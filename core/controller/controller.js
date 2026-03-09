/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

//Imports.
var fs              = require('fs');
var EventEmitter    = require('events').EventEmitter;
var http            = require('http');
var https           = require('https');
var utils           = require('./../utils') || require.cache[require.resolve('./../utils')];
var merge           = utils.merge;
var inherits        = utils.inherits;
var console         = utils.logger;
var Collection      = utils.Collection;
var swig            = require('swig');


/**
 * @class SuperController
 *
 *
 * @package     Gina
 * @namespace
 * @author      Rhinostone <gina@rhinostone.com>
 *
 * @api         Public
 */
function SuperController(options) {
    this.name = 'SuperController';

    //private
    var self = this;
    var local = {
        req     : null,
        res     : null,
        next    : null,
        options : options || null,
        query   : {},
        _data   : {}
    };

    var ports = {
        'http': 80,
        'https': 443
    };


    /**
     * SuperController Constructor
     * @constructor
     * */
    var init = function() {

        if ( typeof(SuperController.initialized) != 'undefined' ) {
            return getInstance()
        } else {
            SuperController.initialized = true;
            SuperController.instance = self;
            if (local.options) {
                SuperController.instance._options = local.options
            }
        }
    }

    var getInstance = function() {
        local.options = SuperController.instance._options = options;
        return SuperController.instance
    }

    var hasViews = function() {
        return ( typeof(local.options.views) != 'undefined' ) ? true : false;
    }

    /**
     * Check if env is running cacheless
     * */
    this.isCacheless = function() {
        return local.options.cacheless
    }

    this.setOptions = function(req, res, next, options) {
        local.options = SuperController.instance._options = options;

        // N.B.: Avoid setting `page` properties as much as possible from the routing.json
        // It will be easier for the framework if set from the controller.
        //
        // Here is a sample if you choose to set  `page.title` from the rule
        // ------rouging rule sample -----
        // {
        //    "default": {
        //        "url": ["", "/"],
        //            "param": {
        //            "action": "home",
        //                "title": "My Title"
        //        }
        // }
        //
        // ------controller action sample -----
        // Here is a sample if you decide to set `page.title` from your controller
        //
        // this.home = function(req, res, next) {
        //      var data = { page: { title: "My Title"}};
        //      self.render(data)
        // }
        if ( typeof(options.conf.content.routing[options.rule].param) !=  'undefined' ) {
            var str = 'page.', p = options.conf.content.routing[options.rule].param;
            for (var key in p) {
                if (p.hasOwnProperty(key)) {
                    str += key + '.';
                    var obj = p[key], value = '';
                    for (var prop in obj) {
                        if (obj.hasOwnProperty(prop)) {
                            value += obj[prop]
                        } else {

                            if ( /^:/.test(value) ) {
                                set(str.substr(0, str.length-1), req.params[value.substr(1)])
                            } else {
                                set(str.substr(0, str.length-1), value)
                            }


                            str = 'page.'
                        }
                    }
                }
            }
        }

        local.req = req;
        local.res = res;
        local.next = next;

        getParams(req);
        if ( typeof(local.options.views) != 'undefined' && typeof(local.options.action) != 'undefined' ) {


            var  action     = local.options.action
                , rule      = local.options.rule
                , ext       = 'html'
                , namespace = local.options.namespace || '';


            if ( typeof(local.options.views.default) != 'undefined' ) {
                ext = local.options.views.default.ext || ext;
            }
            if( !/\./.test(ext) ) {
                ext = '.' + ext;
                local.options.views.default.ext = ext
            }

            // new declaration && overrides
            var version = {
                "number"        : getContext('gina').version,
                "platform"      : process.platform,
                "arch"          : process.arch,
                "nodejs"        : process.versions.node,
                "middleware"    : getContext('gina').middleware
            };

            set('page.environment.gina', version.number);
            set('page.environment.nodejs', version.nodejs +' '+ version.platform +' '+ version.arch);
            set('page.environment.middleware', version.middleware);
            set('page.environment.env', options.conf.env);
            set('page.environment.webroot', options.conf.server.webroot);
            set('page.environment.bundle', options.conf.bundle);

            set('page.ext', ext);
            set('page.content', action);
            set('page.namespace', namespace);
            set('page.title', rule.replace(new RegExp('@'+options.conf.bundle), ''));
            set('page.forms', options.conf.content.forms);
            
            var acceptLanguage = 'en-US'; // by default
            if ( typeof(req.headers['accept-language']) != 'undefined' ) {
                acceptLanguage = req.headers['accept-language']
            } else if ( typeof(local.options.conf.server.response.header['accept-language']) != 'undefined' ) {
                acceptLanguage = local.options.conf.server.response.header['accept-language']
            }

            // set user locale
            var userCulture     = acceptLanguage.split(',')[0];
            var userCultureCode = userCulture.split(/\-/);
            var userLangCode    = userCultureCode[0];
            var userCountryCode = userCultureCode[1];

            var locales         = new Collection( getContext('gina').locales );
            var userLocales     = null;

            try {
                userLocales = locales.findOne({ lang: userLangCode }).content
            } catch (err) {
                console.warn('language code `'+ userLangCode +'` not handled to setup locales: replacing by `en`');
                userLocales = locales.findOne({ lang: 'en' }).content // by default
            }

            // user locales list
            local.options.conf.locales = userLocales;

            // user locale
            options.conf.locale = new Collection(userLocales).findOne({ short: userCountryCode });

            set('page.locale', options.conf.locale);
            set('page.lang', userCulture);
        }

        if ( hasViews() ) {

            if ( typeof(local.options.file) == 'undefined') {
                local.options.file = 'index'
            }

            if ( typeof(local.options.isWithoutLayout) == 'undefined' ) {
                local.options.isWithoutLayout = false;
            }

            var rule        = local.options.rule
                , namespace = local.options.namespace || rule;

            set('file', local.options.file);
            set('page.title', local.options.file);
            set('page.namespace', namespace);

            //TODO - detect when to use swig
            var dir = self.views || local.options.views.default.views;
            var swigOptions = {
                autoescape: ( typeof(local.options.autoescape) != 'undefined') ? local.options.autoescape: false,
                loader: swig.loaders.fs(dir),
                cache: (local.options.cacheless) ? false : 'memory'
            };
            swig.setDefaults(swigOptions);
            self.engine = swig;
        }
    }



    this.renderWithoutLayout = function (data, displayToolbar) {
        local.options.isWithoutLayout = true;
        local.options.debugMode = true; // only active for dev env
        self.render(data)
    }

    /**
     * Render HTML templates : Swig is the default template engine
     *
     *  Extend default filters
     *  - length
     *
     * Avilable filters:
     *  - getWebroot()
     *  - getUrl()
     *
     *
     * @param {object} _data
     *
     * @return {void}
     * */
    this.render = function(_data) {

        try {
            var data = getData(), path = '', plugin = null;
            if (!_data) {
                _data = { page: {}}
            } else if ( _data && !_data['page']) {
                data['page'] = {
                    data: _data
                }
            } else {
                data = merge(_data, data)
            }


            data.view = local.options.rule.replace('\@'+ local.options.bundle, '');
            setResources(local.options.views, data.view);

            var file = data.file;

            // pre-compiling variables
            data = merge(data, getData()); // needed !!

            if  (typeof(data.page.data) == 'undefined' ) {
                data.page.data = {}
            }

            if ( typeof(data.page.data.status) != 'undefined' && !/^2/.test(data.page.data.status) && typeof(data.page.data.error) != 'undefined' ) {
                self.throwError(data.page.data.status, data.page.data.error)
            }

            // making path thru [namespace &] file
            if ( typeof(local.options.namespace) != 'undefined' ) {
                file = ''+ file.replace(local.options.namespace+'-', '');
                // means that rule name === namespace -> pointing to root namespace dir
                if (!file || file === local.options.namespace) {
                    file = 'index'
                }
                path = _(local.options.views[data.view].html +'/'+ local.options.namespace + '/' + file)
            } else {
                if (local.options.path) {
                    path = _(local.options.path);
                    var re = new RegExp( data.page.ext+'$');
                    if ( data.page.ext && re.test(data.page.file) ) {
                        data.page.path = path.replace('/'+ data.page.file, '');

                        path            = path.replace(re, '');
                        data.page.file  = data.page.file.replace(re, '');

                    } else {
                        data.page.path = path.replace('/'+ data.page.file, '');
                    }

                } else {
                    path = _(local.options.views[data.view].html +'/'+ file)
                }
            }

            if (data.page.ext) {
                path += data.page.ext
            }

            var dic = {}, msg = '';
            for (var d in data.page) {
                dic['page.'+d] = data.page[d]
            }


            // please, do not put any slashes when including...
            // ex.:
            //      /html/inc/_partial.html (BAD)
            //      html/inc/_partial.html (GOOD)
            //      ./html/namespace/page.html (GOOD)
            fs.readFile(path, function (err, content) {
                if (err) {
                    msg = 'could not open "'+ path +'"' +
                            '\n1) The requested file does not exists in your views/html (check your template directory). Can you find: '+path +
                            '\n2) Check the following rule in your `'+local.options.conf.bundlePath+'/config/routing.json` and look around `param` to make sure that nothing is wrong with your declaration: '+
                            '\n' + options.rule +':'+ JSON.stringify(options.conf.content.routing[options.rule], null, 4) +
                            '\n3) At this point, if you still have problems trying to run this portion of code, you can contact us telling us how to reproduce the bug.' +
                            '\n\r[ stack trace ] '+ err.stack;

                    console.error(err);
                    self.throwError(local.res, 500, new Error(msg));
                }

                try {
                    // Extends default `length` filter
                    swig.setFilter('length', function (input, obj) {

                        if ( typeof(input.count) != 'undefined' ) {
                            return input.count()
                        } else {
                            return input.length
                        }
                    });


                    // Allows you to get a bundle web root
                    swig.setFilter('getWebroot', function (input, obj) {
                        var prop = options.envObj.getConf(obj, options.conf.env),
                            url = prop.protocol + '://'+ prop.host +':'+ prop.port[prop.protocol];
                        if ( typeof(prop.server['webroot']) != 'undefined') {
                            url += prop.server['webroot']
                        }
                        return url
                    });

                    /**
                     * getUrl filter
                     *
                     * Usage:
                     *      <a href="{{ '/homepage' | getUrl() }}">Homepage</a>
                     *      <a href="{{ 'users-add' | getUrl({ id: user.id }) }}">Add User</a>
                     *      <a href="{{ 'users-edit' | getUrl({ id: user.id }) }}">Edit user</a>
                     *      <a href="{{ 'users-list' | getUrl(null, 'http://domain.com') }}">Display all users</a>
                     *      <a href="{{ '/dashboard' | getUrl(null, 'admin') }}">Go to admin bundle's dashboard page</a>
                     *
                     *      // can also be used with standalone mode: will add webroot if current bundle is not master
                     *      <script src="{{ '/js/vendor/modernizr-2.8.3.min.js' | getUrl() }}"></script>
                     *      compiled as => <script src="/my-bundle/js/vendor/modernizr-2.8.3.min.js"></script>
                     *
                     * @param {string} route
                     * @param {object} params - can't be left blank if base is required -> null if not defined
                     * @param {string} [base] - can be a CDN, the http://domain.com or a bundle name
                     *
                     * @return {string} relativeUrl|absoluteUrl - /sample/url.html or http://domain.com/sample/url.html
                     * */
                    var config              = null
                        , hostname          = null
                        , wroot             = null
                        , isStandalone      = null
                        , isMaster          = null
                        , routing           = null
                        , isWithoutLayout   = null
                        , rule              = ''
                        , url               = NaN
                        , urlStr            = null
                    ;


                    swig.setFilter('getUrl', function (route, params, base) {
                        // if no route, returns current route
                        if ( typeof(route) == 'undefined') {
                            var route = local.options.rule
                        }

                        // setting default config
                        config          = local.options.conf;
                        hostname        = '';
                        wroot           = config.server.webroot;

                        isStandalone    = (config.bundles.length > 1) ? true : false;
                        isMaster        = (config.bundles[0] === config.bundle) ? true : false;
                        routing         = config.content.routing;
                        isWithoutLayout = (local.options.isWithoutLayout) ? true : false;

                        if ( typeof(base) != 'undefined' ) {

                            // if base is not an URL, must be a bundle
                            if ( !/^http\:/.test(base) ) {
                                var mainConf = getContext('gina').Config.instance;
                                // is real bundle ?
                                if ( mainConf.allBundles.indexOf(base) > -1 ) {
                                    // config override
                                    config          = mainConf.Env.getConf(base, mainConf.env);

                                    // retrieve hostname, webroot & routing
                                    hostname        = config.hostname;
                                    routing         = config.content.routing;
                                    wroot           = config.server.webroot;

                                    config.bundle   = base;
                                    isStandalone    = (mainConf.bundles.length > 1) ? true : false;
                                    isMaster        = (mainConf.bundles[0] === config.bundle) ? true : false;

                                } else {
                                    self.throwError(local.res, 500, new Error('bundle `'+ base +'` not found: Swig.getUrl() filter encountered a problem while trying to compile base `'+base+'` and route `'+route+'`').stack)
                                }
                            }
                        }

                        // is path ?
                        if (/\//.test(route)) {

                            if (route.substr(0,1) == '/')
                                route = route.substr(1);


                            if (wroot.length == 1)
                                wroot = '';

                            return hostname + wroot +'/'+ route;
                        }

                        // rules are now unique per bundle : rule@bundle
                        rule = route + '@' + config.bundle;

                        if ( typeof(routing[rule]) != 'undefined' ) { //found
                            url = routing[rule].url;
                            if ( typeof(routing[rule].requirements) != 'undefined' ) {
                                
                                for (var p in routing[rule].requirements) {
                                    if ( Array.isArray(url) ) {
                                        for (var i= 0, len = url.length; i< len; ++i) {
                                            if ( params && /:/.test(url[i]) ) {
                                                urlStr = url[i].replace(new RegExp(':'+p+'(\\W|$)', 'g'), params[p]+'$1');
                                                break
                                            }
                                        }

                                        if (urlStr != null) {
                                            url = urlStr
                                        } else { // just take the first one by default
                                            url = url[0]
                                        }
                                    } else {
                                        try {
                                            url = url.replace(new RegExp(':'+p+'(\\W|$)', 'g'), params[p]+'$1')
                                        } catch (err) {
                                            self.throwError(local.res, 500, 'template compilation exception encoutered: [ '+path+' ]\nsounds like you are having troubles with the following call `{{ "'+route+'" | getUrl() }}` where `'+p+'` parameter is expected according to your `routing.json`'  +'\n'+(err.stack||err.message));
                                        }

                                    }
                                }
                            } else {
                                if ( Array.isArray(url) ) {
                                    url = url[0] || url[1] // just taking the default one: using the first element unless it is empty.
                                    if (!url) {
                                        self.throwError(local.res, 500, new Error('please check your `routing.json` at the defined rule `'+rule+'` : `url` attribute cannot be empty').stack)
                                    }
                                }
                            }

                            if ( /^\//.test(url) )
                                url = hostname + url;
                            else
                                url = hostname +'/'+ url;

                        } else {
                            if ( typeof(routing['404']) != 'undefined' && typeof(routing['404'].url) != 'undefined' ) {
                                if (routing["404"].url.substr(0,1) == '/')
                                    routing["404"].url = routing["404"].url.substr(1);

                                url = hostname + wroot +'/'+ routing["404"].url
                            } else {
                                url = hostname + wroot +'/404.html'
                            }
                        }

                        return url
                    });

                } catch (err) {
                    // [ martin ]
                    // i sent an email to [ paul@paularmstrongdesigns.com ] on 2014/08 to see if there is
                    // a way of retrieving swig compilation stack traces
                    //var stack = __stack.splice(1).toString().split(',').join('\n');
                    self.throwError(local.res, 500, 'template compilation exception encoutered: [ '+path+' ]\n'+(err.stack||err.message));
                }

                dic['page.content'] = content;

                var layoutPath = (local.options.isWithoutLayout) ? local.options.views[data.view].noLayout : local.options.views[data.view].layout;

                fs.readFile(layoutPath, function(err, layout) {
                    if (err) {
                        self.throwError(local.res, 500, err.stack);
                    } else {
                        layout = layout.toString();
                        // adding plugins
                        if ( hasViews() && local.options.conf.env == 'dev' && (!local.options.isWithoutLayout || local.options.isWithoutLayout && local.options.debugMode)  ) {

                            layout = ''
                                + '{%- set ginaDataInspector                = JSON.parse(JSON.stringify(page)) -%}'
                                + '{%- set ginaDataInspector.scripts        = "ignored-by-toolbar" -%}'
                                + '{%- set ginaDataInspector.stylesheets    = "ignored-by-toolbar" -%}'
                                + layout.replace('{{ page.scripts }}', '')
                                ;

                            plugin = '\t'
                                + '{# Gina Toolbar #}'
                                + '{%- set userDataInspector                = page -%}'
                                + '{%- set userDataInspector.scripts        = "ignored-by-toolbar" -%}'
                                + '{%- set userDataInspector.stylesheets    = "ignored-by-toolbar" -%}'
                                + '{%- include "'+getPath('gina').core+'/asset/js/plugin/src/gina/toolbar/toolbar.html" with { gina: ginaDataInspector, user: userDataInspector} -%}'
                                + '{# END Gina Toolbar #}'

                                + '\n<script type="text/javascript">'
                                + ' \n<!--'
                                + '\n' + local.options.views.default.pluginLoader.toString()
                                + '//-->'
                                + '\n</script>'

                                + '\n<script type="text/javascript" src="{{ \'/js/vendor/gina/gina.min.js\' | getUrl() }}"></script>'

                                + '{{ page.scripts }}'
                            ;

                            if (local.options.isWithoutLayout && local.options.debugMode) {
                                var XHRData = '\t<input type="hidden" id="gina-without-layout-xhr-data" value="'+ encodeURIComponent(JSON.stringify(data.page.data)) +'">\n\r';
                                layout = XHRData + layout;
                            }

                            layout = layout.replace(/<\/body>/i, plugin + '\n\t</body>');

                        } else if ( hasViews() && local.options.conf.env == 'dev' && self.isXMLRequest() ) {
                            // means that we don't want GFF context or we already have it loaded
                            var XHRData = '\n<input type="hidden" id="gina-without-layout-xhr-data" value="'+ encodeURIComponent(JSON.stringify(data.page.data)) +'">';

                            layout += XHRData;

                        } else { // production env

                            plugin = '\t'
                                + '\n<script type="text/javascript">'
                                + ' \n<!--'
                                + '\n' + local.options.views.default.pluginLoader.toString()
                                + '//-->'
                                + '\n</script>'

                                + '\n<script type="text/javascript" src="{{ \'/js/vendor/gina/gina.min.js\' | getUrl() }}"></script>'
                            ;

                            if ( !/page\.scripts/.test(layout) ) {
                                layout = layout.replace(/<\/body>/i, plugin + '\t{{ page.scripts }}\n\t</body>');
                            } else {
                                layout = layout.replace(/{{ page.scripts }}/i, plugin + '\t{{ page.scripts }}');
                            }

                        }

                        layout = whisper(dic, layout, /\{{ ([a-zA-Z.]+) \}}/g );

                        try {

                            layout = swig.compile(layout)(data);
                            // special case for template without layout in debug mode - dev only
                            if ( hasViews() && local.options.isWithoutLayout && local.options.debugMode ) {
                                layout = layout.replace(/<\/body>/i, plugin + '\n\t</body>');
                                layout = whisper(dic, layout, /\{{ ([a-zA-Z.]+) \}}/g );
                                layout = swig.compile(layout)(data);
                            }

                        } catch (err) {
                            var filename = local.options.views[data.view].html;
                            filename += ( typeof(data.page.namespace) != 'undefined' && data.page.namespace != '' && new RegExp('^' + data.page.namespace +'-').test(data.file) ) ? '/' + data.page.namespace + data.file.split(data.page.namespace +'-').join('/') + ( (data.page.ext != '') ? data.page.ext: '' ) : '/' + data.file+ ( (data.page.ext != '') ? data.page.ext: '' );
                            self.throwError(local.res, 500, 'Compilation error encountered while trying to process template `'+ filename + '`\n'+(err.stack||err.message))
                        }

                        if ( !local.res.headersSent ) {
                            local.res.statusCode = ( typeof(local.options.conf.server.coreConfiguration.statusCodes[data.page.data.status])  != 'undefined' ) ? data.page.data.status : 200; // by default
                            //catching errors
                            if (
                                typeof(data.page.data.errno) != 'undefined' && /^2/.test(data.page.data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
                                || typeof(data.page.data.status) != 'undefined' && !/^2/.test(data.page.data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
                            ) {

                                try {
                                    //local.res.statusCode    = data.page.data.status;
                                    local.res.statusMessage = local.options.conf.server.coreConfiguration.statusCodes[data.page.data.status];
                                } catch (err){
                                    local.res.statusCode    = 500;
                                    local.res.statusMessage = err.stack||err.message||local.options.conf.server.coreConfiguration.statusCodes[local.res.statusCode];
                                }
                            }

                            local.res.setHeader("Content-Type", local.options.conf.server.coreConfiguration.mime['html']);

                            console.info(local.req.method +' ['+local.res.statusCode +'] '+ local.req.url);

                            local.res.end(layout);
                            local.res.headersSent = true
                        } else {
                            local.next()
                        }
                    }
                })
            })
        } catch (err) {
            self.throwError(local.res, 500, err.stack||err.message)
        }
    }

    this.isXMLRequest = function() {
        return local.options.isXMLRequest;
    }

    this.isWithCredentials = function() {
        return ( /true/.test(local.options.withCredentials) ) ? true : false;
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
    this.renderJSON = function(jsonObj) {

        var request     = local.req;
        var response    = local.res;
        var next        = local.next;


        if (!jsonObj) {
            var jsonObj = {}
        }
        
        try {
            // just in case
            if ( typeof(jsonObj) == 'string') {
                jsonObj = JSON.parse(jsonObj)
            }

            if( typeof(local.options) != "undefined" && typeof(local.options.charset) != "undefined" ){
                response.setHeader("charset", local.options.charset);
            }
            

            //catching errors
            if (
                typeof(jsonObj.errno) != 'undefined' && response.statusCode == 200
                || typeof(jsonObj.status) != 'undefined' && jsonObj.status != 200 && typeof(local.options.conf.server.coreConfiguration.statusCodes[jsonObj.status]) != 'undefined'
            ) {

                try {
                    response.statusCode    = jsonObj.status;
                    response.statusMessage = local.options.conf.server.coreConfiguration.statusCodes[jsonObj.status];
                } catch (err){
                    response.statusCode    = 500;
                    response.statusMessage = err.stack;
                }
            }


            // Internet Explorer override
            if ( /msie/i.test(request.headers['user-agent']) ) {
                response.setHeader("Content-Type", "text/plain")
            } else {
                response.setHeader("Content-Type", local.options.conf.server.coreConfiguration.mime['json'])
            }

            if ( !response.headersSent ) {
                console.info(request.method +' ['+ response.statusCode +'] '+ request.url);

                if ( local.options.isXMLRequest && self.isWithCredentials() )  {

                    var data = JSON.stringify(jsonObj);
                    var len = 0;
                    // content length must be the right size !
                    if ( typeof(data) === 'string') {
                        len = Buffer.byteLength(data, 'utf8')
                    } else {
                        len = data.length
                    }

                    response.setHeader("Content-Length", len);

                    response.write(data);
                    response.headersSent = true;

                    // required to close connection
                    setTimeout(function () {
                        response.end()
                    }, 200);

                    return // force completion

                } else { // normal case
                    response.end(JSON.stringify(jsonObj));
                    response.headersSent = true
                }
            }
        } catch (err) {
            self.throwError(response, 500, err.stack||err.message)
        }

    }


    this.renderTEXT = function(content) {
        if ( typeof(content) != "string" ) {
            var content = content.toString();
        }

        if(typeof(options) != "undefined" && typeof(options.charset) !="undefined") {
            local.res.setHeader("charset", options.charset);
        }
        if ( !local.res.get('Content-Type') ) {
            local.res.setHeader("Content-Type", "text/plain");
        }

        if ( !local.res.headersSent ) {
            console.info(local.req.method +' ['+local.res.statusCode +'] '+ local.req.url);
            local.res.end(content);
            local.res.headersSent = true
        }
    }

    var parseDataObject = function (o, obj) {

        for (var i in o) {
            if (o[i] !== null && typeof(o[i]) == 'object') {
                parseDataObject(o[i], obj);
            } else if (o[i] == '_content_'){
                o[i] = obj
            }
        }

        return o
    }

    /**
     * Set data
     *
     * @param {string} nave -  variable name to set
     * @param {string|object} value - value to set
     *
     * @return {void}
     * */
    // var set = function(variable, value) {
    //     if ( typeof(local._data[variable]) == 'undefined' )
    //         local._data[variable] = value
    // }

    var set = function(name, value) {

        if ( typeof(name) == 'string' && /\./.test(name) ) {
            var keys        = name.split(/\./g)
                , newObj    = {}
                , str       = '{'
                , _count    = 0;

            for (var k = 0, len = keys.length; k<len; ++k) {
                str +=  "\""+ keys.splice(0,1)[0] + "\":{";

                ++_count;
                if (k == len-1) {
                    str = str.substr(0, str.length-1);
                    str += "\"_content_\"";
                    for (var c = 0; c<_count; ++c) {
                        str += "}"
                    }
                }
            }

            newObj = parseDataObject(JSON.parse(str), value);
            local._data = merge(local._data, newObj);

        } else if ( typeof(local._data[name]) == 'undefined' ) {
            local._data[name] = value
        }
    }

    /**
     * Get data
     *
     * @param {String} variable Data name to set
     * @return {Object | String} data Data object or String
     * */
    var get = function(variable) {
        return local._data[variable]
    }

    /**
     * Set resources
     *
     * @param {object} viewConf - template configuration
     * @param {string} localRessouces - rule name
     * */
    var setResources = function(viewConf, localRessource) {
        if (!viewConf) {
            self.throwError(500, 'No views configuration found. Did you try to add views before using Controller::render(...) ? Try to run: ./gina.sh -av '+options.conf.bundle)
        }

        var res     = '',
            tmpRes  = {},
            css     = {
                media   : "screen",
                rel     : "stylesheet",
                type    : "text/css",
                content : []
            },
            cssStr  = ' ',
            js      = {
                type    : "text/javascript",
                content : []
            },
            jsStr   = ' ',
            exclude  = null;

        //intercept errors in case of malformed config
        if ( typeof(viewConf) != "object" ) {
            cssStr  = viewConf;
            jsStr   = viewConf
        }


        //cascading merging
        if (localRessource !== 'default') {
            if ( typeof(viewConf[localRessource]) != 'undefined') {

                var noneDefaultJs   = (viewConf[localRessource]['javascripts']) ? JSON.parse(JSON.stringify(viewConf[localRessource]['javascripts'])) : [] ;
                var noneDefaultCss  = (viewConf[localRessource]['stylesheets']) ? JSON.parse(JSON.stringify(viewConf[localRessource]['stylesheets'])) : [] ;

                viewConf[localRessource] = merge(viewConf.default, viewConf[localRessource]);

                if ( viewConf[localRessource]["javascriptsExclude"] ) {

                    if ( Array.isArray(viewConf[localRessource]["javascriptsExclude"]) && !/(all|\*)/.test(viewConf[localRessource]["javascriptsExclude"][0]) || typeof(viewConf[localRessource]["javascriptsExclude"]) == 'string' && !/(all|\*)/.test(viewConf[localRessource]["javascriptsExclude"]) ) {

                        for (var i = 0, len = viewConf.default['javascripts'].length; i<len; ++i) {
                            if ( viewConf.default['javascripts'] && viewConf[localRessource]['javascripts'].indexOf(viewConf.default['javascripts'][i]) ) {
                                viewConf[localRessource]['javascripts'].splice(viewConf[localRessource]['javascripts'].indexOf(viewConf.default['javascripts'][i]), 1)
                            }
                        }
                    } else {// else means that we exclude all default
                        viewConf[localRessource]['javascripts'] = noneDefaultJs;
                    }
                }

                if ( viewConf[localRessource]["stylesheetsExclude"] ) {

                    if ( Array.isArray(viewConf[localRessource]["stylesheetsExclude"]) && !/(all|\*)/.test(viewConf[localRessource]["stylesheetsExclude"][0]) || typeof(viewConf[localRessource]["stylesheetsExclude"]) == 'string' && !/(all|\*)/.test(viewConf[localRessource]["stylesheetsExclude"]) ) {

                        for (var i = 0, len = viewConf.default['stylesheets'].length; i<len; ++i) {
                            if ( viewConf.default['stylesheets'] && viewConf[localRessource]['javascripts'].indexOf(viewConf.default['javascripts'][i]) ) {
                                viewConf[localRessource]['stylesheets'].splice(viewConf[localRessource]['javascripts'].indexOf(viewConf.default['javascripts'][i]), 1)
                            }
                        }
                    } else {// else means that we exclude all default
                        viewConf[localRessource]['stylesheets'] = noneDefaultJs;
                    }
                }


            } else {
                viewConf[localRessource] = viewConf.default
            }
        }

        //Get css
        if( viewConf[localRessource]["stylesheets"] ) {
            tmpRes  = getNodeRes('css', cssStr, viewConf[localRessource]["stylesheets"], css);

            cssStr  = tmpRes.cssStr;
            css     = tmpRes.css;
            tmpRes  = null
        }
        //Get js
        if( viewConf[localRessource]["javascripts"] ) {
            tmpRes  = getNodeRes('js', jsStr, viewConf[localRessource]["javascripts"], js);

            jsStr   = tmpRes.jsStr;
            js      = tmpRes.js;
            tmpRes  = null
        }

        set('page.stylesheets', cssStr);
        set('page.scripts', jsStr)
    }

    /**
     * Get node resources
     *
     * @param {string} type
     * @param {string} resStr
     * @param {array} resArr
     * @param {object} resObj
     *
     * @return {object} content
     *
     * @private
     * */
    var getNodeRes = function(type, resStr, resArr, resObj) {
        switch(type){
            case 'css':
                var css = resObj;
                for (var res in resArr) {
                    //means that you will find options.
                    if (typeof(resArr[res]) == "object") {
                        //console.info('found object ', resArr[res]);
                        css.media = (resArr[res].options.media) ? resArr[res].options.media : css.media;
                        css.rel = (resArr[res].options.rel) ? resArr[res].options.rel : css.rel;
                        css.type = (resArr[res].options.type) ? resArr[res].options.type : css.type;
                        if (!css.content[resArr[res]._]) {
                            css.content[resArr[res]._] = '<link href="'+ resArr[res]._ +'" media="'+ css.media +'" rel="'+ css.rel +'" type="'+ css.type +'">';
                            resStr += '\n\t' + css.content[resArr[res]._]
                        }

                    } else {
                        css.content[resArr[res]] = '<link href="'+ resArr[res] +'" media="screen" rel="'+ css.rel +'" type="'+ css.type +'">';
                        resStr += '\n\t' + css.content[resArr[res]]
                    }


                }
                return { css : css, cssStr : resStr }
            break;

            case 'js':
                var js = resObj;
                for (var res in resArr) {
                    //means that you will find options
                    if ( typeof(resArr[res]) == "object" ) {
                        js.type = (resArr[res].options.type) ? resArr[res].options.type : js.type;
                        if (!js.content[resArr[res]._]) {
                            js.content[resArr[res]._] = '<script type="'+ js.type +'" src="'+ resArr[res]._ +'"></script>';
                            resStr += '\n' + js.content[resArr[res]._];
                        }

                    } else {
                        js.content[resArr[res]] = '<script type="'+ js.type +'" src="'+ resArr[res] +'"></script>';
                        resStr += '\n' + js.content[resArr[res]]
                    }


                }
                return { js : js, jsStr : resStr }
            break;
        }
    }

    /**
     * TODO -  SuperController.setMeta()
     * */
    // this.setMeta = function(metaName, metacontent) {
    //
    // }

    var getData = function() {
        return refToObj( local._data )
    }

    var isValidURL = function(url){
        var re = /(http|ftp|https|sftp):\/\/[\w-]+(\.[\w-]+)+([\w.,@?^=%&amp;:\/~+#-]*[\w@?^=%&amp;\/~+#-])?/;
        return (re.test(url)) ? true : false
    }

    /**
     * redirect
     *
     * TODO - improve redirect based on `utils.routing`
     * e.g.: self.redirect('project-get', { companyId: companyId, clientId: clientId, id: projectId }, true)
     *
     * You have to ways of using this method
     *
     * 1) Through routing.json
     * ---------------------
     * Allows you to redirect to an internal [ route ], an internal [ path ], or an external [ url ]
     *
     * For this to work you have to set in your routing.json a new route using  "param":
     * { "action": "redirect", "route": "one-valid-route" }
     * OR
     * { "action": "redirect", "url": "http://www.somedomain.com/page.html" }
     *
     * OR
     * { "action": "redirect", "path": "/", "ignoreWebRoot": true }
     *
     * if you are free to use the redirection [ code ] of your choice, we've set it to 301 by default
     *
     *
     * 2) By calling this.redirect(rule, [ignoreWebRoot]):
     * ------------------------------------------------
     * where `this` is :
     *  - a Controller instance
     *  - a Middleware instance
     *
     * Where `rule` is either a string defining
     *  - the rule/route name => home
     *  - an URI => /home
     *  - a URL => http://www.google.com/
     *
     * And Where `ignoreWebRoot` is an optional parameter used to ignore web root settings (Standalone mode or user set web root)
     * `ignoreWebRoot` behaves the like set to `false` by default
     *
     * N.B.: Gina will tell browsers not to cache redirections if you are using `dev` environement
     *
     * @param {object|string} req|rule - Request Object or Rule/Route name
     * @param {object|boolean} res|ignoreWebRoot - Response Object or Ignore WebRoot & start from domain root: /
     * @param {object} [params] TODO
     *
     * @callback [ next ]
     * */
    this.redirect = function(req, res, next) {
        var conf    = self.getConfig();
        var wroot   = conf.server.webroot;
        var routing = conf.content.routing;
        var route   = '', rte = '';
        var ignoreWebRoot = null;

        if ( typeof(req) === 'string' ) {

            if ( typeof(res) == 'undefined') {
                // nothing to do
            } else if (typeof(res) === 'string' || typeof(res) === 'number' || typeof(res) === 'boolean') {
                if ( /true|1/.test(res) ) {
                    ignoreWebRoot = true
                } else if ( /false|0/.test(res) ) {
                    ignoreWebRoot = false
                } else {
                    res = local.res;
                    var stack = __stack.splice(1).toString().split(',').join('\n');
                    self.throwError(res, 500, 'Internal Server Error\n@param `ignoreWebRoot` must be a boolean\n' + stack);
                }
            }

            if ( req.substr(0,1) === '/') { // is relative (not checking if the URI is defined in the routing.json)
                if (wroot.substr(wroot.length-1,1) == '/') {
                    wroot = wroot.substr(wroot.length-1,1).replace('/', '')
                }
                rte     = ( ignoreWebRoot != null && ignoreWebRoot) ? req : wroot + req;
                req     = local.req;
                res     = local.res;
                next    = local.next;
                var isRelative = true;
                req.routing.param.path = rte
            } else if ( isValidURL(req) ) { // might be an URL
                rte     = req;
                req     = local.req;
                res     = local.res;
                next    = local.next;
                req.routing.param.url = rte
            } else { // is by default a route name
                rte = route = ( new RegExp('^/'+conf.bundle+'-$').test(req) ) ? req : wroot.match(/[^/]/g).join('') +'-'+ req;
                req     = local.req;
                res     = local.res;
                next    = local.next;
                req.routing.param.route = routing[rte]
            }
        } else {
            route = req.routing.param.route;
        }

        var path        = req.routing.param.path || '';
        var url         = req.routing.param.url;
        var code        = req.routing.param.code || 301;

        var keepParams  = req.routing.param['keep-params'] || false;

        var condition   = true; //set by default for url @ path redirect

        if (route) { // will go with route first
            condition = ( typeof(routing[route]) != 'undefined') ? true : false;
        }

        if ( !self.forward404Unless(condition, req, res) ) { // forward to 404 if bad route

            if (wroot.substr(wroot.length-1,1) == '/') {
                wroot = wroot.substr(wroot.length-1,1).replace('/', '')
            }


            if (route) { // will go with route first
                path = (ignoreWebRoot) ? routing[route].url.replace(wroot, '') : routing[route].url;
                if (path instanceof Array) {
                    path = path[0] //if it is an array, we just take the first one
                }
            } else if (url && !path) {
                path = ( (/\:\/\//).test(url) ) ? url : req.protocol + '://' + url;
            } else if(path && typeof(isRelative) !=  'undefined') {
                // nothing to do
            } else {
                //path = conf.protocol + '://' +conf.hostname + path
                path = conf.hostname + path
            }

            if (req.headersSent) return next();

            if (conf.env == 'dev') {
                res.writeHead(code, {
                    'Location': path,
                    'Cache-Control': 'no-cache, no-store, must-revalidate', // preventing browsers from caching it
                    'Pragma': 'no-cache',
                    'Expires': '0'
                })
            } else {
                res.writeHead(code, { 'Location': path })
            }


            console.warn(local.req.method +' ['+local.res.statusCode +'] '+ path);
            res.end();
            local.res.headersSent = true;// done for the render() method
        }
        next()
    }

    /**
     * Move files to assets dir
     *
     * @param {object} res
     * @param {collection} files
     *
     * @callback cb
     * @param {object} [err]
     * */
    var movefiles = function (i, res, files, cb) {
        if (!files.length || files.length == 0) {
            cb(false)
        } else {
            if ( fs.existsSync(files[i].target) ) new _(files[i].target).rmSync();

            var sourceStream = fs.createReadStream(files[i].source);
            var destinationStream = fs.createWriteStream(files[i].target);

            sourceStream
                .pipe(destinationStream)
                .on('error', function () {
                    var err = 'Error on SuperController::copyFile(...): Not found ' + files[i].source + ' or ' + files[i].target;
                    cb(err)
                })
                .on('close', function () {

                    try {
                        fs.unlinkSync(files[i].source);
                        files.splice(i, 1);
                    } catch (err) {
                        cb(err)
                    }

                    movefiles(i, res, files, cb)
                })
        }
    }

    // TODO - download file
    /**
     * Download to targeteded filename.ext - Will create target if new
     * Use `cb` callback or `onComplete` event
     *
     * @param {string} filename
     * @param {string} content
     *
     * @callback [cb]
     *  @param {object|null} error
     *
     * @event
     *  @param {object|null} error
     **/
    //this.download(filename, content, cb) {}

    //this.downloadLocalfile = function(pathname){}

    /**
     * Upload to target - Will create target if new
     * Use `cb` callback or `onComplete` event
     *
     * @param {string} target
     *
     * @callback [cb]
     *  @param {object} error
     *  @param {array} files
     *
     * @event
     *  @param {object} error
     *  @param {array} files
     *
     * */
    this.upload = function(target, cb) {

        var start = function(target, cb) {
            var files = local.req.files, uploadedFiles = [];

            if ( typeof(files) == 'undefined' || files.count() == 0 ) {
                if (cb) {
                    cb(new Error('No file to upload'))
                } else {
                    self.emit('uploaded', new Error('No file to upload'))
                }
            } else {
                // saving files
                var uploadDir   = new _(target)
                    , list      = []
                    , i         = 0
                    , folder    = uploadDir.mkdirSync()
                    , el        = null;

                if (folder instanceof Error) {
                    if (cb) {
                        cb(folder)
                    } else {
                        self.emit('uploaded', folder)
                    }
                } else {
                    // files list
                    for (el in files) {
                        list[i] = {
                            source: files[el].path,
                            target: _(uploadDir.toString() + '/' + files[el].originalFilename)
                        };
                        uploadedFiles[i] = { location: list[i].target, file: files[el].originalFilename };
                        ++i
                    }

                    movefiles(0, local.res, list, function (err) {
                        if (err) {
                            if (cb) {
                                cb(new Error('No file to upload'))
                            } else {
                                self.emit('uploaded', new Error('No file to upload'))
                            }
                        } else {
                            if (cb) {
                                cb(false, uploadedFiles)
                            } else {
                                self.emit('uploaded', false, uploadedFiles)
                            }
                        }
                    })
                }
            }
        }

        if ( typeof(cb) == 'undefined' ) {

            return {
                onComplete : function(cb){
                    self.on('uploaded', cb);
                    start(target)
                }
            }
        } else {
            start(target, cb)
        }
    }


    /**
     * Query
     *
     * Allows you to act as a proxy between your frontend and a 1/3 API
     * */
    local.query.data = {};
    local.query.options = {
        host    : undefined, // Must be an IP
        hostname  : undefined, // cname of the host e.g.: `www.google.com` or `localhost`
        path    : undefined, // e.g.: /test.html
        port    : 80, // #80 by default but can be 3000
        method  : 'GET', // POST | GET | PUT | DELETE
        agent   : false,
        keepAlive: true,
        auth    : undefined, // use `"username:password"` for basic authentification
        rejectUnauthorized: undefined, // ignore verification when requesting on https (443)
        headers : {
            'Content-Type': 'application/json',
            // 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',

            // 'X-Requested-With': 'XMLHttpRequest' // to convert into an XHR query
            'Content-Length': local.query.data.length
        }
    };

    this.query = function(options, data, callback) {

        var queryData           = {}
            , defaultOptions    = local.query.options
            , path              = options.path
            , browser           = null
            , options           = merge(options, defaultOptions)
        ;

        for (var o in options) {//cleaning
            if ( typeof(options[o]) == 'undefined' || options[o] == undefined) {
                delete options[o]
            }
        }

        if ( !options.host && !options.hostname ) {
            self.emit('query#complete', new Error('SuperController::query() needs at least a `host IP` or a `hostname`'))
        }

        if ( /\:\/\//.test(options.host) ) {
            var hArr = options.host.split('://');
            options.port = ports[hArr[0]];
            options.host = hArr[1]
        }

        if (arguments.length <3) {
            if ( typeof(data) == 'function') {
                var callback = data;
                var data = undefined;
            } else {
                callback = undefined;
            }
        }
        if ( typeof(data) != 'undefined' &&  data.count() > 0) {

            queryData = '?';
            // TODO - if 'application/json' && method == (put|post)
            if ( ['put', 'post'].indexOf(options.method.toLowerCase()) >-1 && /(text\/plain|application\/json|application\/x\-www\-form)/i.test(options.headers['Content-Type']) ) {
                // replacing
                queryData = encodeURIComponent(JSON.stringify(data))

            } else {
                //Sample request.
                //options.path = '/updater/start?release={"version":"0.0.5-dev","url":"http://10.1.0.1:8080/project/bundle/repository/archive?ref=0.0.5-dev","date":1383669077141}&pid=46493';

                for (var d in data) {
                    if ( typeof(data[d]) == 'object') {
                        data[d] = JSON.stringify(data[d]);
                    }
                    queryData += d + '=' + data[d] + '&';
                }

                queryData = queryData.substring(0, queryData.length-1);
                queryData = queryData.replace(/\s/g, '%20');
                options.path += queryData;
            }

        } else {
            queryData = ''
        }


        // Internet Explorer override
        if ( /msie/i.test(local.req.headers['user-agent']) ) {
            options.headers['Content-Type'] = 'text/plain';
        } else {
            options.headers['Content-Type'] = local.options.conf.server.coreConfiguration.mime['json'];
        }

        if ( typeof(local.req.headers.cookie) != 'undefined' ) { // useful for CORS : forward cookies from the original request
            options.headers.cookie = local.req.headers.cookie;
        }

        //you need this, even when empty.
        options.headers['Content-Length'] = queryData.length;

        browser = (options.port == 443) ? https : http;

        var req = browser.request(options, function(res) {

            res.setEncoding('utf8');

            // upgrade response headers to handler
            if ( typeof(res.headers['access-control-allow-credentials']) != 'undefined' )
                local.options.withCredentials = res.headers['access-control-allow-credentials'];


            var data = '';

            res.on('data', function onData (chunk) {
                data += chunk;
            });

            res.on('end', function onEnd() {

                //Only when needed.
                if ( typeof(callback) != 'undefined' ) {
                    if ( typeof(data) == 'string' && /^(\{|%7B|\[{)/.test(data) ) {
                        try {
                            data = JSON.parse(data)
                        } catch (err) {
                            data = {
                                status    : 500,
                                error     : data
                            }
                        }
                    }

                    if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined' ) {
                        callback(data)
                    } else {
                        callback( false, data )
                    }

                } else {
                    if ( typeof(data) == 'string' && /^(\{|%7B|\[{)/.test(data) ) {
                        try {
                            data = JSON.parse(data)
                        } catch (err) {
                            data = {
                                status    : 500,
                                error     : data
                            }
                            self.emit('query#complete', data)
                        }
                    }

                    if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined' ) {
                        self.emit('query#complete', data)
                    } else {
                        self.emit('query#complete', false, data)
                    }
                }
            })
        });


        //starting from from >0.10.15
        req.on('error', function onError(err) {

            console.error(err.stack||err.message);
            // you can get here if :
            //  - you are trying to query using: `enctype="multipart/form-data"`
            //  -
            if ( typeof(callback) != "undefined") {
                callback(err)
            } else {
                var data = {
                    status    : 500,
                    error     : err.stack || err.message
                };

                self.emit('query#complete', data)
            }
        });


        if (req) { // don't touch this please
            if (req.write) req.write(queryData);
            if (req.end) req.end();
        }

        return {
            onComplete  : function(cb) {
                self.once('query#complete', function(err, data){

                    if ( typeof(data) == 'string' && /^(\{|%7B|\[{)/.test(data) ) {
                        try {
                            data = JSON.parse(data)
                        } catch (err) {
                            data = {
                                status    : 500,
                                error     : data
                            }
                        }
                    }

                    if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined') {
                        cb(data)
                    } else {
                        cb(err, data)
                    }
                })
            }
        }
    }


    /**
     * forward404Unless
     *
     * @param {boolean} condition
     * @param {object} req
     * @param {object} res
     *
     * @callback [ next ]
     * @param {string | boolean} err
     *
     * @return {string | boolean} err
     * */
    this.forward404Unless = function(condition, req, res, next) {
        var pathname = req.url;

        if (!condition) {
            self.throwError(res, 404, 'Page not found\n' + pathname);
            var err = new Error('Page not found\n' + pathname);
            if ( typeof(next) != 'undefined')
                next(err)
            else
                return err
        } else {
            if ( typeof(next) != 'undefined' )
                next(false)
            else
                return false
        }
    }

    /**
     * Get all Params
     * */
    var getParams = function(req) {

        req.getParams = function() {
            // copy
            var params = JSON.parse(JSON.stringify(req.params));
            switch( req.method.toLowerCase() ) {
                case 'get':
                    params = merge(params, req.get, true);
                    break;

                case 'post':
                    params = merge(params, req.post, true);
                    break;

                case 'put':
                    params = merge(params, req.put, true);
                    break;

                case 'delete':
                    params = merge(params, req.delete, true);
                    break;
            }

            return params
        }

        req.getParam = function(name) {
            // copy
            var param = null, params = JSON.parse(JSON.stringify(req.params));
            switch( req.method.toLowerCase() ) {
                case 'get':
                    param = req.get[name];
                    break;

                case 'post':
                    param = req.post[name];
                    break;

                case 'put':
                    param= req.put[name];
                    break;

                case 'delete':
                    param = req.delete[name];
                    break;
            }

            return param
        }
    }

    /**
     * Get config
     *
     * @param {string} [name] - Conf name without extension.
     * @return {object} config
     *
     * TODO - Protect result
     * */
    this.getConfig = function(name) {
        var config = null;

        if ( typeof(name) != 'undefined' ) {
            try {
                // needs to be read only
                config = JSON.stringify(local.options.conf.content[name]);
                return JSON.parse(config)
            } catch (err) {
                return undefined
            }
        } else {
            config = JSON.stringify(local.options.conf);
            return JSON.parse(config)
        }
    }

    /**
     * Get locales
     *
     * @param {string} [shortCountryCode] - e.g. EN
     *
     * @return {object} locales
     * */
    this.getLocales = function (shortCountryCode) {

        var userLocales = local.options.conf.locales;

        if ( typeof(shortCountryCode) != 'undefined' ) {

            var locales         = new Collection( getContext('gina').locales );

            try {
                userLocales = locales.findOne({ lang: userLangCode }).content
            } catch (err) {
                console.warn('language code `'+ userLangCode +'` not handled to setup locales: replacing by `en`');
                userLocales = locales.findOne({ lang: 'en' }).content // by default
            }
        }


        /**
         * Get countries list
         *
         * @param {string} [code] - e.g.: short, long, fifa, m49
         *
         * @return {object} countries - countries code & value list
         * */
        var getCountries = function (code) {
            var list = {}, cde = 'short', name = null;

            if ( typeof(code) != 'undefined' && typeof(userLocales[0][code]) == 'string' ) {
                cde = code
            } else if ( typeof(code) != 'undefined' ) (
                console.warn('`'+ code +'` not supported : sticking with `short` code')
            )

            for ( var i = 0, len = userLocales.length; i< len; ++i ) {

                if (userLocales[i][cde]) {

                    name = userLocales[i].full || userLocales[i].officialName.short;

                    if ( name )
                        list[ userLocales[i][cde] ] = name;
                }
            }

            return list
        }

        return {
            'getCountries': getCountries
        }
    }

    /**
     * Get forms rules
     *
     * @param {string} [formId]
     *
     * @return {object} rules
     *
     * */
    this.getFormsRules = function (formId) {
        try {

            if ( typeof(formId) != 'undefined' ) {
                try {
                    formId = formId.replace(/\-/g, '.');
                    return JSON.parse(JSON.stringify(local.options.conf.content.forms)).rules[formId]
                } catch (err) {
                    self.throwError(err)
                }
            } else {
                return JSON.parse(JSON.stringify(local.options.conf.content.forms)).rules
            }

        } catch (err) {
            self.throwError(local.res, 500, err.stack||err.message)
        }
    }

    /**
     * Throw error
     *
     * @param {object} [ res ]
     * @param {number} code
     * @param {string} msg
     *
     * @return {void}
     * */
    this.throwError = function(res, code, msg) {

        if (arguments.length == 1 && typeof(res) == 'object' ) {
            var code    = ( res && typeof(res.status) != 'undefined' ) ?  res.status : 500;
                //, msg   = res.stack || res.message || res.error
            var msg = {};

            if ( res instanceof Error) {
                msg.error   = res.message;
                msg.stack   = res.stack;
            } else {
                msg = JSON.parse(JSON.stringify(res))
            }

            var res   = local.res;

        } else if (arguments.length < 3) {
            var msg             = code || null
                , code          = res || 500
                , res           = local.res;
        }

        var req     = local.req;
        var next    = local.next;

        if (!res.headersSent) {
            if ( self.isXMLRequest() || !hasViews() || !local.options.isUsingTemplate ) {
                // allowing this.throwError(err)
                if ( typeof(code) == 'object' && !msg && typeof(code.status) != 'undefined' && typeof(code.error) != 'undefined' ) {
                    msg     = code.error || code.message;
                    code    = code.status || 500;
                }

                if ( !req.headers['content-type'] ) {
                    req.headers['content-type'] = local.options.conf.server.coreConfiguration.mime['json']
                }
                // Internet Explorer override
                if ( typeof(req.headers['user-agent']) != 'undefined' ) {
                    if ( /msie/i.test(req.headers['user-agent']) ) {
                        res.writeHead(code, "Content-Type", "text/plain")
                    } else {
                        res.writeHead(code, { 'Content-Type': req.headers['content-type']} )
                    }
                } else if ( typeof(req.headers['content-type']) != 'undefined' ) {
                    res.writeHead(code, { 'Content-Type': req.headers['content-type']} )
                } else {
                    res.writeHead(code, "Content-Type", local.options.conf.server.coreConfiguration.mime['json'])
                }

                console.error(req.method +' ['+res.statusCode +'] '+ req.url);
                res.end(JSON.stringify({
                    status: code,
                    error: msg.error || msg,
                    stack: msg.stack
                }))
            } else {
                res.writeHead(code, { 'Content-Type': 'text/html'} );
                console.error(req.method +' ['+ res.statusCode +'] '+ req.url);

                //var msgString = msg.stack || msg.error || msg;
                var msgString = '<h1 class="status">Error '+ code +'.</h1>';
                var eCode = code.toString().substr(0,1);

                if ( typeof(msg) == 'object' ) {

                    if (msg.title) {
                        msgString += '<pre class="'+ eCode +'xx title">'+ msg.title +'</pre>';
                    }

                    if (msg.error) {
                        msgString += '<pre class="'+ eCode +'xx message">'+ msg.error +'</pre>';
                    }

                    if (msg.message) {
                        msgString += '<pre class="'+ eCode +'xx message">'+ msg.message +'</pre>';
                    }

                    if (msg.stack) {

                        if (msg.error) {
                            msg.stack = msg.stack.replace(msg.error, '')
                        }

                        if (msg.message) {
                            msg.stack = msg.stack.replace(msg.message, '')
                        }

                        msg.stack = msg.stack.replace('Error:', '').replace(' ', '');
                        msgString += '<pre class="'+ eCode +'xx stack">'+ msg.stack +'</pre>';
                    }

                } else {
                    msgString += '<pre class="'+ eCode +'xx message">'+ msg +'</pre>';
                }

                res.end(msgString)
            }
        } else {
            next()
        }
    }

    // converting references to objects
    var refToObj = function (arr){
        var tmp = null,
            curObj = {},
            obj = {},
            count = 0,
            data = {},
            last = null;
        for (var r in arr) {
            tmp = r.split(".");
            //Creating structure - Adding sub levels
            for (var o in tmp) {
                count++;
                if (last && typeof(obj[last]) == "undefined") {
                    curObj[last] = {};
                    if (count >= tmp.length) {
                        // assigning.
                        // !!! if null or undefined, it will be ignored while extending.
                        curObj[last][tmp[o]] = (arr[r]) ? arr[r] : "undefined";
                        last = null;
                        count = 0;
                        break
                    } else {
                        curObj[last][tmp[o]] = {}
                    }
                } else if (tmp.length === 1) { //Just one root var
                    curObj[tmp[o]] = (arr[r]) ? arr[r] : "undefined";
                    obj = curObj;
                    break
                }
                obj = curObj;
                last = tmp[o]
            }
            //data = merge(data, obj, true);
            data = merge(obj, data);
            obj = {};
            curObj = {}
        }
        return data
    }

    init()
};

SuperController = inherits(SuperController, EventEmitter);
module.exports = SuperController