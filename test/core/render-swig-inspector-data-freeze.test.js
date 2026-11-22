'use strict';
/**
 * #B464 — the Inspector's `window.__ginaData` script must never be TEMPLATE
 * SOURCE. With `server.cache.enable` the swig compiled template is cached per
 * view on serverInstance._cached and the injected layout is persisted to the
 * bundle's `.gina-layout-cache` file (re-primed only when missing), so a data
 * script baked into the layout pre-compile served request 1's page data — the
 * controller's userData, the session card, the environment — to every later
 * request of that view and, through the file, to every later process
 * (measured on isolated dev + prod boots, a restart included). The fix leaves
 * an HTML-comment MARKER in the compiled layout and splices this request's
 * script into the EXECUTED HTML on both cache paths; a stale layout-cache file
 * is healed in place on the next compile-cache miss.
 *
 * Coverage shape:
 *   §01 source pins on the shipped delegate — split into pins on code the fix
 *       CHANGES (red on the pre-fix bytes) and premise pins on code it does NOT
 *       (green on both);
 *   §02 the real `@rhinostone/swig` fork: compile ONCE, execute TWICE, splice
 *       with the SHIPPED helper bytes (extracted, not replicated) — each execute
 *       carries its own data, the sinks refresh per execute;
 *   §03 the pre-fix shape reproduced in the same harness — the defect, as the
 *       control proving the instrument can tell the two apart;
 *   §04 the layout-cache heal, on the shipped bytes;
 *   §05 the XHR hidden-input splice, on the shipped bytes.
 *
 * Red-first: `GINA_RENDER_SWIG_SRC=<pre-fix blob> node --test <this file>`
 * runs every pin AND every extracted-bytes arm against the old delegate.
 */

var assert = require('node:assert');
var fs     = require('fs');
var path   = require('path');
var test   = require('node:test');
var describe = test.describe, it = test.it, before = test.before, after = test.after;

var FW     = require('../fw');
// Module-path seam: the whole file can be pointed at a pre-change copy of the
// delegate (pins + extracted-bytes arms alike) without touching a shared tree.
var SOURCE = process.env.GINA_RENDER_SWIG_SRC || path.join(FW, 'core/controller/controller.render-swig.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');

var swig            = require(path.join(FW, 'node_modules/@rhinostone/swig'));
var inlineScript    = require(path.join(FW, 'core/controller/inline-script.js'));
var inspectorRedact = require(path.join(FW, 'lib/inspector-redact'));
// The real RFC 5987 encoder: helpers/data assigns it as a global when the
// DataHelper constructor runs (the bare-global shape render-swig.js reads).
var DataHelper = require(path.join(FW, 'helpers/data/src/main.js'));
var commentStrip = require('../strip-comments');
new DataHelper();
var encodeRFC5987ValueChars = global.encodeRFC5987ValueChars;

var BANNER = '// ---- #B464 - module-scope helpers for the post-execute Inspector data splice ----';

/** Strip block comments and full-line `//` comments (negative pins only; every use pairs with an anti-vacuity control). */
function stripComments(s) {
    return commentStrip.lines(s);
}

/** Count non-overlapping occurrences of a literal. */
function count(haystack, needle) {
    return haystack.split(needle).length - 1;
}

/**
 * Extract the #B464 module-bottom region and execute the SHIPPED bytes with
 * the module's dependencies injected. Control-gated: the banner must appear
 * exactly once, and the returned helpers must be functions.
 */
