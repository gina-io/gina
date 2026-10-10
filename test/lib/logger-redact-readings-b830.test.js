'use strict';
/**
 * Log redaction reads a message twice (#B830).
 *
 * The log writers render a control character held by a logged value as a
 * visible escape (the two characters backslash + n, backslash + r, backslash +
 * t, or the six characters backslash + u + four hex digits), and they do it
 * BEFORE the message reaches the redaction. A visible escape ends in a word
 * character and stands where whitespace stood, so a rule anchored on a word
 * boundary, a lookbehind or whitespace stopped matching, and a secret value
 * holding a line break was no longer found: a credential that was masked
 * before the escapes existed was printed after them.
 *
 * `redact.apply()` therefore reads a message that holds a visible escape
 * twice: as written, then decoded (each escape read as the character it stands
 * for). A span found on the decoded reading is masked in the message as
 * written, so the decoded reading only ever adds masks. That matters because
 * the escapers leave the backslash alone: a backslash + n the caller wrote on
 * purpose is not told from an escaped line feed, and a credential that itself
 * holds one must still be found as written.
 *
 * Since #B834 the decoded reading also reads the two quote escapes the object
 * writers add to a string value (backslash + double quote, backslash + single
 * quote); `logger-redact-b834.test.js` covers that change.
 *
 *   01  the decoded reading and its offset map
 *   02  no visible escape: byte for byte what one `replace` per rule gives
 *   03  the mapped replace equals the native one (every replacement form)
 *   04  found on the decoded reading only (the regression this closes)
 *   05  found as written only (why the decoded reading does not stand alone)
 *   06  secrets: the two readings are merged, longest first
 *   07  a kept group is copied as written — no control character is written back
 *   08  credential-free text is left alone; apply() stays idempotent
 *   09  the real logger: what reaches a sink (one process per arm group)
 *
 * The engine path can be overridden (`GINA_B830_REDACT`) to run sections 01-08
 * against another copy of redact.js.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var cp     = require('child_process');

var FW         = path.resolve(require('../fw'));
var REDACT_SRC = process.env.GINA_B830_REDACT || path.join(FW, 'lib/logger/src/redact.js');
var MAIN_SRC   = path.join(FW, 'lib/logger/src/main.js');

var redact = require(REDACT_SRC);
var M      = redact.MARKER;

/** Characters built from their code, never typed. */
function ch(code) { return String.fromCharCode(code); }
var BS = ch(92), LF = ch(10), CR = ch(13), TAB = ch(9), ESC = ch(0x1b), LS = ch(0x2028);
/** The visible escape of a line feed, a carriage return, a tab. */
var vLF = BS + 'n', vCR = BS + 'r', vTAB = BS + 't';

var JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl';
var TOK = 'abcdefghijklmnopqrstuvwxyz012345';
var PEM = '-----BEGIN PRIVATE KEY-----' + LF + 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + LF + '-----END PRIVATE KEY-----';

function defaults(secrets) { return redact.compileState([redact.compileBlock()], secrets || []); }
/** What one `replace` per rule gives: the reading of the message as written, alone. */
function asWritten(st, c) {
    if (st.secretRe) { c = c.replace(st.secretRe, M); }
    st.rules.forEach(function (r) { c = c.replace(r.re, r.replacement); });
    return c;
}
/** The decoded reading alone, built from the module's own primitives (the subtract of section 05). */
function decodedOnly(st, c) {
    var v = redact.decodeView(c);
    if (!v) { return asWritten(st, c); }
    if (st.secretRe) { c = redact.replaceThroughView({ re: st.secretRe, replacement: M }, c, v); v = redact.decodeView(c); }
    st.rules.forEach(function (r) {
        if (v) { c = redact.replaceThroughView(r, c, v); v = redact.decodeView(c); } else { c = c.replace(r.re, r.replacement); }
    });
    return c;
}
/** A reading in which every character sits where it sits in the text: forces the mapped path on any input. */
function identityView(s) { var map = []; for (var i = 0; i <= s.length; i++) { map.push(i); } return { text: s, map: map }; }
/** Does `s` hold a control character (C0, DEL, C1)? */
function hasControl(s) { for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) { return true; } } return false; }


