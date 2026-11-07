'use strict';
/**
 * #B1111 — `self.downloadFromURL(url, { file })`: `options.file` replaced the url's name AFTER
 * the url's own extension test, so a name with no ASCII-word extension (`report`, `notes.été`,
 * `a.pdf ` with a trailing space) or a value that is not a string (`42`, `{}`) reached the
 * `ext` line, which threw a TypeError inside the async method: its promise rejected,
 * throwError never answered, the response never ended, and a caller that neither awaits nor
 * catches got a process-level unhandledRejection. The final name now gets the url's test and
 * the same answer: a 500 through throwError.
 *
 * The method runs for real through `createTestInstance` (the #B1073 bootstrap) against an
 * in-process upstream. §01–§02 replace throwError with a recorder; §04 drives the REAL
 * throwError (the JSON branch, `isXMLRequest: true`) for one shape.
 * Arms marked CONTROL pin unchanged behaviour and pass on the pre-fix bytes too.
 *
 * Seam: GINA_B1111_CONTROLLER — the controller module to require (a pre-fix copy must sit
 * beside the real file so its relative requires resolve).
 */

var { describe, it, before, after } = require('node:test');
var assert   = require('node:assert/strict');
var os       = require('node:os');
var http     = require('node:http');
var nodePath = require('node:path');
var { Writable } = require('node:stream');

// `_isLocalScope` is read once when the controller module loads: outside the local scope is the
// production default (it only shapes §04's error body)
process.env.NODE_SCOPE_IS_LOCAL = 'false';

var ROOT = nodePath.join(__dirname, '..', '..');
var FW   = require('../fw');
var CONTROLLER_SRC = process.env.GINA_B1111_CONTROLLER || nodePath.join(FW, 'core/controller/controller.js');

process.env.NODE_PATH = (process.env.NODE_PATH || '') + nodePath.delimiter + FW;
require('node:module').Module._initPaths();
require(nodePath.join(FW, 'helpers'));
require(nodePath.join(ROOT, 'utils', 'prototypes'));
setPath('gina', { core: nodePath.join(FW, 'core') });
// a framework global the bundle runtime defines (downloadFromURL builds a tmp path from it)
if (typeof(global.GINA_TMPDIR) == 'undefined') { global.GINA_TMPDIR = os.tmpdir(); }

var SuperController = require(CONTROLLER_SRC);

var STATUS_CODES = { '200': 'OK', '500': 'Internal Server Error' };
var CONF = {
    bundle: 'b', encoding: 'utf-8',
    content: { routing: { r: {} }, templates: { _common: {} } },
    server: { coreConfiguration: {
        statusCodes: STATUS_CODES,
        mime: { pdf: 'application/pdf', json: 'application/json', html: 'text/html' }
    } }
};

/**
 * A mock response whose setHeader enforces Node's header-value rule, as ServerResponse does.
 *
 * @inner
 * @returns {object} The mock response (a Writable, so `pipeline()` can write into it).
 */
function strictRes() {
    var chunks = [];
    var res = new Writable({ write: function (c, e, cb) { chunks.push(c); cb(); } });
    res.headers = {};
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = function (k, v) { http.validateHeaderValue(k, v); res.headers[k.toLowerCase()] = v; };
    res.getHeader = function (k) { return res.headers[k.toLowerCase()]; };
    res.getHeaders = function () { var o = {}; for (var k in res.headers) { o[k] = res.headers[k]; } return o; };
    res.removeHeader = function (k) { delete res.headers[k.toLowerCase()]; };
    res.body = function () { return Buffer.concat(chunks).toString(); };
    return res;
}

// the in-process upstream: counts the requests it receives
var up = null, upPort = 0, upCount = 0;

before(function (t, ready) {
    up = http.createServer(function (req, res) {
        upCount++;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('UPBYTES');
    });
    up.listen(0, '127.0.0.1', function () { upPort = up.address().port; ready(); });
});
after(function () { if (up) { up.close(); } });

function upUrl(name) { return 'http://127.0.0.1:' + upPort + '/' + name; }

/**
 * Run downloadFromURL with throwError replaced by a recorder, and report how it ended.
 *
 * @inner
 * @param {*} url - the url argument, as given
 * @param {object} [opts] - the options argument, as given
 * @returns {Promise<object>} `{ settled, thrown, finished, upCalls, headers, body }`: `settled`
 *   reads `resolved`, `rejected: <message>` or `pending` (no settle within 3 s)
 */
