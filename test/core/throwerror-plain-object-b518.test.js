'use strict';
/**
 * #B518 — `throwError()` called with ONE error object keeps the object's
 * `message` and its relay-safe `ref`: on the JSON body, on the inline HTML
 * error page, and in the #ERRREF pairing line; and the fast lane's
 * `ctx.error()`, which builds the same envelope, keeps them too.
 *
 * In the one-argument form the build kept only `status` and `error` of a plain
 * object, and only `message` and `stack` of an `Error`: a plain object's
 * sentence never reached the client or the log line, and a `ref` on either was
 * replaced by a fresh one. The two- and three-argument forms already carried
 * both. The booted-bundle arms (the JSON body, a `self.query()` relay) live in
 * test/integration/container-boot-throwerror-plain-object-b518.test.js; this
 * file drives the REAL bytes through `createTestInstance` (the #B554 harness)
 * to reach what a boot in the local scope cannot:
 *
 *   §01 the inline HTML page: the copied message renders, escaped; the ref of
 *       a plain object and of an `Error` is honoured; controls in the two- and
 *       three-argument forms
 *   §02 the JSON body outside the local scope (this file sets it, the
 *       production default): message and ref kept; a copied message carrying
 *       a stack keeps its first line only, on the body and on the page (the
 *       #B670 rule); an unsafe ref is still replaced
 *   §03 the pairing line carries the caller's sentence under the kept ref,
 *       and a stack-bearing message in full
 *   §04 lib/lane `ctx.error()`: the same shapes keep the same message and ref
 *       (its parity with the controller over the shapes they already shared is
 *       pinned in test/lib/lane-writers.test.js §05; the `Error` with a `ref`
 *       is not among them)
 *
 * The HTML page is reached with the #B554 option set (b): no views, method
 * DELETE, `isUsingTemplate` true, no `errorFiles`, a URL without extension.
 * The JSON body is reached with `isXMLRequest` true.
 *
 * Seam: `GINA_LANE_MAIN=<file>` loads that file instead of the tree's
 * `lib/lane` (§04).
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');

// `_isLocalScope` is read ONCE at module load, by the controller and by the
// lane: set it before either is required. Outside the local scope is the
// production default.
process.env.NODE_SCOPE_IS_LOCAL = 'false';

var FW        = require('../fw');
var SRC_CTL   = path.join(FW, 'core/controller/controller.js');
var LANE_MAIN = process.env.GINA_LANE_MAIN || path.join(FW, 'lib/lane/src/main.js');

var SENTENCE = 'upstream refused';
var MINTED   = /^[0-9A-F]{6}$/;
var STACKY   = 'boom\n    at handler (/srv/app/b518.js:1:1)';
var STATUS_CODES = { '200': 'OK', '500': 'Internal Server Error', '502': 'Bad Gateway' };

/**
 * A 1-arg `Error` with a status and a relay-safe ref.
 *
 * @inner
 * @returns {Error}
 */
function errorWithRef() {
    var e = new Error(SENTENCE);
    e.status = 502;
    e.ref = 'ORDER-42';
    return e;
}

/**
 * Drive the REAL controller `throwError` and capture what it answers.
 *
 * @inner
 * @returns {function(boolean, function(object): Array): object}
 *          drive(xhr, argsFn) -> `{ status, body, json, log }`, where argsFn
 *          receives the mock response and returns the throwError arguments,
 *          and `log` holds the #ERRREF pairing lines written meanwhile
 */
