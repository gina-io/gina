'use strict';
// helpers/json — block-comment stripping (#B568)
//
// Behavioural, through the REAL global `requireJSON`, on fixtures written per
// test. Negative arms — inputs the helper refuses — run in a child process,
// because the helper answers a parse failure with `console.emerg` followed by
// `process.exit(1)`, which would take the test runner down with it.
//
// What is pinned and why:
//   - the strip is LINEAR: an unterminated `/*` inside a string value, followed
//     by a long tail of lines, must return in milliseconds (the regex it
//     replaced backtracked ~2x per LF line and ~4x per CRLF line — a config
//     with a glob path near its top hung the bundle boot);
//   - a `/*` INSIDE A STRING VALUE is data, not a comment opener (the regex
//     ate `/**/` out of `"./lib/**/*"`, yielding `"./lib*"`);
//   - everything else is byte-for-byte the previous behaviour: block comments
//     are stripped only when the file carries a `/**` docblock; a `/*` outside
//     a string opens a block wherever it sits (including inside a `//` line
//     comment, a shape a live consumer config relies on); an unterminated
//     block outside a string is left verbatim, as the regex left it.
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var cp     = require('child_process');

var FW     = require('../fw');
var HELPER = path.join(FW, 'helpers/json/src/main.js');
require(HELPER)(); // installs the implicit global `requireJSON`

