const fs       = require('fs');
const nodePath = require('path'); // CVE-2023-25345: used for template path boundary enforcement

const lib             = require('./../../lib') || require.cache[require.resolve('./../../lib')];
const Collection      = lib.Collection;
const cache           = new lib.Cache();
var statusCodes       = requireJSON( _( getPath('gina').core + '/status.codes') );

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

function writeCache(bundle, opt, htmlContent) {
    if (
        typeof(local.req.routing.cache) == 'undefined'
        ||
        ! local.req.routing.cache
        ||
        ! /^true$/i.test(self.serverInstance._cacheIsEnabled)
    ) {
        return;
    }
    var cacheKey = "static:"+ local.req.originalUrl;
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
            cacheObject.content = htmlContent;

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
            var htmlFilename = _(opt.path +'/'+ bundle +'/html'+ url + '.html', true);
            var htmlDir = htmlFilename.split(/\//g).slice(0, -1).join('/');
            var htmlDirObj = new _(htmlDir);
            if ( !htmlDirObj.existsSync() ) {
                htmlDirObj.mkdirSync()
            }
            htmlDirObj = null;

            // console.debug("Writting cache to: ", htmlFilename);
            var fd = fs.openSync(htmlFilename, 'w'); // Open file for writing
            var buffer = Buffer.from( htmlContent );
            fs.writeSync(fd, buffer, 0, buffer.length, 0); // Write the buffer
            buffer = null;
            fs.closeSync(fd); // Close the file descriptor
            fd = null;

            // filename is mandatory here
            cacheObject.filename = htmlFilename;

            cache.set(cacheKey, cacheObject);
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
 * @param {object} userData
 * @param {boolean} [displayToolbar]
 * @param {object} [errOptions]
 *
 * @returns {void}
 * */
module.exports = function render(userData, displayToolbar, errOptions, deps) {

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
    var isRenderingCustomError = (
                                typeof(userData.isRenderingCustomError) != 'undefined'
                                && /^true$/i.test(userData.isRenderingCustomError)
                            ) ? true : false;
    if (isRenderingCustomError)
        delete userData.isRenderingCustomError;

    var localOptions = (errOptions) ? errOptions : local.options;
    localOptions.renderingStack.push( self.name );
    // preventing multiple call of self.render() when controller is rendering from another required controller
    if ( localOptions.renderingStack.length > 1 && !isRenderingCustomError ) {
        return false;
    }


    var data                = null
        , layout            = null
        , newLayoutFilename = null
        , fd                = null
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
            if ( !/^(\.|\/|\\)/.test(file) && file != fileNamingConvention ) {
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
                var re = new RegExp( data.page.view.ext+'$');
                if ( data.page.view.ext && re.test(data.page.view.file) ) {
                    data.page.view.path = path.replace('/'+ data.page.view.file, '');

                    path            = path.replace(re, '');
                    data.page.view.file  = data.page.view.file.replace(re, '');

                } else {
                    data.page.view.path = path.replace('/'+ data.page.view.file, '');
                }
                re = null;
            } else {
                    // [CVE-2023-25345] When file starts with . / or \, it was used as-is,
                    // bypassing the template root entirely and allowing traversal to arbitrary
                    // filesystem locations (e.g. file = "../../etc/passwd").
                    // We now validate that any such path resolves within the template root.
                    // path = (!isRenderingCustomError && !/^(\.|\/|\\)/.test(file)) // replaced: CVE-2023-25345
                    //     ? _(localOptions.template.html +'/'+ file)
                    //     : file
                    if ( /^(\.|\/|\\)/.test(file) && !isRenderingCustomError ) {
                        var _fileTemplateRoot    = nodePath.resolve(localOptions.template.html);
                        var _fileResolvedPath    = nodePath.resolve(_fileTemplateRoot, file);
                        if ( !_fileResolvedPath.startsWith(_fileTemplateRoot + '/') ) {
                            throw new Error('[CVE-2023-25345] Path traversal attempt blocked: ' + file);
                        }
                        _fileTemplateRoot = null;
                        _fileResolvedPath = null;
                    }
                    // [/CVE-2023-25345]
                    path = (!isRenderingCustomError && !/^(\.|\/|\\)/.test(file))
                        ? _(localOptions.template.html +'/'+ file)
                        : file
            }
        }

        if (data.page.view.ext && !new RegExp(data.page.view.ext+ '$').test(file) ) {
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
        _templateContent = fs.readFileSync(path).toString()
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
                    !/^true$/i.test(self.serverInstance._cacheIsEnabled)
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
                    fd = fs.openSync(newLayoutFilename, 'w'); // Open file for writing

                    // [CVE-2023-25345] The layoutPath is extracted from the raw {% extends "..." %}
                    // directive in the template file. Without a boundary check, a template containing
                    // {% extends "../../../etc/passwd" %} would cause readFileSync to read arbitrary
                    // files outside the template root (directory traversal / arbitrary file read).
                    // We resolve the path and confirm it stays within localOptions.template.html.
                    var _layoutTemplateRoot     = nodePath.resolve(localOptions.template.html);
                    var _layoutResolvedPath     = nodePath.resolve(_layoutTemplateRoot, layoutPath);
                    if ( !_layoutResolvedPath.startsWith(_layoutTemplateRoot + '/') ) {
                        throw new Error('[CVE-2023-25345] Path traversal attempt blocked in {% extends %}: ' + layoutPath);
                    }
                    _layoutTemplateRoot = null;
                    _layoutResolvedPath = null;
                    // [/CVE-2023-25345]

                    // buffer = Buffer.from( fs.readFileSync(localOptions.template.html + '/'+ layoutPath) ); // replaced: CVE-2023-25345
                    buffer = Buffer.from( fs.readFileSync(localOptions.template.html + '/'+ layoutPath) );
                    fs.writeSync(fd, buffer, 0, buffer.length, 0); // Write the buffer
                    buffer = null;
                    fs.closeSync(fd); // Close the file descriptor
                    fd = null;
                }

                // updating extends
                _templateContent = _templateContent.replace(layoutPath, _(cachePath +'/'+ localOptions.bundle +'/'+ newLayoutPath, true) );

                // override layout path
                layoutPath = newLayoutPath;

                data.page.view.layout = layoutPath;
                layoutPath = cachePath +'/'+ localOptions.bundle +'/'+ layoutPath;

                localOptions.template.layout = layoutPath;

            } catch (extendErr) {
                // nothing to do
            }
        }
        extendFound = null;
    }

    localOptions.debugMode = ( typeof(displayToolbar) == 'undefined' ) ? undefined : ( (/true/i.test(displayToolbar)) ? true : false ); // only active for dev env

    // specific override
    if (
        self.isCacheless()
        && typeof(local.req[ local.req.method.toLowerCase() ]) != 'undefined'
        && typeof(local.req[ local.req.method.toLowerCase() ].debug) != 'undefined'
    ) {
        if ( !/^(true|false)$/i.test(local.req[ local.req.method.toLowerCase() ].debug) ) {
            console.warn('Detected wrong value for `debug`: '+ local.req[ local.req.method.toLowerCase() ].debug);
            console.warn('Switching `debug` to `true` as `cacheless` mode is enabled');
            local.req[ local.req.method.toLowerCase() ].debug = true;
        }
        localOptions.debugMode = ( /^true$/i.test(local.req[ local.req.method.toLowerCase() ].debug) ) ? true : false;
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
            && !/^2/.test(data.page.data.status)
            && typeof(data.page.data.error) != 'undefined'
        ) {

            var errorObject = {
                status  : data.page.data.status,
                error   : statusCodes[data.page.data.status] || msg.error || msg,
                message : data.page.data.message || data.page.data.error,
                stack   : data.page.data.stack
            };
            if ( typeof(data.page.data.session) != 'undefined' ) {
                errorObject.session = data.page.data.session;
            }

            return self.throwError(errorObject);
        }


        // data.page.view.path = path;

        var dic = {}, msg = '';
        for (let d in data.page) {
            dic['page.'+d] = data.page[d]
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
            &&  /^(80|443)$/.test(localRequestPort)
            && localOptions.conf.server.scheme +'://'+ local.req.headers.host+':'+ localRequestPort != localOptions.conf.hostname.replace(/\:\d+$/, '') +':'+ localOptions.conf.server.port
            ||
            typeof(local.req.headers[':authority']) != 'undefined'
            && localOptions.conf.server.scheme +'://'+ local.req.headers[':authority'] != localOptions.conf.hostname
            ||
            typeof(local.req.headers.host) != 'undefined'
            && typeof(localRequestPort) != 'undefined'
            && /^(80|443)$/.test(localRequestPort)
            && local.req.headers.host == localOptions.conf.host
            ||
            typeof(local.req.headers['x-nginx-proxy']) != 'undefined'
            && /^true$/i.test(local.req.headers['x-nginx-proxy'])
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
                if ( typeof(filters[filter]) == 'function' && !/^getConfig$/.test(filter) ) {
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
            if ( !/^\//.test(layoutPath)) {
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
                    && /^2/.test(data.page.data.status)
                    && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
                    && !/http\/2/.test(localOptions.conf.server.protocol)
                ||
                typeof(data.page.data.status) != 'undefined'
                    && !/^2/.test(data.page.data.status)
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

                // escape special chars
                var blacklistRe = new RegExp('[\<\>]', 'g');
                // DO NOT REPLACE IT BY JSON.clone() !!!!

                data.page.data = JSON.parse(JSON.stringify(data.page.data).replace(blacklistRe, '\$&'));
                blacklistRe = null;
            } catch (err) {
                filename = localOptions.template.html;
                filename += ( typeof(data.page.view.namespace) != 'undefined' && data.page.view.namespace != '' && new RegExp('^' + data.page.view.namespace +'-').test(data.page.view.file) ) ? '/' + data.page.view.namespace + data.page.view.file.split(data.page.view.namespace +'-').join('/') + ( (data.page.view.ext != '') ? data.page.view.ext: '' ) : '/' + data.page.view.file+ ( (data.page.view.ext != '') ? data.page.view.ext: '' );
                self.throwError(local.res, 500, new Error('Controller::render(...) compilation error encountered while trying to process template `'+ filename + '`\n' + (err.stack||err.message||err) ));
                filename = null;
                blacklistRe = null;
                return;
            }
        }


        var isLoadingPartial = false;
        assets  = {assets:"${assets}"};
        layout = fs.readFileSync(layoutPath, 'utf8');
        // Loading from cache
        if (
            /^true$/i.test(self.serverInstance._cacheIsEnabled)
            && cache.has(cacheKey)
        ) {
            compiledTemplate = cache.get(cacheKey).template;

            if ( !headersSent() ) {
                if ( localOptions.isRenderingCustomError ) {
                    localOptions.isRenderingCustomError = false;
                }

                htmlContent = compiledTemplate(data);
                local.res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

                if (
                    !self.isCacheless()
                    && typeof(local.req.routing.cache) != 'undefined'
                    && /^GET$/i.test(local.req.method)
                    ||
                    // allowing caching even for dev env
                    /^true$/i.test(self.serverInstance._cacheIsEnabled)
                    && typeof(local.req.routing.cache) != 'undefined'
                    && /^GET$/i.test(local.req.method)
                ) {
                    writeCache(localOptions.bundle, localOptions.conf.server.cache, htmlContent);
                }

                console.info(local.req.method +' ['+local.res.statusCode +'] '+ local.req.url);
                // if ( stream ) {
                //     stream.respond({
                //         'content-type': localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
                //         ':status': 200
                //     });
                //     layout = null;
                //     return stream.end(htmlContent);
                // }
                local.res.end( htmlContent );
                layout = null;
            }

            // Release per-request refs — save next first since local.next is used directly here.
            var _next = ( typeof(local.next) != 'undefined' ) ? local.next : null;
            local.req = null;
            local.res = null;
            local.next = null;
            if ( _next ) return _next();
            return;
        } // EO /^true$/i.test(self.serverInstance._cacheIsEnabled)



        isLoadingPartial = (
            !/\<html/i.test(layout)
            || !/\<head/i.test(layout)
            || !/\<body/i.test(layout)
        ) ? true : false;

        // if (isLoadingPartial) {
        //     console.warn('----------------> loading partial `'+ path);
        // }

        isDeferModeEnabled = localOptions.template.javascriptsDeferEnabled || localOptions.conf.content.templates._common.javascriptsDeferEnabled || false;
        hasExternalsPlugins = (localOptions.template.externalPlugins.length > 0) ? true : false;

        // iframe case - without HTML TAG
        if (!self.isXMLRequest() && !/\<html/.test(layout) ) {
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
            if (self.isXMLRequest() || !/\<html/.test(layout) ) {
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
            if ( !/\{\%\- set ginaDataInspector/.test(layout) ) {
                layout = ''
                    // + '{%- set ginaDataInspector                    = JSON.clone(page) -%}'
                    + '{%- set ginaDataInspector                    = JSON.clone(page) -%}'
                    // + '{%- set ginaDataInspector                    = { view: {}, environment: { routing: {}}} -%}'
                    + '{%- set ginaDataInspector.view.assets        = {} -%}'
                    + '{%- set ginaDataInspector.view.scripts       = "ignored-by-toolbar" -%}'
                    + '{%- set ginaDataInspector.view.stylesheets   = "ignored-by-toolbar" -%}'
                    + layout
                ;
            }


            plugin = '\t'
                + '{# Gina Toolbar #}'
                + '{%- set userDataInspector                    = JSON.clone(page) -%}'
                + '{%- set userDataInspector.view.scripts       = "ignored-by-toolbar"  -%}'
                + '{%- set userDataInspector.view.stylesheets   = "ignored-by-toolbar"  -%}'
                + '{%- set userDataInspector.view.assets        = '+ JSON.stringify(assets) +' -%}'
                + '{# END Gina Toolbar #}'
                + '{%- include "'+ getPath('gina').core +'/asset/plugin/dist/vendor/gina/html/toolbar.html" with { gina: ginaDataInspector, user: userDataInspector } -%}'// jshint ignore:line
            ;


            if (isWithoutLayout && localOptions.debugMode || localOptions.debugMode ) {
                if (self.isXMLRequest()) {
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
                    && !/\{\# Gina Toolbar \#\}/.test(layout)
                ||
                localOptions.debugMode
                    && !/\{\# Gina Toolbar \#\}/.test(layout)
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
            //         && /^2/.test(data.page.data.status)
            //         && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
            //         && !/http\/2/.test(localOptions.conf.server.protocol)
            //     ||
            //     typeof(data.page.data.status) != 'undefined'
            //         && !/^2/.test(data.page.data.status)
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
                fd = fs.openSync(newLayoutFilename, 'w'); // Open file for writing
                buffer = Buffer.from( layout );
                fs.writeSync(fd, buffer, 0, buffer.length, 0); // Write the buffer
                buffer = null;
                fs.closeSync(fd); // Close the file descriptor
                fd = null;
            }

            // Last compilation before rendering
            // Now we can use `data` instead of `swigData`
            mapping = { filename: path  };
            compiledTemplate = swig.compile(_templateContent, mapping);

            if (
                /^true$/i.test(self.serverInstance._cacheIsEnabled)
                && hasLayoutInPath
                && !cache.has(cacheKey)
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
                htmlContent = compiledTemplate(data);
                local.res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

                if (
                    !self.isCacheless()
                    && typeof(local.req.routing.cache) != 'undefined'
                    && /^GET$/i.test(local.req.method)
                    ||
                    // allowing caching even for dev env
                    /^true$/i.test(self.serverInstance._cacheIsEnabled)
                    && typeof(local.req.routing.cache) != 'undefined'
                    && /^GET$/i.test(local.req.method)
                ) {
                    writeCache(localOptions.bundle, localOptions.conf.server.cache, htmlContent);
                }

                console.info(local.req.method +' ['+local.res.statusCode +'] '+ local.req.url);
                // if ( stream ) {
                //     stream.respond({
                //         'content-type': localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
                //         ':status': 200
                //     });
                //     layout = null;
                //     return stream.end(htmlContent);
                // }
                local.res.end( htmlContent );

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
