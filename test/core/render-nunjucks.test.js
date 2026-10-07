var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SOURCE = path.join(require('../fw'), 'core/controller/controller.render-nunjucks.js');


// ─── 01 — Function-scoped captures of per-request refs (#M1 race fix) ────────
//
// Mirror of render-swig.test.js section 12. renderNunjucks() is async with
// awaits at writeCache; between yields, the controller's `local` closure can
// have its `req` / `res` / `next` properties nulled by another code path
// (most commonly throwError's generic-HTML fallthrough at
// controller.js:5342-5344). Pre-retrofit, renderNunjucks read `local.req` /
// `local.res` directly throughout its body and helpers (sendHtmlResponse /
// writeCache / registerGinaFilters), so any post-await read after such a
// null-out would crash with `Cannot read properties of null (reading
// 'method')` or similar.
//
// The retrofit captures `local.req` / `local.res` / `local.next` into
// function-scoped `var req` / `var res` / `var _next` at the very top of
// renderNunjucks() (immediately after the deps unpack, before any await).
// All post-deps reads go through the captures. Helpers that read the
// per-request refs (sendHtmlResponse / writeCache / registerGinaFilters)
// take the captures as parameters.

describe('01 - function-scoped captures of per-request refs (#M1 race fix)', function() {

    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    // ── (a) source structure: captures at top of renderNunjucks ─────────

    it("renderNunjucks() body captures `var req = local.req` after the deps unpack", function() {
        var src = getSrc();
        var renderIdx = src.indexOf('module.exports = async function renderNunjucks');
        assert.ok(renderIdx > -1, 'renderNunjucks() exported declaration not found');
        // Window from renderNunjucks() declaration to the first await on a
        // user-visible promise (writeCache). Anchored on `await writeCache(`
        // since the writeCache helper above also has its own await but lives
        // outside the renderNunjucks body.
        var awaitIdx = src.indexOf('await writeCache(', renderIdx);
        assert.ok(awaitIdx > -1, 'first await writeCache(...) in renderNunjucks not found');
        var prologue = src.substring(renderIdx, awaitIdx);
        assert.ok(
            /var\s+req\s*=\s*local\.req\s*;/.test(prologue),
            'expected `var req = local.req;` capture before any await in renderNunjucks()'
        );
    });

    it("renderNunjucks() body captures `var res = local.res` after the deps unpack", function() {
        var src = getSrc();
        var renderIdx = src.indexOf('module.exports = async function renderNunjucks');
        var awaitIdx  = src.indexOf('await writeCache(', renderIdx);
        var prologue  = src.substring(renderIdx, awaitIdx);
        assert.ok(
            /var\s+res\s*=\s*local\.res\s*;/.test(prologue),
            'expected `var res = local.res;` capture before any await in renderNunjucks()'
        );
    });

    it("renderNunjucks() body captures `var _next = local.next` after the deps unpack", function() {
        var src = getSrc();
        var renderIdx = src.indexOf('module.exports = async function renderNunjucks');
        var awaitIdx  = src.indexOf('await writeCache(', renderIdx);
        var prologue  = src.substring(renderIdx, awaitIdx);
        assert.ok(
            /var\s+_next\s*=\s*local\.next\s*;/.test(prologue),
            'expected `var _next = local.next;` capture before any await in renderNunjucks()'
        );
    });

    it("captures come AFTER `local = deps.local;` so they read the populated closure", function() {
        var src = getSrc();
        var depsIdx    = src.indexOf('var local = deps.local;');
        var captureIdx = src.indexOf('var req   = local.req;');
        assert.ok(depsIdx > -1, '`var local = deps.local;` deps assignment not found');
        assert.ok(captureIdx > -1, '`var req   = local.req;` capture not found');
        assert.ok(
            captureIdx > depsIdx,
            'captures must come AFTER `var local = deps.local;` so `local` is populated when read'
        );
    });

    // ── (b) source structure: helper signatures take req, res params ────

    it('writeCache signature includes `req, res` parameters', function() {
        var src = getSrc();
        assert.ok(
            /async\s+function\s+writeCache\s*\(\s*local\s*,\s*self\s*,\s*bundle\s*,\s*opt\s*,\s*htmlContent\s*,\s*req\s*,\s*res\s*\)/.test(src),
            'writeCache must take `local, self, bundle, opt, htmlContent, req, res` — req/res are renderNunjucks()-captured copies (race-safe)'
        );
    });

    it('sendHtmlResponse signature includes `req, res` parameters', function() {
        var src = getSrc();
        assert.ok(
            /function\s+sendHtmlResponse\s*\(\s*local\s*,\s*html\s*,\s*req\s*,\s*res\s*\)/.test(src),
            'sendHtmlResponse must take `local, html, req, res` — its 19 post-await local.req/res reads now go through the captures'
        );
    });

    it('registerGinaFilters signature includes `req, res` parameters', function() {
        var src = getSrc();
        assert.ok(
            /function\s+registerGinaFilters\s*\(\s*env\s*,\s*self\s*,\s*local\s*,\s*localOptions\s*,\s*req\s*,\s*res\s*\)/.test(src),
            'registerGinaFilters must take `env, self, local, localOptions, req, res` — its 11 local.req reads now go through the captures'
        );
    });

    // ── (c) source structure: call sites pass req, res ──────────────────

    it('renderNunjucks calls sendHtmlResponse with `req, res` on both paths', function() {
        var src = getSrc();
        // Two call sites: empty-string fallback (no-views early return) and the
        // main render path at the bottom of renderNunjucks(). The function
        // declaration above (`function sendHtmlResponse(local, html, req, res)`)
        // matches the same parameter-shape regex, so we expect 3 total
        // occurrences (1 definition + 2 call sites).
        var matches = src.match(/sendHtmlResponse\s*\(\s*local\s*,\s*[^,)]+\s*,\s*req\s*,\s*res\s*\)/g);
        assert.ok(matches, 'no sendHtmlResponse(..., req, res) occurrences found');
        assert.strictEqual(matches.length, 3, 'expected 3 occurrences: 1 definition + 2 call sites (no-views + main render)');
        // Verify the no-views call site (empty string body) is present.
        assert.ok(
            /sendHtmlResponse\s*\(\s*local\s*,\s*''\s*,\s*req\s*,\s*res\s*\)/.test(src),
            'expected sendHtmlResponse(local, "", req, res) for no-views early return'
        );
        // Verify the main-path call site (html body) is present.
        assert.ok(
            /sendHtmlResponse\s*\(\s*local\s*,\s*html\s*,\s*req\s*,\s*res\s*\)/.test(src),
            'expected sendHtmlResponse(local, html, req, res) for main render path (post-await)'
        );
    });

    it('renderNunjucks calls registerGinaFilters with `req, res`', function() {
        var src = getSrc();
        assert.ok(
            /registerGinaFilters\s*\(\s*env\s*,\s*self\s*,\s*local\s*,\s*localOptions\s*,\s*req\s*,\s*res\s*\)/.test(src),
            'registerGinaFilters call site must pass req, res'
        );
    });

    it('renderNunjucks awaits writeCache with `req, res`', function() {
        var src = getSrc();
        assert.ok(
            /await\s+writeCache\s*\(\s*local\s*,\s*self\s*,\s*localOptions\.bundle\s*,\s*localOptions\.conf\.server\.cache\s*,\s*html\s*,\s*req\s*,\s*res\s*\)/.test(src),
            'writeCache call site must pass req, res — this is the critical post-await race window'
        );
    });

    // ── (d) negative invariant: no `local.req` / `local.res` / `local.next`
    //     READS in active code outside the captures and the bug-explanation
    //     comment. The negative lookahead `(?!\s*=)` excludes terminal-exit
    //     WRITES (`local.req = null;` etc.) — those are deliberate per
    //     class.controller.md § 4 and don't carry the post-await race risk
    //     the captures guard against.

    it('no `local.req` reads remain in active code outside the captures', function() {
        var src = getSrc();
        // Strip single-line and block comments so commented-out documentation
        // (e.g. the bug explanation in the captures' comment block) does not
        // count as an "active read".
        var stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        var allReads = stripped.match(/local\.req\b(?!\s*=)/g) || [];
        // Allowed: only the capture `var req   = local.req;` (1 occurrence)
        assert.strictEqual(
            allReads.length, 1,
            'expected exactly 1 `local.req` READ in active code (the capture line), found ' + allReads.length
        );
    });

    it('no `local.res` reads remain in active code outside the captures', function() {
        var src = getSrc();
        var stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        var allReads = stripped.match(/local\.res\b(?!\s*=)/g) || [];
        assert.strictEqual(
            allReads.length, 1,
            'expected exactly 1 `local.res` READ in active code (the capture line), found ' + allReads.length
        );
    });

    it('no `local.next` reads remain in active code outside the captures', function() {
        var src = getSrc();
        var stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        var allReads = stripped.match(/local\.next\b(?!\s*=)/g) || [];
        assert.strictEqual(
            allReads.length, 1,
            'expected exactly 1 `local.next` READ in active code (the capture line), found ' + allReads.length
        );
    });

    // ── (e) pure-logic replica: race-safety property ────────────────────

    it('captured `req` survives `local.req = null` (function-scoped vs closure-scoped)', function() {
        // Simulate the controller's per-request closure shape.
        var local = { req: { method: 'GET', url: '/x' }, res: {}, next: function() {} };
        // Capture function-scoped refs (mirrors the captures in renderNunjucks).
        var req = local.req;
        var res = local.res;
        var _next = local.next;
        // External path nulls the closure properties (mirrors throwError's
        // generic-error fallthrough at controller.js:5342-5344).
        local.req = null;
        local.res = null;
        local.next = null;
        // Pre-retrofit: any `local.req.X` post-await read crashed. Post-
        // retrofit: the captured `req` still references the original object.
        assert.equal(req.method, 'GET', 'captured req survives the closure null-out');
        assert.equal(req.url, '/x', 'captured req object is still the same reference');
        assert.notEqual(res, null, 'captured res survives the closure null-out');
        assert.equal(typeof _next, 'function', 'captured _next survives the closure null-out');
    });

    it('repro of the pre-retrofit failure: `local.req.method` after null-out throws TypeError', function() {
        // sendHtmlResponse line 396 pre-retrofit: `var isHead = /^HEAD$/i.test(local.req.method);`
        // The race surface: if local.req was nulled while renderNunjucks was
        // suspended at the writeCache await, sendHtmlResponse on resume would
        // crash here. Post-retrofit, sendHtmlResponse receives `req` as a
        // parameter (the captured ref) so this access never sees null.
        var local = { req: { method: 'GET' } };
        local.req = null;
        assert.throws(
            function() {
                /* eslint-disable no-unused-vars */
                var isHead = /^HEAD$/i.test(local.req.method);
                /* eslint-enable no-unused-vars */
            },
            /Cannot read prop(erty|erties).+null.+(reading\s+'method'|of\s+null)/,
            'pre-retrofit access pattern must throw TypeError on null local.req'
        );
    });

    it('post-retrofit: the same access via the captured `req` does NOT throw', function() {
        var local = { req: { method: 'GET' } };
        var req = local.req;
        local.req = null;
        var isHead = /^HEAD$/i.test(req.method);
        assert.equal(isHead, false, 'GET is not HEAD; the access returns a boolean instead of throwing');
    });

});


