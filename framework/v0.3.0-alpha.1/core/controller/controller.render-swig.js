const fs       = require('fs');
const nodePath = require('path'); // CVE-2023-25345: used for template path boundary enforcement

const lib             = require('./../../lib') || require.cache[require.resolve('./../../lib')];
const Collection      = lib.Collection;
const cache           = new lib.Cache();
var statusCodes       = requireJSON( _( getPath('gina').core + '/status.codes') );
// Precompiled regex — avoids per-request RegExp allocation (#P3)
var blacklistRe       = /[<>]/g;

// Inherited from controller
var self                = null
    , local             = null
    , getData           = null
    , hasViews          = null
    , setResources      = null
    // Default filters
    , SwigFilters       = null
    , headersSent       = null
    , cachePath         = null
;

/**
 * Write the rendered HTML to the cache store (memory or file system).
 * No-op when caching is disabled or the route has no `cache` setting.
 *
 * @inner
 * @param {string} bundle      - Bundle name (used as cache-key namespace)
 * @param {object} opt         - Server cache configuration (`opt.path`, `opt.ttl`)
 * @param {string} htmlContent - Compiled HTML string to cache
 * @returns {Promise<void>}
 */
async function writeCache(bundle, opt, htmlContent) {
    if (
        typeof(local.req.routing.cache) == 'undefined'
        ||
        ! local.req.routing.cache
        ||
        // replaced: /^true$/i.test() (#P6)
        String(self.serverInstance._cacheIsEnabled).toLowerCase() !== 'true'
    ) {
        return;
    }
    // before: "static:" + local.req.originalUrl  (#C3 — added bundle namespace to prevent silent collisions when two bundles serve the same URL path)
    var cacheKey = "static:" + bundle + ":" + local.req.originalUrl;
    var responseHeaders = local.res.getHeaders() || {};
    if ( !cache.has(cacheKey) ) {
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
            cacheObject.content = htmlContent;

            cache.set(cacheKey, cacheObject);
        }

        // Caching to `fs` (file system)
        // Use this method for most of your needs:
        // - prioritize content linked to sessions
        // - default ttl is 3600 sec
        if ( /^fs$/i.test(cachingOption.type) ) {
            var url = local.req.originalUrl;
            // replaced: /\/$/.test(url) (#P7)
            if ( url.endsWith('/') ) {
                url += 'index'
            }
            var htmlFilename = _(opt.path +'/'+ bundle +'/html'+ url + '.html', true);
            var htmlDir = htmlFilename.split(/\//g).slice(0, -1).join('/');
            var htmlDirObj = new _(htmlDir);
            if ( !htmlDirObj.existsSync() ) {
                htmlDirObj.mkdirSync()
            }
            htmlDirObj = null;

            // console.debug("Writting cache to: ", htmlFilename);
            // replaced: openSync/writeSync/closeSync — async write (#P30)
            await fs.promises.writeFile(htmlFilename, htmlContent);

            // filename is mandatory here
            cacheObject.filename = htmlFilename;

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
}
/**
 * Render HTML templates : Swig is the default template engine
 *
 *  Extend default filters
 *  - length
 *
 * Available filters:
 *  - getWebroot()
 *  - getUrl()
 *
 *  N.B.: Filters can be extended through your `<project>/src/<bundle>/templates/swig/filters.js`
 *
 *
 * @param {object}   userData              - Data merged into the template context
 * @param {boolean}  [displayInspector]    - Show the Gina dev inspector when `true`
 * @param {object}   [errOptions]          - Override `local.options` when rendering a custom error page
 * @param {object}   deps                  - Inherited refs from SuperController
 * @param {object}   deps.self             - The SuperController instance
 * @param {object}   deps.local            - Per-request closure (`req`, `res`, `next`, `options`)
 * @param {function} deps.getData          - Returns the merged template data object
 * @param {function} deps.hasViews         - Returns `true` when the route has a template configured
 * @param {function} deps.setResources     - Injects CSS/JS resource tags into the template data
 * @param {object}   deps.swig             - Swig template engine instance
 * @param {object}   deps.SwigFilters      - Custom Swig filter registry
 * @param {function} deps.headersSent      - Returns `true` when response headers are already sent
 * @returns {Promise<void>}
 */
module.exports = async function render(userData, displayInspector, errOptions, deps) {

    // Inherited from controller
    self            = deps.self;
    local           = deps.local;
    getData         = deps.getData;
    hasViews        = deps.hasViews;
    setResources    = deps.setResources;
    // Default filters
    swig            = deps.swig;
    SwigFilters     = deps.SwigFilters;
    headersSent     = deps.headersSent;
;
    // Using server cache to cache compiledTemplates
    cache.from(self.serverInstance._cached);

    cachePath       = self.serverInstance._cachePath;

    var err = null;
    // localOptions must be resolved before the isRenderingCustomError check below
    // because renderCustomError() sets the flag on local.options, not on userData.
    var localOptions = (errOptions) ? errOptions : local.options;
    // isRenderingCustomError is true when either:
    // - userData carries the flag (legacy path via throwError pass-through)
    // - local.options / errOptions carries it (set by renderCustomError at controller.js)
    var isRenderingCustomError = (
                                (typeof(userData) != 'undefined' && userData !== null
                                    && typeof(userData.isRenderingCustomError) != 'undefined'
                                    && String(userData.isRenderingCustomError).toLowerCase() === 'true')
                                || localOptions.isRenderingCustomError === true
                            ) ? true : false;
    if (isRenderingCustomError && userData && typeof(userData.isRenderingCustomError) != 'undefined')
        delete userData.isRenderingCustomError;

    localOptions.renderingStack.push( self.name );
    // preventing multiple call of self.render() when controller is rendering from another required controller
    if ( localOptions.renderingStack.length > 1 && !isRenderingCustomError ) {
        return false;
    }


    var data                = null
        , layout            = null
        , newLayoutFilename = null
        , layoutCacheFailed = false
        // fd removed: no longer needed after async I/O conversion (#P31)
        , buffer            = null
        , compiledTemplate  = null
        , template          = null
        , file              = null
        , path              = null
        , htmlContent       = null
        , cacheKey          = null
        , cacheObject       = null
        , plugin            = null
        // By default
        , isWithoutLayout   = (localOptions.isWithoutLayout) ? true : false
        , stream            = null
    ;

    if ( typeof(local.res.stream) != 'undefined') {
        stream = local.res.stream
    }

    try {
        data = getData();
        // Display session
        if (
            typeof(local.req.session) != 'undefined'
        ) {
            if ( typeof(data.page.data) == 'undefined' ) {
                data.page.data = {};
            }

            if ( typeof(local.req.session.cookie._expires) != 'undefined' ) {
                var dateEnd = local.req.session.cookie._expires;
                var dateStart = ( typeof(local.req.session.lastModified) != 'undefined')
                                ? new Date(local.req.session.lastModified)
                                : new Date()
                ;
                var elapsed = dateEnd - dateStart;
                // var expiresAt =
                if ( typeof(data.page.data.session) == 'undefined' ) {
                    data.page.data.session = {
                        id          : local.req.session.id,
                        lastModified: local.req.session.lastModified
                    };
                }
                // In milliseconds
                data.page.data.session.createdAt    = local.req.session.createdAt;
                data.page.data.session.expiresAt    = dateEnd.format('isoDateTime');
                data.page.data.session.timeout      = elapsed;

                dateEnd     = null;
                dateStart   = null;
                elapsed     = null;
            }
        }

        // in case `local.req.routing.param.file` has been changed on the fly
        if (
            local.req.routing.param.file
            && local.req.routing.param.file != data.page.view.file
        ) {
            data.page.view.file = local.req.routing.param.file;
        }
        if (
            local.req.routing.param.ext
            && local.req.routing.param.ext != data.page.view.ext
        ) {
            data.page.view.ext = local.req.routing.param.ext;
        }
        file = (isRenderingCustomError) ? localOptions.file : data.page.view.file;
        // making path thru [namespace &] file
        if ( typeof(localOptions.namespace) != 'undefined' && localOptions.namespace ) {
            // excepted for custom paths
            var fileNamingConvention = file.replace(localOptions.namespace+'-', '');
            // replaced: !/^(\.|\/|\\)/.test(file) → charAt(0) checks (#P9)
            if ( file.charAt(0) !== '.' && file.charAt(0) !== '/' && file.charAt(0) !== '\\' && file != fileNamingConvention ) {
                var _ext = data.page.view.ext;

                console.warn('file `'+ file +'` used in routing `'+ localOptions.rule +'` does not respect gina naming convention ! You should rename the file `'+ file + _ext +'` to `'+ ''+ fileNamingConvention + _ext +'`');
                console.warn('The reason you are getting this message is because your filename begins with `<namespace>-`\n If you don\‘t want to rename, use template path like ./../'+ localOptions.namespace +'/'+file);
                file = ''+ file.replace(localOptions.namespace+'-', '');
            }
            fileNamingConvention = null;
            _ext = null;


            // means that rule name === namespace -> pointing to root namespace dir
            if (!file || file === localOptions.namespace) {
                file = 'index'
            }
            path = (isRenderingCustomError) ? _(file) : _(localOptions.template.html +'/'+ localOptions.namespace + '/' + file)
        } else {
            if ( localOptions.path && !/(\?|\#)/.test(localOptions.path) ) {
                path = _(localOptions.path);
                // replaced: new RegExp(ext+'$') — use endsWith + slice instead (#P1)
                var _ext = data.page.view.ext;
                if ( _ext && data.page.view.file.endsWith(_ext) ) {
                    data.page.view.path = path.replace('/'+ data.page.view.file, '');

                    path            = path.slice(0, -_ext.length);
                    data.page.view.file  = data.page.view.file.slice(0, -_ext.length);

                } else {
                    data.page.view.path = path.replace('/'+ data.page.view.file, '');
                }
                _ext = null;
            } else {
                    // [CVE-2023-25345] When file starts with . / or \, it was used as-is,
                    // bypassing the template root entirely and allowing traversal to arbitrary
                    // filesystem locations (e.g. file = "../../etc/passwd").
                    // We now validate that any such path resolves within the template root.
                    // path = (!isRenderingCustomError && !/^(\.|\/|\\)/.test(file)) // replaced: CVE-2023-25345
                    //     ? _(localOptions.template.html +'/'+ file)
                    //     : file
                    // replaced: /^(\.|\/|\\)/.test(file) → charAt(0) checks (#P9)
                    if ( (file.charAt(0) === '.' || file.charAt(0) === '/' || file.charAt(0) === '\\') && !isRenderingCustomError ) {
                        var _fileTemplateRoot    = nodePath.resolve(localOptions.template.html);
                        var _fileResolvedPath    = nodePath.resolve(_fileTemplateRoot, file);
                        if ( !_fileResolvedPath.startsWith(_fileTemplateRoot + '/') ) {
                            throw new Error('[CVE-2023-25345] Path traversal attempt blocked: ' + file);
                        }
                        _fileTemplateRoot = null;
                        _fileResolvedPath = null;
                    }
                    // [/CVE-2023-25345]
                    // replaced: !/^(\.|\/|\\)/.test(file) → charAt(0) checks (#P9)
                    path = (!isRenderingCustomError && file.charAt(0) !== '.' && file.charAt(0) !== '/' && file.charAt(0) !== '\\')
                        ? _(localOptions.template.html +'/'+ file)
                        : file
            }
        }

        // replaced: new RegExp(ext+'$') — use endsWith instead (#P2)
        if (data.page.view.ext && !file.endsWith(data.page.view.ext) ) {
            path += data.page.view.ext
        }

        data.page.view.path = path;
    } catch (dataErr) {
        return self.throwError(dataErr);
    }

    // isWithoutLayout from content
    var pageContentObj  = new _(data.page.view.path);
    var _templateContent = null;
    try {
        // replaced: fs.readFileSync — async read (#P28)
        _templateContent = (await fs.promises.readFile(path)).toString()
    } catch (pathException) {
            console.warn("Path exception: ", pathException);
    }
    var hasLayoutInPath = /\{\%(\s+extends|extends)/.test(_templateContent) || false;
    var layoutPath      = null;
    var subFolder       = path.split(/\//g).slice(0, -1).join('/').replace(localOptions.template.html, '') || '';
    var hasSubFolder    = (subFolder && subFolder != '') ? true : false;

    if (
        !isWithoutLayout
        && !isRenderingCustomError
        && pageContentObj.existsSync()
        && !hasLayoutInPath
    ) {
        isWithoutLayout = true;
    }
    pageContentObj = null;

    cacheKey = 'swig:' + localOptions.bundle + subFolder +'/'+ data.page.view.file;
    // Retrieve layoutPath from content
    if (
        hasLayoutInPath
        && _templateContent
        && !cache.has(cacheKey)
    ) {

        // subFolder       = path.split(/\//g).slice(0, -1).join('/').replace(localOptions.template.html, '');
        // hasSubFolder    = (subFolder) ? true : false;
        var extendFound = _templateContent.match(/\{\%(\s+extends|extends)(.*)\%}/);
        if (extendFound && Array.isArray(extendFound)) {
            try {
                // localOptions.template.templates +'/'+
                layoutPath = extendFound[0].match(/(\"|\')(.*)(\"|\')/)[0].replace(/(\"|\')/g, '');

                // adding layout
                var newLayoutPath = 'swig' + subFolder  +'/'+ layoutPath;
                newLayoutFilename = _(cachePath +'/'+ localOptions.bundle +'/'+ newLayoutPath, true);

                // For dev/cacheless envs
                if (
                    String(self.serverInstance._cacheIsEnabled).toLowerCase() !== 'true'
                    && fs.existsSync( newLayoutFilename )
                ) {
                    fs.rmSync( newLayoutFilename )
                }

                if ( !fs.existsSync( newLayoutFilename ) ) {
                    var newLayoutDir = newLayoutFilename.split(/\//g).slice(0, -1).join('/');
                    var newLayoutDirObj = new _(newLayoutDir);
                    if ( !newLayoutDirObj.existsSync() ) {
                        newLayoutDirObj.mkdirSync()
                    }
                    newLayoutDirObj = null;
                    // [CVE-2023-25345] The layoutPath is extracted from the raw {% extends "..." %}
                    // directive in the template file. Without a boundary check, a template containing
                    // {% extends "../../../etc/passwd" %} would cause readFileSync to read arbitrary
                    // files outside the template root (directory traversal / arbitrary file read).
                    // We resolve the path and confirm it stays within localOptions.template.html.
                    // Boundary check now runs BEFORE any file operation (was after openSync previously).
                    var _layoutTemplateRoot     = nodePath.resolve(localOptions.template.html);
                    var _layoutResolvedPath     = nodePath.resolve(_layoutTemplateRoot, layoutPath);
                    if ( !_layoutResolvedPath.startsWith(_layoutTemplateRoot + '/') ) {
                        throw new Error('[CVE-2023-25345] Path traversal attempt blocked in {% extends %}: ' + layoutPath);
                    }
                    _layoutTemplateRoot = null;
                    _layoutResolvedPath = null;
                    // [/CVE-2023-25345]

                    // replaced: openSync/readFileSync/writeSync/closeSync — async read + write (#P29, #P31)
                    // buffer = Buffer.from( fs.readFileSync(localOptions.template.html + '/'+ layoutPath) ); // replaced: CVE-2023-25345
                    buffer = await fs.promises.readFile(localOptions.template.html + '/'+ layoutPath);
                    await fs.promises.writeFile(newLayoutFilename, buffer);
                    buffer = null;
                }

                // updating extends
                _templateContent = _templateContent.replace(layoutPath, _(cachePath +'/'+ localOptions.bundle +'/'+ newLayoutPath, true) );

                // override layout path
                layoutPath = newLayoutPath;

                data.page.view.layout = layoutPath;
                layoutPath = cachePath +'/'+ localOptions.bundle +'/'+ layoutPath;

                localOptions.template.layout = layoutPath;

            } catch (extendErr) {
                // Layout cache setup failed (e.g. EACCES on cache dir).
                // Clear newLayoutFilename so line 1076 does not attempt to write
                // to a directory that was never created, which would produce a
                // misleading ENOENT 500. Rendering continues from the original
                // configured layout path via localOptions.template.layout.
                // layoutCacheFailed suppresses both the swig template cache and
                // writeCache so the warning repeats on every request until fixed.
                newLayoutFilename = null;
                layoutCacheFailed = true;
                console.warn('[render] Layout cache setup failed: ' + (extendErr.stack||extendErr.message||extendErr));
            }
        }
        extendFound = null;
    }

    localOptions.debugMode = ( typeof(displayInspector) == 'undefined' ) ? undefined : ( (/true/i.test(displayInspector)) ? true : false ); // only active for dev env

    // specific override
    if (
        self.isCacheless()
        && typeof(local.req[ local.req.method.toLowerCase() ]) != 'undefined'
        && typeof(local.req[ local.req.method.toLowerCase() ].debug) != 'undefined'
    ) {
        // replaced: /^(true|false)$/i.test() — use string comparison (#P6)
        var _debugVal = String(local.req[ local.req.method.toLowerCase() ].debug).toLowerCase();
        if ( _debugVal !== 'true' && _debugVal !== 'false' ) {
            console.warn('Detected wrong value for `debug`: '+ local.req[ local.req.method.toLowerCase() ].debug);
            console.warn('Switching `debug` to `true` as `cacheless` mode is enabled');
            local.req[ local.req.method.toLowerCase() ].debug = true;
            _debugVal = 'true';
        }
        localOptions.debugMode = _debugVal === 'true';
    } else if (
        self.isCacheless()
        && hasViews()
        && !isWithoutLayout
        && localOptions.debugMode == undefined
    ) {
        localOptions.debugMode = true;
    } else if ( localOptions.debugMode == undefined  ) {
        localOptions.debugMode = self.isCacheless()
    }

    try {

        if (!userData) {
            userData = { page: { view: {}}}
        } else if ( userData && !userData['page']) {

            if ( typeof(data['page']['data']) == 'undefined' )
                data['page']['data'] = userData;
            else
                data['page']['data'] = (isRenderingCustomError) ? userData : merge( userData, data['page']['data'] );
        } else {
            data = (isRenderingCustomError) ? userData : merge(userData, data)
        }

        template = localOptions.rule.replace('\@'+ localOptions.bundle, '');
        var localTemplateConf = localOptions.template;
        if ( isWithoutLayout ) {
            localTemplateConf = JSON.clone(localOptions.template);
            localTemplateConf.javascripts = new Collection(localTemplateConf.javascripts).find({ isCommon: false}, { isCommon: true, name: 'gina' });
            localTemplateConf.stylesheets = new Collection(localTemplateConf.stylesheets).find({ isCommon: false}, { isCommon: true, name: 'gina' });
        }
        setResources(localTemplateConf);

        // Allowing file & ext override
        if (
            typeof(local.req.routing.param.file) != 'undefined'
            && data.page.view.file !== local.req.routing.param.file
        ) {
            data.page.view.file = localOptions.file = local.req.routing.param.file
        }
        if (
            typeof(local.req.routing.param.ext) != 'undefined'
            && data.page.view.ext !== local.req.routing.param.ext
        ) {
            data.page.view.ext = localOptions.template.ext = local.req.routing.param.ext
        }


        // pre-compiling variables
        data = merge(data, getData()); // needed !!

        if  (typeof(data.page.data) == 'undefined' ) {
            data.page.data = {}
        }


        if (
            !localOptions.isRenderingCustomError
            && typeof(data.page.data.status) != 'undefined'
            && !String(data.page.data.status).startsWith('2')
            && typeof(data.page.data.error) != 'undefined'
        ) {

            // Normalize error/message to strings — upstream may send objects (e.g. ApiError
            // instances or plain {message, code} objects). Without normalization the error
            // page renders "[object Object]" as the title. (#Q2)
            var _errDetail = data.page.data.error || data.page.data.message;
            if ( _errDetail && typeof(_errDetail) === 'object' ) {
                _errDetail = _errDetail.message || _errDetail.error || JSON.stringify(_errDetail);
            }
            var _msgDetail = data.page.data.message;
            if ( _msgDetail && typeof(_msgDetail) === 'object' ) {
                _msgDetail = _msgDetail.message || _msgDetail.error || JSON.stringify(_msgDetail);
            }

            var errorObject = {
                status  : data.page.data.status,
                // replaced: statusCodes[data.page.data.status] first — always truthy for known
                // codes, so actual coreapi error reason was always buried. Prioritize the actual
                // error/message from the upstream response; fall back to generic status label. (#Q1)
                // Normalized to string before use — upstream objects would otherwise render as
                // "[object Object]". (#Q2)
                error   : _errDetail || _msgDetail || statusCodes[data.page.data.status] || msg,
                message : _msgDetail || _errDetail,
                stack   : data.page.data.stack
            };
            if ( typeof(data.page.data.session) != 'undefined' ) {
                errorObject.session = data.page.data.session;
            }
            // Log before throwError so the actual error reason appears in the bundle log
            // — throwError may only surface the generic status label otherwise. (#Q1)
            console.error(
                '[render] '+ data.page.data.status +' from upstream'
                + ( _errDetail ? ' — ' + _errDetail : '' )
                + ( data.page.data.stack ? '\n' + data.page.data.stack : '' )
            );

            return self.throwError(errorObject);
        }


        // data.page.view.path = path;

        var dic = {}, msg = '';
        for (let d in data.page) {
            dic['page.'+d] = data.page[d]
        }
        // Flatten page.environment so whisper() can resolve {{ page.environment.key }}
        // placeholders in ginaLoader (gina.onload.min.js), which is inserted after Swig
        // compilation and therefore cannot rely on Swig to substitute these tokens.
        if (typeof data.page.environment === 'object' && data.page.environment !== null) {
            for (let k in data.page.environment) {
                dic['page.environment.' + k] = data.page.environment[k];
            }
        }



        // please, do not start with a slashe when including...
        // ex.:
        //      /inc/_partial.html (BAD)
        //      inc/_partial.html (GOOD)
        //      ./namespace/page.html (GOOD)

        if ( !fs.existsSync(path) ) {
            msg = 'could not open "'+ path +'"' +
                        '\n1) The requested file does not exists in your templates/html (check your template directory). Can you find: '+path +
                        '\n2) Check the following rule in your `'+localOptions.conf.bundlePath+'/config/routing.json` and look around `param` to make sure that nothing is wrong with your file declaration: '+
                        '\n' + localOptions.rule +':'+ JSON.stringify(localOptions.conf.content.routing[localOptions.rule], null, 4) +
                        '\n3) At this point, if you still have problems trying to run this portion of code, you can contact us telling us how to reproduce the bug.'
                        //'\n\r[ stack trace ] '
                        ;
            err = new ApiError(msg, 500);
            console.error(err.stack);
            self.throwError(err);
            return;
        }

        var localRequestPort = local.req.headers.port || local.req.headers[':port'];
        var isProxyHost = (
            typeof(local.req.headers.host) != 'undefined'
            && typeof(localRequestPort) != 'undefined'
            &&  (localRequestPort === '80' || localRequestPort === '443' || localRequestPort === 80 || localRequestPort === 443)
            && localOptions.conf.server.scheme +'://'+ local.req.headers.host+':'+ localRequestPort != localOptions.conf.hostname.replace(/\:\d+$/, '') +':'+ localOptions.conf.server.port
            ||
            typeof(local.req.headers[':authority']) != 'undefined'
            && localOptions.conf.server.scheme +'://'+ local.req.headers[':authority'] != localOptions.conf.hostname
            ||
            typeof(local.req.headers.host) != 'undefined'
            && typeof(localRequestPort) != 'undefined'
            && (localRequestPort === '80' || localRequestPort === '443' || localRequestPort === 80 || localRequestPort === 443)
            && local.req.headers.host == localOptions.conf.host
            ||
            typeof(local.req.headers['x-nginx-proxy']) != 'undefined'
            && String(local.req.headers['x-nginx-proxy']).toLowerCase() === 'true'
            ||
            typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
        ) ? true : false;


        // Setup swig default filters
        var filters = SwigFilters({
            options     : JSON.clone(localOptions),
            isProxyHost : isProxyHost,
            throwError  : self.throwError,
            req         : local.req,
            res         : local.res
        });
        try {

            // To extends default filters with user defined filters, go to controllers/setup.js

            // Allows you to get a bundle web root
            // e.g.: swig.setFilter('getWebroot', filters.getWebroot);
            // e.g.: swig.setFilter('nl2br', filters.nl2br);
            for (let filter in filters) {
                // replaced: !/^getConfig$/.test() — use !== instead (#P11)
                if ( typeof(filters[filter]) == 'function' && filter !== 'getConfig' ) {
                    swig.setFilter(filter, filters[filter]);
                }
            }
        } catch (err) {
            self.throwError(local.res, 500, new Error('[SwigFilters] template filters setup exception encoutered: [ '+path+' ]\n'+(err.stack||err.message)));
            return;
        }


        var  assets                 = null
            , mapping               = null
            , XHRData               = null
            , XHRView               = null
            , isDeferModeEnabled    = null
            , hasExternalsPlugins    = null
            , viewInfos             = null
            , filename              = null
            , isWithSwigLayout      = null
            , isUsingGinaLayout     = (!isWithoutLayout && typeof(localOptions.template.layout) != 'undefined' && fs.existsSync(localOptions.template.layout)) ? true : false
        ;

        if ( isWithoutLayout || isUsingGinaLayout ) {
            layoutPath = (isWithoutLayout) ? localOptions.template.noLayout : localOptions.template.layout;
            // user layout override
            if ( isUsingGinaLayout && !isWithoutLayout ) {
                layoutPath = localOptions.template.layout;
            }
            if (isWithoutLayout) {
                data.page.view.layout = layoutPath;
            }
        }
        // without layout case
        else if (!hasLayoutInPath) {

            // by default
            layoutPath = localOptions.template.layout;
            // replaced: !/^\//.test() (#P8)
            if ( !layoutPath.startsWith('/')) {
                layoutPath = localOptions.template.templates +'/'+ layoutPath;
            }
            // default layout
            if (
                !isWithoutLayout  && !fs.existsSync(layoutPath) && layoutPath == localOptions.template.templates +'/index.html'
            ) {
                console.warn('Layout '+ localOptions.template.layout +' not found, replacing with `nolayout`: '+ localOptions.template.noLayout);
                layoutPath = localOptions.template.noLayout
                isWithoutLayout = true;
                data.page.view.layout = layoutPath;
            }
            // user defined layout
            else if ( !isWithoutLayout && !fs.existsSync(layoutPath) ) {
                isWithSwigLayout = true;
                layoutPath = localOptions.template.noLayout;
                data.page.view.layout = layoutPath;
            }
            // layout defiendd but not found
            else if (!fs.existsSync(layoutPath) ) {
                err = new ApiError(localOptions.bundle +' SuperController exception while trying to load your layout `'+ layoutPath +'`.\nIt seems like you have defined a layout, but gina could not locate the file.\nFor more informations, check your `config/templates.json` declaration around `'+ localOptions.rule.replace(/\@(.*)/g, '') +'`', 500);
                self.throwError(err);
                return;
            }
        }


        // errors first
        if (!headersSent()) {

            //catching errors
            local.res.statusCode = ( typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status])  != 'undefined' ) ? data.page.data.status : 200; // by default

            // HTTP/2 (RFC7540 8.1.2.4):
            // This standard for HTTP/2 explicitly states that status messages are not supported.
            // In HTTP/2, the status is conveyed solely by the numerical status code (e.g., 200, 404, 500),
            // and there is no field for a human-readable status message.
            if (
                typeof(data.page.data.errno) != 'undefined'
                    && String(data.page.data.status).startsWith('2')
                    && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
                    && !/http\/2/.test(localOptions.conf.server.protocol)
                ||
                typeof(data.page.data.status) != 'undefined'
                    && !String(data.page.data.status).startsWith('2')
                    && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
                    && !/http\/2/.test(localOptions.conf.server.protocol)
            ) {

                try {
                    local.res.statusMessage = localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status];
                } catch (err){
                    local.res.statusCode    = 500;
                    local.res.statusMessage = err.stack||err.message||localOptions.conf.server.coreConfiguration.statusCodes[local.res.statusCode];
                }
            }

            local.res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

            try {

                // escape special chars — uses module-level precompiled blacklistRe (#P3)
                // DO NOT REPLACE IT BY JSON.clone() !!!!
                blacklistRe.lastIndex = 0;
                data.page.data = JSON.parse(JSON.stringify(data.page.data).replace(blacklistRe, '\$&'));
            } catch (err) {
                filename = localOptions.template.html;
                // replaced: new RegExp('^' + namespace + '-') — use startsWith instead (#P2)
                filename += ( typeof(data.page.view.namespace) != 'undefined' && data.page.view.namespace != '' && data.page.view.file.startsWith(data.page.view.namespace + '-') ) ? '/' + data.page.view.namespace + data.page.view.file.split(data.page.view.namespace +'-').join('/') + ( (data.page.view.ext != '') ? data.page.view.ext: '' ) : '/' + data.page.view.file+ ( (data.page.view.ext != '') ? data.page.view.ext: '' );
                self.throwError(local.res, 500, new Error('Controller::render(...) compilation error encountered while trying to process template `'+ filename + '`\n' + (err.stack||err.message||err) ));
                filename = null;
                return;
            }
        }


        var isLoadingPartial = false;
        assets  = {assets:"${assets}"};
        // replaced: fs.readFileSync — async read (#P29)
        layout = await fs.promises.readFile(layoutPath, 'utf8');
        // Loading from cache
        if (
            String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'
            && cache.has(cacheKey)
        ) {
            compiledTemplate = cache.get(cacheKey).template;

            // #FI — inject flow data before template execution on the cache-hit path.
            // The cached compiled template includes the __ginaData script (from the
            // miss-path toolbar injection), so data.page.flow must be populated before
            // compiledTemplate(data) for the Inspector to see timeline entries.
            if (local._timeline && local._timeline.entries.length > 0) {
                if (local._queryLog) {
                    for (var _cti = 0; _cti < local._queryLog.length; _cti++) {
                        var _cqe = local._queryLog[_cti];
                        if (_cqe._startMs) {
                            local._timeline.entries.push({
                                label: 'n1ql:' + (_cqe.trigger || 'query'),
                                cat: 'db',
                                startMs: _cqe._startMs,
                                endMs: _cqe._startMs + (_cqe.durationMs || 0),
                                durationMs: _cqe.durationMs || 0,
                                detail: (_cqe.statement || '').substring(0, 80)
                            });
                        }
                    }
                }
                data.page.flow = {
                    requestStart: local._timeline.requestStart,
                    entries: local._timeline.entries
                };
            }
            if (local._queryLog && local._queryLog.length > 0) {
                data.page.queries = local._queryLog;
            }
            // #FI — snapshot count BEFORE late entries are pushed.
            // data.page.flow.entries is a reference to local._timeline.entries,
            // so reading .length later would include entries pushed after this point.
            var _cacheFlowSnapshot = (local._timeline) ? local._timeline.entries.length : 0;

            if ( !headersSent() ) {
                if ( localOptions.isRenderingCustomError ) {
                    localOptions.isRenderingCustomError = false;
                }

                // #FI — template execution timing (cache hit — no compile phase)
                var _cacheExecStart = (local._timeline) ? Date.now() : 0;
                htmlContent = compiledTemplate(data);
                if (_cacheExecStart && local._timeline) {
                    local._timeline.entries.push({
                        label: 'swig-execute', cat: 'template',
                        startMs: _cacheExecStart, endMs: Date.now(),
                        durationMs: Date.now() - _cacheExecStart,
                        detail: (data.page.view.file || null)
                    });
                }
                local.res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

                if (
                    !self.isCacheless()
                    && typeof(local.req.routing.cache) != 'undefined'
                    && local.req.method.toUpperCase() === 'GET'
                    ||
                    // allowing caching even for dev env
                    String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'
                    && typeof(local.req.routing.cache) != 'undefined'
                    && local.req.method.toUpperCase() === 'GET'
                ) {
                    await writeCache(localOptions.bundle, localOptions.conf.server.cache, htmlContent);
                }

                // Cache-Control: miss path — inform browsers/CDNs of the response lifetime (#C6)
                if ( typeof(local.req.routing.cache) != 'undefined' && local.req.routing.cache ) {
                    var _ccCfg = ( typeof(local.req.routing.cache) == 'string' ) ? { type: local.req.routing.cache } : local.req.routing.cache;
                    var _ccTtl = ( typeof(_ccCfg.ttl) != 'undefined' && _ccCfg.ttl > 0 ) ? _ccCfg.ttl : localOptions.conf.server.cache.ttl;
                    if ( _ccTtl > 0 ) {
                        local.res.setHeader('Cache-Control', ( _ccCfg.visibility === 'public' ? 'public' : 'private' ) + ', max-age=' + ~~(_ccTtl));
                    }
                }

                // #FI — response write + total timing (cache hit)
                if (local._timeline) {
                    var _cacheRespEnd = Date.now();
                    var _cacheRwStart = local._timeline._renderStart || local._timeline._actionStart || local._timeline.requestStart;
                    local._timeline.entries.push({
                        label: 'response-write', cat: 'response',
                        startMs: _cacheRwStart, endMs: _cacheRespEnd,
                        durationMs: _cacheRespEnd - _cacheRwStart,
                        detail: null
                    });
                    local._timeline.entries.push({
                        label: 'total', cat: 'total',
                        startMs: local._timeline.requestStart,
                        endMs: _cacheRespEnd,
                        durationMs: _cacheRespEnd - local._timeline.requestStart,
                        detail: null
                    });

                    // Patch late entries into HTML — flow/execute/response/total were pushed
                    // after data.page.flow was set, so the __ginaData script in the cached
                    // template has stale entries. Inject a small correction script.
                    // Uses _cacheFlowSnapshot saved before any late entries were pushed.
                    var _cacheLateEntries = local._timeline.entries.slice(_cacheFlowSnapshot);
                    if (_cacheLateEntries.length > 0 && (displayInspector || self.isCacheless())) {
                        var _cachePatchScript = '<script>if(window.__ginaData&&window.__ginaData.user&&window.__ginaData.user.flow){'
                            + 'var _e=window.__ginaData.user.flow.entries;'
                            + 'var _p=' + JSON.stringify(_cacheLateEntries) + ';'
                            + 'for(var _i=0;_i<_p.length;_i++){_e.push(_p[_i])}'
                            + '}</script>';
                        htmlContent = htmlContent.replace(/<\/body>/i, _cachePatchScript + '</body>');
                    }
                }

                console.info(local.req.method +' ['+local.res.statusCode +'] '+ local.req.url);
                // HEAD: send headers only — body suppressed (HTTP spec §4.3.2)
                if ( /^HEAD$/i.test(local.req.method) ) {
                    local.res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding);
                    local.res.setHeader('content-length', Buffer.byteLength(htmlContent, 'utf8'));
                    local.res.end();
                } else {
                // if ( stream ) {
                //     stream.respond({
                //         'content-type': localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
                //         ':status': 200
                //     });
                //     layout = null;
                //     return stream.end(htmlContent);
                // }
                local.res.end( htmlContent );
                }
                layout = null;
            }

            // Release per-request refs — save next first since local.next is used directly here.
            var _next = ( typeof(local.next) != 'undefined' ) ? local.next : null;
            local.req = null;
            local.res = null;
            local.next = null;
            if ( _next ) return _next();
            return;
        } // EO String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'



        // replaced: /\<html|head|body/i.test() — use toLowerCase().indexOf() (#P14)
        var _layoutLower = layout.toLowerCase();
        isLoadingPartial = (
            _layoutLower.indexOf('<html') < 0
            || _layoutLower.indexOf('<head') < 0
            || _layoutLower.indexOf('<body') < 0
        ) ? true : false;

        // if (isLoadingPartial) {
        //     console.warn('----------------> loading partial `'+ path);
        // }

        isDeferModeEnabled = localOptions.template.javascriptsDeferEnabled || localOptions.conf.content.templates._common.javascriptsDeferEnabled || false;
        hasExternalsPlugins = (localOptions.template.externalPlugins.length > 0) ? true : false;

        // iframe case - without HTML TAG
        if (!self.isXMLRequest() && _layoutLower.indexOf('<html') < 0 ) {
            layout = '<html>\n\t<head></head>\n\t<body class="gina-iframe-body">\n\t\t'+ layout +'\n\t</body>\n</html>';
        }

        // adding stylesheets
        if (!isWithoutLayout && data.page.view.stylesheets && !/\{\{\s+(page\.view\.stylesheets)\s+\}\}/.test(layout) ) {
            layout = layout.replace(/\<\/head\>/i, '\n\t{{ page.view.stylesheets }}\n</head>')
        }

        if (hasViews() && isWithoutLayout) {
            // $.getScript(...)
            //var isProxyHost = ( typeof(local.req.headers.host) != 'undefined' && localOptions.conf.server.scheme +'://'+ local.req.headers.host != localOptions.conf.hostname || typeof(local.req.headers[':authority']) != 'undefined' && localOptions.conf.server.scheme +'://'+ local.req.headers[':authority'] != localOptions.conf.hostname  ) ? true : false;
            //var hostname = (isProxyHost) ? localOptions.conf.hostname.replace(/\:\d+$/, '') : localOptions.conf.hostname;



            var scripts = data.page.view.scripts;
            scripts = scripts.replace(/\s+\<script/g, '\n<script');

            if (!isProxyHost) {
                var webroot = data.page.environment.webroot;
                scripts = scripts.replace(/src\=\"\/(.*)\"/g, 'src="'+ webroot +'$1"');
                //stylesheets = stylesheets.replace(/href\=\"\/(.*)\"/g, 'href="'+ webroot +'$1"')
                webroot = null;
            }

            // iframe case - without HTML TAG
            if (self.isXMLRequest() || _layoutLower.indexOf('<html') < 0 ) {
                layout += scripts;
                //layout += stylesheets;
            }

        }

        // Adding plugins
        // Means that we don't want GFF context or we already have it loaded
        viewInfos = JSON.clone(data.page.view);
        if ( !isWithoutLayout )
                viewInfos.assets = assets;

        if (
            hasViews() && self.isCacheless() && !isWithoutLayout
            && localOptions.debugMode
            ||
            hasViews() && self.isCacheless() && !isWithoutLayout
            && typeof(localOptions.debugMode) == 'undefined'
            ||
            hasViews() && localOptions.debugMode
        ) {
            // #QI — inject dev-mode query log into data.page for Inspector
            if (local._queryLog && local._queryLog.length > 0) {
                data.page.queries = local._queryLog;
            }

            // #FI — inject dev-mode request timeline for Inspector Flow tab.
            // Also convert QI entries into timeline entries so the waterfall
            // shows N1QL queries alongside routing/controller/template phases.
            if (local._timeline && local._timeline.entries.length > 0) {
                if (local._queryLog) {
                    for (var _ti = 0; _ti < local._queryLog.length; _ti++) {
                        var _qe = local._queryLog[_ti];
                        if (_qe._startMs) {
                            local._timeline.entries.push({
                                label: 'n1ql:' + (_qe.trigger || 'query'),
                                cat: 'db',
                                startMs: _qe._startMs,
                                endMs: _qe._startMs + (_qe.durationMs || 0),
                                durationMs: _qe.durationMs || 0,
                                detail: (_qe.statement || '').substring(0, 80)
                            });
                        }
                    }
                }
                data.page.flow = {
                    requestStart: local._timeline.requestStart,
                    entries: local._timeline.entries
                };
            }
            // #FI — snapshot count BEFORE late entries are pushed.
            // data.page.flow.entries is a reference to local._timeline.entries,
            // so reading .length later would include entries pushed after this point.
            var _flowSnapshotCount = (local._timeline) ? local._timeline.entries.length : 0;

            var __gdGina = JSON.parse(JSON.stringify(data.page));
            __gdGina.view.assets      = {};
            __gdGina.view.scripts     = 'ignored-by-toolbar';
            __gdGina.view.stylesheets = 'ignored-by-toolbar';

            var __gdUser = JSON.parse(JSON.stringify(data.page));
            __gdUser.view.scripts     = 'ignored-by-toolbar';
            __gdUser.view.stylesheets = 'ignored-by-toolbar';
            __gdUser.view.assets      = assets;

            var __gdPayload = { gina: __gdGina, user: __gdUser };
            var __gdScript = '<script>window.__ginaData = '
                + JSON.stringify(__gdPayload)
                    .replace(/<\/script>/gi, '<\\/script>')
                    .replace(/<!--/g, '<\\!--')
                + ';</script>\n';

            // Expose last snapshot for engine.io push and /_gina/agent SSE
            self.serverInstance._lastGinaData = __gdPayload;
            process.emit('inspector#data', __gdPayload);

            var __logsScript = '<script>'
                + 'window.__ginaLogs = window.__ginaLogs || [];'
                + '(function(w){'
                + 'var _c=w.console,_l=w.__ginaLogs,_b="' + (__gdUser.environment && __gdUser.environment.bundle || '') + '";'
                + '["log","info","warn","error","debug"].forEach(function(lvl){'
                + 'var orig=_c[lvl].bind(_c);'
                + '_c[lvl]=function(){'
                + 'orig.apply(_c,arguments);'
                + 'try{_l.push({t:Date.now(),l:lvl,b:_b,s:Array.prototype.slice.call(arguments).join(" ")});}catch(e){}'
                + '};});'
                + '}(window));</script>\n';

            plugin = '\t'
                + '{# Gina Inspector #}'
                + __logsScript
                + __gdScript
                + '{%- include "'+ getPath('gina').core +'/asset/plugin/dist/vendor/gina/html/statusbar.html" -%}'// jshint ignore:line
                + '{# END Gina Inspector #}'
            ;


            if (isWithoutLayout && localOptions.debugMode || localOptions.debugMode ) {
                if (self.isXMLRequest()) {
                    // #FI + #QI — inject flow and queries into data.page.data so the
                    // XHR hidden input carries them to the Inspector on popin/dialog open.
                    if (data.page.flow)    { data.page.data.flow    = data.page.flow; }
                    if (data.page.queries) { data.page.data.queries = data.page.queries; }
                    XHRData = '\t<input type="hidden" id="gina-without-layout-xhr-data" value="'+ encodeRFC5987ValueChars(JSON.stringify(data.page.data)) +'">\n\r';
                    XHRView = '\n<input type="hidden" id="gina-without-layout-xhr-view" value="'+ encodeRFC5987ValueChars(JSON.stringify(viewInfos)) +'">';
                    if ( /<\/body>/i.test(layout) ) {
                        layout = layout.replace(/<\/body>/i, XHRData + XHRView + '\n\t</body>');
                    } else {
                        // Popin case
                        // Fix added on 2023-01-25
                        layout += XHRData + XHRView + '\n\t'
                    }
                }
            }


            if (
                self.isCacheless()
                    && !/\{\# Gina Inspector \#\}/.test(layout)
                ||
                localOptions.debugMode
                    && !/\{\# Gina Inspector \#\}/.test(layout)
            ) {
                layout = layout.replace(/<\/body>/i, plugin + '\n\t</body>');
            }

            // adding javascripts
            layout.replace('{{ page.view.scripts }}', '');
            // placed in the HEAD excepted when rendering a partial or when `isDeferModeEnabled` == true
            if (isLoadingPartial) {
                if ( !/\{\{ page\.view\.scripts \}\}/.test(layout) ) {
                    layout += '\t{{ page.view.scripts }}';
                }
            } else {
                // placed in the HEAD
                if ( isDeferModeEnabled  ) {
                    layout = layout.replace(/\<\/head\>/i, '\t{{ page.view.scripts }}\n\t</head>');
                }
                // placed in the BODY
                else {
                    if ( !/\{\{ page\.view\.scripts \}\}/.test(layout) ) {
                        layout = layout.replace(/\<\/body\>/i, '\t{{ page.view.scripts }}\n</body>');
                    }
                    if (hasExternalsPlugins) {
                        for (let i =0, len = localOptions.template.externalPlugins.length; i<len; i++) {
                            layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.externalPlugins +'\n</head>');
                        }
                    }
                }
            }

            // ginaLoader cannot be deferred
            if (
                !localOptions.template.javascriptsExcluded
                    && !/window\.onGinaLoaded/.test(layout)
                ||
                localOptions.template.javascriptsExcluded != '**'
                    && !/window\.onGinaLoaded/.test(layout)

            ) {
                layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.ginaLoader +'\n</head>');
            }

        } else if ( hasViews() && self.isCacheless() && self.isXMLRequest() ) {

            if (isWithoutLayout) {
                delete data.page.view.scripts;
                delete data.page.view.stylesheets;
            }
            // means that we don't want GFF context or we already have it loaded
            // viewInfos = JSON.clone(data.page.view);
            // if ( !isWithoutLayout )
            //     viewInfos.assets = assets;


            // #FI + #QI — inject flow and queries into data.page.data so the
            // XHR hidden input carries them to the Inspector on popin/dialog open.
            if (data.page.flow)    { data.page.data.flow    = data.page.flow; }
            if (data.page.queries) { data.page.data.queries = data.page.queries; }
            XHRData = '\n<input type="hidden" id="gina-without-layout-xhr-data" value="'+ encodeRFC5987ValueChars(JSON.stringify(data.page.data)) +'">';
            XHRView = '\n<input type="hidden" id="gina-without-layout-xhr-view" value="'+ encodeRFC5987ValueChars(JSON.stringify(viewInfos)) +'">';
            if ( /<\/body>/i.test(layout) ) {
                layout = layout.replace(/<\/body>/i, XHRData + XHRView + '\n\t</body>');
            } else {
                // Popin case
                // Fix added on 2023-01-25
                layout += XHRData + XHRView + '\n\t'
            }

            // layout += XHRData + XHRView;

        } else { // other envs like prod ...
            // adding javascripts
            layout.replace('{{ page.view.scripts }}', '');
            if (isLoadingPartial) {
                if ( !/\{\{ page\.view\.scripts \}\}/.test(layout) ) {
                    layout += '\t{{ page.view.scripts }}\n';
                }
                if (
                    !localOptions.template.javascriptsExcluded
                        && !/window\.onGinaLoaded/.test(layout)
                    ||
                    localOptions.template.javascriptsExcluded != '**'
                        && !/window\.onGinaLoaded/.test(layout)

                ) {
                    layout += '\t'+ localOptions.template.ginaLoader +'\n';
                }
            } else {
                // placed in the HEAD
                if (
                    isDeferModeEnabled && /\<\/head\>/i.test(layout)
                    && !/\{\{ page\.view\.scripts \}\}/.test(layout)
                ) { // placed in the HEAD
                    layout = layout.replace(/\<\/head\>/i, '\t{{ page.view.scripts }}\n\t</head>');
                }
                // placed in the BODY
                else {
                    if ( !/\{\{ page\.view\.scripts \}\}/.test(layout) ) {
                        layout = layout.replace(/\<\/body\>/i, '\t{{ page.view.scripts }}\n</body>');
                    }
                    if (hasExternalsPlugins) {
                        for (let i =0, len = localOptions.template.externalPlugins.length; i<len; i++) {
                            layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.externalPlugins +'\n</head>');
                        }
                    }
                }
                // ginaLoader cannot be deferred
                if (
                    !localOptions.template.javascriptsExcluded
                        && !/window\.onGinaLoaded/.test(layout)
                    ||
                    localOptions.template.javascriptsExcluded != '**'
                        && !/window\.onGinaLoaded/.test(layout)

                ) {
                    layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.ginaLoader +'\n</head>');
                }
            }
        }


        layout = whisper(dic, layout, /\{{ ([a-zA-Z.]+) \}}/g );
        dic['page.content'] = layout;


        if ( !headersSent() ) {
            // //catching errors
            // local.res.statusCode = ( typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status])  != 'undefined' ) ? data.page.data.status : 200; // by default

            // // HTTP/2 (RFC7540 8.1.2.4):
            // // This standard for HTTP/2 explicitly states that status messages are not supported.
            // // In HTTP/2, the status is conveyed solely by the numerical status code (e.g., 200, 404, 500),
            // // and there is no field for a human-readable status message.
            // if (
            //     typeof(data.page.data.errno) != 'undefined'
            //         && String(data.page.data.status).startsWith('2')
            //         && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
            //         && !/http\/2/.test(localOptions.conf.server.protocol)
            //     ||
            //     typeof(data.page.data.status) != 'undefined'
            //         && !String(data.page.data.status).startsWith('2')
            //         && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
            //         && !/http\/2/.test(localOptions.conf.server.protocol)
            // ) {

            //     try {
            //         local.res.statusMessage = localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status];
            //     } catch (err){
            //         local.res.statusCode    = 500;
            //         local.res.statusMessage = err.stack||err.message||localOptions.conf.server.coreConfiguration.statusCodes[local.res.statusCode];
            //     }
            // }

            // local.res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

            // try {

            //     // escape special chars
            //     var blacklistRe = new RegExp('[\<\>]', 'g');
            //     // DO NOT REPLACE IT BY JSON.clone() !!!!

            //     data.page.data = JSON.parse(JSON.stringify(data.page.data).replace(blacklistRe, '\$&'));
            //     blacklistRe = null;
            // } catch (err) {
            //     filename = localOptions.template.html;
            //     filename += ( typeof(data.page.view.namespace) != 'undefined' && data.page.view.namespace != '' && new RegExp('^' + data.page.view.namespace +'-').test(data.page.view.file) ) ? '/' + data.page.view.namespace + data.page.view.file.split(data.page.view.namespace +'-').join('/') + ( (data.page.view.ext != '') ? data.page.view.ext: '' ) : '/' + data.page.view.file+ ( (data.page.view.ext != '') ? data.page.view.ext: '' );
            //     self.throwError(local.res, 500, new Error('Controller::render(...) compilation error encountered while trying to process template `'+ filename + '`\n' + (err.stack||err.message||err) ));
            //     filename = null;
            //     blacklistRe = null;
            //     return;
            // }



            // Only available for http/2.0 for now
            if ( !self.isXMLRequest() && /http\/2/.test(localOptions.conf.server.protocol) ) {
                var assets = null;
                try {
                    // TODO - button in toolbar to empty url assets cache
                    if ( /**  self.isCacheless() ||*/ typeof(localOptions.template.assets) == 'undefined' || typeof(localOptions.template.assets[local.req.url]) == 'undefined' ) {
                        // assets string -> object
                        //assets = self.serverInstance.getAssets(localOptions.conf, layout.toString(), swig, data);
                        assets = self.serverInstance.getAssets(localOptions.conf, layout, null, data);
                        localOptions.template.assets = JSON.parse(assets);
                    }

                    //  only for toolbar - TODO hasToolbar()
                    if (
                        self.isCacheless() && hasViews() && !isWithoutLayout
                        || hasViews() && localOptions.debugMode
                        || self.isCacheless() && hasViews() && self.isXMLRequest()
                    ) {
                        layout = layout.replace('{"assets":"${assets}"}', assets );
                    }

                    if ( !self.isCacheless() ) {
                        var links = localOptions.template.h2Links;
                        for (let l in localOptions.template.assets) {
                            let link = localOptions.template.assets[l]
                            if (
                                /^_/.test(l)
                                || typeof(link.as) == 'undefined'
                                || typeof(link.as) != 'undefined'
                                    && link.as != 'null'
                                    && !link.isAvailable
                                || !link.as
                            ) {
                                // ignoring
                                continue;
                            }

                            links += '<'+ l +'>; as='+ link.as +'; '
                            if ( link.imagesrcset) {
                                links += 'imagesrcset='+ link.imagesrcset +'; ';
                            }
                            if ( link.imagesizes) {
                                links += 'imagesizes='+ link.imagesizes +'; ';
                            }
                            links += 'rel=preload,'

                        }
                        if ( /\,$/.test(links) ) {
                            links = links.substring(0, links.length-1);
                        }
                        local.res.setHeader('link', links);
                        links = null;
                    }

                    assets = null;

                } catch (err) {
                    assets = null;
                    self.throwError(local.res, 500, new Error('Controller::render(...) calling getAssets(...) \n' + (err.stack||err.message||err) ));
                    return;
                }
            }

            if (newLayoutFilename) {
                // replaced: openSync/writeSync/closeSync — async write (#P31)
                await fs.promises.writeFile(newLayoutFilename, layout);
            }

            // Last compilation before rendering
            // Now we can use `data` instead of `swigData`
            mapping = { filename: path  };
            if (isWithoutLayout && localOptions.debugMode || localOptions.debugMode ) {
                if (self.isXMLRequest()) {
                    // popin case
                    if ( !/<\/body>/i.test(layout) ) {
                        _templateContent += layout
                    }
                }
            }
            // #FI — template compilation timing
            var _compileStart = (local._timeline) ? Date.now() : 0;
            compiledTemplate = swig.compile(_templateContent, mapping);
            if (_compileStart && local._timeline) {
                local._timeline.entries.push({
                    label: 'swig-compile', cat: 'template',
                    startMs: _compileStart, endMs: Date.now(),
                    durationMs: Date.now() - _compileStart,
                    detail: (data.page.view.file || null)
                });
            }

            if (
                String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'
                && hasLayoutInPath
                && !cache.has(cacheKey)
                && !layoutCacheFailed
            ) {
                // Caching template
                cacheObject = {
                    template: compiledTemplate
                };
                cache.set(cacheKey, cacheObject);
            }

            if ( !headersSent() ) {
                if ( localOptions.isRenderingCustomError ) {
                    localOptions.isRenderingCustomError = false;
                }
                // #FI — template execution timing
                var _execStart = (local._timeline) ? Date.now() : 0;
                htmlContent = compiledTemplate(data);
                if (_execStart && local._timeline) {
                    local._timeline.entries.push({
                        label: 'swig-execute', cat: 'template',
                        startMs: _execStart, endMs: Date.now(),
                        durationMs: Date.now() - _execStart,
                        detail: (data.page.view.file || null)
                    });
                }
                local.res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

                if (
                    !layoutCacheFailed
                    && (
                        !self.isCacheless()
                        && typeof(local.req.routing.cache) != 'undefined'
                        && local.req.method.toUpperCase() === 'GET'
                        ||
                        // allowing caching even for dev env
                        String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'
                        && typeof(local.req.routing.cache) != 'undefined'
                        && local.req.method.toUpperCase() === 'GET'
                    )
                ) {
                    await writeCache(localOptions.bundle, localOptions.conf.server.cache, htmlContent);
                }

                // Cache-Control: miss path — inform browsers/CDNs of the response lifetime (#C6)
                if ( typeof(local.req.routing.cache) != 'undefined' && local.req.routing.cache ) {
                    var _ccCfg = ( typeof(local.req.routing.cache) == 'string' ) ? { type: local.req.routing.cache } : local.req.routing.cache;
                    var _ccTtl = ( typeof(_ccCfg.ttl) != 'undefined' && _ccCfg.ttl > 0 ) ? _ccCfg.ttl : localOptions.conf.server.cache.ttl;
                    if ( _ccTtl > 0 ) {
                        local.res.setHeader('Cache-Control', ( _ccCfg.visibility === 'public' ? 'public' : 'private' ) + ', max-age=' + ~~(_ccTtl));
                    }
                }

                // #FI — response write + total timing
                if (local._timeline) {
                    var _respEnd = Date.now();
                    var _rwStart = local._timeline._renderStart || local._timeline._actionStart || local._timeline.requestStart;
                    local._timeline.entries.push({
                        label: 'response-write', cat: 'response',
                        startMs: _rwStart, endMs: _respEnd,
                        durationMs: _respEnd - _rwStart,
                        detail: null
                    });
                    local._timeline.entries.push({
                        label: 'total', cat: 'total',
                        startMs: local._timeline.requestStart,
                        endMs: _respEnd,
                        durationMs: _respEnd - local._timeline.requestStart,
                        detail: null
                    });

                    // #FI — patch late entries into the HTML.
                    // __ginaData was serialized (deep clone) before swig-compile,
                    // so template/response/total entries are missing from it.
                    // Uses _flowSnapshotCount saved before any late entries were pushed.
                    var _lateEntries = local._timeline.entries.slice(_flowSnapshotCount);
                    if (_lateEntries.length > 0 && (displayInspector || self.isCacheless())) {
                        var _patchScript = '<script>if(window.__ginaData&&window.__ginaData.user&&window.__ginaData.user.flow){'
                            + 'var _e=window.__ginaData.user.flow.entries;'
                            + 'var _p=' + JSON.stringify(_lateEntries) + ';'
                            + 'for(var _i=0;_i<_p.length;_i++){_e.push(_p[_i])}'
                            + '}</script>';
                        htmlContent = htmlContent.replace(/<\/body>/i, _patchScript + '</body>');
                    }
                }

                console.info(local.req.method +' ['+local.res.statusCode +'] '+ local.req.url);
                // HEAD: send headers only — body suppressed (HTTP spec §4.3.2)
                if ( /^HEAD$/i.test(local.req.method) ) {
                    local.res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding);
                    local.res.setHeader('content-length', Buffer.byteLength(htmlContent, 'utf8'));
                    local.res.end();
                } else {
                // if ( stream ) {
                //     stream.respond({
                //         'content-type': localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
                //         ':status': 200
                //     });
                //     layout = null;
                //     return stream.end(htmlContent);
                // }
                local.res.end( htmlContent );
                }

                layout = null;
            }

            // console.info(local.req.method +' ['+local.res.statusCode +'] '+ local.req.url);

            // Release per-request refs — save next first since local.next is used directly here.
            var _next = ( typeof(local.next) != 'undefined' ) ? local.next : null;
            local.req = null;
            local.res = null;
            local.next = null;
            if ( _next ) return _next();
            return;
        }


        if ( typeof(local.req.params.errorObject) != 'undefined' ) {
            return self.throwError(local.req.params.errorObject);
        }
        // if (
        //     stream
        //     && !headersSent()
        // ) {
        //     stream.respond({
        //         'content-type': localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
        //         ':status': 500
        //     });
        //     layout = null;
        //     return stream.end('Unexpected controller error while trying to render.');
        // }
        local.res.end('Unexpected controller error while trying to render.');

        // Release per-request refs — save next first since local.next is used directly here.
        var _next = ( typeof(local.next) != 'undefined' ) ? local.next : null;
        local.req = null;
        local.res = null;
        local.next = null;
        if ( _next ) return _next();
        return;

    } catch (err) {
        return self.throwError(local.res, 500, err);
    }
};
