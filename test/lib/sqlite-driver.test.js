/**
 * lib/sqlite-driver — the SQLite driver resolver seam.
 *
 * Runs under Node (the suite is Node-only by design), so the bun:sqlite
 * branch is exercised through `makeAdapter()` with a stand-in module that
 * encodes bun:sqlite's MEASURED contract (probe 2026-07-28, bun 1.2.21 +
 * oven/bun:1.3.14, node:sqlite as the control):
 *
 *   - `new Database(path)` creates the file when missing
 *   - statements expose get/all/run, callable via `.apply` with positional
 *     args (null bindings included)
 *   - `run()` returns `{ changes: number, lastInsertRowid: number }`
 *   - errors are `SQLiteError` with the numeric SQLite result code on
 *     `errno` (extended codes included) and a specific string on `code`
 *     (e.g. 'SQLITE_BUSY'), and NO `errcode` — where node:sqlite carries
 *     the numeric code on `errcode` with code 'ERR_SQLITE_ERROR'.
 *
 * The real-bun validation lives outside this suite (the parity probe is
 * re-runnable in the oven/bun container); these tests lock the seam's
 * resolution order, the adapter's mapping, and the four consumer swaps.
 */
'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW = require('../fw');
var DRIVER_PATH = path.join(FW, 'lib/sqlite-driver.js');
var driver = require(DRIVER_PATH);
var classify = require(path.join(FW, 'lib/connector-error/src/main.js')).classify;

describe('01 - sqlite-driver: source pins', function () {

    var src;
    it('loads the source', function () {
        src = fs.readFileSync(DRIVER_PATH, 'utf8');
        assert.ok(src.length > 0);
    });

    // NB: order pins anchor on CODE-unique strings — the JSDoc @example blocks
    // legitimately contain require('bun:sqlite') prose, so bare indexOf on the
    // require form would trip the own-comment trap.
    it('tries node:sqlite FIRST (self-retiring order — before the bun:sqlite code require)', function () {
        var iNode = src.indexOf("var nodeSqlite = require('node:sqlite');");
        var iBun  = src.indexOf("bunSqlite = require('bun:sqlite');");
        assert.ok(iNode > -1, 'node:sqlite code require present');
        assert.ok(iBun > -1, 'bun:sqlite code require present');
        assert.ok(iNode < iBun, 'node:sqlite tried before bun:sqlite');
    });

    it('gates the bun:sqlite branch on isBun()', function () {
        var iGate = src.indexOf('if (runtime.isBun()) {');
        var iBun  = src.indexOf("bunSqlite = require('bun:sqlite');");
        assert.ok(iGate > -1, 'isBun() gate present in code');
        assert.ok(iGate < iBun, 'isBun() gate precedes the bun:sqlite code require');
    });

    it('normalizes bun errors by stamping errcode from the numeric errno', function () {
        assert.ok(/typeof e\.errno === 'number'/.test(src));
        assert.ok(/e\.errcode = e\.errno/.test(src));
    });

    it('keeps the historical Node error-message shape for the no-driver throw', function () {
        assert.ok(/node:sqlite requires Node\.js >= 22\.5\.0\. /.test(src));
        assert.ok(/'Current: ' \+ process\.version/.test(src));
    });

    it('pulls in no third-party driver (known-negative)', function () {
        assert.ok(!/require\('better-sqlite3'\)/.test(src));
        assert.ok(!/require\('sqlite3'\)/.test(src));
    });
});

describe('02 - sqlite-driver: Node resolution path (real node:sqlite)', function () {

    it('getDatabaseSync() returns node:sqlite\'s DatabaseSync verbatim (zero Node delta)', function () {
        var native = require('node:sqlite').DatabaseSync;
        assert.equal(driver.getDatabaseSync(), native);
    });

    it('memoizes the resolution', function () {
        assert.equal(driver.getDatabaseSync(), driver.getDatabaseSync());
    });
});

/**
 * Stand-in for bun:sqlite's Database, encoding the measured contract.
 * Records calls so forwarding + `.apply` positional passing can be asserted.
 */
