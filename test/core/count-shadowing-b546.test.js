/**
 * #B546 — the framework's OWN own-property counts must not travel through a
 * shadowable property lookup.
 *
 * gina installs a `count()` helper on `Object.prototype` (`utils/prototypes.js:62`,
 * unguarded, on require). `<container>.count()` is therefore an ordinary property
 * lookup, and an OWN property of that name shadows the helper. The containers the
 * request pipeline counts — `request.body`, `request.query`, `req.params`,
 * `req.files`, `req[method]`, caller-supplied query data, a rule's `options.data`,
 * and whatever a template pipes through `| length` — are keyed by the CLIENT, so a
 * single field named `count` made the framework call a string.
 *
 * Measured live before the fix, each arm beside a control differing only in the
 * field name: on the guarded body branches it surfaced as a 500; on the UNGUARDED query branches as
 * an uncaughtException that EXITED the bundle process, unauthenticated, on any URL
 * including one with no route, because the parse runs before routing resolves; and
 * on a route param as an unhandled rejection that left the request hanging open.
 *
 * The fix reaches the same helper through `ownCount(x)`, which no
 * own property can shadow. It is the same function body, so every other receiver
 * shape (plain object, array, string, number, boolean) counts exactly as before.
 *
 * SEAMS (red-first, no working-tree revert — jsdoc.md § "validate by pulling the
 * pre-change text from git"):
 *   GINA_B546_SERVER_SRC / _CONTROLLER_SRC / _SWIG_SRC / _NUNJUCKS_SRC / _FORMVAL_SRC
 * point the pins AND the behavioural arms at a `git show <sha>:<path>` extract.
 *
 * ⚠️ The harness installs `utils/prototypes` deliberately. Without it every pre-fix
 * arm would go red because the helper is missing, not because the defect is present
 * — the #B165 shape (jsdoc.md § "a red-first arm can go red for a HARNESS reason").
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var FW     = require('../fw');

require(path.resolve(FW, '..', '..', 'utils', 'prototypes')); // Object.prototype.count()

var SRC = {
    server:     process.env.GINA_B546_SERVER_SRC     || path.join(FW, 'core/server.js'),
    controller: process.env.GINA_B546_CONTROLLER_SRC || path.join(FW, 'core/controller/controller.js'),
    swig:       process.env.GINA_B546_SWIG_SRC       || path.join(FW, 'lib/swig-filters/src/main.js'),
    nunjucks:   process.env.GINA_B546_NUNJUCKS_SRC   || path.join(FW, 'lib/nunjucks-filters/src/main.js'),
    formval:    process.env.GINA_B546_FORMVAL_SRC    || path.join(FW, 'core/plugins/lib/validator/src/form-validator.js')
};
var TEXT = {};
Object.keys(SRC).forEach(function (k) { TEXT[k] = fs.readFileSync(SRC[k], 'utf8'); });

/** Strip block and line comments so a NEGATIVE pin cannot trip on the fix's own prose. */
function codeOnly(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
}

/**
 * The OUTERMOST balanced `( … )` group enclosing `needle` — the `if (…)`, the
 * ternary's condition, or the `var x = ( … )` group, lifted verbatim from the
 * shipped source so the arms execute real bytes rather than a replica.
 */
function enclosingCondition(src, needle) {
    var at = src.indexOf(needle);
    assert.ok(at > -1, 'needle absent from source: ' + needle);

    /** Content of the balanced group opening at `i`, or null if it never closes in range. */
    function groupAt(i) {
        if (src[i] !== '(') { return null; }
        var depth = 0;
        for (var j = i; j < src.length && j - i < 1500; j++) {
            if (src[j] === '(') { depth++; }
            else if (src[j] === ')') {
                depth--;
                if (depth === 0) { return { text: src.slice(i + 1, j), end: j }; }
            }
        }
        return null;
    }

    // Forward: the needle opens its own construct — `if (`, `} else if (`,
    // `var x = (`, `y = ( … ) ? …`. Take the first group that holds the call.
    for (var f = at; f < at + needle.length + 4 && f < src.length; f++) {
        var g = groupAt(f);
        if (g && g.text.indexOf('ownCount(') > -1) { return g.text; }
    }
    // Backward: the needle is a FRAGMENT of a larger (often multi-line)
    // condition — take the outermost group that spans it.
    var best = null;
    for (var i = at; i >= 0 && at - i < 900; i--) {
        var b = groupAt(i);
        if (b && b.end > at) { best = b.text; }
    }
    assert.ok(best, 'no balanced group encloses: ' + needle);
    return best;
}

