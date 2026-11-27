'use strict';
// helpers/json — line-comment stripping is string-aware (#B1170)
//
// Behavioural, through the REAL helper: `parseJSONWithComments` in-process (it
// throws on a parse failure) and `requireJSON` on a fixture in a child process
// (on a parse failure it calls `console.emerg` then `process.exit(1)`, which
// would take the test runner down with it).
//
// Module-path seam: GINA_JSON_HELPER_SRC points the whole file at another copy
// of helpers/json/src/main.js. Run at BASE, before the fix is applied, §01, §02,
// §04 and §05.1 go red and §00, §03 and §05.2 stay green.
//
// What is pinned and why:
//   - a `//` inside a string value or key is data: a path joined from a
//     directory that ends in `/` ("/var/T//gina"), "x//y", a key "a//b", and a
//     `//` after an escaped backslash ("C:\\dir//x"). The rule this replaced cut
//     each line at its leftmost `//` unless the character before it was `:`,
//     `"` or `\`, so those values were cut and the text no longer parsed;
//   - a `//` comment after a value that holds `//` is still removed: the old
//     rule kept the whole line when its leftmost `//` followed `:` (a URL), so
//     the comment stayed and the text did not parse;
//   - everything the old rule parsed reads the same: comment lines, a URL, a
//     value that starts with `//`, an escaped quote before `//`, a comment after
//     a plain value (§03, and §05.2 over 2,000 generated documents).
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var cp     = require('child_process');

var FW     = require('../fw');
var HELPER = process.env.GINA_JSON_HELPER_SRC || path.join(FW, 'helpers/json/src/main.js');
require(HELPER)(); // installs the implicit globals `requireJSON` and `parseJSONWithComments`