function makeFakeBunSqlite(opts) {
    opts = opts || {};
    var calls = { constructed: [], exec: [], prepared: [], get: [], all: [], run: [], closed: 0 };

    function SQLiteError(message, code, errno) {
        var e = new Error(message);
        e.name  = 'SQLiteError';
        e.code  = code;
        e.errno = errno; // numeric SQLite result code — bun's field (measured)
        return e;
    }

    function FakeDatabase(location) {
        calls.constructed.push(location);
        if (opts.throwOnConstruct) throw SQLiteError('unable to open database file', 'SQLITE_CANTOPEN', 14);
    }
    FakeDatabase.prototype.exec = function (sql) {
        calls.exec.push(sql);
        if (opts.throwOnExec) throw SQLiteError('database is locked', 'SQLITE_BUSY', opts.execErrno != null ? opts.execErrno : 5);
    };
    FakeDatabase.prototype.prepare = function (sql) {
        calls.prepared.push(sql);
        return {
            get: function () {
                calls.get.push(Array.prototype.slice.call(arguments));
                if (opts.throwOnGet) throw SQLiteError('database is locked', 'SQLITE_BUSY', 5);
                return (opts.getReturns !== undefined) ? opts.getReturns : null; // bun returns null on miss (adapter maps to undefined)
            },
            all: function () {
                calls.all.push(Array.prototype.slice.call(arguments));
                return opts.allReturns || [];
            },
            run: function () {
                calls.run.push(Array.prototype.slice.call(arguments));
                if (opts.throwOnRun) {
                    var e = SQLiteError('UNIQUE constraint failed: t.id', 'SQLITE_CONSTRAINT_PRIMARYKEY', 1555);
                    if (opts.runErrExtras) Object.assign(e, opts.runErrExtras);
                    throw e;
                }
                return { changes: 1, lastInsertRowid: 42 };
            }
        };
    };
    FakeDatabase.prototype.close = function () { calls.closed++; };

    return { module: { Database: FakeDatabase }, calls: calls };
}

describe('03 - sqlite-driver: bun adapter (fake bun:sqlite encoding the measured contract)', function () {

    it('constructs, execs, prepares, closes — all forwarded', function () {
        var fake = makeFakeBunSqlite();
        var Adapter = driver.makeAdapter(fake.module);
        var db = new Adapter('/tmp/x.db');
        db.exec('PRAGMA journal_mode=WAL');
        db.prepare('SELECT 1');
        db.close();
        assert.deepEqual(fake.calls.constructed, ['/tmp/x.db']);
        assert.deepEqual(fake.calls.exec, ['PRAGMA journal_mode=WAL']);
        assert.deepEqual(fake.calls.prepared, ['SELECT 1']);
        assert.equal(fake.calls.closed, 1);
    });

    it('tolerates expando properties on the handle (connector.js stamps _file/_name)', function () {
        var fake = makeFakeBunSqlite();
        var Adapter = driver.makeAdapter(fake.module);
        var db = new Adapter('/tmp/x.db');
        db._file = '/tmp/x.db';
        db._name = 'probe';
        assert.equal(db._file, '/tmp/x.db');
        assert.equal(db._name, 'probe');
    });

    it('statement methods forward positional args via .apply — null bindings included (the gina call shape)', function () {
        var fake = makeFakeBunSqlite();
        var Adapter = driver.makeAdapter(fake.module);
        var stmt = new Adapter('/tmp/x.db').prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?)');
        var args = ['j1', 'queued', null, 1753700000000, '{"x":1}'];
        stmt.run.apply(stmt, args);
        assert.deepEqual(fake.calls.run, [args]);
    });

    it('get(): bun\'s null miss is mapped to node\'s undefined; a hit passes through', function () {
        var fake = makeFakeBunSqlite();
        var Adapter = driver.makeAdapter(fake.module);
        var stmt = new Adapter('/tmp/x.db').prepare('SELECT 1');
        assert.equal(stmt.get('missing'), undefined);

        var hit = makeFakeBunSqlite({ getReturns: { record: '{"x":1}', expires_at: null } });
        var stmt2 = new (driver.makeAdapter(hit.module))('/tmp/x.db').prepare('SELECT 1');
        assert.deepEqual(stmt2.get('j1'), { record: '{"x":1}', expires_at: null });
    });

    it('run(): passes { changes, lastInsertRowid } through — the "changes" in r contract holds', function () {
        var fake = makeFakeBunSqlite();
        var Adapter = driver.makeAdapter(fake.module);
        var r = new Adapter('/tmp/x.db').prepare('DELETE FROM t').run();
        assert.equal(typeof r.changes, 'number');
        assert.ok('changes' in r);
        assert.equal(typeof r.lastInsertRowid, 'number');
    });

    it('all(): arrays pass through, empty stays an empty array', function () {
        var fake = makeFakeBunSqlite({ allReturns: [{ id: 'j1' }] });
        var Adapter = driver.makeAdapter(fake.module);
        var db = new Adapter('/tmp/x.db');
        assert.deepEqual(db.prepare('SELECT id FROM t').all('queued'), [{ id: 'j1' }]);
        var empty = makeFakeBunSqlite();
        assert.deepEqual(new (driver.makeAdapter(empty.module))('/tmp/x.db').prepare('SELECT 1').all(), []);
    });
});

