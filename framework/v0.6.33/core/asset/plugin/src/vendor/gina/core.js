/**
 * Gina Frontend Framework
 *
 * Usage:
 *  By adding gina tag in the end of the DOM ( just before </body>)
 *
 *      <script type="text/javascript" src="/js/vendor/gina/gina.min.js"></script>
 *
 *  Config options come from the server-rendered page environment. Once the
 *  framework has loaded, option properties can be added or overridden through
 *      gina.setOptions({ ... })
 *
 *  Through RequireJS
 *
 *      var gina = require('gina');
 *
 *  Useful Globals
 *
 *  window['originalContext']
 *      You can pass a custom context to Gina handlers
 *      e.g.:
 *          window['originalContext'] = myContext
 *
 *      This can be achieved by overriding `window['originalContext']` before defining your handler
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

// #B414 — the framework's ONE mandatory client dependency (the routing table,
// fetched by getDependencies from `<webroot>_gina/assets/routing.json`) must be
// SETTLED before any consumer handler runs: the server whispers
// `page.environment.routing` as a hardcoded '{}' (the real export is commented
// out — "Adding 289 KB"), so between DOMContentLoaded and the fetch landing,
// `gina.config.routing` is {} and any getRoute()/toUrl() in handler init throws
// or misroutes. Loopback wins that race by single-digit ms; a real deployment
// LOSES it by 150ms+ on every load — deterministic breakage that local dev can
// never see. "Settled" deliberately means loaded OR failed: loadRoutingConf
// dispatches `deps.loaded` on both paths, so a broken endpoint still releases
// handlers (with console evidence via the listener) instead of hanging the page.
var _ginaDepsSettled = false;
var _ginaDepsQueue   = [];
/**
 * Marks the mandatory client deps settled and drains every queued callback.
 * Idempotent — the forced (timeout) and real (deps.loaded) paths can both fire.
 * @param {boolean} [forced] - true when the 5s fallback fired before the deps
 * @inner
 */
function _settleDeps(forced) {
    if (_ginaDepsSettled) return;
    _ginaDepsSettled = true;
    if (forced && typeof(console) != 'undefined' && console.error) {
        console.error('[gina] routing dependency still pending after 5s — releasing handlers with a degraded routing table');
    }
    while (_ginaDepsQueue.length) {
        try { _ginaDepsQueue.shift()(); } catch (depsCbErr) {
            if ( typeof(console) != 'undefined' && console.error ) {
                console.error(depsCbErr.stack || depsCbErr.message || depsCbErr);
            }
        }
    }
}
/**
 * Runs `fn` now if the mandatory deps have settled, else queues it for the
 * settle drain (real or forced).
 * @param {function} fn
 * @inner
 */
function _whenDepsSettled(fn) {
    if (_ginaDepsSettled) { fn(); return; }
    _ginaDepsQueue.push(fn);
}
// Armed at PARSE TIME on purpose — NOT inside getDependencies: on a page where
// the script-tag scan matches nothing (renamed src, static harness) the fetch
// is never issued, so a timer armed there would never start and the gate would
// hang handlers forever in exactly the degenerate case it exists to protect.
setTimeout(function () { _settleDeps(true); }, 5000);

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
                            // #B414 — advance past the gina entry only once the
                            // routing dependency has settled too: a truthy
                            // onGinaLoaded means only that the LOADER's whispers
                            // ran (isFrameworkLoaded), never that the async
                            // routing fetch landed. Releasing here without it
                            // ran consumer handlers against a {} table.
                            if (result && _ginaDepsSettled) {
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
                    readyList[i].ctx = window.originalContext || null;
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
        // TODO - Preload routing & reverseRouting
        gina.ready();
    }
}


