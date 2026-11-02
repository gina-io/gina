var inherits = require('../src/main.js');// Not needed if the framework installed

var A = function() {
    this.name = "A";

    this.age = 32;// Overriding Super (46)
    this.init(); // triggers Super init()
};

var B = function() {//Super Class
    this.name = "B";

    var self = this;
    this.age = 46; // by default

    this.init = function() {
        console.log('Inheritance completed with success')
    };

    this.getAge = function () {
        return self.age;
    };
};

var a = new ( inherits(A, B) )(); // Inheritance completed with success
console.log('is [ a ] instance of A ? ', a instanceof A);// true
console.log('is [ a ] instance of B ? ', a instanceof B);// true
console.log('Age: ', a.getAge());// 32