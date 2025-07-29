/**
 * Gina Frontend Framework
 *
 * Usage:
 *  By adding gina tag in the end of the DOM ( just before </body>)
 *
 *      <script type="text/javascript" src="/js/vendor/gina/gina.min.js"></script>
 *
 *  You can add or edit config options through the `data-gina-config`
 *      <script type="text/javascript" src="/js/vendor/gina/gina.min.js" data-gina-config="{ env: 'dev', envIsDev: true, webroot: '/' }"></script>
 *
 *  Through RequireJS
 *
 *      var gina = require('gina');
 *
 *  Useful Globals
 *
 *  window['originalContext']
 *      You have to passe your `jQuery` or your `DollarDom` context to Gina
 *      e.g.:
 *          window['originalContext'] = window['jQuery']
 *
 *      This can be achieved by overriding `window['originalContext']` before defining your handler
 *       Default value will be jQuery
 *
 * */

//var wContext = ( typeof(window.onGinaLoaded) == 'undefined') ? window : parent.window; // iframe case
var readyList = [
    {
        name: 'gina',
        ctx: window['gina'],
        fn: window.onGinaLoaded
    }
];
var readyFired = false;
var readyEventHandlersInstalled = false;

// call this when the document is ready
// this function protects itself against being called more than once
function ready() {

    if (!readyFired) {
        // this must be set to true before we start calling callbacks
        readyFired = true;
        var result = null;
        var i = i || 0;

        var handleEvent = function (i, readyList) {

            if ( readyList[i] ) {

                if (readyList[i].name == 'gina') {

                    var scheduler = window.setInterval(function (i, readyList) {
                        try {
                            if ( typeof(readyList) == 'undefined' ) {
                                // Fixing init bug in chrome
                                readyList = window.readyList;
                            }
                            readyList[i].ctx = window.gina;
                            result = readyList[i].fn.call(window, readyList[i].ctx, window.require);

                            // clear
                            if (result) {
                                window.clearInterval(scheduler);
                                ++i;
                                handleEvent(i, readyList);
                            }
                        } catch (err) {
                            window.clearInterval(scheduler);
                            throw err;
                        }

                    }, 50, i, readyList);


                } else { // onEachHandlerReady
                    // iframe case
                    if ( !window.$ && typeof(parent.window.$) != 'undefined' ) {
                        window.$ = parent.window.$;
                    }
                    // by default, but can be overriden in your handler (before the handler definition)
                    if ( typeof(window.originalContext) == 'undefined' && typeof(window.$) != 'undefined' ) {
                        window.originalContext = window.$
                    }
                    // passes the user's orignalContext by default; if no orignalContext is set will try users'jQuery
                    readyList[i].ctx = window.originalContext || $;
                    readyList[i].fn.call(window, readyList[i].ctx, window.require);
                    ++i;
                    handleEvent(i, readyList);
                }

            } else { // end
                // allow any closures held by these functions to free
                readyList = [];
            }
        }

        handleEvent(i, readyList);
    }
} // EO function ready()

function readyStateChange() {
    if ( document.readyState === 'complete' ) {
        gina.ready();
    }
}


