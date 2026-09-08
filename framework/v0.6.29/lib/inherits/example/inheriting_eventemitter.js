var inherits = require('../src/main.js');// Not needed if the framework installed
var EventEmitter  = require('events').EventEmitter;

var A = function() {
    this.name = "A";

    console.log('You once were '+ this.age); // You once were 33
    this.init(); // triggers Super init()
};

var B = function() {//Super Class
    this.name = "B";

    var self = this;
    this.age = 33; // by default

    this.init = function() {
        incrementYears();
    };

    var incrementYears = function() {

        if(self.age < 36) {
            ++self.age;
            console.log('Happy birthday, you are now '+ self.age);
            setTimeout(incrementYears, 1000);
        } else {
            self.emit('super#done')
        }
    }


    this.getAge = function () {
        return self.age;
    };

    this.onPast35 = function(callback) {
        self.once('super#done', function() {
            callback()
        })
    }
};
// making B inheriting from EventEmitter
B = inherits(B, EventEmitter);
var AB = inherits(A, B);
var a = new AB();
a.onPast35( function() {
    console.log('Time has past and you are now ', a.getAge());// Time has past and you are now 36

    console.log('is [ a ] instance of A ? ', a instanceof A);// true
    console.log('is [ a ] instance of B ? ', a instanceof B);// true
    console.log('is [ a ] instance of EventEmitter ? ', a instanceof EventEmitter);// true
})

