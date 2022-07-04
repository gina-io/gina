define('gina', [ 'require', 'vendor/uuid', 'utils/merge', 'utils/events', 'helpers/dateFormat', 'gina/toolbar' ], function (require) {
    var eventsHandler   = require('utils/events'); // events handler
    var merge           = require('utils/merge');
    var dateFormat      = require('helpers/dateFormat')();
    var uuid            = require('vendor/uuid');



    /**
     * Imports & definitions
     * */

    var jQuery = (window['jQuery']) ? window['jQuery'] : null;

    if (!window.process ) {
        (function(window, nextTick, process, prefixes, i, p, fnc) {
            p = window[process] || (window[process] = {});
            while (!fnc && i < prefixes.length) {
                fnc = window[prefixes[i++] + 'equestAnimationFrame'];
            }
            p[nextTick] = p[nextTick] || (fnc && fnc.bind(window)) || window.setImmediate || window.setTimeout;
        })(window, 'nextTick', 'process', 'r webkitR mozR msR oR'.split(' '), 0);
    }

    if (!window.getComputedStyle) {
        /**
         * Returns the roster widget element.
         * @this {Window}
         * @return {ComputedStyle}
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

    /**
     * Custom object properties definition
     * */

    Object.defineProperty( Date.prototype, 'format', {
        writable:   false,
        enumerable: false,
        //If loaded several times, it can lead to an exception. That's why I put this.
        configurable: true,
        value: function(mask, utc){ return dateFormat.format(this, mask, utc) }
    });


    Object.defineProperty( Object.prototype, 'count', {
        writable: true,
        enumerable: false,
        //If loaded several times, it can lead to an exception. That's why I put this.
        configurable: true,
        value: function(){
            try {
                var self = this;
                if (this instanceof String) self = JSON.parse(this);
                var i = 0;
                for (var prop in this)
                    if (this.hasOwnProperty(prop)) ++i;

                return i
            } catch (err) {
                return i
            }
        }
    });


    function construct(gina) {

        this.plugin         = 'gina';

        var events          = [ 'ginaloaded', 'ready' ];

        /**
         * setOptions
         * Override default options or add new options properties
         *
         * @param {object} options
         * */
        var setOptions = function(options) {
            proto.options = merge(proto.options, options, true)
        }

        var proto           = { // instance proto
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
            'options'           : {},
            'registeredEvents'  : {},
            'events'            : {},

            'setOptions'        : setOptions
        };

        $instance = merge( (window['gina'] || {}), $instance);

        registerEvents(this.plugin, events);

        triggerEvent(gina, proto.target, 'ginaloaded', $instance)
    }

    return construct
});