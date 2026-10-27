'use strict';
/**
 * #B672 — `self.throwError()` never writes into the error object an action passes to it.
 *
 * Up to 0.7.5 the one-argument API-error form `self.throwError({ error, fields | flash | errors })`
 * made the action's object the TARGET of `lib/merge` (controller.js, the ApiError merge), and
 * `lib/merge` returns its target: the object received the response's `status`, then the incident
 * `ref`, on an HTML request a callsite `stack`, and on a custom error page that page's data. An
 * object passed again (a module-level error catalogue) answered the later request with the first
 * request's ref and, carrying a stack, went down another branch that dropped its `fields`. In the
 * local scope the inline fallback page also wrote its trimmed text back into the `stack` of the
 * `msg` the caller passed (an `Error` or a plain object, the three-argument form). The fix merges
 * into a copy made by `copyOwn()` (core/controller/render-data.js) and trims a local variable.
 *
 * Arms:
 *   §00 instrument validation - the anchors fire, the comment strip removes the `// was:` lines
 *       without gutting the file, and the old statements survive in RAW text, so the live
 *       negatives of §02 can fail
 *   §01 copyOwn() contract - prototype, own keys with their descriptors, accessors kept and not
 *       called, members shared, a writable copy of a frozen object, a self-reference, an own
 *       `__proto__` key, an array, the values returned as is, the source never written
 *   §02 source pins - both merge sites target `renderData.copyOwn(...)`, the module is required
 *       once, no live statement of throwError writes `msg.stack`
 *   §03 the REAL throwError through `createTestInstance` (the #B554 / #B518 harness), local
 *       scope: one object passed on two requests stays as it was and each request answers its
 *       own ref (XHR and HTML page, the `fields`, `flash` and `errors` shapes); a caller-supplied
 *       ref is still honoured; a frozen object answers; the three-argument form keeps an
 *       `Error`'s and a plain object's `stack`, and the page shows the same trimmed text on
 *       every request
 *
 * The booted twin: test/integration/container-boot-throwerror-reuse-b672.test.js (a custom
 * error page, `fields` on the page, the custom page's data).
 *
 * Seam: `GINA_B672_FW=<framework dir>` loads that tree's controller and render-data (red-first
 * against a pre-fix tree).
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

// The inline fallback page renders its stack block only in the local scope; `_isLocalScope` is
// read ONCE at module load, so this is set before controller.js is required (§03).
process.env.NODE_SCOPE_IS_LOCAL = 'true';

var FW       = process.env.GINA_B672_FW || require('../fw');
var SRC_CTL  = path.join(FW, 'core/controller/controller.js');
var SRC_DATA = path.join(FW, 'core/controller/render-data.js');

var rawCtl = fs.readFileSync(SRC_CTL, 'utf8');

var MINTED       = /^[0-9A-F]{6}$/;
var STATUS_CODES = { '200': 'OK', '400': 'Bad Request', '500': 'Internal Server Error', '503': 'Service Unavailable' };

/**
 * Drop comment lines, so a pin cannot be satisfied by the `// was:` lines the replace-code
 * convention leaves beside a fixed statement.
 *
 * @inner
 * @param {string} source
 * @returns {string} the live lines only
 */
function stripComments(source) {
    return source.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}
var liveCtl = stripComments(rawCtl);

