/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
// nodejs dependencies
if ( typeof(module) !== 'undefined' && module.exports) {

    var fs          = require('fs');
    var JSZip       = require('./dep/jszip.min.js');
    var Emitter     = require('events').EventEmitter;
    var helpers     = require('../../../helpers/index');
    var inherits    = require('../../../lib/inherits');
}


/**
 * Archiver
 *  Every form writes a DEFLATE zip through JSZip, in pure JavaScript — nothing
 *  here touches zlib or libuv's threadpool.
 *
 * @package     Gina.Lib
 * @namespace   Gina.Lib.Archiver
 * @author      Rhinostone <contact@gina.io>
 * */

function Archiver() {


    var self        = this;
    var isGFFCtx    = ((typeof (module) !== 'undefined') && module.exports) ? false :  true;
    var merge       = (isGFFCtx) ? require('lib/merge') : require('../../../lib/merge');


    this.allowedCompressionMethods = ['gzip'];

    var defaultCompressionOptions = {
        tmp         : null,
        method      : 'gzip', // names the completion event (archiver-gzip#complete); no form selects a codec by it
        unlinkSrc   : false,
        name        : 'default',
        level       : 9   // DEFLATE level handed to JSZip
    };

    /**
     * Per-call completion channel (#B473).
     *
     * `compress()` and `decompress()` each hand the caller a `{ onComplete }`
     * handle. The channel behind it is created per call, settles at most once,
     * delivers a listener attached after settlement, and on failure destroys
     * every stream the call tracked, so overlapping calls in one process cannot
     * release each other or close each other's streams. The singleton still
     * emits `eventName` `(err, target)` on settlement, purely for observers —
     * the same shape as the connectors' per-call Promise latch.
     *
     * @inner
     * @private
     * @param {string} eventName - the singleton event to broadcast on settlement
     * @returns {{settle: function, onComplete: function, track: function}} the call's channel
     */
    var createRun = function(eventName) {
        var _resolve, _reject, _settled = false, _target = null, _streams = [];
        var _done = new Promise(function(resolve, reject) {
            _resolve = resolve;
            _reject  = reject;
        });
        // A fire-and-forget caller (no onComplete, no trailing callback) observed
        // silence on failure before; keep it that way rather than surfacing an
        // unhandled rejection. `.then(cb)` consumers still see the rejection.
        _done.catch(function() {});

        return {
            /**
             * Register a stream this call opened, so a failure can release it.
             * @private
             * @param {stream.Stream} stream - readable or writable
             * @returns {stream.Stream} the same stream, for chaining
             */
            track: function(stream) {
                _streams.push(stream);
                return stream;
            },
            /**
             * Settle THIS call, at most once. On an error every tracked stream is
             * destroyed first, so no file descriptor outlives a failed run.
             * @private
             * @param {Error|boolean} err - the error, or `false` on success
             * @param {string|null} target - the archive / extraction path
             * @returns {void}
             */
            settle: function(err, target) {
                if (_settled) {
                    return;
                }
                _settled = true;
                var streams = _streams;
                _streams = [];
                if (err) {
                    for (var s = 0, sLen = streams.length; s < sLen; ++s) {
                        try { streams[s].destroy(); } catch (ignore) { /* already gone */ }
                    }
                    _reject(err);
                } else {
                    _target = target;
                    _resolve(target);
                }
                self.emit(eventName, err, target);
            },
            /**
             * Deliver `(err, target)` to `cb` once settled — including when the
             * call settled before `cb` was attached.
             * @private
             * @param {function} cb - `(err, target)`; `err` is `false` on success
             * @returns {void}
             */
            onComplete: function(cb) {
                _done.then(
                    function()    { cb(false, _target); },
                    function(err) { cb(err, null); }
                ).catch(function(cbErr) {
                    // a throwing callback must stay an uncaught EXCEPTION, as it was
                    // when delivery ran inside the stream handler — never a rejection
                    // that a non-default --unhandled-rejections policy would swallow
                    process.nextTick(function() { throw cbErr; });
                });
            }
        };
    };

    /**
     * Compress a file, a directory, or a list of files and directories into
     * `<target>/<name>.zip`.
     *
     * Every form writes a DEFLATE zip that `decompress()` reads back. The array
     * form takes `[{ input, output }, …]` pairs; the directory form walks the
     * tree, dotfiles included; the single-file form is the array form with one
     * entry named by the file's basename, and `<name>` defaults to that basename.
     *
     * Each call settles its own handle exactly once, so overlapping calls in one
     * process are isolated from each other. Errors on every stream the call
     * opens — input reads, the zip generator, the output write — reach the
     * callback as the stream's error, and a listener attached after the run has
     * settled is still delivered. The singleton also emits
     * `archiver-<method>#complete` `(err, target)` for observers. A run that
     * fails may leave a partial `<target>/<name>.zip` on disk; the next run to
     * the same path removes it before writing.
     *
     * @param {string|Array<{input: string, output: string}>} src - a filename, a dirname, or a list of
     *  `{ input, output }` pairs where `output` is the entry path inside the archive
     * @param {string} target - output directory, created if missing
     * @param {object} [options] - merged over the defaults
     * @param {string} [options.method='gzip'] - names the completion event (`archiver-gzip#complete`); the only accepted value, and no form selects a codec by it
     * @param {string} [options.name='default'] - archive basename
     * @param {number} [options.level=9] - compression level, `0` (store) to `9` (best)
     * @param {function} [cb] - trailing callback `(err, target)` for `promisify`; may stand in for `options`
     * @returns {{onComplete: function}} completion handle — `onComplete(cb)` attaches `(err, target)` and returns the handle
     * @throws {Error} synchronously on any `options.method` other than `gzip` — `br` and `deflate` were accepted but never implemented
     *
     * @example
     *  lib.archiver.compress([{ input: '/srv/app/package.json', output: 'package.json' }], '/backup/', { name: 'app', level: 9 })
     *      .onComplete(function (err, archivePath) {
     *          if (err) { return; }           // e.g. err.code === 'EACCES' on an unreadable input
     *          // archivePath === '/backup/app.zip'
     *      });
     * @example
     *  // promisify shapes — a trailing callback, with or without options
     *  lib.archiver.compress('/var/dump.sql', '/backup/', function (err, archivePath) {});
     */
    this.compress = function(src, target, options) {

        // trailing callback (promisify form): compress(src, target, [options], cb)
        var cb = null;
        if ( typeof(arguments[arguments.length-1]) == 'function' ) {
            cb = arguments[arguments.length-1];
            if ( typeof(options) == 'function' ) {
                options = undefined;
            }
        }

        // a fresh copy: merge() mutates its target, and an omitted `options`
        // used to alias the shared defaults object across calls
        options = merge( merge({}, options || {}), defaultCompressionOptions );

        if ( options.tmp != null ) {
            options.unlinkSrc = true;
        }

        if ( !/\/$/.test(target) ) {
            target += '/'
        }

        if ( !fs.existsSync(target))
            new _(target).mkdirSync();

        if ( self.allowedCompressionMethods.indexOf(options.method.toLowerCase()) < 0 ) {
            throw new Error('compression methode `'+ options.method +'` not supported !');
        }

        var run    = createRun('archiver-'+ options.method +'#complete');
        var handle = {
            onComplete: function onCompressionCompleted(cb) {
                run.onComplete(cb);
                return handle;
            }
        };
        if (cb) {
            run.onComplete(cb);
        }

        // #B476 — a single file is the array form with one entry. It used to take its
        // own branch, which piped the file through a gzip codec and wrote the result
        // under the `.zip` name (unreadable by decompress()), with an early return on
        // any dot-prefixed path segment that reported success on the INPUT path and
        // leaked both streams. The archive keeps its name — `<name>` defaults to the
        // file's basename, as before — and a missing path stays on the string route
        // so it still settles the `file not found` error rather than an empty archive.
        if ( typeof(src) == 'string' && fs.existsSync(src) && fs.statSync(src).isFile() ) {
            var baseName = src.substring(src.lastIndexOf('/')+1);
            if ( typeof(options.name) == 'undefined' || options.name == 'default' ) {
                options.name = baseName;
            }
            src = [{ input: src, output: baseName }];
        }

        compress(options.method, src, target, new JSZip(), options, run);

        return handle;
    }


    var compress = function(method, src, target, zipInstance, options, run) {

        var stats = null;

        var processSrc = function(method, src, target, zipInstance, options, cb) {

            if ( !fs.existsSync(src) ) {
                run.settle(new Error('file not found `'+ src +'`'));

                return;
            }

            stats = fs.statSync(src);

            var isBatchProcessing = ( typeof(cb) != 'undefined' ) ? true : false;

            if ( stats.isFile() ) { // a file is always an array entry (#B476)

                if ( !isBatchProcessing ) {
                    // unreachable: compress() rewrites a file `src` into a one-entry
                    // array before dispatch — kept loud rather than silent for a refactor
                    run.settle(new Error('[ lib/archiver ] a single file must reach processSrc as an array entry'), null);
                    return;
                }

                compressFile(src, target, zipInstance, run, function(err, entry, zipInstance) {
                    cb(err, zipInstance);
                });
            } else if ( stats.isDirectory() ) { // might be a fodler

                /**
                // targeted filename
                if ( typeof(options.name) != 'undefined' && options.name != 'default') {
                    target += options.name;
                } else {
                    target += src.substring(src.lastIndexOf('/')+1);
                }  */

                if ( !isBatchProcessing ) {
                    // targeted filename
                    if ( typeof(options.name) != 'undefined' && options.name != 'default') {
                        options.root = './'+ options.name +'/';
                        target += options.name;
                    } else {
                        options.root = './'+ src.substring(src.lastIndexOf('/')+1) +'/';
                        target += src.substring(src.lastIndexOf('/')+1);
                    }
                }

                browse(method, src, target, zipInstance, options, [], [], 0, null, isBatchProcessing, function(err, target, zipInstance) {
                    if ( isBatchProcessing ) {
                        cb(err, zipInstance);
                    } else {
                        run.settle(err, target);
                    }
                }, run);
            } else {
                var err = new Error('[ lib/archiver ] only supporting real `filename` & `dirname` as `src` input at for now');
                err.status = 500;
                if ( isBatchProcessing ) {
                    cb(err, zipInstance);
                } else {
                    run.settle(err, null)
                }
            }
        }

        // compress single file or scan an entire directory
        if ( typeof(src) == 'string' ) {
            processSrc(method, src, target, zipInstance, options)

        } else if ( Array.isArray(src) ) { // compress from a list of files & folders

            // main zip dir
            var mainFolder  = target + options.name;
            options.root    = '.'+ mainFolder.substring(mainFolder.lastIndexOf('/')) +'/';

            var output = mainFolder +'.zip';
            if ( fs.existsSync(output)) {
                fs.unlinkSync(output);
            }

            // per-call (#B473): an implicit global here let one run close another's stream
            var outputStream = run.track(fs.createWriteStream(output));
            outputStream.once('error', function(streamErr) {
                run.settle(streamErr, null);
            });

            var i = 0, len = src.length;
            var processList = function(method, files, target, zipInstance, options, i, len, err) {

                if (i >= len || err) {

                    if (!err && zipInstance) {

                        var gen = run.track(zipInstance.generateNodeStream({ compression: 'DEFLATE', compressionOptions : {level: options.level } }));
                        gen.once('error', function(genErr) {
                            run.settle(genErr, null);
                        });
                        outputStream.once('finish', function(){
                            outputStream.close();
                            run.settle(false, this.path);
                        });
                        gen.pipe(outputStream);

                    } else {
                        run.settle(err, null);
                    }

                    return
                }


                if ( typeof(files[i]) == 'undefined' ) {
                    console.warn('[ lib/archiver ] undefined file found: cannot process index `'+ i +'`, skipping to next index');
                    return processList(method, files, target, zipInstance, options, i+1, len, err);
                }

                if ( !fs.existsSync(files[i].input) ) {
                    console.warn('[ lib/archiver ] src `'+ files[i].input +'` not found at index `'+ i +'`: skipping to next src');
                    return processList(method, files, target, zipInstance, options, i+1, len, err);
                }

                // check if src is inside directory
                if ( /\//.test(files[i].output) && fs.statSync(files[i].input).isFile() ) {
                    //var newFolder = options.root + files[i].output.substring( 0, files[i].output.lastIndexOf('/')+1).replace(/^(\.\/|\/)/, '');
                    var newFolder = files[i].output.substring( 0, files[i].output.lastIndexOf('/')+1).replace(/^(\.\/|\/)/, '');
                    zipInstance.folder( newFolder )
                }

                if ( fs.statSync(files[i].input).isDirectory() ) {
                    files[i].output = options.root + files[i].output;
                }

                processSrc(method, files[i].input, files[i].output, zipInstance, options, function onSrcProcessed(err, zipInstance){
                    processList(method, src, target, zipInstance, options, i+1, len, err);
                });

                return

            }

            processList(method, src, target, zipInstance, options, i, len, false);

        } else {
            var err = new Error('[ lib/archiver ] `src` must be a `string` or an `array`');
            err.status = 500;
            run.settle(err, null)
        }

    }

    var compressFile = function(input, output, zipInstance, run, cb) {

        // the lib opens this stream, so the lib owns its error: whether JSZip
        // re-surfaces a read failure on its output stream is a timing race —
        // measured on the same input, the process crashed on an unhandled
        // 'error' in about one run in four and the run hung with a partial
        // archive on disk otherwise (a non-first entry hung every time)
        var entryInput = run.track(fs.createReadStream(input));
        entryInput.once('error', function(readErr) {
            run.settle(readErr, null);
        });
        zipInstance.file(output, entryInput);

        cb(false, output, zipInstance);
    }

    var browse = function(method, dir, target, zipInstance, options, files, outFiles, i, mainOutput, isBatchProcessing, cb, run) {

        var input  = null, output = null;
        var zipFolder = null;   // per-call (#B473): was an implicit global
        var f = null, fLen = null;
        if (files.length == 0) {
            files.push(dir);

            outFiles.push(target +'.zip');

            if (!isBatchProcessing) {
                if ( fs.existsSync(outFiles[0])) {
                    fs.unlinkSync(outFiles[0]);
                }

                mainOutput = run.track(fs.createWriteStream(outFiles[0]));
                mainOutput.once('error', function(streamErr) {
                    run.settle(streamErr, null);
                });

                // main zip dir
                target = zipFolder =  '.'+ dir.substring(dir.lastIndexOf('/')) + '/';
                zipInstance.folder(zipFolder);
            }


            var list = fs.readdirSync(dir);
            // #B474 — start at 0: node's readdir never returns `.`/`..`, and the
            // former `f = 1` silently dropped the first entry of the top-level dir
            f = 0; fLen = list.length;
            for (; f < fLen; ++f) {
                // input list
                files.push(dir +'/'+ list[f]);
                // output lis
                outFiles.push(target + list[f])
            }
            ++i
        }

        var filename  = files[i];

        // scan completed
        if ( typeof(filename) == 'undefined' ) {

            if ( isBatchProcessing ) {
                cb(false, null, zipInstance)
                return
            }

            var gen = run.track(zipInstance.generateNodeStream({ compression: 'DEFLATE', compressionOptions : {level: options.level } }));
            gen.once('error', function(genErr) {
                run.settle(genErr, null);
            });
            mainOutput.once('finish', function(){
                mainOutput.close();
                cb(false, this.path);
            });
            gen.pipe(mainOutput);

        } else {

            if ( !fs.existsSync(filename) ) {
                throw new Error('filename not found: '+ filename)
            }

            var stats = fs.statSync(filename);

            if ( stats.isFile() ) {

                input   = run.track(fs.createReadStream(filename));
                input.once('error', function(readErr) {
                    run.settle(readErr, null);
                });
                // output  = fs.createWriteStream(outFiles[i]);

                zipInstance.file(outFiles[i], input);
                browse(method, dir, target, zipInstance, options, files, outFiles, i+1, mainOutput, isBatchProcessing, cb, run);

                // ------------------------------------ once we get a method to retrieve the archive headers
                // compressFile(method, input, output, zipInstance, isBatchProcessing, function(err, output) {
                //     if (err) {
                //         cb(err, null)
                //     } else {
                //         zipInstance.file(outFiles[i], input);
                //         browse(method, dir, target, zipInstance, options, files, outFiles, i+1, mainOutput, isBatchProcessing, cb)
                //     }
                // }, true);

            } else {
                var newDir      = filename;
                var moreFiles   = fs.readdirSync(newDir);
                var newTarget   = (isBatchProcessing)
                                    ? newDir.substring( newDir.lastIndexOf( '/'+target.substring(1).replace(options.root.substring(1), '') ) ) +'/'
                                    : '.'+ newDir.substring( newDir.lastIndexOf(options.root.substring(1))) +'/'
                ;
                zipInstance.folder(newTarget);

                var index = i+1;
                f = 0; fLen = moreFiles.length;
                for (; f < fLen; ++f) {
                    // update input list
                    files.splice(index, 0, newDir +'/'+ moreFiles[f]);
                    // update output list
                    outFiles.splice(index, 0, newTarget + moreFiles[f]);

                    ++index;
                }

                browse(method, newDir, target, zipInstance, options, files, outFiles, i+1, mainOutput, isBatchProcessing, cb, run)
            }
        }

    }



    /**
     * decompress
     *
     * Inverse of `compress()` — extracts a `.zip` archive into a target directory;
     * every form of `compress()` writes one. Mirrors compress()'s completion contract: each
     * call settles its own `{ onComplete: fn }` handle exactly once (a trailing
     * callback is also accepted for `promisify`), and the singleton emits
     * `archiver-decompress#complete` `(err, target)` for observers. Uses JSZip 3.x
     * (`loadAsync` + per-entry `async('nodebuffer')`).
     *
     * @param {string} src - absolute path to the `.zip` archive
     * @param {string} target - output directory (created if missing); entries are
     *  written at their archive-relative paths under it
     * @param {object} [options] - reserved for future use
     * @returns {{ onComplete: function }} completion handle
     *
     * @example
     *  lib.archiver.decompress('/dump/app.zip', '/srv/app/').onComplete(function (err, dir) {
     *      if (err) { return; }
     *      // dir now holds the extracted tree
     *  });
     */
    this.decompress = function(src, target, options) {

        var path   = require('path');
        var run    = createRun('archiver-decompress#complete');
        var handle = {
            onComplete: function onDecompressionCompleted(cb) {
                run.onComplete(cb);
                return handle;
            }
        };

        // Used for `promisify` — same trailing-callback contract as compress()
        if ( typeof(arguments[arguments.length-1]) == 'function' ) {
            run.onComplete(arguments[arguments.length-1]);
        }

        if ( !/\/$/.test(target) ) {
            target += '/'
        }
        if ( !fs.existsSync(target) ) {
            fs.mkdirSync(target, { recursive: true });
        }
        var targetAbs = path.resolve(target);

        if ( !fs.existsSync(src) ) {
            // defer so a synchronous error still reaches a listener attached
            // via the returned handle's onComplete() on the same tick
            process.nextTick(function () {
                run.settle(new Error('archive not found `'+ src +'`'), null);
            });
            return handle;
        }

        try {
            var buf = fs.readFileSync(src);
            JSZip.loadAsync(buf).then(function (zip) {

                var entries = [];
                zip.forEach(function (relPath, entry) {
                    entries.push({ relPath: relPath, entry: entry });
                });

                var i = 0;
                var next = function () {
                    if ( i >= entries.length ) {
                        run.settle(false, target);
                        return;
                    }
                    var it   = entries[i++];
                    var dest = path.resolve(targetAbs, it.relPath);

                    // zip-slip guard: an entry must never escape the target dir
                    if ( dest !== targetAbs && dest.indexOf(targetAbs + path.sep) !== 0 ) {
                        run.settle(new Error('unsafe entry path in archive: `'+ it.relPath +'`'), null);
                        return;
                    }

                    if ( it.entry.dir ) {
                        if ( !fs.existsSync(dest) ) {
                            fs.mkdirSync(dest, { recursive: true });
                        }
                        return next();
                    }

                    var parent = path.dirname(dest);
                    if ( !fs.existsSync(parent) ) {
                        fs.mkdirSync(parent, { recursive: true });
                    }
                    it.entry.async('nodebuffer').then(function (content) {
                        fs.writeFileSync(dest, content);
                        next();
                    }).catch(function (err) {
                        run.settle(err, null);
                    });
                };
                next();

            }).catch(function (err) {
                run.settle(err, null);
            });
        } catch (err) {
            process.nextTick(function () {
                run.settle(err, null);
            });
        }

        return handle;
    }

    this.compressFromStream = function(readStream, target, options) {

    }

    this.compressHttpResponse = function(request, response, options) {

    }

    this.addSignature = function(filename, options) {

    }

}

if ( typeof(module) !== 'undefined' && module.exports ) {
    // Publish as node.js module
    Archiver = inherits(Archiver, Emitter);
    module.exports = new Archiver()
} else if ( typeof(define) === 'function' && define.amd ) {
    // Publish as AMD module
    define(function() { return Archiver() })
}