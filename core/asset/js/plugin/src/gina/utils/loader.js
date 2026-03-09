"use strict";
/**
 * onGinaLoaded
 *
 * Used in the framework to load gina from the Super controller
 * 
 * NB.: this file is built appart
 *
 * Must be placed before gina <script> tag
 *
 * */

window['originalContext'] = window['jQuery'];


window['ginaToolbar']   = null;
window['onGinaLoaded']  = function(gina) {

    if (!gina) {
        //console.log('gina not ready yet');
        return false

    } else {
        if ( gina["isFrameworkLoaded"] ) {
            return true
        }
        var options = gina.options = {
            /**@js_externs env*/
            'env'     : '{{ page.environment.env }}',
            /**@js_externs version*/
            version : '{{ page.environment.version }}',
            /**@js_externs webroot*/
            'webroot' : '{{ page.environment.webroot }}'
        };

        gina["isFrameworkLoaded"]       = true;
        gina["setOptions"](options);
        gina["forms"]                   = JSON.parse('{{ JSON.stringify(page.forms) }}');

        // making adding css to the head
        var link        = null;
        link            = document.createElement('link');
        link.href       = ((options['webroot'] !== '/') ? options['webroot'] + '/' : options['webroot']) + "js/vendor/gina/gina.min.css";
        link.media      = "screen";
        link.rel        = "stylesheet";
        link.type       = "text/css";
        document.getElementsByTagName('head')[0].appendChild(link);

        // all required must be listed in `src/gina.js` defined modules list
        if (options['env'] == 'dev') {
            var Toolbar             = require('gina/toolbar');
            window['ginaToolbar']   = new Toolbar();
        }

        return true
    }
}