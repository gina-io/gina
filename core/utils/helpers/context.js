/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var os      = require('os');
var merge   = require('./../lib/merge');
var console = require('./../lib/logger');

/**
 * ContextHelper
 *
 * @package     Gina.Utils.Helpers
 * @author      Rhinostone <gina@rhinostone.com>
 * @api public
 * */
function ContextHelper(contexts) {

    var self = {};

    /**
     * ContextHelper Constructor
     * */
    var init = function(contexts) {

        if ( typeof(contexts) == 'undefined' ) {
            var contexts = {
                paths : {}
            }
        }

        self.contexts = contexts;

        if ( typeof(ContextHelper.initialized) != 'undefined' && ContextHelper.instance) {
            self = ContextHelper.instance;
        } else {
            ContextHelper.initialized = true;
            ContextHelper.instance = self
        }



        return self
    }

    self.configure = function(contexts) {
        joinContext(contexts)
    }

    joinContext = function(context) {
        merge(self.contexts, context, true)
    }

    var parseCtxObject = function (o, obj) {

        for (var i in o) {
            if (o[i] !== null && typeof(o[i]) == 'object') {
                parseCtxObject(o[i], obj);
            } else if (o[i] == '_content_'){
                o[i] = obj
            }
        }

        return o
    }

    setContext = function(name, obj, force) {

        if (arguments.length > 1) {
            //console.log("Globla setter active ", name, obj);
            if ( typeof(name) == 'undefined' || name == '' ) {
                var name = 'global'
            }

            if (/\./.test(name) ) {
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

                newObj = parseCtxObject(JSON.parse(str), obj);
                if (force) {
                    var key = name.split(/\./g);
                    self.contexts = merge(self.contexts, newObj, true);
                } else {
                    self.contexts =  merge(self.contexts, newObj)
                }

            } else {
                if (!self.contexts[name])
                    self.contexts[name] = {};

                if ( typeof(self.contexts[name]) != 'undefined' && !force) {
                    self.contexts[name] = obj
                } else {
                    self.contexts[name] = merge(self.contexts[name], obj, force)
                }
            }

        } else {
            //console.debug("setting context ", arguments[0]);
            self.contexts = arguments[0]
        }

        ContextHelper.instance = self;
    }

    getContext = function(name) {

        if ( typeof(name) != 'undefined' ) {
            try {
                //return clone(self.contexts[name])
                return self.contexts[name]
            } catch (err) {
                return undefined
            }
        } else {
            return self.contexts
        }
    }


    var throwError = function(code, err) {
        var router      = getContext('router');
        if (router) {
            var res                 = router.response
                , next              = router.next
                , hasViews          = router.hasViews
                , isUsingTemplate   = isUsingTemplate
                , code              = code;


            if (arguments.length < 2) {
                var err = code;
                code = 500
            }

            if ( !hasViews || !isUsingTemplate ) {
                if (!res.headersSent) {
                    res.writeHead(code, { 'Content-Type': 'application/json'} );
                    res.end(JSON.stringify({
                        status: code,
                        error: 'Error '+ code +'. '+ err.stack
                    }))
                } else {
                    next()
                }

            } else {
                if (!res.headersSent) {
                    res.writeHead(code, { 'Content-Type': 'text/html'} );
                    res.end('<h1>Error '+ code +'.</h1><pre>'+ err.stack + '</pre>')
                } else {
                    next()
                }
            }
        } else {
            throw err
        }
    }

    /**
     * Get bundle library
     *
     * TODO - cleanup
     *
     * @param {string} [ bundle ] - Bundle name
     * @param {string} lib  - Library name (module or file)
     *
     * */
    getLib = function(bundle, lib) {
        var ctx       = self.contexts;

        if (arguments.length == 1 || !bundle) {
            //console.debug(
            //    '\n[ 0 ] = '+ __stack[0].getFileName(),
            //    '\n[ 1 ] = '+ __stack[1].getFileName(),
            //    '\n[ 2 ] = '+ __stack[2].getFileName(),
            //    '\n[ 3 ] = '+ __stack[3].getFileName(),
            //    '\n[ 4 ] = '+ __stack[4].getFileName(),
            //    '\n[ 5 ] = '+ __stack[5].getFileName(),
            //    '\n[ 6 ] = '+ __stack[6].getFileName()
            //);
            var lib         = (arguments.length == 1) ? bundle : lib
                , bundle    = null
                , libPath   = null
                , file      = null
                , stackFileName = null;
                //, file      = ( !/node_modules/.test(__stack[1].getFileName()) ) ?  __stack[1].getFileName() : __stack[2].getFileName()
            for (var i = 1, len = 10; i<len; ++i) {
                stackFileName = __stack[i].getFileName();
                if ( stackFileName && !/node_modules/.test(stackFileName) ) {
                    file = stackFileName;
                    break;
                }
            }
            var a           = file.replace('.js', '').split('/')
                , i         = a.length-1;

            if (bundle == lib) {
                bundle = ctx.bundle
            } else {

                if (ctx.bundles) {
                    for (; i >= 0; --i) {
                        index = ctx.bundles.indexOf(a[i]);
                        if ( index > -1 ) {
                            ctx.bundle = bundle = ctx.bundles[index];

                            break
                        }
                    }
                } else if (ctx.bundle) {
                    bundle = ctx.bundle
                }

            }
        }
        // else {
        //     var libPath     = null
        //         , conf      = getContext('gina').config
        //         , env       = conf.env
        //         , cacheless = conf.isCacheless();
        // }
        var env     = ctx.env;
        var cacheless = ctx.cacheless;
        var Config  = ctx.gina.Config;
        var conf = new Config({
            env             : env,
            executionPath   : getPath('root'),
            startingApp     : bundle,
            ginaPath        : getPath('gina').core
        }).getInstance(bundle);

        if ( typeof(lib) != 'undefined' ) {

            try {

                if (!libPath)
                    libPath = conf.bundlesConfiguration.conf[bundle][env].libPath;

                var libToLoad = _(libPath +'/'+ lib, true);

                if (cacheless) delete require.cache[libToLoad];

                // init with options
                try {
                    var LibClass = require(libToLoad);
                    /**
                     * getConfig
                     *
                     * @param {string} [name]
                     *
                     * @return {object} bundleConfiguration - By default config from the bundle where the lib is located
                     * */
                    LibClass.prototype.getConfig = function (name) {
                        if ( typeof(name) != 'undefined' && typeof( conf.envConf[bundle][env].content[name] ) != 'undefined' ) {
                            return conf.envConf[bundle][env].content[name]
                        }

                        return conf.envConf[bundle][env]
                    };

                    return new LibClass ({
                        bundle      : bundle,
                        env         : env,
                        cacheless   : cacheless,
                        libPath     : libPath
                    })

                } catch(err) {
                    throwError(500, err)
                }

            } catch (err) {
                console.error(err.stack||err.message||err);
                throwError(500, err);
                return undefined
            }
        } else {
            console.error( new Error("no `lib` found"));
            throwError(500, new Error("`lib` [ "+name+" ] not found"))
            return undefined
        }

    }

    /**
     * Whisper
     * Convert replace constant names dictionary by its value
     *
     * @param {object} dictionary
     * @param {object} replaceable
     *
     * @return {object} revealed
     * */
    whisper = function(dictionary, replaceable, rule) {
        var s, key;
        if ( typeof(rule) != 'undefined') {
            return replaceable.replace(rule, function(s, key) {
                return dictionary[key] || s;
            })
        } else {

            if ( typeof(replaceable) == 'object' &&  !/\[native code\]/.test(replaceable.constructor) ||  typeof(replaceable) == 'function' /** && /Object/.test(replaceable.constructor) */ ) { // /Object/.test(replaceable.constructor)
                for (var attr in replaceable) {
                    if ( typeof(replaceable[attr]) != 'function') {
                        replaceable[attr] = (typeof(replaceable[attr]) != 'string' && typeof(replaceable[attr]) != 'object') ? JSON.stringify(replaceable[attr], null, 2) : replaceable[attr];
                        if (replaceable[attr] && typeof(replaceable[attr]) != 'object') {
                            replaceable[attr] = replaceable[attr].replace(/\{(\w+)\}/g, function(s, key) {
                                return dictionary[key] || s;
                            })
                        }
                    }
                }
                return replaceable
            } else { // mixing with classes
                replaceable = JSON.stringify(replaceable, null, 2);

                return JSON.parse(
                    replaceable.replace(/\{(\w+)\}/g, function(s, key) {
                        return dictionary[key] || s;
                    })
                )
            }
        }
    }

    isWin32 = function() {
        return (os.platform() == 'win32') ? true : false;
    }

    return init(contexts)
};

module.exports = ContextHelper;