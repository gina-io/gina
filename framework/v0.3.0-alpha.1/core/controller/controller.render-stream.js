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
 * Buffers. Object chunks are coerced via String(); Buffer chunks are decoded
 * as UTF-8.
 *
 * HTTP/2: uses stream.respond() + stream.write() + stream.end()
 * HTTP/1.1: uses response.setHeader() + response.write() + response.end()
 *
 * In both cases all pending response headers set upstream (CORS, etc.) are
 * preserved and merged into the initial headers frame.
 *
 * @param {AsyncIterable} asyncIterable  Source of string/Buffer chunks
 * @param {string}        contentType    Response Content-Type (default: text/event-stream)
 * @param {object}        deps           Injected by controller: { self, local, headersSent }
 */

var self, local, headersSent;

module.exports = function renderStream(asyncIterable, contentType, deps) {

    self        = deps.self;
    local       = deps.local;
    headersSent = deps.headersSent;

    // Prevent double-render (same guard used by renderJSON / renderTEXT)
    if (local.options.renderingStack.length > 1) return false;
    if (self.isProcessingError) return;

    var response = local.res;
    var stream   = (typeof(response.stream) !== 'undefined') ? response.stream : null;

    if (headersSent(response)) {
        local.req = null; local.res = null; local.next = null;
        return;
    }

    contentType = contentType || 'text/event-stream';
    var isSSE   = /text\/event-stream/i.test(contentType);

    function formatChunk(chunk) {
        var s = (chunk instanceof Buffer) ? chunk.toString('utf8') : String(chunk);
        return isSSE ? 'data: ' + s + '\n\n' : s;
    }

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
                        ':status'          : 200,
                        'content-type'     : contentType,
                        'cache-control'    : 'no-cache',
                        'x-accel-buffering': 'no'
                    };
                    // Merge pending response headers set upstream (CORS, cookies, etc.)
                    var _pending = response.getHeaders ? response.getHeaders() : {};
                    for (var k in _pending) {
                        if (!(k in _headers)) _headers[k] = _pending[k];
                    }
                    stream.respond(_headers);
                }

                for await (chunk of asyncIterable) {
                    if (stream.destroyed || stream.closed) break;
                    stream.write(formatChunk(chunk));
                }

                if (!stream.destroyed && !stream.closed) stream.end();
                response.headersSent = true;

            } else {
                // ── HTTP/1.1 ─────────────────────────────────────────────────────
                if (!headersSent(response)) {
                    response.setHeader('content-type', contentType);
                    response.setHeader('cache-control', 'no-cache');
                    response.setHeader('connection', 'keep-alive');
                    if (isSSE) response.setHeader('x-accel-buffering', 'no');
                    response.statusCode = 200;
                }

                for await (chunk of asyncIterable) {
                    if (response.writableEnded || response.destroyed) break;
                    response.write(formatChunk(chunk));
                }

                if (!response.writableEnded) response.end();
                response.headersSent = true;
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
