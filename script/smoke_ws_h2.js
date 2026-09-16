'use strict';
/**
 * #H13 WebSocket-over-HTTP/2 container smoke — the RUNTIME gate the node:test
 * suite structurally cannot provide.
 *
 * The suite already covers ws-over-h2 thoroughly on Node (`test/lib/ws-session.test.js`
 * drives a real h2c loopback with genuine RFC 8441 extended-CONNECT pseudo-headers,
 * plus `ws-framing` / `server-ws-routes` / `component-ws-lifecycle`) — but it is
 * Node-only by design, so NOTHING exercised ws-over-h2 under Bun. This script is
 * that missing leg: it boots a real bundle over https/h2 with
 * `http2Options.enableConnectProtocol`, declares a `method:"ws"` route, and drives a
 * genuine extended CONNECT plus an RFC 6455 frame round-trip through the shipped
 * `lib/ws-framing` codec.
 *
 * Deliberately SEPARATE from `smoke_in_container.js` rather than a fourth bundle in
 * it: that script's boot loop resolves ONE scheme/protocol for every bundle
 * (`pe.def_scheme` / `pe.def_protocol`), so an https/h2 bundle would force a refactor
 * of the loop gating the three existing bundles — a blocking release gate. This leg
 * is additive and its failures are attributable to itself.
 *
 * Runs INSIDE a disposable container:
 *   docker run --rm -v <tarball>:/tmp/gina.tgz:ro -v <this>:/tmp/ws.js:ro \
 *     -v <certdir>:/tmp/gina-cert:ro <image> <node|bun> /tmp/ws.js
 *
 * The cert is generated HOST-side and mounted because only `oven/bun:1.4.2` ships
 * openssl — node:22/24/26-slim and oven/bun:1.3.14 do not (measured 2026-09-17).
 *
 * @module script/smoke_ws_h2
 */

var fs    = require('fs');
var os    = require('os');
var path  = require('path');
var net   = require('net');
var http2 = require('http2');
var cp    = require('child_process');

var TARBALL   = process.env.GINA_SMOKE_TARBALL || '/tmp/gina.tgz';
var CERT_DIR  = process.env.GINA_SMOKE_CERT    || '/tmp/gina-cert';
var PROJECT   = 'wssmoke';
var BUNDLE    = 'ws';
var PROJECT_DIR = path.join(os.tmpdir(), 'gina-ws-smoke-project');
var GINA_HOME   = path.join(os.homedir(), '.gina');
var PORT_FROM   = 9700;
var BOOT_TIMEOUT_MS = 60000;
var WS_ROOM   = 'room1';
var WS_RULE   = 'ws-echo';
var WS_HANDLER = 'echo';

var IS_BUN         = (typeof Bun !== 'undefined') || !!(process.versions && process.versions.bun);
var RUNTIME_LABEL  = IS_BUN ? ('bun ' + (process.versions.bun || '?')) : ('node ' + process.version);
var BUN_GINA_DIR   = path.join(os.homedir(), '.bun', 'install', 'global', 'node_modules', 'gina');
var GINA_ENTRY     = path.join(BUN_GINA_DIR, 'bin', 'gina');
var GINA_CONTAINER = path.join(BUN_GINA_DIR, 'bin', 'gina-container');

function log(m)  { process.stdout.write('[ ws-smoke ] ' + m + '\n'); }
function ok(m)   { process.stdout.write('[ ws-smoke ] ✓ ' + m + '\n'); }
function fail(m) { process.stdout.write('[ ws-smoke ] ✗ FAIL: ' + m + '\n'); }

var child = null;
function teardown() { try { if (child && child.pid) process.kill(child.pid, 'SIGTERM'); } catch (e) { /* gone */ } }
function die(code, why) { fail(why); teardown(); process.exit(code); }

/**
 * Whether THIS runtime is expected to advertise RFC 8441 extended CONNECT.
 *
 * This is the two-sided half of the gate: the leg asserts the ACTUAL advertisement
 * equals the EXPECTED one, so it fails both when a capable runtime regresses AND
 * when an incapable one unexpectedly gains it — never a silent skip.
 *
 * Bun shipped `SETTINGS_ENABLE_CONNECT_PROTOCOL` in 1.4 (measured 2026-09-17:
 * oven/bun:1.3.14 advertises `false`, oven/bun:1.4.2 advertises `true`).
 *
 * @returns {boolean} `true` when the runtime must advertise.
 * @example
 *  if (expectedAdvertise() !== actual) { /* gate fails *\/ }
 */
