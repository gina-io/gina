/**
 * #B429 / #B430 / #B431 — couchbase connector: per-call settlement.
 *
 * Before the fix the completion trigger ('N1QL:<entity>#<method>') carried NO call
 * identity and `self` is a process-wide entity singleton (EntitySuper[Name].instance),
 * so the Promise / `await` / `.onComplete()` path settled from a shared
 * `self.once(trigger)` listener. Node fires EVERY listener registered for one `emit`,
 * so the first completion woke every in-flight caller of that method with ITS payload
 * and removed their listeners — a BROADCAST, not arrival-order pairing. Measured on the
 * pre-fix file: two concurrent callers cross-delivered on IN-ORDER completion as well as
 * out-of-order, and a caller could receive another call's error.
 *
 * What each arm exists for:
 *   §01 controls      — the instrument can read CORRECT (serial) and the explicit
 *                       trailing-callback form was ALREADY safe (it settles from
 *                       onQueryCallback's own per-call closure). Both PASS pre-fix, so
 *                       they discriminate a broken harness from a broken connector.
 *   §02 cross-delivery— in-order, out-of-order, and `.onComplete()`; plus the
 *                       authorization-relevant shape (a call keyed on one id must never
 *                       resolve with another id's row).
 *   §03 errors        — an error settles only the call that produced it, in both
 *                       directions across the two call forms.
 *   §04 emit contract — exactly ONE trigger emit per completion. The emit is kept
 *                       deliberately: entity.js's emit override forwards a trigger
 *                       matching the `N1QL:*` allow-list to lib/inspector-events, which
 *                       is what the Inspector's event stream renders.
 *   §05 #B430/#B431   — a callback is invoked exactly once: not twice when it throws
 *                       (#B430), and not twice on a failed query (#B431 — `.catch()`
 *                       returning normally RESOLVES, so a trailing `.then()` ran on every
 *                       error and settled a second time with a bogus empty success).
 *   §06 bulkInsert    — the same defect existed independently on its own dispatch.
 *   §07 source pins   — the mechanisms are gone, not merely bypassed.
 *
 * Harness notes:
 *   - Boots the REAL connector against a controllable cluster stub, so completion ORDER
 *     is chosen by the test rather than raced. The stub exposes only
 *     `QueryScanConsistency` — the sole SDK member the call path reads.
 *   - Ordering is structural: the connector dispatches via `setTimeout(register, 0)`, so
 *     one macrotask tick is required before a query is pending; results are then released
 *     explicitly by the test. No arm depends on wall-clock racing.
 *   - Every await is BOUNDED by a settle race, so a regression to a never-settling shape
 *     FAILS rather than hanging the suite.
 *   - Callback arms CAPTURE every invocation and hold a grace window before asserting, so
 *     a double settle is observable (a resolve-on-first wrapper cannot see one).
 *   - `quiesce()` runs between arms: a promise settled early by cross-delivery leaves its
 *     real query in flight, and pre-fix that late emit lands on the NEXT arm's listener.
 */
'use strict';

// Must be set BEFORE the connector is required — `isCacheless`/`envIsDev` are captured at
// module load, and dev mode re-reads the .sql file on every call.
process.env.NODE_ENV_IS_DEV = 'false';

var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW       = path.resolve(require('../fw'));
var REPO     = path.resolve(__dirname, '../..');
var CONN_SRC = path.join(FW, 'core/connectors/couchbase/index.js');

// ─── globals bootstrap (mirrors test/core/controller.test.js) ────────────────
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(FW + '/helpers');
setPath('gina', { core: path.join(FW, 'core') });

// ─── gina package stub (mirrors test/core/entity-promisify-concurrency.test.js) ──
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

