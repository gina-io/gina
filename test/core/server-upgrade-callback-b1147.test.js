'use strict';
/**
 * #B1147 — on Node.js 22.21.0, an http2 secure server with `allowHTTP1` has no
 * `shouldUpgradeCallback`, yet that release's HTTP layer calls it for every
 * HTTP/1.1 request carrying upgrade headers: such a request threw
 * `TypeError: server.shouldUpgradeCallback is not a function` inside Node's
 * parser (nodejs/node#60336, fixed in Node.js 22.21.1). At listen(), gina now
 * assigns Node.js 22.21.1's own default where the property is missing
 * (`ensureUpgradeCallback`), before the agent's attach, whose wrapper then
 * installs as on every other release.
 *
 * The arms emulate 22.21.0 on the running release by deleting the property from
 * a fresh http2 secure server (`allowHTTP1`). The CONTROL arm runs such a server
 * in a child process, without gina's steps, and reads the throw there: it shows
 * the emulation reproduces 22.21.0 on this runtime. The emulated arms run where
 * this runtime's HTTP layer calls the callback (a fresh `https` server has one);
 * elsewhere there is nothing to emulate and they are skipped. On Bun,
 * `ensureUpgradeCallback` assigns nothing.
 *
 * `ensureUpgradeCallback` and `attachInspectorAgentWs` are compiled from
 * core/server.js's real bytes with every identifier they read handed in (a
 * `new Function` captures no closure), and run on a real http2 secure server on
 * loopback in the order server.js runs them at listen(). The server uses a
 * throwaway certificate made with `openssl`; without `openssl` the TLS arms are
 * skipped.
 *
 * Seam: GINA_SERVER_SRC=<absolute file> reads both functions and the listen()
 * statements from that text (red-first against the previous bytes). Where that
 * text has no `ensureUpgradeCallback`, the emulated arms run the agent's attach
 * alone, as the previous bytes did.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var https = require('https');
var http2 = require('http2');
var tls = require('tls');
var Module = require('module');
var execFileSync = require('child_process').execFileSync;
var spawnSync = require('child_process').spawnSync;

var FW = require('../fw');
var strip = require('../strip-comments');
var SERVER_SOURCE = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');
var SERVER_SRC = fs.readFileSync(SERVER_SOURCE, 'utf8');
var serverRequire = Module.createRequire(path.join(FW, 'core/server.js'));
var WS = serverRequire('ws');
var HELPER_FN = 'function ensureUpgradeCallback(rawServer) {';
var AGENT_FN = 'function attachInspectorAgentWs(rawServer, ctx) {';
var CALL = 'ensureUpgradeCallback(process.server);';
var quiet = { debug: function() {}, info: function() {}, warn: function() {}, log: function() {}, error: function() {} };
var IS_BUN = !!(process.versions && process.versions.bun);
// Whether this runtime's HTTP layer calls shouldUpgradeCallback: a fresh `https` server has one where it does.
var HTTP_CALLS_IT = typeof https.createServer().shouldUpgradeCallback === 'function';
var SKIP_EMULATED = IS_BUN
    ? 'Bun: its http2 fallback does not call a missing callback, so there is nothing to emulate'
    : (HTTP_CALLS_IT ? false : 'this runtime\'s HTTP layer never calls shouldUpgradeCallback (a release before the callback existed)');

var TLS_DIR = null;
var TLS_OPTS = null;
var servers = [];

before(function() {
    // A throwaway certificate, made as test/core/server-agent-upgrade-unclaimed-b1141.test.js makes one.
    try {
        TLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1147-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(TLS_DIR, 'k.pem'), '-out', path.join(TLS_DIR, 'c.pem'),
            '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
        TLS_OPTS = { key: fs.readFileSync(path.join(TLS_DIR, 'k.pem')), cert: fs.readFileSync(path.join(TLS_DIR, 'c.pem')) };
    } catch (e) {
        TLS_OPTS = null;
    }
});

after(function() {
    servers.forEach(function(s) {
        s.conns.forEach(function(c) { try { c.destroy(); } catch (e) { /* gone */ } });
        try { s.server.close(); } catch (e) { /* gone */ }
    });
    if (TLS_DIR) { try { fs.rmSync(TLS_DIR, { recursive: true, force: true }); } catch (e) { /* gone */ } }
});

