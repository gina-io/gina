'use strict';
// helpers/json — the parse-error excerpt shows the error (#B917)
//
// requireJSON answers a JSON syntax error with a message that quotes the file
// around the error, the error marked `--(ERROR !)--`. The excerpt ended at the
// fixed index 300 (`substring(pos - 200, 300)`), so for an error past character
// 500 the start passed the end, substring() swapped the two, and the excerpt
// stopped 200 characters short of the error: the marker never showed, and a long
// file printed almost whole. The excerpt now runs from 200 characters before the
// error to 300 after it.
//
// Behavioural arms run the REAL global requireJSON in a child process: the helper
// answers a parse failure with console.emerg followed by process.exit(1), which
// would take this runner down. The child replaces the logger's emerg and
// process.exit, and writes the message it captured to a file.
//
// The helper refuses a file one of two ways, both with the same message: it
// hands the message to console.emerg and calls process.exit(1), or it throws.
// Which one depends on load order: lib/logger loads the helpers, this one among
// them, before it sets its exports, so a helper loaded through the logger holds
// the logger's initial exports, has no console.emerg, and throws; the seam's copy,
// loaded later, exits. The excerpt is what this file pins, so both are accepted.
//
// The excerpt needs the position the engine reports. V8 says `... at position N`;
// JavaScriptCore (Bun) reports no position, and the helper then names the file
// without an excerpt, so the behavioural arms are skipped on such an engine.
//
// GINA_B917_JSON_HELPER points the whole file, pins and arms, at another copy of
// helpers/json/src/main.js: a copy taken before the fix reads red on every arm
// that pins the change and green on the controls. The copy's relative require of
// lib/logger must be made absolute, so the child patches the same module.
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var cp     = require('child_process');

var FW     = require('../fw');
var commentStrip = require('../strip-comments');
var HELPER = process.env.GINA_B917_JSON_HELPER || path.join(FW, 'helpers/json/src/main.js');
var LOGGER = path.join(FW, 'lib/logger');
var SRC    = fs.readFileSync(HELPER, 'utf8');

/** True when this engine's JSON.parse error names the position, as V8's does. */
var HAS_POSITION = (function() {
    try { JSON.parse('{"a": 1 "b": 2}'); } catch (e) { return /position(\s|\s+)\d+/.test(String(e && e.stack || e)); }
    return false;
})();

