'use strict';
/**
 * #B1108 — the opt-in popin load limit (`loadTimeout`): unit arms on the REAL source.
 *
 * A popin whose content request never answered kept its loading shell, and its trigger busy,
 * with no limit. `loadTimeout` (per popin, or `gina.config.popin.loadTimeout` for every popin
 * without its own value) aborts such a load at its limit; the request's own readyState-4
 * failure branch then reports `{ status: 408, error: 'Request Timeout' }`. The browser
 * behaviour is test/e2e/popin-load-timeout-b1108.spec.js's; this file covers what a browser
 * run reaches only slowly or not at all.
 *
 * 01 executes resolveLoadTimeout, armLoadTimer and clearLoadTimer extracted from the source
 *    (brace-balanced extraction; each uses only its parameters and the globals it is handed,
 *    so lifting it out of the module closure changes nothing it reads); 02 pins the wiring the
 *    extraction cannot run (popinLoad, preloadFetch, warmTrigger, the defaults); 03 pins the
 *    served bundle.
 *
 * Red-first lever: point the file at the pre-change source and every arm but the CONTROL
 * goes red —
 *   GINA_POPIN_SRC=<path to `git show <rev>:framework/v<ver>/core/asset/plugin/src/vendor/gina/popin/main.js`> \
 *     node --test test/core/popin-load-timeout-b1108.test.js
 * (the dist arms read the built bundle, not that file: rebuild, or read them against a
 * pre-change dist, to see them red).
 *
 * Usage: node --test test/core/popin-load-timeout-b1108.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC   = process.env.GINA_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN_JS = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var _src;
function getSrc() { return _src || (_src = fs.readFileSync(POPIN_SRC, 'utf8')); }

/**
 * extract — the text of ONE module-level inner function, by name: anchored on its unique
 * declaration line and sliced by brace balance (popin-loading-state.test.js's seam).
 *
 * @param {string} name
 * @param {string} [src]
 * @returns {string}
 */
function extract(name, src) {
    src = src || getSrc();
    var re = new RegExp('^[ \\t]*function ' + name + '\\(', 'mg');
    var m = re.exec(src);
    if (!m) throw new Error('declaration missing: ' + name);
    if (re.exec(src)) throw new Error('declaration not unique: ' + name);
    var i = m.index, depth = 0, started = false;
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    if (!started || depth !== 0) throw new Error('unbalanced braces: ' + name);
    return src.slice(m.index, i);
}

/** resolveLoadTimeout from the source, reading the `gina` it is handed. */
function loadResolver(gina) {
    return new Function('gina', extract('resolveLoadTimeout') + '\nreturn resolveLoadTimeout;')(gina);
}

/** armLoadTimer + clearLoadTimer from the source, on the timer functions they are handed. */
function loadTimers(setTimeoutFn, clearTimeoutFn) {
    return new Function('setTimeout', 'clearTimeout',
        extract('armLoadTimer') + '\n' + extract('clearLoadTimer') + '\nreturn { arm: armLoadTimer, clear: clearLoadTimer };'
    )(setTimeoutFn, clearTimeoutFn);
}

/** A manual clock: `tick()` runs the due callbacks. */
function fakeClock() {
    var queue = [], now = 0, nextId = 1;
    return {
        setTimeout: function (fn, ms) { var id = nextId++; queue.push({ id: id, at: now + ms, fn: fn }); return id; },
        clearTimeout: function (id) { queue = queue.filter(function (t) { return t.id !== id; }); },
        tick: function (ms) {
            now += ms;
            var due = queue.filter(function (t) { return t.at <= now; });
            queue = queue.filter(function (t) { return t.at > now; });
            due.forEach(function (t) { t.fn(); });
        },
        pending: function () { return queue.length; }
    };
}

function fakeXhr(readyState) {
    return { readyState: readyState, aborted: 0, abort: function () { this.aborted++; this.readyState = 4; } };
}

