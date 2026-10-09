'use strict';
/**
 * #ERRREF — incident ref on error responses.
 *
 * Every `throwError` JSON error body carries a top-level `ref`: a short,
 * voice-relayable correlation code (6 uppercase hex from crypto.randomBytes(3),
 * or a relay-safe caller-supplied value), present in ALL scopes — it is a
 * random correlation key carrying no server detail, unlike `stack`, which the
 * egress gate keeps stripping outside local scope. ONE error-level log line
 * per thrown error pairs the ref with the FULL error (message + stack +
 * cause) AND the request correlation id (request._ginaReqId, #M12b/#COMPLY2),
 * emitted BEFORE the wire copy is sanitized — so support resolves a
 * user-relayed ref to the exact failure in any scope, production included.
 * The HTML surfaces (custom error page data + the inline fallback page) carry
 * the same ref. Consumers render their own prose around the ref client-side.
 *
 * This closes the two measured pre-#ERRREF logging gaps:
 *  - controller JSON/XHR branch: the strip ran with NO pre-strip log, so a
 *    production API error's stack was lost server-side entirely;
 *  - server XHR branch: the summary line logged method/code/url but NOT the
 *    message, so a message-only prod error reached the wire but not the log.
 *
 * Server-side only (neither builder is browser-bundled) — no dist pins.
 *
 * Suites:
 *  01 — server.js source pins (mint helper, pairing line before sanitize,
 *       ref on all four JSON literals + eData + both HTML fallbacks, the
 *       sanitize helper is log-free).
 *  02 — controller.js source pins (twin helper byte-identical, mint+pairing
 *       BEFORE the strip, ref on the reduced literal, HTML-branch mint,
 *       eData.ref, fallback-page ref, the post-strip wire-mirror log gone).
 *  03 — behavioral: the EXTRACTED mint (real bytes, control-gated) — format,
 *       variance, caller-supplied honoured, forging-shaped values re-minted.
 *  04 — behavioral: the EXTRACTED server pairing+sanitize composition and the
 *       EXTRACTED controller mint+pairing+strip+serialize composition — the
 *       proposal's arms: ref on the wire in local AND non-local scope; the
 *       log pairs the SAME ref with the full error; non-local wire has no
 *       stack but the log does; caller-supplied honoured; refs vary across
 *       throws; cause captured; message-only errors now logged.
 *  05 — only the two throwError builders mint: render delegates and the
 *       success paths carry no ref machinery (a normal response has no ref).
 *  06 — subtract: the frozen PRE-fix controller order (strip, then log the
 *       post-strip output) provably loses the stack from the log; the shipped
 *       order captures it — the discriminator.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var crypto = require('crypto');

var FW = require('../fw');

// installs JSON.clone (the sanitize object-strip path uses it)
require('../../utils/prototypes');

var SRV_SRC  = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var CTRL_SRC = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
var RJ_SRC   = fs.readFileSync(path.join(FW, 'core/controller/controller.render-json.js'), 'utf8');
var RS_SRC   = fs.readFileSync(path.join(FW, 'core/controller/controller.render-swig.js'), 'utf8');

// comment-stripped views for negative pins (the replace-code convention keeps
// prose mentions; a negative pin must only see ACTIVE code)
function stripComments(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

// ─── server.js throwError slice (declaration → end-of-file anchor) ────────────
var SRV_T_START = SRV_SRC.indexOf('var throwError = function(res, code, msg, next)');
var SRV_T_END   = SRV_SRC.indexOf('Server = inherits(Server, EventEmitter)');
var SRV_T       = SRV_SRC.substring(SRV_T_START, SRV_T_END);

// ─── controller.js throwError slice (declaration → the next method decl) ──────
var CTRL_T_START = CTRL_SRC.indexOf('this.throwError = function(res, code, msg)');
var CTRL_T_END   = CTRL_SRC.indexOf('var refToObj = function (arr)');
var CTRL_T       = CTRL_SRC.substring(CTRL_T_START, CTRL_T_END);

// ─── the two mint helper bodies (extraction is control-gated in §01/§02) ──────
var MINT_RE = /var _mintErrorRef = function\(supplied\) \{[\s\S]*?\n\};/;
var SRV_MINT  = SRV_SRC.match(MINT_RE);
var CTRL_MINT = CTRL_SRC.match(MINT_RE);

// #B830 — the extracted throwError blocks now call escapeLogControlChars +
// escapeLogDetailKeepFrames (the keep-frames log-escape). Provide both in the eval
// scope below, exactly as the mint helper is. The two helpers are adjacent in each
// source; slice from the first to the declaration that follows the pair. No assertion
// depends on them — the eval runs the REAL escape code, so a genuine regression fails.
var SRV_ESC  = SRV_SRC.slice(SRV_SRC.indexOf('function escapeLogControlChars(value) {'), SRV_SRC.indexOf('/**\n * #B662'));
var CTRL_ESC = CTRL_SRC.slice(CTRL_SRC.indexOf('function escapeLogControlChars(value) {'), CTRL_SRC.indexOf("const { Resolver } = require('node:dns').promises;"));

// ─── 01 — server.js source pins ───────────────────────────────────────────────
describe('#ERRREF §01 — server.js: mint + pairing line + ref on every emit', function () {

    it('slice + extraction anchors resolve (instrument control)', function () {
        assert.ok(SRV_T_START > -1 && SRV_T_END > SRV_T_START, 'throwError slice anchors');
        assert.ok(SRV_MINT, '_mintErrorRef declaration present in server.js');
        assert.equal(SRV_SRC.match(/var _mintErrorRef = function\(supplied\)/g).length, 1,
            'exactly one declaration (module scope)');
    });

    it('the mint is randomBytes(3) → 6 uppercase hex, with the relay-safe supplied gate', function () {
        assert.ok(SRV_MINT[0].indexOf("crypto.randomBytes(3).toString('hex').toUpperCase()") > -1);
        assert.ok(SRV_MINT[0].indexOf('/^[\\w.\\-]{1,32}$/') > -1,
            'caller-supplied values are charset+length gated (log-forging neutralised)');
    });

    it('the pairing line exists inside throwError and carries ref + request correlation id', function () {
        assert.ok(SRV_T.indexOf("[ ref '+ ref +' ][ req '+ ( _req._ginaReqId || '-' ) +' ]") > -1);
    });

    it('ORDER: mint + pairing line run BEFORE the wire sanitize (the log sees the full text)', function () {
        var mintIdx = SRV_T.indexOf('var ref = _mintErrorRef(');
        var pairIdx = SRV_T.indexOf("[ ref '+ ref +' ]");
        var saniIdx = SRV_T.indexOf('msg = sanitizeWireError(msg, code);');
        assert.ok(mintIdx > -1 && pairIdx > -1 && saniIdx > -1);
        assert.ok(mintIdx < pairIdx, 'mint before the line that logs it');
        assert.ok(pairIdx < saniIdx, 'pairing line before the sanitize');
    });

    it('all four JSON wire literals carry the top-level ref field', function () {
        var count = (SRV_T.match(/ref\s*:\s*ref/g) || []).length;
        // 4 JSON literals + the eData object (the HTML fallbacks use string
        // concatenation, counted separately below)
        assert.equal(count, 5, 'expected ref on 4 JSON literals + eData, found ' + count);
    });

    it('both inline HTML fallback pages render the ref', function () {
        var count = (SRV_T.match(/\\n\\nref '\+ ref \+'/g) || []).length;
        assert.equal(count, 2, 'HTTP/2 + HTTP/1.1 inline fallback pages');
    });

    it('the custom-error eData carries the ref for consumer templates', function () {
        var eDataIdx = SRV_T.indexOf('isRenderingCustomError  : true');
        assert.ok(eDataIdx > -1);
        var eDataBlock = SRV_T.substring(eDataIdx, eDataIdx + 600);
        assert.match(eDataBlock, /ref\s+:\s+ref/);
    });

    it('sanitizeWireError is log-free (ACTIVE code — the pairing line owns the log)', function () {
        var hStart = SRV_T.indexOf('var sanitizeWireError = function(m, c)');
        var hEnd   = SRV_T.indexOf('msg = sanitizeWireError(msg, code);');
        assert.ok(hStart > -1 && hEnd > hStart, 'helper slice anchors');
        var helper = stripComments(SRV_T.substring(hStart, hEnd));
        assert.ok(helper.indexOf('console.error') < 0, 'no in-helper logging remains');
    });
});

// ─── 02 — controller.js source pins ───────────────────────────────────────────
describe('#ERRREF §02 — controller.js: twin mint + pairing BEFORE the strip', function () {

    it('slice + extraction anchors resolve (instrument control)', function () {
        assert.ok(CTRL_T_START > -1 && CTRL_T_END > CTRL_T_START, 'throwError slice anchors');
        assert.ok(CTRL_MINT, '_mintErrorRef declaration present in controller.js');
        assert.equal(CTRL_SRC.match(/var _mintErrorRef = function\(supplied\)/g).length, 1,
            'exactly one declaration (module scope)');
    });

    it('the two mint helper BODIES are byte-identical (the keep-in-sync lock)', function () {
        assert.equal(SRV_MINT[0], CTRL_MINT[0],
            'server.js and controller.js _mintErrorRef must not drift');
    });

    it('JSON branch: mint + pairing line sit BEFORE the egress strip (the prod stack-loss fix)', function () {
        var mintIdx  = CTRL_T.indexOf('errorObject.ref = _mintErrorRef(');
        var pairIdx  = CTRL_T.indexOf("[ ref '+ errorObject.ref +' ][ req");
        var stripIdx = CTRL_T.indexOf('delete errorObject.stack;');
        assert.ok(mintIdx > -1 && pairIdx > -1 && stripIdx > -1);
        assert.ok(mintIdx < pairIdx, 'mint before the pairing line');
        assert.ok(pairIdx < stripIdx, 'pairing line captures the PRE-strip detail');
    });

    it('the reduced whitelist literal carries the ref', function () {
        assert.match(CTRL_T, /stack\s+:\s+errorObject\.stack \|\| null,\s*\n\s*ref\s+:\s+errorObject\.ref/);
    });

    it('the post-strip wire-mirror log is gone (ACTIVE code)', function () {
        var active = stripComments(CTRL_T);
        assert.ok(!/console\.error\([^\n]*errOutput\)/.test(active),
            'no console.error may serialize the post-strip errOutput — the pairing line supersedes it');
    });

    it('HTML branch: a branch-level mint feeds the detail log line, eData and the fallback page', function () {
        var htmlMint = CTRL_T.indexOf('var _errRef = _mintErrorRef(');
        assert.ok(htmlMint > -1, 'HTML-branch mint exists');
        assert.ok(CTRL_T.indexOf("[ ref '+ _errRef +' ][ req") > htmlMint, 'detail log line carries it');
        assert.ok(CTRL_T.indexOf('eData.ref = _errRef;') > htmlMint, 'custom error page data carries it');
        assert.ok(CTRL_T.indexOf("ref\">ref '+ _errRef +'") > htmlMint, 'inline fallback page renders it');
    });

    it('JSDoc documents the ref field (with the pinned scope-gate phrases intact)', function () {
        var jsdocStart = CTRL_SRC.indexOf('Throw error — terminates the request');
        var fnDecl     = CTRL_SRC.indexOf('this.throwError = function(res, code, msg)');
        assert.ok(jsdocStart > -1 && fnDecl > jsdocStart);
        var jsdocBlock = CTRL_SRC.slice(jsdocStart, fnDecl);
        assert.ok(jsdocBlock.indexOf('#ERRREF') > -1, 'ref behaviour is documented');
        assert.ok(jsdocBlock.indexOf('NODE_SCOPE_IS_LOCAL') > -1, 'scope-gate doc phrase kept');
    });
});

// ─── 03 — behavioral: the EXTRACTED mint (real bytes) ─────────────────────────
describe('#ERRREF §03 — the extracted mint behaves (format, variance, supplied)', function () {

    /* jshint evil: true */
    var mint = new Function('crypto',
        SRV_MINT[0] + '\nreturn _mintErrorRef;')(crypto);

    it('a fresh mint is exactly 6 uppercase hex chars', function () {
        for (var i = 0; i < 20; i++) {
            assert.match(mint(), /^[A-F0-9]{6}$/);
        }
    });

    it('refs vary across mints (correlation requires distinctness)', function () {
        var seen = {};
        for (var i = 0; i < 10; i++) { seen[mint()] = true; }
        assert.ok(Object.keys(seen).length > 1, 'ten mints must not all collide');
    });

    it('a relay-safe caller-supplied ref is honoured verbatim', function () {
        assert.equal(mint('ABC123'), 'ABC123');
        assert.equal(mint('my-ref_1.2'), 'my-ref_1.2');
    });

    it('an unsafe supplied value gets a fresh mint (log-forging neutralised)', function () {
        assert.match(mint('evil\n[ BUNDLE ] forged line'), /^[A-F0-9]{6}$/, 'newline injection');
        assert.match(mint('has spaces'), /^[A-F0-9]{6}$/, 'space');
        assert.match(mint('x'.repeat(33)), /^[A-F0-9]{6}$/, 'over the length cap');
        assert.match(mint(''), /^[A-F0-9]{6}$/, 'empty string');
        assert.match(mint(42), /^[A-F0-9]{6}$/, 'non-string');
        assert.match(mint(), /^[A-F0-9]{6}$/, 'absent');
    });
});