// ─── 01  the decoded reading ────────────────────────────────────────────────
describe('01 - the decoded reading and its offset map', function () {

    it('each visible escape is read as the character it stands for', function () {
        assert.equal(redact.decodeView('a' + vLF + 'b' + vCR + 'c' + vTAB + 'd').text, 'a' + LF + 'b' + CR + 'c' + TAB + 'd');
        assert.equal(redact.decodeView('x' + BS + 'u001b[31m').text, 'x' + ESC + '[31m');
        assert.equal(redact.decodeView('x' + BS + 'u2028y').text, 'x' + LS + 'y');
    });

    it('the map gives, for each decoded character, where it starts in the text as written', function () {
        var v = redact.decodeView('a' + vLF + 'b');
        assert.deepEqual(v.map, [0, 1, 3, 4]);
        var w = redact.decodeView(BS + 'u0007ab' + vTAB);
        assert.equal(w.text, ch(7) + 'ab' + TAB);
        assert.deepEqual(w.map, [0, 6, 7, 8, 10]);
    });

    it('no visible escape gives null: a backslash alone, a Windows path, a four-hex escape of a printable character', function () {
        assert.equal(redact.decodeView('GET [200] /files/42'), null);
        assert.equal(redact.decodeView('C:' + BS + 'Users' + BS + 'me'), null);
        assert.equal(redact.decodeView('x' + BS + 'u0041y'), null);
    });

    it('a quote escape is read as the quote (#B834): the object writers escape the quotes of a string value', function () {
        assert.equal(redact.decodeView('say ' + BS + '"hi' + BS + '"').text, 'say "hi"');
    });

    it('a WRITTEN backslash + n is read as a line feed too (the reading is not an inverse)', function () {
        assert.equal(redact.decodeView('C:' + BS + 'new' + BS + 'temp').text, 'C:' + LF + 'ew' + TAB + 'emp');
    });
});