/** @inner @param {string} hay @param {string} needle @returns {number} */
function countOf(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The text of the controller's `throwError` method: from its declaration to the declaration
 * that follows it (`var refToObj`).
 *
 * @inner
 * @param {string} src - controller.js, raw or comment-stripped
 * @returns {string|null} the method's text, or null when an anchor is missing
 */
function throwErrorBody(src) {
    var start = src.indexOf('this.throwError = function(res, code, msg)');
    var end   = src.indexOf('var refToObj = function (arr){', start);
    if (start < 0 || end < 0) { return null; }
    return src.slice(start, end);
}

/** A live statement writing the `stack` of the caller's `msg` (`==` / `===` excluded). */
var MSG_STACK_WRITE = /\bmsg\.stack\s*=(?!=)/g;

/** @inner @param {string} s @returns {number} */
function msgStackWrites(s) { return (s.match(MSG_STACK_WRITE) || []).length; }

/**
 * A comparable picture of an object: its own keys and its JSON text.
 *
 * @inner
 * @param {object} o
 * @returns {{keys: string[], json: string}}
 */
function snapshot(o) {
    return { keys: Reflect.ownKeys(o).map(String), json: JSON.stringify(o) };
}

/**
 * The trimming the inline fallback page applies to a stack before it renders it (the shipped
 * statements, applied to a local value).
 *
 * @inner
 * @param {{error: *, message: *, stack: string}} msg
 * @returns {string}
 */
function trimmed(msg) {
    var s = msg.stack;
    if (msg.error)   { s = s.replace(msg.error, ''); }
    if (msg.message) { s = s.replace(msg.message, ''); }
    return s.replace('Error:', '').replace(' ', '');
}

/**
 * Drive the REAL controller `throwError` and capture what it answers (the #B518 harness).
 *
 * @inner
 * @returns {function(boolean, function(object): Array): object}
 *          drive(xhr, argsFn) -> `{ status, body, json }`, where argsFn receives the mock
 *          response and returns the throwError arguments
 */
function makeDriver() {
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));
    setPath('gina', { core: path.join(FW, 'core') });
    var SuperController = require(SRC_CTL);

    return function drive(xhr, argsFn) {
        var body = null, status = null;
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
        console.error = function () {};
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
        return { status: status, body: body, json: json };
    };
}

/**
 * The text of every `<pre class="Nxx <kind>">` block on the page.
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
 * The incident ref a page shows (its single ref block).
 *
 * @inner
 * @param {string} html
 * @returns {string}
 */
function pageRef(html) {
    var refs = blocks(html, 'ref');
    assert.equal(refs.length, 1, 'harness fault: expected one ref block, got ' + refs.length);
    return refs[0].replace(/^ref /, '');
}

/** The three API-error shapes that reach the ApiError merge. */
var API_SHAPES = [
    ['fields', function () { return { error: 'Invalid input', fields: { email: 'required' } }; }],
    ['flash',  function () { return { error: 'Invalid input', flash: { notice: 'check the form' } }; }],
    ['errors', function () { return { error: 'Invalid input', errors: [{ path: 'amount', message: 'required' }] }; }]
];

var renderData = require(SRC_DATA);
var copyOwn    = renderData.copyOwn;
var drive      = null;

/** @inner @returns {function} the driver, built once */
function driver() {
    if (!drive) { drive = makeDriver(); }
    return drive;
}


describe('#B672 §00 - instrument validation', function () {

    it('the anchors fire, and a bogus token does not', function () {
        assert.ok(rawCtl.indexOf('this.throwError = function(res, code, msg)') > -1, 'controller anchor must fire');
        assert.ok(throwErrorBody(rawCtl) && throwErrorBody(rawCtl).length > 10000, 'the throwError body must extract');
        assert.equal(rawCtl.indexOf('zz-b672-bogus-token'), -1);
    });

    it('the comment strip removes lines without gutting the file, and keeps the method', function () {
        assert.ok(liveCtl.length < rawCtl.length, 'the strip must remove something');
        assert.ok(liveCtl.length > rawCtl.length * 0.3, 'the strip must not gut the source');
        assert.ok(throwErrorBody(liveCtl) && throwErrorBody(liveCtl).length > 10000, 'the method survives the strip');
    });

    it('the old statements are still locatable in RAW text, so the negatives of §02 can fail', function () {
        assert.ok(countOf(rawCtl, 'errorObject = merge(arguments[arguments.length-1], errorObject)') > 0, 'the ApiError merge into the caller\'s object');
        assert.ok(countOf(rawCtl, 'errorObject = merge(_lastArg, errorObject);') > 0, 'the stack-bearing merge into the caller\'s object');
        assert.ok(msgStackWrites(throwErrorBody(rawCtl)) > 0, 'a write to msg.stack');
    });
});