// ─── 04 — behavioral: the extracted pairing compositions ──────────────────────
describe('#ERRREF §04 — the wire carries the ref; the log pairs it with the full error', function () {

    // SERVER side: extract [mint … pairing line … sanitize def+call] and run
    // those exact bytes.
    var SB_START = SRV_T.indexOf('var ref = _mintErrorRef(');
    var SB_END_TOKEN = 'msg = sanitizeWireError(msg, code);';
    var SB_END   = SRV_T.indexOf(SB_END_TOKEN) + SB_END_TOKEN.length;
    var SB_SRC   = SRV_T.substring(SB_START, SB_END);

    it('server block extraction fires (instrument control)', function () {
        assert.ok(SB_START > -1 && SB_END > SB_START);
        assert.ok(SB_SRC.indexOf('_mintErrorRef(') > -1);
        assert.ok(SB_SRC.indexOf('var sanitizeWireError') > -1);
        assert.ok(SB_SRC.indexOf(SB_END_TOKEN) > -1);
    });

    /* jshint evil: true */
    function runServerBlock(isLocal, msg, code, calls) {
        var mintFn = new Function('crypto', SRV_MINT[0] + '\nreturn _mintErrorRef;')(crypto);
        var self   = { isLocalScope: function () { return isLocal; }, appName: 'fixtureapp' };
        var local  = { request: { method: 'GET', url: '/fixture', _ginaReqId: 'REQ-FIXTURE-1' } };
        var cons   = { error: function () { calls.push(Array.prototype.slice.call(arguments).join(' ')); } };
        var fn = new Function('_mintErrorRef', 'msg', 'code', 'self', 'local', 'console', 'JSON',
            'var _req = local.request; // #B806 — models the resolved request (fallback branch) for the extracted pairing line\n' + SRV_ESC + SB_SRC + '\nreturn { ref: ref, msg: msg };');
        return fn(mintFn, msg, code, self, local, cons, JSON);
    }

    it('NON-local + stack msg: wire is message-line-only, ONE log line pairs the SAME ref with the full stack + requestId', function () {
        var calls = [];
        var input = new Error('errref pair').stack;
        var out = runServerBlock(false, input, 500, calls);
        assert.match(out.ref, /^[A-F0-9]{6}$/);
        assert.equal(out.msg, 'Error: errref pair', 'wire value truncated by the gate');
        assert.equal(calls.length, 1, 'exactly ONE log line per thrown error');
        assert.ok(calls[0].indexOf(' at ') > -1, 'the log carries the frames the wire loses');
        assert.ok(calls[0].indexOf('[ ref ' + out.ref + ' ]') > -1, 'the log names the SAME ref the wire ships');
        assert.ok(calls[0].indexOf('[ req REQ-FIXTURE-1 ]') > -1, 'the log pairs the request correlation id');
        assert.ok(calls[0].indexOf('[ 500 ]') > -1, 'the log names the status code');
    });

    it('LOCAL scope: the wire keeps the stack AND the pairing line still fires (every scope)', function () {
        var calls = [];
        var input = new Error('errref local').stack;
        var out = runServerBlock(true, input, 500, calls);
        assert.equal(out.msg, input, 'local wire byte-identical (dev toolbar contract)');
        assert.match(out.ref, /^[A-F0-9]{6}$/, 'ref minted in local scope too');
        assert.equal(calls.length, 1, 'the pairing line is scope-independent');
        assert.ok(calls[0].indexOf(' at ') > -1);
    });

    it('message-only error: the log now carries the message (the pre-#ERRREF summary line did not)', function () {
        var calls = [];
        var out = runServerBlock(false, 'Page not found: /nope', 404, calls);
        assert.equal(out.msg, 'Page not found: /nope');
        assert.equal(calls.length, 1);
        assert.ok(calls[0].indexOf('Page not found: /nope') > -1, 'the full message reaches the log');
        assert.ok(calls[0].indexOf('[ ref ' + out.ref + ' ]') > -1);
    });

    it('cause is captured in the log (never on the wire)', function () {
        var calls = [];
        var inner = new Error('root cause');
        var outer = { status: 500, error: 'wrapper', message: 'wrapper', stack: 'Error: wrapper\n    at w (/x.js:1:1)', cause: inner };
        var out = runServerBlock(false, outer, 500, calls);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].indexOf('caused by: ') > -1, 'cause chain logged');
        assert.ok(calls[0].indexOf('root cause') > -1);
        assert.equal(typeof out.msg.cause, 'object', 'sanitize strips only .stack — cause untouched on the object');
        assert.equal(typeof out.msg.stack, 'undefined', 'stack stripped from the wire object');
    });

    it('caller-supplied msg.ref is honoured; the 1-arg errorObject shape ref too', function () {
        var calls = [];
        var out = runServerBlock(false, { status: 422, error: 'invalid', ref: 'UPSTREAM-7' }, 422, calls);
        assert.equal(out.ref, 'UPSTREAM-7');
        assert.ok(calls[0].indexOf('[ ref UPSTREAM-7 ]') > -1);
        // 1-arg errorObject shape: msg is undefined, the object rides `code`
        var calls2 = [];
        var out2 = runServerBlock(false, undefined, { status: 500, error: 'boom', ref: 'OBJ-REF-1' }, calls2);
        assert.equal(out2.ref, 'OBJ-REF-1');
        assert.ok(calls2[0].indexOf('[ 500 ]') > -1, 'display code resolved off the 1-arg object');
    });

    it('refs vary across two throws of the same error', function () {
        var c1 = [], c2 = [];
        var r1 = runServerBlock(false, 'same failure', 500, c1);
        var r2 = runServerBlock(false, 'same failure', 500, c2);
        assert.notEqual(r1.ref, r2.ref, 'per-error mint, not per-message');
    });

    // CONTROLLER side: extract [fallback build … mint+pairing … strip …
    // errOutput build] and run those exact bytes.
    var CB_START_TOKEN = 'if (!errorObject) {';
    var CB_START = CTRL_T.indexOf(CB_START_TOKEN);
    var CB_END_TOKEN = '// #ERRREF — the post-strip wire-mirror log';
    var CB_END   = CTRL_T.indexOf(CB_END_TOKEN);
    var CB_SRC   = CTRL_T.substring(CB_START, CB_END);

    it('controller block extraction fires (instrument control)', function () {
        assert.ok(CB_START > -1 && CB_END > CB_START, 'controller block anchors');
        assert.ok(CB_START < CTRL_T.indexOf('var _errRef'), 'sliced the ACTIVE JSON-branch build, not the HTML branch');
        assert.ok(CB_SRC.indexOf('errorObject.ref = _mintErrorRef(') > -1);
        assert.ok(CB_SRC.indexOf('delete errorObject.stack;') > -1);
        assert.ok(CB_SRC.indexOf('ref     : errorObject.ref') > -1);
    });

    /* jshint evil: true */
    function runControllerBlock(isLocal, errorObject, msg, code, calls) {
        var mintFn = new Function('crypto', CTRL_MINT[0] + '\nreturn _mintErrorRef;')(crypto);
        var cons   = { error: function () { calls.push(Array.prototype.slice.call(arguments).join(' ')); } };
        // #CE1 stand-ins: the extracted window now carries the opt-in
        // transient error-field swap; provide its bindings with the feature
        // OFF (the shipped default), so this suite keeps testing exactly the
        // #ERRREF composition on the real bytes. The feature-ON path is
        // covered end-to-end by test/core/transient-errors.test.js §03.
        var fn = new Function(
            '_mintErrorRef', '_isLocalScope', 'errorObject', 'msg', 'code',
            'standardErrorMessage', 'bundleConf', 'req', 'res', 'console', 'JSON',
            '_transient503Applied', '_teConf', 'statusCodes',
            CTRL_ESC + CB_SRC + '\nreturn { errorObject: errorObject, errOutput: errOutput };');
        return fn(
            mintFn, isLocal, errorObject, msg, code,
            'Internal Server Error', { bundle: 'fixturebundle' },
            { method: 'POST', url: '/api/fixture', _ginaReqId: 'REQ-FIXTURE-2' },
            { statusCode: code }, cons, JSON,
            false, null, { '503': 'Service Unavailable' });
    }

    it('NON-local: wire body has ref + NO stack; the log has the SAME ref + the full stack (the closed gap)', function () {
        var calls = [];
        var eObj = { status: 500, error: 'boom', message: 'boom', stack: 'Error: boom\n    at ctl (/srv/app.js:9:9)' };
        var out = runControllerBlock(false, eObj, null, 500, calls);
        var wire = JSON.parse(out.errOutput);
        assert.match(wire.ref, /^[A-F0-9]{6}$/, 'ref on the wire');
        assert.ok(!('stack' in wire), 'stack stripped from the wire');
        assert.equal(calls.length, 1, 'ONE pairing line');
        assert.ok(calls[0].indexOf('at ctl') > -1, 'the log keeps the stack prod used to lose');
        assert.ok(calls[0].indexOf('[ ref ' + wire.ref + ' ]') > -1, 'same ref, wire and log');
        assert.ok(calls[0].indexOf('[ req REQ-FIXTURE-2 ]') > -1);
    });

    it('LOCAL: wire keeps stack AND ref; pairing line fires too', function () {
        var calls = [];
        var eObj = { status: 500, error: 'boom', stack: 'Error: boom\n    at ctl (/srv/app.js:9:9)' };
        var out = runControllerBlock(true, eObj, null, 500, calls);
        var wire = JSON.parse(out.errOutput);
        assert.equal(wire.stack, eObj.stack, 'local keeps the stack on the wire');
        assert.match(wire.ref, /^[A-F0-9]{6}$/);
        assert.equal(calls.length, 1);
    });

    it('caller/producer-supplied ref on the error object is honoured (ApiError merge path)', function () {
        var calls = [];
        var eObj = { status: 412, error: 'fields', fields: { a: 'bad' }, ref: 'FORM-A1' };
        var out = runControllerBlock(false, eObj, null, 412, calls);
        var wire = JSON.parse(out.errOutput);
        assert.equal(wire.ref, 'FORM-A1');
        assert.ok(calls[0].indexOf('[ ref FORM-A1 ]') > -1);
    });

    it('the fallback errorObject build (string msg) mints too — every JSON error carries a ref', function () {
        var calls = [];
        var out = runControllerBlock(false, null, 'plain failure', 500, calls);
        var wire = JSON.parse(out.errOutput);
        assert.match(wire.ref, /^[A-F0-9]{6}$/);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].indexOf('plain failure') > -1, 'message-only errors reach the log');
    });

    it('whitelist path (custom toString): ref rides the reduced literal', function () {
        var calls = [];
        var eObj = { status: 500, error: 'boom', stack: 'Error: boom\n    at x', toString: function () { return 'custom'; } };
        var out = runControllerBlock(false, eObj, null, 500, calls);
        var wire = JSON.parse(out.errOutput);
        assert.equal(wire.error, 'custom');
        assert.equal(wire.stack, null);
        assert.match(wire.ref, /^[A-F0-9]{6}$/);
    });
});

