/**
 * #B989 — a page rendered with a session carries the request's session block on every HTML
 * engine, in booted bundles.
 *
 * A page rendered for a request that has a session gets its session block under
 * `page.data.session` (`id`, `lastModified`, `createdAt`, `expiresAt`, `timeout`), and gina's
 * client bootstrap in the page builds `gina.session` from its `{{ page.data.session.id }}`,
 * `.timeout`, `.createdAt` and `.lastModified` placeholders. Up to 0.7.5 only the sync swig
 * delegate built the block: with an async swig loader (`settings.template.swig.loader`), with
 * nunjucks (`render.engine: nunjucks`) and with an async nunjucks loader, a template read no
 * session value and the bootstrap reached the browser with its placeholders as written. Since
 * 0.7.6 the five HTML delegates build it with `core/controller/render-session.js`.
 *
 * The scene: four bundles, one per engine, each in its own project (`view:add` in a project with
 * several bundles also runs on the others, #B998): `sw` (sync swig, the control), `swa` (swig
 * with a memory loader), `nj` (nunjucks, templates on disk) and `nja` (nunjucks with a memory
 * loader). express-session is not installed here, so each bundle's `index.js` mounts a
 * stub session middleware: a request with an `x-b989-sid` header gets
 * `req.session = { id, cookie: { _expires: <now + 10 min> } }`, plus `lastModified` from an
 * `x-b989-lm` header; a request without the header has no `req.session`. Each page prints what
 * its template was given (`SID`, `LM`, `USER`, `TITLE`). The bundles boot one after another, and
 * each answers these arms, in order, in `before()`:
 *
 *   fresh.A / fresh.B   a fresh object on a layout page, sessions A and B
 *   freshsess           an object with its own `session` member (`{ user: 'app' }`)
 *   freshpage           an object with its own `page.data`
 *   freshnl             a layoutless render (no bootstrap in a fragment)
 *   reusedsess.A / .B   one module-level object with its own `session` member, sessions A and B
 *   fresh.lm            session A with a `lastModified`
 *   fresh.none          no session
 *   apptext             an object whose data holds the text `{{ page.data.session.id }}`
 *   peek                the keys the module-level object and its `session` member hold
 *
 *   01 – 04  one block per engine (`sw` passes before and after the fix): the template and the
 *            bootstrap show the request's own session, with no `{{ page.data.session.` placeholder
 *            left; an object's own `session` or `page.data` member keeps its keys; the shared
 *            object holds only its own keys; a page without a session gets empty values; and
 *            text the page renders from app data keeps the placeholder it holds: the session id
 *            goes into the bootstrap only (the three post-render engines substitute their
 *            bootstrap's placeholders over the whole page)
 *
 * Every request carries a client timeout, so a failing run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-render-reuse-b988.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14350–14385, one window of 10 per bundle), project:rm +
 * rmSync at teardown. nunjucks is project-only: the framework's devDependency is linked into the
 * two nunjucks projects (the container-boot-template-containment-b867.test.js precedent). Seam:
 * `B989_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's
 * CLI (red-first against a pre-fix tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-render-session-b989.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var https  = require('https');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP     = Date.now();
var FAKE_HOME = path.join(os.tmpdir(), 'gina-b989-home-' + STAMP);
var GINA_HOME = path.join(FAKE_HOME, '.gina');

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 8000;

var GINA_ROOT = process.env.B989_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var SID_A = 'b989-sid-aaaa';
var SID_B = 'b989-sid-bbbb';
var LM    = '2026-10-27T01:00:00.000Z';

// [bundle, label, port window start, mode]
var BUNDLES = [
    ['sw',  'sync swig (control)', 14350, 'swig'],
    ['swa', 'swig, memory loader',  14360, 'swig-async'],
    ['nj',  'nunjucks',             14370, 'nunjucks'],
    ['nja', 'nunjucks, memory loader', 14380, 'nunjucks-async']
];

// [rule, action, how the action renders, layout page?]
var RULES = [
    ['b989fresh',      'b989Fresh',      'self.render({ title: "F" });', true],
    ['b989freshsess',  'b989FreshSess',  'self.render({ title: "S", session: { user: "app" } });', true],
    ['b989freshpage',  'b989FreshPage',  'self.render({ page: { data: { title: "P" } } });', true],
    ['b989freshnl',    'b989FreshNl',    'self.renderWithoutLayout({ title: "NL" });', false],
    ['b989reusedsess', 'b989ReusedSess', 'if (!global.__b989Shared) { global.__b989Shared = { title: "R", session: { user: "app" } }; } self.render(global.__b989Shared);', true],
    ['b989apptext',    'b989AppText',    'self.render({ title: "{{ page.data.session.id }}" });', true]
];

// [label, path under the webroot, request headers] — sent in this order, once each
var ARMS = [
    ['fresh.A',      'b989-fresh',      { 'x-b989-sid': SID_A }],
    ['fresh.B',      'b989-fresh',      { 'x-b989-sid': SID_B }],
    ['freshsess',    'b989-freshsess',  { 'x-b989-sid': SID_A }],
    ['freshpage',    'b989-freshpage',  { 'x-b989-sid': SID_A }],
    ['freshnl',      'b989-freshnl',    { 'x-b989-sid': SID_A }],
    ['reusedsess.A', 'b989-reusedsess', { 'x-b989-sid': SID_A }],
    ['reusedsess.B', 'b989-reusedsess', { 'x-b989-sid': SID_B }],
    ['fresh.lm',     'b989-fresh',      { 'x-b989-sid': SID_A, 'x-b989-lm': LM }],
    ['fresh.none',   'b989-fresh',      {}],
    ['apptext',      'b989-apptext',    { 'x-b989-sid': SID_A }],
    ['peek',         'b989-peek',       {}]
];

// per bundle: { proj, projDir, port, scheme, webroot, error, answers, log }
var state = {};
var skip = false, skipReason = '', setupError = null;
var child = null, childOut = '', childExit = null;


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

/**
 * One GET with a client timeout: an unanswered request resolves with
 * `{ status: null, err: 'timeout' }` instead of waiting forever.
 *
 * @inner
 * @param {object} st - the bundle's state (`port`, `scheme`)
 * @param {string} reqPath - path including the webroot
 * @param {object} headers - request headers
 * @returns {Promise<object>} `{ status, body, json }` or `{ status: null, err }`
 */
