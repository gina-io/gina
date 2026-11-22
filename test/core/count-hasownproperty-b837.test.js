'use strict';
/**
 * #B837 — `count()` and `functionCount()` test each key with a `hasOwnProperty`
 * no key can shadow.
 *
 * gina installs a `count()` helper on `Object.prototype` from two files:
 * `utils/prototypes.js`, unconditionally, on require (the copy a bundle process
 * runs), and `framework/v<version>/helpers/prototypes.js`, only when no `count` is
 * installed yet (the copy the browser bundle carries, `gina.js` / `gina.min.js`).
 * Both counted with `this.hasOwnProperty(prop)` inside a `try` whose `catch`
 * returns the count so far. On an object with an OWN `hasOwnProperty` key that is
 * not a function (a request field of that name) and on an object with no
 * prototype (`Object.create(null)`, `querystring.parse()`), that call throws on
 * the first key, so the helper returned 0. The request pipeline gates on that
 * count, so a request carrying a field named `hasOwnProperty` reached its action
 * with `req.get` / `req.delete` empty and `req.body` left as the raw string.
 * `functionCount()` (utils copy only) made the same call with no `try`, so it
 * threw on both shapes.
 *
 * The fix tests each key with `Object.prototype.hasOwnProperty.call(this, prop)`.
 * It is the same test on every other receiver, so no other count moves.
 *
 *   §01  the premise, with controls: the shorthand, derived from each shipped
 *        function, reads 0 on the defect shapes and counts every other shape
 *   §02  each copy, installed in its own child process the way a process
 *        installs it, counts the defect shapes and the controls
 *   §03  the shipped function of each copy, and of the built browser bundle,
 *        agrees with the shorthand on every ordinary shape and differs on the
 *        defect shapes only
 *   §04  functionCount (utils copy): the shorthand throws on both shapes, the
 *        shipped function counts them, and both agree elsewhere
 *
 * SEAMS (red-first with no tree revert): GINA_B837_UTILS_SRC,
 * GINA_B837_HELPERS_SRC and GINA_B837_DIST_DIR point every arm at another copy
 * (a `git show <rev>:<path>` extract). On the pre-fix copies §01 and every control
 * pass while each arm that names the fix fails.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var { spawnSync } = require('child_process');

var FW   = require('../fw');
var commentStrip = require('../strip-comments');
var ROOT = path.resolve(FW, '..', '..');

var SRC = {
    utils:   process.env.GINA_B837_UTILS_SRC   || path.join(ROOT, 'utils', 'prototypes.js'),
    helpers: process.env.GINA_B837_HELPERS_SRC || path.join(FW, 'helpers', 'prototypes.js')
};
var DIST_DIR = process.env.GINA_B837_DIST_DIR || path.join(FW, 'core', 'asset', 'plugin', 'dist', 'vendor', 'gina', 'js');
var DIST = {
    'gina.js':     path.join(DIST_DIR, 'gina.js'),
    'gina.min.js': path.join(DIST_DIR, 'gina.min.js')
};

/** The own-key test the fix writes, whatever the minifier named the key variable. */
var CALL_FORM  = /Object\.prototype\.hasOwnProperty\.call\(\s*this\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
/** The pre-fix own-key test. */
var SHORT_FORM = /this\.hasOwnProperty\(\s*([A-Za-z_$][\w$]*)\s*\)/g;

/** Strips block and line comments, so a comment naming either form cannot count as code. */
function codeOnly(s) {
    return commentStrip.all(s);
}

/**
 * The code of the function a file installs as `Object.prototype.<name>`, from
 * `function` to its closing brace, comments removed (the file must define it
 * exactly once).
 *
 * @param {string} src - File text.
 * @param {string} name - The installed name.
 * @returns {string} The function's code.
 */
function installedFunctionText(src, name) {
    var anchor = new RegExp("Object\\.defineProperty\\(\\s*Object\\.prototype\\s*,\\s*'" + name + "'\\s*,\\s*\\{", 'g');
    var hits = src.match(anchor) || [];
    assert.equal(hits.length, 1, 'the file defines Object.prototype.' + name + ' exactly once');
    var value = /value\s*:\s*function\s*\(\s*\)\s*\{/g;
    value.lastIndex = src.search(anchor);
    var m = value.exec(src);
    assert.ok(m, 'the ' + name + ' definition has a value function');
    var start = m.index + m[0].indexOf('function'), depth = 0;
    for (var i = m.index + m[0].length - 1; i < src.length; i++) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') { depth--; if (depth === 0) { return codeOnly(src.slice(start, i + 1)); } }
    }
    throw new Error('unbalanced braces after the ' + name + ' definition');
}

/** Compiles a function text in sloppy mode, as the shipped files run it. */
function compile(fnText) {
    /* eslint-disable no-new-func */
    return new Function('return (' + fnText + ');')();
}

/**
 * The function with its own-key test written as the pre-fix shorthand: the
 * shipped text when it already carries it, otherwise the shipped text with the
 * call form put back. Either way the function holds exactly one own-key test.
 */
function shorthandOf(fnText) {
    var calls = fnText.match(CALL_FORM) || [], shorts = fnText.match(SHORT_FORM) || [];
    assert.equal(calls.length + shorts.length, 1, 'the function makes exactly one own-key test');
    return fnText.replace(CALL_FORM, 'this.hasOwnProperty($1)');
}

function nullProto(o) { return Object.assign(Object.create(null), o); }

/** The shapes the shorthand miscounts: [label, make, the own enumerable count]. */
var DEFECT = [
    ['an own hasOwnProperty key that is not a function', function () { return { hasOwnProperty: 'x', a: 1 }; }, 2],
    ['the same key after the others',                   function () { return { a: 1, b: 2, hasOwnProperty: 'x' }; }, 3],
    ['an object with no prototype',                     function () { return nullProto({ a: 1, b: 2 }); }, 2],
    ['an own hasOwnProperty function that answers false', function () { return { hasOwnProperty: function () { return false; }, a: 1 }; }, 2]
];

/** Every other shape: both forms must agree on each. */
var ORDINARY = [
    function () { return {}; },
    function () { return { a: 1, b: 2 }; },
    function () { return { hasOwnPropertyX: 'x', a: 1 }; },
    function () { return { 0: '/p', label: 'x' }; },
    function () { return { count: 5, a: 1 }; },
    function () { return Object.assign(Object.create({ inherited: 1 }), { own: 1 }); },
    function () { return [1, 2, 3]; },
    function () { return 'abc'; },
    function () { return '{"a":1}'; },
    function () { return ''; },
    function () { return 5; },
    function () { return true; }
];

function show(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }

var TEXT = {}, FN = {};
Object.keys(SRC).forEach(function (k) { TEXT[k] = fs.readFileSync(SRC[k], 'utf8'); });
Object.keys(DIST).forEach(function (k) { TEXT[k] = fs.readFileSync(DIST[k], 'utf8'); });
Object.keys(TEXT).forEach(function (k) { FN[k] = installedFunctionText(TEXT[k], 'count'); });

// ---------------------------------------------------------------------------
describe('count-hasownproperty-b837 §01 — the premise, with controls', function () {

    Object.keys(FN).forEach(function (copy) {

        it('01 - ' + copy + ': the shorthand reads 0 on every defect shape', function () {
            var short = compile(shorthandOf(FN[copy]));
            DEFECT.forEach(function (d) {
                assert.equal(short.call(d[1]()), 0, copy + ', ' + d[0]);
            });
        });

        it('01 - ' + copy + ': control, the shorthand counts a plain object and a near-miss key', function () {
            var short = compile(shorthandOf(FN[copy]));
            assert.equal(short.call({ a: 1, b: 2 }), 2);
            assert.equal(short.call({ hasOwnPropertyX: 'x', a: 1 }), 2);
        });
    });
});

// ---------------------------------------------------------------------------
describe('count-hasownproperty-b837 §02 — each copy, installed in a process of its own', function () {

    /** The receivers the child counts, as source text the child evaluates. */
    var RECEIVERS = [
        "{ hasOwnProperty: 'x', a: 1 }",                              // 0 the key first
        "{ a: 1, b: 2, hasOwnProperty: 'x' }",                        // 1 the key last
        'Object.assign(Object.create(null), { a: 1, b: 2 })',         // 2 no prototype
        '{ a: 1, b: 2 }',                                             // 3 control
        "{ hasOwnPropertyX: 'x', a: 1 }",                             // 4 near-miss control
        'Object.assign(Object.create({ inh: 1 }), { own: 1 })'       // 5 inherited key control
    ];

    /**
     * Loads one copy in a fresh process, the way a process installs it, and returns
     * what the installed `count()` reads on each receiver, the shorthand call on a
     * plain object, and the module files the process loaded.
     *
     * @param {string} copy - 'utils' or 'helpers'.
     * @param {string} [also] - Another copy's path, loaded after it (the control).
     */
    function installed(copy, also) {
        var code = [
            "if (typeof Object.prototype.count !== 'undefined') { throw new Error('a count helper was installed before the copy loaded'); }",
            // with JSON.clone missing, the helpers copy loads utils/helper, which installs the
            // OTHER copy first, and the utils copy requires a sibling file: neither concerns count()
            'JSON.clone = function (o) { return o; };',
            'var m = require(process.env.B837_SRC);',
            "if (process.env.B837_COPY === 'helpers') { m(); }",
            'if (process.env.B837_ALSO) { require(process.env.B837_ALSO)(); }',
            'var c = Object.prototype.count;',
            'process.stdout.write(JSON.stringify({',
            '    type: typeof c,',
            "    self: require('fs').realpathSync(process.env.B837_SRC),",
            "    loaded: Object.keys(require.cache).filter(function (k) { return /\\.js$/.test(k); }),",
            '    reads: [' + RECEIVERS.join(', ') + '].map(function (r) { return String(c.call(r)); }),',
            '    shorthand: ({ a: 1, b: 2 }).count()',
            '}));'
        ].join('\n');
        var env = Object.assign({}, process.env, { B837_SRC: SRC[copy], B837_COPY: copy });
        delete env.B837_ALSO;
        if (also) { env.B837_ALSO = also; }
        var r = spawnSync(process.execPath, ['-e', code], { env: env, encoding: 'utf8', timeout: 30000 });
        assert.equal(r.status, 0, copy + ': the child loads the copy: ' + (r.stderr || '').slice(-600));
        return JSON.parse(r.stdout);
    }

    it('02 - control: a process that loads the other copy too is told apart', function () {
        var o = installed('utils', SRC.helpers);
        assert.equal(o.loaded.length, 2);
        assert.notDeepEqual(o.loaded, [o.self]);
    });

    ['utils', 'helpers'].forEach(function (copy) {

        it('02 - ' + copy + ': the child loads THIS copy and no other module (control)', function () {
            var o = installed(copy);
            assert.equal(o.type, 'function');
            assert.deepEqual(o.loaded, [o.self]);
        });

        it('02 - ' + copy + ': controls, a plain object, a near-miss key, an inherited key and the shorthand call', function () {
            var o = installed(copy);
            assert.equal(o.reads[3], '2');
            assert.equal(o.reads[4], '2');
            assert.equal(o.reads[5], '1', 'an inherited key is not counted');
            assert.equal(o.shorthand, 2);
        });

        it('02 - ' + copy + ': an own hasOwnProperty key is counted like any other key', function () {
            var o = installed(copy);
            assert.equal(o.reads[0], '2', 'the key first');
            assert.equal(o.reads[1], '3', 'the key last');
        });

        it('02 - ' + copy + ': an object with no prototype is counted', function () {
            assert.equal(installed(copy).reads[2], '2');
        });
    });
});

// ---------------------------------------------------------------------------
describe('count-hasownproperty-b837 §03 — the shipped function differs from the shorthand on the defect shapes only', function () {

    Object.keys(FN).forEach(function (copy) {

        it('03 - ' + copy + ': counts every defect shape', function () {
            var fixed = compile(FN[copy]);
            DEFECT.forEach(function (d) {
                assert.equal(fixed.call(d[1]()), d[2], copy + ', ' + d[0]);
            });
        });

        it('03 - ' + copy + ': agrees with the shorthand on every ordinary shape', function () {
            var fixed = compile(FN[copy]), short = compile(shorthandOf(FN[copy]));
            ORDINARY.forEach(function (make) {
                var v = make();
                assert.equal(String(fixed.call(v)), String(short.call(v)), copy + ', receiver ' + show(v));
            });
        });
    });
});

// ---------------------------------------------------------------------------
describe('count-hasownproperty-b837 §04 — functionCount, the same own-key test (utils copy)', function () {

    var FC = installedFunctionText(TEXT.utils, 'functionCount');
    function fn() {}

    it('04 - premise: the shorthand throws on an own hasOwnProperty key and on an object with no prototype', function () {
        var short = compile(shorthandOf(FC));
        assert.equal(short.call({ f: fn, a: 1 }), 1, 'control: it counts a plain object');
        assert.throws(function () { short.call({ hasOwnProperty: 'x', f: fn }); }, TypeError);
        assert.throws(function () { short.call(nullProto({ f: fn, a: 1 })); }, TypeError);
    });

    it('04 - counts the function-valued keys of both shapes', function () {
        var fixed = compile(FC);
        assert.equal(fixed.call({ hasOwnProperty: 'x', f: fn, a: 1 }), 1);
        assert.equal(fixed.call(nullProto({ f: fn, a: 1 })), 1);
    });

    it('04 - agrees with the shorthand on ordinary shapes', function () {
        var fixed = compile(FC), short = compile(shorthandOf(FC));
        [{}, { f: fn, a: 1 }, { f: fn, g: fn }, Object.assign(Object.create({ inh: fn }), { own: fn }), [fn, 1]].forEach(function (v, i) {
            assert.equal(fixed.call(v), short.call(v), 'receiver #' + i);
        });
    });
});
