'use strict';
/**
 * #B1173 — on a Bun whose bun:sqlite statements carry no `reader` (measured on Bun 1.2.21),
 * the Bun adapter in lib/sqlite-driver passed `undefined` through, so the SQLite connector
 * fell back to the leading keyword: a `WITH` clause feeding a write went to `all()` and an
 * `INSERT … RETURNING` to `run()`. Those statements do carry `columnNames`, which lists the
 * result columns exactly where node:sqlite's `columns()` does (measured: the nine statements
 * below). Fix: the adapter's `reader` is bun:sqlite's own boolean where the statement carries
 * one, else whether `columnNames` lists a column, else `undefined`.
 *
 * §01 drives the adapter (`makeAdapter`) with a fake bun:sqlite whose statements carry the
 * `columnNames` measured on Bun 1.2.21 and no `reader`; §02 pins the precedence and the
 * fallbacks. Red-first: GINA_B1173_DRIVER_SRC=<pre-fix driver> reds §01.1, §01.2 and §02.3;
 * §02.1 and §02.2 pass on both.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');

var FW = require('../fw');
var DRIVER_SRC = process.env.GINA_B1173_DRIVER_SRC || path.join(FW, 'lib', 'sqlite-driver.js');
var driver = require(DRIVER_SRC);

// Each statement's columnNames as Bun 1.2.21's bun:sqlite reports it (no `reader` on any of them),
// and whether it returns rows (node:sqlite's columns() splits them the same way)
var MEASURED = [
    [ 'SELECT 1',                                                ['1'],            true  ],
    [ 'WITH t2 AS (SELECT 1 AS a) SELECT a FROM t2',             ['a'],            true  ],
    [ 'VALUES (1)',                                              ['column1'],      true  ],
    [ 'PRAGMA user_version',                                     ['user_version'], true  ],
    [ 'INSERT INTO t VALUES (2) RETURNING *',                    ['a'],            true  ],
    [ 'PRAGMA user_version = 1',                                 [],               false ],
    [ 'INSERT INTO t VALUES (1)',                                [],               false ],
    [ 'WITH s AS (SELECT 1 AS a) INSERT INTO t SELECT a FROM s', [],               false ],
    [ 'CREATE TABLE u (a)',                                      [],               false ]
];

/**
 * A stand-in for bun:sqlite's module: each prepared statement carries what `shape(sql)` gives.
 *
 * @inner
 * @param {Function} shape - (sql) => the statement's extra properties (`reader`, `columnNames`)
 * @returns {object} the fake module
 */
function fakeBun(shape) {
    function Database() {}
    Database.prototype.prepare = function (sql) {
        var stmt = {
            get: function () { return null; },
            all: function () { return []; },
            run: function () { return { changes: 0, lastInsertRowid: 0 }; }
        };
        var extra = shape(sql);
        for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) stmt[k] = extra[k];
        }
        return stmt;
    };
    Database.prototype.exec  = function () {};
    Database.prototype.close = function () {};
    return { Database: Database };
}

/**
 * The adapter's `reader` for one statement of a fake bun:sqlite.
 *
 * @inner
 * @param {Function} shape - see fakeBun
 * @param {string} sql - the statement
 * @returns {*} the prepared statement's `reader`
 */
function readerOf(shape, sql) {
    var A = driver.makeAdapter(fakeBun(shape));
    return new A(':memory:').prepare(sql).reader;
}

/** The Bun 1.2.21 shape of a measured statement: its columnNames, no reader. */
function measured(sql) {
    for (var i = 0; i < MEASURED.length; i++) {
        if (MEASURED[i][0] === sql) return { columnNames: MEASURED[i][1] };
    }
    throw new Error('not a measured statement: ' + sql);
}


// ---------------------------------------------------------------------------
describe('sqlite-driver-reader-b1173 §01 — a Bun without reader: columnNames decides', function () {

    it('01.1  the five row-returning statements read true', function () {
        MEASURED.filter(function (r) { return r[2]; }).forEach(function (r) {
            assert.equal(readerOf(measured, r[0]), true, r[0]);
        });
    });

    it('01.2  the four writes read false', function () {
        MEASURED.filter(function (r) { return !r[2]; }).forEach(function (r) {
            assert.equal(readerOf(measured, r[0]), false, r[0]);
        });
    });
});


// ---------------------------------------------------------------------------
describe('sqlite-driver-reader-b1173 §02 — precedence and fallbacks', function () {

    it('02.1  a boolean reader wins over columnNames', function () {
        assert.equal(readerOf(function () { return { reader: false, columnNames: ['a'] }; }, 'X'), false);
        assert.equal(readerOf(function () { return { reader: true,  columnNames: [] }; }, 'X'), true);
    });

    it('02.2  neither reader nor columnNames: undefined (the leading keyword then decides)', function () {
        assert.equal(typeof readerOf(function () { return {}; }, 'VALUES (1)'), 'undefined');
    });

    it('02.3  a reader that is not a boolean, or a columnNames that is not an array, does not decide', function () {
        assert.equal(typeof readerOf(function () { return { columnNames: 'a' }; }, 'X'), 'undefined');
        assert.equal(typeof readerOf(function () { return { reader: 'yes' }; }, 'X'), 'undefined');
        assert.equal(readerOf(function () { return { reader: 1, columnNames: [] }; }, 'X'), false);
    });
});
