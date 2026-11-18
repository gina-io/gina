'use strict';
/**
 * #B1126 — `requireController()` loads the required controller once per process outside
 * development, and keeps no evicted copy in development.
 *
 * The function evicted the super controller (`controller/index.js`) and the required controller
 * from the require cache and required them again on EVERY call, in every environment: its
 * `if (isCacheless)` guard was commented out. Node pushes each module required on a cache miss
 * onto the requiring module's `children` array, and nothing pruned that array on this path, so
 * every copy stayed alive on the router module for the life of the process. Once V8 has flushed
 * a module's code, each copy also keeps its own source text, so a long-running process grew by
 * about the required controller's source size per call.
 *
 * The guard is restored: outside development both modules load once (a cache hit adds no child),
 * as a routed controller does, so the required controller's module-level code runs once. In
 * development both are still evicted and required again on every call, so an edit shows on the
 * next call, and `pruneDeadModuleChildren()` then drops the evicted copies from `children`.
 *
 *  01 extraction controls — both regions are sliced from the source under test.
 *  02 outside development, behavioural — the REAL `requireController` bytes compiled with their
 *     closure inputs; a cached parent module hands in its own `require`, as router.js does, and
 *     has required the super controller first, as router.js does at load. The readings are the
 *     parent's `children`, the module identities in the require cache, and how many times the
 *     required controller's module-level code ran.
 *  03 development, behavioural — the same reading, plus the hot reload the change kept.
 *  04 source pins on the region, comment-stripped, each with the strip's own control.
 *
 * Seam: GINA_ROUTER_SRC=<absolute file> runs every arm against that text. Red-first against the
 * pre-change bytes (`git show <sha>:<fw>/core/router.js > <file>`): the arms that pin the change
 * read RED, the arms labelled CONTROL pin what it kept and stay GREEN. Nothing here waits on a
 * callback or a timer, so a regression fails and never hangs.
 */
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');

var FW            = require('../fw');
var ROUTER_SOURCE = process.env.GINA_ROUTER_SRC || path.join(FW, 'core/router.js');
var inherits      = require(path.join(FW, 'lib/inherits/src/main'));
var ROUTER_SRC    = fs.readFileSync(ROUTER_SOURCE, 'utf8');

// realpath: on macOS os.tmpdir() is a symlink, and require-cache keys are real paths
var TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1126-')));
var ENV_BEFORE = process.env.NODE_ENV_IS_DEV;

after(function () {
    Object.keys(require.cache).forEach(function (k) { if ( k.indexOf(TMP) === 0 ) { delete require.cache[k]; } });
    fs.rmSync(TMP, { recursive: true, force: true });
    if ( typeof(ENV_BEFORE) == 'undefined' ) { delete process.env.NODE_ENV_IS_DEV; } else { process.env.NODE_ENV_IS_DEV = ENV_BEFORE; }
});

/** Index of the brace closing the one opened at `open`, skipping strings and comments. */
function matchBrace(src, open) {
    var depth = 0, i, c, q;
    for (i = open; i < src.length; i++) {
        c = src[i];
        if ( c === '/' && src[i + 1] === '/' ) { i = src.indexOf('\n', i); if ( i < 0 ) { return -1; } continue; }
        if ( c === '/' && src[i + 1] === '*' ) { i = src.indexOf('*/', i + 2) + 1; if ( i <= 0 ) { return -1; } continue; }
        if ( c === '\'' || c === '"' || c === '`' ) {
            q = c;
            for (i++; i < src.length && src[i] !== q; i++) { if ( src[i] === '\\' ) { i++; } }
            continue;
        }
        if ( c === '{' ) { depth++; }
        else if ( c === '}' ) { depth--; if ( depth === 0 ) { return i; } }
    }
    return -1;
}

/** Slices the function expression assigned by the unique `start` literal, or null. */
function sliceFn(src, start) {
    var a = src.indexOf(start);
    if ( a < 0 || src.indexOf(start, a + 1) > -1 ) { return null; }
    var close = matchBrace(src, src.indexOf('{', a + start.length - 1));
    if ( close < 0 ) { return null; }
    return src.slice(a, close + 1) + ( /^\s*;/.test(src.slice(close + 1, close + 8)) ? ';' : '' );
}

function count(hay, needle) { return hay.split(needle).length - 1; }
function stripComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}
function squash(text) { return text.replace(/\s+/g, ' '); }

