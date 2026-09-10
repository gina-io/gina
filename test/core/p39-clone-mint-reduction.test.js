'use strict';
/**
 * #P39 — render/request-path deep-clone & id-mint reduction (slice 1).
 *
 * The #P34 CPU baseline convicted per-request copy/id overhead as ~60% of
 * render-arm CPU: JSONClone alone was ~50%, 98.7% of it in three call paths —
 * ① SwigFilters.getInstance re-cloning the render's whole `local.options`
 *   into the filter singleton (which has NO writer beyond the stash itself),
 * ② the render delegates pre-cloning the same payload when calling the
 *   filter factory (a clone of a clone: the router already shallow-isolates
 *   the conf per request — the #B52-residual optimisation these clones were
 *   silently defeating),
 * ③ setOptions building two Collections per request over the boot-static
 *   region sets (a deep copy of ~500 nested records plus one uuid(16) —
 *   ~3 webcrypto calls — per record) to answer two lookups.
 *
 * Slice 1: ①/② stash and pass by REFERENCE (write-set measured empty; the
 * request path already shares conf.routing/reverseRouting/forms by reference,
 * so the filters see the same objects the controller uses and the
 * stash-then-await interleave window is unchanged); ③ is replaced by a
 * module-level memo + a lazily-materialized per-request `conf.locales` and a
 * per-request deep copy of the ONE resolved locale row; lib/uuid sizes its
 * random-byte batch to the requested length (uuid(16): 1 webcrypto call, was
 * ~3); the clone impl drops a dead per-recursion allocation.
 *
 * §01 — source pins on every touched site (each validated red-first against
 *       the pre-fix blobs: no-match PRE, match POST).
 * §02 — behavioral: the EXTRACTED shipped getInstance bytes stash by
 *       reference (identity assert — the arm that fails on the pre-fix
 *       bytes, where the stash is a clone).
 * §03 — behavioral: uuid output contract across sizes + webcrypto call
 *       count (1 call for uuid(16)).
 * §04 — behavioral: the EXTRACTED _defineLazyLocales accessor — lazy
 *       materialization, per-request isolation, self-replacement, and
 *       assign-through.
 *
 * Companion realignments (same slice, their own files): the #B101 lookup pin
 * + replica in controller-locale-fallback.test.js now lock the memoized
 * helper; nunjucks-filters.test.js locks the reference stash.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW        = require('../fw');
var GINA_ROOT = path.resolve(FW, '..', '..');

var CTRL_SRC  = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
var RSWIG_SRC = fs.readFileSync(path.join(FW, 'core/controller/controller.render-swig.js'), 'utf8');
var RNJK_SRC  = fs.readFileSync(path.join(FW, 'core/controller/controller.render-nunjucks.js'), 'utf8');
var SF_SRC    = fs.readFileSync(path.join(FW, 'lib/swig-filters/src/main.js'), 'utf8');
var NF_SRC    = fs.readFileSync(path.join(FW, 'lib/nunjucks-filters/src/main.js'), 'utf8');
var UUID_SRC  = fs.readFileSync(path.join(FW, 'lib/uuid/src/main.js'), 'utf8');
var CLONE_SRC = fs.readFileSync(path.join(GINA_ROOT, 'utils/prototypes.json_clone.js'), 'utf8');

var JSONClone = require(path.join(GINA_ROOT, 'utils/prototypes.json_clone.js'));
var uuid      = require(path.join(FW, 'lib/uuid/src/main.js'));

/** strip block + line comments so negative pins can't trip on prose */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Brace-matched extraction of a `var <name> = function(...) {...}` construct,
 * control-gated per the house extraction discipline: the declaration must
 * resolve exactly once and the brace walk must balance.
 */
function extractFn(src, decl) {
    var start = src.indexOf(decl);
    assert.ok(start > -1, 'extraction control: `' + decl.slice(0, 40) + '…` must exist');
    assert.equal(src.indexOf(decl, start + 1), -1, 'extraction control: the declaration must be unique');
    // Walk from the declaration regardless of whether it already carries the
    // opening brace — count from zero and stop when the first-opened block
    // closes (a decl-includes-brace assumption silently captures one block
    // too many when it does not).
    var i = start; // from the declaration itself — the decl text carries no stray braces
    var depth = 0, started = false;
    while (i < src.length) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') { depth--; }
        i++;
        if (started && depth === 0) { break; }
    }
    assert.ok(started, 'extraction control: an opening brace must follow the declaration');
    assert.equal(depth, 0, 'extraction control: braces must balance');
    var fnAt = start + src.slice(start).indexOf('function');
    return src.slice(fnAt, i);
}

