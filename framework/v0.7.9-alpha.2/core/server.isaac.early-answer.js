/**
 * HTTP/2 early answers on Bun — discarding the body of a request answered before
 * its body is read, and closing its stream once the answer has gone out (#B1076).
 *
 * Over HTTP/2, gina answers some requests before it reads their body: the
 * `/_gina/*` control endpoints and the cross-origin guard in `server.isaac.js`'s
 * request listener, the maintenance gate, and the admin endpoints `core/server.js`
 * answers ahead of routing (`/_gina/storage/gc`, for one). Node.js closes such a
 * stream itself once its answer has gone out; Bun 1.2 and 1.3 keep it open and
 * keep everything the client sends into it, without bound.
 *
 * Closing the stream once the answer has gone out (`RST_STREAM(NO_ERROR)`, which
 * RFC 9113 § 8.1 allows a server that has sent a complete response) bounds that
 * for a client that reads its answer. A client that never reads it (a zero receive
 * window) never lets the answer's writable side finish, so a close waiting for
 * `'finish'` never runs. The body is therefore also discarded as soon as the
 * answer is handed to the stream: the stream's own `'data'` readers are removed
 * (the compatibility request's among them) and the stream is resumed, so what the
 * client sends is read and dropped, and its window granted back, instead of kept.
 * Measured on 2026-11-03 under a zero receive window with 128 MB offered by the
 * client: about 230 MB held by the process on Bun 1.2.21 and 1.3.14 before, about
 * 100 MB, close to its baseline, after; on Bun 1.4.4 the client was held at the
 * stream's flow-control window before, and its body is drained after.
 *
 * The discard goes through the stream, not the compatibility request: a
 * `request.resume()` is undone by a `request.destroy()` that follows the answer,
 * which several stops do — the 431 counted past `upload.maxFieldsSize` on a
 * request with no `content-length`, the 413 past `server.maxBodySize` (#B1071),
 * and a maintenance or instrumentation control body past its 4 KB cap.
 *
 * A static answer is the exception: `core/server.js`'s `handleStatics` discards an
 * armed request's body through the compatibility request
 * ({@link discardThroughRequest}) before any of its answers. No static path destroys
 * its request, so the resume holds there, and the stream-level detach cut a large
 * static read by a slow client: on Bun 1.2.21, a POST with a body to a 600 KB file
 * read by a paused reader ended early in 9 of 26 runs; with the compatibility resume,
 * in none of 16 runs on each of Bun 1.2.21, 1.3.14 and 1.4.4 (measured 2026-11-03).
 *
 * Which requests are armed:
 *
 * - Bun only, picked by RUNTIME at load ({@link RUNTIME_IS_BUN}, the #B615 rule:
 *   never by version, never by probing a stream). On Node.js nothing is armed:
 *   Node closes a never-read stream itself, its compatibility response always
 *   waits for trailers (a close at `'finish'` drops them), and `respondWithFile()`
 *   finishes its writable side before the file is sent (a close at `'finish'`
 *   there cut a static file to 0 B and ended the process on Node 26).
 * - A request whose body may still come (`stream.endAfterHeaders !== true`): a
 *   GET or a HEAD without a body is never armed.
 *
 * What an armed request does:
 *
 * - When an answer is handed to its stream (`stream.respond()`, which the
 *   compatibility response calls too) while {@link keepOpen} has not been called,
 *   the body is discarded ({@link discard}).
 * - When the answer's writable side finishes while {@link keepOpen} has not been
 *   called, the stream is closed with `NGHTTP2_NO_ERROR`.
 * - A static answer discards through the compatibility request first
 *   ({@link discardThroughRequest}), so the hook's {@link discard} then finds the
 *   body discarded and does nothing.
 *
 * {@link keepOpen} is called by every answer that reads its body or stays open by
 * design, before it answers: `core/server.js` from its non-static branch (the body
 * is read and the router owns the answer from there; its parse-time stops discard
 * through `closeStreamAfterAnswer`). The three server-sent-event endpoints of
 * `server.isaac.js` set the same property inline
 * (`request._ginaStreamKeepOpen = true`), which keeps each handler block
 * self-contained. An armed binary static is sent buffered by `core/server.js`
 * ({@link isArmed}): `respondWithFile()` finishes before the file's bytes, so a
 * close at its `'finish'` would cut the file.
 *
 * Framework-free on purpose, like `server.isaac.rapid-reset`: it is unit-tested on
 * both runtime rules with a stand-in stream, which `server.isaac.js` (loading the
 * lib registry at require time) cannot be. Its one dependency, `utils/runtime`, is
 * a dependency-free leaf at the package root.
 *
 * @module core/server.isaac.early-answer
 */
