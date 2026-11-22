'use strict';
/**
 * #B490 — the Inspector's `view.assets` is the parsed http/2 preload map, never a placeholder.
 *
 * Since 0.6.25 the Inspector View tab rendered the literal `${assets}`: #B463's brace escape
 * made the layout-level `layout.replace('{"assets":"${assets}"}', assets)` inert (the serialised
 * literal no longer spelled the target), and #B464 then moved the payload post-execute so the
 * target left `layout` entirely — while the placeholder object at the top of render() kept
 * riding `__gdUser.view.assets` and the XHR hidden input. The render-v1 twin of the pair sits in
 * a file that is never required. Fix: a render()-scope `_inspectorAssetsMap()` resolver reads the
 * per-template `localOptions.template.assets` (the parsed getAssets() map — filled by the first
 * compile-path request, so compiled-template cache hits see it) at SPLICE time, for all four
 * consumers; the placeholder, its capture and the dead replace (#B481) are retired together.
 * `view.assets` is ABSENT when the http/2 block never ran (http/1.1, XHR) — operator decision.
 *
 * What this file pins and what it cannot: the CALLER's choice lives in render()'s closure, so §01
 * pins it in the source and §02 extracts the resolver body and drives it against fake
 * `localOptions` shapes (incl. the getAssets()-returns-a-STRING trap); §03 drives the SHIPPED
 * module-bottom builder to lock the pass-through and the absent contract. The live restoration —
 * a real http/2 render whose payload carries asset-URL keys — is the boot arm recorded in the
 * #B490 ledger row, not a unit arm.
 *
 * House style: negative pins on a comment-stripped copy with an anti-vacuity control; every
 * discriminating pin run RED against the pre-change source through the GINA_RENDER_SWIG_SRC seam.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var path = require('path');

var FW     = require('../fw');
// Module-path seam (the freeze test's): point the whole file at a pre-change copy.
var SOURCE = process.env.GINA_RENDER_SWIG_SRC || path.join(FW, 'core/controller/controller.render-swig.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');

var inlineScript    = require(path.join(FW, 'core/controller/inline-script.js'));
var inspectorRedact = require(path.join(FW, 'lib/inspector-redact'));
var DataHelper      = require(path.join(FW, 'helpers/data/src/main.js'));
var commentStrip = require('../strip-comments');
new DataHelper();
var encodeRFC5987ValueChars = global.encodeRFC5987ValueChars;

var BANNER = '// ---- #B464 - module-scope helpers for the post-execute Inspector data splice ----';

function stripComments(s) {
    return commentStrip.lines(s);
}
function count(haystack, needle) { return haystack.split(needle).length - 1; }

/** A realistic getAssets() map: asset URL → metadata, as `localOptions.template.assets` holds it after JSON.parse. */
var MAP = {
    '/js/vendor/gina/gina.min.js': { as: 'script', isAvailable: true, file: 'gina.min.js', mime: 'application/javascript' },
    '/css/main.css'               : { as: 'style',  isAvailable: true, file: 'main.css',    mime: 'text/css' }
};

// ─── 01 — source pins ─────────────────────────────────────────────────────────

