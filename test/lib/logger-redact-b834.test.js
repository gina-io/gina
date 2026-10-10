'use strict';
/**
 * A secret that holds a quote is masked inside an object and on the raw path (#B834).
 *
 * The log redaction (#B433) masks every resolved secret value. The object
 * writers escape a string value's quotes BEFORE the message reaches the
 * redaction: the levelled writer writes a double quote as backslash + double
 * quote and a single quote as backslash + single quote, and the raw
 * `console.log` path renders an object with `JSON.stringify`, which writes a
 * double quote as backslash + double quote. A secret value holding a quote then
 * matched neither reading of the message (#B830's as-written and decoded
 * readings), and it was printed in full. `redact.decodeView()` now reads the
 * two quote escapes as well, so the decoded reading finds the secret, and the
 * span is masked in the message as written.
 *
 *   01  the decoded reading reads the two quote escapes (the grammar this widens)
 *   02  apply() masks a quoted secret in the form each writer gives it
 *   03  the real logger: what reaches stdout, levelled and raw (one process per secret)
 *
 * Not covered here: a secret holding a backslash, a control character, a lone
 * surrogate or a line break, and the renderers other than the two object
 * writers (`JSON.stringify` for those characters, `util.inspect`, the levelled
 * string path). `logger-redact-renderers-b838.test.js` covers them (#B838).
 *
 * The framework directory can be overridden (`GINA_B834_FW`) to run every
 * section against another tree: the red-first run against the pre-fix code.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var cp     = require('child_process');

var FW         = process.env.GINA_B834_FW || path.resolve(require('../fw'));
var REDACT_SRC = path.join(FW, 'lib/logger/src/redact.js');
var MAIN_SRC   = path.join(FW, 'lib/logger/src/main.js');

var redact = require(REDACT_SRC);
var M      = redact.MARKER;

/** Characters built from their code, never typed. */
function ch(code) { return String.fromCharCode(code); }
var BS = ch(92), DQ = ch(34), SQ = ch(39), LF = ch(10), TAB = ch(9);

var SECRET_DQ    = 'pa' + DQ + 'ss-with-quote-123456';
var SECRET_SQ    = 'it' + SQ + 's-a-secret-value-9876';
var SECRET_PLAIN = 'plain-secret-value-5678';

/** The default rule set plus one secret, compiled the way `setRedaction()` compiles it. */
function stateFor(secret) { return redact.compileState([redact.compileBlock()], [secret]); }
/** The form the levelled writer gives a string value inside an object (`parse()` in main.js). */
function levelledForm(v) { return '{"p": "' + v.split(SQ).join(BS + SQ).split(DQ).join(BS + DQ) + '"}'; }
/** The form the raw `console.log` path gives an object (`JSON.stringify` with a tab, main.js). */
function rawForm(v) { return JSON.stringify({ p: v }, null, TAB); }
/** The raw form with the secret replaced by the marker. */
var RAW_MASKED = '{' + LF + TAB + '"p": "' + M + '"' + LF + '}';


// ─── 01  the decoded reading ────────────────────────────────────────────────
describe('01 - the decoded reading reads the two quote escapes', function () {

    it('a backslash + double quote is read as the double quote, with its offset map', function () {
        assert.deepEqual(redact.decodeView('a' + BS + DQ + 'b'), { text: 'a' + DQ + 'b', map: [0, 1, 3, 4] });
    });

    it('a backslash + single quote is read as the single quote', function () {
        assert.deepEqual(redact.decodeView('it' + BS + SQ + 's'), { text: 'it' + SQ + 's', map: [0, 1, 2, 4, 5] });
    });

    it('a quote escape next to a control-character escape: both are read', function () {
        assert.deepEqual(redact.decodeView('a' + BS + 'n' + BS + DQ), { text: 'a' + LF + DQ, map: [0, 1, 3, 5] });
    });

    it('CONTROL: a backslash before another printable character, and a quote with no backslash, are still not escapes', function () {
        assert.equal(redact.decodeView('C:' + BS + 'Users' + BS + 'me'), null);
        assert.equal(redact.decodeView('x' + BS + 'u0041y'), null);
        assert.equal(redact.decodeView('say ' + DQ + 'hi' + DQ), null);
    });
});


