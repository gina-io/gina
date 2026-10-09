#!/usr/bin/env node

/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @file script/smoke_in_container.js
 *
 * Pre-release smoke test — runs INSIDE a throwaway Docker/OrbStack container
 * (a stock `node:NN` image), never on the host directly. It is invoked by
 * `script/smoke_test_tarball.js`, which packs the candidate tarball with
 * `npm pack --ignore-scripts` (faithful published bytes, NO "Prerelease update"
 * commit) and bind-mounts the tarball plus this script into the container:
 *
 *   docker run --rm \
 *     -v <tarball>:/tmp/gina.tgz:ro \
 *     -v script/smoke_in_container.js:/tmp/smoke.js:ro \
 *     -e GINA_SMOKE_TARBALL=/tmp/gina.tgz -e GINA_SMOKE_VERSION=<version> \
 *     -e GINA_LOG_STDOUT=true \
 *     node:NN node /tmp/smoke.js
 *
 * What it proves end-to-end, against the EXACT bytes that would be published:
 *   1. `npm install -g <tarball>` succeeds (exercises pre/post-install scripts —
 *      the v0.3.8 "broken global install" regression class).
 *   2. `gina version` runs and prints a version.
 *   3. `gina project:add` scaffolds a project.
 *   4. `gina bundle:add api` + `frontend` + `db` scaffold three bundles.
 *   4b. The `db` bundle gets a SQLite connector fixture (connectors.json entry +
 *      entity + SQL files + a probe route) — see `sqliteFixtureFiles()`.
 *   5. All three bundles BOOT to a listening HTTP server via the daemonless
 *      launcher `gina-container` (no framework socket / port-8124 daemon needed)
 *      and answer HTTP 200 with the boilerplate greeting.
 *   6. The `db` bundle round-trips a real SQLite CREATE → INSERT → SELECT through
 *      the shipped ORM connector and reports the resolved driver.
 *
 * Why the SQLite leg exists (the connector coverage boundary, measured 2026-07-28):
 * no CI leg — Node or Bun — exercised ANY connector, so "Bun is a supported,
 * CI-gated runtime" only ever meant install → boot → HTTP 200 on a CONNECTOR-FREE
 * scaffold. SQLite is the one connector that needs zero npm install (it resolves
 * through `lib/sqlite-driver`: `node:sqlite` on Node, a `bun:sqlite` adapter on
 * Bun), so it is the cheapest possible guard for that whole surface.
 *
 * Exit codes: 0 — all checks passed; 1 — a check failed (the orchestrator turns
 * a non-zero exit into a loud red "DO NOT PUBLISH").
 *
 * Design notes mirrored from test/integration/container-boot.test.js (the proven
 * daemonless-boot harness):
 *   - CLI exit codes are NOT trusted (the first-run home bootstrap exits non-zero
 *     on a benign in-process MQ ECONNRESET); success is verified via the on-disk
 *     state files (projects.json / ports.reverse.json).
 *   - The bound port is read from ~/.gina/ports.reverse.json (the requested
 *     --start-port-from is only a hint; the resolved port can differ).
 *   - Boot via `gina-container <bundle> @<project>`, NOT `gina bundle:start`
 *     (the latter needs the port-8124 daemon, which a container does not run).
 */

'use strict';