// ─── 02  no visible escape ──────────────────────────────────────────────────
describe('02 - a message with no visible escape is redacted exactly as before', function () {
    var HEX64 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    var LONG  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    // every message of test/lib/logger-redact.test.js, positives and negatives
    var VECTORS = [
        'GET [200] /reset?token=8f3a9c2e1b7d&x=1', 'GET [302] /cb?access_token=ya29.a0AfH6SMB&expires=3600', 'GET [200] /dl?sig=MEUCIQDx7b3',
        'GET [200] /api?api_key=AIzaSyD-9tSrke72', 'POST [200] /login  Authorization: Bearer ' + LONG, 'cookie=' + LONG + '; path=/',
        'proxy target https://svc:S3cr3tP%40ss@internal.host:8443/v1', 'authorization: Basic dXNlcjpwYXNzd29yZDEyMw==', 'x-api-key: 7c9e6679-7425-40de-944b-e07fc1f90ae7',
        '[ ref abc ][ req 12 ] GET [ 404 ] /invite?otp=482913' + LF + 'Error: route not found for /invite?otp=482913', 'a?token=one b?token=two',
        'GET [200] /files/' + HEX64, 'GET [200] /objects/' + HEX64 + '/original.png', 'GET [200] /users/7c9e6679-7425-40de-944b-e07fc1f90ae7',
        'GET [200] /list?page=2&sort=name&code=FR&key=name&session=1', 'GET [200] /search?q=bearer%20authentication&tokenizer=basic',
        'Bearer authentication is configured; Basic authentication is disabled', 'connected to redis://cache.internal:6379/0 in 12ms',
        'fetch https://example.com:8443/path@v2/file', 'user john.doe@example.com signed in at 2026-08-28T10:00:00.000Z',
        '{"id":"' + HEX64 + '","sha":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}', 'GET [200] /assets/app.3f2a9c1b.min.js',
        'validator token count=3 secret_key_len=32', 'my_token=abc mytoken=def', 'GET [200] /r?token=abc', 'GET /i/inv_42 inv_7', 'GET /j?INVITE=abc&invite=def',
        'couchbase://correct-horse-battery@db ok correct-horse-battery', 'x abcdefgh-longer-tail y', 'pw=p4ss.w0rd(1)+ pw2=p4ssXw0rd(1)+',
        'Error: boom' + LF + '    at one (a.js:1:1)' + LF + '    at two (b.js:2:2)', 'two' + TAB + 'columns', 'C:' + BS + 'Users' + BS + 'me' + BS + 'file.dat token=abc'
    ];
    var STATES = [
        defaults(['correct-horse-battery', 'abcdefgh', 'abcdefgh-longer-tail', 'p4ss.w0rd(1)+']),
        redact.compileState([redact.compileBlock({ defaults: false, patterns: ['inv_[0-9]+', { pattern: '(invite=)[^&\\s]+', flags: 'i', replacement: '$1' + M }] })])
    ];

    it('CONTROL: none of the vectors holds a visible escape, and the set does hold credentials', function () {
        VECTORS.forEach(function (v) { assert.equal(redact.decodeView(v), null, v); });
        assert.ok(VECTORS.filter(function (v) { return asWritten(STATES[0], v) !== v; }).length >= 12);
    });

    it('apply() equals one replace per rule, on every vector and both states', function () {
        STATES.forEach(function (st, n) {
            VECTORS.forEach(function (v) { assert.equal(redact.apply(st, v), asWritten(st, v), 'state ' + n + ': ' + v); });
        });
    });
});


