var inherits = require('../index');
var EventEmitter  = require('events').EventEmitter;

var A = function() {
    this.init() // triggers Super init()
}

var B = function() {//Super Class
    var self = this;
    this.age = 33; // by default

    this.init = function() {
        incrementYears()
    }

    var incrementYears = function() {
        //process.stdout.write('.');
        if(self.age < 36) {
            ++self.age;
            setTimeout(incrementYears, 500)
        } else {
            process.stdout.write('\n\r');
            self.emit('b#done')
        }
    }

    this.getAge = function () {
        return self.age
    }

    this.onYearsPast = function(callback) {
        self.once('b#done', function() {
            callback()
        })
    }
};
// making B inheriting from EventEmitter
B = inherits(B, EventEmitter);
var AB = inherits(A, B);
var a = new AB();

exports['Object created'] = function(test) {
    test.equal( typeof(a), 'object' );
    test.done()
}

exports['Is instance of these 3: A, B & EventEmitter'] = function(test) {
    test.equal(a instanceof A, true);
    test.equal(a instanceof B, true);
    test.equal(a instanceof EventEmitter, true);
    test.done()
}

exports['Can create events'] = function(test) {
    process.stdout.write('  testing events, please wait...');
    a.onYearsPast( function() {
        test.equal(a.getAge(), 36);
        test.done()
    })
}