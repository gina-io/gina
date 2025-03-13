var inherits = require('../src/main.js');// Not needed if the framework installed

var A = function() {
    this.name = "A";

    var self = this, local = {};
    local.name = 'Michael Jackson';
    this.getName = function () {
        return local.name
    };

    this.say('some song on the juke box')// => playing some song on the juke box
};


var B = function(gender) {//Super Class
    this.name = "B";
    
    var self = this, local = {};
    //var self = {}; for private ?
    local.gender = gender || 'female';
    local.name = 'Julia Roberts';
    local.age = 46;


    this.getAge = function () {
        return local.age;
    }

    this.getGender = function() {
        return local.gender
    }

    this.protected = { // exposed to derived
        say : function(song) {
            console.log('playing ' + song)
        },
        getAge : self.getAge,
        getGender : self.getGender
    }

};


var A = inherits(A, B);
var a = new A('male');

console.log('is [ a ] instance of A ? ', a instanceof A);// => true
console.log('is [ a ] instance of B ? ', a instanceof B);// => true
console.log('Name: ', a.getName() );// => Michael Jackson
console.log('Age: ', a.getAge() );// => 46
console.log('Gender: ', a.getGender());// => male
a.say('A, B, C !'); // playing A, B, C !