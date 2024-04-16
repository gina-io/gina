# Gina Frontend Framework

Last updated October 16th, 2016

## Requirements

- [Requirejs](http://requirejs.org/)
- [sass](http://sass-lang.com/install)
- [sass-lint](https://www.npmjs.com/package/sass-lint)
- [csso](https://github.com/css/csso)
- Java (for [Google Closure Compiler](https://developers.google.com/closure/compiler/))

## Installing Dependencies

To be able to compile the GFF (Gina Frontend Framework), you need to install the following node modules.

```tty
npm install -g requirejs
```

`sudo gem install sass` __is deprecated__

```tty
npm install -g sass
```

```tty
npm install -g sass-lint
```

```tty
npm install -g csso@2.2.1
```

## Compiling & minification

```tty
gina build
```
or just for the `dev` environment

```tty
gina build --env=dev
```


### What command lines are used by the build script

Uglify2 is the default compiler.

Locate `/node_modules/gina/core/asset/plugin/gina`.
N.B.: replace ${project} by your project path.

```tty
cd /usr/local/node_modules/gina/node_modules/gina/framework/v.0.1.0/core/asset/plugin
```

You should see at this point a file named `build.json`.
To compile & minify, run the following command line.

```tty
r.js -o build.json
```

Then you need to optimize with closure compiler
> Current used version is : v20220104
> If you need the latest, [visit the project page](https://mvnrepository.com/artifact/com.google.javascript/closure-compiler)
> For compilation issuers :
>
> - [Suppress annotations](https://github.com/google/closure-compiler/wiki/@suppress-annotations)
> - [About warnings](https://github.com/google/closure-compiler/wiki/Warnings)

`gina.js` Optimization options :

- `WHITESPACE_ONLY` - Working (1.11MB -> 513KB)
- `SIMPLE_OPTIMIZATIONS`  - Wanted, but not working yet (from 1.11MB -> 389KB)
- `ADVANCED_OPTIMIZATIONS` - The best if we can make it work :'(

```tty
java -jar ./lib/js/compiler.jar --formatting=SINGLE_QUOTES --compilation_level SIMPLE_OPTIMIZATIONS --jscomp_warning=es5Strict --js ./dist/gina.js --create_source_map ./dist/gina.min.js.map --js_output_file ./dist/gina.min.js
```

**Attention:** look into `dist/gina.min.js.map` to modify `./dist/gina.js` to `./gina.js`

### Building loader

```tty
cd /usr/local/node_modules/gina/node_modules/gina/framework/v.0.1.0/core/asset/plugin
```

```tty
java -jar ./lib/js/compiler.jar --formatting=SINGLE_QUOTES --compilation_level ADVANCED_OPTIMIZATIONS --js ./src/vendor/gina/utils/loader.js --create_source_map ./dist/gina.onload.min.js.map --js_output_file ./dist/gina.onload.min.js
```

### Building SASS assets into CSS

__Popin sample__

If you want to watch `sass/gina-popin.sass` and apply modifications on changes
```tty
sass --watch sass/gina-popin.sass sass/popin.sass:css/popin.css
```

Or just update

```tty
sass --update sass/popin.sass:css/popin.css
```


### Building CSS assets

> **N.B.:** The `<LINK>` `/css/vendor/gina/gina.min.css` will be added through the
> `gina.onload` `<event>`.
> For more this topic, checkout `gina/core/asset/plugin/src/vendor/gina/js/loader/main.js`

```tty
cd ${project}/node_modules/gina/core/asset/plugin
```

#### Without GZIP

```tty
cat ./src/vendor/gina/toolbar/css/toolbar.css ./src/vendor/gina/popin/css/popin.css | csso > ./dist/gina.min.css | csso ./dist/gina.min.css --map ./dist/gina.min.css.map
```

#### With GZIP

```tty
cat ./src/vendor/gina/toolbar/css/toolbar.css ./src/vendor/gina/popin/css/popin.css | csso | gzip -9 -c > ./dist/gina.min.css | csso ./dist/gina.min.css --map ./dist/gina.min.css.map
```

## Using GFF

You can add to your layout the following tag :

```html
<script type="text/javascript" src="{{ '/js/vendor/gina.min.js' | getUrl() }}"></script>
```

Or you can add to you `/config/templates.json` the library path.

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
var socket = eio('ws://localhost:8888');

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