'use strict';

/**
 * The `RST_STREAM` code of the close (`0`, no error): the answer went out whole.
 *
 * @constant {number}
 */
var NGHTTP2_NO_ERROR = require('http2').constants.NGHTTP2_NO_ERROR;

/**
 * Whether this process runs on Bun — decided once at load. The early-answer hooks
 * are needed on Bun and wrong on Node.js (module header), so they are picked by
 * RUNTIME, never by feature-probing a stream (the #B615 rule).
 *
 * @constant {boolean}
 */
var RUNTIME_IS_BUN = require(__dirname + '/../../../utils/runtime').isBun();

/**
 * Marks a request whose body is read, or whose stream stays open by design, from
 * here on: an armed request's hooks then neither discard its body nor close its
 * stream. Call it before the answer is handed to the stream.
 *
 * Harmless on a request that was never armed (Node.js, HTTP/1.1, a request with
 * no body).
 *
 * @param {object} request - The compatibility request
 * @returns {void}
 *
 * @example
 * // core/server.js, where the body read starts and the router owns the answer:
 * earlyAnswer.keepOpen(request);
 * // the same, inline: a server-sent-event endpoint, before its 200 goes out:
 * request._ginaStreamKeepOpen = true;
 * response.stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
 */
function keepOpen(request) {
    if ( request ) {
        request._ginaStreamKeepOpen = true;
    }
}

/**
 * Whether {@link arm} armed this request: Bun, an HTTP/2 stream, and a body that
 * may still come.
 *
 * @param {object} request - The compatibility request
 * @returns {boolean} `true` when the request is armed
 *
 * @example
 * // core/server.js, an HTTP/2 binary static:
 * if ( isBinary && earlyAnswer.isArmed(request) ) {
 *     // send it buffered: the close at 'finish' must follow the bytes
 * } else if ( isBinary ) {
 *     stream.respondWithFile(filename, header);
 * }
 */
function isArmed(request) {
    return !!( request && request._ginaStreamCloseArmed === true );
}

/**
 * Discards what the client still sends on an armed request's stream: its `'data'`
 * readers are removed (the compatibility request's among them) and the stream is
 * resumed, so the bytes are read and dropped and the client's window is granted
 * back. Once per request.
 *
 * Called by the {@link arm} hook when an early answer is handed to the stream, and
 * by `core/server.js`'s `closeStreamAfterAnswer` when a parse-time stop (#B1071)
 * answers a request whose body it no longer reads.
 *
 * @param {object} request - The compatibility request
 * @returns {boolean} `true` when the body is now discarded; `false` when the
 *   request is not armed, was already discarded, or its stream is closed or
 *   destroyed
 *
 * @example
 * // an armed request (Bun), answered before its body was read in full:
 * earlyAnswer.discard(request); // true: what the client still sends is read and dropped
 * earlyAnswer.discard(request); // false: once per request
 * // a request that was never armed (Node.js, HTTP/1.1, no body):
 * earlyAnswer.discard(request); // false: nothing is done
 */
function discard(request) {
    if ( !isArmed(request) || request._ginaBodyDiscarded === true ) {
        return false;
    }
    var stream = request.stream;
    if ( !stream || stream.closed || stream.destroyed ) {
        return false;
    }
    request._ginaBodyDiscarded = true;
    try {
        stream.removeAllListeners('data');
        stream.resume();
    } catch (streamGone) {
        // the stream went away between the checks and the calls: nothing is left to discard
    }
    return true;
}