function expectedAdvertise() {
    if (!IS_BUN) { return true; }                       // every supported Node major advertises
    var v = String(process.versions.bun || '').split('.');
    var major = parseInt(v[0], 10);
    var minor = parseInt(v[1], 10);
    if (isNaN(major) || isNaN(minor)) { return true; }  // unknown Bun → hold it to the capable bar
    return (major > 1) || (major === 1 && minor >= 4);
}

/**
 * The bundle fixture written after `bundle:add`.
 *
 * Pure — returns `bundle-relative path -> content` and touches no disk, so the shape
 * is unit-testable without a container (mirrors `sqliteFixtureFiles()`).
 *
 * The handler echoes the captured `:room` param so the assertion proves BOTH the
 * frame round-trip and param capture, not merely that bytes came back.
 *
 * @returns {Object<string,string>} Bundle-relative path -> file content.
 * @example
 *  var f = wsFixtureFiles(); // { 'channels/echo.js': 'module.exports = ...' }
 */
function wsFixtureFiles() {
    var files = {};
    files['channels/' + WS_HANDLER + '.js'] =
        '\'use strict\';\n'
      + '// #H13 smoke channel handler — echoes the captured :room param so the\n'
      + '// assertion proves param capture as well as the frame round-trip.\n'
      + 'module.exports = function(session, request) {\n'
      + '    session.onMessage(function(data) {\n'
      + '        session.send(\'[\' + (request.params && request.params.room) + \'] \' + data);\n'
      + '    });\n'
      + '};\n';
    return files;
}

/**
 * The `routing.json` rule MERGED into the bundle (never clobbering the scaffold's).
 *
 * @returns {object} Rule name -> rule.
 * @example
 *  var r = wsRoutingRule(); // { 'ws-echo': { url: '/live/:room', method: 'ws', ... } }
 */
function wsRoutingRule() {
    var rule = {};
    rule[WS_RULE] = {
        url    : '/live/:' + 'room',
        method : 'ws',
        param  : { wsHandler: WS_HANDLER }
    };
    return rule;
}

/**
 * Reads a scaffolded bundle CONFIG json, tolerating the full-line `//` comments the
 * boilerplate ships (plain `JSON.parse` throws on them).
 *
 * @param   {string} file Absolute path.
 * @returns {object}
 */
function readConfigJSON(file) {
    return JSON.parse(
        fs.readFileSync(file, 'utf8').split('\n')
          .filter(function (line) { return !/^\s*\/\//.test(line); }).join('\n')
    );
}

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** @inner */
function gina(args) {
    return IS_BUN
        ? cp.spawnSync('bun', [GINA_ENTRY].concat(args), { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 180000 })
        : cp.spawnSync('gina', args, { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 180000 });
}

/** @inner */
function isTcpPortOpen(port) {
    return new Promise(function (resolve) {
        var s = net.connect({ host: '127.0.0.1', port: port });
        var settled = false;
        function done(v) { if (!settled) { settled = true; try { s.destroy(); } catch (e) {} resolve(v); } }
        s.on('connect', function () { done(true); });
        s.on('error', function () { done(false); });
        setTimeout(function () { done(false); }, 800);
    });
}

/** @inner */
async function waitForPort(port, timeoutMs) {
    var started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await isTcpPortOpen(port)) { return true; }
        await new Promise(function (r) { setTimeout(r, 300); });
    }
    return false;
}

module.exports = {
    expectedAdvertise : expectedAdvertise,
    wsFixtureFiles    : wsFixtureFiles,
    wsRoutingRule     : wsRoutingRule
};

// The pure builders above are unit-tested without a container; the smoke itself
// runs only when this file is the entry point (measured true under BOTH node and
// bun when run directly, false under `node --test`).
if (require.main === module) { main(); }

