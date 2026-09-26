/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var EventEmitter = require('events').EventEmitter;
var gina         = require('../../../../core/gna');
var lib          = gina.lib;
var console      = lib.logger;
var inherits     = lib.inherits;

/**
 * DuckDB connector — opens an embedded analytical (columnar / OLAP) database.
 *
 * `@duckdb/node-api` is loaded from the **project's** node_modules so the
 * framework has zero hard dependency on it. Install it in your project:
 *   npm install @duckdb/node-api
 *
 * connectors.json entry:
 * {
 *   "analytics": {
 *     "connector": "duckdb",
 *     "database": "analytics",
 *     "file": "/optional/absolute/path/to/analytics.duckdb"
 *   }
 * }
 *
 * `database` names the logical model directory (`models/<database>/entities/`).
 * `file` is the actual DuckDB file path. Defaults to `~/.gina/{database}.duckdb`
 * when absent. Use `':memory:'` for an ephemeral in-process database.
 * `readOnly` opens the database in read-only mode (driver `access_mode: 'READ_ONLY'`) —
 * writes are refused by the engine, and any number of read-only PROCESSES can share
 * one file. DuckDB is single-writer across processes: while one process holds a file
 * read-write, no other process can open it at all (not even read-only). Within one
 * process, re-opening the same file is fine (merged-process bundles share cleanly).
 *
 * Unlike the SQLite connector (synchronous `node:sqlite`), the DuckDB driver is
 * natively async — `onReady()` resolves after the instance + connection handshake.
 *
 * @class DuckdbConnector
 * @constructor
 * @param {object}  conf             - Connector config from connectors.json
 * @param {string}  conf.database    - Logical database name (models/ directory)
 * @param {string}  [conf.file]      - DuckDB file path (defaults to ~/.gina/{database}.duckdb; ':memory:' supported)
 * @param {boolean} [conf.readOnly]  - Open read-only (access_mode READ_ONLY; default false)
 */
function DuckdbConnector(conf) {
    var _conn        = null;
    var _err         = null;
    var _initPromise = null;

    var init = function(conf) {
        var duckdb;
        try {
            var duckdbPath = _(getPath('project') + '/node_modules/@duckdb/node-api', true);
            duckdb = require(duckdbPath);
        } catch (e) {
            _err = new Error(
                '[DuckdbConnector] @duckdb/node-api is not installed in your project.\n'
                + 'Run: npm install @duckdb/node-api\n'
                + e.message
            );
            return;
        }

        // Resolve file path: conf.file > ~/.gina/{database}.duckdb
        // ':memory:' passes through to the driver verbatim.
        var dbFile = conf.file || _(getPath('gina').home + '/' + conf.database + '.duckdb', true);

        // `create(path)` and `create(path, config)` are both valid driver forms;
        // only pass a config object when an option is actually set.
        var pending = (conf.readOnly)
            ? duckdb.DuckDBInstance.create(dbFile, { access_mode: 'READ_ONLY' })
            : duckdb.DuckDBInstance.create(dbFile);

        _initPromise = pending
            .then(function(instance) {
                return instance.connect();
            })
            .then(function(connection) {
                _conn = connection;
                // Expose metadata on the connection object for use by index.js.
                _conn._file = dbFile;
                _conn._name = conf.database;
                console.debug('[DuckdbConnector] opened: ' + dbFile);
            })
            .catch(function(e) {
                _err = new Error('[DuckdbConnector] Failed to open "' + dbFile + '": ' + e.message);
            });
    };

    /**
     * Register a one-time ready callback. Async — resolves once the DuckDB
     * instance + connection handshake completes. No ping query is needed:
     * the database is embedded, so a successful open IS the connectivity proof
     * (SQLite precedent).
     *
     * @param {function} fn - `fn(err, conn)` where `conn` is the DuckDBConnection.
     *
     * @example
     * var connector = new DuckdbConnector({ database: 'analytics' });
     * connector.onReady(function(err, conn) {
     *     if (err) return console.error(err.message);
     *     // conn is ready — conn._name === 'analytics'
     * });
     */
    this.onReady = function(fn) {
        if (_err) return fn(_err, null);

        _initPromise.then(function() {
            if (_err) return fn(_err, null);
            console.debug('[DuckdbConnector] connected to: ' + _conn._name);
            fn(null, _conn);
        });
    };

    init(conf);
}

DuckdbConnector = inherits(DuckdbConnector, EventEmitter);
module.exports  = DuckdbConnector;
