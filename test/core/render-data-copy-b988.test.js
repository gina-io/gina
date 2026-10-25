'use strict';
/**
 * #B988 — the render delegates read the object an action passes to `self.render()` /
 * `self.renderWithoutLayout()`, and never write into it.
 *
 * Before 0.7.6 every delegate combined the action's object with gina's render data by making
 * it the TARGET of `lib/merge` (which fills the keys a target lacks) or by aliasing it inside
 * gina's data: the swig delegate wrote the request's `page.data.session` block, its
 * `gina.csrfToken` and its `page.view` into the action's object, so an object passed to
 * several renders carried one request's values into the next request's page. Since 0.7.6
 * each delegate combines `core/controller/render-data.js`'s `copyForRender(userData, data)`.
 *
 *   §01  the helper's contract: which nodes are new, which stay shared, and how a copy keeps
 *        a node's shape (prototype, symbols, non-enumerables, accessors, an own `__proto__`
 *        key, frozen sources, cycles, holes, the depth cap)
 *   §02  the real combine: the combine block of each live delegate is EXTRACTED from the
 *        shipped source and executed for two requests that pass the same object, with
 *        gina's data built by the controller's own `set()` and `refToObj()` (also extracted):
 *        the object stays as it was and the second request's data holds its own session
 *        id, CSRF token and URL; a fresh object gives the same data as the same block with
 *        the copy line removed; and that copy-less block (the 0.7.5 shape) writes into the
 *        object and leaks the first request's values, the control that shows each arm can fail
 *   §03  source pins on the comment-stripped delegates: one `require('./render-data')` and
 *        one call each, the call immediately before the combine; the helper stays out of the
 *        browser bundle
 *
 * The booted twin is test/integration/container-boot-render-reuse-b988.test.js.
 *
 * Seam: `B988_FW=<framework dir>` reads the delegates, `controller.js`, `lib/merge` and the
 * helper from another tree. Against a pre-fix tree §01 and §03 fail (no helper, no call) and
 * §02's "unchanged" arms fail on the leak, while its controls pass.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = process.env.B988_FW || require('../fw');
var CONTROLLER = path.join(FW, 'core', 'controller');
var merge      = require(path.join(FW, 'lib', 'merge', 'src', 'main.js'));

var renderData = null, loadError = null;
try {
    renderData = require(path.join(CONTROLLER, 'render-data.js'));
} catch (e) {
    loadError = e;
}

/**
 * The helper module, asserted loaded.
 *
 * @inner
 * @returns {object} `core/controller/render-data`
 */
function helper() {
    assert.ok(renderData, 'core/controller/render-data.js loads (' + (loadError && loadError.message) + ')');
    return renderData;
}


// ---------------------------------------------------------------------------
// Source reading
// ---------------------------------------------------------------------------

/**
 * The keywords after which an expression starts, so a `/` that follows one opens a regex literal.
 *
 * @constant
 * @type {Array<string>}
 */
var REGEX_KEYWORDS = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'];

/**
 * Whether a `/` met after the code read so far opens a regex literal.
 *
 * @inner
 * @param {string} out - the code read so far, comments dropped
 * @returns {boolean} true for a regex literal
 */
function regexMayStart(out) {
    var j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) { j--; }
    if (j < 0) { return true; }
    if ('(,=:[!&|?{};+-*%<>~^'.indexOf(out[j]) > -1) { return true; }
    if (!/[A-Za-z0-9_$]/.test(out[j])) { return false; }
    var k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) { k--; }
    return REGEX_KEYWORDS.indexOf(out.slice(k + 1, j + 1)) > -1;
}

/**
 * Drops `//` and `/* *\/` comments outside string, template and regex literals (copied from
 * test/core/request-array-bag-b965.test.js), so a comment naming a pinned expression cannot
 * satisfy a pin and a commented-out brace cannot unbalance an extraction.
 *
 * @inner
 * @param {string} text - the source
 * @returns {string} the source without its comments
 */
