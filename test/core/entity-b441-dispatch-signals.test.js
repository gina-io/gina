/**
 * #B441 — completion-signal accounting for emit-style entity methods, and the wrong-record
 * delivery it closes.
 *
 * A wrapped method that emits its completion trigger MORE THAN ONCE per call settles its
 * caller on the FIRST emit (correct #B440 behaviour, kept). Before this fix every SURPLUS
 * emit took the legacy `setListener` buffering path — the first emit had drained the queue,
 * both dispatchers remove themselves on drain, so the surplus emit found no listener and was
 * pushed into `_arguments`, from where the NEXT detached (`util.promisify`) caller of the
 * method consumed it as its own result (`DISPATCH:BUFFER_CALLBACK`). Measured on a
 * production-mode boot (`isCacheless` false — dev mode's per-call `_arguments` clear masks
 * it): caller B received A's record, so did C, and the buffer grew by one entry per surplus
 * emit. Entity-context (Option B) callers were immune through the #M5 clear.
 *
 * The fix accounts at EMIT time, the one place every completion passes: `_forget` (every
 * settle path of both forms) stamps the call's resolver `_settled`; the entity's `emit`
 * override reads the active per-call store — the store names this trigger and its resolver
 * is `_settled` ⇒ a surplus completion, never buffered, reported ONCE per call at the second
 * emit as `DISPATCH:REPEAT_EMIT` (one late emit after a Promise/timeout settle stays silent);
 * no store, or another trigger's ⇒ `DISPATCH:NO_CONTEXT`, whether or not anything is pending
 * (limb b: the line used to be gated on a non-empty queue, so a consumer's zero was
 * ambiguous); a numbered `<trigger>N` variant of the store's own trigger stays silent.
 *
 * Harness mirrors entity-call-identity.test.js (captured levelled logger, the
 * `B440_ENTITY_SRC` lever to compile another file's bytes AS entity.js for the red-first
 * run, bounded settles). Red-first on the pre-fix bytes: §01 (the benign-shape control) and
 * the ob/single-emit controls of §06 green, every other arm red. No existing test is modified.
 */
'use strict';

process.env.NODE_ENV_IS_DEV = 'false';

var fs   = require('fs');
var path = require('path');
var { promisify } = require('util');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

// location-agnostic: the file was authored parked outside the tracked tree and lives in
// test/core/ now — walk up to the repo root (the dir holding test/fw.js) either way.
var REPO = __dirname;
while (!fs.existsSync(path.join(REPO, 'test', 'fw.js')) && path.dirname(REPO) !== REPO) { REPO = path.dirname(REPO); }
var GINA_FW = path.resolve(require(path.join(REPO, 'test', 'fw')));
require(GINA_FW + '/helpers');

var ModelUtil = require(GINA_FW + '/lib/model');
var mu        = new ModelUtil();
var ginaMain  = require.resolve(REPO);
var _inherits = require(GINA_FW + '/lib/inherits/src/main.js');
var _merge    = require(GINA_FW + '/lib/merge/src/main.js');

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

function build(body) {
    var tag = 'b441x' + (++n), name = 'B441x' + n + 'Ent';
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
    EntitySuper[name] = { initialized: true };
    var inst = new E(null, null, null);
    REG[tag] = inst;
    return { inst: inst, T: tag + 'Ent#getRecord', tag: tag };
}
function settle(p, ms) {
    return Promise.race([
        Promise.resolve(p).then(function (v) { return { state: 'resolved', v: v }; },
                                function (e) { return { state: 'rejected', e: e }; }),
        new Promise(function (r) { setTimeout(function () { r({ state: 'HUNG' }); }, ms); })
    ]);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var HANG_MS = 2500;
var FORMS = [
    ['fp', function (ent) { return promisify(ent.getRecord); }],
    ['ob', function (ent) { return function (k) { return ent.getRecord(k); }; }]
];
function own(r, k) { return r.state === 'resolved' && r.v && r.v.key === k; }
function label(r) { return r.state === 'resolved' ? 'resolved(' + (r.v && r.v.key) + ')' : r.state === 'rejected' ? 'rejected(' + String(r.e && r.e.message).slice(0, 60) + ')' : 'HUNG'; }
function linesSince(before, needle, T) {
    return debugs.slice(before).filter(function (m) { return m.indexOf(needle) > -1 && m.indexOf(T) > -1; });
}
var REPEAT = 'DISPATCH:REPEAT_EMIT', NOCTX = 'DISPATCH:NO_CONTEXT';

// emit at each of the given delays (ms) — N emits for ONE call
function emits(delays) {
    return "var ds = " + JSON.stringify(delays) + "; ds.forEach(function (d) { setTimeout(function () { ent.emit(T, false, { key: key }); }, d); });";
}
// Promise-settled at `res` ms, then ALSO emits at each delay
function promiseThenEmits(res, delays) {
    return "return new Promise(function (ok) { setTimeout(function () { ok({ key: key }); }, " + res + "); " +
           JSON.stringify(delays) + ".forEach(function (d) { setTimeout(function () { ent.emit(T, false, { key: key }); }, d); }); });";
}


describe('01 - CONTROL: the documented benign shape (Promise-settled, ONE late emit) emits NO REPEAT_EMIT line — must be green before AND after', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': one late emit after a Promise settle is silent', async function () {
            var e = build(promiseThenEmits(5, [40]));
            var call = form[1](e.inst), before = debugs.length;
            var r = await settle(call('A'), HANG_MS);
            await sleep(90);
            assert.ok(own(r, 'A'), 'A: ' + label(r));
            assert.equal(linesSince(before, REPEAT, e.T).length, 0, 'the benign shape must stay silent: ' + JSON.stringify(linesSince(before, REPEAT, e.T)));
        });
    });
});


