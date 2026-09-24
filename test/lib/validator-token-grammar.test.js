'use strict';

/**
 * #B603 / #B604 / #B606 — one `$`-token grammar for every substitution site.
 *
 * Three sites used to recognise a `$<field>` token three different ways:
 *   - `getDynamisedRules` (main.js) replaced one field name at a time, longest
 *     name first by a descending sort, re-scanning the whole rule set after
 *     every splice — so a VALUE containing `$<otherField>` was substituted a
 *     second time (#B603), and a DOM-fallback second loop did it once more;
 *   - the engine's `is()` (form-validator.js) required whitespace or the end
 *     after a token (`(?!\S+)`), so `($a) === ($b)` and `$a===$b` never
 *     resolved (#B604), and interpolated the name into the RegExp unescaped
 *     (`$pw[0]` became a character class);
 *   - the client `query` body scanned `\$[-_\[\]a-z 0-9]+` — lowercase only,
 *     a space inside the class — so `$passwordConfirm` resolved `$password`
 *     + `Confirm`, `$password-confirm` depended on body order, and a `$`
 *     naming no field went out as the string `null` (#B606).
 *
 * Now: `FormValidatorUtil.substituteFieldTokens(text, names, resolve)` — a
 * token is `$` + a field name in scope, longest name first, ONE pass over the
 * original text, ending only where a non-name character (`[^A-Za-z0-9_-]`)
 * follows; a replacement is spliced verbatim and never re-scanned; a `$` that
 * names no field stays literal at every site.
 *
 * No replicas of shipped code: §02/§03 drive the REAL plugin and engine; §01
 * drives the real static; §04 executes the shipped `queryFromFrontend`
 * substitution block, sliced by its own comment anchors, with its free
 * variables supplied; §05 the sliced `getDynamisedRules` with a fake DOM.
 *
 * Red-first record (run on the unmodified worktree before the fix):
 *   MUST-RED  — every arm marked (#B603) / (#B604) / (#B606) / (absent), all
 *               of §06, §07 (dist, red again at the src-fixed / dist-stale
 *               midstate).
 *   MUST-GREEN — every arm marked (premise) or (control).
 */

var { describe, it, before, after } = require('node:test');
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
setContext('bundle', 'tokengrammarbundle');

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
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}

/** Slices `src` between two unique anchors (instrument: throws on a miss or a duplicate). */
function between(src, from, to, label) {
    var a = src.indexOf(from);
    assert.ok(a > -1, '[instrument] ' + label + ': start anchor not found');
    assert.equal(src.indexOf(from, a + 1), -1, '[instrument] ' + label + ': start anchor not unique');
    var b = src.indexOf(to, a);
    assert.ok(b > a, '[instrument] ' + label + ': end anchor not found');
    return src.slice(a, b);
}

/** A module-scope `function <name>(` declaration of form-validator.js, or null when absent. */
function fnDecl(src, name) {
    var re = new RegExp('^function ' + name + '\\(', 'mg');
    var hits = [], m;
    while ((m = re.exec(src)) !== null) { hits.push(m.index); }
    if (hits.length !== 1) { return null; }
    var i = hits[0], depth = 0, started = false;
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') { depth--; if (started && depth === 0) { return src.slice(hits[0], i + 1); } }
    }
    return null;
}

/** Captures console.warn while `fn` runs (the engine's grammar refusal is a warn, never a throw). */
function withWarns(fn) {
    var warns = [], orig = console.warn;
    console.warn = function (m) { warns.push(String(m)); };
    try { var r = fn(); return { result: r, warns: warns }; } finally { console.warn = orig; }
}

function isBody(src) {
    var start = src.indexOf("self[el]['is'] = function");
    var next = src.indexOf('self[el][', start + 10);
    assert.ok(start > -1 && next > start, '[instrument] is() not found');
    return src.slice(start, next);
}
function queryBlock(src) {
    return between(src, '        // replace placeholders by field values', '        // TODO - support regexp for validIf', 'query substitution block');
}
function dynBlock(src) {
    return between(src, 'var getDynamisedRules = function(', '     * Validate form', 'getDynamisedRules');
}
function validateBlock(src) {
    return between(src, 'var validate = function($formOrElement, fields, $fields, rules, cb, culture) {', 'var d = null;//FormValidator instance', 'validate head');
}

