/**
 * #gh76 slice 2 (C1) — ONE region-binding policy for injected HTML: `bindRegion()` in
 * utils/dom.js, the validator's opt-in-gated `bindRegion()`, and nav migrated onto them.
 *
 * WHAT IT PINS / DRIVES
 *  §01 the DOM helper's script policy, driven on the EXTRACTED shipped bytes under jsdom:
 *      a fragment `<script src>` the document does not already carry is re-created in
 *      <head>; one the page already has (outside the region) is not; the fragment's own
 *      inert copy never counts as "already loaded"; an inline script is never executed;
 *      a second call for the same src injects nothing; `<link>` is left alone; the
 *      validator and link plugins are called when published and skipped when absent;
 *      `deferFormId` is forwarded.
 *  §02 the validator's `bindRegion` — source pins: it applies `isFormOptedIn` (the #B549
 *      gate), mints ids as the boot scan does, retires a stale same-id entry with
 *      `destroy` before `validateFormById`, honours `deferFormId`, and is published on
 *      both the proto (`$validator`) and the instance (`gina.validator`).
 *  §03 nav — source pins: the region is bound through `bindRegion($target)` after
 *      `closeActivePopin()`, the three retired private helpers and the two snapshot
 *      registries are gone, `utils/dom` is a declared dependency.
 *
 * The validator method closes over module state (`instance`, `local`, `isFormOptedIn`,
 * `destroy`), so its behaviour is driven on the real bundle by
 * test/e2e/nav-region-binding.spec.js, not replicated here.
 *
 * Red-first: §01's extraction banner control and every §02/§03 pin FAIL on the pre-C1
 * sources (`git show HEAD~:<file>` for each of the three files).
 *
 * Usage: node --test test/core/region-binding.test.js
 */
'use strict';
var { describe, it, beforeEach } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var { JSDOM } = require('jsdom');

var FW = require('../fw');
// Module-path seams: point at a scratch copy to run every pin AND the extracted arms
// against pre-change bytes (jsdoc.md § "A module-path SEAM in the test file").
var DOM_SRC = process.env.GINA_UTILS_DOM_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/utils/dom.js');
var VAL_SRC = process.env.GINA_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var NAV_SRC = process.env.GINA_NAV_SRC       || path.join(FW, 'core/asset/plugin/src/vendor/gina/nav/main.js');

var domSrc = fs.readFileSync(DOM_SRC, 'utf8');
var valSrc = fs.readFileSync(VAL_SRC, 'utf8');
var navSrc = fs.readFileSync(NAV_SRC, 'utf8');

// Strip comments before any NEGATIVE pin (the own-JSDoc trap): the docblocks above the
// functions name the retired shapes in prose.
function active(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
}

