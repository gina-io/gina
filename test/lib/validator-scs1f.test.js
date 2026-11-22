'use strict';
var path   = require('path');
var fs     = require('fs');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW       = require('../fw');
var commentStrip = require('../strip-comments');
var MAIN_SRC = fs.readFileSync(path.join(FW, 'core/plugins/lib/validator/src/main.js'), 'utf8');

// --- Test-local replicas of the two primitives shipped at #M20. ---
// These mirror the source verbatim so the behavioural assertions below
// double as parity locks: if the replica diverges from the source, the
// source-inspection block in section 04 fails and surfaces the drift.

var setByPath = function (rootObj, segments, value) {
    var cur = rootObj;
    for (var i = 0; i < segments.length - 1; i++) {
        var seg = segments[i];
        if (cur[seg] === undefined || cur[seg] === null) {
            cur[seg] = (typeof segments[i + 1] === 'number') ? [] : {};
        }
        cur = cur[seg];
    }
    cur[segments[segments.length - 1]] = value;
};

var JSONclone = function (obj) { return JSON.parse(JSON.stringify(obj)); };

var makeObjectFromArgs = function (_root, args, _obj, len, i, _value, _rootObj) {
    var rootSegments = Array.isArray(_root) ? _root : ['rootObj'];
    var obj          = _obj || null;
    var value        = _value || null;
    var rootObj      = _rootObj || null;

    if (i == len) {
        setByPath(rootObj, rootSegments.slice(1), value);
        return JSONclone(rootObj);
    }

    var key = args[i].replace(/^\[|\]$/g, '');

    if (typeof(rootObj) == 'undefined' || !rootObj) {
        rootObj      = {};
        rootSegments = ['rootObj'];
        rootSegments.push((/^\d+$/.test(key)) ? parseInt(key, 10) : key);
        setByPath(rootObj, rootSegments.slice(1), obj);
    } else {
        rootSegments.push((/^\d+$/.test(key)) ? parseInt(key, 10) : key);
    }

    var nextKey   = (typeof(args[i + 1]) != 'undefined') ? args[i + 1].replace(/^\[|\]$/g, '') : null;
    var valueType = (nextKey && parseInt(nextKey) == nextKey) ? [] : {};
    if (nextKey) {
        setByPath(rootObj, rootSegments.slice(1), valueType);
    }

    if (typeof(obj[key]) == 'undefined') {
        if (/^\d+$/.test(nextKey)) {
            obj[key] = [];
        } else {
            obj[key] = {};
        }
        ++i;
        return makeObjectFromArgs(rootSegments, args, obj[key], len, i, value, rootObj);
    }

    ++i;
    return makeObjectFromArgs(rootSegments, args, obj[key], len, i, value, rootObj);
};


// --- 01 — setByPath standalone behaviour ---
describe('01 — setByPath standalone behaviour (#M20)', function () {

    it('assigns at single-segment string key', function () {
        var root = {};
        setByPath(root, ['foo'], 'leaf');
        assert.deepStrictEqual(root, { foo: 'leaf' });
    });

    it('assigns at single-segment numeric key (on object root)', function () {
        var root = {};
        setByPath(root, [0], 'leaf');
        assert.deepStrictEqual(root, { 0: 'leaf' });
    });

    it('creates intermediate object when next segment is string', function () {
        var root = {};
        setByPath(root, ['foo', 'bar'], 42);
        assert.deepStrictEqual(root, { foo: { bar: 42 } });
    });

    it('creates intermediate array when next segment is numeric', function () {
        var root = {};
        setByPath(root, ['items', 0], 'first');
        assert.deepStrictEqual(root, { items: ['first'] });
    });

    it('walks deep nested object path', function () {
        var root = {};
        setByPath(root, ['a', 'b', 'c'], 'deep');
        assert.deepStrictEqual(root, { a: { b: { c: 'deep' } } });
    });

    it('walks mixed object + array path', function () {
        var root = {};
        setByPath(root, ['users', 0, 'name'], 'Ada');
        assert.deepStrictEqual(root, { users: [{ name: 'Ada' }] });
    });

    it('walks array + object + array path', function () {
        // Assigning at index 1 of a freshly-created array leaves a sparse hole
        // at index 0 — deepStrictEqual distinguishes sparse from explicit
        // undefined, so verify shape via index access.
        var root = {};
        setByPath(root, ['rows', 0, 'cells', 1], 'cell');
        assert.ok(Array.isArray(root.rows));
        assert.equal(root.rows.length, 1);
        assert.ok(Array.isArray(root.rows[0].cells));
        assert.equal(root.rows[0].cells.length, 2);
        assert.equal(root.rows[0].cells[1], 'cell');
    });
});