/** Plugin auto path (server `Validator` -> validate -> getDynamisedRules -> engine). */
function drivePlugin(rules, data) {
    var res = Validator(JSON.parse(JSON.stringify(rules)), Object.assign({}, data), 'token-grammar-form');
    var errs = {};
    for (var f in res.error || {}) { errs[f] = Object.keys(res.error[f] || {}); }
    return errs;
}
function isErr(errs, field) { return (errs[field] || []).indexOf('is') > -1; }

/** Engine path: `is()`'s OWN substitution (route `validator::` requirements, fluent `.is()`). */
function driveIs(data, target, condition) {
    return withWarns(function () {
        return new FormValidator(JSON.parse(JSON.stringify(data)))[target].is(condition, 'mismatch');
    });
}

/**
 * The shipped `queryFromFrontend` substitution block, executed with its free
 * variables supplied: `local.data` (the engine's data), `fieldsSet` (the form's
 * controls, live-check only), `getElementByName` (throws for a name outside
 * `fieldsSet`, as the real one does). Returns the decoded body text.
 */
var QUERY_DRIVER = (function () {
    try {
        var helpers = ['escapeForJsonString', 'decodeSplicedQuotes', 'escapeRegExp', 'substituteFieldTokens']
            .map(function (n) { return fnDecl(ENGINE_SRC, n) || ''; }).join('\n');
        var body = helpers + '\nvar re = null; var queryData = options.data || null, strData = null;\n'
            + queryBlock(ENGINE_SRC) + '\nreturn queryData;';
        return { fn: new Function('local', 'getElementByName', 'options', 'isInlineValidation', 'fieldsSet', body), error: null };
    } catch (e) { return { fn: null, error: e }; }
})();
function driveQuery(data, fields, opts) {
    opts = opts || {};
    if (!QUERY_DRIVER.fn) { throw new Error('[instrument] query block could not be compiled: ' + QUERY_DRIVER.error.message); }
    var live = opts.live || {};
    var fieldsSet = {};
    Object.keys(fields).concat(Object.keys(live)).forEach(function (n, i) { fieldsSet['f' + i] = { name: n, id: 'id' + i }; });
    var gebn = function (form, name) {
        if (name in live) { return { value: live[name] }; }
        if (name in fields) { return { value: fields[name] }; }
        throw new Error('Field `' + name + '` not found in fieldsSet');
    };
    return QUERY_DRIVER.fn.call({ target: { form: {} } }, { data: Object.assign({}, fields) }, gebn, { data: data }, !!opts.inline, fieldsSet);
}

/**
 * main.js `getDynamisedRules`, compiled from the shipped source with its
 * closure-scope collaborators supplied (the real `getCastedValue` and the #B600
 * helpers, sliced from the same file; the real engine for the static), so the
 * DOM-fallback shape can be driven with a fake `$fields`.
 */
var DYN_DRIVER = (function () {
    try {
        function varDecl(name) { return between(MAIN_SRC, '    var ' + name + ' = function', '\n    }\n', name) + '\n    }\n'; }
        var parts = [];
        ['escapeForJsonString', 'quoteForDynamisedRules'].forEach(function (n) {
            if (MAIN_SRC.indexOf('    var ' + n + ' = function') > -1) { parts.push(varDecl(n)); }
        });
        // both end anchors sit INSIDE (or just past) the next declaration's JSDoc — cut at
        // that JSDoc's opener so no comment fragment reaches the compiler (a JSDoc carries
        // braces of its own, so "the last `}`" is not the function's closing brace)
        function toDecl(s, label) {
            var docAt = s.lastIndexOf('/**');
            if (docAt > -1) { s = s.slice(0, docAt); }
            s = s.replace(/\s+$/, '');
            assert.equal(s.charAt(s.length - 1), '}', '[instrument] ' + label + ': slice does not end on a closing brace');
            return s;
        }
        parts.push(toDecl(between(MAIN_SRC, '    var getCastedValue = function', '    var formatFields', 'getCastedValue'), 'getCastedValue'));
        parts.push(toDecl(dynBlock(MAIN_SRC), 'getDynamisedRules'));
        var warns = [];
        var fakeConsole = { warn: function (m) { warns.push(String(m)); }, log: function () {}, debug: function () {}, error: function () {} };
        var noLive = function () { throw new Error('getFormValidationInfos must not run in a full-form pass'); };
        var fn = new Function('getFormValidationInfos', 'console', 'FormValidator', parts.join('\n') + '\nreturn getDynamisedRules;')(noLive, fakeConsole, FormValidator);
        return { fn: fn, warns: warns, error: null };
    } catch (e) { return { fn: null, warns: [], error: e }; }
})();

