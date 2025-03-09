var rts  = require('./routing.json');
var up  = new (require('./index.js'))({fqdn : 'toto.com'}, rts);
var testMocks  = require('./mocks.json');


function mocksTest(target) {
    var index;
    var i;
    var res;

    var worked = true;
    var localWorked;

    for (index in testMocks) {
        if (target.test(index)) {
            localWorked = true;
            i = 0;

            for (; i < testMocks[index].length; ++i) {
                res = up.path(testMocks[index][i].route, testMocks[index][i].args);
                localWorked = localWorked && (res == testMocks[index][i].result);
                console.log('route    : ' + testMocks[index][i].route);
                console.log('args     :', testMocks[index][i].args);
                console.log('expected : ' + testMocks[index][i].result);
                console.log('get      : ' + res);
                console.log('result   : ' + (res == testMocks[index][i].result));
                console.log('\n')
            }
            worked = worked && localWorked;
            console.log('\n');
        }
    }

    if (worked) {
        console.log('OK')
    } else {
        console.log('NOT OK')
    }
};
//mocksTest(/default/);
//mocksTest(/test1/);
//mocksTest(/test2/);
//mocksTest(/test3/);
//mocksTest(/test4/);
//mocksTest(/test5/);
//mocksTest(/test6/);
//mocksTest(/test7/);
//mocksTest(/test8/);
//mocksTest(/error/);
mocksTest(/.*/)




//var trueRTS  = require('../../config/routing.json');
//var up2  = new (require('./index.js'))({fqdn : 'toto.com'}, trueRTS);
//var res = up.path('home', { "culture" : 'ger', "toto": "toto"});
//console.log('get      : ' + res);