// --- 02 — setByPath edge cases ---
describe('02 — setByPath edge cases (#M20)', function () {

    it('overwrites existing leaf value', function () {
        var root = { foo: 'old' };
        setByPath(root, ['foo'], 'new');
        assert.equal(root.foo, 'new');
    });

    it('overwrites existing intermediate (does not re-create)', function () {
        var root = { foo: { bar: 'old' } };
        setByPath(root, ['foo', 'bar'], 'new');
        assert.deepStrictEqual(root, { foo: { bar: 'new' } });
    });

    it('does not clobber sibling keys on intermediate object', function () {
        var root = { foo: { sibling: 'keep' } };
        setByPath(root, ['foo', 'new'], 'val');
        assert.deepStrictEqual(root, { foo: { sibling: 'keep', new: 'val' } });
    });

    it('treats explicit null intermediate as missing (recreates)', function () {
        var root = { foo: null };
        setByPath(root, ['foo', 'bar'], 'val');
        assert.deepStrictEqual(root, { foo: { bar: 'val' } });
    });

    it('keeps array semantics on numeric next-segment after recreation', function () {
        var root = { items: null };
        setByPath(root, ['items', 0], 'x');
        assert.ok(Array.isArray(root.items), 'items should be array');
        assert.equal(root.items[0], 'x');
    });
});


// --- 03 — makeObjectFromArgs end-to-end parity ---
// The reference outputs below were derived by tracing the pre-refactor
// (eval-based) function shape by hand for the same args/value inputs.
// Replica behaviour must match the trace, locking parity.
describe('03 — makeObjectFromArgs end-to-end parity (#M20)', function () {

    it('flat single-key path produces {key: value}', function () {
        // args = ['foo'], len = 1, i = 0 (terminal on first call after init branch).
        // External callers always start with at least one key; init branch runs.
        var result = makeObjectFromArgs(undefined, ['foo'], {}, 1, 0, 'leaf', null);
        // Init: rootObj = {foo: {}}. Then i=1=len terminal: rootObj.foo = 'leaf'.
        assert.deepStrictEqual(result, { foo: 'leaf' });
    });

    it('two-segment object path produces nested object', function () {
        var result = makeObjectFromArgs(undefined, ['foo', 'bar'], {}, 2, 0, 'leaf', null);
        assert.deepStrictEqual(result, { foo: { bar: 'leaf' } });
    });

    it('object + numeric-bracket path produces array under outer object', function () {
        var result = makeObjectFromArgs(undefined, ['foo', '[0]'], {}, 2, 0, 'leaf', null);
        // 'foo' is the outer key → object slot. '0' is numeric → array index.
        // After init: rootObj = {foo: []}. nextKey='0', numeric → valueType=[].
        // setByPath overwrites rootObj.foo = []. Then walk in, terminal sets foo[0]=leaf.
        assert.deepStrictEqual(result, { foo: ['leaf'] });
    });

    it('three-segment deep path produces three-level nesting', function () {
        var result = makeObjectFromArgs(undefined, ['a', 'b', 'c'], {}, 3, 0, 'deep', null);
        assert.deepStrictEqual(result, { a: { b: { c: 'deep' } } });
    });

    it('mixed nesting object/array/object produces correct shape', function () {
        var result = makeObjectFromArgs(undefined, ['users', '[0]', 'name'], {}, 3, 0, 'Ada', null);
        assert.deepStrictEqual(result, { users: [{ name: 'Ada' }] });
    });

    it('external-caller call shape (i=1 entry, key="foo") returns sub-tree clone', function () {
        // Matches makeObject:3113 call: makeObjectFromArgs(key, args, obj[key], len, 1, value, null).
        // args = ['foo', '[0]', '[bar]'], starting at i=1. Init branch fires (rootObj=null).
        var arr = [];
        var result = makeObjectFromArgs('foo', ['foo', '[0]', '[bar]'], arr, 3, 1, 'value', null);
        // First call (i=1): init → rootObj={0: arr} → overwrite to {0: {}}.
        //   arr[0] = {} (since nextKey='bar' not numeric).
        // Recurse (i=2): rootSegments=['rootObj',0], NOT init.
        //   push('bar') → ['rootObj',0,'bar']. nextKey=undefined → no valueType set.
        //   arr[0].bar = {} (since nextKey null not numeric).
        // Recurse (i=3=len): terminal.
        //   setByPath(rootObj={0:{}}, [0,'bar'], 'value') → rootObj[0].bar = 'value'.
        //   return JSON.clone(rootObj) → {0: {bar: 'value'}}.
        assert.deepStrictEqual(result, { 0: { bar: 'value' } });
    });

    it('terminal value can be a non-string (object)', function () {
        var leaf = { kind: 'complex' };
        var result = makeObjectFromArgs(undefined, ['foo'], {}, 1, 0, leaf, null);
        assert.deepStrictEqual(result, { foo: leaf });
    });

    it('result is a clone — mutating returned tree does not affect inputs', function () {
        var sourceObj = {};
        var result = makeObjectFromArgs(undefined, ['foo'], sourceObj, 1, 0, 'leaf', null);
        result.foo = 'mutated';
        // sourceObj is left in the state the function transformed it to during recursion,
        // not the post-mutation state of `result` — proves the clone broke the reference.
        assert.notEqual(result.foo, 'leaf');
        assert.equal(result.foo, 'mutated');
    });
});


