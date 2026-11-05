define('gina', [ 'require', 'lib/merge', 'lib/uuid', 'lib/routing', 'lib/money', 'utils/events', 'helpers/prototypes', 'helpers/dateFormat' ], function (require) {

    /**
     * Imports & definitions
     * */
    var eventsHandler   = require('utils/events'); // events handler
    var merge           = require('lib/merge');
    var uuid            = require('lib/uuid');
    var routing         = require('lib/routing');
    var money           = require('lib/money'); // #FIN5 — exposed as gina.money below
    var dateFormat      = require('helpers/dateFormat')();
    var prototypes      = require('helpers/prototypes')({ dateFormat: dateFormat });
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


    async function construct(gina) {

        this.plugin         = 'gina';

        var events          = [ 'ginaloaded', 'ready' ];

        /**
         * setOptions
         * Overrides default config options or adds new option properties on the
         * exposed `gina.config` — the object every plugin and library reads.
         * Applied in place with override semantics: a top-level scalar from
         * `options` replaces the existing value, a top-level object is merged one
         * level deep, and keys absent from `options` are never removed.
         *
         * N.B.: the framework boot passes the exposed config itself through this
         * function; that call is a no-op by design. In a child frame inheriting a
         * parent frame's instance, the inherited handler configures the parent.
         *
         * @param {object} options - e.g. `{ loadingAttribute: 'data-loading' }`
         *
         * @example
         *  gina.setOptions({ loadingAttribute: 'data-loading' });
         *  // gina.config.loadingAttribute is now 'data-loading'
         * */
        var setOptions = function(options) {
            if ( !options || typeof(options) != 'object' || options === $instance.config ) {
                // nothing to merge: no options given, or the boot passing the
                // exposed config back to itself
                return
            }
            $instance.config = merge($instance.config, options, true)
        }

        // instance proto
        var proto           = {
            'id'                : 'gina-' + uuid(),

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

            'setOptions'        : setOptions,
            // #FIN5 — exact-money primitive (ISO 4217 minor-unit BigInt
            // arithmetic), the same module the server registers as lib.money:
            // gina.money.parse('19.99','EUR') / add / subtract / multiply /
            // compare / format / toMinor / fromMinor / exponent. Display
            // formatting stays with Intl.NumberFormat.
            'money'             : money
        };

        // iframe case — inherit the parent frame's instance when there is one.
        // #B486 — under a CROSS-ORIGIN parent the named-property read on its
        // WindowProxy throws SecurityError; construct() is async, so that throw
        // became an unobserved rejection (core.js discards the promise) and
        // `ginaloaded` was never dispatched — a silently half-booted client.
        // Inheritance is optional: skip it, never let it stop the boot.
        try {
            if ( typeof(parent.window['gina']) != 'undefined' ) {
                // inheriting from parent frame instance
                window['gina'] = merge((window['gina'] || {}), parent.window['gina']);
            }
        } catch (crossOriginErr) {
            // cross-origin parent: no inheritance
        }
        $instance = merge( (window['gina'] || {}), $instance);

        registerEvents(this.plugin, events);
        triggerEvent(gina, proto.target, 'ginaloaded', $instance);
    }

    return construct
});