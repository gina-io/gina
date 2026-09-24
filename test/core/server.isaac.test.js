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
        // #B212 moved the map build to core/server.js's buildClientRoutingAssets;
        // Slice 3 (#SPA1) then rebuilt the full-map cut as an allowlist, so the
        // `{ _comment, middleware, ...clean }` rest-destructuring is gone with the
        // denylist. The const-not-var V8 arm64 guard re-anchors on the SURVIVING
        // rest-destructuring — the #B66 host/hostname drop, kept verbatim in the
        // builder. The negative half is asserted on BOTH files so a `var` rest
        // form cannot reappear in either.
        var serverSrc = fs.readFileSync(path.join(require('../fw'), 'core/server.js'), 'utf8');
        var isaacSrc  = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /const\s*\{\s*host\s*,\s*hostname\s*,\s*\.\.\.cleanStripped\s*\}/.test(serverSrc),
            'expected `const { host, hostname, ...cleanStripped }` — the rest-destructuring stays const (V8 arm64 hang guard)'
        );
        assert.ok(
            !/var\s*\{\s*[^}]*\.\.\.[a-zA-Z]/.test(serverSrc)
            && !/var\s*\{\s*[^}]*\.\.\.[a-zA-Z]/.test(isaacSrc),
            'a `var { ..., ...rest }` object rest-destructuring must not appear — causes V8 hang on arm64 Node 25'
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

    it('source defaults maxSessionRejectedStreams to 100 (RST/Rapid Reset defense) (#H7)', function() {
        assert.ok(
            getSrc().indexOf('_h2Opts.maxSessionRejectedStreams || 100') > -1,
            'expected `_h2Opts.maxSessionRejectedStreams || 100` — configurable RST flood defense'
        );
    });

    it('source defaults maxSessionInvalidFrames to 1000 (CONTINUATION flood defense) (#H7)', function() {
        assert.ok(
            getSrc().indexOf('_h2Opts.maxSessionInvalidFrames || 1000') > -1,
            'expected `_h2Opts.maxSessionInvalidFrames || 1000` — configurable CONTINUATION flood defense'
        );
    });

});