// Extract `function bindRegion(...) { ... }` from utils/dom.js by a started-flag brace
// walk anchored at the line-start declaration (no braces inside string literals in it —
// verified by reading the function).
function extractBindRegion(src) {
    var re = /^function bindRegion\(/mg;
    var m = re.exec(src);
    assert.ok(m, 'the bindRegion declaration must be present (extraction control)');
    assert.equal(re.exec(src), null, 'exactly one bindRegion declaration');
    var i = m.index, depth = 0, started = false;
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    assert.equal(depth, 0, 'balanced braces');
    return src.slice(m.index, i);
}

/** A jsdom window with the extracted bindRegion evaluated inside it. */
function makeWindow(html, ginaStub) {
    var dom = new JSDOM('<!DOCTYPE html><html><head><script src="http://localhost/js/gina.min.js"></script></head><body>' + html + '</body></html>', { url: 'http://localhost/page', runScripts: 'outside-only' });
    var w = dom.window;
    w.gina = ginaStub || null;
    var fnSrc = extractBindRegion(domSrc);
    // evaluated INSIDE the window so `document`/`window` resolve to jsdom's
    w.eval('window.__bindRegion = (function(){ ' + fnSrc + ' return bindRegion; }());');
    return w;
}

describe('§01 bindRegion (utils/dom) — the extracted shipped bytes under jsdom', function () {

    it('extraction control: the declaration is present exactly once and brace-balanced', function () {
        var fn = extractBindRegion(domSrc);
        assert.ok(/^function bindRegion\(\$root, options\)/.test(fn));
        assert.ok(fn.length > 500, 'the body was captured');
    });

    it('re-creates a fragment <script src> the document does not have, in <head>, once', function () {
        var w = makeWindow('<div id="r"><script src="/js/frag.js"></script><p>x</p></div>');
        var out = w.__bindRegion(w.document.getElementById('r'));
        assert.equal(out.scripts, 1);
        var heads = w.document.head.querySelectorAll('script[src="http://localhost/js/frag.js"], script[src="/js/frag.js"]');
        assert.equal(heads.length, 1, 'one head copy');
        // a second call for the same region injects nothing more (the head copy is known now)
        var out2 = w.__bindRegion(w.document.getElementById('r'));
        assert.equal(out2.scripts, 0);
        assert.equal(w.document.head.querySelectorAll('script[src$="/js/frag.js"]').length, 1);
    });

    it('does NOT re-create a src the page already carries outside the region (the fragment may re-declare the page bundle)', function () {
        var w = makeWindow('<div id="r"><script src="/js/gina.min.js"></script></div>');
        var before = w.document.querySelectorAll('script[src$="/js/gina.min.js"]').length; // head + the inert fragment copy
        var out = w.__bindRegion(w.document.getElementById('r'));
        assert.equal(out.scripts, 0);
        assert.equal(w.document.querySelectorAll('script[src$="/js/gina.min.js"]').length, before);
    });

    it("the fragment's OWN inert copy never counts as already loaded (control for the dedup: a src present only inside the region IS injected)", function () {
        var w = makeWindow('<div id="r"><script src="/js/only-here.js"></script></div>');
        assert.equal(w.document.querySelectorAll('script[src$="/js/only-here.js"]').length, 1, 'scene premise: the inert copy is in the document');
        var out = w.__bindRegion(w.document.getElementById('r'));
        assert.equal(out.scripts, 1, 'injected despite the in-region copy');
    });

    it('never executes an inline script and leaves <link> alone', function () {
        var w = makeWindow('<div id="r"><script>window.__ran = 1;</script><link rel="stylesheet" href="/css/x.css"></div>');
        var out = w.__bindRegion(w.document.getElementById('r'));
        assert.equal(out.scripts, 0);
        assert.equal(w.__ran, undefined, 'inline script not executed');
        assert.equal(w.document.head.querySelectorAll('link').length, 0, 'no <link> re-created in head');
    });

    it('calls gina.validator.bindRegion($root, {deferFormId}) when the validator is published, and reports its count', function () {
        var calls = [];
        var stub = { hasValidator: true, validator: { bindRegion: function ($root, o) { calls.push({ id: $root.id, defer: o.deferFormId }); return 2; } } };
        var w = makeWindow('<div id="r"><form id="f"></form></div>', stub);
        var out = w.__bindRegion(w.document.getElementById('r'), { deferFormId: 'f' });
        assert.deepEqual(calls, [{ id: 'r', defer: 'f' }]);
        assert.equal(out.forms, 2);
    });

    it('skips forms when no validator is published, and when forms:false', function () {
        var w = makeWindow('<div id="r"><form id="f"></form></div>', null);
        assert.equal(w.__bindRegion(w.document.getElementById('r')).forms, 0);
        var calls = 0;
        var stub = { hasValidator: true, validator: { bindRegion: function () { calls++; return 1; } } };
        var w2 = makeWindow('<div id="r"><form id="f"></form></div>', stub);
        assert.equal(w2.__bindRegion(w2.document.getElementById('r'), { forms: false }).forms, 0);
        assert.equal(calls, 0);
    });

    it('binds data-gina-link anchors through gina.link.bindLinks when the link plugin is active, counting the opted-in anchors', function () {
        var seen = [];
        var stub = { hasLinkHandler: true, link: { bindLinks: function ($root) { seen.push($root.id); } } };
        var w = makeWindow('<div id="r"><a data-gina-link href="/a">a</a><a data-gina-link="false" href="/b">b</a><a href="/c">c</a></div>', stub);
        var out = w.__bindRegion(w.document.getElementById('r'));
        assert.deepEqual(seen, ['r']);
        assert.equal(out.links, 1);
        var w2 = makeWindow('<div id="r"><a data-gina-link href="/a">a</a></div>', null);
        assert.equal(w2.__bindRegion(w2.document.getElementById('r')).links, 0, 'no plugin, nothing bound');
    });

    it('a throwing plugin is contained (warned, not propagated) and the other steps still run', function () {
        var warned = [];
        var stub = { hasValidator: true, validator: { bindRegion: function () { throw new Error('boom'); } }, hasLinkHandler: true, link: { bindLinks: function () {} } };
        var w = makeWindow('<div id="r"><script src="/js/z.js"></script><a data-gina-link href="/a">a</a></div>', stub);
        w.console.warn = function (m) { warned.push(String(m)); };
        var out = w.__bindRegion(w.document.getElementById('r'));
        assert.equal(out.scripts, 1);
        assert.equal(out.forms, 0);
        assert.equal(out.links, 1);
        assert.ok(warned.some(function (m) { return /form binding failed: boom/.test(m); }), warned.join('|'));
    });

    it('returns zeros for a non-element root', function () {
        var w = makeWindow('');
        // JSON round-trip: the object is minted in the jsdom realm, whose Object.prototype is not ours
        assert.deepEqual(JSON.parse(JSON.stringify(w.__bindRegion(null))), { scripts: 0, forms: 0, links: 0 });
    });
});

describe('§02 validator bindRegion — source pins (behaviour driven by the e2e spec)', function () {
    var a = active(valSrc);
    var declIdx = a.indexOf('var bindRegion = function($root, options) {');
    var endIdx  = a.indexOf('var unbindForm = function($target) {');

    it('declares bindRegion once, ahead of unbindForm', function () {
        assert.ok(declIdx > -1, 'declaration present');
        assert.equal(a.indexOf('var bindRegion = function', declIdx + 1), -1, 'declared once');
        assert.ok(endIdx > declIdx, 'unbindForm follows it (the slice terminator)');
    });

    it('applies the #B549 opt-in gate to every form of the region', function () {
        var body = a.slice(declIdx, endIdx);
        assert.ok(/if \( !isFormOptedIn\(\$f, local\.rules\) \) continue;/.test(body), 'isFormOptedIn gate');
        assert.ok(/getElementsByTagName\('form'\)/.test(body));
    });

    it('mints an id like the boot scan, honours deferFormId, retires a stale same-id entry with destroy() before validateFormById', function () {
        var body = a.slice(declIdx, endIdx);
        assert.ok(/'form\.' \+ uuid\(\)/.test(body), 'id minting');
        assert.ok(/if \( deferId && _id === deferId \) continue;/.test(body), 'deferFormId skip');
        var destroyAt = body.indexOf('destroy(_id);');
        var bindAt    = body.indexOf('validateFormById.call($v, _id);');
        assert.ok(destroyAt > -1 && bindAt > destroyAt, 'destroy the stale entry, then bind');
        assert.ok(/existing\.target !== \$f/.test(body), 'stale = same id, different element');
        assert.ok(/existing && existing\.target === \$f \) continue;/.test(body), 'already bound to this element => skip');
    });

    it('is published on the proto AND on the instance gina.validator', function () {
        assert.ok(/\$validator\.bindRegion\s+= bindRegion;/.test(a), 'proto publish');
        assert.ok(/instance\.bindRegion\s+= bindRegion;/.test(a), 'instance publish');
    });
});