var PC = { password: { isRequired: true }, 'password-confirm': { isRequired: true, is: ['$password === $password-confirm', 'mismatch'] } };
function pc(a, b, extra) { var o = { password: a, 'password-confirm': b }; if (extra) { Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); } return o; }
function pcRules(extra) { var r = JSON.parse(JSON.stringify(PC)); if (extra) { Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); } return r; }

// ---------------------------------------------------------------------------
// §01 — the tokenizer itself (the static on the engine constructor)
// ---------------------------------------------------------------------------
describe('validator-token-grammar §01 — FormValidatorUtil.substituteFieldTokens', function () {

    function sub(text, names) {
        assert.equal(typeof FormValidator.substituteFieldTokens, 'function', 'the static is absent');
        return FormValidator.substituteFieldTokens(text, names, function (name) { return '<' + name + '>'; });
    }

    it('01.1 - a token ends where its name ends, whatever non-name character follows (absent)', function () {
        assert.equal(sub('($password) === ($password-confirm)', ['password', 'password-confirm']), '(<password>) === (<password-confirm>)');
        assert.equal(sub('$password===$password-confirm', ['password', 'password-confirm']), '<password>===<password-confirm>');
        assert.equal(sub('$a,$b]"', ['a', 'b']), '<a>,<b>]"');
        assert.equal(sub('$a === $b', ['a', 'b']), '<a> === <b>');
    });

    it('01.2 - the longest known name wins in either declaration order; a prefix never resolves (absent)', function () {
        assert.equal(sub('$password-confirm === $password', ['password', 'password-confirm']), '<password-confirm> === <password>');
        assert.equal(sub('$password-confirm === $password', ['password-confirm', 'password']), '<password-confirm> === <password>');
        assert.equal(sub('$password-confirm', ['password']), '$password-confirm');
        assert.equal(sub('$passwordX $password_x', ['password']), '$passwordX $password_x');
    });

    it('01.3 - ONE pass: a replacement is never re-scanned (absent)', function () {
        var out = FormValidator.substituteFieldTokens('$a === $b', ['a', 'b'], function (n) { return n === 'a' ? '"x$b"' : '"Q"'; });
        assert.equal(out, '"x$b" === "Q"');
    });

    it('01.4 - structural characters after a token are text: `.`/`[` keep the loop-1 reading, a longer known name still wins (absent)', function () {
        assert.equal(sub('$username.example.com', ['username']), '<username>.example.com');
        assert.equal(sub('$user.email', ['user', 'user.email']), '<user.email>');
        assert.equal(sub('$user[email] === $user', ['user', 'user[email]']), '<user[email]> === <user>');
        assert.equal(sub('$pw[0] === $pw[1]', ['pw[0]', 'pw[1]']), '<pw[0]> === <pw[1]>');
    });

    it('01.5 - names are RegExp-escaped and case-sensitive; unknown `$` stays literal; an empty list is a no-op (absent)', function () {
        assert.equal(sub('$a+b === $c+d', ['a+b', 'c+d']), '<a+b> === <c+d>');
        assert.equal(sub('$a.b(c)+* === 1', ['a.b(c)+*']), '<a.b(c)+*> === 1');
        assert.equal(sub('$Email $email', ['email']), '$Email <email>');
        assert.equal(sub('$price === "$100" /x$/ $$', ['price']), '<price> === "$100" /x$/ $$');
        assert.equal(sub('$a === $b', []), '$a === $b');
        assert.equal(sub('$a === $b', ['', 'a', 'a']), '<a> === $b');
    });

    it('01.6 - the resolver receives the name and the matched token (absent)', function () {
        var seen = [];
        FormValidator.substituteFieldTokens('$a $b', ['a', 'b'], function (n, m) { seen.push([n, m]); return ''; });
        assert.deepEqual(seen, [['a', '$a'], ['b', '$b']]);
    });
});

