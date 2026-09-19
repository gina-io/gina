/**
 * storage-maintenance.test.js — the #STO1 CLI slice: the maintenance verbs
 * (driver `stats` / `sweepNow` / `verify`), their optional seam surface
 * (meta-store `stats` + `listKeys`), the `/_gina/storage/*` endpoint family,
 * and the `storage:*` cmd handlers.
 *
 * Fixtures are BUILT AT RUNTIME (Buffer.alloc / direct SQL on mkdtemp roots)
 * — no binary byte lives in this source file, so it stays text-classified
 * and greppable (the storage-cas precedent). Keep new fixtures constructed,
 * not pasted.
 *
 * Three instrument classes, each per its measured house precedent:
 *   - driver/seam logic — BEHAVIOURAL, through the real factories against
 *     temp roots (the storage-cas idiom; sweepInterval 0 so tests drive the
 *     sweep deterministically);
 *   - the cmd handlers — SOURCE-INSPECTION pins (they read CLI globals —
 *     `lib`, requireJSON, CmdHelper state — so they are not require-safe;
 *     the cache-clear.test.js precedent);
 *   - the endpoint handlers — SOURCE-INSPECTION pins + a pure-logic replica
 *     of the drain loop (the server.test.js / server-release-watch §04
 *     precedent; the handlers live inside onRequest()'s closure).
 */

var fs       = require('fs');
var os       = require('os');
var nodePath = require('path');
var { describe, it, after } = require('node:test');
var assert   = require('node:assert/strict');
var Readable = require('stream').Readable;

var ROOT = nodePath.join(__dirname, '..', '..');
var FW   = require('../fw');

var storage      = require(nodePath.join(FW, 'lib', 'storage', 'src', 'main.js'));
var sqliteDriver = require(nodePath.join(FW, 'lib', 'sqlite-driver'));

var SERVER_SRC = fs.readFileSync(nodePath.join(FW, 'core', 'server.js'), 'utf8');
var STATS_SRC  = fs.readFileSync(nodePath.join(FW, 'lib', 'cmd', 'storage', 'stats.js'), 'utf8');
var GC_SRC     = fs.readFileSync(nodePath.join(FW, 'lib', 'cmd', 'storage', 'gc.js'), 'utf8');
var VERIFY_SRC = fs.readFileSync(nodePath.join(FW, 'lib', 'cmd', 'storage', 'verify.js'), 'utf8');
var HELP_TXT   = fs.readFileSync(nodePath.join(FW, 'lib', 'cmd', 'storage', 'help.txt'), 'utf8');
var ARGS_ARR   = JSON.parse(fs.readFileSync(nodePath.join(FW, 'lib', 'cmd', 'storage', 'arguments.json'), 'utf8'));
var CLI_SRC    = fs.readFileSync(nodePath.join(ROOT, 'bin', 'cli'), 'utf8');

var roots = [];
after(function () {
    storage.reset();
    roots.forEach(function (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
});

function mkRoot() {
    var root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'gina-storage-maint-'));
    roots.push(root);
    return root;
}

/** Build an embedded store inside a fresh root. */
function freshStore(root) {
    return storage._createEmbeddedMetaStore(nodePath.join(root, '.meta.db'));
}

/** Build a cas driver over a fresh root, sweep timer off, tiny grace. */
function freshCas(root, over) {
    over = over || {};
    var conf = storage._resolveDriverConf({ root: root, strategy: 'cas', sweepInterval: '0s' });
    conf.sweepGrace = ( typeof over.sweepGrace === 'number' ) ? over.sweepGrace : 60;
    conf.inlineThreshold = ( typeof over.inlineThreshold === 'number' ) ? over.inlineThreshold : 16;
    var store = over.store || freshStore(root);
    return storage._FACTORIES.cas('maint', conf, store);
}

/** Build a sharded driver over a fresh root. */
function freshSharded(root, over) {
    over = over || {};
    var conf = storage._resolveDriverConf({ root: root, strategy: 'sharded' });
    if ( typeof over.inlineThreshold === 'number' ) { conf.inlineThreshold = over.inlineThreshold; }
    var store = over.store || freshStore(root);
    return storage._FACTORIES.sharded('maint', conf, store);
}

function put(driver, buf, fn) {
    driver.put(Readable.from([buf]), { originalName: 'f.bin', contentType: 'application/octet-stream' }, fn);
}

/** Direct DB access for row surgery (backdating) — the storage-cas idiom. */
function openDb(root) {
    var DatabaseSync = sqliteDriver.getDatabaseSync();
    return new DatabaseSync(nodePath.join(root, '.meta.db'));
}

function backdateZero(root, key, ms) {
    var db = openDb(root);
    db.prepare('UPDATE objects SET zero_at = ? WHERE key = ?').run(Date.now() - ms, key);
    db.close();
}

function backdateCreated(root, key, ms) {
    var db = openDb(root);
    db.prepare('UPDATE objects SET created_at = ? WHERE key = ?').run(Date.now() - ms, key);
    db.close();
}