// ─── 01 — source pins ────────────────────────────────────────────────────────
describe('#P39 §01 — the per-render clones are gone at every touched site', function () {

    it('render-swig passes the filter factory options by REFERENCE', function () {
        assert.match(RSWIG_SRC, /options\s*:\s*localOptions\s*,/,
            'the SwigFilters call must hand local.options through un-cloned');
        var block = stripComments(RSWIG_SRC);
        // #B514 re-anchor: the factory options moved out of the call into a
        // named `_renderCtx`, so the SAME object reaches SwigFilters() and
        // _renderALS.enterWith() and the two cannot drift apart. The #P39
        // contract is unchanged — no per-render clone in the factory options —
        // so this scans the literal that now carries them, and additionally
        // proves the factory receives that very object.
        var at  = block.indexOf('var _renderCtx = {');
        var end = block.indexOf('};', at);
        assert.ok(at > -1 && end > at, 'the render-context literal must resolve in comment-stripped code');
        assert.equal(block.slice(at, end).indexOf('JSON.clone'), -1,
            'no clone may sit in the factory call');
        assert.match(block, /var\s+filters\s*=\s*SwigFilters\(_renderCtx\)/,
            'the factory must receive that very object');
    });

    it('render-nunjucks passes the filter factory options by REFERENCE', function () {
        assert.match(RNJK_SRC, /options\s*:\s*localOptions\s*,/);
        var block = stripComments(RNJK_SRC);
        var at  = block.indexOf('var filters = nunjucksFilters({');
        var end = block.indexOf('});', at);
        assert.ok(at > -1 && end > at, 'the factory call block must resolve in comment-stripped code');
        assert.equal(block.slice(at, end).indexOf('JSON.clone'), -1);
    });

    it('SwigFilters.getInstance stashes by REFERENCE', function () {
        assert.match(SF_SRC, /SwigFilters\.instance\._options\s*=\s*conf\s*;/);
        var code = stripComments(SF_SRC);
        var gi  = code.indexOf('var getInstance = function()');
        var end = code.indexOf('return SwigFilters.instance', gi);
        assert.ok(gi > -1 && end > gi, 'getInstance body must resolve in comment-stripped code');
        assert.equal(code.slice(gi, end).indexOf('JSON.clone'), -1,
            'no clone may sit on the per-call stash path');
    });

    it('the nunjucks mirror is locked by its own realigned pin (cross-reference)', function () {
        // The authoritative pin lives in test/lib/nunjucks-filters.test.js
        // ("refreshes instance._options by REFERENCE on every call (#P39)").
        // This arm only keeps the two mirrors from silently diverging.
        assert.match(NF_SRC, /NunjucksFilters\.instance\._options\s*=\s*conf\s*;/);
    });

    it('uuid sizes the random-byte batch to the REQUESTED length', function () {
        assert.match(UUID_SRC, /var\s+step\s*=\s*\(\s*size\s*<=\s*4\s*\)\s*\?\s*_step\s*:\s*Math\.ceil\(\s*1\.6\s*\*\s*\(\s*_mask\s*\+\s*1\s*\)\s*\*\s*size\s*\/\s*_alphabet\.length\s*\)/,
            'the batch formula must match customAlphabet\'s sizing');
        assert.match(UUID_SRC, /new\s+Uint8Array\(\s*step\s*\)/,
            'the allocation must use the computed step');
        assert.match(UUID_SRC, /j\s*<\s*step\s*;\s*j\+\+/,
            'the consume loop must walk the computed step');
    });

    it('the clone impl carries no dead per-recursion key allocation', function () {
        var code  = stripComments(CLONE_SRC);
        var start = code.indexOf('function JSONClone(source, target)');
        var end   = code.indexOf('module.exports');
        assert.ok(start > -1 && end > start, 'the clone function body must resolve');
        assert.equal(code.slice(start, end).indexOf('Object.keys'), -1,
            'the dead Object.keys sibling allocation must stay gone');
        assert.ok(code.slice(start, end).indexOf('Object.getOwnPropertyNames') > -1,
            'the live property walk is untouched');
    });
});

// ─── 02 — behavioral: the shipped getInstance bytes stash by reference ──────
describe('#P39 §02 — the extracted getInstance stashes the ACTUAL wrapper object', function () {

    // The factories cannot be require()d standalone (module load reads
    // gna.js-injected globals), so the shipped bytes are extracted and driven
    // directly. A working JSON.clone is injected so the PRE-fix bytes run too
    // — that is what makes the identity assert a discriminating red-first arm
    // (a clone can never be reference-identical to its source).
    function driveGetInstance(src, singletonName) {
        var fnSrc = extractFn(stripComments(src), 'var getInstance = function()');
        var singleton = { instance: { _options: null } };
        var wrapper   = { options: { conf: { marker: 'X' } }, isProxyHost: false };
        var JSONShim  = Object.assign({}, JSON, { clone: JSONClone });
        var fn = new Function('conf', 'self', singletonName, 'JSON',
            'return (' + fnSrc + ');')(wrapper, { options: null }, singleton, JSONShim);
        var out = fn();
        return { singleton: singleton, wrapper: wrapper, out: out };
    }

    it('swig: instance._options IS the caller\'s wrapper (reference identity)', function () {
        var r = driveGetInstance(SF_SRC, 'SwigFilters');
        assert.equal(r.singleton.instance._options, r.wrapper,
            'the stash must be the wrapper itself — a clone cannot pass this');
        assert.equal(r.out, r.singleton.instance, 'getInstance returns the singleton');
    });

    it('nunjucks: instance._options IS the caller\'s wrapper (reference identity)', function () {
        var r = driveGetInstance(NF_SRC, 'NunjucksFilters');
        assert.equal(r.singleton.instance._options, r.wrapper);
    });
});

