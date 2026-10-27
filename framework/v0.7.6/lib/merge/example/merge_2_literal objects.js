/**
 * Merging 2 litteral objects
 * */
'use strict';
var merge = require('../src/main');// Not needed if the framework installed

var aNO = {
    name: 'Julia Roberts',
    job: 'actress',
    getName: function () {
        return this.name
    },
    getJob: function () {
        return this.job
    }
}

var bNO = {
    name: 'Michael Jackson',
    age: 46,
    job: 'singer',
    getAge: function () {
        return this.age
    },
    getJob: function () {
        return 'Job : '+this.job
    }
}

var resultNO = merge(aNO, bNO);

console.log('Name: ', resultNO.getName());  // Julia Robert
console.log('Age: ', resultNO.getAge());   // 46
console.log('Job: ', resultNO.getJob());   // actress


var a = {
    name: 'Julia Roberts',
    job: 'actress',
    getName: function () {
        return this.name
    },
    getJob: function () {
        return this.job
    }
}

var b = {
    name: 'Michael Jackson',
    age: 46,
    job: 'singer',
    getAge: function () {
        return this.age
    },
    getJob: function () {
        return 'Job : '+this.job
    }
}

var result = merge(a, b, true);

console.log('Name: ', result.getName());  // Michael Jackson
console.log('Age: ', result.getAge());   // 46
console.log('Job: ', result.getJob());   // Job : singer