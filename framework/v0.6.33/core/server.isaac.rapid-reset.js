/**
 * HTTP/2 rapid-reset guard — the counting policy behind `server.isaac.js`'s
 * per-session limiter (#H9, re-scoped by #B611).
 *
 * CVE-2023-44487 ("Rapid Reset") is a client opening a stream and cancelling it
 * with `RST_STREAM` before the server has answered, thousands of times per second:
 * every open/reset pair is nearly free for the attacker and a full request
 * setup/teardown for the server. The guard therefore counts, per session, the
 * streams the CLIENT cut short before the response completed, in a rolling
 * one-second window, and asks the engine to GOAWAY the session past a limit.
 *
 * It deliberately does NOT count new streams. The limiter it replaces did, and a
 * well-behaved multiplexing caller — a sibling bundle's `self.query()` sends every
 * call to one authority on ONE cached session — tripped it at 200 calls/s
 * (bundle-to-bundle audit, 2026-09-24: 17% of calls answered 500 at 50 concurrent
 * callers with default settings). New streams are bounded by `maxConcurrentStreams`.
 *
 * Which signal, and why (measured on node v25.3.0 / nghttp2 1.67.1 with a bare
 * `node:http2` server, 2026-09-24):
 *
 * - A server stream's `'aborted'` event fires when the stream closes while its
 *   writable side is still open — i.e. the peer reset it (`RST_STREAM`, ANY code,
 *   including 0) or destroyed it before the response ended. A stream the client
 *   resets AFTER the response completed never reaches this layer (it is already
 *   closed) — that is not amplification, the work was done.
 * - The SERVER's own `destroy()` of an unfinished stream also emits `'aborted'`,
 *   but with `stream.destroyed === true` at that moment; a session teardown
 *   (`goaway()` + `close()`, or `destroy()`) aborts every in-flight stream with
 *   `session.closed` / `session.destroyed` set. Both are excluded — they are the
 *   engine's decisions, not the client's.
 * - `stream.rstCode` is a PROPERTY, not an event: the `'rstCode'` listener the
 *   previous code attached never fired (#B614).
 *
 * Bun's `node:http2` server emits the same event with a DIFFERENT state model, so
 * the discriminator is picked by runtime at load (#B615, measured on Bun 1.2.21 /
 * 1.3.14 / 1.4.2 with a raw-frame client, 2026-09-24):
 *
 * - Bun closes the stream (`state.state` 7, `state.localClose` 1) BEFORE emitting
 *   `'aborted'` for a reset it received; its own `destroy()` / `close()` emit the
 *   event with the local side still open (`localClose` 0). That field is the Bun
 *   signal — `stream.destroyed` is not: 1.4.2 reads it `true` for every received
 *   reset but CANCEL (the node rule missed them), 1.2 / 1.3 read it `false` for
 *   the engine's own aborts (the node rule over-counted them).
 * - Bun has NO frame-level reset rate limit — 50,000 open+reset pairs on one
 *   session raise no GOAWAY and no event on any of the three versions, and the
 *   `streamResetBurst` / `streamResetRate` server options are ignored. On Bun
 *   this guard is the ONLY layer.
 *
 * nghttp2 >= 1.57 (node >= 20.8.1) carries its own reset rate limit — a 1,000-frame
 * burst, then 33/s, closing the session with `GOAWAY(INTERNAL_ERROR)` and no
 * server-side event — and it applies to every received `RST_STREAM`, completed
 * streams included. On node this guard is the observable, configurable,
 * tighter-burst layer on top of it (a GOAWAY with `ENHANCE_YOUR_CALM`, a warn
 * line, the `rapidResetBlocked` and `rstCount` metrics), never the only one.
 *
 * Framework-free on purpose: it is unit-tested live against a bare
 * `http2.createServer()`, which `server.isaac.js` (loading the lib registry at
 * require time) cannot be. Its one dependency, `utils/runtime`, is a
 * dependency-free leaf at the package root.
 *
 * @module core/server.isaac.rapid-reset
 */
'use strict';

/**
 * Default limit: client resets per session per rolling one-second window.
 *
 * Kept at the previous limiter's value. On node it sits well below nghttp2's
 * 1,000-frame burst, so a BURST meets this layer first, observably; a SUSTAINED
 * client reset rate between nghttp2's 33/s refill and this limit trips nghttp2
 * first, after roughly 1000 / (rate − 33) seconds (inferred from the measured
 * bucket, not measured as such). On Bun nothing sits underneath: this is the only
 * layer (module header). Well above anything a browser produces (cancelling a
 * page's in-flight requests is a burst of a few dozen at most).
 *
 * @constant {number}
 */