/**
 * A function of core/server.js, compiled from its real bytes.
 *
 * @param {string} header - the function's first line, as written
 * @param {string[]} names - the identifiers it reads from its module
 * @param {Array} values - their values, in the same order
 * @returns {function}
 */
function compile(header, names, values) {
    var a = SERVER_SRC.indexOf(header);
    assert.ok(a > -1 && SERVER_SRC.indexOf(header, a + 1) < 0, 'found once: ' + header);
    var b = SERVER_SRC.indexOf('\n}\n', a);
    assert.ok(b > a, 'closes: ' + header);
    var name = header.slice('function '.length, header.indexOf('('));
    return new Function(names.join(','), SERVER_SRC.slice(a, b + 2) + '\nreturn ' + name + ';').apply(null, values);
}

/**
 * `ensureUpgradeCallback`, compiled from core/server.js's real bytes (it reads only `process`).
 *
 * @returns {function} ensureUpgradeCallback(rawServer)
 */
function ensureCallback() {
    return compile(HELPER_FN, [], []);
}

/**
 * The agent's attach function, compiled from core/server.js's real bytes.
 *
 * @returns {function} attachInspectorAgentWs(rawServer, ctx)
 */
function agentAttach() {
    return compile(AGENT_FN, ['require', 'lib', '_agentKeyValid', 'console'], [serverRequire, {}, function() { return false; }, quiet]);
}

/**
 * The bundle's request handler: a plain answer that closes its connection.
 *
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
function plainAnswer(req, res) {
    res.writeHead(200, { 'content-type': 'text/plain', 'connection': 'close' });
    res.end('plain');
}

/**
 * An application's own WebSocket endpoint on `/chat`, as a bundle could add it.
 *
 * @param {object} server
 * @returns {void}
 */
function appWebSocket(server) {
    var wss = new WS.WebSocketServer({ noServer: true });
    server.on('upgrade', function(req, socket, head) {
        if (req.url !== '/chat') { return; }
        wss.handleUpgrade(req, socket, head, function(ws) { ws.on('error', function() { /* closed by the test */ }); });
    });
}

/**
 * Starts an http2 secure server (`allowHTTP1`) on loopback without
 * `shouldUpgradeCallback`, as on Node.js 22.21.0, and runs gina's listen() steps
 * on it: `ensureUpgradeCallback` (when the text under test has it), then the
 * agent's attach.
 *
 * @param {object} [opts]
 * @param {function} [opts.setup] - called with the server before gina's steps
 * @returns {Promise<{server: object, port: number, conns: Set, assigned: (boolean|null)}>}
 */
function boot(opts) {
    opts = opts || {};
    var server = http2.createSecureServer(Object.assign({ allowHTTP1: true }, TLS_OPTS), plainAnswer);
    delete server.shouldUpgradeCallback;
    assert.equal(typeof server.shouldUpgradeCallback, 'undefined', 'emulated: the server has no callback');
    var conns = new Set();
    server.on('connection', function(c) { conns.add(c); });
    if (opts.setup) { opts.setup(server); }
    var rec = { server: server, port: 0, conns: conns, assigned: null };
    servers.push(rec);
    return new Promise(function(resolve) {
        server.listen(0, '127.0.0.1', function() {
            rec.port = server.address().port;
            if (SERVER_SRC.indexOf(HELPER_FN) > -1) { rec.assigned = ensureCallback()(server); }
            agentAttach()(server, { instance: {}, appName: 'demo', env: 'prod' });
            resolve(rec);
        });
    });
}

/**
 * Sends one HTTP/1.1 request carrying Upgrade headers over TLS (ALPN `http/1.1`)
 * and watches its socket for `ms`. The watch ends early when the server closes
 * the socket.
 *
 * @param {number} port
 * @param {string} p - the request path
 * @param {number} ms - how long to watch
 * @returns {Promise<{firstLine: string, bytes: number, closedAt: (number|null), alpn: (string|boolean|null)}>}
 */
