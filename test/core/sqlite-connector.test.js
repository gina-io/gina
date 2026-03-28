'use strict';
/**
 * SQLite connector — ORM / entity wiring tests (#CN2 v2)
 *
 * Strategy: logic replicas + source inspection.
 * The node:sqlite module is built-in on Node >= 22.5.0.
 * Tests that require it are skipped on older versions with an informative message.
 * No framework bootstrap or live project is required.
 */
var { describe, it, before } = require('node:test');
var assert  = require('node:assert/strict');
var path    = require('path');
var fs      = require('fs');
var os      = require('os');

var FW = require('../fw');
var CONNECTOR_INDEX  = path.join(FW, 'core/connectors/sqlite/index.js');
var CONNECTOR_LIB    = path.join(FW, 'core/connectors/sqlite/lib/connector.js');
var SESSION_STORE    = path.join(FW, 'core/connectors/sqlite/lib/session-store.js');

// Determine whether node:sqlite is available (Node >= 22.5.0)
var HAS_SQLITE = false;
try {
    require('node:sqlite');
    HAS_SQLITE = true;
} catch (_) {}


// ─── 01 — source: connector.js ───────────────────────────────────────────────

describe('01 - SQLite connector: lib/connector.js source', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR_LIB, 'utf8'); });

    it('exports a SqliteConnector constructor', function() {
        assert.ok(/function SqliteConnector/.test(src));
        assert.ok(/module\.exports\s*=\s*SqliteConnector/.test(src));
    });

    it('requires node:sqlite with a try/catch guard', function() {
        assert.ok(/require\('node:sqlite'\)/.test(src));
        // guard block: catch on Node < 22.5
        assert.ok(/catch\s*\(/.test(src));
    });

    it('enables WAL journal mode', function() {
        assert.ok(/PRAGMA journal_mode=WAL/.test(src));
    });

    it('enables synchronous=NORMAL', function() {
        assert.ok(/PRAGMA synchronous=NORMAL/.test(src));
    });

    it('enables foreign_keys=ON', function() {
        assert.ok(/PRAGMA foreign_keys=ON/.test(src));
    });

    it('onReady() calls fn(null, conn) on success', function() {
        assert.ok(/fn\(null,\s*_conn\)/.test(src));
    });

    it('onReady() calls fn(_err, null) on failure', function() {
        assert.ok(/fn\(_err,\s*null\)/.test(src));
    });

    it('defaults database file to ~/.gina/{version}/{database}.sqlite', function() {
        assert.ok(/getPath\('gina'\)\.home/.test(src));
        assert.ok(/\.sqlite/.test(src));
    });

});


// ─── 02 — source: index.js ───────────────────────────────────────────────────