// 03b — HTTP/2 configurable settings pure logic
describe('03b - HTTP/2 configurable settings: fallback logic', function() {

    // Replica of the _h2Opts fallback logic in server.isaac.js (settings + session guards)
    function resolveH2Settings(optionsHttp2Options) {
        var _h2Opts = (optionsHttp2Options && typeof optionsHttp2Options === 'object') ? optionsHttp2Options : {};
        return {
            settings: {
                maxConcurrentStreams : _h2Opts.maxConcurrentStreams || 256,
                initialWindowSize   : _h2Opts.initialWindowSize    || 65535 * 10,
                maxHeaderListSize   : 65536,
                enablePush          : false
            },
            // #H7 — session-level guards now also configurable
            maxSessionRejectedStreams : _h2Opts.maxSessionRejectedStreams || 100,
            maxSessionInvalidFrames  : _h2Opts.maxSessionInvalidFrames   || 1000
        };
    }

    it('uses default maxConcurrentStreams (256) when http2Options absent', function() {
        assert.equal(resolveH2Settings(undefined).settings.maxConcurrentStreams, 256);
    });

    it('uses default maxConcurrentStreams (256) when http2Options is null', function() {
        assert.equal(resolveH2Settings(null).settings.maxConcurrentStreams, 256);
    });

    it('uses default maxConcurrentStreams (256) when http2Options is not an object', function() {
        assert.equal(resolveH2Settings('string').settings.maxConcurrentStreams, 256);
    });

    it('honours custom maxConcurrentStreams from settings.json', function() {
        assert.equal(resolveH2Settings({ maxConcurrentStreams: 512 }).settings.maxConcurrentStreams, 512);
    });

    it('uses default initialWindowSize (655350) when http2Options absent', function() {
        assert.equal(resolveH2Settings(undefined).settings.initialWindowSize, 65535 * 10);
    });

    it('honours custom initialWindowSize from settings.json', function() {
        assert.equal(resolveH2Settings({ initialWindowSize: 131070 }).settings.initialWindowSize, 131070);
    });

    it('always uses hardcoded maxHeaderListSize (65536)', function() {
        assert.equal(resolveH2Settings({ maxHeaderListSize: 99999 }).settings.maxHeaderListSize, 65536);
    });

    it('always disables server push regardless of user config', function() {
        assert.equal(resolveH2Settings({ enablePush: true }).settings.enablePush, false);
    });

    it('http2Options empty object falls back to all defaults', function() {
        var s = resolveH2Settings({});
        assert.equal(s.settings.maxConcurrentStreams, 256);
        assert.equal(s.settings.initialWindowSize, 65535 * 10);
        assert.equal(s.settings.maxHeaderListSize, 65536);
        assert.equal(s.settings.enablePush, false);
        assert.equal(s.maxSessionRejectedStreams, 100);
        assert.equal(s.maxSessionInvalidFrames, 1000);
    });

    // #H7 — session-level guard configurability
    it('uses default maxSessionRejectedStreams (100) when absent', function() {
        assert.equal(resolveH2Settings(undefined).maxSessionRejectedStreams, 100);
    });

    it('honours custom maxSessionRejectedStreams from settings.json', function() {
        assert.equal(resolveH2Settings({ maxSessionRejectedStreams: 50 }).maxSessionRejectedStreams, 50);
    });

    it('uses default maxSessionInvalidFrames (1000) when absent', function() {
        assert.equal(resolveH2Settings(undefined).maxSessionInvalidFrames, 1000);
    });

    it('honours custom maxSessionInvalidFrames from settings.json', function() {
        assert.equal(resolveH2Settings({ maxSessionInvalidFrames: 500 }).maxSessionInvalidFrames, 500);
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


// 07 — HTTP/2 rapid-reset guard wiring (#H9, re-scoped by #B611; #B614)
// The counting policy lives in core/server.isaac.rapid-reset.js and is tested LIVE
// against a bare node:http2 server in test/core/h2-rapid-reset-guard.test.js (the
// former §07b sliding-window replica cases run there against the real function).
// This section pins how server.isaac.js wires it: the resolved limit, the legacy-key
// warning, the per-stream attach inside the session 'stream' listener, and the two
// hooks that own the metrics and the GOAWAY teardown.
describe('07 - HTTP/2 rapid-reset guard wiring in the session stream listener (#H9 / #B611 / #B614)', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }
    function stripLineComments(text) {
        return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
    }

    it('source requires the guard module and resolves the limit from http2Options.maxStreamResetsPerSecond', function() {
        var s = getSrc();
        assert.ok(s.indexOf("var _rapidReset      = require('./server.isaac.rapid-reset');") > -1, 'expected the guard module require');
        assert.ok(s.indexOf('var _maxResetsPerSec = _rapidReset.resolveMaxResetsPerSecond(_h2Opts);') > -1,
            'expected the limit resolved by the module from the http2Options block');
    });

    it('source no longer counts NEW streams (#B611): no live window state on the stream count, no maxStreamsPerSecond fallback', function() {
        var live = stripLineComments(getSrc());
        assert.equal(live.indexOf('session._streamWindowCount'), -1, 'the new-stream window counter is gone');
        assert.equal(live.indexOf('maxStreamsPerSecond || 200'), -1, 'the old key is not read as the limit');
        assert.ok(getSrc().indexOf('maxStreamsPerSecond || 200') > -1,
            'control: the retired line survives as a `// replaced:` comment, so the strip above is a real strip');
    });

    it('source warns once at engine creation when the pre-0.6.33 key maxStreamsPerSecond is still set, and does not honour it', function() {
        var s = getSrc();
        var warnIdx = s.indexOf("if (typeof _h2Opts.maxStreamsPerSecond !== 'undefined') {");
        assert.ok(warnIdx > -1, 'expected the legacy-key presence check');
        var warnBlock = s.slice(warnIdx, warnIdx + 700);
        assert.ok(warnBlock.indexOf('is no longer read') > -1, 'the warning says the key is no longer read');
        assert.ok(warnBlock.indexOf('maxStreamResetsPerSecond') > -1, 'the warning names the replacement key');
        var resolveIdx = s.indexOf('_rapidReset.resolveMaxResetsPerSecond(_h2Opts)');
        assert.ok(resolveIdx > -1 && resolveIdx < warnIdx, 'the limit is resolved by the module BEFORE the warning (the old key never feeds it)');
    });

    it('source passes the runtime\'s own reset-limit knobs through only as a pair (streamResetBurst + streamResetRate)', function() {
        var s = getSrc();
        var idx = s.indexOf("if (typeof _h2Opts.streamResetBurst === 'number' && typeof _h2Opts.streamResetRate === 'number') {");
        assert.ok(idx > -1, 'both knobs gated together — node applies neither unless both are set');
        var block = s.slice(idx, idx + 300);
        assert.ok(block.indexOf('http2Options.streamResetBurst = _h2Opts.streamResetBurst;') > -1);
        assert.ok(block.indexOf('http2Options.streamResetRate  = _h2Opts.streamResetRate;') > -1);
    });

    it('source arms the guard on every stream inside the session stream listener, before the goaway listener', function() {
        var s = getSrc();
        var streamIdx = s.indexOf("session.on('stream'");
        var attachIdx = s.indexOf('_rapidReset.attach(session, stream, _maxResetsPerSec, {', streamIdx);
        var goawayIdx = s.indexOf("session.on('goaway'", streamIdx);
        assert.ok(streamIdx > -1 && attachIdx > streamIdx && goawayIdx > attachIdx,
            'expected `_rapidReset.attach(session, stream, _maxResetsPerSec, {…})` between the stream and goaway listeners');
    });

    it('source feeds rstCount from the guard\'s onReset hook — the rstCode EVENT listener is gone (#B614: rstCode is a property, that listener never fired)', function() {
        var s = getSrc();
        var attachIdx = s.indexOf('_rapidReset.attach(session, stream, _maxResetsPerSec, {');
        var hooks = s.slice(attachIdx, attachIdx + 1200);
        var resetIdx = hooks.indexOf('onReset  : function onClientReset() {');
        assert.ok(resetIdx > -1, 'expected the onReset hook');
        assert.ok(hooks.indexOf('_h2Metrics.rstCount++', resetIdx) > -1, 'onReset increments rstCount');
        assert.equal(stripLineComments(s).indexOf("stream.on('rstCode'"), -1, 'no live rstCode event listener');
        assert.ok(s.indexOf("stream.on('rstCode')") > -1 || s.indexOf('`rstCode` is a property') > -1,
            'control: the retired listener is named in a comment at the site, so the strip above is a real strip');
    });

    it('source sends GOAWAY with NGHTTP2_ENHANCE_YOUR_CALM on breach', function() {
        assert.ok(
            getSrc().indexOf('session.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM)') > -1,
            'expected `session.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM)` on breach'
        );
    });

    it('source closes the session immediately after the breach GOAWAY', function() {
        var s = getSrc();
        var goawayIdx = s.indexOf('session.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM)');
        assert.ok(goawayIdx > -1, 'breach GOAWAY call must exist');
        var closeIdx = s.indexOf('session.close()', goawayIdx);
        assert.ok(closeIdx > -1 && (closeIdx - goawayIdx) < 200, 'expected `session.close()` right after the breach GOAWAY');
    });

    it('source declares the rapidResetBlocked counter', function() {
        assert.ok(getSrc().indexOf('rapidResetBlocked') > -1, 'expected a `rapidResetBlocked` counter');
    });

    it('source increments rapidResetBlocked on breach, inside the guard\'s onBreach hook', function() {
        var s = getSrc();
        var breachIdx = s.indexOf('onBreach : function onRapidResetBreach(count, limit) {');
        assert.ok(breachIdx > -1, 'expected the onBreach hook');
        var blockedIdx = s.indexOf('_h2Metrics.rapidResetBlocked++', breachIdx);
        assert.ok(blockedIdx > -1 && (blockedIdx - breachIdx) < 200, 'expected `_h2Metrics.rapidResetBlocked++` inside the onBreach hook');
    });

    it('source exposes rapidResetBlocked in the /_gina/info http2 payload', function() {
        assert.ok(
            getSrc().indexOf('rapidResetBlocked : server._h2Metrics.rapidResetBlocked') > -1,
            'expected `rapidResetBlocked` in the /_gina/info http2 block'
        );
    });

    it('source warns in the [ SERVER ] style on breach, naming client stream resets', function() {
        assert.ok(
            getSrc().indexOf('[ SERVER ] HTTP/2 rapid-reset rate limit exceeded') > -1,
            'expected a `[ SERVER ] HTTP/2 rapid-reset rate limit exceeded` console.warn'
        );
        assert.ok(getSrc().indexOf('client stream resets in <1s (limit') > -1, 'the warning counts client stream resets, not streams');
    });

    it('the settings templates carry the new key and not the retired one', function() {
        var tplPath = path.join(require('../fw'), 'core', 'template', 'conf', 'settings.json');
        var bpPath  = path.join(require('../fw'), 'core', 'template', 'boilerplate', 'bundle', 'config', 'settings.server.json');
        var tpl = fs.readFileSync(tplPath, 'utf8');
        var bp  = fs.readFileSync(bpPath, 'utf8');
        assert.ok(tpl.indexOf('"maxStreamResetsPerSecond": 200') > -1, 'conf/settings.json ships maxStreamResetsPerSecond: 200');
        assert.equal(tpl.indexOf('"maxStreamsPerSecond":'), -1, 'conf/settings.json no longer ships the retired key');
        assert.ok(bp.indexOf('"maxStreamResetsPerSecond": 200') > -1, 'the boilerplate example names the new key');
        assert.equal(bp.indexOf('"maxStreamsPerSecond":'), -1, 'the boilerplate example no longer names the retired key');
        assert.ok(tpl.indexOf('"maxConcurrentStreams": 256') > -1, 'control: the sibling key is still there');
    });

});

// 07b — the sliding-window cases that used to run here against a replica now run in
// test/core/h2-rapid-reset-guard.test.js against the real core/server.isaac.rapid-reset.js
// (pure window step + live bare-http2 arms). Kept as a pointer so a grep for the old
// section title lands here.


// ─── X-Forwarded-Prefix capture (per-request, not process-global) ────────────
//
// When a reverse proxy mounts the bundle on a sub-path (e.g.
// `proxy_set_header X-Forwarded-Prefix /admin;`), the framework needs to know
// the public mount path so the controller can compose a public webroot for
// browser-side URL construction. The capture site sits AFTER (sibling to,
// not inside) the proxy detection block — it must run on EVERY request
// regardless of `isProxyHost` state, because the proxy detection block is
// gated on `!isProxyHost` and stops firing after the first proxied request
// flips `isProxyHost` to globally true. Stores the normalised value on
// `request._ginaProxyPrefix` (per-request slot) so the value cannot leak
// across requests when the worker handles a mix of proxied + direct calls
// or different proxy mounts. process.gina.PROXY_PREFIX (the previous
// process-global slot) is no longer written.
//
// Normalisation: trim, drop trailing slashes, prepend leading slash if
// missing, drop empty / "/" results so back-compat is preserved (header
// absent or no-op header → property never set, controller falls back to
// the bundle's internal webroot).

describe('X-Forwarded-Prefix capture & normalisation (per-request)', function() {

    if (typeof src == 'undefined' || src === null) {
        src = fs.readFileSync(SOURCE, 'utf8');
    }

    // ── (a) source structure ─────────────────────────────────────────────────

    it("source reads request.headers['x-forwarded-prefix'] after x-forwarded-host in the proxy region", function() {
        // #B65: robust structural pin — replaces a 2500-char proximity window
        // that broke when the #B65 safe-un-gate block was inserted between the
        // host read and the prefix read (span grew 2500 → 2619). An index
        // existence + ordering check has no char-count to re-tune on adjacent
        // edits: it fails loudly if EITHER header read is removed, and asserts
        // the prefix read is co-located AFTER the host read in the proxy-header
        // preprocessing (not relocated elsewhere in the file). The stronger
        // "runs on every request / outside the !isProxyHost gate" guarantee is
        // pinned separately below (xfp read index > the setContext gate index).
        var xfh = src.indexOf("request.headers['x-forwarded-host']");
        var xfp = src.indexOf("request.headers['x-forwarded-prefix']");
        assert.ok(xfh > -1, 'x-forwarded-host read not found — proxy detection block moved');
        assert.ok(xfp > -1, 'x-forwarded-prefix read not found — #B65 xfp processing missing');
        assert.ok(
            xfp > xfh,
            'x-forwarded-prefix must be read AFTER x-forwarded-host (co-located in the proxy-header preprocessing region)'
        );
    });

    it("source assigns the normalised value to request._ginaProxyPrefix (per-request)", function() {
        var anchor = src.indexOf("request.headers['x-forwarded-prefix']");
        assert.ok(anchor > -1, 'x-forwarded-prefix read site not found');
        // #B367 widened 600 -> 1000: the injection charset gate and its rationale
        // comment now sit between the header read and the assignment. The assignment
        // itself is unchanged and still per-request; only the distance grew. (This is
        // the proximity-window brittleness jsdoc.md documents — prefer a structural
        // anchor over a char-distance window when this next needs touching.)
        var windowEnd = Math.min(src.length, anchor + 1000);
        var block = src.slice(anchor, windowEnd);
        assert.ok(
            block.indexOf('request._ginaProxyPrefix') > -1,
            'expected request._ginaProxyPrefix assignment near the x-forwarded-prefix read (per-request, not process-global)'
        );
    });

    it("source does NOT write process.gina.PROXY_PREFIX (the leaky process-global is removed)", function() {
        // Negative invariant: the previous process-global write is the bug
        // surface this slice fixed. If it ever comes back, the per-request
        // isolation is broken and renders mixing proxied + direct calls
        // would leak the prefix across requests until worker restart.
        assert.ok(
            src.indexOf('process.gina.PROXY_PREFIX') === -1,
            'process.gina.PROXY_PREFIX must NOT be written by server.isaac.js — use request._ginaProxyPrefix instead (cross-request leak protection)'
        );
    });

    it("x-forwarded-prefix processing is OUTSIDE the !isProxyHost gated block (runs on every request)", function() {
        // Find the gated block's setContext('isProxyHost', true) line — that
        // marks the END of the gated block. The x-forwarded-prefix read must
        // come AFTER it (or be far enough away to demonstrably be outside).
        // If both sit before setContext, the prefix is still inside the gate
        // and the cross-request leak is back.
        var gateEnd = src.indexOf("setContext('isProxyHost', true)");
        var xfpRead = src.indexOf("request.headers['x-forwarded-prefix']");
        assert.ok(gateEnd > -1, "setContext('isProxyHost', true) not found — proxy block may have moved");
        assert.ok(xfpRead > -1, 'x-forwarded-prefix read not found');
        assert.ok(
            xfpRead > gateEnd,
            'x-forwarded-prefix processing must be AFTER the !isProxyHost gated block (currently before — leak risk)'
        );
    });

    it("source strips trailing slashes via /\\/+$/ replace", function() {
        var anchor = src.indexOf("request.headers['x-forwarded-prefix']");
        var windowEnd = Math.min(src.length, anchor + 600);
        var block = src.slice(anchor, windowEnd);
        assert.ok(
            /\.replace\(\s*\/\\\/\+\$\/\s*,\s*''\s*\)/.test(block),
            'expected `.replace(/\\/+$/, \'\')` to strip trailing slashes from the header value'
        );
    });

    // ── (b) pure logic — inline replica ──────────────────────────────────────
    //
    // Replica of the normalisation steps in server.isaac.js. The replica must
    // stay byte-equivalent to the live capture; the source-structure tests
    // above pin the live shape.

    function normaliseXfp(headerValue) {
        if (!headerValue) return undefined;
        var xfp = String(headerValue).trim();
        xfp = xfp.replace(/\/+$/, '');
        if (xfp.length > 0 && xfp.charAt(0) !== '/') {
            xfp = '/' + xfp;
        }
        if (xfp.length > 0) return xfp;
        return undefined;
    }

    it('absent header → undefined (back-compat)', function() {
        assert.equal(normaliseXfp(undefined), undefined);
        assert.equal(normaliseXfp(null), undefined);
        assert.equal(normaliseXfp(''), undefined);
    });

    it('lone "/" → undefined (no-op header is dropped)', function() {
        assert.equal(normaliseXfp('/'), undefined);
        assert.equal(normaliseXfp('//'), undefined);
        assert.equal(normaliseXfp('   /   '), undefined);
    });

    it('"/sub" → "/sub" (already canonical)', function() {
        assert.equal(normaliseXfp('/sub'), '/sub');
    });

    it('"/sub/" → "/sub" (trailing slash stripped)', function() {
        assert.equal(normaliseXfp('/sub/'), '/sub');
    });

    it('"/sub//" → "/sub" (multiple trailing slashes stripped)', function() {
        assert.equal(normaliseXfp('/sub//'), '/sub');
    });

    it('"sub" → "/sub" (leading slash added)', function() {
        assert.equal(normaliseXfp('sub'), '/sub');
    });

    it('"sub/" → "/sub" (leading added, trailing stripped)', function() {
        assert.equal(normaliseXfp('sub/'), '/sub');
    });

    it('"  /sub  " → "/sub" (whitespace trimmed)', function() {
        assert.equal(normaliseXfp('  /sub  '), '/sub');
    });

    it('multi-segment "/admin/v2" → "/admin/v2"', function() {
        assert.equal(normaliseXfp('/admin/v2'), '/admin/v2');
    });

    it('multi-segment "/admin/v2/" → "/admin/v2"', function() {
        assert.equal(normaliseXfp('/admin/v2/'), '/admin/v2');
    });

});


// 05 — URL query string parsing: '+' → space decoding (#B17)
//
// The Isaac engine's request handler at server.on('request', ...) parses
// `?key=value&...` into request.query. Per WHATWG URL "application/x-www-form-urlencoded
// parser" spec, '+' in values must be replaced with space BEFORE percent-decoding
// (decodeURIComponent only decodes %XX, not '+'). Both branches of the parser
// (multi-value `&` loop and single-key `=` no-`&` path) carry the fix.
//
// Express engine is already spec-correct via qs/querystring.unescape defaults — no
// change there. Body parsing is covered by http-methods.test.js section 12.

describe("05 - URL query string parsing: '+' → space decoding (#B17)", function() {

    var srcLocal;
    function getSrc() {
        if (!srcLocal) srcLocal = fs.readFileSync(SOURCE, 'utf8');
        return srcLocal;
    }

    // Source-level pins — confirm '+' handling exists at both sites BEFORE
    // (or independent of) decodeURIComponent, in the request-handler URL parser.

    it("multi-value branch: '+' replacement appears before decodeURIComponent inside the &-loop", function() {
        // Region: the &-loop processes arr[p].split('=') inside queryParams.split('&').
        // We look for the if-block that handles '+' and '%' in the value.
        var s = getSrc();
        var marker = "arr = queryParams[i].split('&')";
        var startIdx = s.indexOf(marker);
        assert.ok(startIdx > -1, 'expected the &-loop marker to be present');
        // Slice to the end of the inner for-loop (closing of the arr-loop)
        var region = s.slice(startIdx, startIdx + 1500);
        assert.match(
            region,
            /a\[1\]\.indexOf\('\+'\)\s*>\s*-1/,
            "expected '+' presence check on a[1] inside &-loop"
        );
        assert.match(
            region,
            /a\[1\]\s*=\s*a\[1\]\.replace\(\/\\\+\/g,\s*' '\)/,
            "expected '+' → space replacement on a[1] inside &-loop"
        );
    });

    it("single-key branch: '+' replacement appears in the no-'&' path (a.length > 1 case)", function() {
        var s = getSrc();
        // Region: the else branch after the &-loop (no `&` in query string)
        var marker = "queryParams[1].split('=')";
        var idx = s.indexOf(marker);
        assert.ok(idx > -1, "expected single-key branch marker to be present");
        var region = s.slice(idx, idx + 1500);
        assert.match(
            region,
            /a\[1\]\.indexOf\('\+'\)\s*>\s*-1/,
            "expected '+' presence check on a[1] in single-key branch"
        );
        assert.match(
            region,
            /a\[1\]\s*=\s*a\[1\]\.replace\(\/\\\+\/g,\s*' '\)/,
            "expected '+' → space replacement on a[1] in single-key branch"
        );
    });

    it("both branches replace '+' BEFORE calling decodeURIComponent (not after)", function() {
        // The order matters: decodeURIComponent does NOT decode '+', so the replace
        // must run first (or at least before the value is consumed). Otherwise a
        // value like 'Hello%2B' (literal '+' encoded as %2B) would become 'Hello+'
        // which would then be wrongly turned into 'Hello '.
        var s = getSrc();
        // Multi-value branch
        var multiStart = s.indexOf("arr = queryParams[i].split('&')");
        var multiRegion = s.slice(multiStart, multiStart + 1500);
        var multiPlus   = multiRegion.indexOf("a[1].replace(/\\+/g, ' ')");
        // #B30 renamed the decode call to the crash-safe wrapper safeDecodeURIComponent(a[1]);
        // the +→space ordering invariant (#B17) is unchanged.
        var multiDecode = multiRegion.indexOf('safeDecodeURIComponent(a[1])');
        assert.ok(multiPlus > -1 && multiDecode > -1, 'both ops must exist in multi-value branch');
        assert.ok(multiPlus < multiDecode, "multi-value: '+' replace must precede decodeURIComponent");

        // Single-key branch
        var singleStart = s.indexOf("queryParams[1].split('=')");
        var singleRegion = s.slice(singleStart, singleStart + 1500);
        var singlePlus   = singleRegion.indexOf("a[1].replace(/\\+/g, ' ')");
        var singleDecode = singleRegion.indexOf('safeDecodeURIComponent(a[1])'); // #B30 rename (see above)
        assert.ok(singlePlus > -1 && singleDecode > -1, 'both ops must exist in single-key branch');
        assert.ok(singlePlus < singleDecode, "single-key: '+' replace must precede decodeURIComponent");
    });

    // Pure-logic replicas of the two branches AFTER #B17 fix, exercised against
    // the inputs the production parser sees. Mirror of server.isaac.js:1258-1300.

    function parseQueryAfterFix(rawQs) {
        // rawQs is everything after '?'
        var query = {};
        if (rawQs.indexOf('&') > -1) {
            // multi-value branch
            var arr = rawQs.split('&');
            for (var p = 0; p < arr.length; ++p) {
                var a = arr[p].split('=');
                var lower = a[1] && a[1].toLowerCase();
                if (lower === 'false' || lower === 'true' || lower === 'on') {
                    a[1] = (lower === 'true' || lower === 'on') ? true : false;
                } else if (a[1] && (a[1].indexOf('+') > -1 || a[1].indexOf('%') > -1)) {
                    if (a[1].indexOf('+') > -1) a[1] = a[1].replace(/\+/g, ' ');
                    if (a[1].indexOf('%') > -1) a[1] = decodeURIComponent(a[1]);
                }
                if (a[1] && typeof a[1] === 'string' && (a[1].charAt(0) === '{' || a[1].charAt(0) === '[')) {
                    try { a[1] = JSON.parse(a[1]); } catch (e) { /* keep as string */ }
                }
                query[a[0]] = a[1];
            }
        } else {
            // single-key branch (no '&')
            var a = rawQs.split('=');
            if (a.length > 1) {
                var lower2 = a[1] && a[1].toLowerCase();
                if (lower2 === 'false' || lower2 === 'true' || lower2 === 'on') {
                    a[1] = (lower2 === 'true' || lower2 === 'on') ? true : false;
                } else if (a[1] && (a[1].indexOf('+') > -1 || a[1].indexOf('%') > -1)) {
                    if (a[1].indexOf('+') > -1) a[1] = a[1].replace(/\+/g, ' ');
                    if (a[1].indexOf('%') > -1) a[1] = decodeURIComponent(a[1]);
                }
                query[a[0]] = a[1];
            } else {
                // ?encodedJsonObject fallback — unchanged by #B17
                if (a[0].indexOf('%') > -1) a[0] = decodeURIComponent(a[0]);
                try { query = a[0] ? JSON.parse(a[0]) : {}; } catch (e) { /* ignore */ }
            }
        }
        return query;
    }

    // Single-key branch (no '&') — positive cases

    it("single-key '?name=Hello+World' decodes to { name: 'Hello World' }", function() {
        var q = parseQueryAfterFix('name=Hello+World');
        assert.deepEqual(q, { name: 'Hello World' });
    });

    it("single-key '?name=Hello%20World' still decodes to { name: 'Hello World' } via existing % path", function() {
        var q = parseQueryAfterFix('name=Hello%20World');
        assert.deepEqual(q, { name: 'Hello World' });
    });

    it("single-key mixed '?name=Hello+World%21' decodes to { name: 'Hello World!' }", function() {
        var q = parseQueryAfterFix('name=Hello+World%21');
        assert.deepEqual(q, { name: 'Hello World!' });
    });

    // Multi-value branch (has '&') — positive cases

    it("multi-value '?a=1+2&b=3+4' decodes both values to '1 2' and '3 4'", function() {
        var q = parseQueryAfterFix('a=1+2&b=3+4');
        assert.deepEqual(q, { a: '1 2', b: '3 4' });
    });

    it("multi-value '?a=Hello+World&b=foo%21' decodes both values together", function() {
        var q = parseQueryAfterFix('a=Hello+World&b=foo%21');
        assert.deepEqual(q, { a: 'Hello World', b: 'foo!' });
    });

    it("multi-value '?name=Hello%20World&other=plain' still decodes via existing % path", function() {
        var q = parseQueryAfterFix('name=Hello%20World&other=plain');
        assert.deepEqual(q, { name: 'Hello World', other: 'plain' });
    });

    // Reproducer pinned: URLSearchParams.toString() encodes space as '+'

    it("URLSearchParams.toString() output → single-key parser decodes '+' back to space", function() {
        var params = new URLSearchParams({ name: 'Hello World' });
        assert.ok(/\+/.test(params.toString()));
        var q = parseQueryAfterFix(params.toString());
        assert.deepEqual(q, { name: 'Hello World' });
    });

    it("URLSearchParams.toString() multi-key → multi-value parser decodes '+' back to space", function() {
        var params = new URLSearchParams({ first: 'Jane Doe', last: 'John Smith' });
        var qs = params.toString();
        assert.ok(/\+/.test(qs));
        var q = parseQueryAfterFix(qs);
        assert.deepEqual(q, { first: 'Jane Doe', last: 'John Smith' });
    });

    // Counter / back-compat — values without '+' or '%' are unchanged

    it("plain values without '+' or '%' pass through unchanged (multi-value)", function() {
        var q = parseQueryAfterFix('a=plain&b=other');
        assert.deepEqual(q, { a: 'plain', b: 'other' });
    });

    it("plain values without '+' or '%' pass through unchanged (single-key)", function() {
        var q = parseQueryAfterFix('name=plain');
        assert.deepEqual(q, { name: 'plain' });
    });

    it("'false'/'true'/'on' coercion still wins over '+' decoding when value matches", function() {
        // The boolean-coercion branch comes first; if value is exactly 'false'/'true'/'on'
        // (no '+' chars anyway), it gets boolean-coerced and never reaches the '+' branch.
        var q = parseQueryAfterFix('flag=true&other=false');
        assert.deepEqual(q, { flag: true, other: false });
    });

    it("multi-value JSON-parse branch still fires after '+' decode if value starts with '{'", function() {
        // Note: '+' inside a JSON value is preserved by decodeURIComponent and JSON.parse.
        // The JSON-parse step only exists in the multi-value branch (production parity),
        // so the test must use a multi-key query string to exercise it.
        var q = parseQueryAfterFix('payload=' + encodeURIComponent('{"v":"1+2"}') + '&flag=true');
        assert.deepEqual(q, { payload: { v: '1+2' }, flag: true });
    });

    it("single-key branch does NOT auto-JSON-parse values starting with '{' (pre-existing behaviour)", function() {
        // Production single-key branch (server.isaac.js:1282-1288) lacks the JSON-parse step
        // present in the multi-value branch. #B17 does not change this; documented for clarity.
        var q = parseQueryAfterFix('payload=' + encodeURIComponent('{"v":"1"}'));
        assert.strictEqual(typeof q.payload, 'string',
            'single-key branch keeps JSON-shaped value as string — only multi-value branch auto-parses');
    });

    // Counter — body-parser fix in commit 014ff60a is unaffected

    it("body-parser fix (POST/PUT/PATCH) is unchanged — query-string fix is a different code path", function() {
        var s = getSrc();
        // The body-parser fix lives in server.js, not server.isaac.js. Confirm
        // server.isaac.js does NOT have its own processRequestData definition.
        assert.ok(
            s.indexOf('var processRequestData = function') < 0,
            'server.isaac.js must NOT define processRequestData — body parsing is delegated to server.js handle()'
        );
    });
});


// 06 — refreshCore() require.cache rebuild: Module-vs-exports object
describe('06 - refreshCore() require.cache rebuild — no exports-object poisoning', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    // Slice the refreshCore() function body so the assertions below cannot
    // false-match similar shapes elsewhere in the file.
    function refreshCoreRegion() {
        var s = getSrc();
        var start = s.indexOf('var refreshCore = function()');
        assert.ok(start > -1, 'expected `var refreshCore = function()` to be present');
        var end = s.indexOf('// Express compatibility', start);
        assert.ok(end > start, 'expected the `// Express compatibility` marker after refreshCore()');
        return s.slice(start, end);
    }

    it('rebuilds the lib entry via delete + fresh require (not `require.cache[path] = require(path)`)', function() {
        assert.match(
            refreshCoreRegion(),
            /delete require\.cache\[require\.resolve\(libIndexPath\)\];\s+var freshLib = require\( libIndexPath \);/,
            'expected `delete require.cache[...]` then `var freshLib = require(libIndexPath)` — rebuild via fresh require'
        );
    });

    it('does NOT overwrite require.cache[libPath] with the exports object (the poisoning antipattern)', function() {
        var region = refreshCoreRegion();
        assert.ok(
            region.indexOf("require.cache[_(libPath +'/index.js', true)] = require(") < 0,
            'require.cache[libPath] must not be assigned the exports object — Node expects a Module instance there'
        );
        assert.ok(
            region.indexOf('require.cache[libIndexPath] =') < 0,
            'the fresh-binding refactor must not re-introduce a require.cache[libIndexPath] = ... assignment'
        );
    });

    it('points gna.js `.exports.lib` at the fresh registry binding', function() {
        assert.match(
            refreshCoreRegion(),
            /require\.cache\[_\(corePath \+ '\/gna\.js', true\)\]\.exports\.lib\s*=\s*freshLib;/,
            'expected `…/gna.js…].exports.lib = freshLib` — gna must point at the rebuilt registry'
        );
    });

    it('applies the same delete + fresh-require + exports.plugins shape to the plugins entry', function() {
        var region = refreshCoreRegion();
        assert.match(
            region,
            /delete require\.cache\[require\.resolve\(pluginsIndexPath\)\];\s+var freshPlugins = require\( pluginsIndexPath \);/,
            'expected the plugins entry to use the same rebuild-via-fresh-require shape'
        );
        assert.ok(
            region.indexOf("require.cache[_(corePath +'/plugins/index.js', true)] = require(") < 0,
            'require.cache[pluginsPath] must not be assigned the exports object'
        );
        assert.match(
            region,
            /require\.cache\[_\(corePath \+ '\/gna\.js', true\)\]\.exports\.plugins\s*=\s*freshPlugins;/,
            'expected `…/gna.js…].exports.plugins = freshPlugins`'
        );
    });

    it('keeps the correct `.exports`-assigning form for the core-path refresh loop', function() {
        // The loop that refreshes every other core module already uses the
        // correct shape — `require.cache[c].exports = require(...)` — which keeps
        // the Module instance and only swaps `.exports`. The lib/plugins fix
        // mirrors that intent via delete + fresh require.
        assert.match(
            refreshCoreRegion(),
            /require\.cache\[c\]\.exports\s*=\s*require\(/,
            'expected the core-path loop to keep `require.cache[c].exports = require(...)`'
        );
    });

});


// ─────────────────────────────────────────────────────────────────────────
// 08 — #S7 admin-grade /_gina/* IP allowlist
// ─────────────────────────────────────────────────────────────────────────
//
// /_gina/info and /_gina/cache/stats expose process state (memory,
// uptime, HTTP/2 session counters, cache contents). They are admin-grade
// endpoints and must be IP-allowlisted at the bundle edge.
//
// Mirrors the #OBS1 metrics gate at /_gina/metrics:
//   - Reads client IP from req.socket.remoteAddress only (NEVER X-Forwarded-For)
//   - Normalises ::ffff:IPv4 → IPv4
//   - Empty allowlist `[]` means deny-everyone (explicit lockdown)
//   - Defaults to loopback `['127.0.0.1', '::1']` when app.json admin.allowFrom omitted
//   - process.gina._adminAllowList holds the cached list (populated by gna.js at bundle init)
//
// 403 JSON `{ error: 'forbidden', message: '...' }` with cache-control headers
// on deny, mirroring the metrics endpoint's deny shape.

describe('08 - #S7 admin /_gina/* IP allowlist source structure', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // The helper-body pins (reads-allowlist / no-X-Forwarded-For / ::ffff
    // normalise) moved to test/lib/admin.test.js when isAdminClientAllowed was
    // extracted into the shared lib.admin; this describe now pins how the Isaac
    // handlers wire that gate (plus the gna.js + schema wiring below).

    it('/_gina/info handler invokes the gate before responding', function() {
        var infoMatch = src.indexOf('\\_gina\\/info$');
        assert.ok(infoMatch > -1, '/_gina/info regex anchor not found');
        var afterInfo = src.slice(infoMatch, infoMatch + 1200);
        assert.ok(afterInfo.indexOf('lib.admin.isClientAllowed(request)') > -1,
            '/_gina/info handler must invoke lib.admin.isClientAllowed(request) before responding');
        assert.ok(afterInfo.indexOf("':status': 403") > -1 || afterInfo.indexOf(', 403') > -1,
            '/_gina/info handler must return 403 on deny');
    });

    it('/_gina/cache/stats handler invokes the gate before responding', function() {
        var cacheMatch = src.indexOf('/_gina\\/cache\\/stats$');
        assert.ok(cacheMatch > -1, '/_gina/cache/stats regex anchor not found');
        var afterCache = src.slice(cacheMatch, cacheMatch + 1200);
        assert.ok(afterCache.indexOf('lib.admin.isClientAllowed(request)') > -1,
            '/_gina/cache/stats handler must invoke lib.admin.isClientAllowed(request) before responding');
        assert.ok(afterCache.indexOf("':status': 403") > -1 || afterCache.indexOf(', 403') > -1,
            '/_gina/cache/stats handler must return 403 on deny');
    });

    // ── /_gina/cache/clear (#RC — Slice 3 cross-strategy flush) ─────────────
    it('/_gina/cache/clear handler is POST-gated + admin-gated (403 on deny)', function() {
        var clearMatch = src.indexOf('/_gina/cache/clear');
        var jobsMatch  = src.indexOf('/_gina\\/jobs', clearMatch);
        assert.ok(clearMatch > -1, '/_gina/cache/clear regex anchor not found');
        var blk = src.slice(clearMatch, jobsMatch > clearMatch ? jobsMatch : clearMatch + 2000);
        assert.ok(/method\.toUpperCase\(\) === 'POST'/.test(blk),
            '/_gina/cache/clear must gate on POST (a flush is a mutation, not a safe GET)');
        assert.ok(blk.indexOf('lib.admin.isClientAllowed(request)') > -1,
            '/_gina/cache/clear handler must invoke lib.admin.isClientAllowed(request) before flushing');
        assert.ok(blk.indexOf("':status': 403") > -1 || blk.indexOf(', 403') > -1,
            '/_gina/cache/clear handler must return 403 on deny');
    });

    it('/_gina/cache/clear flushes via renderCache scoped clear(bundle) + keeps the dual HTTP/2 + HTTP/1.1 write', function() {
        var clearMatch = src.indexOf('/_gina/cache/clear');
        var jobsMatch  = src.indexOf('/_gina\\/jobs', clearMatch);
        var blk = src.slice(clearMatch, jobsMatch > clearMatch ? jobsMatch : clearMatch + 2000);
        assert.ok(blk.indexOf('renderCache.from(server._cached)') > -1, 'must adopt the shared server._cached Map');
        assert.ok(/renderCache\.clear\(cacheClearBundle\)/.test(blk),
            'must call the scoped clear(bundle) on the render-cache dispatcher (never lib.Cache whole-store)');
        assert.ok(blk.indexOf("get('bundle')") > -1, 'must honour the optional ?bundle= filter');
        assert.ok(blk.indexOf('response.stream.respond') > -1 && blk.indexOf('response.writeHead(200') > -1,
            'must keep the isaac dual HTTP/2 (stream.respond) + HTTP/1.1 (writeHead) response');
    });

    it('/_gina/cache/clear honours ?event= and lets it WIN over ?bundle= (engine parity)', function() {
        // Mirrors the express-engine pin in server.test.js — /_gina/* handlers must
        // stay in step across engines. Load-bearing: `event` used to be an unparsed
        // param, so ?event=<name> fell through with bundle === null and flushed EVERY
        // bundle's output cache instead of evicting that event's entries.
        var clearMatch = src.indexOf('/_gina/cache/clear');
        var jobsMatch  = src.indexOf('/_gina\\/jobs', clearMatch);
        var blk = src.slice(clearMatch, jobsMatch > clearMatch ? jobsMatch : clearMatch + 2000);

        assert.ok(blk.indexOf("get('event')") > -1, 'must parse the ?event= selector');
        assert.ok(/renderCache\.invalidateByEvent\(cacheClearEvent\)/.test(blk),
            'an ?event= run must evict by event, not flush');

        // The selection must be gated on cacheClearEvent, so ?event= can never reach
        // the bundle flush.
        assert.match(blk, /\(\s*cacheClearEvent\s*\)\s*\?[\s\S]{0,160}?invalidateByEvent\(cacheClearEvent\)[\s\S]{0,160}?:[\s\S]{0,160}?renderCache\.clear\(cacheClearBundle\)/,
            'invalidateByEvent must be selected over clear() whenever cacheClearEvent is set');
        // …and the reported envelope must name the event, not a null bundle.
        assert.ok(blk.indexOf('event: cacheClearEvent') > -1,
            'the ?event= response must echo the event (never bundle: null)');
    });

    it('gna.js wires the admin allowlist init alongside the metrics init block', function() {
        var gnaSrc = fs.readFileSync(path.join(require('../fw'), 'core/gna.js'), 'utf8');
        assert.ok(
            gnaSrc.indexOf('process.gina._adminAllowList') > -1,
            'gna.js must set process.gina._adminAllowList at bundle init'
        );
        assert.ok(
            gnaSrc.indexOf('_adminAppConf.admin') > -1 || gnaSrc.indexOf('admin.allowFrom') > -1,
            'gna.js must read admin.allowFrom from app.json'
        );
    });

    it('schema/app.json declares the admin.allowFrom block', function() {
        var schemaSrc = fs.readFileSync(path.join(require('../fw'), '../../schema/app.json'), 'utf8');
        var schema    = JSON.parse(schemaSrc);
        assert.ok(schema.properties.admin, 'schema must declare an `admin` block');
        assert.ok(schema.properties.admin.properties.allowFrom, 'admin block must declare an `allowFrom` property');
        assert.equal(schema.properties.admin.properties.allowFrom.type, 'array', 'allowFrom must be an array');
        assert.deepEqual(schema.properties.admin.properties.allowFrom.default, ['127.0.0.1', '::1'],
            'allowFrom must default to loopback');
    });

});


describe('08b - #S7 admin allowlist: pure logic replica', function() {

    // Inline replica of isAdminClientAllowed. Takes the allowlist as a parameter
    // so we can exercise every branch without touching process.gina state.
    function isAllowed(req, list) {
        if (list.length === 0) return false;
        var ip = (req.socket && req.socket.remoteAddress)
              || (req.connection && req.connection.remoteAddress)
              || '';
        if (ip.indexOf('::ffff:') === 0) ip = ip.slice(7);
        return list.indexOf(ip) >= 0;
    }

    it('loopback IPv4 is allowed by default', function() {
        var req = { socket: { remoteAddress: '127.0.0.1' } };
        assert.equal(isAllowed(req, ['127.0.0.1', '::1']), true);
    });

    it('loopback IPv6 (::1) is allowed by default', function() {
        var req = { socket: { remoteAddress: '::1' } };
        assert.equal(isAllowed(req, ['127.0.0.1', '::1']), true);
    });

    it('::ffff:127.0.0.1 (IPv6-mapped IPv4 loopback) is normalised and allowed', function() {
        var req = { socket: { remoteAddress: '::ffff:127.0.0.1' } };
        assert.equal(isAllowed(req, ['127.0.0.1', '::1']), true);
    });

    it('arbitrary public IP is denied by default loopback-only list', function() {
        var req = { socket: { remoteAddress: '203.0.113.42' } };
        assert.equal(isAllowed(req, ['127.0.0.1', '::1']), false);
    });

    it('private network IP is allowed when listed', function() {
        var req = { socket: { remoteAddress: '10.0.1.5' } };
        assert.equal(isAllowed(req, ['127.0.0.1', '::1', '10.0.1.5']), true);
    });

    it('::ffff:10.0.1.5 (IPv6-mapped non-loopback) is normalised and matched', function() {
        var req = { socket: { remoteAddress: '::ffff:10.0.1.5' } };
        assert.equal(isAllowed(req, ['10.0.1.5']), true);
    });

    it('empty allowlist denies everyone (explicit lockdown)', function() {
        assert.equal(isAllowed({ socket: { remoteAddress: '127.0.0.1' } }, []), false);
        assert.equal(isAllowed({ socket: { remoteAddress: '::1' } }, []), false);
        assert.equal(isAllowed({ socket: { remoteAddress: '10.0.0.1' } }, []), false);
    });

    it('falls back to req.connection.remoteAddress when req.socket is missing', function() {
        var req = { connection: { remoteAddress: '127.0.0.1' } };
        assert.equal(isAllowed(req, ['127.0.0.1', '::1']), true);
    });

    it('req with no socket and no connection returns empty IP, denies', function() {
        var req = {};
        assert.equal(isAllowed(req, ['127.0.0.1', '::1']), false);
    });

    it('X-Forwarded-For header is ignored even when present (spoofing defense)', function() {
        // The actual socket source is non-loopback; the X-Forwarded-For header
        // claims to be loopback. Helper must trust the socket, not the header.
        var req = {
            socket:  { remoteAddress: '203.0.113.42' },
            headers: { 'x-forwarded-for': '127.0.0.1' }
        };
        assert.equal(isAllowed(req, ['127.0.0.1', '::1']), false,
            'must NOT trust X-Forwarded-For — reverse proxies could spoof it');
    });

});


// ─────────────────────────────────────────────────────────────────────────
// 09 — #HDR8 Phase 2 X-Powered-By framework-level gate (source structure)
// ─────────────────────────────────────────────────────────────────────────
//
// Phase 2 closes the Isaac-engine gap that the Phase 1
// gina.plugins.HidePoweredBy() middleware cannot reach: 17 direct
// response.writeHead({ 'X-Powered-By': ... }) emissions that bypass
// the setHeader/removeHeader interface. Wiring:
//   - settings.json > server.hidePoweredBy boolean (default false)
//   - _setPoweredByHeader(headers) closure inside onPath, defined
//     once at server boot, capturing `options` from ServerEngineClass
//   - 16 object-literal header blocks wrap via _setPoweredByHeader({...})
//   - 1 routing.json asset handler wraps response.setHeader in an
//     inline `if (!options.hidePoweredBy)` (different writeHead shape)
//
// Default false preserves shipped behaviour; opt-in via
// server.hidePoweredBy: true. The flag is a no-op on the Express
// engine — Express bundles use gina.plugins.HidePoweredBy() instead.

describe('09 - #HDR8 Phase 2 X-Powered-By framework gate source structure', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    it('source defines the _setPoweredByHeader helper', function() {
        assert.ok(
            src.indexOf('var _setPoweredByHeader = function(headers) {') > -1,
            'expected `var _setPoweredByHeader = function(headers) {` helper definition'
        );
    });

    it('helper gates on !options.hidePoweredBy', function() {
        var fnStart = src.indexOf('var _setPoweredByHeader = function(headers) {');
        var fnEnd   = src.indexOf('};', fnStart);
        var body    = src.slice(fnStart, fnEnd);
        assert.ok(body.indexOf('if (!options.hidePoweredBy)') > -1,
            'helper must use `if (!options.hidePoweredBy)` as the gate');
    });

    it("helper sets 'X-Powered-By' to 'Gina/' + GINA_VERSION when the gate is open", function() {
        var fnStart = src.indexOf('var _setPoweredByHeader = function(headers) {');
        var fnEnd   = src.indexOf('};', fnStart);
        var body    = src.slice(fnStart, fnEnd);
        assert.ok(body.indexOf("headers['X-Powered-By'] = 'Gina/' + GINA_VERSION;") > -1,
            "helper must assign `headers['X-Powered-By'] = 'Gina/' + GINA_VERSION;` inside the gate");
    });

    it('helper returns the headers object (mutates in place, then returns)', function() {
        var fnStart = src.indexOf('var _setPoweredByHeader = function(headers) {');
        var fnEnd   = src.indexOf('};', fnStart);
        var body    = src.slice(fnStart, fnEnd);
        assert.ok(/return\s+headers\s*;/.test(body),
            'helper must end with `return headers;`');
    });

    it('helper is defined exactly once (no duplicate definitions)', function() {
        var matches = src.match(/var _setPoweredByHeader\s*=\s*function/g);
        assert.equal(matches && matches.length, 1,
            'expected exactly one _setPoweredByHeader definition; found ' + (matches ? matches.length : 0));
    });

    it('helper is defined inside onPath (after var-block, before request callback)', function() {
        var helperPos = src.indexOf('var _setPoweredByHeader = function(headers) {');
        var onPathPos = src.indexOf('const onPath = function(path, cb, allowAll)');
        var reqPos    = src.indexOf("server.on('request',", onPathPos);
        assert.ok(helperPos > onPathPos, 'helper must be defined after `const onPath = ...`');
        assert.ok(helperPos < reqPos,    "helper must be defined before `server.on('request', ...)`");
    });

    it('exactly 28 object-literal sites wrap headers via _setPoweredByHeader({', function() {
        // 16 sites through #INS9b; #INS10 added the 17th — the GET/POST
        // /_gina/instrument control handler wraps its reply headers via the
        // helper so the deny/status responses honour server.hidePoweredBy.
        // #RC (Slice 3 — cross-strategy flush) added the 18th + 19th: the POST
        // /_gina/cache/clear handler wraps BOTH its 403-deny and its 200-ok
        // reply headers via the helper, mirroring the sibling
        // /_gina/cache/stats handler, so the flush response honours
        // server.hidePoweredBy too.
        // #RWATCH added the 20th–25th: the three /_gina/release/* mirrors
        // (status / rebuild / events) each wrap their 403-deny AND their
        // success reply headers via the helper.
        // #MAINT1 added the 26th + 27th: the GET/POST /_gina/maintenance
        // control handler and the bypass-grant 302. These wrap for CROSS-ENGINE
        // PARITY rather than for leak prevention — core/server.js sets
        // X-Powered-By from its own engine-agnostic #HDR8 gate BEFORE the
        // maintenance gate runs, so the express path already honours
        // hidePoweredBy on these responses; wrapping here is what makes isaac
        // behave identically instead of silently omitting the header.
        // NOTE: the gate's own 503 path is deliberately NOT in this census — it
        // wraps lib.maintenance.responseHeaders(...), a function RESULT, not an
        // object literal, so it does not match this pattern.
        // #B384 added the 28th: the cross-origin WRITE guard that fronts the
        // whole /_gina/* family wraps its 403-deny headers via the helper, so a
        // refusal cannot leak X-Powered-By under server.hidePoweredBy. It sits
        // above every /_gina/* handler, which is why it is the first site in
        // file order rather than the last.
        var matches = src.match(/=\s*_setPoweredByHeader\(\{/g);
        assert.equal(matches && matches.length, 28,
            'expected 28 `= _setPoweredByHeader({` call sites; found ' + (matches ? matches.length : 0));
    });

    it('every named headers var that previously held X-Powered-By is now wrapped via helper', function() {
        var names = [
            'healthHeaders',
            'metricsForbiddenHeaders', 'metricsDisabledHeaders', 'metricsHeaders', 'metricsErrHeaders',
            'infoForbiddenHeaders',    'infoHeaders',
            'cacheStatsForbiddenHeaders', 'cacheStatsHeaders',
            '_jobsHeaders',
            '_inspHeaders', '_sseHeaders', '_agHeaders', '_agDenyHeaders',
            '_ixHeaders', '_rvHeaders'
        ];
        names.forEach(function(name) {
            var re = new RegExp('(?:var|const)\\s+' + name + '\\s*=\\s*_setPoweredByHeader\\(\\{');
            assert.ok(re.test(src), 'expected `' + name + ' = _setPoweredByHeader({` in source');
        });
    });

    it('source contains exactly 3 X-Powered-By mentions (1 helper comment, 1 helper body, 1 routing.json setHeader)', function() {
        var matches = src.match(/X-Powered-By/g);
        assert.equal(matches && matches.length, 3,
            'expected 3 X-Powered-By mentions; found ' + (matches ? matches.length : 0));
    });

    it('routing.json asset setHeader site wraps in an inline !options.hidePoweredBy guard', function() {
        var routingMatch = src.indexOf('\\_gina\\/assets\\/routing\\.json');
        assert.ok(routingMatch > -1, '/_gina/assets/routing.json regex anchor not found');
        // #B66 — structural ordering pin (was a fixed `slice(anchor, anchor + 1500)`
        // window; the #B66 stripped-routing branch + Cache-Control comment were
        // inserted between the anchor and the guard, pushing it past 1500). Assert the
        // guard + its guarded setHeader exist AFTER the routing.json anchor and in
        // order, with no brittle char cap — per the jsdoc.md "structural anchor, not
        // char-distance" lesson + the #B65 §617 X-Forwarded-Prefix precedent.
        var guardIdx = src.indexOf('if (!options.hidePoweredBy)', routingMatch);
        var xpbIdx   = src.indexOf("response.setHeader('X-Powered-By', 'Gina/'+ GINA_VERSION);", routingMatch);
        assert.ok(guardIdx > routingMatch,
            'routing.json asset handler must wrap response.setHeader in `if (!options.hidePoweredBy)`');
        assert.ok(xpbIdx > guardIdx,
            'routing.json asset handler must emit X-Powered-By via setHeader inside (after) the open gate');
    });

    it('helper and inline gate both read options.hidePoweredBy (exactly 2 reads)', function() {
        var matches = src.match(/options\.hidePoweredBy/g);
        assert.equal(matches && matches.length, 2,
            'expected 2 reads of options.hidePoweredBy (1 in helper, 1 in inline gate); found ' + (matches ? matches.length : 0));
    });

    it('settings.json template declares server.hidePoweredBy as boolean true (default since 0.6.23, #OW1)', function() {
        // Realigned for #OW1 (OWASP A02): the shipped default flipped false -> true
        // in 0.6.23, so the framework no longer discloses its name and exact
        // version on every response. The GATE mechanism this file pins is
        // unchanged — the helper and the inline gate still both read
        // `options.hidePoweredBy` (pinned by the sibling arm above); only the
        // shipped default moved. `false` still restores the old behaviour.
        var settingsSrc = fs.readFileSync(
            path.join(require('../fw'), 'core/template/conf/settings.json'),
            'utf8'
        );
        assert.ok(settingsSrc.indexOf('"hidePoweredBy": true') > -1,
            'settings.json template must declare `"hidePoweredBy": true` as the default (#OW1)');
    });

    it('settings.json hidePoweredBy key sits inside the top-level server.* block', function() {
        var settingsSrc = fs.readFileSync(
            path.join(require('../fw'), 'core/template/conf/settings.json'),
            'utf8'
        );
        var serverStart = settingsSrc.indexOf('"server": {');
        var serverEnd   = settingsSrc.indexOf('"upload": {');
        assert.ok(serverStart > -1 && serverEnd > -1 && serverEnd > serverStart,
            'expected server.* block to precede upload.* block in settings.json');
        var serverBlock = settingsSrc.slice(serverStart, serverEnd);
        assert.ok(serverBlock.indexOf('"hidePoweredBy"') > -1,
            'hidePoweredBy must live inside the server.* block, not at top level');
    });

    it('settings.json comment block names #HDR8 Phase 2 and the Isaac-engine writeHead context', function() {
        var settingsSrc = fs.readFileSync(
            path.join(require('../fw'), 'core/template/conf/settings.json'),
            'utf8'
        );
        var hidePos    = settingsSrc.indexOf('"hidePoweredBy"');
        var blockStart = settingsSrc.lastIndexOf('// #HDR8 Phase 2', hidePos);
        assert.ok(blockStart > -1, 'expected `// #HDR8 Phase 2` marker comment above the hidePoweredBy key');
        var commentBlock = settingsSrc.slice(blockStart, hidePos);
        assert.ok(/Isaac/.test(commentBlock),    'comment block must explain the Isaac-engine context');
        assert.ok(/writeHead/.test(commentBlock), 'comment block must explain the writeHead bypass shape');
    });

});


describe('09b - #HDR8 Phase 2 framework gate: pure logic replica', function() {

    // Inline replica of _setPoweredByHeader, parameterised by the options
    // object so we can exercise the gate without touching framework state.
    var GINA_VERSION_FIXTURE = '0.3.15-alpha.3';

    function gate(options) {
        return function _setPoweredByHeader(headers) {
            if (!options.hidePoweredBy) {
                headers['X-Powered-By'] = 'Gina/' + GINA_VERSION_FIXTURE;
            }
            return headers;
        };
    }

    it('undefined hidePoweredBy emits the header (default behaviour)', function() {
        var headers = gate({})({ 'content-type': 'application/json' });
        assert.equal(headers['X-Powered-By'], 'Gina/0.3.15-alpha.3');
    });

    it('false hidePoweredBy emits the header', function() {
        var headers = gate({ hidePoweredBy: false })({ 'content-type': 'application/json' });
        assert.equal(headers['X-Powered-By'], 'Gina/0.3.15-alpha.3');
    });

    it('true hidePoweredBy suppresses the header (key absent)', function() {
        var headers = gate({ hidePoweredBy: true })({ 'content-type': 'application/json' });
        assert.equal(typeof headers['X-Powered-By'], 'undefined');
    });

    it('truthy non-boolean (e.g. string "true") also suppresses (loose truthy check)', function() {
        var headers = gate({ hidePoweredBy: 'true' })({ 'content-type': 'application/json' });
        assert.equal(typeof headers['X-Powered-By'], 'undefined');
    });

    it('falsy non-boolean (0, "", null) emits the header', function() {
        assert.equal(gate({ hidePoweredBy: 0    })({})['X-Powered-By'], 'Gina/0.3.15-alpha.3');
        assert.equal(gate({ hidePoweredBy: ''   })({})['X-Powered-By'], 'Gina/0.3.15-alpha.3');
        assert.equal(gate({ hidePoweredBy: null })({})['X-Powered-By'], 'Gina/0.3.15-alpha.3');
    });

    it('helper mutates the input headers object in place (does not copy)', function() {
        var input  = { 'content-type': 'application/json' };
        var output = gate({})(input);
        assert.strictEqual(output, input,
            'helper must return the same object reference it received');
    });

    it('helper preserves other header keys untouched', function() {
        var headers = gate({ hidePoweredBy: true })({
            'cache-control':                'no-cache',
            'content-type':                 'application/json',
            'access-control-allow-origin':  '*'
        });
        assert.equal(headers['cache-control'],                'no-cache');
        assert.equal(headers['content-type'],                 'application/json');
        assert.equal(headers['access-control-allow-origin'],  '*');
    });

    it('helper does not corrupt unrelated X-* headers when the gate is open or closed', function() {
        var headers = gate({ hidePoweredBy: false })({
            'X-Custom-Header': 'preserved',
            'X-Request-Id':    'abc123'
        });
        assert.equal(headers['X-Custom-Header'], 'preserved');
        assert.equal(headers['X-Request-Id'],    'abc123');
        assert.equal(headers['X-Powered-By'],    'Gina/0.3.15-alpha.3');
    });

    it('repeated calls with gate=true are idempotent (header stays absent)', function() {
        var headers = {};
        gate({ hidePoweredBy: true })(headers);
        gate({ hidePoweredBy: true })(headers);
        assert.equal(typeof headers['X-Powered-By'], 'undefined');
    });

    it('repeated calls with gate=false are idempotent (key uniqueness preserved)', function() {
        var headers = {};
        gate({ hidePoweredBy: false })(headers);
        gate({ hidePoweredBy: false })(headers);
        assert.equal(headers['X-Powered-By'], 'Gina/0.3.15-alpha.3');
        var ownKeys = Object.keys(headers);
        var matchingKeys = ownKeys.filter(function(k) { return k === 'X-Powered-By'; });
        assert.equal(matchingKeys.length, 1, 'expected exactly one X-Powered-By key');
    });

    it('flip gate true → false on same headers — header appears', function() {
        var headers = {};
        gate({ hidePoweredBy: true })(headers);
        assert.equal(typeof headers['X-Powered-By'], 'undefined');
        gate({ hidePoweredBy: false })(headers);
        assert.equal(headers['X-Powered-By'], 'Gina/0.3.15-alpha.3');
    });

    it('flip gate false → true on same headers — helper does NOT delete (only adds)', function() {
        // Real framework call sites pass a fresh literal each request, so the
        // carry-over scenario doesn't arise in production. This documents the
        // helper's add-only behaviour.
        var headers = {};
        gate({ hidePoweredBy: false })(headers);
        assert.equal(headers['X-Powered-By'], 'Gina/0.3.15-alpha.3');
        gate({ hidePoweredBy: true })(headers);
        assert.equal(headers['X-Powered-By'], 'Gina/0.3.15-alpha.3',
            'gate=true does not actively remove a previously-set key');
    });

});


describe('09c - #HDR8 Phase 2 framework gate documentation cross-references', function() {

    it("plugin README's Effectiveness section references server.hidePoweredBy: true", function() {
        var readmePath = path.join(
            require('../fw'),
            'core/plugins/lib/security-headers/hide-powered-by/README.md'
        );
        var readme = fs.readFileSync(readmePath, 'utf8');
        assert.ok(readme.indexOf('server.hidePoweredBy: true') > -1,
            'README must reference `server.hidePoweredBy: true` as the Isaac-engine complement');
    });

    it('plugin README no longer says "separate slice" or "file an issue against"', function() {
        var readmePath = path.join(
            require('../fw'),
            'core/plugins/lib/security-headers/hide-powered-by/README.md'
        );
        var readme = fs.readFileSync(readmePath, 'utf8');
        assert.equal(readme.indexOf('separate slice'),         -1,
            'README must no longer call the Isaac gate a "separate slice"');
        assert.equal(readme.indexOf('file an issue against'),  -1,
            'README must no longer ask users to file an issue for the Isaac gate');
    });

    it('plugin main.js JSDoc references server.hidePoweredBy', function() {
        var mainPath = path.join(
            require('../fw'),
            'core/plugins/lib/security-headers/hide-powered-by/src/main.js'
        );
        var mainSrc = fs.readFileSync(mainPath, 'utf8');
        var docEnd  = mainSrc.indexOf('var HEADER_NAME');
        var doc     = mainSrc.slice(0, docEnd);
        assert.ok(doc.indexOf('server.hidePoweredBy') > -1,
            'main.js JSDoc must reference `server.hidePoweredBy` as the Isaac complement');
    });

    it('plugin main.js JSDoc no longer says "separate framework-level settings-flag slice"', function() {
        var mainPath = path.join(
            require('../fw'),
            'core/plugins/lib/security-headers/hide-powered-by/src/main.js'
        );
        var mainSrc = fs.readFileSync(mainPath, 'utf8');
        assert.equal(mainSrc.indexOf('separate framework-level settings-flag slice'), -1,
            'main.js JSDoc must no longer describe the gate as a separate slice');
    });

    it('README failure-modes table documents both Isaac states (flag off and flag on)', function() {
        var readmePath = path.join(
            require('../fw'),
            'core/plugins/lib/security-headers/hide-powered-by/README.md'
        );
        var readme = fs.readFileSync(readmePath, 'utf8');
        assert.ok(readme.indexOf('Isaac engine (no `server.hidePoweredBy` flag)') > -1,
            'failure-modes table must document Isaac without the flag');
        assert.ok(readme.indexOf('Isaac engine + `server.hidePoweredBy: true`') > -1,
            'failure-modes table must document Isaac with the flag enabled');
    });

});


// ─────────────────────────────────────────────────────────────────────────
// 10 — /_gina/jobs/:id async-job status endpoint (#AI6 slice 3)
// ─────────────────────────────────────────────────────────────────────────
//
// Always-on, state-only status endpoint. The Isaac handler (this SOURCE) is
// the HTTP/2 fast-path; server.js carries the engine-agnostic mirror per the
// framework's "/_gina/* built-in endpoint sync" rule. Both project the record
// through lib.job.toStatusView so result / error payloads never reach the
// public polling surface.

describe('10 - /_gina/jobs/:id status endpoint source structure (#AI6 slice 3)', function() {

    var isaacSrc  = fs.readFileSync(SOURCE, 'utf8');
    var serverSrc = fs.readFileSync(path.join(require('../fw'), 'core/server.js'), 'utf8');

    it('Isaac source defines a /_gina/jobs/:id GET handler with the #AI6 marker', function() {
        assert.ok(isaacSrc.indexOf('_gina\\/jobs\\/([A-Za-z0-9_-]+)') > -1, 'jobs route regex missing from Isaac');
        assert.ok(isaacSrc.indexOf('#AI6') > -1, '#AI6 marker missing from Isaac');
    });

    it('Isaac handler is state-only (toStatusView, never reads .result)', function() {
        var at    = isaacSrc.indexOf('_gina\\/jobs\\/([A-Za-z0-9_-]+)');
        var end   = isaacSrc.indexOf('Inspector SPA', at);
        var block = isaacSrc.slice(at, end);
        assert.ok(block.indexOf('lib.job.toStatusView') > -1, 'must project via toStatusView');
        assert.ok(block.indexOf('.result') === -1, 'handler must NOT read the result payload (state-only)');
    });

    it('Isaac handler 404s an unknown id and uses the dual HTTP/2 + HTTP/1.1 shape', function() {
        var at    = isaacSrc.indexOf('_gina\\/jobs\\/([A-Za-z0-9_-]+)');
        var end   = isaacSrc.indexOf('Inspector SPA', at);
        var block = isaacSrc.slice(at, end);
        assert.ok(block.indexOf("'not_found'") > -1,           'must return not_found for unknown id');
        assert.ok(block.indexOf('response.stream.respond') > -1, 'HTTP/2 stream path present');
        assert.ok(block.indexOf('response.writeHead') > -1,      'HTTP/1.1 fallback path present');
    });

    it('server.js carries the engine-agnostic mirror (/_gina/* sync rule)', function() {
        assert.ok(serverSrc.indexOf('_gina\\/jobs\\/([A-Za-z0-9_-]+)') > -1, 'jobs route regex missing from server.js');
        var at    = serverSrc.indexOf('_gina\\/jobs\\/([A-Za-z0-9_-]+)');
        var end   = serverSrc.indexOf('Inspector SPA', at);
        var block = serverSrc.slice(at, end);
        assert.ok(block.indexOf('lib.job.toStatusView') > -1, 'server.js handler must project via toStatusView');
        assert.ok(block.indexOf("'not_found'") > -1,          'server.js handler must 404 unknown id');
        assert.ok(block.indexOf('.result') === -1,            'server.js handler must be state-only');
    });
});


describe('10b - /_gina/jobs/:id handler logic: pure replica (#AI6)', function() {

    var job = require(path.join(require('../fw'), 'lib/job/src/main'));

    // Replica of the per-engine handler decision (status + body), using the
    // REAL toStatusView so the state-only guarantee is actually exercised.
    function handleJob(rec, jobId) {
        if (!rec) {
            return { status: 404, body: { error: 'not_found', message: '/_gina/jobs/' + jobId + ': unknown job id' } };
        }
        return { status: 200, body: job.toStatusView(rec) };
    }

    it('404s an unknown id with a not_found body naming the id', function() {
        var out = handleJob(null, 'ABC');
        assert.equal(out.status, 404);
        assert.equal(out.body.error, 'not_found');
        assert.ok(out.body.message.indexOf('ABC') > -1);
    });

    it('200s a known job with a state-only body (no result / error / callbackUrl leak)', function() {
        var rec = {
            id: 'XYZ', state: 'completed', createdAt: 1, updatedAt: 2,
            result: 'SECRET', error: { message: 'oops' }, callbackUrl: 'https://x/y'
        };
        var out = handleJob(rec, 'XYZ');
        assert.equal(out.status, 200);
        assert.deepEqual(out.body, { id: 'XYZ', state: 'completed', createdAt: 1, updatedAt: 2 });
        assert.ok(!('result' in out.body),      'result must not leak to the status endpoint');
        assert.ok(!('error'  in out.body),      'error must not leak to the status endpoint');
        assert.ok(!('callbackUrl' in out.body), 'callbackUrl must not leak to the status endpoint');
    });

    it('reflects whatever lifecycle state the record carries', function() {
        ['pending', 'running', 'failed'].forEach(function(st) {
            var out = handleJob({ id: 'i', state: st, createdAt: 1, updatedAt: 2 }, 'i');
            assert.equal(out.status, 200);
            assert.equal(out.body.state, st);
        });
    });

    it('the route regex captures a valid id and rejects traversal / empty id', function() {
        var re = /\/_gina\/jobs\/([A-Za-z0-9_-]+)\/?(\?.*)?$/;
        assert.equal('/_gina/jobs/AbC123_-'.match(re)[1], 'AbC123_-');
        assert.equal('/_gina/jobs/AbC123?x=1'.match(re)[1], 'AbC123', 'ignores query string');
        assert.equal('/sub/_gina/jobs/AbC123'.match(re)[1], 'AbC123', 'matches under a webroot prefix');
        assert.equal('/_gina/jobs/../etc'.match(re), null, 'rejects path traversal');
        assert.equal('/_gina/jobs/'.match(re), null, 'rejects empty id');
    });
});


// 10 — URL query string parsing: malformed-% crash-safety (#B30)
//
// The isaac URL query parser percent-decodes each value (a[1]) when it contains
// a '%'. A bare decodeURIComponent throws URIError on a malformed escape (e.g.
// GET /?x=%) which — with no uncaughtException handler — crashes the bundle.
// #B30 routes both branches (the multi-value &-loop and the single-key path)
// through safeDecodeURIComponent, which falls back to the raw value.
describe('10 - URL query string parsing: malformed-% crash-safety (#B30)', function() {

    var srcLocal;
    function getSrc() {
        if (!srcLocal) srcLocal = fs.readFileSync(SOURCE, 'utf8');
        return srcLocal;
    }

    it('both query-value decode sites use safeDecodeURIComponent(a[1])', function() {
        var hits = getSrc().match(/safeDecodeURIComponent\(a\[1\]\)/g) || [];
        assert.strictEqual(hits.length, 2, 'multi-value &-loop + single-key branch both safe-decode a[1]');
    });

    it('no BARE decodeURIComponent(a[1]) remains (only the safe wrapper)', function() {
        // negative lookbehind: a "safe"-prefixed call is fine; a bare one is the bug
        assert.doesNotMatch(getSrc(), /(?<![A-Za-z])decodeURIComponent\(a\[1\]\)/,
            'a bare (unguarded) decodeURIComponent(a[1]) would crash the bundle on a malformed %');
    });

    // Pure-logic replica of the two parser branches AFTER #B30, mirroring the
    // source (safe-decode + the same +→space and boolean-coercion steps).
    function safeDec(str) { try { return decodeURIComponent(str); } catch (e) { return str; } }
    function parseQueryAfterFix(qs) {
        var query = {}, a;
        if (qs.indexOf('&') > -1) {
            qs.split('&').forEach(function(pair) {
                a = pair.split('=');
                var low = a[1] && a[1].toLowerCase();
                if (low === 'false' || low === 'true' || low === 'on') {
                    a[1] = (low === 'true' || low === 'on');
                } else if (a[1] && (a[1].indexOf('+') > -1 || a[1].indexOf('%') > -1)) {
                    if (a[1].indexOf('+') > -1) a[1] = a[1].replace(/\+/g, ' ');
                    if (a[1].indexOf('%') > -1) a[1] = safeDec(a[1]);
                }
                query[a[0]] = a[1];
            });
        } else {
            a = qs.split('=');
            if (a.length > 1) {
                if (a[1] && (a[1].indexOf('+') > -1 || a[1].indexOf('%') > -1)) {
                    if (a[1].indexOf('+') > -1) a[1] = a[1].replace(/\+/g, ' ');
                    if (a[1].indexOf('%') > -1) a[1] = safeDec(a[1]);
                }
                query[a[0]] = a[1];
            }
        }
        return query;
    }

    it('single-key malformed %: ?x=% does NOT throw and falls back to raw "%"', function() {
        var q;
        assert.doesNotThrow(function() { q = parseQueryAfterFix('x=%'); });
        assert.strictEqual(q.x, '%');
    });

    it('multi-value malformed %: ?x=%&y=ok does NOT throw; y decodes, x falls back', function() {
        var q;
        assert.doesNotThrow(function() { q = parseQueryAfterFix('x=%&y=ok'); });
        assert.strictEqual(q.x, '%');
        assert.strictEqual(q.y, 'ok');
    });

    it('valid escape still decodes: ?x=a%20b → "a b"', function() {
        assert.strictEqual(parseQueryAfterFix('x=a%20b').x, 'a b');
    });

    // Subtract: the pre-#B30 bare decode throws URIError on the same malformed input.
    it('subtract: a bare decodeURIComponent(a[1]) would throw URIError on ?x=%', function() {
        assert.throws(function() {
            var a = 'x=%'.split('=');
            if (a[1].indexOf('%') > -1) a[1] = decodeURIComponent(a[1]); // pre-fix shape
        }, URIError);
    });
});


// 11 — #H13 RFC 8441 extended CONNECT enablement (source structure)
// Strict boolean opt-in (settings.json http2Options.enableConnectProtocol),
// compat-level `connect` listener with an HTTP-status refusal table, internal
// `_extendedConnectHandler` hook, and an `extendedConnect` /_gina/info metric.
describe('11 - #H13 extended CONNECT enablement source structure', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it('source resolves the opt-in with a strict `=== true` check', function() {
        assert.ok(
            getSrc().indexOf('_h2Opts.enableConnectProtocol === true') > -1,
            'expected `_h2Opts.enableConnectProtocol === true` — strict boolean opt-in'
        );
    });

    it('source never falls back with `||` for enableConnectProtocol (boolean, not numeric idiom)', function() {
        assert.doesNotMatch(
            getSrc(),
            /_h2Opts\.enableConnectProtocol\s*\|\|/,
            'a `|| <default>` fallback would coerce truthy non-booleans (e.g. the string "true") into enabling the feature'
        );
    });

    it('source carries enableConnectProtocol in the http2 settings literal', function() {
        assert.ok(
            getSrc().indexOf('enableConnectProtocol : _enableConnectProtocol') > -1,
            'expected `enableConnectProtocol : _enableConnectProtocol` inside http2Options.settings'
        );
    });

    it('source registers the connect listener ONLY inside the opt-in gate', function() {
        assert.match(
            getSrc(),
            /if \(_enableConnectProtocol\) \{\s*server\.on\('connect'/,
            'expected `server.on(\'connect\', ...)` immediately inside `if (_enableConnectProtocol) {` — when the flag is off no listener may exist (the compat default 405 must be preserved byte-identically)'
        );
    });

    it('source reads the RFC 8441 :protocol pseudo-header off the request', function() {
        assert.ok(
            getSrc().indexOf("request.headers[':protocol']") > -1,
            "expected a `request.headers[':protocol']` read in the connect handler"
        );
    });

    it('source guards the HTTP/1.1 CONNECT signature (no request.stream) with a raw-socket refusal', function() {
        var s = getSrc();
        assert.ok(s.indexOf('if (!request.stream)') > -1, 'expected the `!request.stream` h1-signature guard');
        assert.ok(
            s.indexOf("'HTTP/1.1 405 Method Not Allowed\\r\\nConnection: close\\r\\n\\r\\n'") > -1,
            'expected the raw HTTP/1.1 405 status line written to the socket'
        );
    });

    it('source mirrors the compat default for plain HTTP/2 CONNECT: writeHead(405)', function() {
        assert.ok(
            getSrc().indexOf('response.writeHead(405)') > -1,
            'expected `response.writeHead(405)` for plain CONNECT (no :protocol) — byte-parity with the engine default'
        );
    });

    it('source refuses non-websocket :protocol values with 501', function() {
        var s = getSrc();
        assert.ok(s.indexOf("_protocol !== 'websocket'") > -1, 'expected the `:protocol !== websocket` check');
        assert.ok(s.indexOf('response.writeHead(501)') > -1, 'expected `response.writeHead(501)` refusals');
    });

    it('source hands accepted websocket streams to a typeof-guarded internal hook', function() {
        assert.ok(
            getSrc().indexOf("typeof server._extendedConnectHandler === 'function'") > -1,
            'expected the typeof-guarded `server._extendedConnectHandler` hook (the WS session bridge consumer)'
        );
    });

    it('source increments the extendedConnect metric for :protocol-bearing streams', function() {
        assert.ok(
            getSrc().indexOf('_h2Metrics.extendedConnect++') > -1,
            'expected `_h2Metrics.extendedConnect++`'
        );
    });

    it('source declares extendedConnect in the metrics literal and the /_gina/info http2 payload', function() {
        var s = getSrc();
        assert.ok(s.indexOf('extendedConnect : 0') > -1, 'expected `extendedConnect : 0` in the _h2Metrics literal');
        assert.ok(
            s.indexOf('extendedConnect : server._h2Metrics.extendedConnect') > -1,
            'expected `extendedConnect` in the /_gina/info http2 block'
        );
    });

    it('source contains the CONNECT-path error containment (close, never crash)', function() {
        var s = getSrc();
        var connectIdx = s.indexOf("server.on('connect'");
        assert.ok(connectIdx > -1, 'connect listener must exist');
        var closeIdx = s.indexOf('http2.constants.NGHTTP2_INTERNAL_ERROR', connectIdx);
        assert.ok(closeIdx > -1, 'expected a `stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)` fallback in the connect handler catch');
    });

    it('#H9 composition: the per-session stream accounting stays CONNECT-agnostic', function() {
        var s = getSrc();
        var streamIdx = s.indexOf("session.on('stream'");
        var goawayIdx = s.indexOf("session.on('goaway'");
        assert.ok(streamIdx > -1 && goawayIdx > streamIdx, 'session stream + goaway listeners must exist in order');
        var block = s.slice(streamIdx, goawayIdx);
        assert.ok(
            block.indexOf(':protocol') === -1,
            'the #H9 stream-accounting handler must not grow CONNECT detection — every CONNECT stream keeps counting in the rapid-reset window, detection lives on the compat connect event'
        );
    });

    it('both settings templates document the enableConnectProtocol key', function() {
        var confTemplate = fs.readFileSync(
            path.join(require('../fw'), 'core/template/conf/settings.json'), 'utf8'
        );
        var boilerplate = fs.readFileSync(
            path.join(require('../fw'), 'core/template/boilerplate/bundle/config/settings.server.json'), 'utf8'
        );
        assert.ok(
            confTemplate.indexOf('"enableConnectProtocol": false') > -1,
            'expected `"enableConnectProtocol": false` in the conf settings.json http2Options block'
        );
        assert.ok(
            boilerplate.indexOf('"enableConnectProtocol": false') > -1,
            'expected the commented `"enableConnectProtocol": false` example in the settings.server.json boilerplate'
        );
    });

});


// 11b — #H13 extended CONNECT: pure-logic replica of the opt-in resolve +
// the connect-listener decision table (mirrors the source line-for-line so
// the §11 pins lock the operators against drift).
describe('11b - #H13 extended CONNECT: opt-in resolve + dispatch logic', function() {

    // Replica of the #H13 strict opt-in resolve in server.isaac.js
    function resolveEnableConnectProtocol(optionsHttp2Options) {
        var _h2Opts = (optionsHttp2Options && typeof optionsHttp2Options === 'object') ? optionsHttp2Options : {};
        return _h2Opts.enableConnectProtocol === true;
    }

    // Replica of the #H13 `connect` listener decision table. Returns the
    // terminal action; mutates `metrics` exactly like the source.
    function onConnect(hasStream, headers, hasHandler, metrics) {
        if (!hasStream) {
            // HTTP/1.1 CONNECT signature — raw 405 + socket destroy
            return { action: 'h1-refuse-and-close', status: 405 };
        }
        var _protocol = headers[':protocol'];
        if (typeof _protocol === 'undefined') {
            return { action: 'respond', status: 405 };
        }
        metrics.extendedConnect++;
        if (_protocol !== 'websocket') {
            return { action: 'respond', status: 501 };
        }
        if (hasHandler) {
            return { action: 'handoff' };
        }
        return { action: 'respond', status: 501 };
    }

    it('opt-in defaults to false when http2Options is absent, empty, or not an object', function() {
        assert.equal(resolveEnableConnectProtocol(undefined), false);
        assert.equal(resolveEnableConnectProtocol({}), false);
        assert.equal(resolveEnableConnectProtocol(null), false);
        assert.equal(resolveEnableConnectProtocol('yes'), false);
    });

    it('opt-in enables only for the boolean true', function() {
        assert.equal(resolveEnableConnectProtocol({ enableConnectProtocol: true }), true);
    });

    it('strictness subtract: truthy non-booleans do NOT enable (=== true vs the || idiom)', function() {
        // The sibling numeric options use `_h2Opts.X || <default>`; that idiom
        // applied here would let the string "true" or the number 1 flip a
        // SETTINGS advert on. The strict === keeps them off.
        assert.equal(resolveEnableConnectProtocol({ enableConnectProtocol: 'true' }), false);
        assert.equal(resolveEnableConnectProtocol({ enableConnectProtocol: 1 }), false);
        assert.equal(resolveEnableConnectProtocol({ enableConnectProtocol: {} }), false);
        // contrast: the || idiom would have enabled all three
        assert.ok(('true' || false) && (1 || false));
    });

    it('HTTP/1.1 CONNECT signature (no stream) is refused on the raw socket, uncounted', function() {
        var m = { extendedConnect: 0 };
        var r = onConnect(false, {}, false, m);
        assert.equal(r.action, 'h1-refuse-and-close');
        assert.equal(r.status, 405);
        assert.equal(m.extendedConnect, 0);
    });

    it('plain HTTP/2 CONNECT (no :protocol) gets 405 and is NOT counted as extended', function() {
        var m = { extendedConnect: 0 };
        var r = onConnect(true, { ':method': 'CONNECT' }, false, m);
        assert.equal(r.action, 'respond');
        assert.equal(r.status, 405);
        assert.equal(m.extendedConnect, 0);
    });

    it('a non-websocket :protocol is counted, then refused with 501', function() {
        var m = { extendedConnect: 0 };
        var r = onConnect(true, { ':protocol': 'webtransport' }, false, m);
        assert.equal(r.action, 'respond');
        assert.equal(r.status, 501);
        assert.equal(m.extendedConnect, 1);
    });

    it('websocket with no registered consumer is counted, then refused with 501', function() {
        var m = { extendedConnect: 0 };
        var r = onConnect(true, { ':protocol': 'websocket' }, false, m);
        assert.equal(r.action, 'respond');
        assert.equal(r.status, 501);
        assert.equal(m.extendedConnect, 1);
    });

    it('websocket with a registered consumer hands the stream off', function() {
        var m = { extendedConnect: 0 };
        var r = onConnect(true, { ':protocol': 'websocket' }, true, m);
        assert.equal(r.action, 'handoff');
        assert.equal(m.extendedConnect, 1);
    });

    it('the extendedConnect metric accumulates across streams', function() {
        var m = { extendedConnect: 0 };
        onConnect(true, { ':protocol': 'websocket' }, true, m);
        onConnect(true, { ':protocol': 'foo' }, true, m);
        onConnect(true, { ':method': 'CONNECT' }, true, m); // plain — uncounted
        onConnect(true, { ':protocol': 'websocket' }, false, m);
        assert.equal(m.extendedConnect, 3);
    });

});


// 12 — #H13 onWebSocket registration API + dispatcher (source structure)
// Public bundle surface: app.onWebSocket(path, handler) from onInitialize.
// The dispatcher installs LAZILY on the first registration so the §11
// refusal table (501 for unclaimed websocket streams) holds until a
// consumer exists.
describe('12 - #H13 onWebSocket registration + dispatcher source structure', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it('source declares the per-path handler registry and the registration method', function() {
        var s = getSrc();
        assert.ok(s.indexOf('server._wsHandlers = {};') > -1, 'expected the `server._wsHandlers` registry literal');
        assert.ok(s.indexOf('server.onWebSocket = function(wsPath, wsHandler, wsOptions)') > -1, 'expected the onWebSocket registration method (slice 3a adds the optional wsOptions arg)');
        assert.ok(s.indexOf('server._wsHandlers[wsPath] = wsHandler;') > -1, 'expected the per-path handler store');
    });

    it('source validates registration arguments at call time (throw, not warn)', function() {
        assert.ok(
            getSrc().indexOf('onWebSocket(path, handler) requires a non-empty path string and a handler function') > -1,
            'expected the factory-call-time TypeError message'
        );
    });

    it('source installs the dispatcher LAZILY — only when no hook exists yet', function() {
        assert.ok(
            getSrc().indexOf("typeof server._extendedConnectHandler !== 'function'") > -1,
            'expected the lazy-install guard so the §11 501-unclaimed behaviour holds with zero registrations'
        );
    });

    it('source matches on the :path pathname with the query string stripped', function() {
        assert.ok(
            getSrc().indexOf(".split('?')[0]") > -1,
            'expected the query-string strip before the handler lookup'
        );
    });

    it('source refuses an unregistered pathname with 404', function() {
        assert.ok(
            getSrc().indexOf('response.writeHead(404)') > -1,
            'expected `response.writeHead(404)` for a pathname with no registered handler'
        );
    });

    it('source accepts matched streams through the ws-session bridge', function() {
        assert.ok(
            getSrc().indexOf('lib.wsSession.accept(request, _wsOpts || undefined)') > -1,
            'expected `lib.wsSession.accept(request, _wsOpts || undefined)` on the matched path (slice 3a threads per-route options)'
        );
    });

    it('the registration API lives inside the opt-in gate, the safety stub after both branches', function() {
        var s = getSrc();
        var gateIdx = s.indexOf('if (_enableConnectProtocol) {');
        var defIdx = s.indexOf('server.onWebSocket = function(wsPath, wsHandler, wsOptions)');
        var stubIdx = s.indexOf("typeof server.onWebSocket !== 'function'");
        assert.ok(gateIdx > -1 && defIdx > gateIdx, 'the real onWebSocket must be defined inside the opt-in gate');
        assert.ok(stubIdx > defIdx, 'the cross-protocol stub must come after the gated definition');
        assert.ok(s.indexOf('onWebSocket() ignored') > -1, 'expected the stub warn message');
    });

    it('lib/index.js registers the ws-session bridge on the registry', function() {
        var libIndex = fs.readFileSync(
            path.join(require('../fw'), 'lib/index.js'), 'utf8'
        );
        assert.match(libIndex, /wsSession\s*:\s*_require\('\.\/ws-session'\)/, 'expected the lib.wsSession registration');
        assert.match(libIndex, /wsFraming\s*:\s*_require\('\.\/ws-framing'\)/, 'expected the lib.wsFraming registration');
    });

});


// 12b — #H13 dispatcher pure-logic replica
describe('12b - #H13 onWebSocket dispatcher logic', function() {

    // Replica of the lazy dispatcher installed by onWebSocket
    function dispatchWs(reqPath, handlers) {
        var _wsPathname = String(reqPath || '').split('?')[0];
        var _wsTarget = handlers[_wsPathname];
        if (typeof _wsTarget !== 'function') {
            return { action: 'status', code: 404 };
        }
        return { action: 'accept', handler: _wsTarget };
    }

    var handler = function() {};

    it('an exact pathname match accepts and hands off to the registered handler', function() {
        var r = dispatchWs('/live', { '/live': handler });
        assert.equal(r.action, 'accept');
        assert.equal(r.handler, handler);
    });

    it('the query string is stripped before matching', function() {
        var r = dispatchWs('/live?token=abc&x=1', { '/live': handler });
        assert.equal(r.action, 'accept');
    });

    it('an unregistered pathname is refused with 404', function() {
        assert.deepEqual(dispatchWs('/other', { '/live': handler }), { action: 'status', code: 404 });
    });

    it('no prefix or pattern matching — /live/sub does not match /live', function() {
        assert.equal(dispatchWs('/live/sub', { '/live': handler }).code, 404);
    });

    it('a missing :path is refused, not crashed on', function() {
        assert.equal(dispatchWs(undefined, { '/live': handler }).code, 404);
    });

});


describe('12c - #H13 onWebSocket collision warn (programmatic overrides a declared ws route)', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it('onWebSocket warns before overwriting an already-registered path', function() {
        var s        = getSrc();
        var warnIdx  = s.indexOf("console.warn('[ SERVER ] onWebSocket: path");
        assert.ok(warnIdx > -1, 'expected the overwrite console.warn in onWebSocket');
        var guardIdx = s.lastIndexOf("typeof server._wsHandlers[wsPath] === 'function'", warnIdx);
        assert.ok(guardIdx > -1 && guardIdx < warnIdx,
            'the warn must be gated on wsPath already holding a function handler');
        var storeIdx = s.indexOf('server._wsHandlers[wsPath] = wsHandler;', warnIdx);
        assert.ok(storeIdx > warnIdx,
            'the collision check must run before the (unchanged) per-path store (last-write-wins)');
    });
});


// 12d — #H13 slice 2: :param matcher source structure
describe('12d - #H13 slice 2 :param matcher source structure', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it('declares the ordered param-pattern registry and the matcher', function() {
        var s = getSrc();
        assert.ok(s.indexOf('server._wsParamHandlers = [];') > -1, 'expected the `server._wsParamHandlers` ordered registry');
        assert.ok(s.indexOf('server._wsMatchParam = function(pathname)') > -1, 'expected the `_wsMatchParam` matcher');
    });

    it('routes a `:`-bearing path to the param registry (the /\\:/ placeholder convention)', function() {
        var s = getSrc();
        assert.ok(s.indexOf('/\\:/.test(wsPath)') > -1, 'expected the /\\:/ placeholder detection at registration (same as lib/routing hasParams)');
        assert.ok(s.indexOf("server._wsParamHandlers.push({ pattern: wsPath, segments: wsPath.split('/'), handler: wsHandler, options: wsOptions || null })") > -1,
            'expected the compile-and-push of {pattern, segments, handler, options}');
    });

    it('the dispatcher tries the exact map FIRST, then the param scan (exact wins)', function() {
        var s = getSrc();
        var exactIdx = s.indexOf('var _wsTarget = server._wsHandlers[_wsPathname];');
        var paramIdx = s.indexOf('server._wsMatchParam(_wsPathname)');
        assert.ok(exactIdx > -1 && paramIdx > exactIdx, 'the exact lookup must precede the param fallback');
    });

    it('the param fallback runs only on an exact miss', function() {
        assert.ok(getSrc().indexOf("typeof _wsTarget !== 'function' && server._wsParamHandlers.length") > -1,
            'expected the param scan gated on an exact miss');
    });

    it('populates request.params before handing off to lib.wsSession.accept', function() {
        var s = getSrc();
        var paramsIdx = s.indexOf('request.params = _wsParams || {};');
        var acceptIdx = s.indexOf('lib.wsSession.accept(request, _wsOpts || undefined)', paramsIdx);
        assert.ok(paramsIdx > -1 && acceptIdx > paramsIdx, 'request.params must be set before accept()');
    });

    it('the matcher decodeURIComponent-captures and rejects an empty segment', function() {
        var s = getSrc();
        assert.ok(s.indexOf('decodeURIComponent(reqSegs[s])') > -1, 'expected decodeURIComponent on the captured segment');
        assert.ok(s.indexOf("if (reqSegs[s] === '') { ok = false; break; }") > -1, 'expected the empty-segment rejection');
    });

    it('warns + overwrites on a duplicate param pattern (last wins for identical patterns)', function() {
        assert.ok(getSrc().indexOf("console.warn('[ SERVER ] onWebSocket: pattern") > -1,
            'expected the duplicate-pattern overwrite warn (distinct from the exact-path warn)');
    });
});


