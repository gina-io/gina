"use strict";
/**
 * @module gina/core/server.isaac
 */
const fs                    = require('fs');
var _isDebugLog = function() {
    return process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
};
var _dbg = function(msg) {
    if (!_isDebugLog()) return;
    var d = new Date()
        , _m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        , p2 = function(n) { return (n < 10 ? '0' : '') + n; };
    fs.writeSync(2, '\u001b[90m[' + d.getFullYear() +' '+ _m[d.getMonth()] +' '+ p2(d.getDate())
        +' '+ p2(d.getHours()) +':'+ p2(d.getMinutes()) +':'+ p2(d.getSeconds())
        + '] [debug  ][gina:isaac] ' + msg + '\u001b[39m\n');
};
_dbg('isaac-req-1: fs ok');
const { execSync, exec }    = require('child_process');
_dbg('isaac-req-2: child_process ok');
const {EventEmitter}        = require('events');
_dbg('isaac-req-3: events ok');
_dbg('isaac-req-4: requiring engine.io...');
const Eio                   = require('engine.io');
_dbg('isaac-req-5: engine.io ok, requiring lib');
// const zlib                  = require('zlib'); // gzip / deflate

const lib               = require('./../lib');
const inherits          = lib.inherits;
const merge             = lib.merge;
const console           = lib.logger;
const Collection        = lib.Collection;
_dbg('isaac-req-6: cache');
const cache             = new lib.Cache();
_dbg('isaac-req-7: module-level done');


const env               = process.env.NODE_ENV
    , isDev             = process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true'
    , scope             = process.env.NODE_SCOPE
    , isLocalScope      = process.env.NODE_SCOPE_IS_LOCAL && process.env.NODE_SCOPE_IS_LOCAL.toLowerCase() === 'true'
    , isProductionScope = process.env.NODE_SCOPE_IS_PRODUCTION && process.env.NODE_SCOPE_IS_PRODUCTION.toLowerCase() === 'true'
;

/**
 * Reloads all core and lib modules from disk by replacing their require.cache
 * entries with fresh exports. Excludes gna.js itself. Also refreshes the
 * plugins index so the running instance picks up any hot-reloaded code.
 *
 * @memberof module:gina/core/server.isaac
 */
var refreshCore = function() {

    var corePath    = getPath('gina').core;
    var libPath     = getPath('gina').lib;

    // replaced: new RegExp(corePath) — use indexOf instead (#P4)
    var excluded    = [
        _(corePath + '/gna.js', true)
    ];

    for (let c in require.cache) {
        if ( c.indexOf(corePath) > -1 && excluded.indexOf(c) < 0 ) {
            require.cache[c].exports = require( _(c, true) )
        }
    }

    // Update lib & helpers
    delete require.cache[require.resolve(_(libPath +'/index.js', true))];
    require.cache[_(libPath +'/index.js', true)] = require( _(libPath +'/index.js', true) );
    require.cache[_(corePath + '/gna.js', true)].exports.lib = require.cache[_(libPath +'/index.js', true)];

    // Update plugins
    delete require.cache[require.resolve(_(corePath +'/plugins/index.js', true))];
    require.cache[_(corePath +'/plugins/index.js', true)] = require( _(corePath +'/plugins/index.js', true) );
    require.cache[_(corePath + '/gna.js', true)].exports.plugins = require.cache[_(corePath +'/plugins/index.js', true)];
}

// Express compatibility
const slice = Array.prototype.slice;


/**
 * Isaac server engine — Gina's built-in HTTP/1.1 and HTTP/2 server.
 * Creates an HTTP or HTTPS server (Node `http`, `https`, or `http2`),
 * sets up asset caching, routing cache, brotli/gzip compression detection,
 * and wires the `onPath` request handler.
 * Also attaches an optional engine.io WebSocket server when `options.ioServer` is defined.
 *
 * Returns `{ instance: server, middleware: middleware }`.
 *
 * @class ServerEngineClass
 * @constructor
 * @param {object} options - Bundle server configuration
 * @param {string} options.protocol - Protocol string (e.g. 'http/1.1', 'http/2')
 * @param {string} options.scheme - Scheme: 'http' or 'https'
 * @param {string} options.bundle - Bundle name
 * @param {string} options.cachePath - Absolute path to the bundle cache directory
 * @param {boolean} options.isCacheless - True in dev mode; clears local cache on startup
 * @param {object} options.credentials - TLS credentials (privateKey, certificate, ca, passphrase)
 * @param {object} options.allRoutes - Full routing map (used for frontend routing cache)
 * @param {string} options.preferedCompressionEncodingOrder - Ordered list of accepted encodings
 * @param {number} [options.keepAliveTimeout] - Server keep-alive timeout in ms
 * @param {number} [options.headersTimeout] - Server headers timeout in ms
 * @param {object} [options.ioServer] - engine.io server options; omit to disable WebSocket support
 * @returns {{ instance: object, middleware: function }} Configured Node server and middleware factory
 */
