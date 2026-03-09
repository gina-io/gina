/**
 * - Copies and preserve first object keys & values
 * - Adds new keys & values from others objects
 * */
'use strict';
var merge = require('../index');// Not needed if the framework installed

var a = {
    "actress": "julia roberts",
    "films": [
        "pretty woman",
        "mirror, mirror"
    ]
};

var b = {
    "actor": "tom hanks",
    "films": [
        "philadelphia",
        "forrest gump"
    ]
};

var c = {
    "singer": "michael jackson",
    "films": [
        "captain eo",
        "The Wiz"
    ]
};

var result = merge(a, b, c);
console.log(JSON.stringify(result, null, 4));
// =>
// {
//     "actress": "julia roberts",
//     "films": [
//         "pretty woman",
//         "mirror, mirror"
//     ],
//     "actor": "tom hanks",
//     "singer": "michael jackson"
// }