var tmp;
before(function() { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b917-')); });
after(function()  { fs.rmSync(tmp, { recursive: true, force: true }); });

function fixture(name, text) {
    var p = path.join(tmp, name);
    fs.writeFileSync(p, text);
    return p;
}

/**
 * A JSON object of `n` keys, one per line (`    "key007": "value 007",`), with
 * the comma after key `missing` left out, so the parse fails at the next key.
 *
 * @param {number} n - number of keys
 * @param {number} missing - index of the key whose trailing comma is dropped
 * @returns {string} the file text
 */
function keyFile(n, missing) {
    var lines = [];
    for (var i = 0; i < n; ++i) {
        var k = ('00' + i).slice(-3);
        lines.push('    "key' + k + '": "value ' + k + '"' + (i < n - 1 && i !== missing ? ',' : ''));
    }
    return '{\n' + lines.join('\n') + '\n}\n';
}

var CHILD = [
    'var fs = require("fs");',
    'var logger = require(process.argv[2]);',
    'var captured = null;',
    'var realExit = process.exit;',
    'logger.emerg = function(m) { captured = String(m); };',
    'process.exit = function(code) { throw { __exit: code }; };',
    'require(process.argv[1])();',
    'var how = "parsed";',
    'try { requireJSON(process.argv[3]); }',
    'catch (e) { how = (e && e.__exit !== undefined) ? "exit " + e.__exit : "threw"; if (captured === null && e && e.message) { captured = e.message; } }',
    'fs.writeFileSync(process.argv[4], JSON.stringify({ how: how, message: captured }));',
    'realExit(0);'
].join('\n');

/**
 * Run the real requireJSON on `file` in a child process.
 *
 * @param {string} file - the JSON file to load
 * @returns {{how: string, message: (string|null)}} `how` is `parsed`, `exit <code>`
 *   or `threw`; `message` is what the helper handed console.emerg (or the
 *   thrown error's message)
 */
function childLoad(file) {
    var outf = path.join(tmp, 'child-' + process.hrtime.bigint() + '.json');
    cp.spawnSync(process.execPath, ['-e', CHILD, HELPER, LOGGER, file, outf], { stdio: 'ignore', timeout: 20000 });
    if ( !fs.existsSync(outf) ) { return { how: 'no output', message: null }; }
    return JSON.parse(fs.readFileSync(outf, 'utf8'));
}

/** The helper refused the file: it exited through console.emerg, or threw. */
function assertRefused(r) {
    assert.ok(r.how === 'exit 1' || r.how === 'threw', 'the helper must refuse the file: ' + JSON.stringify(r).slice(0, 300));
    assert.equal(typeof r.message, 'string');
}

/** The excerpt between the message's « this portion » line and its closing tag. */
function excerptOf(message) {
    var head = 'Something is wrong around this portion:\n\r';
    var s = message.indexOf(head);
    var e = message.indexOf('<strong style="color:red">"</strong>', s);
    assert.ok(s > -1 && e > s, 'the message must quote an excerpt: ' + JSON.stringify(message.slice(0, 200)));
    return message.slice(s + head.length, e);
}

/** requireJSON's body, from its assignment to the next helper's. */
function region() {
    var s = SRC.indexOf('requireJSON = function(filename){');
    var e = SRC.indexOf('parseJSONWithComments = function(', s);
    assert.ok(s > -1 && e > s, 'the requireJSON region must be found');
    return SRC.slice(s, e);
}

/** `text` without its block comments and whole-line `//` comments. */
function code(text) {
    return commentStrip.lines(text);
}

// ─── 01 — the excerpt's bounds in the source ─────────────────────────────────

describe('01 - the excerpt runs from 200 characters before the error to 300 after it', function() {

    it('parses the position read from the stack before any arithmetic', function() {
        assert.match(code(region()), /var at\s*=\s*parseInt\(pos,\s*10\);/);
    });

    it('takes the excerpt from Math.max(0, at - 200) to at + 300', function() {
        assert.match(code(region()), /jsonStr\.substring\(Math\.max\(0,\s*at - 200\),\s*at \+ 300\)/);
    });

    it('no longer ends the excerpt at the fixed index 300', function() {
        assert.equal(code(region()).indexOf('substring(pos-200, 300)'), -1);
    });

    it('control: stripping comments keeps the code (the marker insertion is still there)', function() {
        assert.ok(code(region()).indexOf("jsonStr.substring(0, pos) + '--(ERROR !)--\\n' + jsonStr.substring(pos)") > -1);
    });

    it('control: the retired expression is still in the raw source, so the negative above is not vacuous', function() {
        assert.ok(region().indexOf('substring(pos-200, 300)') > -1);
    });
});

// ─── 02 — what requireJSON prints ────────────────────────────────────────────

// Registered only where the engine reports a position: without one requireJSON
// quotes no excerpt, and bun test (1.2.21) ran these arms despite a per-test
// `skip` option, so the whole block is gated instead.
if (HAS_POSITION) describe('02 - the message quotes the file around the error', function() {

    it('harness control: a valid file parses in the child', function() {
        var r = childLoad(fixture('valid.json', keyFile(80, -1)));
        assert.equal(r.how, 'parsed', JSON.stringify(r));
    });

    it('an error past character 500 shows the marker and the keys on both sides of it', function() {
        var r = childLoad(fixture('late.json', keyFile(80, 40)));   // the error is at "key041", char 1112
        assertRefused(r);
        var x = excerptOf(r.message);
        assert.ok(x.indexOf('--(ERROR !)--') > -1, 'marker missing from: ' + JSON.stringify(x.slice(0, 160)));
        assert.ok(x.indexOf('"key040"') > -1 && x.indexOf('"key041"') > -1, 'the keys around the error: ' + JSON.stringify(x.slice(0, 160)));
        assert.ok(x.indexOf('"key000"') === -1, 'the excerpt starts 200 characters before the error, not at the top');
    });

    it('an error between characters 300 and 500 shows the marker', function() {
        var r = childLoad(fixture('mid.json', keyFile(80, 15)));    // the error is at "key016", char 437
        assertRefused(r);
        var x = excerptOf(r.message);
        assert.ok(x.indexOf('--(ERROR !)--') > -1, 'marker missing from: ' + JSON.stringify(x.slice(0, 160)));
        assert.ok(x.indexOf('"key015"') > -1 && x.indexOf('"key016"') > -1);
    });

    it('an error deep in a long file quotes about 500 characters, not the file', function() {
        var r = childLoad(fixture('long.json', keyFile(300, 250)));  // the error is at "key251", char 6782
        assertRefused(r);
        var x = excerptOf(r.message);
        assert.ok(x.length <= 600, 'excerpt of ' + x.length + ' characters');
        assert.ok(x.indexOf('"key250"') > -1 && x.indexOf('"key251"') > -1);
    });

    it('control: an error before character 200 shows the marker (it did before the fix too)', function() {
        var r = childLoad(fixture('early.json', '{"a": 1 "b": 2}' + new Array(601).join(' ')));
        assertRefused(r);
        var x = excerptOf(r.message);
        assert.ok(x.indexOf('--(ERROR !)--') > -1, 'marker missing from: ' + JSON.stringify(x.slice(0, 160)));
    });
});
