var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC    = path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var EVENTS_SRC   = path.join(FW, 'core/asset/plugin/src/vendor/gina/utils/events.js');
var BINDING_SRC  = path.join(FW, 'core/asset/plugin/src/vendor/gina/helpers/binding.js');
var DIST_JS      = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

var _popinSrc, _eventsSrc, _bindingSrc, _distSrc;
function getPopinSrc()  { return _popinSrc  || (_popinSrc  = fs.readFileSync(POPIN_SRC, 'utf8')); }
function getEventsSrc() { return _eventsSrc || (_eventsSrc = fs.readFileSync(EVENTS_SRC, 'utf8')); }
function getBindingSrc(){ return _bindingSrc|| (_bindingSrc= fs.readFileSync(BINDING_SRC, 'utf8')); }
function getDistSrc()   { return _distSrc   || (_distSrc   = fs.readFileSync(DIST_JS, 'utf8')); }


// ── 01 — Popin performance: crypto.randomUUID() replaced by _nextId() ─────────

describe('01 - Popin perf: _nextId() replaces crypto.randomUUID()', function() {

    it('_nextId function is defined', function() {
        assert.ok(
            /function\s+_nextId\s*\(/.test(getPopinSrc()),
            'expected _nextId function declaration in popin/main.js'
        );
    });

    it('no crypto.randomUUID() calls remain in popin source', function() {
        // Only allowed in comments (lines starting with // or inside JSDoc)
        var lines = getPopinSrc().split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (/crypto\.randomUUID\(\)/.test(line) && !/^(\/\/|\*)/.test(line)) {
                assert.fail('crypto.randomUUID() found in executable code at line ' + (i + 1) + ': ' + line);
            }
        }
    });

    it('_nextId is used for instance ID', function() {
        assert.ok(
            /id\s*:\s*'gina-popins-'\s*\+\s*_nextId\(\)/.test(getPopinSrc()),
            'expected _nextId() in instance id assignment'
        );
    });
});


// ── 02 — Popin perf: querySelectorAll replaces getElementsByAttribute ──────────

describe('02 - Popin perf: querySelectorAll for DOM scanning', function() {

    it('uses querySelectorAll for data-gina-popin-name', function() {
        assert.ok(
            getPopinSrc().indexOf("document.querySelectorAll('[' + attr + ']')") > -1,
            'expected querySelectorAll for popin name attribute lookup'
        );
    });

    it('uses querySelectorAll for .gina-popin-close', function() {
        var matches = getPopinSrc().match(/querySelectorAll\('\.gina-popin-close'\)/g);
        assert.ok(
            matches && matches.length >= 2,
            'expected at least 2 querySelectorAll calls for .gina-popin-close (popinBind + overlay)'
        );
    });

    it('no getElementsByAttribute calls remain', function() {
        // getElementsByAttribute is the old full-DOM scan helper
        assert.ok(
            getPopinSrc().indexOf('getElementsByAttribute(') === -1,
            'getElementsByAttribute should be replaced by querySelectorAll'
        );
    });
});


// ── 03 — Popin perf: classList API replaces className string manipulation ──────

describe('03 - Popin perf: classList API', function() {

    it('uses classList.add for gina-popin-is-active', function() {
        assert.ok(
            getPopinSrc().indexOf("classList.add('gina-popin-is-active')") > -1,
            'expected classList.add for activation'
        );
    });

    it('uses classList.remove for gina-popin-is-active', function() {
        assert.ok(
            getPopinSrc().indexOf("classList.remove('gina-popin-is-active')") > -1,
            'expected classList.remove for deactivation'
        );
    });

    it('uses classList.contains for gina-popin-is-active checks', function() {
        assert.ok(
            getPopinSrc().indexOf("classList.contains('gina-popin-is-active')") > -1,
            'expected classList.contains for class presence checks'
        );
    });

    it('no className += gina-popin-is-active concatenation remains', function() {
        assert.ok(
            !/className\s*\+=\s*.*gina-popin-is-active/.test(getPopinSrc()),
            'className string concatenation for gina-popin-is-active should be replaced by classList'
        );
    });
});


// ── 04 — Popin perf: cached RegExp for click handler ──────────────────────────

describe('04 - Popin perf: cached RegExp', function() {

    it('_rePopinClick is defined once', function() {
        assert.ok(
            /var\s+_rePopinClick\s*=\s*new\s+RegExp/.test(getPopinSrc()),
            'expected _rePopinClick cached regex'
        );
    });

    it('click handlers use _rePopinClick instead of new RegExp', function() {
        var matches = getPopinSrc().match(/_rePopinClick\.test\(/g);
        assert.ok(
            matches && matches.length >= 2,
            'expected at least 2 uses of _rePopinClick.test()'
        );
    });

    it('no inline RegExp with instance.id for popin click matching in executable code', function() {
        // The general prefix check (without instance.id) at line 222 is intentional
        // Line 223 is a commented-out variant — only executable code matters
        var src = getPopinSrc();
        var lines = src.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (/new\s+RegExp.*popin\.click\.gina-popin-.*instance\.id/.test(line) && !/^\/\//.test(line)) {
                assert.fail('inline RegExp with instance.id in executable code at line ' + (i + 1));
            }
        }
    });
});


// ── 05 — Popin perf: getScript/getStyle use DOM injection ─────────────────────

describe('05 - Popin perf: getScript/getStyle DOM injection', function() {

    it('getScript creates a <script> element', function() {
        assert.ok(
            /document\.createElement\('script'\)/.test(getPopinSrc()),
            'expected document.createElement(script) in getScript'
        );
    });

    it('getStyle creates a <link> element', function() {
        assert.ok(
            /document\.createElement\('link'\)/.test(getPopinSrc()),
            'expected document.createElement(link) in getStyle'
        );
    });

    it('no eval() in getScript or getStyle', function() {
        // Find getScript and getStyle function bodies and verify no eval() in executable code
        var src = getPopinSrc();
        var scriptFn = src.substring(
            src.indexOf('function getScript('),
            src.indexOf('function getStyle(')
        );
        var styleFn = src.substring(
            src.indexOf('function getStyle('),
            src.indexOf('function refreshCSS(')
        );
        // Filter out comments (lines with * or //) before checking for eval
        var scriptLines = scriptFn.split('\n').filter(function(l) {
            return !/^\s*(\/\/|\*|\*\/)/.test(l.trim());
        }).join('\n');
        var styleLines = styleFn.split('\n').filter(function(l) {
            return !/^\s*(\/\/|\*|\*\/)/.test(l.trim());
        }).join('\n');
        assert.ok(
            scriptLines.indexOf('eval(') === -1,
            'eval() must not appear in getScript executable code'
        );
        assert.ok(
            styleLines.indexOf('eval(') === -1,
            'eval() must not appear in getStyle executable code'
        );
    });

    it('getScript and getStyle track headers on $popin for cleanup', function() {
        assert.ok(
            /\$popin\.\$headers\.push/.test(getPopinSrc()),
            'expected $headers tracking for injected resources'
        );
    });
});


// ── 06 — Popin perf: double popinBind guard ───────────────────────────────────

describe('06 - Popin perf: popinBind dedup guard in popinOpen', function() {

    it('popinOpen guards popinBind with gina.popinIsBinded check', function() {
        var src = getPopinSrc();
        // Find the popinOpen function — needs enough range to reach the guard
        var fnStart = src.indexOf('function popinOpen(');
        var fnBlock = src.substring(fnStart, fnStart + 4000);
        assert.ok(
            /if\s*\(!gina\.popinIsBinded\)/.test(fnBlock),
            'expected gina.popinIsBinded guard before popinBind in popinOpen'
        );
    });
});


// ── 07 — Popin perf: per-load XHR ────────────────────────────────────────────

describe('07 - Popin perf: per-load XMLHttpRequest', function() {

    it('popinLoad creates a local xhr', function() {
        var src = getPopinSrc();
        var fnStart = src.indexOf('function popinLoad(');
        var fnBlock = src.substring(fnStart, fnStart + 6000);
        assert.ok(
            /\/\/\s*Fresh XHR per load/.test(fnBlock),
            'expected per-load XHR comment marker in popinLoad'
        );
        assert.ok(
            fnBlock.indexOf('var xhr = null;') > -1,
            'expected local var xhr declaration in popinLoad'
        );
    });

    it('registerPopin does not create xhr', function() {
        var src = getPopinSrc();
        var fnStart = src.indexOf('function registerPopin(');
        // End at var init (which uses = function, not function declaration)
        var fnBlock = src.substring(fnStart, src.indexOf('var init = function'));
        assert.ok(
            fnBlock.indexOf('new XMLHttpRequest()') === -1,
            'registerPopin should not create XMLHttpRequest (moved to popinLoad)'
        );
    });
});


// ── 08 — Popin: popinDestroy implementation ───────────────────────────────────

describe('08 - Popin: popinDestroy is fully implemented', function() {

    it('popinDestroy closes the popin if open', function() {
        var src = getPopinSrc();
        var fnStart = src.indexOf('function popinDestroy(');
        var fnEnd = src.indexOf('\n        function', fnStart + 1);
        var fnBlock = src.substring(fnStart, fnEnd);
        assert.ok(
            /popinClose\(name\)/.test(fnBlock),
            'expected popinClose call in popinDestroy'
        );
    });

    it('popinDestroy removes the DOM element', function() {
        var src = getPopinSrc();
        var fnStart = src.indexOf('function popinDestroy(');
        var fnEnd = src.indexOf('\n        function', fnStart + 1);
        var fnBlock = src.substring(fnStart, fnEnd);
        assert.ok(
            /\$el\.remove\(\)/.test(fnBlock),
            'expected DOM element removal in popinDestroy'
        );
    });

    it('popinDestroy cleans up instance.$popins registry', function() {
        var src = getPopinSrc();
        var fnStart = src.indexOf('function popinDestroy(');
        var fnEnd = src.indexOf('\n        function', fnStart + 1);
        var fnBlock = src.substring(fnStart, fnEnd);
        assert.ok(
            /delete\s+instance\.\$popins\[id\]/.test(fnBlock),
            'expected delete instance.$popins[id]'
        );
    });

    it('popinDestroy cleans up registeredPopins array', function() {
        var src = getPopinSrc();
        var fnStart = src.indexOf('function popinDestroy(');
        var fnEnd = src.indexOf('\n        function', fnStart + 1);
        var fnBlock = src.substring(fnStart, fnEnd);
        assert.ok(
            /registeredPopins\.splice/.test(fnBlock),
            'expected registeredPopins splice in popinDestroy'
        );
    });

    it('popinDestroy fires the destroy event', function() {
        var src = getPopinSrc();
        var fnStart = src.indexOf('function popinDestroy(');
        var fnEnd = src.indexOf('\n        function', fnStart + 1);
        var fnBlock = src.substring(fnStart, fnEnd);
        assert.ok(
            /triggerEvent\(gina,\s*instance\.target,\s*'destroy\.'/.test(fnBlock),
            'expected destroy event trigger'
        );
    });

    it('destroy is exposed on instance proto', function() {
        assert.ok(
            /instance\.destroy\s*=\s*popinDestroy/.test(getPopinSrc()),
            'expected instance.destroy = popinDestroy in setupInstanceProto'
        );
    });
});


// ── 09 — Popin: registeredPopins is populated ─────────────────────────────────

describe('09 - Popin: registeredPopins is populated on registration', function() {

    it('registerPopin pushes to registeredPopins', function() {
        var src = getPopinSrc();
        var fnStart = src.indexOf('function registerPopin(');
        var fnBlock = src.substring(fnStart, fnStart + 1500);
        assert.ok(
            /registeredPopins\.push\(\$popin\.options\['name'\]\)/.test(fnBlock),
            'expected registeredPopins.push in registerPopin'
        );
    });
});


// ── 10 — events.js: malformed regex fix ───────────────────────────────────────

describe('10 - events.js: regex fix in XHR error handler', function() {

    it('regex test is correctly formed (/.test() not between delimiters)', function() {
        var src = getEventsSrc();
        // The old buggy form: /^(\{|\[).test( xhr.responseText ) /
        assert.ok(
            src.indexOf('.test( xhr.responseText ) /') === -1,
            'malformed regex (closing / after .test()) should be fixed'
        );
    });

    it('correct regex form exists', function() {
        assert.ok(
            getEventsSrc().indexOf("/^(\\{|\\[)/.test( xhr.responseText )") > -1,
            'expected properly formed /^({|[)/.test(xhr.responseText)'
        );
    });
});


// ── 11 — events.js: hearder typo fix ─────────────────────────────────────────

describe('11 - events.js: header variable name fix', function() {

    it('no "hearder" typo remains', function() {
        assert.ok(
            getEventsSrc().indexOf('hearder') === -1,
            'typo "hearder" should be replaced with "header"'
        );
    });

    it('"for (var header in options.headers)" exists', function() {
        var matches = getEventsSrc().match(/for\s*\(var\s+header\s+in\s+options\.headers\)/g);
        assert.ok(
            matches && matches.length >= 1,
            'expected corrected "header" loop variable'
        );
    });
});


// ── 12 — binding.js: operator precedence fix ──────────────────────────────────

describe('12 - binding.js: operator precedence in error logging', function() {

    it('err.stack || err is wrapped in parentheses', function() {
        assert.ok(
            getBindingSrc().indexOf('(err.stack || err)') > -1,
            'expected (err.stack || err) with parens to fix precedence'
        );
    });

    it('old unparenthesized form is gone', function() {
        // The old form: + err.stack || err  (without parens around ||)
        // Must not match the fixed form which has parens
        var src = getBindingSrc();
        var lines = src.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (/\+\s*err\.stack\s*\|\|\s*err[^)]/.test(lines[i])) {
                assert.fail('unparenthesized err.stack || err found at line ' + (i + 1));
            }
        }
    });
});


// ── 13 — dist bundle includes all changes ─────────────────────────────────────

describe('13 - dist/gina.min.js reflects source changes', function() {

    it('dist contains _nextId function', function() {
        assert.ok(
            /function\s+_nextId/.test(getDistSrc()),
            'expected _nextId in built dist/gina.min.js'
        );
    });

    it('dist contains no crypto.randomUUID in popin module', function() {
        // The popin AMD module in the bundle should not contain crypto.randomUUID
        var distSrc = getDistSrc();
        var popinStart = distSrc.indexOf("define('gina/popin'");
        if (popinStart === -1) {
            assert.fail('gina/popin AMD module not found in dist bundle');
        }
        var popinBlock = distSrc.substring(popinStart, popinStart + 20000);
        var lines = popinBlock.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (/crypto\.randomUUID\(\)/.test(line) && !/^(\/\/|\*)/.test(line)) {
                assert.fail('crypto.randomUUID() in dist popin module at line ' + (i + 1));
            }
        }
    });

    it('dist contains corrected regex in events module', function() {
        assert.ok(
            getDistSrc().indexOf("/^(\\{|\\[)/.test( xhr.responseText )") > -1,
            'expected fixed regex in dist'
        );
    });

    it('dist contains operator precedence fix in binding module', function() {
        assert.ok(
            getDistSrc().indexOf('(err.stack || err)') > -1,
            'expected parenthesized err.stack || err in dist'
        );
    });
});


// ── 14 — Popin: no inline onclick injection on close (CSP script-src-attr) ─────
//
// The close-binding loop used to inject `onclick="return false;"` on every
// .gina-popin-close element. Under a nonce-based CSP (a 'nonce-…' in script-src,
// no effective 'unsafe-inline'), a nonce disables 'unsafe-inline' for inline
// event-handler attributes (script-src-attr), so the injected handler is reported
// (report-only) or blocked (enforce). It was redundant: register('close', …)
// attaches a click listener that calls cancelEvent() (preventDefault) on every
// click, so an <a href="#"> default action is already suppressed. Injection removed.

describe('14 - Popin: no inline onclick injection on close (CSP-safe)', function() {

    function getDistPopinBlock() {
        var distSrc = getDistSrc();
        var start = distSrc.indexOf("define('gina/popin'");
        assert.ok(start > -1, 'gina/popin AMD module not found in dist bundle');
        var next = distSrc.indexOf('\ndefine(', start + 20);
        return (next > -1) ? distSrc.substring(start, next) : distSrc.substring(start);
    }

    it('popin source no longer injects an inline onclick handler', function() {
        assert.equal(
            getPopinSrc().indexOf("setAttribute('onclick'"), -1,
            "popin/main.js must not set an inline onclick attribute (trips CSP script-src-attr under nonce policies)"
        );
    });

    it('the dead onclickAttribute local is gone', function() {
        assert.equal(
            getPopinSrc().indexOf('onclickAttribute'), -1,
            'the onclickAttribute variable (and its never-written-back append branch) should be removed'
        );
    });

    it("close behaviour is still wired via register('close', …)", function() {
        assert.ok(
            /register\('close',\s*evt,\s*\$close\[b\]\)/.test(getPopinSrc()),
            "expected register('close', evt, $close[b]) to still bind the close listener"
        );
    });

    it('cancelEvent (relied on by the close listener) calls preventDefault', function() {
        // This is what makes removing the inline onclick safe: the registered click
        // listener suppresses the default <a href="#"> navigation itself.
        var ev = getEventsSrc();
        var start = ev.indexOf('function cancelEvent');
        assert.ok(start > -1, 'cancelEvent function not found in events.js');
        var body = ev.substring(start, start + 400);
        assert.ok(
            body.indexOf('preventDefault') > -1,
            'cancelEvent must call preventDefault (close-listener default suppression)'
        );
    });

    it('rebuilt dist popin module contains no inline onclick injection', function() {
        assert.equal(
            getDistPopinBlock().indexOf("setAttribute('onclick'"), -1,
            'the built gina/popin module must not inject an inline onclick attribute'
        );
    });
});


