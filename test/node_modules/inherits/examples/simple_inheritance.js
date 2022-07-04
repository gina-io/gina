var inherits = require('../index.js');// Not needed if the framework installed

var A = function() {
    var self = this;
    this.gender = 'female';
    this.name = 'Julia Roberts';
    this.getName = function () {
        return self.name;
    };

    this.init();
};

var B = function(gender) {//Super Class
    var self = this;
    this.gender = gender || 'female';
    this.name = 'Michael Jackson';
    this.age = 46;

    this.init = function() {
        console.log(self.age);
    }

    this.getAge = function () {
        return self.age;
    }

    this.getGender = function() {
        return self.gender;
    }
};

var a = new ( inherits(A, B) )('male');
console.log('is [ a ] instance of A ? ', a instanceof A);// true
console.log('is [ a ] instance of B ? ', a instanceof B);// true
console.log('Name: ', a.getName());// Julia Roberts
console.log('Age: ', a.getAge());// 46
console.log('Gender: ', a.getGender() );// female