// ─── 03  the mapped replace equals the native one ───────────────────────────
describe('03 - the mapped replace equals String.prototype.replace', function () {
    var PATTERNS = [
        ['token=([^&\\s]+)', 'g'], ['(invite=)[^&\\s]+', 'gi'], ['(?<k>pwd|key)=(?<v>\\w+)', 'g'], ['\\b', 'g'], ['(?=a)', 'g'], ['a|(b)|(c)', 'g'],
        ['(a)(b)?(c)?(d)?(e)?(f)?(g)?(h)?(i)?(j)?(k)?', 'g'], ['[0-9a-f]{4,}', 'g'], ['(x+)(y*)', 'gy'], ['\\s+', 'g'], ['.', 'gs'], ['(\\p{L}+)', 'gu'],
        ['(?=\\p{L})', 'gu'], ['$', 'gm'], ['^(\\w)', 'gm'], ['((a)|(b))+', 'g'], ['(?<![\\w.-])(?:auth|sig)=([^&\\s#\'"]+)', 'gi']
    ];
    var TEMPLATES = ['[REDACTED]', '$1[REDACTED]', '$&', '$$', '$`', "$'", '$1$2', '$2-$1', '$0', '$00', '$01', '$10', '$11', '$12', '$99',
        '$<k>=$<v>', '$<v>', '$<nope>', '$<', '$<k', 'a$', '$', '$$$1', '<$&>$1', '$1$', "[$`|$&|$']", '$3$4$5', '$<k>$1$&$$'];
    var ALPHA = ['a', 'b', 'c', 'x', 'y', '=', '&', ' ', LF, 't', 'o', 'k', 'e', 'n', '1', 'f', 'p', 'w', 'd', '-', '.', ch(0xd83d) + ch(0xde00), ch(0xe9), TAB, '$'];
    var FIXED = ['', 'token=abc&x=1 token=def', 'pwd=one key=two', 'aXbXc', 'abcdefghijk abc', 'xxyy xy x', 'INVITE=abc&invite=def', 'auth=a sig=b my-auth=c',
        'a' + LF + 'b' + LF + 'c', ch(0xd83d) + ch(0xde00) + 'a' + ch(0xd83d) + ch(0xde00), 'ab', 'ba', 'aaa'];
    var seed = 20261009;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    function input() { var n = Math.floor(rnd() * 40), s = ''; for (var i = 0; i < n; i++) { s += ALPHA[Math.floor(rnd() * ALPHA.length)]; } return s; }

    it('every pattern x every replacement form x fixed and seeded inputs', function () {
        var cases = 0, bad = [];
        PATTERNS.forEach(function (p) {
            TEMPLATES.forEach(function (t) {
                var inputs = FIXED.slice();
                for (var i = 0; i < 12; i++) { inputs.push(input()); }
                inputs.forEach(function (s) {
                    var want = s.replace(new RegExp(p[0], p[1]), t);
                    var got  = redact.replaceThroughView({ re: new RegExp(p[0], p[1]), replacement: t }, s, identityView(s));
                    cases++;
                    if (got !== want && bad.length < 5) { bad.push(JSON.stringify({ pattern: p, replacement: t, input: s, want: want, got: got })); }
                });
            });
        });
        assert.deepEqual(bad, []);
        assert.equal(cases, PATTERNS.length * TEMPLATES.length * (FIXED.length + 12));
    });

    it('the built-in rules, on their own shapes and on seeded text', function () {
        var st = defaults(), bad = [];
        var shapes = ['GET [200] /reset?token=8f3a9c2e1b7d&x=1', 'cookie=' + JWT + '; path=/', 'proxy target https://svc:S3cr3tP%40ss@internal.host:8443/v1',
            'authorization: Basic dXNlcjpwYXNzd29yZDEyMw==', 'x-api-key: 7c9e6679-7425-40de-944b-e07fc1f90ae7', 'Authorization: Bearer ' + TOK, 'a?token=one b?token=two'];
        st.rules.forEach(function (rule) {
            var inputs = shapes.slice();
            for (var i = 0; i < 300; i++) { inputs.push(input()); }
            inputs.forEach(function (s) {
                var want = s.replace(rule.re, rule.replacement), got = redact.replaceThroughView(rule, s, identityView(s));
                if (got !== want && bad.length < 5) { bad.push(JSON.stringify({ rule: rule.name, input: s, want: want, got: got })); }
            });
        });
        assert.deepEqual(bad, []);
    });

    it('CONTROL: the comparison tells a wrong expansion from a right one', function () {
        var s = 'token=abc';
        assert.equal(redact.replaceThroughView({ re: /token=(\w+)/g, replacement: '$1!' }, s, identityView(s)), 'abc!');
        assert.notEqual(redact.replaceThroughView({ re: /token=(\w+)/g, replacement: '$2!' }, s, identityView(s)), 'abc!');
    });
});


