define('gina', [ 'require', 'vendor/uuid', 'lib/merge', 'lib/routing', 'utils/events', 'helpers/prototypes', 'helpers/dateFormat', 'gina/toolbar' ], function (require) {

    /**
     * Imports & definitions
     * */
    var eventsHandler   = require('utils/events'); // events handler
    var merge           = require('lib/merge');
    var routing         = require('lib/routing');
    var dateFormat      = require('helpers/dateFormat')();
    var prototypes      = require('helpers/prototypes')({ dateFormat: dateFormat });
    var uuid            = require('vendor/uuid');

    var jQuery          = (window['jQuery']) ? window['jQuery'] : null;

    if (!window.process ) {
        (function(window, nextTick, process, prefixes, i, p, fnc) {
            p = window[process] || (window[process] = {});
            while (!fnc && i < prefixes.length) {
                fnc = window[prefixes[i++] + 'requestAnimationFrame'];
            }
            p[nextTick] = p[nextTick] || (fnc && fnc.bind(window)) || window.setImmediate || window.setTimeout;
        })(window, 'nextTick', 'process', 'r webkitR mozR msR oR'.split(' '), 0);
    }

    if (!window.getComputedStyle) {
        /**
         * Returns the roster widget element.
         * @this {Window}
         * @returns {ComputedStyle}
         */
        window.getComputedStyle = function(el, pseudo) {
            this.el = el;
            this.getPropertyValue = function(prop) {
                var re = /(\-([a-z]){1})/g;
                if (prop == 'float') {
                    prop = 'styleFloat'
                }
                if (re.test(prop)) {
                    prop = prop.replace(re, function () {
                        return arguments[2].toUpperCase()
                    })
                }
                return el.currentStyle[prop] ? el.currentStyle[prop] : null
            }
            return this
        }
    }

    async function getDependencies(gina, cb) {
        // Loading frontend assets required by plugins
        // Creating a custom event
        var depsEventBus = new EventTarget();

        async function loadRoutingConf(name, opt) {
            // var filenameOrUrl   = (opt.isCachingRequired) ? opt.url : opt.filename;
            var filenameOrUrl   = opt.url;
            var response    = null
                , result    = null
                , err       = null
            ;

            try {
                response    = await fetch(filenameOrUrl);
                result      = await response.text();
                gina.config[name] = JSON.parse(result);

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

        // Deps count
        var arr = [0,1];
        depsEventBus.addEventListener('deps.loaded', (event) => {
            arr.splice(0,1);
            if (!arr.length) {
                // Deps ready
                cb()
            }
        });

        // Get routing to populate `window.gina.config.routing`
        // Now fetching routing from gina
        // [0]
        await loadRoutingConf('routing', {url:  gina.config.webroot + '_gina/assets/routing.json'});
        // [1]
        await loadRoutingConf('reverseRouting', {url:  gina.config.webroot + '_gina/assets/reverse-routing.json'});
        // By adding another dep, you need
    }

    async function construct(gina) {

        this.plugin         = 'gina';

        var events          = [ 'ginaloaded', 'ready' ];

        /**
         * setOptions
         * Override default config options or add new options properties
         *
         * @param {object} options
         * */
        var setOptions = function(options) {
            proto.config = merge(proto.config, options, true)
        }

        // instance proto
        var proto           = {
            'id'                : 'gina-' + uuid.v1(),

            'plugin'            : this.plugin,
            'on'                : on,
            'eventData'         : {},
            'target'            : document, // by default
        };

        document.id = proto.id;

        var $instance       = {
            'id'                : proto.id,

            'isFrameworkLoaded' : false,
            'hasValidator'      : false,
            'hasPopinHandler'   : false,
            'config'            : {},
            'session'           : null,
            'registeredEvents'  : {},
            'events'            : {},

            'setOptions'        : setOptions
        };

        // iframe case
        if ( typeof(parent.window['gina']) != 'undefined' ) {
            // inheriting from parent frame instance
            window['gina'] = merge((window['gina'] || {}), parent.window['gina']);
        }
        $instance = merge( (window['gina'] || {}), $instance);

        registerEvents(this.plugin, events);

        await getDependencies(gina, function onDepsReady() {
           // [gina][deps] are ready ready
            triggerEvent(gina, proto.target, 'ginaloaded', $instance)
        });
    }

    return construct
});