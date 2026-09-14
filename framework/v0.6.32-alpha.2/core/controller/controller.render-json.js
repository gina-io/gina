const fs = require('fs');

const lib               = require('./../../lib') || require.cache[require.resolve('./../../lib')];
// #B433 hardening — bind the logger explicitly. Until now this file reached it
// only because lib/routing reassigns the global at require time; an explicit
// binding keeps every log line here on the redacting, container-dispatched
// writer regardless of that side effect.
var console             = lib.logger;
const Collection        = lib.Collection;
const renderCache       = new lib.RenderCache();
var statusCodes         = requireJSON( _( getPath('gina').core + '/status.codes') );
// Inspector secret redaction (dev-mode only — never touches the actual response body)
var inspectorRedact     = require('lib/inspector-redact');

// Inherited from controller.
// #B63 (sibling of the render-swig #B61 / render-stream #B62 race fixes):
// the per-request deps are FUNCTION-scoped inside renderJSON() and threaded
// into the module-level writeCache() as parameters — nothing per-request
// lives at module scope. In prod this module is a shared singleton across
// concurrent requests; a module-scoped capture is reassigned by every
// incoming renderJSON, so writeCache resumed after its writeFile await
// reading a CONCURRENT request's controller (measured: the cache-config
// error path reported through the other request's throwError).


/**
 * Write the rendered JSON to the cache store (memory or file system).
 * No-op when caching is disabled or the route has no `cache` setting.
 * FS writes are performed asynchronously to avoid blocking the event loop.
 *
 * @inner
 * @param {string} bundle      - Bundle name (used as cache-key namespace)
 * @param {object} opt         - Server cache configuration (`opt.path`, `opt.ttl`, `opt.sliding`, `opt.maxAge`)
 * @param {string} jsonContent - Serialised JSON string to cache
 * @param {object} req         - Per-request request captured by renderJSON (race-safe)
 * @param {object} res         - Per-request response captured by renderJSON (race-safe)
 * @param {boolean|string} cacheIsEnabled - Server-level cache flag threaded by renderJSON
 * @param {function} throwError - Render-scoped controller `throwError` (closure-bound), threaded
 *                               for the `invalidateOnEvents` validation branch
 * @returns {Promise<void>}
 */
