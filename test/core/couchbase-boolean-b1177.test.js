/**
 * #B1177 — couchbase: a `@return {boolean}` statement always settles its caller.
 *
 * Before the fix the connector nulled an empty result, and the boolean branch then read
 * `data.length` (case #2) or `Object.keys(data[0])` (case #1, on a `[null]` row) INSIDE the
 * driver's result callback, before `_deliver()`. Both result handlers' catches only logged, so the
 * caller never settled: no response, no 5xx (the #B412 shape). A failed query took the same branch
 * with `data` null, so every boolean statement, `COUNT(` included, hung on a query error.
 *
 *   §01 controls — the instrument reads correct values (these pass on the pre-fix connector too).
 *   §02 no row   — a SELECT without COUNT( (Promise and callback forms), a COUNT( + GROUP BY, a write
 *                  without RETURNING: each settles `false` (true only when the statement returned a row).
 *   §03 errors   — a failed query of a boolean statement rejects with the query's error, status 500 and
 *                  classified; a `@return {object}` statement rejects the same way (control).
 *   §04 shapes   — a `[null]` row settles `true` (a row came back); a write without `@return` resolves
 *                  `null`, and the callback form receives the driver's metadata as its third argument.
 *   §05 the net  — both result-handler catches settle a call still unsettled: source pins (comments
 *                  stripped with test/strip-comments.js), and the connector compiled with the former
 *                  case-#2 read restored rejects (status 500, classified) instead of hanging.
 *
 * Harness: the real connector against a stub cluster, as test/core/couchbase-concurrency.test.js.
 * Every await is bounded, so a regression to a never-settling shape FAILS instead of hanging.
 */
'use strict';

// Before the connector loads: isCacheless / envIsDev are captured at module load.
process.env.NODE_ENV_IS_DEV = 'false';

var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var Module = require('module');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW       = path.resolve(require('../fw'));
var REPO     = path.resolve(__dirname, '../..');
var CONN_SRC = path.join(FW, 'core/connectors/couchbase/index.js');
var strip    = require('../strip-comments');

// ─── globals bootstrap (mirrors test/core/couchbase-concurrency.test.js) ─────
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
Module.Module._initPaths();
require(FW + '/helpers');
setPath('gina', { core: path.join(FW, 'core') });

var ginaMain  = require.resolve(REPO);
var _inherits = require(FW + '/lib/inherits/src/main.js');
var _merge    = require(FW + '/lib/merge/src/main.js');
var ModelUtil = require(FW + '/lib/model');
if (!require.cache[ginaMain] || !require.cache[ginaMain].exports.lib) {
    require.cache[ginaMain] = {
        id: ginaMain, filename: ginaMain, loaded: true,
        exports: { lib: { logger: console, helpers: {}, inherits: _inherits, merge: _merge, Model: ModelUtil } }
    };
}

// ─── throwaway project: stub SDK + one entity with six .sql-derived methods ───
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1177-'));
fs.mkdirSync(path.join(TMP, 'node_modules/couchbase'), { recursive: true });
fs.writeFileSync(
    path.join(TMP, 'node_modules/couchbase/index.js'),
    "module.exports = { QueryScanConsistency: { NotBounded: 'not_bounded', RequestPlus: 'request_plus' } };\n"
);
fs.mkdirSync(path.join(TMP, 'bundle/models/db/entities'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'bundle/models/db/n1ql/thing'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'bundle/models/db/entities/thing.js'),
    'function Thing(conn) {}\nmodule.exports = Thing;\n');