// ─── 04  found on the decoded reading only ──────────────────────────────────
describe('04 - a credential next to a visible escape is masked (found on the decoded reading)', function () {

    /** One arm: printed by the reading as written alone, masked by apply(). */
    function arm(st, msg, needle, label) {
        assert.ok(asWritten(st, msg).indexOf(needle) > -1, 'PREMISE (' + label + '): one replace per rule prints it');
        var out = redact.apply(st, msg);
        assert.equal(out.indexOf(needle), -1, label + ': ' + out);
        assert.ok(out.indexOf(M) > -1, label);
        return out;
    }

    it('`password=` right after an escaped line feed, in an object value', function () {
        var out = arm(defaults(), '"env": "A=1' + vLF + 'password=hunter2hunter2"', 'hunter2', 'password');
        assert.equal(out, '"env": "A=1' + vLF + 'password=' + M + '"', 'the key and the escape before it are kept as written');
    });

    it('a JWT right after an escaped line feed', function () {
        arm(defaults(), '"raw": "x' + vLF + JWT + '"', 'c2lnbmF0', 'jwt');
    });

    it('`Bearer`, an escaped tab, then the token', function () {
        var out = arm(defaults(), '"h": "Authorization: Bearer' + vTAB + TOK + '"', 'abcdefghij', 'bearer');
        assert.equal(out, '"h": "Authorization: Bearer' + vTAB + M + '"');
    });

    it('an `x-auth-token` header right after an escaped line feed', function () {
        arm(defaults(), '"h": "Host: x' + vLF + 'x-auth-token: ' + TOK + '"', 'abcdefghij', 'headerkey');
    });

    it('a JSON string the caller built: `password=` after the `\\n` JSON.stringify wrote', function () {
        arm(defaults(), 'conf ' + JSON.stringify({ env: 'A=1' + LF + 'password=hunter2hunter2' }), 'hunter2', 'caller-stringified');
    });

    it('a central error detail: `password=` on a line the frame-keeping escape joined', function () {
        arm(defaults(), '[ BUNDLE ][ app ] GET [ 500 ] /x' + LF + 'connect failed:' + vLF + 'password=hunter2hunter2' + LF + '    at f (a.js:1:1)', 'hunter2', 'detail');
    });

    it('a secret value holding line feeds, written with its line feeds as escapes', function () {
        var st = defaults([PEM]);
        var out = arm(st, '"key": "' + PEM.split(LF).join(vLF) + '"', 'MIIEvQ', 'multi-line secret');
        assert.equal(out, '"key": "' + M + '"');
    });

    it('a secret value holding a tab, and one holding an ESC written as `\\u001b`', function () {
        var tab = 'pass' + TAB + 'word-with-tab-1234', esc = 'pre' + ESC + 'post-secret-1234';
        arm(defaults([tab]), '"k": "' + tab.split(TAB).join(vTAB) + '"', 'word-with-tab', 'tab secret');
        arm(defaults([esc]), '"k": "pre' + BS + 'u001bpost-secret-1234"', 'post-secret', 'esc secret');
    });

    it("a bundle's own pattern sees the boundary too", function () {
        var st = redact.compileState([redact.compileBlock({ defaults: false, patterns: ['\\binv_[0-9]+', { pattern: '(\\sinvite=)[^"\\s]+', replacement: '$1' + M }] })]);
        assert.equal(redact.apply(st, '"q": "a' + vLF + 'inv_42"'), '"q": "a' + vLF + M + '"');
        assert.equal(redact.apply(st, '"q": "a=1' + vLF + 'invite=abcdef"'), '"q": "a=1' + vLF + 'invite=' + M + '"');
    });
});


// ─── 05  found as written only ──────────────────────────────────────────────
describe('05 - a credential that itself holds a written backslash sequence is masked (found as written)', function () {
    var PW = 'S3cr3t' + BS + 'nPassw0rd';          // a password with a backslash and an n in it

    /** One arm: masked by apply(), and PRINTED by the decoded reading alone (the subtract). */
    function arm(st, msg, needle, label) {
        assert.equal(redact.apply(st, msg).indexOf(needle), -1, label + ': apply() masks it');
        assert.ok(decodedOnly(st, msg).indexOf(needle) > -1, 'SUBTRACT (' + label + '): the decoded reading alone prints it');
    }

    it('a registered secret, printed verbatim in a plain string', function () {
        arm(defaults([PW]), 'connect failed pw=' + PW + ' host=db', 'Passw0rd', 'secret');
    });

    it('the same password in a connection string (the userinfo rule)', function () {
        arm(defaults(), 'connecting to mongodb://app:' + PW + '@db.internal:27017/x', 'Passw0rd', 'userinfo');
    });

    it('`password=` whose value holds a backslash + t', function () {
        arm(defaults(), 'retry with password=ab' + BS + 'tcdEFGH and continue', 'cdEFGH', 'querykey');
    });

    it('CONTROL: the decoded reading alone does mask what section 04 is about', function () {
        var msg = '"env": "A=1' + vLF + 'password=hunter2hunter2"';
        assert.equal(decodedOnly(defaults(), msg).indexOf('hunter2'), -1);
    });
});


