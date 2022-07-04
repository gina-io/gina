/**
 * Merging 2 objects
 * */
'use strict';
var merge = require('../src/main');// Not needed if the framework installed

var a = {
    status: 'ok',
    msg: 'hello world !',
    page: {
        content: 'index.html',
        list: ['apple', 'orange', 'mango']
    }
};

var b = {
    "status": "ko",
    "msg": "hello Jane !",
    "page": {
        "action": "home",
        "ext": ".html",
        "content": "home.html"
    }
};

var result = merge(a, b, true);

console.log('result: ', JSON.stringify(result, null, 4));