'use strict';

/**
 * Runtime parity for the published TypeScript declarations (#DTO3b — Half B).
 *
 * A `tsc --noEmit` pass proves the declarations are well-FORMED, never that
 * they are TRUE: a declaration file can compile with zero errors while
 * declaring members the runtime does not have (a consumer then typechecks
 * and crashes) or omitting members it does have. This test reflects the
 * REAL runtime and diffs it against the declarations, two-way, so neither
 * class of lie can ship:
 *
 *   §02  `types/index.d.ts` namespace value members  ⟷  `gna.<X> =` assignments
 *   §03  `GinaLib` interface                          ⟷  Object.keys(framework lib registry)
 *   §04  `SuperController` interface                  ⟷  createTestInstance() members
 *   §05  `declare global` block                       ⟷  globals injected by the helpers bootstrap
 *   §06  negative pins (the fixed lies stay fixed)
 *   §07  prototype augmentations (real ones declared, fictional ones gone)
 *
 * §01 validates every parser/enumerator this file relies on by proving it
 * finds symbols it MUST find — an instrument that cannot fire is not an
 * instrument (a line-anchored variant of the §02 enumeration once reported
 * 22 real members as absent).
 *
 * Deliberate exceptions are declared inline, each with its reason — an
 * exception without a reason is a lie waiting to rot.
 *
 * Run with:
 *   node --test test/lib/types-runtime-parity.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var REPO_ROOT = path.resolve(__dirname, '../..');
var FW        = require('../fw');

var INDEX_DTS   = path.join(REPO_ROOT, 'types', 'index.d.ts');
var GLOBALS_DTS = path.join(REPO_ROOT, 'types', 'globals.d.ts');
var CORE_GNA    = path.join(FW, 'core', 'gna.js');
var MODEL_SRC   = path.join(FW, 'lib', 'model.js');

var indexSrc   = fs.readFileSync(INDEX_DTS, 'utf8');
var globalsSrc = fs.readFileSync(GLOBALS_DTS, 'utf8');
var gnaSrc     = fs.readFileSync(CORE_GNA, 'utf8');
var modelSrc   = fs.readFileSync(MODEL_SRC, 'utf8');

// ---------------------------------------------------------------------------
// Runtime bootstrap — capture the injected-globals diff BEFORE any framework
// require, then load the same surfaces the declarations describe.
// ---------------------------------------------------------------------------

var beforeGlobals = new Set(Object.getOwnPropertyNames(globalThis));

process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(FW + '/helpers');

var injectedGlobals = new Set(
    Object.getOwnPropertyNames(globalThis).filter(function (n) { return !beforeGlobals.has(n); })
);

setPath('gina', { core: FW + '/core' });
var SuperController = require(FW + '/core/controller/controller.js');
var scInstance = SuperController.createTestInstance({
    req: { headers: {} },
    res: { statusCode: 200 },
    next: function () {},
    options: { conf: { content: { routing: {} } } }
});

var libRegistry = require(FW + '/lib');

var EventEmitter = require('events').EventEmitter;
var EE_PROTO_METHODS = new Set(
    Object.getOwnPropertyNames(EventEmitter.prototype).filter(function (n) {
        return n !== 'constructor' && n.charAt(0) !== '_';
    })
);

// ---------------------------------------------------------------------------
// Declaration parsers.
// ---------------------------------------------------------------------------

/** Brace-walked body of the block opening at `src.indexOf(header)`. */
function blockBody(src, header) {
    var start = src.indexOf(header);
    assert.ok(start !== -1, 'block header not found: ' + header);
    var i = src.indexOf('{', start);
    var depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) { return src.slice(src.indexOf('{', start) + 1, i); }
        }
    }
    assert.fail('unbalanced braces after: ' + header);
}

/**
 * Namespace VALUE members of index.d.ts — `const <name>:` / `function <name>(`
 * at 4-space indent (the layout contract stated in the file header).
 */
