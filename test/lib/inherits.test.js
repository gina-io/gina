var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var EventEmitter = require('events').EventEmitter;

var inherits = require('../../framework/v0.1.6-alpha.177/lib/inherits/src/main');


// 01 — Simple inheritance
describe('01 - Simple inheritance', function () {

    var A = function () {
        this.name = 'A';
        var self = this, local = {};
        this.gender = 'female';
        local.name = 'Julia Roberts';
        this.getName = function () { return local.name };
    };

    var B = function (gender) {
        this.name = 'B';
        var self = this, local = {};
        this.gender = gender;
        local.name = 'Michael Jackson';
        local.age = 46;
        this.getAge = function () { return local.age };
        this.getGender = function () { return self.gender };
    };

    var a = new (inherits(A, B))('male');

    it('Object created', function () {
        assert.equal(typeof(a), 'object');
    });

    it('Has both instances', function () {
        assert.equal(a instanceof A, true);
        assert.equal(a instanceof B, true);
    });

    it('Instances is named after the source class', function () {
        assert.equal(a.name, 'A');
    });

    it('Super is overrided', function () {
        assert.equal(a.gender, 'female');
        assert.equal(a.getGender(), 'female');
    });

    it('Can access public members', function () {
        assert.equal(a.getName(), 'Julia Roberts');
        assert.equal(a.getAge(), 46);
    });

    it('Got arguments', function () {
        assert.equal(a.gender, 'female');
    });
});


// 02 — Super attribute overridden by child on init
describe('02 - Super attribute overridden by child on init', function () {

    var A = function () {
        this.age = 32;
        this.init();
    };

    var B = function () {
        var self = this;
        this.initialized = false;
        this.age = 46;
        this.init = function () { self.initialized = true };
        this.getAge = function () { return self.age };
    };

    var a = new (inherits(A, B))();

    it('Object created', function () {
        assert.equal(typeof(a), 'object');
        assert.equal(a.initialized, true);
    });

    it('Has both instances', function () {
        assert.equal(a instanceof A, true);
        assert.equal(a instanceof B, true);
    });

    it('Super overriden', function () {
        assert.equal(a.getAge(), 32);
    });
});


// 03 — Inheriting EventEmitter
describe('03 - Inheriting EventEmitter', function () {

    var A = function () {
        this.init();
    };

    var B = function () {
        var self = this;
        this.age = 33;

        this.init = function () { incrementYears() };

        var incrementYears = function () {
            if (self.age < 36) {
                ++self.age;
                setTimeout(incrementYears, 500);
            } else {
                self.emit('b#done');
            }
        };

        this.getAge = function () { return self.age };

        this.onYearsPast = function (callback) {
            self.once('b#done', function () { callback() });
        };
    };

    B = inherits(B, EventEmitter);
    var AB = inherits(A, B);
    var a = new AB();

    it('Object created', function () {
        assert.equal(typeof(a), 'object');
    });

    it('Is instance of these 3: A, B & EventEmitter', function () {
        assert.equal(a instanceof A, true);
        assert.equal(a instanceof B, true);
        assert.equal(a instanceof EventEmitter, true);
    });

    it('Can create events', function (t, done) {
        a.onYearsPast(function () {
            assert.equal(a.getAge(), 36);
            done();
        });
    });
});