// 12e — #H13 slice 2: :param matcher + exact-first dispatch pure-logic replica.
// Faithful replica of server._wsMatchParam + the exact-first dispatch; the §12d
// source pins lock the operators so this replica cannot silently drift.
describe('12e - #H13 slice 2 :param matcher + exact-first dispatch logic', function() {

    function compile(pattern) { return { pattern: pattern, segments: pattern.split('/') }; }

    function matchParam(pathname, paramHandlers) {
        var reqSegs = String(pathname || '').split('/');
        for (var i = 0; i < paramHandlers.length; i++) {
            var entry = paramHandlers[i];
            if (entry.segments.length !== reqSegs.length) { continue; }
            var params = {}, ok = true;
            for (var s = 0; s < entry.segments.length; s++) {
                var pat = entry.segments[s];
                if (pat.charAt(0) === ':') {
                    if (reqSegs[s] === '') { ok = false; break; }
                    params[pat.substring(1)] = decodeURIComponent(reqSegs[s]);
                } else if (pat !== reqSegs[s]) { ok = false; break; }
            }
            if (ok) { return { handler: entry.handler, params: params }; }
        }
        return null;
    }

    function dispatch(reqPath, exact, paramHandlers) {
        var pathname = String(reqPath || '').split('?')[0];
        var target = exact[pathname];
        var params = null;
        if (typeof target !== 'function' && paramHandlers.length) {
            var m = matchParam(pathname, paramHandlers);
            if (m) { target = m.handler; params = m.params; }
        }
        if (typeof target !== 'function') { return { action: 'status', code: 404 }; }
        return { action: 'accept', handler: target, params: params || {} };
    }

    var hExact = function exactH() {};
    var hRoom  = function roomH() {};
    var hArea  = function areaH() {};

    it('captures a :param segment into request.params', function() {
        var ph = [Object.assign(compile('/live/:room'), { handler: hRoom })];
        var r = dispatch('/live/foo', {}, ph);
        assert.equal(r.action, 'accept');
        assert.equal(r.handler, hRoom);
        assert.deepEqual(r.params, { room: 'foo' });
    });

    it('an exact route beats an overlapping :param pattern (and yields empty params)', function() {
        var ph = [Object.assign(compile('/live/:room'), { handler: hRoom })];
        var r = dispatch('/live/all', { '/live/all': hExact }, ph);
        assert.equal(r.handler, hExact);
        assert.deepEqual(r.params, {});
    });

    it('strict segment-count gate — /live and /live/a/b do not match /live/:room', function() {
        var ph = [Object.assign(compile('/live/:room'), { handler: hRoom })];
        assert.equal(dispatch('/live', {}, ph).code, 404);
        assert.equal(dispatch('/live/a/b', {}, ph).code, 404);
    });

    it('first-registered wins among two overlapping equal-length :param patterns', function() {
        var ph = [
            Object.assign(compile('/live/:room'), { handler: hRoom }),
            Object.assign(compile('/:area/:room'), { handler: hArea })
        ];
        var r = dispatch('/live/foo', {}, ph);
        assert.equal(r.handler, hRoom, 'the first-declared pattern wins (mirrors gina HTTP first-match)');
        assert.deepEqual(r.params, { room: 'foo' });
    });

    it('query string is stripped before param matching', function() {
        var ph = [Object.assign(compile('/live/:room'), { handler: hRoom })];
        var r = dispatch('/live/foo?token=x', {}, ph);
        assert.equal(r.action, 'accept');
        assert.deepEqual(r.params, { room: 'foo' });
    });

    it('an empty captured segment is rejected (/live/ vs /live/:room)', function() {
        var ph = [Object.assign(compile('/live/:room'), { handler: hRoom })];
        assert.equal(dispatch('/live/', {}, ph).code, 404);
    });

    it('captured values are decodeURIComponent-decoded', function() {
        var ph = [Object.assign(compile('/live/:room'), { handler: hRoom })];
        assert.deepEqual(dispatch('/live/a%20b', {}, ph).params, { room: 'a b' });
    });

    it('multi-segment capture (/room/:id/user/:uid)', function() {
        var ph = [Object.assign(compile('/room/:id/user/:uid'), { handler: hRoom })];
        assert.deepEqual(dispatch('/room/7/user/42', {}, ph).params, { id: '7', uid: '42' });
    });

    it('an exact match path yields params === {} (never undefined)', function() {
        var r = dispatch('/live', { '/live': hExact }, []);
        assert.equal(r.handler, hExact);
        assert.deepEqual(r.params, {});
    });

    it('a missing :path is refused, not crashed on', function() {
        assert.equal(dispatch(undefined, { '/live': hExact }, []).code, 404);
    });

    it('no handler at all (exact miss + param miss) → 404', function() {
        var ph = [Object.assign(compile('/live/:room'), { handler: hRoom })];
        assert.equal(dispatch('/other', {}, ph).code, 404);
    });
});


