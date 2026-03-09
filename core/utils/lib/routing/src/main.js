/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

//var ContextHelper = require('./context');

/**
 * Routing
 *
 * @package     Gina.Utils
 * @namespace   Gina.Utils.Lib.Routing
 * @author      Rhinostone <gina@rhinostone.com>
 * */

function Routing() {

    var self        = {};

    /**
     * @function getRoute
     *
     * @param {string} rule e.g.: <name>[@<bundle>]
     * @param {object} params
     *
     * @return {object} route
     * */
    self.getRoute = function(rule, params) {

        var config      = getContext('gina').config
            , bundle    = null;

        if ( /\@/.test(rule) ) {
            bundle = rule.split(/\@/)[1];
        } else {
            bundle    = config.bundle
        }

        var env     = config.env
        , routing   = config.getRouting(bundle, env);

        if ( typeof(routing[rule]) == 'undefined' ) {
            throw new Error('[ RoutingHelper::getRouting(rule, params) ] : `' +rule + '` not found !')
        }

        var route = JSON.parse(JSON.stringify(routing[rule]));
        var variable = null
        for (var p in route.param) {
            if ( /^:/.test(route.param[p]) ) {
                variable = route.param[p].substr(1);
                if ( typeof(params[variable]) != 'undefined') {
                    route.url = route.url.replace( new RegExp('(/:'+variable+'|/:'+variable+'$)', 'g'), '/'+ params[variable] );

                    if ( typeof(route.param.path) != 'undefined' && /:/.test(route.param.path) ) {
                        route.param.path = route.param.path.replace( new RegExp('(:'+variable+'/|:'+variable+'$)', 'g'), params[variable]);
                    }
                }
            }
        }

        if ( Array.isArray(route.url) ) {
            route.url = route.url[0]
        }

        return route

    };

    /**
     * Get route by url
     * N.B.: this will only work with rules declared with `GET` method property
     *
     * @function getRouteByUrl
     *
     * @param {string} url e.g.: /bundle/some/url/path or http
     * @param {string} [bundle] targeted bundle
     *
     * @return {object} route
     * */
    self.getRouteByUrl = function (url, bundle) {

        var matched         = false
            , pathname      = null
            , gnaCtx        = getContext('gina')
            , config        = gnaCtx.config
            , bundle        = ( typeof(bundle) != 'undefined' ) ? bundle : config.bundle
            , env           = config.env
            , router        = new gnaCtx.Router(env)
            , routing       = config.getRouting(bundle, env)
            , isRoute       = null
            , route         = null
            , isXMLRequest  = getContext().router.isProcessingXMLRequest
        ;

        var hostname    = config.envConf[bundle][env].hostname
            , uri       = config.envConf[bundle][env].server.webroot
            , prefix    = hostname + uri;

        pathname = url.replace( new RegExp('^'+ hostname), '');

        var request = {
            routing: {
                path: unescape(pathname)
            },
            method: 'GET',
            params: {}

        };

        out:
            for (var rule in routing) {
                if (typeof(routing[rule]['param']) == 'undefined')
                    break;

                if (routing[rule].bundle != bundle) continue;

                // this will only work with rules declared with `GET` method property
                if ( typeof(routing[rule].method) != 'undefined' && !/^get$/i.test(routing[rule].method) ) continue;

                //Preparing params to relay to the router.
                params = {
                    method              : routing[rule].method || 'GET',
                    requirements        : routing[rule].requirements,
                    namespace           : routing[rule].namespace || undefined,
                    url                 : unescape(pathname), /// avoid %20
                    rule                : routing[rule].originalRule || rule,
                    param               : routing[rule].param,
                    middleware          : routing[rule].middleware,
                    bundle              : routing[rule].bundle,
                    isXMLRequest        : isXMLRequest
                };

                //Parsing for the right url.
                try {
                    isRoute = router.compareUrls(request, params, routing[rule].url);
                } catch (err) {
                    throw new Error('Rule [ '+rule+' ] needs your attention.\n' + err.stack);
                    break;
                }

                if (isRoute.past) {

                    route = JSON.parse(JSON.stringify(routing[rule]));

                    matched = true;
                    isRoute = {};
                    break out;

                }
            }

        if (!matched) {
            throw new Error('[ RoutingHelper::getRouteByUrl(rule[, bundle]) ] : route not found for url: `' + url + '` !')
        } else {
            return route
        }

    }

    return self
};
module.exports = Routing()