// ─── 02 — Terminal-exit closure nulling (#M1 retrofit follow-up) ─────────────
//
// render-swig.js nulls `local.req` / `local.res` / `local.next` on the closure
// at every success-side terminal exit (cache-hit, normal render, error
// fallthrough) for early per-request memory release. The captures from
// section 01 stay alive until the function returns and are GC'd then; the
// closure properties need explicit nulling for early release of the per-
// request payload (the controller's `local` closure also holds `options` and
// other per-request fields that GC can reclaim once the request is done).
//
// Mirror site: render-swig.js terminal exits at lines 964, 1603, 1637.

describe('02 - terminal-exit closure nulling (#M1 retrofit follow-up)', function() {

    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    it('no-view short-circuit nulls local.req/res/next after sendHtmlResponse', function() {
        var src = getSrc();
        // Match the 5-line shape: sendHtmlResponse + 3 null writes + return.
        var pattern = /sendHtmlResponse\(local,\s*['"]['"],\s*req,\s*res\);[\s\S]{0,300}?local\.req\s*=\s*null;\s*local\.res\s*=\s*null;\s*local\.next\s*=\s*null;\s*return;/;
        assert.ok(
            pattern.test(src),
            'expected the no-view short-circuit to null local.req/res/next after sendHtmlResponse and before return'
        );
    });

    it('final terminal exit nulls local.req/res/next after sendHtmlResponse', function() {
        var src = getSrc();
        // Match the final sendHtmlResponse(local, html, req, res) + 3 null
        // writes at the end of the function, followed by the function close `};`.
        var pattern = /sendHtmlResponse\(local,\s*html,\s*req,\s*res\);[\s\S]{0,300}?local\.req\s*=\s*null;\s*local\.res\s*=\s*null;\s*local\.next\s*=\s*null;\s*\};/;
        assert.ok(
            pattern.test(src),
            'expected the final terminal exit to null local.req/res/next after sendHtmlResponse before the function close'
        );
    });

    it('exactly 2 closure-nulling sites (no over-nulling on throwError paths)', function() {
        var src = getSrc();
        // Strip comments so commented-out documentation doesn't count.
        var stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        var writes = stripped.match(/local\.req\s*=\s*null/g) || [];
        // Two sites: no-view short-circuit + final terminal exit. throwError
        // paths handle cleanup via their own controller render chain, matching
        // render-swig.js's "only success-side terminals" pattern.
        assert.strictEqual(
            writes.length, 2,
            'expected exactly 2 `local.req = null` writes (no-view + final), found ' + writes.length
        );
    });

    it('captures precede the first nulling site (ordering invariant)', function() {
        var src = getSrc();
        var captureIdx = src.indexOf('var req   = local.req;');
        var firstNull  = src.indexOf('local.req = null');
        assert.ok(captureIdx > -1, 'capture line `var req   = local.req;` not found');
        assert.ok(firstNull > -1, 'no `local.req = null` site found');
        assert.ok(
            captureIdx < firstNull,
            'captures must precede the first nulling site so the function-scoped refs hold live values when the closure is nulled'
        );
    });

    it('triple-null block: req → res → next ordering matches render-swig pattern', function() {
        var src = getSrc();
        // Each nulling block must be the exact three-line shape in the order
        // req → res → next. This locks the pattern against partial regressions
        // (e.g. someone adding `local.res = null` without the matching pair).
        var pattern = /local\.req\s*=\s*null;\s*local\.res\s*=\s*null;\s*local\.next\s*=\s*null;/g;
        var matches = src.match(pattern) || [];
        assert.strictEqual(
            matches.length, 2,
            'expected exactly 2 `local.req=null; local.res=null; local.next=null;` triple-blocks, found ' + matches.length
        );
    });
});


// 03 — HTTP/2 response trailers (#H10)
describe('03 - HTTP/2 response trailers (#H10)', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    it('captures _trailers from local._trailers', function() {
        assert.ok(/var _trailers\s*=.*local\._trailers/.test(src()), 'expected _trailers capture from local._trailers');
    });

    it('wires waitForTrailers + wantTrailers + sendTrailers in the body path', function() {
        var s = src();
        assert.ok(s.indexOf('#H10') > -1, 'expected #H10 marker');
        assert.ok(s.indexOf('waitForTrailers') > -1, 'expected waitForTrailers');
        assert.ok(s.indexOf("'wantTrailers'") > -1, 'expected wantTrailers listener');
        assert.ok(s.indexOf('sendTrailers') > -1, 'expected sendTrailers call');
    });

    it('gates the trailer wiring on registered trailers (if (_trailers))', function() {
        assert.ok(/if\s*\(\s*_trailers\s*\)/.test(src()), 'expected `if (_trailers)` gate');
    });

    it('passes waitForTrailers conditionally to the body-path stream.respond()', function() {
        assert.ok(
            /stream\.respond\(_streamHeaders,\s*_trailers\s*\?\s*\{\s*waitForTrailers:\s*true\s*\}\s*:\s*undefined\)/.test(src()),
            'expected single conditional stream.respond(_streamHeaders, _trailers ? {...} : undefined) in Case 3 (body)'
        );
    });
});


