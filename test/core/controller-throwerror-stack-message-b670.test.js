'use strict';
/**
 * #B670 — the CONTROLLER-side `throwError` (`this.throwError`,
 * core/controller/controller.js) shipped a STACK passed as the message to the
 * client outside the local scope. Its fail-closed gate strips the `stack`
 * FIELD only, so a stack passed as the message reached the JSON body and the
 * inline HTML fallback page with its file paths and frames:
 *   - `throwError(res, 500, err.stack)`            → JSON `message`, the page
 *   - `throwError(500, err.stack)`                 → JSON `message`, the page
 *   - `throwError({ status: 500, error: err.stack })` → JSON `error`, the page
 *   - `throwError(res, 500, { message: err.stack })`  → JSON `message`, the page
 * #B131 closed the same class on the server-side twin (core/server.js).
 *
 * Driven 2026-09-26 on an isolated production-scope boot (the child's own
 * NODE_SCOPE_IS_LOCAL read `false` on the wire): all four shapes leaked on
 * both branches, while an Error object and a one-line string were clean. The
 * same run showed two HTML-branch log gaps that made cutting the page unsafe
 * on its own: the ref line logged the throwError CALLSITE instead of the
 * error's own text, and the 3-arg object shape logged no ref line at all.
 * The fix closes both gaps, then cuts.
 *
 * §01 — source pins on live code (full-line comments dropped): where each cut
 *       sits relative to the log line it depends on, the frame detector shared
 *       with server.js, the cached scope read, and that the caller's `msg` is
 *       never written.
 * §02 — the real throwError driven through createTestInstance: the JSON and
 *       HTML branches, non-local and local scope, with the log captured.
 * §03 — subtract: on the same input, the non-local wire differs from the
 *       pre-fix wire value (the input itself) and is its first line.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW      = require('../fw');
var SRC_CTL = path.join(FW, 'core/controller/controller.js');
var SRC_SRV = path.join(FW, 'core/server.js');

var FRAME = /\n\s+at\s/;

/**
 * Drop full-line comments so a pin cannot be satisfied by prose.
 *
 * @inner
 * @param {string} src
 * @returns {string}
 */
function live(src) {
    return src.split('\n').filter(function (l) {
        var t = l.trim();
        return !( t.indexOf('//') === 0 || t.indexOf('/*') === 0 || t.indexOf('*') === 0 );
    }).join('\n');
}

function countOf(hay, needle) { return hay.split(needle).length - 1; }

var CTL_RAW = fs.readFileSync(SRC_CTL, 'utf8');
var T_START = CTL_RAW.indexOf('this.throwError = function(res, code, msg)');
var T_END   = CTL_RAW.indexOf('var refToObj = function (arr)');
var T       = live(CTL_RAW.substring(T_START, T_END));