describe('04 - sqlite-driver: error normalization (errcode stamped from errno)', function () {

    it('a busy error thrown by run() gains errcode === errno (5), keeping name/code/message', function () {
        var fake = makeFakeBunSqlite({ throwOnExec: true });
        var Adapter = driver.makeAdapter(fake.module);
        var db = new Adapter('/tmp/x.db');
        var caught = null;
        try { db.exec('BEGIN IMMEDIATE'); } catch (e) { caught = e; }
        assert.ok(caught, 'threw');
        assert.equal(caught.errcode, 5);
        assert.equal(caught.errno, 5);
        assert.equal(caught.code, 'SQLITE_BUSY');
        assert.equal(caught.name, 'SQLiteError');
        assert.match(caught.message, /database is locked/);
    });

    it('extended codes survive (261 SQLITE_BUSY_RECOVERY -> errcode 261)', function () {
        var fake = makeFakeBunSqlite({ throwOnExec: true, execErrno: 261 });
        var db = new (driver.makeAdapter(fake.module))('/tmp/x.db');
        var caught = null;
        try { db.exec('BEGIN'); } catch (e) { caught = e; }
        assert.equal(caught.errcode, 261);
    });

    it('a pre-existing errcode is never overwritten', function () {
        var e = new Error('x');
        e.errno = 5;
        e.errcode = 99;
        driver._normalizeBunSqliteError(e);
        assert.equal(e.errcode, 99);
    });

    it('a non-numeric errno is not stamped (socket-style string errnos stay untouched)', function () {
        var e = new Error('x');
        e.errno = 'ECONNRESET';
        driver._normalizeBunSqliteError(e);
        assert.equal(typeof e.errcode, 'undefined');
    });

    it('END-TO-END: the REAL lib/connector-error classifier reads normalized bun errors like node errors', function () {
        // busy (5) -> transient sqlite:busy via the numeric-errcode branch
        var busy = makeFakeBunSqlite({ throwOnExec: true });
        var db = new (driver.makeAdapter(busy.module))('/tmp/x.db');
        var e1 = null;
        try { db.exec('BEGIN IMMEDIATE'); } catch (e) { e1 = e; }
        var v1 = classify(e1);
        assert.equal(v1.isTransient, true);
        assert.equal(v1.reason, 'sqlite:busy');

        // extended busy (261) -> still transient via the primary-code low byte
        var busyRec = makeFakeBunSqlite({ throwOnExec: true, execErrno: 261 });
        var db2 = new (driver.makeAdapter(busyRec.module))('/tmp/x.db');
        var e2 = null;
        try { db2.exec('BEGIN'); } catch (e) { e2 = e; }
        // strip bun's specific string code so the numeric branch is what discriminates
        // (a real SQLITE_BUSY_RECOVERY carries code 'SQLITE_BUSY_RECOVERY', absent
        //  from the string table — the numeric errcode is what classifies it)
        assert.equal(e2.code, 'SQLITE_BUSY'); // fake models the plain-string case
        e2.code = 'SQLITE_BUSY_RECOVERY';
        var v2 = classify(e2);
        assert.equal(v2.isTransient, true, 'extended busy classifies transient through errcode & 0xff');

        // constraint (1555) -> NOT transient (permanent)
        var dup = makeFakeBunSqlite({ throwOnRun: true });
        var stmt = new (driver.makeAdapter(dup.module))('/tmp/x.db').prepare('INSERT INTO t VALUES (?)');
        var e3 = null;
        try { stmt.run('j1'); } catch (e) { e3 = e; }
        assert.equal(e3.errcode, 1555);
        var v3 = classify(e3);
        assert.equal(v3.isTransient, false, 'a constraint violation stays permanent');
    });

    it('SUBTRACT: the same bun-shaped busy error WITHOUT normalization is what the adapter protects against', function () {
        // Raw bun error with an extended-code string and no errcode: the string
        // table misses it and the numeric branch has nothing to read.
        var raw = new Error('database is locked');
        raw.name  = 'SQLiteError';
        raw.code  = 'SQLITE_BUSY_RECOVERY';
        raw.errno = 261;
        var v = classify(raw);
        assert.equal(v.isTransient, false, 'un-normalized extended bun error mis-classifies — the stamp is load-bearing');
    });
});

