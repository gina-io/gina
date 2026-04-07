var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC    = path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var EVENTS_SRC   = path.join(FW, 'core/asset/plugin/src/vendor/gina/utils/events.js');
var BINDING_SRC  = path.join(FW, 'core/asset/plugin/src/vendor/gina/helpers/binding.js');
var DIST_JS      = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

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