if ( typeof(window['gina']) == 'undefined' ) { // could have be defined by loader

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
            },
            /**@js_externs initialized*/
            initialized: []
        },
        /**
         * ready
         * This is the one public interface use to wrap `handlers`
         * It fires once BOTH document readiness (DOMContentLoaded-equivalent)
         * AND the framework's mandatory routing dependency have settled — the
         * routing table arrives by async fetch, so DOMContentLoaded alone was
         * too early on deployed tiers (#B414). If the fetch fails or never
         * starts, handlers still release (settle-on-error / 5s fallback), with
         * console evidence.
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
                // #B414 — the late-registration path must gate on the routing
                // dependency too: this branch bypasses the readyList scheduler
                // entirely, so without the gate a handler registered after
                // DOMContentLoaded (a deferred script, a handler registered
                // from another handler) still ran against a {} table.
                _whenDepsSettled(function () {
                    setTimeout(function() {callback(context);}, 1);
                });
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

// #B483 — the `ginaloaded` listener is attached HERE, at parse time, ABOVE the
// `core` module definition. The `require([...])` below is deferred by the loader
// (RequireJS `nextTick` = setTimeout 4 ms) and the `core` factory is what constructs
// gina and dispatches `ginaloaded`, so a listener attached at file scope precedes
// the dispatch by construction. It used to be attached inside getDependencies'
// completion callback — only after the async routing.json fetch resolved — and on
// a light page the 4 ms timer beat the fetch: the event fired with no listener,
// the loader was never invoked against the constructed instance, `isFrameworkLoaded`
// never flipped, and the plugin boot pollers gave up (a permanently half-booted
// client, measured by a consumer's instrumented timeline). The loader is resolved
// LAZILY at dispatch: `window['onGinaLoaded']` is whispered server-side before this
// script executes; `_ginaFallbackOnLoaded` covers a page without the whisper.
function _ginaFallbackOnLoaded(gina) {

    if (!gina) {
        return false
    }

    if ( gina["isFrameworkLoaded"] ) {
        return true
    }

    // var options = gina['config'] = {
    var options = {
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
        'webroot'           : '{{ page.environment.webroot }}'
        // /**@js_externs routing*/
        // 'routing': JSON.parse(decodeURIComponent('{{ page.environment.routing }}')),
        // /**@js_externs reverseRouting*/
        // 'reverseRouting': JSON.parse(decodeURIComponent('{{ page.environment.reverseRouting }}'))
    };



    // Overriding in case of already defined config
    if ( typeof(gina['config']) != 'undefined' ) {
        for (let prop in gina['config'] ) {
            options[prop] = gina['config'][prop];
        }
    }
    gina['config'] = options;

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
        // Trigger timeout assignment - will trigger a compilation warning
        gina['session'].timeout;
    }



    // Globals
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

    // Cooking css into the head
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
function _onGinaLoadedEvent(event) {
    window['gina'] = event.detail;
    (window['onGinaLoaded'] || _ginaFallbackOnLoaded)(event.detail);
}
if (document.addEventListener) {
    document.addEventListener("ginaloaded", _onGinaLoadedEvent);
} else if (document.attachEvent) {
    document.attachEvent("ginaloaded", _onGinaLoadedEvent);
}


define('core', ['require', 'gina'], function (require) {
    require('gina')(window['gina']); // passing core required lib through parameters
});


require.config({
    "packages": ["gina"]
});

