/**
 * #P49 — the fast lane, live, through booted bundles (three serving boots, three refusals).
 *
 * A route declaring `param.lane` skips the controller: its `lanes/<name>.js` module export answers
 * through `ctx.json()` / `ctx.error()`. Boots the REAL `bin/gina-container` on a scaffolded bundle
 * carrying lane modules, a response DTO, and an entry that registers one middleware (so the
 * bundle's own chain is in front of the lane, as a session or CSRF middleware would be):
 *
 *   h1    isaac over http/1.1, prod (a built release)
 *   h2    isaac over http/2 + TLS, prod — every routed response takes the #B562 shim path
 *   dev   isaac over http/1.1, dev (the sources) — plus a lane module edited while it runs
 *
 * Served arms (h1 and h2; the starred ones in dev too):
 *   01* 200, the JSON body, the content type, X-Request-Id honoured inbound and echoed, the
 *       bundle's middleware ran first (its header on the response, its stamp seen by the handler),
 *       `this` is the module; a byte content-length on HTTP/1.1
 *   02  HEAD: the length, no body
 *   03  an async handler
 *   04  a `status` key sets the status
 *   05  ctx.error(404, msg) and ctx.error({ status: 422, error, fields }) envelopes, X-Request-Id kept
 *   06  a synchronous throw and a rejection answer 500 with a 6-hex ref (paired in the bundle's
 *       log), and the bundle keeps serving
 *   07  a failure after the answer: the first answer stands
 *   08  param.responseDto strips the undeclared field
 *   09  the same URL twice (the warm route-cache path); a nested module; URL params and the query
 *   10  a JSON POST body reaches the handler
 *   11  the scaffold's classic route still answers (the control)
 *   12  (dev) a lane module edited on disk is served on the next request
 * Refusals (dev, the sources): a lane route declaring `param.requireAuth`, one declaring `cache`,
 *   one naming a missing module — each exits 1, names the route on stderr, never opens its port.
 *
 * Isolation: a throwaway HOME under os.tmpdir(), its own port window (11250 — 11200..11249 holds
 * two local OrbStack forwards on the machine this was written on), project:rm + rmSync at
 * teardown; the HTTP/2 boot gets a self-signed certificate triple. Seam: `P49_GINA_ROOT=<tree>`
 * boots THAT tree (red-first against a tree without the lane).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-lane.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var https  = require('https');
var http2  = require('http2');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-p49-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'p49' + STAMP;
var BUNDLE     = 'api';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var SRC        = path.join(PROJ_DIR, 'src', BUNDLE);
var PORT_START = 11250;

var BOOT_TIMEOUT_MS  = 40000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.P49_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var MODES = [
    { name: 'h1',  env: 'prod', protocol: 'http/1.1', scheme: 'http' },
    { name: 'h2',  env: 'prod', protocol: 'http/2.0', scheme: 'https' },
    { name: 'dev', env: 'dev',  protocol: 'http/1.1', scheme: 'http' }
];

var REQ_ID = 'p49-req-1';
var HEX6   = /^[0-9A-F]{6}$/;

var skip = false, skipReason = '', setupError = null;
var webroot = '/' + BUNDLE + '/';
var ROUTING_BASE = null;   // the scaffold's routing.json + the lane routes, restored after each refusal
var results = {};
var refusals = {};


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

var ITEMS_JS = [
    "'use strict';",
    "function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }",
    "module.exports.list   = function (ctx) {",
    "    ctx.json({ items: ['a', 'é'], requestId: ctx.requestId, mw: ctx.req.p49Mw || null, isModule: this === module.exports });",
    "};",
    "module.exports.slow   = async function (ctx) { await wait(30); ctx.json({ slow: true }); };",
    "module.exports.gone   = function (ctx) { ctx.json({ status: 404, error: 'gone' }); };",
    "module.exports.nf     = function (ctx) { ctx.error(404, 'no such item'); };",
    "module.exports.bad    = function (ctx) { ctx.error({ status: 422, error: 'Validation failed', fields: { name: { isRequired: 'name is required' } } }); };",
    "module.exports.boom   = function () { throw new Error('p49 lane boom'); };",
    "module.exports.rej    = async function () { await wait(5); throw new Error('p49 lane rejected'); };",
    "module.exports.late   = function (ctx) { ctx.json({ first: true }); setTimeout(function () { ctx.error(500, 'p49 too late'); }, 5); };",
    "module.exports.shaped = function (ctx) { ctx.json({ id: 7, name: 'shaped', secret: 'must not leave' }); };",
    "module.exports.one    = function (ctx) { ctx.json({ id: ctx.params.id, q: ( ctx.get && ctx.get.q ) || null }); };",
    "module.exports.create = function (ctx) { ctx.json({ status: 201, received: ctx.body }); };"
].join('\n') + '\n';

function hotJs(v) { return "module.exports.version = function (ctx) { ctx.json({ v: " + JSON.stringify(v) + " }); };\n"; }

/** The bundle entry: one middleware in front of every route, and onStarted (the dev watcher). */
var INDEX_JS = [
    "var api = require('gina');",
    "api.onInitialize(function (event, app, express) {",
    "    app.use(function p49Middleware(req, res, next) {",
    "        res.setHeader('x-p49-mw', 'ran');",
    "        req.p49Mw = 'ran';",
    "        next();",
    "    });",
    "    event.emit('complete', app);",
    "});",
    "api.onStarted(function () {});",
    "api.onError(function (err, req, res, next) { next(err); });",
    "api.start();"
].join('\n') + '\n';

