'use strict';
/**
 * script/smoke_ws_h2.js — the #H13 ws-over-HTTP/2 runtime gate.
 *
 * The smoke itself needs a container; these arms cover the PURE builders and pin
 * the hard-won invariants of the leg so a later edit cannot silently defeat it.
 * Mirrors test/lib/smoke-in-container-fixture.test.js.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');

var SCRIPT = path.join(__dirname, '..', '..', 'script', 'smoke_ws_h2.js');
var mod    = require(SCRIPT);
var src    = fs.readFileSync(SCRIPT, 'utf8');

describe('01 - smoke_ws_h2: pure builders', function () {

    it('exports the pure builders without running the smoke', function () {
        assert.equal(typeof mod.wsFixtureFiles, 'function');
        assert.equal(typeof mod.wsRoutingRule, 'function');
        assert.equal(typeof mod.expectedAdvertise, 'function');
    });

    it('wsRoutingRule() declares a `method:"ws"` route with a :param url', function () {
        var rule = mod.wsRoutingRule();
        var names = Object.keys(rule);
        assert.equal(names.length, 1, 'exactly one rule');
        var r = rule[names[0]];
        assert.equal(r.method, 'ws');
        assert.ok(/:room/.test(r.url), 'url carries the :room capture, got ' + r.url);
        assert.equal(typeof r.param.wsHandler, 'string');
        assert.ok(r.param.wsHandler.length > 0);
    });

    it('the rule\'s wsHandler MATCHES the fixture filename (the drift guard)', function () {
        // core/server.js resolves `channels/<param.wsHandler>.js` and THROWS at boot
        // when absent — a rename on one side only would fail the leg opaquely.
        var handler = mod.wsRoutingRule()[Object.keys(mod.wsRoutingRule())[0]].param.wsHandler;
        var files   = Object.keys(mod.wsFixtureFiles());
        assert.ok(
            files.indexOf('channels/' + handler + '.js') > -1,
            'expected channels/' + handler + '.js among ' + JSON.stringify(files)
        );
    });

    it('the channel handler is a real (session, request) module that echoes the :room capture', function () {
        var files = mod.wsFixtureFiles();
        var rel   = Object.keys(files)[0];
        var tmp   = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fixture-'));
        var file  = path.join(tmp, 'echo.js');
        fs.writeFileSync(file, files[rel]);

        var handler = require(file);
        assert.equal(typeof handler, 'function', 'module.exports must be a function');

        // Drive it with a fake session + request, exactly as the dispatcher would.
        var sent = [];
        var session = {
            onMessage: function (cb) { session._cb = cb; return session; },
            send: function (m) { sent.push(m); return session; }
        };
        handler(session, { params: { room: 'r7' } });
        assert.equal(typeof session._cb, 'function', 'handler registered an onMessage callback');
        session._cb('ping');
        assert.deepEqual(sent, ['[r7] ping'], 'echoes the captured room with the payload');

        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('expectedAdvertise() holds THIS runtime (node) to the capable bar', function () {
        // The suite is Node-only by design; every supported Node major advertises.
        assert.equal(mod.expectedAdvertise(), true);
    });
});

describe('02 - smoke_ws_h2: invariants pinned in source', function () {

    it('guards the smoke behind require.main so the builders stay unit-testable', function () {
        assert.ok(
            src.indexOf('require.main === module') > -1,
            'expected a `require.main === module` guard — without it, requiring this file runs a container smoke'
        );
    });

    it('DERIVES the ws path from the bundle webroot instead of hardcoding it', function () {
        // A `method:"ws"` route registers at the WEBROOT-PREFIXED path: config load
        // prefixes route urls with the bundle webroot, so `/live/:room` in bundle `ws`
        // is reachable at `/ws/live/room1`. Hardcoding `/live/...` 404s forever.
        assert.ok(src.indexOf('"webroot"') > -1, 'expected the webroot to be read out of settings.server.json');
        assert.ok(
            /webroot\s*\+\s*'\/live\//.test(src),
            'expected the ws path to be built FROM the webroot'
        );
    });

    it('keeps the 404-vs-501 diagnostic (they mean opposite things)', function () {
        // isaac answers 501 when NO dispatcher is installed and 404 once one is (it
        // installs lazily on first registration). So a 404 proves the route registered
        // and the path is wrong — the intuitive reading is backwards.
        assert.ok(src.indexOf('404') > -1 && src.indexOf('501') > -1,
            'expected the :status failure to explain 404 vs 501');
    });

    it('asserts the advertisement two-sidedly rather than skipping incapable runtimes', function () {
        assert.ok(
            src.indexOf('advertised !== expected') > -1,
            'expected an equality assertion against the per-runtime expectation — a skip would be a control that cannot fire'
        );
    });
});