/** @inner */
async function main() {
    log(RUNTIME_LABEL + ' — #H13 ws-over-HTTP/2 runtime gate');
    fs.mkdirSync(PROJECT_DIR, { recursive: true });

    var inst = IS_BUN
        ? cp.spawnSync('bun', ['add', '-g', TARBALL], { stdio: 'inherit', timeout: 600000 })
        : cp.spawnSync('npm', ['install', '-g', TARBALL, '--dangerously-allow-all-scripts'], { stdio: 'inherit', timeout: 600000 });
    if (inst.error)       { return die(1, 'could not run the installer: ' + inst.error.message); }
    if (inst.status !== 0) { return die(1, 'global install exited ' + inst.status); }
    ok('installed');

    gina(['version']);
    gina(['project:add', '@' + PROJECT, '--path=' + PROJECT_DIR]);
    var projectsPath = path.join(GINA_HOME, 'projects.json');
    if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJECT]) {
        return die(2, 'project:add did not register @' + PROJECT);
    }
    gina(['bundle:add', BUNDLE, '@' + PROJECT, '--start-port-from=' + PORT_FROM]);
    var bundleDir = path.join(PROJECT_DIR, 'src', BUNDLE);
    if (!fs.existsSync(path.join(bundleDir, 'index.js'))) { return die(3, 'bundle:add did not scaffold ' + BUNDLE); }
    ok('project + bundle scaffolded');

    // http/2.0 + https + the extended-CONNECT opt-in. Spliced as a STRING so the
    // boilerplate's `//` comments survive (a JSON round-trip would strip them).
    var settingsPath = path.join(bundleDir, 'config', 'settings.server.json');
    var settingsSrc  = fs.readFileSync(settingsPath, 'utf8');
    var anchor       = settingsSrc.match(/"webroot"\s*:\s*"[^"]*"/);
    if (!anchor) { return die(4, 'no "webroot" anchor in ' + settingsPath); }
    settingsSrc = settingsSrc.replace(anchor[0], anchor[0]
        + ',\n    "protocol": "http/2.0",\n    "scheme": "https"'
        + ',\n    "http2Options": { "enableConnectProtocol": true }');
    fs.writeFileSync(settingsPath, settingsSrc);

    // isaac's https path reads a cert TRIPLE from the gina home. Generated host-side
    // and mounted: only oven/bun:1.4.2 ships openssl among the smoke images.
    var certTarget = path.join(GINA_HOME, 'certificates', 'scopes', 'local', 'localhost');
    if (!fs.existsSync(path.join(CERT_DIR, 'private.key')) || !fs.existsSync(path.join(CERT_DIR, 'certificate.crt'))) {
        return die(5, 'cert material missing at ' + CERT_DIR + ' — mount a host-generated private.key + certificate.crt');
    }
    fs.mkdirSync(certTarget, { recursive: true });
    fs.copyFileSync(path.join(CERT_DIR, 'private.key'),     path.join(certTarget, 'private.key'));
    fs.copyFileSync(path.join(CERT_DIR, 'certificate.crt'), path.join(certTarget, 'certificate.crt'));
    fs.copyFileSync(path.join(CERT_DIR, 'certificate.crt'), path.join(certTarget, 'ca_bundle.crt'));
    ok('h2/https + enableConnectProtocol configured; cert triple in place');

    var routingPath = path.join(bundleDir, 'config', 'routing.json');
    var routing     = readConfigJSON(routingPath);
    var rule        = wsRoutingRule();
    Object.keys(rule).forEach(function (rn) { routing[rn] = rule[rn]; });
    fs.writeFileSync(routingPath, JSON.stringify(routing, null, 2) + '\n');
    var fixture = wsFixtureFiles();
    Object.keys(fixture).forEach(function (rel) {
        var target = path.join(bundleDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, fixture[rel]);
    });
    ok('ws route + channel handler written');

    var key = BUNDLE + '@' + PROJECT;
    var portsReverse = readJSON(path.join(GINA_HOME, 'ports.reverse.json'));
    var port = null;
    try { port = portsReverse[key].dev['http/2.0'].https; } catch (e) { port = null; }
    if (!port) {
        return die(6, 'no dev http/2.0 https port for ' + key + ' — got ' + JSON.stringify(portsReverse[key]));
    }

    // A ws route registers at the WEBROOT-PREFIXED path: config load prefixes route
    // urls with the bundle's webroot, so `/live/:room` in bundle `ws` is reachable at
    // `/ws/live/room1`. Derived, never hardcoded.
    var webroot = ((settingsSrc.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE)).replace(/\/+$/, '');
    var wsPath  = webroot + '/live/' + WS_ROOM;

    child = IS_BUN
        ? cp.spawn('bun', [GINA_CONTAINER, BUNDLE, '@' + PROJECT], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
        : cp.spawn('gina-container', [BUNDLE, '@' + PROJECT], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    var bootLog = '';
    child.stdout.on('data', function (d) { bootLog += d; });
    child.stderr.on('data', function (d) { bootLog += d; });
    child.on('exit', function (c, s) { bootLog += '\n<<bundle exited code=' + c + ' signal=' + s + '>>'; });

    if (!await waitForPort(port, BOOT_TIMEOUT_MS)) {
        process.stdout.write(bootLog.slice(-3000) + '\n');
        return die(7, BUNDLE + ' never bound https port ' + port + ' within ' + BOOT_TIMEOUT_MS + ' ms');
    }
    ok('bundle bound https/h2 on ' + port);

    var ginaRoot = IS_BUN ? BUN_GINA_DIR : path.join(cp.execSync('npm root -g', { encoding: 'utf8' }).trim(), 'gina');
    var frameworkDir = fs.readdirSync(path.join(ginaRoot, 'framework')).filter(function (d) { return /^v/.test(d); })[0];
    var wsf = require(path.join(ginaRoot, 'framework', frameworkDir, 'lib', 'ws-framing', 'src', 'main.js'));

    var client = http2.connect('https://127.0.0.1:' + port, { rejectUnauthorized: false });
    var advertised = await new Promise(function (resolve) {
        var settled = false;
        setTimeout(function () { if (!settled) { settled = true; resolve(null); } }, 25000);
        client.on('error', function (e) { if (!settled) { settled = true; resolve('ERROR ' + e.message); } });
        client.on('remoteSettings', function (st) { if (!settled) { settled = true; resolve(st.enableConnectProtocol); } });
    });

    // GATE 1 — two-sided: the advertisement must MATCH this runtime's expectation.
    var expected = expectedAdvertise();
    log('extended CONNECT advertised = ' + advertised + ' (expected ' + expected + ' for ' + RUNTIME_LABEL + ')');
    if (advertised !== expected) {
        try { client.close(); } catch (e) {}
        process.stdout.write(bootLog.slice(-2000) + '\n');
        return die(8, 'advertisement ' + JSON.stringify(advertised) + ' != expected ' + JSON.stringify(expected) +
                      ' — a capable runtime regressed, or an incapable one changed.');
    }
    ok('gate 1/3 advertisement matches expectation for this runtime');

    if (!expected) {
        // Bun < 1.4 cannot carry a websocket stream; the expectation above IS the
        // assertion for this runtime. Nothing is skipped silently.
        try { client.close(); } catch (e) {}
        ok('runtime predates extended CONNECT — advertisement correctly absent; no round-trip to drive');
        log('RESULT: ws-over-h2 gate PASSED (capability-absent arm) on ' + RUNTIME_LABEL);
        teardown();
        return process.exit(0);
    }

    var result = await new Promise(function (resolve) {
        var settled = false;
        function finish(v) { if (!settled) { settled = true; resolve(v); } }
        setTimeout(function () { finish({ step: 'timeout' }); }, 20000);
        var req;
        try {
            req = client.request({
                ':method': 'CONNECT', ':protocol': 'websocket', ':scheme': 'https',
                ':path': wsPath, ':authority': '127.0.0.1:' + port
            }, { endStream: false });
        } catch (e) { return finish({ step: 'request', detail: e.message }); }
        req.on('error', function (e) { finish({ step: 'stream', detail: e.message }); });
        req.on('response', function (headers) {
            if (Number(headers[':status']) !== 200) { return finish({ step: 'status', detail: headers[':status'] }); }
            var parser = wsf.createParser({
                isServer  : false,
                onMessage : function (d) { finish({ step: 'done', echo: Buffer.isBuffer(d) ? d.toString('utf8') : String(d) }); },
                onError   : function (e) { finish({ step: 'parse', detail: e.message }); }
            });
            req.on('data', function (chunk) {
                try { parser.feed(chunk); } catch (e) { finish({ step: 'feed', detail: e.message }); }
            });
            req.write(wsf.encodeText('hello', { mask: true }));
        });
    });
    try { client.close(); } catch (e) {}

    if (result.step === 'status') {
        process.stdout.write(bootLog.slice(-2000) + '\n');
        return die(9, 'extended CONNECT to ' + wsPath + ' returned :status ' + result.detail +
                      ' — 404 means the route registered but the path is wrong; 501 means no dispatcher installed.');
    }
    if (result.step !== 'done') {
        process.stdout.write(bootLog.slice(-2000) + '\n');
        return die(10, 'gate "' + result.step + '"' + (result.detail ? ': ' + result.detail : ''));
    }
    ok('gate 2/3 extended CONNECT accepted (:status 200) at ' + wsPath);

    var want = '[' + WS_ROOM + '] hello';
    if (result.echo !== want) {
        return die(11, 'round-trip mismatch — got ' + JSON.stringify(result.echo) + ', expected ' + JSON.stringify(want));
    }
    ok('gate 3/3 RFC 6455 round-trip + :param capture — ' + JSON.stringify(result.echo));
    log('RESULT: ws-over-h2 WORKS END-TO-END on ' + RUNTIME_LABEL);
    teardown();
    process.exit(0);
}
