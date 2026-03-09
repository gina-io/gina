define('gina/popin', [ 'require', 'jquery', 'vendor/uuid','utils/merge', 'utils/events' ], function (require) {

    var $       = require('jquery');
    var uuid    = require('vendor/uuid');
    var merge   = require('utils/merge');

    require('utils/events'); // events

    /**
     * Gina Popin Handler
     *
     * @param {object} options
     * */
    function Popin(options) {

        this.plugin = 'popin';

        var events  = ['loaded', 'ready', 'open', 'close', 'destroy', 'success', 'error', 'progress'];
        registerEvents(this.plugin, events);

        var self = { // local use only
            'options' : {
                'name' : undefined,
                'class': 'gina-popin-default'
            },
            autorizedEvents : ['ready', 'error'],
            events: {}
        };

        var instance        = {
            plugin      : this.plugin,
            id          : 'gina-popins-' + uuid.v1(),
            on          : on,
            eventData   : {},

            target      : document, // by default
            isReady     : false,
            initialized : false
        };

        // popin proto
        var $popin          = { // is on main `gina-popins` container (first level)
            'plugin'            : this.plugin,
            'on'                : on,
            'eventData'         : {},
            'target'            : document, // by default

            'name'          : null,
            'load'          : null,
            'loadContent'   : null,
            'open'          : null,
            'isOpen'        : false,
            'close'         : null,
            '$forms'        : []
        };

        var $validator      = null; // validator instance


        // XML Request
        var xhr = null;

        var registeredPopins = [];


        /**
         * popinCreateContainer
         *
         * Creates HTML container and add it to the DOM
         *
         *
         * */
        var popinCreateContainer = function() {

            // creating template
            // <div class="gina-popins">
            //     <div class="gina-popins-overlay gina-popin-is-active"></div>
            // </div>
            var $container = document.createElement('div');
            $container.id = instance.id;
            $container.setAttribute('id', instance.id);
            $container.setAttribute('class', 'gina-popins');

            var $overlay = document.createElement('div');
            $overlay.setAttribute('id', 'gina-popins-overlay');
            $overlay.setAttribute('class', 'gina-popins-overlay');


            $container.appendChild( $overlay );

            // adding to DOM
            document.body.appendChild($container);

            instance.target     = $container;
            instance.on         = on;

            gina.popinContainer  = instance.id;
            gina.hasPopinHandler = true;
        }
        
        var popinGetContainer = function () {
            //instance.id         = gina.popinContainer
            instance.target     = document.getElementById(gina.popinContainer);
            instance.on         = on;
        }

        var bindOpen = function() {
            var attr    = 'data-gina-popin-name';
            var $els    = getElementsByAttribute(attr);
            var $el     = null, name = null;
            var url     = null;
            var proceed = null, evt = null;


            for (var i = 0, len = $els.length; i < len; ++i) {
                $el     = $els[i];
                name    = $el.getAttribute(attr);
                if ( $el.tagName == 'A' ) {
                    url = $el.getAttribute('href');
                    if (url == '' || url =='#' || /\#/.test(url) ) {
                        url = null
                    }
                }

                if ( !url && typeof( $el.getAttribute('data-gina-popin-url') ) != 'undefined') {
                    url = $el.getAttribute('data-gina-popin-url');

                }

                if (!url) {
                    throw new Error('Found `data-gina-popin-name` without `url` !')
                }

                if ( !$el['url'] ) {
                    $el['url'] = url;
                }

                if ( !$el['popinName'] ) {
                    $el['popinName'] = name;
                }

                if (name == $popin.name) {
                    evt = 'popin.click.'+ 'gina-popin-' + instance.id +'-'+ uuid.v1() +'-'+ name;
                    $el['id'] = evt;
                    $el.setAttribute( 'id', evt);

                    if (!gina.events[evt]) {
                    //proceed = function () {
                        // attach submit events
                        addListener(gina, $el, evt, function(e) {
                            cancelEvent(e);

                            var fired = false;
                            $popin.on('loaded', function (e) {
                                e.preventDefault();

                                if (!fired) {
                                    fired = true;

                                    e.target.innerHTML = e.detail;


                                    // bind with formValidator if forms are found
                                    if ( /<form/i.test(e.target.innerHTML) && typeof($validator) != 'undefined' ) {
                                        var _id = null;
                                        var $forms = e.target.getElementsByTagName('form');
                                        for (var i = 0, len = $forms.length; i < len; ++i) {

                                            if ( !$forms[i]['id'] || typeof($forms[i]) != 'string' ) {
                                                _id = $forms[i].getAttribute('id') || 'form.' + uuid.v1();
                                                $forms[i].setAttribute('id', _id);// just in case
                                                $forms[i]['id'] = _id
                                            } else {
                                                _id = $forms[i]['id']
                                            }

                                            //console.log('pushing ', _id, $forms[i]['id'], typeof($forms[i]['id']), $forms[i].getAttribute('id'));
                                            if ($popin['$forms'].indexOf(_id) < 0)
                                                $popin['$forms'].push(_id);

                                            $forms[i].close = popinClose;
                                            $validator.validateFormById($forms[i].getAttribute('id')) //$forms[i]['id']

                                            removeListener(gina, $popin.target, e.type);
                                        }
                                    }

                                    popinOpen($popin.name);
                                }
                            });

                            // loading & binding popin
                            popinLoad($popin.name, e.target.url);
                        });
                    }


                    // if ( typeof(instance.events[evt]) != 'undefined' && instance.events[evt] == $el.id ) {
                    //     removeListener(gina, $el, evt, proceed);
                    //     delete instance.events[evt]
                    // } else {
                    //     proceed()
                    // }
                }

            }

            // proxies
            // click on main document
            evt = 'click';// click proxy
            // for proxies, use popinInstance.id as target is always `document`
            addListener(gina, document, evt, function(event) {

                if ( typeof(event.target.id) == 'undefined' ) {
                    event.target.setAttribute('id', evt +'.'+ uuid.v1() );
                    event.target.id = event.target.getAttribute('id')
                }

                if ( /^popin\.close\./.test(event.target.id) ) {
                    cancelEvent(event);

                    var _evt = event.target.id;

                    triggerEvent(gina, event.target, _evt, event.detail);
                }

                if ( /^popin\.click\./.test(event.target.id) ) {
                    cancelEvent(event);
                    //console.log('popin.click !! ', event.target);
                    var _evt = event.target.id;

                    if ( new RegExp( '^popin.click.gina-popin-' + instance.id).test(_evt) )
                        triggerEvent(gina, event.target, _evt, event.detail);

                }
            });

            gina.popinIsBindinded = true
        }



        /**
         * XML Request options
         * */
        var xhrOptions = {
            'url'           : '',
            'method'        : 'GET',
            'isSynchrone'   : false,
            'withCredentials': true, // if should be enabled under a trusted env
            'headers'       : {
                // cross domain is enabled by default, but you need to setup `Access-Control-Allow-Origin`
                'X-Requested-With': 'XMLHttpRequest' // in case of cross domain origin

            }
        };

        /**
         * popinLoad
         *
         * @param {string} name
         * @param {string} url
         * @param {object} [options]
         * */
        function popinLoad(name, url, options) {

            var id          = 'gina-popin-' + instance.id +'-'+ name;

            // popin element
            var $el         = document.getElementById(id) || null;

            if ( $el == null ) {

                var className   = self.options.class +' '+ id;
                $el             = document.createElement('div');
                $el.setAttribute('id', id);
                $el.setAttribute('class', className);
                instance.target.firstChild.appendChild($el);
            }

            if ( typeof(options) != 'undefined' ) {
                var options = merge(options, xhrOptions);
            } else {
                var options = xhrOptions;
            }

            options.url     = url;


            if ( options.withCredentials ) {
                if ('withCredentials' in xhr) {
                    // XHR for Chrome/Firefox/Opera/Safari.
                    if (options.isSynchrone) {
                        xhr.open(options.method, options.url, options.isSynchrone)
                    } else {
                        xhr.open(options.method, options.url)
                    }
                } else if ( typeof XDomainRequest != 'undefined' ) {
                    // XDomainRequest for IE.
                    xhr = new XDomainRequest();
                    xhr.open(options.method, options.url);
                } else {
                    // CORS not supported.
                    xhr = null;
                    var result = 'CORS not supported: the server is missing the header `"Access-Control-Allow-Credentials": true` ';
                    triggerEvent(gina, $el, 'error.' + id, result)
                }
            } else {
                if (options.isSynchrone) {
                    xhr.open(options.method, options.url, options.isSynchrone)
                } else {
                    xhr.open(options.method, options.url)
                }
            }

            // setting up headers
            for (var hearder in options.headers) {
                xhr.setRequestHeader(hearder, options.headers[hearder]);
            }

            if (xhr) {
                // catching ready state cb
                xhr.onreadystatechange = function (event) {
                    if (xhr.readyState == 4) {
                        // 200, 201, 201' etc ...
                        if( /^2/.test(xhr.status) ) {

                            try {
                                var result = xhr.responseText;
                                if ( /json$/.test( xhr.getResponseHeader("Content-Type") ) ) {
                                    result = JSON.parse(xhr.responseText)
                                }


                                instance.eventData.success = result;

                                triggerEvent(gina, $el, 'loaded.' + id, result);

                            } catch (err) {
                                var result = {
                                    'status':  422,
                                    'error' : err.description
                                };

                                instance.eventData.error = result;

                                triggerEvent(gina, $el, 'error.' + id, result)
                            }

                        } else {
                            //console.log('error event triggered ', event.target, $form);
                            var result = {
                                'status':  xhr.status,
                                'error' : xhr.responseText
                            };

                            instance.eventData.error = result;

                            // update toolbar
                            var XHRData = result;
                            if ( gina && typeof(window.ginaToolbar) == "object" && XHRData ) {
                                try {
                                    if ( XHRData.error && /^(\{|\[).test(XHRData.error) /)
                                        XHRData.error = JSON.parse(XHRData.error);

                                    // bad .. should not happen
                                    if ( typeof(XHRData.error.error) != 'undefined' )
                                        XHRData.error = XHRData.error.error;

                                    ginaToolbar.update("data-xhr", XHRData )
                                } catch (err) {
                                    throw err
                                }
                            }


                            triggerEvent(gina, $el, 'error.' + id, result)
                        }
                    }
                };

                // catching request progress
                // xhr.onprogress = function(event) {
                //     //console.log(
                //     //    'progress position '+ event.position,
                //     //    '\nprogress total size '+ event.totalSize
                //     //);
                //
                //     var percentComplete = (event.position / event.totalSize)*100;
                //     var result = {
                //         'status': 100,
                //         'progress': percentComplete
                //     };
                //
                //     instance.eventData.onprogress = result;
                //
                //     triggerEvent(gina, $el, 'progress.' + id, result)
                // };

                // catching timeout
                // xhr.ontimeout = function (event) {
                //     var result = {
                //         'status': 408,
                //         'error': 'Request Timeout'
                //     };
                //
                //     instance.eventData.ontimeout = result;
                //
                //     triggerEvent(gina, $el, 'error.' + id, result)
                // };


                // sending
                xhr.send();

                return {
                    'open': function () {
                        var fired = false;
                        addListener(gina, $el, 'loaded.' + id, function(e) {
                        //$popin.on('loaded', function (e) {
                            e.preventDefault();

                            if (!fired) {
                                fired = true;

                                e.target.innerHTML = e.detail;


                                // bind with formValidator if forms are found
                                if ( /<form/i.test(e.target.innerHTML) && typeof($validator) != 'undefined' ) {
                                    var _id = null;
                                    var $forms = e.target.getElementsByTagName('form');
                                    for (var i = 0, len = $forms.length; i < len; ++i) {

                                        if ( !$forms[i]['id'] || typeof($forms[i]) != 'string' ) {
                                            _id = $forms[i].getAttribute('id') || 'form.' + uuid.v1();
                                            $forms[i].setAttribute('id', _id);// just in case
                                            $forms[i]['id'] = _id
                                        } else {
                                            _id = $forms[i]['id']
                                        }

                                        //console.log('pushing ', _id, $forms[i]['id'], typeof($forms[i]['id']), $forms[i].getAttribute('id'));
                                        if ($popin['$forms'].indexOf(_id) < 0)
                                            $popin['$forms'].push(_id);

                                        $forms[i].close = popinClose;
                                        $validator.validateFormById($forms[i].getAttribute('id')) //$forms[i]['id']

                                        removeListener(gina, $popin.target, e.type);
                                    }
                                }

                                popinOpen($popin.name);
                            }
                        });
                    }
                }
            }

        }

        function popinLoadContent() {

        }

        /**
         * popinOpen
         *
         * Opens a popin by name
         *
         * @parama {string} name
         *
         * */
        function popinOpen(name) {

            // bind overlay on click
            var $overlay = instance.target.childNodes[0];

            addListener(gina, $overlay, 'click', function(event) {

                // don't cancel here, it will corrupt child elements behaviors such as checkboxes and radio buttons

                if ( /gina-popin-is-active/.test(event.target.className) ) {


                    // remove listeners
                    removeListener(gina, event.target, 'click');

                    // binding popin close
                    var $close = [], $buttonsTMP = [];

                    $buttonsTMP = $el.getElementsByTagName('button');
                    if ( $buttonsTMP.length > 0 ) {
                        for(var b = 0, len = $buttonsTMP.length; b < len; ++b) {
                            if ( /gina-popin-close/.test($buttonsTMP[b].className) )
                                $close.push($buttonsTMP[b])
                        }
                    }

                    $buttonsTMP = $el.getElementsByTagName('div');
                    if ( $buttonsTMP.length > 0 ) {
                        for(var b = 0, len = $buttonsTMP.length; b < len; ++b) {
                            if ( /gina-popin-close/.test($buttonsTMP[b].className) )
                                $close.push($buttonsTMP[b])
                        }
                    }

                    $buttonsTMP = $el.getElementsByTagName('a');
                    if ( $buttonsTMP.length > 0 ) {
                        for(var b = 0, len = $buttonsTMP.length; b < len; ++b) {
                            if ( /gina-popin-close/.test($buttonsTMP[b].className) )
                                $close.push($buttonsTMP[b])
                        }
                    }

                    for (var b = 0, len = $close.length; b < len; ++b) {
                        removeListener(gina, $close[b], $close[b].getAttribute('id') )
                    }

                    popinClose(name);
                }
            });


            var id = null, $el = null;
            if ( typeof(name) == 'string' && name != '' ) {
                id = 'gina-popin-' + instance.id +'-'+ name;
                if (id !== $popin.id)
                    throw new Error('Popin `'+name+'` not found !')
            } else if ( typeof(name) == 'undefined' ) {
                id = $popin.id
            }

            $el = document.getElementById(id);

            if ( !/gina-popin-is-active/.test($el.className) )
                $el.className += ' gina-popin-is-active';

            if ( !/gina-popin-is-active/.test(instance.target.firstChild.className) )
                instance.target.firstChild.className += ' gina-popin-is-active';

            // binding popin close
            var $close = [], $buttonsTMP = [];

            $buttonsTMP = $el.getElementsByTagName('button');
            if ( $buttonsTMP.length > 0 ) {
                for(var b = 0, len = $buttonsTMP.length; b < len; ++b) {
                    if ( /gina-popin-close/.test($buttonsTMP[b].className) )
                        $close.push($buttonsTMP[b])
                }
            }

            $buttonsTMP = $el.getElementsByTagName('div');
            if ( $buttonsTMP.length > 0 ) {
                for(var b = 0, len = $buttonsTMP.length; b < len; ++b) {
                    if ( /gina-popin-close/.test($buttonsTMP[b].className) )
                        $close.push($buttonsTMP[b])
                }
            }

            $buttonsTMP = $el.getElementsByTagName('a');
            if ( $buttonsTMP.length > 0 ) {
                for(var b = 0, len = $buttonsTMP.length; b < len; ++b) {
                    if ( /gina-popin-close/.test($buttonsTMP[b].className) )
                        $close.push($buttonsTMP[b])
                }
            }
            var onclickAttribute = null, evt = null;
            for (var b = 0, len = $close.length; b < len; ++b) {
                if ($close[b].tagName == 'A') {
                    onclickAttribute = $close[b].getAttribute('onclick');
                }

                if ( !onclickAttribute ) {
                    $close[b].setAttribute('onclick', 'return false;')
                } else if ( !/return false/) {
                    if ( /\;$/.test(onclickAttribute) ) {
                        onclickAttribute += 'return false;'
                    } else {
                        onclickAttribute += '; return false;'
                    }
                }

                if (!$close[b]['id']) {

                    evt = 'popin.close.'+ uuid.v1();
                    $close[b]['id'] = evt;
                    $close[b].setAttribute( 'id', evt);

                } else {
                    evt = $close[b]['id'];
                }

                var register = function (evt, $close) {
                    // attach submit events
                    addListener(gina, $close, evt, function(event) {

                        cancelEvent(event);

                        popinClose(name);
                        removeListener(gina, event.target, event.type)
                    });
                }


                if ( typeof(gina.events[evt]) == 'undefined' || gina.events[evt] != $close[b].id ) {
                    register(evt, $close[b])
                }
            }


            if ( /gina-popin-is-active/.test(event.target.className) ) {
                removeListener(gina, event.target, event.target.getAttribute('id'))
            }

            $popin.isOpen = true;
            // so it can be forwarded to the handler who is listening
            $popin.target = $el;

            // update toolbar
            var XHRData = document.getElementById('gina-without-layout-xhr-data');
            if ( gina && typeof(window.ginaToolbar) == "object" && XHRData ) {
                try {

                    if ( typeof(XHRData.value) != 'undefined' && XHRData.value ) {
                        XHRData = JSON.parse( decodeURIComponent( XHRData.value ) );
                        // reset data-xhr
                        ginaToolbar.update("data-xhr", null);

                        ginaToolbar.update("data-xhr", XHRData);
                    }

                } catch (err) {
                    throw err
                }
            }

            triggerEvent(gina, instance.target, 'open.'+ $popin.id, $popin);
        }


        /**
         * popinClose
         *
         * Closes a popin by `name` or all `is-active`
         *
         * @parama {string} [name]
         *
         * */
        function popinClose(name) {
            var id = null, $el = null;
            if ( typeof(name) == 'string' && name != '' ) {
                if (name !== $popin.name)
                    throw new Error('Popin `'+name+'` not found !');
            }
            // by default
            id = $popin.id;

            $el = $popin.target;

            if ( $el != null && /gina-popin-is-active/.test($el.className) ) {
                instance.target.firstChild.className  = instance.target.firstChild.className.replace(/\sgina-popin-is-active|gina-popin-is-active|gina-popin-is-active\s/, '');
                $el.className           = $el.className.replace(/\sgina-popin-is-active|gina-popin-is-active|gina-popin-is-active\s/, '');
                $el.innerHTML = '';

                // removing from FormValidator instance
                var i = 0, formsLength = $popin['$forms'].length;
                if ($validator['$forms'] && formsLength > 0) {
                    for (; i < formsLength; ++i) {
                        if ( typeof($validator['$forms'][ $popin['$forms'][i] ]) != 'undefined' )
                            $validator['$forms'][ $popin['$forms'][i] ].destroy();

                        $popin['$forms'].splice( i, 1);
                    }
                }
                // remove listeners
                removeListener(gina, $popin.target, 'loaded.' + $popin.id);




                $popin.isOpen = false;

                // restore toolbar
                if ( gina && typeof(window.ginaToolbar) == "object" )
                    ginaToolbar.restore();

                triggerEvent(gina, $popin.target, 'close.'+ id, $popin);
            }
        }

        /**
         * popinDestroy
         *
         * Destroyes a popin by name
         *
         * @parama {string} name
         *
         * */
        function popinDestroy(name) {
            var id = null, $el = null;
            if ( typeof(name) == 'string' && name != '' ) {
                id = 'gina-popin-' + instance.id +'-'+ name;
                if (id !== $popin.id)
                    throw new Error('Popin `'+name+'` not found !')
            } else if ( typeof(name) == 'undefined' ) {
                id = $popin.id
            }
        }

        var init = function(options) {

            instance.on('init', function(event) {

                if ( typeof(options) != 'object' ) {
                    throw new Error('`options` must be an object')
                }

                self.options    = merge(options, self.options);

                if ( typeof(self.options['name']) != 'string' || self.options['name'] == '' ) {
                    throw new Error('`options.name` can not be left `empty` or `undefined`')
                }

                if ( registeredPopins.indexOf(self.options['name']) > -1 ) {
                    throw new Error('`popin '+self.options['name']+'` already exists !')
                }

                if ( typeof(self.options['validator']) != 'undefined' ) {
                    $validator = self.options['validator']
                }

                self.options['class'] = 'gina-popin-container ' + self.options['class'];

                $popin.id           = 'gina-popin-' + instance.id +'-'+ self.options['name'];
                $popin.name         = self.options['name'];
                $popin.load         = popinLoad;
                $popin.loadContent  = popinLoadContent;
                $popin.open         = popinOpen;
                $popin.close        = popinClose;

                if ( typeof($validator) != 'undefined' )
                    $popin.validateFormById = $validator.validateFormById;

                // setting up AJAX
                if (window.XMLHttpRequest) { // Mozilla, Safari, ...
                    xhr = new XMLHttpRequest();
                } else if (window.ActiveXObject) { // IE
                    try {
                        xhr = new ActiveXObject("Msxml2.XMLHTTP");
                    } catch (e) {
                        try {
                            xhr = new ActiveXObject("Microsoft.XMLHTTP");
                        }
                        catch (e) {}
                    }
                }

                bindOpen();

                instance.isReady = true;

                // trigger validator ready event
                triggerEvent(gina, instance.target, 'ready.' + instance.id, $popin);
            });

            instance.initialized = true;

            return instance
        }



        if ( !gina.hasPopinHandler ) {
            popinCreateContainer();
        } else {
            popinGetContainer()
        }

        return init(options)
    };

    return Popin
})