function upgrade(port, p, ms) {
    return new Promise(function(resolve) {
        var started = Date.now();
        var s = tls.connect({ host: '127.0.0.1', port: port, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
        var buf = '';
        var closedAt = null;
        var alpn = null;
        var finished = false;
        var t = setTimeout(finish, ms);
        function finish() {
            if (finished) { return; }
            finished = true;
            clearTimeout(t);
            try { s.destroy(); } catch (e) { /* gone */ }
            resolve({ firstLine: buf.split('\r\n')[0], bytes: buf.length, closedAt: closedAt, alpn: alpn });
        }
        s.on('secureConnect', function() {
            alpn = s.alpnProtocol;
            s.write('GET ' + p + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        });
        s.on('data', function(d) { buf += d.toString('latin1'); });
        s.on('close', function() {
            if (closedAt === null) { closedAt = Date.now() - started; }
            finish();
        });
        s.on('error', function() { /* the close follows */ });
    });
}

/**
 * Runs, in a child process, an http2 secure server (`allowHTTP1`) without
 * `shouldUpgradeCallback` and without gina's steps, sends it one HTTP/1.1
 * upgrade request, and returns what reached the child's process.
 *
 * @returns {{uncaught: (string|null), bytes: number}}
 */
function emulatedThrow() {
    var script = [
        "var http2 = require('http2'), tls = require('tls'), fs = require('fs');",
        "var out = { uncaught: null, bytes: 0 };",
        "process.on('uncaughtException', function(e) { if (!out.uncaught) { out.uncaught = (e && e.name) + ': ' + (e && e.message); } });",
        "var s = http2.createSecureServer({ allowHTTP1: true, key: fs.readFileSync(process.env.B1147_KEY), cert: fs.readFileSync(process.env.B1147_CERT) }, function(req, res) { res.end('plain'); });",
        "delete s.shouldUpgradeCallback;",
        "s.listen(0, '127.0.0.1', function() {",
        "  var buf = '';",
        "  var c = tls.connect({ host: '127.0.0.1', port: s.address().port, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false }, function() {",
        "    c.write('GET /foo HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');",
        "  });",
        "  c.on('data', function(d) { buf += d.toString('latin1'); });",
        "  c.on('error', function() {});",
        "  setTimeout(function() { out.bytes = buf.length; process.stdout.write(JSON.stringify(out) + '\\n'); process.exit(0); }, 1500);",
        "});"
    ].join('\n');
    var env = Object.assign({}, process.env, { B1147_KEY: path.join(TLS_DIR, 'k.pem'), B1147_CERT: path.join(TLS_DIR, 'c.pem') });
    delete env.NODE_TEST_CONTEXT;
    var r = spawnSync(process.execPath, ['-e', script], { env: env, encoding: 'utf8', timeout: 15000 });
    var line = String(r.stdout || '').trim().split('\n').pop();
    assert.ok(line, 'the child reported (status ' + r.status + ', stderr ' + String(r.stderr || '').slice(0, 300) + ')');
    return JSON.parse(line);
}

describe('#B1147 - on an http2 secure server without shouldUpgradeCallback, as on Node.js 22.21.0', function() {

    it('CONTROL: without gina\'s steps, an HTTP/1.1 upgrade request throws inside Node\'s parser (child process)', { skip: SKIP_EMULATED }, function(t) {
        if (!TLS_OPTS) { t.skip('no openssl for a throwaway certificate'); return; }
        var r = emulatedThrow();
        assert.match(String(r.uncaught), /shouldUpgradeCallback is not a function/, 'the emulation reproduces Node.js 22.21.0\'s throw');
        assert.equal(r.bytes, 0, 'no answer');
    });

    it('with gina\'s listen() steps, an upgrade on /foo is answered 200 by the request handler', { skip: SKIP_EMULATED }, async function(t) {
        if (!TLS_OPTS) { t.skip('no openssl for a throwaway certificate'); return; }
        var srv = await boot();
        var r = await upgrade(srv.port, '/foo', 2500);
        assert.equal(r.alpn, 'http/1.1', 'the HTTP/1.1 fallback answered the handshake');
        assert.equal(r.firstLine, 'HTTP/1.1 200 OK', 'a plain request (closedAt ' + r.closedAt + ')');
        assert.equal(srv.assigned, true, 'ensureUpgradeCallback assigned the default');
    });

    it('the agent\'s path still reaches the agent\'s listener: 404 outside dev', { skip: SKIP_EMULATED }, async function(t) {
        if (!TLS_OPTS) { t.skip('no openssl for a throwaway certificate'); return; }
        var wasDev = process.env.NODE_ENV_IS_DEV;
        process.env.NODE_ENV_IS_DEV = 'false';
        try {
            var srv = await boot();
            var r = await upgrade(srv.port, '/_gina/agent', 2500);
            assert.equal(r.firstLine, 'HTTP/1.1 404 Not Found');
        } finally {
            if (typeof wasDev === 'undefined') { delete process.env.NODE_ENV_IS_DEV; } else { process.env.NODE_ENV_IS_DEV = wasDev; }
        }
    });

    it('another upgrade listener is attached: its endpoint upgrades, and an upgrade on /foo is closed after about 1 s with no byte', { skip: SKIP_EMULATED }, async function(t) {
        if (!TLS_OPTS) { t.skip('no openssl for a throwaway certificate'); return; }
        var srv = await boot({ setup: appWebSocket });
        var chat = await upgrade(srv.port, '/chat', 1500);
        assert.equal(chat.firstLine, 'HTTP/1.1 101 Switching Protocols', 'the application\'s endpoint upgraded');
        var r = await upgrade(srv.port, '/foo', 2500);
        assert.equal(r.bytes, 0, 'no byte');
        assert.notEqual(r.closedAt, null, 'closed within 2.5 s');
        assert.ok(r.closedAt >= 900, 'closed after the 1 s delay, not at once (closedAt ' + r.closedAt + ')');
    });
});

describe('#B1147 - ensureUpgradeCallback leaves a callback already there as it is', function() {

    it('the runtime\'s own callback', { skip: SKIP_EMULATED }, function() {
        var s = http2.createSecureServer(Object.assign({ allowHTTP1: true }, TLS_OPTS || {}));
        var own = s.shouldUpgradeCallback;
        assert.equal(typeof own, 'function', 'this runtime gives the server one');
        assert.equal(ensureCallback()(s), false, 'nothing assigned');
        assert.equal(s.shouldUpgradeCallback, own, 'the same function');
    });

    it('an application\'s own callback', function() {
        var s = http2.createSecureServer(Object.assign({ allowHTTP1: true }, TLS_OPTS || {}));
        var own = function() { return false; };
        s.shouldUpgradeCallback = own;
        assert.equal(ensureCallback()(s), false, 'nothing assigned');
        assert.equal(s.shouldUpgradeCallback, own, 'the same function');
    });

    it('a value without the listener API is left alone', function() {
        var plain = {};
        assert.equal(ensureCallback()(null), false);
        assert.equal(ensureCallback()(plain), false);
        assert.equal(typeof plain.shouldUpgradeCallback, 'undefined');
    });
});

describe('#B1147 - on Bun, ensureUpgradeCallback assigns nothing', function() {

    it('an http2 secure server keeps what it had (Bun only)', { skip: IS_BUN ? false : 'Node.js: this arm is Bun\'s' }, function() {
        var s = http2.createSecureServer(Object.assign({ allowHTTP1: true }, TLS_OPTS || {}));
        var had = s.shouldUpgradeCallback;
        assert.equal(ensureCallback()(s), false, 'nothing assigned');
        assert.equal(s.shouldUpgradeCallback, had, 'unchanged');
    });
});

describe('#B1147 - server.js runs ensureUpgradeCallback at listen(), right before the agent\'s attach', function() {

    it('the call order in the live code', function() {
        var code = strip.all(SERVER_SRC);
        var iWatch = code.indexOf('watchBindOutcome(process.server, ');
        var iCall = code.indexOf(CALL);
        var iAttach = code.indexOf('attachInspectorAgentWs(process.server, self);');
        assert.ok(iWatch > -1 && iCall > iWatch && iAttach > iCall, 'watch ' + iWatch + ' < call ' + iCall + ' < attach ' + iAttach);
        assert.equal(code.indexOf(CALL, iCall + 1), -1, 'called once in the live code');
        var raw = SERVER_SRC.split(CALL).length - 1;
        assert.ok(raw >= 2, 'CONTROL: the raw text also holds the JSDoc example, which the strip removes (' + raw + ')');
    });
});