describe('#B672 §01 - copyOwn() contract', function () {

    it('render-data exports copyOwn()', function () {
        assert.equal(typeof copyOwn, 'function', '#B672: core/controller/render-data.js exports no copyOwn()');
    });

    it('a plain object: a new object with the same own keys and values, members shared, the source never written', function () {
        assert.equal(typeof copyOwn, 'function');
        var fields = { email: 'required' };
        var src    = { error: 'Invalid input', fields: fields };
        var before = Object.getOwnPropertyDescriptors(src);
        var copy   = copyOwn(src);
        assert.notEqual(copy, src);
        assert.equal(Object.getPrototypeOf(copy), Object.prototype);
        assert.deepEqual(Reflect.ownKeys(copy), Reflect.ownKeys(src));
        assert.equal(copy.error, 'Invalid input');
        assert.equal(copy.fields, fields, 'a member is shared, not copied');
        copy.status = 400;
        copy.ref    = 'R1';
        assert.deepEqual(Object.getOwnPropertyDescriptors(src), before, 'a write to the copy reached the source');
    });

    it('the prototype is kept: a null-prototype object, and an object built on a plain prototype keeps its toJSON', function () {
        assert.equal(typeof copyOwn, 'function');
        var bare = Object.create(null);
        bare.error  = 'x';
        bare.fields = {};
        var c1 = copyOwn(bare);
        assert.notEqual(c1, bare);
        assert.equal(Object.getPrototypeOf(c1), null);
        var proto = { toJSON: function () { return { tag: 'api', error: this.error }; } };
        var built = Object.create(proto);
        built.error  = 'Invalid';
        built.fields = {};
        var c2 = copyOwn(built);
        assert.notEqual(c2, built);
        assert.equal(Object.getPrototypeOf(c2), proto);
        assert.equal(JSON.stringify(c2), '{"tag":"api","error":"Invalid"}');
    });

    it('own keys keep their descriptors: a symbol key, a non-enumerable key, an accessor that is not called', function () {
        assert.equal(typeof copyOwn, 'function');
        var sym = Symbol('b672'), calls = 0;
        var src = { error: 'x', fields: {} };
        src[sym] = 'symbol value';
        Object.defineProperty(src, 'hidden',   { value: 'h', enumerable: false, writable: false, configurable: false });
        Object.defineProperty(src, 'computed', { get: function () { calls++; return 'c'; }, enumerable: true, configurable: true });
        var copy = copyOwn(src);
        assert.equal(calls, 0, 'the copy called an accessor');
        assert.equal(copy[sym], 'symbol value');
        var dh = Object.getOwnPropertyDescriptor(copy, 'hidden');
        assert.equal(dh.value, 'h');
        assert.equal(dh.enumerable, false, 'enumerability is kept');
        assert.equal(dh.writable, true, 'a data property becomes writable');
        assert.equal(dh.configurable, true, 'a data property becomes configurable');
        var dc = Object.getOwnPropertyDescriptor(copy, 'computed');
        assert.equal(typeof dc.get, 'function', 'the accessor stays an accessor');
        assert.equal(dc.enumerable, true);
        assert.equal(calls, 0, 'reading the descriptor called the accessor');
    });

    it('a frozen object gives a writable copy, and stays frozen', function () {
        assert.equal(typeof copyOwn, 'function');
        var src  = Object.freeze({ error: 'x', fields: Object.freeze({ a: 1 }) });
        var copy = copyOwn(src);
        assert.ok(Object.isExtensible(copy));
        copy.status = 400;
        copy.error  = 'y';
        assert.equal(copy.status, 400);
        assert.equal(copy.error, 'y');
        assert.ok(Object.isFrozen(src));
        assert.equal(src.error, 'x');
        assert.equal(copy.fields, src.fields, 'a frozen member stays shared');
    });

    it('a member referring back to the object refers to the copy; an own `__proto__` key stays an own key', function () {
        assert.equal(typeof copyOwn, 'function');
        var src = { error: 'x', fields: {} };
        src.self = src;
        var copy = copyOwn(src);
        assert.equal(copy.self, copy);
        assert.equal(src.self, src);
        var parsed = JSON.parse('{"error":"x","fields":{},"__proto__":{"polluted":true}}');
        var c2 = copyOwn(parsed);
        assert.ok(Object.prototype.hasOwnProperty.call(c2, '__proto__'), 'the own __proto__ key was lost');
        assert.equal(Object.getPrototypeOf(c2), Object.prototype, 'the copy\'s prototype changed');
        assert.equal(c2.polluted, undefined);
    });

    it('an array is copied one level deep, its holes and its length kept', function () {
        assert.equal(typeof copyOwn, 'function');
        var row  = { id: 1 };
        var src  = [row, , 'z']; // eslint-disable-line no-sparse-arrays
        var copy = copyOwn(src);
        assert.notEqual(copy, src);
        assert.ok(Array.isArray(copy));
        assert.equal(copy.length, 3);
        assert.equal(copy[0], row, 'an element is shared');
        assert.equal(1 in copy, false, 'the hole is kept');
        assert.equal(copy[2], 'z');
    });

    it('a value that is not a copyable node is returned as is', function () {
        assert.equal(typeof copyOwn, 'function');
        class ApiError { constructor() { this.error = 'x'; this.fields = {}; } }
        class List extends Array {}
        var values = [undefined, null, 0, 42, '', 'str', true, new Error('x'), new Date(0),
            function () {}, new Map(), new ApiError(), new List()];
        values.forEach(function (v, i) {
            assert.equal(copyOwn(v), v, 'value #' + i + ' was not returned as is');
        });
    });
});


