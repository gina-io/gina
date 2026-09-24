'use strict';
/**
 * #B617 — a model-loading failure must end the boot the #B57 way (emerg, a
 * synchronous stderr flush, exit 1) on EVERY connector, not only on a
 * synchronous one.
 *
 * `lib/model.js` builds the models inside the connector's own ready callback.
 * On sqlite that callback runs in-line, so a throw there reached the #B57 catch
 * in `core/gna.js` and the process exited 1. On duckdb the callback runs inside a
 * `.then()`, and couchbase emits `ready` inside an `async` function, so the same
 * throw became an unhandled promise REJECTION that `core/gna.js` only logs.
 * Measured 2026-09-25 through the real `bin/gina-container`: a duckdb bundle
 * whose entity file is `_temp.js` exited 0 (a success status) in 790 ms, never
 * bound its port, and left stderr empty; the same file on sqlite exited 1 with
 * the reason. With the catch below, the duckdb arm exits 1 with the reason too.
 *
 * Why this file executes EXTRACTED source rather than driving the boot:
 * `loadAllModels` is not unit-isolatable (test/lib/model-load.test.js says so in
 * its header), and the async live arm needs a duckdb driver this repo does not
 * ship. So the terminal is a module-level function executed here as shipped
 * bytes, with its three effects injected, and the wiring is pinned on whole
 * source lines — a comment that merely mentions `cb()` cannot satisfy a pin.
 *
 * Arms:
 *   §00 instrument validation — the extraction matches exactly once and is
 *                               brace-balanced; a bogus name does not extract;
 *                               the line anchors resolve exactly once
 *   §01 source pins           — the model-building block sits inside a try whose
 *                               catch calls the terminal; cb() stays outside it
 *   §02 _abortModelLoading    — real bytes: emerg, then the stderr flush, then
 *                               exit(1), with the #B57 message; a failing flush
 *                               still exits; a non-Error reason is rendered
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SOURCE = path.join(FW, 'lib/model.js');
var src    = fs.readFileSync(SOURCE, 'utf8');
var gnaSrc = fs.readFileSync(path.join(FW, 'core/gna.js'), 'utf8');

var PREFIX = '[ FRAMEWORK ] Model loading failed — aborting boot: ';

/**
 * Extract `var <name> = function(...) { ... };` from the source by brace-matching,
 * so a multi-line body is captured whole (a line-bounded regex cannot). Same
 * extractor as test/lib/model-entity-attach-b555.test.js.
 *
 * @inner
 * @param {string} source - the file text
 * @param {string} name   - the declared function name
 * @returns {{text: string, balanced: boolean, unique: boolean}}
 */
function extractFn(source, name) {
    var decl = 'var ' + name + ' = function(';
    var i = source.indexOf(decl);
    if (i < 0) { return { text: null, balanced: false, unique: false }; }
    var unique = source.indexOf(decl, i + 1) === -1;
    var open = source.indexOf('{', i);
    var depth = 0, j = open;
    for (; j < source.length; j++) {
        if (source[j] === '{') { depth++; }
        else if (source[j] === '}') { depth--; if (depth === 0) { break; } }
    }
    return { text: source.slice(i + ('var ' + name + ' = ').length, j + 1), balanced: depth === 0, unique: unique };
}

/**
 * Build the shipped `_abortModelLoading` with its three effects injected, and a
 * log of every effect in the order it happened.
 *
 * @inner
 * @param {object} [opts]
 * @param {boolean} [opts.flushThrows] - make the stderr flush throw
 * @returns {{fn: function, calls: Array}}
 */
function buildAbort(opts) {
    var calls = [];
    var stubConsole = { emerg: function (m) { calls.push(['emerg', m]); } };
    var stubFs = { writeSync: function (fd, s) {
        calls.push(['write', fd, s]);
        if (opts && opts.flushThrows) { throw new Error('EPIPE'); }
    } };
    var stubProcess = { exit: function (code) { calls.push(['exit', code]); } };
    var fn = new Function('fs', 'console', 'process', 'return (' + ABORT.text + ');')(stubFs, stubConsole, stubProcess);
    return { fn: fn, calls: calls };
}

/**
 * Index of the ONE line whose trimmed text equals `text`, searching from `from`.
 *
 * @inner
 * @param {Array<string>} lines - trimmed source lines
 * @param {string} text         - the exact trimmed line
 * @param {number} [from]       - first index to consider
 * @returns {number} the index, or -1
 */
function lineIndex(lines, text, from) {
    for (var k = (from || 0); k < lines.length; k++) {
        if (lines[k] === text) { return k; }
    }
    return -1;
}

var ABORT = extractFn(src, '_abortModelLoading');
var LINES = src.split('\n').map(function (l) { return l.trim(); });
var IF_ALL_READY = 'if ( t == _connectorCount ) {';