// 12f — #H13 slice 3a: per-route wsOptions threading (source structure)
describe('12f - #H13 slice 3a per-route wsOptions threading source structure', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it('declares the parallel exact-path options map, separate from _wsHandlers', function() {
        var s = getSrc();
        assert.ok(s.indexOf('server._wsHandlerOptions = {};') > -1, 'expected the `server._wsHandlerOptions` map literal');
        assert.ok(s.indexOf('server._wsHandlers = {};') > -1, '`server._wsHandlers` must stay a pure path→handler map');
    });

    it('onWebSocket takes the optional 3rd wsOptions arg and stores it on the exact map', function() {
        var s = getSrc();
        assert.ok(s.indexOf('server.onWebSocket = function(wsPath, wsHandler, wsOptions)') > -1, 'expected the 3-arg onWebSocket signature');
        assert.ok(s.indexOf('server._wsHandlerOptions[wsPath] = wsOptions || null;') > -1, 'expected the exact-path options store');
    });

    it('the :param push carries an options field; the matcher returns it', function() {
        var s = getSrc();
        assert.ok(s.indexOf("handler: wsHandler, options: wsOptions || null })") > -1, 'expected the param-entry options field at push');
        assert.ok(s.indexOf('return { handler: entry.handler, params: params, options: entry.options };') > -1, 'expected _wsMatchParam to return the matched entry options');
    });

    it('a :param overwrite replaces options too (last-write-wins)', function() {
        assert.ok(getSrc().indexOf('server._wsParamHandlers[_existing].options = wsOptions || null;') > -1,
            'expected the param-overwrite to replace options alongside the handler');
    });

    it('the dispatcher resolves _wsOpts (exact map first, then the param entry) and threads it to accept', function() {
        var s = getSrc();
        var exactIdx  = s.indexOf('server._wsHandlerOptions[_wsPathname] || null;');
        var paramIdx  = s.indexOf('_wsOpts = _m.options || null;');
        var acceptIdx = s.indexOf('lib.wsSession.accept(request, _wsOpts || undefined);');
        assert.ok(exactIdx > -1, 'expected the exact-hit options resolution from the options map');
        assert.ok(paramIdx > exactIdx, 'expected the param-hit options override after the exact resolution');
        assert.ok(acceptIdx > paramIdx, 'expected accept(request, _wsOpts || undefined) after _wsOpts is resolved');
    });
});


