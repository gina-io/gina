define('gina/link', [ 'require', 'jquery', 'vendor/uuid', 'lib/domain', 'lib/merge', 'utils/events' ], function (require) {

    var $               = require('jquery');
    // $.noConflict = function( deep ) {
    //     if ( window.$ === jQuery ) {
    //         window.$ = _$;
    //     }

    //     if ( deep && window.jQuery === jQuery ) {
    //         window.jQuery = _jQuery;
    //     }

    //     return jQuery;
    // }
    $.noConflict();
    var uuid            = require('vendor/uuid');
    var Domain          = require('lib/domain');
    var domainInstance  = null;
    var merge           = require('lib/merge');

    require('utils/events'); // events

    /**
     * Gina Link Handler
     *
     * Activate binding with: `data-gina-link`
     * Optional, if your a.href is empty or with another value than the targeted action : `data-gina-link-url`
     *
     * @param {object} options
     * */
    function Link(options) {

        this.plugin = 'link';

        var events  = ['loaded', 'ready', 'open', 'close', 'destroy', 'success', 'error', 'progress'];
        registerEvents(this.plugin, events);

        var self = { // local use only
            'options' : {
                'url' : undefined,
                'class': 'gina-link-default'
            },
            authorizedEvents : ['ready', 'success', 'error'],
            events: {}
        };

        var instance        = {
            plugin          : this.plugin,
            id              : 'gina-links-' + uuid.v4(),
            on              : on,
            eventData       : {},

            '$links'       : {},
            target          : document, // by default
            isReady         : false,
            initialized     : false
        };

        // link proto
        var $link          = { // is on main `gina-links` container (first level)
            'plugin'            : this.plugin,
            'on'                : on,
            'eventData'         : {},
            'target'            : document, // by default

            'url'               : null,
            'request'           : null,
            '$forms'            : []
        };



        // XML Request
        var xhr = null;

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
                'X-Requested-With': 'XMLHttpRequest' // to set isXMLRequest == true && in case of cross domain origin

            }
        };

        var registeredLinks = [];



        var proxyClick = function($childNode, $el, evt) {

            addListener(gina, $childNode, 'click', function(e) {
                cancelEvent(e);

                triggerEvent(gina, $el, evt);
            });
        }

        var getLinkById = function(id) {
            return ( typeof(instance.$links[id]) != 'undefined' ) ? instance.$links[id] : null;
        }

        var getLinkByUrl = function(url) {
            var $link = null;

            for (var p in gina.link.$links) {
                if ( typeof(gina.link.$links[p].url) != 'undefined' && gina.link.$links[p].url == url ) {
                    $link = gina.link.$links[p];
                    break;
                }
            }

            return $link;
        }



        /**
         * linkRequest
         *
         * @param {string} url
         * @param {object} [options]
         * */
        function linkRequest(url, options) {

            // link object
            var $link      = getLinkByUrl(url);
            var id         = $link.id;


            // link element
            var $el         = document.getElementById(id) || null;

            var hLinkIsRequired = null;
            // forward callback to HTML data event attribute through `hform` status
            hLinkIsRequired = ( $el.getAttribute('data-gina-link-event-on-success') || $el.getAttribute('data-gina-link-event-on-error') ) ? true : false;
            // success -> data-gina-form-event-on-submit-success
            // error -> data-gina-form-event-on-submit-error
            if (hLinkIsRequired)
                listenToXhrEvents($link);

            // if ( $el == null ) {

            //     //var className   = $link.options.class +' '+ id;
            //     $el             = document.createElement('a');
            //     $el.setAttribute('id', id);
            //     //$el.setAttribute('class', className);
            //     instance.target.firstChild.appendChild($el);
            // }

            if ( typeof(options) == 'undefined' ) {
                options = xhrOptions;
            } else {
                options = merge(options, xhrOptions);
            }

            if ( /^(http|https)\:/.test(url) && !new RegExp('^' + window.location.protocol + '//'+ window.location.host).test(url) ) {
                // is request from same domain ?
                //options.headers['Origin']   = window.protocol+'//'+window.location.host;
                //options.headers['Origin']   = '*';
                //options.headers['Host']     = 'https://freelancer-app.fr.local:3154';
                var hostRootDomain  = domainInstance.getRootDomain(window.location.hostname).value;
                var urlRootDomain   = domainInstance.getRootDomain(url).value;
                var isSameDomain    = (hostRootDomain === urlRootDomain) ? true : false;
                // var isSameDomain    = ( new RegExp(window.location.hostname).test(url) ) ? true : false;

                if (gina.config.envIsDev) {
                    console.debug('Checking CORS from Popin plugin...\TODO - local CORS Proxy');
                    console.debug('Is request from same domain ? ', isSameDomain);
                }
                if (!isSameDomain) {
                    // proxy external urls
                    // TODO - instead of using `cors.io`, try to intégrate a local CORS proxy similar to : http://oskarhane.com/avoid-cors-with-nginx-proxy_pass/
                    //url = url.match(/^(https|http)\:/)[0] + '//cors.io/?' + url;
                    url = url.match(/^(https|http)\:/)[0] + '//corsacme.herokuapp.com/?'+ url;
                    //delete options.headers['X-Requested-With']
                }
            }
            options.url     = url;
            // updating link options
            if ($link && typeof($link.options) != 'undefined')
                options  = merge($link.options, options);


            if ( options.withCredentials ) { // Preflighted requests
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
            } else { // simple requests

                if (options.isSynchrone) {
                    xhr.open(options.method, options.url, options.isSynchrone)
                } else {
                    xhr.open(options.method, options.url)
                }
            }



            if (!xhr)
                throw new Error('No `xhr` object initiated');


            options.$link = $link;
            //xhr = handleXhr(xhr, $el, options);
            handleXhr(xhr, $el, options, require);
            // sending
            xhr.send();
        }

        // var listenToXhrEvents = function($link) {

        //     //data-gina-link-event-on-success
        //     var htmlSuccesEventCallback =  $link.target.getAttribute('data-gina-link-event-on-success') || null;
        //     if (htmlSuccesEventCallback != null) {

        //         if ( /\((.*)\)/.test(htmlSuccesEventCallback) ) {
        //             eval(htmlSuccesEventCallback)
        //         } else {
        //             $link.on('success.hlink',  window[htmlSuccesEventCallback])
        //         }
        //     }

        //     //data-gina-link-event-on-error
        //     var htmlErrorEventCallback =  $link.target.getAttribute('data-gina-link-event-on-error') || null;
        //     if (htmlErrorEventCallback != null) {
        //         if ( /\((.*)\)/.test(htmlErrorEventCallback) ) {
        //             eval(htmlErrorEventCallback)
        //         } else {
        //             $link.on('error.hlink', window[htmlErrorEventCallback])
        //         }
        //     }
        // }




        function registerLink($link, options) {

            if ( typeof(options) != 'object' ) {
                throw new Error('`options` must be an object')
            }

            $link.options = merge(options, self.options);

            // link element
            var id  = $link.id;
            var $el = document.getElementById(id) || null;

            if ( typeof(instance.$links[$link.id]) == 'undefined' ) {



                if ( registeredLinks.indexOf($link.id) > -1 ) {
                    throw new Error('`link '+$link.id+'` already exists !')
                }


                if (!gina.events[evt]) {



                    // attach click events
                    addListener(gina, $el, evt, function(e) {
                        cancelEvent(e);

                        var $localLink = getLinkById(e.target.id)
                        // loading & binding link
                        var localUrl = $localLink.url;

                        // Non-Preflighted requests
                        if ( typeof($localLink.options.isSynchrone) == 'undefined' ) {
                            $localLink.options.isSynchrone = false;
                        }
                        if ( typeof($localLink.options.withCredentials) == 'undefined' ) {
                            $localLink.options.withCredentials = false
                        }

                        linkRequest(localUrl, $localLink.options);

                        //delete gina.events[ $localLink.id ];
                        //removeListener(gina, event.target, event.type)
                    });



                    // bind child elements
                    var childNodes = $el.childNodes;
                    var l = 0; lLen = childNodes.length;
                    if (lLen > 0) {
                        for(; l < lLen; ++l) {
                            if (typeof (childNodes[l].tagName) != 'undefined') {
                                proxyClick(childNodes[l], $el, evt)
                            }
                        }
                    }
                }




                $link.request       = linkRequest;
                $link.getLinkById   = getLinkById;
                $link.getLinkByUrl  = getLinkByUrl;

                instance.$links[$link.id] = $link;



            }
        }

        /**
         * bindLinks
         *
         * @param {object} $target - DOM element
         * @param {object} [options]
         * */
        var bindLinks = function($target, options) {

            var id = null;
            if ( typeof($target) == 'undefined' ) {
                $target = instance.target;
                id = instance.id;
            }

            // binding form elements
            var found               = null
                , $el               = null
                , props             = null
                , $newLink          = null
                , url               = null
                , elId              = null
                , onEvent           = null
                , onclickAttribute  = null
                // a
                , $a                = $target.getElementsByTagName('a')
                // buttons
                //, $button   = $target.getElementsByTagName('button')
            ;

            var i = 0, len = $a.length;
            for (; i < len; ++i) {
                found = $a[i].getAttribute('data-gina-link');

                if (!found && found != "" || /^false$/i.test(found) ) continue;

                $el     = $a[i];
                props   = {
                    type: 'a',
                    method: 'GET'
                };


                url = $el.getAttribute('data-gina-link-url');
                if ( typeof(url) != 'undefined' && url != null ) {
                    props.url = url
                } else {
                    props.url = $el.getAttribute('href')
                }




                elId = $el.getAttribute('id');
                if ( typeof(elId) == 'undefined' || elId == null || elId == '' || /popin\.link/.test(elId) ) {

                    // unbind popin link
                    // if ( /popin\.link/.test(elId) ) {

                    // }

                    elId = 'link.click.'+ 'gina-link-' + instance.id +'-'+ uuid.v4();
                }
                $el['id']   = elId;
                props.id    = elId;
                evt         = elId;
                $el.setAttribute('id', evt);

                if ($el.tagName == 'A') {
                    onclickAttribute = $el.getAttribute('onclick');
                }

                if ( !onclickAttribute ) {
                    $el.setAttribute('onclick', 'return false;')
                } else if ( typeof(onclickAttribute) != 'undefined' && !/return false/.test(onclickAttribute) ) {
                    if ( /\;$/.test(onclickAttribute) ) {
                        onclickAttribute += 'return false;'
                    } else {
                        onclickAttribute += '; return false;'
                    }
                    $el.setAttribute('onclick', onclickAttribute);
                }

                $newLink = null;

                if ( typeof(instance.$links[props.id]) == 'undefined' ) {
                    props.target = $el;
                    $newLink = merge(props, $link);
                    registerLink($newLink, options);
                }


            }

        }

        var init = function(options) {

            setupInstanceProto();
            instance.on('init', function(event) {

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

                // proxies
                // click on main document
                evt = 'click';// click proxy
                // for proxies, use linkInstance.id as target is always `document`
                addListener(gina, instance.target, evt, function(event) {

                    if ( typeof(event.target.id) == 'undefined' ) {
                        event.target.setAttribute('id', evt +'.'+ uuid.v4() );
                        event.target.id = event.target.getAttribute('id')
                    }



                    if ( /^link\.click\./.test(event.target.id) ) {
                        cancelEvent(event);
                        var _evt = event.target.id;

                        if ( new RegExp( '^link.click.gina-link-' + instance.id).test(_evt) )
                            triggerEvent(gina, event.target, _evt, event.detail);

                    }
                });

                if ( typeof(options) == 'undefined' ) {
                    options = {}
                }
                instance.options = options;

                bindLinks(instance.target, options);
                gina.linkIsBinded = true;

                instance.isReady = true;
                gina.hasLinkHandler = true;
                gina.link = merge(gina.link, instance);
                // trigger link ready event
                triggerEvent(gina, instance.target, 'ready.' + instance.id, instance);
            });




            instance.initialized = true;

            return instance
        }

        var setupInstanceProto = function() {

            instance.bindLinks      = bindLinks;
            instance.request        = linkRequest;
            instance.getLinkById    = getLinkById;
            instance.getLinkByUrl   = getLinkByUrl;
        }

        new Domain( function onReady(err, _domainInstance) {
            if (err) {
                throw err
            }

            domainInstance = _domainInstance;
        });

        return init(options)
    }

    return Link
});