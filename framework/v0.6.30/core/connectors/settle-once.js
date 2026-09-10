/**
 * @module settle-once
 *
 * #B432 — a per-call guard that settles a caller exactly once and never
 * re-invokes a callback that threw.
 *
 * Why this exists: every connector delivers a result by invoking a callback
 * the CALLER supplied. That callback is application code, so it can throw for
 * reasons that have nothing to do with the query — a template error, a null
 * dereference in the handler, an assertion. Two shapes then run it a second
 * time with a different payload:
 *
 *   1. a synchronous `try { cb(null, rows); } catch (e) { cb(e); }` — the
 *      callback's own exception lands in the catch, which calls it again; and
 *   2. a promise chain `.then(function () { cb(null, rows); })` followed by a
 *      trailing `.catch(function (e) { cb(e); })` — the success handler's throw
 *      rejects the intermediate promise, and the trailing catch settles again.
 *
 * Both deliver a success and then an error for one operation, so the canonical
 * `if (err) { return next(err); } render(data);` shape runs BOTH branches. The
 * second call is also actively misleading: it reports the caller's own
 * exception as though it were a database failure.
 *
 * A native promise resolver is immune (a promise settles once), which is why
 * only the callback-bearing paths need this. Sibling of `param-redact` and
 * `sql-parser`: loaded by a relative require, and deliberately DEPENDENCY-FREE
 * (no lib registry, no logger) so it can never affect a query path.
 *
 * Scope note: `core/connectors/couchbase/index.js` keeps its own inline
 * `_deliver()` closure — the reference implementation this module generalises.
 * Converting it is deliberately out of scope; its behaviour is already correct
 * and pinned by `test/core/couchbase-concurrency.test.js`.
 */

'use strict';

/**
 * Describe a thrown value without ever mutating it.
 *
 * A throw is not guaranteed to be an `Error` — `throw 'boom'` is legal — and
 * these modules run under `'use strict'`, where assigning a property onto a
 * primitive throws a `TypeError`. So the message is BUILT rather than stamped
 * onto the thrown value, which keeps the reporter itself throw-free.
 *
 * @memberof module:settle-once
 * @inner
 * @param {*} thrown - whatever the callback threw
 * @returns {string} a printable description
 *
 * @example
 * describeThrow(new Error('boom'))   // -> 'Error: boom\n    at …'
 * @example
 * describeThrow('boom')              // -> 'boom'
 */
function describeThrow(thrown) {
    if (thrown && typeof thrown === 'object') {
        if (typeof thrown.stack === 'string' && thrown.stack) return thrown.stack;
        if (typeof thrown.message === 'string' && thrown.message) return thrown.message;
    }
    try {
        return String(thrown);
    } catch (_e) {
        return '[unprintable thrown value]';
    }
}

/**
 * Wrap a caller-supplied callback in a per-call at-most-once guard.
 *
 * The returned function forwards every argument it receives, so it fits any
 * callback arity a connector uses — `(err, rows)`, `(err, rows, meta)`, or the
 * Inspector's wider `(err, driver, database, indexes)`.
 *
 * Guarantees:
 * - the wrapped callback runs **at most once**, whichever path settles first;
 * - a callback that THROWS is never re-invoked — the throw is reported against
 *   `label` and swallowed, so it cannot travel back into the connector's own
 *   error path and masquerade as a query failure.
 *
 * ⚠️ Call this **per invocation**, inside the entity method or store operation
 * — never once at module scope. The guard flag lives in the returned closure,
 * so a module-scope guard would let the FIRST call permanently suppress every
 * later one.
 *
 * @memberof module:settle-once
 * @param {string} label - diagnostic label for the throw report, e.g. a query
 *   trigger (`SQL:user#findById`) or a store operation (`sqlite:session#get`).
 * @param {function} cb - the caller-supplied callback to guard. A non-function
 *   (including `null`) is accepted and makes the guard a no-op, so a promise
 *   path may share one guard with a callback path.
 * @param {object} [reporter=console] - anything exposing `error(message)`.
 *   Connectors pass their `console` (the framework logger); omitted, the global
 *   console is used. Never required — this module takes no dependencies.
 * @returns {function} the guarded settle function. Returns `true` when it
 *   delivered (or attempted to), `false` when it suppressed a repeat settle or
 *   had no callback to call.
 *
 * @example
 * // sqlite / mongodb / scylladb entity dispatch — `trigger` is in scope
 * var deliver = settleOnce(trigger, _mainCallback, console);
 * try {
 *     deliver(null, execute(args));
 * } catch (e) {
 *     deliver(lib.connectorError.stamp(e));   // suppressed if the first landed
 * }
 *
 * @example
 * // a store operation, where no `trigger` variable exists
 * var done = settleOnce('sqlite:session#get', fn);
 * op().then(function (row) { done(null, row); })
 *     .catch(function (err) { done(err); });
 */
function settleOnce(label, cb, reporter) {
    var delivered = false;

    return function guardedSettle() {
        if (delivered) {
            return false;
        }
        delivered = true;

        if (typeof cb !== 'function') {
            return false;
        }

        try {
            cb.apply(this, arguments);
        } catch (cbErr) {
            // #B432 — the caller's own callback threw. Never call it again:
            // re-invoking it here is what ran a throwing callback twice and
            // reported the caller's exception as a query failure. Surface it
            // instead, tagged with the operation that was delivering.
            var sink = (reporter && typeof reporter.error === 'function')
                ? reporter
                : console;
            try {
                sink.error('[ ' + label + ' ] callback exception:\n' + describeThrow(cbErr));
            } catch (_reportErr) {
                // a broken reporter must never break delivery accounting
            }
        }
        return true;
    };
}

module.exports = settleOnce;
module.exports.settleOnce     = settleOnce;
module.exports.describeThrow  = describeThrow;
