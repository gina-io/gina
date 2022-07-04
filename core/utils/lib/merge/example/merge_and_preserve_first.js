/**
 * - Copies and preserve first object keys & values
 * - Adds new keys & values from others objects
 * */
'use strict';
var merge = require('../src/main');// Not needed if the framework installed

var aNO = {
    "actress": "julia roberts",
    "job": "actress",
    "films": [
        "pretty woman",
        "mirror, mirror"
    ]
};

var bNO = {
    "actor": "tom hanks",
    "job": "actor",
    "films": [
        "philadelphia",
        "forrest gump"
    ]
};

var cNO = {
    "singer": "michael jackson",
    "job": "singer",
    "films": [
        "captain eo",
        "The Wiz"
    ]
};

var resultNO = merge(aNO, bNO, cNO);
console.log(JSON.stringify(resultNO, null, 4));
//=>
//{
//    "actress": "julia roberts",
//    "job": "actress",
//    "films": [
//        "pretty woman",
//        "mirror, mirror"
//    ],
//    "actor": "tom hanks",
//    "singer": "michael jackson"
//}

var a = {
    "actress": "julia roberts",
    "job": "actress",
    "films": [
        "pretty woman",
        "mirror, mirror"
    ]
};

var b = {
    "actor": "tom hanks",
    "job": "actor",
    "films": [
        "philadelphia",
        "forrest gump"
    ]
};

var c = {
    "singer": "michael jackson",
    "job": "singer",
    "films": [
        "captain eo",
        "The Wiz"
    ]
};

var result = merge(a, b, c, true);
console.log(JSON.stringify(result, null, 4));
//=>
//{
//    "actress": "julia roberts",
//    "job": "singer",
//    "films": [
//        "captain eo",
//        "The Wiz"
//    ],
//    "actor": "tom hanks",
//    "singer": "michael jackson"
//}