'use strict';
/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * renderStream delegate — streams an AsyncIterable as a chunked HTTP response.
 *
 * Content-type determines framing:
 *   text/event-stream  → SSE: each chunk is wrapped as `data: {chunk}\n\n`
 *   anything else      → raw chunks written in sequence
 *                        (HTTP/1.1 uses chunked transfer-encoding automatically)
 *
 * The caller (controller action) is responsible for yielding plain strings or
 * Buffers. Object chunks are coerced via String(). Buffer chunks are decoded
 * as UTF-8 on the SSE path only — on any other content-type they pass through
 * VERBATIM, byte-exact, which is what makes this delegate usable for binary
 * serving (#STO1 Range: 206 bodies must not be re-encoded).
 *
 * HEAD requests answer headers-only (no body, the iterable is never consumed —
 * a destroyable source is destroy()ed) — the same render-layer body
 * suppression every other delegate applies.
 *
 * HTTP/2: uses stream.respond() + stream.write() + stream.end()
 * HTTP/1.1: uses response.setHeader() + response.write() + response.end()
 *
 * In both cases all pending response headers set upstream (CORS, Content-Range,
 * etc.) are preserved and merged into the initial headers frame, and the
 * delegate's own defaults (cache-control, connection, x-accel-buffering) apply
 * only where the caller has not already chosen a value.
 *
 * @param {AsyncIterable} asyncIterable  Source of string/Buffer chunks
 * @param {string}        contentType    Response Content-Type (default: text/event-stream)
 * @param {object}        deps           Injected by controller: { self, local, headersSent }
 */

module.exports = function renderStream(asyncIterable, contentType, deps) {

    // #B62 (sibling of the render-swig #B61 race fix): the per-request deps
    // are FUNCTION-scoped. In prod this module is a shared singleton across
    // concurrent requests; with module-scoped captures, the fire-and-forget
    // _doStream IIFE below resumed after its `for await` reading a CONCURRENT
    // request's refs — its catch reported errors through the other request's
    // controller, and its finally nulled the OTHER request's live
    // local.req/res/next mid-stream (measured) while never releasing its own.
    var self        = deps.self;
    var local       = deps.local;
    var headersSent = deps.headersSent;

    // Prevent double-render (same guard used by renderJSON / renderTEXT)
    if (local.options.renderingStack.length > 1) return false;
    if (self.isProcessingError) return;

    // #B38 — released-response guard (see #B31 / #B36): a terminal exit (redirect() /
    // renderTEXT() / throwError()) nulled the per-request refs before this stream began.
    // renderStream's wrapper and this delegate are BOTH synchronous, so the read below
    // would throw synchronously → uncaughtException → SIGTERM. The read happens BEFORE the
    // headersSent() guard further down, so check here — mirrors render-json.js's #B36
    // placement (after isProcessingError, before the first local.res deref). Behaviour-
    // neutral on live requests (guard skipped while the refs exist).
    if (local.res == null) return;

    var response = local.res;
    var stream   = (typeof(response.stream) !== 'undefined') ? response.stream : null;
    // #H10 — opt-in HTTP/2 response trailers (registered via self.sendTrailers()).
    var _trailers = (local._trailers && typeof(local._trailers) === 'object') ? local._trailers : null;

    if (headersSent(response)) {
        local.req = null; local.res = null; local.next = null;
        return;
    }

    contentType = contentType || 'text/event-stream';
    var isSSE   = /text\/event-stream/i.test(contentType);

    /**
     * Frame one chunk for the wire.
     *
     * SSE is a TEXT protocol, so Buffers are decoded as UTF-8 before framing.
     * On the raw (non-SSE) path a Buffer passes through VERBATIM: the
     * historical unconditional `chunk.toString('utf8')` replaced every
     * non-UTF-8 byte with U+FFFD (measured: a 12-byte PNG header round-tripped
     * to 20 bytes), which made this delegate unusable for byte serving. A
     * valid-UTF-8 Buffer re-encodes byte-identically on write, so text
     * consumers see no change.
     *
     * @inner
     * @param {Buffer|string|*} chunk - One yielded chunk.
     * @returns {Buffer|string} The bytes/string to write.
     */
    function formatChunk(chunk) {
        if (isSSE) {
            var s = (chunk instanceof Buffer) ? chunk.toString('utf8') : String(chunk);
            return 'data: ' + s + '\n\n';
        }
        return (chunk instanceof Buffer) ? chunk : String(chunk);
    }

    // HEAD parity — headers-only, no body, the iterable is never consumed.
    // Every other delegate suppresses the body for HEAD in the render layer
    // (render-json.js is the canonical pattern); this delegate was the lone
    // exception, so a HEAD to a streaming route used to stream a full body.
    // Runs synchronously before the IIFE: no #FI timeline entry is pushed
    // (no stream occurred) and #H10 trailers are skipped (no body to trail).
    if ( local.req && local.req.method && /^HEAD$/i.test(local.req.method) ) {
        if (stream) {
            if ( !stream.destroyed && !stream.closed && !stream.headersSent ) {
                var _headHeaders = {
                    ':status'      : response.statusCode || 200,
                    'content-type' : contentType
                };
                var _headPending = response.getHeaders ? response.getHeaders() : {};
                for (var hk in _headPending) {
                    if ( !(hk in _headHeaders) ) _headHeaders[hk] = _headPending[hk];
                }
                stream.respond(_headHeaders);
            }
            if ( !stream.destroyed && !stream.closed ) stream.end();
        } else {
            if ( !headersSent(response) ) {
                response.setHeader('content-type', contentType);
                response.statusCode = response.statusCode || 200;
            }
            response.end();
        }
        // A stream-like source the caller opened would otherwise leak its
        // handle — it is never iterated on the HEAD path.
        if ( asyncIterable && typeof asyncIterable.destroy === 'function' ) {
            try { asyncIterable.destroy(); } catch (_dErr) { /* best-effort */ }
        }
        // #B357 — see the note at the h2 arm's assignment below.
        try { response.headersSent = true; } catch (_hsErr) { /* getter-only — already true */ }
        local.req = null; local.res = null; local.next = null;
        return;
    }

    // #FI — stream start time for Inspector Flow tab
    var _timeline = local._timeline || null;
    var _streamStart = _timeline ? Date.now() : 0;

    ;(async function _doStream() {
        var chunk;
        try {
            if (stream) {
                // ── HTTP/2 ────────────────────────────────────────────────────────
                if (stream.destroyed || stream.closed) {
                    return;
                }

                if (!stream.headersSent) {
                    var _headers = {
                        // #B351 — never a literal: a hand-built h2 frame must carry the
                        // caller's status, because `setHeader(':status', …)` throws and no
                        // later merge can repair a pseudo-header. Without this, renderStream
                        // can only ever answer 200 — so 206/416 (Range) and 404 are
                        // unreachable on the h2 engine. Same class as #B172 (render-json).
                        ':status'          : response.statusCode || 200,
                        'content-type'     : contentType
                    };
                    // Merge pending response headers set upstream (CORS, cookies,
                    // Content-Range, etc.)
                    var _pending = response.getHeaders ? response.getHeaders() : {};
                    for (var k in _pending) {
                        if (!(k in _headers)) _headers[k] = _pending[k];
                    }
                    // Delegate defaults apply only where the caller has not chosen
                    // a value — a byte-serving caller (#STO1 Range) sets its own
                    // Cache-Control, which the old frame literal silently beat.
                    if ( !('cache-control' in _headers) ) {
                        _headers['cache-control'] = 'no-cache';
                    }
                    if ( !('x-accel-buffering' in _headers) ) {
                        _headers['x-accel-buffering'] = 'no';
                    }
                    // #H10 — when trailers were registered, defer the stream close so the
                    // wantTrailers event can flush them after the final DATA frame.
                    if (_trailers) {
                        stream.once('wantTrailers', function() {
                            try {
                                if (!stream.destroyed && !stream.closed) stream.sendTrailers(_trailers);
                            } catch (_e) { /* trailers are best-effort — never fail the response */ }
                        });
                        stream.respond(_headers, { waitForTrailers: true });
                    } else {
                        stream.respond(_headers);
                    }
                }

                for await (chunk of asyncIterable) {
                    if (stream.destroyed || stream.closed) break;
                    stream.write(formatChunk(chunk));
                }

                if (!stream.destroyed && !stream.closed) stream.end();
                // #B357 — `headersSent` is a getter-only accessor on real
                // ServerResponse / Http2ServerResponse objects, so a bare
                // assignment THROWS under this file's strict mode. The wire was
                // already complete (end() above), but the throw detoured every
                // streaming request through the catch → a swallowed late
                // throwError — and killed the #FI timeline entries below. Real
                // responses already read true here (the getter tracks
                // respond()/end()); the assignment only matters for
                // plain-object test doubles, which stay writable.
                try { response.headersSent = true; } catch (_hs2Err) { /* getter-only — already true */ }

            } else {
                // ── HTTP/1.1 ─────────────────────────────────────────────────────
                if (!headersSent(response)) {
                    response.setHeader('content-type', contentType);
                    // Delegate defaults apply only where the caller has not
                    // already chosen a value (#STO1 Range) — setHeader would
                    // silently clobber a pre-set Cache-Control.
                    var _h1Pending = response.getHeaders ? response.getHeaders() : {};
                    if ( !('cache-control' in _h1Pending) ) {
                        response.setHeader('cache-control', 'no-cache');
                    }
                    if ( !('connection' in _h1Pending) ) {
                        response.setHeader('connection', 'keep-alive');
                    }
                    if ( isSSE && !('x-accel-buffering' in _h1Pending) ) {
                        response.setHeader('x-accel-buffering', 'no');
                    }
                    // #B351 — preserve a status the caller pre-set. The bare assignment
                    // clobbered it, which is worse than the h2 arm's literal: a controller
                    // that had already chosen 206/404 was silently answered 200.
                    response.statusCode = response.statusCode || 200;
                }

                for await (chunk of asyncIterable) {
                    if (response.writableEnded || response.destroyed) break;
                    response.write(formatChunk(chunk));
                }

                if (!response.writableEnded) response.end();
                // #B357 — see the h2 arm's note: guarded, real responses
                // already read true post-end.
                try { response.headersSent = true; } catch (_hs1Err) { /* getter-only — already true */ }
            }

            // #FI — stream response + total timing
            if (_streamStart && _timeline) {
                var _streamEnd = Date.now();
                _timeline.entries.push({
                    label: 'stream-write', cat: 'response',
                    startMs: _streamStart, endMs: _streamEnd,
                    durationMs: _streamEnd - _streamStart,
                    detail: contentType
                });
                _timeline.entries.push({
                    label: 'total', cat: 'total',
                    startMs: _timeline.requestStart,
                    endMs: _streamEnd,
                    durationMs: _streamEnd - _timeline.requestStart,
                    detail: null
                });
            }

        } catch (err) {
            self.throwError(response, 500, err);
        } finally {
            local.req  = null;
            local.res  = null;
            local.next = null;
        }
    })();
};
