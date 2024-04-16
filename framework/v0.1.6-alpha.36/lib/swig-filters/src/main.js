/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */


/**
 * SwigFilters
 * ------
 * Setup
 * ------
 * var filters = SwigFilters({
 *   options     : local.options,
 *   isProxyHost : isProxyHost,
 *   throwError  : self.throwError, // use ctx.throwError
 *   req         : local.req,
 *   res         : local.res
 * });
 * -----
 * Call
 * -----
 * swig.setFilter('getUrl', filters.getUrl);
 *
 *
 * @package     Gina.Lib
 * @namespace   Gina.Lib.SwigFilters
 * @author      Rhinostone <contact@gina.io>
 * */
function SwigFilters(conf) {

    var isGFFCtx    = ((typeof (module) !== 'undefined') && module.exports) ? false : true;

    if ( typeof(merge) == 'undefined' ) {
        var merge = null;
    }
    if ( !merge || typeof(merge) != 'function' ) {
        merge = require(_(GINA_FRAMEWORK_DIR+"/lib/merge", true));
    }
    if ( typeof(routing) == 'undefined' ) {
        var routing = null;
    }
    if ( !routing || typeof(routing) != 'function' ) {
        routing = require(_(GINA_FRAMEWORK_DIR+"/lib/routing", true));
    }

    var self = { options: conf };
    var init = function() {

        if ( typeof(SwigFilters.initialized) != 'undefined' ) {
            return getInstance()
        } else {

            SwigFilters.instance = self;

            if (self.options) {
                SwigFilters.instance._options = self.options;
            }

            SwigFilters.initialized = true;

            return SwigFilters.instance
        }
    }

    var getInstance = function() {
        if (conf) {
            self.options = SwigFilters.instance._options = JSON.clone(conf);
        }

        return SwigFilters.instance
    }

    self.getConfig = function() {
        return JSON.clone(self.options)
    }

    // Allows you to get a bundle web root
    self.getWebroot = function (input, obj) {

        var ctx  = SwigFilters.instance._options || self.options;

        var url     = null
            , prop  = self.options.envObj.getConf(obj, options.conf.env)
            , isProxyHost  = ( ctx.isProxyHost && /^true$/i.test(ctx.isProxyHost) ) ? true : (( typeof(process.gina.PROXY_HOSTNAME) != 'undefined' ) ? true : false)
        ;
        if ( isProxyHost ) {
            url = prop.server.scheme + '://'+ prop.host;
        } else {
            url = prop.server.scheme + '://'+ prop.host +':'+ prop.port[prop.server.protocol][prop.server.scheme];
        }

        if ( typeof(prop.server['webroot']) != 'undefined') {
            url += prop.server['webroot']
        }
        return url
    }

    // var getRouteDefinition = function(routingRules, rule, method) {
    //     var routeObject = null;
    //     for (r in routingRules) {
    //         if ( r == rule && routingRules[r].method.toLowerCase() == method.toLowerCase() ) {
    //             routeObject = routingRules[r];
    //             break;
    //         }
    //     }

    //     return routeObject;
    // }

    /**
     * getUrl filter
     *
     * Usage:
     *      <a href="{{ '/homepage' | getUrl() }}">Homepage</a>
     *      <a href="{{ 'users-add' | getUrl({ id: user.id }) }}">Add User</a>
     *      <a href="{{ 'users-edit' | getUrl({ id: user.id }) }}">Edit user</a>
     *      <a href="{{ 'users-get-empty' | getUrl({ id: '' }) }}">Get empty</a>
     *      <a href="{{ 'users-list' | getUrl(null, 'http://domain.com') }}">Display all users</a>
     *      <a href="{{ '/dashboard' | getUrl(null, 'admin') }}">Go to admin bundle's dashboard page</a>
     *      <a href="{{ 'home@admin' | getUrl() }}">Go to admin bundle's dashboard page</a>
     *
     *      // can also be used with standalone mode: will add webroot if current bundle is not master
     *      <script src="{{ '/js/vendor/modernizr-2.8.3.min.js' | getUrl() }}"></script>
     *      compiled as => <script src="/my-bundle/js/vendor/modernizr-2.8.3.min.js"></script>
     *
     * @param {string} route
     * @param {object} params - can't be left blank if base is required -> null if not defined
     * @param {string} [base] - can be a CDN, the http://domain.com or a bundle name
     *
     * @returns {string} relativeUrl|absoluteUrl - /sample/url.html or http://domain.com/sample/url.html
     * */
    self.getUrl = function (route, params, base) {

        //var ctx = SwigFilters().getConfig();
        //var ctx = self.options;
        if (typeof(params) == 'undefined') {
            params = {}
        }
        var ctx  = SwigFilters.instance._options || self.options;

        var config              = null
            , scheme            = null
            , hostname          = null
            , requestPort       = null
            , wroot             = null
            , wrootRe           = null
            , isStandalone      = null
            , isMaster          = null
            , isProxyHost       = ( ctx.isProxyHost && /^true$/i.test(ctx.isProxyHost) ) ? true : (( typeof(process.gina.PROXY_HOSTNAME) != 'undefined' ) ? true : false)
            , routingRules      = null
            , rule              = null
            , url               = NaN
            , urlStr            = null
            , method            = 'GET'
        ;


        if (ctx.options.method != 'undefined') {
            method = ctx.options.method
        }

        // if no route, returns current route
        if ( !route || typeof(route) == 'undefined') {
            route = ctx.options.rule
        }

        config = {};
        if (/\@/.test(route) && typeof(base) == 'undefined') {
            var r = route.split(/\@/);
            route = r[0].toLowerCase();
            base = config.bundle = r[1];
            r = null;
        } else {
            if (
                !/\@/.test(route)
                && !/\.(.*)$/.test(route)
                && typeof(base) == 'undefined'
            ) {
                base = config.bundle = ctx.options.conf.bundle;
            }
            // eg.: "/assets/img/common/header@2x.png"
            // Added comment on 2024-02-23
            // route = route.toLowerCase();
        }

        // setting default config
        config          = merge(config, ctx.options.conf);
        hostname        = '';
        //console.debug('web roooot ', SwigFilters.instance._options.conf.server.webroot);
        wroot           = config.server.webroot;
        isStandalone    = (config.bundles.length > 1) ? true : false;
        isMaster        = (config.bundles[0] === config.bundle) ? true : false;
        routingRules    = config.routing;


        if ( typeof(base) != 'undefined' ) {

            // if base is not an URL, must be a bundle
            if ( !/^(http|https)\:/.test(base) ) {
                var mainConf = getContext('gina').Config.instance;
                // is real bundle ?
                if ( mainConf.allBundles.indexOf(base) > -1 ) {
                    // config override
                    config          = mainConf.Env.getConf(base, mainConf.env);

                    // retrieve hostname, webroot & routingRules
                    hostname        = config.hostname + config.server.webroot;

                    scheme          = hostname.match(/^(https|http)/)[0];
                    requestPort = (ctx.req.headers.port||ctx.req.headers[':port']||parseInt(process.gina.PROXY_PORT));
                    var hostPort = config.hostname.match(/(\:d+\/|\:\d+)$/);
                    hostPort = (hostPort) ? ~~(hostPort[0].replace(/\:/g, '')) : config.port[config.server.protocol][config.server.scheme];
                    // Linking bundle B from bundle A wihtout proxy
                    var isSpecialCase = (
                            getContext('bundle') != config.bundle
                            && requestPort != hostPort
                            && ctx.req.headers[':host'] != process.gina.PROXY_HOST
                    ) ? true : false;

                    if (isSpecialCase) {
                        hostname = config.hostname
                        if (isProxyHost) {
                            hostname = scheme + '://'+ (process.gina.PROXY_HOST||ctx.req.headers.host||ctx.req.headers[':host']);
                        }
                    }

                    // rewrite hostname vs ctx.req.headers.host
                    if (
                        isProxyHost
                        && !isSpecialCase
                    ) {

                        hostname    = scheme + '://'+ (process.gina.PROXY_HOST||ctx.req.headers.host||ctx.req.headers[':host']);

                        if (
                            !/^(80|443)$/.test(requestPort)
                            && !new RegExp(requestPort+'$').test(hostname)
                        ) {
                            hostname += ':'+ requestPort;
                        }
                    }


                    config.bundle   = base;
                    isStandalone    = (mainConf.bundles.length > 1) ? true : false;
                    isMaster        = (mainConf.bundles[0] === config.bundle) ? true : false;

                } else {
                    ctx.throwError(ctx.res, 500, new Error('bundle `'+ base +'` not found: Swig.getUrl() filter encountered a problem while trying to compile base `'+base+'` and route `'+route+'`').stack)
                }
            } else {
                scheme = base.match(/^(https|http)/)[0];
            }
        }

        wrootRe = new RegExp('^'+ config.server.webroot);

        // is path ?
        if (/^\//.test(route)) {

            if ( !wrootRe.test(route) ) {
                route = config.server.webroot + route.substr(1);
                hostname =   hostname.replace(new RegExp( config.server.webroot +'$'), '')
            } else if (
                config.server.webroot != '/'
                && config.server.webroot != ''
            ) {
                route = route.substr(1)
            }

            return hostname + route;
        }

        // rules are now unique per bundle : rule@bundle
        rule = route + '@' + config.bundle;
        //var ruleObj = getRouteDefinition(routingRules, rule, method);
        try {
            url = routing.getRoute(route +'@'+ config.bundle, params);
            if (isProxyHost) {
                // url.proxy_hostname    = (hostname) ? url.hostname.replace(/(https|http)\:\/\/.*/, hostname) : url.hostname;
                url.proxy_hostname    = (isGFFCtx) ? window.location.protocol +'//'+ document.location.hostname : (process.gina.PROXY_HOSTNAME||config.envConf._proxyHostname);
                url.proxy_host        = url.hostname.replace(/(https|http)\:\/\//, '');
            }
            url = url.toUrl();

        } catch (routingErr) {
            url = '404:['+ ctx.req.method +']'+rule
        }


        // var ruleObj = routingRules[rule];
        // if ( typeof(ruleObj) != 'undefined' && ruleObj != null ) { //found

        //     url = ruleObj.url;

        //     if ( typeof(ruleObj.requirements) != 'undefined' ) {
        //         var urls    = null
        //             , i     = 0
        //             , len   = null
        //             , p     = null
        //         ;

        //         for (p in ruleObj.requirements) {

        //             if ( /\,/.test(url) ) {
        //                 urls = url.split(/\,/g);
        //                 i = 0; len = urls.length;
        //                 for (; i< len; ++i) {
        //                     if ( params && /:/.test(urls[i]) ) {
        //                         urlStr = urls[i].replace(new RegExp(':'+p+'(\\W|$)', 'g'), params[p]+'$1');
        //                         break
        //                     }
        //                 }

        //                 url = (urlStr != null) ? urlStr : urls[0];
        //             } else {
        //                 try {
        //                     url = url.replace(new RegExp(':'+p+'(\\W|$)', 'g'), params[p]+'$1')
        //                 } catch (err) {
        //                     ctx.throwError(ctx.res, 500, new Error('template compilation exception encoutered: [ '+ url +' ]\nsounds like you are having troubles with the following call `{{ "'+route+'" | getUrl() }}` where `'+p+'` parameter is expected according to your `routing.json`'  +'\n'+ (err.stack||err.message)));
        //                 }
        //             }
        //         }
        //     } else {
        //         if ( /\,/.test(url) ) {
        //             url = url.split(/\,/g)[0] || null; // just taking the default one: using the first element unless it is empty.
        //             if (!url) {
        //                 ctx.throwError(ctx.res, 500, new Error('please check your `routing.json` at the defined rule `'+ rule +'` : `url` attribute cannot be empty').stack)
        //             }
        //         }
        //     }


        //     if (hostname.length > 0) {
        //         url = url.replace(wrootRe, '');
        //     }

        //     // fix url in case of empty param value allowed by the routing rule
        //     // to prevent having a folder.
        //     // eg.: {..., id: '/^\\s*$/'} => {..., id: ''} => /path/to/ becoming /path/to
        //     if ( /\/$/.test(url) && url != '/' )
        //         url = url.substr(0, url.length-1);

        //     url = hostname + url;

        // } else {

        //     if ( typeof(routingRules['404@'+ config.bundle]) != 'undefined' && typeof(routingRules['404@'+ config.bundle].url) != 'undefined' ) {
        //         //url = ( /^\//.test(routingRules['404@'+ config.bundle].url) ) ? hostname + routingRules['404@'+ config.bundle].url.substr(1) : hostname + routingRules['404@'+ config.bundle].url;
        //         url = routingRules['404@'+ config.bundle].url.replace(wrootRe, '');
        //         if (hostname.length > 0) {
        //             url = url.replace(wrootRe, '');
        //         }
        //         url = hostname + url;
        //     } else {
        //         url = route;
        //         if (hostname.length > 0) {
        //             url = url.substr(1);
        //         }
        //         url = hostname + url
        //     }

        //     return '404:['+ ctx.req.method +']'+rule
        // }

        return url
    }

    // Extends default `length` filter
    self.length = function (input, obj) {

        if ( typeof(input.count) != 'undefined' ) {
            return input.count()
        } else {
            return input.length
        }
    }

    self.nl2br = function(text, replacement) {
        replacement = ( typeof( replacement ) != 'undefined' ) ? replacement : '<br/>';
        return text.replace(/(\n|\r)/g, replacement);
    }


    return init()

}

if ((typeof (module) !== 'undefined') && module.exports) {
    // Publish as node.js module
    module.exports = SwigFilters
} else if (typeof (define) === 'function' && define.amd) {
    // Publish as AMD module
    define(function() { return SwigFilters })
}