'use strict';
/**
 * The page.environment block computes three per-process values once (phase-2 per-request trims,
 * slice B).
 *
 * `setOptions` (core/controller/controller.js) fills page.environment on EVERY routed request of
 * a bundle with views — JSON, XML and stream routes included. Three of its values did work per
 * request for an answer that could not change:
 *   - `memory allocated` — the V8 heap limit, read through a `require('v8')` and a
 *     getHeapStatistics() call; the limit is fixed for the life of the process;
 *   - the `forms` whisper — the bundle's forms catalog (minus `mocks`, #B344) serialized and
 *     RFC 5987-encoded, 5–7 µs per KB of catalog; the catalog is built once per bundle load and
 *     the framework never writes it afterwards;
 *   - the date: `page.environment.date.now` and the locale's `date.now` each called
 *     `new Date().format("isoDateTime")`, so two calls per request that could straddle a
 *     second boundary.
 * Now the heap label is computed on the first render, the forms whisper is memoized per catalog
 * object (a WeakMap: a reloaded catalog is a new key), and one date stamp serves both fields.
 *
 *  §01 source pins — comment-stripped: the two module-scope memos, `require('v8')` only inside
 *      the heap memo's fill, a single `format("isoDateTime")` whose value both date fields read,
 *      and the forms block's memo lookup behind a `typeof` guard.
 *  §02 behavioural, the forms block — extracted between the anchors the #B344 test uses and
 *      compiled with `new Function('local', 'options', 'set', '_formsWhisperMemo', …)`: a second
 *      render with the same catalog reuses the encoded whisper without walking the catalog, each
 *      catalog object gets its own entry, and the memoized value is the #B344 export. Controls:
 *      without the memo in scope the block encodes every time (the #B344 harness's shape), and a
 *      missing catalog whispers `{}`.
 *  §03 behavioural, a real instance — the source under test is compiled AS controller.js and
 *      `setOptions` runs the env block three times (template + control, a minimal context), with
 *      `Date.prototype.format` and `v8.getHeapStatistics` counted: one date stamp per request,
 *      carried by the locale, and one heap read for the three requests. Controls: the block ran
 *      (the forms catalog is grafted, the locale is set) and the stubs were live.
 *
 * Seam: GINA_CONTROLLER_SRC=<file> runs every arm against that text. Red-first against
 * `git show HEAD:<fw>/core/controller/controller.js` (the pre-slice bytes): the §01 memo, heap,
 * date and forms pins, §02's two memo arms and §03's date and heap arms read RED; every control
 * stays GREEN.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var Module = require('module');

var FW     = require('../fw');
var REAL   = path.join(FW, 'core/controller/controller.js');
var SOURCE = process.env.GINA_CONTROLLER_SRC || REAL;

// the framework globals (encodeRFC5987ValueChars, Date.prototype.format, _(), the contexts),
// installed the way gna.js does at boot
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
Module._initPaths();
require(path.join(FW, 'helpers'));

var src = fs.readFileSync(SOURCE, 'utf8');
var active = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
    return !/^\s*\/\//.test(l);
}).join('\n');

function count(hay, needle) { return hay.split(needle).length - 1; }

// the #B344 test's anchors — byte-stable around the forms block
var START_ANCHOR = 'var forms = local.options.conf.forms = options.conf.content.forms';
var END_ANCHOR   = "set('page.forms', options.conf.content.forms);";
function formsSpan(text) {
    var s = text.indexOf(START_ANCHOR), e = text.indexOf(END_ANCHOR);
    assert.ok(s > -1 && e > s, 'the forms block anchors are present, in order');
    return text.slice(s, e + END_ANCHOR.length);
}

describe('§01 source pins — three values computed once', function () {

    it('anti-vacuity: the strip removed comment text and kept the code', function () {
        assert.ok(active.length < src.length);
        assert.ok(active.indexOf('function SuperController(') > -1);
        assert.ok(active.indexOf('this.setOptions = function(req, res, next, options) {') > -1);
    });

    it('both memos are declared once, at module scope', function () {
        var ctor = active.indexOf('function SuperController(');
        var heap = active.indexOf('var _heapLimitLabel = null;');
        var forms = active.indexOf('var _formsWhisperMemo = new WeakMap();');
        assert.ok(heap > -1 && heap < ctor, 'the heap label memo sits above the constructor');
        assert.ok(forms > -1 && forms < ctor, 'the forms whisper memo sits above the constructor');
        assert.equal(count(active, 'var _heapLimitLabel = null;'), 1);
        assert.equal(count(active, 'var _formsWhisperMemo = new WeakMap();'), 1);
    });

    it("require('v8') runs only inside the heap memo's fill", function () {
        assert.equal(count(active, "require('v8')"), 1, "one require('v8') in code");
        var fill = active.indexOf('if (_heapLimitLabel === null) {');
        assert.ok(fill > -1, 'the fill guard exists');
        var close = active.indexOf('}', fill);
        var v8At = active.indexOf("require('v8')");
        assert.ok(v8At > fill && v8At < close, "require('v8') sits inside the fill");
        assert.equal(count(active, "set('page.environment.memory allocated', _heapLimitLabel);"), 1);
    });

    it('one date stamp per request, read by both date fields', function () {
        assert.equal(count(active, 'new Date().format("isoDateTime")'), 1, 'one call');
        assert.equal(count(active, 'var _nowIso = new Date().format("isoDateTime");'), 1);
        assert.equal(count(active, "set('page.environment.date.now', _nowIso);"), 1);
        assert.ok(/options\.conf\.locale\.date\s*=\s*\{\s*now:\s*_nowIso\s*\}/.test(active), "the locale's date.now reads the stamp");
    });

    it('the forms block looks the whisper up in the memo, behind a typeof guard', function () {
        var span = formsSpan(active);
        assert.ok(span.indexOf("typeof(_formsWhisperMemo) != 'undefined'") > -1, 'the guard');
        assert.ok(span.indexOf('_formsWhisperMemo.get(_formsWhisperKey)') > -1, 'the lookup');
        assert.ok(span.indexOf('_formsWhisperMemo.set(_formsWhisperKey, _formsWhisper);') > -1, 'the fill');
        assert.equal(count(active, "set('page.environment.forms', _formsWhisper);"), 1, 'the whisper reads the memoized value');
    });
});

describe('§02 behavioural — the forms block, extracted', function () {

    var span = null;
    before(function () { span = formsSpan(active); });

    function run(catalog, memo) {
        var captured = {};
        var set = function (k, v) { captured[k] = v; };
        var local = { options: { conf: {} } };
        var options = { conf: { content: { forms: catalog } } };
        new Function('local', 'options', 'set', '_formsWhisperMemo', span)(local, options, set, memo);
        return captured['page.environment.forms'];
    }

    // a catalog whose `validators` group counts its reads — the block's copy loop is the only reader
    function countingCatalog(counter) {
        var c = {
            rules: { signup: { email: { isRequired: true, isEmail: true } } },
            mocks: { signup: { email: 'sample@fixture.test' } }
        };
        Object.defineProperty(c, 'validators', {
            enumerable: true,
            get: function () { counter.reads++; return { myValidator: 'function (value) { return true; }' }; }
        });
        return c;
    }

    it('a second render with the same catalog reuses the encoded whisper without walking the catalog', function () {
        var counter = { reads: 0 }, memo = new WeakMap(), c = countingCatalog(counter);
        var w1 = run(c, memo), w2 = run(c, memo);
        assert.equal(w2, w1, 'the same whisper');
        assert.equal(counter.reads, 1, 'the catalog was walked once');
        assert.ok(memo.has(c), 'the catalog object is the key');
    });

    it('each catalog object gets its own entry', function () {
        var memo = new WeakMap();
        var a = { rules: { a: { x: { isRequired: true } } } };
        var b = { rules: { b: { y: { isEmail: true } } } };
        var wa = run(a, memo), wb = run(b, memo);
        assert.ok(memo.has(a) && memo.has(b), 'two entries');
        assert.notEqual(wa, wb);
        assert.equal(run(a, memo), wa, 'a is still answered from its own entry');
    });

    it('control: the memoized whisper is the #B344 export — mocks excluded, a direct encode of the copy', function () {
        var counter = { reads: 0 }, memo = new WeakMap(), c = countingCatalog(counter);
        run(c, memo);
        var w = run(c, memo);
        var parsed = JSON.parse(decodeURIComponent(w));
        assert.equal(typeof parsed.mocks, 'undefined', 'mocks stay out of the whisper');
        assert.equal(w, encodeRFC5987ValueChars(JSON.stringify({ rules: c.rules, validators: { myValidator: 'function (value) { return true; }' } })));
    });

    it('control: without the memo in scope the block encodes on every render', function () {
        var counter = { reads: 0 }, c = countingCatalog(counter);
        var w1 = run(c, undefined), w2 = run(c, undefined);
        assert.equal(w2, w1);
        assert.equal(counter.reads, 2, 'walked on each render');
    });

    it('control: a missing catalog whispers {} and throws nothing', function () {
        var memo = new WeakMap();
        assert.deepEqual(JSON.parse(decodeURIComponent(run(undefined, memo))), {});
    });
});

describe('§03 behavioural — a real instance runs the env block three times', function () {

    var rec = null, restore = [];

    before(function () {
        var prevEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'prod';
        restore.push(function () { if (typeof prevEnv == 'undefined') { delete process.env.NODE_ENV; } else { process.env.NODE_ENV = prevEnv; } });
        process.gina = process.gina || {};
        setPath('gina', { core: path.join(FW, 'core') });
        setContext('gina', {
            version: '0.0.0-test', middleware: 'isaac',
            config: { envConf: {
                demo: { prod: { bundle: 'demo', hostname: 'http://localhost:3100', host: 'localhost',
                                server: { webroot: '/', protocol: 'http/1.1', scheme: 'http', port: 3100 },
                                port: { 'http/1.1': { http: 3100 } } } },
                routing: {}, reverseRouting: {}, _isRoutingUpdateNeeded: false
            } },
            // one language row, so `accept-language: en-US` below resolves a locale row
            // deterministically (no fallback warn, whatever the environment's culture)
            locales: [{ lang: 'en', content: [{ isoShort: 'US', name: 'United States' }] }]
        });

        // a fresh copy of the source under test, compiled as controller.js (its relative
        // requires resolve from core/controller/) and never cached — its memos start empty
        var m = new Module(REAL, null);
        m.filename = REAL;
        m.paths = Module._nodeModulePaths(path.dirname(REAL));
        m._compile(src, REAL);
        var SuperController = m.exports;

        // Date.prototype.format is installed non-writable but configurable: stub it through
        // defineProperty, counting only the `isoDateTime` mask, and restore the exact descriptor
        var stamps = 0, fmtDesc = Object.getOwnPropertyDescriptor(Date.prototype, 'format');
        Object.defineProperty(Date.prototype, 'format', {
            configurable: true, enumerable: false, writable: false,
            value: function (mask) {
                if (mask === 'isoDateTime') { stamps++; return 'STAMP-' + stamps; }
                return fmtDesc.value.apply(this, arguments);
            }
        });
        restore.push(function () { Object.defineProperty(Date.prototype, 'format', fmtDesc); });
        var v8 = require('v8'), heapReads = 0, origHeap = v8.getHeapStatistics;
        v8.getHeapStatistics = function () { heapReads++; return origHeap.apply(this, arguments); };
        restore.push(function () { v8.getHeapStatistics = origHeap; });

        rec = { perRequest: [], heapReads: 0 };
        for (var i = 0; i < 3; i++) {
            var catalog = { rules: { signup: { email: { isRequired: true } } } };
            var o = {
                rule: 'home@demo', control: 'home', namespace: 'content', renderingStack: [], method: 'GET',
                controller: '/srv/app/src/demo/controllers/controller.content.js',
                template: { html: '/srv/app/src/demo/templates/html', templates: '/srv/app/src/demo/templates',
                            layout: '/srv/app/src/demo/templates/html/layouts/main.html', ext: 'html' },
                conf: {
                    bundle: 'demo', projectName: 'test', env: 'prod', bundlesPath: '/srv/app/src',
                    encoding: 'utf-8', renderingStack: [],
                    server: { engine: 'isaac', protocol: 'http/1.1', scheme: 'http', port: 3100, debugPort: 9229, webroot: '/',
                              response: { header: {} }, cache: { ttl: 3600 },
                              coreConfiguration: { statusCodes: { '500': 'Internal Server Error' },
                                                   mime: { json: 'application/json', html: 'text/html' } } },
                    content: { templates: { _common: {} }, settings: {}, forms: catalog,
                               routing: { 'home@demo': { url: '/', param: { control: 'home' } } } }
                }
            };
            var req = { url: '/', method: 'GET', httpVersion: '1.1', headers: { 'accept-language': 'en-US' }, params: {}, get: {},
                        routing: { rule: 'home@demo', param: { control: 'home' } },
                        getParams: function () { return {}; } };
            var res = { statusCode: 200, headersSent: false, getHeaders: function () { return {}; },
                        getHeader: function () {}, setHeader: function () {}, writeHead: function () {}, end: function () {} };
            // createTestInstance() runs setOptions() right after construction, before a caller can
            // attach the serverInstance the env block reads — so its two steps, with one in between
            var inst = new SuperController(o);
            inst._isTestInstance = true;
            inst.serverInstance = { _cacheIsEnabled: false };
            var before = stamps;
            inst.setOptions(req, res, function () {}, o);
            rec.perRequest.push({ stamps: stamps - before, lastStamp: 'STAMP-' + stamps, locale: o.conf.locale,
                                  forms: o.conf.forms, catalog: catalog });
        }
        rec.heapReads = heapReads;
    });

    after(function () { while (restore.length) { restore.pop()(); } });

    it('control: the env block ran for each request (catalog grafted, locale row resolved)', function () {
        assert.equal(rec.perRequest.length, 3);
        rec.perRequest.forEach(function (r) {
            assert.equal(r.forms, r.catalog, 'setOptions grafted the forms catalog');
            assert.ok(r.locale && r.locale.isoShort === 'US', 'setOptions resolved the en-US locale row');
        });
    });

    it('control: the date stub was live', function () {
        rec.perRequest.forEach(function (r) { assert.ok(r.stamps >= 1); });
    });

    it('one date stamp per request, and the locale carries it', function () {
        rec.perRequest.forEach(function (r) {
            assert.equal(r.stamps, 1, 'one format("isoDateTime") per request');
            assert.deepEqual(r.locale.date, { now: r.lastStamp });
        });
    });

    it('the heap limit is read once for the three requests', function () {
        assert.equal(rec.heapReads, 1);
    });
});