var RC_SRC    = sliceFn(ROUTER_SRC, 'var requireController = function (namespace, options) {');
var PRUNE_SRC = sliceFn(ROUTER_SRC, 'var pruneDeadModuleChildren = function() {');

var seq = 0;
/**
 * A bundle tree: a super controller behind an `index.js` that mirrors the framework's own gate,
 * a `billing` namespace controller counting its module evaluations, and the long-lived parent.
 */
function makeTree() {
    var dir  = path.join(TMP, 't' + (++seq));
    var core = path.join(dir, 'core', 'controller');
    var ctrl = path.join(dir, 'bundles', 'b', 'controllers');
    var key  = '__ginaB1126Evals' + seq;
    fs.mkdirSync(core, { recursive: true });
    fs.mkdirSync(ctrl, { recursive: true });
    fs.writeFileSync(path.join(core, 'index.js'),
        "var isCacheless = ( /^false$/i.test(process.env.NODE_ENV_IS_DEV) ) ? false : true;\n"
      + "if (isCacheless) { delete require.cache[require.resolve('./controller')]; }\n"
      + "module.exports = require('./controller');\n");
    fs.writeFileSync(path.join(core, 'controller.js'),
        "function SuperController() {}\n"
      + "SuperController.prototype.setOptions = function (req, res, next, options) { this.wiredWith = options; };\n"
      + "module.exports = SuperController;\n");
    var file = path.join(ctrl, 'controller.billing.js');
    var write = function (answer) {
        fs.writeFileSync(file,
            "global['" + key + "'] = ( global['" + key + "'] || 0 ) + 1;\n"
          + "function BillingController() { this.answer = function () { return '" + answer + "'; }; }\n"
          + "module.exports = BillingController;\n");
    };
    write('v1');
    fs.writeFileSync(path.join(dir, 'parent.js'), "module.exports = { require: require, module: module };\n");
    return {
        dir: dir, core: path.join(dir, 'core'), bundles: path.join(dir, 'bundles'), file: file,
        index: path.join(core, 'index.js'), write: write,
        evals: function () { return global[key] || 0; }
    };
}

/** Compiles the REAL requireController bytes with every closure input passed in. */
function compile(isDev, tree) {
    process.env.NODE_ENV_IS_DEV = isDev ? 'true' : 'false';
    var parent = require(path.join(tree.dir, 'parent.js'));
    // router.js requires the super controller once, at module load
    parent.require(tree.index);
    var prune = new Function('require', PRUNE_SRC + '\nreturn pruneDeadModuleChildren;')(require);
    var rc = new Function('_isDev', 'getPath', 'getContext', '_', 'inherits', 'require', 'serverInstance',
        'request', 'response', 'next', 'pruneDeadModuleChildren', RC_SRC + '\nreturn requireController;')(
        isDev,
        function () { return { core: tree.core }; },
        function () {
            return { Config: { instance: { bundle: 'b', env: 'prod', scope: 'production',
                Env: { getConf: function () { return { bundlesPath: tree.bundles }; } } } } };
        },
        function (p) { return path.resolve(p); },
        inherits,
        parent.require,
        { throwError: function (res, code, err) { throw err; } },
        {}, {}, function () {},
        prune
    );
    return { rc: rc, parent: parent };
}

/** Calls requireController `n` times; returns what each call gave and the cache after it. */
function callN(h, tree, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
        var opts = {};
        var c = h.rc('billing', opts);
        out.push({ ctrl: c, opts: opts, fileModule: require.cache[tree.file], indexModule: require.cache[tree.index] });
    }
    return out;
}

describe('01 - extraction controls: both regions are sliced from the source under test', function () {
    it('the requireController region slices once and reaches its own end', function () {
        assert.ok(RC_SRC, 'the requireController region must be extractable');
        assert.equal(count(RC_SRC, 'controller.requireController = requireController;'), 1);
        assert.equal(count(RC_SRC, 'delete require.cache[require.resolve(filename)];'), 1);
    });
    it('the pruneDeadModuleChildren region slices once', function () {
        assert.ok(PRUNE_SRC, 'the pruneDeadModuleChildren region must be extractable');
        assert.equal(count(PRUNE_SRC, 'return require.cache[child.id] === child;'), 1);
    });
});