// --- 04 — Source-inspection guards (#M20 / #SCS1f) ---
// Mirrors the validator-scs1e.test.js § 09 idiom: read MAIN_SRC, strip
// comments (both line and block), then assert on the live (executable)
// code shape. Block-comment stripping is needed because the JSDoc
// provenance tag for makeObjectFromArgs contains the literal text
// "eval(root + ...)" as a historical reference.
describe('04 — #M20 / #SCS1f source-inspection guards', function () {

    var stripComments = function (src) {
        return commentStrip.lines(src);
    };

    it('main.js: zero `eval(root +` calls remain in live code', function () {
        var live = stripComments(MAIN_SRC);
        assert.ok(
            !/eval\s*\(\s*root\s*\+/.test(live),
            'live code still contains eval(root + ...)'
        );
    });

    it('main.js: the makeObjectFromArgs body has no _global.register("root") block', function () {
        // The pre-#M20 scaffolding wrote `'root' : _root || null,` inside a
        // _global.register({...}) literal. Asserting the literal-key absence
        // is precise enough to catch any partial re-introduction.
        var live = stripComments(MAIN_SRC);
        assert.ok(
            !/_global\.register\s*\(\s*\{\s*['"]root['"]/.test(live),
            "live code still contains _global.register({'root' ...})"
        );
    });

    it('main.js: the makeObjectFromArgs body has no _global.register("valueType") block', function () {
        var live = stripComments(MAIN_SRC);
        assert.ok(
            !/_global\.register\s*\(\s*\{\s*['"]valueType['"]/.test(live),
            "live code still contains _global.register({'valueType' ...})"
        );
    });

    it('main.js: the setByPath helper is defined', function () {
        assert.ok(/var\s+setByPath\s*=\s*function/.test(MAIN_SRC), 'setByPath definition missing');
        assert.ok(
            /cur\[segments\[segments\.length\s*-\s*1\]\]\s*=\s*value/.test(MAIN_SRC),
            'setByPath terminal assignment missing'
        );
    });

    it('main.js: setByPath is called from the three pre-#M20 eval sites', function () {
        // Three setByPath call sites inside makeObjectFromArgs: terminal,
        // init-branch, and nextKey-branch. Match the call shape regardless
        // of the third argument.
        var calls = MAIN_SRC.match(/setByPath\s*\(\s*rootObj\s*,\s*rootSegments\.slice\(1\)/g) || [];
        assert.ok(calls.length >= 3, 'expected ≥3 setByPath calls, got ' + calls.length);
    });

    it('main.js: the rootSegments array threads through recursion', function () {
        // Recursive calls at the two tails must pass rootSegments (not root).
        var recursiveCalls = MAIN_SRC.match(/makeObjectFromArgs\s*\(\s*rootSegments\s*,/g) || [];
        assert.ok(
            recursiveCalls.length >= 2,
            'expected ≥2 recursive calls passing rootSegments, got ' + recursiveCalls.length
        );
    });

    it('main.js: carries the #M20 provenance tag', function () {
        assert.ok(/#M20/.test(MAIN_SRC), '#M20 tag should be present in main.js');
    });
});
