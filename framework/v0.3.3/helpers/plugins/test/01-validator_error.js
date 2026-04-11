var reporter    = require('nodeunit').reporters.default;
var pluginsHelper  = require('../src/main')();// Not needed if the framework installed

exports['ValidatorError:  case'] = function(test) {
    var res = {};
    
    test.equal( typeof(appPlaceholdersCase), 'object' );
    test.deepEqual(appPlaceholdersCase, res );

    test.done();
};


// for debug purpose
if (reporter)
    reporter.run(['test/01-require_json.js']);