// ─── 02  apply() on each writer's form ──────────────────────────────────────
describe('02 - apply() masks a quoted secret in the form each writer gives it', function () {

    it('levelled writer, double quote: the secret is masked, its backslash included', function () {
        assert.equal(redact.apply(stateFor(SECRET_DQ), levelledForm(SECRET_DQ)), '{"p": "' + M + '"}');
    });

    it('levelled writer, single quote', function () {
        assert.equal(redact.apply(stateFor(SECRET_SQ), levelledForm(SECRET_SQ)), '{"p": "' + M + '"}');
    });

    it('raw path (JSON.stringify), double quote', function () {
        assert.equal(redact.apply(stateFor(SECRET_DQ), rawForm(SECRET_DQ)), RAW_MASKED);
    });

    it('CONTROL: forms with no escape were masked before and still are (a single quote on the raw path, a plain string)', function () {
        assert.equal(redact.apply(stateFor(SECRET_SQ), rawForm(SECRET_SQ)), RAW_MASKED);
        assert.equal(redact.apply(stateFor(SECRET_DQ), 'v=' + SECRET_DQ), 'v=' + M);
    });

    it('CONTROL: an escaped quote in text that holds no secret is left exactly as written', function () {
        var line = '{"note": "say ' + BS + DQ + 'hi' + BS + DQ + '"}';
        assert.equal(redact.apply(stateFor(SECRET_DQ), line), line);
    });
});


// ─── 03  the real logger ────────────────────────────────────────────────────
describe('03 - the real logger: what reaches stdout, levelled and raw', function () {

    /**
     * Run `body` in a fresh process with the real logger, the JSON log format and one
     * secret; returns each message written to stdout, keyed by the tag it starts with. The
     * raw `console.log` path writes stdout itself (it bypasses the flows), so stdout is
     * read for both paths. One process per secret: a second secret registered in the same
     * process can mask the first one's escaped form and hide a leak
     * (`logger-redact-readings-b830.test.js` section 09).
     */
    function drive(secret, body) {
        var script = [
            "process.env.GINA_LOG_STDOUT='true';process.env.GINA_LOG_FORMAT='json';",
            "var out=[];var w=process.stdout.write;process.stdout.write=function(s){out.push(String(s));return true;};",
            "var logger=require(" + JSON.stringify(MAIN_SRC) + ");",
            "var SECRET=" + JSON.stringify(secret) + ";",
            "logger.setRedaction({},{group:'b834',secrets:[{path:'k',value:SECRET}]});",
            body,
            "process.stdout.write=w;var msgs={};",
            "out.join('').split(String.fromCharCode(10)).forEach(function(l){var o;try{o=JSON.parse(l);}catch(e){return;}",
            "if(typeof o.message==='string'){msgs[o.message.slice(0,2)]=o.message;}});",
            "process.stdout.write(JSON.stringify(msgs));"
        ].join('');
        return JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
    }

    /** Does the secret's content survive in `msg`, as written or with the writers' quote escapes undone? */
    function survives(msg, secret) {
        var undone = msg.split(BS + DQ).join(DQ).split(BS + SQ).join(SQ);
        return msg.indexOf(secret) > -1 || undone.indexOf(secret) > -1;
    }

    it('a secret holding a double quote: inside an object, and through console.log (an object and an array)', function () {
        var f = drive(SECRET_DQ, "logger.info('L1',{p:SECRET});logger.log('R1',{p:SECRET});logger.log('R2',[SECRET]);");
        ['L1', 'R1', 'R2'].forEach(function (tag) {
            assert.ok(f[tag], tag + ' reached stdout');
            assert.equal(survives(f[tag], SECRET_DQ), false, tag + ' printed the secret: ' + f[tag]);
            assert.ok(f[tag].indexOf(M) > -1, tag + ' holds the mask: ' + f[tag]);
        });
    });

    it('a secret holding a single quote, inside an object', function () {
        var f = drive(SECRET_SQ, "logger.info('L2',{p:SECRET});");
        assert.ok(f.L2, 'L2 reached stdout');
        assert.equal(survives(f.L2, SECRET_SQ), false, 'L2 printed the secret: ' + f.L2);
        assert.ok(f.L2.indexOf(M) > -1, 'L2 holds the mask: ' + f.L2);
    });

    it('CONTROL: a secret with no quote is masked on both paths, and a value that is not a secret is printed', function () {
        var f = drive(SECRET_PLAIN, "logger.info('P1',{p:SECRET});logger.log('P2',{p:SECRET});logger.info('P3',{p:'not-a-secret-value'});");
        ['P1', 'P2', 'P3'].forEach(function (tag) { assert.ok(f[tag], tag + ' reached stdout'); });
        assert.equal(survives(f.P1, SECRET_PLAIN), false, f.P1);
        assert.equal(survives(f.P2, SECRET_PLAIN), false, f.P2);
        assert.ok(f.P3.indexOf('not-a-secret-value') > -1, 'a value that is not a secret is printed: ' + f.P3);
    });
});
