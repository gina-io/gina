var reporter = require('nodeunit').reporters.default;

var resultMock = ['a', 'b', 'c'];

function Query() { 
    
    var self    = this, local = {};
    var result  = local.result = JSON.clone(resultMock); 

    this.find = function() {
        var result = ( Array.isArray(this) ) ? this : local.result;

        result.limit = self.limit;
        result.toRaw = self.toRaw;

        return result;
    };

    this.limit = function(limit) {

        var result = JSON.clone(local.result);

        result = result.splice(0, limit);
        result.find = self.find;
        result.toRaw = self.toRaw;

        return result;
    };

    this.toRaw = function() {

        var result = (Array.isArray(this)) ? this : local.result;
        
        return JSON.clone(result);
    };


    return this.find(); 
}



exports['demo'] = function(test) {

    var result = new Query();
    
    test.equal(Array.isArray(result), true);
    test.equal(result.length, resultMock.length);

    test.deepEqual(result.limit(2).toRaw(), ['a', 'b']);
    test.deepEqual(result.toRaw(), resultMock);

    test.done()
}

// for debug purpose
if (reporter)
    reporter.run(['test/demo.js']);