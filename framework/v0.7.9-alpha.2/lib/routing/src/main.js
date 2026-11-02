/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Routing
 *
 * @package     Gina.Lib
 * @namespace   Gina.Lib.Routing
 * @author      Rhinostone <contact@gina.io>
 * */

function Routing() {

    var isGFFCtx    = ((typeof (module) !== 'undefined') && module.exports) ? false : true;
    var self        = {
        allowedMethods: ['get', 'post', 'put', 'delete'],
        reservedParams: ['controle', 'file','title', 'namespace', 'path'],
        notFound: {}
    };

    /**
     * #B830 (2026-10-09) — render the control characters of a value (C0 U+0000-U+001F, DEL
     * and C1 U+007F-U+009F, the line separators U+2028 / U+2029) as visible escapes
     * (`\n`/`\r`/`\t`, else `\uXXXX`) before it is written into a log message, so a request
     * value substituted into a route URL cannot forge a physical log line (CWE-117).
     * Declared inside `Routing()`: this file is also in the browser bundle, where a
     * top-level function of the same name would meet the validator's copy.
     * `test/lib/log-escape-parity-b830.test.js` fails when a copy drifts.
     *
     * @inner
     * @private
     * @param   {*} value - Coerced with `String()`.
     * @returns {string} The value with its control characters shown as escapes.
     * @example
     * escapeLogControlChars('/a\nb'); // the five characters / a \ n b, on one physical line
     */
    function escapeLogControlChars(value) {
        return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, function (c) {
            switch (c) {
                case '\n': return '\\n';
                case '\r': return '\\r';
                case '\t': return '\\t';
                default:   return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
            }
        });
    }

    self.getInstance = function(params) {
        return Routing.instance;
    }


    if ( typeof(Routing.initialized) == 'undefined' ) {
        Routing.initialized     = true;
        Routing.instance        = self;
        // Warm route cache: routeId (`METHOD:pathname`) -> { name, routing }, kept in
        // insertion order — see self.cache() for the eviction rule.
        Routing._cached         = new Map();
    } else {
        self = self.getInstance();
        return self;
    }

    // Maximum number of distinct route IDs kept in the route cache.
    // When exceeded, the oldest entry (insertion order) is evicted first.
    var MAX_CACHED_ROUTES = 5000;

    /**
     * Own-property test for a lookup keyed by a name the client may choose (#B650). A plain
     * `obj[key]` read also resolves `Object.prototype` members, so a query key named
     * `toString` or `valueOf` read as a requirement the rule declares.
     *
     * `Object.prototype.hasOwnProperty.call`, not `Object.hasOwn`: this file is also bundled
     * for the browser.
     *
     * @inner
     * @private
     * @param {object} obj - the object to test (a rule's `requirements` or `param`)
     * @param {string} key - the key to look for
     * @returns {boolean} true when `obj` itself carries `key`
     *
     * @example
     * hasOwn({ id: '/^[0-9]+$/' }, 'id');       // => true
     * hasOwn({ id: '/^[0-9]+$/' }, 'toString'); // => false
     */
    var hasOwn = function(obj, key) {
        return obj !== null && typeof(obj) != 'undefined' && Object.prototype.hasOwnProperty.call(obj, key);
    };


    self.allowedMethodsString   = self.allowedMethods.join(',');



    // loading lib & plugins
    var plugins     = null
        , inherits  = null
        , merge     = null
        , Validator = null
        , fs        = null
        , promisify = null
    ;
    if (!isGFFCtx) {
        fs          = require('fs');
        promisify   = require('util').promisify;
        inherits    = require('../../inherits');
        merge       = require('../../merge');
        plugins     = require(__dirname+'/../../../core/plugins') || getContext('gina').plugins;
        Validator   = plugins.Validator;

    }
    // BO - In case of partial rendering whithout handler defined for the partial
    else {

        if ( !merge || typeof(merge) != 'function' ) {
            merge = require('lib/merge');
        }
        if ( !Validator || typeof(Validator) != 'function' ) {
            Validator = require('lib/form-validator');
        }
    }
    // EO - In case of partial rendering whithout handler defined for the partial

    /**
     * Get url props
     * Used to retrieve additional properties for routes with redirect flag for example
     *
     * @param {string} [bundle]
     * @param {string} [env]
     *
     * @returns {object} urlProps - { .host, .hostname, .webroot }
     */
    self.getUrlProps = function(bundle, env) {
        var config = null, urlProps = {}, _route = null;
        if (isGFFCtx) {
            // TODO - add support to get from env
            config = window.gina.config;
            // by default
            urlProps.hostname = config.hostname;
            if ( typeof(bundle) != 'undefined' ) {
                // get from webroot
                _route = this.getRoute('webroot@'+ bundle);
                urlProps.hostname   = _route.hostname;
                urlProps.host       = _route.host;
                urlProps.webroot    = _route.webroot;
            }
        } else {
            config = getContext('gina').config;
            if ( typeof(getContext('argvFilename')) != 'undefined' ) {
                config.getRouting = getContext('gina').Config.instance.getRouting
            }
            if ( typeof(bundle) == 'undefined' ) {
                bundle      = config.bundle;
            }
            if ( typeof(env) == 'undefined' ) {
                env      = config.env;
            }

            urlProps.hostname   = config.envConf[bundle][env].hostname;
            urlProps.host       = config.envConf[bundle][env].host;
            urlProps.webroot    = config.envConf[bundle][env].server.webroot;
        }

        return urlProps;
    }

    /**
     * Load bundle routing configuration
     *
     * @param {object} options
     *  {
     *      isStadalone: false,
     *      bundle: 'default',   // bundle's name
     *      wroot: '/',          // by default
     *
     *  }
     *
     */
    // self.loadBundleRoutingConfiguration = function(options, filename) {

    // }

    /**
     * Get routing
     *
     * @param {string} [bundle]
     */
    // self.getRouting = function(bundle) {

    // }

    /**
     * Get reversed routing
     *
     * @param {string} [bundle]
     */
    // self.getReverseRouting = function(bundle) {

    // }

    /**
     * Cache a matched route so that later requests with the same `METHOD:pathname`
     * take the warm path. One `Map`: a lookup and an eviction cost O(1) at any size.
     *
     * The first write to a key wins — a key already cached is left untouched, so a
     * key a legitimate request warmed keeps answering later requests. At
     * `MAX_CACHED_ROUTES` entries the OLDEST key is evicted first (FIFO by insertion
     * order; a hit never moves an entry). Only the rule's name and object are kept:
     * `params` and `methodParams` — the request's route params and data bag, a POST
     * body included — are accepted for the call signature and not stored.
     *
     * @param {string} routeId - `METHOD:pathname`, e.g. `GET:/index`
     * @param {string} name - route name
     * @param {object} routeObject - routing[name]
     * @param {object} [params] - the matched request's route params (not stored)
     * @param {object} [methodParams] - the matched request's data bag (not stored)
     * @returns {void}
     *
     * @example
     * routingLib.cache('GET:/invoice/42', 'invoice@api', routing['invoice@api']);
     */
    self.cache = function(routeId, name, routeObject, params, methodParams) {
        if ( !Routing._cached.has(routeId) ) {
            // FIFO eviction: when at capacity, drop the oldest entry before inserting
            if ( Routing._cached.size >= MAX_CACHED_ROUTES ) {
                self.invalidateCached( Routing._cached.keys().next().value );
            }
            Routing._cached.set(routeId, {
                name            : name,
                routing         : routeObject
            });
        }
    }

    /**
     * Look a request up in the warm route cache. A hit re-runs `compareUrls()`
     * against a clone of the cached rule, so requirements are re-evaluated on every
     * hit (#B422: an entry is a candidate; the verdict is the result's `.past`). A
     * miss returns `null` synchronously.
     *
     * @param {string} routeId - `METHOD:pathname`, e.g. `GET:/index`
     * @param {object} req - the incoming request
     * @returns {Promise<object>|null} `compareUrls()`'s result on a hit, `null` on a miss
     *
     * @example
     * var found = routingLib.getCached(req.method + ':' + pathname, req);
     * if ( found ) { found = await found; if ( found.past ) { dispatch(req.routing); } }
     */
    self.getCached = function(routeId, req) {
        var cachedRoute = Routing._cached.get(routeId);
        if ( cachedRoute ) {

            var method      = req.method.toLowerCase();


            // routeObject
            var routeObject       = JSON.clone(cachedRoute.routing);
            var params = {
                method              : method,
                requirements        : routeObject.requirements,
                namespace           : routeObject.namespace || undefined,
                url                 : safeDecodeURI(req.url), /// avoid %20 — #B30 malformed-%-safe
                rule                : routeObject.originalRule || cachedRoute.name,

                param               : routeObject.param,

                middleware          : routeObject.middleware,
                bundle              : routeObject.bundle,
                isXMLRequest        : req.isXMLRequest,
                isWithCredentials   : req.isWithCredentials
            };
            if ( typeof(routeObject.rule) == 'undefined' && typeof(params.rule) != 'undefined' ) {
                routeObject.rule = params.rule;
            }
            if ( typeof(routeObject.cache) != 'undefined' ) {
                params.cache = routeObject.cache;
            }
            // #CSRF2 — propagate per-route Csrf opt-out to req.routing.csrfExempt
            if ( typeof(routeObject.csrfExempt) != 'undefined' ) {
                params.csrfExempt = routeObject.csrfExempt;
            }
            // #I18N1 slice 3 — propagate per-route culture-prefix flag to
            // req.routing.culturePrefix. When true, the negotiator at the
            // request-pipeline boundary reads req.routing.param.culture as
            // the highest-priority culture source (URL prefix).
            if ( typeof(routeObject.culturePrefix) != 'undefined' ) {
                params.culturePrefix = routeObject.culturePrefix;
            }
            if ( typeof(routeObject.queryTimeout) != 'undefined' ) {
                params.queryTimeout = parseTimeout(routeObject.queryTimeout);
            }
            // #SPA1 — propagate the per-route content-negotiation capability to
            // req.routing.negotiate (top-level, NOT req.routing.param.* — the #CSRF2
            // trap). Assigned only when declared, so a routing.json that never mentions
            // `negotiate` produces a byte-identical params object.
            if ( typeof(routeObject.negotiate) != 'undefined' ) {
                params.negotiate = routeObject.negotiate;
            }
            // #MS6 — propagate the per-route rate-limit override/exempt to
            // req.routing.rateLimit (top-level, NOT req.routing.param.* — the
            // #CSRF2 trap). typeof-guarded so `false` (exempt) survives the copy;
            // assigned only when declared, so a routing.json that never mentions
            // `rateLimit` produces a byte-identical params object.
            if ( typeof(routeObject.rateLimit) != 'undefined' ) {
                params.rateLimit = routeObject.rateLimit;
            }

            // #FIN6 — propagate the per-route idempotency opt-in to
            // req.routing.idempotency (top-level, NOT req.routing.param.* — the
            // #CSRF2 trap). typeof-guarded so `false` survives the copy;
            // assigned only when declared, so a routing.json that never
            // mentions `idempotency` produces a byte-identical params object.
            if ( typeof(routeObject.idempotency) != 'undefined' ) {
                params.idempotency = routeObject.idempotency;
            }

            // isRoute
            return self.compareUrls(params, routeObject.url, req);
        }

        return null
    }

    /**
     * Remove one key from the warm route cache; a key that is not cached is a no-op.
     *
     * @param {string} routeId - `METHOD:pathname`
     * @returns {void}
     *
     * @example
     * routingLib.invalidateCached('GET:/invoice/42');
     */
    self.invalidateCached = function(routeId) {
        Routing._cached.delete(routeId);
    }

    /**
     * Compare urls
     *
     * @param {object} params - Route params containing the given url to be compared with
     * @param {string|array} url - routing.json url
     * @param {object} [request]
     * @param {object} [response] - only used for query validation
     * @param {object} [next] - only used for query validation
     *
     * @returns {object|false} foundRoute
     * */
    self.compareUrls = async function(params, url, request, response, next) {

        if ( typeof(request) == 'undefined' ) {
            request = { routing: {} };
        }
        // Sample debug break for specific rule
        // if ( params.rule == 'my-specific-rule@bundle' ) {
        //     console.debug('passed '+ params.rule);
        // }
        if ( /\,/.test(url) ) {
            var i               = 0
                , urls          = url.split(/\,/g)
                , len           = urls.length
                , foundRoute    = {
                    past: false,
                    request: request
                };


            while (i < len && !foundRoute.past) {
                foundRoute = await parseRouting(params, urls[i], request, response, next);
                ++i;
            }

            i       = null;
            urls    = null;
            len     = null;

            return foundRoute;
        }


        return await parseRouting(params, url, request, response, next);
    };


    /**
     * Check if rule has params
     *
     * @param {string} pathname
     * @returns {boolean} found
     *
     * @private
     * */
    var hasParams = function(pathname) {
        return (/\:/.test(pathname)) ? true : false;
    };

    /**
     * Parse routing for mathcing url
     *
     * A DELETE rule that declares `requirements` is matched here, by the DELETE branch, rather
     * than by `fitsWithRequirements`: each placeholder's regex is tested against its URL segment
     * — a placeholder without a requirement accepts any non-empty segment (#B956) — and a matched
     * value is written to `request[method]` and, for a placeholder the rule binds in `param`, to
     * `request.params` (#B955).
     *
     * @param {object} params - `params` is the same `request.routing` that can be retried in controller with: req.routing
     * @param {string} url
     * @param {object} request
     * @param {object} [response] - Only used for query validation
     * @param {object} [next] - Only used for query validation
     *
     * @returns {object} foundRoute
     *
     * @example
     * // rule: { url: '/items/:id', method: 'DELETE', requirements: { id: '/^[0-9]+$/' }, param: { id: ':id' } }
     * // DELETE /items/42  =>  request.delete.id === '42' and request.params.id === '42'
     * */
    var parseRouting = async function(params, url, request, response, next) {

        // Sample debug break for specific rule
        // if ( params.rule == 'my-specific-rule@bundle' ) {
        //     console.debug('passed '+ params.rule);
        // }

        var paramUrlSplit = null;
        try {
            paramUrlSplit = params.url.split(/\//);
        } catch (paramUrlSplitErr) {
            console.warn(paramUrlSplitErr);
            paramUrlSplit = ['']
        }

        var uRe             = paramUrlSplit
            , uRo           = url.split(/\//)
            , uReCount      = 0
            , uRoCount      = 0
            , maxLen        = uRo.length
            , score         = 0
            , foundRoute    = {}
            , i             = 0
            , method        = request.method.toLowerCase()
        ;

        // Attaching routing description for this request
        var paramMethod = 'get'; // by default
        try {
            paramMethod = params.method.toLowerCase();
        } catch(methodErr) {}


        var hasAlreadyBeenScored = false;
        if (
            typeof(params.requirements) != 'undefined'
            && /get|delete/i.test(method)
            && typeof(request[method]) != 'undefined'
            ||
            // GET request is in fact in this case a DELETE request
            typeof(params.requirements) != 'undefined'
            && /get/i.test(method)
            && /delete/i.test(paramMethod)
        ) {
            if ( /get/i.test(method) && /delete/i.test(paramMethod) ) {
                method = paramMethod;
            }
            // `delete` methods don't have a body
            // So, request.delete is {} by default
            if ( /^(delete)$/i.test(method) && uRe.length === uRo.length ) {
                // just in case
                if ( typeof(request[method]) == 'undefined' ) {
                    request[method] = {};
                }
                for (let p = 0, pLen = uRo.length; p < pLen; p++) {
                    if (uRe[p] === uRo[p]) {
                        ++score;
                        continue;
                    }
                    let _key = uRo[p].substring(1);
                    // #B650 — a requirement counts only when the rule declares it itself.
                    // was: if ( typeof(params.requirements[_key]) == 'undefined' ) {
                    if ( !hasOwn(params.requirements, _key) || typeof(params.requirements[_key]) == 'undefined' ) {
                        // #B956 — a placeholder the rule declares no requirement for accepts any
                        // non-empty segment and scores, as fitsWithRequirements does on the GET
                        // path. It was skipped unscored, so a DELETE rule whose requirements cover
                        // only some of its placeholders never reached maxLen: it answered 404 on
                        // every request. A static segment that differs from the URL's is still
                        // skipped unscored (the `/^:/` test), so such a rule still does not match.
                        if ( /^:/.test(uRo[p]) && uRe[p] ) {
                            ++score;
                            request[method][_key] = uRe[p];
                            if ( hasOwn(params.param, _key) && typeof(request.params) != 'undefined' ) {
                                request.params[_key] = uRe[p];
                            }
                        }
                        continue;
                    }
                    let condition = params.requirements[_key];
                    let conditionFlags = '';
                    if ( /^\//.test(condition) ) {
                        // Strip the surrounding `/…/<flags>` delimiters to the bare pattern body.
                        // End index is lastIndexOf('/') (exclusive), NOT -1: the `-1` over-stripped
                        // the final body char, so a requirement ending `…)/i` (group-close right
                        // before the flag) lost its closing `)` → `new RegExp(condition)` threw
                        // "Invalid regular expression: Unterminated group", 500ing every DELETE
                        // dispatch that scanned it (a `…)$/i` requirement merely lost its `$` anchor).
                        // Preserve the trailing `/<flags>` too (the segment after the closing `/`)
                        // and pass it to new RegExp, mirroring the GET path (fitsWithRequirements):
                        // a requirement written `/.../i` now matches case-insensitively on DELETE as
                        // well. Previously the flags were dropped here, so DELETE matched
                        // case-sensitively while GET honoured them — a silent DELETE/GET mismatch.
                        conditionFlags = condition.substring(condition.lastIndexOf('/') + 1);
                        condition = condition.substring(1, condition.lastIndexOf('/'));
                    } else if ( /^validator\:\:/.test(condition) && await fitsWithRequirements(uRo[p], uRe[p], params, request, response, next) ) {
                        ++score;
                        continue;
                    }
                    if (
                        /^:/.test(uRo[p])
                        && typeof(condition) != 'undefined'
                        && new RegExp(condition, conditionFlags).test(uRe[p])
                    ) {
                        ++score;
                        request[method][uRo[p].substring(1)] = uRe[p];
                        // #B955 — the matched URL value reaches `request.params` too, as the GET
                        // path's `fitsWithRequirements` writes it, for a placeholder the rule binds
                        // in `param` (the same gate as there). This branch wrote `request[method]`
                        // alone, so `req.params.<key>` stayed unset on a DELETE route whose regex
                        // requirements cover its placeholders.
                        if ( hasOwn(params.param, _key) && typeof(request.params) != 'undefined' ) {
                            request.params[_key] = uRe[p];
                        }
                    }
                }
                hasAlreadyBeenScored = true;
            }

            // Sample debug break for specific rule
            // if ( params.rule == 'my-specific-rule@bundle' ) {
            //     console.debug('passed '+ params.rule);
            // }
            for (let p in request[method]) {
                // #B650 — `p` is a key the CLIENT chose, so only a requirement the rule itself
                // declares may count. A query key named like an Object.prototype member
                // (toString, valueOf, ...) read as a declared requirement, and each such key
                // replaced one leading URL segment below: a request reached a rule whose path
                // differs from its own, past any path-based control applied outside the rule.
                // was: if ( typeof(params.requirements[p]) != 'undefined' && uRo.indexOf(':' + p) < 0 ) {
                if ( hasOwn(params.requirements, p) && typeof(params.requirements[p]) != 'undefined' && uRo.indexOf(':' + p) < 0 ) {
                    uRo[uRoCount] = ':' + p;
                    ++uRoCount;

                    uRe[uReCount] = request[method][p];
                    ++uReCount;
                    if (!hasAlreadyBeenScored && uRe.length === uRo.length) {
                        ++maxLen;
                    }
                }
            }
        }


        // Sample debug break for specific rule
        // if ( params.rule == 'my-specific-rule@bundle' ) {
        //     console.debug('passed '+ params.rule);
        // }

        if (!hasAlreadyBeenScored && uRe.length === uRo.length) {

            for (; i < maxLen; ++i) {

                if (uRe[i] === uRo[i]) {
                    ++score;
                }
                else if (
                    score == i && hasParams(uRo[i])
                    && await fitsWithRequirements(uRo[i], uRe[i], params, request, response, next)
                ) {
                    ++score;
                }
            }
        }

        // This test is done to catch `validator::` rules under requirements
        if (
            typeof(params.requirements) != 'undefined'
            && method == params.method.toLowerCase()
            && !hasAlreadyBeenScored
            && score >= maxLen
        ) {

            var requiremements = Object.getOwnPropertyNames(params.requirements);
            var r = 0;
            // In order to filter variables
            var uRoVars = uRo.join(',').match(/\:[-_a-z0-9]+/g);
            // var uRoVarCount = (uRoVars) ? uRoVars.length : 0;
            while ( r < requiremements.length ) {
                // requirement name as `key`
                let key = requiremements[r];
                // if not listed, but still needing validation
                if (
                    typeof(params.param[ key ]) == 'undefined'
                    && /^validator\:\:/i.test(params.requirements[ key ])
                ) {
                    if (uRo.length != uRe.length) {
                        // r++;
                        // continue;
                        break;
                    }
                    // updating uRoVars
                    uRoVars = uRo.join(',').match(/\:[-_a-z0-9]+/g);
                    /**
                     * "requirements" : {
                     *      "email": "validator::{ isEmail: true, isString: [7] }"
                     *  }
                     *
                     * e.g.: result = new Validator('routing', _data, null, {email: {isEmail: true, subject: \"Anything\"}} ).isEmail().valid;
                     */
                    let regex = params.requirements[ key ];
                    let _data = {}, _ruleObj = {}, _rule = {};

                    try {
                        _ruleObj    = JSON.parse(
                        regex.split(/::/).splice(1)[0]
                            .replace(/([^\:\"\s+](\w+))\:/g, '"$1":') // { query: { validIf: true }} => { "query": { "validIf": true }}
                            .replace(/([^\:\"\s+](\w+))\s+\:/g, '"$1":') // note the space between `validIf` & `:` { query: { validIf : true }} => { "query": { "validIf": true }}
                        );
                    } catch (err) {
                        throw err;
                    }

                    // validator.query case
                    if (typeof(_ruleObj.query) != 'undefined' && typeof(_ruleObj.query.data) != 'undefined') {
                        _data = _ruleObj.query.data;
                        // filter _data vs uRoVars by removing from data those not present in uRoVars
                        for (let k in _data) {
                            if ( uRoVars.indexOf(_data[k]) < 0 ) {
                                delete _data[k]
                            }
                        }
                        for (let p = 0, pLen = uRo.length; p < pLen; p++) {
                            // :variable only
                            if (!/^\:/.test(uRo[p])) continue;

                            let pName = uRo[p].replace(/^\:/, '');
                            if ( pName != '' && typeof(uRe[p]) != 'undefined' ) {
                                _data[ pName ] = uRe[p];
                                // Updating params
                                if ( typeof(request.params[pName]) == 'undefined' ) {
                                    // Set in case if not found
                                    request.params[pName] = uRe[p];
                                }
                            }
                        }
                    }

                    // If validator.query has data, _data should inherit from request data
                    _data = merge(_data, JSON.clone(request[method]) || {} );
                    // This test is to initialize query.data[key] to null by default
                    if ( typeof(_data[key]) == 'undefined' ) {
                        // init default value for unlisted variable/param
                        _data[key] = null;
                    }

                    _rule[key]  = _ruleObj;
                    if (!isGFFCtx) {
                        _validator  = new Validator('routing', _data, null, _rule );
                    } else {
                        _validator  = new Validator(_data);
                    }

                    if (_ruleObj.count() == 0 ) {
                        console.error('Route validation failed '+ params.rule);
                        --score;
                        r++;
                        continue;
                    }
                    // for each validation rule
                    for (let rule in _ruleObj) {
                        // updating query.data
                        if (typeof(_ruleObj[rule].data) != 'undefined') {
                            _ruleObj[rule].data = _data;
                        }
                        let _result = null;
                        if (Array.isArray(_ruleObj[rule])) { // has args
                            _result = await _validator[key][rule].apply(_validator[key], _ruleObj[rule]);
                        } else {
                            _result = await _validator[key][rule](_ruleObj[rule], request, response, next);
                        }

                        //let condition = _ruleObj[rule].validIf.replace(new RegExp('\\$isValid'), _result.isValid);
                        // if ( eval(condition)) {
                        if ( !_result.isValid ) {
                            --score;
                            if ( typeof(_result.error) != 'undefined' ) {
                                throw _result.error;
                            }
                        }
                    }
                }
                r++
            }

            r               = null;
            uRoVars         = null;
            requiremements  = null;
        }

        foundRoute.past     = (score === maxLen) ? true : false;

        if (foundRoute.past) {
            // attaching routing description for this request
            //request.routing = params; // can be retried in controller with: req.routing
            // && replacing placeholders
            // #B877 — the route's placeholders take the values the route MATCHED: each URL segment,
            // and each query key a requirement of the rule validated (`request.params`), over the
            // request data. Fed the request data alone, a query or body key named like a URL-segment
            // placeholder replaced that segment in `param.file` after it had passed its requirement.
            // The #B833 guard in checkRouteParams still checks every value it fills.
            // was: request.routing = checkRouteParams(params, request[method]);
            request.routing = checkRouteParams(params, fillValuesOf(request[method], request.params));
            foundRoute.request  = request;
        }


        return foundRoute;
    };

    /**
     * Fits with requiremements
     * This is for server side use only
     * http://en.wikipedia.org/wiki/Regular_expression
     *
     * Before the requirement test, writes `urlVal` in place of the `urlVar` placeholder in
     * `params.param.path`, `.namespace` and `.title`, verbatim: through a function replacer,
     * so `$`-patterns in the value are not expanded (#B688). A `urlVal` that would escape as a
     * path component (`_isUnsafePathValue`) is not written into `.path` or `.namespace`: their
     * placeholder is left for checkRouteParams, whose #B833 guard rejects the value (#B883).
     *
     * @param {string} urlVar - the rule's URL segment, e.g. `:id`
     * @param {string} urlVal - the request's URL segment at the same position
     * @param {object} params - the per-request route description (its `param` is a per-request copy)
     * @param {object} request
     * @param {object} response
     * @param {function} next
     *
     * @returns {Promise<boolean>} `true` if it fits
     *
     * @example
     * // rule url `/user/:id`, param `{ title: 'User :id' }`, request `/user/$%60`
     * await fitsWithRequirements(':id', '$`', params, req, res, next); // params.param.title === 'User $`'
     *
     * @private
     * */
    var fitsWithRequirements = async function(urlVar, urlVal, params, request, response, next) {
        // Sample debug break for specific rule
        // if ( params.rule == 'my-specific-rule@bundle' ) {
        //     console.debug('passed '+ params.rule);
        // }
        //var isValid = new Validator('routing', { email: "contact@gina.io"}, null, {email: {isEmail: true}} ).isEmail().valid;
        var matched     = -1
            , _param    = urlVar.match(/\:\w+/g)
            , regex     = new RegExp(urlVar, 'g')
            , re        = null
            , flags     = null
            , key       = null
            , tested    = false

            , _validator    = null
            , _data         = null
            , _ruleObj      = null
            , _rule         = null
            , rule          = null
            , str           = null
            // request method
            , requestMethod        = request.method.toLowerCase()
        ;

        if (!_param.length) return false;

        // #B688 — the path, namespace and title rewrites take the URL value through a FUNCTION
        // replacer. A string replacement expanded `$`-patterns found in the value (`` $` `` the
        // text before the placeholder, `$&` the placeholder, `$'` the text after it, `$$` a `$`):
        // a request to `/user/$%60` turned `"title": "User :id"` into `User User `. The value is
        // now written verbatim, as the URL and `param.file` already were.
        // #B883 — a value that would escape as a path component (a `..` segment or a leading
        // separator, `_isUnsafePathValue`) is not written into `param.path` or `param.namespace`
        // here: the placeholder is left for checkRouteParams, whose #B833 guard rejects the value.
        // Written here, it reached both fields unchecked, from a URL segment or from a query key
        // that its requirement folds in as a segment. The value is tested before `regex.test()`:
        // a passing test moves this `g` regex's `lastIndex` past the match, and a skipped rewrite
        // would leave it there for the next field's test (only a replace() resets it).
        //  if custom path, path rewrite
        // was: if (params.param.path && regex.test(params.param.path)) {
        if (params.param.path && !_isUnsafePathValue(urlVal) && regex.test(params.param.path)) {
            // was: params.param.path = params.param.path.replace(regex, urlVal);
            params.param.path = params.param.path.replace(regex, function () { return urlVal; });
        }

        //  if custom namespace, namespace rewrite
        // was: if (params.param.namespace && regex.test(params.param.namespace)) {
        if (params.param.namespace && !_isUnsafePathValue(urlVal) && regex.test(params.param.namespace)) {
            // was: params.param.namespace = params.param.namespace.replace(regex, urlVal);
            params.param.namespace = params.param.namespace.replace(regex, function () { return urlVal; });
        }

        //  if custom file, file rewrite
        // if (params.param.file && regex.test(params.param.file)) {
        //     params.param.file = params.param.file.replace(regex, urlVal);
        // }
        // #B877 — `param.file` is not rewritten here: checkRouteParams fills it once the route has
        // matched, from the values the route matched (see parseRouting), behind the #B833 guard.
        // The block below never matched, because `urlVar` already starts with `:` and its pattern
        // read `::name`; fixing that pattern instead would fill `param.file` before the guard sees
        // the value.
        // was: if ( typeof(params.param.file) != 'undefined' && /\:/.test(params.param.file)) {
        // was:     var _regex = new RegExp('(:'+urlVar+'/|:'+urlVar+'$)', 'g');
        // was:     replacement.variable = urlVal;
        // was:     params.param.file = params.param.file.replace( _regex, replacement );
        // was:     _regex = null;
        // was: }

        //  if custom title, title rewrite (#B688: a function replacer, as for the path above)
        if (params.param.title && regex.test(params.param.title)) {
            // was: params.param.title = params.param.title.replace(regex, urlVal);
            params.param.title = params.param.title.replace(regex, function () { return urlVal; });
        }


        if (_param.length == 1) { // fast one

            re = new RegExp( _param[0]);
            matched = (_param.indexOf(urlVar) > -1) ? _param.indexOf(urlVar) : false;

            if (matched === false ) {
                // In order to support rules defined like :
                //      { params.url }  => `/section/:name/page:number`
                //      { request.url } => `/section/plante/page4`
                //
                //      with keys = [ ":name", ":number" ]

                if ( urlVar.match(re) ) {
                    matched = 0;
                }
            }


            if (matched === false) return matched;
            // filter on method
            if (params.method.toLowerCase() !== requestMethod) return false;

            if ( typeof(request[requestMethod]) == 'undefined' ) {
                request[requestMethod] = {}
            }

            key     = _param[matched].substring(1);

            // No requirements defined for this param — accept any non-empty segment
            // #B650 — a requirement or a param counts only when the rule declares it itself:
            // an inherited Object.prototype member is neither.
            // was: if ( typeof(params.requirements) == 'undefined' || typeof(params.requirements[key]) == 'undefined' ) {
            // was:     if ( typeof(params.param[key]) != 'undefined' && typeof(request.params) != 'undefined' && urlVal ) {
            if ( typeof(params.requirements) == 'undefined' || typeof(params.requirements[key]) == 'undefined' || !hasOwn(params.requirements, key) ) {
                if ( typeof(params.param[key]) != 'undefined' && hasOwn(params.param, key) && typeof(request.params) != 'undefined' && urlVal ) {
                    request.params[key] = urlVal;
                    if ( typeof(request[requestMethod][key]) == 'undefined' ) {
                        request[requestMethod][key] = urlVal;
                    }
                    return true;
                }
                return false;
            }

            // escaping `\` characters
            // TODO - remove comment : all regex requirement must start with `/`
            //regex   = ( /\\/.test(params.requirements[key]) ) ? params.requirements[key].replace(/\\/, '') : params.requirements[key];
            regex = params.requirements[key];
            if (/^\//.test(regex)) {
                re      = regex.match(/\/(.*)\//).pop();
                flags   = regex.replace('/' + re + '/', '');

                tested  = new RegExp(re, flags).test(urlVal)
            } else if ( /^validator\:\:/.test(regex) && urlVal) {
                /**
                 * "requirements" : {
                 *      "id" : "/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i",
                 *      "email": "validator::{ isEmail: true, isString: [7] }"
                 *  }
                 *
                 * e.g.: tested = new Validator('routing', _data, null, {email: {isEmail: true, subject: \"Anything\"}} ).isEmail().valid;
                 */
                _data = {}; _ruleObj = {}; _rule = {}; str = '';
                urlVar.replace( new RegExp('[^'+ key +']','g'), function(){ str += arguments[0] });
                _data[key]  = urlVal.replace( new RegExp(str, 'g'), '');
                try {
                    //_ruleObj    = JSON.parse(regex.split(/::/).splice(1)[0].replace(/([^\W+ true false])+(\w+)/g, '"$&"'));
                    _ruleObj    = JSON.parse(
                    regex.split(/::/).splice(1)[0]
                        .replace(/([^\:\"\s+](\w+))\:/g, '"$1":') // { query: { validIf: true }} => { "query": { "validIf": true }}
                        .replace(/([^\:\"\s+](\w+))\s+\:/g, '"$1":') // note the space between `validIf` & `:` { query: { validIf : true }} => { "query": { "validIf": true }}
                    );
                } catch (err) {
                    throw err;
                }
                //_ruleObj    = JSON.parse(regex.split(/::/).splice(1)[0].replace(/([^\W+ true false])+(\w+)/g, '"$&"'));
                if (typeof(_ruleObj.query) != 'undefined' && typeof(_ruleObj.query.data) != 'undefined') {
                    // since we only have one param
                    // :var1 == :var1
                    if ( urlVar == _ruleObj.query.data[ Object.keys(_ruleObj.query.data)[0] ] ) {
                        _ruleObj.query.data[ Object.keys(_ruleObj.query.data)[0] ] = _data[key];
                        // Set in case it is not found
                        request.params[key] = _data[key];
                    }
                }
                _rule[key]  = _ruleObj;
                _validator  = new Validator('routing', _data, null, _rule );
                if (_ruleObj.count() == 0 ) {
                    console.error('Route validation failed '+ params.rule);
                    return false;
                }
                for (let rule in _ruleObj) {
                    if (Array.isArray(_ruleObj[rule])) { // has args
                        await _validator[key][rule].apply(_validator[key], _ruleObj[rule]);
                    } else {
                        await _validator[key][rule](_ruleObj[rule], request, response, next);
                    }
                }
                tested = _validator.isValid();
            } else {
                tested = new RegExp(params.requirements[key]).test(urlVal);
            }

            // #B650 — the binding also requires the rule's OWN param and requirement
            // (was: the same test without the two hasOwn() terms).
            if (
                typeof(params.param[key]) != 'undefined' &&
                hasOwn(params.param, key) &&
                typeof(params.requirements) != 'undefined' &&
                typeof(params.requirements[key]) != 'undefined' &&
                hasOwn(params.requirements, key) &&
                typeof(request.params) != 'undefined' &&
                tested
            ) {
                request.params[key] = urlVal;
                if ( typeof(request[requestMethod][key]) == 'undefined' ) {
                    switch (urlVal) {
                        case 'null':
                            urlVal = null;
                            break;
                        case 'false':
                            urlVal = false;
                            break;
                        case 'true':
                        //case 'on':
                            urlVal = true;
                            break
                        default:
                            break;
                    }
                    request[requestMethod][key] = urlVal;
                }
                return true;
            }

        } else { // slow one

            // No requirements defined — multi-param routes without requirements are not matchable
            if ( typeof(params.requirements) == 'undefined' ) return false;

            // In order to support rules defined like :
            //      { params.url }  => `/section/:name/page:number`
            //      { request.url } => `/section/plante/page4`
            //
            //      with keys = [ ":name", ":number" ]

            var keys        = _param
                , tplUrl    = params.url
                , url       = request.url
                , values    = {}
                , strVal    = ''
                , started   = false
                , i         = 0
            ;

            for (var c = 0, posLen = url.length; c < posLen; ++c) {
                if (url.charAt(c) == tplUrl.charAt(i) && !started) {
                    ++i
                    continue
                } else if (strVal == '') { // start

                    started = true;
                    strVal += url.charAt(c);
                } else if (c > (tplUrl.indexOf(keys[0]) + keys[0].length)) {

                    regex = params.requirements[keys[0]];
                    urlVal = strVal.substring(0, strVal.length);

                    if (/^\//.test(regex)) {
                        re      = regex.match(/\/(.*)\//).pop();
                        flags   = regex.replace('/' + re + '/', '');

                        tested = new RegExp(re, flags).test(urlVal)

                    } else if ( /^validator\:\:/.test(regex) ) {
                        /**
                         * "requirements" : {
                         *      "id" : "/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i",
                         *      "email": "validator::{ isEmail: true, isString: [7] }"
                         *  }
                         *
                         * e.g.: tested = new Validator('routing', _data, null, {email: {isEmail: true}} ).isEmail().valid;
                         */
                        _data = {}; _ruleObj = {}; _rule = {}; str = '';
                        urlVar.replace( new RegExp('[^'+ key[0] +']','g'), function(){ str += arguments[0]  });
                        _data[key[0]]  = urlVal.replace( new RegExp(str, 'g'), '');
                        _ruleObj    = JSON.parse(regex.split(/::/).splice(1)[0].replace(/([^\W+ true false])+(\w+)/g, '"$&"'));
                        _rule[key[0]]  = _ruleObj;
                        _validator  = new Validator('routing', _data, null, _rule );

                        for (let rule in _ruleObj) {
                            if (Array.isArray(_ruleObj[rule])) { // has args
                                _validator[key[0]][rule].apply(_validator[key[0]], _ruleObj[rule])
                            } else {
                                _validator[key[0]][rule](_ruleObj[rule])
                            }
                        }
                        tested = _validator.isValid();
                    } else {
                        tested = new RegExp(params.requirements[key[0]]).test(urlVal)
                    }

                    if (tested) {
                        values[keys[0].substring(1)] = urlVal
                    } else {
                        return false
                    }

                    strVal = '';
                    started = false;
                    i = (tplUrl.indexOf(keys[0]) + keys[0].length);
                    c -= 1;

                    keys.splice(0, 1)
                } else {
                    strVal += url.charAt(c);
                    ++i
                }

                if (c == posLen - 1) {

                    regex = params.requirements[keys[0]];
                    urlVal = strVal.substring(0, strVal.length);

                    if (/^\//.test(regex)) {
                        re = regex.match(/\/(.*)\//).pop();
                        flags = regex.replace('/' + re + '/', '');

                        tested = new RegExp(re, flags).test(urlVal)

                    } else {
                        tested = new RegExp(params.requirements[key]).test(urlVal)
                    }

                    if (tested) {
                        values[keys[0].substring(1)] = urlVal
                    } else {
                        return false
                    }
                }
            }

            if (values.count() == keys.length) {
                key = null;
                for (key in values) {
                    switch (values[key]) {
                        case 'null':
                            values[key] = null;
                            break;
                        case 'false':
                            values[key] = false;
                            break;
                        case 'true':
                        //case 'on':
                            values[key] = true;
                            break
                        default:
                            break;
                    }
                    request.params[key] = values[key];
                }
                return true
            }
        }

        return false
    }

    /**
     * String.prototype.replace callback shared by the placeholder writers: returns
     * `replacement.variable`, plus the `/` the match consumed when the regex matched `:id/`.
     * A function replacer writes the value verbatim, where a string replacement would expand
     * `$`-patterns in it (#B688). Set `replacement.variable` right before each `.replace()`.
     *
     * @inner
     * @param {string} matched - the matched placeholder, `:id` or `:id/`
     * @returns {string|*} the value, with a trailing `/` when `matched` had one
     *
     * @example
     * replacement.variable = '42';
     * '/users/:id/edit'.replace(/(:id\/|:id$)/g, replacement); // '/users/42/edit'
     */
    var replacement = function(matched){
        return ( /\/$/.test(matched) ? replacement.variable+ '/': replacement.variable )
    };

    /**
     * #B833 — a route placeholder value coming from the REQUEST (checkRouteParams is fed
     * `request[method]`, which merges the query string and body) is substituted VERBATIM into
     * `param.file` / `param.path` / `param.namespace`, AFTER the route requirement was matched
     * against the URL segment. A query value of the same name therefore overrides a
     * requirement-validated URL segment and can carry `..` into the rendered template path
     * (CWE-22, the CVE-2023-25345 class the render delegates guard). This predicate flags a value
     * that would ESCAPE when used as a path component: a `..` path segment, or a leading path
     * separator (an absolute path, which `path.resolve` honours over the root). Developer-authored
     * static prefixes in `param.file` (e.g. `../shared/:template`, reaching a sibling namespace
     * directory) are NOT request values and are never tested here — only the substituted value is.
     * fitsWithRequirements consults it too, and leaves a flagged URL value out of its early
     * `param.path` / `param.namespace` rewrite, so the value reaches the guard (#B883).
     *
     * @inner
     * @param {*} value - the request-supplied placeholder value
     * @returns {boolean} true when the value would escape as a path component
     *
     * @example
     * _isUnsafePathValue('../../etc/passwd'); // true  (`..` segment)
     * _isUnsafePathValue('/etc/passwd');      // true  (leading separator — absolute path)
     * _isUnsafePathValue('estimate-add');     // false
     * _isUnsafePathValue('foo/bar');          // false (stays within the root once prefixed)
     */
    var _isUnsafePathValue = function(value){
        var v = (typeof value === 'string') ? value : String(value);
        return /(^|[\/\\])\.\.([\/\\]|$)/.test(v) || /^[\/\\]/.test(v);
    };

    /**
     * #B877 — the values checkRouteParams fills a MATCHED route's placeholders with, on the request
     * path: the request data (`request[method]`, query and body), overlaid by the values the route
     * matched (`request.params`: each URL segment, and each query key a requirement of the rule
     * validated). A query or body key named like a URL-segment placeholder therefore no longer
     * replaces that segment, and a placeholder the URL does not carry is still filled from the
     * request data.
     *
     * Own keys only, copied as data properties (the rule of the Express adapter's query copy,
     * #B666), so a key named `__proto__` stays an ordinary property of the copy and never reaches the
     * prototype setter. An `undefined` value is skipped, so it never hides a defined one. Neither
     * argument is modified.
     *
     * @inner
     * @param {object} [data] - the request data, `request[method]`
     * @param {object} [matched] - the values the route matched, `request.params`
     * @returns {object} a new plain object
     *
     * @example
     * fillValuesOf({ name: 'other', foo: '1' }, { name: 'page' }); // { name: 'page', foo: '1' }
     * fillValuesOf({ tpl: 'home' }, { 0: '/t' });                  // { tpl: 'home', 0: '/t' }
     */
    var fillValuesOf = function(data, matched) {
        var out = {}, sources = [data, matched], s = 0, k = null;
        for (; s < sources.length; ++s) {
            if ( !sources[s] || typeof(sources[s]) != 'object' ) continue;
            for (k in sources[s]) {
                if ( !hasOwn(sources[s], k) || typeof(sources[s][k]) == 'undefined' ) continue;
                Object.defineProperty(out, k, { value: sources[s][k], writable: true, enumerable: true, configurable: true });
            }
        }
        return out;
    };

    /**
     * checkRouteParams
     *
     * Fills the route's `:placeholders` from `params`: for each `param` entry declared as a
     * placeholder (`"id": ":id"`), writes `params.id` into `param.path`, `.title`,
     * `.namespace`, `.file` and the url. Every value goes through `replacement`, so it is
     * written verbatim (`$`-patterns are not expanded) and the `/` after a `:id/` placeholder
     * is kept (#B688).
     *
     * @inner
     * @param {object} route - the route to fill: a copy (getRoute clones the rule, the
     *   request path clones `param` per request)
     * @param {object} params - placeholder values, keyed by variable name (on the request path:
     *   the request data overlaid by the matched values, see fillValuesOf, #B877)
     * @return {object} route - updated route object
     *
     * @example
     * // param `{ id: ':id', path: '/users/:id/edit', title: 'User :id' }`
     * checkRouteParams(route, { id: '42' }); // param.path '/users/42/edit', param.title 'User 42'
     */
    var checkRouteParams = function(route, params) {
        var variable        = null
            , regex         = null
            , urls          = null
            , i             = null
            , len           = null
            , p             = null
        ;

        for (p in route.param) {
            if ( typeof(params) != 'undefined' && typeof(params[p]) == 'undefined' ) continue;

            if ( /^:/.test(route.param[p]) ) {
                variable = route.param[p].substring(1);

                if ( typeof(params) != 'undefined' && typeof(params[variable]) != 'undefined' ) {

                    regex = new RegExp('(:'+variable+'/|:'+variable+'$)', 'g');

                    // #B833 — fail closed BEFORE substituting: a request value that would escape as
                    // a path component must never fill a filesystem-path param (`file`/`path`/
                    // `namespace`). Only guard when THIS variable actually fills one of those (a `..`
                    // in a value that fills only `title`/`url` is harmless). A traversal attempt
                    // throws the same CVE-2023-25345 block the render delegates raise.
                    if ( _isUnsafePathValue(params[variable]) ) {
                        var _b833Ph = new RegExp(':' + variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:/|$)');
                        if (
                            ( typeof(route.param.file) != 'undefined'      && _b833Ph.test(route.param.file) )
                            || ( typeof(route.param.path) != 'undefined'      && _b833Ph.test(route.param.path) )
                            || ( typeof(route.param.namespace) != 'undefined' && _b833Ph.test(route.param.namespace) )
                        ) {
                            throw new Error('[CVE-2023-25345] Path traversal attempt blocked in route param `' + variable + '`');
                        }
                    }

                    // #B688 — path, title and namespace go through `replacement`, as `file` and the
                    // URL below already did. A string replacement expanded `$`-patterns found in the
                    // value (`` $` `` `$&` `$'` `$$`) and dropped the `/` this regex consumes:
                    // `/users/:id/edit` gave `/users/42edit`.
                    replacement.variable = params[variable];
                    if ( typeof(route.param.path) != 'undefined' && /\:/.test(route.param.path) ) {
                        // was: route.param.path = route.param.path.replace( regex, params[variable]);
                        route.param.path = route.param.path.replace( regex, replacement );
                    }
                    if (typeof (route.param.title) != 'undefined' && /\:/.test(route.param.title)) {
                        // was: route.param.title = route.param.title.replace( regex, params[variable]);
                        route.param.title = route.param.title.replace( regex, replacement );
                    }
                    if (typeof (route.param.namespace) != 'undefined' && /\:/.test(route.param.namespace)) {
                        // was: route.param.namespace = route.param.namespace.replace( regex, params[variable]);
                        route.param.namespace = route.param.namespace.replace( regex, replacement );
                    }
                    // file is handle like url replacement (path is like pathname)
                    if (typeof (route.param.file) != 'undefined' && /\:/.test(route.param.file)) {
                        replacement.variable = params[variable];
                        route.param.file = route.param.file.replace( regex, replacement );
                    }

                    if ( /\,/.test(route.url) ) {
                        urls = route.url.split(/\,/g);
                        i = 0; len = urls.length;
                        for (; i < len; ++i) {
                            replacement.variable = params[variable];
                            urls[i] = urls[i].replace( regex, replacement );
                        }
                        route.url = urls.join(',');
                    } else {
                        replacement.variable = params[variable];
                        route.url = route.url.replace( regex, replacement );
                    }
                }
            }
        }

        // #B374 — which url of a multi-url rule getRoute() composes is chosen there, on the rule's
        // own url (selectUrlIndex). The loop that chose it here read the FIRST url on every pass
        // (`rawUrls[0]`), so it always chose 0, and getRoute() let that 0 override the caller's
        // own urlIndex whenever a placeholder had been filled.
        // was: // Selecting url in case of multiple urls & optional requirmements
        // was: if ( urls ) {
        // was:     i = 0; len = urls.length;
        // was:     var rawUrlVars = null
        // was:         , rawUrlScore = null
        // was:         , rawUrls = rawRouteUrl.split(/\,/g)
        // was:         , pKey = null
        // was:         , lastScore = 0
        // was:     ;
        // was:     route.urlIndex = 0; // by default
        // was:     for (; i < len; ++i) {
        // was:         rawUrlScore = 0;
        // was:         rawUrlVars = rawUrls[0].match(/\:[-_a-z0-9]+/ig);
        // was:         if ( !rawUrlVars ) continue;
        // was:         p = 0;
        // was:         pLen = rawUrlVars.length;
        // was:         for (; p < pLen; p++) {
        // was:             pKey = rawUrlVars[p].substring(1);
        // was:             if ( typeof(params[ pKey ]) != 'undefined' && params[ pKey ] ) {
        // was:                 rawUrlScore++;
        // was:             }
        // was:         }
        // was:         // We just rely in params count for now
        // was:         if (rawUrlScore > lastScore) {
        // was:             lastScore = rawUrlScore;
        // was:             route.urlIndex = i;
        // was:         }
        // was:     }
        // was: }

        return route;
    }

    /**
     * selectUrlIndex
     *
     * #B374 — the url of a multi-url rule that getRoute() composes when the caller names none:
     * the first url whose placeholders all receive a value, preferring among those the url that
     * uses the most values; when no url is complete, the url that receives the most values. Ties
     * go to the first url, so a rule whose urls carry the same placeholders (one url per
     * language, for instance) keeps composing its first url. A placeholder receives a value
     * when its value is not `undefined`, the test the fill itself applies (checkRouteParams
     * writes `''` and `null` too).
     *
     * @inner
     * @param {string} rawUrl - the rule's own url, its urls separated by commas, before any value
     *   is filled in
     * @param {object} [params] - the values getRoute() fills in, keyed by placeholder name
     * @returns {number} index of the url to compose; `0` for a rule with a single url
     *
     * @example
     * selectUrlIndex('/logout/:timestamp,/logout', {});               // 1
     * selectUrlIndex('/logout/:timestamp,/logout', { timestamp: 9 });  // 0
     * selectUrlIndex('/s,/s/:ts', { ts: '12' });                        // 1
     * selectUrlIndex('/help,/aide', {});                                // 0
     */
    var selectUrlIndex = function(rawUrl, params) {
        var urls        = rawUrl.split(/\,/g)
            , best      = 0
            , bestDone  = -1
            , bestFill  = -1
            , names     = null
            , fill      = 0
            , done      = 0
            , value     = null
            , u         = 0
            , n         = 0
        ;
        for (; u < urls.length; ++u) {
            names   = urls[u].match(/\:[-_a-z0-9]+/ig) || [];
            fill    = 0;
            for (n = 0; n < names.length; ++n) {
                value = ( params ) ? params[ names[n].substring(1) ] : undefined;
                if ( typeof(value) != 'undefined' ) {
                    ++fill;
                }
            }
            done = ( fill === names.length ) ? 1 : 0;
            if ( done > bestDone || ( done === bestDone && fill > bestFill ) ) {
                best        = u;
                bestDone    = done;
                bestFill    = fill;
            }
        }
        return best;
    };

    /**
     * #B168 — once-per-process latch for the proxied-context degrade warning in
     * getRoute(): the resolver sits on the per-request hot path, so the abnormal
     * state is reported once rather than per call (under dev-mode hot-reload the
     * module re-evaluates, so the warning may reappear per reload cycle).
     * @private
     */
    var _proxyHostDegradeWarned = false;

    /**
     * Composes the url of a routing rule and returns the route object (`url`, `toUrl()`,
     * `request()`). The values in `params` fill the rule's `:placeholders`; on a GET rule, the
     * other values become query parameters.
     *
     * A rule with several urls (`"url": "/a/:id, /b/:id"`) composes one of them (#B374): the
     * one `urlIndex` names or, without `urlIndex`, the first url whose placeholders all receive
     * a value, preferring among those the url that uses the most values; when no url is
     * complete, the url that receives the most values. Ties go to the first url. A placeholder
     * receives a value when its value is not `undefined`.
     *
     * Query parameters, on a GET rule: a value whose key `param` declares, when the url composed
     * does not carry it (#B220): its placeholder, or a fixed value as written, is not in that url;
     * `requirements` does not keep such a value out. Then every other value that is neither
     * reserved, nor declared in the rule's `requirements`, nor already written into the path
     * (#B943). No value is appended twice (#B944).
     *
     * On the server, the proxied classification and proxy hostname come from the
     * REQUEST first (#B502): core/router.js fills `proxy` on the process.gina._reqALS
     * store that server.js handle() establishes for every request, so a direct
     * request builds direct URLs even after a port-less-Host request has written
     * the worker global. Only a req-less caller (boot, CLI, cron — no store) falls
     * back to the getContext('isProxyHost') latch — read as `false` when the latch
     * was never set (#B537), so route.isProxyHost is always a boolean — and the
     * worker global with an
     * envConf fallback; when neither holds a value the route degrades to its direct
     * hostname (route.isProxyHost is flipped false) instead of failing, and a
     * once-per-process warning is emitted.
     *
     * @function getRoute
     *
     * @param {string} rule e.g.: [ <scheme>:// ]<name>[ @<bundle> ][ /<environment> ]
     * @param {object} [params] - values for the rule's `:placeholders`; on a GET rule, the values left over are appended to `route.url` as query parameters, as described above (a rule with no `requirements` block is safe — the block is optional)
     * @param {number|string} [urlIndex] - for a rule with several urls, the 0-based index of the url to compose; a numeric string such as `"1"` is accepted. Ignored for a rule with a single url.
     *
     * @returns {object} route
     *
     * @throws {Error} when the rule is not found, or when `urlIndex` names no url of a rule with several urls
     *
     * @example
     * // "logout": { "url": "/logout/:timestamp, /logout", "param": { "control": "logout", "timestamp": ":timestamp" } }
     * routing.getRoute('logout@auth').url;                          // '/logout'
     * routing.getRoute('logout@auth', { timestamp: '9' }).url;       // '/logout/9'
     * routing.getRoute('logout@auth', { timestamp: '9' }, 1).url;    // '/logout?timestamp=9'
     *
     * @example
     * // "invoice": { "url": "/invoice/:id", "param": { "control": "get", "id": ":id" } }
     * routing.getRoute('invoice@frontend', { id: 'abc-123', tab: '2' }).url; // '/invoice/abc-123?tab=2'
     * */
    self.getRoute = function(rule, params, urlIndex) {

        var config = null, isProxyHost = false, _stProxy = null;
        if (isGFFCtx) {
            if (
                !window.location.port
                && window.location.hostname == window.gina.config.hostname.replace(/^(https|http|wss|ws)\:\/\//, '').replace(/\:\d+$/, '')
            ) {
                isProxyHost = true;
                window.gina.config.hostname = window.gina.config.hostname.replace(/^(https|http|wss|ws)\:\/\//, '').replace(/\:\d+$/, '')
            }
            config = window.gina.config;
        } else {

            config = getContext('gina').config;
            if ( typeof(getContext('argvFilename')) != 'undefined' ) {
                config.getRouting = getContext('gina').Config.instance.getRouting;
            }

            // #B502 — the request's own proxied classification first: core/router.js
            // fills `proxy` on the process.gina._reqALS store server.js handle()
            // establishes for every request. The worker-global latch below is the
            // fallback for req-less callers only (boot, CLI, cron) — it is monotonic
            // once any request has written process.gina.PROXY_HOSTNAME, so reading
            // it for a DIRECT request classified it as proxied and built its URLs
            // from another request's host.
            var _reqStore = ( process.gina && process.gina._reqALS ) ? process.gina._reqALS.getStore() : null;
            _stProxy    = ( _reqStore && _reqStore.proxy ) ? _reqStore.proxy : null;
            // #B537 — a req-less caller on a process that never set the latch (the
            // boot-time writer runs only when the proxy configuration resolved a
            // record for the running scope and env) read `undefined` here, so the
            // route carried a non-boolean isProxyHost that JSON.clone then flagged
            // as an authoring error on every clone. Coerce with the `|| false` idiom
            // the sibling readers of this latch use: the flag is always a boolean.
            isProxyHost = ( _stProxy ) ? _stProxy.isProxyHost : ( getContext('isProxyHost') || false );
        }

        var env         = config.env || GINA_ENV  // by default, takes the current bundle
            , envTmp    = null
            //, scheme    = null
            , bundle    = config.bundle // by default, takes the current bundle
        ;

        if ( !/\@/.test(rule) && typeof(bundle) != 'undefined' && bundle != null) {
            rule = rule.toLowerCase()
            rule += '@' + bundle
        }

        if ( /\@/.test(rule) ) {

            var arr = ( rule.replace(/(.*)\:\/\//, '') ).split(/\@/);

            bundle  = arr[1];

            // getting env
            if ( /\/(.*)$/.test(rule) ) {
                envTmp  = ( rule.replace(/(.*)\:\/\//, '') ).split(/\/(.*)$/)[1];
                bundle  = bundle.replace(/\/(.*)$/, '');
                env     = envTmp || env;
            }


            // getting scheme
            //scheme = ( /\:\/\//.test(rule) ) ? rule.split(/\:\/\//)[0] : config.bundlesConfiguration.conf[bundle][env].server.scheme;

            rule = arr[0].toLowerCase() +'@'+ bundle;
        }

        var routing = config.getRouting(bundle, env);
        // TODO- change the way it is done
        // var routing = null;
        // if ( config.bundle != bundle) {
        //     // We are going to try to retrieved an exposed route (single)
        //     routing = config.getRouting(rule, env);
        // } else {
        //     // We are getting the current bundle routing (all routes)
        //     routing = config.getRouting(bundle, env);
        // }


        // #B415 — client-side getRouting returns null BY DESIGN when nothing
        // matches (a {} table before the routing fetch lands, or a bundle with
        // no rules). The bare `routing[rule]` deref below then threw a context-
        // free TypeError ONE LINE ABOVE the #B132 diagnostic — so the degraded-
        // table case #B132 was built for was exactly the one it could never
        // report. Name the bundle and the likely cause instead.
        if ( !routing ) {
            throw new Error('[ RoutingHelper::getRoute(rule, params) ] : bundle `'+ bundle +'` has no routing table for rule `'+ rule +'` (client: routing config not loaded yet, or empty)')
        }
        if ( typeof(routing[rule]) == 'undefined' ) {
            // #B132 — name the bundle + its table size so a degraded/near-empty
            // table (e.g. a bundle whose routing config never loaded) is
            // tellable from a plain mistyped rule at the call site.
            throw new Error('[ RoutingHelper::getRouting(rule, params) ] : `' +rule + '` not found ! (bundle `'+ bundle +'` holds '+ Object.keys(routing).length +' rules)')
        }

        var route   = JSON.clone(routing[rule]);
        var msg     = null;
        route = checkRouteParams(route, params);

        route.isProxyHost = isProxyHost;
        if (isProxyHost) {
            if (isGFFCtx) {
                route.proxy_hostname  = window.location.protocol +'//'+ document.location.hostname;
            } else {
                route.proxy_hostname  = ( _stProxy && _stProxy.proxyHostname ) || process.gina.PROXY_HOSTNAME || config.envConf._proxyHostname;
                // console.debug("[getRoute#1]["+isProxyHost+"] process.gina.PROXY_HOSTNAME ("+ process.gina.PROXY_HOSTNAME  +") VS config.envConf._proxyHostname ("+ config.envConf._proxyHostname +")");
            }
            // #B168 — on the server, BOTH sources above are framework-produced falsy
            // states: the worker global is boot-set only from a proxy config carrying a
            // hostname (and otherwise first written by a proxied request), while the
            // envConf fallback is deliberately written null for a request classified
            // direct. With the worker-wide proxied latch true and both unset, the
            // unguarded rewrite below crashed every server-side getRoute() while the
            // state lasted. Degrade to the route's direct hostname instead — and flip
            // route.isProxyHost too: toUrl() keys on it, so leaving it true would
            // stringify the unset value straight into the emitted URL.
            if (route.proxy_hostname) {
                route.proxy_host      = route.proxy_hostname.replace(/^(https|http)\:\/\//, '');
            } else {
                delete route.proxy_hostname;
                route.isProxyHost = false;
                if (!_proxyHostDegradeWarned) {
                    _proxyHostDegradeWarned = true;
                    console.warn('[ RoutingHelper::getRoute() ] Proxied context is active but no proxy hostname is resolvable (worker global and envConf fallback both unset) - falling back to the route direct hostname. Warned once per process.');
                }
            }

        } else if (
            !isGFFCtx
            && typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
            // #B168 — the typeof gate admits a defined-but-falsy value (typeof null is
            // 'object'); require a truthy hostname before the rewrite below
            && process.gina.PROXY_HOSTNAME
        ) {
            route.proxy_hostname  = process.gina.PROXY_HOSTNAME;
            route.proxy_host      = route.proxy_hostname.replace(/^(https|http)\:\/\//, '');
            console.debug("[getRoute#2]["+isProxyHost+"] process.gina.PROXY_HOSTNAME ("+ process.gina.PROXY_HOSTNAME  +") VS config.envConf._proxyHostname ("+ config.envConf._proxyHostname +")");
        }

        if ( /\,/.test(route.url) ) {
            // #B374, #B946 — the url to compose is chosen on the rule's own url, before any value
            // is filled in: a filled url can carry a comma inside a value, which the split used to
            // read as a url boundary (`{ x: 'a,b' }` on `/o/:x` composed `/o/a`). The caller's
            // urlIndex wins; it used to be overridden by the 0 the fill always chose. An index that
            // names no url throws instead of composing `undefined`. Without one, selectUrlIndex()
            // chooses. Only the url chosen is filled, by the same checkRouteParams().
            // was: if ( typeof(route.urlIndex) != 'undefined' ) {
            // was:     urlIndex = route.urlIndex; // set by checkRouteParams(route, params)
            // was:     delete route.urlIndex;
            // was: }
            // was: urlIndex = ( typeof(urlIndex) != 'undefined' ) ? urlIndex : 0;
            // was: route.url = route.url.split(/,/g)[urlIndex];
            var _ruleUrls = routing[rule].url.split(/\,/g);
            if ( _ruleUrls.length > 1 ) {
                if ( typeof(urlIndex) != 'undefined' && urlIndex !== null ) {
                    var _index = ( typeof(urlIndex) == 'string' && /^\d+$/.test(urlIndex) ) ? parseInt(urlIndex, 10) : urlIndex;
                    if ( typeof(_index) != 'number' || _index % 1 !== 0 || _index < 0 || _index >= _ruleUrls.length ) {
                        throw new Error('[ RoutingHelper::getRoute(rule, params, urlIndex) ] : urlIndex `'+ urlIndex +'` names no url of rule `'+ rule +'`, which has '+ _ruleUrls.length +' urls');
                    }
                    urlIndex = _index;
                } else {
                    urlIndex = selectUrlIndex(routing[rule].url, params);
                }
                // #B947 — the placeholder bindings only (`"id": ":id"`), read on the rule's own param:
                // the first checkRouteParams() call above wrote the values into `path`, `title`,
                // `namespace` and `file`, so a placeholder bound under one of those keys
                // (`"file": ":file"`) no longer read as a binding on the route and stayed in the url.
                // Only `.url` is kept from this second fill.
                // was: var _bindings = {};
                // was: for (var _key in route.param) {
                // was:     if ( typeof(route.param[_key]) == 'string' && /^:/.test(route.param[_key]) ) {
                // was:         _bindings[_key] = route.param[_key];
                // was:     }
                // was: }
                var _bindings = {}, _ruleParam = routing[rule].param || {};
                for (var _key in _ruleParam) {
                    if ( typeof(_ruleParam[_key]) == 'string' && /^:/.test(_ruleParam[_key]) ) {
                        _bindings[_key] = _ruleParam[_key];
                    }
                }
                route.url = checkRouteParams({ url: _ruleUrls[urlIndex], param: _bindings }, params).url;
                // read by the query append below, which needs the url actually composed; removed there
                route.urlIndex = urlIndex;
            }
        }
        // fix url in case of empty param value allowed by the routing rule
        // to prevent having a folder.
        // eg.: {..., id: '/^\\s*$/'} => {..., id: ''} => /path/to/ becoming /path/to
        if ( /\/$/.test(route.url) && route.url != '/' )
            route.url = route.url.substring(0, route.url.length-1);

        // Completeting url with extra params e.g.: ?param1=val1&param2=val2
        if ( /GET/i.test(route.method) && typeof(params) != 'undefined' ) {
            var queryParams = '?'
                // #B220 — the url actually composed (the one chosen above), not every url of the
                // rule joined: a value whose placeholder sits only in another url of the rule was
                // skipped here and, when declared in `requirements`, dropped by the loop below.
                // was: , maskedUrl = routing[rule].url
                , maskedUrl = routing[rule].url.split(/\,/g)[ route.urlIndex || 0 ] || routing[rule].url
            ;

            // in route.rule params
            var extracted = [], i = 0;
            for (let r in route.param) {
                // #B220 — a placeholder is in the url only where the fill writes it: `:name` followed
                // by `/` or the end (checkRouteParams), so `:key` no longer matches inside `:keyXyz`.
                // was: if ( self.reservedParams.indexOf(r) > -1 || new RegExp(route.param[r]).test(maskedUrl) )
                if (
                    self.reservedParams.indexOf(r) > -1
                    || (
                        ( /^:/.test(route.param[r]) )
                            ? new RegExp('('+ route.param[r] +'/|'+ route.param[r] +'$)').test(maskedUrl)
                            : new RegExp(route.param[r]).test(maskedUrl)
                    )
                )
                    continue;
                if (typeof(params[r]) != 'undefined' ) {
                    queryParams += r +'='+ encodeRFC5987ValueChars(params[r])+ '&';
                    // #B944 — the loop below tests KEYS: record the key, not its value
                    // was: extracted[i] = params[r];
                    extracted[i] = r;
                    ++i;
                }
            }

            // extra params ( not declared in the rule, but added by getUrl() )
            for (let p in params) {
                if (
                    self.reservedParams.indexOf(p) > -1
                    // a rule that declares no `requirements` block composes with requirements: undefined —
                    // guard the deref (the fitsWithRequirements discipline) so getRoute(rule, extraParams)
                    // on such a GET route appends the query params instead of throwing
                    || ( route.requirements && typeof(route.requirements[p]) != 'undefined' )
                    || extracted.indexOf(p) > -1
                    // #B943 — a key bound to a placeholder of the url composed (`"id": ":id"`) is in
                    // the path already; an unbound one keeps travelling as a query parameter
                    || (
                        route.param
                        && typeof(route.param[p]) == 'string'
                        && /^:/.test(route.param[p])
                        && new RegExp('('+ route.param[p] +'/|'+ route.param[p] +'$)').test(maskedUrl)
                    )
                ) {
                    continue;
                }
                if ( typeof(params[p]) == 'object' ) {
                    queryParams += p +'='+ encodeRFC5987ValueChars(JSON.stringify(params[p])) +'&';
                } else {
                    queryParams += p +'='+ params[p] +'&';
                }
            }
            maskedUrl = null;
            extracted = null;
            i = null;

            if (queryParams.length > 1) {
                queryParams = queryParams.substring(0, queryParams.length-1);

                route.url += queryParams;
            }
            queryParams = null;
        }
        // #B374 — the index handed over by the url choice above is not part of the route returned
        delete route.urlIndex;

        // recommanded for x-bundle coms
        // leave `ignoreWebRoot` empty or set it to false for x-bundle coms
        route.toUrl = function (ignoreWebRoot) {

            var urlProps = null;
            // Slice 3 (#SPA1) — the client-served map ships the derived boolean
            // `isRedirect` instead of `param.control` (a dispatch key that stays
            // server-side); server-side routes still carry the full `param`, so
            // both forms are honoured. The `this.param &&` guard also keeps a
            // param-less route from throwing here.
            if ( this.isRedirect === true || /^redirect$/i.test(this.param && this.param.control) ) {
                urlProps = self.getUrlProps(this.bundle, (env||GINA_ENV));
            }

            var wroot       = this.webroot || urlProps.webroot
                , hostname  = ''+this.hostname || ''+urlProps.hostname
                , path      = ''+this.url
            ;
            if (this.isProxyHost) {
                hostname = ''+this.proxy_hostname;
            }

            this.url = (
                    typeof(ignoreWebRoot) != 'undefined'
                    && /^true$/i.test(ignoreWebRoot)
                ) ? path.replace( new RegExp('^'+ wroot), '/') : path.replace( new RegExp('^('+wroot +'|\/$)'), wroot);

            // this.url = (
            //     typeof(ignoreWebRoot) != 'undefined'
            //     && /^true$/i.test(ignoreWebRoot)
            // ) ? path.replace( new RegExp('\/'+ wroot), '/') : path;


            return hostname + this.url
        };

        /**
         * request current url
         * Attention: You should first try without an authentification middleware
         *
         * The callback is settled EXACTLY ONCE, on every outcome: a successful response,
         * a dial failure (ECONNREFUSED / EHOSTUNREACH / ENETUNREACH ...), a response stream
         * that dies mid-body, or a timeout. Without a callback the request is fire-and-forget
         * and a dial failure is reported with `console.warn` instead of being thrown.
         *
         * @param {boolean} [ignoreWebRoot]
         * @param {object} [options] - see: https://nodejs.org/api/https.html#https_new_agent_options
         *      @param {number} [options.timeout] - milliseconds; on expiry the request is destroyed
         *              and the callback settles with an Error carrying `code === 'ETIMEDOUT'`
         * @param {object} [_this] - current context: only used when `promisify`is used
         *
         * @callback {callback} [cb]
         *      @param {Error|string|boolean} err - an Error for transport failures, a string for a
         *              broken response stream, `false` on success
         *      @param {object|string} [data] - the response body, parsed when it is JSON
         *
         * @example
         *      route.request(false, { timeout: 5000 }, function (err, data) {
         *          if (err) { return handle(err); }
         *          use(data);
         *      });
         */
        route.request = function(ignoreWebRoot, options) {

            var cb = null, _this = null;
            if ( typeof(arguments[arguments.length-1]) == 'function' ) {
                cb = arguments[arguments.length-1];
            }
            if ( typeof(arguments[2]) == 'object' ) {
                _this = arguments[2];
            }

            var wroot       = this.webroot || _this.webroot
                , hostname  = this.hostname || _this.hostname
                , url       = ( typeof(ignoreWebRoot) != 'undefined' && ignoreWebRoot == true ) ? path.replace(wroot, '/') : this.url || _this.url
            ;

            if ( /^\//.test(url) ) {
                url = hostname + url;
            }

            var scheme = ( /^https/.test(hostname) ) ? 'https' : 'http';

            if (isGFFCtx) {
                var target = ( typeof(options) != 'undefined' && typeof(options.target) != 'undefined' ) ? options.target : "_self";
                window.open(url, target);
                return;
            }

            if ( typeof(options.agent) == 'undefined' ) {
                // See.: https://nodejs.org/api/http.html#http_class_http_agent
                // create an agent just for this request
                options.agent = false;
            }
            var agent = require(''+scheme);
            // #B442: every exit path settles the caller exactly once. Before this guard the
            // ClientRequest was discarded, so a dial failure had NO 'error' listener: a carved-out
            // code (e.g. ECONNREFUSED, see lib/proc.js) left the caller waiting forever with
            // nothing logged, and an uncarved one (ETIMEDOUT / EHOSTUNREACH / ENETUNREACH)
            // escalated to uncaughtException and took the bundle down via dismiss(pid,'SIGTERM').
            var settled = false;
            var settle = function (err, data) {
                if (settled) { return; }
                settled = true;
                cb(err, data);
            };
            var onAgentResponse = function(res) {

                var data = '', err = false;

                res.on('data', function (chunk) {
                    data += chunk;
                });
                res.on('error', function (error) {
                    // #B442: a response that dies mid-body never emits 'end', so assigning here
                    // and waiting for 'end' to deliver meant the caller was never settled at all.
                    err = 'route.request: response stream failed for ' + url;
                    if (error && typeof(error.stack) != 'undefined' ) {
                        err += '\n' + error.stack;
                    } else if ( typeof(error) == 'string' ) {
                        err += '\n' + error;
                    }
                    settle(err);
                });
                res.on('end', function () {
                    if (/^\{/.test(data) ) {
                        try {
                            data = JSON.parse(data);
                            if (typeof(data.error) != 'undefined') {
                                err = JSON.clone(data);
                                data = null;
                            }
                        } catch(parseError) {
                            err = parseError
                        }
                    }
                    if (err) {
                        settle(err);
                        return;
                    }

                    settle(false, data);
                    return;
                });
            }
            var req = null;
            if (cb) {
                req = agent.get(url, options, onAgentResponse);
                // #B442: the dial-failure path. Without this the 'error' event has no listener.
                req.on('error', function (error) {
                    settle(error);
                });
                // #B442: `options.timeout` reaches http(s).get and Node EMITS 'timeout' without
                // destroying the socket — and the request object used to be unreachable, so the
                // option looked like a workaround and did nothing. Honour it here.
                if ( options && typeof(options.timeout) != 'undefined' && options.timeout ) {
                    req.on('timeout', function () {
                        var e = new Error('route.request: timed out after ' + options.timeout + 'ms requesting ' + url);
                        e.code = 'ETIMEDOUT';
                        req.destroy(e);
                    });
                }
            } else {
                // just throw the request without waiting/handling response
                req = agent.get(url, options);
                // #B442: nobody is waiting, but an unhandled 'error' here is still an
                // uncaughtException — which is how a fire-and-forget call could kill the bundle.
                req.on('error', function (error) {
                    console.warn('[ ROUTING ] route.request: fire-and-forget request to ' + url + ' failed: ' + ( (error && error.message) ? error.message : error ));
                });
            }
            return;

        } // EO route.request()

        if (
            /\:/.test(route.url)
            // Avoiding : `/bundle/path?redirect=https://bundle-dev-scope-v1.docmain.com:3132/bundle/referrer-path`
            && !/\:d+\//.test(route.url)
            && !/\:\/\//.test(route.url)
        ) {
            var paramList = route.url
                                .match(/(\:(.*)\/|\:(.*)$)/g)
                                .map(function(el){  return el.replace(/\//g, ''); }).join(', ');
            // #B830 — `route.url` holds the request values already written into it, and the
            // list below is cut out of it: both are written with their control characters as
            // visible escapes, so neither can start a line of its own in the log
            // was: … param placeholder not defined: `' + route.url + '` !\n Check … [ '+ paramList +']';
            msg = '[ RoutingHelper::getRoute(rule[, bundle, method]) ] : route [ %r ] param placeholder not defined: `' + escapeLogControlChars(route.url) + '` !\n Check your route description to compare requirements against param variables [ '+ escapeLogControlChars(paramList) +']';
            msg = msg.replace(/\%r/, rule);
            var err = new Error(msg);
            console.warn( err );
            paramList = null;
            err = null;
            msg = null;
            // Do not throw error nor return here !!!
        }

        return route
    };

    // TODO - Remove this : deprecated && not used
    var getFormatedRoute = function(route, url, hash) {
        // fix url in case of empty param value allowed by the routing rule
        // to prevent having a folder.
        // eg.: {..., id: '/^\\s*$/'} => {..., id: ''} => /path/to/ becoming /path/to
        if ( /\/$/.test(url) && url != '/' )
            url = url.substring(0, url.length-1);
        // adding hash if found
        if (hash)
            url += hash;

        route.url = url;
        // recommanded for x-bundle coms
        // leave `ignoreWebRoot` empty or set it to false for x-bundle coms
        route.toUrl = function (ignoreWebRoot) {
            var wroot       = this.webroot
                , hostname  = this.hostname
                , path      = this.url
            ;

            this.url = ( typeof(ignoreWebRoot) != 'undefined' && ignoreWebRoot == true ) ? path.replace(wroot, '/') : path;

            return hostname + this.url
        };

        return route
    }

    /**
     * Get route by url
     * N.B.: this will only work with rules declared with `GET` method property
     *
     * Async since #B121: the underlying `compareUrls` machinery is async (it can
     * await `validator::` routing-requirement validation), and the historical
     * un-awaited call meant no rule could ever match — callers received the
     * `false` sentinel for every url. Await this method (or `.then()` it); the
     * old "unresolved promises" caveat that used to sit here was this defect.
     *
     * Browser context, on a miss (#B462): when a rendered `404:` marker or an
     * alternate-route lookup identifies the missing rule, the composed
     * "route not found inside your view" diagnostic is registered on the
     * notFound registry — keyed per rule, `count` incremented on repeats —
     * and emitted via `console.warn` on the FIRST sighting of each key.
     * Server context warns on every miss (unchanged).
     *
     * @function getRouteByUrl
     * @async
     *
     * @param {string} url e.g.: /webroot/some/url/path or http
     * @param {string} [bundle] targeted bundle
     * @param {string} [method] 2nd or 3rd -  request method (GET|PUT|PUT|DELETE) - GET is set by default
     * @param {object} [request]
     * @param {boolean} [isOverridingMethod] // will replace request.method by the provided method - Used for redirections
     *
     * @returns {Promise<object|boolean>} route - when route is found; `false` when not found
     *
     * @example
     *  // from an async context (e.g. a controller helper)
     *  var route = await lib.routing.getRouteByUrl('/myapp/landing', 'myapp', 'GET', req);
     *  if (route) { console.log(route.name, route.param); }
     * */

    self.getRouteByUrl = async function (url, bundle, method, request, isOverridingMethod) {

        if (
            arguments.length == 2
            && typeof(arguments[1]) != 'undefined'
            && arguments[1]
            && self.allowedMethods.indexOf(arguments[1].toLowerCase()) > -1
        ) {
            method = arguments[1];
            bundle = undefined;
        }
        var webroot             = null
            , route             = null
            , routing           = null
            , reverseRouting    = null
            , hash              = null // #section nav
            , hostname          = null
            , host              = null
        ;

        if ( /\#/.test(url) && url.length > 1 ) {
            var urlPart = url.split(/\#/);
            url     = urlPart[0];
            hash    = '#' + urlPart[1];

            urlPart = null;
        }

        // fast method
        if (
            arguments.length == 1
            && typeof(arguments[0]) != 'undefined'
        ) {
            if ( !/^(https|http)/i.test(url) && !/^\//.test(url)) {
                url = '/'+ url;
            }

            webroot = '/' + url.split(/\//g)[1];
            if (isGFFCtx) {
                reverseRouting  = gina.config.reverseRouting;
                routing         = gina.config.routing
            }
            // get bundle
            if ( typeof(reverseRouting[webroot]) != 'undefined' ) {
                var infos = routing[ reverseRouting[webroot] ];
                bundle      = infos.bundle;
                webroot     = infos.webroot;
                host        = infos.host;
                hostname    = infos.hostname;
                infos       = null;
            }
        }

        isOverridingMethod = ( typeof(arguments[arguments.length-1]) != 'boolean') ? false : arguments[arguments.length-1];

        var matched             = false
            , config            = null
            , env               = null
            , prefix            = null
            , pathname          = null
            , params            = null
            , isRoute           = null
            , foundRoute        = null
            , routeObj          = null
        ;



        var isMethodProvidedByDefault = ( typeof(method) != 'undefined' ) ? true : false;

        if (isGFFCtx) {
            config          = window.gina.config;
            bundle          = (typeof (bundle) != 'undefined') ? bundle : config.bundle;
            env             = config.env;
            routing         = config.routing || config.getRouting(bundle);
            reverseRouting  = config.reverseRouting;
            isXMLRequest    = ( typeof(isXMLRequest) != 'undefined' ) ? isXMLRequest : false; // TODO - retrieve the right value

            hostname        = hostname || config.hostname;
            webroot         = webroot || config.webroot;
            prefix          = hostname + webroot;

            request = {
                routing: {},
                method: method,
                params: {},
                url: url
            };
            if (bundle) {
                request.bundle = bundle;
            }
        } else {

            var gnaCtx      = getContext('gina');

            config          = gnaCtx.config;
            bundle          = (typeof (bundle) != 'undefined') ? bundle : config.bundle;
            env             = config.env;
            routing         = config.getRouting(bundle);



            hostname        = config.envConf[bundle][env].hostname;
            webroot         = config.envConf[bundle][env].server.webroot;
            prefix          = hostname + webroot;

            if ( !request ) {
                request = {
                    routing: {},
                    isXMLRequest: false,
                    method : ( typeof(method) != 'undefined' ) ? method.toLowerCase() : 'get',
                    params: {},
                    url: url
                }
            }
            if (isOverridingMethod) {
                request.method = method;
            }
            isXMLRequest    = request.isXMLRequest || false;
        }

        pathname    = url.replace( new RegExp('^('+ hostname +'|'+hostname.replace(/\:\d+/, '') +')' ), '');
        if ( typeof(request.routing.path) == 'undefined' )
            request.routing.path = safeDecodeURI(pathname); // #B30 malformed-%-safe
        method      = ( typeof(method) != 'undefined' ) ? method.toLowerCase() : 'get';

        if (isMethodProvidedByDefault) {
            // to handle 303 redirect like PUT -> GET
            request.originalMethod = request.method;

            request.method = method;
            request.routing.path = safeDecodeURI(pathname) // #B30 malformed-%-safe
        }
        // last method check
        if ( !request.method)
            request.method = method;

        //  getting params
        params = {};



        var paramsList = null;
        var re = new RegExp(method, 'i');
        var localMethod = null;
        // N.B.: this part of the code must remain identical to the one used in `server.js`
        out:
            for (var name in routing) {
                if (typeof (routing[name]['param']) == 'undefined')
                    break;

                // bundle filter
                if (routing[name].bundle != bundle) continue;

                // method filter
                localMethod = routing[name].method;
                if ( /\,/.test( localMethod ) && re.test(localMethod) ) {
                    localMethod = request.method
                }
                if (typeof (routing[name].method) != 'undefined' && !re.test(localMethod)) continue;

                //Preparing params to relay to the core/router.
                params = {
                    method              : localMethod,
                    requirements        : routing[name].requirements,
                    namespace           : routing[name].namespace || undefined,
                    url                 : safeDecodeURI(pathname), /// avoid %20 — #B30 malformed-%-safe
                    rule                : routing[name].originalRule || name,
                    // #B52-residual finding-2: clone so the matcher's in-place param substitution
                    // (fitsWithRequirements / checkRouteParams rewrite param.{path,namespace,file,title})
                    // does NOT mutate the shared config singleton — getRouteByUrl's `routing` is
                    // config.getRouting() (server-side) / gina.config.routing (client), both by reference.
                    // Mirrors server.js:4852 and the middleware clone on the next line.
                    //param             : routing[name].param,
                    param               : JSON.clone(routing[name].param),
                    //middleware: routing[name].middleware,
                    middleware          : JSON.clone(routing[name].middleware),
                    bundle              : routing[name].bundle,
                    isXMLRequest        : isXMLRequest
                };

                // normal case
                //Parsing for the right url.
                try {
                    // #B121 root cause — `compareUrls` is async (it can await `validator::`
                    // requirement validation), so the historical un-awaited call yielded a
                    // Promise whose `.past` is always undefined: no rule could EVER match
                    // server-side. Await it, and mirror the engine loop's exact-url
                    // fast-path so this block stays identical to `server.js` (see the
                    // N.B. above the loop).
                    // was: isRoute = self.compareUrls(params, routing[name].url, request);
                    // was: if (isRoute.past) {
                    isRoute = await self.compareUrls(params, routing[name].url, request);
                    if (pathname == routing[name].url || isRoute.past) {
                        route = JSON.clone(routing[name]);
                        route.name = name;
                        // #B52-residual finding-2: getRouteByUrl returns `route` (a fresh clone of the
                        // singleton), NOT the mutated `params`. Carry the per-request substituted param
                        // (rewritten on the private clone above) onto the returned route so the result is
                        // correct AND the singleton keeps its `:placeholder`(s) for the next request.
                        route.param = params.param;

                        matched = true;
                        isRoute = {};

                        break;
                    }

                } catch (err) {
                    throw new Error('Route [ ' + name + ' ] needs your attention.\n' + err.stack);
                }
            } //EO for break out

        if (!matched) {
            if (isGFFCtx) {
                var urlHasChanged = false;
                if (
                    url == '#'
                    && /GET/i.test(method)
                    && isMethodProvidedByDefault
                    || /^404\:/.test(url)
                ) {
                    url = location.pathname;
                    urlHasChanged = true;
                }

                if ( typeof(self.notFound) == 'undefined' ) {
                    self.notFound = {}
                }

                var notFound = null, msg = '[ RoutingHelper::getRouteByUrl(rule[, bundle, method]) ] : route [ %r ] is called but not found inside your view: `' + url + '` !';
                if ( gina.hasPopinHandler && gina.popinIsBinded ) {
                    notFound = gina.popin.getActivePopin().target.innerHTML.match(/404\:\[\w+\][a-z 0-9-_@]+/);
                } else {
                    notFound = document.body.innerHTML.match(/404\:\[\w+\][a-z 0-9-_@]+/);
                }

                notFound = (notFound && notFound.length > 0) ? notFound[0] : null;

                if ( notFound && isMethodProvidedByDefault && urlHasChanged ) {

                    var m = notFound.match(/\[\w+\]/)[0];

                    notFound = notFound.replace('404:'+m, m.replace(/\[|\]/g, '')+'::' );

                    msg = msg.replace(/\%r/, notFound.replace(/404\:\s+/, ''));

                    if (typeof(self.notFound[notFound]) == 'undefined') {
                        self.notFound[notFound] = {
                            count: 1,
                            message: msg
                        };
                        console.warn(msg); // #B462 — announce the composed diagnostic on the FIRST sighting of each key (the registry dedups repeats)
                    } else if ( isMethodProvidedByDefault && typeof(self.notFound[notFound]) != 'undefined' ) {
                        ++self.notFound[notFound].count;
                    }

                    return false
                }

                notFound = null;

                var altRule = gina.config.reverseRouting[url] || null;
                if (
                    !notFound
                    && altRule
                    && typeof(altRule) != 'undefined'
                    && altRule.split(/\@(.+)$/)[1] == bundle
                ) {

                    notFound = altRule;
                    if ( typeof(self.notFound[notFound]) == 'undefined' ) {

                        msg = msg.replace(/\%r/, method.toUpperCase() +'::'+ altRule);

                        self.notFound[notFound] = {
                            count: 1,
                            message: msg
                        };
                        console.warn(msg); // #B462 — re-enabled: emit once per new registry key
                    } else if ( isMethodProvidedByDefault && typeof(self.notFound[notFound]) != 'undefined' ) {
                        ++self.notFound[notFound].count;
                    }

                    return false
                }

                // forms
                // #B121 root-cause sibling — un-awaited async `compareUrls`: `altRoute`
                // was a Promise (truthy, `.past` undefined), so this not-found
                // bookkeeping branch could never run.
                // was: var altRoute = self.compareUrls(params, url, request) || null;
                var altRoute = ( await self.compareUrls(params, url, request) ) || null;
                if(altRoute.past && isMethodProvidedByDefault) {
                    notFound = method.toUpperCase() +'::'+ altRoute.request.routing.rule;
                    if ( typeof(self.notFound[notFound]) == 'undefined' ) {
                        msg = msg.replace(/\%r/, notFound);
                        // #B462 — the registry write was missing here, leaving the
                        // increment arm below unreachable; aligned with the sibling
                        // arms (create + emit once per key)
                        self.notFound[notFound] = {
                            count: 1,
                            message: msg
                        };
                        console.warn(msg); // #B462
                    } else {
                        ++self.notFound[notFound].count;
                    }

                    return false
                }
                return false
            }


            console.warn( new Error('[ RoutingHelper::getRouteByUrl(rule[, bundle, method, request]) ] : route not found for url: `' + url + '` !').stack );
            return false;
        } else {
            // fix url in case of empty param value allowed by the routing rule
            // to prevent having a folder.
            // eg.: {..., id: '/^\\s*$/'} => {..., id: ''} => /path/to/ becoming /path/to
            if ( /\/$/.test(url) && url != '/' )
                url = url.substring(0, url.length-1);
            // adding hash if found
            if (hash)
                url += hash;

            route.url = url;
            // recommanded for x-bundle coms
            // leave `ignoreWebRoot` empty or set it to false for x-bundle coms
            route.toUrl = function (ignoreWebRoot) {
                var wroot       = this.webroot
                    , hostname  = this.hostname
                    , path      = this.url
                ;

                this.url = ( typeof(ignoreWebRoot) != 'undefined' && ignoreWebRoot == true ) ? path.replace(wroot, '/') : path;

                return hostname + this.url
            };

            return route
        }
    }

    return self
}

if ((typeof (module) !== 'undefined') && module.exports) {

    // Loading logger
    if ( typeof(console.err) == 'undefined' ) {
        console = require('../../logger');
    }

    // Publish as node.js module
    module.exports = Routing();
} else if (typeof (define) === 'function' && define.amd) {
    // Publish as AMD module
    define('lib/routing', ['require', 'lib/form-validator', 'lib/merge'], function() {
        return Routing();
    });
}