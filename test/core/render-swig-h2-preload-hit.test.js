'use strict';
/**
 * #B495 — the http/2 `link` preload header is emitted on a compiled-template cache HIT.
 *
 * Measured on isolated prod h2 boots (`todo/b495-harness/`): with `server.cache.enable: true`
 * the first request of a view answered with a 270-byte `link: …; rel=preload` header and every
 * later request with none — the cache-hit branch returns before the compile path's http/2
 * block, which is the only place the header was built. With the cache off (the control) all
 * three requests carried it. Nothing compensated: `early103: []` in both arms.
 *
 * Fix: the compile path assembles the header through a module-scope, parameters-only helper
 * (`buildH2PreloadLinks`) and memoises it — together with the parsed `getAssets()` map — on
 * the compiled-template cache entry (`cacheObject.h2Link` / `.assets`); the hit path reads the
 * entry once, re-hydrates `localOptions.template.assets` from it (the router clones options per
 * request, so the map a compile wrote to that clone died with the request — #B490's hit-path
 * gap, measured: `view.assets` absent on hits) and emits the memoised header under the compile
 * path's own gates (`!XHR && !dev`). An XHR request computes the map + header when the cache is
 * on — the entry is shared with every later render of the view, navigation included (measured:
 * an XHR render populates the same entry) — and skips the block as before when it is off.
 *
 * What this file pins and what it cannot: §01 pins the wiring in the source (every discriminating
 * pin run RED against the pre-change bytes through the GINA_RENDER_SWIG_SRC seam); §02 extracts
 * the shipped helper and drives it, including a differential arm against the compile path's
 * former inline loop frozen as a fixture; §03 executes the extracted hit-path slices (emission
 * gate, re-hydration, the XHR compute gate) against truth tables. The live restoration — a real
 * h2 cache hit carrying the header, and `view.assets` on a hit — is the boot arm recorded in the
 * #B495 ledger row, not a unit arm.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var path = require('path');

var FW     = require('../fw');
// Module-path seam (the freeze test's): point the whole file at a pre-change copy.
var SOURCE = process.env.GINA_RENDER_SWIG_SRC || path.join(FW, 'core/controller/controller.render-swig.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');

var BANNER = '// ---- #B464 - module-scope helpers for the post-execute Inspector data splice ----';
var EO     = "} // EO String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'";

function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/mg, '');
}
function count(haystack, needle) { return haystack.split(needle).length - 1; }

/**
 * Started-flag brace walk from a line-anchored declaration; both controls kept
 * (declared exactly once, braces balanced). Safe here: the helper carries no
 * brace inside a string or regex literal.
 * @inner
 */
function extractFunction(src, name) {
    var re = new RegExp('^function ' + name + '\\(', 'mg');
    var m = re.exec(src);
    assert.ok(m, name + ' must be declared at module scope to extract');
    assert.strictEqual(re.exec(src), null, name + ' must be declared exactly once');
    var depth = 0, started = false, i = m.index;
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    assert.strictEqual(depth, 0, 'balanced braces');
    return src.slice(m.index, i);
}

/** Slice a unique literal out of the source (uniqueness-guarded). @inner */
function uniqueSlice(src, literal) {
    var at = src.indexOf(literal);
    assert.ok(at > -1, 'slice literal must be present: ' + literal.slice(0, 60));
    assert.strictEqual(src.indexOf(literal, at + 1), -1, 'slice literal must be unique: ' + literal.slice(0, 60));
    return literal;
}

var MAP = {
    '/css/main.css'   : { as: 'style',  isAvailable: true },
    '/js/app.js'      : { as: 'script', isAvailable: true },
    '_classes'        : ['a', 'b'],
    '_cssassets'      : {},
    '/img/hero.webp'  : { as: 'image',  isAvailable: true, imagesrcset: '/img/hero-2x.webp 2x', imagesizes: '100vw' },
    '/gone.js'        : { as: 'script', isAvailable: false },
    '/noas.css'       : { isAvailable: true },
    '/manifest.json'  : { as: 'null',   isAvailable: false },
    '/blank.js'       : { as: '',       isAvailable: true }
};
var PREFIX = '</css/vendor/gina/gina.min.css>; as=style; rel=preload,';

// ─── 01 — source pins ─────────────────────────────────────────────────────────

