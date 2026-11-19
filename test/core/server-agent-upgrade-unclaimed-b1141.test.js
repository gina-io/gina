'use strict';
/**
 * #B1141 — an upgrade request on a path that no listener takes is answered or
 * closed.
 *
 * The Inspector agent's upgrade listener (`/_gina/agent`) is attached to every
 * bundle's server at listen(), and once an `upgrade` listener exists Node.js
 * accepts every upgrade request. An upgrade on any other path that no listener
 * takes is now served as a plain request where the server has
 * `shouldUpgradeCallback` (Node.js 22.21 and later, 24.9 and later) and gina's
 * listeners are the server's only upgrade listeners. Otherwise it is closed
 * after 1 s: always when gina's listeners are the only ones, and with another
 * listener attached when nothing has been written on it, the rule and delay
 * engine.io applies to an upgrade it does not own. On Bun a socket reads
 * `bytesWritten` 0 after another listener has answered on it, so there, with
 * another listener attached, the socket is left to that listener: the arms
 * that attach one expect the close on Node.js and the socket kept on Bun.
 * Before, it was left open.
 *
 * `attachInspectorAgentWs` is compiled from core/server.js's real bytes with
 * every identifier it reads handed in (a `new Function` captures no closure),
 * and attached to real `http`, `https` and `http2` secure (`allowHTTP1`)
 * servers on loopback. The TLS servers use a throwaway certificate made with
 * `openssl`; without `openssl` their arms are skipped. An arm whose outcome
 * depends on `shouldUpgradeCallback` reads whether a fresh server of that kind
 * has the property on this runtime and expects the plain answer where it has
 * it, the close after 1 s where it has not; no arm is skipped for it.
 *
 * Seam: GINA_SERVER_SRC=<absolute file> reads the function from that text
 * (red-first against the previous bytes); modules always resolve from this
 * tree's core/, as they do in production.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var https = require('https');
var http2 = require('http2');
var net = require('net');
var tls = require('tls');
var Module = require('module');
var execFileSync = require('child_process').execFileSync;

var FW = require('../fw');
var SERVER_SOURCE = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');
var SERVER_SRC = fs.readFileSync(SERVER_SOURCE, 'utf8');
var serverRequire = Module.createRequire(path.join(FW, 'core/server.js'));
var WS = serverRequire('ws');
var AGENT_FN = 'function attachInspectorAgentWs(rawServer, ctx) {';
var quiet = { debug: function() {}, info: function() {}, warn: function() {}, log: function() {}, error: function() {} };
var UPGRADE_101 = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n';
// The runtime the arms that attach another upgrade listener branch on (the same key as utils/runtime).
var IS_BUN = !!(process.versions && process.versions.bun);

var TLS_OPTS = null;
var servers = [];

before(function() {
    // A throwaway certificate for the TLS servers, made as test/core/query-h1-agent-reuse.test.js makes one.
    try {
        var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1141-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
            '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
        TLS_OPTS = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
        TLS_OPTS = null;
    }
});

after(function() {
    servers.forEach(function(s) {
        s.conns.forEach(function(c) { try { c.destroy(); } catch (e) { /* gone */ } });
        try { s.server.close(); } catch (e) { /* gone */ }
    });
});

/**
 * The agent's attach function, compiled from core/server.js's real bytes.
 *
 * @returns {function} attachInspectorAgentWs(rawServer, ctx)
 */
