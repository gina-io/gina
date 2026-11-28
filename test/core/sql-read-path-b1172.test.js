/**
 * #B1172 — the PostgreSQL and MySQL connectors ask the driver's answer whether a statement
 * returned rows, instead of reading the statement's first keyword.
 *
 * Before the fix both connectors took the row branch only for a statement starting with
 * `SELECT`: a `WITH … SELECT`, a `VALUES`, a `SHOW` or a write with `RETURNING` came back
 * shaped as a write and its rows were lost, and a `SELECT … INTO` (which returns no rows) took
 * the row branch. The answer now decides: pg's `result.fields` (filled from the server's row
 * description, `[]` for a statement that returns none), mysql2's array of rows versus its
 * `ResultSetHeader`. The leading-`SELECT` keyword still decides an answer of neither shape.
 *
 *   §01 PostgreSQL — controls (a SELECT, a write, a boolean write, an answer without `fields`)
 *                    and the arms (`WITH … SELECT`, `VALUES`, `INSERT … RETURNING` with and
 *                    without `@return {object}`, `SELECT … INTO`).
 *   §02 MySQL      — controls (a SELECT, a write, several result sets at once) and the arms
 *                    (`WITH … SELECT`, `SHOW`, `SELECT … INTO @v`).
 *
 * Harness: the real connectors against stub connections, as test/core/couchbase-boolean-b1177.test.js.
 * The stub answers follow the drivers' own result shapes (pg 8.23.1 `lib/result.js`: `command`,
 * `rowCount`, `rows`, `fields`; mysql2 3.23.3 `lib/commands/query.js`: an array of rows, or a
 * header when the server reports no columns). Every await is bounded, so a call that never
 * settles FAILS instead of hanging.
 */
'use strict';

// Before the connectors load: isCacheless / envIsDev are captured at module load.
process.env.NODE_ENV_IS_DEV = 'false';

var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var Module = require('module');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW   = path.resolve(require('../fw'));
var REPO = path.resolve(__dirname, '../..');

// ─── globals bootstrap (mirrors test/core/couchbase-boolean-b1177.test.js) ────
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
Module.Module._initPaths();
require(FW + '/helpers');
setPath('gina', { core: path.join(FW, 'core') });

var ginaMain  = require.resolve(REPO);
var _inherits = require(FW + '/lib/inherits/src/main.js');
var _merge    = require(FW + '/lib/merge/src/main.js');
var ModelUtil = require(FW + '/lib/model');
if (!require.cache[ginaMain] || !require.cache[ginaMain].exports.lib) {
    require.cache[ginaMain] = {
        id: ginaMain, filename: ginaMain, loaded: true,
        exports: { lib: { logger: console, helpers: {}, inherits: _inherits, merge: _merge, Model: ModelUtil } }
    };
}

// ─── throwaway project: one entity per connector, one .sql file per statement ───
// Each statement names its own table (t_p1, t_m1, …): the stub answers by that name.
var STMTS = {
    pg: {
        selectCtl          : { ret: 'array',   sql: 'SELECT a FROM t_p1 WHERE k = $1' },
        insertCtl          : { ret: null,      sql: 'INSERT INTO t_p2 (a) VALUES ($1)' },
        deleteBool         : { ret: 'boolean', sql: 'DELETE FROM t_p3 WHERE k = $1' },
        selectNoFields     : { ret: null,      sql: 'SELECT a FROM t_p4' },
        withSelect         : { ret: null,      sql: 'WITH x AS (SELECT a FROM t_p5) SELECT a FROM x' },
        valuesList         : { ret: null,      sql: "VALUES (1, 't_p6'), (2, 't_p6')" },
        insertReturningObj : { ret: 'object',  sql: 'INSERT INTO t_p7 (a) VALUES ($1) RETURNING *' },
        insertReturning    : { ret: null,      sql: 'INSERT INTO t_p8 (a) VALUES ($1) RETURNING *' },
        selectInto         : { ret: null,      sql: 'SELECT a INTO t_p9_copy FROM t_p9' }
    },
    my: {
        selectCtl     : { ret: 'array', sql: 'SELECT a FROM t_m1 WHERE k = ?' },
        updateCtl     : { ret: null,    sql: 'UPDATE t_m2 SET a = ? WHERE k = 1' },
        selectMulti   : { ret: null,    sql: 'SELECT a FROM t_m3' },
        withSelect    : { ret: null,    sql: 'WITH x AS (SELECT a FROM t_m4) SELECT a FROM x' },
        showTables    : { ret: null,    sql: "SHOW TABLES LIKE 't_m5'" },
        selectIntoVar : { ret: null,    sql: 'SELECT a INTO @v FROM t_m6 LIMIT 1' }
    }
};
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1172-'));
['pg', 'my'].forEach(function (k) {
    var db = k + 'db';
    fs.mkdirSync(path.join(TMP, 'bundle/models', db, 'entities'), { recursive: true });
    fs.mkdirSync(path.join(TMP, 'bundle/models', db, 'sql/thing'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'bundle/models', db, 'entities/thing.js'),
        'function Thing(conn) {}\nmodule.exports = Thing;\n');
    Object.keys(STMTS[k]).forEach(function (n) {
        var s = STMTS[k][n];
        fs.writeFileSync(path.join(TMP, 'bundle/models', db, 'sql/thing', n + '.sql'),
            '/**\n * ' + n + (/\$1|\?/.test(s.sql) ? '\n * @param {string} ' + (k === 'pg' ? '$1' : '?') + ' value' : '')
            + (s.ret ? '\n * @return {' + s.ret + '}' : '') + '\n */\n' + s.sql + '\n');
    });
});
setPath('project', TMP);
setPath('bundle',  path.join(TMP, 'bundle'));