// ---------------------------------------------------------------------------
// §02 — plugin path (server `Validator` -> getDynamisedRules -> engine)
// ---------------------------------------------------------------------------
describe('validator-token-grammar §02 — plugin path', function () {

    it('02.1 - control: a plain confirmation validates, a plain mismatch errors', function () {
        assert.equal(isErr(drivePlugin(PC, pc('abc123', 'abc123')), 'password-confirm'), false);
        assert.equal(isErr(drivePlugin(PC, pc('abc123', 'abc124')), 'password-confirm'), true);
    });

    it('02.2 - a value containing `$<other field>` compares as typed, whatever that field sorts as (#B603)', function () {
        var rules = pcRules({ email: { isRequired: true } });
        assert.equal(isErr(drivePlugin(rules, pc('abc$email', 'abc$email', { email: 'a@b.co' })), 'password-confirm'), false, 'equal');
        assert.equal(isErr(drivePlugin(rules, pc('abc$email', 'abd$email', { email: 'a@b.co' })), 'password-confirm'), true, 'unequal still errors');
        var rules2 = pcRules({ zeta: { isRequired: true } });
        assert.equal(isErr(drivePlugin(rules2, pc('abc$zeta', 'abc$zeta', { zeta: 'zz' })), 'password-confirm'), false, 'the other sort side');
    });

    it('02.3 - a value holding the very token the condition references compares as typed (#B603)', function () {
        assert.equal(isErr(drivePlugin(PC, pc('x $password-confirm y', 'x $password-confirm y')), 'password-confirm'), false);
        assert.equal(isErr(drivePlugin(PC, pc('x $password y', 'x $password y')), 'password-confirm'), false);
        assert.equal(isErr(drivePlugin(PC, pc('x $password y', 'x $password z')), 'password-confirm'), true, 'unequal still errors');
    });

    it('02.3b - two DIFFERENT values no longer compare equal when one holds `$<sibling>` (the array-rule scan fail-open, #B603)', function () {
        // the scan re-substituted `$zeta` RAW inside the already-spliced value, so
        // `abc$zeta x` matched `abcZ x` — a confirmation check passing two different values
        var rules = pcRules({ zeta: { isRequired: true } });
        assert.equal(isErr(drivePlugin(rules, pc('abc$zeta x', 'abcZ x', { zeta: 'Z' })), 'password-confirm'), true, 'different values must mismatch');
        assert.equal(isErr(drivePlugin(rules, pc('a$zeta', 'aZ$zetaZ', { zeta: 'Z$&Z' })), 'password-confirm'), true, 'nor may `$&` in the sibling value expand');
        assert.equal(isErr(drivePlugin(rules, pc('abc$zeta x', 'abc$zeta x', { zeta: 'Z' })), 'password-confirm'), false, 'control: the same value still confirms');
    });

    it('02.4 - premise: the prefix pair, parentheses and a bare `$100` were already right on this path', function () {
        assert.equal(isErr(drivePlugin(PC, pc('abc', 'abc')), 'password-confirm'), false);
        var paren = pcRules(); paren['password-confirm'].is = ['($password) === ($password-confirm)', 'mismatch'];
        assert.equal(isErr(drivePlugin(paren, pc('abc', 'abc')), 'password-confirm'), false);
        assert.equal(isErr(drivePlugin(paren, pc('abc', 'abd')), 'password-confirm'), true);
        var lit = { price: { is: ['$price === "$100"', 'not 100'] } };
        assert.equal(isErr(drivePlugin(lit, { price: '$100' }), 'price'), false);
        assert.equal(isErr(drivePlugin(lit, { price: '$200' }), 'price'), true);
    });

    it('02.5 - a field name holding a RegExp metacharacter resolves (absent)', function () {
        var rules = { 'a+b': { isRequired: true }, 'c+d': { isRequired: true, is: ['$a+b === $c+d', 'mismatch'] } };
        assert.equal(isErr(drivePlugin(rules, { 'a+b': 'abc', 'c+d': 'abc' }), 'c+d'), false);
        assert.equal(isErr(drivePlugin(rules, { 'a+b': 'abc', 'c+d': 'abd' }), 'c+d'), true);
    });

    it('02.6 - premise: bracket and dotted names, camelCase, an empty referenced value', function () {
        var br = { 'pw[0]': { isRequired: true }, 'pw[1]': { isRequired: true, is: ['$pw[0] === $pw[1]', 'mismatch'] } };
        assert.equal(isErr(drivePlugin(br, { 'pw[0]': 'abc', 'pw[1]': 'abc' }), 'pw[1]'), false);
        assert.equal(isErr(drivePlugin(br, { 'pw[0]': 'abc', 'pw[1]': 'abd' }), 'pw[1]'), true);
        var dot = { 'user.pw': { isRequired: true }, 'user.pwc': { isRequired: true, is: ['$user.pw === $user.pwc', 'mismatch'] } };
        assert.equal(isErr(drivePlugin(dot, { 'user.pw': 'abc', 'user.pwc': 'abc' }), 'user.pwc'), false);
        var camel = { password: { isRequired: true }, passwordConfirm: { isRequired: true, is: ['$password === $passwordConfirm', 'mismatch'] } };
        assert.equal(isErr(drivePlugin(camel, { password: 'abc', passwordConfirm: 'abc' }), 'passwordConfirm'), false);
        assert.equal(isErr(drivePlugin(camel, { password: 'abc', passwordConfirm: 'abd' }), 'passwordConfirm'), true);
        // #B82: an empty referenced operand is a quoted "" — the condition neither throws nor errors on its own
        var opt = { password: {}, 'password-confirm': { is: ['$password === $password-confirm', 'mismatch'] } };
        assert.equal(isErr(drivePlugin(opt, pc('', 'abc')), 'password-confirm'), true);
    });
});