var tmp;
before(function() { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b568-')); });
after(function()  { fs.rmSync(tmp, { recursive: true, force: true }); });

function fixture(name, text) {
    var p = path.join(tmp, name);
    fs.writeFileSync(p, text);
    return p;
}

/** Parse `file` through the real helper in a child; returns { ok, value|error }. */
function childParse(file) {
    var outf = path.join(tmp, 'child-' + process.hrtime.bigint() + '.out');
    var script = 'require(process.argv[1])();'
        + 'var fs=require("fs");'
        + 'try { fs.writeFileSync(process.argv[3], "OK " + JSON.stringify(requireJSON(process.argv[2]))); }'
        + 'catch (e) { fs.writeFileSync(process.argv[3], "ERR " + String(e && e.message || e).split("\\n")[0]); }';
    cp.spawnSync(process.execPath, ['-e', script, HELPER, file, outf], { stdio: 'ignore', timeout: 20000 });
    var out = fs.existsSync(outf) ? fs.readFileSync(outf, 'utf8') : '';
    if (out.slice(0, 3) === 'OK ') return { ok: true,  value: JSON.parse(out.slice(3)) };
    return { ok: false, error: out.slice(4) || '(emerg exit — no output written)' };
}

function lines(n, eol) { return new Array(n + 1).join(eol); }

// ─── 01 — a `/*` inside a string value is data ───────────────────────────────

describe('01 - a /* inside a string value is preserved (the regex ate it)', function() {

    it('keeps a glob carrying /**/ intact when the file also carries a docblock', function() {
        // "./lib/**/*" contains the literal `/**`, which opens the block-strip
        // gate, and then `/**/` reads as an empty block comment to the regex —
        // it returned "./lib*". Measured on a vendored tsconfig in the wild.
        var f = fixture('glob.json', '/** build */\n{ "include": ["./lib/**/*"] }\n');
        var v = requireJSON(f);
        assert.equal(v.include[0], './lib/**/*');
    });

    it('keeps a certificate glob path intact beside a real block comment', function() {
        // Through a child: the regex this replaced stripped from the in-string
        // `/*` to the real comment's `*/`, leaving invalid JSON — and the helper
        // answers that with process.exit(1), which must not reach this runner.
        var f = fixture('cert.json', '/** doc */\n{\n  "ca": "/etc/ssl/*.example.pem", /* pinned */\n  "n": 1\n}\n');
        var r = childParse(f);
        assert.equal(r.ok, true, 'must parse: ' + JSON.stringify(r));
        assert.equal(r.value.ca, '/etc/ssl/*.example.pem');
        assert.equal(r.value.n, 1);
    });

    it('keeps the helper\'s own app2.json fixture values intact (gate closed, in-string /*)', function() {
        var f = path.join(FW, 'helpers/json/test/data/app2.json');
        if ( !fs.existsSync(f) ) { assert.fail('fixture moved: ' + f); }
        var v = requireJSON(f);
        var s = JSON.stringify(v);
        assert.ok(s.indexOf('/*.') > -1, 'the in-string glob must survive: ' + s.slice(0, 200));
    });
});

// ─── 02 — the strip is linear ────────────────────────────────────────────────

describe('02 - the strip is linear on an unterminated in-string /* with a long tail', function() {

    it('LF tail: 28 lines after the /* return in under 100 ms (regex: ~1.3 s and doubling per line)', function() {
        var f = fixture('lf.json', '/** doc */\n{ "ca": "/x/*.pem"' + lines(28, '\n') + '}\n');
        var t = Date.now();
        var v = requireJSON(f);
        var ms = Date.now() - t;
        assert.equal(v.ca, '/x/*.pem');
        assert.ok(ms < 100, 'took ' + ms + ' ms');
    });

    it('CRLF tail: 15 lines after the /* return in under 100 ms (regex: ~1.3 s and 4x per line)', function() {
        var f = fixture('crlf.json', '/** doc */\r\n{ "ca": "/x/*.pem"' + lines(15, '\r\n') + '}\r\n');
        var t = Date.now();
        var v = requireJSON(f);
        var ms = Date.now() - t;
        assert.equal(v.ca, '/x/*.pem');
        assert.ok(ms < 100, 'took ' + ms + ' ms');
    });

    it('a 7 MB comment-free fixture still parses in well under a second', function() {
        var f = path.join(FW, 'lib/collection/test/data/hotel.json');
        if ( !fs.existsSync(f) ) { assert.fail('fixture moved: ' + f); }
        var t = Date.now();
        var v = requireJSON(f);
        var ms = Date.now() - t;
        assert.ok(Array.isArray(v) && v.length > 100);
        assert.ok(ms < 1000, 'took ' + ms + ' ms');
    });
});

// ─── 03 — previous behaviour, byte for byte ──────────────────────────────────

describe('03 - previous behaviour is kept outside the two fixes', function() {

    it('a /** docblock and a /* … */ block are both stripped', function() {
        var f = fixture('blocks.json', '/**\n * head\n */\n{\n  /* a */ "a": 1,\n  "b": 2 /* b */\n}\n');
        assert.deepEqual(requireJSON(f), { a: 1, b: 2 });
    });

    it('a /* inside a // line comment opens a block, as before (a live consumer config relies on it)', function() {
        var f = fixture('line-opens-block.json',
            '{\n  "webroot": "/auth" // trailing note    /**\n#     * more\n#     */\n  , "n": 1\n}\n');
        assert.deepEqual(requireJSON(f), { webroot: '/auth', n: 1 });
    });

    it('an unterminated /* inside a // line comment, with the gate open, is harmless (the line strip removes it)', function() {
        var f = fixture('line-unterminated.json', '/** doc */\n{\n  // see /* this\n  "a": 1\n}\n');
        assert.deepEqual(requireJSON(f), { a: 1 });
    });

    it('single-star /* … */ with NO /** anywhere is still not stripped (gate closed — parse fails)', function() {
        var f = fixture('single-star.json', '{ /* c */ "a": 1 }\n');
        var r = childParse(f);
        assert.equal(r.ok, false, 'must refuse, as before: ' + JSON.stringify(r));
    });

    it('an unterminated /* OUTSIDE any string is left verbatim, so the parse fails as before', function() {
        var f = fixture('unterminated.json', '/** doc */\n{ "a": 1 } /* never closed\n\n');
        var r = childParse(f);
        assert.equal(r.ok, false, 'must refuse, as before: ' + JSON.stringify(r));
    });

    it('the framework\'s own scaffold configs still parse (gate closed, /* inside // comments)', function() {
        ['core/template/conf/settings.json', 'core/template/conf/env.json'].forEach(function(rel) {
            var f = path.join(FW, rel);
            assert.ok(fs.existsSync(f), 'scaffold moved: ' + rel);
            var v = requireJSON(f);
            assert.equal(typeof v, 'object');
        });
    });

    it('URL and // inside strings are untouched (the line-comment stage is unchanged)', function() {
        // the trailing comment sits on its OWN line: the per-line strip keeps a
        // line whose leftmost `//` is a URL's, so `"u": …, // note` would be data.
        var f = fixture('url.json', '/** doc */\n{\n  "u": "https://example.com/a//b",\n  // note\n  "v": "//cdn"\n}\n');
        assert.deepEqual(requireJSON(f), { u: 'https://example.com/a//b', v: '//cdn' });
    });
});

// ─── 04 — source pins ────────────────────────────────────────────────────────

describe('04 - source pins', function() {

    var src;
    before(function() { src = fs.readFileSync(HELPER, 'utf8'); });

    it('the backtracking regex is gone from the CODE (its text survives only in the JSDoc naming it)', function() {
        var needle = "([^*]|[\\r\\n]|(\\*+([^*\\/]|[\\r\\n])))*";
        // The scanner's JSDoc quotes the regex it replaced, so a raw absence pin
        // would fail on the fix itself. Strip comments first — and prove the strip
        // removed something, so a broken strip cannot pass this vacuously.
        var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(src.indexOf(needle) > -1, 'control: the raw file must still name the old regex in its JSDoc');
        assert.equal(code.indexOf(needle), -1, 'the old block-comment regex is still present in executable code');
        assert.ok(code.indexOf('function stripBlockComments') > -1, 'the scanner must be present in code');
    });

    it('no lookbehind regex is used anywhere (the :192 constraint from require-json.test.js)', function() {
        assert.equal(src.indexOf('(?<!'), -1);
    });

    it('the /** gate is kept and now guards the scanner', function() {
        var gate = src.indexOf('/\\/\\*\\*/.test(jsonStr)');
        var call = src.indexOf('stripBlockComments(jsonStr)', gate);
        assert.ok(gate > -1, 'gate missing');
        assert.ok(call > gate && call - gate < 200, 'the scanner call must sit inside the gate');
    });
});
