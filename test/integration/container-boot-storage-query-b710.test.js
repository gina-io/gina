/**
 * #B710 — the `/_gina/storage/*` endpoints read their query on the default engine, through a
 * booted bundle: `?dryRun=1` stays a dry run and `?driver=` filters.
 *
 * Isaac, the default engine, parses a request's query into `request.query` and then strips
 * it from `request.url` before handing the request to the engine-agnostic handlers in
 * core/server.js — and the three storage handlers read `?dryRun=` / `?driver=` from
 * `request.url`. So on isaac `POST /_gina/storage/gc?dryRun=1` (what
 * `gina storage:gc --dry-run` sends to a running bundle) ran a REAL collection over every
 * driver, and `stats` / `verify` ignored `?driver=`. The express engine keeps the query on
 * `request.url`, which is why the handlers looked right.
 *
 * This file boots the REAL `bin/gina-container` (isaac, http/1.1) with one `cas` storage
 * driver whose root holds ONE collectable blob — a zero-reference row past the sweep grace,
 * with its file — seeded before boot through the storage module's own factory (the
 * test/lib/storage-maintenance.test.js idiom). Arms:
 *
 *   01  preconditions — the driver is configured and holds one collectable blob
 *   02  the query is read — a filter naming no driver answers 404 on stats, verify and gc;
 *       `?dryRun=1` reports a dry run, lists the blob, and leaves its row and its file
 *   03  a real collection then removes the blob the dry run kept
 *
 * Isolation: the container-boot-route-confusion.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (10700), the storage root inside that HOME (outside the
 * project and its statics), project:rm + rmSync at teardown. Seam: `B710_GINA_ROOT=<tree>`
 * boots THAT tree (red-first: a tree without the fix).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-storage-query-b710.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { Readable } = require('stream');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-sq-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'sq' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var STO_ROOT   = path.join(FAKE_HOME, 'storage-cas');
var PORT_START = 10700;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B710_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');
var FW        = path.join(GINA_ROOT, 'framework', 'v' + require(path.join(GINA_ROOT, 'package.json')).version);

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null;
var child = null, childOut = '', childExit = null;
var blobKey = null;


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

/** One HTTP/1.1 request from loopback with no browser signal — what the gina CLI sends. */
function request(method, absPath) {
    return new Promise(function (resolve) {
        var req = http.request({ host: '127.0.0.1', port: bundlePort, path: absPath, method: method, agent: false }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, body: data, json: json });
            });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null }); });
        req.end();
    });
}

function show(r) { return JSON.stringify({ status: r.status, body: (r.body || '').slice(0, 240), err: r.err || undefined }); }