// ─── throwaway project: stub SDK + one entity with one .sql-derived method ───
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b429-'));
fs.mkdirSync(path.join(TMP, 'node_modules/couchbase'), { recursive: true });
fs.writeFileSync(
    path.join(TMP, 'node_modules/couchbase/index.js'),
    "module.exports = { QueryScanConsistency: { NotBounded: 'not_bounded', RequestPlus: 'request_plus' } };\n"
);
fs.mkdirSync(path.join(TMP, 'bundle/models/db/entities'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'bundle/models/db/n1ql/thing'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'bundle/models/db/entities/thing.js'),
    'function Thing(conn) {}\nmodule.exports = Thing;\n');
fs.writeFileSync(path.join(TMP, 'bundle/models/db/n1ql/thing/getRecord.sql'),
    '/**\n * getRecord\n * @param {string} $key\n */\nSELECT t.* FROM db t USE KEYS $key\n');
setPath('project', TMP);
setPath('bundle',  path.join(TMP, 'bundle'));

// ─── controllable cluster stub ───────────────────────────────────────────────
var pending = [];
var conn = {
    sdk      : { version: 3 },
    _cluster : {
        query: function (q, opts) {
            return new Promise(function (resolve, reject) {
                pending.push({ q: String(q), opts: opts, resolve: resolve, reject: reject, done: false });
            });
        }
    }
};

/**
 * Find the in-flight stub query carrying `needle` among its bound parameters.
 *
 * @inner
 * @param {string} needle - a bound parameter value unique to one call
 * @returns {object} the pending query record
 * @throws {Error} when no unsettled query matches (a harness fault, never a silent pass)
 */
function findPending(needle) {
    for (var i = pending.length - 1; i >= 0; i--) {
        var p      = pending[i];
        var params = (p.opts && p.opts.parameters) || [];
        if (!p.done && (params.indexOf(needle) > -1 || p.q.indexOf(needle) > -1)) {
            return p;
        }
    }
    throw new Error('harness: no pending query for ' + needle + ' (pending=' + pending.length + ')');
}
/** Release one in-flight query successfully. @inner @param {string} needle @param {Array} rows @returns {void} */
function ok(needle, rows) { var p = findPending(needle); p.done = true; p.resolve({ rows: rows, meta: {} }); }
/** Fail one in-flight query. @inner @param {string} needle @param {Error} err @returns {void} */
function ko(needle, err)  { var p = findPending(needle); p.done = true; p.reject(err); }
/** @inner @param {number} [ms=10] @returns {Promise<void>} */
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 10); }); }

/**
 * Await a value without ever hanging: a regression that never settles resolves to
 * `{status:'timeout'}` and FAILS its assertion instead of stalling the suite.
 *
 * @inner
 * @param {Promise} p
 * @param {number} [ms=400]
 * @returns {Promise<{status:string, value?:*, error?:Error}>}
 */
function bounded(p, ms) {
    return Promise.race([
        Promise.resolve(p).then(
            function (v) { return { status: 'ok',  value: v }; },
            function (e) { return { status: 'err', error: e }; }
        ),
        tick(ms || 400).then(function () { return { status: 'timeout' }; })
    ]);
}

/**
 * Capture EVERY invocation of a callback-style call, then settle after a grace window so
 * a SECOND (wrong) invocation is observable. A resolve-on-first wrapper cannot see one.
 *
 * @inner
 * @param {function(function)} run - receives the callback to hand to the connector
 * @returns {Promise<{calls: Array<Array>, timedOut: boolean}>}
 */
function captureCalls(run) {
    return new Promise(function (resolve) {
        var calls = [];
        var guard = setTimeout(function () { resolve({ calls: calls, timedOut: true }); }, 3000);
        run(function () {
            calls.push(Array.prototype.slice.call(arguments));
            if (calls.length === 1) {
                setTimeout(function () { clearTimeout(guard); resolve({ calls: calls, timedOut: false }); }, 200);
            }
        });
    });
}

/** @inner @param {string} key @returns {Array<object>} */
function row(key) { return [{ key: key, doc: 'doc-of-' + key }]; }
/** @inner @param {object} r @returns {string} */
function keyOf(r) { return (r.status === 'ok' && r.value && r.value[0]) ? r.value[0].key : r.status; }

