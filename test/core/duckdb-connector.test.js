/*
 * test/core/duckdb-connector.test.js
 *
 * DuckDB connector (#CN11) — source inspection + inline logic replicas.
 * Strategy: source inspection + inline logic replicas.
 * No live DuckDB, no framework bootstrap, no project required.
 * The driver (@duckdb/node-api) is loaded from the CONSUMING PROJECT's
 * node_modules at factory time, so this suite never reaches it. Mock
 * connections encode the driver contract MEASURED against
 * @duckdb/node-api@1.5.5-r.2: runAndReadAll(sql, args) resolves a reader
 * whose getRowObjectsJson() returns JSON-safe rows (BIGINT/DECIMAL/DATE/
 * TIMESTAMP as strings — COUNT(*) arrives as a STRING), and run(sql, args)
 * resolves a result whose rowsChanged is a plain number.
 *
 * Negative pins run against comment-stripped source so they can never
 * anchor on a JSDoc mention or a `// was:` line.
 */
'use strict';

var assert = require('node:assert');
var test   = require('node:test');
var describe = test.describe;
var it       = test.it;
var before   = test.before;

var fs   = require('fs');
var path = require('path');

var FW = require('../fw');
var commentStrip = require('../strip-comments');
var CONNECTOR_INDEX = path.join(FW, 'core/connectors/duckdb/index.js');
var CONNECTOR_LIB   = path.join(FW, 'core/connectors/duckdb/lib/connector.js');
var CONNECTOR_ERROR = path.join(FW, 'lib/connector-error/src/main.js');

/**
 * Strip block + line comments so negative pins cannot anchor on JSDoc or
 * explanatory comments (same shape as session-store-touch-guard.test.js).
 */
function stripComments(src) {
    return commentStrip.all(src);
}

