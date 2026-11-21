'use strict';
/**
 * #B1157 — `test/strip-comments.js`, the exact comment strip shared by the source-pin tests.
 *
 * §01 known answers: the shapes where a block regex run before anything else opens a phantom
 *     block (a `/*` inside a `//` comment, a string, a regex class, a template), and the `//` that
 *     is not a comment (a string, a URL, a template line). Where the old strip gets a case wrong,
 *     its wrong answer is pinned as the red arm.
 * §02 modes: `blocks` keeps `//` comments, `lines` blanks comment-only lines, `all` removes every
 *     comment; every mode keeps every newline.
 * §03 corpus: every `.js` file of the framework directory that compiles as a function body still
 *     compiles after `all()`, keeps its line count, and re-lexes with no comment left.
 * §04 `lines(src, { drop: true })`: each comment-only line goes with its newline (a line filter's
 *     shape, done exactly); each case records the old strip's answer; the option is opt-in.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var strip = require('../strip-comments');

// The strip this module replaces (a block regex first), kept only for the red arms.
var OLD = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');

// CASES:BEGIN
var CASES = [
    { id: '01.1', name: 'a `/*` inside a `//` comment opens no block', mode: 'lines',
      src: 'a();\n// handles /x/* routes\nb();\n/* real */ c();\n',
      expect: 'a();\n\nb();\n c();\n', oldLoses: 'b();' },
    { id: '01.2', name: 'a `/*` inside a string opens no block', mode: 'all',
      src: "var s = '/*';\nx();\n/* c */ y();\n",
      expect: "var s = '/*';\nx();\n y();\n", oldLoses: 'x();' },
    { id: '01.3', name: 'a `/*` inside a regex class opens no block', mode: 'all',
      src: 'var r = /[/*]+/g;\nz();\n/* c */ w();\n',
      expect: 'var r = /[/*]+/g;\nz();\n w();\n', oldLoses: 'z();' },
    { id: '01.4', name: 'a `/*` inside a template stays template text', mode: 'all',
      src: 'var t = `a ${b} /* not */ c`;\nq(); // tail\n',
      expect: 'var t = `a ${b} /* not */ c`;\nq(); \n', oldLoses: '/* not */' },
    { id: '01.5', name: 'a `//` inside a string or a URL is not a comment', mode: 'all',
      src: "var u = 'http://x/y'; // note\nvar v = \"a//b\";\n",
      expect: "var u = 'http://x/y'; \nvar v = \"a//b\";\n", oldLoses: null },
    { id: '01.6', name: 'a template line that starts with `//` is not a comment line', mode: 'lines',
      src: 'var t = `\n// not a comment\n`;\n  // real\nk();\n',
      expect: 'var t = `\n// not a comment\n`;\n\nk();\n', oldLoses: null },
    { id: '02.1', name: 'blocks keeps `//` comments and the newline of a block it removes', mode: 'blocks',
      src: 'a(); /* b */ c(); // d\n  // e\n/* f\n g */ h();\n',
      expect: 'a();  c(); // d\n  // e\n\n h();\n', oldLoses: null },
    { id: '02.2', name: 'lines blanks comment-only lines and keeps a trailing `//` comment', mode: 'lines',
      src: 'a(); /* b */ c(); // d\n  // e\n/* f\n g */ h();\n',
      expect: 'a();  c(); // d\n\n\n h();\n', oldLoses: null },
    { id: '02.3', name: 'all removes every comment', mode: 'all',
      src: 'a(); /* b */ c(); // d\n  // e\n/* f\n g */ h();\n',
      expect: 'a();  c(); \n  \n\n h();\n', oldLoses: null }
];
// CASES:END

describe('#B1157 §01–§02 — known answers and modes', function () {
    CASES.forEach(function (c) {
        it(c.id + ' ' + c.name, function () {
            var out = strip[c.mode](c.src);
            assert.equal(out, c.expect);
            assert.equal(out.split('\n').length, c.src.split('\n').length, 'every newline kept');
            if ( c.oldLoses ) {
                assert.ok(c.src.indexOf(c.oldLoses) > -1, 'the needle is in the source');
                assert.equal(c.src.replace(OLD, '').indexOf(c.oldLoses), -1, 'red arm: the old strip loses it');
                assert.ok(out.indexOf(c.oldLoses) > -1, 'the exact strip keeps it');
            }
        });
    });
});