// ---------------------------------------------------------------------------
// §03 — engine path (`is()`'s own substitution)
// ---------------------------------------------------------------------------
describe('validator-token-grammar §03 — engine path', function () {

    it('03.1 - control: equal validates, unequal does not, no warn either way', function () {
        var eq = driveIs(pc('abc', 'abc'), 'password-confirm', '$password === $password-confirm');
        var ne = driveIs(pc('abc', 'abd'), 'password-confirm', '$password === $password-confirm');
        assert.equal(eq.result.valid, true); assert.equal(ne.result.valid, false);
        assert.equal(eq.warns.length + ne.warns.length, 0);
    });

    it('03.2 - a token followed by a parenthesis resolves (#B604)', function () {
        var eq = driveIs(pc('abc', 'abc'), 'password-confirm', '($password) === ($password-confirm)');
        var ne = driveIs(pc('abc', 'abd'), 'password-confirm', '($password) === ($password-confirm)');
        assert.equal(eq.result.valid, true, 'equal: ' + eq.warns[0]);
        assert.equal(ne.result.valid, false);
        assert.equal(eq.warns.length + ne.warns.length, 0, 'no grammar refusal');
    });

    it('03.3 - a token followed by an operator resolves (#B604)', function () {
        var eq = driveIs(pc('abc', 'abc'), 'password-confirm', '$password===$password-confirm');
        var ne = driveIs(pc('abc', 'abd'), 'password-confirm', '$password===$password-confirm');
        assert.equal(eq.result.valid, true, 'equal: ' + eq.warns[0]);
        assert.equal(ne.result.valid, false);
        assert.equal(eq.warns.length + ne.warns.length, 0, 'no grammar refusal');
    });

    it('03.4 - bracket names and names holding a RegExp metacharacter resolve (absent)', function () {
        var br = driveIs({ 'pw[0]': 'abc', 'pw[1]': 'abc' }, 'pw[1]', '$pw[0] === $pw[1]');
        var brNe = driveIs({ 'pw[0]': 'abc', 'pw[1]': 'abd' }, 'pw[1]', '$pw[0] === $pw[1]');
        assert.equal(br.result.valid, true, br.warns[0]); assert.equal(brNe.result.valid, false);
        var plus = driveIs({ 'a+b': 'abc', 'c+d': 'abc' }, 'c+d', '$a+b === $c+d');
        assert.equal(plus.result.valid, true, plus.warns[0]);
    });

    it('03.5 - a value holding a referenced token compares as typed (#B603, engine)', function () {
        var eq = driveIs(pc('x $password-confirm y', 'x $password-confirm y'), 'password-confirm', '$password === $password-confirm');
        assert.equal(eq.result.valid, true, eq.warns[0]);
        var ne = driveIs(pc('x $password-confirm y', 'x $password-confirm z'), 'password-confirm', '$password === $password-confirm');
        assert.equal(ne.result.valid, false);
    });

    it('03.6 - a `$` naming an engine METHOD is not a token: the condition is refused, never evaluated (absent)', function () {
        var r = driveIs({ a: 'x' }, 'a', '$isValid === "x"');
        assert.equal(r.result.valid, false);
        assert.equal(r.warns.length, 1, 'the grammar refusal warns (it used to splice `undefined` silently)');
        assert.match(r.warns[0], /Could not evaluate condition/);
    });

    it('03.7 - premise: a `$` naming no field stays literal; dotted names resolve; camelCase resolves', function () {
        var lit = driveIs({ price: '$100' }, 'price', '$price === "$100"');
        assert.equal(lit.result.valid, true, lit.warns[0]);
        assert.equal(driveIs({ price: '$200' }, 'price', '$price === "$100"').result.valid, false);
        assert.equal(driveIs({ 'user.pw': 'abc', 'user.pwc': 'abc' }, 'user.pwc', '$user.pw === $user.pwc').result.valid, true);
        assert.equal(driveIs({ password: 'abc', passwordConfirm: 'abc' }, 'passwordConfirm', '$password === $passwordConfirm').result.valid, true);
        assert.equal(driveIs({ password: 'abc', passwordConfirm: 'abd' }, 'passwordConfirm', '$password === $passwordConfirm').result.valid, false);
    });
});

