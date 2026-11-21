/**
 * #B88 — a raw server stack trace must never render into a user-facing field error
 * outside local scope.
 *
 * The stack reaches the browser through exactly one channel: `error.fields[fieldName]`
 * (a merge of `{tag,fields,path}` over the error drops the non-enumerable root `.stack`,
 * so the fields slot is the only carrier; both validator render paths — the live-check
 * `compileError` path and the form-submit `main.js` path — read it verbatim). ApiError is
 * the single framework site that writes that slot (`formatClientError`), and it is the
 * point at which a stack is injected: `errorMessage = e.message || e.stack` yields a raw
 * stack whenever the caller's Error has a falsy `.message`, and an app may also pass a
 * stack string directly. So the fix lives here, scope-gated, mirroring the fail-closed
 * wire strip at controller.js (`!_isLocalScope` → strip).
 *
 * Shape: these drive the REAL ApiError helper (server-side, node-requirable — unlike the
 * closure-private compileError, which is source-pinned elsewhere). Scope is read at call
 * time, so the tests toggle NODE_SCOPE_IS_LOCAL and reuse one required module. A subtract
 * (a replica with the guard removed) proves the guard is load-bearing, and the local-scope
 * case doubles as the known-positive instrument check (the shape regex DOES fire on a real
 * stack — it just isn't stripped locally).
 */
'use strict';

var test   = require('node:test');
var assert = require('node:assert');
var fs     = require('node:fs');
var path   = require('node:path');
var commentStrip = require('../strip-comments');

var FW  = path.resolve(__dirname, '../../framework');
// resolve the single tracked framework version dir
var VER = fs.readdirSync(FW).filter(function (d) { return /^v\d/.test(d); }).sort().pop();
var API_ERROR_PATH = path.join(FW, VER, 'helpers/plugins/src/api-error.js');
var GINA_ROOT      = path.resolve(__dirname, '../..');

// --- minimal framework globals api-error.js reads (self-contained; no ~/.gina, no bundle) ---
global.requireJSON = function (p) {
    var s = commentStrip.lines(fs.readFileSync(p, 'utf8'));
    return JSON.parse(s);
};
global.getContext = function () { return { bundle: 'testbundle' }; };
global.getPath    = function () { return { core: path.join(FW, VER, 'core') }; };
global.__stack    = [];
if (typeof JSON.clone !== 'function') {
    JSON.clone = require(path.join(GINA_ROOT, 'utils/prototypes.json_clone.js'));
}

var ApiError    = require(API_ERROR_PATH);
var ENGINE_SRC  = fs.readFileSync(API_ERROR_PATH, 'utf8');
var STACK_SHAPE = /\n\s+at\s/;

// helpers
function fieldOf(e) { var k = Object.keys(e.fields)[0]; return e.fields[k]; }
function withScope(v, fn) {
    var prev = process.env.NODE_SCOPE_IS_LOCAL;
    var prevStack = global.__stack;
    if (v === undefined) { delete process.env.NODE_SCOPE_IS_LOCAL; }
    else { process.env.NODE_SCOPE_IS_LOCAL = v; }
    global.__stack = [];                       // introspection else-branch; the strip still runs
    try { return fn(); } finally {
        if (prev === undefined) { delete process.env.NODE_SCOPE_IS_LOCAL; }
        else { process.env.NODE_SCOPE_IS_LOCAL = prev; }
        global.__stack = prevStack;
    }
}

test('01 - outside local scope: a stack-shaped field message is replaced with a neutral one', function () {
    withScope('false', function () {
        // A: framework fallback — a message-less Error makes ApiError use e.stack
        var a = fieldOf(new ApiError(new Error(''), 'account[username]', 412));
        assert.equal(a, 'An error occurred', 'message-less Error must not leak its stack');
        assert.ok(!STACK_SHAPE.test(a), 'A must not be stack-shaped');

        // B: app passes a stack string directly as the message
        var b = fieldOf(new ApiError((new Error('db exploded')).stack, 'account[username]', 412));
        assert.equal(b, 'An error occurred', 'an app-supplied stack string must not leak');
        assert.ok(!STACK_SHAPE.test(b), 'B must not be stack-shaped');
    });
});

test('02 - outside local scope: ordinary and {{placeholder}} messages are untouched', function () {
    withScope('false', function () {
        assert.equal(fieldOf(new ApiError('Already taken', 'account[username]', 412)), 'Already taken');
        // a query-response placeholder message must survive to reach compileError downstream
        assert.equal(fieldOf(new ApiError('Value {{data[x]}} is taken', 'account[username]', 412)),
                     'Value {{data[x]}} is taken');
    });
});

