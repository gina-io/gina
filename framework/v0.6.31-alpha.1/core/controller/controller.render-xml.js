'use strict';
/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

const lib               = require('./../../lib') || require.cache[require.resolve('./../../lib')];
// #B433 hardening — bind the logger explicitly rather than relying on the
// global lib/routing reassigns at require time (see render-json.js).
var console             = lib.logger;

/**
 * renderXML delegate — sends a pre-serialised XML document.
 *
 * The counterpart to #FIN1's inbound pass-through: gina does not BUILD XML any
 * more than it parses it. The caller serialises with the library of its choice
 * and hands over a string; this delegate owns the wire concerns only —
 * content-type, charset, HEAD suppression, the HTTP/2 vs HTTP/1.1 split, and
 * the per-request lifecycle every delegate shares.
 *
 * Deliberately NOT mirrored from render-json.js, each for a stated reason:
 *
 *  - **Payload-envelope status resolution.** render-json derives the status from
 *    `jsonObj.status` / `jsonObj.errno`. A string body has no envelope, so the
 *    status comes from `response.statusCode` — set upstream by the pipeline or
 *    by the action itself. `self.throwError()` remains the way to answer an error.
 *  - **`#DTO2` response DTOs and the `__ginaQueries` / `__ginaFlow` sidecars.**
 *    Both are JSON-object transforms; there is nowhere in an XML document to put
 *    them that would not corrupt it.
 *  - **The render cache.** Deferred rather than rejected — see the note on
 *    `buildKey` below.
 *
 * @param {string} xmlContent    - The serialised XML document. Coerced via
 *                                 `toString()` when not already a string;
 *                                 null/undefined send an empty body.
 * @param {string} [contentType] - Response Content-Type, default `application/xml`.
 *                                 RFC 7303 §4.1 recommends it over `text/xml`
 *                                 (and `mime['xml']` cannot supply it — core/mime.types
 *                                 declares the `xml` key TWICE, so it resolves to
 *                                 `text/xml`). Pass an explicit type for the
 *                                 suffix family: `application/soap+xml`,
 *                                 `application/atom+xml`, a vendor tree, …
 * @param {object} deps          - Injected by controller: `{ self, local, headersSent }`
 * @returns {void}
 */
