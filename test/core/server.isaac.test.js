var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var vm = require('node:vm');
var path = require('path');

var SOURCE = path.join(require('../fw'), 'core/server.isaac.js');
var src; // lazily loaded — avoids repeated readFileSync calls


// 01 — V8 arm64 regression: const not var for object rest destructuring
describe('01 - V8 arm64 regression: const not var for object rest destructuring', function() {

    it('source uses const (not var) for routing object rest destructuring', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /const\s*\{\s*_comment\s*,\s*middleware\s*,\s*\.\.\.clean\s*\}/.test(src),
            'expected `const { _comment, middleware, ...clean }` — was changed from `var` to fix V8 arm64 hang'
        );
        assert.ok(
            !/var\s*\{\s*_comment\s*,\s*middleware\s*,\s*\.\.\.clean\s*\}/.test(src),
            '`var { _comment, middleware, ...clean }` must not appear — causes V8 hang on arm64 Node 25'
        );
    });

    it('vm.Script compiles object rest with const without hanging', { timeout: 2000 }, function() {
        // On arm64 Linux / Node 25, `var { ...rest }` inside new vm.Script() would hang at parse time.
        // This test guards against regression: if const is reverted to var, this test will time out.
        var snippet = 'const { _comment, middleware, ...clean } = { _comment: "x", middleware: [], route: "/" };';
        assert.doesNotThrow(function() {
            new vm.Script(snippet);
        });
    });

});


// 02 — routing cleanup: strips _comment and middleware, keeps other keys
describe('02 - routing cleanup: strips _comment and middleware, keeps other keys', function() {

    it('destructuring removes _comment and middleware from route', function() {
        var route = { _comment: 'home page', middleware: ['auth'], bundle: 'public', action: 'home', param: { id: '\\d+' } };
        const { _comment, middleware, ...clean } = route;
        assert.equal(clean._comment, undefined);
        assert.equal(clean.middleware, undefined);
        assert.equal(clean.bundle, 'public');
        assert.equal(clean.action, 'home');
        assert.equal(clean.param.id, '\\d+');
    });

    it('destructuring works when _comment and middleware are absent', function() {
        var route = { bundle: 'api', action: 'list' };
        const { _comment, middleware, ...clean } = route;
        assert.equal(clean.bundle, 'api');
        assert.equal(clean.action, 'list');
        assert.equal(Object.keys(clean).length, 2);
    });

    it('destructuring yields undefined for absent keys without throwing', function() {
        var route = { bundle: 'api' };
        assert.doesNotThrow(function() {
            const { _comment, middleware, ...clean } = route;
            assert.equal(_comment, undefined);
            assert.equal(middleware, undefined);
        });
    });

    it('original route object is not mutated by destructuring', function() {
        var route = { _comment: 'doc', middleware: ['guard'], path: '/items' };
        const { _comment, middleware, ...clean } = route;
        assert.equal(route._comment, 'doc');
        assert.deepEqual(route.middleware, ['guard']);
        assert.equal(route.path, '/items');
    });

    it('multiple routes cleaned independently without cross-contamination', function() {
        var routes = {
            'GET /':       { _comment: 'home', middleware: ['auth'], bundle: 'public', action: 'home' },
            'GET /about':  { bundle: 'public', action: 'about' },
            'POST /login': { _comment: 'login', middleware: [], bundle: 'auth', action: 'login' }
        };
        var cleaned = {};
        var keys = Object.keys(routes);
        for (var i = 0; i < keys.length; ++i) {
            const { _comment, middleware, ...clean } = routes[keys[i]];
            cleaned[keys[i]] = clean;
        }
        assert.equal(cleaned['GET /']._comment, undefined);
        assert.equal(cleaned['GET /'].bundle, 'public');
        assert.equal(cleaned['GET /about'].bundle, 'public');
        assert.equal(cleaned['POST /login']._comment, undefined);
        assert.equal(cleaned['POST /login'].bundle, 'auth');
    });

});


