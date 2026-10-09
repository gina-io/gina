'use strict';
/**
 * The log escapers (#B830): every private copy says the same thing.
 *
 * A value a client supplied must not be able to start a log line of its own
 * (CWE-117), so the sites that write one into a log message pass it through
 * `escapeLogControlChars` (control characters become visible escapes), and the
 * sites that print an error detail pass it through `escapeLogDetailKeepFrames`
 * (the same, but a real line feed is kept before a stack-frame line). The two
 * functions are deliberately private per module, the way `escapeForJsonString`
 * is: no single requireable home serves the logger, the server engines, the
 * controller, the render delegate, the context helper, lib/lane, and the two
 * files that are also in the browser bundle (lib/routing, the validator).
 *
 * Nine copies of the first and six of the second can drift. This file is the
 * guard: it extracts each copy from its source and executes those exact bytes.
 *
 *   01  census — each copy is found exactly once, and the walk that extracts it is sound
 *   02  identity — the `function` copies are byte-identical once dedented
 *   03  behaviour — every copy agrees on every input, and the escaped set is exactly
 *       C0, DEL, C1, U+2028 and U+2029
 *   04  the redaction's decoded reading (lib/logger/src/redact.js) reads back what the
 *       escapers write, and nothing else
 *   05  the frame-keeping escape: its contract, including the accepted residual
 *   06  the browser bundle carries its two copies with the same set
 *
 * No replica: every arm runs source text sliced from the tree. The framework
 * directory can be overridden (`GINA_B830_FW`) to run the whole file against
 * another tree's bytes.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW = process.env.GINA_B830_FW || path.resolve(require('../fw'));

/** Characters built from their code, never typed: a source file must not hold them raw. */
function ch(code) { return String.fromCharCode(code); }
var BS = ch(92), LF = ch(10), CR = ch(13), TAB = ch(9), NBSP = ch(0xa0), LS = ch(0x2028), PS = ch(0x2029), NEL = ch(0x85);

var ESC_DECL  = 'function escapeLogControlChars(value) {';
var KEEP_DECL = 'function escapeLogDetailKeepFrames(detail) {';

/** Every file holding a copy: its escaper declaration, and whether it holds the frame-keeping one. */
var COPIES = [
    { name: 'logger',      rel: 'lib/logger/src/main.js',                            esc: 'var escapeLogControlChars = function(s) {', keep: false },
    { name: 'server',      rel: 'core/server.js',                                    esc: ESC_DECL, keep: true  },
    { name: 'isaac',       rel: 'core/server.isaac.js',                              esc: ESC_DECL, keep: true  },
    { name: 'controller',  rel: 'core/controller/controller.js',                     esc: ESC_DECL, keep: true  },
    { name: 'render-swig', rel: 'core/controller/controller.render-swig.js',         esc: ESC_DECL, keep: true  },
    { name: 'context',     rel: 'helpers/context.js',                                esc: ESC_DECL, keep: true  },
    { name: 'lane',        rel: 'lib/lane/src/main.js',                              esc: ESC_DECL, keep: true  },
    { name: 'routing',     rel: 'lib/routing/src/main.js',                           esc: ESC_DECL, keep: false },
    { name: 'validator',   rel: 'core/plugins/lib/validator/src/form-validator.js',  esc: ESC_DECL, keep: false }
];

var SRC = {};
COPIES.forEach(function (c) { SRC[c.name] = fs.readFileSync(path.join(FW, c.rel), 'utf8'); });

/**
 * The text of one function, from its declaration to its matching closing brace.
 * Instrument: the declaration must appear exactly once, and the braces must balance.
 */