/** The cas driver's own entry in a stats reply. */
function casStore(r) {
    var d = (r.json && Array.isArray(r.json.drivers)) ? r.json.drivers.filter(function (x) { return x && x.name === 'cas'; })[0] : null;
    return d ? d.store : null;
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/**
 * Put one blob into a cas root through the storage module's own factory, release it, and
 * backdate its zero-reference time two hours — past the default one-hour sweep grace — so a
 * collection pass takes it. `inlineThreshold` 0 keeps the bytes in a FILE, which the arms
 * can look at. The driver is closed before the bundle opens the root (one process per root).
 *
 * @returns {Promise<string>} the blob's key
 */
function seedCollectableBlob() {
    var storage      = require(path.join(FW, 'lib', 'storage', 'src', 'main.js'));
    var sqliteDriver = require(path.join(FW, 'lib', 'sqlite-driver'));
    fs.mkdirSync(STO_ROOT, { recursive: true });
    return new Promise(function (resolve, reject) {
        var conf = storage._resolveDriverConf({ root: STO_ROOT, strategy: 'cas', sweepInterval: '0s' });
        conf.inlineThreshold = 0;
        var driver = storage._FACTORIES.cas('cas', conf, storage._createEmbeddedMetaStore(path.join(STO_ROOT, '.meta.db')));
        driver.put(Readable.from([Buffer.alloc(4096, 0x42)]), { originalName: 'seed.bin', contentType: 'application/octet-stream' }, function (err, r) {
            if (err) { driver.close(); return reject(err); }
            driver.release(r.key, function (err2) {
                if (err2) { driver.close(); return reject(err2); }
                try {
                    var DatabaseSync = sqliteDriver.getDatabaseSync();
                    var db = new DatabaseSync(path.join(STO_ROOT, '.meta.db'));
                    db.prepare('UPDATE objects SET zero_at = ? WHERE key = ?').run(Date.now() - 2 * 3600 * 1000, r.key);
                    db.close();
                } catch (e) { driver.close(); return reject(e); }
                driver.close();
                resolve(r.key);
            });
        });
    });
}

/** Declare the `cas` driver in the scaffold's settings.json (it carries // comments: splice, never parse). */
function installStorageSettings() {
    var file   = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.json');
    var src    = fs.readFileSync(file, 'utf8');
    var anchor = '    "swig": {';
    if (src.split(anchor).length !== 2) { throw new Error('settings.json anchor count ' + (src.split(anchor).length - 1)); }
    var block = '    "storage": {\n'
              + '        "drivers": {\n'
              + '            "cas": { "adapter": "local", "strategy": "cas", "root": ' + JSON.stringify(STO_ROOT)
              + ', "sweepInterval": "0s", "inlineThreshold": "0B" }\n'
              + '        }\n'
              + '    },\n';
    fs.writeFileSync(file, src.replace(anchor, block + anchor));
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('30 - container-boot-storage-query-b710 — the storage endpoints read ?dryRun= and ?driver= on the default engine (#B710)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) { setupError = 'project:add did not register @' + PROJ; return; }
        runCli(['bundle:add', BUNDLE, '@' + PROJ, '--start-port-from=' + PORT_START]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var key = BUNDLE + '@' + PROJ;
        if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) { setupError = 'bundle:add did not register ' + key; return; }

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        // after the last CLI verb: a CLI run re-stubs the settings files
        try { installStorageSettings(); } catch (e) { setupError = 'settings splice failed: ' + (e.message || e); return; }
        try { blobKey = await seedCollectableBlob(); } catch (e) { setupError = 'seeding the blob failed: ' + (e.stack || e); return; }
        if (!fs.existsSync(path.join(STO_ROOT, blobKey))) { setupError = 'the seeded blob has no file at ' + blobKey; return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try { bundlePort = readJSON(portsReversePath)[key][env]['http/1.1']['http']; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the http/1.1 http port for ' + key; return; }

        // ONE boot for every arm
        child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', function (d) { childOut += d; });
        child.stderr.on('data', function (d) { childOut += d; });
        child.on('exit', function (code, signal) { childExit = { code: code, signal: signal }; });
        var deadline = Date.now() + BOOT_TIMEOUT_MS, up = false;
        while (Date.now() < deadline && !childExit) {
            if (await isTcpPortOpen(bundlePort)) { up = true; break; }
            await sleep(POLL_INTERVAL_MS);
        }
        if (!up) { setupError = 'the bundle did not come up: exit ' + JSON.stringify(childExit) + '\n' + childOut.slice(-2000); return; }
        await sleep(300);
    });

    after(async function () {
        if (isChildAlive()) {
            try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
            var until = Date.now() + 12000;
            while (Date.now() < until && isChildAlive()) { await sleep(150); }
            if (isChildAlive()) {
                // SIGKILL cannot be forwarded: signal the bundle process too, or it outlives the run
                var m = childOut.match(/\[ FRAMEWORK \]\[ (\d+) \]/);
                if (m) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch (e) { /* gone */ } }
                try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
            }
        }
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or non-empty: leave it */ }
    });

    function ready(t) {
        if (skip) { t.skip(skipReason); return false; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        return true;
    }

    // ── 01 preconditions ──────────────────────────────────────────────────

    it('01.1  the cas driver is configured and holds one collectable blob', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', '/_gina/storage/stats');
        assert.equal(r.status, 200, show(r));
        assert.equal(r.json && r.json.configured, true, show(r));
        var store = casStore(r);
        assert.ok(store, 'no cas driver in ' + show(r));
        assert.equal(store.zeroRefPending, 1, show(r));
    });

    // ── 02 the query is read ──────────────────────────────────────────────

    it('02.1  stats honours ?driver= — a name no driver has answers 404 (pre-fix: 200, every driver)', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', '/_gina/storage/stats?driver=__nope__');
        assert.equal(r.status, 404, show(r));
    });

    it('02.2  verify honours ?driver= — a name no driver has answers 404 (pre-fix: 200, every driver)', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', '/_gina/storage/verify?driver=__nope__');
        assert.equal(r.status, 404, show(r));
    });

    it('02.3  gc honours ?driver= — a name no driver has answers 404 before any sweep (pre-fix: a real sweep of every driver)', async function (t) {
        if (!ready(t)) return;
        var r = await request('POST', '/_gina/storage/gc?dryRun=1&driver=__nope__');
        assert.equal(r.status, 404, show(r));
    });

    it('02.4  ?dryRun=1 is a dry run — it reports so and lists the blob (pre-fix: dryRun false, the blob collected)', async function (t) {
        if (!ready(t)) return;
        var r = await request('POST', '/_gina/storage/gc?dryRun=1');
        assert.equal(r.status, 200, show(r));
        assert.equal(r.json && r.json.dryRun, true, show(r));
        var cas = (r.json.drivers || []).filter(function (x) { return x && x.name === 'cas'; })[0];
        assert.ok(cas, show(r));
        assert.deepEqual(cas.collectable, [blobKey], show(r));
        assert.equal(typeof cas.collected, 'undefined', 'a dry run collects nothing: ' + show(r));
    });

    it('02.5  after the dry run the blob is still there — its row and its file', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', '/_gina/storage/stats');
        var store = casStore(r);
        assert.ok(store, show(r));
        assert.equal(store.zeroRefPending, 1, show(r));
        assert.equal(fs.existsSync(path.join(STO_ROOT, blobKey)), true, 'the dry run removed the blob file');
    });

    // ── 03 a real collection ──────────────────────────────────────────────

    it('03.1  a real gc collects the blob the dry run kept', async function (t) {
        if (!ready(t)) return;
        var r = await request('POST', '/_gina/storage/gc');
        assert.equal(r.status, 200, show(r));
        assert.equal(r.json && r.json.dryRun, false, show(r));
        var cas = (r.json.drivers || []).filter(function (x) { return x && x.name === 'cas'; })[0];
        assert.ok(cas, show(r));
        assert.equal(cas.collected, 1, show(r));
    });

    it('03.2  after it, the row and the file are gone', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', '/_gina/storage/stats');
        var store = casStore(r);
        assert.ok(store, show(r));
        assert.equal(store.zeroRefPending, 0, show(r));
        assert.equal(fs.existsSync(path.join(STO_ROOT, blobKey)), false, 'the blob file survived a real collection');
    });
});