function loadHelpers() {
    var at = SRC.indexOf(BANNER);
    assert.ok(at > -1, 'the #B464 helper region banner must be present in ' + SOURCE);
    assert.strictEqual(SRC.indexOf(BANNER, at + 1), -1, 'the banner must be unique');
    var region = SRC.slice(at);
    var factory = new Function(
        'inlineScript', 'inspectorRedact', 'encodeRFC5987ValueChars', 'process', 'require',
        region + '\nreturn { INSPECTOR_DATA_MARKER: INSPECTOR_DATA_MARKER, RE_PERSISTED_INSPECTOR_DATA: RE_PERSISTED_INSPECTOR_DATA, RE_PERSISTED_XHR_INPUT: RE_PERSISTED_XHR_INPUT, healPersistedInspectorData: healPersistedInspectorData, buildInspectorDataScript: buildInspectorDataScript, spliceInspectorData: spliceInspectorData, spliceXhrInputs: spliceXhrInputs };'
    );
    var H = factory(inlineScript, inspectorRedact, encodeRFC5987ValueChars, process, require);
    ['healPersistedInspectorData', 'buildInspectorDataScript', 'spliceInspectorData', 'spliceXhrInputs'].forEach(function (name) {
        assert.strictEqual(typeof H[name], 'function', name + ' must be a function in the extracted region');
    });
    assert.strictEqual(H.INSPECTOR_DATA_MARKER, '<!--gina:inspector-data-->', 'the marker literal');
    return H;
}

/** Parse the first Inspector data script out of a rendered page. */
function extractPayload(html) {
    var m = /<script([^>]*)>window\.__ginaData = ([\s\S]*?);<\/script>/.exec(html);
    return m ? { attrs: m[1], json: JSON.parse(m[2]), index: m.index } : null;
}

var LOGS_STUB      = '<script>window.__ginaLogs = window.__ginaLogs || [];</script>\n';
var STATUSBAR_STUB = '<script>var d = window.__ginaData;</script>';
var ASSETS         = { assets: '${assets}' };

/** The layout shape render-swig assembles, with the data slot supplied by the caller. */
function layoutTemplate(dataSlot) {
    return '<!doctype html><html><head><title>t</title></head><body>'
        + '<p id="marker">{{ page.data.marker }}</p>\n\t'
        + '{# Gina Inspector #}' + LOGS_STUB + dataSlot + STATUSBAR_STUB + '{# END Gina Inspector #}'
        + '\n\t</body></html>';
}

function makeData(marker, extra) {
    var d = { page: {
        view        : { file: 'home', ext: '.html', title: 'Home', scripts: '<script src="/js/a.js"></script>', stylesheets: '<link rel="stylesheet" href="/a.css">' },
        data        : { marker: marker, note: 'n-' + marker },
        environment : { bundle: 'web', webroot: '/', hostname: 'http://localhost' }
    } };
    if (extra) { Object.keys(extra).forEach(function (k) { d.page[k] = extra[k]; }); }
    return d;
}
function makeLocal(timeline) { return { _timeline: timeline || null, options: { conf: {} } }; }
function makeSelf() { return { serverInstance: {} }; }


// ─── 01 — source pins ─────────────────────────────────────────────────────────

