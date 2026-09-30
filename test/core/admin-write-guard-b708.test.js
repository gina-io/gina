'use strict';
/**
 * #B708 — the cross-origin WRITE guard (#B384) must match wherever a `/_gina/*` WRITE
 * handler matches, on both engines.
 *
 * #B384 put one guard per engine above every `/_gina/*` handler, so current and future
 * handlers would inherit the refusal. Placement was not enough: the guard's URL test was
 * narrower than the handlers it fronts. The unanchored handlers (cache/clear, maintenance,
 * instrument) test the FULL url, so a path prefix (`/web/_gina/…`, `//_gina/…`) and the
 * endpoint path at the END of the query string (`/?next=/_gina/maintenance`) reached them;
 * cache/clear, storage/* and release/* match in any case (`/_GINA/storage/gc`). Each such
 * cross-site request reached its handler without meeting the guard (driven live on isaac,
 * dev and prod — the live twin is test/integration/container-boot-admin-guard-b708.test.js).
 *
 * This file reads both engine sources, extracts the guard's URL regex and every
 * `/_gina/` handler regex whose condition admits a non-safe method, and asserts over a
 * corpus of URL shapes that the guard matches every URL a write handler matches. A future
 * write handler with a looser matcher is picked up by the extraction and turns this red.
 *
 * Seams — run the whole file against other bytes (red-first, no tree revert):
 *   GINA_B708_SERVER_SRC=<core/server.js copy>  GINA_B708_ISAAC_SRC=<core/server.isaac.js copy>
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW = require('../fw');

var SOURCES = [
    { name: 'core/server.js',       file: process.env.GINA_B708_SERVER_SRC || path.join(FW, 'core/server.js'),
      expectWrites: ['cache/clear', 'storage/gc', 'release/rebuild', 'maintenance', 'instrument'] },
    { name: 'core/server.isaac.js', file: process.env.GINA_B708_ISAAC_SRC  || path.join(FW, 'core/server.isaac.js'),
      expectWrites: ['cache/clear', 'release/rebuild', 'maintenance', 'instrument'] }
];

/** Methods that cannot mutate state — mirrors lib/admin SAFE_HTTP_METHODS. */
var SAFE = { GET: true, HEAD: true, OPTIONS: true, TRACE: true };

/** A regex literal applied to `request.url` with `.test(…)`, on one line. */
var LITERAL_RE = /\/((?:\\\/|[^\/\n])+)\/([dgimsuvy]*)\.test\(request\.url\)/g;

/**
 * Every `/_gina/` regex literal tested against `request.url`, with the full `if ( … ) {`
 * condition it sits in.
 *
 * @param {string} src engine source
 * @returns {Array<{index:number, source:string, flags:string, regex:RegExp, condition:string}>}
 */