// 12g — #H13 slice 3a: wsOptions resolution pure-logic replica (exact-first,
// then the matched :param entry's options; undefined when a route declares none).
// Additive — §12e stays byte-identical; the §12f source pins lock the operators.
describe('12g - #H13 slice 3a wsOptions resolution logic', function() {

    function matchParam(pathname, paramHandlers) {
        var reqSegs = String(pathname || '').split('/');
        for (var i = 0; i < paramHandlers.length; i++) {
            var entry = paramHandlers[i];
            var segs  = entry.pattern.split('/');
            if (segs.length !== reqSegs.length) { continue; }
            var ok = true;
            for (var s = 0; s < segs.length; s++) {
                if (segs[s].charAt(0) === ':') { if (reqSegs[s] === '') { ok = false; break; } }
                else if (segs[s] !== reqSegs[s]) { ok = false; break; }
            }
            if (ok) { return entry; }
        }
        return null;
    }

    // Mirrors _extendedConnectHandler's _wsOpts resolution + the accept() arg.
    function resolveAcceptArg(reqPath, exactHandlers, exactOptions, paramHandlers) {
        var pathname = String(reqPath || '').split('?')[0];
        var target = exactHandlers[pathname];
        var opts   = exactOptions[pathname] || null;
        if (typeof target !== 'function' && paramHandlers.length) {
            var m = matchParam(pathname, paramHandlers);
            if (m) { target = m.handler; opts = m.options || null; }
        }
        if (typeof target !== 'function') { return { action: 'status', code: 404 }; }
        return { action: 'accept', acceptArg: opts || undefined };
    }

    var H = function() {};

    it('an exact route with options threads them as the accept arg', function() {
        var r = resolveAcceptArg('/live', { '/live': H }, { '/live': { protocol: 'chat' } }, []);
        assert.deepEqual(r.acceptArg, { protocol: 'chat' });
    });

    it('an exact route without options passes undefined to accept (defaults apply)', function() {
        var r = resolveAcceptArg('/live', { '/live': H }, { '/live': null }, []);
        assert.equal(r.acceptArg, undefined);
    });

    it('a :param route carries the matched entry options', function() {
        var ph = [{ pattern: '/live/:room', handler: H, options: { maxPayload: 1024 } }];
        var r = resolveAcceptArg('/live/foo', {}, {}, ph);
        assert.deepEqual(r.acceptArg, { maxPayload: 1024 });
    });

    it('a :param route without options passes undefined', function() {
        var ph = [{ pattern: '/live/:room', handler: H, options: null }];
        var r = resolveAcceptArg('/live/foo', {}, {}, ph);
        assert.equal(r.acceptArg, undefined);
    });

    it('exact options win over an overlapping :param entry (exact-first)', function() {
        var ph = [{ pattern: '/live/:room', handler: H, options: { protocol: 'param' } }];
        var r = resolveAcceptArg('/live/all', { '/live/all': H }, { '/live/all': { protocol: 'exact' } }, ph);
        assert.deepEqual(r.acceptArg, { protocol: 'exact' });
    });
});