var LANE_ROUTES = {
    'lane-items'  : { url: '/lane/items',        method: 'GET',  param: { lane: 'items', control: 'list' } },
    'lane-create' : { url: '/lane/items',        method: 'POST', param: { lane: 'items', control: 'create' } },
    'lane-one'    : { url: '/lane/items/:id',    method: 'GET',  param: { lane: 'items', control: 'one', id: ':id' } },
    'lane-slow'   : { url: '/lane/slow',         method: 'GET',  param: { lane: 'items', control: 'slow' } },
    'lane-gone'   : { url: '/lane/gone',         method: 'GET',  param: { lane: 'items', control: 'gone' } },
    'lane-nf'     : { url: '/lane/nf',           method: 'GET',  param: { lane: 'items', control: 'nf' } },
    'lane-bad'    : { url: '/lane/bad',          method: 'GET',  param: { lane: 'items', control: 'bad' } },
    'lane-boom'   : { url: '/lane/boom',         method: 'GET',  param: { lane: 'items', control: 'boom' } },
    'lane-rej'    : { url: '/lane/rej',          method: 'GET',  param: { lane: 'items', control: 'rej' } },
    'lane-late'   : { url: '/lane/late',         method: 'GET',  param: { lane: 'items', control: 'late' } },
    'lane-shaped' : { url: '/lane/shaped',       method: 'GET',  param: { lane: 'items', control: 'shaped', responseDto: 'P49ItemView' } },
    'lane-admin'  : { url: '/lane/admin/users',  method: 'GET',  param: { lane: 'admin/users', control: 'list' } },
    'lane-hot'    : { url: '/lane/hot',          method: 'GET',  param: { lane: 'hot', control: 'version' } }
};


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTcpPortOpen(port) {
    return new Promise(function (resolve) {
        var sock = new net.Socket();
        sock.setTimeout(800);
        sock.on('connect', function () { sock.destroy(); resolve(true); });
        sock.on('error',   function () { resolve(false); });
        sock.on('timeout', function () { sock.destroy(); resolve(false); });
        sock.connect(port, '127.0.0.1');
    });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 120000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
/** The scaffold's JSON files carry whole-line `//` comments only. */
function readConfig(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'));
}
function write(rel, content) {
    var f = path.join(SRC, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    return f;
}

/**
 * One request; the body as a utf8 string. `via`: 'h1' (plain HTTP/1.1) or 'h2' (HTTP/2 over TLS,
 * one session per call).
 */
function request(via, port, method, reqPath, headers, body) {
    headers = headers || {};
    if (via === 'h2') {
        return new Promise(function (resolve) {
            var session = http2.connect('https://127.0.0.1:' + port, { rejectUnauthorized: false });
            var done = false;
            var finish = function (r) { if (done) { return; } done = true; try { session.close(); } catch (e) { /* ignore */ } resolve(r); };
            session.on('error', function (e) { finish({ status: null, headers: {}, body: '', err: e.message }); });
            var req = session.request(Object.assign({ ':method': method, ':path': reqPath }, headers));
            var chunks = [], resHeaders = {};
            req.setTimeout(15000, function () { req.close(); finish({ status: null, headers: {}, body: '', err: 'timeout' }); });
            req.on('response', function (hs) { resHeaders = hs; });
            req.on('data', function (c) { chunks.push(c); });
            req.on('end', function () { finish({ status: Number(resHeaders[':status']), headers: resHeaders, body: Buffer.concat(chunks).toString('utf8') }); });
            req.on('error', function (e) { finish({ status: null, headers: {}, body: '', err: e.message }); });
            if ( body ) { req.write(body); }
            req.end();
        });
    }
    return new Promise(function (resolve) {
        var req = http.request({ host: '127.0.0.1', port: port, path: reqPath, method: method, agent: false, headers: headers }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, headers: {}, body: '', err: e.message }); });
        if ( body ) { req.write(body); }
        req.end();
    });
}