describe('01 - #B490 source pins: one resolver at every consumer, no placeholder, no dead replace', function () {
    var stripped;
    before(function () { stripped = stripComments(SRC); });

    it('the strip is load-bearing: the raw source names #B490 in a comment and the stripped copy does not', function () {
        // anti-vacuity check for the negative pins below (discriminating — the pre-fix source has no #B490)
        assert.ok(count(SRC, '#B490') >= 1, 'the raw source names #B490 in a comment');
        assert.strictEqual(count(stripped, '#B490'), 0, 'the strip removed the #B490 comments');
    });

    it('the resolver exists and reads the per-template parsed map behind an object-type guard', function () {
        var re = /var _inspectorAssetsMap = function\(\) \{[\s\S]{0,400}?typeof\(localOptions\.template\.assets\) == 'object'[\s\S]{0,200}?\? localOptions\.template\.assets[\s\S]{0,60}?: undefined;/;
        assert.ok(re.test(stripped), 'the resolver body guards on typeof object and falls back to undefined');
    });

    it('the placeholder literal is gone from the delegate', function () {
        assert.strictEqual(count(stripped, '${assets}'), 0, 'no `${assets}` placeholder anywhere in live code');
        assert.strictEqual(count(stripped, 'var _inspectorAssets = assets;'), 0, 'the pre-fix capture is retired');
    });

    it('the dead http/2 toolbar substitution is retired (#B481)', function () {
        assert.strictEqual(count(stripped, "layout.replace('{\"assets\"") , 0, 'no layout-level assets replace remains');
        assert.strictEqual(count(stripped, 'only for toolbar - TODO hasToolbar()'), 0, 'its comment went with it');
    });

    it('exactly four consumers call the resolver: both splice sites and both XHR view-info sites', function () {
        assert.strictEqual(count(stripped, ', _inspectorAssetsMap(), local, self, _cspNonceAttr)'), 2, 'two spliceInspectorData call sites pass the resolver');
        assert.strictEqual(count(stripped, '.assets = _inspectorAssetsMap();'), 2, 'two viewInfos assignments read the resolver');
        assert.strictEqual(count(stripped, '_inspectorAssetsMap()'), 4, 'and no fifth call');
    });

    it('the compile-path XHR view read sits AFTER the http/2 block populates the map (file order)', function () {
        var populate = stripped.indexOf('localOptions.template.assets = JSON.parse(assets);');
        var read     = stripped.indexOf('viewInfos.assets = _inspectorAssetsMap();');
        assert.ok(populate > -1 && read > -1, 'both anchors present');
        assert.ok(read > populate, 'the miss-path read follows the populate');
    });

    it('control — the splice call-site shape and count are unchanged from #B464', function () {
        assert.strictEqual(count(stripped, 'spliceInspectorData(htmlContent, _inspectorWanted,'), 2, 'still exactly two splice sites');
        assert.ok(stripped.indexOf('var _inspectorWanted = (') > -1, 'the wanted predicate is intact');
    });
});

// ─── 02 — the resolver, extracted and driven ─────────────────────────────────

describe('02 - the resolver body against every localOptions shape it can meet', function () {
    var resolve;
    before(function () {
        var m = /var _inspectorAssetsMap = function\(\) \{\n([\s\S]*?)\n {8}\};/.exec(SRC);
        assert.ok(m, 'the resolver must be present to extract');
        // free identifier: localOptions only
        resolve = new Function('localOptions', m[1]);
    });

    it('returns the parsed map when the http/2 block populated it', function () {
        assert.deepStrictEqual(resolve({ template: { assets: MAP } }), MAP);
    });
    it('returns undefined when the route has no template (hasViews() false)', function () {
        assert.strictEqual(resolve({}), undefined);
        assert.strictEqual(resolve({ template: undefined }), undefined);
    });
    it('returns undefined when the block never ran (http/1.1: no .assets on the template config)', function () {
        assert.strictEqual(resolve({ template: { html: '/tpl' } }), undefined);
    });
    it('returns undefined for the getAssets()-returns-a-STRING trap — a string is not the map', function () {
        assert.strictEqual(resolve({ template: { assets: '{"/a.js":{"as":"script"}}' } }), undefined);
    });
    it('returns undefined for null', function () {
        assert.strictEqual(resolve({ template: { assets: null } }), undefined);
    });
});

// ─── 03 — the shipped builder: pass-through and the absent contract ─────────

describe('03 - buildInspectorDataScript / spliceXhrInputs carry the map through, and drop an absent one', function () {
    var H;
    before(function () {
        var at = SRC.indexOf(BANNER);
        assert.ok(at > -1, 'the #B464 helper region banner must be present in ' + SOURCE);
        var region = SRC.slice(at);
        var factory = new Function('inlineScript', 'inspectorRedact', 'encodeRFC5987ValueChars', 'process', 'require',
            region + '\nreturn { buildInspectorDataScript: buildInspectorDataScript, spliceXhrInputs: spliceXhrInputs };');
        H = factory(inlineScript, inspectorRedact, encodeRFC5987ValueChars, process, require);
    });
    function data() {
        return { page: {
            view: { file: 'home', ext: '.html', title: 'Home', scripts: '<script src="/js/a.js"></script>', stylesheets: '<link href="/a.css">' },
            data: { marker: 'x' },
            environment: { bundle: 'web', webroot: '/', hostname: 'http://localhost' }
        } };
    }
    function payload(script) {
        var m = /window\.__ginaData = ([\s\S]*?);<\/script>/.exec(script);
        assert.ok(m, 'a data script was built');
        return JSON.parse(m[1]);
    }

    it('a map rides user.view.assets verbatim', function () {
        var built = H.buildInspectorDataScript(data(), MAP, { options: { conf: {} } }, { serverInstance: {} }, '');
        assert.deepStrictEqual(payload(built.script).user.view.assets, MAP);
    });
    it('undefined leaves NO assets key at all — the absent contract, not null and not a placeholder', function () {
        var built = H.buildInspectorDataScript(data(), undefined, { options: { conf: {} } }, { serverInstance: {} }, '');
        var view = payload(built.script).user.view;
        assert.strictEqual(Object.prototype.hasOwnProperty.call(view, 'assets'), false, 'no assets key');
        assert.strictEqual(view.title, 'Home', 'control: the rest of the view survives');
    });
    it('the XHR hidden input mirrors the same contract', function () {
        var vi = JSON.parse(JSON.stringify(data().page.view));   // the JSON.clone shape, no .assets
        var html = H.spliceXhrInputs('<html><body></body></html>', data(), vi);
        var m = /id="gina-without-layout-xhr-view" value="([^"]*)"/.exec(html);
        assert.ok(m, 'the view input was spliced');
        var decoded = JSON.parse(decodeURIComponent(m[1]));
        assert.strictEqual(Object.prototype.hasOwnProperty.call(decoded, 'assets'), false, 'no assets key when none was resolved');
        vi.assets = MAP;
        html = H.spliceXhrInputs('<html><body></body></html>', data(), vi);
        m = /id="gina-without-layout-xhr-view" value="([^"]*)"/.exec(html);
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(m[1])).assets, MAP, 'and the map rides it when resolved');
    });
});
