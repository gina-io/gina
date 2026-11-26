'use strict';
/**
 * #B1169 — the SQLite connector reads rows from every statement that returns rows.
 *
 * `core/connectors/sqlite/index.js` chose between `all()` / `get()` and `run()`
 * from a leading `SELECT` alone, so a `.sql` method starting with `WITH`,
 * `VALUES` or `PRAGMA` ran with `run()` and returned `{ changes,
 * lastInsertRowid }` instead of its rows, with no error. The connector now asks
 * the prepared statement once (`statementReturnsRows`): its `columns()` on
 * node:sqlite (Node 22.16.0 / 23.11.0 and later), its `reader` flag on
 * bun:sqlite through the adapter in `lib/sqlite-driver`, and the leading keyword
 * (SELECT, WITH, VALUES, PRAGMA, EXPLAIN) where the statement offers neither.
 *
 * Arms:
 *   §00 INSTRUMENT     - the decision is extracted from the connector's source,
 *                        exactly once, braces balanced; the extractor and the
 *                        comment filter can fail                  [red pre-fix]
 *   §01 the decision   - fake statements: columns() first, reader second, the
 *                        keyword last; a columns() that throws or answers with
 *                        no array falls through                   [red pre-fix]
 *   §02 the wiring     - the decision is taken once, after prepare(), and both
 *                        execute branches read it; no active line tests a
 *                        leading SELECT any more                  [red pre-fix]
 *   §03 the adapter    - lib/sqlite-driver passes bun:sqlite's reader through
 *                        (a fake bun module); get/all/run unchanged
 *                                                                 [red pre-fix]
 *   §04 the connector, end to end - an in-memory database from the driver gina
 *                        resolves, `.sql` methods built by the REAL factory:
 *                        WITH, VALUES and PRAGMA reads return their rows under
 *                        each annotation; a SELECT and a plain INSERT are the
 *                        controls                                 [red pre-fix]
 *   §05 statements the driver can ask - registered only where a prepared
 *                        statement has columns() or a boolean reader: a WITH
 *                        clause feeding an INSERT runs once and returns
 *                        { changes, lastInsertRowid }; INSERT … RETURNING runs
 *                        once and returns its rows       [RETURNING red pre-fix]
 *
 * Seams (JavaScriptCore runs §00–§03 on a BASE and a fixed copy before any
 * window): GINA_B1169_SQLITE_SRC names the connector source the text arms read;
 * GINA_B1169_DRIVER_SRC names the driver module §03 requires (it has no
 * top-level relative require, so a copy loads). §04 and §05 always load the
 * tree's own connector.
 */

// Must be set BEFORE the connector factory runs: it reads NODE_ENV_IS_DEV per call.
process.env.NODE_ENV_IS_DEV = 'false';

var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');

var FW          = path.resolve(require('../fw'));
var REPO        = path.resolve(__dirname, '../..');
var SQLITE_PATH = path.join(FW, 'core/connectors/sqlite/index.js');
var SQLITE_SRC  = process.env.GINA_B1169_SQLITE_SRC || SQLITE_PATH;
var DRIVER_SRC  = process.env.GINA_B1169_DRIVER_SRC || path.join(FW, 'lib/sqlite-driver.js');

/** @constant {string} the declaration §00 extracts */
var DECL = 'function statementReturnsRows(stmt, queryString) {';

/**
 * Drops every line whose first non-blank characters open a comment (`//`, `/*`,
 * ` *`): the `// was:` records and the JSDoc. A trailing comment after code
 * stays; the needles below never sit in one.
 *
 * @inner
 * @param {string} src - JavaScript source
 * @returns {string} the source without its full-line comments
 */
function activeLines(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\/\*|\*)/.test(l);
    }).join('\n');
}

/**
 * Brace-walks a declaration to its closing brace (the started-flag form: the
 * walk opens on the first `{` at or after the declaration).
 *
 * @inner
 * @param {string} src  - JavaScript source
 * @param {string} decl - the declaration's exact text
 * @returns {string} the function's text, from `function` to its closing brace
 * @throws {Error} when the declaration is absent, not unique, or unbalanced
 */
function extractFn(src, decl) {
    var at = src.indexOf(decl);
    if (at < 0) { throw new Error('declaration not found -> ' + decl); }
    if (src.indexOf(decl, at + 1) > -1) { throw new Error('declaration not unique -> ' + decl); }
    var depth = 0, started = false;
    for (var i = at; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') {
            depth--;
            if (started && depth === 0) { return src.slice(at, i + 1); }
        }
    }
    throw new Error('unbalanced braces extracting ' + decl);
}