/** The file's OWN `ownCount` helper, lifted from the shipped source and made callable. */
function helperOf(text) {
    var at = text.indexOf('function ownCount(container) {');
    assert.ok(at > -1, 'the ownCount helper is declared in this file');
    assert.equal(text.indexOf('function ownCount(container) {', at + 1), -1,
        'exactly one ownCount declaration per file');
    var depth = 0, end = -1;
    for (var j = text.indexOf('{', at); j < text.length; j++) {
        if (text[j] === '{') { depth++; }
        else if (text[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    assert.ok(end > at, 'the helper closes');
    /* eslint-disable no-new-func */
    return new Function(text.slice(at, end + 1) + '; return ownCount;')();
}

/**
 * Evaluate a lifted condition with an explicit free-variable scope, plus the file's
 * own `ownCount` — so the arm exercises the shipped helper, not a stand-in.
 */
function run(condition, scope, helper) {
    var withHelper = Object.assign({ ownCount: helper }, scope);
    var names  = Object.keys(withHelper);
    var values = names.map(function (n) { return withHelper[n]; });
    /* eslint-disable no-new-func */
    return Function.apply(null, names.concat(['return (' + condition + ');'])).apply(null, values);
}

// A container whose keys the client chose, carrying the colliding name.
function shadowed(extra) { return Object.assign({ count: '1' }, extra || {}); }

// ---------------------------------------------------------------------------
describe('count-shadowing-b546 §01 — the premise, with controls', function () {

    it('01.1 - an own property named count shadows the helper and makes the call throw', function () {
        assert.equal(({ a: 1, b: 2 }).count(), 2, 'control: the helper is installed and counts own keys');
        assert.throws(function () { return shadowed({ a: 2 }).count(); }, TypeError,
            'the defect: the shorthand calls the own value, which is a string');
    });

    it('01.2 - Object.prototype.count.call reaches the helper regardless of the own property', function () {
        assert.equal(Object.prototype.count.call(shadowed({ a: 2 })), 2);
    });

    it('01.3 - the .call form is the SAME function, so no other receiver shape moves', function () {
        [{}, { a: 1, b: 2 }, { 0: '/p', label: 'x' }, [1, 2, 3], 'abc', '{"a":1}', '', 5, true].forEach(function (v) {
            assert.equal(String(Object.prototype.count.call(v)), String(v.count()),
                'divergence on receiver: ' + JSON.stringify(v));
        });
    });

    it('01.4 - control: null still throws on BOTH forms, so the obj={} seeding invariant is untouched', function () {
        assert.throws(function () { return helperOf(TEXT.server)(null); }, TypeError);
    });
});

// ---------------------------------------------------------------------------
describe('count-shadowing-b546 §01b — the ownCount helper, lifted from each shipped file', function () {

    ['server', 'controller', 'formval'].forEach(function (file) {

        it('01b - ' + file + ': counts a container keyed `count` instead of calling it', function () {
            assert.equal(helperOf(TEXT[file])(shadowed({ a: 2 })), 2);
        });

        it('01b - ' + file + ': agrees with the shorthand on every non-shadowed receiver', function () {
            var h = helperOf(TEXT[file]);
            [{}, { a: 1, b: 2 }, { 0: '/p', label: 'x' }, [1, 2, 3], 'abc', '{"a":1}', '', 5, true].forEach(function (v) {
                assert.equal(String(h(v)), String(v.count()), 'divergence on receiver: ' + JSON.stringify(v));
            });
        });

        it('01b - ' + file + ': null and undefined still THROW, as the shorthand did', function () {
            var h = helperOf(TEXT[file]);
            // The seeding invariant in the body-parse branches (`obj = {}`, because
            // `typeof null === 'object'`) is built on this throw. A bare
            // `Object.prototype.count.call(null)` would bind `this` to the global object
            // and return ITS key count instead — measured 23 on this runtime.
            assert.throws(function () { return h(null); }, TypeError);
            assert.throws(function () { return h(undefined); }, TypeError);
            assert.ok(Object.prototype.count.call(null) > 0,
                'control: the raw .call form really does NOT throw, which is why the guard exists');
        });
    });
});

// ---------------------------------------------------------------------------
describe('count-shadowing-b546 §02 — negative pins: no client-keyed container is counted via the shorthand', function () {

    // receiver expressions whose keys the client chooses
    var FORBIDDEN = [
        'request.body.count()', 'request.query.count()', 'req.query.count()', 'req.params.count()',
        '_origReqMethod.count()', 'parameters.count()', 'requestParams.count()', 'files.count()',
        'options.data.count()'
    ];

    it('02.1 - control: the comment strip removes text AND leaves the fixed idiom in view', function () {
        var raw = TEXT.server, code = codeOnly(raw);
        assert.notEqual(code, raw, 'the strip changed the text');
        assert.ok(code.indexOf('ownCount(request.query)') > -1,
            'an over-eager strip must not green the negatives by emptying the corpus');
    });

    it('02.2 - server.js carries none of the shadowable client-keyed forms', function () {
        var code = codeOnly(TEXT.server);
        FORBIDDEN.forEach(function (f) {
            assert.equal(code.indexOf(f), -1, 'server.js still counts a client-keyed container via ' + f);
        });
    });

    it('02.3 - controller.js carries none of them either', function () {
        var code = codeOnly(TEXT.controller);
        FORBIDDEN.forEach(function (f) {
            assert.equal(code.indexOf(f), -1, 'controller.js still counts a client-keyed container via ' + f);
        });
    });

    it('02.4 - the validator rule-data site is counted through the helper', function () {
        var code = codeOnly(TEXT.formval);
        assert.equal(code.indexOf('options.data.count()'), -1);
        assert.ok(code.indexOf('ownCount(options.data)') > -1);
    });

    it('02.5 - census: the rewritten sites are all still present (a silent revert reads here)', function () {
        function n(s, needle) {
            var c = 0, i = s.indexOf(needle);
            while (i > -1) { c++; i = s.indexOf(needle, i + needle.length); }
            return c;
        }
        // 1 declaration + N call sites per file. A silent revert of any site reads here,
        // and so does an unreviewed NEW client-keyed count added without a red-first arm.
        assert.equal(n(codeOnly(TEXT.server), 'ownCount('), 19, 'server.js: 1 declaration + 18 call sites');
        assert.equal(n(codeOnly(TEXT.controller), 'ownCount('), 9, 'controller.js: 1 declaration + 8 call sites');
        assert.equal(n(codeOnly(TEXT.formval), 'ownCount('), 2, 'form-validator.js: 1 declaration + 1 call site');
    });

    it('02.6 - the config/internal counts are deliberately LEFT on the shorthand', function () {
        var code = codeOnly(TEXT.server);
        // these receivers are framework-built, never client-keyed — pinned so the
        // boundary stays a decision rather than drift
        ['resHeaders.count()', 'routing.count()', 'err.count()'].forEach(function (kept) {
            assert.ok(code.indexOf(kept) > -1, 'expected to keep the shorthand at ' + kept);
        });
    });
});

// ---------------------------------------------------------------------------
describe('count-shadowing-b546 §03 — the lifted conditions, driven with a client-keyed container', function () {

    var q = function (extra) { return { request: { query: shadowed(extra) } }; };

    // { label, file, needle, scope-with-a-shadowing-key, expected, control-scope, control-expected }
    var SITES = [
        { label: 'POST urlencoded tail (obj)', file: 'server',
          needle: 'if (ownCount(obj) == 0 && bodyStr.length > 1) {',
          scope: { obj: shadowed(), bodyStr: 'xx' }, expect: false,
          ctl: { obj: {}, bodyStr: 'xx' }, ctlExpect: true },

        { label: 'POST/PUT body-empty fallback to query', file: 'server',
          needle: "if (ownCount(request.body) == 0 && typeof(request.query) != 'string' && ownCount(request.query) > 0 ) {",
          scope: { request: { body: {}, query: shadowed() } }, expect: true,
          ctl: { request: { body: { a: 1 }, query: shadowed() } }, ctlExpect: false },

        { label: 'PATCH body-empty fallback to query', file: 'server',
          needle: "if ( ownCount(request.body) == 0 && typeof(request.query) != 'string' && ownCount(request.query) > 0 ) {",
          scope: { request: { body: {}, query: shadowed() } }, expect: true,
          ctl: { request: { body: {}, query: {} } }, ctlExpect: false },

        { label: 'POST/PATCH parsed-body adoption', file: 'server',
          needle: "if ( typeof(obj) == 'object' && ownCount(obj) > 0 ) {",
          scope: { obj: shadowed() }, expect: true,
          ctl: { obj: {} }, ctlExpect: false },

        { label: 'GET/HEAD query branch (the process-kill site)', file: 'server',
          needle: "if ( typeof(request.query) != 'undefined' && ownCount(request.query) > 0 ) {",
          scope: q(), expect: true,
          ctl: { request: { query: {} } }, ctlExpect: false },

        { label: 'PUT parsed-body empty check', file: 'server',
          needle: "if ( typeof(obj) != 'undefined' && ownCount(obj) == 0 && bodyStr.length > 1 ) {",
          scope: { obj: shadowed(), bodyStr: 'xx' }, expect: false,
          ctl: { obj: {}, bodyStr: 'xx' }, ctlExpect: true },

        { label: 'PUT parsed-body adoption', file: 'server',
          needle: "if ( obj && typeof(obj) != 'undefined' && ownCount(obj) > 0 ) {",
          scope: { obj: shadowed() }, expect: true,
          ctl: { obj: {} }, ctlExpect: false },

        { label: 'DELETE query branch (the process-kill site)', file: 'server',
          needle: 'if ( ownCount(request.query) > 0 ) {',
          scope: q(), expect: true,
          ctl: { request: { query: {} } }, ctlExpect: false },

        { label: 'PATCH tolerant-parse ternary', file: 'server',
          needle: 'request.patch = ( ownCount(obj) == 0 && bodyStr.length > 1 ) ? obj',
          scope: { obj: shadowed(), bodyStr: 'xx' }, expect: false,
          ctl: { obj: {}, bodyStr: 'xx' }, ctlExpect: true },

        { label: 'handle() GET/DELETE no-param exception (query AND params)', file: 'server',
          needle: 'ownCount(req.params) > 1',
          scope: { methods: ['get', 'delete'], method: 'get', req: { query: undefined, params: shadowed({ 0: '/p' }) } }, expect: true,
          ctl: { methods: ['get', 'delete'], method: 'get', req: { query: undefined, params: { 0: '/p' } } }, ctlExpect: false },

        { label: 'req[method] restore after route matching', file: 'server',
          needle: 'ownCount(_origReqMethod) > 0',
          scope: { _origReqMethod: shadowed(), _reqMethodKey: 'get', req: { get: undefined } }, expect: true,
          ctl: { _origReqMethod: {}, _reqMethodKey: 'get', req: { get: undefined } }, ctlExpect: false },

        { label: 'setOptions view params', file: 'controller',
          needle: 'if (ownCount(parameters) > 0)',
          scope: { parameters: shadowed() }, expect: true,
          ctl: { parameters: {} }, ctlExpect: false },

        { label: 'redirect() request params', file: 'controller',
          needle: "if ( typeof(requestParams) != 'undefined' && ownCount(requestParams) > 0 ) {",
          scope: { requestParams: shadowed() }, expect: true,
          ctl: { requestParams: {} }, ctlExpect: false },

        { label: 'redirect() XHR branch params', file: 'controller',
          needle: 'if (ownCount(requestParams) > 0)  {',
          scope: { requestParams: shadowed() }, expect: true,
          ctl: { requestParams: {} }, ctlExpect: false },

        { label: 'store() uploaded files', file: 'controller',
          needle: "if ( typeof(files) == 'undefined' || ownCount(files) == 0 ) {",
          scope: { files: (function () { var a = [{ name: 'f' }]; a.count = '1'; return a; })() }, expect: false,
          ctl: { files: [] }, ctlExpect: true },

        { label: 'query() caller data', file: 'controller',
          needle: "} else if ( typeof(data) != 'undefined' &&  ownCount(data) > 0) {",
          scope: { data: shadowed() }, expect: true,
          ctl: { data: {} }, ctlExpect: false },

        { label: 'pauseRequest() params', file: 'controller',
          needle: 'if (ownCount(requestParams) > 0) {',
          scope: { requestParams: shadowed() }, expect: true,
          ctl: { requestParams: {} }, ctlExpect: false },

        { label: 'resumeRequest() data (no-space form)', file: 'controller',
          needle: 'if (ownCount(data) > 0) {',
          scope: { data: shadowed() }, expect: true,
          ctl: { data: {} }, ctlExpect: false },

        { label: 'resumeRequest() data (spaced form)', file: 'controller',
          needle: 'if ( ownCount(data) > 0 ) {',
          scope: { data: shadowed() }, expect: true,
          ctl: { data: {} }, ctlExpect: false },

        { label: 'validator rule data', file: 'formval',
          needle: "var data = ( typeof(options.data) == 'object' && ownCount(options.data) > 0 )",
          scope: { options: { data: shadowed() } }, expect: true,
          ctl: { options: { data: {} } }, ctlExpect: false }
    ];

    SITES.forEach(function (s, i) {
        var n = ('0' + (i + 1)).slice(-2);
        it('03.' + n + ' - ' + s.label + ': evaluates without throwing on a container keyed `count`', function () {
            var cond = enclosingCondition(TEXT[s.file], s.needle);
            assert.ok(cond.indexOf('ownCount(') > -1,
                'instrument: the lifted condition must route through ownCount — got: ' + cond.slice(0, 120));
            assert.equal(run(cond, s.scope, helperOf(TEXT[s.file])), s.expect, 'lifted condition: ' + cond.slice(0, 150));
        });

        it('03.' + n + 'c - ' + s.label + ': control, the same condition still discriminates on a clean container', function () {
            var cond = enclosingCondition(TEXT[s.file], s.needle);
            assert.equal(run(cond, s.ctl, helperOf(TEXT[s.file])), s.ctlExpect, 'lifted condition: ' + cond.slice(0, 150));
        });
    });

    // -----------------------------------------------------------------------
    // SUBTRACT — what promotes §03 above a source pin (jsdoc.md § "a source pin is
    // not a behavioral test"). Each lifted condition is rewritten back to the
    // pre-fix shorthand and driven with the SAME container: it must throw. If the
    // rewrite were cosmetic these would pass, and §03 would be certifying nothing.
    function preFix(cond) {
        var out = cond.replace(/ownCount\(([^)]*)\)/g, '$1.count()');
        assert.notEqual(out, cond, 'the subtract must change the bytes it executes');
        assert.equal(out.indexOf('ownCount('), -1, 'no ownCount call survives the subtract');
        return out;
    }

    SITES.forEach(function (s, i) {
        var n = ('0' + (i + 1)).slice(-2);
        it('03.' + n + 's - ' + s.label + ': SUBTRACT, the pre-fix shorthand throws on the same container', function () {
            var cond = preFix(enclosingCondition(TEXT[s.file], s.needle));
            assert.throws(function () { return run(cond, s.scope, helperOf(TEXT[s.file])); }, TypeError,
                'pre-fix condition should have thrown: ' + cond.slice(0, 150));
        });

        it('03.' + n + 'sc - ' + s.label + ': SUBTRACT control, the pre-fix shorthand is FINE on a clean container', function () {
            var cond = preFix(enclosingCondition(TEXT[s.file], s.needle));
            assert.equal(run(cond, s.ctl, helperOf(TEXT[s.file])), s.ctlExpect,
                'only the shadowed container should break the shorthand');
        });
    });

    it('03.zz - instrument control: a deliberately WRONG expectation must FAIL', function () {
        var cond = enclosingCondition(TEXT.server, 'if ( ownCount(request.query) > 0 ) {');
        assert.throws(function () {
            assert.equal(run(cond, { request: { query: shadowed() } }, helperOf(TEXT.server)), false);
        }, 'the harness must be able to report a failure, or every row above is void');
    });
});

// ---------------------------------------------------------------------------
describe('count-shadowing-b546 §04 — the |length template filter, on both engines', function () {

    /** Lift self.length verbatim from the shipped filter module. */
    function lengthFilter(text) {
        var a = text.indexOf('self.length = function');
        assert.ok(a > -1, 'self.length declaration present');
        var z = text.indexOf('\n    }', a);
        assert.ok(z > a, 'self.length closes');
        var body = text.slice(a, z + 6).replace(/^self\.length\s*=\s*/, '').replace(/;?\s*$/, '');
        /* eslint-disable no-new-func */
        return new Function('return (' + body + ');')();
    }

    ['swig', 'nunjucks'].forEach(function (engine) {
        it('04 - ' + engine + ': an object keyed `count` no longer crashes the render', function () {
            assert.equal(lengthFilter(TEXT[engine])(shadowed({ a: 2 })), 2);
        });

        it('04 - ' + engine + ': controls, every other receiver is unchanged', function () {
            var f = lengthFilter(TEXT[engine]);
            assert.equal(f(null), 0, 'null guard');
            assert.equal(f(undefined), 0, 'undefined guard');
            assert.equal(f([1, 2, 3]), 3, 'array');
            assert.equal(f({ a: 1, b: 2 }), 2, 'plain object');
        });

        it('04 - ' + engine + ': an own count METHOD still wins (the collection-like case the filter exists for)', function () {
            assert.equal(lengthFilter(TEXT[engine])({ count: function () { return 42; } }), 42);
        });
    });
});
