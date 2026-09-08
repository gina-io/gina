/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
const { execSync }  = require('child_process');


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

    // Setting up requirements - Gina toolbox
    // var ginaPath = execSync("which gina")
    //                             .toString()
    //                             .replace(/(\n|\r|\t)/g, '')
    //                             .replace(/\/bin\/gina/, '');

    // var help    = require(ginaPath + '/utils/helper.js');
    // var pack    = ginaPath + '/package.json';
    // pack = (isWin32()) ? pack.replace(/\//g, '\\') : pack;
    // pack = require(pack);

    // var frameworkPath   = ginaPath +'/framework/v'+ pack.version;
    // var helpers         = require(frameworkPath +'/helpers');
    // var lib             = require(frameworkPath +'/lib');

    // var merge   = lib.merge;
    // var rouging = lib.routing;


    if ( typeof(merge) == 'undefined' ) {
        merge = null;
    }
    if ( !merge || typeof(merge) != 'function' ) {
        merge = require(_(GINA_FRAMEWORK_DIR+"/lib/merge", true));
        // merge = lib.merge;
    }
    if ( typeof(routing) == 'undefined' ) {
        routing = null;
    }
    if ( !routing || typeof(routing) != 'function' ) {
        routing = require(_(GINA_FRAMEWORK_DIR+"/lib/routing", true));
        // routing = lib.routing;
    }
    // #I18N1 slice 2 — translation primitive backing the `t` filter.
    var i18n;
    if ( typeof(i18n) == 'undefined' || !i18n ) {
        i18n = require(_(GINA_FRAMEWORK_DIR+"/lib/i18n", true));
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
            // #P39 — stash by REFERENCE. The former per-call deep copy of the
            // whole wrapper (whose `.options` is the render's `local.options`,
            // itself already private per request — #M1) doubled the single
            // heaviest clone in the render profile for zero isolation gain:
            // `_options` is never written outside this assignment (the merge in
            // getUrl/getWebroot fills a fresh `{}` target and only READS this),
            // and `req`/`res` always passed by reference anyway (the cloner
            // bails on non-plain constructors). `self.options` is kept in the
            // chain for the boot-branch shape parity, but note `self` here is a
            // throwaway per-call object — `SwigFilters.instance` is what every
            // consumer reads.
            self.options = SwigFilters.instance._options = conf;
        }

        return SwigFilters.instance
    }

    self.getConfig = function() {
        return JSON.clone(self.options)
    }

    // #TPL1 Tier-2 — per-request filter context. The async render delegates
    // register the context-bearing filters ONCE on a shared per-bundle engine
    // and pass each request's { options, isProxyHost, throwError, req, res }
    // through process.gina._renderALS (an AsyncLocalStorage .run() wrap around
    // the awaited render). getUrl / getWebroot / t / tIcu read that store at
    // CALL time, so a single shared filter table cannot bleed one request's
    // context into another's interleaved async render (#B25). On the sync
    // render path the delegate never enters .run() -> getStore() is undefined
    // -> the per-request singleton (set by the per-request SwigFilters() call)
    // applies, byte-identical to pre-#TPL1.
    var getRenderCtx = function () {
        var _store = ( typeof(process) != 'undefined' && process.gina && process.gina._renderALS )
            ? process.gina._renderALS.getStore()
            : null;
        return _store || SwigFilters.instance._options || self.options;
    };

    /**
     * Resolve a bundle's absolute web root URL (scheme + host[:port] + webroot).
     *
     * Resolves the target bundle's env config via the global Config registry
     * (`getContext('gina').Config.instance.Env.getConf`) — the same lookup the
     * sibling `getUrl` filter uses. When `obj` is omitted, `Env.getConf` defaults
     * to the current bundle.
     *
     * @memberof SwigFilters
     * @param {string} input  - Pipe input (unused; templates pipe a placeholder)
     * @param {string} [obj]  - Bundle name; defaults to the current bundle
     * @returns {string} Absolute URL: `scheme://host[:port]/webroot`
     *
     * @example
     *   {{ '' | getWebroot() }}
     */
    self.getWebroot = function (input, obj) {

        var ctx  = getRenderCtx();

        // #B26 fix: the original line below threw on every invocation — `self.options`
        // is the per-request wrapper ({ options, isProxyHost, throwError, req, res }), so
        // `self.options.envObj` is undefined; and bare `options` was undeclared in this
        // scope. Resolve the bundle env config the same way the sibling getUrl filter
        // does, via the global Config registry.
        //     , prop  = self.options.envObj.getConf(obj, options.conf.env)
        var mainConf = getContext('gina').Config.instance;
        var url     = null
            , prop  = mainConf.Env.getConf(obj, mainConf.env)
            , isProxyHost  = ( ctx.isProxyHost && String(ctx.isProxyHost).toLowerCase() === 'true' ) ? true : (( typeof(process.gina.PROXY_HOSTNAME) != 'undefined' ) ? true : false)
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
        var ctx  = getRenderCtx();

        var config              = null
            , scheme            = null
            , hostname          = null
            , requestPort       = null
            , wroot             = null
            , wrootRe           = null
            , isStandalone      = null
            , isMaster          = null
            // #B152 — prefer THIS request's #B65 classification slot over the
            // ctx/worker-global latch: a port-less internal call (service-DNS
            // health probe, mesh hop, sibling-bundle request) classifies as
            // proxied and rewrites process.gina.PROXY_* mid-flight, so the latch
            // can reflect ANOTHER request's proxy context. Slot absent (req-less
            // render, slot-less engine path) -> legacy composite, byte-identical.
            , isProxyHost       = ( ctx.req && typeof(ctx.req._ginaIsProxyHost) != 'undefined' ) ? ( ctx.req._ginaIsProxyHost === true ) : ( ( ctx.isProxyHost && String(ctx.isProxyHost).toLowerCase() === 'true' ) ? true : (( typeof(process.gina) != 'undefined' && typeof(process.gina.PROXY_HOSTNAME) != 'undefined' ) ? true : false) )
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
        // #B511 — a route with a leading `/` is a PATH, never a rule reference, so it
        // must not enter the `rule@bundle` split: `'/assets/img/common/header@2x.png'`
        // used to be cut into rule `/assets/img/common/header` @ bundle `2x.png`, fail the
        // bundle lookup below and render a 500 mid-template (throwError renders, and
        // this site sits outside the routing try). A path that needs another bundle's
        // host passes it as the `base` argument; an in-string `@bundle` on a path is not
        // a supported form.
        if (!/^\//.test(route) && /\@/.test(route) && typeof(base) == 'undefined') {
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
                            hostname = scheme + '://'+ ((ctx.req && ctx.req._ginaProxyHost)||process.gina.PROXY_HOST||ctx.req.headers.host||ctx.req.headers[':host']);
                        }
                    }

                    // rewrite hostname vs ctx.req.headers.host
                    if (
                        isProxyHost
                        && !isSpecialCase
                    ) {

                        hostname    = scheme + '://'+ ((ctx.req && ctx.req._ginaProxyHost)||process.gina.PROXY_HOST||ctx.req.headers.host||ctx.req.headers[':host']);

                        // replaced: new RegExp(requestPort+'$') — use endsWith instead (#P5)
                        if (
                            requestPort !== '80' && requestPort !== '443' && requestPort !== 80 && requestPort !== 443
                            && !hostname.endsWith('' + requestPort)
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
                route = config.server.webroot + route.substring(1);
                hostname =   hostname.replace(new RegExp( config.server.webroot +'$'), '')
            } else if (
                config.server.webroot != '/'
                && config.server.webroot != ''
            ) {
                route = route.substring(1)
            }

            return hostname + route;
        }

        // rules are now unique per bundle : route@bundle
        rule = route + '@' + config.bundle;
        try {
            url = routing.getRoute(route +'@'+ config.bundle, params);
            // #B152 — getRoute stamps the route from the worker-global latch
            // (getContext('isProxyHost') + process.gina.PROXY_HOSTNAME); re-point
            // BOTH to THIS request's classification before toUrl(): a raw victim
            // flips to the config-host branch, a proxied victim emits its own
            // host — never the last port-less caller's. Slot absent -> legacy
            // latch/global, byte-identical.
            url.isProxyHost = isProxyHost;
            if (isProxyHost) {
                // #B168 — hold getRoute's own resolution: with no per-request slot and
                // no worker global, the override below must not replace a usable
                // envConf-derived value with an unset one
                var _routeProxyHostname = url.proxy_hostname;
                url.proxy_hostname    = (isGFFCtx) ? window.location.protocol +'//'+ document.location.hostname : ( (ctx.req && ctx.req._ginaProxyHostname) || process.gina.PROXY_HOSTNAME );
                url.proxy_host        = url.hostname.replace(/(https|http)\:\/\//, '');
                if ( !url.proxy_hostname ) {
                    url.proxy_hostname = _routeProxyHostname;
                    if ( !url.proxy_hostname ) {
                        // #B168 — nothing resolvable anywhere: degrade to the route's
                        // direct hostname; toUrl() keys on isProxyHost, so leaving it
                        // true would stringify the unset value into the emitted URL
                        url.isProxyHost = false;
                    }
                }
            }
            url = url.toUrl();

        } catch (routingErr) {
            url = '404:['+ ctx.req.method +']'+rule;
            console.error('[swig-filter] Routing Exception on route "', rule, '" \n', 'isProxy: '+ isProxyHost +'\n', 'process.gina.PROXY_HOSTNAME: '+ process.gina.PROXY_HOSTNAME +'\n' , routingErr.stack);
        }

        return url
    }

    // Extends default `length` filter
    self.length = function (input, obj) {

        // Match upstream nunjucks `runtime.length` / Jinja2: undefined or null → 0.
        // Without this guard, `typeof(input.count)` dereferences `.count` first
        // and throws on undefined — crashing any template that pipes a missing
        // variable through `| length`.
        if ( input == null ) {
            return 0
        }
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

    /**
     * Add or subtract hours from a date.
     * Mirrors helpers/dateFormat.js::addHours — registered here so Swig templates
     * can use {{ myDate | addHours(n) }}.
     *
     * @param {Date|string} input - date value piped from the template
     * @param {number} h - hours to add (negative to subtract)
     * @returns {Date}
     *
     * @example
     *   {{ post.publishedAt | addHours(2) | date('Y-m-d H:i') }}
     */
    self.addHours = function(input, h) {
        var d = (input instanceof Date) ? new Date(input.getTime()) : new Date(input);
        d.setHours(d.getHours() + h);
        return d;
    }

    /**
     * Add or subtract days from a date.
     * Mirrors helpers/dateFormat.js::addDays — registered here so Swig templates
     * can use {{ myDate | addDays(n) }}.
     *
     * @param {Date|string} input - date value piped from the template
     * @param {number} d - days to add (negative to subtract)
     * @returns {Date}
     *
     * @example
     *   {{ event.startDate | addDays(7) | date('Y-m-d') }}
     */
    self.addDays = function(input, d) {
        var copied = (input instanceof Date) ? new Date(input.getTime()) : new Date(input);
        copied.setHours(copied.getHours() + d * 24);
        return copied;
    }

    /**
     * Add or subtract years from a date.
     * Mirrors helpers/dateFormat.js::addYears — registered here so Swig templates
     * can use {{ myDate | addYears(n) }}.
     *
     * @param {Date|string} input - date value piped from the template
     * @param {number} y - years to add (negative to subtract)
     * @returns {Date}
     *
     * @example
     *   {{ user.birthDate | addYears(18) | date('Y-m-d') }}
     */
    self.addYears = function(input, y) {
        var d = (input instanceof Date) ? new Date(input.getTime()) : new Date(input);
        d.setFullYear(d.getFullYear() + y);
        return d;
    }

    /**
     * #I18N1 slice 2 — translate a key against the bundle's loaded i18n catalog.
     *
     * Auto-binds the request's culture from `req.culture` (slice 3 hook),
     * falling back to the process default `GINA_CULTURE` env var. Bundle
     * name is taken from the per-request `options.conf.bundle` slot.
     *
     * Identical surface to the nunjucks `t` filter so templates port between
     * engines unchanged.
     *
     * @memberof SwigFilters
     * @param   {string}      key      - Dotted-path key, e.g. `"common.welcome"`.
     * @param   {Object|null} [params] - Interpolation values. Pass `count` for
     *                                   CLDR plural-form selection.
     * @returns {string} Translated string, or the key verbatim when nothing
     *                   in the fallback chain matches.
     *
     * @example
     *   {{ "common.welcome"  | t }}
     * @example
     *   {{ "common.greeting" | t({ name: user.name }) }}
     * @example
     *   {{ "common.items"    | t({ count: 5 }) }}
     */
    self.t = function(key, params) {
        var ctx        = getRenderCtx();
        var culture    = (ctx && ctx.req && ctx.req.culture)
            ? ctx.req.culture
            : ((typeof getEnvVar === 'function' && getEnvVar('GINA_CULTURE')) || null);
        var bundleName = (ctx && ctx.options && ctx.options.conf && ctx.options.conf.bundle)
            ? ctx.options.conf.bundle
            : null;
        return i18n.t(key, params, culture, { bundleName: bundleName });
    }

    /**
     * #I18N2 — ICU MessageFormat opt-in template filter. Same auto-binding
     * shape as `self.t` (culture from `req.culture`, bundle from
     * `options.conf.bundle`) but the catalog string is interpreted as ICU
     * MessageFormat syntax (plural / select / gender / nested combinators)
     * via `intl-messageformat`. Catalog values that are NOT strings
     * (plural-form objects, nested categories) fall through to v1 `t()`.
     *
     * Identical surface to the nunjucks `tIcu` filter so templates port
     * between engines unchanged. Throws clearly if `intl-messageformat`
     * is not installed.
     *
     * @memberof SwigFilters
     * @param   {string}      key      - Dotted-path key.
     * @param   {Object|null} [params] - ICU MF placeholder values.
     * @returns {string}
     *
     * @example
     *   {{ "cart.itemCount" | tIcu({ count: 5 }) }}
     * @example
     *   {{ "user.greeting"  | tIcu({ gender: 'female', name: user.name }) }}
     */
    self.tIcu = function(key, params) {
        var ctx        = getRenderCtx();
        var culture    = (ctx && ctx.req && ctx.req.culture)
            ? ctx.req.culture
            : ((typeof getEnvVar === 'function' && getEnvVar('GINA_CULTURE')) || null);
        var bundleName = (ctx && ctx.options && ctx.options.conf && ctx.options.conf.bundle)
            ? ctx.options.conf.bundle
            : null;
        return i18n.tIcu(key, params, culture, { bundleName: bundleName });
    }


    return init()

}

if ((typeof (module) !== 'undefined') && module.exports) {

    // Loading logger
    if ( typeof(console.err) == 'undefined' ) {
        console = require('../../logger');
    }

    // Publish as node.js module
    module.exports = SwigFilters
} else if (typeof (define) === 'function' && define.amd) {
    // Publish as AMD module
    define(function() { return SwigFilters })
}