describe('05 - sqlite-driver: the four consumers resolve through the seam', function () {

    var CONSUMERS = [
        { file: 'core/connectors/sqlite/lib/connector.js',     rel: /require\('\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/sqlite-driver'\)\.getDatabaseSync\(\)/ },
        { file: 'core/connectors/sqlite/lib/session-store.js', rel: /require\('\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/sqlite-driver'\)\.getDatabaseSync\(\)/ },
        { file: 'core/connectors/sqlite/lib/job-store.js',     rel: /require\('\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/sqlite-driver'\)\.getDatabaseSync\(\)/ },
        { file: 'lib/state.js',                                rel: /require\('\.\/sqlite-driver'\)\.getDatabaseSync\(\)/ }
    ];

    CONSUMERS.forEach(function (c) {
        it(c.file + ' resolves through lib/sqlite-driver and keeps no direct node:sqlite require', function () {
            var src = fs.readFileSync(path.join(FW, c.file), 'utf8');
            assert.ok(c.rel.test(src), 'seam require present');
            assert.ok(!/require\('node:sqlite'\)/.test(src), 'no direct node:sqlite require remains');
        });
    });

    it('the seam relative path actually resolves from the connector tree (no drift)', function () {
        var resolved = require.resolve(path.join(FW, 'core/connectors/sqlite/lib', './../../../../lib/sqlite-driver'));
        assert.equal(resolved, DRIVER_PATH);
    });
});


/**
 * #B829 — Node 26.11.0 renamed node:sqlite's class from `DatabaseSync` to
 * `Database` and deprecated the old name (DEP0210). The seam takes `Database`
 * where the module exports it and `DatabaseSync` everywhere else, so it keeps
 * resolving on a runtime that has dropped the old name.
 *
 * The stand-in arms run the SHIPPED text of `getDatabaseSync()` with a stand-in
 * `require`. Every free identifier the function reads is passed in, and a
 * control arm checks that the lifted copy behaves like the module on the real
 * runtime before the stand-in readings count.
 */
describe('06 - sqlite-driver: the class is taken under its current name (#B829)', function () {

    var src = fs.readFileSync(DRIVER_PATH, 'utf8');

    /** The source without its block comments and full-line comments. */
    function stripComments(text) {
        return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    }

    /** The shipped `getDatabaseSync` text, compiled with `fakeRequire` and an empty memo. */
    function liftedResolver(fakeRequire) {
        return (new Function('require', '_DatabaseSync', 'makeAdapter', '__dirname',
            'return (' + driver.getDatabaseSync.toString() + ')'))(
            fakeRequire, null, driver.makeAdapter, path.dirname(DRIVER_PATH));
    }

    /** A `require` whose `node:sqlite` is `mod`; every other id goes to the real one. */
    function requireOf(mod) {
        return function (id) {
            if (id === 'node:sqlite') return mod;
            return require(id);
        };
    }

    it('control — the lifted copy resolves what the module resolves on this runtime', function () {
        var lifted = liftedResolver(require)();
        var real   = driver.getDatabaseSync();
        if (real.name === 'BunDatabaseSync') {
            // Bun < 1.4: every makeAdapter() call builds a class of its own.
            assert.equal(lifted.name, 'BunDatabaseSync');
        } else {
            assert.equal(lifted, real);
        }
    });

    it('resolves the class on a runtime that exports it as Database only (the old name removed)', function () {
        function Renamed() {}
        assert.equal(liftedResolver(requireOf({ Database: Renamed }))(), Renamed);
    });

    it('takes Database, not the deprecated name, when the two are different classes', function () {
        function Current() {}
        function Old() {}
        assert.equal(liftedResolver(requireOf({ Database: Current, DatabaseSync: Old }))(), Current);
    });

    it('control — resolves the one class a runtime exports under both names (Node >= 26.11.0)', function () {
        function Both() {}
        assert.equal(liftedResolver(requireOf({ Database: Both, DatabaseSync: Both }))(), Both);
    });

    it('control — falls back to DatabaseSync where the runtime has no Database export', function () {
        function Old() {}
        assert.equal(liftedResolver(requireOf({ DatabaseSync: Old }))(), Old);
    });

    it('the code takes the class in one place, Database first, and never through the old name alone', function () {
        var code = stripComments(src);
        assert.ok(src.indexOf('DatabaseSync') > -1, 'control — the raw text still names the old class');
        assert.ok(code.indexOf("require('node:sqlite').DatabaseSync") < 0, 'the retired shape is gone from the code');
        var sites = code.match(/_DatabaseSync\s*=\s*nodeSqlite\.Database\s*\|\|\s*nodeSqlite\.DatabaseSync\s*;/g) || [];
        assert.equal(sites.length, 1, 'one resolution site, Database first');
    });
});