function fnText(src, decl, label) {
    var i = src.indexOf(decl);
    if (i < 0) { throw new Error('[instrument] ' + label + ': declaration not found'); }
    if (src.indexOf(decl, i + 1) > -1) { throw new Error('[instrument] ' + label + ': declaration not unique'); }
    var depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
        var c = src.charAt(j);
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
    }
    if (!started || depth !== 0) { throw new Error('[instrument] ' + label + ': braces do not balance'); }
    return src.slice(i, j);
}
/** The same text with the declaration line's indentation removed from every line. */
function dedent(src, decl, text) {
    var i = src.indexOf(decl), lineStart = src.lastIndexOf('\n', i) + 1, pad = src.slice(lineStart, i);
    if (pad.replace(/ /g, '') !== '') { return text; }                // not at an indented line start: leave as is
    return text.split('\n').map(function (l, n) { return (n > 0 && l.indexOf(pad) === 0) ? l.slice(pad.length) : l; }).join('\n');
}

var ESC_TEXT = {}, KEEP_TEXT = {}, E = {}, K = {};
COPIES.forEach(function (c) {
    ESC_TEXT[c.name] = fnText(SRC[c.name], c.esc, c.name + ' escaper');
    E[c.name] = new Function(ESC_TEXT[c.name] + '\nreturn escapeLogControlChars;')();
    if (c.keep) {
        KEEP_TEXT[c.name] = fnText(SRC[c.name], KEEP_DECL, c.name + ' frame-keeping escaper');
        // the frame-keeping function calls its file's OWN escaper: build the pair from that file's bytes
        K[c.name] = new Function(ESC_TEXT[c.name] + '\n' + KEEP_TEXT[c.name] + '\nreturn escapeLogDetailKeepFrames;')();
    }
});
var ESC_NAMES = Object.keys(E), KEEP_NAMES = Object.keys(K);

/** The code points every copy is run over: U+0000 to U+00FF, the two line separators, and four that must pass. */
var FUZZ = [];
for (var cp = 0; cp <= 0xff; cp++) { FUZZ.push(cp); }
FUZZ.push(0x2028, 0x2029, 0x2027, 0x202a, 0xfeff, 0x3000);
function inSet(code) { return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029; }
/** Does `s` hold a raw character of the escaped set? (Built from codes: no raw separator in this file.) */
var RAW_SET_RE = new RegExp('[' + BS + 'u0000-' + BS + 'u001f' + BS + 'u007f-' + BS + 'u009f' + BS + 'u2028' + BS + 'u2029]');


describe('01 - census: every copy is found, once', function () {

    it('nine files hold the escaper and six of them the frame-keeping one', function () {
        assert.equal(ESC_NAMES.length, 9);
        assert.deepEqual(KEEP_NAMES, ['server', 'isaac', 'controller', 'render-swig', 'context', 'lane']);
    });

    it('INSTRUMENT: the extraction refuses a declaration that is absent or repeated', function () {
        assert.throws(function () { fnText('var a = 1;', ESC_DECL, 'x'); }, /declaration not found/);
        assert.throws(function () { fnText(ESC_DECL + ' }\n' + ESC_DECL + ' }', ESC_DECL, 'x'); }, /declaration not unique/);
        assert.throws(function () { fnText(ESC_DECL + ' if (a) { ', ESC_DECL, 'x'); }, /braces do not balance/);
        assert.equal(fnText('x;\n' + ESC_DECL + ' if (a) { b(); } }\ny;', ESC_DECL, 'x'), ESC_DECL + ' if (a) { b(); } }');
    });

    it('no other file of the framework declares an escaper that this census does not know', function () {
        // a tenth copy must be added to COPIES, or it is never compared with the others
        var known = COPIES.map(function (c) { return c.rel; }), extra = [];
        (function walk(dir, rel) {
            fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
                if (d.name === 'node_modules' || d.name === 'dist' || d.name === 'test' || d.name.charAt(0) === '.') { return; }
                var p = path.join(dir, d.name), r = rel ? rel + '/' + d.name : d.name;
                if (d.isSymbolicLink()) { return; }
                if (d.isDirectory()) { return walk(p, r); }
                if (!/\.js$/.test(d.name) || known.indexOf(r) > -1) { return; }
                var t = fs.readFileSync(p, 'utf8');
                if (t.indexOf('escapeLogControlChars = function') > -1 || t.indexOf('function escapeLogControlChars') > -1 || t.indexOf('function escapeLogDetailKeepFrames') > -1) { extra.push(r); }
            });
        })(FW, '');
        assert.deepEqual(extra, []);
    });
});


