/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
// nodejs dependencies
if ( typeof(module) !== 'undefined' && module.exports) {

    var fs          = require('fs');
    var zlib        = require('zlib');
    var JSZip       = require('./dep/jszip.min.js');
    var Emitter     = require('events').EventEmitter;
    var helpers     = require('../../../helpers/index');
    var inherits    = require('../../../lib/inherits');
}


/**
 * Archiver
 *  zlib APIs except those that are explicitly synchronous
 *  To prenvent any suprises, you can use this in a child process
 *
 *  Note:
 *      Because libuv's threadpool has a fixed size,
 *      it means that if for whatever reason any of these APIs takes a long time,
 *      other (seemingly unrelated) APIs that run in libuv's threadpool will experience degraded performance.
 *      In order to mitigate this issue, one potential solution is to increase the size of libuv's threadpool
 *      by setting the 'UV_THREADPOOL_SIZE' environment variable to a value greater than 4 (its current default value).
 *      For more information, see the libuv threadpool documentation (http://docs.libuv.org/en/latest/threadpool.html)
 *
 * @package     Gina.Lib
 * @namespace   Gina.Lib.Archiver
 * @author      Rhinostone <contact@gina.io>
 * */

function Archiver() {


    var self        = this;
    var isGFFCtx    = ((typeof (module) !== 'undefined') && module.exports) ? false :  true;
    var merge       = (isGFFCtx) ? require('lib/merge') : require('../../../lib/merge');
    var zip         = null;


    // var fs = null, zlib = null, Emitter = null;
    // // node dependencies - backend use only !
    // if (!isGFFCtx) {
    //     fs      = require('fs');
    //     zlib    = require('zlib');
    // }

    this.allowedCompressionMethods = ['gzip', 'br', 'deflate'];

    var defaultCompressionOptions = {
        tmp         : null,
        method      : 'gzip', // gzip (Gzip/Gunzip) | br (Brotli) | deflate (Deflate/Inflate)
        unlinkSrc   : false,
        name        : 'default',
        // Zlib class options : https://nodejs.org/api/zlib.html#zlib_class_options
        level       : 9   // compression level
    };

    var local = {};



    /**
     * compress
     *
     * @param {string|array} src - filename, dirname or array of filenames & dirnames e.g: `/usr/local/data/dump.sql`
     *
     * Array must be a collection e.g.:
     *  [
     *      {
     *          input: '/usr/loca/data/img/favicon.ico'
     *          ouput: 'img/favicon.ico
     *      },
     *      {
     *          input: '/usr/local/backup/mysql/dump.sql',
     *          ouput: 'dump/my-db.sql'
     *      }
     *  ]
     *
     * @param {string} output pathname - e.g: `/var/backup/mysql/`
     * @param {object} [options] you can also pass Zlib class options, see: https://nodejs.org/api/zlib.html#zlib_class_options
     *  {
     *      method: 'gzip',
     *      name: 'my-dump', // this is optional
     *      level: 7    // `0` for no compression; `1` for best speed; `9` for best compression
     *  }
     *
     * @callback [cb] - Used for `promisify`
     *
     */
    this.compress = function(src, target, options) {

        // Used for `promisify`
        var cb = null;
        if ( typeof(arguments[arguments.length-1]) == 'function' ){
            cb = arguments[arguments.length-1];
            self.once('archiver-'+ options.method +'#complete', function(err, target){
                zip = null;
                return cb(err, target)
            })
        }

        options = ( typeof(options) != 'undefined' ) ? merge(options, defaultCompressionOptions) : defaultCompressionOptions;

        if ( options.tmp != null ) {
            options.unlinkSrc = true;
        }

        if ( !/\/$/.test(target) ) {
            target += '/'
        }

        if ( !fs.existsSync(target))
            new _(target).mkdirSync();

        // if ( /\.(zip|gz)$/.test(target) ) {
        //     options.method = 'gzip';
        // }

        if ( self.allowedCompressionMethods.indexOf(options.method.toLowerCase()) < 0 ) {
            throw new Error('compression methode `'+ options.method +'` not supported !');
        }



        local.options = options;
        zip = new JSZip(); // zipInstance

        compress(options.method, src, target, zip, options);

        return {
            onComplete: function onCompressionCompleted(cb) {
                self.once('archiver-'+ options.method +'#complete', function(err, target){
                    zip = null;
                    cb(err, target)
                })
            }//,
            //addSignature : selt.addSignature
        }
    }


    var compress = function(method, src, target, zipInstance, options) {

        var stats = null;

        var processSrc = function(method, src, target, zipInstance, options, cb) {

            if ( !fs.existsSync(src) ) {
                self.emit('archiver-'+ method +'#complete', new Error('file not found `'+ src +'`'));

                return;
            }

            stats = fs.statSync(src);

            var isBatchProcessing = ( typeof(cb) != 'undefined' ) ? true : false;

            if ( stats.isFile() ) { // single file compression


                var input   = null;
                var output  = null;

                if ( isBatchProcessing ) {
                    input   = src;
                    output  = target
                } else {
                    // targeted filename
                    if ( typeof(options.name) != 'undefined' && options.name != 'default') {
                        target += options.name;
                    } else {
                        target += src.substr(src.lastIndexOf('/')+1);
                    }

                    input   = fs.createReadStream(src);
                    output  = fs.createWriteStream(target +'.zip');
                }

                compressFile(method, input, output, zipInstance, isBatchProcessing, function(err, target, zipInstance) {
                    if ( isBatchProcessing ) {
                        cb(err, zipInstance);
                    } else {
                        self.emit('archiver-'+ method +'#complete', err, target)
                    }

                });
            } else if ( stats.isDirectory() ) { // might be a fodler

                /**
                // targeted filename
                if ( typeof(options.name) != 'undefined' && options.name != 'default') {
                    target += options.name;
                } else {
                    target += src.substr(src.lastIndexOf('/')+1);
                }  */

                if ( !isBatchProcessing ) {
                    // targeted filename
                    if ( typeof(options.name) != 'undefined' && options.name != 'default') {
                        options.root = './'+ options.name +'/';
                        target += options.name;
                    } else {
                        options.root = './'+ src.substr(src.lastIndexOf('/')+1) +'/';
                        target += src.substr(src.lastIndexOf('/')+1);
                    }
                }

                browse(method, src, target, zipInstance, options, [], [], 0, null, isBatchProcessing, function(err, target, zipInstance) {
                    if ( isBatchProcessing ) {
                        cb(err, zipInstance);
                    } else {
                        self.emit('archiver-'+ method +'#complete', err, target);
                    }
                });
            } else {
                var err = new Error('[ lib/archiver ] only supporting real `filename` & `dirname` as `src` input at for now');
                err.status = 500;
                if ( isBatchProcessing ) {
                    cb(err, zipInstance);
                } else {
                    self.emit('archiver-'+ method +'#complete', err, null)
                }
            }
        }

        // compress single file or scan an entire directory
        if ( typeof(src) == 'string' ) {
            processSrc(method, src, target, zipInstance, options)

        } else if ( Array.isArray(src) ) { // compress from a list of files & folders

            // main zip dir
            var mainFolder  = target + options.name;
            options.root    = '.'+ mainFolder.substr(mainFolder.lastIndexOf('/')) +'/';

            var output = mainFolder +'.zip';
            if ( fs.existsSync(output)) {
                fs.unlinkSync(output);
            }

            outputStream = fs.createWriteStream(output);


            var i = 0, len = src.length;
            var processList = function(method, files, target, zipInstance, options, i, len, err) {

                if (i >= len || err) {

                    if (!err && zipInstance) {

                        zipInstance
                            .generateNodeStream({ compression: 'DEFLATE', compressionOptions : {level: options.level } })
                            .pipe(outputStream);

                        outputStream
                            .once('err', function(){
                                outputStream.close();
                                self.emit('archiver-'+ method +'#complete', err, null);
                            })
                            .once('finish', function(){
                                outputStream.close();
                                self.emit('archiver-'+ method +'#complete', false, this.path);
                            })

                    } else {
                        self.emit('archiver-'+ method +'#complete', err, null);
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
                    //var newFolder = options.root + files[i].output.substr( 0, files[i].output.lastIndexOf('/')+1).replace(/^(\.\/|\/)/, '');
                    var newFolder = files[i].output.substr( 0, files[i].output.lastIndexOf('/')+1).replace(/^(\.\/|\/)/, '');
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
            self.emit('archiver-'+ method +'#complete', err, null)
        }

    }

    var compressFile = function(method, input, output, zipInstance, isBatchProcessing, cb, isPackage) {

        var methodObject = null;
        isPackage = ( typeof(isPackage) == 'undefined' ) ? false: isPackage;

        if ( isBatchProcessing ) {

            zipInstance.file(output, fs.createReadStream(input));

            cb(false, output, zipInstance);
            return
        }

        switch (method) {
            case 'gzip':
                methodObject = zlib.createGzip();
                break;

            default:
                methodObject = zlib.createGzip();
                break;
        }


        if ( /\/\.(.*)$/.test(input.path) ) {

            if (isPackage) {
                cb(false, input)
            } else {
                cb(false, input.path)
            }
            return
        } else {
            input
                .pipe(methodObject)
                .pipe(output);
        }


        output
            .once('error', function onCompressionError(err) {
                cb(err, null)
            })
            .once('finish', function onCompressionFinished(){
                if (isPackage) {
                    cb(false, this, zipInstance)
                } else {
                    cb(false, this.path, zipInstance)
                }
            });

    }

    var browse = function(method, dir, target, zipInstance, options, files, outFiles, i, mainOutput, isBatchProcessing, cb) {

        var input  = null, output = null;
        var f = null, fLen = null;
        if (files.length == 0) {
            files.push(dir);

            outFiles.push(target +'.zip');

            if (!isBatchProcessing) {
                if ( fs.existsSync(outFiles[0])) {
                    fs.unlinkSync(outFiles[0]);
                }

                mainOutput = fs.createWriteStream(outFiles[0]);

                // main zip dir
                target = zipFolder =  '.'+ dir.substr(dir.lastIndexOf('/')) + '/';
                zipInstance.folder(zipFolder);
            }


            var list = fs.readdirSync(dir);
            f = 1; fLen = list.length;
            for (; f < fLen; ++f) {
                // input list
                files.push(dir +'/'+ list[f]);
                // output lis
                outFiles.push(target + list[f])
            }
            ++i
        }

        var filename  = files[i];

        if ( /^(\.|\.\.)$/.test(filename) ) {// ignore this
            browse(method, dir, target, zipInstance, options, files, outFiles, i+1, mainOutput, isBatchProcessing, cb)
        }



        // scan completed
        if ( typeof(filename) == 'undefined' ) {

            if ( isBatchProcessing ) {
                cb(false, null, zipInstance)
                return
            }

            zipInstance
                .generateNodeStream({ compression: 'DEFLATE', compressionOptions : {level: local.options.level } })
                .pipe(mainOutput);

            mainOutput
                .once('err', function(){
                    mainOutput.close();
                    cb(err, null);
                })
                .once('finish', function(){
                    mainOutput.close();
                    cb(false, this.path);
                })

        } else {

            if ( !fs.existsSync(filename) ) {
                throw new Error('filename not found: '+ filename)
            }

            var stats = fs.statSync(filename);

            if ( stats.isFile() ) {

                input   = fs.createReadStream(filename);
                // output  = fs.createWriteStream(outFiles[i]);

                zipInstance.file(outFiles[i], input);
                browse(method, dir, target, zipInstance, options, files, outFiles, i+1, mainOutput, isBatchProcessing, cb);

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
                                    ? newDir.substr( newDir.lastIndexOf( '/'+target.substr(1).replace(options.root.substr(1), '') ) ) +'/'
                                    : '.'+ newDir.substr( newDir.lastIndexOf(options.root.substr(1))) +'/'
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

                browse(method, newDir, target, zipInstance, options, files, outFiles, i+1, mainOutput, isBatchProcessing, cb)
            }
        }

    }



    this.decompress = function(src, target, options) {

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