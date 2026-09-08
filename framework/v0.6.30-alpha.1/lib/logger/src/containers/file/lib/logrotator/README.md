![Logrotator](https://raw.githubusercontent.com/karthickapps/logrotator/master/logrotator-logo.png)

# Logrotator

Log rotation in pure javascript.

Log rotation is performed based on the size of the file.
If the file size reaches the designated limit, rotation takes place.

Rotation is based on copying the file contents and then truncating the file size to 0.
This way we avoid file renaming problems where programs are not always prepared to handle a log file being renamed.

## Usage

```javascript
var logrotate = require('logrotator');

// use the global rotator
var rotator = logrotate.rotator;

// or create a new instance
// var rotator = logrotate.create();

// check file rotation every 5 minutes, and rotate the file if its size exceeds 10 mb.
// keep only 3 rotated files and compress (gzip) them.
rotator.register('/var/log/myfile.log', {schedule: '5m', size: '10m', compress: true, count: 3});

rotator.on('error', function(err) {
  console.log('oops, an error occured!');
});

// 'rotate' event is invoked whenever a registered file gets rotated
rotator.on('rotate', function(file) {
  console.log('file ' + file + ' was rotated!');
});

```

## API

#### `register(file, options)`

Schedules a file for rotation. emits a 'rotate' event whenever the file has been rotated.

* `file` - full file path to rotate
* `options` - rotation options:
  * `schedule` - how often to check for file rotation conditions. possible values are '1s', '1m', '1h'. default is 5m.
  * `size` - size of the file to trigger rotation. possible values are '1k', '1m', '1g'. default is 10m.
  * `count` - number of files to keep. default is 3.
  * `compress` - whether to gzip rotated files. default is true.
  * `format` - a function to build the name of a rotated file. the function receives the index of the rotated file.
                 default format is the index itself

#### `unregister(file)`

Remove the scheduled rotation of a file

* `file` - the file to stop rotating

#### `stop()`

Remove all the scheduled file rotations.

* `file` - the file to stop rotating

#### `rotate(file, options, cb)`

Rotate a file now if size conditions are met.

* `file` - full file path to rotate
* `options` - rotation options:
  * `size` - size of the file to trigger rotation. possible values are '1k', '1m', '1g'. default is 10m.
  * `count` - number of files to keep. default is 3.
  * `compress` - whether to gzip rotated files. default is true.
  * `format` - a function to build the name of a rotated file. the function receives the index of the rotated file.
               default format is the index itself

## License

The MIT License (MIT)

Copyright (c) 2016 Capriza

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
