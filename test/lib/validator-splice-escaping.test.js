'use strict';
/**
 * #B600 / #B601 / #B602 (gh#77) — a referenced field value SPLICED into text.
 *
 * An `is` condition such as `$password === $password-confirm` is resolved by
 * splicing field values into text, at three places:
 *   - the plugin path (`getDynamisedRules`, validator `main.js`) splices them
 *     into the STRINGIFIED rule set, then parses it back;
 *   - the engine path (`is()`, `form-validator.js`) splices them into the
 *     condition text, which a grammar-locked matcher then reads (this is the
 *     route-requirements path);
 *   - the client `query` path splices them into the request body's JSON text.
 *
 * Three defects lived in those splices:
 *   - #B600 — values were concatenated between quotes UNESCAPED, through STRING
 *     replacements: a `"`, `\` or control character in a referenced value made
 *     the closing parse throw out of the whole validation pass (a dead submit
 *     in the browser, an error on the server), and `$&` / `$'` / `$$` in a
 *     value were expanded as replacement patterns. Fix: a JSON-string escaper
 *     at the four plugin splice sites (two levels, `quoteForDynamisedRules`),
 *     function replacers everywhere, a guarded parse, a widened string operand
 *     decoded as a JSON literal (read verbatim when an authored literal is not
 *     valid JSON, exactly as before), and a query-body decode that restores
 *     each spliced value instead of deleting every quote.
 *   - #B601 — the `(` / `)` / `return` strip ran over the compared VALUES too,
 *     so two values differing only by those characters compared as equal. It
 *     now runs outside string literals only.
 *   - #B602 — the evaluation was gated on the condition containing an ASCII
 *     letter or digit run, so values made only of symbols or non-ASCII letters
 *     (`!!!`, `é€`) always compared as a mismatch. Reproduces on the plugin
 *     path, and on the engine path with a literal condition only: through `$`
 *     tokens the gate matches the token NAMES (measured pre-fix).
 *
 * No replicas of shipped code: §01/§02 drive the REAL plugin and engine;
 * §03-§05 execute functions EXTRACTED from the shipped source (declaration
 * anchored at a line start, control-gated on exactly one match, brace-walked).
 * The only replica is `oldStrip()` in §03 — the REMOVED query-body cleanup,
 * kept as the reference the new decode must stay byte-identical to.
 *
 * Seam: GINA_VALIDATOR_SRC_DIR points every source read AND require at another
 * copy of the plugin's src dir — the same dir of a detached worktree at the
 * pre-fix commit (its relative requires need the framework tree around it).
 *
 * Red-first buckets (pre-fix bytes, measured):
 *   MUST-RED  — §01.2-§01.8, §02.2, §02.4-§02.7, §02.9, all of §03/§04 (their
 *               constructs do not exist: the extraction controls fail first),
 *               §05.2-§05.4, the change pins of §06, §07 (dist).
 *   MUST-GREEN (premises / controls) — §01.1, §01.9, §01.10, §02.1, §02.3,
 *               §02.8, §02.10, §05.1, the premise pins of §06.
 * At the src-fixed / dist-stale midstate only §07 stays red.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');

var FW = require('../fw');

process.env.NODE_ENV_IS_DEV = process.env.NODE_ENV_IS_DEV || 'false';
process.setMaxListeners(0);
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
/* global getContext, setContext */
if (typeof getContext('gina') === 'undefined') { setContext('gina', { forms: null }); }
setContext('bundle', 'spliceescapingbundle');

var SRC_DIR = process.env.GINA_VALIDATOR_SRC_DIR || path.join(FW, 'core/plugins/lib/validator/src');
var MAIN_PATH = path.join(SRC_DIR, 'main.js');
var ENGINE_PATH = path.join(SRC_DIR, 'form-validator.js');
var MAIN_SRC = fs.readFileSync(MAIN_PATH, 'utf8');
var ENGINE_SRC = fs.readFileSync(ENGINE_PATH, 'utf8');
var DIST_RAW_PATH = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN_PATH = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var Validator = require(MAIN_PATH);
var FormValidator = require(ENGINE_PATH);

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** Comment-stripped view — code pins must not match narrative comments. */
function activeLines(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/** Every start offset of `re` (global + multiline) in `src`. */
function declOffsets(src, re) {
    var out = [], m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) { out.push(m.index); }
    return out;
}

/**
 * Slices ONE declaration: anchored at a line start (an `// EO` marker or a prose
 * mention cannot match), control-gated on exactly one hit, then a started-flag
 * brace walk to the matching close. Safe only for bodies with no brace inside a
 * string or regex literal — true of every function sliced here.
 */
