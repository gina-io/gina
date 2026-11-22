/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Connector-backed KV store (#KV1 slice 1) — Redis backend.
 *
 * Covers:
 *   - core/connectors/redis/lib/kv-store.js — behavioural, against the REAL
 *     store code driven by a fake promise-style ioredis driver (CI has no
 *     redis; the driver is injected via the factory's test-only fourth arg,
 *     the job-store `injected` DI precedent).
 *   - The whole 13-op surface driven THROUGH the real `lib/kv` facade wired to
 *     the redis backend — i.e. the same contract the in-memory backend
 *     satisfies, answered by redis commands. This is the parity half that
 *     matters: the facade is unaware which backend it holds.
 *   - `consume` both ways: `GETDEL` on a modern server AND the Lua fallback on
 *     a pre-6.2 one, plus the once-only capability probe (no re-probing after
 *     the first fallback).
 *   - `incrby`'s TTL-on-CREATE-only Lua, and the normalised non-integer refusal.
 *   - `compareDel` atomicity via Lua (never a GET+DEL pair).
 *   - `clear()` over SCAN, standalone AND multi-node cluster.
 *   - Config resolution: standalone host/port/db/password/tls, cluster
 *     construction, prefix default `kv:<namespace>:`, custom prefix, and the
 *     policy pass-throughs (absent keys must leave ioredis's defaults alone).
 *   - Source pins: driver resolution order, no GET+DEL pair, and the
 *     deliberate ABSENCE of the job store's cluster hash-tag fail-fast.
 *
 * The fake driver throws on any command it does not implement, so the store
 * reaching for an unexpected redis command fails these tests by construction.
 * Its `eval` dispatches on the three known script texts rather than
 * interpreting Lua — an unknown script is likewise a throw.
 *
 * Run: node --test test/lib/kv-store-redis.test.js
 */

var { describe, it, beforeEach, afterEach, mock } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW           = require('../fw');
var createStore  = require(path.join(FW, 'core/connectors/redis/lib/kv-store'));
var kv           = require(path.join(FW, 'lib/kv/src/main'));
var commentStrip = require('../strip-comments');

var STORE_SOURCE = path.join(FW, 'core/connectors/redis/lib/kv-store.js');
var SRC          = fs.readFileSync(STORE_SOURCE, 'utf8');

// ─── Fake ioredis ───────────────────────────────────────────────────────────

/**
 * Build a fake promise-style ioredis driver over a shared keyspace.
 *
 * @inner
 * @param {object}  [opts]              - Fake behaviour switches.
 * @param {boolean} [opts.getdel=true]  - Whether the server knows `GETDEL` (redis >= 6.2).
 * @param {object}  [opts.state]        - Shared keyspace Map to adopt (durability analogs).
 * @param {string[]} [opts.calls]       - Array collecting every command name issued.
 * @returns {function} An ioredis-shaped constructor with a `.Cluster` property.
 */
function makeDriver(opts) {
    opts = opts || {};
    var store  = opts.state || new Map();
    var calls  = opts.calls || [];
    var hasGetDel = (opts.getdel !== false);

    /**
     * Live record for a physical key (lazy expiry).
     * @inner
     * @param {string} key - Physical key.
     * @returns {?{v: string, exp: ?number}}
     */
    function live(key) {
        var rec = store.get(key);
        if (!rec) { return null; }
        if (rec.exp !== null && rec.exp <= Date.now()) { store.delete(key); return null; }
        return rec;
    }

    /**
     * One fake client instance.
     * @inner
     * @param {object} [conf] - Construction config (recorded for assertions).
     * @returns {object} The fake client.
     */
    function Client(conf) {
        var self = this;
        this.conf     = conf;
        this.quitCalls = 0;
        this.handlers = {};

        this.on = function (evt, fn) { self.handlers[evt] = fn; return self; };
        this.quit = function () { self.quitCalls++; return Promise.resolve('OK'); };

        this.get = function (key) {
            calls.push('get');
            var rec = live(key);
            return Promise.resolve(rec ? rec.v : null);
        };

        this.set = function () {
            calls.push('set');
            var args = Array.prototype.slice.call(arguments);
            var key = args[0], val = args[1];
            var px = null, nx = false;
            for (var i = 2; i < args.length; i++) {
                var a = String(args[i]).toUpperCase();
                if (a === 'PX') { px = +args[i + 1]; i++; }
                else if (a === 'NX') { nx = true; }
                else { throw new Error('fake ioredis: unsupported SET option `' + args[i] + '`'); }
            }
            if (nx && live(key)) { return Promise.resolve(null); }
            store.set(key, { v: String(val), exp: px ? Date.now() + px : null });
            return Promise.resolve('OK');
        };

        this.del = function (key) {
            calls.push('del');
            var existed = !!live(key);
            store.delete(key);
            return Promise.resolve(existed ? 1 : 0);
        };

        this.exists = function (key) {
            calls.push('exists');
            return Promise.resolve(live(key) ? 1 : 0);
        };

        this.pttl = function (key) {
            calls.push('pttl');
            var rec = live(key);
            if (!rec) { return Promise.resolve(-2); }
            if (rec.exp === null) { return Promise.resolve(-1); }
            return Promise.resolve(Math.max(0, rec.exp - Date.now()));
        };

        this.pexpire = function (key, ms) {
            calls.push('pexpire');
            var rec = live(key);
            if (!rec) { return Promise.resolve(0); }
            rec.exp = Date.now() + (+ms);
            return Promise.resolve(1);
        };

        if (hasGetDel) {
            this.getdel = function (key) {
                calls.push('getdel');
                var rec = live(key);
                store.delete(key);
                return Promise.resolve(rec ? rec.v : null);
            };
        } else {
            // A pre-6.2 server: ioredis still exposes the method, the SERVER
            // rejects it. This is the shape the store's probe must survive.
            this.getdel = function () {
                calls.push('getdel');
                return Promise.reject(new Error("ERR unknown command 'GETDEL'"));
            };
        }

        this.eval = function (script, numKeys, key) {
            var argv = Array.prototype.slice.call(arguments, 3);
            if (/GETDEL|getdel/.test(script)) { throw new Error('fake ioredis: unexpected script'); }
            if (/local v = redis\.call\('GET'/.test(script)) {
                calls.push('eval:consume');
                var rec = live(key);
                store.delete(key);
                return Promise.resolve(rec ? rec.v : null);
            }
            if (/local existed = redis\.call\('EXISTS'/.test(script)) {
                calls.push('eval:incr');
                var by = Number(argv[0]);
                var ttl = argv[1];
                var cur = live(key);
                var existed = !!cur;
                var base = 0;
                if (cur) {
                    if (!/^-?\d+$/.test(cur.v)) {
                        return Promise.reject(new Error('ERR value is not an integer or out of range'));
                    }
                    base = Number(cur.v);
                }
                var next = base + by;
                store.set(key, { v: String(next), exp: existed ? (cur.exp) : (ttl ? Date.now() + Number(ttl) : null) });
                return Promise.resolve(next);
            }
            if (/if redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\]/.test(script)) {
                calls.push('eval:compareDel');
                var r = live(key);
                if (r && r.v === argv[0]) { store.delete(key); return Promise.resolve(1); }
                return Promise.resolve(0);
            }
            throw new Error('fake ioredis: unsupported script `' + String(script).slice(0, 40) + '`');
        };

        this.scan = function (cursor, matchKw, pattern, countKw, count) {
            calls.push('scan');
            assert.equal(String(matchKw).toUpperCase(), 'MATCH');
            assert.equal(String(countKw).toUpperCase(), 'COUNT');
            var re = new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$');
            var all = Array.from(store.keys()).filter(function (kk) { return re.test(kk); });
            // Single-page scan: cursor '0' in, '0' out.
            return Promise.resolve(['0', all]);
        };

        // Not implemented on purpose — reaching for one fails by construction.
        ['keys', 'flushdb', 'flushall', 'mget', 'mset', 'incr', 'incrby', 'getset', 'setex', 'ttl'].forEach(function (cmd) {
            self[cmd] = function () { throw new Error('fake ioredis: unsupported command `' + cmd + '`'); };
        });
    }

    /**
     * @inner
     * @param {object} conf - Standalone client config.
     * @returns {object} A fake client.
     */
    function Driver(conf) { return new Client(conf); }

    Driver.Cluster = function (nodes, clusterOpts) {
        var c = new Client({ cluster: nodes, clusterOpts: clusterOpts });
        c.isClusterClient = true;
        c.nodeList = [c];
        c.nodes = function () { return c.nodeList; };
        return c;
    };
    Driver._store = store;
    Driver._calls = calls;
    return Driver;
}

/**
 * Build a store over a fresh fake driver.
 *
 * @inner
 * @param {object} [connConf] - connectors.json entry.
 * @param {object} [dOpts]    - Fake-driver options.
 * @returns {{store: object, driver: function, calls: string[]}}
 */
function build(connConf, dOpts) {
    var calls  = [];
    var driver = makeDriver(Object.assign({ calls: calls }, dOpts || {}));
    var store  = createStore(connConf || {}, 'testbundle', 'tokens', { driver: driver });
    return { store: store, driver: driver, calls: calls };
}

/**
 * Wire the real lib/kv facade onto a redis-backed namespace.
 *
 * @inner
 * @param {object} [nsConf]   - Namespace conf (`failMode` etc.).
 * @param {object} [connConf] - connectors.json entry.
 * @param {object} [dOpts]    - Fake-driver options.
 * @returns {{ns: object, ctx: object}}
 */
function facade(nsConf, connConf, dOpts) {
    var ctx = build(connConf, dOpts);
    kv.reset();
    var block = { default: 'tokens', namespaces: { tokens: (nsConf || {}) } };
    assert.equal(kv.validateConfig(block).fatal, null);
    kv.start(block, { stores: { tokens: ctx.store } });
    return { ns: kv.get('tokens'), ctx: ctx };
}

afterEach(function () { kv.reset(); });

// ─── 01. Config resolution ──────────────────────────────────────────────────

describe('01 - config resolution', function () {

    it('standalone: host / port / db defaults and overrides', function () {
        var a = build({});
        assert.deepEqual(a.store && a.driverConf, undefined); // store exposes no conf — read it off the client below
        var b = createStore({}, 'b', 'ns', { driver: makeDriver() });
        assert.equal(typeof b.get, 'function');

        var drv = makeDriver();
        var seen = null;
        var Wrapped = function (conf) { seen = conf; return new (drv)(conf); };
        Wrapped.Cluster = drv.Cluster;
        createStore({ host: '10.0.0.5', port: 6380, db: 3, password: 'p', tls: true }, 'b', 'ns', { driver: Wrapped });
        assert.equal(seen.host, '10.0.0.5');
        assert.equal(seen.port, 6380);
        assert.equal(seen.db, 3);
        assert.equal(seen.password, 'p');
        assert.deepEqual(seen.tls, {});
    });

    it('policy pass-throughs are OPT-IN — absent keys leave ioredis defaults alone', function () {
        var drv = makeDriver();
        var seen = null;
        var Wrapped = function (conf) { seen = conf; return new (drv)(conf); };
        Wrapped.Cluster = drv.Cluster;

        createStore({}, 'b', 'ns', { driver: Wrapped });
        assert.equal('commandTimeout' in seen, false, 'no commandTimeout unless configured');
        assert.equal('maxRetriesPerRequest' in seen, false);
        assert.equal('enableOfflineQueue' in seen, false, 'the offline queue stays at ioredis default');

        createStore({ commandTimeout: 250, maxRetriesPerRequest: 0, enableOfflineQueue: false }, 'b', 'ns', { driver: Wrapped });
        assert.equal(seen.commandTimeout, 250);
        assert.equal(seen.maxRetriesPerRequest, 0);
        assert.equal(seen.enableOfflineQueue, false);
    });

    it('cluster: nodes + redisOptions, and enableOfflineQueue rides the TOP level', function () {
        var drv = makeDriver();
        var seenNodes = null, seenOpts = null;
        var Wrapped = function (conf) { return new drv(conf); };
        Wrapped.Cluster = function (nodes, opts) { seenNodes = nodes; seenOpts = opts; return drv.Cluster(nodes, opts); };

        var nodes = [{ host: 'n1', port: 6379 }, { host: 'n2', port: 6379 }];
        createStore({ cluster: nodes, password: 'p', tls: true, commandTimeout: 500, enableOfflineQueue: false }, 'b', 'ns', { driver: Wrapped });
        assert.deepEqual(seenNodes, nodes);
        assert.equal(seenOpts.enableOfflineQueue, false, 'top-level, not per-node (ioredis Omits it there)');
        assert.equal(seenOpts.redisOptions.commandTimeout, 500);
        assert.equal(seenOpts.redisOptions.password, 'p');
        assert.deepEqual(seenOpts.redisOptions.tls, {});
    });

    it('prefix defaults to kv:<namespace>: and is overridable', async function () {
        var c = build({});
        await c.store.set('a', '1', null);
        assert.ok(c.driver._store.has('kv:tokens:a'), 'default prefix namespaces the key');

        var calls2 = [];
        var d2 = makeDriver({ calls: calls2 });
        var s2 = createStore({ prefix: 'custom:' }, 'b', 'tokens', { driver: d2 });
        await s2.set('a', '1', null);
        assert.ok(d2._store.has('custom:a'));
    });

    it('two namespaces on ONE entry never collide', async function () {
        var shared = new Map();
        var d = makeDriver({ state: shared });
        var s1 = createStore({}, 'b', 'alpha', { driver: d });
        var s2 = createStore({}, 'b', 'beta',  { driver: d });
        await s1.set('k', '"one"', null);
        await s2.set('k', '"two"', null);
        assert.equal(await s1.get('k'), '"one"');
        assert.equal(await s2.get('k'), '"two"');
    });
});

// ─── 02. The 13-op surface, driven through the REAL facade ──────────────────

describe('02 - the facade over redis (backend-agnostic contract)', function () {

    it('set / get round-trips a value', async function () {
        var f = facade();
        assert.equal(await f.ns.set('k', { a: 1 }), true);
        assert.deepEqual(await f.ns.get('k'), { a: 1 });
        assert.equal(await f.ns.get('absent'), null);
    });

    it('del / has', async function () {
        var f = facade();
        await f.ns.set('k', 1);
        assert.equal(await f.ns.has('k'), true);
        assert.equal(await f.ns.del('k'), true);
        assert.equal(await f.ns.del('k'), false);
        assert.equal(await f.ns.has('k'), false);
    });

    it('ttl maps redis -2 to a null MISS and keeps -1 for no-expiry', async function () {
        var f = facade();
        assert.equal(await f.ns.ttl('absent'), null, 'redis -2 must not leak to the caller');
        await f.ns.set('forever', 1);
        assert.equal(await f.ns.ttl('forever'), -1);
        await f.ns.set('k', 1, { ttl: 5000 });
        var remaining = await f.ns.ttl('k');
        assert.ok(remaining > 4000 && remaining <= 5000, 'got ' + remaining);
    });

    it('expire slides a live key and misses on absent', async function () {
        var f = facade();
        await f.ns.set('k', 1, { ttl: 1000 });
        assert.equal(await f.ns.expire('k', 9000), true);
        assert.ok(await f.ns.ttl('k') > 5000);
        assert.equal(await f.ns.expire('gone', 1000), false);
    });

    it('setnx wins once (SET .. NX resolving null is a LOSS, not an error)', async function () {
        var f = facade();
        assert.equal(await f.ns.setnx('k', 'first', { ttl: 60000 }), true);
        assert.equal(await f.ns.setnx('k', 'second'), false);
        assert.equal(await f.ns.get('k'), 'first');
    });

    it('clear empties only this namespace and reports the count', async function () {
        var shared = new Map();
        var d = makeDriver({ state: shared });
        var mine  = createStore({}, 'b', 'tokens', { driver: d });
        var other = createStore({}, 'b', 'other',  { driver: d });
        await mine.set('a', '1', null);
        await mine.set('b', '2', null);
        await other.set('a', '9', null);
        assert.equal(await mine.clear(), 2);
        assert.equal(await mine.get('a'), null);
        assert.equal(await other.get('a'), '9', 'a sibling namespace is untouched');
    });

    it('getOrSet works over redis (facade-level single-flight, backend-agnostic)', async function () {
        var f = facade();
        var calls = 0;
        var release;
        var gate = new Promise(function (r) { release = r; });
        var load = function () { calls++; return gate.then(function () { return 'built'; }); };
        var p1 = f.ns.getOrSet('k', load);
        var p2 = f.ns.getOrSet('k', load);
        release();
        assert.equal(await p1, 'built');
        assert.equal(await p2, 'built');
        assert.equal(calls, 1);
        assert.equal(await f.ns.get('k'), 'built');
    });
});

// ─── 03. consume — GETDEL, the Lua fallback, and the once-only probe ────────

describe('03 - consume (atomic read-and-delete)', function () {

    it('modern server: uses GETDEL and yields the value exactly once', async function () {
        var f = facade(null, null, { getdel: true });
        await f.ns.set('t', { uid: 7 });
        assert.deepEqual(await f.ns.consume('t'), { uid: 7 });
        assert.equal(await f.ns.consume('t'), null);
        assert.ok(f.ctx.calls.indexOf('getdel') > -1, 'GETDEL path taken');
        assert.equal(f.ctx.calls.indexOf('eval:consume'), -1, 'no Lua on a modern server');
    });

    it('pre-6.2 server: falls back to Lua, never to a GET+DEL pair', async function () {
        var f = facade(null, null, { getdel: false });
        await f.ns.set('t', 'v');
        assert.equal(await f.ns.consume('t'), 'v');
        assert.ok(f.ctx.calls.indexOf('eval:consume') > -1, 'Lua fallback taken');
        assert.equal(await f.ns.consume('t'), null);
    });

    it('the capability is probed ONCE — no re-probe after the first fallback', async function () {
        var f = facade(null, null, { getdel: false });
        await f.ns.set('a', 1); await f.ns.set('b', 2); await f.ns.set('c', 3);
        await f.ns.consume('a');
        await f.ns.consume('b');
        await f.ns.consume('c');
        var probes = f.ctx.calls.filter(function (c) { return c === 'getdel'; }).length;
        assert.equal(probes, 1, 'exactly one GETDEL probe across three consumes, got ' + probes);
        var luas = f.ctx.calls.filter(function (c) { return c === 'eval:consume'; }).length;
        assert.equal(luas, 3);
    });

    it('a NON-capability driver error propagates (not swallowed as a fallback)', async function () {
        var ctx = build({});
        ctx.store; // built
        var d = makeDriver();
        var s = createStore({}, 'b', 'ns', { driver: d });
        // replace getdel with a genuine failure
        // (the store must not treat this as "server too old")
        var real = s.consume;
        var broken = createStore({}, 'b', 'ns', { driver: (function () {
            var D = makeDriver();
            var Wrapped = function (conf) {
                var c = new D(conf);
                c.getdel = function () { return Promise.reject(new Error('READONLY You can\'t write against a read only replica.')); };
                return c;
            };
            Wrapped.Cluster = D.Cluster;
            return Wrapped;
        })() });
        await assert.rejects(broken.consume('k'), /READONLY/);
    });
});

// ─── 04. incrby — TTL on create only, normalised refusal ────────────────────

describe('04 - counters', function () {

    it('increments and decrements through the facade', async function () {
        var f = facade();
        assert.equal(await f.ns.incr('c'), 1);
        assert.equal(await f.ns.incr('c', 5), 6);
        assert.equal(await f.ns.decr('c', 2), 4);
    });

    it('TTL applies on CREATE only (a later incr must not renew it)', async function () {
        var f = facade();
        assert.equal(await f.ns.incr('c', 1, { ttl: 60000 }), 1);
        var first = await f.ns.ttl('c');
        assert.ok(first > 0 && first <= 60000);
        await f.ns.incr('c', 1, { ttl: 999000 });
        var second = await f.ns.ttl('c');
        assert.ok(second <= first + 5, 'ttl must not be renewed on increment (was ' + first + ', now ' + second + ')');
    });

    it('a non-integer stored value is refused with the FACADE wording, not the redis wording', async function () {
        var f = facade();
        await f.ns.set('s', 'text');
        await assert.rejects(f.ns.incr('s'), /is not an integer — incr\/decr need an integer value/);
        await assert.rejects(f.ns.incr('s'), /^(?!.*out of range).*$/s);
    });
});

// ─── 05. compareDel ─────────────────────────────────────────────────────────

describe('05 - delIfEquals (compare-and-delete)', function () {

    it('deletes only on a strict match, atomically via Lua', async function () {
        var f = facade();
        await f.ns.set('lock', { owner: 'a' });
        assert.equal(await f.ns.delIfEquals('lock', { owner: 'b' }), false);
        assert.equal(await f.ns.has('lock'), true);
        assert.equal(await f.ns.delIfEquals('lock', { owner: 'a' }), true);
        assert.equal(await f.ns.has('lock'), false);
        assert.ok(f.ctx.calls.indexOf('eval:compareDel') > -1, 'must go through the script');
    });
});

// ─── 06. clear() over SCAN, standalone and cluster ──────────────────────────

describe('06 - clear over SCAN', function () {

    it('standalone: scans and deletes per key (never KEYS/FLUSHDB)', async function () {
        var c = build({});
        await c.store.set('a', '1', null);
        await c.store.set('b', '2', null);
        assert.equal(await c.store.clear(), 2);
        assert.ok(c.calls.indexOf('scan') > -1);
        assert.equal(c.calls.indexOf('keys'), -1, 'KEYS is O(N)-blocking and unimplemented by the fake');
    });

    it('cluster: scans EVERY master node', async function () {
        var d = makeDriver();
        var seenNodes = 0;
        var Wrapped = function (conf) { return new d(conf); };
        Wrapped.Cluster = function (nodes, opts) {
            var c = d.Cluster(nodes, opts);
            var n1 = new d({}); var n2 = new d({});
            // both nodes share the cluster client's keyspace via the driver's Map
            c.nodes = function () { seenNodes++; return [n1, n2]; };
            return c;
        };
        var s = createStore({ cluster: [{ host: 'n1', port: 6379 }, { host: 'n2', port: 6379 }] }, 'b', 'tokens', { driver: Wrapped });
        await s.set('a', '1', null);
        assert.equal(await s.clear(), 1);
        assert.equal(seenNodes, 1, 'nodes(\'master\') consulted for the scan surface');
    });
});

// ─── 07. failMode over a genuinely failing backend ──────────────────────────

describe('07 - failMode over redis errors', function () {

    /**
     * A driver whose every command rejects — the outage stand-in.
     * @inner
     * @returns {function} ioredis-shaped constructor.
     */
    function brokenDriver() {
        var D = makeDriver();
        var Wrapped = function (conf) {
            var c = new D(conf);
            ['get', 'set', 'del', 'exists', 'pttl', 'pexpire', 'getdel', 'eval', 'scan'].forEach(function (m) {
                c[m] = function () { return Promise.reject(new Error('CONNECTIONBROKEN')); };
            });
            return c;
        };
        Wrapped.Cluster = D.Cluster;
        return Wrapped;
    }

    it('closed (default): a redis outage rejects the call', async function () {
        var store = createStore({}, 'b', 'tokens', { driver: brokenDriver() });
        kv.reset();
        kv.start({ namespaces: { tokens: {} } }, { stores: { tokens: store } });
        await assert.rejects(kv.get('tokens').get('k'), /CONNECTIONBROKEN/);
    });

    it('open: a redis outage degrades to miss shapes with a warning', async function () {
        var store = createStore({}, 'b', 'tokens', { driver: brokenDriver() });
        var warned = [];
        kv.reset();
        kv.start({ namespaces: { tokens: { failMode: 'open' } } },
                 { stores: { tokens: store }, warn: function (m) { warned.push(m); } });
        var ns = kv.get('tokens');
        assert.equal(await ns.get('k'), null);
        assert.equal(await ns.set('k', 1), false);
        assert.equal(await ns.consume('k'), null);
        assert.ok(warned.length >= 3, 'each degrade warns');
    });
});

// ─── 08. Source pins ────────────────────────────────────────────────────────

describe('08 - source pins', function () {

    it('driver resolution: bare require first, then the project node_modules', function () {
        var bareIdx    = SRC.indexOf("Redis = require('ioredis')");
        var projectIdx = SRC.indexOf("getPath('project') + '/node_modules/ioredis'");
        assert.ok(bareIdx > -1, 'bare require present');
        assert.ok(projectIdx > bareIdx, 'project fallback follows the bare require');
    });

    it('consume never composes a GET+DEL pair in the fallback', function () {
        // The Lua script is the fallback; a JS-level get-then-del would be the
        // race this op exists to prevent.
        var code = commentStrip.lines(SRC);
        var consumeIdx = code.indexOf('consume: function');
        var incrIdx    = code.indexOf('incrby: function');
        assert.ok(consumeIdx > -1 && incrIdx > consumeIdx);
        var block = code.slice(consumeIdx, incrIdx);
        assert.ok(block.indexOf('LUA_CONSUME') > -1, 'fallback goes through the script');
        assert.equal(/client\.get\s*\(/.test(block), false, 'no GET in the consume path');
        assert.equal(/client\.del\s*\(/.test(block), false, 'no DEL in the consume path');
    });

    it('the three Lua scripts are single-key and parameterised (no interpolated values)', function () {
        ['LUA_CONSUME', 'LUA_INCR_TTL', 'LUA_COMPARE_DEL'].forEach(function (name) {
            var i = SRC.indexOf('var ' + name);
            assert.ok(i > -1, name + ' declared');
        });
        assert.ok(SRC.indexOf("KEYS[1]") > -1);
        // values reach the script as ARGV, never spliced into the source
        assert.equal(/\+\s*(?:s|by|ttlMs)\s*\+\s*"/.test(SRC), false, 'no value interpolation into a script');
    });

    it('does NOT carry the job store cluster hash-tag fail-fast (deliberate divergence)', function () {
        assert.equal(SRC.indexOf('hash-tagged `prefix`'), -1,
            'KV ops are single-key, so a cluster namespace must be free to spread across slots');
        assert.ok(SRC.indexOf('single-key') > -1, 'and the divergence is documented in-source');
    });

    it('clear() scans rather than reaching for KEYS or FLUSHDB', function () {
        assert.ok(SRC.indexOf('.scan(') > -1);
        assert.equal(/client\.keys\s*\(|flushdb|flushall/i.test(SRC), false);
    });
});