// 04 — CSP nonce on framework-injected inline scripts (#HDR5)
describe('04 - CSP nonce: onGinaLoaded bootstrap carries req._ginaCspNonce', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    it('captures _cspNonce from req._ginaCspNonce', function() {
        assert.ok(
            /var _cspNonce\s*=\s*\(req && req\._ginaCspNonce\)\s*\?\s*req\._ginaCspNonce\s*:\s*null/.test(src()),
            'expected _cspNonce captured from req._ginaCspNonce'
        );
    });

    it('threads cspNonce into injectAssets (param + call site)', function() {
        var s = src();
        assert.ok(/function injectAssets\(html, data, localOptions, cspNonce\)/.test(s),
            'expected injectAssets to accept a cspNonce param');
        assert.ok(/injectAssets\(html, data, localOptions, _cspNonce\)/.test(s),
            'expected the call site to pass _cspNonce');
    });

    it('stamps the bootstrap <script> with the nonce inside injectAssets (#HDR5)', function() {
        var s = src();
        assert.ok(s.indexOf('#HDR5') > -1, 'expected #HDR5 marker');
        assert.ok(
            /'<script type="text\/javascript" nonce="'\s*\+\s*cspNonce\s*\+\s*'">'/.test(s),
            'expected the nonce attribute injected into the bootstrap script tag'
        );
    });

    // pure-logic replica (mirrors the injectAssets nonce transform)
    function nonceLoader(loaderTag, cspNonce) {
        if (cspNonce && typeof loaderTag === 'string') {
            return loaderTag.replace(
                '<script type="text/javascript">',
                '<script type="text/javascript" nonce="' + cspNonce + '">'
            );
        }
        return loaderTag;
    }

    var LOADER = '\n\t\t<script type="text/javascript">\n\t\t<!--\n\t\tvar x=1;\n\t\t//-->\n\t\t</script>';

    it('replica: injects the nonce attribute when a nonce is present', function() {
        var out = nonceLoader(LOADER, 'ABC+/=');
        assert.ok(out.indexOf('<script type="text/javascript" nonce="ABC+/=">') > -1);
        assert.strictEqual(out.indexOf('<script type="text/javascript">'), -1, 'bare tag rewritten');
    });

    it('replica: returns the loader unchanged when no nonce (back-compat)', function() {
        assert.strictEqual(nonceLoader(LOADER, null), LOADER);
        assert.strictEqual(nonceLoader(LOADER, undefined), LOADER);
    });

});