function drive(url, opts) {
    return new Promise(function (resolve) {
        var res = strictRes();
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', routing: { rule: 'r' }, params: {}, get: {}, post: {}, headers: {} },
            res: res, options: { rule: 'r', conf: CONF }
        });
        inst.getConfig = function () { return {}; };
        var out = { settled: 'pending', thrown: null, finished: false, upCalls: 0 };
        var upBefore = upCount, reported = false;
        inst.throwError = function (r, code, e) {
            out.thrown = { code: code, message: (e && e.message) ? e.message : String(e) };
            res.end();
        };
        res.on('finish', function () { out.finished = true; });
        function report() {
            if (reported) { return; }
            reported = true;
            out.upCalls = upCount - upBefore;
            out.headers = res.getHeaders();
            out.body = res.body();
            resolve(out);
        }
        var timer = setTimeout(report, 3000);
        Promise.resolve(inst.downloadFromURL(url, opts)).then(
            function () { out.settled = 'resolved'; },
            function (e) { out.settled = 'rejected: ' + ((e && e.message) ? e.message : String(e)); }
        ).then(function () {
            // the response's `finish` is emitted asynchronously after `end()`
            setTimeout(function () { clearTimeout(timer); report(); }, 20);
        });
    });
}

/**
 * The answer every refused input must get: a settled call, one 500 through throwError with
 * the given message, no upstream request, and an ended response.
 *
 * @inner
 */
function assertRefused(out, message) {
    assert.equal(out.settled, 'resolved', 'the method must settle, not reject (pre-fix: ' + out.settled + ')');
    assert.deepEqual(out.thrown, { code: 500, message: message });
    assert.equal(out.upCalls, 0, 'no upstream request');
    assert.equal(out.finished, true, 'the response ended');
}


// ── 00 — instrument controls ──────────────────────────────────────────────────

describe('00 - instrument controls', function () {

    it('CONTROL - a plain download runs end to end: 200, the header, the upstream bytes', async function () {
        var out = await drive(upUrl('proof.pdf'), { file: 'report.pdf' });
        assert.equal(out.settled, 'resolved');
        assert.equal(out.thrown, null);
        assert.equal(out.upCalls, 1);
        assert.equal(out.finished, true);
        assert.equal(out.headers['content-type'], 'application/pdf; charset=utf-8');
        assert.equal(out.headers['content-disposition'], 'attachment; filename="report.pdf"');
        assert.equal(out.body, 'UPBYTES');
    });

    it('CONTROL - the recorder sees the existing url check: a url without an extension answers 500', async function () {
        assertRefused(await drive(upUrl('proof'), {}), '[ proof ] extension not found.');
    });
});


// ── 01 — #B1111: the final name gets the url's test ──────────────────────────

describe('01 - #B1111: options.file without an ASCII-word extension answers 500 through throwError', function () {

    var NAMES = {
        'no extension'                      : 'report',
        'a non-ASCII extension'             : 'notes.été',
        'a trailing space after the extension': 'a.pdf '
    };

    Object.keys(NAMES).forEach(function (k) {
        it(k + ': ' + JSON.stringify(NAMES[k]), async function () {
            var out = await drive(upUrl('proof.pdf'), { file: NAMES[k] });
            assertRefused(out, '[ ' + NAMES[k] + ' ] extension not found in `options.file`.');
            assert.equal(out.headers['content-disposition'], undefined, 'nothing of the download was sent');
        });
    });

    it('the same with contentDisposition: inline', async function () {
        var out = await drive(upUrl('proof.pdf'), { file: 'report', contentDisposition: 'inline' });
        assertRefused(out, '[ report ] extension not found in `options.file`.');
    });

    it('a non-ASCII extension is refused even when the url\'s own name is valid (the url\'s test ran first)', async function () {
        var out = await drive(upUrl('ok.pdf'), { file: 'résumé.péf' });
        assertRefused(out, '[ résumé.péf ] extension not found in `options.file`.');
    });
});

describe('01b - #B1111: options.file that is not a string answers 500 through throwError', function () {

    var VALUES = [
        ['a number', 42, 'number'],
        ['an object', {}, 'object'],
        ['an array', ['report.pdf'], 'object'],
        ['true', true, 'boolean']
    ];

    VALUES.forEach(function (v) {
        it(v[0], async function () {
            assertRefused(await drive(upUrl('proof.pdf'), { file: v[1] }), '`options.file` must be a string, got ' + v[2] + '.');
        });
    });
});


// ── 02 — CONTROLs: every name that worked before keeps its exact answer ───────