var tmp;
before(function() { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1170-')); });
after(function()  { fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * Writes `text` to a fixture file in this run's temporary directory.
 *
 * @param {string} name - the file name
 * @param {string} text - the file content
 * @returns {string} the file's absolute path
 */
function fixture(name, text) {
    var p = path.join(tmp, name);
    fs.writeFileSync(p, text);
    return p;
}

/**
 * Parses `file` through the real `requireJSON` in a child process, so a parse
 * failure (`console.emerg` + `process.exit(1)`) cannot stop the runner.
 *
 * @param {string} file - the fixture to parse
 * @returns {{ok: boolean, value: *, error: string}} the parsed value, or the error's first line
 */
function childParse(file) {
    var outf = path.join(tmp, 'child-' + process.hrtime.bigint() + '.out');
    var script = 'require(process.argv[1])();'
        + 'var fs=require("fs");'
        + 'try { fs.writeFileSync(process.argv[3], "OK " + JSON.stringify(requireJSON(process.argv[2]))); }'
        + 'catch (e) { fs.writeFileSync(process.argv[3], "ERR " + String(e && e.message || e).split("\\n")[0]); }';
    cp.spawnSync(process.execPath, ['-e', script, HELPER, file, outf], { stdio: 'ignore', timeout: 20000 });
    var out = fs.existsSync(outf) ? fs.readFileSync(outf, 'utf8') : '';
    if (out.slice(0, 3) === 'OK ') return { ok: true, value: JSON.parse(out.slice(3)) };
    return { ok: false, error: out.slice(4) || '(emerg exit — no output written)' };
}

// ─── 00 — the helper under test is loaded ────────────────────────────────────

describe('00 - the helper under test is loaded', function() {
    it('installs parseJSONWithComments and requireJSON', function() {
        assert.equal(typeof parseJSONWithComments, 'function');
        assert.equal(typeof requireJSON, 'function');
    });
});

// ─── 01 — a `//` inside a string is data ─────────────────────────────────────

describe('01 - a // inside a string value or key is data', function() {
    it('keeps a path joined from a directory that ends in / ("…/T//gina-a")', function() {
        var v = parseJSONWithComments('{\n  "def_prefix": "/var/folders/xx/T//gina-a"\n}');
        assert.equal(v.def_prefix, '/var/folders/xx/T//gina-a');
    });

    it('keeps "x//y"', function() {
        assert.deepEqual(parseJSONWithComments('{ "a": "x//y" }'), { a: 'x//y' });
    });

    it('keeps a key holding //', function() {
        assert.deepEqual(parseJSONWithComments('{ "a//b": 1 }'), { 'a//b': 1 });
    });

    it('keeps a // that follows an escaped backslash inside a value', function() {
        // the JSON text is "C:\\dir//x": the `//` follows `r`, so the old rule cut there
        assert.deepEqual(parseJSONWithComments('{ "p": "C:\\\\dir//x" }'), { p: 'C:\\dir//x' });
    });
});

// ─── 02 — a comment after a value that holds `//` is removed ─────────────────

describe('02 - a // comment after a value that holds // is removed', function() {
    it('removes a comment after a URL value on the same line', function() {
        assert.deepEqual(parseJSONWithComments('{\n  "u": "http://x/y" // the API\n}'), { u: 'http://x/y' });
    });

    it('removes a comment after a path value holding //, then reads the next key', function() {
        assert.deepEqual(parseJSONWithComments('{\n  "d": "/var/T//g", // note\n  "n": 1\n}'), { d: '/var/T//g', n: 1 });
    });
});

// ─── 03 — what the old rule parsed reads the same ────────────────────────────

describe('03 - text the old rule parsed reads the same', function() {
    it('drops full-line and indented comment lines', function() {
        assert.deepEqual(parseJSONWithComments('// head\n{\n  // note\n  "a": 1\n//\n}'), { a: 1 });
    });

    it('keeps a URL value holding //', function() {
        assert.deepEqual(parseJSONWithComments('{ "u": "https://example.com/a//b" }'), { u: 'https://example.com/a//b' });
    });

    it('keeps a value that starts with //', function() {
        assert.deepEqual(parseJSONWithComments('{ "v": "//cdn" }'), { v: '//cdn' });
    });

    it('keeps "http://host//:rest"', function() {
        assert.deepEqual(parseJSONWithComments('{ "u": "http://host//:rest" }'), { u: 'http://host//:rest' });
    });

    it('keeps a // that follows an escaped quote inside a value', function() {
        assert.deepEqual(parseJSONWithComments('{ "q": "say \\"x\\"//y" }'), { q: 'say "x"//y' });
    });

    it('removes a comment after a plain value', function() {
        assert.deepEqual(parseJSONWithComments('{\n  "n": 1 // one\n}'), { n: 1 });
    });
});

// ─── 04 — requireJSON reads a file whose path value holds `//` ────────────────

describe('04 - requireJSON reads a file whose path value holds //', function() {
    it('parses a settings file whose prefix was joined from a directory ending in /', function() {
        var f = fixture('main.json', '{\n  // framework state\n  "def_prefix": "/var/folders/xx/T//gina-a",\n  "frameworks": {}\n}\n');
        var r = childParse(f);
        assert.equal(r.ok, true, 'requireJSON failed: ' + r.error);
        assert.equal(r.value.def_prefix, '/var/folders/xx/T//gina-a');
    });
});

// ─── 05 — a seeded differential against the rule it replaced ─────────────────

/**
 * The line-comment rule #B1170 replaced, kept here as the test's oracle.
 *
 * @param {string} jsonStr - a JSON-with-comments source without block comments
 * @returns {string} the source as the old rule stripped it
 */
function oldStrip(jsonStr) {
    return jsonStr.split('\n').map(function(line) {
        var idx = line.indexOf('//');
        if (idx === -1) return line;
        if (idx > 0) {
            var prev = line.charAt(idx - 1);
            if (prev === ':' || prev === '"' || prev === '\\') return line;
        }
        return line.substring(0, idx);
    }).join('\n');
}

/**
 * A seeded generator of small JSON-with-comments documents (values holding `//`,
 * URLs, escaped quotes and backslashes, an array; trailing and standalone
 * comments). No block comments and no trailing commas.
 *
 * @param {number} seed - the PRNG seed
 * @returns {function(): string} the next document
 */
function generator(seed) {
    var s = seed | 0;
    function rnd() {
        s = (s + 0x6D2B79F5) | 0;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
    var VALS  = ['1', 'true', 'null', '"plain"', '"a//b"', '"https://x/y"', '"https://x/a//b"', '"//srv/share"', '"/var/T//g"', '"x\\\\//y"', '"q\\"//r"', '"c:/d"', '"://"', '"\\/\\/"', '"say \\"hi\\""', '[1, "u//v"]'];
    var TAILS = ['', '', '', ' // note', '// note', ' //', ' // has "quote" and // more', ' // url http://x'];
    var SOLO  = ['  // standalone', '//', '  // url http://x/y', '  // a "quoted" // comment'];
    return function() {
        var n = 1 + Math.floor(rnd() * 5), lines = ['{'];
        for (var i = 0; i < n; i++) {
            if (rnd() < 0.3) lines.push(pick(SOLO));
            lines.push('  "k' + i + '": ' + pick(VALS) + (i < n - 1 ? ',' : '') + pick(TAILS));
        }
        if (rnd() < 0.3) lines.push(pick(SOLO));
        lines.push('}');
        return lines.join('\n');
    };
}

describe('05 - 2,000 generated documents against the rule it replaced', function() {
    var N = 2000, docs = [];
    before(function() {
        var next = generator(1170);
        for (var i = 0; i < N; i++) docs.push(next());
    });

    it('parses every document', function() {
        var failed = 0, oldFailed = 0, first = null;
        for (var i = 0; i < N; i++) {
            try { JSON.parse(oldStrip(docs[i])); } catch (e) { oldFailed++; }
            try { parseJSONWithComments(docs[i]); } catch (e) { failed++; if (first === null) first = docs[i]; }
        }
        assert.ok(oldFailed > 0, 'control: the generator must produce documents the old rule cannot parse');
        assert.equal(failed, 0, failed + ' of ' + N + ' did not parse; the first: ' + JSON.stringify(first));
    });

    it('reads every document the old rule parsed the same way', function() {
        var compared = 0;
        for (var i = 0; i < N; i++) {
            var expected;
            try { expected = JSON.parse(oldStrip(docs[i])); } catch (e) { continue; }
            compared++;
            assert.deepEqual(parseJSONWithComments(docs[i]), expected, 'document ' + i + ': ' + JSON.stringify(docs[i]));
        }
        assert.ok(compared > 0, 'control: the old rule must parse some documents');
    });
});