/**
 * The connector's own `statementReturnsRows`, compiled from its source text.
 * Closure-free by construction: it reads its two parameters only.
 *
 * @inner
 * @returns {function(?object, string): boolean} the decision
 */
function decision() {
    return new Function('return (' + extractFn(fs.readFileSync(SQLITE_SRC, 'utf8'), DECL) + ');')();
}

/**
 * Returns `value` as a plain JSON value: node:sqlite rows have a null
 * prototype, which a strict deep comparison with an object literal rejects.
 *
 * @inner
 * @param {*} value - a row, a row list, or null
 * @returns {*} the same data, plain
 */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}


// ─── §00 — INSTRUMENT ────────────────────────────────────────────────────────

describe('00 - INSTRUMENT: the decision is extracted from the connector source', function () {

    it('the declaration occurs exactly once and compiles to a function', function () {
        var src = fs.readFileSync(SQLITE_SRC, 'utf8');
        assert.equal(src.split(DECL).length, 2, 'statementReturnsRows must be declared once in the connector');
        assert.equal(typeof decision(), 'function');
    });

    it('CONTROL: the extractor reports an absent declaration', function () {
        assert.throws(function () { extractFn('function a() {}', 'function b() {'); }, /declaration not found/);
    });

    it('CONTROL: the extractor reports unbalanced braces', function () {
        assert.throws(function () { extractFn('function a() { if (x) {', 'function a() {'); }, /unbalanced braces/);
    });

    it('CONTROL: the comment filter drops full-line comments and keeps code', function () {
        assert.equal(activeLines('a();\n// was: isSELECT\n/**\n * isSELECT\n */\nb();'), 'a();\nb();');
    });
});


// ─── §01 — the decision ──────────────────────────────────────────────────────

describe('01 - the decision: columns() first, reader second, the leading keyword last', function () {

    var WRITE_CTE = 'WITH s AS (SELECT ? AS a) INSERT INTO t (a) SELECT a FROM s';
    var RETURNING = 'INSERT INTO t (a) VALUES (?) RETURNING a';

    it('columns() with no column decides "no rows", against a WITH keyword', function () {
        assert.equal(decision()({ columns: function () { return []; } }, WRITE_CTE), false);
    });

    it('columns() with a column decides "rows", against an INSERT keyword', function () {
        assert.equal(decision()({ columns: function () { return [{ name: 'a' }]; } }, RETURNING), true);
    });

    it('columns() that throws falls through to the keyword', function () {
        var stmt = { columns: function () { throw new Error('statement finalized'); } };
        assert.equal(decision()(stmt, 'WITH t AS (SELECT 1 AS a) SELECT a FROM t'), true);
        assert.equal(decision()(stmt, 'DELETE FROM t'), false);
    });

    it('columns() that answers with no array falls through to reader', function () {
        assert.equal(decision()({ columns: function () { return null; }, reader: false }, 'SELECT 1'), false);
    });

    it('reader decides when columns() is absent, against the keyword', function () {
        assert.equal(decision()({ reader: true }, RETURNING), true);
        assert.equal(decision()({ reader: false }, WRITE_CTE), false);
    });

    it('a reader that is not a boolean falls through to the keyword', function () {
        assert.equal(decision()({ reader: undefined }, 'VALUES (1)'), true);
    });

    it('the keyword decides when the statement offers neither', function () {
        var f = decision();
        assert.equal(f({}, 'SELECT 1'), true);
        assert.equal(f({}, '  with t as (select 1 as a) select a from t'), true);
        assert.equal(f({}, 'VALUES (1), (2)'), true);
        assert.equal(f({}, 'PRAGMA user_version'), true);
        assert.equal(f({}, 'EXPLAIN QUERY PLAN SELECT 1'), true);
        assert.equal(f({}, 'INSERT INTO t (a) VALUES (1)'), false);
        assert.equal(f({}, 'UPDATE t SET a = 1'), false);
        assert.equal(f({}, 'CREATE TABLE u (a)'), false);
    });

    it('the keyword is a whole word: WITHOUT is not WITH', function () {
        assert.equal(decision()({}, 'WITHOUT ROWID'), false);
    });

    it('a statement that failed to prepare (null) is decided by the keyword', function () {
        assert.equal(decision()(null, 'VALUES (1)'), true);
        assert.equal(decision()(null, 'DELETE FROM t'), false);
    });
});


