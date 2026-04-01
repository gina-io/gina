'use strict';
/**
 * PostgreSQL connector — ORM / entity wiring tests
 *
 * Strategy: source inspection + inline logic replicas.
 * No live PostgreSQL server, no framework bootstrap, no project required.
 * Mock conn.query() / pool.query() stand in for the real pg driver.
 */
var { describe, it, before } = require('node:test');
var assert  = require('node:assert/strict');
var path    = require('path');
var fs      = require('fs');

var FW = require('../fw');
var CONNECTOR_INDEX = path.join(FW, 'core/connectors/postgresql/index.js');
var CONNECTOR_LIB   = path.join(FW, 'core/connectors/postgresql/lib/connector.js');


// ─── 01 — source: lib/connector.js ───────────────────────────────────────────

describe('01 - PostgreSQL connector: lib/connector.js source', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR_LIB, 'utf8'); });

    it('exports a PostgresqlConnector constructor', function() {
        assert.ok(/function PostgresqlConnector/.test(src));
        assert.ok(/module\.exports\s*=\s*PostgresqlConnector/.test(src));
    });

    it('loads pg from project node_modules (not from framework)', function() {
        assert.ok(/getPath\('project'\)/.test(src));
        assert.ok(/node_modules\/pg/.test(src));
    });

    it('wraps pg require in a try/catch guard', function() {
        assert.ok(/try\s*\{/.test(src));
        assert.ok(/catch\s*\(/.test(src));
    });

    it('uses new pg.Pool() for connection pooling', function() {
        assert.ok(/new pg\.Pool\(poolConf\)/.test(src));
    });

    it('defaults host to 127.0.0.1 when absent', function() {
        assert.ok(/conf\.host\s*\|\|\s*'127\.0\.0\.1'/.test(src));
    });

    it('defaults port to 5432 when absent', function() {
        assert.ok(/conf\.port\s*\|\|\s*5432/.test(src));
    });

    it('defaults connectionLimit (max) to 10 when absent', function() {
        assert.ok(/conf\.connectionLimit\s*\|\|\s*10/.test(src));
    });

    it('passes ssl option through to pg when present', function() {
        assert.ok(/conf\.ssl/.test(src));
        assert.ok(/poolConf\.ssl\s*=\s*conf\.ssl/.test(src));
    });

    it('registers pool error handler to prevent unhandled EventEmitter crash', function() {
        assert.ok(/_conn\.on\('error'/.test(src));
    });

    it('onReady() pings via pool.query(SELECT 1)', function() {
        assert.ok(/_conn\.query\('SELECT 1'/.test(src));
    });

    it('onReady() calls fn(null, conn) on success', function() {
        assert.ok(/fn\(null,\s*_conn\)/.test(src));
    });

    it('onReady() calls fn(_err, null) when init failed', function() {
        assert.ok(/fn\(_err,\s*null\)/.test(src));
    });

    it('sets _conn._name to conf.database for debug logging', function() {
        assert.ok(/_conn\._name\s*=\s*conf\.database/.test(src));
    });

    it('maps connectionLimit to pg Pool max field', function() {
        assert.ok(/max\s*:\s*conf\.connectionLimit/.test(src));
    });

    it('maps idleTimeout to idleTimeoutMillis', function() {
        assert.ok(/idleTimeoutMillis/.test(src));
        assert.ok(/conf\.idleTimeout/.test(src));
    });

    it('maps connectionTimeout to connectionTimeoutMillis', function() {
        assert.ok(/connectionTimeoutMillis/.test(src));
        assert.ok(/conf\.connectionTimeout/.test(src));
    });

    it('inherits from EventEmitter', function() {
        assert.ok(/EventEmitter/.test(src));
        assert.ok(/inherits\(PostgresqlConnector,\s*EventEmitter\)/.test(src));
    });

});


// ─── 02 — source: index.js ───────────────────────────────────────────────────

describe('02 - PostgreSQL connector: index.js source', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR_INDEX, 'utf8'); });

    it('exports a Postgresql constructor function', function() {
        assert.ok(/function Postgresql\(/.test(src));
        assert.ok(/module\.exports\s*=\s*Postgresql/.test(src));
    });

    it('loads EntitySuperClass from model/entity.js via getPath', function() {
        assert.ok(/\/model\/entity\.js/.test(src));
        assert.ok(/getPath\('gina'\)/.test(src));
    });

    it('loads entity JS files from models/<database>/entities/', function() {
        assert.ok(/\/models\//.test(src));
        assert.ok(/\/entities/.test(src));
    });

    it('wires entities with inherits(Entity, EntitySuperClass)', function() {
        assert.ok(/inherits\(Entity,\s*EntitySuperClass\)/.test(src));
    });

    it('looks for sql/ directory (not n1ql/) for SQL method files', function() {
        assert.ok(/\/sql/.test(src));
        assert.ok(!/\/n1ql/.test(src));
    });

    it('uses conn.query() (pg API — not conn.execute)', function() {
        assert.ok(/conn\.query\(/.test(src));
        assert.ok(!/conn\.execute\(/.test(src));
    });

    it('returns native Promise with .onComplete() shim from entity methods', function() {
        assert.ok(/new Promise/.test(src));
        assert.ok(/\.onComplete\s*=\s*function/.test(src));
    });

    it('does NOT use setTimeout(0) — pg is natively async', function() {
        assert.ok(!/setTimeout\(function\(\)\s*\{/.test(src));
    });

    it('reads SELECT rows from result.rows', function() {
        assert.ok(/result\.rows/.test(src));
    });

    it('reads write row count from result.rowCount', function() {
        assert.ok(/result\.rowCount/.test(src));
    });

    it('reads command from result.command for default write result', function() {
        assert.ok(/result\.command/.test(src));
    });

    it('default write result is { changes, command }', function() {
        assert.ok(/changes\s*:\s*result\.rowCount/.test(src));
        assert.ok(/command\s*:\s*result\.command/.test(src));
    });

    it('supports @return {object} coercion', function() {
        assert.ok(/returnType\s*===\s*'object'/.test(src));
    });

    it('supports @return {boolean} coercion', function() {
        assert.ok(/returnType\s*===\s*'boolean'/.test(src));
    });

    it('supports @return {number} COUNT(*) extraction', function() {
        assert.ok(/returnType\s*===\s*'number'/.test(src));
        assert.ok(/count/.test(src));
    });

    it('annotates entity prototype with model/bundle/database/_collection', function() {
        assert.ok(/Entity\.prototype\.model\s*=/.test(src));
        assert.ok(/Entity\.prototype\.bundle\s*=/.test(src));
        assert.ok(/Entity\.prototype\.database\s*=/.test(src));
        assert.ok(/Entity\.prototype\._collection\s*=/.test(src));
    });

    it('sets _scope from infos.scope or NODE_SCOPE env var', function() {
        assert.ok(/Entity\.prototype\._scope\s*=\s*infos\.scope/.test(src));
        assert.ok(/NODE_SCOPE/.test(src));
    });

    it('has existsSync guard for missing sql/ directory', function() {
        assert.ok(/fs\.existsSync\(sqlDir\)/.test(src));
    });

    it('trigger prefix is PG: for dev logging', function() {
        assert.ok(/'PG:'/.test(src));
    });

    it('appends sql file path to error message for traceability', function() {
        assert.ok(/err\.message\s*=\s*'\[\s*'\s*\+\s*source/.test(src));
    });

});


// ─── 03 — PostgresqlConnector logic (mock pg) ────────────────────────────────

describe('03 - PostgresqlConnector logic', function() {

    // Replicate the onReady logic inline using a mock pg pool.
    var makeOnReady = function(mockPool, initErr) {
        var _conn = mockPool;
        var _err  = initErr || null;
        return function(fn) {
            if (_err) return fn(_err, null);
            _conn.query('SELECT 1', function(err) {
                if (err) {
                    fn(new Error('[PostgresqlConnector] Connection failed: ' + err.message), null);
                    return;
                }
                fn(null, _conn);
            });
        };
    };

    it('onReady calls fn(null, pool) on successful SELECT 1', function(_, done) {
        var mockPool = {
            _name: 'testdb',
            query: function(q, cb) { cb(null); }
        };
        var onReady = makeOnReady(mockPool, null);
        onReady(function(err, conn) {
            assert.equal(err, null);
            assert.strictEqual(conn, mockPool);
            done();
        });
    });

    it('onReady calls fn(err, null) when SELECT 1 fails', function(_, done) {
        var mockPool = {
            query: function(q, cb) { cb(new Error('ECONNREFUSED')); }
        };
        var onReady = makeOnReady(mockPool, null);
        onReady(function(err, conn) {
            assert.ok(err instanceof Error);
            assert.ok(/Connection failed/.test(err.message));
            assert.equal(conn, null);
            done();
        });
    });

    it('onReady calls fn(_err, null) when init failed (e.g. pg missing)', function(_, done) {
        var initErr = new Error('[PostgresqlConnector] pg is not installed');
        var onReady = makeOnReady(null, initErr);
        onReady(function(err, conn) {
            assert.strictEqual(err, initErr);
            assert.equal(conn, null);
            done();
        });
    });

    it('idle client error handler fires without crashing', function() {
        // Simulate the pool.on('error', ...) guard — must not throw.
        var emittedErr = null;
        var mockPool = {
            on: function(evt, cb) { if (evt === 'error') { cb(new Error('idle client error')); } }
        };
        assert.doesNotThrow(function() {
            mockPool.on('error', function(err) { emittedErr = err; });
        });
        assert.ok(emittedErr instanceof Error);
        assert.ok(/idle/.test(emittedErr.message));
    });

});


// ─── 04 — coerce() return-type logic ─────────────────────────────────────────

describe('04 - PostgreSQL coerce() — return-type coercions', function() {

    // Replicate the coerce() function from index.js.
    // pg wraps results in { rows, rowCount, command }.
    var makeCoerce = function(queryString, returnType) {
        var isSELECT = /^\s*SELECT\b/i.test(queryString);
        return function coerce(result) {
            if (isSELECT) {
                var rows = result.rows;
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
            if (returnType === 'boolean') return result.rowCount > 0;
            if (returnType === 'number')  return result.rowCount;
            return { changes: result.rowCount, command: result.command };
        };
    };

    var pgResult = function(rows, rowCount, command) {
        return { rows: rows || [], rowCount: rowCount || 0, command: command || 'SELECT' };
    };

    // SELECT coercions ────────────────────────────────────────────────────────

    it('@return {object} — returns first row when rows non-empty', function() {
        var coerce = makeCoerce('SELECT * FROM users WHERE id = $1', 'object');
        var row = { id: 1, name: 'Alice' };
        assert.deepEqual(coerce(pgResult([row], 1, 'SELECT')), row);
    });

    it('@return {object} — returns null when rows empty', function() {
        var coerce = makeCoerce('SELECT * FROM users WHERE id = $1', 'object');
        assert.equal(coerce(pgResult([], 0, 'SELECT')), null);
    });

    it('@return {array} — returns all rows when non-empty', function() {
        var coerce = makeCoerce('SELECT * FROM users', 'array');
        var rows = [{ id: 1 }, { id: 2 }];
        assert.deepEqual(coerce(pgResult(rows, 2, 'SELECT')), rows);
    });

    it('no annotation — returns all rows when non-empty (default SELECT)', function() {
        var coerce = makeCoerce('SELECT * FROM users', null);
        var rows = [{ id: 1 }];
        assert.deepEqual(coerce(pgResult(rows, 1, 'SELECT')), rows);
    });

    it('no annotation — returns null when SELECT rows empty', function() {
        var coerce = makeCoerce('SELECT * FROM users', null);
        assert.equal(coerce(pgResult([], 0, 'SELECT')), null);
    });

    it('@return {boolean} — returns true when rows exist', function() {
        var coerce = makeCoerce('SELECT id FROM users WHERE name = $1', 'boolean');
        assert.equal(coerce(pgResult([{ id: 1 }], 1, 'SELECT')), true);
    });

    it('@return {boolean} — returns false when no rows', function() {
        var coerce = makeCoerce('SELECT id FROM users WHERE name = $1', 'boolean');
        assert.equal(coerce(pgResult([], 0, 'SELECT')), false);
    });

    it('@return {number} — extracts COUNT(*) value as a Number', function() {
        var coerce = makeCoerce('SELECT COUNT(*) AS cnt FROM users', 'number');
        // pg returns count as string (bigint) — Number() coercion is applied
        assert.equal(coerce(pgResult([{ cnt: '7' }], 1, 'SELECT')), 7);
        assert.equal(typeof coerce(pgResult([{ cnt: '7' }], 1, 'SELECT')), 'number');
    });

    it('@return {number} COUNT — returns 0 when rows empty', function() {
        var coerce = makeCoerce('SELECT COUNT(*) AS cnt FROM users', 'number');
        assert.equal(coerce(pgResult([], 0, 'SELECT')), 0);
    });

    // Write op coercions ──────────────────────────────────────────────────────

    it('INSERT default — returns { changes, command: INSERT }', function() {
        var coerce = makeCoerce('INSERT INTO users (name) VALUES ($1)', null);
        var result = coerce(pgResult([], 1, 'INSERT'));
        assert.deepEqual(result, { changes: 1, command: 'INSERT' });
    });

    it('UPDATE default — returns { changes, command: UPDATE }', function() {
        var coerce = makeCoerce('UPDATE users SET name = $1 WHERE id = $2', null);
        var result = coerce(pgResult([], 3, 'UPDATE'));
        assert.deepEqual(result, { changes: 3, command: 'UPDATE' });
    });

    it('DELETE @return {boolean} — true when rowCount > 0', function() {
        var coerce = makeCoerce('DELETE FROM users WHERE id = $1', 'boolean');
        assert.equal(coerce(pgResult([], 1, 'DELETE')), true);
    });

    it('DELETE @return {boolean} — false when rowCount is 0', function() {
        var coerce = makeCoerce('DELETE FROM users WHERE id = $1', 'boolean');
        assert.equal(coerce(pgResult([], 0, 'DELETE')), false);
    });

    it('UPDATE @return {number} — returns rowCount', function() {
        var coerce = makeCoerce('UPDATE users SET active = true', 'number');
        assert.equal(coerce(pgResult([], 5, 'UPDATE')), 5);
    });

});


// ─── 05 — entity method Promise and .onComplete() with mock conn ──────────────

describe('05 - PostgreSQL entity method — Promise and .onComplete() pattern', function() {

    // Replicate the method-generation closure from index.js (pg async path —
    // no setTimeout(0): resolution happens directly in the query callback).
    var makeMethod = function(mockQuery, queryString, returnType) {
        var isSELECT = /^\s*SELECT\b/i.test(queryString);

        var coerce = function(result) {
            if (isSELECT) {
                var rows = result.rows;
                if (returnType === 'object')  return rows.length > 0 ? rows[0] : null;
                if (returnType === 'boolean') return rows.length > 0;
                return rows.length > 0 ? rows : null;
            }
            if (returnType === 'boolean') return result.rowCount > 0;
            return { changes: result.rowCount, command: result.command };
        };

        return function() {
            var args = Array.prototype.slice.call(arguments);
            var _mainCallback = null;
            if (typeof args[args.length - 1] === 'function') {
                _mainCallback = args.pop();
            }

            if (_mainCallback === null) {
                var _resolve, _reject, _internalData;
                var _promise = new Promise(function(resolve, reject) {
                    _resolve = resolve;
                    _reject  = reject;
                });
                _promise.onComplete = function(cb) {
                    _promise.then(
                        function()    { cb(null, _internalData); },
                        function(err) { cb(err); }
                    );
                    return _promise;
                };
                mockQuery(queryString, args, function(err, result) {
                    if (err) { _reject(err); return; }
                    var raw = coerce(result);
                    _internalData = raw;
                    _resolve(raw);
                });
                return _promise;
            } else {
                mockQuery(queryString, args, function(err, result) {
                    if (err) { _mainCallback(err); return; }
                    _mainCallback(null, coerce(result));
                });
            }
        };
    };

    var pgResult = function(rows, rowCount, command) {
        return { rows: rows || [], rowCount: rowCount || 0, command: command || 'SELECT' };
    };

    it('returns a Promise when no callback is provided', function() {
        var query = function(q, a, cb) { cb(null, pgResult([], 0)); };
        var method = makeMethod(query, 'SELECT 1', null);
        assert.ok(method() instanceof Promise);
    });

    it('returned Promise has .onComplete() attached', function() {
        var query = function(q, a, cb) { cb(null, pgResult([], 0)); };
        var method = makeMethod(query, 'SELECT 1', null);
        assert.equal(typeof method().onComplete, 'function');
    });

    it('.onComplete(cb) receives (null, data) on success', function(_, done) {
        var row = { id: 1 };
        var query = function(q, a, cb) { cb(null, pgResult([row], 1, 'SELECT')); };
        var method = makeMethod(query, 'SELECT * FROM users WHERE id = $1', 'object');
        method(1).onComplete(function(err, data) {
            assert.equal(err, null);
            assert.deepEqual(data, row);
            done();
        });
    });

    it('.onComplete(cb) receives (err) when query fails', function(_, done) {
        var query = function(q, a, cb) { cb(new Error('column "bad" does not exist')); };
        var method = makeMethod(query, 'SELECT bad FROM users', 'object');
        method().onComplete(function(err) {
            assert.ok(err instanceof Error);
            assert.ok(/does not exist/.test(err.message));
            done();
        });
    });

    it('await resolves with coerced result', function(_, done) {
        var rows = [{ id: 1 }, { id: 2 }];
        var query = function(q, a, cb) { cb(null, pgResult(rows, 2, 'SELECT')); };
        var method = makeMethod(query, 'SELECT * FROM users', 'array');
        method().then(function(data) {
            assert.deepEqual(data, rows);
            done();
        });
    });

    it('direct callback path calls cb(null, data) on success', function(_, done) {
        var query = function(q, a, cb) { cb(null, pgResult([], 1, 'INSERT')); };
        var method = makeMethod(query, 'INSERT INTO users (name) VALUES ($1)', null);
        method('Alice', function(err, data) {
            assert.equal(err, null);
            assert.deepEqual(data, { changes: 1, command: 'INSERT' });
            done();
        });
    });

    it('direct callback path calls cb(err) on failure', function(_, done) {
        var query = function(q, a, cb) { cb(new Error('connection terminated')); };
        var method = makeMethod(query, 'SELECT 1', null);
        method(function(err) {
            assert.ok(err instanceof Error);
            assert.ok(/connection terminated/.test(err.message));
            done();
        });
    });

    it('@return {boolean} INSERT — resolves true when rowCount > 0', function(_, done) {
        var query = function(q, a, cb) { cb(null, pgResult([], 1, 'INSERT')); };
        var method = makeMethod(query, 'INSERT INTO users (name) VALUES ($1)', 'boolean');
        method('Bob').then(function(data) {
            assert.equal(data, true);
            done();
        });
    });

    it('@return {boolean} DELETE — resolves false when rowCount is 0', function(_, done) {
        var query = function(q, a, cb) { cb(null, pgResult([], 0, 'DELETE')); };
        var method = makeMethod(query, 'DELETE FROM users WHERE id = $1', 'boolean');
        method(9999).then(function(data) {
            assert.equal(data, false);
            done();
        });
    });

});


// ─── 06 — @param type casting ────────────────────────────────────────────────

describe('06 - PostgreSQL @param type casting', function() {

    // Replicate the casting loop from index.js — identical to MySQL.
    var castParams = function(args, paramTypes) {
        args = args.slice();
        for (var t = 0; t < paramTypes.length && t < args.length; t++) {
            switch (paramTypes[t]) {
                case 'number':
                case 'integer': args[t] = parseInt(args[t], 10);                          break;
                case 'float':   args[t] = parseFloat(String(args[t]).replace(/,/, '.')); break;
                case 'string':  args[t] = String(args[t]);                                break;
            }
        }
        return args;
    };

    it('casts string → integer for @param {integer}', function() {
        assert.deepEqual(castParams(['42'], ['integer']), [42]);
    });

    it('casts string → integer for @param {number}', function() {
        assert.deepEqual(castParams(['7'], ['number']), [7]);
    });

    it('casts comma-decimal to float for @param {float}', function() {
        assert.equal(castParams(['3,14'], ['float'])[0], 3.14);
    });

    it('casts dot-decimal to float for @param {float}', function() {
        assert.equal(castParams(['1.5'], ['float'])[0], 1.5);
    });

    it('casts number to string for @param {string}', function() {
        assert.deepEqual(castParams([123], ['string']), ['123']);
    });

    it('casts mixed types in order ($1=string $2=integer $3=float)', function() {
        var result = castParams(['hello', '99', '2.5'], ['string', 'integer', 'float']);
        assert.deepEqual(result, ['hello', 99, 2.5]);
    });

    it('leaves extra args beyond @param count untouched', function() {
        assert.deepEqual(castParams(['alice', 'extra'], ['string']), ['alice', 'extra']);
    });

    it('leaves args untouched when paramTypes is empty', function() {
        assert.deepEqual(castParams([1, 2], []), [1, 2]);
    });

});