function stripComments(text) {
    var out = '', i = 0, n = text.length, quote = null;
    while (i < n) {
        var c = text[i], d = text[i + 1];
        if (quote) {
            out += c;
            if (c === '\\') { out += d; i += 2; continue; }
            if (c === quote) { quote = null; }
            i++; continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
        if (c === '/' && d === '/') { var e = text.indexOf('\n', i); if (e < 0) { e = n; } i = e; continue; }
        if (c === '/' && d === '*') { var f = text.indexOf('*/', i + 2); assert.ok(f > -1, 'unterminated block comment'); i = f + 2; continue; }
        if (c === '/' && regexMayStart(out)) {
            var inClass = false;
            out += c; i++;
            while (i < n) {
                var r = text[i];
                assert.ok(r !== '\n', 'unterminated regex literal');
                out += r;
                if (r === '\\') { out += text[i + 1]; i += 2; continue; }
                i++;
                if (r === '[') { inClass = true; }
                else if (r === ']') { inClass = false; }
                else if (r === '/' && !inClass) { break; }
            }
            continue;
        }
        out += c; i++;
    }
    return out;
}

function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The text from `start` to the brace that closes the first `{` met from there, string
 * literals skipped. Asserts `start` is unique and the braces balance.
 *
 * @inner
 * @param {string} src - comment-stripped source
 * @param {string} start - the unique text the slice begins with
 * @param {string} label - for the assertion messages
 * @returns {string} the slice
 */
function braceSlice(src, start, label) {
    var at = src.indexOf(start);
    assert.ok(at > -1, label + ': `' + start + '` is in the source');
    assert.equal(src.indexOf(start, at + 1), -1, label + ': `' + start + '` is unique');
    var depth = 0, started = false, quote = null, i = at;
    for (; i < src.length; i++) {
        var c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) { quote = null; }
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') { depth++; started = true; }
        else if (c === '}') {
            depth--;
            if (started && depth === 0) { i++; break; }
        }
    }
    assert.ok(started && depth === 0, label + ': the slice from `' + start + '` balances');
    return src.slice(at, i);
}

var DELEGATES = {
    swig          : 'controller.render-swig.js',
    v1            : 'controller.render-v1.js',
    swigAsync     : 'controller.render-swig-async.js',
    nunjucks      : 'controller.render-nunjucks.js',
    nunjucksAsync : 'controller.render-nunjucks-async.js'
};
var SOURCE = {}, STRIPPED = {};
Object.keys(DELEGATES).forEach(function (k) {
    SOURCE[k]   = fs.readFileSync(path.join(CONTROLLER, DELEGATES[k]), 'utf8');
    STRIPPED[k] = stripComments(SOURCE[k]);
});
var CONTROLLER_ST = stripComments(fs.readFileSync(path.join(CONTROLLER, 'controller.js'), 'utf8'));

/** The call every delegate makes before its combine. */
var COPY_LINE   = 'userData = renderData.copyForRender(userData, data);';
/** The first combine statement of the swig and v1 delegates. */
var SWIG_ANCHOR = 'if (!userData) {';
/** The restore that ends the swig and v1 combine region. */
var SWIG_END    = 'data = merge(data, getData());';
/** The combine block of the async and nunjucks delegates. */
var NJ_ANCHOR   = "if (userData && typeof(userData) === 'object') {";
/**
 * The one statement the swig and v1 delegates run between the call and the combine: the
 * legacy error flag leaves the copy (whitespace-normalised). The other delegates run none.
 */
var FLAG_STRIP  = {
    swig : "if (isRenderingCustomError && userData && typeof(userData.isRenderingCustomError) != 'undefined') delete userData.isRenderingCustomError;",
    v1   : 'if (isRenderingCustomError) delete userData.isRenderingCustomError;'
};

/**
 * The combine region of a delegate, from the copy line when the source has one (else from
 * the combine anchor) through the restore: the swig and v1 delegates' branch chain,
 * `setResources()`, the file / ext override and `data = merge(data, getData())`; the async
 * and nunjucks delegates' `if (userData && typeof(userData) === 'object') { … }` block.
 *
 * @inner
 * @param {string} key - a DELEGATES key
 * @returns {{ body: string, hasCopy: boolean }} the region and whether it starts with the copy
 */
function combineRegion(key) {
    var st = STRIPPED[key];
    var anchor = (key === 'swig' || key === 'v1') ? SWIG_ANCHOR : NJ_ANCHOR;
    var aAt = st.indexOf(anchor);
    assert.ok(aAt > -1 && st.indexOf(anchor, aAt + 1) === -1, key + ': the combine anchor is unique');
    var cAt = st.indexOf(COPY_LINE);
    var hasCopy = cAt > -1 && cAt < aAt;
    var from = hasCopy ? cAt : aAt;
    var to;
    if (key === 'swig' || key === 'v1') {
        to = st.indexOf(SWIG_END, aAt);
        assert.ok(to > -1, key + ': the restore follows the combine');
        to += SWIG_END.length;
    } else {
        to = aAt + braceSlice(st, anchor, key).length;
    }
    return { body: st.slice(from, to), hasCopy: hasCopy };
}

