/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

'use strict';

/**
 * @module inspectorEvents
 *
 * #EVTBUS — observable application-event emit hook for the Inspector.
 *
 * Lets a bundle surface a named runtime event (e.g. `order.created`) so it
 * shows up in the Inspector's Event tab — both as a live `inspector#event`
 * frame (streamed over `/_gina/agent`) and in the end-of-request `user.events`
 * snapshot (carried on `inspector#data`). This is an OBSERVABILITY hook, NOT a
 * general pub/sub bus: the only subscriber is the Inspector, so when neither the
 * dev term nor an instrumentation window is open the emit is a cheap no-op with
 * zero subscribers.
 *
 * Mirrors the #AISTREAM AI-token signal, with ONE deliberate divergence: the
 * live `inspector#event` frame is emitted whenever the gate is open (store or
 * not), so non-request callers (background jobs, framework lifecycle hooks —
 * #EVTBUS Slice 2b) reach the stream; #AISTREAM's live `inspector#token` emit is
 * itself store-gated. The per-request buffer is a sibling KEY (`_devEventLog`)
 * inside the single `process.gina._queryALS` store (set up in controller.js
 * `setOptions` alongside `_devQueryLog` / `_devAiLog`), reached here via
 * `getStore()`. Capture is gated on the dev term OR an open instrumentation
 * window — identical to the query / AI capture gates.
 *
 * Metadata safety: the event NAME plus framework stamps (`id`, `t`) always ride
 * the wire; the caller-supplied `metadata` object's VALUES ride ONLY when
 * `settings.inspector.events.captureArgs` is enabled (seeded onto
 * `process.gina._inspectorEventsCaptureArgs` at boot, default false). This
 * mirrors #AISTREAM's `captureText`: `lib/inspector-redact` matches secret-NAMED
 * keys only and cannot sanitise arbitrary argument VALUES, so the protection is
 * the gate + the opt-in + the authenticated channel — never redaction.
 *
 * Stateless (no module-scope registry or timer — only a monotonic counter whose
 * uniqueness does not depend on surviving a reset), so it is registered in
 * lib/index.js via the dev-mode-hot-reloadable `_require`.
 *
 * @package gina.framework
 * @namespace inspectorEvents
 * @author Rhinostone <contact@gina.io>
 */

/**
 * Monotonic per-process counter giving each emitted event a unique id suffix
 * (disambiguates events that share a millisecond on the client). Uniqueness does
 * not rely on this surviving a `refreshCore()` reset — the timestamp component
 * keeps ids distinct across requests regardless.
 * @type {number}
 * @private
 */
var _eventSeq = 0;

/**
 * Emit an observable application event to the Inspector. Once the dev/window gate
 * passes the live `inspector#event` frame is ALWAYS emitted; the per-request buffer
 * entry (→ end-of-request `user.events` snapshot) is pushed ONLY inside a request's
 * async context (when the shared `_queryALS` store exists). Called from a detached
 * timer, a background job, or a framework lifecycle hook (no store), it still emits
 * the live frame — only the snapshot half is skipped. A no-op (returns `false`) only
 * when the gate is closed or `name` is invalid. (This always-on-live contract is the
 * #EVTBUS Slice 2b unblock; it intentionally diverges from #AISTREAM, whose live
 * `inspector#token` emit is itself store-gated.)
 *
 * @param {string} name        - Dotted event name, e.g. `'order.created'`. Required, non-empty.
 * @param {Object} [metadata]  - Optional structured metadata. Its VALUES reach the
 *                               wire only when `settings.inspector.events.captureArgs`
 *                               is enabled (default off); the event name + stamps
 *                               always do.
 * @param {string} [source='app'] - Origin discriminator: `'app'` for an explicit
 *                               `self.emitEvent`, `'framework'` for a bridged framework
 *                               event (#EVTBUS Slice 2a/2b). A framework-controlled field,
 *                               so it ALWAYS rides the wire (unlike caller metadata).
 * @returns {boolean} `true` if the live frame was emitted (gate open + valid name; the
 *                    buffer entry is added too when in a request's async context);
 *                    `false` only when gated out or the name is invalid.
 *
 * @example
 * // From a controller action (preferred — see self.emitEvent):
 * self.emitEvent('order.created', { orderId: order.id });
 *
 * @example
 * // From model / service code (no `self`), via the bare-module resolver:
 * require('lib/inspector-events').emit('cache.miss', { key: k });
 */