describe('#B1157 §03 — corpus: the framework directory', function () {

    var files = [];
    (function walk(dir) {
        fs.readdirSync(dir).forEach(function (name) {
            var p = path.join(dir, name);
            var st = fs.lstatSync(p);
            if ( st.isSymbolicLink() || name === 'node_modules' || name.charAt(0) === '.' ) { return; }
            if ( st.isDirectory() ) { walk(p); return; }
            if ( /\.js$/.test(name) ) { files.push(p); }
        });
    })(FW);

    it('03.1 every file that compiles still compiles after all(), keeps its lines, and holds no comment', function () {
        var checked = 0, skipped = 0;
        files.forEach(function (f) {
            var raw = fs.readFileSync(f, 'utf8');
            try { new Function(raw); } catch (e) { skipped++; return; } // a module, a shebang or a fragment
            var out = strip.all(raw);
            assert.doesNotThrow(function () { new Function(out); }, f);
            assert.equal(out.split('\n').length, raw.split('\n').length, f + ': line count');
            var cls = strip.lex(out);
            assert.equal(cls.indexOf(1), -1, f + ': a line comment is left');
            assert.equal(cls.indexOf(3), -1, f + ': a block comment is left');
            checked++;
        });
        assert.ok(checked > 200, 'anti-vacuity: ' + checked + ' files checked, ' + skipped + ' skipped');
    });
});

// The old strip in full (the block regex, then the line filter), kept only to record its answer
// beside each §04 case: the same answer wherever the old strip was right.
function oldChain(src) {
    return src.replace(OLD, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

// DROP:BEGIN
var DROP_CASES = [
    { id: '04.1', name: 'a comment-only line goes with its newline; a blank line stays',
      src: 'a();\n   \n  // note\nb();\n',
      expect: 'a();\n   \nb();\n', old: 'a();\n   \nb();\n' },
    { id: '04.2', name: 'a line holding a block comment, then a `//` comment, goes too; a trailing `//` comment stays',
      src: 'x(); // why\n/* a */ // b\ny();\n',
      expect: 'x(); // why\ny();\n', old: 'x(); // why\ny();\n' },
    { id: '04.3', name: 'a line holding only a block comment stays, as an empty line',
      src: 'a();\n/* x */\nb();\n',
      expect: 'a();\n\nb();\n', old: 'a();\n\nb();\n' },
    { id: '04.4', name: 'the lines of a multi-line block comment stay, as empty lines (the old regex also removed the newline inside it)',
      src: 'a();\n/* x\n   y */\nb();\n',
      expect: 'a();\n\n\nb();\n', old: 'a();\n\nb();\n' },
    { id: '04.5', name: 'a template line that starts with `//` stays (the old filter dropped it)',
      src: 'var t = `\n// not a comment\n`;\n  // real\nk();\n',
      expect: 'var t = `\n// not a comment\n`;\nk();\n', old: 'var t = `\n`;\nk();\n' },
    { id: '04.6', name: 'a `/*` inside a `//` comment opens no block (the old regex deleted b(); and c();)',
      src: 'a();\n// handles /x/* routes\nb();\n/* real */ c();\n',
      expect: 'a();\nb();\n c();\n', old: 'a();\n' },
    { id: '04.7', name: 'a comment-only first or last line goes, and no newline is left behind',
      src: '// head\na();\n// tail',
      expect: 'a();', old: 'a();' }
];
// DROP:END

describe('#B1157 §04 — lines(src, { drop: true })', function () {

    DROP_CASES.forEach(function (c) {
        it(c.id + ' ' + c.name, function () {
            assert.equal(strip.lines(c.src, { drop: true }), c.expect);
            assert.equal(oldChain(c.src), c.old, 'the old strip\'s answer, as recorded');
        });
    });

    it('04.8 the option is opt-in: no opts, {}, null, drop false or a truthy value other than true keep the blanking', function () {
        var c = CASES.filter(function (x) { return x.id === '02.2'; })[0];
        [undefined, {}, null, { drop: false }, { drop: 1 }, { drop: 'true' }].forEach(function (o) {
            assert.equal(strip.lines(c.src, o), c.expect, String(JSON.stringify(o)));
        });
        assert.notEqual(strip.lines(c.src, { drop: true }), c.expect, 'control: drop changes this source');
    });
});