/**
 * The combine region compiled into a function of the delegate's free identifiers, returning
 * the render data it leaves. `withCopy: false` removes the copy line, which gives the 0.7.5
 * shape of the same block.
 *
 * @inner
 * @param {string} key - a DELEGATES key
 * @param {boolean} withCopy - keep the copy line
 * @returns {function} `(env) => data`
 */
function compileCombine(key, withCopy) {
    var region = combineRegion(key);
    var body = region.body;
    if (!withCopy && region.hasCopy) {
        assert.equal(count(body, COPY_LINE), 1, key + ': one copy line in the region');
        body = body.replace(COPY_LINE, '');
    }
    var fn = new Function(
        'userData', 'data', 'renderData', 'merge', 'getData', 'setResources', 'localOptions', 'req', 'local',
        'isWithoutLayout', 'isRenderingCustomError', 'Collection', 'JSON', 'template',
        body + '\nreturn data;'
    );
    return function (env) {
        return fn(env.userData, env.data, renderData, merge, env.getData, env.setResources, env.localOptions,
            env.req, env.local, env.isWithoutLayout, false, Collection, JSON_SHIM, undefined);
    };
}

/** `new Collection(list).find(…)` as the layoutless branch calls it: the list itself. */
function Collection(list) { this.list = list || []; }
Collection.prototype.find = function () { return this.list; };

/** The `JSON` the extracted code sees: the global one, plus gina's `JSON.clone`. */
var JSON_SHIM = {
    parse     : JSON.parse,
    stringify : JSON.stringify,
    clone     : function (o) { return JSON.parse(JSON.stringify(o)); }
};

/**
 * A function extracted from controller.js (`var <name> = function …`), compiled with the
 * given free identifiers.
 *
 * @inner
 * @param {string} name - the variable the function is assigned to
 * @param {Array<string>} params - its free identifiers
 * @returns {function} `(...values) => the function`
 */
function controllerFn(name, params) {
    var decl = 'var ' + name + ' = function';
    var slice = braceSlice(CONTROLLER_ST, decl, 'controller.js ' + name);
    var fnSrc = slice.slice(('var ' + name + ' = ').length);
    return new Function(params.join(','), 'return (' + fnSrc + ');');
}
var makeSet      = controllerFn('set', ['local', 'merge']);
var makeRefToObj = controllerFn('refToObj', ['merge']);

/**
 * One request's render state, built the way the controller builds it: `set()` writes the
 * view, environment and Csrf values into `local.userData`, `getData()` is
 * `refToObj(local.userData)`, and the swig delegate adds the session block to `data` before
 * the combine (`withSession`).
 *
 * @inner
 * @param {object} o - `{ sid, token, url, withSession, isWithoutLayout }`
 * @returns {object} what compileCombine()'s function reads
 */
function newRequest(o) {
    var local    = { userData: {}, req: { routing: { param: {} } } };
    var set      = makeSet(local, merge);
    var refToObj = makeRefToObj(merge);
    set('page.environment.webroot', '/app/');
    set('page.view.url', o.url);
    set('page.view.file', 'home');
    set('gina.csrfToken', o.token);
    set('gina.csrfInput', '<input name="_csrf" value="' + o.token + '">');
    var getData = function () { return refToObj(local.userData); };
    var data = getData();
    if (o.withSession) {
        if (typeof(data.page.data) == 'undefined') { data.page.data = {}; }
        data.page.data.session = { id: o.sid, lastModified: 1, createdAt: 0, expiresAt: '2026-10-25T00:00:00', timeout: 1 };
    }
    return {
        data            : data,
        getData         : getData,
        local           : local,
        req             : local.req,
        isWithoutLayout : !!o.isWithoutLayout,
        localOptions    : { rule: 'home@app', bundle: 'app', template: { javascripts: [], stylesheets: [] } },
        setResources    : function () {
            set('page.view.stylesheets', '<link rel="stylesheet" href="/app/a.css">');
            set('page.view.scripts', '<script src="/app/a.js"></script>');
        }
    };
}

/**
 * The values a page of the request reads: the session id, the CSRF token and the URL, where
 * the templates of each shape read them.
 *
 * @inner
 * @param {object} data - the render data the combine left
 * @returns {object} `{ sid, token, url }`
 */
function seen(data) {
    var pd = data && data.page && data.page.data;
    return {
        sid   : (pd && pd.session && pd.session.id) || null,
        token : (data && data.gina && data.gina.csrfToken) || null,
        url   : (data && data.page && data.page.view && data.page.view.url) || null
    };
}