function sliceDecl(src, re, label) {
    var hits = declOffsets(src, re);
    if (hits.length !== 1) {
        throw new Error(label + ': expected exactly one declaration, found ' + hits.length);
    }
    var depth = 0, started = false, i = hits[0];
    for (; i < src.length; i++) {
        var c = src.charAt(i);
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    if (!started || depth !== 0) { throw new Error(label + ': unbalanced braces'); }
    return src.slice(hits[0], i);
}

/**
 * Terminator-anchored slice, for a function whose comments carry braces — the
 * replace-code `// was:` records do (`getDynamisedRules` keeps a lone `{` in one),
 * and a brace walk counts them: from the line-start declaration to the JSDoc block
 * that opens the NEXT declaration.
 */
function sliceUntilNextDoc(src, declRe, endLiteral, label) {
    var hits = declOffsets(src, declRe);
    if (hits.length !== 1) {
        throw new Error(label + ': expected exactly one declaration, found ' + hits.length);
    }
    var endAt = src.indexOf(endLiteral, hits[0]);
    if (endAt < 0) { throw new Error(label + ': end anchor not found'); }
    var docAt = src.lastIndexOf('/**', endAt);
    if (docAt <= hits[0]) { throw new Error(label + ': no JSDoc opener before the end anchor'); }
    var slice = src.slice(hits[0], docAt).replace(/\s+$/, '');
    if (slice.charAt(slice.length - 1) !== '}') { throw new Error(label + ': slice does not end on a closing brace'); }
    return slice;
}

/** Declaration anchors: `var name = function(` (main.js) / `function name(` (engine module scope). */
function varDecl(name) { return new RegExp('^[ \\t]*var ' + name + ' = function\\(', 'mg'); }
function fnDecl(name) { return new RegExp('^function ' + name + '\\(', 'mg'); }

/** Runs `build` once; keeps the error so each arm fails with it instead of the whole file. */
function tryLoad(build) {
    try { return { value: build(), error: null }; } catch (e) { return { value: null, error: e }; }
}
function need(loaded, label) {
    if (!loaded.value) { throw new Error(label + ' could not be extracted: ' + loaded.error.message); }
    return loaded.value;
}

var MAIN_HELPERS = tryLoad(function () {
    return new Function(
        sliceDecl(MAIN_SRC, varDecl('escapeForJsonString'), 'main.js escapeForJsonString') + ';\n'
        + sliceDecl(MAIN_SRC, varDecl('quoteForDynamisedRules'), 'main.js quoteForDynamisedRules') + ';\n'
        + 'return { escapeForJsonString: escapeForJsonString, quoteForDynamisedRules: quoteForDynamisedRules };'
    )();
});
var ENGINE_HELPERS = tryLoad(function () {
    return new Function(
        sliceDecl(ENGINE_SRC, fnDecl('escapeForJsonString'), 'form-validator.js escapeForJsonString') + '\n'
        + sliceDecl(ENGINE_SRC, fnDecl('decodeSplicedQuotes'), 'form-validator.js decodeSplicedQuotes') + '\n'
        + 'return { escapeForJsonString: escapeForJsonString, decodeSplicedQuotes: decodeSplicedQuotes };'
    )();
});

/**
 * Compiles main.js's `getDynamisedRules` (+ `getCastedValue`, + the #B600 helpers when
 * present — the pre-fix bodies never call them) in a scope with an injected `console`,
 * so its loop-2 DOM fallback and its parse can be driven without a DOM. `stubCast`
 * replaces `getCastedValue` (the parse-guard arm).
 */
function compileSplice(stubCast) {
    var parts = [];
    ['escapeForJsonString', 'quoteForDynamisedRules'].forEach(function (name) {
        if (declOffsets(MAIN_SRC, varDecl(name)).length > 0) {
            parts.push(sliceDecl(MAIN_SRC, varDecl(name), name));
        }
    });
    if (!stubCast) {
        parts.push(sliceUntilNextDoc(MAIN_SRC, varDecl('getCastedValue'), 'var formatFields', 'getCastedValue'));
    }
    parts.push(sliceUntilNextDoc(MAIN_SRC, varDecl('getDynamisedRules'), '     * Validate form', 'getDynamisedRules'));
    var warns = [];
    var fakeConsole = {
        warn: function (m) { warns.push(String(m)); },
        log: function () {}, debug: function () {}, error: function () {}
    };
    var noLiveCheck = function () { throw new Error('getFormValidationInfos must not run in a full-form pass'); };
    var body = parts.join(';\n') + ';\nreturn getDynamisedRules;';
    var fn = stubCast
        ? new Function('getFormValidationInfos', 'console', 'getCastedValue', body)(noLiveCheck, fakeConsole, stubCast)
        : new Function('getFormValidationInfos', 'console', body)(noLiveCheck, fakeConsole);
    return { getDynamisedRules: fn, warns: warns };
}

/** Plugin auto path (server `Validator` -> validate -> getDynamisedRules -> engine). */
function drivePlugin(rules, data) {
    var res = Validator(JSON.parse(JSON.stringify(rules)), Object.assign({}, data), 'splice-escaping-form');
    var errs = {};
    for (var f in res.error || {}) { errs[f] = Object.keys(res.error[f] || {}); }
    return { formValid: res.isValid(), errs: errs };
}
function isErr(r, field) { return (r.errs[field] || []).indexOf('is') > -1; }

var CONFIRM = {
    password: { isRequired: true },
    'password-confirm': { isRequired: true, is: ['$password === $password-confirm', 'mismatch'] }
};
function confirmPair(a, b) { return drivePlugin(CONFIRM, { password: a, 'password-confirm': b }); }

var NUMBER = {
    amount: { isNumber: true },
    'amount-confirm': { isNumber: true, is: ['$amount === $amount-confirm', 'mismatch'] }
};
function numberPair(a, b) { return drivePlugin(NUMBER, { amount: a, 'amount-confirm': b }); }

/** Engine path: `is()`'s OWN `$` substitution (the route-requirements path). */
function driveIs(a, b, condition) {
    var fv = new FormValidator({ password: a, 'password-confirm': b });
    var f = fv['password-confirm'].is(condition || '$password === $password-confirm', 'mismatch');
    return { valid: f.valid, errs: Object.keys(f.errors || {}) };
}

/** Values that used to throw, or to be rewritten, when spliced. */
var SPECIALS = [
    'ab"cd', 'say "hi"', 'ab\\cd', 'ends\\', '\\', '"', '\\"', 'ab\ncd', 'ab\r\ncd', 'ab\tcd',
    'ab\u0000cd', 'ab\u001fcd', 'ab$&cd', "ab$'cd", 'ab$`cd', 'a" === "a', ' ', 'é€', '😀', '\ud800', ''
];

// ---------------------------------------------------------------------------
// §01 — behaviour, plugin path (server `Validator`)
// ---------------------------------------------------------------------------
describe('validator-splice-escaping §01 — plugin path (#B600 / #B601 / #B602)', function () {

    it('01.1 - control: a plain confirmation validates, a plain mismatch errors', function () {
        assert.equal(confirmPair('abcd1234', 'abcd1234').formValid, true);
        var ko = confirmPair('abcd1234', 'abce1234');
        assert.equal(ko.formValid, false);
        assert.deepEqual(ko.errs['password-confirm'], ['is']);
    });

    it('01.2 - quotes, backslashes, control characters and $-patterns compare as typed (#B600)', function () {
        ['ab"cd', 'ab\\cd', 'ab\ncd', 'ab\tcd', 'ab\u0001cd', 'ab$&cd', "ab$'cd", 'ab$`cd'].forEach(function (v) {
            var ok = confirmPair(v, v);
            assert.equal(ok.formValid, true, JSON.stringify(v) + ' against itself must validate');
            var ko = confirmPair(v, v + 'x');
            assert.equal(isErr(ko, 'password-confirm'), true, JSON.stringify(v) + ' against a different value must mismatch');
        });
    });

    it('01.3 - `$$` stays two characters: ab$$cd is NOT ab$cd (#B600)', function () {
        assert.equal(isErr(confirmPair('ab$$cd', 'ab$cd'), 'password-confirm'), true);
        assert.equal(confirmPair('ab$$cd', 'ab$$cd').formValid, true);
    });

    it('01.4 - an operand-shaped value is one operand, never grammar (#B600)', function () {
        assert.equal(confirmPair('a" === "a', 'a" === "a').formValid, true);
        assert.equal(isErr(confirmPair('a" === "a', 'x'), 'password-confirm'), true);
    });

    it('01.5 - a referenced field with NO rule of its own (the loop-1 default splice) is escaped too (#B600)', function () {
        var rules = { 'password-confirm': { is: ['$password === $password-confirm', 'mismatch'] } };
        assert.equal(drivePlugin(rules, { password: 'ab"cd', 'password-confirm': 'ab"cd' }).formValid, true);
        assert.equal(isErr(drivePlugin(rules, { password: 'ab"cd', 'password-confirm': 'ab"ce' }), 'password-confirm'), true);
    });

    it('01.6 - number rules: non-numeric text is spliced as an escaped string and compares as text (#B600)', function () {
        assert.equal(isErr(numberPair('1"2', '1"2'), 'amount-confirm'), false, 'equal text compares equal');
        // the engine's isNumber reads both as the leading number 1 (parseInt, measured),
        // so only a TEXT comparison tells them apart
        assert.equal(isErr(numberPair('1"2', '1"3'), 'amount-confirm'), true, 'compared as text, not as a parsed number');
        assert.equal(isErr(numberPair('1\\2', '1\\2'), 'amount-confirm'), false);
        // text that used to fail the grammar (`abc === abc`) now compares as text,
        // and the field keeps its own isNumber error
        var abc = numberPair('abc', 'abc');
        assert.equal(isErr(abc, 'amount-confirm'), false);
        assert.ok((abc.errs.amount || []).indexOf('isNumber') > -1, 'the field keeps its own isNumber error');
        assert.equal(isErr(numberPair('abc', 'abd'), 'amount-confirm'), true);
    });

    it('01.7 - values differing only by parentheses or `return` do not compare equal (#B601)', function () {
        assert.equal(isErr(confirmPair('ab(cd', 'ab)cd'), 'password-confirm'), true);
        assert.equal(isErr(confirmPair('myreturnpass', 'mypass'), 'password-confirm'), true);
        assert.equal(confirmPair('ab(cd)', 'ab(cd)').formValid, true, 'equal parenthesised values still validate');
    });

    it('01.8 - values with no ASCII letter or digit are compared (#B602)', function () {
        assert.equal(confirmPair('!!!', '!!!').formValid, true);
        assert.equal(confirmPair('é€', 'é€').formValid, true);
        assert.equal(isErr(confirmPair('!!!', '???'), 'password-confirm'), true, 'and a real mismatch still fails');
    });

    it('01.9 - premise: numeric comparisons stay numeric, padding and typed numbers included', function () {
        assert.equal(isErr(numberPair('12', '12'), 'amount-confirm'), false);
        assert.equal(isErr(numberPair('12', '13'), 'amount-confirm'), true);
        assert.equal(isErr(numberPair(' 12', '12'), 'amount-confirm'), false, 'space padding reads as part of a number');
        assert.equal(isErr(numberPair('12 ', '12'), 'amount-confirm'), false);
        assert.equal(isErr(numberPair(12, 12), 'amount-confirm'), false, 'typed numbers');
        assert.equal(isErr(numberPair('1,5', '1.5'), 'amount-confirm'), false, 'comma normalisation');
        assert.equal(numberPair('é1', 'é1').errs.amount.indexOf('isNumber') > -1, true);
    });

    it('01.10 - premise: an empty confirmation is reported by isRequired alone (#B233 unchanged)', function () {
        assert.deepEqual(confirmPair('abc', '').errs['password-confirm'], ['isRequired']);
        assert.equal(confirmPair('é1', 'é1').formValid, true, 'the #B602 discriminating control');
    });
});

// ---------------------------------------------------------------------------
// §02 — behaviour, engine path (`is()`'s own substitution)
// ---------------------------------------------------------------------------
describe('validator-splice-escaping §02 — engine path (#B600 / #B601 / #B602)', function () {

    it('02.1 - control: plain values', function () {
        assert.equal(driveIs('abcd1234', 'abcd1234').valid, true);
        assert.deepEqual(driveIs('abcd1234', 'abce1234').errs, ['is']);
    });

    it('02.2 - a double quote compares as typed (#B600)', function () {
        assert.equal(driveIs('ab"cd', 'ab"cd').valid, true);
        assert.equal(driveIs('say "hi"', 'say "hi"').valid, true);
    });

    it('02.3 - premise: a backslash was always literal here, and a quote mismatch still fails', function () {
        assert.equal(driveIs('ab\\cd', 'ab\\cd').valid, true);
        assert.equal(driveIs('ab\\cd', 'ab\\ce').valid, false);
        assert.equal(driveIs('ab"cd', 'ab"ce').valid, false);
        assert.equal(driveIs('a" === "a', 'x').valid, false, 'an operand-shaped value never becomes grammar');
    });

    it('02.4 - $-patterns stay literal (#B600)', function () {
        assert.equal(driveIs('ab$&cd', 'ab$&cd').valid, true);
        assert.equal(driveIs('ab$$cd', 'ab$cd').valid, false);
    });

    it('02.5 - an operand-shaped value compares as one operand (#B600)', function () {
        assert.equal(driveIs('a" === "a', 'a" === "a').valid, true);
    });

    it('02.6 - parentheses and `return` inside values are part of the value (#B601)', function () {
        assert.equal(driveIs('ab(cd', 'ab)cd').valid, false);
        assert.equal(driveIs('myreturnpass', 'mypass').valid, false);
    });

    it('02.7 - a literal condition with no ASCII letter or digit is evaluated (#B602)', function () {
        assert.equal(driveIs('x', 'x', '"!!!" === "!!!"').valid, true);
        assert.equal(driveIs('x', 'x', '"é€" === "é€"').valid, true);
        assert.equal(driveIs('x', 'x', '"!!!" === "???"').valid, false);
    });

    it('02.8 - premise: authored parentheses and `return` OUTSIDE literals are still stripped', function () {
        assert.equal(driveIs('x', 'x', '("abc") === ("abc")').valid, true);
        assert.equal(driveIs('abc', 'abc', 'return $password === $password-confirm').valid, true);
    });

    it('02.9 - an authored literal with a valid escape is decoded (#B600)', function () {
        assert.equal(driveIs('a"b', 'x', '$password === "a\\"b"').valid, true);
        assert.equal(driveIs('a"c', 'x', '$password === "a\\"b"').valid, false);
    });

    it('02.10 - premise: an authored literal that is not valid JSON is read verbatim, as before', function () {
        assert.equal(driveIs('a\\qb', 'x', '$password === "a\\qb"').valid, true);
        assert.equal(driveIs('a\\qc', 'x', '$password === "a\\qb"').valid, false);
        // an undecodable literal that also carries an escaped quote fails the field, never throws
        assert.equal(driveIs('a"b\\q', 'x', '$password === "a\\"b\\q"').valid, false);
    });
});

// ---------------------------------------------------------------------------
// §03 — the query-body decode (form-validator.js decodeSplicedQuotes, extracted)
// ---------------------------------------------------------------------------

/** The REMOVED cleanup (form-validator.js queryFromFrontend), verbatim: the identity reference. */
function oldStrip(jsonText) { return jsonText.replace(/\\"/g, ''); }

/** Deterministic PRNG (mulberry32) for the identity fuzz. */
function prng(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

describe('validator-splice-escaping §03 — query body decode (#B600)', function () {

    it('03.0 - control: the helpers are extracted from the shipped source, once each', function () {
        var h = need(ENGINE_HELPERS, 'form-validator.js helpers');
        assert.equal(typeof h.decodeSplicedQuotes, 'function');
        assert.equal(typeof h.escapeForJsonString, 'function');
        assert.throws(function () { sliceDecl('nothing here', fnDecl('decodeSplicedQuotes'), 'x'); }, /found 0/);
    });

    it('03.1 - byte-identical to the old cleanup for every body without a backslash (documented shapes)', function () {
        var dec = need(ENGINE_HELPERS, 'form-validator.js helpers').decodeSplicedQuotes;
        [
            [{ username: '"john"' }, '{"username":"john"}'],
            [{ q: 'prefix-"john"-suffix' }, '{"q":"prefix-john-suffix"}'],
            [{ q: 'say "hi"' }, '{"q":"say hi"}'],
            [{ q: 'a"b' }, '{"q":"ab"}'],
            [{ '"k"': 1 }, '{"k":1}'],
            [{ n: 1.5, t: true, z: null }, '{"n":1.5,"t":true,"z":null}'],
            [{ a: { b: ['"x"', 'y'] } }, '{"a":{"b":["x","y"]}}'],
            [{ q: '' }, '{"q":""}'],
            [{ q: '""' }, '{"q":""}'],
            [{ b: 'x', '"1"': 'y' }, '{"b":"x","1":"y"}']
        ].forEach(function (c) {
            var text = JSON.stringify(c[0]);
            assert.equal(dec(text), c[1], text);
            assert.equal(dec(text), oldStrip(text), 'identity: ' + text);
        });
    });

    it('03.2 - byte-identical to the old cleanup on a seeded fuzz of backslash-free bodies', function () {
        var dec = need(ENGINE_HELPERS, 'form-validator.js helpers').decodeSplicedQuotes;
        var rnd = prng(77);
        var alphabet = ['a', 'Z', '0', '"', '"', '$', ' ', 'é', '€', '{', '}', '[', ']', ':', ',',
            '\n', '\t', '\u0001', ' ', '😀', '\ud800'];
        function str() {
            var s = '', n = Math.floor(rnd() * 9);
            for (var i = 0; i < n; i++) { s += alphabet[Math.floor(rnd() * alphabet.length)]; }
            return s;
        }
        function val(depth) {
            var r = rnd();
            if (r < 0.55 || depth > 1) { return str(); }
            if (r < 0.62) { return Math.floor(rnd() * 1000) / 10; }
            if (r < 0.68) { return rnd() < 0.5; }
            if (r < 0.72) { return null; }
            if (r < 0.86) { return [str(), val(depth + 1)]; }
            var o = {}; o[str()] = val(depth + 1); return o;
        }
        for (var i = 0; i < 500; i++) {
            var obj = {}, keys = 1 + Math.floor(rnd() * 3);
            for (var k = 0; k < keys; k++) { obj[str()] = val(0); }
            var text = JSON.stringify(obj);
            assert.equal(dec(text), oldStrip(text), 'case ' + i + ': ' + text);
        }
    });

    it('03.3 - a spliced value (a JSON literal escaped by the splice) decodes back exactly', function () {
        var h = need(ENGINE_HELPERS, 'form-validator.js helpers');
        SPECIALS.concat(['jo"hn', 'plain']).forEach(function (v) {
            var literal = '"' + h.escapeForJsonString(v) + '"';
            assert.equal(JSON.parse(h.decodeSplicedQuotes(JSON.stringify({ k: literal }))).k, v, 'value ' + JSON.stringify(v));
            assert.equal(JSON.parse(h.decodeSplicedQuotes(JSON.stringify({ k: 'pre-' + literal + '-post' }))).k,
                'pre-' + v + '-post', 'embedded ' + JSON.stringify(v));
            var asKey = {}; asKey[literal] = 1;
            assert.deepEqual(Object.keys(JSON.parse(h.decodeSplicedQuotes(JSON.stringify(asKey)))), [v], 'key ' + JSON.stringify(v));
        });
    });

    it('03.4 - the late token (queryFromFrontend, the form pinned in §06.6) reaches the wire intact', function () {
        var h = need(ENGINE_HELPERS, 'form-validator.js helpers');
        function lateBody(value) {
            var strData = JSON.stringify({ account: { username: '$username' } });
            var re = new RegExp('\\$username', 'g');
            var splicedValue = '\\"' + h.escapeForJsonString(h.escapeForJsonString(value)) + '\\"';
            strData = strData.replace(re, function () { return splicedValue; });
            return h.decodeSplicedQuotes(strData);
        }
        SPECIALS.concat(['jo"hn']).forEach(function (v) {
            assert.equal(JSON.parse(lateBody(v)).account.username, v, 'late ' + JSON.stringify(v));
        });
        // byte-identical to the old raw insert + cleanup for plain values (and null -> "null")
        ['john', 'a b', 'é', '12', null].forEach(function (v) {
            var old = JSON.stringify({ account: { username: '$username' } }).replace(new RegExp('\\$username', 'g'), v);
            assert.equal(lateBody(v), oldStrip(old), 'identity ' + JSON.stringify(v));
        });
    });

    it('03.5 - documented divergence: an AUTHORED quoted segment carrying a valid escape is decoded', function () {
        var dec = need(ENGINE_HELPERS, 'form-validator.js helpers').decodeSplicedQuotes;
        var text = JSON.stringify({ q: 'say "a\\nb"' });           // authored: backslash + n inside quotes
        assert.equal(JSON.parse(dec(text)).q, 'say a\nb');           // now: a line break
        assert.equal(JSON.parse(oldStrip(text)).q, 'say a\\nb');     // before: backslash + n
    });

    it('03.6 - a body the old cleanup broke (a value ending in a backslash) is now well-formed', function () {
        var dec = need(ENGINE_HELPERS, 'form-validator.js helpers').decodeSplicedQuotes;
        var text = JSON.stringify({ q: 'ends\\' });
        assert.throws(function () { JSON.parse(oldStrip(text)); }, SyntaxError, 'the old cleanup corrupted it');
        assert.equal(JSON.parse(dec(text)).q, 'ends\\');
    });
});

// ---------------------------------------------------------------------------
// §04 — the escaper: both copies agree, and match JSON's own escaping
// ---------------------------------------------------------------------------
describe('validator-splice-escaping §04 — escapeForJsonString / quoteForDynamisedRules (#B600)', function () {

    it('04.1 - main.js and form-validator.js carry the SAME escaper', function () {
        var m = need(MAIN_HELPERS, 'main.js helpers'), e = need(ENGINE_HELPERS, 'form-validator.js helpers');
        var corpus = SPECIALS.slice();
        for (var c = 0; c < 256; c++) { corpus.push(String.fromCharCode(c)); }
        corpus.push(' ', '\udc00', '𐀀', 'mixed "\\\n\u0007 end');
        corpus.forEach(function (s) {
            assert.equal(m.escapeForJsonString(s), e.escapeForJsonString(s), JSON.stringify(s));
        });
    });

    it('04.2 - it escapes exactly what JSON.stringify escapes, lone surrogates excepted', function () {
        var esc = need(MAIN_HELPERS, 'main.js helpers').escapeForJsonString;
        for (var c = 0; c < 256; c++) {
            var s = String.fromCharCode(c);
            assert.equal(esc(s), JSON.stringify(s).slice(1, -1), 'U+' + c.toString(16));
        }
        assert.equal(esc('ab"cd\\ef 😀'), JSON.stringify('ab"cd\\ef 😀').slice(1, -1));
        assert.equal(esc('\ud800'), '\ud800', 'a lone surrogate never broke a parse: left as it is');
        assert.equal(esc(12), '12', 'coerces with String()');
        assert.equal(esc(null), 'null');
    });

    it('04.3 - quoteForDynamisedRules is the historical splice for plain values, and round-trips every value', function () {
        var quote = need(MAIN_HELPERS, 'main.js helpers').quoteForDynamisedRules;
        ['abc', '12', 'a b', 'é€', '', 'x$y', 'null'].forEach(function (v) {
            assert.equal(quote(v), '\\"' + v + '\\"', 'byte-identical for ' + JSON.stringify(v));
        });
        // the rule set is JSON text and the splice sits inside one of its strings:
        // parse 1 = the rule set, parse 2 = the operand is() decodes
        SPECIALS.forEach(function (v) {
            assert.equal(JSON.parse(JSON.parse('"' + quote(v) + '"')), v, 'round trip ' + JSON.stringify(v));
        });
    });
});

// ---------------------------------------------------------------------------
// §05 — getDynamisedRules' DOM fallback and parse guard (extracted, no DOM needed)
// ---------------------------------------------------------------------------
describe('validator-splice-escaping §05 — getDynamisedRules loop 2 and parse (#B600)', function () {

    // `$b` surviving loop 1 inside a SPLICED value is what makes loop 2 act (it
    // walks the same field names as loop 1, in descending order): `a` is spliced
    // after `b`'s turn, so the `$b` it carries meets `b`'s DOM value in loop 2.
    var RULES = { a: { is: ['$a === $a-confirm', 'mismatch'] }, 'a-confirm': {}, b: {} };
    function dom(bValue) {
        return {
            fields: { a: 'x$b', 'a-confirm': 'x$b', b: bValue },
            $fields: { a: { value: 'x$b' }, 'a-confirm': { value: 'x$b' }, b: { value: bValue } }
        };
    }

    it('05.1 - control: the extracted function splices a plain value (premise, unchanged)', function () {
        var s = compileSplice();
        var out = s.getDynamisedRules(JSON.stringify({ a: { is: ['$a === $b', 'm'] }, b: {} }), { a: 'x', b: 'x' }, null, false);
        assert.equal(out.a.is[0], '"x" === "x"');
    });

    it('05.2 - the DOM-fallback splice of a quote-bearing value no longer throws', function () {
        var s = compileSplice(), d = dom('q"r'), out;
        assert.doesNotThrow(function () { out = s.getDynamisedRules(JSON.stringify(RULES), d.fields, d.$fields, false); });
        assert.equal(typeof out.a.is[0], 'string');
    });

    it('05.3 - the DOM-fallback splice keeps `$&` literal', function () {
        var s = compileSplice(), d = dom('q$&r');
        var out = s.getDynamisedRules(JSON.stringify(RULES), d.fields, d.$fields, false);
        assert.ok(out.a.is[0].indexOf('q$&r') > -1, out.a.is[0]);
    });

    it('05.4 - a rule set that cannot be parsed falls back to the rules as declared, with a warning', function () {
        var s = compileSplice(function () { return '"'; }), out;
        assert.doesNotThrow(function () {
            out = s.getDynamisedRules(JSON.stringify({ a: { is: ['$a === $b', 'm'] }, b: {} }), { a: 'x', b: 'y' }, null, false);
        });
        assert.equal(out.a.is[0], '$a === $b', 'the un-substituted condition, for is() to resolve or fail closed');
        assert.equal(s.warns.length, 1);
        assert.match(s.warns[0], /Could not parse the dynamised rules/);
    });
});

// ---------------------------------------------------------------------------
// §06 — source pins
// ---------------------------------------------------------------------------

/** Same anchors as the crossfield / isboolean-contract / server-dollar-rules slicers. */
function castBlock(src) {
    var start = src.indexOf('var getCastedValue = function');
    var end = src.indexOf('var formatFields', start);
    assert.ok(start > -1 && end > start, 'getCastedValue block not found');
    return src.slice(start, end);
}
function dynBlock(src) {
    var start = src.indexOf('var getDynamisedRules = function(');
    var end = src.indexOf('     * Validate form', start);
    assert.ok(start > -1 && end > start, 'getDynamisedRules block not found');
    return src.slice(start, end);
}
function isBody(src) {
    var start = src.indexOf("self[el]['is'] = function");
    var next = src.indexOf('self[el][', start + 10);
    assert.ok(start > -1 && next > start, 'is() not found');
    return src.slice(start, next);
}
function queryBlock(src) {
    var start = src.indexOf('var queryFromFrontend = function(');
    var end = src.indexOf('var validIf = ', start);
    assert.ok(start > -1 && end > start, 'queryFromFrontend block not found');
    return src.slice(start, end);
}

describe('validator-splice-escaping §06 — source pins', function () {

    it('06.0 - control: the slicers can fail', function () {
        assert.throws(function () { castBlock('nothing'); }, /not found/);
        assert.throws(function () { dynBlock('nothing'); }, /not found/);
        assert.throws(function () { isBody('nothing'); }, /not found/);
        assert.throws(function () { queryBlock('nothing'); }, /not found/);
    });

    it('06.1 - main.js: both helpers declared once, BEFORE getCastedValue (outside the sliced blocks)', function () {
        var castAt = MAIN_SRC.indexOf('var getCastedValue = function');
        ['escapeForJsonString', 'quoteForDynamisedRules'].forEach(function (name) {
            var at = declOffsets(MAIN_SRC, varDecl(name));
            assert.equal(at.length, 1, name + ' declared exactly once');
            assert.ok(at[0] < castAt, name + ' precedes getCastedValue');
        });
        assert.ok(activeLines(MAIN_SRC).indexOf(String.raw`return '\\"' + escapeForJsonString(escapeForJsonString(value)) + '\\"';`) > -1,
            'two levels, inside escaped quotes');
    });

    it('06.2 - getCastedValue: the string return and the number branch splice through the helper', function () {
        var block = activeLines(castBlock(MAIN_SRC));
        assert.ok(block.indexOf('return isOnDynamisedRules ? quoteForDynamisedRules(fields[fieldName]) : fields[fieldName];') > -1);
        assert.ok(block.indexOf(String.raw`&& !/^ *-?\d+(?:\.\d+)? *$/.test(fields[fieldName])`) > -1, 'the raw-number test');
        assert.ok(block.indexOf("&& typeof(fields[fieldName]) != 'number'") > -1);
        assert.ok(block.indexOf("&& typeof(fields[fieldName]) != 'boolean'") > -1);
        assert.ok(block.indexOf('return quoteForDynamisedRules(fields[fieldName]);') > -1);
        assert.equal(block.indexOf('+ fields[fieldName] +'), -1, 'no raw concatenation left');
    });

    it('06.3 - premise: the quoted-empty guard and the #B236 boolean gate are untouched', function () {
        var block = castBlock(MAIN_SRC);
        assert.match(block, /if \( isOnDynamisedRules && \/\^\\s\*\$\/\.test\(fields\[fieldName\]\) \)/);
        assert.ok(block.indexOf(String.raw`return '\\"\\"';`) > -1);
        assert.ok(block.indexOf('} else if (isOnDynamisedRules && ruleObj[fieldName].isBoolean) {') > -1);
    });

    it('06.4 - getDynamisedRules: escaped defaults, function replacers, a guarded parse', function () {
        var block = activeLines(dynBlock(MAIN_SRC));
        assert.ok(block.indexOf('let fieldValue = quoteForDynamisedRules(fields[arrFields[i]]);') > -1, 'loop-1 default');
        assert.ok(block.indexOf(String.raw`let fieldValue = ($fields[arrFields[i]].value != '' ) ? quoteForDynamisedRules($fields[arrFields[i]].value) : '\\"\\"';`) > -1,
            'loop-2 default');
        assert.ok(block.indexOf('stringifiedRules = stringifiedRules.replace(re, function() { return fieldValue; });') > -1);
        assert.ok(block.indexOf('stringifiedRules = stringifiedRules.replace(re, function() { return splicedValue; });') > -1);
        assert.equal(block.indexOf('.replace(re, fieldValue'), -1, 'no string replacement left');
        assert.equal(block.indexOf('+ fields[arrFields[i]] +'), -1);
        assert.equal(block.indexOf('+ $fields[arrFields[i]].value +'), -1);
        var tryAt = block.lastIndexOf('try {'), parseAt = block.indexOf('return JSON.parse(stringifiedRules);');
        var catchAt = block.indexOf('} catch (parseErr) {'), fallbackAt = block.indexOf('return ruleObj;');
        assert.ok(tryAt > -1 && tryAt < parseAt && parseAt < catchAt && catchAt < fallbackAt, 'try -> parse -> catch -> ruleObj');
    });

    it('06.5 - is(): escaped substitution, literal-aware strip, widened grammar, guarded operand decode', function () {
        var body = activeLines(isBody(ENGINE_SRC));
        assert.ok(body.indexOf('var variables = condition.match(/\\${0}[-_,.\\[\\]a-z0-9]+/ig) || [];') > -1, '#B602: no gate on an empty match');
        assert.equal(body.indexOf('variables && variables.length > 0'), -1);
        assert.ok(body.indexOf('var _scsSubstituted = JSON.stringify(self[ variables[i] ].value);') > -1);
        assert.ok(body.indexOf('compiledCondition = compiledCondition.replace(re, function() { return _scsSubstituted; });') > -1);
        assert.equal(body.indexOf("'\"'+ self[ variables[i] ].value +'\"'"), -1, 'no bare-quote string replacement left');
        var stripAt = body.indexOf(String.raw`compiledCondition = compiledCondition.replace(/"(?:[^"\\]|\\.)*"|[^"]+/g, function(_scsPart) {`);
        var grammarAt = body.indexOf(String.raw`var _SCS_BINARY_RE = /^\s*(null|undefined|true|false|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)\s*(===|!==|<=|>=|==|!=|<|>)\s*(null|undefined|true|false|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)\s*$/;`);
        assert.ok(stripAt > -1, '#B601: the strip runs outside string literals');
        assert.ok(grammarAt > stripAt, 'the widened grammar, after the strip');
        assert.ok(body.indexOf('return JSON.parse(_t);') > -1, 'a string operand decodes as a JSON literal');
        assert.ok(body.indexOf('_scsOperandErr') > -1, 'an undecodable operand fails the field');
    });

    it('06.6 - queryFromFrontend: the late token is spliced twice-escaped, the body decoded', function () {
        var block = activeLines(queryBlock(ENGINE_SRC));
        assert.ok(block.indexOf(String.raw`var splicedValue = '\\"' + escapeForJsonString(escapeForJsonString(value)) + '\\"';`) > -1);
        assert.ok(block.indexOf('strData = strData.replace( re, function() { return splicedValue; } );') > -1);
        assert.ok(block.indexOf('queryData = decodeSplicedQuotes(strData);') > -1);
        assert.equal(block.indexOf('strData.replace( re, value )'), -1);
        assert.equal(block.indexOf(String.raw`strData.replace(/\\"/g, '')`), -1, 'the blanket cleanup is gone');
    });

    it('06.7 - form-validator.js: the helpers live at module scope, before FormValidatorUtil', function () {
        var ctorAt = ENGINE_SRC.indexOf('function FormValidatorUtil(');
        ['escapeForJsonString', 'decodeSplicedQuotes'].forEach(function (name) {
            var at = declOffsets(ENGINE_SRC, fnDecl(name));
            assert.equal(at.length, 1, name + ' declared exactly once');
            assert.ok(at[0] < ctorAt, name + ' precedes FormValidatorUtil');
        });
    });

    it('06.8 - premise: the grammar-mismatch branch still fails the field without throwing', function () {
        assert.match(ENGINE_SRC, /if \(!_scsBinMatch\) \{[\s\S]*?isValid = false;[\s\S]*?\} else \{[\s\S]*?_scsParseOperand/);
    });
});

// ---------------------------------------------------------------------------
// §07 — dist pins (the browser bundle carries the fix — red until the prod rebuild)
// ---------------------------------------------------------------------------
describe('validator-splice-escaping §07 — dist', function () {

    var GRAMMAR = String.raw`/^\s*(null|undefined|true|false|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)\s*(===|!==|<=|>=|==|!=|<|>)\s*(null|undefined|true|false|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)\s*$/`;
    var SEGMENTS = String.raw`/"(?:[^"\\]|\\.)*"|[^"]+/g`;

    it('07.1 - gina.js carries the helpers and the widened grammar', function () {
        var raw = fs.readFileSync(DIST_RAW_PATH, 'utf8');
        assert.ok(raw.indexOf('var quoteForDynamisedRules = function(value) {') > -1);
        assert.ok(raw.indexOf('function decodeSplicedQuotes(jsonText) {') > -1);
        assert.ok(raw.indexOf(GRAMMAR) > -1);
        assert.ok(raw.indexOf(SEGMENTS) > -1);
    });

    it('07.2 - gina.min.js carries the widened grammar and the literal-aware strip', function () {
        var min = fs.readFileSync(DIST_MIN_PATH, 'utf8');
        assert.equal(min.split(GRAMMAR).length - 1, 1, 'the widened grammar, once');
        assert.equal(min.split(SEGMENTS).length - 1, 1, 'the segment regex, once');
    });
});