function makeDriver() {
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));
    setPath('gina', { core: path.join(FW, 'core') });
    var SuperController = require(SRC_CTL);

    return function drive(xhr, argsFn) {
        var body = null, status = null, log = [];
        var res = {
            statusCode: 200, headersSent: false,
            setHeader: function () {}, getHeader: function () {},
            getHeaders: function () { return {}; },
            writeHead: function (code) { status = code; },
            end: function (chunk) { body = (chunk == null) ? '' : String(chunk); }
        };
        var req = {
            url: '/x', method: xhr ? 'GET' : 'DELETE',
            routing: { rule: 'r@b', param: { control: 'action' } },
            params: {}, get: {}, headers: { 'user-agent': 'node-test', 'accept-language': 'en' }
        };
        var options = {
            rule: 'r', control: 'action', encoding: 'utf8',
            isXMLRequest: !!xhr, isUsingTemplate: true,
            conf: {
                bundle: 'b', encoding: 'utf8',
                server: { coreConfiguration: {
                    statusCodes: STATUS_CODES,
                    mime: { json: 'application/json', html: 'text/html' }
                } },
                content: { routing: {}, templates: { _common: {} } }
            }
        };
        var inst = SuperController.createTestInstance({
            req: req, res: res, next: function () {}, options: options
        });
        var origError = console.error;
        console.error = function () {
            var line = Array.prototype.join.call(arguments, ' ');
            if (/\[ ref /.test(line)) { log.push(line); }
        };
        try {
            inst.throwError.apply(inst, argsFn(res));
        } finally {
            console.error = origError;
        }
        assert.equal(typeof body, 'string', 'harness fault: throwError never reached res.end');
        var json = null;
        if (xhr) {
            try { json = JSON.parse(body); } catch (e) { /* not JSON */ }
            assert.ok(json, 'harness fault: the XHR answer is not JSON: ' + body.slice(0, 200));
        } else {
            assert.ok(body.indexOf('<h1 class="status">Error ') > -1, 'harness fault: not the inline fallback page: ' + body.slice(0, 200));
        }
        return { status: status, body: body, json: json, log: log };
    };
}

/**
 * The text of every `<pre class="5xx <kind>">` block on the page.
 *
 * @inner
 * @param {string} html
 * @param {string} kind - `message`, `title`, `ref` or `stack`
 * @returns {string[]}
 */
function blocks(html, kind) {
    var out = [], re = new RegExp('<pre class="\\dxx ' + kind + '">([\\s\\S]*?)</pre>', 'g'), m;
    while ((m = re.exec(html))) { out.push(m[1]); }
    return out;
}

/**
 * Answer through the REAL lane `ctx.error()` on a response stub (the
 * lane-writers.test.js shape), its logger silenced.
 *
 * @inner
 * @param {Array} args - the `ctx.error()` arguments
 * @returns {{status: number, json: object}}
 */
function laneError(args) {
    var LOGGER = require(path.join(FW, 'lib/logger'));
    var api    = require(LANE_MAIN);
    var out = {}, headers = {}, sent = false;
    var res = {
        statusCode : 200,
        setHeader  : function (k, v) { headers[String(k).toLowerCase()] = v; return this; },
        getHeader  : function (k) { return headers[String(k).toLowerCase()]; },
        getHeaders : function () { return Object.assign({}, headers); },
        writeHead  : function (code, h) {
            out.status = code; this.statusCode = code;
            for (var k in h) { headers[k.toLowerCase()] = h[k]; }
            sent = true; return this;
        },
        end        : function (chunk) { out.body = (chunk == null) ? '' : String(chunk); sent = true; return this; }
    };
    Object.defineProperty(res, 'headersSent', { get: function () { return sent; } });
    var req = {
        method: 'GET', url: '/x', headers: { 'user-agent': 'node-test', 'accept-language': 'en' },
        params: {}, get: {}, routing: { rule: 'r@b', bundle: 'b', param: { lane: 'l', control: 'action' } },
        _ginaReqId: 'REQ-B518'
    };
    var conf = {
        bundle: 'b', encoding: 'utf8',
        server: { protocol: 'http/1.1', coreConfiguration: { statusCodes: STATUS_CODES, mime: { json: 'application/json', html: 'text/html' } } },
        content: { routing: {}, templates: { _common: {} }, settings: {} }
    };
    var levels = ['info', 'warn', 'error', 'debug'], saved = {}, savedGetContext = global.getContext;
    levels.forEach(function (l) { saved[l] = LOGGER[l]; LOGGER[l] = function () {}; });
    global.getContext = function () { return undefined; };
    try {
        var ctx = new api.LaneContext(req, res, { lane: 'l', control: 'action' }, conf);
        ctx.error.apply(ctx, args);
    } finally {
        levels.forEach(function (l) { LOGGER[l] = saved[l]; });
        global.getContext = savedGetContext;
    }
    assert.equal(typeof out.body, 'string', 'harness fault: the lane never answered');
    return { status: out.status, json: JSON.parse(out.body) };
}

