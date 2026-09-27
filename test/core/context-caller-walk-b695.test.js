'use strict';
/**
 * #B695 — a `getConfig()` / `getLib()` call that names no bundle no longer walks the call stack,
 * and the walk that remains can no longer throw.
 *
 * `helpers/context.js`'s two resolvers located "the calling bundle" by reading `__stack` (one full
 * V8 stack capture per read) frame by frame, skipping every frame whose file sits under
 * `node_modules`, then calling `.replace` on the first remaining file name. The walk ran for EVERY
 * call shape, although `getConfig()` and `getConfig(confName)` never use its result: the bundle is
 * then the running one, `ctx.bundle`. Under an npm install every framework file sits under
 * `…/node_modules/gina/`, so a call made from framework code found no such frame and threw a
 * TypeError at `file.replace`. In a repository checkout the first frame qualifies, which is why no
 * suite run ever saw it. The per-request swig settings read in `core/controller/controller.js` made
 * that call inside a `try` whose catch set `autoescape` to false: on an npm install,
 * `settings.swig.autoescape: true` was silently ignored, and every templated request paid nine stack
 * captures and a thrown TypeError.
 *
 * After the fix, the walk runs only for the shapes that consume its result (a falsy bundle with a
 * `confName`, and `getLib(lib)`), it captures the stack ONCE (`callerFileSegments(__stack)`), and a
 * stack without a qualifying frame yields `[]`, the resolver's ordinary no-match path. The render
 * site reads the request's own conf, `local.options.conf.content.settings.swig`.
 *
 *   §01 source pins on `helpers/context.js`, comment-stripped (the replace-code convention keeps the
 *       old walk as `// #B695 — was:` records), with a RAW control that the records are there.
 *   §02 the SHIPPED resolver prologues and helper, extracted from the source and run under
 *       `new Function` + `with (scope)`: the scope injects a counting `__stack`, `ctx`, and `index`,
 *       which the prologue assigns without `var`. A frozen VERBATIM copy of each pre-fix prologue
 *       (`helpers/context.js` at v0.7.0, blob 96a84b60, lines 475-509 and 605-649) runs through the
 *       same harness first and must reproduce the KNOWN defect (nine reads, then the TypeError)
 *       before any post-fix reading counts. One arm reads REAL CallSites through the real `__stack`
 *       getter (`utils/prototypes.js`): the check that the fake frames model the real ones.
 *   §03 controller pins: the render site no longer calls the global `getConfig()`.
 *
 * The install-shaped boot, which checks the real escaping from a copy of the tree placed under
 * `…/node_modules/gina`, is a step of `.github/workflows/test.yml`: it runs
 * `test/integration/container-boot-swig-autoescape.test.js` through its `B359_GINA_ROOT` seam.
 *
 * Red-first, against the release that carries the defect:
 *   git show v0.7.0:framework/v0.7.0/helpers/context.js            > /tmp/ctx-070.js
 *   git show v0.7.0:framework/v0.7.0/core/controller/controller.js > /tmp/ctrl-070.js
 *   GINA_CONTEXT_SRC=/tmp/ctx-070.js GINA_CONTROLLER_SRC=/tmp/ctrl-070.js \
 *     node --test test/core/context-caller-walk-b695.test.js
 * Every post-fix pin and arm goes red; the arms labelled CONTROL stay green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = require('../fw');
var CTX_SOURCE  = process.env.GINA_CONTEXT_SRC    || path.join(FW, 'helpers/context.js');
var CTRL_SOURCE = process.env.GINA_CONTROLLER_SRC || path.join(FW, 'core/controller/controller.js');
var CTX_SRC     = fs.readFileSync(CTX_SOURCE, 'utf8');
var CTRL_SRC    = fs.readFileSync(CTRL_SOURCE, 'utf8');
var PROTO_SRC   = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'prototypes.js'), 'utf8');

var GETCONFIG_DECL = 'getConfig = function(bundle, confName) {';
var GETLIB_DECL    = 'getLib = function(bundle, lib) {';
var PROLOGUE       = 'if (arguments.length == 1 || !bundle) {';
var HELPER_DECL    = 'var callerFileSegments = function(stack) {';
var OLD_RENDER_READ = 'getConfig()[local.options.conf.bundle][local.options.conf.env].content.settings.swig';


// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/** Drops every line that starts with `//`, `*` or `/*` (the swig-autoescape.test.js strip). */
function stripComments(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

function count(hay, needle) {
    return hay.split(needle).length - 1;
}

function between(src, startMarker, endMarker) {
    var start = src.indexOf(startMarker);
    assert.ok(start > -1, 'marker present: ' + startMarker);
    assert.equal(src.indexOf(startMarker, start + 1), -1, 'marker unique: ' + startMarker);
    var end = src.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, 'end marker follows ' + startMarker + ': ' + endMarker);
    return src.slice(start, end);
}