module.exports = function renderXML(xmlContent, contentType, deps) {
    // #B63 — per-request deps are FUNCTION-scoped. This module is a shared
    // singleton across concurrent requests in prod; a module-scoped capture is
    // reassigned by every incoming render.
    var self            = deps.self;
    var local           = deps.local;
    var headersSent     = deps.headersSent;

    // Prevent double-render when a controller renders from a required controller
    // (same guard as renderJSON / renderTEXT / renderStream).
    if (local.options.renderingStack.length > 1) {
        return false;
    }
    if ( self.isProcessingError ) {
        return;
    }

    // #B36 — released-response guard. A terminal exit (redirect-then-continue,
    // renderTEXT, throwError) nulls local.req/res/next; the synchronous
    // `local.res.stream` read below would then crash the bundle
    // (uncaughtException → SIGTERM, the #B31/#B33/#B35 class). Placed after the
    // isProcessingError bail and before the first local.res deref, mirroring
    // render-json.js.
    if ( local.res == null ) {
        return;
    }

    var request     = local.req;
    var response    = local.res;
    var next        = local.next || null;
    var stream      = null;
    if ( typeof(local.res.stream) != 'undefined') {
        stream = local.res.stream
    }
    // #H10 — opt-in HTTP/2 response trailers (registered via self.sendTrailers()).
    var _trailers   = (local._trailers && typeof(local._trailers) === 'object') ? local._trailers : null;

    try {
        // The caller owns serialisation. A non-string is coerced rather than
        // rejected (the renderTEXT convention), and null/undefined sends an
        // empty body instead of the string "null" — `toString()` on either
        // would throw, which a render must never do.
        var data;
        if ( typeof(xmlContent) == 'string' ) {
            data = xmlContent;
        } else if ( xmlContent === null || typeof(xmlContent) == 'undefined' ) {
            data = '';
        } else {
            data = xmlContent.toString();
        }

        // No XML declaration is prepended: a `<?xml … encoding="…"?>` emitted by
        // the framework could contradict a charset the caller chose, and the
        // document is the caller's to own — the inbound side is verbatim too.
        var _type = ( typeof(contentType) == 'string' && contentType.trim() !== '' )
                    ? contentType.trim()
                    : 'application/xml';
        var _contentType = _type + '; charset='+ local.options.conf.encoding;

        if ( !headersSent(response) ) {
            response.setHeader('content-type', _contentType);
        }

        console.info(request.method +' ['+ response.statusCode +'] '+ request.url);

        // #FIN6 — record the response envelope for an idempotency-reserved
        // request. Sits at this delegate's single body-resolution point, the
        // sibling of render-json's stringify choke point, so every body-write
        // branch below sees the recorded body. Without it an idempotency-enabled
        // route answering XML would RESERVE and never RECORD: the finish belt
        // would release the reservation and a retry would re-execute.
        // Fire-and-forget — record() owns its own rejection.
        if ( request._idemCapture ) {
            lib.idempotency.record(request, response, data);
        }

        // HEAD: emit the headers the body would have carried (content-length
        // included) and suppress the body itself.
        if ( /^HEAD$/i.test(request.method) ) {
            var headLen = Buffer.byteLength(data, 'utf8');
            if ( stream ) {
                if ( !stream.headersSent ) {
                    var _headH = {
                        'content-type'   : _contentType,
                        'content-length' : headLen,
                        ':status'        : response.statusCode || 200
                    };
                    var _pendingH = response.getHeaders ? response.getHeaders() : {};
                    for (var _hk in _pendingH) {
                        if (!(_hk in _headH)) _headH[_hk] = _pendingH[_hk];
                    }
                    stream.respond(_headH);
                }
                stream.end();
            } else if ( !headersSent(response) ) {
                response.setHeader('content-type', _contentType);
                response.setHeader('content-length', headLen);
                response.end();
            }
            local.req = null;
            local.res = null;
            local.next = null;
            return;
        }

        if ( stream ) {
            // The client may have disconnected before an async action completed;
            // respond() on a destroyed stream throws ERR_HTTP2_INVALID_STREAM.
            if (stream.destroyed || stream.closed) {
                console.warn('[render-xml] Stream already destroyed — client disconnected before response was sent ('+ (request ? request.url : 'unknown') +')');
                local.req = null;
                local.res = null;
                local.next = null;
                return;
            }
            if (!stream.headersSent) {
                var _streamHeaders = {
                    'content-type' : _contentType,
                    // The raw stream.respond() bypasses the compat layer, and
                    // setHeader(':status', …) throws ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED,
                    // so the status must be carried as a pseudo-header here — a
                    // literal 200 would serve every error as 200 (the #B172 lesson).
                    ':status'      : response.statusCode || 200
                };
                // Headers set earlier in the pipeline (CORS, security headers,
                // cache-control) do NOT travel with stream.respond(); fold them in.
                var _pendingHeaders = response.getHeaders ? response.getHeaders() : {};
                for (var _rhk in _pendingHeaders) {
                    if (!(_rhk in _streamHeaders)) _streamHeaders[_rhk] = _pendingHeaders[_rhk];
                }
                // #H10 — register the trailer flush, then defer the close via
                // waitForTrailers so trailers follow the final DATA frame.
                if (_trailers) {
                    stream.once('wantTrailers', function() {
                        try { if (!stream.destroyed && !stream.closed) stream.sendTrailers(_trailers); } catch (_e) { /* best-effort */ }
                    });
                }
                stream.respond(_streamHeaders, _trailers ? { waitForTrailers: true } : undefined);
            }

            stream.end(data);
            response.headersSent = true;
            local.req = null;
            local.res = null;
            local.next = null;
            return;
        }

        // Fallback (HTTP/1.1)
        if (!headersSent(response)) {
            try {
                response.setHeader('content-type', _contentType);
                response.end(data);
                response.headersSent = true;
                // Release per-request refs — response is a local copy, so the
                // .end() above is unaffected.
                local.req = null;
                local.res = null;
                local.next = null;
                return;
            } catch(err) {
                // Ignoring warning
            }
        }
        local.req = null;
        local.res = null;
        local.next = null;

        if ( next ) {
            return next()
        }

        return;

    } catch (err) {
        return self.throwError(response, 500, err);
    }
};
