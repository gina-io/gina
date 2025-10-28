/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2025 Rhinostone <contact@gina.io>
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
            console.debug("[self.getUrlProps][isProxyHost = "+ getContext('isProxyHost') +"] hostname ", config.envConf[bundle][env].hostname, vs, process.gina.PROXY_HOSTNAME);
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
     * @param {object} params - `params` is the same `request.routing` that can be retried in controller with: req.routing
     * @param {string} url
     * @param {object} request
     * @param {object} [response] - Only used for query validation
     * @param {object} [next] - Only used for query validation
     *
     * @returns {object} foundRoute
     *
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
                    if ( typeof(params.requirements[_key]) == 'undefined' ) {
                        continue;
                    }
                    let condition = params.requirements[_key];
                    if ( /^\//.test(condition) ) {
                        condition = condition.substring(1, condition.lastIndexOf('/')-1);
                    } else if ( /^validator\:\:/.test(condition) && await fitsWithRequirements(uRo[p], uRe[p], params, request, response, next) ) {
                        ++score;
                        continue;
                    }
                    if (
                        /^:/.test(uRo[p])
                        && typeof(condition) != 'undefined'
                        && new RegExp(condition).test(uRe[p])
                    ) {
                        ++score;
                        request[method][uRo[p].substring(1)] = uRe[p];
                    }
                }
                hasAlreadyBeenScored = true;
            }

            // Sample debug break for specific rule
            // if ( params.rule == 'my-specific-rule@bundle' ) {
            //     console.debug('passed '+ params.rule);
            // }
            for (let p in request[method]) {
                if ( typeof(params.requirements[p]) != 'undefined' && uRo.indexOf(':' + p) < 0 ) {
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
            request.routing = checkRouteParams(params, request[method]);
            foundRoute.request  = request;
        }


        return foundRoute;
    };

    /**
     * Fits with requiremements
     * This is for server side use only
     * http://en.wikipedia.org/wiki/Regular_expression
     *
     * @param {string} urlVar
     * @param {string} urlVal
     * @param {object} params
     *
     * @returns {boolean} true|false - `true` if it fits
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

        //  if custom path, path rewrite
        if (params.param.path && regex.test(params.param.path)) {
            params.param.path = params.param.path.replace(regex, urlVal);
        }

        //  if custom namespace, namespace rewrite
        if (params.param.namespace && regex.test(params.param.namespace)) {
            params.param.namespace = params.param.namespace.replace(regex, urlVal);
        }

        //  if custom file, file rewrite
        // if (params.param.file && regex.test(params.param.file)) {
        //     params.param.file = params.param.file.replace(regex, urlVal);
        // }
        // file is handle like url replacement (path is like pathname)
        if ( typeof(params.param.file) != 'undefined' && /\:/.test(params.param.file)) {
            var _regex = new RegExp('(:'+urlVar+'/|:'+urlVar+'$)', 'g');
            replacement.variable = urlVal;
            params.param.file = params.param.file.replace( _regex, replacement );
            _regex = null;
        }

        //  if custom title, title rewrite
        if (params.param.title && regex.test(params.param.title)) {
            params.param.title = params.param.title.replace(regex, urlVal);
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

            if (
                typeof(params.param[key]) != 'undefined' &&
                typeof(params.requirements) != 'undefined' &&
                typeof(params.requirements[key]) != 'undefined' &&
                typeof(request.params) != 'undefined' &&
                tested
            ) {
                request.params[key] = urlVal;
                if ( typeof(request[requestMethod][key]) == 'undefined' ) {
                    request[requestMethod][key] = urlVal;
                }
                return true;
            }

        } else { // slow one

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
                    request.params[key] = values[key];
                }
                return true
            }
        }

        return false
    }

    var replacement = function(matched){
        return ( /\/$/.test(matched) ? replacement.variable+ '/': replacement.variable )
    };
    var checkRouteParams = function(route, params) {
        var variable        = null
            , regex         = null
            , urls          = null
            , i             = null
            , len           = null
            , rawRouteUrl   = route.url
            , p             = null
            , pLen          = null
        ;
        for (p in route.param) {
            if ( typeof(params) != 'undefined' && typeof(params[p]) == 'undefined' ) continue;

            if ( /^:/.test(route.param[p]) ) {
                variable = route.param[p].substring(1);

                if ( typeof(params) != 'undefined' && typeof(params[variable]) != 'undefined' ) {

                    regex = new RegExp('(:'+variable+'/|:'+variable+'$)', 'g');


                    if ( typeof(route.param.path) != 'undefined' && /\:/.test(route.param.path) ) {
                        route.param.path = route.param.path.replace( regex, params[variable]);
                    }
                    if (typeof (route.param.title) != 'undefined' && /\:/.test(route.param.title)) {
                        route.param.title = route.param.title.replace( regex, params[variable]);
                    }
                    if (typeof (route.param.namespace) != 'undefined' && /\:/.test(route.param.namespace)) {
                        route.param.namespace = route.param.namespace.replace( regex, params[variable]);
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

        // Selecting url in case of multiple urls & optional requirmements
        if ( urls ) {
            i = 0; len = urls.length;
            var rawUrlVars = null
                , rawUrlScore = null
                , rawUrls = rawRouteUrl.split(/\,/g)
                , pKey = null
                , lastScore = 0
            ;
            route.urlIndex = 0; // by default
            for (; i < len; ++i) {
                rawUrlScore = 0;
                rawUrlVars = rawUrls[0].match(/\:[-_a-z0-9]+/ig);
                if ( !rawUrlVars ) continue;
                p = 0;
                pLen = rawUrlVars.length;
                for (; p < pLen; p++) {
                    pKey = rawUrlVars[p].substring(1);
                    if ( typeof(params[ pKey ]) != 'undefined' && params[ pKey ] ) {
                        rawUrlScore++;
                    }
                }
                // We just rely in params count for now
                if (rawUrlScore > lastScore) {
                    lastScore = rawUrlScore;
                    route.urlIndex = i;
                }
            }
        }

        return route;
    }

    /**
     * @function getRoute
     *
     * @param {string} rule e.g.: [ <scheme>:// ]<name>[ @<bundle> ][ /<environment> ]
     * @param {object} params
     * @param {number} [urlIndex] in case you have more than one url registered for the current route, you can select the one you want to use. Default is 0.
     *
     * @returns {object} route
     * */
    self.getRoute = function(rule, params, urlIndex) {

        var config = null, isProxyHost = false;
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

            isProxyHost = getContext('isProxyHost');
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

        if ( typeof(routing[rule]) == 'undefined' ) {
            throw new Error('[ RoutingHelper::getRouting(rule, params) ] : `' +rule + '` not found !')
        }

        var route   = JSON.clone(routing[rule]);
        var msg     = null;
        route = checkRouteParams(route, params);

        route.isProxyHost = isProxyHost;
        if (isProxyHost) {
            if (isGFFCtx) {
                route.proxy_hostname  = window.location.protocol +'//'+ document.location.hostname;
            } else {
                route.proxy_hostname  = process.gina.PROXY_HOSTNAME || config.envConf._proxyHostname;
                console.debug("[getRoute#1]["+isProxyHost+"] process.gina.PROXY_HOSTNAME ("+ process.gina.PROXY_HOSTNAME  +") VS config.envConf._proxyHostname ("+ config.envConf._proxyHostname +")");
            }
            route.proxy_host      = route.proxy_hostname.replace(/^(https|http)\:\/\//, '');

        } else if (
            !isGFFCtx
            && typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
        ) {
            route.proxy_hostname  = process.gina.PROXY_HOSTNAME;
            route.proxy_host      = route.proxy_hostname.replace(/^(https|http)\:\/\//, '');
            console.debug("[getRoute#2]["+isProxyHost+"] process.gina.PROXY_HOSTNAME ("+ process.gina.PROXY_HOSTNAME  +") VS config.envConf._proxyHostname ("+ config.envConf._proxyHostname +")");
        }

        if ( /\,/.test(route.url) ) {
            if ( typeof(route.urlIndex) != 'undefined' ) {
                urlIndex = route.urlIndex; // set by checkRouteParams(route, params)
                delete route.urlIndex;
            }
            urlIndex = ( typeof(urlIndex) != 'undefined' ) ? urlIndex : 0;
            route.url = route.url.split(/,/g)[urlIndex];
        }
        // fix url in case of empty param value allowed by the routing rule
        // to prevent having a folder.
        // eg.: {..., id: '/^\\s*$/'} => {..., id: ''} => /path/to/ becoming /path/to
        if ( /\/$/.test(route.url) && route.url != '/' )
            route.url = route.url.substring(0, route.url.length-1);

        // Completeting url with extra params e.g.: ?param1=val1&param2=val2
        if ( /GET/i.test(route.method) && typeof(params) != 'undefined' ) {
            var queryParams = '?'
                , maskedUrl = routing[rule].url
            ;

            // in route.rule params
            var extracted = [], i = 0;
            for (let r in route.param) {
                if ( self.reservedParams.indexOf(r) > -1 || new RegExp(route.param[r]).test(maskedUrl) )
                    continue;
                if (typeof(params[r]) != 'undefined' ) {
                    queryParams += r +'='+ encodeRFC5987ValueChars(params[r])+ '&';
                    extracted[i] = params[r];
                    ++i;
                }
            }

            // extra params ( not declared in the rule, but added by getUrl() )
            for (let p in params) {
                if (
                    self.reservedParams.indexOf(p) > -1
                    || typeof(route.requirements[p]) != 'undefined'
                    || extracted.indexOf(p) > -1
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

        // recommanded for x-bundle coms
        // leave `ignoreWebRoot` empty or set it to false for x-bundle coms
        route.toUrl = function (ignoreWebRoot) {

            var urlProps = null;
            if ( /^redirect$/i.test(this.param.control) ) {
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
         *
         * @param {boolean} [ignoreWebRoot]
         * @param {object} [options] - see: https://nodejs.org/api/https.html#https_new_agent_options
         * @param {object} [_this] - current context: only used when `promisify`is used
         *
         * @callback {callback} [cb] - see: https://nodejs.org/api/https.html#https_new_agent_options
         *      @param {object} res
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
            var onAgentResponse = function(res) {

                var data = '', err = false;

                res.on('data', function (chunk) {
                    data += chunk;
                });
                res.on('error', function (error) {
                    err = 'Failed to get mail content';
                    if (error && typeof(error.stack) != 'undefined' ) {
                        err += error.stack;
                    } else if ( typeof(error) == 'string' ) {
                        err += '\n' + error;
                    }
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
                        cb(err);
                        return;
                    }

                    cb(false, data);
                    return;
                });
            }
            if (cb) {
                agent.get(url, options, onAgentResponse);
            } else {
                // just throw the request without waiting/handling response
                agent.get(url, options);
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
            msg = '[ RoutingHelper::getRoute(rule[, bundle, method]) ] : route [ %r ] param placeholder not defined: `' + route.url + '` !\n Check your route description to compare requirements against param variables [ '+ paramList +']';
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
     * ATTENTION !!! Not fully working for frontend because of unresolved promises !!!!
     *
     * @function getRouteByUrl
     *
     * @param {string} url e.g.: /webroot/some/url/path or http
     * @param {string} [bundle] targeted bundle
     * @param {string} [method] 2nd or 3rd -  request method (GET|PUT|PUT|DELETE) - GET is set by default
     * @param {object} [request]
     * @param {boolean} [isOverridinMethod] // will replace request.method by the provided method - Used for redirections
     *
     * @returns {object|boolean} route - when route is found; `false` when not found
     * */

    self.getRouteByUrl = function (url, bundle, method, request, isOverridinMethod) {

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

        isOverridinMethod = ( typeof(arguments[arguments.length-1]) != 'boolean') ? false : arguments[arguments.length-1];

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
            routing         = routing || config.getRouting(bundle);
            reverseRouting  = reverseRouting || config.reverseRouting;
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
            if (isOverridinMethod) {
                request.method = method;
            }
            isXMLRequest    = request.isXMLRequest || false;
        }

        pathname    = url.replace( new RegExp('^('+ hostname +'|'+hostname.replace(/\:\d+/, '') +')' ), '');
        if ( typeof(request.routing.path) == 'undefined' )
            request.routing.path = decodeURI(pathname);
        method      = ( typeof(method) != 'undefined' ) ? method.toLowerCase() : 'get';

        if (isMethodProvidedByDefault) {
            // to handle 303 redirect like PUT -> GET
            request.originalMethod = request.method;

            request.method = method;
            request.routing.path = decodeURI(pathname)
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
                    url                 : decodeURI(pathname), /// avoid %20
                    rule                : routing[name].originalRule || name,
                    param               : routing[name].param,
                    //middleware: routing[name].middleware,
                    middleware          : JSON.clone(routing[name].middleware),
                    bundle              : routing[name].bundle,
                    isXMLRequest        : isXMLRequest
                };

                // normal case
                //Parsing for the right url.
                try {
                    isRoute = self.compareUrls(params, routing[name].url, request);
                    if (isRoute.past) {
                        route = JSON.clone(routing[name]);
                        route.name = name;

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
                        //console.warn(msg);
                    } else if ( isMethodProvidedByDefault && typeof(self.notFound[notFound]) != 'undefined' ) {
                        ++self.notFound[notFound].count;
                    }

                    return false
                }

                // forms
                var altRoute = self.compareUrls(params, url, request) || null;
                if(altRoute.past && isMethodProvidedByDefault) {
                    notFound = method.toUpperCase() +'::'+ altRoute.request.routing.rule;
                    if ( typeof(self.notFound[notFound]) == 'undefined' ) {
                        msg = msg.replace(/\%r/, notFound);
                        //console.warn(msg);
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
    module.exports = Routing()
} else if (typeof (define) === 'function' && define.amd) {
    // Publish as AMD module
    define('lib/routing', ['require', 'lib/form-validator', 'lib/merge'], function() { return Routing() })
}