describe('01 - source pins: the data script is spliced post-execute, never compiled (#B464)', function () {

    var stripped = stripComments(SRC);

    it('anti-vacuity: the comment strip keeps the code it is asked about', function () {
        assert.ok(SRC.indexOf('module.exports = async function render') > -1, 'render() present (raw)');
        assert.ok(stripped.indexOf('module.exports = async function render') > -1, 'render() present after the strip');
        assert.ok(stripped.indexOf('htmlContent = compiledTemplate(data);') > -1, 'the execute sites survive the strip');
    });

    it('the pre-compile plugin carries the MARKER between __logsScript and the statusbar body — never the data script', function () {
        assert.match(
            SRC,
            /plugin = '\\t'\s*\+ '\{# Gina Inspector #\}'\s*\+ __logsScript\s*(?:\/\/[^\n]*\n\s*)*\+ INSPECTOR_DATA_MARKER \+ '\\n'\s*\+ _statusbarTpl\s*\+ '\{# END Gina Inspector #\}'/,
            'expected the plugin assembly to splice INSPECTOR_DATA_MARKER where the data script used to be'
        );
    });

    it('no __gdScript literal is assembled anywhere in the delegate (comment-stripped), while the prose still names it (control)', function () {
        assert.ok(SRC.indexOf('__gdScript') > -1, 'control: the raw text names the retired literal in a comment');
        assert.strictEqual(stripped.indexOf('__gdScript'), -1, 'no code builds or splices __gdScript any more');
    });

    it('both execute sites resolve the marker before the release banner and the late-bind patch', function () {
        var sites = [];
        var from = 0;
        for (;;) {
            var at = SRC.indexOf('htmlContent = compiledTemplate(data);', from);
            if (at < 0) break;
            sites.push(at);
            from = at + 1;
        }
        assert.strictEqual(sites.length, 2, 'exactly two execute sites (cache-hit + cache-miss)');
        sites.forEach(function (at, i) {
            var bannerAt = SRC.indexOf('releaseBanner.maybeInject(', at);
            assert.ok(bannerAt > at, 'site ' + i + ': the release banner follows the execute');
            var between = SRC.slice(at, bannerAt);
            assert.ok(between.indexOf('spliceInspectorData(htmlContent, _inspectorWanted,') > -1,
                'site ' + i + ': spliceInspectorData(htmlContent, _inspectorWanted, …) runs between the execute and the banner');
            assert.ok(between.indexOf('spliceXhrInputs(htmlContent, data,') > -1,
                'site ' + i + ': spliceXhrInputs(htmlContent, data, …) runs between the execute and the banner');
        });
        // the patch scripts, which read window.__ginaData, come after both splices
        assert.ok(SRC.indexOf('spliceInspectorData(htmlContent, _inspectorWanted,') < SRC.indexOf('var _cachePatchScript'),
            'cache-hit: the data splice precedes the late-bind patch');
        assert.ok(SRC.indexOf('spliceInspectorData(htmlContent, _inspectorWanted,', SRC.indexOf('var _cachePatchScript')) < SRC.indexOf('var _patchScript'),
            'cache-miss: the data splice precedes the late-bind patch');
        // call-site forms only: the helper DECLARATIONS share the bare `name(htmlContent, …` prefix
        assert.strictEqual(count(stripped, 'spliceInspectorData(htmlContent, _inspectorWanted,'), 2, 'exactly two call sites');
        assert.strictEqual(count(stripped, 'htmlContent = spliceXhrInputs(htmlContent, data,'), 2, 'exactly two XHR splice sites');
    });

    it('the Inspector decision is made ONCE per request, after debugMode resolves and before the cache paths split', function () {
        assert.strictEqual(count(stripped, 'var _inspectorWanted'), 1, 'one declaration');
        assert.strictEqual(count(stripped, 'var _xhrInputsWanted'), 1, 'one declaration');
        var decided   = SRC.indexOf('var _inspectorWanted');
        var resolved  = SRC.lastIndexOf('localOptions.debugMode = self.isCacheless()');
        var hitBranch = SRC.indexOf('cache.get(cacheKey).template');
        assert.ok(resolved > -1 && decided > resolved, 'decided after the last debugMode resolution');
        assert.ok(hitBranch > -1 && decided < hitBranch, 'decided before the cache-hit branch reads the compiled template');
        assert.match(SRC, /\/\/ #B464 — the predicate is _inspectorWanted[^\n]*\n\s*if \( _inspectorWanted \) \{/,
            'the compile branch is gated on the same decision');
    });

    it('the heal runs after the #B130 normalizer and before the cache-hit/compile branch split', function () {
        var normAt = SRC.indexOf('/<script type="text\\/javascript" nonce="[^"]*">(\\s*<!--)/g');
        var healAt = SRC.indexOf('layout = healPersistedInspectorData(layout);');
        var hitAt  = SRC.indexOf('cache.get(cacheKey).template');
        assert.ok(normAt > -1, 'the #B130 normalizer is still there');
        assert.ok(healAt > normAt, 'the heal follows the #B130 normalizer');
        assert.ok(hitAt > healAt, 'the heal precedes the branch split');
        assert.strictEqual(count(stripped, 'healPersistedInspectorData(layout);'), 1, 'one heal call');
    });

    it('the XHR hidden inputs are built in ONE place — the post-execute helper — and no longer spliced into the layout', function () {
        var literal = 'id="gina-without-layout-xhr-data"';
        assert.strictEqual(count(stripped, literal), 1, 'exactly one emission site (the helper)');
        assert.ok(stripped.indexOf(literal) > stripped.indexOf(BANNER), 'and it sits in the module-bottom helper region');
        assert.strictEqual(stripped.indexOf('XHRData'), -1, 'the old XHRData binding is gone');
        assert.strictEqual(stripped.indexOf('XHRView'), -1, 'the old XHRView binding is gone');
    });

    it('nonce forms: __logsScript keeps the compile-time TEMPLATE form, the data script opens with the LITERAL', function () {
        assert.strictEqual((SRC.match(/'<script' \+ _cspNonceTplAttr \+ '>'/g) || []).length, 1,
            'only __logsScript is still baked into the compiled layout');
        assert.ok(SRC.indexOf("'<script' + _cspNonceAttr + '>window.__ginaData = '") > SRC.indexOf(BANNER),
            'the data script opener uses the per-request literal, inside the helper region');
    });

    it('the helper region exists once and declares every helper the delegate calls', function () {
        assert.strictEqual(count(SRC, BANNER), 1, 'one banner');
        var region = SRC.slice(SRC.indexOf(BANNER));
        ['function healPersistedInspectorData(layout)', 'function buildInspectorDataScript(data, assets, local, self, _cspNonceAttr)',
         'function spliceInspectorData(htmlContent, wanted, data, assets, local, self, _cspNonceAttr)', 'function spliceXhrInputs(htmlContent, data, viewInfos)',
         "var INSPECTOR_DATA_MARKER = '<!--gina:inspector-data-->';"].forEach(function (decl) {
            assert.strictEqual(count(region, decl), 1, decl + ' declared once in the region');
        });
        // per-call inputs only: the region never reads render()-scoped bindings (#B60/#B61)
        var body = stripComments(region);
        assert.strictEqual(body.indexOf('localOptions'), -1, 'no localOptions read at module scope');
        assert.strictEqual(body.indexOf('_cspNonceTplAttr'), -1, 'no template-form nonce in the post-execute helpers');
    });

});

