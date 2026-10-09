'use strict';
/**
 * Line breaks and control characters in a logged value (#B830).
 *
 * In the default (text) format the levelled writer turned the two WRITTEN
 * characters backslash + r/n/t into a real control character, and let a real
 * line feed held by a value pass straight through — so a logged client value
 * (an upload field/group/extension, a parsed body value, a validator warning)
 * could forge a physical log line (CWE-117), and escaping the value first with
 * `JSON.stringify` did not help, because the two characters it produces were
 * then rewritten.
 *
 * The fix, all BEHAVIORAL here (the real singleton is driven):
 *   A — `write()` no longer rewrites a written backslash + r/n/t; only a REAL
 *       CR / LF / TAB is handled, exactly as before, so a legitimate multi-line
 *       argument (an Error, an err.stack string) is unchanged.
 *   B — `parse()` writes a logged object's keys and string values with their
 *       control characters as visible escapes, so no member can break the line.
 *
 * Part B reaches every string the object holds: an array inside an array, an
 * array of key/value pairs and a Buffer inside an array are written through
 * the escaper too (arms 17-20), and the escaped set is C0, DEL, C1 and the two
 * Unicode line separators (arm 21). A value holding no control character
 * renders exactly as it did (arms 13, 22, 23).
 *
 * Part C (the framework log/error sites that embed a decoded client value) has
 * its own files: `test/core/log-line-break-sites-b830.test.js` (one arm per
 * site), `test/lib/log-escape-parity-b830.test.js` (the escaper copies) and
 * `test/lib/logger-redact-readings-b830.test.js` (the redaction, which reads
 * the escaped text).
 *
 * Red-first: on the pre-fix `lib/logger/src/main.js` the A and B arms fail
 * (two physical lines) while every control passes. GINA_LOG_STDOUT=true strips
 * the mq flow before init; GINA_LOG_FORMAT=text keeps the raw path plain.
 * node --test runs each file in its own process, so the singleton cannot leak.
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var cp     = require('child_process');

var FRAMEWORK = path.resolve(require('../fw'));
var MAIN_SRC  = path.join(FRAMEWORK, 'lib/logger/src/main.js');

var BS = String.fromCharCode(92);   // one backslash
var LF = String.fromCharCode(10);
var CR = String.fromCharCode(13);
var TAB = String.fromCharCode(9);
var BEL = String.fromCharCode(7);   // a C0 control with no short escape -> \u0007

var logger;
var frames = [];

before(function () {
    process.env.GINA_LOG_STDOUT = 'true';
    process.env.GINA_LOG_FORMAT = 'text';
    logger = require(MAIN_SRC);
    process.on('logger#default', function (p) { frames.push(JSON.parse(p)); });
});
after(function () {
    process.removeAllListeners('logger#default');
    delete process.env.GINA_LOG_STDOUT;
    delete process.env.GINA_LOG_FORMAT;
});

/** Content of the last levelled frame whose content carries `needle`. */
function levelled(needle) {
    var f = frames.filter(function (x) { return x.content.indexOf(needle) > -1; });
    return f.length ? f[f.length - 1].content : null;
}
/** Count of REAL line feeds in a string (a container writes content + '\n', so
 *  this is the number of EXTRA physical lines a value introduced). */
function realLFs(s) { return (String(s).match(/\n/g) || []).length; }

/** Capture process.stdout while `fn` runs. */
function rawOutput(fn) {
    var captured = [];
    var saved = process.stdout.write;
    process.stdout.write = function (s) { captured.push(String(s)); return true; };
    try { fn(); } finally { process.stdout.write = saved; }
    return captured.join('');
}