describe('02 - identity: the function copies are the same bytes', function () {

    var FN_COPIES = ['server', 'isaac', 'controller', 'render-swig', 'context', 'lane', 'routing'];
    function decl(name) { return COPIES.filter(function (c) { return c.name === name; })[0].esc; }

    it('the seven `function` copies of the escaper are byte-identical once dedented', function () {
        var ref = dedent(SRC.server, ESC_DECL, ESC_TEXT.server);
        FN_COPIES.forEach(function (n) {
            assert.equal(dedent(SRC[n], decl(n), ESC_TEXT[n]), ref, n + ' differs from core/server.js');
        });
    });

    it('the validator copy differs by spacing only, and the logger copy by its parameter name and form', function () {
        var squash = function (s) { return s.replace(/\s+/g, ''); };
        assert.equal(squash(ESC_TEXT.validator), squash(ESC_TEXT.server));
        assert.equal(squash(ESC_TEXT.logger).replace('varescapeLogControlChars=function(s){returnString(s)', 'functionescapeLogControlChars(value){returnString(value)'), squash(ESC_TEXT.server));
    });

    it('the six copies of the frame-keeping escaper are byte-identical once dedented', function () {
        var ref = dedent(SRC.server, KEEP_DECL, KEEP_TEXT.server);
        KEEP_NAMES.forEach(function (n) {
            assert.equal(dedent(SRC[n], KEEP_DECL, KEEP_TEXT[n]), ref, n + ' differs from core/server.js');
        });
    });

    it('CONTROL: the comparison tells two different bodies apart', function () {
        assert.notEqual(dedent(SRC.server, ESC_DECL, ESC_TEXT.server), dedent(SRC.server, KEEP_DECL, KEEP_TEXT.server));
    });
});


describe('03 - behaviour: one answer per input, and exactly one escaped set', function () {

    it('the nine copies agree on every code point of the fuzz set', function () {
        var disagree = [];
        FUZZ.forEach(function (code) {
            var input = 'a' + ch(code) + 'b', first = E.server(input);
            ESC_NAMES.forEach(function (n) { if (E[n](input) !== first) { disagree.push(n + ' U+' + code.toString(16)); } });
        });
        assert.deepEqual(disagree, []);
    });

    it('a character of the set is written as a visible escape, any other is written as it is', function () {
        var wrong = [];
        FUZZ.forEach(function (code) {
            var input = 'a' + ch(code) + 'b', out = E.server(input);
            if (inSet(code) ? (out === input || RAW_SET_RE.test(out)) : (out !== input)) { wrong.push('U+' + code.toString(16)); }
        });
        assert.deepEqual(wrong, []);
        assert.equal(FUZZ.filter(inSet).length, 32 + 33 + 2, 'C0 (32), DEL and C1 (33), the two separators');
    });

    it('the three short forms and the long form', function () {
        assert.equal(E.server('a' + LF + 'b'), 'a' + BS + 'nb');
        assert.equal(E.server('a' + CR + 'b'), 'a' + BS + 'rb');
        assert.equal(E.server('a' + TAB + 'b'), 'a' + BS + 'tb');
        assert.equal(E.server('a' + ch(7) + 'b'), 'a' + BS + 'u0007b');
        assert.equal(E.server('a' + ch(0x1b) + '[31m'), 'a' + BS + 'u001b[31m');
        assert.equal(E.server('a' + ch(0x7f) + NEL + ch(0x9b) + 'b'), 'a' + BS + 'u007f' + BS + 'u0085' + BS + 'u009bb');
        assert.equal(E.server('a' + LS + 'b' + PS + 'c'), 'a' + BS + 'u2028b' + BS + 'u2029c');
    });

    it('a printable character, a quote and a WRITTEN backslash sequence are left alone', function () {
        var s = 'C:' + BS + 'new' + BS + 'temp "x" ' + "'y'" + ' ' + NBSP + ' ' + ch(0xe9) + ch(0xd83d) + ch(0xde00);
        ESC_NAMES.forEach(function (n) { assert.equal(E[n](s), s, n); });
    });

    it('a value that is not a string is coerced first', function () {
        ESC_NAMES.forEach(function (n) {
            assert.equal(E[n](null), 'null', n);
            assert.equal(E[n](undefined), 'undefined', n);
            assert.equal(E[n](12), '12', n);
            assert.equal(E[n](['x' + LF + 'y', 'z']), 'x' + BS + 'ny,z', n);
        });
    });
});