if ( typeof(window['gina']) == 'undefined' ) {// could have be defined by loader

    var gina = {
        /**
         * `_global` is used mainly for google closure compilation in some cases
         * where eval() is called
         * It will store extenal variable definitions
         * e.g.:
         *  root -> window.root
         *  then you need to call :
         *      gina._global.register({'root': yourValue });
         *      => `window.root`now accessible
         *  before using:
         *      eval(root +'=value');
         *
         *  when not required anymore
         *      gina._global.unregister(['root])
         */
        /**@js_externs _global*/
        _global: {

            /**@js_externs register*/
            register: function(variables) {
                if ( typeof(variables) != 'undefined') {
                    for (let k in variables) {
                        // if ( typeof(window[k]) != 'undefined' ) {
                        //     // already register
                        //     continue;
                        //     //throw new Error('Gina cannot register _global.'+k+': variable name need to be changed, or you need to called `_global.unregister(['+k+'])` in order to use it');
                        // }
                        //window.gina['_global'][k] = variables[k];
                        window[k] = variables[k];
                    }
                }
            },
            /**@js_externs unregister*/
            unregister: function(variables) {
                if ( typeof(variables) == 'undefined' || !Array.isArray(variables)) {
                    throw new Error('`variables` needs to ba an array')
                }

                for (let i = 0, len = variables.length; i < len; i++) {
                    //delete  window.gina['_global'][ variables[i] ];
                    //if ( typeof(window[ variables[i] ]) != 'undefined' ) {
                        //console.debug('now removing: '+ variables[i]);
                        delete window[ variables[i] ]
                    //}
                }
            }
        },
        /**
         * ready
         * This is the one public interface use to wrap `handlers`
         * It is an equivalent of jQuery(document).ready(cb)
         *
         * No need to use it for `handlers`, it is automatically applied for each `handler`
         *
         * @callback {callback} callback
         * @param {object} [context] - if present, it will be passed
         * */
        /**@js_externs ready*/
        ready: function(callback, context) {


            // if ready has already beenfired, then just schedule the callback
            // to fire asynchronously, but right away
            if (readyFired) {
                setTimeout(function() {callback(context);}, 1);
                return;
            } else {
                // add the function and context to the list
                readyList.push({ name: 'anonymous', fn: callback, ctx: context });
            }

            // if document already ready to go, schedule the ready function to run
            // IE only safe when readyState is "complete", others safe when readyState is "interactive"
            if (document.readyState === "complete" || (!document.attachEvent && document.readyState === "interactive")) {
                setTimeout(ready, 1);
            } else if (!readyEventHandlersInstalled) {
                // otherwise if we don't have event handlers installed, install them
                if (document.addEventListener) {
                    // first choice is DOMContentLoaded event
                    document.addEventListener("DOMContentLoaded", ready, false);
                    // backup is window load event
                    window.addEventListener("load", ready, false);
                } else {
                    // must be IE
                    document.attachEvent("onreadystatechange", readyStateChange);
                    window.attachEvent("onload", ready);
                }
                readyEventHandlersInstalled = true;
            }

        }
    };

    window['gina'] = gina;
}


define('core', ['require', 'gina'], function (require) {
    // require(['jquery'], function onjQueryLoaded(_jQuery) {
    //     console.debug('_jQuery loaded ', _jQuery.fn.jquery);
    //     jquery = _jQuery
    // });

    require('gina')(window['gina']); // passing core required lib through parameters

});

/**
 * It will not work, since jQuery registers itself with the name of 'jquery' and not 'lib/jquery'.
 * In general, explicitly naming modules in the define() call are discouraged, but jQuery has some special constraints.
 */
// if ( typeof define === "function" && define.amd ) {
// 	define(['require'], function(require) {
// 		jQuery = require('jquery');
// 	});
// // }


require.config({
    "packages": ["gina"]
});

// exporting
// require(["jquery"]);
require([
    //vendors
    "vendor/uuid",
    "vendor/engine.io",

    "core",
    // helpers
    "helpers/prototypes",
    "helpers/binding",
    "helpers/dateFormat",

    // plugins
    "gina/link",
    "gina/validator",
    "gina/popin",
    "gina/storage",

    // lib
    "utils/dom",
    "utils/events",
    "utils/data",
    "utils/effects",
    "utils/polyfill",
    "lib/inherits",
    //"lib/merge",
    "lib/form-validator",
    "lib/collection",
    "lib/domain",
    "lib/routing"
]);

// catching gina script load event
var tags = document.getElementsByTagName('script');

