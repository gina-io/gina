function registerEvents(plugin, events) {
    gina.registeredEvents[plugin] = events
}

function addListener(target, element, name, callback) {

    if ( typeof(target.event) != 'undefined' && target.event.isTouchSupported && /^(click|mouseout|mouseover)/.test(name) && target.event[name].indexOf(element) == -1) {
        target.event[name][target.event[name].length] = element
    }

    if (typeof(element) != 'undefined' && element != null) {
        if (element.addEventListener) {
            element.addEventListener(name, callback, false)
        } else if (element.attachEvent) {
            element.attachEvent('on' + name, callback)
        }
    } else {
        target.customEvent.addListener(name, callback)
    }

    gina.events[name] = ( typeof(element.id) != 'undefined' && typeof(element.id) != 'object' ) ? element.id : element.getAttribute('id')
}

function triggerEvent (target, element, name, args) {
    if (typeof(element) != 'undefined' && element != null) {
        var evt = null, isDefaultPrevented = false, isAttachedToDOM = false;

        // done separately because it can be listen at the same time by the user & by gina
        if ( jQuery ) { //thru jQuery if detected

            // Check if listener is in use: e.g $('#selector').on('eventName', cb)
            var $events = null; // attached events list
            // Before jQuery 1.7
            var version = jQuery['fn']['jquery'].split(/\./);
            if (version.length > 2) {
                version = version.splice(0,2).join('.');
            } else {
                version = version.join('.');
            }

            if (version <= '1.7') {
                $events = jQuery(element)['data']('events')
            } else {// From 1.8 +
                $events = jQuery['_data'](jQuery(element)[0], "events")
            }

            isAttachedToDOM = ( typeof($events) != 'undefined' && typeof($events[name]) != 'undefined' ) ? true : false;

            if (isAttachedToDOM) { // only trigger if attached
                evt = jQuery.Event( name );
                jQuery(element)['trigger'](evt, args);
                isDefaultPrevented = evt['isDefaultPrevented']();
            }


        }

        if (window.CustomEvent || document.createEvent) {

            if (window.CustomEvent) { // new method from ie9
                evt = new CustomEvent(name, {
                    'detail'    : args,
                    'bubbles'   : true,
                    'cancelable': true,
                    'target'    : element
                })
            } else { // before ie9

                evt = document.createEvent('HTMLEvents');
                // OR
                // evt = document.createEvent('Event');

                evt['detail'] = args;
                evt['target'] = element;
                evt.initEvent(name, true, true);

                evt['eventName'] = name;

            }

            if ( typeof(evt.defaultPrevented) != 'undefined' && evt.defaultPrevented )
                isDefaultPrevented = evt.defaultPrevented;

            if ( !isDefaultPrevented ) {
                //console.log('dispatching ['+name+'] to ', element.id, isAttachedToDOM, evt.detail);
                element.dispatchEvent(evt)
            }

        } else if (document.createEventObject) { // non standard
            evt = document.createEventObject();
            evt.srcElement.id = element.id;
            evt.detail = args;
            evt.target = element;
            element.fireEvent('on' + name, evt)
        }

    } else {
        target.customEvent.fire(name, args)
    }
}

function cancelEvent(event) {
    if (typeof(event) != 'undefined' && event != null) {

        event.cancelBubble = true;

        if (event.preventDefault) {
            event.preventDefault()
        }

        if (event.stopPropagation) {
            event.stopPropagation()
        }


        event.returnValue = false;
    }
}

function removeListener(target, element, name, callback) {
    if (typeof(target.event) != 'undefined' && target.event.isTouchSupported && /^(click|mouseout|mouseover)/.test(name) && target.event[name].indexOf(element) != -1) {
        target.event[name].splice(target.event[name].indexOf(element), 1)
    }

    if (typeof(element) != 'undefined' && element != null) {
        if (element.removeEventListener) {
            element.removeEventListener(name, callback, false)
        } else if (element.attachEvent) {
            element.detachEvent('on' + name, callback)
        }
    } else {
        target.customEvent.removeListener(name, callback)
    }

    //console.log('tying to removing ', name, element);// avoid event proxies
    //if (! /^(click|submit)$/.test(name))
    if ( /**! /^(click|submit)$/.test(name) &&*/ typeof(gina.events[name]) != 'undefined' ) {
        //console.log('------> [removed] ' + name);
        delete gina.events[name]
    }
}

function on(event, cb) {

    if (!this.plugin) throw new Error('No `plugin` reference found for this event: `'+ event);

    var events = gina.registeredEvents[this.plugin];

    if ( events.indexOf(event) < 0 && !/^init$/.test(event) ) {
        cb(new Error('Event `'+ event +'` not handled by ginaEventHandler'))
    } else {
        var $target = null, id = null;
        if ( typeof(this.id) != 'undefined' && typeof(this.id) != 'object' ) {
            $target = this.target || this;
            id      = this.id;
        } else if ( typeof(this.target) != 'undefined'  ) {
            $target = this.target;
            if (!$target) {
                $target = this;
            }
            id      = ( typeof($target.getAttribute) != 'undefined' ) ? $target.getAttribute('id') : this.id;
        } else {
            $target = this.target;
            id      = instance.id;
        }

        if ( this.eventData && !$target.eventData)
            $target.eventData = this.eventData

        event += '.' + id;


        if (!gina.events[event]) {

            addListener(gina, $target, event, function(e) {

                cancelEvent(e);

                var data = null;
                if (e['detail']) {
                    data = e['detail'];
                } else if ( typeof(this.eventData.submit) != 'undefined' ) {
                    data = this.eventData.submit
                } else if ( typeof(this.eventData.error) != 'undefined' ) {
                    data = this.eventData.error
                } else if ( typeof(this.eventData.success) != 'undefined' ) {
                    data = this.eventData.success;
                }

                if (cb)
                    cb(e, data);
            });

            if (this.initialized && !this.isReady)
                triggerEvent(gina, $target, 'init.' + id);

        }

        return this
    }
}