var fs    = require('fs');
var os    = require('os');
var path  = require('path');
var net   = require('net');
var http  = require('http');
var https = require('https');
var { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var TARBALL          = process.env.GINA_SMOKE_TARBALL || '/tmp/gina.tgz';
var EXPECTED_VERSION = process.env.GINA_SMOKE_VERSION  || '';
var PROJECT          = 'smoke';
var PROJECT_DIR      = path.join(os.tmpdir(), 'gina-smoke-project');
var BUNDLES          = ['api', 'frontend', 'db'];   // added in this order; each gets its own webroot
var PORT_BASE        = 9700;                   // api 9700, frontend 9800, db 9900 (hints; resolved from state)
var GREETING         = 'Hello World';          // boilerplate config/app.json greeting
var GINA_HOME        = path.join(os.homedir(), '.gina');
var BOOT_TIMEOUT_MS  = 40000;                  // a cold container boot is slower than a warm host
var POLL_INTERVAL_MS = 300;

// -- SQLite connector leg -----------------------------------------------------
// Carried by its OWN bundle so `api` + `frontend` stay pristine: their
// "a plain scaffold boots and serves" assertion remains an untouched control, and
// a SQLite regression fails exactly one bundle instead of tainting all three.
var DB_BUNDLE  = 'db';                                             // bundle carrying the fixture
var DB_ENTRY   = 'smokedb';                                        // connectors.json key — MUST equal `database`
var DB_FILE    = path.join(os.tmpdir(), 'gina-smoke-smokedb.sqlite'); // explicit `file`, asserted verbatim
var DB_NS      = 'probe';                                          // routing namespace → controller.probe.js
var DB_ENTITY  = 'probe';                                          // entities/probe.js → sql/probe/
var DB_ROUTE   = 'sqlite-probe';                                   // routing.json rule name + url segment
var DB_ACTION  = 'sqliteProbe';                                    // param.control
var DB_TABLE   = 'smoke_probe';
// The driver KINDS the gate accepts, as `sqliteDriverKind()` reports them:
// `node:sqlite` is the runtime's own class, `bun:sqlite` is the bun:sqlite adapter
// (lib/sqlite-driver.js). Both are accepted on purpose — the adapter SELF-RETIRES
// when Bun ships node:sqlite (oven-sh/bun#20412; Bun 1.4 does), and pinning the
// Bun leg to the adapter would then go red exactly when the good thing happens.
//
// A kind, never a class NAME (#B828): Node 26.11.0 renamed node:sqlite's class
// from `DatabaseSync` to `Database` and a name list turned the gate red on a
// working connector. A name cannot tell the drivers apart either — bun:sqlite's
// own class is also called `Database`.
var DB_DRIVERS = ['node:sqlite', 'bun:sqlite'];

var booted = [];   // [{ name, proc, stdout, stderr, exit }] — SIGKILLed on shutdown

// Runtime. The orchestrator launches this script with `node` or `bun` as the
// container command, so detect which we're under. Under Bun the node-shebang
// `gina`/`gina-container` bins can't run (oven/bun has no node), so invoke their
// JS entry points with `bun` directly. (Bun's global install dir is the standard
// ~/.bun/install/global/node_modules location.)
var IS_BUN         = (typeof Bun !== 'undefined') || !!(process.versions && process.versions.bun);
var RUNTIME        = IS_BUN ? 'bun' : 'node';
var BUN_GINA_DIR   = path.join(os.homedir(), '.bun', 'install', 'global', 'node_modules', 'gina');
var GINA_ENTRY     = path.join(BUN_GINA_DIR, 'bin', 'gina');
var GINA_CONTAINER = path.join(BUN_GINA_DIR, 'bin', 'gina-container');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg)  { process.stdout.write('[ smoke ] ' + msg + '\n'); }
function ok(msg)   { process.stdout.write('[ smoke ] ✓ ' + msg + '\n'); }
function fail(msg) { process.stdout.write('[ smoke ] ✗ FAIL: ' + msg + '\n'); }

// ---------------------------------------------------------------------------
// Helpers (mirrored from test/integration/container-boot.test.js)
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

function waitForPort(port, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve) {
        (function poll() {
            isTcpPortOpen(port).then(function (open) {
                if (open)                   return resolve(true);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(poll, POLL_INTERVAL_MS);
            });
        })();
    });
}

function httpGet(useScheme, port, reqPath) {
    var lib = (useScheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: port, path: reqPath,
            method: 'GET', rejectUnauthorized: false
        }, function (res) {
            var body = '';
            res.on('data', function (chunk) { body += chunk; });
            res.on('end',  function () {
                resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: body });
            });
        });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '' }); });
        req.end();
    });
}

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/**
 * Reads a scaffolded bundle CONFIG json. Unlike {@link readJSON} this tolerates
 * the leading `// bundle needs to be restarted on changes !!` line the boilerplate
 * ships — plain `JSON.parse` throws on it. Only FULL-LINE `//` comments are
 * stripped, so the `https://` inside `$schema` survives.
 *
 * Mirrors `parseConfigJSON` in test/integration/container-boot.test.js.
 *
 * @param   {string} file  Absolute path to the config json.
 * @returns {object} The parsed config.
 */