var DEFAULT_MAX_RESETS_PER_SECOND = 200;

/**
 * Whether this process runs on Bun — decided once at load. The `'aborted'`-time
 * state model differs by runtime (module header), so the discriminator is picked
 * by RUNTIME, never by feature-probing a stream: the Bun rule is wrong on node
 * and the node rule is wrong on Bun.
 *
 * `utils/runtime` is a dependency-free leaf at the package root (the
 * `lib/sqlite-driver` shape), so the module stays free of the lib registry.
 *
 * @constant {boolean}
 */
var RUNTIME_IS_BUN = require(__dirname + '/../../../utils/runtime').isBun();

/**
 * Rolling window length in milliseconds.
 *
 * @constant {number}
 */
var WINDOW_MS = 1000;

/**
 * Resolves the limit from a bundle's `settings.json` `http2Options` block.
 *
 * Same idiom as the sibling #H3/#H7 options: a missing, non-numeric or `0` value
 * falls back to the default — the guard cannot be disabled by setting it to `0`.
 * The pre-0.6.33 key `maxStreamsPerSecond` is NOT read here (it described a
 * different count); the engine warns once when it is present.
 *
 * @param {*} h2Opts - `settings.server.http2Options` (may be anything)
 * @returns {number} The limit, `>= 1`
 *
 * @example
 * resolveMaxResetsPerSecond({ maxStreamResetsPerSecond: 50 }); // → 50
 * resolveMaxResetsPerSecond({ maxStreamsPerSecond: 1000000 }); // → 200 (old key, ignored)
 * resolveMaxResetsPerSecond(undefined);                         // → 200
 */
function resolveMaxResetsPerSecond(h2Opts) {
    var _h2Opts = (h2Opts && typeof h2Opts === 'object') ? h2Opts : {};
    var _max = Number(_h2Opts.maxStreamResetsPerSecond);
    if (!(_max > 0)) { return DEFAULT_MAX_RESETS_PER_SECOND; }
    return Math.floor(_max);
}

/**
 * Tells a CLIENT reset from an engine-initiated abort at the moment the stream's
 * `'aborted'` event fires (see the module header for the measured shapes).
 *
 * @param {object} session - The `http2.ServerHttp2Session` the stream belongs to
 * @param {object} stream  - The `http2.ServerHttp2Stream` that just emitted `'aborted'`
 * @returns {boolean} `true` when the peer cut the stream short
 *
 * @example
 * stream.on('aborted', function() {
 *     if (!isClientReset(session, stream)) return; // engine teardown, not the peer
 * });
 */
function isClientReset(session, stream) {
    if (!session || !stream) { return false; }
    if (stream.destroyed) { return false; }                 // the engine destroyed it
    if (session.closed || session.destroyed) { return false; } // session teardown
    return true;
}

/**
 * The Bun variant of {@link isClientReset} (#B615). Bun's `node:http2` server
 * marks a stream CLOSED (`state.state` 7, `state.localClose` 1) BEFORE emitting
 * `'aborted'` for a reset it RECEIVED, while its own `destroy()` / `close()` emit
 * the event with the local side still open (`localClose` 0) — measured on nine
 * abort shapes across Bun 1.2.21, 1.3.14 and 1.4.2 (2026-09-24). `stream.destroyed`
 * cannot serve there: 1.4.2 reads it `true` for every received reset but CANCEL
 * (the node rule missed them), 1.2 / 1.3 read it `false` for the engine's own
 * aborts (the node rule over-counted them).
 *
 * Fail-closed: when `state.localClose` is unreadable the reset IS counted — a
 * missed reset is the hole this guard exists to close, an over-counted engine
 * abort costs one session, and the live arms in the Bun CI leg turn red on any
 * runtime change that gets here.
 *
 * On node this function is WRONG (a received reset reads `localClose` 0 there);
 * it is selected only when {@link RUNTIME_IS_BUN}.
 *
 * @param {object} session - The `http2.ServerHttp2Session` the stream belongs to
 * @param {object} stream  - The `http2.ServerHttp2Stream` that just emitted `'aborted'`
 * @returns {boolean} `true` when the peer cut the stream short
 *
 * @example
 * // a received RST_STREAM on Bun 1.4 (destroyed already reads true)
 * isClientResetOnBun({ closed: false, destroyed: false }, { destroyed: true,  state: { localClose: 1 } }); // → true
 * // the engine's own destroy() / close(code)
 * isClientResetOnBun({ closed: false, destroyed: false }, { destroyed: false, state: { localClose: 0 } }); // → false
 */