// ─── 03 — behavioral: uuid output contract + webcrypto call count ───────────
describe('#P39 §03 — uuid mints the same ids with fewer webcrypto calls', function () {

    it('output contract holds across sizes (length + base-62 alphabet)', function () {
        [4, 8, 16, 32].forEach(function (size) {
            for (var n = 0; n < 25; n++) {
                var id = uuid(size);
                assert.equal(id.length, size);
                assert.match(id, /^[0-9A-Za-z]+$/);
            }
        });
        assert.equal(uuid().length, 4, 'the default size is untouched');
    });

    it('uuid(16) costs ONE getRandomValues call', function () {
        // 27 random bytes yield ~26 usable chars (62/64 acceptance); the odds
        // of needing a second batch for 16 chars are < 1e-40 — treated as
        // deterministic, same probabilistic footing as the collection
        // collision suite. The spy preserves real entropy (delegates to the
        // original) so the output stays genuinely random.
        var desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        var real = globalThis.crypto;
        var calls = 0;
        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: {
                getRandomValues: function (arr) { calls++; return real.getRandomValues.call(real, arr); }
            }
        });
        try {
            var id = uuid(16);
            assert.equal(id.length, 16);
            assert.equal(calls, 1, 'a right-sized batch needs a single webcrypto call (was ~3)');
        } finally {
            Object.defineProperty(globalThis, 'crypto', desc);
        }
    });
});

// ─── 04 — behavioral: the lazy conf.locales accessor ────────────────────────
describe('#P39 §04 — conf.locales materializes lazily, per request, isolated', function () {

    var SRC_ROWS = [
        { isoShort: 'US', countryName: 'United States', currency: { alphacode: 'USD' } },
        { isoShort: 'CM', countryName: 'Cameroon',      currency: { alphacode: 'XAF' } }
    ];

    function makeConf() {
        var fnSrc = extractFn(stripComments(CTRL_SRC), 'var _defineLazyLocales = function(conf, srcRows) {');
        var JSONShim = Object.assign({}, JSON, { clone: JSONClone });
        var define = new Function('JSON', 'Object', 'return (' + fnSrc + ');')(JSONShim, Object);
        var conf = {};
        define(conf, SRC_ROWS);
        return conf;
    }

    it('before any read, `locales` is an enumerable ACCESSOR — nothing was copied yet', function () {
        var conf = makeConf();
        var d = Object.getOwnPropertyDescriptor(conf, 'locales');
        assert.equal(typeof d.get, 'function', 'lazy accessor expected before first read');
        assert.ok(d.enumerable, 'the key must stay visible to serializers and whole-conf clones');
        assert.ok(Object.keys(conf).indexOf('locales') > -1);
    });

    it('the first read materializes the request\'s OWN deep copy; later reads reuse it', function () {
        var conf  = makeConf();
        var first = conf.locales;
        assert.notEqual(first, SRC_ROWS, 'the materialized rows must not be the shared source');
        assert.deepEqual(first, SRC_ROWS, 'same content, own copy');
        assert.equal(conf.locales, first, 'the accessor must self-replace — one copy per request');
        var d = Object.getOwnPropertyDescriptor(conf, 'locales');
        assert.equal(d.get, undefined, 'after the read it is a plain value property');
    });

    it('mutating a request\'s copy never reaches the shared source or a sibling request', function () {
        var confA = makeConf();
        var confB = makeConf();
        confA.locales[0].currency.alphacode = 'MUTATED';
        confA.locales.push({ isoShort: 'ZZ' });
        assert.equal(SRC_ROWS[0].currency.alphacode, 'USD', 'the pristine source must never be touched');
        assert.equal(confB.locales.length, 2, 'a sibling request must get the pristine shape');
        assert.equal(confB.locales[0].currency.alphacode, 'USD');
    });

    it('assignment writes through, replacing the accessor with a plain value', function () {
        var conf = makeConf();
        conf.locales = [{ isoShort: 'FR' }];
        assert.equal(conf.locales.length, 1);
        assert.equal(conf.locales[0].isoShort, 'FR');
        var d = Object.getOwnPropertyDescriptor(conf, 'locales');
        assert.equal(d.get, undefined, 'assignment must leave a plain writable property');
        assert.ok(d.writable);
    });
});