// exporting
require([
    //vendors
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
    "gina/nav",

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
    "lib/routing",
    "lib/loading-state"
], function () {
    // Boot the popin handler at page load so the declarative `data-gina-dialog` API is
    // active WITHOUT bundle code calling `new gina.popin()`. Constructing the handler
    // installs the delegated open listener + the `gina-popins` container; the
    // `.on('ready')` registration triggers the popin `init` self-fire so `gina.popin` /
    // `gina.hasPopinHandler` are set (a later explicit `new Popin()` reuses this
    // container and registers into the module-shared popin registry — the published
    // `gina.popin` stays this boot instance, #B90). Idempotent — guarded
    // on `hasPopinHandler`; a no-op on pages with no dialog/popin elements. The popin
    // module mutates the framework instance (`window.gina`), so defer until the
    // `ginaloaded` lifecycle has wired it (bounded poll on `isFrameworkLoaded`).
    var _popinBootTries = 0;
    var bootPopinHandler = function () {
        try {
            if ( !window['gina'] || !window['gina']['isFrameworkLoaded'] ) {
                if ( _popinBootTries++ < 100 ) {
                    (window['setTimeout'] || function (fn) { fn(); })(bootPopinHandler, 50);
                }
                return;
            }
            if ( window['gina']['hasPopinHandler'] ) {
                return;
            }
            var Popin = require('gina/popin');
            if ( typeof(Popin) == 'function' ) {
                new Popin({ 'name': 'gina-dialog-boot' }).on('ready', function () {});
            }
        } catch (popinBootErr) {
            if ( typeof(console) != 'undefined' && console.error ) {
                console.error('[gina] popin boot failed', popinBootErr.stack || popinBootErr);
            }
        }
    };
    bootPopinHandler();

    // Boot the validator at page load so the declarative `data-gina-form-rule` API is
    // active WITHOUT bundle code calling `new gina.validator()` — the sibling of the
    // popin boot above. Constructing the validator scans every `<form>`, binds the ones
    // matching a `gina.forms.rules` entry (live-checking + always-XHR submit), and the
    // `.on('ready')` registration triggers the validator `init` self-fire so
    // `gina.validator` / `gina.hasValidator` are set. Idempotent: a later explicit
    // `new gina.validator()` (a bundle's `handlers/*.js`) takes the `gina.hasValidator`
    // merge path and its own `.on('ready', …)` handler still fires — the same
    // re-construction path bundle code already relies on when it constructs the
    // validator more than once (a bundle `main.js` PLUS a per-page handler). Gated on a
    // NON-EMPTY `gina.forms.rules` so pages with no rules stay byte-identical (no form
    // scan, no `gina.validator` publish). `gina.forms` is whispered by `onGinaLoaded`,
    // which sets `isFrameworkLoaded` (synchronously) BEFORE `gina.forms`, so a truthy
    // `isFrameworkLoaded` observed from the bounded poll guarantees `gina.forms` is
    // already populated (run-to-completion — no yield splits the whisper).
    var _validatorBootTries = 0;
    var bootValidator = function () {
        try {
            // #B414 — `_ginaDepsSettled` joins the gate: `isFrameworkLoaded`
            // guarantees the whispers (incl. gina.forms) ran, but NOT that the
            // async routing fetch landed — and a form rule may name a route
            // (the `query` rule), which evaluates at bind. Constructing before
            // the deps settle bound forms against a {} table and died inside
            // the init listener. Settle-on-error + the 5s fallback keep this
            // poll terminating in every degenerate shape.
            if ( !window['gina'] || !window['gina']['isFrameworkLoaded'] || !_ginaDepsSettled ) {
                if ( _validatorBootTries++ < 100 ) {
                    (window['setTimeout'] || function (fn) { fn(); })(bootValidator, 50);
                }
                return;
            }
            if ( window['gina']['hasValidator'] ) {
                return;
            }
            var _forms = window['gina']['forms'];
            var _rules = ( _forms && _forms['rules'] ) ? _forms['rules'] : null;
            if ( !_rules || !Object.keys(_rules).length ) {
                return;
            }
            var Validator = require('gina/validator');
            if ( typeof(Validator) == 'function' ) {
                new Validator(_rules).on('ready', function () {});
            }
        } catch (validatorBootErr) {
            if ( typeof(console) != 'undefined' && console.error ) {
                console.error('[gina] validator boot failed', validatorBootErr.stack || validatorBootErr);
            }
        }
    };
    bootValidator();

    // Boot the navigation handler (#SPA1 — Tier 1) so the declarative
    // `data-gina-nav` API is active WITHOUT bundle code calling
    // `new gina.nav()` — the sibling of the popin/validator boots above,
    // with one deliberate difference: navigation is OPT-IN PER PROJECT
    // (SPA design decision 3 — upgrading gina must not change navigation
    // behaviour on existing pages). The shim therefore constructs ONLY when
    // the page carries a `data-gina-nav` swap-region marker; the `"false"`
    // value is the per-LINK opt-out spelling and does not opt a page in.
    // Pages without the marker stay byte-identical: no listener, no
    // `gina.nav` publish, no history/scroll changes. Gated on
    // `isFrameworkLoaded` like its siblings — by then the DOM is ready
    // (onGinaLoaded runs from the DOMContentLoaded-driven scheduler), so the
    // marker query observes the rendered page.
    var _navBootTries = 0;
    var bootNav = function () {
        try {
            if ( !window['gina'] || !window['gina']['isFrameworkLoaded'] ) {
                if ( _navBootTries++ < 100 ) {
                    (window['setTimeout'] || function (fn) { fn(); })(bootNav, 50);
                }
                return;
            }
            if ( window['gina']['hasNavHandler'] ) {
                return;
            }
            if (
                typeof(document.querySelector) != 'function'
                || !document.querySelector('[data-gina-nav]:not([data-gina-nav="false"])')
            ) {
                return;
            }
            var Nav = require('gina/nav');
            if ( typeof(Nav) == 'function' ) {
                new Nav({}).on('ready', function () {});
            }
        } catch (navBootErr) {
            if ( typeof(console) != 'undefined' && console.error ) {
                console.error('[gina] nav boot failed', navBootErr.stack || navBootErr);
            }
        }
    };
    bootNav();
});