// ─── 06  secrets on both readings ───────────────────────────────────────────
describe('06 - secret values: the spans of the two readings are merged', function () {

    it('a short secret found as written inside a longer one found decoded: one mask, nothing of the longer one left', function () {
        var st = redact.compileState([redact.compileBlock({ defaults: false })], ['abcdefgh', 'xx-head' + LF + 'abcdefgh']);
        assert.equal(redact.apply(st, 'v="xx-head' + vLF + 'abcdefgh" end'), 'v="' + M + '" end');
        assert.ok(asWritten(st, 'v="xx-head' + vLF + 'abcdefgh" end').indexOf('xx-head') > -1, 'PREMISE: as written alone leaves the head');
    });

    it('the same secret found by both readings is masked once', function () {
        var st = redact.compileState([redact.compileBlock({ defaults: false })], ['correct-horse-battery']);
        assert.equal(redact.apply(st, 'a' + vLF + 'pw=correct-horse-battery z'), 'a' + vLF + 'pw=' + M + ' z');
    });

    it('two secrets side by side give two masks, as one replace does', function () {
        var st = redact.compileState([redact.compileBlock({ defaults: false })], ['aaaaaaaa', 'bbbbbbbb']);
        assert.equal(redact.apply(st, 'x' + vTAB + 'aaaaaaaabbbbbbbb'), 'x' + vTAB + M + M);
    });

    it('a secret is masked before any pattern runs, on a message with an escape as on one without', function () {
        var st = defaults(['token=keep-this-whole-value-together']);
        assert.equal(redact.apply(st, 'a' + vLF + 'token=keep-this-whole-value-together'), 'a' + vLF + M);
    });
});


// ─── 07  kept groups are copied as written ──────────────────────────────────
describe('07 - nothing decoded is written back', function () {

    it('a kept group that spans an escape keeps the escape visible', function () {
        var out = redact.apply(defaults(), 'Authorization: Bearer' + vTAB + TOK);
        assert.equal(out, 'Authorization: Bearer' + vTAB + M);
        assert.equal(hasControl(out), false);
    });

    it('`$&`, a named group and `$$`, each on a match that holds an escape', function () {
        var mk = function (replacement) { return redact.compileState([redact.compileBlock({ defaults: false, patterns: [{ pattern: '(?<k>key)\\s(?<v>\\w+)', replacement: replacement }] })]); };
        var msg = 'x key' + vLF + 'abc y';
        assert.equal(redact.apply(mk('<$&>'), msg), 'x <key' + vLF + 'abc> y');
        assert.equal(redact.apply(mk('$<k>=$$' + M), msg), 'x key=$' + M + ' y');
        assert.equal(redact.apply(mk('$<v>:$<k>'), msg), 'x abc:key y');
        [mk('<$&>'), mk('$<k>=$$' + M), mk('$<v>:$<k>')].forEach(function (st) { assert.equal(hasControl(redact.apply(st, msg)), false); });
    });

    it('no message of this file gains a control character from apply()', function () {
        var st = defaults([PEM, 'pass' + TAB + 'word-with-tab-1234']);
        ['"env": "A=1' + vLF + 'password=hunter2hunter2"', '"key": "' + PEM.split(LF).join(vLF) + '"', '"h": "Bearer' + vTAB + TOK + '"',
            'x' + BS + 'u001b[31m password=abc' + BS + 'u2028 y', 'upstream:' + vCR + vLF + 'https://u:p4ssw0rdp4ss@h/'].forEach(function (msg) {
            assert.equal(hasControl(redact.apply(st, msg)), false, msg);
        });
    });
});


