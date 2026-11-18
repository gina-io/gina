/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var EventEmitter = require('events').EventEmitter;
var util         = require('util');

/**
 * Redis connector — no-op boot-scan satisfier (v1: no entity/ORM wiring).
 *
 * The model layer (`lib/model.js` -> `core/model/index.js`) loads
 * `core/connectors/<type>/lib/connector.js` for EVERY `connectors.json` entry
 * at bundle boot and treats a missing file as fatal (`model#ready` fires with
 * an Error and the boot exits). Before this file existed, ANY redis entry —
 * including the documented session-store configuration and a job-store entry —
 * aborted the boot at that scan.
 *
 * This connector therefore exists to let a redis entry pass the scan; it
 * deliberately:
 *   - opens NO connection (the redis session store and job store each build
 *     and own their own client — nothing at boot needs one);
 *   - requires NO driver (the entry must boot even before the driver package
 *     is installed; the stores resolve the driver themselves at their own
 *     construction time, with an actionable error);
 *   - reports ready synchronously with a `null` connection (the sqlite
 *     connector's sync-`onReady` precedent — there is no handshake to wait on).
 *
 * Entity/ORM support remains unimplemented for redis: `getModel()` on a redis
 * entry yields only the bare `{ _connection: null, getConnection }` shell the
 * model layer builds — by design, until a redis ORM lands.
 *
 * @class RedisConnector
 * @constructor
 * @param {object} conf - Connector config from connectors.json (kept for
 *                        API parity with real connectors; nothing is read).
 */
function RedisConnector(conf) {
    EventEmitter.call(this);

    /**
     * The connectors.json entry, exposed for introspection/debugging only.
     * @type {object}
     */
    this.conf = conf || {};

    /**
     * Register a one-time ready callback.
     * Fires synchronously (sqlite precedent) with a `null` connection —
     * nothing is dialled at boot; the session/job stores own their clients.
     *
     * @param {function} fn - `fn(err, conn)`; always called as `fn(null, null)`.
     * @returns {void}
     */
    this.onReady = function(fn) {
        fn(null, null);
    };
}

util.inherits(RedisConnector, EventEmitter);

module.exports = RedisConnector;
