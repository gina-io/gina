/**
 * #B394 — concurrent `util.promisify(entity.method)` calls must not cross-deliver
 * results or starve a caller.
 *
 * Before the fix the promisify fast-path registered a SCALAR callback slot
 * (`entity._callbacks[shortName] = cb`) plus a per-call `.once` guarded on that
 * slot. Two concurrent calls on the SAME method therefore raced on one slot:
 * the second overwrote the first, the first result to arrive was flushed to the
 * last-registered callback (cross-delivery), and the displaced caller's `.once`
 * found its guard false so its promise NEVER settled (starvation — a hung
 * request with nothing logged). Option B (entity-context calls) had already been
 * given a FIFO queue + a single persistent dispatch listener (#M2); the fast-path
 * kept the scalar. This brings the fast-path to the same FIFO shape.
 *
 * What the #B394 fix guaranteed, and what #B440 (2026-08-30) added:
 *   - the OVERWRITE starvation is eliminated — every concurrent caller's callback
 *     is pushed, never overwritten, so no promise is orphaned by a sibling call
 *     (§03 pins this);
 *   - cross-delivery is CLOSED for in-order completion — when the underlying
 *     operations finish in call order, each caller gets its own result (§02, §04);
 *   - #B394 left a residual for OUT-OF-ORDER completion — FIFO paired callers to
 *     results by ARRIVAL order, so if the operations finished out of call order
 *     the results swapped — and, as #B440 measured, ONE call that never emitted
 *     left its resolver at the head of the FIFO forever, so every later caller
 *     received the NEXT caller's record (that is a different failure from the
 *     overwrite starvation above, which this file's header used to call
 *     "starvation ELIMINATED"). #B440 pairs each emit to the call it came from
 *     (per-call AsyncLocalStorage identity), so §03 now pins "each own record";
 *     the lost-emit shape and the opt-in bound are pinned by
 *     entity-call-identity.test.js.
 *
 * Harness notes:
 *   - Each entity method MUST contain its trigger as a LITERAL string, or
 *     setListeners' source-regex never detects it and the method is left
 *     unwrapped (mirrors entity-arguments.test.js; a closure referencing the
 *     trigger as a variable does not appear in the method's toString()).
 *   - The fast-path binds `this` to its own promise wrapper, so the documented
 *     emit pattern captures the entity in a module-level ref, not `this`.
 *   - Timing-sensitive but ordering-deterministic: node fires timers by absolute
 *     deadline, so a larger delay always completes after a smaller one; every
 *     await is BOUNDED by a settle race (never a bare await), so a regression to
 *     the starving shape FAILS rather than hanging the suite.
 */
'use strict';

// Must be set BEFORE requiring entity.js — isCacheless is captured at module
// load time; with it true the dev-mode per-call clear masks the path under test.
process.env.NODE_ENV_IS_DEV = 'false';

var path = require('path');
var { promisify } = require('util');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var GINA_FW = path.resolve(require('../fw'));
require(GINA_FW + '/helpers');

var ModelUtil = require(GINA_FW + '/lib/model');
var mu        = new ModelUtil();
var ginaMain  = require.resolve(path.resolve(__dirname, '../../'));
var _inherits = require(GINA_FW + '/lib/inherits/src/main.js');
var _merge    = require(GINA_FW + '/lib/merge/src/main.js');

if (!require.cache[ginaMain] || !require.cache[ginaMain].exports.lib) {
    require.cache[ginaMain] = {
        id: ginaMain, filename: ginaMain, loaded: true,
        exports: { lib: { logger: console, helpers: {}, inherits: _inherits, merge: _merge, Model: ModelUtil } }
    };
}

var entityPath = GINA_FW + '/core/model/entity.js';
delete require.cache[require.resolve(entityPath)];
var EntitySuper = require(entityPath);

/**
 * Wires an entity class with a hand-written `getRecord` (carrying its literal
 * trigger) onto a unique EntitySuper static slot.
 * @param {string}   name   - unique prototype name (shortName is derived from it)
 * @param {function} method - getRecord(key), MUST contain its trigger literal
 * @returns {object} the entity instance
 */
function build(name, method) {
    function E() {}
    E = _inherits(E, EntitySuper);
    E.prototype.name     = name;
    E.prototype.model    = 'model_' + name;
    E.prototype.bundle   = 'bundle_' + name;
    E.prototype.database = 'testdb';
    E.prototype.getRecord = method;
    mu.setConnection('bundle_' + name, 'model_' + name, null);
    mu.setModelEntity('bundle_' + name, 'model_' + name, name + 'Entity', E);
    // #B555 — keyed on (bundle, model, className) now, via EntitySuper.key().
    EntitySuper[EntitySuper.key('bundle_' + name, 'model_' + name, name)] = { initialized: true };
    return new E(null, null);
}

/**
 * Awaits `p`, but resolves to `{state:'HUNG'}` if it does not settle within `ms`.
 * A starving promise therefore FAILS an assertion rather than hanging the suite.
 */
function settle(p, ms) {
    return Promise.race([
        p.then(function (v) { return { state: 'resolved', v: v }; },
               function (e) { return { state: 'rejected', e: String(e) }; }),
        new Promise(function (r) { setTimeout(function () { r({ state: 'HUNG' }); }, ms); })
    ]);
}

