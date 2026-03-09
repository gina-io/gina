var helpers     = require(__dirname +'/../../../helpers');
var reporter    = null;
try {
    reporter    = require('nodeunit').reporters.default;
} catch (reporterErr) {
    reporter    = null
}

var merge       = require(__dirname + '/../src/main');// Not needed if the framework installed
var filename    = __filename;
var file        = filename.split(/\//g).slice(-1);


var a = null;
var b = null;
var c = null;

var originalA = [
    {
        media: 'screen',
        name: 'default',
        rel: 'stylesheet',
        type: 'text/css',
        url: '/js/vendor/gina/gina.min.css'
    }
];
var originalB = [
    {
        media: 'screen',
        name: 'public',
        rel: 'stylesheet',
        type: 'text/css',
        url: '/js/css/public.min.css'
    }
];
var originalC = [
    {
        media: 'print',
        name: 'pdf',
        rel: 'stylesheet',
        type: 'text/css',
        url: '/js/vendor/gina/gina.min.css'
    }
];

var setVariable = function () {
    a = JSON.clone(originalA);
    b = JSON.clone(originalB);
    c = JSON.clone(originalC);
};


exports['Merge : B<-A without override using key `url`'] = function(test) {

    setVariable();
    merge.setKeyComparison('url');
    var BtoAwithoutOverride = merge(a, b);

    var res = [
        {
            media: 'screen',
            name: 'default',
            rel: 'stylesheet',
            type: 'text/css',
            url: '/js/vendor/gina/gina.min.css'
        },
        {
            media: 'screen',
            name: 'public',
            rel: 'stylesheet',
            type: 'text/css',
            url: '/js/css/public.min.css'
        }
    ];

    test.equal( Array.isArray(BtoAwithoutOverride), true );
    test.deepEqual(BtoAwithoutOverride, res);

    test.deepEqual(originalA, a);
    test.deepEqual(originalB, b);
    test.deepEqual(originalC, c);

    test.done()
}

exports['Merge : A<-B without override using key `url`'] = function(test) {

    setVariable();
    // you can also write it this way
    var BtoAwithoutOverride = merge.setKeyComparison('url')(b, a);

    var res = [
        {
            media: 'screen',
            name: 'public',
            rel: 'stylesheet',
            type: 'text/css',
            url: '/js/css/public.min.css'
        },
        {
            media: 'screen',
            name: 'default',
            rel: 'stylesheet',
            type: 'text/css',
            url: '/js/vendor/gina/gina.min.css'
        }
    ];

    test.equal( Array.isArray(BtoAwithoutOverride), true );
    test.deepEqual(BtoAwithoutOverride, res);

    test.deepEqual(originalA, a);
    test.deepEqual(originalB, b);
    test.deepEqual(originalC, c);

    test.done()
}


exports['Merge : A<-C without override using key `url`'] = function(test) {

    setVariable();
    merge.setKeyComparison('url');
    var CtoAwithoutOverride = merge(a, c);

    var res = [
        {
            media: 'screen',
            name: 'default',
            rel: 'stylesheet',
            type: 'text/css',
            url: '/js/vendor/gina/gina.min.css'
        }
    ];

    test.equal( Array.isArray(CtoAwithoutOverride), true );
    test.deepEqual(CtoAwithoutOverride, res);

    test.deepEqual(originalA, a);
    test.deepEqual(originalB, b);
    test.deepEqual(originalC, c);

    test.done()
}

exports['Merge : A<-C with override using key `url`'] = function(test) {

    setVariable();
    merge.setKeyComparison('url');
    var CtoAwithOverride = merge(a, c, true);

    var res = [
        {
            media: 'print',
            name: 'pdf',
            rel: 'stylesheet',
            type: 'text/css',
            url: '/js/vendor/gina/gina.min.css'
        }
    ];

    test.equal( Array.isArray(CtoAwithOverride), true );
    test.deepEqual(CtoAwithOverride, res);

    test.deepEqual(originalA, a);
    test.deepEqual(originalB, b);
    test.deepEqual(originalC, c);

    test.done()
}


// for debug purpose
if (reporter)
    reporter.run(['test/'+file]);