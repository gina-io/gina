/**
 * Gina Frontend Framework
 *
 * Usage:
 *  By adding gina tag in the end of the DOM ( just before </body>)
 *
 *      <script type="text/javascript" src="/js/vendor/gina/gina.min.js"></script>
 *
 *  You can add options through the `data-options`
 *      <script type="text/javascript" src="/js/vendor/gina/gina.min.js" data-options="{ env: 'dev', webroot: '/' }"></script>
 *
 *  Through RequireJS
 *
 *      var gina = require('gina');
 *
 *  Useful Globals
 *
 *  window['originalContext']
 *      - passe your `jQuery` or your `DollarDom` context to Gina
 *
 * */

var readyList = [ { name: 'gina', ctx: window['gina'], fn: onGinaLoaded } ];
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

                            readyList[i].ctx = window.gina;
                            result = readyList[i].fn.call(window, readyList[i].ctx);

                            // clear
                            if (result) {
                                window.clearInterval(scheduler);
                                ++i;
                                handleEvent(i, readyList)
                            }
                        } catch (err) {
                            window.clearInterval(scheduler);
                            throw err
                        }

                    }, 50, i, readyList);


                } else {
                    readyList[i].fn.call(window, readyList[i].ctx);
                    ++i;
                    handleEvent(i, readyList)
                }

            } else { // end
                // allow any closures held by these functions to free
                readyList = [];
            }
        }

        handleEvent(i, readyList)
    }
}

function readyStateChange() {
    if ( document.readyState === 'complete' ) {
        gina.ready();
    }
}


if ( typeof(window['gina']) == 'undefined' ) {// could have be defined by loader

    var gina = {
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


            // if ready has already fired, then just schedule the callback
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
    require('gina')(window['gina']); // passing core required lib through parameters
});


require.config({
    "packages": ["gina"]
});

require([
    //vendors
    "vendor/uuid",
    "vendor/engine.io",

    "core",

    // plugins
    "gina/validator",
    "gina/popin",
    "gina/storage",

    // utils
    "utils/dom",
    "utils/events",
    "utils/form-validator",
    "utils/collection"
]);


// catching freelancer script load event
var tags = document.getElementsByTagName('script');

for (var t = 0, len = tags.length; t < len; ++t) {

    if ( /gina.min.js|gina.js/.test( tags[t].getAttribute('src') ) ) {

        tags[t]['onload'] = function onGinaLoaded(e) {
            // TODO - get the version number from the response ?? console.log('tag ', tags[t].getAttribute('data-options'));
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
                    } else {
                        if ( gina["isFrameworkLoaded"] ) {
                            return true
                        }
                        var options = gina.options = {
                            /**@js_externs env*/
                            //env     : '{{ page.environment.env }}',
                            /**@js_externs version*/
                            //version : '{{ page.environment.version }}',
                            /**@js_externs webroot*/
                            webroot : '/'
                        };

                        gina["setOptions"](options);
                        gina["isFrameworkLoaded"]       = true;

                        // making adding css to the head
                        var link    = null;
                        link        = document.createElement('link');
                        link.href   = ((options.webroot !== '/') ? options.webroot + '/' : options.webroot) + "js/vendor/gina/gina.min.css";
                        link.media  = "screen";
                        link.rel    = "stylesheet";
                        link.type   = "text/css";
                        document.getElementsByTagName('head')[0].appendChild(link);

                        return true
                    }
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