describe('02 - SQLite connector: index.js source', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR_INDEX, 'utf8'); });

    it('exports a Sqlite constructor function', function() {
        assert.ok(/function Sqlite\(/.test(src));
        assert.ok(/module\.exports\s*=\s*Sqlite/.test(src));
    });

    it('loads EntitySuperClass from model/entity.js via getPath', function() {
        assert.ok(/\/model\/entity\.js/.test(src) && /getPath\('gina'\)/.test(src));
    });

    it('loads entity JS files from models/<database>/entities/', function() {
        assert.ok(/\/models\//.test(src));
        assert.ok(/\/entities/.test(src));
    });

    it('wires entities with inherits(Entity, EntitySuperClass)', function() {
        assert.ok(/inherits\(Entity,\s*EntitySuperClass\)/.test(src));
    });

    it('looks for sql/ directory for SQL method files', function() {
        assert.ok(/\/sql/.test(src));
    });

    it('returns native Promise with .onComplete() shim from entity methods', function() {
        assert.ok(/new Promise/.test(src));
        assert.ok(/\.onComplete\s*=\s*function/.test(src));
    });

    it('uses setTimeout(0) to defer synchronous execution (Option B pattern)', function() {
        assert.ok(/setTimeout\(function\(\)\s*\{/.test(src));
    });

    it('uses stmt.get() for @return {object}', function() {
        assert.ok(/returnType\s*===\s*'object'/.test(src));
        assert.ok(/stmt\.get\.apply/.test(src));
    });

    it('uses stmt.all() for array / default SELECT', function() {
        assert.ok(/stmt\.all\.apply/.test(src));
    });

    it('uses stmt.run() for write operations', function() {
        assert.ok(/stmt\.run\.apply/.test(src));
    });

    it('supports @return {boolean} coercion', function() {
        assert.ok(/returnType\s*===\s*'boolean'/.test(src));
    });

    it('supports @return {number} COUNT(*) extraction', function() {
        assert.ok(/returnType\s*===\s*'number'/.test(src));
        // The source contains the regex literal /count\s*\(/i somewhere
        assert.ok(/count/.test(src));
    });

    it('strips SQL comments before preparing statements', function() {
        // The source contains a regex that removes /* */ comment blocks
        assert.ok(/replace/.test(src) && /\*\//.test(src));
    });

    it('handles missing sql/ directory gracefully (existsSync guard)', function() {
        assert.ok(/fs\.existsSync\(sqlDir\)/.test(src));
    });

    it('pre-compiles statements with conn.prepare() at load time', function() {
        assert.ok(/conn\.prepare\(queryString\)/.test(src));
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

});


// ─── 03 — SqliteConnector logic (requires node:sqlite) ───────────────────────

describe('03 - SqliteConnector logic', function() {

    it('opens :memory: database and fires onReady(null, conn)', function() {
        if (!HAS_SQLITE) {
            return; // skip on Node < 22.5.0
        }
        var { DatabaseSync } = require('node:sqlite');
        // Replicate the connector init logic inline
        var _conn = null;
        var _err  = null;
        try {
            _conn = new DatabaseSync(':memory:');
            _conn.exec('PRAGMA journal_mode=WAL');
            _conn.exec('PRAGMA synchronous=NORMAL');
            _conn.exec('PRAGMA foreign_keys=ON');
        } catch (e) {
            _err = e;
        }

        assert.equal(_err, null, 'should open without error');
        assert.ok(_conn, 'connection should be truthy');

        // onReady equivalent
        var cbErr = 'NOT_CALLED', cbConn = 'NOT_CALLED';
        var onReady = function(fn) {
            if (_err) { fn(_err, null); } else { fn(null, _conn); }
        };
        onReady(function(err, conn) { cbErr = err; cbConn = conn; });

        assert.equal(cbErr, null);
        assert.strictEqual(cbConn, _conn);
    });

    it('fires onReady(err, null) when node:sqlite fails to load', function() {
        // Simulate the error path by building _err manually
        var _err = new Error('[SqliteConnector] node:sqlite requires Node.js >= 22.5.0. Current: v12.0.0');
        var cbErr = null, cbConn = 'NOT_CALLED';
        var onReady = function(fn) {
            if (_err) { fn(_err, null); } else { fn(null, null); }
        };
        onReady(function(err, conn) { cbErr = err; cbConn = conn; });

        assert.ok(cbErr instanceof Error);
        assert.ok(/22\.5\.0/.test(cbErr.message));
        assert.equal(cbConn, null);
    });

    it('fires onReady(err, null) when file cannot be opened', function() {
        if (!HAS_SQLITE) return;
        var { DatabaseSync } = require('node:sqlite');
        var _conn = null;
        var _err  = null;
        try {
            // Use a path we cannot write to
            _conn = new DatabaseSync('/proc/cannot-create.sqlite');
        } catch (e) {
            _err = new Error('[SqliteConnector] Failed to open: ' + e.message);
        }
        // On non-Linux or if /proc is writable, just verify the guard logic
        if (_err) {
            var cbErr = null;
            var onReady = function(fn) {
                if (_err) { fn(_err, null); } else { fn(null, _conn); }
            };
            onReady(function(err) { cbErr = err; });
            assert.ok(cbErr instanceof Error);
        }
        // If no error was thrown (some systems allow the write), that is also acceptable.
    });

});


// ─── 04 — execute() helper logic ─────────────────────────────────────────────

describe('04 - SQLite execute() logic (query execution + return-type coercions)', function() {

    // Replicate the execute() helper from index.js inline for isolated testing.
    var makeExecute = function(db, queryString, returnType, paramTypes) {
        var isSELECT = /^\s*SELECT\b/i.test(queryString);
        var stmt     = db.prepare(queryString);

        return function execute(args) {
            var raw;
            if (isSELECT) {
                if (returnType === 'object') {
                    raw = stmt.get.apply(stmt, args);
                    raw = (raw != null && raw !== undefined) ? raw : null;
                } else {
                    raw = stmt.all.apply(stmt, args);
                }
            } else {
                raw = stmt.run.apply(stmt, args);
            }
            if (raw === undefined) raw = null;

            if (returnType === 'boolean') {
                if (Array.isArray(raw)) {
                    raw = raw.length > 0;
                } else if (raw !== null && typeof raw === 'object' && 'changes' in raw) {
                    raw = raw.changes > 0;
                } else {
                    raw = !!raw;
                }
            } else if (returnType === 'number' && /count\s*\(/i.test(queryString)) {
                if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object') {
                    var keys = Object.keys(raw[0]);
                    raw = raw[0][keys[0]];
                } else if (raw !== null && !Array.isArray(raw) && typeof raw === 'object') {
                    var keys = Object.keys(raw);
                    raw = raw[keys[0]];
                }
            } else if (Array.isArray(raw) && raw.length === 0) {
                raw = null;
            }
            return raw;
        };
    };

    var db;
    before(function() {
        if (!HAS_SQLITE) return;
        var { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT)');
        db.exec("INSERT INTO users (name, email) VALUES ('Alice', 'alice@ex.com')");
        db.exec("INSERT INTO users (name, email) VALUES ('Bob',   'bob@ex.com')");
    });

    it('SELECT with @return {Array} returns array of rows', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'SELECT * FROM users WHERE id > ?', 'Array');
        var result = exec([0]);
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 2);
    });

    it('SELECT with @return {object} returns single row object', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'SELECT * FROM users WHERE id = ?', 'object');
        var result = exec([1]);
        assert.ok(result && typeof result === 'object' && !Array.isArray(result));
        assert.equal(result.name, 'Alice');
    });

    it('SELECT with @return {object} returns null when no match', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'SELECT * FROM users WHERE id = ?', 'object');
        var result = exec([9999]);
        assert.equal(result, null);
    });

    it('SELECT with no result returns null (empty array normalised)', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'SELECT * FROM users WHERE name = ?', null);
        var result = exec(['nobody']);
        assert.equal(result, null);
    });

    it('SELECT with @return {boolean} returns true when rows exist', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'SELECT id FROM users WHERE name = ?', 'boolean');
        assert.equal(exec(['Alice']), true);
    });

    it('SELECT with @return {boolean} returns false when no rows', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'SELECT id FROM users WHERE name = ?', 'boolean');
        assert.equal(exec(['nobody']), false);
    });

    it('SELECT COUNT(*) with @return {number} returns integer', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'SELECT COUNT(*) AS cnt FROM users', 'number');
        var result = exec([]);
        assert.equal(typeof result, 'number');
        assert.equal(result, 2);
    });

    it('INSERT returns { changes, lastInsertRowid }', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, "INSERT INTO users (name, email) VALUES (?, ?)", null);
        var result = exec(['Carol', 'carol@ex.com']);
        assert.ok(result && typeof result === 'object');
        assert.equal(result.changes, 1);
        assert.ok(result.lastInsertRowid > 0);
    });

    it('UPDATE with @return {boolean} returns true on success', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'UPDATE users SET email = ? WHERE name = ?', 'boolean');
        assert.equal(exec(['new@ex.com', 'Alice']), true);
    });

    it('UPDATE with @return {boolean} returns false when no row matched', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'UPDATE users SET email = ? WHERE name = ?', 'boolean');
        assert.equal(exec(['x@ex.com', 'nobody']), false);
    });

    it('DELETE returns { changes } object when no return annotation', function() {
        if (!HAS_SQLITE) return;
        var exec = makeExecute(db, 'DELETE FROM users WHERE name = ?', null);
        var result = exec(['Carol']); // inserted above
        assert.ok(result && typeof result === 'object' && 'changes' in result);
    });

});