/**
 * Discards what the client still sends on an armed request through its
 * compatibility request instead: the request is resumed, so the runtime reads the
 * bytes and drops them, and the stream's own `'data'` readers stay in place. Marks
 * the body discarded, so {@link discard} does nothing afterwards. Once per request.
 *
 * Called by `core/server.js`'s `handleStatics` before any of its answers: no static
 * path destroys its request (a `request.destroy()` after the answer would undo the
 * resume), and the stream-level detach of {@link discard} cut a large static read by
 * a slow client on Bun 1.2.21.
 *
 * @param {object} request - The compatibility request
 * @returns {boolean} `true` when the body is now discarded through the request;
 *   `false` when the request is not armed or its body was already discarded
 *
 * @example
 * // core/server.js, handleStatics, an armed POST to a static file, before its answer:
 * earlyAnswer.discardThroughRequest(request); // true: the body is read and dropped from now on
 * earlyAnswer.discard(request);               // false: already discarded
 * // a request that was never armed (Node.js, HTTP/1.1, no body):
 * earlyAnswer.discardThroughRequest(request); // false: nothing is done
 */
function discardThroughRequest(request) {
    if ( !isArmed(request) || request._ginaBodyDiscarded === true ) {
        return false;
    }
    request._ginaBodyDiscarded = true;
    try {
        request.resume();
    } catch (requestGone) {
        // the request went away before the call: nothing is left to discard
    }
    return true;
}

/**
 * Arms the early-answer hooks on one HTTP/2 request (module header): on Bun, for a
 * request whose body may still come, an answer handed to its stream before
 * {@link keepOpen} discards the body ({@link discard}), and the stream closes with
 * `NGHTTP2_NO_ERROR` once that answer's writable side has finished. Once per
 * request; a second call changes nothing.
 *
 * Call it at the top of the engine's request listener, before any answer.
 *
 * @param {object}  request - The compatibility request; `request.stream` is the
 *   server stream over HTTP/2
 * @param {boolean} isBun   - Whether the hooks apply: {@link RUNTIME_IS_BUN} in the
 *   engine, injectable so a test can drive both runtime rules
 * @returns {boolean} `true` when the request is armed; `false` otherwise (Node.js,
 *   HTTP/1.1, or a request whose body ended with its headers), and nothing is done
 *
 * @example
 * server.on('request', function (request, response) {
 *     earlyAnswer.arm(request, earlyAnswer.RUNTIME_IS_BUN);
 *     // an early answer: on Bun its body is discarded, and its stream closes once
 *     // the answer has gone out
 *     response.writeHead(403);
 *     response.end();
 * });
 */
function arm(request, isBun) {
    if ( isBun !== true ) {
        return false;
    }
    var stream = ( request && request.stream ) ? request.stream : null;
    if ( !stream || typeof(stream.close) != 'function' || typeof(stream.respond) != 'function' ) {
        return false;
    }
    if ( stream.endAfterHeaders === true ) {
        return false;
    }
    if ( isArmed(request) ) {
        return true;
    }
    request._ginaStreamCloseArmed = true;

    var respond = stream.respond;
    stream.respond = function respondThenDiscard() {
        var sent = respond.apply(this, arguments);
        if ( request._ginaStreamKeepOpen !== true ) {
            discard(request);
        }
        return sent;
    };
    stream.once('finish', function closeAfterEarlyAnswer() {
        if ( request._ginaStreamKeepOpen !== true && !stream.closed && !stream.destroyed ) {
            stream.close(NGHTTP2_NO_ERROR);
        }
    });
    return true;
}

module.exports = {
    NGHTTP2_NO_ERROR : NGHTTP2_NO_ERROR,
    RUNTIME_IS_BUN   : RUNTIME_IS_BUN,
    keepOpen         : keepOpen,
    isArmed          : isArmed,
    discard          : discard,
    discardThroughRequest : discardThroughRequest,
    arm              : arm
};