function request(st, reqPath, headers) {
    var lib = (st.scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: st.port, path: reqPath, method: 'GET', headers: headers, rejectUnauthorized: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, body: data, json: json });
            });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null }); });
        req.end();
    });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/**
 * The line each page prints: what its template was given.
 *
 * @inner
 * @param {string} rule - the rule name
 * @param {string} titleExpr - the template expression of the title
 * @returns {string} the line
 */
function sceneLine(rule, titleExpr) {
    return '<p id="b989">RULE=[' + rule + '] TITLE=[' + titleExpr + ']'
        + ' SID=[{{ page.data.session.id }}] LM=[{{ page.data.session.lastModified }}]'
        + ' USER=[{{ page.data.session.user }}]</p>';
}

/**
 * Inserts one top-level key into the bundle's `config/settings.json` (a commented file),
 * after its opening brace, count-guarded.
 *
 * @inner
 * @param {string} bundleDir - the bundle's directory
 * @param {string} keyJson - `"key": <json>`
 * @returns {void}
 */
function spliceSettings(bundleDir, keyJson) {
    var sf = path.join(bundleDir, 'config', 'settings.json');
    var t = fs.readFileSync(sf, 'utf8');
    var m = t.match(/^\{[ \t]*$/mg) || [];
    if (m.length !== 1) { throw new Error('settings.json opening-brace anchor count ' + m.length); }
    fs.writeFileSync(sf, t.replace(/^\{[ \t]*$/m, '{\n    ' + keyJson + ','));
}

/**
 * Writes one bundle's scene: the stub session middleware in `index.js`, views on, the rules,
 * the actions, and the templates the bundle's engine reads (on disk, or in its memory loader).
 *
 * @inner
 * @param {string} bundle - the bundle name
 * @param {string} mode - swig | swig-async | nunjucks | nunjucks-async
 * @returns {void}
 */
function installScene(bundle, mode) {
    var bundleDir = path.join(state[bundle].projDir, 'src', bundle);

    fs.writeFileSync(path.join(bundleDir, 'index.js'), [
        "var myapp = require('gina');",
        "myapp.onInitialize(function(event, app) {",
        "    // #B989 scene: a stub session (express-session is not installed here)",
        "    app.use(function (req, res, next) {",
        "        var sid = req.headers['x-b989-sid'];",
        "        if (sid) {",
        "            req.session = { id: sid, cookie: { _expires: new Date(Date.now() + 600000) } };",
        "            if (req.headers['x-b989-lm']) { req.session.lastModified = req.headers['x-b989-lm']; }",
        "        }",
        "        next();",
        "    });",
        "    event.emit('complete', app);",
        "});",
        "myapp.onError(function(err, req, res, next) { next(err); });",
        "myapp.start();",
        ""
    ].join('\n'));

    var ss = path.join(bundleDir, 'config', 'settings.server.json');
    var sst = fs.readFileSync(ss, 'utf8');
    var wm = sst.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (wm.length !== 1) { throw new Error('settings.server.json webroot anchor count ' + wm.length); }
    fs.writeFileSync(ss, sst.replace(wm[0], wm[0] + ',\n    "template": true'));

    var rf = path.join(bundleDir, 'config', 'routing.json');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    RULES.forEach(function (rule) {
        r[rule[0]] = { namespace: 'content', url: '/' + rule[0].replace('b989', 'b989-'), method: 'GET', param: { control: rule[1] } };
    });
    r.b989peek = { namespace: 'content', url: '/b989-peek', method: 'GET', param: { control: 'b989Peek' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var cf = path.join(bundleDir, 'controllers', 'controller.content.js');
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = RULES.map(function (rule) {
        return '    this.' + rule[1] + ' = function(req, res) { ' + rule[2] + ' };';
    }).concat([
        '    this.b989Peek = function(req, res) {',
        '        var keys = function (o) { return (o && typeof(o) == "object") ? Object.keys(o) : null; };',
        '        var o = global.__b989Shared;',
        '        self.renderJSON({ shared: keys(o), sharedSession: keys(o && o.session) });',
        '    };',
        ''
    ]).join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + '\n' + anchor));

    var td = path.join(bundleDir, 'templates', 'html', 'content');
    if (!fs.existsSync(td)) { throw new Error('no templates/html/content (did view:add run?)'); }

    // names as resolveTemplatePath() builds them for a memory loader: `<namespace>/<rule>.html`
    var memoryMap = function () {
        var map = { 'layout.html': '<!doctype html><html><head><title>b989</title></head><body>{% block body %}{% endblock %}</body></html>' };
        RULES.forEach(function (rule) {
            map['content/' + rule[0] + '.html'] = rule[3]
                ? '{% extends "layout.html" %}{% block body %}' + sceneLine(rule[0], '{{ page.data.title }}') + '{% endblock %}'
                : sceneLine(rule[0], '{{ title }}');
        });
        return map;
    };

    if (mode === 'swig' || mode === 'nunjucks') {
        var layout = "'layouts/main.html'";
        if (mode === 'nunjucks') {
            fs.writeFileSync(path.join(bundleDir, 'templates', 'html', 'layouts', 'b989nj.html'),
                '<!doctype html>\n<html>\n<head><title>b989</title></head>\n<body>{% block content %}{% endblock %}</body>\n</html>\n');
            layout = '"layouts/b989nj.html"';
            spliceSettings(bundleDir, '"render": { "engine": "nunjucks" }');
        }
        RULES.forEach(function (rule) {
            fs.writeFileSync(path.join(td, rule[0] + '.html'), rule[3]
                ? '{% extends ' + layout + ' %}\n{% block content %}' + sceneLine(rule[0], '{{ page.data.title }}') + '{% endblock %}\n'
                : sceneLine(rule[0], '{{ title }}') + '\n');
        });
    } else if (mode === 'swig-async') {
        spliceSettings(bundleDir, '"template": ' + JSON.stringify({ swig: { loader: { type: 'memory', templates: memoryMap() } } }));
    } else if (mode === 'nunjucks-async') {
        spliceSettings(bundleDir, '"template": ' + JSON.stringify({ nunjucks: { loader: { type: 'memory', templates: memoryMap() } } }));
        spliceSettings(bundleDir, '"render": { "engine": "nunjucks" }');
    }
}

/**
 * Boots one bundle, sends its arms in order, and stops it.
 *
 * @inner
 * @param {string} bundle - the bundle name
 * @returns {Promise<void>} resolves when the bundle has stopped; failures land in `state[bundle].error`
 */
async function runBundle(bundle) {
    var st = state[bundle];
    child = null; childOut = ''; childExit = null;
    child = spawn(process.execPath, [CONTAINER, bundle, '@' + st.proj], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', function (d) { childOut += d; });
    child.stderr.on('data', function (d) { childOut += d; });
    child.on('exit', function (code, signal) { childExit = { code: code, signal: signal }; });
    var deadline = Date.now() + BOOT_TIMEOUT_MS, up = false;
    while (Date.now() < deadline && !childExit) {
        if (await isTcpPortOpen(st.port)) { up = true; break; }
        await sleep(POLL_INTERVAL_MS);
    }
    if (!up) {
        st.error = bundle + ' did not come up: exit ' + JSON.stringify(childExit) + '\n' + childOut.slice(-2000);
    } else {
        await sleep(300);
        for (var i = 0; i < ARMS.length; i++) {
            st.answers[ARMS[i][0]] = await request(st, st.webroot + ARMS[i][1], ARMS[i][2]);
        }
    }
    st.log = childOut.slice(-2000);
    await stopChild();
}

async function stopChild() {
    if (isChildAlive()) {
        try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        var until = Date.now() + 4000;
        while (Date.now() < until && isChildAlive()) { await sleep(150); }
        if (isChildAlive()) { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
    }
}

/**
 * The fields a page's scene line shows, asserted to come from a 200 HTML answer of the rule.
 *
 * @inner
 * @param {string} bundle - the bundle name
 * @param {string} label - an ARMS label
 * @returns {{title: string, sid: string, lm: string, user: string, body: string}} the fields
 */
function lineOf(bundle, label) {
    var a = state[bundle].answers[label];
    assert.ok(a, bundle + ' ' + label + ': the arm was not sent');
    assert.equal(a.status, 200, bundle + ' ' + label + ': expected 200 (got ' + a.status + ': ' + String(a.err || a.body || '').slice(0, 400) + ')');
    var m = /RULE=\[([^\]]*)\] TITLE=\[([^\]]*)\] SID=\[([^\]]*)\] LM=\[([^\]]*)\] USER=\[([^\]]*)\]/.exec(a.body);
    assert.ok(m, bundle + ' ' + label + ': the page carries the scene line (body: ' + String(a.body).slice(0, 300) + ')');
    return { title: m[2], sid: m[3], lm: m[4], user: m[5], body: a.body };
}