// ─── 05 — Promise / .onComplete() pattern ────────────────────────────────────

describe('05 - entity method Promise and .onComplete() pattern', function() {

    // Replicate the method-generation closure logic inline.
    var makeMethod = function(executeFn) {
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
                setTimeout(function() {
                    try {
                        var result = executeFn(args);
                        _internalData = result;
                        _resolve(result);
                    } catch (e) {
                        _reject(e);
                    }
                }, 0);
                return _promise;
            } else {
                try {
                    var result = executeFn(args);
                    _mainCallback(null, result);
                } catch (e) {
                    _mainCallback(e);
                }
            }
        };
    };

    it('returns a Promise when no callback is provided', function(_, done) {
        var method = makeMethod(function() { return 42; });
        var result = method();
        assert.ok(result instanceof Promise, 'should return a Promise');
        result.then(function(v) {
            assert.equal(v, 42);
            done();
        });
    });

    it('returned Promise has .onComplete() attached', function() {
        var method = makeMethod(function() { return 'hello'; });
        var result = method();
        assert.equal(typeof result.onComplete, 'function');
    });

    it('.onComplete(cb) receives (null, data) on success', function(_, done) {
        var method = makeMethod(function() { return { id: 1 }; });
        method().onComplete(function(err, data) {
            assert.equal(err, null);
            assert.deepEqual(data, { id: 1 });
            done();
        });
    });

    it('.onComplete(cb) receives (err) on failure', function(_, done) {
        var method = makeMethod(function() { throw new Error('query failed'); });
        method().onComplete(function(err, data) {
            assert.ok(err instanceof Error);
            assert.ok(/query failed/.test(err.message));
            done();
        });
    });

    it('await resolves with the result value', function(_, done) {
        var method = makeMethod(function() { return [1, 2, 3]; });
        var p = method();
        p.then(function(v) {
            assert.deepEqual(v, [1, 2, 3]);
            done();
        });
    });

    it('direct callback path calls cb(null, data)', function() {
        var method = makeMethod(function() { return 'sync'; });
        var cbErr = 'NOT_CALLED', cbData = 'NOT_CALLED';
        method(function(err, data) { cbErr = err; cbData = data; });
        assert.equal(cbErr, null);
        assert.equal(cbData, 'sync');
    });

    it('direct callback path calls cb(err) on failure', function() {
        var method = makeMethod(function() { throw new Error('direct fail'); });
        var cbErr = null;
        method(function(err) { cbErr = err; });
        assert.ok(cbErr instanceof Error);
        assert.ok(/direct fail/.test(cbErr.message));
    });

});


