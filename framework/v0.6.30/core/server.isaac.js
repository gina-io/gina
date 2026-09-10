"use strict";
/**
 * @module gina/core/server.isaac
 */
const fs                    = require('fs');
const crypto                = require('crypto');
const nodePath              = require('path'); // #B179: used for path-traversal boundary enforcement
const { execSync, exec }    = require('child_process');
const {EventEmitter}        = require('events');
// #B10 fix: engine.io is only needed when options.ioServer is configured (WebSocket support).
// Require it lazily so bundles without WebSocket support don't crash if engine.io is absent.
// const Eio = require('engine.io');
let Eio = null;
// const zlib                  = require('zlib'); // gzip / deflate

// Lightweight debug logger — gated on LOG_LEVEL so zero cost in production.
// Format mirrors lib/logger template: [date] [debug  ][gina:isaac] message
// Deliberately retained with no call sites (#B435): the producer half of the
// boot-diagnostic channel. lib/cmd/bundle/start.js's child.stderr filter
// forwards lines matching `[debug  ][gina:` raw to the CLI client — no other
// write from a daemon-spawned bundle reaches the operator (console.error does
// not match the filter; stdout is captured but not forwarded). Writing
// straight to stderr keeps it usable before lib/logger is ready and immune to
// the logger's own failure modes — which also means it bypasses log redaction
// (#B433): keep messages free of URLs and credentials. Format changes must
// preserve `] [debug  ][gina:` — test/core/debug-log.test.js pins the contract.
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
    process.stderr.write('\u001b[90m[' + ts + '] [debug  ][gina:isaac] ' + msg + '\u001b[39m\n');
};

const lib               = require('./../lib');
const inherits          = lib.inherits;
const merge             = lib.merge;
const console           = lib.logger;
const Collection        = lib.Collection;
const cache             = new lib.Cache();
const renderCache       = new lib.RenderCache();


const env               = process.env.NODE_ENV
    , isDev             = process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true'
    , scope             = process.env.NODE_SCOPE
    , isLocalScope      = process.env.NODE_SCOPE_IS_LOCAL && process.env.NODE_SCOPE_IS_LOCAL.toLowerCase() === 'true'
    , isProductionScope = process.env.NODE_SCOPE_IS_PRODUCTION && process.env.NODE_SCOPE_IS_PRODUCTION.toLowerCase() === 'true'
;

/**
 * Constant-time API-key check for the /_gina/agent SSE endpoint when it is
 * exposed outside dev mode (#INS9b). The configured key lives on
 * `process.gina._inspectorAgentKey` (set by gna.js from settings.json
 * `inspector.agent.key`). The request presents the key via the
 * `x-gina-inspector-key` header or a `?key=` query param — browsers using
 * EventSource cannot set request headers, so the query param is the browser
 * path; programmatic callers should prefer the header.
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
 * Confines a resolved filename to its intended base directory, rejecting
 * path-traversal escapes (`../`) that would otherwise canonicalise outside it.
 * Both paths are normalised with `path.resolve`, then a separator-aware
 * containment check is applied so a base of `/srv/app/lib` cannot be bypassed
 * by a sibling such as `/srv/app/lib-secrets`. Purely lexical (no symlink
 * following).
 *
 * Engine-local mirror of the canonical `confineToBase` in `core/server.js`
 * (declared inside `Server()`, so it is not reachable from this module). Keep
 * the two behaviourally identical — `test/core/server-static-traversal.test.js`
 * extracts the server.js copy by its declaration string and drives it directly,
 * and `test/core/inspector-traversal.test.js` does the same for this one.
 *
 * @inner
 * @private
 * @memberof module:gina/core/server.isaac
 * @param {string} filename - The concatenated candidate filesystem path
 * @param {string} base     - The intended base directory
 * @returns {string|null} The canonical in-base path, or `null` when it escapes `base`
 * @example
 * confineToBase('/srv/app/js/lib/../../../config/secret.json', '/srv/app/js/lib'); // → null
 * confineToBase('/srv/app/js/lib/app.js', '/srv/app/js/lib');                      // → '/srv/app/js/lib/app.js'
 */
var confineToBase = function(filename, base) {
    if ( typeof(filename) != 'string' || typeof(base) != 'string' || base.length === 0 ) {
        return null;
    }
    var _resolvedBase = nodePath.resolve(base);
    var _resolvedFile = nodePath.resolve(filename);
    // separator-aware containment: identical to base, or a proper child of it
    if ( _resolvedFile === _resolvedBase || _resolvedFile.indexOf(_resolvedBase + nodePath.sep) === 0 ) {
        return _resolvedFile;
    }
    return null;
}

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

    // Update lib & helpers.
    //
    // `require.cache[<path>] = require(<path>)` would overwrite the cache entry
    // — which Node expects to be a `Module` instance with an `.exports` property
    // — with the lib registry's *exports object* directly. Subsequent plain
    // `require('../../lib')` calls then read `require.cache[<path>].exports` and
    // get `undefined` (the registry object has no `.exports` key), surfacing as
    // `Cannot read properties of undefined (reading 'Collection')` / `(reading
    // 'Cache')` etc. in the controller render delegates after a dev-mode hot
    // reload. Fix: delete the entry and let the next require() rebuild a proper
    // Module, then point gna.js's captured `.lib` at the fresh exports — the
    // same `.exports`-preserving shape the loop above already uses.
    var libIndexPath = _(libPath +'/index.js', true);
    delete require.cache[require.resolve(libIndexPath)];
    var freshLib = require( libIndexPath );
    require.cache[_(corePath + '/gna.js', true)].exports.lib = freshLib;

    // Update plugins — same fix as above.
    var pluginsIndexPath = _(corePath +'/plugins/index.js', true);
    delete require.cache[require.resolve(pluginsIndexPath)];
    var freshPlugins = require( pluginsIndexPath );
    require.cache[_(corePath + '/gna.js', true)].exports.plugins = freshPlugins;

    pruneDeadModuleChildren();
}

/**
 * Prunes stale `Module` references from every cached module's `children` array.
 *
 * Each cache-miss `require()` pushes the freshly created `Module` onto the
 * requiring module's `children` array — Node only dedupes on cache hits — so the
 * per-request delete-and-re-require cycles in `refreshCore()` (and the router's
 * `refreshCoreDependencies()`) make long-lived parents accumulate one dead
 * `Module` per eviction: this engine module, `router.js`, and any module with a
 * lazy in-function `require()` of an evicted lib. Every dead `Module` pins its
 * entire evaluated exports graph. Measured on a minimal bundle in dev mode:
 * ~1.8 MB of post-GC live heap retained per request, ending in a heap-limit
 * OOM (SIGABRT) at ~2400 requests.
 *
 * Keeping only children whose resolved id still maps to that same instance in
 * `require.cache` releases the dead graphs. `children` is diagnostic metadata
 * (nothing in Node's resolution reads it), so pruning never unloads a module
 * still referenced elsewhere.
 *
 * A local copy of the same sweep lives in `core/router.js` — the engine-agnostic
 * router cannot depend on an engine module, and the `lib` registry is itself
 * evicted per request. Keep both copies in sync.
 *
 * @memberof module:gina/core/server.isaac
 * @inner
 * @returns {undefined}
 */