describe('§03 nav — bound through the shared policy, the private copies retired', function () {
    var a = active(navSrc);

    it('declares utils/dom as a dependency', function () {
        assert.ok(/define\('gina\/nav', \[ 'require', 'lib\/merge', 'lib\/uuid', 'utils\/events', 'utils\/dom' \]/.test(navSrc));
    });

    it('applyFragment binds the region through bindRegion($target) AFTER closeActivePopin()', function () {
        var apply = a.indexOf('var applyFragment = function(html, url, isPopState, navOptions) {');
        assert.ok(apply > -1);
        var closeAt = a.indexOf('closeActivePopin();', apply);
        var bindAt  = a.indexOf('bindRegion($target);', apply);
        var successAt = a.indexOf("triggerEvent(gina, instance.target, 'success.' + instance.id", apply);
        assert.ok(closeAt > -1 && bindAt > closeAt && successAt > bindAt, 'close -> bindRegion -> success');
        assert.equal(a.indexOf('bindRegion($target);', bindAt + 1), -1, 'exactly one bind call');
    });

    it('the retired helpers and registries are gone from the active source', function () {
        ['var snapshotParentScripts', 'var injectFragmentScripts', 'var rebindValidator', '_parentScripts', '_injectedScripts', 'snapshotParentScripts()'].forEach(function (needle) {
            assert.equal(a.indexOf(needle), -1, needle + ' must be gone');
        });
    });
});