/** Self-signed certificate triple for the HTTP/2 boot (isaac reads all three for https). */
function writeCerts() {
    var certDir = path.join(GINA_HOME, 'certificates', 'scopes', 'local', 'localhost');
    fs.mkdirSync(certDir, { recursive: true });
    var ssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(certDir, 'private.key'), '-out', path.join(certDir, 'certificate.crt'),
        '-days', '2', '-subj', '/CN=localhost'], { encoding: 'utf8' });
    if (ssl.status !== 0 || !fs.existsSync(path.join(certDir, 'private.key'))) {
        throw new Error('openssl self-signed cert generation failed: ' + (ssl.stderr || ssl.status));
    }
    fs.copyFileSync(path.join(certDir, 'certificate.crt'), path.join(certDir, 'ca_bundle.crt'));
}

/** The lane modules, the response DTO, the entry, and the routes (kept as the base to restore). */
function installFixture() {
    write('lanes/items.js', ITEMS_JS);
    write('lanes/admin/users.js', "module.exports.list = function (ctx) { ctx.json({ admin: true, mw: ctx.req.p49Mw || null }); };\n");
    write('lanes/hot.js', hotJs(1));
    write('dtos/P49ItemView.js', "module.exports = function (dto) { return dto.object({ id: dto.integer(), name: dto.string() }); };\n");
    write('index.js', INDEX_JS);
    var rf = path.join(SRC, 'config', 'routing.json');
    var routing = readConfig(rf);
    if ( !routing.homepage ) { throw new Error('the scaffold has no `homepage` route to keep as the control'); }
    Object.keys(LANE_ROUTES).forEach(function (k) { routing[k] = LANE_ROUTES[k]; });
    ROUTING_BASE = routing;
    fs.writeFileSync(rf, JSON.stringify(routing, null, 2));
}

function setRouting(routing) {
    fs.writeFileSync(path.join(SRC, 'config', 'routing.json'), JSON.stringify(routing, null, 2));
}

