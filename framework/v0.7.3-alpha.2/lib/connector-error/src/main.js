'use strict';

/**
 * #CE1 — Connector error classification.
 *
 * A datastore query error surfaces to a controller as the raw vendor Error with
 * no signal to distinguish a TRANSIENT failure (a datastore timeout, a dropped
 * connection, a node warming up after a restart / rebalance / failover — a
 * condition that clears itself in seconds) from a PERMANENT one (a bad query, a
 * constraint violation, a missing document). Without that signal an application
 * renders a generic 500 for a self-healing condition, and the user concludes
 * their data is broken.
 *
 * This module normalizes the discriminating signals every driver already
 * carries — socket-level errno, driver-specific error codes and class names,
 * ANSI SQLSTATE classes, MongoDB error labels, Couchbase N1QL cause codes — into
 * two fields stamped on the error object that already flows to the controller:
 *
 *   err.isTransient      {boolean}      true when a retry after backoff can succeed
 *   err.transientReason  {string|null}  a normalized token naming the condition
 *                                       (e.g. 'socket:econnrefused',
 *                                       'postgres:serialization-failure') — null
 *                                       when the error is permanent
 *
 * A controller can then branch on `err.isTransient` to render an honest
 * "temporarily unavailable, please retry" (a 503 + Retry-After) instead of a
 * hard 500, WITHOUT string-matching vendor error text (brittle, drifts across
 * driver versions). The classification is additive — it sets only the two fields
 * above, never mutates existing ones — and TOTAL: it never throws (an
 * unrecognized shape classifies as permanent), so stamping on the error path can
 * never itself break the request.
 *
 * @module lib/connector-error
 */

/**
 * Socket-level errno strings that indicate a TRANSIENT network condition.
 * `ENOTFOUND` is deliberately EXCLUDED — a DNS resolution failure is a
 * configuration error, not a self-healing blip. `EAI_AGAIN` (a *temporary* DNS
 * failure) IS included, being retryable by definition.
 *
 * @constant {Object.<string,string>}
 */
var TRANSIENT_SOCKET = {
    ECONNREFUSED : 'socket:econnrefused',
    ECONNRESET   : 'socket:econnreset',
    ETIMEDOUT    : 'socket:etimedout',
    EPIPE        : 'socket:epipe',
    EHOSTUNREACH : 'socket:ehostunreach',
    ENETUNREACH  : 'socket:enetunreach',
    ENETDOWN     : 'socket:enetdown',
    EAI_AGAIN    : 'socket:eai_again'
};

/**
 * String driver error codes that are transient (MySQL / MariaDB, SQLite).
 * PostgreSQL SQLSTATE is handled separately (5-char classes).
 *
 * @constant {Object.<string,string>}
 */
var TRANSIENT_DRIVER_CODE = {
    // mysql / mariadb (node `mysql` / `mysql2`)
    PROTOCOL_CONNECTION_LOST     : 'mysql:connection-lost',
    PROTOCOL_SEQUENCE_TIMEOUT    : 'mysql:sequence-timeout',
    ER_LOCK_DEADLOCK             : 'mysql:deadlock',
    ER_LOCK_WAIT_TIMEOUT         : 'mysql:lock-wait-timeout',
    ER_CON_COUNT_ERROR           : 'mysql:too-many-connections',
    ER_TOO_MANY_USER_CONNECTIONS : 'mysql:too-many-connections',
    // sqlite (node:sqlite / better-sqlite3)
    SQLITE_BUSY                  : 'sqlite:busy',
    SQLITE_LOCKED                : 'sqlite:locked',
    SQLITE_PROTOCOL              : 'sqlite:protocol'
};

/**
 * Driver error CLASS names (matched on `err.name`): cassandra-driver / ScyllaDB,
 * Couchbase SDK v4, MongoDB network errors.
 *
 * @constant {Object.<string,string>}
 */
var TRANSIENT_NAME = {
    // cassandra-driver (scylladb)
    NoHostAvailableError     : 'cassandra:no-host-available',
    OperationTimedOutError   : 'cassandra:operation-timed-out',
    // couchbase SDK v4
    TimeoutError             : 'couchbase:timeout',
    UnambiguousTimeoutError  : 'couchbase:timeout',
    AmbiguousTimeoutError    : 'couchbase:timeout',
    RequestCanceledError     : 'couchbase:request-canceled',
    ServiceNotAvailableError : 'couchbase:service-unavailable',
    // mongodb
    MongoNetworkError        : 'mongo:network',
    MongoNetworkTimeoutError : 'mongo:network-timeout',
    MongoServerSelectionError: 'mongo:server-selection'
};

