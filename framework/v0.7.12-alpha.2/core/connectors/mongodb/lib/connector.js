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

// #B432 — the ready handler is the model layer's boot continuation and must run
// exactly once: a handler that THROWS can no longer be re-invoked with a
// fabricated `Connection failed` by onReady's own error path (see
// core/connectors/settle-once.js).
var settleOnce   = require('./../../settle-once');

/**
 * MongoDB connector — creates a `mongodb` MongoClient.
 *
 * The `mongodb` driver is loaded from the project's node_modules so the
 * framework has zero hard dependency on it. Install it in your project:
 *   npm install mongodb
 *
 * connectors.json entry (URI form, preferred when available):
 * {
 *   "mydb": {
 *     "connector": "mongodb",
 *     "uri": "mongodb://user:pass@localhost:27017/mydb?authSource=admin",
 *     "database": "mydb"
 *   }
 * }
 *
 * connectors.json entry (decomposed fields, schema-parity with other
 * connectors):
 * {
 *   "mydb": {
 *     "connector": "mongodb",
 *     "host": "127.0.0.1",
 *     "port": 27017,
 *     "username": "admin",
 *     "password": "secret",
 *     "database": "mydb",
 *     "authSource": "admin",
 *     "replicaSet": "rs0"
 *   }
 * }
 *
 * `database` names both the logical model directory
 * (`models/<database>/entities/`) and the Mongo db name selected via
 * `client.db(database)`. When `uri` is present it takes precedence over
 * the decomposed fields, but `database` is still required and is used
 * to select the db on the client.
 *
 * @class MongodbConnector
 * @constructor
 * @param {object}        conf              - Connector config from connectors.json
 * @param {string}        conf.database     - DB name (also the model dir name)
 * @param {string}        [conf.uri]        - Full mongodb:// or mongodb+srv:// URI
 * @param {string}        [conf.host]       - Host (used when uri absent)
 * @param {number|string} [conf.port]       - Port (default 27017, used when uri absent)
 * @param {string}        [conf.username]   - Auth username (used when uri absent)
 * @param {string}        [conf.password]   - Auth password (used when uri absent)
 * @param {string}        [conf.authSource] - Authentication db (typically "admin")
 * @param {string}        [conf.replicaSet] - Replica set name
 * @param {object|boolean}[conf.ssl]        - TLS configuration; `true` enables defaults,
 *                                            an object is merged into client options.
 */
function MongodbConnector(conf) {
    var _client = null;
    var _db     = null;
    var _dbName = null;
    var _err    = null;

    var init = function(conf) {
        var mongodb;
        try {
            var driverPath = _(getPath('project') + '/node_modules/mongodb', true);
            mongodb = require(driverPath);
        } catch (e) {
            _err = new Error(
                '[MongodbConnector] mongodb is not installed in your project.\n'
                + 'Run: npm install mongodb\n'
                + e.message
            );
            return;
        }

        _dbName = conf.database;
        if (!_dbName) {
            _err = new Error('[MongodbConnector] missing required `database` field in connectors.json entry');
            return;
        }

        var uri;
        if (conf.uri) {
            uri = conf.uri;
        } else {
            var host = conf.host || '127.0.0.1';
            var port = conf.port || 27017;
            var auth = '';
            if (conf.username) {
                auth = encodeURIComponent(conf.username);
                if (conf.password) {
                    auth += ':' + encodeURIComponent(conf.password);
                }
                auth += '@';
            }
            uri = 'mongodb://' + auth + host + ':' + port + '/' + encodeURIComponent(_dbName);
            var qs = [];
            if (conf.authSource) qs.push('authSource=' + encodeURIComponent(conf.authSource));
            if (conf.replicaSet) qs.push('replicaSet=' + encodeURIComponent(conf.replicaSet));
            if (qs.length) uri += '?' + qs.join('&');
        }

        var clientOptions = {};
        if (conf.ssl === true) {
            clientOptions.tls = true;
        } else if (conf.ssl && typeof conf.ssl === 'object') {
            clientOptions.tls = true;
            for (var k in conf.ssl) {
                if (Object.prototype.hasOwnProperty.call(conf.ssl, k)) {
                    clientOptions[k] = conf.ssl[k];
                }
            }
        }

        try {
            _client = new mongodb.MongoClient(uri, clientOptions);
            _client._name = _dbName;
            console.debug('[MongodbConnector] client created for: ' + _dbName);
        } catch (e) {
            _err = new Error('[MongodbConnector] Failed to create client: ' + e.message);
        }
    };

    /**
     * Register a one-time ready callback. Async — calls `client.connect()`
     * which establishes the TCP connection and verifies authentication.
     *
     * The yielded `Db` is decorated with `_name` (db name) and `_client` (a
     * back-reference to the owning `MongoClient`), so entities — which are
     * handed the `Db` — can reach client-level APIs (sessions, transactions)
     * through the public `getClient()` accessor.
     *
     * @param {function} fn - `fn(err, conn)` where `conn` is the mongodb Db instance.
     */
    this.onReady = function(fn) {
        // #B432 — guard ONLY a function: an unconditional wrap would turn a
        // missing callback from a loud `fn is not a function` into a silent hang.
        if (typeof fn === 'function') fn = settleOnce('mongodb:connector#onReady', fn, console);
        if (_err) return fn(_err, null);

        _client.connect().then(function() {
            _db = _client.db(_dbName);
            _db._name = _dbName;
            _db._client = _client; // back-reference to the MongoClient (one level up from the Db) so entities can reach sessions/transactions via getClient()
            console.debug('[MongodbConnector] connected to: ' + _dbName);
            fn(null, _db);
        }).catch(function(err) {
            fn(new Error('[MongodbConnector] Connection failed: ' + err.message), null);
        });
    };

    init(conf);
}

MongodbConnector = inherits(MongodbConnector, EventEmitter);
module.exports   = MongodbConnector;
