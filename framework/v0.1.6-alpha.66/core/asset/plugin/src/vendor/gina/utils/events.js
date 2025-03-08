function registerEvents(plugin, events) {
    if ( typeof(gina) == 'undefined' && typeof(window.gina) != 'undefined' ) {
        gina = window.gina;
    }
    gina.registeredEvents[plugin] = events;
}
function mergeEventProps(evt, proxiedEvent) {
    for (let p in proxiedEvent) {
        // add only missing props
        if ( typeof(evt[p]) == 'undefined' ) {
            evt[p] = proxiedEvent[p];
        }
    }
    return evt;
}
/**
 * addListener
 *
 * @param {object} target
 * @param {object} element
 * @param {string|array} name
 * @param {callback} callback
 */
function addListener(target, element, name, callback) {

    var registerListener = function(target, element, name, callback) {

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

        gina.events[name] = ( typeof(element.id) != 'undefined' && typeof(element.id) != 'object' ) ? element.id : element.getAttribute('id');
    }

    var i = 0, len = null;
    if ( Array.isArray(name) ) {
        len = name.length;
        for (; i < len; i++) {
            registerListener(target, element, name[i], callback)
        }
    } else {
        if ( Array.isArray(element) ) {
            i = 0;
            len = element.length;
            for (; i < len; i++) {
                let evtName =  ( /\.$/.test(name) ) ? name + element[i].id : name;
                registerListener(target, element[i], evtName, callback);
            }
        } else {
            name =  ( /\.$/.test(name) ) ? name + element.id : name;
            registerListener(target, element, name, callback);
        }
    }

}
/**
 * triggerEvent
 * @param {object} target - targeted domain
 * @param {object} element - HTMLFormElement
 * @param {string} name - event ID
 * @param {object|array|string} args - details
 * @param {object} [proxiedEvent]
 */
function triggerEvent (target, element, name, args, proxiedEvent) {
    if (typeof(element) != 'undefined' && element != null) {
        var evt = null, isDefaultPrevented = false, isAttachedToDOM = false, merge  = null;
        // if (proxiedEvent) {
        //     merge = require('lib/merge');
        // }
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
            if (proxiedEvent) {
                // merging props
                evt = mergeEventProps(evt, proxiedEvent);
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

            if (proxiedEvent) {
                // merging props
                evt = mergeEventProps(evt, proxiedEvent);
            }

            element.fireEvent('on' + name, evt);
        }

    } else {
        target.customEvent.fire(name, args);
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

function setupXhr(options) {
    var xhr = null;
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
    if ( typeof(options) != 'undefined' ) {
        if ( !options.url || typeof(options.url) == 'undefined' ) {
            throw new Error('Missing `options.url`');
        }
        if ( typeof(options.method) == 'undefined' ) {
            options.method = 'GET';
        }
        options.method = options.method.toUpperCase();

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
                result = 'CORS not supported: the server is missing the header `"Access-Control-Allow-Credentials": true` ';
                triggerEvent(gina, $target, 'error.' + id, result);

                return;
            }

            if ( typeof(options.responseType) != 'undefined' ) {
                xhr.responseType = options.responseType;
            } else {
                xhr.responseType = '';
            }

            xhr.withCredentials = true;
        } else {
            if (options.isSynchrone) {
                xhr.open(options.method, options.url, options.isSynchrone);
            } else {
                xhr.open(options.method, options.url);
            }
        }

        // setting up headers -    all but Content-Type ; it will be set right before .send() is called
        for (var hearder in options.headers) {
             //if ( hearder == 'Content-Type' && typeof (enctype) != 'undefined' && enctype != null && enctype != '') {
             //    options.headers[hearder] = enctype
             //}
            if (hearder == 'Content-Type' && typeof (enctype) != 'undefined' && enctype != null && enctype != '')
                continue;

            xhr.setRequestHeader(hearder, options.headers[hearder]);
        }
    }
    return xhr;
}

