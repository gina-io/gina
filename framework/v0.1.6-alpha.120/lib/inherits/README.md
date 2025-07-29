# inherits()

**Package:** gina.lib
**Name:** inherits
**Version:** 0.0.2
**Compatibility:** ECMA-262
**Gina version:** 0.0.8p10
**Status:** unstable



## Summary

`inherits` uses `Object.create()` to allow a class **A** inherit properties from a class **B**  where **B** is the superclass.
Properties/members from the superclass (B) can be overriden by the targeted class (A).
There is two way of inheriting from a superclass:
- inheriting by exposing **all** `public` members of the superclass (default)
- inheriting by exposing **only** `protected` members of the superclass

The result of the operation will return a class with both properties.
`inherits()` is a function from gina.lib. Althought, it can be required without having to install the [framework](https://github.com/rhinostone/gina).

## Syntax
*inherits(ClassA, ClassB)*

> var a = new ( inherits(A, B) );

or

> var AB = inherits(A, B);
> var a = new AB();


**N.B.:** Inheritance will occur before instantiation

### Parameters

**ClassA**
> Target class

**ClassB**
> Super class

### Example - Public inheritance


```javascript
var inherits = require('../inherits.js');// Not needed if the framework installed

var A = function() {
    var _this = this;
    this.name = 'Julia Roberts';
    this.getName = function () {
        return _this.name;
    };
};

var B = function() {
    var _this = this;
    this.name = 'Michael Jackson';
    this.age = 46;

    this.getAge = function () {
        return _this.age;
    };
};

var a = new ( inherits(A, B) );
console.log('is [ a ] instance of A ? ', a instanceof A);// true
console.log('is [ a ] instance of B ? ', a instanceof B);// true
console.log('Name: ', a.getName());// Michael Jackson
console.log('Age: ', a.getAge());// 46
```

**output:**

```tty
is [ a ] instance of A ?  true
is [ a ] instance of B ?  true
Name:  Julia Roberts
Age:  46
```

### Example - Protected inheritance

```javascript
var inherits = require('../inherits.js');// Not needed if the framework installed

var A = function() {
    var _this = this;
    this.name = 'Michael Jackson';
    this.getName = function () {
        return _this.name
    };

    this.say('some song on the juke box')// => playing some song on the juke box
};


var B = function(gender) {//Super Class
    var _this = this;
    //var self = {}; for private
    this.gender = gender || 'female';
    this.name = 'Julia Roberts';
    this.age = 46;


    this.getAge = function () {
        return _this.age;
    }

    this.getGender = function() {
        return _this.gender
    }

    this.protected = { // exposed to derived
        say : function(song) {
            console.log('playing ' + song)
        },
        getAge : _this.getAge,
        getGender : _this.getGender
    }

};


var a = new ( inherits(A, B) )('male');
console.log('is [ a ] instance of A ? ', a instanceof A);// => true
console.log('is [ a ] instance of B ? ', a instanceof B);// => true
console.log('Name: ', a.getName() );// => Michael Jackson
console.log('Age: ', a.getAge() );// => 46
console.log('Gender: ', a.getGender());// => male
a.say('A, B, C !'); // playing A, B, C !

```

**output:**
```tty
playing some song on the juke box
is [ a ] instance of A ?  true
is [ a ] instance of B ?  true
Name:  Michael Jackson
Age:  46
Gender:  male
playing A, B, C !
```