test('03 - local scope KEEPS the stack (debug parity with controller.js) — and proves the shape regex fires on a real stack', function () {
    withScope('true', function () {
        var a = fieldOf(new ApiError(new Error(''), 'account[username]', 412));
        // known-positive instrument check: this IS a real stack, and the regex matches it —
        // it is simply not stripped in local scope.
        assert.ok(STACK_SHAPE.test(a), 'in local scope the raw stack is retained');
        assert.ok(a.length > 100, 'a retained stack is substantial, not a short label');
        // legit messages still untouched in local scope too
        assert.equal(fieldOf(new ApiError('Already taken', 'account[username]', 412)), 'Already taken');
    });
});

test('04 - unset scope is fail-closed: strips (production-safe default)', function () {
    withScope(undefined, function () {
        var a = fieldOf(new ApiError(new Error(''), 'account[username]', 412));
        assert.equal(a, 'An error occurred', 'an unset NODE_SCOPE_IS_LOCAL must strip, not leak');
    });
});

test('05 - the catch-branch root .stack is scope-gated (it serialises via renderJSON, which does no stripping)', function () {
    var prev = process.env.NODE_SCOPE_IS_LOCAL, prevStack = global.__stack;
    try {
        // force the tag-introspection try to throw: __stack[2] is an object with no getFileName()
        global.__stack = [null, null, {}];

        process.env.NODE_SCOPE_IS_LOCAL = 'false';
        var prod = new ApiError(new Error('boom'), 'field', 412);
        assert.ok(!Object.prototype.hasOwnProperty.call(prod, 'stack'),
                  'outside local scope the introspection-failure stack must not be attached');
        assert.equal(prod.tag, 'N/A');

        process.env.NODE_SCOPE_IS_LOCAL = 'true';
        var local = new ApiError(new Error('boom'), 'field', 412);
        assert.ok(Object.prototype.hasOwnProperty.call(local, 'stack'),
                  'in local scope the stack is retained for debugging');
    } finally {
        if (prev === undefined) { delete process.env.NODE_SCOPE_IS_LOCAL; }
        else { process.env.NODE_SCOPE_IS_LOCAL = prev; }
        global.__stack = prevStack;
    }
});

test('06 - SUBTRACT: without the scope-gated guard, the same stack-shaped value reaches the field slot', function () {
    // Replica of the two shapes at the fields-slot write. The guarded shape mirrors the
    // shipped code; the unguarded shape is the pre-#B88 behaviour.
    function assign(guarded, scopeIsLocal, value) {
        var fields = {};
        fields['f'] = value;
        if (guarded && !scopeIsLocal && typeof(fields['f']) === 'string' && /\n\s+at\s/.test(fields['f'])) {
            fields['f'] = 'An error occurred';
        }
        return fields['f'];
    }
    var stack = (new Error('x')).stack;
    // unguarded (subtract) → the raw stack survives, as it did before the fix
    assert.ok(STACK_SHAPE.test(assign(false, false, stack)), 'without the guard the stack leaks');
    // guarded → replaced outside local scope
    assert.equal(assign(true, false, stack), 'An error occurred');
    // guarded but local → kept
    assert.ok(STACK_SHAPE.test(assign(true, true, stack)), 'guard keeps the stack in local scope');
    // guarded, non-stack value → untouched regardless of scope
    assert.equal(assign(true, false, 'Already taken'), 'Already taken');
});

test('07 - source: the fields-slot strip is scope-gated, shape-gated, and precedes tag introspection', function () {
    var writeIdx  = ENGINE_SRC.indexOf('error.fields[fieldName] = errorMessage;');
    var guardIdx  = ENGINE_SRC.indexOf('STACK_SHAPE_RE.test(error.fields[fieldName])', writeIdx);
    var scopeIdx  = ENGINE_SRC.indexOf('!_scopeIsLocal()', writeIdx);
    var tagIdx    = ENGINE_SRC.indexOf('var bundleName', writeIdx);
    assert.ok(writeIdx >= 0, 'expected the fields-slot write');
    assert.ok(guardIdx > writeIdx, 'the shape-gated strip must follow the write');
    assert.ok(scopeIdx > writeIdx && scopeIdx < tagIdx, 'the strip must be scope-gated and precede tag introspection');
    // scope is read at call time from the canonical env var, fail-closed
    assert.ok(/function _scopeIsLocal\(\)/.test(ENGINE_SRC), 'expected the _scopeIsLocal helper');
    assert.ok(/NODE_SCOPE_IS_LOCAL/.test(ENGINE_SRC), 'the helper must read NODE_SCOPE_IS_LOCAL');
    // the catch-branch root stack is scope-gated too
    var catchStackIdx = ENGINE_SRC.indexOf('error.stack = err.stack;');
    var catchGuardIdx = ENGINE_SRC.lastIndexOf('if ( _scopeIsLocal() ) {', catchStackIdx);
    assert.ok(catchStackIdx >= 0 && catchGuardIdx >= 0 && catchGuardIdx < catchStackIdx,
              'the catch-branch error.stack assignment must be scope-gated');
});