describe('01 - the limit, from the source', function () {

    it('resolveLoadTimeout: the popin\'s own value, else the project value, else none', function () {
        var resolve = loadResolver({ config: { popin: { loadTimeout: 1000 } } });
        assert.equal(resolve({ options: { loadTimeout: 2500 } }), 2500, 'the popin\'s own value wins');
        assert.equal(resolve({ options: { loadTimeout: null } }), 1000, 'none of its own: the project value');
        assert.equal(resolve({ options: {} }), 1000);
        assert.equal(resolve(null), 1000, 'no popin known (a warm before registration): the project value');
        assert.equal(resolve({ options: { loadTimeout: 0 } }), 0, 'a popin\'s 0 means no limit, even under a project value');
        var none = loadResolver({ config: {} });
        assert.equal(none({ options: { loadTimeout: null } }), 0, 'no value anywhere: no limit (the default)');
        assert.equal(loadResolver(undefined)({ options: { loadTimeout: 1500 } }), 1500, 'no gina at all: the popin\'s own value still applies');
    });

    it('resolveLoadTimeout: a value that is not a finite number >= 0 falls through to the next level', function () {
        var resolve = loadResolver({ config: { popin: { loadTimeout: 1000 } } });
        [NaN, -5, Infinity, '1500', true, {}].forEach(function (bad) {
            assert.equal(resolve({ options: { loadTimeout: bad } }), 1000, 'falls through: ' + String(bad));
        });
        var badProject = loadResolver({ config: { popin: { loadTimeout: '1000' } } });
        assert.equal(badProject({ options: {} }), 0, 'a project value that is not a number is no limit');
    });

    it('resolveLoadTimeout: above the timer maximum (2^31 - 1 ms) means no limit', function () {
        var resolve = loadResolver({ config: {} });
        assert.equal(resolve({ options: { loadTimeout: 2147483647 } }), 2147483647, 'the maximum itself is a limit');
        assert.equal(resolve({ options: { loadTimeout: 2147483648 } }), 0, 'one more is no limit: setTimeout would fire it at once');
    });

    it('armLoadTimer: unanswered at the limit, onFire runs first, then the abort', function () {
        var clock = fakeClock(), t = loadTimers(clock.setTimeout, clock.clearTimeout);
        var xhr = fakeXhr(1), order = [];
        xhr.abort = function () { order.push('abort'); this.readyState = 4; };
        t.arm(xhr, 1000, function () { order.push('onFire'); });
        clock.tick(999);
        assert.deepEqual(order, [], 'nothing before the limit');
        clock.tick(1);
        assert.deepEqual(order, ['onFire', 'abort'], 'the latch is set before the abort settles the request');
        assert.equal(xhr._ginaLoadTimer, null, 'the timer is forgotten');
    });

    it('armLoadTimer: a settled request is left alone; clearLoadTimer drops the limit; 0 arms nothing', function () {
        var clock = fakeClock(), t = loadTimers(clock.setTimeout, clock.clearTimeout);
        var settled = fakeXhr(1), fired = 0;
        t.arm(settled, 1000, function () { fired++; });
        settled.readyState = 4;
        clock.tick(1000);
        assert.equal(settled.aborted, 0, 'readyState 4 at the limit: no abort');
        assert.equal(fired, 0, 'and no latch');
        var cleared = fakeXhr(1);
        t.arm(cleared, 1000, function () { fired++; });
        t.clear(cleared);
        assert.equal(clock.pending(), 0, 'the timer is gone');
        clock.tick(2000);
        assert.equal(cleared.aborted, 0);
        var off = fakeXhr(1);
        t.arm(off, 0, function () { fired++; });
        assert.equal(clock.pending(), 0, 'a 0 limit arms nothing');
        t.arm(null, 1000);
        assert.equal(clock.pending(), 0, 'no request arms nothing');
        assert.equal(fired, 0);
    });
});

