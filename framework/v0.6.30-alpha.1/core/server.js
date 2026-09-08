'use strict';
/**
 * @module gina/core/server
 */
/**
 * Orchestrates the HTTP/HTTPS/HTTP2 server lifecycle for a Gina bundle.
 * Loads routing, initialises the Swig template engine, wires the request
 * pipeline (statics, preflight, middleware, routing), and emits `'configured'`
 * once the server engine is ready.
 *
 * Supports three engine backends selected by `options.conf` server settings:
 * - `engine: 'isaac'` — built-in Gina HTTP/HTTP2 engine (`server.isaac.js`)
 * - `engine: 'express'` — Express.js adapter (`server.express.js`)
 * - default (no engine) — bare Node.js `http`/`https`/`http2`
 *
 * @class Server
 * @constructor
 * @param {object} options - Server initialisation options
 * @param {string} options.projectName - Project name
 * @param {string} options.bundle - Bundle name being started
 * @param {string} options.env - Active environment name
 * @param {string} options.scope - Active scope name
 * @param {boolean} options.isStandalone - When true, multiple bundles share one server port
 * @param {string[]} options.bundles - All bundle names in the project
 * @param {string} options.executionPath - Project root path
 * @param {object} options.conf - Merged env configuration object
 */
//Imports.
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const EventEmitter  = require('events').EventEmitter;
// Swig is now resolved through lib.swigResolver so a project can opt into
// a pinned @rhinostone/swig (or @rhinostone/swig-twig) via
// settings.json > swig.useProject. Default-off: the resolver falls back to
// the framework's require('@rhinostone/swig') whenever the flag is absent
// or a safety gate rejects the project's pin. The module is cached on
// process.gina._swig after the first call; `swig` below resolves to the
// framework default when no bundle has loaded yet.
// Busboy is consumed from npm as @rhinostone/busboy — a strict superset of the
// dormant upstream busboy@1.6.0 whose only addition is `info.dispositionParams`
// (each part's parsed Content-Disposition params), which is what lets the
// upload handler below read the `group="…"` tag. It replaces the former
// vendored copy at core/deps/busboy-1.6.0, which carried the same capability as
// a local patch that had to be re-applied on every upstream upgrade.
// was: const Busboy = require('./deps/busboy-1.6.0');
const Busboy        = require('@rhinostone/busboy');
const Stream        = require('stream');
const util          = require('util');
const crypto        = require('crypto');
var https           = require('https');
// ssl-checker dependency removed in 0.3.1 — replaced by inline verifyCertificate().

// #M12b — per-request log context (requestId / durationMs in JSON logs).
// Active ONLY when JSON logging is on: the text formatter ('[%d] [%s][%a] %m')
// renders no id field, so running the AsyncLocalStorage in text mode would be pure
// overhead with no reader. Mirrors lib/logger's opt.format precedence
// (GINA_LOG_FORMAT > GINA_LOG_STDOUT), resolved once — the format is fixed for the
// process lifetime.
var _reqCtxLogging = (function() {
    if ( /^json$/i.test(process.env.GINA_LOG_FORMAT) ) { return true; }
    if ( /^text$/i.test(process.env.GINA_LOG_FORMAT) ) { return false; }
    return /^true$/i.test(process.env.GINA_LOG_STDOUT);
})();

// #M12b — resolve the request id: honour a sanitised inbound `X-Request-Id` (so logs
// correlate across an upstream proxy / sibling services), else generate a UUID. The
// inbound value is client-supplied and untrusted — cap length and restrict the
// charset to neutralise log-forging / injection; on any violation fall back to a
// fresh UUID.
var _resolveRequestId = function(request) {
    var _inbound = request && request.headers && request.headers['x-request-id'];
    if ( _inbound && /^[\w.\-]{1,128}$/.test(_inbound) ) {
        return _inbound;
    }
    return crypto.randomUUID();
};

/**
 * #ERRREF — mint (or validate a caller-supplied) incident ref for error
 * responses.
 *
 * The ref is a short correlation code returned as a top-level `ref` field on
 * every `throwError` JSON error body — in ALL scopes (it is a random
 * correlation key carrying no server detail, unlike `stack`) — and paired
 * server-side with the full error detail in the throwError log line, so a
 * user-relayed ref resolves to the exact failure even where the stack
 * egress gate strips the wire. 6 uppercase hex chars is a deliberate
 * divergence from the base64url token house style (csrf/csp nonces): this
 * is the one token END USERS relay by voice or typing to support, so the
 * charset must be case-insensitively matchable and free of ambiguous
 * symbols. A caller-supplied ref is honoured when relay-safe — same
 * sanitize-inbound discipline as _resolveRequestId's X-Request-Id (bounded
 * length, restricted charset — neutralises log forging); anything else gets
 * a fresh mint. Kept in sync with the controller-side twin
 * (core/controller/controller.js).
 *
 * @private
 * @param {string} [supplied] - caller/producer-provided ref candidate
 * @returns {string} the supplied value when relay-safe (1-32 chars of
 *  word chars, dots or dashes), else 6 fresh uppercase hex chars
 */
var _mintErrorRef = function(supplied) {
    if ( typeof(supplied) == 'string' && /^[\w.\-]{1,32}$/.test(supplied) ) {
        return supplied;
    }
    return crypto.randomBytes(3).toString('hex').toUpperCase();
};


// Lightweight debug logger — gated on LOG_LEVEL so zero cost in production.
// Format mirrors lib/logger template: [date] [debug  ][gina:server] message
// Deliberately retained with no call sites (#B435): the producer half of the
// boot-diagnostic channel. lib/cmd/bundle/start.js's child.stderr filter
// forwards lines matching `[debug  ][gina:` raw to the CLI client — no other
// write from a daemon-spawned bundle reaches the operator (console.error does
// not match the filter; stdout is captured but not forwarded). Writing
// straight to stderr keeps it usable before lib/logger is ready and immune to
// the logger's own failure modes — which also means it bypasses log redaction
// (#B433): keep messages free of URLs and credentials. Format changes must
// preserve `] [debug  ][gina:` — test/core/debug-log.test.js pins the contract.
/**
 * #OW2 — parse a byte-size setting (`"64MB"`, `"512KB"`, `"2048B"`) into bytes.
 *
 * Deliberately SEPARATE from the multipart `parseSize` helper inside the upload
 * branch, which this arc does not touch: that helper sits on the upload path and
 * carries its own source pins, and refactoring a working path as a side-effect of
 * adding a body cap is the "while I'm here" shape that produced the #B446
 * follow-up regression. The two agree by construction on every unit and are pinned
 * against each other in `test/core/body-size-cap.test.js` so they cannot drift;
 * unifying them belongs to a future upload/merge arc (#B457).
 *
 * Bare numbers are MB for back-compat with the multipart convention.
 *
 * @param {string|number} value - e.g. `"64MB"`, `"512KB"`, `2` (= 2MB)
 * @returns {number} bytes, or NaN when unparseable
 * @private
 * @example
 * parseByteSize('64MB');  // 67108864
 * parseByteSize('512KB'); // 524288
 * parseByteSize(2);       // 2097152
 */
var parseByteSize = function(value) {
    if ( typeof(value) == 'number' ) { return value * 1024 * 1024; } // bare number = MB
    if ( typeof(value) != 'string' ) { return NaN; }
    var m = value.trim().match(/^([0-9]*\.?[0-9]+)\s*(b|kb|k|mb|m|gb|g)?$/i);
    if ( !m ) { return NaN; }
    var n = parseFloat(m[1]);
    switch ( (m[2] || 'mb').toLowerCase() ) {
        case 'b':
            return n;
        case 'k':
        case 'kb':
            return n * 1024;
        case 'g':
        case 'gb':
            return n * 1024 * 1024 * 1024;
        case 'm':
        case 'mb':
        default:
            return n * 1024 * 1024;
    }
};

/**
 * #B469 — reclaim staged multipart parts a PREVIOUS process stranded.
 *
 * A staged upload part has exactly two reclaim paths: the `movefiles()` unlink
 * when `self.store()` publishes it, and the per-upload `autoTmpCleanupTimeout`
 * timer — which is in-process, so every part it was holding outlives a restart.
 * This sweep runs the same policy across process lifetimes: at boot, remove
 * from each configured staging directory the parts old enough that an armed
 * timer would already have taken them, had its process survived.
 *
 * Deliberately conservative:
 * - name-gated on the exact staged shape (32 lowercase hex + `.part`, the
 *   server-generated name) — a client-named orphan predating that naming is
 *   indistinguishable from an application file and is left alone;
 * - regular files only (`lstat`, never follows a symlink), non-recursive;
 * - age-gated on mtime, so a part a SIBLING live process is still streaming
 *   into a shared staging dir (fresh mtime while chunks land) is never touched;
 * - every step tolerates a concurrent removal (`ENOENT` is not an error — a
 *   sibling bundle sweeping the same dir, or the app unlinking its own part).
 *
 * @private
 * @function sweepStagedUploadOrphans
 * @param {array} dirs - Absolute staging directories (already resolved, deduped by the caller)
 * @param {number} olderThanMs - Only parts whose mtime is older than this many ms are removed; a non-positive/NaN value makes the sweep a no-op
 * @param {function} done - Completion callback
 * @param {object} done.report - `{ scanned, removed, errors }` counters (`scanned` = name-matching entries considered)
 * @returns {void}
 * @example
 *   sweepStagedUploadOrphans([ '/var/data/uploads' ], 3600000, function(report) {
 *       console.debug('removed ' + report.removed + ' orphaned staged part(s)');
 *   });
 */
var sweepStagedUploadOrphans = function(dirs, olderThanMs, done) {
    var report = { scanned: 0, removed: 0, errors: 0 };
    if ( !(olderThanMs > 0) ) { // NaN/0/negative — refuse to sweep on a broken threshold
        return done(report);
    }
    var d = 0;
    var nextDir = function() {
        if (d >= dirs.length) {
            return done(report);
        }
        var dir = dirs[d]; d++;
        fs.readdir(dir, function(readdirErr, names) {
            if (readdirErr) {
                // a staging dir that does not exist yet has nothing to reclaim
                if (readdirErr.code != 'ENOENT') report.errors++;
                return nextDir();
            }
            var cutoff = Date.now() - olderThanMs;
            var n = 0;
            var nextName = function() {
                if (n >= names.length) {
                    return nextDir();
                }
                var name = names[n]; n++;
                if ( !/^[0-9a-f]{32}\.part$/.test(name) ) {
                    return nextName();
                }
                report.scanned++;
                var full = dir + '/' + name;
                fs.lstat(full, function(lstatErr, stats) {
                    if (lstatErr) {
                        if (lstatErr.code != 'ENOENT') report.errors++;
                        return nextName();
                    }
                    if ( !stats.isFile() || stats.mtimeMs > cutoff ) {
                        return nextName();
                    }
                    fs.unlink(full, function(unlinkErr) {
                        if (unlinkErr) {
                            if (unlinkErr.code != 'ENOENT') report.errors++;
                        } else {
                            report.removed++;
                        }
                        nextName();
                    });
                });
            };
            nextName();
        });
    };
    nextDir();
};

var _isDebugLog = function() {
    return process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
};
var _debugLog = function(msg) {
    if (!_isDebugLog()) return;
    var _m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var p2 = function(n) { return (n < 10 ? '0' : '') + n; };
    var d = new Date();
    var ts = d.getFullYear() + ' ' + _m[d.getMonth()] + ' ' + p2(d.getDate())
        + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    process.stderr.write('\u001b[90m[' + ts + '] [debug  ][gina:server] ' + msg + '\u001b[39m\n');
};

var Config          = require('./config');
var Router          = require('./router');
var lib             = require('./../lib');
var routingLib      = lib.routing;
// #RC4 — the engine-agnostic render/output-cache read path (design f). One gen-0
// instance (plain-required RenderCache survives refreshCore), pointed at the shared
// Map per request via `from()`. Mirrors server.isaac.js's module-scope renderCache.
var renderCache     = new lib.RenderCache();
var inherits        = lib.inherits;
var merge           = lib.merge;
var Proc            = lib.Proc;
var console         = lib.logger;
var SwigFilters     = lib.SwigFilters;
var swigResolver    = lib.swigResolver;
var nunjucksResolver = lib.nunjucksResolver;
var Domain          = lib.Domain;
var domainLib       = new Domain();

/**
 * #A11Y3 — BCP-47 language tag for a framework-generated document.
 *
 * The negotiated culture is stored underscore-separated (`en_CM`), and a raw
 * `accept-language` value can still carry its q-value (`fr;q=0.9`). Neither form
 * is a valid `lang` attribute: assistive technology that cannot parse the tag
 * falls back to the wrong voice, which is worse than no tag at all. Normalises
 * to a hyphen-separated subtag sequence and falls back to `en` rather than
 * emitting something unparseable.
 *
 * @param {object} [req] - request whose negotiated `culture` should be used
 * @returns {string} a BCP-47-shaped language tag, never empty
 *
 * @example
 * a11yLangTag({ culture: 'en_CM' });    // 'en-CM'
 * a11yLangTag({ culture: 'fr;q=0.9' }); // 'fr'
 * a11yLangTag(null);                    // 'en'
 *
 * @inner
 */
var a11yLangTag = function(req) {
    var culture = ( req && typeof(req.culture) == 'string' && req.culture )
        ? req.culture
        : ( getEnvVar('GINA_CULTURE') || '' );
    culture = String(culture).split(',')[0].split(';')[0].trim().replace(/_/g, '-');
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(culture) ? culture : 'en';
};

/**
 * #A11Y3 — wraps a framework-generated error body in a conforming HTML document.
 *
 * The built-in fallback previously emitted no doctype (so browsers rendered it in
 * quirks mode), no `<head>`, no `<title>` (WCAG 2.4.2) and no `lang` (WCAG 3.1.1);
 * the HTTP/1 branch additionally closed `<body>` with an *opening* `<html>` tag.
 * The caller's body is embedded verbatim, so the status and incident ref that the
 * error-pages guide promises the fallback shows are preserved unchanged.
 *
 * @param {number|string} code - HTTP status code, used for the document title
 * @param {string} bodyHtml - the already-built error body markup
 * @param {object} [req] - request, for language negotiation
 * @returns {string} a complete, conforming HTML document
 *
 * @example
 * a11yErrorDocument(500, '<h1>Error 500.</h1><pre>ref A1B2C3</pre>', local.request);
 *
 * @inner
 */
var a11yErrorDocument = function(code, bodyHtml, req) {
    return '<!doctype html><html lang="'+ a11yLangTag(req) +'">'
        + '<head><title>Error '+ code +'</title></head>'
        + '<body><main>'+ bodyHtml +'</main></body></html>';
};

/**
 * #MAINT1 — answer a request refused by the maintenance gate.
 *
 * Always 503 + `Retry-After` + `Cache-Control: no-store`. The `no-store` is
 * load-bearing rather than tidy: a 503 cached by an intermediary would outlive
 * the maintenance window and keep serving the closed page after the site
 * reopened — the one failure mode that turns a 10-minute window into an
 * open-ended outage.
 *
 * Content negotiation is header-only, because this runs BEFORE routing: nothing
 * has parsed the request yet, so `req.isXMLRequest` does not exist at this point.
 * The HTML branch reuses the #A11Y3 conforming-document wrapper (doctype, `lang`,
 * `<title>`) and is entirely self-contained — no stylesheet, no image, no script —
 * precisely because the gate above it also refuses static assets.
 *
 * Engine-agnostic: uses the express idiom (setHeader/statusCode/end) and is
 * mirrored by the isaac twin in core/server.isaac.js.
 *
 * @inner
 * @param {object} req - the request
 * @param {object} res - the response
 * @param {object} conf - the effective conf from lib.maintenance.effectiveConf()
 * @returns {*} the result of `res.end()`
 *
 * @example
 * _serveMaintenance(request, response, { retryAfter: 300, message: 'Back at 14:00 UTC' });
 */
var _serveMaintenance = function(req, res, conf) {
    var kind    = lib.maintenance.negotiate(req);
    var built   = lib.maintenance.buildBody(conf, kind, a11yLangTag(req));
    var headers = lib.maintenance.responseHeaders(conf, built.contentType);

    res.statusCode = 503;
    for (var h in headers) {
        res.setHeader(h, headers[h]);
    }
    return res.end(built.body);
};

/**
 * Constant-time API-key check for the /_gina/agent SSE endpoint when it is
 * exposed outside dev mode (#INS9b). Engine-agnostic mirror of the helper in
 * server.isaac.js. The configured key lives on `process.gina._inspectorAgentKey`
 * (set by gna.js from settings.json `inspector.agent.key`). The request
 * presents the key via the `x-gina-inspector-key` header or a `?key=` query
 * param — browsers using EventSource cannot set request headers, so the query
 * param is the browser path; programmatic callers should prefer the header.
 *
 * Fail-closed: when no key is configured this returns false, so the endpoint
 * stays closed even if `inspector.agent.enabled` is true. Uses
 * `crypto.timingSafeEqual` with a length guard so a length mismatch can't
 * throw and the compare does not early-exit on the first differing byte.
 *
 * @inner
 * @param {http.IncomingMessage|http2.Http2ServerRequest} req
 * @returns {boolean} true when the presented key matches the configured key
 */
function _agentKeyValid(req) {
    var configured = (typeof process.gina === 'object' && process.gina && typeof process.gina._inspectorAgentKey === 'string')
        ? process.gina._inspectorAgentKey
        : '';
    if (!configured) return false;
    var presented = (req.headers && req.headers['x-gina-inspector-key']) || '';
    if (!presented && typeof req.url === 'string') {
        var _qi = req.url.indexOf('?');
        if (_qi >= 0) {
            try {
                presented = new URLSearchParams(req.url.slice(_qi + 1)).get('key') || '';
            } catch (e) { presented = ''; }
        }
    }
    if (!presented) return false;
    var a = Buffer.from(String(presented));
    var b = Buffer.from(configured);
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

/**
 * Validate the inspector instrumentation control key (#INS10). Mirrors
 * {@link _agentKeyValid} but reads the SEPARATE `process.gina._inspectorInstrumentKey`
 * — turning on raw query/flow capture is more sensitive than agent log-streaming,
 * so it carries its own opt-in + key and is required EVEN in dev. Reads the
 * `x-gina-inspector-key` header or a `?key=` query param; constant-time compare
 * with a length guard; fail-closed when no key is configured.
 *
 * @inner
 * @param {http.IncomingMessage|http2.Http2ServerRequest} req
 * @returns {boolean} true when the presented key matches the configured instrument key
 */
function _instrumentKeyValid(req) {
    var configured = (typeof process.gina === 'object' && process.gina && typeof process.gina._inspectorInstrumentKey === 'string')
        ? process.gina._inspectorInstrumentKey
        : '';
    if (!configured) return false;
    var presented = (req.headers && req.headers['x-gina-inspector-key']) || '';
    if (!presented && typeof req.url === 'string') {
        var _qi = req.url.indexOf('?');
        if (_qi >= 0) {
            try {
                presented = new URLSearchParams(req.url.slice(_qi + 1)).get('key') || '';
            } catch (e) { presented = ''; }
        }
    }
    if (!presented) return false;
    var a = Buffer.from(String(presented));
    var b = Buffer.from(configured);
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

/**
 * #INS8 — Attach the authenticated WebSocket transport for `/_gina/agent` to
 * the raw HTTP server. The standalone Inspector (services/src/inspector on
 * :4101) can connect over a WebSocket as an alternative to the SSE channel —
 * same data + log frames, same #INS9b auth — but over a single bidirectional
 * socket, the substrate for future bidirectional commands (#INS11 multi-bundle
 * dashboard, #INS12 browser extension).
 *
 * Engine-agnostic by design: `rawServer` is the value returned by
 * `self.instance.listen()`, and server.js owns the single `listen()` call for
 * BOTH engines (the isaac instance IS the raw server; express's `app.listen()`
 * returns it), so one `upgrade` listener here covers both. There is deliberately
 * NO isaac-specific mirror — the isaac engine.io upgrade handler defers to this
 * one via a `/_gina/agent` skip-guard (see server.isaac.js).
 *
 * Auth parity with the SSE endpoint: dev stays open + keyless; outside dev the
 * upgrade requires a valid key (`x-gina-inspector-key` header or `?key=` query
 * param) via the shared {@link _agentKeyValid}, fail-closed. When an Origin
 * allowlist is configured (`process.gina._inspectorAgentAllowedOrigins`), the
 * upgrade `Origin` must be in it; unconfigured ⇒ allow (parity with the SSE
 * endpoint's `access-control-allow-origin: *`; cross-origin is the norm here,
 * Inspector on :4101 → target on another port). Denials are written as a raw
 * HTTP status line on the upgrade socket (no `ServerResponse` exists yet), then
 * the socket is destroyed.
 *
 * Snapshot replay + capture egress mirror the SSE handler: the last snapshot is
 * only sent in dev OR during an active instrumentation window (#INS10), never a
 * post-window snapshot to a late authenticated client.
 *
 * Fail-graceful: if the `ws` module cannot be loaded the attach is skipped with
 * a warning and SSE remains the transport — the WebSocket is an enhancement,
 * not a hard dependency of the inspector channel.
 *
 * @inner
 * @param {http.Server|https.Server|http2.Http2Server} rawServer - the raw server returned by listen()
 * @param {object} ctx - the Server instance (provides `ctx.instance._lastGinaData`, `ctx.appName`, `ctx.env`)
 * @returns {void}
 * @example
 * // Browser (standalone Inspector), non-dev target with a configured key:
 * //   new WebSocket('ws://host:port/_gina/agent?key=' + encodeURIComponent(key))
 * // Frames: {"event":"data","data":{...}} and {"event":"log","data":{t,l,b,s,src}}
 */
function attachInspectorAgentWs(rawServer, ctx) {
    if (!rawServer || typeof rawServer.on !== 'function') { return; }
    var WebSocketServer;
    try {
        var _wsMod = require('ws');
        WebSocketServer = _wsMod.WebSocketServer || _wsMod.Server;
    } catch (wsErr) {
        console.warn('[inspector-agent] WebSocket transport disabled — ws module unavailable: ' + (wsErr.message || wsErr));
        return;
    }
    if (typeof WebSocketServer !== 'function') { return; }

    var _wss     = new WebSocketServer({ noServer: true });
    var _agAnsiRe = /\x1B\[\d+m/g;

    rawServer.on('upgrade', function(req, socket, head) {
        // Only handle the agent WS path; leave every other upgrade (e.g.
        // engine.io in ioServer-attach mode) for its own listener.
        if (!/\/_gina\/agent(?:\?|$)/.test(req.url || '')) { return; }

        var _agIsDev = (process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true');

        // Gate: dev OR explicitly enabled outside dev — otherwise the endpoint
        // does not exist (404), matching the SSE handler's opt-in invisibility.
        if (!_agIsDev && !(process.gina && process.gina._inspectorAgentEnabled)) {
            try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch (e) {}
            try { socket.destroy(); } catch (e) {}
            return;
        }

        // #INS9b auth — outside dev a valid key is required (header or ?key=).
        if (!_agIsDev && !_agentKeyValid(req)) {
            try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch (e) {}
            try { socket.destroy(); } catch (e) {}
            return;
        }

        // Optional Origin allowlist — enforced only when configured (parity with
        // the SSE endpoint, open by default). The operator lists the Inspector
        // origin(s) for production use.
        var _allowed = (process.gina && Array.isArray(process.gina._inspectorAgentAllowedOrigins))
            ? process.gina._inspectorAgentAllowedOrigins : [];
        if (_allowed.length > 0) {
            var _origin = (req.headers && req.headers.origin) || '';
            if (_allowed.indexOf(_origin) < 0) {
                try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch (e) {}
                try { socket.destroy(); } catch (e) {}
                return;
            }
        }

        _wss.handleUpgrade(req, socket, head, function(ws) {
            if (!process.gina._inspectorActive) { process.gina._inspectorActive = true; }

            // Initial snapshot — dev OR an active instrumentation window only,
            // never a post-window snapshot to a late authenticated client (#INS10).
            try {
                if ((_agIsDev || (lib.instrument && lib.instrument.isActive())) && ctx.instance && ctx.instance._lastGinaData) {
                    ws.send(JSON.stringify({ event: 'data', data: ctx.instance._lastGinaData }));
                } else {
                    var _initEnv = { bundle: ctx.appName || '', env: ctx.env || '' };
                    ws.send(JSON.stringify({ event: 'data', data: { gina: { environment: _initEnv }, user: { environment: _initEnv } } }));
                }
            } catch (e) {}

            // Data updates — emitted by the render delegates on every render.
            var _wsDataListener = function(payload) {
                try { ws.send(JSON.stringify({ event: 'data', data: payload })); } catch (e) {}
            };
            // Log entries — same source + frame shape as the SSE endpoint.
            var _wsLogListener = function(payload) {
                try {
                    var entry = JSON.parse(payload);
                    var level = entry.level === 'catch' ? 'log' : (entry.level || 'log');
                    var msg   = (entry.content || '').replace(_agAnsiRe, '').replace(/\n$/, '');
                    if (!msg) { return; }
                    ws.send(JSON.stringify({ event: 'log', data: { t: Date.now(), l: level, b: entry.group || '', s: msg, src: 'server' } }));
                } catch (e) {}
            };
            // #AISTREAM — live AI token-stream frames (distinct event, same envelope).
            var _wsTokenListener = function(payload) {
                try { ws.send(JSON.stringify({ event: 'token', data: payload })); } catch (e) {}
            };
            // #EVTBUS — live application-event frames (distinct event, same envelope).
            var _wsEventListener = function(payload) {
                try { ws.send(JSON.stringify({ event: 'event', data: payload })); } catch (e) {}
            };

            process.on('inspector#data', _wsDataListener);
            process.on('logger#default', _wsLogListener);
            process.on('inspector#token', _wsTokenListener);
            process.on('inspector#event', _wsEventListener);

            // Graceful-shutdown drain: proc.js's SIGTERM path invokes every
            // registered closer before _httpServer.close(), so a live agent
            // WebSocket ends with a clean `1001 going away` close handshake
            // instead of blocking shutdown until the hard timeout. ws emits
            // 'close' once the handshake completes, so _cleanup deregisters.
            if (!process.gina._sseConnections) process.gina._sseConnections = new Set();
            var _wsShutdownCloser = function() {
                try { ws.close(1001, 'server shutting down'); } catch (e) {}
            };
            process.gina._sseConnections.add(_wsShutdownCloser);

            var _cleanup = function() {
                process.removeListener('inspector#data', _wsDataListener);
                process.removeListener('logger#default', _wsLogListener);
                process.removeListener('inspector#token', _wsTokenListener);
                process.removeListener('inspector#event', _wsEventListener);
                if (process.gina._sseConnections) {
                    process.gina._sseConnections.delete(_wsShutdownCloser);
                }
            };
            ws.on('close', _cleanup);
            ws.on('error', _cleanup);

            // Inbound frames are reserved for future bidirectional commands
            // (#INS11/#INS12). For now, answer only a lightweight heartbeat.
            ws.on('message', function(raw) {
                try {
                    var m = JSON.parse(raw.toString());
                    if (m && m.type === 'ping') { ws.send(JSON.stringify({ event: 'pong', data: Date.now() })); }
                } catch (e) {}
            });

            try { console.info((req.method || 'GET') + ' [101] ' + req.url + ' (WS agent)'); } catch (e) {}
        });
    });
}

/**
 * Read a small JSON request body for the POST /_gina/instrument control
 * endpoint (#INS10). Bounded at 4 KB — the control body is tiny
 * (`{enable, ttlSeconds}`). Uses `req.body` when an upstream parser already
 * populated it; otherwise drains the request stream (works for HTTP/1.1
 * IncomingMessage and HTTP/2 Http2ServerRequest). A 2s timeout guards against
 * an already-consumed stream that never re-fires `end`. Calls back exactly once.
 *
 * @inner
 * @param {http.IncomingMessage|http2.Http2ServerRequest} req
 * @param {function(Error|null, object=):void} cb - `(err, parsedBody)`
 * @returns {void}
 */
function _readInstrumentBody(req, cb) {
    if (req.body && typeof req.body === 'object') {
        return cb(null, req.body);
    }
    var _chunks = [];
    var _size   = 0;
    var _done   = false;
    var _MAX    = 4096;
    var _timer  = null;
    var _finish = function(err, val) {
        if (_done) return;
        _done = true;
        if (_timer) { clearTimeout(_timer); _timer = null; }
        cb(err, val);
    };
    _timer = setTimeout(function() { _finish(new Error('body read timeout')); }, 2000);
    if (_timer && typeof _timer.unref === 'function') { _timer.unref(); }
    req.on('data', function(chunk) {
        _size += chunk.length;
        if (_size > _MAX) {
            _finish(new Error('body too large'));
            try { req.destroy(); } catch (e) {}
            return;
        }
        _chunks.push(chunk);
    });
    req.on('end', function() {
        var _raw = Buffer.concat(_chunks).toString('utf8').trim();
        if (!_raw) return _finish(null, {});
        try { _finish(null, JSON.parse(_raw)); }
        catch (e) { _finish(new Error('invalid JSON body')); }
    });
    req.on('error', function(e) { _finish(e); });
}

/**
 * Builds the client-served routing maps from the boot-time global route
 * table: the full map, and the #B66 host-stripped variant served to proxied
 * clients.
 *
 * #B212 — this is the ONE engine-agnostic builder. It moved here verbatim
 * from the isaac engine constructor (`server.isaac.js`), where it lived
 * isaac-only — leaving `/_gina/assets/routing.json` a 404 under any other
 * engine, in violation of the `/_gina/*` endpoint-sync rule (and the client,
 * lacking a `response.ok` check — #B213 — then installed the 404 JSON body AS
 * its routing table). Two consumers, one source of truth: `init()` hands the
 * maps to the engine via `serverOpt.clientRoutingAssets` (isaac writes them to
 * disk and serves the precompressed files as its fast-path) and keeps
 * pre-stringified copies on `self._clientRoutingAssets` for the engine-
 * agnostic `onRequest` handler (the express path). Rebuilding per engine
 * would re-create the writer/reader drift the #C3 lesson warns about.
 *
 * Runs once at boot over a bounded route table — not a hot path.
 *
 * Slice 3 (#SPA1) rebuilt the cut as an ALLOWLIST. The previous shape was a
 * destructuring-rest DENYLIST (strip `_comment`/`middleware`, then the
 * #COMPLY1 `requireAuth`/`roles`/`policy` + #COMPLY10 `public` authorization
 * keys) — but `schema/routing.json` is `additionalProperties: true` at both
 * the route and `param` levels, so under a denylist every FUTURE key shipped
 * to any anonymous browser by default; that is exactly how `csrfExempt`,
 * `param.dto` and `queryTimeout` reached the wire. Under the allowlist the
 * authorization strip is structural: a key that is not named simply never
 * ships. The client contract kept here is the MEASURED reader set — client
 * `getRoute`/`toUrl` read `url`/`webroot`/`bundle`/`hostname` (+ `host` on
 * raw deployments), iterate `param` for URL-placeholder bindings, test
 * `requirements` key-presence, and branch on the route being a redirect;
 * `negotiate` is the content-negotiation capability flag the navigation
 * layer needs. Everything else — dispatch keys (`param.control`/`file`/
 * `path`/`title`/…), `cache`, `csrfExempt`, `scopes`, `namespace`,
 * `middlewareIgnored`, `validator::` requirement bodies — is a server-side
 * contract and stays home.
 *
 * @private
 * @param {object} allRoutes - The boot-time global (all-bundles) route table (`options.conf.routing`)
 * @returns {{full: object, stripped: object}} The client-safe full map and the #B66 host-stripped variant (both fresh clones — the live config is never touched)
 */
function buildClientRoutingAssets(allRoutes) {
    var _all = JSON.clone(allRoutes);
    var _routing = {};
    // Route-level allowlist — the measured client contract (see the JSDoc above).
    var _clientRouteKeys = ['url', 'method', 'webroot', 'bundle', 'hostname', 'host', 'negotiate'];
    var _routingKeys = Object.keys(_all);
    for (var ri = 0; ri < _routingKeys.length; ++ri) {
        var _src   = _all[_routingKeys[ri]];
        var _clean = {};
        if ( !_src || typeof(_src) != 'object' ) {
            _routing[_routingKeys[ri]] = _src;
            continue;
        }
        for (var ki = 0; ki < _clientRouteKeys.length; ++ki) {
            if ( typeof(_src[_clientRouteKeys[ki]]) != 'undefined' ) {
                _clean[_clientRouteKeys[ki]] = _src[_clientRouteKeys[ki]];
            }
        }
        // `requirements` — plain-regex entries only: the client toUrl reads KEY
        // PRESENCE (to keep a declared URL variable out of the query string);
        // a `validator::{...}` body is a server-side validation spec and a
        // disclosure of the bundle's validation model.
        if ( _src.requirements && typeof(_src.requirements) == 'object' ) {
            var _cleanReq = {};
            var _reqKeys = Object.keys(_src.requirements);
            for (var qi = 0; qi < _reqKeys.length; ++qi) {
                if ( !/^validator\:\:/i.test(String(_src.requirements[_reqKeys[qi]])) ) {
                    _cleanReq[_reqKeys[qi]] = _src.requirements[_reqKeys[qi]];
                }
            }
            _clean.requirements = _cleanReq;
        }
        // `param` — URL-placeholder BINDINGS only. A param entry is a binding
        // iff the route's own url declares `:key` (the client getRoute uses the
        // binding regex to split URL variables from appended query params);
        // every other param key is dispatch/authorization vocabulary
        // (`control`, `file`, `path`, `title`, the #COMPLY1/#COMPLY10 keys, …)
        // and is a server-side contract. The one dispatch FACT the client
        // toUrl branches on — "is this a redirect route" — ships as the
        // derived boolean `isRedirect` instead of the `control` value.
        if ( _src.param && typeof(_src.param) == 'object' ) {
            var _bindings = {};
            var _urlVars  = String(_src.url || '').match(/\:[-_a-zA-Z0-9]+/g) || [];
            for (var vi = 0; vi < _urlVars.length; ++vi) {
                var _varName = _urlVars[vi].substr(1);
                if ( typeof(_src.param[_varName]) != 'undefined' ) {
                    _bindings[_varName] = _src.param[_varName];
                }
            }
            _clean.param = _bindings;
            if ( typeof(_src.param.control) == 'string' && /^redirect$/i.test(_src.param.control) ) {
                _clean.isRedirect = true;
            }
        }
        _routing[_routingKeys[ri]] = _clean;

        // reverseRouting is done on the frontend side

    }// EO for routing keys

    // #B66 — a host-stripped variant of the routing map, served to PROXIED clients
    // so the browser never receives any bundle's INTERNAL scheme://host:port (an
    // information disclosure) and cross-bundle client toUrl resolves same-origin.
    // Drop each route's `host` + `hostname`; KEEP `webroot` (the client toUrl path
    // relies on it). Proxy-host-agnostic + boot-static like the full map above; the
    // serve-time handlers pick stripped-vs-full per request (isaac on the #B65
    // request stamp, the engine-agnostic onRequest handler on its #B65-twin).
    var _routingStripped = JSON.clone(_routing);
    var _routingStrippedKeys = Object.keys(_routingStripped);
    for (var si = 0; si < _routingStrippedKeys.length; ++si) {
        const { host, hostname, ...cleanStripped } = _routingStripped[_routingStrippedKeys[si]];
        _routingStripped[_routingStrippedKeys[si]] = cleanStripped;
    }// EO for stripped routing keys

    return { full: _routing, stripped: _routingStripped };
}

function Server(options) {

    // switching logger flow
    //console.switchFlow('server');

    var e       = new EventEmitter();
    var self    = this;
    var local   = {
        router : null,
        hasViews: {}
    };
    var Engine = null;

    this.conf = {
        core: {}
    };

    this.routing = {};
    //this.activeChild = 0;

    /**
     * Configures the Swig template engine for the given bundle config: sets
     * loader root, cache mode, and registers all custom Swig filters.
     *
     * @inner
     * @private
     * @param {object} conf - Bundle/env configuration object
     */
    /**
     * Preloads the nunjucks module for this bundle when render.engine is
     * "nunjucks". Called once per bundle startup, before any HTTP request
     * can reach controller.render-nunjucks.js. A missing nunjucks package
     * throws NUNJUCKS_NOT_INSTALLED here, terminating bundle startup with
     * a clear error — rendering with a stub would mask the misconfig.
     *
     * No-op when render.engine is unset or "swig" AND no templates.json
     * section declares a `.njk` extension — the existing swig engine init
     * handles that case via initSwigEngine below. A bundle whose
     * settings-level engine is swig can still mix in nunjucks-rendered
     * sections via per-section templates.json `ext` declarations (#M11:
     * `.njk` routes through the nunjucks delegate at dispatch time), so
     * nunjucks is initialised for those bundles too and a missing project
     * nunjucks install fails at startup instead of 500-ing the first
     * `.njk` render.
     *
     * @inner
     * @private
     * @param {object} conf - Bundle/env configuration object
     */
    var initNunjucksEngine = function(conf) {
        var _settings = (conf && conf.content && conf.content.settings) || {};
        var _engine = (_settings.render && _settings.render.engine) || 'swig';
        // #M11 — extension-keyed mixing: any templates.json section whose
        // `ext` is `.njk` (or `njk`) dispatches through nunjucks even when
        // the settings-level engine is swig, so those bundles need the
        // same fail-fast startup init.
        var _hasNjkSection = false;
        try {
            var _tpls = (conf && conf.content && conf.content.templates) || {};
            for (var _section in _tpls) {
                var _sectionExt = _tpls[_section] && _tpls[_section].ext;
                if ( _sectionExt && /^\.?njk$/i.test(String(_sectionExt)) ) {
                    _hasNjkSection = true;
                    break;
                }
            }
        } catch (e) { /* fall through — the settings-level engine decides */ }
        if (_engine !== 'nunjucks' && !_hasNjkSection) { return; }
        var _nunjucksSettings = _settings.nunjucks || {};
        // load() throws NUNJUCKS_NOT_INSTALLED if the project does not have
        // nunjucks in its node_modules — we intentionally let that propagate
        // so bundle startup fails with a clear message rather than
        // deferring the failure to the first render attempt.
        nunjucksResolver.load(self.executionPath, _nunjucksSettings);

        // #TPL1 — async template-loader extension point. When the bundle
        // configures settings.template.nunjucks.loader, build + validate the
        // loader at startup (fail-fast on bad config, same as the nunjucks
        // load above) and stash it per-bundle keyed by the template root.
        // controller.js routes such bundles to the async delegate
        // (controller.render-nunjucks-async.js), which builds a PER-REQUEST
        // nunjucks Environment over this loader. The default (no-loader) path
        // is untouched — render-nunjucks.js's cached-Environment filesystem path.
        var _loaderCfg = (
            conf.content && conf.content.settings && conf.content.settings.template
            && conf.content.settings.template.nunjucks && conf.content.settings.template.nunjucks.loader
        ) || null;
        if (_loaderCfg) {
            // build() throws on a bad config; let it propagate so bundle startup
            // fails with a clear message rather than 500-ing the first render.
            // It does NOT reach the backend (no network probe at boot).
            var _builtLoader = lib.templateLoaders.build(_loaderCfg, { bundle: self.appName });
            if (_builtLoader && _builtLoader.async === true) {
                if (!process.gina._nunjucksLoaders) { process.gina._nunjucksLoaders = Object.create(null); }
                process.gina._nunjucksLoaders[conf.content.templates._common.html] = {
                    loader:     _builtLoader,
                    autoescape: (_nunjucksSettings.autoescape !== false),
                    cache:      (_loaderCfg.cache === true)   // #TPL1 Tier-2 opt-in compiled-template cache
                };
            }
        }
    };

    var initSwigEngine = function(conf) {
        // Resolve the swig module for this bundle. First call per process
        // honours the opt-in in conf.content.settings.swig (useProject,
        // package, min) and caches on process.gina._swig; subsequent calls
        // return the cached reference. The resolver falls back to the
        // framework copy on any safety-gate mismatch — same behaviour as
        // the previous top-level require('@rhinostone/swig').
        var _swigSettings = (conf && conf.content && conf.content.settings && conf.content.settings.swig) || {};
        swigResolver.load(self.executionPath, _swigSettings);
        var swig = swigResolver.get();

        // swig options
        var dir = conf.content.templates._common.html;
        // Output auto-escaping — resolve from the bundle's swig settings,
        // mirroring nunjucks (initNunjucksEngine reads _nunjucksSettings.autoescape
        // from settings.nunjucks). `_swigSettings` is conf.content.settings.swig,
        // already resolved above for the swig-package opt-in. ABSENT ⇒ false
        // (unchanged behaviour; the previous read of `conf.autoescape` was never
        // populated by config.js — measured dead). A non-boolean value refuses the
        // boot: a security toggle must never be silently mis-typed (the
        // audit.enabled strictly-boolean rule).
        if ( typeof(_swigSettings.autoescape) != 'undefined'
            && typeof(_swigSettings.autoescape) != 'boolean' ) {
            throw new Error('[ SWIG ] settings.swig.autoescape must be a boolean (got: '+ JSON.stringify(_swigSettings.autoescape) +')');
        }
        var swigOptions = {
            // was: autoescape: ( typeof(conf.autoescape) != 'undefined') ? conf.autoescape: false,
            autoescape: (_swigSettings.autoescape === true),
            // #TPL2 — confined loader (swig-core basepath confinement, CVE-2023-25345).
            // gina no longer resolves any template OUTSIDE the bundle templates root:
            // the processed layout cache lives in-root (controller.render-swig.js
            // .gina-layout-cache) and the dev inspector statusbar is inlined rather
            // than {% include %}-d from the framework core dir. So the loader keeps
            // swig-core's confinement (allowOutsideRoot defaults false) for every
            // resolution, including untrusted nested {% include %} / {% import %}.
            loader: swig.loaders.fs(dir),
            cache: (conf.isCacheless) ? false : 'memory'
        };

        swig.setDefaults(swigOptions);

        var filters = SwigFilters({
            options     : conf,
            isProxyHost : getContext('isProxyHost')
        });

        try {
            // Allows you to get a bundle web root
            // e.g.: swig.setFilter('getWebroot', filters.getWebroot);
            // e.g.: swig.setFilter('nl2br', filters.nl2br);
            for (let filter in filters) {
                if ( typeof(filters[filter]) == 'function' && !/^getConfig$/.test(filter) ) {
                    swig.setFilter(filter, filters[filter]);
                }
            }

        } catch (err) {
            throw err;
        }

        // #TPL1 — async template-loader extension point. When the bundle
        // configures settings.template.swig.loader, build + validate the loader
        // at startup (fail-fast on bad config, mirroring initNunjucksEngine) and
        // stash it per-bundle keyed by the template root. controller.js routes
        // such bundles to the async delegate (controller.render-swig-async.js),
        // which builds an ISOLATED per-bundle swig engine from this loader — the
        // shared singleton's setDefaults loader above is unused for them. The
        // default (no-loader) path is untouched: byte-identical to pre-#TPL1.
        var _loaderCfg = (
            conf.content && conf.content.settings && conf.content.settings.template
            && conf.content.settings.template.swig && conf.content.settings.template.swig.loader
        ) || null;
        if (_loaderCfg) {
            // build() throws on a bad config; we let it propagate so bundle
            // startup fails with a clear message rather than 500-ing the first
            // render. It does NOT reach the backend (no network probe at boot).
            var _builtLoader = lib.templateLoaders.build(_loaderCfg, { bundle: self.appName });
            if (_builtLoader && _builtLoader.async === true) {
                if (!process.gina._swigLoaders) { process.gina._swigLoaders = Object.create(null); }
                process.gina._swigLoaders[dir] = {
                    loader:     _builtLoader,
                    autoescape: swigOptions.autoescape,
                    cache:      (_loaderCfg.cache === true)   // #TPL1 Tier-2 opt-in compiled-fn cache
                };
            }
        }
    }

    /**
     * Applies the server configuration options, builds the Config/Router
     * instances, selects the server engine, and emits `'configured'` with
     * `(err, instance, middleware, conf)` once the engine is ready.
     *
     * @inner
     * @private
     * @param {object} options - Same options passed to the outer `Server` constructor
     */
    var init = function(options) {

        self.projectName    = options.projectName;
        //Starting app.
        self.appName        = options.bundle;
        self.env            = options.env;
        self.scope          = options.scope;
        self.version        = options.version;
        local.router        = new Router(self.env, self.scope);

        //True => multiple bundles sharing the same server (port).
        self.isStandalone   = options.isStandalone;
        self.bundles        = options.bundles;
        self.executionPath  = options.executionPath;


        if (!self.isStandalone) {
            //Only load the related conf / env.
            self.conf[self.appName] = {};
            self.conf[self.appName][self.env] = options.conf[self.appName][self.env];
            self.conf[self.appName][self.env].bundlesPath = options.conf[self.appName][self.env].bundlesPath;
            self.conf[self.appName][self.env].modelsPath =  options.conf[self.appName][self.env].modelsPath;
            self.conf[self.appName][self.env].executionPath = options.conf[self.appName][self.env].executionPath = self.executionPath;
        } else {

            //console.debug("Running mode not handled yet..", self.appName, " VS ", self.bundles);
            //Load all conf for the related apps & env.
            var apps = self.bundles;
            for (let i=0; i<apps.length; ++i) {
                self.conf[apps[i]] = {};
                self.conf[apps[i]][self.env] = options.conf[apps[i]][self.env];
                self.conf[apps[i]][self.env].bundlesPath = options.conf[apps[i]][self.env].bundlesPath;
                self.conf[apps[i]][self.env].modelsPath = options.conf[apps[i]][self.env].modelsPath;
            }
        }


        try {

            // updating server protocol
            var serverOpt = {};
            var ioServerOpt = null;
            if ( typeof(options.conf[self.appName][self.env].content.settings.ioServer) != 'undefined' ) {
                ioServerOpt = JSON.clone(options.conf[self.appName][self.env].content.settings.ioServer);
            }


            if (
                typeof(options.conf[self.appName][self.env].content.settings.server) != 'undefined'
                && options.conf[self.appName][self.env].content.settings.server != ''
                && options.conf[self.appName][self.env].content.settings.server != null
            ) {
                serverOpt = options.conf[self.appName][self.env].content.settings.server;
            }

            serverOpt = merge({
                        bundle  : self.appName,
                        env     : self.env,
                        scope   : self.scope
                    },
                    serverOpt,
                    {
                        engine              : options.conf[self.appName][self.env].server.engine,
                        protocol            : options.conf[self.appName][self.env].server.protocol,
                        scheme              : options.conf[self.appName][self.env].server.scheme,
                        coreConfiguration   : options.conf[self.appName][self.env].server.coreConfiguration,
                        isCacheless         : options.conf[self.appName][self.env].isCacheless,
                        routing             : options.conf[self.appName][self.env].routing,
                        allRoutes           : options.conf.routing,
                        cachePath           : options.conf[self.appName][self.env].cachePath,
                        // #COMPLY9 — the transport-posture knobs resolve exactly like
                        // `scheme` itself: the bundle's settings (already seeded into
                        // serverOpt above) win, and these fills give env.json's
                        // per-env `server` block a voice when settings are silent.
                        requireHttps        : options.conf[self.appName][self.env].server.requireHttps,
                        allowInsecure       : options.conf[self.appName][self.env].server.allowInsecure
                    }
            );

            self.engine = serverOpt.engine;
            console.debug('[ BUNDLE ][ server ][ init ] Initializing [ '+ self.appName +' ] server with `'+ serverOpt.engine +'`engine');

            // controlling one last time protocol & ports
            var ctx             = getContext('gina')
                , projectConf   = ctx.project
                // TODO - check if the user prefered protocol is register in projectConf
                , protocols       = projectConf.protocols
                , portsReverse    = ctx.portsReverse
            ;

            // locking port & protocol so it can't be changed by the user's settings
            self.conf[self.appName][self.env].server.protocol   = serverOpt.protocol;
            self.conf[self.appName][self.env].server.scheme     = serverOpt.scheme;
            self.conf[self.appName][self.env].server.engine     = serverOpt.engine;
            self.conf[self.appName][self.env].server.cachePath  = serverOpt.cachePath;

            serverOpt.port      = self.conf[self.appName][self.env].server.port = portsReverse[ self.appName +'@'+ self.projectName ][self.env][serverOpt.protocol][serverOpt.scheme];
            self.conf[self.appName][self.env].server.debugPort = getContext().debugPort;

            // engine.io options
            if ( ioServerOpt ) {
                serverOpt.ioServer = ioServerOpt
            }

            // #B212 — build the client-served routing maps ONCE here, engine-
            // agnostically, so /_gina/assets/routing.json serves identically under
            // every engine: isaac consumes these via serverOpt for its
            // precompressed-file fast-path, and the engine-agnostic onRequest
            // handler below serves the pre-stringified copies from memory (the
            // express path, which used to fall through to routing and 404).
            // Built BEFORE `new Engine(serverOpt)` — isaac reads them in its
            // constructor.
            // TODO - Use the per-bundle `routing` instead of `allRoutes` after having
            // filtered `allRoutes` vs `formsRules` to use only external routes exposed
            // by `"query"` validation
            var _clientRoutingAssets = buildClientRoutingAssets(serverOpt.allRoutes);
            serverOpt.clientRoutingAssets = _clientRoutingAssets;
            self._clientRoutingAssets = {
                full     : JSON.stringify(_clientRoutingAssets.full),
                stripped : JSON.stringify(_clientRoutingAssets.stripped)
            };
            // Slice 3 (#SPA1) — weak per-variant ETags, computed once: the maps are
            // boot-static, and the serve paths answer If-None-Match with a 304 under
            // `no-cache` (revalidate) semantics. This closes the staleness window the
            // old `max-age=86400` left open — a returning browser could dispatch on a
            // day-old table for up to 24h after a restart. Weak tags (`W/"…"`) so ONE
            // tag per variant covers isaac's content-encoded file representations too.
            self._clientRoutingAssets.fullEtag =
                'W/"' + crypto.createHash('sha1').update(self._clientRoutingAssets.full).digest('hex').substr(0, 16) + '"';
            self._clientRoutingAssets.strippedEtag =
                'W/"' + crypto.createHash('sha1').update(self._clientRoutingAssets.stripped).digest('hex').substr(0, 16) + '"';
            serverOpt.clientRoutingAssets.fullEtag     = self._clientRoutingAssets.fullEtag;
            serverOpt.clientRoutingAssets.strippedEtag = self._clientRoutingAssets.strippedEtag;

            Engine = require('./server.' + ((typeof (serverOpt.engine) != 'undefined' && serverOpt.engine != '') ? serverOpt.engine : 'express'));
            var engine = new Engine(serverOpt);

            // Swig engine is always initialised when the bundle has views —
            // it handles both swig-rendered pages and any thrown HTML error
            // pages (the framework error template is currently swig-only).
            // Nunjucks is loaded in parallel when the bundle explicitly
            // opts in via render.engine === 'nunjucks'; a missing nunjucks
            // package throws NUNJUCKS_NOT_INSTALLED here, terminating
            // bundle startup.
            if ( hasViews(self.appName) ) {
                initSwigEngine(self.conf[self.appName][self.env]);
                initNunjucksEngine(self.conf[self.appName][self.env]);
            }


            // setting timezone
            if (
                typeof(options.conf[self.appName][self.env].content.settings.region) != 'undefined'
                && typeof(options.conf[self.appName][self.env].content.settings.region.timeZone) != 'undefined'
            ) {
                process.env.TZ = options.conf[self.appName][self.env].content.settings.region.timeZone;
            }

            // #H13 — register routing.json-declared WebSocket routes (`"method": "ws"`).
            // Each such route names a connection-handler module via `param.wsHandler`,
            // resolved under the bundle's `channels/` dir. We register through the
            // engine's own `onWebSocket(path, handler)` (set up during `new Engine()`
            // above): on an http/2 isaac bundle with `enableConnectProtocol` it wires
            // the real dispatcher; otherwise it hits the warn-noop stub, so we never
            // write a registry nothing reads. This runs BEFORE the `configured` emit
            // (hence before the bundle's onInitialize), so a programmatic
            // `app.onWebSocket()` in onInitialize overrides a declaration here.
            // WS dispatch happens in the engine's extended-CONNECT handler — these
            // routes never reach handle()/router.route (the `:4816` method filter +
            // the method-keyed route cache keep a `ws` route from matching an HTTP
            // request, and the radix-trie candidate is method-filtered in the loop).
            var _wsRouting           = serverOpt.routing || {};
            var _wsRegistered        = {};
            var _wsUnsupportedWarned = false;
            for (var _wsRule in _wsRouting) {
                var _wsRoute = _wsRouting[_wsRule];
                if ( typeof(_wsRoute) != 'object' || _wsRoute === null || !/^ws$/i.test(_wsRoute.method || '') ) {
                    continue;
                }
                if ( typeof(engine.instance.onWebSocket) != 'function' ) {
                    if ( !_wsUnsupportedWarned ) {
                        console.warn('[ SERVER ] WebSocket route(s) declared but the `'+ serverOpt.engine +'` engine has no WebSocket support (requires the isaac engine with http2Options.enableConnectProtocol = true)');
                        _wsUnsupportedWarned = true;
                    }
                    continue;
                }
                var _wsName = ( _wsRoute.param && typeof(_wsRoute.param.wsHandler) == 'string' && _wsRoute.param.wsHandler != '' )
                    ? _wsRoute.param.wsHandler
                    : null;
                if ( !_wsName ) {
                    throw new Error('[ SERVER ] WebSocket route `'+ _wsRule +'` must declare `param.wsHandler` (the channels/<name> module to handle it).');
                }
                // #H13 slice 3a — optional per-route session options (maxPayload /
                // protocol / closeTimeout), threaded to lib.wsSession.accept via
                // onWebSocket. Present-but-not-an-object fails loudly at boot (mirrors
                // the wsHandler fail-fast); absent → null (accept defaults apply).
                if ( _wsRoute.param && typeof(_wsRoute.param.wsOptions) != 'undefined'
                        && ( typeof(_wsRoute.param.wsOptions) != 'object' || _wsRoute.param.wsOptions === null ) ) {
                    throw new Error('[ SERVER ] WebSocket route `'+ _wsRule +'`: `param.wsOptions` must be an object');
                }
                var _wsOptions = ( _wsRoute.param && typeof(_wsRoute.param.wsOptions) == 'object' && _wsRoute.param.wsOptions !== null )
                    ? _wsRoute.param.wsOptions
                    : null;
                var _wsFile = _(self.conf[self.appName][self.env].bundlesPath + '/' + self.appName + '/channels/' + _wsName + '.js', true);
                var _wsHandlerFn = null;
                try {
                    _wsHandlerFn = require(_wsFile);
                } catch (_wsErr) {
                    throw new Error('[ SERVER ] WebSocket route `'+ _wsRule +'`: channel module `channels/'+ _wsName +'.js` could not be loaded ('+ _wsFile +'):\n'+ _wsErr.message);
                }
                if ( typeof(_wsHandlerFn) != 'function' ) {
                    throw new Error('[ SERVER ] WebSocket route `'+ _wsRule +'`: channel module `channels/'+ _wsName +'.js` must export a function (session, request).');
                }
                // A route URL may be comma-separated (multi-url) — register each.
                var _wsUrls = String(_wsRoute.url || '').split(',');
                for (var _wsi = 0, _wsLen = _wsUrls.length; _wsi < _wsLen; ++_wsi) {
                    var _wsUrl = _wsUrls[_wsi].trim();
                    if ( !_wsUrl ) { continue; }
                    if ( _wsRegistered[_wsUrl] ) {
                        console.warn('[ SERVER ] WebSocket path `'+ _wsUrl +'` is declared by more than one `method:"ws"` route — last wins (`'+ _wsRule +'`)');
                    }
                    _wsRegistered[_wsUrl] = true;
                    // #H13 slice 3b — record the bundle/env this server serves (a server
                    // serves one bundle) so the dispatcher can build session.query. Set
                    // explicitly here (self.appName/self.env are guaranteed correct at
                    // boot) before onWebSocket, so its getContext fallback is skipped.
                    engine.instance._wsBundle = self.appName;
                    engine.instance._wsEnv    = self.env;
                    engine.instance.onWebSocket(_wsUrl, _wsHandlerFn, _wsOptions);
                }
            }

            // #DTO2 — resolve + register every routing.json-declared DTO at BOOT.
            // A route opts its payload into default-on validation with `param.dto`, and
            // shapes its JSON response with `param.responseDto`; both name a
            // `<bundle>/dtos/<name>.js` FACTORY module
            // (`module.exports = function (dto) { return dto.object({...}, 'X'); };`) —
            // the same convention `bundle:openapi` / `bundle:mcp` already read offline.
            //
            // Resolving HERE rather than lazily on the first request buys three things:
            //   * `dto.load()` re-runs the factory on EVERY call, so a per-request resolve
            //     would rebuild the DTO each time; registering once makes the request path
            //     an O(1) `dto.get()` off `process.gina._dtos` (no fs, no factory re-run).
            //   * a missing / broken DTO refuses to BOOT instead of silently disabling
            //     validation on that route in production (the #B57 "a failure must
            //     surface, never be swallowed into a success path" rule).
            //   * the `.toRules()` dry-run compiles a request DTO through the guard that
            //     rejects a `$` (server-fatal in the validator engine) — so it fails at
            //     deploy, not on a live request.
            // A DTO file edit therefore needs a bundle restart, exactly like routing.json,
            // forms and connectors.json.
            var _dtoRouting = serverOpt.routing || {};
            var _dtoSrcPath = self.conf[self.appName][self.env].bundlesPath + '/' + self.appName;
            var _dtoCount   = 0;
            for (var _dtoRule in _dtoRouting) {
                var _dtoRoute = _dtoRouting[_dtoRule];
                if ( typeof(_dtoRoute) != 'object' || _dtoRoute === null || !_dtoRoute.param ) {
                    continue;
                }
                var _dtoRefs = [
                    { key: 'dto',         name: _dtoRoute.param.dto,         isRequestDto: true  },
                    { key: 'responseDto', name: _dtoRoute.param.responseDto, isRequestDto: false }
                ];
                for (var _dtoI = 0; _dtoI < _dtoRefs.length; ++_dtoI) {
                    var _dtoRef = _dtoRefs[_dtoI];
                    if ( typeof(_dtoRef.name) == 'undefined' || _dtoRef.name === null || _dtoRef.name === '' ) {
                        continue;
                    }
                    if ( typeof(_dtoRef.name) != 'string' ) {
                        throw new Error('[ SERVER ] Route `'+ _dtoRule +'`: `param.'+ _dtoRef.key +'` must be a string (the `dtos/<name>.js` module to load).');
                    }
                    var _dtoObj = null;
                    try {
                        _dtoObj = lib.dto.load(_dtoSrcPath, _dtoRef.name);
                    } catch (_dtoErr) {
                        throw new Error('[ SERVER ] Route `'+ _dtoRule +'`: DTO module `dtos/'+ _dtoRef.name +'.js` could not be loaded from `'+ _dtoSrcPath +'`:\n'+ _dtoErr.message);
                    }
                    if ( !_dtoObj ) {
                        throw new Error('[ SERVER ] Route `'+ _dtoRule +'` declares `param.'+ _dtoRef.key +'` `'+ _dtoRef.name +'` but `'+ _dtoSrcPath +'/dtos/'+ _dtoRef.name +'.js` is missing (or exports neither a `dto.object(...)` nor a factory returning one).');
                    }
                    if ( _dtoRef.isRequestDto ) {
                        try {
                            _dtoObj.toRules();
                        } catch (_dtoRulesErr) {
                            throw new Error('[ SERVER ] Route `'+ _dtoRule +'`: `param.dto` `'+ _dtoRef.name +'` cannot drive the validator — '+ _dtoRulesErr.message);
                        }
                    }
                    ++_dtoCount;
                }
            }
            if ( _dtoCount > 0 ) {
                console.debug('[ BUNDLE ][ server ][ init ] Registered '+ _dtoCount +' route DTO reference(s) for [ '+ self.appName +' ]');
            }

            // #FIN3 — resolve + register every routing.json-declared message
            // validator at BOOT. A route opts its raw request body into
            // application-supplied schema validation with `param.messageValidator`,
            // naming a `<bundle>/message-validators/<name>.js` FACTORY module
            // (`module.exports = function (ctx) { return function validate(document, req) { ... }; };`).
            // The factory runs HERE, synchronously, once per name — an expensive
            // schema compile happens at deploy time, and a missing / broken
            // validator module refuses to BOOT instead of silently disabling
            // validation on that route in production (the #B57 rule, mirroring
            // the DTO registrar above). A validator file edit therefore needs a
            // bundle restart, exactly like DTOs, routing.json, forms and
            // connectors.json.
            var _msvRouting = serverOpt.routing || {};
            var _msvSrcPath = self.conf[self.appName][self.env].bundlesPath + '/' + self.appName;
            var _msvCount   = 0;
            for (var _msvRule in _msvRouting) {
                var _msvRoute = _msvRouting[_msvRule];
                if ( typeof(_msvRoute) != 'object' || _msvRoute === null || !_msvRoute.param ) {
                    continue;
                }
                var _msvName = _msvRoute.param.messageValidator;
                if ( typeof(_msvName) == 'undefined' || _msvName === null || _msvName === '' ) {
                    continue;
                }
                if ( typeof(_msvName) != 'string' ) {
                    throw new Error('[ SERVER ] Route `'+ _msvRule +'`: `param.messageValidator` must be a string (the `message-validators/<name>.js` module to load).');
                }
                var _msvFn = null;
                try {
                    _msvFn = lib.messageValidator.register(_msvSrcPath, _msvName, { bundle: self.appName, env: self.env });
                } catch (_msvErr) {
                    throw new Error('[ SERVER ] Route `'+ _msvRule +'`: message validator `message-validators/'+ _msvName +'.js` could not be registered from `'+ _msvSrcPath +'`:\n'+ _msvErr.message);
                }
                if ( !_msvFn ) {
                    throw new Error('[ SERVER ] Route `'+ _msvRule +'` declares `param.messageValidator` `'+ _msvName +'` but `'+ _msvSrcPath +'/message-validators/'+ _msvName +'.js` is missing, does not export a factory function, or its factory did not return a validate function (the contract is `module.exports = function (ctx) { return function validate(document, req) { ... }; };`).');
                }
                ++_msvCount;
            }
            if ( _msvCount > 0 ) {
                console.debug('[ BUNDLE ][ server ][ init ] Registered '+ _msvCount +' route message validator(s) for [ '+ self.appName +' ]');
            }

            // #COMPLY1 — lint every declared authorization flag and resolve the login
            // bounce target at BOOT. A route gates its access with `param.requireAuth`;
            // `lib/authz-gate` enforces it at both core/router.js dispatch sites.
            //
            // Resolving HERE rather than per request buys the same three things the DTO
            // registrar above does:
            //   * the request path costs an O(1) read off `process.gina._authConf` — never
            //     a config clone per unauthenticated hit (which an unauthenticated caller
            //     would otherwise be free to amplify). The `_adminAllowList` precedent.
            //   * an author error — a non-boolean flag, a login route this bundle does not
            //     declare — refuses to BOOT instead of silently leaving a route ungated in
            //     production (the #B57 "a failure must surface, never be swallowed into a
            //     success path" rule). A truthy STRING is the motivating case: the gate
            //     tests `=== true`, so `"requireAuth": "true"` would silently NOT gate.
            //   * `settings.json` is boot config (never hot-reloaded), so there is nothing
            //     to re-read: an `auth` change needs a bundle restart, exactly like
            //     routing.json, forms and connectors.json.
            var _authzRouting  = serverOpt.routing || {};
            var _authzSettings = (
                self.conf[self.appName][self.env].content
                && self.conf[self.appName][self.env].content.settings
                && self.conf[self.appName][self.env].content.settings.auth
            ) ? self.conf[self.appName][self.env].content.settings.auth : {};
            if ( typeof(_authzSettings) != 'object' || _authzSettings === null || Array.isArray(_authzSettings) ) {
                throw new Error('[ SERVER ] `settings.json > auth` must be an object.');
            }

            // #COMPLY10 — deny-by-default authorization: an un-annotated route is GATED
            // rather than open, and opts back out with `param.public: true`. Read HERE,
            // before the per-route loop, because two of that loop's refusals only apply
            // while the mode is on. Strict boolean for the same reason as every sibling
            // flag in this block: a truthy string would leave every un-annotated route
            // silently UNGATED while the operator believes the bundle is deny-by-default
            // — the quietly-OFF class this whole block exists to refuse.
            var _authzDefaultDeny = false;
            if ( typeof(_authzSettings.requireAuthByDefault) != 'undefined' ) {
                if ( typeof(_authzSettings.requireAuthByDefault) != 'boolean' ) {
                    throw new Error('[ SERVER ] `settings.json > auth.requireAuthByDefault` must be a boolean — got '+ JSON.stringify(_authzSettings.requireAuthByDefault) +'. A truthy string would leave every un-annotated route silently UNGATED, so the boot refuses instead.');
                }
                _authzDefaultDeny = _authzSettings.requireAuthByDefault;
            }

            var _authzSrcPath     = self.conf[self.appName][self.env].bundlesPath + '/' + self.appName;
            var _authzCount       = 0;
            var _authzRolesCount  = 0;
            var _authzPolicyCount = 0;
            var _authzPublicCount = 0;
            var _authzDefaultGatedCount = 0;
            var _authzWsUngated   = [];   // #B159 — ws routes the mode would otherwise count as gated
            for (var _authzRule in _authzRouting) {
                var _authzRoute = _authzRouting[_authzRule];
                if ( typeof(_authzRoute) != 'object' || _authzRoute === null || !_authzRoute.param ) {
                    continue;
                }
                var _authzGated = false;
                if ( typeof(_authzRoute.param.requireAuth) != 'undefined' ) {
                    if ( typeof(_authzRoute.param.requireAuth) != 'boolean' ) {
                        throw new Error('[ SERVER ] Route `'+ _authzRule +'`: `param.requireAuth` must be a boolean (got `'+ typeof(_authzRoute.param.requireAuth) +'`). A truthy string would NOT gate the route.');
                    }
                    if ( _authzRoute.param.requireAuth === true ) {
                        _authzGated = true;
                    }
                }
                // `param.roles` — a non-empty array of non-empty strings; IMPLIES
                // `requireAuth` at the gate (an unauthenticated caller can hold no
                // role). Any OTHER declared shape refuses to boot: the gate only
                // enforces a non-empty string array, so `"roles": null`, a bare
                // string or an empty array would be silently ungated — the same
                // quietly-OFF class as a truthy-string `requireAuth`.
                if ( typeof(_authzRoute.param.roles) != 'undefined' ) {
                    var _authzRoles = _authzRoute.param.roles;
                    if ( !Array.isArray(_authzRoles) || _authzRoles.length === 0 ) {
                        throw new Error('[ SERVER ] Route `'+ _authzRule +'`: `param.roles` must be a non-empty array of role names (got '+ ( Array.isArray(_authzRoles) ? 'an empty array' : '`'+ typeof(_authzRoles) +'`' ) +'). Any other shape would NOT gate the route.');
                    }
                    for (var _authzRi = 0; _authzRi < _authzRoles.length; ++_authzRi) {
                        if ( typeof(_authzRoles[_authzRi]) != 'string' || _authzRoles[_authzRi] === '' ) {
                            throw new Error('[ SERVER ] Route `'+ _authzRule +'`: `param.roles` must contain only non-empty strings (index '+ _authzRi +' is '+ ( _authzRoles[_authzRi] === '' ? 'an empty string' : 'a `'+ typeof(_authzRoles[_authzRi]) +'`' ) +').');
                        }
                    }
                    _authzGated = true;
                    ++_authzRolesCount;
                }
                // `param.policy` — a `<bundle>/policies/<name>.js` module exporting a
                // plain `function (user, req) { return boolean; }`, registered HERE at
                // boot (the DTO registrar above is the mould). Registering once makes the
                // request path an O(1) lookup off `process.gina._policies` — no fs, no
                // re-require per request (which would also feed the dev-mode
                // `module.children` leak class, #B32). It also means a missing, broken or
                // ASYNC policy refuses to BOOT rather than denying its route on every
                // request in production: an async policy's promise return is truthy but
                // never `=== true`, so the gate's strict allow would leave the route
                // permanently, silently 403ing. A policy file edit therefore needs a
                // bundle restart, exactly like routing.json, forms and connectors.json.
                if ( typeof(_authzRoute.param.policy) != 'undefined' ) {
                    var _authzPolicy = _authzRoute.param.policy;
                    if ( typeof(_authzPolicy) != 'string' || _authzPolicy === '' ) {
                        throw new Error('[ SERVER ] Route `'+ _authzRule +'`: `param.policy` must be a non-empty string (the `policies/<name>.js` module to load). Any other shape would NOT gate the route.');
                    }
                    var _authzPolicyFn = null;
                    try {
                        _authzPolicyFn = lib.authzGate.registerPolicy(_authzSrcPath, _authzPolicy);
                    } catch (_authzPolicyErr) {
                        throw new Error('[ SERVER ] Route `'+ _authzRule +'`: policy module `policies/'+ _authzPolicy +'.js` could not be registered from `'+ _authzSrcPath +'`:\n'+ _authzPolicyErr.message);
                    }
                    if ( !_authzPolicyFn ) {
                        throw new Error('[ SERVER ] Route `'+ _authzRule +'` declares `param.policy` `'+ _authzPolicy +'` but `'+ _authzSrcPath +'/policies/'+ _authzPolicy +'.js` is missing (or does not export a function).');
                    }
                    _authzGated = true;
                    ++_authzPolicyCount;
                }
                // #B159 — a WebSocket route can declare an authorization key, but nothing
                // can ever enforce it. A `method: "ws"` route is registered on the engine's
                // extended-CONNECT handler and never reaches `handle()` / `router.route`,
                // which is where `lib/authz-gate` runs — so the gate is not merely skipped,
                // it is unreachable by construction. Left accepted, the route would lint
                // clean, boot, AND be counted in the "Registered N authorization-gated
                // route(s)" line below: the framework would actively confirm an illusion.
                // That is precisely the quietly-OFF class the rest of this block refuses
                // (a truthy-string `requireAuth` already refuses to boot), so a
                // structurally unenforceable one must refuse too. `/^ws$/i` is the SAME
                // predicate the ws registration uses, so the two can never disagree about
                // what a ws route is. Placed after the requireAuth/roles/policy blocks so
                // `_authzGated` is already final and one check covers all three keys.
                if ( _authzGated && /^ws$/i.test(_authzRoute.method || '') ) {
                    throw new Error('[ SERVER ] Route `'+ _authzRule +'`: it is a `method: "ws"` route, so `param.requireAuth` / `param.roles` / `param.policy` can never be enforced on it — a WebSocket handshake is answered by the engine\'s extended-CONNECT handler and never reaches the authorization gate. Authenticate inside the `wsHandler` instead: it receives the full request, so it can inspect headers and cookies and close the socket itself. Remove the authorization key to make that explicit.');
                }
                // #COMPLY10 — `param.public`: the explicit exemption from
                // `auth.requireAuthByDefault`. Linted UNCONDITIONALLY, mode on or off:
                // a malformed exemption is an author error worth surfacing at the
                // deploy that INTRODUCES it, not at the later one that enables the mode
                // (the audit block's rationale below, applied here). Placed after the
                // requireAuth/roles/policy blocks so `_authzGated` is already final.
                if ( typeof(_authzRoute.param.public) != 'undefined' ) {
                    if ( typeof(_authzRoute.param.public) != 'boolean' ) {
                        throw new Error('[ SERVER ] Route `'+ _authzRule +'`: `param.public` must be a boolean (got `'+ typeof(_authzRoute.param.public) +'`). A truthy string would NOT exempt the route from `auth.requireAuthByDefault`.');
                    }
                    if ( _authzRoute.param.public === true ) {
                        // Same axis, opposite answers. Neither reading is safe: honouring
                        // `public` silently un-gates an explicitly gated route (fail-open),
                        // and honouring the gate silently discards what the author wrote.
                        // `roles` and `policy` both IMPLY `requireAuth`, so they collapse
                        // into the same contradiction.
                        if ( _authzGated ) {
                            throw new Error('[ SERVER ] Route `'+ _authzRule +'`: `param.public: true` contradicts `param.requireAuth` / `param.roles` / `param.policy` on the same route — it cannot be both exempt from authentication and gated by it. Drop one.');
                        }
                        ++_authzPublicCount;
                    }
                }
                // #B158 — a GATED route must not also be cached, however it is gated.
                // Both render-cache serve points run BEFORE the authorization gate: the
                // engine-agnostic read serves and RETURNS ahead of `router.route` (inside
                // which the gate runs), and isaac's runs pre-routing, before `req.routing`
                // even exists — so neither can consult authorization even in principle.
                // The key is `<release>:<kind>:<bundle>:<url>` with no principal component,
                // so a cached gated route replays the first authenticated caller's rendered
                // body to every later anonymous one. Measured live on an isolated boot: a
                // Bearer-authenticated render was served verbatim, same body and same
                // render nonce, to the next unauthenticated caller, while the identical
                // route WITHOUT `cache` correctly answered 401.
                //
                // #COMPLY10 shipped this refusal scoped to MODE-gated routes only, so that
                // enabling the mode could not break a working bundle; the explicitly
                // annotated case it deliberately left open is the pre-existing hole, and
                // closing it here is what #B158 is. Explicitly gated + cached is therefore
                // now refused in BOTH modes.
                var _authzRouteGated = _authzGated || ( _authzDefaultDeny && _authzRoute.param.public !== true );
                if (
                    _authzRouteGated
                    && typeof(_authzRoute.cache) != 'undefined'
                    && _authzRoute.cache
                ) {
                    throw new Error('[ SERVER ] Route `'+ _authzRule +'`: '+ ( _authzGated ? '`param.requireAuth` / `param.roles` / `param.policy` gate this route' : '`auth.requireAuthByDefault` gates this route' ) +', but it also declares `cache`. The render cache is read BEFORE authorization runs and its key carries no user identity, so the first authenticated response would be replayed to unauthenticated callers. Drop `cache`'+ ( _authzGated ? ', or remove the authorization keys if the route is meant to be open to everyone.' : ', or mark the route `"public": true` if it is meant to be cacheable and open.' ));
                }
                if ( _authzDefaultDeny && !_authzGated && _authzRoute.param.public !== true ) {
                    // #B159 — the mode cannot gate a ws route either (same unreachable
                    // gate). Counting one would repeat the illusion the explicit refusal
                    // above exists to stop, so ws routes are excluded from the tally and
                    // named once instead. A WARN rather than a refusal on purpose: an
                    // explicit key is an author asserting something false, whereas the
                    // mode sweeps up every un-annotated route, so refusing here would
                    // break a working ws bundle the moment the mode is switched on — the
                    // exact regression #COMPLY10 was scoped to avoid.
                    if ( /^ws$/i.test(_authzRoute.method || '') ) {
                        _authzWsUngated.push(_authzRule);
                    } else {
                        ++_authzDefaultGatedCount;
                    }
                }
                if ( _authzGated ) {
                    ++_authzCount;
                }
            }

            // The login bounce target: a routing.json RULE NAME (recommended — config.js
            // has already composed the bundle's webroot into `routing[rule].url`, so the
            // resolved path is correct by construction) or an absolute path, used verbatim.
            // Either way the emitted Location stays root-relative — same-origin by
            // construction, which keeps the bounce clear of the proxy-host composition
            // family (#B65/#B66/#B67) entirely.
            var _authzLoginRoute = null;
            if (
                typeof(_authzSettings.loginRoute) != 'undefined'
                && _authzSettings.loginRoute !== null
                && _authzSettings.loginRoute !== ''
            ) {
                if ( typeof(_authzSettings.loginRoute) != 'string' ) {
                    throw new Error('[ SERVER ] `settings.json > auth.loginRoute` must be a string (a routing.json rule name, or an absolute path like `/login`) or null.');
                }
                var _authzPath = _authzSettings.loginRoute;
                if ( _authzPath.charAt(0) !== '/' ) {
                    // core/config.js re-keys every rule to `<rule.toLowerCase()>@<bundle>`
                    // at normalisation, so accept the name as the author declared it in
                    // routing.json — and an explicit `<rule>@<bundle>` too, for a login
                    // route this bundle inherits from another one.
                    var _authzTarget = _authzRouting[_authzPath]
                        || _authzRouting[ _authzPath.toLowerCase() +'@'+ self.appName ];
                    if ( !_authzTarget ) {
                        throw new Error('[ SERVER ] `settings.json > auth.loginRoute` names route `'+ _authzPath +'`, which this bundle does not declare. Use an existing routing.json rule name, or an absolute path like `/login`.');
                    }
                    if ( typeof(_authzTarget.url) != 'string' ) {
                        throw new Error('[ SERVER ] `settings.json > auth.loginRoute` names route `'+ _authzPath +'`, which does not resolve to a single url. Point it at a route declaring one url, or use an absolute path.');
                    }
                    _authzPath = _authzTarget.url;
                }
                if ( /\:/.test(_authzPath) ) {
                    throw new Error('[ SERVER ] `settings.json > auth.loginRoute` resolves to `'+ _authzPath +'`, which is parameterized. The login bounce target must be a fixed url.');
                }
                _authzLoginRoute = _authzPath;
            }

            // #COMPLY10 — the lockout check. Under deny-by-default a login route that
            // is not itself exempt bounces to ITSELF: the gate 302s an unauthenticated
            // caller to the login page, which is gated, which 302s again — the browser
            // gives up with ERR_TOO_MANY_REDIRECTS and the bundle has locked out every
            // visitor. It is statically detectable, so it refuses at boot rather than
            // at the first visitor — the same trade this block already makes for a
            // non-boolean `requireAuth` (one deploy-time error instead of a production
            // incident).
            if ( _authzDefaultDeny ) {
                if ( !_authzLoginRoute ) {
                    // Legal and coherent for a pure API / machine-caller bundle (#MS3):
                    // with no bounce target every unauthenticated request simply gets a
                    // 401, which is the correct answer for a service. Warn, never refuse
                    // — the `auth.machine.enabled`-with-no-callers precedent below:
                    // legal, but worth seeing at boot.
                    console.warn('[ SERVER ] `auth.requireAuthByDefault` is true and no `auth.loginRoute` is configured — every unauthenticated request to an un-annotated route gets a 401. Correct for an API bundle; a browser-facing bundle almost certainly wants a login route.');
                } else {
                    var _authzLoginTarget = null;
                    for (var _authzLr in _authzRouting) {
                        var _authzLrRoute = _authzRouting[_authzLr];
                        if ( typeof(_authzLrRoute) != 'object' || _authzLrRoute === null || typeof(_authzLrRoute.url) != 'string' ) {
                            continue;
                        }
                        // `url` may carry the `,`-separated multi-url form (config.js
                        // writes it for the webroot auto-redirect), so a match on any
                        // member counts.
                        if ( _authzLrRoute.url.split(',').indexOf(_authzLoginRoute) > -1 ) {
                            _authzLoginTarget = _authzLrRoute;
                            break;
                        }
                    }
                    if ( !_authzLoginTarget ) {
                        throw new Error('[ SERVER ] `auth.requireAuthByDefault` is true, but `auth.loginRoute` (`'+ _authzLoginRoute +'`) does not resolve to a route this bundle declares, so the boot cannot verify the login page is reachable without authenticating. Under deny-by-default an unverifiable login target is exactly the config that locks every visitor out — point `auth.loginRoute` at a routing.json rule name.');
                    }
                    if ( !_authzLoginTarget.param || _authzLoginTarget.param.public !== true ) {
                        throw new Error('[ SERVER ] `auth.requireAuthByDefault` is true, but the login route (`'+ _authzLoginRoute +'`) is not marked `"public": true`. The mode would gate it, so an unauthenticated visitor is bounced to the login page, which bounces again — an infinite redirect that locks out every visitor. Add `"public": true` to that route\'s `param`.');
                    }
                }
            }

            // #MS3 — machine-caller authentication: lint + precompute at BOOT.
            // `settings.json > auth.machine` declares named machine callers
            // (services, job runners, external systems) whose
            // `Authorization: Bearer <key>` admits them through the authz gate
            // without a session. Same three boot-resolution buys as the
            // requireAuth/roles/policy lint above: an O(1) request-path read
            // off `process.gina._authConf.machine`, fail-fast on author error
            // (the quietly-OFF class — a truthy-string `enabled` or a
            // malformed caller must never leave the control silently off or a
            // caller silently locked out), and boot-config semantics (an
            // `auth.machine` change needs a bundle restart). Keys support
            // `${secret:KEY}` — resolved by config-load (lib/secrets) before
            // this block runs, so it sees the real value. Only the sha256 hash
            // of each key is RETAINED: the gate compares fixed-length digests
            // (`crypto.timingSafeEqual`, no length oracle) and the raw key
            // does not linger in process memory past this loop.
            var _authzMachine = { enabled: false, callers: {} };
            if ( typeof(_authzSettings.machine) != 'undefined' && _authzSettings.machine !== null ) {
                if ( typeof(_authzSettings.machine) != 'object' || Array.isArray(_authzSettings.machine) ) {
                    throw new Error('[ SERVER ] `settings.json > auth.machine` must be an object.');
                }
                var _authzMachineConf = _authzSettings.machine;
                if ( typeof(_authzMachineConf.enabled) != 'undefined' && typeof(_authzMachineConf.enabled) != 'boolean' ) {
                    throw new Error('[ SERVER ] `settings.json > auth.machine.enabled` must be a boolean (got `'+ typeof(_authzMachineConf.enabled) +'`). A truthy string would silently NOT enable machine authentication.');
                }
                _authzMachine.enabled = ( _authzMachineConf.enabled === true );
                if ( typeof(_authzMachineConf.callers) != 'undefined' && _authzMachineConf.callers !== null ) {
                    if ( typeof(_authzMachineConf.callers) != 'object' || Array.isArray(_authzMachineConf.callers) ) {
                        throw new Error('[ SERVER ] `settings.json > auth.machine.callers` must be an object map (callerName -> { key, roles }).');
                    }
                    for (var _authzCn in _authzMachineConf.callers) {
                        var _authzCaller = _authzMachineConf.callers[_authzCn];
                        if ( typeof(_authzCaller) != 'object' || _authzCaller === null || Array.isArray(_authzCaller) ) {
                            throw new Error('[ SERVER ] `auth.machine.callers > '+ _authzCn +'` must be an object ({ key, roles }).');
                        }
                        if ( typeof(_authzCaller.key) != 'string' || _authzCaller.key === '' ) {
                            throw new Error('[ SERVER ] `auth.machine.callers > '+ _authzCn +'`: `key` must be a non-empty string. Use a `${secret:KEY}` placeholder to keep the value out of the config file.');
                        }
                        // `roles` — OPTIONAL, but when declared: the same lint as route
                        // `param.roles` (a non-empty-strings array). Absent means the
                        // caller holds NO roles: it can pass `requireAuth`-only routes,
                        // never role-gated ones.
                        var _authzCallerRoles = [];
                        if ( typeof(_authzCaller.roles) != 'undefined' && _authzCaller.roles !== null ) {
                            if ( !Array.isArray(_authzCaller.roles) ) {
                                throw new Error('[ SERVER ] `auth.machine.callers > '+ _authzCn +'`: `roles` must be an array of role names.');
                            }
                            for (var _authzCri = 0; _authzCri < _authzCaller.roles.length; ++_authzCri) {
                                if ( typeof(_authzCaller.roles[_authzCri]) != 'string' || _authzCaller.roles[_authzCri] === '' ) {
                                    throw new Error('[ SERVER ] `auth.machine.callers > '+ _authzCn +'`: `roles` must contain only non-empty strings (index '+ _authzCri +' is '+ ( _authzCaller.roles[_authzCri] === '' ? 'an empty string' : 'a `'+ typeof(_authzCaller.roles[_authzCri]) +'`' ) +').');
                                }
                            }
                            _authzCallerRoles = _authzCaller.roles.slice();
                        }
                        _authzMachine.callers[_authzCn] = {
                            keyHash : crypto.createHash('sha256').update(_authzCaller.key, 'utf8').digest(),
                            roles   : _authzCallerRoles
                        };
                    }
                }
                // `authenticator` — OPTIONAL: names a `<bundle>/authenticators/<name>.js`
                // module (the `policies/<name>.js` shape, applied to authN — the gate
                // runs it AFTER the built-in caller map, for any sync-checkable
                // credential). Registered HERE at boot, the registerPolicy mould: a
                // missing, broken or ASYNC module refuses to BOOT rather than silently
                // never admitting. Linted + registered even while `enabled` is false,
                // so a broken file surfaces at deploy time, not at the later enable.
                if ( typeof(_authzMachineConf.authenticator) != 'undefined' && _authzMachineConf.authenticator !== null ) {
                    if ( typeof(_authzMachineConf.authenticator) != 'string' || _authzMachineConf.authenticator === '' ) {
                        throw new Error('[ SERVER ] `settings.json > auth.machine.authenticator` must be a non-empty string (the `authenticators/<name>.js` module to load) or null.');
                    }
                    var _authzAuthFn = null;
                    try {
                        _authzAuthFn = lib.authzGate.registerAuthenticator(_authzSrcPath, _authzMachineConf.authenticator);
                    } catch (_authzAuthErr) {
                        throw new Error('[ SERVER ] `auth.machine.authenticator`: module `authenticators/'+ _authzMachineConf.authenticator +'.js` could not be registered from `'+ _authzSrcPath +'`:\n'+ _authzAuthErr.message);
                    }
                    if ( !_authzAuthFn ) {
                        throw new Error('[ SERVER ] `auth.machine.authenticator` names `'+ _authzMachineConf.authenticator +'` but `'+ _authzSrcPath +'/authenticators/'+ _authzMachineConf.authenticator +'.js` is missing (or does not export a function).');
                    }
                    _authzMachine.authenticator = _authzMachineConf.authenticator;
                }
                if ( _authzMachine.enabled === true && Object.keys(_authzMachine.callers).length === 0 && !_authzMachine.authenticator ) {
                    // Legal (fail-closed — nothing can authenticate), but a mis-pasted
                    // config should be visible at boot rather than debugged per request.
                    console.warn('[ SERVER ] `auth.machine.enabled` is true but `auth.machine.callers` declares no caller and no `authenticator` is named — machine authentication is ON but can admit nobody.');
                }
            }
            // #COMPLY10 — the per-bundle posture map. MERGED mode runs every bundle of a
            // project in ONE process and this write happens once per init(), so a FLAT
            // mode flag would be decided by whichever bundle booted LAST: a bundle that
            // opted into deny-by-default would silently un-gate every one of its routes
            // the moment a sibling booted without the key. That is a fail-OPEN, and an
            // invisible one — the single failure direction this control must not have.
            // Reading the existing map first preserves what earlier bundles wrote.
            // (`loginRoute` / `machine` stay flat — pre-existing behaviour, untouched.)
            var _authzByBundle = (
                process.gina._authConf
                && process.gina._authConf.byBundle
                && typeof(process.gina._authConf.byBundle) == 'object'
            ) ? process.gina._authConf.byBundle : {};
            _authzByBundle[self.appName] = { requireAuthByDefault: _authzDefaultDeny };
            process.gina._authConf = { loginRoute: _authzLoginRoute, machine: _authzMachine };
            process.gina._authConf.byBundle = _authzByBundle;
            if ( _authzMachine.enabled === true ) {
                console.debug('[ BUNDLE ][ server ][ init ] Machine-caller authentication ENABLED — '+ Object.keys(_authzMachine.callers).length +' caller(s)'
                    + ( _authzMachine.authenticator ? ' + authenticator `'+ _authzMachine.authenticator +'`' : '' )
                    +' for [ '+ self.appName +' ]');
            }
            if ( _authzCount > 0 ) {
                var _authzParts = [];
                if ( _authzRolesCount > 0 )  { _authzParts.push(_authzRolesCount +' role-gated'); }
                if ( _authzPolicyCount > 0 ) { _authzParts.push(_authzPolicyCount +' policy-gated'); }
                console.debug('[ BUNDLE ][ server ][ init ] Registered '+ _authzCount +' authorization-gated route(s)'
                    + ( _authzParts.length > 0 ? ' ('+ _authzParts.join(', ') +')' : '' )
                    +' for [ '+ self.appName +' ]'
                    + ( _authzLoginRoute ? ' — login bounce: '+ _authzLoginRoute : ' — no `auth.loginRoute`: unauthenticated requests get a 401' ));
            }
            if ( _authzDefaultDeny ) {
                // console.info, NOT console.debug — the shipped default log_level filters
                // debug, and under a mode that can lock a bundle out, the count of newly
                // gated routes is the single number an operator needs confirmed at deploy.
                console.info('[ BUNDLE ][ server ][ init ] Deny-by-default authorization ENABLED for [ '+ self.appName +' ] — '+ _authzDefaultGatedCount +' un-annotated route(s) now require authentication, '+ _authzPublicCount +' marked `public`');
                // #B159 — say plainly which routes the mode does NOT reach. Silence here
                // would read as "everything is gated now", which is the whole failure mode.
                if ( _authzWsUngated.length > 0 ) {
                    console.warn('[ BUNDLE ][ server ][ init ] `auth.requireAuthByDefault` does NOT cover '+ _authzWsUngated.length +' WebSocket route(s) — '+ _authzWsUngated.join(', ') +'. A ws handshake never reaches the authorization gate, so these stay open unless their `wsHandler` authenticates. Mark them `"public": true` once you have confirmed that is intended.');
                }
            }

            // ── #COMPLY2 — audit trail: boot resolve + fail-fast lint ──
            // Sibling of the #COMPLY1 registrar above and the #DTO2 registrar before
            // it, and FATAL like both (unlike #RWATCH below): every `throw` here
            // lands in init()'s enclosing catch, which produces the #B57 shape
            // (emerg + synchronous stderr flush + exit(1)) — an audit trail that
            // cannot write is a compliance control that is quietly OFF, so the boot
            // refuses instead. Shapes are linted UNCONDITIONALLY (a malformed block
            // with `enabled: false` is still an author error better surfaced now);
            // the store is built + adopted only when enabled.
            var _auditSettings = (
                self.conf[self.appName][self.env].content
                && self.conf[self.appName][self.env].content.settings
                && self.conf[self.appName][self.env].content.settings.audit
            ) ? self.conf[self.appName][self.env].content.settings.audit : {};
            if ( typeof(_auditSettings) != 'object' || _auditSettings === null || Array.isArray(_auditSettings) ) {
                throw new Error('[ SERVER ] `settings.json > audit` must be an object.');
            }
            var _auditEnabled = false;
            if ( typeof(_auditSettings.enabled) != 'undefined' ) {
                if ( typeof(_auditSettings.enabled) != 'boolean' ) {
                    throw new Error('[ SERVER ] `settings.json > audit.enabled` must be a boolean — got '+ JSON.stringify(_auditSettings.enabled) +'. A truthy string would leave the audit trail silently OFF, so the boot refuses instead.');
                }
                _auditEnabled = _auditSettings.enabled;
            }
            if ( _auditSettings.file != null && ( typeof(_auditSettings.file) != 'string' || _auditSettings.file === '' ) ) {
                throw new Error('[ SERVER ] `settings.json > audit.file` must be a non-empty string (or null for the default `<project>/logs` destination).');
            }
            if ( typeof(_auditSettings.store) != 'undefined' && _auditSettings.store !== null && ( typeof(_auditSettings.store) != 'string' || _auditSettings.store === '' ) ) {
                throw new Error('[ SERVER ] `settings.json > audit.store` must be a non-empty connectors.json entry name.');
            }
            if ( typeof(_auditSettings.actorKey) != 'undefined' && ( typeof(_auditSettings.actorKey) != 'string' || _auditSettings.actorKey === '' ) ) {
                throw new Error('[ SERVER ] `settings.json > audit.actorKey` must be a non-empty string.');
            }
            if ( typeof(_auditSettings.events) != 'undefined' ) {
                if ( typeof(_auditSettings.events) != 'object' || _auditSettings.events === null || Array.isArray(_auditSettings.events) ) {
                    throw new Error('[ SERVER ] `settings.json > audit.events` must be an object.');
                }
                if ( typeof(_auditSettings.events.authz) != 'undefined' && typeof(_auditSettings.events.authz) != 'boolean' ) {
                    throw new Error('[ SERVER ] `settings.json > audit.events.authz` must be a boolean — any other type would not opt out.');
                }
            }
            if ( _auditSettings.store && _auditSettings.file ) {
                throw new Error('[ SERVER ] `settings.json > audit`: `store` and `file` are mutually exclusive — pick one backend.');
            }
            // ── #COMPLY2 slice 3 — tamper-evidence chain: shape lint (unconditional,
            // like the rest of the audit lint family: a malformed block with the
            // chain OFF is still an author error better surfaced now).
            if ( typeof(_auditSettings.chain) != 'undefined' ) {
                if ( typeof(_auditSettings.chain) != 'object' || _auditSettings.chain === null || Array.isArray(_auditSettings.chain) ) {
                    throw new Error('[ SERVER ] `settings.json > audit.chain` must be an object.');
                }
                if ( typeof(_auditSettings.chain.enabled) != 'undefined' && typeof(_auditSettings.chain.enabled) != 'boolean' ) {
                    throw new Error('[ SERVER ] `settings.json > audit.chain.enabled` must be a boolean — got '+ JSON.stringify(_auditSettings.chain.enabled) +'. A truthy string would leave tamper-evidence silently OFF, so the boot refuses instead.');
                }
                if ( typeof(_auditSettings.chain.secret) != 'undefined' && ( typeof(_auditSettings.chain.secret) != 'string' || _auditSettings.chain.secret === '' ) ) {
                    throw new Error('[ SERVER ] `settings.json > audit.chain.secret` must be a non-empty string.');
                }
                if ( typeof(_auditSettings.chain.secret) == 'string' && /\$\{/.test(_auditSettings.chain.secret) ) {
                    throw new Error('[ SERVER ] `settings.json > audit.chain.secret` carries an unresolved `${...}` placeholder — only the anchored `${secret:KEY}` form is substituted at config load; bare `${VAR}` and mixed strings pass through as literals. Use `${secret:KEY}` with the variable exported in the environment the bundle starts from, or set GINA_AUDIT_SECRET.');
                }
            }
            var _auditChainEnabled = !!( _auditSettings.chain && _auditSettings.chain.enabled === true );
            if ( _auditChainEnabled && !_auditEnabled ) {
                console.warn('[ SERVER ] `audit.chain.enabled` is true but `audit.enabled` is false — the audit trail (and with it the chain) is OFF for [ '+ self.appName +' ].');
            }
            // Merged mode (shared port ⇒ one process) starts ONE trail — the
            // starting bundle's. A sibling that declares `audit.enabled: true`
            // is silently ignored otherwise (its block parses into envConf and
            // nothing ever reads it — runtime-measured 2026-07-26), which is
            // the quietly-OFF class this lint family exists to prevent: say so.
            if ( self.isStandalone && Array.isArray(self.bundles) && self.bundles.length > 1 ) {
                for (let _mb = 0; _mb < self.bundles.length; ++_mb) {
                    if (self.bundles[_mb] === self.appName) continue;
                    var _mbConf  = options.conf[self.bundles[_mb]] && options.conf[self.bundles[_mb]][self.env];
                    var _mbAudit = ( _mbConf && _mbConf.content && _mbConf.content.settings && _mbConf.content.settings.audit ) ? _mbConf.content.settings.audit : null;
                    if ( _mbAudit && _mbAudit.enabled === true ) {
                        console.warn('[ SERVER ] [ audit ] bundle `'+ self.bundles[_mb] +'` declares `audit.enabled: true`, but in merged mode (shared port) only the starting bundle\'s audit settings apply — its audit configuration is IGNORED. The process-wide trail is governed by [ '+ self.appName +' ].');
                    }
                }
            }
            if ( _auditEnabled ) {
                var _auditStartOpts = {
                    bundle      : self.appName,
                    env         : self.env,
                    actorKey    : _auditSettings.actorKey || 'id',
                    eventsAuthz : !( _auditSettings.events && _auditSettings.events.authz === false )
                };
                var _auditDestLabel = null;
                if ( _auditSettings.store ) {
                    // Connector-backed store — the lib/audit-store dispatcher throws
                    // (⇒ boot refusal) when the entry or the implementation is missing.
                    _auditStartOpts.store = lib.AuditStore(_auditSettings.store);
                    _auditDestLabel = 'store: '+ _auditSettings.store;
                } else {
                    // Default file backend — `<project>/logs/audit-<bundle>-<env>.jsonl`.
                    // `logsPath` is a never-propagated env.json key (dead placeholder —
                    // declared at the file root, outside the `${bundle}`/`${env}` subtree
                    // config.js copies), so the log dir is derived from `projectPath`:
                    // the exact value env.json declares for it (`${projectPath}/logs`).
                    // Per-env filename: two envs of one bundle running concurrently must
                    // never interleave writers into one file (harmless for JSONL, fatal
                    // for the slice-3 hash chain).
                    var _auditFile = _auditSettings.file || null;
                    if ( !_auditFile || !/^\//.test(_auditFile) ) {
                        var _auditProjectPath = self.conf[self.appName][self.env].projectPath;
                        if ( typeof(_auditProjectPath) != 'string' || _auditProjectPath === '' || /\$\{/.test(_auditProjectPath) ) {
                            throw new Error('[ SERVER ] audit: could not derive the log dir — `projectPath` is unresolved ('+ JSON.stringify(_auditProjectPath) +'). Set an absolute `settings.json > audit.file` explicitly.');
                        }
                        // A relative `audit.file` resolves against the project root —
                        // never against the process cwd (which depends on how the
                        // bundle was launched).
                        _auditFile = _auditFile
                            ? _auditProjectPath + '/' + _auditFile
                            : _auditProjectPath + '/logs/audit-'+ self.appName +'-'+ self.env +'.jsonl';
                    }
                    _auditStartOpts.file = _(_auditFile, true);
                    _auditDestLabel = _auditStartOpts.file;
                }
                if ( _auditChainEnabled ) {
                    if ( _auditSettings.store ) {
                        // The store seam carries NO ordering obligation — a
                        // connector backend may persist out of emit order, and
                        // a chain over reordered records forks silently.
                        throw new Error('[ SERVER ] `audit.chain` requires the file backend — a connector `store` cannot guarantee the ordered append a hash chain needs. Remove `audit.store` or disable the chain.');
                    }
                    // Key resolution mirrors the CSRF secret chain, with the
                    // GINA_* read through the framework env reader (the
                    // GINA_MCP_AUTH_TOKEN precedent — the CLI sweeps GINA_*
                    // out of process.env, so a direct read is empty there).
                    var _auditChainSecret = ( typeof(_auditSettings.chain.secret) == 'string' && _auditSettings.chain.secret ) ? _auditSettings.chain.secret : null;
                    if ( !_auditChainSecret ) {
                        _auditChainSecret = ( typeof(getEnvVar) == 'function' && getEnvVar('GINA_AUDIT_SECRET') ) || process.env.GINA_AUDIT_SECRET || null;
                    }
                    if ( !_auditChainSecret || typeof(_auditChainSecret) != 'string' ) {
                        throw new Error('[ SERVER ] `audit.chain.enabled` is true but no signing key is configured — set `settings.json > audit.chain.secret` (e.g. "${secret:MY_AUDIT_KEY}", a non-GINA variable name) or the GINA_AUDIT_SECRET environment variable. Tamper-evidence without a key would be silently OFF, so the boot refuses instead.');
                    }
                    if ( _auditChainSecret.length < 32 ) {
                        console.warn('[ SERVER ] `audit.chain` signing key is shorter than 32 characters — a longer random key (>= 32 bytes) is recommended.');
                    }
                    _auditStartOpts.chain = { secret: _auditChainSecret };
                }
                // Cross-PROCESS shared-file refusal: two bundles resolving the
                // SAME audit file run as separate writers in per-process mode,
                // and two writers fork a linear hash chain. Boot-detectable in
                // both modes — options.conf carries every bundle's parsed
                // settings (runtime-measured 2026-07-26) — so the boot refuses
                // when EITHER party chains. Without a chain the shared file
                // stays legal (interleaved JSONL, pre-existing behaviour).
                // Replicas and cross-project collisions are NOT detectable
                // from config; the docs state that boundary.
                if ( _auditStartOpts.file ) {
                    for (var _ab in options.conf) {
                        if (_ab === self.appName) continue;
                        var _sibConf  = options.conf[_ab] && options.conf[_ab][self.env];
                        var _sibAudit = ( _sibConf && _sibConf.content && _sibConf.content.settings && _sibConf.content.settings.audit ) ? _sibConf.content.settings.audit : null;
                        if ( !_sibAudit || _sibAudit.enabled !== true || _sibAudit.store ) continue;
                        var _sibChain = !!( _sibAudit.chain && _sibAudit.chain.enabled === true );
                        if ( !_auditChainEnabled && !_sibChain ) continue;
                        // replay the sibling's file derivation
                        var _sibFile = ( typeof(_sibAudit.file) == 'string' && _sibAudit.file ) ? _sibAudit.file : null;
                        if ( !_sibFile || !/^\//.test(_sibFile) ) {
                            var _sibProjectPath = _sibConf.projectPath;
                            if ( typeof(_sibProjectPath) != 'string' || _sibProjectPath === '' || /\$\{/.test(_sibProjectPath) ) continue; // unresolvable — its own boot lints it
                            _sibFile = _sibFile
                                ? _sibProjectPath + '/' + _sibFile
                                : _sibProjectPath + '/logs/audit-'+ _ab +'-'+ self.env +'.jsonl';
                        }
                        if ( _( _sibFile, true) === _auditStartOpts.file ) {
                            throw new Error('[ SERVER ] `audit.chain`: bundle `'+ _ab +'` resolves the SAME audit file ('+ _auditStartOpts.file +') and '+ ( _auditChainEnabled ? 'this bundle chains its trail' : 'that bundle chains its trail' ) +' — two writers fork a linear hash chain, so the boot refuses. Give each bundle its own `audit.file` (the default per-bundle path never collides), or disable the chain on both.');
                        }
                    }
                }
                // start() mkdirs + opens the O_APPEND fd — an unwritable destination
                // throws HERE, i.e. refuses the boot rather than dropping records later.
                lib.audit.start(_auditStartOpts);
                // console.info, NOT console.debug — the shipped default log_level
                // ("info") filters debug, which would silently defeat the
                // "path logged at boot" contract.
                console.info('[ BUNDLE ][ server ][ init ] Audit trail enabled for [ '+ self.appName +' ] → '+ _auditDestLabel + ( _auditChainEnabled ? ' (tamper-evident chain: ON)' : '' ));
            }

            // ── #B144 — upload write-error probe (`simulateWriteError`) boot warn ──
            // A group with `simulateWriteError: true` makes every upload tagging it
            // fail with a guarded 500 (the #B143 write-error path) so a consumer can
            // re-confirm the crash-guard on their own surface. It is INERT in
            // production scope (the 'file' handler gates on self.isProductionScope()),
            // but a flag shipped to production by accident is a smell — surface it at
            // boot either way so it can never hide.
            var _uploadSettings = ( self.conf[self.appName]
                && self.conf[self.appName][self.env]
                && self.conf[self.appName][self.env].content
                && self.conf[self.appName][self.env].content.settings
                && self.conf[self.appName][self.env].content.settings.upload
            ) ? self.conf[self.appName][self.env].content.settings.upload : null;
            if ( _uploadSettings && _uploadSettings.groups && typeof(_uploadSettings.groups) == 'object' ) {
                var _probeGroups = Object.keys(_uploadSettings.groups).filter(function(g) {
                    return _uploadSettings.groups[g] && _uploadSettings.groups[g].simulateWriteError;
                });
                if ( _probeGroups.length ) {
                    if ( self.isProductionScope() ) {
                        console.warn('[ BUNDLE ][ server ][ init ] `upload.groups` has `simulateWriteError` set on [ '+ _probeGroups.join(', ') +' ] — IGNORED in production scope, but remove it before shipping (it is a test-only fault injector).');
                    } else {
                        console.warn('[ BUNDLE ][ server ][ init ] upload write-error PROBE active — group(s) [ '+ _probeGroups.join(', ') +' ] will fail every upload with a guarded 500 (`simulateWriteError`). Test-only; inert in production scope.');
                    }
                }
            }

            // ── #B469 — staged-upload orphan sweep (boot-time) ──
            // The `autoTmpCleanupTimeout` deletion timer is per-upload and
            // in-process: a restart strands every part it was holding, and a
            // part that never reaches `self.store()` (the request failed after
            // the multipart parse, or the app consumed the staged file some
            // other way) has NO other reclaim path. So when the operator HAS
            // armed the timer, honour that same policy across process
            // lifetimes: sweep the configured staging dirs at boot for staged
            // parts old enough that a surviving timer would already have taken
            // them. The threshold is floored at 1h: an in-flight upload from a
            // sibling live process on a SHARED staging dir keeps a fresh mtime
            // while its chunks land, and the floor keeps even a stalled one
            // safe. A disabled timer (the shipped default) arms NO sweep — the
            // docs say tmp cleanup is then the operator's own job, and this
            // keeps that contract intact. Runs in every scope (production is
            // where restarts strand parts); duplicate sweeps of a dir shared
            // across merged-process bundles are harmless (idempotent,
            // ENOENT-tolerant).
            if ( _uploadSettings && _uploadSettings.groups && typeof(_uploadSettings.groups) == 'object' ) {
                // mirrors the request path's arming gate for the timer itself
                var _hasSweepTimeout = (
                    typeof(_uploadSettings.autoTmpCleanupTimeout) != 'undefined'
                    &&  _uploadSettings.autoTmpCleanupTimeout != ''
                    &&  _uploadSettings.autoTmpCleanupTimeout != 0
                    &&  !/false/i.test(_uploadSettings.autoTmpCleanupTimeout)
                ) ? true : false;
                var _sweepTimeoutMs = (!_hasSweepTimeout) ? null : parseTimeout(_uploadSettings.autoTmpCleanupTimeout);
                if (_sweepTimeoutMs) {
                    // staging-dir set = the resolved global landing dir + every
                    // group override — the same resolution the write site uses
                    var _sweepDirs = [ ( _uploadSettings.uploadDir || _uploadSettings.tmpPath || os.tmpdir() ) ];
                    var _sweepGroupNames = Object.keys(_uploadSettings.groups);
                    for (var _sg = 0; _sg < _sweepGroupNames.length; _sg++) {
                        var _sgPath = _uploadSettings.groups[_sweepGroupNames[_sg]] && _uploadSettings.groups[_sweepGroupNames[_sg]].path;
                        if ( _sgPath && _sweepDirs.indexOf(_sgPath) < 0 ) {
                            _sweepDirs.push(_sgPath);
                        }
                    }
                    var _sweepAppName = self.appName;
                    setImmediate(function() {
                        sweepStagedUploadOrphans(_sweepDirs, Math.max(_sweepTimeoutMs, 3600000), function(report) {
                            if (report.removed || report.errors) {
                                console.info('[ BUNDLE ][ '+ _sweepAppName +' ][ server ][ init ] upload orphan sweep: removed '+ report.removed +' staged part(s)'+ ( report.errors ? ' ('+ report.errors +' error(s))' : '' ) +' across '+ _sweepDirs.length +' staging dir(s)');
                            } else {
                                console.debug('[ BUNDLE ][ '+ _sweepAppName +' ][ server ][ init ] upload orphan sweep: no orphaned staged parts ('+ _sweepDirs.length +' staging dir(s))');
                            }
                        });
                    });
                }
            }

            // ── #B152 — opt-in deterministic proxied-request classification ──
            // server.proxy.requireForwardedHeaders === true -> a request is
            // classified proxied ONLY on an explicit X-Forwarded-Host; the
            // port-less-Host heuristic is disabled, so an internal call addressed
            // by service/DNS name (container health probe on an app route, mesh
            // hop, sibling-bundle request) can no longer rewrite the worker's
            // PROXY_* host context (the source req-less renders fall back to).
            // Enable only behind a front proxy that ALWAYS sends X-Forwarded-Host.
            // Boot-resolved ONCE onto the worker-global (standalone workers take
            // the started bundle's setting); read by the two classification twins:
            // core/server.isaac.js (#B65 block) + core/router.js (#B67 block).
            try {
                var _proxyClassifyConf = self.conf[self.appName][self.env].server.proxy;
                process.gina._proxyRequireForwarded = ( _proxyClassifyConf && _proxyClassifyConf.requireForwardedHeaders === true ) ? true : false;
                if (process.gina._proxyRequireForwarded) {
                    console.info('[ BUNDLE ][ server ][ init ] proxied-request classification: X-Forwarded-Host REQUIRED (server.proxy.requireForwardedHeaders) — the port-less-Host heuristic is disabled.');
                }
            } catch (_proxyClassifyErr) {
                process.gina._proxyRequireForwarded = false;
            }

            // ── #MAINT1 — maintenance mode: boot-resolve the per-bundle state ──
            // A server serves exactly ONE bundle (#H13 slice 3b), so the state
            // lives on the ENGINE INSTANCE rather than a bundle-keyed map: in
            // merged-process mode each bundle has its own instance, so per-bundle
            // scope falls out for free and `gina bundle:x` maintenance can never
            // leak onto a sibling bundle sharing the process.
            //
            // Resolved ONCE here (not per request) so the gate costs one property
            // read plus a boolean when the feature is off — the #P39-sensitive
            // render path must not pay for an opt-in it is not using. Same
            // boot-resolve precedent as `instance._cacheName` (#B238) and
            // `process.gina._proxyRequireForwarded` above.
            //
            // `_maintenance.runtime` is the POST /_gina/maintenance override
            // (null = follow config). It is deliberately NOT persisted: a restart
            // returns the bundle to its configured state, which is the safe
            // direction — a forgotten runtime toggle can never outlive the process
            // that set it. Config `enabled: true` is the durable form.
            //
            // Read by the gate in onRequest() below AND by the isaac twin
            // (core/server.isaac.js reads the same object as `server._maintenance`).
            try {
                var _mtBlock = self.conf[self.appName][self.env].server.maintenance;
                engine.instance._maintenance = {
                    conf    : lib.maintenance.resolveConf(_mtBlock),
                    runtime : null
                };
                if ( engine.instance._maintenance.conf.enabled ) {
                    console.warn('[ BUNDLE ][ server ][ init ] MAINTENANCE MODE IS ON for `'+ self.appName +'` (settings.json > server.maintenance.enabled) — every request outside /_gina/* answers 503 until it is turned off.');
                }
            } catch (_mtErr) {
                engine.instance._maintenance = {
                    conf    : lib.maintenance.resolveConf(null),
                    runtime : null
                };
            }

            // ── #RWATCH — stale built-release watch (local production rehearsals) ──
            // Hard gates: local scope + non-dev env + explicit opt-in
            // (server.releaseWatch.enabled === true — fail-closed default). Inert
            // otherwise: CLI processes, dev-env bundles and real clusters never pay
            // for it. NON-FATAL by design (unlike the DTO registrar above): an
            // opt-in observability aid must never break a boot — and
            // lib.releaseWatch.init() already warns loudly on every refusal path
            // (missing src root, double-arm, watcher failure).
            try {
                var _rwConf = self.conf[self.appName][self.env].server.releaseWatch;
                if (
                    /^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL)
                    && !/^true$/i.test(process.env.NODE_ENV_IS_DEV)
                    && _rwConf
                ) {
                  if ( _rwConf.enabled === true ) {
                    var _rwProjectRoot  = getContext('gina').project.path;
                    var _rwManifestPath = _(_rwProjectRoot + '/manifest.json', true);
                    var _rwManifest     = requireJSON(_rwManifestPath);
                    var _rwSrcRel       = _rwManifest.bundles
                        && _rwManifest.bundles[self.appName]
                        && _rwManifest.bundles[self.appName].src
                        || null;
                    // The build verbs stamp the fingerprint of bundlesPath + '/' + bundle
                    // (the exact tree buildEnv() copies). The manifest `src` is the same
                    // tree by scaffold construction — warn on divergence so a hand-edited
                    // manifest surfaces as a visible config problem instead of a
                    // mysterious never-converging staleness compare.
                    var _rwBuildSrc = _(self.conf[self.appName][self.env].bundlesPath + '/' + self.appName, true);
                    var _rwSrcRoot  = _rwSrcRel ? _(_rwProjectRoot + '/' + _rwSrcRel, true) : _rwBuildSrc;
                    if (_rwSrcRoot !== _rwBuildSrc) {
                        console.warn('[releaseWatch] manifest `src` ('+ _rwSrcRoot +') differs from the build source tree ('+ _rwBuildSrc +') — the build stamps the latter; the staleness compare may never converge');
                    }
                    lib.releaseWatch.init({
                        bundle              : self.appName,
                        project             : self.projectName,
                        env                 : self.env,
                        scope               : self.scope,
                        srcRoot             : _rwSrcRoot,
                        manifestPath        : _rwManifestPath,
                        mode                : _rwConf.mode,
                        restartMode         : _rwConf.restartMode,
                        debounceMs          : _rwConf.debounceMs,
                        reconcileIntervalMs : _rwConf.reconcileIntervalMs,
                        httpServer          : engine.instance,
                        // the /_gina/cache/clear flush idiom — resolved lazily at
                        // rebuild time, when self.instance._cached provably exists
                        flushRenderCache    : function _rwFlushRenderCache(bundle) {
                            var _rwFlushView = new lib.RenderCache();
                            _rwFlushView.from(self.instance._cached);
                            _rwFlushView.clear(bundle);
                        }
                    });
                  } else if ( _rwConf.enabled ) {
                    // a truthy-but-not-boolean-true `enabled` (e.g. the string
                    // "true" from a hand-edited settings.json) fails the strict
                    // gate and would otherwise arm NOTHING silently — surface the
                    // likely config typo (fail-closed is intentional; a silent
                    // no-op on a plausible typo is not).
                    console.warn('[releaseWatch] server.releaseWatch.enabled is `'
                        + JSON.stringify(_rwConf.enabled) + '` (a ' + typeof _rwConf.enabled
                        + ') — expected the boolean true; the watch stays DISABLED (fail-closed)');
                  }
                }
            } catch (rwInitErr) {
                console.warn('[releaseWatch] init skipped: '+ (rwInitErr.stack || rwInitErr.message || rwInitErr));
            }

            // ── #COMPLY9 — production transport posture (ZT2) ──────────────────
            // Outside the `local` scope a bundle resolving a cleartext scheme is
            // served exactly as configured — both engines' scheme switches default
            // to cleartext — so the posture is surfaced at boot instead of staying
            // invisible: warn by default, refuse when the operator asked for
            // enforcement, acknowledge when the operator asserted the boundary.
            //
            //   server.requireHttps  === true  → REFUSE to boot a cleartext bundle
            //       outside the local scope. The throw lands in this init() try,
            //       whose catch emergs + flushes + exits BEFORE any listen() — the
            //       same pre-listen principle as the MCP transport's fail-closed
            //       start(): the cleartext port is never reachable at all.
            //   server.allowInsecure === true  → the operator's assertion that TLS
            //       terminates upstream (mesh sidecar, ingress/LB, reverse proxy —
            //       the documented h2c topology); the warn becomes one info line.
            //       Same vocabulary and polarity as `mcp.json > server >
            //       allowInsecure`.
            //
            // Both are strict booleans resolved like `scheme` itself (bundle
            // settings win, env.json's `server` block fills — the picked-keys
            // merge above). A non-boolean throws: a truthy string on
            // `requireHttps` would leave the transport silently UNENFORCED while
            // the operator believes otherwise — the quietly-OFF class the authz
            // lints above refuse (`auth.requireAuthByDefault` precedent). The
            // scope gate is NOT-local, never is-production: custom scopes (e.g. a
            // `beta`) are neither local nor production, and a production-keyed
            // gate would silently skip them — the same reasoning as the
            // stack-trace egress gate. `conf.server.scopeIsLocal` is deliberately
            // not used (it derives from projects.json `def_scope`, not the live
            // scope). The scheme test is `!== 'https'`, fail-closed: anything the
            // engines cannot positively recognise as https is served cleartext
            // (their scheme switches `default:` to the plain server).
            var _tpRequireHttps  = serverOpt.requireHttps;
            var _tpAllowInsecure = serverOpt.allowInsecure;
            // Type lint first, scope-independent: settings.json boots every
            // scope, so the dev machine catches the typo before it ships.
            if ( typeof(_tpRequireHttps) != 'undefined' && typeof(_tpRequireHttps) != 'boolean' ) {
                throw new Error('[ SERVER ] `settings.json > server.requireHttps` must be a boolean — got '+ JSON.stringify(_tpRequireHttps) +'. A truthy string would leave the transport silently UNENFORCED, so the boot refuses instead.');
            }
            if ( typeof(_tpAllowInsecure) != 'undefined' && typeof(_tpAllowInsecure) != 'boolean' ) {
                throw new Error('[ SERVER ] `settings.json > server.allowInsecure` must be a boolean — got '+ JSON.stringify(_tpAllowInsecure) +'.');
            }
            if ( _tpRequireHttps === true && _tpAllowInsecure === true ) {
                throw new Error('[ SERVER ] `server.requireHttps` and `server.allowInsecure` are both true — they assert opposite postures (enforce https at this bundle vs TLS terminates upstream). Keep exactly one.');
            }
            if ( serverOpt.scheme !== 'https' && !self.isLocalScope() ) {
                if ( _tpRequireHttps === true ) {
                    throw new Error('[ SERVER ] `server.requireHttps` is true, but bundle `'+ self.appName +'` resolves scheme `'+ serverOpt.scheme +'` in scope `'+ self.scope +'` — the listener would serve cleartext outside the local scope, which is exactly what this knob refuses (the refusal is pre-listen: nothing binds). Switch the bundle to https (`settings.json > server.scheme: "https"` + `server.credentials`), or — if TLS terminates upstream (mesh, ingress, reverse proxy) — replace `requireHttps` with `server.allowInsecure: true`.');
                }
                if ( _tpAllowInsecure === true ) {
                    console.info('[ BUNDLE ][ server ][ init ] transport posture: scheme `'+ serverOpt.scheme +'` in scope `'+ self.scope +'` — allowInsecure asserted (TLS terminates upstream).');
                } else {
                    // proxy.json is advisory only — an https:// upstream hostname
                    // for this scope+env strongly suggests TLS terminates there,
                    // but only the explicit `allowInsecure` assertion silences
                    // the warn (a reviewer can tell an audited acknowledgment
                    // from a leftover; the #COMPLY10 `public`-marker rationale).
                    var _tpProxyNote = ( typeof(process.gina.PROXY_HOSTNAME) != 'undefined' && /^https:\/\//i.test(process.gina.PROXY_HOSTNAME) )
                        ? ' proxy.json declares `'+ process.gina.PROXY_HOSTNAME +'` for this scope+env, so TLS likely terminates there.'
                        : '';
                    console.warn('[ BUNDLE ][ server ][ init ] transport posture: bundle `'+ self.appName +'` serves plain `'+ serverOpt.scheme +'` in scope `'+ self.scope +'` — the transport at this listener is cleartext.'+ _tpProxyNote +' If TLS terminates upstream (mesh, ingress/LB, reverse proxy — the documented h2c topology), acknowledge with `server.allowInsecure: true`; to enforce https at this bundle, set `server.requireHttps: true`.');
                }
            } else if ( _tpRequireHttps === true && serverOpt.scheme === 'https' && !self.isLocalScope() ) {
                console.info('[ BUNDLE ][ server ][ init ] transport posture: server.requireHttps satisfied — scheme is https.');
            }

            self.emit('configured', false, engine.instance, engine.middleware, self.conf[self.appName][self.env]);

        } catch (err) {
            var _engineMsg = '[ BUNDLE ] [ '+ self.appName +' ] ServerEngine ' + err.stack;
            console.emerg(_engineMsg)
            // Guarantee the reason survives process.exit() on an async pipe (e.g. bin/gina-container).
            try { fs.writeSync(2, _engineMsg + '\n'); } catch (_e) { /* best-effort */ }
            process.exit(1)
        }
    }
    /**
     * Returns `true` when running in dev mode (`NODE_ENV_IS_DEV=true`).
     *
     * @memberof module:gina/core/server
     * @returns {boolean}
     */
    this.isCacheless = function() {
        return (/^true$/i.test(process.env.NODE_ENV_IS_DEV)) ? true : false
    }
    /**
     * Returns `true` when the active scope is `local` (`NODE_SCOPE_IS_LOCAL=true`).
     *
     * @memberof module:gina/core/server
     * @returns {boolean}
     */
    this.isLocalScope = function() {
        return (/^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL)) ? true : false;
    }
    /**
     * Returns `true` when the active scope is `production` (`NODE_SCOPE_IS_PRODUCTION=true`).
     *
     * @memberof module:gina/core/server
     * @returns {boolean}
     */
    this.isProductionScope = function() {
        return (/^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION)) ? true : false;
    }

    /**
     * Registers a one-time listener for the `'configured'` event, then kicks
     * off `init()`. The callback receives `(err, instance, middleware, conf)`.
     *
     * @memberof module:gina/core/server
     * @param {function} callback - `function(err, instance, middleware, conf)`
     */
    this.onConfigured = function(callback) {
        self.once('configured', function(err, instance, middleware, conf) {
            callback(err, instance, middleware, conf)
        });

        init(options);
    }

    /**
     * Checks TLS certificate validity for an HTTPS endpoint.
     *
     * Replaces the `ssl-checker` npm package with a direct `https.request` +
     * `res.socket.getPeerCertificate()` call. Returns the same result shape:
     * `{ daysRemaining, valid, validFrom, validTo, validFor }`.
     *
     * @memberof module:gina/core/server
     * @param {string} endpoint - Hostname to verify (e.g. `'myapp.dev'`)
     * @param {number} [port=443] - HTTPS port
     * @returns {Promise<void>} Resolves when valid; throws if DNS/cert check fails
     */
    this.verifyCertificate = async function(endpoint, port) {
        let sslDetails = null;
        console.debug('Checking certificate validity...');
        try {
            console.debug('[ssl] endpoint: ', endpoint);
            sslDetails = await new Promise(function(resolve, reject) {
                var _port = port || 443;
                var reqOptions = {
                    host: endpoint,
                    port: _port,
                    method: 'GET',
                    path: '/_gina/health/check',
                    rejectUnauthorized: false,
                    // replaced: fs.readFileSync(credentials.ca) — credentials paths use ~/ which fs.readFileSync does not expand; _() expands $HOME via execSync('echo $HOME')
                    ca: fs.readFileSync(_(self.conf[self.appName][self.env].content.settings.server.credentials.ca, true)),
                    agent: new https.Agent({ maxCachedSessions: 0 })
                };

                var timeoutId = setTimeout(function() {
                    req.destroy();
                    reject(new Error('Timed Out'));
                }, 5000);

                var req = https.request(reqOptions, function(res) {
                    clearTimeout(timeoutId);
                    var cert = res.socket.getPeerCertificate();
                    res.socket.destroy();

                    if (!cert || !cert.valid_from || !cert.valid_to) {
                        return reject(new Error('No certificate'));
                    }

                    var validFrom = new Date(cert.valid_from).toISOString();
                    var validTo   = new Date(cert.valid_to).toISOString();
                    var now       = Date.now();
                    var expiry    = new Date(cert.valid_to).getTime();
                    var daysRemaining = Math.floor((expiry - now) / 86400000);

                    var result = {
                        daysRemaining: daysRemaining,
                        valid: res.socket.authorized || false,
                        validFrom: validFrom,
                        validTo: validTo
                    };

                    // Extract Subject Alternative Names (DNS entries)
                    if (cert.subjectaltname) {
                        result.validFor = cert.subjectaltname
                            .split(',')
                            .map(function(s) { return s.trim().replace(/^DNS:/, ''); })
                            .filter(function(s) { return s.length > 0; });
                    }

                    resolve(result);
                });

                req.on('error', function(err) {
                    clearTimeout(timeoutId);
                    reject(err);
                });

                req.end();
            });
        } catch (err) {
            if (!sslDetails) {
                throw new Error('DNS issue ? Did you check your `/etc/hosts` or your DNS configuration ?\n'+ err.stack);
            }
            throw new Error(sslDetails +'\n'+ err.stack);
        }


        const failed  = !sslDetails.valid;
        const humanView = JSON.stringify(sslDetails, null, '  ');

        // Wildcard exception - See https://github.com/dyaa/ssl-checker/issues/381
        // Date of the test: 2022-12-18T00:00:00.000Z
        // container-87546.dev.sample.app -> not valid when it should return true.
        // {
        //     "daysRemaining": 290,
        //     "valid": false,
        //     "validFrom": "2022-10-03T00:00:00.000Z",
        //     "validTo": "2023-10-03T23:59:59.000Z",
        //     "validFor": [
        //         "*.sample.app",
        //         "sample.app"
        //     ]
        // }

        const isHandleByWildcardCert = function(endpoint, hv) {
            var isAllowed = false;
            const start = new Date(hv.validFrom).format('longIsoDateTime');
            const end = new Date(hv.validTo).format('longIsoDateTime');
            const today = new Date().format('longIsoDateTime');
            const allowed = hv.validFor;

            for (let i=0, len=allowed.length; i<len; ++i ) {
                // skip if not a wildcard
                if ( ! /^[*]\./.test(allowed[i]) ) continue;

                let re = new RegExp( allowed[i].replace(/^[*]/, '')+'$' );
                if ( ! re.test(endpoint) ) continue;

                if ( today >= start && today < end) {
                    isAllowed = true;
                    break
                }
            }
            return isAllowed;
        }
        if ( failed && Array.isArray(sslDetails.validFor) && isHandleByWildcardCert(endpoint, sslDetails) ) {
            return;
        }


        if (failed) {
            if (sslDetails.daysRemaining > -1) {
                var isProxyHost = getContext('isProxyHost');
                if ( /^true$/i.test(isProxyHost) ) {
                    console.warn("Host is behind a reverse proxy, skipping server.verifyCertificate(...) ");
                    return;
                }
                var rootDomain = domainLib.getRootDomain(endpoint).value;
                hasMatchedEntry = false;
                for (let i in sslDetails.validFor) {
                    if ( new RegExp(sslDetails.validFor[i].replace(/^\*\./, '') + '$').test(rootDomain) ) {
                        hasMatchedEntry = true;
                        break;
                    }
                }
                if (!hasMatchedEntry) {
                    console.warn(`[Certificate] "${endpoint}" : Root domain not matching your certificate. If you plan to run your service behind a revese proxy, please do not forget to add "proxy.json" at the root of your project while going to production.${'\n'} ${humanView}`);
                    return;
                }
                // sslDetails.validFor
                console.emerg(`[Certificate] ${endpoint} : It is like there is a problem with your CA certificate${'\n'} ${humanView}`);
                return;
            }
            console.emerg(`[Certificate] ${endpoint} has no valid certificate: ${'\n'} ${humanView}`);
            return;
        }
    }

    /**
     * #MS5 — resolve and validate the `server.query.circuitBreaker` block ONCE at
     * engine start, for the stamp below that `controller.query()` reads (the same
     * boot-resolved-once pattern as `_cacheName` / #B238). Dormant contract: an
     * absent block, or `enabled` not strictly `true`, resolves to
     * `{ enabled: false }` and the breaker path in `query()` is never entered.
     * Structurally invalid values on an ENABLED block are a boot refusal (throw),
     * not a warn-and-disable: silently running without the protection the operator
     * asked for is exactly the fail-open shape the storage/kv boot bands refuse.
     *
     * @inner
     * @param {object} [serverConf] - Post-fold `server` block (env.json keys win, settings.json fills — see the config.js #MS5 fold)
     * @returns {object} `{ enabled: false }` or `{ enabled: true, failureThreshold, cooldownMs }`
     */
    var resolveQueryCircuitBreakerConf = function(serverConf) {
        var block = serverConf && serverConf.query && serverConf.query.circuitBreaker;
        if ( !block || block.enabled !== true ) {
            return { enabled: false };
        }
        var threshold = ( typeof(block.failureThreshold) == 'undefined' ) ? 5 : block.failureThreshold;
        if ( typeof(threshold) != 'number' || threshold !== ~~threshold || threshold < 1 ) {
            throw new Error('[SERVER][#MS5] `server.query.circuitBreaker.failureThreshold` must be an integer >= 1 — got `'+ threshold +'`');
        }
        var cooldownMs = parseTimeout( ( typeof(block.cooldown) == 'undefined' ) ? '30s' : block.cooldown );
        if ( typeof(cooldownMs) != 'number' || cooldownMs < 1 ) {
            throw new Error('[SERVER][#MS5] `server.query.circuitBreaker.cooldown` must be a positive timeout (e.g. "30s", 500) — got `'+ block.cooldown +'`');
        }
        return { enabled: true, failureThreshold: threshold, cooldownMs: cooldownMs };
    };

    /**
     * Attaches the server engine instance, injects helper references
     * (`throwError`, `getAssets`, `completeHeaders`) onto it, and returns
     * `onRequest()` to begin serving HTTP traffic.
     *
     * @memberof module:gina/core/server
     * @param {object} instance - Server engine instance (Express app or Isaac server)
     * @returns {*} Return value of `onRequest()`
     */
    this.start = function(instance) {
        if (instance) {
            self.instance       = instance;
            //Router configuration.
            var router = local.router;

            instance.throwError         = throwError;
            instance.getAssets          = getAssets;
            instance.completeHeaders    = completeHeaders;

            // If you change here, you will also have to refrect changes in the form-validator
            if ( typeof(instance._cached) == 'undefined' ) {
                instance._cached = new Map();
                // Tag with LRU cap so all Cache instances pointing at this Map share the same limit.
                // Reads server.cache.maxEntries from env.json; defaults to 1000. Set to 0 to disable.
                var _cacheConf = self.conf[self.appName][self.env].server.cache;
                instance._cached._maxEntries = ( _cacheConf.maxEntries > 0 ) ? ~~(_cacheConf.maxEntries) : 1000;
            }
            if ( typeof(instance._cachedPath) == 'undefined' ) {
                instance._cachePath = self.conf[self.appName][self.env].server.cache.path;
            }
            if ( typeof(instance._cacheIsEnabled) == 'undefined' ) {
                instance._cacheIsEnabled = self.conf[self.appName][self.env].server.cache.enable;
            }
            // #B238 — the Cache-Status identifier, resolved ONCE from the post-fold
            // server.cache (`name` when valid, else `gina-cache`) and stamped on the
            // engine instance both engines read (isaac: `server._cacheName`; the
            // engine-agnostic hit/miss mints: `self.instance._cacheName`). One
            // resolution, three readers — the identifier cannot disagree across
            // engines or hit/miss outcomes. Unconditional beside the sibling
            // scalars above, so the mint sites read it unguarded (same trust as
            // `_cacheIsEnabled`).
            if ( typeof(instance._cacheName) == 'undefined' ) {
                instance._cacheName = lib.RenderCache.resolveCacheName(self.conf[self.appName][self.env].server.cache);
            }

            // #MS5 — per-authority query circuit-breaker policy, resolved ONCE
            // from the post-fold `server.query.circuitBreaker` and stamped where
            // `controller.query()` reads it (mirrors the `_cache*` scalars above;
            // breaker STATE lives separately on `instance._queryCircuitBreakers`,
            // minted lazily by the controller).
            if ( typeof(instance._queryCircuitBreaker) == 'undefined' ) {
                instance._queryCircuitBreaker = resolveQueryCircuitBreakerConf(self.conf[self.appName][self.env].server);
            }

            // #MS6 — identified-caller quota policy, resolved ONCE from the
            // post-fold `server.rateLimit` and stamped where the router reads it
            // (the same instance-scalars family as the breaker above: survives
            // dev-mode hot reloads, dies on restart). The resolver is fail-closed
            // on an enabled block (a bad value refuses the boot) and verifies the
            // named kv namespace is DECLARED — the kv boot band installed the
            // namespaces before the first request, upstream of this engine start.
            if ( typeof(instance._rateLimit) == 'undefined' ) {
                var _rlContent = self.conf[self.appName][self.env].content;
                instance._rateLimit = lib.rateLimit.resolveConf(self.conf[self.appName][self.env].server, {
                    kv         : lib.kv,
                    kvSettings : _rlContent && _rlContent.settings && _rlContent.settings.kv,
                    connectors : _rlContent && _rlContent.connectors,
                    routing    : _rlContent && _rlContent.routing,
                    warn       : function(rlWarnMsg) { console.warn('[rate-limit] ' + rlWarnMsg); }
                });
            }

            // #FIN6 — Idempotency-Key dedup policy, resolved ONCE from the
            // post-fold `server.idempotency` and stamped where the router reads
            // it (the same instance-scalars family as the rate-limit stamp
            // above). Fail-closed on an enabled block; verifies the named kv
            // namespace is DECLARED.
            if ( typeof(instance._idempotency) == 'undefined' ) {
                var _idemContent = self.conf[self.appName][self.env].content;
                instance._idempotency = lib.idempotency.resolveConf(self.conf[self.appName][self.env].server, {
                    kv         : lib.kv,
                    kvSettings : _idemContent && _idemContent.settings && _idemContent.settings.kv,
                    connectors : _idemContent && _idemContent.connectors,
                    routing    : _idemContent && _idemContent.routing,
                    warn       : function(idemWarnMsg) { console.warn('[idempotency] ' + idemWarnMsg); }
                });
            }

            // #B115 — publish the engine so the form-validator's server-side `query`
            // rule can hand its hand-built controller the LIVE instance (one engine
            // per process). Without this, queryFromBackend mints a second `_cached`
            // Map on the bundle's config dict, and controller.query()'s
            // cache.from(serverInstance._cached) leaves the process-wide lib/cache
            // pointer on that wrong Map after every validator query.
            if (!process.gina) { process.gina = {}; }
            process.gina._serverInstance = instance;

            router.setServerInstance(instance);
        }

        return onRequest()
    }



    /**
     * Called once route files are loaded. Builds the merged routing and
     * reverse-routing maps across all bundles, registers them on the Config
     * singleton and the Router, and calls `callback(false)`.
     *
     * @inner
     * @private
     * @param {function} callback - `function(err)` called on completion
     */
    var onRoutesLoaded = function(callback) {

        var config                  = new Config()
            , conf                  = config.getInstance(self.appName)
            , serverCoreConf        = self.conf.core
            , routing               = {}
            , reverseRouting        = {}
            , isCacheless           = config.isCacheless()
            , env                   = self.env
            , scope                 = self.scope
            , apps                  = conf.allBundles // conf.bundles
            , filename              = ''
            , appName               = ''
            , tmp                   = {}
            , standaloneTmp         = {}
            , main                  = ''
            , tmpContent            = ''
            , i                     = 0
            , file                  = null // template file
            , wroot                 = null
            , hasWebRoot            = false
            , webrootAutoredirect   = null
            , localWroot            = null
            , originalRules         = []
            , oRuleCount            = 0
        ;

        //Standalone or shared instance mode. It doesn't matter.
        for (; i<apps.length; ++i) {
            config.setServerCoreConf(apps[i], env, scope, serverCoreConf);

            var appPath = _(conf.envConf[apps[i]][env].bundlesPath+ '/' + apps[i]);
            appName     =  apps[i];

            //Specific case.
            if (!self.isStandalone && i == 0) appName = apps[i];

            try {
                main        = _(appPath + '/config/' + conf.envConf[apps[i]][env].configFiles.routing);
                filename    = main;//by default
                filename    = conf.envConf[apps[i]][env].configFiles.routing.replace(/.json/, '.' +env + '.json');
                filename    = _(appPath + '/config/' + filename);
                //Can't do a thing without.
                if ( !fs.existsSync(filename) ) {
                    filename = main
                }

                if (isCacheless) {
                    delete require.cache[require.resolve(_(filename, true))]
                }

                if (filename != main) {
                    routing = tmpContent = merge(require(main), require(filename), true);

                } else {
                    try {
                        tmpContent = require(filename);
                    } catch (err) {
                        // do not block here because the bundle is not build for the same env
                        console.warn(err.stack);
                        continue
                    }
                }

                try {

                    wroot               = conf.envConf[apps[i]][env].server.webroot;
                    webrootAutoredirect = conf.envConf[apps[i]][env].server.webrootAutoredirect;
                    // renaming rule for standalone setup
                    if ( self.isStandalone && apps[i] != self.appName && wroot == '/') {
                        wroot = '/'+ apps[i];
                        conf.envConf[apps[i]][env].server.webroot = wroot
                    }

                    if (wroot.length >1) {
                        hasWebRoot = true
                    } else {
                        hasWebRoot = false
                    }

                    tmp = tmpContent;
                    //Adding important properties; also done in core/config.
                    for (var rule in tmp){
                        tmp[rule.toLowerCase() +'@'+ appName] = tmp[rule];
                        delete tmp[rule];
                        file = ruleShort = rule.toLowerCase();
                        rule = rule.toLowerCase() +'@'+ appName;


                        tmp[rule].bundle        = (tmp[rule].bundle) ? tmp[rule].bundle : apps[i]; // for reverse search
                        tmp[rule].param.file    = ( typeof(tmp) != 'string' && typeof(tmp[rule].param.file) != 'undefined' ) ? tmp[rule].param.file : file; // get template file
                        // by default, method is inherited from the request
                        if (
                            hasWebRoot && typeof(tmp[rule].param.path) != 'undefined' && typeof(tmp[rule].param.ignoreWebRoot) == 'undefined'
                            || hasWebRoot && typeof(tmp[rule].param.path) != 'undefined' && !tmp[rule].param.ignoreWebRoot
                        ) {
                            tmp[rule].param.path = wroot + tmp[rule].param.path
                        }

                        if (typeof(tmp[rule].url) != 'object') {
                            if (tmp[rule].url.length > 1 && tmp[rule].url.substring(0,1) != '/') {
                                tmp[rule].url = '/'+tmp[rule].url
                            }
                            /** else if (tmp[rule].url.length > 1 && conf.envConf[apps[i]][env].server.webroot.substring(conf.envConf[apps[i]][env].server.webroot.length-1,1) == '/') {
                                tmp[rule].url = tmp[rule].url.substring(1)
                            }*/
                            else {
                                if (wroot.substring(wroot.length-1,1) == '/') {
                                    wroot = wroot.substring(wroot.length-1,1).replace('/', '')
                                }
                            }


                            if (tmp[rule].bundle != apps[i]) { // allowing to override bundle name in routing.json
                                // originalRule is used to facilitate cross bundles (hypertext)linking
                                originalRules[oRuleCount] = ( self.isStandalone && tmp[rule] && apps[i] != self.appName) ? apps[i] + '-' + rule : rule;
                                ++oRuleCount;

                                localWroot = conf.envConf[tmp[rule].bundle][env].server.webroot;
                                // standalone setup
                                if ( self.isStandalone && tmp[rule].bundle != self.appName && localWroot == '/') {
                                    localWroot = '/'+ routing[rule].bundle;
                                    conf.envConf[tmp[rule].bundle][env].server.webroot = localWroot
                                }
                                if (localWroot.substring(localWroot.length-1,1) == '/') {
                                    localWroot = localWroot.substring(localWroot.length-1,1).replace('/', '')
                                }
                                if ( typeof(tmp[rule].param.ignoreWebRoot) == 'undefined' || !tmp[rule].param.ignoreWebRoot )
                                    tmp[rule].url = localWroot + tmp[rule].url
                            } else {
                                if ( typeof(tmp[rule].param.ignoreWebRoot) == 'undefined' || !tmp[rule].param.ignoreWebRoot )
                                    tmp[rule].url = wroot + tmp[rule].url
                                else if (!tmp[rule].url.length)
                                    tmp[rule].url += '/'
                            }

                        } else {

                            for (var u=0; u<tmp[rule].url.length; ++u) {
                                if (tmp[rule].url[u].length > 1 && tmp[rule].url[u].substring(0,1) != '/') {
                                    tmp[rule].url[u] = '/'+tmp[rule].url[u]
                                } else {
                                    if (wroot.substring(wroot.length-1,1) == '/') {
                                        wroot = wroot.substring(wroot.length-1,1).replace('/', '')
                                    }
                                }
                                if ( typeof(tmp[rule].param.ignoreWebRoot) == 'undefined' || !tmp[rule].param.ignoreWebRoot )
                                    tmp[rule].url[u] = wroot + tmp[rule].url[u]
                                else if (!tmp[rule].url.length)
                                    tmp[rule].url += '/'
                            }
                        }

                        if( hasViews(apps[i]) ) {
                            // This is only an issue when it comes to the frontend dev
                            // views.routeNameAsFilenameEnabled is set to true by default
                            // IF [ false ] the action is used as filename
                            if ( !conf.envConf[apps[i]][env].content.templates['_common'].routeNameAsFilenameEnabled && tmp[rule].param.bundle != 'framework') {
                                var tmpRouting = [];
                                for (var r = 0, len = tmp[rule].param.file.length; r < len; ++r) {
                                    if (/[A-Z]/.test(tmp[rule].param.file.charAt(r))) {
                                        tmpRouting[0] = tmp[rule].param.file.substring(0, r);
                                        tmpRouting[1] = '-' + (tmp[rule].param.file.charAt(r)).toLocaleLowerCase();
                                        tmpRouting[2] = tmp[rule].param.file.substring(r + 1);
                                        tmp[rule].param.file = tmpRouting[0] + tmpRouting[1] + tmpRouting[2];
                                        ++r
                                    }
                                }
                                tmpRouting = null;
                            }
                        }

                        if ( self.isStandalone && tmp[rule]) {
                            standaloneTmp[rule] = JSON.clone(tmp[rule]);
                        }
                    }// EO for


                } catch (err) {
                    self.routing = routing = null;
                    console.error(err.stack||err.message);
                    callback(err)
                }

            } catch (err) {
                console.warn(err, err.stack||err.message);
                callback(err)
            }


            routing = merge(routing, ((self.isStandalone && apps[i] != self.appName ) ? standaloneTmp : tmp), true);
            // originalRule is used to facilitate cross bundles (hypertext)linking
            for (let r = 0, len = originalRules.length; r < len; r++) { // for each rule ( originalRules[r] )
                routing[originalRules[r]].originalRule = (routing[originalRules[r]].bundle === self.appName )
                    ?  config.getOriginalRule(originalRules[r], routing)
                    : config.getOriginalRule(routing[originalRules[r]].bundle +'-'+ originalRules[r], routing)
            }

            // reverse routing
            for (let rule in routing) {
                if ( typeof(routing[rule].url) != 'object' ) {
                    reverseRouting[routing[rule].url] = rule
                } else {
                    for (let u = 0, len = routing[rule].url.length; u < len; ++u) {
                        reverseRouting[routing[rule].url[u]] = rule
                    }
                }
            }

            config.setRouting(apps[i], env, scope, routing);
            config.setReverseRouting(apps[i], env, scope, reverseRouting);

            // Build radix trie for this bundle — enables O(m) candidate lookup in handle()
            routingLib.buildTrie(routing, apps[i]);

            if (apps[i] == self.appName) {
                self.routing        = routing;
                self.reverseRouting = reverseRouting
            }

        }//EO for.


        callback(false)
    }

    /**
     * Returns `true` if the bundle has a templates directory defined in its
     * env config (result cached per bundle for the lifetime of the server).
     *
     * @inner
     * @private
     * @param {string} bundle - Bundle name
     * @returns {boolean}
     */
    var hasViews = function(bundle) {
        var _hasViews   = false
            , conf      = new Config().getInstance(bundle)
        ;
        if (typeof(local.hasViews[bundle]) != 'undefined') {
            _hasViews = local.hasViews[bundle];
        } else {
            _hasViews = ( typeof(conf.envConf[bundle][self.env].content['templates']) != 'undefined' ) ? true : false;
            local.hasViews[bundle] = _hasViews;
        }

        return _hasViews
    }


    /**
     * Confines a resolved static-asset filename to its intended base directory,
     * rejecting path-traversal escapes (`../`, and their `%2e%2e` / `%2F` encoded
     * variants once decoded) that would otherwise canonicalise to a sibling under
     * the shared root. Both paths are normalised with `path.resolve`, then a
     * separator-aware containment check is applied so a base of `/srv/app/lib`
     * cannot be bypassed by a sibling such as `/srv/app/lib-secrets`. Callers must
     * settle percent-decoding on `filename` BEFORE calling — both static resolvers
     * `safeDecodeURIComponent()` first, so `%2e%2e` / `%2F` are already `..` / `/`
     * here. Purely lexical (no symlink following) — matches the existing
     * CVE-2023-25345 boundary-check idiom in `controller.render-swig.js`.
     *
     * @inner
     * @private
     * @param {string} filename - The concatenated candidate filesystem path (decoded)
     * @param {string} base     - The intended base directory (mapping target or publicPath)
     * @returns {string|null} The canonical in-base path, or `null` when it escapes `base`
     * @example
     * confineToBase('/srv/app/js/lib/../../../config/secret.json', '/srv/app/js/lib'); // → null
     * confineToBase('/srv/app/js/lib/app.js', '/srv/app/js/lib');                      // → '/srv/app/js/lib/app.js'
     */
    var confineToBase = function(filename, base) {
        if ( typeof(filename) != 'string' || typeof(base) != 'string' || base.length === 0 ) {
            return null;
        }
        var _resolvedBase = path.resolve(base);
        var _resolvedFile = path.resolve(filename);
        // separator-aware containment: identical to base, or a proper child of it
        if ( _resolvedFile === _resolvedBase || _resolvedFile.indexOf(_resolvedBase + path.sep) === 0 ) {
            return _resolvedFile;
        }
        return null;
    }

    /**
     * Resolves a request URL to an absolute asset filename by consulting
     * `publicResources`, `staticResources`, reverse-routing aliases, and
     * the bundle's `content.statics` map. Returns `'404.html'` when not found.
     *
     * @inner
     * @private
     * @param {object} bundleConf - Bundle/env configuration slice
     * @param {string} url - Decoded request URL
     * @returns {string} Absolute filename path, or `'404.html'`
     */
    var getAssetFilenameFromUrl = function(bundleConf, url) {

        var staticsArr  = bundleConf.publicResources;
        // #B30: reachable with an attacker-controlled URL (the HTTP/2 static path
        // passes request-derived `pathname` here — server.js ~2500), so a malformed
        // % escape would otherwise throw URIError, uncaught, and crash the bundle.
        // was: url = decodeURIComponent( url );
        url = safeDecodeURIComponent( url );
        var staticProps = {
            firstLevel  : '/'+ url.split(/\//g)[1] + '/',
            isFile      :  /^\/[A-Za-z0-9_-]+\.(.*)$/.test(url)
        };
        var notFound = '404.html'

        var filename        = null
            , path          = null
            , altConf       = ( typeof(staticProps.firstLevel) != 'undefined' && typeof(self.conf.reverseRouting) != 'undefined' ) ? self.conf.reverseRouting[staticProps.firstLevel] : false
            , backedupPath  = null
            , _base         = null // #B64 — intended base dir to confine `filename` against
        ;
        if (
            staticProps.isFile && staticsArr.indexOf(url) > -1
            || staticsArr.indexOf(staticProps.firstLevel) > -1
            || typeof(altConf) != 'undefined' && altConf
        ) {

            // by default
            path = url.replace(url.substring(url.lastIndexOf('/')+1), '');
            if ( typeof(altConf) != 'undefined' && altConf ) {
                bundleConf = self.conf[altConf.split(/\@/)[1]][bundleConf.env];
                backedupPath = path;
                path = path.replace(staticProps.firstLevel, '/');
            }


            // catch `statics.json` defined paths || bundleConf.staticResources.indexOf(url.replace(url.substring(url.lastIndexOf('/')+1), '')) > -1
            if (  bundleConf.staticResources.indexOf(path) > -1 || bundleConf.staticResources.indexOf(staticProps.firstLevel) > -1 ) {
                if ( typeof(altConf) != 'undefined' && altConf && backedupPath ) {
                    filename = (bundleConf.staticResources.indexOf(path) > -1) ? bundleConf.content.statics[path] + url.replace(backedupPath, '/') : bundleConf.content.statics[staticProps.firstLevel] + url.replace(staticProps.firstLevel, '/');
                } else {
                    filename = (bundleConf.staticResources.indexOf(path) > -1) ? bundleConf.content.statics[path] + url.replace(path, '/') : bundleConf.content.statics[staticProps.firstLevel] + url.replace(staticProps.firstLevel, '/');
                }
                // #B64 path-traversal guard — the mapped filename above is
                // `<mapping target> + <url remainder>` by raw concatenation, so a
                // decoded `../` in the remainder escapes the target dir. Capture the
                // matched mapping target as the base to confine against (below).
                _base = (bundleConf.staticResources.indexOf(path) > -1) ? bundleConf.content.statics[path] : bundleConf.content.statics[staticProps.firstLevel];
            } else {
                filename = ( bundleConf.staticResources.indexOf(url) > -1 ) ? bundleConf.content.statics[url] : bundleConf.publicPath + url;
                // #B64 path-traversal guard — exact-match mapping target, else the
                // bundle `publicPath` (for the `publicPath + url` fallback).
                _base    = ( bundleConf.staticResources.indexOf(url) > -1 ) ? bundleConf.content.statics[url] : bundleConf.publicPath;
            }


            // #B64 — reject any path that canonicalises outside its base dir
            // (traversal). Returns notFound (`404.html`) — identical to a missing
            // file, no distinct signal. Guards every caller (HTTP/2 push, asset
            // catalog) at this single resolver chokepoint.
            if ( confineToBase(filename, _base) === null )
                return notFound;

            if ( !fs.existsSync(filename) )
                return notFound;

            return filename

        } else {
            return notFound
        }
    }

    /**
     * Synchronously fetches the body of a URL via HTTP GET using `httpclient`.
     *
     * @inner
     * @private
     * @param {string} url - Fully-qualified URL to fetch
     * @param {string} [encoding] - Character encoding for decoding the body
     * @returns {string} Decoded response body
     */
    var readFromUrl = function(url, encoding) {
        return new (require('httpclient').HttpClient)({
            method: 'GET',
              url: url
            }).finish().body.read().decodeToString();
    }

    /**
     * Parses a rendered layout string for `<link>`, `<script>`, `<source>`,
     * and `<img>` tags, resolves each asset URL to an absolute file path, and
     * returns a structured assets map used by the rendering pipeline.
     * When `swig` and `data` are provided the function was called from a
     * controller action (in-request asset resolution).
     *
     * @inner
     * @private
     * @param {object} bundleConf - Bundle/env configuration slice
     * @param {string} layoutStr - Rendered HTML layout string to scan for asset tags
     * @param {object} [swig] - Swig instance when called from the controller
     * @param {object} [data] - Template data when called from the controller
     * @returns {object} Assets map keyed by URL
     */
    var getAssets = function (bundleConf, layoutStr, swig, data) {

        // layout search for <link|source|script|img>
        var layoutAssets        = layoutStr.match(/<link .*?<\/link>|<link .*?(rel\=\"(stylesheet|icon|manifest|(.*)\-icon))(.*)|<source .*?(type\=\"(image))(.*)|<script.*?<\/script>|<img .*?(.*)/g) || [];

        var assets      = {}
            , cssFiles  = []
            , aCount    = 0
            , i         = 0
            , len       = 0
            , domain    = null
            , key       = null // [ code ] url
            , ext       = null
            , url       = null
            , filename  = null
        ;

        // user's defineds assets
        var layoutClasses     = [];

        // layout assets
        i   = 0;
        len = layoutAssets.length;
        var type                    = null
            , isAvailable           = null
            , tag                   = null
            , properties            = null
            , p                     = 0
            , pArr                  = []
            , sourceTagSrcSetStr    = ''
        ;
        for (; i < len; ++i) {

            if (
                !/(\<img|\<link|\<source|\<script)/g.test(layoutAssets[i])
                // ||
                // not able to handle srcset case for now
                /**
                /\<img/.test(layoutAssets[i])
                    &&  /srcset/.test(layoutAssets[i])*/
            ) {
                continue;
            }

            // https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/preload
            let asType = null;

            if ( /\<img/.test(layoutAssets[i]) ) {
                type    = 'image';
                tag     = 'img';
                asType  = type;
            }



            if ( /\<link/.test(layoutAssets[i]) ) {
                // if ( /rel\=\"stylesheet/.test(layoutAssets[i]) ) {
                //     type    = 'stylesheet';
                // } else if ( /rel\=\"(icon|(.*)\-icon)/.test(layoutAssets[i]) ) {
                //     type    = 'image';
                // } else {
                //     type = 'file';
                // }
                type = layoutAssets[i].match(/rel=\"[-a-z 0-9]+\"/)[0] || null;
                if (type) {
                    type = type.replace(/^rel\=\"|"$/g, '');
                }


                switch (type) {
                    case /stylesheet/.test(type):
                        asType  = 'style';
                        break;

                    case /javascript/.test(type):
                        asType  = 'script';
                        break;

                    default:
                        asType  = null;
                        if ( /icon/.test(type) ) {
                            asType  = 'image';
                            // ignoring all (fav)icons type: rel="*icon*" case
                            continue;
                        }
                        if ( /font/.test(type) ) {
                            asType  = 'font';
                        }
                        // if ( /manifest/.test(type) ) {
                        //     asType  = 'webmanifest';
                        // }
                        break;
                }

                tag     = 'link';
            }

            if ( /\<source/.test(layoutAssets[i]) ) {
                if ( /type\=\"image/.test(layoutAssets[i]) ) {
                    type    = 'image';
                }

                tag     = 'source';
            }

            if ( /\<script/.test(layoutAssets[i]) ) {
                type    = 'javascript';
                tag     = 'script';
                // Skip inline scripts (no src attribute) — not external assets
                if ( !/\ssrc\s*=/.test(layoutAssets[i]) ) {
                    continue;
                }
            }

            domain  = null;
            let isEncodedContent = false;
            // repsonsive images
            // https://html.spec.whatwg.org/multipage/semantics.html#attr-link-imagesrcset
            let srcset  = null;
            // https://html.spec.whatwg.org/multipage/semantics.html#attr-link-imagesizes
            let sizes   = null;
            let urlArr  = null;
            try {
                urlArr  = layoutAssets[i].match(/(src|href|srcset)\=(\".*?\"|\'.*?\')/g);
                for (let u=0, uLen=urlArr.length; u<uLen; u++) {
                    if ( /data\:/.test(urlArr[u]) ) {
                        isEncodedContent = true;
                        break;
                    }
                    if ( /^srcset\=/.test(urlArr[u]) ) {
                        srcset = urlArr[u]
                                    .replace(/((src|href|srcset)\=\"|(src|href|srcset)\=\')/g, '')
                                    .replace(/\"/g, '');
                        if ( /source/i.test(tag) ) {
                            sourceTagSrcSetStr += srcset + ','
                        }
                    }
                    if ( /^(src|href)\=/.test(urlArr[u]) ) {
                        url = urlArr[u]
                                    .replace(/((src|href|srcset)\=\"|(src|href|srcset)\=\')/g, '')
                                    .replace(/\"/g, '');
                    }
                }
                if ( isEncodedContent ) { // ignoring "data:..."
                    continue
                }
                // url = urlArr[0];
            } catch (err) {
                console.warn('Problem with this asset ('+ i +'/'+ len +'): '+ layoutAssets[i].substring(0, 80) +'...');
                continue;
            }

            if ( /source/i.test(tag) ) {
                continue;
            }


            // if ( /data\:/.test(url) ) { // ignoring "data:..."
            //     continue
            // }
            //url = url.replace(/((src|href)\=\"|(src|href)\=\'|\"|\')/g, '');
            // url = url
            //         .replace(/((src|href|srcset)\=\"|(src|href|srcset)\=\')/g, '')
            //         .replace(/\"/g, '')
            // ;
            // FRAMEWORK PATCH: drop the `^` anchor so the
            // decorative-quote strip is also skipped when `{{ }}` is embedded
            // mid-string (e.g. `css/main.css?cache={{ ''|formatDate('HH:MM:ss') }}`).
            // Without this, inner Swig string-literal quotes get stripped, the
            // expression becomes `{{ |formatDate(HH:MM:ss) }}`, and the cached
            // layout's runtime Swig pass throws "Unexpected colon on line N".
            // Reproduces in v0.3.9-alpha.2 (last touched 2026-04-26).
            if ( !/\{\{/.test(url) ) {
                url = url.replace(/(\"|\')/g, '');
            }
            if (swig && /^\{\{/.test(url) ) {
                url = swig.compile(url, swig.getOptions())(data);
            }

            if (!/(\:\/\/|^\/\/)/.test(url) ) {
                filename = getAssetFilenameFromUrl(bundleConf, url);
            } else {
                domain      = url.match(/^.*:\/\/[a-z0-9._-]+\/?/);
                //url         = ( new RegExp('/'+ bundleConf.host +'/' ).test(domain) ) ? url.replace(domain, '/') : url;

                if ( ! new RegExp('/'+ bundleConf.host +'/' ).test(domain) ) {
                    continue;
                }

                url         = url.replace(domain, '/');
                filename    = url
            }
            //key =  (( /404/.test(filename) ) ? '[404]' : '[200]') +' '+ url;
            key         = url;
            isAvailable =  ( /404/.test(filename) ) ? false : true;
            if ( isAvailable ) {
                try {
                    ext         = url.substring(url.lastIndexOf('.')).match(/(\.[A-Za-z0-9]+)/)[0];
                } catch(err) {

                    console.warn('No extension found for `'+ filename +'`\n'+ err.stack );
                    ext = null
                }
            }


            assets[key] = {
                type        : type,
                as          : asType,
                url         : url,
                ext         : ext,
                mime        : (!ext) ? 'NA' : (bundleConf.server.coreConfiguration.mime[ext.substring(1)] || 'NA'),
                filename    : ( /404/.test(filename) ) ? 'not found' : filename,
                isAvailable : isAvailable
            };

            //sourceTagSrcSetStr
            if (sourceTagSrcSetStr.length > 0) {
                assets[key]['imagesrcset'] = sourceTagSrcSetStr.substring(0, sourceTagSrcSetStr.length-1);
                // reset
                sourceTagSrcSetStr = '';
            }

            if (srcset) {
                if ( typeof(assets[key]['imagesrcset']) != 'undefined' ) {
                    assets[key]['imagesrcset'] += ', '+ srcset;
                } else {
                    assets[key]['imagesrcset'] = srcset;
                }

            }

            if (sizes) {
                if ( typeof(assets[key]['imagesizes']) != 'undefined' ) {
                    assets[key]['imagesizes'] += ', '+ sizes;
                } else {
                    assets[key]['imagesizes'] = sizes;
                }
            }

            if (domain) {
                assets[key].domain = domain;
            }

            if ( type == 'stylesheet' && !/not found/.test(assets[key].filename) ) {
                cssFiles.push(assets[key].filename)
            }

            properties = layoutAssets[i].replace( new RegExp('(\<'+ tag +'\\s+|\>|\/\>|\<\/'+ tag +'\>)', 'g'), '').replace(/[A-Za-z]+\s+/, '$&="true" ').split(/\"\s+/g);
            p = 0;

            for (; p < properties.length; ++p ) {

                pArr = properties[p].split(/\=/g);
                if ( /(src|href)/.test(pArr[0]) )
                    continue;

                assets[key][pArr[0]] = (pArr[1]) ? pArr[1].replace(/\"/g, '') : pArr[1];
            }
            //++aCount
        }

        // getting layout css classes in order to retrieve active css assets from <asset>.css
        var classesArr = layoutStr.match(/class=\"([A-Za-z0-9_-\s+]+)\"?/g);

        if ( classesArr ) {
            var cCount      = 0
                , cArr      = null
                , cArrI     = null
                , cArrLen   = null
            ;
            i = 0;
            len = classesArr.length;
            for (; i < len; ++i) {
                classesArr[i] = classesArr[i].replace(/(\"|class\=)/g, '').trim();

                if ( /\s+/g.test(classesArr[i]) ) {
                    cArrI   = 0;
                    cArr    = classesArr[i].replace(/\s+/g, ',').split(/\,/g);
                    //cArr    = classesArr[i].split(/\s+/g);
                    cArrLen = cArr.length;

                    for (; cArrI < cArrLen; ++cArrI) {

                        if ( layoutClasses.indexOf( cArr[cArrI] ) < 0) {
                            layoutClasses[cCount] = cArr[cArrI];

                            ++cCount
                        }
                    }
                    continue;
                }

                if ( layoutClasses.indexOf( classesArr[i] ) < 0) {
                    layoutClasses[cCount] = classesArr[i];
                    ++cCount
                }
            }
            assets._classes = {
                total: layoutClasses.length,
                list: layoutClasses.join(', ')
            };

            // parsing css files
            i = 0, len = cssFiles.length;
            var cssContent      = null
                , hasUrls       = null
                , definition    = null
                , defName       = null
                , d             = null
                , dLen          = null
                , cssMatched    = null
            ;
            var cssArr = null, classNames = null, assetsInClassFound = {};
            for (; i < len; ++i) {
                //if ( /^(http|https)\:/.test(cssFiles[i]) ) {
                //    cssContent = readFromUrl(cssFiles[i], bundleConf.encoding);
                //} else {
                    cssContent = fs.readFileSync(cssFiles[i], bundleConf.encoding).toString();
                //}

                hasUrls = ( /(url\(|url\s+\()/.test(cssContent) ) ? true : false;
                if (!hasUrls) continue;

                cssArr = cssContent.split(/}/g);
                for (let c = 0; c < cssArr.length; ++c) {

                    if ( /(\@media|\@font-face)/.test(cssArr[c]) ) { // one day maybe !
                        continue
                    }

                    if ( /(url\(|url\s+\()/.test(cssArr[c]) && !/data\:|\@font-face/.test(cssArr[c]) ) {

                        url = cssArr[c].match(/((background\:url|url)+\()([A-Za-z0-9->~_.,:"'%/\s+]+).*?\)+/g)[0].replace(/((background\:url|url)+\(|\))/g, '').trim();
                        if ( typeof(assetsInClassFound[url]) != 'undefined') continue; // already defined

                        //cssMatched = cssArr[c].match(/((\.[A-Za-z0-9-_.,;:"'%\s+]+)(\s+\{|{))/);
                        cssMatched = cssArr[c].match(/((\.[A-Za-z0-9->~_.,;:"'%\s+]+)(\s+\{|{))/);
                        if ( !cssMatched ) { // might be a symbol problem : not supported by the regex
                            console.warn('[ HTTP2 ][ ASSETS ][ cssMatchedException ] `'+ cssFiles[i] +'`: unable to match definition for url : '+ url +'\n'+ cssArr[c]);
                            continue;
                        }
                        definition = cssMatched[0].replace(/\{/g, '');

                        classNames = definition.replace(/\./g, '').split(/\s+/);


                        for( let clss = 0; clss < classNames.length; ++clss) {
                            // this asset is in use
                            if ( layoutClasses.indexOf(classNames[clss] < 0 && typeof(assetsInClassFound[url]) == 'undefined') ) {
                                //console.debug(' found -> (' +  url +')');
                                assetsInClassFound[url] = true;
                                // assetsInClassFound[url] = {
                                //     cssFile: cssFiles[i],
                                //     definition: definition,
                                //     url: url
                                // }
                                if (!/(\:\/\/|^\/\/)/.test(url) ) {
                                    filename = getAssetFilenameFromUrl(bundleConf, url);
                                } else {
                                    domain      = url.match(/^.*:\/\/[a-z0-9._-]+\/?/);
                                    url         = url.replace(domain, '/');
                                    filename    = url
                                }

                                //key =  (( /404/.test(filename) ) ? '[404]' : '[200]') +' '+ url;
                                key         = url;
                                isAvailable =  ( /404/.test(filename) ) ? false : true;
                                ext         = url.substring(url.lastIndexOf('.')).match(/(\.[A-Za-z0-9]+)/)[0];
                                assets[key] = {
                                    referrer    : cssFiles[i],
                                    definition  : definition,
                                    type        : type,
                                    url         : url,
                                    ext         : ext,
                                    mime        : bundleConf.server.coreConfiguration.mime[ext.substring(1)] || 'NA',
                                    filename    : ( /404/.test(filename) ) ? 'not found' : filename
                                };

                                if (domain)
                                    assets[key].domain = domain;

                                break;
                            }
                        }
                    }
                    //font-family: source-sans-pro, sans-serif;


                }

                // match all definitions .xxx {}
                //definitions = cssContent.match(/((\.[A-Za-z0-9-_.\s+]+)+(\s+\{|{))([A-Za-z0-9-@'"/._:;()\s+]+)\}/g);
                //definitions = cssContent.match(/((\.[A-Za-z0-9-_.\s+]+)+(\s+\{|{))?/g);
                // d = 0, dLen = definitions.length;
                // for (; d < dLen; ++d) {
                //     if ( definitions[d] )
                // }

                // fonts, images, background - attention required to relative paths !!
                //var inSourceAssets = cssContent.match(/((background\:url|url)+\()([A-Za-z0-9-_."']+).*?\)+/g);
            }

            assets._cssassets = assetsInClassFound.count();
        } // EO if (classesArr) {



        // TODO - report
        /**
         * assets._report = {
         *      total   : ${int: aCount}, // assets count
         *      warning : [
         *          {
         *              message: "too many requests",
         *              hint: "you should lower this"
         *          },
         *          {...}
         *      ],
         *      error: [
         *          {
         *              message: "${int: eCount} asset(s) not found",
         *              hint: "check your assets location"
         *          },
         *          {
         *
         *          }
         *      ]
         * }
         */


        if (swig) { // Deprecated
            var assetsStr = JSON.stringify(assets);
            assets = swig.compile( assetsStr.substring(1, assetsStr.length-1), swig.getOptions() )(data);

            return '{'+ assets +'}';
        } else {
            return JSON.stringify(assets)
        }
    }

    // var getHeaderFromPseudoHeader = function(header) {

    //     var htt2Headers = {
    //         ':status'   : 'status',
    //         ':method'   : 'method',
    //         ':authority': 'host',
    //         ':scheme'   : 'scheme', // not sure
    //         ':path'     : 'path', // not sure
    //         ':protocol' : 'protocol' // not sure
    //     };

    //     if ( typeof(htt2Headers[header]) != 'undefined' ) {
    //         return htt2Headers[header]
    //     }

    //     return header
    // }

    /**
     * Merges configured response headers (CORS, cache-control, etc.) into the
     * response. Resolves `Access-Control-Allow-Origin` against the bundle's
     * allowed origins list and normalises HTTP/1.1 vs HTTP/2 header names.
     * When `server.http3Advertisement` is enabled, also emits the opt-in
     * `Alt-Svc: h3=":443"; ma=86400` HTTP/3-advertisement header (#H11).
     *
     * @inner
     * @private
     * @param {object|null} responseHeaders - Extra headers to merge, or null to use conf defaults
     * @param {object} request - Incoming request object
     * @param {object} response - Server response object
     * @returns {object} The merged response headers object
     */
    var completeHeaders = function(responseHeaders, request, response) {

        var resHeaders      = null
            , referer       = null
            , authority     = null
            , method        = null
            , scheme        = null
            , re            = null
            , allowedOrigin = null
            , sameOrigin    = false
            , conf          = self.conf[self.appName][self.env]
        ;

        if ( typeof(responseHeaders) == 'undefined' || !responseHeaders) {
            responseHeaders = {};
        }

        // #H11 — opt-in Alt-Svc HTTP/3-advertisement header on every routed
        // (user-facing) response. When server.http3Advertisement is true,
        // advertise an HTTP/3 (QUIC) alternative on :443 so QUIC-capable
        // clients upgrade via a QUIC-capable edge proxy (Caddy / nginx-QUIC /
        // Cloudflare). Gina does NOT implement QUIC — advertise only; the edge
        // terminates HTTP/3 on :443 (NOT the bundle's own listen port). Set via
        // response.setHeader so it is carried onto both engines: completeHeaders
        // runs for Isaac routed requests through the composeHeadersMiddleware
        // drain and for the Express engine alike, and the render delegates fold
        // response.getHeaders() into the HTTP/2 stream.respond. First-writer-
        // wins: an upstream-set Alt-Svc is never clobbered. Off by default.
        if (
            conf.server.http3Advertisement
            && typeof(response.getHeader) == 'function'
            && !response.getHeader('alt-svc')
        ) {
            response.setHeader('alt-svc', 'h3=":443"; ma=86400');
        }

        // Copy to avoid override
        resHeaders  = JSON.clone(conf.server.response.header);
        // #B121 — falsy-aware guard: a failed route resolution can leave
        // `request.routing` holding the boolean `false` (a sentinel, not undefined),
        // and this file is strict-mode — writing `.bundle` onto a primitive throws
        // from inside the error-response path itself (a double-fault: the throw
        // escapes the router's catch through throwError's own call back into this
        // function, and the second identical throw is uncaught → process kill).
        // was: if ( typeof(request.routing) == 'undefined' ) {
        if ( !request.routing ) {
            request.routing = {
                'url'   : request.url,
                'method': request.method
            }
        }
        if ( typeof(request.routing.bundle) == 'undefined' ) {
            request.routing.bundle = self.appName
        }
        // Should not override main server.response.header.methods
        resHeaders['access-control-allow-methods'] = request.routing.method.replace(/(\,\s+|\,)/g, ', ').toUpperCase();

        if ( typeof(request.headers.origin) != 'undefined' ) {
            authority = request.headers.origin;
        } else if (request.headers.referer) {
            referer = request.headers.referer.match(/^[https://|http://][a-z0-9-_.:/]+\//);
            if (Array.isArray(referer) && referer.length > 0) {
                referer = referer[0].substring(0, referer.length-1);
            }
        }

        // access-control-allow-origin settings
        if ( resHeaders.count() > 0 ) {

            // authority by default if no Access Control Allow Origin set
            if (!authority) {
                if (!referer) {
                    if ( /http\/2/.test(conf.server.protocol) ) {
                        authority   = request.headers[':authority'] || request.headers.host;
                        scheme      = request.headers[':scheme'] || request.headers['x-forwarded-proto'] || conf.server.scheme;
                    } else {
                        authority   = request.headers.host;
                        scheme      = ( new RegExp(authority).test(referer) ) ? referer.match(/^http(.*)\:\/\//)[0].replace(/\:\/\//, '') : conf.server.scheme;
                    }
                    authority = scheme +'://'+ authority;
                } else {
                    authority   = referer;
                    sameOrigin  = authority;
                }
            }

            if (!sameOrigin && conf.hostname == authority || !sameOrigin && conf.hostname.replace(/\:\d+$/, '') == authority.replace(/\:\d+$/, '') ) {
                sameOrigin = authority
            }

            re = new RegExp(authority);
            allowedOrigin = ( typeof(conf.server.response.header['access-control-allow-origin']) != 'undefined' && conf.server.response.header['access-control-allow-origin'] != '' ) ? conf.server.response.header['access-control-allow-origin'] : authority;
            // console.debug('[ server ][access-control-allow-origin] ', allowedOrigin);
            var found = null, origin = null, origins = null; // to handles multiple origins

            var originHostReplacement = function(name) {
                var matched = name.match(/{([-_A-z]+?@[-_A-z]+?)}/g);
                if (!matched || !Array.isArray(matched) || Array.isArray(matched) && matched.length == 0 ) {
                    return name
                }

                var env     = self.conf.env || self.env
                    , scope = self.conf.scope || self.scope
                ;

                for (let i=0, len=matched.length; i<len; ++i) {
                    let oldHost = matched[i];
                    let newHost = matched[i].replace(/\{|\}|\s+/g, '');
                    newHost = newHost.split(/\@/);
                    let bundle      = newHost[0]
                        , project   = newHost[1]
                        , arr       = null
                        , hostname  = null
                        , scheme    = null
                    ;
                    if ( /\//.test(newHost[1]) ) {
                        arr     = newHost[1].split(/\//);
                        project = arr[0];
                        env     = (arr[1]) ? arr[1] : env;
                    }
                    if ( typeof(self.conf[bundle]) == 'undefined' ) {
                        continue;
                    }
                    scheme  = self.conf[bundle][env].server.scheme;
                    hostname  = ( !self.conf[bundle][env].hostname ) ? self.conf[bundle][env].server.scheme + '://' + self.conf[bundle][env].host + ':' + self.conf[bundle][env].server.port : self.conf[bundle][env].hostname;
                    name    = name.replace(oldHost, hostname);
                }
                matched = null;
                env = null;

                return name;
            }

            var headerValue = null, re = new RegExp('\{\s*(.*)\s*\}', 'g');
            for (let h in resHeaders) {
                if (
                    !response.headersSent
                ) {
                    // handles multiple origins
                    if ( /access\-control\-allow\-origin/i.test(h) ) { // re.test(resHeaders[h]
                        if (sameOrigin) {
                            origin = sameOrigin
                        } else {
                            if ( /\,/.test(allowedOrigin) ) {
                                origins = allowedOrigin.replace(/\s+/g, '').replace(re, originHostReplacement).split(/\,/g);

                                found = ( origins.indexOf(authority) > -1 ) ? origins[origins.indexOf(authority)] : false;
                                if ( found != false ) {
                                    origin = found
                                }
                            } else {
                                origin = allowedOrigin.replace(/\s+/g, '').replace(re, originHostReplacement);
                            }
                        }

                        if (origin || sameOrigin) {
                            if (!origin && sameOrigin) {
                                origin = sameOrigin;
                            }

                            try {
                                response.setHeader(h, origin);
                            } catch (headerError) {
                                console.error(headerError)
                            }
                        }
                        sameOrigin = false;
                    } else {
                        // #B13 — preserve preflight echo of access-control-allow-headers.
                        // checkPreflightRequest() echoes back the browser's
                        // access-control-request-headers list so the preflight passes even
                        // when the bundle's static ACAH config does not list every header
                        // the client sends (e.g. Content-Type). Without this guard, the
                        // static value below would overwrite that echo and break CORS.
                        if (
                            /^access\-control\-allow\-headers$/i.test(h)
                            && request.isPreflightRequest
                            && response.getHeader('access-control-allow-headers')
                        ) {
                            continue;
                        }
                        headerValue = resHeaders[h];
                        try {
                            response.setHeader(h, headerValue);
                        } catch (headerError) {
                            console.error(headerError)
                        }
                    }
                }
            }
        }

        // update response
        try {
            if ( responseHeaders && Object.keys(responseHeaders).length > 0 ) {
                return merge(responseHeaders, response.getHeaders());
            }
            return response.getHeaders();
        } catch(err) {
            return responseHeaders
        }
    }

    /**
     * HTTP/2 server-push handler. Resolves asset paths for the current request
     * and pushes static files to the client over open HTTP/2 streams.
     * Attached to the server instance by the Isaac engine.
     *
     * @memberof module:gina/core/server
     * @param {object} stream - Node.js `Http2ServerRequest` stream
     * @param {object} headers - HTTP/2 request headers object
     * @param {object} response - HTTP/2 response object
     */
    this.onHttp2Stream = function(stream, headers, response) {
        var header          = null
            , isWebroot     = false
            , pathname      = null
            , asset         = null
            , assets        = this._options.template.assets
            , conf          = this._options.conf
            , isCacheless   = conf.isCacheless
        ;


        if (
            headers[':path'] == '/'
            || headers[':path'] == this._options.conf.server.webroot
        ) {

            if (
                this._options.conf.server.webroot != headers[':path']
                && this._options.conf.server.webrootAutoredirect
                || headers[':path'] == this._options.conf.server.webroot
                    && this._options.conf.server.webrootAutoredirect
            ) {
                isWebroot = true
            }
        }

        var url = (isWebroot) ? this._referrer : headers[':path'];

        var hanlersPath     = conf.handlersPath
            , isHandler     = (
                                typeof(assets[ url ]) != 'undefined'
                                && typeof(assets[ url ].filename) != 'undefined'
                                && new RegExp('^'+ hanlersPath).test(assets[ url ].filename)
                            ) ? true: false
        ;

        if (!stream.pushAllowed ) {

            // Fix added for static sites
            if (
                !assets[ url ]
                ||
                !assets[ url ].isBinary && !assets[ url ].isHandler
            ) {
                return;
            }

            asset = {
                url         : url,
                filename    : assets[ url ].filename,
                file        : null,
                isAvailable : assets[ url ].isAvailable,
                mime        : assets[ url ].mime,
                encoding    : conf.encoding,
                isBinary    : assets[ url ].isBinary,
                isHandler   : assets[ url ].isHandler
            };
            header = merge({ ':status': 200 }, response.getHeaders());
            header['content-type'] = ( !/charset/.test(asset.mime ) ) ? asset.mime + '; charset='+ asset.encoding : asset.mime;
            header = completeHeaders(header, local.request, response);
            if (asset.isBinary || asset.isHandler ) {


                if (asset.isHandler) {
                    // adding handler `gina.ready(...)` wrapper
                    var file = null;
                    if ( !fs.existsSync(asset.filename) ) {
                        throwError({stream: stream}, 404, 'Page not found: \n' + headers[':path']);
                        return;
                    }

                    if (!assets[ url ].file) {
                        file      = fs.readFileSync(asset.filename, asset.encoding).toString();
                        file      = '(gina.ready(function onGinaReady($){\n'+ file + '\n},window["originalContext"]));';
                        this._options.template.assets[ headers[':path'] ].file = file;
                    } else {
                        file = assets[ url ].file;
                    }

                    // header['content-length'] = fs.statSync(file).size;
                    stream.respond(header);
                    stream.end(file);

                    return;
                }

                header['content-length'] = fs.statSync(asset.filename).size;
                stream.respondWithFile(
                    asset.filename
                    , header
                    //, { onError }
                );

            } else {
                stream.respond(header);
                stream.end();
            }

            return;
        }

        if (stream.headersSent) return;

        if ( !this._options.template ) {
            throwError({stream: stream}, 500, 'Internal server error\n' + headers[':path'] + '\nNo template found');
            return;
        }

        if (
            // headers[':path'] == '/'
            // || headers[':path'] == this._options.conf.server.webroot
            /^true$/i.test(isWebroot)
        ) {
            header = {
                ':status': 301
            };

            if (isCacheless) {
                header['cache-control'] = 'no-cache, no-store, must-revalidate';
                header['pragma'] = 'no-cache';
                header['expires'] = '0';
            }
            header['location'] = this._options.conf.server.webroot;

            stream.respond(header);
            stream.end();
            return;
        }

        if (
            typeof(this._options.template.assets) != 'undefined'
            && typeof(this._options.template.assets[ headers[':path'] ]) != 'undefined'
            && this._options.template.assets[ headers[':path'] ].isAvailable
            || isWebroot
        ) {
            // by default
            header = {
                ':status': 200
            };
            var responseHeaders = ( typeof(this._responseHeaders) != 'undefined') ? this._responseHeaders : null;
            asset = {
                url         : url,
                filename    : assets[ url ].filename,
                file        : null,
                isAvailable : assets[ url ].isAvailable,
                mime        : assets[ url ].mime,
                encoding    : conf.encoding,
                isHandler   : isHandler
            };

            console.debug('h2 pushing: '+ headers[':path'] + ' -> '+ asset.filename);

            // Adding handler `gina.ready(...)` wrapper
            if ( new RegExp('^'+ conf.handlersPath).test(asset.filename) ) {

                if ( !fs.existsSync(asset.filename) ) {
                    throwError({stream: stream}, 404, 'Page not found: \n' + headers[':path']);
                    return;
                }

                asset.isHandler = this._options.template.assets[ headers[':path'] ].isHandler  = true;
                asset.file      = fs.readFileSync(asset.filename, asset.encoding).toString();
                asset.file      = '(gina.ready(function onGinaReady($){\n'+ asset.file + '\n},window["originalContext"]));';

                stream.respond(header);
                stream.end(asset.file);

                return;
            }

            stream.pushStream({ ':path': headers[':path'] }, function onPushStream(err, pushStream, headers){


                if ( err ) {
                    header[':status'] = 500;
                    if (err.code === 'ENOENT' || !asset.isAvailable ) {
                        header[':status'] = 404;
                    }
                    //console.info(headers[':method'] +' ['+ header[':status'] +'] '+ headers[':path'] + '\n' + (err.stack||err.message||err));
                    var msg = ( header[':status'] == 404 ) ? 'Page not found: \n' + asset.url :  'Internal server error\n' + (err.stack||err.message||err)
                    throwError({stream: pushStream}, header[':status'], msg);
                    return;
                }


                header['content-type'] = ( !/charset/.test(asset.mime ) ) ? asset.mime + '; charset='+ asset.encoding : asset.mime;
                if (assets[ url ].isBinary) {
                    header['content-length'] = fs.statSync(assets[ url ].filename).size;
                }

                if (isCacheless) {
                    // source maps integration for javascript & css
                    if ( /(.js|.css)$/.test(asset.filename) && fs.existsSync(asset.filename +'.map') ) {
                        //pathname = asset.filename +'.map';
                        pathname = headers[':path'] +'.map';
                        header['X-SourceMap'] = pathname;
                    }
                    // replaced: cache-control was only set for source-mapped .js/.css —
                    // same bug as the handleStatics HTTP/2 path. Apply to all pushed assets.
                    header['cache-control'] = 'no-cache, no-store, must-revalidate';
                    header['pragma'] = 'no-cache';
                    header['expires'] = '0';
                }

                if (responseHeaders) {
                    header = merge(header, responseHeaders);
                }
                header = completeHeaders(header, local.request, response);
                var pushedFile = (/index.html$/.test(headers[':path']) && /\/$/.test(asset.filename) ) ? asset.filename +'index.html': asset.filename;
                pushStream.respondWithFile(
                    pushedFile
                    , header
                    //, { onError }
                );

            });
        } else {
            var status = 404;
            if ( /\/$/.test(headers[':path']) && this._options.template.assets[ headers[':path'] +'index.html' ].isAvailable   ) { // preview of directory is forbidden
                status = 403;
                headers[':status'] = status;
            }
            return throwError({stream: stream}, status, 'Page not found: \n' + headers[':path']);
        }
    }



    /**
     * Returns the negotiated response protocol string (e.g. `'http/1.1'` or
     * `'http/2'`). Upgrades to `'http/2'` when the bundle is configured for
     * HTTP/2 and the response has an open stream.
     *
     * @inner
     * @private
     * @param {object} response - Server response object
     * @returns {string} Protocol string
     */
    var getResponseProtocol = function (response) {

        var protocol    = 'http/'+ local.request.httpVersion; // inheriting request protocol version by default
        var bundleConf  = self.conf[self.appName][self.env];
        // Switching protocol to h2 when possible
        if ( /http\/2/.test(bundleConf.server.protocol) && response.stream ) {
            protocol    = bundleConf.server.protocol;
        }

        return protocol;
    }

    /**
     * Default HTTP/1.x static file handler. Resolves the filename from the URL,
     * streams the file to the response with the correct MIME type, or calls
     * `next` when the file is not found or falls through to routing.
     * For HTTP/2.x statics, see `SuperController`.
     *
     * @inner
     * @private
     * @param {object} staticProps - Object with `.isStaticFilename` and `.firstLevel` URL segment
     * @param {object} request - Incoming request object
     * @param {object} response - Server response object
     * @param {function} next - Next middleware callback
     */
    var handleStatics = function(staticProps, request, response, next) {


        var conf            = self.conf
            , bundleConf    = conf[self.appName][self.env]
            , webroot       = bundleConf.server.webroot
            , re            = new RegExp('^'+ webroot)
            , publicPathRe  = new RegExp('^'+ bundleConf.publicPath)
            , pathname      = ( webroot.length > 1 && re.test(request.url) ) ? request.url.replace(re, '/') : request.url
            , contentType   = null
            , stream        = null
            , header        = null
            , protocol      = getResponseProtocol(response)
        ;


        // h2 protocol response option
        if ( /http\/2/.test(protocol) ) {

            stream = response.stream;

            if ( typeof(self._options) == 'undefined') {
                self._options       = {
                    template: {
                        assets: {}
                    },
                    conf: bundleConf
                }
            }

            self._options.conf = bundleConf
        }

        var isCacheless       = bundleConf.isCacheless;
        // by default
        var filename        = bundleConf.publicPath + pathname;
        // #B64 path-traversal guard — the intended base dir for `filename`. Starts
        // at publicPath (the default build above) and is re-pointed to the matched
        // statics mapping target in each branch below, then confined post-decode.
        var _staticBase     = bundleConf.publicPath;
        var isFilenameDir   = null
            , stat          = null
            , dirname       = null
            , isBinary      = null
            , isHandler     = null
            , hanlersPath   = null
            , preferedEncoding = bundleConf.server.preferedCompressionEncodingOrder
            , acceptEncodingArr = (request.headers['accept-encoding']) ? request.headers['accept-encoding'].replace(/\s+/g, '').split(/\,/) : []
            , acceptEncoding = null
        ;

        // catch `statics.json` defined paths
        var staticIndex     = bundleConf.staticResources.indexOf(pathname);
        if ( staticProps.isStaticFilename && staticIndex > -1 ) {
            filename =  bundleConf.content.statics[ bundleConf.staticResources[staticIndex] ]
            _staticBase = filename; // #B64 — exact single-file mapping; base = the file itself
        } else {
            var s = 0, sLen = bundleConf.staticResources.length;
            for ( ; s < sLen; ++s ) {
                // #SCS1 (2026-04-23) — swap `eval` for `new RegExp` so Socket no longer flags the
                //                       server-side `Uses eval` risk here. Semantics unchanged: both
                //                       forms build the same regex from the (already slash-escaped)
                //                       `staticResources` path.
                // if ( eval('/^' + bundleConf.staticResources[s].replace(/\//g,'\\/') +'/').test(pathname) ) {
                if ( new RegExp('^' + bundleConf.staticResources[s].replace(/\//g,'\\/')).test(pathname) ) {
                    // #B64 — capture the matched mapping target as the confinement base
                    _staticBase = bundleConf.content.statics[ bundleConf.staticResources[s] ];
                    filename = bundleConf.content.statics[ bundleConf.staticResources[s] ] +'/'+ pathname.replace(bundleConf.staticResources[s], '');
                    break;
                }
            }

            // try local
            if ( !fs.existsSync(filename) ) {
                var key = pathname.replace(pathname.split('/').splice(-1), '');
                for ( ; s < sLen; ++s ) {
                    if ( bundleConf.staticResources[s] == key ) {
                        // #B64 — capture the matched mapping target as the confinement base
                        _staticBase = bundleConf.content.statics[ bundleConf.staticResources[s] ];
                        filename = bundleConf.content.statics[ bundleConf.staticResources[s] ] +'/'+ pathname.replace(bundleConf.staticResources[s], '');
                        break;
                    }
                }
                key = null;
            }
            s       = null;
            sLen    = null;

        }


        // #B30: a static-asset request URL with a malformed % escape (e.g.
        // GET /assets/%E0%.css) would otherwise throw URIError here, uncaught,
        // and crash the bundle. Fall back to the raw filename on a bad escape.
        // was: filename = decodeURIComponent(filename);
        filename = safeDecodeURIComponent(filename);
        // #B64 path-traversal guard — `filename` above is `<base> + '/' + <url
        // remainder>` (or `publicPath + pathname`) by raw concatenation, so a
        // decoded `../` (incl. %2F / %2e%2e, now settled by the line above)
        // escapes the base dir. Reject anything resolving outside `_staticBase`
        // with a plain 404 — identical to a missing file, no distinct signal.
        // Guards BOTH the fs.readFile and fs.createReadStream sinks below.
        if ( confineToBase(filename, _staticBase) === null ) {
            return throwError(response, 404, 'Page not found: \n' + pathname, next);
        }
        let filenameObj = new _(filename, true);
        filenameObj.exists(function onStaticExists(exists) {
        // fs.exists(filename, function onStaticExists(exists) {

            if (!exists) {
                return throwError(response, 404, 'Page not found: \n' + pathname, next);
            }

            stat = fs.statSync(filename);
            isFilenameDir = stat.isDirectory();
            if ( isFilenameDir ) {
                dirname = request.url;
                filename += 'index.html';
                request.url += 'index.html';

                if ( !fs.existsSync(filename) ) {
                    throwError(response, 403, 'Forbidden: \n' + pathname, next);
                    return;
                }

                var ext = 'html';
                if ( /http\/2/.test(protocol) ) {
                    header = {
                        ':status': 301,
                        'location': request.url,
                        'content-type': bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding
                    };

                    if (isCacheless) {
                        header['cache-control'] = 'no-cache, no-store, must-revalidate';
                        header['pragma'] = 'no-cache';
                        header['expires'] = '0';
                    }
                    request = checkPreflightRequest(request, response);
                    header  = completeHeaders(header, request, response);

                    if (!stream.destroyed) {
                        stream.respond(header);
                        stream.end();
                    }

                } else {
                    response.setHeader('location', request.url);
                    request = checkPreflightRequest(request, response);
                    completeHeaders(null, request, response);
                    // The redirect status is unconditional — mirroring the HTTP/2
                    // sibling above; only the no-cache set is dev-gated. Without
                    // it, a non-dev directory hit answered 200 with a Location
                    // header browsers ignore (a blank page instead of the index).
                    var _dirHeaders = {
                        'content-type': bundleConf.server.coreConfiguration.mime[ext]
                    };
                    if (isCacheless) {
                        _dirHeaders['cache-control'] = 'no-cache, no-store, must-revalidate'; // preventing browsers from using cache
                        _dirHeaders['pragma'] = 'no-cache';
                        _dirHeaders['expires'] = '0';
                    }
                    response.writeHead(301, _dirHeaders);
                    response.end()
                }

                return;
            }


            if (isCacheless) {
                delete require.cache[require.resolve(filename)];
            }

            if (response.headersSent) {
                // May be sent by http/2 push
                return
            }
            fs.readFile(filename, bundleConf.encoding, function onStaticFileRead(err, file) {
                if (err) {
                    throwError(response, 404, 'Page not found: \n' + pathname, next);
                    return;
                }

                if (!response.headersSent) {

                    // ETag + Last-Modified for conditional GET (#Next)
                    var lastModified = stat.mtime.toUTCString();
                    var etag = '"' + stat.size + '-' + stat.mtime.getTime() + '"';

                    // 304 Not Modified — only in production (dev always re-serves for live reload)
                    if (!isCacheless) {
                        var ifNoneMatch     = request.headers['if-none-match'];
                        var ifModifiedSince = request.headers['if-modified-since'];
                        var isNotModified   = (ifNoneMatch && ifNoneMatch === etag)
                                            || (!ifNoneMatch && ifModifiedSince && new Date(ifModifiedSince) >= stat.mtime);
                        if (isNotModified) {
                            if ( /http\/2/.test(protocol) ) {
                                stream.respond({ ':status': 304 });
                                stream.end();
                            } else {
                                response.writeHead(304);
                                response.end();
                            }
                            console.info(request.method +' [304] '+ pathname);
                            return;
                        }
                    }

                    isBinary    = true;
                    isHandler   = false;

                    try {
                        contentType = getContentTypeByFilename(filename);

                        // adding gina loader
                        if ( /text\/html/i.test(contentType) && self.isCacheless() ) {
                            isBinary = false;
                            // javascriptsDeferEnabled
                            if  (bundleConf.content.templates._common.javascriptsDeferEnabled ) {
                                file = file.replace(/\<\/head\>/i, '\t'+ bundleConf.content.templates._common.ginaLoader +'\n</head>');
                            } else {
                                file = file.replace(/\<\/body\>/i, '\t'+ bundleConf.content.templates._common.ginaLoader +'\n</body>');
                            }

                        } else {
                            // adding handler `gina.ready(...)` wrapper
                            hanlersPath = bundleConf.handlersPath;

                            if ( new RegExp('^'+ hanlersPath).test(filename) ) {
                                isBinary    = false;
                                isHandler   = true;
                                file = '(gina.ready(function onGinaReady($){\n'+ file + '\n},window["originalContext"]));'

                                // acceptEncodingArr = request.headers['accept-encoding'].replace(/\s+/g, '').split(/\,/);
                                // acceptEncoding = null;
                                for (let e=0, eLen=preferedEncoding.length; e<eLen; e++) {
                                    if ( acceptEncodingArr && acceptEncodingArr.indexOf(preferedEncoding[e]) > -1 ) {
                                        acceptEncoding = bundleConf.server.coreConfiguration.encoding[ preferedEncoding[e] ] ;
                                        break;
                                    }
                                }
                                // Compressed content
                                if (
                                    !isCacheless
                                    && acceptEncoding
                                    && fs.existsSync(filename + acceptEncoding)
                                ) {
                                    isBinary = true;
                                }
                            }
                        }

                        if ( /http\/2/.test(protocol) ) {
                            self._isStatic      = true;
                            self._referrer      = request.url;
                            var ext = request.url.match(/\.([A-Za-z0-9]+)$/);
                            request.url = ( ext != null && typeof(ext[0]) != 'undefined' ) ? request.url : request.url + 'index.html';

                            self._responseHeaders         = response.getHeaders();
                            if (
                                !isBinary
                                && typeof(self._options.template.assets[request.url]) == 'undefined'
                            ) {
                                // #assets-guard — getAssets() returns the assets map SERIALIZED as a
                                // string (its render-path consumers in controller.render-swig.js /
                                // controller.render-v1.js embed it verbatim). `template.assets` must
                                // stay an OBJECT here: assigning the raw string and then writing
                                // `template.assets[request.url]` below throws under 'use strict'
                                // (TypeError: Cannot create property '<url>' on string '{}'), killing the
                                // bundle under concurrent static requests (Chrome HTTP/2 favicon/manifest
                                // prefetch). Parse it back into the object form it represents.
                                try {
                                    self._options.template.assets = JSON.parse( getAssets(bundleConf, file) || '{}' );
                                } catch (e) {
                                    self._options.template.assets = {};
                                }
                            }

                            // #assets-guard — defense-in-depth: never write a property on a non-object
                            // assets map (binary requests skip the coercion above).
                            if ( typeof(self._options.template.assets) != 'object' || self._options.template.assets == null ) {
                                self._options.template.assets = {};
                            }

                            if (
                                typeof(self._options.template.assets[request.url]) == 'undefined'
                                || isBinary
                            ) {

                                self._options.template.assets[request.url] = {
                                    ext: ( ext != null && typeof(ext[0]) != 'undefined' ) ? ext[0] : null,
                                    isAvailable: true,
                                    mime: contentType,
                                    url: request.url,
                                    filename: filename,
                                    isBinary: isBinary,
                                    isHandler: isHandler
                                }
                            }

                            self.instance._isXMLRequest    = request.isXMLRequest;
                            self.instance._getAssetFilenameFromUrl = getAssetFilenameFromUrl;

                            var isPathMatchingUrl = null;
                            if ( !self.instance._http2streamEventInitalized ) {
                                self.instance._http2streamEventInitalized = true;
                                self.instance.on('stream', function onHttp2Strem(stream, headers) {

                                    if (!self._isStatic) return;

                                    if (!this._isXMLRequest) {
                                        isPathMatchingUrl = true;
                                        if (headers[':path'] != request.url) {
                                            request.url         = headers[':path'];
                                            isPathMatchingUrl   = false;
                                        }

                                        // for new requests
                                        if (!isPathMatchingUrl) {
                                            pathname        = ( webroot.length > 1 && re.test(request.url) ) ? request.url.replace(re, '/') : request.url;
                                            isFilenameDir   = (webroot == request.url) ? true: false;

                                            if ( !isFilenameDir && !/404\.html/.test(filename) && fs.existsSync(filename) )
                                                isFilenameDir = fs.statSync(filename).isDirectory();
                                            if (!isFilenameDir) {
                                                filename = this._getAssetFilenameFromUrl(bundleConf, pathname);
                                            }

                                            if ( !isFilenameDir && !fs.existsSync(filename) ) {
                                                throwError(response, 404, 'Page not found: \n' + pathname, next);
                                                return;
                                            }


                                            if ( isFilenameDir ) {
                                                dirname = bundleConf.publicPath + pathname;
                                                filename =  dirname + 'index.html';
                                                request.url += 'index.html';
                                                if ( !fs.existsSync(filename) ) {
                                                    throwError(response, 403, 'Forbidden: \n' + pathname, next);
                                                    return;
                                                } else {
                                                    header = {
                                                        ':status': 301,
                                                        'location': request.url
                                                    };

                                                    if (isCacheless) {
                                                        header['cache-control'] = 'no-cache, no-store, must-revalidate';
                                                        header['pragma'] = 'no-cache';
                                                        header['expires'] = '0';
                                                    }


                                                    stream.respond(header);
                                                    stream.end();
                                                }
                                            }
                                        }

                                        contentType = getContentTypeByFilename(filename);
                                        contentType = contentType +'; charset='+ bundleConf.encoding;
                                        ext = request.url.match(/\.([A-Za-z0-9]+)$/);
                                        request.url = ( ext != null && typeof(ext[0]) != 'undefined' ) ? request.url : request.url + 'index.html';
                                        // #assets-guard — defense-in-depth before the property writes below.
                                        if ( typeof(self._options.template.assets) != 'object' || self._options.template.assets == null ) {
                                            self._options.template.assets = {};
                                        }
                                        if (
                                            !isPathMatchingUrl
                                            && typeof(self._options.template.assets[request.url]) == 'undefined'
                                        ) {

                                            self._options.template.assets[request.url] = {
                                                ext: ( ext != null && typeof(ext[0]) != 'undefined' ) ? ext[0] : null,
                                                //isAvailable: true,
                                                isAvailable: (!/404\.html/.test(filename)) ? true : false,
                                                mime: contentType,
                                                url: request.url,
                                                filename: filename,
                                                isBinary: isBinary,
                                                isHandler: isHandler
                                            }
                                        }

                                        if (!fs.existsSync(filename)) return;
                                        isBinary    = ( /text\/html/i.test(contentType) ) ? false : true;
                                        isHandler   = ( new RegExp('^'+ bundleConf.handlersPath).test(filename) ) ? true : false;
                                        if ( isBinary ) {
                                            // override
                                            self._options.template.assets[request.url] = {
                                                ext: ( ext != null && typeof(ext[0]) != 'undefined' ) ? ext[0] : null,
                                                isAvailable: true,
                                                mime: contentType,
                                                url: request.url,
                                                filename: filename,
                                                isBinary: isBinary,
                                                isHandler: isHandler
                                            }
                                        }

                                        if ( isHandler ) {
                                            // adding handler `gina.ready(...)` wrapper
                                            var file = null;
                                            if (!self._options.template.assets[request.url].file) {
                                                file      = fs.readFileSync(filename, bundleConf.encoding).toString();
                                                file      = '(gina.ready(function onGinaReady($){\n'+ file + '\n},window["originalContext"]));';
                                                self._options.template.assets[request.url].file = file;
                                            }
                                        }
                                        self.onHttp2Stream(stream, headers, response);
                                    }

                                }); // EO self.instance.on('stream' ..
                            }


                            header = {
                                ':status': 200,
                                'content-type': contentType + '; charset='+ bundleConf.encoding
                            };

                            if (isCacheless) {
                                // source maps integration for javascript & css
                                if ( /(.js|.css)$/.test(filename) && fs.existsSync(filename +'.map') && !/sourceMappingURL/.test(file) ) {
                                    //pathname = pathname +'.map';
                                    pathname = webroot + pathname.substring(1) +'.map';
                                    header['X-SourceMap'] = pathname;
                                }
                                // replaced: cache-control was only set for source-mapped .js/.css —
                                // all other static types (HTML, fonts, images) got no cache headers
                                // in HTTP/2 dev mode, causing heuristic freshness. Now applied to
                                // all statics, matching the HTTP/1.x dev path behaviour.
                                header['cache-control'] = 'no-cache, no-store, must-revalidate';
                                header['pragma'] = 'no-cache';
                                header['expires'] = '0';
                            } else {
                                // production: ETag + Last-Modified enable conditional GET (304) (#Next)
                                header['last-modified'] = lastModified;
                                header['etag'] = etag;
                            }

                            header  = completeHeaders(header, request, response);
                            if (isBinary) {
                                stream.respondWithFile(filename, header)
                            } else {
                                stream.respond(header);
                                stream.end(file);
                            }
                            // Fixed on march 15 2021 by removing the return
                            // Could be the cause why the push is pending
                            //return;
                        } else {

                            completeHeaders(null, request, response);
                            response.setHeader('content-type', contentType +'; charset='+ bundleConf.encoding);
                            // if (/\.(woff|woff2)$/i.test(filename) )  {
                            //     response.setHeader("transfer-encoding", 'Identity')
                            // }


                            if (isBinary) {
                                response.setHeader('content-length', fs.statSync(filename).size);

                                // acceptEncodingArr = request.headers['accept-encoding'].replace(/\s+/g, '').split(/\,/);
                                // acceptEncoding = null;
                                for (let e=0, eLen=preferedEncoding.length; e<eLen; e++) {
                                    if ( acceptEncodingArr && acceptEncodingArr.indexOf(preferedEncoding[e]) > -1 ) {
                                        acceptEncoding = bundleConf.server.coreConfiguration.encoding[ preferedEncoding[e] ] ;
                                        break;
                                    }
                                }
                                // Compressed content
                                if (
                                    !isCacheless
                                    && acceptEncoding
                                    && fs.existsSync(filename + acceptEncoding)
                                ) {
                                    filename += acceptEncoding;
                                    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Encoding
                                    response.setHeader('content-encoding', acceptEncoding.replace(/^\./, ''));
                                    // override content length
                                    response.setHeader('content-length', fs.statSync(filename).size);
                                }
                            }

                            if (isCacheless) {
                                // source maps integration for javascript & css
                                if ( /(.js|.css)$/.test(filename) && fs.existsSync(filename +'.map') && !/sourceMappingURL/.test(file) ) {
                                    //pathname = pathname +'.map'
                                    pathname = webroot + pathname.substring(1) +'.map';
                                    response.setHeader("X-SourceMap", pathname)
                                }

                                // serve without cache
                                response.writeHead(200, {
                                    'cache-control': 'no-cache, no-store, must-revalidate', // preventing browsers from caching it
                                    'pragma': 'no-cache',
                                    'expires': '0'
                                });

                            } else {
                                // production: ETag + Last-Modified enable conditional GET (304) (#Next)
                                response.writeHead(200, {
                                    'last-modified': lastModified,
                                    'etag': etag
                                });
                            }


                            if (isBinary) { // images, javascript, pdf ....

                                fs.createReadStream(filename)
                                    .on('end', function onResponse(){
                                        console.info(request.method +' [200] '+ pathname);
                                    })
                                    .pipe(response);
                            } else {
                                response.write(file, bundleConf.encoding);
                                response.end();
                                console.info(request.method +' [200] '+ pathname);
                            }

                            return;
                        }

                    } catch(err) {
                        throwError(response, 500, err.stack);
                        return;
                    }
                }

                return
            });


        });
        filenameObj = null;
    }


    /**
     * Attaches the catch-all route handler to the server instance.
     * Handles statics, preflight (CORS OPTIONS), body parsing, Express
     * middleware chain, and final routing delegation to the Router.
     *
     * The catch-all pattern is ENGINE-CONDITIONAL (#B211): Express mounts a
     * RegExp — Express 5 routes through path-to-regexp v8, which rejects a
     * bare `'*'` path string at mount time (`TypeError: Missing parameter
     * name`), while a RegExp path bypasses string parsing on Express 4 AND 5,
     * measured live-dispatching `/`, `/web/` and deep paths on both majors.
     * Isaac KEEPS the string `'*'`: its request listener's dispatch gate is
     * `path === '*' || path == request.url` (server.isaac.js:2366), so a
     * RegExp there matches NOTHING and every request hangs without a
     * response — measured, a deterministic container-boot timeout.
     *
     * @inner
     * @private
     * @returns {void}
     */
    var onRequest = function() {

        var apps = self.bundles;
        var webrootLen = self.conf[self.appName][self.env].server.webroot.length;

        // catch all (request urls)
        // #B211 — was: self.instance.all('*', ...) unconditionally. Express 5's
        // router rejects the bare-string wildcard at mount (boot abort before
        // listen()); isaac's dispatch gate REQUIRES it (see the JSDoc above).
        var catchAllPattern = ( /^express/.test(self.engine) ) ? /(.*)/ : '*';
        self.instance.all(catchAllPattern, function onInstance(request, response, next) {

            // #M12b / #COMPLY2 — stamp the request id + entry time at request entry.
            //
            // The ID is ALWAYS-ON (#COMPLY2 slice 1): the audit trail correlates every
            // record to its originating request, and audit is not a logging feature — an
            // audit record's correlation key must never depend on GINA_LOG_FORMAT. One id
            // serves both consumers, so an audit record and a JSON log line correlate by
            // construction. First-seer-guarded: a re-entered dispatch (isaac routes a
            // request through this catch-all as its listener's cb) must not regenerate the
            // id and split one request's records across two keys. Text-mode cost: one
            // crypto.randomUUID(). NOTE the id honours a sanitised inbound X-Request-Id, so
            // it is client-influenceable BY DESIGN — it is a correlation key, never
            // attribution (attribution is the audit record's session-derived actor).
            if ( !request._ginaReqId ) {
                request._ginaReqId = _resolveRequestId(request);
            }

            // The entry TIME stays JSON-log-gated — its only consumer is the logger's
            // durationMs (an audit record stamps its own `ts` at write time). The
            // per-request .run() happens at handle(): the request.on('end') boundary
            // between here and handle() loses async context, so the store must be
            // established where the dispatch runs.
            if ( _reqCtxLogging ) {
                request._ginaReqStartMs = Date.now();
            }

            // #FI — dev-mode request timeline for Inspector Flow tab
            // Only initialized when the Inspector has been opened (process.gina._inspectorActive)
            // #INS10 — or during a prod instrumentation window (process.gina._inspectorWindowUntil).
            // #OBS1 first-seer (!request._devTimeline): under isaac this onInstance runs as the
            // engine listener's cb, AFTER the isaac listener already ran this same init — an
            // unguarded overwrite would reset requestStart to this LATER time, dropping the
            // isaac-listener setup interval. The isaac listener claims first; this skips. On the
            // Express engine there is no isaac listener, so this claims. Keep the two tops in sync.
            if (((process.gina && process.gina._inspectorWindowUntil > Date.now()) || (self.isCacheless() && process.gina._inspectorActive)) && !request._devTimeline) {
                request._devTimeline = { requestStart: Date.now(), entries: [] };
            }
            // #OBS1 slice 3 — HTTP request lifecycle hook for Prometheus metrics.
            // Engine-agnostic mirror of the server.isaac.js hook. Gated on
            // lib.metrics.isEnabled() so the listener is only wired when
            // app.json metrics.enabled is true.
            // #OBS1 first-seer (!request._metricsRecorded): under isaac this onInstance runs as the
            // engine listener's cb, AFTER the isaac listener already wired this same finish-hook — an
            // unguarded second wiring double-registers the listener and recordRequest fires twice per
            // routed request. The isaac listener claims first; this skips. On the Express engine there
            // is no isaac listener, so this claims. Mirrors the RW-F8 _rwTracked claim below.
            if (lib.metrics.isEnabled() && !request._metricsRecorded) {
                request._metricsRecorded = true;
                request._metricsStartTime = Date.now();
                response.on('finish', function _gina_metrics_record() {
                    try {
                        var _route = (request.routing && request.routing.rule) || undefined;
                        lib.metrics.recordRequest({
                            method:   request.method,
                            route:    _route,
                            status:   response.statusCode,
                            duration: Date.now() - request._metricsStartTime
                        });
                    } catch (_e) { /* metrics never crashes a request */ }
                });
            }

            // #RWATCH — in-flight request gauge for the release-watch idle gate.
            // Sibling of the metrics hook above; wired only when the service armed
            // at boot (local scope + built release + opt-in). trackRequest() returns
            // an IDEMPOTENT finisher, so wiring both `finish` and `close` can never
            // double-decrement; /_gina/* control paths are excluded inside the lib
            // (an open SSE stream never fires `finish` — counting the release-watch
            // stream itself would deadlock the idle gate).
            // RW-F8 first-seer claim (request._rwTracked): under the isaac engine a
            // routed request runs BOTH the engine's server.on('request') listener AND
            // this onInstance (its cb) — both carry this gauge, so an unguarded hook
            // counts the request twice (self-balancing but inflating the reported
            // inFlight). The claim flag makes the count exactly-once on either engine.
            if (lib.releaseWatch.isActive() && !request._rwTracked) {
                request._rwTracked = true;
                var _rwDone = lib.releaseWatch.trackRequest(request.url);
                response.on('finish', _rwDone);
                response.on('close',  _rwDone);
            }

            // Caching = [...]
            // TODO - handle this through a middleware
            /**
            * var cacheIndex = ['/api/document/get/b47c4dd3-f7c4-44b2-b1fb-401948be1ca4'].indexOf(request.url)
            * if ( cacheIndex > -1) {
            *     // return caching[cacheIndex].content
            * }
            */

            // Retrieving cached route
            // var cachedUrls = ['/'];
            // if (cachedUrls.indexOf(request.url) > -1) {
            //     request.routing = JSON.parse('{"method":"GET","namespace":"home","url":"/","rule":"home@public","param":{"control":"home","file":"../home"},"middleware":["middlewares.maintenance.check"],"bundle":"public","isXMLRequest":false,"isWithCredentials":false}');
            //     var headers = JSON.parse('{"X-Powered-By":"Gina I/O - v0.1.6-alpha.94","access-control-allow-headers":"X-Requested-With, Content-Type","access-control-allow-methods":"GET","access-control-allow-credentials":true,"vary":"Origin","accept-language":"en-US,en;q=0.8,fr;q=0.6"}');
            //     for (let h in headers) {
            //         response.setHeader(h, headers[h]);
            //     }

            //     return local.router.route(request, response, next, request.routing);
            // }



            // #B103 (2026-07-20) — a multipart body must reach busboy RAW (Buffers):
            // decoding the request stream to strings mangles every byte sequence that
            // is not valid UTF-8 (→ U+FFFD) BEFORE busboy even parses, so binary file
            // payloads arrived pre-corrupted (and re-encoded ~1.5-2x larger). The
            // decode stays for every other content-type — the non-multipart branches
            // accumulate request.body as text. Same flag is reused by the multipart
            // branch below so the two sites cannot drift.
            // was:
            // request.setEncoding(self.conf[self.appName][self.env].encoding);
            request.isMultipart = /multipart\/form-data;/.test(request.headers['content-type'] || '');
            if ( !request.isMultipart ) {
                request.setEncoding(self.conf[self.appName][self.env].encoding);
            }
            // #FIN1 — XML request bodies reach the application verbatim. The flag is computed
            // here, beside the multipart one, so the content-type regex exists at exactly ONE
            // site: the three body branches (POST/PUT/PATCH) read the flag. That is the #B103
            // lesson applied — those same three sites had drifted apart before the multipart
            // test was collapsed to a single flag.
            //
            // The matched set is the one three independent implementations converge on:
            // ASP.NET Core registers `application/xml`, `text/xml` and `application/*+xml`
            // (MediaTypeHeaderValues.cs — ApplicationXml / TextXml / ApplicationAnyXmlSyntax,
            // all three added by XmlSerializerInputFormatter); Spring's MimeType.includes()
            // documents `application/*+xml` as including `application/soap+xml`; type-is
            // (Express/body-parser) matches structured suffixes generically. Note the wildcard
            // is scoped to `application/` in all of them — none registers `image/*+xml` or
            // `text/*+xml` — so `image/svg+xml` is deliberately NOT matched here.
            //
            // RFC 7303 §9.6.1 registers the `+xml` suffix, but RFC 6838 §4.2.8 makes it a
            // naming convention only and does NOT mandate generic processing: this set is
            // convergent implementation practice, not a normative requirement. The anchoring
            // correctly excludes the three RFC 7303 types that are not XML *documents* —
            // `application/xml-dtd` (§9.5) and both `xml-external-parsed-entity` (§9.3/§9.4).
            request.isXmlBody = /^\s*(application\/([\w.-]+\+)?xml|text\/xml)\s*(;|$)/i.test(request.headers['content-type'] || '');
            // be carfull, if you are using jQuery + cross domain, you have to set the header manually in your $.ajax query -> headers: {'X-Requested-With': 'XMLHttpRequest'}
            request.isXMLRequest       = ( request.headers['x-requested-with'] && request.headers['x-requested-with'] == 'XMLHttpRequest' ) ? true : false;

            // Passing credentials :
            //      - if you are using jQuery + cross domain, you have to set the `xhrFields` in your $.ajax query -> xhrFields: { withCredentials: true }
            //      - if you are using another solution or doing it by hand, make sure to properly set the header: headers: {'access-control-allow-credentials': true }
            /**
             * NB.: jQuery
             * The `withCredentials` property will include any cookies from the remote domain in the request,
             * and it will also set any cookies from the remote domain.
             * Note that these cookies still honor same-origin policies, so your JavaScript code can’t access the cookies
             * from document.cookie or the response headers.
             * They can only be controlled/produced by the remote domain.
             * */
            request.isWithCredentials  = ( request.headers['access-control-allow-credentials'] && request.headers['access-control-allow-credentials'] == true ) ? true : false;
            /**
             * Intercept gina headers for:
             *  - form valdiation
             *  - form security
             */
            var ginaHeaders = {
                form: {},
                popin: {}
            };
            // if (/x\-gina\-form\-id/i.test(request.headers['access-control-request-headers']) ) {
            if ( typeof(request.headers['x-gina-form-rule']) != 'undefined' ) {
                ginaHeaders.form.id = request.headers['x-gina-form-id'];
            }
            if ( typeof(request.headers['x-gina-popin-id']) != 'undefined' ) {
                ginaHeaders.popin.id = request.headers['x-gina-popin-id'];
            }
            if ( typeof(request.headers['x-gina-popin-name']) != 'undefined' ) {
                ginaHeaders.popin.name = request.headers['x-gina-popin-name'];
            }
            // #SPA1 — content-negotiation signal. `X-Gina-Navigate: fragment` asks a
            // NEGOTIABLE route (routing.json `negotiate: true`) for its layoutless body
            // instead of the full page. Parked here with the other gina headers rather
            // than overloading `X-Requested-With`, which popin / link / validator all
            // already send and which the render + error paths already fork on.
            // Unknown values are deliberately NOT rejected — they fall through to the
            // full page, so extending the vocabulary later is backward-compatible.
            if ( typeof(request.headers['x-gina-navigate']) != 'undefined' ) {
                ginaHeaders.navigate = String(request.headers['x-gina-navigate']).trim().toLowerCase();
            }
            if ( typeof(request.headers['x-gina-form-rule']) != 'undefined' ) {
                var rule = request.headers['x-gina-form-rule'].split(/\@/);
                ginaHeaders.form.rule = rule[0];
                ginaHeaders.form.bundle = rule[1];
                rule = null;
            }
            request.ginaHeaders = ginaHeaders;

            local.request = request;

            // #HDR8 — engine-agnostic gate: `settings.json > server.hidePoweredBy`
            // must also cover responses that never traverse the express middleware
            // chain (static-asset serves, static/traversal 404s, framework error
            // pages) — the HidePoweredBy middleware's removeHeader and the env.json
            // `server.response.header` override only reach routed responses.
            if ( !self.conf[self.appName][self.env].server.hidePoweredBy ) {
                response.setHeader('X-Powered-By', 'Gina/'+ GINA_VERSION );
            }

            // #OW1 — engine-agnostic security headers (OWASP A02). Placed beside
            // the hidePoweredBy gate because it needs the SAME coverage: routed
            // responses, static-asset serves, static/traversal 404s and framework
            // error pages, none of which traverse the express middleware chain —
            // and on the default isaac engine NOTHING traverses it (measured: the
            // only consumer of server._expressMiddlewares is the WS session
            // binder, name-filtered, against an inert response). The isaac
            // writeHead sites are covered by the twin call inside
            // _setPoweredByHeader(). First-writer-wins inside the emitter, so an
            // explicitly mounted #HDR plugin or an env.json
            // `server.response.header` entry always wins.
            lib.securityHeadersEmitter.applyToResponse(
                self.conf[self.appName][self.env].server.securityHeaders,
                request,
                response
            );

            // MS1 — echo the always-on correlation id on every response so a
            // caller / LB / APM can read it back (the read-side of X-Request-Id
            // propagation). Ungated (independent of log format) and guarded
            // against an already-sent response.
            if ( request._ginaReqId && !response.headersSent ) {
                response.setHeader('X-Request-Id', request._ginaReqId);
            }

            // ── #B384 — cross-origin WRITE guard for the /_gina/* control family ────────
            // PLACEMENT IS THE FEATURE, exactly as with the #MAINT1 gate below.
            //
            // It sits ABOVE every /_gina/* handler so that each one — and every
            // FUTURE one — inherits the refusal without having to remember it.
            // The alternative seams were both measured worse: the shared body
            // reader `_readInstrumentBody` fronts only 2 of the family (the
            // query-param endpoints never read a body at all), and folding the
            // check into lib.admin.isClientAllowed would silently widen a
            // function whose name promises an IP check, catching six admin GETs
            // that were never the problem.
            //
            // WHY it is needed: these endpoints authenticate with an AMBIENT
            // credential (the client IP), so a lured operator browsing from an
            // allowlisted address — loopback by DEFAULT, i.e. the machine
            // running the bundle — silently carries that credential into any
            // request an attacker's page makes. /_gina/storage/gc,
            // /_gina/cache/clear and /_gina/release/rebuild read their whole
            // input from the QUERY STRING and no body, so this needs no fetch
            // and no CORS reasoning: an auto-submitting <form> is enough.
            //
            // SAFE methods are deliberately untouched — the Inspector's
            // cross-origin GET/SSE channels (/_gina/agent, /_gina/logs,
            // /_gina/indexes) are a documented design, and a cross-origin GET
            // is not a CSRF vector. MEASURED before shipping: the plugin source
            // issues ZERO POSTs to /_gina/*, with a firing control (23 hits on
            // /_gina/agent), so no shipped caller is broken by this.
            //
            // Keep in sync with the core/server.isaac.js twin.
            if (
                /^\/_gina\//.test(request.url)
                && !lib.admin.isSafeMethod(request.method)
                && lib.admin.isCrossOriginWrite(request)
            ) {
                console.warn('[admin] refused a cross-origin write to `' + request.url.split('?')[0] + '` — `' + self.appName + '`');
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                response.statusCode = 403;
                return response.end(JSON.stringify({ error: 'forbidden', message: 'cross-origin write to a /_gina/* control endpoint is refused' }));
            }

            // ── /_gina/health/check — liveness probe (always-on, UNGATED) ───────────────
            // (MS2) Engine-agnostic mirror of the Isaac handler (server.isaac.js ~:1105).
            // GET only, returns {status:"healthy", timestamp}. Deliberately UNGATED — no
            // dev gate and no admin/metrics IP allowlist: it exposes no process state, and
            // liveness probes (kubelet, Docker HEALTHCHECK, LB) originate off-loopback, so
            // an allowlist would defeat the endpoint's purpose. Uses the express idiom
            // (setHeader/statusCode/end), NOT the Isaac stream / _setPoweredByHeader. Kept
            // in sync with the isaac fast-path per the /_gina/* built-in endpoint rule.
            if (
                request.method.toUpperCase() === 'GET'
                && /\/_gina\/health\/check$/i.test(request.url)
            ) {
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                response.setHeader('pragma',        'no-cache');
                response.setHeader('expires',       '0');
                response.statusCode = 200;
                return response.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
            }

            // ── /_gina/assets/routing.json — client routing map (always-on, public) ─────
            // (#B212) Engine-agnostic mirror of the Isaac fast-path (server.isaac.js
            // ~:2079). Under isaac the fast-path answers first with the precompressed
            // file variants, so this handler is what serves the map under any other
            // engine (express) — where the asset previously fell through to routing
            // and 404'd, and the client (no response.ok check — #B213) then installed
            // the 404 JSON body AS its routing table. Serves the maps built once at
            // init by buildClientRoutingAssets(). GET only + the isaac header set;
            // X-Powered-By / X-Request-Id are already emitted above for every
            // onInstance response, so they are inherited, not re-set.
            if (
                request.method.toUpperCase() === 'GET'
                && /\/_gina\/assets\/routing\.json$/i.test(request.url)
                && self._clientRoutingAssets
            ) {
                // #B65-twin — per-request proxied classification (keep in sync with
                // the core/server.isaac.js #B65 block + the core/router.js #B67 twin):
                // proxied iff the inbound Host is port-less (heuristic, disabled by
                // process.gina._proxyRequireForwarded — #B152) OR an explicit
                // X-Forwarded-Host is present. Computed inline because the #B65 stamp
                // (request._ginaIsProxyHost) is isaac-request-path-only and the #B67
                // twin runs at routing time — after this handler.
                var _croutHost    = request.headers.host || request.headers[':authority'];
                var _croutProxied = (
                    ( _croutHost && !/\:[0-9]+$/.test(_croutHost)
                        && process.gina._proxyRequireForwarded !== true )
                    || request.headers['x-forwarded-host']
                ) ? true : false;
                var _croutEtag = ( _croutProxied === true )
                    ? self._clientRoutingAssets.strippedEtag
                    : self._clientRoutingAssets.fullEtag;
                response.setHeader('content-type', 'application/json; charset=utf8');
                response.setHeader('vary', 'Origin');
                // #B66 — a shared cache must not cross-serve the stripped (proxied) and
                // full (raw) variants under the same URL; mark the proxied variant
                // private. Slice 3 (#SPA1): `no-cache` = revalidate-before-use — the
                // per-variant weak ETag turns each page boot into one conditional GET
                // (usually a 304), so a restart's new route table reaches returning
                // browsers immediately instead of after a 24h max-age window.
                response.setHeader('cache-control', ( _croutProxied === true ) ? 'private, no-cache' : 'public, no-cache');
                response.setHeader('x-content-type-options', 'nosniff');
                response.setHeader('x-frame-options', 'DENY');
                response.setHeader('x-xss-protection', '1; mode=block');
                response.setHeader('etag', _croutEtag);
                if ( request.headers['if-none-match'] === _croutEtag ) {
                    response.statusCode = 304;
                    return response.end();
                }
                response.statusCode = 200;
                return response.end( ( _croutProxied === true ) ? self._clientRoutingAssets.stripped : self._clientRoutingAssets.full );
            }

            // ── /_gina/metrics — Prometheus exposition (always-on, opt-in via app.json) ──
            // (#OBS1 slice 2) Engine-agnostic mirror of the Isaac handler. Method gate
            // is GET only; IP allowlist comes from app.json `metrics.allowFrom` (default
            // loopback). 503 when metrics.enabled is false in app.json.
            if (
                request.method.toUpperCase() === 'GET'
                && /\/_gina\/metrics$/.test(request.url)
            ) {
                if ( !lib.metrics.isClientAllowed(request) ) {
                    response.setHeader('content-type',  'application/json; charset=utf8');
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.statusCode = 403;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/metrics: client IP not in app.json metrics.allowFrom' }));
                }
                if ( !lib.metrics.isEnabled() ) {
                    response.setHeader('content-type',  'text/plain; version=0.0.4; charset=utf-8');
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.statusCode = 503;
                    return response.end('# /_gina/metrics — metrics not enabled\n# set app.json metrics.enabled to true and install prom-client (npm install prom-client)\n');
                }
                return lib.metrics.getMetrics().then(function(_metricsText) {
                    response.setHeader('content-type',  'text/plain; version=0.0.4; charset=utf-8');
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    return response.end(_metricsText);
                }).catch(function(_metricsErr) {
                    response.setHeader('content-type',  'application/json; charset=utf8');
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.statusCode = 500;
                    return response.end(JSON.stringify({ error: 'metrics_error', message: _metricsErr.message || String(_metricsErr) }));
                });
            }

            // ── /_gina/info — process/runtime state (always-on, admin-gated) ─────────
            // (#S7) Engine-agnostic mirror of the Isaac handler. GET only. The IP
            // allowlist comes from app.json `admin.allowFrom` (default loopback) via
            // process.gina._adminAllowList; 403 JSON on deny. The `http2` block is
            // Isaac-only (the Express engine has no HTTP/2 session metrics —
            // _h2Metrics is undefined here), so it degrades to omitted under Express.
            if (
                request.method.toUpperCase() === 'GET'
                && /\/_gina\/info$/i.test(request.url)
            ) {
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                response.setHeader('pragma',  'no-cache');
                response.setHeader('expires', '0');
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/info: client IP not in app.json admin.allowFrom' }));
                }
                var infoPayload = {
                    "cache-is-enabled": self.instance._cacheIsEnabled,
                    "memory"  : process.memoryUsage(),
                    "uptime"  : process.uptime(),
                    "version" : process.version
                };
                if (self.instance._h2Metrics) {
                    infoPayload["http2"] = {
                        activeSessions    : self.instance._h2Metrics.activeSessions,
                        totalStreams      : self.instance._h2Metrics.totalStreams,
                        goawayCount       : self.instance._h2Metrics.goawayCount,
                        rstCount          : self.instance._h2Metrics.rstCount,
                        rapidResetBlocked : self.instance._h2Metrics.rapidResetBlocked,
                        extendedConnect   : self.instance._h2Metrics.extendedConnect
                    };
                }
                return response.end(JSON.stringify(infoPayload));
            }

            // ── /_gina/cache/stats — cache statistics (always-on, admin-gated) ───────
            // (#S7) Engine-agnostic mirror of the Isaac handler. GET only. Same admin
            // IP allowlist as /_gina/info. Builds a Cache view over the shared
            // self.instance._cached Map and returns its stats(); 403 JSON on deny.
            if (
                request.method.toUpperCase() === 'GET'
                && /\/_gina\/cache\/stats$/i.test(request.url)
            ) {
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                response.setHeader('pragma',  'no-cache');
                response.setHeader('expires', '0');
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/cache/stats: client IP not in app.json admin.allowFrom' }));
                }
                var _cacheStatsView = new lib.Cache();
                _cacheStatsView.from(self.instance._cached);
                var _cacheStatsPayload = _cacheStatsView.stats();
                // #RC5 — L2 (redis) health when a render-cache store was wired at boot
                // (gna.js #RC4): an ADDITIVE `l2` field — absent on memory/fs-only
                // bundles, so existing consumers of { size, entries } are untouched.
                // health() is sync (an ioredis status-property read, no network), so
                // the admin endpoint can never hang on a dead redis.
                if ( process.gina && process.gina._renderCacheStore
                        && typeof(process.gina._renderCacheStore.health) === 'function' ) {
                    _cacheStatsPayload.l2 = process.gina._renderCacheStore.health();
                }
                return response.end(JSON.stringify(_cacheStatsPayload));
            }

            // ── /_gina/cache/clear — flush the render/output cache (always-on, admin-gated) ──
            // (#RC) Engine-agnostic mirror of the Isaac handler. POST only — a
            // cache flush is a mutation, never a safe/idempotent GET (a GET could
            // be fired by a prefetch/crawler). Same admin IP allowlist as
            // /_gina/cache/stats. Scoped to the static:/data: output namespaces
            // via lib.RenderCache.clear() — never wipes swig: compiled templates
            // or http2session: entries. Optional ?bundle=<name> restricts the
            // flush to one bundle; optional ?event=<name> evicts only the entries
            // registered to that event (the route's cache.invalidateOnEvents) and
            // takes precedence over ?bundle. Current-namespace fs bodies are removed
            // via the entries' cleanup fns; old-namespace fs orphans are reclaimed by
            // the CLI (gina cache:clear), not in-process.
            if (
                request.method.toUpperCase() === 'POST'
                && /\/_gina\/cache\/clear(\?.*)?$/i.test(request.url)
            ) {
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                response.setHeader('pragma',  'no-cache');
                response.setHeader('expires', '0');
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/cache/clear: client IP not in app.json admin.allowFrom' }));
                }
                var _cacheClearBundle = null;
                var _cacheClearEvent  = null;
                var _cacheClearQi     = request.url.indexOf('?');
                if ( _cacheClearQi > -1 ) {
                    var _cacheClearQs = new URLSearchParams(request.url.slice(_cacheClearQi + 1));
                    _cacheClearBundle = _cacheClearQs.get('bundle') || null;
                    _cacheClearEvent  = _cacheClearQs.get('event')  || null;
                }
                var _cacheClearView = new lib.RenderCache();
                _cacheClearView.from(self.instance._cached);
                // `event` wins over `bundle`. Load-bearing: `event` used to be an
                // unread param, so ?event=<name> fell through with bundle === null and
                // silently flushed EVERY bundle's output cache — the opposite of the
                // narrow eviction the caller asked for.
                if ( _cacheClearEvent ) {
                    var _cacheEvicted = _cacheClearView.invalidateByEvent(_cacheClearEvent);
                    return response.end(JSON.stringify({ ok: true, event: _cacheClearEvent, cleared: _cacheEvicted }));
                }
                var _cacheCleared = _cacheClearView.clear(_cacheClearBundle);
                return response.end(JSON.stringify({ ok: true, bundle: _cacheClearBundle, cleared: _cacheCleared }));
            }

            // ── /_gina/jobs/:id — async-job status (always-on, state-only) ──────────
            // (#AI6 slice 3) Engine-agnostic mirror of the Isaac handler. GET only.
            // Returns lib.job.toStatusView (id + state + timestamps) — never the
            // result / error payload (authenticated result retrieval goes through a
            // user route via self.jobStatus). 404 for an unknown / malformed id.
            var _ginaJobsMatch = (request.method.toUpperCase() === 'GET')
                ? request.url.match(/\/_gina\/jobs\/([A-Za-z0-9_-]+)\/?(\?.*)?$/)
                : null;
            if ( _ginaJobsMatch ) {
                var _ginaJobId = _ginaJobsMatch[1];
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                return lib.job.get(_ginaJobId, function(_jErr, _jRec) {
                    if (_jErr || !_jRec) {
                        response.statusCode = 404;
                        return response.end(JSON.stringify({ error: 'not_found', message: '/_gina/jobs/' + _ginaJobId + ': unknown job id' }));
                    }
                    return response.end(JSON.stringify(lib.job.toStatusView(_jRec)));
                });
            }

            // ── /_gina/storage/* — storage maintenance (#STO1 CLI slice; always-on, admin-gated) ──
            // Engine-agnostic ONLY — no isaac fast-path, per the /_gina/agent
            // precedent (the isaac instance runs this same onRequest chain, so
            // one handler covers both engines). Same admin IP allowlist as
            // /_gina/info & /_gina/cache/* — the surface discloses filesystem
            // ROOTS and gc DELETES, the /_gina/cache/stats class. NO dev gate:
            // operational tooling. Patterns are ^-anchored (the RW-F9 lesson —
            // unanchored, any URL that merely EMBEDS the path would match).
            // No fix-over-HTTP: verify's racy half stays offline where it is
            // safe by construction — the running process serves REPORTS, and
            // the gc sweep is the one sanctioned mutation.
            //
            // GET /_gina/storage/stats?driver=<name>
            //   → { configured, drivers: [ {name, strategy, root, capabilities,
            //     store: {objects, refcounted, zeroRefPending, inline, bytes}|null }
            //     | {name, error} ] } — the driver's own stats() shape, verbatim.
            if (
                request.method.toUpperCase() === 'GET'
                && /^\/_gina\/storage\/stats(\?.*)?$/i.test(request.url)
            ) {
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                response.setHeader('pragma',  'no-cache');
                response.setHeader('expires', '0');
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/storage/stats: client IP not in app.json admin.allowFrom' }));
                }
                var _stoStatsNames  = lib.storage.list();
                var _stoStatsDriver = null;
                var _stoStatsQi     = request.url.indexOf('?');
                if ( _stoStatsQi > -1 ) {
                    _stoStatsDriver = new URLSearchParams(request.url.slice(_stoStatsQi + 1)).get('driver') || null;
                }
                if ( _stoStatsDriver ) {
                    if ( _stoStatsNames.indexOf(_stoStatsDriver) < 0 ) {
                        response.statusCode = 404;
                        return response.end(JSON.stringify({ error: 'not_found', message: '/_gina/storage/stats: no driver `' + _stoStatsDriver + '` (configured: ' + (_stoStatsNames.join(', ') || 'none') + ')' }));
                    }
                    _stoStatsNames = [ _stoStatsDriver ];
                }
                var _stoStatsOut  = { configured: lib.storage.isStarted(), drivers: [] };
                var _stoStatsNext = function(_stoI) {
                    if ( _stoI >= _stoStatsNames.length ) {
                        return response.end(JSON.stringify(_stoStatsOut));
                    }
                    lib.storage.get(_stoStatsNames[_stoI]).stats(function(_stoErr, _stoView) {
                        _stoStatsOut.drivers.push(_stoErr
                            ? { name: _stoStatsNames[_stoI], error: _stoErr.message || String(_stoErr) }
                            : _stoView);
                        _stoStatsNext(_stoI + 1);
                    });
                };
                return _stoStatsNext(0);
            }

            // POST /_gina/storage/gc?dryRun=1&driver=<name> — POST only: a gc
            // pass is a mutation (a prefetch/crawler must never fire it — the
            // /_gina/cache/clear rationale). `dryRun=1` lists what a real pass
            // would collect and touches NOTHING. A real pass LOOPS sweepNow()
            // until the driver reports `drained` (each pass is batch-capped),
            // bounded so a pathological store cannot pin the request forever.
            // A driver without a sweep (sharded) is named-and-skipped, never
            // an error — the design's "no sweep" is a strategy fact.
            if (
                request.method.toUpperCase() === 'POST'
                && /^\/_gina\/storage\/gc(\?.*)?$/i.test(request.url)
            ) {
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                response.setHeader('pragma',  'no-cache');
                response.setHeader('expires', '0');
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/storage/gc: client IP not in app.json admin.allowFrom' }));
                }
                var _stoGcNames  = lib.storage.list();
                var _stoGcDriver = null;
                var _stoGcDry    = false;
                var _stoGcQi     = request.url.indexOf('?');
                if ( _stoGcQi > -1 ) {
                    var _stoGcQs = new URLSearchParams(request.url.slice(_stoGcQi + 1));
                    _stoGcDriver = _stoGcQs.get('driver') || null;
                    _stoGcDry    = ( _stoGcQs.get('dryRun') === '1' || _stoGcQs.get('dryRun') === 'true' );
                }
                if ( _stoGcDriver ) {
                    if ( _stoGcNames.indexOf(_stoGcDriver) < 0 ) {
                        response.statusCode = 404;
                        return response.end(JSON.stringify({ error: 'not_found', message: '/_gina/storage/gc: no driver `' + _stoGcDriver + '` (configured: ' + (_stoGcNames.join(', ') || 'none') + ')' }));
                    }
                    _stoGcNames = [ _stoGcDriver ];
                }
                var _stoGcOut  = { configured: lib.storage.isStarted(), dryRun: _stoGcDry, drivers: [] };
                var _stoGcNext = function(_stoI) {
                    if ( _stoI >= _stoGcNames.length ) {
                        return response.end(JSON.stringify(_stoGcOut));
                    }
                    var _stoGcName = _stoGcNames[_stoI];
                    var _stoGcDrv  = lib.storage.get(_stoGcName);
                    if ( typeof _stoGcDrv.sweepNow !== 'function' ) {
                        _stoGcOut.drivers.push({ name: _stoGcName, skipped: true, reason: 'this driver\'s strategy has no sweep (only `cas` collects garbage)' });
                        return _stoGcNext(_stoI + 1);
                    }
                    if ( _stoGcDry ) {
                        return _stoGcDrv.sweepNow({ dryRun: true }, function(_stoErr, _stoRes) {
                            _stoGcOut.drivers.push(_stoErr
                                ? { name: _stoGcName, error: _stoErr.message || String(_stoErr) }
                                : { name: _stoGcName, collectable: _stoRes.collectable, drained: _stoRes.drained });
                            _stoGcNext(_stoI + 1);
                        });
                    }
                    // full drain: loop the batch-capped pass until `drained`,
                    // hard-bounded at 1000 passes (100k blobs per request)
                    var _stoGcTotal  = 0;
                    var _stoGcPasses = 0;
                    var _stoGcLoop   = function() {
                        _stoGcDrv.sweepNow(function(_stoErr, _stoRes) {
                            if (_stoErr) {
                                _stoGcOut.drivers.push({ name: _stoGcName, error: _stoErr.message || String(_stoErr) });
                                return _stoGcNext(_stoI + 1);
                            }
                            _stoGcTotal += _stoRes.collected;
                            _stoGcPasses++;
                            if ( !_stoRes.drained && _stoGcPasses < 1000 ) {
                                return setImmediate(_stoGcLoop);
                            }
                            _stoGcOut.drivers.push({ name: _stoGcName, collected: _stoGcTotal, drained: _stoRes.drained, passes: _stoGcPasses });
                            _stoGcNext(_stoI + 1);
                        });
                    };
                    _stoGcLoop();
                };
                return _stoGcNext(0);
            }

            // GET /_gina/storage/verify?driver=<name> — REPORT-ONLY over HTTP,
            // deliberately: `fix` is not even parsed here (the CLI refuses
            // --fix while the bundle runs, and this handler is what makes that
            // refusal structural rather than advisory). A driver without
            // verify (sharded, v1) is named-and-skipped, never an error.
            if (
                request.method.toUpperCase() === 'GET'
                && /^\/_gina\/storage\/verify(\?.*)?$/i.test(request.url)
            ) {
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                response.setHeader('pragma',  'no-cache');
                response.setHeader('expires', '0');
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/storage/verify: client IP not in app.json admin.allowFrom' }));
                }
                var _stoVerNames  = lib.storage.list();
                var _stoVerDriver = null;
                var _stoVerQi     = request.url.indexOf('?');
                if ( _stoVerQi > -1 ) {
                    _stoVerDriver = new URLSearchParams(request.url.slice(_stoVerQi + 1)).get('driver') || null;
                }
                if ( _stoVerDriver ) {
                    if ( _stoVerNames.indexOf(_stoVerDriver) < 0 ) {
                        response.statusCode = 404;
                        return response.end(JSON.stringify({ error: 'not_found', message: '/_gina/storage/verify: no driver `' + _stoVerDriver + '` (configured: ' + (_stoVerNames.join(', ') || 'none') + ')' }));
                    }
                    _stoVerNames = [ _stoVerDriver ];
                }
                var _stoVerOut  = { configured: lib.storage.isStarted(), drivers: [] };
                var _stoVerNext = function(_stoI) {
                    if ( _stoI >= _stoVerNames.length ) {
                        return response.end(JSON.stringify(_stoVerOut));
                    }
                    var _stoVerName = _stoVerNames[_stoI];
                    var _stoVerDrv  = lib.storage.get(_stoVerName);
                    if ( typeof _stoVerDrv.verify !== 'function' ) {
                        _stoVerOut.drivers.push({ name: _stoVerName, skipped: true, reason: 'verify is cas-only in v1' });
                        return _stoVerNext(_stoI + 1);
                    }
                    _stoVerDrv.verify(function(_stoErr, _stoRep) {
                        _stoVerOut.drivers.push(_stoErr
                            ? { name: _stoVerName, error: _stoErr.message || String(_stoErr) }
                            : _stoRep);
                        _stoVerNext(_stoI + 1);
                    });
                };
                return _stoVerNext(0);
            }

            // ── /_gina/release/* — stale built-release watch (#RWATCH) ──────────
            // Present ONLY when the service armed at boot (local scope + non-dev +
            // server.releaseWatch.enabled) — when inactive the URLs fall through to
            // routing and 404 naturally (surface invisible). Same admin IP allowlist
            // as /_gina/info & /_gina/cache/* (app.json admin.allowFrom — loopback
            // by default). Engine-agnostic handlers; the Isaac fast-path mirrors
            // these — keep methods + shapes identical across engines.
            if (
                lib.releaseWatch.isActive()
                && request.method.toUpperCase() === 'GET'
                && /^\/_gina\/release\/status$/i.test(request.url)
            ) {
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.setHeader('content-type', 'application/json; charset=utf8');
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/release/status: client IP not in app.json admin.allowFrom' }));
                }
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                return response.end(JSON.stringify(lib.releaseWatch.getStatus()));
            }

            // POST only — a rebuild is a mutation. ?restart=auto|skip|force; `force`
            // against an ALREADY-WAITING idle gate opens the gate instead of
            // starting a new pipeline. 409 when a rebuild is already running.
            if (
                lib.releaseWatch.isActive()
                && request.method.toUpperCase() === 'POST'
                && /^\/_gina\/release\/rebuild(\?.*)?$/i.test(request.url)
            ) {
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.setHeader('content-type', 'application/json; charset=utf8');
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/release/rebuild: client IP not in app.json admin.allowFrom' }));
                }
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                var _rwRestartMatch = request.url.match(/[?&]restart=(auto|skip|force)\b/i);
                var _rwRestart      = _rwRestartMatch ? _rwRestartMatch[1].toLowerCase() : 'auto';
                var _rwStatusNow    = lib.releaseWatch.getStatus();
                if ( _rwRestart === 'force' && _rwStatusNow && _rwStatusNow.action && _rwStatusNow.action.state === 'waiting' ) {
                    return response.end(JSON.stringify({ accepted: true, forcedGate: lib.releaseWatch.forceRestartGate() }));
                }
                var _rwResult = lib.releaseWatch.requestRebuild({ restart: _rwRestart, requestedBy: 'operator' });
                if ( !_rwResult.accepted ) {
                    response.statusCode = 409;
                }
                return response.end(JSON.stringify(_rwResult));
            }

            // SSE — mirrors the /_gina/logs stream shape: registers a closer in
            // process.gina._sseConnections so the SIGTERM drain (lib/proc.js) and
            // the release-watch restart executor can end it before server.close().
            if (
                lib.releaseWatch.isActive()
                && request.method.toUpperCase() === 'GET'
                && /^\/_gina\/release\/events$/i.test(request.url)
            ) {
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.setHeader('content-type', 'application/json; charset=utf8');
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/release/events: client IP not in app.json admin.allowFrom' }));
                }
                response.setHeader('content-type', 'text/event-stream; charset=utf-8');
                response.setHeader('cache-control', 'no-cache, no-store');
                response.setHeader('connection', 'keep-alive');
                response.setHeader('x-content-type-options', 'nosniff');
                // Initial SSE comment to establish the connection
                response.write(':ok\n\n');

                var _rwSseSend = function(evt) {
                    try {
                        response.write('data: ' + JSON.stringify(evt) + '\n\n');
                    } catch (e) { /* connection may be closing */ }
                };
                // initial frame: the current status snapshot
                _rwSseSend({ type: 'status', data: lib.releaseWatch.getStatus(), at: Date.now() });
                var _rwUnsubscribe = lib.releaseWatch.subscribe(_rwSseSend);

                if (!process.gina._sseConnections) process.gina._sseConnections = new Set();
                var _rwSseClose = function() {
                    if (_rwUnsubscribe) { try { _rwUnsubscribe(); } catch (e) {} }
                    process.gina._sseConnections.delete(_rwSseClose);
                    try { response.end(); } catch (e) {}
                };
                process.gina._sseConnections.add(_rwSseClose);
                request.on('close', _rwSseClose);

                console.info(request.method + ' [200] ' + request.url + ' (SSE)');
                return; // keep the connection open — do not call response.end()
            }

            // ── /_gina/maintenance — maintenance-mode control (always-on, admin-gated) ──
            // (#MAINT1) GET returns status; POST {enable:bool[,ttlSeconds,retryAfter,
            // message]} flips it. Admin IP-allowlist gated like /_gina/info and the
            // cache/storage families — NOT key-gated like /_gina/instrument, because
            // this is an operational switch rather than a data-capture toggle, and it
            // must stay reachable from the host/pod and from the CLI (which dials the
            // bundle port directly, so it presents as loopback under any topology).
            //
            // Deliberately declared ABOVE the maintenance gate itself, so an operator
            // can always reach their own off switch while the window is open.
            //
            // The runtime override is NOT persisted: a restart returns the bundle to
            // its configured state. `ttlSeconds` is a dead-man switch — when it
            // expires the bundle reverts to CONFIG (not to "off"), so a forgotten
            // timer can never re-open a site settings.json says is closed. A PRESENT
            // `ttlSeconds` must be an integer in 1..86400 or the request is refused 400
            // (#B498) — it is never silently dropped or clamped.
            //
            // Keep in sync with the core/server.isaac.js twin.
            if (
                ( request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST' )
                && /\/_gina\/maintenance(?:\?|$)/.test(request.url)
            ) {
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                if ( !lib.admin.isClientAllowed(request) ) {
                    response.statusCode = 403;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/maintenance: client IP not in app.json admin.allowFrom' }));
                }

                var _mtCtl = self.instance._maintenance;
                if ( !_mtCtl ) {
                    response.statusCode = 503;
                    return response.end(JSON.stringify({ error: 'unavailable', message: '/_gina/maintenance: state not initialised' }));
                }

                // The status payload NEVER carries bypassKey — only whether one is
                // configured, which is what an operator actually needs to know
                // before closing a site they might then be unable to browse.
                var _mtStatus = function() {
                    var _now = Date.now();
                    var _eff = lib.maintenance.effectiveConf(_mtCtl, _now);
                    var _rt  = _mtCtl.runtime;
                    var _rtLive = !!( _rt && !( typeof(_rt.until) == 'number' && _rt.until <= _now ) );
                    return {
                        bundle       : self.appName,
                        active       : lib.maintenance.isActive(_mtCtl, _now),
                        source       : _rtLive ? 'runtime' : 'config',
                        retryAfter   : _eff.retryAfter,
                        message      : _eff.message,
                        until        : ( _rtLive && _rt && typeof(_rt.until) == 'number' ) ? new Date(_rt.until).toISOString() : null,
                        hasBypassKey : !!( _eff.bypassKey && _eff.bypassKey.length )
                    };
                };

                if ( request.method.toUpperCase() === 'GET' ) {
                    return response.end(JSON.stringify(_mtStatus()));
                }

                return _readInstrumentBody(request, function(_mbErr, _mbBody) {
                    if ( _mbErr ) {
                        response.statusCode = 400;
                        return response.end(JSON.stringify({ error: 'bad_request', message: '/_gina/maintenance: ' + _mbErr.message }));
                    }
                    if ( !_mbBody || ( _mbBody.enable !== true && _mbBody.enable !== false ) ) {
                        response.statusCode = 400;
                        return response.end(JSON.stringify({ error: 'bad_request', message: '/_gina/maintenance: body must be {"enable":true|false[,"ttlSeconds":N,"retryAfter":N,"message":"…"]}' }));
                    }

                    // #B498 — a PRESENT `ttlSeconds` must be an integer in 1..86400. Anything
                    // else used to be silently ignored, which armed an UNBOUNDED window when the
                    // caller had asked for a bounded one: fail-open on the dead-man switch, with
                    // `until: null` in the response as the only tell. Absent (or null) is still
                    // legal — it means "no timer" and is the documented default. Refused rather
                    // than clamped: a shorter-than-asked window reopens a site mid-deploy, so
                    // unlike the instrument window there is no safe direction to round toward.
                    if ( typeof(_mbBody.ttlSeconds) != 'undefined' && _mbBody.ttlSeconds !== null
                            && !( typeof(_mbBody.ttlSeconds) == 'number' && isFinite(_mbBody.ttlSeconds)
                                && Math.floor(_mbBody.ttlSeconds) === _mbBody.ttlSeconds
                                && _mbBody.ttlSeconds >= 1 && _mbBody.ttlSeconds <= 86400 ) ) {
                        response.statusCode = 400;
                        return response.end(JSON.stringify({ error: 'bad_request', message: '/_gina/maintenance: `ttlSeconds` must be an integer from 1 to 86400 (24h) — for a window that must outlive a day or a restart, set settings.json > server.maintenance.enabled: true' }));
                    }

                    var _rtNew = { active: _mbBody.enable === true, until: null };
                    if ( typeof(_mbBody.ttlSeconds) == 'number' && isFinite(_mbBody.ttlSeconds)
                            && Math.floor(_mbBody.ttlSeconds) === _mbBody.ttlSeconds
                            && _mbBody.ttlSeconds >= 1 && _mbBody.ttlSeconds <= 86400 ) {
                        _rtNew.until = Date.now() + (_mbBody.ttlSeconds * 1000);
                    }
                    if ( typeof(_mbBody.retryAfter) == 'number' ) {
                        _rtNew.retryAfter = _mbBody.retryAfter;
                    }
                    if ( typeof(_mbBody.message) == 'string' ) {
                        _rtNew.message = _mbBody.message;
                    }
                    _mtCtl.runtime = _rtNew;

                    console.warn('[maintenance] `' + self.appName + '` maintenance mode turned '
                        + ( _rtNew.active ? 'ON' : 'OFF' ) + ' via POST /_gina/maintenance'
                        + ( _rtNew.until ? (' until ' + new Date(_rtNew.until).toISOString()) : '' )
                        + ' — runtime override, NOT persisted across a restart.');

                    return response.end(JSON.stringify(_mtStatus()));
                });
            }

            // ── /_gina/instrument — toggleable instrumentation window (#INS10) ──
            // Opt-in (settings.json inspector.instrumentation.enabled) + key-auth
            // (required EVEN in dev — turning on raw query/flow capture outside dev
            // is more sensitive than the dev-open agent stream). GET returns the
            // window status; POST {enable:bool, ttlSeconds?:int} opens/closes it.
            // When the opt-in is off the block does not match → the request 404s
            // through normal routing (endpoint invisible unless explicitly enabled).
            if (
                process.gina && process.gina._inspectorInstrumentEnabled
                && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')
                && /\/_gina\/instrument(?:\?|$)/.test(request.url)
            ) {
                response.setHeader('content-type',  'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                response.setHeader('access-control-allow-origin', '*');
                if (!_instrumentKeyValid(request)) {
                    response.statusCode = 401;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/instrument: invalid or missing inspector key' }));
                }
                if (request.method.toUpperCase() === 'GET') {
                    return response.end(JSON.stringify(lib.instrument.status()));
                }
                // POST — mutate the window
                return _readInstrumentBody(request, function(_bErr, _body) {
                    if (_bErr) {
                        response.statusCode = 400;
                        return response.end(JSON.stringify({ error: 'bad_request', message: '/_gina/instrument: ' + _bErr.message }));
                    }
                    if (_body && _body.enable === false) {
                        var _stClose = lib.instrument.close();
                        console.warn('[inspector-instrument] window closed via /_gina/instrument');
                        return response.end(JSON.stringify(_stClose));
                    }
                    if (_body && _body.enable === true) {
                        var _stOpen = lib.instrument.open(_body.ttlSeconds);
                        console.warn('[inspector-instrument] window opened via /_gina/instrument for ' + Math.round(_stOpen.remainingMs / 1000) + 's');
                        return response.end(JSON.stringify(_stOpen));
                    }
                    response.statusCode = 400;
                    return response.end(JSON.stringify({ error: 'bad_request', message: '/_gina/instrument: body must be {"enable":true|false[,"ttlSeconds":N]}' }));
                });
            }

            // ── Inspector SPA — served at /_gina/inspector/ in dev mode ──────────
            if (
                process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true'
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/inspector(\/.*)?$/.test(request.url)
            ) {
                // Activate profiling on first Inspector access — one-way flag,
                // stays true until bundle restart. QI (controller.js:257) gates
                // on this; it must be true before any request is processed.
                if (!process.gina._inspectorActive) process.gina._inspectorActive = true;
                var _bmBase = __dirname + '/asset/plugin/dist/vendor/gina/inspector';
                var _bmPath = request.url.replace(/^.*\/_gina\/inspector\/?/, '').split('?')[0];
                if (!_bmPath || _bmPath === '') _bmPath = 'index.html';

                var _bmMime = {
                    'html':  'text/html; charset=utf8',
                    'js':    'application/javascript; charset=utf8',
                    'css':   'text/css; charset=utf8',
                    'svg':   'image/svg+xml',
                    'woff2': 'font/woff2',
                    'woff':  'font/woff'
                };
                var _bmExt = _bmPath.split('.').pop();
                var _bmFile = _(_bmBase + '/' + _bmPath, true);

                // #B179 — reject any path that canonicalises outside the Inspector
                // asset root, BEFORE any fs access. `_bmPath` is taken straight off
                // `request.url` with no `..` handling, and `_()` NORMALISES
                // traversal (helpers/path.js:87) rather than rejecting it — so a
                // request-target carrying a literal `..` otherwise resolves to any
                // absolute path the bundle process can read. Falls through to the
                // same 404 as a missing file — no distinct signal. Same guard as
                // the #B64 static resolvers above.
                if (confineToBase(_bmFile, _bmBase) !== null && fs.existsSync(_bmFile)) {
                    var _bmBinary = /^(woff2?|png|ico|gif|jpe?g)$/.test(_bmExt);
                    response.setHeader('content-type', _bmMime[_bmExt] || 'application/octet-stream');
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.setHeader('x-content-type-options', 'nosniff');
                    response.setHeader('access-control-allow-origin', '*');
                    console.info(request.method + ' [200] ' + request.url);
                    return response.end(fs.readFileSync(_bmFile, _bmBinary ? undefined : 'utf8'));
                }
                // Fall through to 404 if file not found
            }

            // ── Server-side log streaming — SSE at /_gina/logs in dev mode ──
            if (
                process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true'
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/logs$/.test(request.url)
            ) {
                if (!process.gina._inspectorActive) process.gina._inspectorActive = true;
                var _ansiRe = /\x1B\[\d+m/g;

                response.setHeader('content-type', 'text/event-stream; charset=utf-8');
                response.setHeader('cache-control', 'no-cache, no-store');
                response.setHeader('connection', 'keep-alive');
                response.setHeader('access-control-allow-origin', '*');
                response.setHeader('x-content-type-options', 'nosniff');
                // Initial SSE comment to establish the connection
                response.write(':ok\n\n');

                var _sseLogListener = function(payload) {
                    try {
                        var entry = JSON.parse(payload);
                        var level = entry.level === 'catch' ? 'log' : (entry.level || 'log');
                        var msg   = (entry.content || '').replace(_ansiRe, '').replace(/\n$/, '');
                        if (!msg) return;
                        var evt = JSON.stringify({
                            t: Date.now(),
                            l: level,
                            b: entry.group || '',
                            s: msg,
                            src: 'server'
                        });
                        response.write('data: ' + evt + '\n\n');
                    } catch (e) { /* connection may be closing */ }
                };

                if (!process.gina._sseConnections) process.gina._sseConnections = new Set();
                var _sseClose = function() {
                    process.removeListener('logger#default', _sseLogListener);
                    process.gina._sseConnections.delete(_sseClose);
                    try { response.end(); } catch (e) {}
                };

                process.on('logger#default', _sseLogListener);
                process.gina._sseConnections.add(_sseClose);
                request.on('close', _sseClose);

                console.info(request.method + ' [200] ' + request.url + ' (SSE)');
                return; // keep the connection open — do not call response.end()
            }

            // ── Inspector agent — combined SSE at /_gina/agent in dev mode ──
            // Streams both __ginaData updates and server-side log entries over
            // a single SSE connection. The standalone Inspector connects here
            // instead of using window.opener polling + separate /_gina/logs.
            if (
                (
                    (process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true')
                    || (process.gina && process.gina._inspectorAgentEnabled)
                )
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/agent(?:\?|$)/.test(request.url)
            ) {
                // #INS9b — outside dev mode the agent endpoint requires a valid
                // key (x-gina-inspector-key header or ?key= query param). In dev
                // it stays open with no key, preserving #INS9a.
                var _agIsDev = (process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true');
                if (!_agIsDev && !_agentKeyValid(request)) {
                    response.setHeader('content-type',  'application/json; charset=utf8');
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.statusCode = 401;
                    return response.end(JSON.stringify({ error: 'forbidden', message: '/_gina/agent: invalid or missing inspector key' }));
                }
                if (!process.gina._inspectorActive) process.gina._inspectorActive = true;
                var _agAnsiRe = /\x1B\[\d+m/g;

                response.setHeader('content-type', 'text/event-stream; charset=utf-8');
                response.setHeader('cache-control', 'no-cache, no-store');
                response.setHeader('connection', 'keep-alive');
                response.setHeader('access-control-allow-origin', '*');
                response.setHeader('x-content-type-options', 'nosniff');
                response.write(':ok\n\n');

                // Send current snapshot immediately if available; otherwise
                // send a lightweight "connected" frame so the Inspector shows
                // the bundle identity without waiting for the first request.
                // #INS10 — only replay the last snapshot in dev OR during an active window;
                // never leak a post-window snapshot to a late authenticated client.
                if ((_agIsDev || lib.instrument.isActive()) && self.instance && self.instance._lastGinaData) {
                    try {
                        response.write('event: data\ndata: ' + JSON.stringify(self.instance._lastGinaData) + '\n\n');
                    } catch (e) {}
                } else {
                    try {
                        var _initEnv = {
                            bundle : self.appName || '',
                            env    : self.env || ''
                        };
                        var _initPayload = { gina: { environment: _initEnv }, user: { environment: _initEnv } };
                        response.write('event: data\ndata: ' + JSON.stringify(_initPayload) + '\n\n');
                    } catch (e) {}
                }

                // Data updates — emitted by render-swig.js on every HTML render
                var _agDataListener = function(payload) {
                    try {
                        response.write('event: data\ndata: ' + JSON.stringify(payload) + '\n\n');
                    } catch (e) {}
                };

                // Log entries — same source as /_gina/logs
                var _agLogListener = function(payload) {
                    try {
                        var entry = JSON.parse(payload);
                        var level = entry.level === 'catch' ? 'log' : (entry.level || 'log');
                        var msg   = (entry.content || '').replace(_agAnsiRe, '').replace(/\n$/, '');
                        if (!msg) return;
                        var evt = JSON.stringify({
                            t: Date.now(),
                            l: level,
                            b: entry.group || '',
                            s: msg,
                            src: 'server'
                        });
                        response.write('event: log\ndata: ' + evt + '\n\n');
                    } catch (e) {}
                };

                // #AISTREAM — live AI token-stream frames (distinct event so the SPA
                // wires incremental appends without touching the data-snapshot path).
                var _agTokenListener = function(payload) {
                    try {
                        response.write('event: token\ndata: ' + JSON.stringify(payload) + '\n\n');
                    } catch (e) {}
                };

                // #EVTBUS — live application-event frames (distinct event so the SPA
                // wires incremental appends, like token).
                var _agEventListener = function(payload) {
                    try {
                        response.write('event: event\ndata: ' + JSON.stringify(payload) + '\n\n');
                    } catch (e) {}
                };

                if (!process.gina._sseConnections) process.gina._sseConnections = new Set();
                var _agClose = function() {
                    process.removeListener('inspector#data', _agDataListener);
                    process.removeListener('logger#default', _agLogListener);
                    process.removeListener('inspector#token', _agTokenListener);
                    process.removeListener('inspector#event', _agEventListener);
                    process.gina._sseConnections.delete(_agClose);
                    try { response.end(); } catch (e) {}
                };

                process.on('inspector#data', _agDataListener);
                process.on('logger#default', _agLogListener);
                process.on('inspector#token', _agTokenListener);
                process.on('inspector#event', _agEventListener);
                process.gina._sseConnections.add(_agClose);
                request.on('close', _agClose);

                console.info(request.method + ' [200] ' + request.url + ' (SSE agent)');
                return;
            }

            // ── Live index introspection — JSON at /_gina/indexes in dev mode ──
            // #QI2 — triggers inspector#indexes event; each SQL connector responds
            // with its live index data. Collector aggregates responses from all
            // active connectors and returns a single JSON payload.
            if (
                process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true'
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/indexes$/.test(request.url)
            ) {
                if (!process.gina._inspectorActive) process.gina._inspectorActive = true;

                var _ixListenerCount = process.listenerCount('inspector#indexes');
                if (_ixListenerCount === 0) {
                    response.setHeader('content-type', 'application/json; charset=utf8');
                    response.setHeader('cache-control', 'no-cache, no-store');
                    response.setHeader('access-control-allow-origin', '*');
                    console.info(request.method + ' [200] ' + request.url);
                    return response.end(JSON.stringify({ connectors: {} }));
                }

                var _ixResults   = {};
                var _ixRemaining = _ixListenerCount;
                var _ixResponded = false;

                var _ixRespond = function() {
                    if (_ixResponded) return;
                    _ixResponded = true;
                    clearTimeout(_ixTimeout);
                    var _ixBody = JSON.stringify({ connectors: _ixResults });
                    response.setHeader('content-type', 'application/json; charset=utf8');
                    response.setHeader('cache-control', 'no-cache, no-store');
                    response.setHeader('access-control-allow-origin', '*');
                    console.info(request.method + ' [200] ' + request.url);
                    response.end(_ixBody);
                };

                var _ixCollector = function(err, type, database, indexMap) {
                    if (_ixResponded) return;
                    if (!err && indexMap) {
                        var key = type + ':' + database;
                        _ixResults[key] = { type: type, database: database, tables: indexMap };
                    }
                    if (--_ixRemaining <= 0) _ixRespond();
                };

                var _ixTimeout = setTimeout(_ixRespond, 2000);
                process.emit('inspector#indexes', _ixCollector);
                return;
            }

            // ── Inspector reveal — JSON at /_gina/reveal in dev mode ──
            // #R7 reveal — returns the unredacted snapshot of the most recent
            // __ginaData payload, but ONLY when the bundle is running in the
            // `local` scope. Production / beta / testing bundles never expose
            // raw secrets through this endpoint, even in dev mode. The
            // unredacted snapshot itself is only stored when scope === 'local'
            // (see render-swig.js / render-json.js #R7 reveal block); other
            // scopes leave _lastGinaDataUnredacted as null.
            if (
                process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true'
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/reveal$/.test(request.url)
            ) {
                response.setHeader('content-type', 'application/json; charset=utf8');
                response.setHeader('cache-control', 'no-cache, no-store');
                response.setHeader('access-control-allow-origin', '*');

                if (process.env.NODE_SCOPE !== 'local') {
                    response.statusCode = 403;
                    console.info(request.method + ' [403] ' + request.url);
                    return response.end(JSON.stringify({ error: 'reveal forbidden in non-local scope' }));
                }

                if (!self.instance || !self.instance._lastGinaDataUnredacted) {
                    response.statusCode = 404;
                    console.info(request.method + ' [404] ' + request.url);
                    return response.end(JSON.stringify({ error: 'no snapshot available' }));
                }

                console.info(request.method + ' [200] ' + request.url);
                return response.end(JSON.stringify(self.instance._lastGinaDataUnredacted));
            }

            // ── #MAINT1 — maintenance gate (always-on, opt-in) ───────────────────
            // PLACEMENT IS THE FEATURE. It sits here deliberately:
            //
            //   AFTER every /_gina/* handler above — so liveness keeps answering
            //   200 (an orchestrator must NOT restart pods because the operator
            //   declared maintenance; correct k8s maintenance keeps pods READY and
            //   serves the 503 from the app), and so the admin endpoints, metrics
            //   and the maintenance toggle itself stay reachable while the window
            //   is open. Gating them would strand the operator outside their own
            //   off switch.
            //
            //   BEFORE the webroot filter, the static-asset branch below
            //   (`priority to statics`) and all routing — which is exactly what a
            //   middleware-based maintenance mode structurally CANNOT do, since
            //   route middleware runs only after a route matches (core/router.js
            //   processMiddlewares). Below this line, statics would keep serving
            //   200 and an unmatched URL would 404 instead of 503.
            //
            // It is also above BOTH render-cache serve points: isaac's pre-routing
            // L1 read, and the shared handle() L2 read — handle() runs downstream
            // of onRequest(), so this single placement covers it. A cache serve
            // point sitting above a gate is precisely #B158's shape.
            //
            // Cost when off: one property read + one boolean. The #P39-sensitive
            // render path pays nothing for an opt-in it is not using.
            //
            // ⚠️ #B383 — THIS GATE MUST STAY SYNCHRONOUS. Anything added here that
            // defers its decision (await, a callback, a promise, setImmediate)
            // becomes BYPASSABLE, and silently so. Under HTTP/2 node's compat
            // layer registers its own 'stream' listener when a 'request' listener
            // attaches; gina's byte-serving onHttp2Strem (registered lazily from
            // inside the first h2 static request, ~:3900) therefore lands SECOND
            // on the same emitter. EventEmitter dispatches synchronously in
            // registration order, so a synchronous gate completes its 503 while
            // the compat listener still holds the stack — before gina's listener
            // ever runs. An ASYNC gate returns control to the emitter first, and
            // the raw listener then serves the asset underneath it: MEASURED as a
            // 200 bypass in a 6-arm micro-replica whose synchronous arm held at
            // 503, with a positive control that served 200. The live h2 boot also
            // logs one harmless ERR_HTTP2_HEADERS_SENT here — gina's listener
            // losing the race it was always going to lose — which lib/proc
            // downgrades to a warn; the bundle stays up.
            //
            // The constraint is GENERAL: it binds any future pre-routing gate
            // placed in onRequest(), not just this one.
            //
            // Keep in sync with the core/server.isaac.js twin.
            var _mtState = self.instance && self.instance._maintenance;
            if ( _mtState && lib.maintenance.isActive(_mtState) ) {
                var _mtNow     = Date.now();
                var _mtConf    = lib.maintenance.effectiveConf(_mtState, _mtNow);
                var _mtVerdict = lib.maintenance.evaluateBypass(
                    request, _mtConf, _mtNow, process.gina._proxyRequireForwarded
                );

                if ( _mtVerdict.allowed ) {
                    if ( _mtVerdict.grant ) {
                        // The operator presented the key in the URL. Hand back a
                        // cookie so the rest of the session needs no secret, then
                        // redirect to the same URL WITHOUT it so the key leaves the
                        // address bar, the history and the Referer.
                        //
                        // The Location is the stripped PATH ONLY — never rebuilt
                        // from Host or any X-Forwarded-* header. #B367 established
                        // those are attacker-controlled; a redirect target built
                        // from them is an open redirect. A relative Location is
                        // resolved against the origin the client already reached,
                        // which is always the right one here.
                        console.warn('[maintenance] bypass granted to a client presenting a valid key (' + _mtVerdict.reason + ') — `' + self.appName + '`');
                        response.setHeader('set-cookie', lib.maintenance.buildBypassCookieHeader(
                            _mtVerdict.cookie, lib.maintenance.isSecureRequest(request)
                        ));
                        response.setHeader('cache-control', 'no-store');
                        response.setHeader('location', _mtVerdict.redirectTo || '/');
                        response.statusCode = 302;
                        return response.end();
                    }
                    // cookie / header / allowlisted-and-not-proxied: straight through.
                } else {
                    if ( _mtVerdict.reason === 'invalid-key' ) {
                        // Never log the presented value — the #B365 precedent for an
                        // asserting client. One line is enough to spot probing.
                        console.warn('[maintenance] a client presented an INVALID bypass key — `' + self.appName + '`');
                    }
                    return _serveMaintenance(request, response, _mtConf);
                }
            }

            // Fixing an express js bug :(
            // express is trying to force : /path/dir => /path/dir/
            // which causes : /path/dir/path/dir/  <---- by trying to add a slash in the end
            // if (
            //     webrootLen > 1
            //     && request.url === self.conf[self.appName][self.env].server.webroot + '/' + self.conf[self.appName][self.env].server.webroot + '/'
            // ) {
            //     request.url = self.conf[self.appName][self.env].server.webroot
            // }


            // webroot filter
            var isWebrootHandledByRouting = ( self.conf[self.appName][self.env].server.webroot == request.url && !fs.existsSync( _(self.conf[self.appName][self.env].publicPath +'/index.html', true) ) ) ? true : false;
            // webrootAutoredirect case
            if (
                request.url == '/'
                && typeof(self.conf[self.appName][self.env].server.webroot) != 'undefined'
                && /^true$/i.test(self.conf[self.appName][self.env].server.webrootAutoredirect)
            ) {
                var routing = self.conf[self.appName][self.env].content.routing;
                if (
                    typeof(routing['webroot@'+self.appName]) != 'undefined'
                    && self.conf[self.appName][self.env].server.webroot == routing['webroot@'+self.appName].webroot
                ) {
                    var urls = routing['webroot@'+self.appName].url.split(',');
                    if ( urls.indexOf('/') > -1 ) {
                        isWebrootHandledByRouting = true;
                    }
                    urls = null;
                }
                routing = null;
            }

            // priority to statics - this portion of code has been duplicated to SuperController : see `isStaticRoute` method
            var staticsArr  = self.conf[self.appName][self.env].publicResources;
            var staticProps = {
                isStaticFilename: false
            };

            if (!isWebrootHandledByRouting) {

                staticProps.firstLevel          = '/' + request.url.split(/\//g)[1] + '/';

                // to be considered as a stativ content, url must content at least 2 caracters after last `.`: .js, .html are ok
                var ext = request.url.match(/(\.([A-Za-z0-9]+){2}|\/)$/);
                var isImage = false;
                if ( typeof(ext) != 'undefined' &&  ext != null) {
                    ext = ext[0];
                    // if image with `@` found
                    if ( /^image/i.test(self.conf[self.appName][self.env].server.coreConfiguration.mime[ext.substring(1)]) ) {
                        isImage = true
                    }
                }
                if (
                    ext != null
                    // and must not be an email
                    && !/^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(request.url)
                    // and must be handled by mime.types
                    &&  typeof(self.conf[self.appName][self.env].server.coreConfiguration.mime[ext.substring(1)]) != 'undefined'
                    ||
                    ext != null
                    && isImage

                ) {
                    staticProps.isStaticFilename = true
                }

                ext = null;
                isImage = null;
            }



            // handle resources from public with webroot in url
            if ( staticProps.isStaticFilename && self.conf[self.appName][self.env].server.webroot != '/' && staticProps.firstLevel == self.conf[self.appName][self.env].server.webroot ) {
                var matchedFirstInUrl = request.url.replace(self.conf[self.appName][self.env].server.webroot, '').match(/[A-Za-z0-9_-]+\/?/);
                if ( matchedFirstInUrl && matchedFirstInUrl.length > 0 ) {
                    staticProps.firstLevel = self.conf[self.appName][self.env].server.webroot + matchedFirstInUrl[0]
                }
                matchedFirstInUrl = null;
            }

            if (
                staticProps.isStaticFilename && staticsArr.indexOf(request.url) > -1
                || staticProps.isStaticFilename && staticsArr.indexOf( request.url.replace(request.url.substring(request.url.lastIndexOf('/')+1), '') ) > -1
                || staticProps.isStaticFilename && new RegExp('^'+ staticProps.firstLevel).test(request.url)
                || /\/$/.test(request.url) && !isWebrootHandledByRouting && !/\/engine\.io\//.test(request.url)
            ) {
                self._isStatic  = true;

                self._referrer  = request.url;
                // by default - used in `composeHeadersMiddleware`: see Default Global Middlewares (gna.js)
                request.routing = {
                    'url'       : request.url,
                    'method'    : 'GET',
                    'bundle'    : self.appName
                };
                request = checkPreflightRequest(request, response);
                local.request = request; // update request
                // filtered to handle only html for now
                if ( /text\/html/.test(request.headers['accept'])
                    &&  /^isaac/.test(self.engine)
                    && self.instance._expressMiddlewares.length > 0
                    ||
                    request.isPreflightRequest
                    && /^isaac/.test(self.engine)
                    && self.instance._expressMiddlewares.length > 0
                ) {

                    // FRAMEWORK PATCH: Bug I — per-request dispatcher
                    var nextMiddleware = createNextMiddleware();
                    nextMiddleware._index        = 0;
                    nextMiddleware._count        = self.instance._expressMiddlewares.length-1;
                    nextMiddleware._request      = request;
                    nextMiddleware._response     = response;
                    nextMiddleware._next         = next;
                    nextMiddleware._nextAction   = 'handleStatics';
                    nextMiddleware._staticProps  = staticProps;


                    nextMiddleware()
                } else {
                    handleStatics(staticProps, request, response, next);
                }

            } else { // not a static request
                self._isStatic  = false;
                // init content
                request.body    = ( typeof(request.body) != 'undefined' ) ? request.body : {};
                request.get     = {};
                request.post    = {};
                request.put     = {};
                request.delete  = {};
                request.patch   = {};
                request.head    = {};
                request.files   = [];
                //request.cookies = {}; // ???
                //request.copy ???



                // multipart wrapper for uploads
                // files are available from your controller or any middlewares:
                //  @param {object} req.files
                // #B103 — flag computed once at the request prologue (where it also
                // gates request.setEncoding: a multipart body must stay RAW for busboy).
                // was: if ( /multipart\/form-data;/.test(request.headers['content-type']) ) {
                if ( request.isMultipart ) {
                    // TODO - get options from settings.json & settings.{env}.json ...
                    // -> https://github.com/mscdex/busboy
                    var opt = self.conf[self.appName][self.env].content.settings.upload;
                    // checking size
                    // #B51 (2026-06-16) — parse the maxFieldsSize unit suffix into bytes.
                    // was: var maxSize  = parseInt(opt.maxFieldsSize);
                    //      var fileSize = request.headers["content-length"]/1024/1024; //MB
                    // parseInt("512K") => 512, compared against content-length/1024/1024 (MB), so
                    // "512K" silently meant 512 MB. parseSize reads B/KB/MB/GB (case-insensitive)
                    // into bytes; a BARE number is treated as MB for back-compat (the shipped "2MB"
                    // => 2*1024*1024, unchanged). content-length is then compared in bytes directly.
                    var parseSize = function(value) {
                        if ( typeof(value) == 'number' ) { return value * 1024 * 1024; } // bare number = MB
                        if ( typeof(value) != 'string' ) { return NaN; }
                        var m = value.trim().match(/^([0-9]*\.?[0-9]+)\s*(b|kb|k|mb|m|gb|g)?$/i);
                        if ( !m ) { return NaN; }
                        var n = parseFloat(m[1]);
                        switch ( (m[2] || 'mb').toLowerCase() ) {
                            case 'b':
                                return n;
                            case 'k':
                            case 'kb':
                                return n * 1024;
                            case 'g':
                            case 'gb':
                                return n * 1024 * 1024 * 1024;
                            case 'm':
                            case 'mb':
                            default:
                                return n * 1024 * 1024;
                        }
                    };
                    var maxSize     = parseSize(opt.maxFieldsSize);                     // bytes
                    // #B489 — publish the resolved cap so a relay (Controller::forward())
                    // can bound the multipart body it re-encodes from req.files. NaN or 0
                    // means the cap is disabled; the relay falls back to its own default.
                    request.uploadMaxSize = maxSize;
                    var fileSize    = parseInt(request.headers["content-length"], 10);  // bytes
                    var hasAutoTmpCleanupTimeout = (
                        typeof(opt.autoTmpCleanupTimeout) != 'undefined'
                        &&  opt.autoTmpCleanupTimeout != ''
                        &&  opt.autoTmpCleanupTimeout != 0
                        &&  !/false/i.test(opt.autoTmpCleanupTimeout)
                    ) ? true : false;
                    var autoTmpCleanupTimeout = (!hasAutoTmpCleanupTimeout) ? null : parseTimeout(opt.autoTmpCleanupTimeout);

                    // #B51 — guard on maxSize so an unset / 0 / invalid maxFieldsSize disables the
                    // cap (was: `fileSize > maxSize` with maxSize=NaN naturally skipped; maxSize=0
                    // would have rejected everything — 0 now means "no limit", as for maxFields).
                    if (maxSize && fileSize > maxSize) {
                        return throwError(response, 431, 'Attachment exceeded maximum file size [ '+ opt.maxFieldsSize +' ]');
                    }

                    // #B49 (2026-06-16) — honour the configured upload directory.
                    // was: var uploadDir = opt.uploadDir || os.tmpdir();
                    // The old line read only `opt.uploadDir`, a key the shipped settings.json
                    // never sets (it defines `upload.tmpPath`, and nothing maps tmpPath→uploadDir),
                    // so every upload fell back to os.tmpdir() and the documented `upload.tmpPath`
                    // / per-group `path` keys were dead. `tmpPath` resolves to an absolute dir at
                    // config-load (via whisper → <project>/tmp, created at boot), so prefer it;
                    // `uploadDir` is kept first for back-compat (any operator who set it). A
                    // per-group `path` overrides this global default at the write site below.
                    var uploadDir = opt.uploadDir || opt.tmpPath || os.tmpdir();

                    /**
                     * str2ab
                     * One common practical question about ArrayBuffer is how to convert a String to an ArrayBuffer and vice-versa.
                     * Since an ArrayBuffer is, in fact, a byte array, this conversion requires that both ends agree on how
                     * to represent the characters in the String as bytes.
                     * You probably have seen this "agreement" before: it is the
                     * String's character encoding (and the usual "agreement terms" are, for example, Unicode UTF-16 and iso8859-1).
                     * Thus, supposing you and the other party have agreed on the UTF-16 encoding
                     *
                     * ref.:
                     *  - https://developers.google.com/web/updates/2012/06/How-to-convert-ArrayBuffer-to-and-from-String
                     *
                     * TODO - Test with audio content
                     *
                     * @param {string} str
                     *
                     * @returns {array} buffer
                     * */
                    var str2ab = function(str, bits) {

                        var bytesLength = str.length
                            //, bits         = 8 // default bytesLength
                            , bits      = ( typeof (bits) != 'undefined' ) ? (bits/8) : 1
                            , buffer    = new ArrayBuffer(bytesLength * bits) // `bits`  bytes for each char
                            , bufView   = null;

                        switch (bytesLength) {
                            case 8:
                                bufView = new Uint8Array(buffer);
                                break;

                            case 16:
                                bufView = new Uint16Array(buffer);
                                break;

                            case 32:
                                bufView = new Uint32Array(buffer);
                                break;

                            default:
                                bufView = new Uint8Array(buffer);
                                break;
                        }
                        //var buf = new ArrayBuffer(str.length * 2); // 2 bytes for each char when using Uint16Array(buf)
                        //var buf = new ArrayBuffer(str.length); // Uint8Array
                        //var bufView = new Uint8Array(buf);
                        for (let i = 0, strLen = str.length; i < strLen; i++) {
                            bufView[i] = str.charCodeAt(i);
                        }

                        return buffer;
                    };

                    /**
                     * str2ab
                     *
                     * With TypedArray now available, the Buffer class implements the Uint8Array API
                     * in a manner that is more optimized and suitable for Node.js.
                     * ref.:
                     *  - https://nodejs.org/api/buffer.html#buffer_buffer_from_buffer_alloc_and_buffer_allocunsafe
                     *
                     * @param {string} str
                     *
                     * @returns {array} buffer
                     */
                    // var str2ab = function(str, encoding) {

                    //     const buffer = Buffer.allocUnsafe(str.length);

                    //     for (let i = 0, len = str.len; i < len; i++) {
                    //         buffer[i] = str.charCodeAt(i);
                    //     }

                    //     return buffer;
                    // }


                    var fileObj         = null
                        , fileCount     = 0
                        , tmpFilename   = null
                        , writeStreams  = []
                        , index         = 0
                        // #B143 — write streams created but not yet closed. Incremented at
                        // stream creation in the 'file' handler, decremented by each
                        // stream's close callback (armed at creation, see below).
                        , pending       = 0
                        // #B143 — set once busboy has parsed the whole body. Resume fires
                        // only when busboyDone && pending === 0, whichever event lands last.
                        , busboyDone    = false;

                    request.files = [];
                    request.routing = {
                        'url': request.url,
                        'method': 'POST',
                        'bundle' : self.appName
                    };
                    // #B92-adjacent (2026-07-12) — multipart TEXT-field caps. The 'field'
                    // listener below makes busboy buffer non-file parts in memory, so both
                    // busboy limits are wired: `fields` (count — the excess emits
                    // 'fieldsLimit' once and is then silently skipped, answered 400 below)
                    // and `fieldSize` (bytes per field — busboy truncates at the cap and
                    // flags `valueTruncated`, answered 400 below). Absent / invalid settings
                    // fall back to safe defaults; an explicit 0 means "no limit", as for
                    // maxFields above.
                    var maxTextFields = ( typeof(opt.maxTextFields) != 'undefined' && opt.maxTextFields !== '' )
                        ? parseInt(opt.maxTextFields, 10)
                        : 1000;
                    if ( isNaN(maxTextFields) ) {
                        maxTextFields = 1000;
                    } else if ( maxTextFields <= 0 ) {
                        maxTextFields = Infinity;
                    }
                    var maxTextFieldSize = parseSize(opt.maxTextFieldSize); // bytes; bare number = MB
                    if ( isNaN(maxTextFieldSize) ) {
                        maxTextFieldSize = 1024 * 1024; // 1MB — busboy's own fieldSize default
                    } else if ( maxTextFieldSize <= 0 ) {
                        maxTextFieldSize = Infinity;
                    }
                    // defParamCharset:'utf8' — decode the Content-Disposition `filename=`
                    // param as UTF-8 rather than busboy's latin1 default; otherwise a UTF-8
                    // filename ("Accusé de réception.pdf") is mojibaked ("AccusÃ© de rÃ©ception.pdf").
                    // The RFC 5987 `filename*` form is self-describing and unaffected; the
                    // field `name` param is ASCII, so this only corrects the plain filename path.
                    var busboy = Busboy({
                        headers: request.headers,
                        defParamCharset: 'utf8',
                        limits: { fields: maxTextFields, fieldSize: maxTextFieldSize }
                    });

                    // #B92-adjacent (2026-07-12) — capture multipart TEXT fields into the
                    // request body. The framework historically attached NO 'field' listener,
                    // and the vendored busboy SKIPS every non-file part when no listener is
                    // registered — so text fields sent alongside files (or alone, #B93)
                    // silently vanished: request.post / request.body stayed {}. Captured
                    // fields follow the application/json body contract (#B28/#B92): values
                    // VERBATIM (a multipart part body is not url-encoded — no decode, no
                    // "true"/"false"/"on"/"null" coercion) and bracket-notation names are
                    // nested through the data helper's own nesting layer
                    // (nestBracketNotationKey, the parseLocalObj alias), so `item[0][id]`
                    // arrives as `item: [ { id } ]` exactly as from a JSON body. Duplicate
                    // plain names: last one wins.
                    var multipartFields = null;
                    busboy.on('field', function onMultipartField(name, value, info) {
                        // A truncated value hit the fieldSize cap — busboy truncates
                        // silently, which would hand the app corrupted data; reject instead.
                        if ( info && info.valueTruncated ) {
                            if ( !response.headersSent && !request.handled ) {
                                request.handled = true;
                                throwError(response, 400, 'multipart text field `'+ name +'` exceeds the allowed size. See the `upload.maxTextFieldSize` definition in settings.json.', next);
                            }
                            return;
                        }
                        if ( multipartFields == null ) {
                            multipartFields = {};
                        }
                        if ( /^(.*)\[(.*)\]/.test(name) ) {
                            multipartFields = nestBracketNotationKey(multipartFields, name.replace(/\]/g, '').split(/\[/g), 0, value);
                        } else {
                            multipartFields[name] = value;
                        }
                    });
                    // Text fields past the `fields` limit are silently skipped by busboy
                    // after a single 'fieldsLimit' emit; skipping means silent data loss,
                    // so answer 400 (the maxFields file-count cap's shape).
                    busboy.on('fieldsLimit', function onFieldsLimit() {
                        if ( !response.headersSent && !request.handled ) {
                            request.handled = true;
                            throwError(response, 400, 'too many multipart text fields (max '+ maxTextFields +'). See the `upload.maxTextFields` definition in settings.json.', next);
                        }
                    });

                    // @rhinostone/busboy emits upstream's object-style `info`
                    // ({ filename, encoding, mimeType }) plus the fork's additive
                    // `info.dispositionParams` — the part's parsed Content-Disposition
                    // params. The former vendored copy instead threaded `group` as a 6th
                    // POSITIONAL arg via a local patch to lib/types/multipart.js, which had
                    // to be re-applied on every upstream upgrade; reading it off `info` here
                    // is what retires that patch. A part carrying no `group` param yields
                    // undefined, which the #B50 gate below resolves to `untagged`.
                    // was: busboy.on('file', function(fieldname, file, filename, encoding, mimetype, group) {
                    busboy.on('file', function(fieldname, file, info) {

                        // Keep these as locals — do NOT inline `info.filename` /
                        // `info.dispositionParams.group` at the use sites below. The #B49
                        // and #B50 source pins in upload-config.test.js and
                        // upload-groups.test.js assert on the identifiers `filename` and
                        // `group` inside this body; neither file mentions busboy, so
                        // inlining would break two suites for a non-obvious reason.
                        var filename = info.filename;
                        var encoding = info.encoding;
                        var mimetype = info.mimeType;
                        var group    = ( info.dispositionParams ) ? info.dispositionParams.group : undefined;

                        file._dataLen = 0;
                        // #B142 — this part's request.files record, captured at the
                        // source's 'end' and size-finalized in liner._flush (below the
                        // pipe): at 'end' time the liner can still hold queued chunks
                        // the byte counter has not seen.
                        var fileRecord;
                        ++fileCount;

                        // #B51 (2026-06-16) — enforce the global maxFields file-count cap. It was
                        // declared in settings.json (default 1000) but read NOWHERE — the only count
                        // limit was the binary per-group isMultipleAllowed, so an isMultipleAllowed:true
                        // group (the shipped untagged default) accepted UNBOUNDED files. parseInt reads
                        // the number or a string; an unset / 0 / NaN value disables the cap. Global only
                        // (per-group maxFields is not wired, like per-group maxFieldsSize).
                        var maxFields = parseInt(opt.maxFields, 10);
                        if ( maxFields && fileCount > maxFields ) {
                            throwError(response, 400, 'too many upload fields (max '+ maxFields +'). See the `upload.maxFields` definition in settings.json.');
                            return false;
                        }

                        // #B50 (2026-06-16) — every uploaded file must map to a CONFIGURED upload group.
                        // The old gate (commented below) ran the ext + count checks ONLY for a group that was
                        // defined, NOT `untagged`, AND present in opt.groups; every other case — no group,
                        // `untagged`, or an unknown group name — streamed through UNCHECKED, so a client could
                        // bypass a group's allow-list simply by tagging a file with any unconfigured group.
                        // Now: a file with no group falls back to the default `untagged`; a group not declared
                        // in settings.json `upload.groups` is rejected (400); and `untagged` is no longer
                        // hardcode-exempt — it obeys its own allowedExtensions / isMultipleAllowed like any
                        // other group (the shipped default is `*` + isMultipleAllowed:true, so single- and
                        // multi-file untagged uploads are unaffected).
                        //
                        // if (
                        //     typeof(group) != 'undefined'
                        //     && group != 'untagged'
                        //     && typeof(opt.groups[group]) != 'undefined'
                        // ) {
                        //     // allowed extensions
                        //     if ( typeof(opt.groups[group].allowedExtensions) != 'undefined'
                        //         && opt.groups[group].allowedExtensions != '*'
                        //     ) {
                        //         var ext     = opt.groups[group].allowedExtensions;
                        //         var fileExt = filename.substring(filename.lastIndexOf('.')+1)
                        //         if ( !Array.isArray(ext) ) { ext = [ext] }
                        //         if ( ext.indexOf(fileExt) < 0 ) {
                        //             throwError(response, 400, '`'+ fileExt +'` is not an allowed extension. See `'+ group +'` upload group definition.');
                        //             return false;
                        //         }
                        //     }
                        //     // multiple or single
                        //     if ( typeof(opt.groups[group].isMultipleAllowed) != 'undefined'
                        //         && !opt.groups[group].isMultipleAllowed
                        //         && fileCount > 1
                        //     ) {
                        //         throwError(response, 400, 'multiple uploads not allowed. See `'+ group +'` upload group definition.');
                        //         return false;
                        //     }
                        // }
                        var fileGroup = ( typeof(group) != 'undefined' && group ) ? group : 'untagged';

                        // deny an unconfigured upload group (was: silently streamed through)
                        if ( typeof(opt.groups) == 'undefined' || typeof(opt.groups[fileGroup]) == 'undefined' ) {
                            throwError(response, 400, '`'+ fileGroup +'` is not a configured upload group. See the `upload.groups` definition in settings.json.');
                            return false;
                        }

                        // allowed extensions
                        if ( typeof(opt.groups[fileGroup].allowedExtensions) != 'undefined'
                            && opt.groups[fileGroup].allowedExtensions != '*'
                        ) {
                            var ext     = opt.groups[fileGroup].allowedExtensions;
                            var fileExt = filename.substring(filename.lastIndexOf('.')+1)
                            if ( !Array.isArray(ext) ) {
                                ext = [ext]
                            }

                            if ( ext.indexOf(fileExt) < 0 ) {
                                throwError(response, 400, '`'+ fileExt +'` is not an allowed extension. See `'+ fileGroup +'` upload group definition.');
                                return false;
                            }
                        }

                        // multiple or single
                        if ( typeof(opt.groups[fileGroup].isMultipleAllowed) != 'undefined'
                            && !opt.groups[fileGroup].isMultipleAllowed
                            && fileCount > 1
                        ) {
                            throwError(response, 400, 'multiple uploads not allowed. See `'+ fileGroup +'` upload group definition.');
                            return false;
                        }


                        // TODO - https://github.com/TooTallNate/node-wav
                        //file._mimetype = mimetype;

                        // #B49 (2026-06-16) — per-group `path` overrides the global uploadDir;
                        // fall back to the global dir when the group declares no path. The
                        // configured defaults resolve to dirs that exist (os.tmpdir() always;
                        // <project>/tmp is created at boot), but a CUSTOM dir may not exist yet.
                        // mkdir-if-missing prevents the write error entirely; since #B143 the
                        // writeStream 'error' handler is also armed at stream creation (below),
                        // so a missing dir would now get a guarded 500 instead of the historical
                        // unhandled-ENOENT crash (the handler used to attach only in the busboy
                        // 'finish' loop, after the whole body was parsed).
                        var fileUploadDir = ( opt.groups[fileGroup] && opt.groups[fileGroup].path )
                            ? opt.groups[fileGroup].path
                            : uploadDir;
                        // #B419 (2026-08-25) — the staging destination is server-generated and
                        // OPAQUE: never the client-supplied basename. Both the write site below
                        // and the record's `path` used `<fileUploadDir>/<info.filename>` verbatim
                        // with no per-part component — so two parts sharing a name (within ONE
                        // request, or across concurrent requests) opened two write streams on ONE
                        // path with independent file offsets and INTERLEAVED their bytes into a
                        // single hybrid matching neither source, reported to the app as a success
                        // (`storeErr:false` / 200). Measured pre-fix on a live boot: one request
                        // with two same-named parts -> one 500000-byte file of {B:417353,A:82647};
                        // 12 concurrent same-named requests -> 0/12 clean. The parse precedes
                        // routing and all middleware (the #B30/#B97/#B145 family), so an
                        // UNAUTHENTICATED POST to ANY url reaches this path — an unrouted one
                        // answers 404 to the client and still writes the file.
                        //
                        // A random name, NOT `filename + <suffix>`: this is what multer ("a random
                        // name that doesn't include any file extension") and formidable
                        // (`newFilename` hexoid, client name kept as `originalFilename`) both do.
                        // Appending would keep attacker-controlled bytes on disk (RTL-override
                        // display spoofing, control chars, reserved device names) and could push a
                        // long-but-legal filename past NAME_MAX (255) into an ENAMETOOLONG 500,
                        // turning a working upload into a failure. A CSPRNG, NOT the `Math.random()`
                        // movefiles uses (`controller.js:3198`): V8's is xorshift128+, so staging
                        // paths would be predictable, and a group `path` is operator-configurable
                        // into a served root. No extension, so a misconfigured static-serve of that
                        // directory cannot hand back an interpretable type.
                        //
                        // The client's name is NOT lost — it stays on the record as
                        // `originalFilename` below, which is what `self.store()` publishes under
                        // (`controller.js:4061`) and what a storage driver receives as
                        // `originalName`. The documented "keeping each file's original name"
                        // contract is unchanged; only `req.files[].path`'s basename differs, and
                        // that is documented as "the absolute path of the temporary file on disk".
                        var stagedName = crypto.randomBytes(16).toString('hex') + '.part';
                        // #B145 (2026-07-22) — guard the dir creation. mkdirSync throws
                        // SYNCHRONOUSLY inside this busboy 'file' callback when the configured
                        // group `path` is non-creatable (parent read-only / EROFS / EACCES).
                        // Unguarded, that propagates up the parser call stack →
                        // uncaughtException → proc.js SIGTERM: an UNAUTHENTICATED single-request
                        // bundle-kill (the #B30/#B97 family — the multipart parse precedes
                        // routing + middleware). #B49's "mkdir-if-missing prevents the write
                        // error" only covered the missing-dir STREAM error (handled by the
                        // writeStream 'error' listener below), not mkdirSync itself failing. A
                        // non-creatable destination is a SERVER config problem, not client input
                        // → answer a guarded 500 (not the 400 used for client-side violations).
                        try {
                            if ( !fs.existsSync(fileUploadDir) ) {
                                fs.mkdirSync(fileUploadDir, { recursive: true });
                            }
                        } catch (mkdirErr) {
                            console.error('[ busboy ] [ onUploadDirError ]', mkdirErr);
                            throwError(response, 500, 'upload destination for group `'+ fileGroup +'` is not creatable ('+ fileUploadDir +')\n' + mkdirErr, next);
                            return false;
                        }

                        // creating file
                        writeStreams[index] = fs.createWriteStream( _(fileUploadDir + '/' + stagedName) );
                        // #B143 (2026-07-21) — arm the write stream's terminal listeners AT
                        // CREATION, not in a busboy 'finish' loop. The historical late attach
                        // lost a race: an early small part's write stream emits 'finish' in
                        // ~ms while a later large part is still streaming, and Node never
                        // replays 'finish' for a late listener — that stream's decrement
                        // never ran, the count never reached 0, and the request hung forever
                        // (no log line; only a client/front-proxy timeout severed it).
                        // Attaching here closes the race for every ordering, and gives a
                        // write error DURING streaming (ENOENT/EIO/disk-full) a handler —
                        // previously an unhandled 'error' → uncaughtException → SIGTERM.
                        // An errored stream never emits 'finish', so it never decrements:
                        // the request stays terminal at the 500 (the pre-#B143 semantics).
                        ++pending;
                        writeStreams[index].on('error', function(err) {
                            console.error('[ busboy ] [ onWriteError ]', err);
                            throwError(response, 500, 'Internal server error\n' + err, next);
                            this.close();
                            return;
                        });
                        writeStreams[index].on('finish', function() {
                            this.close( function onUploaded(){
                                --pending;
                                console.debug('closing writestreams : ' + pending);

                                // #B143 — exactly-once by arithmetic: busboy emits no
                                // 'file' after 'finish', so once busboyDone is set the
                                // counter can only drain; the LAST close callback resumes.
                                if (busboyDone && pending === 0) {
                                    resumeAfterMultipart();
                                }
                            })
                        });

                        // #B144 (2026-07-22) — consumer-probeable write-error path. A group
                        // with `simulateWriteError: true` (honoured OUTSIDE production scope
                        // only) creates the REAL write stream + arms the REAL #B143 terminal
                        // listeners above, then synthetically destroys the stream so the
                        // production 'error' listener fires the production throwError(500) with
                        // the EXACT terminal semantics of a real mid-stream ENOSPC/EIO: an
                        // errored stream never emits 'finish' → never decrements `pending` → the
                        // request stays terminal at the 500 (a second errored part's throwError
                        // is a no-op behind throwError's !res.headersSent guard). Lets a consumer
                        // re-confirm the #B143 crash-guard on their own upload surface after a
                        // pickup WITHOUT any filesystem / global-config change that touches real
                        // uploads — the failure scopes to requests tagging this one group. INERT
                        // in production (self.isProductionScope()); a flag shipped there by
                        // accident is surfaced by the boot warn (init) but never fires. Faithful
                        // to the real error path: the source part is NOT drained (matching a real
                        // mid-stream error), and createWriteStream may leave a 0-byte tmp file —
                        // point the probe group's `path` at a tmp dir.
                        if ( opt.groups[fileGroup].simulateWriteError && !self.isProductionScope() ) {
                            writeStreams[index].destroy(new Error('simulated write error — upload group `'+ fileGroup +'` has `simulateWriteError` enabled (test-only fault injector)'));
                            ++index;
                            return false;
                        }

                        var liner = require('stream').Transform({objectMode: true});

                        liner._transform = function (chunk, encoding, done) {
                            // #B103 (2026-07-20) — pass the Buffer through VERBATIM. The historical
                            // toString()/str2ab round-trip utf8-decoded every chunk (invalid sequences
                            // → U+FFFD) and then truncated each UTF-16 code unit mod 256, so any byte
                            // sequence that is not valid UTF-8 was mangled — binary uploads corrupted,
                            // while pure-ASCII payloads survived byte-identical, which is what hid it.
                            // Counting chunk.length (bytes, not post-decode UTF-16 chars) also makes
                            // req.files[].size the real on-disk size.
                            // was:
                            // var str = chunk.toString();
                            // file._dataLen += str.length;
                            //
                            // var ab = Buffer.from(str2ab(str));
                            // this.push(ab)
                            file._dataLen += chunk.length;
                            this.push(chunk);

                            done()
                        }

                        file.pipe(liner).pipe(writeStreams[index]);
                        ++index;

                        // #B142 (2026-07-21) — finalize req.files[].size once the LAST
                        // _transform has counted its chunk. Ordering guarantees (probe-
                        // measured): _flush completes strictly BEFORE the write stream can
                        // emit 'finish', and the request only resumes (resumeAfterMultipart)
                        // after every write stream finished — so the patched size is final
                        // before any consumer (incl. the controller's store()) reads
                        // request.files. On a settled pipeline _flush can run BEFORE the
                        // source's 'end' listener; fileRecord is then still undefined here,
                        // and the push at 'end' reads the already-complete count — both
                        // interleavings yield the exact byte size. Assigned AFTER the pipe
                        // on purpose: the Transform only consults _flush at end-of-input,
                        // and the sibling suite slices the _transform block up to the pipe
                        // call. (Supersedes the long-commented _flush stub that sat above
                        // the pipe since the original implementation.)
                        liner._flush = function (done) {
                            if ( fileRecord ) {
                                fileRecord.size = file._dataLen;
                            }
                            done()
                        };


                        file.on('end', function() {

                            //fileObj = Buffer.from(str2ab(this._dataChunk));
                            //delete this._dataChunk;

                            // #B49 — mirror the per-group / configured dir chosen at the write site
                            // above (file.on('end') closes over the same per-file fileUploadDir).
                            // #B419 — and the same per-part `stagedName`: this expression and the
                            // createWriteStream above are built INDEPENDENTLY, so uniquifying only
                            // one leaves this record pointing at a file that was never written.
                            tmpFilename = _(fileUploadDir + '/' + stagedName);

                            // #B142 (2026-07-21) — size here is PROVISIONAL: 'end' fires on
                            // the SOURCE stream while the liner Transform downstream can
                            // still hold queued chunks the byte counter has not seen
                            // (measured live: a 1.5MB upload reported ~25% short).
                            // liner._flush finalizes it. The push itself stays HERE: busboy
                            // emits parts sequentially, so pushing at the source's 'end'
                            // preserves part order in request.files — flush completion
                            // order can invert across parts when an earlier part's sink
                            // drains slower.
                            fileRecord = {
                                name: fieldname,
                                // #B140 — the RESOLVED group (`untagged` when the part
                                // carried no group tag), never the raw disposition
                                // param: this record is what `self.store()` routes on
                                group: fileGroup,
                                originalFilename: filename,
                                encoding: encoding,
                                type: mimetype,
                                size: this._dataLen,
                                path: tmpFilename
                            };
                            request.files.push(fileRecord);

                            // /tmp autoTmpCleanupTimeout
                            if (autoTmpCleanupTimeout) {
                                setTimeout((tmpFilename) => {
                                    console.debug('[ BUNDLE ][ '+self.appName+' ][ server ][ upload ] Now removing `'+ tmpFilename +'` from tmp');
                                    var tmpFilename = new _(tmpFilename);
                                    if (tmpFilename.existsSync())
                                        tmpFilename.rmSync();
                                }, autoTmpCleanupTimeout, tmpFilename);
                            }
                        });
                    });

                    // #B93 — resume the request lifecycle once the multipart body is fully
                    // parsed. Shared by the has-files path (after every write stream closes)
                    // and the fields-only path below, which produces no write streams and
                    // otherwise never reached this continuation.
                    var resumeAfterMultipart = function resumeAfterMultipart() {
                        loadBundleConfiguration(request, response, next, function onBundleConfigurationLoaded(err, bundle, pathname, config, req, res, next) {
                            if (!req.handled) {
                                req.handled = true;
                                if (err) {
                                    if (!res.headersSent)
                                        throwError(response, 500, 'Internal server error\n' + err.stack, next);
                                        return;
                                } else {
                                    handle(req, res, next, bundle, pathname, config)
                                }
                            }
                        })
                    };

                    // #B97 — a malformed / empty / non-multipart body sent with a
                    // multipart/form-data content-type makes busboy emit 'error' (never
                    // 'finish'). With no listener this surfaced as an uncaughtException,
                    // which proc.js answers with SIGTERM — so a single unauthenticated
                    // request could kill the bundle (and the client got no response at all).
                    // Answer 400 instead; guard against a double-response in case a file
                    // write stream already failed and responded.
                    busboy.on('error', function onBusboyError(err) {
                        console.error('[ busboy ] [ onParseError ]', (err && err.message) ? err.message : err);
                        if (!response.headersSent && !request.handled) {
                            request.handled = true;
                            throwError(response, 400, 'Malformed multipart/form-data request', next);
                        }
                    });

                    busboy.on('finish', function() {
                        // #B92-adjacent — expose the captured text fields on the request
                        // BEFORE either dispatch path below runs, mirroring
                        // processRequestData's `request.body = request.post = obj` parity
                        // shape (the multipart branch never runs processRequestData). Only
                        // the body-carrying methods get the method slot — request.get /
                        // request.delete also feed URL params in the routing loop and are
                        // left alone; the fields stay readable on request.body regardless.
                        if ( multipartFields != null ) {
                            request.body = multipartFields;
                            var _fieldsMethod = ( request.method || '' ).toLowerCase();
                            if ( /^(post|put|patch)$/.test(_fieldsMethod) ) {
                                request[_fieldsMethod] = multipartFields;
                            }
                        }
                        // #B143 — the whole body is parsed; from here the per-stream close
                        // callbacks (armed at stream creation in the 'file' handler, where
                        // the historical attach loop that lost the early-finisher race used
                        // to live) are allowed to resume the request.
                        busboyDone = true;

                        // #B93 + #B143 — zero streams still pending covers BOTH terminals:
                        // a fields-only body created no write stream at all (#B93 — this
                        // branch is what un-hung it), and a multi-file body whose every
                        // write stream already finished and closed while later parts were
                        // still being parsed (#B143). Resume directly; otherwise the LAST
                        // close callback resumes (busboyDone && pending === 0). (Text
                        // fields, dropped when #B93 shipped, are captured since
                        // #B92-adjacent — see the 'field' handler and the assignment above.)
                        if (pending === 0) {
                            resumeAfterMultipart();
                        }
                    });

                    request.pipe(busboy);
                } else {


                    // #OW2 — bound the non-multipart body accumulation (OWASP A10).
                    // The accumulator below is the ONLY unbounded growth on the request
                    // path: multipart is capped by busboy + maxFieldsSize, but a plain
                    // JSON/urlencoded body grew until the process died. Counting the RAW
                    // chunk bytes (not the decoded string length) is what a cap has to
                    // measure — a multi-byte UTF-8 body is larger on the wire than its
                    // string length suggests.
                    //
                    // Two thresholds, deliberately:
                    //  - `server.maxBodySize` ENFORCES (413 + destroy). Defaults to a
                    //    permissive 64MB: the ceiling exists to stop unbounded growth,
                    //    not to police payload shapes, and the framework's OWN
                    //    inter-bundle `self.query()` hop posts through this same pipeline
                    //    with no size contract — a tight enforced default would break
                    //    gina with gina, in a shape that reads as a consumer bug.
                    //  - `server.maxBodySizeWarn` only WARNS (default 2MB), so every
                    //    consumer measures their real distribution from their own logs
                    //    before a stricter ceiling is ever considered. Precedent: the
                    //    #B238 warn-not-flip disclosure gate.
                    // `0` / unset / unparseable disables either threshold (the
                    // maxFieldsSize convention — an invalid cap must not reject
                    // everything).
                    var _bodySrv      = ( self.conf[self.appName][self.env].server || {} );
                    var _maxBody      = parseByteSize(_bodySrv.maxBodySize);
                    var _maxBodyWarn  = parseByteSize(_bodySrv.maxBodySizeWarn);
                    var _bodyBytes    = 0;
                    var _bodyWarned   = false;
                    var _bodyRejected = false;

                    request.on('data', function(chunk){ // for this to work, don't forget the name attr for you form elements
                        if ( _bodyRejected ) { return }

                        _bodyBytes += chunk.length;

                        if ( _maxBodyWarn > 0 && !_bodyWarned && _bodyBytes > _maxBodyWarn ) {
                            _bodyWarned = true;
                            // No URL, no body content — #B433 keeps log lines free of
                            // request data; the method + byte count is the actionable part.
                            console.warn('[ SERVER ] Request body exceeded server.maxBodySizeWarn ('
                                + _bodySrv.maxBodySizeWarn + ') — '+ request.method +' body is over '
                                + _maxBodyWarn +' bytes and still accumulating. Not rejected.');
                        }

                        if ( _maxBody > 0 && _bodyBytes > _maxBody ) {
                            _bodyRejected = true;
                            request.body  = '';
                            throwError(response, 413, 'Request body exceeded maximum size [ '+ _bodySrv.maxBodySize +' ]', next);
                            // Stop the peer streaming into a request nobody will read.
                            try { request.destroy() } catch (destroyErr) {}
                            return
                        }

                        if ( typeof(request.body) == 'object') {
                            request.body = '';
                        }
                        request.body += chunk.toString()
                    });

                    request.on('end', function onEnd() {
                        // #OW2 — a rejected body already answered 413 and destroyed the
                        // stream; dispatching here would double-respond (and parse a body
                        // we deliberately discarded). `destroy()` normally prevents 'end'
                        // from firing at all, but that is a race against already-buffered
                        // chunks, not a guarantee — the flag is the guarantee.
                        if ( _bodyRejected ) { return }

                        // Preserve the exact unparsed body BEFORE processRequestData mutates
                        // request.body into the parsed object. Inbound webhooks that
                        // authenticate via an HMAC computed over the raw request bytes need
                        // the untouched body; by the time middlewares run, the stream is
                        // drained and request.body is the parsed object. request.body is the
                        // fully-accumulated string here ('' when the body was empty). This
                        // is a reference assignment, not a copy. The multipart branch above
                        // uses Busboy and never reaches here, so uploads are unaffected.
                        request.rawBody = (typeof request.body === 'string') ? request.body : '';
                        processRequestData(request, response, next);
                    });

                    if (request.end) request.end();


                } //EO if multipart
            }


        });//EO this.instance


        // Timeout in milliseconds - e.g.: (1000x60)x2 => 2 min
        // #OW2 — configurable via `settings.json > server.timeout`; DEFAULT 0
        // (unlimited) is deliberate and must stay the default: gina serves SSE
        // (`text/event-stream`) and WebSockets, and a finite whole-request clock
        // kills both. The slow-body case a finite value would cover is already
        // closed by `server.maxBodySize` (the accumulator hits its ceiling
        // regardless of drip rate); connection-level bounds come from
        // keepAliveTimeout / headersTimeout and node's own defaults.
        // An unparseable value falls back to 0 rather than to something arbitrary.
        var _srvTimeoutCfg = self.conf[self.appName][self.env].server.timeout;
        var _srvTimeout    = ( typeof(_srvTimeoutCfg) == 'undefined' ) ? 0 : parseTimeout(_srvTimeoutCfg);
        self.instance.timeout = ( typeof(_srvTimeout) == 'number' && _srvTimeout >= 0 ) ? _srvTimeout : 0;
        // Port by default would be 3100
        // '::' as the binding address (ipv4 & ipv6)
        // To check: netstat -tuln
        // If you get "connection refused", make sure that `/proc/sys/net/ipv6/bindv6only` is set to 0
        // TODO - compare core/config.js and core/template/conf/settings.json
        // self.instance.listen(self.conf[self.appName][self.env].server.port, self.conf[self.appName][self.env].server.address, self.conf[self.appName][self.env].server.backlog);
        // Capture the raw server returned by listen() so proc.js can call
        // server.close() on SIGTERM for graceful shutdown. For the isaac engine,
        // self.instance IS the raw server and listen() returns it unchanged. For
        // the express engine, app.listen() creates the underlying http/http2 server
        // internally and returns it — without capturing here it is unreachable.
        var _rawServer = self.instance.listen(self.conf[self.appName][self.env].server.port);
        process.server = (_rawServer && typeof _rawServer.close === 'function') ? _rawServer : self.instance;

        // #INS8 — attach the authenticated WebSocket transport for /_gina/agent
        // to the raw server. Covers both the isaac and express engines (server.js
        // owns the single listen() call), so no engine-specific mirror is needed.
        attachInspectorAgentWs(process.server, self);

        self.emit('started', self.conf[self.appName][self.env], true);
    }

    /**
     * Parses and normalises the request body for POST/PUT/PATCH/DELETE methods.
     * Handles `application/json`, `application/x-www-form-urlencoded`, and
     * `multipart/form-data` (via Busboy). Calls `next` when done.
     *
     * @inner
     * @private
     * @param {object} request - Incoming request object
     * @param {object} response - Server response object
     * @param {function} next - Next middleware callback
     */
    var processRequestData = function(request, response, next) {



        var bodyStr = null, obj = null, exception = null;

        /**
         * Serializes `request.query` for the GET/HEAD re-parse below,
         * unwrapping nested-JSON STRING values by PARSING them (#B407).
         *
         * A query value may legitimately arrive as serialized JSON — a
         * `?filter={"a":1}` reaches the engine query parser as the STRING
         * value `'{"a":1}'` — and the pipeline below expects it to land as
         * a real object. The previous implementation unwrapped TEXTUALLY on
         * the serialized document: two wrapper replaces for the quotes
         * around a `{`-leading value, then a blanket backslash strip to
         * clean the escapes INSIDE the unwrapped object. That strip ran
         * over the WHOLE document, destroying the escapes JSON.stringify
         * had just written for ORDINARY values: a newline (`%0A`) became
         * the letter `n`, a tab the letter `t`, a backslash vanished — and
         * a double quote in a value (or a JSON-ARRAY value, which the
         * wrapper replaces never handled) produced invalid JSON, which
         * `parseBody` reports (`[365] could not parse body`) before
         * returning undefined, so EVERY query param on the request was
         * silently dropped. Parsing each candidate value keeps the unwrap
         * intent — validated now, and correct for nested content carrying
         * escapes, which the textual unwrap also corrupted — while every
         * escape in an ordinary value survives serialization intact.
         *
         * Only own enumerable STRING values leaning `{`/`[` are candidates;
         * one that does not parse stays a verbatim string (previously that
         * shape, once the strip mangled it, also dropped the whole query).
         * The `"true"`/`"false"`/`"on"`/`"null"` text coercion at the call
         * sites is unchanged — with escapes intact it can only match
         * whole-string values, never an escaped occurrence inside one.
         *
         * @inner
         * @private
         * @param {object} query - The engine-parsed `request.query`
         * @returns {string} Serialized query, nested-JSON string values unwrapped
         */
        var serializeQueryForReparse = function (query) {
            for (var qKey in query) {
                if ( !Object.prototype.hasOwnProperty.call(query, qKey) ) continue;
                if ( typeof(query[qKey]) == 'string' && /^\s*[\{\[]/.test(query[qKey]) ) {
                    try {
                        query[qKey] = JSON.parse(query[qKey]);
                    } catch (qParseErr) {
                        // not JSON after all — keep the raw string value
                    }
                }
            }
            return JSON.stringify(query);
        };

        // to compare with /core/controller/controller.js -> getParams()
        switch( request.method.toLowerCase() ) {
            case 'post':
                var configuring = false, msg = null, isPostSet = false;
                if ( typeof(request.body) == 'string' ) {
                    // get rid of encoding issues
                    try {
                        // #B103 — same header test as the request-prologue flag; read the flag
                        // so the multipart content-type regex exists at exactly one site.
                        // was: if ( !/multipart\/form-data;/.test(request.headers['content-type']) ) {
                        if ( !request.isMultipart ) {
                            if ( /application\/json/i.test(request.headers['content-type']) ) {
                                // #B28 — application/json: parse the body verbatim. JSON already
                                // carries real types, so do NOT url-decode (a %XX inside a string
                                // value would be corrupted) and do NOT apply form-style
                                // "true"/"false"/"on"/"null" coercion or bracket-key expansion —
                                // those are urlencoded-form conventions, not JSON.
                                try {
                                    obj = JSON.parse(request.body);
                                    request.post = obj;
                                    isPostSet = true;
                                } catch (err) {
                                    // Tolerate a percent-encoded JSON body (e.g. an
                                    // encodeURIComponent / RFC5987-encoded payload). A genuine
                                    // raw-JSON body parses on the verbatim attempt above, so a
                                    // legitimate %XX inside a string value is never double-decoded
                                    // (preserves #B28 intent) — only a non-raw-JSON body reaches here.
                                    try {
                                        obj = JSON.parse(decodeURIComponent(request.body));
                                        request.post = obj;
                                        isPostSet = true;
                                    } catch (err2) {
                                        exception = new Error('Could not parse application/json POST body. '+ err.message);
                                        throwError(response, 500, exception, next);
                                        return;
                                    }
                                }
                            } else if ( request.isXmlBody ) {
                                // #FIN1 — hand an XML body to the application untouched: no
                                // decode, no "true"/"false"/"on"/"null" coercion, no bracket-key
                                // expansion. `request.body` stays the verbatim document (the same
                                // string `request.rawBody` snapshots above), and the method slot is
                                // left unset — the routing loop normalises it to {} further down,
                                // so a controller still reads an object from `request.post`.
                                //
                                // What the legacy branch below did to XML: the data helper it
                                // calls splits on `&`, then on `=`, and keeps only the first pair — so
                                // `<?xml version="1.0" encoding="UTF-8"?>` alone collapsed the
                                // WHOLE document to { '<?xml version': '"1.0" encoding' }, and that
                                // object (having a key) then REPLACED request.body at the tail.
                                // No error was ever raised; the document was silently truncated.
                                //
                                // `obj` must be set to an object rather than left null: the shared
                                // tail below reads `typeof(obj) == 'object' && obj.count()`, and
                                // `typeof null === 'object'`, so a null would throw inside that
                                // guard and be answered as a 500. An empty object no-ops it.
                                obj = {};
                            } else {
                                if ( /application\/x\-www\-form\-urlencoded/.test(request.headers['content-type']) && /\+/.test(request.body) ) {
                                    request.body = request.body.replace(/\+/g, ' ');
                                }

                                if ( request.body.substring(0,1) == '?')
                                    request.body = request.body.substring(1);

                                try {
                                    bodyStr = decodeURIComponent(request.body); // it is already a string for sure
                                } catch (err) {
                                    bodyStr = request.body;
                                }

                                // false & true case
                                if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                                    bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);
                                if ( /(\"null\")/i.test(bodyStr) )
                                    bodyStr = bodyStr.replace(/\"null\"/ig, null);

                                try {
                                    // obj = parseBody(bodyStr);
                                    obj = formatDataFromString(bodyStr);
                                    if ( !obj) {
                                        exception = new Error('Could not convert POST::BODY_STRING to POST::OBJECT. Possible JSON error in `bodyStr`');
                                        throwError(response, 500, exception, next);
                                        return;
                                    }
                                    request.post = obj;
                                    isPostSet = true;
                                } catch (err) {
                                    // ignore this one
                                    msg = '[ Could properly evaluate POST ] '+ request.url +'\n'+  err.stack;
                                    console.warn(msg);
                                }
                                if (!isPostSet) {
                                    try {
                                        if (obj.count() == 0 && bodyStr.length > 1) {
                                            request.post = obj;
                                        } else {
                                            request.post = JSON.parse(bodyStr)
                                        }

                                    } catch (err) {
                                        msg = '[ Exception found for POST ] '+ request.url +'\n'+  err.stack;
                                        console.warn(msg);
                                    }
                                }
                            }
                        }

                    } catch (err) {
                        msg = '[ Could properly evaluate POST ] '+ request.url +'\n'+  err.stack;
                        console.warn(msg);
                    }

                } else {
                    // 2016-05-19: fix to handle requests from swagger/express
                    if (request.body.count() == 0 && typeof(request.query) != 'string' && request.query.count() > 0 ) {
                        request.body = request.query
                    }
                    // 2023-01-31: fixed `request.body` might not be an `object`
                    bodyStr = ( typeof(request.body) == 'object') ? JSON.stringify(request.body) : request.body;
                    // false & true case
                    if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);

                    obj = JSON.parse(bodyStr)
                }

                try {
                    if ( typeof(obj) == 'object' && obj.count() > 0 ) {
                        // still need this to allow compatibility with express & connect middlewares
                        request.body = request.post = obj;
                    }
                } catch (err) {
                    msg = '[ Could complete POST ] '+ request.url +'\n'+ err.stack;
                    console.error(msg);
                    throwError(response, 500, err, next);
                    return;
                }


                // see.: https://www.w3.org/Protocols/rfc2616/rfc2616-sec9.html#POST
                //     Responses to this method are not cacheable,
                //     unless the response includes appropriate cache-control or expires header fields.
                //     However, the 303 (See Other) response can be used to direct the user agent to retrieve a cacheable resource.
                if ( !response.headersSent ) {
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.setHeader('pragma', 'no-cache');
                    response.setHeader('expires', '0');
                }


                // cleaning
                request.query   = undefined;
                request.get     = undefined;
                request.put     = undefined;
                request.delete  = undefined;
                break;

            case 'get':
                // if ( typeof(request.query) == 'string' && /^(\{|\[\{)/.test(request.query) ) {
                //     bodyStr = request.query.replace(/\"{/g, '{').replace(/}\"/g, '}').replace(/\\/g, '');
                //     request.query = JSON.parse(bodyStr);
                // }
                if ( typeof(request.query) != 'undefined' && request.query.count() > 0 ) {
                    var inheritedDataObj = {};
                    if ( typeof(request.query.inheritedData) != 'undefined' ) {


                        if ( typeof(request.query.inheritedData) == 'string' ) {
                            // #B30: request.query.inheritedData is ALREADY percent-decoded once by
                            // the engine query parser (server.isaac.js / express qs), and
                            // formatDataFromString performs its OWN guarded internal decode. The
                            // explicit decodeURIComponent here was a redundant SECOND decode whose
                            // only effects were (a) a URIError crash on a literal '%' surviving the
                            // first decode — e.g. inheritedData carrying {"x":"50%off"} → "%of" is a
                            // malformed escape → the bundle dies (URIError → proc.js uncaughtException → SIGTERM) — and
                            // (b) extra silent double-decode corruption. Dropped: formatDataFromString
                            // supplies the single guarded decode.
                            // was: inheritedDataObj = formatDataFromString(decodeURIComponent(request.query.inheritedData));
                            inheritedDataObj = formatDataFromString(request.query.inheritedData);
                        } else {
                            inheritedDataObj = JSON.clone(request.query.inheritedData);
                        }

                        delete request.query.inheritedData;

                    }

                    // #B407 — was: bodyStr = JSON.stringify(request.query).replace(/\"{/g, '{').replace(/}\"/g, '}').replace(/\\/g, '');
                    // (see serializeQueryForReparse above: the textual unwrap's blanket backslash
                    // strip corrupted every escape-bearing value and dropped the whole query on a
                    // double quote or a JSON-array value)
                    bodyStr = serializeQueryForReparse(request.query);
                    // false & true case
                    if ( /(\"false\"|\"true\"|\"on\")/i.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"false\"/ig, false).replace(/\"true\"/ig, true).replace(/\"on\"/ig, true);
                    if ( /(\"null\")/i.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"null\"/ig, null);


                    // #B30: redundant second decode dropped (see the GET inheritedData note
                    // above) — request.query values are already engine-decoded and
                    // formatDataFromString self-guards its own decode.
                    // was: obj = formatDataFromString(decodeURIComponent(bodyStr));
                    obj = formatDataFromString(bodyStr);

                    request.query = merge(obj, inheritedDataObj);
                    // delete obj;
                    obj = null;
                    inheritedDataObj = null;

                    request.get = request.query;
                }
                // else, will be matching route params against url context instead, once route is identified


                // cleaning
                request.query   = undefined;
                request.post    = undefined;
                request.put     = undefined;
                request.delete  = undefined;
                break;

            case 'put':
                // eg.: PUT /user/set/1
                if ( typeof(request.body) == 'string' ) {
                    // get rid of encoding issues
                    try {
                        // #B103 — same header test as the request-prologue flag; read the flag
                        // so the multipart content-type regex exists at exactly one site.
                        // was: if ( !/multipart\/form-data;/.test(request.headers['content-type']) ) {
                        if ( !request.isMultipart ) {
                            if ( /application\/json/i.test(request.headers['content-type']) ) {
                                // #B28 — application/json: parse the body verbatim. JSON already
                                // carries real types, so do NOT url-decode (a %XX inside a string
                                // value would be corrupted) and do NOT apply form-style
                                // "true"/"false"/"on"/"null" coercion or bracket-key expansion —
                                // those are urlencoded-form conventions, not JSON.
                                try {
                                    obj = JSON.parse(request.body);
                                } catch (err) {
                                    // Tolerate a percent-encoded JSON body (see the POST branch).
                                    // The verbatim attempt above wins for genuine raw JSON, so
                                    // #B28 intent holds and only an encoded body reaches here.
                                    try {
                                        obj = JSON.parse(decodeURIComponent(request.body));
                                    } catch (err2) {
                                        console.warn('[ Could not parse application/json PUT body ] '+ request.url +'\n'+ err.stack);
                                    }
                                }
                            } else if ( request.isXmlBody ) {
                                // #FIN1 — verbatim XML body; see the POST branch for the full
                                // rationale. PUT's tail is already null-guarded (`if ( obj && … )`)
                                // unlike POST/PATCH, so the empty object is for uniformity across
                                // the three sites rather than to dodge a throw.
                                obj = {};
                            } else {
                                if ( /application\/x\-www\-form\-urlencoded/.test(request.headers['content-type']) ) {
                                    request.body = request.body.replace(/\+/g, ' ');
                                }

                                if ( request.body.substring(0,1) == '?')
                                    request.body = request.body.substring(1);

                                // false & true case
                                try {
                                    bodyStr = decodeURIComponent(request.body); // it is already a string for sure
                                } catch (err) {
                                    bodyStr = request.body;
                                }

                                // false & true case
                                if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                                    bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);
                                if ( /(\"null\")/i.test(bodyStr) )
                                    bodyStr = bodyStr.replace(/\"null\"/ig, null);

                                obj = formatDataFromString(bodyStr);


                                if ( typeof(obj) != 'undefined' && obj.count() == 0 && bodyStr.length > 1 ) {
                                    try {
                                        request.put = merge(request.put, obj);
                                    } catch (err) {
                                        console.log('Case `put` #0 [ merge error ]: ' + (err.stack||err.message))
                                    }
                                }
                            }
                        }

                    } catch (err) {
                        var msg = '[ '+request.url+' ]\nCould not evaluate PUT.\n'+ err.stack;
                        throwError(response, 500, msg, next);
                        return;
                    }

                } else {
                    // 2016-05-19: fix to handle requests from swagger/express
                    if (request.body.count() == 0 && typeof(request.query) != 'string' && request.query.count() > 0 ) {
                        request.body = request.query
                    }
                    bodyStr = JSON.stringify(request.body);
                    // false & true case
                    if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);
                    if ( /(\"null\")/i.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"null\"/ig, null);

                    obj = JSON.parse(bodyStr)
                }

                if ( obj && typeof(obj) != 'undefined' && obj.count() > 0 ) {
                    
// still need this to allow compatibility with express & connect middlewares
                    request.body = request.put = merge(request.put, obj);

                }


                request.query   = undefined; // added on september 13 2016
                request.post    = undefined;
                request.delete  = undefined;
                request.get     = undefined;

                obj = null;
                break;


            case 'delete':
                if ( request.query.count() > 0 ) {
                    request.delete = request.query;

                }
                // else, matching route params against url context instead once, route is identified

                request.post    = undefined;
                request.put     = undefined;
                request.get     = undefined;
                break

            case 'patch':
                // PATCH: partial update — only the fields sent are changed on the server.
                // Body parsing is identical to POST; the result lands on req.patch (not req.post)
                // so controllers can assert the method semantics explicitly when needed.
                var isPatchSet = false, msg = null;
                if ( typeof(request.body) == 'string' ) {
                    try {
                        // #B103 — same header test as the request-prologue flag; read the flag
                        // so the multipart content-type regex exists at exactly one site.
                        // was: if ( !/multipart\/form-data;/.test(request.headers['content-type']) ) {
                        if ( !request.isMultipart ) {
                            if ( /application\/json/i.test(request.headers['content-type']) ) {
                                // #B28 — application/json: parse the body verbatim. JSON already
                                // carries real types, so do NOT url-decode (a %XX inside a string
                                // value would be corrupted) and do NOT apply form-style
                                // "true"/"false"/"on"/"null" coercion or bracket-key expansion —
                                // those are urlencoded-form conventions, not JSON.
                                try {
                                    obj = JSON.parse(request.body);
                                    request.patch = obj;
                                    isPatchSet = true;
                                } catch (err) {
                                    // Tolerate a percent-encoded JSON body (see the POST branch).
                                    // The verbatim attempt above wins for genuine raw JSON, so
                                    // #B28 intent holds and only an encoded body reaches here.
                                    try {
                                        obj = JSON.parse(decodeURIComponent(request.body));
                                        request.patch = obj;
                                        isPatchSet = true;
                                    } catch (err2) {
                                        exception = new Error('Could not parse application/json PATCH body. '+ err.message);
                                        throwError(response, 500, exception, next);
                                        return;
                                    }
                                }
                            } else if ( request.isXmlBody ) {
                                // #FIN1 — verbatim XML body; see the POST branch for the full
                                // rationale. PATCH shares POST's tail shape, so the empty object
                                // is load-bearing here too: a null would throw inside
                                // `typeof(obj) == 'object' && obj.count()` and answer 500.
                                obj = {};
                            } else {
                                if ( /application\/x\-www\-form\-urlencoded/.test(request.headers['content-type']) && /\+/.test(request.body) ) {
                                    request.body = request.body.replace(/\+/g, ' ');
                                }
                                if ( request.body.substring(0,1) == '?' )
                                    request.body = request.body.substring(1);
                                try {
                                    bodyStr = decodeURIComponent(request.body);
                                } catch (err) {
                                    bodyStr = request.body;
                                }
                                if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                                    bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);
                                if ( /(\"null\")/i.test(bodyStr) )
                                    bodyStr = bodyStr.replace(/\"null\"/ig, null);
                                try {
                                    obj = formatDataFromString(bodyStr);
                                    if ( !obj ) {
                                        exception = new Error('Could not convert PATCH::BODY_STRING to PATCH::OBJECT. Possible JSON error in `bodyStr`');
                                        throwError(response, 500, exception, next);
                                        return;
                                    }
                                    request.patch = obj;
                                    isPatchSet = true;
                                } catch (err) {
                                    msg = '[ Could not properly evaluate PATCH ] '+ request.url +'\n'+ err.stack;
                                    console.warn(msg);
                                }
                                if (!isPatchSet) {
                                    try {
                                        request.patch = ( obj.count() == 0 && bodyStr.length > 1 ) ? obj : JSON.parse(bodyStr);
                                    } catch (err) {
                                        msg = '[ Exception found for PATCH ] '+ request.url +'\n'+ err.stack;
                                        console.warn(msg);
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        msg = '[ Could not properly evaluate PATCH ] '+ request.url +'\n'+ err.stack;
                        console.warn(msg);
                    }
                } else {
                    if ( request.body.count() == 0 && typeof(request.query) != 'string' && request.query.count() > 0 ) {
                        request.body = request.query;
                    }
                    bodyStr = ( typeof(request.body) == 'object') ? JSON.stringify(request.body) : request.body;
                    if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);
                    if ( /(\"null\")/i.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"null\"/ig, null);
                    obj = JSON.parse(bodyStr);
                }
                try {
                    if ( typeof(obj) == 'object' && obj.count() > 0 ) {
                        request.body = request.patch = obj;
                    }
                } catch (err) {
                    msg = '[ Could not complete PATCH ] '+ request.url +'\n'+ err.stack;
                    console.error(msg);
                    throwError(response, 500, err, next);
                    return;
                }
                if ( !response.headersSent ) {
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.setHeader('pragma', 'no-cache');
                    response.setHeader('expires', '0');
                }
                request.query   = undefined;
                request.get     = undefined;
                request.post    = undefined;
                request.put     = undefined;
                request.delete  = undefined;
                request.head    = undefined;
                break;

            case 'head':
                // HEAD: same query-string processing as GET; the response body is suppressed
                // in the render layer. Use HEAD to check whether a resource exists and read
                // its headers (content-type, content-length, cache headers) without downloading
                // the full body. Routes declared as GET automatically accept HEAD requests.
                if ( typeof(request.query) != 'undefined' && request.query.count() > 0 ) {
                    var headInheritedDataObj = {};
                    if ( typeof(request.query.inheritedData) != 'undefined' ) {
                        if ( typeof(request.query.inheritedData) == 'string' ) {
                            // #B30: redundant second decode dropped (see the GET inheritedData note).
                            // was: headInheritedDataObj = formatDataFromString(decodeURIComponent(request.query.inheritedData));
                            headInheritedDataObj = formatDataFromString(request.query.inheritedData);
                        } else {
                            headInheritedDataObj = JSON.clone(request.query.inheritedData);
                        }
                        delete request.query.inheritedData;
                    }
                    // #B407 — was: bodyStr = JSON.stringify(request.query).replace(/\"{/g, '{').replace(/}\"/g, '}').replace(/\\/g, '');
                    // (see serializeQueryForReparse above: the textual unwrap's blanket backslash
                    // strip corrupted every escape-bearing value and dropped the whole query on a
                    // double quote or a JSON-array value)
                    bodyStr = serializeQueryForReparse(request.query);
                    if ( /(\"false\"|\"true\"|\"on\")/i.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"false\"/ig, false).replace(/\"true\"/ig, true).replace(/\"on\"/ig, true);
                    if ( /(\"null\")/i.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"null\"/ig, null);
                    // #B30: redundant second decode dropped (see the GET inheritedData note).
                    // was: obj = formatDataFromString(decodeURIComponent(bodyStr));
                    obj = formatDataFromString(bodyStr);
                    request.query = merge(obj, headInheritedDataObj);
                    obj = null;
                    headInheritedDataObj = null;
                    request.head = request.query;
                }
                request.query   = undefined;
                request.get     = undefined;
                request.post    = undefined;
                request.put     = undefined;
                request.delete  = undefined;
                request.patch   = undefined;
                break;


        };

        loadBundleConfiguration(request, response, next, function onLoadBundleConfiguration (err, bundle, pathname, config, req, res, next) {
            if (!req.handled) {
                req.handled = true;
                if (err) {
                    throwError(response, 500, 'Internal server error\n' + err.stack, next);
                    return;
                } else {
                    handle(req, res, next, bundle, pathname, config)
                }
            } else {
                if (typeof(next) != 'undefined')
                    return next();
                else
                    return;
            }

            return;
        })
    }

    /**
     * Looks up the MIME type for a filename by its extension using the
     * bundle's core MIME configuration. Falls back to `'plain/text'` when
     * the extension is unknown.
     *
     * @inner
     * @private
     * @param {string} filename - File path or name with extension
     * @returns {string} MIME type string
     */
    var getContentTypeByFilename = function(filename) {
        try {
            var s       = filename.split(/\./);
            var ext     = s[s.length-1];
            var type    = null;
            var mime    = self.conf[self.appName][self.env].server.coreConfiguration.mime;

            if ( typeof(mime[ext]) != 'undefined' ) {
                type = mime[ext];
            } else {
                console.warn('[ '+filename+' ] extension: `'+s[2]+'` not supported by gina: `core/mime.types`. Pathname must be a directory. Replacing with `plain/text` ')
            }
            return type || 'plain/text';
        } catch (err) {
            console.error('Error while trying to getContentTypeByFilename('+ filename +') extention. Replacing with `plain/text` '+ err.stack);
            return 'plain/text'
        }

    }

    /**
     * Retrieves the current Config singleton and resolves which bundle owns
     * the request URL. Then calls `onBundleConfigLoaded` which invokes
     * `callback(err, bundle, pathname, config, req, res, next)`.
     *
     * @inner
     * @private
     * @param {object} req - Incoming request object
     * @param {object} res - Server response object
     * @param {function} next - Next middleware callback
     * @param {function} callback - `function(err, bundle, pathname, config, req, res, next)`
     */
    var loadBundleConfiguration = function(req, res, next, callback) {

        var config = new Config();
        config.setBundles(self.bundles);
        // for all loaded bundles
        var conf = config.getInstance();
        //for cacheless mode
        if ( typeof(conf) != 'undefined') {
            self.conf = conf;
        }

        var pathname    = req.url;
        var bundle      = self.appName; // by default

        // finding bundle
        if (self.isStandalone) {

        end:
            for (let b in conf) {
                if (self.bundles.indexOf(b) < 0) continue;
                if ( typeof(conf[b][self.env].content) != 'undefined' && typeof(conf[b][self.env].content.statics) != 'undefined' && conf[b][self.env].content.statics.count() > 0 ) {
                    for (let s in conf[b][self.env].content.statics) {
                        s = (s.substring(0,1) == '/') ? s.substring(1) : s;
                        if ( (new RegExp('^/'+s)).test(pathname) ) {
                            bundle = b;
                            break end
                        }
                    }
                } else {
                    // no statics ... use startingApp and leave it to handle()
                    self.isNotStatic = true
                    break
                }
            }
        }


        if ( /\/favicon\.ico/.test(pathname) && !hasViews(bundle)) {
            callback(false, bundle, pathname, config, req, res, next);
            return false
        }

        onBundleConfigLoaded(bundle, {
            err         : false,
            config      : config,
            pathname    : pathname,
            req         : req,
            res         : res,
            conf        : config,
            next        : next,
            callback    : callback
        });

        return;
    }

    /**
     * Invokes the routing `callback` once per request with the resolved bundle
     * and config. In cacheless mode this would also trigger a config refresh
     * (currently commented out).
     *
     * @inner
     * @private
     * @param {string} bundle - Resolved bundle name for this request
     * @param {object} options - Options bag from `loadBundleConfiguration`
     * @param {boolean|Error} options.err - Error state
     * @param {object} options.config - Config singleton
     * @param {string} options.pathname - Request URL pathname
     * @param {object} options.req - Incoming request object
     * @param {object} options.res - Server response object
     * @param {function} options.next - Next middleware callback
     * @param {function} options.callback - Final callback `function(err, bundle, pathname, config, req, res, next)`
     */
    var onBundleConfigLoaded = function(bundle, options) {
        var err             = options.err
            , isCacheless   = options.config.isCacheless()
            , pathname      = options.pathname
            , req           = options.req
            , res           = options.res
            , config        = options.conf
            , next          = options.next
            , callback      = options.callback
        ;

        //Reloading assets & files.
        // ⚠️ Before ever uncommenting the refresh below, settle secrets-backend
        // caching: `secrets.resolve` runs inside every config load, so with
        // `settings.secrets.exec` declared this dead branch would re-run the
        // operator's fetch command — a blocking child process — PER BUNDLE PER
        // REQUEST in cacheless mode. Today the exec fetch runs once per bundle
        // at boot only, precisely because this call site is dead.
        // if (!isCacheless) { // all but dev & debug
            callback(err, bundle, pathname, options.config, req, res, next)
        // } else {
        //     config.refresh(bundle, function(err, routing) {
        //         if (err) {
        //             throwError(res, 500, 'Internal server error: \n' + (err.stack||err), next)
        //             return;
        //         } else {
        //             refreshing routing at the same time.
        //            self.routing = routing;
        //             callback(err, bundle, pathname, options.config, req, res, next)
        //        }
        //     })
        // }
    }

    /**
     * Iterates through the Express-compatible middleware stack attached to
     * `instance._expressMiddlewares`, calling each in sequence and routing
     * to either `router.route` or `handleStatics` when the chain is exhausted.
     * Provides Express middleware portability for non-Express engines.
     *
     * @inner
     * @private
     * @param {Error|boolean} err - Error from the previous middleware, or false
     */
    // FRAMEWORK PATCH: Bug I — wrap nextMiddleware in a
    // per-request factory. The original function held dispatch state on its
    // own properties (._index, ._request, ._response, ._next, ._nextAction).
    // Under concurrent requests, request B's setup at the entry point
    // overwrote request A's state, so A's awaited middleware callbacks
    // resumed against B's req object — visible as "[csrf] no req.session.id"
    // sporadic 500s when express-session correctly populated req.session for
    // A but CSRF then ran with B's req that never went through session.
    // Each call to createNextMiddleware now returns a fresh function with
    // closure-isolated state. Push upstream to gina-io/gina.
    var createNextMiddleware = function() {
    var nextMiddleware = function(err) {

        var router              = local.router;
        var expressMiddlewares  = self.instance._expressMiddlewares;

        if (err) {
            return throwError(nextMiddleware._response, 500, (err.stack||err.message||err), nextMiddleware._next, nextMiddleware._nextAction);
        }

        // #FI — per-middleware timing
        var _mwFn = expressMiddlewares[nextMiddleware._index];
        var _mwStart = (nextMiddleware._request._devTimeline) ? Date.now() : 0;

        _mwFn(nextMiddleware._request, nextMiddleware._response, function onNextMiddleware(err, request, response) {

            // #FI — record this middleware's duration
            if (_mwStart && nextMiddleware._request._devTimeline) {
                nextMiddleware._request._devTimeline.entries.push({
                    label: _mwFn.name || ('middleware[' + nextMiddleware._index + ']'),
                    cat: 'middleware',
                    startMs: _mwStart, endMs: Date.now(),
                    durationMs: Date.now() - _mwStart,
                    detail: null
                });
            }

            if (err) {
                return throwError(nextMiddleware._response, 500, (err.stack||err.message||err), nextMiddleware._next, nextMiddleware._nextAction);
            }

            ++nextMiddleware._index;
            if (request) {
                nextMiddleware._request  = request;
            }

            if (response) {
                nextMiddleware._response = response;
            }

            if (nextMiddleware._index > nextMiddleware._count) {

                if ( nextMiddleware._nextAction == 'route' ) {
                    router._server = self.instance;
                    router.route(nextMiddleware._request, nextMiddleware._response, nextMiddleware._next, nextMiddleware._request.routing);
                } else { // handle statics
                    self._responseHeaders = nextMiddleware._response.getHeaders();
                    handleStatics(nextMiddleware._staticProps, nextMiddleware._request, nextMiddleware._response, nextMiddleware._next);
                }
            } else {
                nextMiddleware.call(this, err, true)
            }
        });
    };
        return nextMiddleware;
    };

    /**
     * Detects CORS preflight (OPTIONS) requests by inspecting the method,
     * `Access-Control-Request-Method` header, and configured allowed-origin
     * lists. Sets `request.isPreflightRequest` accordingly.
     *
     * @inner
     * @private
     * @param {object} request - Incoming request object (mutated with `isPreflightRequest`)
     * @param {object} response - Server response object
     * @returns {object} The (mutated) request object
     */
    var checkPreflightRequest = function(request, response) {
        var config = self.conf[self.appName][self.env];
        // by default, if not set in `${projectPath}/env.json`
        var corsMethod = 'GET, POST, HEAD';
        // See https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS
        if (
            typeof(config.server.response.header['access-control-allow-methods']) != 'undefined'
            &&
            config.server.response.header['access-control-allow-methods'] != ''
        ) {
            // as defined in `${projectPath}/env.json`
            corsMethod = config.server.response.header['access-control-allow-methods'];
        }

        var method                          = ( /http\/2/.test(config.server.protocol) ) ? request.headers[':method'] : request.method
            //, reMethod                      = new RegExp(method, 'i')
            , reAccessAllowMethod           = new RegExp('(' + corsMethod.replace(/\,\s+|\s+\,|\,/g, '|') +')', 'i')
            // preflight support - conditions required
            , isPreflightRequest            = (
                    // must meet all the following conditions
                    /OPTIONS/i.test(method)
                    && typeof(request.headers['access-control-request-method']) != 'undefined'

                    // as defined in `${projectPath}/env.json`,
                    // request method must match: config.server.response.header['access-control-allow-methods']
                    && reAccessAllowMethod.test(request.headers['access-control-request-method'])
                    && typeof(request.headers['access-control-request-headers']) != 'undefined'
                ) ? true : false
            , accessControlRequestHeaders   = null
            , serverResponseHeaders         = config.server.response.header//config.envConf[self.appName][self.env].server.response.header
        ;

        // additional checks
        // /(application\/x\-www\-form\-urlencoded|multipart\/form\-data|text\/plain)/i.test(request.headers['accept'])

        request.isPreflightRequest  = isPreflightRequest;
        if (isPreflightRequest) { // update request/response
            method                      = request.headers['access-control-request-method'];
            // updating to avoid conflict with requested route
            if ( /http\/2/.test(config.server.protocol) ) {
                request.headers[':method'] = method;
            } else {
                request.method = method
            }
            accessControlRequestHeaders = ( typeof(request.headers['access-control-request-headers']) != 'undefined' ) ? request.headers['access-control-request-headers'].replace(/\s+/, '').split(/\,/g) : '';
            if ( typeof(request.headers['access-control-request-credentials']) != 'undefined' && typeof(serverResponseHeaders['access-control-allow-credentials']) != 'undefined' ) {
                request.isWithCredentials = true;
            }
            if (accessControlRequestHeaders.length > 0) {
                for (var h in accessControlRequestHeaders) {
                    if ( /x\-requested\-with/i.test(h) && /x\-requested\-with/i.test(serverResponseHeaders['access-control-allow-headers']) ) {
                        request.isXMLRequest = true;
                    }
                }
                response.setHeader('access-control-allow-headers', request.headers['access-control-request-headers']);
            }
        }

        return request
    }

    // #RC4 — serve an already-resolved render/output-cache entry (design f). Redis L1/L2
    // entries are `fromMemory` (never an `fs` filename — redis has no disk body), so this
    // is the memory-serve shape, mirroring server.isaac.js's cache-hit serve + render-json's
    // HTTP/2 respond. B2: a warm() that lost the race to a client abort must be FULLY
    // abandoned — never write to a dead socket, never fall through to a second render — so
    // the dead-response guard returns `true` (served/handled) with the response untouched
    // (L1 was already populated by warm(); harmless). Returns true when handled.
    // #RC5 — `source` names the physical tier the bytes came from on THIS request,
    // emitted as the RFC 9211 §2.8 `detail` parameter (implementation-specific by
    // design — the RFC's own example is `detail=MEMORY`): 'memory' = the in-process
    // L1 Map, 'redis' = a shared-L2 warm — the cross-replica cold-start, observable
    // on the wire.
    var serveRenderCacheHit = function(req, res, hit, source) {
        var _isH2 = /http\/2/.test(self.conf[self.appName][self.env].server.protocol) && res.stream;
        // B2 (+ F6) — response gone OR already committed: abandon. Covers a client abort
        // during the warm await (destroyed / ended) AND an already-headersSent response
        // (nothing before dispatch sends headers, so this arm is defensive) — either way
        // the setHeader loop below must not run (it would ERR_HTTP_HEADERS_SENT).
        if ( _isH2
                ? ( res.stream.destroyed || res.stream.headersSent )
                : ( res.writableEnded || res.destroyed || res.headersSent ) ) {
            return true;
        }
        // Remaining absolute ttl (redis entries are never sliding — validateConfig rejects
        // sliding+redis). createdAt was stamped by mem.set at warm/serve-into-L1 time, so
        // a re-served L1 entry reports its true shrinking remaining life (#C6 correctness).
        var _remaining = null;
        if ( typeof(hit.ttl) === 'number' && hit.ttl > 0 && hit.createdAt ) {
            _remaining = Math.max(0, Math.floor( (hit.createdAt.getTime() + Math.round(hit.ttl * 1000) - Date.now()) / 1000 ));
        }
        var _vis = ( hit.visibility === 'public' ) ? 'public' : 'private';
        // #B130 — a hit replays the STORED headers + body, both minted by the request
        // that WROTE the entry. When the stored CSP header carries a nonce, replaying
        // the pair verbatim would reuse one nonce for every client of this URL until
        // the TTL (and the Csp middleware never re-mints here — the hit short-circuits
        // dispatch). Mint fresh + rewrite the header copy AND the body occurrences so
        // nonces stay per-response. The stored entry is never mutated.
        // Keep in sync with the isaac pre-routing read (server.isaac.js).
        var _rn         = lib.RenderCache.renonceCspHeaders(hit.responseHeaders || null);
        var _hitContent = _rn ? lib.RenderCache.swapNonces(hit.content, _rn.oldNonces, _rn.nonce) : hit.content;
        // The page's own headers first, then the cache metadata.
        if ( hit.responseHeaders ) {
            var _hitHeaders = _rn ? _rn.headers : hit.responseHeaders;
            for (var h in _hitHeaders) { res.setHeader(h, _hitHeaders[h]); }
        }
        // #RC5 — ONE header string, set AND logged from the same var (the prior dual
        // construction at setHeader + console.info was a drift hazard).
        // #B238 — identifier from the boot-resolved stamp (was the literal
        // 'gina-cache'); default unchanged when server.cache.name is unset.
        var _cs = self.instance._cacheName + '; hit'
            + (_remaining !== null ? '; ttl=' + _remaining : '')
            + (source ? '; detail=' + source : '');
        res.setHeader('Cache-Status', _cs);
        if ( _remaining !== null ) {
            res.setHeader('Cache-Control', _vis + ', max-age=' + _remaining);
        }
        if ( _isH2 ) {
            // Fold res.getHeaders() (the cache metadata + page headers set just above)
            // into the stream.respond() headers — they don't travel on a raw Http2Stream.
            // NOTE completeHeaders() runs during dispatch, which this hit short-circuits,
            // so the ORIGINAL render's completeHeaders output is already baked into
            // hit.responseHeaders (captured at write time) — it is not re-derived here.
            if ( !res.stream.headersSent && !res.stream.destroyed ) {
                var _sh = { ':status': 200 };
                var _pending = res.getHeaders ? res.getHeaders() : {};
                for (var ph in _pending) { _sh[ph] = _pending[ph]; }
                res.stream.respond(_sh);
                res.stream.end(_hitContent);
                res.headersSent = true;
            }
        } else {
            if ( !res.headersSent && !res.writableEnded ) {
                res.end(_hitContent);
            }
        }
        console.info(req.method + ' [200][' + _cs + '] ' + (req.originalUrl || req.url));
        return true;
    };

    // #RC4 — the render/output-cache redis L2 read (design f). Engine-agnostic (this
    // dispatch backs BOTH isaac and express — fixing #B111: express had no read path).
    // Tightly gated so an uncached GET pays nothing: only a GET on a route that opts into
    // caching AND resolves to the redis strategy AND with the cache enabled reaches redis.
    // isaac's pre-routing read already served any L1 hit before this runs (so here L1 is
    // the EXPRESS fast path); L2 warm() is the cold-replica path both engines share, and
    // repopulates L1 so the next request hits L1. Returns true when it SERVED (or abandoned
    // a dead response) → the caller returns; false → fall through to the normal render.
    var tryServeRenderCacheHit = async function(req, res, bundle) {
        var _method = ( /http\/2/.test(self.conf[self.appName][self.env].server.protocol) ) ? req.headers[':method'] : req.method;
        if ( !/^get$/i.test(_method || req.method || '') ) { return false; }
        if ( !req.routing || !req.routing.cache ) { return false; }
        // #SPA1 — never SERVE a negotiable route from the output cache. The key has no
        // shape dimension and this serve point runs before the shape is resolved, so a
        // hit could replay a fragment to a page request. The writer refuses too
        // (render-swig writeCache), making this defence-in-depth rather than the only
        // guard — but it is stated at BOTH ends so the invariant is local to each site.
        if ( req.routing.negotiate === true ) { return false; }
        if ( String(self.instance._cacheIsEnabled).toLowerCase() !== 'true' ) { return false; }
        // No L2 store wired (memory/fs bundle, or boot degraded) → nothing to warm here;
        // isaac already served any L1 hit, and express memory/fs read is a later slice.
        if ( !(process.gina && process.gina._renderCacheStore) ) { return false; }

        // Effective strategy: route.cache.type wins, else the bundle-wide server.cache.type
        // (post the config.js fold). Must resolve to redis (delegate/writeCache parity).
        var _serverCache = self.conf[self.appName][self.env].server.cache;
        var _rc      = req.routing.cache;
        // F3 — effective strategy with writeCache parity: a route that sets `type` at
        // all (even blank/garbage) KEEPS it; only a route that OMITS `type` inherits the
        // bundle-wide default. (A bare `!_rcType` inherit made a route `type:""` warm L2
        // for a surface the writer never wrote.) `_rc` is truthy here (the guard above
        // rejected a falsy req.routing.cache), so it is a non-empty string or an object.
        var _rcType;
        if ( typeof(_rc) === 'string' ) {
            _rcType = _rc;
        } else if ( _rc && typeof(_rc.type) !== 'undefined' ) {
            _rcType = _rc.type;
        } else {
            _rcType = _serverCache && _serverCache.type;
        }
        if ( !/^redis$/i.test(_rcType || '') ) { return false; }

        // F1 — warm() MUST re-register the route's invalidateOnEvents (a warmed entry
        // skipped the delegate's setEvents; without them an event can neither evict L1 nor
        // DEL L2). Route config is the source of truth — the L2 value never carries events.
        var _events = ( _rc && typeof(_rc) === 'object' && Array.isArray(_rc.invalidateOnEvents) ) ? _rc.invalidateOnEvents : [];
        var _url    = req.originalUrl || req.url; // parity with the delegate write (req.originalUrl)
        // Point at the shared Map; NO cachePath → pure L1 (redis entries have no fs body).
        renderCache.from(self.instance._cached);

        var _kinds = ['data', 'static']; // a URL is rendered by ONE action → ONE kind; try both
        var _hit   = null, _hitSource = null, i, _k;
        // L1 first (sync, no redis): a warmed entry from a prior request, or the express L1.
        for (i = 0; i < _kinds.length; i++) {
            _k = renderCache.buildKey(_kinds[i], bundle, _url);
            if ( renderCache.has(_k) ) {
                _hit = renderCache.get(_k);
                if ( _hit ) { _hitSource = 'memory'; break; }
                _hit = null;
            }
        }
        // L2 warm on an L1 miss (reads redis, repopulates L1; fail-open → undefined).
        if ( !_hit ) {
            for (i = 0; i < _kinds.length; i++) {
                _k = renderCache.buildKey(_kinds[i], bundle, _url);
                _hit = await renderCache.warm(_k, _events);
                if ( _hit ) { _hitSource = 'redis'; break; }
                _hit = null;
            }
        }
        if ( !_hit ) {
            // #RC5 — both tiers consulted, nothing found: report the RFC 9211 miss form
            // (`fwd=uri-miss`, §2.2 — "did not contain any responses that matched the
            // request URI") before falling through to the render. Reached ONLY past every
            // gate above, so an uncached / non-redis / disabled route still emits nothing.
            // On isaac this overwrites the pre-routing read's identical miss value; on
            // express it is the engine's FIRST miss signal (#B111 sibling). `stored` is
            // deliberately NOT claimed — whether the render's writeCache stores is not
            // knowable here, and headers are flushed before it settles.
            if ( !res.headersSent ) {
                // #B238 — identifier from the boot-resolved stamp (was the literal 'gina-cache').
                res.setHeader('Cache-Status', self.instance._cacheName + '; fwd=uri-miss');
            }
            return false; // miss → render normally
        }
        return serveRenderCacheHit(req, res, _hit, _hitSource);
    };

    // #M12b — wrap the async dispatch in the per-request log context so requestId /
    // durationMs propagate through the WHOLE await chain (router, controller, render,
    // connectors). Established here — not at onInstance — because the request.on('end')
    // boundary between them loses the async context, whereas handle()'s awaits preserve
    // it. The store carries {requestId, startMs} stamped at onInstance entry.
    // #B502 — the store is entered on EVERY request, in every log mode: it also carries
    // the request's proxied classification (`proxy`, filled by core/router.js after the
    // engine-agnostic slot fill) so the req-less lib/routing getRoute()/toUrl() resolves
    // THIS request's context instead of the worker-global latch — which is monotonic
    // once any port-less-Host request has written process.gina.PROXY_HOSTNAME, and so
    // made a later DIRECT request build its absolute URLs from another request's host.
    // The logger readers stay JSON-gated (lib/logger main.js + containers/default), so
    // text mode gains only the ALS enter; requestId/startMs are read there as before.
    var handle = async function(req, res, next, bundle, pathname, config) {
        if ( !process.gina ) { process.gina = {}; }
        if ( !process.gina._reqALS ) {
            var { AsyncLocalStorage } = require('async_hooks');
            process.gina._reqALS = new AsyncLocalStorage();
        }
        var _reqStore = {
            requestId : req._ginaReqId || _resolveRequestId(req),
            startMs   : (typeof req._ginaReqStartMs === 'number') ? req._ginaReqStartMs : Date.now(),
            proxy     : null
        };
        return process.gina._reqALS.run(_reqStore, function() {
            return _handleDispatch(req, res, next, bundle, pathname, config);
        });
    };

    var _handleDispatch = async function(req, res, next, bundle, pathname, config) {

        // #FI — request setup time (header parsing, CORS, Inspector endpoint checks)
        if (req._devTimeline) {
            var _handleStart = Date.now();
            req._devTimeline.entries.push({
                label: 'request-setup', cat: 'routing',
                startMs: req._devTimeline.requestStart, endMs: _handleStart,
                durationMs: _handleStart - req._devTimeline.requestStart,
                detail: null
            });
        }

        var matched             = false
            , isRoute           = null
            , withViews         = hasViews(bundle)
            , router            = local.router
            , isCacheless       = config.isCacheless()
            , wroot             = null
        ;

        //matched = routingLib.getRouteByUrl(req.url, bundle, (req.method||req[':method']), req);

        req = checkPreflightRequest(req, res);

        // Short-circuit OPTIONS preflight: respond immediately with CORS headers and
        // HTTP 204, without routing the request to the controller.
        // Without this, checkPreflightRequest() overwrites the OPTIONS method to the
        // requested method (e.g. POST), the controller action runs without a body,
        // returns an error response (e.g. 412), and Access-Control-Allow-Origin is
        // never written — causing the browser's CORS check to fail.
        if ( req.isPreflightRequest ) {
            var preflightHeader = null;
            if ( /http\/2/.test(self.conf[self.appName][self.env].server.protocol) && res.stream ) {
                preflightHeader = { ':status': 204 };
                preflightHeader = completeHeaders(preflightHeader, req, res);
                if ( !res.stream.destroyed ) {
                    res.stream.respond(preflightHeader);
                    res.stream.end();
                }
            } else {
                completeHeaders(null, req, res);
                res.writeHead(204);
                res.end();
            }
            return;
        }

        // Pre-set CORS and default response headers on the response object.
        // render-json.js merges response.getHeaders() into the HTTP/2 stream.respond()
        // headers object, so headers written here reach the client on every JSON response.
        completeHeaders(null, req, res);

        var params      = {}
            , _routing  = {}
            , method    = ( /http\/2/.test(self.conf[self.appName][self.env].server.protocol) ) ? req.headers[':method'] : req.method
            , reMethod  = new RegExp(method, 'i')
        ;
        try {


            // #FI — route matching start
            var _routeMatchStart = (isCacheless && req._devTimeline) ? Date.now() : 0;

            var routing   = config.getRouting(bundle, self.env);

            if ( routing == null || routing.count() == 0 ) {
                console.error('Malformed routing or Null value for bundle [' + bundle + '] => ' + req.url);
                throwError(res, 500, 'Internal server error\nMalformed routing or Null value for bundle [' + bundle + '] => ' + req.url, next);
                return;
            }

        } catch (err) {
            throwError(res, 500, err.stack, next);
            return;
        }
        var isMethodAllowed = null, hostname = null, _methodMismatch405msg = null;

        // #B84 — per-request culture negotiation, shared by the cold (loop-match)
        // and warm (cached-route fast-path) paths. The cached fast-path breaks the
        // routing loop before the cold-path negotiation site below, so without
        // calling this on the warm path `req.culture` stayed unset on every cached
        // request (→ `gina.config.culture` empty → the i18n overlays are inert on
        // warm reloads). Re-negotiate per-request (never cache the resolved culture:
        // it varies per request via cookie / Accept-Language, so caching it with the
        // shared route entry would cross-request-bleed).
        var _negotiateReqCulture = function(req, routeBundle) {
            try {
                var _i18nBundle = routeBundle || null;
                var _i18nAvail  = ( _i18nBundle
                    && process.gina._i18nCatalogs
                    && process.gina._i18nCatalogs[_i18nBundle] )
                    ? Object.keys(process.gina._i18nCatalogs[_i18nBundle])
                    : [];
                // #B102 — `settings.i18n.cultures`, honoured since 0.5.22: a
                // non-empty array constrains which cultures the USER-SIGNAL
                // steps (URL prefix / cookie / Accept-Language) may match —
                // e.g. a staged rollout keeps a shipped-but-unlaunched catalog
                // out of negotiation. The bundle-default step
                // (settings.region.culture) is deliberately NOT constrained —
                // the operator's fallback needs no catalog match. `null`, `[]`
                // or a non-array keep the historical derive-from-loaded-
                // catalogs behavior.
                if ( _i18nAvail.length > 0
                    && _i18nBundle
                    && self.conf[_i18nBundle]
                    && self.conf[_i18nBundle][self.env]
                    && self.conf[_i18nBundle][self.env].content
                    && self.conf[_i18nBundle][self.env].content.settings
                    && self.conf[_i18nBundle][self.env].content.settings.i18n
                ) {
                    var _i18nCulturesConf = self.conf[_i18nBundle][self.env].content.settings.i18n.cultures;
                    if ( Array.isArray(_i18nCulturesConf) && _i18nCulturesConf.length > 0 ) {
                        _i18nAvail = _i18nAvail.filter(function(c) {
                            return _i18nCulturesConf.indexOf(c) > -1;
                        });
                    }
                }
                // #I18N — bundle-level default culture: settings.region.culture
                // (full underscore culture, e.g. `xx_XX`, resolved at bundle:add).
                // Ranks below URL/cookie/Accept-Language (which need loaded catalogs
                // to match) and above the GINA_CULTURE env fallback (negotiateCulture
                // step 5). Format-guarded so an unresolved `${culture}` placeholder
                // never leaks through as the culture.
                var _i18nDefault = null;
                if ( _i18nBundle
                    && self.conf[_i18nBundle]
                    && self.conf[_i18nBundle][self.env]
                    && self.conf[_i18nBundle][self.env].content
                    && self.conf[_i18nBundle][self.env].content.settings
                    && self.conf[_i18nBundle][self.env].content.settings.region
                    && typeof(self.conf[_i18nBundle][self.env].content.settings.region.culture) == 'string'
                    && /^[a-z]{2,3}([_-][A-Za-z]{2,4})?$/.test(self.conf[_i18nBundle][self.env].content.settings.region.culture)
                ) {
                    _i18nDefault = self.conf[_i18nBundle][self.env].content.settings.region.culture;
                }
                // #B99 — `settings.i18n.cookieName`, honoured since 0.5.16: a
                // bundle may rename the locale-persistence cookie; an explicit
                // `null` disables cookie-based negotiation (negotiateCulture
                // skips its cookie step on a falsy name). Absent, empty or
                // non-string values keep the historical `gina_culture` default.
                var _i18nCookieName = 'gina_culture';
                if ( _i18nBundle
                    && self.conf[_i18nBundle]
                    && self.conf[_i18nBundle][self.env]
                    && self.conf[_i18nBundle][self.env].content
                    && self.conf[_i18nBundle][self.env].content.settings
                    && self.conf[_i18nBundle][self.env].content.settings.i18n
                ) {
                    var _i18nCookieConf = self.conf[_i18nBundle][self.env].content.settings.i18n.cookieName;
                    if ( _i18nCookieConf === null ) {
                        _i18nCookieName = null;
                    } else if ( typeof(_i18nCookieConf) == 'string' && _i18nCookieConf.length > 0 ) {
                        _i18nCookieName = _i18nCookieConf;
                    }
                }
                req.culture = lib.i18n.negotiateCulture(req, {
                    availableCultures : _i18nAvail,
                    cookieName        : _i18nCookieName,
                    defaultCulture    : _i18nDefault
                });
            } catch (_i18nErr) {
                req.culture = (getEnvVar('GINA_CULTURE') || 'en').replace(/-/g, '_');
            }
        };

        // Checking cached route
        // #B422 — a cached entry is a CANDIDATE, not a verdict. getCached() re-runs
        // compareUrls(), whose returned foundRoute carries the verdict in `.past`
        // (`request.routing` is populated only when `.past` is true) — but this call
        // site used to test the OBJECT's truthiness, so a warm entry whose
        // `requirements` REJECTED the request was still forced into `matched = true`
        // by the loop's cached-route break below, dispatching with `req.routing`
        // unset: the header-composition stub reached router.route(), whose
        // `params.param.control` deref threw inside the async chain — an unhandled
        // rejection, connection dropped, no HTTP response at all. Trigger: the cache
        // key is `method:pathname` and (on the isaac engine) `req.url` arrives
        // query-stripped, so ALL query variants of one pathname share ONE entry —
        // whichever variant is seen first decides what is cached, and every later
        // variant used to inherit that entry verdict-free.
        // Fix: honor the verdict. Any warm outcome other than `.past === true`
        // (requirements rejected, or a throwing `validator::` requirement) restores
        // the request bags the failed compareUrls run contaminated (same surface the
        // cold loop resets per iteration: req.params + req[method]) and falls
        // through to the cold scan, which owns every terminal: 404, a sibling rule,
        // or the cold catch's 500 naming the rule. Mirrors the two #B121 fixes in
        // lib/routing (`was: if (isRoute.past)`).
        var _reqMethodKey   = (method || req.method || 'GET').toLowerCase();
        // #B422 — pre-getCached capture: a truly-cold request reaches this point
        // with getCached() returning null WITHOUT running compareUrls, so restoring
        // this state makes the fall-through byte-equivalent to a cold request at
        // loop entry.
        var _preCacheParams     = Object.assign({}, req.params);
        var _preCacheReqMethod  = (typeof(req[_reqMethodKey]) != "undefined") ? Object.assign({}, req[_reqMethodKey]) : undefined;
        var hasCachedRoute      = null;
        var _cachedRouteThrew   = false;
        try {
            hasCachedRoute = await routingLib.getCached(req.method +':'+ pathname, req) || null;
        } catch (_cachedRouteErr) {
            // #B422 — a warm `validator::` requirement threw: treat as a miss. The
            // cold scan re-runs the same rule and answers through its own catch,
            // naming the rule — this warm site only knows the cache key.
            _cachedRouteThrew = true;
        }
        if ( _cachedRouteThrew || hasCachedRoute && hasCachedRoute.past !== true ) {
            // #B422 — requirements rejected this request (or evaluation threw). The
            // entry stays valid for the variants it accepts; THIS request re-enters
            // the cold scan clean.
            req.params = Object.assign({}, _preCacheParams);
            req[_reqMethodKey] = _preCacheReqMethod ? Object.assign({}, _preCacheReqMethod) : {};
            hasCachedRoute = null;
        }
        if ( hasCachedRoute ) {
            // Supposed to have everything we need to route
            isRoute = hasCachedRoute;
            // req = isRoute.request;
            // #B84 — the cached fast-path breaks out of the routing loop below
            // before the cold-path negotiation site, so negotiate here. getCached()
            // ran compareUrls(), which has already populated req.routing (incl.
            // culturePrefix + bundle), so the URL-prefix negotiation step still works.
            _negotiateReqCulture(req, ( req.routing && req.routing.bundle ) || bundle);
        } else {
            isRoute = {}
        }

        // Radix trie fast-path — build a candidate Set for this request so the
        // linear scan can skip routes that cannot structurally match the URL.
        // lookupTrie returns null when no trie is available → linear scan runs normally.
        var _trieCandidateSet = null;
        if (!hasCachedRoute) {
            var _trieHits = routingLib.lookupTrie(safeDecodeURI(pathname), bundle); // #B30: malformed-%-safe — a bad escape here would otherwise reject the async dispatch promise → hung request
            if (_trieHits !== null && _trieHits.length > 0) {
                _trieCandidateSet = new Set(_trieHits);
            }
        }

        // #B422 — _reqMethodKey is computed above, before the getCached call, so the
        // pre-cache capture and this loop's per-iteration reset share one key.
        // Save the original req.params set by server.isaac.js (e.g. { 0: "/path" }).
        // fitsWithRequirements checks typeof(request.params) != 'undefined' — it must
        // exist, but contamination keys from failed compareUrls must be removed.
        var _origParams     = Object.assign({}, req.params);
        var _origReqMethod  = (typeof(req[_reqMethodKey]) != "undefined") ? Object.assign({}, req[_reqMethodKey]) : undefined;


        out:
            for (let name in routing) {
                // skip non-object entries (e.g. $schema annotations in routing.json)
                if ( typeof(routing[name]) != 'object' || routing[name] === null ) continue;

                // Ignore cached route
                if ( hasCachedRoute ) {
                    matched = true;
                    break;
                }

                // Radix trie fast-path: skip routes that cannot match this URL structure
                if ( _trieCandidateSet !== null && !_trieCandidateSet.has(name) ) continue;

                // Ignoring routes out of scope
                if ( routing[name].scopes.indexOf(process.env.NODE_SCOPE) < 0 ) {
                    continue;
                }

                if ( typeof(routing[name]['param']) == 'undefined' ) {
                    continue; // replaced: break — skip entries without param rather than aborting route matching
                }

                // Clean cross-route contamination from previous iteration's compareUrls.
                // fitsWithRequirements sets req.params[key] and req[method][key] during
                // matching; leftover values cause parseRouting lines 396-407 to inject
                // phantom segments, compounding work on each subsequent compareUrls call.
                req.params = Object.assign({}, _origParams);
                req[_reqMethodKey] = _origReqMethod ? Object.assign({}, _origReqMethod) : {};

                // Updating hostname
                // if (
                //     typeof(routing[name].hostname) == 'undefined' && !/^redirect$/.test(routing[name].param.control)
                //     || !routing[name].hostname && !/^redirect$/.test(routing[name].param.control)
                // ) {
                //     hostname = self.conf[routing[name].bundle][self.env].hostname;
                //     routing[name].hostname = self.conf.routing[name].hostname = hostname;
                // }

                // For debug only
                // if ( name == 'name-of-targeted-rule@bundle') {
                //     console.debug('checking: ', name);
                // }

                if (routing[name].bundle != bundle) continue;

                // Early method filter — skip routes whose single HTTP method cannot
                // match the request.  This avoids the expensive async compareUrls()
                // call for obvious method mismatches (the main dev-mode perf win,
                // since the routing cache is cleared on every request in cacheless mode).
                // Multi-method routes (e.g. "get,post") are NOT filtered here.
                var _routeMethod = routing[name].method;
                if ( !/\,/.test(_routeMethod) && !reMethod.test(_routeMethod) ) {
                    // Exception — HEAD requests match GET routes (HTTP spec)
                    if ( /^head$/i.test(req.method) && /^get$/i.test(_routeMethod) ) {
                        /* fall through to compareUrls */
                    // Exception — GET → DELETE method override
                    } else if ( /^get$/i.test(req.method) && /^delete$/i.test(_routeMethod) ) {
                        /* fall through to compareUrls */
                    } else {
                        continue;
                    }
                }

                // Method filter
                method = routing[name].method;
                if ( /\,/.test( method ) && reMethod.test(method) ) {
                    method = req.method
                }

                // Preparing params to relay to the router.
                params = {
                    method              : method,
                    control             : routing[name].param.control,
                    requirements        : routing[name].requirements,
                    namespace           : routing[name].namespace || undefined,
                    url                 : safeDecodeURI(pathname), /// avoid %20 — #B30 malformed-%-safe
                    rule                : routing[name].originalRule || name,
                    cache               : routing[name].cache || null,
                    queryTimeout        : parseTimeout(routing[name].queryTimeout) || null,
                    // #CSRF2 — per-route opt-out for the Csrf middleware (webhook receivers, etc.)
                    csrfExempt          : routing[name].csrfExempt || false,
                    // #MS6 — per-route rate-limit override/exempt. typeof-guarded,
                    // NOT `||`: `false` is a MEANINGFUL value (exempt) that `|| null`
                    // would erase into the default policy.
                    rateLimit           : ( typeof(routing[name].rateLimit) != 'undefined' ) ? routing[name].rateLimit : null,
                    // #FIN6 — per-route idempotency opt-in. typeof-guarded for
                    // symmetry with the rate-limit line above (`false` is a
                    // meaningful explicit value).
                    idempotency         : ( typeof(routing[name].idempotency) != 'undefined' ) ? routing[name].idempotency : null,
                    // #I18N1 slice 3 — per-route culture-prefix opt-in.
                    // When true, the i18n negotiator reads
                    // req.routing.param.culture as the highest-priority
                    // culture source (URL `/fr/...` → req.culture='fr').
                    culturePrefix       : routing[name].culturePrefix || false,
                    // #SPA1 — per-route content-negotiation capability. Declares that
                    // this route may answer in more than one shape, so the render cache
                    // (whose key carries no shape dimension) must not serve or store it.
                    // Read at the request-pipeline boundary, BEFORE the cache serve
                    // points — which is precisely why the capability is route-declared
                    // rather than derived inside render().
                    negotiate           : routing[name].negotiate || false,
                    // We clone because we are going to modify it while comparing urls
                    param               : JSON.clone(routing[name].param),
                    // We clone because we are going to modify it while routing (.splice(..))
                    middleware          : JSON.clone(routing[name].middleware),
                    bundle              : routing[name].bundle,
                    isXMLRequest        : req.isXMLRequest,
                    isWithCredentials   : req.isWithCredentials
                };

                // Parsing for the right url.
                try {
                    isRoute = await routingLib.compareUrls(params, routing[name].url, req, res, next);
                } catch (err) {
                    var msg = 'Internal server error.\nRule [ '+name+' ] needs your attention.\n';
                    // TODO - Refactor `ApiError`to handle the following param
                    // var e = new ApiError({ message: msg, stack: err.stack});
                    // throwError(res, e)
                    throwError(res, 500, 'Internal server error.\nRule [ '+name+' ] needs your attention.\n'+ err.stack);
                    break;
                }

                if ( pathname == routing[name].url || isRoute.past ) {

                    _routing = req.routing;

                    // #B84 — negotiate req.culture on the cold (loop-match) path.
                    // The warm (cached-route) path negotiates earlier via the same
                    // `_negotiateReqCulture` helper, so the two paths cannot drift.
                    // (#I18N1 slice 3 — negotiation order: URL prefix
                    // req.routing.culturePrefix → cookie `gina_culture` →
                    // Accept-Language → settings.region.culture → GINA_CULTURE → 'en'.)
                    _negotiateReqCulture(req, routing[name].bundle);

                    // Comparing routing method VS request.url method
                    isMethodAllowed = reMethod.test(_routing.method);
                    if (!isMethodAllowed) {
                        // Exception — HEAD requests match GET routes (HTTP spec: HEAD is GET without a response body)
                        if ( /^head$/i.test(req.method) && /^get$/i.test(_routing.method) ) {
                            isMethodAllowed = true;
                        // Exception - Method override
                        } else if ( /get/i.test(req.method) && /delete/i.test(_routing.method) ) {
                            console.debug('ignoring case request.method[GET] on routing.method[DELETE]');
                            req.method = _routing.method;
                            isMethodAllowed = true;
                        } else {
                            // URL matched but method didn't — keep looking for a route that matches both.
                            _methodMismatch405msg = 'Method Not Allowed.\n `'+req.url+'` does not support `' + req.method.toUpperCase() + '`';
                            continue;
                        }
                    }

                    // Handling GET method exception - if no param found
                    var methods = ['get', 'delete'], method = req.method.toLowerCase();
                    var p = null;
                    if (
                        methods.indexOf(method) > -1 && typeof(req.query) != 'undefined' && req.query.count() == 0
                        || methods.indexOf(method) > -1 && typeof(req.query) == 'undefined' && typeof(req.params) != 'undefined' && req.params.count() > 1
                    ) {
                        //req.params = parseObject(req.params);
                        p = 0;
                        for (let parameter in req.params) {
                            if (p > 0) {
                                // false & true case
                                if ( /^(false|true|on)$/.test( req.params[parameter] ) && typeof(req.params[parameter]) == 'string' )
                                    req.params[parameter] = ( /^(true|on)$/.test( req.params[parameter] ) ) ? true : false;

                                req[method][parameter] = req.params[parameter]
                            }
                            ++p
                        }

                    } else if ( method == 'put' ) { // merging req.params with req.put (passed through URI)
                        p = 0;
                        for (let parameter in req.params) {
                            if (p > 0) {
                                // false & true case
                                if ( /^(false|true|on)$/.test( req.params[parameter] ) && typeof(req.params[parameter]) == 'string' )
                                    req.params[parameter] = ( /^(true|on)$/.test( req.params[parameter] ) ) ? true : false;

                                req[method][parameter] = req.params[parameter]
                            }
                            ++p
                        }
                    } else if ( method === 'patch' ) { // merging req.params with req.patch (passed through URI)
                        p = 0;
                        for (let parameter in req.params) {
                            if (p > 0) {
                                // false & true case
                                if ( /^(false|true|on)$/.test( req.params[parameter] ) && typeof(req.params[parameter]) == 'string' )
                                    req.params[parameter] = ( /^(true|on)$/.test( req.params[parameter] ) ) ? true : false;

                                req.patch[parameter] = req.params[parameter]
                            }
                            ++p
                        }
                    } else if ( method === 'head' ) { // merging req.params with req.head (URI params, same semantics as GET)
                        p = 0;
                        for (let parameter in req.params) {
                            if (p > 0) {
                                // false & true case
                                if ( /^(false|true|on)$/.test( req.params[parameter] ) && typeof(req.params[parameter]) == 'string' )
                                    req.params[parameter] = ( /^(true|on)$/.test( req.params[parameter] ) ) ? true : false;

                                req.head[parameter] = req.params[parameter]
                            }
                            ++p
                        }
                    }


                    // onRouting Event ???
                    if (isRoute.past) {
                        matched = true;
                        // Caching route
                        routingLib.cache(req.method +':'+ pathname, name, routing[name], params, req[method]);
                        isRoute = {};

                        break;
                    }
                }
            } // EO for (let name in routing) {

        // Restore req[method] if deleted during route matching (#fix: routes without URL params)
        if (typeof(req[_reqMethodKey]) == "undefined") {
            req[_reqMethodKey] = _origReqMethod || {};
        } else if (
            _origReqMethod && typeof(_origReqMethod) == "object"
            && ["get", "put", "post", "patch", "delete"].indexOf(_reqMethodKey) > -1
            && _origReqMethod.count() > 0
        ) {
            // compareUrls recreates req[method] with only URL params, discarding
            // body data parsed by processRequestData (or query params for GET). Merge back in.
            // URL params (in req[method]) take precedence over original values.
            var _bodyKeys = Object.keys(_origReqMethod);
            for (var _bk = 0; _bk < _bodyKeys.length; ++_bk) {
                if (typeof(req[_reqMethodKey][_bodyKeys[_bk]]) == "undefined") {
                    req[_reqMethodKey][_bodyKeys[_bk]] = _origReqMethod[_bodyKeys[_bk]];
                }
            }
        }

        // #FI — route matching end
        if (_routeMatchStart && req._devTimeline) {
            req._devTimeline.entries.push({
                label: 'route-match', cat: 'routing',
                startMs: _routeMatchStart, endMs: Date.now(),
                durationMs: Date.now() - _routeMatchStart,
                detail: matched ? ('rule: ' + (req.routing && req.routing.rule || '?')) : '404'
            });
        }

        if (!matched && _methodMismatch405msg) {
            return throwError(res, 405, _methodMismatch405msg, next);
        }

        if (matched) {
            // #RC4 — render/output-cache redis L2 read (design f). Runs AFTER route
            // matching (so req.routing.cache is materialised → uncached GETs pay nothing)
            // and BEFORE both dispatch paths. On a hit it serves + returns, skipping the
            // express-middleware chain AND router.route. `server.isaac.js` SOURCE is
            // unmodified — this shared handle() read is the L2-warm entry for BOTH
            // engines (on isaac it is the cold-L1 path; isaac's own pre-routing read
            // serves the warmed L1 on the next request).
            if ( await tryServeRenderCacheHit(req, res, bundle) ) {
                return;
            }

            if ( /^isaac/.test(self.engine) && self.instance._expressMiddlewares.length > 0) {
                // FRAMEWORK PATCH: Bug I — per-request dispatcher
                var nextMiddleware = createNextMiddleware();
                nextMiddleware._index        = 0;
                nextMiddleware._count        = self.instance._expressMiddlewares.length-1;
                nextMiddleware._request      = req;
                nextMiddleware._response     = res;
                nextMiddleware._next         = next;
                nextMiddleware._nextAction   = 'route';
                // #FI — express middleware start
                nextMiddleware._timelineStart = (req._devTimeline) ? Date.now() : 0;

                return nextMiddleware()
            }

            router._server = self.instance;

            return router.route(req, res, next, req.routing);
        }

        return throwError(res, 404, 'Page not found: \n' + pathname, next);
    }




    /**
     * Sends an HTTP error response. Renders an HTML error page when the
     * bundle has views and the request is not an XHR, or a JSON error body
     * for XHR/API requests. Also exposed on the server engine instance.
     *
     * #ERRREF — every JSON error body additionally carries a top-level
     * `ref`: a short incident ref minted per error (or honoured from a
     * relay-safe caller-supplied `msg.ref` / 1-arg errorObject `ref`),
     * present in ALL scopes, and paired server-side with the full error
     * detail (message + stack + cause) plus the request correlation id in
     * ONE error-level log line emitted at entry — so the detail the
     * NODE_SCOPE_IS_LOCAL egress gate strips from the wire stays findable
     * from a user-relayed ref. The HTML surfaces (custom error page data +
     * the inline fallback page) carry the same ref.
     *
     * @inner
     * @private
     * @param {object} res - Server response object
     * @param {number} code - HTTP status code (e.g. 404, 500)
     * @param {string|object} msg - Error message string or error object
     * @param {function} next - Next middleware callback
     */
    var throwError = function(res, code, msg, next) {

        var withViews       = local.hasViews[self.appName] || hasViews(self.appName);
        var isUsingTemplate = self.conf[self.appName][self.env].template;
        var isXMLRequest    = local.request.isXMLRequest;
        var protocol        = getResponseProtocol(res);
        var stream          = ( /http\/2/.test(protocol) && res.stream ) ? res.stream : null;
        var header          = ( /http\/2/.test(protocol) && res.stream ) ? {} : null;
        var err             = null;
        var bundleConf      = self.conf[self.appName][self.env];
        var _h1ContentType  = null;

        // #ERRREF — incident ref + the ONE full-detail pairing line, EVERY scope.
        // The ref is a short random correlation code returned as a top-level
        // `ref` field on every JSON error body in ALL scopes (it carries no
        // server detail — the egress gate below keeps protecting the wire);
        // this line pairs it with the FULL error (message + stack + cause) and
        // the request's correlation id (#M12b/#COMPLY2) BEFORE the gate strips
        // the wire copy, so a user-relayed ref greps to the exact failure in
        // any scope, production included. Consolidates the two former in-gate
        // log emits + the per-branch summary lines (one line per thrown error
        // instead of two). Honours a relay-safe caller-supplied ref (msg.ref,
        // or the 1-arg errorObject shape's ref). Kept in sync with the
        // controller-side throwError twin (core/controller/controller.js).
        var ref = _mintErrorRef(
            ( msg && typeof(msg) == 'object' && msg.ref )
                ? msg.ref
                : ( typeof(code) == 'object' && code && code.ref ) ? code.ref : undefined
        );
        var _errSubject = ( typeof(msg) != 'undefined' && msg !== null )
            ? msg
            : ( typeof(code) == 'object' && code ) ? code : msg;
        var _errDetail  = '';
        if ( typeof(_errSubject) == 'string' ) {
            _errDetail = _errSubject;
        } else if ( _errSubject && typeof(_errSubject) == 'object' ) {
            try {
                _errDetail = _errSubject.stack || _errSubject.message || JSON.stringify(_errSubject);
            } catch (_refJsonErr) {
                _errDetail = String(_errSubject);
            }
            if ( _errSubject.cause ) {
                _errDetail += '\ncaused by: '+ ( _errSubject.cause.stack || _errSubject.cause.message || _errSubject.cause );
            }
        }
        var _displayCode = ( typeof(code) == 'object' && code && typeof(code.status) != 'undefined' ) ? code.status : code;
        console.error('[ BUNDLE ][ '+ self.appName +' ][ ref '+ ref +' ][ req '+ ( local.request._ginaReqId || '-' ) +' ] '+ local.request.method +' [ '+ _displayCode +' ] '+ local.request.url + ( _errDetail ? '\n'+ _errDetail : '' ));

        // #B131 — scope-gated stack egress. Feeders (router.js action/middleware
        // catches, server.js internals) pass `err.stack` pre-flattened as `msg`,
        // so outside local scope every emit below (the JSON XHR/API branches, the
        // inline HTML fallback, the custom-error page data built from `err`) would
        // carry absolute framework paths + stack frames to HTTP clients. Outside
        // local scope: send the message line only / strip the field — the full
        // text is captured in EVERY scope by the #ERRREF pairing line above,
        // keyed by the ref the client receives. Local scope stays byte-identical
        // on the wire — the dev toolbar reads the
        // stack. The gate reads self.isLocalScope() — the same NODE_SCOPE_IS_LOCAL
        // env read as controller.js's module-level scope cache (both set once at
        // gna.js bootstrap), so the server-side and controller-side throwError
        // gates can never disagree. bundleConf.server.scopeIsLocal was rejected:
        // it derives from projects.json def_scope (config.js), which can lag the
        // RUNTIME scope of a boot started with an explicit NODE_SCOPE/--scope.
        var sanitizeWireError = function(m, c) {
            if ( self.isLocalScope() ) {
                return m;
            }
            // #ERRREF — the full text (stack included) is logged by the pairing
            // line at throwError entry, in every scope; this gate only shapes
            // the WIRE copy now.
            if ( typeof(m) == 'string' && /\n\s+at\s/.test(m) ) {
                return m.split('\n')[0];
            }
            if ( m && typeof(m) == 'object' && typeof(m.stack) != 'undefined' ) {
                m = JSON.clone(m);
                delete m.stack;
            }
            return m;
        };
        msg = sanitizeWireError(msg, code);

        if ( typeof(msg) != 'object' ) {
            err = {
                code    : code,
                message : msg
            }
        } else {
            err = JSON.clone(msg);
        }

        if (!res.headersSent) {
            // res.headersSent = true;
            local.request = checkPreflightRequest(local.request, local.response);
            // updated filter on controller.js : 2020/09/25
            //if (isXMLRequest || !withViews || !isUsingTemplate ) {
            if (isXMLRequest || !withViews || !isUsingTemplate || withViews && !isUsingTemplate ) {
                // allowing this.throwError(err)
                if ( typeof(code) == 'object' && !msg && typeof(code.status) != 'undefined' && typeof(code.error) != 'undefined' ) {
                    msg     = code.error;
                    code    = code.status;
                    // #B131 — the 1-arg errorObject shape lands `msg` after the
                    // top-of-function gate already ran; sanitize the reshaped value too.
                    msg     = sanitizeWireError(msg, code);
                }

                // Internet Explorer override
                if ( /msie/i.test(local.request.headers['user-agent']) ) {
                    if ( /http\/2/.test(protocol) && stream ) {
                        header = {
                            ':status': code,
                            'content-type': 'text/plain; charset='+ bundleConf.encoding
                            //'content-type': bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding
                        };
                    } else {
                        _h1ContentType = 'text/plain; charset='+ bundleConf.encoding;
                    }

                } else {
                    if ( /http\/2/.test(protocol) && stream ) {
                        header = {
                            ':status': code,
                            'content-type': 'application/json; charset='+ bundleConf.encoding
                        };
                    } else {
                        _h1ContentType = 'application/json; charset='+ bundleConf.encoding;
                    }
                }

                // #ERRREF — the request summary previously logged here is
                // carried by the pairing line at throwError entry.

                // The HTTP/1.1 flush must come AFTER completeHeaders: writeHead marks
                // headers as sent and completeHeaders' header loop is
                // `!response.headersSent`-guarded, so a writeHead-first order turns the
                // env.json `server.response.header` overrides into a no-op on error
                // responses (the HTTP/2 branch already merges them into the headers
                // object passed to stream.respond).
                header = completeHeaders(header, local.request, res);
                if ( /http\/2/.test(protocol) && stream) {
                    stream.respond(header);
                    stream.end(JSON.stringify({
                        status: code,
                        error: msg,
                        ref: ref
                    }));

                } else {
                    res.writeHead(code, { 'content-type': _h1ContentType } );
                    res.end(JSON.stringify({
                        status  : code,
                        error   : msg,
                        ref     : ref
                    }));
                }
                return;

            } else {

                // #ERRREF — the summary + sanitized-msg line previously logged
                // here is superseded by the full-detail pairing line at
                // throwError entry (which carries the pre-sanitize text + ref).
                // intercept none HTML mime types
                // #B30: throwError is the central error responder, reached synchronously from many
                // request callbacks; an unguarded decodeURI of a malformed-% URL here throws URIError →
                // proc.js uncaughtException handler (proc.js:319) → emerg + SIGTERM → the bundle dies
                // (it even turns a would-be graceful 404 on a malformed-% URL into a crash).
                // safeDecodeURI falls back to the raw URL.
                // was: var url = decodeURI(local.request.url) /// avoid %20
                var url                     = safeDecodeURI(local.request.url) /// avoid %20
                    , ext                   = null
                    , isHtmlContent         = false
                    , hasCustomErrorFile    = false
                    , eCode                 = code.toString().substring(0,1) + 'xx'
                ;
                var extArr = url.substring(url.lastIndexOf('.')).match(/(\.[A-Za-z0-9]+)/);
                if (extArr) {
                    ext = extArr[0].substring(1);
                }
                if ( !ext || /^(html|htm)$/i.test(ext) ) {
                    isHtmlContent = true;
                }

                if (
                    isHtmlContent
                    && typeof(bundleConf.content.templates._common.errorFiles) != 'undefined'
                    && typeof(bundleConf.content.templates._common.errorFiles[code]) != 'undefined'
                    ||
                    isHtmlContent
                    && typeof(bundleConf.content.templates._common.errorFiles) != 'undefined'
                    && typeof(bundleConf.content.templates._common.errorFiles[eCode]) != 'undefined'
                ) {
                    hasCustomErrorFile = true;

                    var eFilename   = null
                        , eData     = {
                            isRenderingCustomError  : true,
                            bundle                  : self.appName,
                            status                  : code || null,
                            message                 : msg || null,
                            pathname                : url,
                            // #ERRREF — the custom error template can render
                            // the same ref the JSON wire carries
                            ref                     : ref
                        }
                    ;

                    if ( typeof(err) == 'object' && err.count() > 0 ) {
                        if ( typeof(err.stack)  != 'undefined' ) {
                            eData.stack = err.stack
                        }
                        if ( !eData.message && typeof(err.message) != 'undefined' ) {
                            eData.message = err.message
                        }
                    }
                    if (
                        code
                        // See: framework/${version}/core/status.code
                        && typeof(bundleConf.server.coreConfiguration.statusCodes[code]) != 'undefined'
                    ) {
                        eData.title = bundleConf.server.coreConfiguration.statusCodes[code];
                    }

                    if ( typeof(local.request.routing) != 'undefined' ) {
                        eData.routing = local.request.routing;
                    }

                    if (typeof(bundleConf.content.templates._common.errorFiles[code]) != 'undefined') {
                        eFilename = bundleConf.content.templates._common.errorFiles[code];
                    } else {
                        eFilename = bundleConf.content.templates._common.errorFiles[eCode];
                    }

                    var eRule = 'custom-error-page@'+ self.appName;
                    var routeObj = routingLib.getRoute(eRule);
                    routeObj.rule = eRule;
                    routeObj.url = url;
                    routeObj.param.title = ( typeof(eData.title) != 'undefined' ) ? eData.title : 'Error ' + eData.status;
                    routeObj.param.file = eFilename;
                    routeObj.param.error = eData;
                    routeObj.param.displayInspector = self.isCacheless();

                    local.request.routing = routeObj;

                    var hasMiddlewareException = null;
                    for (let i=0, len = __stack.length; i<len; i++) {
                        let c = __stack[i].getFunctionName() || null;
                        if ( /processMiddlewares/.test(c) ) {
                            hasMiddlewareException = true;
                            break;
                        }
                    }
                    if ( !hasMiddlewareException ) {
                        var router = local.router;
                        if ( typeof(router._server) == 'undefined' ) {
                            router._server = self.instance;
                        }
                        router.route(local.request, res, next, local.request.routing);

                        return;
                    }
                    hasMiddlewareException = null;
                    // TODO - Instead of setting `hasCustomErrorFile` to false, compile custom error page with:
                    // JSON.stringify({
                    //     status  : code,
                    //     error   : msg
                    // })
                    hasCustomErrorFile = false;
                }

                if ( /http\/2/.test(protocol) && stream ) {
                    header = {
                        ':status'       : code,
                        'content-type'  : bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding
                    };
                } else {
                    // flushed by the writeHead AFTER completeHeaders below — same
                    // ordering constraint as the sibling XHR/JSON branch above
                    _h1ContentType = bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding;
                }

                header = completeHeaders(header, local.request, res);
                if ( /http\/2/.test(protocol) && stream ) {
                    // #H2 — guard against writing to a stream that was already closed/destroyed
                    if (stream.destroyed || stream.closed) { return; }
                    stream.respond(header);
                    if ( isHtmlContent && !hasCustomErrorFile ) {
                        // #A11Y3 — the body previously opened two `<pre>` elements and closed
                        // only one, inside a document with no doctype, head, title or lang.
                        stream.end(a11yErrorDocument(code, '<h1>Error '+ code +'.</h1><pre>'+ msg + '\n\nref '+ ref +'</pre>', local.request));
                    } else {
                        stream.end(JSON.stringify({
                            status  : code,
                            error   : msg,
                            ref     : ref
                        }));
                    }
                } else {
                    res.writeHead(code, { 'content-type': _h1ContentType } );
                    if ( isHtmlContent && !hasCustomErrorFile ) {
                        // #A11Y3 — this branch additionally closed `<body>` with an OPENING
                        // `<html>` tag, so the document never terminated. Same fix as the
                        // HTTP/2 branch above; both now share one document builder.
                        res.end(a11yErrorDocument(code, '<h1>Error '+ code +'.</h1><pre>'+ msg + '\n\nref '+ ref +'</pre>', local.request));
                    } else {
                        res.end(JSON.stringify({
                            status  : code,
                            error   : msg,
                            ref     : ref
                        }))
                    }
                }
                return;
            }

        } else {
            if ( typeof(next) != 'undefined' )
                next();
            return;
        }
    }
};

Server = inherits(Server, EventEmitter);
module.exports = Server