// [label, delegate key, isWithoutLayout, builds the session block]
var PATHS = [
    ['swig, layout',        'swig',          false, true],
    ['swig, layoutless',    'swig',          true,  true],
    ['v1, layout',          'v1',            false, true],
    ['swig-async',          'swigAsync',     false, false],
    ['nunjucks',            'nunjucks',      false, false],
    ['nunjucks-async',      'nunjucksAsync', false, false]
];

// [label, the object an action passes]
var SHAPES = [
    ['an object without `page`',          function () { return { title: 'shared', items: [{ id: 1 }, { id: 2 }] }; }],
    ['an object with its own `page`',     function () { return { page: { data: { title: 'shared' } } }; }],
    ['an object with its own `session`',  function () { return { title: 'shared', session: { user: 'app' } }; }],
    ['an object with `page.view` and `gina`', function () { return { page: { view: { title: 'V' } }, gina: { theme: 'dark' } }; }]
];

/**
 * One render of a request: the delegate's combine region, then what the delegate runs next
 * on `data` before the template — render-nunjucks calls `setResources()`, the async
 * delegates call it and restore again (`data = merge(data, getData())`); the swig and v1
 * regions already end with both.
 *
 * @inner
 * @param {string} key - a DELEGATES key
 * @param {function} combine - from compileCombine()
 * @param {object} env - from newRequest(), with `userData`
 * @returns {object} the render data the template would receive
 */
function render(key, combine, env) {
    var data = combine(env);
    if (key === 'nunjucks') {
        env.setResources();
    } else if (key === 'swigAsync' || key === 'nunjucksAsync') {
        env.setResources();
        data = merge(data, env.getData());
    }
    return data;
}

var REQ_A = { sid: 'sid-A', token: 'tok-A', url: '/app/a' };
var REQ_B = { sid: 'sid-B', token: 'tok-B', url: '/app/b' };

/**
 * A request's render of an object.
 *
 * @inner
 * @param {Array} p - a PATHS row
 * @param {boolean} withCopy - keep the copy line
 * @param {object} req - REQ_A or REQ_B
 * @param {object} userData - the object the action passes
 * @returns {object} the render data
 */
function renderFor(p, withCopy, req, userData) {
    var env = newRequest({ sid: req.sid, token: req.token, url: req.url, withSession: p[3], isWithoutLayout: p[2] });
    env.userData = userData;
    return render(p[1], compileCombine(p[1], withCopy), env);
}


// ---------------------------------------------------------------------------
// §01 — the helper's contract
// ---------------------------------------------------------------------------