function agentAttach() {
    var a = SERVER_SRC.indexOf(AGENT_FN);
    assert.ok(a > -1 && SERVER_SRC.indexOf(AGENT_FN, a + 1) < 0, 'the agent attach function is found once');
    var b = SERVER_SRC.indexOf('\n}\n', a);
    assert.ok(b > a, 'the agent attach function closes');
    return new Function('require', 'lib', '_agentKeyValid', 'console', SERVER_SRC.slice(a, b + 2) + '\nreturn attachInspectorAgentWs;')(
        serverRequire, {}, function() { return false; }, quiet);
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
 * A server of one kind, created but not started.
 *
 * @param {string} kind - 'http', 'https' or 'h2s' (http2 secure with allowHTTP1)
 * @returns {object|null} the server, or null when a TLS kind has no certificate
 */
function createServer(kind) {
    if (kind === 'http') { return http.createServer(plainAnswer); }
    if (!TLS_OPTS) { return null; }
    if (kind === 'https') { return https.createServer(TLS_OPTS, plainAnswer); }
    return http2.createSecureServer(Object.assign({ allowHTTP1: true }, TLS_OPTS), plainAnswer);
}

/**
 * Whether a server of this kind has `shouldUpgradeCallback` on this runtime,
 * read on a fresh server before anything assigns it.
 *
 * @param {string} kind
 * @returns {boolean}
 */
function hasUpgradeCallback(kind) {
    var s = createServer(kind);
    return !!s && typeof s.shouldUpgradeCallback === 'function';
}

/**
 * Starts a server on loopback with the agent's listener attached, as server.js
 * attaches it at listen().
 *
 * @param {string} kind - 'http', 'https' or 'h2s'
 * @param {object} [opts]
 * @param {boolean} [opts.agent=true] - attach the agent's listener
 * @param {function} [opts.setup] - called with the server before the agent's listener is attached
 * @returns {Promise<{server: object, port: number, conns: Set}>}
 */
function boot(kind, opts) {
    opts = opts || {};
    var server = createServer(kind);
    var conns = new Set();
    server.on('connection', function(c) { conns.add(c); });
    if (opts.setup) { opts.setup(server); }
    var rec = { server: server, port: 0, conns: conns };
    servers.push(rec);
    return new Promise(function(resolve) {
        server.listen(0, '127.0.0.1', function() {
            rec.port = server.address().port;
            if (opts.agent !== false) { agentAttach()(server, { instance: {}, appName: 'demo', env: 'prod' }); }
            resolve(rec);
        });
    });
}

/**
 * Sends one HTTP/1.1 request carrying Upgrade headers and watches its socket
 * for `ms`. The watch ends early when the server closes the socket.
 *
 * @param {string} kind - 'http' (plain socket) or a TLS kind
 * @param {number} port
 * @param {string} p - the request path
 * @param {number} ms - how long to watch
 * @param {string} [protocol='websocket'] - 'websocket' or 'h2c'
 * @returns {Promise<{firstLine: string, bytes: number, closedAt: (number|null)}>} the first response line,
 *   the number of bytes received, and when the server closed the socket (ms from the start; null if open)
 */
function upgrade(kind, port, p, ms, protocol) {
    return new Promise(function(resolve) {
        var started = Date.now();
        var s = (kind === 'http')
            ? net.connect(port, '127.0.0.1')
            : tls.connect({ host: '127.0.0.1', port: port, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
        var buf = '';
        var closedAt = null;
        var finished = false;
        var t = setTimeout(finish, ms);
        function finish() {
            if (finished) { return; }
            finished = true;
            clearTimeout(t);
            try { s.destroy(); } catch (e) { /* gone */ }
            resolve({ firstLine: buf.split('\r\n')[0], bytes: buf.length, closedAt: closedAt });
        }
        s.on(kind === 'http' ? 'connect' : 'secureConnect', function() {
            var head = (protocol === 'h2c')
                ? 'Upgrade: h2c\r\nConnection: Upgrade, HTTP2-Settings\r\nHTTP2-Settings: AAMAAABkAAQAAP__\r\n'
                : 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n';
            s.write('GET ' + p + ' HTTP/1.1\r\nHost: 127.0.0.1\r\n' + head + '\r\n');
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
 * Skips the test when a TLS kind has no certificate.
 *
 * @param {object} t - the test context
 * @param {string} kind
 * @returns {boolean} true when the test was skipped
 */
function skipWithoutTls(t, kind) {
    if (kind !== 'http' && !TLS_OPTS) { t.skip('no openssl for a throwaway certificate'); return true; }
    return false;
}

describe('#B1141 - the harness', function() {

    it('CONTROL: without any upgrade listener, an upgrade request is served as a plain request', async function() {
        var srv = await boot('http', { agent: false });
        var r = await upgrade('http', srv.port, '/foo', 1500);
        assert.equal(r.firstLine, 'HTTP/1.1 200 OK');
    });

    it('INSTRUMENT: a socket the server destroys is seen closed, with no byte', async function() {
        var srv = await boot('http', { agent: false, setup: function(s) { s.on('upgrade', function(req, socket) { socket.destroy(); }); } });
        var r = await upgrade('http', srv.port, '/foo', 1500);
        assert.equal(r.bytes, 0);
        assert.notEqual(r.closedAt, null, 'closed');
    });

    it('INSTRUMENT: a socket nobody answers or closes is seen open, with no byte', async function() {
        var srv = await boot('http', { agent: false, setup: function(s) { s.on('upgrade', function() { /* takes nothing */ }); } });
        var r = await upgrade('http', srv.port, '/foo', 1600);
        assert.equal(r.bytes, 0);
        assert.equal(r.closedAt, null, 'still open');
    });

    it('CONTROL: the agent\'s listener, from its real bytes, still answers /_gina/agent with its gate (404 outside dev, agent not enabled)', async function() {
        var srv = await boot('http');
        var r = await upgrade('http', srv.port, '/_gina/agent', 1500);
        assert.equal(r.firstLine, 'HTTP/1.1 404 Not Found');
    });
});

/**
 * Asserts the outcome of an upgrade that gina's listeners alone cannot take:
 * the request handler's plain answer where the server has
 * `shouldUpgradeCallback`, a close after about 1 s with no byte where it has not.
 *
 * @param {{firstLine: string, bytes: number, closedAt: (number|null)}} r
 * @param {boolean} withCallback
 * @returns {void}
 */
function assertAnsweredOrClosed(r, withCallback) {
    if (withCallback) {
        assert.equal(r.firstLine, 'HTTP/1.1 200 OK', 'a plain request (closedAt ' + r.closedAt + ')');
        return;
    }
    assert.equal(r.bytes, 0, 'no byte');
    assert.notEqual(r.closedAt, null, 'closed within the watch');
    assert.ok(r.closedAt >= 900, 'closed after the 1 s delay, not at once (closedAt ' + r.closedAt + ')');
}

describe('#B1141 - with only gina\'s listeners, an upgrade on another path is a plain request, or is closed after 1 s', function() {

    ['http', 'https', 'h2s'].forEach(function(kind) {
        it('an upgrade on /foo is answered 200 by the request handler where the server has shouldUpgradeCallback, closed after about 1 s where it has not (' + kind + ')', async function(t) {
            if (skipWithoutTls(t, kind)) { return; }
            var withCallback = hasUpgradeCallback(kind);
            var srv = await boot(kind);
            var r = await upgrade(kind, srv.port, '/foo', 2500);
            assertAnsweredOrClosed(r, withCallback);
        });
    });

    it('an Upgrade: h2c request is handled the same way (http)', async function() {
        var withCallback = hasUpgradeCallback('http');
        var srv = await boot('http');
        var r = await upgrade('http', srv.port, '/foo', 2500, 'h2c');
        assertAnsweredOrClosed(r, withCallback);
    });
});

describe('#B1141 - another upgrade listener is attached and takes nothing: the upgrade is closed after 1 s on Node.js, left to that listener on Bun', function() {

    ['http', 'h2s'].forEach(function(kind) {
        it('an upgrade on /foo is closed after about 1 s with no byte on Node.js, and kept open on Bun (' + kind + ')', async function(t) {
            if (skipWithoutTls(t, kind)) { return; }
            var srv = await boot(kind, { setup: appWebSocket });
            var r = await upgrade(kind, srv.port, '/foo', 2500);
            assert.equal(r.bytes, 0);
            if (IS_BUN) {
                assert.equal(r.closedAt, null, 'left to the other listener: still open at 2.5 s');
                return;
            }
            assert.notEqual(r.closedAt, null, 'closed within 2.5 s');
            assert.ok(r.closedAt >= 900, 'closed after the 1 s delay, not at once (closedAt ' + r.closedAt + ')');
        });
    });

    it('CONTROL: an application\'s own WebSocket endpoint still upgrades, and its socket stays open past 1 s', async function() {
        var srv = await boot('http', { setup: appWebSocket });
        var r = await upgrade('http', srv.port, '/chat', 1600);
        assert.equal(r.firstLine, 'HTTP/1.1 101 Switching Protocols');
        assert.equal(r.closedAt, null, 'still open');
    });

    it('a listener that writes nothing for 1 s loses the socket on Node.js (the stated limit); on Bun the socket is left to it and its late answer arrives', async function() {
        var srv = await boot('http', { setup: function(s) {
            s.on('upgrade', function(req, socket) {
                if (req.url !== '/slow') { return; }
                socket.on('error', function() { /* destroyed first */ });
                setTimeout(function() { try { socket.write(UPGRADE_101); } catch (e) { /* destroyed */ } }, 1500);
            });
        } });
        var r = await upgrade('http', srv.port, '/slow', 2500);
        if (IS_BUN) {
            assert.equal(r.firstLine, 'HTTP/1.1 101 Switching Protocols', 'the late answer reached the client');
            assert.equal(r.closedAt, null, 'still open at 2.5 s');
            return;
        }
        assert.equal(r.bytes, 0, 'the late answer never reached the client');
        assert.notEqual(r.closedAt, null, 'closed');
        assert.ok(r.closedAt >= 900, 'closed after the 1 s delay, not at once (closedAt ' + r.closedAt + ')');
    });

    it('an application\'s own shouldUpgradeCallback still decides when another upgrade listener is attached', async function() {
        var withCallback = hasUpgradeCallback('http');
        var srv = await boot('http', { setup: function(s) {
            s.shouldUpgradeCallback = function(req) { return req.url !== '/plain'; };
            appWebSocket(s);
        } });
        var plain = await upgrade('http', srv.port, '/plain', 2500);
        // Where the runtime has no such callback, the assignment does nothing:
        // the upgrade reaches the listeners, nobody takes it, and it is closed after 1 s.
        assertAnsweredOrClosed(plain, withCallback);
        var chat = await upgrade('http', srv.port, '/chat', 1500);
        assert.equal(chat.firstLine, 'HTTP/1.1 101 Switching Protocols', 'the application\'s endpoint upgraded');
    });
});