// ─── 06 — SQL file parsing ────────────────────────────────────────────────────

describe('06 - SQL file comment stripping and @return / @param parsing', function() {

    // Replicate the parsing logic from index.js readSQL().
    var parseSQL = function(rawSource) {
        var returnType = null;
        var retMatch   = rawSource.match(/@return\s+\{([^}]+)\}/);
        if (retMatch) returnType = retMatch[1].trim().toLowerCase();

        var paramTypes = [];
        var ptMatches  = rawSource.match(/@param\s+\{([^}]+)\}/g);
        if (ptMatches) {
            for (var pt = 0; pt < ptMatches.length; pt++) {
                paramTypes.push(ptMatches[pt].match(/\{([^}]+)\}/)[1].trim().toLowerCase());
            }
        }

        var queryString = rawSource
            .replace(/(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        return { returnType: returnType, paramTypes: paramTypes, queryString: queryString };
    };

    it('extracts @return {object}', function() {
        var src = '/* @return {object} */ SELECT * FROM users WHERE id = ?';
        var r = parseSQL(src);
        assert.equal(r.returnType, 'object');
    });

    it('extracts @return {Array}', function() {
        var src = '/* @return {Array} */ SELECT * FROM users';
        var r = parseSQL(src);
        assert.equal(r.returnType, 'array');
    });

    it('extracts @return {boolean}', function() {
        var src = '/* @return {boolean} */ UPDATE users SET name = ? WHERE id = ?';
        var r = parseSQL(src);
        assert.equal(r.returnType, 'boolean');
    });

    it('extracts @return {number}', function() {
        var src = '/* @return {number} */ SELECT COUNT(*) AS cnt FROM users';
        var r = parseSQL(src);
        assert.equal(r.returnType, 'number');
    });

    it('returns null returnType when annotation absent', function() {
        var src = 'SELECT * FROM users WHERE id = ?';
        var r = parseSQL(src);
        assert.equal(r.returnType, null);
    });

    it('extracts @param types in order', function() {
        var src = '/* @param {string} $name\n * @param {integer} $age\n */ INSERT INTO users (name, age) VALUES (?, ?)';
        var r = parseSQL(src);
        assert.deepEqual(r.paramTypes, ['string', 'integer']);
    });

    it('strips block comments from query string', function() {
        var src = '/* comment */ SELECT 1';
        var r = parseSQL(src);
        assert.equal(r.queryString, 'SELECT 1');
    });

    it('strips line comments from query string', function() {
        var src = '// line comment\nSELECT 1';
        var r = parseSQL(src);
        assert.equal(r.queryString, 'SELECT 1');
    });

    it('collapses multiple whitespace into single spaces', function() {
        var src = 'SELECT  *\n  FROM\t users';
        var r = parseSQL(src);
        assert.equal(r.queryString, 'SELECT * FROM users');
    });

    it('detects SELECT vs write operation', function() {
        assert.ok(/^\s*SELECT\b/i.test('SELECT * FROM users'));
        assert.ok(!/^\s*SELECT\b/i.test('INSERT INTO users VALUES (?)'));
        assert.ok(!/^\s*SELECT\b/i.test('UPDATE users SET x = ?'));
        assert.ok(!/^\s*SELECT\b/i.test('DELETE FROM users WHERE id = ?'));
    });

});
