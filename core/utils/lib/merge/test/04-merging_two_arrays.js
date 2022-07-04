var merge = require('../src/main');// Not needed if the framework installed

var a = null;
var b = null;
var c = null;
var setVariable = function () {
    a = [];
    b = ['apple', 'orange', 'mango'];
    c = ['green', 'yellow'];
};

setVariable();
var AtoBwithOverride    = merge(a, b, true);
setVariable();
var BtoAwithOverride    = merge(b, a, true);
setVariable();
var BtoCwithOverride    = merge(b, c, true);
setVariable();
var AtoBwithoutOverride = merge(a, b);
setVariable();
var BtoAwithoutOverride = merge(b, a);
setVariable();
var BtoCwithoutOverride = merge(b, c);

exports['Merge : A<-B with override'] = function(test) {
    var res = ['apple', 'orange', 'mango'];

    test.equal( Array.isArray(AtoBwithOverride), true );
    test.deepEqual(AtoBwithOverride, res);

    test.done()
}
exports['Merge : B<-A with override'] = function(test) {
    var res = [];

    test.equal( typeof(BtoAwithOverride), 'object' );
    test.deepEqual(BtoAwithOverride, res);

    test.done()
}
exports['Merge : B<-C with override'] = function(test) {
    var res = ['green', 'yellow'];

    test.equal( typeof(BtoCwithOverride), 'object' );
    test.deepEqual(BtoCwithOverride, res);

    test.done()
}


exports['Merge : A<-B without override'] = function(test) {
    var res = ['apple', 'orange', 'mango'];

    test.equal( typeof(AtoBwithoutOverride), 'object' );
    test.deepEqual(AtoBwithoutOverride, res);

    test.done()
}

exports['Merge : B<-A without override'] = function(test) {
    var res = ['apple', 'orange', 'mango'];

    test.equal( typeof(BtoAwithoutOverride), 'object' );
    test.deepEqual(BtoAwithoutOverride, res);

    test.done()
}

exports['Merge : B<-C without override'] = function(test) {
    var res = ['apple', 'orange', 'mango', 'green', 'yellow'];

    test.equal( typeof(BtoCwithoutOverride), 'object' );
    test.deepEqual(BtoCwithoutOverride, res);

    test.done()
}

exports['Compare : A<-B with override & B<-A without override'] = function(test) {
    test.deepEqual(AtoBwithOverride, BtoAwithoutOverride);

    test.done()
}
exports['Compare : B<-A with override & A<-B without override'] = function(test) {
    test.notDeepEqual(AtoBwithoutOverride, BtoAwithOverride);

    test.done()
}