function ServerEngineClass(options) {

    console.debug('[ ENGINE ] Isaac says hello !');

    // TODO - See if it would be interesting to add it to Helper::Path & to extend it to also readdirSync, returning the directory content
    /**
     * Reads a file synchronously, resolving symlinks before reading.
     *
     * @inner
     * @private
     * @param {string} filename - Absolute path to the file (may be a symlink)
     * @returns {string} UTF-8 file contents
     */
    var readSync = function(filename) {
        var fileObj = new _(filename, true);
        if ( fileObj.isSymlinkSync() ) {
            filename = fileObj.getSymlinkSourceSync()
        }

        return fs.readFileSync(filename).toString()
    }

    var preferedEncoding    = options.preferedCompressionEncodingOrder
        , acceptEncodingArr = null
        , acceptEncoding    = null
    ;

    var localAssets             = null
        , cachedAssets          = null
        , cachePathObj          = null
        , localCachePathObj     = null
    ;
    try {

        // Adding cache directory if not found
        cachePathObj = new _(options.cachePath, true);
        localCachePathObj = new _(options.cachePath +'/'+ options.bundle, true);
        if ( !cachePathObj.existsSync() ) {
            cachePathObj.mkdirSync();
        }
        // Empty cache for cahceless envs
        if ( options.isCacheless && localCachePathObj.existsSync() ) {
            localCachePathObj.rmSync();
        }
        // For frontend template routing if needed
        // TODO - Used `options.routing` instead after having filtered `options.allRoutes` vs `options.formsRules` to use only external routes exposed by `"query"` validation
        // replaced: delete operator + for...in — destructuring rest builds clean objects (#P21, #P22)
        var _routing = JSON.clone(options.allRoutes);
        // var _routing = JSON.clone(options.routing);
        var _routingKeys = Object.keys(_routing);
        for (var ri = 0; ri < _routingKeys.length; ++ri) {
            const { _comment, middleware, ...clean } = _routing[_routingKeys[ri]];
            _routing[_routingKeys[ri]] = clean;

            // reverseRouting is done on the frontend side

        }// EO for routing keys

        // Checking if brotli is installed
        var brotliBin = null;
        try {
            brotliBin = execSync( 'which brotli' ).toString().trim();
        } catch (binErr) {
            // Means that it is not installed.
        }
        // Checking if gzip is installed
        var gZipBin = null;
        try {
            gZipBin = execSync( 'which gzip' ).toString().trim();
        } catch (binErr) {
            // Means that it is not installed.
        }

        // Caching routing
        let targetDir   = _(options.cachePath +'/'+ options.bundle +'/config', true);
        let targetDirObj = new _(targetDir, true);
        if ( ! targetDirObj.existsSync() ) {
            targetDirObj.mkdirSync();
        }
        let targetFile  = null
            , fd        = null
            , buffer    = null
            , cmd       = null
            , brFileObj = null
            , gzFileObj = null
        ;
        if (_routing) {
            targetFile  = 'routing.json';
            // Storing to disk
            console.debug(`Writing ${targetFile} to: ${targetDir}/${targetFile}`);
            fd = fs.openSync(targetDir +'/'+ targetFile, 'w'); // Open file for writing
            buffer = Buffer.from( JSON.stringify(_routing) );
            fs.writeSync(fd, buffer, 0, buffer.length, 0); // Write the buffer
            fs.closeSync(fd); // Close the file descriptor

            // Adding brotli version
            // To enblable this feature, you need to install brotli on the host
            // [ Mac Os X ] brew install brotli
            // [ Debian/Ubuntu ] sudo apt install brotli
            try {
                if (brotliBin) {
                    brFileObj = new _(targetDir +'/'+ targetFile +'.br');
                    // Removing existing
                    if ( brFileObj.existsSync() ) {
                        brFileObj.rmSync();
                    }
                    // Creating a new br version
                    cmd = brotliBin +' --best '+ _(targetDir +'/'+ targetFile, true);
                    // replaced: execSync — async exec to avoid blocking event loop during startup (#P32)
                    // console.debug( execSync( cmd ).toString() );
                    exec(cmd, function(brCmdErr, stdout) {
                        if (brCmdErr) { console.error('[ SERVER ] brotli compression error: ' + (brCmdErr.stack || brCmdErr.message)); return; }
                        if (stdout) console.debug(stdout.toString().trim());
                    });
                }
            } catch (brError) {
                console.error('[ SERVER ] '+ brError.stack);
            }

            // Adding GZip version
            // To enblable this feature, you need to install gzip on the host
            // [ Mac Os X ] brew install gzip
            // [ Debian/Ubuntu ] sudo apt install gzip
            try {
                if (gZipBin) {
                    gzFileObj = new _(targetDir +'/'+ targetFile +'.gz');
                    // Removing existing
                    if ( gzFileObj.existsSync() ) {
                        gzFileObj.rmSync();
                    }
                    // Creating a new gz version
                    cmd = gZipBin +' -9 -k '+ _(targetDir +'/'+ targetFile, true);
                    // replaced: execSync — async exec to avoid blocking event loop during startup (#P32)
                    // console.debug( execSync( cmd ).toString() );
                    exec(cmd, function(gzCmdErr, stdout) {
                        if (gzCmdErr) { console.error('[ SERVER ] gzip compression error: ' + (gzCmdErr.stack || gzCmdErr.message)); return; }
                        if (stdout) console.debug(stdout.toString().trim());
                    });
                }
            } catch (gzError) {
                console.error('[ SERVER ] '+ gzError.stack);
            }
        }


        buffer = null;
        fd = null;


        // TODO - Make a br or a gz file asside here
        localAssets = [
            {
                file    : 'public_suffix_list.dat',
                path    : getPath('gina').lib +'/domain/dist',
                mime    : 'text/plain; charset=utf8'
            },
            {
                file    : 'routing.json',
                path    : targetDir,
                mime    : 'application/json; charset=utf8'
            }
        ];
        for (let i=0, len=localAssets.length; i<len; i++) {
            let fileName  =  _(localAssets[i].path +'/'+ localAssets[i].file, true);
            localAssets[i].content = readSync(fileName, 'utf8');
        }// EO for localAssets

    } catch (assetsError) {
        // TODO - Reuse the default or the project 404 page
        // fileContent = 'Not found';
        console.error('[ SERVER ] '+ assetsError.stack);
    }


    // openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj "/CN=localhost" -keyout localhost-privkey.pem -out localhost-cert.pem
    var http2Options = {};
    if ( /https/.test(options.scheme) ) {
        try {
            http2Options = {
                key: readSync(options.credentials.privateKey),
                cert: readSync(options.credentials.certificate)
            };
        } catch(err) {
            console.emerg('You are trying to start a secured server (https) wihtout suficient credentials: check your `server settings`\n'+ err.stack);
            process.exit(1)
        }
    }


    var allowHTTP1 = true; // by default
    if (typeof (options.allowHTTP1) != 'undefined' && options.allowHTTP1 != '' ) {
        allowHTTP1 = options.allowHTTP1;
    }
    http2Options.allowHTTP1 = allowHTTP1;


    if (typeof (options.credentials.ca) != 'undefined' && options.credentials.ca != '' )
        // replaced: http2Options.ca = options.credentials.ca — credentials.ca is a path string; readSync() expands ~/ via _() before fs.readFileSync
        http2Options.ca = readSync(options.credentials.ca);

    if (typeof (options.credentials.pfx) != 'undefined' && options.credentials.pfx != '' )
        http2Options.pfx = readSync(options.credentials.pfx);

    if (typeof (options.credentials.passphrase) != 'undefined' && options.credentials.passphrase != '' )
        http2Options.passphrase = options.credentials.passphrase;

    var server = null, http = null, ioServer = null;


    if ( /^http\/2/.test(options.protocol) ) {
        http2Options.settings = {
            // Nombre max de requêtes parallèles sur UNE seule connexion TCP
            maxConcurrentStreams: 1000,
            // Taille de la fenêtre de réception (évite les blocages sur gros transferts)
            initialWindowSize: 65535 * 10
        };
        var http2   = require('http2');
        switch (options.scheme) {
            case 'http':
                server      = http2.createServer({ allowHTTP1: allowHTTP1 });
                break;

            case 'https':
                server      = http2.createSecureServer(http2Options);
                break;

            default:
                server      = http2.createServer({ allowHTTP1: allowHTTP1 });
                break;
        }

        server.on('session', (session) => {
            // 120 seconds (120000 of inactivity
            let sessionTimeout = 120000;
            session.setTimeout(sessionTimeout);

            session.on('timeout', () => {
                // Check if there are active streams before closing
                // This prevents killing a POST request that is still processing
                if (session.activeStreams === 0) {
                    console.log('[SERVER] Session idle timeout - Closing connection safely');
                    session.close();
                } else {
                    // Reset timeout if streams are still active
                    session.setTimeout(sessionTimeout);
                }
            });

            session.on('stream', () => {
                // Optional: reduce noise in production logs
                // console.warn(`[ SERVER ] New stream on existing session (Multiplexing)`);
            });

            session.on('close', () => {
                // This is normal after 60s of inactivity
                console.warn("[ SERVER ] TCP Connection closed");
            });

            // Without this handler, an abrupt client disconnect (ECONNRESET, EPROTO)
            // emits 'error' on the session with no listener → escalates to uncaughtException
            // → proc.js kills the bundle. Absorb these as warnings.
            session.on('error', (err) => {
                if (/ECONNRESET|EPROTO|ETIMEDOUT/i.test(err.code)) {
                    console.warn('[ SERVER ] Session error (absorbed):', err.message);
                    return;
                }
                console.error('[ SERVER ] Session error:', err.stack);
            });
        });
    } else {

        switch (options.scheme) {
            case 'http':
                http        = require('http');
                server      = http.createServer();
                break;

            case 'https':
                var https   = require('https');
                server      = https.createServer(http2Options);
                break;

            default:
                http        = require('http');
                server      = http.createServer();
                break;
        }
    }

    // Setting up server options
    if ( typeof(options.keepAliveTimeout) != 'undefined' ) {
        server.keepAliveTimeout = parseTimeout(options.keepAliveTimeout);
    }

    // Set headersTimeout slightly longer than keepAliveTimeout
    if ( typeof(options.headersTimeout) != 'undefined' ) {
        server.headersTimeout = parseTimeout(options.headersTimeout);
    }



    /**
     * Placeholder middleware factory (currently a stub).
     * Reserved for future path-scoped middleware support.
     *
     * @inner
     * @private
     * @param {string} path - Route path to match
     * @param {function} cb - Middleware callback
     */
    const middleware = function(path, cb) {

        // if (request.path === path) {
        //     onPath.call(this, path, cb)
        // }  else { // 404
        //     stream.respond({
        //         'content-type': 'text/html',
        //         ':status': 404
        //     });
        //     stream.end('<h1>404</h1>');
        // }
    }


    /**
     * Core HTTP request handler. Wires the server's `request` event listener,
     * dispatches health-check and info endpoints internally, handles static asset
     * serving with brotli/gzip negotiation, and delegates all other requests to
     * the Gina Router via `cb`. Called by `server.all` with `allowAll=true`.
     *
     * @inner
     * @private
     * @param {string} path - Base path this handler is mounted at
     * @param {function} cb - Gina router callback invoked for non-static requests
     * @param {boolean} [allowAll=false] - When true, all paths are handled (set by server.all)
     */
    const onPath = function(path, cb, allowAll) {

        var queryParams         = null
            , i                 = null
            , len               = null
            , p                 = null
            , arr               = null
            , a                 = null
            , isProxyHost       = null
            , requestHost       = null
            , isBinary          = null
            , isCacheless       = options.isCacheless
            , assetsCollection  = new Collection(localAssets)
            , localAsset        = null
            , cachedContents    = null
            , cachedContentObj  = null
            , cachedIndexes     = []
            , cachedIndexe      = null
        ;


        // http2stream handle by the Router class & the SuperController class
        // See `${core}/router.js` & `${core}/controller/controller.js`

        server.on('request', (request, response) => {

            request.originalUrl = request.url;
            // From the original

            acceptEncodingArr = null;
            if ( typeof(request.headers['accept-encoding']) != 'undefined' ) {
                acceptEncodingArr   = request.headers['accept-encoding'].replace(/\s+/g, '').split(/\,/);
            }
            acceptEncoding      = null;
            isBinary            = false;

            // healthcheck
            // TODO - add a top level API : server.api.js (check, get ...)
            // TODO - on 90% RAM usage, redirect to `come back later then restart bundle`
            // TODO - check url against wroot : getContext() ?
            if ( request.method.toUpperCase() === 'GET' && /\_gina\/health\/check$/i.test(request.url) ) {

                const healthStatus = JSON.stringify({
                    status: "healthy",
                    timestamp: new Date().toISOString() // Correction : JSON valide (string)
                });

                const healthHeaders = {
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma': 'no-cache',
                    'expires': '0',
                    'content-type': 'application/json; charset=utf8',
                    'X-Powered-By': 'Gina/' + GINA_VERSION
                };

                // HTTP/2 (Multiplexing)
                if (response.stream) {
                    // On utilise le stream pour garder la session ouverte
                    response.stream.respond({
                        ':status': 200,
                        ...healthHeaders
                    });
                    return response.stream.end(healthStatus);
                }

                // Fallback HTTP/1.1
                response.writeHead(200, healthHeaders);
                return response.end(healthStatus);
            }
            if ( request.method.toUpperCase() === 'GET' && /\_gina\/info$/i.test(request.url) ) {

                const infoStatus = JSON.stringify({
                    "cache-is-enabled": server._cacheIsEnabled,
                    "memory": process.memoryUsage(),
                    "uptime":  process.uptime(),
                    "version": process.version
                });

                const infoHeaders = {
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma': 'no-cache',
                    'expires': '0',
                    'content-type': 'application/json; charset=utf8',
                    'X-Powered-By': 'Gina/' + GINA_VERSION
                };

                // HTTP/2 (Multiplexing)
                if (response.stream) {
                    // On utilise le stream pour garder la session ouverte
                    response.stream.respond({
                        ':status': 200,
                        ...infoHeaders
                    });
                    return response.stream.end(infoHeaders);
                }

                // Fallback HTTP/1.1
                response.writeHead(200, infoHeaders);
                return response.end(infoStatus);
            }

            // Proxy detection - Needs to be place after /_gina/health/*
            isProxyHost = getContext('isProxyHost') || false;
            requestHost = request.headers.host || request.headers[':authority'];
            // console.debug('[PROXY_HOST][isProxyHost='+ isProxyHost +'] request.headers.host -> ' + request.headers.host + '  VS request.headers[":authority"] '+ request.headers[':authority'] +' | '+ request.url);
            if (
                !isProxyHost
                && !/\:[0-9]+$/.test(requestHost)
                ||
                !isProxyHost
                && request.headers['x-forwarded-host']
            ) {
                // Enable proxied mode
                process.gina.PROXY_HOSTNAME = process.gina.PROXY_SCHEME +'://'+ requestHost;
                process.gina.PROXY_HOST     = requestHost;
                // For internal services communications - Eg.: Controller::query()
                if (request.headers['x-forwarded-host']) {
                    process.gina.PROXY_HOSTNAME = request.headers['x-forwarded-proto'] +'://'+ request.headers['x-forwarded-host'];
                    process.gina.PROXY_HOST     = request.headers['x-forwarded-host'];
                    // console.debug('[PROXY_HOST][X-FORWARDED-PROTO] override request.headers["x-forwarded-host"] -> ' + request.headers['x-forwarded-host']);
                }
                // Forcing context - also available for workers
                setContext('isProxyHost', true);
            }


            if (
                request.method.toUpperCase() === 'GET' && /\_gina\/assets\/public_suffix_list.dat$/i.test(request.url)
                ||
                request.method.toUpperCase() === 'GET' && /\_gina\/assets\/routing\.json$/i.test(request.url)
            ) {
                // server.toApi(reques, response)
                // console.debug('[ SERVER ][200] '+ request.url);
                localAsset = assetsCollection.findOne({ file: request.url.split(/\//g).slice(-1).toString() });
                response.setHeader('content-type', localAsset.mime);
                response.setHeader('vary', 'Origin');
                response.setHeader('cache-control', 'public, max-age=86400');
                response.setHeader('x-content-type-options', 'nosniff');
                response.setHeader('x-frame-options', 'DENY');
                response.setHeader('x-xss-protection', '1; mode=block');
                response.setHeader('X-Powered-By', 'Gina/'+ GINA_VERSION);

                var filename  =  _(localAsset.path +'/'+ localAsset.file, true);
                if (acceptEncodingArr) {
                    for (let e=0, eLen=preferedEncoding.length; e<eLen; e++) {
                        if ( acceptEncodingArr && acceptEncodingArr.indexOf(preferedEncoding[e]) > -1 ) {
                            acceptEncoding = options.coreConfiguration.encoding[ preferedEncoding[e] ] ;
                            break;
                        }
                    }
                }
                // Compressed content
                if (
                    !isCacheless
                    && acceptEncoding
                    && fs.existsSync(filename + acceptEncoding)
                ) {
                    isBinary = true;
                    filename += acceptEncoding;
                    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Encoding
                    response.setHeader('content-encoding', acceptEncoding.replace(/^\./, ''));
                    // override content length
                    response.setHeader('content-length', fs.statSync(filename).size);
                }

                if (!isBinary) {
                    console.info(request.method +' [200] '+ request.url);
                    return response.end(localAsset.content);
                }

                return fs.createReadStream(filename)
                    .on('end', function onResponse(){
                        console.info(request.method +' [200] '+ request.url);
                    })
                    .pipe(response);
            }


            if (isDev) {
                refreshCore()
            }

            if (!isCacheless || String(server._cacheIsEnabled).toLowerCase() === 'true') {
                if ( request.method.toUpperCase() === 'GET' ) {
                    var cacheStatus = null;
                    if ( String(server._cacheIsEnabled).toLowerCase() === 'true' ) {
                        cacheStatus = 'gina-cache';
                    }

                    // Importing cache handler
                    cache.from(server._cached);
                    var cacheKey        = null
                        , hasCachedKey  = false
                        , keyPrefixes   = ['data:', 'static:']
                    ;
                    for (let p=0, pLen=keyPrefixes.length; p<pLen; p++ ) {
                        cacheKey = keyPrefixes[p] + request.url;
                        if ( cache.has(cacheKey) ) {
                            hasCachedKey = true;
                            break;
                        }
                    }

                    if ( hasCachedKey ) {
                        // Getting cache from key.
                        // get() may return undefined when a sliding window expires between
                        // has() and get() — treat that as a miss and fall through.
                        cachedContentObj = cache.get(cacheKey);
                        if ( !cachedContentObj ) {
                            hasCachedKey = false;
                        }
                    }

                    if ( hasCachedKey ) {
                        // Getting the headers
                        cacheStatus += '; hit';
                        var cacheNow = new Date().getTime();
                        if ( cachedContentObj.sliding === true ) {
                            // Sliding: report remaining idle window and absolute ceiling separately
                            if ( typeof(cachedContentObj.ttl) != 'undefined' && cachedContentObj.ttl > 0 ) {
                                var lastAccess = cachedContentObj.lastAccessedAt
                                    ? cachedContentObj.lastAccessedAt.getTime()
                                    : cachedContentObj.createdAt.getTime();
                                var slidingRemainingSeconds = Math.max(0, Math.floor( (lastAccess + Math.round(cachedContentObj.ttl * 1000) - cacheNow) / 1000 ));
                                cacheStatus += '; ttl=' + slidingRemainingSeconds;
                                lastAccess = null;
                                slidingRemainingSeconds = null;
                            }
                            if ( cachedContentObj.expiresAt ) {
                                var absoluteRemainingSeconds = Math.max(0, Math.floor( (cachedContentObj.expiresAt.getTime() - cacheNow) / 1000 ));
                                cacheStatus += '; max-age=' + absoluteRemainingSeconds;
                                absoluteRemainingSeconds = null;
                            }
                        } else {
                            // Non-sliding (existing behaviour): report remaining absolute TTL
                            if ( typeof(cachedContentObj.ttl) != 'undefined' && cachedContentObj.ttl > 0) {
                                var createdAt = cachedContentObj.createdAt.getTime() + Math.round(cachedContentObj.ttl * 1000);
                                var remainingSeconds = Math.floor( (createdAt - cacheNow) /1000);
                                cacheStatus += '; ttl='+remainingSeconds;
                                createdAt = null;
                                remainingSeconds = null;
                            }
                        }
                        cacheNow = null;

                        if ( typeof(cachedContentObj.responseHeaders) != 'undefined' ) {
                            for (let h in cachedContentObj.responseHeaders ) {
                                response.setHeader(h, cachedContentObj.responseHeaders[h]);
                            }
                        }
                        response.setHeader('Cache-Status', cacheStatus);
                        if (
                            typeof(cachedContentObj.fromMemory) != 'undefined'
                        ) {
                            console.info(request.method +' [200]['+ cacheStatus +'] '+ request.url);
                            return response.end(cachedContentObj.content);
                        }

                        filename  =  _(cachedContentObj.filename, true);

                        return fs.createReadStream(filename)
                            .on('error', function onError(err) {
                                console.error("[SERVER][CACHE][FILE ERROR] ", err.stack|err.message|err);
                                return response.end(''+ err.stack|err.message|err);
                            })
                            .on('end', function onResponse(){
                                console.info(request.method +' [200] '+ request.url);
                            })
                            .pipe(response);
                    } // EO if ( hasCachedKey )
                    if (cacheStatus) {
                        cacheStatus += '; uri-miss';
                        response.setHeader('Cache-Status', cacheStatus);
                    }


                    cacheKey        = null;
                    hasCachedKey    = null;
                    keyPrefixes     = null;
                } // EO if ( request.method.toUpperCase() === 'GET' )
            } // EO if (!isCacheless)



            if ( /engine.io/.test(request.url)) {
                console.debug('[ SERVER ] engine.io request');
            }

            if (path === '*' || path == request.url) {
                request.params  = {};
                request.query   = {};

                if ( request.url.indexOf('?') > -1 ) {

                    queryParams = request.url.split('?');

                    len = queryParams.length;
                    // fixing `?` > 1 occurence
                    if (len > 2) {
                        queryParams[1] = queryParams.slice(1).join('&');
                        // cleanup
                        queryParams.splice(2);
                        len = queryParams.length;
                    }
                    request.params[0] = queryParams[0];

                    if ( queryParams[1].indexOf('&') > -1 ) {
                        i = 1;
                        for (; i < len; ++i) {

                            arr = queryParams[i].split('&');
                            p = 0;
                            for (; p < arr.length; ++p) {
                                a = arr[p].split('=');
                                // false & true case — replaced: regex with string comparison (#P16)
                                var _aLower = a[1] && a[1].toLowerCase();
                                if ( _aLower === 'false' || _aLower === 'true' || _aLower === 'on' )
                                    a[1] = ( _aLower === 'true' || _aLower === 'on' ) ? true : false;
                                else if (a[1] && a[1].indexOf('%') > -1)
                                    a[1] = decodeURIComponent(a[1]);

                                if (a[1] && typeof a[1] === 'string' && (a[1].charAt(0) === '{' || a[1].charAt(0) === '[') ) {
                                    try {
                                        a[1] = JSON.parse(a[1]);
                                    } catch(notAJsonError) {
                                        console.warn('[SERVER][INCOMING REQUEST]', 'Could not convert to JSON or Array this key/value to :' + a[0] + ': '+a[1] +'/nLeaving value as a string.');
                                    }
                                }
                                request.query[ a[0] ] = a[1]
                            }
                        }
                    } else {
                        a = queryParams[1].split('=');

                        if (a.length > 1) {
                            // false & true case — replaced: regex with string comparison (#P16)
                            var _aLower2 = a[1] && a[1].toLowerCase();
                            if ( _aLower2 === 'false' || _aLower2 === 'true' || _aLower2 === 'on' )
                                a[1] = ( _aLower2 === 'true' || _aLower2 === 'on' ) ? true : false;

                            request.query[ a[0] ] = a[1]
                        } else { // for redirection purposes or when passing `?encodedJsonObject`
                            try {
                                if ( a[0].indexOf('%') > -1 ) { // encoded URI Component
                                    a[0] = decodeURIComponent(a[0])
                                }

                                request.query = a[0] ? JSON.parse(a[0]) : {};
                            } catch(err) {
                                console.error(err.stack)
                            }
                        }

                    }
                    request.url = request.url.split('?')[0]
                } else {
                    request.params[0] = request.url
                }

                var referer     = null
                    , authority = request.scheme + '://'+ request.authority
                    , host      = null
                ;
                if ( typeof(request.headers.origin) != 'undefined' ) {
                    referer = request.headers.origin;
                } else if (request.headers.referer || request.authority) {
                    referer = request.headers.referer || authority;
                }
                var a = null;
                if (authority) {
                    a = authority.match(/^[https://|http://][a-z0-9-_.:/]+/);
                    if (a) {
                        a[0].split(/\//g);
                        a.splice(3);
                        authority = a.join('/');
                        host = authority;
                    }
                }

                if ( referer && /^(https\:\/\/|http\:\/\/)/.test(referer) ) {
                    if (referer != authority ) {
                        a = referer.match(/^[https://|http://][a-z0-9-_.:/]+\//)[0].split(/\//g);
                        a.splice(3);
                        referer = a.join('/');
                    }

                    a = null;
                }
                request.origin = referer;
                if (!host && referer) {
                    host = referer;
                } else if (!host && typeof(request.headers.host) != 'undefined' ) {
                    host = request.headers.host;
                }

                var port = null;
                try {
                    port = host.match(/\:\d+/);
                } catch (portError) {
                    console.warn('[SERVER] Port not in string for host `'+ host +'`.\nSetting default port to 80.');
                }
                if (port) {
                    host = host.replace(port[0], '');
                    port = ~~(port[0].substring(1));
                } else {
                    port = 80;
                }

                if (host) {
                    host = host.replace(/^(https\:\/\/|http\:\/\/)/, '');

                    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Origin
                    if ( /^http\/2/.test(options.protocol) ) {
                        request.headers[':host']    = host;
                        request.headers[':port']    = port;
                    } else if ( typeof(request.headers.hostname) == 'undefined') {
                        request.headers.host = host;
                        request.headers.port = port;
                    }

                    request.port    = port;
                    request.host    = host;

                    port    = null;
                    referer = null;
                }


                cb(request, response);
            }
        });

    }


    /**
     * Registers a catch-all request handler for every path.
     * Delegates to onPath with `allowAll=true`.
     *
     * @memberof ServerEngineClass
     * @param {string} path - Base path (usually '/')
     * @param {function} cb - Gina router callback
     */
    // All paths allowed
    server.all = function(path, cb) {
        onPath.call(this, path, cb, true)
    }

    // configuring express plugins|middlewares
    server._expressMiddlewares = [];
    /**
     * Registers one or more middleware functions to be called for every request.
     * Accepts either a plain function or an array of functions (Express-compatible signature).
     * Middlewares are stored in `server._expressMiddlewares` and invoked in registration order.
     *
     * @memberof ServerEngineClass
     * @param {function|function[]} fn - Middleware function or array of middleware functions
     */
    server.use = function use(fn) {

        var offset = 0;
        //var path = '/';

        // default path to '/'
        // disambiguate app.use([fn])
        if (typeof fn !== 'function') {
          var arg = fn;

          while (Array.isArray(arg) && arg.length !== 0) {
            arg = arg[0];
          }

          // first arg is the path
          if (typeof arg !== 'function') {
            offset = 1;
            path = fn;
          }
        }


        var fns = merge(slice.call(arguments, offset));

        if (fns.length === 0) {
          throw new TypeError('server.use() requires a middleware function')
        }

        fns.forEach(function (fn) {
            server._expressMiddlewares[server._expressMiddlewares.length] = fn;
        });

        return this;
    }


    server.on('error', (err) => {
        console.error(err)
    });


    //------------------------------------
    // Engine IO server
    // https://socket.io/docs/v4/server-api/#socketsendargs
    //------------------------------------
    if (
        typeof(options.ioServer) != 'undefined'
        && typeof(options.ioServer.integrationMode) != 'undefined'
        && /^attach$/.test(options.ioServer.integrationMode)
    ) {
        console.info('[IO SERVER ] `eio` found using `'+ options.ioServer.integrationMode +'` integration mode');
        delete options.ioServer.integrationMode;
        // Normalize timeout fields to ms before passing to engine.io constructor,
        // which calls setTimeout() internally and requires numeric values.
        var _ioTimeoutKeys = ['pingTimeout', 'pingInterval', 'timeout', 'interval', 'ackTimeout'];
        for (var _k = 0; _k < _ioTimeoutKeys.length; ++_k) {
            if (typeof options.ioServer[_ioTimeoutKeys[_k]] !== 'undefined') {
                options.ioServer[_ioTimeoutKeys[_k]] = parseTimeout(options.ioServer[_ioTimeoutKeys[_k]]);
            }
        }
        // test done in case we would like to switch to socket.io-server
        ioServer = ( typeof(Eio.attach) != 'undefined' ) ? new Eio.attach(server, options.ioServer) : new Eio(server, options.ioServer);

        server.eio = ioServer;

        ioServer.on('connection', function (socket) {

            socket.send(JSON.stringify({
                id: this.id,//socket.id,
                handshake: 'Welcomed to `'+ options.bundle +'` main socket !',
                // how many ms before sending a new ping packet
                pingTimeout: parseTimeout(options.ioServer.pingTimeout || options.ioServer.timeout),
                // how many ms without a pong packet to consider the connection closed
                pingInterval: parseTimeout(options.ioServer.pingInterval || options.ioServer.interval)
            }));

            socket.on('message', function(payload){

                try {
                    console.debug('[IO SERVER ] receiving '+ payload);
                    payload = JSON.parse(payload);
                    // bind to session ID
                    if ( typeof(payload.session) != 'undefined' ) {
                        this.sessionId = payload.session.id;
                    }
                } catch(err) {
                    console.error(err.stack||err.message|| err)
                }
            });

            socket.on('close', function(){
                console.debug('[IO SERVER ] closed socket #'+ this.id);
            });
        });

        server.on('upgrade', function(req, socket, head){
            console.debug('[IO SERVER ] upgrading socket #'+ this.id);
            ioServer.handleUpgrade(req, socket, head);
        });
        // httpServer.on('request', function(req, res){
        //     ioServer.handleRequest(req, res);
        // });


    }



    return {
        instance: server,
        middleware: middleware
    }
};

module.exports = ServerEngineClass;