// Every render-scoped value is threaded as a parameter — writeCache is
// module-level and must not read the per-request bindings, which are
// function-scoped inside renderJSON (#B63). The post-await throwError uses
// the captured `res` so it never dereferences a nulled `local.res`, and the
// captured `throwError` so a concurrent renderJSON entering during the
// writeFile await can never re-route this request's error reporting.
async function writeCache(bundle, opt, jsonContent, req, res, cacheIsEnabled, throwError) {
    if (
        typeof(req.routing.cache) == 'undefined'
        ||
        ! req.routing.cache
        ||
        ! /^true$/i.test(cacheIsEnabled)
        ||
        // #B158 — a gated route is never stored: the key carries no principal and
        // both serve points run before the gate. Full rationale on isRouteGated.
        lib.authzGate.isRouteGated(req)
    ) {
        return;
    }
    // Fully-namespaced key via the single builder (#C3 bundle namespace +
    // the release namespace both live in renderCache.buildKey — writer/reader
    // share ONE format so they can't drift).
    var cacheKey = renderCache.buildKey('data', bundle, req.originalUrl);
    var responseHeaders = res.getHeaders() || {};

    // Caching kinds are: `memory` & `fs`
    var cachingOption = ( typeof(req.routing.cache) == 'string' ) ? { type: req.routing.cache } : JSON.clone(req.routing.cache);
    if ( typeof(cachingOption.ttl) == 'undefined' ) {
        cachingOption.ttl = opt.ttl
    }
    // Inherit the bundle-wide default strategy (server.cache.type) when the
    // route omits `type` — mirrors the ttl fallback above. Stays undefined
    // (→ not cached, unchanged) when neither the route nor server.cache sets it.
    if ( typeof(cachingOption.type) == 'undefined' ) {
        cachingOption.type = opt.type;
    }
    // Inherit bundle-wide sliding / maxAge defaults from server.cache when
    // the route omits them (mirrors the ttl fallback above). Per-route values
    // always win — an explicit `sliding: false` overrides a bundle-wide `true`.
    if ( typeof(cachingOption.sliding) == 'undefined' && typeof(opt.sliding) != 'undefined' ) {
        cachingOption.sliding = opt.sliding;
    }
    if ( typeof(cachingOption.maxAge) == 'undefined' && typeof(opt.maxAge) != 'undefined' ) {
        cachingOption.maxAge = opt.maxAge;
    }
    var cacheObject = {
        responseHeaders : responseHeaders
    };
    // Store visibility for Cache-Control header on the hit path.
    // Default is 'private' — opt in to 'public' explicitly for truly static pages.
    cacheObject.visibility = ( cachingOption.visibility === 'public' ) ? 'public' : 'private';
    if ( cachingOption.ttl > 0) {
        cacheObject.ttl = cachingOption.ttl;
    }
    // Sliding window (opt-in, default false).
    // When true, ttl becomes the idle eviction threshold (seconds since last access)
    // rather than an absolute duration from creation.
    if ( cachingOption.sliding === true ) {
        cacheObject.sliding = true;
    }
    // Absolute expiration ceiling — only meaningful when sliding is enabled.
    // The entry is evicted at createdAt + maxAge regardless of access patterns.
    if ( cacheObject.sliding && typeof(cachingOption.maxAge) != 'undefined' && cachingOption.maxAge > 0 ) {
        cacheObject.maxAge = cachingOption.maxAge;
    }
    // Store via the render-cache strategy dispatcher (memory | fs). The
    // memory/fs storage detail lives in lib/render-cache so all three
    // render delegates + the server read path share one backend seam.
    await renderCache.set(cachingOption.type, cacheKey, cacheObject, {
        content : jsonContent,
        path    : opt.path,
        bundle  : bundle,
        url     : req.originalUrl,
        kind    : 'data'
    });

    // Invalidation
    if ( typeof(cachingOption.invalidateOnEvents) != 'undefined' ) {
        if ( !Array.isArray(cachingOption.invalidateOnEvents) ) {
            // #M1/#B63 — this resume point sits after the render-cache write await:
            // both the response AND the reporting controller come from the
            // threaded parameters (renderJSON's captures), never from the
            // module scope a concurrent request may have moved on from.
            return throwError(res, 500, new Error('cache.invalidateOn must be an array'));
        }
        // Placing event listeners. Awaited: setEvents also persists the events into
        // the `fs` sidecar, so a restart's disk read-back can restore them.
        await renderCache.setEvents(cacheKey, cachingOption.invalidateOnEvents);
    }
}

/**
 * Render JSON
 *
 * Serialises `jsonObj` to JSON, sets appropriate content-type headers,
 * writes the response, and nulls per-request refs on every exit path.
 *
 * @param {object|string} jsonObj     - Data to serialise. Parsed if passed as a string.
 * @param {object}        deps        - Inherited refs from SuperController
 * @param {object}        deps.self   - The SuperController instance
 * @param {object}        deps.local  - Per-request closure (`req`, `res`, `next`, `options`)
 * @param {function}      deps.headersSent  - Returns `true` when response headers are already sent
 * @returns {void}
 */
