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
 * PostgreSQL connector — creates a pg connection pool.
 *
 * `pg` is loaded from the **project's** node_modules so the framework
 * has zero hard dependency on it. Install it in your project:
 *   npm install pg
 *
 * connectors.json entry:
 * {
 *   "mydb": {
 *     "connector": "postgresql",
 *     "host": "127.0.0.1",
 *     "port": 5432,
 *     "database": "mydb",
 *     "username": "postgres",
 *     "password": "secret",
 *     "connectionLimit": 10
 *   }
 * }
 *
 * `database` names both the logical model directory (`models/<database>/entities/`)
 * and the PostgreSQL database to connect to.
 * `connectionLimit` maps to `pg.Pool` `max` (default: 10).
 * `idleTimeout` maps to `idleTimeoutMillis` (default: 30000 ms).
 * `connectionTimeout` maps to `connectionTimeoutMillis` (default: 2000 ms).
 * `ssl` is passed through to pg as-is when present.
 *
 * @class PostgresqlConnector
 * @constructor
 * @param {object}  conf                       - Connector config from connectors.json
 * @param {string}  conf.database              - PostgreSQL database name
 * @param {string}  [conf.host]                - PostgreSQL host (default: 127.0.0.1)
 * @param {number}  [conf.port]                - PostgreSQL port (default: 5432)
 * @param {string}  [conf.username]            - PostgreSQL user
 * @param {string}  [conf.password]            - PostgreSQL password
 * @param {number}  [conf.connectionLimit]     - Max pool size (default: 10)
 * @param {number}  [conf.idleTimeout]         - Idle connection timeout ms (default: 30000)
 * @param {number}  [conf.connectionTimeout]   - Connection acquire timeout ms (default: 2000)
 * @param {object}  [conf.ssl]                 - SSL options passed directly to pg
 */
function PostgresqlConnector(conf) {
    var _conn = null;
    var _err  = null;

    var init = function(conf) {
        var pg;
        try {
            var pgPath = _(getPath('project') + '/node_modules/pg', true);
            pg = require(pgPath);
        } catch (e) {
            _err = new Error(
                '[PostgresqlConnector] pg is not installed in your project.\n'
                + 'Run: npm install pg\n'
                + e.message
            );
            return;
        }

        var poolConf = {
            host                   : conf.host     || '127.0.0.1',
            port                   : conf.port     || 5432,
            user                   : conf.username,
            password               : conf.password || '',
            database               : conf.database,
            max                    : conf.connectionLimit   || 10,
            idleTimeoutMillis      : conf.idleTimeout       || 30000,
            connectionTimeoutMillis : conf.connectionTimeout || 2000
        };
        if (conf.ssl) poolConf.ssl = conf.ssl;

        try {
            _conn = new pg.Pool(poolConf);
            _conn._name = conf.database;
            console.debug('[PostgresqlConnector] pool created for: ' + conf.database);

            // Surface uncaught pool errors — prevents unhandled 'error' EventEmitter crash.
            _conn.on('error', function(err) {
                console.error('[PostgresqlConnector] idle client error: ' + err.message);
            });
        } catch (e) {
            _err = new Error('[PostgresqlConnector] Failed to create pool: ' + e.message);
        }
    };

    /**
     * Register a one-time ready callback. Async — verifies pool connectivity
     * with a SELECT 1 ping before calling back.
     *
     * @param {function} fn - `fn(err, conn)` where `conn` is the pg Pool.
     */
    this.onReady = function(fn) {
        if (_err) return fn(_err, null);

        _conn.query('SELECT 1', function(err) {
            if (err) {
                fn(new Error('[PostgresqlConnector] Connection failed: ' + err.message), null);
                return;
            }
            console.debug('[PostgresqlConnector] connected to: ' + _conn._name);
            fn(null, _conn);
        });
    };

    init(conf);
}

PostgresqlConnector = inherits(PostgresqlConnector, EventEmitter);
module.exports      = PostgresqlConnector;
