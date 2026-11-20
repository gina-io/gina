'use strict';
/**
 * #S25 — Isaac runs engine.io's WebSocket transport on gina's own `ws`.
 *
 * engine.io's WebSocket transport runs on `ws`, and every engine.io 6.6.x
 * release pins its own `ws` range below 8.23.0, so an install from the
 * registry places an older `ws` under engine.io that gina's own `ws` range
 * does not reach. Isaac's `ioServer` attach block now passes gina's `ws`
 * server class to engine.io as `wsEngine`, unless the bundle named one.
 *
 * The attach statements are sliced from the real core/server.isaac.js bytes,
 * from `delete options.ioServer.integrationMode;` to `server.eio = ioServer;`,
 * and compiled with every identifier they read handed in as a parameter
 * (options, server, Eio, parseTimeout, require, console): a slice compiled
 * with `new Function` captures no closure, so nothing may be left free.
 * `require` is created for the source file's own path, so `ws` resolves as it
 * does in production. engine.io is a stub that records how it was built.
 *
 * Seam: GINA_ISAAC_SRC=<absolute file> runs every arm against that text
 * (red-first against develop's core/server.isaac.js).
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var Module = require('module');

var FW = require('../fw');
var SOURCE = process.env.GINA_ISAAC_SRC || path.join(FW, 'core/server.isaac.js');
var SRC = fs.readFileSync(SOURCE, 'utf8');

var START = 'delete options.ioServer.integrationMode;';
var END = 'server.eio = ioServer;';

// `require` as core/server.isaac.js sees it: resolution starts in its directory.
var isaacRequire = Module.createRequire(SOURCE);

/**
 * The attach statements, or null when either needle is missing or repeated.
 *
 * @returns {string|null}
 */
function attachSlice() {
    var a = SRC.indexOf(START);
    if (a < 0 || SRC.indexOf(START, a + 1) > -1) { return null; }
    var b = SRC.indexOf(END, a);
    if (b < 0 || SRC.indexOf(END, b + 1) > -1) { return null; }
    return SRC.slice(a, b + END.length);
}

/**
 * Drops whole-line `//` comments (the slice has no other kind).
 *
 * @param {string} text
 * @returns {string}
 */
function stripLineComments(text) {
    return text.split('\n').filter(function(line) { return !/^\s*\/\//.test(line); }).join('\n');
}

/**
 * Runs the real attach statements against a stub engine.io.
 *
 * @param {object} ioServerOpts - the bundle's `ioServer` block, as settings.json gives it
 * @returns {{ built: object, returned: object, server: object, timeouts: string[] }}
 */
function runAttach(ioServerOpts) {
    var body = attachSlice();
    assert.ok(body, 'the attach statements must be found once, between the two needles');
    var built = { viaNew: false, server: null, opts: null };
    function Attach(server, opts) {
        built.viaNew = (this instanceof Attach);
        built.server = server;
        built.opts = opts;
        return { stub: 'engine.io' };
    }
    var timeouts = [];
    function parseTimeout(v) { timeouts.push(String(v)); return (v === '5s') ? 5000 : v; }
    var quiet = { info: function() {}, warn: function() {}, log: function() {}, error: function() {} };
    var server = {};
    var fn = new Function('options', 'server', 'Eio', 'parseTimeout', 'require', 'console',
        'var ioServer = null;\n' + body + '\nreturn ioServer;');
    var returned = fn({ ioServer: ioServerOpts }, server, { attach: Attach }, parseTimeout, isaacRequire, quiet);
    return { built: built, returned: returned, server: server, timeouts: timeouts };
}

describe('#S25 - the ioServer attach block hands engine.io gina\'s own ws', function() {

    it('passes gina\'s ws server class as wsEngine when the bundle names none', function() {
        var r = runAttach({ integrationMode: 'attach', transports: ['websocket', 'polling'] });
        var ginaWs = isaacRequire('ws');
        assert.equal(typeof ginaWs.WebSocketServer, 'function', 'precondition: gina\'s ws exports WebSocketServer');
        assert.equal(r.built.opts.wsEngine, ginaWs.WebSocketServer);
    });

    it('that class bounds pending automatic Pongs (maxPendingAutoPongs 60)', function() {
        var r = runAttach({ integrationMode: 'attach' });
        var WsEngine = r.built.opts.wsEngine;
        assert.equal(typeof WsEngine, 'function', 'expected a wsEngine class');
        var wss = new WsEngine({ noServer: true });
        try {
            assert.equal(wss.options.maxPendingAutoPongs, 60);
        } finally {
            wss.close();
        }
    });

    it('keeps a wsEngine the bundle named', function() {
        function CustomWss() {}
        var r = runAttach({ integrationMode: 'attach', wsEngine: CustomWss });
        assert.equal(r.built.opts.wsEngine, CustomWss);
    });

    it('CONTROL: the slice is the real attach code (built with new, integrationMode removed, timeouts normalised, the rest passed through)', function() {
        var r = runAttach({ integrationMode: 'attach', transports: ['polling'], pingInterval: '5s', cors: false });
        assert.equal(r.built.viaNew, true, 'engine.io is constructed with new');
        assert.equal(Object.prototype.hasOwnProperty.call(r.built.opts, 'integrationMode'), false);
        assert.deepEqual(r.timeouts, ['5s'], 'the timeout loop ran');
        assert.equal(r.built.opts.pingInterval, 5000);
        assert.deepEqual(r.built.opts.transports, ['polling']);
        assert.equal(r.built.opts.cors, false);
        assert.equal(r.server.eio, r.returned, 'server.eio is the engine.io instance');
    });

    it('source: the wsEngine default is set before engine.io is constructed (comment lines stripped)', function() {
        var raw = attachSlice();
        assert.ok(raw && raw.indexOf('new Eio.attach(server, options.ioServer)') > -1, 'the raw slice carries the attach call');
        var s = stripLineComments(raw);
        var def = s.indexOf('options.ioServer.wsEngine =');
        var att = s.indexOf('new Eio.attach(server, options.ioServer)');
        assert.ok(def > -1, 'expected the wsEngine default assignment');
        assert.ok(att > def, 'expected the default before engine.io is constructed');
        assert.ok(s.indexOf("require('ws')") > -1, 'expected gina\'s own ws to be required');
    });

});

describe('#S25 - engine.io builds its WebSocket server from opts.wsEngine (the contract the fix relies on)', function() {

    it('uses the class it is given', function() {
        var eio = isaacRequire('engine.io');
        var made = [];
        function FakeWss(opts) {
            made.push(opts);
            this.on = function() {};
            this.close = function() {};
        }
        var engine = new eio.Server({ wsEngine: FakeWss });
        try {
            assert.equal(made.length, 1);
            assert.ok(engine.ws instanceof FakeWss);
            assert.equal(made[0].noServer, true);
        } finally {
            engine.close();
        }
    });

    it('CONTROL: without a wsEngine it builds a ws server of its own', function() {
        var eio = isaacRequire('engine.io');
        var engine = new eio.Server({});
        try {
            assert.equal(typeof engine.ws, 'object');
            assert.equal(typeof engine.ws.handleUpgrade, 'function');
        } finally {
            engine.close();
        }
    });

});
