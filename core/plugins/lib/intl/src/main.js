
function IntlPlugin() {

    var merge       = merge || require('utils/merge');
    var Collection  = Collection || require('utils/collection');

    var self = {
        'options' : { }
    };

};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports  = IntlPlugin
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define('gina/intl', function(){ return IntlPlugin })
}