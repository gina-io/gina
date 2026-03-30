const fs      = require('fs');
const util    = require('util');
const zlib    = require('zlib');
const events  = require('events');

/**
 * Performs scheduled and on demand log rotation on files
 */
function Logrotator() {
  events.EventEmitter.call(this);
  this.timers = {};
}

util.inherits(Logrotator, events.EventEmitter);

/**
 * Schedules a file for rotation. emits a 'rotate' event whenever the file has been rotated.
 * @param file full file path to rotate
 * @param options rotation options
 *  - schedule - how often to check for file rotation conditions. possible values are '1s', '1m', '1h'. default is 5m.
 *  - size - size of the file to trigger rotation. possible values are '1k', '1m', '1g'. default is 10m.
 *  - count - number of files to keep. default is 3.
 *  - compress - whether to gzip rotated files. default is true.
 *  - format - a function to build the name of a rotated file. the function receives the index of the rotated file.
 *            default format is the index itself.
 */
Logrotator.prototype.register = function(file, options) {

  options = util._extend({schedule: '5m'}, options);

  var match = options.schedule.match(/^([0-9]+)(s|m|h)$/);
  if (!match) {
    this.emit('error', 'incorrect schedule format ' + options.schedule);
    return;
  }

  if (this.timers[file]) {
    this.unregister(file);
  }

  // calculate the schedule
  var multi = this._timeMultiplier(match[2]);
  var schedule = parseInt(match[1]) * multi;
  var _this = this;

  // perform rotation
  function _doRotate() {
    _this.rotate(file, options, function(err, rotated) {
      if (err) {
        _this.emit('error', err);
        return;
      }
      if (rotated) {
        _this.emit('rotate', file);
      }
    });
  }

  // register the rotation timer
  this.timers[file] = setInterval(function() {
    _doRotate();
  }, schedule);

  // immediately rotate
  _doRotate();
};

/**
 * Remove the scheduled rotation of a file
 * @param file the file to stop rotating
 */
Logrotator.prototype.unregister = function(file) {
  if (!this.timers[file]) {
    return;
  }

  clearInterval(this.timers[file]);
  delete this.timers[file];
};

/**
 * Stop all schedulers
 */
Logrotator.prototype.stop = function() {
  var _this = this;
  Object.keys(this.timers).forEach(function(name) {
    clearInterval(_this.timers[name]);
  });
  this.timers = {};
};

Logrotator.prototype._timeMultiplier = function(multi) {
  switch (multi) {
    case 's':
      return 1000;
    case 'm':
      return 60*1000;
    case 'h':
      return 60*60*1000;
  }
};

Logrotator.prototype._sizeMultiplier = function(multi) {
  switch (multi) {
    case 'k':
      return 1024;
    case 'm':
      return 1024*1024;
    case 'g':
      return 1024*1024*1024;
  }
};

/**
 * Rotate a file now if size conditions are met.
 * @param file full file path to rotate
 * @param options rotation options
 *  - size - size of the file to trigger rotation. possible values are '1k', '1m', '1g'. default is 10m.
 *  - count - number of files to keep. default is 3.
 *  - compress - gzip rotated files. default is true.
 *  - format - a function to build the name of a rotated file. the function receives the index of the rotated file.
 *            default format is the index itself.
 * @param cb - invoked on completion, receives 'err' on error
 */
Logrotator.prototype.rotate = function(file, options, cb) {

  if (!cb) {
    cb = options;
    options = null;
  }

  options = util._extend({size: '10m', count: 3, compress: true}, options);

  var match = options.size.match(/^([0-9]+)(k|m|g)$/);
  if (!match) {
    cb('incorrect size format ' + options.size);
    return;
  }

  var multi = this._sizeMultiplier(match[2]);
  var size = parseInt(match[1]) * multi;

  // check if the file reached the trigger size
  var _this = this;
  fs.stat(file, function(err, stats) {
    if (err) {
      var message = null;
      // if file does not exist, ignore
      if (err.code !== 'ENOENT') {
        // other errors
        message = file + ' stat failed: ' + err.message;
      }
      cb(message);
      return;
    }

    // this isn't a file
    if (!stats.isFile()) {
      cb(file + ' is not a file');
      return;
    }

    // check file size to see if rotation is needed
    if (stats.size >= size) {
      _this._rotate(file, options.count, options, cb);
    } else {
      cb(null, false);
    }
  });

};

/**
 * Get the correct file name based on params
 * @param file
 * @param index
 * @param options
 * @private
 */
Logrotator.prototype._filename = function(file, index, options) {
  var format = index;
  if (typeof options.format === 'function') {
    format = options.format(index);
  }

  var fileName = file + '.' + format;
  if (options.compress) {
    fileName += '.gz';
  }
  return fileName;
};

/**
 * The log rotation brains
 * @param file
 * @param index
 * @param options
 * @param cb
 * @private
 */
Logrotator.prototype._rotate = function(file, index, options, cb) {

  // rotate all existing files
  // 1. delete last file
  // 2. rename all files to with +1
  // 3. read + compress current log into 1
  // 4. truncate file to size 0
  var _this = this;
  var fileName = this._filename(file, index, options);

  // delete last file
  if (index === options.count) {
    fs.unlink(fileName, function(err) {
      if (err && err.code !== 'ENOENT') {
        cb('error deleting file ' + fileName + ': ' + err.message);
        return;
      }
      _this._rotate(file, --index, options, cb);
    });
    return;
  }

  // rename all files to with +1
  if (index > 0) {
    var renameTo = this._filename(file, index+1, options);
    fs.rename(fileName, renameTo, function(err) {
      if (err && err.code !== 'ENOENT') {
        cb('error renaming file ' + fileName + ': ' + err.message);
        return;
      }
      _this._rotate(file, --index, options, cb);
    });

    return;
  }

  // read (and compress) the file log into index 1
  var fis = fs.createReadStream(file);
  var fos = fs.createWriteStream(this._filename(file, 1, options));
  var pipe;
  if (options.compress) {
    pipe = fis.pipe(zlib.createGzip()).pipe(fos);
  } else {
    pipe = fis.pipe(fos);
  }

  var error;
  pipe.on('finish', function() {
    if (error) {
      return;
    }
    // truncate log file to size 0
    fs.truncate(file, 0, function(err) {
      if (err) {
        cb && cb('error truncating file ' + file + ': ' + err.message);
        return;
      }
      cb && cb(null, true);
    })
  });
  pipe.on('error', function(err) {
    error = true;
    cb('error compressing file ' + file + ': ' + err.message);
    cb = null;
  });
};

// create a new log rotator
module.exports.create = function() {
  return new Logrotator();
};

// global log rotator
module.exports.rotator = new Logrotator();