var drive = makeDriver();


describe('#B518 §01 - the inline HTML page', function () {

    it('CONTROL - `(502, {…})` renders the message and honours the ref', function () {
        var r = drive(false, function () { return [502, { status: 502, error: 'Bad Gateway', message: SENTENCE, ref: 'UP-4' }]; });
        assert.ok(blocks(r.body, 'message').indexOf(SENTENCE) > -1, 'harness fault: the control did not render its message: ' + r.body.slice(0, 400));
        assert.deepEqual(blocks(r.body, 'ref'), ['ref UP-4']);
    });

    it('CONTROL - `(res, 502, {…})` renders the message and honours the ref', function () {
        var r = drive(false, function (res) { return [res, 502, { message: SENTENCE, ref: 'UP-5' }]; });
        assert.ok(blocks(r.body, 'message').indexOf(SENTENCE) > -1);
        assert.deepEqual(blocks(r.body, 'ref'), ['ref UP-5']);
    });

    it('a 1-arg `{status, error, message}` renders its message beside the `error` title', function () {
        var r = drive(false, function () { return [{ status: 502, error: 'Bad Gateway', message: SENTENCE }]; });
        assert.equal(r.status, 502);
        assert.deepEqual(blocks(r.body, 'title'), ['Bad Gateway']);
        assert.deepEqual(blocks(r.body, 'message'), [SENTENCE], 'the object\'s message is missing from the page');
    });

    it('a 1-arg object keeps its relay-safe ref on the page', function () {
        var r = drive(false, function () { return [{ status: 502, error: 'Bad Gateway', message: SENTENCE, ref: 'UP-1' }]; });
        assert.deepEqual(blocks(r.body, 'ref'), ['ref UP-1'], 'the object\'s ref was replaced on the page');
    });

    it('a 1-arg Error keeps its relay-safe ref on the page', function () {
        var r = drive(false, function () { return [errorWithRef()]; });
        assert.deepEqual(blocks(r.body, 'ref'), ['ref ORDER-42'], 'the Error\'s ref was replaced on the page');
    });

    it('a copied message renders escaped on the page', function () {
        var r = drive(false, function () { return [{ status: 502, error: 'Bad Gateway', message: '<img src=x onerror=alert(1)>' }]; });
        assert.equal(r.body.indexOf('<img'), -1, 'the copied message was reflected raw');
        assert.deepEqual(blocks(r.body, 'message'), ['&lt;img src=x onerror=alert(1)&gt;']);
    });
});


describe('#B518 §02 - the JSON body, outside the local scope', function () {

    it('CONTROL - `(502, err)` honours the Error\'s ref', function () {
        var r = drive(true, function () { var e = errorWithRef(); delete e.status; return [502, e]; });
        assert.equal(r.json.ref, 'ORDER-42', 'harness fault: the two-argument form no longer honours the ref');
    });

    it('a 1-arg object carries its message and its ref', function () {
        var r = drive(true, function () { return [{ status: 502, error: 'Bad Gateway', message: SENTENCE, ref: 'UP-1' }]; });
        assert.equal(r.json.error, 'Bad Gateway');
        assert.equal(r.json.message, SENTENCE, 'the object\'s message was dropped');
        assert.equal(r.json.ref, 'UP-1', 'the object\'s ref was replaced');
    });

    it('a 1-arg Error keeps its relay-safe ref', function () {
        var r = drive(true, function () { return [errorWithRef()]; });
        assert.equal(r.json.message, SENTENCE);
        assert.equal(r.json.ref, 'ORDER-42', 'the Error\'s ref was replaced');
    });

    it('a copied message carrying a stack keeps its first line on the JSON body', function () {
        var r = drive(true, function () { return [{ status: 500, error: 'Internal Server Error', message: STACKY }]; });
        assert.equal(r.json.message, 'boom', 'the copied message did not keep its first line only');
        assert.equal(r.body.indexOf('/srv/app/b518.js'), -1, 'a frame reached the JSON body');
        assert.equal(r.json.stack, undefined, 'the stack field reached the JSON body');
    });

    it('a copied message carrying a stack keeps its first line on the page', function () {
        var r = drive(false, function () { return [{ status: 500, error: 'Internal Server Error', message: STACKY }]; });
        assert.deepEqual(blocks(r.body, 'message'), ['boom'], 'the copied message did not keep its first line only');
        assert.equal(r.body.indexOf('/srv/app/b518.js'), -1, 'a frame reached the page');
        assert.deepEqual(blocks(r.body, 'stack'), [], 'a stack block rendered outside the local scope');
    });

    it('GUARD - an unsafe ref on a 1-arg object is still replaced, on the JSON body and on the page', function () {
        var unsafe = { status: 502, error: 'Bad Gateway', message: SENTENCE, ref: 'x ][ ref FORGED' };
        var j = drive(true,  function () { return [Object.assign({}, unsafe)]; });
        var h = drive(false, function () { return [Object.assign({}, unsafe)]; });
        assert.match(j.json.ref, MINTED, 'an unsafe ref reached the JSON body: ' + j.json.ref);
        var pageRef = blocks(h.body, 'ref');
        assert.equal(pageRef.length, 1);
        assert.match(pageRef[0].replace(/^ref /, ''), MINTED, 'an unsafe ref reached the page: ' + pageRef[0]);
    });
});


