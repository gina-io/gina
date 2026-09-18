/**
 * #B440 — an emit-style entity method that never signals completion must not
 * desynchronise every later caller of that method; each call is paired to ITS
 * OWN completion, regardless of completion order.
 *
 * Before the fix both dispatch paths in `core/model/entity.js` — the
 * `util.promisify` fast-path (detached call: `this[m]` undefined + trailing fn)
 * and Option B (entity-context call returning a native Promise) — pushed one
 * resolver per call onto a FIFO and handed every `<shortName>#<method>` emit to
 * the OLDEST queued resolver. Arrival order carries no call identity, so ONE
 * call that never emits (the canonical shape: a throw inside an un-awaited
 * async callback — swallowed, only `unhandledRejection` sees it) left its
 * resolver at the head forever: from then on every caller received the NEXT
 * caller's record and the last one hung, silently. Where a method reads a
 * user-scoped record that is a wrong-principal delivery, not just a hang.
 *
 * The fix gives every wrapped call an identity: the call runs inside a
 * per-process AsyncLocalStorage store `{ e, r }` and both dispatchers pair an
 * emit to the call it came from (`_dequeueByIdentity`): the resolver of THAT
 * call is spliced out of the queue, a completion for a call that already
 * settled is DROPPED, and only a completion carrying no call context at all
 * falls back to arrival order (logged at debug as `DISPATCH:NO_CONTEXT`).
 * Resolvers forget themselves on settle; the fast-path chains on a returned
 * Promise as Option B always did; an opt-in bound
 * (`settings.json > model.emitTimeout`, ms) rejects a call that never
 * completes with an Error naming the trigger and `#B440`.
 *
 * What this file pins. Red-first measured against the pre-fix bytes
 * (`git show 4a0707451:framework/v0.6.20-alpha.2/core/model/entity.js`, via the
 * lever below): 17 of 22 arms fail there; the 5 that pass are the controls
 * named as such:
 *   §01 serial calls each receive their own record                    (control)
 *   §02 one lost emit among overlapping callers: the others still own theirs
 *   §03 the opt-in bound rejects the dead call and the queue heals
 *   §04 a lone later caller, after a lost emit, is not starved
 *   §05 OUT-OF-order completion pairs each caller to its own record
 *       (the #B394 residual, closed)
 *   §06 the fast-path chains on a returned Promise (it used to discard it)
 *   §07 a late duplicate completion of a settled call is DROPPED, never
 *       handed to the head of the queue nor buffered for the next call
 *       (control: green on the pre-fix bytes too — it pins the DROP rule
 *       against the tempting wrong fix, a resolver that forgets itself on
 *       settle but falls back to shift() when its emit finds it gone; that
 *       variant hands A's late record to B and was measured to do so)
 *   §08 an entity method that calls another entity's method with a direct
 *       callback and emits its own completion from inside it pairs by identity
 *   §09 a completion carrying NO call context pairs by arrival order and says
 *       so at debug level                                    (fallback contract)
 *   §10 `model.emitTimeout` is read through `getConfig` once per entity
 *   §11 the dispatcher and the queue drain after completion (its first arm is
 *       the #B394 cleanup control; the second is red pre-fix)
 *
 * Harness notes:
 *   - Each entity method MUST contain its trigger as a LITERAL string, or
 *     setListeners' source-regex never detects it and the method is left
 *     unwrapped (mirrors entity-promisify-concurrency.test.js).
 *   - The fast-path binds `this` to its own promise wrapper, so the emit pattern
 *     captures the entity in a module-level ref, not `this`.
 *   - Every await is BOUNDED by a settle race, so a regression to the hanging
 *     shape FAILS rather than hanging the suite.
 *   - Red-first lever: `B440_ENTITY_SRC=<file>` compiles that file's text in
 *     place of the tree's entity.js, with the real filename so `require('gina')`
 *     still resolves — used to validate the arms against the pre-fix bytes
 *     (`git show <pre-fix-sha>:framework/v<ver>/core/model/entity.js`).
 */
'use strict';

