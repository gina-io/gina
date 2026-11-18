'use strict';
/**
 * #B1140 — Isaac's engine.io upgrade listener never hands engine.io an upgrade
 * it cannot take.
 *
 * In the `ioServer` attach block, `Eio.attach()` installs engine.io's own
 * upgrade listener for its path (`/engine.io/` unless `ioServer.path` says
 * otherwise) while the websocket transport is enabled. Isaac's listener serves
 * every other path but `/_gina/agent` (a bundle's push path, for instance). It
 * now skips engine.io's own path (handing engine.io the same socket twice
 * threw), skips when engine.io has no WebSocket server, and destroys the socket
 * if handleUpgrade throws, so no throw inside it can stop the bundle.
 *
 * The attach statements are sliced from the real core/server.isaac.js bytes
 * (from `delete options.ioServer.integrationMode;` to `server.eio = ioServer;`)
 * and run with the REAL engine.io against a real http.Server; Isaac's upgrade
 * region (the `_eioOwn…` declarations when present, then every ACTIVE
 * `server.on('upgrade'` statement, comment lines skipped) is installed from its
 * real bytes, after the attach, as Isaac registers it. The server's upgrade
 * dispatch is wrapped, so a listener's synchronous throw is recorded instead of
 * ending the run.
 *
 * The Inspector agent's upgrade listener (`/_gina/agent`) is installed from
 * core/server.js's real bytes (the whole `attachInspectorAgentWs` function) for
 * the arms that need it, after Isaac's, as server.js attaches it at listen().
 *
 * Seams: GINA_ISAAC_SRC=<absolute file> and GINA_SERVER_SRC=<absolute file>
 * read the statements from that text (red-first against the previous bytes);
 * modules always resolve from this tree's core/, as they do in production.
 */
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var http = require('http');
var net = require('net');
var Module = require('module');

var FW = require('../fw');
var SOURCE = process.env.GINA_ISAAC_SRC || path.join(FW, 'core/server.isaac.js');
var SRC = fs.readFileSync(SOURCE, 'utf8');
var isaacRequire = Module.createRequire(path.join(FW, 'core/server.isaac.js'));
var Eio = isaacRequire('engine.io');
var WS = require('ws');
var SERVER_SOURCE = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');
var SERVER_SRC = fs.readFileSync(SERVER_SOURCE, 'utf8');
var serverRequire = Module.createRequire(path.join(FW, 'core/server.js'));
var AGENT_FN = 'function attachInspectorAgentWs(rawServer, ctx) {';

var ATTACH_START = 'delete options.ioServer.integrationMode;';
var ATTACH_END = 'server.eio = ioServer;';
var UPGRADE = "server.on('upgrade'";
var DECL = 'var _eioOwnPath';
var quiet = { debug: function() {}, info: function() {}, warn: function() {}, log: function() {}, error: function() {} };

/** @returns {boolean} whether the line holding `index` is a comment line */
function onCommentLine(text, index) {
    var lineStart = text.lastIndexOf('\n', index) + 1;
    return /^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, index + 1));
}

/** @returns {string|null} the attach statements, or null when a needle is missing or repeated */
function attachSlice() {
    var a = SRC.indexOf(ATTACH_START);
    if (a < 0 || SRC.indexOf(ATTACH_START, a + 1) > -1) { return null; }
    var b = SRC.indexOf(ATTACH_END, a);
    if (b < 0 || SRC.indexOf(ATTACH_END, b + 1) > -1) { return null; }
    return SRC.slice(a, b + ATTACH_END.length);
}

/**
 * Isaac's upgrade region: for every ACTIVE `server.on('upgrade', …);`
 * statement, the statement itself, preceded by the `_eioOwn…` declarations it
 * reads when the file has them (after the attach statements).
 *
 * @returns {string[]}
 */
function upgradeRegions() {
    var out = [];
    var attachEnd = SRC.indexOf(ATTACH_END);
    for (var i = SRC.indexOf(UPGRADE); i > -1; i = SRC.indexOf(UPGRADE, i + 1)) {
        if (onCommentLine(SRC, i)) { continue; }
        var end = SRC.indexOf('\n        });', i);
        assert.ok(end > i, 'an active upgrade statement must close');
        var start = SRC.lastIndexOf(DECL, i);
        if (start < 0 || start < attachEnd) { start = i; }
        out.push(SRC.slice(start, end) + '\n        });');
    }
    return out;
}