describe('02 - the wiring', function () {

    it('the constructor defaults carry loadTimeout: null (off by default)', function () {
        assert.match(getSrc(), /'loadingShell'\s*:\s*null,[\s\S]{0,700}?'loadTimeout'\s*:\s*null,/);
    });

    it('popinLoad: clearLoadTimer first at readyState 4, the 408 payload before the error emit, the limit armed after send()', function () {
        var s = extract('popinLoad');
        var rs4 = s.indexOf('if (xhr.readyState == 4) {');
        var clear = s.indexOf('clearLoadTimer(xhr);', rs4);
        var release = s.indexOf('loadingState.disarm($popinTrigger);', rs4);
        assert.ok(rs4 > -1 && clear > rs4 && release > clear, 'the limit is dropped before the release block');
        var timed = s.search(/if\s*\(\s*timedOut\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*result\s*=\s*\{\s*'status'\s*:\s*408,\s*'error'\s*:\s*'Request Timeout'\s*\};/);
        var emit = s.indexOf("triggerEvent(gina, $el, 'error.' + id, result)", timed);
        assert.ok(timed > -1 && emit > timed, 'a timed-out load reports 408 through the same error emit');
        var send = s.indexOf('xhr.send();');
        var arm = s.search(/armLoadTimer\(\s*xhr\s*,\s*resolveLoadTimeout\(\s*\$popin\s*\)\s*,\s*function\s*\(\)\s*\{\s*timedOut\s*=\s*true;\s*\}\s*\);/);
        assert.ok(send > -1 && arm > send, 'the limit is armed after the request is sent');
    });

    it('CONTROL — preloadFetch keeps its (url, onDone) signature (true before and after #B1108; other tests pin it)', function () {
        assert.match(getSrc(), /function\s+preloadFetch\s*\(\s*url\s*,\s*onDone\s*\)/);
    });

    it('the warm: preloadFetch returns its request and drops the limit at readyState 4; warmTrigger arms it', function () {
        var pf = extract('preloadFetch');
        assert.ok(pf.indexOf('clearLoadTimer(xhrPreload);') > pf.indexOf('if ( xhrPreload.readyState == 4 ) {'), 'the warm drops its limit when it settles');
        assert.match(pf, /xhrPreload\.send\(\);\s*\n\s*return xhrPreload;/, 'the warm request is handed back');
        var wt = extract('warmTrigger');
        assert.match(wt, /armLoadTimer\(\s*preloadFetch\(\s*url\s*,\s*onDone\s*\)\s*,\s*resolveLoadTimeout\(/, 'warmTrigger arms the limit on it');
        assert.match(wt, /getAttribute\('data-gina-dialog'\)\s*\|\|\s*\$trigger\.getAttribute\('data-gina-popin-name'\)/, 'from the popin the trigger opens');
    });
});

describe('03 - the served bundle', function () {

    it('gina.js carries the three functions', function () {
        var dist = fs.readFileSync(DIST_JS, 'utf8');
        ['function resolveLoadTimeout(', 'function armLoadTimer(', 'function clearLoadTimer('].forEach(function (needle) {
            assert.ok(dist.indexOf(needle) > -1, needle + ' — rebuild the plugin bundle');
        });
    });

    it('gina.min.js carries the timer property and the latch-chosen timeout payload', function () {
        var min = fs.readFileSync(DIST_MIN_JS, 'utf8');
        assert.ok(min.indexOf('_ginaLoadTimer') > -1, 'the timer property survives minification — rebuild the plugin bundle');
        // NOT a bare 'Request Timeout' search: the bundle carried that literal twice before
        // #B1108 (two other `ontimeout` handlers), so it cannot tell the bundles apart. The
        // popin's failure branch minifies to `<latch>?r={status:408,…}:(r={status:<xhr>.status,`.
        assert.match(min, /\?(\w+)=\{status:408,error:'Request Timeout'\}:\(\1=\{status:\w+\.status,/,
            'the failure branch picks the 408 payload when the latch is set — rebuild the plugin bundle');
    });
});