// The resolution test's slices (context-config-resolution.test.js), comment-stripped.
function getConfigActive() { return stripComments(between(CTX_SRC, GETCONFIG_DECL, GETLIB_DECL)); }
function getLibActive()    { return stripComments(between(CTX_SRC, GETLIB_DECL, 'Whisper')); }

/**
 * Brace walk with the started flag: from the anchor at depth 0 to the brace that closes the first
 * one opened. Callers pass comment-stripped text: the was-records carry lone braces.
 */
function bracedFrom(src, anchor) {
    var at = src.indexOf(anchor);
    assert.ok(at > -1, 'anchor present: ' + anchor);
    assert.equal(src.indexOf(anchor, at + 1), -1, 'anchor unique in its slice: ' + anchor);
    var depth = 0, started = false;
    for (var i = at; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') {
            depth--;
            if (started && depth === 0) { return src.slice(at, i + 1); }
        }
    }
    assert.fail('braces never balance after: ' + anchor);
}

function getConfigPrologue() { return bracedFrom(getConfigActive(), PROLOGUE); }
function getLibPrologue()    { return bracedFrom(getLibActive(), PROLOGUE); }

/** The shipped helper, compiled from the file under test; `null` when the file predates it. */
function loadHelper() {
    var active = stripComments(CTX_SRC);
    if (active.indexOf(HELPER_DECL) < 0) { return null; }
    var fnSrc = bracedFrom(active, HELPER_DECL).replace(/^var callerFileSegments = /, '');
    return new Function('return (' + fnSrc + ');')();
}
function requireHelper() {
    var h = loadHelper();
    assert.ok(h, 'helpers/context.js declares `' + HELPER_DECL + '`');
    return h;
}

/**
 * Compiles a resolver prologue as `function (<params>) { <prologue> return {…}; }` inside
 * `with (scope)`: every free identifier it reads (`__stack`, `ctx`, `index`,
 * `callerFileSegments`) resolves on `scope`. Function-constructor code is sloppy, so `with` is
 * legal, and `index = …` (no `var`, as shipped) lands on `scope.index`.
 */
function compilePrologue(prologue, params) {
    var ret = params.split(/\s*,\s*/).map(function (n) { return n + ': ' + n; }).join(', ');
    return new Function('scope',
        'with (scope) { return function (' + params + ') {\n' + prologue + '\nreturn { ' + ret + ' };\n}; }');
}

/** Fake CallSites: only `getFileName()` is read. */
function callSites(files) {
    return files.map(function (f) {
        return (f && typeof f === 'object') ? f : { getFileName: function () { return f; } };
    });
}

/** A scope whose `__stack` counts its reads and returns the given frames. */
function makeScope(files, ctx, helper) {
    var reads = 0;
    var stack = callSites(files);
    var scope = { ctx: ctx, index: undefined, callerFileSegments: helper };
    Object.defineProperty(scope, '__stack', { get: function () { reads++; return stack; } });
    return { scope: scope, reads: function () { return reads; } };
}

function run(prologue, params, files, ctx, args) {
    var s = makeScope(files, ctx, loadHelper());
    var fn = compilePrologue(prologue, params)(s.scope);
    var out = { threw: null, result: null };
    try { out.result = fn.apply(null, args); } catch (e) { out.threw = e; }
    out.reads = s.reads();
    out.ctx = ctx;
    return out;
}

function noThrow(out) {
    assert.equal(out.threw, null, 'must not throw, threw: ' + (out.threw && out.threw.message));
}


// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

// An npm install: every framework file under node_modules. Index 0 is the resolver itself; the
// rest is the measured shape of the per-request call (controller, router, server, gna, …).
// Ten frames: Error.stackTraceLimit's default.
var NM = '/usr/local/lib/node_modules/gina/framework/v0.7.1/';
var NM_FRAMES = [
    NM + 'helpers/context.js',
    NM + 'core/controller/controller.js',
    NM + 'core/router.js',
    NM + 'core/server.js',
    NM + 'core/gna.js',
    NM + 'core/server.js',
    NM + 'core/server.js',
    NM + 'core/gna.js',
    NM + 'core/server.js',
    NM + 'core/server.isaac.js'
];
var NM_SHORT = NM_FRAMES.slice(0, 3);

// A bundle file of the project (bundle `api`), reached through one framework frame.
var PROJECT_FILE = '/srv/shop/src/api/controllers/controller.js';
var PROJECT_SEGMENTS = ['', 'srv', 'shop', 'src', 'api', 'controllers', 'controller'];
var FROM_PROJECT = [NM_FRAMES[0], NM_FRAMES[1], PROJECT_FILE].concat(NM_FRAMES.slice(3));

// A repository checkout: no framework path contains node_modules.
var CO = '/home/dev/gina/framework/v0.7.1/';
var CHECKOUT_FRAMES = NM_FRAMES.map(function (f) { return f.replace(NM, CO); });

function ctxFixture() { return { bundle: 'web', bundles: ['api', 'web'] }; }


// ---------------------------------------------------------------------------
// Frozen VERBATIM pre-fix prologues — helpers/context.js at v0.7.0 (blob 96a84b60),
// lines 475-509 (getConfig) and 605-649 (getLib). The harness's instrument check.
// ---------------------------------------------------------------------------

var PRE_FIX_GETCONFIG = [
"        if (arguments.length == 1 || !bundle) {",
"",
"            confName = (arguments.length == 1) ? bundle : confName;",
"            var file = null",
"                , stackFileName = null;",
"",
"            for (let i = 1, len = 10; i < len; ++i) {",
"                stackFileName = __stack[i].getFileName();",
"                if (stackFileName && !/node_modules/.test(stackFileName)) {",
"                    file = stackFileName;",
"                    break;",
"                }",
"            }",
"            var a = file.replace('.js', '').split('/')",
"                , i = a.length - 1;",
"",
"            if (bundle == confName) {",
"                bundle = ctx.bundle",
"            } else {",
"",
"                if (ctx.bundles) {",
"                    for (; i >= 0; --i) {",
"                        index = ctx.bundles.indexOf(a[i]);",
"                        if (index > -1) {",
"                            ctx.bundle = bundle = ctx.bundles[index];",
"",
"                            break",
"                        }",
"                    }",
"                } else if (ctx.bundle) {",
"                    bundle = ctx.bundle",
"                }",
"",
"            }",
"        }"
].join('\n');

var PRE_FIX_GETLIB = [
"        if (arguments.length == 1 || !bundle) {",
"            //console.debug(",
"            //    '\\n[ 0 ] = '+ __stack[0].getFileName(),",
"            //    '\\n[ 1 ] = '+ __stack[1].getFileName(),",
"            //    '\\n[ 2 ] = '+ __stack[2].getFileName(),",
"            //    '\\n[ 3 ] = '+ __stack[3].getFileName(),",
"            //    '\\n[ 4 ] = '+ __stack[4].getFileName(),",
"            //    '\\n[ 5 ] = '+ __stack[5].getFileName(),",
"            //    '\\n[ 6 ] = '+ __stack[6].getFileName()",
"            //);",
"             lib    = (arguments.length == 1) ? bundle : lib;",
"             bundle = null;",
"             var file          = null",
"                , stackFileName = null",
"                //, file        = ( !/node_modules/.test(__stack[1].getFileName()) ) ?  __stack[1].getFileName() : __stack[2].getFileName()",
"            ;",
"            for (let i = 1, len = 10; i<len; ++i) {",
"                stackFileName = __stack[i].getFileName();",
"                if ( stackFileName && !/node_modules/.test(stackFileName) ) {",
"                    file = stackFileName;",
"                    break;",
"                }",
"            }",
"            var a           = file.replace('.js', '').split('/')",
"                , i         = a.length-1;",
"",
"            if (bundle == lib) {",
"                bundle = ctx.bundle",
"            } else {",
"",
"                if (ctx.bundles) {",
"                    for (; i >= 0; --i) {",
"                        index = ctx.bundles.indexOf(a[i]);",
"                        if ( index > -1 ) {",
"                            ctx.bundle = bundle = ctx.bundles[index];",
"",
"                            break",
"                        }",
"                    }",
"                } else if (ctx.bundle) {",
"                    bundle = ctx.bundle",
"                }",
"",
"            }",
"        }"
].join('\n');