describe('#B988 §01 — copyForRender(): which nodes are new, which stay shared', function () {

    var ENV = { page: { view: { file: 'f' }, data: { session: { id: 's1' } }, environment: { routing: { r: 1 } } }, gina: { csrfToken: 't' } };

    it('01.1  a value that is not a copyable node is returned as is', function () {
        var rd = helper();
        class Model { constructor() { this.page = {}; } }
        var fn = function () {}, date = new Date(0), map = new Map(), inst = new Model(), buf = Buffer.from('x');
        class List extends Array {}
        var sub = new List();
        [undefined, null, 0, '', 'text', true, fn, date, map, inst, buf, sub].forEach(function (v, i) {
            assert.equal(rd.copyForRender(v, ENV), v, 'value #' + i);
        });
    });

    it('01.2  the object is new, holds the same keys and values, and its members gina never writes stay shared', function () {
        var rd = helper();
        var rows = [{ a: 1 }], when = new Date(0), user = { name: 'n' };
        var src = { title: 'T', rows: rows, when: when, user: user };
        var copy = rd.copyForRender(src, ENV);
        assert.notEqual(copy, src);
        assert.deepEqual(copy, src);
        assert.equal(copy.rows, rows);
        assert.equal(copy.when, when);
        assert.equal(copy.user, user);
    });

    it('01.3  `page`, `page.view`, `page.data`, `page.environment`, `gina` and `session` are new whatever gina\'s data holds; their own members stay shared', function () {
        var rd = helper();
        var src = {
            page    : { view: { sub: { s: 1 } }, data: { list: [1] }, environment: { e: { x: 1 } }, other: { o: 1 } },
            gina    : { theme: { t: 1 } },
            session : { user: { u: 1 } }
        };
        var copy = rd.copyForRender(src, {});
        ['page', 'gina', 'session'].forEach(function (k) { assert.notEqual(copy[k], src[k], k); });
        ['view', 'data', 'environment'].forEach(function (k) { assert.notEqual(copy.page[k], src.page[k], 'page.' + k); });
        assert.equal(copy.page.other, src.page.other, 'page.other: no node of gina\'s data there');
        assert.equal(copy.page.view.sub, src.page.view.sub);
        assert.equal(copy.page.data.list, src.page.data.list);
        assert.equal(copy.page.environment.e, src.page.environment.e);
        assert.equal(copy.gina.theme, src.gina.theme);
        assert.equal(copy.session.user, src.session.user);
        assert.deepEqual(copy, src);
    });

    it('01.4  a member is followed down where gina\'s data holds a node at the same place, at the top level and under `page.data`', function () {
        var rd = helper();
        var src = { page: { environment: { routing: { mine: 1 } } }, extra: { session: { id: 'x' } } };
        var copy = rd.copyForRender(src, ENV);
        assert.notEqual(copy.page.environment.routing, src.page.environment.routing, 'page.environment.routing meets gina\'s routing');
        var deep = { session: { cookie: { c: 1 } } };
        var env2 = { page: { data: { session: { id: 's', cookie: { maxAge: 1 } } } } };
        var c2 = rd.copyForRender(deep, env2);
        assert.notEqual(c2.session.cookie, deep.session.cookie, 'session.cookie meets page.data.session.cookie');
        var none = { thing: { a: { b: 1 } } };
        assert.equal(rd.copyForRender(none, ENV).thing, none.thing, 'no node of gina\'s data at `thing`');
    });

    it('01.5  an array on a copied path is a new array with the same elements and holes; class instances, Dates and Maps inside stay shared', function () {
        var rd = helper();
        var inst = new (class X {})(), date = new Date(1), map = new Map();
        var src = { page: { view: { list: [1, , 3] } }, session: { mixed: [inst, date, map] } };
        var env = { page: { view: { list: [9] }, data: { session: { mixed: [] } } } };
        var copy = rd.copyForRender(src, env);
        assert.notEqual(copy.page.view.list, src.page.view.list);
        assert.equal(copy.page.view.list.length, 3);
        assert.equal(1 in copy.page.view.list, false, 'the hole stays a hole');
        assert.notEqual(copy.session.mixed, src.session.mixed);
        assert.equal(copy.session.mixed[0], inst);
        assert.equal(copy.session.mixed[1], date);
        assert.equal(copy.session.mixed[2], map);
    });

    it('01.6  a copy keeps the prototype, symbol and non-enumerable keys, accessors (not called) and an own `__proto__` key', function () {
        var rd = helper();
        var proto = { inherited: true };
        var src = Object.create(proto);
        var sym = Symbol('s'), calls = 0;
        src.page = {};
        src[sym] = 'symbol';
        Object.defineProperty(src, 'hidden', { value: 'h', enumerable: false, writable: false, configurable: false });
        Object.defineProperty(src, 'lazy', { get: function () { calls++; return 'L'; }, enumerable: true, configurable: true });
        var copy = rd.copyForRender(src, ENV);
        assert.equal(Object.getPrototypeOf(copy), proto);
        assert.equal(copy[sym], 'symbol');
        assert.equal(copy.hidden, 'h');
        assert.equal(Object.keys(copy).indexOf('hidden'), -1, 'still not enumerable');
        assert.equal(calls, 0, 'the accessor was not called by the copy');
        assert.equal(typeof Object.getOwnPropertyDescriptor(copy, 'lazy').get, 'function');
        assert.equal(copy.lazy, 'L');

        var nul = Object.create(null);
        nul.page = { data: {} };
        assert.equal(Object.getPrototypeOf(rd.copyForRender(nul, ENV)), null);

        var parsed = JSON.parse('{"__proto__": {"polluted": true}, "page": {}}');
        var cp = rd.copyForRender(parsed, ENV);
        assert.equal(Object.getPrototypeOf(cp), Object.prototype, 'the prototype did not change');
        assert.equal(Object.prototype.hasOwnProperty.call(cp, '__proto__'), true, 'an own data property');
        assert.equal(({}).polluted, undefined);
    });

    it('01.7  a prototype holding a setter is never invoked: the copy defines its own property', function () {
        var rd = helper();
        var proto = { set title(v) { throw new Error('the inherited setter ran'); } };
        var src = Object.create(proto);
        Object.defineProperty(src, 'title', { value: 'own', writable: true, enumerable: true, configurable: true });
        src.page = {};
        var copy = rd.copyForRender(src, ENV);
        assert.equal(Object.getOwnPropertyDescriptor(copy, 'title').value, 'own');
    });

    it('01.8  a frozen object gives a writable copy, and the object stays frozen and unchanged', function () {
        var rd = helper();
        var src = Object.freeze({ title: 'F', page: Object.freeze({ data: Object.freeze({ a: 1 }) }) });
        var copy = rd.copyForRender(src, ENV);
        copy.page.data.b = 2;
        copy.added = 1;
        assert.equal(Object.isFrozen(src), true);
        assert.equal('b' in src.page.data, false);
        assert.equal('added' in src, false);
    });

    it('01.9  a cycle terminates and keeps its shape inside the copy; a node met twice is copied once', function () {
        var rd = helper();
        var src = { page: { data: {} } };
        src.page.data.self = src.page.data;
        src.page.back = src;
        var copy = rd.copyForRender(src, ENV);
        assert.equal(copy.page.data.self, copy.page.data);
        assert.equal(copy.page.back, copy);
        assert.equal(src.page.data.self, src.page.data, 'the object keeps its own cycle');
    });

    it('01.10 nodes nested deeper than MAX_DEPTH stay references, and a deep nesting does not exhaust the stack', function () {
        var rd = helper();
        var env = { page: { data: {} } }, src = { page: { data: {} } }, e = env.page.data, s = src.page.data;
        for (var i = 0; i < 200; i++) { e.n = {}; s.n = {}; e = e.n; s = s.n; }
        var copy = rd.copyForRender(src, env);
        var c = copy.page.data, o = src.page.data, depth = 2;
        while (c !== o && c && c.n) { c = c.n; o = o.n; depth++; }
        assert.equal(c, o, 'a node below the cap is shared');
        assert.equal(depth, rd.MAX_DEPTH + 1, 'the first shared node sits just below MAX_DEPTH');
    });

    it('01.11 every shape lib/merge descends into is copied: a drift guard on the isObject replica, whose controls show it can fail', function () {
        var rd = helper();
        class Model { constructor() { this.a = 1; } }
        class List extends Array {}
        function Legacy() { this.a = 1; }
        var ownIsPrototypeOf = { isPrototypeOf: function () { return false; } };
        // [label, a fresh member of that shape]
        var SWEEP = [
            ['a plain object',                                     function () { return { a: 1 }; }],
            ['a null-prototype object',                            function () { var o = Object.create(null); o.a = 1; return o; }],
            ['an object on a plain prototype',                     function () { var o = Object.create({ inherited: 1 }); o.a = 1; return o; }],
            ['an object on a prototype with its own isPrototypeOf', function () { var o = Object.create(ownIsPrototypeOf); o.a = 1; return o; }],
            ['JSON with a "constructor" object',                   function () { return JSON.parse('{"constructor":{},"a":1}'); }],
            ['JSON with a "constructor" null',                     function () { return JSON.parse('{"constructor":null,"a":1}'); }],
            ['Object.create(Object.prototype)',                    function () { var o = Object.create(Object.prototype); o.a = 1; return o; }],
            ['a Proxy of a plain object',                          function () { return new Proxy({ a: 1 }, {}); }],
            ['a class instance with an own constructor key',       function () { var o = new Model(); o.constructor = {}; return o; }],
            ['a class instance',                                   function () { return new Model(); }],
            ['a function-constructor instance',                    function () { return new Legacy(); }],
            ['an array',                                           function () { return [1, 2]; }],
            ['an array subclass',                                  function () { var x = new List(); x.push(1); return x; }],
            ['a Date',                                             function () { return new Date(0); }],
            ['a Map',                                              function () { return new Map(); }],
            ['a Buffer',                                           function () { return Buffer.from('x'); }],
            ['a RegExp',                                           function () { return /x/; }],
            ['a function',                                         function () { return function f() {}; }],
            ['an object with Symbol.toStringTag',                  function () { var o = { a: 1 }; o[Symbol.toStringTag] = 'Thing'; return o; }],
            ['an object with nodeType',                            function () { return { nodeType: 1, a: 1 }; }],
            ['an object with setInterval',                         function () { return { setInterval: function () {}, a: 1 }; }],
            ['a frozen plain object',                              function () { return Object.freeze({ a: 1 }); }]
        ];
        var make = function (label) {
            var row = SWEEP.filter(function (s) { return s[0] === label; })[0];
            assert.ok(row, 'CONTROL: the sweep holds « ' + label + ' »');
            return row[1];
        };
        // whether lib/merge writes into the member (descends) rather than replacing it or throwing
        var mergeDescends = function (makeMember) {
            var member = makeMember(), target = { k: member };
            try { merge(target, { k: { __b988probe__: 1 } }); } catch (e) { return false; }
            return target.k === member && member.__b988probe__ === 1;
        };
        // the shapes merge descends into that a copy function leaves shared
        var underCopies = function (copy) {
            return SWEEP.filter(function (s) {
                if (!mergeDescends(s[1])) { return false; }
                var member = s[1]();
                return copy({ k: member }, { k: { z: 1 } }).k === member;
            }).map(function (s) { return s[0]; });
        };
        assert.equal(mergeDescends(make('a plain object')), true, 'CONTROL: merge descends into a plain object');
        assert.equal(mergeDescends(make('a class instance')), false, 'CONTROL: merge replaces a class instance');
        assert.ok(underCopies(function (x) { return x; }).length > 0, 'CONTROL: a copy that shares everything is caught');
        assert.deepEqual(underCopies(rd.copyForRender), [], 'no shape merge descends into is left shared');
    });
});