// ─── 01 — source pins ─────────────────────────────────────────────────────────
describe('#B670 §01 — where the cuts sit in controller-side throwError', function () {

    it('slice anchors resolve (extraction control)', function () {
        assert.ok(T_START > -1 && T_END > T_START, 'throwError slice anchors');
        assert.ok(T.indexOf('delete errorObject.stack;') > -1, 'the existing stack gate is inside the slice');
    });

    it('JSON: the cut follows the stack gate and the pairing line, and precedes serialization', function () {
        var pairIdx  = T.indexOf("[ BUNDLE ][ '+ bundleConf.bundle +' ][ Controller ][ ref '");
        var gateIdx  = T.indexOf('delete errorObject.stack;');
        var cutIdx   = T.indexOf('_wireKeys');
        var serIdx   = T.indexOf('var errOutput = null, output = errorObject.toString()');
        assert.ok(pairIdx > -1 && gateIdx > -1 && cutIdx > -1 && serIdx > -1, 'anchors');
        assert.ok(pairIdx < cutIdx, 'the pairing line logs the text BEFORE it is cut');
        assert.ok(gateIdx < cutIdx && cutIdx < serIdx, 'cut after the stack gate, before JSON.stringify');
    });

    it('JSON: the pairing line is completed with any stack-bearing text before it is emitted', function () {
        var detIdx  = T.indexOf('var _errDetail = errorObject.stack');
        var addIdx  = T.indexOf('_detailKeys');
        var pairIdx = T.indexOf("[ BUNDLE ][ '+ bundleConf.bundle +' ][ Controller ][ ref '");
        assert.ok(detIdx > -1 && addIdx > -1 && pairIdx > -1);
        assert.ok(detIdx < addIdx && addIdx < pairIdx);
    });

    it('HTML: the ref line carries the error\'s own text, and fires when errorObject is null', function () {
        var logIdx = T.indexOf('var _logMsg = errorObject.stack');
        var addIdx = T.indexOf('_logKeys');
        assert.ok(logIdx > -1 && addIdx > logIdx, 'the errorObject ref line appends the stack-bearing text');
        assert.equal(countOf(T, "console.error('[ ref '+ _errRef +' ][ req '"), 2,
            'two HTML ref lines: the errorObject one and the (res, code, errorObj) one');
    });

    it('HTML: the page cut follows every HTML ref line and precedes both page builders', function () {
        var lastLog  = T.lastIndexOf("console.error('[ ref '+ _errRef +' ][ req '");
        var cutIdx   = T.indexOf('_pageKeys');
        var eDataIdx = T.indexOf('eData = {');
        var pageIdx  = T.indexOf("var msgString = '<h1 class=\"status\">Error ");
        assert.ok(lastLog > -1 && cutIdx > -1 && eDataIdx > -1 && pageIdx > -1, 'anchors');
        assert.ok(lastLog < cutIdx, 'logged in full before the page is cut');
        assert.ok(cutIdx < eDataIdx && cutIdx < pageIdx, 'custom page data and the fallback page inherit the cut');
    });

    it('both cuts read the cached _isLocalScope, never the env', function () {
        var jsonCut = T.substring(T.indexOf('_wireKeys') - 200, T.indexOf('_wireKeys'));
        var pageCut = T.substring(T.indexOf('_pageKeys') - 200, T.indexOf('_pageKeys'));
        assert.ok(jsonCut.indexOf('!_isLocalScope') > -1, 'JSON cut gated on the cached scope');
        assert.ok(pageCut.indexOf('!_isLocalScope') > -1, 'page cut gated on the cached scope');
        assert.equal(T.indexOf('process.env.NODE_SCOPE_IS_LOCAL'), -1, 'no per-request env read in throwError');
    });

    it('the frame detector is the one #B131 uses on the server-side twin', function () {
        var srv = live(fs.readFileSync(SRC_SRV, 'utf8'));
        assert.ok(srv.indexOf('/\\n\\s+at\\s/.test(m)') > -1, 'server.js sanitizeWireError detector');
        assert.equal(countOf(T, '/\\n\\s+at\\s/.test('), 5,
            'JSON cut, JSON pairing completion, HTML ref-line completion, HTML page cut (errorObject + msg)');
    });

    it('the caller\'s msg is never written — a copy replaces it', function () {
        ['msg.title =', 'msg.message =', 'msg.error ='].forEach(function (w) {
            assert.equal(countOf(T, w), 0, 'no assignment into the caller\'s object: ' + w);
        });
        assert.ok(T.indexOf('msg = _msgCopy;') > -1, 'the copy replaces the local binding');
    });
});


// ─── 02 — the real throwError, driven ─────────────────────────────────────────
var BOOTSTRAPPED = false;
function bootstrap() {
    if (BOOTSTRAPPED) return;
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));
    setPath('gina', { core: path.join(FW, 'core') });
    BOOTSTRAPPED = true;
}

/**
 * Load controller.js under a given scope (the scope is cached at module load)
 * and return a driver for its real throwError.
 *
 * The JSON branch is taken for an XHR; the HTML branch is the #B554 harness
 * shape (not an XHR, no views, DELETE, isUsingTemplate) — the inline fallback
 * page, since no `errorFiles` is configured.
 *
 * @inner
 * @param {boolean} isLocal
 * @returns {function(object, function): {body: string, logs: string[]}}
 */