// ─── 08  negatives and idempotence ──────────────────────────────────────────
describe('08 - credential-free text and idempotence', function () {
    var NEG = [
        'C:' + BS + 'new' + BS + 'temp' + BS + 'report.txt',
        'regex /' + BS + 'bfoo' + BS + 'n' + BS + 't' + BS + 'u0041/ compiled',
        '"msg": "line one' + vLF + 'line two' + vLF + '"',
        'Page not found: ' + vLF + '/app/nope',
        '"a": "x' + BS + 'u0000y' + BS + 'u001b[31m' + BS + 'u2028z"',
        'path D:' + BS + 'repo' + BS + 'node_modules' + BS + 'token' + BS + 'readme.txt',
        'Bearer' + vLF + 'authentication is configured; Basic' + vTAB + 'authentication is disabled',
        '"note": "validator token count=3' + vLF + 'secret_key_len=32"'
    ];

    it('text that holds visible escapes and no credential comes back unchanged', function () {
        var st = defaults();
        NEG.forEach(function (l) { assert.equal(redact.apply(st, l), l, 'false positive on: ' + l); });
    });

    it('CONTROL: each of those lines does take the two-readings path', function () {
        NEG.forEach(function (l) { assert.notEqual(redact.decodeView(l), null, l); });
    });

    it('a redacted message re-redacts to itself', function () {
        var st = defaults([PEM]);
        ['"env": "A=1' + vLF + 'password=hunter2hunter2" token=abcdef', '"key": "' + PEM.split(LF).join(vLF) + '" Bearer' + vTAB + TOK,
            ' token=abc' + vLF + 'def&x=1'].forEach(function (msg) {
            var once = redact.apply(st, msg);
            assert.equal(redact.apply(st, once), once, msg);
        });
    });

    it('a null state, an empty string and a non-string still pass through', function () {
        assert.equal(redact.apply(null, 'a' + vLF + 'token=abc'), 'a' + vLF + 'token=abc');
        assert.equal(redact.apply(defaults(), ''), '');
        assert.equal(redact.apply(defaults(), 42), 42);
    });
});


