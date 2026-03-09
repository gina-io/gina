
function IntlPlugin() {

    var merge       = merge || require('lib/merge');
    var Collection  = Collection || require('lib/collection');

    var self = {
        options : {
            isCaseSensitive: true,
            locale: 'en' // by default
        }
    };

    // load phrases
    var phrases = {
        'amendment' : {
            _data : null,
            en : 'amendment',
            fr : 'avenant'
        }
    };

};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    var merge       = require('lib/merge');
    var Collection  = require('lib/collection');

    module.exports  = IntlPlugin

} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define('gina/intl', function(){ return IntlPlugin })
}