function makeDriver(isLocal) {
    bootstrap();
    process.env.NODE_SCOPE_IS_LOCAL = isLocal ? 'true' : 'false';
    delete require.cache[require.resolve(SRC_CTL)];
    var SuperController = require(SRC_CTL);
    var logger = require(path.join(FW, 'lib')).logger;
    var STATUS_CODES = { '200': 'OK', '400': 'Bad Request', '404': 'Not Found', '500': 'Internal Server Error' };

    return function drive(opts, argsFn) {
        var body = null, logs = [];
        var res = {
            statusCode: 200, headersSent: false,
            setHeader: function () {}, getHeader: function () {},
            getHeaders: function () { return {}; },
            writeHead: function () {},
            end: function (chunk) { body = (chunk == null) ? '' : String(chunk); }
        };
        var req = {
            url: '/x', method: opts.xhr ? 'GET' : 'DELETE',
            routing: { rule: 'r@b', param: { control: 'action' } },
            params: {}, get: {}, _ginaReqId: 'REQ-B670',
            headers: { 'user-agent': 'node-test', 'accept-language': 'en' }
        };
        var options = {
            rule: 'r', control: 'action', encoding: 'utf8',
            isXMLRequest: !!opts.xhr, isUsingTemplate: true,
            conf: {
                bundle: 'b', encoding: 'utf8',
                server: { coreConfiguration: {
                    statusCodes: STATUS_CODES,
                    mime: { json: 'application/json', html: 'text/html' }
                } },
                content: { routing: {}, templates: { _common: {} } }
            }
        };
        var inst = SuperController.createTestInstance({ req: req, res: res, next: function () {}, options: options });
        var origError = logger.error;
        logger.error = function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            inst.throwError.apply(inst, argsFn(res));
        } finally {
            logger.error = origError;
        }
        assert.equal(typeof body, 'string', 'harness fault: throwError never reached res.end');
        return { body: body, logs: logs };
    };
}

function stackOf(token) { return new Error(token).stack; }
function firstLine(s) { return s.split('\n')[0]; }
function json(r) { return JSON.parse(r.body); }
function anyFrame(obj) {
    return Object.keys(obj).some(function (k) { return typeof obj[k] == 'string' && FRAME.test(obj[k]); });
}
function pageRef(body) { var m = body.match(/ref ([0-9A-F]{6})<\/pre>/); return m && m[1]; }