/** Point the bundle at `mode`'s protocol, then build the prod release. */
function configureAndBuild(mode) {
    var sf = path.join(SRC, 'config', 'settings.json');
    var settings = readConfig(sf);
    settings.server = Object.assign({}, settings.server, { protocol: mode.protocol, scheme: mode.scheme });
    fs.writeFileSync(sf, JSON.stringify(settings, null, 2));
    if (mode.env === 'dev') { return; }   // dev boots the sources
    var b = runCli(['bundle:build', BUNDLE, '@' + PROJ, '--env=prod', '--scope=local']);
    var relRoot = path.join(PROJ_DIR, 'releases', BUNDLE, 'local', 'prod');
    var built = fs.existsSync(relRoot) && fs.readdirSync(relRoot).some(function (v) {
        return fs.existsSync(path.join(relRoot, v, 'index.js')) && fs.existsSync(path.join(relRoot, v, 'lanes', 'items.js'));
    });
    if (!built) { throw new Error('bundle:build produced no prod release carrying lanes/ under ' + relRoot + '\n' + (b.stdout + b.stderr).slice(-1500)); }
}

function portFor(mode) {
    var key = BUNDLE + '@' + PROJ;
    return readJSON(path.join(GINA_HOME, 'ports.reverse.json'))[key][mode.env][mode.protocol][mode.scheme];
}

/** Start the container; resolve once the port opens or the process exits. */
async function boot(mode) {
    var port = portFor(mode);
    var st = { out: '', stderr: '', exit: null, port: port, up: false };
    var childEnv = Object.assign({}, CHILD_ENV, { NODE_ENV: 'prod' });
    if (mode.env === 'dev') { delete childEnv.NODE_ENV; }   // the project's def_env (dev)
    var child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], { env: childEnv, cwd: FAKE_HOME, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', function (d) { st.out += d; });
    child.stderr.on('data', function (d) { st.out += d; st.stderr += d; });
    child.on('exit', function (code, signal) { st.exit = { code: code, signal: signal }; });
    st.child = child;
    var deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline && !st.exit) {
        if (await isTcpPortOpen(port)) { st.up = true; break; }
        await sleep(POLL_INTERVAL_MS);
    }
    if (st.exit) { await sleep(300); }   // let the streams flush
    return st;
}

async function stop(st) {
    var child = st.child;
    var alive = function () { return child.exitCode === null && child.signalCode === null; };
    if (alive()) {
        try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        var until = Date.now() + 12000;
        while (Date.now() < until && alive()) { await sleep(150); }
        if (alive()) {
            var m = st.out.match(/\[ FRAMEWORK \]\[ (\d+) \]/);
            if (m) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch (e) { /* gone */ } }
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
    }
    var free = Date.now() + 8000;
    while (Date.now() < free && await isTcpPortOpen(st.port)) { await sleep(150); }
}

/** Boot, drive every arm of the mode, stop. */
async function bootDriveStop(mode) {
    var st  = await boot(mode);
    var res = { out: '', err: null };
    if (!st.up) {
        res.err = 'the bundle did not come up on ' + st.port + ': exit ' + JSON.stringify(st.exit) + '\n' + st.out.slice(-2500);
        res.out = st.out;
        return res;
    }
    await sleep(300);
    var via = ( mode.name === 'h2' ) ? 'h2' : 'h1';
    var port = st.port;
    var u = function (p) { return webroot + p; };
    var json = { 'content-type': 'application/json' };
    res.list     = await request(via, port, 'GET', u('lane/items'), { 'x-request-id': REQ_ID });
    if ( mode.name !== 'dev' ) {
        res.head     = await request(via, port, 'HEAD', u('lane/items'), { 'x-request-id': REQ_ID });   // the same id: the same would-be body
        res.slow     = await request(via, port, 'GET', u('lane/slow'));
        res.gone     = await request(via, port, 'GET', u('lane/gone'));
        res.nf       = await request(via, port, 'GET', u('lane/nf'), { 'x-request-id': 'p49-req-nf' });
        res.bad      = await request(via, port, 'GET', u('lane/bad'));
        res.boom     = await request(via, port, 'GET', u('lane/boom'));
        res.afterBoom = await request(via, port, 'GET', u('lane/items'));
        res.rej      = await request(via, port, 'GET', u('lane/rej'));
        res.late     = await request(via, port, 'GET', u('lane/late'));
        await sleep(50);
        res.afterLate = await request(via, port, 'GET', u('lane/items'));
        res.shaped   = await request(via, port, 'GET', u('lane/shaped'));
        res.warm1    = await request(via, port, 'GET', u('lane/admin/users'));
        res.warm2    = await request(via, port, 'GET', u('lane/admin/users'));
        res.one      = await request(via, port, 'GET', u('lane/items/42?q=x'));
        res.create   = await request(via, port, 'POST', u('lane/items'), json, JSON.stringify({ name: 'p49' }));
        res.home     = await request(via, port, 'GET', webroot);
    } else {
        res.home     = await request(via, port, 'GET', webroot);
        res.hot1     = await request(via, port, 'GET', u('lane/hot'));
        fs.writeFileSync(path.join(SRC, 'lanes', 'hot.js'), hotJs(2));
        var until = Date.now() + 8000;
        do {
            await sleep(200);
            res.hot2 = await request(via, port, 'GET', u('lane/hot'));
        } while ( Date.now() < until && !( res.hot2.status === 200 && /"v":2/.test(res.hot2.body) ) );
    }
    await sleep(200);
    await stop(st);
    res.out = st.out;
    return res;
}