// ---------------------------------------------------------------------------
// §02 — the real combine of each delegate, two requests, one object
// ---------------------------------------------------------------------------

describe('#B988 §02 — each delegate\'s combine leaves the action\'s object as it was', function () {

    it('02.0  CONTROL — the extraction: each combine region holds its branch statements, and the copy line when the source has one', function () {
        Object.keys(DELEGATES).forEach(function (key) {
            var r = combineRegion(key);
            if (key === 'swig' || key === 'v1') {
                assert.ok(r.body.indexOf("merge( userData, data['page']['data'] )") > -1, key + ': the layout branch');
                assert.ok(r.body.indexOf('merge(userData, data)') > -1, key + ': the top-level branch');
                assert.ok(r.body.indexOf('setResources(localTemplateConf);') > -1, key + ': setResources');
            } else {
                assert.ok(r.body.indexOf('data.page[pk] = userData.page[pk];') > -1, key + ': the per-key page write');
                assert.ok(r.body.indexOf('data = merge(data, getData());') > -1, key + ': the restore');
            }
            assert.equal(r.hasCopy, renderData !== null, key + ': the copy line is there exactly when the helper is');
        });
        // the controller's own set() and refToObj() build the request data
        var local = { userData: {} };
        makeSet(local, merge)('page.view.url', '/u');
        assert.deepEqual(makeRefToObj(merge)(local.userData), { page: { view: { url: '/u' } } });
    });

    PATHS.forEach(function (p) {
        SHAPES.forEach(function (shape) {
            it('02  ' + p[0] + ', ' + shape[0] + ', passed by two requests: the object is unchanged, and the second request gets what a fresh object gets', function () {
                var shared = shape[1](), snapshot = shape[1]();
                renderFor(p, true, REQ_A, shared);
                var reused = renderFor(p, true, REQ_B, shared);
                var fresh  = renderFor(p, true, REQ_B, shape[1]());
                assert.deepEqual(shared, snapshot, 'the action\'s object is as it was');
                assert.equal(JSON.stringify(reused), JSON.stringify(fresh), 'the reused object renders like a fresh one');
                assert.equal(seen(fresh).token, 'tok-B', 'CONTROL: the fresh render carries the second request\'s CSRF token');
            });
        });
    });

    PATHS.forEach(function (p) {
        SHAPES.forEach(function (shape) {
            it('02  ' + p[0] + ', ' + shape[0] + ', a fresh object: the same data with and without the copy line', function () {
                var withCopy = renderFor(p, true, REQ_A, shape[1]());
                var without  = renderFor(p, false, REQ_A, shape[1]());
                assert.equal(JSON.stringify(withCopy), JSON.stringify(without));
            });
        });
    });

    it('02.C CONTROL — the same blocks without the copy line (the 0.7.5 shape) write into the object, and the second request reads the first one\'s values', function () {
        var leaks = [];
        PATHS.forEach(function (p) {
            SHAPES.forEach(function (shape) {
                var shared = shape[1](), snapshot = shape[1]();
                renderFor(p, false, REQ_A, shared);
                var b = seen(renderFor(p, false, REQ_B, shared));
                var written = JSON.stringify(shared) !== JSON.stringify(snapshot);
                var stale = (p[3] && b.sid === 'sid-A') || b.token === 'tok-A' || b.url === '/app/a';
                if (written) { leaks.push(p[0] + ' / ' + shape[0] + (stale ? ' / stale' : '')); }
            });
        });
        // the swig and v1 paths write every shape; the async and nunjucks paths write an
        // object that carries `gina` (the restore fills the request's Csrf values into it)
        [
            'swig, layout / an object without `page` / stale',
            'swig, layout / an object with its own `page` / stale',
            'swig, layout / an object with its own `session` / stale',
            'swig, layout / an object with `page.view` and `gina` / stale',
            'swig, layoutless / an object without `page` / stale',
            'swig, layoutless / an object with its own `page` / stale',
            'swig, layoutless / an object with its own `session` / stale',
            'swig, layoutless / an object with `page.view` and `gina` / stale',
            'v1, layout / an object without `page` / stale',
            'v1, layout / an object with its own `page` / stale',
            'v1, layout / an object with its own `session` / stale',
            'v1, layout / an object with `page.view` and `gina` / stale',
            'swig-async / an object with `page.view` and `gina` / stale',
            'nunjucks / an object with `page.view` and `gina` / stale',
            'nunjucks-async / an object with `page.view` and `gina` / stale'
        ].forEach(function (expected) {
            assert.ok(leaks.indexOf(expected) > -1, 'the 0.7.5 shape leaks: ' + expected + '\n(leaks: ' + leaks.join(' | ') + ')');
        });
    });

    it('02.F the legacy error flag: an object that carries it keeps it, and the data the template receives does not (swig, v1)', function () {
        [['swig', false], ['swig', true], ['v1', false]].forEach(function (c) {
            var key = c[0], layoutless = c[1], label = key + (layoutless ? ', layoutless' : ', layout');
            var fn = new Function(
                'userData', 'data', 'renderData', 'merge', 'getData', 'setResources', 'localOptions', 'req', 'local',
                'isWithoutLayout', 'isRenderingCustomError', 'Collection', 'JSON', 'template',
                combineRegion(key).body + '\nreturn data;'
            );
            var env = newRequest({ sid: 'sid-A', token: 'tok-A', url: '/app/a', withSession: true, isWithoutLayout: layoutless });
            var shared = { isRenderingCustomError: 'true', status: 404, title: 'shared' };
            var snapshot = JSON.parse(JSON.stringify(shared));
            var data = fn(shared, env.data, renderData, merge, env.getData, env.setResources, env.localOptions,
                env.req, env.local, layoutless, true, Collection, JSON_SHIM, undefined);
            var holder = (data.page && data.page.data && data.page.data.status === 404) ? data.page.data : data;
            assert.deepEqual(shared, snapshot, label + ': the object keeps its keys');
            assert.equal(holder.status, 404, label + ': CONTROL: the template data holds the object\'s values');
            assert.equal('isRenderingCustomError' in holder, false, label + ': the template data lacks the flag');
        });
    });
});


