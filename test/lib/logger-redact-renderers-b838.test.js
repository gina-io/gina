'use strict';
/**
 * A resolved secret is masked whichever renderer writes it (#B838).
 *
 * The log redaction (#B433) masks every resolved secret value in the message,
 * after the logger has rendered its arguments. Four writers can alter a value
 * before that point: the levelled string path (a carriage return becomes a
 * line feed), the logger's own object writer (read back since #B830 / #B834),
 * `JSON.stringify` (the raw `console.log` path, and any JSON string the caller
 * builds) and `util.inspect` (an `Error`, on both paths). The last two escape
 * the backslash itself, `util.inspect` also lays a value's line breaks out
 * (a long string is split after each line feed, a nested Error's message is
 * indented), and a value can be rendered more than once. A secret holding a
 * backslash, a control character, a lone surrogate or a line break was then
 * printed in full.
 *
 * `redact.apply()` now searches the secret values on every escape layer of the
 * message (`decodeEscapes`), and a secret's line breaks match the layout a
 * renderer gives them (`compileState`).
 *
 *   01  decodeEscapes(): one layer of backslash escaping read back
 *   02  compileState(): a secret's line breaks, and the head of a very long one
 *   03  apply(): the form each renderer gives a value, built with that renderer
 *   04  the real logger: every character class a renderer singles out, in every
 *       position a logged value can take (one process, an exact expected table)
 *
 * Section 04's two axes are read off the code, not listed from memory: the
 * value shapes are the branches of the logger's two argument loops plus the
 * string writers of `util.inspect`; the values are the character classes those
 * writers single out, and the lengths at which `util.inspect` changes layout.
 *
 * What stays printed is pinned too (section 04, `STILL_PRINTED`): a secret
 * that sits inside a longer string `util.inspect` cut at its `maxStringLength`.
 *
 * The framework directory can be overridden (`GINA_B838_FW`) to run every
 * section against another tree: the red-first run against the pre-fix code.
 */
var path = require('path');
var util = require('util');
var cp   = require('child_process');

var FW         = process.env.GINA_B838_FW || path.resolve(require('../fw'));
var REDACT_SRC = path.join(FW, 'lib/logger/src/redact.js');
var MAIN_SRC   = path.join(FW, 'lib/logger/src/main.js');

function ch(code) { return String.fromCharCode(code); }
var BS = ch(92), DQ = ch(34), SQ = ch(39), BT = ch(96), LF = ch(10), CR = ch(13), TAB = ch(9);