// ─── §02 — the wiring ────────────────────────────────────────────────────────

describe('02 - the wiring: decided once after prepare(), read by both execute branches', function () {

    it('the decision is taken once, after prepare() and before execute is defined', function () {
        var active  = activeLines(fs.readFileSync(SQLITE_SRC, 'utf8'));
        var call    = 'var returnsRows = statementReturnsRows(stmt, queryString);';
        var at      = active.indexOf(call);
        assert.ok(at > -1, 'the connector must take the decision with ' + call);
        assert.equal(active.indexOf(call, at + 1), -1, 'the decision must be taken once');
        var prepare = active.indexOf('stmt = conn.prepare(queryString);');
        var execute = active.indexOf('var execute = function(args) {');
        assert.ok(prepare > -1 && execute > -1, 'premise: prepare() and execute are in the connector');
        assert.ok(prepare < at && at < execute, 'the decision must sit between prepare() and execute');
    });

    it('execute reads the decision in its branch and in the no-annotation write case', function () {
        var active = activeLines(fs.readFileSync(SQLITE_SRC, 'utf8'));
        var body   = extractFn(active, 'var execute = function(args) {');
        var branch = body.indexOf('if (returnsRows) {');
        assert.ok(branch > -1, 'execute must branch on returnsRows');
        assert.ok(branch < body.indexOf('stmt.get.apply(stmt, args)') && branch < body.indexOf('stmt.all.apply(stmt, args)'),
            'the returnsRows branch must lead to get() / all()');
        assert.ok(body.indexOf('} else if (!returnType && !returnsRows) {') > -1,
            'the no-annotation write case must read returnsRows');
    });

    it('no active line tests a leading SELECT any more', function () {
        var active = activeLines(fs.readFileSync(SQLITE_SRC, 'utf8'));
        assert.equal(active.indexOf('isSELECT'), -1, 'the SELECT-only classifier must be gone from the code');
    });
});


// ─── §03 — the adapter ───────────────────────────────────────────────────────

/**
 * A stand-in for bun:sqlite's module whose statements carry `reader` as given.
 *
 * @inner
 * @param {*} reader - the value each prepared statement exposes as `reader`;
 *                     `'absent'` leaves the property out
 * @returns {{module: object, calls: object}} the fake module and its call log
 */
function fakeBun(reader) {
    var calls = { get: 0, all: 0, run: 0 };
    function Database() {}
    Database.prototype.prepare = function () {
        var stmt = {
            get: function () { calls.get++; return null; },
            all: function () { calls.all++; return [{ a: 1 }]; },
            run: function () { calls.run++; return { changes: 1, lastInsertRowid: 1 }; }
        };
        if (reader !== 'absent') { stmt.reader = reader; }
        return stmt;
    };
    Database.prototype.exec  = function () {};
    Database.prototype.close = function () {};
    return { module: { Database: Database }, calls: calls };
}

describe('03 - the adapter passes bun:sqlite\'s reader through', function () {

    var driver = require(DRIVER_SRC);

    it('a statement whose reader is true reads true through the adapter', function () {
        var A = driver.makeAdapter(fakeBun(true).module);
        assert.equal(new A(':memory:').prepare('INSERT INTO t (a) VALUES (1) RETURNING a').reader, true);
    });

    it('a statement whose reader is false reads false through the adapter', function () {
        var A = driver.makeAdapter(fakeBun(false).module);
        assert.equal(new A(':memory:').prepare('WITH s AS (SELECT 1 AS a) INSERT INTO t (a) SELECT a FROM s').reader, false);
    });

    it('a Bun whose statements carry no reader leaves it undefined (the keyword then decides)', function () {
        var A = driver.makeAdapter(fakeBun('absent').module);
        var stmt = new A(':memory:').prepare('VALUES (1)');
        assert.equal(typeof stmt.reader, 'undefined');
        assert.equal(decision()(stmt, 'VALUES (1)'), true);
    });

    it('CONTROL: get, all and run still delegate once each', function () {
        var fake = fakeBun(true);
        var stmt = new (driver.makeAdapter(fake.module))(':memory:').prepare('SELECT 1');
        stmt.get(); stmt.all(); stmt.run();
        assert.deepEqual([fake.calls.get, fake.calls.all, fake.calls.run], [1, 1, 1]);
    });
});


// ─── §04 / §05 — the connector, end to end ───────────────────────────────────