describe('01b - premise pins: what the fix leaves in place (green on the pre-fix bytes too)', function () {

    it('the two compile-branch flow/queries injections and the late-bind slice points survive', function () {
        assert.ok(count(SRC, 'data.page.data.flow    = data.page.flow') >= 2, 'the XHR flow injection sites');
        assert.ok(SRC.indexOf('entries.slice(_flowSnapshotCount)') > -1, 'miss-path late-entry slice');
        assert.ok(SRC.indexOf('entries.slice(_cacheFlowSnapshot)') > -1, 'hit-path late-entry slice');
        assert.ok(SRC.indexOf('/<script nonce="[^"]*">(window\\.__gina(Data|Logs))/g') > -1, 'the #B130 normalizer regex');
        assert.strictEqual(count(SRC, 'data.page.events = local._eventLog;'), 2, 'the two #EVTBUS attach sites');
    });

});


// ─── 02 — the real fork: compile once, execute twice, splice the SHIPPED bytes ──

describe('02 - real swig: one compile, two executes, each page carries its OWN Inspector data', function () {

    var H, emitted = [];
    function onData(payload) { emitted.push(payload); }

    before(function () {
        H = loadHelpers();
        process.on('inspector#data', onData);
    });
    after(function () { process.removeListener('inspector#data', onData); });

    it('swig passes the marker through untouched (control: a swig comment on the same line is stripped)', function () {
        var out = swig.compile('A' + H.INSPECTOR_DATA_MARKER + 'B{# stripped #}C')({});
        assert.strictEqual(out, 'A' + H.INSPECTOR_DATA_MARKER + 'BC');
    });

    it('two executes of ONE compiled layout each get their own payload, nonce and sinks', function () {
        var tpl   = swig.compile(layoutTemplate(H.INSPECTOR_DATA_MARKER + '\n'));
        var local = makeLocal();
        var self  = makeSelf();
        var d1    = makeData('alpha');
        var d2    = makeData('beta', { cspNonce: 'NONCE-2' });
        var emitsBefore = emitted.length;

        var out1 = H.spliceInspectorData(tpl(d1), true, d1, ASSETS, local, self, '');
        var out2 = H.spliceInspectorData(tpl(d2), true, d2, ASSETS, local, self, ' nonce="NONCE-2"');

        var p1 = extractPayload(out1.html), p2 = extractPayload(out2.html);
        assert.ok(p1 && p2, 'both pages carry a data script');
        assert.strictEqual(p1.json.user.data.marker, 'alpha', 'execute 1 carries its own data');
        assert.strictEqual(p2.json.user.data.marker, 'beta',  'execute 2 carries its own data');
        assert.strictEqual(p2.json.gina.data.marker, 'beta',  'the toolbar view too');
        assert.strictEqual(out2.html.indexOf('alpha'), -1, "request 1's data is nowhere in request 2's page");
        assert.ok(out1.html.indexOf('<p id="marker">alpha</p>') > -1 && out2.html.indexOf('<p id="marker">beta</p>') > -1, 'the body markers track the executes');
        assert.strictEqual(out1.html.indexOf(H.INSPECTOR_DATA_MARKER), -1, 'the marker is consumed (1)');
        assert.strictEqual(out2.html.indexOf(H.INSPECTOR_DATA_MARKER), -1, 'the marker is consumed (2)');
        assert.strictEqual(p1.attrs, '', 'no nonce attribute without a request nonce');
        assert.strictEqual(p2.attrs, ' nonce="NONCE-2"', 'the LITERAL per-request nonce rides the opener');
        assert.ok(p2.index > out2.html.indexOf(LOGS_STUB) && p2.index < out2.html.indexOf(STATUSBAR_STUB),
            'the data script lands between the logs script and the statusbar body, which reads window.__ginaData at load');
        assert.strictEqual(typeof p2.json.user.cspNonce, 'undefined', 'the transport nonce is not page data (user)');
        assert.strictEqual(typeof p2.json.gina.cspNonce, 'undefined', 'the transport nonce is not page data (gina)');
        assert.deepStrictEqual(p2.json.user.view.assets, ASSETS, 'the assets placeholder rides user.view.assets');
        assert.strictEqual(p2.json.user.view.scripts, 'ignored-by-toolbar', 'scripts elided as before');
        assert.ok(Array.isArray(p2.json.gina.inspectorRedact.patterns), 'the redact config rides gina.inspectorRedact');
        assert.strictEqual(p2.json.gina.environment.templateEngine.name, 'swig', 'the engine badge');
        assert.strictEqual(out1.flowSnapshotCount, 0, 'no timeline ⇒ snapshot count 0');
        // the sinks refresh per execute — a cache HIT now refreshes them too
        assert.strictEqual(self.serverInstance._lastGinaData.user.data.marker, 'beta', '_lastGinaData holds the LATEST execute');
        assert.strictEqual(emitted.length - emitsBefore, 2, 'one inspector data event per execute');
        assert.deepStrictEqual(emitted.slice(-2).map(function (p) { return p.user.data.marker; }), ['alpha', 'beta']);
    });

    it('the snapshot count is the timeline length at payload-build time, and serverMs derives from it', function () {
        var tpl   = swig.compile(layoutTemplate(H.INSPECTOR_DATA_MARKER + '\n'));
        var tl    = { requestStart: 1000, entries: [ { label: 'routing', cat: 'routing', startMs: 1000, endMs: 1004, durationMs: 4 }, { label: 'swig-execute', cat: 'template', startMs: 1004, endMs: 1010, durationMs: 6 } ] };
        var d     = makeData('gamma', { flow: { requestStart: 1000, entries: tl.entries } });
        var out   = H.spliceInspectorData(tpl(d), true, d, ASSETS, makeLocal(tl), makeSelf(), '');
        var p     = extractPayload(out.html);
        assert.strictEqual(out.flowSnapshotCount, 2, 'both entries were in the payload');
        assert.strictEqual(p.json.user.environment.metrics.serverMs, 10, 'serverMs = latest endMs − requestStart');
        assert.strictEqual(p.json.user.environment.metrics.weightBytes, null, 'weightBytes is late-bound by the patch script');
        assert.strictEqual(p.json.user.flow.entries.length, 2, 'the flow snapshot rides the payload');
    });

    it('not wanted: the marker is dropped, no script, no sink refresh, no event', function () {
        var tpl   = swig.compile(layoutTemplate(H.INSPECTOR_DATA_MARKER + '\n'));
        var self  = makeSelf();
        var d     = makeData('delta');
        var emitsBefore = emitted.length;
        var out   = H.spliceInspectorData(tpl(d), false, d, ASSETS, makeLocal(), self, '');
        assert.strictEqual(out.html.indexOf(H.INSPECTOR_DATA_MARKER), -1, 'the marker is gone');
        assert.strictEqual(out.html.indexOf('window.__ginaData ='), -1, 'no data script');
        assert.strictEqual(out.html.indexOf('delta'), out.html.indexOf('<p id="marker">delta</p>') + '<p id="marker">'.length, 'the only delta is the body marker');
        assert.strictEqual(out.flowSnapshotCount, null);
        assert.strictEqual(typeof self.serverInstance._lastGinaData, 'undefined', 'the sink is untouched');
        assert.strictEqual(emitted.length, emitsBefore, 'no event');
    });

    it('marker absent: the HTML is returned as-is (a layout that never carried the plugin)', function () {
        var html  = '<html><body><p>plain</p></body></html>';
        var emitsBefore = emitted.length;
        var out   = H.spliceInspectorData(html, true, makeData('x'), ASSETS, makeLocal(), makeSelf(), '');
        assert.strictEqual(out.html, html);
        assert.strictEqual(out.flowSnapshotCount, null);
        assert.strictEqual(emitted.length, emitsBefore, 'no event without a marker');
    });

    it('$-safety: page data carrying replacement patterns is spliced verbatim (function replacer)', function () {
        var tpl  = swig.compile(layoutTemplate(H.INSPECTOR_DATA_MARKER + '\n'));
        var d    = makeData("x$'y$`z$&w$1");
        var out  = H.spliceInspectorData(tpl(d), true, d, ASSETS, makeLocal(), makeSelf(), '');
        assert.strictEqual(count(out.html, '<body>'), 1, 'the document is not duplicated by a $` / $\' expansion');
        assert.strictEqual(extractPayload(out.html).json.user.data.marker, "x$'y$`z$&w$1", 'the value round-trips');
    });

    it('the unredacted snapshot is taken BEFORE redaction, and only in local scope', function () {
        var saved = process.env.NODE_SCOPE;
        try {
            var tpl = swig.compile(layoutTemplate(H.INSPECTOR_DATA_MARKER + '\n'));
            var d   = makeData('eps');
            d.page.data.password = 'p4ss';
            process.env.NODE_SCOPE = 'local';
            var selfLocal = makeSelf();
            var out = H.spliceInspectorData(tpl(d), true, d, ASSETS, makeLocal(), selfLocal, '');
            assert.strictEqual(extractPayload(out.html).json.user.data.password, inspectorRedact.REPLACEMENT, 'the page carries the redacted value');
            assert.strictEqual(selfLocal.serverInstance._lastGinaData.user.data.password, inspectorRedact.REPLACEMENT, 'the SSE sink is redacted');
            assert.strictEqual(selfLocal.serverInstance._lastGinaDataUnredacted.user.data.password, 'p4ss', 'the reveal snapshot is not');
            process.env.NODE_SCOPE = 'production';
            var selfProd = makeSelf();
            H.spliceInspectorData(tpl(d), true, d, ASSETS, makeLocal(), selfProd, '');
            assert.strictEqual(selfProd.serverInstance._lastGinaDataUnredacted, null, 'no unredacted snapshot outside local scope');
        } finally {
            if (typeof saved === 'undefined') { delete process.env.NODE_SCOPE; } else { process.env.NODE_SCOPE = saved; }
        }
    });

});