describe('#B518 §03 - the #ERRREF pairing line', function () {

    it('CONTROL - `(502, {…})` logs the caller\'s sentence under the honoured ref', function () {
        var r = drive(true, function () { return [502, { status: 502, error: 'Bad Gateway', message: SENTENCE, ref: 'UP-4' }]; });
        assert.equal(r.log.length, 1, 'harness fault: expected one pairing line, got ' + r.log.length);
        assert.ok(r.log[0].indexOf('[ ref UP-4 ]') > -1);
        assert.ok(r.log[0].indexOf(SENTENCE) > -1);
    });

    it('a 1-arg object logs its sentence under its own ref', function () {
        var r = drive(true, function () { return [{ status: 502, error: 'Bad Gateway', message: SENTENCE, ref: 'UP-1' }]; });
        assert.equal(r.log.length, 1);
        assert.ok(r.log[0].indexOf('[ ref UP-1 ]') > -1, 'the pairing line names another ref: ' + r.log[0].slice(0, 160));
        assert.ok(r.log[0].indexOf(SENTENCE) > -1, 'the pairing line lost the caller\'s sentence: ' + r.log[0].slice(0, 160));
    });

    it('a copied message carrying a stack is logged in full', function () {
        var r = drive(true, function () { return [{ status: 500, error: 'Internal Server Error', message: STACKY }]; });
        assert.equal(r.log.length, 1);
        assert.ok(r.log[0].indexOf('/srv/app/b518.js') > -1, 'the pairing line lost the frames the wire dropped: ' + r.log[0].slice(0, 200));
    });
});


describe('#B518 §04 - lib/lane ctx.error() keeps the same message and ref', function () {

    it('CONTROL - `(502, {…})` carries the message and honours the ref', function () {
        var r = laneError([502, { status: 502, error: 'Bad Gateway', message: SENTENCE, ref: 'UP-4' }]);
        assert.equal(r.json.message, SENTENCE, 'harness fault: the lane control lost its message');
        assert.equal(r.json.ref, 'UP-4');
    });

    it('a 1-arg object keeps its message and its relay-safe ref', function () {
        var r = laneError([{ status: 502, error: 'Bad Gateway', message: SENTENCE, ref: 'UP-1' }]);
        assert.equal(r.status, 502);
        assert.equal(r.json.error, 'Bad Gateway');
        assert.equal(r.json.message, SENTENCE, 'the object\'s message was dropped');
        assert.equal(r.json.ref, 'UP-1', 'the object\'s ref was replaced');
    });

    it('a 1-arg Error keeps its relay-safe ref', function () {
        var r = laneError([errorWithRef()]);
        assert.equal(r.json.message, SENTENCE);
        assert.equal(r.json.ref, 'ORDER-42', 'the Error\'s ref was replaced');
    });

    it('GUARD - an unsafe ref on a 1-arg object is still replaced', function () {
        var r = laneError([{ status: 502, error: 'Bad Gateway', message: SENTENCE, ref: 'x ][ ref FORGED' }]);
        assert.match(r.json.ref, MINTED, 'an unsafe ref reached the lane\'s body: ' + r.json.ref);
    });
});