describe('#B672 §02 - source pins', function () {

    it('the ApiError merge targets a copy of the last argument (live code)', function () {
        assert.equal(countOf(liveCtl, 'errorObject = merge(renderData.copyOwn(arguments[arguments.length-1]), errorObject)'), 1,
            '#B672: expected exactly one live ApiError merge into renderData.copyOwn(...)');
        assert.equal(countOf(liveCtl, 'errorObject = merge(arguments[arguments.length-1], errorObject)'), 0,
            '#B672: a live merge into the caller\'s object survives');
    });

    it('the stack-bearing last-argument merge targets a copy too (live code)', function () {
        assert.equal(countOf(liveCtl, 'errorObject = merge(renderData.copyOwn(_lastArg), errorObject);'), 1);
        assert.equal(countOf(liveCtl, 'errorObject = merge(_lastArg, errorObject);'), 0,
            '#B672: a live merge into the caller\'s object survives');
    });

    it('controller.js requires core/controller/render-data once', function () {
        var m = liveCtl.match(/var renderData\s*=\s*require\('\.\/render-data'\);/g) || [];
        assert.equal(m.length, 1);
    });

    it('no live statement of throwError writes msg.stack; the page renders the local copy', function () {
        var body = throwErrorBody(liveCtl);
        assert.ok(body, 'harness fault: the throwError body did not extract');
        assert.equal(msgStackWrites(body), 0, '#B672: a live write to the caller\'s msg.stack survives');
        assert.equal(countOf(body, "' stack\">'+ _escapeHtml(_msgStack) +'</pre>'"), 1);
    });
});