// ---------------------------------------------------------------------------
// 00 - instruments
// ---------------------------------------------------------------------------
describe('00 - instruments', function () {

    it('CONTROL — stripComments drops comment lines and keeps active code', function () {
        var out = stripComments('active(1);\n    // was: dead(2);\n/* block */\n * jsdoc line\nkeep(3);');
        assert.ok(out.indexOf('active(1)') > -1 && out.indexOf('keep(3)') > -1, 'active code kept');
        assert.ok(out.indexOf('dead(2)') < 0 && out.indexOf('block') < 0 && out.indexOf('jsdoc') < 0, 'comments dropped');
    });

    it('CONTROL — bracedFrom returns the whole nested block and refuses an unbalanced one', function () {
        assert.equal(bracedFrom('x; if (a) { b({ c: 1 }); } tail;', 'if (a) {'), 'if (a) { b({ c: 1 }); }');
        assert.throws(function () { bracedFrom('if (a) { b(', 'if (a) {'); }, /never balance/);
    });

    it('CONTROL — each resolver slice carries exactly one prologue, and it extracts', function () {
        assert.equal(count(getConfigActive(), PROLOGUE), 1, 'one prologue in getConfig');
        assert.equal(count(getLibActive(), PROLOGUE), 1, 'one prologue in getLib');
        assert.ok(/^if \(arguments\.length == 1 \|\| !bundle\) \{[\s\S]*\}$/.test(getConfigPrologue()));
        assert.ok(/^if \(arguments\.length == 1 \|\| !bundle\) \{[\s\S]*\}$/.test(getLibPrologue()));
    });
});


// ---------------------------------------------------------------------------
// 01 - helpers/context.js source pins
// ---------------------------------------------------------------------------
describe('01 - helpers/context.js source pins', function () {

    it('CONTROL — the raw source still carries the old walk, as `// #B695 — was:` records', function () {
        var raw = between(CTX_SRC, GETCONFIG_DECL, 'Whisper');
        assert.ok(count(raw, "file.replace('.js', '')") >= 2, 'the old `file.replace` line is in the raw source for both resolvers');
    });

    it('getConfig: no indexed `__stack[` read is left in active code (the per-frame loop is gone)', function () {
        assert.equal(count(getConfigActive(), '__stack['), 0);
    });

    it('getConfig: exactly one active `__stack` read, passed to callerFileSegments', function () {
        var a = getConfigActive();
        assert.equal(count(a, '__stack'), 1, 'one __stack read');
        assert.equal(count(a, 'callerFileSegments(__stack)'), 1, 'read as the helper argument');
    });

    it('getConfig: that read sits in the branch that consumes it (after `bundle == confName`, under `ctx.bundles`)', function () {
        var a = getConfigActive();
        var branch = a.indexOf('if (bundle == confName) {');
        var bundles = a.indexOf('if (ctx.bundles) {');
        var read = a.indexOf('__stack');
        assert.ok(branch > -1 && bundles > branch, 'the branch order is intact');
        assert.ok(read > bundles, 'the stack is read inside `if (ctx.bundles)`, after the no-bundle branch');
    });

    it('getConfig: `file.replace` is gone from active code', function () {
        assert.equal(count(getConfigActive(), 'file.replace'), 0);
    });

    it('getLib: no indexed `__stack[` read is left in active code', function () {
        assert.equal(count(getLibActive(), '__stack['), 0);
    });

    it('getLib: exactly one active `__stack` read, passed to callerFileSegments', function () {
        var a = getLibActive();
        assert.equal(count(a, '__stack'), 1, 'one __stack read');
        assert.equal(count(a, 'callerFileSegments(__stack)'), 1, 'read as the helper argument');
    });

    it('getLib: that read sits in the branch that consumes it (after `bundle == lib`, under `ctx.bundles`)', function () {
        var a = getLibActive();
        var branch = a.indexOf('if (bundle == lib) {');
        var bundles = a.indexOf('if (ctx.bundles) {');
        var read = a.indexOf('__stack');
        assert.ok(branch > -1 && bundles > branch, 'the branch order is intact');
        assert.ok(read > bundles, 'the stack is read inside `if (ctx.bundles)`, after the no-bundle branch');
    });

    it('getLib: `file.replace` is gone from active code', function () {
        assert.equal(count(getLibActive(), 'file.replace'), 0);
    });

    it('the helper is declared once, guards the stack and each frame, and returns [] when nothing qualifies', function () {
        var active = stripComments(CTX_SRC);
        assert.equal(count(active, HELPER_DECL), 1, 'declared once');
        var body = bracedFrom(active, HELPER_DECL);
        assert.ok(body.indexOf('( stack && stack[i] )') > -1, 'a missing stack or frame is guarded');
        assert.ok(body.indexOf('!/node_modules/.test(stackFileName)') > -1, 'frames under node_modules are skipped');
        assert.ok(/return \[\];\s*\}$/.test(body), 'the fall-through returns []');
    });
});