describe('02 - CONTROL: names and inputs that worked before keep their answer', function () {

    it('CONTROL - no options: the url\'s name', async function () {
        var out = await drive(upUrl('proof.pdf'));
        assert.equal(out.thrown, null);
        assert.equal(out.headers['content-disposition'], 'attachment; filename="proof.pdf"');
    });

    [['no file key', {}], ['file: null', { file: null }], ['file: \'\'', { file: '' }], ['file: 0', { file: 0 }]].forEach(function (c) {
        it('CONTROL - ' + c[0] + ': the url\'s name', async function () {
            var out = await drive(upUrl('proof.pdf'), c[1]);
            assert.equal(out.settled, 'resolved');
            assert.equal(out.thrown, null);
            assert.equal(out.headers['content-disposition'], 'attachment; filename="proof.pdf"');
            assert.equal(out.body, 'UPBYTES');
        });
    });

    it('CONTROL - a name with spaces and a valid extension', async function () {
        var out = await drive(upUrl('proof.pdf'), { file: 'monthly report 2026.pdf' });
        assert.equal(out.thrown, null);
        assert.equal(out.headers['content-disposition'], 'attachment; filename="monthly report 2026.pdf"');
    });

    it('CONTROL - inline keeps its value', async function () {
        var out = await drive(upUrl('proof.pdf'), { file: 'report.pdf', contentDisposition: 'inline' });
        assert.equal(out.thrown, null);
        assert.equal(out.headers['content-disposition'], 'inline');
    });

    it('CONTROL - an extension mime.types does not know answers its own 500', async function () {
        assertRefused(await drive(upUrl('proof.pdf'), { file: 'report.xyz' }), '[ xyz ] Extension not supported. Ref.: gina/core mime.types');
    });

    it('CONTROL - a url without a scheme defaults to http', async function () {
        var out = await drive('127.0.0.1:' + upPort + '/proof.pdf', {});
        assert.equal(out.thrown, null);
        assert.equal(out.upCalls, 1);
        assert.equal(out.body, 'UPBYTES');
    });
});


// ── 04 — the REAL throwError: what the client receives ───────────────────────

describe('04 - through the real throwError (the JSON branch): the client gets a 500 body', function () {

    /**
     * Run downloadFromURL with the controller's own throwError and capture the answer.
     *
     * @inner
     * @returns {Promise<object>} `{ settled, status, json }`
     */
    function driveReal(url, opts) {
        return new Promise(function (resolve) {
            var status = null, body = null;
            var res = {
                statusCode: 200, headersSent: false,
                setHeader: function () {}, getHeader: function () {},
                getHeaders: function () { return {}; }, removeHeader: function () {},
                writeHead: function (code) { status = code; },
                end: function (chunk) { body = (chunk == null) ? '' : String(chunk); }
            };
            var inst = SuperController.createTestInstance({
                req: { url: '/x', method: 'GET', routing: { rule: 'r@b', param: { control: 'action' } },
                    params: {}, get: {}, post: {}, headers: { 'user-agent': 'node-test', 'accept-language': 'en' } },
                res: res, next: function () {},
                options: { rule: 'r', control: 'action', encoding: 'utf8', isXMLRequest: true, isUsingTemplate: true, conf: CONF }
            });
            inst.getConfig = function () { return {}; };
            var origError = console.error;
            console.error = function () {}; // the #ERRREF pairing line
            var settled = 'pending';
            Promise.resolve(inst.downloadFromURL(url, opts)).then(
                function () { settled = 'resolved'; },
                function (e) { settled = 'rejected: ' + (e && e.message); }
            ).then(function () {
                console.error = origError;
                var json = null;
                try { json = JSON.parse(body); } catch (e) { json = null; }
                resolve({ settled: settled, status: status, json: json });
            });
        });
    }

    it('#B1111 options.file without an extension', async function () {
        var out = await driveReal(upUrl('proof.pdf'), { file: 'report' });
        assert.equal(out.settled, 'resolved', 'pre-fix: ' + out.settled);
        assert.equal(out.status, 500);
        assert.ok(out.json, 'a JSON body');
        assert.equal(out.json.status, 500);
        assert.equal(out.json.message, '[ report ] extension not found in `options.file`.');
    });

    it('CONTROL - the url check already answered this way', async function () {
        var out = await driveReal(upUrl('proof'), {});
        assert.equal(out.settled, 'resolved');
        assert.equal(out.status, 500);
        assert.equal(out.json && out.json.message, '[ proof ] extension not found.');
    });
});
