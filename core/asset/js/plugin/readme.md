# Gina Frontend Framework

Last updated October 16th, 2016

## Requirments

- [Requirejs](http://requirejs.org/)
- [csso](https://github.com/css/csso)
- Java & [Google Closure Compiler](https://developers.google.com/closure/compiler/)


## Installing Dependencies
To be able to compile the GFF (Gina Frontend Framework), you need to install the following node modules.

```tty
$ npm install -g requirejs
```

```tty
$ npm install -g csso
```


## Compiling & minification

### Building main frontend framework
Uglify2 is the default compiler.

Locate `/node_modules/gina/core/asset/js/plugin/gina`.
N.B.: replace ${project} by your project path.

```tty
$ cd ${project}/node_modules/gina/core/asset/js/plugin
```

You should see at this point a file named `build.json`.
To compile & minify, run the following command line.

```tty
$ r.js -o build.json
```

### Building loader

```tty
$ cd ${project}/node_modules/gina/core/asset/js/plugin
```

```tty
$ java -jar /usr/local/lib/compiler.jar --formatting=SINGLE_QUOTES --compilation_level ADVANCED_OPTIMIZATIONS --js ./src/gina/utils/loader.js --create_source_map ./dist/gina.onload.min.js.map --js_output_file ./dist/gina.onload.min.js
```


### Building CSS assets

> ** N.B.: ** The <LINK> `/js/vendor/gina/gina.min.css` will be added through the 
 `gina.onload` <event>.
 For more this topic, checkout `gina/core/asset/js/plugin/src/loader/main.js`

```tty
$ cd ${project}/node_modules/gina/core/asset/js/plugin
```

Without GZIP

```tty
$ cat ./src/gina/toolbar/css/toolbar.css ./src/gina/popin/css/popin.css | csso > ./dist/gina.min.css | csso ./dist/gina.min.css --map ./dist/gina.min.css.map
```
With GZIP
```tty
$ cat ./src/gina/toolbar/css/toolbar.css ./src/gina/popin/css/popin.css | csso | gzip -9 -c > ./dist/gina.min.css | csso ./dist/gina.min.css --map ./dist/gina.min.css.map
```



## Using GFF

You can add to your layout the following tag :
```html
<script type="text/javascript" src="{{ '/js/vendor/gina.min.js' | getUrl() }}"></script>
```

Or you can add to you `/config/views.json` the library path.

GFF will be made available on load through the global variable `gina`.

## Events list

```javascript


```

## Classes list
```javascript


```

### Controller

```javascript


```

### Popin

```javascript


```

## Methods list

### .extend
```javascript


```


## Pacakges list

### engine.io (client)
```javascript
var eio = require('engine.io');
var socket = eio('ws://127.0.0.1:8888');

socket.on('open', function(){
    socket.on('close', function(){
        console.debug('closing socket !')
    });

    socket.on('message', function (payload) {
        console.log(payload);
    })
});
```

### uuid
```javascript
var uuid = require('uuid');
console.log('id -> ', uuid.v4() )
```
Sample output
```tty
id ->  f66f698f-9e17-41f9-a3f2-a25b38d6e379
```
Reference: visite the official [repository](https://github.com/broofa/node-uuid)