describe('02 - an EMIT-settled call that emits once more: exactly ONE REPEAT_EMIT line (two emits total IS the smell)', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': emit at 10 ms settles; emit at 40 ms is dropped AND reported once', async function () {
            var e = build(emits([10, 40]));
            var call = form[1](e.inst), before = debugs.length;
            var r = await settle(call('A'), HANG_MS);
            await sleep(90);
            assert.ok(own(r, 'A'), 'A: ' + label(r));
            var lines = linesSince(before, REPEAT, e.T);
            assert.equal(lines.length, 1, 'exactly one REPEAT_EMIT line, got ' + lines.length + ': ' + JSON.stringify(lines));
            assert.ok(/settled/.test(lines[0]) && /once|more than once|repeat/i.test(lines[0]), 'the line must say the call already settled and name repeated emission: ' + lines[0]);
        });
    });
});


describe('03 - a Promise-settled call with TWO late emits: exactly ONE line, on the SECOND drop (the first is the benign shape)', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': Promise at 5 ms; emits at 30 and 60 ms ⇒ one line', async function () {
            var e = build(promiseThenEmits(5, [30, 60]));
            var call = form[1](e.inst), before = debugs.length;
            var r = await settle(call('A'), HANG_MS);
            await sleep(120);
            assert.ok(own(r, 'A'), 'A: ' + label(r));
            assert.equal(linesSince(before, REPEAT, e.T).length, 1, 'one line for two late emits: ' + JSON.stringify(linesSince(before, REPEAT, e.T)));
        });
    });
});


describe('04 - the consumer shape: a method emitting its completion ten times per call — caller settles on the FIRST, ONE line total, not nine', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': 10 emits at 10 ms intervals ⇒ own record, exactly 1 REPEAT_EMIT line', async function () {
            var ds = []; for (var i = 0; i < 10; i++) ds.push(10 + 10 * i);
            var e = build(emits(ds));
            var call = form[1](e.inst), before = debugs.length;
            var r = await settle(call('A'), HANG_MS);
            await sleep(180);
            assert.ok(own(r, 'A'), 'A: ' + label(r));
            var lines = linesSince(before, REPEAT, e.T);
            assert.equal(lines.length, 1, 'ONE line for nine drops (once per call, not per drop), got ' + lines.length);
        });
    });
    it('two OVERLAPPING callers on the looping method each get their own record and each is reported once', async function () {
        var ds = []; for (var i = 0; i < 6; i++) ds.push(10 + 10 * i);
        var e = build(emits(ds));
        var call = FORMS[1][1](e.inst), before = debugs.length;
        var pA = call('A'), pB = call('B');
        var rA = await settle(pA, HANG_MS), rB = await settle(pB, HANG_MS);
        await sleep(120);
        assert.ok(own(rA, 'A'), 'A: ' + label(rA));
        assert.ok(own(rB, 'B'), 'B: ' + label(rB));
        assert.equal(linesSince(before, REPEAT, e.T).length, 2, 'one line per call: ' + JSON.stringify(linesSince(before, REPEAT, e.T)));
    });
});


describe('05 - limb (b) REACHABILITY PROBE: a no-context completion arriving with NOTHING pending', function () {
    FORMS.forEach(function (form) {
        it(form[0] + ': after the call fully settles, an emit from outside any call context logs DISPATCH:NO_CONTEXT', async function () {
            var e = build(emits([5]));
            var call = form[1](e.inst);
            var r = await settle(call('A'), HANG_MS);
            assert.ok(own(r, 'A'), 'A: ' + label(r));
            await sleep(30);
            var before = debugs.length;
            // outside every call's async context, queue empty
            e.inst.emit(e.T, false, { key: 'ORPHAN' });
            await sleep(20);
            var lines = linesSince(before, NOCTX, e.T);
            assert.equal(lines.length, 1, 'a no-context completion on an EMPTY queue must be reported (limb b); got ' + lines.length + ' — pre-fix 0: the line was gated on a non-empty queue, and the dispatcher that reached it had already removed itself');
        });
    });
});


