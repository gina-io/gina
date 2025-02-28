var inherits = require('../src/main');

var A = function() {
    this.name = 'A';

    var self = this, local = {};

    this.gender     = 'female';
    local.name      = 'Julia Roberts';

    this.getName = function () {
        return local.name;
    };
};

var B = function(gender) {//Super Class
    this.name = 'B';

    var self = this, local = {};
    
    this.gender     = gender;
    local.name      = 'Michael Jackson';
    local.age       = 46;

    this.getAge = function () {
        return local.age;
    };

    this.getGender = function() {
        return self.gender
    }
};

var a = new ( inherits(A, B) )('male');

exports['Object created'] = function(test) {
    test.equal( typeof(a), 'object' );
    test.done()
}

exports['Has both instances'] = function(test) {
    test.equal(a instanceof A, true);
    test.equal(a instanceof B, true);
    test.done()
}

exports['Instances is named after the source class'] = function(test) {
    test.equal(a.name, 'A');
    test.done()
}

exports['Super is overrided'] = function(test) {
    test.equal(a.gender, 'female');
    test.equal(a.getGender(), 'female');
    test.done()
}

exports['Can access public members'] = function(test) {
    test.equal(a.getName(), 'Julia Roberts');
    test.equal(a.getAge(), 46);
    test.done()
}

exports['Got arguments'] = function(test) {
    test.equal(a.gender, 'female');
    test.done()
}