/**
 * handleXhr
 *
 * @param {object} xhr - instance
 * @param {object} $el - dom objet element
 * @param {object} options
 */
function handleXhr(xhr, $el, options, require) {

    if (!xhr)
        throw new Error('No `xhr` object initiated');

    //var merge   = require('lib/merge');

    var blob            = null
        , isAttachment  = null // handle download
        , contentType   = null
        , result        = null
        , id            = null
        , $link         = options.$link || null
        , $form         = options.$form || null
        , $target       = null
    ;
    delete options.$link;
    delete options.$form;

    if ($form || $link) {
        if ($link) {
            // not the link element but the link elements collection : like for popins main container
            $link.target = document.getElementById($link.id);
            $target     = gina.link.target;
            id          = gina.link.id;

            // copy $el attributes to $target
            // for (var prop in $link) {
            //     if ( !$target[prop] )
            //         $target[prop] = $link[prop];
            // }
        } else { // forms
            $target = $form.target;
            id      = $target.getAttribute('id');
        }
    } else {
        $target = $el;
        id      = $target.getAttribute('id');
    }

    // forward callback to HTML data event attribute through `hform` status
    var hLinkIsRequired = ( $link && $el.getAttribute('data-gina-link-event-on-success') || $link && $el.getAttribute('data-gina-link-event-on-error') ) ? true : false;
    // if (hLinkIsRequired && $link)
    //     listenToXhrEvents($link, 'link');

    // forward callback to HTML data event attribute through `hform` status
    var hFormIsRequired = ( $form && $target.getAttribute('data-gina-form-event-on-submit-success') || $form && $target.getAttribute('data-gina-form-event-on-submit-error') ) ? true : false;
    // success -> data-gina-form-event-on-submit-success
    // error -> data-gina-form-event-on-submit-error
    if (hFormIsRequired && $form)
        listenToXhrEvents($form, 'form');


    // to upload, use `multipart/form-data` for `enctype`
    var enctype = $el.getAttribute('enctype') || options.headers['Content-Type'];

    // setting up headers -    all but Content-Type ; it will be set right before .send() is called
    for (var hearder in options.headers) {
        //if ( hearder == 'Content-Type' && typeof (enctype) != 'undefined' && enctype != null && enctype != '') {
        //    options.headers[hearder] = enctype
        //}
        if (hearder == 'Content-Type' && typeof (enctype) != 'undefined' && enctype != null && enctype != '')
            continue;

        xhr.setRequestHeader(hearder, options.headers[hearder]);
    }
    xhr.withCredentials = ( typeof(options.withCredentials) != 'undefined' ) ? options.withCredentials : false;


    // catching errors
    xhr.onerror = function(event, err) {

        var error = 'Transaction error: might be due to the server CORS settings.\nPlease, check the console for more details.';
        var result = {
            'status':  xhr.status || 500, //500,
            'error' : error
        };

        var resultIsObject = true;
        if ($form)
            $form.eventData.error = result;

        if ($link)
            $link.eventData.error = result;

        //updateToolbar(result, resultIsObject);
        window.ginaToolbar.update('data-xhr', result, resultIsObject);

        triggerEvent(gina, $target, 'error.' + id, result);

        if (hFormIsRequired)
            triggerEvent(gina, $target, 'error.' + id + '.hform', result);

        if (hLinkIsRequired)
            triggerEvent(gina, $target, 'error.' + id + '.hlink', result);
    }

    // catching ready state cb
    xhr.onreadystatechange = function (event) {
        // In case the user is also redirecting
        var redirectDelay = (/Google Inc/i.test(navigator.vendor)) ? 50 : 0;

        if (xhr.readyState == 2) { // responseType interception
            isAttachment    = ( /^attachment\;/.test( xhr.getResponseHeader('Content-Disposition') ) ) ? true : false;
            // force blob response type
            if ( !xhr.responseType && isAttachment ) {
                xhr.responseType = 'blob';
            }
        }

        if (xhr.readyState == 4) {
            blob            = null;
            contentType     = xhr.getResponseHeader('Content-Type');

            // 200, 201, 201' etc ...
            if( /^2/.test(xhr.status) ) {

                try {

                    // handling blob xhr download
                    if ( /blob/.test(xhr.responseType) || isAttachment ) {
                        if ( typeof(contentType) == 'undefined' || contentType == null) {
                            contentType = 'application/octet-stream';
                        }

                        blob = new Blob([this.response], { type: contentType });

                        //Create a link element, hide it, direct it towards the blob, and then 'click' it programatically
                        var a = document.createElement('a');
                        a.style = 'display: none';
                        document.body.appendChild(a);
                        //Create a DOMString representing the blob and point the link element towards it
                        var url = window.URL.createObjectURL(blob);
                        a.href = url;
                        var contentDisposition = xhr.getResponseHeader('Content-Disposition');
                        a.download = contentDisposition.match('\=(.*)')[0].substr(1);
                        //programatically click the link to trigger the download
                        a.click();
                        //release the reference to the file by revoking the Object URL
                        window.URL.revokeObjectURL(url);

                        result = {
                            status          : xhr.status,
                            statusText      : xhr.statusText,
                            responseType    : blob.type,
                            type            : blob.type,
                            size            : blob.size
                        }

                    }


                    if ( !result && /\/json/.test( contentType ) ) {
                        result = JSON.parse(xhr.responseText);

                        if ( typeof(result.status) == 'undefined' )
                            result.status = xhr.status || 200;
                    }

                    if ( !result && /\/html/.test( contentType ) ) {

                        result = {
                            contentType : contentType,
                            content     : xhr.responseText
                        };

                        if ( typeof(result.status) == 'undefined' )
                            result.status = xhr.status;

                        // if hasPopinHandler & popinIsBinded
                        if ( typeof(gina.popin) != 'undefined' && gina.hasPopinHandler ) {

                            // select popin by id
                            var $popin = gina.popin.getActivePopin();

                            if ($popin) {

                                XHRData = {};
                                // update toolbar

                                try {
                                    XHRData = new DOMParser().parseFromString(result.content, 'text/html').getElementById('gina-without-layout-xhr-data');
                                    XHRData = JSON.parse(decodeURIComponent(XHRData.value));

                                    XHRView = new DOMParser().parseFromString(result.content, 'text/html').getElementById('gina-without-layout-xhr-view');
                                    XHRView = JSON.parse(decodeURIComponent(XHRView.value));

                                    // update data tab
                                    if ( gina && typeof(window.ginaToolbar) && typeof(XHRData) != 'undefined' ) {
                                        window.ginaToolbar.update('data-xhr', XHRData);
                                    }

                                    // update view tab
                                    if ( gina && typeof(window.ginaToolbar) && typeof(XHRView) != 'undefined' ) {
                                        window.ginaToolbar.update('view-xhr', XHRView);
                                    }

                                } catch (err) {
                                    throw err
                                }

                                $popin.loadContent(result.content);

                                result = XHRData;
                                triggerEvent(gina, $target, 'success.' + id, result);

                                return;
                            }

                        }
                    }

                    if (!result) { // normal case
                        result = xhr.responseText;
                    }

                    if ($form)
                        $form.eventData.success = result;

                    XHRData = result;
                    // update toolbar
                    if ( gina && typeof(window.ginaToolbar) == 'object' && XHRData ) {
                        try {
                            // don't refresh for html datas
                            if ( typeof(XHRData) != 'undefined' && /\/html/.test(contentType) ) {
                                window.ginaToolbar.update('data-xhr', XHRData);
                            }

                        } catch (err) {
                            throw err
                        }
                    }

                    triggerEvent(gina, $target, 'success.' + id, result);

                    if (hFormIsRequired)
                        triggerEvent(gina, $target, 'success.' + id + '.hform', result);

                    if (hLinkIsRequired)
                        triggerEvent(gina, $target, 'success.' + id + '.hlink', result);

                } catch (err) {

                    result = {
                        status:  422,
                        error : err.message,
                        stack : err.stack

                    };

                    if ($form)
                        $form.eventData.error = result;


                    XHRData = result;
                    // update toolbar
                    if ( gina && typeof(window.ginaToolbar) == 'object' && XHRData ) {
                        try {

                            if ( typeof(XHRData) != 'undefined' ) {
                                window.ginaToolbar.update('data-xhr', XHRData);
                            }

                        } catch (err) {
                            throw err
                        }
                    }

                    triggerEvent(gina, $target, 'error.' + id, result);
                    if (hFormIsRequired)
                        triggerEvent(gina, $target, 'error.' + id + '.hform', result);

                    if (hLinkIsRequired)
                        triggerEvent(gina, $target, 'error.' + id + '.hlink', result);
                }

                // handle redirect
                if ( typeof(result) != 'undefined' && typeof(result.location) != 'undefined' ) {
                    window.location.hash = ''; //removing hashtag

                    // if ( window.location.host == gina.config.hostname && /^(http|https)\:\/\//.test(result.location) ) { // same origin
                    //     result.location = result.location.replace( new RegExp(gina.config.hostname), '' );
                    // } else { // external - need to remove `X-Requested-With` from `options.headers`
                        result.location = (!/^http/.test(result.location) && !/^\//.test(result.location) ) ? location.protocol +'//' + result.location : result.location;
                    //}

                    return setTimeout(() => {
                        window.location.href = result.location;
                    }, redirectDelay);
                }

            } else if ( xhr.status != 0) {

                result = { 'status': xhr.status, 'message': '' };
                // handling blob xhr error
                if ( /blob/.test(xhr.responseType) ) {

                    blob = new Blob([this.response], { type: 'text/plain' });

                    var reader = new FileReader(), blobError = '';

                    // This fires after the blob has been read/loaded.
                    reader.addEventListener('loadend', (e) => {

                        if ( /string/i.test(typeof(e.srcElement.result)) ) {
                            blobError += e.srcElement.result;
                        } else if ( typeof(e.srcElement.result) == 'object' ) {
                            result = merge(result, e.srcElement.result)
                        } else {
                            result.message += e.srcElement.result
                        }

                        // once ready
                        if ( /^2/.test(reader.readyState) ) {

                            if ( /^(\{|\[)/.test( blobError ) ) {
                                try {
                                    result = merge( result, JSON.parse(blobError) )
                                } catch(err) {
                                    result = merge(result, err)
                                }
                            }

                            if (!result.message)
                                delete result.message;

                            if ($form)
                                $form.eventData.error = result;

                            // forward appplication errors to forms.errors when available
                            if ( typeof(result) != 'undefined' && typeof(result.error) != 'undefined' &&  result.error.fields && typeof(result.error.fields) == 'object') {
                                var formsErrors = {}, errCount = 0;
                                for (var f in result.error.fields) {
                                    ++errCount;
                                    formsErrors[f] = { isApplicationValidationError: result.error.fields[f] };
                                }

                                if (errCount > 0) {
                                    handleErrorsDisplay($form.target, formsErrors);
                                }
                            }

                            // update toolbar
                            XHRData = result;
                            if ( gina && typeof(window.ginaToolbar) == 'object' && XHRData ) {
                                try {
                                    // update toolbar
                                    window.ginaToolbar.update('data-xhr', XHRData );

                                } catch (err) {
                                    throw err
                                }
                            }

                            triggerEvent(gina, $target, 'error.' + id, result);

                            if (hFormIsRequired)
                                triggerEvent(gina, $target, 'error.' + id + '.hform', result);

                            if (hLinkIsRequired)
                                triggerEvent(gina, $target, 'error.' + id + '.hlink', result);
                        }
                        return;


                    });

                    // Start reading the blob as text.
                    reader.readAsText(blob);

                } else { // normal case

                    if ( /^(\{|\[).test( xhr.responseText ) /) {

                        try {
                            result = merge( result, JSON.parse(xhr.responseText) )
                        } catch (err) {
                            result = merge(result, err)
                        }

                    } else if ( typeof(xhr.responseText) == 'object' ) {
                        result = merge(result, xhr.responseText)
                    } else {
                        result.message = xhr.responseText
                    }

                    if ($form)
                        $form.eventData.error = result;

                    // forward appplication errors to forms.errors when available
                    if ( typeof(result) != 'undefined' && typeof(result.error) != 'undefined' &&  result.error.fields && typeof(result.error.fields) == 'object') {
                        var formsErrors = {}, errCount = 0;
                        for (var f in result.error.fields) {
                            ++errCount;
                            formsErrors[f] = { isApplicationValidationError: result.error.fields[f] };
                        }

                        if (errCount > 0) {
                            handleErrorsDisplay($form.target, formsErrors);
                        }
                    }

                    // update toolbar
                    XHRData = result;
                    if ( gina && typeof(window.ginaToolbar) == "object" && XHRData ) {
                        try {
                            // update toolbar
                            window.ginaToolbar.update('data-xhr', XHRData );

                        } catch (err) {
                            throw err
                        }
                    }

                    triggerEvent(gina, $target, 'error.' + id, result);

                    if (hFormIsRequired)
                        triggerEvent(gina, $target, 'error.' + id + '.hform', result);

                    if (hLinkIsRequired)
                        triggerEvent(gina, $target, 'error.' + id + '.hlink', result);
                }

                return;


            }
        }
    };

    // catching request progress
    xhr.onprogress = function(event) {

        var percentComplete = '0';
        if (event.lengthComputable) {
            percentComplete = event.loaded / event.total;
            percentComplete = parseInt(percentComplete * 100);

        }

        //var percentComplete = (event.position / event.totalSize)*100;
        var result = {
            'status': 100,
            'progress': percentComplete
        };

        if ($form)
            $form.eventData.onprogress = result;

        triggerEvent(gina, $target, 'progress.' + id, result);
        return;
    };

    // catching timeout
    xhr.ontimeout = function (event) {
        result = {
            'status': 408,
            'error': 'Request Timeout'
        };

        if ($form)
            $form.eventData.ontimeout = result;

        triggerEvent(gina, $target, 'error.' + id, result);

        if (hFormIsRequired)
            triggerEvent(gina, $target, 'error.' + id + '.hform', result);

        if (hLinkIsRequired)
            triggerEvent(gina, $target, 'error.' + id + '.hlink', result);

        return;
    };


    //return xhr;
}

function removeListener(target, element, name, callback) {
    if (typeof(target.event) != 'undefined' && target.event.isTouchSupported && /^(click|mouseout|mouseover)/.test(name) && target.event[name].indexOf(element) != -1) {
        target.event[name].splice(target.event[name].indexOf(element), 1)
    }

    if (typeof(element) != 'undefined' && element != null) {
        if (element.removeEventListener) {
            //element.removeEventListener(name, callback, false);
            if ( Array.isArray(element) ) {
                i = 0;
                len = element.length;
                for (; i < len; i++) {
                    let evtName =  ( /\.$/.test(name) ) ? name + element[i].id : name;
                    element.removeEventListener(evtName, callback, false);
                    if ( typeof(gina.events[evtName]) != 'undefined' ) {
                        // removed ------> [evtName];
                        delete gina.events[evtName]
                    }
                }
            } else {
                name =  ( /\.$/.test(name) ) ? name + element.id : name;
                element.removeEventListener(name, callback, false);
            }
        } else if (element.attachEvent) {
            //element.detachEvent('on' + name, callback);
            if ( Array.isArray(element) ) {
                i = 0;
                len = element.length;
                for (; i < len; i++) {
                    let evtName =  ( /\.$/.test(name) ) ? name + element[i].id : name;
                    element.detachEvent('on' + evtName, callback);
                    if ( typeof(gina.events[evtName]) != 'undefined' ) {
                        // removed ------> [evtName];
                        delete gina.events[evtName]
                    }
                }
            } else {
                name =  ( /\.$/.test(name) ) ? name + element.id : name;
                element.detachEvent('on' + name, callback);
            }
        }
    } else {
        //target.customEvent.removeListener(name, callback)
        if ( Array.isArray(element) ) {
            i = 0;
            len = element.length;
            for (; i < len; i++) {
                let evtName =  ( /\.$/.test(name) ) ? name + element[i].id : name;
                target.customEvent.removeListener(evtName, callback);
                if ( typeof(gina.events[evtName]) != 'undefined' ) {
                    // removed ------> [evtName];
                    delete gina.events[evtName]
                }
            }
        } else {
            name =  ( /\.$/.test(name) ) ? name + element.id : name;
            target.customEvent.removeListener(name, callback)
        }
    }

    if ( typeof(gina.events[name]) != 'undefined' ) {
        // removed ------> [name];
        delete gina.events[name]
    }
    if ( typeof(callback) != 'undefined' ) {
        callback()
    }
}



function on(event, cb) {

    if (!this.plugin) throw new Error('No `plugin` reference found for this event: `'+ event);

    var events = gina.registeredEvents[this.plugin];

    if ( events.indexOf(event) < 0 && !/^init$/.test(event) && !/\.hform$/.test(event) && !/\.hlink$/.test(event) ) {
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

        if ( /\.(hform|hlink)$/.test(event) ) {
            event = ( /\.hform$/.test(event) ) ? event.replace(/\.hform$/, '.' + id + '.hform') : event.replace(/\.hlink$/, '.' + id + '.hlink');
        } else { // normal case
            event += '.' + id;
        }


        if (!gina.events[event]) {

            addListener(gina, $target, event, function(e) {

                //if ( typeof(e.defaultPrevented) != 'undefined' && e.defaultPrevented)
                cancelEvent(e);

                var data = null;

                if (e['detail']) {
                    data = e['detail'];
                } else if ( typeof(this.eventData.submit) != 'undefined' ) {
                    data = this.eventData.submit
                } else if ( typeof(this.eventData.error) != 'undefined' ) {
                    data = this.eventData.error;
                } else if ( typeof(this.eventData.success) != 'undefined' ) {
                    data = this.eventData.success;
                }

                if (cb)
                    cb(e, data);

                //triggerEvent(gina, e.currentTarget, e.type);
            });

            if (this.initialized && !this.isReady)
                triggerEvent(gina, $target, 'init.' + id);

        }

        return this
    }

    // Nothing can be added after on()


    var listenToXhrEvents = function($el, type) {


        //data-gina-{type}-event-on-success
        var htmlSuccesEventCallback =  $el.target.getAttribute('data-gina-'+ type +'-event-on-success') || null;
        if (htmlSuccesEventCallback != null) {

            if ( /\((.*)\)/.test(htmlSuccesEventCallback) ) {
                eval(htmlSuccesEventCallback)
            } else {
                $el.on('success.h'+ type,  window[htmlSuccesEventCallback])
            }
        }

        //data-gina-{type}-event-on-error
        var htmlErrorEventCallback =  $el.target.getAttribute('data-gina-'+ type +'-event-on-error') || null;
        if (htmlErrorEventCallback != null) {
            if ( /\((.*)\)/.test(htmlErrorEventCallback) ) {
                eval(htmlErrorEventCallback)
            } else {
                $el.on('error.h'+ type, window[htmlErrorEventCallback])
            }
        }
    }
}