/** A refusal boot: the routing is changed, the bundle must exit 1 without opening its port. */
async function refusalBoot(routing) {
    setRouting(routing);
    try {
        var st = await boot(MODES[2]);
        if (!st.exit) { await stop(st); }
        return { exit: st.exit, up: st.up, out: st.out, stderr: st.stderr };
    } finally {
        setRouting(ROUTING_BASE);
    }
}

function header(r, name) { return (r && r.headers && r.headers[name]) || undefined; }
function brief(r) { return r ? (r.status + ' ' + String(r.body).slice(0, 300) + ( r.err ? ' err=' + r.err : '' )) : 'no response'; }
function bodyOf(r) { return JSON.parse(r.body); }


// ---------------------------------------------------------------------------
// Teardown — after BOTH suites (the refusals reuse the project the first one sets up)
// ---------------------------------------------------------------------------

after(async function () {
    try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
    try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or non-empty: leave it */ }
});


// ---------------------------------------------------------------------------
// Suite — served
// ---------------------------------------------------------------------------

describe('30 - container-boot-lane — lane routes served by booted bundles (#P49)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        if (spawnSync('openssl', ['version'], { encoding: 'utf8' }).status !== 0) { skip = true; skipReason = 'openssl is not available (the HTTP/2 boot needs a certificate)'; return; }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) { setupError = 'project:add did not register @' + PROJ; return; }
        runCli(['bundle:add', BUNDLE, '@' + PROJ, '--start-port-from=' + PORT_START]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var key = BUNDLE + '@' + PROJ;
        if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) { setupError = 'bundle:add did not register ' + key; return; }
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }
        try {
            var ss = fs.readFileSync(path.join(SRC, 'config', 'settings.server.json'), 'utf8');
            var wr = (ss.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }
        try { installFixture(); } catch (e) { setupError = 'fixture install failed: ' + (e.message || e); return; }
        try { writeCerts(); } catch (e) { setupError = e.message; return; }

        for (var i = 0; i < MODES.length; ++i) {
            try { configureAndBuild(MODES[i]); }
            catch (e) { setupError = MODES[i].name + ': ' + e.message; return; }
            results[MODES[i].name] = await bootDriveStop(MODES[i]);
        }
    }, { timeout: 300000 });

    function ready(t) {
        if (skip) { t.skip(skipReason); return false; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        return true;
    }
    function booted(name) {
        var r = results[name];
        assert.ok(r, 'the ' + name + ' boot ran');
        assert.equal(r.err, null, name + ': ' + r.err);
        return r;
    }

    ['h1', 'h2', 'dev'].forEach(function (name) {
        it('01 - ' + name + ': 200, the body and its type, X-Request-Id honoured and echoed, the bundle middleware first, `this` the module', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name).list;
            assert.equal(r.status, 200, brief(r));
            assert.equal(header(r, 'content-type'), 'application/json; charset=utf8', brief(r));
            assert.equal(header(r, 'x-request-id'), REQ_ID, 'the inbound id is honoured and echoed');
            assert.equal(header(r, 'x-p49-mw'), 'ran', 'the bundle middleware ran and its header reached the response');
            assert.deepEqual(bodyOf(r), { items: ['a', 'é'], requestId: REQ_ID, mw: 'ran', isModule: true });
            if ( name !== 'h2' ) {
                assert.equal(header(r, 'content-length'), String(Buffer.byteLength(r.body, 'utf8')), 'a byte length');
                assert.equal(header(r, 'transfer-encoding'), undefined, 'not chunked');
            }
        });
    });

    ['h1', 'h2'].forEach(function (name) {
        it('02 - ' + name + ': HEAD answers the length the body would have, and no body', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name);
            assert.equal(r.head.status, 200, brief(r.head));
            assert.equal(r.head.body, '');
            if ( name === 'h1' ) {
                assert.equal(header(r.head, 'content-length'), header(r.list, 'content-length'));
            } else {
                assert.equal(header(r.head, 'content-length'), String(Buffer.byteLength(r.list.body, 'utf8')));
            }
        });

        it('03 - ' + name + ': an async handler answers', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name).slow;
            assert.equal(r.status, 200, brief(r));
            assert.deepEqual(bodyOf(r), { slow: true });
        });

        it('04 - ' + name + ': a `status` key sets the status', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name).gone;
            assert.equal(r.status, 404, brief(r));
            assert.deepEqual(bodyOf(r), { status: 404, error: 'gone' });
        });

        it('05 - ' + name + ': the ctx.error() envelopes — (404, msg) and a fields object — keep X-Request-Id', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name);
            assert.equal(r.nf.status, 404, brief(r.nf));
            var nf = bodyOf(r.nf);
            assert.equal(nf.status, 404);
            assert.equal(nf.error, 'Not Found');
            assert.equal(nf.message, 'no such item');
            assert.match(nf.ref, HEX6);
            assert.equal(header(r.nf, 'x-request-id'), 'p49-req-nf');
            assert.equal(header(r.nf, 'content-type'), 'application/json; charset=utf8');
            assert.equal(r.bad.status, 422, brief(r.bad));
            var bad = bodyOf(r.bad);
            assert.deepEqual(bad.fields, { name: { isRequired: 'name is required' } });
            assert.equal(bad.error, 'Validation failed');
        });

        it('06 - ' + name + ': a throw and a rejection answer 500 with a ref paired in the log; the bundle keeps serving', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name);
            assert.equal(r.boom.status, 500, brief(r.boom));
            var boom = bodyOf(r.boom);
            assert.equal(boom.message, 'p49 lane boom');
            assert.match(boom.ref, HEX6);
            assert.ok(r.out.indexOf('[ Lane ][ ref ' + boom.ref + ' ]') > -1, 'the pairing line carries the ref');
            assert.equal(r.rej.status, 500, brief(r.rej));
            assert.equal(bodyOf(r.rej).message, 'p49 lane rejected');
            assert.equal(r.afterBoom.status, 200, 'still serving after a throw: ' + brief(r.afterBoom));
        });

        it('07 - ' + name + ': a failure after the answer leaves the first answer standing', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name);
            assert.equal(r.late.status, 200, brief(r.late));
            assert.deepEqual(bodyOf(r.late), { first: true });
            assert.equal(r.afterLate.status, 200, brief(r.afterLate));
            assert.ok(r.out.indexOf('error() called after the response was released') > -1, 'the late call is logged');
        });

        it('08 - ' + name + ': param.responseDto strips the undeclared field', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name).shaped;
            assert.equal(r.status, 200, brief(r));
            assert.deepEqual(bodyOf(r), { id: 7, name: 'shaped' });
        });

        it('09 - ' + name + ': the same URL twice (warm), a nested module, URL params and the query', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name);
            assert.equal(r.warm1.status, 200, brief(r.warm1));
            assert.equal(r.warm2.status, 200, brief(r.warm2));
            assert.deepEqual(bodyOf(r.warm2), { admin: true, mw: 'ran' });
            assert.equal(r.one.status, 200, brief(r.one));
            assert.deepEqual(bodyOf(r.one), { id: '42', q: 'x' });
        });

        it('10 - ' + name + ': a JSON POST body reaches the handler', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name).create;
            assert.equal(r.status, 201, brief(r));
            assert.deepEqual(bodyOf(r).received, { name: 'p49' });
        });
    });

    ['h1', 'h2', 'dev'].forEach(function (name) {
        it('11 - ' + name + ': the scaffold\'s classic route still answers (the control)', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name).home;
            assert.equal(r.status, 200, brief(r));
            assert.ok('msg' in bodyOf(r), brief(r));
        });
    });

    it('12 - dev: a lane module edited on disk is served on the next request', function (t) {
        if (!ready(t)) { return; }
        var r = booted('dev');
        assert.equal(r.hot1.status, 200, brief(r.hot1));
        assert.deepEqual(bodyOf(r.hot1), { v: 1 });
        assert.equal(r.hot2.status, 200, brief(r.hot2));
        assert.deepEqual(bodyOf(r.hot2), { v: 2 }, 'the edit reached the handler: ' + brief(r.hot2));
    });
});


