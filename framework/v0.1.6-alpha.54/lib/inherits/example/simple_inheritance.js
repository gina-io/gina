var inherits = require('../src/main.js');// Not needed if the framework installed

var A = function() {
    this.name = "A";

    var self = this, local = {};

    this.gender = 'female';
    local.name = 'Julia Roberts';

    this.getName = function () {
        return local.name;
    };

    this.init();
};

var B = function(gender) {//Super Class
    this.name = "B";

    var self = this, local = {};

    this.gender = gender;
    local.name = 'Michael Jackson';
    local.age = 46;

    this.init = function() {
        console.log('logging age: '+local.age);
    }

    this.getAge = function () {
        return local.age;
    }

    this.getGender = function() {
        return self.gender;
    }
};


var a = new ( inherits(A, B) )('male');
console.log('is [ a ] instance of A ? ', a instanceof A);// true
console.log('is [ a ] instance of B ? ', a instanceof B);// true
console.log('instance name of [a] is: '+ a.name);// A

console.log('Name: ', a.getName());// Julia Roberts
console.log('Age: ', a.getAge());// 46
console.log('Gender: ', a.getGender() );// female