var pruneDeadModuleChildren = function() {
    var cacheIds = Object.keys(require.cache);
    for (var i = 0, len = cacheIds.length; i < len; i++) {
        var cached = require.cache[cacheIds[i]];
        if (cached && cached.children && cached.children.length > 0) {
            cached.children = cached.children.filter(function onPruneFilter(child) {
                return require.cache[child.id] === child;
            });
        }
    }
};

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
 * @param {object} options.allRoutes - Full routing map (no longer read here — the client maps arrive pre-built, see clientRoutingAssets)
 * @param {{full: object, stripped: object}} options.clientRoutingAssets - Client-served routing maps built once by core/server.js `buildClientRoutingAssets` (#B212) — the full map and the #B66 host-stripped variant; isaac writes them to disk and serves the precompressed files as its fast-path
 * @param {string} options.preferedCompressionEncodingOrder - Ordered list of accepted encodings
 * @param {number} [options.keepAliveTimeout] - Server keep-alive timeout in ms
 * @param {number} [options.headersTimeout] - Server headers timeout in ms
 * @param {object} [options.ioServer] - engine.io server options; omit to disable WebSocket support
 * @returns {{ instance: object, middleware: function }} Configured Node server and middleware factory
 */
function ServerEngineClass(options) {

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
        // #B212 — the client-served maps (the full map + the #B66 host-stripped
        // variant, #COMPLY1/#COMPLY10 strip included) are now built ONCE, engine-
        // agnostically, by core/server.js (buildClientRoutingAssets) and handed to
        // every engine via options.clientRoutingAssets — one builder, two consumers:
        // server.js serves the pre-stringified maps from memory in its onRequest
        // catch-all (the express path, which used to 404 here), while isaac writes
        // them to disk below and serves the precompressed files as its fast-path.
        // Rebuilding the maps here would re-create the exact writer/reader drift
        // the #C3 lesson warns about.
        var _routing         = ( options.clientRoutingAssets && options.clientRoutingAssets.full ) || null;
        var _routingStripped = ( options.clientRoutingAssets && options.clientRoutingAssets.stripped ) || null;
        if ( !_routing ) {
            console.warn('[ SERVER ][ isaac ] options.clientRoutingAssets missing — the client routing assets (routing.json / routing.stripped.json) will not be written for this boot.');
        }

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

        // #B66 — write + (br/gz)-compress the host-stripped variant to disk, mirroring
        // the full routing.json above. Served to proxied clients by the #B66 handler
        // branch; RAW clients keep the full blob (the full write above is untouched).
        if (_routingStripped) {
            targetFile  = 'routing.stripped.json';
            // Storing to disk
            console.debug(`Writing ${targetFile} to: ${targetDir}/${targetFile}`);
            fd = fs.openSync(targetDir +'/'+ targetFile, 'w'); // Open file for writing
            buffer = Buffer.from( JSON.stringify(_routingStripped) );
            fs.writeSync(fd, buffer, 0, buffer.length, 0); // Write the buffer
            fs.closeSync(fd); // Close the file descriptor

            // Adding brotli version (see the full routing.json block above)
            try {
                if (brotliBin) {
                    brFileObj = new _(targetDir +'/'+ targetFile +'.br');
                    if ( brFileObj.existsSync() ) {
                        brFileObj.rmSync();
                    }
                    cmd = brotliBin +' --best '+ _(targetDir +'/'+ targetFile, true);
                    exec(cmd, function(brCmdErr, stdout) {
                        if (brCmdErr) { console.error('[ SERVER ] brotli compression error: ' + (brCmdErr.stack || brCmdErr.message)); return; }
                        if (stdout) console.debug(stdout.toString().trim());
                    });
                }
            } catch (brError) {
                console.error('[ SERVER ] '+ brError.stack);
            }

            // Adding GZip version
            try {
                if (gZipBin) {
                    gzFileObj = new _(targetDir +'/'+ targetFile +'.gz');
                    if ( gzFileObj.existsSync() ) {
                        gzFileObj.rmSync();
                    }
                    cmd = gZipBin +' -9 -k '+ _(targetDir +'/'+ targetFile, true);
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


        localAssets = [
            {
                file    : 'routing.json',
                path    : targetDir,
                mime    : 'application/json; charset=utf8'
            },
            // #B66 — host-stripped variant, served to proxied clients (see handler branch)
            {
                file    : 'routing.stripped.json',
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
            var _credMsg = 'You are trying to start a secured server (https) wihtout suficient credentials: check your `server settings`\n'+ err.stack;
            console.emerg(_credMsg);
            // Guarantee the reason survives process.exit() on an async pipe (e.g. bin/gina-container).
            try { fs.writeSync(2, _credMsg + '\n'); } catch (_e) { /* best-effort */ }
            process.exit(1)
        }
    }


    var allowHTTP1 = true; // by default
    if (typeof (options.allowHTTP1) != 'undefined' && options.allowHTTP1 != '' ) {
        allowHTTP1 = options.allowHTTP1;
    }
    http2Options.allowHTTP1 = allowHTTP1;


    // Only read optional CA/PFX credentials for HTTPS — they are not needed for plain HTTP
    if ( /https/.test(options.scheme) ) {
        if (typeof (options.credentials.ca) != 'undefined' && options.credentials.ca != '' )
            // replaced: http2Options.ca = options.credentials.ca — credentials.ca is a path string; readSync() expands ~/ via _() before fs.readFileSync
            http2Options.ca = readSync(options.credentials.ca);

        if (typeof (options.credentials.pfx) != 'undefined' && options.credentials.pfx != '' )
            http2Options.pfx = readSync(options.credentials.pfx);

        if (typeof (options.credentials.passphrase) != 'undefined' && options.credentials.passphrase != '' )
            http2Options.passphrase = options.credentials.passphrase;
    }

    var server = null, http = null, ioServer = null;


    if ( /^http\/2/.test(options.protocol) ) {
        var _h2Opts = (options.http2Options && typeof options.http2Options === 'object') ? options.http2Options : {};
        // #H13 — RFC 8441 extended CONNECT (WebSocket over HTTP/2): strict boolean
        // opt-in via settings.json http2Options.enableConnectProtocol (default false).
        // Gates both the SETTINGS advert below and the `connect` listener registration.
        var _enableConnectProtocol = _h2Opts.enableConnectProtocol === true;
        http2Options.settings = {
            // Max parallel streams per TCP connection — configurable via settings.json http2Options.maxConcurrentStreams
            maxConcurrentStreams : _h2Opts.maxConcurrentStreams || 256,
            // Flow-control window in bytes — configurable via settings.json http2Options.initialWindowSize
            initialWindowSize   : _h2Opts.initialWindowSize    || 65535 * 10,
            // #H3 — HPACK bomb defense: cap compressed header list size (SETTINGS_MAX_HEADER_LIST_SIZE)
            maxHeaderListSize   : 65536,
            // #H3 — Server push is deprecated in Chrome/Firefox and removed in HTTP/2 RFC 9113; disable it
            enablePush          : false,
            // #H13 — advertises SETTINGS_ENABLE_CONNECT_PROTOCOL (RFC 8441) on any
            // http/2 bundle: `http2Options` (and this `settings` block) reaches
            // createSecureServer (https) and createServer (h2c) alike. RFC 8441 has
            // no TLS requirement; the flag stays a strict opt-in (default false).
            enableConnectProtocol : _enableConnectProtocol
        };
        // #H3 — RST flood defense (CVE-2019-9514, CVE-2023-44487 rapid reset)
        // #H7 — configurable via settings.json http2Options.maxSessionRejectedStreams (default 100)
        http2Options.maxSessionRejectedStreams = _h2Opts.maxSessionRejectedStreams || 100;
        // #H3 — CONTINUATION flood defense (CVE-2024-27316, CVE-2024-27983)
        // #H7 — configurable via settings.json http2Options.maxSessionInvalidFrames (default 1000)
        http2Options.maxSessionInvalidFrames = _h2Opts.maxSessionInvalidFrames || 1000;
        // #H9 — rapid-reset rate limit: max new streams accepted per session per
        // rolling 1s window before the session is GOAWAY'd + closed. Defends against
        // CVE-2023-44487-style rapid-reset floods (open then immediately RST streams
        // faster than maxConcurrentStreams alone can throttle). Configurable via
        // settings.json http2Options.maxStreamsPerSecond (default 200).
        var _maxStreamsPerSec = _h2Opts.maxStreamsPerSecond || 200;
        var http2   = require('http2');
        // h2c flood-defense parity: the cleartext branches receive the same
        // `http2Options` as the https branch. On non-https schemes the object
        // carries no TLS material (key/cert/ca/pfx/passphrase are merged under
        // `/https/` scheme gates only) — it holds exactly allowHTTP1 + the
        // `settings` advert + the #H3/#H7 caps, so the hardening applies
        // identically across schemes.
        switch (options.scheme) {
            case 'http':
                server      = http2.createServer(http2Options);
                break;

            case 'https':
                server      = http2.createSecureServer(http2Options);
                break;

            default:
                server      = http2.createServer(http2Options);
                break;
        }

        // ── HTTP/2 session metrics — exposed via /_gina/info ─────────────────────
        var _h2Metrics = {
            activeSessions : 0,
            totalStreams    : 0,
            goawayCount     : 0,
            rstCount        : 0,
            rapidResetBlocked : 0,
            // #H13 — extended-CONNECT (`:protocol`-bearing) streams observed
            extendedConnect : 0
        };
        server._h2Metrics = _h2Metrics;

        server.on('session', (session) => {
            // 120 seconds (120000 of inactivity
            let sessionTimeout = 120000;
            session.setTimeout(sessionTimeout);
            _h2Metrics.activeSessions++;

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

            session.on('stream', (stream) => {
                _h2Metrics.totalStreams++;

                // #H9 — rapid-reset rate limit. Count new streams in a rolling 1s
                // window per session; on breach send GOAWAY(ENHANCE_YOUR_CALM) and
                // close the session so a flood cannot exhaust the worker.
                var _now = Date.now();
                if (typeof session._streamWindowStart === 'undefined' || (_now - session._streamWindowStart) >= 1000) {
                    session._streamWindowStart = _now;
                    session._streamWindowCount = 0;
                }
                session._streamWindowCount++;
                if (session._streamWindowCount > _maxStreamsPerSec) {
                    _h2Metrics.rapidResetBlocked++;
                    console.warn('[ SERVER ] HTTP/2 rapid-reset rate limit exceeded — ' + session._streamWindowCount + ' streams in <1s (limit ' + _maxStreamsPerSec + '); sending GOAWAY + closing session');
                    session.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM);
                    session.close();
                    // Deliberately return before registering the per-stream
                    // `rstCode` listener below: the session is being torn down,
                    // so the breaching stream needs no per-stream accounting.
                    // Breached streams are counted by `rapidResetBlocked`, not
                    // `rstCount` — the two metrics stay cleanly separated
                    // (proactive block vs. observed client RST_STREAM).
                    return;
                }

                stream.on('rstCode', (code) => {
                    if (code !== 0) _h2Metrics.rstCount++;
                });
            });

            session.on('goaway', () => {
                _h2Metrics.goawayCount++;
            });

            session.on('close', () => {
                // This is normal after 60s of inactivity
                if (_h2Metrics.activeSessions > 0) _h2Metrics.activeSessions--;
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

        // #H13 — RFC 8441 extended CONNECT (WebSocket over HTTP/2), strict opt-in.
        // Registering a `connect` listener suppresses the engine compat layer's
        // automatic 405 for CONNECT streams, so EVERY path below must terminate
        // the stream/socket — an unanswered CONNECT hangs forever. When the flag
        // is off, no listener is registered and the engine behaves byte-identically
        // to previous releases (plain CONNECT → compat 405; extended CONNECT →
        // rejected as malformed before reaching the app, since
        // SETTINGS_ENABLE_CONNECT_PROTOCOL was never advertised).
        // #H9 composition: the per-session `stream` accounting above still counts
        // every CONNECT stream — a rapid-reset flood of CONNECT streams trips the
        // same GOAWAY teardown, which destroys any just-accepted stream with it.
        if (_enableConnectProtocol) {
            server.on('connect', (request, response) => {
                try {
                    if (!request.stream) {
                        // HTTP/1.1 CONNECT (allowHTTP1 fallback): `response` is the
                        // raw socket here, the third argument the head buffer. Gina
                        // is not a forward proxy — refuse and close. (Without this
                        // listener the engine destroys the connection unanswered.)
                        response.write('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
                        response.destroy();
                        return;
                    }
                    var _protocol = request.headers[':protocol'];
                    if (typeof _protocol === 'undefined') {
                        // Plain HTTP/2 CONNECT (no :protocol): mirror the compat
                        // layer's default refusal (`:status 405` + `date`, no body).
                        response.writeHead(405);
                        response.end();
                        return;
                    }
                    _h2Metrics.extendedConnect++;
                    if (_protocol !== 'websocket') {
                        response.writeHead(501);
                        response.end();
                        return;
                    }
                    if (typeof server._extendedConnectHandler === 'function') {
                        // Narrow internal hook: the WebSocket session bridge claims
                        // the stream from here (`request.stream` is the raw
                        // Http2Stream; RFC 8441 §5 — respond `:status 200`, then the
                        // stream IS the bidirectional WebSocket channel).
                        server._extendedConnectHandler(request, response);
                        return;
                    }
                    // No consumer registered (transport enabled, bridge not wired):
                    // refuse cleanly so clients see a handshake failure, not a hang.
                    response.writeHead(501);
                    response.end();
                } catch (err) {
                    // Never let a CONNECT-path error escalate to uncaughtException
                    // (proc.js would SIGTERM the bundle) — terminate the stream instead.
                    console.warn('[ SERVER ] extended CONNECT handling failed: ' + err.message);
                    try {
                        if (request.stream && !request.stream.destroyed) {
                            request.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
                        } else if (!request.stream && response && response.destroy) {
                            response.destroy();
                        }
                    } catch (closeErr) {
                        // stream/socket already gone — nothing left to terminate
                    }
                }
            });

            /**
             * #H13 — public WebSocket-over-HTTP/2 registration API. Bundle code
             * reaches it from `onInitialize` (the `app` argument IS this raw
             * server object) and registers a handler per exact pathname:
             *
             *     app.onWebSocket('/live', function(session, request) { ... });
             *
             * The dispatcher installs LAZILY on the first registration so the
             * default refusal table above keeps answering 501 for websocket
             * streams when no consumer exists. With handlers registered, an
             * accepted websocket stream is matched on its `:path` pathname
             * (query string stripped): an exact-path hit first, then (#H13
             * slice 2) an ordered scan of `:param` patterns whose captured
             * segments populate `request.params` (colon-stripped keys, the
             * same shape an HTTP controller reads). A hit is answered
             * `:status 200` via lib.wsSession.accept and handed to the handler
             * as a live session; a miss is refused with 404. No express middleware runs
             * on the CONNECT path — authentication is the handler's concern
             * (it receives the full request for header/cookie inspection).
             * Registering a path that already has a handler warns and overwrites
             * (last-write-wins): a programmatic call overrides a routing.json
             * `method:"ws"` declaration for the same path (declarations are
             * registered at bundle bootstrap, before onInitialize).
             *
             * #H13 slice 3a — an optional 3rd argument carries per-route session
             * options (maxPayload / protocol / closeTimeout) forwarded verbatim to
             * lib.wsSession.accept; a routing.json `method:"ws"` route supplies them
             * via `param.wsOptions`. Overwriting a path replaces handler AND options.
             */
            server._wsHandlers = {};
            // #H13 slice 3a — parallel exact-path → per-route options map. Kept
            // separate from _wsHandlers so that stays a pure path→handler map (the
            // collision guard tests the literal `_wsHandlers[wsPath]` shape).
            server._wsHandlerOptions = {};
            // #H13 slice 2 — ordered registry of `:param` patterns, scanned only
            // on an exact-match miss. Each entry: { pattern, segments, handler }.
            // First-registered wins among overlapping equal-length patterns —
            // mirrors gina's HTTP router, which is first-match by declaration
            // order (core/server.js routing loop breaks on the first matching
            // route; there is no cross-route best-score selection). Keeping the
            // same rule here means WS routing resolves consistently with HTTP.
            server._wsParamHandlers = [];

            // #H13 slice 2 — match a request pathname against the `:param`
            // registry. Exact routes are resolved by the caller BEFORE this runs.
            // Splits on '/' (keeping the leading '' from the leading slash, so
            // pattern/request segments index-align, mirroring lib/routing). A
            // strict segment-count gate, then per-segment: a literal must equal
            // exactly; a `:name` segment captures any NON-EMPTY segment as
            // `params[name]` (colon-stripped key + decodeURIComponent — the same
            // shape an HTTP controller reads off req.params). Returns
            // { handler, params } for the first matching pattern, else null.
            server._wsMatchParam = function(pathname) {
                var reqSegs = String(pathname || '').split('/');
                for (var i = 0; i < server._wsParamHandlers.length; i++) {
                    var entry = server._wsParamHandlers[i];
                    if (entry.segments.length !== reqSegs.length) { continue; }
                    var params = {};
                    var ok = true;
                    for (var s = 0; s < entry.segments.length; s++) {
                        var pat = entry.segments[s];
                        if (pat.charAt(0) === ':') {
                            if (reqSegs[s] === '') { ok = false; break; } // reject empty captured segment
                            params[pat.substring(1)] = decodeURIComponent(reqSegs[s]);
                        } else if (pat !== reqSegs[s]) {
                            ok = false; break;
                        }
                    }
                    if (ok) { return { handler: entry.handler, params: params, options: entry.options }; }
                }
                return null;
            };

            server.onWebSocket = function(wsPath, wsHandler, wsOptions) {
                if (typeof wsPath !== 'string' || wsPath.length === 0 || typeof wsHandler !== 'function') {
                    throw new TypeError('onWebSocket(path, handler) requires a non-empty path string and a handler function');
                }
                // #H13 slice 3b — capture, once, the bundle/env this server serves
                // (a server serves one bundle) for session.query. The routing.json
                // registrar (core/server.js) sets server._wsBundle/_wsEnv explicitly
                // from self.appName/self.env before its first call here; a purely
                // programmatic caller (onInitialize) falls back to getContext, which
                // is correct at boot. Capturing at registration avoids the shared
                // ctx.bundle stack-walk mutation hazard that would bite a lazy
                // connect/message-time read on a long-lived interleaved session.
                if (typeof server._wsBundle === 'undefined') {
                    server._wsBundle = (typeof getContext === 'function') ? getContext('bundle') : null;
                    server._wsEnv    = (typeof getContext === 'function') ? getContext('env') : null;
                }
                // #H13 slice 2 — a path with a `:` segment is a param pattern
                // (same placeholder convention as lib/routing's hasParams: /\:/).
                if ( /\:/.test(wsPath) ) {
                    var _existing = -1;
                    for (var _p = 0; _p < server._wsParamHandlers.length; _p++) {
                        if (server._wsParamHandlers[_p].pattern === wsPath) { _existing = _p; break; }
                    }
                    if (_existing > -1) {
                        console.warn('[ SERVER ] onWebSocket: pattern `'+ wsPath +'` already has a handler — overwriting');
                        server._wsParamHandlers[_existing].handler = wsHandler;
                        server._wsParamHandlers[_existing].options = wsOptions || null;
                    } else {
                        server._wsParamHandlers.push({ pattern: wsPath, segments: wsPath.split('/'), handler: wsHandler, options: wsOptions || null });
                    }
                } else {
                    if ( typeof server._wsHandlers[wsPath] === 'function' ) {
                        console.warn('[ SERVER ] onWebSocket: path `'+ wsPath +'` already has a handler — overwriting');
                    }
                    server._wsHandlers[wsPath] = wsHandler;
                    server._wsHandlerOptions[wsPath] = wsOptions || null;
                }
                if (typeof server._extendedConnectHandler !== 'function') {
                    server._extendedConnectHandler = function(request, response) {
                        var _wsPathname = String(request.headers[':path'] || '').split('?')[0];
                        // Exact match wins (slice-1 precedence preserved).
                        var _wsTarget = server._wsHandlers[_wsPathname];
                        var _wsParams = null;
                        // #H13 slice 3a — per-route session options resolved alongside
                        // the handler: an exact hit reads the exact options map; a
                        // param hit takes the matched entry's options below.
                        var _wsOpts   = server._wsHandlerOptions[_wsPathname] || null;
                        // #H13 slice 2 — param fallback only on an exact miss.
                        if (typeof _wsTarget !== 'function' && server._wsParamHandlers.length) {
                            var _m = server._wsMatchParam(_wsPathname);
                            if (_m) { _wsTarget = _m.handler; _wsParams = _m.params; _wsOpts = _m.options || null; }
                        }
                        if (typeof _wsTarget !== 'function') {
                            // No handler registered for this pathname.
                            response.writeHead(404);
                            response.end();
                            return;
                        }
                        // Populate request.params (named keys, colon-stripped) so a
                        // channel handler reads the same shape an HTTP controller does.
                        request.params = _wsParams || {};
                        var _wsSession = lib.wsSession.accept(request, _wsOpts || undefined);
                        // #H13 slice 3b — give the channel handler a cross-bundle HTTP
                        // capability (session.query(options[, data]) → Promise), mirroring
                        // a controller's self.query(). Attached AFTER accept so
                        // lib/ws-session stays controller-free. The bundle/env this server
                        // serves were captured at registration (server._wsBundle/_wsEnv) —
                        // never resolved lazily here, where the shared getContext('bundle')
                        // is rewritten by every getConfig/getLib stack-walk.
                        _wsSession.query = lib.wsQuery.build(server, server._wsBundle, server._wsEnv);
                        _wsTarget(_wsSession, request);
                    };
                }
            };
        }
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

    // #H13 — cross-protocol safety stub: onWebSocket is only functional on an
    // http/2 bundle with http2Options.enableConnectProtocol enabled. Bundles
    // sharing one onInitialize across differently-configured environments
    // must not crash on the call — warn instead of throwing.
    if (typeof server.onWebSocket !== 'function') {
        server.onWebSocket = function() {
            console.warn('[ SERVER ] onWebSocket() ignored — WebSocket over HTTP/2 requires an http/2 protocol and settings.json http2Options.enableConnectProtocol set to true');
        };
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

        // #HDR8 Phase 2 — gate the framework's X-Powered-By emission based on
        // settings.json > server.hidePoweredBy (default false). Phase 1's
        // gina.plugins.HidePoweredBy() middleware can intercept setHeader /
        // removeHeader in the express chain but NOT the 15 direct writeHead
        // emissions below — writeHead bypasses the setHeader interface. This
        // helper closes that Isaac-engine gap. The engine-agnostic per-request
        // emission in core/server.js honors the SAME flag via its own inline
        // gate, so the flag suppresses the header framework-wide (routed,
        // statics, error pages, /_gina). Default false preserves shipped
        // behaviour; opt-in by setting server.hidePoweredBy = true.
        var _setPoweredByHeader = function(headers) {
            if (!options.hidePoweredBy) {
                headers['X-Powered-By'] = 'Gina/' + GINA_VERSION;
            }
            // #OW1 — engine-agnostic security headers (OWASP A02), applied at the
            // SAME writeHead sites this helper already backs. writeHead commits
            // headers directly, bypassing setHeader, so the core/server.js twin
            // cannot reach them — this is the isaac half of ONE shared emitter
            // (lib/security-headers-emitter), not a drifting copy.
            // Every call site of this helper is a /_gina/* endpoint (measured
            // 29/29), and those are deliberately cross-origin — the metrics /
            // health / SSE handlers emit `access-control-allow-origin: *` and the
            // Inspector's cross-origin GET/SSE channels are a documented design —
            // so the cross-origin-isolating headers (coop/corp) are exempted here
            // unconditionally. Signature deliberately unchanged: no call site
            // needs editing.
            headers = lib.securityHeadersEmitter.applyToGinaEndpointHeaders(options.securityHeaders, headers);
            return headers;
        };


        // http2stream handle by the Router class & the SuperController class
        // See `${core}/router.js` & `${core}/controller/controller.js`

        server.on('request', (request, response) => {

            request.originalUrl = request.url;
            // #FI — dev-mode request timeline for Inspector Flow tab
            // Only initialized when the Inspector has been opened (process.gina._inspectorActive)
            // #INS10 — or during a prod instrumentation window (process.gina._inspectorWindowUntil).
            // #OBS1 first-seer (!request._devTimeline): this engine listener runs BEFORE it hands
            // off to server.js's onInstance (via cb), and BOTH tops carry this same init. An
            // unguarded overwrite would reset requestStart to onInstance's LATER time, dropping
            // the isaac-listener setup interval from the Flow timeline. The engine listener claims
            // first; onInstance then skips. Keep the two tops in sync.
            if (((process.gina && process.gina._inspectorWindowUntil > Date.now()) || (isCacheless && process.gina._inspectorActive)) && !request._devTimeline) {
                request._devTimeline = { requestStart: Date.now(), entries: [] };
            }
            // #OBS1 slice 3 — HTTP request lifecycle hook for Prometheus metrics.
            // Gated on lib.metrics.isEnabled() so the listener is only wired when
            // app.json metrics.enabled is true. Records on response 'finish' (fires
            // for both HTTP/1.1 ServerResponse and HTTP/2 Http2ServerResponse).
            // Errors inside the listener are swallowed — metrics must never crash
            // a request.
            // #OBS1 first-seer (!request._metricsRecorded): under isaac a ROUTED request runs BOTH
            // this engine listener AND server.js's onInstance (its cb) — both carry this finish-hook,
            // so an unguarded wiring registers TWO 'finish' listeners and recordRequest fires twice
            // (counters double-incremented, histogram double-observed). The engine listener claims
            // first; onInstance then skips. Mirrors the RW-F8 _rwTracked claim on the gauge below.
            // Keep the two tops in sync.
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
            // Sibling of the metrics hook above; mirrors the engine-agnostic
            // server.js hook — keep the two in sync. trackRequest() returns an
            // IDEMPOTENT finisher (finish + close can never double-decrement) and
            // excludes /_gina/* control paths inside the lib.
            // RW-F8 first-seer claim (request._rwTracked): this engine listener runs
            // BEFORE it hands off to server.js's onInstance (via cb), and both carry
            // this gauge — an unguarded hook counts a routed request twice. The engine
            // listener claims first; onInstance then skips.
            if (lib.releaseWatch.isActive() && !request._rwTracked) {
                request._rwTracked = true;
                var _rwDone = lib.releaseWatch.trackRequest(request.url);
                response.on('finish', _rwDone);
                response.on('close',  _rwDone);
            }
            // From the original

            acceptEncodingArr = null;
            if ( typeof(request.headers['accept-encoding']) != 'undefined' ) {
                acceptEncodingArr   = request.headers['accept-encoding'].replace(/\s+/g, '').split(/\,/);
            }
            acceptEncoding      = null;
            isBinary            = false;

            // ── #B384 — cross-origin WRITE guard for the /_gina/* control family ────────
            // Twin of the core/server.js gate — see there for the full rationale.
            // Isaac needs its OWN copy rather than inheriting the express one:
            // its fast-path handlers (/_gina/maintenance, /_gina/cache/clear,
            // /_gina/release/rebuild) answer here and never reach server.js's
            // onInstance, so a single copy on the express side would leave
            // precisely the mutating endpoints unguarded under this engine.
            //
            // Placed above every /_gina/* handler so current AND future ones
            // inherit the refusal. SAFE methods are untouched — the Inspector's
            // cross-origin GET/SSE channels are a documented design.
            if (
                /^\/_gina\//.test(request.url)
                && !lib.admin.isSafeMethod(request.method)
                && lib.admin.isCrossOriginWrite(request)
            ) {
                console.warn('[ SERVER ] refused a cross-origin write to `' + request.url.split('?')[0] + '`');

                const xOrgBody = JSON.stringify({
                    error: 'forbidden',
                    message: 'cross-origin write to a /_gina/* control endpoint is refused'
                });

                const xOrgHeaders = _setPoweredByHeader({
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma': 'no-cache',
                    'expires': '0',
                    'content-type': 'application/json; charset=utf8'
                });

                if (response.stream) {
                    response.stream.respond({
                        ':status': 403,
                        ...xOrgHeaders
                    });
                    return response.stream.end(xOrgBody);
                }

                response.writeHead(403, xOrgHeaders);
                return response.end(xOrgBody);
            }

            // healthcheck
            // TODO - add a top level API : server.api.js (check, get ...)
            // TODO - on 90% RAM usage, redirect to `come back later then restart bundle`
            // TODO - check url against wroot : getContext() ?
            if ( request.method.toUpperCase() === 'GET' && /\_gina\/health\/check$/i.test(request.url) ) {

                const healthStatus = JSON.stringify({
                    status: "healthy",
                    timestamp: new Date().toISOString() // Correction : JSON valide (string)
                });

                const healthHeaders = _setPoweredByHeader({
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma': 'no-cache',
                    'expires': '0',
                    'content-type': 'application/json; charset=utf8'
                });

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

            // /_gina/metrics — Prometheus exposition format (#OBS1, slice 2)
            if ( request.method.toUpperCase() === 'GET' && /\/_gina\/metrics$/i.test(request.url) ) {
                if ( !lib.metrics.isClientAllowed(request) ) {
                    var metricsForbiddenBody    = JSON.stringify({ error: 'forbidden', message: '/_gina/metrics: client IP not in app.json metrics.allowFrom' });
                    var metricsForbiddenHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'pragma':        'no-cache',
                        'expires':       '0',
                        'content-type':  'application/json; charset=utf8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 403, ...metricsForbiddenHeaders });
                        return response.stream.end(metricsForbiddenBody);
                    }
                    response.writeHead(403, metricsForbiddenHeaders);
                    return response.end(metricsForbiddenBody);
                }
                if ( !lib.metrics.isEnabled() ) {
                    var metricsDisabledBody    = '# /_gina/metrics — metrics not enabled\n# set app.json metrics.enabled to true and install prom-client (npm install prom-client)\n';
                    var metricsDisabledHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'content-type':  'text/plain; version=0.0.4; charset=utf-8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 503, ...metricsDisabledHeaders });
                        return response.stream.end(metricsDisabledBody);
                    }
                    response.writeHead(503, metricsDisabledHeaders);
                    return response.end(metricsDisabledBody);
                }
                return lib.metrics.getMetrics().then(function(metricsText) {
                    var metricsHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'content-type':  'text/plain; version=0.0.4; charset=utf-8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 200, ...metricsHeaders });
                        return response.stream.end(metricsText);
                    }
                    response.writeHead(200, metricsHeaders);
                    return response.end(metricsText);
                }).catch(function(metricsErr) {
                    var metricsErrBody    = JSON.stringify({ error: 'metrics_error', message: metricsErr.message || String(metricsErr) });
                    var metricsErrHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'content-type':  'application/json; charset=utf8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 500, ...metricsErrHeaders });
                        return response.stream.end(metricsErrBody);
                    }
                    response.writeHead(500, metricsErrHeaders);
                    return response.end(metricsErrBody);
                });
            }

            if ( request.method.toUpperCase() === 'GET' && /\_gina\/info$/i.test(request.url) ) {

                // #S7 — IP allowlist gate. Mirrors the metrics endpoint
                // gate at L605-621. 403 on deny.
                if ( !lib.admin.isClientAllowed(request) ) {
                    var infoForbiddenBody    = JSON.stringify({ error: 'forbidden', message: '/_gina/info: client IP not in app.json admin.allowFrom' });
                    var infoForbiddenHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'pragma':        'no-cache',
                        'expires':       '0',
                        'content-type':  'application/json; charset=utf8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 403, ...infoForbiddenHeaders });
                        return response.stream.end(infoForbiddenBody);
                    }
                    response.writeHead(403, infoForbiddenHeaders);
                    return response.end(infoForbiddenBody);
                }

                var infoPayload = {
                    "cache-is-enabled": server._cacheIsEnabled,
                    "memory"  : process.memoryUsage(),
                    "uptime"  : process.uptime(),
                    "version" : process.version
                };
                if (server._h2Metrics) {
                    infoPayload["http2"] = {
                        activeSessions : server._h2Metrics.activeSessions,
                        totalStreams    : server._h2Metrics.totalStreams,
                        goawayCount    : server._h2Metrics.goawayCount,
                        rstCount       : server._h2Metrics.rstCount,
                        rapidResetBlocked : server._h2Metrics.rapidResetBlocked,
                        extendedConnect : server._h2Metrics.extendedConnect
                    };
                }
                const infoStatus = JSON.stringify(infoPayload);

                const infoHeaders = _setPoweredByHeader({
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma': 'no-cache',
                    'expires': '0',
                    'content-type': 'application/json; charset=utf8'
                });

                // HTTP/2 (Multiplexing)
                if (response.stream) {
                    // On utilise le stream pour garder la session ouverte
                    response.stream.respond({
                        ':status': 200,
                        ...infoHeaders
                    });
                    // fixed: #H1 — was passing infoHeaders (object) instead of infoStatus (JSON string)
                    return response.stream.end(infoStatus);
                }

                // Fallback HTTP/1.1
                response.writeHead(200, infoHeaders);
                return response.end(infoStatus);
            }

            if ( request.method.toUpperCase() === 'GET' && /\/_gina\/cache\/stats$/i.test(request.url) ) {

                // #S7 — IP allowlist gate. Same shape as the /_gina/info gate above.
                if ( !lib.admin.isClientAllowed(request) ) {
                    var cacheStatsForbiddenBody    = JSON.stringify({ error: 'forbidden', message: '/_gina/cache/stats: client IP not in app.json admin.allowFrom' });
                    var cacheStatsForbiddenHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'pragma':        'no-cache',
                        'expires':       '0',
                        'content-type':  'application/json; charset=utf8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 403, ...cacheStatsForbiddenHeaders });
                        return response.stream.end(cacheStatsForbiddenBody);
                    }
                    response.writeHead(403, cacheStatsForbiddenHeaders);
                    return response.end(cacheStatsForbiddenBody);
                }

                cache.from(server._cached);
                const cacheStatsPayload = cache.stats();
                // #RC5 — L2 (redis) health when a render-cache store was wired at boot:
                // an ADDITIVE `l2` field, mirroring the engine-agnostic server.js handler
                // (/_gina/* parity). health() is sync — no network on the admin path.
                if ( process.gina && process.gina._renderCacheStore
                        && typeof(process.gina._renderCacheStore.health) === 'function' ) {
                    cacheStatsPayload.l2 = process.gina._renderCacheStore.health();
                }
                const cacheStatsData = JSON.stringify(cacheStatsPayload);
                const cacheStatsHeaders = _setPoweredByHeader({
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma': 'no-cache',
                    'expires': '0',
                    'content-type': 'application/json; charset=utf8'
                });
                // HTTP/2 (Multiplexing)
                if (response.stream) {
                    response.stream.respond({ ':status': 200, ...cacheStatsHeaders });
                    return response.stream.end(cacheStatsData);
                }
                // Fallback HTTP/1.1
                response.writeHead(200, cacheStatsHeaders);
                return response.end(cacheStatsData);
            }

            // ── /_gina/cache/clear — flush the render/output cache (always-on, admin-gated) ──
            // (#RC) POST only — a cache flush is a mutation, never a safe/idempotent
            // GET. Same admin IP allowlist as /_gina/cache/stats. Scoped to the
            // static:/data: output namespaces via renderCache.clear() — never wipes
            // swig: compiled templates or http2session: entries. Optional
            // ?bundle=<name> restricts the flush to one bundle; optional ?event=<name>
            // evicts only the entries registered to that event (the route's
            // cache.invalidateOnEvents) and takes precedence over ?bundle.
            // Current-namespace fs bodies are removed via the entries' cleanup fns;
            // old-namespace fs orphans are reclaimed by the CLI (gina cache:clear).
            if ( request.method.toUpperCase() === 'POST' && /\/_gina\/cache\/clear(\?.*)?$/i.test(request.url) ) {

                if ( !lib.admin.isClientAllowed(request) ) {
                    var cacheClearForbiddenBody    = JSON.stringify({ error: 'forbidden', message: '/_gina/cache/clear: client IP not in app.json admin.allowFrom' });
                    var cacheClearForbiddenHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'pragma':        'no-cache',
                        'expires':       '0',
                        'content-type':  'application/json; charset=utf8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 403, ...cacheClearForbiddenHeaders });
                        return response.stream.end(cacheClearForbiddenBody);
                    }
                    response.writeHead(403, cacheClearForbiddenHeaders);
                    return response.end(cacheClearForbiddenBody);
                }

                var cacheClearBundle = null;
                var cacheClearEvent  = null;
                var cacheClearQi     = request.url.indexOf('?');
                if ( cacheClearQi > -1 ) {
                    var cacheClearQs = new URLSearchParams(request.url.slice(cacheClearQi + 1));
                    cacheClearBundle = cacheClearQs.get('bundle') || null;
                    cacheClearEvent  = cacheClearQs.get('event')  || null;
                }
                renderCache.from(server._cached);
                // `event` wins over `bundle`. Load-bearing: `event` used to be an unread
                // param, so ?event=<name> fell through with bundle === null and silently
                // flushed EVERY bundle's output cache — the opposite of the narrow
                // eviction the caller asked for.
                var cacheClearedCount   = ( cacheClearEvent )
                                            ? renderCache.invalidateByEvent(cacheClearEvent)
                                            : renderCache.clear(cacheClearBundle);
                const cacheClearData    = ( cacheClearEvent )
                                            ? JSON.stringify({ ok: true, event: cacheClearEvent, cleared: cacheClearedCount })
                                            : JSON.stringify({ ok: true, bundle: cacheClearBundle, cleared: cacheClearedCount });
                const cacheClearHeaders = _setPoweredByHeader({
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma': 'no-cache',
                    'expires': '0',
                    'content-type': 'application/json; charset=utf8'
                });
                // HTTP/2 (Multiplexing)
                if (response.stream) {
                    response.stream.respond({ ':status': 200, ...cacheClearHeaders });
                    return response.stream.end(cacheClearData);
                }
                // Fallback HTTP/1.1
                response.writeHead(200, cacheClearHeaders);
                return response.end(cacheClearData);
            }

            // ── /_gina/release/* — stale built-release watch (#RWATCH) ───────────
            // Isaac fast-path mirrors of the engine-agnostic server.js handlers —
            // keep methods + shapes identical across engines. Present ONLY when the
            // service armed at boot (local scope + non-dev + server.releaseWatch
            // .enabled): when inactive the URLs fall through to routing and 404.
            // Same admin IP allowlist as /_gina/info & /_gina/cache/*.
            if (
                lib.releaseWatch.isActive()
                && request.method.toUpperCase() === 'GET'
                && /^\/_gina\/release\/status$/i.test(request.url)
            ) {
                if ( !lib.admin.isClientAllowed(request) ) {
                    var _rwStatusForbiddenBody    = JSON.stringify({ error: 'forbidden', message: '/_gina/release/status: client IP not in app.json admin.allowFrom' });
                    var _rwStatusForbiddenHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'content-type' : 'application/json; charset=utf8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 403, ..._rwStatusForbiddenHeaders });
                        return response.stream.end(_rwStatusForbiddenBody);
                    }
                    response.writeHead(403, _rwStatusForbiddenHeaders);
                    return response.end(_rwStatusForbiddenBody);
                }
                var _rwStatusBody    = JSON.stringify(lib.releaseWatch.getStatus());
                var _rwStatusHeaders = _setPoweredByHeader({
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'content-type' : 'application/json; charset=utf8'
                });
                if (response.stream) {
                    response.stream.respond({ ':status': 200, ..._rwStatusHeaders });
                    return response.stream.end(_rwStatusBody);
                }
                response.writeHead(200, _rwStatusHeaders);
                return response.end(_rwStatusBody);
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
                    var _rwRebuildForbiddenBody    = JSON.stringify({ error: 'forbidden', message: '/_gina/release/rebuild: client IP not in app.json admin.allowFrom' });
                    var _rwRebuildForbiddenHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'content-type' : 'application/json; charset=utf8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 403, ..._rwRebuildForbiddenHeaders });
                        return response.stream.end(_rwRebuildForbiddenBody);
                    }
                    response.writeHead(403, _rwRebuildForbiddenHeaders);
                    return response.end(_rwRebuildForbiddenBody);
                }
                var _rwRebuildHeaders = _setPoweredByHeader({
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'content-type' : 'application/json; charset=utf8'
                });
                var _rwRestartMatch = request.url.match(/[?&]restart=(auto|skip|force)\b/i);
                var _rwRestart      = _rwRestartMatch ? _rwRestartMatch[1].toLowerCase() : 'auto';
                var _rwStatusNow    = lib.releaseWatch.getStatus();
                var _rwCode         = 200;
                var _rwBody         = null;
                if ( _rwRestart === 'force' && _rwStatusNow && _rwStatusNow.action && _rwStatusNow.action.state === 'waiting' ) {
                    _rwBody = JSON.stringify({ accepted: true, forcedGate: lib.releaseWatch.forceRestartGate() });
                } else {
                    var _rwResult = lib.releaseWatch.requestRebuild({ restart: _rwRestart, requestedBy: 'operator' });
                    if ( !_rwResult.accepted ) {
                        _rwCode = 409;
                    }
                    _rwBody = JSON.stringify(_rwResult);
                }
                if (response.stream) {
                    response.stream.respond({ ':status': _rwCode, ..._rwRebuildHeaders });
                    return response.stream.end(_rwBody);
                }
                response.writeHead(_rwCode, _rwRebuildHeaders);
                return response.end(_rwBody);
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
                    var _rwEventsForbiddenBody    = JSON.stringify({ error: 'forbidden', message: '/_gina/release/events: client IP not in app.json admin.allowFrom' });
                    var _rwEventsForbiddenHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'content-type' : 'application/json; charset=utf8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 403, ..._rwEventsForbiddenHeaders });
                        return response.stream.end(_rwEventsForbiddenBody);
                    }
                    response.writeHead(403, _rwEventsForbiddenHeaders);
                    return response.end(_rwEventsForbiddenBody);
                }
                var _rwSseHeaders = _setPoweredByHeader({
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache, no-store',
                    'connection': 'keep-alive',
                    'x-content-type-options': 'nosniff'
                });
                var _rwWrite, _rwOnClose;
                // HTTP/2
                if (response.stream) {
                    response.stream.respond({ ':status': 200, ..._rwSseHeaders });
                    _rwWrite   = function(d) { try { response.stream.write(d); } catch(e){} };
                    _rwOnClose = function(fn) { response.stream.on('close', fn); };
                } else {
                    // HTTP/1.1
                    response.writeHead(200, _rwSseHeaders);
                    _rwWrite   = function(d) { try { response.write(d); } catch(e){} };
                    _rwOnClose = function(fn) { request.on('close', fn); };
                }
                _rwWrite(':ok\n\n');

                var _rwSseSend = function(evt) {
                    _rwWrite('data: ' + JSON.stringify(evt) + '\n\n');
                };
                // initial frame: the current status snapshot
                _rwSseSend({ type: 'status', data: lib.releaseWatch.getStatus(), at: Date.now() });
                var _rwUnsubscribe = lib.releaseWatch.subscribe(_rwSseSend);

                if (!process.gina._sseConnections) process.gina._sseConnections = new Set();
                var _rwSseClose = function() {
                    if (_rwUnsubscribe) { try { _rwUnsubscribe(); } catch (e) {} }
                    process.gina._sseConnections.delete(_rwSseClose);
                    try {
                        if (response.stream) response.stream.end();
                        else response.end();
                    } catch (e) {}
                };
                process.gina._sseConnections.add(_rwSseClose);
                _rwOnClose(_rwSseClose);

                return; // keep the connection open — do not end the response
            }

            // ── /_gina/jobs/:id — async-job status (#AI6 slice 3) ────────────────
            // Always-on, state-only: returns lib.job.toStatusView (id + state +
            // timestamps), never result / error. Engine-agnostic handler lives in
            // server.js; this is the Isaac (HTTP/2) fast-path. 404 on unknown /
            // malformed id.
            var _jobsMatch = (request.method.toUpperCase() === 'GET')
                ? request.url.match(/\/_gina\/jobs\/([A-Za-z0-9_-]+)\/?(\?.*)?$/)
                : null;
            if ( _jobsMatch ) {
                var _jobsId      = _jobsMatch[1];
                var _jobsHeaders = _setPoweredByHeader({
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma': 'no-cache',
                    'expires': '0',
                    'content-type': 'application/json; charset=utf8'
                });
                return lib.job.get(_jobsId, function(_jErr, _jRec) {
                    var _jobsStatus, _jobsBody;
                    if (_jErr || !_jRec) {
                        _jobsStatus = 404;
                        _jobsBody   = JSON.stringify({ error: 'not_found', message: '/_gina/jobs/' + _jobsId + ': unknown job id' });
                    } else {
                        _jobsStatus = 200;
                        _jobsBody   = JSON.stringify(lib.job.toStatusView(_jRec));
                    }
                    if (response.stream) {
                        response.stream.respond({ ':status': _jobsStatus, ..._jobsHeaders });
                        return response.stream.end(_jobsBody);
                    }
                    response.writeHead(_jobsStatus, _jobsHeaders);
                    return response.end(_jobsBody);
                });
            }

            // ── /_gina/maintenance — maintenance-mode control (always-on, admin-gated) ──
            // (#MAINT1) Twin of the core/server.js handler — keep in sync per the
            // /_gina/* endpoint rule. GET returns status; POST {enable:bool[,
            // ttlSeconds,retryAfter,message]} flips it. Admin IP-allowlist gated like
            // /_gina/info and the cache family — an operational switch, not a
            // data-capture toggle — and declared ABOVE the maintenance gate itself so
            // the operator can always reach their own off switch while the window is
            // open. The runtime override is NOT persisted; `ttlSeconds` expiry reverts
            // to CONFIG (never to "off"), so a forgotten timer cannot re-open a site
            // settings.json says is closed.
            if (
                ( request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST' )
                && /\/_gina\/maintenance(?:\?|$)/.test(request.url)
            ) {
                var _mtCtlHeaders = _setPoweredByHeader({
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma':        'no-cache',
                    'expires':       '0',
                    'content-type':  'application/json; charset=utf8'
                });
                var _mtSend = function(status, payload) {
                    var _b = JSON.stringify(payload);
                    if (response.stream) {
                        response.stream.respond({ ':status': status, ..._mtCtlHeaders });
                        return response.stream.end(_b);
                    }
                    response.writeHead(status, _mtCtlHeaders);
                    return response.end(_b);
                };

                if ( !lib.admin.isClientAllowed(request) ) {
                    return _mtSend(403, { error: 'forbidden', message: '/_gina/maintenance: client IP not in app.json admin.allowFrom' });
                }

                var _mtCtl = server._maintenance;
                if ( !_mtCtl ) {
                    return _mtSend(503, { error: 'unavailable', message: '/_gina/maintenance: state not initialised' });
                }

                // The status payload NEVER carries bypassKey — only whether one is
                // configured, which is what an operator needs to know before closing
                // a site they might then be unable to browse.
                var _mtStatus = function() {
                    var _now    = Date.now();
                    var _eff    = lib.maintenance.effectiveConf(_mtCtl, _now);
                    var _rt     = _mtCtl.runtime;
                    var _rtLive = !!( _rt && !( typeof(_rt.until) == 'number' && _rt.until <= _now ) );
                    return {
                        bundle       : server._wsBundle || (typeof getContext === 'function' ? getContext('bundle') : null),
                        active       : lib.maintenance.isActive(_mtCtl, _now),
                        source       : _rtLive ? 'runtime' : 'config',
                        retryAfter   : _eff.retryAfter,
                        message      : _eff.message,
                        until        : ( _rtLive && _rt && typeof(_rt.until) == 'number' ) ? new Date(_rt.until).toISOString() : null,
                        hasBypassKey : !!( _eff.bypassKey && _eff.bypassKey.length )
                    };
                };

                if ( request.method.toUpperCase() === 'GET' ) {
                    return _mtSend(200, _mtStatus());
                }

                return _readInstrumentBody(request, function(_mbErr, _mbBody) {
                    if ( _mbErr ) {
                        return _mtSend(400, { error: 'bad_request', message: '/_gina/maintenance: ' + _mbErr.message });
                    }
                    if ( !_mbBody || ( _mbBody.enable !== true && _mbBody.enable !== false ) ) {
                        return _mtSend(400, { error: 'bad_request', message: '/_gina/maintenance: body must be {"enable":true|false[,"ttlSeconds":N,"retryAfter":N,"message":"…"]}' });
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
                        return _mtSend(400, { error: 'bad_request', message: '/_gina/maintenance: `ttlSeconds` must be an integer from 1 to 86400 (24h) — for a window that must outlive a day or a restart, set settings.json > server.maintenance.enabled: true' });
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

                    console.warn('[maintenance] maintenance mode turned '
                        + ( _rtNew.active ? 'ON' : 'OFF' ) + ' via POST /_gina/maintenance'
                        + ( _rtNew.until ? (' until ' + new Date(_rtNew.until).toISOString()) : '' )
                        + ' — runtime override, NOT persisted across a restart.');

                    return _mtSend(200, _mtStatus());
                });
            }

            // ── /_gina/instrument — toggleable instrumentation window (#INS10) ──
            // Opt-in (inspector.instrumentation.enabled) + key-auth required EVEN
            // in dev. GET → window status; POST {enable,ttlSeconds} → open/close.
            // Off-by-default: when not enabled the block does not match and the
            // request 404s through normal routing. Isaac HTTP/2 + HTTP/1.1 dual.
            if (
                process.gina && process.gina._inspectorInstrumentEnabled
                && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')
                && /\/_gina\/instrument(?:\?|$)/.test(request.url)
            ) {
                var _instrHeaders = _setPoweredByHeader({
                    'content-type':  'application/json; charset=utf8',
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'access-control-allow-origin': '*'
                });
                var _instrSend = function(_code, _payload) {
                    var _bodyStr = JSON.stringify(_payload);
                    if (response.stream) {
                        try {
                            response.stream.respond({ ':status': _code, ..._instrHeaders });
                            return response.stream.end(_bodyStr);
                        } catch (e) { return; }
                    }
                    response.writeHead(_code, _instrHeaders);
                    return response.end(_bodyStr);
                };
                if (!_instrumentKeyValid(request)) {
                    return _instrSend(401, { error: 'forbidden', message: '/_gina/instrument: invalid or missing inspector key' });
                }
                if (request.method.toUpperCase() === 'GET') {
                    return _instrSend(200, lib.instrument.status());
                }
                return _readInstrumentBody(request, function(_bErr, _body) {
                    if (_bErr) {
                        return _instrSend(400, { error: 'bad_request', message: '/_gina/instrument: ' + _bErr.message });
                    }
                    if (_body && _body.enable === false) {
                        var _stClose = lib.instrument.close();
                        console.warn('[inspector-instrument] window closed via /_gina/instrument');
                        return _instrSend(200, _stClose);
                    }
                    if (_body && _body.enable === true) {
                        var _stOpen = lib.instrument.open(_body.ttlSeconds);
                        console.warn('[inspector-instrument] window opened via /_gina/instrument for ' + Math.round(_stOpen.remainingMs / 1000) + 's');
                        return _instrSend(200, _stOpen);
                    }
                    return _instrSend(400, { error: 'bad_request', message: '/_gina/instrument: body must be {"enable":true|false[,"ttlSeconds":N]}' });
                });
            }

            // ── Inspector SPA — served at /_gina/inspector/ in dev mode ──────────
            if (
                isCacheless
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/inspector(\/.*)?$/.test(request.url)
            ) {
                // Activate profiling on first Inspector access — one-way flag,
                // stays true until bundle restart. QI (controller.js:257) gates
                // on this; it must be true before any request is processed.
                if (!process.gina._inspectorActive) process.gina._inspectorActive = true;
                var _inspBase = __dirname + '/asset/plugin/dist/vendor/gina/inspector';
                var _inspPath = request.url.replace(/^.*\/_gina\/inspector\/?/, '').split('?')[0];
                if (!_inspPath || _inspPath === '') _inspPath = 'index.html';

                var _inspMime = {
                    'html':  'text/html; charset=utf8',
                    'js':    'application/javascript; charset=utf8',
                    'css':   'text/css; charset=utf8',
                    'svg':   'image/svg+xml',
                    'woff2': 'font/woff2',
                    'woff':  'font/woff'
                };
                var _inspExt  = _inspPath.split('.').pop();
                var _inspFile = _(_inspBase + '/' + _inspPath, true);

                // #B179 — reject any path that canonicalises outside the Inspector
                // asset root, BEFORE any fs access. `_inspPath` is taken straight
                // off `request.url` with no `..` handling, and `_()` NORMALISES
                // traversal (helpers/path.js:87) rather than rejecting it — so a
                // request-target carrying a literal `..` otherwise resolves to any
                // absolute path the bundle process can read. Falls through to the
                // same 404 as a missing file — no distinct signal. Mirrors the #B64
                // static-resolver guard in server.js.
                if (confineToBase(_inspFile, _inspBase) !== null && fs.existsSync(_inspFile)) {
                    var _inspBinary = /^(woff2?|png|ico|gif|jpe?g)$/.test(_inspExt);
                    var _inspHeaders = _setPoweredByHeader({
                        'content-type': _inspMime[_inspExt] || 'application/octet-stream',
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'x-content-type-options': 'nosniff',
                        'access-control-allow-origin': '*'
                    });
                    var _inspData = fs.readFileSync(_inspFile, _inspBinary ? undefined : 'utf8');

                    // HTTP/2
                    if (response.stream) {
                        response.stream.respond({ ':status': 200, ..._inspHeaders });
                        return response.stream.end(_inspData);
                    }

                    // HTTP/1.1
                    response.writeHead(200, _inspHeaders);
                    console.info(request.method + ' [200] ' + request.url);
                    return response.end(_inspData);
                }
                // Fall through to 404 if file not found
            }

            // ── Server-side log streaming — SSE at /_gina/logs in dev mode ──
            if (
                isCacheless
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/logs$/.test(request.url)
            ) {
                if (!process.gina._inspectorActive) process.gina._inspectorActive = true;
                var _ansiRe = /\x1B\[\d+m/g;

                var _sseHeaders = _setPoweredByHeader({
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache, no-store',
                    'connection': 'keep-alive',
                    'x-content-type-options': 'nosniff',
                    'access-control-allow-origin': '*'
                });

                var _write, _onClose;

                // HTTP/2
                if (response.stream) {
                    response.stream.respond({ ':status': 200, ..._sseHeaders });
                    _write   = function(d) { try { response.stream.write(d); } catch(e){} };
                    _onClose = function(fn) { response.stream.on('close', fn); };
                } else {
                    // HTTP/1.1
                    response.writeHead(200, _sseHeaders);
                    _write   = function(d) { try { response.write(d); } catch(e){} };
                    _onClose = function(fn) { request.on('close', fn); };
                }

                _write(':ok\n\n');

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
                        _write('data: ' + evt + '\n\n');
                    } catch (e) {}
                };

                if (!process.gina._sseConnections) process.gina._sseConnections = new Set();
                var _sseClose = function() {
                    process.removeListener('logger#default', _sseLogListener);
                    process.gina._sseConnections.delete(_sseClose);
                    try {
                        if (response.stream) response.stream.end();
                        else response.end();
                    } catch (e) {}
                };

                process.on('logger#default', _sseLogListener);
                process.gina._sseConnections.add(_sseClose);
                _onClose(_sseClose);

                console.info(request.method + ' [200] ' + request.url + ' (SSE)');
                return; // keep the connection open
            }

            // ── Inspector agent — combined SSE at /_gina/agent in dev mode ──
            if (
                (isCacheless || (process.gina && process.gina._inspectorAgentEnabled))
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/agent(?:\?|$)/.test(request.url)
            ) {
                // #INS9b — outside dev mode the agent endpoint requires a valid
                // key (x-gina-inspector-key header or ?key= query param). In dev
                // (isCacheless) it stays open with no key, preserving #INS9a.
                if (!isCacheless && !_agentKeyValid(request)) {
                    var _agDenyBody    = JSON.stringify({ error: 'forbidden', message: '/_gina/agent: invalid or missing inspector key' });
                    var _agDenyHeaders = _setPoweredByHeader({
                        'cache-control': 'no-cache, no-store, must-revalidate',
                        'content-type':  'application/json; charset=utf8'
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 401, ..._agDenyHeaders });
                        return response.stream.end(_agDenyBody);
                    }
                    response.writeHead(401, _agDenyHeaders);
                    return response.end(_agDenyBody);
                }
                if (!process.gina._inspectorActive) process.gina._inspectorActive = true;
                var _agAnsiRe = /\x1B\[\d+m/g;

                var _agHeaders = _setPoweredByHeader({
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache, no-store',
                    'connection': 'keep-alive',
                    'access-control-allow-origin': '*',
                    'x-content-type-options': 'nosniff'
                });

                var _agWrite, _agOnClose;

                // HTTP/2
                if (response.stream) {
                    response.stream.respond({ ':status': 200, ..._agHeaders });
                    _agWrite   = function(d) { try { response.stream.write(d); } catch(e){} };
                    _agOnClose = function(fn) { response.stream.on('close', fn); };
                } else {
                    // HTTP/1.1
                    response.writeHead(200, _agHeaders);
                    _agWrite   = function(d) { try { response.write(d); } catch(e){} };
                    _agOnClose = function(fn) { request.on('close', fn); };
                }

                _agWrite(':ok\n\n');

                // Send current snapshot immediately if available; otherwise
                // send a lightweight "connected" frame so the Inspector shows
                // the bundle identity without waiting for the first request.
                // #INS10 — only replay the last snapshot to a connecting client in dev OR
                // during an active instrumentation window; never leak a post-window snapshot
                // to a late client (the redacted snapshot lingers in memory until overwritten).
                if ((isCacheless || lib.instrument.isActive()) && server._lastGinaData) {
                    try {
                        _agWrite('event: data\ndata: ' + JSON.stringify(server._lastGinaData) + '\n\n');
                    } catch (e) {}
                } else {
                    try {
                        var _initEnv = {
                            bundle : options.bundle || '',
                            env    : env || ''
                        };
                        var _initPayload = { gina: { environment: _initEnv }, user: { environment: _initEnv } };
                        _agWrite('event: data\ndata: ' + JSON.stringify(_initPayload) + '\n\n');
                    } catch (e) {}
                }

                // Data updates — emitted by render-swig.js on every HTML render
                var _agDataListener = function(payload) {
                    try {
                        _agWrite('event: data\ndata: ' + JSON.stringify(payload) + '\n\n');
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
                        _agWrite('event: log\ndata: ' + evt + '\n\n');
                    } catch (e) {}
                };

                // #AISTREAM — live AI token-stream frames (distinct event so the SPA
                // wires incremental appends without touching the data-snapshot path).
                var _agTokenListener = function(payload) {
                    try {
                        _agWrite('event: token\ndata: ' + JSON.stringify(payload) + '\n\n');
                    } catch (e) {}
                };

                // #EVTBUS — live application-event frames (distinct event so the SPA
                // wires incremental appends, like token).
                var _agEventListener = function(payload) {
                    try {
                        _agWrite('event: event\ndata: ' + JSON.stringify(payload) + '\n\n');
                    } catch (e) {}
                };

                if (!process.gina._sseConnections) process.gina._sseConnections = new Set();
                var _agClose = function() {
                    process.removeListener('inspector#data', _agDataListener);
                    process.removeListener('logger#default', _agLogListener);
                    process.removeListener('inspector#token', _agTokenListener);
                    process.removeListener('inspector#event', _agEventListener);
                    process.gina._sseConnections.delete(_agClose);
                    try {
                        if (response.stream) response.stream.end();
                        else response.end();
                    } catch (e) {}
                };

                process.on('inspector#data', _agDataListener);
                process.on('logger#default', _agLogListener);
                process.on('inspector#token', _agTokenListener);
                process.on('inspector#event', _agEventListener);
                process.gina._sseConnections.add(_agClose);
                _agOnClose(_agClose);

                console.info(request.method + ' [200] ' + request.url + ' (SSE agent)');
                return;
            }

            // ── Live index introspection — JSON at /_gina/indexes in dev mode ──
            // #QI2 — triggers inspector#indexes event; each SQL connector responds
            // with its live index data. Collector aggregates responses.
            if (
                isCacheless
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/indexes$/.test(request.url)
            ) {
                if (!process.gina._inspectorActive) process.gina._inspectorActive = true;

                var _ixListenerCount = process.listenerCount('inspector#indexes');
                var _ixHeaders = _setPoweredByHeader({
                    'content-type': 'application/json; charset=utf8',
                    'cache-control': 'no-cache, no-store',
                    'access-control-allow-origin': '*'
                });

                if (_ixListenerCount === 0) {
                    var _ixEmpty = JSON.stringify({ connectors: {} });
                    if (response.stream) {
                        response.stream.respond({ ':status': 200, ..._ixHeaders });
                        return response.stream.end(_ixEmpty);
                    }
                    response.writeHead(200, _ixHeaders);
                    console.info(request.method + ' [200] ' + request.url);
                    return response.end(_ixEmpty);
                }

                var _ixResults   = {};
                var _ixRemaining = _ixListenerCount;
                var _ixResponded = false;

                var _ixRespond = function() {
                    if (_ixResponded) return;
                    _ixResponded = true;
                    clearTimeout(_ixTimeout);
                    var _ixBody = JSON.stringify({ connectors: _ixResults });
                    if (response.stream) {
                        if (response.stream.destroyed || response.stream.closed) return;
                        response.stream.respond({ ':status': 200, ..._ixHeaders });
                        return response.stream.end(_ixBody);
                    }
                    response.writeHead(200, _ixHeaders);
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
                isCacheless
                && request.method.toUpperCase() === 'GET'
                && /\/_gina\/reveal$/.test(request.url)
            ) {
                var _rvHeaders = _setPoweredByHeader({
                    'content-type': 'application/json; charset=utf8',
                    'cache-control': 'no-cache, no-store',
                    'access-control-allow-origin': '*'
                });

                var _rvSend = function(status, body) {
                    var _rvBody = JSON.stringify(body);
                    if (response.stream) {
                        if (response.stream.destroyed || response.stream.closed) return;
                        response.stream.respond({ ':status': status, ..._rvHeaders });
                        return response.stream.end(_rvBody);
                    }
                    response.writeHead(status, _rvHeaders);
                    console.info(request.method + ' [' + status + '] ' + request.url);
                    response.end(_rvBody);
                };

                if (process.env.NODE_SCOPE !== 'local') {
                    return _rvSend(403, { error: 'reveal forbidden in non-local scope' });
                }

                if (!server._lastGinaDataUnredacted) {
                    return _rvSend(404, { error: 'no snapshot available' });
                }

                return _rvSend(200, server._lastGinaDataUnredacted);
            }

            // Proxy detection - Needs to be place after /_gina/health/*
            isProxyHost = getContext('isProxyHost') || false;
            requestHost = request.headers.host || request.headers[':authority'];
            // console.debug('[PROXY_HOST][isProxyHost='+ isProxyHost +'] request.headers.host -> ' + request.headers.host + '  VS request.headers[":authority"] '+ request.headers[':authority'] +' | '+ request.url);
            // #B65 — request-scope the reverse-proxy host context. Classify THIS
            // request as proxied when its inbound Host is port-less (a reverse proxy
            // rewrote it) OR it carries an X-Forwarded-Host; a raw `host:port` access
            // (no proxy) is never classified proxied, so its URL builders keep
            // resolving the static config host. The per-request result is stashed on
            // the request (request._ginaIsProxyHost / _ginaProxyHost / _ginaProxyHostname
            // — mirrors request._ginaProxyPrefix below) so concurrent requests can't
            // contaminate each other. The worker-global PROXY_* is refreshed on EVERY
            // proxied request (NOT gated on the sticky `isProxyHost` latch) so it can
            // never FREEZE at the first proxied request's value — the same one-shot-gate
            // defect the x-forwarded-prefix block below calls out. Because the globals
            // are only ever written from a proxied request, they can never freeze to a
            // `host:port` (raw) value.
            // #B152 — opt-in: server.proxy.requireForwardedHeaders (boot-resolved
            // to process.gina._proxyRequireForwarded by server.js) disables the
            // port-less-Host heuristic — only an explicit X-Forwarded-Host
            // classifies as proxied. Keep in sync with the core/router.js twin
            // (proxyReqIsProxied).
            // #B367 — SECURITY: every value below is attacker-supplied and is spliced
            // UNESCAPED into the client loader's JS string literals (gina.onload.min.js:
            // `hostname:'{{ page.environment.hostname }}'`, `window.__ginaWebroot='…'`),
            // because whisper() (helpers/context.js:798-802) is a raw token replace with
            // no escaping. A single quote in one of these headers therefore CLOSES the
            // literal and executes arbitrary script on every rendered page, unauthenticated
            // (reproduced over real HTTP). SANITISE AT INGEST rather than escape at
            // emission: a host is `name[:port]` (or a bracketed IPv6 literal) and a prefix
            // is a path — neither legitimately carries a quote, backslash, angle bracket or
            // whitespace — so a malformed value is malformed at the source, and rejecting it
            // here protects EVERY downstream consumer of these slots, not just the loader.
            // Rejection is fail-safe: the request simply falls back to the bundle's internal
            // configured values, exactly as if the header had been absent.
            // Keep in sync with the core/router.js twin.
            var _isSafeHostToken = function(v) {
                return ( typeof(v) == 'string' && v.length > 0 && v.length <= 255
                         && /^[A-Za-z0-9._:\[\]-]+$/.test(v) );
            };
            var _xfhRaw = request.headers['x-forwarded-host'];
            var _xfh    = _isSafeHostToken(_xfhRaw)   ? _xfhRaw   : null;
            var _safeRequestHost = _isSafeHostToken(requestHost) ? requestHost : null;
            // Scheme is a two-value whitelist — it is concatenated straight into the
            // whispered origin, and the pre-#B367 code emitted a literal `undefined://`
            // when the header was absent.
            var _xfpr       = request.headers['x-forwarded-proto'];
            var _safeScheme = ( _xfpr === 'http' || _xfpr === 'https' ) ? _xfpr : null;

            var _thisReqProxied = (
                ( _safeRequestHost && !/\:[0-9]+$/.test(_safeRequestHost)
                    && process.gina._proxyRequireForwarded !== true )
                || _xfh
            ) ? true : false;
            request._ginaIsProxyHost = _thisReqProxied;
            if ( _thisReqProxied ) {
                // this request's proxied host/hostname — X-Forwarded-Host wins (multi-hop:
                // TLS-terminating ingress -> inner proxy -> bundle), else the port-less
                // Host (single-hop: reverse proxy -> bundle).
                if ( _xfh ) {
                    request._ginaProxyHostname = ( _safeScheme || process.gina.PROXY_SCHEME ) +'://'+ _xfh;
                    request._ginaProxyHost     = _xfh;
                } else {
                    // Scheme: X-Forwarded-Proto, then PROXY_SCHEME, then the bundle's own —
                    // the same chain as the core/router.js twin (#B502: this arm read
                    // PROXY_SCHEME alone and ignored an X-Forwarded-Proto the twin honours).
                    // PROXY_SCHEME is the PROJECT's def_scheme (gna.js), so with no
                    // X-Forwarded-Proto an https bundle in an http-default project still
                    // stamps `http://` here and in the twin alike — measured on an isolated
                    // h2 scene; tracked as #B506.
                    request._ginaProxyHostname = ( _safeScheme || process.gina.PROXY_SCHEME || options.scheme ) +'://'+ _safeRequestHost;
                    request._ginaProxyHost     = _safeRequestHost;
                }
                // Refresh the worker-global on EVERY proxied request (freeze fix) — the
                // value is always this request's proxied host, so a later internal
                // direct-host call inherits a correct (never direct-frozen) global.
                // For internal services communications - Eg.: Controller::query()
                process.gina.PROXY_HOSTNAME = request._ginaProxyHostname;
                process.gina.PROXY_HOST     = request._ginaProxyHost;
                // Forcing context - also available for workers (monotonic: only ever true)
                setContext('isProxyHost', true);
            }

            // Path-prefix awareness for upstreams mounted on a sub-path by the
            // reverse proxy. Standard header used by Spring Boot, Traefik,
            // FastAPI, etc. Per-request state (`request._ginaProxyPrefix`) so
            // the value cannot leak across requests when the worker handles a
            // mix of proxied + direct calls or different proxy mounts. Run on
            // EVERY request — gating on `!isProxyHost` like the host/scheme
            // block above would freeze the value at the first proxied
            // request's prefix forever (the gate stops firing after the first
            // proxied request, because `isProxyHost` becomes globally true).
            // Normalised to leading slash + no trailing slash so downstream
            // concatenation with the bundle's internal webroot is stable
            // (e.g. "/admin" + "/" → "/admin/"). Empty or "/" values are
            // dropped (back-compat: header absent or no-op header → property
            // never set, controller falls back to bundle's internal webroot).
            if (request.headers['x-forwarded-prefix']) {
                var _xfp = String(request.headers['x-forwarded-prefix']).trim();
                _xfp = _xfp.replace(/\/+$/, '');
                if (_xfp.length > 0 && _xfp.charAt(0) !== '/') {
                    _xfp = '/' + _xfp;
                }
                // #B367 — SECURITY: this value is concatenated into the public webroot and
                // whispered into `window.__ginaWebroot='…'` in the client loader, so a quote
                // here closes that literal and executes arbitrary script (reproduced over
                // real HTTP). A mount path is percent-encoded URL-path characters only;
                // reject anything else and fall back to the bundle's internal webroot.
                if ( _xfp.length > 255 || !/^[A-Za-z0-9._~\/%-]*$/.test(_xfp) ) {
                    _xfp = '';
                }
                if (_xfp.length > 0) {
                    request._ginaProxyPrefix = _xfp;
                }
            }


            if (
                request.method.toUpperCase() === 'GET' && /\_gina\/assets\/routing\.json$/i.test(request.url)
            ) {
                // server.toApi(reques, response)
                // console.debug('[ SERVER ][200] '+ request.url);
                localAsset = assetsCollection.findOne({ file: request.url.split(/\//g).slice(-1).toString() });
                // #B66 — on a proxied deployment serve the host-stripped routing.json so
                // the browser never receives any bundle's INTERNAL scheme://host:port (an
                // information disclosure) and cross-bundle client toUrl resolves
                // same-origin. Gated on the per-request #B65 classification; RAW (direct
                // host:port) keeps the full blob, byte-identical.
                if ( request._ginaIsProxyHost === true ) {
                    var _strippedRoutingAsset = assetsCollection.findOne({ file: 'routing.stripped.json' });
                    if (_strippedRoutingAsset) {
                        localAsset = _strippedRoutingAsset;
                    }
                }
                // Slice 3 (SPA Tier 1) — per-variant weak ETag, computed once at init by
                // core/server.js beside the maps themselves (#B212 single-builder);
                // ONE weak tag per variant covers this fast-path's content-encoded
                // file representations too. Kept in sync with the engine-agnostic
                // server.js handler per the /_gina/* endpoint rule.
                var _routingAssetEtag = ( request._ginaIsProxyHost === true && options.clientRoutingAssets )
                    ? options.clientRoutingAssets.strippedEtag
                    : ( options.clientRoutingAssets ? options.clientRoutingAssets.fullEtag : null );
                response.setHeader('content-type', localAsset.mime);
                response.setHeader('vary', 'Origin');
                // #B66 — a shared cache must not cross-serve the stripped (proxied) and
                // full (raw) variants under the same URL; mark the proxied variant
                // private. Slice 3 (SPA Tier 1): `no-cache` = revalidate-before-use — each
                // page boot costs one conditional GET (usually a 304), so a restart's
                // new route table reaches returning browsers immediately instead of
                // after the old 24h max-age window.
                response.setHeader('cache-control', ( request._ginaIsProxyHost === true ) ? 'private, no-cache' : 'public, no-cache');
                response.setHeader('x-content-type-options', 'nosniff');
                response.setHeader('x-frame-options', 'DENY');
                response.setHeader('x-xss-protection', '1; mode=block');
                if (_routingAssetEtag) {
                    response.setHeader('etag', _routingAssetEtag);
                }
                // #HDR8 Phase 2 — gated on settings.json > server.hidePoweredBy
                // (inline form because this site uses setHeader instead of the
                // writeHead object-literal headers shape that _setPoweredByHeader covers)
                if (!options.hidePoweredBy) {
                    response.setHeader('X-Powered-By', 'Gina/'+ GINA_VERSION);
                }
                if ( _routingAssetEtag && request.headers['if-none-match'] === _routingAssetEtag ) {
                    response.statusCode = 304;
                    return response.end();
                }

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

            // ── #MAINT1 — maintenance gate (always-on, opt-in) ───────────────────
            // Twin of the core/server.js gate — keep the two in sync per the
            // /_gina/* endpoint rule. PLACEMENT IS THE FEATURE:
            //
            //   AFTER every /_gina/* handler above (liveness keeps answering 200 so
            //   an orchestrator does not restart pods over a declared maintenance
            //   window; the admin endpoints and the maintenance toggle itself stay
            //   reachable, so the operator is never stranded outside their own off
            //   switch) and after the proxied-request classification, whose
            //   `request._ginaIsProxyHost` stamp lib.maintenance reuses rather than
            //   deriving a fourth copy of the #B65 heuristic.
            //
            //   BEFORE this engine's pre-routing render-cache L1 read below, before
            //   the static-asset resolution and before routing — which is what a
            //   middleware-based maintenance mode structurally cannot reach, since
            //   route middleware only runs once a route has matched.
            //
            // Cost when off: one property read plus a boolean.
            //
            // ⚠️ #B383 — THIS GATE MUST STAY SYNCHRONOUS, and so must any future
            // pre-routing gate on either engine. A gate that defers its decision
            // (await / callback / promise / setImmediate) hands control back to
            // the HTTP/2 'stream' emitter, and the raw byte-serving listener in
            // core/server.js then serves the asset underneath it — MEASURED as a
            // 200 bypass, against a synchronous arm that held at 503. The full
            // mechanism is documented at the core/server.js twin.
            var _mtState = server._maintenance;
            if ( _mtState && lib.maintenance.isActive(_mtState) ) {
                var _mtNow     = Date.now();
                var _mtConf    = lib.maintenance.effectiveConf(_mtState, _mtNow);
                var _mtVerdict = lib.maintenance.evaluateBypass(
                    request, _mtConf, _mtNow, (process.gina && process.gina._proxyRequireForwarded)
                );

                if ( !_mtVerdict.allowed ) {
                    if ( _mtVerdict.reason === 'invalid-key' ) {
                        // Never log the presented value — the #B365 precedent.
                        console.warn('[maintenance] a client presented an INVALID bypass key');
                    }
                    var _mtKind    = lib.maintenance.negotiate(request);
                    var _mtBuilt   = lib.maintenance.buildBody(
                        _mtConf, _mtKind, lib.maintenance.langTag(request.headers['accept-language'])
                    );
                    var _mtHeaders = _setPoweredByHeader(
                        lib.maintenance.responseHeaders(_mtConf, _mtBuilt.contentType)
                    );
                    if (response.stream) {
                        response.stream.respond({ ':status': 503, ..._mtHeaders });
                        return response.stream.end(_mtBuilt.body);
                    }
                    response.writeHead(503, _mtHeaders);
                    return response.end(_mtBuilt.body);
                }

                if ( _mtVerdict.grant ) {
                    // Key presented in the URL: hand back a cookie so the rest of
                    // the session needs no secret, then redirect to the same URL
                    // WITHOUT it so the key leaves the address bar, history and
                    // Referer. The Location is the stripped PATH ONLY — never
                    // rebuilt from Host or any X-Forwarded-* header (#B367 proved
                    // those are attacker-controlled; a target built from them is an
                    // open redirect).
                    console.warn('[maintenance] bypass granted to a client presenting a valid key (' + _mtVerdict.reason + ')');
                    var _mtGrantHeaders = _setPoweredByHeader({
                        'cache-control' : 'no-store',
                        'location'      : _mtVerdict.redirectTo || '/',
                        'set-cookie'    : lib.maintenance.buildBypassCookieHeader(
                                              _mtVerdict.cookie, lib.maintenance.isSecureRequest(request)
                                          )
                    });
                    if (response.stream) {
                        response.stream.respond({ ':status': 302, ..._mtGrantHeaders });
                        return response.stream.end();
                    }
                    response.writeHead(302, _mtGrantHeaders);
                    return response.end();
                }
                // cookie / header / allowlisted-and-not-proxied: straight through.
            }

            if (!isCacheless || String(server._cacheIsEnabled).toLowerCase() === 'true') {
                if ( request.method.toUpperCase() === 'GET' ) {
                    var cacheStatus = null;
                    if ( String(server._cacheIsEnabled).toLowerCase() === 'true' ) {
                        // #B238 — identifier from the boot-resolved stamp (server.js
                        // stamps `instance._cacheName` beside `_cacheIsEnabled`; was
                        // the literal 'gina-cache'). Same value as the shared handle()
                        // read's mints — the engines agree on the wire by construction.
                        cacheStatus = server._cacheName;
                    }

                    // Importing cache handler (render/output cache goes through the strategy dispatcher)
                    // Pass options.cachePath so an `fs`-strategy entry can be read back from disk
                    // after a restart (the Map is empty on boot): has()/get() fall back to the disk
                    // body + its `.meta` sidecar. == server.cache.path (the writer's opt.path) by
                    // default — both resolve to the top-level `${cachePath}` (${projectPath}/cache).
                    // #SPA1 — NOTE for anyone adding a per-route guard here: this read
                    // is PRE-ROUTING. It keys off the raw `request.url` and there is no
                    // `request.routing` in scope yet, so a `request.routing.negotiate`
                    // check at this site would be a control that can never fire. A
                    // negotiable route is kept out of the cache by the WRITERS refusing
                    // to store it (render-swig / render-nunjucks writeCache) — which is
                    // precisely why that refusal is load-bearing rather than belt-and-
                    // braces. Do not "fix" this by adding a dead guard.
                    renderCache.from(server._cached, options.cachePath);
                    var cacheKey        = null
                        , hasCachedKey  = false
                        // Output-cache kinds, in check order (data first, then static).
                        // buildKey prepends the release namespace + bundle — the SAME
                        // format the render delegates write with, so a hit never misses
                        // on writer/reader key drift (#C3).
                        , cacheKinds     = ['data', 'static']
                    ;
                    for (let p=0, pLen=cacheKinds.length; p<pLen; p++ ) {
                        cacheKey = renderCache.buildKey(cacheKinds[p], options.bundle, request.url);
                        if ( renderCache.has(cacheKey) ) {
                            hasCachedKey = true;
                            break;
                        }
                    }

                    if ( hasCachedKey ) {
                        // Getting cache from key.
                        // get() may return undefined when a sliding window expires between
                        // has() and get() — treat that as a miss and fall through.
                        cachedContentObj = renderCache.get(cacheKey);
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

                        // #RC5 — physical source of the bytes on THIS request, emitted as
                        // the RFC 9211 §2.8 `detail` parameter: 'memory' = the in-process
                        // L1 Map, 'fs' = the on-disk body read back after a restart (the
                        // fs strategy's restart survival, made observable on the wire).
                        // Same predicate as the memory-vs-fs serve branch below. A redis
                        // L2 warm never labels here — isaac's pre-routing read is L1/fs
                        // only; the shared handle() read (server.js) labels detail=redis.
                        cacheStatus += '; detail=' + ( (typeof(cachedContentObj.fromMemory) != 'undefined') ? 'memory' : 'fs' );

                        // #B130 — same re-nonce as server.js serveRenderCacheHit (keep in
                        // sync): a hit replays the WRITING request's stored headers + body;
                        // when the stored CSP header carries a nonce, mint fresh + rewrite
                        // the header copy and the body occurrences so nonces stay
                        // per-response. The stored entry is never mutated.
                        var _rn = lib.RenderCache.renonceCspHeaders(
                            ( typeof(cachedContentObj.responseHeaders) != 'undefined' )
                                ? cachedContentObj.responseHeaders
                                : null
                        );
                        if ( typeof(cachedContentObj.responseHeaders) != 'undefined' ) {
                            let _rnHeaders = _rn ? _rn.headers : cachedContentObj.responseHeaders;
                            for (let h in _rnHeaders ) {
                                response.setHeader(h, _rnHeaders[h]);
                            }
                        }
                        response.setHeader('Cache-Status', cacheStatus);

                        // Cache-Control: hit path — use remaining TTL so downstream caches don't over-serve (#C6)
                        var _ccHitMaxAge = null;
                        var _ccHitNow = new Date().getTime();
                        if ( cachedContentObj.sliding === true ) {
                            if ( typeof(cachedContentObj.ttl) != 'undefined' && cachedContentObj.ttl > 0 ) {
                                var _ccHitLast = cachedContentObj.lastAccessedAt
                                    ? cachedContentObj.lastAccessedAt.getTime()
                                    : cachedContentObj.createdAt.getTime();
                                _ccHitMaxAge = Math.max(0, Math.floor( (_ccHitLast + Math.round(cachedContentObj.ttl * 1000) - _ccHitNow) / 1000 ));
                            }
                        } else {
                            if ( typeof(cachedContentObj.ttl) != 'undefined' && cachedContentObj.ttl > 0 ) {
                                _ccHitMaxAge = Math.max(0, Math.floor( (cachedContentObj.createdAt.getTime() + Math.round(cachedContentObj.ttl * 1000) - _ccHitNow) / 1000 ));
                            }
                        }
                        if ( _ccHitMaxAge !== null ) {
                            var _ccHitVis = ( cachedContentObj.visibility === 'public' ) ? 'public' : 'private';
                            response.setHeader('Cache-Control', _ccHitVis + ', max-age=' + _ccHitMaxAge);
                        }
                        _ccHitMaxAge = null; _ccHitNow = null;

                        if (
                            typeof(cachedContentObj.fromMemory) != 'undefined'
                        ) {
                            console.info(request.method +' [200]['+ cacheStatus +'] '+ request.url);
                            return response.end(
                                _rn
                                    ? lib.RenderCache.swapNonces(cachedContentObj.content, _rn.oldNonces, _rn.nonce)
                                    : cachedContentObj.content
                            );
                        }

                        filename  =  _(cachedContentObj.filename, true);

                        if ( _rn ) {
                            // #B130 — the re-nonced body needs the whole content in hand;
                            // buffer the disk read-back instead of streaming. Only fires
                            // when the stored headers carry a CSP nonce — nonce-less
                            // entries keep the streaming path below byte-identical.
                            return fs.readFile(filename, 'utf8', function onCachedFileRenonce(err, fileContent) {
                                if (err) {
                                    console.error("[SERVER][CACHE][FILE ERROR] ", err.stack||err.message||err);
                                    // message-only on the wire — the stack stays in the log above
                                    return response.end(''+ (err.message || err));
                                }
                                console.info(request.method +' [200] '+ request.url);
                                return response.end( lib.RenderCache.swapNonces(fileContent, _rn.oldNonces, _rn.nonce) );
                            });
                        }

                        return fs.createReadStream(filename)
                            .on('error', function onError(err) {
                                console.error("[SERVER][CACHE][FILE ERROR] ", err.stack||err.message||err);
                                // #B131 — message-only on the wire, aligned with the
                                // onCachedFileRenonce buffered sibling above; the stack
                                // stays in the log line above (it previously led the
                                // wire fallback chain, putting frames on the wire).
                                return response.end(''+ (err.message || err));
                            })
                            .on('end', function onResponse(){
                                console.info(request.method +' [200] '+ request.url);
                            })
                            .pipe(response);
                    } // EO if ( hasCachedKey )
                    if (cacheStatus) {
                        // #RC5 — RFC 9211 §2.2 miss form: `uri-miss` is a VALUE of the
                        // `fwd` parameter, not a standalone parameter (the bare form
                        // shipped in 0.5.17 read as an unregistered boolean param to
                        // RFC-aware tooling). Same string as the shared handle() read's
                        // genuine-miss emission — the engines agree on the wire.
                        cacheStatus += '; fwd=uri-miss';
                        response.setHeader('Cache-Status', cacheStatus);
                    }


                    cacheKey        = null;
                    hasCachedKey    = null;
                    cacheKinds      = null;
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
                                else if (a[1] && (a[1].indexOf('+') > -1 || a[1].indexOf('%') > -1)) {
                                    // #B17: '+' → space per WHATWG URL form-urlencoded parser; must run before decodeURIComponent (which does NOT decode '+').
                                    if (a[1].indexOf('+') > -1) a[1] = a[1].replace(/\+/g, ' ');
                                    if (a[1].indexOf('%') > -1) a[1] = safeDecodeURIComponent(a[1]); // #B30: malformed-%-safe (raw fallback) — an unguarded decodeURIComponent here crashes the bundle
                                }

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
                            else if (a[1] && (a[1].indexOf('+') > -1 || a[1].indexOf('%') > -1)) {
                                // #B17: '+' → space per WHATWG URL form-urlencoded parser; must run before decodeURIComponent (which does NOT decode '+').
                                if (a[1].indexOf('+') > -1) a[1] = a[1].replace(/\+/g, ' ');
                                if (a[1].indexOf('%') > -1) a[1] = safeDecodeURIComponent(a[1]); // #B30: malformed-%-safe (raw fallback) — an unguarded decodeURIComponent here crashes the bundle
                            }

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
        // #B10 fix: lazy-require engine.io — only loaded when ioServer is configured
        if (Eio === null) {
            Eio = require('engine.io');
        }
        // test done in case we would like to switch to socket.io-server
        ioServer = ( typeof(Eio.attach) != 'undefined' ) ? new Eio.attach(server, options.ioServer) : new Eio(server, options.ioServer);

        server.eio = ioServer;

        /**
         * #B365 — derive a socket's session SERVER-side, from the upgrade
         * request's own cookie, and bind it to `socket.sessionId`.
         *
         * The socket's identity used to be whatever the client asserted in a
         * message payload. Rather than re-implement cookie unsigning here —
         * which would mean handing the framework the session secret that today
         * lives entirely in bundle code — this replays the bundle's OWN session
         * middleware over the upgrade request. Same secret, same store, same
         * cookie name, no configuration, and it works whether or not the bundle
         * adopted `gina.plugins.Session()`.
         *
         * The response passed to it is inert: every header/write method is a
         * no-op, so a `Set-Cookie` can never be emitted from a socket upgrade.
         * Combined with never touching the session object, a `saveUninitialized:
         * false` setup creates and saves nothing.
         *
         * Fail CLOSED: no session middleware, no cookie, or a cookie that does
         * not verify leaves `sessionId` unset, and an unset id matches no
         * targeted push — such a socket receives only deliberate broadcasts.
         *
         * @inner
         * @private
         * @param {object}   socket - The engine.io socket (carries `.request`).
         * @param {function} [cb]   - Called with the bound id (or null) once resolved.
         * @returns {void}
         */
        var bindSocketSession = function(socket, cb) {
            var done = ( typeof(cb) == 'function' ) ? cb : function() {};
            var req  = socket.request;
            if ( req == null || !server._expressMiddlewares || !server._expressMiddlewares.length ) {
                return done(null);
            }
            // express-session's middleware is a NAMED function expression
            // (`return function session(req, res, next)`), and the gina wrapper's
            // absolute-timeout variant is `ginaSessionAbsoluteTimeout` — both are
            // matched here so an adopting and a non-adopting bundle behave alike.
            var chain = [];
            for (var i = 0, len = server._expressMiddlewares.length; i < len; ++i) {
                var fn = server._expressMiddlewares[i];
                if ( typeof(fn) == 'function' && /^(session|ginaSessionAbsoluteTimeout)$/.test(fn.name) ) {
                    chain[chain.length] = fn;
                }
            }
            if ( !chain.length ) {
                return done(null);
            }
            var noop     = function() { return inertRes; };
            var inertRes = {
                setHeader: noop, getHeader: function() { return undefined; },
                removeHeader: noop, appendHeader: noop, writeHead: noop,
                write: function() { return true; }, end: noop,
                on: noop, once: noop, emit: function() { return false; },
                headersSent: false, finished: false
            };
            var idx = 0;
            var next = function(err) {
                if (err) {
                    console.warn('[IO SERVER ] could not derive a session for socket #'+ socket.id +': '+ (err.message || err));
                    return done(null);
                }
                if ( idx >= chain.length ) {
                    var sid = ( typeof(req.sessionID) != 'undefined' && req.sessionID ) ? req.sessionID : null;
                    if (sid) {
                        socket.sessionId = sid;
                    }
                    return done(sid);
                }
                var mw = chain[idx++];
                try {
                    mw(req, inertRes, next);
                } catch (mwErr) {
                    console.warn('[IO SERVER ] session middleware threw while deriving a socket session: '+ (mwErr.message || mwErr));
                    return done(null);
                }
            };
            next();
        };

        ioServer.on('connection', function (socket) {

            // #B365 — bind identity from the connection's own cookie before any
            // message can assert one. Asynchronous (the session store is), so a
            // push racing the handshake simply finds no match yet.
            bindSocketSession(socket);


            socket.send(JSON.stringify({
                id: this.id,//socket.id,
                handshake: 'Welcomed to `'+ options.bundle +'` main socket !',
                // how many ms before sending a new ping packet
                pingTimeout: parseTimeout(options.ioServer.pingTimeout || options.ioServer.timeout),
                // how many ms without a pong packet to consider the connection closed
                pingInterval: parseTimeout(options.ioServer.pingInterval || options.ioServer.interval)
            }));

            // Graceful-shutdown drain: proc.js's SIGTERM path invokes every
            // registered closer before _httpServer.close(), so live engine.io
            // sockets get a graceful close() (write buffer flushed, transport
            // close packet sent) instead of blocking shutdown until the hard
            // timeout. engine.io's close() takes no status code — the discard
            // variant close(true) is the hard teardown ioServer.close() uses.
            if (!process.gina._sseConnections) process.gina._sseConnections = new Set();
            var _eioShutdownCloser = function() {
                try { socket.close(); } catch (e) {}
            };
            process.gina._sseConnections.add(_eioShutdownCloser);

            socket.on('message', function(payload){

                try {
                    console.debug('[IO SERVER ] receiving '+ payload);
                    payload = JSON.parse(payload);
                    // #B365 — the recipient of a targeted push is resolved from
                    // `socket.sessionId`, and that used to be set RIGHT HERE from
                    // `payload.session.id`: a value the CLIENT sends, on every
                    // message, never checked against the connection's own session.
                    // Any client could claim another user's session and receive
                    // the pushes addressed to it — and the page renders the BARE
                    // session id into its bootstrap script, so claiming one needed
                    // strictly less than stealing the cookie.
                    //
                    // The binding now happens once, server-side, at connection
                    // (see bindSocketSession below) from the upgrade request's own
                    // signed cookie. What is left here is a DETECTOR: a client that
                    // still asserts an id we did not derive gets logged and ignored.
                    if (
                        typeof(payload.session) != 'undefined'
                        && payload.session != null
                        && typeof(payload.session.id) != 'undefined'
                        && payload.session.id !== this.sessionId
                    ) {
                        console.warn(
                            '[IO SERVER ] socket #'+ this.id +' asserted session `'+ payload.session.id
                            + '` which does not match the session derived from its own cookie'
                            + ( this.sessionId ? ' (`'+ this.sessionId +'`)' : ' (none)' )
                            + '. Ignoring the assertion (#B365).'
                        );
                    }
                    // Inspector: respond to data pull request. #INS10 — the engine.io
                    // channel is UNAUTHENTICATED, so never serve the captured snapshot
                    // over it outside dev mode. An instrumentation window can populate
                    // _lastGinaData in prod; that data must only leave via the
                    // authenticated /_gina/agent SSE, never this socket.
                    if ( payload.type === 'getGinaData' ) {
                        var _gd = options.isCacheless ? server._lastGinaData : null;
                        if (_gd) {
                            socket.send(JSON.stringify({ type: 'ginaData', data: _gd }));
                        }
                    }
                } catch(err) {
                    console.error(err.stack||err.message|| err)
                }
            });

            // ── Broadcast server-side log entries to connected Inspector ──
            if (options.isCacheless) {
                var _ioAnsiRe = /\x1B\[\d+m/g;

                var _ioLogListener = function(payload) {
                    try {
                        var entry = JSON.parse(payload);
                        var level = entry.level === 'catch' ? 'log' : (entry.level || 'log');
                        var msg   = (entry.content || '').replace(_ioAnsiRe, '').replace(/\n$/, '');
                        if (!msg) return;
                        socket.send(JSON.stringify({
                            type: 'log',
                            data: {
                                t: Date.now(),
                                l: level,
                                b: entry.group || '',
                                s: msg,
                                src: 'server'
                            }
                        }));
                    } catch (e) { /* socket may be closing */ }
                };

                process.on('logger#default', _ioLogListener);
            }

            socket.on('close', function(){
                console.debug('[IO SERVER ] closed socket #'+ this.id);
                if (process.gina._sseConnections) {
                    process.gina._sseConnections.delete(_eioShutdownCloser);
                }
                if (typeof _ioLogListener !== 'undefined') {
                    process.removeListener('logger#default', _ioLogListener);
                }
            });
        });

        server.on('upgrade', function(req, socket, head){
            // #INS8 — defer /_gina/agent upgrades to the WebSocket agent handler
            // attached in server.js; engine.io owns only its own upgrade path.
            if (/\/_gina\/agent(?:\?|$)/.test(req.url || '')) { return; }
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