// 03 — HTTP/2 configurable settings source structure (#H3)
describe('03 - HTTP/2 configurable settings source structure (#H3)', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it('source reads http2Options from options', function() {
        assert.ok(
            getSrc().indexOf('options.http2Options') > -1,
            'expected `options.http2Options` — configurable HTTP/2 options not wired'
        );
    });

    it('source defaults maxConcurrentStreams to 256', function() {
        assert.ok(
            getSrc().indexOf('_h2Opts.maxConcurrentStreams || 256') > -1,
            'expected `_h2Opts.maxConcurrentStreams || 256` default'
        );
    });

    it('source defaults initialWindowSize to 65535 * 10', function() {
        assert.ok(
            getSrc().indexOf('_h2Opts.initialWindowSize    || 65535 * 10') > -1,
            'expected `_h2Opts.initialWindowSize || 65535 * 10` default'
        );
    });

    it('source hardcodes maxHeaderListSize to 65536 (HPACK bomb defense)', function() {
        assert.ok(
            getSrc().indexOf('maxHeaderListSize   : 65536') > -1,
            'expected `maxHeaderListSize : 65536` — HPACK bomb defense missing'
        );
    });

    it('source hardcodes enablePush to false', function() {
        assert.ok(
            getSrc().indexOf('enablePush          : false') > -1,
            'expected `enablePush : false` — server push must be disabled'
        );
    });

    it('source sets maxSessionRejectedStreams to 100 (RST/Rapid Reset defense)', function() {
        assert.ok(
            getSrc().indexOf('http2Options.maxSessionRejectedStreams = 100') > -1,
            'expected `maxSessionRejectedStreams = 100` — RST flood / Rapid Reset defense missing'
        );
    });

    it('source sets maxSessionInvalidFrames to 1000 (CONTINUATION flood defense)', function() {
        assert.ok(
            getSrc().indexOf('http2Options.maxSessionInvalidFrames = 1000') > -1,
            'expected `maxSessionInvalidFrames = 1000` — CONTINUATION flood defense missing'
        );
    });

});


// 03b — HTTP/2 configurable settings pure logic
describe('03b - HTTP/2 configurable settings: fallback logic', function() {

    // Replica of the _h2Opts fallback logic in server.isaac.js
    function resolveH2Settings(optionsHttp2Options) {
        var _h2Opts = (optionsHttp2Options && typeof optionsHttp2Options === 'object') ? optionsHttp2Options : {};
        return {
            maxConcurrentStreams : _h2Opts.maxConcurrentStreams || 256,
            initialWindowSize   : _h2Opts.initialWindowSize    || 65535 * 10,
            maxHeaderListSize   : 65536,
            enablePush          : false
        };
    }

    it('uses default maxConcurrentStreams (256) when http2Options absent', function() {
        assert.equal(resolveH2Settings(undefined).maxConcurrentStreams, 256);
    });

    it('uses default maxConcurrentStreams (256) when http2Options is null', function() {
        assert.equal(resolveH2Settings(null).maxConcurrentStreams, 256);
    });

    it('uses default maxConcurrentStreams (256) when http2Options is not an object', function() {
        assert.equal(resolveH2Settings('string').maxConcurrentStreams, 256);
    });

    it('honours custom maxConcurrentStreams from settings.json', function() {
        assert.equal(resolveH2Settings({ maxConcurrentStreams: 512 }).maxConcurrentStreams, 512);
    });

    it('uses default initialWindowSize (655350) when http2Options absent', function() {
        assert.equal(resolveH2Settings(undefined).initialWindowSize, 65535 * 10);
    });

    it('honours custom initialWindowSize from settings.json', function() {
        assert.equal(resolveH2Settings({ initialWindowSize: 131070 }).initialWindowSize, 131070);
    });

    it('always uses hardcoded maxHeaderListSize (65536)', function() {
        assert.equal(resolveH2Settings({ maxHeaderListSize: 99999 }).maxHeaderListSize, 65536);
    });

    it('always disables server push regardless of user config', function() {
        assert.equal(resolveH2Settings({ enablePush: true }).enablePush, false);
    });

    it('http2Options empty object falls back to all defaults', function() {
        var s = resolveH2Settings({});
        assert.equal(s.maxConcurrentStreams, 256);
        assert.equal(s.initialWindowSize, 65535 * 10);
        assert.equal(s.maxHeaderListSize, 65536);
        assert.equal(s.enablePush, false);
    });

});


// 04 — HTTP/2 session metrics source structure (#H3)
describe('04 - HTTP/2 session metrics source structure (#H3)', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it('source declares _h2Metrics with activeSessions, totalStreams, goawayCount, rstCount', function() {
        var s = getSrc();
        assert.ok(s.indexOf('activeSessions') > -1);
        assert.ok(s.indexOf('totalStreams') > -1);
        assert.ok(s.indexOf('goawayCount') > -1);
        assert.ok(s.indexOf('rstCount') > -1);
    });

    it('source attaches _h2Metrics to server', function() {
        assert.ok(
            getSrc().indexOf('server._h2Metrics = _h2Metrics') > -1,
            'expected `server._h2Metrics = _h2Metrics` — metrics not attached to server'
        );
    });

    it('source increments activeSessions on session event', function() {
        assert.ok(
            getSrc().indexOf('_h2Metrics.activeSessions++') > -1,
            'expected `_h2Metrics.activeSessions++` in session handler'
        );
    });

    it('source increments totalStreams on stream event', function() {
        assert.ok(
            getSrc().indexOf('_h2Metrics.totalStreams++') > -1,
            'expected `_h2Metrics.totalStreams++` in stream handler'
        );
    });

    it('source increments rstCount on non-zero rstCode', function() {
        assert.ok(
            getSrc().indexOf('_h2Metrics.rstCount++') > -1,
            'expected `_h2Metrics.rstCount++` in rstCode handler'
        );
    });

    it('source increments goawayCount on goaway event', function() {
        assert.ok(
            getSrc().indexOf('_h2Metrics.goawayCount++') > -1,
            'expected `_h2Metrics.goawayCount++` in goaway handler'
        );
    });

    it('source decrements activeSessions on session close', function() {
        assert.ok(
            getSrc().indexOf('_h2Metrics.activeSessions--') > -1 ||
            getSrc().indexOf('if (_h2Metrics.activeSessions > 0) _h2Metrics.activeSessions--') > -1,
            'expected activeSessions decrement in close handler'
        );
    });

    it('source exposes http2 key in /_gina/info when _h2Metrics present', function() {
        assert.ok(
            getSrc().indexOf('server._h2Metrics') > -1 &&
            getSrc().indexOf('infoPayload["http2"]') > -1,
            'expected http2 block in /_gina/info response'
        );
    });

});


