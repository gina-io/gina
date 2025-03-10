define('gina', [ 'require', 'vendor/uuid', 'lib/merge', 'utils/events', 'helpers/prototypes', 'helpers/dateFormat', 'gina/toolbar' ], function (require) {

    /**
     * Imports & definitions
     * */
    var eventsHandler   = require('utils/events'); // events handler
    var merge           = require('lib/merge');
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

    function construct(gina) {

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

        triggerEvent(gina, proto.target, 'ginaloaded', $instance)
    }

    return construct
});