// ---------------------------------------------------------------------------
// §04 — client `query` body (the shipped substitution block, sliced)
// ---------------------------------------------------------------------------
describe('validator-token-grammar §04 — client query body (#B606)', function () {

    it('04.0 - control: the block compiles from the shipped source and splices a plain token', function () {
        assert.equal(driveQuery({ u: '$username' }, { username: 'john' }), '{"u":"john"}');
        assert.equal(driveQuery({ e: '$user[email]' }, { 'user[email]': 'a@b' }), '{"e":"a@b"}');
    });

    it('04.1 - a camelCase or capitalised name resolves the RIGHT field (#B606)', function () {
        assert.equal(driveQuery({ c: '$passwordConfirm' }, { passwordConfirm: 'abc', password: 'zzz' }), '{"c":"abc"}');
        assert.equal(driveQuery({ e: '$Email' }, { Email: 'a@b' }), '{"e":"a@b"}');
    });

    it('04.2 - a prefix pair resolves whatever the body order (#B606)', function () {
        var f = { password: 'abc', 'password-confirm': 'abd' };
        assert.equal(driveQuery({ p: '$password', c: '$password-confirm' }, f), '{"p":"abc","c":"abd"}');
        assert.equal(driveQuery({ c: '$password-confirm', p: '$password' }, f), '{"c":"abd","p":"abc"}');
    });

    it('04.3 - text after a token keeps the token; a spliced value is never re-scanned (#B606)', function () {
        assert.equal(driveQuery({ m: '$username is taken' }, { username: 'john' }), '{"m":"john is taken"}');
        assert.equal(driveQuery({ n: '$first $last' }, { first: 'A', last: 'B' }), '{"n":"A B"}');
        assert.equal(driveQuery({ a: '$a', b: '$b' }, { a: 'x$b', b: 'Q' }), '{"a":"x$b","b":"Q"}');
        assert.equal(driveQuery({ b: '$b', a: '$a' }, { a: 'x$b', b: 'Q' }), '{"b":"Q","a":"x$b"}');
    });

    it('04.4 - a `$` naming no field stays literal — and no longer throws in live-check (#B606)', function () {
        assert.equal(driveQuery({ x: '$nosuch' }, { username: 'john' }), '{"x":"$nosuch"}');
        assert.equal(driveQuery({ price: '$100' }, { username: 'john' }), '{"price":"$100"}');
        assert.equal(driveQuery({ price: '$100' }, { username: 'john' }, { inline: true }), '{"price":"$100"}');
    });

    it('04.5 - live-check: a sibling not yet in the engine data resolves from the form (premise, the getElementByName universe)', function () {
        assert.equal(driveQuery({ u: '$username' }, { other: 'o' }, { inline: true, live: { username: 'live-john' } }), '{"u":"live-john"}');
    });

    it('04.6 - documented reading: a name character after a token makes it another (unknown) name, left literal (#B606)', function () {
        assert.equal(driveQuery({ u: 'x-$username-y' }, { username: 'john' }), '{"u":"x-$username-y"}');
    });

    it('04.7 - premise: a value holding `"` or `\\` still reaches the body as typed (#B600 unchanged)', function () {
        assert.equal(JSON.parse(driveQuery({ u: '$username' }, { username: 'jo"hn' })).u, 'jo"hn');
        assert.equal(JSON.parse(driveQuery({ u: '$username' }, { username: 'a\\b' })).u, 'a\\b');
    });
});