describe('02 - outside development: the required controller loads once', function () {
    var tree = makeTree();
    var h    = compile(false, tree);
    var warm = callN(h, tree, 1)[0];
    var c0   = h.parent.module.children.length;
    var e0   = tree.evals();
    var runs = callN(h, tree, 20);
    // read now: the other suites run their calls before these tests do
    var childrenDelta = h.parent.module.children.length - c0;
    var evalsDelta    = tree.evals() - e0;

    it('20 more calls add no child to the parent module', function () {
        assert.equal(childrenDelta, 0);
    });
    it('the required controller\'s module-level code ran once, for the first call only', function () {
        assert.equal(e0, 1, 'the first call loads it');
        assert.equal(evalsDelta, 0, 'later calls reuse the cached module');
    });
    it('every call reads the same cached modules', function () {
        runs.forEach(function (r) {
            assert.equal(r.fileModule, warm.fileModule, 'the required controller module');
            assert.equal(r.indexModule, warm.indexModule, 'the super controller module');
        });
    });
    it('CONTROL: each call returns a controller built for it, inheriting the super controller', function () {
        runs.forEach(function (r) {
            assert.equal(r.ctrl.answer(), 'v1');
            assert.equal(typeof r.ctrl.setOptions, 'function');
            assert.equal(r.ctrl.wiredWith, r.opts, 'setOptions received this call\'s options');
            assert.equal(r.ctrl.name, 'billing');
            assert.equal(r.ctrl.requireController, h.rc);
        });
        assert.notEqual(runs[0].ctrl, runs[1].ctrl, 'one instance per call');
    });
    it('CONTROL: each call records the required controller in its options', function () {
        runs.forEach(function (r) {
            assert.equal(r.opts.controlRequired.length, 1);
            assert.equal(r.opts.controlRequired[0]['controller.billing'], tree.file);
        });
    });
});

describe('03 - development: the required controller reloads on every call and leaves no copy behind', function () {
    var tree = makeTree();
    var h    = compile(true, tree);
    callN(h, tree, 1);
    var c0   = h.parent.module.children.length;
    var e0   = tree.evals();
    var runs = callN(h, tree, 20);
    var childrenAfter = h.parent.module.children.slice();
    var evalsDelta    = tree.evals() - e0;
    var cacheNow      = childrenAfter.map(function (child) { return require.cache[child.id] === child; });

    it('20 more calls add no child to the parent module: the evicted copies are pruned', function () {
        assert.equal(childrenAfter.length - c0, 0);
    });
    it('every child the parent keeps is the module the require cache holds now', function () {
        assert.ok(childrenAfter.length > 0, 'the parent keeps the current copies');
        cacheNow.forEach(function (isCurrent, i) { assert.equal(isCurrent, true, childrenAfter[i].id); });
    });
    it('CONTROL: the required controller\'s module-level code ran on every call (hot reload kept)', function () {
        assert.equal(evalsDelta, 20);
        assert.notEqual(runs[0].fileModule, runs[1].fileModule, 'a fresh module per call');
    });
    it('CONTROL: an edit to the controller file shows on the next call', function () {
        assert.equal(runs[19].ctrl.answer(), 'v1');
        tree.write('v2');
        assert.equal(callN(h, tree, 1)[0].ctrl.answer(), 'v2');
    });
});

describe('04 - source pins on the requireController region', function () {
    var stripped = squash(stripComments(RC_SRC || ''));

    it('both evictions sit inside an `if (isCacheless)` block', function () {
        assert.ok(stripped.indexOf(
            "if (isCacheless) { delete require.cache[require.resolve(_(corePath +'/controller/index.js', true))];"
          + " delete require.cache[require.resolve(filename)]; }") > -1);
    });
    it('in that mode, pruneDeadModuleChildren() runs after the required controller is required again', function () {
        assert.ok(stripped.indexOf(
            'var RequiredController = require(filename); if (isCacheless) { pruneDeadModuleChildren(); }') > -1);
    });
    it('CONTROL: the strip removed the comment lines, the commented guard marker among them', function () {
        assert.ok(RC_SRC.indexOf('//if (isCacheless) {') > -1, 'the raw region carries the marker');
        assert.ok(RC_SRC.indexOf('#B18') > -1, 'the raw region carries a comment');
        assert.equal(stripped.indexOf('//if (isCacheless) {'), -1);
        assert.equal(stripped.indexOf('#B18'), -1);
    });
    it('CONTROL: the super controller is read from require()\'s return value (#B18)', function () {
        assert.ok(stripped.indexOf("var SuperController = require(_(corePath +'/controller/index.js', true));") > -1);
    });
});
