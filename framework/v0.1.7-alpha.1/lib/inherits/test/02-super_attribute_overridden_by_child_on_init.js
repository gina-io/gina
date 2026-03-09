var inherits = require('../src/main');

var A = function() {
    this.age = 32;// Overriding Super (46)
    this.init() // triggers Super init()
}

var B = function(gender) {//Super Class
    var self = this;
    this.initialized = false;
    this.age = 46; // by default

    this.init = function() {
        self.initialized = true;
    }

    this.getAge = function () {
        return self.age
    }
};

var a = new ( inherits(A, B) )();

exports['Object created'] = function(test) {
    test.equal( typeof(a), 'object' );
    test.equal(a.initialized, true);
    test.done()
}

exports['Has both instances'] = function(test) {
    test.equal(a instanceof A, true);
    test.equal(a instanceof B, true);
    test.done()
}

exports['Super overriden'] = function(test) {
    test.equal(a.getAge(), 32);
    test.done()
}