var DatabaseSync = null;
var ASKS = false;
try {
    DatabaseSync = require(path.join(FW, 'lib/sqlite-driver.js')).getDatabaseSync();
    var probeDb = new DatabaseSync(':memory:');
    var probeStmt = probeDb.prepare('SELECT 1');
    ASKS = typeof probeStmt.columns === 'function' || typeof probeStmt.reader === 'boolean';
    probeDb.close();
} catch (e) {
    DatabaseSync = null; // no SQLite driver on this runtime: §04 and §05 are not registered
}

var TMP = null;
var OPEN = [];
if (DatabaseSync) {
    // Globals bootstrap (mirrors entity-registry-b555.test.js): the factory needs
    // gina's helpers, getPath('gina') / getPath('bundle'), and the `gina` main
    // module's `lib` for entity.js.
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(FW + '/helpers');
    setPath('gina', { core: path.join(FW, 'core') });
    var ginaMain = require.resolve(REPO);
    if (!require.cache[ginaMain] || !require.cache[ginaMain].exports.lib) {
        require.cache[ginaMain] = {
            id: ginaMain, filename: ginaMain, loaded: true,
            exports: { lib: {
                logger   : console,
                helpers  : {},
                inherits : require(FW + '/lib/inherits/src/main.js'),
                merge    : require(FW + '/lib/merge/src/main.js'),
                Model    : require(FW + '/lib/model')
            } }
        };
    }
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1169-'));
    after(function () {
        OPEN.forEach(function (db) { try { db.close(); } catch (e) { /* already closed */ } });
        fs.rmSync(TMP, { recursive: true, force: true });
    });
}

/**
 * Builds one scene: a bundle root holding the `probe` entity and one `.sql` file
 * per method, an in-memory database with table `t`, and the REAL connector
 * factory run over them as lib/model.js runs it.
 *
 * @inner
 * @param {string} label - the scene's own directory name under TMP
 * @param {Object<string, string>} files - method name -> `.sql` file content
 * @returns {{conn: object, Probe: function}} the database and the built entity class
 */
function scene(label, files) {
    var root   = path.join(TMP, label);
    var entDir = path.join(root, 'bundle/models/b1169/entities');
    var sqlDir = path.join(root, 'bundle/models/b1169/sql/Probe');
    fs.mkdirSync(entDir, { recursive: true });
    fs.mkdirSync(sqlDir, { recursive: true });
    fs.writeFileSync(path.join(entDir, 'probe.js'), 'function Probe(conn) {}\nmodule.exports = Probe;\n');
    Object.keys(files).forEach(function (m) { fs.writeFileSync(path.join(sqlDir, m + '.sql'), files[m]); });
    var conn = new DatabaseSync(':memory:');
    OPEN.push(conn);
    conn.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER)');
    setPath('project', root);
    setPath('bundle', path.join(root, 'bundle'));
    var Sqlite   = require(SQLITE_PATH);
    var entities = new Sqlite(conn, { model: 'b1169', bundle: 'b1169-bundle', database: 'b1169', scope: 'local' });
    assert.equal(typeof entities.Probe, 'function', 'harness fault: the probe entity was not built');
    Object.keys(files).forEach(function (m) {
        assert.ok(Object.prototype.hasOwnProperty.call(entities.Probe.prototype, m),
            'harness fault: the query method ' + m + ' was not attached');
    });
    return { conn: conn, Probe: entities.Probe };
}

/**
 * Calls a query method through its callback form and resolves with its data.
 *
 * @inner
 * @param {function} Probe  - the entity class from scene()
 * @param {string}   method - the method name
 * @param {Array}    [args] - the bound values
 * @returns {Promise<*>} the method's data
 */
function call(Probe, method, args) {
    return new Promise(function (resolve, reject) {
        Probe.prototype[method].apply(null, (args || []).concat([function (err, data) {
            if (err) { reject(err); } else { resolve(data); }
        }]));
    });
}