describe('#B672 §03 - the real throwError, local scope', function () {

    it('CONTROL - a fresh `{ error, fields }` on each request answers its own ref (XHR)', function () {
        var r1 = driver()(true, function () { return [API_SHAPES[0][1]()]; });
        var r2 = driver()(true, function () { return [API_SHAPES[0][1]()]; });
        assert.match(r1.json.ref, MINTED);
        assert.match(r2.json.ref, MINTED);
        assert.notEqual(r1.json.ref, r2.json.ref, 'harness fault: two mints gave the same ref');
        assert.deepEqual(r2.json.fields, { email: 'required' });
    });

    API_SHAPES.forEach(function (shape) {
        it('the same `{ error, ' + shape[0] + ' }` on two XHR requests: unchanged, and request 2 answers its own ref', function () {
            var shared = shape[1]();
            var before = snapshot(shared);
            var r1 = driver()(true, function () { return [shared]; });
            assert.deepEqual(snapshot(shared), before, 'request 1 wrote into the object');
            var r2 = driver()(true, function () { return [shared]; });
            assert.deepEqual(snapshot(shared), before, 'request 2 wrote into the object');
            assert.match(r2.json.ref, MINTED);
            assert.notEqual(r2.json.ref, r1.json.ref, 'request 2 answered request 1\'s ref');
            assert.deepEqual(r2.json[shape[0]], shape[1]()[shape[0]], 'request 2 lost its ' + shape[0]);
        });
    });

    it('the same `{ error, fields }` on two HTML requests: unchanged, and request 2\'s page shows its own ref', function () {
        var shared = API_SHAPES[0][1]();
        var before = snapshot(shared);
        var r1 = driver()(false, function () { return [shared]; });
        var r2 = driver()(false, function () { return [shared]; });
        assert.deepEqual(snapshot(shared), before, 'the requests wrote into the object');
        assert.match(pageRef(r2.body), MINTED);
        assert.notEqual(pageRef(r2.body), pageRef(r1.body), 'request 2\'s page shows request 1\'s ref');
    });

    it('CONTROL - a caller-supplied ref on the same object is honoured on both requests', function () {
        var shared = { error: 'Invalid input', fields: {}, ref: 'ORDER-42' };
        var j = driver()(true, function () { return [shared]; });
        var h = driver()(false, function () { return [shared]; });
        assert.equal(j.json.ref, 'ORDER-42');
        assert.equal(pageRef(h.body), 'ORDER-42');
    });

    it('a frozen `{ error, fields }` answers, on XHR and on the HTML page', function () {
        var frozen = Object.freeze({ error: 'Invalid input', fields: Object.freeze({ email: 'required' }) });
        var j = driver()(true, function () { return [frozen]; });
        var h = driver()(false, function () { return [frozen]; });
        assert.deepEqual(j.json.fields, { email: 'required' });
        assert.match(pageRef(h.body), MINTED);
    });

    it('the three-argument form keeps an Error\'s stack, and its page shows the trimmed text', function () {
        var err = new Error('boom');
        err.stack = 'Error: boom\n    at handler (/srv/app/b672.js:1:1)';
        var original = err.stack;
        var r = driver()(false, function (res) { return [res, 500, err]; });
        assert.equal(err.stack, original, 'the page rewrote the Error\'s own stack');
        assert.deepEqual(blocks(r.body, 'stack'), [trimmed({ message: 'boom', stack: original })]);
    });

    it('the three-argument form keeps a plain object\'s stack, and both requests show the same trimmed text', function () {
        var original = 'Error: M1\n    at frame (/srv/app/b672.js:2:2)';
        var shared   = { title: 'T', message: 'M1', stack: original };
        var r1 = driver()(false, function (res) { return [res, 503, shared]; });
        var r2 = driver()(false, function (res) { return [res, 503, shared]; });
        assert.equal(shared.stack, original, 'the page rewrote the object\'s own stack');
        var expected = [trimmed({ message: 'M1', stack: original })];
        assert.deepEqual(blocks(r1.body, 'stack'), expected);
        assert.deepEqual(blocks(r2.body, 'stack'), expected, 'request 2\'s page shows another stack');
    });

    it('CONTROL - an Error passed twice in the one-argument form is never written', function () {
        var err = new Error('x');
        err.stack = 'Error: x\n    at a (/srv/app/b672.js:3:3)';
        var keys = Reflect.ownKeys(err).map(String);
        driver()(false, function () { return [err]; });
        driver()(true,  function () { return [err]; });
        assert.equal(err.stack, 'Error: x\n    at a (/srv/app/b672.js:3:3)');
        assert.deepEqual(Reflect.ownKeys(err).map(String), keys);
    });
});