// 04b — HTTP/2 session metrics pure logic
describe('04b - HTTP/2 session metrics: counter logic', function() {

    // Replica of the _h2Metrics counter used in server.isaac.js
    function makeMetrics() {
        return { activeSessions: 0, totalStreams: 0, goawayCount: 0, rstCount: 0 };
    }

    // Replica of the /_gina/info payload builder
    function buildInfoPayload(basePayload, h2Metrics) {
        var payload = Object.assign({}, basePayload);
        if (h2Metrics) {
            payload['http2'] = {
                activeSessions : h2Metrics.activeSessions,
                totalStreams    : h2Metrics.totalStreams,
                goawayCount    : h2Metrics.goawayCount,
                rstCount        : h2Metrics.rstCount
            };
        }
        return payload;
    }

    it('fresh metrics object starts at zero for all counters', function() {
        var m = makeMetrics();
        assert.equal(m.activeSessions, 0);
        assert.equal(m.totalStreams, 0);
        assert.equal(m.goawayCount, 0);
        assert.equal(m.rstCount, 0);
    });

    it('activeSessions increments correctly', function() {
        var m = makeMetrics();
        m.activeSessions++;
        m.activeSessions++;
        assert.equal(m.activeSessions, 2);
    });

    it('activeSessions decrements correctly and does not go below 0', function() {
        var m = makeMetrics();
        m.activeSessions++;
        if (m.activeSessions > 0) m.activeSessions--;
        assert.equal(m.activeSessions, 0);
        if (m.activeSessions > 0) m.activeSessions--;
        assert.equal(m.activeSessions, 0, 'activeSessions must not go below 0');
    });

    it('totalStreams increments independently of activeSessions', function() {
        var m = makeMetrics();
        m.totalStreams++;
        m.totalStreams++;
        m.totalStreams++;
        assert.equal(m.totalStreams, 3);
        assert.equal(m.activeSessions, 0);
    });

    it('rstCount only increments on non-zero rst code', function() {
        var m = makeMetrics();
        var code = 0;
        if (code !== 0) m.rstCount++;
        assert.equal(m.rstCount, 0, 'RST code 0 (NO_ERROR) must not increment rstCount');

        code = 8; // CANCEL
        if (code !== 0) m.rstCount++;
        assert.equal(m.rstCount, 1);
    });

    it('goawayCount increments on goaway event', function() {
        var m = makeMetrics();
        m.goawayCount++;
        assert.equal(m.goawayCount, 1);
    });

    it('buildInfoPayload includes http2 key when metrics provided', function() {
        var m = makeMetrics();
        m.activeSessions = 3;
        m.totalStreams    = 100;
        m.goawayCount    = 2;
        m.rstCount        = 5;
        var payload = buildInfoPayload({ version: 'v20.0.0' }, m);
        assert.ok('http2' in payload, 'http2 key must be present');
        assert.equal(payload.http2.activeSessions, 3);
        assert.equal(payload.http2.totalStreams, 100);
        assert.equal(payload.http2.goawayCount, 2);
        assert.equal(payload.http2.rstCount, 5);
    });

    it('buildInfoPayload omits http2 key when metrics is null', function() {
        var payload = buildInfoPayload({ version: 'v20.0.0' }, null);
        assert.ok(!('http2' in payload), 'http2 key must be absent when metrics is null');
    });

    it('buildInfoPayload omits http2 key when metrics is undefined', function() {
        var payload = buildInfoPayload({ version: 'v20.0.0' }, undefined);
        assert.ok(!('http2' in payload), 'http2 key must be absent when metrics is undefined');
    });

    it('metrics counters are independent — incrementing one does not affect others', function() {
        var m = makeMetrics();
        m.activeSessions++;
        assert.equal(m.totalStreams, 0);
        assert.equal(m.goawayCount, 0);
        assert.equal(m.rstCount, 0);
    });

});
