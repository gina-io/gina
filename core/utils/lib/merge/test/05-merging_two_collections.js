var merge = require('../src/main');// Not needed if the framework installed

var a = null;
var b = null;
var c = null;
var setVariable = function () {
    a = [];
    b = [
        {
            id: 1,
            value: 'apple'
        },
        {
            id: 2,
            value: 'orange'
        },
        {
            id: 3,
            value: 'mango'
        }
    ];
    c = [
        {
            id: 1,
            value: 'green'
        },
        {
            id: 4,
            value: 'yellow'
        },
        {
            id: 3,
            value: 'mango'
        }
    ];
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
    var res = [
        {
            id: 1,
            value: 'apple'
        },
        {
            id: 2,
            value: 'orange'
        },
        {
            id: 3,
            value: 'mango'
        }
    ];

    test.equal( Array.isArray(AtoBwithOverride), true );
    test.deepEqual(AtoBwithOverride, res);

    test.done()
}
exports['Merge : B<-A with override'] = function(test) {
    var res = [];

    test.equal( Array.isArray(BtoAwithOverride), true );
    test.deepEqual(BtoAwithOverride, res);

    test.done()
}
exports['Merge : B<-C with override'] = function(test) {
    var res = [
        {
            id: 1,
            value: 'green'
        },
        {
            id: 2,
            value: 'orange'
        },
        {
            id: 3,
            value: 'mango'
        },
        {
            id: 4,
            value: 'yellow'
        }
    ];

    test.equal( Array.isArray(BtoAwithOverride), true );
    test.deepEqual(BtoCwithOverride, res);

    test.done()
}


exports['Merge : A<-B without override'] = function(test) {
    var res = [
        {
            id: 1,
            value: 'apple'
        },
        {
            id: 2,
            value: 'orange'
        },
        {
            id: 3,
            value: 'mango'
        }
    ];

    test.equal( Array.isArray(BtoAwithOverride), true );
    test.deepEqual(AtoBwithoutOverride, res);

    test.done()
}

exports['Merge : B<-A without override'] = function(test) {
    var res = [
        {
            id: 1,
            value: 'apple'
        },
        {
            id: 2,
            value: 'orange'
        },
        {
            id: 3,
            value: 'mango'
        }
    ];

    test.equal( Array.isArray(BtoAwithOverride), true );
    test.deepEqual(BtoAwithoutOverride, res);

    test.done()
}

exports['Merge : B<-C without override'] = function(test) {
    var res = [
        {
            id: 1,
            value: 'apple'
        },
        {
            id: 2,
            value: 'orange'
        },
        {
            id: 3,
            value: 'mango'
        },
        {
            id: 4,
            value: 'yellow'
        }
    ];

    test.equal( Array.isArray(BtoAwithOverride), true );
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