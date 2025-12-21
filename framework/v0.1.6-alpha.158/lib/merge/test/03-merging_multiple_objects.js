var merge = require('../src/main');// Not needed if the framework installed

var a = null;
var b = null;
var c = null;
var setVariable = function () {
    a = {
        "actress": "julia roberts",
        "job": "actress",
        "films": [
            "pretty woman",
            "mirror, mirror"
        ]
    };
    b = {
        "actor": "tom hanks",
        "job": "actor",
        "films": [
            "philadelphia",
            "forrest gump"
        ]
    };
    c = {
        "singer": "michael jackson",
        "job": "singer",
        "films": [
            "captain eo",
            "The Wiz"
        ]
    };
};

setVariable();
var AtoBtoCwithOverride = merge(a, b, c, true);
setVariable();
var AtoCtoBwithOverride = merge(a, c, b, true);
setVariable();
var BtoAtoCwithOverride = merge(b, a, c, true);
setVariable();
var BtoCtoAwithOverride = merge(b, c, a, true);
setVariable();
var CtoAtoBwithOverride = merge(c, a, b, true);
setVariable();
var CtoBtoAwithOverride = merge(c, b, a, true);

setVariable();
var AtoBtoCwithoutOverride = merge(a, b, c);
setVariable();
var AtoCtoBwithoutOverride = merge(a, c, b);
setVariable();
var BtoAtoCwithoutOverride = merge(b, a, c);
setVariable();
var BtoCtoAwithoutOverride = merge(b, c, a);
setVariable();
var CtoAtoBwithoutOverride = merge(c, a, b);
setVariable();
var CtoBtoAwithoutOverride = merge(c, b, a);

exports['Merge : A<-B<-C with override'] = function(test) {
    var res = {
        "actor": "tom hanks",
        "actress": "julia roberts",
        "job": "singer",
        "films": [
            "captain eo",
            "The Wiz"
        ],

        "singer": "michael jackson"
    }
    test.equal( typeof(AtoBtoCwithOverride), 'object' );
    test.deepEqual(AtoBtoCwithOverride, res);

    test.done()
}
exports['Merge : A<-C<-B with override'] = function(test) {
    var res = {
        "actress": "julia roberts",
        "job": "actor",
        "films": [
            "philadelphia",
            "forrest gump"
        ],
        "actor": "tom hanks",
        "singer": "michael jackson"
    }
    test.equal( typeof(AtoCtoBwithOverride), 'object' );
    test.deepEqual(AtoCtoBwithOverride, res);

    test.done()
}
exports['Merge : B<-A<-C with override'] = function(test) {
    var res = {
        "actress": "julia roberts",
        "job": "singer",
        "films": [
            "captain eo",
            "The Wiz"
        ],
        "actor": "tom hanks",
        "singer": "michael jackson"
    }
    test.equal( typeof(BtoAtoCwithOverride), 'object' );
    test.deepEqual(BtoAtoCwithOverride, res);

    test.done()
}
exports['Merge : B<-C<-A with override'] = function(test) {
    var res = {
        "actress": "julia roberts",
        "job": "actress",
        "films": [
            "pretty woman",
            "mirror, mirror"
        ],
        "actor": "tom hanks",
        "singer": "michael jackson"
    }
    test.equal( typeof(BtoCtoAwithOverride), 'object' );
    test.deepEqual(BtoCtoAwithOverride, res);

    test.done()
}
exports['Merge : C<-A<-B with override'] = function(test) {
    var res = {
        "actress": "julia roberts",
        "job": "actor",
        "films": [
            "philadelphia",
            "forrest gump"
        ],
        "actor": "tom hanks",
        "singer": "michael jackson"
    }
    test.equal( typeof(CtoAtoBwithOverride), 'object' );
    test.deepEqual(CtoAtoBwithOverride, res);

    test.done()
}
exports['Merge : C<-B<-A with override'] = function(test) {
    var res = {
        "actress": "julia roberts",
        "job": "actress",
        "films": [
            "pretty woman",
            "mirror, mirror"
        ],
        "actor": "tom hanks",
        "singer": "michael jackson"
    }
    test.equal( typeof(CtoBtoAwithOverride), 'object' );
    test.deepEqual(CtoBtoAwithOverride, res);

    test.done()
}