// ─── 05 — only the two throwError builders mint ───────────────────────────────
describe('#ERRREF §05 — a normal (non-error) response carries no ref machinery', function () {

    it('the render delegates never reference the mint', function () {
        assert.ok(RJ_SRC.indexOf('_mintErrorRef') < 0, 'render-json is ref-free');
        assert.ok(RS_SRC.indexOf('_mintErrorRef') < 0, 'render-swig is ref-free');
    });

    it('every mint call site lives inside a throwError body (none elsewhere)', function () {
        // server.js: 1 call (throwError entry); controller.js: 2 calls (JSON
        // branch + HTML branch). The declarations don't match `_mintErrorRef(`
        // (they read `= function(supplied)`).
        var srvCalls  = (stripComments(SRV_SRC).match(/_mintErrorRef\(/g) || []).length;
        var ctrlCalls = (stripComments(CTRL_SRC).match(/_mintErrorRef\(/g) || []).length;
        assert.equal(srvCalls, 1, 'server.js: exactly the throwError entry mint');
        assert.equal(ctrlCalls, 2, 'controller.js: exactly the JSON-branch + HTML-branch mints');
        var srvInT  = (stripComments(SRV_T).match(/_mintErrorRef\(/g) || []).length;
        var ctrlInT = (stripComments(CTRL_T).match(/_mintErrorRef\(/g) || []).length;
        assert.equal(srvCalls, srvInT, 'all server mints are inside throwError');
        assert.equal(ctrlCalls, ctrlInT, 'all controller mints are inside throwError');
    });
});

// ─── 06 — subtract: the pre-fix order provably lost the stack from the log ────
describe('#ERRREF §06 — subtract: pre-fix strip-then-log loses the stack; shipped order keeps it', function () {

    function drive(orderIsPreFix) {
        var calls = [];
        var errorObject = { status: 500, error: 'boom', message: 'boom', stack: 'Error: boom\n    at lost (/srv/app.js:1:1)' };
        var isLocalScope = false;

        function logPreStrip() {   // shipped shape: pairing line BEFORE the strip
            calls.push('detail: ' + (errorObject.stack || errorObject.message || errorObject.error));
        }
        function strip() {
            if (!isLocalScope && errorObject && errorObject.stack) { delete errorObject.stack; }
        }
        function logPostStrip() {  // frozen PRE-fix shape: log the post-strip output
            calls.push('detail: ' + JSON.stringify(errorObject));
        }

        if (orderIsPreFix) { strip(); logPostStrip(); }
        else               { logPreStrip(); strip(); }
        return calls[0];
    }

    it('PRE-fix (frozen): the only log line carries NO stack — the prod loss', function () {
        var line = drive(true);
        assert.ok(line.indexOf('at lost') < 0, 'the stack never reached the log');
    });

    it('SHIPPED: the log line carries the stack the wire loses — the discriminator', function () {
        var line = drive(false);
        assert.ok(line.indexOf('at lost') > -1);
    });
});