/**
 * The client bootstrap's session object as the page serves it (`session={id:'…',…}`).
 *
 * @inner
 * @param {string} bundle - the bundle name
 * @param {string} label - an ARMS label
 * @param {string} body - the page
 * @returns {{id: string, originalTimeout: string, lastModified: string}} its fields
 */
function bootOf(bundle, label, body) {
    var m = /session=\{id:'([^']*)',originalTimeout:'([^']*)',createdAt:'([^']*)',lastModified:'([^']*)'/.exec(body);
    assert.ok(m, bundle + ' ' + label + ': the page carries the bootstrap\'s session object');
    return { id: m[1], originalTimeout: m[2], lastModified: m[4] };
}

/** The number of `{{ page.data.session.` placeholders left in a page. */
function leftOf(body) { return body.split('{{ page.data.session.').length - 1; }


// ---------------------------------------------------------------------------
// 01 – 04 — boot arms, one block per engine
// ---------------------------------------------------------------------------

describe('container-boot-render-session — the session block on every HTML engine (#B989)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        var projectsPath     = path.join(GINA_HOME, 'projects.json');
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var njkSrc           = path.join(GINA_ROOT, 'node_modules', 'nunjucks');
        if (!fs.existsSync(path.join(njkSrc, 'package.json'))) { setupError = 'nunjucks (a devDependency) is not installed under ' + GINA_ROOT; return; }

        // one project per bundle
        for (var i = 0; i < BUNDLES.length; i++) {
            var b = BUNDLES[i][0], proj = 'rs' + b + STAMP, projDir = path.join(FAKE_HOME, 'proj-' + b);
            state[b] = { proj: proj, projDir: projDir, port: null, scheme: 'http', webroot: '/' + b + '/', error: null, answers: {}, log: '' };
            fs.mkdirSync(projDir, { recursive: true });
            runCli(['project:add', '@' + proj, '--path=' + projDir]);
            if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[proj]) { setupError = 'project:add did not register @' + proj; return; }
            var pe = readJSON(projectsPath)[proj], env = pe.def_env || 'dev', proto = pe.def_protocol;
            state[b].scheme = pe.def_scheme || 'http';
            runCli(['bundle:add', b, '@' + proj, '--start-port-from=' + BUNDLES[i][2]]);
            var key = b + '@' + proj;
            if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) { setupError = 'bundle:add did not register ' + key; return; }
            var va = runCli(['view:add', b, '@' + proj]);
            if (va.status !== 0) { setupError = 'view:add ' + b + ' failed: ' + (va.stderr || va.stdout).slice(-600); return; }
            try { state[b].port = readJSON(portsReversePath)[key][env][proto][state[b].scheme]; } catch (e) { state[b].port = null; }
            if (!state[b].port) { setupError = 'could not resolve the bound port for ' + key; return; }
            try {
                var ssj = fs.readFileSync(path.join(projDir, 'src', b, 'config', 'settings.server.json'), 'utf8');
                var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + b);
                state[b].webroot = wr.replace(/\/+$/, '') + '/';
            } catch (e) { /* keep the default */ }

            // the project must load the tree under test (the #B422 Franken-boot trap)
            try {
                var target = fs.realpathSync(path.join(projDir, 'node_modules', 'gina'));
                if (target !== fs.realpathSync(GINA_ROOT)) { setupError = b + ': node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
            } catch (e) { setupError = b + ': node_modules/gina is not linked: ' + (e.message || e); return; }

            // nunjucks is project-only: link the framework's devDependency into the project
            if (/^nunjucks/.test(BUNDLES[i][3])) {
                fs.symlinkSync(njkSrc, path.join(projDir, 'node_modules', 'nunjucks'));
            }
        }

        try {
            BUNDLES.forEach(function (bd) { installScene(bd[0], bd[3]); });
        } catch (e) { setupError = 'scene install failed: ' + (e.message || e); return; }

        // one boot per bundle, one after another
        for (var j = 0; j < BUNDLES.length; j++) {
            await runBundle(BUNDLES[j][0]);
        }
    });

    after(async function () {
        await stopChild();
        Object.keys(state).forEach(function (b) {
            try { runCli(['project:rm', '@' + state[b].proj, '--force']); } catch (e) { /* ignore */ }
            try { fs.rmdirSync(path.join(os.homedir(), '.' + state[b].proj)); } catch (e) { /* absent or non-empty: leave it */ }
        });
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    function ready(t, bundle) {
        if (skip) { t.skip(skipReason); return false; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        assert.equal(state[bundle].error, null, 'boot failed: ' + state[bundle].error);
        return true;
    }

    BUNDLES.forEach(function (bd, n) {
        var b = bd[0], nn = '0' + (n + 1), ctl = (b === 'sw') ? ' (CONTROL)' : '';

        it(nn + '.1  ' + bd[1] + ctl + ': a fresh object shows the request\'s own session, in the template and the bootstrap', async function (t) {
            if (!ready(t, b)) return;
            [['fresh.A', SID_A], ['fresh.B', SID_B]].forEach(function (arm) {
                var l = lineOf(b, arm[0]);
                assert.equal(l.sid, arm[1], arm[0] + ': the template\'s page.data.session.id');
                assert.equal(l.title, 'F', arm[0] + ': the action\'s title');
                var boot = bootOf(b, arm[0], l.body);
                assert.equal(boot.id, arm[1], arm[0] + ': the bootstrap\'s session id');
                assert.match(boot.originalTimeout, /^\d+$/, arm[0] + ': the bootstrap\'s timeout is a number of milliseconds');
                assert.equal(leftOf(l.body), 0, arm[0] + ': no `{{ page.data.session.` placeholder left');
            });
        });

        it(nn + '.2  ' + bd[1] + ctl + ': an object with its own `session` member keeps its keys and gets the request\'s session', async function (t) {
            if (!ready(t, b)) return;
            var l = lineOf(b, 'freshsess');
            assert.equal(l.sid, SID_A, 'the template\'s page.data.session.id');
            assert.equal(l.user, 'app', 'the action\'s own session.user');
            assert.equal(bootOf(b, 'freshsess', l.body).id, SID_A, 'the bootstrap\'s session id');
            assert.equal(leftOf(l.body), 0, 'no `{{ page.data.session.` placeholder left');
        });

        it(nn + '.3  ' + bd[1] + ctl + ': an object with its own `page.data` keeps it and gets the request\'s session', async function (t) {
            if (!ready(t, b)) return;
            var l = lineOf(b, 'freshpage');
            assert.equal(l.title, 'P', 'the action\'s own page.data.title');
            assert.equal(l.sid, SID_A, 'the template\'s page.data.session.id');
            assert.equal(bootOf(b, 'freshpage', l.body).id, SID_A, 'the bootstrap\'s session id');
            assert.equal(leftOf(l.body), 0, 'no `{{ page.data.session.` placeholder left');
        });

        it(nn + '.4  ' + bd[1] + ctl + ': a layoutless render shows the request\'s own session', async function (t) {
            if (!ready(t, b)) return;
            var l = lineOf(b, 'freshnl');
            assert.equal(l.title, 'NL', 'the action\'s title, at the top level');
            assert.equal(l.sid, SID_A, 'the template\'s page.data.session.id');
            assert.equal(leftOf(l.body), 0, 'no `{{ page.data.session.` placeholder left');
        });

        it(nn + '.5  ' + bd[1] + ctl + ': one object on two sessions shows each request its own, and holds only its own keys', async function (t) {
            if (!ready(t, b)) return;
            [['reusedsess.A', SID_A], ['reusedsess.B', SID_B]].forEach(function (arm) {
                var l = lineOf(b, arm[0]);
                assert.equal(l.sid, arm[1], arm[0] + ': the template\'s page.data.session.id');
                assert.equal(l.user, 'app', arm[0] + ': the object\'s own session.user');
                assert.equal(bootOf(b, arm[0], l.body).id, arm[1], arm[0] + ': the bootstrap\'s session id');
                assert.equal(leftOf(l.body), 0, arm[0] + ': no `{{ page.data.session.` placeholder left');
            });
            var a = state[b].answers.peek;
            assert.equal(a.status, 200, 'peek: ' + String(a.err || a.body).slice(0, 300));
            assert.ok(a.json, 'peek answers JSON');
            assert.deepEqual(a.json.shared, ['title', 'session'], 'the shared object');
            assert.deepEqual(a.json.sharedSession, ['user'], 'its `session` member: gina wrote nothing into it');
        });

        it(nn + '.6  ' + bd[1] + ctl + ': a session\'s `lastModified` reaches the template and the bootstrap', async function (t) {
            if (!ready(t, b)) return;
            var l = lineOf(b, 'fresh.lm');
            assert.equal(l.sid, SID_A, 'the template\'s page.data.session.id');
            assert.equal(l.lm, LM, 'the template\'s page.data.session.lastModified');
            var boot = bootOf(b, 'fresh.lm', l.body);
            assert.equal(boot.id, SID_A, 'the bootstrap\'s session id');
            assert.equal(boot.lastModified, LM, 'the bootstrap\'s lastModified');
            assert.equal(leftOf(l.body), 0, 'no `{{ page.data.session.` placeholder left');
        });

        it(nn + '.7  ' + bd[1] + ctl + ': a page without a session gets empty session values, not the placeholders', async function (t) {
            if (!ready(t, b)) return;
            var l = lineOf(b, 'fresh.none');
            assert.equal(l.sid, '', 'the template\'s page.data.session.id is empty');
            assert.equal(l.title, 'F', 'the action\'s title');
            var boot = bootOf(b, 'fresh.none', l.body);
            assert.equal(boot.id, '', 'the bootstrap\'s session id is empty');
            assert.equal(boot.originalTimeout, '', 'the bootstrap\'s timeout is empty');
            assert.equal(leftOf(l.body), 0, 'no `{{ page.data.session.` placeholder left');
        });

        it(nn + '.8  ' + bd[1] + ctl + ': text rendered from app data keeps the session placeholder it holds; the id goes into the bootstrap only', async function (t) {
            if (!ready(t, b)) return;
            var l = lineOf(b, 'apptext');
            assert.equal(l.title, '{{ page.data.session.id }}', 'the app\'s text, as the action gave it');
            assert.equal(l.sid, SID_A, 'the template\'s page.data.session.id');
            assert.equal(bootOf(b, 'apptext', l.body).id, SID_A, 'the bootstrap\'s session id');
        });
    });
});