describe('01 - #B495 source pins: the entry carries the memo, the hit path emits it, the compile path feeds it', function () {
    var stripped;
    before(function () { stripped = stripComments(SRC); });

    it('the strip is load-bearing: the raw source names #B495 in a comment and the stripped copy does not', function () {
        assert.ok(count(SRC, '#B495') >= 1, 'the raw source names #B495 in a comment');
        assert.strictEqual(count(stripped, '#B495'), 0, 'the strip removed the #B495 comments');
    });

    it('the compile path memoises the header and the map on the compiled-template cache entry', function () {
        var re = /cacheObject = \{\s*template\s*:\s*compiledTemplate,\s*h2Link\s*:\s*_h2PreloadLinks,\s*assets\s*:\s*\([^\n]{0,200}\)\s*\?\s*localOptions\.template\.assets\s*:\s*null\s*\};/;
        assert.ok(re.test(stripped), 'cacheObject carries template + h2Link + assets');
        // writeCache() builds its own `cacheObject = {` for the output cache — anchor on the entry's first field
        assert.strictEqual(count(stripped, 'template : compiledTemplate,'), 1, 'one compiled-template entry shape');
    });

    it('the hit path reads the entry once, after the compiled template, and re-hydrates the per-request template clone', function () {
        var tpl   = stripped.indexOf('compiledTemplate = cache.get(cacheKey).template;');
        var entry = stripped.indexOf('var _swigEntry = cache.get(cacheKey);');
        var rehyd = stripped.indexOf('localOptions.template.assets = _swigEntry.assets;');
        var eo    = stripped.indexOf(EO);
        assert.ok(tpl > -1 && entry > -1 && rehyd > -1 && eo > -1, 'all four anchors present');
        assert.strictEqual(count(stripped, 'var _swigEntry = cache.get(cacheKey);'), 1, 'one entry read');
        assert.ok(entry > tpl && rehyd > entry && rehyd < eo, 'template read → entry read → re-hydration, all inside the hit block');
        assert.ok(stripped.indexOf("if ( localOptions.template && _swigEntry.assets && typeof(localOptions.template.assets) == 'undefined' )") > -1, 'the re-hydration never clobbers a same-request map');
    });

    it("the hit path emits the memoised header under the compile path's gates, inside the hit block", function () {
        var lit = "if ( _swigEntry.h2Link && !self.isXMLRequest() && !self.isCacheless() ) {\n                    res.setHeader('link', _swigEntry.h2Link);";
        var at  = stripped.indexOf(lit);
        assert.ok(at > -1, 'the hit-path emission is present with its three gates');
        assert.ok(at < stripped.indexOf(EO), 'and it sits before the hit block closes');
        assert.strictEqual(count(stripped, "res.setHeader('link'"), 2, 'exactly two link-header sites: hit + compile');
        assert.ok(stripped.indexOf("res.setHeader('link'") < stripped.indexOf(EO), 'the first of them is the hit-path one');
    });

    it('the compile-path block computes for an XHR request only when the compiled-template cache is on', function () {
        assert.strictEqual(count(stripped, "&& ( !self.isXMLRequest() || String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true' )"), 1, 'the cache-on-gated XHR clause');
        assert.strictEqual(count(stripped, "if ( !self.isXMLRequest() && /http\\/2/.test(localOptions.conf.server.protocol) ) {"), 0, 'the old combined gate is gone');
        // premise — green on both revisions: the protocol test is the block's own gate in both shapes
        // (pre: `…protocol) ) {` inside the combined condition; post: `…protocol)\n && (`). The bare
        // literal occurs at three unrelated sites in the file, so it is anchored on what follows it.
        assert.match(stripped, /\/http\\\/2\/\.test\(localOptions\.conf\.server\.protocol\)\s*(\)\s*\{|&&\s*\()/, 'the protocol gate still guards the block');
    });

    it('the compile path assembles through the helper, gates only the emission, and the inline loop is retired', function () {
        assert.strictEqual(count(stripped, '_h2PreloadLinks = buildH2PreloadLinks(localOptions.template.h2Links, localOptions.template.assets);'), 1, 'one assembly call');
        assert.strictEqual(count(stripped, 'if ( !self.isXMLRequest() && !self.isCacheless() && _h2PreloadLinks ) {'), 1, 'the compile-path emission gate');
        assert.strictEqual(count(stripped, 'for (let l in localOptions.template.assets)'), 0, 'the inline loop is gone from render()');
        assert.strictEqual(count(stripped, 'var links = localOptions.template.h2Links;'), 0, 'and so is its seed');
        assert.strictEqual(count(stripped, ', _h2PreloadLinks   = null'), 1, 'the render-scoped memo is declared in the var list');
    });

    it('the helper is declared once at module scope, after the #B464 banner, and reads nothing from render()', function () {
        var fn = extractFunction(stripped, 'buildH2PreloadLinks');
        assert.ok(stripped.indexOf('function buildH2PreloadLinks(') > stripped.indexOf(BANNER), 'declared in the module-scope helper region');
        ['self.', 'local.', 'localOptions', 'req.', 'res.', 'cache.'].forEach(function (tok) {
            assert.strictEqual(count(fn, tok), 0, 'the helper must not read `' + tok + '` — parameters only');
        });
    });

    it('premise (green on both revisions): the getAssets call, its parse, and its error path are untouched', function () {
        // #B1131 — the call's argument is the layout whispered with every value (pinned in
        // render-swig-whisper-per-request-b1131.test.js); here, the one call
        assert.strictEqual(count(stripped, 'assets = self.serverInstance.getAssets(localOptions.conf, '), 1, 'one getAssets call');
        assert.strictEqual(count(stripped, 'localOptions.template.assets = JSON.parse(assets);'), 1, 'one parse');
        assert.strictEqual(count(stripped, 'calling getAssets'), 1, 'the 500 path still names getAssets');
        assert.strictEqual(count(stripped, 'cache.get(cacheKey).template'), 1, 'the compiled-template read is unchanged');
    });
});

// ─── 02 — the helper, extracted and driven ───────────────────────────────────

describe('02 - buildH2PreloadLinks: the shipped bytes, driven', function () {
    var build;
    before(function () {
        var fn = extractFunction(SRC, 'buildH2PreloadLinks');
        build = new Function('return (' + fn + ');')();
    });

    it('prefix only — the trailing comma getNodeRes() leaves is trimmed', function () {
        assert.strictEqual(build(PREFIX, undefined), PREFIX.slice(0, -1));
        assert.strictEqual(build(PREFIX, null), PREFIX.slice(0, -1));
    });
    it('nothing at all → the empty string (callers send no header then)', function () {
        assert.strictEqual(build(undefined, undefined), '');
        assert.strictEqual(build('', {}), '');
    });
    it('a realistic map: qualifying entries appended in map order, metadata and unavailable/as-less entries skipped', function () {
        var out = build(PREFIX, MAP);
        assert.strictEqual(out,
            PREFIX
            + '</css/main.css>; as=style; rel=preload,'
            + '</js/app.js>; as=script; rel=preload,'
            + '</img/hero.webp>; as=image; imagesrcset=/img/hero-2x.webp 2x; imagesizes=100vw; rel=preload,'
            // parity with the former inline loop: an `as` of the STRING 'null' bypasses the
            // isAvailable check (the `link.as != 'null'` clause) and is emitted as-is
            + '</manifest.json>; as=null; rel=preload');
        assert.strictEqual(count(out, '_classes'), 0, 'metadata keys never emit');
        assert.strictEqual(count(out, '/gone.js'), 0, 'an unavailable asset never emits');
        assert.strictEqual(count(out, '/noas.css'), 0, 'an entry without `as` never emits');
        assert.strictEqual(count(out, '/blank.js'), 0, 'a falsy `as` never emits');
        assert.ok(!/,$/.test(out), 'no trailing comma');
    });
    it('a map without a prefix (h2Links undefined outside http/2) still assembles', function () {
        assert.strictEqual(build(undefined, { '/a.css': { as: 'style', isAvailable: true } }), '</a.css>; as=style; rel=preload');
    });
    it('is pure: the same inputs give the same string, and the map is not mutated', function () {
        var snapshot = JSON.stringify(MAP);
        assert.strictEqual(build(PREFIX, MAP), build(PREFIX, MAP));
        assert.strictEqual(JSON.stringify(MAP), snapshot);
    });

    // Differential control: the compile path's former INLINE loop (controller.render-swig.js
    // at 32f8e4646, lines 1715-1742), frozen here as a fixture — not a replica of live code —
    // so the lift can be shown behaviour-preserving over a matrix.
    var FORMER_LOOP = [
        "var links = localOptions.template.h2Links;",
        "for (let l in localOptions.template.assets) {",
        "    let link = localOptions.template.assets[l]",
        "    if (",
        "        /^_/.test(l)",
        "        || typeof(link.as) == 'undefined'",
        "        || typeof(link.as) != 'undefined'",
        "            && link.as != 'null'",
        "            && !link.isAvailable",
        "        || !link.as",
        "    ) {",
        "        continue;",
        "    }",
        "    links += '<'+ l +'>; as='+ link.as +'; '",
        "    if ( link.imagesrcset) {",
        "        links += 'imagesrcset='+ link.imagesrcset +'; ';",
        "    }",
        "    if ( link.imagesizes) {",
        "        links += 'imagesizes='+ link.imagesizes +'; ';",
        "    }",
        "    links += 'rel=preload,'",
        "}",
        "if ( /\\,$/.test(links) ) {",
        "    links = links.substring(0, links.length-1);",
        "}",
        "return links;"
    ].join('\n');
    it('differential: the helper reproduces the former inline loop byte-for-byte over a matrix', function () {
        var former = new Function('localOptions', FORMER_LOOP);
        var cases = [
            [PREFIX, MAP],
            ['', MAP],
            [PREFIX, { '/x.js': { as: 'script', isAvailable: true } }],
            [PREFIX, { '_only': {} }],
            ['</p.css>; as=style; rel=preload,', {}]
        ];
        cases.forEach(function (c) {
            assert.strictEqual(build(c[0], c[1]), former({ template: { h2Links: c[0], assets: c[1] } }), 'case ' + JSON.stringify(c[0]).slice(0, 30));
        });
    });
});

// ─── 03 — the extracted hit-path slices against truth tables ─────────────────

describe('03 - the hit-path emission gate, the re-hydration and the XHR compute gate, executed from the source', function () {
    it('the hit path sets the header exactly when the entry has one AND the request is neither XHR nor dev', function () {
        var slice = uniqueSlice(SRC, "if ( _swigEntry.h2Link && !self.isXMLRequest() && !self.isCacheless() ) {\n                    res.setHeader('link', _swigEntry.h2Link);\n                }");
        var run = new Function('_swigEntry', 'self', 'res', slice);
        [true, false].forEach(function (xhr) {
            [true, false].forEach(function (dev) {
                ['</a.css>; as=style; rel=preload', '', null].forEach(function (h2Link) {
                    var set = [];
                    run({ h2Link: h2Link }, { isXMLRequest: function () { return xhr; }, isCacheless: function () { return dev; } }, { setHeader: function (k, v) { set.push([k, v]); } });
                    var expected = (!!h2Link && !xhr && !dev) ? 1 : 0;
                    assert.strictEqual(set.length, expected, 'xhr=' + xhr + ' dev=' + dev + ' h2Link=' + JSON.stringify(h2Link));
                    if (expected) assert.deepStrictEqual(set[0], ['link', h2Link]);
                });
            });
        });
    });

    it('the re-hydration restores the map onto an empty clone and never clobbers or invents one', function () {
        var slice = uniqueSlice(SRC, "if ( localOptions.template && _swigEntry.assets && typeof(localOptions.template.assets) == 'undefined' ) {\n                localOptions.template.assets = _swigEntry.assets;\n            }");
        var run = new Function('localOptions', '_swigEntry', slice);
        var lo = { template: { h2Links: '' } };
        run(lo, { assets: MAP });
        assert.strictEqual(lo.template.assets, MAP, 'restored by reference from the entry');
        var own = { template: { assets: { '/mine': {} } } };
        run(own, { assets: MAP });
        assert.notStrictEqual(own.template.assets, MAP, 'a map already on the clone is kept');
        var none = { template: {} };
        run(none, { assets: null });
        assert.strictEqual(Object.prototype.hasOwnProperty.call(none.template, 'assets'), false, 'a null memo invents nothing');
        var noTpl = {};
        run(noTpl, { assets: MAP });
        assert.strictEqual(noTpl.template, undefined, 'a route without a template is left alone');
    });

    it('the compile-path gate admits an XHR request only when the compiled-template cache is on', function () {
        var expr = uniqueSlice(SRC, "( !self.isXMLRequest() || String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true' )");
        var gate = new Function('self', 'return ' + expr + ';');
        function self(xhr, cacheOn) { return { isXMLRequest: function () { return xhr; }, serverInstance: { _cacheIsEnabled: cacheOn } }; }
        assert.strictEqual(gate(self(false, false)), true,  'navigation, cache off → computes (as before)');
        assert.strictEqual(gate(self(false, true)),  true,  'navigation, cache on → computes');
        assert.strictEqual(gate(self(true,  false)), false, 'XHR, cache off → skips (byte-identical to before)');
        assert.strictEqual(gate(self(true,  true)),  true,  'XHR, cache on → computes for the entry');
        assert.strictEqual(gate(self(true,  'true')), true, 'the string form the config carries');
        assert.strictEqual(gate(self(true,  undefined)), false, 'an unset flag reads as off');
    });
});