for (var t = 0, len = tags.length; t < len; ++t) {

    if ( /gina.min.js|gina.js/.test( tags[t].getAttribute('src') ) ) {

        tags[t]['onload'] = function onGinaLoaded(e) {
            // TODO - get the version number from the response ?? console.log('tag ', tags[t].getAttribute('data-gina-config'));
            // var req = new XMLHttpRequest();
            // req.open('GET', document.location, false);
            // req.send(null);
            // var version = req.getAllResponseHeaders().match(/X-Powered-By:(.*)/)[0].replace('X-Powered-By: ', '');
            if (window['onGinaLoaded']) {
                var onGinaLoaded = window['onGinaLoaded']
            } else {
                function onGinaLoaded(gina) {

                    if (!gina) {
                        return false
                    }

                    if ( gina["isFrameworkLoaded"] ) {
                        return true
                    }

                    var options = gina['config'] = {
                        /**@js_externs env*/
                        env                 : '{{ page.environment.env }}',
                        /**@js_externs envIsDev*/
                        envIsDev            : ( /^true$/.test('{{ page.environment.envIsDev }}') ) ? true : false,
                        /**@js_externs scope*/
                        scope               : '{{ page.environment.scope }}',
                        /**@js_externs scopeIsLocal*/
                        scopeIsLocal        : ( /^true$/.test('{{ page.environment.scopeIsLocal }}') ) ? true : false,
                        /**@js_externs scopeIsProduction*/
                        scopeIsProduction   : ( /^true$/.test('{{ page.environment.scopeIsProduction }}') ) ? true : false,
                        /**@js_externs version*/
                        //version           : '{{ page.environment.version }}',
                        /**@js_externs webroot*/
                        'webroot'           : '{{ page.environment.webroot }}',
                    };

                    if ( typeof(getTimeout) == 'undefined' ) {
                        /**
                         * getTimeout
                         * Get session timeout
                         *
                         * @param {object} _this - `gina.session`
                         *
                         * @returns {date} extpiresAt
                        */
                        var getTimeout = function(_this) {
                            if (!_this['lastModified']) {
                                return null;
                            }
                            if ( _this['lastModified'] && typeof(_this['lastModified']) == 'string' ) {
                                _this['lastModified'] = new Date(_this['lastModified']);
                            }
                            if ( _this['createdAt'] && typeof(_this['createdAt']) == 'string' ) {
                                _this['createdAt'] = new Date(_this['createdAt']);
                            }
                            if ( _this['originalTimeout'] && typeof(_this['originalTimeout']) == 'string' ) {
                                _this['originalTimeout'] = parseInt(_this['originalTimeout']);
                            }
                            _this['expiresAt'] = new Date(new Date(_this['lastModified']).getTime() + _this['originalTimeout'])

                            return _this['expiresAt'] - new Date();
                        }
                    }

                    if ( !gina['session'] ) {

                        gina['session'] = {
                            /**@js_externs id*/
                            'id'                    : '{{ page.data.session.id }}' || null,
                            /**@js_externs originalTimeout*/
                            'originalTimeout'       : '{{ page.data.session.timeout }}' || (1000 * 60 * 5),
                            /**@js_externs createdAt*/
                            'createdAt'             : '{{ page.data.session.createdAt }}' || null,
                            /**@js_externs lastModified*/
                            'lastModified'          : '{{ page.data.session.lastModified }}' || null,
                            /**@js_externs expiresAt*/
                            'expiresAt'             : null
                        };

                        gina['session'].__defineGetter__("timeout", function () {
                            return getTimeout(this);
                        });
                        // trigger timeout assignment - will trigger a compilation warning
                        gina['session'].timeout;
                    }



                    // globals
                    window['GINA_ENV']          = '{{ page.environment.env }}';
                    window['GINA_ENV_IS_DEV']   = /^true$/i.test('{{ page.environment.envIsDev }}') ? true : false;
                    if ( typeof(location.search) != 'undefined' && /debug\=/i.test(window.location.search) ) {
                        var search = (' ' + window.location.search).slice(1);
                        if (!search && /\?/.test(window.location.href) ) {
                            search = window.location.href.match(/\?.*/);
                            if (Array.isArray(search) && search.length > 0) {
                                search = search[0]
                            }
                        }
                        var matched = search.match(/debug=(true|false)/);
                        if (matched)
                            window['GINA_ENV_IS_DEV'] = gina['config']['envIsDev'] = options['envIsDev'] = /^true$/i.test(matched[0].split(/\=/)[1]) ? true: false;
                    }

                    window['GINA_SCOPE']                = '{{ page.environment.scope }}';
                    window['GINA_SCOPE_IS_LOCAL']       = /^true$/i.test('{{ page.environment.scopeIsLocal }}') ? true : false;
                    window['GINA_SCOPE_IS_PRODUCTION']  = /^true$/i.test('{{ page.environment.scopeIsProduction }}') ? true : false;


                    gina["setOptions"](options);
                    gina["isFrameworkLoaded"]       = true;

                    // making adding css to the head
                    var link    = null;
                    link        = document.createElement('link');
                    link.href   = options.webroot + "css/vendor/gina/gina.min.css";
                    link.media  = "screen";
                    link.rel    = "stylesheet";
                    link.type   = "text/css";
                    document.getElementsByTagName('head')[0].appendChild(link);
                    link = null;

                    return true;
                }
            }


            if (document.addEventListener) {
                document.addEventListener("ginaloaded", function(event){
                    //console.log('Gina Framework is ready !');
                    window['gina'] = event.detail;
                    onGinaLoaded(event.detail)
                })
            } else if (document.attachEvent) {
                document.attachEvent("ginaloaded", function(event){
                    window['gina'] = event.detail;
                    onGinaLoaded(event.detail)
                })
            }
        }()
        break;
    }
}