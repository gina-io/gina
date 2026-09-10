/**
 * Out-of-request push primitive (#B366).
 *
 * `SuperController.push()` is reachable only from a live request-bound
 * controller — it returns early once the request is released (#B38) — and the
 * engine.io socket set has exactly one other reader in the whole framework.
 * So code with no request in hand (a `lib/job` handler, a cron tick, a boot
 * hook) has had no sanctioned way to reach a user's socket. This module is it.
 *
 * Design notes (full record: the #B366 design):
 *
 *   - The recipient is a REQUIRED argument with no fallback, and there is no
 *     broadcast reachable from this API at all. #B364 shipped because a
 *     primitive whose blast radius is "everyone connected" inferred the wide
 *     case from a MISSING value; an absent recipient here is an error, never a
 *     fan-out. Deliberate all-clients sends stay in-request
 *     (`self.push(payload, { broadcast: true })`).
 *
 *   - The caller is trusted to name any session, exactly as the in-request
 *     `option.sessionID` branch already trusts server-side code. What must
 *     never happen is a recipient sourced from client input: capture the id
 *     server-side (at job creation, say) and keep it there. Round-tripping a
 *     recipient id — or a token naming one — through the browser hands the
 *     choice back to the caller and re-opens #B364 one layer up.
 *
 *   - Delivery is REPORTED, not assumed. `callback(err, { delivered })` gives
 *     the number of sockets written, because the shape this replaces was
 *     fire-and-forget and blind: a consumer measured ~41% of their progress
 *     pushes never sending, and nothing surfaced it. `delivered: 0` is a
 *     normal outcome (the user has no socket open), not an error.
 *
 *   - Receiver identity is a SEPARATE axis (#B365): this decides who a sender
 *     may aim at, never how a receiver proves who it is.
 *
 * @module lib/push
 */

/**
 * Push a payload to every engine.io socket bound to one session.
 *
 * @param {object}          instance            - The live server instance (`process.gina._serverInstance`).
 * @param {string}          sessionID           - REQUIRED recipient session id; empty/non-string is an error, never a broadcast.
 * @param {object|string}   payload             - Object (JSON-stringified) or a pre-serialized string.
 * @param {object}          [option]            - Forwarded to the transport (e.g. `{ compress: true }`).
 * @param {string}          [option.section]    - Stamped onto an object payload when it carries no `section`.
 * @param {function}        [callback]          - `callback(err, { delivered })`, called exactly ONCE.
 * @returns {void}
 *
 * @example
 * // from a job handler, with the session id captured at job creation
 * var push = require('gina').lib.push;
 * push.toSession(process.gina._serverInstance, job.sessionID, { event: 'ready', pct: 100 }, null, function(err, res) {
 *     if (err) { return console.error(err.code, err.message); }
 *     if (!res.delivered) { console.debug('user has no socket open'); }
 * });
 */
var toSession = function(instance, sessionID, payload, option, callback) {

    if ( typeof(option) == 'function' ) {
        callback = option;
        option   = null;
    }
    var cb = ( typeof(callback) == 'function' ) ? callback : function() {};

    // Fail CLOSED on an unusable recipient. This is the #B364 invariant in the
    // signature: no recipient means nothing is sent — never everyone.
    if ( typeof(sessionID) != 'string' || sessionID === '' ) {
        return cb(_err('PUSH_INVALID_RECIPIENT',
            '`sessionID` is required and must be a non-empty string. This API never broadcasts: '
            + 'use the in-request `self.push(payload, { broadcast: true })` to reach every client.'));
    }

    if ( payload == null ) {
        return cb(_err('PUSH_INVALID_PAYLOAD',
            '`payload` is required. There is no request to fall back to outside a controller.'));
    }

    if ( instance == null || instance.eio == null || instance.eio.clients == null ) {
        return cb(_err('PUSH_CHANNEL_NOT_CONFIGURED',
            'no engine.io channel on this server instance. The push channel needs the isaac engine with '
            + '`settings.json > server.ioServer.integrationMode: "attach"`; the express engine has no `eio`.'));
    }

    // Section stamping mirrors the in-request path, minus every request-sourced
    // default — there is no request here, so an explicit option is the only source.
    var section = ( option != null && typeof(option.section) != 'undefined' ) ? option.section : null;
    var body    = payload;
    if ( typeof(body) == 'object' ) {
        if ( section && typeof(body.section) == 'undefined' ) {
            body.section = section;
        }
        try {
            body = JSON.stringify(body);
        } catch (serializeErr) {
            return cb(_err('PUSH_PAYLOAD_SERIALIZE_FAILED', serializeErr.message || String(serializeErr)));
        }
    }

    var clients   = instance.eio.clients;
    var delivered = 0;
    try {
        for (let s in clients) {
            // #B364 — the guard this replaces read `!clients[s].constructor.name == 'Socket'`,
            // which parses as `(!name) == 'Socket'` and so never once skipped anything.
            if ( clients[s].constructor.name !== 'Socket' ) {
                continue;
            }
            if (
                typeof(clients[s].sessionId) != 'undefined'
                && clients[s].sessionId == sessionID
            ) {
                // The caller's callback is NOT threaded into sendPacket: it fires
                // per socket, and this API promises exactly one callback carrying a
                // total. Transport-level acks stay the transport's business.
                clients[s].sendPacket('message', body, option || {});
                ++delivered;
            }
        }
    } catch (sendErr) {
        return cb(sendErr);
    }

    return cb(null, { delivered: delivered });
};

/**
 * Build a coded Error — same shape as the storage verbs, so callers can branch
 * on `err.code` instead of matching message text.
 *
 * @inner
 * @private
 * @param {string} code    - Machine-readable code.
 * @param {string} message - Human-readable detail.
 * @returns {Error} The error, with `code` attached.
 */
var _err = function(code, message) {
    var e = new Error('[ push ] ' + message);
    e.code = code;
    return e;
};

module.exports = {
    toSession: toSession
};