/** The active listener statement alone, comment lines dropped. */
function activeListenerCode() {
    var regions = upgradeRegions();
    assert.equal(regions.length, 1, 'one active upgrade listener');
    var region = regions[0];
    return region.slice(region.indexOf(UPGRADE)).split('\n').filter(function(line) { return !/^\s*(\/\/|\*|\/\*)/.test(line); }).join('\n');
}

/**
 * The Inspector agent's attach function, compiled from core/server.js's real
 * bytes with every identifier it reads handed in (a `new Function` captures no
 * closure).
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

var servers = [];
after(function() {
    servers.forEach(function(s) {
        s.conns.forEach(function(c) { try { c.destroy(); } catch (e) { /* gone */ } });
        try { s.ioServer && s.ioServer.close(); } catch (e) { /* gone */ }
        try { s.server.close(); } catch (e) { /* gone */ }
    });
});

/**
 * A server set up as Isaac sets it up: the real attach statements with the
 * real engine.io, then Isaac's upgrade region.
 *
 * @param {object} ioServerOpts - the bundle's `ioServer` block
 * @param {function} [extraListener] - an upgrade listener installed instead of Isaac's (instrument arm)
 * @returns {Promise<{server: object, ioServer: object, port: number, thrown: Error[], conns: Set}>}
 */
function boot(ioServerOpts, extraListener) {
    var body = attachSlice();
    assert.ok(body, 'the attach statements are found once, between the two needles');
    var server = http.createServer(function(req, res) { res.end('app'); });
    var thrown = [];
    var emit = server.emit;
    server.emit = function(event) {
        if (event === 'upgrade') {
            try { return emit.apply(this, arguments); } catch (err) { thrown.push(err); return true; }
        }
        return emit.apply(this, arguments);
    };
    var conns = new Set();
    server.on('connection', function(c) { conns.add(c); });
    var options = { ioServer: JSON.parse(JSON.stringify(Object.assign({ integrationMode: 'attach' }, ioServerOpts))) };
    var attach = new Function('options', 'server', 'Eio', 'parseTimeout', 'require', 'console',
        'var ioServer = null;\n' + body + '\nreturn ioServer;');
    var ioServer = attach(options, server, Eio, function(v) { return v; }, isaacRequire, quiet);
    if (extraListener) {
        server.on('upgrade', extraListener);
    } else {
        upgradeRegions().forEach(function(region) {
            new Function('options', 'server', 'ioServer', 'console', region)(options, server, ioServer, quiet);
        });
    }
    var rec = { server: server, ioServer: ioServer, thrown: thrown, conns: conns, port: 0 };
    servers.push(rec);
    return new Promise(function(resolve) {
        server.listen(0, '127.0.0.1', function() { rec.port = server.address().port; resolve(rec); });
    });
}

/** Opens a WebSocket; resolves on the first message (or `onMessage`'s done), a close, or 2.5 s. */
function socket(port, p, onOpen, onMessage) {
    return new Promise(function(resolve) {
        var c = new WS('ws://127.0.0.1:' + port + p);
        var r = { opened: false, messages: [], ended: null };
        var t = setTimeout(function() { done('timeout'); }, 2500);
        function done(why) { if (r.ended) { return; } r.ended = why; clearTimeout(t); try { c.terminate(); } catch (e) { /* gone */ } resolve(r); }
        c.on('open', function() { r.opened = true; if (onOpen) { onOpen(c); } });
        c.on('message', function(m) {
            r.messages.push(String(m));
            if (onMessage) { onMessage(c, String(m), done); } else { done('message'); }
        });
        c.on('close', function() { done('close'); });
        c.on('error', function() { /* the close follows */ });
        c.on('unexpected-response', function() { done('unexpected-response'); });
    });
}