// ─── 09  the real logger ────────────────────────────────────────────────────
describe('09 - what reaches a sink, through the real logger', function () {

    /**
     * Run `body` in a fresh process with the real logger and one redaction setup; returns the
     * content of each frame the default flow received, keyed by the tag its message starts with.
     * One process per setup: a second secret registered in the same process can mask the first
     * one's escaped form and hide a leak.
     */
    function drive(secret, body) {
        var script = [
            "process.env.GINA_LOG_STDOUT='true';process.env.GINA_LOG_FORMAT='text';",
            "var LF=String.fromCharCode(10),TAB=String.fromCharCode(9),BS=String.fromCharCode(92);",
            "var logger=require(" + JSON.stringify(MAIN_SRC) + ");var frames={};",
            "process.on('logger#default',function(p){var c=JSON.parse(p).content;frames[c.slice(0,2)]=c;});",
            "var w=process.stdout.write;process.stdout.write=function(){return true;};",
            "var SECRET=" + JSON.stringify(secret) + ";",
            "logger.setRedaction({},{group:'b830',secrets:SECRET===null?[]:[{path:'k',value:SECRET}]});",
            body,
            "process.stdout.write=w;process.stdout.write(JSON.stringify(frames));"
        ].join('');
        return JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
    }

    it('a multi-line secret inside an object, inside an array, and in a JSON string the caller built', function () {
        var f = drive(PEM, "logger.info('S1',{k:SECRET});logger.info('S2',[SECRET]);logger.info('S3 '+JSON.stringify({key:SECRET}));logger.info('S4 '+JSON.stringify({key:SECRET},null,2));logger.info('S0 v='+SECRET);");
        ['S0', 'S1', 'S2', 'S3', 'S4'].forEach(function (tag) {
            assert.ok(f[tag], tag + ' reached the flow');
            assert.equal(f[tag].indexOf('MIIEvQ'), -1, tag + ' printed the key: ' + f[tag]);
            assert.ok(f[tag].indexOf(M) > -1, tag);
        });
    });

    it('a secret holding a tab, inside an object and inside an array', function () {
        var f = drive('pass' + TAB + 'word-with-tab-1234', "logger.info('S1',{k:SECRET});logger.info('S2',[SECRET]);");
        assert.equal(f.S1.indexOf('word-with-tab'), -1, f.S1);
        assert.equal(f.S2.indexOf('word-with-tab'), -1, f.S2);
    });

    it('the built-in patterns, next to a control character held by an object value', function () {
        var f = drive(null, [
            "logger.info('Q1 user=a password=hunter2hunter2');",
            "logger.info('Q2',{env:'A=1'+LF+'password=hunter2hunter2'});",
            "logger.info('Q3',{raw:'x'+LF+" + JSON.stringify(JWT) + "});",
            "logger.info('Q4',{h:'Authorization: Bearer'+TAB+" + JSON.stringify(TOK) + "});",
            "logger.info('Q5',{h:'Host: x'+LF+'x-auth-token: '+" + JSON.stringify(TOK) + "});",
            "logger.info('Q6 conf '+JSON.stringify({env:'A=1'+LF+'password=hunter2hunter2'}));",
            "logger.info('Q7',[['A=1'+LF+'password=hunter2hunter2']]);"
        ].join(''));
        assert.equal(f.Q1.indexOf('hunter2'), -1, 'CONTROL, no control character nearby: ' + f.Q1);
        assert.equal(f.Q2.indexOf('hunter2'), -1, f.Q2);
        assert.equal(f.Q3.indexOf('c2lnbmF0'), -1, f.Q3);
        assert.equal(f.Q4.indexOf('abcdefghij'), -1, f.Q4);
        assert.equal(f.Q5.indexOf('abcdefghij'), -1, f.Q5);
        assert.equal(f.Q6.indexOf('hunter2'), -1, f.Q6);
        assert.equal(f.Q7.indexOf('hunter2'), -1, 'a nested array: ' + f.Q7);
    });

    it('a credential holding a written backslash + n or t, in a plain string', function () {
        var pw = 'S3cr3t' + BS + 'nPassw0rd';
        var f1 = drive(pw, "logger.info('U1 connect failed pw='+SECRET+' host=db');");
        assert.equal(f1.U1.indexOf('Passw0rd'), -1, f1.U1);
        var f2 = drive(null, "logger.info('U2 connecting to mongodb://app:S3cr3t'+BS+'nPassw0rd@db.internal:27017/x');logger.info('U3 retry with password=ab'+BS+'tcdEFGH and continue');");
        assert.equal(f2.U2.indexOf('Passw0rd'), -1, f2.U2);
        assert.equal(f2.U3.indexOf('cdEFGH'), -1, f2.U3);
    });

    it('CONTROL: with redaction off, the same calls print the value (the harness can see a leak)', function () {
        var script = [
            "process.env.GINA_LOG_STDOUT='true';process.env.GINA_LOG_FORMAT='text';var LF=String.fromCharCode(10);",
            "var logger=require(" + JSON.stringify(MAIN_SRC) + ");var frames={};",
            "process.on('logger#default',function(p){var c=JSON.parse(p).content;frames[c.slice(0,2)]=c;});",
            "var w=process.stdout.write;process.stdout.write=function(){return true;};",
            "logger.info('Q2',{env:'A=1'+LF+'password=hunter2hunter2'});",
            "process.stdout.write=w;process.stdout.write(JSON.stringify(frames));"
        ].join('');
        var f = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
        assert.ok(f.Q2.indexOf('hunter2') > -1, f.Q2);
    });
});