/**
 * MongoDB numeric server error codes that are transient.
 *
 * @constant {Object.<number,string>}
 */
var TRANSIENT_MONGO_CODE = {
    // NOTE: code 7 (HostNotFound) is deliberately ABSENT — it is the server-side
    // sibling of ENOTFOUND (a name that does not resolve), which this module
    // classifies as a configuration error, not a blip. Code 6 (HostUnreachable)
    // stays: it is the network-level condition, consistent with EHOSTUNREACH.
    6     : 'mongo:host-unreachable',
    89    : 'mongo:network-timeout',
    91    : 'mongo:shutdown-in-progress',
    133   : 'mongo:failed-to-satisfy-read-preference',
    189   : 'mongo:primary-stepped-down',
    262   : 'mongo:exceeded-time-limit',
    9001  : 'mongo:socket-exception',
    10107 : 'mongo:not-writable-primary',
    11600 : 'mongo:interrupted-at-shutdown',
    11602 : 'mongo:interrupted-repl-state-change',
    13435 : 'mongo:not-primary-no-secondary-ok',
    13436 : 'mongo:not-primary-or-secondary'
};

/**
 * PostgreSQL SQLSTATE (5-char) codes that are transient. Class `08` (connection
 * exception) is transient as a whole and matched by prefix; the rest are exact.
 *
 * @constant {Object.<string,string>}
 */
var TRANSIENT_PG_SQLSTATE = {
    '40001' : 'postgres:serialization-failure',
    '40P01' : 'postgres:deadlock',
    '53300' : 'postgres:too-many-connections',
    '57P01' : 'postgres:admin-shutdown',
    '57P02' : 'postgres:crash-shutdown',
    '57P03' : 'postgres:cannot-connect-now'
};

/**
 * Couchbase N1QL `cause.first_error_code` values that are transient.
 *
 * @constant {Object.<number,string>}
 */
var TRANSIENT_N1QL_CODE = {
    // NOTE: 12009 (generic DML error) is deliberately ABSENT — it also covers
    // duplicate-key inserts, which are PERMANENT everywhere else in this module.
    // The server's own `cause.retry === true` flag (checked separately) is the
    // honest signal for a retryable DML failure such as a CAS mismatch.
    //
    // These CODE entries are load-bearing on the connector path even where the
    // SDK types the error: whenever the N1QL `cause` envelope carries server
    // TEXT, the couchbase connector's #B153 handlers forward that failure as a
    // synthesized `new Error(first_error_message)` carrying only `cause` —
    // `err.name` is 'Error' there, so TRANSIENT_NAME cannot fire and this table
    // is the sole classifier. (Only where there IS text: since the #B153
    // residual fix an EMPTY envelope message is raw-forwarded instead, so a
    // typed client-side timeout keeps its class name and the name rule catches
    // it first — that is the whole point of the residual fix.) On the raw SDK shape a
    // server-side 1080 arrives typed (SDK 4.x `document_query.cxx` maps 1080 ->
    // unambiguous_timeout -> UnambiguousTimeoutError) and the name rule catches
    // it first — the 1080 entry is the belt for the envelope shape. 12008 has NO
    // typed class of its own: the SDK buckets every un-cased 12xxx code
    // (permanent 12003 keyspace-not-found included) into one IndexFailureError
    // grab-bag, so the cause CODE is the only discriminating signal on BOTH
    // shapes — which is why IndexFailureError must never join TRANSIENT_NAME.
    // 12008 marks the query engine's KV bulk-get giving up after its internal
    // retries — measured transient in a real cluster warmup (retry after
    // backoff succeeded), and a READ, so classifying it transient carries no
    // 12009-style conflict hazard.
    1080  : 'couchbase:timeout',                    // N1QL request timeout
    12008 : 'couchbase:bulk-get-retry-exhausted'    // KV bulk-get retries exhausted
};

/**
 * Classifies a datastore error as transient (retryable) or permanent. Pure and
 * total — never throws; an unrecognized shape returns permanent.
 *
 * @param {*} err - the raw vendor/driver error (or anything)
 * @returns {{isTransient: boolean, reason: (string|null)}}
 *
 * @example
 * classify({ code: 'ECONNREFUSED' });   // { isTransient: true,  reason: 'socket:econnrefused' }
 * classify({ code: '40001' });          // { isTransient: true,  reason: 'postgres:serialization-failure' }
 * classify({ code: 'ER_DUP_ENTRY' });   // { isTransient: false, reason: null }
 * classify(null);                       // { isTransient: false, reason: null }
 */
