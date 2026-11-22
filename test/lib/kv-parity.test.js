/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * #KV1 slice 2 — the THREE-BACKEND PARITY MATRIX.
 *
 * `lib/kv` advertises one contract satisfied by interchangeable backends. That
 * is a claim, and this file is what makes it a measurement: ONE spec, written
 * once, executed against every backend through the REAL facade —
 *
 *   - `memory` — the in-process default (`lib/kv`'s own store);
 *   - `redis`  — `core/connectors/redis/lib/kv-store.js` over the fake driver;
 *   - `sqlite` — `core/connectors/sqlite/lib/kv-store.js` over a REAL
 *                `node:sqlite` file in a temp dir (no mock — the driver is
 *                built in).
 *
 * A backend that diverges fails the shared spec rather than quietly behaving
 * differently in production, which is the failure mode a per-backend test
 * suite cannot catch: each suite passes, and the CONTRACT is still not one
 * contract.
 *
 * ⚠️ Instrument validity: a spec that all three pass could be a spec that
 * asserts nothing. §09 is the control — it drives a DELIBERATELY BROKEN
 * backend through the same spec helpers and asserts they reject it, so the
 * matrix cannot pass vacuously.
 *
 * ⚠️ Honest divergence, asserted rather than papered over: the overflow
 * BOUNDARY differs (memory and sqlite enforce JavaScript's safe-integer range,
 * a real redis enforces int64). The shared spec asserts the observable
 * contract — an overflow REJECTS — not the numeric boundary. See §07.
 *
 * Time: TTL cases use `node:test` mock timers (`Date` included), which every
 * backend reads through `Date.now()`, so no test waits on wall-clock.
 *
 * Run: node --test test/lib/kv-parity.test.js
 */

var { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
var assert   = require('node:assert/strict');
var path     = require('path');
var fs       = require('fs');
var os       = require('os');

var FW           = require('../fw');
var kv           = require(path.join(FW, 'lib/kv/src/main'));
var makeRedisKv  = require(path.join(FW, 'core/connectors/redis/lib/kv-store'));
var makeSqliteKv = require(path.join(FW, 'core/connectors/sqlite/lib/kv-store'));
var { makeFakeIoredis } = require('./fake-ioredis');
var commentStrip = require('../strip-comments');

var _tmpDir = null;
var _seq    = 0;

before(function () {
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-kv-parity-'));
});
after(function () {
    try { fs.rmSync(_tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

/**
 * The backends under test. `make()` returns a `KvStoreContract` or `null`
 * (meaning "let the facade build its in-memory backend").
 *
 * @constant
 * @type {Array.<{name: string, make: function}>}
 */
var BACKENDS = [
    { name: 'memory', make: function () { return null; } },
    {
        name: 'redis',
        make: function () {
            return makeRedisKv({}, 'paritybundle', 'ns', { driver: makeFakeIoredis() });
        }
    },
    {
        name: 'sqlite',
        make: function () {
            _seq++;
            return makeSqliteKv({ file: path.join(_tmpDir, 'kv-' + _seq + '.db') }, 'paritybundle', 'ns');
        }
    }
];

/**
 * Start a single-namespace facade over one backend and return its handle.
 *
 * @inner
 * @param {{name: string, make: function}} backend - Backend descriptor.
 * @param {object} [nsConf] - Namespace conf (`failMode`, ...).
 * @returns {object} The namespace handle.
 */
function start(backend, nsConf) {
    kv.reset();
    var store = backend.make();
    var block = { default: 'ns', namespaces: { ns: (nsConf || {}) } };
    assert.equal(kv.validateConfig(block).fatal, null);
    kv.start(block, store ? { stores: { ns: store } } : undefined);
    return kv.get('ns');
}

// ─── The shared spec ─────────────────────────────────────────────────────────

/**
 * Every parity assertion, as named async predicates over a namespace handle.
 * Each throws (via `assert`) on divergence. Declared ONCE and executed against
 * every backend — and, in §09, against a broken backend to prove they bite.
 *
 * @constant
 * @type {Array.<{name: string, ttl: boolean, run: function}>}
 */
var SPEC = [
    { name: 'set/get round-trips objects; a miss is null', ttl: false, run: async function (ns) {
        assert.equal(await ns.set('k', { a: 1, b: ['x'] }), true);
        assert.deepEqual(await ns.get('k'), { a: 1, b: ['x'] });
        assert.equal(await ns.get('absent'), null);
    }},
    { name: 'del reports whether a LIVE entry existed', ttl: false, run: async function (ns) {
        await ns.set('k', 1);
        assert.equal(await ns.del('k'), true);
        assert.equal(await ns.del('k'), false);
    }},
    { name: 'has answers liveness', ttl: false, run: async function (ns) {
        assert.equal(await ns.has('k'), false);
        await ns.set('k', 0);
        assert.equal(await ns.has('k'), true);
    }},
    { name: 'ttl: null on miss, -1 with no expiry', ttl: false, run: async function (ns) {
        assert.equal(await ns.ttl('absent'), null);
        await ns.set('forever', 1);
        assert.equal(await ns.ttl('forever'), -1);
    }},
    { name: 'setnx wins once while a live entry stands', ttl: false, run: async function (ns) {
        assert.equal(await ns.setnx('k', 'first'), true);
        assert.equal(await ns.setnx('k', 'second'), false);
        assert.equal(await ns.get('k'), 'first');
    }},
    { name: 'consume yields the value exactly once', ttl: false, run: async function (ns) {
        await ns.set('t', { uid: 7 });
        assert.deepEqual(await ns.consume('t'), { uid: 7 });
        assert.equal(await ns.consume('t'), null);
        assert.equal(await ns.has('t'), false);
    }},
    { name: 'incr/decr from absent and with an explicit step', ttl: false, run: async function (ns) {
        assert.equal(await ns.incr('c'), 1);
        assert.equal(await ns.incr('c', 5), 6);
        assert.equal(await ns.decr('c', 2), 4);
        assert.equal(await ns.decr('d'), -1);
    }},
    { name: 'incr refuses a non-integer stored value, with the FACADE wording', ttl: false, run: async function (ns) {
        await ns.set('s', 'text');
        await assert.rejects(ns.incr('s'), /is not an integer — incr\/decr need an integer value/);
    }},
    { name: 'incr refuses an overflow (boundary differs per backend; the refusal does not)', ttl: false, run: async function (ns) {
        await ns.set('c', Number.MAX_SAFE_INTEGER);
        await assert.rejects(ns.incr('c'));
    }},
    { name: 'delIfEquals deletes only on a strict match', ttl: false, run: async function (ns) {
        await ns.set('lock', { owner: 'a' });
        assert.equal(await ns.delIfEquals('lock', { owner: 'b' }), false);
        assert.equal(await ns.has('lock'), true);
        assert.equal(await ns.delIfEquals('lock', { owner: 'a' }), true);
        assert.equal(await ns.has('lock'), false);
    }},
    { name: 'clear empties the namespace and reports a count', ttl: false, run: async function (ns) {
        await ns.set('a', 1); await ns.set('b', 2);
        assert.equal(await ns.clear(), 2);
        assert.equal(await ns.get('a'), null);
        assert.equal(await ns.clear(), 0);
    }},
    { name: 'the value model refuses undefined and null on every write', ttl: false, run: async function (ns) {
        await assert.rejects(ns.set('k', undefined), /undefined/);
        await assert.rejects(ns.set('k', null), /indistinguishable from a miss/);
        await assert.rejects(ns.setnx('k', null), /indistinguishable from a miss/);
    }},
    { name: 'getOrSet: miss runs the loader once, then hits', ttl: false, run: async function (ns) {
        var calls = 0;
        var load = function () { calls++; return { fresh: true }; };
        assert.deepEqual(await ns.getOrSet('k', load), { fresh: true });
        assert.deepEqual(await ns.getOrSet('k', load), { fresh: true });
        assert.equal(calls, 1);
    }},
    { name: 'getOrSet: concurrent misses share ONE in-flight load', ttl: false, run: async function (ns) {
        var calls = 0, release;
        var gate = new Promise(function (r) { release = r; });
        var load = function () { calls++; return gate.then(function () { return 'built'; }); };
        var p1 = ns.getOrSet('k', load);
        var p2 = ns.getOrSet('k', load);
        release();
        assert.equal(await p1, 'built');
        assert.equal(await p2, 'built');
        assert.equal(calls, 1);
    }},

    // ── TTL-dependent (mocked clock) ──
    { name: 'a set with ttl expires', ttl: true, run: async function (ns) {
        await ns.set('k', 'v', { ttl: 1000 });
        assert.equal(await ns.get('k'), 'v');
        mock.timers.tick(1001);
        assert.equal(await ns.get('k'), null);
    }},
    { name: 'ttl reports the remaining lifetime', ttl: true, run: async function (ns) {
        await ns.set('k', 1, { ttl: 5000 });
        mock.timers.tick(2000);
        assert.equal(await ns.ttl('k'), 3000);
    }},
    { name: 'expire slides a live key and misses on absent', ttl: true, run: async function (ns) {
        await ns.set('k', 1, { ttl: 1000 });
        mock.timers.tick(900);
        assert.equal(await ns.expire('k', 5000), true);
        mock.timers.tick(4900);
        assert.equal(await ns.get('k'), 1);
        mock.timers.tick(200);
        assert.equal(await ns.get('k'), null);
        assert.equal(await ns.expire('gone', 1000), false);
    }},
    { name: 'setnx wins again once the incumbent expires', ttl: true, run: async function (ns) {
        assert.equal(await ns.setnx('k', 'first', { ttl: 1000 }), true);
        mock.timers.tick(1001);
        assert.equal(await ns.setnx('k', 'second'), true);
        assert.equal(await ns.get('k'), 'second');
    }},
    { name: 'an EXPIRED entry is not consumable and not deletable-as-live', ttl: true, run: async function (ns) {
        await ns.set('t', 'v', { ttl: 500 });
        mock.timers.tick(501);
        assert.equal(await ns.consume('t'), null);
        assert.equal(await ns.del('t'), false);
        assert.equal(await ns.has('t'), false);
    }},
    { name: 'incr applies its ttl on CREATE only', ttl: true, run: async function (ns) {
        assert.equal(await ns.incr('c', 1, { ttl: 1000 }), 1);
        mock.timers.tick(600);
        assert.equal(await ns.incr('c'), 2);
        mock.timers.tick(500);
        assert.equal(await ns.get('c'), null, 'a later incr must not renew the expiry');
    }}
];

// ─── §01-§08 — the matrix ────────────────────────────────────────────────────

BACKENDS.forEach(function (backend) {

    describe('parity [' + backend.name + ']', function () {

        afterEach(function () {
            kv.reset();
            mock.timers.reset();
        });

        SPEC.forEach(function (arm) {
            it(arm.name, async function () {
                if (arm.ttl) { mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] }); }
                var ns = start(backend);
                await arm.run(ns);
            });
        });
    });
});

// ─── §09 — instrument validation: the spec must REJECT a broken backend ──────

describe('09 - instrument validation (the matrix cannot pass vacuously)', function () {

    afterEach(function () { kv.reset(); mock.timers.reset(); });

    /**
     * A backend that is subtly WRONG in ways the contract forbids: `consume`
     * is a read that never deletes (so a token is redeemable twice), `setnx`
     * always wins (so a lock is never held), and `del` always claims success.
     * Every one of those is a real bug a naive implementation could ship.
     *
     * @inner
     * @returns {object} A KvStoreContract-shaped, contract-violating store.
     */
    function brokenBackend() {
        var m = new Map();
        return {
            get:     function (key) { return Promise.resolve(m.has(key) ? m.get(key) : null); },
            set:     function (key, s) { m.set(key, s); return Promise.resolve(); },
            del:     function () { return Promise.resolve(true); },          // always "existed"
            has:     function (key) { return Promise.resolve(m.has(key)); },
            pttl:    function (key) { return Promise.resolve(m.has(key) ? -1 : null); },
            pexpire: function () { return Promise.resolve(true); },
            setnx:   function (key, s) { m.set(key, s); return Promise.resolve(true); }, // always wins
            consume: function (key) { return Promise.resolve(m.has(key) ? m.get(key) : null); }, // never deletes
            incrby:  function (key, by) {
                var n = (m.has(key) ? Number(m.get(key)) : 0) + by;
                m.set(key, String(n));
                return Promise.resolve(n);
            },
            compareDel: function (key) { m.delete(key); return Promise.resolve(true); }, // ignores the comparison
            clear:   function () { m.clear(); return Promise.resolve(0); },
            close:   function () {}
        };
    }

    var broken = { name: 'broken', make: brokenBackend };

    it('the consume arm catches a consume that never deletes', async function () {
        var arm = SPEC.filter(function (a) { return /consume yields the value exactly once/.test(a.name); })[0];
        assert.ok(arm, 'arm present');
        await assert.rejects(async function () { await arm.run(start(broken)); },
            'a non-deleting consume MUST fail the shared spec');
    });

    it('the setnx arm catches a setnx that always wins', async function () {
        var arm = SPEC.filter(function (a) { return /setnx wins once/.test(a.name); })[0];
        await assert.rejects(async function () { await arm.run(start(broken)); },
            'an always-winning setnx MUST fail the shared spec');
    });

    it('the delIfEquals arm catches a compare-and-delete that ignores the comparison', async function () {
        var arm = SPEC.filter(function (a) { return /delIfEquals/.test(a.name); })[0];
        await assert.rejects(async function () { await arm.run(start(broken)); },
            'an unconditional compareDel MUST fail the shared spec');
    });

    it('the del arm catches a del that always claims an entry existed', async function () {
        var arm = SPEC.filter(function (a) { return /del reports whether a LIVE entry existed/.test(a.name); })[0];
        await assert.rejects(async function () { await arm.run(start(broken)); },
            'an always-true del MUST fail the shared spec');
    });

    it('the matrix covers every backend and a non-trivial spec (no silent shrinkage)', function () {
        assert.deepEqual(BACKENDS.map(function (b) { return b.name; }), ['memory', 'redis', 'sqlite']);
        assert.ok(SPEC.length >= 20, 'expected a substantial shared spec, got ' + SPEC.length);
        assert.ok(SPEC.filter(function (a) { return a.ttl; }).length >= 5, 'expected TTL coverage in the shared spec');
    });
});

// ─── §10 — sqlite specifics the shared spec cannot express ───────────────────

describe('10 - sqlite backend specifics', function () {

    afterEach(function () { kv.reset(); });

    it('survives a close/reopen of the same file (durability, which memory cannot offer)', async function () {
        var file = path.join(_tmpDir, 'durable.db');
        var s1 = makeSqliteKv({ file: file }, 'b', 'ns');
        await s1.set('k', '"kept"', null);
        s1.close();

        var s2 = makeSqliteKv({ file: file }, 'b', 'ns');
        assert.equal(await s2.get('k'), '"kept"', 'the value must survive the reopen');
        s2.close();
    });

    it('isolates namespaces sharing ONE file by composite key', async function () {
        var file = path.join(_tmpDir, 'shared.db');
        var a = makeSqliteKv({ file: file }, 'b', 'alpha');
        var b = makeSqliteKv({ file: file }, 'b', 'beta');
        await a.set('k', '"one"', null);
        await b.set('k', '"two"', null);
        assert.equal(await a.get('k'), '"one"');
        assert.equal(await b.get('k'), '"two"');
        assert.equal(await a.clear(), 1, 'clear is namespace-scoped');
        assert.equal(await b.get('k'), '"two"', 'the sibling namespace survives');
        a.close(); b.close();
    });

    it('read-modify-write verbs run inside an IMMEDIATE transaction (multi-process atomicity)', function () {
        var src = fs.readFileSync(path.join(FW, 'core/connectors/sqlite/lib/kv-store.js'), 'utf8');
        var code = commentStrip.lines(src);
        assert.ok(code.indexOf("BEGIN IMMEDIATE") > -1, 'IMMEDIATE takes the write lock up front');
        ['del', 'pexpire', 'setnx', 'consume', 'incrby', 'compareDel'].forEach(function (verb) {
            var i = code.indexOf(verb + ': function');
            assert.ok(i > -1, verb + ' present');
            var block = code.slice(i, i + 900);
            assert.ok(block.indexOf('tx(') > -1, verb + ' must run inside the transaction helper');
        });
        // single-statement verbs need no transaction
        var getIdx = code.indexOf('get: function');
        assert.equal(code.slice(getIdx, getIdx + 200).indexOf('tx('), -1, 'get needs no transaction');
    });
});