// Must be set BEFORE requiring entity.js — isCacheless is captured at module
// load time; with it true the dev-mode per-call clear masks the path under test.
process.env.NODE_ENV_IS_DEV = 'false';

var fs   = require('fs');
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

// Captured logger: the fix's diagnostics are LEVELLED (console.warn / console.debug
// on lib.logger), so the stub records them instead of printing.
var warns = [], debugs = [];
var logger = Object.assign({}, console, {
    warn:  function (m) { warns.push(String(m)); },
    debug: function (m) { debugs.push(String(m)); }
});
if (!require.cache[ginaMain] || !require.cache[ginaMain].exports.lib) {
    require.cache[ginaMain] = {
        id: ginaMain, filename: ginaMain, loaded: true,
        exports: { lib: { logger: logger, helpers: {}, inherits: _inherits, merge: _merge, Model: ModelUtil } }
    };
}

var entityPath = GINA_FW + '/core/model/entity.js';
delete require.cache[require.resolve(entityPath)];
var EntitySuper;
if (process.env.B440_ENTITY_SRC) {
    // red-first lever: compile another file's text AS entity.js
    var Module = require('module');
    var m = new Module(entityPath, null);
    m.filename = entityPath;
    m.paths = Module._nodeModulePaths(path.dirname(entityPath));
    m._compile(fs.readFileSync(process.env.B440_ENTITY_SRC, 'utf8'), entityPath);
    EntitySuper = m.exports;
} else {
    EntitySuper = require(entityPath);
}

var REG = {}, n = 0;

/**
 * Wires an entity class with a hand-written `getRecord` onto a unique
 * EntitySuper static slot. The trigger literal is baked into the method source
 * so setListeners detects it.
 * @param {string} body - method body; sees `key`, `ent` (the instance), `T` (its trigger), `REG`, `promisify`
 * @param {object} [injected] - #R3 injection (e.g. a `config` function)
 * @returns {{inst: object, T: string, tag: string}}
 */
function build(body, injected) {
    var tag = 'b440x' + (++n), name = 'B440x' + n + 'Ent';
    function E() {}
    E = _inherits(E, EntitySuper);
    E.prototype.name     = name;
    E.prototype.model    = 'model_' + name;
    E.prototype.bundle   = 'bundle_' + name;
    E.prototype.database = 'testdb';
    E.prototype.getRecord = new Function('REG', 'promisify',
        "return function getRecord(key) { var ent = REG['" + tag + "']; var T = '" + tag + "Ent#getRecord'; " + body + " };")(REG, promisify);
    mu.setConnection('bundle_' + name, 'model_' + name, null);
    mu.setModelEntity('bundle_' + name, 'model_' + name, name + 'Entity', E);
    // #B555 — keyed on (bundle, model, className) now, via EntitySuper.key().
    EntitySuper[EntitySuper.key('bundle_' + name, 'model_' + name, name)] = { initialized: true };
    var inst = new E(null, null, injected || null);
    REG[tag] = inst;
    return { inst: inst, T: tag + 'Ent#getRecord', tag: tag };
}

/**
 * Awaits `p`, but resolves to `{state:'HUNG'}` if it does not settle within `ms`.
 */