/** Minimal in-memory StorageMetaStore, refcount verbs included, NO stats/listKeys. */
function stubRefcountStore() {
    var rows = {};
    return {
        set: function(key, meta, fn) { rows[key] = Object.assign({}, meta); (fn || function(){})(null, meta); },
        get: function(key, fn) {
            if ( !(key in rows) ) { return fn(null, null); }
            fn(null, Object.assign({}, rows[key]));
        },
        remove: function(key, fn) { var had = (key in rows); delete rows[key]; (fn || function(){})(null, had); },
        acquireRef: function(key, meta, fn) {
            if ( key in rows && typeof rows[key].refs === 'number' ) {
                rows[key].refs++; rows[key].zeroAt = null;
                return (fn || function(){})(null, { created: false, refs: rows[key].refs, meta: Object.assign({}, rows[key]) });
            }
            rows[key] = Object.assign({}, meta, { refs: 1, zeroAt: null });
            (fn || function(){})(null, { created: true, refs: 1, meta: meta });
        },
        releaseRef: function(key, fn) {
            var r = rows[key];
            if ( !r || typeof r.refs !== 'number' || r.refs < 1 ) { return (fn || function(){})(null, { existed: false, refs: 0 }); }
            r.refs--;
            if ( r.refs === 0 ) { r.zeroAt = Date.now(); }
            (fn || function(){})(null, { existed: true, refs: r.refs });
        },
        listZeroRefs: function(olderThanMs, limit, fn) {
            var keys = Object.keys(rows).filter(function(k) {
                return rows[k].refs === 0 && typeof rows[k].zeroAt === 'number' && rows[k].zeroAt <= olderThanMs;
            }).slice(0, limit);
            fn(null, keys);
        },
        removeIfZero: function(key, fn) {
            var r = rows[key];
            if ( r && r.refs === 0 ) { delete rows[key]; return (fn || function(){})(null, true); }
            (fn || function(){})(null, false);
        },
        close: function() {}
        // deliberately NO stats() and NO listKeys() — the degrade paths under test
    };
}


describe('01 - meta-store stats verb', function () {

    it('an empty store reports all-zero counts (the control that can fire)', function (t, done) {
        var store = freshStore(mkRoot());
        store.stats(function (err, s) {
            assert.ifError(err);
            assert.deepEqual(s, { objects: 0, refcounted: 0, zeroRefPending: 0, inline: 0, bytes: 0 });
            store.close();
            done();
        });
    });

    it('counts objects / refcounted / zeroRefPending / inline / bytes correctly', function (t, done) {
        var store = freshStore(mkRoot());
        // one plain file-backed row (sharded shape), one refcounted inline row,
        // one refcounted file-backed row released to zero
        store.set('2026/01/01/aaa.bin', { originalName: 'a', size: 10, createdAt: Date.now() }, function () {
            store.acquireRef('blobs/sha256/aa/aa/' + 'a'.repeat(64), { size: 20, createdAt: Date.now(), data: Buffer.alloc(20, 65) }, function () {
                store.acquireRef('blobs/sha256/bb/bb/' + 'b'.repeat(64), { size: 30, createdAt: Date.now() }, function () {
                    store.releaseRef('blobs/sha256/bb/bb/' + 'b'.repeat(64), function () {
                        store.stats(function (err, s) {
                            assert.ifError(err);
                            assert.equal(s.objects, 3);
                            assert.equal(s.refcounted, 2);
                            assert.equal(s.zeroRefPending, 1);
                            assert.equal(s.inline, 1);
                            assert.equal(s.bytes, 60);
                            store.close();
                            done();
                        });
                    });
                });
            });
        });
    });

    it('reserved dot-key rows (the .driver stamp) are excluded from every count', function (t, done) {
        var store = freshStore(mkRoot());
        store.set('.driver', { createdAt: Date.now(), data: Buffer.from('{"strategy":"cas"}') }, function () {
            store.stats(function (err, s) {
                assert.ifError(err);
                assert.equal(s.objects, 0, 'the stamp must not count as an object');
                assert.equal(s.inline, 0, 'the stamp payload must not count as an inline object');
                store.close();
                done();
            });
        });
    });
});


