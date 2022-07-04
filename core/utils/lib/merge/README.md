# merge()

**Package:** gina.utils
**Name:** merge

**Requirement: **


**Description**
Merges the contents of two or more objects together into the first object.
`merge` is a function from gina.utils, but can be require without having to install the [framework](https://github.com/rhinostone/gina).

**usage:** merge(object1, [objectN], [override])


**N.B.:** The function allows you to merge json and literal objects.


You can the following methods to merge objects:
- merge by preserving first object keys
- merge by overriding first object keys

** Copy and preserve first object keys & values **


```javascript
var merge = require('merge');// Not needed if the framework installed
var a = {
    "actress" : "julia roberts",
    "films" : [
        "pretty woman",
        "mirror, mirror"
    ]
};
var b = {
    "actor" : "tom hanks",
    "films" : [
        "philadelphia",
        "forrest gump"
    ]
};
var c = {
    "singer" : "michael jackson",
    "films" : [
        "captain eo",
        "The Wiz"
    ]
};

var result = merge(a, b, c);
console.log(JSON.stringify(result, null, 4));
```

**output:**

```tty
{
    "actress": "julia roberts",
    "films": [
        "pretty woman",
        "mirror, mirror"
    ],
    "actor": "tom hanks",
    "singer": "michael jackson"
}
```



