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
 * ScyllaDB / Cassandra connector — creates a cassandra-driver Client.
 *
 * `cassandra-driver` is loaded from the **project's** node_modules so the
 * framework has zero hard dependency on it. Install it in your project:
 *   npm install cassandra-driver
 *
 * The driver works against ScyllaDB and any Cassandra-compatible cluster
 * (the wire protocol is shared). Shard-aware routing is not available on
 * Node.js — only the Python / Java / Go / Rust drivers offer it. The
 * `cassandra-driver` package transparently uses token-aware routing,
 * which is sufficient for most workloads.
 *
 * connectors.json entry:
 * {
 *   "mydb": {
 *     "connector": "scylladb",
 *     "contactPoints": ["127.0.0.1:9042"],
 *     "localDataCenter": "datacenter1",
 *     "keyspace": "mykeyspace",
 *     "credentials": { "username": "cassandra", "password": "secret" }
 *   }
 * }
 *
 * `keyspace` names both the logical model directory (`models/<keyspace>/entities/`)
 * and the CQL keyspace to connect to.
 * `contactPoints` accepts either an array of `host:port` strings or a single
 * `host` + `port` pair (legacy schema parity). Default port is 9042.
 *
 * @class ScylladbConnector
 * @constructor
 * @param {object} conf                       - Connector config from connectors.json
 * @param {string} conf.keyspace              - CQL keyspace name (also used as model dir)
 * @param {string[]|string} [conf.contactPoints] - Array of `host:port` strings, or a single host
 * @param {string} [conf.host]                - Single host (legacy alias when contactPoints is absent)
 * @param {number|string} [conf.port]         - Single port (default: 9042)
 * @param {string} [conf.localDataCenter]     - Data center name (required by cassandra-driver 4.x)
 * @param {object} [conf.credentials]         - { username, password }
 * @param {string} [conf.username]            - Authentication username (legacy alias)
 * @param {string} [conf.password]            - Authentication password (legacy alias)
 * @param {object} [conf.ssl]                 - SSL options passed directly to cassandra-driver as sslOptions
 */
function ScylladbConnector(conf) {
    var _conn = null;
    var _err  = null;

    var init = function(conf) {
        var cassandra;
        try {
            var driverPath = _(getPath('project') + '/node_modules/cassandra-driver', true);
            cassandra = require(driverPath);
        } catch (e) {
            _err = new Error(
                '[ScylladbConnector] cassandra-driver is not installed in your project.\n'
                + 'Run: npm install cassandra-driver\n'
                + e.message
            );
            return;
        }

        var contactPoints = [];
        if ( Array.isArray(conf.contactPoints) ) {
            contactPoints = conf.contactPoints.slice();
        } else if ( typeof(conf.contactPoints) == 'string' ) {
            contactPoints = conf.contactPoints.split(/\s*,\s*/);
        } else if ( conf.host ) {
            contactPoints = [ conf.host + ':' + (conf.port || 9042) ];
        } else {
            contactPoints = [ '127.0.0.1:9042' ];
        }

        var credentials = null;
        if ( conf.credentials && conf.credentials.username ) {
            credentials = conf.credentials;
        } else if ( conf.username ) {
            credentials = { username: conf.username, password: conf.password || '' };
        }

        var clientConf = {
            contactPoints  : contactPoints,
            localDataCenter: conf.localDataCenter || 'datacenter1',
            keyspace       : conf.keyspace || conf.database
        };
        if (credentials) {
            clientConf.authProvider = new cassandra.auth.PlainTextAuthProvider(
                credentials.username, credentials.password || ''
            );
        }
        if (conf.ssl) {
            clientConf.sslOptions = conf.ssl;
        }

        try {
            _conn = new cassandra.Client(clientConf);
            _conn._name = conf.keyspace || conf.database;
            console.debug('[ScylladbConnector] client created for: ' + (conf.keyspace || conf.database));

            _conn.on('log', function(level, className, message) {
                if (level === 'error') {
                    console.error('[ScylladbConnector] ' + className + ': ' + message);
                }
            });
        } catch (e) {
            _err = new Error('[ScylladbConnector] Failed to create client: ' + e.message);
        }
    };

    /**
     * Register a one-time ready callback. Async — calls `client.connect()`
     * which both verifies cluster connectivity and prepares the topology
     * metadata cache.
     *
     * @param {function} fn - `fn(err, conn)` where `conn` is the cassandra Client.
     */
    this.onReady = function(fn) {
        // #B432 — guard ONLY a function: an unconditional wrap would turn a
        // missing callback from a loud `fn is not a function` into a silent hang.
        if (typeof fn === 'function') fn = settleOnce('scylladb:connector#onReady', fn, console);
        if (_err) return fn(_err, null);

        _conn.connect().then(function() {
            console.debug('[ScylladbConnector] connected to: ' + _conn._name);
            fn(null, _conn);
        }).catch(function(err) {
            fn(new Error('[ScylladbConnector] Connection failed: ' + err.message), null);
        });
    };

    init(conf);
}

ScylladbConnector = inherits(ScylladbConnector, EventEmitter);
module.exports    = ScylladbConnector;