function isClientResetOnBun(session, stream) {
    if (!session || !stream) { return false; }
    if (session.closed || session.destroyed) { return false; } // session teardown
    var _state = null;
    try { _state = stream.state; } catch (e) { _state = null; }
    if (_state && typeof _state.localClose === 'number') {
        return _state.localClose === 1;                        // the peer closed it first
    }
    return true;                                               // unreadable: count it (fail-closed)
}

/**
 * The discriminator {@link attach} uses on this runtime.
 *
 * @constant {function}
 */
var isClientResetActive = RUNTIME_IS_BUN ? isClientResetOnBun : isClientReset;

/**
 * The window step: records one client reset on the session and reports whether
 * it breached the limit. State lives on the session object (`_resetWindowStart`,
 * `_resetWindowCount`), so every session is limited independently.
 *
 * - the window resets when `>= WINDOW_MS` have elapsed (exactly 1000 ms starts a
 *   fresh window);
 * - the breach is `count > max`: the `max`-th reset in a window is allowed, the
 *   next one breaches — and every further reset in that window breaches again.
 *
 * @param {object} session - The session carrying the window state (mutated)
 * @param {number} now     - The current timestamp in ms (`Date.now()`, injectable for tests)
 * @param {number} max     - The limit from {@link resolveMaxResetsPerSecond}
 * @returns {boolean} `true` when this reset breached the limit
 *
 * @example
 * var s = {};
 * countReset(s, 1000, 2); // false (1)
 * countReset(s, 1500, 2); // false (2)
 * countReset(s, 1900, 2); // true  (3 > 2)
 * countReset(s, 2000, 2); // false (new window, 1)
 */
function countReset(session, now, max) {
    if (typeof session._resetWindowStart === 'undefined' || (now - session._resetWindowStart) >= WINDOW_MS) {
        session._resetWindowStart = now;
        session._resetWindowCount = 0;
    }
    session._resetWindowCount++;
    return session._resetWindowCount > max;
}

/**
 * Arms the guard on one server stream: on a CLIENT reset it calls `hooks.onReset()`
 * (the engine's `rstCount` metric), counts it on the session's window and, on a
 * breach, calls `hooks.onBreach(count, max)` — the engine then warns, sends
 * `GOAWAY(ENHANCE_YOUR_CALM)` and closes the session. Once the session is closing,
 * the remaining in-flight streams' aborts are teardown, not resets, and are not
 * counted (see {@link isClientReset} on node, {@link isClientResetOnBun} on Bun —
 * picked once at load, {@link isClientResetActive}).
 *
 * Call it from the session's `'stream'` listener, once per stream.
 *
 * @param {object}   session          - The `http2.ServerHttp2Session`
 * @param {object}   stream           - The `http2.ServerHttp2Stream` just opened on it
 * @param {number}   max              - The limit from {@link resolveMaxResetsPerSecond}
 * @param {object}   hooks
 * @param {function} [hooks.onReset]  - Called for every counted client reset
 * @param {function} [hooks.onBreach] - Called with `(count, max)` for every reset past the limit
 * @param {function} [now]            - Clock, defaults to `Date.now` (injectable for tests)
 * @returns {void}
 *
 * @example
 * session.on('stream', function(stream) {
 *     attach(session, stream, max, {
 *         onReset  : function() { metrics.rstCount++; },
 *         onBreach : function(count, limit) {
 *             metrics.rapidResetBlocked++;
 *             session.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM);
 *             session.close();
 *         }
 *     });
 * });
 */
function attach(session, stream, max, hooks, now) {
    var _hooks = hooks || {};
    var _now   = (typeof now === 'function') ? now : Date.now;
    stream.on('aborted', function onStreamAbortedByPeer() {
        if (!isClientResetActive(session, stream)) { return; }
        if (typeof _hooks.onReset === 'function') { _hooks.onReset(); }
        if (countReset(session, _now(), max) && typeof _hooks.onBreach === 'function') {
            _hooks.onBreach(session._resetWindowCount, max);
        }
    });
}

module.exports = {
    DEFAULT_MAX_RESETS_PER_SECOND : DEFAULT_MAX_RESETS_PER_SECOND,
    WINDOW_MS                     : WINDOW_MS,
    RUNTIME_IS_BUN                : RUNTIME_IS_BUN,
    resolveMaxResetsPerSecond     : resolveMaxResetsPerSecond,
    isClientReset                 : isClientReset,
    isClientResetOnBun            : isClientResetOnBun,
    isClientResetActive           : isClientResetActive,
    countReset                    : countReset,
    attach                        : attach
};