if (DatabaseSync) {
    describe('04 - the connector, end to end: WITH, VALUES and PRAGMA reads return their rows', function () {

        var s = null;
        /** @inner @returns {{conn: object, Probe: function}} the shared scene, built on first use */
        function S() {
            return s || (s = scene('rows', {
                rowsSelect      : 'SELECT 1 AS a\n',
                rowsWith        : 'WITH t2 AS (SELECT 1 AS a) SELECT a FROM t2\n',
                rowsValues      : 'VALUES (1), (2)\n',
                rowsPragma      : 'PRAGMA user_version\n',
                rowsWithEmpty   : 'WITH t2 AS (SELECT 1 AS a) SELECT a FROM t2 WHERE a = 2\n',
                rowsWithObject  : '/*\n * @return {object}\n */\nWITH t2 AS (SELECT 7 AS a) SELECT a FROM t2\n',
                rowsWithCount   : '/*\n * @return {number}\n */\nWITH t2 AS (SELECT 1 AS a UNION ALL SELECT 2) SELECT COUNT(*) AS n FROM t2\n',
                rowsWithBoolean : '/*\n * @param {integer} $a\n * @return {boolean}\n */\nWITH t2 AS (SELECT 1 AS a) SELECT a FROM t2 WHERE a = ?\n',
                writePlain      : '/*\n * @param {integer} $a\n */\nINSERT INTO t (a) VALUES (?)\n'
            }));
        }

        it('CONTROL: a SELECT returns its rows', async function () {
            assert.deepEqual(plain(await call(S().Probe, 'rowsSelect')), [{ a: 1 }]);
        });

        it('a WITH … SELECT returns its rows', async function () {
            assert.deepEqual(plain(await call(S().Probe, 'rowsWith')), [{ a: 1 }]);
        });

        it('a VALUES statement returns its rows', async function () {
            assert.deepEqual(plain(await call(S().Probe, 'rowsValues')), [{ column1: 1 }, { column1: 2 }]);
        });

        it('a PRAGMA read returns its row', async function () {
            assert.deepEqual(plain(await call(S().Probe, 'rowsPragma')), [{ user_version: 0 }]);
        });

        it('a WITH … SELECT with no matching row returns null, as a SELECT does', async function () {
            assert.equal(await call(S().Probe, 'rowsWithEmpty'), null);
        });

        it('@return {object}: a WITH … SELECT returns its first row', async function () {
            assert.deepEqual(plain(await call(S().Probe, 'rowsWithObject')), { a: 7 });
        });

        it('@return {number}: a WITH … SELECT COUNT(*) returns the count', async function () {
            assert.equal(await call(S().Probe, 'rowsWithCount'), 2);
        });

        it('@return {boolean}: a WITH … SELECT reads true when a row matches, false when none does', async function () {
            assert.equal(await call(S().Probe, 'rowsWithBoolean', [1]), true);
            assert.equal(await call(S().Probe, 'rowsWithBoolean', [2]), false);
        });

        it('the promise form returns the rows too', async function () {
            assert.deepEqual(plain(await S().Probe.prototype.rowsWith()), [{ a: 1 }]);
        });

        it('CONTROL: a plain INSERT returns { changes, lastInsertRowid } and writes once', async function () {
            var r = await call(S().Probe, 'writePlain', [5]);
            assert.equal(r.changes, 1);
            assert.ok('lastInsertRowid' in r, 'the run result carries lastInsertRowid');
            assert.equal(S().conn.prepare('SELECT COUNT(*) AS n FROM t WHERE a = 5').get().n, 1);
        });
    });
}

if (DatabaseSync && ASKS) {
    describe('05 - statements the driver can ask: a WITH clause feeding a write, and INSERT … RETURNING', function () {

        var s = null;
        /** @inner @returns {{conn: object, Probe: function}} the shared scene, built on first use */
        function S() {
            return s || (s = scene('asked', {
                writeWith      : '/*\n * @param {integer} $a\n */\nWITH s AS (SELECT ? AS a) INSERT INTO t (a) SELECT a FROM s\n',
                writeReturning : '/*\n * @param {integer} $a\n */\nINSERT INTO t (a) VALUES (?) RETURNING a\n'
            }));
        }

        it('a WITH clause feeding an INSERT returns { changes, lastInsertRowid } and writes once', async function () {
            var r = await call(S().Probe, 'writeWith', [9]);
            assert.equal(r.changes, 1);
            assert.ok('lastInsertRowid' in r, 'the run result carries lastInsertRowid');
            assert.equal(S().conn.prepare('SELECT COUNT(*) AS n FROM t WHERE a = 9').get().n, 1);
        });

        it('INSERT … RETURNING returns its rows and writes once', async function () {
            assert.deepEqual(plain(await call(S().Probe, 'writeReturning', [11])), [{ a: 11 }]);
            assert.equal(S().conn.prepare('SELECT COUNT(*) AS n FROM t WHERE a = 11').get().n, 1);
        });
    });
}