// ── 15 — Popin: modal vs non-modal split (showModal for modal, show for non-modal) ─
//
// The dev-only env downgrade is still gone (the three overlay gates carry no
// `|| gina.config.envIsDev` disjunct; the manual .gina-popins-overlay survives only
// for non-dialog mode, !useDialogMode). What changed: the new `data-gina-dialog-*`
// API defaults to NON-modal, so popinOpen now branches on a resolved `useModal`
// boolean — `$el.showModal()` for the modal path, `$el.show()` (+ applyNonModalShims)
// for the non-modal path. Any path that does NOT set `$popin.modal` (legacy
// `data-gina-popin-*` triggers, direct popinOpen() calls) falls back to modal, so
// legacy parity is preserved (legacy popins stay showModal()-only). The
// `!hasAttribute('open')` re-entry guard is kept (re-showModal/re-show on an
// already-open dialog throws). Replaces the prior "showModal()-only" pins, which were
// updated deliberately when the non-modal default was added (see plan Test 15).

describe('15 - Popin: modal/non-modal split (showModal vs show, legacy=modal)', function() {

    function getDistPopinBlock() {
        var distSrc = getDistSrc();
        var start = distSrc.indexOf("define('gina/popin'");
        assert.ok(start > -1, 'gina/popin AMD module not found in dist bundle');
        var next = distSrc.indexOf('\ndefine(', start + 20);
        return (next > -1) ? distSrc.substring(start, next) : distSrc.substring(start);
    }

    it('source: overlay gates no longer carry the gina.config.envIsDev disjunct', function() {
        assert.equal(
            getPopinSrc().indexOf('useDialogMode || gina.config.envIsDev'), -1,
            'the 3 overlay gates must be `!self.options.useDialogMode` only (no `|| gina.config.envIsDev`)'
        );
    });

    it('source: the dialog-open branch calls $el.showModal() for the modal path', function() {
        assert.ok(
            getPopinSrc().indexOf('$el.showModal();') > -1,
            'popinOpen must call $el.showModal() in the modal branch'
        );
    });

    it('source: a gated non-modal $el.show() branch exists (new-API default)', function() {
        var src = getPopinSrc();
        assert.ok(
            src.indexOf('$el.show()') > -1,
            'popinOpen must have a non-modal $el.show() branch (new data-gina-dialog default is non-modal)'
        );
        // It is gated on a resolved modal boolean, not unconditional — legacy/direct
        // paths fall back to modal (showModal).
        assert.ok(
            /var\s+useModal\s*=/.test(src),
            'expected a resolved `useModal` gate selecting showModal() vs show()'
        );
        assert.ok(
            /applyNonModalShims\s*\(/.test(src),
            'the non-modal branch must restore Escape/scroll-lock/inert via applyNonModalShims()'
        );
    });

    it("source: the `useDialogMode && !$el.hasAttribute('open')` guard is preserved (#B574)", function() {
        assert.ok(
            /useDialogMode\s*&&\s*!\$el\.hasAttribute\('open'\)/.test(getPopinSrc()),
            "popinOpen must keep the open-guard so a consumer-preopened modal is not re-shown (re-showModal throws)"
        );
    });

    it('dist: built popin module reflects the modal/non-modal split (no env gate; both show() & showModal())', function() {
        var block = getDistPopinBlock();
        assert.equal(
            block.indexOf('useDialogMode || gina.config.envIsDev'), -1,
            'built popin module must not carry the envIsDev overlay-gate disjunct'
        );
        assert.ok(
            block.indexOf('$el.show()') > -1,
            'built popin module must contain the non-modal $el.show() branch'
        );
        assert.ok(
            block.indexOf('$el.showModal()') > -1,
            'built popin module must call $el.showModal() for the modal branch'
        );
    });
});


// ── 16 — Popin: opt-in skeleton-loading pre-open (preOpen + loadingShell) ──────
//
// showLoadingShell($popin, $el) fills a popin with a loading skeleton and opens it
// born-modal BEFORE the XHR returns, gated on the per-popin `preOpen` option. The
// optional `loadingShell` lets a consumer pass its own markup (so it can delete its
// own pre-open observer and keep its look); otherwise a generic gina-namespaced
// default skeleton (GINA_DEFAULT_LOADING_SHELL, styled by .gina-popin-skeleton* in
// popin.css) is used. It is invoked at BOTH loading-attr write sites and is
// idempotent (the open/active guard makes it fire at most once per load). On
// completion popinBind replaces the skeleton with the real HTML and popinOpen's
// !$el.hasAttribute('open') guard skips its own open.
//
// Strategy (same convention as validator-aria-invalid / validator-isinlist):
//  - a jsdom-backed DOM exercises a test-local replica of showLoadingShell.
//  - the source-inspection block pins the production source to the same logic so the
//    replica cannot silently drift. (jsdom ^29 has no native <dialog>.showModal(),
//    so the modal branch is exercised via a showModal spy on the element.)

var { JSDOM } = require('jsdom');

// Test-local replica of showLoadingShell($popin, $el) — MUST mirror popin/main.js.
// The source-inspection pins at the end lock the source-side shape to this.
var GINA_DEFAULT_LOADING_SHELL_REPLICA =
      '<div class="gina-popin-skeleton" aria-hidden="true">'
    +     '<div class="gina-popin-skeleton-line gina-popin-skeleton-title"></div>'
    +     '<div class="gina-popin-skeleton-line"></div>'
    +     '<div class="gina-popin-skeleton-line gina-popin-skeleton-line--short"></div>'
    + '</div>';

function showLoadingShellReplica($popin, $el) {
    if ( !$popin || !$el || !$popin.options || !$popin.options.preOpen ) {
        return;
    }
    if ( $el.hasAttribute('open') || $el.classList.contains('gina-popin-is-active') ) {
        return;
    }
    var shell = ( typeof($popin.options.loadingShell) == 'string' && $popin.options.loadingShell )
        ? $popin.options.loadingShell
        : GINA_DEFAULT_LOADING_SHELL_REPLICA;
    $el.innerHTML = shell;

    if ( $el.tagName === 'DIALOG' ) {
        if ( typeof($el.showModal) === 'function' ) {
            try { $el.showModal(); } catch (e) {}
        } else {
            $el.setAttribute('open', true);
        }
    } else {
        $el.classList.add('gina-popin-is-active');
        var $overlay = $el.parentElement;
        if ( $overlay && !$overlay.classList.contains('gina-popin-is-active') ) {
            $overlay.classList.add('gina-popin-is-active');
        }
    }
}

function makeDoc() {
    return new JSDOM('<!DOCTYPE html><body></body>').window.document;
}
// jsdom has no native dialog.showModal(); attach a spy so the modal branch runs.
function makeDialog(doc, withShowModalSpy) {
    var $el = doc.createElement('dialog');
    $el.className = 'gina-popin-container';
    doc.body.appendChild($el);
    var calls = { showModal: 0 };
    if (withShowModalSpy) {
        $el.showModal = function () { calls.showModal++; $el.setAttribute('open', ''); };
    }
    return { $el: $el, calls: calls };
}
function makeDiv(doc) {
    var $overlay = doc.createElement('div');
    $overlay.className = 'gina-popins-overlay';
    var $el = doc.createElement('div');
    $el.className = 'gina-popin-container';
    $overlay.appendChild($el);
    doc.body.appendChild($overlay);
    return { $el: $el, $overlay: $overlay };
}

describe('16 - Popin: opt-in skeleton pre-open (preOpen + loadingShell)', function () {

    // --- behavioral (jsdom + replica) ---

    it('preOpen:false → no-op (no skeleton, dialog stays closed)', function () {
        var d = makeDialog(makeDoc(), true);
        showLoadingShellReplica({ options: { preOpen: false } }, d.$el);
        assert.equal(d.$el.innerHTML, '', 'no skeleton injected when preOpen is off');
        assert.equal(d.calls.showModal, 0, 'dialog not opened when preOpen is off');
        assert.equal(d.$el.hasAttribute('open'), false);
    });

    it('preOpen:true, no loadingShell → gina default skeleton + showModal (born modal)', function () {
        var d = makeDialog(makeDoc(), true);
        showLoadingShellReplica({ options: { preOpen: true } }, d.$el);
        assert.ok(d.$el.querySelector('.gina-popin-skeleton'), 'gina default skeleton injected');
        assert.ok(d.$el.querySelector('.gina-popin-skeleton-title'), 'skeleton title line injected');
        assert.equal(d.calls.showModal, 1, 'dialog opened as native modal');
        assert.ok(d.$el.hasAttribute('open'), 'open attribute set by showModal');
    });

    it('preOpen:true, custom loadingShell → consumer markup wins (no gina default)', function () {
        var d = makeDialog(makeDoc(), true);
        var custom = '<div class="my-skel"><span>loading…</span></div>';
        showLoadingShellReplica({ options: { preOpen: true, loadingShell: custom } }, d.$el);
        assert.ok(d.$el.querySelector('.my-skel'), 'consumer loadingShell injected');
        assert.equal(d.$el.querySelector('.gina-popin-skeleton'), null, 'gina default NOT used when loadingShell provided');
        assert.equal(d.calls.showModal, 1, 'dialog still opened');
    });

    it('idempotent: second call no-ops (open dialog not re-shown)', function () {
        var d = makeDialog(makeDoc(), true);
        var $popin = { options: { preOpen: true } };
        showLoadingShellReplica($popin, d.$el);   // write site 1
        showLoadingShellReplica($popin, d.$el);   // write site 2 — dialog already open
        assert.equal(d.calls.showModal, 1, 'showModal called once across the two loading-attr write sites');
    });

    it('showModal unavailable → setAttribute(open) fallback', function () {
        var d = makeDialog(makeDoc(), false);   // no spy → typeof($el.showModal) !== 'function'
        showLoadingShellReplica({ options: { preOpen: true } }, d.$el);
        assert.ok(d.$el.querySelector('.gina-popin-skeleton'), 'skeleton injected');
        assert.ok(d.$el.hasAttribute('open'), 'open attribute set via fallback when showModal unavailable');
    });

    it('div mode → activates container + overlay (no native modal)', function () {
        var d = makeDiv(makeDoc());
        showLoadingShellReplica({ options: { preOpen: true } }, d.$el);
        assert.ok(d.$el.querySelector('.gina-popin-skeleton'), 'skeleton injected in div mode');
        assert.ok(d.$el.classList.contains('gina-popin-is-active'), 'container activated');
        assert.ok(d.$overlay.classList.contains('gina-popin-is-active'), 'overlay activated');
    });

    it('div mode idempotent: second call no-ops (already active)', function () {
        var d = makeDiv(makeDoc());
        var $popin = { options: { preOpen: true } };
        showLoadingShellReplica($popin, d.$el);
        var firstHtml = d.$el.innerHTML;
        showLoadingShellReplica($popin, d.$el);
        assert.equal(d.$el.innerHTML, firstHtml, 'skeleton not re-injected once active');
    });

    // --- source pins (lock popin/main.js to the replica above) ---

    it('source: self.options declares preOpen:false default', function () {
        assert.ok(/'preOpen'\s*:\s*false/.test(getPopinSrc()), 'expected preOpen:false default in self.options');
    });

    it('source: self.options declares loadingShell:null default', function () {
        assert.ok(/'loadingShell'\s*:\s*null/.test(getPopinSrc()), 'expected loadingShell:null default in self.options');
    });

    it('source: showLoadingShell($popin, $el) is defined', function () {
        assert.ok(
            /function\s+showLoadingShell\s*\(\s*\$popin\s*,\s*\$el\s*\)/.test(getPopinSrc()),
            'expected showLoadingShell($popin, $el) declaration'
        );
    });

    it('source: GINA_DEFAULT_LOADING_SHELL const uses gina-namespaced skeleton classes', function () {
        var src = getPopinSrc();
        assert.ok(/var\s+GINA_DEFAULT_LOADING_SHELL\s*=/.test(src), 'expected GINA_DEFAULT_LOADING_SHELL const');
        assert.ok(src.indexOf('gina-popin-skeleton') > -1, 'expected gina-namespaced skeleton class');
    });

    it('source: opt-in gate reads $popin.options.preOpen', function () {
        assert.ok(/\$popin\.options\.preOpen/.test(getPopinSrc()), 'expected the preOpen opt-in gate');
    });

    it('source: idempotency guard uses hasAttribute(open) || is-active (not getAttribute)', function () {
        var src = getPopinSrc();
        var fnBlock = src.substring(src.indexOf('function showLoadingShell('), src.indexOf('function showLoadingShell(') + 2000);
        assert.ok(
            /hasAttribute\('open'\)\s*\|\|\s*\$el\.classList\.contains\('gina-popin-is-active'\)/.test(fnBlock),
            'expected idempotent hasAttribute(open) || classList.contains(is-active) guard'
        );
    });

    it('source: consumer loadingShell wins over the gina default', function () {
        var src = getPopinSrc();
        var fnBlock = src.substring(src.indexOf('function showLoadingShell('), src.indexOf('function showLoadingShell(') + 2000);
        assert.ok(
            /typeof\(\$popin\.options\.loadingShell\)\s*==\s*'string'\s*&&\s*\$popin\.options\.loadingShell/.test(fnBlock),
            'expected loadingShell-wins ternary'
        );
        assert.ok(/:\s*GINA_DEFAULT_LOADING_SHELL/.test(fnBlock), 'expected gina default fallback');
    });

    it('source: helper invoked at BOTH loading-attr write sites', function () {
        var matches = getPopinSrc().match(/showLoadingShell\(\$popin,\s*\$el\);/g);
        assert.ok(matches && matches.length >= 2, 'expected >= 2 showLoadingShell($popin, $el) call statements');
    });

    it('source: dialog branch opens born-modal via showModal()', function () {
        var src = getPopinSrc();
        var fnBlock = src.substring(src.indexOf('function showLoadingShell('), src.indexOf('function showLoadingShell(') + 2000);
        assert.ok(/\$el\.tagName\s*===\s*'DIALOG'/.test(fnBlock), 'expected dialog-tag branch');
        assert.ok(/\$el\.showModal\(\)/.test(fnBlock), 'expected showModal() call');
    });

    // --- dist pins (built bundle + concatenated CSS reflect the source) ---

    function getDistPopinBlock() {
        var distSrc = getDistSrc();
        var start = distSrc.indexOf("define('gina/popin'");
        assert.ok(start > -1, 'gina/popin AMD module not found in dist bundle');
        var next = distSrc.indexOf('\ndefine(', start + 20);
        return (next > -1) ? distSrc.substring(start, next) : distSrc.substring(start);
    }

    it('dist: built popin module contains the gina skeleton markup', function () {
        assert.ok(
            getDistPopinBlock().indexOf('gina-popin-skeleton') > -1,
            'built popin module must contain the default skeleton class'
        );
    });

    it('dist/gina.min.css contains the skeleton rules', function () {
        var css = fs.readFileSync(path.join(FW, 'core/asset/plugin/dist/vendor/gina/css/gina.min.css'), 'utf8');
        assert.ok(css.indexOf('gina-popin-skeleton') > -1, 'expected skeleton CSS concatenated into gina.min.css');
    });
});


// ── 17–22 — new `data-gina-dialog-*` entry layer ─────────────────────────────────
//
// Behavioral jsdom tests of the strangler entry layer (resolveTrigger / resolveModal /
// warnDeprecatedOnce / applyContent / preload / a11y), each paired with a
// source-inspection block — the same convention as block 16 (showLoadingShell): a
// test-local replica exercises the logic in jsdom, and the source pins lock the
// production source's shape to the replica so it cannot silently drift.
//
// jsdom ^29 has no native <dialog>.showModal()/show(); the open-path branch selection
// is asserted via the descriptor (resolveModal) rather than the native method, and the
// shim helpers (Escape, focus) are exercised directly.

// Test-local replica factory mirroring resolveTrigger / resolveModal / warnDeprecatedOnce.
function makeEntryLayer(opts) {
    opts = opts || {};
    var selfOptions = { modal: (typeof opts.optionModal != 'undefined') ? opts.optionModal : null };
    var ginaConfig  = opts.config || null; // e.g. { popin: { modal: true } }
    var warnLog     = [];
    var _warned     = {};

    function warnDeprecatedOnce(kind) {
        if (_warned[kind]) { return; }
        _warned[kind] = true;
        warnLog.push(kind);
    }
    function resolveModal($trigger, isLegacy) {
        if (isLegacy || $trigger.getAttribute('data-gina-popin-name') != null) { return true; }
        var attr = $trigger.getAttribute('data-gina-dialog-modal');
        if (attr != null) { return (attr === 'false') ? false : true; }
        if (selfOptions.modal === true || selfOptions.modal === false) { return selfOptions.modal; }
        if (ginaConfig && ginaConfig.popin && (ginaConfig.popin.modal === true || ginaConfig.popin.modal === false)) {
            return ginaConfig.popin.modal;
        }
        return false;
    }
    function resolveTrigger($trigger) {
        var isLegacy = false;
        var id  = $trigger.getAttribute('data-gina-dialog');
        var src = $trigger.getAttribute('data-gina-dialog-src');
        if (id == null && $trigger.getAttribute('data-gina-popin-name') != null) {
            isLegacy = true; id = $trigger.getAttribute('data-gina-popin-name'); warnDeprecatedOnce('data-gina-popin-name');
        }
        if (src == null && $trigger.getAttribute('data-gina-popin-url') != null) {
            isLegacy = true; src = $trigger.getAttribute('data-gina-popin-url'); warnDeprecatedOnce('data-gina-popin-url');
        }
        if (src == null && /^A$/i.test($trigger.tagName)) {
            var href = $trigger.getAttribute('href');
            if (href && href != '' && href != '#' && !/^#/.test(href)) { src = href; }
        }
        return {
              id            : id
            , src           : src
            , isLegacy      : isLegacy
            , modal         : resolveModal($trigger, isLegacy)
            , partialTarget : $trigger.getAttribute('data-gina-dialog-target')
            , isLink        : /^true$/i.test($trigger.getAttribute('data-gina-popin-is-link'))
            , formSubmit    : /^true$/i.test($trigger.getAttribute('data-gina-form-submit'))
        };
    }
    return { resolveTrigger: resolveTrigger, resolveModal: resolveModal, warnLog: warnLog };
}

function mkTrigger(doc, tag, attrs) {
    var $el = doc.createElement(tag || 'button');
    for (var k in attrs) { $el.setAttribute(k, attrs[k]); }
    doc.body.appendChild($el);
    return $el;
}


// ── 17 — Attribute resolution (resolveTrigger) ────────────────────────────────────

describe('17 - Popin: resolveTrigger parses id/src/target', function () {

    it('new data-gina-dialog → id, no src, not legacy', function () {
        var doc = makeDoc();
        var d = makeEntryLayer().resolveTrigger(mkTrigger(doc, 'button', { 'data-gina-dialog': 'foo', 'type': 'button' }));
        assert.equal(d.id, 'foo');
        assert.equal(d.src, null);
        assert.equal(d.isLegacy, false);
    });

    it('data-gina-dialog-src → src; data-gina-dialog-target → partialTarget', function () {
        var doc = makeDoc();
        var d = makeEntryLayer().resolveTrigger(mkTrigger(doc, 'button', {
            'data-gina-dialog': 'foo', 'data-gina-dialog-src': '/load', 'data-gina-dialog-target': '#slot'
        }));
        assert.equal(d.src, '/load');
        assert.equal(d.partialTarget, '#slot');
    });

    it('<a href> doubles as src; "#" anchors ignored', function () {
        var doc = makeDoc();
        var d1 = makeEntryLayer().resolveTrigger(mkTrigger(doc, 'a', { 'data-gina-dialog': 'foo', 'href': '/page' }));
        assert.equal(d1.src, '/page');
        var d2 = makeEntryLayer().resolveTrigger(mkTrigger(doc, 'a', { 'data-gina-dialog': 'foo', 'href': '#' }));
        assert.equal(d2.src, null, '"#" href must not be treated as a src');
    });

    it('source: resolveTrigger($trigger) reads data-gina-dialog / -src / -target', function () {
        var src = getPopinSrc();
        assert.ok(/function\s+resolveTrigger\s*\(\s*\$trigger\s*\)/.test(src), 'expected resolveTrigger($trigger)');
        assert.ok(src.indexOf("getAttribute('data-gina-dialog')") > -1, 'expected data-gina-dialog read');
        assert.ok(src.indexOf("getAttribute('data-gina-dialog-src')") > -1, 'expected data-gina-dialog-src read');
        assert.ok(src.indexOf("getAttribute('data-gina-dialog-target')") > -1, 'expected data-gina-dialog-target read');
    });
});


// ── 18 — Modal precedence (resolveModal) ─────────────────────────────────────────

describe('18 - Popin: resolveModal precedence', function () {

    it('no attr, no config → non-modal (framework default)', function () {
        var doc = makeDoc();
        var el = makeEntryLayer();
        assert.equal(el.resolveModal(mkTrigger(doc, 'button', { 'data-gina-dialog': 'x' }), false), false);
    });

    it('config.popin.modal:true → modal', function () {
        var doc = makeDoc();
        var el = makeEntryLayer({ config: { popin: { modal: true } } });
        assert.equal(el.resolveModal(mkTrigger(doc, 'button', { 'data-gina-dialog': 'x' }), false), true);
    });

    it('data-gina-dialog-modal (bare) and ="true" → modal', function () {
        var doc = makeDoc();
        var el = makeEntryLayer();
        assert.equal(el.resolveModal(mkTrigger(doc, 'button', { 'data-gina-dialog': 'x', 'data-gina-dialog-modal': '' }), false), true);
        assert.equal(el.resolveModal(mkTrigger(doc, 'button', { 'data-gina-dialog': 'y', 'data-gina-dialog-modal': 'true' }), false), true);
    });

    it('data-gina-dialog-modal="false" overrides config.popin.modal:true → non-modal', function () {
        var doc = makeDoc();
        var el = makeEntryLayer({ config: { popin: { modal: true } } });
        assert.equal(el.resolveModal(mkTrigger(doc, 'button', { 'data-gina-dialog': 'x', 'data-gina-dialog-modal': 'false' }), false), false);
    });

    it('per-popin option modal:true (no attr) → modal', function () {
        var doc = makeDoc();
        var el = makeEntryLayer({ optionModal: true });
        assert.equal(el.resolveModal(mkTrigger(doc, 'button', { 'data-gina-dialog': 'x' }), false), true);
    });

    it('legacy data-gina-popin-* → modal regardless of config/option saying false', function () {
        var doc = makeDoc();
        var el = makeEntryLayer({ optionModal: false, config: { popin: { modal: false } } });
        assert.equal(el.resolveModal(mkTrigger(doc, 'button', { 'data-gina-popin-name': 'leg' }), false), true);
        assert.equal(el.resolveModal(mkTrigger(doc, 'button', { 'data-gina-dialog': 'z' }), true), true, 'isLegacy flag also short-circuits');
    });

    it('source: resolveModal honors gina.config.popin.modal and ="false" override', function () {
        var src = getPopinSrc();
        assert.ok(/function\s+resolveModal\s*\(\s*\$trigger/.test(src), 'expected resolveModal($trigger, …)');
        assert.ok(/gina\.config\.popin\.modal/.test(src), 'expected lazy gina.config.popin.modal read');
        assert.ok(src.indexOf("attr === 'false'") > -1, 'expected the data-gina-dialog-modal==="false" → non-modal rule');
    });
});


// ── 19 — Legacy aliasing + warn-once ─────────────────────────────────────────────

describe('19 - Popin: legacy aliasing maps name/url + warns once per kind', function () {

    it('data-gina-popin-name → id, data-gina-popin-url → src, isLegacy true', function () {
        var doc = makeDoc();
        var d = makeEntryLayer().resolveTrigger(mkTrigger(doc, 'a', {
            'data-gina-popin-name': 'legacy', 'data-gina-popin-url': '/old'
        }));
        assert.equal(d.id, 'legacy');
        assert.equal(d.src, '/old');
        assert.equal(d.isLegacy, true);
    });

    it('one warn per kind → at most two distinct warnings across repeated triggers', function () {
        var doc = makeDoc();
        var el = makeEntryLayer();
        el.resolveTrigger(mkTrigger(doc, 'a', { 'data-gina-popin-name': 'a', 'data-gina-popin-url': '/1' }));
        el.resolveTrigger(mkTrigger(doc, 'a', { 'data-gina-popin-name': 'b', 'data-gina-popin-url': '/2' }));
        el.resolveTrigger(mkTrigger(doc, 'a', { 'data-gina-popin-name': 'c', 'data-gina-popin-url': '/3' }));
        assert.deepEqual(el.warnLog.sort(), ['data-gina-popin-name', 'data-gina-popin-url']);
    });

    it('engine-managed is-link / loading emit NO deprecation warning', function () {
        var doc = makeDoc();
        var el = makeEntryLayer();
        el.resolveTrigger(mkTrigger(doc, 'a', {
            'data-gina-popin-is-link': 'true', 'data-gina-popin-loading': 'true', 'href': '/x', 'data-gina-dialog': 'newapi'
        }));
        assert.equal(el.warnLog.length, 0, 'is-link/loading must not be deprecated (gina writes them itself)');
    });

    it('source: warnDeprecatedOnce only ever warns name/url (not is-link/loading)', function () {
        var src = getPopinSrc();
        assert.ok(/function\s+warnDeprecatedOnce\s*\(\s*kind\s*\)/.test(src), 'expected warnDeprecatedOnce(kind)');
        assert.ok(src.indexOf("warnDeprecatedOnce('data-gina-popin-name')") > -1, 'expected name warn call');
        assert.ok(src.indexOf("warnDeprecatedOnce('data-gina-popin-url')") > -1, 'expected url warn call');
        assert.equal(src.indexOf("warnDeprecatedOnce('data-gina-popin-is-link')"), -1, 'is-link must NOT be warned');
        assert.equal(src.indexOf("warnDeprecatedOnce('data-gina-popin-loading')"), -1, 'loading must NOT be warned');
    });
});


// ── 20 — Preload on hover/focus ──────────────────────────────────────────────────

// Replica of installPreload/consumePreload — same cache semantics: a reserved
// in-flight slot is `null`; `consumePreload` treats `null` as not-ready (== null).
function makePreload(netLog) {
    var preloadCache = {};
    function preloadFetch(url) { netLog.push(url); preloadCache[url] = 'BODY:' + url; } // synchronous "completion"
    function onIntentEl($trigger) {
        var url = $trigger.getAttribute('data-gina-dialog-src') || $trigger.getAttribute('data-gina-popin-url');
        if (!url || typeof preloadCache[url] != 'undefined') { return; }
        preloadCache[url] = null;   // reserve (dedup concurrent intents)
        preloadFetch(url);
    }
    function onMouseover(target) {
        var $trigger = target.closest ? target.closest('[data-gina-dialog-src],[data-gina-popin-url]') : null;
        if (!$trigger) { return; }
        onIntentEl($trigger);
    }
    function consumePreload(url) {
        if (preloadCache[url] == null) { return null; }
        var body = preloadCache[url];
        delete preloadCache[url];
        return body;
    }
    return { onMouseover: onMouseover, consumePreload: consumePreload, cache: preloadCache };
}

describe('20 - Popin: preload cache (hover/focus warms, open consumes + dedups)', function () {

    it('mouseover warms the cache; open consumes and deletes it', function () {
        var doc = makeDoc();
        var net = [];
        var pl = makePreload(net);
        var $trigger = mkTrigger(doc, 'button', { 'data-gina-dialog': 'd', 'data-gina-dialog-src': '/aj' });
        pl.onMouseover($trigger);
        assert.equal(net.length, 1, 'one network call on hover');
        assert.equal(pl.consumePreload('/aj'), 'BODY:/aj', 'open consumes the cached body');
        assert.equal(pl.consumePreload('/aj'), null, 'cache entry deleted after consume');
    });

    it('repeated mouseover over descendants → only one network call (URL-cache dedup)', function () {
        var doc = makeDoc();
        var net = [];
        var pl = makePreload(net);
        var $trigger = mkTrigger(doc, 'button', { 'data-gina-dialog': 'd', 'data-gina-dialog-src': '/aj' });
        var $child = doc.createElement('span');
        $trigger.appendChild($child);
        pl.onMouseover($child);
        pl.onMouseover($child);
        pl.onMouseover($trigger);
        assert.equal(net.length, 1, 'descendant re-hovers dedup to a single fetch');
    });

    it('source: preloadCache + installPreload/consumePreload + mouseover/focusin listeners', function () {
        var src = getPopinSrc();
        assert.ok(/var\s+preloadCache\s*=/.test(src), 'expected module-level preloadCache');
        assert.ok(/function\s+installPreload\s*\(/.test(src), 'expected installPreload()');
        assert.ok(/function\s+consumePreload\s*\(/.test(src), 'expected consumePreload()');
        assert.ok(src.indexOf("addEventListener('mouseover'") > -1, 'expected mouseover listener');
        assert.ok(src.indexOf("addEventListener('focusin'") > -1, 'expected focusin listener');
    });
});


// ── 21 — Partial vs full content application (applyContent) ───────────────────────

function applyContentReplica($el, html, partialTarget) {
    if (!partialTarget) { $el.innerHTML = (typeof html == 'string') ? html.trim() : ''; return; }
    var $slot = $el.querySelector(partialTarget);
    if (!$slot) { $el.innerHTML = (typeof html == 'string') ? html.trim() : ''; return; }
    var DOMParserCtor = $el.ownerDocument.defaultView.DOMParser;
    var parsed = new DOMParserCtor().parseFromString(html, 'text/html');
    var $incoming = parsed.querySelector(partialTarget) || parsed.body;
    $slot.innerHTML = $incoming.innerHTML;
}

describe('21 - Popin: applyContent full vs partial', function () {

    it('full (no target) replaces the whole element innerHTML', function () {
        var doc = makeDoc();
        var $el = doc.createElement('dialog'); doc.body.appendChild($el);
        $el.innerHTML = '<p>old</p>';
        applyContentReplica($el, '  <p>new</p>  ', null);
        assert.equal($el.innerHTML, '<p>new</p>', 'full-replace trims and swaps everything');
    });

    it('partial swaps only the target slot; chrome survives', function () {
        var doc = makeDoc();
        var $el = doc.createElement('dialog'); doc.body.appendChild($el);
        $el.innerHTML = '<button class="gina-popin-close">×</button><div id="slot"><p>old</p></div>';
        var fetched = '<html><body><header>ignored</header><div id="slot"><p>fresh</p></div></body></html>';
        applyContentReplica($el, fetched, '#slot');
        assert.ok($el.querySelector('.gina-popin-close'), 'close-button chrome preserved');
        assert.equal($el.querySelector('#slot').innerHTML, '<p>fresh</p>', 'only the slot content swapped');
    });

    it('partial with absent slot falls back to full replace', function () {
        var doc = makeDoc();
        var $el = doc.createElement('dialog'); doc.body.appendChild($el);
        $el.innerHTML = '<p>old</p>';
        applyContentReplica($el, '<p>whole</p>', '#missing');
        assert.equal($el.innerHTML, '<p>whole</p>');
    });

    it('source: applyContent has a partialTarget branch using DOMParser', function () {
        var src = getPopinSrc();
        assert.ok(/function\s+applyContent\s*\(\s*\$el\s*,\s*html\s*,\s*\$popin\s*,\s*partialTarget\s*\)/.test(src),
            'expected applyContent($el, html, $popin, partialTarget)');
        var fn = src.substring(src.indexOf('function applyContent('), src.indexOf('function applyContent(') + 900);
        assert.ok(fn.indexOf('partialTarget') > -1, 'expected partialTarget branch');
        assert.ok(/new\s+DOMParser\s*\(\s*\)/.test(fn), 'expected DOMParser parse in the partial branch');
        assert.ok(fn.indexOf('html.trim()') > -1, 'full path must stay byte-identical to $el.innerHTML = html.trim()');
    });

    it('source: popinLoadContent diversion is gated on !$popin.partialTarget on both open-dialog clauses (regression lock for 7a4003e9)', function () {
        var src = getPopinSrc();
        // An already-open dialog re-load is diverted to popinLoadContent (full $el.innerHTML
        // replace) ONLY when there is no partialTarget — so a data-gina-dialog-target partial
        // re-load instead falls through to applyContent's slot-swap, preserving chrome.
        var clauses = src.match(/\$popin\.isOpen\b[^|{}]*?!\$popin\.partialTarget/g) || [];
        assert.ok(clauses.length >= 2,
            'both open-dialog popinLoadContent guard clauses must carry !$popin.partialTarget (found ' + clauses.length + ')');
        // The FINAL guard clause must directly close the if-condition and gate the
        // popinLoadContent diversion (structural + indentation-tolerant — robust vs a char count).
        var lastGuard = src.slice(src.lastIndexOf('!$popin.partialTarget'));
        assert.ok(/^!\$popin\.partialTarget\s*\)\s*\{[\s\S]{0,160}?popinLoadContent\(/.test(lastGuard),
            'the final !$popin.partialTarget guard clause must directly gate the popinLoadContent call');
    });
});


// ── 22 — Accessibility (aria wiring, focus return, Escape) ────────────────────────

function wireTriggerAriaReplica($trigger, id) {
    if (!$trigger || !id) { return; }
    $trigger.setAttribute('aria-haspopup', 'dialog');
    $trigger.setAttribute('aria-controls', id);
}
function associateLabelReplica($el) {
    if (!$el || typeof $el.querySelector != 'function') { return; }
    var $title = $el.querySelector('[id$="-title"]') || $el.querySelector('h1, h2, h3, h4, h5, h6');
    if (!$title) { return; }
    if (!$title.id) { $title.id = ($el.id || 'gina-popin') + '-title'; $title.setAttribute('id', $title.id); }
    $el.setAttribute('aria-labelledby', $title.id);
}

describe('22 - Popin: a11y wiring (aria, focus return, Escape)', function () {

    it('wireTriggerAria sets aria-haspopup="dialog" + aria-controls', function () {
        var doc = makeDoc();
        var $trigger = mkTrigger(doc, 'button', { 'data-gina-dialog': 'dlg' });
        wireTriggerAriaReplica($trigger, 'dlg');
        assert.equal($trigger.getAttribute('aria-haspopup'), 'dialog');
        assert.equal($trigger.getAttribute('aria-controls'), 'dlg');
    });

    it('associateLabel points aria-labelledby at a REAL title element (assigns id if missing)', function () {
        var doc = makeDoc();
        var $el = doc.createElement('dialog'); $el.id = 'mydlg'; doc.body.appendChild($el);
        $el.innerHTML = '<h2>Heading</h2><p>body</p>';
        associateLabelReplica($el);
        var labelId = $el.getAttribute('aria-labelledby');
        assert.equal(labelId, 'mydlg-title', 'heading gets an id and aria-labelledby points at it');
        assert.equal($el.querySelector('h2').id, 'mydlg-title');
    });

    it('focus returns to the trigger on close', function () {
        var doc = makeDoc();
        var $trigger = mkTrigger(doc, 'button', { 'data-gina-dialog': 'dlg', 'id': 'trg' });
        var $dialog = doc.createElement('dialog'); $dialog.setAttribute('tabindex', '-1'); doc.body.appendChild($dialog);
        $dialog.focus();
        // replica of popinClose's focus-return
        var $popinTrigger = doc.getElementById('trg');
        if ($popinTrigger && typeof $popinTrigger.focus == 'function') { $popinTrigger.focus(); }
        assert.equal(doc.activeElement, $trigger, 'focus returned to the opening trigger');
    });

    it('Escape closes a non-modal (div-mode) dialog via the shim handler', function () {
        var doc = makeDoc();
        var win = doc.defaultView;
        var $el = doc.createElement('dialog'); doc.body.appendChild($el);
        var closed = 0;
        // replica of applyNonModalShims' Escape handler
        var onKeydown = function (e) {
            if (e.key === 'Escape' || e.keyCode === 27) { e.preventDefault(); closed++; }
        };
        $el.addEventListener('keydown', onKeydown);
        $el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(closed, 1, 'Escape keydown closed the non-modal dialog');
    });

    it('source: aria wiring + focus-return helpers exist and popinClose returns focus', function () {
        var src = getPopinSrc();
        assert.ok(/function\s+wireTriggerAria\s*\(/.test(src), 'expected wireTriggerAria()');
        assert.ok(/function\s+associateLabel\s*\(/.test(src), 'expected associateLabel()');
        assert.ok(/function\s+focusInitial\s*\(/.test(src), 'expected focusInitial()');
        assert.ok(src.indexOf("setAttribute('aria-haspopup', 'dialog')") > -1, 'expected aria-haspopup=dialog');
        assert.ok(src.indexOf("setAttribute('aria-controls', id)") > -1, 'expected aria-controls wiring');
        // popinClose returns focus to the opening trigger on close
        var closeFn = src.substring(src.indexOf('function popinClose('), src.indexOf('function popinDestroy('));
        assert.ok(/\$popinTrigger\.focus\(\)/.test(closeFn), 'popinClose must return focus to the trigger');
    });
});


// ── 23 — Served bundle (gina.min.js) reflects the dialog source ────────────────────
//
// The served static asset is gina.min.js, NOT the un-minified gina.js (which is only
// the Closure input and is never served). A source change that is not rebuilt into
// gina.min.js ships nothing that runs. Blocks 01-22 assert on source and on gina.js;
// none read the served minified bundle — so a stale gina.min.js (source updated, dist
// not rebuilt) passes them all while the feature reaches no browser. This block reads
// the REAL served bundle so that gap cannot hide again. The data-gina-dialog* tokens
// are attribute-name string literals, which survive Closure ADVANCED minification
// (unlike renamed identifiers), making them stable freshness markers.

var DIST_MIN_JS = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
var _distMinSrc;
function getDistMinSrc() { return _distMinSrc || (_distMinSrc = fs.readFileSync(DIST_MIN_JS, 'utf8')); }

describe('23 - Served bundle (gina.min.js) reflects the dialog source', function () {

    it('served gina.min.js carries all four data-gina-dialog* attribute names', function () {
        var min = getDistMinSrc();
        ['data-gina-dialog', 'data-gina-dialog-src', 'data-gina-dialog-target', 'data-gina-dialog-modal']
            .forEach(function (attr) {
                assert.ok(
                    min.indexOf(attr) > -1,
                    'served gina.min.js is missing "' + attr + '" — the bundle was not rebuilt from source '
                    + '(a stale min ships the feature nowhere)'
                );
            });
    });

    it('served gina.min.js no longer ships the dead external CORS proxy', function () {
        assert.ok(
            getDistMinSrc().indexOf('corsacme') === -1,
            'served gina.min.js still references the removed corsacme proxy — rebuild the bundle after the source removal'
        );
    });

    it('source feature and served bundle agree (if source declares it, the min must carry it)', function () {
        // Cross-check guarding the exact failure mode where source is updated but the
        // dist is left stale: if the popin source declares the entry attribute, the
        // served minified bundle must contain it too.
        if (getPopinSrc().indexOf('data-gina-dialog') > -1) {
            assert.ok(
                getDistMinSrc().indexOf('data-gina-dialog') > -1,
                'popin source declares data-gina-dialog but the served gina.min.js does not — dist is stale'
            );
        }
    });
});


// ── 24 — PR #35 finish: boot-instantiation + dialog-mode close path ───────────────
//
// Three coupled gaps in the data-gina-dialog feature, all verified live (clean-boot
// click open/close/reopen) and pinned here against regression:
//   (1) Inert at page boot — nothing instantiated the popin handler, so the delegated
//       open listener + container were never installed (clean-boot click did nothing,
//       gina.popin undefined). core.js now boots the handler in the plugin-loading
//       require([...]) callback (new Popin(...).on('ready', …) — the listener triggers
//       the init self-fire that sets gina.popin / gina.hasPopinHandler).
//   (2) Close threw — popinUnbind did instance.target.firstChild.classList.remove(),
//       but a dialog-mode container has no overlay first-child (popinCreateContainer
//       skips it; native ::backdrop is used), so firstChild was null. Now guarded by
//       !useDialogMode, mirroring the open path.
//   (3) Reopen was blank — popinUnbind wiped $el.innerHTML on close, erasing an in-page
//       dialog's authored content. In-page dialogs are now marked isInPageDialog and
//       skip the wipe; AJAX-loaded popins keep the legacy clear.
//
// A node:test source pin cannot exercise the runtime boot wiring (that needs a real
// gina render — verified by hand); these guard the source structure + the served-bundle
// freshness, plus a pure-logic replica of the guarded teardown.

var CORE_SRC = path.join(FW, 'core/asset/plugin/src/vendor/gina/core.js');
var _coreSrc;
function getCoreSrc() { return _coreSrc || (_coreSrc = fs.readFileSync(CORE_SRC, 'utf8')); }

describe('24 - PR #35 finish: boot-instantiation + dialog-mode close path', function () {

    it('source: core.js boots the popin handler in the require([...]) callback (#1)', function () {
        var src = getCoreSrc();
        assert.ok(/require\(\s*\[[\s\S]*?\]\s*,\s*function/.test(src),
            'expected a callback on the plugin-loading require([...])');
        assert.ok(src.indexOf("'gina-dialog-boot'") > -1,
            'expected the reserved boot popin name');
        assert.ok(/new\s+Popin\(\s*\{\s*'name'\s*:\s*'gina-dialog-boot'\s*\}\s*\)\.on\(\s*'ready'/.test(src),
            'expected new Popin({ "name": "gina-dialog-boot" }).on("ready", …) to fire the init self-fire');
        assert.ok(src.indexOf("window['gina']['hasPopinHandler']") > -1,
            'boot must be idempotent — guarded on hasPopinHandler (return-early)');
    });

    it('source: popinUnbind guards the overlay firstChild access in dialog mode (#2)', function () {
        var src = getPopinSrc();
        var unbind = src.substring(src.indexOf('function popinUnbind('), src.indexOf('function popinClose('));
        assert.ok(unbind.length > 0, 'popinUnbind function not found');
        assert.ok(/if\s*\(\s*!self\.options\.useDialogMode\s*\)\s*\{[\s\S]*?instance\.target\.firstChild\.classList\.remove/.test(unbind),
            'popinUnbind must guard instance.target.firstChild (null in dialog mode) behind !useDialogMode');
    });

    it('source: in-page dialogs are marked isInPageDialog and skip the innerHTML wipe (#3)', function () {
        var src = getPopinSrc();
        var openFn = src.substring(src.indexOf('function openInPageDialog('), src.indexOf('function openFromTrigger('));
        assert.ok(openFn.length > 0, 'openInPageDialog function not found');
        assert.ok(/\$dialogPopin\.isInPageDialog\s*=\s*true/.test(openFn),
            'openInPageDialog must mark the static dialog isInPageDialog');
        var unbind = src.substring(src.indexOf('function popinUnbind('), src.indexOf('function popinClose('));
        assert.ok(/if\s*\(\s*!\$popin\.isInPageDialog\s*\)\s*\{[\s\S]*?\$el\.innerHTML/.test(unbind),
            'popinUnbind must skip the $el.innerHTML wipe for in-page dialogs');
    });

    it('served gina.min.js carries the boot instantiation — rebuilt from source (#1 freshness)', function () {
        // 'gina-dialog-boot' is a quoted string literal → survives Closure ADVANCED
        // minification (unlike the renamed isInPageDialog / useDialogMode identifiers),
        // so it is the stable marker proving the boot code shipped into the served bundle.
        assert.ok(getDistMinSrc().indexOf('gina-dialog-boot') > -1,
            'served gina.min.js is missing the boot popin name — the bundle was not rebuilt from source');
        // the un-minified gina.js retains the renamed-in-min source markers
        assert.ok(getDistSrc().indexOf('isInPageDialog') > -1,
            'gina.js must carry the isInPageDialog close-path marker');
    });

    it('logic: dialog-mode close is null-safe and preserves in-page content; legacy clears (#2/#3)', function () {
        // Pure-logic replica of popinUnbind's `!isRouting` teardown.
        function teardown($el, instanceTarget, useDialogMode, isInPageDialog) {
            if ( !useDialogMode ) {
                instanceTarget.firstChild.classList.remove('gina-popin-is-active'); // throws if firstChild null
            }
            $el.classList.remove('gina-popin-is-active');
            if ( !isInPageDialog ) {
                $el.innerHTML = '';
            }
        }
        var mkEl = function (html) {
            var cls = {};
            return {
                innerHTML: html,
                classList: {
                    add: function (c) { cls[c] = 1; },
                    remove: function (c) { delete cls[c]; },
                    contains: function (c) { return !!cls[c]; }
                }
            };
        };

        // dialog mode (default): container has NO overlay child → firstChild is null;
        // an in-page dialog → close must not throw AND must keep its authored content.
        var $dlg = mkEl('<h2>Demo</h2>');
        var dialogContainer = { firstChild: null };
        assert.doesNotThrow(function () { teardown($dlg, dialogContainer, true, true); },
            'dialog-mode close must not deref instance.target.firstChild');
        assert.equal($dlg.innerHTML, '<h2>Demo</h2>', 'in-page dialog content must survive close');

        // non-dialog (legacy) mode: overlay child present, AJAX popin → content cleared.
        var $ajax = mkEl('<p>loaded</p>');
        var overlay = { classList: { remove: function () {}, contains: function () { return false; } } };
        var legacyContainer = { firstChild: overlay };
        assert.doesNotThrow(function () { teardown($ajax, legacyContainer, false, false); });
        assert.equal($ajax.innerHTML, '', 'AJAX popin content is still cleared (legacy behavior preserved)');
    });
});


// ── 25 — PR #35 fix: AJAX (data-gina-dialog-src) path actually opens ──────────────
//
// The contributor's AJAX path shipped non-functional on a clean boot — verified live,
// BOTH sub-paths broken (see the architecture note "No plugin auto-bootstraps at page
// boot"). Three coupled fixes, pinned here against regression:
//   (1) Cold click was a silent no-op — openFromTrigger called popinLoad() (which only
//       FIRES `loaded.<id>` with the body — it does not inject/open itself) but registered
//       NO listener to consume it, so the fetched HTML resolved into the void. It now wires
//       a `loaded.<id>` listener → handleLoadedBody (inject + bind + open), mirroring the
//       legacy bindOpen load site.
//   (2) Preload path threw `getElementsByTagName` of null — consumePreload short-circuits
//       popinLoad (which is what creates the <dialog id=$popin.id>), so popinOpen's
//       `document.getElementById(id)` returned null. A shared ensurePopinDialog() now
//       creates the element on demand for the preload AND cold paths.
//   (3) data-gina-dialog-src-only triggers were inert — the delegated click gate required
//       data-gina-dialog, but `-src` is a documented peer trigger (and installPreload
//       already warmed it). The gate now also owns [data-gina-dialog-src].
//
// As with block 24, a node:test pin cannot drive the real browser wiring (verified live
// against a gina render — every path opens with content, closes clean, zero console
// errors); these guard the source structure + served-bundle freshness, plus pure-logic
// replicas of the ensurePopinDialog create + the loaded→inject→open contract.

describe('25 - PR #35 fix: AJAX (data-gina-dialog-src) path opens', function () {

    it('source: ensurePopinDialog creates/returns the popin element (#2)', function () {
        var src = getPopinSrc();
        assert.ok(/function\s+ensurePopinDialog\s*\(/.test(src),
            'expected an ensurePopinDialog helper');
        var fn = src.substring(src.indexOf('function ensurePopinDialog('), src.indexOf('function consumePreload('));
        assert.ok(fn.length > 0, 'ensurePopinDialog function not found');
        assert.ok(/document\.getElementById\(\s*\$popin\.id\s*\)/.test(fn) && /return\s+\$el/.test(fn),
            'ensurePopinDialog must return the existing element when present (idempotent)');
        assert.ok(/createElement\('dialog'\)/.test(fn) && /createElement\('div'\)/.test(fn),
            'ensurePopinDialog must create a <dialog> (dialog mode) or <div> (non-dialog mode)');
    });

    it('source: consumePreload + handleLoadedBody route through ensurePopinDialog (#2)', function () {
        var src = getPopinSrc();
        var consume = src.substring(src.indexOf('function consumePreload('), src.indexOf('function installPreload('));
        assert.ok(/ensurePopinDialog\(\s*\$popin\s*\)/.test(consume),
            'consumePreload must obtain its element via ensurePopinDialog (popinLoad never ran on this path)');
        var handle = src.substring(src.indexOf('function handleLoadedBody('), src.indexOf('function preloadFetch('));
        assert.ok(/\$el\s*=\s*\$el\s*\|\|\s*ensurePopinDialog\(\s*\$popin\s*\)/.test(handle),
            'handleLoadedBody must ensure the element before injecting/opening');
    });

    it('source: openFromTrigger wires a loaded.<id> listener that opens the AJAX popin (#1)', function () {
        var src = getPopinSrc();
        var fn = src.substring(src.indexOf('function openFromTrigger('), src.indexOf('function bindDelegatedOpen('));
        assert.ok(fn.length > 0, 'openFromTrigger function not found');
        assert.ok(/addListener\(\s*gina\s*,\s*existing\.target\s*,\s*loadedEvt\s*,/.test(fn),
            'openFromTrigger must register a loaded.<id> listener (without it the click-time XHR opens nothing)');
        assert.ok(/handleLoadedBody\(\s*loadedEvent\.detail\s*,\s*existing\s*,/.test(fn),
            'the loaded listener must hand the response body to handleLoadedBody');
        assert.ok(/typeof\(gina\.events\[\s*loadedEvt\s*\]\)\s*==\s*'undefined'/.test(fn),
            'listener registration must be guarded (register once per popin)');
    });

    it('source: the delegated gate also owns standalone data-gina-dialog-src (#3)', function () {
        var src = getPopinSrc();
        var fn = src.substring(src.indexOf('function bindDelegatedOpen('), src.indexOf('var bindOpen'));
        assert.ok(fn.length > 0, 'bindDelegatedOpen function not found');
        assert.ok(fn.indexOf("closest('[data-gina-dialog],[data-gina-dialog-src],[data-gina-popin-name]')") > -1,
            'the gate selector must include [data-gina-dialog-src]');
        assert.ok(/getAttribute\('data-gina-dialog'\)\s*==\s*null[\s\S]*?&&[\s\S]*?getAttribute\('data-gina-dialog-src'\)\s*==\s*null/.test(fn),
            'the defer guard must require BOTH data-gina-dialog AND data-gina-dialog-src absent before deferring to bindOpen');
    });

    it('served gina.min.js carries the widened gate + ensurePopinDialog — rebuilt from source', function () {
        // the widened selector is a quoted string literal → survives Closure minification
        assert.ok(getDistMinSrc().indexOf('[data-gina-dialog],[data-gina-dialog-src],[data-gina-popin-name]') > -1,
            'served gina.min.js is missing the widened delegated-gate selector — rebuild the bundle from source');
        // un-minified gina.js retains the renamed-in-min helper name
        assert.ok(getDistSrc().indexOf('ensurePopinDialog') > -1,
            'gina.js must carry the ensurePopinDialog helper');
    });

    it('logic: ensurePopinDialog creates a <dialog> once and reuses it (#2 replica)', function () {
        // Pure-logic replica of ensurePopinDialog's idempotent create.
        var byId = {};
        var created = [];
        function mkEl(tag) {
            var el = { tagName: tag.toUpperCase(), id: '', attrs: {}, children: [],
                setAttribute: function (k, v) { this.attrs[k] = v; if (k === 'id') { this.id = v; byId[v] = this; } },
                appendChild: function (c) { this.children.push(c); } };
            return el;
        }
        var container = mkEl('div');
        function ensurePopinDialog($popin, useDialogMode) {
            var $el = byId[$popin.id] || null;
            if ($el != null) { return $el; }
            $el = mkEl(useDialogMode ? 'dialog' : 'div');
            $el.setAttribute('id', $popin.id);
            container.appendChild($el);
            created.push($el);
            return $el;
        }
        var $popin = { id: 'gina-popin-x-ajax-1', name: 'ajax-1', options: { class: 'gina-popin-container' } };
        var first = ensurePopinDialog($popin, true);
        assert.equal(first.tagName, 'DIALOG', 'dialog mode must create a <dialog>');
        assert.equal(first.id, 'gina-popin-x-ajax-1');
        var second = ensurePopinDialog($popin, true);
        assert.equal(second, first, 'second call must return the SAME element (idempotent — no duplicate)');
        assert.equal(created.length, 1, 'exactly one element created across two calls');
    });

    it('logic: the loaded listener injects the body then opens (cold-path #1 replica)', function () {
        // Replica of openFromTrigger's loaded listener → handleLoadedBody contract:
        // popinLoad fires loaded.<id> with the body; the listener injects it into the
        // (ensured) element and opens the popin. Pre-fix there was no listener → no open.
        var opened = false, boundCount = 0;
        var $el = { innerHTML: '', getElementsByTagName: function () { return []; } };
        function applyContent(el, body) { el.innerHTML = (typeof body === 'string' ? body.trim() : ''); }
        function handleLoadedBody(body, $popin, el) {
            el = el || $el;
            applyContent(el, body, $popin);
            boundCount++;                       // stands in for popinBind
            if (!$popin.isOpen) { opened = true; } // stands in for popinOpen
        }
        var $popin = { id: 'p1', name: 'p1', isOpen: false };
        var loadedEvent = { detail: '<p class="frag">FRAGMENT</p>', preventDefault: function () {} };
        (function loadedListener(ev) { ev.preventDefault(); handleLoadedBody(ev.detail, $popin, $el); }(loadedEvent));

        assert.ok($el.innerHTML.indexOf('FRAGMENT') > -1, 'the response body must be injected into the popin element');
        assert.equal(boundCount, 1, 'the popin must be bound once');
        assert.equal(opened, true, 'the popin must be opened (pre-fix: no listener → never opened)');
    });
});


// ── 26 — #B54: a click reuses the hover/focus preload (one click = one GET) ───────

describe('26 - Popin: #B54 click consumes the in-flight preload (one click = one GET)', function () {

    it('source: a preloadWaiters registry backs in-flight preload adoption', function () {
        assert.ok(/var\s+preloadWaiters\s*=/.test(getPopinSrc()), 'expected module-level preloadWaiters');
    });

    it('source: preloadFetch wakes parked waiters with the body (or null on failure)', function () {
        var src = getPopinSrc();
        assert.match(src, /_waiters\[[^\]]+\]\(xhrPreload\.responseText\)/, 'success path feeds the body to waiters');
        assert.match(src, /_waiters\[[^\]]+\]\(null\)/, 'failure path signals waiters with null');
    });

    it('source: consumePreload takes an onMiss and parks a waiter for an in-flight (null) slot', function () {
        var src = getPopinSrc();
        assert.match(src, /function\s+consumePreload\s*\(\s*url\s*,\s*\$popin\s*,\s*onMiss\s*,\s*onSettled\s*\)/, 'consumePreload(url, $popin, onMiss, onSettled)');
        assert.match(src, /typeof\(slot\)\s*==\s*'undefined'[\s\S]{0,40}return false/, 'undefined slot returns false (caller loads)');
        assert.ok(src.indexOf('slot === null') > -1, 'in-flight (null) slot is handled distinctly');
        assert.ok(/preloadWaiters\[url\]\.push/.test(src), 'in-flight slot parks a waiter rather than firing a GET');
    });

    it('source: the legacy bindOpen click path consumes the preload before loading', function () {
        var src = getPopinSrc();
        assert.ok(/var\s+doLoad\s*=\s*function/.test(src), 'legacy click wraps its load in doLoad');
        assert.match(src, /consumePreload\(url,\s*\$popin,\s*doLoad,\s*_onAdoptionSettled\)/, 'legacy click consumes the preload, falling back to doLoad, and hands the #B285 settle callback');
    });

    it('source: the new-API openFromTrigger passes an onMiss fallback to consumePreload', function () {
        assert.match(getPopinSrc(), /consumePreload\(descriptor\.src,\s*existing,\s*onMiss,\s*_onAdoptionSettled\)/, 'openFromTrigger passes onMiss, and hands the #B285 settle callback');
    });

    it('source: a preOpen popin still gets its skeleton while the adopted preload is in flight', function () {
        assert.match(getPopinSrc(), /\$popin\.options\.preOpen[\s\S]{0,80}showLoadingShell\(\$popin,\s*ensurePopinDialog\(\$popin\)\)/, 'in-flight preOpen shows the skeleton');
    });
});


// ── 27 — Popin: native <dialog> UA-close routes through popinClose ─────────────────
//
// A native <dialog> opened with showModal() can be closed by the user agent — pressing
// Escape, or submitting a `<form method="dialog">` inside it — which fires the element's
// native `close` event WITHOUT calling popinClose(). popinClose() is the only path that
// resets `isOpen`, runs popinUnbind() (clearing an AJAX popin's innerHTML + removing its
// `loaded.<id>` listener) and restores the toolbar, so a UA close otherwise leaves the
// reused element stale and `isOpen` stuck true. popinOpen() now binds a one-time native
// `close` listener (gated on useDialogMode) that runs popinClose() when the dialog closed
// while still flagged open.
//
// jsdom ^29 has no native <dialog> (no showModal()/Escape, no native `close` event), so —
// same convention as blocks 16-22 — a test-local replica of the bind + handler is exercised
// against a jsdom element (a synthetic `close` event stands in for the UA close), and the
// source-inspection pins at the end lock the production source to the same shape so the
// replica cannot drift.

// Replica of the popinClose cleanup relevant to a UA close — MUST mirror popin/main.js
// popinClose(): early-return when already closed, call $el.close(), clear the AJAX popin's
// innerHTML (popinUnbind, gated on !isInPageDialog), then flip isOpen=false. (The real
// popinClose does more — toolbar restore, focus return, header teardown — out of scope for
// the close-routing contract under test here.)
function popinCloseReplica($popin) {
    if ( !$popin.isOpen ) {
        return;                          // mirrors popinClose's `if (!$popin.isOpen) return`
    }
    if ( $popin.target && typeof($popin.target.close) === 'function' ) {
        $popin.target.close();           // in a real browser this queues the async `close` event
    }
    if ( $popin.target && !$popin.isInPageDialog ) {
        $popin.target.innerHTML = '';    // popinUnbind clears AJAX popin content
    }
    $popin.isOpen = false;               // set AFTER close() but synchronously — before any queued event
    $popin._cleanupCount = ($popin._cleanupCount || 0) + 1;
}

// Replica of the popinOpen close-sync bind — MUST mirror popin/main.js.
function bindCloseSyncReplica($el, $popin, useDialogMode) {
    if ( useDialogMode && $el && !$el._ginaCloseSyncBound ) {
        $el._ginaCloseSyncBound = true;
        $el.addEventListener('close', function () {
            if ( $popin.isOpen ) {
                popinCloseReplica($popin);
            }
        });
    }
}

describe('27 - Popin: native <dialog> UA-close routes through popinClose', function () {

    // --- behavioral (jsdom + replica) ---

    it('UA close (synthetic `close` event) while open → cleanup runs (isOpen false, AJAX content cleared)', function () {
        var doc = makeDoc();
        var d = makeDialog(doc, true);
        d.$el.innerHTML = '<p>fragment A</p>';
        var $popin = { name: 'demo', isOpen: true, target: d.$el, isInPageDialog: false };
        bindCloseSyncReplica(d.$el, $popin, true);

        // UA closes the dialog (Escape / method="dialog") — only the native event fires.
        d.$el.dispatchEvent(new doc.defaultView.Event('close'));

        assert.equal($popin.isOpen, false, 'isOpen reset by the close listener');
        assert.equal(d.$el.innerHTML, '', 'stale AJAX content cleared');
        assert.equal($popin._cleanupCount, 1, 'cleanup ran exactly once');
    });

    it("de-dup: the plugin's own popinClose cleans up once; the queued `close` event then no-ops", function () {
        var doc = makeDoc();
        var d = makeDialog(doc, true);
        d.$el.innerHTML = '<p>fragment A</p>';
        var $popin = { name: 'demo', isOpen: true, target: d.$el, isInPageDialog: false };
        bindCloseSyncReplica(d.$el, $popin, true);

        // Plugin-initiated close: popinClose sets isOpen=false synchronously...
        popinCloseReplica($popin);
        assert.equal($popin._cleanupCount, 1, 'plugin close cleaned up once');
        assert.equal($popin.isOpen, false);

        // ...then the `close` event that popinClose's $el.close() queued fires — guard no-ops.
        d.$el.dispatchEvent(new doc.defaultView.Event('close'));
        assert.equal($popin._cleanupCount, 1, 'queued close event did NOT double-run cleanup');
    });

    it('listener is bound once across element reuse (_ginaCloseSyncBound guard)', function () {
        var doc = makeDoc();
        var d = makeDialog(doc, true);
        var $popin = { name: 'demo', isOpen: true, target: d.$el, isInPageDialog: false };
        bindCloseSyncReplica(d.$el, $popin, true);   // popinOpen #1
        bindCloseSyncReplica(d.$el, $popin, true);   // popinOpen #2 — element reused, must not re-bind

        d.$el.dispatchEvent(new doc.defaultView.Event('close'));
        assert.equal($popin._cleanupCount, 1, 'a single close fires cleanup once (no stacked listeners)');
    });

    it('non-dialog mode → no native close listener bound', function () {
        var doc = makeDoc();
        var d = makeDiv(doc);    // <div>, not <dialog>
        var $popin = { name: 'demo', isOpen: true, target: d.$el };
        bindCloseSyncReplica(d.$el, $popin, false);  // useDialogMode:false
        assert.notEqual(d.$el._ginaCloseSyncBound, true, 'no close-sync flag in non-dialog mode');
        d.$el.dispatchEvent(new doc.defaultView.Event('close'));
        assert.equal($popin._cleanupCount, undefined, 'no cleanup (a <div> has no native close)');
    });

    it('in-page dialog content is preserved on UA close (isInPageDialog guard)', function () {
        var doc = makeDoc();
        var d = makeDialog(doc, true);
        d.$el.innerHTML = '<p>authored content</p>';
        var $popin = { name: 'demo', isOpen: true, target: d.$el, isInPageDialog: true };
        bindCloseSyncReplica(d.$el, $popin, true);
        d.$el.dispatchEvent(new doc.defaultView.Event('close'));
        assert.equal($popin.isOpen, false, 'isOpen still reset for an in-page dialog');
        assert.equal(d.$el.innerHTML, '<p>authored content</p>', 'authored content preserved (not an AJAX popin)');
    });

    // --- source-inspection pins (lock the production source to the replica above) ---

    it('source: popinOpen binds a one-time native `close` listener gated on useDialogMode', function () {
        assert.match(
            getPopinSrc(),
            /self\.options\.useDialogMode\s*&&\s*\$el\s*&&\s*!\$el\._ginaCloseSyncBound/,
            'expected the useDialogMode + once-guard gate in popinOpen'
        );
        assert.match(getPopinSrc(), /\$el\._ginaCloseSyncBound\s*=\s*true;/, 'expected the once-bind flag set');
        assert.match(getPopinSrc(), /\$el\.addEventListener\(\s*['"]close['"]/, 'expected a native `close` listener (DOM addEventListener)');
    });

    it('source: the close listener runs popinClose only while still flagged open', function () {
        assert.match(
            getPopinSrc(),
            /addEventListener\(\s*['"]close['"][\s\S]{0,220}?if\s*\(\s*\$popin\.isOpen\s*\)[\s\S]{0,80}?popinClose\(\s*\$popin\.name\s*\)/,
            'close handler must guard on $popin.isOpen then call popinClose($popin.name)'
        );
    });

    it('source: the close-sync bind precedes `$popin.isOpen = true` in popinOpen', function () {
        var src = getPopinSrc();
        var bindIdx = src.indexOf('!$el._ginaCloseSyncBound');
        var openIdx = src.indexOf('$popin.isOpen = true');
        assert.ok(bindIdx > -1, 'gate present');
        assert.ok(openIdx > -1, '$popin.isOpen = true present');
        assert.ok(bindIdx < openIdx, 'the close listener is bound before isOpen is set true');
    });

    // --- dist freshness (the served bundle must carry the fix) ---

    it('served gina.min.js carries the _ginaCloseSyncBound close-sync listener', function () {
        assert.ok(
            getDistMinSrc().indexOf('_ginaCloseSyncBound') > -1,
            'served gina.min.js is missing _ginaCloseSyncBound — rebuild the bundle from source'
        );
    });
});


// ── 28 — Popin: #B77 _self redirect-tunnel loads-then-returns (blind-open timer removed) ─
//
// A proxied/tunnelled redirect JSON response (isXhrRedirect + location, default _self)
// used to: $popin.load(location) then setTimeout(50, () => { if (!$popin.isOpen) $popin.open() }).
// That blind 50 ms timer was a vestigial v0.1.0 (2021, 4d85d084) race-inducer: when a
// follow-up load took longer than 50 ms, the timer fired open() against a not-yet-injected
// (skeleton/empty) target — an intermittent unhandled-deref crash. It is unnecessary because
// the already-armed `loaded.<id>` listener opens CONTENT-FIRST (it injects the body via
// popinBind/handleLoadedBody, THEN calls popinOpen). The _self branch now just loads and
// returns. The `return;` also preserves the pre-existing window.open() fall-through guard —
// non-_self targets (blank/parent/top) still reach window.open, _self never does.
//
// NOTE: this fix is scoped to the popin plugin's OWN _self redirect. The structurally
// similar blind timer that lived in the sibling validator path
// (`Validator::Popin now redirecting`, core/plugins/lib/validator/src/main.js) had a
// DIFFERENT safety profile — it could $popin.load() a DIFFERENT popin whose loaded.<id>
// listener was never armed, so a bare delete would have broken that flow. It was
// resolved separately (#B79): the validator now captures popinLoad's returned handle
// and arms its content-first `loaded.<id>` listener when the popin is not open. The
// served gina.min.js carries no blind popin-open timer anymore.
// Coverage: test/core/validator-popin-redirect.test.js.

describe('28 - Popin: #B77 _self redirect-tunnel loads-then-returns (blind-open timer removed)', function () {

    // --- behavioral (pure-logic replicas) ---

    it('logic: the armed loaded listener injects the redirect body then opens (content-first)', function () {
        // Replica of the loaded.<id> listener contract the _self redirect relies on:
        // $popin.load() fires loaded.<id> with the body; the (already-armed) listener injects
        // it into the popin element and THEN opens — so content is present at open time, which
        // is exactly why the blind 50 ms open timer is unnecessary.
        var openedWithContent = null;
        var $el = { innerHTML: '' };
        function applyContent(el, body) { el.innerHTML = (typeof body === 'string' ? body.trim() : ''); }
        function popinOpen($popin) { openedWithContent = $popin.target.innerHTML; $popin.isOpen = true; }
        var $popin = { name: 'p1', id: 'p1', isOpen: false, target: $el };

        function loadedListener(ev) {
            applyContent($popin.target, ev.detail);      // popinBind / handleLoadedBody inject
            if (!$popin.isOpen) { popinOpen($popin); }    // ...then popinOpen
        }
        loadedListener({ detail: '<p class="fetched">REDIRECT BODY</p>' });

        assert.equal($popin.isOpen, true, 'the popin opened via the armed loaded listener');
        assert.ok(openedWithContent.indexOf('fetched') > -1,
            'content was already injected when the popin opened (content-first — no blind timer needed)');
    });

    it('subtract: the removed blind 50 ms timer opened before a slow load injected (the race)', function () {
        // Model the two events the removed timer raced: the blind open (fixed 50 ms) vs the
        // loaded-listener injection (arrives when the follow-up load completes — here > 50 ms).
        var log = [];
        var $el = { innerHTML: '' };
        var $popin = { isOpen: false, target: $el };
        function blindOpenTimer() {                         // the removed setTimeout(...,50) body
            if (!$popin.isOpen) {
                $popin.isOpen = true;
                log.push('open@50:content=' + JSON.stringify($popin.target.innerHTML));
            }
        }
        function slowLoadInject(body) { $popin.target.innerHTML = body; log.push('inject@120'); }

        blindOpenTimer();                                   // t=50ms — timer fires first
        slowLoadInject('<p class="fetched">BODY</p>');      // t=120ms — content arrives after

        assert.equal(log[0], 'open@50:content=""',
            'the blind timer opened against an EMPTY target (the not-yet-injected skeleton — the crash source)');
        assert.equal(log[1], 'inject@120', 'content was injected only AFTER the popin had already opened');
        assert.equal($popin.isOpen, true);
    });

    // --- source-inspection pins (lock the production source to the removal) ---

    it('source: the _self redirect branch loads then returns — no setTimeout/onPopinredirect blind open', function () {
        var src = getPopinSrc();
        var selfIdx = src.indexOf('/^_self$/.test(_target)');
        var winIdx  = src.indexOf('window.open(result.location', selfIdx);
        assert.ok(selfIdx > -1, 'the _self redirect branch is present');
        assert.ok(winIdx > selfIdx, 'the window.open fall-through follows the _self branch');
        var branch = src.substring(selfIdx, winIdx);
        assert.ok(branch.indexOf('.load( $popin.name, popinUrl, $popin.options )') > -1,
            'the _self branch must still issue the popin load');
        assert.ok(/\.load\([^;]*\);[\s\S]*?return;/.test(branch),
            'the _self branch must return immediately after the load');
        assert.equal(branch.indexOf('setTimeout'), -1,
            'the _self branch must NOT arm a blind-open setTimeout (removed #B77)');
        assert.equal(branch.indexOf('onPopinredirect'), -1,
            'the blind-open timer callback must be gone');
    });

    it('source: the _self branch return; sits before window.open (non-_self targets only reach it)', function () {
        var src = getPopinSrc();
        var selfIdx = src.indexOf('/^_self$/.test(_target)');
        var winIdx  = src.indexOf('window.open(result.location', selfIdx);
        var loadIdx = src.indexOf('.load( $popin.name, popinUrl, $popin.options )', selfIdx);
        var retIdx  = src.indexOf('return;', loadIdx);
        assert.ok(selfIdx > -1 && winIdx > -1 && loadIdx > -1, 'branch + load + window.open all present');
        assert.ok(retIdx > loadIdx && retIdx < winIdx,
            'the _self branch return; is between the load and window.open — so a _self redirect never window.opens');
    });

    // --- dist freshness (the served bundle must carry the removal) ---

    it('served gina.js (gina/popin module): the _self branch loads-then-returns, timer gone', function () {
        var dist = getDistSrc();
        var modIdx = dist.indexOf("define('gina/popin'");
        assert.ok(modIdx > -1, 'gina/popin AMD module present in gina.js');
        var selfIdx = dist.indexOf('/^_self$/.test(_target)', modIdx);
        var winIdx  = dist.indexOf('window.open(result.location', selfIdx);
        assert.ok(selfIdx > modIdx && winIdx > selfIdx, 'the popin _self branch is present in the built module');
        var branch = dist.substring(selfIdx, winIdx);
        assert.ok(branch.indexOf('.load( $popin.name, popinUrl, $popin.options )') > -1, 'load present in built module');
        assert.equal(branch.indexOf('setTimeout'), -1,
            'no blind-open timer in the built gina/popin _self branch — rebuild the bundle if this fails');
        assert.equal(branch.indexOf('onPopinredirect'), -1, 'timer callback gone from the built module');
    });

    it('served gina.min.js: the popin _self branch carries no blind-open timer', function () {
        var min = getDistMinSrc();
        var selfIdx = min.indexOf('/^_self$/.test');
        assert.ok(selfIdx > -1, 'the popin _self branch is present in the minified bundle');
        var winIdx = min.indexOf('window.open(', selfIdx);
        assert.ok(winIdx > selfIdx, 'window.open follows the _self branch');
        var branch = min.substring(selfIdx, winIdx);   // scoped to the popin _self branch only
        assert.ok(/\.load\(/.test(branch), 'the _self branch still issues the popin load in the served bundle');
        assert.equal(branch.indexOf('setTimeout'), -1,
            'the popin _self branch must carry no setTimeout blind-open in the served bundle (rebuild if this fails)');
    });
});


// ── 29 — #B91: per-trigger preload opt-out (data-gina-dialog-preload="false") ──────

// Replica of the #B91 gate + cache semantics (the gate lives in warmTrigger, the
// shared per-trigger gate both warm paths route through): an opted-out trigger never
// warms, its cache slot stays undefined, so the click-time consume finds nothing
// and the caller's click-time load runs (the ordering is source-pinned below).
function makeGatedPreload(netLog) {
    var preloadCache = {};
    function preloadFetch(url) { netLog.push(url); preloadCache[url] = 'BODY:' + url; }
    function onMouseover(target) {
        var $trigger = target.closest ? target.closest('[data-gina-dialog-src],[data-gina-popin-url]') : null;
        if (!$trigger) { return; }
        // #B91 gate — same parse as popin/main.js warmTrigger (case-insensitive).
        if (/^false$/i.test($trigger.getAttribute('data-gina-dialog-preload'))) { return; }
        var url = $trigger.getAttribute('data-gina-dialog-src') || $trigger.getAttribute('data-gina-popin-url');
        if (!url || typeof preloadCache[url] != 'undefined') { return; }
        preloadCache[url] = null;
        preloadFetch(url);
    }
    function consumePreload(url) {
        if (typeof preloadCache[url] == 'undefined') { return false; } // -> caller runs its click-time load
        var body = preloadCache[url];
        delete preloadCache[url];
        return body;
    }
    return { onMouseover: onMouseover, consumePreload: consumePreload, cache: preloadCache };
}

describe('29 - Popin: #B91 preload opt-out (data-gina-dialog-preload="false")', function () {

    // --- behavioral (replica) ---

    it('an opted-out trigger never warms: no GET on hover, no cache slot', function () {
        var doc = makeDoc();
        var net = [];
        var pl = makeGatedPreload(net);
        var $t = mkTrigger(doc, 'button', {
            'data-gina-dialog': 'd', 'data-gina-dialog-src': '/aj', 'data-gina-dialog-preload': 'false'
        });
        pl.onMouseover($t);
        assert.equal(net.length, 0, 'no network call on hover');
        assert.equal(typeof pl.cache['/aj'], 'undefined', 'no cache slot reserved');
    });

    it('the parse is case-insensitive — a templated "False"/"FALSE" still opts out (fail-safe)', function () {
        ['False', 'FALSE', 'fAlSe'].forEach(function (v) {
            var doc = makeDoc();
            var net = [];
            var pl = makeGatedPreload(net);
            var $t = mkTrigger(doc, 'button', {
                'data-gina-dialog': 'd', 'data-gina-dialog-src': '/aj', 'data-gina-dialog-preload': v
            });
            pl.onMouseover($t);
            assert.equal(net.length, 0, 'no GET for value "' + v + '"');
        });
    });

    it('absent / "true" / empty / other values leave the default preload ON', function () {
        [null, 'true', '', 'yes'].forEach(function (v) {
            var doc = makeDoc();
            var net = [];
            var pl = makeGatedPreload(net);
            var attrs = { 'data-gina-dialog': 'd', 'data-gina-dialog-src': '/aj' };
            if (v !== null) { attrs['data-gina-dialog-preload'] = v; }
            var $t = mkTrigger(doc, 'button', attrs);
            pl.onMouseover($t);
            assert.equal(net.length, 1, 'preload fires for value ' + JSON.stringify(v));
        });
    });

    it('an opted-out trigger click-consume returns false — the caller runs its click-time load', function () {
        var doc = makeDoc();
        var net = [];
        var pl = makeGatedPreload(net);
        var $t = mkTrigger(doc, 'button', {
            'data-gina-dialog': 'd', 'data-gina-dialog-src': '/aj', 'data-gina-dialog-preload': 'false'
        });
        pl.onMouseover($t);
        assert.equal(pl.consumePreload('/aj'), false, 'undefined slot -> false (caller click-time load path)');
    });

    it('legacy data-gina-popin-url triggers honor the same attribute', function () {
        var doc = makeDoc();
        var net = [];
        var pl = makeGatedPreload(net);
        var $t = mkTrigger(doc, 'button', {
            'data-gina-popin-name': 'p', 'data-gina-popin-url': '/lg', 'data-gina-dialog-preload': 'false'
        });
        pl.onMouseover($t);
        assert.equal(net.length, 0, 'legacy trigger opted out — no hover GET');
    });

    // --- source pins (structural anchors) ---

    it('source: the gate sits inside warmTrigger — after the disabled skip, before the fetch — and onIntent routes through it', function () {
        var src = getPopinSrc();
        // the hover/focus path funnels into the shared gate
        var fnIdx = src.indexOf('function installPreload');
        assert.ok(fnIdx > -1, 'installPreload present');
        var endIdx = src.indexOf("addEventListener('mouseover'", fnIdx);
        assert.ok(endIdx > fnIdx, 'end anchor (mouseover registration) present');
        var onIntentBlk = src.substring(fnIdx, endIdx);   // end-anchored slice: the onIntent body
        assert.ok(/warmTrigger\(\s*\$trigger\s*\)/.test(onIntentBlk),
            'onIntent must route the matched trigger through warmTrigger (shared gate)');
        // the gate block itself, now in warmTrigger (shared with the eager pass)
        var wtIdx = src.indexOf('function warmTrigger(');
        assert.ok(wtIdx > -1, 'warmTrigger present');
        var wtEnd = src.indexOf('function installEagerPreload(', wtIdx);
        assert.ok(wtEnd > wtIdx, 'end anchor (installEagerPreload) present');
        var blk = src.substring(wtIdx, wtEnd);   // warmTrigger body (+ trailing JSDoc)
        var gateIdx = blk.indexOf("/^false$/i.test($trigger.getAttribute('data-gina-dialog-preload'))");
        assert.ok(gateIdx > -1, 'expected the case-insensitive opt-out gate in warmTrigger');
        var ariaIdx = blk.indexOf("aria-disabled') == 'true'");
        var fetchIdx = blk.indexOf('preloadFetch(url');
        assert.ok(ariaIdx > -1 && fetchIdx > -1, 'ordering anchors present');
        assert.ok(gateIdx > ariaIdx, 'gate sits after the disabled/aria-disabled skip');
        assert.ok(gateIdx < fetchIdx, 'gate sits before the preload GET');
    });

    // --- dist fidelity (these two are RED on a stale dist — rebuild if they fail) ---

    it('dist gina.js carries the opt-out gate (code token, not just the comment)', function () {
        var dist = getDistSrc();
        assert.ok(
            dist.indexOf("/^false$/i.test($trigger.getAttribute('data-gina-dialog-preload'))") > -1,
            'dist gina.js must carry the #B91 gate — rebuild the plugin bundle'
        );
    });

    it('served gina.min.js carries the opt-out gate (minify-surviving tokens)', function () {
        var min = getDistMinSrc();
        assert.ok(min.indexOf('data-gina-dialog-preload') > -1,
            'attribute literal must survive minification — rebuild the plugin bundle');
        assert.ok(
            /\/\^false\$\/i\.test\([$\w.]+\.getAttribute\((?:"|')data-gina-dialog-preload(?:"|')\)\)/.test(min),
            'the case-insensitive gate must survive minification (regex literal + getAttribute + attr string)'
        );
    });
});


// ── 30 — Popin: eager preload (data-gina-dialog-preload="eager" idle warm-all) ─────

// Replica of warmTrigger + the installEagerPreload pass: the shared gate (disabled
// skip → #B91 "false" opt-out → URL resolve → already-cached/in-flight dedup →
// reserve+fetch) with an onDone that fires on EVERY exit path, and the serialized
// queue that starts the next warm only on the previous one's completion. The fetch
// stub completes ASYNCHRONOUSLY (flushed by the test) so serialization is observable.
function makeEagerPreload(netLog) {
    var preloadCache = {};
    var pending = [];   // parked fetch completions, flushed manually by the test
    function preloadFetch(url, onDone) {
        netLog.push(url);
        pending.push(function () {
            preloadCache[url] = 'BODY:' + url;
            if (typeof onDone == 'function') { onDone(); }
        });
    }
    function warmTrigger($trigger, onDone) {
        var done = function () { if (typeof onDone == 'function') { onDone(); } };
        if ($trigger.getAttribute('disabled') != null && $trigger.getAttribute('disabled') != 'false'
            || $trigger.getAttribute('aria-disabled') == 'true') { done(); return; }
        if (/^false$/i.test($trigger.getAttribute('data-gina-dialog-preload'))) { done(); return; }
        var url = $trigger.getAttribute('data-gina-dialog-src') || $trigger.getAttribute('data-gina-popin-url');
        if (!url || typeof preloadCache[url] != 'undefined') { done(); return; }
        preloadCache[url] = null;   // reserve in-flight slot
        preloadFetch(url, onDone);
    }
    function eagerPass($candidates) {
        var queue = [];
        for (var c = 0; c < $candidates.length; ++c) {
            if (/^eager$/i.test($candidates[c].getAttribute('data-gina-dialog-preload'))) {
                queue.push($candidates[c]);
            }
        }
        var next = function () {
            var $t = queue.shift();
            if (!$t) { return; }
            warmTrigger($t, next);
        };
        next();
    }
    return {
        cache: preloadCache, warmTrigger: warmTrigger, eagerPass: eagerPass,
        flushOne: function () { var f = pending.shift(); if (f) { f(); } },
        pendingCount: function () { return pending.length; }
    };
}

describe('30 - Popin: eager preload (data-gina-dialog-preload="eager")', function () {

    // --- behavioral (replica) ---

    it('an eager trigger warms with zero interaction; default and "false" stay cold', function () {
        var doc = makeDoc();
        var net = [];
        var pl = makeEagerPreload(net);
        var $eager = mkTrigger(doc, 'button', { 'data-gina-dialog': 'a', 'data-gina-dialog-src': '/e1', 'data-gina-dialog-preload': 'eager' });
        var $deflt = mkTrigger(doc, 'button', { 'data-gina-dialog': 'b', 'data-gina-dialog-src': '/d1' });
        var $noped = mkTrigger(doc, 'button', { 'data-gina-dialog': 'c', 'data-gina-dialog-src': '/n1', 'data-gina-dialog-preload': 'false' });
        pl.eagerPass([$eager, $deflt, $noped]);
        assert.deepEqual(net, ['/e1'], 'only the eager trigger fires a GET in the pass');
        assert.equal(pl.cache['/e1'], null, 'eager slot reserved in-flight');
        assert.equal(typeof pl.cache['/d1'], 'undefined', 'default trigger untouched by the pass (hover-warm covers it)');
        assert.equal(typeof pl.cache['/n1'], 'undefined', 'opted-out trigger never warms');
    });

    it('the parse is case-insensitive — "Eager"/"EAGER" warm too (templated values)', function () {
        ['Eager', 'EAGER', 'eAgEr'].forEach(function (v) {
            var doc = makeDoc();
            var net = [];
            var pl = makeEagerPreload(net);
            var $t = mkTrigger(doc, 'button', { 'data-gina-dialog': 'a', 'data-gina-dialog-src': '/e', 'data-gina-dialog-preload': v });
            pl.eagerPass([$t]);
            assert.equal(net.length, 1, 'eager warm fires for value "' + v + '"');
        });
    });

    it('serialized: the second warm starts only after the first completes', function () {
        var doc = makeDoc();
        var net = [];
        var pl = makeEagerPreload(net);
        var $t1 = mkTrigger(doc, 'button', { 'data-gina-dialog': 'a', 'data-gina-dialog-src': '/e1', 'data-gina-dialog-preload': 'eager' });
        var $t2 = mkTrigger(doc, 'button', { 'data-gina-dialog': 'b', 'data-gina-dialog-src': '/e2', 'data-gina-dialog-preload': 'eager' });
        pl.eagerPass([$t1, $t2]);
        assert.deepEqual(net, ['/e1'], 'only the FIRST GET is in flight after the pass starts');
        assert.equal(pl.pendingCount(), 1, 'one pending completion');
        pl.flushOne();
        assert.deepEqual(net, ['/e1', '/e2'], 'second GET starts only after the first completed');
        pl.flushOne();
        assert.equal(pl.cache['/e2'], 'BODY:/e2', 'queue drained to completion');
    });

    it('onDone fires on every exit path — gate-skipped triggers never stall the queue', function () {
        var doc = makeDoc();
        var net = [];
        var pl = makeEagerPreload(net);
        var $skip1 = mkTrigger(doc, 'button', { 'data-gina-dialog': 'a', 'data-gina-dialog-src': '/s1', 'data-gina-dialog-preload': 'eager', 'disabled': 'disabled' });
        var $skip2 = mkTrigger(doc, 'button', { 'data-gina-dialog': 'b', 'data-gina-dialog-src': '/s2', 'data-gina-dialog-preload': 'eager' });
        pl.cache['/s2'] = 'BODY:/s2';   // already warmed -> dedup skip
        var $good  = mkTrigger(doc, 'button', { 'data-gina-dialog': 'c', 'data-gina-dialog-src': '/e3', 'data-gina-dialog-preload': 'eager' });
        pl.eagerPass([$skip1, $skip2, $good]);
        assert.deepEqual(net, ['/e3'], 'both skips advanced the queue to the good trigger');
        pl.flushOne();
        assert.equal(pl.cache['/e3'], 'BODY:/e3', 'good trigger warmed to completion');
    });

    it('hover-warm and eager-warm coalesce — whichever runs second is a no-op (one GET total)', function () {
        // hover first, eager second
        var doc = makeDoc();
        var net = [];
        var pl = makeEagerPreload(net);
        var $t = mkTrigger(doc, 'button', { 'data-gina-dialog': 'a', 'data-gina-dialog-src': '/e1', 'data-gina-dialog-preload': 'eager' });
        pl.warmTrigger($t);           // hover path
        pl.flushOne();
        pl.eagerPass([$t]);           // eager pass afterwards
        assert.equal(net.length, 1, 'eager pass deduped against the hover warm');
        // eager first (still in flight), hover second
        var net2 = [];
        var pl2 = makeEagerPreload(net2);
        pl2.eagerPass([$t]);
        pl2.warmTrigger($t);          // hover during the in-flight eager warm
        assert.equal(net2.length, 1, 'hover deduped against the in-flight eager warm');
    });

    // --- source pins (structural anchors) ---

    it('source: both warm paths route through the shared warmTrigger gate', function () {
        var src = getPopinSrc();
        assert.ok(/function\s+warmTrigger\s*\(\s*\$trigger\s*,\s*onDone\s*\)/.test(src),
            'expected warmTrigger($trigger, onDone)');
        var ip = src.substring(src.indexOf('function installPreload'), src.indexOf('function warmTrigger('));
        assert.ok(/warmTrigger\(\s*\$trigger\s*\)/.test(ip), 'hover path (onIntent) calls warmTrigger');
        var ie = src.substring(src.indexOf('function installEagerPreload('), src.indexOf('function openInPageDialog('));
        assert.ok(ie.length > 0, 'installEagerPreload slice found');
        assert.ok(/warmTrigger\(\s*\$trigger\s*,\s*next\s*\)/.test(ie),
            'eager pass chains warmTrigger($trigger, next) — serialized queue');
    });

    it('source: installEagerPreload — eager filter, off-critical-path scheduling, Save-Data skip, install-once', function () {
        var src = getPopinSrc();
        var ie = src.substring(src.indexOf('function installEagerPreload('), src.indexOf('function openInPageDialog('));
        assert.ok(ie.indexOf("/^eager$/i.test($candidates[c].getAttribute('data-gina-dialog-preload'))") > -1,
            'case-insensitive eager filter');
        assert.ok(ie.indexOf("querySelectorAll('[data-gina-dialog-src],[data-gina-popin-url]')") > -1,
            'candidate scan uses the same trigger selector as the intent path');
        assert.ok(/requestIdleCallback/.test(ie) && /setTimeout\(\s*run\s*,/.test(ie),
            'requestIdleCallback with a setTimeout fallback');
        assert.ok(/addEventListener\(\s*'load'\s*,\s*schedule\s*,\s*\{\s*once:\s*true\s*\}\s*\)/.test(ie),
            'waits for window load before scheduling');
        assert.ok(/readyState\s*==\s*'complete'/.test(ie), 'already-loaded fast path');
        assert.ok(/navigator\.connection\s*&&\s*navigator\.connection\.saveData/.test(ie),
            'Save-Data preference suppresses the speculative warm');
        assert.ok(/_ginaEagerInstalled/.test(ie), 'install-once module guard');
        assert.ok(/var\s+_ginaEagerInstalled\s*=\s*false/.test(src), 'guard declared at module level');
    });

    it('source: init wires the eager pass after the intent listeners', function () {
        var src = getPopinSrc();
        var ipCall = src.indexOf('installPreload();');
        var ieCall = src.indexOf('installEagerPreload();');
        assert.ok(ipCall > -1 && ieCall > -1, 'both init calls present');
        assert.ok(ieCall > ipCall, 'installEagerPreload() runs after installPreload()');
    });

    it('source: preloadFetch takes onDone and fires it on every exit path', function () {
        var src = getPopinSrc();
        assert.ok(/function\s+preloadFetch\s*\(\s*url\s*,\s*onDone\s*\)/.test(src),
            'preloadFetch(url, onDone)');
        var pf = src.substring(src.indexOf('function preloadFetch('), src.indexOf('function ensurePopinDialog('));
        var calls = pf.split('_preloadDone();').length - 1;
        assert.ok(calls >= 2, 'completion fires on the cross-origin bail AND the readyState-4 tail (found ' + calls + ')');
    });

    // --- dist fidelity (RED on a stale dist — rebuild if they fail) ---

    it('dist gina.js carries warmTrigger + the eager pass', function () {
        var dist = getDistSrc();
        assert.ok(dist.indexOf('function warmTrigger(') > -1, 'dist must carry warmTrigger — rebuild the plugin bundle');
        assert.ok(dist.indexOf('function installEagerPreload(') > -1, 'dist must carry installEagerPreload — rebuild the plugin bundle');
        assert.ok(dist.indexOf('/^eager$/i.test(') > -1, 'dist must carry the eager filter — rebuild the plugin bundle');
    });

    it('served gina.min.js carries the eager pass (minify-surviving tokens)', function () {
        var min = getDistMinSrc();
        assert.ok(/\/\^eager\$\/i\.test\(/.test(min),
            'the case-insensitive eager filter must survive minification');
        assert.ok(min.indexOf('requestIdleCallback') > -1,
            'the idle scheduling must survive minification (window property access)');
        assert.ok(min.indexOf('.saveData') > -1,
            'the Save-Data guard must survive minification (property access)');
    });
});

describe('31 - #B139: the content preload cache dies with the open it warmed', function () {

    // Pre-fix, the cache was a ONE-GENERATION-LAGGING store (measured in a real
    // browser, 5 opens with the server version-bumped between them: every open
    // after the first fetched the CURRENT body but rendered the PREVIOUS open's):
    // open N consumes the entry warmed around open N-1, and the around-open-N
    // re-warm (mouseover/focusin near the click or close) parks the CURRENT
    // generation in the cache — where the pre-open-N+1 hover then dedups against
    // it instead of warming fresh. No invalidation path existed: close/unbind/
    // destroy never touched preloadCache. The fix clears the popin's content-URL
    // slot at the same unbind moment the AJAX body is wiped from the DOM.

    // Minimal faithful replica of the cache protocol (warm reserve/complete,
    // ready-consume with delete, close-clear) — the waiter indirection is
    // modeled only where the assertion needs it (31.2).
    function makeCacheModel() {
        var m = { cache: {}, waiters: {} };
        m.complete = function (url, body) {                // preloadFetch readyState-4 tail:
            m.cache[url] = body;                           // completion writes…
            var w = m.waiters[url] || [];
            delete m.waiters[url];
            for (var i = 0; i < w.length; i++) { w[i](body); }   // …then fires waiters
        };
        m.warm = function (url, body) {                    // warmTrigger: dedup + reserve + fetch
            if ( typeof(m.cache[url]) != 'undefined' ) { return 'dedup'; }
            m.cache[url] = null;
            m.complete(url, body);
            return 'fetched';
        };
        m.consume = function (url, $popin) {               // ready branch only
            var slot = m.cache[url];
            if ( typeof(slot) == 'undefined' ) { return false; }
            delete m.cache[url];
            $popin._contentUrl = url;
            $popin.rendered = slot;
            return true;
        };
        m.clearSlot = function (url) {                     // clearPreloadSlot core
            var slot = m.cache[url];
            if ( typeof(slot) == 'undefined' ) { return; }
            if ( slot === null ) {
                (m.waiters[url] = m.waiters[url] || []).push(function () { delete m.cache[url]; });
                return;
            }
            delete m.cache[url];
        };
        m.clear = function ($popin) {                      // clearContentPreload
            var url = $popin._contentUrl;
            if ( !url ) { return; }
            $popin._contentUrl = null;
            m.clearSlot(url);
        };
        return m;
    }

    it('31.1 - replica + SUBTRACT: without the close-clear every open renders the previous generation; with it every open is fresh', function () {
        // WITHOUT the clear (pre-fix): warm(v1) -> open1 consumes v1 -> around-open
        // re-warm parks v2 -> close (no clear) -> pre-open-2 hover DEDUPS -> open2
        // consumes v2 while the server is at v3 == the one-generation lag.
        var pre = makeCacheModel();
        var $p = {};
        pre.warm('/frag', 'v1');
        pre.consume('/frag', $p);                              // open 1
        assert.equal($p.rendered, 'v1', 'open 1 is fresh on both shapes');
        pre.warm('/frag', 'v2');                               // around-open re-warm
        /* close: pre-fix clears nothing */
        assert.equal(pre.warm('/frag', 'v3'), 'dedup',
            'SUBTRACT: the pre-open-2 hover dedups against the leftover — the fresh warm never happens');
        pre.consume('/frag', $p);                              // open 2
        assert.equal($p.rendered, 'v2', 'SUBTRACT: open 2 renders the previous generation (the measured lag)');

        // WITH the clear (#B139): the close deletes the leftover, so the next
        // hover warms the CURRENT generation and the open renders it.
        var fixed = makeCacheModel();
        var $q = {};
        fixed.warm('/frag', 'v1');
        fixed.consume('/frag', $q);                            // open 1
        fixed.warm('/frag', 'v2');                             // around-open re-warm
        fixed.clear($q);                                       // close -> clearContentPreload
        assert.equal(fixed.warm('/frag', 'v3'), 'fetched',
            'the pre-open-2 hover warms FRESH — the leftover is gone');
        fixed.consume('/frag', $q);                            // open 2
        assert.equal($q.rendered, 'v3', 'open 2 renders the current generation');
    });

    it('31.2 - replica: an in-flight slot at close gets a discard waiter (completion writes, waiter deletes)', function () {
        var m = makeCacheModel();
        var $p = { _contentUrl: '/frag' };
        m.cache['/frag'] = null;                               // in-flight at close time
        m.clear($p);
        assert.equal(m.cache['/frag'], null, 'the in-flight reservation itself is left for the completion');
        // completion arrives: writes the body, fires the parked discard waiter
        m.complete('/frag', 'late-body');
        assert.equal(typeof m.cache['/frag'], 'undefined',
            'the discard waiter deletes the just-written entry — nothing outlives the close');
    });

    it('31.3 - source: clearContentPreload exists, popinUnbind clears AND re-sweeps past the teardown', function () {
        var src = getPopinSrc();
        assert.ok(/function\s+clearContentPreload\s*\(/.test(src), 'clearContentPreload must exist');
        var unbind = src.substring(src.indexOf('function popinUnbind('), src.indexOf('function popinClose('));
        assert.ok(/if\s*\(\s*!\$popin\.isInPageDialog\s*\)\s*\{[\s\S]*?\$el\.innerHTML[\s\S]*?clearContentPreload\(\s*\$popin\s*\)/.test(unbind),
            'popinUnbind must clear the content-URL cache slot in the same AJAX-only branch that wipes the body');
        // the URL is captured BEFORE the clear nulls it, and re-swept after the
        // teardown task (the close-time focus-return + pointer re-hover re-warm
        // the slot with close-era content within ~1ms — measured)
        assert.ok(/var\s+_closedContentUrl\s*=\s*\$popin\._contentUrl[\s\S]*?clearContentPreload\(\s*\$popin\s*\)/.test(unbind),
            'the sweep URL must be captured before clearContentPreload nulls the stamp');
        assert.ok(/setTimeout\(\s*function\s*\(\s*\)\s*\{\s*clearPreloadSlot\(\s*_closedContentUrl\s*\)/.test(unbind),
            'popinUnbind must schedule the deferred sweep of the same slot');
        // the clear core: delete on ready, discard-waiter on in-flight
        var clear = src.substring(src.indexOf('function clearContentPreload('), src.indexOf('function installPreload('));
        assert.ok(/delete\s+preloadCache\[\s*url\s*\]/.test(clear), 'ready slots are deleted');
        assert.ok(/preloadWaiters\[\s*url\s*\]\.push\(\s*function\s*\(\s*\)\s*\{\s*delete preloadCache\[\s*url\s*\]/.test(clear),
            'in-flight slots get a discard waiter');
    });

    it('31.7 - replica: the deferred sweep kills the close-time synthetic re-warm (the measured defeat of clear-only)', function () {
        // Measured in a real browser: Esc close -> the a11y focus-return fires a
        // TRUSTED focusin -> warmTrigger GETs close-era content within 1ms, AFTER
        // the immediate clear ran — so clear-only left the next open serving
        // close-era content again. The deferred sweep runs past the teardown and
        // deletes whatever the synthetics parked; the next real open then misses
        // and fetches CURRENT.
        var m = makeCacheModel();
        var $p = {};
        m.warm('/frag', 'open-era');
        m.consume('/frag', $p);                                // open
        m.clear($p);                                           // close: immediate clear
        m.warm('/frag', 'close-era');                          // synthetic focus-return re-warm (post-clear)
        // SUBTRACT: without the sweep the next open serves the close-era body
        var $q1 = {};
        var probe = makeCacheModel();
        probe.cache = JSON.parse(JSON.stringify(m.cache));
        probe.consume('/frag', $q1);
        assert.equal($q1.rendered, 'close-era',
            'SUBTRACT: clear-only is defeated — the synthetic re-warm serves close-era content at reopen');
        // WITH the sweep: the slot dies, the reopen misses and fetches current
        m.clearSlot('/frag');                                  // the deferred sweep
        var $q2 = {};
        assert.equal(m.consume('/frag', $q2), false, 'the reopen must MISS after the sweep');
        assert.equal(m.warm('/frag', 'current'), 'fetched', 'the reopen-time fetch gets CURRENT content');
        m.consume('/frag', $q2);
        assert.equal($q2.rendered, 'current');
    });

    it('31.4 - source: the content URL is stamped at every inject/load entry point', function () {
        var src = getPopinSrc();
        var consume = src.substring(src.indexOf('function consumePreload('), src.indexOf('function clearContentPreload('));
        var stamps = consume.match(/\$popin\._contentUrl\s*=\s*url/g) || [];
        assert.equal(stamps.length, 2, 'consumePreload must stamp _contentUrl on BOTH branches (ready + adopted in-flight)');
        var load = src.substring(src.indexOf('function popinLoad('), src.indexOf('function popinOpen('));
        assert.ok(/\$popin\._contentUrl\s*=\s*url/.test(load), 'popinLoad must stamp _contentUrl (click-time loads incl. redirects)');
    });

    it('31.5 - source: preload="false" triggers skip the consume on BOTH open paths (always-refetch)', function () {
        var src = getPopinSrc();
        var openFn = src.substring(src.indexOf('function openFromTrigger('), src.indexOf('function bindDelegatedOpen('));
        assert.ok(/_noPreload\s*=\s*\/\^false\$\/i\.test\(\s*\$trigger\.getAttribute\('data-gina-dialog-preload'\)\s*\)/.test(openFn)
            && /!_noPreload\s*&&\s*consumePreload\(/.test(openFn),
            'openFromTrigger must gate the consume on the false opt-out');
        var legacy = src.substring(src.indexOf('var bindOpen'), src.indexOf('function popinLoad('));
        assert.ok(/_noPreload\s*=\s*\/\^false\$\/i\.test\(\s*this\.getAttribute\('data-gina-dialog-preload'\)\s*\)/.test(legacy)
            && /!_noPreload\s*&&\s*consumePreload\(/.test(legacy),
            'the legacy click path must gate the consume identically');
    });

    it('31.6 - dist fidelity: the close-clear reached the bundles (rebuild guard)', function () {
        assert.ok(getDistSrc().indexOf('function clearContentPreload(') > -1,
            'gina.js must carry clearContentPreload — the plugin bundle was not rebuilt from source');
        assert.ok(getDistMinSrc().indexOf('_contentUrl') > -1,
            'gina.min.js must carry the _contentUrl stamp (property names survive SIMPLE minification)');
    });
});


// ── 32 — #B225: preload-consumed opens set the dev toolbar overlay ─────────────────

// A cold click routes through the popin XHR loaded handler, which calls
// updateToolbar(result) under GINA_ENV_IS_DEV before dispatching the body — so a
// cold open surfaces the popin's rendered data (its XHR overlay era) in the dev
// tools. A preload-consumed open (#B54) bypassed that handler entirely:
// consumePreload dispatched the cached body straight to handleLoadedBody, so a
// warmed open never set the overlay and the popin's queries/data stayed invisible
// to the Inspector (#B225 — measured on BOTH consume branches: ready + adopted
// in-flight). The fix mirrors the cold path's dev gate on both branches,
// immediately before each handleLoadedBody dispatch. The placement is
// consumePreload-only by design: the cold path also routes through
// handleLoadedBody, so gating inside the dispatcher would double-fire the
// overlay on cold opens (single-set measured).

describe('32 - #B225: preload-consumed opens set the dev toolbar overlay', function () {

    /** Started-flag brace walker (same shape as inspector.test.js §84/§85 —
     *  no braces inside string literals in the popin functions walked here). */
    function extractFn32(src, decl) {
        var i = src.indexOf(decl);
        if (i < 0) throw new Error('decl not found: ' + decl);
        if (src.indexOf(decl, i + 1) > -1) throw new Error('decl not unique: ' + decl);
        var depth = 0, started = false, j = i;
        for (; j < src.length; j++) {
            var c = src[j];
            if (c === '{') { depth++; started = true; }
            else if (c === '}') {
                depth--;
                if (started && depth === 0) { j++; break; }
            }
        }
        if (!started || depth !== 0) throw new Error('unbalanced braces for: ' + decl);
        return src.slice(i, j);
    }

    /** Active lines only — negative pins must not trip on prose naming a symbol. */
    function stripComments32(block) {
        return block.split('\n').filter(function (l) {
            return !/^\s*(\/\/|\*|\/\*)/.test(l);
        }).join('\n');
    }

    /** Executes the SHIPPED consumePreload bytes (no replica) with a recording
     *  scope; log entries are ['toolbar'|'loaded', body] in call order. */
    function driveConsume(src, opts) {
        var fnText = extractFn32(src, 'function consumePreload(');
        var log = [];
        var runner = new Function(
            'preloadCache', 'preloadWaiters', 'showLoadingShell',
            'ensurePopinDialog', 'handleLoadedBody', 'GINA_ENV_IS_DEV', 'updateToolbar',
            'return (' + fnText + ');'
        );
        var fn = runner(
            opts.cache, opts.waiters || {},
            function () { log.push(['shell']); },
            function () { return { el: true }; },
            function (body) { log.push(['loaded', body]); },
            opts.dev,
            function (body) { log.push(['toolbar', body]); }
        );
        return { fn: fn, log: log };
    }

    // --- behavioral (extracted real bytes) ---

    it('ready-branch consume sets the toolbar overlay from the body BEFORE dispatching (dev on)', function () {
        var d = driveConsume(getPopinSrc(), { cache: { '/u': 'BODY' }, dev: true });
        assert.equal(d.fn('/u', { options: {} }), true, 'ready slot must be consumed');
        assert.deepEqual(d.log, [['toolbar', 'BODY'], ['loaded', 'BODY']],
            'the dev overlay must be set from the consumed body, before handleLoadedBody (the cold-path parity #B225 adds)');
    });

    it('adopted in-flight consume: the waiter sets the overlay when the body arrives', function () {
        var waiters = {};
        var d = driveConsume(getPopinSrc(), { cache: { '/u': null }, waiters: waiters, dev: true });
        assert.equal(d.fn('/u', { options: {} }, function () { d.log.push(['miss']); }), true,
            'in-flight slot must be adopted');
        assert.equal((waiters['/u'] || []).length, 1, 'a waiter must be parked on the in-flight slot');
        waiters['/u'][0]('BODY');
        assert.deepEqual(d.log, [['toolbar', 'BODY'], ['loaded', 'BODY']],
            'the adopted body must set the dev overlay before its dispatch, exactly like the ready branch');
    });

    it('the set is dev-only: GINA_ENV_IS_DEV false leaves both branches overlay-free', function () {
        var waiters = {};
        var d = driveConsume(getPopinSrc(), { cache: { '/r': 'B1', '/a': null }, waiters: waiters, dev: false });
        d.fn('/r', { options: {} });
        d.fn('/a', { options: {} });
        waiters['/a'][0]('B2');
        assert.deepEqual(d.log, [['loaded', 'B1'], ['loaded', 'B2']],
            'production consumes must dispatch without ever touching the toolbar');
    });

    it('a failed adopted preload runs onMiss and never touches the toolbar (no-regression arm)', function () {
        var waiters = {};
        var d = driveConsume(getPopinSrc(), { cache: { '/u': null }, waiters: waiters, dev: true });
        d.fn('/u', { options: {} }, function () { d.log.push(['miss']); });
        waiters['/u'][0](null);
        assert.deepEqual(d.log, [['miss']],
            'a null body routes to the caller click-time load only — no overlay, no dispatch');
    });

    it('a never-warmed slot still returns false (consume protocol untouched)', function () {
        var d = driveConsume(getPopinSrc(), { cache: {}, dev: true });
        assert.equal(d.fn('/x', { options: {} }), false, 'undefined slot -> caller loads itself');
        assert.deepEqual(d.log, [], 'nothing may fire on a miss');
    });

    // --- source pins (contiguous spans — an insertion into either seam breaks them) ---

    it('source: the ready branch gates updateToolbar(body) on GINA_ENV_IS_DEV immediately before its dispatch', function () {
        assert.match(getPopinSrc(),
            /var \$el = ensurePopinDialog\(\$popin\);\n\s*if \(GINA_ENV_IS_DEV\) \{ updateToolbar\(body\); \}\n\s*handleLoadedBody\(body, \$popin, \$el\);/,
            'expected the dev-gated overlay set between ensurePopinDialog and the ready-branch dispatch');
    });

    it('source: the adopted-in-flight waiter carries the same dev-gated set', function () {
        assert.match(getPopinSrc(),
            /\$popin\._contentUrl = url;\n\s*if \(GINA_ENV_IS_DEV\) \{ updateToolbar\(body\); \}\n\s*handleLoadedBody\(body, \$popin, ensurePopinDialog\(\$popin\)\);/,
            'expected the dev-gated overlay set between the waiter\'s _contentUrl stamp and its dispatch');
    });

    it('source: exactly two dev-gated sets live in consumePreload — and handleLoadedBody has none (single-set rule)', function () {
        var blk = extractFn32(getPopinSrc(), 'function consumePreload(');
        var gates = blk.match(/if \(GINA_ENV_IS_DEV\) \{ updateToolbar\(body\); \}/g) || [];
        assert.equal(gates.length, 2, 'one dev-gated set per consume branch, no more');
        var hl = extractFn32(getPopinSrc(), 'function handleLoadedBody(');
        assert.ok(stripComments32(hl).indexOf('updateToolbar') < 0,
            'handleLoadedBody must NOT set the overlay — the cold path already sets it in the XHR loaded handler; a set in the shared dispatcher would double-fire');
    });

    // --- dist fidelity (RED on a stale dist — rebuild if these fail) ---

    it('dist gina.js carries both dev-gated sets (rebuild guard)', function () {
        var dist = getDistSrc();
        assert.match(dist,
            /var \$el = ensurePopinDialog\(\$popin\);\n\s*if \(GINA_ENV_IS_DEV\) \{ updateToolbar\(body\); \}\n\s*handleLoadedBody\(body, \$popin, \$el\);/,
            'gina.js must carry the ready-branch set — rebuild the plugin bundle');
        assert.match(dist,
            /\$popin\._contentUrl = url;\n\s*if \(GINA_ENV_IS_DEV\) \{ updateToolbar\(body\); \}\n\s*handleLoadedBody\(body, \$popin, ensurePopinDialog\(\$popin\)\);/,
            'gina.js must carry the adopted-branch set — rebuild the plugin bundle');
    });

    it('served gina.min.js carries both dev-gated sets (minify-surviving shapes, wrap-agnostic)', function () {
        // GINA_ENV_IS_DEV is an implicit global, so SIMPLE minification keeps the
        // name; locals are renamed, so both shapes anchor on it plus the
        // _contentUrl property. Validated both directions against the real
        // artifacts: each pattern 0 on the pre-fix bundle, 1 on the rebuilt one
        // (Closure folds the adopted waiter into a comma expression — the
        // [,;] separators and \s* boundaries keep the pins wrap-agnostic).
        var min = getDistMinSrc();
        var ready = min.match(/_contentUrl\s*=\s*[$\w]+\s*[,;]\s*(?:var\s+)?[$\w]+\s*=\s*[$\w]+\(\s*[$\w]+\s*\)\s*[,;]\s*GINA_ENV_IS_DEV\s*&&\s*[$\w]+\(\s*[$\w]+\s*\)/g) || [];
        assert.equal(ready.length, 1,
            'the ready-branch dev-gated set must survive minification — rebuild the plugin bundle');
        var adopted = min.match(/_contentUrl\s*=\s*[$\w]+\s*[,;]\s*GINA_ENV_IS_DEV\s*&&\s*[$\w]+\(\s*[$\w]+\s*\)\s*[,;]\s*[$\w]+\(\s*[$\w]+\s*,\s*[$\w]+\s*,\s*[$\w]+\(\s*[$\w]+\s*\)\s*\)/g) || [];
        assert.equal(adopted.length, 1,
            'the adopted-branch dev-gated set must survive minification — rebuild the plugin bundle');
        assert.ok((min.match(/GINA_ENV_IS_DEV/g) || []).length >= 9,
            'the dev-gate count must include the two consume sites (7 pre-fix, 9 post)');
    });
});

describe('33 - #B285: consumePreload reports settling (onSettled contract)', function () {

    /** Started-flag brace walker (same shape as §32's — no braces inside string
     *  literals in consumePreload). */
    function extractFn33(src, decl) {
        var i = src.indexOf(decl);
        if (i < 0) throw new Error('decl not found: ' + decl);
        if (src.indexOf(decl, i + 1) > -1) throw new Error('decl not unique: ' + decl);
        var depth = 0, started = false, j = i;
        for (; j < src.length; j++) {
            var c = src[j];
            if (c === '{') { depth++; started = true; }
            else if (c === '}') {
                depth--;
                if (started && depth === 0) { j++; break; }
            }
        }
        if (!started || depth !== 0) throw new Error('unbalanced braces for: ' + decl);
        return src.slice(i, j);
    }

    /** Executes the SHIPPED consumePreload bytes (no replica) with a recording
     *  scope — the same seven injections as §32's driveConsume. The #B285 settle
     *  callback is passed at CALL time (4th argument), so this runner needs no
     *  extra injected symbol and §32's ≤3-arg calls keep running the same bytes. */
    function driveConsume33(src, opts) {
        var fnText = extractFn33(src, 'function consumePreload(');
        var log = [];
        var runner = new Function(
            'preloadCache', 'preloadWaiters', 'showLoadingShell',
            'ensurePopinDialog', 'handleLoadedBody', 'GINA_ENV_IS_DEV', 'updateToolbar',
            'return (' + fnText + ');'
        );
        var fn = runner(
            opts.cache, opts.waiters || {},
            function () { log.push(['shell']); },
            function () { return { el: true }; },
            function (body) { log.push(['loaded', body]); },
            opts.dev,
            function (body) { log.push(['toolbar', body]); }
        );
        return { fn: fn, log: log };
    }

    it('ready-branch consume settles SYNCHRONOUSLY, after its dispatch', function () {
        var d = driveConsume33(getPopinSrc(), { cache: { '/u': 'BODY' }, dev: false });
        var settled = [];
        var consumed = d.fn('/u', { options: {} }, null, function () { settled.push(d.log.length); });
        assert.equal(consumed, true, 'ready slot must be consumed');
        assert.deepEqual(d.log, [['loaded', 'BODY']], 'the cached body must dispatch');
        assert.deepEqual(settled, [1],
            'onSettled must fire exactly once, synchronously, AFTER handleLoadedBody — the caller must be able to tell "no wait ever began" before consumePreload returns');
    });

    it('adopting an in-flight preload does NOT settle at park time — the wait has only begun', function () {
        var waiters = {};
        var d = driveConsume33(getPopinSrc(), { cache: { '/u': null }, waiters: waiters, dev: false });
        var settled = [];
        var consumed = d.fn('/u', { options: {} }, function () { d.log.push(['miss']); }, function () { settled.push(d.log.length); });
        assert.equal(consumed, true, 'in-flight slot must be adopted');
        assert.equal((waiters['/u'] || []).length, 1, 'a waiter must be parked');
        assert.deepEqual(settled, [], 'parking must NOT settle — this gap is exactly what the caller arms for');
    });

    it('the adopted waiter settles FIRST, before the body dispatch (release-before-apply, like the cold readyState-4 site)', function () {
        var waiters = {};
        var d = driveConsume33(getPopinSrc(), { cache: { '/u': null }, waiters: waiters, dev: false });
        var settled = [];
        d.fn('/u', { options: {} }, function () { d.log.push(['miss']); }, function () { settled.push(d.log.length); });
        waiters['/u'][0]('BODY');
        assert.deepEqual(settled, [0], 'settle must precede the dispatch (log empty at settle time)');
        assert.deepEqual(d.log, [['loaded', 'BODY']], 'the adopted body must still dispatch');
    });

    it('a FAILED adoption settles too, before onMiss runs — the release cannot leak on the miss leg', function () {
        var waiters = {};
        var d = driveConsume33(getPopinSrc(), { cache: { '/u': null }, waiters: waiters, dev: false });
        var settled = [];
        d.fn('/u', { options: {} }, function () { d.log.push(['miss']); }, function () { settled.push(d.log.length); });
        waiters['/u'][0](null);
        assert.deepEqual(settled, [0], 'the null (failure) leg must settle before the fallback');
        assert.deepEqual(d.log, [['miss']], 'the caller click-time load must still run');
    });

    it('the 4th argument is optional — a 3-arg call keeps every prior shape (harness-compat control)', function () {
        var d = driveConsume33(getPopinSrc(), { cache: { '/u': 'BODY' }, dev: false });
        assert.equal(d.fn('/u', { options: {} }), true);
        assert.deepEqual(d.log, [['loaded', 'BODY']],
            'no settle callback, identical behavior — this is what keeps the older ≤3-arg harness calls green untouched');
    });
});

describe('34 - #B315: the popin `success` event actually fires (no free `$forms` in popinLoad)', function () {

    /** Started-flag brace walker (same shape as §32/§33's). popinLoad carries no
     *  brace inside a string literal — asserted by the balance check itself, which
     *  throws rather than returning a truncated body. */
    function extractFn34(src, name) {
        // Anchored at a line-start declaration on purpose: this file closes its
        // long functions with an `} // EO function popinBind(e, $popin) {` marker,
        // so a bare indexOf finds TWO "declarations" and a uniqueness guard that
        // scans raw source rejects a perfectly unique function.
        var re = new RegExp('^[ \\t]*function ' + name + '\\(', 'mg');
        var hits = [], m;
        while ((m = re.exec(src)) !== null) hits.push(m.index);
        if (!hits.length) throw new Error('decl not found: ' + name);
        if (hits.length > 1) throw new Error('decl not unique: ' + name);
        var i = hits[0];
        var depth = 0, started = false, j = i;
        for (; j < src.length; j++) {
            var c = src[j];
            if (c === '{') { depth++; started = true; }
            else if (c === '}') {
                depth--;
                if (started && depth === 0) { j++; break; }
            }
        }
        if (!started || depth !== 0) throw new Error('unbalanced braces for: ' + name);
        return src.slice(i, j);
    }

    /** Comment-stripped view: these pins are about CODE, and the fix deliberately
     *  documents the old broken identifier in a comment right above the fixed line.
     *  Asserting on raw source would match my own explanation and read green for
     *  the wrong reason (the negative-on-raw-source trap recorded for #B288). */
    function activeSource(text) {
        return text.split('\n').filter(function (l) {
            var t = l.trim();
            return t.indexOf('//') !== 0 && t.indexOf('*') !== 0 && t.indexOf('/*') !== 0;
        }).join('\n');
    }

    it('popinLoad contains NO `$forms` identifier — it is declared only in the sibling popinBind', function () {
        var body = activeSource(extractFn34(getPopinSrc(), 'popinLoad'));
        assert.equal(/\$forms/.test(body), false,
            'popinLoad must not reference `$forms`: the only declaration is `var $forms` inside popinBind, a SIBLING function, so any read here is a free variable that throws ReferenceError into popinLoad\'s own catch');
    });

    it('`var $forms` is declared exactly once in the module, and it sits inside popinBind', function () {
        // Position arithmetic rather than a brace walk: popinBind does not balance
        // under the naive walker (it carries a brace inside a literal), and the walk
        // is not needed — popinBind's span is delimited by its own `// EO` marker.
        var src = getPopinSrc();
        var decls = src.match(/var\s+\$forms\b/g) || [];
        assert.equal(decls.length, 1, 'exactly one `var $forms` declaration must exist');

        var declAt = src.search(/var\s+\$forms\b/);
        var bindAt = src.search(/^[ \t]*function popinBind\(/m);
        var bindEnd = src.indexOf('// EO function popinBind');
        assert.ok(bindAt > -1 && bindEnd > bindAt, 'popinBind span must be locatable');
        assert.ok(declAt > bindAt && declAt < bindEnd,
            'the sole `var $forms` must sit INSIDE popinBind — that is what makes the popinLoad reference a free variable rather than a shadowed local');

        var loadAt = src.search(/^[ \t]*function popinLoad\(/m);
        assert.ok(loadAt > bindEnd,
            'popinLoad must start after popinBind ends — sibling functions, so no closure can supply $forms');
    });

    it('the `success.` trigger dispatches on `$el`, matching its two sibling triggers in the same handler', function () {
        var body = activeSource(extractFn34(getPopinSrc(), 'popinLoad'));
        assert.ok(/triggerEvent\(\s*gina\s*,\s*\$el\s*,\s*'success\.'\s*\+\s*id\s*,\s*result\s*\)/.test(body),
            '`success` must dispatch on $el');
        // The siblings are the reason $el is the right target, not a guess.
        assert.ok(/triggerEvent\(\s*gina\s*,\s*\$el\s*,\s*'loaded\.'\s*\+\s*id/.test(body), 'loaded. dispatches on $el');
        assert.ok(/triggerEvent\(\s*gina\s*,\s*\$el\s*,\s*'error\.'\s*\+\s*id/.test(body), 'error. dispatches on $el');
    });

    it('DIST FIDELITY: the fix reached the built bundle', function () {
        var dist = fs.readFileSync(DIST_JS, 'utf8');
        assert.ok(dist.indexOf("'success.' + id") > -1 || dist.indexOf('"success." + id') > -1,
            'the success dispatch must be present in the built bundle');
        assert.equal(/triggerEvent\(gina,\s*\$forms\[0\],\s*'success\./.test(dist), false,
            'the pre-fix `$forms[0]` dispatch must NOT survive in dist — a stale dist here means the rebuild was skipped');
    });
});

describe('35 - #B300: the always-false id-backfill guards stay deleted', function () {

    /** Comment-stripped view (same helper shape as §34's). Load-bearing here, not
     *  hygiene: each #B300 deletion leaves a comment quoting the removed condition
     *  VERBATIM so a future reader does not restore it — so a pin asserting on RAW
     *  source matches my own explanation, can never reach 0, and is a control that
     *  cannot fail. That exact reading cost two invalid measurement passes when the
     *  fix was made. */
    function activeSource35(text) {
        return text.split('\n').filter(function (l) {
            var t = l.trim();
            return t.indexOf('//') !== 0 && t.indexOf('*') !== 0 && t.indexOf('/*') !== 0;
        }).join('\n');
    }

    /** Region between a unique start landmark and the first end landmark AFTER it.
     *  Neither site is a `function name(...)` declaration — both are function
     *  EXPRESSIONS assigned to a var — so §34's declaration walker does not apply,
     *  and `var register = function (...)` is not even unique as a raw string: the
     *  file repeats it in its own `} // EO var register = ...` closing marker. */
    function region35(src, startRe, endNeedle, label) {
        var m = src.match(startRe);
        if (!m) throw new Error('start landmark not found: ' + label);
        var from = src.indexOf(m[0]);
        var to = src.indexOf(endNeedle, from + m[0].length);
        if (to < 0) throw new Error('end landmark not found: ' + label);
        return activeSource35(src.slice(from, to));
    }

    it('bindOpen\'s document click proxy does not stamp an id on the clicked element', function () {
        var region = region35(
            getPopinSrc(),
            /evt = 'click';\/\/ click proxy/,
            'gina.popinIsBinded = false',
            'document click proxy'
        );

        // CONTROL first — proves the region is the right one and non-empty. Without
        // it, a mis-anchored (empty) region would pass both negatives vacuously.
        assert.ok(/\/\^popin\\\.close\\\.\/\.test\(event\.target\.id\)/.test(region),
            'control: the click proxy must still test the popin.close. prefix — if this fails the region is mis-anchored and the negatives below prove nothing');

        assert.equal(/typeof\(event\.target\.id\) == 'undefined'/.test(region), false,
            'the always-false id guard must stay deleted: an element\'s `id` IDL attribute always exists (defaults to ""), so the body never ran');
        assert.equal(/event\.target\.setAttribute\('id', evt/.test(region), false,
            'the id-stamping body must stay deleted — and must NOT be "repaired" by correcting the operand: `evt` is the literal "click" here, so a live body would stamp id="click.<n>" onto EVERY id-less element clicked anywhere in the document, matching neither prefix tested below it');
    });

    it('register()\'s close branch does not rewrite event.target.id', function () {
        var region = region35(
            getPopinSrc(),
            /^[ \t]*var register = function \(type, evt, \$element\) \{/m,
            '// EO var register',
            'register() close branch'
        );

        // CONTROL — the #B299/#B301 fix reads currentTarget; its presence proves the
        // region actually spans the close branch.
        assert.ok(/event\.currentTarget\.id/.test(region),
            'control: the close branch must still read event.currentTarget.id (#B299/#B301) — if this fails the region is mis-anchored');

        assert.equal(/typeof\(event\.target\.id\) == 'undefined'/.test(region), false,
            'the always-false id guard must stay deleted');
        assert.equal(/event\.target\.setAttribute\('id', evt/.test(region), false,
            'the id-rewrite body must stay deleted — and must NOT be "repaired": it would set the clicked node\'s id to `evt + "." + _nextId()`, breaking the invariant the #B299/#B301 note depends on (the $close teardown sweep finds this listener via `gina.events[eId] == eId`, i.e. element id === event name) and leaking the listener');
    });
});
