var inherits = require('../index');

var A = function() {
    var self = this;
    this.gender = 'female';
    this.name = 'Julia Roberts';
    this.getName = function () {
        return self.name;
    };
};

var B = function(gender) {//Super Class
    var self = this;
    this.gender = gender;
    this.name = 'Michael Jackson';
    this.age = 46;

    this.getAge = function () {
        return self.age;
    };

    this.getGender = function() {
        return this.gender
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

exports['Super overrides'] = function(test) {
    test.equal(a.name, 'Julia Roberts');
    test.equal(a.getName(), 'Julia Roberts');
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
