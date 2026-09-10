/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

'use strict';

/**
 * @module instrument
 *
 * #INS10 — toggleable Inspector instrumentation window.
 *
 * Opens a time-boxed window during which the Inspector's query + flow capture
 * runs even when the bundle is NOT in dev mode (NODE_ENV_IS_DEV unset), so a
 * production issue can be traced for a bounded period without enabling full
 * dev mode. The window is a process-global epoch-ms deadline stored on
 * `process.gina._inspectorWindowUntil` (0 = closed). Every capture gate reads
 * that slot directly (dependency-free: `process.gina._inspectorWindowUntil >
 * Date.now()`); {@link module:instrument.isActive} is the canonical equivalent
 * used by the control endpoint, the status view, and the tests.
 *
 * Module-singleton: registered in lib/index.js via a PLAIN require (not the
 * dev-mode cache-busting `_require`) so the expiry timer and window state
 * survive `refreshCore()`'s per-request `Lib()` rebuild — same discipline as
 * lib/job and lib/state.
 *
 * Safety bounds:
 *   - HARD_CAP_SECONDS (3600) is an absolute ceiling. settings.json
 *     `inspector.instrumentation.maxWindowSeconds` may LOWER it but never raise
 *     it above 3600 — a forgotten window cannot stay open beyond one hour.
 *   - The window auto-closes lazily (every gate compares against `Date.now()`)
 *     and eagerly (an unref'd `setTimeout` fires `close()` at the deadline).
 *     `unref()` lets the process exit without the timer pinning the event loop.
 *
 * This module never reads or writes the HTTP response body and never logs
 * secrets; it only flips a deadline and emits `inspector#instrument-closed` on
 * teardown (the server engines listen to clear `_lastGinaData` + log the close).
 *
 * @package gina.framework
 * @namespace instrument
 * @author Rhinostone <contact@gina.io>
 */

/**
 * Absolute maximum window length, in seconds. Config may lower the effective
 * cap but never exceed this hard ceiling.
 * @constant {number}
 */
var HARD_CAP_SECONDS = 3600;

/**
 * Default window length, in seconds, used when the caller omits a ttl and
 * settings.json does not override `defaultWindowSeconds`.
 * @constant {number}
 */
var DEFAULT_WINDOW_SECONDS = 300;

/**
 * Live handle to the unref'd expiry timer, or null when no window is armed.
 * @type {?object}
 * @private
 */
var _expiryTimer = null;

/**
 * Ensure the `process.gina` container and the window slot exist. The slot is
 * also seeded by gna.js at server start; this guard makes the module safe to
 * call in isolation (tests, very-early use).
 * @inner
 * @returns {void}
 */
function _ensureSlot() {
    if (typeof process.gina !== 'object' || !process.gina) {
        process.gina = {};
    }
    if (typeof process.gina._inspectorWindowUntil !== 'number') {
        process.gina._inspectorWindowUntil = 0;
    }
}

/**
 * Resolve the effective maximum window length: the operator-tunable
 * `process.gina._inspectorWindowMaxSec` (seeded from settings.json by gna.js),
 * clamped down to {@link HARD_CAP_SECONDS}.
 * @inner
 * @returns {number} effective max in seconds (1..HARD_CAP_SECONDS)
 */
function _effectiveMaxSeconds() {
    var configured = (process.gina && typeof process.gina._inspectorWindowMaxSec === 'number' && process.gina._inspectorWindowMaxSec > 0)
        ? process.gina._inspectorWindowMaxSec
        : HARD_CAP_SECONDS;
    return Math.min(configured, HARD_CAP_SECONDS);
}

/**
 * Resolve the default window length used when the caller omits a ttl. Capped
 * by {@link _effectiveMaxSeconds} so a misconfigured default cannot exceed the
 * ceiling.
 * @inner
 * @returns {number} default window in seconds
 */
function _defaultSeconds() {
    var configured = (process.gina && typeof process.gina._inspectorWindowDefaultSec === 'number' && process.gina._inspectorWindowDefaultSec > 0)
        ? process.gina._inspectorWindowDefaultSec
        : DEFAULT_WINDOW_SECONDS;
    return Math.min(configured, _effectiveMaxSeconds());
}

/**
 * Arm (or re-arm) the eager expiry timer. Fires `close()` shortly after the
 * deadline so the window tears down even on an otherwise-idle process. The
 * lazy per-gate check is the correctness backstop if the timer is delayed.
 * @inner
 * @param {number} ttlSeconds
 * @returns {void}
 */