// ─── 03 — the defect, reproduced as the control the instrument can fail on ────

describe('03 - CONTROL: the pre-fix shape (data script baked into the template source) freezes request 1', function () {

    it('one compile with the payload baked in serves the FIRST payload to every later execute', function () {
        var frozen = inlineScript.safeInlineJson({ gina: { data: { marker: 'alpha' } }, user: { data: { marker: 'alpha' } } });
        var baked  = swig.compile(layoutTemplate('<script>window.__ginaData = ' + frozen + ';</script>\n'));
        var out1   = baked(makeData('alpha'));
        var out2   = baked(makeData('beta'));
        assert.ok(out2.indexOf('<p id="marker">beta</p>') > -1, 'execute 2 renders its own body data');
        assert.strictEqual(extractPayload(out2).json.user.data.marker, 'alpha', 'but its Inspector payload is request 1\'s — the #B464 freeze');
        assert.strictEqual(extractPayload(out1).json.user.data.marker, 'alpha');
    });

});


// ─── 04 — the layout-cache heal, on the shipped bytes ─────────────────────────

describe('04 - healPersistedInspectorData: a stale layout-cache file loses its persisted data, once', function () {

    var H;
    before(function () { H = loadHelpers(); });

    var OLD_JSON = function () {
        // safeInlineJson escapes `<`, so a value that spells the terminator cannot end the block early
        return inlineScript.safeInlineJson({ gina: { x: 1 }, user: { data: { marker: 'alpha', note: 'has ;</scr' + 'ipt> inside' } } });
    };
    var COND = '{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}';
    var APP_SCRIPT = '<script>window.app = {"theme":"dark"};</script>';
    var APP_INPUT  = '<input type="hidden" id="csrf" value="tok">';

    function staleLayout(opener) {
        return '<!doctype html><html><head>' + APP_SCRIPT + '</head><body>{% block content %}{% endblock %}\n'
            + APP_INPUT + '\n'
            + '\t<input type="hidden" id="gina-without-layout-xhr-data" value="%7B%22marker%22%3A%22alpha%22%7D">\n\r'
            + '\n<input type="hidden" id="gina-without-layout-xhr-view" value="%7B%22file%22%3A%22home%22%7D">'
            + '\n\t{# Gina Inspector #}' + LOGS_STUB
            + '<script' + opener + '>window.__ginaData = ' + OLD_JSON() + ';</script>\n'
            + STATUSBAR_STUB + '{# END Gina Inspector #}\n\t</body></html>';
    }

    ['', COND, ' nonce="OLD-LITERAL"'].forEach(function (opener) {
        it('heals the persisted data script with opener ' + JSON.stringify(opener || '(bare)') + ' into the marker', function () {
            var stale  = staleLayout(opener);
            var healed = H.healPersistedInspectorData(stale);
            assert.notStrictEqual(healed, stale, 'something was healed');
            // the assignment form: the statusbar body legitimately READS window.__ginaData
            assert.strictEqual(healed.indexOf('window.__ginaData ='), -1, 'the persisted data script is gone');
            assert.ok(healed.indexOf(STATUSBAR_STUB) > -1, 'control: the statusbar body, which reads it, survives');
            assert.strictEqual(healed.indexOf('alpha'), -1, "request 1's data is gone with it");
            assert.strictEqual(count(healed, H.INSPECTOR_DATA_MARKER + '\n'), 1, 'exactly one marker, newline-terminated like a fresh plugin');
            assert.ok(healed.indexOf(LOGS_STUB + H.INSPECTOR_DATA_MARKER + '\n' + STATUSBAR_STUB) > -1,
                'the marker sits exactly where the script was: after the logs script, before the statusbar body');
            assert.strictEqual(healed.indexOf('gina-without-layout-xhr-'), -1, 'the persisted XHR inputs are dropped');
            assert.ok(healed.indexOf(APP_SCRIPT) > -1 && healed.indexOf(APP_INPUT) > -1, 'app-authored script and input untouched');
            assert.ok(healed.indexOf('{% block content %}{% endblock %}') > -1, 'template tags untouched');
            assert.strictEqual(H.healPersistedInspectorData(healed), healed, 'idempotent');
        });
    });

    it('a freshly persisted post-fix layout (marker already in place) is returned byte-identical', function () {
        var fresh = '<html><body>{# Gina Inspector #}' + LOGS_STUB + H.INSPECTOR_DATA_MARKER + '\n' + STATUSBAR_STUB + '{# END Gina Inspector #}</body></html>';
        assert.strictEqual(H.healPersistedInspectorData(fresh), fresh);
    });

    it('a layout that never carried either token is returned as-is (fast path), and non-strings pass through', function () {
        var plain = '<html><body><script>window.other = 1;</script></body></html>';
        assert.strictEqual(H.healPersistedInspectorData(plain), plain);
        assert.strictEqual(H.healPersistedInspectorData(null), null);
    });

    it('an app script that merely mentions __ginaData is NOT the framework emission shape and survives', function () {
        var app = '<html><body><script>\n  if (window.__ginaData) { console.log("dev"); }\n</script></body></html>';
        assert.strictEqual(H.healPersistedInspectorData(app), app, 'anchored on the framework opener, not on the token');
    });

});