// ---------------------------------------------------------------------------
// §05 — getDynamisedRules with a fake DOM (the retired second loop)
// ---------------------------------------------------------------------------
describe('validator-token-grammar §05 — getDynamisedRules, single pass', function () {

    var RULES = { a: { is: ['$a === $a-confirm', 'mismatch'] }, 'a-confirm': {}, b: {} };

    it('05.0 - control: the sliced function splices a plain value', function () {
        assert.ok(DYN_DRIVER.fn, '[instrument] ' + (DYN_DRIVER.error && DYN_DRIVER.error.message));
        var out = DYN_DRIVER.fn(JSON.stringify({ a: { is: ['$a === $b', 'm'] }, b: {} }), { a: 'x', b: 'x' }, null, false);
        assert.equal(out.a.is[0], '"x" === "x"');
    });

    it('05.1 - with a DOM present, a spliced value carrying `$b` is NOT substituted again (#B603)', function () {
        var fields = { a: 'x$b', 'a-confirm': 'x$b', b: 'Q' };
        var $fields = { a: { value: 'x$b' }, 'a-confirm': { value: 'x$b' }, b: { value: 'Q' } };
        var out = DYN_DRIVER.fn(JSON.stringify(RULES), fields, $fields, false);
        assert.equal(out.a.is[0], '"x$b" === "x$b"');
    });

    it('05.2 - without a DOM, a field the old descending sort walked LAST no longer re-hits a spliced value (#B603)', function () {
        // `Z` sorts before `a`, so the old loop reached it after `a`'s value was spliced
        var rules = { a: { is: ['$a === $a-confirm', 'mismatch'] }, 'a-confirm': {}, Z: {} };
        var out = DYN_DRIVER.fn(JSON.stringify(rules), { a: 'x$Z', 'a-confirm': 'x$Z', Z: 'Q' }, null, false);
        assert.equal(out.a.is[0], '"x$Z" === "x$Z"');
    });

    it('05.3 - a referenced field without a rule of its own is spliced once, with one warning (premise)', function () {
        DYN_DRIVER.warns.length = 0;
        var out = DYN_DRIVER.fn(JSON.stringify({ a: { is: ['$a === $z', 'm'], is1: ['$z === $z', 'm'] } }), { a: 'x', z: 'x' }, null, false);
        assert.equal(out.a.is[0], '"x" === "x"');
        assert.equal(out.a.is1[0], '"x" === "x"');
        var about = DYN_DRIVER.warns.filter(function (w) { return /`z` is used in a dynamic rule without definition/.test(w); });
        assert.equal(about.length, 1, 'one warning per NAME, not per occurrence: ' + JSON.stringify(DYN_DRIVER.warns));
    });
});

