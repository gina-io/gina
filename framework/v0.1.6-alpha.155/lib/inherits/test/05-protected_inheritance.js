//var inherits = require('../src/main');
//
//var A = function() {
//    var self = this;
//    this.name = 'Michael Jackson';
//    this.getName = function () {
//        return self.name
//    };
//
//    this.say('some song on the juke box')// => playing some song on the juke box
//};
//
//
//var B = function(gender) {//Super Class
//    var self = this;
//    this.gender = gender || 'female';
//    this.name = 'Julia Roberts';
//    this.age = 46;
//
//
//    this.getAge = function () {
//        return self.age;
//    }
//
//    this.getGender = function() {
//        return self.gender
//    }
//
//    this.protected = { // exposed to derived
//        say : function(song) {
//            return 'playing ' + song
//        },
//        getAge : self.getAge,
//        getGender : self.getGender
//    }
//
//};
//
//var a = new ( inherits(A, B) )('male');
//
//exports['Can access protected members'] = function(test) {
//    test.equal(a.name, 'Michael Jackson');
//    test.equal(a.getAge(), 46);
//    test.done()
//}
//
//exports['Public members from Super are forbidden'] = function(test) {
//    test.equal(a.age, undefined);
//    test.done()
//}
//
//exports['Got arguments from child'] = function(test) {
//    test.equal(a.getGender(), 'male');
//    var lyric = 'some song on the juke box';
//    test.equal(a.say(lyric), 'playing ' + lyric);
//    test.done()
//}