describe('02 - meta-store listKeys verb', function () {

    it('pages in key order, excludes dot-keys, honours the cursor and the limit', function (t, done) {
        var store = freshStore(mkRoot());
        store.set('.driver', { createdAt: Date.now() }, function () {
            store.set('k/a', { createdAt: Date.now() }, function () {
                store.set('k/b', { createdAt: Date.now() }, function () {
                    store.set('k/c', { createdAt: Date.now() }, function () {
                        store.listKeys('', 2, function (err, page1) {
                            assert.ifError(err);
                            assert.deepEqual(page1, ['k/a', 'k/b'], 'first page: ordered, dot-key excluded, limit honoured');
                            store.listKeys(page1[page1.length - 1], 2, function (err2, page2) {
                                assert.ifError(err2);
                                assert.deepEqual(page2, ['k/c'], 'cursor page is exclusive of afterKey');
                                store.listKeys(page2[0], 2, function (err3, page3) {
                                    assert.ifError(err3);
                                    assert.deepEqual(page3, [], 'exhausted cursor answers empty');
                                    store.close();
                                    done();
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});


describe('03 - resolveDriverConf seam (the offline CLI door)', function () {

    it('sharded: defaults applied, explicit values parsed', function () {
        var r = storage._resolveDriverConf({ root: '/x', strategy: 'sharded' });
        assert.equal(r.maxObjectSize, storage._DEFAULT_MAX_OBJECT_SIZE);
        assert.equal(r.inlineThreshold, storage._DEFAULT_INLINE_THRESHOLD);
        assert.equal(typeof r.hash, 'undefined', 'no cas keys on a sharded resolve');
        var r2 = storage._resolveDriverConf({ root: '/x', strategy: 'sharded', maxObjectSize: '1MB', inlineThreshold: '0B' });
        assert.equal(r2.maxObjectSize, 1024 * 1024);
        assert.equal(r2.inlineThreshold, 0, "'0B' keeps its zero (tiering off)");
    });

    it('cas: hash lowercased + defaulted, fsync/sweep defaults resolved', function () {
        var r = storage._resolveDriverConf({ root: '/x', strategy: 'cas', hash: 'SHA512' });
        assert.equal(r.hash, 'sha512', 'hash is canonicalised to lowercase');
        assert.equal(r.fsync, storage._DEFAULT_CAS_FSYNC);
        assert.equal(r.sweepInterval, storage._DEFAULT_SWEEP_INTERVAL);
        assert.equal(r.sweepGrace, storage._DEFAULT_SWEEP_GRACE);
        var r2 = storage._resolveDriverConf({ root: '/x', strategy: 'cas', sweepInterval: '0s', fsync: false });
        assert.equal(r2.hash, storage._DEFAULT_CAS_HASH);
        assert.equal(r2.sweepInterval, 0, "'0s' keeps its zero (periodic sweep off)");
        assert.equal(r2.fsync, false);
    });

    it('start() resolves through the same function (source pin — one copy of default resolution)', function () {
        var MAIN_SRC = fs.readFileSync(nodePath.join(FW, 'lib', 'storage', 'src', 'main.js'), 'utf8');
        assert.ok(MAIN_SRC.indexOf('var resolved = resolveDriverConf(conf);') > -1,
            'start() must resolve through resolveDriverConf — two copies would drift');
        assert.ok(MAIN_SRC.indexOf('_resolveDriverConf       : resolveDriverConf') > -1,
            'the resolver must be exported for the CLI offline door');
    });
});


describe('04 - list()', function () {

    it('answers [] before start, names after, [] again after reset', function () {
        storage.reset();
        assert.deepEqual(storage.list(), [], 'empty before start');
        var root = mkRoot();
        var ok = storage.start({ drivers: { docs: { root: root, strategy: 'cas' }, files: { root: mkRoot(), strategy: 'sharded' } } });
        assert.equal(ok, true);
        assert.deepEqual(storage.list(), ['docs', 'files'], 'configuration order');
        storage.reset();
        assert.deepEqual(storage.list(), [], 'empty after reset');
    });
});


describe('05 - driver stats (sharded)', function () {

    it('reports identity + store counts', function (t, done) {
        var root = mkRoot();
        var driver = freshSharded(root, { inlineThreshold: 16 });
        put(driver, Buffer.alloc(8, 65), function (e1) {
            assert.ifError(e1);
            put(driver, Buffer.alloc(64, 66), function (e2) {
                assert.ifError(e2);
                driver.stats(function (err, s) {
                    assert.ifError(err);
                    assert.equal(s.name, 'maint');
                    assert.equal(s.strategy, 'sharded');
                    assert.equal(s.root, root);
                    assert.equal(s.capabilities.dedup, false);
                    assert.deepEqual(s.store, { objects: 2, refcounted: 0, zeroRefPending: 0, inline: 1, bytes: 72 });
                    driver.close();
                    done();
                });
            });
        });
    });

    it('degrades to store:null over a store without stats() — never errors', function (t, done) {
        var driver = freshSharded(mkRoot(), { store: stubRefcountStore() });
        driver.stats(function (err, s) {
            assert.ifError(err);
            assert.equal(s.store, null, 'a store lacking stats() reports no stats');
            assert.equal(s.strategy, 'sharded', 'the driver identity half still answers');
            driver.close();
            done();
        });
    });
});


describe('06 - driver stats (cas)', function () {

    it('reports refcounted + zeroRefPending through the same shape', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root);
        put(driver, Buffer.alloc(8, 65), function (e1, r1) {
            assert.ifError(e1);
            put(driver, Buffer.alloc(64, 66), function (e2, r2) {
                assert.ifError(e2);
                driver.release(r2.key, function () {
                    driver.stats(function (err, s) {
                        assert.ifError(err);
                        assert.equal(s.strategy, 'cas');
                        assert.equal(s.capabilities.dedup, true);
                        assert.deepEqual(s.store, { objects: 2, refcounted: 2, zeroRefPending: 1, inline: 1, bytes: 72 });
                        driver.close();
                        done();
                    });
                });
            });
        });
    });
});


describe('07 - sweepNow (the promoted door)', function () {

    it('sweepNow IS _sweepOnce (the alias identity that keeps the cas suite untouched)', function () {
        var driver = freshCas(mkRoot());
        assert.equal(driver.sweepNow, driver._sweepOnce, 'one function, two names');
        driver.close();
    });

    it('dryRun lists collectable keys past the grace and touches NOTHING', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root);
        put(driver, Buffer.alloc(64, 67), function (e1, r1) {
            assert.ifError(e1);
            driver.release(r1.key, function () {
                backdateZero(root, r1.key, 10000);
                driver.sweepNow({ dryRun: true }, function (err, res) {
                    assert.ifError(err);
                    assert.deepEqual(res.collectable, [r1.key]);
                    assert.equal(res.drained, true);
                    assert.ok(fs.existsSync(nodePath.join(root, r1.key)), 'dryRun must not unlink');
                    driver.sweepNow({ dryRun: true }, function (err2, res2) {
                        assert.ifError(err2);
                        assert.deepEqual(res2.collectable, [r1.key], 'still collectable — dryRun claimed no row');
                        driver.close();
                        done();
                    });
                });
            });
        });
    });

    it('inside the grace window nothing is collectable (the age control)', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root, { sweepGrace: 60 * 60 * 1000 });
        put(driver, Buffer.alloc(64, 68), function (e1, r1) {
            assert.ifError(e1);
            driver.release(r1.key, function () {
                driver.sweepNow({ dryRun: true }, function (err, res) {
                    assert.ifError(err);
                    assert.deepEqual(res.collectable, [], 'a fresh zero-ref blob sits out its grace');
                    assert.equal(res.drained, true);
                    driver.close();
                    done();
                });
            });
        });
    });

    it('a real pass reports {collected, drained}; a second batch reports drained:false first', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root);
        // 101 zero-ref inline blobs, all past grace — one over the batch cap
        var mkOne = function (i, next) {
            if ( i >= 101 ) { return next(); }
            put(driver, Buffer.from('blob-' + String(i).padStart(3, '0')), function (e, r) {
                assert.ifError(e);
                driver.release(r.key, function () {
                    backdateZero(root, r.key, 10000);
                    mkOne(i + 1, next);
                });
            });
        };
        mkOne(0, function () {
            driver.sweepNow(function (err, res) {
                assert.ifError(err);
                assert.equal(res.collected, 100, 'batch-capped at SWEEP_BATCH');
                assert.equal(res.drained, false, 'one blob remains past the cap');
                driver.sweepNow(function (err2, res2) {
                    assert.ifError(err2);
                    assert.equal(res2.collected, 1);
                    assert.equal(res2.drained, true);
                    driver.stats(function (err3, s) {
                        assert.ifError(err3);
                        assert.equal(s.store.objects, 0, 'everything collected');
                        driver.close();
                        done();
                    });
                });
            });
        });
    });

    it('a bare no-argument call keeps the pre-promotion timer shape (no throw, sweep runs)', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root);
        put(driver, Buffer.alloc(64, 69), function (e1, r1) {
            assert.ifError(e1);
            driver.release(r1.key, function () {
                backdateZero(root, r1.key, 10000);
                driver._sweepOnce(); // the exact call shape the cas suite and the timer use
                // the embedded store is synchronous — the pass has settled here
                driver.stats(function (err, s) {
                    assert.ifError(err);
                    assert.equal(s.store.objects, 0, 'the no-arg pass swept');
                    driver.close();
                    done();
                });
            });
        });
    });
});


describe('08 - verify (both classes, age gates, fix asymmetry)', function () {

    /** Plant an aged orphan blob file (correct grammar depth, no row). */
    function plantOrphan(root, hexByte, ageMs) {
        var hex = hexByte.repeat(32);
        var key = 'blobs/sha256/' + hex.slice(0, 2) + '/' + hex.slice(2, 4) + '/' + hex;
        var p   = nodePath.join(root, key);
        fs.mkdirSync(nodePath.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.alloc(10, 70));
        if (ageMs) {
            var old = new Date(Date.now() - ageMs);
            fs.utimesSync(p, old, old);
        }
        return key;
    }

    it('reports an AGED file-without-row; a YOUNG one is age-gated out (control)', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root, { sweepGrace: 60 });
        var aged  = plantOrphan(root, 'ab', 10000);
        plantOrphan(root, 'cd', 0); // young — must NOT be reported
        driver.verify(function (err, rep) {
            assert.ifError(err);
            assert.equal(rep.findingCounts.filesWithoutRows, 1, 'exactly the aged orphan');
            assert.equal(rep.findings[0]['class'], 'file-without-row');
            assert.equal(rep.findings[0].key, aged);
            assert.equal(rep.checked.files, 2, 'both files were visited');
            driver.close();
            done();
        });
    });

    it('reports an AGED row-without-file with refs; a FRESH row is age-gated out (the acquire→rename window)', function (t, done) {
        var root = mkRoot();
        // #B565 — the grace is in MILLISECONDS (`sweepGraceMs = conf.sweepGrace`
        // verbatim), and it gates r2's freshness against wall-clock time elapsed
        // between its put() and verify(). At 60 ms that margin measured ~6-21 ms
        // on an idle machine and vanished under load, so verify() CORRECTLY
        // reported both rows and the assertion below failed intermittently.
        // r1 is backdated 10 s, so it stays aged for any grace below that.
        var driver = freshCas(root, { sweepGrace: 5000 });
        put(driver, Buffer.alloc(64, 71), function (e1, r1) {
            assert.ifError(e1);
            fs.unlinkSync(nodePath.join(root, r1.key));
            put(driver, Buffer.alloc(64, 72), function (e2, r2) {
                assert.ifError(e2);
                fs.unlinkSync(nodePath.join(root, r2.key));
                backdateCreated(root, r1.key, 10000); // r1 aged, r2 stays fresh
                driver.verify(function (err, rep) {
                    assert.ifError(err);
                    assert.equal(rep.findingCounts.rowsWithoutFiles, 1, 'only the aged row');
                    var f = rep.findings.filter(function (x) { return x['class'] === 'row-without-file'; })[0];
                    assert.equal(f.key, r1.key);
                    assert.equal(f.refs, 1, 'the refcount rides the finding — it is the loss evidence');
                    driver.close();
                    done();
                });
            });
        });
    });

    it('an inline row and a zero-ref row are NEVER rows-without-files findings (controls)', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root, { sweepGrace: 60 });
        put(driver, Buffer.alloc(8, 73), function (e1, r1) {          // inline — no file expected
            assert.ifError(e1);
            put(driver, Buffer.alloc(64, 74), function (e2, r2) {    // spilled, then released to zero + file removed
                assert.ifError(e2);
                fs.unlinkSync(nodePath.join(root, r2.key));
                driver.release(r2.key, function () {
                    backdateCreated(root, r1.key, 10000);
                    backdateCreated(root, r2.key, 10000);
                    driver.verify(function (err, rep) {
                        assert.ifError(err);
                        assert.equal(rep.findingCounts.rowsWithoutFiles, 0,
                            'inline rows have no file by design; zero-ref rows are the sweep\'s to self-heal');
                        driver.close();
                        done();
                    });
                });
            });
        });
    });

    it('fix unlinks ONLY files-without-rows; loss evidence is preserved', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root, { sweepGrace: 60 });
        var orphanKey = plantOrphan(root, 'ef', 10000);
        put(driver, Buffer.alloc(64, 75), function (e1, r1) {
            assert.ifError(e1);
            fs.unlinkSync(nodePath.join(root, r1.key));
            backdateCreated(root, r1.key, 10000);
            driver.verify({ fix: true }, function (err, rep) {
                assert.ifError(err);
                assert.equal(rep.fixedCount, 1);
                assert.equal(fs.existsSync(nodePath.join(root, orphanKey)), false, 'orphan unlinked');
                assert.equal(rep.findingCounts.rowsWithoutFiles, 1, 'loss evidence still reported');
                driver.stat(r1.key, function (e3, m) {
                    assert.ifError(e3);
                    assert.ok(m && m.refs === 1, 'the loss-evidence ROW is untouched — deleting it would destroy the signal');
                    driver.close();
                    done();
                });
            });
        });
    });

    it('without fix, nothing is unlinked (the mutation control)', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root, { sweepGrace: 60 });
        var orphanKey = plantOrphan(root, '01', 10000);
        driver.verify(function (err, rep) {
            assert.ifError(err);
            assert.equal(rep.findingCounts.filesWithoutRows, 1);
            assert.ok(fs.existsSync(nodePath.join(root, orphanKey)), 'report-only must not touch the tree');
            assert.equal(rep.fixedCount, 0);
            driver.close();
            done();
        });
    });

    it('degrades to the files direction over a store without listKeys (rowsChecked:false)', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root, { sweepGrace: 60, store: stubRefcountStore() });
        var orphanKey = plantOrphan(root, '23', 10000);
        driver.verify(function (err, rep) {
            assert.ifError(err);
            assert.equal(rep.rowsChecked, false, 'a store lacking listKeys cannot back the rows direction');
            assert.equal(rep.findingCounts.filesWithoutRows, 1, 'the files direction still works');
            assert.equal(rep.findings[0].key, orphanKey);
            driver.close();
            done();
        });
    });

    it('a clean root reports clean (the negative control)', function (t, done) {
        var root = mkRoot();
        var driver = freshCas(root, { sweepGrace: 60 });
        put(driver, Buffer.alloc(64, 76), function (e1, r1) {
            assert.ifError(e1);
            backdateCreated(root, r1.key, 10000);
            driver.verify(function (err, rep) {
                assert.ifError(err);
                assert.equal(rep.findingCounts.filesWithoutRows, 0);
                assert.equal(rep.findingCounts.rowsWithoutFiles, 0);
                assert.equal(rep.checked.files, 1);
                assert.ok(rep.checked.rows >= 1);
                driver.close();
                done();
            });
        });
    });
});


