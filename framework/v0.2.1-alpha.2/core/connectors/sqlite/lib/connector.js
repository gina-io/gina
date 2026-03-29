/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var EventEmitter    = require('events').EventEmitter;
var gina            = require('../../../../core/gna');
var lib             = gina.lib;
var console         = lib.logger;
var inherits        = lib.inherits;

/**
 * SQLite connector — opens a DatabaseSync connection.
 * Backed by `node:sqlite` (Node.js built-in, available since Node 22.5.0 — zero npm deps).
 * `onReady()` fires synchronously because there is no async network handshake.
 *
 * connectors.json entry:
 * {
 *   "mydb": {
 *     "connector": "sqlite",
 *     "database": "mydb",
 *     "file": "/optional/absolute/path/to/mydb.sqlite"
 *   }
 * }
 *
 * `database` names the logical model directory (`models/<database>/entities/`).
 * `file` is the actual SQLite file path. Defaults to `~/.gina/{version}/{database}.sqlite`
 * when absent. Use `':memory:'` for an ephemeral in-process database (tests).
 *
 * @class SqliteConnector
 * @constructor
 * @param {object} conf            - Connector config from connectors.json
 * @param {string} conf.database   - Logical database name (models/ directory)
 * @param {string} [conf.file]     - SQLite file path (defaults to ~/.gina/{v}/{database}.sqlite)
 */
function SqliteConnector(conf) {
    var self = this;
    var _conn = null;
    var _err  = null;

    var init = function(conf) {
        var DatabaseSync;
        try {
            DatabaseSync = require('node:sqlite').DatabaseSync;
        } catch (e) {
            _err = new Error(
                '[SqliteConnector] node:sqlite requires Node.js >= 22.5.0. '
                + 'Current: ' + process.version + '\n'
                + e.message
            );
            return;
        }

        // Resolve file path: conf.file > ~/.gina/{version}/{database}.sqlite
        var dbFile = conf.file || _(getPath('gina').home + '/' + conf.database + '.sqlite', true);

        try {
            _conn = new DatabaseSync(dbFile);
            // WAL mode: concurrent readers never block the writer.
            _conn.exec('PRAGMA journal_mode=WAL');
            // synchronous=NORMAL: safe with WAL — never corrupts the DB on crash.
            _conn.exec('PRAGMA synchronous=NORMAL');
            // Enforce FK constraints at the connection level.
            _conn.exec('PRAGMA foreign_keys=ON');
            // Expose metadata on the connection object for use by index.js.
            _conn._file = dbFile;
            _conn._name = conf.database;
            console.debug('[SqliteConnector] opened: ' + dbFile);
        } catch (e) {
            _err = new Error('[SqliteConnector] Failed to open "' + dbFile + '": ' + e.message);
        }
    };

    /**
     * Register a one-time ready callback.
     * Fires synchronously — node:sqlite has no async handshake.
     *
     * @param {function} fn - `fn(err, conn)` where `conn` is the DatabaseSync instance.
     */
    this.onReady = function(fn) {
        if (_err) {
            fn(_err, null);
        } else {
            fn(null, _conn);
        }
    };

    init(conf);
}

SqliteConnector = inherits(SqliteConnector, EventEmitter);
module.exports = SqliteConnector;