var src = fs.readFileSync(CONN_SRC, 'utf8');
var entities, ent, EntitySuper;
var TRIGGER = 'N1QL:thing#getRecord';

/**
 * Flush stragglers and drop leftover listeners between arms.
 * @inner @returns {Promise<void>}
 */
async function quiesce() {
    await tick(40);
    if (ent) { ent.removeAllListeners(TRIGGER); ent.removeAllListeners('N1QL:thing#bulkInsert'); }
    pending.length = 0;
}

before(function () {
    require(FW + '/lib');
    var Couchbase = require(CONN_SRC);
    entities = new Couchbase(conn, { database: 'db', model: 'model', bundle: 'bundle', scope: 'local' });

    var mu = new ModelUtil();
    mu.setConnection('bundle', 'model', conn);
    mu.setModelEntity('bundle', 'model', 'Thing', entities.Thing);
    new entities.Thing(conn);

    // Production hands out the singleton registered at entity.js:491 — the same object the
    // connector falls back to for a detached call. That sharing IS the defect's substrate.
    EntitySuper = require(path.join(FW, 'core/model/entity.js'));
    ent = EntitySuper.Thing.instance;
});

after(function () { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('01 - controls (these PASS on the pre-fix connector too)', function () {

    it('the entity handed to callers is the process-wide singleton', function () {
        assert.ok(ent, 'entity singleton must be resolvable');
        assert.equal(ent, EntitySuper.Thing.instance);
    });

    it('serial calls each receive their own row (the instrument can read CORRECT)', async function () {
        await quiesce();
        var pa = ent.getRecord('s-A'); await tick(); ok('s-A', row('s-A'));
        var ra = await bounded(pa);
        var pb = ent.getRecord('s-B'); await tick(); ok('s-B', row('s-B'));
        var rb = await bounded(pb);
        assert.equal(keyOf(ra), 's-A');
        assert.equal(keyOf(rb), 's-B');
    });

    it('the explicit trailing-callback form was already safe under concurrency', async function () {
        await quiesce();
        var got = {};
        var pa = captureCalls(function (cb) { ent.getRecord('c-A', function (e, d) { cb(); got.A = e ? 'err' : d[0].key; }); });
        var pb = captureCalls(function (cb) { ent.getRecord('c-B', function (e, d) { cb(); got.B = e ? 'err' : d[0].key; }); });
        ok('c-B', row('c-B')); await tick(); ok('c-A', row('c-A'));
        await bounded(Promise.all([pa, pb]), 4000);
        assert.equal(got.A, 'c-A');
        assert.equal(got.B, 'c-B');
    });
});

describe('02 - concurrent callers never cross-deliver', function () {

    it('await, IN-ORDER completion: each caller its own row', async function () {
        await quiesce();
        var pa = ent.getRecord('i-A'), pb = ent.getRecord('i-B'); await tick();
        ok('i-A', row('i-A')); await tick(); ok('i-B', row('i-B'));
        var ra = await bounded(pa), rb = await bounded(pb);
        // Pre-fix this read B->i-A: the first emit woke BOTH listeners. In-order completion
        // was NOT safe, contrary to the emit pattern's documented guarantee.
        assert.equal(keyOf(ra), 'i-A');
        assert.equal(keyOf(rb), 'i-B');
    });

    it('await, OUT-OF-ORDER completion: each caller its own row', async function () {
        await quiesce();
        var pa = ent.getRecord('o-A'), pb = ent.getRecord('o-B'); await tick();
        ok('o-B', row('o-B')); await tick(); ok('o-A', row('o-A'));
        var ra = await bounded(pa), rb = await bounded(pb);
        assert.equal(keyOf(ra), 'o-A');
        assert.equal(keyOf(rb), 'o-B');
    });

    it('.onComplete(), OUT-OF-ORDER completion: each caller its own row', async function () {
        await quiesce();
        var got = {};
        var pa = new Promise(function (r) { ent.getRecord('n-A').onComplete(function (e, d) { got.A = e ? 'err' : d[0].key; r(); }); });
        var pb = new Promise(function (r) { ent.getRecord('n-B').onComplete(function (e, d) { got.B = e ? 'err' : d[0].key; r(); }); });
        await tick(); ok('n-B', row('n-B')); await tick(); ok('n-A', row('n-A'));
        await bounded(Promise.all([pa, pb]));
        assert.equal(got.A, 'n-A');
        assert.equal(got.B, 'n-B');
    });

    it('a call keyed on one id never resolves with another id\'s row', async function () {
        await quiesce();
        // The authorization-relevant shape: an ownership read for one resource resolving
        // with a different resource's row makes the check pass for the wrong principal.
        var pv = ent.getRecord('r-victim'), pa = ent.getRecord('r-attacker'); await tick();
        ok('r-attacker', [{ key: 'r-attacker', owner: 'attacker' }]); await tick();
        ok('r-victim',   [{ key: 'r-victim',   owner: 'victim'   }]);
        var rv = await bounded(pv), ra = await bounded(pa);
        assert.equal(rv.status, 'ok');
        assert.equal(rv.value[0].owner, 'victim', 'the victim-keyed read must carry the victim row');
        assert.equal(ra.value[0].owner, 'attacker');
    });

    it('mixed call forms settle correctly in both orders (no starvation)', async function () {
        await quiesce();
        var gotB = null;
        var pa = ent.getRecord('m-A'); await tick();
        var pb = captureCalls(function (cb) { ent.getRecord('m-B', function (e, d) { cb(); gotB = e ? 'err' : d[0].key; }); });
        ok('m-B', row('m-B')); await tick(); ok('m-A', row('m-A'));
        var ra = await bounded(pa); await bounded(pb, 4000);
        assert.equal(keyOf(ra), 'm-A');
        assert.equal(gotB, 'm-B');
    });
});

describe('03 - an error settles only the call that produced it', function () {

    it('a failing call does not settle a concurrent await caller', async function () {
        await quiesce();
        var pa = ent.getRecord('e-A'), pb = ent.getRecord('e-B');
        // Attach immediately: post-fix A rejects well before we await it, and an unattached
        // rejected promise would trip node's unhandled-rejection detection.
        var wa = bounded(pa, 1500), wb = bounded(pb, 1500);
        await tick();
        ko('e-A', new Error('boom-A')); await tick();
        var early = await bounded(pb, 60);
        assert.equal(early.status, 'timeout', 'B must still be pending after A failed');
        ok('e-B', row('e-B'));
        var ra = await wa, rb = await wb;
        assert.equal(ra.status, 'err');
        assert.match(ra.error.message, /boom-A/);
        assert.equal(keyOf(rb), 'e-B');
    });

    it('an explicit-callback call\'s error does not leak into a concurrent await caller', async function () {
        await quiesce();
        var xErr = null;
        var py = ent.getRecord('l-Y');
        var wy = bounded(py, 1500);
        await tick();
        var px = captureCalls(function (cb) { ent.getRecord('l-X', function (e) { cb(); xErr = e; }); });
        ko('l-X', new Error('boom-X')); await tick();
        var early = await bounded(py, 60);
        assert.equal(early.status, 'timeout', 'Y must not be settled by X\'s failure');
        ok('l-Y', row('l-Y'));
        await bounded(px, 4000);
        var ry = await wy;
        assert.ok(xErr, 'X must receive its own error');
        assert.match(String(xErr.message), /boom-X/);
        assert.equal(keyOf(ry), 'l-Y');
    });
});

describe('04 - exactly one trigger emit per completion (observability contract)', function () {

    /** @inner @param {function} fn @returns {Promise<number>} emits observed while fn ran */
    function countEmits(fn) {
        var n = 0;
        var listener = function () { n++; };
        ent.on(TRIGGER, listener);
        return Promise.resolve(fn()).then(function () {
            ent.removeListener(TRIGGER, listener);
            return n;
        });
    }

    it('a successful await emits once', async function () {
        await quiesce();
        var n = await countEmits(async function () {
            var p = ent.getRecord('m1'); await tick(); ok('m1', row('m1')); await bounded(p); await tick();
        });
        assert.equal(n, 1);
    });

    it('a failed await emits once (pre-fix: three)', async function () {
        await quiesce();
        var n = await countEmits(async function () {
            var p = ent.getRecord('m2'); await tick(); ko('m2', new Error('boom')); await bounded(p); await tick();
        });
        assert.equal(n, 1);
    });

    it('a successful explicit-callback call emits once (pre-fix: never)', async function () {
        await quiesce();
        var n = await countEmits(async function () {
            var p = captureCalls(function (cb) { ent.getRecord('m3', cb); });
            ok('m3', row('m3')); await bounded(p, 4000); await tick();
        });
        assert.equal(n, 1, 'the Inspector bridge must see direct-callback completions too');
    });

    it('the emit reaches lib/inspector-events when the N1QL:* topic is allow-listed', async function () {
        await quiesce();
        var ie = require(path.join(FW, 'lib/inspector-events'));
        var original = ie.emit;
        var calls = [];
        ie.emit = function (name, meta, source) { calls.push({ name: name, meta: meta, source: source }); };
        var previous = process.gina;
        process.gina = { _inspectorEventTopics: ['N1QL:*'] };
        try {
            var p = ent.getRecord('m4'); await tick(); ok('m4', row('m4')); await bounded(p); await tick();
        } finally {
            ie.emit = original;
            process.gina = previous;
        }
        assert.equal(calls.length, 1, 'the emit is a live signal, not dead code');
        assert.equal(calls[0].name, TRIGGER);
        assert.equal(calls[0].source, 'framework');
        assert.equal(calls[0].meta.ok, true);
    });
});

describe('05 - a caller\'s callback is invoked exactly once', function () {

    it('#B430: a callback that THROWS is not re-invoked with the same payload', async function () {
        await quiesce();
        var p = captureCalls(function (cb) {
            ent.getRecord('t1', function () { cb(); throw new Error('cb-throw'); });
        });
        await tick();
        ok('t1', row('t1'));
        var r = await bounded(p, 5000);
        assert.equal(r.status, 'ok');
        assert.equal(r.value.timedOut, false, 'the callback must be invoked at all');
        assert.equal(r.value.calls.length, 1, 'a throwing callback must not run twice');
    });

    it('#B431: a FAILED query settles the callback once, with the error', async function () {
        await quiesce();
        var p = captureCalls(function (cb) { ent.getRecord('t2', cb); });
        ko('t2', new Error('boom-once'));
        var r = await bounded(p, 5000);
        assert.equal(r.status, 'ok');
        assert.equal(r.value.timedOut, false);
        // Pre-fix: two invocations — (Error, null, undefined) then a bogus (false, null, {}),
        // because `.catch()` returning normally RESOLVES and the trailing `.then()` ran.
        assert.equal(r.value.calls.length, 1, 'a failed query must not also report success');
        assert.ok(r.value.calls[0][0] instanceof Error, 'the single settle carries the error');
        assert.match(r.value.calls[0][0].message, /boom-once/);
    });

    it('a SUCCESSFUL query settles the callback once (control)', async function () {
        await quiesce();
        var p = captureCalls(function (cb) { ent.getRecord('t3', cb); });
        ok('t3', row('t3'));
        var r = await bounded(p, 5000);
        assert.equal(r.value.timedOut, false);
        assert.equal(r.value.calls.length, 1);
        assert.equal(r.value.calls[0][0], false, 'success reports no error');
    });
});

describe('06 - bulkInsert carries the same guarantees', function () {

    it('concurrent bulkInsert calls, OUT-OF-ORDER completion: each its own result', async function () {
        await quiesce();
        var p1 = ent.bulkInsert({ k1: { values: { a: 1 } } });
        var p2 = ent.bulkInsert({ k2: { values: { b: 2 } } });
        var w1 = bounded(p1, 1500), w2 = bounded(p2, 1500);
        await tick();
        ok('"k2"', [{ id: 'k2' }]); await tick(); ok('"k1"', [{ id: 'k1' }]);
        var r1 = await w1, r2 = await w2;
        assert.equal(r1.status, 'ok');
        assert.equal(r2.status, 'ok');
        assert.equal(r1.value[0].id, 'k1');
        assert.equal(r2.value[0].id, 'k2');
    });

    it('a failed bulkInsert rejects once, with its own error', async function () {
        await quiesce();
        var settles = [];
        var bp = ent.bulkInsert({ k3: { values: { c: 3 } } });
        bp.then(function () { settles.push('resolved'); }, function (e) { settles.push('rejected:' + e.message); });
        await tick();
        ko('"k3"', new Error('boom-bi'));
        await tick(200);
        assert.equal(settles.length, 1, 'exactly one settlement');
        assert.match(settles[0], /^rejected:/);
        assert.match(settles[0], /boom-bi/);
    });
});

describe('07 - the shared-emitter mechanisms are removed, not merely bypassed (source pins)', function () {

    /**
     * Strip BOTH comment forms so a negative pin cannot match the fix's own narrative.
     * Line comments alone are not enough: the JSDoc on `register()` documents the removed
     * `self.once(trigger)` registration by name, inside a block comment — the documented
     * own-JSDoc trap, which this pin hit for real while it was being written.
     *
     * @inner
     * @param {string} t - raw source
     * @returns {string} source with block and line comments removed
     */
    function live(t) {
        return t
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
    }
    var liveSrc = live(src);

    it('the comment strip is real AND does not eat live code (instrument control)', function () {
        // known comment-only tokens must be gone...
        assert.equal(liveSrc.indexOf('#B430'), -1, 'block/line comments are stripped');
        assert.equal(liveSrc.indexOf('byte-identical copy of the dispatch below'), -1);
        // ...while known live statements survive, so the strip cannot pass vacuously.
        assert.ok(liveSrc.indexOf('var _deliver = function') > -1, 'live code survives the strip');
        assert.ok(liveSrc.indexOf('conn._cluster.query(query, queryOptions)') > -1);
        assert.ok(liveSrc.length > src.length * 0.3, 'the strip must not blank the file');
    });

    it('the raw source still contains the commented-out originals (control: the strip is real)', function () {
        assert.ok(src.indexOf('self.once(trigger') > -1, 'the replaced code is documented in place');
        assert.ok(src.indexOf('_isRegisteredFromProto') > -1, 'the retired flag is explained in place');
    });

    it('no live self.once(trigger) registration remains', function () {
        assert.equal(liveSrc.indexOf('self.once(trigger'), -1,
            'settlement must never come from a listener keyed on entity+method');
    });

    it('the shared _isRegisteredFromProto flag is gone from live code', function () {
        assert.equal(liveSrc.indexOf('_isRegisteredFromProto'), -1,
            'a mutable dispatch flag on the shared entity singleton must not return');
    });

    it('#B431: no dispatch chains .catch(...) into a trailing .then(...)', function () {
        assert.equal(liveSrc.indexOf('.catch( function onError'), -1,
            'error and success handlers must be mutually exclusive branches of one .then()');
        var branched = (liveSrc.match(/\.then\(\s*\n\s*function onResult/g) || []).length;
        assert.equal(branched, 2, 'both dispatch sites (register + bulkInsert) use the two-argument .then()');
    });

    it('settlement flows through the per-call guards', function () {
        assert.match(liveSrc, /var _deliver = function\(err, data, meta\) \{[\s\S]{0,200}?if \(_delivered\)/,
            'the query path settles at most once, per call');
        assert.match(liveSrc, /var _settle = function\(err, data, meta\) \{[\s\S]{0,200}?if \(_settled\)/,
            'bulkInsert settles at most once, per call');
        assert.match(liveSrc, /_mainCallback = _internalCb;/,
            'the Promise path converges on the same per-call closure the callback path uses');
    });
});