// ─── 01 — lib/connector.js source pins ───────────────────────────────────────
describe('01 - DuckDB connector: lib/connector.js source', function () {

    var src, stripped;
    before(function () {
        src = fs.readFileSync(CONNECTOR_LIB, 'utf8');
        stripped = stripComments(src);
    });

    it('declares DuckdbConnector and exports it', function () {
        assert.ok(/function DuckdbConnector\(conf\)/.test(src));
        assert.ok(/module\.exports\s*=\s*DuckdbConnector/.test(src));
    });

    it('loads @duckdb/node-api from the PROJECT node_modules, not the framework', function () {
        assert.ok(src.indexOf("getPath('project') + '/node_modules/@duckdb/node-api'") > -1);
    });

    it('wraps the driver require in try/catch (missing driver degrades, never throws)', function () {
        assert.ok(/try\s*\{\s*var duckdbPath/.test(src));
    });

    it('pins the missing-driver message against shipped source (actionable install hint)', function () {
        // The sibling suites build fixture Errors and leave the shipped string
        // unasserted — pin it here so the wording cannot silently drift.
        assert.ok(src.indexOf('[DuckdbConnector] @duckdb/node-api is not installed in your project.') > -1);
        assert.ok(src.indexOf('Run: npm install @duckdb/node-api') > -1);
    });

    it('defaults the file path to ~/.gina/{database}.duckdb', function () {
        assert.ok(src.indexOf("conf.file || _(getPath('gina').home + '/' + conf.database + '.duckdb', true)") > -1);
    });

    it('maps readOnly to the driver access_mode READ_ONLY config', function () {
        assert.ok(/conf\.readOnly\)/.test(src));
        assert.ok(src.indexOf("{ access_mode: 'READ_ONLY' }") > -1);
    });

    it('passes NO config object when readOnly is not set (plain create)', function () {
        assert.ok(/DuckDBInstance\.create\(dbFile\)/.test(stripped),
            'the non-readOnly branch must call create(dbFile) with no config arg');
    });

    it('has no host/port/username/password surface (embedded database)', function () {
        assert.ok(!/conf\.host/.test(stripped));
        assert.ok(!/conf\.port/.test(stripped));
        assert.ok(!/conf\.username/.test(stripped));
        assert.ok(!/conf\.password/.test(stripped));
    });

    it('does NOT ping — a successful open IS the connectivity proof (embedded)', function () {
        assert.ok(!/SELECT 1/.test(stripped));
    });

    it('sets no PRAGMAs (DuckDB defaults, unlike the SQLite connector)', function () {
        assert.ok(!/PRAGMA/.test(stripped));
    });

    it('does not touch node:sqlite or the sqlite-driver seam', function () {
        assert.ok(!/node:sqlite/.test(stripped));
        assert.ok(!/sqlite-driver/.test(stripped));
    });

    it('onReady awaits the async init promise (driver is Promise-native)', function () {
        assert.ok(/_initPromise\.then\(/.test(src));
    });

    it('onReady short-circuits with the captured error: fn(_err, null)', function () {
        assert.ok(/if \(_err\) return fn\(_err, null\)/.test(src));
    });

    it('captures open failures into _err with the file path in the message', function () {
        assert.ok(/_err = new Error\('\[DuckdbConnector\] Failed to open "' \+ dbFile/.test(src));
    });

    it('exposes _file and _name metadata on the connection for index.js', function () {
        assert.ok(/_conn\._file = dbFile/.test(src));
        assert.ok(/_conn\._name = conf\.database/.test(src));
    });

    it('inherits from EventEmitter (the model layer attaches listeners unconditionally)', function () {
        assert.ok(/DuckdbConnector = inherits\(DuckdbConnector, EventEmitter\)/.test(src));
    });
});


// ─── 02 — index.js source pins ───────────────────────────────────────────────
describe('02 - DuckDB connector: index.js source', function () {

    var src, stripped;
    before(function () {
        src = fs.readFileSync(CONNECTOR_INDEX, 'utf8');
        stripped = stripComments(src);
    });

    it('exports the plain-call entity factory (return init(conn, infos))', function () {
        assert.ok(/function Duckdb\(conn, infos\)/.test(src));
        assert.ok(/return init\(conn, infos\);/.test(src));
        assert.ok(/module\.exports\s*=\s*Duckdb/.test(src));
    });

    it('reads SQL methods from the sql/ directory (not n1ql/cql/pipelines)', function () {
        assert.ok(src.indexOf("+ '/models/' + infos.database + '/sql'") > -1);
        assert.ok(!/n1ql/.test(stripped));
        assert.ok(!/\/cql/.test(stripped));
        assert.ok(!/pipelines/.test(stripped));
    });

    it('classifies row-returning statements across the DuckDB dialect, not bare SELECT', function () {
        assert.ok(src.indexOf('(SELECT|WITH|FROM|SUMMARIZE|PIVOT|UNPIVOT|DESCRIBE|SHOW)') > -1);
        assert.ok(!/var isSELECT/.test(stripped),
            'the sibling bare-SELECT classifier variable must not exist here');
    });

    it('reads rows via runAndReadAll + getRowObjectsJson (JSON-safe getter)', function () {
        assert.equal(src.split('conn.runAndReadAll(queryString, args)').length - 1, 2,
            'both the promise and callback branches read via runAndReadAll');
        assert.ok(/result\.getRowObjectsJson\(\)/.test(src));
    });

    it('executes writes via run() and reads rowsChanged off the result', function () {
        assert.equal(src.split('conn.run(queryString, args)').length - 1, 2,
            'both branches route writes through run()');
        assert.ok(/result\.rowsChanged/.test(src));
    });

    it('does NOT use setTimeout(0) — @duckdb/node-api is natively async', function () {
        assert.ok(!/setTimeout\(function\(\)\s*\{/.test(stripped));
    });

    it('does not borrow sibling driver idioms (query/execute/prepare)', function () {
        assert.ok(!/conn\.query\(/.test(stripped));
        assert.ok(!/conn\.execute\(/.test(stripped));
        assert.ok(!/conn\.prepare\(/.test(stripped));
    });

    it('stamps connector errors at exactly two sites (promise + callback reject)', function () {
        assert.equal(src.split('lib.connectorError.stamp(err)').length - 1, 2);
    });

    it('prefixes errors with the SQL source path at both sites', function () {
        assert.equal(src.split("err.message = '[ ' + source + ' ]\\n' + err.message").length - 1, 2);
    });

    it('stamps the full prototype metadata set on every entity', function () {
        assert.ok(/Entity\.prototype\.name\s*=\s*className/.test(src));
        assert.ok(/Entity\.prototype\.model\s*=\s*infos\.model/.test(src));
        assert.ok(/Entity\.prototype\.bundle\s*=\s*infos\.bundle/.test(src));
        assert.ok(/Entity\.prototype\.database\s*=\s*infos\.database/.test(src));
        assert.ok(/Entity\.prototype\._collection\s*=\s*entityName/.test(src));
        assert.ok(/Entity\.prototype\._scope\s*=\s*infos\.scope \|\| process\.env\.NODE_SCOPE/.test(src));
        assert.ok(/Entity\.prototype\._filename/.test(src));
    });

    it('auto-creates the entities dir and skips a missing sql dir silently', function () {
        assert.ok(/new _\(entitiesPath\)\.mkdirSync\(\)/.test(src));
        assert.ok(/fs\.existsSync\(sqlDir\)/.test(src));
    });

    it('@param and @return annotations use the shared positional syntax', function () {
        assert.ok(src.indexOf('@return\\s+\\{([^}]+)\\}') > -1);
        assert.ok(src.indexOf('@param\\s+\\{([^}]+)\\}') > -1);
    });

    it("builds the debug trigger with the 'DUCKDB:' prefix", function () {
        assert.ok(src.indexOf("'DUCKDB:' + entityName.toLowerCase()") > -1);
    });

    // QI coverage — duckdb is not in connector-query-log.test.js's roster
    // (its computed numbering would collide); the equivalent pins live here.
    it('captures under the full dev-OR-instrumentation-window gate (#INS10)', function () {
        assert.ok(src.indexOf('envIsDev || (process.gina && process.gina._inspectorWindowUntil > Date.now())') > -1);
    });

    it('reaches the request store and pushes inside the gate (getStore -> _devQueryLog -> push)', function () {
        assert.ok(/process\.gina\._queryALS\s*\?\s*process\.gina\._queryALS\.getStore\(\)/.test(src));
        assert.ok(/_devLog\s*=\s*_alsStore\s*\?\s*_alsStore\._devQueryLog\s*:\s*null/.test(src));
        assert.ok(/_devLog\.push\(_queryEntry\)/.test(src));
    });

    it("tags query entries type 'DUCKDB' and connector 'duckdb' with _startMs timing", function () {
        assert.ok(/type\s*:\s*'DUCKDB'/.test(src));
        assert.ok(/connector\s*:\s*'duckdb'/.test(src));
        assert.ok(/_queryEntry\._startMs\s*=\s*Date\.now\(\)/.test(src));
    });

    it('answers inspector#indexes with live duckdb_indexes() introspection (dev only)', function () {
        assert.ok(src.indexOf('duckdb_indexes()') > -1);
        assert.ok(src.indexOf("process.on('inspector#indexes'") > -1);
    });
});


// ─── 03 — DuckdbConnector logic (mock driver) ────────────────────────────────
describe('03 - DuckDB connector: connection logic (mock driver)', function () {

    // Replicate the init/onReady logic from lib/connector.js.
    // `loadDriver` stands in for the try/catch project require; `ginaHome`
    // stands in for getPath('gina').home.
    var makeConnector = function (loadDriver, conf, ginaHome) {
        var _conn = null, _err = null, _initPromise = null;

        var init = function (conf) {
            // #B911 — mirrors lib/connector.js: an entry that names neither `file`
            // nor `database` is refused before the driver is loaded.
            if (!conf.file && !conf.database) {
                _err = new Error(
                    '[DuckdbConnector] The connectors.json entry names neither `file` nor `database`.\n'
                    + 'Set `database` (it names models/<database>/ and the default file ~/.gina/<database>.duckdb), '
                    + 'or `file` (a path, or ":memory:").'
                );
                return;
            }
            var duckdb;
            try {
                duckdb = loadDriver();
            } catch (e) {
                _err = new Error(
                    '[DuckdbConnector] @duckdb/node-api is not installed in your project.\n'
                    + 'Run: npm install @duckdb/node-api\n'
                    + e.message
                );
                return;
            }
            var dbFile = conf.file || (ginaHome + '/' + conf.database + '.duckdb');
            var pending = (conf.readOnly)
                ? duckdb.DuckDBInstance.create(dbFile, { access_mode: 'READ_ONLY' })
                : duckdb.DuckDBInstance.create(dbFile);
            _initPromise = pending
                .then(function (instance) { return instance.connect(); })
                .then(function (connection) {
                    _conn = connection;
                    _conn._file = dbFile;
                    _conn._name = conf.database;
                })
                .catch(function (e) {
                    _err = new Error('[DuckdbConnector] Failed to open "' + dbFile + '": ' + e.message);
                });
        };

        var onReady = function (fn) {
            if (_err) return fn(_err, null);
            _initPromise.then(function () {
                if (_err) return fn(_err, null);
                fn(null, _conn);
            });
        };

        init(conf);
        return { onReady: onReady };
    };

    var mockDriver = function (createSpy) {
        return {
            DuckDBInstance: {
                create: function (file, config) {
                    if (createSpy) createSpy(file, config, arguments.length);
                    return Promise.resolve({
                        connect: function () { return Promise.resolve({}); }
                    });
                }
            }
        };
    };

    it('surfaces the missing driver through onReady SYNCHRONOUSLY as fn(err, null)', function () {
        var seen = null;
        var c = makeConnector(function () { throw new Error("Cannot find module '@duckdb/node-api'"); },
            { database: 'analytics' }, '/tmp/home');
        c.onReady(function (err, conn) { seen = { err: err, conn: conn }; });
        assert.ok(seen !== null, 'missing-driver onReady must fire synchronously');
        assert.ok(/is not installed in your project/.test(seen.err.message));
        assert.ok(/Run: npm install @duckdb\/node-api/.test(seen.err.message));
        assert.equal(seen.conn, null);
    });

    it('refuses an entry with neither `file` nor `database` SYNCHRONOUSLY, before loading the driver (#B911)', function () {
        var seen = null, loaded = false;
        var c = makeConnector(function () { loaded = true; return mockDriver(); }, {}, '/tmp/home');
        c.onReady(function (err, conn) { seen = { err: err, conn: conn }; });
        assert.ok(seen !== null, 'the refusal must reach onReady synchronously');
        assert.ok(/names neither `file` nor `database`/.test(seen.err.message));
        assert.equal(seen.conn, null);
        assert.equal(loaded, false, 'the driver must not be loaded for a refused entry');
    });

    it('surfaces an open failure as [DuckdbConnector] Failed to open', async function () {
        var failing = {
            DuckDBInstance: {
                create: function () { return Promise.reject(new Error('IO Error: Could not set lock')); }
            }
        };
        var seen = null;
        var c = makeConnector(function () { return failing; }, { database: 'analytics' }, '/tmp/home');
        await new Promise(function (resolve) {
            c.onReady(function (err, conn) { seen = { err: err, conn: conn }; resolve(); });
        });
        assert.ok(/\[DuckdbConnector\] Failed to open "\/tmp\/home\/analytics\.duckdb"/.test(seen.err.message));
        assert.ok(/IO Error: Could not set lock/.test(seen.err.message));
        assert.equal(seen.conn, null);
    });

    it('delivers the connection with _file and _name metadata on success', async function () {
        var seen = null;
        var c = makeConnector(function () { return mockDriver(); }, { database: 'analytics' }, '/tmp/home');
        await new Promise(function (resolve) {
            c.onReady(function (err, conn) { seen = { err: err, conn: conn }; resolve(); });
        });
        assert.equal(seen.err, null);
        assert.equal(seen.conn._name, 'analytics');
        assert.equal(seen.conn._file, '/tmp/home/analytics.duckdb');
    });

    it('onReady is ASYNC on the success path (driver handshake is Promise-native)', function () {
        var seen = null;
        var c = makeConnector(function () { return mockDriver(); }, { database: 'analytics' }, '/tmp/home');
        c.onReady(function (err, conn) { seen = { err: err, conn: conn }; });
        assert.equal(seen, null, 'callback must not fire before the init promise settles');
        return new Promise(function (resolve) { setImmediate(function () {
            assert.ok(seen !== null, 'callback fires after the promise settles');
            resolve();
        }); });
    });

    it('defaults the file to <ginaHome>/<database>.duckdb when conf.file is absent', async function () {
        var captured = null;
        var c = makeConnector(function () {
            return mockDriver(function (file) { captured = file; });
        }, { database: 'metrics' }, '/gina/home');
        await new Promise(function (resolve) { c.onReady(resolve); });
        assert.equal(captured, '/gina/home/metrics.duckdb');
    });

    it("passes ':memory:' through to the driver verbatim", async function () {
        var captured = null;
        var c = makeConnector(function () {
            return mockDriver(function (file) { captured = file; });
        }, { database: 'analytics', file: ':memory:' }, '/gina/home');
        await new Promise(function (resolve) { c.onReady(resolve); });
        assert.equal(captured, ':memory:');
    });

    it('readOnly true opens with { access_mode: READ_ONLY }', async function () {
        var capturedConfig = null;
        var c = makeConnector(function () {
            return mockDriver(function (file, config) { capturedConfig = config; });
        }, { database: 'analytics', readOnly: true }, '/gina/home');
        await new Promise(function (resolve) { c.onReady(resolve); });
        assert.deepStrictEqual(capturedConfig, { access_mode: 'READ_ONLY' });
    });

    it('readOnly absent calls create with the file path ONLY (no config arg)', async function () {
        var capturedArity = null;
        var c = makeConnector(function () {
            return mockDriver(function (file, config, arity) { capturedArity = arity; });
        }, { database: 'analytics' }, '/gina/home');
        await new Promise(function (resolve) { c.onReady(resolve); });
        assert.equal(capturedArity, 1);
    });
});


// ─── 04 — classifier + coerce() return-type logic ────────────────────────────
describe('04 - DuckDB connector: classifier and coerce() return-type logic', function () {

    // Replicate the row-returning classifier from index.js.
    var isRowReturning = function (q) {
        return /^\s*(SELECT|WITH|FROM|SUMMARIZE|PIVOT|UNPIVOT|DESCRIBE|SHOW)\b/i.test(q);
    };

    // Replicate the coerce() function from index.js.
    var makeCoerce = function (rowReturning, returnType, queryString) {
        return function (result) {
            if (rowReturning) {
                var rows = result.getRowObjectsJson();
                if (returnType === 'object')  return (rows.length > 0) ? rows[0] : null;
                if (returnType === 'boolean') return rows.length > 0;
                if (returnType === 'number' && /count\s*\(/i.test(queryString)) {
                    if (rows.length > 0 && typeof rows[0] === 'object') {
                        var keys = Object.keys(rows[0]);
                        return (keys.length > 0) ? Number(rows[0][keys[0]]) : 0;
                    }
                    return 0;
                }
                return rows.length > 0 ? rows : null;
            }
            if (returnType === 'boolean') return result.rowsChanged > 0;
            if (returnType === 'number')  return result.rowsChanged;
            return { changes: result.rowsChanged };
        };
    };

    var reader = function (rows) {
        return { getRowObjectsJson: function () { return rows; } };
    };

    it('classifies SELECT / select as row-returning', function () {
        assert.equal(isRowReturning('SELECT * FROM t'), true);
        assert.equal(isRowReturning('  select 1'), true);
    });

    it('classifies WITH (CTEs), FROM-first and SUMMARIZE as row-returning', function () {
        assert.equal(isRowReturning('WITH x AS (SELECT 1) SELECT * FROM x'), true);
        assert.equal(isRowReturning('FROM t'), true);
        assert.equal(isRowReturning('SUMMARIZE t'), true);
    });

    it('classifies PIVOT / UNPIVOT / DESCRIBE / SHOW as row-returning', function () {
        assert.equal(isRowReturning('PIVOT t ON year'), true);
        assert.equal(isRowReturning('UNPIVOT t ON col'), true);
        assert.equal(isRowReturning('DESCRIBE t'), true);
        assert.equal(isRowReturning('SHOW TABLES'), true);
    });

    it('classifies writes and DDL as NOT row-returning', function () {
        assert.equal(isRowReturning('INSERT INTO t VALUES (1)'), false);
        assert.equal(isRowReturning('UPDATE t SET a = 1'), false);
        assert.equal(isRowReturning('DELETE FROM t'), false);
        assert.equal(isRowReturning('CREATE TABLE t (id INTEGER)'), false);
        assert.equal(isRowReturning("COPY t FROM 'x.csv'"), false);
    });

    it('respects word boundaries (WITHOUT / SHOWCASE are not statement heads)', function () {
        assert.equal(isRowReturning('WITHOUT_TABLE_OP something'), false);
        assert.equal(isRowReturning('SHOWCASE_PROC()'), false);
    });

    it('subtract: a bare ^SELECT classifier would misroute WITH queries to the write path', function () {
        // The measured defect the widened classifier fixes: run() reports
        // rowsChanged 0 for a WITH query and the rows are silently lost.
        var bareSelect = /^\s*SELECT\b/i;
        var withQuery  = 'WITH x AS (SELECT 1) SELECT * FROM x';
        assert.equal(bareSelect.test(withQuery), false, 'the sibling classifier misses CTEs');
        assert.equal(isRowReturning(withQuery), true, 'the DuckDB classifier routes them to rows');
    });

    it('@return {object} — returns first row when results non-empty', function () {
        var coerce = makeCoerce(true, 'object', 'SELECT * FROM t');
        assert.deepStrictEqual(coerce(reader([{ id: 1 }, { id: 2 }])), { id: 1 });
    });

    it('@return {object} — returns null on an empty result', function () {
        var coerce = makeCoerce(true, 'object', 'SELECT * FROM t');
        assert.equal(coerce(reader([])), null);
    });

    it('@return {boolean} — rows.length > 0 on row-returning statements', function () {
        var coerce = makeCoerce(true, 'boolean', 'SELECT * FROM t');
        assert.equal(coerce(reader([{ id: 1 }])), true);
        assert.equal(coerce(reader([])), false);
    });

    it('@return {number} — Number()s the COUNT string the Json getter delivers', function () {
        // MEASURED: getRowObjectsJson() returns COUNT(*) as a STRING ("7") —
        // same behaviour as the pg driver's bigint handling.
        var coerce = makeCoerce(true, 'number', 'SELECT COUNT(*) AS cnt FROM t');
        var out = coerce(reader([{ cnt: '7' }]));
        assert.equal(typeof out, 'number');
        assert.equal(out, 7);
    });

    it('@return {number} — 0 on an empty COUNT result', function () {
        var coerce = makeCoerce(true, 'number', 'SELECT COUNT(*) FROM t');
        assert.equal(coerce(reader([])), 0);
    });

    it('@return {number} without COUNT( in the query falls through to all rows', function () {
        var coerce = makeCoerce(true, 'number', 'SELECT id FROM t');
        assert.deepStrictEqual(coerce(reader([{ id: 3 }])), [{ id: 3 }]);
    });

    it('@return {array} / no annotation — all rows, null when empty', function () {
        var coerce = makeCoerce(true, null, 'SELECT * FROM t');
        assert.deepStrictEqual(coerce(reader([{ a: 1 }])), [{ a: 1 }]);
        assert.equal(coerce(reader([])), null);
    });

    it('write @return {boolean} — rowsChanged > 0', function () {
        var coerce = makeCoerce(false, 'boolean', 'UPDATE t SET a = 1');
        assert.equal(coerce({ rowsChanged: 2 }), true);
        assert.equal(coerce({ rowsChanged: 0 }), false);
    });

    it('write @return {number} — rowsChanged verbatim', function () {
        var coerce = makeCoerce(false, 'number', 'DELETE FROM t');
        assert.equal(coerce({ rowsChanged: 3 }), 3);
    });

    it('write default — { changes } only (DuckDB has no insertId analog)', function () {
        var coerce = makeCoerce(false, null, 'INSERT INTO t VALUES (1)');
        assert.deepStrictEqual(coerce({ rowsChanged: 1 }), { changes: 1 });
    });
});


// ─── 05 — entity-method Promise / .onComplete() ──────────────────────────────
describe('05 - DuckDB connector: entity-method Promise and .onComplete()', function () {

    // The real stamp() — lib/connector-error has zero require()s of its own,
    // so it loads live (connector-error.test.js precedent).
    var ce = require(CONNECTOR_ERROR);

    // Replicate the method-generation closure from index.js (async driver
    // path — no setTimeout(0); QI instrumentation elided, pinned in §02).
    var makeMethod = function (conn, queryString, rowReturning, returnType, paramTypes, source) {
        var coerce = function (result) {
            if (rowReturning) {
                var rows = result.getRowObjectsJson();
                if (returnType === 'object') return (rows.length > 0) ? rows[0] : null;
                return rows.length > 0 ? rows : null;
            }
            return { changes: result.rowsChanged };
        };

        return function () {
            var args = Array.prototype.slice.call(arguments);
            var _mainCallback = null;
            if (typeof args[args.length - 1] === 'function') {
                _mainCallback = args.pop();
            }
            for (var t = 0, tLen = paramTypes.length; t < tLen && t < args.length; t++) {
                switch (paramTypes[t]) {
                    case 'number':
                    case 'integer': args[t] = parseInt(args[t], 10);                          break;
                    case 'float':   args[t] = parseFloat(String(args[t]).replace(/,/, '.')); break;
                    case 'string':  args[t] = String(args[t]);                                break;
                }
            }

            if (_mainCallback === null) {
                var _resolve, _reject, _internalData;
                var _promise = new Promise(function (resolve, reject) {
                    _resolve = resolve; _reject = reject;
                });
                _promise.onComplete = function (cb) {
                    _promise.then(
                        function ()    { cb(null, _internalData); },
                        function (err) { cb(err); }
                    );
                    return _promise;
                };
                var _driverCall = rowReturning
                    ? conn.runAndReadAll(queryString, args)
                    : conn.run(queryString, args);
                _driverCall.then(
                    function (result) {
                        var raw = coerce(result);
                        _internalData = raw;
                        _resolve(raw);
                    },
                    function (err) {
                        err.message = '[ ' + source + ' ]\n' + err.message;
                        _reject(ce.stamp(err));
                    }
                );
                return _promise;
            }

            var _driverCall2 = rowReturning
                ? conn.runAndReadAll(queryString, args)
                : conn.run(queryString, args);
            _driverCall2.then(
                function (result) { _mainCallback(null, coerce(result)); },
                function (err) {
                    err.message = '[ ' + source + ' ]\n' + err.message;
                    _mainCallback(ce.stamp(err));
                }
            );
        };
    };

    var mockConn = function (log, rows, failWith) {
        return {
            runAndReadAll: function (q, args) {
                log.push({ method: 'runAndReadAll', q: q, args: args });
                if (failWith) return Promise.reject(failWith);
                return Promise.resolve({ getRowObjectsJson: function () { return rows; } });
            },
            run: function (q, args) {
                log.push({ method: 'run', q: q, args: args });
                if (failWith) return Promise.reject(failWith);
                return Promise.resolve({ rowsChanged: 1 });
            }
        };
    };

    it('returns a native Promise carrying an onComplete function', function () {
        var m = makeMethod(mockConn([], []), 'SELECT 1', true, null, [], 'x.sql');
        var p = m();
        assert.ok(p instanceof Promise);
        assert.equal(typeof p.onComplete, 'function');
        return p;
    });

    it('await resolves the coerced rows', async function () {
        var m = makeMethod(mockConn([], [{ id: 1 }]), 'SELECT 1', true, null, [], 'x.sql');
        var out = await m();
        assert.deepStrictEqual(out, [{ id: 1 }]);
    });

    it('onComplete(cb) delivers cb(null, data) and preserves chaining', async function () {
        var m = makeMethod(mockConn([], [{ id: 2 }]), 'SELECT 1', true, 'object', [], 'x.sql');
        var seen = null;
        var returned = m().onComplete(function (err, data) { seen = { err: err, data: data }; });
        assert.ok(returned instanceof Promise, 'onComplete returns the promise for chaining');
        await returned;
        await new Promise(setImmediate);
        assert.equal(seen.err, null);
        assert.deepStrictEqual(seen.data, { id: 2 });
    });

    it('routes row-returning statements through runAndReadAll', async function () {
        var log = [];
        var m = makeMethod(mockConn(log, []), 'SELECT * FROM t', true, null, [], 'x.sql');
        await m();
        assert.equal(log[0].method, 'runAndReadAll');
    });

    it('routes writes through run()', async function () {
        var log = [];
        var m = makeMethod(mockConn(log, []), 'INSERT INTO t VALUES (?)', false, null, [], 'x.sql');
        var out = await m(1);
        assert.equal(log[0].method, 'run');
        assert.deepStrictEqual(out, { changes: 1 });
    });

    it('passes positional args to the driver as an array', async function () {
        var log = [];
        var m = makeMethod(mockConn(log, []), 'SELECT * FROM t WHERE id = ?', true, null, [], 'x.sql');
        await m(42, 'b');
        assert.deepStrictEqual(log[0].args, [42, 'b']);
    });

    it('rejection prefixes the SQL source path and stamps the error', async function () {
        var boom = new Error('Catalog Error: Table with name no_such_table does not exist!');
        var m = makeMethod(mockConn([], [], boom), 'SELECT * FROM no_such_table', true, null, [], '/models/db/sql/T/find.sql');
        var caught = null;
        try { await m(); } catch (e) { caught = e; }
        assert.ok(caught, 'promise must reject');
        assert.ok(/^\[ \/models\/db\/sql\/T\/find\.sql \]\n/.test(caught.message));
        assert.ok('isTransient' in caught, 'error must carry the connector-error stamp');
        assert.equal(caught.isTransient, false, 'a Catalog error is permanent');
    });

    it('callback path delivers cb(null, coerced) without a Promise', async function () {
        var seen = null;
        var m = makeMethod(mockConn([], [{ id: 9 }]), 'SELECT 1', true, 'object', [], 'x.sql');
        var returned = m(function (err, data) { seen = { err: err, data: data }; });
        assert.equal(returned, undefined, 'callback path returns nothing');
        await new Promise(setImmediate);
        assert.equal(seen.err, null);
        assert.deepStrictEqual(seen.data, { id: 9 });
    });

    it('callback path receives the stamped, prefixed error', async function () {
        var boom = new Error('Parser Error: syntax error at or near "SELEC"');
        var m = makeMethod(mockConn([], [], boom), 'SELEC broken', false, null, [], 'y.sql');
        var seen = null;
        m(function (err) { seen = err; });
        await new Promise(setImmediate);
        assert.ok(/^\[ y\.sql \]\n/.test(seen.message));
        assert.equal(seen.isTransient, false);
    });

    it('trailing callback is popped BEFORE casting (never cast as a param)', async function () {
        var log = [];
        var m = makeMethod(mockConn(log, []), 'SELECT ?', true, null, ['integer'], 'x.sql');
        await new Promise(function (resolve) { m('7', function () { resolve(); }); });
        assert.deepStrictEqual(log[0].args, [7], 'the callback must not be in the driver args');
    });
});


// ─── 06 — @param type casting ────────────────────────────────────────────────
describe('06 - DuckDB connector: @param type casting', function () {

    // Replicate the casting loop from index.js.
    var cast = function (paramTypes, args) {
        for (var t = 0, tLen = paramTypes.length; t < tLen && t < args.length; t++) {
            switch (paramTypes[t]) {
                case 'number':
                case 'integer': args[t] = parseInt(args[t], 10);                          break;
                case 'float':   args[t] = parseFloat(String(args[t]).replace(/,/, '.')); break;
                case 'string':  args[t] = String(args[t]);                                break;
            }
        }
        return args;
    };

    it('@param {integer} casts numeric strings with parseInt', function () {
        assert.deepStrictEqual(cast(['integer'], ['42']), [42]);
    });

    it('@param {number} is an alias of integer casting', function () {
        assert.deepStrictEqual(cast(['number'], ['08']), [8]);
    });

    it('@param {float} normalises comma decimals (3,14 → 3.14)', function () {
        assert.deepStrictEqual(cast(['float'], ['3,14']), [3.14]);
    });

    it('@param {string} coerces via String()', function () {
        assert.deepStrictEqual(cast(['string'], [42]), ['42']);
    });

    it('unknown types pass through untouched', function () {
        assert.deepStrictEqual(cast(['uuid'], ['abc']), ['abc']);
    });

    it('extra args past the annotation count are untouched', function () {
        assert.deepStrictEqual(cast(['integer'], ['1', '2']), [1, '2']);
    });

    it('empty paramTypes is a no-op', function () {
        assert.deepStrictEqual(cast([], ['1', 2]), ['1', 2]);
    });
});