// 05 — CSP nonce on the dev-only Inspector + patch inline scripts (#HDR16)
describe('05 - CSP nonce: dev-only Inspector + patch inline scripts', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    it('injectInspectorScripts reads the stable local._cspNonce (NOT volatile local.req)', function() {
        var s = src();
        assert.ok(
            /var _cspNonce\s*=\s*\(local && local\._cspNonce\)\s*\?\s*local\._cspNonce\s*:\s*null/.test(s),
            'expected injectInspectorScripts to read local._cspNonce'
        );
        assert.ok(/local\._cspNonce\s*=\s*_cspNonce/.test(s),
            'expected the main scope to stamp local._cspNonce from the captured nonce');
    });

    it('defines _cspNonceAttr in both the Inspector helper and the main render scope', function() {
        var defs = (src().match(/var _cspNonceAttr\s*=\s*_cspNonce\s*\?/g) || []);
        assert.ok(defs.length >= 2,
            'expected _cspNonceAttr defined in injectInspectorScripts AND the main scope (got ' + defs.length + ')');
    });

    it('injects _cspNonceAttr into the Inspector + patch inline <script> openings', function() {
        var nonced = (src().match(/'<script' \+ _cspNonceAttr \+ '>/g) || []);
        // __gdScript, __logsScript (injectInspectorScripts) + _njPatchScript (main) = 3 sites
        assert.ok(nonced.length >= 3,
            'expected all 3 dev-script openings to carry _cspNonceAttr (got ' + nonced.length + ')');
    });

    it('leaves no bare framework-assembled <script> opening assignment', function() {
        var s = src();
        assert.ok(!/=\s*'<script>'/.test(s),          'no bare <script> assignment should remain');
        assert.ok(!/=\s*'<script>\(function/.test(s), 'no bare <script>(function assignment should remain');
        assert.ok(!/=\s*'<script>window/.test(s),     'no bare <script>window assignment should remain');
    });

    // pure-logic replica of the _cspNonceAttr fragment
    function nonceAttr(nonce) { return nonce ? (' nonce="' + nonce + '"') : ''; }

    it('replica: emits a nonce attribute when present, nothing otherwise', function() {
        assert.strictEqual('<script' + nonceAttr('Xy9+/=') + '>', '<script nonce="Xy9+/=">');
        assert.strictEqual('<script' + nonceAttr(null) + '>', '<script>');
    });

});


// 06 — CSP nonce app-template helper: top-level cspNonce in the render context (#HDR16 follow-up)
describe('06 - CSP nonce: cspNonce template var in the nunjucks render context', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    it('exposes the nonce on top-level data.cspNonce, guarded so the key is absent when no nonce', function() {
        assert.ok(
            /if \(_cspNonce\) \{ data\.cspNonce = _cspNonce; \}/.test(src()),
            'expected `if (_cspNonce) { data.cspNonce = _cspNonce; }` guard in the render context'
        );
    });

    it('sets data.cspNonce before the render branch (covers env.render + env.renderString)', function() {
        var s = src();
        var nonceIdx  = s.indexOf('data.cspNonce = _cspNonce');
        var renderIdx = s.indexOf('html = env.render(templateRel, data)');
        var strIdx    = s.indexOf('html = env.renderString(_errSource, data)');
        assert.ok(nonceIdx > -1, 'data.cspNonce assignment present');
        assert.ok(renderIdx > nonceIdx, 'data.cspNonce must be set before env.render()');
        assert.ok(strIdx  > nonceIdx, 'data.cspNonce must be set before env.renderString()');
    });

    // pure-logic replica of the guarded assignment
    function applyNonce(ctx, nonce) {
        if (nonce) { ctx.cspNonce = nonce; }
        return ctx;
    }

    it('replica: sets cspNonce when present, leaves the key absent otherwise', function() {
        assert.strictEqual(applyNonce({}, 'Xy9+/=').cspNonce, 'Xy9+/=');
        assert.ok(!('cspNonce' in applyNonce({}, null)),      'absent when null');
        assert.ok(!('cspNonce' in applyNonce({}, undefined)), 'absent when undefined');
    });

});


// Bundle-compat parity with swig (commit bf474621): three independent edits.
describe('bundle-compat parity with render-swig (commit bf474621)', function() {

    var _src;
    function src() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    // (1) resolveTemplatePath honours self.setTemplate() override
    describe('resolveTemplatePath honours _templateOverride', function() {

        it('declares resolveTemplatePath(data, localOptions)', function() {
            assert.ok(
                /function\s+resolveTemplatePath\s*\(\s*data\s*,\s*localOptions\s*\)/.test(src()),
                'expected `function resolveTemplatePath(data, localOptions)` — helper signature changed or reverted'
            );
        });

        it('checks localOptions._templateOverride.file before falling back to data.page.view.file', function() {
            var s = src();
            var fnMatch = s.match(/function\s+resolveTemplatePath[\s\S]*?\n\}/);
            assert.ok(fnMatch, 'resolveTemplatePath body not found');
            var body = fnMatch[0];
            assert.ok(
                /localOptions\s*&&\s*localOptions\._templateOverride\s*&&\s*localOptions\._templateOverride\.file/.test(body),
                'expected _templateOverride.file guard in resolveTemplatePath — setTemplate() honour was reverted'
            );
            assert.ok(
                /var\s+ovFile\s*=\s*localOptions\._templateOverride\.file/.test(body),
                'expected `var ovFile = localOptions._templateOverride.file` capture'
            );
        });

        it('override path skips the namespace prefix block', function() {
            var s = src();
            var fnMatch = s.match(/function\s+resolveTemplatePath[\s\S]*?\n\}/);
            var body = fnMatch[0];
            var overrideReturn = body.indexOf('return ovFile');
            var nsBlock = body.indexOf('localOptions.namespace');
            assert.ok(overrideReturn > -1, 'expected `return ovFile` early-exit in override branch');
            assert.ok(nsBlock > overrideReturn, 'override must return before reaching the namespace block (no namespace prefixing)');
        });
    });

    // (2) registerUserFilters invokes setup.js with this.engine bound
    describe('registerUserFilters invokes setup.js with this.engine bound to nunjucks env', function() {

        it('declares registerUserFilters with captured req/res/_next params (#M1 async-race guard)', function() {
            assert.ok(
                /function\s+registerUserFilters\s*\(\s*env\s*,\s*self\s*,\s*local\s*,\s*localOptions\s*,\s*req\s*,\s*res\s*,\s*_next\s*\)/.test(src()),
                'expected `function registerUserFilters(env, self, local, localOptions, req, res, _next)` — captured-locals pattern (mirrors registerGinaFilters); reading local.req/res/next inside the helper would re-introduce the #M1 async-race read'
            );
        });

        it('Setup.apply uses captured req/res/_next, not local.req/res/next', function() {
            var s = src();
            // #B807 — the call runs on a per-run receiver (`setupContext`), no longer on the export.
            assert.ok(
                /Setup\.apply\(\s*setupContext\s*,\s*\[\s*req\s*,\s*res\s*,\s*_next\s*\]\s*\)/.test(s),
                'expected `Setup.apply(setupContext, [req, res, _next])` using captured locals — reading local.req/res/next here defeats the #M1 retrofit'
            );
            assert.ok(
                !/Setup\.apply\(\s*(?:Setup|setupContext)\s*,\s*\[\s*local\.req/.test(s),
                'must NOT call Setup.apply with [local.req, local.res, local.next] — captured locals only'
            );
        });

        it('is guarded by an `env._userSetupDone` idempotency marker', function() {
            var s = src();
            assert.ok(
                /if\s*\(\s*env\._userSetupDone\s*\)\s*return/.test(s),
                'expected idempotency early-return `if (env._userSetupDone) return` — would re-run setup.js per render'
            );
            assert.ok(
                /env\._userSetupDone\s*=\s*true/.test(s),
                'expected env._userSetupDone marker to be set after setup invocation'
            );
        });
    });

    // (3) userData merge mirrors render-swig.js — unconditional top-level merge
    describe('userData merge mirrors render-swig (unconditional top-level merge; userData.page merges INTO data.page)', function() {

        it('merges userData.page INTO data.page rather than clobbering it', function() {
            var s = src();
            assert.ok(
                /k\s*===\s*'page'[\s\S]{0,160}Object\.keys\(\s*userData\.page\s*\)\.forEach/.test(s),
                'expected `k === "page"` branch with `Object.keys(userData.page).forEach` — clobber-mode (data.page = userData.page) would erase view metadata'
            );
            assert.ok(
                /data\.page\[\s*pk\s*\]\s*=\s*userData\.page\[\s*pk\s*\]/.test(s),
                'expected per-key write `data.page[pk] = userData.page[pk]` inside the page-merge branch'
            );
        });

        it('keeps the data.page.data stash for the !userData.page branch', function() {
            var s = src();
            assert.ok(
                /data\.page\.data\s*=/.test(s),
                'expected data.page.data assignment to remain for full-page-shape stash'
            );
        });

    });

});


// #29 gap-3 — page.* clobber regression: framework page.environment survives a
// controller passing a partial page subtree, via the merge(data, getData())
// restoration (render-swig.js:593) that nunjucks was missing.
describe('userData merge — framework page.* survives a partial page override (#29 gap-3)', function() {

    var merge = require(path.join(require('../fw'), 'lib/merge'));

    // Pure-logic replica of the render-nunjucks userData merge block (a)+(b)+(c),
    // exercising the REAL framework deep-merge.
    function applyMerge(userData, getData) {
        var data = getData();
        if (userData && typeof(userData) === 'object') {
            if (!userData.page) {
                if (!data.page.data) { data.page.data = {}; }
                Object.keys(userData).forEach(function (k) { data.page.data[k] = userData[k]; });
            }
            Object.keys(userData).forEach(function (k) {
                if (k === 'page' && data.page && typeof userData.page === 'object') {
                    Object.keys(userData.page).forEach(function (pk) { data.page[pk] = userData.page[pk]; });
                } else {
                    data[k] = userData[k];
                }
            });
            data = merge(data, getData());
        }
        return data;
    }

    function freshFrameworkData() {
        return { page: {
            environment: { webroot: '/', hostname: 'h', version: '0.4.1' },
            view: { file: 'home' },
            data: { session: { id: 'sid' } }
        } };
    }

    it('preserves page.environment.webroot/hostname/version when userData passes a partial page.environment', function() {
        var out = applyMerge({ page: { environment: { custom: 'x' } } }, freshFrameworkData);
        assert.strictEqual(out.page.environment.webroot, '/', 'webroot must survive the partial page.environment override');
        assert.strictEqual(out.page.environment.hostname, 'h', 'hostname must survive');
        assert.strictEqual(out.page.environment.version, '0.4.1', 'version must survive');
        assert.strictEqual(out.page.environment.custom, 'x', 'the userData-supplied page.environment key is still present');
    });

    it('preserves framework page.view and page.data.session across a userData.page override', function() {
        var out = applyMerge({ page: { view: { extra: 1 } } }, freshFrameworkData);
        assert.strictEqual(out.page.view.file, 'home', 'framework page.view.file must survive');
        assert.ok(out.page.data && out.page.data.session && out.page.data.session.id === 'sid', 'page.data.session must survive');
    });

    it('promotes flat userData to top level (no page key) and stashes under page.data', function() {
        var out = applyMerge({ client: 'acme', total: 42 }, freshFrameworkData);
        assert.strictEqual(out.client, 'acme', 'flat userData promoted to top-level ({{ client }} resolves)');
        assert.strictEqual(out.total, 42);
        assert.strictEqual(out.page.data.client, 'acme', 'flat userData also stashed under page.data');
    });

    it('SUBTRACT: without the merge(data, getData()) restore, the clobber drops webroot (proves the restore is load-bearing)', function() {
        function noRestore(userData, getData) {
            var data = getData();
            Object.keys(userData).forEach(function (k) {
                if (k === 'page') {
                    Object.keys(userData.page).forEach(function (pk) { data.page[pk] = userData.page[pk]; });
                } else { data[k] = userData[k]; }
            });
            return data;
        }
        var out = noRestore({ page: { environment: { custom: 'x' } } }, freshFrameworkData);
        assert.strictEqual(out.page.environment.webroot, undefined, 'without the restore, webroot is clobbered — this is the bug #29 fixes');
    });

});

// 07 — #M11 nunjucks Inspector parity: data.page.queries + dev statusbar
//
// Closes the two remaining within-Inspector parity gaps against render-swig:
// (a) the raw QI query log is exposed as data.page.queries alongside the
//     flow-timeline fold-in, so __ginaData.user.queries exists for nunjucks
//     pages (the Inspector Queries tab no longer renders empty);
// (b) the dev statusbar ships — statusbar.html is a leaf template (only
//     {% if page.cspNonce %} + {{ }} tags, valid nunjucks) rendered through
//     the resolver module's renderString() AFTER the engine pass and spliced
//     before </body> with a FUNCTION replacer ($-safe: the statusbar body
//     literally contains $` and $' sequences which a string replacement
//     would dollar-expand — the same defect render-swig's #TPL2 splice fix
//     addressed).
describe('07 - #M11 Inspector parity: queries + statusbar', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    it('exposes data.page.queries from local._queryLog (same gate as render-swig)', function() {
        var s = src();
        assert.ok(
            /if\s*\(local\._queryLog\s*&&\s*local\._queryLog\.length\s*>\s*0\)\s*\{\s*data\.page\.queries\s*=\s*local\._queryLog;/.test(s),
            'expected the render-swig-shaped queries gate + assignment'
        );
    });

    it('queries assignment sits in injectInspectorScripts, after the flow fold-in', function() {
        var s = src();
        var helperIdx = s.indexOf('function injectInspectorScripts');
        var flowIdx = s.indexOf('data.page.flow = {', helperIdx);
        var queriesIdx = s.indexOf('data.page.queries = local._queryLog', helperIdx);
        var clonesIdx = s.indexOf('JSON.parse(JSON.stringify(data.page))', helperIdx);
        assert.ok(helperIdx > 0 && flowIdx > helperIdx, 'flow block inside the helper');
        assert.ok(queriesIdx > flowIdx, 'queries assignment after the flow block');
        assert.ok(queriesIdx < clonesIdx, 'queries assigned BEFORE the payload deep-clones');
    });

    it('reads statusbar.html from the framework core dist (per-render, hot-reloadable)', function() {
        var s = src();
        assert.ok(
            /fs\.readFileSync\(\s*\n?\s*getPath\('gina'\)\.core\s*\+\s*'\/asset\/plugin\/dist\/vendor\/gina\/html\/statusbar\.html'/.test(s),
            'expected the statusbar.html read in injectInspectorScripts'
        );
    });

    it('renders the statusbar through the resolver module renderString (post-engine pass)', function() {
        assert.ok(
            src().indexOf("require('../../lib/nunjucks-resolver').get().renderString(_statusbarTpl, data)") > 0,
            'expected renderString over the statusbar body with the render data'
        );
    });

    it('statusbar read + render is contained in try/catch (best-effort, never breaks the render)', function() {
        var s = src();
        var sbIdx = s.indexOf('var _statusbarHtml');
        var trIdx = s.indexOf('try {', sbIdx);
        var caIdx = s.indexOf('catch (_sbErr)', sbIdx);
        var spliceIdx = s.indexOf('var _injected', sbIdx);
        assert.ok(sbIdx > 0 && trIdx > sbIdx && caIdx > trIdx && spliceIdx > caIdx,
            'statusbar build wrapped in try/catch ahead of the splice');
    });

    it('splices with a function replacer ($-safe), statusbar between payload scripts and </body>', function() {
        var s = src();
        assert.ok(
            /var _injected\s*=\s*'\\t'\s*\+\s*__logsScript\s*\+\s*__gdScript\s*\+\s*_statusbarHtml\s*\+\s*'\\n\\t<\/body>'/.test(s),
            'expected the injected block composition'
        );
        assert.ok(
            /return html\.replace\(\/<\\\/body>\/i,\s*function\s*\(\)\s*\{\s*return\s+_injected;\s*\}\s*\)/.test(s),
            'expected the function-replacer splice'
        );
        // No string-replacement splice of the inspector block remains.
        assert.ok(
            s.indexOf("html.replace(/<\\/body>/i, '\\t' + __logsScript") < 0,
            'the old string-replacement splice must be gone'
        );
    });

    // Behavioural replica of the $-safety property: a payload carrying
    // dollar-quote / dollar-backtick sequences must splice verbatim.
    it('$-safe splice replica: dollar sequences survive verbatim (subtract: string form corrupts)', function() {
        var html = '<html><body><p>content before</p></body></html>';
        var block = '<script>var re = /\\$\'/; // and a $` in a comment</script>';
        var injected = '\t' + block + '\n\t</body>';
        var safe = html.replace(/<\/body>/i, function () { return injected; });
        assert.ok(safe.indexOf(block) > 0, 'function replacer keeps the block verbatim');
        // Subtract-my-contribution: the string form dollar-expands $' (the
        // post-match text) into the block — proving the replacer is the
        // load-bearing half of the fix.
        var corrupted = html.replace(/<\/body>/i, injected);
        assert.ok(corrupted.indexOf(block) < 0, 'string replacement corrupts the block');
        // $' substitutes the POST-MATCH text (everything after </body>).
        assert.ok(corrupted.indexOf('</html>/; // and a') > 0, "$' expanded the post-match text");
        // $` substitutes the PRE-MATCH text.
        assert.ok(corrupted.indexOf('a <html><body><p>content before</p> in a comment') > 0,
            '$` expanded the pre-match text');
    });

    // Behavioural: the statusbar body's single directive renders under
    // plain nunjucks renderString when the project has nunjucks installed
    // (same install-gate idiom as the other behavioural nunjucks tests).
    it('statusbar.html body renders under nunjucks renderString (gated on nunjucks install)', function(t) {
        var nunjucks;
        try { nunjucks = require('nunjucks'); }
        catch (e) { t.skip('nunjucks not installed in this environment'); return; }
        var FW = require('../fw');
        var sb = fs.readFileSync(
            path.join(FW, 'core/asset/plugin/dist/vendor/gina/html/statusbar.html'), 'utf8'
        );
        var withNonce = nunjucks.renderString(sb, { page: { cspNonce: 'abc123' } });
        assert.ok(withNonce.indexOf('nonce="abc123"') > 0, 'nonce attribute rendered');
        var withoutNonce = nunjucks.renderString(sb, { page: {} });
        assert.ok(withoutNonce.indexOf('nonce=') < 0, 'no nonce attribute without page.cspNonce');
        assert.ok(withoutNonce.indexOf('{%') < 0 && withoutNonce.indexOf('{{') < 0,
            'no unrendered template directives remain');
    });
});


describe('08 - released-response guard (#B45)', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    // renderNunjucks() captures req/res/next (#M1) then proceeds to setResources, which
    // reads local.req.headers (controller.js:896). When a controller fires several parallel
    // self.query() calls against a downed upstream — the first failure callback renders +
    // releases the triplet, then a later callback re-enters renderNunjucks() here with
    // local.res === null — that deref threw. Guarded at the top, mirroring render-json.js
    // (#B36). (render-nunjucks's own res.stream read is already (res && ...)-safe, so the
    // crash surfaces at the setResources -> local.req.headers path.)

    it('renderNunjucks guards a released response after the #M1 captures, before renderCache.from', function() {
        var s = src();
        var guardIdx   = s.search(/if\s*\(\s*local\.res\s*==\s*null\s*\)\s*\{[\s\S]{0,40}?return;/);
        var captureIdx = s.search(/var\s+_next\s*=\s*local\.next;/);
        var cacheIdx   = s.indexOf('renderCache.from(self.serverInstance._cached)');
        assert.ok(guardIdx > -1, 'expected an `if ( local.res == null ) return;` guard in renderNunjucks()');
        assert.ok(captureIdx > -1 && captureIdx < guardIdx, 'guard must follow the #M1 req/res/next captures');
        assert.ok(cacheIdx > guardIdx, 'guard must precede renderCache.from / the first per-request work');
    });

    // ---- pure-logic replica of the guard + render-nunjucks's released-response crash site ----
    function renderNunjucksHead(local, mode) {
        // mode: 'fixed' (post-#B45) | 'prefix' (pre-#B45, no guard)
        if (mode === 'fixed' && local.res == null) return 'no-op (released)';
        var req = local.req;   // #M1 capture
        // setResources reads local.req.headers (controller.js:896) — reached once render
        // proceeds past the guard on a released instance.
        var proto = (typeof req.headers['x-forwarded-proto'] != 'undefined')
            ? req.headers['x-forwarded-proto'] : 'https';
        return 'rendered (' + proto + ')';
    }

    it('replica: released response no-ops; live response proceeds', function() {
        assert.strictEqual(renderNunjucksHead({ req: null, res: null }, 'fixed'), 'no-op (released)');
        assert.strictEqual(renderNunjucksHead({ req: { headers: {} }, res: {} }, 'fixed'), 'rendered (https)');
    });

    it('subtract: the pre-fix head throws reading `headers` on a released response', function() {
        assert.throws(function() { renderNunjucksHead({ req: null, res: null }, 'prefix'); },
            function(err) {
                return err instanceof TypeError
                    && /Cannot read properties of null \(reading 'headers'\)/.test(err.message);
            },
            'the unguarded renderNunjucks head must reproduce the released-response crash');
    });
});


// ─── 09 — #RWATCH stale-release banner injection (S3) ───────────────────────
//
// Mirror of render-swig.test.js section 24. renderNunjucks calls
// releaseBanner.maybeInject() on the finalized HTML AFTER the inspector
// injection and BEFORE writeCache, so the banner rides both cache-miss renders
// and cache-hit replays. The injector is a shared, standalone module — the
// behavioral tests below drive the REAL release-banner.js.
describe('09 - #RWATCH stale-release banner injection', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    var BANNER_SRC = path.join(require('../fw'), 'core/controller/release-banner.js');
    function bannerSrc() { return fs.readFileSync(BANNER_SRC, 'utf8'); }
    var releaseBanner = require(BANNER_SRC);

    // ── delegate source pins ──
    it('renderNunjucks requires the release-banner injector', function() {
        assert.match(src(), /var\s+releaseBanner\s*=\s*require\('\.\/release-banner'\)/,
            "expected `var releaseBanner = require('./release-banner')` in render-nunjucks.js");
    });

    it('maybeInject is called once, before writeCache', function() {
        var s = src();
        var calls = s.match(/releaseBanner\.maybeInject\(\s*html\s*,\s*localOptions\.conf\s*,\s*_cspNonceAttr\s*\)/g);
        assert.ok(calls && calls.length === 1,
            'expected exactly 1 releaseBanner.maybeInject(html, localOptions.conf, _cspNonceAttr) site');
        assert.ok(s.indexOf('releaseBanner.maybeInject(') < s.indexOf('await writeCache('),
            'the inject must precede writeCache (the banner rides the stored cache bytes)');
    });

    // ── banner source pin: the </body> splice is a FUNCTION replacer ($-safe form) ──
    it('maybeInject splices via a function replacer, not a string replacement', function() {
        var b = bannerSrc();
        assert.match(b, /html\.replace\(\/<\\\/body>\/i,\s*function\s*\(\)\s*\{\s*return\s+'\\n'\s*\+\s*snippet/,
            'expected the </body> splice to use a function replacer (String.replace $-expansion safety)');
        assert.doesNotMatch(b, /html\.replace\(\/<\\\/body>\/i,\s*'\\n'\s*\+\s*snippet/,
            'the vulnerable string-replacement form must be absent');
    });

    // ── behavioral against the real release-banner module ──
    function setOrDel(k, v) { if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; } }
    function withGate(scopeLocal, envDev, fn) {
        var s = process.env.NODE_SCOPE_IS_LOCAL, d = process.env.NODE_ENV_IS_DEV;
        setOrDel('NODE_SCOPE_IS_LOCAL', scopeLocal);
        setOrDel('NODE_ENV_IS_DEV', envDev);
        try { return fn(); } finally { setOrDel('NODE_SCOPE_IS_LOCAL', s); setOrDel('NODE_ENV_IS_DEV', d); }
    }
    var CONF_ON  = { server: { releaseWatch: { enabled: true  } } };
    var CONF_OFF = { server: { releaseWatch: { enabled: false } } };
    var PAGE = '<!DOCTYPE html><html><head></head><body><div>PAGEBODY</div></body></html>';

    it('gate ON (local + !dev + enabled): injects the shadow-DOM banner into the stored HTML', function() {
        var out = withGate('true', undefined, function() { return releaseBanner.maybeInject(PAGE, CONF_ON, ''); });
        assert.notStrictEqual(out, PAGE, 'the banner must be injected when the gate passes');
        assert.ok(out.indexOf(releaseBanner.MARKER) > -1, 'the marker (double-injection guard token) must be present');
        assert.ok(out.indexOf('attachShadow') > -1, 'the shadow-DOM client must be present');
        assert.ok(out.indexOf('EventSource(') > -1 && out.indexOf('/_gina/release/status') > -1,
            'the live client (SSE + status fetch) must be present');
        assert.strictEqual((out.match(/<\/body>/g) || []).length, 1, 'exactly one </body> (function replacer, no duplication)');
        assert.strictEqual((out.match(/PAGEBODY/g) || []).length, 1, 'no page-body duplication (function replacer)');
        assert.match(out, /<\/script>\s*<\/body>/, 'the snippet is spliced immediately before </body>');
    });

    it('gate OFF — scope not local: HTML unchanged', function() {
        assert.strictEqual(withGate('false', undefined, function() { return releaseBanner.maybeInject(PAGE, CONF_ON, ''); }), PAGE);
    });

    it('gate OFF — dev env: HTML unchanged', function() {
        assert.strictEqual(withGate('true', 'true', function() { return releaseBanner.maybeInject(PAGE, CONF_ON, ''); }), PAGE);
    });

    it('gate OFF — releaseWatch.enabled false: HTML unchanged', function() {
        assert.strictEqual(withGate('true', undefined, function() { return releaseBanner.maybeInject(PAGE, CONF_OFF, ''); }), PAGE);
    });

    it('gate OFF — releaseWatch config missing: HTML unchanged', function() {
        assert.strictEqual(withGate('true', undefined, function() { return releaseBanner.maybeInject(PAGE, { server: {} }, ''); }), PAGE);
    });

    it('non-HTML (no </body>, e.g. a JSON/API body) is skipped', function() {
        var json = '{"ok":true}';
        assert.strictEqual(withGate('true', undefined, function() { return releaseBanner.maybeInject(json, CONF_ON, ''); }), json);
    });

    it('non-string input is returned as-is', function() {
        var obj = { page: 1 };
        assert.strictEqual(withGate('true', undefined, function() { return releaseBanner.maybeInject(obj, CONF_ON); }), obj);
    });

    it('double injection is a no-op (marker guard — a cached page already carrying the banner)', function() {
        var once  = withGate('true', undefined, function() { return releaseBanner.maybeInject(PAGE, CONF_ON, ''); });
        var twice = withGate('true', undefined, function() { return releaseBanner.maybeInject(once, CONF_ON, ''); });
        assert.strictEqual(twice, once, 'a second inject on already-injected HTML must be a no-op');
        assert.strictEqual(once.split(releaseBanner.MARKER).length - 1, 1, 'the marker must appear exactly once');
    });

    it('the CSP nonce is applied to the injected <script> (#HDR16)', function() {
        var out = withGate('true', undefined, function() {
            return releaseBanner.maybeInject(PAGE, CONF_ON, ' nonce="abc123"');
        });
        assert.ok(out.indexOf('<script nonce="abc123">') > -1, 'the nonce attribute must ride the injected script tag');
    });

    // ── pure-logic $-safe replica (mirrors render-swig §18): the function-replacer FORM
    //    maybeInject uses inserts content verbatim; the string form would $-expand /
    //    duplicate the doc. (Measured 2026-07-15: the current snippet carries no $-special
    //    sequence, so the form is defensive here — it guards any future $-content.)
    var DOLLAR_BACKTICK = '$' + '`';
    var DOLLAR_QUOTE    = '$' + "'";
    function spliceUnsafe(doc, inj) { return doc.replace(/<\/body>/i, inj + '</body>'); }
    function spliceSafe(doc, inj)   { return doc.replace(/<\/body>/i, function () { return inj + '</body>'; }); }
    var DOC = '<!DOCTYPE html><html><body><div>PAGEBODY</div></body></html>';
    var INJ = '<script>/* ' + DOLLAR_BACKTICK + ' ' + DOLLAR_QUOTE + ' */</script>';

    it('replica: the string form nests the document (why the injector avoids it)', function() {
        var out = spliceUnsafe(DOC, INJ);
        assert.ok((out.match(/PAGEBODY/g) || []).length > 1,
            'a string replacement duplicates the page body via the prematch pattern');
    });

    it('replica: the function-replacer form inserts verbatim (the form maybeInject uses)', function() {
        var out = spliceSafe(DOC, INJ);
        assert.strictEqual((out.match(/PAGEBODY/g) || []).length, 1, 'no duplication with a function replacer');
        assert.ok(out.indexOf(DOLLAR_BACKTICK) > -1 && out.indexOf(DOLLAR_QUOTE) > -1,
            'the $-sequences survive verbatim in the injected content');
    });

});