function classify(err) {
    try {
        if (!err || typeof err !== 'object') {
            return { isTransient: false, reason: null };
        }

        var code = err.code;
        var name = err.name;

        // 1. socket-level errno (string) — err.code is canonical; some drivers
        //    surface the errno only on err.errno as a string.
        if (typeof code === 'string' && TRANSIENT_SOCKET[code]) {
            return { isTransient: true, reason: TRANSIENT_SOCKET[code] };
        }
        if (typeof err.errno === 'string' && TRANSIENT_SOCKET[err.errno]) {
            return { isTransient: true, reason: TRANSIENT_SOCKET[err.errno] };
        }

        // 2. string driver codes (mysql / sqlite-as-string)
        if (typeof code === 'string' && TRANSIENT_DRIVER_CODE[code]) {
            return { isTransient: true, reason: TRANSIENT_DRIVER_CODE[code] };
        }

        // 2b. node:sqlite numeric errcode (MEASURED shape: a busy error carries
        //     code 'ERR_SQLITE_ERROR' + errcode 5, never code 'SQLITE_BUSY').
        //     Match on the PRIMARY result code (low byte) so extended codes work
        //     too — e.g. 261 SQLITE_BUSY_RECOVERY -> 5. A constraint violation
        //     (errcode 1555 -> primary 19) stays permanent.
        if (typeof err.errcode === 'number') {
            var sqlitePrimary = err.errcode & 0xff;
            if (sqlitePrimary === 5) {
                return { isTransient: true, reason: 'sqlite:busy' };
            }
            if (sqlitePrimary === 6) {
                return { isTransient: true, reason: 'sqlite:locked' };
            }
        }

        // 3. postgres SQLSTATE — exact codes, plus the whole '08' connection class
        if (typeof code === 'string' && code.length === 5) {
            if (TRANSIENT_PG_SQLSTATE[code]) {
                return { isTransient: true, reason: TRANSIENT_PG_SQLSTATE[code] };
            }
            if (code.charAt(0) === '0' && code.charAt(1) === '8') {
                return { isTransient: true, reason: 'postgres:connection-exception' };
            }
        }

        // 4. driver error CLASS names (cassandra, couchbase, mongo network)
        if (typeof name === 'string' && TRANSIENT_NAME[name]) {
            return { isTransient: true, reason: TRANSIENT_NAME[name] };
        }

        // 5. mongodb error labels — the driver's own retryable signal
        if (typeof err.hasErrorLabel === 'function') {
            if (err.hasErrorLabel('TransientTransactionError')) {
                return { isTransient: true, reason: 'mongo:transient-transaction' };
            }
            if (err.hasErrorLabel('RetryableWriteError')) {
                return { isTransient: true, reason: 'mongo:retryable-write' };
            }
        }

        // 6. mongodb numeric server codes
        if (typeof code === 'number' && TRANSIENT_MONGO_CODE[code]) {
            return { isTransient: true, reason: TRANSIENT_MONGO_CODE[code] };
        }

        // 7. couchbase N1QL cause envelope (preserved by #B153's raw-error forward)
        if (err.cause && typeof err.cause === 'object') {
            var n1ql = err.cause.first_error_code;
            if (typeof n1ql === 'number' && TRANSIENT_N1QL_CODE[n1ql]) {
                return { isTransient: true, reason: TRANSIENT_N1QL_CODE[n1ql] };
            }
            if (err.cause.retry === true) {
                return { isTransient: true, reason: 'couchbase:retryable' };
            }
        }

        return { isTransient: false, reason: null };
    } catch (_e) {
        // classification must never break the error path
        return { isTransient: false, reason: null };
    }
}

/**
 * Stamps the classification onto the error object in place and returns it.
 * Additive (sets only `isTransient` + `transientReason`); never throws — a
 * frozen or exotic error object is left unstamped rather than raising on the
 * error path.
 *
 * @param {*} err
 * @returns {*} the same err (for chaining)
 *
 * @example
 * // at a connector's reject site — stamp returns err, so fold it into the terminal:
 * .catch(function (err) { _reject(lib.connectorError.stamp(err)); });
 */
function stamp(err) {
    if (!err || typeof err !== 'object') {
        return err;
    }
    var c = classify(err);
    try {
        err.isTransient     = c.isTransient;
        err.transientReason = c.reason;
    } catch (_e) {
        // a frozen / non-extensible error object — leave it unstamped
    }
    return err;
}

module.exports = {
    classify : classify,
    stamp    : stamp
};