function extractMatchers(src) {
    var out = [], m;
    LITERAL_RE.lastIndex = 0;
    while ( (m = LITERAL_RE.exec(src)) !== null ) {
        if ( m[1].indexOf('_gina') < 0 ) { continue; }
        var ifRe = /\bif\s*\(/g, ifAt = -1, f;
        while ( (f = ifRe.exec(src)) !== null && f.index < m.index ) { ifAt = f.index; }
        var end = src.indexOf(') {', m.index + m[0].length);
        out.push({
            index     : m.index,
            source    : m[1],
            flags     : m[2],
            regex     : new RegExp(m[1], m[2]),
            condition : (ifAt > -1 && end > -1) ? src.slice(ifAt, end + 3) : ''
        });
    }
    return out;
}

/** The HTTP methods a handler condition compares against (upper-case). */
function methodsOf(condition) {
    var re = /request\.method\.toUpperCase\(\)\s*===\s*'([A-Z]+)'/g, m, out = [];
    while ( (m = re.exec(condition)) !== null ) { out.push(m[1]); }
    return out;
}

/** True when the condition admits a non-safe method (or names no method at all). */
function admitsWrite(condition) {
    var methods = methodsOf(condition);
    if ( methods.length === 0 ) { return true; }
    return methods.some(function (x) { return !SAFE[x]; });
}

/** The endpoint path a handler regex names, unescaped (`cache/clear`, `maintenance`). */
function endpointOf(source) {
    var m = source.match(/_gina\\\/((?:[A-Za-z0-9_-]|\\\/|\\\.)+)/);
    return m ? m[1].replace(/\\\//g, '/').replace(/\\\./g, '.') : null;
}

/** The URL shapes tried for one endpoint path. */
function corpus(ep) {
    return [
        '/_gina/' + ep,
        '/_gina/' + ep + '?x=1',
        '/web/_gina/' + ep,
        '/zzz/_gina/' + ep,
        '//_gina/' + ep,
        '/web//_gina/' + ep + '?y=2',
        '/_GINA/' + ep,
        '/_Gina/' + ep,
        '/_gina/' + ep.toUpperCase(),
        '/?next=/_gina/' + ep,
        '/app/page?a=1&next=/_gina/' + ep,
        '/web/?next=/_GINA/' + ep
    ];
}

/** The engine's guard: the matcher whose condition calls lib.admin.isCrossOriginWrite. */
function guardOf(matchers) {
    return matchers.filter(function (x) { return x.condition.indexOf('lib.admin.isCrossOriginWrite(request)') > -1; });
}

SOURCES.forEach(function (engine, n) {
    var src      = fs.readFileSync(engine.file, 'utf8');
    var matchers = extractMatchers(src);
    var guards   = guardOf(matchers);
    var guard    = guards[0];
    var writes   = matchers.filter(function (x) { return guards.indexOf(x) < 0 && admitsWrite(x.condition); });

    describe('0' + (n + 1) + ' - ' + engine.name + ' — the cross-origin write guard covers every /_gina/* write handler (#B708)', function () {

        // ── controls: the extraction found what it must, or every arm below is vacuous ──

        it('0' + (n + 1) + '.01  exactly one guard, and it is the #B384 guard (safe-method exemption + cross-origin check)', function () {
            assert.equal(guards.length, 1, 'guard matchers found: ' + guards.length);
            assert.ok(guard.condition.indexOf('!lib.admin.isSafeMethod(request.method)') > -1, guard.condition);
        });

        it('0' + (n + 1) + '.02  the extraction finds every known write handler', function () {
            var found = writes.map(function (x) { return endpointOf(x.source); });
            engine.expectWrites.forEach(function (ep) {
                assert.ok(found.indexOf(ep) > -1, 'write handler `' + ep + '` not extracted; found: ' + JSON.stringify(found));
            });
        });

        it('0' + (n + 1) + '.03  GET-only handlers are not classified as writes (the method classifier discriminates)', function () {
            var info = matchers.filter(function (x) { return endpointOf(x.source) === 'info'; });
            assert.equal(info.length, 1, 'the /_gina/info matcher must be extracted exactly once');
            assert.equal(admitsWrite(info[0].condition), false, info[0].condition);
            assert.ok(writes.length >= engine.expectWrites.length);
        });

        it('0' + (n + 1) + '.04  the guard does not match a plain app URL (it is not a catch-all)', function () {
            ['/', '/web/', '/api/x', '/web/page?next=/home', '/_ginax/maintenance', '/gina/maintenance'].forEach(function (u) {
                assert.equal(guard.regex.test(u), false, 'guard matched ' + u);
            });
        });

        it('0' + (n + 1) + '.05  the guard sits above every write handler', function () {
            writes.forEach(function (x) {
                assert.ok(guard.index < x.index, 'write handler `' + endpointOf(x.source) + '` sits above the guard');
            });
        });

        // ── the property: every URL a write handler matches, the guard matches ──

        engine.expectWrites.forEach(function (ep, i) {
            it('0' + (n + 1) + '.1' + i + '  `' + ep + '` — every URL shape the handler accepts meets the guard', function () {
                var handler = writes.filter(function (x) { return endpointOf(x.source) === ep; })[0];
                assert.ok(handler, 'no write handler for ' + ep);
                assert.ok(handler.regex.test('/_gina/' + ep), 'control: the handler accepts its canonical URL');
                var escaped = corpus(ep).filter(function (u) { return handler.regex.test(u) && !guard.regex.test(u); });
                assert.deepEqual(escaped, [], '`' + ep + '` accepts URLs the guard (/' + guard.source + '/' + guard.flags + ') misses');
            });
        });

        it('0' + (n + 1) + '.20  any other write handler found by the extraction is covered too', function () {
            var extra = writes.filter(function (x) { return engine.expectWrites.indexOf(endpointOf(x.source)) < 0; });
            extra.forEach(function (x) {
                var ep = endpointOf(x.source);
                var escaped = corpus(ep || 'x').filter(function (u) { return x.regex.test(u) && !guard.regex.test(u); });
                assert.deepEqual(escaped, [], 'write handler /' + x.source + '/' + x.flags + ' accepts URLs the guard misses');
            });
        });
    });
});
