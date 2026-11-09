'use strict';
/**
 * #B1112 — `self.downloadFromURL(url, options)` merged its defaults INTO the caller's `options`
 * object (lib/merge fills and returns its target), then wrote the formatted content-disposition
 * and the forwarded headers (`content-type`, `x-request-id`) into it. One options object passed
 * to two calls, such as an options object kept at module level and passed to every download,
 * sent the second download under the first one's filename and forwarded the first request's
 * `x-request-id` upstream. A non-null object is now copied, with its own copy of `headers`,
 * before the merge; every other value it holds (an http.Agent, TLS buffers, a lookup function,
 * an AbortSignal) is passed on as it is.
 *
 * The method runs for real through `createTestInstance` against an in-process upstream that
 * records what each request carried; `http.get` is wrapped for this file to read the request
 * options that reach it; §01–§04 replace throwError with a recorder. Arms marked CONTROL pin
 * unchanged behaviour and pass on the pre-fix bytes too. §06 pins the source with its comment
 * lines stripped.
 *
 * Seam: GINA_B1112_CONTROLLER — the controller module to require (a pre-fix copy must sit
 * beside the real file so its relative requires resolve).
 */

var { describe, it, before, after } = require('node:test');
var assert   = require('node:assert/strict');
var fs       = require('node:fs');
var os       = require('node:os');
var http     = require('node:http');
var nodePath = require('node:path');
var { Writable } = require('node:stream');

// `_isLocalScope` is read once when the controller module loads: outside the local scope is the
// production default (it only shapes the real throwError's body)
process.env.NODE_SCOPE_IS_LOCAL = 'false';

var ROOT = nodePath.join(__dirname, '..', '..');
var FW   = require('../fw');
var CONTROLLER_SRC = process.env.GINA_B1112_CONTROLLER || nodePath.join(FW, 'core/controller/controller.js');

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
        mime: { pdf: 'application/pdf', json: 'application/json' }
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

// the in-process upstream records what each request carried; http.get is wrapped to keep the
// request options the method hands it (all requests in this file go to 127.0.0.1)
var up = null, upPort = 0, seen = [];
var origGet = null, lastGet = null;

before(function (t, ready) {
    origGet = http.get;
    http.get = function (opts) { lastGet = opts; return origGet.apply(this, arguments); };
    up = http.createServer(function (req, res) {
        seen.push({
            path: req.url,
            rid: req.headers['x-request-id'] || null,
            auth: req.headers['authorization'] || null,
            custom: req.headers['x-custom'] || null
        });
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('UPBYTES');
    });
    up.listen(0, '127.0.0.1', function () { upPort = up.address().port; ready(); });
});
after(function () {
    if (origGet) { http.get = origGet; }
    if (up) { up.close(); }
});

function upUrl(name) { return 'http://127.0.0.1:' + upPort + '/' + name; }

/**
 * Run downloadFromURL with throwError replaced by a recorder, and report how it ended.
 *
 * @inner
 * @param {*} url - the url argument, as given
 * @param {*} opts - the options argument, as given
 * @param {string} [reqId] - the request's correlation id (`req._ginaReqId`)
 * @returns {Promise<object>} `{ settled, thrown, finished, upstream, headers, body, atGet }`:
 *   `settled` reads `resolved`, `rejected: <message>` or `pending` (no settle within 3 s);
 *   `upstream` lists what the upstream received during this call
 */