function _armExpiryTimer(ttlSeconds) {
    if (_expiryTimer) {
        clearTimeout(_expiryTimer);
        _expiryTimer = null;
    }
    // +250ms cushion so the lazy gate check (strict `>`) has certainly closed
    // the window before the eager teardown fires.
    _expiryTimer = setTimeout(function () {
        close();
    }, ttlSeconds * 1000 + 250);
    if (_expiryTimer && typeof _expiryTimer.unref === 'function') {
        _expiryTimer.unref();
    }
}

/**
 * Whether a production instrumentation window is currently open. Canonical form
 * of the dependency-free expression the capture gates inline
 * (`process.gina._inspectorWindowUntil > Date.now()`). Window-only and
 * deliberately independent of NODE_ENV_IS_DEV — gates OR it with their own dev
 * term.
 *
 * @memberof module:instrument
 * @returns {boolean} true when a window deadline is set and not yet elapsed
 * @example
 * // at a capture gate:
 * if (envIsDev || lib.instrument.isActive()) { ...capture... }
 */
function isActive() {
    return !!(process.gina && typeof process.gina._inspectorWindowUntil === 'number'
        && process.gina._inspectorWindowUntil > Date.now());
}

/**
 * Current window status — safe to expose over the authenticated control
 * endpoint. Reports the WINDOW state only (NODE_ENV_IS_DEV is a separate axis,
 * not reflected here).
 *
 * @memberof module:instrument
 * @returns {{active:boolean, until:number, startedAt:number, remainingMs:number}}
 * @example
 * lib.instrument.status();
 * // { active: true, until: 1750000000000, startedAt: 1749999700000, remainingMs: 287000 }
 */
function status() {
    _ensureSlot();
    var now    = Date.now();
    var until  = process.gina._inspectorWindowUntil || 0;
    var active = until > now;
    return {
        active      : active,
        until       : active ? until : 0,
        startedAt   : active ? (process.gina._inspectorWindowStartedAt || 0) : 0,
        remainingMs : active ? (until - now) : 0
    };
}

/**
 * Open (or extend / reset) the instrumentation window.
 *
 * @memberof module:instrument
 * @param {number} [ttlSeconds] - requested window length; clamped to
 *        `[1, effectiveMax]`. Non-numeric or `<= 0` falls back to the default.
 * @returns {{active:boolean, until:number, startedAt:number, remainingMs:number}} status after opening
 * @example
 * lib.instrument.open(300);  // open a 5-minute window
 * lib.instrument.open();     // open the default-length window
 */
function open(ttlSeconds) {
    _ensureSlot();
    var ttl = parseInt(ttlSeconds, 10);
    if (isNaN(ttl) || ttl <= 0) {
        ttl = _defaultSeconds();
    }
    var max = _effectiveMaxSeconds();
    if (ttl > max) {
        ttl = max;
    }
    var now = Date.now();
    process.gina._inspectorWindowStartedAt = now;
    process.gina._inspectorWindowUntil     = now + ttl * 1000;
    _armExpiryTimer(ttl);
    return status();
}

/**
 * Close the instrumentation window immediately (manual disable, or fired by the
 * expiry timer). Idempotent. Emits `inspector#instrument-closed` ONLY when a
 * window was actually open, so the server engines can clear the last-captured
 * snapshot and log the close without spurious events.
 *
 * @memberof module:instrument
 * @fires inspector#instrument-closed
 * @returns {{active:boolean, until:number, startedAt:number, remainingMs:number}} status after closing (always inactive)
 * @example
 * lib.instrument.close();
 */
function close() {
    _ensureSlot();
    var wasActive = process.gina._inspectorWindowUntil > Date.now();
    process.gina._inspectorWindowUntil     = 0;
    process.gina._inspectorWindowStartedAt = 0;
    if (_expiryTimer) {
        clearTimeout(_expiryTimer);
        _expiryTimer = null;
    }
    if (wasActive) {
        // never throw on teardown — listeners are best-effort cleanup.
        try { process.emit('inspector#instrument-closed'); } catch (e) { /* swallow */ }
    }
    return status();
}

module.exports = {
    HARD_CAP_SECONDS       : HARD_CAP_SECONDS,
    DEFAULT_WINDOW_SECONDS : DEFAULT_WINDOW_SECONDS,
    isActive               : isActive,
    status                 : status,
    open                   : open,
    close                  : close
};
