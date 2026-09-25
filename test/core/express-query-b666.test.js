'use strict';
/**
 * #B666 — engine:"express" on Express 5: one DELETE, or one POST/PUT/PATCH without a
 * body, killed the bundle. The `query` ACCESSOR on the per-app request prototype
 * closes it at the engine.
 *
 * Mechanism (measured live on express@5.2.1 with express@4.22.3 and isaac controls,
 * on the released v0.6.33 tree and on develop): Express 5 defines `req.query` as a
 * prototype GETTER, which #B211 shadowed with a writable own DATA property holding
 * `undefined` on `app.request` so the pipeline's strict-mode `request.query =`
 * assignments keep working. That shadow read `undefined` for every request until
 * something assigned it, and the pipeline assigns it only on its GET and HEAD
 * branches. Its DELETE branch and the empty-body fallback of the POST/PUT/PATCH
 * branches read `request.query` raw through `ownCount()`, which re-raises the
 * shorthand's TypeError on `undefined` by design (#B546) — inside the request's
 * `end` handler, with nothing catching it: `uncaughtException` → SIGTERM → the
 * bundle is gone. Express 4 assigns `req.query` as an own property from its
 * auto-mounted query middleware on every request, so it never hit this.
 *
 * Fix (server.express.js): the data property becomes an accessor. On Express 5 the
 * getter materialises the engine's OWN parse (its getter beneath the shadow, so the
 * app's `query parser` setting is honoured at read time) as a PLAIN, writable own
 * property on the first read — `querystring.parse` (the `simple` default) returns
 * a null-prototype object, and gina's `Object.prototype.count()` helper, which the
 * documented `req.get.count()` / `req.delete.count()` call, cannot iterate one —
 * and the setter stores an assigned value the same way. On Express 4 (no getter on
 * the chain) the getter answers `undefined` and materialises nothing, the setter
 * stores: the #B211 data property's behaviour byte for byte. No layer is
 * registered and no router is created at engine construction — the draft that did
 * would have frozen `strict routing` / `case sensitive routing` (both majors) and
 * Express 4's query parser before a consumer's `app.set(...)` in onInitialize.
 *
 * Express is consumer-provided by design (never a dependency), so this suite cannot
 * require it: the helpers are extracted from the SHIPPED adapter source and run
 * against a pure-node replica of Express 5's request prototype (its getter body
 * transcribed from lib/request.js:217) and of Express 4's (no getter). The helpers
 * close over nothing but globals — asserted below, so the lifted scope is faithful.
 * The LIVE A/B boot smoke on real express 4 + 5 installs
 * (todo/b659-harness/repro-b666.sh) is the acceptance instrument.
 *
 * Red-first: GINA_EXPRESS_ADAPTER_SRC=<pre-fix server.express.js> reds every pin and
 * every behavioural arm except the pre-fix controls.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var http = require('http');
var url = require('url');
var querystring = require('querystring');

var FW = require('../fw');
var ginaRoot = path.resolve(__dirname, '../..');
// the bags must serve gina's own count() helper — install it exactly as a bundle does
require(path.join(ginaRoot, 'utils', 'prototypes'));

var SOURCE  = process.env.GINA_EXPRESS_ADAPTER_SRC || path.join(FW, 'core', 'server.express.js');
var ADAPTER = fs.readFileSync(SOURCE, 'utf8');
var SERVER  = fs.readFileSync(path.join(FW, 'core', 'server.js'), 'utf8');
var ISAAC   = fs.readFileSync(path.join(FW, 'core', 'server.isaac.js'), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(function (l) { return !/^\s*\/\//.test(l); })
        .join('\n');
}
var ADAPTER_ST = stripComments(ADAPTER);

var INSTALL = "Object.defineProperty(app.request, 'query', queryAccessorDescriptor(app.request));";

// ---------------------------------------------------------------------------
// extraction — the two module-scope helpers, from `function toPlainQuery(` to the
// column-0 brace closing `queryAccessorDescriptor`
// ---------------------------------------------------------------------------
function extractHelpers(src) {
    var start = src.indexOf('function toPlainQuery(');
    assert.ok(start > -1, 'extraction control: toPlainQuery must be defined in the adapter');
    var qad = src.indexOf('function queryAccessorDescriptor(', start);
    assert.ok(qad > -1, 'extraction control: queryAccessorDescriptor must follow toPlainQuery');
    var end = src.indexOf('\n}\n', qad);
    assert.ok(end > -1, 'extraction control: queryAccessorDescriptor must close at column 0');
    return src.slice(start, end + 2);
}

function loadHelpers() {
    var block = extractHelpers(ADAPTER);
    var active = stripComments(block);
    // lifted-scope control: a `new Function` body captures NO closure, so the block
    // must reference no module-scope binding of the adapter (#B364 lesson)
    ['lib.', 'console.', 'express(', 'fs.', 'merge(', 'inherits(', 'isDev', 'options.'].forEach(function (needle) {
        assert.equal(active.indexOf(needle), -1, 'the helpers must not reference the adapter binding `' + needle + '`');
    });
    var fn = new Function("'use strict';\n" + block +
        '\nreturn { toPlainQuery: toPlainQuery, queryAccessorDescriptor: queryAccessorDescriptor };');
    return fn();
}

// the shipped ownCount — the pipeline's counting site (#B546), extracted from server.js
function loadOwnCount() {
    var start = SERVER.indexOf('function ownCount(container) {');
    assert.ok(start > -1, 'extraction control: ownCount must be defined in server.js');
    var end = SERVER.indexOf('\n}\n', start);
    var fn = new Function("'use strict';\n" + SERVER.slice(start, end + 2) + '\nreturn ownCount;');
    return fn();
}

// ---------------------------------------------------------------------------
// fixtures — Express 5 (prototype getter, lib/request.js:217) and Express 4
// (no getter; its query middleware assigns an own property), each with the
// shipped accessor installed on the per-app request prototype
// ---------------------------------------------------------------------------
function express5App(parserFn) {
    var app = {
        settings: { 'query parser fn': parserFn },
        get: function (k) { return this.settings[k]; }
    };
    var reqProto = Object.create(http.IncomingMessage.prototype);
    Object.defineProperty(reqProto, 'query', {
        configurable: true,
        enumerable: true,
        get: function query() {
            var queryparse = this.app.get('query parser fn');
            if (!queryparse) {
                return Object.create(null);  // "parsing is disabled"
            }
            return queryparse(url.parse(this.url).query || '');
        }
    });
    app.request = Object.create(reqProto, {
        app: { configurable: true, enumerable: true, writable: true, value: app }
    });
    return app;
}

function express4App() {
    var app = { settings: {}, get: function (k) { return this.settings[k]; } };
    app.request = Object.create(http.IncomingMessage.prototype, {
        app: { configurable: true, enumerable: true, writable: true, value: app }
    });
    return app;
}

function install(H, app) {
    Object.defineProperty(app.request, 'query', H.queryAccessorDescriptor(app.request));
    return app;
}

// the #B211 shape, for the pre-fix control
function installOldShadow(app) {
    Object.defineProperty(app.request, 'query', {
        value: undefined, writable: true, configurable: true, enumerable: false
    });
    return app;
}

function makeReq(app, reqUrl) {
    var req = Object.create(app.request);
    req.url = reqUrl;
    return req;
}

// ---------------------------------------------------------------------------
describe('express-query-b666 §01 — adapter source pins', function () {

    it('strip validity: the stripped adapter still installs a property named query on app.request', function () {
        assert.ok(ADAPTER_ST.indexOf("Object.defineProperty(app.request, 'query'") > -1);
    });

    it('the accessor is installed on the per-app request prototype, exactly once, from the descriptor factory', function () {
        assert.ok(ADAPTER_ST.indexOf(INSTALL) > -1, 'the install site must use queryAccessorDescriptor');
        assert.equal(ADAPTER_ST.split(INSTALL).length - 1, 1, 'exactly one install');
    });

    it('negative: the #B211 data-property shadow is no longer ACTIVE (it survives only as the `// was:` line)', function () {
        assert.equal(ADAPTER_ST.indexOf("Object.defineProperty(app.request, 'query', {"), -1,
            'an inline data-property shadow would leave request.query undefined on Express 5 again');
        assert.ok(ADAPTER.indexOf('value: undefined, writable: true, configurable: true, enumerable: false });') > -1,
            'raw-guard: the retired shape is documented in the `// was:` comment');
    });

    it('the descriptor is an accessor: get + set, configurable, not a value/writable pair', function () {
        var block = stripComments(extractHelpers(ADAPTER));
        var ret = block.slice(block.lastIndexOf('return {'));
        assert.ok(ret.indexOf('get: function () {') > -1, 'a getter');
        assert.ok(ret.indexOf('set: function (value) {') > -1, 'a setter');
        assert.ok(ret.indexOf('configurable: true') > -1);
        assert.ok(ret.indexOf('enumerable: false') > -1);
    });

    it('the getter yields undefined without a native getter and never materialises on the prototype itself', function () {
        var block = stripComments(extractHelpers(ADAPTER));
        assert.ok(block.indexOf('if ( !nativeGetter || this === appRequest ) {') > -1);
        assert.ok(block.indexOf('return undefined;') > -1);
    });

    it('getter and setter materialise a WRITABLE own data property on the request (strict-mode assignment survives)', function () {
        var block = stripComments(extractHelpers(ADAPTER));
        var mat = block.slice(block.indexOf('var materialise = function (req, query) {'));
        mat = mat.slice(0, mat.indexOf('return query;'));
        assert.ok(mat.indexOf("Object.defineProperty(req, 'query', {") > -1);
        assert.ok(/writable:\s*true/.test(mat) && /configurable:\s*true/.test(mat) && /enumerable:\s*true/.test(mat));
        assert.ok(block.indexOf('return materialise(this, toPlainQuery(nativeGetter.call(this)));') > -1, 'the getter calls the ENGINE getter on the request');
        assert.ok(block.indexOf('materialise(this, value);') > -1, 'the setter stores through the same path');
    });

    it('the copy is keyed on the null prototype and built with defineProperty (no __proto__ setter)', function () {
        var block = stripComments(extractHelpers(ADAPTER));
        assert.ok(block.indexOf('Object.getPrototypeOf(parsed) !== null') > -1, 'a plain result is handed back untouched');
        assert.ok(block.indexOf('Object.defineProperty(plain, key, {') > -1, 'own keys are defined, never assigned');
    });

    it('negative: the adapter registers NO layer at engine construction (an early app.use would create the router before onInitialize)', function () {
        assert.equal(ADAPTER_ST.indexOf('app.use('), -1);
    });

    it('the helpers close over nothing but globals (lifted-scope control fires)', function () {
        loadHelpers();
    });
});

// ---------------------------------------------------------------------------
describe('express-query-b666 §02 — the SHIPPED accessor, driven on both Express shapes', function () {

    it('Express 5, default parser: the first read materialises a PLAIN, own, countable bag', function () {
        var H = loadHelpers();
        var app = install(H, express5App(querystring.parse));
        var req = makeReq(app, '/app/getonly?x=1&y=2');
        assert.ok(!Object.prototype.hasOwnProperty.call(req, 'query'), 'nothing materialised before the first read');
        var q = req.query;
        assert.deepEqual(Object.assign({}, q), { x: '1', y: '2' });
        assert.equal(Object.getPrototypeOf(q), Object.prototype, 'a plain object, not the null-prototype parse');
        assert.ok(Object.prototype.hasOwnProperty.call(req, 'query'), 'materialised as an OWN property of the request');
        assert.equal(req.query, q, 'the second read returns the materialised object');
        assert.equal(req.query.count(), 2, 'the documented count() works');
    });

    it('CONTROL — pre-fix shape (#B211 data property): Express 5 reads undefined and the pipeline site throws', function () {
        var ownCount = loadOwnCount();
        var app = installOldShadow(express5App(querystring.parse));
        var req = makeReq(app, '/app/delstatic?x=1');
        assert.equal(req.query, undefined, 'the #B211 shadow alone reads undefined');
        assert.throws(function () { ownCount(req.query); }, function (err) {
            return err instanceof TypeError && /count/.test(err.message);
        }, 'the DELETE branch shape `ownCount(request.query)` re-raises the shorthand TypeError — the production stack');
    });

    it('the pipeline site no longer throws — with the shipped ownCount, with and without a query', function () {
        var H = loadHelpers();
        var ownCount = loadOwnCount();
        var app = install(H, express5App(querystring.parse));
        assert.equal(ownCount(makeReq(app, '/app/delstatic?x=1').query), 1);
        assert.equal(ownCount(makeReq(app, '/app/delstatic').query), 0, 'an empty query is an EMPTY bag, never undefined');
    });

    it('the engine parser is resolved at READ time (a `query parser` set after the install is honoured)', function () {
        var H = loadHelpers();
        var calls = 0;
        var app = install(H, express5App(querystring.parse));
        app.settings['query parser fn'] = function (str) { calls++; return { custom: str }; };
        var req = makeReq(app, '/app/x?x=1');
        assert.deepEqual(req.query, { custom: 'x=1' });
        assert.equal(calls, 1);
        req.query; req.query;
        assert.equal(calls, 1, 'materialised once — later reads never re-parse');
    });

    it('a value assigned BEFORE any read is stored and the engine parser never runs', function () {
        var H = loadHelpers();
        var calls = 0;
        var app = install(H, express5App(function (str) { calls++; return querystring.parse(str); }));
        var req = makeReq(app, '/app/x?x=1');
        var pre = { pre: '1' };
        req.query = pre;
        assert.equal(req.query, pre);
        assert.equal(calls, 0);
    });

    it('strict-mode assignment keeps working after materialisation (the pipeline sites)', function () {
        var H = loadHelpers();
        var app = install(H, express5App(querystring.parse));
        var req = makeReq(app, '/app/x?x=1');
        assert.equal(req.query.x, '1');
        req.query = undefined;          // server.js cleanup shape
        req.query = { merged: true };   // server.js GET/HEAD merge shape
        assert.deepEqual(req.query, { merged: true });
    });

    it('WHY the plain copy: a null-prototype parse has no count(), and gina\'s helper under-counts it to 0', function () {
        var H = loadHelpers();
        var raw = querystring.parse('a=1&b=2');
        assert.equal(Object.getPrototypeOf(raw), null, 'fixture control: querystring.parse is null-prototype');
        assert.equal(typeof raw.count, 'undefined', 'the documented req.get.count() would not exist');
        assert.equal(Object.prototype.count.call(raw), 0, 'and the shipped helper reads 0 for two keys (its hasOwnProperty call throws, caught)');
        var plain = H.toPlainQuery(raw);
        assert.equal(plain.count(), 2);
        assert.deepEqual(Object.assign({}, plain), { a: '1', b: '2' });
    });

    it('a client key named __proto__ becomes an own data property of the bag — no prototype is touched', function () {
        var H = loadHelpers();
        var app = install(H, express5App(querystring.parse));
        var req = makeReq(app, '/app/x?__proto__=evil&a=1');
        var q = req.query;
        assert.equal(Object.getPrototypeOf(q), Object.prototype);
        assert.ok(Object.prototype.hasOwnProperty.call(q, '__proto__'), 'the key survives as an own property');
        assert.equal(({}).evil, undefined, 'Object.prototype is untouched');
        assert.equal(q.count(), 2);
    });

    it('parsing disabled (`query parser` false): an empty plain bag', function () {
        var H = loadHelpers();
        var app = install(H, express5App(undefined));
        var req = makeReq(app, '/app/x?x=1');
        assert.deepEqual(Object.assign({}, req.query), {});
        assert.equal(req.query.count(), 0);
    });

    it('an `extended` or custom parser that returns an ordinary object is handed back by identity', function () {
        var H = loadHelpers();
        var marker = { custom: true };
        var app = install(H, express5App(function () { return marker; }));
        assert.equal(makeReq(app, '/app/x?x=1').query, marker);
    });

    it('reading query on the prototype itself materialises nothing there — later requests still work', function () {
        var H = loadHelpers();
        var app = install(H, express5App(querystring.parse));
        assert.equal(app.request.query, undefined);
        var d = Object.getOwnPropertyDescriptor(app.request, 'query');
        assert.equal(typeof d.get, 'function', 'the accessor is intact on the prototype');
        assert.deepEqual(Object.assign({}, makeReq(app, '/app/x?z=9').query), { z: '9' });
    });

    it('Express 4 shape: the read yields undefined and materialises nothing, so the query middleware assigns as before', function () {
        var H = loadHelpers();
        var app = install(H, express4App());
        var req = makeReq(app, '/app/x?x=1');
        assert.equal(req.query, undefined);
        assert.ok(!Object.prototype.hasOwnProperty.call(req, 'query'), 'no own property materialised on the read');
        // Express 4 lib/middleware/query.js: if (!req.query) { req.query = queryparse(val, opts) }
        var fromQueryMiddleware = querystring.parse('x=1');
        if (!req.query) { req.query = fromQueryMiddleware; }
        assert.equal(req.query, fromQueryMiddleware, 'the assignment stores by identity');
        assert.ok(Object.prototype.hasOwnProperty.call(req, 'query'));
        var d = Object.getOwnPropertyDescriptor(req, 'query');
        assert.ok(d.writable && d.configurable && d.enumerable, 'a plain writable own property, as the #B211 shadow produced');
    });

    it('toPlainQuery: non-objects become an empty bag; null too', function () {
        var H = loadHelpers();
        assert.deepEqual(H.toPlainQuery(undefined), {});
        assert.deepEqual(H.toPlainQuery(null), {});
        assert.deepEqual(H.toPlainQuery('a=1'), {});
    });
});

// ---------------------------------------------------------------------------
describe('express-query-b666 §03 — the neighbouring contracts are unchanged (tripwires)', function () {

    it('isaac still seeds request.query with an object before its own parse', function () {
        assert.ok(ISAAC.indexOf('request.query   = {};') > -1,
            'isaac parses the query itself into a plain object — the engine-side contract the pipeline relies on');
    });

    it('the pipeline sites this fix protects still read the query raw (pinned by #B546, not widened here)', function () {
        var st = stripComments(SERVER);
        assert.ok(st.indexOf('if ( ownCount(request.query) > 0 ) {') > -1, 'the DELETE branch');
        assert.ok(st.indexOf("if (ownCount(request.body) == 0 && typeof(request.query) != 'string' && ownCount(request.query) > 0 ) {") > -1, 'the empty-body fallback');
    });
});