describe('#B670 §02 — NON-local scope: the wire carries the message line, the log the full text', function () {

    var drive = makeDriver(false);

    it('control — the harness is non-local and the logger stub captures (an Error: stack field stripped, stack logged)', function () {
        var r = drive({ xhr: true }, function (res) { return [res, 500, new Error('b670-cerr')]; });
        var w = json(r);
        assert.ok(!('stack' in w), 'non-local: the existing gate strips the stack field');
        assert.equal(w.message, 'b670-cerr');
        assert.equal(r.logs.length, 1, 'ONE pairing line');
        assert.ok(r.logs[0].indexOf('b670-cerr') > -1 && FRAME.test(r.logs[0]), 'the log keeps the stack');
    });

    [
        ['3-arg (res, 500, err.stack)',       function (s) { return function (res) { return [res, 500, s]; }; }, 'message'],
        ['2-arg (500, err.stack)',            function (s) { return function ()    { return [500, s]; }; },      'message'],
        ['1-arg { status, error: err.stack }', function (s) { return function ()    { return [{ status: 500, error: s }]; }; }, 'error'],
        ['3-arg (res, 500, { message: err.stack })', function (s) { return function (res) { return [res, 500, { error: 'short', message: s }]; }; }, 'message']
    ].forEach(function (c) {
        var label = c[0], mk = c[1], field = c[2];

        it('JSON ' + label + ': no frame on the wire, the ' + field + ' is its first line, the log has it all', function () {
            var s = stackOf('b670-json ' + label);
            var r = drive({ xhr: true }, mk(s));
            var w = json(r);
            assert.ok(!anyFrame(w), 'no stack-bearing field on the wire: ' + r.body.slice(0, 300));
            assert.equal(w[field], firstLine(s));
            assert.match(w.ref, /^[0-9A-F]{6}$/, 'the ref still rides the wire');
            assert.equal(r.logs.length, 1, 'ONE pairing line');
            assert.ok(r.logs[0].indexOf(s) > -1, 'the pairing line carries the full text');
            assert.ok(r.logs[0].indexOf('[ ref ' + w.ref + ' ]') > -1, 'same ref, wire and log');
        });

        it('HTML ' + label + ': no frame on the page, the log carries the error\'s own text under the page ref', function () {
            var s = stackOf('b670-html ' + label);
            var r = drive({ xhr: false }, mk(s));
            assert.ok(r.body.indexOf('<h1 class="status">Error 500.</h1>') > -1, 'harness fault: not the fallback page');
            assert.ok(!FRAME.test(r.body), 'no frame on the page: ' + r.body.slice(0, 400));
            assert.ok(r.body.indexOf(firstLine(s)) > -1, 'the message line is still shown');
            var ref = pageRef(r.body);
            assert.ok(ref, 'the page shows a ref');
            var line = r.logs.filter(function (l) { return l.indexOf('[ ref ' + ref + ' ]') > -1; });
            assert.equal(line.length, 1, 'one log line pairs the page ref');
            assert.ok(line[0].indexOf(s) > -1, 'that line carries the error\'s own full text');
        });
    });

    it('a hand-built object whose own stack differs from a stack-bearing message: both reach the log', function () {
        var a = stackOf('b670-detail-message'), b = stackOf('b670-detail-stack');
        var r = drive({ xhr: true }, function (res) { return [res, 500, { error: 'x', message: a, stack: b }]; });
        var w = json(r);
        assert.ok(!anyFrame(w) && !('stack' in w), 'nothing stack-bearing on the wire');
        assert.equal(w.message, firstLine(a));
        assert.ok(r.logs[0].indexOf(b) > -1, 'the object\'s stack is logged');
        assert.ok(r.logs[0].indexOf(a) > -1, 'and so is the stack it carried as its message');
    });

    it('the caller\'s object is not rewritten (JSON and HTML)', function () {
        var s = stackOf('b670-caller');
        var o1 = { error: 'short', message: s };
        drive({ xhr: true },  function (res) { return [res, 500, o1]; });
        var o2 = { error: 'short', message: s };
        drive({ xhr: false }, function (res) { return [res, 500, o2]; });
        var o3 = { status: 500, error: s };
        drive({ xhr: false }, function () { return [o3]; });
        assert.equal(o1.message, s);
        assert.equal(o2.message, s);
        assert.equal(o3.error, s);
    });

    it('controls: a one-line string and a multi-line text without frames pass through untouched', function () {
        var r1 = drive({ xhr: true }, function (res) { return [res, 404, 'b670 plain not found']; });
        assert.equal(json(r1).message, 'b670 plain not found');
        var multi = 'first line\nsecond line';
        var r2 = drive({ xhr: true }, function (res) { return [res, 400, multi]; });
        assert.equal(json(r2).message, multi, 'the detector needs a frame');
    });
});

describe('#B670 §02 — LOCAL scope: the wire is unchanged (the dev toolbar reads it)', function () {

    var drive = makeDriver(true);

    it('JSON 3-arg: the full stack stays in message; an Error keeps its stack field', function () {
        var s = stackOf('b670-local');
        var w = json(drive({ xhr: true }, function (res) { return [res, 500, s]; }));
        assert.equal(w.message, s);
        var w2 = json(drive({ xhr: true }, function (res) { return [res, 500, new Error('b670-local-err')]; }));
        assert.ok(typeof w2.stack == 'string' && FRAME.test(w2.stack), 'local keeps the stack field');
    });

    it('HTML 3-arg: the page still shows the frames', function () {
        var s = stackOf('b670-local-html');
        var r = drive({ xhr: false }, function (res) { return [res, 500, s]; });
        assert.ok(FRAME.test(r.body), 'local page keeps the frames');
        assert.ok(r.body.indexOf('b670-local-html') > -1);
    });
});


// ─── 03 — subtract ────────────────────────────────────────────────────────────
describe('#B670 §03 — subtract: the non-local wire is not the pre-fix value', function () {

    it('pre-fix the wire carried the input verbatim; now it carries its first line', function () {
        var drive = makeDriver(false);
        var s = stackOf('b670-subtract');
        var w = json(drive({ xhr: true }, function (res) { return [res, 500, s]; }));
        assert.notEqual(w.message, s, 'the fix changes the wire value — the discriminator');
        assert.equal(s.indexOf(w.message), 0, 'truncation, not rewrite: the full text starts with the wire line');
    });
});
