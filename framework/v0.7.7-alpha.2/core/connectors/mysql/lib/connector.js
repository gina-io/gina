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
 * MySQL connector — creates a mysql2 connection pool.
 *
 * `mysql2` is loaded from the **project's** node_modules so the framework
 * has zero hard dependency on it. Install it in your project:
 *   npm install mysql2
 *
 * connectors.json entry:
 * {
 *   "mydb": {
 *     "connector": "mysql",
 *     "host": "127.0.0.1",
 *     "port": 3306,
 *     "database": "mydb",
 *     "username": "root",
 *     "password": "secret",
 *     "connectionLimit": 10
 *   }
 * }
 *
 * `database` names both the logical model directory (`models/<database>/entities/`)
 * and the MySQL database to connect to.
 * `connectionLimit` defaults to 10 when absent.
 * `ssl` is passed through to mysql2 as-is when present.
 *
 * @class MysqlConnector
 * @constructor
 * @param {object}  conf                    - Connector config from connectors.json
 * @param {string}  conf.database           - MySQL database name
 * @param {string}  [conf.host]             - MySQL host (default: 127.0.0.1)
 * @param {number}  [conf.port]             - MySQL port (default: 3306)
 * @param {string}  [conf.username]         - MySQL user
 * @param {string}  [conf.password]         - MySQL password
 * @param {number}  [conf.connectionLimit]  - Pool connection limit (default: 10)
 * @param {object}  [conf.ssl]              - SSL options passed directly to mysql2
 */
function MysqlConnector(conf) {
    var _conn = null;
    var _err  = null;

    var init = function(conf) {
        var mysql;
        try {
            var mysql2Path = _(getPath('project') + '/node_modules/mysql2', true);
            mysql = require(mysql2Path);
        } catch (e) {
            _err = new Error(
                '[MysqlConnector] mysql2 is not installed in your project.\n'
                + 'Run: npm install mysql2\n'
                + e.message
            );
            return;
        }

        var poolConf = {
            host              : conf.host     || '127.0.0.1',
            port              : conf.port     || 3306,
            user              : conf.username,
            password          : conf.password || '',
            database          : conf.database,
            connectionLimit   : conf.connectionLimit || 10,
            waitForConnections : true,
            queueLimit        : 0
        };
        if (conf.ssl) poolConf.ssl = conf.ssl;

        try {
            _conn = mysql.createPool(poolConf);
            _conn._name = conf.database;
            console.debug('[MysqlConnector] pool created for: ' + conf.database);
        } catch (e) {
            _err = new Error('[MysqlConnector] Failed to create pool: ' + e.message);
        }
    };

    /**
     * Register a one-time ready callback. Async — verifies pool connectivity
     * with a single `getConnection` ping before calling back.
     *
     * @param {function} fn - `fn(err, conn)` where `conn` is the mysql2 Pool.
     */
    this.onReady = function(fn) {
        if (_err) return fn(_err, null);

        _conn.getConnection(function(err, connection) {
            if (err) {
                fn(new Error('[MysqlConnector] Connection failed: ' + err.message), null);
                return;
            }
            connection.release();
            console.debug('[MysqlConnector] connected to: ' + _conn._name);
            fn(null, _conn);
        });
    };

    init(conf);
}

MysqlConnector = inherits(MysqlConnector, EventEmitter);
module.exports  = MysqlConnector;