function drive(url, opts, reqId) {
    return new Promise(function (resolve) {
        var res = strictRes();
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', routing: { rule: 'r' }, params: {}, get: {}, post: {}, headers: {},
                _ginaReqId: reqId || 'REQ-0' },
            res: res, options: { rule: 'r', conf: CONF }
        });
        inst.getConfig = function () { return {}; };
        var out = { settled: 'pending', thrown: null, finished: false };
        var seenBefore = seen.length, reported = false;
        lastGet = null;
        inst.throwError = function (r, code, e) {
            out.thrown = { code: code, message: (e && e.message) ? e.message : String(e) };
            res.end();
        };
        res.on('finish', function () { out.finished = true; });
        function report() {
            if (reported) { return; }
            reported = true;
            out.upstream = seen.slice(seenBefore);
            out.headers = res.getHeaders();
            out.body = res.body();
            out.atGet = lastGet;
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
 * The answer a completed download must get: settled, no throwError, the upstream bytes.
 *
 * @inner
 */
function assertDownloaded(out) {
    assert.equal(out.settled, 'resolved', 'the method settles (got: ' + out.settled + ')');
    assert.equal(out.thrown, null, 'no throwError');
    assert.equal(out.body, 'UPBYTES', 'the upstream bytes reached the client');
}

function cd(name) { return 'attachment; filename="' + name + '"'; }


// ── 00 — instrument controls ──────────────────────────────────────────────────

describe('00 - instrument controls', function () {

    it('CONTROL - a plain download runs end to end and forwards the request id', async function () {
        var out = await drive(upUrl('proof.pdf'), {}, 'REQ-A');
        assertDownloaded(out);
        assert.equal(out.headers['content-disposition'], cd('proof.pdf'));
        assert.equal(out.upstream.length, 1);
        assert.equal(out.upstream[0].rid, 'REQ-A');
    });

    it('CONTROL - the http.get wrapper reads the request options the method sends', async function () {
        var out = await drive(upUrl('proof.pdf'), {}, 'REQ-B');
        assert.ok(out.atGet, 'http.get was reached through the wrapper');
        assert.equal(out.atGet.host, '127.0.0.1');
        assert.equal(out.atGet.headers['x-request-id'], 'REQ-B');
    });
});


// ── 01 — #B1112: one options object passed to two calls ──────────────────────

describe('01 - #B1112: one options object passed to two calls: each call keeps its own name and request id', function () {

    it('an empty object', async function () {
        var shared = {};
        var first = await drive(upUrl('first.pdf'), shared, 'REQ-1');
        var second = await drive(upUrl('second.pdf'), shared, 'REQ-2');
        assert.equal(first.headers['content-disposition'], cd('first.pdf'));
        assert.equal(second.headers['content-disposition'], cd('second.pdf'), 'the second call goes out under its own name');
        assert.equal(second.upstream[0].rid, 'REQ-2', 'the second call forwards its own request id');
    });

    it('an object kept at module level with a contentType', async function () {
        var shared = { contentType: 'application/pdf' };
        await drive(upUrl('a.pdf'), shared, 'REQ-3');
        var second = await drive(upUrl('b.pdf'), shared, 'REQ-4');
        assert.equal(second.headers['content-disposition'], cd('b.pdf'));
        assert.equal(second.upstream[0].rid, 'REQ-4');
        assert.equal(second.headers['content-type'], 'application/pdf; charset=utf-8');
    });

    it('CONTROL - a fresh object per call', async function () {
        await drive(upUrl('first.pdf'), {}, 'REQ-5');
        var second = await drive(upUrl('second.pdf'), {}, 'REQ-6');
        assert.equal(second.headers['content-disposition'], cd('second.pdf'));
        assert.equal(second.upstream[0].rid, 'REQ-6');
    });
});


// ── 02 — #B1112: the caller's object is left as it was ───────────────────────

describe('02 - #B1112: the caller\'s options object is left as it was', function () {

    it('an empty object gains no key', async function () {
        var o = {};
        assertDownloaded(await drive(upUrl('proof.pdf'), o, 'REQ-7'));
        assert.deepEqual(Object.keys(o), []);
    });

    it('an object with headers keeps its keys, its values and its own headers object', async function () {
        var h = { authorization: 'Bearer T' };
        var o = { headers: h, rejectUnauthorized: false };
        var before = JSON.stringify(o);
        assertDownloaded(await drive(upUrl('proof.pdf'), o, 'REQ-8'));
        assert.equal(JSON.stringify(o), before);
        assert.equal(o.headers, h, 'the same headers object');
        assert.deepEqual(Object.keys(h), ['authorization']);
    });

    it('CONTROL - the caller\'s headers are forwarded', async function () {
        var out = await drive(upUrl('proof.pdf'), { headers: { authorization: 'Bearer T' } }, 'REQ-9');
        assert.equal(out.upstream[0].auth, 'Bearer T');
        assert.equal(out.upstream[0].rid, 'REQ-9');
    });

    it('CONTROL - a caller\'s own x-request-id wins over the request\'s', async function () {
        var out = await drive(upUrl('proof.pdf'), { headers: { 'x-request-id': 'CALLER' } }, 'REQ-10');
        assert.equal(out.upstream[0].rid, 'CALLER');
    });

    it('CONTROL - the caller\'s rejectUnauthorized reaches http.get', async function () {
        var out = await drive(upUrl('proof.pdf'), { rejectUnauthorized: false }, 'REQ-11');
        assert.equal(out.atGet.rejectUnauthorized, false);
    });
});


// ── 03 — values reach http.get as they were given ────────────────────────────
// CONTROLs: before the fix the caller's object was the merge target, so these held then too;
// they guard the copy (a deep copy turned an array of Buffers into objects and dropped the call).

describe('03 - CONTROL: the values an options object holds reach http.get as they were given', function () {

    it('CONTROL - an http.Agent reaches http.get by identity and carries the request', async function () {
        var ag = new http.Agent({ keepAlive: false }), adds = 0, origAdd = ag.addRequest;
        ag.addRequest = function () { adds++; return origAdd.apply(this, arguments); };
        var out = await drive(upUrl('proof.pdf'), { agent: ag }, 'REQ-12');
        assertDownloaded(out);
        assert.equal(out.atGet.agent, ag);
        assert.equal(adds, 1);
        ag.destroy();
    });

    it('CONTROL - an array of Buffers, a Buffer, a key, a lookup function and an AbortSignal pass by identity', async function () {
        var b1 = Buffer.from('CA-ONE'), b2 = Buffer.from('CA-TWO'), b3 = Buffer.from('CERT');
        var ca = [b1, b2];
        var lookup = function (h, o, cb) { return require('node:dns').lookup(h, o, cb); };
        var ac = new AbortController();
        var out = await drive(upUrl('proof.pdf'), { ca: ca, cert: b3, key: 'PEM-KEY', lookup: lookup, signal: ac.signal }, 'REQ-13');
        assertDownloaded(out);
        assert.equal(out.atGet.ca, ca);
        assert.equal(out.atGet.ca[0], b1);
        assert.ok(Buffer.isBuffer(out.atGet.ca[1]));
        assert.equal(out.atGet.cert, b3);
        assert.equal(out.atGet.key, 'PEM-KEY');
        assert.equal(out.atGet.lookup, lookup);
        assert.equal(out.atGet.signal, ac.signal);
    });

    it('CONTROL - a header whose value is an array is sent as given', async function () {
        var xc = ['a', 'a', 'b'];
        var out = await drive(upUrl('proof.pdf'), { headers: { 'x-custom': xc } }, 'REQ-14');
        assertDownloaded(out);
        assert.equal(out.atGet.headers['x-custom'], xc);
        assert.equal(out.upstream[0].custom, 'a, a, b');
    });
});


// ── 04 — CONTROLs: inputs that worked before keep their answer ───────────────

describe('04 - CONTROL: inputs that worked before keep their answer', function () {

    it('CONTROL - no options: the url\'s name', async function () {
        var out = await drive(upUrl('proof.pdf'), undefined, 'REQ-15');
        assertDownloaded(out);
        assert.equal(out.headers['content-disposition'], cd('proof.pdf'));
    });

    it('CONTROL - null: the url\'s name, as with no options', async function () {
        var out = await drive(upUrl('proof.pdf'), null, 'REQ-16');
        assertDownloaded(out);
        assert.equal(out.headers['content-disposition'], cd('proof.pdf'));
    });

    it('CONTROL - one object carrying a file name, passed to two calls: both use that name', async function () {
        var o = { file: 'renamed.pdf' };
        var first = await drive(upUrl('a.pdf'), o, 'REQ-17');
        var second = await drive(upUrl('b.pdf'), o, 'REQ-18');
        assert.equal(first.headers['content-disposition'], cd('renamed.pdf'));
        assert.equal(second.headers['content-disposition'], cd('renamed.pdf'));
    });

    it('CONTROL - inline keeps its value', async function () {
        var out = await drive(upUrl('proof.pdf'), { contentDisposition: 'inline' }, 'REQ-19');
        assert.equal(out.headers['content-disposition'], 'inline');
    });
});


// ── 06 — source pins (comment lines stripped) ────────────────────────────────

/**
 * downloadFromURL's body in the controller under test: raw, and with its comment lines
 * (`//`, `/*`, `*`) dropped.
 *
 * @inner
 * @returns {{raw: string, code: string}}
 */
function downloadBody() {
    var src = fs.readFileSync(CONTROLLER_SRC, 'utf8');
    var head = 'this.downloadFromURL = async function';
    var tail = '} // EO this.downloadFromURL()';
    assert.equal(src.split(head).length - 1, 1, 'one downloadFromURL definition');
    assert.equal(src.split(tail).length - 1, 1, 'one end marker');
    var raw = src.slice(src.indexOf(head), src.indexOf(tail));
    var code = raw.split('\n').filter(function (l) {
        var t = l.trim();
        return !(t.indexOf('//') === 0 || t.indexOf('/*') === 0 || t.indexOf('*') === 0);
    }).join('\n');
    return { raw: raw, code: code };
}
function countOf(s, needle) { return s.split(needle).length - 1; }

describe('06 - #B1112 source: the options are copied before the merge', function () {

    it('the copy of the object and of its headers, then the merge into the copy', function () {
        var b = downloadBody();
        assert.equal(countOf(b.code, 'opt = Object.assign({}, options);'), 1);
        assert.equal(countOf(b.code, 'opt.headers = Object.assign({}, opt.headers);'), 1);
        assert.equal(countOf(b.code, 'opt = merge(opt, defaultOptions);'), 1);
    });
});