function readConfigJSON(file) {
    var src = fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(function (line) { return !/^\s*\/\//.test(line); })
        .join('\n');
    return JSON.parse(src);
}

// ---------------------------------------------------------------------------
// SQLite connector fixture
// ---------------------------------------------------------------------------

/**
 * Builds the SQLite fixture written into the `db` bundle after `bundle:add`.
 *
 * Pure — returns `bundle-relative path → file content` and touches no disk, so
 * the shape is unit-testable without a container (test/lib/smoke-in-container-fixture.test.js).
 *
 * The layout is the one the shipped docs teach (the link-shortener tutorial):
 * a connectors.json entry, an entity class whose body stays empty, and one `.sql`
 * file per method. The SQLite connector discovers every method from the `.sql`
 * filenames at boot and attaches it to the entity prototype
 * (`core/connectors/sqlite/index.js`).
 *
 * `database` deliberately equals the entry key: two independent code paths
 * auto-create the models dir — one from the entry key (`core/model/index.js`),
 * one from `database` (`core/connectors/sqlite/index.js`) — so a mismatch
 * silently creates two directories and the SQL is loaded into neither.
 *
 * `file` is set explicitly rather than left to default (`~/.gina/<v>/<database>.sqlite`)
 * for three reasons: it exercises the `conf.file` branch a real deployment uses,
 * it keeps the probe DB out of `~/.gina`, and it makes the path assertable verbatim.
 * A real file (not `:memory:`) is used so the connector's WAL/synchronous pragmas
 * actually engage against a disk-backed database.
 *
 * @returns {Object<string, string>} Bundle-relative path → file content.
 */
function sqliteFixtureFiles() {
    var modelDir = 'models/' + DB_ENTRY;
    var files    = {};

    // Replaces the `$schema`-only scaffold stub. NOTE a connectors.json with no
    // object-valued keys boots green and silent (the #B29 guard short-circuits),
    // so a typo here would NOT fail the boot — which is exactly why the gate
    // asserts on the HTTP response body rather than on "the bundle started".
    var connectors = { '$schema': 'https://gina.io/schema/connectors.json' };
    connectors[DB_ENTRY] = {
        connector : 'sqlite',
        database  : DB_ENTRY,
        file      : DB_FILE
    };
    files['config/connectors.json'] = JSON.stringify(connectors, null, 2) + '\n';

    // The class body stays empty on purpose — every method comes from the .sql
    // files below. The entity CLASS name is derived from this FILENAME by the
    // connector (probe.js → Probe), not from the exported function's name.
    files[modelDir + '/entities/' + DB_ENTITY + '.js'] = [
        '/**',
        ' * Probe entity — SQL methods are attached from ' + modelDir + '/sql/' + DB_ENTITY + '/',
        ' * at boot by the SQLite connector. Written by script/smoke_in_container.js.',
        ' */',
        'function ProbeEntity() {}',
        '',
        'module.exports = ProbeEntity;',
        ''
    ].join('\n');

    files[modelDir + '/sql/' + DB_ENTITY + '/insert.sql'] = [
        '/*',
        ' * @param {string} ?',
        ' */',
        'INSERT INTO ' + DB_TABLE + ' (token) VALUES (?)',
        ''
    ].join('\n');

    // `@return {object}` selects stmt.get() — the first row, or null.
    files[modelDir + '/sql/' + DB_ENTITY + '/findByToken.sql'] = [
        '/*',
        ' * @param  {string} ?',
        ' * @return {object}',
        ' */',
        'SELECT token FROM ' + DB_TABLE + ' WHERE token = ?',
        ''
    ].join('\n');

    // A namespaced controller is required: without `namespace` the router loads
    // controllers/controller.js, whose scaffold declares no actions at all.
    files['controllers/controller.' + DB_NS + '.js'] = sqliteProbeController();

    return files;
}

/**
 * The probe table's DDL. Owned by the HARNESS, not by a `.sql` fixture file.
 *
 * MEASURED 2026-07-29 (node:24 container): the SQLite connector PRE-COMPILES every
 * `.sql` file at boot (`core/connectors/sqlite/index.js` → `readSQL`), so a
 * statement naming a table that does not exist yet fails `conn.prepare()` and its
 * error is LATCHED in `stmtError` for the whole process lifetime — a `setup.sql`
 * invoked later from an action creates the table but cannot rescue the already
 * failed statements. Real deployments migrate before the app starts; seeding here
 * mirrors that and keeps the fixture's SQL realistic.
 *
 * @returns {string} `CREATE TABLE IF NOT EXISTS` for the probe table.
 */
function sqliteSchemaSql() {
    return [
        'CREATE TABLE IF NOT EXISTS ' + DB_TABLE + ' (',
        '    id    INTEGER PRIMARY KEY AUTOINCREMENT,',
        '    token TEXT    NOT NULL UNIQUE',
        ')'
    ].join('\n');
}

/**
 * Names the SQLite driver behind a live connection — by IDENTITY, not by the
 * name of its class (#B828).
 *
 * `node:sqlite` when `conn` is an instance of the class the runtime's own
 * node:sqlite module exports: `Database` since Node 26.11.0, which kept
 * `DatabaseSync` as a deprecated alias, and `DatabaseSync` alone on older Node
 * and on Bun >= 1.4. `bun:sqlite` when it is the framework's bun:sqlite adapter
 * (`BunDatabaseSync`, lib/sqlite-driver.js). `null` for anything else — a raw
 * bun:sqlite connection included, whose class is also called `Database`.
 *
 * SELF-CONTAINED ON PURPOSE: `sqliteProbeController()` embeds this function's
 * SOURCE TEXT in the controller it writes, so it runs inside the bundle with
 * that module's own `require`. It must reference nothing outside itself.
 *
 * @param   {object} conn  A live connection (the model's `getConnection()`).
 * @returns {('node:sqlite'|'bun:sqlite'|null)} The driver kind, or `null` when
 *          `conn` is neither.
 * @example
 * var conn = getModel('smokedb').getConnection();
 * sqliteDriverKind(conn);   // 'node:sqlite' on Node, 'bun:sqlite' below Bun 1.4
 */
function sqliteDriverKind(conn) {
    if (!conn) return null;
    try {
        var nodeSqlite = require('node:sqlite');
        var names      = ['Database', 'DatabaseSync'];
        for (var i = 0; i < names.length; i++) {
            if (typeof nodeSqlite[names[i]] === 'function' && conn instanceof nodeSqlite[names[i]]) {
                return 'node:sqlite';
            }
        }
    } catch (e) { /* this runtime has no node:sqlite (Bun < 1.4) */ }
    if (conn.constructor && conn.constructor.name === 'BunDatabaseSync') return 'bun:sqlite';
    return null;
}

/**
 * Source of the probe controller written into the `db` bundle.
 *
 * The action drives the full ORM path (CREATE → INSERT → SELECT) and additionally
 * reports the live connection's driver — its kind, from `sqliteDriverKind()`,
 * and its class name beside it — so the gate has POSITIVE evidence the expected
 * driver is engaged rather than merely "nothing threw". The gate accepts on the
 * kind; the class name is printed only.
 *
 * The failure branch dumps `Object.keys(db)` because the entity key is registered
 * at runtime (`lib/model.js` `updateModel`) — if that contract ever moves, the
 * smoke says which keys DO exist instead of just reporting a TypeError.
 *
 * @returns {string} JavaScript source for `controllers/controller.<DB_NS>.js`.
 */
function sqliteProbeController() {
    return [
        '/**',
        ' * DbProbeController — the SQLite connector leg of the container smoke.',
        ' * Written by script/smoke_in_container.js; not part of the scaffold.',
        ' */',
        '',
        '// Carried as source — see sqliteDriverKind() in script/smoke_in_container.js.',
        sqliteDriverKind.toString(),
        '',
        'function DbProbeController() {',
        '    var self = this;',
        '',
        '    this.' + DB_ACTION + ' = async function(req, res) {',
        '        var db = null;',
        '        try {',
        '            db        = getModel(\'' + DB_ENTRY + '\');',
        '            var token = \'tok-\' + Date.now() + \'-\' + process.pid;',
        '',
        '            await db.' + DB_ENTITY + '.insert(token);',
        '            var row  = await db.' + DB_ENTITY + '.findByToken(token);',
        '            var conn = db.getConnection();',
        '',
        '            self.renderJSON({',
        '                sqlite   : \'ok\',',
        '                written  : token,',
        '                readBack : (row && row.token) || null,',
        '                driver   : sqliteDriverKind(conn),',
        '                driverClass : (conn && conn.constructor) ? conn.constructor.name : null,',
        '                file     : (conn && conn._file) || null,',
        '                runtime  : (process.versions && process.versions.bun)',
        '                    ? (\'bun \' + process.versions.bun)',
        '                    : (\'node \' + process.version)',
        '            });',
        '        } catch (e) {',
        '            // renderJSON() takes ONE argument — there is no status-code',
        '            // parameter (core/controller/controller.js), so this stays 200',
        '            // on purpose and the gate asserts on the BODY.',
        '            self.renderJSON({',
        '                sqlite    : \'error\',',
        '                error     : (e && e.message) || String(e),',
        '                modelKeys : db ? Object.keys(db) : null',
        '            });',
        '        }',
        '    };',
        '}',
        '',
        'module.exports = DbProbeController;',
        ''
    ].join('\n');
}

/**
 * The routing rule MERGED into the `db` bundle's scaffolded routing.json.
 *
 * Merged rather than overwritten so the scaffold's own `homepage` rule survives —
 * the greeting assertion for this bundle must keep testing the SCAFFOLD's route,
 * not one this script wrote.
 *
 * @returns {object} `{ '<DB_ROUTE>': { namespace, url, method, param } }`
 */
function sqliteRoutingRule() {
    var rule = {};
    rule[DB_ROUTE] = {
        namespace : DB_NS,
        url       : '/' + DB_ROUTE,
        method    : 'GET',
        param     : { control: DB_ACTION }
    };
    return rule;
}

/**
 * Runs a gina CLI command. The exit status is informational ONLY — callers
 * verify success via the on-disk state files, because the first-run home
 * bootstrap exits non-zero on a benign in-process MQ ECONNRESET teardown.
 *
 * @param   {string[]} args  CLI argv (e.g. `['bundle:add', 'api', '@smoke']`).
 * @returns {{status: (number|null), stdout: string, stderr: string, error: (Error|undefined)}}
 */
function gina(args) {
    // Run from PROJECT_DIR (a real directory): when a command has no --path, the
    // gina CLI resolves the project from process.cwd() and ERRORS ("run command
    // from a deleted path") if the container's default CWD ("/") can't serve as a
    // project-resolution base. PROJECT_DIR is created before any gina() call.
    var r = IS_BUN
        ? spawnSync('bun', [GINA_ENTRY].concat(args), { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 120000 })
        : spawnSync('gina', args, { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 120000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/**
 * Boots one scaffolded bundle via the daemonless `gina-container` launcher and
 * wires up stream + exit capture for diagnostics. Each call keeps its own
 * record so the stream listeners never cross-bind under a loop.
 *
 * @param   {string} name  Bundle name.
 * @returns {{name: string, proc: object, stdout: string, stderr: string, exit: (object|null)}}
 */
function bootBundle(name) {
    var rec = { name: name, proc: null, stdout: '', stderr: '', exit: null };
    if (IS_BUN) {
        rec.proc = spawn('bun', [GINA_CONTAINER, name, '@' + PROJECT], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
        rec.proc = spawn('gina-container', [name, '@' + PROJECT], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    rec.proc.stdout.on('data', function (d) { rec.stdout += d; });
    rec.proc.stderr.on('data', function (d) { rec.stderr += d; });
    rec.proc.on('exit', function (code, signal) { rec.exit = { code: code, signal: signal }; });
    booted.push(rec);
    return rec;
}

/**
 * Rich boot-failure diagnostic — distinguishes a CRASH (non-zero exit before
 * binding; a timeout bump would not help) from a genuine stalled boot (never
 * reached `.listen()`), and dumps both child streams with byte counts (the
 * 2026-06-10 CI flake came back with an EMPTY tail).
 *
 * @inner
 * @param {object} rec  A {@link bootBundle} record.
 * @returns {string}
 */
function diagnostics(rec) {
    var note;
    if (rec.exit === null)        note = 'still running at deadline — a stalled boot (never reached .listen())';
    else if (rec.exit.code === 0) note = 'exited cleanly (code 0) before binding — unexpected';
    else                          note = 'CRASHED (exit ' + rec.exit.code + ', signal ' + rec.exit.signal + ') before binding — a boot crash, NOT a slow boot';
    return 'container exit: ' + JSON.stringify(rec.exit) + ' — ' + note + '\n' +
           'stdout (' + rec.stdout.length + 'b):\n' + (rec.stdout || '(empty)') + '\n---\n' +
           'stderr (' + rec.stderr.length + 'b):\n' + (rec.stderr || '(empty)');
}

/**
 * Dumps a booted bundle's captured streams WITHOUT {@link diagnostics}'s boot
 * verdict — that verdict ("still running at deadline — a stalled boot") is
 * correct only before a bundle binds, and actively misleading for a failure
 * observed AFTER it is already serving.
 *
 * @inner
 * @param {object} rec  A {@link bootBundle} record.
 * @returns {string}
 */
function streams(rec) {
    return 'stdout (' + rec.stdout.length + 'b):\n' + (rec.stdout || '(empty)') + '\n---\n' +
           'stderr (' + rec.stderr.length + 'b):\n' + (rec.stderr || '(empty)');
}

/**
 * Creates the probe table in {@link DB_FILE} before any bundle boots — see
 * {@link sqliteSchemaSql} for why the harness owns the schema.
 *
 * Driver resolution mirrors `lib/sqlite-driver.js` (node:sqlite first, bun:sqlite
 * under Bun) but is deliberately LOCAL and independent: the harness must not have
 * to locate the installed framework tree, and keeping the two resolutions separate
 * means the bundle's own resolution stays the thing actually under measurement.
 *
 * @inner
 * @returns {{ok: boolean, kind: (string|undefined), error: (string|undefined)}}
 */
function seedSqliteSchema() {
    var Database = null;
    var kind     = null;
    var nodeErr  = null;

    try {
        // Node 26.11.0 renamed the class to `Database` and kept `DatabaseSync` as a
        // deprecated alias (DEP0210): take whichever name this runtime exports.
        var nodeSqlite = require('node:sqlite');
        Database = nodeSqlite.Database || nodeSqlite.DatabaseSync;
        kind     = 'node:sqlite';
    } catch (e) {
        nodeErr = e;
        try {
            Database = require('bun:sqlite').Database;
            kind     = 'bun:sqlite';
        } catch (e2) {
            return { ok: false, error: 'no synchronous SQLite driver in this runtime — ' +
                'node:sqlite: ' + nodeErr.message + ' | bun:sqlite: ' + e2.message };
        }
    }

    try {
        var db = new Database(DB_FILE);
        db.exec(sqliteSchemaSql());
        db.close();
        return { ok: true, kind: kind };
    } catch (e) {
        return { ok: false, error: 'could not seed ' + DB_FILE + ' via ' + kind + ': ' + e.message };
    }
}

function shutdown() {
    booted.forEach(function (b) {
        try { if (b.proc && b.proc.exitCode === null) b.proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
    });
}

function die(code) { shutdown(); process.exit(code); }

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

async function main() {
    log((IS_BUN ? ('bun ' + (process.versions.bun || '')) : ('node ' + process.version)) +
        ' — tarball ' + TARBALL + (EXPECTED_VERSION ? ' (candidate ' + EXPECTED_VERSION + ')' : ''));

    // Every gina() call runs from PROJECT_DIR (see the gina() helper) — create it
    // up front so the CWD is a real directory before the first CLI invocation.
    fs.mkdirSync(PROJECT_DIR, { recursive: true });

    // 1. Install the candidate globally. Node: `npm install -g` (exercises
    //    pre/post-install). Bun: `bun add -g` — note Bun blocks dependency
    //    postinstall by default, so ~/.gina + framework deps are NOT bootstrapped;
    //    the smoke then surfaces the first runtime break under Bun.
    var t0 = Date.now();
    var inst;
    if (IS_BUN) {
        log('bun add -g ' + TARBALL + ' ...');
        inst = spawnSync('bun', ['add', '-g', TARBALL], { stdio: 'inherit', timeout: 600000 });
    } else {
        // npm 12 blocks dependency install scripts by default (allowScripts).
        // A tarball install resolves to a file: identity, so the name-based
        // `--allow-scripts=gina` opt-in cannot match it — the all-scripts
        // escape hatch is the only opt-in that works for a tarball, and this
        // is a throwaway container. Harmless on npm <= 11: unknown CLI
        // configs only warn there, and install scripts already run by default.
        log('npm install -g ' + TARBALL + ' --dangerously-allow-all-scripts (runs pre/post-install) ...');
        inst = spawnSync('npm', ['install', '-g', TARBALL, '--dangerously-allow-all-scripts'], { stdio: 'inherit', timeout: 600000 });
    }
    if (inst.error) { fail('could not run the ' + RUNTIME + ' installer: ' + inst.error.message); return die(1); }
    if (inst.status !== 0) { fail('global install exited ' + inst.status); return die(1); }
    ok('installed in ' + Math.round((Date.now() - t0) / 1000) + 's');
    if (IS_BUN) {
        log('note: Bun blocks dependency postinstall by default — ~/.gina + framework deps (swig/psl/ws) are NOT auto-bootstrapped; surfacing the first runtime break.');
    }

    // 2. gina version — proves the CLI resolves and runs offline.
    var ver = gina(['version']);
    if (ver.error) { fail('`gina` not runnable after install: ' + ver.error.message + ' (is it on PATH?)'); return die(1); }
    if (ver.status !== 0) { fail('`gina version` exited ' + ver.status + '\n' + (ver.stderr || ver.stdout)); return die(1); }
    var verOut = (ver.stdout + ver.stderr).trim();
    if (!verOut) { fail('`gina version` produced no output'); return die(1); }
    ok('gina version → ' + verOut.split('\n')[0]);
    if (EXPECTED_VERSION && verOut.indexOf(EXPECTED_VERSION) < 0) {
        // Soft check: a STABLE cut packs pre-rename bytes whose internal version
        // still carries the prior alpha suffix (the framework dir is renamed only
        // inside the `prepare` hook, after this gate). The code is identical, so a
        // version-string mismatch here is expected, not a failure.
        log('note: candidate "' + EXPECTED_VERSION + '" not found verbatim in `gina version` output — expected for a stable pre-rename smoke.');
    }

    // 3. project:add — scaffold the project (verify via projects.json, not exit code).
    gina(['project:add', '@' + PROJECT, '--path=' + PROJECT_DIR]);
    var projectsPath = path.join(GINA_HOME, 'projects.json');
    if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJECT]) {
        fail('project:add did not register @' + PROJECT + ' in ' + projectsPath); return die(1);
    }
    ok('project @' + PROJECT + ' scaffolded at ' + PROJECT_DIR);

    // 4. bundle:add api + frontend (verify via ports.reverse.json + the entry point).
    var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
    for (var i = 0; i < BUNDLES.length; i++) {
        var b   = BUNDLES[i];
        var key = b + '@' + PROJECT;
        gina(['bundle:add', b, '@' + PROJECT, '--start-port-from=' + (PORT_BASE + i * 100)]);
        if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) {
            fail('bundle:add did not register ' + key + ' in ports.reverse.json'); return die(1);
        }
        var entry = path.join(PROJECT_DIR, 'src', b, 'index.js');
        if (!fs.existsSync(entry)) { fail('bundle entry point not scaffolded: ' + entry); return die(1); }
        ok('bundle ' + b + ' scaffolded');
    }

    // 4b. Write the SQLite connector fixture into the `db` bundle.
    //     Done AFTER bundle:add and BEFORE any boot: connectors.json and
    //     routing.json are read once at boot and are NOT hot-reloaded, so writing
    //     them now sidesteps the restart the scaffold's own header warns about.
    var dbDir    = path.join(PROJECT_DIR, 'src', DB_BUNDLE);
    var fixture  = sqliteFixtureFiles();
    var relPaths = Object.keys(fixture);
    for (var fx = 0; fx < relPaths.length; fx++) {
        var target = path.join(dbDir, relPaths[fx]);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, fixture[relPaths[fx]]);
    }

    // routing.json is MERGED, never clobbered — the scaffold's `homepage` rule is
    // what the greeting assertion below tests for this bundle.
    var dbRoutingPath = path.join(dbDir, 'config', 'routing.json');
    var dbRouting     = readConfigJSON(dbRoutingPath);
    var probeRule     = sqliteRoutingRule();
    var ruleNames     = Object.keys(probeRule);
    for (var rn = 0; rn < ruleNames.length; rn++) {
        dbRouting[ruleNames[rn]] = probeRule[ruleNames[rn]];
    }
    fs.writeFileSync(dbRoutingPath, JSON.stringify(dbRouting, null, 2) + '\n');
    ok('sqlite fixture written into the ' + DB_BUNDLE + ' bundle (' + (relPaths.length + 1) + ' files, db=' + DB_FILE + ')');

    // 4c. Seed the schema BEFORE the boot — the connector pre-compiles every .sql
    //     file at boot, so the tables its statements name must already exist.
    var seeded = seedSqliteSchema();
    if (!seeded.ok) { fail('could not prepare the sqlite fixture database: ' + seeded.error); return die(1); }
    ok('sqlite schema seeded via ' + seeded.kind + ' at ' + DB_FILE);

    // 5. Boot each bundle and verify it serves — SEQUENTIALLY, one at a time.
    //    gina-container is one-bundle-per-container by design (the k8s model).
    //    Booting two bundles of the same project CONCURRENTLY races on the shared
    //    bundles/ mount symlinks (gna.js mountBundle does check→rmSync→symlinkSync)
    //    and on the shared project config load — which crashes the second bundle.
    //    Booting+verifying each bundle before the next starts removes the race.
    var projects     = readJSON(projectsPath);
    var portsReverse = readJSON(portsReversePath);
    var pe     = projects[PROJECT];
    var env    = pe.def_env      || 'dev';
    var scheme = pe.def_scheme   || 'http';
    var proto  = pe.def_protocol;

    for (var j = 0; j < BUNDLES.length; j++) {
        var name = BUNDLES[j];
        var k    = name + '@' + PROJECT;

        var port;
        try { port = portsReverse[k][env][proto][scheme]; } catch (e) { port = null; }
        if (!port) { fail('could not resolve bound port for ' + k + ' (' + env + '/' + proto + '/' + scheme + ')'); return die(1); }

        var webroot;
        try {
            var ssj = fs.readFileSync(path.join(PROJECT_DIR, 'src', name, 'config', 'settings.server.json'), 'utf8');
            var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + name);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + name + '/'; }

        var rec = bootBundle(name);
        log('booting ' + name + ' → ' + scheme + '://127.0.0.1:' + port + webroot + ' (gina-container)');

        var opened = await waitForPort(port, BOOT_TIMEOUT_MS);
        if (!opened) {
            fail(name + ' never bound port ' + port + ' within ' + BOOT_TIMEOUT_MS + ' ms.\n' + diagnostics(rec));
            return die(1);
        }
        var res = await httpGet(scheme, port, webroot);
        if (res.status !== 200) {
            fail('GET ' + scheme + '://127.0.0.1:' + port + webroot + ' returned ' + res.status +
                 (res.err ? ' (' + res.err + ')' : '') + '\n' + diagnostics(rec));
            return die(1);
        }
        if (res.body.indexOf(GREETING) < 0) {
            fail(name + ' served 200 but body lacks the "' + GREETING + '" greeting.\nfirst 200 chars: ' + res.body.substring(0, 200));
            return die(1);
        }
        ok(name + ' serving HTTP 200 with greeting at ' + scheme + '://127.0.0.1:' + port + webroot);

        // 6. SQLite connector round-trip — the connector coverage gate.
        //    `webroot` is already normalised with a trailing slash and config.js
        //    prefixes every route url with it, so never hardcode the path here.
        if (name === DB_BUNDLE) {
            var probeUrl = webroot + DB_ROUTE;
            var probeRes = await httpGet(scheme, port, probeUrl);
            if (probeRes.status !== 200) {
                fail('GET ' + scheme + '://127.0.0.1:' + port + probeUrl + ' returned ' + probeRes.status +
                     (probeRes.err ? ' (' + probeRes.err + ')' : '') +
                     '\nbody: ' + (probeRes.body || '(empty)').substring(0, 600) + '\n' + streams(rec));
                return die(1);
            }
            var probeBody;
            try { probeBody = JSON.parse(probeRes.body); }
            catch (e) {
                fail('sqlite probe did not return JSON.\nbody: ' + (probeRes.body || '(empty)').substring(0, 600));
                return die(1);
            }
            if (probeBody.sqlite !== 'ok') {
                fail('sqlite probe reported failure: ' + JSON.stringify(probeBody) + '\n' + streams(rec));
                return die(1);
            }
            // Positive evidence, not absence-of-error: the value written must come
            // back out of the database, so a stubbed/no-op query cannot pass.
            if (!probeBody.written || probeBody.readBack !== probeBody.written) {
                fail('sqlite round-trip mismatch — wrote ' + JSON.stringify(probeBody.written) +
                     ' but read back ' + JSON.stringify(probeBody.readBack));
                return die(1);
            }
            // The KIND is decided by identity inside the bundle (sqliteDriverKind);
            // the class name rides along for the log line and is never gated.
            if (DB_DRIVERS.indexOf(probeBody.driver) < 0) {
                fail('unexpected SQLite driver ' + JSON.stringify(probeBody.driver) +
                     ' (class ' + JSON.stringify(probeBody.driverClass) + ')' +
                     ' — expected one of ' + DB_DRIVERS.join(' | ') + '.\n' +
                     'A null driver means the connection is neither an instance of this runtime\'s node:sqlite class\n' +
                     'nor the framework\'s bun:sqlite adapter. Under Bun this should be the adapter unless Bun has shipped node:sqlite.');
                return die(1);
            }
            // Proves the CONFIGURED entry was used and not a defaulted path.
            if (probeBody.file !== DB_FILE) {
                fail('sqlite connector opened ' + JSON.stringify(probeBody.file) +
                     ' but connectors.json configured ' + JSON.stringify(DB_FILE));
                return die(1);
            }
            ok('sqlite connector round-trip OK — driver ' + probeBody.driver +
               ' (class ' + probeBody.driverClass + '), db ' + probeBody.file + ' (' + probeBody.runtime + ')');
        }
    }

    log('ALL CHECKS PASSED on ' + (IS_BUN ? ('bun ' + (process.versions.bun || '')) : ('node ' + process.version)));
    return die(0);
}

// Guarded so the fixture builders above can be required by
// test/lib/smoke-in-container-fixture.test.js without booting the smoke.
// MEASURED both directions before relying on it: `require.main === module` is
// true when run directly under BOTH node:24 and oven/bun:1.3.14, and false when
// required from node:test — so this can neither skip the smoke in a container nor
// run it inside the suite.
if (require.main === module) {
    main().catch(function (e) { fail('unexpected error: ' + (e && e.stack ? e.stack : e)); die(1); });
}

module.exports = {
    sqliteFixtureFiles   : sqliteFixtureFiles,
    sqliteProbeController: sqliteProbeController,
    sqliteDriverKind     : sqliteDriverKind,
    sqliteRoutingRule    : sqliteRoutingRule,
    sqliteSchemaSql      : sqliteSchemaSql,
    readConfigJSON       : readConfigJSON,
    BUNDLES              : BUNDLES,
    DB_BUNDLE            : DB_BUNDLE,
    DB_ENTRY             : DB_ENTRY,
    DB_FILE              : DB_FILE,
    DB_NS                : DB_NS,
    DB_ENTITY            : DB_ENTITY,
    DB_ROUTE             : DB_ROUTE,
    DB_ACTION            : DB_ACTION,
    DB_TABLE             : DB_TABLE,
    DB_DRIVERS           : DB_DRIVERS
};
