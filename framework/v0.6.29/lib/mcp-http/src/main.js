/**
 * @module gina/lib/mcp-http
 *
 * Model Context Protocol Streamable HTTP transport. Spec revision 2025-06-18.
 *
 * Responsibilities:
 *  - Bind an HTTP server to a host/port and accept JSON-RPC 2.0 over POST.
 *  - Negotiate `application/json` vs `text/event-stream` via `Accept`.
 *  - Support batch requests (JSON-RPC 2.0 array).
 *  - Emit `Mcp-Session-Id` on `initialize` responses; echo when provided.
 *  - Enforce a body-size cap (413 on overflow).
 *  - Return 405 for GET / DELETE (no server-initiated streams in v1).
 *  - Validate the `Origin` header against an allowlist (DNS rebinding
 *    mitigation per MCP spec §Security).
 *  - Enforce a static bearer token when `authToken` is configured.
 *  - Refuse to start, token-less, once an ambient protection has been removed
 *    (non-loopback bind, or a wildcard Origin allowlist) unless `allowInsecure`.
 *  - Emit full CORS response headers (`access-control-allow-origin` +
 *    `vary: Origin`, or `*` when wildcard allowlist is in effect).
 *
 * Out of scope (Session 3):
 *  - CLI wiring on `bundle:mcp-start` (`--transport=http` flag, manifest
 *    precedence, `host_v4` fallback).
 *
 * The transport consumes an `mcpServer` instance that exposes
 * `handleMessage(raw) → Promise<string|null>`. All JSON-RPC framing and
 * lifecycle logic lives there; this module owns only the wire.
 */

'use strict';

var http   = require('http');
var crypto = require('crypto');

var DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

// Header value advertised on 401 responses and in preflight allow-headers.
var BEARER_REALM = 'MCP';


/**
 * True only when `h` is unambiguously a loopback bind address, i.e. when
 * binding it cannot make the transport reachable from another host.
 *
 * Deliberately fail-closed: anything this cannot positively recognise as
 * loopback (a hostname, `0.0.0.0`, `::`, a LAN address) is treated as exposed,
 * because guessing wrong in that direction is the expensive mistake.
 *
 * Recognised: `localhost`, `::1` (bracketed or bare), the whole `127.0.0.0/8`
 * block, and IPv4-mapped forms such as `::ffff:127.0.0.1`.
 *
 * @param   {string} h - a bind host as handed to `server.listen()`.
 * @returns {boolean}
 * @inner
 * @private
 */
function isLoopbackBind(h) {
    if (typeof(h) !== 'string') return false;
    var v = h.trim().toLowerCase();
    if (v.charAt(0) === '[' && v.charAt(v.length - 1) === ']') {
        v = v.substring(1, v.length - 1);
    }
    if (v === 'localhost' || v === '::1') return true;
    if (v.indexOf('::ffff:') === 0) {
        v = v.substring(7);         // IPv4-mapped IPv6 — fall through to the v4 test
    }
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
    if (!m) return false;
    for (var i = 1; i <= 4; ++i) {
        if (Number(m[i]) > 255) return false;
    }
    return Number(m[1]) === 127;
}


/**
 * Creates an HTTP transport bound to an mcp-server instance. Returns a
 * controller with `start()`, `stop()`, and `address()`.
 *
 * @param   {object}    opts
 * @param   {object}    opts.mcpServer          - Instance from mcpServer.createServer
 * @param   {string}    [opts.host='127.0.0.1'] - Bind host
 * @param   {number}    [opts.port=0]           - Bind port (0 = OS-assigned)
 * @param   {number}    [opts.maxBodyBytes]     - Cap on POST body size
 * @param   {string}    [opts.authToken]        - If set, `Authorization: Bearer <token>`
 *                                                is required on every non-OPTIONS request.
 *                                                Compared in constant time, sha256-hashed
 *                                                on both sides. When omitted the transport
 *                                                leans on its ambient protections (loopback
 *                                                bind + Origin allowlist) and REFUSES to
 *                                                start if either has been deliberately
 *                                                removed — see `opts.allowInsecure`.
 * @param   {boolean}   [opts.allowInsecure]    - Strict boolean. Set `true` to run
 *                                                token-less even with an ambient protection
 *                                                removed (non-loopback bind, or a wildcard
 *                                                Origin allowlist). Assert this only when
 *                                                access is restricted upstream — a service
 *                                                mesh, a NetworkPolicy, or an
 *                                                authenticating reverse proxy.
 * @param   {string[]}  [opts.allowedOrigins]   - Additional origins to accept beyond the
 *                                                built-in loopback allowlist
 *                                                (`http(s)://localhost`, `http(s)://127.0.0.1`,
 *                                                `http(s)://[::1]`, any port). Use `['*']`
 *                                                to disable the Origin check entirely.
 * @param   {function}  [opts.onError]          - (err) => void, for transport logs
 * @returns {{start: function, stop: function, address: function}}
 *
 * @example
 *   var transport = createHttpTransport({
 *       mcpServer: server,
 *       port: 3107,
 *       authToken: 'secret',
 *       allowedOrigins: ['http://mcp-inspector.example.com']
 *   });
 *   transport.start().then(function (info) {
 *       console.log('listening on', info.host + ':' + info.port);
 *   });
 */
