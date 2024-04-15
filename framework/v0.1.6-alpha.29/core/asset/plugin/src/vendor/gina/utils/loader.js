"use strict";
/**
 * onGinaLoaded
 *
 * Used in the framework to load gina from the Super controller
 *
 * NB.:
 *  - this file is built appart
 *  - on change, you have to restart the bundle
 *
 * Must be placed before gina <script> tag
 *
 * Instructions for closure compiler: https://github.com/google/closure-compiler/wiki/@suppress-annotations
 * */

window['originalContext']   = window['jQuery'];
window['ginaToolbar']       = null;

window['onGinaLoaded']      = function(gina) {

    if (!gina) {
        //console.debug('gina not ready yet');
        return false
    }

    if ( gina["isFrameworkLoaded"] ) {
        return true
    }

    var options = gina['config'] = {
        /**@js_externs bundle*/
        'bundle': '{{ page.environment.bundle }}',
        /**@js_externs env*/
        'env'     : '{{ page.environment.env }}',
        /**@js_externs envIsDev*/
        'envIsDev' : ( /^true$/.test('{{ page.environment.envIsDev }}') ) ? true : false,
        /**@js_externs scope*/
        'scope'     : '{{ page.environment.scope }}',
        /**@js_externs scopeIsLocal*/
        'scopeIsLocal' : ( /^true$/.test('{{ page.environment.scopeIsLocal }}') ) ? true : false,
        /**@js_externs scopeIsProduction*/
        'scopeIsProduction' : ( /^true$/.test('{{ page.environment.scopeIsProduction }}') ) ? true : false,
        /**@js_externs isProxyHost*/
        'isProxyHost' : ( /^true$/.test('{{ page.environment.isProxyHost }}') ) ? true : false,
        /**@js_externs hostname*/
        'hostname': '{{ page.environment.hostname }}',
        /**@js_externs routing*/
        'routing': JSON.parse(decodeURIComponent('{{ page.environment.routing }}')),
        /**@js_externs reverseRouting*/
        'reverseRouting': JSON.parse(decodeURIComponent('{{ page.environment.reverseRouting }}')),
        /**@js_externs forms*/
        //'forms': JSON.parse(decodeURIComponent('{{ page.environment.forms }}')),
        /**@js_externs version*/
        version : '{{ page.environment.version }}',
        /**@js_externs webroot*/
        'webroot' : '{{ page.environment.webroot }}',
        /**@js_externs protocol*/
        'protocol' : '{{ page.environment.protocol }}'
    };

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
    // trigger timeout assignment - will trigger a compilation warning
    gina['session'].timeout;



    /**
     * getRouting
     *
     * @param {string} [bundle]
     *
     * @returns {Object} routing
    */
    gina['config']['getRouting'] = function(bundle) {

        if ( typeof(bundle) == 'undefined' ) {
            return gina['config']['routing']
        }

        var routes      = {};
        var routing     = gina['config']['routing'];
        var re = new RegExp("\\@" + bundle + String.fromCharCode(36)); // Closure compiler requirements: $ -> String.fromCharCode(36)

        // var route       = null;
        for (var route in routing) {
            if ( re.test(route) )
                routes[route] = routing[route]
        }
        re = null;

        return (routes['count']() > 0) ? routes : null
    };

    // Globals
    window['GINA_ENV']              = '{{ page.environment.env }}';
    window['GINA_ENV_IS_DEV']       = /^true$/i.test('{{ page.environment.envIsDev }}') ? true: false;
    if (
        typeof(location.search) != 'undefined' && /debug\=/i.test(location.search)
        ||
        !location.search && /\?/.test(location.href)
    ) {
        // Deep copy
        var search = (' ' + location.search).slice(1);
        if (!search && /\?/.test(location.href) ) {
            search = location.href.match(/\?.*/);
            if (Array.isArray(search) && search.length > 0) {
                search = search[0]
            }
        }
        var matched = search.match(/debug=(true|false)/);
        if (matched) {
            window['GINA_ENV_IS_DEV'] = gina['config']['envIsDev'] = ( /^true$/i.test(matched[0].split(/\=/)[1]) ) ? true: false;
        }
        matched = null;
        search  = null;
    }

    gina["isFrameworkLoaded"]       = true;
    gina["setOptions"](options);

    try {
        gina["forms"]               = JSON.parse(decodeURIComponent('{{ page.environment.forms }}'));
    } catch (err) {
        throw err
    }


    // Adding css to the head
    var link        = null
        , cssPath   = "css/vendor/gina/gina.min.css"
    ;

    // check if css has not been added yet
    var links       = document.head.getElementsByTagName('link')
        , i         = 0
        , len       = links.length
        , found     = false
        , re        = new RegExp(cssPath)
    ;

    for (; i < len; ++i ) {
        if ( re.test(links[i].href) ) {
            found = true;
            break
        }
    }
    links   = null;
    i       = null;
    len     = null;
    re      = null;

    if (!found) { // add css
        link            = document.createElement('link');
        link.href       = options['webroot'] + cssPath;
        link.media      = "screen";
        link.rel        = "stylesheet";
        link.type       = "text/css";

        // document.getElementsByTagName('head')[0].appendChild(link);
        var headEls = document.getElementsByTagName('head')[0];
        var existingLinks = headEls.getElementsByTagName('link');
        if (
            existingLinks
            && typeof(existingLinks.length) != 'undefined'
            && existingLinks.length > 0
        ) {
            // Must be the first link
            console.debug("placed before");
            headEls.insertBefore(link, existingLinks[0]);
        } else {
            console.debug("placed after");
            headEls.appendChild(link);
        }
        existingLinks = null;
        headEls = null;
    }

    // all required must be listed in `src/gina.js` defined modules list
    if ( /^true$/i.test(options['envIsDev']) ) {
        var Toolbar             = window['require']('gina/toolbar');
        window['ginaToolbar']   = new Toolbar();
    }

    return true;
}