function namespaceValueMembers() {
    var body = blockBody(indexSrc, 'declare namespace gina {');
    var names = new Set();
    var rx = /^    (?:const|function) ([A-Za-z_$][\w$]*)/gm;
    var m;
    while ((m = rx.exec(body)) !== null) { names.add(m[1]); }
    return names;
}

/** Member names of an interface block at 8-space indent (overloads dedupe). */
function interfaceMembers(header) {
    var body = blockBody(indexSrc, header);
    var names = new Set();
    var rx = /^ {8}(?:readonly )?(?:new )?([A-Za-z_$][\w$]*)\??\s*[:(<]/gm;
    var m;
    while ((m = rx.exec(body)) !== null) { names.add(m[1]); }
    return names;
}

/**
 * The UNANCHORED `gna.<name> =` enumeration over core/gna.js. Anchor-free is
 * load-bearing: lifecycle members are assigned INDENTED inside a boot
 * callback, and a line-anchored pattern reports them absent.
 */
function gnaRuntimeMembers() {
    var names = new Set();
    var rx = /^\s*gna\.([A-Za-z_$][\w$]*)\s*=/gm;
    var m;
    while ((m = rx.exec(gnaSrc)) !== null) { names.add(m[1]); }
    // `gna = { core: {}, os: {} }` seeds two structural sub-objects in the
    // object literal (never via `gna.X =`), deliberately undocumented —
    // internal scaffolding, not API. The declarations track the assignment
    // surface only.
    return names;
}

/** Declared globals — the same parser the generator uses (shared instrument). */
var readDeclaredGlobals = require(path.join(REPO_ROOT, 'script', 'generate_gna_types.js')).readDeclaredGlobals;

/** Instance member names: own + prototype chain, minus Object.prototype. */
function instanceMembers(inst, functionsOnly) {
    var names = new Set();
    var o = inst;
    while (o && o !== Object.prototype) {
        Object.getOwnPropertyNames(o).forEach(function (n) {
            if (n === 'constructor' || n.charAt(0) === '_') { return; }
            var isFn = false;
            try { isFn = (typeof inst[n] === 'function'); } catch (e) { /* getter throw */ }
            if (!functionsOnly || isFn) { names.add(n); }
        });
        o = Object.getPrototypeOf(o);
    }
    return names;
}

function setDiff(a, b) {
    return Array.from(a).filter(function (x) { return !b.has(x); }).sort();
}

// ---------------------------------------------------------------------------

describe('01 - instrument validation (every parser/enumerator can fire)', function () {

    it('unanchored gna enumeration sees the INDENTED lifecycle members', function () {
        var names = gnaRuntimeMembers();
        ['onInitialize', 'onStarted', 'onRouting', 'onError',
         'start', 'stop', 'restart', 'status', 'getConfig', 'getVersion'].forEach(function (n) {
            assert.ok(names.has(n), 'enumeration missed indented member: ' + n);
        });
        assert.ok(names.size >= 75, 'enumeration suspiciously small: ' + names.size);
    });

    it('namespace-member parser fires', function () {
        var names = namespaceValueMembers();
        ['dto', 'lib', 'onInitialize', 'merge', 'emit'].forEach(function (n) {
            assert.ok(names.has(n), 'namespace parser missed: ' + n);
        });
        assert.ok(names.size >= 75, 'namespace parser suspiciously small: ' + names.size);
    });

    it('SuperController interface parser fires', function () {
        var names = interfaceMembers('interface SuperController extends EventEmitter {');
        ['render', 'renderJSON', 't', 'sendTrailers', 'query', 'cache'].forEach(function (n) {
            assert.ok(names.has(n), 'interface parser missed: ' + n);
        });
        assert.ok(names.size >= 40, 'interface parser suspiciously small: ' + names.size);
    });

    it('GinaLib interface parser fires', function () {
        var names = interfaceMembers('interface GinaLib {');
        ['dto', 'uuid', 'routing', 'merge'].forEach(function (n) {
            assert.ok(names.has(n), 'GinaLib parser missed: ' + n);
        });
        assert.ok(names.size >= 45, 'GinaLib parser suspiciously small: ' + names.size);
    });

    it('declared-globals parser (shared with the generator) fires', function () {
        var declared = readDeclaredGlobals();
        ['_', 'merge', 'ApiError', '__stack', 'nestBracketNotationKey'].forEach(function (n) {
            assert.ok(declared.has(n), 'globals parser missed: ' + n);
        });
        assert.ok(declared.size >= 45, 'globals parser suspiciously small: ' + declared.size);
    });

    it('runtime instance enumeration fires', function () {
        var fns = instanceMembers(scInstance, true);
        ['render', 't', 'sendTrailers', 'startJob'].forEach(function (n) {
            assert.ok(fns.has(n), 'instance enumeration missed: ' + n);
        });
        assert.ok(fns.size >= 55, 'instance enumeration suspiciously small: ' + fns.size);
    });
});

describe('02 - Gna namespace members mirror the runtime assignment surface', function () {

    it('declared === runtime (two-way)', function () {
        var declared = namespaceValueMembers();
        var runtime  = gnaRuntimeMembers();

        assert.deepEqual(setDiff(declared, runtime), [],
            'DECLARED but never assigned at runtime (phantom members — a consumer would typecheck then crash)');
        assert.deepEqual(setDiff(runtime, declared), [],
            'ASSIGNED at runtime but undeclared (missing members — valid consumer code fails to typecheck)');
    });
});

describe('03 - GinaLib mirrors the framework lib registry', function () {

    it('declared === Object.keys(require(framework/lib)) (two-way)', function () {
        var declared = interfaceMembers('interface GinaLib {');
        var runtime  = new Set(Object.keys(libRegistry));

        assert.deepEqual(setDiff(declared, runtime), [],
            'DECLARED in GinaLib but absent from the lib registry');
        assert.deepEqual(setDiff(runtime, declared), [],
            'IN the lib registry but undeclared in GinaLib');
    });
});

describe('04 - SuperController interface mirrors a real instance', function () {

    it('every runtime method is declared (or inherited from EventEmitter)', function () {
        var declared = interfaceMembers('interface SuperController extends EventEmitter {');
        var runtimeFns = instanceMembers(scInstance, true);

        var missing = Array.from(runtimeFns).filter(function (n) {
            return !declared.has(n) && !EE_PROTO_METHODS.has(n);
        }).sort();
        assert.deepEqual(missing, [],
            'REAL instance methods missing from the SuperController interface');
    });

    it('every declared member exists on a real instance (isProcessingError excepted)', function () {
        var declared = interfaceMembers('interface SuperController extends EventEmitter {');
        var runtimeAll = instanceMembers(scInstance, false);

        // isProcessingError is assigned only once query()/throwError() has
        // run — absent on a fresh instance BY DESIGN, so it must be declared
        // optional (asserted below) and is exempt from the presence check.
        var phantom = Array.from(declared).filter(function (n) {
            return !runtimeAll.has(n) && n !== 'isProcessingError';
        }).sort();
        assert.deepEqual(phantom, [],
            'DECLARED members absent from a real instance (a consumer would typecheck then crash)');
    });

    it('isProcessingError is declared OPTIONAL', function () {
        assert.match(indexSrc, /isProcessingError\?:/,
            'isProcessingError must stay optional — it does not exist on a fresh instance');
    });

    it('the instance really is an EventEmitter (the interface may extend it)', function () {
        assert.ok(scInstance instanceof EventEmitter);
    });
});

describe('05 - declare-global block mirrors the injected globals', function () {

    // Injected at MODEL-LAYER init (sloppy-mode assignments in lib/model.js),
    // not by the bare helpers bootstrap — declared, with the injection site
    // source-pinned so this exception cannot rot into fiction.
    var MODEL_INIT_GLOBALS = new Set(['getModel', 'getModelEntity']);

    // Injected by the bootstrap but deliberately NOT declared:
    var ALLOWED_UNDECLARED = {
        // Already declared by @types/node with the same type; re-declaring
        // adds duplicate-identifier risk for zero value.
        __filename: true
    };

    it('every declared global is really injected (or source-pinned to model init)', function () {
        var declared = readDeclaredGlobals();
        var phantom = Array.from(declared).filter(function (n) {
            return !injectedGlobals.has(n) && !MODEL_INIT_GLOBALS.has(n);
        }).sort();
        assert.deepEqual(phantom, [],
            'DECLARED globals the framework never injects (fiction — the ltrim class of lie)');
    });

    it('model-init exception globals have live injection sites in lib/model.js', function () {
        assert.match(modelSrc, /^\s*getModel = function/m,
            'getModel injection site gone from lib/model.js — retire the exception');
        assert.match(modelSrc, /^\s*getModelEntity = function/m,
            'getModelEntity injection site gone from lib/model.js — retire the exception');
    });

    it('every injected global is declared (or allowlisted with a reason)', function () {
        var declared = readDeclaredGlobals();
        var undeclared = Array.from(injectedGlobals).filter(function (n) {
            return !declared.has(n) && !ALLOWED_UNDECLARED[n];
        }).sort();
        assert.deepEqual(undeclared, [],
            'INJECTED globals missing from declare global (valid consumer code fails to typecheck)');
    });
});

describe('06 - negative pins: the fixed lies stay fixed', function () {

    it('D1: the module declares a value (export = gina)', function () {
        assert.match(indexSrc, /^export = gina;/m);
    });

    it('D3: no ambient class declarations for SuperController / EntitySuper', function () {
        assert.doesNotMatch(indexSrc, /\bclass\s+(SuperController|EntitySuper)\b/,
            'the main entry must not declare constructor VALUES it does not export');
    });

    it('D4: the namespace declares no EventEmitter method members', function () {
        var declared = namespaceValueMembers();
        ['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners',
         'listeners', 'eventNames', 'setMaxListeners'].forEach(function (n) {
            assert.ok(!declared.has(n),
                'gina.' + n + ' declared — the runtime module object is a plain object literal, not an EventEmitter');
        });
        // `emit` alone IS assigned at runtime (an inert stub since #B109 —
        // always false, never dispatches) — it stays declared for parity,
        // with its warning JSDoc.
        assert.ok(declared.has('emit'));
    });

    it('D5: the fictional String prototype methods are gone from the declarations', function () {
        var stringBlockGone = ['ltrim', 'rtrim', 'gtrim'].every(function (n) {
            return globalsSrc.indexOf(n) === -1;
        });
        assert.ok(stringBlockGone, 'ltrim/rtrim/gtrim resurfaced in globals.d.ts');
    });

    it('D6: setPath accepts the object form', function () {
        assert.match(globalsSrc, /function setPath\(name: string, path: string \| object\): void;/);
    });
});

describe('07 - prototype augmentations: real ones declared, fictional ones absent', function () {

    it('Array.prototype.clone is real AND declared', function () {
        assert.equal(typeof Array.prototype.clone, 'function');
        assert.match(globalsSrc, /interface Array<T> \{\s*\n\s*clone\(\): T\[\];/);
    });

    it('String.prototype.ltrim/rtrim/gtrim do not exist at runtime (D5 evidence)', function () {
        assert.equal(typeof String.prototype.ltrim, 'undefined');
        assert.equal(typeof String.prototype.rtrim, 'undefined');
        assert.equal(typeof String.prototype.gtrim, 'undefined');
    });

    it('D2: JSON.clone/escape are real AND the JSON interface sits INSIDE declare global', function () {
        assert.equal(typeof JSON.clone, 'function');
        assert.equal(typeof JSON.escape, 'function');
        var globalBlock = blockBody(globalsSrc, 'declare global {');
        assert.ok(globalBlock.indexOf('interface JSON {') !== -1,
            'the JSON augmentation must live INSIDE declare global — at module scope it silently never merges');
    });
});
