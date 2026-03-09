/**
 * Merging 2 litteral objects
 * */
'use strict';
var merge = require('../index');// Not needed if the framework installed

var a = {
    name: 'Julia Roberts',
    getName: function () {
        return this.name;
    }
}

var b = {
    name: 'Michael Jackson',
    age: 46,
    getAge: function () {
        return this.age;
    }
}

var result = merge(a, b);

console.log('Name: ', a.getName());  // Julia Robert
console.log('Age: ', a.getAge());   // 46