describe('09 - /_gina/storage/* endpoint pins (server.js, engine-agnostic)', function () {

    // ANCHOR → SLICE → ASSERT (the server.test.js idiom). The block is
    // anchored on the family BANNER, not on the first URL regex — each
    // handler's method check sits on the line BEFORE its regex, so a
    // regex-anchored slice would exclude the stats method line (the
    // release-watch pins anchor on their banner for the same reason).
    var bannerAt  = SERVER_SRC.indexOf('/_gina/storage/* — storage maintenance');
    var statsAt   = SERVER_SRC.indexOf('_gina\\/storage\\/stats');
    var gcAt      = SERVER_SRC.indexOf('_gina\\/storage\\/gc');
    var verifyAt  = SERVER_SRC.indexOf('_gina\\/storage\\/verify');
    var releaseAt = SERVER_SRC.indexOf('/_gina/release/* — stale built-release watch');
    var jobsAt    = SERVER_SRC.indexOf('_gina\\/jobs\\/([A-Za-z0-9_-]+)');

    it('all three URL regexes exist, ^-anchored (the RW-F9 lesson), between jobs and release', function () {
        assert.ok(bannerAt > -1, 'the storage family banner expected');
        assert.ok(statsAt > -1 && gcAt > -1 && verifyAt > -1, 'stats/gc/verify regex anchors expected');
        assert.ok(statsAt < gcAt && gcAt < verifyAt, 'declaration order: stats, gc, verify');
        assert.ok(jobsAt > -1 && bannerAt > jobsAt, 'the family sits after the jobs handler');
        assert.ok(releaseAt > verifyAt, 'the family sits before the release-watch banner (its pins slice from that banner)');
        assert.ok(SERVER_SRC.indexOf('/^\\/_gina\\/storage\\/stats(\\?.*)?$/i') > -1, 'stats pattern is ^-anchored');
        assert.ok(SERVER_SRC.indexOf('/^\\/_gina\\/storage\\/gc(\\?.*)?$/i') > -1, 'gc pattern is ^-anchored');
        assert.ok(SERVER_SRC.indexOf('/^\\/_gina\\/storage\\/verify(\\?.*)?$/i') > -1, 'verify pattern is ^-anchored');
    });

    var blk = SERVER_SRC.slice(bannerAt, releaseAt);

    it('every endpoint is admin-gated with the canonical 403 deny; NO dev gate', function () {
        assert.equal((blk.match(/lib\.admin\.isClientAllowed\(request\)/g) || []).length, 3, 'one admin gate per endpoint');
        ['stats', 'gc', 'verify'].forEach(function (ep) {
            assert.ok(blk.indexOf('/_gina/storage/' + ep + ': client IP not in app.json admin.allowFrom') > -1,
                'canonical deny message expected for ' + ep);
        });
        assert.ok(blk.indexOf('NODE_ENV_IS_DEV') === -1, 'always-on: operational tooling carries no dev gate');
    });

    it('methods — stats GET, gc POST (a gc pass is a mutation), verify GET', function () {
        var localStats  = blk.indexOf('_gina\\/storage\\/stats');
        var localGc     = blk.indexOf('_gina\\/storage\\/gc');
        var localVerify = blk.indexOf('_gina\\/storage\\/verify');
        assert.ok(blk.lastIndexOf("=== 'GET'", localStats) > -1, 'stats is GET');
        assert.ok(blk.slice(localStats, localGc).indexOf("=== 'POST'") > -1, 'gc is POST');
        assert.ok(blk.slice(localGc, localVerify).indexOf("=== 'GET'") > -1, 'verify is GET');
    });

    it('enumeration goes through lib.storage.list() + get() — never a config re-read', function () {
        assert.equal((blk.match(/lib\.storage\.list\(\)/g) || []).length, 3, 'each endpoint enumerates the BUILT drivers');
        assert.ok(blk.indexOf('lib.storage.get(') > -1);
        assert.ok(blk.indexOf('lib.storage.isStarted()') > -1, 'the configured flag comes from module state');
    });

    it('gc parses ?dryRun= and drains: loops the batch-capped pass until drained, hard-bounded', function () {
        assert.ok(blk.indexOf("get('dryRun')") > -1, 'dryRun parsed from the query');
        assert.ok(blk.indexOf('sweepNow({ dryRun: true }') > -1, 'dry-run rides the driver verb');
        assert.ok(blk.indexOf('_stoGcPasses < 1000') > -1, 'the drain loop is hard-bounded');
        assert.ok(blk.indexOf('setImmediate(_stoGcLoop)') > -1, 'the drain loop yields between passes');
    });

    it('verify over HTTP is REPORT-ONLY: the handler never even parses a fix flag', function () {
        var verifyBlk = blk.slice(blk.indexOf('_gina\\/storage\\/verify'));
        assert.ok(verifyBlk.indexOf("get('fix')") === -1, 'no fix param parsing');
        assert.ok(verifyBlk.indexOf('fix: true') === -1, 'no fix option reaches the driver');
        assert.ok(/_stoVerDrv\.verify\(function/.test(verifyBlk), 'verify is called with the callback only');
    });

    it('a driver without the verb is named-and-skipped, never an error', function () {
        assert.ok(blk.indexOf("skipped: true, reason: 'this driver\\'s strategy has no sweep") > -1, 'gc skip entry');
        assert.ok(blk.indexOf("skipped: true, reason: 'verify is cas-only in v1'") > -1, 'verify skip entry');
        assert.ok(blk.indexOf('typeof _stoGcDrv.sweepNow !== \'function\'') > -1, 'capability-probed, not strategy-string-matched');
    });
});


describe('10 - endpoint gc drain loop: pure replica', function () {

    // Replica of the _stoGcLoop shape (pinned above so drift is caught):
    // loop the batch-capped pass, accumulate, stop on drained or the bound.
    function drain(sweepNow, bound, fn) {
        var total = 0, passes = 0;
        var loop = function () {
            sweepNow(function (err, res) {
                if (err) { return fn(err); }
                total += res.collected;
                passes++;
                if ( !res.drained && passes < bound ) { return setImmediate(loop); }
                fn(null, { collected: total, drained: res.drained, passes: passes });
            });
        };
        loop();
    }

    it('accumulates across passes and stops on drained', function (t, done) {
        var feed = [ { collected: 100, drained: false }, { collected: 100, drained: false }, { collected: 3, drained: true } ];
        drain(function (cb) { cb(null, feed.shift()); }, 1000, function (err, res) {
            assert.ifError(err);
            assert.deepEqual(res, { collected: 203, drained: true, passes: 3 });
            done();
        });
    });

    it('the bound stops a never-draining store and reports drained:false honestly', function (t, done) {
        drain(function (cb) { cb(null, { collected: 100, drained: false }); }, 5, function (err, res) {
            assert.ifError(err);
            assert.deepEqual(res, { collected: 500, drained: false, passes: 5 });
            done();
        });
    });
});


describe('11 - storage:stats cmd pins', function () {

    it('module shape: constructor, CmdHelper wiring, isCmdConfigured gate', function () {
        assert.match(STATS_SRC, /module\.exports\s*=\s*Stats;?/);
        assert.match(STATS_SRC, /function\s+Stats\s*\(\s*opt\s*,\s*cmd\s*\)\s*\{/);
        assert.match(STATS_SRC, /new CmdHelper\(self, opt\.client, \{ port: opt\.debugPort, brkEnabled: opt\.debugBrkEnabled \}\)/);
        assert.match(STATS_SRC, /if \(!isCmdConfigured\(\)\) return false;/);
    });

    it('reaches the storage module via the lib registry (bare lib/storage does not resolve in daemon scope)', function () {
        assert.ok(STATS_SRC.indexOf("require('../../index').storage") > -1);
        assert.ok(STATS_SRC.indexOf("require('lib/storage')") < 0);
    });

    it('captures --driver= and --format= via the argv pre-scan idiom', function () {
        assert.match(STATS_SRC, /\/\^\\-\\-driver\\=\/\.test\(process\.argv\[i\]\)/);
        assert.match(STATS_SRC, /\/\^\\-\\-format\\=\/\.test\(process\.argv\[i\]\)/);
    });

    it('probes via the port-candidates walk, advancing on ECONNREFUSED', function () {
        assert.ok(STATS_SRC.indexOf("self.portsReverseData[bundle + '@' + self.projectName]") > -1);
        assert.ok(STATS_SRC.indexOf('self.projects[self.projectName].def_env') > -1);
        assert.match(STATS_SRC, /err\.code === 'ECONNREFUSED'/);
        assert.ok(STATS_SRC.indexOf("'/_gina/storage/stats'") > -1);
    });

    it('a timeout or socket error NEVER falls back to offline (the store may be owned by a live process)', function () {
        assert.equal((STATS_SRC.match(/not opening its store offline/g) || []).length, 2, 'both the timeout and the error path refuse');
    });

    it('offline builds the REAL driver through the boot seams, sweep timer off, without creating a missing root', function () {
        assert.ok(STATS_SRC.indexOf('storageLib._resolveDriverConf(d)') > -1);
        assert.ok(STATS_SRC.indexOf('resolved.sweepInterval = 0') > -1);
        assert.ok(STATS_SRC.indexOf('storageLib._createEmbeddedMetaStore(nodePath.join(d.root') > -1);
        assert.ok(STATS_SRC.indexOf('storageLib._FACTORIES[d.strategy](name, resolved, metaStore)') > -1);
        assert.match(STATS_SRC, /if \( !fs\.existsSync\(d\.root\) \) \{[\s\S]{0,200}?missingRoot/,
            'a stats read must report a missing root, never mkdir it');
        assert.ok(STATS_SRC.indexOf('requireJSON(settingsPath)') > -1, 'settings.json carries comments — requireJSON, never require');
        assert.ok(STATS_SRC.indexOf('storageLib.validateConfig(block)') > -1, 'the offline path lints before building');
    });

    it('connector-backed stores are named-and-skipped offline', function () {
        assert.ok(STATS_SRC.indexOf('nothing local to open; start the bundle and re-run') > -1);
    });

    it('JSON output is pipe-safe (fs.writeSync before the exit)', function () {
        assert.ok(STATS_SRC.indexOf('fs.writeSync(1, JSON.stringify(envelope)') > -1);
    });
});


describe('12 - storage:gc cmd pins', function () {

    it('POSTs /_gina/storage/gc with the dryRun/driver query', function () {
        assert.ok(GC_SRC.indexOf("'/_gina/storage/gc'") > -1);
        assert.match(GC_SRC, /method\s*:\s*'POST'/);
        assert.ok(GC_SRC.indexOf("query.push('dryRun=1')") > -1);
    });

    it('captures --dry-run via the argv pre-scan idiom', function () {
        assert.match(GC_SRC, /\/\^\\-\\-dry-run\$\/\.test\(process\.argv\[i\]\)/);
        assert.match(GC_SRC, /self\.dryRun = true;/);
    });

    it('offline drains through the driver verb: sweepNow looped until drained, hard-bounded', function () {
        assert.ok(GC_SRC.indexOf('driver.sweepNow({ dryRun: true }') > -1);
        assert.ok(GC_SRC.indexOf('passes < 1000') > -1);
        assert.match(GC_SRC, /if \( !res\.drained && passes < 1000 \)/);
    });

    it('sharded drivers and connector stores are named-and-skipped offline', function () {
        assert.ok(GC_SRC.indexOf("this driver\\'s strategy has no sweep") > -1);
        assert.ok(GC_SRC.indexOf('nothing local to open') > -1);
    });

    it('the response timeout is the long class (the server drains before answering), not the 5s probe class', function () {
        assert.match(GC_SRC, /timeout\s*:\s*120000/);
    });

    it('a timeout or socket error NEVER falls back to offline', function () {
        assert.equal((GC_SRC.match(/not opening its store offline/g) || []).length, 2);
    });
});


describe('13 - storage:verify cmd pins', function () {

    it('GETs /_gina/storage/verify (report-only over HTTP)', function () {
        assert.ok(VERIFY_SRC.indexOf("'/_gina/storage/verify'") > -1);
        assert.match(VERIFY_SRC, /method\s*:\s*'GET'/);
    });

    it('--fix while the bundle RUNS is refused with the stop-the-bundle message', function () {
        assert.ok(VERIFY_SRC.indexOf('--fix refused while the bundle runs') > -1);
        assert.match(VERIFY_SRC, /outcome\.mode === 'running' && self\.fix/, 'the refusal keys on the RUNNING outcome');
    });

    it('--fix is honoured on the OFFLINE path only, through the driver verb', function () {
        assert.ok(VERIFY_SRC.indexOf('driver.verify({ fix: self.fix }') > -1);
        assert.match(VERIFY_SRC, /\/\^\\-\\-fix\$\/\.test\(process\.argv\[i\]\)/);
    });

    it('a timeout or socket error NEVER falls back to offline', function () {
        assert.equal((VERIFY_SRC.match(/not opening its store offline/g) || []).length, 2);
    });

    it('loss evidence is presented as such in the text output', function () {
        assert.ok(VERIFY_SRC.indexOf('LOSS EVIDENCE') > -1);
        assert.ok(VERIFY_SRC.indexOf('never auto-fixed') > -1);
    });
});


describe('14 - registration + help surfaces', function () {

    it('storage: is in bin/cli allowedOffline (the hard gate — a topic dir alone is unreachable)', function () {
        var atList = CLI_SRC.indexOf('var allowedOffline = [');
        var atEnd  = CLI_SRC.indexOf('];', atList);
        assert.ok(atList > -1 && atEnd > atList, 'allowedOffline array expected in bin/cli');
        var arr = CLI_SRC.slice(atList, atEnd);
        assert.ok(arr.indexOf("'storage:'") > -1, "'storage:' must join allowedOffline");
    });

    it('arguments.json whitelists exactly the four flags (else CmdHelper reads them as bundle names)', function () {
        assert.deepEqual(ARGS_ARR, ['--driver', '--dry-run', '--fix', '--format']);
    });

    it('help.txt documents all three verbs and every flag it names is implemented', function () {
        ['storage:stats', 'storage:gc', 'storage:verify'].forEach(function (verb) {
            assert.ok(HELP_TXT.indexOf(verb) > -1, verb + ' documented');
        });
        ['--driver', '--dry-run', '--fix', '--format'].forEach(function (flag) {
            assert.ok(HELP_TXT.indexOf(flag) > -1, flag + ' documented');
        });
        assert.ok(HELP_TXT.indexOf('bundle must be STOPPED') > -1, 'the --fix offline-only constraint is stated');
        assert.ok(HELP_TXT.indexOf('LOSS EVIDENCE') > -1, 'the asymmetry is stated');
        assert.ok(HELP_TXT.indexOf('admin.allowFrom') > -1, 'the admin gating is stated');
    });

    it('the handlers exist at the dispatch-convention paths (the existsSync route)', function () {
        ['stats.js', 'gc.js', 'verify.js', 'help.txt', 'arguments.json'].forEach(function (f) {
            assert.ok(fs.existsSync(nodePath.join(FW, 'lib', 'cmd', 'storage', f)), f + ' expected under lib/cmd/storage/');
        });
    });
});