// ---------------------------------------------------------------------------
// §06 — source pins (comment-stripped)
// ---------------------------------------------------------------------------
describe('validator-token-grammar §06 — source pins', function () {

    it('06.1 - form-validator.js: the tokenizer is declared once at module scope and exported as a static', function () {
        var decl = fnDecl(ENGINE_SRC, 'substituteFieldTokens');
        assert.ok(decl, 'substituteFieldTokens declared exactly once');
        assert.ok(fnDecl(ENGINE_SRC, 'escapeRegExp'), 'escapeRegExp declared exactly once');
        assert.ok(ENGINE_SRC.indexOf('function substituteFieldTokens(') < ENGINE_SRC.indexOf('function FormValidatorUtil('), 'declared before the constructor');
        assert.ok(activeLines(ENGINE_SRC).indexOf('FormValidatorUtil.substituteFieldTokens = substituteFieldTokens;') > -1, 'the static');
        assert.ok(decl.indexOf("(?![A-Za-z0-9_-])") > -1, 'the trailing boundary');
        assert.ok(decl.indexOf('return b.length - a.length') > -1, 'longest name first');
    });

    it('06.2 - is(): the sigil-less scan and the whitespace lookahead are gone; the tokenizer is called', function () {
        var body = activeLines(isBody(ENGINE_SRC));
        assert.equal(body.indexOf('(?!\\\\S+)'), -1, 'the `(?!\\S+)` lookahead');
        assert.equal(body.indexOf('var variables = condition.match('), -1, 'the sigil-less scan');
        assert.ok(body.indexOf('substituteFieldTokens(') > -1);
    });

    it('06.3 - queryFromFrontend: the lowercase scan is gone; the tokenizer is called; the splice and the decode stay', function () {
        var block = activeLines(queryBlock(ENGINE_SRC));
        assert.equal(block.indexOf('strData.match(/\\$[-_\\[\\]a-z 0-9]+/g)'), -1, 'the old scan');
        assert.ok(block.indexOf('substituteFieldTokens(') > -1);
        assert.ok(block.indexOf('escapeForJsonString(escapeForJsonString(') > -1, 'the twice-escaped splice');
        assert.ok(block.indexOf('queryData = decodeSplicedQuotes(strData);') > -1);
    });

    it('06.4 - getDynamisedRules: one pass through the static; no descending sort, no DOM-fallback loop; the parse guard stays', function () {
        var block = activeLines(dynBlock(MAIN_SRC));
        assert.equal(block.indexOf('arrFields.sort().reverse()'), -1, 'the descending sort');
        assert.equal(block.indexOf('$fields && /\\$(.*)/.test(stringifiedRules)'), -1, 'the #B234 loop-2 gate');
        assert.equal(block.indexOf("new RegExp('\\\\$'"), -1, 'a per-name RegExp');
        assert.ok(block.indexOf('FormValidator.substituteFieldTokens(') > -1);
        var casts = block.match(/getCastedValue\(ruleObj, fields, /g) || [];
        assert.equal(casts.length, 1, 'exactly one getCastedValue call site, got ' + casts.length);
        var tryAt = block.lastIndexOf('try {'), parseAt = block.indexOf('return JSON.parse(stringifiedRules);');
        var catchAt = block.indexOf('} catch (parseErr) {'), fallbackAt = block.indexOf('return ruleObj;');
        assert.ok(tryAt > -1 && tryAt < parseAt && parseAt < catchAt && catchAt < fallbackAt, 'try -> parse -> catch -> ruleObj');
    });

    it('06.5 - premise: validate() keeps its own `$` gate (only loop 2\'s gate went)', function () {
        assert.ok(activeLines(validateBlock(MAIN_SRC)).indexOf('if ( /\\$(.*)/.test(stringifiedRules) ) {') > -1);
    });
});

// ---------------------------------------------------------------------------
// §07 — dist pins (the browser bundle carries the fix — red until the prod rebuild)
// ---------------------------------------------------------------------------
describe('validator-token-grammar §07 — dist', function () {

    it('07.1 - gina.js carries the tokenizer, the static and the three call sites; the old scans are gone', function () {
        var raw = fs.readFileSync(DIST_RAW_PATH, 'utf8');
        assert.equal(raw.split('function substituteFieldTokens(').length - 1, 1);
        assert.ok(raw.indexOf('FormValidatorUtil.substituteFieldTokens = substituteFieldTokens;') > -1);
        // comment-stripped: RequireJS keeps every comment, and the JSDoc @example spells the
        // call while the #B604/#B606 comments quote the very scans these negatives look for
        var active = activeLines(raw);
        assert.equal(active.split('substituteFieldTokens(').length - 1, 4, 'declaration + is() + query + getDynamisedRules');
        assert.equal(active.indexOf('"\\\\$"+ variables[i] +"(?!\\\\S+)"'), -1, 'the engine\'s old per-name replace');
        assert.equal(active.indexOf('/\\$[-_\\[\\]a-z 0-9]+/g'), -1, 'the query body\'s old scan');
        assert.ok(raw.indexOf('/\\$[-_\\[\\]a-z 0-9]+/g') > -1, 'control: the needle still matches the raw text (the #B606 comment quotes it)');
    });

    it('07.2 - gina.min.js carries the boundary once and the old lookahead not at all', function () {
        var min = fs.readFileSync(DIST_MIN_PATH, 'utf8');
        assert.equal(min.split(')(?![A-Za-z0-9_-])').length - 1, 1, 'the trailing boundary, once');
        assert.equal(min.split('(?!\\\\S+)').length - 1, 0, 'the old lookahead');
    });
});