var SQL = {
    hasRow     : '/**\n * hasRow\n * @param {string} $k\n * @return {boolean}\n */\nSELECT t.id FROM db t WHERE t.k = $k\n',
    hasGroup   : '/**\n * hasGroup\n * @param {string} $k\n * @return {boolean}\n */\nSELECT COUNT(*) AS n FROM db t WHERE t.k = $k GROUP BY t.kind\n',
    touch      : '/**\n * touch\n * @param {string} $k\n * @return {boolean}\n */\nUPDATE db t SET t.seen = true WHERE t.k = $k\n',
    touchNoRet : '/**\n * touchNoRet\n * @param {string} $k\n */\nUPDATE db t SET t.seen = true WHERE t.k = $k\n',
    countRows  : '/**\n * countRows\n * @param {string} $k\n * @return {boolean}\n */\nSELECT COUNT(*) AS n FROM db t WHERE t.k = $k\n',
    getOne     : '/**\n * getOne\n * @param {string} $k\n * @return {object}\n */\nSELECT t.* FROM db t WHERE t.k = $k\n'
};
Object.keys(SQL).forEach(function (m) {
    fs.writeFileSync(path.join(TMP, 'bundle/models/db/n1ql/thing', m + '.sql'), SQL[m]);
});
setPath('project', TMP);
setPath('bundle',  path.join(TMP, 'bundle'));

// ─── cluster stub: rows (and meta), or a rejection, chosen by each arm's unique bound parameter ─
var RESULTS = {
    'c1-one'   : { rows: [ { id: 'x1' } ], meta: {} },
    'c2-zero'  : { rows: [ { n: 0 } ], meta: {} },
    'c3-two'   : { rows: [ { n: 2 } ], meta: {} },
    'c4-none'  : { rows: [], meta: {} },
    'r1-none'  : { rows: [], meta: {} },
    'r2-none'  : { rows: [], meta: {} },
    'r3-none'  : { rows: [], meta: {} },
    'r4-none'  : { rows: [], meta: { metrics: { mutationCount: 1 } } },
    'e1-err'   : { reject: 'stub query failure e1' },
    'e2-err'   : { reject: 'stub query failure e2' },
    'e3-err'   : { reject: 'stub query failure e3' },
    'n1-null'  : { rows: [ null ], meta: {} },
    'w1-none'  : { rows: [], meta: { metrics: { mutationCount: 1 } } },
    'w2-none'  : { rows: [], meta: { metrics: { mutationCount: 1 } } },
    'z1-none'  : { rows: [], meta: {} }
};
var dispatched = {};
var conn = {
    sdk      : { version: 3 },
    _cluster : {
        query: function (q, opts) {
            var params = (opts && Array.isArray(opts.parameters)) ? opts.parameters : [];
            var hay = JSON.stringify(params) + ' ' + String(q);
            var key = Object.keys(RESULTS).filter(function (k) { return hay.indexOf(k) > -1; })[0];
            if (!key) {
                return Promise.reject(new Error('harness: no stub result for ' + hay));
            }
            dispatched[key] = (dispatched[key] || 0) + 1;
            if (RESULTS[key].reject) {
                return Promise.reject(new Error(RESULTS[key].reject));
            }
            return Promise.resolve(JSON.parse(JSON.stringify(RESULTS[key])));
        }
    }
};

/** @inner @param {number} [ms=10] @returns {Promise<void>} */
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 10); }); }

/**
 * Await without ever hanging: a call that never settles reads `{status:'timeout'}`.
 * @inner @param {Promise} p @param {number} [ms=1500]
 * @returns {Promise<{status:string, value?:*, error?:Error}>}
 */
function bounded(p, ms) {
    return Promise.race([
        Promise.resolve(p).then(
            function (v) { return { status: 'ok',  value: v }; },
            function (e) { return { status: 'err', error: e }; }
        ),
        tick(ms || 1500).then(function () { return { status: 'timeout' }; })
    ]);
}

/**
 * Callback form: hand the connector a recording callback, wait the whole window, return every
 * invocation (zero means the call never settled).
 * @inner @param {function(function)} run @param {number} [ms=1500]
 * @returns {Promise<Array<Array>>}
 */
function viaCallback(run, ms) {
    return new Promise(function (resolve) {
        var calls = [];
        run(function () { calls.push(Array.prototype.slice.call(arguments)); });
        setTimeout(function () { resolve(calls); }, ms || 1500);
    });
}

/**
 * Capture console.error while `fn` runs (the connector logs its caught throws there).
 * @inner @param {function(): Promise<*>} fn
 * @returns {Promise<{result: *, lines: Array<string>}>}
 */
async function withErrors(fn) {
    var lines = [];
    var orig  = console.error;
    console.error = function () {
        lines.push(Array.prototype.slice.call(arguments).map(function (a) {
            return (a && a.stack) ? a.stack : String(a);
        }).join(' '));
    };
    try { return { result: await fn(), lines: lines }; } finally { console.error = orig; }
}

