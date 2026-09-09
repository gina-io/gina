'use strict';
var path   = require('path');
var fs     = require('fs');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW           = require('../fw');
var MERGE_SRC    = fs.readFileSync(path.join(FW, 'lib/merge/src/main.js'), 'utf8');
var LOGGER_SRC   = fs.readFileSync(path.join(FW, 'lib/logger/src/main.js'), 'utf8');
var FILE_SRC     = fs.readFileSync(path.join(FW, 'lib/logger/src/containers/file/index.js'), 'utf8');
var MQ_SRC       = fs.readFileSync(path.join(FW, 'lib/logger/src/containers/mq/index.js'), 'utf8');

// #M22 — Logger circular-require structural fix.
//
// Previously, `lib/merge/src/main.js`'s top-level checked `typeof(JSON.clone)`
// and called `require('../../../helpers')` to populate it as a side effect.
// `helpers/index.js` iterates the helpers/ directory and calls
// `_require('./<helper>')` for each file, which transitively requires
// `lib/logger` via `helpers/{path,task,context,json}.js`. When this fires
// during logger's OWN load, `require('lib/logger')` returns a partial empty
// module (Node's circular-require quirk), and propagation downstream means
// `require('../../merge')` from logger ends up bound to a partial too.
//
// The fix: merge.js requires `utils/prototypes.json_clone.js` DIRECTLY —
// a 100-line standalone file with zero `require()` calls at top level.
// This shortcuts past the helpers/index.js for-loop loader, so the
// circular chain never fires.
//
// Three eval fallbacks (logger main.js + file/index.js + mq/index.js) that
// existed solely to recover from the partial-merge case are then removed.
//
// This file pins the invariant as source-side assertions so a future
// regression (re-introducing the helpers require in merge, or adding back
// the eval fallback) surfaces as a failing test.

var stripComments = function (src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
};


// --- 01 — merge.js requires utils/prototypes.json_clone directly ---
describe('01 — merge.js direct json_clone require (#M22)', function () {

    it('merge.js: no longer calls require(\'../../../helpers\') in the module-load tail', function () {
        var live = stripComments(MERGE_SRC);
        assert.ok(
            !/require\s*\(\s*['"]\.\.\/\.\.\/\.\.\/helpers['"]\s*\)/.test(live),
            'merge.js still calls require(\'../../../helpers\') — circular trigger reinstated'
        );
    });

    it('merge.js: the JSON.clone setup at module-load tail requires utils/prototypes.json_clone directly', function () {
        assert.ok(
            /require\s*\(\s*__dirname\s*\+\s*['"]\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/utils\/prototypes\.json_clone['"]\s*\)/.test(MERGE_SRC),
            'merge.js does not require utils/prototypes.json_clone directly'
        );
    });

    it('merge.js: the JSON.clone assignment is explicit (no reliance on helpers/index.js side effects)', function () {
        // The new shape: JSON.clone = require(...). Explicit assignment.
        assert.ok(
            /JSON\.clone\s*=\s*require\s*\(\s*__dirname/.test(MERGE_SRC),
            'merge.js does not explicitly assign JSON.clone from a direct require'
        );
    });

    it('merge.js: carries the #M22 provenance tag', function () {
        assert.ok(/#M22/.test(MERGE_SRC), '#M22 tag should be present in merge.js');
    });
});


// --- 02 — no eval fallback in logger main.js + 2 containers ---
describe('02 — eval fallbacks removed from logger sites (#M22)', function () {

    it('logger/src/main.js: zero eval(fs.readFileSync(...merge...)) calls', function () {
        var live = stripComments(LOGGER_SRC);
        assert.ok(
            !/eval\s*\(\s*fs\.readFileSync\s*\([^)]*merge/.test(live),
            'logger main.js still contains the merge eval fallback'
        );
    });

    it('logger/src/containers/file/index.js: zero eval(fs.readFileSync(...merge...)) calls', function () {
        var live = stripComments(FILE_SRC);
        assert.ok(
            !/eval\s*\(\s*fs\.readFileSync\s*\([^)]*merge/.test(live),
            'file/index.js still contains the merge eval fallback'
        );
    });

    it('logger/src/containers/mq/index.js: zero eval(fs.readFileSync(...merge...)) calls', function () {
        var live = stripComments(MQ_SRC);
        assert.ok(
            !/eval\s*\(\s*fs\.readFileSync\s*\([^)]*merge/.test(live),
            'mq/index.js still contains the merge eval fallback'
        );
    });

    it('logger/src/main.js: zero `eval(` calls anywhere (server-side eval-safe)', function () {
        var live = stripComments(LOGGER_SRC);
        assert.ok(
            !/\beval\s*\(/.test(live),
            'logger main.js contains a stray eval() — invariant breach'
        );
    });

    it('logger/src/containers/file/index.js: zero `eval(` calls anywhere', function () {
        var live = stripComments(FILE_SRC);
        assert.ok(
            !/\beval\s*\(/.test(live),
            'file/index.js contains a stray eval() — invariant breach'
        );
    });

    it('logger/src/containers/mq/index.js: zero `eval(` calls anywhere', function () {
        var live = stripComments(MQ_SRC);
        assert.ok(
            !/\beval\s*\(/.test(live),
            'mq/index.js contains a stray eval() — invariant breach'
        );
    });

    it('logger/main.js carries the #M22 provenance tag', function () {
        assert.ok(/#M22/.test(LOGGER_SRC), '#M22 tag missing from logger main.js');
    });

    // The file container carried this tag for a `lib/merge` require that it no
    // longer has: as an in-process sink it never merges a peer's logger registry
    // (#B526/#B527). logger/main.js and mq/index.js keep theirs, below and above.

    it('logger/containers/mq/index.js carries the #M22 provenance tag', function () {
        assert.ok(/#M22/.test(MQ_SRC), '#M22 tag missing from mq/index.js');
    });
});


// --- 03 — behavioural: require('lib/merge') returns a function ---
describe('03 — merge load returns a function (#M22)', function () {

    it('require(\'lib/merge\') yields a function (the merged-export contract)', function () {
        // Resolve via the framework path to mirror the runtime resolution.
        var merge = require(path.join(FW, 'lib/merge'));
        assert.equal(
            typeof merge, 'function',
            'require(\'lib/merge\') did not return a function — partial-export regression'
        );
    });

    it('require(\'lib/logger\') loads without crashing', function () {
        // logger main.js exports `Logger()` (the result of calling Logger as a
        // factory, not the constructor). So the load itself returns the
        // singleton instance — what matters is that the load doesn't throw.
        // Pre-#M22, removing the eval fallback would have crashed init at
        // `merge(...)` with TypeError; the structural fix means that path is
        // no longer reachable.
        var loggerInstance = require(path.join(FW, 'lib/logger'));
        assert.ok(loggerInstance != null, 'logger load returned null/undefined — load-time regression');
    });

    it('merge({a:1}, {b:2}) returns the expected union (smoke)', function () {
        var merge = require(path.join(FW, 'lib/merge'));
        var out = merge({a: 1}, {b: 2});
        assert.equal(out.a, 1);
        assert.equal(out.b, 2);
    });
});