// ---------------------------------------------------------------------------
// §03 — source pins
// ---------------------------------------------------------------------------

describe('#B988 §03 — each delegate copies the action\'s object before its combine', function () {

    Object.keys(DELEGATES).forEach(function (key) {
        it('03  ' + DELEGATES[key] + ': one require of ./render-data, one call, right before the combine', function () {
            var st = STRIPPED[key];
            assert.equal(count(st, "require('./render-data')"), 1, 'one require');
            assert.equal(count(st, COPY_LINE), 1, 'one call');
            var anchor = (key === 'swig' || key === 'v1') ? SWIG_ANCHOR : NJ_ANCHOR;
            var cAt = st.indexOf(COPY_LINE), aAt = st.indexOf(anchor);
            assert.ok(aAt > -1, 'CONTROL: the combine anchor is in the source');
            assert.ok(cAt > -1 && cAt < aAt, 'the call precedes the combine');
            var between = st.slice(cAt + COPY_LINE.length, aAt).replace(/\s+/g, ' ').trim();
            assert.equal(between, FLAG_STRIP[key] || '', 'nothing but the legacy flag strip runs between the call and the combine');
        });
    });

    it('03.6 the helper is server-side only: the browser bundle\'s build.json does not name it', function () {
        var buildJson = path.join(FW, 'core', 'asset', 'plugin', 'src', 'vendor', 'gina', 'build.json');
        var text = fs.readFileSync(buildJson, 'utf8');
        assert.ok(text.indexOf('inline-script') === -1 && text.indexOf('core/controller') === -1, 'CONTROL: no controller module is bundled');
        assert.equal(text.indexOf('render-data'), -1);
    });

    it('03.7 swig and v1 strip the legacy error flag from the copy: one strip, after the call', function () {
        ['swig', 'v1'].forEach(function (key) {
            var st = STRIPPED[key];
            var cAt = st.indexOf(COPY_LINE), dAt = st.indexOf('delete userData.isRenderingCustomError');
            assert.ok(cAt > -1, key + ': CONTROL: the call is in the source');
            assert.equal(count(st, 'delete userData.isRenderingCustomError'), 1, key + ': one strip');
            assert.ok(dAt > cAt, key + ': the strip follows the call');
        });
    });
});