var EntitySuper, ent;

before(function () {
    require(FW + '/lib');
    var Couchbase = require(CONN_SRC);
    var entities  = new Couchbase(conn, { database: 'db', model: 'model', bundle: 'bundle', scope: 'local' });
    var mu = new ModelUtil();
    mu.setConnection('bundle', 'model', conn);
    mu.setModelEntity('bundle', 'model', 'Thing', entities.Thing);
    new entities.Thing(conn);
    EntitySuper = require(path.join(FW, 'core/model/entity.js'));
    ent = EntitySuper[EntitySuper.key('bundle', 'model', 'Thing')].instance;
});

after(function () { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('01 - controls (pass on the pre-fix connector too)', function () {
    it('§01a — the entity carries its six statement methods', function () {
        assert.ok(ent, 'entity singleton must be resolvable');
        Object.keys(SQL).forEach(function (m) {
            assert.equal(typeof ent[m], 'function', m + ' must be attached from its .sql file');
        });
    });
    it('§01b — a boolean SELECT returning a row settles true', async function () {
        var r = await bounded(ent.hasRow('c1-one'));
        assert.deepEqual([dispatched['c1-one'], r.status, r.value], [1, 'ok', true]);
    });
    it('§01c — COUNT(*) AS n: [{n:0}] settles false, [{n:2}] true (case #1)', async function () {
        var zero = await bounded(ent.countRows('c2-zero'));
        var two  = await bounded(ent.countRows('c3-two'));
        assert.deepEqual([zero.status, zero.value, two.status, two.value], ['ok', false, 'ok', true]);
    });
    it('§01d — @return {object} with no row settles null', async function () {
        var r = await bounded(ent.getOne('c4-none'));
        assert.deepEqual([r.status, r.value], ['ok', null]);
    });
});

describe('02 - no row: the boolean settles false', function () {
    it('§02a — a SELECT without COUNT(, Promise form', async function () {
        var r = await bounded(ent.hasRow('r1-none'));
        assert.equal(dispatched['r1-none'], 1, 'the query ran');
        assert.equal(r.status, 'ok', 'settles (a timeout is the #B1177 hang)');
        assert.equal(r.value, false);
    });
    it('§02b — the same, explicit callback form: called once, with false', async function () {
        var calls = await viaCallback(function (cb) { ent.hasRow('r2-none', cb); });
        assert.equal(calls.length, 1, 'the callback is invoked exactly once (0 = never settled)');
        assert.ok(!calls[0][0], 'no error');
        assert.equal(calls[0][1], false);
    });
    it('§02c — a COUNT( with GROUP BY matching nothing', async function () {
        var r = await bounded(ent.hasGroup('r3-none'));
        assert.deepEqual([r.status, r.value], ['ok', false]);
    });
    it('§02d — a write without RETURNING returns no row: false', async function () {
        var r = await bounded(ent.touch('r4-none'));
        assert.deepEqual([r.status, r.value], ['ok', false]);
    });
});

describe('03 - a failed query rejects with its error', function () {
    it('§03a — a COUNT( statement', async function () {
        var r = await bounded(ent.countRows('e1-err'));
        assert.equal(r.status, 'err', 'rejects (a timeout is the #B1177 hang on the error path)');
        assert.match(String(r.error && r.error.message), /stub query failure e1/);
        assert.equal(r.error.status, 500);
        assert.equal(typeof r.error.isTransient, 'boolean', 'classified by lib.connectorError');
    });
    it('§03b — a statement without COUNT(', async function () {
        var r = await bounded(ent.hasRow('e2-err'));
        assert.equal(r.status, 'err');
        assert.match(String(r.error && r.error.message), /stub query failure e2/);
        assert.equal(r.error.status, 500);
    });
    it('§03c — control: a @return {object} statement rejects the same way', async function () {
        var r = await bounded(ent.getOne('e3-err'));
        assert.equal(r.status, 'err');
        assert.match(String(r.error && r.error.message), /stub query failure e3/);
    });
});

describe('04 - two more shapes', function () {
    it('§04a — a COUNT( statement returning a [null] row settles true (a row came back)', async function () {
        var r = await bounded(ent.countRows('n1-null'));
        assert.deepEqual([r.status, r.value], ['ok', true]);
    });
    it('§04b — a write without @return resolves null', async function () {
        var r = await bounded(ent.touchNoRet('w1-none'));
        assert.deepEqual([r.status, r.value], ['ok', null]);
    });
    it('§04c — the callback form receives the driver metadata as its third argument', async function () {
        var calls = await viaCallback(function (cb) { ent.touchNoRet('w2-none', cb); });
        assert.equal(calls.length, 1);
        assert.ok(!calls[0][0], 'no error');
        assert.equal(calls[0][1], null);
        assert.deepEqual(calls[0][2], { metrics: { mutationCount: 1 } });
    });
});

describe('05 - the net: a result-handler catch settles a call still unsettled', function () {
    it('§05a — both catches deliver (source pins, comments stripped)', function () {
        var live = strip.all(fs.readFileSync(CONN_SRC, 'utf8'));
        assert.ok(live.indexOf('var _deliver = function') > -1, 'control: live code survives the strip');
        var a = live.indexOf('onQueryCallback(false, rows, meta);');
        var aEnd = live.indexOf('function onError(err)', a);
        assert.ok(a > -1 && aEnd > a, 'onResult and the following onError are found');
        assert.ok(live.slice(a, aEnd).indexOf('_deliver(lib.connectorError.stamp(_err));') > -1,
            "onResult's catch settles the call");
        assert.equal(live.split('onQueryCallback(error);').length - 1, 1, "onError's call occurs once");
        var b = live.indexOf('onQueryCallback(error);');
        assert.ok(live.slice(b, b + 1500).indexOf('_deliver(lib.connectorError.stamp(error));') > -1,
            "onError's catch settles the call with the query's error");
        assert.equal(live.indexOf("typeof(data.length) != 'undefined' && data.length > 0"), -1,
            'the former unguarded read is gone from live code');
    });
    it('§05b — with the former case-#2 read restored, a no-row call rejects instead of hanging', async function () {
        var srcText = fs.readFileSync(CONN_SRC, 'utf8');
        var guarded = 'data = ( Array.isArray(data) && data.length > 0 ) ? true : false';
        assert.equal(srcText.split(guarded).length - 1, 1, 'the guarded read occurs once');
        var restored = srcText.replace(guarded, function () {
            return "data = ( typeof(data.length) != 'undefined' && data.length > 0 ) ? true : false";
        });
        // The whole module, compiled under its own filename: same module scope and relative requires.
        var m = new Module(CONN_SRC, module);
        m.filename = CONN_SRC;
        m.paths    = Module._nodeModulePaths(path.dirname(CONN_SRC));
        m._compile(restored, CONN_SRC);
        var entities2 = new m.exports(conn, { database: 'db', model: 'model2', bundle: 'bundle', scope: 'local' });
        var mu = new ModelUtil();
        mu.setConnection('bundle', 'model2', conn);
        mu.setModelEntity('bundle', 'model2', 'Thing', entities2.Thing);
        new entities2.Thing(conn);
        var ent2 = EntitySuper[EntitySuper.key('bundle', 'model2', 'Thing')].instance;
        assert.ok(ent2 && ent2 !== ent, 'a second entity, built from the restored source');
        var got = await withErrors(function () { return bounded(ent2.hasRow('z1-none')); });
        var r = got.result;
        assert.equal(r.status, 'err', 'the net settles the call (a timeout means the net is gone)');
        // The restored read's TypeError names the failing read; V8 and JavaScriptCore (Bun) word it differently:
        // "Cannot read properties of null (reading 'length')" vs "null is not an object (evaluating 'data.length')".
        assert.match(String(r.error && r.error.message), /reading 'length'|evaluating 'data\.length'/, 'the restored throw reached the caller');
        assert.equal(r.error.status, 500);
        assert.equal(typeof r.error.isTransient, 'boolean', 'classified by lib.connectorError');
        assert.ok(got.lines.some(function (l) { return /onQueryCallbackError/.test(l); }), 'the throw is still logged');
    });
});