// 12h — #H13 slice 3b: session.query seam. The dispatcher attaches a cross-bundle
// query capability to each accepted session AFTER lib.wsSession.accept (so
// lib/ws-session stays controller-free), and onWebSocket captures the bundle/env
// this server serves once (a server serves one bundle), falling back to getContext
// only when the routing.json registrar did not already set it explicitly.
describe('12h - #H13 slice 3b session.query seam source structure', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it('attaches session.query = lib.wsQuery.build(server, _wsBundle, _wsEnv) on the matched path', function() {
        assert.ok(getSrc().indexOf('_wsSession.query = lib.wsQuery.build(server, server._wsBundle, server._wsEnv);') > -1,
            'expected the dispatcher to attach session.query via lib.wsQuery.build with the captured bundle/env');
    });

    it('attaches session.query AFTER accept and BEFORE the handler is invoked', function() {
        var s         = getSrc();
        var acceptIdx = s.indexOf('lib.wsSession.accept(request, _wsOpts || undefined);');
        var queryIdx  = s.indexOf('_wsSession.query = lib.wsQuery.build(server, server._wsBundle, server._wsEnv);');
        var callIdx   = s.indexOf('_wsTarget(_wsSession, request);');
        assert.ok(acceptIdx > -1 && queryIdx > acceptIdx,
            'session.query must be attached after accept (so lib/ws-session stays controller-free)');
        assert.ok(callIdx > queryIdx,
            'session.query must be attached before the channel handler runs');
    });

    it('captures bundle/env once at registration, gated on _wsBundle being undefined', function() {
        var s = getSrc();
        var guardIdx  = s.indexOf("if (typeof server._wsBundle === 'undefined') {");
        var bundleIdx = s.indexOf("server._wsBundle = (typeof getContext === 'function') ? getContext('bundle') : null;");
        var envIdx    = s.indexOf("server._wsEnv    = (typeof getContext === 'function') ? getContext('env') : null;");
        assert.ok(guardIdx > -1, 'expected the typeof-undefined guard (capture only once per server)');
        assert.ok(bundleIdx > guardIdx, 'expected the getContext(bundle) fallback inside the guard');
        assert.ok(envIdx > guardIdx, 'expected the getContext(env) fallback inside the guard');
    });
});


// 12i — #H13 slice 3b: the bundle/env capture precedence is pure logic — the
// routing.json registrar's explicit self.appName/self.env wins; a purely
// programmatic onWebSocket (no registrar set) falls back to getContext.
describe('12i - #H13 slice 3b bundle/env capture precedence logic', function() {

    // Mirrors: registrar sets server._wsBundle = self.appName BEFORE onWebSocket,
    // and onWebSocket sets it from getContext ONLY when still undefined.
    function captureBundle(server, registrarBundle, ctxBundle) {
        // core/server.js registrar (runs first, at boot, for a routing.json ws route):
        if (typeof registrarBundle !== 'undefined') { server._wsBundle = registrarBundle; }
        // core/server.isaac.js onWebSocket fallback:
        if (typeof server._wsBundle === 'undefined') { server._wsBundle = ctxBundle; }
        return server._wsBundle;
    }

    it('the registrar value (self.appName) wins over getContext', function() {
        assert.equal(captureBundle({}, 'fromRegistrar', 'fromGetContext'), 'fromRegistrar');
    });

    it('a purely programmatic onWebSocket (no registrar value) falls back to getContext', function() {
        assert.equal(captureBundle({}, undefined, 'fromGetContext'), 'fromGetContext');
    });

    it('once captured, a later programmatic call does not overwrite it', function() {
        var server = {};
        captureBundle(server, 'fromRegistrar', 'fromGetContext');           // registrar first
        captureBundle(server, undefined, 'fromLaterGetContext');            // later programmatic
        assert.equal(server._wsBundle, 'fromRegistrar', 'the first (registrar) capture is sticky');
    });
});