// ---------------------------------------------------------------------------
// Suite — refusals
// ---------------------------------------------------------------------------

describe('30 - container-boot-lane — a lane route the lane cannot serve refuses to boot (#P49)', function () {

    before(async function () {
        if (skip || setupError || !ROUTING_BASE) { return; }
        configureAndBuild(MODES[2]);
        var withRoute = function (rule, route) {
            var r = JSON.parse(JSON.stringify(ROUTING_BASE));
            r[rule] = route;
            return r;
        };
        refusals.auth    = await refusalBoot(withRoute('lane-auth',    { url: '/lane/auth',    method: 'GET', param: { lane: 'items', control: 'list', requireAuth: true } }));
        refusals.cache   = await refusalBoot(withRoute('lane-cached',  { url: '/lane/cached',  method: 'GET', cache: { type: 'memory', ttl: 60 }, param: { lane: 'items', control: 'list' } }));
        refusals.missing = await refusalBoot(withRoute('lane-missing', { url: '/lane/missing', method: 'GET', param: { lane: 'nowhere', control: 'list' } }));
    }, { timeout: 200000 });

    function refused(t, name, re) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        var r = refusals[name];
        assert.ok(r, 'the refusal boot ran');
        var diag = 'exit ' + JSON.stringify(r.exit) + ' up=' + r.up + '\n' + String(r.out).slice(-2000);
        assert.ok(r.exit, 'the bundle exits: ' + diag);
        assert.equal(r.exit.code, 1, diag);
        assert.equal(r.up, false, 'the port never opens');
        assert.match(r.stderr, re, diag);
    }

    it('R1 - a lane route declaring param.requireAuth', function (t) {
        refused(t, 'auth', /Route `lane-auth[^`]*`: a lane route cannot declare `param\.requireAuth` yet/);
    });

    it('R2 - a lane route declaring cache', function (t) {
        refused(t, 'cache', /Route `lane-cached[^`]*`: a lane route cannot declare `cache`/);
    });

    it('R3 - a lane route naming a missing module', function (t) {
        refused(t, 'missing', /Route `lane-missing[^`]*` declares `param\.lane` `nowhere` but `[^`]*nowhere\.js` is missing/);
    });
});