function bufLen(e) { return ((e.inst._arguments || {})[e.T] || []).length; }

describe('06 - the wrong-record delivery: a surplus completion is never buffered for the next caller', function () {
    it('fp: three sequential detached callers of a 3-emit method each receive their OWN record, and nothing is buffered between them', async function () {
        var e = build(emits([10, 20, 30]));
        var call = FORMS[0][1](e.inst), bufs = [], rs = [];
        for (var k of ['A', 'B', 'C']) { rs.push(await settle(call(k), HANG_MS)); await sleep(80); bufs.push(bufLen(e)); }
        // pre-fix (production mode): A own, then B and C both resolved with A's record via
        // DISPATCH:BUFFER_CALLBACK, and the buffer read 2, 4, 6 — one entry per surplus emit
        assert.ok(own(rs[0], 'A'), 'A: ' + label(rs[0]));
        assert.ok(own(rs[1], 'B'), 'B received ' + label(rs[1]) + ' — the surplus emit of A was handed to the next caller');
        assert.ok(own(rs[2], 'C'), 'C received ' + label(rs[2]));
        assert.deepEqual(bufs, [0, 0, 0], '_arguments must stay empty: a settled call\'s surplus completion is discarded, not buffered — got ' + JSON.stringify(bufs));
        assert.equal(e.inst.listenerCount(e.T), 0, 'the dispatcher still self-removes on drain (the #B440 lifecycle is untouched)');
    });
    it('ob CONTROL: the entity-context form was already immune (#M5 clears the buffer per call) — must be green before AND after', async function () {
        var e = build(emits([10, 20, 30]));
        var call = FORMS[1][1](e.inst), rs = [];
        for (var k of ['A', 'B', 'C']) { rs.push(await settle(call(k), HANG_MS)); await sleep(80); }
        assert.ok(own(rs[0], 'A') && own(rs[1], 'B') && own(rs[2], 'C'), rs.map(label).join(' '));
    });
    it('single-emit CONTROL: a well-behaved method buffers nothing on either form — must be green before AND after', async function () {
        var e = build(emits([10]));
        for (var form of FORMS) { var call = form[1](e.inst); var r = await settle(call('A'), HANG_MS); await sleep(40); assert.ok(own(r, 'A'), form[0] + ': ' + label(r)); assert.equal(bufLen(e), 0, form[0] + ': buffer'); }
    });
});


describe('07 - the numbered loop idiom (`<trigger>1`, `<trigger>2`) is not a completion and stays silent', function () {
    it('ob: numbered variants of the call\'s own trigger log no NO_CONTEXT line', async function () {
        // digit-free names: the idiom keys on `type.replace(/[0-9]/g, "")`, so a tag carrying digits
        // could never reach it (the build() tags do — hence the dedicated entity here)
        function NvEnt() {}
        var E = _inherits(NvEnt, EntitySuper), name = 'NvidiomEnt';
        E.prototype.name = name; E.prototype.model = 'model_' + name; E.prototype.bundle = 'bundle_' + name; E.prototype.database = 'testdb';
        E.prototype.getRecord = new Function('REG', "return function getRecord(key) { var ent = REG['nvidiom']; var T = 'nvidiomEnt#getRecord'; " +
            // the alias handler the numbered emit reaches applies a queue ARRAY and throws (pre-existing, tracked separately) — swallow it, the arm is about the log line
            "setTimeout(function () { try { ent.emit(T + '1', false, { key: key }); } catch (x) {} }, 5); setTimeout(function () { ent.emit(T, false, { key: key }); }, 20); };")(REG);
        mu.setConnection('bundle_' + name, 'model_' + name, null);
        mu.setModelEntity('bundle_' + name, 'model_' + name, name + 'Entity', E);
        EntitySuper[name] = { initialized: true };
        var inst = new E(null, null, null); REG.nvidiom = inst;
        var T = 'nvidiomEnt#getRecord', before = debugs.length;
        var r1 = await settle(inst.getRecord('A'), HANG_MS); await sleep(40);
        var r2 = await settle(inst.getRecord('B'), HANG_MS); await sleep(40);   // second call: `T1` is now registered in _triggers
        assert.ok(own(r1, 'A') && own(r2, 'B'), label(r1) + ' ' + label(r2));
        assert.equal(linesSince(before, NOCTX, T).length, 0, 'a numbered variant of the call\'s own trigger must not read as a no-context completion: ' + JSON.stringify(linesSince(before, NOCTX, T)));
    });
});
