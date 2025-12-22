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


function writeCache(bundle, opt, jsonContent) {
    if (
        typeof(local.req.routing.cache) == 'undefined'
        ||
        ! local.req.routing.cache
        ||
        ! /^true$/i.test(self.serverInstance._cacheIsEnabled)
    ) {
        return;
    }
    var cacheKey = "data:"+ local.req.originalUrl;
    var responseHeaders = local.res.getHeaders() || {};

    // Caching kinds are: `memory` & `fs`
    var cachingOption = ( typeof(local.req.routing.cache) == 'string' ) ? { type: local.req.routing.cache } : JSON.clone(local.req.routing.cache);
    if ( typeof(cachingOption.ttl) == 'undefined' ) {
        cachingOption.ttl = opt.ttl
    }
    var cacheObject = {
        responseHeaders : responseHeaders
    };
    if ( cachingOption.ttl > 0) {
        cacheObject.ttl = cachingOption.ttl;
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
        var fd = fs.openSync(jsonFilename, 'w'); // Open file for writing
        var buffer = Buffer.from( jsonContent );
        fs.writeSync(fd, buffer, 0, buffer.length, 0); // Write the buffer
        buffer = null;
        fs.closeSync(fd); // Close the file descriptor
        fd = null;

        // filename is mandatory here
        cacheObject.filename = jsonFilename;

        cache.set(cacheKey, cacheObject);
    }

    // Invalidation
    if ( typeof(cachingOption.invalidateOnEvents) != 'undefined' ) {
        if ( !Array.isArray(cachingOption.invalidateOnEvents) ) {
            return self.throwError(response, 500, new Error('cache.invalidateOn must be an array'));
        }
        // Placing event listeners
        cache.setEvents(cacheKey, cachingOption.invalidateOnEvents);
    }
}

/**
 * Render JSON
 *
 * @param {object|string} jsonObj
 * @param {object} [req]
 * @param {object} [res]
 *
 * @callback {function} [next]
 *
 * */
function renderJSON(jsonObj) {
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
    // var stream      = null;
    // if ( /http\/2/.test(local.options.conf.server.protocol) ) {
    //     stream = response.stream;
    // }

    // Added on 2023-06-12
    if ( headersSent(response) ) {
        freeMemory([jsonObj, request, response, next]);
        return;
    }

    if (!jsonObj) {
        jsonObj = {}
    }

    try {
        // Just in case
        if ( typeof(jsonObj) == 'string') {
            jsonObj = JSON.parse(jsonObj)
        }


        // if( typeof(local.options) != "undefined" && typeof(local.options.charset) != "undefined" ){
        //     response.setHeader("charset", local.options.charset);
        // }


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

        // Internet Explorer override
        if ( /msie/i.test(request.headers['user-agent']) ) {
            response.setHeader('content-type', 'text/plain' + '; charset='+ local.options.conf.encoding)
        } else {
            response.setHeader('content-type', local.options.conf.server.coreConfiguration.mime['json'] + '; charset='+ local.options.conf.encoding)
        }

        console.info(request.method +' ['+ response.statusCode +'] '+ request.url);

        var data = JSON.stringify(jsonObj);

        if ( local.options.isXMLRequest && self.isWithCredentials() )  {

            // content length must be the right size !
            var len = Buffer.byteLength(data, 'utf8') || 0;
            if ( !headersSent(response) ) {
                response.setHeader("content-length", len);
            }

            response.write(data);

            // required to close connection
            setTimeout(function () {
                response.end();
                try {
                    response.headersSent = true;
                } catch(err) {
                    // Ignoring warning
                    //console.warn(err);
                }

                if ( next ) {
                    next()
                }

                freeMemory([jsonObj, data, request, response, next]);
            }, 200);

            // force completion
            return
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
            writeCache(self._options.bundle, local.options.conf.server.cache, data);
        }
        response.end(data);
        if (!headersSent(response)) {
            try {
                response.headersSent = true;
            } catch(err) {
                // Ignoring warning
                //console.warn(err);
            }
        }
        if ( next ) {
            return next()
        }

        freeMemory([jsonObj, data, request, response, next]);

        return;

    } catch (err) {
        return self.throwError(response, 500, err);
    }
}

module.exports = function onDeps(deps) {

    self            = deps.self;
    local           = deps.local;
    headersSent     = deps.headersSent;

    return renderJSON;
};