function settle(p, ms) {
    return Promise.race([
        Promise.resolve(p).then(function (v) { return { state: 'resolved', v: v }; },
                                function (e) { return { state: 'rejected', e: e }; }),
        new Promise(function (r) { setTimeout(function () { r({ state: 'HUNG' }); }, ms); })
    ]);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var HANG_MS = 2500;  // generous — only a genuinely starved promise reaches it
var STAY_MS = 300;   // window in which a deliberately dead call must still be pending

// the two call forms: fp = util.promisify fast-path (detached), ob = Option B (entity context)
var FORMS = [
    ['fp', function (ent) { return promisify(ent.getRecord); }],
    ['ob', function (ent) { return function (k) { return ent.getRecord(k); }; }]
];

// the #B440 trigger: a throw inside an un-awaited async callback, BEFORE the emit —
// the emit is lost. In a bundle the framework's unhandledRejection net (gna.js) only
// logs the throw; here the fixture swallows it itself, because node:test fails the
// running test on any unhandled rejection (the lost emit is the point, the noise is not).
var LOST_EMIT = "(async function () { await null; var rec = null; if (key === 'LOSE') { rec.missing.field = 1; } ent.emit(T, false, { key: key }); })().catch(function () {});";
// emit after a per-key latency
function latency(map) { return "var d = " + JSON.stringify(map) + "[key]; setTimeout(function () { ent.emit(T, false, { key: key }); }, d);"; }

function own(r, k) { return r.state === 'resolved' && r.v && r.v.key === k; }
function label(r) { return r.state === 'resolved' ? 'resolved(' + (r.v && r.v.key) + ')' : r.state === 'rejected' ? 'rejected(' + String(r.e && r.e.message).slice(0, 60) + ')' : 'HUNG'; }


describe('01 - serial calls each receive their own record (control)', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': A then B, each with its own record', async function () {
            var e = build(latency({ A: 10, B: 10 }));
            var call = form[1](e.inst);
            var a = await settle(call('A'), HANG_MS);
            var b = await settle(call('B'), HANG_MS);
            assert.ok(own(a, 'A'), 'A: ' + label(a));
            assert.ok(own(b, 'B'), 'B: ' + label(b));
        });
    });
});


describe('02 - one lost emit among overlapping callers: every other caller still owns its record', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': LOSE never emits; B, C, D each receive their own record; only LOSE waits', async function () {
            var e = build(LOST_EMIT);
            var call = form[1](e.inst);
            var ps = ['LOSE', 'B', 'C', 'D'].map(call);
            var rs = [];
            for (var i = 0; i < ps.length; i++) rs.push(await settle(ps[i], i === 0 ? STAY_MS : HANG_MS));
            // pre-fix: LOSE resolved with B's record, B with C's, C with D's, D hung
            assert.equal(rs[0].state, 'HUNG', 'the dead call must stay pending without a bound, got ' + label(rs[0]));
            assert.ok(own(rs[1], 'B'), 'B: ' + label(rs[1]));
            assert.ok(own(rs[2], 'C'), 'C: ' + label(rs[2]));
            assert.ok(own(rs[3], 'D'), 'D: ' + label(rs[3]));
            // exactly the dead call's resolver remains queued
            assert.equal((e.inst._callbacks[e.T] || []).length, 1, 'queue must hold only the dead call');
        });
    });
});


describe('03 - the opt-in bound (model.emitTimeout) rejects the dead call and the queue heals', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': LOSE rejects with an Error naming the trigger and #B440; B, C, D own; a warn line is logged', async function () {
            var e = build(LOST_EMIT);
            e.inst._emitTimeout = 150;
            var call = form[1](e.inst);
            var before = warns.length;
            var ps = ['LOSE', 'B', 'C', 'D'].map(call);
            var rs = [];
            for (var p of ps) rs.push(await settle(p, HANG_MS));
            assert.equal(rs[0].state, 'rejected', 'LOSE: ' + label(rs[0]));
            assert.ok(rs[0].e instanceof Error);
            assert.match(rs[0].e.message, /#B440/);
            assert.match(rs[0].e.message, new RegExp(e.T.replace(/[#]/g, '\\#')));
            assert.match(rs[0].e.message, /150 ms/);
            assert.ok(own(rs[1], 'B') && own(rs[2], 'C') && own(rs[3], 'D'), rs.slice(1).map(label).join(' '));
            assert.equal(warns.length, before + 1, 'exactly one warn line for the dead call');
            assert.equal(warns[warns.length - 1], rs[0].e.message, 'the warn line IS the rejection message');
            assert.equal((e.inst._callbacks[e.T] || []).length, 0, 'the queue must be empty once every call settled');
        });
    });
});


describe('04 - a lone later caller after a lost emit is not starved', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': with the bound set, the dead call rejects and a later single call resolves with its own record', async function () {
            var e = build(LOST_EMIT);
            e.inst._emitTimeout = 100;
            var call = form[1](e.inst);
            var dead = await settle(call('LOSE'), HANG_MS);
            assert.equal(dead.state, 'rejected', 'LOSE: ' + label(dead));
            await sleep(50);
            var later = await settle(call('LATER'), HANG_MS);
            // pre-fix: the dead resolver at the head swallowed LATER's emit and LATER hung
            assert.ok(own(later, 'LATER'), 'LATER: ' + label(later));
        });
    });
});