module.exports = function renderJSON(jsonObj, deps) {
    // Inherited from controller — function-scoped (#B63): a concurrent
    // renderJSON must not reassign this render's captures while its
    // fire-and-forget writeCache is suspended at the writeFile await.
    var self            = deps.self;
    var local           = deps.local;
    var headersSent     = deps.headersSent;

    // preventing multiple call of self.renderJSON() when controller is rendering from another required controller
    if (local.options.renderingStack.length > 1) {
        return false
    }
    if ( self.isProcessingError ) {
        return;
    }

    // #B36 — released-response guard: a terminal exit (e.g. redirect-then-continue,
    // which nulls local.req/res/next then lets the middleware chain continue) leaves
    // local.res null; the synchronous `local.res.stream` read below would then crash
    // the bundle (uncaughtException → SIGTERM, the #B31/#B33/#B35 class). There is
    // nothing to render to a response that was already sent/released.
    if ( local.res == null ) {
        return;
    }

    // Point the render-cache dispatcher at the server's shared in-memory store.
    renderCache.from(self.serverInstance._cached);

    var request     = local.req;
    var response    = local.res;
    var next        = local.next || null;
    var stream      = null;
    if ( typeof(local.res.stream) != 'undefined') {
        stream = local.res.stream
    }
    // #H10 — opt-in HTTP/2 response trailers (registered via self.sendTrailers()).
    var _trailers   = (local._trailers && typeof(local._trailers) === 'object') ? local._trailers : null;

    if (!jsonObj) {
        jsonObj = {}
    }

    try {
        // Just in case
        if ( typeof(jsonObj) == 'string') {
            jsonObj = JSON.parse(jsonObj)
        }


        // Internet Explorer override
        if ( /msie/i.test(request.headers['user-agent']) ) {
            response.setHeader('content-type', 'text/plain' + '; charset='+ local.options.conf.encoding)
        } else {
            response.setHeader('content-type', local.options.conf.server.coreConfiguration.mime['json'] + '; charset='+ local.options.conf.encoding)
        }


        //catching errors
        // #B172 rider — the errno half carries the same statusCodes[...] guard as
        // its render-swig/render-v1 siblings: an errno-only payload (no usable
        // `status`) used to enter the branch and assign statusCode = undefined,
        // which the HTTP/1.1 response.end() below rejects (the empty catch then
        // swallows it — the response was never sent) and the HTTP/2 statusCode
        // setter throws on. Guarded, such a payload is served as a normal 200
        // with the payload in the body — measured wire-identical to dropping
        // the errno clause on every input.
        if (
            typeof(jsonObj.errno) != 'undefined' && response.statusCode == 200
                && typeof(local.options.conf.server.coreConfiguration.statusCodes[jsonObj.status]) != 'undefined'
            ||
            typeof(jsonObj.status) != 'undefined' && jsonObj.status != 200
                && typeof(local.options.conf.server.coreConfiguration.statusCodes[jsonObj.status]) != 'undefined'
        ) {

            try {
                response.statusCode    = jsonObj.status;
                // HTTP/2 (RFC7540 8.1.2.4):
                // This standard for HTTP/2 explicitly states that status messages are not supported.
                // In HTTP/2, the status is conveyed solely by the numerical status code (e.g., 200, 404, 500),
                // and there is no field for a human-readable status message.
                if ( !/http\/2/.test(local.options.conf.server.protocol) ) {
                    response.statusMessage = local.options.conf.server.coreConfiguration.statusCodes[jsonObj.status];
                }
            } catch (err){
                response.statusCode    = 500;
                // #B131 — the reason phrase must be a short single line: a multi-line
                // stack is invalid on the HTTP/1.1 status line (Node rejects the write)
                // and would leak internal paths + frames to the client. The stack goes
                // to the server log instead.
                console.error('[ RENDER-JSON ] status resolution failed: ', err.stack||err.message||err);
                // HTTP/2 (RFC7540 8.1.2.4):
                // This standard for HTTP/2 explicitly states that status messages are not supported.
                // In HTTP/2, the status is conveyed solely by the numerical status code (e.g., 200, 404, 500),
                // and there is no field for a human-readable status message.
                if ( !/http\/2/.test(local.options.conf.server.protocol) ) {
                    response.statusMessage = err.message || 'Internal Server Error';
                }
            }
        }



        console.info(request.method +' ['+ response.statusCode +'] '+ request.url);

        // #FI — push response-write + total timing to the timeline so the
        // Flow waterfall has closing bars for JSON responses.
        // #INS10 — also during a prod instrumentation window (window-only in prod).
        if (((process.gina && process.gina._inspectorWindowUntil > Date.now()) || (self.isCacheless() && process.gina._inspectorActive)) && local._timeline) {
            var _jsonRespEnd = Date.now();
            var _jsonRwStart = local._timeline._renderStart || local._timeline._actionStart || local._timeline.requestStart;
            local._timeline.entries.push({
                label    : 'response-write',
                cat      : 'response',
                startMs  : _jsonRwStart,
                endMs    : _jsonRespEnd,
                durationMs : _jsonRespEnd - _jsonRwStart,
                detail   : null
            });
            local._timeline.entries.push({
                label    : 'total',
                cat      : 'total',
                startMs  : local._timeline.requestStart,
                endMs    : _jsonRespEnd,
                durationMs : _jsonRespEnd - local._timeline.requestStart,
                detail   : null
            });
        }

        // #INS — emit Inspector payload for JSON responses so the Inspector
        // Data tab, Flow tab, and footer status bar work for APIs that only
        // use self.renderJSON(). Gated on _inspectorActive to avoid overhead
        // when the Inspector has not been opened.
        // #INS10 — also emit over the authenticated agent SSE during a prod window.
        if ((process.gina && process.gina._inspectorWindowUntil > Date.now()) || (self.isCacheless() && process.gina._inspectorActive)) {
            var _ctx = getContext('gina') || {};
            var _conf = local.options.conf || {};
            var _mem = process.memoryUsage();
            var _env = {
                'gina'           : _ctx.version || '',
                'gina pid'       : getEnvVar('GINA_PID') || String(process.pid),
                'nodejs'         : process.versions.node + ' ' + process.platform + ' ' + process.arch,
                'engine'         : (_conf.server && _conf.server.engine) || '',
                'env'            : process.env.NODE_ENV || '',
                'envIsDev'       : self.isCacheless(),
                'scope'          : process.env.NODE_SCOPE || '',
                'bundle'         : _conf.bundle || '',
                'project'        : _conf.projectName || '',
                'protocol'       : (_conf.server && _conf.server.protocol) || '',
                'scheme'         : (_conf.server && _conf.server.scheme) || '',
                'port'           : (_conf.server && _conf.server.port) || '',
                'webroot'        : (_conf.server && _conf.server.webroot) || '',
                'memory heap'    : (_mem.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
                'memory allocated': (require('v8').getHeapStatistics().heap_size_limit / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
                'date.now'       : new Date().toISOString(),
                'pid'            : process.pid
            };
            var _gdUser = {
                environment : _env,
                data        : jsonObj
            };
            if (local._queryLog && local._queryLog.length > 0) {
                _gdUser.queries = local._queryLog;
            }
            // #AISTREAM — AI token-stream snapshot (per-request attribution +
            // persistence) alongside queries/flow; the live view rides inspector#token.
            if (local._aiLog && local._aiLog.length > 0) {
                _gdUser.aiStream = local._aiLog;
            }
            // #EVTBUS — observable application-event snapshot; the live view rides inspector#event.
            if (local._eventLog && local._eventLog.length > 0) {
                _gdUser.events = local._eventLog;
            }
            if (local._timeline) {
                _gdUser.flow = {
                    requestStart : local._timeline.requestStart,
                    entries      : local._timeline.entries
                };
            }
            // #R7 — redact secret-looking fields from the Inspector clone before
            // any sink (engine.io push, /_gina/agent SSE). The actual response
            // body `jsonObj` is never touched — `redact()` returns a deep clone.
            // The resolved redact config is exposed under `gina.inspectorRedact`
            // so the standalone Inspector can mirror the same rules client-side.
            var _jsonRedactConf = inspectorRedact.getConfig(local.options.conf);
            // #INS8 — expose the standalone Inspector URL (null when unset).
            var _jsonInspUrl = null;
            try {
                var _jsonConfSource = local.options.conf || {};
                if (_jsonConfSource.content && _jsonConfSource.content.settings
                    && _jsonConfSource.content.settings.inspector
                    && _jsonConfSource.content.settings.inspector.url) {
                    _jsonInspUrl = _jsonConfSource.content.settings.inspector.url;
                }
            } catch (e) { /* leave null */ }
            var __gdPayload = {
                gina : { environment: _env, inspectorRedact: {
                    patterns    : _jsonRedactConf.patterns,
                    types       : _jsonRedactConf.types,
                    replacement : _jsonRedactConf.replacement
                }, inspectorUrl: _jsonInspUrl },
                user : _gdUser
            };
            // #R7 — JSON renders do NOT write _lastGinaDataUnredacted. The
            // Reveal UX unmasks the Data tab, which always shows the HTML
            // render payload (sourced from window.opener.__ginaData). JSON
            // polling endpoints would otherwise clobber the HTML snapshot
            // with tiny session/ping payloads between page load and click.
            // Only render-swig.js writes the unredacted slot.
            __gdPayload = inspectorRedact.redact(__gdPayload, {
                compiledPatterns : _jsonRedactConf.compiledPatterns,
                replacement      : _jsonRedactConf.replacement
            });
            self.serverInstance._lastGinaData = __gdPayload;
            process.emit('inspector#data', __gdPayload);
        }

        // #QI — embed query log as a sidecar for cross-bundle propagation.
        // When bundle A calls bundle B via self.query(), B's queries travel
        // back as __ginaQueries in the JSON response body. A's query()
        // callback extracts, merges into its own _queryLog, and deletes
        // the field before the data reaches the controller action.
        // #INS10 — in a prod window, attach the RAW cross-bundle query sidecar ONLY when the
        // request came from an internal caller (inbound x-gina-inspector header) that will
        // strip it (controller.js extract path); never to an external client. Dev unchanged.
        if ((self.isCacheless() || ((process.gina && process.gina._inspectorWindowUntil > Date.now()) && request && request.headers && request.headers['x-gina-inspector'] === 'true')) && local._queryLog && local._queryLog.length > 0) {
            jsonObj.__ginaQueries = local._queryLog;
        }

        // #FI — embed timeline entries as a sidecar for cross-bundle flow
        // propagation (mirrors __ginaQueries pattern).
        // #INS10 — same internal-caller gating as __ginaQueries above (no external leak in a window).
        if ((self.isCacheless() || ((process.gina && process.gina._inspectorWindowUntil > Date.now()) && request && request.headers && request.headers['x-gina-inspector'] === 'true')) && local._timeline && local._timeline.entries && local._timeline.entries.length > 0) {
            jsonObj.__ginaFlow = local._timeline.entries;
        }

        // #DTO2 — response DTO. A route shapes its JSON with `param.responseDto`, naming
        // the same `dtos/<name>.js` module `bundle:openapi` embeds as the 200 schema and
        // `bundle:mcp` as the tool `outputSchema` — so the wire, the spec and the manifest
        // cannot drift. The DTO was resolved + registered at boot (core/server.js), so this
        // is an O(1) registry read.
        //
        // This is the ONE transform point: it sits above the single `JSON.stringify` below,
        // which feeds every body-write branch (http/2, http/1.1, xhr, HEAD content-length)
        // AND the cache write — so the cached body is DTO-shaped for free.
        //
        // Strip-only, and only on a 2xx: `response.statusCode` is already resolved above
        // (from jsonObj.errno / jsonObj.status), so an error payload is never mangled by a
        // success DTO. `DtoObject.apply()` keeps the `__gina*` sidecars attached just above.
        if (
            typeof(jsonObj) == 'object' && jsonObj !== null
            && response.statusCode >= 200 && response.statusCode < 300
            && local.req && local.req.routing && local.req.routing.param
            && typeof(local.req.routing.param.responseDto) == 'string'
            && local.req.routing.param.responseDto !== ''
        ) {
            var _respDto = lib.dto.get(local.req.routing.param.responseDto);
            if (_respDto) {
                if ( self.isCacheless() ) {
                    // Dev only: a declared-but-missing required field is a server bug the
                    // DTO would otherwise silently hide by projecting it away. Checked
                    // against the SERVED contract (`dropExcluded`, #B110): a required
                    // field that is also `.exclude()`d can never reach the wire, so the
                    // action omitting it is not a bug and must not warn.
                    var _respSchema  = _respDto.toJsonSchema(null, { dropExcluded: true });
                    var _respMissing = (_respSchema.required || []).filter(function (f) {
                        return ( typeof(jsonObj[f]) == 'undefined' );
                    });
                    if (_respMissing.length > 0) {
                        console.warn('[render-json] responseDto `'+ local.req.routing.param.responseDto +
                            '` declares required field(s) the payload does not carry: '+ _respMissing.join(', '));
                    }
                }
                jsonObj = _respDto.apply(jsonObj);
            } else {
                console.warn('[render-json] responseDto `'+ local.req.routing.param.responseDto +
                    '` is not registered — the payload is sent unshaped.');
            }
        }

        var data = JSON.stringify(jsonObj);

        // #FIN6 — record the response envelope for an idempotency-reserved
        // request (stamped by the router-band gate; absent on every other
        // request). Fire-and-forget: the send below never waits on the store
        // and record() owns its own rejection. Sits at the single stringify
        // choke point so every body-write branch sees the recorded body.
        if ( request._idemCapture ) {
            lib.idempotency.record(request, response, data);
        }

        // HEAD: send all response headers (including content-length reflecting what the body
        // would have been) but suppress the body itself. The controller action runs in full
        // so headers such as content-type, cache-control, and etag are set correctly.
        if ( /^HEAD$/i.test(request.method) ) {
            var headLen = Buffer.byteLength(data, 'utf8');
            if ( stream ) {
                if ( !stream.headersSent ) {
                    var _headH = {
                        'content-type'   : local.options.conf.server.coreConfiguration.mime['json'] + '; charset='+ local.options.conf.encoding,
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
                response.setHeader('content-type', local.options.conf.server.coreConfiguration.mime['json'] + '; charset='+ local.options.conf.encoding);
                response.setHeader('content-length', headLen);
                response.end();
            }
            local.req = null;
            local.res = null;
            local.next = null;
            return;
        }

        if ( local.options.isXMLRequest && self.isWithCredentials() )  {


            // content length must be the right size !
            var len = Buffer.byteLength(data, 'utf8') || 0;
            if ( !headersSent(response) ) {
                response.setHeader("content-length", len);
            }

            response.write(data);

            // required to close connection
            // return setTimeout(function () {
            //     // if (!headersSent()) {
            //         response.end();
            //         try {
            //             response.headersSent = true;
            //         } catch(err) {
            //             // Ignoring warning
            //             //console.warn(err);
            //         }

            //         if ( next ) {
            //             next()
            //         }

            //     // }
            // }, 200);

            // force completion
            // response.headersSent = true;
            // Release per-request refs — response/request/next are local copies so .end() below is unaffected.
            local.req = null;
            local.res = null;
            local.next = null;
            return response.end(data);
        }
        // normal case
        // E.g.: Caching result for document-get-all@api
        if (
            !self.isCacheless()
            && typeof(request.routing.cache) != 'undefined'
            && /^GET$/i.test(request.method)
            ||
            // allowing caching even for dev env
            /^true$/i.test(self.serverInstance._cacheIsEnabled)
            && typeof(request.routing.cache) != 'undefined'
            && /^GET$/i.test(request.method)
        ) {
            writeCache(self._options.bundle, local.options.conf.server.cache, data, request, response, self.serverInstance._cacheIsEnabled, self.throwError).catch(function(err) {
                console.error('[render-json] writeCache failed:', err);
            });
        }

        // Cache-Control: miss path — inform browsers/CDNs of the response lifetime (#C6)
        var _cc = null;
        if ( typeof(request.routing.cache) != 'undefined' && request.routing.cache ) {
            var _ccCfg = ( typeof(request.routing.cache) == 'string' ) ? { type: request.routing.cache } : request.routing.cache;
            var _ccTtl = ( typeof(_ccCfg.ttl) != 'undefined' && _ccCfg.ttl > 0 ) ? _ccCfg.ttl : local.options.conf.server.cache.ttl;
            if ( _ccTtl > 0 ) {
                _cc = ( _ccCfg.visibility === 'public' ? 'public' : 'private' ) + ', max-age=' + ~~(_ccTtl);
            }
        }

        if (  stream ) {
            // Guard: client may have disconnected (nginx timeout, browser navigation)
            // before the async callback (Couchbase, HTTP/2 upstream) completed.
            // stream.destroyed is true in that case — respond() would throw ERR_HTTP2_INVALID_STREAM.
            if (stream.destroyed || stream.closed) {
                console.warn('[render-json] Stream already destroyed — client disconnected before response was sent ('+ (request ? request.url : 'unknown') +')');
                local.req = null;
                local.res = null;
                local.next = null;
                return;
            }
            if (!stream.headersSent) {
                var _streamHeaders = {
                    'content-type': local.options.conf.server.coreConfiguration.mime['json'] + '; charset='+ local.options.conf.encoding,
                    // #B172 — honour the status resolved above (jsonObj.status →
                    // response.statusCode). This frame is built for the raw
                    // stream.respond(), which bypasses the compat layer, and the
                    // pending-header merge below cannot supply `:status`
                    // (setHeader(':status', …) throws ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED)
                    // — so a literal here silently served every JSON error as 200.
                    // Matches the HEAD branch above and the swig/nunjucks delegates.
                    ':status': response.statusCode || 200
                };
                if (_cc) _streamHeaders['cache-control'] = _cc;
                // Merge response headers pre-set earlier in the pipeline (e.g. CORS headers
                // written by completeHeaders() in handle()). stream.respond() on the raw
                // HTTP/2 stream does not include headers set via response.setHeader(), so
                // we pull them explicitly from getHeaders() and fold them in here.
                var _pendingHeaders = response.getHeaders ? response.getHeaders() : {};
                for (var _rhk in _pendingHeaders) {
                    if (!(_rhk in _streamHeaders)) _streamHeaders[_rhk] = _pendingHeaders[_rhk];
                }
                // #H10 — register the trailer flush, then defer the stream close via
                // waitForTrailers so the trailers follow the final DATA frame.
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
                // Internet Explorer override
                if ( /msie/i.test(request.headers['user-agent']) ) {
                    response.setHeader('content-type', 'text/plain' + '; charset='+ local.options.conf.encoding)
                } else {
                    response.setHeader('content-type', local.options.conf.server.coreConfiguration.mime['json'] + '; charset='+ local.options.conf.encoding)
                }
                if (_cc) response.setHeader('Cache-Control', _cc);
                response.end(data);
                response.headersSent = true;
                // Release per-request refs — response is a local copy so the .end() above is unaffected.
                local.req = null;
                local.res = null;
                local.next = null;
                return;
            } catch(err) {
                // Ignoring warning
                //console.warn(err);
            }
        }
        // Release per-request refs — next is a local copy so the call below is unaffected.
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