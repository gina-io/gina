var merge = require('../src/main');// Not needed if the framework installed

var a = null;
var b = null;
var bUnordered = null;
var c = null;

var setVariable = function () {

    a = { // config/app.json
        "name" : "dashboard",
        "version" : "0.0.1",
        "proxy": {
            "coreapi": {
                "_comment": "this is the targeted host to send API queries: pointing to coreapi env",
                "ca": "{projectPath}/ssl/server/myproject.local.pem",
                "hostname" : "coreapi@myproject",
                //"protocol": "https",
                "port": "coreapi@myproject",
                "path": "/api"
            },
            "dashboard": {
              "_comment": "this is the targeted host to send Dashboard queries: pointing to Dashboard env",
              "ca": "{projectPath}/ssl/server/myproject.local.pem",
              "hostname" : "dashboard@myproject",
              "port": "dashboard@myproject",
              "path": "/"
            }
        },

        "apis": {
            "googleFonts": {
                "apiKey": "464vzvgzeghéhzzr644h684hz4hrz8rhk4khjj"
            }
        }
    };

    b = { // config/app.dev.json
        // this setting is only for dev purposes
        "proxy": {
          "coreapi": {
            "rejectUnauthorized": false, // will be disabled on production
            "ca": "{projectPath}/ssl/server/myproject.local.pem"
          },
          "dashboard": {
            "rejectUnauthorized": false, // will be disabled on production
            "ca": "{projectPath}/ssl/server/myproject.local.pem"
          }
        }
    };

    bUnordered = { // config/app.dev.json
        // this setting is only for dev purposes
        "proxy": {
            "dashboard": {
                "rejectUnauthorized": false, // will be disabled on production
                "ca": "{projectPath}/ssl/server/myproject.local.pem",
            },
            "coreapi": {
                "rejectUnauthorized": false, // will be disabled on production
                "ca": "{projectPath}/ssl/server/myproject.local.pem",
          }
        }
    };

    c = {
        host    : undefined, // Must be an IP
        hostname  : undefined, // cname of the host e.g.: `www.google.com` or `localhost`
        path    : undefined, // e.g.: /test.html
        port    : 80, // #80 by default but can be 3000 or <bundle>@<project>/<environment>
        method  : 'GET', // POST | GET | PUT | DELETE
        keepAlive: true,
        auth: undefined, // use `"username:password"` for basic authentification

        // set to false to ignore certificate verification when requesting on https (443)
        rejectUnauthorized: true,

        headers: {
            'content-type': 'application/json',
            'content-length': 327
        },
        agent   : false
    }
};

setVariable();
var CtoBtoAwithoutOverride = merge(a.proxy.dashboard, b.proxy.dashboard, c);
var CtoBUnorderedtoAwithoutOverride = merge(a.proxy.dashboard, bUnordered.proxy.dashboard, c);


exports['Merge : A<-B<-C without override'] = function(test) {
    var res = {
        "_comment": "this is the targeted host to send Dashboard queries: pointing to Dashboard env",
        "ca": "{projectPath}/ssl/server/myproject.local.pem",
        "hostname": "dashboard@myproject",
        "port": "dashboard@myproject",
        "path": "/",
        "rejectUnauthorized": false,
        "method": "GET",
        "keepAlive": true,
        "headers": {
            "content-type": "application/json",
            "content-length": 327
        },
        "agent": false
    };
    test.equal( typeof(CtoBtoAwithoutOverride), 'object' );
    test.deepEqual(CtoBtoAwithoutOverride, res);

    test.equal( typeof(CtoBUnorderedtoAwithoutOverride), 'object' );
    test.deepEqual(CtoBUnorderedtoAwithoutOverride, res);

    test.done()
}

// exports['Merge : A<-B with override'] = function(test) {
//     var res = {
//         "page":{
//             "view": {
//                 "file": "factsheets"
//             }
//         }
//     };
//     test.equal( typeof(AtoBwithOverride), 'object' );
//     test.deepEqual(AtoBwithOverride, res);
//
//     test.done()
// }