describe('05 - OUT-OF-order completion pairs each caller to its own record (the #B394 residual, closed)', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': B completes before A; A still receives A, B receives B', async function () {
            var e = build(latency({ A: 80, B: 20 }));
            var call = form[1](e.inst);
            var pA = call('A'), pB = call('B');
            var rA = await settle(pA, HANG_MS), rB = await settle(pB, HANG_MS);
            assert.ok(own(rA, 'A'), 'A: ' + label(rA));
            assert.ok(own(rB, 'B'), 'B: ' + label(rB));
        });
    });
});


describe('06 - the fast-path chains on a returned Promise (it used to discard it)', function () {
    it('fp: a method that RETURNS a Promise and never emits — LOSE rejects with its own error, B and C resolve with their own records', async function () {
        var e = build("return new Promise(function (res, rej) { setTimeout(function () { if (key === 'LOSE') return rej(new Error('lost ' + key)); res({ key: key }); }, 10); });");
        var call = promisify(e.inst.getRecord);
        var ps = ['LOSE', 'B', 'C'].map(call);
        var rs = [];
        for (var p of ps) rs.push(await settle(p, HANG_MS));
        assert.equal(rs[0].state, 'rejected', 'LOSE: ' + label(rs[0]));
        assert.equal(rs[0].e.message, 'lost LOSE');
        assert.ok(own(rs[1], 'B'), 'B: ' + label(rs[1]));
        assert.ok(own(rs[2], 'C'), 'C: ' + label(rs[2]));
        assert.equal((e.inst._callbacks[e.T] || []).length, 0, 'no resolver left behind');
    });
});


describe('07 - a late duplicate completion of a settled call is DROPPED', function () {
    it('ob: A settles via its Promise, then emits late while B is pending — B still receives B', async function () {
        // A resolves at 20 ms and ALSO emits at 120 ms; B emits at 200 ms
        var e = build("if (key === 'A') { return new Promise(function (res) { setTimeout(function () { res({ key: 'A' }); }, 20); setTimeout(function () { ent.emit(T, false, { key: 'A' }); }, 120); }); } setTimeout(function () { ent.emit(T, false, { key: key }); }, 200);");
        var pA = e.inst.getRecord('A'), pB = e.inst.getRecord('B');
        var rA = await settle(pA, HANG_MS), rB = await settle(pB, HANG_MS);
        assert.ok(own(rA, 'A'), 'A: ' + label(rA));
        // pre-fix: A's late emit was handed to B (the head of the queue)
        assert.ok(own(rB, 'B'), 'B: ' + label(rB));
    });
    it('fp: A resolves then emits late; a FRESH call made after the late emit is not fed the stale record', async function () {
        var e = build("return new Promise(function (res) { setTimeout(function () { res({ key: key }); setTimeout(function () { ent.emit(T, false, { key: key }); }, 20); }, 5); });");
        var call = promisify(e.inst.getRecord);
        var a = await settle(call('A'), HANG_MS);
        await sleep(60);   // A's late emit lands here, with nothing pending
        var b = await settle(call('B'), HANG_MS);
        assert.ok(own(a, 'A'), 'A: ' + label(a));
        // pre-fix: the late emit was buffered into `_arguments` and flushed to the next call
        assert.ok(own(b, 'B'), 'B: ' + label(b));
        assert.equal(((e.inst._arguments || {})[e.T] || []).length, 0, 'nothing buffered for the next call');
    });
});