// ─── stub answers, shaped as each driver answers ────────────────────────────────
var ROWS2 = [ { a: 1 }, { a: 2 } ];
var PG = {
    t_p1 : { command: 'SELECT', rowCount: 2, rows: ROWS2, fields: [ { name: 'a' } ] },
    t_p2 : { command: 'INSERT', rowCount: 1, rows: [], fields: [] },
    t_p3 : { command: 'DELETE', rowCount: 1, rows: [], fields: [] },
    t_p4 : { command: 'SELECT', rowCount: 1, rows: [ { a: 1 } ] }, // no fields array: the keyword decides
    t_p5 : { command: 'SELECT', rowCount: 2, rows: ROWS2, fields: [ { name: 'a' } ] },
    t_p6 : { command: 'SELECT', rowCount: 2, rows: [ { column1: 1, column2: 't_p6' }, { column1: 2, column2: 't_p6' } ], fields: [ { name: 'column1' }, { name: 'column2' } ] },
    t_p7 : { command: 'INSERT', rowCount: 1, rows: [ { id: 7, a: 'v' } ], fields: [ { name: 'id' }, { name: 'a' } ] },
    t_p8 : { command: 'INSERT', rowCount: 1, rows: [ { id: 8, a: 'v' } ], fields: [ { name: 'id' }, { name: 'a' } ] },
    t_p9 : { command: 'SELECT', rowCount: 3, rows: [], fields: [] }   // SELECT … INTO: a table written, no rows
};
function header(affectedRows) {
    return { fieldCount: 0, affectedRows: affectedRows, insertId: 0, info: '', serverStatus: 2, warningStatus: 0, changedRows: 0 };
}
var MY = {
    t_m1 : function () { return ROWS2.slice(); },
    t_m2 : function () { return header(1); },
    t_m3 : function () { return [ [ { a: 1 } ], header(0) ]; },     // several result sets at once
    t_m4 : function () { return ROWS2.slice(); },
    t_m5 : function () { return [ { 'Tables_in_db (t_m5)': 't_m5' } ]; },
    t_m6 : function () { return header(1); }
};
function pick(map, text) {
    var keys = Object.keys(map).sort(function (x, y) { return y.length - x.length; });
    for (var i = 0; i < keys.length; i++) { if (text.indexOf(keys[i]) > -1) { return keys[i]; } }
    return null;
}
var pgConn = { query: function (text, values, cb) {
    if (typeof values === 'function') { cb = values; values = []; }
    var key = pick(PG, text);
    setImmediate(function () {
        if (!key) { cb(new Error('harness: no stub answer for ' + text)); return; }
        cb(null, JSON.parse(JSON.stringify(PG[key])));
    });
} };
var myConn = { execute: function (text, args, cb) {
    var key = pick(MY, text);
    setImmediate(function () {
        if (!key) { cb(new Error('harness: no stub answer for ' + text)); return; }
        var res = MY[key]();
        cb(null, res, Array.isArray(res) && !Array.isArray(res[0]) ? [ { name: 'a' } ] : undefined);
    });
} };

/** @inner @param {number} [ms=10] @returns {Promise<void>} */
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 10); }); }

/**
 * Await without ever hanging: a call that never settles reads `{status:'timeout'}`.
 * @inner @param {Promise} p @param {number} [ms=1500]
 * @returns {Promise<{status:string, value?:*, error?:Error}>}
 */