function getDependencies(gina, cb) {
    // Loading frontend assets required by plugins
    // Creating a custom event
    var depsEventBus = new EventTarget();

    async function loadRoutingConf(name, opt) {

        var filenameOrUrl   = opt.url;
        var response    = null
            , result    = null
            , err       = null
        ;

        try {
            response    = await fetch(filenameOrUrl);
            // #B213 — `fetch` resolves on HTTP error statuses (it only rejects on
            // network failure), and the framework's own 404 page is valid JSON —
            // so without this guard a 404/5xx body (an engine missing the asset,
            // a restart window) was silently installed AS the routing table and
            // every client-side getRoute/toUrl failed from there. Throwing here
            // routes the failure into the existing catch, which dispatches the
            // deps.loaded error path instead of poisoning gina.config.
            if ( !response.ok ) {
                throw new Error('[ROUTING] HTTP '+ response.status +' fetching '+ filenameOrUrl);
            }
            result      = await response.text();
            if ( typeof(gina) == 'undefined' ) {
                gina = {}
            }
            if ( typeof(window['gina']['config']) == 'undefined' ) {
                gina['config'] = {}
            }
            gina['config'][name] = JSON.parse(result);

            depsEventBus.dispatchEvent(
                new CustomEvent('deps.loaded', {
                    detail: {
                        data: result,
                        error: err,
                        timestamp: new Date()
                    }
                })
            );

        } catch (RoutingLoadErr) {
            // There was an error
            err = new Error('[ROUTING] Could not load routing\n'+ (RoutingLoadErr.stack || RoutingLoadErr.message || RoutingLoadErr) );

            depsEventBus.dispatchEvent(
                new CustomEvent('deps.loaded', {
                    detail: {
                        data: null,
                        error: err,
                        timestamp: new Date()
                    }
                })
            );
            return;
        }
    }

    // Gina mandatory dependencies are handled here.
    //
    // Webroot resolution race: this code runs from the gina script-tag onload
    // handler (see ~line 335 below), which fires BEFORE `window.onGinaLoaded`
    // populates `gina.config`. At this point `gina.config.webroot` is undefined,
    // so the URL would fall back to '/' and routing.json would be fetched
    // root-relative — landing on the wrong upstream under reverse-proxy
    // sub-path mounts.
    //
    // `gina.onload.min.js` (whispered server-side) sets `window.__ginaWebroot`
    // synchronously at script parse time, BEFORE this script executes, so its
    // value is reliably available here. Fall back to `gina.config.webroot`
    // (works when `onGinaLoaded` did already run, e.g. re-entry), then to '/'.
    //
    // `core.js` itself ships in `gina.min.js`, which is served as a static
    // asset without a whisper pass — so `{{ page.environment.webroot }}` tokens
    // embedded here would reach the browser un-interpolated and break the fetch.
    var _webroot = (typeof window !== 'undefined' && window.__ginaWebroot)
        || (gina && gina.config && gina.config.webroot)
        || '/';
    var arr = [
        // Get routing to populate `window.gina.config.routing`
        // Now fetching routing from gina
        {
            func: loadRoutingConf,
            args: [ 'routing', {url:  _webroot + '_gina/assets/routing.json'} ]
        }
        // {
        //     func: loadRoutingConf,
        //     args: [ 'reverseRouting', {url:  _webroot + '_gina/assets/reverse-routing.json'} ]
        // }
    ];
    depsEventBus.addEventListener('deps.loaded', (event) => {
        // #B416 — surface the failure the event carries: loadRoutingConf
        // dispatches this on ERROR too (that is what keeps the boot alive),
        // but the detail was discarded — a failed fetch (#B213's guard
        // throwing on a non-OK status) booted the framework permanently
        // degraded (routing {}) with ZERO console evidence.
        if ( event && event.detail && event.detail.error ) {
            if ( typeof(console) != 'undefined' && console.error ) {
                console.error('[gina] routing dependency failed to load — client getRoute()/toUrl() will be degraded until reload:', event.detail.error.stack || event.detail.error.message || event.detail.error);
            }
        }
        arr.splice(0,1);
        if (!arr.length) {
            // Deps settled (loaded or failed) — release the #B414 gate, then
            // run the script-onload continuation (the ginaloaded attach).
            _settleDeps();
            cb()
        }
    });

    try {
        for (let i=0, len=arr.length; i<len; i++) {
            arr[i].func.apply(null,arr[i].args);
        }
    } catch (err) {
        console.error(err.stack||err.message||err);
    }
}

// catching gina script load event
// NOTE — immediately invoked (the trailing `}();`): getDependencies runs at PARSE, and
// `onload` receives the call's undefined return value; it is not an onload handler.
var tags = document.getElementsByTagName('script');
for (var t = 0, len = tags.length; t < len; ++t) {
    if ( /(gina\.min\.js|gina\.js)/.test( tags[t].getAttribute('src') ) ) {
        tags[t]['onload'] = function onGinaLoaded(e) {

            console.debug('Core Gina loaded !');
            getDependencies(gina, function onDepsReady() {
                // #B483 — nothing left to do here: the `ginaloaded` listener is
                // attached at PARSE TIME (file scope, above `define('core')`) and
                // resolves the loader lazily. This continuation is kept so that
                // getDependencies' settle order — `_settleDeps(); cb()` — stays
                // byte-identical (#B414).
            }); // EO await getDependencies
        }();

        break;
    } // EO if ( /(gina\.min\.js|gina\.js)/.test( tags[t].getAttribute('src') ) )
} // EO for (var t = 0, len = tags.length; t < len; ++t)