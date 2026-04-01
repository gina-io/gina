'use strict';
/**
 * MySQL connector — ORM / entity wiring tests
 *
 * Strategy: source inspection + inline logic replicas.
 * No live MySQL server, no framework bootstrap, no project required.
 * Mock conn.execute() / pool.getConnection() stand in for the real driver.
 */
var { describe, it, before } = require('node:test');
var assert  = require('node:assert/strict');
var path    = require('path');
var fs      = require('fs');

var FW = require('../fw');
var CONNECTOR_INDEX = path.join(FW, 'core/connectors/mysql/index.js');
var CONNECTOR_LIB   = path.join(FW, 'core/connectors/mysql/lib/connector.js');


// ─── 01 — source: lib/connector.js ───────────────────────────────────────────

describe('01 - MySQL connector: lib/connector.js source', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR_LIB, 'utf8'); });

    it('exports a MysqlConnector constructor', function() {
        assert.ok(/function MysqlConnector/.test(src));
        assert.ok(/module\.exports\s*=\s*MysqlConnector/.test(src));
    });

    it('loads mysql2 from project node_modules (not from framework)', function() {
        assert.ok(/getPath\('project'\)/.test(src));
        assert.ok(/node_modules\/mysql2/.test(src));
    });

    it('wraps mysql2 require in a try/catch guard', function() {
        assert.ok(/try\s*\{/.test(src));
        assert.ok(/catch\s*\(/.test(src));
    });

    it('uses mysql.createPool() for connection pooling', function() {
        assert.ok(/mysql\.createPool\(poolConf\)/.test(src));
    });

    it('defaults host to 127.0.0.1 when absent', function() {
        assert.ok(/conf\.host\s*\|\|\s*'127\.0\.0\.1'/.test(src));
    });

    it('defaults port to 3306 when absent', function() {
        assert.ok(/conf\.port\s*\|\|\s*3306/.test(src));
    });

    it('defaults connectionLimit to 10 when absent', function() {
        assert.ok(/conf\.connectionLimit\s*\|\|\s*10/.test(src));
    });

    it('passes ssl option through to mysql2 when present', function() {
        assert.ok(/conf\.ssl/.test(src));
        assert.ok(/poolConf\.ssl\s*=\s*conf\.ssl/.test(src));
    });

    it('onReady() uses pool.getConnection() for ping', function() {
        assert.ok(/_conn\.getConnection\(function/.test(src));
    });

    it('onReady() releases the connection after successful ping', function() {
        assert.ok(/connection\.release\(\)/.test(src));
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

    it('inherits from EventEmitter', function() {
        assert.ok(/EventEmitter/.test(src));
        assert.ok(/inherits\(MysqlConnector,\s*EventEmitter\)/.test(src));
    });

});


// ─── 02 — source: index.js ───────────────────────────────────────────────────

describe('02 - MySQL connector: index.js source', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR_INDEX, 'utf8'); });

    it('exports a Mysql constructor function', function() {
        assert.ok(/function Mysql\(/.test(src));
        assert.ok(/module\.exports\s*=\s*Mysql/.test(src));
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

    it('uses conn.execute() (not conn.prepare) — mysql2 auto-prepares', function() {
        assert.ok(/conn\.execute\(/.test(src));
        assert.ok(!/conn\.prepare\(/.test(src));
    });

    it('returns native Promise with .onComplete() shim from entity methods', function() {
        assert.ok(/new Promise/.test(src));
        assert.ok(/\.onComplete\s*=\s*function/.test(src));
    });

    it('does NOT use setTimeout(0) — mysql2 is natively async', function() {
        assert.ok(!/setTimeout\(function\(\)\s*\{/.test(src));
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

    it('uses affectedRows for write op results', function() {
        assert.ok(/affectedRows/.test(src));
    });

    it('uses insertId in default write result', function() {
        assert.ok(/insertId/.test(src));
    });

    it('default write result is { changes, insertId }', function() {
        assert.ok(/changes\s*:\s*results\.affectedRows/.test(src));
        assert.ok(/insertId\s*:\s*results\.insertId/.test(src));
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

    it('trigger prefix is MySQL: for dev logging', function() {
        assert.ok(/'MySQL:'/.test(src));
    });

    it('appends sql file path to error message for traceability', function() {
        assert.ok(/err\.message\s*=\s*'\[\s*'\s*\+\s*source/.test(src));
    });

});


// ─── 03 — MysqlConnector logic (mock mysql2) ─────────────────────────────────

describe('03 - MysqlConnector logic', function() {

    // Replicate the onReady logic inline using a mock pool.
    var makeOnReady = function(mockPool, initErr) {
        var _conn = mockPool;
        var _err  = initErr || null;
        return function(fn) {
            if (_err) return fn(_err, null);
            _conn.getConnection(function(err, connection) {
                if (err) {
                    fn(new Error('[MysqlConnector] Connection failed: ' + err.message), null);
                    return;
                }
                connection.release();
                fn(null, _conn);
            });
        };
    };

    it('onReady calls fn(null, pool) on successful getConnection', function(_, done) {
        var mockConn = { release: function() {} };
        var mockPool = {
            _name: 'testdb',
            getConnection: function(cb) { cb(null, mockConn); }
        };
        var onReady = makeOnReady(mockPool, null);
        onReady(function(err, conn) {
            assert.equal(err, null);
            assert.strictEqual(conn, mockPool);
            done();
        });
    });

    it('onReady releases the connection after ping', function(_, done) {
        var released = false;
        var mockConn = { release: function() { released = true; } };
        var mockPool = { getConnection: function(cb) { cb(null, mockConn); } };
        var onReady  = makeOnReady(mockPool, null);
        onReady(function() {
            assert.ok(released, 'connection.release() must be called');
            done();
        });
    });

    it('onReady calls fn(err, null) when getConnection fails', function(_, done) {
        var mockPool = {
            getConnection: function(cb) { cb(new Error('ECONNREFUSED'), null); }
        };
        var onReady = makeOnReady(mockPool, null);
        onReady(function(err, conn) {
            assert.ok(err instanceof Error);
            assert.ok(/Connection failed/.test(err.message));
            assert.equal(conn, null);
            done();
        });
    });

    it('onReady calls fn(_err, null) when init failed (e.g. mysql2 missing)', function(_, done) {
        var initErr = new Error('[MysqlConnector] mysql2 is not installed');
        var onReady = makeOnReady(null, initErr);
        onReady(function(err, conn) {
            assert.strictEqual(err, initErr);
            assert.equal(conn, null);
            done();
        });
    });

});


// ─── 04 — coerce() return-type logic ─────────────────────────────────────────

describe('04 - MySQL coerce() — return-type coercions', function() {

    // Replicate the coerce() function from index.js.
    var makeCoerce = function(queryString, returnType) {
        var isSELECT = /^\s*SELECT\b/i.test(queryString);
        return function coerce(results) {
            if (isSELECT) {
                var rows = results;
                if (returnType === 'object')  return (rows.length > 0) ? rows[0] : null;
                if (returnType === 'boolean') return rows.length > 0;
                if (returnType === 'number' && /count\s*\(/i.test(queryString)) {
                    if (rows.length > 0 && typeof rows[0] === 'object') {
                        var keys = Object.keys(rows[0]);
                        return (keys.length > 0) ? rows[0][keys[0]] : 0;
                    }
                    return 0;
                }
                return rows.length > 0 ? rows : null;
            }
            if (returnType === 'boolean') return results.affectedRows > 0;
            if (returnType === 'number')  return results.affectedRows;
            return { changes: results.affectedRows, insertId: results.insertId };
        };
    };

    // SELECT coercions ────────────────────────────────────────────────────────

    it('@return {object} — returns first row when results non-empty', function() {
        var coerce = makeCoerce('SELECT * FROM users WHERE id = ?', 'object');
        var row = { id: 1, name: 'Alice' };
        assert.deepEqual(coerce([row]), row);
    });

    it('@return {object} — returns null when results empty', function() {
        var coerce = makeCoerce('SELECT * FROM users WHERE id = ?', 'object');
        assert.equal(coerce([]), null);
    });

    it('@return {array} — returns all rows when non-empty', function() {
        var coerce = makeCoerce('SELECT * FROM users', 'array');
        var rows = [{ id: 1 }, { id: 2 }];
        assert.deepEqual(coerce(rows), rows);
    });

    it('no annotation — returns all rows when non-empty (default SELECT)', function() {
        var coerce = makeCoerce('SELECT * FROM users', null);
        var rows = [{ id: 1 }, { id: 2 }];
        assert.deepEqual(coerce(rows), rows);
    });

    it('no annotation — returns null when SELECT result is empty', function() {
        var coerce = makeCoerce('SELECT * FROM users', null);
        assert.equal(coerce([]), null);
    });

    it('@return {boolean} — returns true when rows exist', function() {
        var coerce = makeCoerce('SELECT id FROM users WHERE name = ?', 'boolean');
        assert.equal(coerce([{ id: 1 }]), true);
    });

    it('@return {boolean} — returns false when no rows', function() {
        var coerce = makeCoerce('SELECT id FROM users WHERE name = ?', 'boolean');
        assert.equal(coerce([]), false);
    });

    it('@return {number} — extracts COUNT(*) value from first row', function() {
        var coerce = makeCoerce('SELECT COUNT(*) AS cnt FROM users', 'number');
        assert.equal(coerce([{ cnt: 7 }]), 7);
    });

    it('@return {number} COUNT — returns 0 when result set empty', function() {
        var coerce = makeCoerce('SELECT COUNT(*) AS cnt FROM users', 'number');
        assert.equal(coerce([]), 0);
    });

    // Write op coercions ──────────────────────────────────────────────────────

    it('INSERT default — returns { changes, insertId }', function() {
        var coerce = makeCoerce('INSERT INTO users (name) VALUES (?)', null);
        var result = coerce({ affectedRows: 1, insertId: 42 });
        assert.deepEqual(result, { changes: 1, insertId: 42 });
    });

    it('UPDATE default — returns { changes, insertId: 0 }', function() {
        var coerce = makeCoerce('UPDATE users SET name = ? WHERE id = ?', null);
        var result = coerce({ affectedRows: 2, insertId: 0 });
        assert.deepEqual(result, { changes: 2, insertId: 0 });
    });

    it('DELETE @return {boolean} — true when affectedRows > 0', function() {
        var coerce = makeCoerce('DELETE FROM users WHERE id = ?', 'boolean');
        assert.equal(coerce({ affectedRows: 1, insertId: 0 }), true);
    });

    it('DELETE @return {boolean} — false when no rows deleted', function() {
        var coerce = makeCoerce('DELETE FROM users WHERE id = ?', 'boolean');
        assert.equal(coerce({ affectedRows: 0, insertId: 0 }), false);
    });

    it('UPDATE @return {number} — returns affectedRows count', function() {
        var coerce = makeCoerce('UPDATE users SET active = 1', 'number');
        assert.equal(coerce({ affectedRows: 5, insertId: 0 }), 5);
    });

});


// ─── 05 — entity method Promise and .onComplete() with mock conn ──────────────

describe('05 - MySQL entity method — Promise and .onComplete() pattern', function() {

    // Replicate the method-generation closure from index.js (mysql2 async path —
    // no setTimeout(0): resolution happens directly in the execute callback).
    var makeMethod = function(mockExecute, queryString, returnType) {
        var isSELECT = /^\s*SELECT\b/i.test(queryString);

        var coerce = function(results) {
            if (isSELECT) {
                var rows = results;
                if (returnType === 'object')  return rows.length > 0 ? rows[0] : null;
                if (returnType === 'boolean') return rows.length > 0;
                return rows.length > 0 ? rows : null;
            }
            if (returnType === 'boolean') return results.affectedRows > 0;
            return { changes: results.affectedRows, insertId: results.insertId };
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
                mockExecute(queryString, args, function(err, results) {
                    if (err) { _reject(err); return; }
                    var raw = coerce(results);
                    _internalData = raw;
                    _resolve(raw);
                });
                return _promise;
            } else {
                mockExecute(queryString, args, function(err, results) {
                    if (err) { _mainCallback(err); return; }
                    _mainCallback(null, coerce(results));
                });
            }
        };
    };

    it('returns a Promise when no callback is provided', function() {
        var exec = function(q, a, cb) { cb(null, []); };
        var method = makeMethod(exec, 'SELECT 1', null);
        var result = method();
        assert.ok(result instanceof Promise);
    });

    it('returned Promise has .onComplete() attached', function() {
        var exec = function(q, a, cb) { cb(null, []); };
        var method = makeMethod(exec, 'SELECT 1', null);
        var result = method();
        assert.equal(typeof result.onComplete, 'function');
    });

    it('.onComplete(cb) receives (null, data) on success', function(_, done) {
        var exec = function(q, a, cb) { cb(null, [{ id: 1 }]); };
        var method = makeMethod(exec, 'SELECT * FROM users WHERE id = ?', 'object');
        method(1).onComplete(function(err, data) {
            assert.equal(err, null);
            assert.deepEqual(data, { id: 1 });
            done();
        });
    });

    it('.onComplete(cb) receives (err) when execute fails', function(_, done) {
        var exec = function(q, a, cb) { cb(new Error('ER_BAD_FIELD_ERROR')); };
        var method = makeMethod(exec, 'SELECT bad FROM users', 'object');
        method().onComplete(function(err, data) {
            assert.ok(err instanceof Error);
            assert.ok(/ER_BAD_FIELD_ERROR/.test(err.message));
            done();
        });
    });

    it('await resolves with coerced result', function(_, done) {
        var rows = [{ id: 1 }, { id: 2 }];
        var exec = function(q, a, cb) { cb(null, rows); };
        var method = makeMethod(exec, 'SELECT * FROM users', 'array');
        method().then(function(data) {
            assert.deepEqual(data, rows);
            done();
        });
    });

    it('direct callback path calls cb(null, data)', function(_, done) {
        var exec = function(q, a, cb) { cb(null, { affectedRows: 1, insertId: 5 }); };
        var method = makeMethod(exec, 'INSERT INTO users (name) VALUES (?)', null);
        method('Alice', function(err, data) {
            assert.equal(err, null);
            assert.deepEqual(data, { changes: 1, insertId: 5 });
            done();
        });
    });

    it('direct callback path calls cb(err) on failure', function(_, done) {
        var exec = function(q, a, cb) { cb(new Error('connection lost')); };
        var method = makeMethod(exec, 'SELECT 1', null);
        method(function(err) {
            assert.ok(err instanceof Error);
            assert.ok(/connection lost/.test(err.message));
            done();
        });
    });

    it('@return {boolean} write — resolves true when affectedRows > 0', function(_, done) {
        var exec = function(q, a, cb) { cb(null, { affectedRows: 1, insertId: 0 }); };
        var method = makeMethod(exec, 'UPDATE users SET active = 1 WHERE id = ?', 'boolean');
        method(1).then(function(data) {
            assert.equal(data, true);
            done();
        });
    });

    it('@return {boolean} write — resolves false when affectedRows is 0', function(_, done) {
        var exec = function(q, a, cb) { cb(null, { affectedRows: 0, insertId: 0 }); };
        var method = makeMethod(exec, 'UPDATE users SET active = 1 WHERE id = ?', 'boolean');
        method(9999).then(function(data) {
            assert.equal(data, false);
            done();
        });
    });

});


// ─── 06 — @param type casting ────────────────────────────────────────────────

describe('06 - MySQL @param type casting', function() {

    // Replicate the casting loop from index.js.
    var castParams = function(args, paramTypes) {
        args = args.slice(); // don't mutate original
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
        var result = castParams(['3,14'], ['float']);
        assert.equal(result[0], 3.14);
    });

    it('casts dot-decimal to float for @param {float}', function() {
        var result = castParams(['1.5'], ['float']);
        assert.equal(result[0], 1.5);
    });

    it('casts number to string for @param {string}', function() {
        assert.deepEqual(castParams([123], ['string']), ['123']);
    });

    it('casts mixed types in order', function() {
        var result = castParams(['hello', '99', '2.5'], ['string', 'integer', 'float']);
        assert.deepEqual(result, ['hello', 99, 2.5]);
    });

    it('leaves extra args beyond @param count untouched', function() {
        var result = castParams(['alice', 'extra'], ['string']);
        assert.deepEqual(result, ['alice', 'extra']);
    });

    it('leaves args untouched when paramTypes is empty', function() {
        assert.deepEqual(castParams([1, 2], []), [1, 2]);
    });

});