function emit(name, metadata, source) {
    if (typeof name !== 'string' || name.length === 0) {
        return false;
    }
    // Gate: dev term OR an open instrumentation window — identical to the
    // query-connector and AI-stream capture gates.
    var envIsDev = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) );
    if ( !( envIsDev || (process.gina && process.gina._inspectorWindowUntil > Date.now()) ) ) {
        return false;
    }
    var captureArgs = !!(process.gina && process.gina._inspectorEventsCaptureArgs);
    var t  = Date.now();
    var id = 'ev-' + t.toString(36) + '-' + (++_eventSeq);
    // #EVTBUS — `source` discriminates a framework-bridged event (Slice 2a/2b pass
    // 'framework') from an app's own self.emitEvent (default 'app'); a
    // framework-controlled field, so it ALWAYS rides (unlike captureArgs-gated meta).
    var evSource = (typeof source === 'string' && source) ? source : 'app';

    // Snapshot half (→ `user.events`). Reach the per-request buffer via the shared
    // `_queryALS` store. Outside a request's async context `getStore()` is undefined
    // → there is no buffer to snapshot onto, so SKIP the push (the live frame below
    // still ships — that is the Slice 2b lifecycle / background-job unblock). The
    // metadata object is attached only when captureArgs is on; on the snapshot path
    // it still passes through lib/inspector-redact (secret-NAMED keys masked), but
    // values are NOT relied upon to be safe — the opt-in is the contract.
    var store = (process.gina && process.gina._queryALS) ? process.gina._queryALS.getStore() : null;
    var buf   = store ? store._devEventLog : null;
    if (buf) {
        var entry = {
            type   : 'event',
            id     : id,
            name   : name,
            t      : t,
            source : evSource
        };
        if (captureArgs && metadata && typeof metadata === 'object') {
            entry.meta = metadata;
        }
        buf.push(entry);
    }

    // Live half (→ `inspector#event` → `event: event` SSE / `{event:'event'}` WS).
    // ALWAYS emitted once the gate passes — store or not. NOT run through redact()
    // — the free-text channel relies on the gate + the authenticated transport (per
    // #AISTREAM); ships metadata values only when captureArgs is on. NOTE: this
    // DIVERGES from #AISTREAM, whose live `inspector#token` emit is itself
    // store-gated (core/connectors/ai/index.js `if (_aiLog)`); #EVTBUS's always-on
    // contract is the Slice 2b lifecycle-emit requirement (no request context).
    var frame = { name: name, id: id, t: t, source: evSource };
    if (captureArgs && metadata && typeof metadata === 'object') {
        frame.meta = metadata;
    }
    process.emit('inspector#event', frame);
    return true;
}

/**
 * Match an event NAME against an allow-list of topic patterns. A topic is an
 * exact name, or carries a single `*` wildcard at the END (prefix match) or the
 * START (suffix match) — NOT a full glob/regex, which keeps it cheap and free of
 * any injection surface. A non-array or empty list matches nothing.
 *
 * @param {string}   name   - Event name to test, e.g. `'account#save'`.
 * @param {string[]} topics - Allow-list, e.g. `['account#*', '*#insert', 'N1QL:*']`.
 * @returns {boolean} `true` if `name` matches any topic.
 *
 * @example
 * matchTopics('account#save',     ['account#*']);     // true  (trailing-* prefix)
 * matchTopics('order#insert',     ['*#insert']);      // true  (leading-* suffix)
 * matchTopics('order#insert',     ['order#insert']);  // true  (exact)
 * matchTopics('N1QL:Order#fetch', ['N1QL:*']);        // true  (connector prefix)
 * matchTopics('cache.miss',       ['account#*']);     // false
 */
function matchTopics(name, topics) {
    if (typeof name !== 'string' || !Array.isArray(topics)) {
        return false;
    }
    for (var i = 0; i < topics.length; i++) {
        var topic = topics[i];
        if (typeof topic !== 'string' || !topic) {
            continue;
        }
        if (topic === '*' || topic === name) {
            return true;
        }
        // trailing '*' → prefix match: 'account#*' matches 'account#save'
        if (topic.charAt(topic.length - 1) === '*'
            && name.indexOf(topic.slice(0, -1)) === 0) {
            return true;
        }
        // leading '*' → suffix match: '*#insert' matches 'order#insert'
        if (topic.charAt(0) === '*') {
            var suffix = topic.slice(1);
            if (suffix.length <= name.length
                && name.slice(name.length - suffix.length) === suffix) {
                return true;
            }
        }
    }
    return false;
}

module.exports = {
    emit        : emit,
    matchTopics : matchTopics
};
