'use strict';
/**
 * The client routing fetch asks again when it never got an answer (#B1044)
 *
 * A navigation can cut the fetch of `_gina/assets/routing.json`: WebKit rejects it when the navigation
 * starts and refuses a new fetch until the navigation ends. The failure message then printed on a page
 * that was going away, and when the navigation did not replace the page (a 204, a download) that page
 * kept no table. `loadRoutingConf` now asks again after 300 ms, 1 s and 2.5 s when no answer was read. An
 * answer the server did give (an HTTP error, a body that is not JSON) is reported at once.
 *
 * Division of labor:
 *  - BEHAVIORAL in real browsers: test/e2e/client-routing-fetch-b1044.spec.js.
 *  - THIS file keeps the browserless `npm test` release gate able to detect a removed retry or a bundle
 *    that was not rebuilt. It runs the function's own source, lifted out of core.js, against a fake
 *    `fetch` and a fake timer, so there is no replica to drift.
 *
 * Run: node --test test/core/client-routing-fetch-retry-b1044.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW   = require('../fw');
var CORE = path.join(FW, 'core/asset/plugin/src/vendor/gina/core.js');
var MIN  = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var coreSrc, minSrc, liftedSrc;

/** Strip `//`-comment lines. */
function stripLineComments(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
}

/** Started-flag brace walk from a unique declaration (comment-stripped input). */
function extractFn(src, decl) {
    assert.equal(src.split(decl).length - 1, 1, 'decl not unique: ' + decl);
    var i = src.indexOf(decl);
    var depth = 0, started = false, j = i;
    while (j < src.length) {
        var c = src[j];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') {
            depth--;
            if (started && depth === 0) break;
        }
        j++;
    }
    assert.ok(started && depth === 0 && j < src.length, 'unbalanced walk for: ' + decl);
    return src.substring(i, j + 1);
}

/**
 * Runs the lifted `loadRoutingConf` until it settles.
 *
 * @param {function} answer - (attempt number from 1) => what `fetch` does: throws to reject, or returns a response
 * @returns {Promise<{attempts: number, delays: number[], events: object[], gina: object}>}
 */
async function run(answer) {
    var out = { attempts: 0, delays: [], events: [], gina: { config: {} } };
    var fakeFetch = async function () {
        out.attempts++;
        return answer(out.attempts);
    };
    var fakeSetTimeout = function (fn, ms) {
        out.delays.push(ms);
        fn();
        return 0;
    };
    var bus = { dispatchEvent: function (e) { out.events.push(e.detail); } };
    function FakeCustomEvent(name, init) { this.detail = init.detail; }
    var fakeWindow = { gina: out.gina };
    var load = new Function('fetch', 'setTimeout', 'depsEventBus', 'CustomEvent', 'window', 'gina',
        liftedSrc + '\nreturn loadRoutingConf;')(fakeFetch, fakeSetTimeout, bus, FakeCustomEvent, fakeWindow, out.gina);
    await load('routing', { url: '/_gina/assets/routing.json' });
    // the fake timer runs the retry at once, without being awaited: let the chain of microtasks end
    for (var i = 0; i < 50 && out.events.length === 0; i++) { await new Promise(function (r) { setImmediate(r); }); }
    return out;
}

function ok(body) {
    return { ok: true, status: 200, text: async function () { return body; } };
}

before(function () {
    coreSrc   = fs.readFileSync(CORE, 'utf8');
    minSrc    = fs.readFileSync(MIN, 'utf8');
    liftedSrc = extractFn(stripLineComments(coreSrc), 'async function loadRoutingConf(name, opt) {');
});

describe('#B1044 — the lifted function, against a fake fetch', function () {

    it('01 - the first answer is installed, with no retry', async function () {
        var r = await run(function () { return ok('{"a":{}}'); });
        assert.equal(r.attempts, 1);
        assert.deepEqual(r.delays, []);
        assert.equal(r.events.length, 1);
        assert.equal(r.events[0].error, null);
        assert.deepEqual(r.gina.config.routing, { a: {} });
    });

    it('02 - a fetch that rejects is asked again, after 300 ms: the answer is installed, nothing is reported', async function () {
        var r = await run(function (n) {
            if (n === 1) { throw new TypeError('Load failed'); }
            return ok('{"a":{}}');
        });
        assert.equal(r.attempts, 2);
        assert.deepEqual(r.delays, [300]);
        assert.equal(r.events.length, 1, 'one settle');
        assert.equal(r.events[0].error, null);
        assert.deepEqual(r.gina.config.routing, { a: {} });
    });

    it('03 - a fetch that keeps rejecting: four attempts on the schedule, then one failure', async function () {
        var r = await run(function () { throw new TypeError('Load failed'); });
        assert.equal(r.attempts, 4);
        assert.deepEqual(r.delays, [300, 1000, 2500]);
        assert.equal(r.events.length, 1, 'one settle');
        assert.ok(r.events[0].error instanceof Error);
        assert.match(r.events[0].error.message, /Could not load routing/);
    });

    it('04 - a body cut while it is read is asked again too', async function () {
        var r = await run(function (n) {
            if (n === 1) {
                return { ok: true, status: 200, text: async function () { throw new TypeError('Load failed'); } };
            }
            return ok('{"a":{}}');
        });
        assert.equal(r.attempts, 2);
        assert.equal(r.events[0].error, null);
    });

    it('05 - an HTTP error is an answer: no retry, the failure at once', async function () {
        var r = await run(function () { return { ok: false, status: 503, text: async function () { return '{}'; } }; });
        assert.equal(r.attempts, 1);
        assert.deepEqual(r.delays, []);
        assert.equal(r.events.length, 1);
        assert.match(r.events[0].error.message, /HTTP 503/);
    });

    it('06 - a body that is not JSON is an answer: no retry, the failure at once', async function () {
        var r = await run(function () { return ok('not json'); });
        assert.equal(r.attempts, 1);
        assert.deepEqual(r.delays, []);
        assert.equal(r.events.length, 1);
        assert.ok(r.events[0].error instanceof Error);
    });
});

describe('#B1044 — dist pin', function () {

    it('07 - gina.min.js carries the schedule', function () {
        assert.match(minSrc, /\[\s*300\s*,\s*1E3\s*,\s*2500\s*\]/);
    });
});
