var merge = require('../src/main');// Not needed if the framework installed


var a = null;
var b = null;
var setVariable = function () {
    a = {
        name: 'Julia Roberts',
        job: 'actress',
        getName: function () {
            return this.name
        },
        getJob: function () {
            return this.job
        }
    };
    b = {
        name: 'Michael Jackson',
        age: 46,
        job: 'singer',
        getAge: function () {
            return this.age
        },
        getJob: function () {
            return 'Job : '+this.job
        }
    };
};

setVariable();
var AtoBwithOverride    = merge(a, b, true);
setVariable();
var BtoAwithOverride    = merge(b, a, true);
setVariable();
var AtoBwithoutOverride = merge(a, b);
setVariable();
var BtoAwithoutOverride = merge(b, a);

exports['Merge : A<-B with override'] = function(test) {
    test.equal( typeof(AtoBwithOverride), 'object' );
    test.equal( AtoBwithOverride.getName(), 'Michael Jackson' );
    test.equal(AtoBwithOverride.getAge(), 46);
    test.equal(AtoBwithOverride.getJob(), 'Job : singer');

    test.done()
}
exports['Merge : B<-A with override'] = function(test) {
    test.equal( typeof(BtoAwithOverride), 'object' );
    test.equal( BtoAwithOverride.getName(), 'Julia Roberts');
    test.equal(BtoAwithOverride.getAge(), 46);
    test.equal(BtoAwithOverride.getJob(), 'actress');

    test.done()
}
exports['Merge : A<-B without override'] = function(test) {
    test.equal( typeof(AtoBwithoutOverride), 'object' );
    test.equal( AtoBwithoutOverride.getName(), 'Julia Roberts');
    test.equal(AtoBwithoutOverride.getAge(), 46);
    test.equal(AtoBwithoutOverride.getJob(), 'actress');

    test.done()
}
exports['Merge : B<-A without override'] = function(test) {
    test.equal( typeof(BtoAwithoutOverride), 'object' );
    test.equal( BtoAwithoutOverride.getName(), 'Michael Jackson' );
    test.equal(BtoAwithoutOverride.getAge(), 46);
    test.equal(BtoAwithoutOverride.getJob(), 'Job : singer');

    test.done()
}

exports['Compare : A<-B with override & B<-A without override'] = function(test) {
    test.equal(AtoBwithOverride.getName(), BtoAwithoutOverride.getName() );
    test.equal(AtoBwithOverride.getAge(), BtoAwithoutOverride.getAge());
    test.equal(AtoBwithOverride.getJob(), BtoAwithoutOverride.getJob());

    test.done()
}
exports['Compare : B<-A with override & A<-B without override'] = function(test) {
    test.equal(AtoBwithoutOverride.getName(), BtoAwithOverride.getName() );
    test.equal(AtoBwithoutOverride.getAge(), BtoAwithOverride.getAge());
    test.equal(AtoBwithoutOverride.getJob(), BtoAwithOverride.getJob());

    test.done()
}