// ─── 05 — the XHR hidden-input splice, on the shipped bytes ───────────────────

describe('05 - spliceXhrInputs: the two hidden inputs ride the executed HTML', function () {

    var H;
    before(function () { H = loadHelpers(); });

    function decodeInput(html, id) {
        var m = new RegExp('<input type="hidden" id="' + id + '" value="([^"]*)">').exec(html);
        return m ? JSON.parse(decodeURIComponent(m[1])) : null;
    }

    it('a full document gets both inputs immediately before </body>, data first', function () {
        var d    = makeData('zeta');
        d.page.data.flow = { requestStart: 1, entries: [] };
        var view = { file: 'home', assets: ASSETS };
        var out  = H.spliceXhrInputs('<html><body><p>x</p></body></html>', d, view);
        assert.deepStrictEqual(decodeInput(out, 'gina-without-layout-xhr-data'), d.page.data, 'the page data round-trips');
        assert.deepStrictEqual(decodeInput(out, 'gina-without-layout-xhr-view'), view, 'the view infos round-trip');
        assert.ok(out.indexOf('xhr-data') < out.indexOf('xhr-view') && out.indexOf('xhr-view') < out.indexOf('</body>'), 'data, then view, then </body>');
        assert.strictEqual(count(out, '<p>x</p>'), 1, 'the document is not duplicated');
    });

    it('a fragment without a document shell (the popin shape) gets both inputs appended', function () {
        var d   = makeData('eta');
        var out = H.spliceXhrInputs('<div>frag</div>', d, { file: 'popin' });
        assert.ok(out.indexOf('<div>frag</div>\n<input type="hidden" id="gina-without-layout-xhr-data"') === 0, 'appended right after the fragment');
        assert.deepStrictEqual(decodeInput(out, 'gina-without-layout-xhr-view'), { file: 'popin' });
    });

    it("$-safety and quoting: the values are percent-encoded, so neither a quote nor a $-pattern can escape the attribute", function () {
        var d   = makeData("q\"uo$'te");
        var out = H.spliceXhrInputs('<body><p>x</p></body>', d, {});
        assert.strictEqual(count(out, '<p>x</p>'), 1);
        assert.strictEqual(decodeInput(out, 'gina-without-layout-xhr-data').marker, "q\"uo$'te");
        assert.strictEqual((out.match(/<input /g) || []).length, 2, 'exactly two inputs');
    });

});