function createHttpTransport(opts) {

    if (!opts || typeof(opts) !== 'object') {
        throw new Error('createHttpTransport: opts is required');
    }
    if (!opts.mcpServer || typeof(opts.mcpServer.handleMessage) !== 'function') {
        throw new Error('createHttpTransport: opts.mcpServer.handleMessage must be a function');
    }

    var mcpServer     = opts.mcpServer;
    var host          = opts.host || '127.0.0.1';
    var port          = (typeof(opts.port) === 'number') ? opts.port : 0;
    var maxBodyBytes  = (typeof(opts.maxBodyBytes) === 'number' && opts.maxBodyBytes > 0)
                        ? opts.maxBodyBytes
                        : DEFAULT_MAX_BODY_BYTES;
    var authToken     = (typeof(opts.authToken) === 'string' && opts.authToken.length) ? opts.authToken : null;
    var extraOrigins  = Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins.slice() : [];
    var originWildcard = (extraOrigins.indexOf('*') !== -1);
    var allowInsecure = (opts.allowInsecure === true);
    var onError       = (typeof(opts.onError) === 'function') ? opts.onError : function() {};

    // Digest the configured token ONCE, here, rather than per request: the
    // compare in `isAuthed` then runs over two fixed-length (32-byte) buffers,
    // so it can neither throw nor leak the token's length. Mirrors the
    // boot-precomputed key hashes in `lib/authz-gate` (`verifyMachineToken`).
    var authTokenHash = authToken
        ? crypto.createHash('sha256').update(authToken, 'utf8').digest()
        : null;

    var httpServer = null;


    // -----------------------------------------------------------------------
    // Security: Origin allowlist + static bearer
    // -----------------------------------------------------------------------

    /**
     * True when a specific origin string should be treated as allowed.
     * Loopback hostnames (`localhost`, `127.0.0.1`, `::1`) on `http:`/`https:`
     * schemes pass regardless of port — that covers the common dev case
     * (MCP Inspector on `http://localhost:<random-port>`, browser dev tools).
     *
     * @private
     */
    function isOriginAllowedString(origin) {
        if (extraOrigins.indexOf(origin) !== -1) return true;
        var parsed;
        try { parsed = new URL(origin); }
        catch (e) { return false; }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        // WHATWG URL keeps IPv6 hostnames bracketed (`[::1]`); accept both
        // forms so we don't drop a legitimate `http://[::1]:8080` origin.
        var h = parsed.hostname;
        return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    }

    /**
     * True when the request should pass the Origin gate. No `Origin` header
     * (non-browser clients — curl, CLI tools, desktop MCP hosts) passes.
     * Wildcard allowlist (`*`) passes everything.
     *
     * @private
     */
    function isOriginAllowed(req) {
        var origin = req.headers['origin'];
        if (!origin) return true;
        if (originWildcard) return true;
        return isOriginAllowedString(origin);
    }


    /**
     * True when the request carries a valid bearer (or no token is configured).
     *
     * Both sides are sha256-hashed before the constant-time compare, so the two
     * buffers are always 32 bytes. That removes the length short-circuit this
     * used to need — comparing the raw tokens meant returning early on a length
     * mismatch (`timingSafeEqual` throws on unequal lengths), which leaked the
     * configured token's length through response timing. The try/catch is kept
     * as the house idiom even though two same-length digests cannot throw.
     *
     * @private
     */
    function isAuthed(req) {
        if (!authToken) return true;
        var header = req.headers['authorization'] || '';
        var m = /^Bearer\s+(.+)$/i.exec(header);
        if (!m) return false;
        var presented     = m[1].trim();
        var presentedHash = crypto.createHash('sha256').update(presented, 'utf8').digest();
        try { return crypto.timingSafeEqual(presentedHash, authTokenHash); }
        catch (e) { return false; }
    }


    /**
     * Describes the ambient protection the operator has removed, when running
     * without a bearer token — or `null` when the transport is adequately
     * protected (or `allowInsecure` waives the requirement).
     *
     * Two protections make a token-less transport defensible, and losing EITHER
     * is enough to need one:
     *  - the loopback bind, which keeps other hosts out entirely;
     *  - the Origin allowlist, which is the only thing standing between a
     *    loopback-bound server and a DNS-rebinding attack driven from any web
     *    page (the bind does not help there — the browser is already local).
     *
     * @returns {string|null} the reason, phrased for an operator-facing error.
     * @private
     */
    function describeExposure() {
        if (authToken || allowInsecure) return null;
        if (!isLoopbackBind(host)) {
            return 'it is bound to the non-loopback address `'+ host +'`';
        }
        if (originWildcard) {
            return 'the Origin allowlist is disabled (`allowedOrigins: ["*"]`)';
        }
        return null;
    }


    /**
     * Merges CORS response headers into a base header bag. Safe to call even
     * when there is no `Origin` on the request — returns the base bag unchanged
     * in that case.
     *
     * @private
     */
    function mergeCorsHeaders(req, baseHeaders) {
        var origin = req.headers['origin'];
        if (!origin) return baseHeaders;
        if (originWildcard) {
            baseHeaders['access-control-allow-origin'] = '*';
            return baseHeaders;
        }
        if (isOriginAllowedString(origin)) {
            baseHeaders['access-control-allow-origin'] = origin;
            baseHeaders['vary'] = 'Origin';
        }
        return baseHeaders;
    }


    // -----------------------------------------------------------------------
    // Request dispatch
    // -----------------------------------------------------------------------

    /**
     * Node `request` event handler. Ordering:
     *   OPTIONS preflight   → writePreflight, bypassing origin/auth gates
     *   Origin gate         → 403 if the origin is disallowed
     *   Bearer gate         → 401 if authToken is set and token doesn't match
     *   Method routing      → 405 for GET/DELETE/others, POST falls through
     *
     * @private
     */
    function handleHttpRequest(req, res) {

        var method = req.method;

        if (method === 'OPTIONS') {
            return writePreflight(req, res);
        }

        if (!isOriginAllowed(req)) {
            return writeForbiddenOrigin(req, res);
        }

        if (!isAuthed(req)) {
            return writeUnauthorized(req, res);
        }

        if (method === 'GET' || method === 'DELETE') {
            return writeMethodNotAllowed(req, res, method);
        }

        if (method !== 'POST') {
            return writeMethodNotAllowed(req, res, method);
        }

        readBodyAndProcess(req, res);
    }


    /**
     * CORS preflight response. When the request Origin is allowed (or wildcard
     * is in effect), echoes it in `access-control-allow-origin`. When it's
     * not, we still respond 204 with the methods / headers advertisement but
     * omit `access-control-allow-origin` — the browser then denies the actual
     * request, which is the correct CORS outcome. OPTIONS never enforces the
     * bearer (preflight cannot carry auth headers).
     *
     * @private
     */
    function writePreflight(req, res) {
        var headers = {
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version',
            'access-control-max-age':       '600'
        };
        var origin = req.headers['origin'];
        if (origin) {
            if (originWildcard) {
                headers['access-control-allow-origin'] = '*';
            } else if (isOriginAllowedString(origin)) {
                headers['access-control-allow-origin'] = origin;
                headers['vary'] = 'Origin';
            }
        }
        res.writeHead(204, headers);
        res.end();
    }


    /**
     * 403 response for a disallowed Origin. Intentionally does NOT echo CORS
     * headers — doing so would defeat the purpose of the rejection.
     *
     * @private
     */
    function writeForbiddenOrigin(req, res) {
        var origin = req.headers['origin'] || '(none)';
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            jsonrpc: '2.0',
            id:      null,
            error:   {
                code:    -32600,
                message: 'Origin not allowed: ' + origin
            }
        }));
    }


    /**
     * 401 response for missing or invalid bearer. Includes `WWW-Authenticate`
     * per RFC 6750 and still echoes CORS so browser clients can read the
     * error body. The JSON-RPC envelope gives a human-readable reason; the
     * HTTP status + `WWW-Authenticate` gives the machine-readable one.
     *
     * @private
     */
    function writeUnauthorized(req, res) {
        var headers = mergeCorsHeaders(req, {
            'content-type':     'application/json; charset=utf-8',
            'www-authenticate': 'Bearer realm="' + BEARER_REALM + '"'
        });
        res.writeHead(401, headers);
        res.end(JSON.stringify({
            jsonrpc: '2.0',
            id:      null,
            error:   {
                code:    -32600,
                message: 'Missing or invalid Bearer token'
            }
        }));
    }


    /**
     * 405 Method Not Allowed + JSON-RPC error body. Includes CORS echo so a
     * browser client making a mistaken GET sees the error detail.
     *
     * @private
     */
    function writeMethodNotAllowed(req, res, method) {
        var msg = 'Method not allowed: ' + method + '. MCP Streamable HTTP exposes only POST in this server.';
        var headers = mergeCorsHeaders(req, {
            'content-type': 'application/json; charset=utf-8',
            'allow':        'POST'
        });
        res.writeHead(405, headers);
        res.end(JSON.stringify({
            jsonrpc: '2.0',
            id:      null,
            error:   { code: -32600, message: msg }
        }));
    }


    /**
     * Accumulates the POST body up to `maxBodyBytes`, then hands off to
     * processBody. Sends 413 and closes the connection on overflow.
     *
     * @private
     */
    function readBodyAndProcess(req, res) {

        var received = 0;
        var chunks   = [];
        var aborted  = false;

        req.on('data', function(chunk) {
            if (aborted) return;
            received += chunk.length;
            if (received > maxBodyBytes) {
                aborted = true;
                var headers = mergeCorsHeaders(req, {
                    'content-type': 'application/json; charset=utf-8'
                });
                res.writeHead(413, headers);
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id:      null,
                    error:   {
                        code:    -32600,
                        message: 'Request body exceeds limit of ' + maxBodyBytes + ' bytes'
                    }
                }));
                // Signal the client to stop sending. Already responded.
                try { req.destroy(); } catch (e) { /* ignore */ }
            } else {
                chunks.push(chunk);
            }
        });

        req.on('end', function() {
            if (aborted) return;
            var body = Buffer.concat(chunks).toString('utf8');
            processBody(req, res, body);
        });

        req.on('error', function(err) {
            if (aborted) return;
            aborted = true;
            onError(err);
            try { res.destroy(); } catch (e) { /* ignore */ }
        });
    }


    /**
     * Parses the body, dispatches each JSON-RPC frame through
     * `mcpServer.handleMessage`, and writes the HTTP response in the shape
     * negotiated by the `Accept` header.
     *
     * @private
     */
    function processBody(req, res, body) {

        var acceptHeader    = req.headers['accept'] || '';
        var wantsSse        = /text\/event-stream/i.test(acceptHeader);
        var clientSessionId = req.headers['mcp-session-id'] || null;

        var parsed;
        try {
            parsed = JSON.parse(body);
        } catch (parseErr) {
            // Malformed JSON — surface as a JSON-RPC parse error frame.
            // HTTP stays 200; the error lives in the JSON-RPC envelope.
            var errFrame = JSON.stringify({
                jsonrpc: '2.0',
                id:      null,
                error:   { code: -32700, message: 'Parse error: ' + parseErr.message }
            });
            if (wantsSse) {
                return writeSseFrames(req, res, [errFrame], clientSessionId);
            }
            return writeJsonFrame(req, res, errFrame, clientSessionId);
        }

        var isBatch = Array.isArray(parsed);
        var frames  = isBatch ? parsed : [parsed];

        // initialize in any frame triggers session-id generation when the
        // client didn't supply one. Per MCP spec, the server assigns the
        // session id on the initialize response.
        var hasInitialize = false;
        for (var i = 0; i < frames.length; i++) {
            if (frames[i] && frames[i].method === 'initialize') {
                hasInitialize = true;
                break;
            }
        }
        var responseSessionId = clientSessionId
            || (hasInitialize ? crypto.randomUUID() : null);

        var dispatches = frames.map(function(frame) {
            // handleMessage expects a raw frame string. Re-serialise each entry
            // so the server sees a consistent shape, regardless of whether we
            // came from a single-frame POST or a batch.
            return mcpServer.handleMessage(JSON.stringify(frame));
        });

        Promise.all(dispatches).then(function(responses) {

            var nonNull = [];
            for (var j = 0; j < responses.length; j++) {
                if (responses[j] != null) nonNull.push(responses[j]);
            }

            if (nonNull.length === 0) {
                // All frames were notifications — spec says 202 Accepted, no body.
                var headers = mergeCorsHeaders(req, {});
                if (responseSessionId) headers['mcp-session-id'] = responseSessionId;
                res.writeHead(202, headers);
                return res.end();
            }

            if (wantsSse) {
                return writeSseFrames(req, res, nonNull, responseSessionId);
            }

            if (isBatch) {
                // JSON-RPC batch response is an array of response frames.
                // Each frame is already a JSON string from handleMessage.
                var arrayBody = '[' + nonNull.join(',') + ']';
                return writeJsonFrame(req, res, arrayBody, responseSessionId);
            }

            return writeJsonFrame(req, res, nonNull[0], responseSessionId);

        }, function(err) {
            // handleMessage always resolves — this is defensive.
            onError(err);
            try {
                var headers = mergeCorsHeaders(req, {
                    'content-type': 'application/json; charset=utf-8'
                });
                res.writeHead(500, headers);
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id:      null,
                    error:   { code: -32603, message: 'Internal error' }
                }));
            } catch (writeErr) { /* response already sent */ }
        });
    }


    /**
     * Writes a single JSON response frame (object or array-as-string) with
     * content-length, CORS, and optional session-id header.
     *
     * @private
     */
    function writeJsonFrame(req, res, frameBody, sessionId) {
        var headers = mergeCorsHeaders(req, {
            'content-type':   'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(frameBody, 'utf8')
        });
        if (sessionId) headers['mcp-session-id'] = sessionId;
        res.writeHead(200, headers);
        res.end(frameBody);
    }


    /**
     * Writes N frames as SSE `event: message` events, then closes the stream.
     * No resumability in v1 — the stream ends as soon as every response frame
     * for the triggering POST has been flushed.
     *
     * @private
     */
    function writeSseFrames(req, res, frames, sessionId) {
        var headers = mergeCorsHeaders(req, {
            'content-type':  'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'connection':    'keep-alive'
        });
        if (sessionId) headers['mcp-session-id'] = sessionId;
        res.writeHead(200, headers);
        for (var i = 0; i < frames.length; i++) {
            res.write('event: message\ndata: ' + frames[i] + '\n\n');
        }
        res.end();
    }


    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Starts the HTTP listener. Rejects if called twice. Resolves with the
     * resolved { host, port, family } — `port` is the OS-assigned port when
     * `opts.port` was 0.
     *
     * Also rejects, BEFORE binding, when the transport would be exposed without
     * a bearer token (see `describeExposure`). Refusing here rather than
     * answering 401 per request is the framework's house answer for a security
     * control that would otherwise sit silently inert: nothing ever listens, so
     * there is no window in which an unauthenticated port is reachable.
     *
     * @returns {Promise<{host: string, port: number, family: string}>}
     */
    function start() {
        return new Promise(function(resolve, reject) {
            if (httpServer) {
                return reject(new Error('start: transport already started'));
            }
            var exposure = describeExposure();
            if (exposure) {
                return reject(new Error(
                    'start: refusing to listen without a bearer token because '+ exposure +'. '
                  + 'Configure a token, or set `allowInsecure` to assert that access is '
                  + 'restricted upstream (service mesh, NetworkPolicy, authenticating proxy).'
                ));
            }
            var server = http.createServer(handleHttpRequest);
            var onListenError = function(err) { reject(err); };
            server.once('error', onListenError);
            server.listen(port, host, function() {
                server.removeListener('error', onListenError);
                server.on('error', function(err) { onError(err); });
                httpServer = server;
                var addr = server.address();
                resolve({ host: addr.address, port: addr.port, family: addr.family });
            });
        });
    }


    /**
     * Stops the HTTP listener. Resolves once every in-flight request has
     * finished. Idempotent — calling stop() before start() or twice is a no-op.
     *
     * HTTP keep-alive would otherwise hold `server.close()` open for the full
     * keepAliveTimeout (Node default ~5s) even when no request is in flight.
     * Two levers combined drop that:
     *   - `closeIdleConnections()` drops sockets that are idle at stop time.
     *   - `keepAliveTimeout = 1` ensures any socket that becomes idle after
     *     its current response finishes also closes immediately.
     * Active requests still drain normally.
     *
     * @returns {Promise<void>}
     */
    function stop() {
        return new Promise(function(resolve) {
            if (!httpServer) return resolve();
            var toClose = httpServer;
            httpServer = null;
            toClose.keepAliveTimeout = 1;
            toClose.close(function() { resolve(); });
            if (typeof(toClose.closeIdleConnections) === 'function') {
                toClose.closeIdleConnections();
            }
        });
    }


    /**
     * Returns the current bind address, or null when not listening.
     *
     * @returns {{host: string, port: number, family: string}|null}
     */
    function address() {
        if (!httpServer) return null;
        var a = httpServer.address();
        if (!a) return null;
        return { host: a.address, port: a.port, family: a.family };
    }


    return {
        start:   start,
        stop:    stop,
        address: address
    };
}


module.exports = {
    createHttpTransport:    createHttpTransport,
    DEFAULT_MAX_BODY_BYTES: DEFAULT_MAX_BODY_BYTES
};