// 13 — h2c flood-defense parity (#H3/#H7/#H13): the cleartext http2 branches
// must receive the same hardening options as the https branch. The TLS keys
// never land on those branches (key/cert/ca/pfx/passphrase merge under
// /https/ scheme gates only), so `http2Options` is passed verbatim.
describe('13 - h2c flood-defense parity source structure (#H3/#H7/#H13)', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it("the h2 `case 'http'` branch passes the full http2Options object", function() {
        assert.match(
            getSrc(),
            /case 'http':\s*server\s*=\s*http2\.createServer\(http2Options\);/,
            "expected `http2.createServer(http2Options)` on the h2c `case 'http'` branch — Node defaults (unlimited concurrent streams, enablePush on) and ignored settings.json overrides otherwise"
        );
    });

    it('the h2 `default` branch passes the full http2Options object', function() {
        assert.match(
            getSrc(),
            /default:\s*server\s*=\s*http2\.createServer\(http2Options\);/,
            'expected `http2.createServer(http2Options)` on the h2c `default` branch'
        );
    });

    it('the https branch still uses createSecureServer with the same object', function() {
        assert.ok(
            getSrc().indexOf('http2.createSecureServer(http2Options)') > -1,
            'expected `http2.createSecureServer(http2Options)` on the https branch'
        );
    });

    it('no h2 branch is left on a bare allowHTTP1-only literal', function() {
        assert.ok(
            getSrc().indexOf('createServer({ allowHTTP1') === -1,
            'a `createServer({ allowHTTP1: ... })` literal would drop the settings advert and the #H3/#H7 caps on cleartext'
        );
    });

    it('TLS material merges under /https/ scheme gates only (the premise that makes verbatim-pass safe)', function() {
        assert.match(
            getSrc(),
            /if \( \/https\/\.test\(options\.scheme\) \) \{\s*try \{\s*http2Options = \{\s*key: readSync/,
            'expected the key/cert seed inside the `/https/.test(options.scheme)` gate — if TLS keys ever land unconditionally, the cleartext branches must stop passing http2Options verbatim'
        );
    });

});


// 13b — h2c flood-defense parity: replica of the option construction for a
// cleartext scheme + a live loopback proving the client actually receives
// gina's advertised settings from a cleartext h2c server.
describe('13b - h2c flood-defense parity: option construction + cleartext settings advert', function() {

    var http2 = require('http2');

    // Replica of server.isaac.js option construction for a NON-https scheme:
    // the TLS stages are /https/-gated and contribute nothing, leaving
    // allowHTTP1 + the settings literal + the #H3/#H7 caps.
    function buildH2cOptions(options) {
        var http2Options = {};
        var allowHTTP1 = true;
        if (typeof (options.allowHTTP1) != 'undefined' && options.allowHTTP1 != '' ) {
            allowHTTP1 = options.allowHTTP1;
        }
        http2Options.allowHTTP1 = allowHTTP1;
        var _h2Opts = (options.http2Options && typeof options.http2Options === 'object') ? options.http2Options : {};
        var _enableConnectProtocol = _h2Opts.enableConnectProtocol === true;
        http2Options.settings = {
            maxConcurrentStreams : _h2Opts.maxConcurrentStreams || 256,
            initialWindowSize   : _h2Opts.initialWindowSize    || 65535 * 10,
            maxHeaderListSize   : 65536,
            enablePush          : false,
            enableConnectProtocol : _enableConnectProtocol
        };
        http2Options.maxSessionRejectedStreams = _h2Opts.maxSessionRejectedStreams || 100;
        http2Options.maxSessionInvalidFrames = _h2Opts.maxSessionInvalidFrames || 1000;
        return http2Options;
    }

    // Spin a cleartext h2 server with `serverOptions`, connect a client, and
    // resolve with the SETTINGS frame the client received from the server.
    function readRemoteSettings(serverOptions) {
        var server = http2.createServer(serverOptions);
        var liveSessions = [];
        server.on('session', function(h2session) { liveSessions.push(h2session); });
        server.on('request', function(req, res) { res.end('ok'); });
        return new Promise(function(resolve, reject) {
            server.listen(0, '127.0.0.1', function() {
                var port = server.address().port;
                var client = http2.connect('http://127.0.0.1:' + port);
                var guard = setTimeout(function() { reject(new Error('settings advert timed out')); }, 3000);
                client.on('error', reject);
                client.on('remoteSettings', function(settings) {
                    clearTimeout(guard);
                    var snapshot = {
                        maxConcurrentStreams  : settings.maxConcurrentStreams,
                        initialWindowSize     : settings.initialWindowSize,
                        maxHeaderListSize     : settings.maxHeaderListSize,
                        enablePush            : settings.enablePush,
                        enableConnectProtocol : settings.enableConnectProtocol
                    };
                    try { client.close(); } catch (e) {}
                    resolve(snapshot);
                });
            });
        }).finally(function() {
            liveSessions.forEach(function(h2session) {
                try { h2session.destroy(); } catch (e) {}
            });
            return new Promise(function(resolve) { server.close(resolve); });
        });
    }

    it('replica defaults: caps + settings present, no TLS keys', function() {
        var opts = buildH2cOptions({});
        assert.equal(opts.allowHTTP1, true);
        assert.equal(opts.maxSessionRejectedStreams, 100);
        assert.equal(opts.maxSessionInvalidFrames, 1000);
        assert.equal(opts.settings.maxConcurrentStreams, 256);
        assert.equal(opts.settings.initialWindowSize, 655350);
        assert.equal(opts.settings.maxHeaderListSize, 65536);
        assert.equal(opts.settings.enablePush, false);
        assert.equal(opts.settings.enableConnectProtocol, false);
        assert.equal(typeof opts.key, 'undefined');
        assert.equal(typeof opts.cert, 'undefined');
    });

    it('replica honours settings.json overrides on a cleartext scheme', function() {
        var opts = buildH2cOptions({ http2Options: {
            maxConcurrentStreams: 64, maxSessionRejectedStreams: 50,
            maxSessionInvalidFrames: 500, enableConnectProtocol: true
        } });
        assert.equal(opts.settings.maxConcurrentStreams, 64);
        assert.equal(opts.maxSessionRejectedStreams, 50);
        assert.equal(opts.maxSessionInvalidFrames, 500);
        assert.equal(opts.settings.enableConnectProtocol, true);
    });

    it('a cleartext h2c server built from these options advertises gina settings to the client', async function() {
        var remote = await readRemoteSettings(buildH2cOptions({ http2Options: { enableConnectProtocol: true } }));
        assert.equal(remote.maxConcurrentStreams, 256, 'expected gina default 256, not the protocol-default unlimited');
        assert.equal(remote.initialWindowSize, 655350);
        assert.equal(remote.maxHeaderListSize, 65536);
        assert.equal(remote.enablePush, false, 'server push must be disabled on h2c too');
        assert.equal(remote.enableConnectProtocol, true, 'the RFC 8441 advert must reach cleartext clients when opted in');
    });

    it('subtract-my-contribution: the old allowHTTP1-only literal advertises protocol defaults', async function() {
        var remote = await readRemoteSettings({ allowHTTP1: true });
        assert.notEqual(remote.maxConcurrentStreams, 256, 'pre-fix shape must NOT carry the gina stream cap');
        assert.equal(remote.enablePush, true, 'pre-fix shape leaves deprecated server push enabled');
        assert.equal(remote.enableConnectProtocol, false);
    });

});


// 14 — engine.io socket SIGTERM-drain registration: live engine.io sockets
// register a graceful closer in process.gina._sseConnections (the registry
// proc.js drains BEFORE _httpServer.close()) and deregister in their own
// close handler, so SIGTERM no longer blocks on open sockets until the
// hard shutdown timeout.
describe('14 - engine.io socket SIGTERM-drain registration source structure', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    // The engine.io connection-handler block: from the connection listener
    // to the upgrade handler that follows it.
    function eioBlk() {
        var s = getSrc();
        var start = s.indexOf("ioServer.on('connection'");
        assert.ok(start > -1, 'engine.io connection handler must exist');
        var end = s.indexOf("server.on('upgrade'", start);
        assert.ok(end > start, 'upgrade handler expected after the connection handler');
        return s.slice(start, end);
    }

    it('registers a shutdown closer in process.gina._sseConnections on connection', function() {
        var blk = eioBlk();
        assert.ok(
            blk.indexOf('if (!process.gina._sseConnections) process.gina._sseConnections = new Set();') > -1,
            'expected the lazy Set init (same idiom as the SSE handlers)'
        );
        assert.ok(
            blk.indexOf('process.gina._sseConnections.add(_eioShutdownCloser)') > -1,
            'expected the closer registration'
        );
    });

    it('the closer calls the GRACEFUL socket.close() — no discard arg', function() {
        assert.match(
            eioBlk(),
            /var _eioShutdownCloser = function\(\) \{\s*try \{ socket\.close\(\); \} catch \(e\) \{\}\s*\};/,
            'expected `try { socket.close(); }` — the engine.io API has no status code; close(true) is the hard-discard variant reserved for ioServer.close()'
        );
    });

    it('the socket close handler deregisters the closer', function() {
        var blk = eioBlk();
        var closeIdx = blk.indexOf("socket.on('close'");
        assert.ok(closeIdx > -1, 'close handler must exist');
        assert.ok(
            blk.indexOf('process.gina._sseConnections.delete(_eioShutdownCloser)', closeIdx) > -1,
            'expected the closer deregistration inside the close handler'
        );
    });

    it('registration precedes the close-handler binding', function() {
        var blk = eioBlk();
        var addIdx   = blk.indexOf('process.gina._sseConnections.add(_eioShutdownCloser)');
        var closeIdx = blk.indexOf("socket.on('close'");
        assert.ok(addIdx > -1 && closeIdx > addIdx, 'add must come before the close-handler binding');
    });

});


// 14b — engine.io SIGTERM-drain lifecycle: pure-logic replica mirroring the
// source — register on connect, a proc.js-style snapshot drain invokes the
// closer (graceful close()), the socket close event deregisters.
describe('14b - engine.io SIGTERM-drain lifecycle logic', function() {

    function makeFakeSocket() {
        var sock = { closed: 0, closeHandlers: [] };
        sock.close = function() {
            sock.closed++;
            // engine.io: the transport teardown fires the socket close event
            sock.closeHandlers.forEach(function(h) { h(); });
        };
        sock.onClose = function(h) { sock.closeHandlers.push(h); };
        return sock;
    }

    // Replica of the source lifecycle against an injected registry.
    function wireSocket(registry, socket) {
        var _eioShutdownCloser = function() {
            try { socket.close(); } catch (e) {}
        };
        registry.add(_eioShutdownCloser);
        socket.onClose(function() {
            registry.delete(_eioShutdownCloser);
        });
    }

    // Replica of the proc.js drain: snapshot first, invoke each in try/catch.
    function drain(registry) {
        Array.from(registry).forEach(function(closer) {
            try { closer(); } catch (e) {}
        });
    }

    it('register → drain closes the socket → close event deregisters', function() {
        var registry = new Set();
        var sock = makeFakeSocket();
        wireSocket(registry, sock);
        assert.equal(registry.size, 1);
        drain(registry);
        assert.equal(sock.closed, 1, 'the drain must close the socket');
        assert.equal(registry.size, 0, 'the close event must deregister the closer');
    });

    it('a peer-initiated close deregisters; a later drain has nothing to do', function() {
        var registry = new Set();
        var sock = makeFakeSocket();
        wireSocket(registry, sock);
        sock.close(); // peer closed first
        assert.equal(registry.size, 0);
        drain(registry);
        assert.equal(sock.closed, 1, 'no double close after deregistration');
    });

    it('multiple sockets drain independently (snapshot iteration is delete-safe)', function() {
        var registry = new Set();
        var a = makeFakeSocket(), b = makeFakeSocket();
        wireSocket(registry, a);
        wireSocket(registry, b);
        assert.equal(registry.size, 2);
        drain(registry);
        assert.equal(a.closed, 1);
        assert.equal(b.closed, 1);
        assert.equal(registry.size, 0);
    });

});


// ─── #B65 reverse-proxy host context: per-request slots + un-gate ─────────────
// The proxy host context (getContext('isProxyHost') + process.gina.PROXY_HOST /
// PROXY_HOSTNAME) was worker-global with a one-shot !isProxyHost gate, so the
// proxied host FROZE at the first proxied request's value. #B65 re-derives it
// per request into request._ginaIsProxyHost / _ginaProxyHost / _ginaProxyHostname
// (mirrors _ginaProxyPrefix) and refreshes the worker-global on EVERY proxied
// request so it can never freeze — and never to a raw `host:port`, because the
// globals are only ever written from a proxied request.
describe('15 - #B65 reverse-proxy host context: per-request slots + un-gate source structure', function() {

    if (typeof src == 'undefined' || src === null) {
        src = fs.readFileSync(SOURCE, 'utf8');
    }

    it('classifies THIS request as proxied from a port-less Host OR an X-Forwarded-Host', function() {
        var anchor = src.indexOf('var _thisReqProxied');
        assert.ok(anchor > -1, '#B65 _thisReqProxied classification not found');
        // #B367 re-anchor + widen: both arms now read SANITISED tokens
        // (_safeRequestHost / _xfh) because forwarded headers are validated at ingest.
        // The classification itself is unchanged — port-less Host OR X-Forwarded-Host.
        var block = src.slice(anchor, anchor + 400);
        assert.ok(
            block.indexOf('!/\\:[0-9]+$/.test(_safeRequestHost)') > -1,
            'expected the port-less Host test in the classification'
        );
        assert.ok(
            block.indexOf('|| _xfh') > -1,
            'expected the x-forwarded-host clause in the classification'
        );
    });

    it('writes the three per-request slots (request._ginaIsProxyHost / _ginaProxyHost / _ginaProxyHostname)', function() {
        assert.ok(src.indexOf('request._ginaIsProxyHost = _thisReqProxied') > -1,
            'expected request._ginaIsProxyHost per-request slot write');
        assert.ok(src.indexOf('request._ginaProxyHost') > -1,
            'expected request._ginaProxyHost per-request slot write');
        assert.ok(src.indexOf('request._ginaProxyHostname') > -1,
            'expected request._ginaProxyHostname per-request slot write');
    });

    it('X-Forwarded-Host wins over the port-less Host inside the proxied branch', function() {
        var anchor = src.indexOf('if ( _thisReqProxied ) {');
        assert.ok(anchor > -1, '#B65 proxied branch not found');
        var block = src.slice(anchor, anchor + 700);
        // #B367 re-anchor: the branch condition is now the sanitised token.
        // Branch ORDER — the pinned property — is unchanged.
        var xfhIdx  = block.indexOf('if ( _xfh )');
        var elseIdx = block.indexOf('} else {');
        assert.ok(xfhIdx > -1 && elseIdx > xfhIdx,
            'expected the X-Forwarded-Host branch BEFORE the else (port-less Host) branch');
    });

    it('refreshes the worker-global from the per-request slot inside the proxied branch (freeze fix)', function() {
        // window-independent: the assignment is globally unique to #B65; assert it
        // EXISTS and is ordered AFTER the proxied-branch open (structural anchor,
        // not a fixed char-window that drifts as the block grows).
        var refreshIdx = src.indexOf('process.gina.PROXY_HOSTNAME = request._ginaProxyHostname');
        var branchIdx  = src.indexOf('if ( _thisReqProxied ) {');
        assert.ok(refreshIdx > -1,
            'expected the worker-global to be refreshed from the per-request slot (freeze fix)');
        assert.ok(branchIdx > -1 && refreshIdx > branchIdx,
            'the global refresh must sit inside/after the proxied branch');
    });

    it("the OLD one-shot gated write (`// Enable proxied mode`) is gone (the un-gate replaced it)", function() {
        // Negative invariant, window-independent: the freeze came from writing the
        // globals only while !isProxyHost (once). Its unique marker comment must be
        // globally absent; if it returns, the freeze is back.
        assert.ok(
            src.indexOf('// Enable proxied mode') === -1,
            'the old gated "Enable proxied mode" write must be gone — #B65 un-gate replaced it'
        );
    });

});

describe('15b - #B65 reverse-proxy host context: classification, three-topology + freeze replica', function() {

    // Pure-logic replica of the #B65 detection (server.isaac.js): classify from a
    // port-less Host OR X-Forwarded-Host; XFH wins; write per-request slots;
    // refresh the worker-global on EVERY proxied request.
    function classify(headers, proxyScheme) {
        var requestHost = headers.host || headers[':authority'];
        var xfh = headers['x-forwarded-host'];
        var thisReqProxied = ( ( requestHost && !/\:[0-9]+$/.test(requestHost) ) || xfh ) ? true : false;
        var slot = { _ginaIsProxyHost: thisReqProxied };
        if (thisReqProxied) {
            if (xfh) {
                slot._ginaProxyHostname = headers['x-forwarded-proto'] + '://' + xfh;
                slot._ginaProxyHost     = xfh;
            } else {
                slot._ginaProxyHostname = proxyScheme + '://' + requestHost;
                slot._ginaProxyHost     = requestHost;
            }
        }
        return slot;
    }

    // NEW (#B65): refresh the worker-global on EVERY proxied request (un-gated).
    function applyDetection(g, headers, proxyScheme) {
        var slot = classify(headers, proxyScheme);
        if (slot._ginaIsProxyHost) {
            g.PROXY_HOSTNAME = slot._ginaProxyHostname;
            g.PROXY_HOST     = slot._ginaProxyHost;
            g.isProxyHost    = true; // monotonic
        }
        return slot;
    }

    // OLD (pre-#B65): one-shot gate — write ONLY while !isProxyHost (freezes).
    function applyDetectionOLD(g, headers, proxyScheme) {
        var requestHost = headers.host || headers[':authority'];
        var xfh = headers['x-forwarded-host'];
        var gatedTrip = ( !g.isProxyHost && requestHost && !/\:[0-9]+$/.test(requestHost) ) || ( !g.isProxyHost && xfh );
        if (gatedTrip) {
            if (xfh) { g.PROXY_HOSTNAME = headers['x-forwarded-proto'] + '://' + xfh; g.PROXY_HOST = xfh; }
            else     { g.PROXY_HOSTNAME = proxyScheme + '://' + requestHost;          g.PROXY_HOST = requestHost; }
            g.isProxyHost = true;
        }
    }

    // ── three topologies (must all hold) ─────────────────────────────────────

    it('RAW (host:port, no proxy) → not proxied; static config host preserved', function() {
        var slot = classify({ host: 'myhost:8080' }, 'https');
        assert.equal(slot._ginaIsProxyHost, false, 'a raw host:port must NOT be classified proxied');
        assert.equal(slot._ginaProxyHost, undefined);
        assert.equal(slot._ginaProxyHostname, undefined);
    });

    it('SINGLE-HOP (port-less Host, no XFH) → proxied, host = the port-less Host', function() {
        var slot = classify({ host: 'publichost' }, 'https');
        assert.equal(slot._ginaIsProxyHost, true);
        assert.equal(slot._ginaProxyHost, 'publichost');
        assert.equal(slot._ginaProxyHostname, 'https://publichost');
    });

    it('MULTI-HOP (port-less Host + XFH) → proxied, host = XFH', function() {
        var slot = classify({ host: 'publichost', 'x-forwarded-host': 'publichost', 'x-forwarded-proto': 'https' }, 'https');
        assert.equal(slot._ginaIsProxyHost, true);
        assert.equal(slot._ginaProxyHost, 'publichost');
        assert.equal(slot._ginaProxyHostname, 'https://publichost');
    });

    it('X-Forwarded-Host wins even when the inbound Host carries a port (inner-hop port)', function() {
        var slot = classify({ host: 'inner-svc:8443', 'x-forwarded-host': 'publichost', 'x-forwarded-proto': 'https' }, 'https');
        assert.equal(slot._ginaIsProxyHost, true);
        assert.equal(slot._ginaProxyHost, 'publichost', 'XFH must win over a port-suffixed inbound Host');
    });

    it('no Host and no :authority → not proxied (guard)', function() {
        var slot = classify({}, 'https');
        assert.equal(slot._ginaIsProxyHost, false);
    });

    // ── freeze fix (decisive) + subtract ─────────────────────────────────────

    it('FREEZE FIX: a direct host:port call can never corrupt the global to a direct host', function() {
        var g = {};
        applyDetection(g, { host: 'publichost' }, 'https');            // external proxied req
        assert.equal(g.PROXY_HOSTNAME, 'https://publichost');
        // an internal cross-bundle call lands on the target's DIRECT host:port
        var slot = applyDetection(g, { host: 'auth-dev-x:5132' }, 'https');
        assert.equal(slot._ginaIsProxyHost, false, 'the direct call is not proxied');
        assert.equal(g.PROXY_HOSTNAME, 'https://publichost',
            'the global must stay the proxied host — a direct call must never overwrite it to a host:port');
    });

    it('FREEZE FIX: the global refreshes to the current proxied host (not frozen at the first)', function() {
        var g = {};
        applyDetection(g, { host: 'tenant-a.example' }, 'https');
        applyDetection(g, { host: 'tenant-b.example' }, 'https');
        assert.equal(g.PROXY_HOSTNAME, 'https://tenant-b.example',
            'un-gated detection tracks the current proxied request — not frozen at tenant-a');
    });

    it('SUBTRACT: the OLD one-shot gate FREEZES at the first host (proves the un-gate is load-bearing)', function() {
        var g = {};
        applyDetectionOLD(g, { host: 'tenant-a.example' }, 'https');
        applyDetectionOLD(g, { host: 'tenant-b.example' }, 'https'); // gate already latched → no refresh
        assert.equal(g.PROXY_HOSTNAME, 'https://tenant-a.example',
            'the pre-#B65 gate freezes at tenant-a — this is the bug #B65 fixes');
    });

});

describe('16 - #B66 host-stripped routing.json for proxied clients source structure', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }
    // #B212 — the map BUILD (full + stripped, #COMPLY1 strip included) moved to
    // core/server.js's buildClientRoutingAssets so both engines serve the same
    // maps; isaac keeps the file write + precompression + serve fast-path below.
    // The build-shape pins therefore read core/server.js now.
    var serverSrc;
    function getServerSrc() { return serverSrc || (serverSrc = fs.readFileSync(path.join(require('../fw'), 'core/server.js'), 'utf8')); }

    it('boot-builds a host-stripped variant by cloning the full map and dropping host+hostname', function() {
        var s = getServerSrc();
        assert.ok(s.indexOf('var _routingStripped = JSON.clone(_routing);') > -1,
            'expected _routingStripped cloned from the (already comment/middleware-stripped) full map');
        assert.ok(s.indexOf('const { host, hostname, ...cleanStripped } = _routingStripped[_routingStrippedKeys[si]];') > -1,
            'expected each route to drop host + hostname via rest-destructuring (keeping the rest)');
    });

    it('keeps webroot in the stripped variant (never destructured away — load-bearing for client toUrl)', function() {
        var s = getServerSrc();
        assert.ok(s.indexOf('const { host, hostname, ...cleanStripped }') > -1);
        assert.ok(s.indexOf('const { host, hostname, webroot,') < 0,
            'webroot must NOT be dropped — the client toUrl path relies on route.webroot');
    });

    it('writes + compresses the stripped file to disk (routing.stripped.json + .br/.gz)', function() {
        var s = getSrc();
        assert.ok(s.indexOf("targetFile  = 'routing.stripped.json';") > -1,
            'expected the stripped file write block');
        var wIdx = s.indexOf("targetFile  = 'routing.stripped.json';");
        // the stripped write reuses the same brotli/gzip machinery as the full block (ordering, no fixed window)
        assert.ok(s.indexOf('brotliBin', wIdx) > wIdx, 'the stripped write must also brotli-compress for prod parity');
        assert.ok(s.indexOf('gZipBin', wIdx) > wIdx, 'the stripped write must also gzip-compress for prod parity');
    });

    it('registers the stripped variant as a second localAssets entry', function() {
        var s = getSrc();
        assert.ok(s.indexOf("file    : 'routing.stripped.json',") > -1,
            'expected a routing.stripped.json entry in localAssets');
    });

    it('the routing.json handler serves the stripped asset when the request is proxied (strict === true)', function() {
        var s = getSrc();
        var anchor = s.indexOf('\\_gina\\/assets\\/routing\\.json');
        assert.ok(anchor > -1, 'routing.json handler anchor not found');
        var branchIdx = s.indexOf('if ( request._ginaIsProxyHost === true ) {', anchor);
        var selectIdx = s.indexOf("assetsCollection.findOne({ file: 'routing.stripped.json' })", anchor);
        assert.ok(branchIdx > anchor,
            'expected the proxied branch gated on the per-request #B65 slot, after the routing.json anchor');
        assert.ok(selectIdx > branchIdx,
            'the proxied branch must select the stripped asset');
    });

    it('marks the proxied (stripped) response private, RAW (full) public — revalidating since Slice 3 (#SPA1)', function() {
        var s = getSrc();
        assert.ok(
            s.indexOf("response.setHeader('cache-control', ( request._ginaIsProxyHost === true ) ? 'private, no-cache' : 'public, no-cache');") > -1,
            'expected a private-if-proxied / public-if-raw cache-control branch with no-cache (ETag revalidation — the 24h staleness window is closed)');
    });

});