/** `n` lines, each starting with a token unique to the value (`K<id>L<nn>x`), joined by `eol`. */
function lines(id, n, eol) {
    var a = [], k;
    for (k = 0; k < n; k++) { a.push('K' + id + 'L' + ('0' + k).slice(-2) + 'x' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGhIjKlMnOpQrStUv'.slice(0, 56)); }
    return a.join(eol);
}


// ─── the sweep, run in a child process (section 04) ─────────────────────────
// usage: <runtime> <this file> --b838-sweep <logger main.js>  →  a JSON table on stdout
if (process.argv[2] === '--b838-sweep') {
    runSweep(process.argv[3]);
    return;
}

/**
 * Log one secret through every value shape, for every value, with the real
 * logger, and print the verdict of each cell. ONE process and one logger: each
 * value replaces the previous one (`setRedaction` on the same group), so a
 * single secret is registered at any time — a second one could mask the
 * first one's escaped form and hide a leak.
 *
 * A verdict: `M` the mask is there and no token of the secret is visible; `P`
 * every token is visible (printed); `p` some are; `a` neither a token nor the
 * mask; `X` the call threw.
 */
function runSweep(mainSrc) {
    process.env.GINA_LOG_STDOUT = 'true';
    process.env.GINA_LOG_FORMAT = 'json';
    var out = [], realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (s) { out.push(String(s)); return true; };
    process.stderr.write = function (s) { out.push(String(s)); return true; };
    var logger = require(mainSrc);

    function errProp(S)   { var e = new Error('connect failed'); e.dsn = S; return e; }
    function errNest(S)   { var e = new Error('connect failed'); e.options = { host: 'db.internal', password: S }; return e; }
    function errKey(S)    { var e = new Error('connect failed'); e.headers = {}; e.headers[S] = 1; return e; }
    function errArr(S)    { var e = new Error('connect failed'); e.list = [S, 'x']; return e; }
    function errMap(S)    { var e = new Error('connect failed'); e.map = new Map([['p', S]]); return e; }
    function errSet(S)    { var e = new Error('connect failed'); e.set = new Set([S]); return e; }
    function errSym(S)    { var e = new Error('connect failed'); e.sym = Symbol(S); return e; }
    function errSymKey(S) { var e = new Error('connect failed'); e[Symbol(S)] = 1; return e; }
    function errBoxed(S)  { var e = new Error('connect failed'); e.boxed = new String(S); return e; }
    function errCause(S)  { return new Error('outer failed', { cause: new Error('inner v=' + S + ' END') }); }
    function errCauseP(S) { return new Error('outer failed', { cause: errProp(S) }); }
    function errAgg(S)    { return new AggregateError([new Error('member v=' + S + ' END')], 'all failed'); }
    function errInErr(S)  { var e = new Error('connect failed'); e.inner = new Error('held v=' + S + ' END'); return e; }
    function errCustom(S) { var e = new Error('connect failed'); e.conf = {}; e.conf[util.inspect.custom] = function () { return 'Conf<' + S + '>'; }; return e; }
    function errJson(S)   { var e = new Error('request failed'); e.body = JSON.stringify({ p: S }); return e; }
    function errInsp(S)   { var e = new Error('request failed'); e.dump = util.inspect({ p: S }); return e; }
    function keyObj(S)    { var o = {}; o[S] = 1; return o; }

    // one arm per position a value can take: write() / parse() / self.log() in
    // lib/logger/src/main.js, and the string writers of util.inspect
    var ARMS = [
        // a level method: a plain string
        ['LS',  function (S) { logger.info('LS v=' + S + ' END'); }],
        ['L2',  function (S) { logger.info('L2', S); }],
        ['LW',  function (S) { logger.warn('LW v=' + S + ' END'); }],
        // a level method: the object writer
        ['LO',  function (S) { logger.info('LO', { p: S }); }],
        ['LN',  function (S) { logger.info('LN', { a: { b: S } }); }],
        ['LA',  function (S) { logger.info('LA', [S]); }],
        ['LAA', function (S) { logger.info('LAA', [[S, 'x']]); }],
        ['LOA', function (S) { logger.info('LOA', { a: [S] }); }],
        ['KO',  function (S) { logger.info('KO', keyObj(S)); }],
        ['KN',  function (S) { logger.info('KN', { a: keyObj(S) }); }],
        ['LSY', function (S) { logger.info('LSY', { p: Symbol(S) }); }],
        // a level method: an Error (util.inspect)
        ['LE',  function (S) { logger.error(new Error('LE v=' + S + ' END')); }],
        ['E3',  function (S) { logger.error(errProp(S)); }],
        ['E1',  function (S) { logger.error(errNest(S)); }],
        ['E5',  function (S) { logger.error('E5 failed:', errProp(S)); }],
        ['EK',  function (S) { logger.error(errKey(S)); }],
        ['EA',  function (S) { logger.error(errArr(S)); }],
        ['EM',  function (S) { logger.error(errMap(S)); }],
        ['ES',  function (S) { logger.error(errSet(S)); }],
        ['EY',  function (S) { logger.error(errSym(S)); }],
        ['EYK', function (S) { logger.error(errSymKey(S)); }],
        ['EB',  function (S) { logger.error(errBoxed(S)); }],
        ['EC',  function (S) { logger.error(errCause(S)); }],
        ['ECP', function (S) { logger.error(errCauseP(S)); }],
        ['EG',  function (S) { logger.error(errAgg(S)); }],
        ['EE',  function (S) { logger.error(errInErr(S)); }],
        ['EX',  function (S) { logger.error(errCustom(S)); }],
        ['NE',  function (S) { logger.info('NE', { err: errProp(S) }); }],
        ['NEC', function (S) { logger.info('NEC', { err: errCause(S) }); }],
        // console.log: the raw path
        ['RS',  function (S) { logger.log('RS v=' + S + ' END'); }],
        ['RO',  function (S) { logger.log('RO', { p: S }); }],
        ['RN',  function (S) { logger.log('RN', { a: { b: S } }); }],
        ['RA',  function (S) { logger.log('RA', [S]); }],
        ['KR',  function (S) { logger.log('KR', keyObj(S)); }],
        ['RE',  function (S) { logger.log(new Error('RE v=' + S + ' END')); }],
        ['E4',  function (S) { logger.log(errProp(S)); }],
        ['E2',  function (S) { logger.log(errNest(S)); }],
        ['RC',  function (S) { logger.log(errCause(S)); }],
        ['NR',  function (S) { logger.log('NR', { err: errProp(S) }); }],
        ['NRC', function (S) { logger.log('NRC', { err: errCause(S) }); }],
        ['NRM', function (S) { logger.log('NRM', { err: new Error('NRM v=' + S + ' END') }); }],
        // a string the caller serialised, logged as a string
        ['LJ',  function (S) { logger.info('LJ ' + JSON.stringify({ p: S })); }],
        ['RJ',  function (S) { logger.log('RJ ', JSON.stringify({ p: S }, null, 2)); }],
        ['LI',  function (S) { logger.info('LI ' + util.inspect({ p: S })); }],
        ['RI',  function (S) { logger.log('RI ' + util.inspect({ p: S })); }],
        ['LFE', function (S) { logger.error('LFE ' + util.inspect(errCause(S))); }],
        // ... then rendered again by the logger (two layers)
        ['OJ',  function (S) { logger.info('OJ', { payload: JSON.stringify({ p: S }) }); }],
        ['OI',  function (S) { logger.info('OI', { dump: util.inspect({ p: S }) }); }],
        ['RJJ', function (S) { logger.log('RJJ', { payload: JSON.stringify({ p: S }) }); }],
        ['RJI', function (S) { logger.log('RJI', { dump: util.inspect({ p: S }) }); }],
        ['EJ',  function (S) { logger.error(errJson(S)); }],
        ['EI',  function (S) { logger.error(errInsp(S)); }],
        // ... and by the logger's own double rendering on top (three layers)
        ['NRJ', function (S) { logger.log('NRJ', { err: errJson(S) }); }],
        ['NRI', function (S) { logger.log('NRI', { err: errInsp(S) }); }]
    ];

    // every character class a renderer singles out, in the middle of the secret
    var CASES = [], i;
    function add(label, mid, at) { CASES.push({ label: label, mid: mid, at: at || 'mid' }); }
    function hex4(n) { return 'U+' + ('000' + n.toString(16).toUpperCase()).slice(-4); }
    for (i = 0; i <= 0x1f; i++) { add(hex4(i), ch(i)); }
    for (i = 0x7f; i <= 0x9f; i++) { add(hex4(i), ch(i)); }
    [0xa0, 0xad, 0x2028, 0x2029, 0x202e, 0xfeff].forEach(function (n) { add(hex4(n), ch(n)); });
    [0xd800, 0xdbff, 0xdc00, 0xdfff].forEach(function (n) { add('lone ' + hex4(n), ch(n)); });
    [['astral pair', ch(0xd83d) + ch(0xde00)], ['e-acute', ch(0xe9)], ['backslash', BS], ['dquote', DQ], ['squote', SQ], ['backtick', BT],
     ['squote+dquote', SQ + DQ], ['all three quotes', SQ + DQ + BT], ['squote+${', SQ + '${'], ['squote+dquote+${', SQ + DQ + '${'],
     ['written \\n', BS + 'n'], ['written \\r', BS + 'r'], ['written \\t', BS + 't'], ['written \\b', BS + 'b'], ['written \\f', BS + 'f'],
     ['written \\u0041', BS + 'u0041'], ['written \\x41', BS + 'x41'], ['written \\\\', BS + BS], ['written \\"', BS + DQ], ['written \\\'', BS + SQ],
     ['three backslashes', BS + BS + BS], ['backslash + LF', BS + LF], ['backslash + CR', BS + CR], ['backslash + U+0001', BS + ch(1)],
     ['LF + backslash', LF + BS], ['dquote + backslash', DQ + BS], ['CR LF', CR + LF], ['LF LF', LF + LF], ['CR CR', CR + CR], ['LF + spaces', LF + '   '],
     ['LF + squote', LF + SQ], ['LF + squote + plus', LF + SQ + ' + ' + SQ], ['TAB TAB', TAB + TAB], ['space-padded', '  '],
     ['%s', '%s'], ['%d', '%d'], ['%j', '%j'], ['%o', '%o'], ['%%', '%%'], ['$&', '$&'], ['$1', '$1'], ['$$', '$$'], ['$`', '$' + BT],
     ['<', '<'], ['>', '>'], ['&', '&'], ['{', '{'], ['}', '}'], ['+', '+'], ['/', '/'], ['=', '='], ['(', '('], [')', ')'], ['[', '['], [']', ']'],
     ['|', '|'], ['*', '*'], ['?', '?'], ['.', '.'], ['^', '^'], ['#', '#'], ['@', '@'], [':', ':'], [';', ';'], [',', ','], ['!', '!'], ['~', '~'],
     ['-', '-'], ['_', '_'], ['+/==', '+/==']
    ].forEach(function (p) { add(p[0], p[1]); });
    // the same special character at an edge of the secret
    [['LF', LF], ['CR', CR], ['CR LF', CR + LF], ['TAB', TAB], ['U+0001', ch(1)], ['backslash', BS], ['dquote', DQ], ['squote', SQ],
     ['lone U+D800', ch(0xd800)], ['lone U+DC00', ch(0xdc00)]].forEach(function (p) {
        add(p[0] + ' at the start', p[1], 'start');
        add(p[0] + ' at the end', p[1], 'end');
    });
    // long values: the layout util.inspect gives a value depends on its length
    var LONGS = [
        ['long: 12 lines LF',                  function (id) { return lines(id, 12, LF); }],
        ['long: 12 lines CR LF',               function (id) { return lines(id, 12, CR + LF); }],
        ['long: 12 lines CR',                  function (id) { return lines(id, 12, CR); }],
        ['long: 12 lines LF, final LF',        function (id) { return lines(id, 12, LF) + LF; }],
        ['long: lines ending in a squote',     function (id) { return lines(id, 6, SQ + LF); }],
        ['long: squote lines then dquote lines', function (id) { return lines(id, 3, SQ + LF) + LF + lines(id + 'b', 3, DQ + LF); }],
        ['long: lines ending in a backslash',  function (id) { return lines(id, 6, BS + LF); }],
        ['long: one line',                     function (id) { return lines(id, 5, '-'); }],
        ['long: one line, backslash + quotes', function (id) { return lines(id, 5, BS + SQ + DQ); }],
        ['long: 2 lines, 71 characters',       function (id) { return 'K' + id + 'L00x' + 'AbCdEfGhIjKlMnOpQrStUvWx' + LF + 'K' + id + 'L01x' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'; }],
        ['long: over 10,000 characters, one line',  function (id) { return 'K' + id + 'L00x' + new Array(1001).join('AbCdEfGhIj') + 'K' + id + 'L99x' + new Array(4).join('0123456789'); }],
        ['long: over 10,000 characters, 160 lines', function (id) { return lines(id, 160, LF); }]
    ];

    function verdict(msg, tokens) {
        if (msg === undefined || msg === '') { return '-'; }
        if (msg.indexOf('THREW') === 0) { return 'X'; }
        var seen = 0, t;
        for (t = 0; t < tokens.length; t++) { if (msg.indexOf(tokens[t]) > -1) { seen++; } }
        if (seen === tokens.length) { return 'P'; }
        if (seen > 0) { return 'p'; }
        return msg.indexOf('[REDACTED]') > -1 ? 'M' : 'a';
    }
    function drive(secret, tokens, on) {
        if (on) { logger.setRedaction({}, { group: 'b838', secrets: [{ path: 'k', value: secret }] }); }
        else    { logger.setRedaction({ enabled: false }, { group: 'b838' }); }
        return ARMS.map(function (arm) {
            var res, msgs = [];
            out.length = 0;
            try { arm[1](secret); } catch (e) { res = 'THREW ' + e.message; }
            if (res === undefined) {
                out.join('').split(LF).forEach(function (line) {
                    if (!line) { return; }
                    try { var o = JSON.parse(line); msgs.push(typeof o.message === 'string' ? o.message : JSON.stringify(o)); } catch (e2) { msgs.push(line); }
                });
                res = msgs.join(ch(0));
            }
            return verdict(res, tokens);
        }).join(' ');
    }

    var table = { arms: ARMS.map(function (a) { return a[0]; }), rows: [] };
    table.rows.push(['CONTROL: no redaction', drive('zzP000xkyTAIL000QQ', ['zzP000x', 'yTAIL000QQ'], false)]);
    table.rows.push(['CONTROL: a plain value', drive('zzP999xkyTAIL999QQ', ['zzP999x', 'yTAIL999QQ'], true)]);
    CASES.forEach(function (c, n) {
        var id = ('00' + (n + 1)).slice(-3), P = 'zzP' + id + 'x', T = 'yTAIL' + id + 'QQ';
        var secret = c.at === 'start' ? c.mid + P + T : (c.at === 'end' ? P + T + c.mid : P + c.mid + T);
        table.rows.push([c.label, drive(secret, [P, T], true)]);
    });
    LONGS.forEach(function (l, n) {
        var id = ch(65 + n) + 'q', secret = l[1](id), tokens = secret.match(new RegExp('K' + id + 'b?L\\d\\dx', 'g'));
        table.rows.push([l[0], drive(secret, tokens, true)]);
        table.rows.push(['CONTROL: no redaction, ' + l[0], drive(secret, tokens, false)]);
    });
    process.stdout.write = realWrite;
    process.stdout.write(JSON.stringify(table));
}


var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var redact = require(REDACT_SRC);
var M      = redact.MARKER;

/** The default rule set plus one secret, compiled the way `setRedaction()` compiles it. */
function stateFor(secret) { return redact.compileState([redact.compileBlock()], [secret]); }

/** The literal source `compileState` built for every value before #B838 (replica of `escapeRegExp`). */
function literalSource(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

var LAYOUT = '[\\s' + SQ + DQ + BT + '+]*';


// ─── 01  decodeEscapes ──────────────────────────────────────────────────────
describe('01 - decodeEscapes(): one layer of backslash escaping read back', function () {

    it('reads every escape JSON.stringify and util.inspect write', function () {
        [[BS + BS, BS], [BS + DQ, DQ], [BS + SQ, SQ], [BS + '/', '/'], [BS + 'b', ch(8)], [BS + 'f', ch(12)], [BS + 'n', LF], [BS + 'r', CR],
         [BS + 't', TAB], [BS + 'x01', ch(1)], [BS + 'x7F', ch(0x7f)], [BS + 'x9f', ch(0x9f)], [BS + 'u0000', ch(0)], [BS + 'ud800', ch(0xd800)],
         [BS + 'uDFFF', ch(0xdfff)], [BS + 'u00e9', ch(0xe9)]].forEach(function (p) {
            assert.equal(redact.decodeEscapes('a' + p[0] + 'b').text, 'a' + p[1] + 'b', JSON.stringify(p[0]));
        });
    });

    it('is the exact inverse of one layer of each renderer, for every UTF-16 code unit below U+0100 and a lone surrogate', function () {
        var s = '', i;
        for (i = 0; i < 0x100; i++) { s += ch(i) + 'z'; }
        s += ch(0xd800) + 'z' + ch(0xdc00) + 'z';
        var json = JSON.stringify(s).slice(1, -1);
        assert.equal(redact.decodeEscapes(json).text, s, 'JSON.stringify');
        // util.inspect picks the quote by content: escape the single quote (a value holding the three quotes)
        var insp = util.inspect(s, { maxStringLength: Infinity, breakLength: Infinity });
        assert.equal(insp.charAt(0), SQ, 'the probe value is wrapped in single quotes');
        assert.equal(redact.decodeEscapes(insp.slice(1, -1)).text, s, 'util.inspect');
    });

    it('maps each character back to its offset, with one trailing entry', function () {
        assert.deepEqual(redact.decodeEscapes('a' + BS + BS + 'b'), { text: 'a' + BS + 'b', map: [0, 1, 3, 4] });
        assert.deepEqual(redact.decodeEscapes('a' + BS + 'x01b'), { text: 'a' + ch(1) + 'b', map: [0, 1, 5, 6] });
        assert.deepEqual(redact.decodeEscapes(BS + 'ud800'), { text: ch(0xd800), map: [0, 6] });
    });

    it('leaves what is not an escape as written, and returns null when nothing was read', function () {
        assert.equal(redact.decodeEscapes('no backslash'), null);
        assert.equal(redact.decodeEscapes('C:' + BS + 'Users' + BS + 'me'), null);
        assert.equal(redact.decodeEscapes('tail' + BS), null);
        assert.equal(redact.decodeEscapes(BS + 'xZZ' + BS + 'u12'), null);
        assert.equal(redact.decodeEscapes(BS + 'q' + BS + BS + 'n').text, BS + 'q' + BS + 'n');
    });

    it('CONTROL: decodeView() is unchanged — it still leaves an escaped backslash as written', function () {
        assert.equal(redact.decodeView('C:' + BS + BS + 'Users'), null);
        assert.equal(redact.decodeView('a' + BS + BS + 'nb').text, 'a' + BS + LF + 'b');
    });
});


// ─── 02  compileState ───────────────────────────────────────────────────────
describe('02 - compileState(): a secret\'s line breaks, and the head of a very long one', function () {

    it('CONTROL: a value holding no line break compiles to the same literal source as before', function () {
        ['plain-secret-value-5678', 'p@ss.w0rd$^*+?()[]{}|/' + BS + 'x', 'it' + SQ + 's' + DQ + BT + '-quoted-123', 'tab' + TAB + 'and' + ch(1) + 'control'].forEach(function (v) {
            assert.equal(stateFor(v).secretRe.source, new RegExp(literalSource(v)).source, JSON.stringify(v));
        });
    });

    it('a carriage return matches a carriage return or a line feed; a line feed is followed by the layout class', function () {
        assert.equal(stateFor('abcd' + CR + LF + 'efgh').secretRe.source, new RegExp('abcd[\\r\\n]\\n' + LAYOUT + 'efgh').source);
        assert.equal(stateFor('abcdefgh' + CR + 'ij').secretRe.source, new RegExp('abcdefgh[\\r\\n]ij').source);
    });

    it('nothing is tolerated at the very end of a value', function () {
        assert.equal(stateFor('abcdefgh' + LF).secretRe.source, new RegExp('abcdefgh\\n').source);
        assert.equal(stateFor('abcdefgh' + LF + '  ').secretRe.source, new RegExp('abcdefgh\\n  ').source);
        assert.equal(redact.apply(stateFor('abcdefgh' + LF), 'v=abcdefgh' + LF + '   next'), 'v=' + M + '   next');
    });

    it('the layout characters a value holds after a line feed join the run: no two variable-length parts are adjacent', function () {
        ['abcdefgh' + LF + LF + LF + 'ij', 'abcdefgh' + LF + '  ' + LF + SQ + ' + ' + SQ + 'ij', 'abcdefgh' + LF + CR + LF + '+ij', LF + LF + 'abcdefgh' + LF + ' ' + CR + 'ij'].forEach(function (v) {
            var src = stateFor(v).secretRe.source;
            assert.equal(/\]\*(?:\\n|\[)/.test(src), false, 'adjacent variable-length parts in ' + src);
            assert.equal(redact.apply(stateFor(v), 'v=' + v + '.'), 'v=' + M + '.', JSON.stringify(v));
        });
    });

    it('a value longer than util.inspect\'s maxStringLength also masks the head util.inspect keeps of it', function () {
        var max = (util.inspect.defaultOptions && util.inspect.defaultOptions.maxStringLength) || 10000;
        var v = new Array(Math.ceil((max + 50) / 10) + 1).join('AbCdEfGhIj');
        var st = stateFor(v);
        assert.equal(st.secretCount, 1, 'the head is not counted as a value');
        assert.equal(redact.apply(st, 'dsn: ' + SQ + v.slice(0, max) + SQ + '... ' + (v.length - max) + ' more characters'), 'dsn: ' + SQ + M + SQ + '... ' + (v.length - max) + ' more characters');
        assert.equal(redact.apply(st, 'whole: ' + v + '.'), 'whole: ' + M + '.', 'the whole value still wins over its head');
    });
});


// ─── 03  apply ──────────────────────────────────────────────────────────────
describe('03 - apply(): the form each renderer gives a value, built with that renderer', function () {

    var SECRETS = [
        ['a backslash', 'pa' + BS + 'ss-with-backslash-12'],
        ['a backspace and a form feed', 'pa' + ch(8) + 'ss' + ch(12) + '-control-3456'],
        ['U+0001 and U+009F', 'pa' + ch(1) + 'ss' + ch(0x9f) + '-control-7890'],
        ['a lone surrogate', 'pa' + ch(0xd800) + 'ss-surrogate-1234'],
        ['a backslash before a quote', 'pa' + BS + DQ + 'ss' + BS + SQ + '-quoted-5678'],
        ['a backslash before a line feed', 'pa' + BS + LF + 'ss-two-lines-9012']
    ];
    function gone(out, secret, label) {
        assert.ok(out.indexOf(M) > -1, label + ' holds the mask: ' + JSON.stringify(out));
        assert.equal(out.indexOf(secret.slice(-12)), -1, label + ' printed the tail of the secret: ' + JSON.stringify(out));
    }
    function errWith(v) { var e = new Error('connect failed'); e.dsn = v; return e; }

    SECRETS.forEach(function (p) {
        it(p[0] + ': JSON.stringify, util.inspect, one on top of the other, and twice', function () {
            var s = p[1], st = stateFor(s);
            var json = JSON.stringify({ p: s }, null, TAB), masked = redact.apply(st, json);
            gone(masked, s, 'JSON.stringify');
            assert.deepEqual(JSON.parse(masked), { p: M }, 'the masked text is still the same JSON document');
            gone(redact.apply(st, util.inspect(errWith(s))), s, 'util.inspect');
            gone(redact.apply(st, JSON.stringify({ err: util.inspect(errWith(s)) })), s, 'JSON.stringify of util.inspect');
            gone(redact.apply(st, JSON.stringify({ payload: JSON.stringify({ p: s }) })), s, 'JSON.stringify twice');
            gone(redact.apply(st, JSON.stringify({ err: util.inspect(errWith(JSON.stringify({ p: s }))) })), s, 'three layers');
        });
    });

    it('the object writer\'s own reading is kept: a backslash before an escaped line feed', function () {
        var s = 'pa' + BS + LF + 'ss-two-lines-9012';
        // as parse() writes it: the line feed escaped, the backslash left alone
        gone(redact.apply(stateFor(s), '{"p": "' + s.split(LF).join(BS + 'n') + '"} '), s, 'the object writer');
    });

    it('a carriage return the levelled string path wrote as a line feed', function () {
        var s = 'line-one-of-the-key' + CR + LF + 'line-two-of-the-key';
        assert.equal(redact.apply(stateFor(s), 'k=' + s.split(CR).join(LF) + ' END'), 'k=' + M + ' END');
    });

    it('a long multi-line value an Error holds (split after each line feed), and one in a nested Error\'s message (indented)', function () {
        var s = lines('Zz', 6, LF), st = stateFor(s);
        gone(redact.apply(st, util.inspect(errWith(s))), s, 'the split value');
        gone(redact.apply(st, util.inspect(new Error('outer failed', { cause: new Error('inner v=' + s + ' END') }))), s, 'the indented message');
        // the two layouts as Node writes them, spelled out so the arm does not depend on the runtime's own
        gone(redact.apply(st, 'dsn: ' + s.split(LF).map(function (l, k, a) { return SQ + l + (k < a.length - 1 ? BS + 'n' : '') + SQ; }).join(' +' + LF + '    ')), s, 'a spelled-out split');
        gone(redact.apply(st, 'Error: inner v=' + s.split(LF).join(LF + '      ') + ' END'), s, 'a spelled-out indentation');
    });

    it('CONTROL: a message that holds escapes and no secret is left exactly as written', function () {
        var st = stateFor('pa' + BS + 'ss-with-backslash-12');
        ['C:' + BS + 'Users' + BS + 'me' + BS + 'new' + BS + 'table', JSON.stringify({ a: 'x' + BS + 'y' + LF + DQ + 'z' }), util.inspect(errWith('q' + ch(1) + BS + 'r')),
         '{"note": "say ' + BS + DQ + 'hi' + BS + DQ + '"} '].forEach(function (line) {
            assert.equal(redact.apply(st, line), line);
        });
    });
});


// ─── 04  the real logger ────────────────────────────────────────────────────
describe('04 - the real logger: every value, in every position (one process)', function () {

    /**
     * The cells that are NOT masked, by rule: `util.inspect` cuts a string
     * longer than its `maxStringLength`; the head of a secret that IS that
     * string is masked, the head of one that sits further inside a longer
     * string (here: inside a JSON or inspect string the caller built, which an
     * Error then holds) is not. `p`: the cut hid the last token; `P`: every
     * token is before the cut.
     */
    var STILL_PRINTED = {
        'long: over 10,000 characters, one line':  { EJ: 'p', EI: 'p', NRJ: 'p', NRI: 'p' },
        'long: over 10,000 characters, 160 lines': { EJ: 'P', EI: 'P', NRJ: 'P', NRI: 'P' }
    };

    var table = JSON.parse(cp.execFileSync(process.execPath, [__filename, '--b838-sweep', MAIN_SRC], { encoding: 'utf8', maxBuffer: 1 << 24 }));
    var rows = {};
    table.rows.forEach(function (r) { rows[r[0]] = r[1].split(' '); });

    /** Every cell of `labels` that differs from what is expected (`A|B`: either), as `row / arm: got (expected)`. */
    function unexpected(labels, expectedFor) {
        var bad = [];
        labels.forEach(function (label) {
            rows[label].forEach(function (got, k) {
                var want = expectedFor(label, table.arms[k]);
                if (want.split('|').indexOf(got) < 0) { bad.push(label + ' / ' + table.arms[k] + ': ' + got + ' (expected ' + want + ')'); }
            });
        });
        return bad;
    }
    var controls = table.rows.map(function (r) { return r[0]; }).filter(function (l) { return l.indexOf('CONTROL: no redaction') === 0; });
    var values   = table.rows.map(function (r) { return r[0]; }).filter(function (l) { return l.indexOf('CONTROL: no redaction') !== 0; });

    it('the table has the size it was built with: 54 value shapes, 191 rows, no duplicate label', function () {
        assert.equal(table.arms.length, 54);
        assert.equal(table.rows.length, 191);
        assert.equal(Object.keys(rows).length, 191);
    });

    it('CONTROL: with no redaction every value shape prints the value, the long values included (every arm can fail)', function () {
        assert.equal(controls.length, 13);
        // `p`: util.inspect cut the value over 10,000 characters, so its last token is not printed
        assert.deepEqual(unexpected(controls, function (label) {
            return label === 'CONTROL: no redaction, long: over 10,000 characters, one line' ? 'P|p' : 'P';
        }), []);
    });

    it('every value is masked in every position, except the cells STILL_PRINTED pins', function () {
        assert.equal(values.length, 178);
        assert.deepEqual(unexpected(values, function (label, arm) {
            return (STILL_PRINTED[label] && STILL_PRINTED[label][arm]) || 'M';
        }), []);
    });

    it('STILL_PRINTED names rows and arms of the table', function () {
        Object.keys(STILL_PRINTED).forEach(function (label) {
            assert.ok(rows[label], label);
            Object.keys(STILL_PRINTED[label]).forEach(function (arm) { assert.ok(table.arms.indexOf(arm) > -1, arm); });
        });
    });
});