describe('#B617 §00 - instrument validation', function () {

    it('_abortModelLoading extracts exactly once and brace-balanced', function () {
        assert.ok(ABORT.text, '_abortModelLoading must be extractable');
        assert.ok(ABORT.unique, '_abortModelLoading must be declared exactly once');
        assert.ok(ABORT.balanced, '_abortModelLoading extraction must be brace-balanced');
    });

    it('the extractor cannot fire on a name that is not there', function () {
        // Without this, a silently-null extraction would make §02 vacuous.
        var bogus = extractFn(src, '_zzB617NotAFunction');
        assert.equal(bogus.text, null);
        assert.equal(bogus.balanced, false);
    });

    it('the all-connectors-ready anchor resolves exactly once', function () {
        var first = lineIndex(LINES, IF_ALL_READY);
        assert.ok(first > -1, 'anchor `' + IF_ALL_READY + '` not found');
        assert.equal(lineIndex(LINES, IF_ALL_READY, first + 1), -1, 'anchor must be unique');
    });

    it('the whole-line matcher does not match a comment that mentions the line', function () {
        // `cb()` appears inside a comment near the catch; only the code line may count.
        assert.equal(lineIndex(['// cb(), the boot\'s continuation', 'x'], 'cb()'), -1);
        assert.equal(lineIndex(['// cb()', 'cb()'], 'cb()'), 1);
    });
});


describe('#B617 §01 - source pins: the model-building block is caught, the continuation is not', function () {

    var iIf    = lineIndex(LINES, IF_ALL_READY);
    var iTry   = lineIndex(LINES, 'try {', iIf + 1);
    var iCatch = lineIndex(LINES, '} catch (modelErr) {', iIf + 1);
    var iCb    = lineIndex(LINES, 'cb()', iCatch + 1);

    it('the block opens a try before any model-building statement', function () {
        assert.ok(iIf > -1 && iTry > iIf, 'a `try {` must follow the all-connectors-ready condition');
        for (var k = iIf + 1; k < iTry; k++) {
            assert.ok(LINES[k] === '' || LINES[k].indexOf('//') === 0,
                'only comments may sit between the condition and the try; found: ' + LINES[k]);
        }
    });

    it('the guard, the entity-manager factory and the entity constructors are inside the try', function () {
        var guard   = LINES.findIndex(function (l) { return l.indexOf('throw new Error(\'Entity Class `\'') === 0; });
        var factory = LINES.findIndex(function (l) { return l.indexOf('entitiesManager = require( _(connectorPath + \'/index.js\', true) )') === 0; });
        var ctor    = lineIndex(LINES, 'nttInstances[nttClass] = new entitiesManager[nttClass](conn);');
        [['guard', guard], ['factory', factory], ['constructor', ctor]].forEach(function (p) {
            assert.ok(p[1] > iTry && p[1] < iCatch, 'the ' + p[0] + ' (line ' + (p[1] + 1) + ') must sit between the try (' + (iTry + 1) + ') and the catch (' + (iCatch + 1) + ')');
        });
    });

    it('the catch hands the error to _abortModelLoading', function () {
        assert.ok(iCatch > iTry, '`} catch (modelErr) {` must close the try');
        var next = LINES.slice(iCatch + 1).find(function (l) { return l !== ''; });
        assert.equal(next, '_abortModelLoading(modelErr);', 'the catch must end the boot through the terminal');
    });

    it('cb() — the boot continuation — runs after the catch, never inside the try', function () {
        // Without the structure every index below is -1 and the comparisons pass vacuously.
        assert.ok(iIf > -1 && iTry > iIf && iCatch > iTry, 'the try/catch must exist before its placement can be judged');
        assert.ok(iCb > iCatch, 'cb() must follow the catch');
        assert.equal(lineIndex(LINES.slice(iTry, iCatch), 'cb()'), -1,
            'cb() inside the try would label a later boot failure as a model failure');
    });

    it('the terminal keeps the #B57 wording used by core/gna.js', function () {
        assert.ok(gnaSrc.indexOf('\'' + PREFIX + '\'') > -1, 'core/gna.js #B57 prefix moved; realign the two terminals');
        assert.ok(ABORT.text && ABORT.text.indexOf('\'' + PREFIX + '\'') > -1, '_abortModelLoading must use the same prefix');
    });
});


describe('#B617 §02 - _abortModelLoading over real bytes', function () {

    it('an Error: emerg, then the synchronous stderr flush, then exit(1)', function () {
        var b = buildAbort();
        var err = new Error('Entity Class `_temp` should start with an uppercase !');
        b.fn(err);
        var msg = PREFIX + err.stack;
        assert.deepEqual(b.calls, [['emerg', msg], ['write', 2, msg + '\n'], ['exit', 1]]);
    });

    it('a flush that throws still ends the boot', function () {
        var b = buildAbort({ flushThrows: true });
        b.fn(new Error('boom'));
        assert.deepEqual(b.calls.map(function (c) { return c[0]; }), ['emerg', 'write', 'exit']);
        assert.equal(b.calls[2][1], 1);
    });

    it('an Error without a stack falls back to its message', function () {
        var b = buildAbort();
        var err = new Error('no stack here');
        err.stack = undefined;
        b.fn(err);
        assert.equal(b.calls[0][1], PREFIX + 'no stack here');
    });

    it('a non-Error reason is rendered, including null', function () {
        var b1 = buildAbort(); b1.fn('plain string');
        assert.equal(b1.calls[0][1], PREFIX + 'plain string');
        var b2 = buildAbort(); b2.fn(null);
        assert.equal(b2.calls[0][1], PREFIX + 'null');
        assert.equal(b2.calls[2][1], 1);
    });
});