// ---------------------------------------------------------------------------
// 02 - the extracted resolver prologues, run
// ---------------------------------------------------------------------------
describe('02 - the extracted resolver prologues, run', function () {

    describe('02a - the harness reproduces the known pre-fix behaviour (frozen v0.7.0 prologues)', function () {

        it('CONTROL — getConfig(), npm-install frames: nine stack reads, then a TypeError at `file.replace`', function () {
            var out = run(PRE_FIX_GETCONFIG, 'bundle, confName', NM_FRAMES, ctxFixture(), []);
            assert.ok(out.threw instanceof TypeError, 'threw a TypeError');
            assert.match(out.threw.message, /reading 'replace'/);
            assert.equal(out.reads, 9);
        });

        it('CONTROL — getLib(lib), npm-install frames: nine stack reads, then the same TypeError', function () {
            var out = run(PRE_FIX_GETLIB, 'bundle, lib', NM_FRAMES, ctxFixture(), ['x']);
            assert.ok(out.threw instanceof TypeError, 'threw a TypeError');
            assert.match(out.threw.message, /reading 'replace'/);
            assert.equal(out.reads, 9);
        });

        it('CONTROL — a stack shorter than ten frames threw earlier, at `__stack[i].getFileName`', function () {
            var out = run(PRE_FIX_GETCONFIG, 'bundle, confName', NM_SHORT, ctxFixture(), [null, 'app']);
            assert.ok(out.threw instanceof TypeError, 'threw a TypeError');
            assert.match(out.threw.message, /reading 'getFileName'/);
            assert.equal(out.reads, 3);
        });

        it('CONTROL — a checkout-shaped stack read once and did not throw: why no suite run saw it', function () {
            var out = run(PRE_FIX_GETCONFIG, 'bundle, confName', CHECKOUT_FRAMES, ctxFixture(), []);
            noThrow(out);
            assert.equal(out.reads, 1);
            assert.equal(out.result.bundle, 'web');
        });
    });

    describe('02b - getConfig, the shipped prologue', function () {

        it('getConfig() reads no stack and resolves the running bundle, even when every frame is under node_modules', function () {
            var out = run(getConfigPrologue(), 'bundle, confName', NM_FRAMES, ctxFixture(), []);
            noThrow(out);
            assert.equal(out.reads, 0, 'no stack read');
            assert.equal(out.result.bundle, 'web');
            assert.equal(out.ctx.bundle, 'web', 'ctx.bundle untouched');
        });

        it('getConfig(confName) reads no stack either, and keeps the confName', function () {
            var out = run(getConfigPrologue(), 'bundle, confName', NM_FRAMES, ctxFixture(), ['app']);
            noThrow(out);
            assert.equal(out.reads, 0, 'no stack read');
            assert.equal(out.result.bundle, 'web');
            assert.equal(out.result.confName, 'app');
        });

        it('a checkout-shaped stack: getConfig() reads nothing (the walk was pure cost there)', function () {
            var out = run(getConfigPrologue(), 'bundle, confName', CHECKOUT_FRAMES, ctxFixture(), []);
            noThrow(out);
            assert.equal(out.reads, 0);
            assert.equal(out.result.bundle, 'web');
        });

        it('getConfig(<falsy>, confName) reads the stack ONCE and resolves the calling file\'s bundle', function () {
            var out = run(getConfigPrologue(), 'bundle, confName', FROM_PROJECT, ctxFixture(), [null, 'app']);
            noThrow(out);
            assert.equal(out.reads, 1, 'one capture, not one per frame examined');
            assert.equal(out.result.bundle, 'api');
            assert.equal(out.ctx.bundle, 'api', 'recorded on ctx, as before');
            assert.equal(out.result.confName, 'app');
        });

        it('getConfig(<falsy>, confName), every frame under node_modules: no throw, the no-match path', function () {
            var out = run(getConfigPrologue(), 'bundle, confName', NM_FRAMES, ctxFixture(), [null, 'app']);
            noThrow(out);
            assert.equal(out.reads, 1);
            assert.equal(out.result.bundle, null, 'no bundle resolves');
            assert.equal(out.ctx.bundle, 'web', 'ctx.bundle untouched');
        });

        it('getConfig(<falsy>, confName), a stack shorter than ten frames: no throw', function () {
            var out = run(getConfigPrologue(), 'bundle, confName', NM_SHORT, ctxFixture(), [null, 'app']);
            noThrow(out);
            assert.equal(out.reads, 1);
            assert.equal(out.result.bundle, null);
        });

        it('getConfig(<falsy>, confName) without ctx.bundles reads no stack and falls back to ctx.bundle', function () {
            var out = run(getConfigPrologue(), 'bundle, confName', NM_FRAMES, { bundle: 'web' }, [null, 'app']);
            noThrow(out);
            assert.equal(out.reads, 0);
            assert.equal(out.result.bundle, 'web');
        });
    });

    describe('02c - getLib, the shipped prologue', function () {

        it('getLib(lib) reads the stack ONCE and resolves the calling file\'s bundle', function () {
            var out = run(getLibPrologue(), 'bundle, lib', FROM_PROJECT, ctxFixture(), ['x']);
            noThrow(out);
            assert.equal(out.reads, 1, 'one capture, not one per frame examined');
            assert.equal(out.result.bundle, 'api');
            assert.equal(out.result.lib, 'x');
        });

        it('getLib(lib), every frame under node_modules: no throw, the no-match path', function () {
            var out = run(getLibPrologue(), 'bundle, lib', NM_FRAMES, ctxFixture(), ['x']);
            noThrow(out);
            assert.equal(out.reads, 1);
            assert.equal(out.result.bundle, null);
            assert.equal(out.ctx.bundle, 'web', 'ctx.bundle untouched');
        });

        it('getLib(lib), a stack shorter than ten frames: no throw', function () {
            var out = run(getLibPrologue(), 'bundle, lib', NM_SHORT, ctxFixture(), ['x']);
            noThrow(out);
            assert.equal(out.reads, 1);
            assert.equal(out.result.bundle, null);
        });

        it('getLib() with no lib takes the `bundle == lib` branch and reads no stack', function () {
            var out = run(getLibPrologue(), 'bundle, lib', NM_FRAMES, ctxFixture(), []);
            noThrow(out);
            assert.equal(out.reads, 0);
            assert.equal(out.result.bundle, 'web');
        });
    });

    describe('02d - callerFileSegments, the shipped helper', function () {

        it('returns the first frame outside node_modules as path segments, without `.js`, skipping index 0', function () {
            var helper = requireHelper();
            var files = ['/srv/shop/src/web/index.js', NM_FRAMES[1], PROJECT_FILE];
            assert.deepEqual(helper(callSites(files)), PROJECT_SEGMENTS);
        });

        it('returns [] when every frame is under node_modules, when the stack is short, and when it is absent', function () {
            var helper = requireHelper();
            assert.deepEqual(helper(callSites(NM_FRAMES)), []);
            assert.deepEqual(helper(callSites(NM_SHORT)), []);
            assert.deepEqual(helper(undefined), []);
            assert.deepEqual(helper(null), []);
        });

        it('skips frames that have no file name', function () {
            var helper = requireHelper();
            var files = [NM_FRAMES[0], { getFileName: function () { return null; } },
                { getFileName: function () { return undefined; } }, PROJECT_FILE];
            assert.deepEqual(helper(callSites(files)), PROJECT_SEGMENTS);
        });

        it('examines indices 1 to 9 only, as before (a qualifying frame at index 10 is out of reach)', function () {
            var helper = requireHelper();
            assert.deepEqual(helper(callSites(NM_FRAMES.concat([PROJECT_FILE]))), []);
            var at9 = NM_FRAMES.slice(0, 9).concat([PROJECT_FILE]);
            assert.deepEqual(helper(callSites(at9)), PROJECT_SEGMENTS, 'index 9 is still read');
        });

        it('a `node:` frame is not under node_modules, so it stops the walk (unchanged)', function () {
            var helper = requireHelper();
            var files = [NM_FRAMES[0], NM_FRAMES[1], 'node:events', PROJECT_FILE];
            assert.deepEqual(helper(callSites(files)), ['node:events']);
        });
    });

    describe('02e - REAL CallSites, through the real `__stack` getter', function () {

        // The getter as shipped: captureStackTrace omits the getter itself, so index 0 is the
        // frame that reads `__stack` (here the compiled prologue) and index 1 is its caller.
        function realStackGetter() {
            var decl  = "Object.defineProperty(global, '__stack', {";
            var start = PROTO_SRC.indexOf(decl);
            assert.ok(start > -1, 'utils/prototypes.js defines __stack');
            var next  = PROTO_SRC.indexOf('Object.defineProperty(', start + decl.length);   // the next getter (`__line`)
            var region = PROTO_SRC.slice(start, next > -1 ? next : undefined);
            var fnSrc = bracedFrom(region, 'get: function(){').replace(/^get: /, '');
            return new Function('return (' + fnSrc + ');')();
        }

        var UNDER_NM = /node_modules/.test(__filename);

        it('CONTROL — getConfig(<falsy>, confName) called from this file resolves a directory of this file', {
            skip: UNDER_NM && 'this file runs from a path under node_modules'
        }, function () {
            var scope = { ctx: { bundle: 'web', bundles: ['core'] }, index: undefined, callerFileSegments: loadHelper() };
            Object.defineProperty(scope, '__stack', { get: realStackGetter() });
            var fn = compilePrologue(getConfigPrologue(), 'bundle, confName')(scope);
            var r = fn(null, 'app');
            assert.equal(r.bundle, 'core', 'test/core/ is the calling directory');
        });
    });
});


// ---------------------------------------------------------------------------
// 03 - core/controller/controller.js source pins (the per-request render site)
// ---------------------------------------------------------------------------
describe('03 - controller.js source pins (the per-request render site)', function () {

    var CTRL_ACTIVE = stripComments(CTRL_SRC);

    it('the swig settings read no longer calls the global getConfig()', function () {
        assert.equal(count(CTRL_ACTIVE, 'getConfig()[local.options.conf.bundle]'), 0);
    });

    it('it reads the request\'s own conf, guarded to {}', function () {
        assert.equal(count(CTRL_ACTIVE, '( local.options.conf.content.settings.swig ) || {}'), 1);
    });

    it('CONTROL — the raw source keeps the old read as a record (the strip is not vacuous)', function () {
        assert.ok(CTRL_SRC.indexOf(OLD_RENDER_READ) > -1);
    });

    it('CONTROL — the catch that falls back to autoescape false is kept', function () {
        assert.ok(CTRL_ACTIVE.indexOf('} catch (_swigAeErr) {') > -1, 'catch present');
        assert.ok(CTRL_ACTIVE.indexOf('_swigAutoescape = ( _tSwig.autoescape === true );') > -1, 'strict select kept');
    });
});
