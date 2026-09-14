/**
 * Connector-backed JobStore (#AI6 follow-up) — SQLite store + seam hardening.
 *
 * Covers:
 *   - core/connectors/sqlite/lib/job-store.js — behavioral, against the REAL
 *     node:sqlite driver (builtin, so no mock needed): seam round-trips,
 *     memory-store parity (no expiry filter on get/list), the sweep predicate
 *     matrix, and restart durability (close + reopen the same file).
 *   - lib/job create() hardening — the drain tick is scheduled from inside the
 *     store.set callback, so an ASYNC store can never lose a job to runOne's
 *     vanished-record guard. Proven behaviorally against a fake async store,
 *     with a pure-logic replica of the OLD ordering demonstrating the drop.
 *   - lib/job start() — a store arriving after one is installed is refused
 *     with a loud warning (was silently ignored).
 *   - Source pins: lib/job (create ordering + start warn), lib/job-store
 *     dispatcher (resolution + fail-fast error shapes), lib/index.js
 *     registration, gna.js boot wiring (store resolution + #B57-shape
 *     fail-fast), and the sqlite store's contract-critical SQL.
 *
 * Run: node --test test/lib/job-store-sqlite.test.js
 */

'use strict';

var { describe, it, before, after, beforeEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');

var FW          = require('../fw');
var createStore = require(path.join(FW, 'core/connectors/sqlite/lib/job-store'));
var job         = require(path.join(FW, 'lib/job/src/main'));

var STORE_SOURCE      = path.join(FW, 'core/connectors/sqlite/lib/job-store.js');
var JOB_SOURCE        = path.join(FW, 'lib/job/src/main.js');
var DISPATCHER_SOURCE = path.join(FW, 'lib/job-store.js');
var LIB_INDEX_SOURCE  = path.join(FW, 'lib/index.js');
var GNA_SOURCE        = path.join(FW, 'core/gna.js');


// ─── Helpers ────────────────────────────────────────────────────────────────

var _tmpDir = null;
var _dbSeq  = 0;

before(function() {
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-jobstore-'));
});

after(function() {
    try { fs.rmSync(_tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

function freshDbPath() {
    return path.join(_tmpDir, 'jobs-' + (++_dbSeq) + '.db');
}

/** Build a record matching create()'s initial 13-key shape. */
function makeRecord(id, patch) {
    var now = Date.now();
    var rec = {
        id:          id,
        state:       'pending',
        result:      null,
        error:       null,
        attempts:    0,
        maxAttempts: 1,
        callbackUrl: null,
        meta:        null,
        createdAt:   now,
        updatedAt:   now,
        startedAt:   null,
        finishedAt:  null,
        expiresAt:   null
    };
    if (patch) {
        for (var k in patch) rec[k] = patch[k];
    }
    return rec;
}

function storeSet(store, rec) {
    return new Promise(function(res, rej) {
        store.set(rec.id, rec, function(err, r) { err ? rej(err) : res(r); });
    });
}
function storeGet(store, id) {
    return new Promise(function(res, rej) {
        store.get(id, function(err, rec) { err ? rej(err) : res(rec); });
    });
}
function storeList(store, filter) {
    return new Promise(function(res, rej) {
        store.list(filter || null, function(err, recs) { err ? rej(err) : res(recs); });
    });
}
function storeSweep(store, now) {
    return new Promise(function(res, rej) {
        store.sweep(now, function(err, n) { err ? rej(err) : res(n); });
    });
}

function tick(ms) {
    return new Promise(function(r) { setTimeout(r, ms || 5); });
}

function getJob(id) {
    return new Promise(function(res) { job.get(id, function(e, rec) { res(rec); }); });
}

async function waitForState(id, state, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 1000);
    var rec;
    while (Date.now() < deadline) {
        rec = await getJob(id);
        if (rec && rec.state === state) return rec;
        await tick(2);
    }
    throw new Error('timeout waiting for "' + state + '"; last state = ' + (rec && rec.state));
}

/**
 * A JobStore whose every callback is deferred — models a connector store with
 * I/O latency. `delays` allows ASYMMETRIC latency (`{ set: 10, get: 1 }`): a
 * slow write + fast read lets a get overtake an in-flight set, which is the
 * exact reordering the create-race hardening defends against. Symmetric delays
 * would serialise set-before-get through FIFO timer ordering and never race.
 */
function createFakeAsyncStore(delays) {
    var map = Object.create(null);
    delays  = delays || {};
    var dSet   = (typeof delays.set === 'number')   ? delays.set   : 2;
    var dGet   = (typeof delays.get === 'number')   ? delays.get   : 2;
    var dOther = (typeof delays.other === 'number') ? delays.other : 2;
    return {
        map: map,
        set: function(id, record, fn) {
            setTimeout(function() {
                map[id] = record;
                if (typeof fn === 'function') fn(null, record);
            }, dSet);
        },
        get: function(id, fn) {
            setTimeout(function() {
                fn(null, Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null);
            }, dGet);
        },
        remove: function(id, fn) {
            setTimeout(function() {
                var existed = Object.prototype.hasOwnProperty.call(map, id);
                if (existed) delete map[id];
                if (typeof fn === 'function') fn(null, existed);
            }, dOther);
        },
        list: function(filter, fn) {
            setTimeout(function() {
                var out = [];
                for (var k in map) {
                    if (filter && filter.state && map[k].state !== filter.state) continue;
                    out.push(map[k]);
                }
                fn(null, out);
            }, dOther);
        },
        sweep: function(now, fn) {
            setTimeout(function() { fn(null, 0); }, dOther);
        }
    };
}


// ─── 01. Module + instance shape ────────────────────────────────────────────

describe('job-store-sqlite § 01 — module + instance shape', function() {

    it('exports a factory function taking (connConf, bundle)', function() {
        assert.equal(typeof createStore, 'function');
        assert.equal(createStore.length, 2);
    });

    it('builds an instance with the five seam methods + close()', function() {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        ['set', 'get', 'remove', 'list', 'sweep', 'close'].forEach(function(m) {
            assert.equal(typeof store[m], 'function', m + ' must be a function');
        });
        store.close();
    });
});


// ─── 02. set/get round-trip ─────────────────────────────────────────────────

describe('job-store-sqlite § 02 — set/get round-trip', function() {

    it('round-trips the full initial record shape byte-faithfully', async function() {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        var rec   = makeRecord('job-rt-1', { meta: { source: 'unit' } });
        var setRes = await storeSet(store, rec);
        assert.deepEqual(setRes, rec);
        var got = await storeGet(store, 'job-rt-1');
        assert.deepEqual(got, rec);
        store.close();
    });

    it('returns null (not an error) for an unknown id', async function() {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        var got = await storeGet(store, 'nope');
        assert.equal(got, null);
        store.close();
    });

    it('tolerates records gaining keys after creation (webhook fields)', async function() {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        var rec   = makeRecord('job-grow-1');
        await storeSet(store, rec);
        rec.state              = 'completed';
        rec.webhookDeliveredAt = Date.now();
        await storeSet(store, rec);
        var got = await storeGet(store, 'job-grow-1');
        assert.equal(got.state, 'completed');
        assert.equal(typeof got.webhookDeliveredAt, 'number');
        store.close();
    });

    it('reports a non-serialisable record through the callback, never throws', function(t, done) {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        var rec   = makeRecord('job-circ-1');
        rec.result = {};
        rec.result.self = rec.result; // circular — JSON.stringify must fail
        store.set(rec.id, rec, function(err) {
            assert.ok(err instanceof Error);
            store.close();
            done();
        });
    });
});


// ─── 03. Memory-store parity — expiry acts ONLY at sweep ────────────────────

describe('job-store-sqlite § 03 — no expiry filter on get/list (memory parity)', function() {

    it('a terminal record past expiresAt stays readable until swept', async function() {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        var past  = Date.now() - 60000;
        var rec   = makeRecord('job-exp-1', { state: 'completed', finishedAt: past, expiresAt: past });
        await storeSet(store, rec);
        var got = await storeGet(store, 'job-exp-1');
        assert.ok(got, 'expired-but-unswept record must still be readable (memory-store parity)');
        assert.equal(got.state, 'completed');
        var listed = await storeList(store, { state: 'completed' });
        assert.equal(listed.length, 1);
        await storeSweep(store, Date.now());
        assert.equal(await storeGet(store, 'job-exp-1'), null);
        store.close();
    });
});


// ─── 04. remove ─────────────────────────────────────────────────────────────

describe('job-store-sqlite § 04 — remove', function() {

    it('reports existed=true then existed=false', function(t, done) {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        store.set('job-rm-1', makeRecord('job-rm-1'), function() {
            store.remove('job-rm-1', function(e1, existed1) {
                assert.equal(e1, null);
                assert.equal(existed1, true);
                store.remove('job-rm-1', function(e2, existed2) {
                    assert.equal(e2, null);
                    assert.equal(existed2, false);
                    store.close();
                    done();
                });
            });
        });
    });
});


// ─── 05. list ───────────────────────────────────────────────────────────────

describe('job-store-sqlite § 05 — list', function() {

    it('lists all records with a null filter and filters by state', async function() {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        await storeSet(store, makeRecord('l1', { state: 'pending' }));
        await storeSet(store, makeRecord('l2', { state: 'completed' }));
        await storeSet(store, makeRecord('l3', { state: 'completed' }));
        assert.equal((await storeList(store, null)).length, 3);
        assert.equal((await storeList(store, { state: 'completed' })).length, 2);
        assert.equal((await storeList(store, { state: 'failed' })).length, 0);
        store.close();
    });
});


// ─── 06. sweep predicate matrix ─────────────────────────────────────────────

describe('job-store-sqlite § 06 — sweep predicate (terminal AND expired only)', function() {

    it('removes exactly the expired terminal records', async function() {
        var store  = createStore({ file: freshDbPath() }, 'testbundle');
        var past   = Date.now() - 60000;
        var future = Date.now() + 60000;
        await storeSet(store, makeRecord('sw-pend-exp',  { state: 'pending',   expiresAt: past }));
        await storeSet(store, makeRecord('sw-run',       { state: 'running' }));
        await storeSet(store, makeRecord('sw-done-live', { state: 'completed', expiresAt: future }));
        await storeSet(store, makeRecord('sw-done-exp',  { state: 'completed', expiresAt: past }));
        await storeSet(store, makeRecord('sw-fail-exp',  { state: 'failed',    expiresAt: past }));

        var removed = await storeSweep(store, Date.now());
        assert.equal(removed, 2, 'only completed-expired + failed-expired are sweepable');

        assert.ok(await storeGet(store, 'sw-pend-exp'),  'pending is never swept, expired or not');
        assert.ok(await storeGet(store, 'sw-run'),       'running is never swept');
        assert.ok(await storeGet(store, 'sw-done-live'), 'unexpired terminal survives');
        assert.equal(await storeGet(store, 'sw-done-exp'), null);
        assert.equal(await storeGet(store, 'sw-fail-exp'), null);
        store.close();
    });
});


// ─── 07. Restart durability — the headline behavior ────────────────────────

describe('job-store-sqlite § 07 — records survive close + reopen', function() {

    it('a record written before close() is intact in a new store on the same file', async function() {
        var dbPath = freshDbPath();
        var store1 = createStore({ file: dbPath }, 'testbundle');
        var rec    = makeRecord('job-dur-1', { state: 'completed', result: { answer: 42 } });
        await storeSet(store1, rec);
        store1.close();

        var store2 = createStore({ file: dbPath }, 'testbundle');
        var got    = await storeGet(store2, 'job-dur-1');
        assert.deepEqual(got, rec);
        store2.close();
    });
});


// ─── 08. Integration through lib/job with the real SQLite store ────────────

describe('job-store-sqlite § 08 — lib/job end-to-end on the SQLite store', function() {

    beforeEach(function() {
        job.reset();
    });

    it('create → completed lands the result in the SQLite-backed record', async function() {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        job.start({ store: store, sweepInterval: 0 });
        var id  = job.create(function() { return Promise.resolve('ok-result'); });
        var rec = await waitForState(id, 'completed');
        assert.equal(rec.result, 'ok-result');
        assert.equal(typeof rec.finishedAt, 'number');
        assert.equal(typeof rec.expiresAt, 'number');
        // Straight from the store, bypassing lib/job — proves where it lives.
        var raw = await storeGet(store, id);
        assert.equal(raw.state, 'completed');
        assert.equal(raw.result, 'ok-result');
        job.reset();
        store.close();
    });

    it('a failing job lands a serialised (JSON-round-trippable) error', async function() {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        job.start({ store: store, sweepInterval: 0 });
        var id  = job.create(function() { throw new Error('boom'); });
        var rec = await waitForState(id, 'failed');
        assert.ok(!(rec.error instanceof Error), 'error must be the serialised shape, not a raw Error');
        assert.equal(rec.error.message, 'boom');
        assert.doesNotThrow(function() { JSON.stringify(rec); });
        job.reset();
        store.close();
    });

    it('toStatusView projects the store-backed record to state-only', async function() {
        var store = createStore({ file: freshDbPath() }, 'testbundle');
        job.start({ store: store, sweepInterval: 0 });
        var id   = job.create(function() { return Promise.resolve({ secret: true }); });
        var rec  = await waitForState(id, 'completed');
        var view = job.toStatusView(rec);
        assert.deepEqual(Object.keys(view).sort(), ['createdAt', 'id', 'state', 'updatedAt']);
        job.reset();
        store.close();
    });
});


// ─── 09. create-race hardening — async store never drops a job ─────────────

describe('job-store-sqlite § 09 — async-store create-race hardening', function() {

    beforeEach(function() {
        job.reset();
    });

    it('a job created on an ASYNC store completes (drain waits for the set to land)', async function() {
        // Adversarial timing — slow write, fast read. Pre-fix, the worker's
        // get() overtook the in-flight set() and the job was silently dropped.
        var fake = createFakeAsyncStore({ set: 10, get: 1 });
        job.start({ store: fake, sweepInterval: 0 });
        var id  = job.create(function() { return Promise.resolve('async-ok'); });
        var rec = await waitForState(id, 'completed', 2000);
        assert.equal(rec.result, 'async-ok');
        job.reset();
    });

    it('SUBTRACT replica — the OLD ordering (fire-and-forget set + immediate drain) drops the job', function(t, done) {
        // Pure-logic replica of the pre-fix create()/runOne() pair, driven
        // against the same slow-write / fast-read store: set() has not landed
        // when the worker's get() runs, so the vanished-record guard drops
        // the job.
        var fake    = createFakeAsyncStore({ set: 10, get: 1 });
        var queue   = [];
        var dropped = 0;
        var ran     = 0;

        function runOneReplica(entry) {
            fake.get(entry.id, function(getErr, rec) {
                if (getErr || !rec) { dropped++; return; } // the silent-drop guard
                ran++;
            });
        }
        function oldCreateReplica(id) {
            fake.set(id, makeRecord(id), function() {}); // fire-and-forget — the old shape
            queue.push({ id: id, fn: function() {} });
            setImmediate(function() { runOneReplica(queue.shift()); });
        }

        oldCreateReplica('old-shape-1');
        setTimeout(function() {
            assert.equal(dropped, 1, 'the old ordering must lose the job on an async store');
            assert.equal(ran, 0);
            done();
        }, 40);
    });

    it('start() refuses (and warns about) a store arriving after one is installed', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(String(msg)); };
        try {
            job.start({ sweepInterval: 0 });                       // installs the memory store
            var late = createFakeAsyncStore({ set: 1, get: 1 });
            job.start({ store: late, sweepInterval: 0 });          // must be refused, loudly
            var id = job.create(function() { return Promise.resolve(1); });
            assert.ok(id, 'primitive still works on the first store');
            assert.ok(
                warns.some(function(w) { return w.indexOf('already installed') > -1; }),
                'a loud warning must name the refusal'
            );
            assert.equal(Object.keys(late.map).length, 0, 'the late store must never receive records');
        } finally {
            console.warn = origWarn;
            job.reset();
        }
    });
});


// ─── 10. Source pins — lib/job hardening ────────────────────────────────────

describe('job-store-sqlite § 10 — lib/job source pins', function() {

    var SRC = fs.readFileSync(JOB_SOURCE, 'utf8');

    it('create(): the drain tick is scheduled from inside the store.set callback', function() {
        var createIdx = SRC.indexOf('function create(');
        assert.ok(createIdx > -1);
        var block   = SRC.substring(createIdx, SRC.indexOf('function get(', createIdx));
        var pushIdx = block.indexOf('_queue.push({ id: id, fn: fn, urgency: urgency });'); // #H12 — the entry carries its urgency
        var setIdx  = block.indexOf('_store.set(id, record, function');
        var drainIdx = block.indexOf('setImmediate(drain);', setIdx);
        assert.ok(pushIdx > -1, 'queue push present');
        assert.ok(setIdx > pushIdx, 'set follows the queue push');
        assert.ok(drainIdx > setIdx, 'setImmediate(drain) sits inside the set callback');
    });

    it('create(): the fire-and-forget set shape is gone file-wide', function() {
        assert.ok(SRC.indexOf('_store.set(id, record, noop)') < 0);
    });

    it('create(): a failed store.set is warned about, never silent', function() {
        assert.match(SRC, /store\.set failed for job/);
    });

    it('start(): a late store is refused with a loud warning', function() {
        var startIdx = SRC.indexOf('function start(');
        var block    = SRC.substring(startIdx, SRC.indexOf('function stats(', startIdx));
        assert.match(block, /else if \(opts\.store && typeof opts\.store === 'object' && opts\.store !== _store\)/);
        assert.match(block, /already installed/);
    });
});


// ─── 11. Source pins + replica — lib/job-store dispatcher ──────────────────

describe('job-store-sqlite § 11 — dispatcher source pins + resolution replica', function() {

    var SRC = fs.readFileSync(DISPATCHER_SOURCE, 'utf8');

    it('rejects a missing / empty entry name', function() {
        assert.match(SRC, /typeof connName !== 'string' \|\| connName\.length === 0/);
        assert.match(SRC, /a connectors\.json entry name is required/);
    });

    it('resolves the connector from conf.content.connectors[connName]', function() {
        assert.ok(SRC.indexOf('conf.content.connectors[connName]') > -1);
        assert.match(SRC, /GINA_FRAMEWORK_DIR \+ '\/core\/connectors'/);
    });

    it('fails loudly when the connector has no job-store implementation', function() {
        assert.ok(SRC.indexOf('fs.existsSync(filename)') > -1);
        assert.match(SRC, /has no job-store implementation/);
    });

    it('hands the resolved connConf + bundle to the connector factory', function() {
        assert.ok(SRC.indexOf('require(filename)(connConf, bundle)') > -1);
    });

    it('replica — the resolution logic maps an entry to the connector file path', function() {
        // Mirrors the dispatcher body: entry lookup → connector field → file path.
        function resolveReplica(conf, connName, frameworkDir) {
            var connConf, connector;
            try {
                connConf  = conf.content.connectors[connName];
                connector = connConf.connector;
            } catch (err) {
                throw new Error('could not resolve `' + connName + '`');
            }
            if (!connector) throw new Error('entry `' + connName + '` has no `connector` field');
            return { connConf: connConf, filename: frameworkDir + '/core/connectors/' + connector + '/lib/job-store.js' };
        }
        var conf = { content: { connectors: { jobsDb: { connector: 'sqlite', file: '/data/jobs.db' } } } };
        var r = resolveReplica(conf, 'jobsDb', '/fw');
        assert.equal(r.filename, '/fw/core/connectors/sqlite/lib/job-store.js');
        assert.equal(r.connConf.file, '/data/jobs.db');
        assert.throws(function() { resolveReplica(conf, 'nope', '/fw'); }, /could not resolve/);
        assert.throws(function() { resolveReplica({ content: { connectors: { bad: {} } } }, 'bad', '/fw'); }, /no `connector` field/);
    });
});


// ─── 12. Source pins — registration + gna.js boot wiring ───────────────────

describe('job-store-sqlite § 12 — lib/index.js + gna.js wiring pins', function() {

    it('lib/index.js registers JobStore via _require (SessionStore precedent)', function() {
        var SRC = fs.readFileSync(LIB_INDEX_SOURCE, 'utf8');
        assert.match(SRC, /JobStore\s+: _require\('\.\/job-store'\)/);
    });

    it('gna.js resolves jobs.store through lib.JobStore and passes it to start()', function() {
        var SRC = fs.readFileSync(GNA_SOURCE, 'utf8');
        var blockIdx = SRC.indexOf('_jobsStartOpts');
        assert.ok(blockIdx > -1, 'jobs boot block present');
        var block = SRC.substring(blockIdx, blockIdx + 2600);
        assert.match(block, /typeof _jobsConf\.store === 'string' && _jobsConf\.store\.length > 0/);
        assert.ok(block.indexOf('_jobsStartOpts.store = lib.JobStore(_jobsConf.store)') > -1);
        assert.ok(block.indexOf('lib.job.start(_jobsStartOpts)') > -1);
    });

    it('gna.js fails fast on an unbuildable configured store (emerg + sync flush + exit)', function() {
        var SRC = fs.readFileSync(GNA_SOURCE, 'utf8');
        var blockIdx = SRC.indexOf('_jobsStartOpts');
        var block = SRC.substring(blockIdx, blockIdx + 2600);
        var emergIdx = block.indexOf('console.emerg(_jobsStoreMsg');
        var flushIdx = block.indexOf('fs.writeSync(2, _jobsStoreMsg');
        var exitIdx  = block.indexOf('process.exit(1)', emergIdx);
        assert.ok(emergIdx > -1, 'emerg present');
        assert.ok(flushIdx > emergIdx, 'synchronous flush follows the emerg');
        assert.ok(exitIdx > flushIdx, 'exit(1) follows the flush');
    });
});


// ─── 13. Source pins — sqlite store contract-critical SQL ──────────────────

describe('job-store-sqlite § 13 — sqlite store source pins', function() {

    var SRC = fs.readFileSync(STORE_SOURCE, 'utf8');

    it('opens with WAL + synchronous=NORMAL (session-store trade-off)', function() {
        assert.ok(SRC.indexOf("PRAGMA journal_mode=WAL") > -1);
        assert.ok(SRC.indexOf("PRAGMA synchronous=NORMAL") > -1);
    });

    it('get has NO expiry filter (memory-store parity — expiry acts at sweep only)', function() {
        assert.ok(SRC.indexOf("SELECT record FROM jobs WHERE id = ?") > -1);
        assert.ok(SRC.indexOf("WHERE id = ? AND expires_at") < 0);
    });

    it('reads the path from `file` (sqlite DB-connector convention, model-scan-safe)', function() {
        assert.ok(SRC.indexOf('connConf.file') > -1);
        assert.ok(SRC.indexOf('connConf.database') < 0, 'database is a NAME to the model layer, never a path here');
    });

    it('sweep deletes terminal AND expired only', function() {
        assert.ok(SRC.indexOf('expires_at IS NOT NULL AND expires_at <= ?') > -1);
        assert.match(SRC, /state IN \(/);
    });

    it('owns no timer — the primitive drives the sweep cadence', function() {
        assert.ok(SRC.indexOf('setInterval') < 0);
    });

    it('imports STATES from lib/job so the sweep predicate cannot drift', function() {
        assert.match(SRC, /require\('\.\.\/\.\.\/\.\.\/\.\.\/lib\/job\/src\/main'\)\.STATES/);
    });
});
