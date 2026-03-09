/**
 * Merging 2 objects
 * */
'use strict';
var merge = require('../index');// Not needed if the framework installed

var a = {
    status: 'ko',
    msg: 'hello world !',
    page : { content: 'index.html' }
}

var b = {
    "status": "ok",
    "msg": "hello world !",
    "page": {
        "action": "toto",
        "ext" : ".html",
        "content" : "home.html"
    }
}

var result = merge(true, a, b);

console.log('result: ', JSON.stringify(result, null, 4));