describe('04 - the redaction reads back exactly what the escapers write', function () {
    var redact = require(path.join(FW, 'lib/logger/src/redact.js'));

    it('every escaped character decodes to itself; an unescaped one leaves nothing to decode', function () {
        var wrong = [];
        FUZZ.forEach(function (code) {
            var input = 'a' + ch(code) + 'b', written = E.server(input), view = redact.decodeView(written);
            if (inSet(code)) {
                if (view === null || view.text !== input) { wrong.push('escaped U+' + code.toString(16)); }
            } else if (code !== 92 && view !== null) {
                wrong.push('unescaped U+' + code.toString(16));
            }
        });
        assert.deepEqual(wrong, []);
    });

    it('a written `\\uXXXX` outside the set is not decoded (the two grammars stay in step)', function () {
        assert.equal(redact.decodeView('a' + BS + 'u0041b'), null);
        assert.equal(redact.decodeView('a' + BS + 'u00a0b'), null);
        assert.equal(redact.decodeView('a' + BS + 'u2027b'), null);
        assert.equal(redact.decodeView('a' + BS + 'u001Bb').text, 'a' + ch(0x1b) + 'b', 'either hex case is read');
    });
});


describe('05 - the frame-keeping escape', function () {

    /** One arm: the six copies agree, and the answer is the expected one. */
    function arm(input, expected, label) {
        KEEP_NAMES.forEach(function (n) { assert.equal(K[n](input), expected, label + ' (' + n + ')'); });
    }
    var FORGED = '[2026 Oct 09 21:00:00] [info   ][app@proj] forged';

    it('a line break that no frame follows becomes a visible escape (the 404 and 405 messages)', function () {
        arm('Page not found: ' + LF + '/nope', 'Page not found: ' + BS + 'n/nope', '404');
        arm('Method Not Allowed.' + LF + ' `/x` does not support `PUT`', 'Method Not Allowed.' + BS + 'n `/x` does not support `PUT`', '405');
    });

    it('a client value holding a break and a record-shaped tail stays on its line', function () {
        arm('`x' + LF + FORGED + '` is not a configured upload group.', '`x' + BS + 'n' + FORGED + '` is not a configured upload group.', 'record-shaped');
        arm('a' + CR + 'FORGED', 'a' + BS + 'rFORGED', 'lone CR');
    });

    it('a real stack keeps its frame lines, and a line between two frames does not', function () {
        var stack = 'Error: x' + LF + '    at f (a.js:1:1)' + LF + '        -> /src/a.ts:10:5' + LF + '    at g (b.js:2:2)';
        arm(stack, 'Error: x' + LF + '    at f (a.js:1:1)' + BS + 'n        -> /src/a.ts:10:5' + LF + '    at g (b.js:2:2)', 'source-map line');
        arm('Error: x' + CR + LF + '    at f (a.js:1:1)', 'Error: x' + BS + 'r' + LF + '    at f (a.js:1:1)', 'CRLF before a frame');
        arm('Error: a' + LF + 'caused by: Error: b' + LF + '    at g (b.js:2:2)', 'Error: a' + LF + 'caused by: Error: b' + LF + '    at g (b.js:2:2)', 'cause chain');
    });

    it('a stack raised by the engine: only frame lines start a physical line', function () {
        // what an engine puts between the message and the frames differs (a require stack, a source
        // excerpt, an assertion diff — or nothing at all), so the arm states the contract, not a shape
        var raised = [];
        try { require('/nonexistent/b830-parity-module'); } catch (e1) { raised.push(e1); }
        try { new Function('return (1 +;')(); } catch (e2) { raised.push(e2); }
        try { assert.deepStrictEqual({ a: 1, b: [1, 2] }, { a: 2, b: [1, 3] }); } catch (e3) { raised.push(e3); }
        try { null.b830; } catch (e4) { raised.push(e4); }
        raised.push(new Error('made here' + LF + 'second line of the message'));
        var stacks = raised.map(function (e) { return e && e.stack; }).filter(function (s) { return typeof s === 'string'; });
        var frames = 0;
        stacks.forEach(function (stack, n) {
            var out = K.server(stack);
            KEEP_NAMES.forEach(function (name) { assert.equal(K[name](stack), out, 'copies agree on stack ' + n + ' (' + name + ')'); });
            out.split(LF).slice(1).forEach(function (l) {
                frames++;
                assert.ok(l.charAt(0) === ' ' && l.replace(/^ +/, '').indexOf('at ') === 0, 'a non-frame line starts a physical line in stack ' + n + ': ' + l.slice(0, 60));
            });
        });
        assert.ok(frames > 0, 'CONTROL: at least one of the stacks holds a frame line, so the check above ran');
    });

    it('ACCEPTED RESIDUAL: a line shaped like a frame is kept, whatever follows `at`', function () {
        // the detail logs a caller-passed stack whole, so a crafted frame line cannot be told from a real one
        arm('bad' + LF + '    at forged (evil.js:1:1)', 'bad' + LF + '    at forged (evil.js:1:1)', 'frame-shaped');
        arm('bad' + LF + ' at ' + FORGED, 'bad' + LF + ' at ' + FORGED, 'whitespace + at + any text');
        arm('bad' + LF + 'caused by: ' + FORGED, 'bad' + LF + 'caused by: ' + FORGED, 'caused by: + any text');
        arm('bad' + LF + NBSP + 'at forged', 'bad' + LF + NBSP + 'at forged', 'a no-break space counts as whitespace');
        // a kept line still has its own control characters escaped
        arm('bad' + LF + TAB + 'at forged', 'bad' + LF + BS + 'tat forged', 'TAB + at');
        arm('bad' + LF + LS + 'at forged', 'bad' + LF + BS + 'u2028at forged', 'line separator + at');
    });

    it('nothing to print: null and undefined give the empty string, anything else is coerced', function () {
        arm(null, '', 'null');
        arm(undefined, '', 'undefined');
        arm({ a: 1 }, '[object Object]', 'object');
        arm('', '', 'empty');
    });
});


describe('06 - the browser bundle carries its two copies', function () {
    var DIST = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');
    function count(text, needle) { return text.split(needle).length - 1; }
    var SET = '[' + BS + 'u0000-' + BS + 'u001f' + BS + 'u007f-' + BS + 'u009f' + BS + 'u2028' + BS + 'u2029]';

    it('the readable bundle holds the validator copy and the routing copy, both with the full set', function () {
        var raw = fs.readFileSync(path.join(DIST, 'gina.js'), 'utf8');
        assert.equal(count(raw, ESC_DECL), 2);
        assert.equal(count(raw, 'replace(/' + SET + '/g'), 2);
    });

    it('the minified bundle holds the set twice, and no raw line separator', function () {
        var min = fs.readFileSync(path.join(DIST, 'gina.min.js'), 'utf8');
        assert.equal(count(min, 'replace(/' + SET + '/g'), 2);
        assert.equal(min.indexOf(LS), -1);
        assert.equal(min.indexOf(PS), -1);
        assert.equal(count(min, 'u007f]/g'), 0, 'the narrower set of the first draft is gone');
    });

    it('CONTROL: the counter fires on a text that holds the needle', function () {
        assert.equal(count('a' + SET + 'b' + SET, SET), 2);
    });
});
