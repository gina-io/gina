var merge = require('../src/main');// Not needed if the framework installed
var helpers = require('../../../helpers');

var a = null;
var b = null;
var setVariable = function () {
    a = {
        status: 'ok',
        msg: 'hello world !',
        page: {
            content: 'index.html',
            list: ['apple', 'orange', 'mango'],
            javascripts: [ '/entreprise/handlers/client/main.js' ]
        }
    };
    b = {
        "status": "ko",
        "msg": "hello Jane !",
        "page": {
            "control": "home",
            "ext": ".html",
            "content": "home.html",
            "javascripts": [
                "/entreprise/handlers/client/edit.js",
                "/js/lib/jquery.min.js"
            ]
        }
    }
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
    var res = {
        "status": "ko",
        "msg": "hello Jane !",
        "page": {
            "content": "home.html",
            "list": [
                "apple",
                "orange",
                "mango"
            ],
            "javascripts": [
                "/entreprise/handlers/client/edit.js",
                "/js/lib/jquery.min.js"
            ],
            "control": "home",
            "ext": ".html"
        }
    };
    test.equal( typeof(AtoBwithOverride), 'object' );
    test.deepEqual(AtoBwithOverride, res);

    test.done()
}
exports['Merge : B<-A with override'] = function(test) {
    var res = {
        "status": "ok",
        "msg": "hello world !",
        "page": {
            "content": "index.html",
            "list": [
                "apple",
                "orange",
                "mango"
            ],
            "javascripts": [ "/entreprise/handlers/client/main.js" ],
            "control": "home",
            "ext": ".html"
        }
    };
    test.equal( typeof(BtoAwithOverride), 'object' );
    test.deepEqual(BtoAwithOverride, res);

    test.done()
}
exports['Merge : A<-B without override'] = function(test) {
    var res = {
        "status": "ok",
        "msg": "hello world !",
        "page": {
            "content": "index.html",
            "list": [
                "apple",
                "orange",
                "mango"
            ],
            "javascripts": [
                "/entreprise/handlers/client/main.js",
                "/entreprise/handlers/client/edit.js",
                "/js/lib/jquery.min.js"
            ],
            "control": "home",
            "ext": ".html"
        }
    };
    test.equal( typeof(AtoBwithoutOverride), 'object' );
    test.deepEqual(AtoBwithoutOverride, res);

    test.done()
}
exports['Merge : B<-A without override'] = function(test) {
    var res = {
        "status": "ko",
        "msg": "hello Jane !",
        "page": {
            "content": "home.html",
            "list": [
                "apple",
                "orange",
                "mango"
            ],
            "javascripts": [
                "/entreprise/handlers/client/edit.js",
                "/js/lib/jquery.min.js",
                "/entreprise/handlers/client/main.js"
            ],
            "control": "home",
            "ext": ".html"
        }
    };
    test.equal( typeof(BtoAwithoutOverride), 'object' );
    test.deepEqual(BtoAwithoutOverride, res);

    test.done()
}

exports['Compare : A<-B with override & B<-A without override'] = function(test) {
    test.notDeepEqual(AtoBwithOverride, BtoAwithoutOverride);

    test.done()
}
exports['Compare : B<-A with override & A<-B without override'] = function(test) {
    test.notDeepEqual(AtoBwithoutOverride, BtoAwithOverride);

    test.done()
}