describe('08 - a chained entity call with a direct callback still pairs the outer completion by identity', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': A calls B detached with a callback and emits its own completion from inside it; B completes out of order', async function () {
            var b = build(latency({ X: 60, Y: 20 }));
            var a = build("var getB = REG['" + b.tag + "'].getRecord; getB.call(undefined, key, function (err, row) { ent.emit(T, false, { key: key, via: row && row.key }); });");
            var call = form[1](a.inst);
            var pX = call('X'), pY = call('Y');
            var rX = await settle(pX, HANG_MS), rY = await settle(pY, HANG_MS);
            assert.ok(own(rX, 'X') && rX.v.via === 'X', 'X: ' + label(rX) + ' via ' + (rX.v && rX.v.via));
            assert.ok(own(rY, 'Y') && rY.v.via === 'Y', 'Y: ' + label(rY) + ' via ' + (rY.v && rY.v.via));
        });
    });
});


describe('09 - a completion carrying NO call context pairs by arrival order, and says so (fallback contract)', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': completions emitted from a loop started outside every call pair in order and log DISPATCH:NO_CONTEXT', async function () {
            var bus = { pending: [] };
            var e = build("REG['__bus'].pending.push(key);");
            REG.__bus = bus;
            var iv = setInterval(function () { var k = bus.pending.shift(); if (k) e.inst.emit(e.T, false, { key: k }); }, 5);
            iv.unref();
            var before = debugs.length;
            var call = form[1](e.inst);
            var ps = ['A', 'B', 'C'].map(call);
            var rs = [];
            for (var p of ps) rs.push(await settle(p, HANG_MS));
            clearInterval(iv);
            assert.ok(own(rs[0], 'A') && own(rs[1], 'B') && own(rs[2], 'C'), rs.map(label).join(' '));
            var lines = debugs.slice(before).filter(function (m) { return m.indexOf('DISPATCH:NO_CONTEXT ' + e.T) > -1; });
            assert.equal(lines.length, 3, 'one NO_CONTEXT debug line per out-of-context completion');
        });
    });
});


describe('10 - model.emitTimeout is read through getConfig once per entity', function () {
    it('reads settings.model.emitTimeout (ms) via the injected config', function () {
        var e = build(latency({ A: 10 }), { config: function (bundle, conf) { return conf === 'settings' ? { model: { emitTimeout: 1500 } } : {}; } });
        assert.equal(e.inst._emitTimeout, 1500);
    });
    it('absent block -> 0 (no bound, the pre-#B440 liveness contract)', function () {
        var e = build(latency({ A: 10 }), { config: function () { return { region: {} }; } });
        assert.equal(e.inst._emitTimeout, 0);
    });
    it('invalid or non-positive values -> 0', function () {
        ['abc', -5, 0, null].forEach(function (v) {
            var e = build(latency({ A: 10 }), { config: function () { return { model: { emitTimeout: v } }; } });
            assert.equal(e.inst._emitTimeout, 0, 'value ' + String(v));
        });
    });
});


describe('11 - the dispatcher and the queue drain after completion', function () {
    it('ob: three in-order callers all resolve, then the listener and the FIFO slot are gone', async function () {
        var e = build(latency({ A: 20, B: 45, C: 70 }));
        var ps = ['A', 'B', 'C'].map(function (k) { return e.inst.getRecord(k); });
        var rs = [];
        for (var p of ps) rs.push(await settle(p, HANG_MS));
        assert.deepEqual(rs.map(function (r) { return r.v && r.v.key; }), ['A', 'B', 'C']);
        assert.equal(e.inst.listenerCount(e.T), 0, 'the persistent dispatcher did not clean up');
        assert.equal(typeof e.inst._callbacks[e.T], 'undefined', 'the FIFO slot was not deleted on drain');
    });
    it('fp: a timed-out call leaves nothing that blocks the next completion', async function () {
        var e = build("if (key === 'LOSE') { return; } setTimeout(function () { ent.emit(T, false, { key: key }); }, 10);");
        e.inst._emitTimeout = 60;
        var call = promisify(e.inst.getRecord);
        var dead = await settle(call('LOSE'), HANG_MS);
        assert.equal(dead.state, 'rejected', label(dead));
        var next = await settle(call('NEXT'), HANG_MS);
        assert.ok(own(next, 'NEXT'), 'NEXT: ' + label(next));
        assert.equal((e.inst._callbacks[e.T] || []).length, 0);
    });
});