var HANG_MS = 2500; // generous — only a genuinely starved promise reaches it

// ── entities: shortName = name[0].toLowerCase()+name.slice(1); trigger literal
//    'b394oneEnt#getRecord' etc. must appear verbatim in each method source ────
var LAT1 = {}, ent1 = null;
ent1 = build('B394oneEnt', function getRecord(key) {
    setTimeout(function () { ent1.emit('b394oneEnt#getRecord', false, { key: key, doc: 'doc-of-' + key }); }, LAT1[key]);
});
var LAT2 = {}, ent2 = null;
ent2 = build('B394twoEnt', function getRecord(key) {
    setTimeout(function () { ent2.emit('b394twoEnt#getRecord', false, { key: key, doc: 'doc-of-' + key }); }, LAT2[key]);
});
var LAT3 = {}, ent3 = null;
ent3 = build('B394threeEnt', function getRecord(key) {
    setTimeout(function () { ent3.emit('b394threeEnt#getRecord', false, { key: key, doc: 'doc-of-' + key }); }, LAT3[key]);
});
var LAT4 = {}, ent4 = null;
ent4 = build('B394fourEnt', function getRecord(key) {
    setTimeout(function () { ent4.emit('b394fourEnt#getRecord', false, { key: key, doc: 'doc-of-' + key }); }, LAT4[key]);
});


describe('01 - serial promisify calls each receive their own record (control)', function () {
    it('resolves A then B, each with its own document', async function () {
        LAT1.A = 20; LAT1.B = 20;
        var getRecord = promisify(ent1.getRecord);
        var a = await settle(getRecord('A'), HANG_MS);
        var b = await settle(getRecord('B'), HANG_MS);
        assert.equal(a.state, 'resolved'); assert.equal(a.v.key, 'A');
        assert.equal(b.state, 'resolved'); assert.equal(b.v.key, 'B');
    });
});


describe('02 - concurrent calls, in-order completion: each caller its own record', function () {
    it('A (completes first) and B each receive their own document', async function () {
        // A emits before B → arrival order == call order → FIFO pairs correctly.
        LAT2.A = 20; LAT2.B = 60;
        var getRecord = promisify(ent2.getRecord);
        var pA = getRecord('A');
        var pB = getRecord('B');
        var rA = await settle(pA, HANG_MS);
        var rB = await settle(pB, HANG_MS);
        assert.equal(rA.state, 'resolved', 'caller A never settled');
        assert.equal(rB.state, 'resolved', 'caller B never settled');
        // Pre-fix: the scalar slot handed B caller-A's result. Post-fix: each own.
        assert.equal(rA.v.key, 'A', 'caller A received the wrong record');
        assert.equal(rB.v.key, 'B', 'caller B received the wrong record (cross-delivery)');
    });
});


describe('03 - concurrent calls, out-of-order completion: neither caller starves, each receives its own record', function () {
    it('both promises settle, each with its own document, even when B completes before A', async function () {
        // B emits before A → the pre-#B394 scalar overwrite orphaned caller A: its
        // `.once` guard was false and its promise hung forever. FIFO settles both —
        // and, since #B440 pairs each emit to the call it came from, each caller
        // now receives ITS OWN record (before #B440 the FIFO swapped them here).
        LAT3.A = 60; LAT3.B = 20;
        var getRecord = promisify(ent3.getRecord);
        var pA = getRecord('A');
        var pB = getRecord('B');
        var rA = await settle(pA, HANG_MS);
        var rB = await settle(pB, HANG_MS);
        assert.notEqual(rA.state, 'HUNG', 'caller A starved (promise never settled)');
        assert.notEqual(rB.state, 'HUNG', 'caller B starved (promise never settled)');
        assert.equal(rA.state, 'resolved');
        assert.equal(rB.state, 'resolved');
        // #B440 — the tightened pin: out-of-order completion no longer swaps results
        assert.equal(rA.v.key, 'A', 'caller A received the wrong record (arrival-order pairing)');
        assert.equal(rB.v.key, 'B', 'caller B received the wrong record (arrival-order pairing)');
    });
});


describe('04 - three concurrent callers all settle and the dispatcher cleans up', function () {
    it('all three resolve in order, and the queue + listener drain to zero', async function () {
        LAT4.A = 20; LAT4.B = 45; LAT4.C = 70;
        var getRecord = promisify(ent4.getRecord);
        var trigger = 'b394fourEnt#getRecord';
        var pA = getRecord('A'), pB = getRecord('B'), pC = getRecord('C');
        var rs = [ await settle(pA, HANG_MS), await settle(pB, HANG_MS), await settle(pC, HANG_MS) ];
        assert.ok(rs.every(function (r) { return r.state === 'resolved'; }), 'a caller starved');
        // in-order completion → each its own
        assert.deepEqual(rs.map(function (r) { return r.v.key; }), ['A', 'B', 'C']);
        // dispatcher self-removed and the FIFO slot was deleted on drain
        assert.equal(ent4.listenerCount(trigger), 0, 'the persistent dispatcher did not clean up');
        assert.equal(typeof ent4._callbacks[trigger], 'undefined', 'the FIFO slot was not deleted on drain');
    });
});