function bounded(p, ms) {
    return Promise.race([
        Promise.resolve(p).then(
            function (v) { return { status: 'ok',  value: v }; },
            function (e) { return { status: 'err', error: e }; }
        ),
        tick(ms || 1500).then(function () { return { status: 'timeout' }; })
    ]);
}

var ent = {};

before(function () {
    require(FW + '/lib');
    var EntitySuper = require(path.join(FW, 'core/model/entity.js'));
    [ [ 'pg', require(path.join(FW, 'core/connectors/postgresql/index.js')), pgConn ],
      [ 'my', require(path.join(FW, 'core/connectors/mysql/index.js')),      myConn ] ].forEach(function (t) {
        var model    = t[0] + 'model';
        var entities = new t[1](t[2], { database: t[0] + 'db', model: model, bundle: 'bundle', scope: 'local' });
        var Cls      = entities.Thing;
        var mu       = new ModelUtil();
        mu.setConnection('bundle', model, t[2]);
        mu.setModelEntity('bundle', model, 'Thing', Cls);
        new Cls(t[2]);
        ent[t[0]] = EntitySuper[EntitySuper.key('bundle', model, 'Thing')].instance;
    });
});

after(function () {
    fs.rmSync(TMP, { recursive: true, force: true });
});

/**
 * Runs one statement and returns its settled value.
 * @inner @param {string} k connector key ('pg' or 'my') @param {string} n statement name
 * @returns {Promise<*>}
 */
async function run(k, n) {
    assert.equal(typeof ent[k][n], 'function', n + ' must be attached');
    var args = /\$1|\?/.test(STMTS[k][n].sql) ? [ 'v' ] : [];
    var r = await bounded(ent[k][n].apply(ent[k], args));
    assert.equal(r.status, 'ok', n + ' must resolve' + (r.error ? ': ' + r.error.message : ''));
    return r.value;
}

describe('01 - PostgreSQL: the answer decides the row branch', function () {

    it('control: a SELECT returns its rows', async function () {
        assert.deepEqual(await run('pg', 'selectCtl'), ROWS2);
    });

    it('control: a write without RETURNING returns { changes, command }', async function () {
        assert.deepEqual(await run('pg', 'insertCtl'), { changes: 1, command: 'INSERT' });
    });

    it('control: @return {boolean} on a write reads rowCount', async function () {
        assert.equal(await run('pg', 'deleteBool'), true);
    });

    it('control: an answer without a fields array keeps the leading keyword', async function () {
        assert.deepEqual(await run('pg', 'selectNoFields'), [ { a: 1 } ]);
    });

    it('a WITH … SELECT returns its rows', async function () {
        assert.deepEqual(await run('pg', 'withSelect'), ROWS2);
    });

    it('a VALUES list returns its rows', async function () {
        assert.deepEqual(await run('pg', 'valuesList'), [ { column1: 1, column2: 't_p6' }, { column1: 2, column2: 't_p6' } ]);
    });

    it('an INSERT … RETURNING under @return {object} returns the returned row', async function () {
        assert.deepEqual(await run('pg', 'insertReturningObj'), { id: 7, a: 'v' });
    });

    it('an INSERT … RETURNING without @return returns the returned rows', async function () {
        assert.deepEqual(await run('pg', 'insertReturning'), [ { id: 8, a: 'v' } ]);
    });

    it('a SELECT … INTO (no rows returned) is shaped as a write', async function () {
        assert.deepEqual(await run('pg', 'selectInto'), { changes: 3, command: 'SELECT' });
    });
});

describe('02 - MySQL: the answer decides the row branch', function () {

    it('control: a SELECT returns its rows', async function () {
        assert.deepEqual(await run('my', 'selectCtl'), ROWS2);
    });

    it('control: a write returns { changes, insertId }', async function () {
        assert.deepEqual(await run('my', 'updateCtl'), { changes: 1, insertId: 0 });
    });

    it('control: several result sets at once keep the leading keyword', async function () {
        assert.deepEqual(await run('my', 'selectMulti'), [ [ { a: 1 } ], header(0) ]);
    });

    it('a WITH … SELECT returns its rows', async function () {
        assert.deepEqual(await run('my', 'withSelect'), ROWS2);
    });

    it('a SHOW returns its rows', async function () {
        assert.deepEqual(await run('my', 'showTables'), [ { 'Tables_in_db (t_m5)': 't_m5' } ]);
    });

    it('a SELECT … INTO @v (no result set) is shaped as a write', async function () {
        assert.deepEqual(await run('my', 'selectIntoVar'), { changes: 1, insertId: 0 });
    });
});