describe('#B830 — a logged value cannot forge a log line', function () {

    // ---- part A: the levelled writer and WRITTEN escapes ----
    it('01 control: a value with no break stays on one line', function () {
        logger.info('B830-01 user=alice');
        assert.equal(realLFs(levelled('B830-01')), 0);
    });

    it('02 A: the two characters backslash + n are NOT turned into a line feed', function () {
        logger.info('B830-02 user=' + 'alice' + BS + 'n' + 'TAIL');
        var c = levelled('B830-02');
        assert.equal(realLFs(c), 0);                 // red pre-fix: 1
        assert.ok(c.indexOf(BS + 'n') > -1);         // the written text is kept literally
    });

    it('03 A: backslash + r and backslash + t are not turned into control characters', function () {
        logger.info('B830-03 a' + BS + 'r' + 'b' + BS + 't' + 'c');
        var c = levelled('B830-03');
        assert.equal(realLFs(c), 0);
        assert.equal((c.match(new RegExp(TAB, 'g')) || []).length, 0);
    });

    it('04 A residual (documented): a REAL line feed in a plain string argument still breaks the line', function () {
        logger.info('B830-04 user=' + 'alice' + LF + 'forged');
        assert.equal(realLFs(levelled('B830-04')), 1);   // intended — same as Node; pass a value in an object instead
    });

    it('05 A: a REAL carriage return in a plain string argument is the same residual', function () {
        logger.info('B830-05 user=' + 'alice' + CR + 'forged');
        assert.equal(realLFs(levelled('B830-05')), 1);
    });

    // ---- part B: keys and string values of a logged object ----
    it('06 B: a string VALUE carrying a real line feed is escaped', function () {
        logger.info('B830-06 body=', { note: 'alice' + LF + 'forged' });
        assert.equal(realLFs(levelled('B830-06')), 0);   // red pre-fix: 1
    });

    it('07 B: an object KEY carrying a real line feed is escaped', function () {
        var o = {}; o['k' + LF + 'forged'] = 1;
        logger.info('B830-07 body=', o);
        assert.equal(realLFs(levelled('B830-07')), 0);   // red pre-fix: 1
    });

    it('08 B: an array element carrying a real line feed is escaped', function () {
        logger.info('B830-08 list=', ['ok', 'alice' + LF + 'forged']);
        assert.equal(realLFs(levelled('B830-08')), 0);
    });

    it('09 B: a nested object string carrying a real line feed is escaped', function () {
        logger.info('B830-09 body=', { user: { name: 'alice' + LF + 'forged' } });
        assert.equal(realLFs(levelled('B830-09')), 0);
    });

    it('10 B: a non-line-break control (BEL) in a string value renders as \\u0007', function () {
        logger.info('B830-10 body=', { name: 'a' + BEL + 'b' });
        var c = levelled('B830-10');
        assert.equal(realLFs(c), 0);
        assert.equal(c.indexOf(BEL), -1);               // the raw control byte is gone
        assert.ok(c.indexOf('\\u0007') > -1);           // shown as a visible escape
    });

    // ---- legitimate multi-line content must NOT be over-escaped ----
    it('11 an Error argument keeps its multi-line stack', function () {
        var e = new Error('B830-11 boom');
        e.stack = 'Error: B830-11 boom' + LF + '    at one (a.js:1:1)' + LF + '    at two (b.js:2:2)';
        logger.error(e);
        assert.ok(realLFs(levelled('B830-11')) >= 2);   // intended — the stack stays multi-line
    });

    it('12 an err.stack passed as a string stays multi-line', function () {
        logger.error('B830-12 failed: ' + 'Error: boom' + LF + '    at one (a.js:1:1)');
        assert.ok(realLFs(levelled('B830-12')) >= 1);
    });

    it('13 control: a plain object with ordinary values is unchanged', function () {
        logger.info('B830-13 body=', { id: 7, name: 'ok', on: true });
        var c = levelled('B830-13');
        assert.equal(realLFs(c), 0);
        assert.ok(c.indexOf('"id": 7') > -1 && c.indexOf('"name": "ok"') > -1 && c.indexOf('"on": true') > -1);
    });

    // ---- the raw console.log path is deliberately left as-is ----
    it('14 raw console.log: a written backslash + n is NOT a line feed (unchanged by the fix)', function () {
        var out = rawOutput(function () { logger.log('B830-14 user=' + 'alice' + BS + 'n' + 'TAIL'); });
        assert.equal(realLFs(out), 1);                  // the single trailing newline only
    });

    it('15 raw console.log: a REAL line feed is the documented raw residual', function () {
        var out = rawOutput(function () { logger.log('B830-15 user=' + 'alice' + LF + 'forged'); });
        assert.equal(realLFs(out), 2);                  // the embedded LF + the trailing newline
    });

    // ---- JSON format: one physical line per message (format resolved once at init) ----
    it('16 JSON format emits exactly one physical line for the A and B arms', function () {
        var script =
            "process.env.GINA_LOG_STDOUT='true';process.env.GINA_LOG_FORMAT='json';" +
            "var out=[];var w=process.stdout.write;process.stdout.write=function(s){out.push(String(s));return true;};" +
            "var l=require(" + JSON.stringify(MAIN_SRC) + ");" +
            "l.info('J-A user='+'x'+String.fromCharCode(92)+'n'+'t');" +      // written backslash-n
            "l.info('J-B body=',{note:'x'+String.fromCharCode(10)+'t'});" +   // object real LF
            "process.stdout.write=w;" +
            "var lines=out.join('').split(String.fromCharCode(10)).filter(Boolean);" +
            "process.stdout.write(String(lines.length));";
        var r = cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
        assert.equal(r, '2');   // two info() calls -> two JSON objects -> two physical lines, nothing forged
    });

    // ---- part B, every string an object holds: nested arrays (the parse() fallback branches) ----
    it('17 B: a string in an array inside an array is escaped', function () {
        logger.info('B830-17 list=', [['alice' + LF + 'forged']]);
        var c = levelled('B830-17');
        assert.equal(realLFs(c), 0);                     // red before the fallback branches went through the escaper: 1
        assert.equal(c, 'B830-17 list= [ alice' + BS + 'nforged ] ');
    });

    it('18 B: object -> array -> array', function () {
        logger.info('B830-18 body=', { x: [['alice' + LF + 'forged']] });
        assert.equal(levelled('B830-18'), 'B830-18 body= {"x": [ alice' + BS + 'nforged ] } ');
    });

    it('19 B: an array of key/value pairs (the shape of URLSearchParams entries)', function () {
        logger.info('B830-19 q=', [['k', 'x' + LF + 'forged']]);
        assert.equal(levelled('B830-19'), 'B830-19 q= [ k,x' + BS + 'nforged ] ');
    });

    it('20 B: a Buffer inside an array', function () {
        logger.info('B830-20 parts=', [Buffer.from('alice' + LF + 'forged')]);
        assert.equal(levelled('B830-20'), 'B830-20 parts= [ alice' + BS + 'nforged ] ');
    });

    it('21 B: the C1 controls and the two Unicode line separators are escaped like the C0 ones', function () {
        var NEL = String.fromCharCode(0x85), CSI = String.fromCharCode(0x9b), LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
        logger.info('B830-21 body=', { v: 'a' + NEL + 'b' + LS + 'c' + PS + 'd' + CSI + '[31m' });
        var c = levelled('B830-21');
        [NEL, CSI, LS, PS].forEach(function (raw) { assert.equal(c.indexOf(raw), -1); });   // red on the C0-only set
        assert.equal(c, 'B830-21 body= {"v": "a' + BS + 'u0085b' + BS + 'u2028c' + BS + 'u2029d' + BS + 'u009b[31m"} ');
    });

    it('22 control: values holding no control character render as they always did (numbers, booleans, null, undefined, bigint)', function () {
        logger.info('B830-22', [1, 'a', true, null, undefined, 2.5]);
        assert.equal(levelled('B830-22'), 'B830-22 [ 1, "a", true, null, undefined, 2.5 ] ');
        logger.info('B830-2b', { n: 1, b: false, z: null, u: undefined, big: 10n });
        assert.equal(levelled('B830-2b'), 'B830-2b {"n": 1, "b": false, "z": null, "u": undefined, "big": 10} ');
    });

    it('23 control: nested arrays and a Buffer with no control character render as they always did', function () {
        logger.info('B830-23', [[1, 2], ['a', 'b']]);
        assert.equal(levelled('B830-23'), 'B830-23 [ 1,2, a,b ] ');
        logger.info('B830-3b', { x: [['a', 'b'], [3]] });
        assert.equal(levelled('B830-3b'), 'B830-3b {"x": [ a,b, 3 ] } ');
        logger.info('B830-3c', [Buffer.from('ab')]);
        assert.equal(levelled('B830-3c'), 'B830-3c [ ab ] ');
    });
});