exports['Merge : A<-B<-C without override'] = function(test) {
    var res = {
        "actor": "tom hanks",
        "actress": "julia roberts",
        "films": [
            "pretty woman",
            "mirror, mirror",
            "philadelphia",
            "forrest gump",
            "captain eo",
            "The Wiz"
        ],
        "job": "actress",
        "singer": "michael jackson"
    }
    test.equal( typeof(AtoBtoCwithoutOverride), 'object' );
    test.deepEqual(AtoBtoCwithoutOverride, res);

    test.done()
}
exports['Merge : A<-C<-B without override'] = function(test) {
    var res = {
        "actor": "tom hanks",
        "actress": "julia roberts",
        "films": [
            "pretty woman",
            "mirror, mirror",
            "captain eo",
            "The Wiz",
            "philadelphia",
            "forrest gump"
        ],
        "job": "actress",
        "singer": "michael jackson"
    }
    test.equal( typeof(AtoCtoBwithoutOverride), 'object' );
    test.deepEqual(AtoCtoBwithoutOverride, res);

    test.done()
}
exports['Merge : B<-A<-C without override'] = function(test) {
    var res = {
        "actor": "tom hanks",
        "actress": "julia roberts",
        "films": [
            "philadelphia",
            "forrest gump",
            "pretty woman",
            "mirror, mirror",
            "captain eo",
            "The Wiz"
        ],
        "job": "actor",
        "singer": "michael jackson"
    }
    test.equal( typeof(BtoAtoCwithoutOverride), 'object' );
    test.deepEqual(BtoAtoCwithoutOverride, res);

    test.done()
}
exports['Merge : B<-C<-A without override'] = function(test) {
    var res = {
        "actor": "tom hanks",
        "actress": "julia roberts",
        "films": [
            "philadelphia",
            "forrest gump",
            "captain eo",
            "The Wiz",
            "pretty woman",
            "mirror, mirror"
        ],
        "job": "actor",
        "singer": "michael jackson"
    }
    test.equal( typeof(BtoCtoAwithoutOverride), 'object' );
    test.deepEqual(BtoCtoAwithoutOverride, res);

    test.done()
}
exports['Merge : C<-A<-B without override'] = function(test) {
    var res = {
        "actor": "tom hanks",
        "actress": "julia roberts",
        "films": [
            "captain eo",
            "The Wiz",
            "pretty woman",
            "mirror, mirror",
            "philadelphia",
            "forrest gump"
        ],
        "job": "singer",
        "singer": "michael jackson"
    }
    test.equal( typeof(CtoAtoBwithoutOverride), 'object' );
    test.deepEqual(CtoAtoBwithoutOverride, res);

    test.done()
}
exports['Merge : C<-B<-A without override'] = function(test) {
    var res = {
        "actor": "tom hanks",
        "actress": "julia roberts",
        "films": [
            "captain eo",
            "The Wiz",
            "philadelphia",
            "forrest gump",
            "pretty woman",
            "mirror, mirror"
        ],
        "job": "singer",
        "singer": "michael jackson"
    }
    test.equal( typeof(CtoBtoAwithoutOverride), 'object' );
    test.deepEqual(CtoBtoAwithoutOverride, res);

    test.done()
}


exports['Compare : (A<-B<-C && A<-C<-B without override) && (B<-C<-A && C<-B<-A with override)'] = function(test) {
    test.notDeepEqual(AtoBtoCwithoutOverride, AtoCtoBwithoutOverride);
    test.notDeepEqual(AtoCtoBwithoutOverride, BtoCtoAwithOverride);
    test.deepEqual(BtoCtoAwithOverride, CtoBtoAwithOverride);
    test.notDeepEqual(CtoBtoAwithOverride, AtoBtoCwithoutOverride);

    test.done()
}
exports['Compare : (B<-A<-C && B<-C<-A without override) && (A<-C<-B && C<-A<-B with override)'] = function(test) {
    test.notDeepEqual(BtoAtoCwithoutOverride, BtoCtoAwithoutOverride);
    test.notDeepEqual(BtoCtoAwithoutOverride, AtoCtoBwithOverride);
    test.deepEqual(AtoCtoBwithOverride, CtoAtoBwithOverride);
    test.notDeepEqual(CtoAtoBwithOverride, BtoAtoCwithoutOverride);

    test.done()
}
exports['Compare : (C<-A<-B && C<-B<-A without override) && (A<-B<-C && B<-A<-C with override)'] = function(test) {
    test.notDeepEqual(CtoAtoBwithoutOverride, CtoBtoAwithoutOverride);
    test.notDeepEqual(CtoBtoAwithoutOverride, AtoBtoCwithOverride);
    test.deepEqual(AtoBtoCwithOverride, BtoAtoCwithOverride);
    test.notDeepEqual(BtoAtoCwithOverride, CtoAtoBwithoutOverride);

    test.done()
}