describe('16b - #B66 host-stripped routing.json: pure-logic replica', function() {

    // Pure-logic replica of the #B66 S2 boot strip + serve-time selection.
    function stripRoute(route) {
        var out = {};
        for (var k in route) { if (k !== 'host' && k !== 'hostname') out[k] = route[k]; }
        return out;
    }
    function selectAsset(isProxy, fullAsset, strippedAsset) {
        var a = fullAsset;
        if (isProxy === true && strippedAsset) a = strippedAsset;
        return a;
    }
    function cacheControl(isProxy) {
        // Slice 3 (#SPA1): no-cache + per-variant ETag — revalidate each boot
        return (isProxy === true) ? 'private, no-cache' : 'public, no-cache';
    }

    // neutral fixture route (internal host+port), framework-generic
    var FULL_ROUTE = {
        url: '/app/', method: 'GET', param: { control: 'home' },
        bundle: 'other', host: 'internal-a', hostname: 'http://internal-a:5101', webroot: '/app/'
    };

    it('strip drops host + hostname, KEEPS webroot/url/param', function() {
        var st = stripRoute(FULL_ROUTE);
        assert.equal('host' in st, false);
        assert.equal('hostname' in st, false);
        assert.equal(st.webroot, '/app/');
        assert.equal(st.url, '/app/');
        assert.deepEqual(st.param, { control: 'home' });
    });

    it('stripped blob carries NO internal-host marker (webroot survives)', function() {
        var blob = JSON.stringify({ 'r@other': stripRoute(FULL_ROUTE) });
        assert.ok(blob.indexOf('internal-a') < 0, 'no internal host in the stripped blob');
        assert.ok(blob.indexOf('5101') < 0, 'no internal port in the stripped blob');
        assert.ok(blob.indexOf('/app/') > -1, 'webroot must survive');
    });

    it('serve-time selection: proxied → stripped, raw → full', function() {
        var full = { file: 'routing.json' }, stripped = { file: 'routing.stripped.json' };
        assert.equal(selectAsset(true,  full, stripped).file, 'routing.stripped.json');
        assert.equal(selectAsset(false, full, stripped).file, 'routing.json');
    });

    it('strict === true: a truthy-but-non-true flag serves the FULL (raw) asset', function() {
        var full = { file: 'routing.json' }, stripped = { file: 'routing.stripped.json' };
        assert.equal(selectAsset('true', full, stripped).file, 'routing.json');
    });

    it('missing stripped asset → falls back to full (defensive)', function() {
        var full = { file: 'routing.json' };
        assert.equal(selectAsset(true, full, undefined).file, 'routing.json');
    });

    it('cache-control: private when proxied, public when raw (no-cache — Slice 3 revalidation)', function() {
        assert.equal(cacheControl(true),  'private, no-cache');
        assert.equal(cacheControl(false), 'public, no-cache');
    });

    it('SUBTRACT: without the strip, the internal host survives in the served blob (the leak)', function() {
        var blob = JSON.stringify({ 'r@other': FULL_ROUTE }); // pre-#B66: full route served to proxied clients
        assert.ok(blob.indexOf('internal-a') > -1 && blob.indexOf('5101') > -1,
            'pre-fix, the proxied client received the internal host:port — this is the disclosure #B66 closes');
    });

});


describe('17 - #RC5 Cache-Status detail + RFC miss form + stats L2 fold — source pins', function() {

    function getSrc() { return src || (src = fs.readFileSync(SOURCE, 'utf8')); }

    it('the hit path appends `detail=` from the SAME memory-vs-fs predicate the serve branch uses', function() {
        var s = getSrc();
        assert.match(s, /cacheStatus\s*\+=\s*'; detail='\s*\+\s*\(\s*\(typeof\(cachedContentObj\.fromMemory\)\s*!=\s*'undefined'\)\s*\?\s*'memory'\s*:\s*'fs'\s*\)/,
            'detail token derived from cachedContentObj.fromMemory — memory (Map) vs fs (disk readBack)');
    });

    it('the detail append precedes the hit setHeader (the header carries it)', function() {
        var s = getSrc();
        var detailAt = s.indexOf("cacheStatus += '; detail='");
        var setAt    = s.indexOf("response.setHeader('Cache-Status', cacheStatus)");
        assert.ok(detailAt > -1 && setAt > -1 && detailAt < setAt,
            'append must land in the string BEFORE the first (hit-path) setHeader');
    });

    it('the miss form is RFC 9211 §2.2 — fwd=uri-miss, never a bare uri-miss parameter', function() {
        var s = getSrc();
        assert.match(s, /cacheStatus\s*\+=\s*'; fwd=uri-miss'/);
        // Window-independent negative: the pre-#RC5 bare-append form is globally gone
        // (the code shape `+= '; uri-miss'`, not the bare token — comments legitimately
        // name uri-miss when explaining the RFC form).
        assert.ok(s.indexOf("+= '; uri-miss'") < 0, 'the bare uri-miss append must not return');
    });

    it('#B238: the identifier seeds from the boot-resolved stamp, never a literal', function() {
        var s = getSrc();
        // The seeding reads the server.js-stamped scalar (sibling of _cacheIsEnabled).
        assert.match(s, /cacheStatus\s*=\s*server\._cacheName;/);
        // Window-independent negative: the literal seeding is globally gone (the
        // assignment shape — comments name the old value without this prefix form).
        assert.ok(s.indexOf("cacheStatus = 'gina-cache'") < 0, 'the literal seeding must not return');
    });

    it('/_gina/cache/stats folds store.health() as an ADDITIVE l2 field, after the admin gate', function() {
        var s = getSrc();
        assert.match(s, /cacheStatsPayload\.l2\s*=\s*process\.gina\._renderCacheStore\.health\(\)/);
        assert.match(s, /typeof\(process\.gina\._renderCacheStore\.health\)\s*===\s*'function'/,
            'guarded on health being a function (a future store without it stays un-folded)');
        var gateAt = s.indexOf('/_gina/cache/stats: client IP not in app.json admin.allowFrom');
        var foldAt = s.indexOf('cacheStatsPayload.l2 =');
        assert.ok(gateAt > -1 && foldAt > gateAt, 'the 403 gate precedes the l2 fold');
        var stringifyAt = s.indexOf('JSON.stringify(cacheStatsPayload)');
        assert.ok(stringifyAt > foldAt, 'the fold lands before the payload is serialized');
    });
});


describe('17b - #RC5 isaac cacheStatus build — pure-logic replica', function() {

    // Faithful replica of the isaac pre-routing read's cacheStatus construction
    // (server.isaac.js hit path: '; hit' + ttl/max-age + '; detail=' append) and
    // the miss form. `now` is injected so the arithmetic is deterministic.
    // #B238 — the real seeding reads the boot-resolved `server._cacheName` stamp;
    // `cacheName` injects it here, with `|| 'gina-cache'` compressing the
    // resolveCacheName default into the replica's one seam (default arms unchanged).
    function buildHitStatus(cachedContentObj, now, cacheName) {
        var cacheStatus = cacheName || 'gina-cache';
        cacheStatus += '; hit';
        var cacheNow = now;
        if ( cachedContentObj.sliding === true ) {
            if ( typeof(cachedContentObj.ttl) != 'undefined' && cachedContentObj.ttl > 0 ) {
                var lastAccess = cachedContentObj.lastAccessedAt
                    ? cachedContentObj.lastAccessedAt.getTime()
                    : cachedContentObj.createdAt.getTime();
                var slidingRemainingSeconds = Math.max(0, Math.floor( (lastAccess + Math.round(cachedContentObj.ttl * 1000) - cacheNow) / 1000 ));
                cacheStatus += '; ttl=' + slidingRemainingSeconds;
            }
            if ( cachedContentObj.expiresAt ) {
                var absoluteRemainingSeconds = Math.max(0, Math.floor( (cachedContentObj.expiresAt.getTime() - cacheNow) / 1000 ));
                cacheStatus += '; max-age=' + absoluteRemainingSeconds;
            }
        } else {
            if ( typeof(cachedContentObj.ttl) != 'undefined' && cachedContentObj.ttl > 0) {
                var createdAt = cachedContentObj.createdAt.getTime() + Math.round(cachedContentObj.ttl * 1000);
                var remainingSeconds = Math.floor( (createdAt - cacheNow) /1000);
                cacheStatus += '; ttl='+remainingSeconds;
            }
        }
        cacheStatus += '; detail=' + ( (typeof(cachedContentObj.fromMemory) != 'undefined') ? 'memory' : 'fs' );
        return cacheStatus;
    }

    function buildMissStatus(cacheName) {
        var cacheStatus = cacheName || 'gina-cache';
        cacheStatus += '; fwd=uri-miss';
        return cacheStatus;
    }

    it('a memory (Map) entry with an absolute ttl → hit; ttl=N; detail=memory', function() {
        var now = Date.now();
        var s = buildHitStatus({ fromMemory: true, ttl: 60, createdAt: new Date(now - 10000) }, now);
        assert.equal(s, 'gina-cache; hit; ttl=50; detail=memory');
    });

    it('an fs (disk readBack) entry → detail=fs — restart survival observable on the wire', function() {
        var now = Date.now();
        var s = buildHitStatus({ filename: '/cache/x', ttl: 60, createdAt: new Date(now - 10000) }, now);
        assert.equal(s, 'gina-cache; hit; ttl=50; detail=fs');
    });

    it('a sliding entry → ttl (idle window) + max-age (absolute ceiling) + detail, in that order', function() {
        var now = Date.now();
        var s = buildHitStatus({
            fromMemory: true, sliding: true, ttl: 30,
            createdAt:      new Date(now - 60000),
            lastAccessedAt: new Date(now - 5000),
            expiresAt:      new Date(now + 100000)
        }, now);
        assert.equal(s, 'gina-cache; hit; ttl=25; max-age=100; detail=memory');
    });

    it('a no-ttl memory entry → hit; detail=memory (no ttl param)', function() {
        var s = buildHitStatus({ fromMemory: true }, Date.now());
        assert.equal(s, 'gina-cache; hit; detail=memory');
    });

    it('the miss form is gina-cache; fwd=uri-miss', function() {
        assert.equal(buildMissStatus(), 'gina-cache; fwd=uri-miss');
    });

    it('#B238: a configured identifier is the only byte that moves — hit and miss', function() {
        var now = Date.now();
        var s = buildHitStatus({ fromMemory: true, ttl: 60, createdAt: new Date(now - 10000) }, now, 'cache');
        assert.equal(s, 'cache; hit; ttl=50; detail=memory',
            'identifier swapped, params byte-identical to the default wire');
        assert.equal(buildMissStatus('cache'), 'cache; fwd=uri-miss');
    });
});


// 18 — #B365 socket identity is derived server-side, never client-asserted
describe('18 - #B365 engine.io socket session binding — source pins', function() {

    var read = function() {
        if (!src) { src = fs.readFileSync(SOURCE, 'utf8'); }
        return src;
    };

    it('the client-asserted binding is GONE', function() {
        // The whole defect: `this.sessionId = payload.session.id` inside the
        // message handler, run on EVERY message, never checked.
        var s = read();
        assert.equal(/this\.sessionId\s*=\s*payload\.session\.id/.test(s), false);
        // Control: the identifier still exists in the file, so a broken needle
        // could not have produced the zero above.
        assert.ok(/sessionId/.test(s), 'sessionId must still appear — else the pin is vacuous');
    });

    it('binds from the upgrade request at connection, not from a message', function() {
        var s = read();
        assert.match(s, /var\s+bindSocketSession\s*=\s*function\s*\(\s*socket\s*,\s*cb\s*\)/);
        assert.match(s, /bindSocketSession\(socket\)/);
        // The bound value comes from the request the session middleware populated.
        assert.match(s, /req\.sessionID/);
        assert.match(s, /socket\.sessionId\s*=\s*sid/);
    });

    it('replays the bundle session middleware rather than unsigning a cookie itself', function() {
        var s = read();
        // Matches express-session's own named middleware and the gina wrapper's
        // absolute-timeout variant, so adopting and non-adopting bundles behave alike.
        assert.match(s, /\^\(session\|ginaSessionAbsoluteTimeout\)\$/);
        assert.match(s, /server\._expressMiddlewares/);
        // It must NOT grow its own crypto path — that would need the session
        // secret, which lives in bundle code.
        assert.equal(/createHmac\([^)]*\)[\s\S]{0,400}sessionId/.test(s), false);
    });

    it('passes an INERT response so a socket upgrade can never emit Set-Cookie', function() {
        var s = read();
        assert.match(s, /var\s+inertRes\s*=\s*\{/);
        assert.match(s, /setHeader:\s*noop/);
        assert.match(s, /writeHead:\s*noop/);
        assert.match(s, /end:\s*noop/);
    });

    it('fails CLOSED — no middleware and no request both return without binding', function() {
        var s = read();
        assert.match(s, /if\s*\(\s*req\s*==\s*null\s*\|\|\s*!server\._expressMiddlewares/);
        assert.match(s, /if\s*\(\s*!chain\.length\s*\)\s*\{[\s\S]{0,40}return done\(null\)/);
    });

    it('keeps a mismatch DETECTOR on the message path', function() {
        var s = read();
        assert.match(s, /payload\.session\.id\s*!==\s*this\.sessionId/);
        assert.match(s, /Ignoring the assertion \(#B365\)/);
    });
});

describe('18b - #B365 binding logic — pure-seam replica', function() {

    // The real bindSocketSession is an inner closure, so its BRANCHES are
    // replicated here. The replica is validated against a known-FALSE case
    // (a socket whose middleware yields no sessionID must bind nothing), so a
    // stuck-true replica cannot pass silently.
    function replica(server, socket, cb) {
        var req = socket.request;
        if (req == null || !server._expressMiddlewares || !server._expressMiddlewares.length) { return cb(null); }
        var chain = server._expressMiddlewares.filter(function (fn) {
            return typeof fn === 'function' && /^(session|ginaSessionAbsoluteTimeout)$/.test(fn.name);
        });
        if (!chain.length) { return cb(null); }
        var idx = 0;
        var next = function (err) {
            if (err) { return cb(null); }
            if (idx >= chain.length) {
                var sid = (typeof req.sessionID !== 'undefined' && req.sessionID) ? req.sessionID : null;
                if (sid) { socket.sessionId = sid; }
                return cb(sid);
            }
            var mw = chain[idx++];
            try { mw(req, {}, next); } catch (e) { return cb(null); }
        };
        next();
    }

    function sessionMw(sid) {
        // Named `session`, exactly as express-session returns it.
        return function session(req, res, next) { req.sessionID = sid; next(); };
    }

    it('binds the id the session middleware resolved', function(t, done) {
        var socket = { request: {} };
        replica({ _expressMiddlewares: [sessionMw('SESSION-A')] }, socket, function (sid) {
            assert.equal(sid, 'SESSION-A');
            assert.equal(socket.sessionId, 'SESSION-A');
            done();
        });
    });

    it('KNOWN-NEGATIVE: binds nothing when the middleware resolves no session', function(t, done) {
        var socket = { request: {} };
        replica({ _expressMiddlewares: [sessionMw(undefined)] }, socket, function (sid) {
            assert.equal(sid, null);
            assert.equal(socket.sessionId, undefined);
            done();
        });
    });

    it('ignores non-session middlewares', function(t, done) {
        var socket = { request: {} };
        var other = function bodyParser(req, res, next) { req.sessionID = 'WRONG'; next(); };
        replica({ _expressMiddlewares: [other] }, socket, function (sid) {
            assert.equal(sid, null);
            assert.equal(socket.sessionId, undefined);
            done();
        });
    });

    it('matches the gina wrapper timeout variant by name', function(t, done) {
        var socket = { request: {} };
        var wrapped = function ginaSessionAbsoluteTimeout(req, res, next) { req.sessionID = 'SESSION-W'; next(); };
        replica({ _expressMiddlewares: [wrapped] }, socket, function (sid) {
            assert.equal(sid, 'SESSION-W');
            done();
        });
    });

    it('fails closed when the middleware errors', function(t, done) {
        var socket = { request: {} };
        var boom = function session(req, res, next) { next(new Error('store down')); };
        replica({ _expressMiddlewares: [boom] }, socket, function (sid) {
            assert.equal(sid, null);
            assert.equal(socket.sessionId, undefined);
            done();
        });
    });

    it('fails closed when the middleware throws', function(t, done) {
        var socket = { request: {} };
        var boom = function session() { throw new Error('exploded'); };
        replica({ _expressMiddlewares: [boom] }, socket, function (sid) {
            assert.equal(sid, null);
            done();
        });
    });

    it('fails closed when there is no upgrade request', function(t, done) {
        replica({ _expressMiddlewares: [sessionMw('SESSION-A')] }, { request: null }, function (sid) {
            assert.equal(sid, null);
            done();
        });
    });
});