/** Writes a raw HTTP/1.1 Upgrade; resolves with the first response line ('' if none) and how it ended. */
function rawUpgrade(port, p) {
    return new Promise(function(resolve) {
        var s = net.connect(port, '127.0.0.1');
        var buf = '', ended = null;
        var t = setTimeout(function() { done('timeout'); }, 1500);
        function done(why) { if (ended) { return; } ended = why; clearTimeout(t); try { s.destroy(); } catch (e) { /* gone */ } resolve({ firstLine: buf.split('\r\n')[0], ended: why }); }
        s.on('connect', function() {
            s.write('GET ' + p + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        });
        s.on('data', function(d) { buf += d.toString('latin1'); if (buf.indexOf('\r\n') > -1) { done('response'); } });
        s.on('close', function() { done('close'); });
        s.on('error', function() { done('error'); });
    });
}

/** Completes a polling handshake on `p`; resolves with the sid. */
function pollingSid(port, p) {
    return new Promise(function(resolve, reject) {
        http.get({ host: '127.0.0.1', port: port, path: p }, function(res) {
            var b = ''; res.on('data', function(d) { b += d; }); res.on('end', function() { resolve((b.match(/"sid":"([^"]+)"/) || [])[1]); });
        }).on('error', reject);
    });
}

describe('#B1140 - the harness', function() {

    it('INSTRUMENT: a throwing upgrade listener is recorded, not lost', async function() {
        var srv = await boot({ transports: ['polling'] }, function() { throw new Error('instrument'); });
        await rawUpgrade(srv.port, '/anything');
        assert.deepEqual(srv.thrown.map(function(e) { return e.message; }), ['instrument']);
    });

    it('CONTROL: the attach statements run the real engine.io, attached to the server', async function() {
        var srv = await boot({ transports: ['polling', 'websocket'] });
        assert.ok(srv.ioServer instanceof Eio.Server, 'ioServer is a real engine.io Server');
        assert.equal(srv.server.eio, srv.ioServer);
    });
});

describe('#B1140 - Isaac\'s listener and engine.io\'s own listener never take the same upgrade', function() {

    it('CONTROL: a WebSocket on a bundle push path (no ioServer.path) still reaches engine.io through Isaac\'s listener', async function() {
        var srv = await boot({ transports: ['websocket', 'polling'] });
        var r = await socket(srv.port, '/mybundle/push/?EIO=4&transport=websocket');
        assert.equal(r.opened, true, 'ended: ' + r.ended);
        assert.equal(r.messages[0].charAt(0), '0', 'the open packet');
        assert.deepEqual(srv.thrown, []);
    });

    it('a WebSocket handshake on engine.io\'s own path opens a session, and nothing throws', async function() {
        var srv = await boot({ transports: ['polling', 'websocket'] });
        var r = await socket(srv.port, '/engine.io/?EIO=4&transport=websocket');
        assert.equal(r.opened, true);
        assert.equal(r.messages[0].charAt(0), '0', 'the open packet');
        assert.deepEqual(srv.thrown, []);
    });

    it('a polling session upgrades on engine.io\'s own path, and nothing throws', async function() {
        var srv = await boot({ transports: ['polling', 'websocket'] });
        var sid = await pollingSid(srv.port, '/engine.io/?EIO=4&transport=polling');
        assert.ok(sid, 'the polling handshake returns a sid');
        var r = await socket(srv.port, '/engine.io/?EIO=4&transport=websocket&sid=' + encodeURIComponent(sid),
            function(c) { c.send('2probe'); },
            function(c, m, done) { if (m === '3probe') { done('probe'); } });
        assert.deepEqual(r.messages, ['3probe']);
        assert.deepEqual(srv.thrown, []);
    });

    it('transports given as a string: engine.io\'s own listener keeps its path, and the session opens', async function() {
        var srv = await boot({ transports: 'websocket' });
        var r = await socket(srv.port, '/engine.io/?EIO=4&transport=websocket');
        assert.equal(r.opened, true, 'ended: ' + r.ended);
        assert.equal(r.messages.length > 0 ? r.messages[0].charAt(0) : 'none', '0', 'the open packet');
        assert.deepEqual(srv.thrown, []);
    });

    it('ioServer.path is honoured: engine.io\'s own listener has that path, and nothing throws', async function() {
        var srv = await boot({ transports: ['websocket', 'polling'], path: '/mybundle/push' });
        var r = await socket(srv.port, '/mybundle/push/?EIO=4&transport=websocket');
        assert.equal(r.opened, true, 'ended: ' + r.ended);
        assert.deepEqual(srv.thrown, []);
    });
});

describe('#B1140 - nothing thrown inside Isaac\'s listener escapes', function() {

    it('with the websocket transport disabled, an Upgrade throws nothing', async function() {
        var srv = await boot({ transports: ['polling'] });
        await rawUpgrade(srv.port, '/mybundle/push/?EIO=4&transport=polling');
        await rawUpgrade(srv.port, '/engine.io/?EIO=4&transport=polling');
        assert.deepEqual(srv.thrown, []);
    });

    it('a throw from handleUpgrade destroys that socket instead of escaping', async function() {
        var srv = await boot({ transports: ['websocket', 'polling'] });
        srv.ioServer.handleUpgrade = function() { throw new Error('handleUpgrade failed'); };
        var r = await rawUpgrade(srv.port, '/mybundle/push/?EIO=4&transport=websocket');
        assert.deepEqual(srv.thrown, []);
        assert.equal(r.firstLine, '', 'no response on a dropped socket');
        assert.notEqual(r.ended, 'timeout', 'the socket was closed, not left open (ended: ' + r.ended + ')');
    });
});

describe('#B1140 - the Inspector agent\'s listener and engine.io\'s own listener', function() {

    var devBefore;
    // NODE_ENV_IS_DEV=true: the agent then takes an upgrade without a key, as in dev mode.
    function devOn() {
        devBefore = process.env.NODE_ENV_IS_DEV;
        process.env.NODE_ENV_IS_DEV = 'true';
        if (!process.gina) { process.gina = {}; }
    }
    function devOff() {
        if (typeof devBefore === 'undefined') { delete process.env.NODE_ENV_IS_DEV; } else { process.env.NODE_ENV_IS_DEV = devBefore; }
    }

    it('CONTROL: the agent\'s listener, from its real bytes, answers /_gina/agent', async function() {
        devOn();
        try {
            var srv = await boot({ transports: ['polling', 'websocket'] });
            agentAttach()(srv.server, { instance: {}, appName: 'demo', env: 'dev' });
            var r = await socket(srv.port, '/_gina/agent');
            assert.equal(r.opened, true, 'ended: ' + r.ended);
            assert.equal(JSON.parse(r.messages[0]).event, 'data', 'the agent\'s first frame');
            assert.deepEqual(srv.thrown, []);
        } finally { devOff(); }
    });

    it('a URL under engine.io\'s path that ends with the agent path throws nothing', async function() {
        devOn();
        try {
            var srv = await boot({ transports: ['polling', 'websocket'] });
            agentAttach()(srv.server, { instance: {}, appName: 'demo', env: 'dev' });
            await socket(srv.port, '/engine.io/_gina/agent?EIO=4&transport=websocket');
            assert.deepEqual(srv.thrown, []);
        } finally { devOff(); }
    });
});

describe('#B1140 - source', function() {

    it('the active listener skips engine.io\'s own path and a missing WebSocket server, and calls handleUpgrade inside a try', function() {
        var code = activeListenerCode();
        assert.ok(/_eioOwnListener\s*&&[^\n]*_eioOwnPath[^\n]*\)\s*\{\s*return;\s*\}/.test(code), 'the engine.io-path skip');
        assert.ok(/if\s*\(\s*!ioServer\.ws\s*\)\s*\{\s*return;\s*\}/.test(code), 'the missing-WebSocket-server skip');
        assert.ok(/try\s*\{\s*ioServer\.handleUpgrade\(req, socket, head\);\s*\}\s*catch/.test(code), 'handleUpgrade inside a try');
        // CONTROL: the region is the real listener (the /_gina/agent deferral is in it)
        assert.ok(code.indexOf('_gina\\/agent') > -1);
    });
});
