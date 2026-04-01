const fs = require('fs');

const lib               = require('./../../lib') || require.cache[require.resolve('./../../lib')];
const Collection        = lib.Collection;
const cache             = new lib.Cache();
var statusCodes         = requireJSON( _( getPath('gina').core + '/status.codes') );

// Inherited from controller
var self                = null
    , local             = null
    , headersSent       = null
    , cachePath         = null
;


/**
 * Write the rendered JSON to the cache store (memory or file system).
 * No-op when caching is disabled or the route has no `cache` setting.
 * FS writes are performed asynchronously to avoid blocking the event loop.
 *
 * @inner
 * @param {string} bundle      - Bundle name (used as cache-key namespace)
 * @param {object} opt         - Server cache configuration (`opt.path`, `opt.ttl`)
 * @param {string} jsonContent - Serialised JSON string to cache
 * @returns {Promise<void>}
 */
async function writeCache(bundle, opt, jsonContent) {
    if (
        typeof(local.req.routing.cache) == 'undefined'
        ||
        ! local.req.routing.cache
        ||
        ! /^true$/i.test(self.serverInstance._cacheIsEnabled)
    ) {
        return;
    }
    // before: "data:" + local.req.originalUrl  (#C3 — added bundle namespace to prevent silent collisions when two bundles serve the same URL path)
    var cacheKey = "data:" + bundle + ":" + local.req.originalUrl;
    var responseHeaders = local.res.getHeaders() || {};

    // Caching kinds are: `memory` & `fs`
    var cachingOption = ( typeof(local.req.routing.cache) == 'string' ) ? { type: local.req.routing.cache } : JSON.clone(local.req.routing.cache);
    if ( typeof(cachingOption.ttl) == 'undefined' ) {
        cachingOption.ttl = opt.ttl
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
    // Caching to `memory`
    // Use this method carefully since it can lead to memory overflow:
    // - only for most visited static content
    // - avoid content linked to sessions
    // - default ttl is 3600 sec
    if ( /^memory$/i.test(cachingOption.type) ) {
        cacheObject.fromMemory = true;
        // content is mandatory here
        cacheObject.content = jsonContent;

        cache.set(cacheKey, cacheObject);
    }

    // Caching to `fs` (file system)
    // Use this method for most of your needs:
    // - prioritize content linked to sessions
    // - default ttl is 3600 sec
    if ( /^fs$/i.test(cachingOption.type) ) {
        var url = local.req.originalUrl;
        if ( /\/$/.test(url) ) {
            url += 'index'
        }
        var jsonFilename = _(opt.path +'/'+ bundle +'/data'+ url + '.json', true);
        var jsonDir = jsonFilename.split(/\//g).slice(0, -1).join('/');
        var jsonDirObj = new _(jsonDir);
        if ( !jsonDirObj.existsSync() ) {
            jsonDirObj.mkdirSync()
        }
        jsonDirObj = null;

        // console.debug("Writting cache to: ", jsonFilename);
        // replaced: sync fs.openSync/writeSync/closeSync — blocks event loop
        await fs.promises.writeFile(jsonFilename, jsonContent);

        // filename is mandatory here
        cacheObject.filename = jsonFilename;

        // cleanupFn: delete the cached file from disk when the entry is evicted
        cache.set(cacheKey, cacheObject, function() {
            try { fs.rmSync(cacheObject.filename); } catch(e) {}
        });
    }

    // Invalidation
    if ( typeof(cachingOption.invalidateOnEvents) != 'undefined' ) {
        if ( !Array.isArray(cachingOption.invalidateOnEvents) ) {
            return self.throwError(local.res, 500, new Error('cache.invalidateOn must be an array'));
        }
        // Placing event listeners
        cache.setEvents(cacheKey, cachingOption.invalidateOnEvents);
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
    // Inherited from controller
    self            = deps.self;
    local           = deps.local;
    headersSent     = deps.headersSent;

    // preventing multiple call of self.renderJSON() when controller is rendering from another required controller
    if (local.options.renderingStack.length > 1) {
        return false
    }
    if ( self.isProcessingError ) {
        return;
    }

    // Using server cache to cache compiledTemplates
    cache.from(self.serverInstance._cached);
    cachePath       = self.serverInstance._cachePath;

    var request     = local.req;
    var response    = local.res;
    var next        = local.next || null;
    var stream      = null;
    if ( typeof(local.res.stream) != 'undefined') {
        stream = local.res.stream
    }

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
        if (
            typeof(jsonObj.errno) != 'undefined' && response.statusCode == 200
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
                // HTTP/2 (RFC7540 8.1.2.4):
                // This standard for HTTP/2 explicitly states that status messages are not supported.
                // In HTTP/2, the status is conveyed solely by the numerical status code (e.g., 200, 404, 500),
                // and there is no field for a human-readable status message.
                if ( !/http\/2/.test(local.options.conf.server.protocol) ) {
                    response.statusMessage = err.stack;
                }
            }
        }



        console.info(request.method +' ['+ response.statusCode +'] '+ request.url);

        var data = JSON.stringify(jsonObj);

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
        // E.g.: Caching result for document-get-all@coreapi
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
            writeCache(self._options.bundle, local.options.conf.server.cache, data).catch(function(err) {
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
                    ':status': 200
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
                stream.respond(_streamHeaders);
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