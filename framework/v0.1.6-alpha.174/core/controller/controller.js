"use strict";
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

//Imports.
var fs              = require('fs');
const {promises: {readFile}} = require("fs");
const { pipeline }  = require('stream/promises');
const exec          = require('child_process').exec;
var util            = require('util');
var promisify       = util.promisify;
var EventEmitter    = require('events').EventEmitter;

const { Resolver } = require('node:dns').promises;
const resolver = new Resolver();

var lib             = require('./../../lib') || require.cache[require.resolve('./../../lib')];
const cache         = new lib.Cache();
var merge           = lib.merge;
var inherits        = lib.inherits;
var console         = lib.logger;
var Collection      = lib.Collection;
var routingLib      = lib.routing;
var Domain          = lib.Domain;
var domainLib       = new Domain();
var swig            = require('./../deps/swig-1.4.2');
const { type }      = require('node:os');
var SwigFilters     = lib.SwigFilters;
var statusCodes     = requireJSON( _( getPath('gina').core + '/status.codes') );


/**
 * @class SuperController
 *
 *
 * @package     Gina
 * @namespace
 * @author      Rhinostone <contact@gina.io>
 *
 * @api         Public
 */
function SuperController(options) {

    //public
    this.name = 'SuperController';
    this.engine = {};


    var self = this;
    //private
    var local = {
        req     : null,
        res     : null,
        next    : null,
        options : options || null,
        query   : {},
        _data   : {},
        view    : {}
    };

    /**
     * SuperController Constructor
     * @constructor
     * */
    var init = function() {

        if ( typeof(SuperController.initialized) != 'undefined' ) {
            return getInstance();
        }

        SuperController.instance = self;
        if (local.options) {
            SuperController.instance._options = local.options;
        }

        SuperController.initialized = true;
    }

    var getInstance = function() {
        local.options = SuperController.instance._options = options;
        // Fixed on 2022-03-07 for none-developpement environnements (without cache)
        self._options = local.options;

        return SuperController.instance;
    }


    var hasViews = function() {
        return ( typeof(local.options.template) != 'undefined' ) ? true : false;
    }

    /**
     * isHttp2
     * Returns `true` if server configured for HTTP/2
     *
     * @returns {boolean} isHttp2
     */
    var isHttp2 = function() {
        var options =  local.options;
        var protocolVersion = ~~options.conf.server.protocol.match(/\/(.*)$/)[1].replace(/\.\d+/, '');
        var httpLib =  options.conf.server.protocol.match(/^(.*)\//)[1] + ( (protocolVersion >= 2) ? protocolVersion : '' );


        return /http2/.test(httpLib)
    }

    var headersSent = function(res) {
        var _res = ( typeof(res) != 'undefined' ) ? res : local.res;
        if (
            typeof(_res.stream) != 'undefined'
            && typeof(_res.stream.headersSent) != 'undefined'
            && _res.stream.headersSent != 'null'
        ) {
            return true
        }

        if ( typeof(_res.headersSent) != 'undefined' ) {
            return _res.headersSent
        }


        return false;
    }
    /**
     * isSecured
     * Returns `true` if server configured to handle a HTTPS exchanges
     *
     * @returns {boolean} isSecured
     */
    var isSecured = function() {
        return /https/.test(local.options.conf.server.scheme)
    }

    /**
     * freeMemory
     *
     * @param {array} variables
     * @param {boolean} isGlobalModeNeeded
     */
    var freeMemory = function(variables, isGlobalModeNeeded) {
        if ( !Array.isArray(variables) || !variables.length ) {
            return;
        }
        if ( typeof(isGlobalModeNeeded) == 'undefined' ) {
            isGlobalModeNeeded = true;
        }
        var i = 0, len = variables.length;
        while (i<len) {
            if ( typeof(variables[i]) != 'undefined' ) {
                variables[i] = null;
            }
            ++i;
        }

        if (/^true$/i.test(isGlobalModeNeeded) ) {
            // all but local.options becasue of `self.requireController('namespace', self._options)` calls
            // local = null;
        }
    }

    this.getRequestObject = function() {
        return local.req;
    }

    this.getResponseObject = function() {
        return local.res;
    }

    this.getNextCallback = function() {
        return local.next;
    }

    /**
     * Check if env is running cacheless
     * */
    this.isCacheless = function() {
        return (/^true$/i.test(process.env.NODE_ENV_IS_DEV)) ? true : false;
    }
    /**
     * Check if the project scope is set for local
     * */
    this.isLocalScope = function() {
        return (/^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL)) ? true : false;
    }
    /**
     * Check if the project scope is set for production
     * */
    this.isProductionScope = function() {
        return (/^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION)) ? true : false;
    }


    this.setOptions = function(req, res, next, options) {
        local.options = SuperController.instance._options = options;
        local.options.renderingStack = (local.options.renderingStack) ? local.options.renderingStack : [];
        local.options.isRenderingCustomError = (local.options.isRenderingCustomError) ? local.options.isRenderingCustomError : false;

        // N.B.: Avoid setting `page` properties as much as possible from the routing.json
        // It will be easier for the framework if set from the controller.
        //
        // Here is a sample if you choose to set  `page.view.title` from the rule
        // ------rouging rule sample -----
        // {
        //    "default": {
        //        "url": ["", "/"],
        //            "param": {
        //            "control": "home",
        //            "title": "My Title"
        //        }
        // }
        //
        // ------controller action sample -----
        // Here is a sample if you decide to set `page.view.title` from your controller
        //
        // this.home = function(req, res, next) {
        //      var data = { page: { view: { title: "My Title"}}};
        //      self.render(data)
        // }

        if ( typeof(options.conf.content.routing[options.rule].param) !=  'undefined' ) {
            var str = 'page.'
                , p = options.conf.content.routing[options.rule].param
            ;

            for (let key in p) {
                if ( p.hasOwnProperty(key) && !/^(control)$/.test(key) ) {
                    str += key + '.';
                    let obj = p[key], value = '';
                    for (let prop in obj) {
                        if (obj.hasOwnProperty(prop)) {
                            value += obj[prop];
                            continue;
                        }

                        if ( /^:/.test(value) ) {
                            str = 'page.view.params.'+ key + '.';
                            set(str.substring(0, str.length-1), req.params[value.substring(1)]);
                        } else if (/^(file|title)$/.test(key)) {
                            str = 'page.view.'+ key + '.';
                            set(str.substring(0, str.length-1), value);
                        } else {
                            set(str.substring(0, str.length-1), value)
                        }

                        str = 'page.'

                    }
                }
            }

            freeMemory([str, p], false);
        }

        local.req = req;
        local.res = res;
        local.next = next;

        getParams(req);
        if (
            typeof(local.options.template) != 'undefined'
            && typeof(local.options.control) != 'undefined'
        ) {
            var  action             = local.options.control
                , rule              = local.options.rule
                , ext               = 'html' // by default
                , isWithoutLayout   = false // by default
                , namespace         = local.options.namespace || ''
            ;

            if (
                typeof(local.options.template) != 'undefined'
                && local.options.template
            ) {
                if (
                    typeof(local.options.template.ext) != 'undefined'
                    && local.options.template.ext
                    && local.options.template.ext != ''
                ) {
                    ext = local.options.template.ext
                }

                if ( !/\./.test(ext) ) {
                    ext = '.' + ext;
                    local.options.template.ext = ext
                }

                if (
                    typeof(local.options.template.layout) == 'undefined'
                    || /^false$/.test(local.options.template.layout)
                    || local.options.template.layout == ''
                ) {
                    isWithoutLayout = true;
                }
            }


            if ( hasViews() ) {

                if ( typeof(local.options.file) == 'undefined') {
                    local.options.file = 'index'
                }

                if ( typeof(local.options.isWithoutLayout) == 'undefined' || !isWithoutLayout ) {
                    local.options.isWithoutLayout = false;
                }

                rule        = local.options.rule;
                namespace   = local.options.namespace || 'default';


                set('page.view.file', local.options.file);
                set('page.view.title', rule.replace(new RegExp('@' + options.conf.bundle), ''));
                set('page.view.namespace', namespace);
            }


            var ctx = getContext('gina');
            // new declaration && overrides
            var arch = process.arch;
            switch (process.arch) {
                case 'x64':
                    arch = 'amd64'
                    break;
                case 'armv7l':
                    arch = 'armhf'
                    break;
                case 'x86':
                    arch = 'i386'
                    break;
                default:
                    break;
            }
            var version = {
                "number"        : ctx.version,
                "platform"      : process.platform,
                "arch"          : arch,
                "nodejs"        : process.versions.node,
                "middleware"    : ctx.middleware
            };

            set('page.environment.allocated memory', (require('v8').getHeapStatistics().heap_size_limit / (1024 * 1024 * 1024)).toFixed(2) +' GB');

            set('page.environment.gina', version.number);
            set('page.environment.gina pid', GINA_PID);
            set('page.environment.nodejs', version.nodejs +' '+ version.platform +' '+ version.arch);
            set('page.environment.engine', options.conf.server.engine);//version.middleware
            set('page.environment.uvThreadpoolSize', process.env.UV_THREADPOOL_SIZE);
            set('page.environment.env', process.env.NODE_ENV);
            set('page.environment.envIsDev', /^true$/i.test(process.env.NODE_ENV_IS_DEV) );
            set('page.environment.scope', process.env.NODE_SCOPE);
            set('page.environment.scopeIsLocal', /^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL) );
            set('page.environment.scopeIsProduction', /^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION) );
            set('page.environment.date.now', new Date().format("isoDateTime"));
            set('page.environment.isCacheless', self.isCacheless());

            // var requestPort = req.headers.port || req.headers[':port'];
            // var isProxyHost = (
            //     typeof(req.headers.host) != 'undefined'
            //     && typeof(requestPort) != 'undefined'
            //     &&  /^(80|443)$/.test(requestPort)
            //     && local.options.conf.server.scheme +'://'+ req.headers.host +':'+ requestPort != local.options.conf.hostname.replace(/\:\d+$/, '') +':'+ local.options.conf.server.port
            //     ||
            //     typeof(req.headers[':authority']) != 'undefined'
            //     && local.options.conf.server.scheme +'://'+ req.headers[':authority'] != local.options.conf.hostname
            //     ||
            //     typeof(req.headers.host) != 'undefined'
            //     && typeof(requestPort) != 'undefined'
            //     && /^(80|443)$/.test(requestPort)
            //     && req.headers.host == local.options.conf.host
            //     ||
            //     typeof(req.headers['x-nginx-proxy']) != 'undefined'
            //     && /^true$/i.test(req.headers['x-nginx-proxy'])
            // ) ? true : false;
            // setContext('isProxyHost', isProxyHost);
            var isProxyHost = getContext('isProxyHost') || false;
            set('page.environment.isProxyHost', isProxyHost);
            if ( /^true$/.test(isProxyHost) ) {
                set('page.environment.proxyHost', process.gina.PROXY_HOST);
                set('page.environment.proxyHostname', process.gina.PROXY_HOSTNAME);
            }

            var _config = ctx.config.envConf[options.conf.bundle][process.env.NODE_ENV];
            // by default
            var hostname    = _config.hostname + _config.server.webroot;
            var scheme      = hostname.match(/^(https|http)/)[0];
            var requestPort = (local.req.headers.port||local.req.headers[':port']);

            var hostPort = hostname.match(/(\:d+\/|\:\d+)$/);
            hostPort = (hostPort) ? ~~(hostPort[0].replace(/\:/g, '')) : _config.port[_config.server.protocol][_config.server.scheme];
            // Linking bundle B from bundle A wihtout proxy
            var isSpecialCase = (
                    getContext('bundle') != _config.bundle
                    && requestPort != hostPort
                    && local.req.headers[':host'] != process.gina.PROXY_HOST
            ) ? true : false;

            if (isSpecialCase) {
                hostname = _config.hostname;
            }

            // if (
            //     isProxyHost
            //     && !isSpecialCase
            // ) {
            //     // Rewrite hostname vs req.headers.host
            //     hostname    = scheme + '://'+ (local.req.headers.host||local.req.headers[':host']);

            //     if (
            //         !/^(80|443)$/.test(requestPort)
            //         && !new RegExp(requestPort+'$').test(hostname)
            //     ) {
            //         hostname += ':'+ requestPort;
            //     }
            // }

            set('page.environment.hostname', hostname);
            // Updating _config.rootDomain - 2024/04/15
            // _config.rootDomain = domainLib.getRootDomain(hostname).value;


            set('page.environment.rootDomain', _config.rootDomain);
            set('page.environment.webroot', options.conf.server.webroot);

            if ( typeof(ctx.config.envConf._isRoutingUpdateNeeded) == 'undefined') {
                ctx.config.envConf._isRoutingUpdateNeeded = false;
            }

            if (
                typeof(ctx.config.envConf._proxyHostname) == 'undefined'
                ||
                hostname != ctx.config.envConf._proxyHostname
            ) {
                ctx.config.envConf._proxyHostname = (isProxyHost) ? hostname : null;
                ctx.config.envConf._isRoutingUpdateNeeded = true;
            }

            if ( typeof(ctx.config.envConf._routingCloned) == 'undefined' ) {
                ctx.config.envConf._routingCloned = JSON.clone(ctx.config.envConf.routing);
            }

            var routing = local.options.conf.routing = ctx.config.envConf._routingCloned; // all routes
            if ( /^true$/i.test(ctx.config.envConf._isRoutingUpdateNeeded) ) {

                for (let r in ctx.config.envConf.routing) {
                    if ( isProxyHost ) {
                        local.options.conf.routing[r].host = hostname.replace(/^(https|http)\:\/\//, '');
                        local.options.conf.routing[r].hostname = hostname;
                        let scheme = hostname.match(/^(https|http)/)[0];
                        local.options.conf.routing[r].hostname    = scheme + '://'+ (local.req.headers.host||local.req.headers[':host']);
                        let requestPort = (local.req.headers.port||local.req.headers[':port']);
                        if (
                            !/^(80|443)$/.test(requestPort)
                            && !new RegExp(requestPort+'$').test(local.options.conf.routing[r].hostname)
                        ) {
                            local.options.conf.routing[r].hostname += ':'+ requestPort
                        }
                        continue;
                    }
                    local.options.conf.routing[r].host = ctx.config.envConf.routing[r].host;
                    local.options.conf.routing[r].hostname = ctx.config.envConf.routing[r].hostname;
                }
                ctx.config.envConf._isRoutingUpdateNeeded = false;

            }
            // Adding 289 KB of datas in the page when including routing & reverseRouting
            // set('page.environment.routing', encodeRFC5987ValueChars(JSON.stringify(routing))); // export for GFF
            set('page.environment.routing',encodeRFC5987ValueChars('{}'));

            //// reverseRouting
            var reverseRouting = local.options.conf.reverseRouting = ctx.config.envConf.reverseRouting; // all routes
            // set('page.environment.reverseRouting', encodeRFC5987ValueChars(JSON.stringify(reverseRouting))); // export for GFF
            set('page.environment.reverseRouting',encodeRFC5987ValueChars('{}'));

            var forms = local.options.conf.forms = options.conf.content.forms // all forms
            set('page.environment.forms', encodeRFC5987ValueChars(JSON.stringify(forms))); // export for GFF
            set('page.forms', options.conf.content.forms);



            set('page.environment.bundle', options.conf.bundle);
            set('page.environment.project', options.conf.projectName);
            set('page.environment.protocol', options.conf.server.protocol);
            set('page.environment.scheme', options.conf.server.scheme);
            set('page.environment.port', options.conf.server.port);
            set('page.environment.debugPort', options.conf.server.debugPort);
            set('page.environment.pid', process.pid);


            set('page.view.ext', ext);
            set('page.view.control', action);
            set('page.view.controller', local.options.controller.replace(options.conf.bundlesPath, ''), true);
            if (typeof (local.options.controlRequired) != 'undefined' ) {
                set('page.view.controlRequired', local.options.controlRequired);
            }
            set('page.view.method', local.options.method);
            set('page.view.namespace', namespace); // by default
            set('page.view.url', req.url);
            if ( local.options.template ) {
                set('page.view.layout', local.options.template.layout.replace(new RegExp(local.options.template.templates+'/'), '').split(/\//g).slice(1).join('/'));
                set('page.view.html.properties.mode.javascriptsDeferEnabled', local.options.template.javascriptsDeferEnabled);
                set('page.view.html.properties.mode.routeNameAsFilenameEnabled', local.options.template.routeNameAsFilenameEnabled);
            }


            if ( /^true$/i.test(self.serverInstance._cacheIsEnabled) ) {
                set('page.view.cacheIsEnabled', self.serverInstance._cacheIsEnabled);
                set('page.view.cacheKey', "static:"+ local.req.url);
                // Some routes might not have caching strategy
                if ( typeof(local.req.routing.cache) != 'undefined' && local.req.routing.cache != null ) {
                    var cachingOption = ( typeof(local.req.routing.cache) == 'string' ) ? { type: local.req.routing.cache } : JSON.clone(local.req.routing.cache);
                    if ( typeof(cachingOption.ttl) == 'undefined' ) {
                        cachingOption.ttl = local.options.conf.server.cache.ttl
                    }
                    set('page.view.cacheType', cachingOption.type);
                    set('page.view.cacheTTL', cachingOption.ttl);
                } else {
                    set('page.view.cacheType', 'Not configured for this route');
                }
            }


            var parameters = JSON.clone(req.getParams());
            parameters = merge(parameters, options.conf.content.routing[rule].param);
            // excluding default page properties
            delete parameters[0];
            delete parameters.file;
            delete parameters.control;
            delete parameters.title;

            if (parameters.count() > 0)
                set('page.view.params', parameters); // view parameters passed through URI or route params

            set('page.view.route', rule);


            var acceptLanguage = GINA_CULTURE; // by default : language-COUNTRY
            if ( typeof(req.headers['accept-language']) != 'undefined' ) {
                acceptLanguage = req.headers['accept-language']
            } else if ( typeof(local.options.conf.server.response.header['accept-language']) != 'undefined' ) {
                acceptLanguage = local.options.conf.server.response.header['accept-language']
            }

            // set user locale: region & culture
            var userCulture     = acceptLanguage.split(',')[0];
            var userCultureCode = userCulture.split(/\-/);
            var userLangCode    = userCultureCode[0];
            var userCountryCode = userCultureCode[1];

            var locales         = new Collection( getContext('gina').locales );
            var userLocales     = null;

            try {
                userLocales = locales.findOne({ lang: userLangCode }).content;
            } catch (err) {
                //var defaultRegion = (local.options.conf.content.settings.region) ? local.options.conf.content.settings.region.shortCode
                console.warn('language code `'+ userLangCode +'` not handled by current locales setup: replacing by default: `'+ local.options.conf.content.settings.region.shortCode +'`');
                userLocales = locales.findOne({ lang: local.options.conf.content.settings.region.shortCode }).content // by default
            }

            // user locales list
            local.options.conf.locales = userLocales;

            // user locale
            options.conf.locale = new Collection(userLocales).findOne({ short: userCountryCode }) || {};

            // current date
            if ( typeof(options.conf.locale) == 'undefined' || !options.conf.locale ) {
                options.conf.locale = {}
            }
            options.conf.locale.date = {
                now: new Date().format("isoDateTime")
            }
            set('page.view.locale', options.conf.locale);
            set('page.view.lang', userCulture);
        }


        //TODO - detect when to use swig
        var dir = null;
        if (local.options.template || self.templates) {
            dir = local.options.template.html || self.templates;

            var swigOptions = {
                autoescape  : ( typeof(local.options.autoescape) != 'undefined') ? local.options.autoescape : false,
                // `memory` is no working yet ... advanced rendering setup required
                // cache       : (local.options.isCacheless) ? false : 'memory'
                cache       : false
            };
            if (dir) {
                swigOptions.loader = swig.loaders.fs(dir);
            }
            if ( typeof(local._swigOptions) == 'undefined' ) {
                local._swigOptions = JSON.clone(swigOptions);
            }
            swig.setDefaults(swigOptions);
            // used for self.engine.compile(tpl, swigOptions)(swigData)
            swig.getOptions = function() {
                return local._swigOptions;
            }
            // preserve the same timezone as the system
            var defaultTZOffset = new Date().getTimezoneOffset();
            swig.setDefaultTZOffset(defaultTZOffset);
            defaultTZOffset = null;


            self.engine = swig;

            dir = null;
            swigOptions = null;

        }

        freeMemory([action, rule, ext, isWithoutLayout, namespace, ctx, version, routing, reverseRouting, forms, parameters, acceptLanguage, userCulture, userCultureCode, userLangCode, userCountryCode, locales, userLocales], false);
    }

    var parseDataObject = function(o, obj, override) {

        for (let i in o) {
            if ( o[i] !== null && typeof(o[i]) == 'object' || override && o[i] !== null && typeof(o[i]) == 'object' ) {
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
     * @param {boolean} [override]
     *
     * @returns {void}
     * */
    var set = function(name, value, override) {

        var override = ( typeof(override) != 'undefined' ) ? override : false;

        if ( typeof(name) == 'string' && /\./.test(name) ) {
            var keys        = name.split(/\./g)
                , newObj    = {}
                , str       = '{'
                , _count    = 0;

            for (let k = 0, len = keys.length; k<len; ++k) {
                str +=  "\""+ keys.splice(0,1)[0] + "\":{";

                ++_count;
                if (k == len-1) {
                    str = str.substring(0, str.length-1);
                    str += "\"_content_\"";
                    for (let c = 0; c<_count; ++c) {
                        str += "}"
                    }
                }
            }

            newObj = parseDataObject(JSON.parse(str), value, override);
            local.userData = merge(local.userData, newObj);

            freeMemory([name, value, keys, newObj, str, _count], false);

        } else if ( typeof(local.userData[name]) == 'undefined' ) {
            local.userData[name] = value.replace(/\\/g, '');
            freeMemory([name, value], false)
        }
    }

    /**
     * Get data
     *
     * @param {String} variable Data name to set
     * @returns {Object | String} data Data object or String
     * */
    var get = function(variable) {
        return local.userData[variable]
    }

    /**
     * Set resources
     *
     * @param {object} template - template configuration
     * */
    var setResources = function(viewConf) {
        if (!viewConf) {
            return self.throwError(500, new Error('No views configuration found. Did you try to add views before using Controller::render(...) ? Try to run: gina view:add '+ options.conf.bundle +' @'+ options.conf.projectName));
        }

        var authority = ( typeof(local.req.headers['x-forwarded-proto']) != 'undefined' ) ? local.req.headers['x-forwarded-proto'] : local.options.conf.server.scheme;
        authority += '://'+ local.req.headers.host;
        var useWebroot = false;
        if (
            !/^\/$/.test(local.options.conf.server.webroot)
            && local.options.conf.server.webroot.length > 0
            // && local.options.conf.hostname.replace(/\:\d+$/, '') == authority
        ) {
            useWebroot = true
        }
        authority = null;

        var reURL = new RegExp('^'+ local.options.conf.server.webroot);

        var cssStr      = ''
            , jsStr     = ''
        ;
        //Get css
        if( viewConf.stylesheets ) {
            // cssStr  = getNodeRes('css', viewConf.stylesheets, useWebroot, reURL);
            // Fixed on 2025-03-08: ordered by route, making sure that _common could all be loaded first
            var cssColl = new Collection(viewConf.stylesheets).orderBy({route: 'asc'})
            cssStr   = getNodeRes('css', cssColl, useWebroot, reURL);
            cssColl = null;
        }
        //Get js
        if( viewConf.javascripts ) {
            // jsStr   = getNodeRes('js', viewConf.javascripts, useWebroot, reURL);
            // Fixed on 2025-03-08: ordered by route, making sure that _common could all be loaded first
            var jsColl = new Collection(viewConf.javascripts).orderBy({route: 'asc'})
            jsStr   = getNodeRes('js', jsColl, useWebroot, reURL);
            jsColl = null;
        }

        set('page.view.stylesheets', cssStr);
        set('page.view.scripts', jsStr);

        reURL   = null;
        cssStr  = null;
        jsStr   = null;
    }

    /**
     * Get node resources
     *
     * @param {string} type
     * @param {string} resStr
     * @param {array} resArr
     * @param {boolean} useWebroot
     * @param {object} reURL - RegExp for webroot
     *
     * @returns {object} content
     *
     * @private
     * */
    var getNodeRes = function(type, resArr, useWebroot, reURL) {

        var r               = 0
            , rLen          = resArr.length
            , obj           = null
            , str           = ''
            , isProxyHost   = getContext('isProxyHost')
            , requestHost   = ( /http\/2/.test(local.options.conf.server.protocol) )
                    ? local.req.headers[':host']
                    : local.req.headers.host
            , hostname      = ( typeof(requestHost) != 'undefined' && local.options.conf.host != requestHost)
                    ? local.options.conf.server.scheme +'://'+ requestHost
                    : local.options.conf.hostname
            , scheme = hostname.match(/^(https|http)/)[0]
        ;
        var requestPort = (local.req.headers.port||local.req.headers[':port']);
        var hostPort = local.options.conf.hostname.match(/(\:d+\/|\:\d+)$/);
        hostPort = (hostPort) ? ~~(hostPort[0].replace(/\:/g, '')) : local.options.conf.port[local.options.conf.server.protocol][local.options.conf.server.scheme];
        // Linking bundle B from bundle A wihtout proxy
        var isSpecialCase = (
                getContext('bundle') != local.options.conf.bundle
                && requestPort != hostPort
                && local.req.headers[':host'] != process.gina.PROXY_HOST
        ) ? true : false;

        if (isSpecialCase) {
            hostname = local.options.conf.hostname
        }


        if (
            isProxyHost
            && !isSpecialCase
        ) {

            hostname    = scheme + '://'+ (local.req.headers.host||local.req.headers[':host']||process.gina.PROXY_HOST);

            if (
                !/^(80|443)$/.test(requestPort)
                && !new RegExp(requestPort+'$').test(hostname)
            ) {
                hostname += ':'+ requestPort;
            }
        }

        switch(type){
            case 'css':
                for (; r < rLen; ++r) {
                    obj = resArr[r];
                    if (useWebroot && !reURL.test(obj.url) ) {
                        obj.url = local.options.conf.server.webroot + obj.url.substring(1);
                    }
                    // HTTP2 Push via Link
                    if (
                        /http\/2/.test(local.options.conf.server.protocol)
                        && !self.isCacheless()
                    ) {
                        local.options.template.h2Links += '<'+ obj.url +'>; as=style; rel=preload,'
                    }
                    // TODO - add support for cdn
                    // Remove this part, since it is best to work with relative paths
                    // if (!/\:\/\//.test(obj.url) ) {
                    //     obj.url = hostname + obj.url;
                    // }

                    if (obj.media) {
                        str += '\n\t\t<link href="'+ obj.url +'" media="'+ obj.media +'" rel="'+ obj.rel +'" type="'+ obj.type +'">';
                    } else {
                        str += '\n\t\t<link href="'+ obj.url +'" rel="'+ obj.rel +'" type="'+ obj.type +'">';
                    }
                }
                break;

            case 'js':
                var deferMode = (local.options.template.javascriptsDeferEnabled) ? ' defer' : '';

                for (; r < rLen; ++r) {
                    obj = resArr[r];
                    if (useWebroot && !reURL.test(obj.url) ) {
                        obj.url = local.options.conf.server.webroot + obj.url.substring(1);
                    }
                    // HTTP2 Push via Link
                    if (
                        /http\/2/.test(local.options.conf.server.protocol)
                        && !self.isCacheless()
                    ) {
                        local.options.template.h2Links += '<'+ obj.url +'>; as=script; rel=preload,'
                    }
                    // TODO - add support for cdn
                    // Remove this part, since it is best to work with relative paths
                    // if (!/\:\/\//.test(obj.url) ) {
                    //     obj.url = hostname + obj.url;
                    // }


                    if ( /\/jquery\.(.*)\.(min\.js|js)$/i.test(obj.url) ) {
                        console.warn('jQuery Plugin found in templates.json !\nIf you want to load it before [gina.min.js], you should declare it at the top of your handler using requireJS or add property "isExternalPlugin: true" in your templates.json, under: '+ (obj.route || local.req.routing.rule) +' .');
                    }
                    // Allow jQuery & other external plugins to be loaded in the HEAD section before gina
                    if (
                        obj.isExternalPlugin
                    ) {
                        local.options.template.externalPlugins.splice(1, 0, '\n\t\t<script'+ deferMode +' type="'+ obj.type +'" src="'+ obj.url +'"></script>');
                    }
                    else {
                        // normal case
                        str += '\n\t\t<script'+ deferMode +' type="'+ obj.type +'" src="'+ obj.url +'"></script>';
                    }
                }
                break;
        }
        r       = null;
        rLen    = null;
        obj     = null;


        return str;
    }

    /**
     * TODO -  SuperController.setMeta()
     * */
    // this.setMeta = function(metaName, metacontent) {
    //
    // }



    var isValidURL = function(url){
        // var re = /(http|ftp|https|sftp):\/\/[\w-]+(\.[\w-]+)+([\w.,@?^=%&amp;:\/~+#-]*[\w@?^=%&amp;\/~+#-])?/;
        return (/(http|ftp|https|sftp):\/\/[\w-]+(\.[\w-]+)+([\w.,@?^=%&amp;:\/~+#-]*[\w@?^=%&amp;\/~+#-])?/.test(url)) ? true : false;
    }

    this.renderWithoutLayout = function (data, displayToolbar) {

        // preventing multiple call of self.renderWithoutLayout() when controller is rendering from another required controller
        if (local.options.renderingStack.length > 1) {
            return false;
        }

        local.options.isWithoutLayout = true;

        self.render(data, displayToolbar);
    }


    var getData = function() {
        return refToObj( local.userData )
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
     *  N.B.: Filters can be extended through your `<project>/src/<bundle>/controllers/setup.js`
     *
     *
     * @param {object} userData
     * @param {boolean} [displayToolbar]
     * @param {object} [errOptions]
     * @returns {void}
     * */
    this.render = function (userData, displayToolbar, errOptions) {
        if  (this.isCacheless() ) {
            delete require.cache[require.resolve( _(__dirname + '/controller.render-v1', true))];
            delete require.cache[require.resolve( _(__dirname + '/controller.render-swig', true))];
        }

        return require( _(__dirname + '/controller.render-swig', true) )(userData, displayToolbar, errOptions, {
            self        : self,
            local       : local,
            getData     : getData,
            hasViews    : hasViews,
            setResources: setResources,
            swig        : swig,
            SwigFilters : SwigFilters,
            headersSent : headersSent
        }); //(userData, displayToolbar, errOptions)
    }



    this.isXMLRequest = function() {
        return local.options.isXMLRequest;
    }

    this.isWithCredentials = function() {
        return ( /true/.test(local.options.withCredentials) ) ? true : false;
    }

    this.isPopinContext = function() {
        return (
            typeof(local.req.headers['x-gina-popin-id']) != 'undefined'
            || typeof(local.req.headers['x-gina-popin-name']) != 'undefined'
        ) ? true : false;
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
        if  (this.isCacheless() ) {
            delete require.cache[require.resolve( _(__dirname + '/controller.render-json', true))];
        }

        return require( _(__dirname + '/controller.render-json', true) )(jsonObj, {
            self        : self,
            local       : local,
            headersSent : headersSent,
            freeMemory  : freeMemory
        });
    }



    this.renderTEXT = function(content) {

        // preventing multiple call of self.renderTEXT() when controller is rendering from another required controller
        if (local.options.renderingStack.length > 1) {
            return false
        }
        if ( self.isProcessingError ) {
           return;
        }

        var request     = local.req;
        var response    = local.res;
        var next        = local.next || null;
        // var stream      = null;
        // if ( /http\/2/.test(local.options.conf.server.protocol) ) {
        //     stream = response.stream;
        // }

        // Added on 2023-06-12
        if ( headersSent(response) ) {
            freeMemory([content, request, response, next]);
            return;
        }

        if ( typeof(content) != "string" ) {
            content = content.toString();
        }

        // if (typeof(options) != "undefined" && typeof(options.charset) !="undefined") {
        //     response.setHeader("charset", options.charset);
        // }
        if ( !response.getHeaders()['content-type'] ) {
            response.setHeader('content-type', 'text/plain' + '; charset='+ local.options.conf.encoding);
        }

        if ( !headersSent() ) {
            console.info(request.method +' ['+response.statusCode +'] '+ request.url);
            response.end(content);
            try {
                response.headersSent = true
            } catch(err) {
                // Ignoring warning
                //console.warn(err);
            }

            freeMemory([content, request, response, next]);
        }
    }



    /**
     * Set method - Override current method
     * E.g.: in case of redirect, to force PUT to GET
     *
     * @param {string} requestMethod - GET, POST, PUT, DELETE
     */
    var localRequestMethod = null, localRequestMethodParams = null;
    this.setRequestMethod = function(requestMethod, conf) {
        // http/2 case
        if ( /http\/2/i.test(conf.server.protocolShort) ) {
            local.req.headers[':method'] = local.req.method.toUpperCase()
        }

        localRequestMethod = local.req.method = local.req.routing.method = requestMethod.toUpperCase();

        local.res.setHeader('access-control-allow-methods', localRequestMethod);

        return localRequestMethod;
    }

    this.getRequestMethod = function() {
        return localRequestMethod;
    }

    this.setRequestMethodParams = function(params) {
        localRequestMethodParams = local.req[local.req.method.toLowerCase()] = localRequestMethodParams = params
    }

    this.getRequestMethodParams = function() {
        return (localRequestMethodParams) ? localRequestMethodParams : local.req[local.req.method.toLowerCase()]
    }

    /**
     * isStaticRoute
     * Trying to determine if url is a `statics` ressource
     *
     * @param {string} url
     * @param {string} method
     *
     * @returns {boolean} isStaticRoute
     */
    var isStaticRoute = function(url, method, bundle, env, conf) {

        if ( !/get/i.test(method) ) {
            return false
        }

        // priority to statics - this portion of code has been duplicated to Server.js

        var staticsArr = conf[bundle][env].publicResources;
        var staticProps = {
            firstLevel          : '/' + url.split(/\//g)[1] + '/',
            // to be considered as a stativ content, url must content at least 2 caracters after last `.`: .js, .html are ok
            isStaticFilename    : /(\.([A-Za-z0-9]+){2}|\/)$/.test(url)
        };

        // handle resources from public with webroot in url
        if ( staticProps.isStaticFilename && conf[bundle][env].server.webroot != '/' && staticProps.firstLevel == conf[bundle][env].server.webroot ) {
            var matchedFirstInUrl = url.replace(conf[bundle][env].server.webroot, '').match(/[A-Za-z0-9_-]+\/?/);
            if ( matchedFirstInUrl && matchedFirstInUrl.length > 0 ) {
                staticProps.firstLevel = conf[bundle][env].server.webroot + matchedFirstInUrl[0];
            }
            matchedFirstInUrl = null;
        }

        if (
            staticProps.isStaticFilename && staticsArr.indexOf(url) > -1
            || staticProps.isStaticFilename && staticsArr.indexOf( url.replace(url.substring(url.lastIndexOf('/')+1), '') ) > -1
            || staticProps.isStaticFilename && staticsArr.indexOf(staticProps.firstLevel) > -1
        ) {
            staticProps = null;
            return true
        }
        staticProps = null;

        return false;
    }

    /**
     * redirect
     *
     * TODO - improve redirect based on `lib.routing`
     * e.g.: self.redirect('project-get', { companyId: companyId, clientId: clientId, id: projectId }, true)
     *
     * How to avoid redirect inside popin context
     * N.B.: When you are in a popin context, add an `id` to your template tag so it can be ignored by the default PopinHandler
     *    E.g.: id="delete-link" -> <a href="#" id="delete-link">delete</a>
     *
     * You have two ways of using this method
     *
     * 1) Through routing.json
     * ---------------------
     * Allows you to redirect to an internal [ route ], an internal [ path ], or an external [ url ]
     *
     * For this to work you have to set in your routing.json a new route using  "param":
     * { "control": "redirect", "route": "one-valid-route" }
     * OR
     * { "control": "redirect", "url": "http://www.somedomain.com/page.html" }
     *
     * OR
     * { "control": "redirect", "path": "/", "ignoreWebRoot": true }
     *
     * OR
     * { "control": "redirect", "url": "http://home@public/production", "ignoreWebRoot": true }
     *
     * if you are free to use the redirection [ code ] of your choice, we've set it to 301 by default
     *
     *
     * 2) By calling this.redirect(rule, [ignoreWebRoot]):
     * ------------------------------------------------
     * where `this` is :
     *  - a Controller instance
     *
     * Where `rule` is either a string defining
     *  - the rule/route name
     *      => home (will use same bundle, same protocol scheme & same environment)
     *      => home@public (will use same protocol scheme & same environment)
     *      => http://home@public/dev (port style for more precision)
     *
     *  - an URI
     *      => /home
     *
     *  - a URL
     *      => http://www.google.com/
     *
     *
     * And Where `ignoreWebRoot` is an optional parameter used to ignore web root settings (Standalone mode or user set web root)
     * `ignoreWebRoot` behaves the like set to `false` by default
     *
     * N.B.: Gina will tell browsers not to cache redirections if you are using `dev` environement
     *
     * Trobleshouting:
     * ---------------
     *
     * Redirecting to a popin from the controller while posting from a form
     *      If this does not work, like doing a real redirect, this
     *      only means that the ID you are using for the form might be
     *      a duplicate one from the the main document !!!
     *
     * @param {object|string} req|rule|url - Request Object or Rule/Route name
     * @param {object|boolean} res|ignoreWebRoot - Response Object or Ignore WebRoot & start from domain root: /
     * @param {object} [params] TODO
     *
     * @callback [ next ]
     * */
    this.redirect = function(req, res, next) {
        var conf    = self.getConfig();
        var bundle  = conf.bundle;
        var env     = conf.env;
        var wroot   = conf.server.webroot;
        var ctx     = getContext('gina');
        var routing = ctx.config.getRouting();//conf.content.routing;
        var route   = '', rte = '';
        var ignoreWebRoot = null, isRelative = false;
        var originalUrl = null;
        var method = null;
        var originalMethod = null;

        if ( typeof(req) === 'string' ) {

            // if ( typeof(res) == 'undefined') {
            //     // nothing to do
            //     ignoreWebRoot = false
            // } else
            if (typeof(res) === 'string' || typeof(res) === 'number' || typeof(res) === 'boolean') {
                if ( /^(true|1)$/i.test(res) ) {
                    ignoreWebRoot = true
                } else if ( /^(false|0)$/i.test(res) ) {
                    ignoreWebRoot = false
                } else {
                    res = local.res;
                    var stack = __stack.splice(1).toString().split(',').join('\n');
                    self.throwError(res, 500, new Error('RedirectError: @param `ignoreWebRoot` must be a boolean\n' + stack));
                    return;
                }
            } else {
                // detect by default
                if (!ignoreWebRoot) {
                    var re = new RegExp('^'+wroot)
                    if ( re.test(req) ) {
                        ignoreWebRoot = true;
                    } else {
                        ignoreWebRoot = false;
                    }
                }

            }

            if ( req.substring(0,1) === '/') { // is relative (not checking if the URI is defined in the routing.json)
                // if (wroot.substring(wroot.length-1,1) == '/') {
                //     wroot = wroot.substring(wroot.length-1,1).replace('/', '')
                // }

                if ( /^\//.test(req) && !ignoreWebRoot )
                    req = req.substring(1);

                rte             = ( ignoreWebRoot != null && ignoreWebRoot  ) ? req : wroot + req;
                // cleaning url in case of ?param=value
                originalUrl     = rte;
                rte             = rte.replace(/\?(.*)/, '');

                req             = local.req;
                originalMethod = ( typeof(req.originalMethod) != 'undefined') ? req.originalMethod :  req.method;
                console.debug('[ BUNDLE ][ '+ local.options.conf.bundle +' ][ Controller ] trying to get route: ', rte, bundle, req.method);
                if ( !ignoreWebRoot || !isStaticRoute(rte, req.method, bundle, env, ctx.config.envConf) && !ignoreWebRoot ) {
                    req.routing     = lib.routing.getRouteByUrl(rte, bundle, req.method, req);
                    // try alternative method
                    if (!req.routing) {
                        req.routing     = lib.routing.getRouteByUrl(rte, bundle, 'GET', req, true); // true == override
                        // if still (!req.routing) { should throw a 404 }
                        if (req.routing) {
                            method = req.method = 'GET'
                        }
                    }

                    //route = route = req.routing.name;
                } else {
                    req.routing = {
                        param : {
                            url: rte
                        }
                    }
                }

                res             = local.res;
                next            = local.next;
                isRelative      = true;

                req.routing.param.path = rte
            } else if ( isValidURL(req) ) { // might be an URL
                rte             = req;
                originalUrl     = rte;
                rte             = rte.replace(/\?(.*)/, '');

                req     = local.req;
                res     = local.res;
                next    = local.next;

                req.routing.param.url = rte
            } else { // is by default a route name

                if ( /\@/.test(req) ) {
                    var rteArr = req.split(/\//);
                    if ( typeof(rteArr[1]) != 'undefined' )
                        env = rteArr[1];

                    rte = route = rteArr[0];
                    rteArr = rteArr[0].split(/\@/);

                    bundle = rteArr[1];

                } else {
                    rte = route = ( new RegExp('^/'+conf.bundle+'-$').test(req) ) ? req : wroot.match(/[^/]/g).join('') +'-'+ req;
                }


                req     = local.req;
                res     = local.res;
                next    = local.next;

                req.routing.param.route = routing[rte]
            }

        } else {
            route = req.routing.param.route;
        }

        if ( !originalMethod ) {
            originalMethod = ( typeof(req.originalMethod) != 'undefined') ? req.originalMethod :  req.method;
        }

        var path        = originalUrl || req.routing.param.path || '';
        var url         = req.routing.param.url;
        var code        = req.routing.param.code || 301;

        var keepParams  = req.routing.param['keep-params'] || false;

        var condition   = true; //set by default for url @ path redirect

        if (route) { // will go with route first
            condition = ( typeof(routing[route]) != 'undefined') ? true : false;
        }

        if ( !self.forward404Unless(condition, req, res) ) { // forward to 404 if bad route

            var localRequestPort = local.req.headers.port || local.req.headers[':port'];
            var isProxyHost = (
                typeof(local.req.headers.host) != 'undefined'
                && typeof(localRequestPort) != 'undefined'
                &&  /^(80|443)$/.test(localRequestPort)
                && local.options.conf.server.scheme +'://'+ local.req.headers.host +':'+ localRequestPort != local.options.conf.hostname.replace(/\:\d+$/, '') +':'+ local.options.conf.server.port
                ||
                typeof(local.req.headers[':authority']) != 'undefined'
                && local.options.conf.server.scheme +'://'+ local.req.headers[':authority'] != local.options.conf.hostname
                ||
                typeof(local.req.headers.host) != 'undefined'
                && typeof(localRequestPort) != 'undefined'
                && /^(80|443)$/.test(localRequestPort)
                && req.headers.host == local.options.conf.host
                ||
                typeof(local.req.headers['x-nginx-proxy']) != 'undefined'
                && /^true$/i.test(local.req.headers['x-nginx-proxy'])
                ||
                typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
            ) ? true : false;

            // var isProxyHost = getContext('isProxyHost');
            var hostname = (isProxyHost)
                    ? process.gina.PROXY_HOSTNAME
                    : ctx.config.envConf[bundle][env].hostname;


            if (route) { // will go with route first

                if ( /\,/.test(routing[route].url) ) {
                    var paths = routing[route].url.split(/\,/g);
                    path = (ignoreWebRoot) ? paths[0].replace(wroot, '') : paths[0];
                } else {
                    path = (ignoreWebRoot) ? routing[route].url.replace(wroot, '') : routing[route].url;
                }

                if (bundle != conf.bundle) {
                    path = hostname + path;
                }
            } else if (url && !path) {
                path = ( (/\:\/\//).test(url) ) ? url : req.scheme + '://' + url;

                if (/\@/.test(path)) {
                    path = lib.routing.getRoute(path).toUrl(ignoreWebRoot);
                }

            //} else if(path && typeof(isRelative) !=  'undefined') {
            // nothing to do, just ignoring
            //} else {
            } else if ( !path && typeof(isRelative) ==  'undefined' ) {

                path = hostname + path
                //path = local.req.headers.host + path
            }

            var isPopinContext = false;
            if (
                typeof(req.routing.param.isPopinContext) != 'undefined'
                && /^true$/i.test(req.routing.param.isPopinContext)
                && self.isXMLRequest()
                ||
                self.isPopinContext()
                && self.isXMLRequest()
            ) {
                isPopinContext = true;
            }

            if (!headersSent()) {

                // backing up oldParams
                var oldParams = local.req[originalMethod.toLowerCase()];
                var requestParams = req[req.method.toLowerCase()] || {};
                if ( typeof(requestParams) != 'undefined' && typeof(requestParams.error) != 'undefined' ) {
                    var redirectError = requestParams.error;
                    self.throwError(requestParams.error);
                    return;
                }

                if (
                    !/GET/i.test(req.method)
                    ||
                    originalMethod && !/GET/i.test(originalMethod)
                ) { // trying to redirect using the wrong method ?

                    console.warn(new Error('Your are trying to redirect using the wrong method: `'+ req.method+'`.\nThis can often occur while redirecting from a controller to another controller or from a bundle to another.\nA redirection is not permitted in this scenario.\nDon\'t panic :)\nSwitching request method to `GET` method instead.\n').message);
                    method = local.req.method = self.setRequestMethod('GET', conf);
                    code = 303;
                }

                var inheritedDataIsNeeded = ( req.method.toLowerCase() == originalMethod.toLowerCase() ) ? false: true;

                // merging new & olds params
                requestParams = merge(requestParams, oldParams);
                // remove session to prevent reaching the 2000 chars limit
                // if you need the session, you need to find another way to retrieve while in the next route
                if ( typeof(requestParams.session) != 'undefined' ) {
                    delete requestParams.session;
                }
                if ( typeof(requestParams) != 'undefined' && requestParams.count() > 0 ) {
                    //if ( typeof(requestParams.error) != 'undefined' )

                    var inheritedData = null;
                    if ( /\?/.test(path) ) {
                        inheritedData = '&inheritedData='+ encodeRFC5987ValueChars(JSON.stringify(requestParams));
                    } else {
                        inheritedData = '?inheritedData='+ encodeRFC5987ValueChars(JSON.stringify(requestParams));
                    }

                    if ( inheritedData.length > 2000 ) {
                        var error = new ApiError('Controller::redirect(...) exceptions: `inheritedData` reached 2000 chars limit', 424);
                        self.throwError(error);
                        return;
                    }

                    // if redirecting from a xhrRequest
                    if ( self.isXMLRequest() ) {
                        // `requestParams` should be stored in the session to avoid passing datas in clear
                        var redirectObj = { isXhrRedirect: true };
                        if (isPopinContext) {
                            redirectObj.popin = {
                                url: path
                            }
                        } else {
                            redirectObj.location = path;
                        }
                        if (requestParams.count() > 0)  {
                            var userSession = req.session.user || req.session;
                            if ( userSession && local.haltedRequestUrlResumed ) {
                                // will be reused for server.js on `case : 'GET'`
                                userSession.inheritedData = requestParams;
                            } else { // will be passed in clear
                                if (isPopinContext) {
                                    redirectObj.popin.url += inheritedData
                                } else {
                                    redirectObj.location += inheritedData;
                                }
                            }
                        }

                        self.renderJSON(redirectObj);
                        return;
                    }

                    if (inheritedDataIsNeeded) {
                        path += inheritedData;
                    }
                }
                // Popin redirect
                if ( isPopinContext ) {
                    return self.renderJSON({
                        isXhrRedirect: true,
                        popin: {
                            url: path
                        }
                    })
                }

                var ext = 'html';
                res.setHeader('content-type', local.options.conf.server.coreConfiguration.mime[ext]);

                var resHeaderACAM = res.getHeader('access-control-allow-methods');
                if (
                    // typeof(local.res._headers) != 'undefined'
                    // && typeof(local.res._headers['access-control-allow-methods']) != 'undefined'
                    // && local.res._headers['access-control-allow-methods'] != req.method
                    typeof(resHeaderACAM) != 'undefined'
                    && resHeaderACAM != req.method
                    ||
                    !new RegExp(req.method, 'i').test( res.getHeader('access-control-allow-methods') )
                ) {
                    res.setHeader('access-control-allow-methods', req.method.toUpperCase() );
                }
                //path += '?query='+ JSON.stringify(self.getRequestMethodParams());
                local.req[req.method.toLowerCase()] = self.getRequestMethodParams() || {};

                var headInfos = {
                    'location': path
                };

                if (self.isCacheless()) {
                    res.writeHead(code, merge(headInfos, {
                        'cache-control': 'no-cache, no-store, must-revalidate', // preventing browsers from using cache
                        'pragma': 'no-cache',
                        'expires': '0'
                    }))
                } else {
                    res.writeHead(code, headInfos)
                }
                // in case of query from another bundle waiting for a response
                var redirectObject = JSON.stringify({ status: code, headers: headInfos });

                try {
                    res.end(redirectObject);
                    local.res.headersSent = true;// done for the render() method
                } catch(err){
                    // ignoring the warning
                    // console.warn(err.stack);
                }

                console.info(local.req.method.toUpperCase() +' ['+code+'] '+ path);

                if ( typeof(next) != 'undefined' )
                    next();
                else
                    return;
            }

        }
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

    this.getBundleStatus = function(req, res, next) {
        var conf = self.getConfig();
        self.renderJSON({
            status: 200,
            isAlive: true,
            message: 'I am alive !',
            // bundle: conf.bundle,
            // project: conf.projectName
        });
    }

    this.checkBundleStatus = async function(bundle, cb) {
        var opt     = self.getConfig('app').proxy[bundle];
        var route   = lib.routing.getRoute('bundle-status@'+bundle);
        opt.method  = 'GET';
        opt.path    = route.url;
        var response = { isAlive: false }, error = false;
        await util.promisify(self.query)(opt, {})
            .then( function onQueryResponse(_status) {
                response = _status
            });

        if (cb) {
            cb(error, response);
        } else {
            return response;
        }
    }

    /**
     * downloadFromURL
     * Download from an URL
     *  - attachment/inline
     *  OR
     *  - locally: `Controller.store(target, cb)` must be called to store on `onComplete` event
     *
     *      - Will trigger on frontend : Failed to load resource: Frame load interrupted
     *        because there is no `res.end()`: whitch is normal, we want to stay on the referrer page
     *
     *      - To avoid this, add to your download link the attribute `data-gina-link`
     *        This will convert the regular HTTP Request to an XML Request
     *
     * @param {string} url - eg.: https://upload.wikimedia.org/wikipedia/fr/2/2f/Firefox_Old_Logo.png
     * @param {object} [options]
     *
     * */
    this.downloadFromURL = async function(url, options, cb) {

        var defaultOptions = {
            // file name i  you want to rename the file
            file: null,
            fileSize: null,
            // only if you want to store locally the downloaded file
            toLocalDir: false, // this option will disable attachment download
            // content-disposition (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Disposition)
            contentDisposition: 'attachment',
            // content-type (https://developer.mozilla.org/en-US/docs/Web/Security/Securing_your_site/Configuring_server_MIME_types)
            contentType: 'application/octet-stream',

            agent: false,
            // set to false to ignore certificate verification
            rejectUnauthorized: true,
            //responseType: 'blob',
            port: 80,
            method: 'GET',
            keepAlive: true,
            headers: {}
        };

        var opt = ( typeof(options) != 'undefined' ) ? merge(options, defaultOptions) : defaultOptions;

        var requestOptions = {};
        for (var o in opt) {
            if ( !/(toLocalDir|contentDisposition|contentType|file)/.test(o) )
                requestOptions[o] = opt[o];
        }

        // defining protocol & scheme
        var protocol    = null;
        var scheme      = null;

        if ( /\:\/\//.test(url) ) {
            scheme = url.match(/^\w+\:/)[0];
            scheme = scheme.substring(0, scheme.length-1);

            if ( !/^http/.test(scheme) ) {
                self.throwError(local.res, 500, new Error('[ '+ scheme +' ] Scheme not supported. Ref.: `http` or `https` only'));
                return;
            }

        } else { // by default
            scheme = 'http';
        }

        requestOptions.scheme = scheme +':';

        //defining port
        // console.debug('[ CONTROLLER ][ HTTP/2.0#downloadFromURL ] defining port from: ', url);
        var port = url.match(/\:\d+\//) || null;
        if ( port != null ) {
            port = port[0].match(/\d+/)[0];
            requestOptions.port = ~~port;
        }

        // defining hostname & path
        var parts = url.replace(new RegExp( scheme + '\:\/\/'), '').split(/\//g);
        requestOptions.host = parts[0].replace(/\:\d+/, '');
        requestOptions.path = '/' + parts.splice(1).join('/');

        // check for protocol upgrade
        // Compare with current proxy list if available
        var appConf = self.getConfig('app');
        if ( typeof(appConf.proxy) != 'undefined' ) {
            var ctx = getContext();
            for ( let service in appConf.proxy) {
                let bundleObj = appConf.proxy[service];

                if ( /\@/.test(bundleObj.hostname) ) {

                    let bundle  = ( bundleObj.hostname.replace(/(.*)\:\/\//, '') ).split(/\@/)[0];
                    // No shorcut possible because conf.hostname might differ from user inputs
                    bundleObj.host        = ctx.gina.config.envConf[bundle][ctx.env].host.replace(/(.*)\:\/\//, '').replace(/\:\d+/, '');
                    bundleObj.hostname    = ctx.gina.config.envConf[bundle][ctx.env].hostname;
                    bundleObj.port        = ~~ctx.gina.config.envConf[bundle][ctx.env].server.port;

                    if (
                        requestOptions.host == bundleObj.host
                        && requestOptions.port != bundleObj.port
                    ) {
                        // Override
                        console.info("Overriding port to fit protocol upgrade: "+ requestOptions.port +" -> "+ bundleObj.port);
                        requestOptions.host = bundleObj.port
                        break;
                    }
                }
            }
        }


        // extension and mime
        var filename    = url.split(/\//g).pop();
        if (!filename) {
            self.throwError(local.res, 500, new Error('Filename not found in url: `'+ url +'`'));
            return;
        }


        if ( !/\.\w+$/.test(filename) ) {
            self.throwError(local.res, 500, new Error('[ '+ filename +' ] extension not found.'));
            return;
        }


        // filename renaming
        if (opt.file)
            filename = opt.file;

        if ( opt.contentDisposition == 'attachment') {
            opt.contentDisposition += '; filename=' + filename;
        }

        var ext             = filename.match(/\.\w+$/)[0].substring(1)
            , contentType   = null
            , tmp           = _(GINA_TMPDIR +'/'+ filename, true)
        ;

        if ( typeof(local.options.conf.server.coreConfiguration.mime[ext]) != 'undefined' ) {

            contentType = (opt.contentType != defaultOptions.contentType) ? opt.contentType : local.options.conf.server.coreConfiguration.mime[ext];

        } else { // extension not supported
            self.throwError(local.res, 500, new Error('[ '+ ext +' ] Extension not supported. Ref.: gina/core mime.types'));
            return;
        }

        // defining responseType
        requestOptions.headers['content-type'] = contentType;
        requestOptions.headers['content-disposition'] = opt.contentDisposition;

        if (
            typeof(local.req.headers['x-client-ip']) != 'undefined'
            && local.req.headers['x-client-ip'] != requestOptions.headers['x-client-ip']
        ) {
            requestOptions.headers['x-client-ip'] = local.req.headers['x-client-ip']
        }
        // [HTTP1] For your Nginx Ingress service host, you should add :
        // # BO - Specific headers for Gina
		// proxy_set_header X-Client-IP $remote_addr;
		// proxy_set_header X-Ingress-IP $server_addr
		// proxy_set_header X-Forwarded-For $remote_addr;
		// # EO - Specific headers for Gina
        if (
            typeof(local.req.headers['x-ingress-ip']) != 'undefined'
            && local.req.headers['x-ingress-ip'] != requestOptions.headers['x-ingress-ip']
        ) {
            requestOptions.headers['x-ingress-ip'] = local.req.headers['x-ingress-ip']
        }

        if (
            typeof(local.req.headers['x-forwarded-for']) != 'undefined'
            && local.req.headers['x-forwarded-for'] != requestOptions.headers['x-forwarded-for']
        ) {
            requestOptions.headers['x-forwarded-for'] = local.req.headers['x-forwarded-for']
        }

        var browser = require(''+ scheme);

        try {
             const response = await new Promise((resolve, reject) => {
                const req = browser.get(requestOptions, (res) => {
                    // Vérification du status HTTP (optionnel mais conseillé)
                    if (res.statusCode >= 400) {
                        res.destroy(); // release the undrained IncomingMessage — nobody will consume it
                        return reject(new Error(`Server responded with ${res.statusCode}`));
                    }
                    resolve(res);
                });

                // Capture l'erreur de connexion (ECONNREFUSED, etc.)
                req.on('error', reject);
            });

            // We need this before piping so we can send back to the requester the final response
            local.res.setHeader('content-type', contentType + '; charset='+ local.options.conf.encoding);
            local.res.setHeader('content-disposition', opt.contentDisposition);
            if (opt.fileSize) {
                local.res.setHeader('content-length', opt.fileSize);
            }

            await pipeline(response, local.res);
            if ( typeof(cb) != 'undefined' ) {
                cb(false)
            }
        } catch (err) {
            if (err.code === 'ECONNREFUSED') {
                let helpMessage = '\nSwitching [SCOPE] for testing? \nCheck if your document url matches the current scope & env\nbefore calling Controller::downloadFromURL(url, opt)\n=> ' + url;
                helpMessage += '\n\nHere is a suggested fix to add in your logic: \n';
                helpMessage += `
// Override for local scope when switching env
if ( /^local$/i.test(process.env.NODE_SCOPE) ) {
    var ctx = getContext();
    var envHostname = ctx.gina.config.envConf['coreapi'][ctx.env].hostname;
    var re = new RegExp('^'+ envHostname);
    if (!re.test(file.url) ) {
        var urlHostname = file.url.match(/^[a-z]+:\/\/[^/:]+(?::\d+)?/)[0];
        file.url = file.url.replace(new RegExp('^' + urlHostname), envHostname);
    }
}`;
                err.message = (err.message || "") + helpMessage;
                err.error = err.message;
            }

            if ( typeof(cb) != 'undefined' ) {
                return cb(err)
            }
            self.throwError(local.res, 500, err);
        }

    } // EO this.downloadFromURL()


    /**
     * Download to targeted filename.ext - Will create target if new
     * Use `cb` callback or `onComplete` event
     *
     *      - Will trigger on frontend : Failed to load resource: Frame load interrupted
     *        because there is no `res.end()`: whitch is normal, we want to stay on the referrer page
     *
     *      - To avoid this, add to your download link the attribute `data-gina-link`
     *        This will convert the regular HTTP Request to an XML Request
     *
     * @param {string} filename
     * @param {object} options
     **/
    this.downloadFromLocal = function(filename) {

        var file            = filename.split(/\//g).pop();
        var ext             = file.split(/\./g).pop()
            , contentType   = null
        ;

        if ( typeof(local.options.conf.server.coreConfiguration.mime[ext]) != 'undefined' ) {

            contentType = local.options.conf.server.coreConfiguration.mime[ext];
            local.res.setHeader('content-type', contentType);
            local.res.setHeader('content-disposition', 'attachment; filename=' + file);

            var filestream = fs.createReadStream(filename);
            filestream.pipe(local.res);

        } else { // extension not supported
            self.throwError(local.res, 500, new Error('[ '+ ext +' ] Extension not supported. Ref.: gina/core mime.types'));
            return;
        }
    }


    /**
     * Store file(s) to a targeted directory - Will create target if new
     * You only need to provide the destination path
     * Use `cb` callback or `onComplete` event
     *
     * @param {string} target is the upload dir destination
     * @param {array} [files]
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
    this.store = async function(target, files, cb) {


        var start = function(target, files, cb) {

            if (arguments.length == 2 && typeof(arguments[1]) == 'function' ) {
                var cb = arguments[1];
            }

            if ( typeof(files) == 'undefined' || typeof(files) == 'function' ) {
                files = local.req.files
            }

            var uploadedFiles = [];

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
                    , folder    = uploadDir.mkdirSync();

                if (folder instanceof Error) {
                    if (cb) {
                        cb(folder)
                    } else {
                        self.emit('uploaded', folder)
                    }
                } else {
                    // files list
                    var fileName = null;
                    for (var len = files.length; i < len; ++i ){

                        fileName = files[i].filename || files[i].originalFilename

                        list[i] = {
                            source: files[i].path,
                            target: _(uploadDir.toString() + '/' + fileName)
                        };

                        uploadedFiles[i] = {
                            file        : fileName,
                            filename    : list[i].target,
                            size        : files[i].size,
                            type        : files[i].type,
                            encoding    : files[i].encoding
                        };

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
                    start(target, files)
                }
            }
        } else {
            start(target, files, cb)
        }
    }


    /**
     * Query
     *
     * Allows you to act as a proxy between your frontend and a 1/3 API
     * */
    function sha256(s) {
        return crypto.createHash('sha256').update(s).digest('base64');
    }
    local.query.data = {};
    local.query.options = {
        // Must be an IP
        host                : undefined,
        // cname of the host e.g.: `www.google.com` or `localhost`
        hostname            : undefined,
        // e.g.: /test.html
        path                : undefined,
        // #80 by default but can be 3000 or <bundle>@<project>/<environment>
        port                : 80,
        // POST|GET|PUT|DELETE|HEAD
        method              : 'GET',
        // {} use `"username:password"` for basic authentification
        auth                : undefined,
        keepAlive           : true,
        // Simultanous active conns
        maxSockets          : 100,
        keepAliveMsecs      : 1000,
        // Only keep 10 open conn while idle
        maxFreeSockets      : 10,
        // Set to false to ignore certificate verification when requesting on https (443)
        // Same as process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
        rejectUnauthorized  : true,
        headers             : {
            'content-type': 'application/json',
            'content-length': local.query.data.length
        },
        // Will try x3 (0, 1, 2)
        maxRetry            : 2,
        // Socket inactivity timeout in milliseconds
        timeout             : 10000,
        agent               : false/**,
        checkServerIdentity: function(host, cert) {
            // Make sure the certificate is issued to the host we are connected to
            const err = tls.checkServerIdentity(host, cert);
            if (err) {
                return err;
            }

            // Pin the public key, similar to HPKP pin-sha25 pinning
            const pubkey256 = 'pL1+qb9HTMRZJmuC/bB/ZI9d302BYrrqiVuRyW+DGrU=';
            if (sha256(cert.pubkey) !== pubkey256) {
                const msg = 'Certificate verification error: ' +
                    `The public key of '${cert.subject.CN}' ` +
                    'does not match our pinned fingerprint';
                return new Error(msg);
            }

            // Pin the exact certificate, rather then the pub key
            const cert256 = '25:FE:39:32:D9:63:8C:8A:FC:A1:9A:29:87:' +
                'D8:3E:4C:1D:98:DB:71:E4:1A:48:03:98:EA:22:6A:BD:8B:93:16';
            if (cert.fingerprint256 !== cert256) {
                const msg = 'Certificate verification error: ' +
                    `The certificate of '${cert.subject.CN}' ` +
                    'does not match our pinned fingerprint';
                return new Error(msg);
            }

            // This loop is informational only.
            // Print the certificate and public key fingerprints of all certs in the
            // chain. Its common to pin the public key of the issuer on the public
            // internet, while pinning the public key of the service in sensitive
            // environments.
            do {
                console.debug('Subject Common Name:', cert.subject.CN);
                console.debug('  Certificate SHA256 fingerprint:', cert.fingerprint256);

                hash = crypto.createHash('sha256');
                console.debug('  Public key ping-sha256:', sha256(cert.pubkey));

                lastprint256 = cert.fingerprint256;
                cert = cert.issuerCertificate;
            } while (cert.fingerprint256 !== lastprint256);

        }*/

    };

    this.query = function() { // options, data, callback
        var err = null;
        var options = arguments[0];
        var data = arguments[1] || {};
        var callback = null;
        if ( typeof(arguments[arguments.length-1]) == 'function' ) {
            callback = arguments[arguments.length-1];
        }  else {
            data = arguments[arguments.length-1]
        }
        // preventing multiple call of self.query() when controller is rendering from another required controller
        if (
            typeof(local.options) != 'undefined'
            && typeof(local.options.renderingStack) != 'undefined'
            && local.options.renderingStack.length > 1
        ) {
            return false
        }
        // by default
        self.isProcessingError = false;

        var queryData           = {}
            , defaultOptions    = local.query.options
            , path              = options.path
            , browser           = null
        ;

        // options must be used as a copy in case of multiple calls of self.query(options, ...)
        options = merge(JSON.clone(options), defaultOptions);
        //cleaning
        for (let o in options) {
            if ( typeof(options[o]) == 'undefined' || options[o] == undefined) {
                delete options[o]
            }
        }


        if (self.isCacheless() || self.isLocalScope() ) {
            options.rejectUnauthorized = false;
        }

        if ( !options.host && !options.hostname ) {
            err = new Error('SuperController::query() needs at least a `host IP` or a `hostname`');
            if (callback) {
                return callback(err)
            }
            self.emit('query#complete', err)
        }


        if ( typeof(data) != 'undefined' &&  data.count() > 0) {

            queryData = '?';
            // TODO - if 'application/json' && method == (put|post)
            if ( ['put', 'post'].indexOf(options.method.toLowerCase()) >-1 && /(text\/plain|application\/json|application\/x\-www\-form)/i.test(options.headers['content-type']) ) {
                // replacing
                queryData = encodeRFC5987ValueChars(JSON.stringify(data))
            } else {
                //Sample request.
                //options.path = '/updater/start?release={"version":"0.0.5-dev","url":"http://10.1.0.1:8080/project/bundle/repository/archive?ref=0.0.5-dev","date":1383669077141}&pid=46493';
                // do not alter the orignal data
                var tmpData = JSON.clone(data);
                for (let d in tmpData) {
                    if ( typeof(tmpData[d]) == 'object') {
                        tmpData[d] = JSON.stringify(tmpData[d]);
                    }
                    queryData += d + '=' + encodeRFC5987ValueChars(tmpData[d]) + '&';
                }

                queryData = queryData.substring(0, queryData.length-1);
                queryData = queryData.replace(/\s/g, '%20');

                options.path += queryData;
            }

        } else {
            queryData = ''
        }


        // Internet Explorer override
        if ( local.req != null && /msie/i.test(local.req.headers['user-agent']) ) {
            options.headers['content-type'] = 'text/plain';
        } else {
            options.headers['content-type'] = local.options.conf.server.coreConfiguration.mime['json'];
        }

        // if ( typeof(local.req.headers.cookie) == 'undefined' && typeof(local.res._headers['set-cookie']) != 'undefined' ) { // useful for CORS : forward cookies from the original request
        //     //options.headers.cookie = local.req.headers.cookie;
        //     var originalResponseCookies = local.res._headers['set-cookie'];
        //     options.headers.cookie = [];
        //     for (var c = 0, cLen = originalResponseCookies.length; c < cLen; ++c) {
        //         options.headers.cookie.push(originalResponseCookies[c])
        //     }
        // }

        // adding gina headers
        if ( local.req != null && typeof(local.req.ginaHeaders) != 'undefined' ) {
            // gina form headers
            for (let h in local.req.ginaHeaders.form) {
                let k = h.substring(0,1).toUpperCase() + h.substring(1);
                options.headers['X-Gina-Form-' +  k ] = local.req.ginaHeaders.form[h];
            }
        }

        var ctx             = getContext()
            , protocol      = null
            , scheme        = null
            , isProxyHost   = getContext('isProxyHost')
            , bundle        = null
            , webroot       = options.webroot || ctx.gina.config.envConf[ctx.bundle][ctx.env].server.webroot;// bundle servers's webroot by default
        ;
        // cleanup options.path
        if (/\:\/\//.test(options.path)) {

            var hArr    = options.path.split(/^(https|http)\:\/\//);
            var domain  = hArr[1] +'://';
            var host    = hArr[2].split(/\//)[0];
            var port    = parseInt(host.split(/\:/)[1] || 80);

            options.port = port;
            options.host = domain + host.replace(':'+port, '');
            options.path = options.path
                                .replace(options.host, '')
                                .replace(':'+port, '');
        }

        // if ( typeof(options.protocol) == 'undefined' ) {
        //     options.protocol = ctx.gina.config.envConf[ctx.bundle][ctx.env].server.protocol;
        // }

        // retrieve protocol & scheme: if empty, take the bundles protocol
        protocol    = options.protocol || ctx.gina.config.envConf[ctx.bundle][ctx.env].server.protocol;// bundle servers's protocol by default
        protocol    = protocol.match(/[.a-z 0-9]+/ig)[0];
        scheme      = options.scheme || ctx.gina.config.envConf[ctx.bundle][ctx.env].server.scheme;// bundle servers's scheme by default
        scheme      = scheme.match(/[a-z 0-9]+/ig)[0];

        // retrieve credentials
        if ( typeof(options.ca) == 'undefined' || ! options.ca ) {
            options.ca  = ctx.gina.config.envConf[ctx.bundle][ctx.env].server.credentials.ca;
        }

        //retrieving dynamic host, hostname & port
        if ( /\@/.test(options.hostname) ) {

            bundle              = ( options.hostname.replace(/(.*)\:\/\//, '') ).split(/\@/)[0];
            // No shorcut possible because conf.hostname might differ from user inputs
            options.host        = ctx.gina.config.envConf[bundle][ctx.env].host.replace(/(.*)\:\/\//, '').replace(/\:\d+/, '');
            options.hostname    = ctx.gina.config.envConf[bundle][ctx.env].hostname;
            options.port        = ctx.gina.config.envConf[bundle][ctx.env].server.port;
            options.protocol    = options.protocol ||  ctx.gina.config.envConf[bundle][ctx.env].server.protocol;
            options.scheme      = ctx.gina.config.envConf[bundle][ctx.env].server.scheme;

            // retrieve credentials
            if ( typeof(options.ca) == 'undefined' || ! options.ca ) {
                options.ca = ctx.gina.config.envConf[bundle][ctx.env].server.credentials.ca;
            }
        }

        if ( typeof(options.protocol) == 'undefined' ) {
            options.protocol = protocol
        }
        if ( typeof(options.scheme) == 'undefined' ) {
            options.scheme = scheme
        }

        // reformating scheme
        if( !/\:$/.test(options.scheme) ) {
            options.scheme += ':';
        }

        if (isProxyHost) {
            // X-Forwarded-Host
            options.headers['x-forwarded-host'] = process.gina.PROXY_HOST;
            // X-Forwarded-Proto
            options.headers['x-forwarded-proto'] = process.gina.PROXY_SCHEME;
        }

        if ( ctx.gina.config.envConf[ctx.bundle][ctx.env].server.resolvers.length > 0 ) {
            var resolversColl = new Collection(ctx.gina.config.envConf[ctx.bundle][ctx.env].server.resolvers);
            options.nameservers = resolversColl.findOne({ scope: process.env.NODE_SCOPE}).nameservers;
            resolversColl = null;
        }

        try {
            options.queryData = queryData;

            bundle = null;

            // TODO - Add preferred communication method option: cCurl or HTTP
            // return handleCurlRequest(options, callback);

            var protocolVersion = ~~options.protocol.match(/\/(.*)$/)[1].replace(/\.\d+/, '');
            var httpLib =  options.protocol.match(/^(.*)\//)[1] + ( (protocolVersion >= 2) ? protocolVersion : '' );
            if ( !/http2/.test(httpLib) && /https/.test(options.scheme) ) {
                httpLib += 's';
            }
            browser = require(''+ httpLib);
            if ( /http2/.test(httpLib) ) {
                return handleHTTP2ClientRequest(browser, options, callback);
            } else {
                return handleHTTP1ClientRequest(browser, options, callback);
            }

        } catch(err) {
            if (callback) {
                return callback(err)
            }
            self.emit('query#complete', err)
        }
    }

    // var handleCurlRequest = async function(opt, callback) {

    //     var body = null;
    //     // https://docs.couchbase.com/server/current/n1ql-rest-query/index.html#Request
    //     var cmd = [
    //         '$(which curl)'
    //     ];

    //     if (!opt.rejectUnauthorized) {
    //         // (SSL) This option explicitly allows curl to perform "insecure" SSL connections and transfers
    //         // same as --insecure
    //         cmd.splice(1,0,'-k');
    //     }

    //     // method
    //     if ( !/get/i.test(opt.method) ) {
    //         cmd.splice(1,0,'-X '+ opt.method.toUpperCase() );
    //     }


    //     if ( /(post|put)/i.test(opt.method) && opt.queryData.length > 0) {
    //         cmd.push('-d '+ opt.queryData );
    //         body = Buffer.from(opt.queryData);
    //         opt.headers['content-length'] = body.length;
    //     } else if (
    //         /get/i.test(opt.method)
    //         && typeof(opt.headers['content-length']) != 'undefined'
    //     ) {
    //         delete opt.headers['content-length'];
    //     }

    //     if ( opt.headers.count() > 0) {
    //         for (let h in opt.headers) {
    //             cmd.splice(1,0,'-H "'+ h +': '+ opt.headers[h] +'"');
    //         }
    //     }

    //     // resolvers
    //     if (opt.nameservers) {
    //         resolver.setServers(opt.nameservers);
    //         await resolver
    //             .resolve4(opt.host)
    //             .catch( function onResolverErr(e) {
    //                 var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
    //                 var msg = 'Could not resolve with these `settings.server.resolvers`:\n'+ opt.nameservers.toString() +'\n' + e.stack+ '\nController Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r';
    //                 var exception = new Error(msg);
    //                 exception.status = 500;
    //                 return self.throwError(exception);
    //             })
    //             .then( function onResolved(ips) {
    //                 if ( typeof(ips) == 'undefined' || !Array.isArray(ips) || !ips.length ) {
    //                     var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
    //                     var e = new Error('`Unable to resolve ${opt.host}`');
    //                     var msg = 'Please check`settings.server.resolvers`:\n'+ opt.nameservers.toString() +'\n'+ e.stack + 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r';
    //                     var exception = new Error(msg);
    //                     exception.status = 500;
    //                     return self.throwError(exception);
    //                 }
    //                 for (let i=0, len=ips.length; i<len; i++) {
    //                     // e.g.: --resolve www.example.com:443:127.0.0.1
    //                     cmd.push('--resolve '+ opt.host +':'+ opt.port +':'+ ips[i]);
    //                 }
    //             });
    //     }




    //     cmd.push('-v "'+ opt.hostname + opt.path +'"');

    //     // Default maxBuffer is 200KB (=> 1024 * 200)
    //     // Setting it to 10MB - preventing: stdout maxBuffer length exceeded
    //     var maxBuffer = (1024 * 1024 * 10);
    //     exec(cmd.join(' '), { maxBuffer: maxBuffer }, function onResult(err, dataStr, infos) {
    //         var error = null;
    //         if (err) {
    //             try {
    //                 // by default
    //                 error = new Error('[ CONTROLLER ][ CURL#query ] request aborted\n'+ err.stack);
    //                 if (
    //                     typeof(err.message) != 'undefined'
    //                     && /Failed to connect/i.test(err.message)
    //                 ) {
    //                     var port = getContext('gina').ports[opt.protocol][opt.scheme.replace(/\:/, '')][ opt.port ];
    //                     error.accessPoint = port;
    //                     error.message = 'Could not connect to [ ' + error.accessPoint + ' ].\nThe `'+port.split(/\@/)[0]+'` bundle is offline or unreachable.\n';
    //                 }
    //                 console.error(error.stack);
    //                 if ( typeof(callback) != 'undefined' ) {
    //                     callback(error)
    //                 } else {
    //                     self.emit('query#complete', error)
    //                 }
    //             } catch (e) {
    //                 // console.error(e.stack);
    //                 var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
    //                 var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
    //                 var exception = new Error(msg);
    //                 exception.status = 500;
    //                 self.throwError(exception);
    //             }
    //             return;
    //         }


    //         try {
    //             let data = JSON.parse(dataStr);
    //             if ( typeof(data) == 'undefined' ) {
    //                 data = {}
    //             }
    //             if ( typeof(callback) != 'undefined' ) {
    //                 callback(err, data)
    //             } else {
    //                 self.emit('query#complete', err, data)
    //             }
    //         } catch (e) {
    //             // _err.stack = '[ CONTROLLER ][ CURL#query ] onCallbackError: '+ e.stack;
    //             // console.error(e.stack);
    //             var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
    //             var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
    //             var exception = new Error(msg);
    //             exception.status = 500;
    //             self.throwError(exception);
    //             return;
    //         }
    //     });
    // }

    // var handleHTTP1ClientRequestv2 = function (browser, options, callback) {
    //     var agent = new browser.Agent({ keepAlive: true });
    //     var options = {
    //         host: options.host,
    //         port: options.port,
    //         path: options.path,
    //         method: 'GET',
    //         agent: agent
    //     };

    //     var req = browser.request(options, function(res) {
    //         var str = "";
    //         var err = false;
    //         res.on('data', function (chunk) {
    //             str += chunk;
    //         });
    //         res.on('end', function () {
    //             // done
    //             return callback( err, data );
    //         });
    //     });
    //     req.write('');
    //     req.end();
    //     req.on('error', function(error) {
    //         err = error
    //     });
    // };

    var handleHTTP1ClientRequest = function(browser, options, callback, retryCount = 0) {


        // [HTTP1] For your Nginx Ingress service host, you should add :
        // # BO - Specific headers for Gina
		// proxy_set_header X-Client-IP $remote_addr;
		// proxy_set_header X-Ingress-IP $server_addr
		// proxy_set_header X-Forwarded-For $remote_addr;
		// # EO - Specific headers for Gina
        if ( typeof(local.req.headers['x-client-ip']) != 'undefined' && local.req.headers['x-client-ip'] != options.headers['x-client-ip'] ) {
            options.headers['x-client-ip'] = local.req.headers['x-client-ip']
        }

        if ( typeof(local.req.headers['x-ingress-ip']) != 'undefined' && local.req.headers['x-ingress-ip'] != options.headers['x-ingress-ip'] ) {
            options.headers['x-ingress-ip'] = local.req.headers['x-ingress-ip']
        }

        if ( /https/.test(options.scheme) && typeof(options.ca) == 'undefined' ) {
            console.warn('[ CONTROLLER ][ HTTPS/1.1#query ] options.ca not found !');
        }
        else if ( /https/.test(options.scheme) ) {
            try {
                if ( !/-----BEGIN/.test(options.ca) ) {
                    options.ca = fs.readFileSync(options.ca);
                }
            } catch(err) {
                if ( typeof(callback) != 'undefined' ) {
                    return callback(err)
                }

                return self.emit('query#complete', err);
            }
        }
        let body = "";
        if (options.queryData) {
            // Convert into Buffer to properly handle UTF-8
            body = Buffer.isBuffer(options.queryData)
                ? options.queryData
                : Buffer.from(typeof options.queryData === 'string' ? options.queryData : JSON.stringify(options.queryData));

            options.headers['content-length'] = body.length;
            options.queryData = body;
        } else {
            options.headers['content-length'] = 0;
        }
        delete options.queryData;


        // Shared Agent
        options.agent = new browser.Agent(options);

        const req = browser.request(options, function(res) {

            res.setEncoding('utf8');

            // upgrade response headers to handler
            if ( typeof(res.headers['access-control-allow-credentials']) != 'undefined' ) {
                local.options.withCredentials = res.headers['access-control-allow-credentials'];
            }

            let data = '';
            res.on('data', function onData (chunk) {
                data += chunk;
            });

            res.on('end', function onEnd(err) {
                // exceptions filter
                if ( typeof(data) == 'string' && /^Unknown ALPN Protocol/.test(data) ) {
                    err = {
                        status: 500,
                        error: new Error(data)
                    };

                    if ( typeof(callback) != 'undefined' ) {
                        return callback(err)
                    }

                    return self.emit('query#complete', err)
                }

                //Only when needed.
                if ( typeof(callback) != 'undefined' ) {
                    if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
                        try {
                            data = JSON.parse(data)
                        } catch (err) {
                            data = {
                                status    : 500,
                                error     : err
                            };
                            console.error(err);
                        }
                    }

                    try {
                        if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined' ) {
                            return self.throwError(data);
                        }

                        return callback( false, data );
                    } catch (e) {
                        var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
                        var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
                        var exception = new Error(msg);
                        exception.status = 500;

                        return self.throwError(exception);
                    }

                }

                if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
                    try {
                        data = JSON.parse(data)
                    } catch (err) {
                        data = {
                            status    : 500,
                            error     : data
                        }
                        return self.emit('query#complete', data)
                    }
                }

                if (
                    data.status
                    && !/^2/.test(data.status)
                    && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined'
                ) {
                    return self.emit('query#complete', data)
                }

                return self.emit('query#complete', false, data);
            })
        });


        //starting from from >0.10.15
        req.on('error', function onError(err) {

            // If conn is down (ECONNRESET, ETIMEDOUT),retry
            if (retryCount < options.maxRetry) {
                const delay = 500 * (retryCount + 1); // Délai progressif
                return setTimeout(() => handleHTTP1ClientRequest(browser, options, callback, retryCount + 1), delay);
            }

            if (
                typeof(err.code) != 'undefined' && /ECONNREFUSED|ECONNRESET/.test(err.code)
                || typeof(err.cause) != 'undefined' && typeof(err.cause.code) != 'undefined' &&  /ECONNREFUSED|ECONNRESET/.test(err.cause.code)
            ) {

                var port = getContext('gina').ports[options.protocol][options.scheme.replace(/\:/, '')][ options.port ];//err.port || err.cause.port
                if ( typeof(port) != 'undefined' ) {
                    err.accessPoint = port;
                    err.message = '`Controller::query()` could not connect to [ ' + err.accessPoint + ' ] using port '+options.port+'.\n';
                }
            }


            console.error(err.stack||err.message);
            // you can get here if :
            //  - you are trying to query using: `enctype="multipart/form-data"`
            //  -
            if ( typeof(callback) != 'undefined' ) {
                return callback(err)
            }

            self.emit('query#complete', {
                status    : 500,
                error     : err.stack || err.message
            })
        });

        req.setTimeout(options.timeout, () => {
            req.destroy(); // Will trigger 'error' event
        });


        if (req) { // don't touch this please

            if (req.write) req.write(body);
            if (req.end) req.end();
        }

        return {
            onComplete  : function(cb) {
                // Remove any orphaned listener from a previous query call on this instance
                // before registering the new one to prevent listener accumulation.
                self.removeAllListeners('query#complete');
                self.once('query#complete', function(err, data){

                    if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
                        try {
                            data = JSON.parse(data)
                        } catch (err) {
                            data = {
                                status    : 500,
                                error     : data
                            }
                        }
                    }

                    try {
                        if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined') {
                            return cb(data)
                        }

                        return cb(err, data)
                    } catch (e) {
                        var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
                        var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
                        var exception = new Error(msg);
                        exception.status = 500;

                        return self.throwError(exception);
                    }
                })
            }

        }
    }

    var handleHTTP2ClientRequest = function(browser, options, callback, isRetry = false) {

        var HTTP2_SESSION_MAX = 50; // max concurrent HTTP/2 sessions in cache

        //cleanup
        options[':authority'] = options.hostname;

        if ( typeof(options[':path']) == 'undefined' ) {
            options[':path'] = options.path;
            delete options.path;
        }
        if ( typeof(options[':method']) == 'undefined' ) {
            options[':method'] = options.method.toUpperCase();
            delete options.method;
        }

        if ( typeof(options[':scheme']) == 'undefined' ) {
            options[':scheme'] = options.scheme;
        }

        if ( typeof(options[':hostname']) == 'undefined' ) {
            options[':hostname'] = options.hostname;
        }
        if (
            typeof(options[':port']) == 'undefined'
            && typeof(options.port) != 'undefined'
            && options.port
        ) {
            options[':port'] = options.port;
            options[':hostname'] = options.host;
        }
        delete options.host;

        if ( /https/.test(options.scheme) && typeof(options.ca) == 'undefined' ) {
            console.warn('[ CONTROLLER ][ HTTP/2.0#query ] options.ca not found !');
        }
        else if ( /https/.test(options.scheme) ) {
            try {
                if ( !/-----BEGIN/.test(options.ca) ) {
                    options.ca = fs.readFileSync(options.ca);
                }
            } catch(err) {
                if ( typeof(callback) != 'undefined' ) {
                    return callback(err)
                }

                return self.emit('query#complete', err);
            }
        }


        var body = options.queryData
            ? Buffer.from(options.queryData)
            : Buffer.alloc(0);
        options.headers['content-length'] = body.length;
        options._body = body; // stash before deleting queryData so retries can reuse it
        delete options.queryData;


        options.settings = {
            // Prevents the NGHTTP2_PROTOCOL_ERROR on long URLs (UUIDs)
            maxHeaderListSize: 65535,
            maxConcurrentStreams: 100,
            enablePush: false
        }

        let authority = options.hostname;
        cache.from(self.serverInstance._cached);
        let sessKey = "http2session:"+ authority;
        let requestId = `${options[':method']}:${options[':path']}:${Date.now()}`; // For debugging

        // Session key tracker — stored on server instance (same scope as cache)
        if (!self.serverInstance._http2Sessions) {
            self.serverInstance._http2Sessions = [];
        }

        let client = cache.get(sessKey);
        // Checking client status: is closed or being closed
        if (client && (client.closed || client.destroyed || client.connecting === false)) {
            client = null;
            cache.delete(sessKey);
            var _staleIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
            if (_staleIdx !== -1) self.serverInstance._http2Sessions.splice(_staleIdx, 1);
            _staleIdx = null;
        }

        if (!client || client.destroyed || client.closed) {

            // Evict the oldest session if the cache has reached its limit
            if (self.serverInstance._http2Sessions.length >= HTTP2_SESSION_MAX) {
                var _evictKey    = self.serverInstance._http2Sessions.shift();
                var _evictClient = cache.get(_evictKey);
                if (_evictClient && !_evictClient.destroyed) _evictClient.destroy();
                cache.delete(_evictKey);
                console.warn('[HTTP2] Session cache limit ('+ HTTP2_SESSION_MAX +') reached. Evicted oldest session: '+ _evictKey);
                _evictKey    = null;
                _evictClient = null;
            }

            client = browser.connect(authority, options);

            // Optional but recommended on M4/Orbstack
            client.setTimeout(0); // disable the default timeout to keep session active

            client.on('error', (error) => {
                console.error( '`'+ options[':path']+ '` : '+ error.stack||error.message);
                cache.delete(sessKey);
                var _errIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                if (_errIdx !== -1) self.serverInstance._http2Sessions.splice(_errIdx, 1);
                _errIdx = null;
                if (
                    typeof(error.cause) != 'undefined' && typeof(error.cause.code) != 'undefined' && /ECONNREFUSED|ECONNRESET/.test(error.cause.code)
                    || /ECONNREFUSED|ECONNRESET/.test(error.code)
                ) {

                    var port = getContext('gina').ports[options.protocol][options.scheme.replace(/\:/, '')][ options.port ];
                    if ( typeof(port) != 'undefined' ) {
                        error.accessPoint = port;
                        error.message = 'Could not connect to [ ' + error.accessPoint + ' ].\nThe `'+port.split(/\@/)[0]+'` bundle is offline or unreachable.\n';
                    }
                }
                self.throwError(error);
                return;
            });

            client.on('close', () => {
                console.log('[CLIENT] Session expired or closed by server. Removing from cache.');
                cache.delete(sessKey);
                var _closeIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                if (_closeIdx !== -1) self.serverInstance._http2Sessions.splice(_closeIdx, 1);
                _closeIdx = null;
            });

            client.on('goaway', () => {
                console.warn('[CLIENT] Server is going away. Draining session.');
                cache.delete(sessKey);
                var _goawayIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                if (_goawayIdx !== -1) self.serverInstance._http2Sessions.splice(_goawayIdx, 1);
                _goawayIdx = null;
            });

            cache.set(sessKey, client);
            self.serverInstance._http2Sessions.push(sessKey);
        }


        const {
            HTTP2_HEADER_PROTOCOL,
            HTTP2_HEADER_SCHEME,
            HTTP2_HEADER_AUTHORITY,
            HTTP2_HEADER_PATH,
            HTTP2_HEADER_METHOD,
            HTTP2_HEADER_STATUS
        } = browser.constants;


        if ( typeof(local.req.headers['x-requested-with']) != 'undefined' ) {
            options.headers['x-requested-with'] = local.req.headers['x-requested-with']
        }

        if ( typeof(local.req.headers['access-control-allow-credentials']) != 'undefined' ) {
            options.headers['access-control-allow-credentials'] = local.req.headers['access-control-allow-credentials']
        }

        if ( typeof(local.req.headers['content-type']) != 'undefined' && local.req.headers['content-type'] != options.headers['content-type'] ) {
            options.headers['content-type'] = local.req.headers['content-type']
        }

        // [HTTP2] For your Nginx Ingress service host, you should add :
        // # BO - Specific headers for Gina
		// proxy_set_header X-Client-IP $remote_addr;
		// proxy_set_header X-Ingress-IP $server_addr
		// proxy_set_header X-Forwarded-For $remote_addr;
		// # EO - Specific headers for Gina
        if ( typeof(local.req.headers['x-client-ip']) != 'undefined' && local.req.headers['x-client-ip'] != options.headers['x-client-ip'] ) {
            options.headers['x-client-ip'] = local.req.headers['x-client-ip']
        }

        if ( typeof(local.req.headers['x-ingress-ip']) != 'undefined' && local.req.headers['x-ingress-ip'] != options.headers['x-ingress-ip'] ) {
            options.headers['x-ingress-ip'] = local.req.headers['x-ingress-ip']
        }

        var headers = merge({
            [HTTP2_HEADER_METHOD]: options[':method'],
            [HTTP2_HEADER_PATH]: options[':path']
        }, options.headers);


        // merging with user options
        for (var o in options) {
            if (
                !/^\:/.test(o)
                && !/headers/.test(o)
                && typeof(headers[o]) == 'undefined'
            ) {
                headers[o] = options[o]
            }
        }
        // 2. CRUCIAL SECURITY: Remove manual content-length for HTTP/2
        // Node.js will calculate it automatically and correctly with req.end(body)
        delete headers['content-length'];
        delete headers['Content-Length'];

        // Strict sanitization for HTTP/2 (no undefined)
        Object.keys(headers).forEach(key => {
            if (headers[key] === undefined || headers[key] === null) delete headers[key];
        });


        const req = client.request(headers);

        // TODO - Add client::http2Ping option (only usefull for realtime apps like trading)
        // Optional: Keep the pipe warm
        // setInterval(() => {
        //     for (let [auth, client] of sessions) {
        //         if (!client.destroyed && !client.closed) client.ping((err, duration) => {});
        //     }
        // }, 30000);

        let isFinished = false;
        let data = '';
        req.on('data', function onQueryDataChunk(chunk) {
            data += chunk;
        });

        req.on('error', function onQueryError(error) {
            // 1. Multiplexing Safety: prevent double callback/emit if stream ends & errors simultaneously
            if (isFinished) return;

             // --- CRITICAL FIXES FOR PRODUCTION ---
            // A. Error object name: using 'error' (from function arg) instead of 'err'
            const errorCode = error.code || (error.cause ? error.cause.code : null);


            // If the session closed exactly when we sent the request (Race Condition)
            // We attempt ONE retry with a fresh connection
            if (!isRetry && (errorCode === 'ERR_HTTP2_STREAM_ERROR' || errorCode === 'ECONNRESET')) {
                isFinished = true; // Mark current attempt as done
                console.warn(`[HTTP2][RETRYING] Stream failed on ${options[':path']}. Retrying with fresh session...`);
                cache.delete(sessKey);
                if (!client.destroyed) client.destroy();
                // Recursive call with isRetry = true to prevent infinite loops
                options.queryData = options._body; // restore body for retry
                return handleHTTP2ClientRequest(browser, options, callback, true);
            }

            isFinished = true;

            // 2. Connection error handling (ECONNREFUSED, ECONNRESET, etc.)
            const isConnError = (
                (error.cause && error.cause.code && /ECONNREFUSED|ECONNRESET/.test(error.cause.code)) ||
                (error.code && /ECONNREFUSED|ECONNRESET/.test(error.code))
            );

            if (isConnError) {
                // Attempt to find the human-readable port/access point from Gina context
                try {
                    const ginaContext = getContext('gina');
                    const schemeKey = options.scheme ? options.scheme.replace(/\:/, '') : options.protocol;
                    const portInfo = ginaContext.ports[options.protocol][schemeKey][options.port];

                    if (typeof portInfo !== 'undefined') {
                        error.accessPoint = portInfo;
                        error.message = `[HTTP2] Could not connect to [ ${error.accessPoint} ].\n${error.message}`;
                    }
                } catch (e) {
                    // Context might be missing, we just log the raw error
                    console.error(`[HTTP2] Context lookup failed during error handling: ${e.message}`);
                }
            }

            // 3. English logging
            console.error(`[HTTP2] Stream Error on ${options[':method']} ${options[':path']}:`);
            console.error(error.stack || error.message);

            // 4. Response handling
            // you can get here if :
            //  - you are trying to query using: `enctype="multipart/form-data"`
            //  - server responded with an error
            if (typeof callback !== 'undefined') {
                // Return the error object to the controller
                callback(error);
            } else {
                // Fallback to Event Emitter for Gina Framework
                const errorData = {
                    status: 500,
                    error: error.stack || error.message
                };
                self.emit('query#complete', errorData);
            }

            // Note: The 'client' session remains in the Map so other parallel requests
            // on the same session can continue unless the entire session is destroyed.
        });


        req.on('close', function onQueryClosed() {
            console.warn('Request stream closed.');
        });

        req.on('end', function onEnd() {
            // 1. Prevention: Ensure the logic only runs once per request
            if (isFinished) return;
            isFinished = true;

            // 2. Guard Clause: Handle empty responses or aborted streams
            if (!data || data.trim() === "") {
                // If aborted, handle it specifically
                if (req.aborted || req.destroyed) {
                    data = { status: 500, error: new Error('Request aborted by client or server') };
                } else {
                    // Might be a 204 No Content, but usually CoreAPI should return {}
                    console.warn('[HTTP2] Empty response received');
                    data = { status: 200, empty: true };
                }
            }
            // 3. Exception filter for ALPN or protocol mismatches
            if (typeof data === 'string' && /^Unknown ALPN Protocol/.test(data)) {
                const err = { status: 500, error: new Error(data) };
                return (typeof callback !== 'undefined') ? callback(err) : self.emit('query#complete', err);
            }

            // 4. Data Parsing & Validation
            if (typeof callback !== 'undefined') {
                if (typeof data === 'string' && /^(\{|%7B|\[{)|\[\]/.test(data)) {
                    try {
                        data = JSON.parse(data);
                        if (typeof data.status === 'undefined') {
                            const currentRule = local.options.rule || local.req.routing.rule;
                            console.warn(`[${currentRule}] Response status code is undefined: switching to 200`);
                            data.status = 200;
                        }
                    } catch (err) {
                        data = { status: 500, error: err };
                        console.error('[HTTP2] JSON Parse Error:', err);
                    }
                } else if (!data && req.aborted && req.destroyed) {
                    data = { status: 500, error: new Error('Request aborted') };
                }

                try {
                    // Intercepting fallback redirect (3xx)
                    if (data.status && /^3/.test(data.status) && typeof data.headers !== 'undefined') {
                        local.res.writeHead(data.status, data.headers);
                        return local.res.end();
                    }

                    // Error code handling (non-2xx)
                    const statusCodes = local.options.conf.server.coreConfiguration.statusCodes;
                    if (data.status && !/^2/.test(data.status) && typeof statusCodes[data.status] !== 'undefined') {
                        if (/^5/.test(data.status)) {
                            return callback(data);
                        } else {
                            self.throwError(data);
                            return;
                        }
                    } else {
                        // Success path
                        if (self && self.isHaltedRequest() && typeof local.onHaltedRequestResumed !== 'undefined') {
                            local.onHaltedRequestResumed(false);
                        }
                        return callback(false, data);
                    }
                } catch (e) {
                    const infos = local.options;
                    const controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
                    const msg = `Controller Query Exception while catching back.\nBundle: ${infos.bundle}\nController: ${controllerName}\nControl: ${infos.control}\n${e.stack}`;
                    const exception = new Error(msg);
                    exception.status = 500;
                    self.throwError(exception);
                    return;
                }
            } else {
                // Fallback for EventEmitter mode (no callback)
                if (typeof data === 'string' && /^(\{|%7B|\[{)|\[\]/.test(data)) {
                    try {
                        data = JSON.parse(data);
                    } catch (e) {
                        data = { status: 500, error: data };
                        self.emit('query#complete', data);
                        return;
                    }
                }

                if (data.status && /^3/.test(data.status) && typeof data.headers !== 'undefined') {
                    self.removeAllListeners(['query#complete']);
                    local.res.writeHead(data.status, data.headers);
                    return local.res.end();
                }

                if (data.status && !/^2/.test(data.status) && typeof local.options.conf.server.coreConfiguration.statusCodes[data.status] !== 'undefined') {
                    self.emit('query#complete', data);
                } else {
                    if (self.isHaltedRequest() && typeof local.onHaltedRequestResumed !== 'undefined') {
                        local.onHaltedRequestResumed(false);
                    }
                    self.emit('query#complete', false, data);
                }
            }

            // IMPORTANT: client (session) is NOT closed here to allow multiplexing
        });

        // req.on('end', function onEnd() {
        //     // exceptions filter
        //     if ( typeof(data) == 'string' && /^Unknown ALPN Protocol/.test(data) ) {
        //         var err = {
        //             status: 500,
        //             error: new Error(data)
        //         };

        //         if ( typeof(callback) != 'undefined' ) {
        //             callback(err)
        //         } else {
        //             self.emit('query#complete', err)
        //         }

        //         return
        //     }

        //     //Only when needed.
        //     if ( typeof(callback) != 'undefined' ) {
        //         if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
        //             try {
        //                 data = JSON.parse(data);
        //                 // just in case
        //                 if ( typeof(data.status) == 'undefined' ) {
        //                     var currentRule = local.options.rule || local.req.routing.rule;
        //                     console.warn( '['+ currentRule +'] ' + 'Response status code is `undefined`: switching to `200`');
        //                     data.status = 200;
        //                 }
        //             } catch (err) {
        //                 data = {
        //                     status    : 500,
        //                     error     : err
        //                 }
        //                 console.error(err);
        //             }
        //         } else if ( !data && this.aborted && this.destroyed) {
        //             data = {
        //                 status    : 500,
        //                 error     : new Error('request aborted')
        //             }
        //         }
        //         //console.debug(options[':method']+ ' ['+ (data.status || 200) +'] '+ options[':path']);
        //         try {
        //             // intercepting fallback redirect
        //             if ( data.status && /^3/.test(data.status) && typeof(data.headers) != 'undefined' ) {
        //                 local.res.writeHead(data.status, data.headers);
        //                 return local.res.end();
        //             }

        //             if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined' ) {
        //                     if ( /^5/.test(data.status)  ) {
        //                         return callback(data)
        //                     } else {
        //                         self.throwError(data);
        //                         return;
        //                     }
        //             } else {
        //                 // required when control is used in an halted state
        //                 // Ref.: resumeRequest()
        //                 if ( self && self.isHaltedRequest() && typeof(local.onHaltedRequestResumed) != 'undefined' ) {
        //                     local.onHaltedRequestResumed(false);
        //                 }
        //                 return callback( false, data )
        //             }

        //         } catch (e) {
        //             var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
        //             var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
        //             var exception = new Error(msg);
        //             exception.status = 500;
        //             self.throwError(exception);
        //             return;
        //         }

        //     } else {
        //         if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
        //             try {
        //                 data = JSON.parse(data)
        //             } catch (e) {
        //                 data = {
        //                     status    : 500,
        //                     error     : data
        //                 }
        //                 self.emit('query#complete', data)
        //             }
        //         }

        //         // intercepting fallback redirect
        //         if ( data.status && /^3/.test(data.status) && typeof(data.headers) != 'undefined' ) {
        //             self.removeAllListeners(['query#complete']);
        //             local.res.writeHead(data.status, data.headers);
        //             return local.res.end();
        //         }

        //         if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined' ) {
        //             self.emit('query#complete', data)
        //         } else {
        //             // required when control is used in an halted state
        //             // Ref.: resumeRequest()
        //             if ( self.isHaltedRequest() && typeof(local.onHaltedRequestResumed) != 'undefined' ) {
        //                 local.onHaltedRequestResumed(false);
        //             }
        //             self.emit('query#complete', false, data)
        //         }
        //     }

        //     // IMPORTANT, DO not close the client since it is being reused
        // });


        if (
            body && (/^post$/i.test(headers[':method'])
            || /^put$/i.test(headers[':method'])
            || /^patch$/i.test(headers[':method']) )
        ) {
            if (!req.destroyed && !req.closed) {
                // req.write(body, (err) => {
                //     if (err) console.error('[CONTROLLER][handleHTTP2] Write error:', err);
                //     // Closing on write success
                //     req.end();
                // });
                req.end(body);
            }
        } else {
            if (!req.destroyed && !req.closed) {
                req.end();
            }
        }


        return {
            onComplete  : function(cb) {

                // Remove any orphaned listener from a previous query call on this instance
                // before registering the new one to prevent listener accumulation.
                self.removeAllListeners('query#complete');
                self.once('query#complete', function(err, data){

                    if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
                        try {
                            data = JSON.parse(data)
                        } catch (err) {
                            data = {
                                status    : 500,
                                error     : data
                            }
                        }
                    }

                    try {
                        if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined') {
                            cb(data)
                        } else {
                            // required when control is used in an halted state
                            // Ref.: resumeRequest()
                            if ( self.isHaltedRequest() && typeof(local.onHaltedRequestResumed) != 'undefined' ) {
                                local.onHaltedRequestResumed(err);
                            }

                            cb(err, data)
                        }
                    } catch (e) {
                        var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
                        var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
                        var exception = new Error(msg);
                        exception.status = 500;
                        self.throwError(exception);
                        return;
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
     * @returns {string | boolean} err
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
     * @param {object} req
     *
     * @returns {object} params
     * */
    var getParams = function(req) {

        req.getParams = function() {
            // Clone
            var params = JSON.clone(req.params);
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

                case 'head':
                    params = merge(params, req.head, true);
                    break;
            }

            return params
        }

        req.getParam = function(name) {

            var param   = null;
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

                case 'head':
                    param = req.head[name];
                    break;
            }

            return param
        }
    }

    /**
     * Forward request
     * Allowing x-bundle forward
     * Attention: this is a work in progres, do not use it yet
     *
     * @param {object} req
     * @param {object} res
     * @param {callback} next
     * @returns
     */
    this.forward = function(req, res, next) {
        var route   = req.routing;
        if ( typeof(route.param.url) == 'undefined' || /^(null|\s*)$/.test(route.param.url) ) {
            self.throwError( new Error('`route.param.url` must be defiend in your route: `'+ route.rule +'`') );
            return;
        }

        var param = {};
        for (let p in route.param) {
            if ( /^(url|urlIndex|control|file|title|bundle|project|hostname|port|path|method)$/.test(p) ) {
                continue;
            }
            param[p] = route.param[p]
        }
        var routeObj = null;
        if ( typeof(route.param.urlIndex) != 'undefined' ) {
            routeObj = lib.routing.getRoute(route.param.url, param, route.param.urlIndex);
        } else {
            routeObj = lib.routing.getRoute(route.param.url, param);
        }
        var ca = self.getConfig('settings').server.credentials.ca;
        var hostname = null, port = null, path = null;
        // by default
        var project = local.options.conf.projectName;
        if ( typeof(route.param.project) != 'undefined' && /^(null|\s*)$/.test(route.param.project) ) {
            project = route.param.project;
        } // TODO - add support for project pointer : getContext('gina').projects[project]
        if (/\@(.*)$/.test(route.param.url)) {
            var targetedBundle = route.param.url.substring(route.param.url.lastIndexOf('@')+1);
            hostname    = targetedBundle +'@'+ project;
            port        = hostname;
            var webroot = getContext('gina').config.envConf[targetedBundle][local.options.conf.env].server.webroot;
            path        = (/\/$/.test(webroot)) ? webroot.substring(0, webroot.length-1) : webroot;
        } else {
            hostname    = route.param.hostname;
            port        = route.param.port;
            path        = route.param.port;
        }

        var method = null;
        if ( typeof(route.param.method) != 'undefined' ) {
            method = route.param.method.toLowerCase();
        } else {
            method = req.method.toLowerCase();
        }

        var opt = {
            ca: ca,
            hostname: hostname,
            port: port,
            path: path,
            method: method
        }
        if (self.isCacheless() || self.isLocalScope() ) {
            opt.rejectUnauthorized = false;
        }

        var obj = req[ req.method.toLowerCase() ];
        // if ( req.files != 'undefined' ) {
        //     obj.files = req.files;
        // }
        self.query(opt, obj, function onForward(err, result){
            if (err) {
                self.throwError(err);
                return;
            }

            // TODO - filter : redirect & location

            // if ( self.isXMLRequest() || !hasViews() || !local.options.isUsingTemplate && !hasViews() || hasViews() && !local.options.isUsingTemplate ) {
                self.renderJSON(result)
            // } else {
            //     self.render(result)
            // }
        });
    }


    /**
     * Get config
     *
     * @param {string} [name] - Conf name without extension.
     * @returns {object} config
     *
     * */
    this.getConfig = function(name) {
        var tmp = null;
        if ( typeof(name) != 'undefined' ) {
            try {
                // Needs to be read only
                tmp = JSON.clone(local.options.conf.content[name]);
            } catch (err) {
                return undefined;
            }
        } else {
            tmp = JSON.clone(local.options.conf);
        }

        if (
            getContext('isProxyHost')
            && typeof(tmp.hostname) != 'undefined'
        ) {
            tmp.hostname    = process.gina.PROXY_HOSTNAME;
            tmp.host        = process.gina.PROXY_HOST;
        }
        return tmp;
    }

    /**
     * Get locales
     * Will take only supported lang
     *
     * @param {string} [shortCountryCode] - e.g. EN
     *
     * @returns {object} locales
     * */
    this.getLocales = function (shortCountryCode) {

        var userLocales = local.options.conf.locales;

        if ( typeof(shortCountryCode) != 'undefined' ) {
            shortCountryCode = shortCountryCode.toLowerCase();
            var locales         = new Collection( getContext('gina').locales );

            try {
                userLocales = locales.findOne({ lang: shortCountryCode }).content
            } catch (err) {
                console.warn('language code `'+ shortCountryCode +'` not handled to setup locales: replacing by `'+ local.options.conf.content.settings.region.shortCode +'`');
                userLocales = locales.findOne({ lang: local.options.conf.content.settings.region.shortCode }).content // by default
            }
        }


        /**
         * Get countries list
         *
         * @param {string} [code] - e.g.: officialStateName, isoShort, isoLong, continent, capital, currency.name
         *
         * @returns {object} countries - countries code & value list
         * */
        var getCountries = function (code) {
            var list = [], cde = 'countryName';

            if ( typeof(code) != 'undefined' && typeof(userLocales[0][code]) == 'string' ) {
                cde = code
            } else if ( typeof(code) != 'undefined' ) {
                console.warn('`'+ code +'` not supported : sticking with `short` code')
            }


            for ( let i = 0, len = userLocales.length; i< len; ++i ) {
                list[ i ] = {
                    isoShort: userLocales[i].isoShort,
                    isoLong: userLocales[i].isoLong,
                    countryName: userLocales[i].countryName,
                    officialStateName: userLocales[i].officialStateName
                };
            }

            return list
        }

        return {
            'getCountries': getCountries
            // TODO - getCurrencies()
        }
    }

    /**
     * Get forms rules
     *
     *
     * @returns {object} rules
     *
     * */
    this.getFormsRules = function () {
        var bundle  = local.options.conf.bundle; // by default
        var form    = null;
        var rule    = null;
        var isGettingRulesFromAnotherBundle = false;
        var rules   = {};
        if ( typeof(local.req.ginaHeaders) != 'undefined' && typeof(local.req.ginaHeaders.form) != 'undefined' ) {
            form = local.req.ginaHeaders.form;
            if ( typeof(form.rule) != 'undefined' ) {
                var ruleInfos = form.rule.split(/\@/);
                rule = ruleInfos[0];
                // rules might be located in another bundle
                if (ruleInfos[1] && ruleInfos[1] != '' && ruleInfos[1] != bundle) {
                    bundle = ruleInfos[1];
                    isGettingRulesFromAnotherBundle = true;
                }
            }
        }

        if ( form && typeof(form.id) != 'undefined' ) {
            try {
                if (isGettingRulesFromAnotherBundle) {
                    rules = JSON.clone(getConfig()[bundle][local.options.conf.env].content.forms.rules[form.id]) || null;
                } else {
                    rules = JSON.clone(local.options.conf.content.forms).rules[form.id] || null;
                }

                if (!rules) {
                    rules = {};
                    console.warn('[CONTROLLER]['+ local.options.conf.bundle +'][Backend validation] did not find matching rules for form.id `'+ form.id +'` for  `'+ bundle+' bundle`. Do not Panic if you did not defined any.')
                }
            } catch (ruleErr) {
                self.throwError(ruleErr);
                return;
            }
        }

        return rules;
    }

    this.push = function(payload, option, callback) {

        var req = local.req, res = local.res;
        var method  = req.method.toLowerCase();
        // if no session defined, will push to all active clients
        // resuming current session
        var sessionId = ( typeof(req[method].sessionID) != 'undefined' ) ? req[method].sessionID : null;
        // retrieve section if existing
        var section = ( typeof(req[method].section) != 'undefined' ) ? req[method].section : null;

        if (!payload) {
            payload     = null;
            if ( typeof(req[method]) != 'undefined' && typeof(req[method].payload) != 'undefined' ) {
                if ( typeof(payload) == 'string' ) {
                    payload = decodeURIComponent(req[method].payload);
                    payload = JSON.parse(payload);
                    if ( section && typeof(payload.section) == 'undefined' ) {
                      payload.section = section
                    }
                    payload = JSON.stringify(payload)
                } else {
                    if ( section && typeof(req[method].payload.section) == 'undefined' ) {
                      req[method].payload.section = section
                    }
                    payload =  JSON.stringify(req[method].payload)
                }
            }
        } else if ( typeof(payload) == 'object' ) {
            if ( section && typeof(payload.section) == 'undefined' ) {
              payload.section = section
            }
            payload = JSON.stringify(payload)
        }

        try {
            var clients = null;
            clients = self.serverInstance.eio.clients;
            if ( clients ) {
                for (let s in clients) {
                    if ( !clients[s].constructor.name == 'Socket' ) {
                        continue;
                    }

                    if (
                        // session filter
                        sessionId
                        && typeof(clients[s].sessionId) != 'undefined'
                        && clients[s].sessionId == sessionId
                        ||
                        // send to all clients if no specific sessionId defined
                        !sessionId
                    ) {
                        clients[s].sendPacket("message", payload, options, callback);
                    }
                }
            }

            // res.end();
        } catch(err) {
            self.throwError(err);
            return;
        }
    }

    var getSession = function() {
        var session = null;
        if ( typeof(local.req.session) != 'undefined') {
            session = local.req.session;
        }
        // passport override
        if (!session && typeof(local.req.session) != 'undefined' && typeof(local.req.session.user) != 'undefined') {
            session = local.req.session.user;
        }

        return session;
    }

    this.isHaltedRequest = function(session) {
        // trying to retrieve session since it is optional
        if ( typeof(session) == 'undefined' ) {
            session = getSession();
            // if ( typeof(local.req.session) != 'undefined' && typeof(local.req.session.haltedRequest) != 'undefined' ) {
            //     session = local.req.session;
            // }
            // // passport
            // if (!session && typeof(local.req.session) != 'undefined' && typeof(local.req.session.user) != 'undefined' && typeof(local.req.session.user.haltedRequest) != 'undefined' ) {
            //     session = local.req.session.user;
            // }
            if (
                !session
                ||
                typeof(session) != 'undefined'
                && typeof(session.haltedRequest) == 'undefined'
            ) {
                return false;
            }
        }

        return (typeof(session.haltedRequest) != 'undefined' ) ? true : false;
    }


    local.haltedRequestUrlResumed = false;

    this.pauseRequest = function(data, requestStorage) {


        // saving halted request
        var req             = local.req
            , res           = local.res
            , next          = local.next
            , haltedRequest = {
                url     : req.url,
                routing : req.routing,
                method  : req.method.toLowerCase(),
                data    : JSON.clone(data)
            }
        ;

        if (
            typeof(requestStorage) == 'undefined'
            && typeof(req.session) != 'undefined'
        ) {
            requestStorage = req.session;
        }

        if (
            typeof(requestStorage) == 'undefined'
        ) {
            var error = new ApiError('`requestStorage` is required', 424);
            self.throwError(error);
            return;
        }

        var requestParams = {}, i = 0;
        for (var p in req.params) {
            if (i > 0) {
                requestParams[p] = req.params[p];
            }
            ++i;
        }
        if (requestParams.count() > 0) {
            haltedRequest.params = requestParams;
        }

        requestStorage.haltedRequest = haltedRequest;

        return requestStorage;
    }


    /**
     * resumeRequest
     * Used to resume an halted request
     * Requirements :
     *  - a middleware attached `haltedRequest` to userSession
     * OR
     * - a persistant object where `haltedRequest` is attached
     *
     * @param {object} req
     * @param {object} res
     * @param {callback|null} next
     * @param {object} [requestStorage] - Will try to use sessionStorage if not passed
     */
    this.resumeRequest = function(requestStorage) {

        if (local.haltedRequestUrlResumed)
            return;

        var haltedRequest   = null
            , req           = local.req
            , res           = local.res
            , next          = local.next
        ;

        if (
            typeof(requestStorage) == 'undefined'
            && typeof(req.session) != 'undefined'
        ) {
            requestStorage = req.session;
        }

        if (
            typeof(requestStorage) == 'undefined'
            ||
            typeof(requestStorage) != 'undefined'
            && typeof(requestStorage.haltedRequest) == 'undefined'
        ) {
            var error = new ApiError('`requestStorage.haltedRequest` is required', 424);
            self.throwError(error);
            return;
        }
        haltedRequest       = requestStorage.haltedRequest;
        var data            = haltedRequest.data || {};
        // request methods cleanup
        // checkout /framework/{verrsion}/core/template/conf/(settings.json).server.supportedRequestMethods
        var serverSupportedMethods = local.options.conf.server.supportedRequestMethods;
        for (let method in serverSupportedMethods) {
            if (req.method.toLowerCase() == method) {
                data = merge(data, req[method])
            }

            delete req[method];
        }


        var dataAsParams    = {};
        if (data.count() > 0) {
            dataAsParams = JSON.clone(haltedRequest.data);
        }
        var url             = lib.routing.getRoute(haltedRequest.routing.rule, haltedRequest.params||dataAsParams).url;
        var requiredController = self; // by default;
        if ( req.routing.namespace != haltedRequest.routing.namespace ) {
            try {
                requiredController = self.requireController(haltedRequest.routing.namespace, self._options );
            } catch (err) {
                self.throwError(err);
            }
        }
        req.routing     = haltedRequest.routing;
        req.method      = haltedRequest.method;
        req[haltedRequest.method] = data;

        local.haltedRequestUrlResumed = true;
        if ( /GET/i.test(req.method) ) {
            if ( typeof(requestStorage.haltedRequest) != 'undefined' ) {
                delete requestStorage.haltedRequest;
            }
            delete requestStorage.haltedRequest;
            delete requestStorage.inheritedData;
            requestStorage.haltedRequestUrlResumed = url;

            if (
                typeof(req.routing.param.isPopinContext) != 'undefined'
                && /^true$/i.test(req.routing.param.isPopinContext)
                && self.isXMLRequest()
                ||
                self.isPopinContext()
                && self.isXMLRequest()
            ) {
                // return self.renderJSON({
                //     isXhrRedirect: true,
                //     popin: {
                //         location: url
                //     }
                // })
                self.redirect(url, true);
                return;
            }
            else if (self.isXMLRequest() ) {
                return self.renderJSON({
                    isXhrRedirect: true,
                    location: url
                })
            }

            requiredController.redirect(url, true);

        } else {
            local.onHaltedRequestResumed = function(err) {
                if (!err) {
                    delete requestStorage.haltedRequest;
                    delete requestStorage.inheritedData;
                }
            }
            if ( typeof(next) == 'function' ) {
                console.warn('About to override `next` param');
            }

            try {
                requiredController[req.routing.param.control](req, res, next);
                // consuming it
                local.onHaltedRequestResumed(false);
            } catch(err) {
                console.error('[ BUNDLE ][ '+ local.options.conf.bundle +' ][ Controller ] Could not resume haltedRequest\n' + err.stack );
                self.throwError(err);
            }


        }
    }


    this.renderCustomError = function (req, res, next) {

        // preventing multiple call of self.renderWithoutLayout() when controller is rendering from another required controller
        if (local.options.renderingStack.length > 1) {
            return false;
        }
        local.options.isRenderingCustomError = true;

        //local.options.isWithoutLayout = true;

        var data = null;
        if ( typeof(req.routing.param.error) != 'undefined' ) {
            data = JSON.clone(req.routing.param.error) || {};
            delete req.routing.param.error
        }

        var session = getSession();
        if (session) {
            if (!data) {
                data = {}
            }
            data.session = ( typeof(session.user) != 'undefined' ) ? JSON.clone(session.user) : JSON.clone(session);
        }
        var displayToolbar = req.routing.param.displayToolbar || false;
        if (req.routing.param.displayToolbar) {
            delete req.routing.param.displayToolbar
        }
        var isLocalOptionResetNeeded = req.routing.param.isLocalOptionResetNeeded || false;
        var errOptions = null;
        if (isLocalOptionResetNeeded) {
            delete req.routing.param.isLocalOptionResetNeeded;
            var bundleConf = JSON.clone(local.options.conf);
            var bundle = req.routing.bundle;
            var param = req.routing.param;
            var localOptions = {
                // view namespace first
                //namespace       : null,
                control         : param.control,
                //controller      : controllerFile,
                //controller: '<span class="gina-bundle-name">' + bundle +'</span>/controllers/controller.js',
                file: param.file,
                //layout: param.file,
                //bundle          : bundle,//module
                bundlePath      : bundleConf.bundlesPath + '/' + bundle,
                renderingStack  : bundleConf.renderingStack,
                //rootPath        : self.executionPath,
                // We don't want to keep original conf untouched
                //conf            : JSON.clone(conf),
                //template: (routeHasViews) ? bundleConf.content.templates[templateName] : undefined,
                //isUsingTemplate: local.isUsingTemplate,
                //isCacheless: isCacheless,
                path: null //, // user custom path : namespace should be ignored | left blank
                //assets: {}
            };
            errOptions = merge(localOptions, local.options);


        }
        delete local.options.namespace;
        self.render(data, displayToolbar, errOptions);
    }

    var getResponseProtocol = function (response) {
        // var options =  local.options;
        // var protocolVersion = ~~options.conf.server.protocol.match(/\/(.*)$/)[1].replace(/\.\d+/, '');

        var protocol    = 'http/'+ local.req.httpVersion; // inheriting request protocol version by default
        var bundleConf  = options.conf;
        // switching protocol to h2 when possible
        if ( /http\/2/.test(bundleConf.server.protocol) && response.stream ) {
            protocol    = bundleConf.server.protocol;
        }

        return protocol;
    }


    /**
     * Throw error
     *
     * @param {object} [ res ]
     * @param {number} code
     * @param {string} msg
     *
     * @returns {void}
     * */
    this.throwError = function(res, code, msg) {

        var protocol        = getResponseProtocol(res);
        var stream          = ( /http\/2/.test(protocol) && res.stream ) ? res.stream : null;
        var header          = ( /http\/2/.test(protocol) && res.stream ) ? {} : null;

        self.isProcessingError = true;
        var errorObject = null; // to be returned

        // preventing multiple call of self.throwError() when controller is rendering from another required controller
        if (local.options.renderingStack.length > 1) {
            return false
        }
        var bundleConf = local.options.conf;
        var bundle = bundleConf.bundle;
        // handle error fallback
        // err.fallback must be a valide route object or a url string
        var fallback = null;
        var standardErrorMessage = null;
        if (
            arguments[0] instanceof Error
            || arguments.length == 1 && typeof(res) == 'object'
            || arguments[arguments.length-1] instanceof Error
            || typeof(arguments[arguments.length-1]) == 'string' && !(arguments[0] instanceof Error)
        ) {

            msg    = ( !/^\d+$/.test(code) && typeof(msg) == 'undefined' ) ?  code : msg;
            code    = ( res && typeof(res.status) != 'undefined' ) ?  res.status : 500;

            if ( typeof(statusCodes[code]) != 'undefined' ) {
                standardErrorMessage = statusCodes[code];
            } else {
                console.warn('[ ApiValidator ] statusCode `'+ code +'` not matching any definition in `'+_( getPath('gina').core + '/status.codes')+'`\nPlease contact the Gina dev team to add one if required');
            }

            errorObject = {
                status  : code,
                error   : res.error || res.message || standardErrorMessage
            };

            if ( res instanceof Error || typeof(res.stack) != 'undefined' ) {
                //errorObject.status   = code;
                //errorObject.error    = standardErrorMessage || res.error || res.message;
                errorObject.stack   = res.stack;
                if (res.message && typeof(res.message) == 'string') {
                    errorObject.message = res.message;
                } else if (res.message) {
                    console.warn('[ Controller ] Ignoring message because of the format.\n'+res.message)
                }

                // ApiError merge


            } else if ( typeof(arguments[arguments.length-1]) == 'string' ) {
                // formated error
                errorObject.message = arguments[arguments.length-1] || msg
                // errorObject = merge(arguments[arguments.length-1], errorObject)
            } else if (
                arguments[arguments.length-1] instanceof Error
                || typeof(res) == 'object' && typeof(res.stack) != 'undefined'
            ) {
                errorObject = merge(arguments[arguments.length-1], errorObject)
            } else if (
                !(arguments[arguments.length-1] instanceof Error)
                && typeof(res) == 'object'
                && typeof(res.error) != 'undefined'
                && typeof(res.fields) != 'undefined'
                ||
                !(arguments[arguments.length-1] instanceof Error)
                && typeof(res) == 'object'
                && typeof(res.error) != 'undefined'
                && typeof(res.flash) != 'undefined'
            ) { // ApiError merge
                errorObject = merge(arguments[arguments.length-1], errorObject)
            }

            if ( typeof(res.fallback) != 'undefined' ) {
                fallback = res.fallback
            }

            res = local.res;

        } else if (arguments.length < 3) {
            msg           = code || null;
            code          = res || 500;
            res           = local.res;
        }

        var responseHeaders = null;
        if ( typeof(res.getHeaders) == 'undefined' && typeof(res.stream) != 'undefined' ) {
            responseHeaders = res.stream.sentHeader;
        } else {
            responseHeaders = res.getHeaders() || local.res.getHeaders();
        }
        // var responseHeaders = res.getHeaders() || local.res.getHeaders();
        var req             = local.req;
        var next            = local.next;
        if (!headersSent()) {
            // DELETE request methods don't normaly use a view,
            // but if we are calling it from a view, we should render the error back to the view
            if ( self.isXMLRequest() || !hasViews() && !/delete/i.test(req.method) || !local.options.isUsingTemplate && !hasViews() || hasViews() && !local.options.isUsingTemplate ) {
                // fallback interception
                if ( fallback ) {
                    if ( typeof(fallback) == 'string' ){ // string url: user provided
                        return self.redirect( fallback, true )
                    } else {
                        // else, using url from route object
                        // Reminder
                        // Here, we use route.toUrl() intead of
                        // route.url to support x-bundle com
                        return self.redirect( fallback.toUrl() );
                    }
                }

                // allowing this.throwError(err)
                if ( typeof(code) == 'object' && !msg && typeof(code.status) != 'undefined' && typeof(code.error) != 'undefined' ) {
                    msg     = code.error || code.message;
                    code    = code.status || 500;
                }
                if ( typeof(statusCodes[code]) != 'undefined' ) {
                    standardErrorMessage = statusCodes[code];
                } else {
                    console.warn('[ ApiValidator ] statusCode `'+ code +'` not matching any definition in `'+_( getPath('gina').core + '/status.codes')+'`\nPlease contact the Gina dev team to add one if required');
                }

                // if ( !local.res.getHeaders()['content-type'] /**!req.headers['content-type'] */  ) {
                //     // Internet Explorer override
                //     if ( typeof(req.headers['user-agent']) != 'undefined' && /msie/i.test(req.headers['user-agent']) ) {
                //         res.writeHead(code, "content-type", "text/plain")
                //     } else {
                //         res.writeHead(code, { 'content-type': bundleConf.server.coreConfiguration.mime['json']} );
                //     }
                // }

                // TODO - test with internet explorer then remove this if working
                if ( typeof(req.headers['user-agent']) != 'undefined' ) {
                    if ( /msie/i.test(req.headers['user-agent']) ) {
                        res.writeHead(code, "content-type", "text/plain");
                    } else {
                        var contentType = ( responseHeaders && responseHeaders['content-type'])
                                         ? responseHeaders['content-type']
                                         : bundleConf.server.coreConfiguration.mime['json']+ '; charset='+ bundleConf.encoding
                        ;
                        res.writeHead(code, { 'content-type': contentType } );
                    }
                } else if ( typeof(responseHeaders['content-type']) != 'undefined' ) {
                    res.writeHead(code, { 'content-type': responseHeaders['content-type']} )
                } else {
                    res.writeHead(code, "content-type", bundleConf.server.coreConfiguration.mime['json']+ '; charset='+ bundleConf.encoding);
                }



                if (!errorObject) {
                    errorObject = {
                        status: code,
                        //errors: msg.error || msg.errors || msg,
                        error: standardErrorMessage || msg.error || msg,
                        message: msg.message || msg,
                        stack: msg.stack
                    }
                }

                var errOutput = null, output = errorObject.toString();
                if ( output == '[object Object]' ) {
                    errOutput = JSON.stringify(errorObject);
                } else {
                    errOutput = JSON.stringify(
                        {
                            status  : errorObject.status,
                            error   : output,
                            stack   : errorObject.stack || null
                        }
                    );
                }

                // console.error('[ BUNDLE ][ '+ bundleConf.bundle +' ][ Controller ] '+ req.method +' ['+res.statusCode +'] '+ req.url +'\n'+ errorObject);
                console.error('[ BUNDLE ][ '+ bundleConf.bundle +' ][ Controller ] '+ req.method +' ['+res.statusCode +'] '+ req.url +'\n'+ errOutput);
                return res.end(errOutput);
            } else {

                if ( errorObject && errorObject != 'null' && /object/i.test(typeof(errorObject)) ) {
                    console.error(req.method +' [ '+ errorObject.status +' ] '+ req.url + '\n'+ (errorObject.stack||errorObject.message) );
                }

                 // intercept none HTML mime types
                 var url                     = decodeURI(local.req.url) /// avoid %20
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
                    if (!ext) {
                        ext = 'html'
                    }
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
                    var eFilename               = null
                        , eData                 = null
                    ;
                    eData = {
                        isRenderingCustomError  : true,
                        bundle                  : bundle,
                        status                  : code || null,
                        //message                 : errorObject.message || msg || null,
                        pathname                : url
                    };

                    if ( errorObject ) {
                        eData = merge(errorObject, eData);
                    }

                    if ( typeof(msg) == 'object' ) {
                        if ( typeof(msg.stack) != 'undefined' ) {
                            eData.stack = msg.stack
                        }
                        if ( !eData.message && typeof(msg.message) != 'undefined' ) {
                            eData.message = msg.message
                        }
                    }
                    if (
                        code
                        // See: framework/${version}/core/status.code
                        && typeof(bundleConf.server.coreConfiguration.statusCodes[code]) != 'undefined'
                    ) {
                        eData.title = bundleConf.server.coreConfiguration.statusCodes[code];
                    }
                    // TODO - Remove this if not used
                    // if ( typeof(local.req.routing) != 'undefined' ) {
                    //     eData.routing = local.req.routing;
                    // }

                    if (typeof(bundleConf.content.templates._common.errorFiles[code]) != 'undefined') {
                        eFilename = bundleConf.content.templates._common.errorFiles[code];
                    } else {
                        eFilename = bundleConf.content.templates._common.errorFiles[eCode];
                    }

                    if (!local.options.isRenderingCustomError) {
                        var eRule = 'custom-error-page@'+ bundle;
                        var routeObj = bundleConf.content.routing[eRule];
                        routeObj.rule = eRule;
                        //routeObj.url = decodeURI(local.req.url);/// avoid %20
                        routeObj.param.title = ( typeof(eData.title) != 'undefined' ) ? eData.title : 'Error ' + eData.status;
                        routeObj.param.file = eFilename;
                        routeObj.param.error = eData;
                        routeObj.param.displayToolbar = self.isCacheless();
                        routeObj.param.isLocalOptionResetNeeded = true;


                        local.req.routing = routeObj;
                        local.req.params.errorObject = errorObject;
                        return self.renderCustomError(local.req, res, local.next);
                    }

                }

                // if (!errorObject) {
                //     errorObject = {
                //         status: code,
                //         //errors: msg.error || msg.errors || msg,
                //         error: standardErrorMessage || msg.error || msg,
                //         message: msg.message || msg,
                //         stack: msg.stack
                //     }
                // }
                var msgString = '<h1 class="status">Error '+ code +'.</h1>';

                console.error('[ BUNDLE ][ '+ local.options.conf.bundle +' ][ Controller ] `this.'+ req.routing.param.control +'(...)` ['+res.statusCode +'] '+ req.url);
                if ( typeof(msg) == 'object' ) {

                    if (msg.title) {
                        msgString += '<pre class="'+ eCode +' title">'+ msg.title +'</pre>';
                    }

                    if (msg.error) {
                        msgString += '<pre class="'+ eCode +' message">'+ msg.error +'</pre>';
                    }

                    if (msg.message) {
                        msgString += '<pre class="'+ eCode +' message">'+ msg.message +'</pre>';
                    }

                    if (msg.stack) {

                        if (msg.error) {
                            msg.stack = msg.stack.replace(msg.error, '')
                        }

                        if (msg.message) {
                            msg.stack = msg.stack.replace(msg.message, '')
                        }

                        msg.stack = msg.stack.replace('Error:', '').replace(' ', '');
                        msgString += '<pre class="'+ eCode +' stack">'+ msg.stack +'</pre>';
                    }

                } else {
                    // Generic error
                    var title = null, message = null, stack = null;;
                    if ( errorObject && typeof(errorObject) != 'undefined' && errorObject && typeof(errorObject.error) != 'undefined' ) {
                        title = errorObject.error
                    }
                    if (errorObject && typeof(errorObject) != 'undefined' && errorObject  && typeof(errorObject.message) != 'undefined' ) {
                        message = errorObject.message
                    }
                    if (errorObject && typeof(errorObject) != 'undefined' && errorObject  && typeof(errorObject.stack) != 'undefined' ) {
                        stack = errorObject.stack
                    }

                    if (title) {
                        msgString += '<pre class="'+ eCode +' title">'+ title +'</pre>';
                    }
                    if (message) {
                        msgString += '<pre class="'+ eCode +' message">'+ message +'</pre>';
                    }
                    if (stack) {
                        msgString += '<pre class="'+ eCode +' stack">'+ stack +'</pre>';
                    }
                }
                res.writeHead(code, { 'content-type': bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding } );
                // if ( isHtmlContent && hasCustomErrorFile ) {
                //     res.end(msgString);
                // } else {
                //if ( isHtmlContent && !hasCustomErrorFile ) {
                    res.end(msgString);
                //}

                return;
            }
        } else {
            if (typeof(next) != 'undefined')
                return next();
        }

        if ( stream && /http\/2/.test(protocol) ) {
            return stream.end();
        }

        return res.end();
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