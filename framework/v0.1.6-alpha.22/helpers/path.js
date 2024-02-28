/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var fs          = require('fs');
var util        = require('util');
var Events      = require('events');
var Path        = require('path');
var execSync    = require('child_process').execSync;

var merge       = require('./../lib/merge');
var console     = require('./../lib/logger');

var ContextHelper = require('./context');
var e =  new Events.EventEmitter();
//Reminder: let listeners be removed by the V8 garbage collector.
e.setMaxListeners(100);


/**
 * PathHelper
 *
 * @package     Gina.Lib.Helpers
 * @author      Rhinzostone <contact@gina.io>
 * @api public
 *
 * TODO - Put debug logs
 * */

function PathHelper() {

    this.paths = [];
    var _this = this;

    /**
     * _
     * PathHelper Constructor
     *
     * @constructor
     *
     * @param {string} path - Path to convert
     * @param {boolean} [force] - Force conversion to match platform style (Only for string conversion)
     *
     * @returns {string|object} converted
     * */

    _ = function(path, force) {

        if ( typeof(path) == 'undefined' || !path || path == '' || path.length <=2 ) {
            throw new Error('This source cannot be used: `'+ path +'`')
        }

        // $HOME detection
        if ( /^\~/.test(path) ) {
            var homedir = null;
            try {
                homedir = execSync('echo $HOME').toString().replace(/(\r|\n)$/g, '');
            } catch (err) {
                throw err
            }

            path = path.replace(/^\~/, homedir);
        }

        if ( typeof(force) == undefined) {
            force = _this.force = false
        }
        // Attention : _('/my/path/../folder/file.ext') will output -> /my/folder/file.ext
        path = Path.normalize(path);
        var isConstructor = false, p = null;
        if (
            this instanceof _ // <- You could use arguments.callee instead of _ here,
            // except in in EcmaScript 5 strict mode.
            && !this.previouslyConstructedBy_) {
            isConstructor = true;
            this.previouslyConstructedBy_ = true
        }

        if ( typeof(path) != 'undefined' && path != '' ) {

            if (isConstructor) {
                //console.debug("creating path record: ", path, isConstructor );
                this.path = path;
                if (process.platform == "win32") {
                    //In case of mixed slashes.
                    this.value = path.replace(/\\/g, "/");// Make it unix like.

                    p = this.value;

                    this.isWindowsStyle = true;
                    this.key = path;
                    if (_this.paths.indexOf(path) < 0 ) {
                        _this.paths.push(p)
                    }
                } else {
                    //console.debug("linux style");
                    //we don't want empty spaces
                    this.value = path.replace(/\\/g, "/");
                    p = this.value;
                    //console.debug("path ", p);
                    this.key = path;
                    if (_this.paths.indexOf(path) < 0 ) {
                        _this.paths.push(p)
                    }
                }
                return this

            } else {
                //Means that we are not in an object context.
                if (process.platform == "win32") {
                    //path = path.replace(/\//g, "\\");
                    if (force)
                        path = path.replace(/\//g, "\\");//Keep it or convert to Win32
                    else
                        path = path.replace(/\\/g, "/");// Make it unix like.


                    if ( _this.paths.indexOf(path) < 0) {
                        _this.paths.push(path)
                    }


                } else {
                    path = path.replace(/\\/g, "/");
                    if (_this.paths.indexOf(path) < 0) {
                        _this.paths.push(path)
                    }
                }

                return path
            }
        }
        return null
    };


    _.prototype.sep = Path.sep;
    _.prototype.start = (process.platform != "win32") ? "/" : "";

    /**
     * _.toString() Convert path object to string
     * @returns {String} path
     *
     * Usage:
     * var myPathObj = new _("my/path/string");
     *
     * Then
     * myPathObj.toString()
     * */
    _.prototype.toString = function() {
        // var self = this;
        // var path = self.value;
        // var i = _this.paths.indexOf(path);
        // return ( i > -1 ) ? _this.paths[i] : path

        return (process.platform != "win32") ? toUnixStyle(this) : toWin32Style(this)
    }

    /**
     * _.toArray() Convert path object to array
     * @returns {Array} path
     *
     * Usage:
     * var myPathObj = new _("my/path/string");
     *
     * Then
     * myPathObj.toArray()
     * */
    _.prototype.toArray = function() {
        var self = this;
        var arr = toArray(self);

        arr.first = function() {
            return arr[0];
        }

        arr.index = function(i) {
            if ( typeof(arr[i]) != 'undefined' )
                return arr[i];
            else
                return undefined;
        }

        arr.last = function() {
            return arr[arr.length-1]
        };

        return arr
    }

    var toArray = function(self) {
        var reg = new RegExp(/[,;/]/g);
        //Last replace just in case. I hate Windows.
        //The first element will be the letter of the drive. Windows only.
        return (typeof(self.isWindowsStyle) != "undefined" && self.isWindowsStyle == true)
            ? self.value.replace(/\\/g, "/").split(reg)
            : self.value.replace(/\\/g, "/").split(reg).splice(1);
    }

    var stringPathToArray = function(path) {
        if ( typeof(path) == 'undefined' || typeof(path) != 'string') {
            console.warn('Path.stringPathToArray(path): path is empty or wrong type.');
            return undefined
        }
        var reg = new RegExp(/[,;/]/g);
        var isWindowsStyle = (process.platform == "win32") ? true : false;

        var arr = (isWindowsStyle)
            ? path.replace(/\\/g, "/").split(reg)
            : path.replace(/\\/g, "/").split(reg).splice(1);

        arr.first = function() {
            return arr[0]
        }

        arr.index = function(i) {
            if ( typeof(arr[i]) != 'undefined')
                return arr[i];
            else
                return undefined;
        }

        arr.last = function() {
            return arr[arr.length-1]
        };

        return arr
    }

    var cleanSlashes = function(self) {
        var path = self.value;
        var a = toArray(self);
        if (a[a.length-1] == '') {
            a.splice(a.length-1, 1);
            self.value = self.start + a.join(Path.sep)
        }
        return self
    }

    var isDirectory = function(value) {
        try {
            if ( fs.lstatSync(value).isDirectory() && !fs.lstatSync(value).isSymbolicLink() ) {
                return true
            }
        } catch (dirErr) {}

        return false;
    }
    _.prototype.isDirectory = function() {
        return isDirectory(this.value)
    }

    var isSymlinkSync = function(value) {
        try {
            if ( fs.lstatSync(value).isSymbolicLink() ) {
                return true
            }
        } catch (linkErr) {}

        return false;
    }
    _.prototype.isSymlinkSync = function() {
        return isSymlinkSync(this.value)
    }

    _.prototype.getSymlinkSourceSync = function() {
        if ( !isSymlinkSync(this.value) ) {
            throw new Error('Path `'+ this.value +'` is not a symbolic link !')
        }
        return fs.readlinkSync(this.value)
    }

    var existsSync = function(value) {
        if ( typeof(fs.accessSync) != 'undefined' ) {
            try {
                fs.accessSync(value, fs.constants.F_OK);
                return true;
            } catch (err) {
                // to handle symlinks
                try {
                    if ( fs.lstatSync(value).isSymbolicLink() ) {
                        return true
                    }
                } catch (linkErr) {}

                return false;
            }

        } else { // support for old version of nodejs
            return fs.existsSync(value);
        }
    }
    _.prototype.existsSync = function() {
        return existsSync(this.value);
    }


    var exists = function(value, callback) {
        if ( typeof(fs.access) != 'undefined' ) {
            fs.access(value, fs.constants.F_OK, (err) => {
                // to handle symlinks
                try {
                    if ( fs.lstatSync(value).isSymbolicLink() ) {
                        return callback(true)
                    }
                } catch (linkErr) {}

                callback( (err) ? false: true )
            });
        } else { // support for old version of nodejs
            fs.exists(value, function(found) {
                callback(found)
            })
        }
    }
    _.prototype.exists = function(callback) {
        exists(this.value, callback);
    }

    _.prototype.isWritableSync = function() {

        if ( typeof(fs.accessSync) != 'undefined' ) {
            try {
                fs.accessSync(this.value, fs.constants.W_OK);
                return true
            } catch (err) {
                return false
            }
        } else { // support for old version of nodejs
            var canWrite = false
            try {
                canWrite = (fs.statSync(this.value).mode & (fs.constants.S_IRUSR | fs.constants.S_IRGRP | fs.constants.S_IROTH));
            } catch (err) {
                canWrite = false
            }
            return canWrite
        }
    }

    _.prototype.isWritable = function(callback) {
        if ( typeof(fs.access) != 'undefined' ) {
            fs.access(this.value, fs.constants.F_OK, (err) => {
                callback( (err) ? false: true )
            });
        } else { // support for old version of nodejs
            fs.stat(this.value, function(err, stats) {
                var canWrite = false;
                if (!err && stats.mode & (fs.constants.S_IRUSR | fs.constants.S_IRGRP | fs.constants.S_IROTH)) {
                    canWrite = true;
                }
                callback( canWrite )
            })
        }
    }

    /**
     * Check if a file is present under a certain dir
     *
     * */
    _.prototype.hasFile = function(search, callback) {
        var self = this;
        var p = self.value;
        fs.lstat(p, function(err, stats) {
            if (err) callback(err);

            if ( !stats.isDirectory() ) {
                callback(new Error(p +' is not a directory'))
            } else {
                fs.readdir(p, function(err, files) {
                    for(var f=0; f<files.length; ++f) {
                        if (search == files[f]) {
                            callback(false, true)
                            break
                        }
                    }
                })
            }
        })
    }

    /**
     * _.mkdirSync() Create a folder recursively
     *      if doesn't exists,
     *
     *      return
     *          err string if failed
     *          else return instance
     *
     * @param {string} permission Folder permission
     * */
    _.prototype.mkdirSync = function(permission, pathArr) {

        if ( existsSync(this.value) ) {
            return this // always return the instance for sync
        }
        cleanSlashes(this);

        //by default.
        if ( typeof(permission) == 'undefined' ) {
            permission = 0775
        }

        if ( typeof(pathArr) == 'undefined' ) {
            pathArr = toArray(this)
        }

        try {
            mkdirSync(this, permission, pathArr, 0);
            return this // always return the instance for sync
        } catch (err) {
            return err // it has to be thrown clean to be "instanceof Error"
        }
    }

    var mkdirSync = function(self, permission, pathArr, i, path) {

        var addFolder = function(self, permission, pathArr, i, path) {
            try {
                fs.mkdirSync(path, permission);
                mkdirSync(self, permission, pathArr, i, path)
            } catch (err) {
                console.debug(err.stack); // always keep trace of the original stack
                throw new Error(err.message)
            }
        };

        if (i+1 < pathArr.length) {

            if ( typeof(path) == 'undefined') {
                path =   self.start + pathArr[0]
            } else {
                ++i;
                path += '/' + pathArr[i]
            }

            if ( !existsSync(path) ) {
                addFolder(self, permission, pathArr, i, path)
            } else {
                mkdirSync(self, permission, pathArr, i, path)
            }
        } else {
            return
        }
    }

    /**
     * _.mkdir() Create a folder if doesn't exists, else return path
     *
     * @param {string} permission Folder permission
     * @callback callback
     * */
    _.prototype.mkdir = function(permission, callback) {
        if ( typeof(permission) == "function") {
            callback = permission;
            permission = 0775
        }
        var self = this;
        self = cleanSlashes(self);

        //Enter dir & start rm.
        exists(self.value, function(found) {
            if (found) {
                callback(false, self.value)
            } else {
                var p = self.value;

                mkdir(self)
                    .onComplete( function(err, path){
                        //Avoid collisions.
                        if (err) {
                            console.crit("debug needed mkdir for targeted folder !! ", err);
                            process.exit(1)
                        } else {

                            if (p == path  && typeof(callback) != 'undefined' && typeof(self.created) == 'undefined' ) {
                                if (typeof(callback) != 'undefined') {
                                    callback(err, path)
                                } else {
                                    console.debug("no callback defined for mkdir ", path)
                                }
                            }
                        }
                    })
            }//EO exists.
        })
    }

    var mkdirEnd = function(self, err, path) {
        if (!err) {
            e.emit('mkdir#complete#'+self.value, false, path)
        } else {
            e.emit('mkdir#complete#'+self.value, err, path)
        }
    }

    var mkdir = function(self, permission, pathArr, i, path) {

        var addFolder = function(self, permission, pathArr, i, path) {

            fs.mkdir(path,  function(err){
                if (!err) {
                    mkdir(self, permission, pathArr, i, path)
                } else {
                    mkdirEnd(self, err)
                }
            })
        };

        //by default.
        if ( typeof(permission) == 'undefined' ) {
            permission = 0775
        }

        if ( typeof(pathArr) == 'undefined' ) {
            pathArr = toArray(self)
        }

        if ( typeof(i) == 'undefined' ) {
            i = 0
        }

        if (i+1 < pathArr.length) {

            if ( typeof(path) == 'undefined') {
                path =   self.start + pathArr[0]
            } else {
                ++i;
                path += '/' + pathArr[i]
            }

            exists(path, function(found) {
                if (!found) {
                    addFolder(self, permission, pathArr, i, path)
                } else {
                    mkdir(self, permission, pathArr, i, path)
                }
            })
        } else {
            //console.debug("calling end on ", self.value);
            mkdirEnd(self, false, path)
        }
        return {
            /**
             * Complete event
             * @event mkdir#onComplete
             * */
            onComplete : function(callback) {
                //console.debug("listeners ", e.listeners('mkdir#complete') );
                //We want it once for the object path.
                e.once('mkdir#complete#'+self.value, function(err, path) {

                    if (err) {
                        console.error(err.stack)
                    }
                    callback(err, path)
                })
            }
        }
    }

    /**
     * symlinkSync
     *
     * @param {string} source
     * @param {string} destination
     * @param {string} type - Only available from node v12.0.0 & only available on Windows and ignored on other platforms
     */
     var symlinkSync = function(source, destination, type) {
        // About junstion for windows (only):
        // reminders: creating a symbolic link requires special privilege (by default, only available to elevated processes) whereas creating a junction only requires access to the file system.
        // https://docs.microsoft.com/en-us/sysinternals/downloads/junction
        // https://superuser.com/questions/343074/directory-junction-vs-directory-symbolic-link
        if ( !existsSync(source) ) {
            throw new Error('Cannot complete symlinkSync from `'+ source +'`: the path does not exist.');
        }
        var nodeVersion = process.version.replace(/v/, '').split(/\./g)[0];

        if (
            process.platform == "win32"
            && ~~nodeVersion >= 12
            && typeof(type) == 'undefined'
            ||
            process.platform == "win32"
            && ~~nodeVersion >= 12
            && !type
            ||
            process.platform == "win32"
            && ~~nodeVersion >= 12
            && type == ''
        ) {
            // check source type
            if ( fs.lstatSync( source ).isDirectory() ) {
                type = 'dir';
            }
            else {
                type = 'file'
            }
        }

        if (
            process.platform == "win32"
            && ~~nodeVersion >= 12
            && typeof(type) != 'undefined'
            && type != 'null'
            && type != ''
        ) { // can use type

            if ( ['dir', 'file', 'junction'].indexOf(type) < 0 ) {
                throw new Error('Wrong symlink type: '+ type);
            }
        }

        fs.symlinkSync(source, destination, type);
    }
    _.prototype.symlinkSync = function(destination, type) {
        var self = this;
        var source = self.value;

        // if ( !existsSync(source) ) {
        //     throw new Error('Cannot complete symlink from `'+ source +'`: the path does not exist.');
        // }
        symlinkSync(source, destination, type);

    }

    _.prototype.renameSync = function(destination) {
        var self = this;
        var source = self.value;

        if ( !existsSync(source) ) {
            throw new Error('Cannot complete rename from `'+ source +'`: the path does not exist.');
        }

        try {
            fs.renameSync(source, destination);
        } catch (err) {
            throw err
        }
    }


    /**
     * copy, file or entire folder
     *
     * Usage:
     * Need object context
     *
     *  var sourceToCopy = new _(stringPath);
     *  var target = _(stringPath);
     *
     *  sourceToCopy.cp(target, function(err, destination){
     *
     *  })
     *
     * @ram {string} target
     * @param {array} [ excluded ] - Excluded list
     *
     * @callback callback
     * @param {string} errResponse
     * @param {string} [pathResponse]
     * */

    _.prototype.cp = function(target, excluded, cb) {

        if ( typeof(excluded) == 'function') {
            cb = excluded;
            excluded = undefined
        }

        if ( typeof(target) == 'undefined' || !target || target == '' || target.length <=2 ) {
            cb( new Error('This target cannot be used: `'+ target +'`'));
            return;
        }

        var self = this;
        //Enter dir & start rm.
        var p = self.value;
        //console.debug("starting copying ", p, " => ", target);

        cp(p, target, excluded)
            .onComplete( function(err, destination, method) {
                cb(err, destination);
            });

    }

    var cp = function(source, destination, excluded) {

        if ( !existsSync(source) ) {
            throw new Error('Cannot complete copy from `'+ source +'`: the path does not exist.');
        }

        /**
         * BO Targeting folder content
         * This only matters when copy is done Folder To Folder.
         *
         * TODO - Need to br [optimized] by not having to create new path object.
         * */
        var childElementsOnly = [], find;
        // ending char : / or \
        var s = new _(source).toUnixStyle();
        find = s.substr(s.length-1, 1);
        if ( find == '\/') {
            source = s.substr(0, s.length-1);
            childElementsOnly['source'] = true
        } else {
            source = s;
            childElementsOnly['source'] = false
        }

        // ending char : / or \
        var d = new _(destination).toUnixStyle();
        find = d.substr(d.length-1, 1);
        if ( find == '\/') {
            destination = d.substr(0, d.length-1);
            childElementsOnly['destination'] = true
        } else {
            destination = d;
            childElementsOnly['destination'] = false
        }
        /**
         * EO Targeting folder content
         * */

        //Define strategy.
        fs.lstat(source, function(err, stats) {
            // 1) File => Dir (add if exist else, throw error).
            // 2) File => File (create or replace if exists).
            // 3) Dir => Dir (create or replace if exists).

            if (err) {
                e.emit("cp#complete", err);
                return;
            }

            if ( stats.isSymbolicLink() ) {
                //console.debug('#1 ('+process.version+') Found symlink: '+ source,'\n', JSON.stringify(stats, null, 4));
                try {
                    symlinkSync(fs.realpathSync(source), destination);
                } catch (realPathError) {
                    e.emit("cp#complete", realPathError, destination);
                    return;
                }

                e.emit("cp#complete", err, destination)
            } else if ( !stats.isDirectory() ) {
                // 1) & 2) File => Dir (add if exist else, throw error).
                copyFileToFile(source, destination, 0, function(err) {
                    e.emit("cp#complete", err, destination)
                }, excluded)
            } else {
                /**
                 * 3) Dir => Dir (create or replace if exists).
                 *
                 *  [3.A] from dir/* to dir/* || dir/* to dir
                 *      - Using this method, you have to make sure
                 *        both source & destination exist
                 *      - If not, errors will be thrown.
                 *  [3.B] form from dir to dir/*
                 *  [3.C] from  dir to dir (override if exists) equals to mv()
                 *        when creating
                 */
                //console.debug("man..", childElementsOnly);
                var method = "3C", createDir;
                if (
                    childElementsOnly['source'] && childElementsOnly['destination'] ||
                    childElementsOnly['source'] && !childElementsOnly['destination']
                ) {
                    method = "3A";
                    //console.debug("....calling method ", method);

                    browseCopy(source, destination, excluded, function(err){
                        //console.debug("copy Dir/ to Dir/ && Dir/ to Dir done");
                        e.emit("cp#complete", err, destination, method)
                    })

                } else if (!childElementsOnly["source"] && childElementsOnly["destination"]) {
                    method = "3B";
                    //console.debug("....calling method ", method);
                    //Getting folder name.
                    var folder = new _(source).toArray().last();
                    destination += '/' + folder;

                    var target = new _(destination).mkdir( function(err, path) {
                        browseCopy(source, path, excluded, function(err) {
                            //console.debug("copy Dir to Dir/ done");
                            e.emit("cp#complete", err, path, method)
                        })
                    })
                } else {
                    //3C.
                    var onRemoved = function(err, target) {
                        // err: 99% means that it doesn't exist. Well, we don't care do we ?.
                        if (!err) {

                            var isExcluded = false;
                            if ( typeof(source) != 'undefined' && excluded != undefined) {
                                var f, p = source.split('/');
                                f = p[p.length-1];
                                for (var r= 0; r<excluded.length; ++r) {
                                    if ( typeof(excluded[r]) == 'object' ) {
                                        if (excluded[r].test(f)) {
                                            isExcluded = true
                                        }
                                    } else if (f === excluded[r]) {
                                        isExcluded = true
                                    }
                                }
                            }
                            if (!isExcluded) {
                                target = new _(destination).mkdir( function(err, path) {

                                    browseCopy(source, path, excluded, function(err) {
                                        //console.debug("copy Dir to Dir done");
                                        //removed = true;
                                        destination = null;
                                        e.emit("cp#complete", err, path, method)
                                    })
                                })
                            } else {
                                var oldSource = source, oldDestination = destination;

                                source = source.split('/');
                                source = source.splice(0, source.length-1);
                                source = source.join('/');
                                destination = destination.split('/');
                                destination = destination.splice(0, destination.length-1);
                                destination = destination.join('/');

                                readContent(source, destination, function(_list, _listTo) {
                                    var i = 0, list = [], listTo = [];
                                    _list = _list.splice(_list.indexOf(oldSource)+1);
                                    _listTo = _listTo.splice(_listTo.indexOf(oldDestination)+1);
                                    for (var p=0; p<_list.length; ++p) {

                                        list.push(_list[p]);
                                        listTo.push(_listTo[p])
                                    }

                                    browseCopy(list[i], listTo[i], excluded, function(err){
                                        e.emit("cp#complete", err, listTo[i], method);
                                        destination = null
                                    }, list, listTo, i)
                                })
                            }

                        } else {
                            console.error("onRemoved error: som'was wrong ");
                            process.exit(1)
                        }
                    };

                    var d = _(destination);
                    exists(d, function(found){
                        //console.debug("about to remove !! ", d, exists);
                        if (found) {
                            rm(d).onComplete( onRemoved )
                        } else {
                            onRemoved(false, d)
                        }
                    })
                }
//               console.error("Copy strategy 3C: Could not create directory for copy");
            }

        });//EO fs.lstat(source


        return {
            /**
             * Complete event
             * @event cp#onComplete
             * */
            onComplete : function(callback) {
                //We want it once for the object path.
                e.once('cp#complete', function(err, destination, method) {
                    if (err) {
                        console.error(err.stack)
                    }
                    console.debug('cp() completed copy to: ', method);
                    callback(err, destination, method)
                })
            }
        }
//        this.onComplete = function(callback) {
//            //We want it once for the object path.
//            e.once('cp#complete', function(err, destination) {
//                if (err) {
//                    logger.error(
//                        'gina',
//                        'LIB:HELPERS:PATH:ERROR:7',
//                        err,
//                        __stack
//                    );
//                }
//                console.debug('cp() complete');
//                callback(err, destination)
//            })
//        };

        //return this
    }

    var readContent = function(source, target, callback) {
        fs.readdir(source, function(err, files) {
            var list = [], listTo = [];
            for (var i=0; i<files.length; ++i) {
                list[i]     = _(source +'/'+ files[i]);
                listTo[i]   = _(target +'/'+ files[i])
            }
            callback(list, listTo)
        })
    }

    /**
     * browse & copy
     *
     * @param {string} method
     * @param {string} sourceDir
     * @param {string} destinationDir
     * @param {array} [ excluded ]
     *
     * @callback callback
     *
     * @param {array} [list]
     * @param {array} [listTo]
     * @param {number} [i]
     * @param {number} [c]
     * @param {array} [paths]
     *
     * @private
     * */

    var end = function(callback, err) {
        callback(err);
    }

    var browseCopy = function(sourceDir, destinationDir, excluded, callback, list, listTo, i) {
        list = ( typeof(list) != 'undefined' ) ? list : [];
        listTo = ( typeof(listTo) != 'undefined' ) ? listTo : [];
        i = ( typeof(i) != 'undefined' ) ? i : 0;

        //console.debug('[browseCopy]', list.length, i, sourceDir, destinationDir);
        if (
            sourceDir == undefined
            || sourceDir == ''
            || destinationDir == undefined
            || destinationDir == ''
        ) {
            var copyError = false;
            // is it the list the last file ?
            if (list.length != i) {
                copyError = new Error('cp() encountred a fatal error. You have to check your paths.\nSource: '+ sourceDir +'\nDestination: ' + destinationDir);
            }
            end(callback, copyError);
        } else {
            fs.lstat(sourceDir, function(err, stats) {

                if ( stats.isSymbolicLink() ) {
                    //console.debug('real path: ', fs.realpathSync(list[i]));
                    //console.debug('#2 ('+process.version+') Found symlink: '+ sourceDir,'\n', JSON.stringify(stats, null, 4));
                    try {
                        symlinkSync(fs.realpathSync(list[i]), listTo[i]);
                    } catch (realPathError) {
                        throw realPathError;
                    }

                    ++i;
                    browseCopy(list[i], listTo[i], excluded, callback, list, listTo, i)
                } else if ( stats.isDirectory() ) {

                    var isExcluded = false;
                    if ( typeof(sourceDir) != 'undefined' && excluded != undefined) {
                        var f, p = sourceDir.split('/');
                        f = p[p.length-1];
                        for (var r= 0; r<excluded.length; ++r) {
                            if ( typeof(excluded[r]) == 'object' ) {
                                if (excluded[r].test(f)) {
                                    isExcluded = true
                                }
                            } else if (f === excluded[r]) {
                                isExcluded = true
                            }
                        }
                    }

                    if (!isExcluded) {
                        if ( typeof(list[i]) == 'undefined' ) {
                            list[i] = sourceDir;
                            listTo[i] = destinationDir;
                        }

                        var createDir = new _(destinationDir);

                        createDir.mkdir( function(err, path) {
                            if (!err) {
                                readContent(sourceDir, destinationDir, function(_list, _listTo) {

                                    for (var p=0; p<_list.length; ++p) {
                                        list.push(_list[p]);
                                        listTo.push(_listTo[p])
                                    }
                                    ++i;
                                    browseCopy(list[i], listTo[i], excluded, callback, list, listTo, i)
                                })
                            } else {
                                console.error(err)
                            }
                        })
                    }  else {
                        ++i;
                        browseCopy(list[i], listTo[i], excluded, callback, list, listTo, i)
                    }

                } else {
                    copyFileToFile(sourceDir, destinationDir, i, function(err, file, i) {
                        ++i;
                        browseCopy(list[i], listTo[i], excluded, callback, list, listTo, i)
                    }, excluded)
                }
            })
        }


    }

    /**
     * Copy file to  file
     *
     * @param {string} source
     * @param {string} destination
     * @param {number} [i]
     * @param {number} [fileCount]
     *
     * @callback callback
     * @param {bool|string} err
     *
     * */
    var copyFileToFile = function(source, destination, i, callback, excluded) {
        var isExcluded = false;
        if ( typeof(excluded) != 'undefined' && excluded != undefined) {
            var f, p = source.split('/');
            f = p[p.length-1];
            for (var r= 0; r<excluded.length; ++r) {
                if ( typeof(excluded[r]) == 'object' ) {
                    if (excluded[r].test(f)) {
                        isExcluded = true
                    }
                } else if (f === excluded[r]) {
                    isExcluded = true
                }
            }
        }


        if (!isExcluded) {
            fs.lstat(destination, function(err, stats) {

                //Means that nothing exists. Needs create.
                if (err) {
                    startCopy(source, destination, i, function(err, i) {
                        //TODO - log error.
                        callback(err, source, i)
                    })
                } else {

                    if ( stats.isDirectory() ) {
                        var str;
                        var path = '/'+ (str = source.split(/\//g))[str.length-1];
                        destination += path
                    }

                    exists(destination, function(replaceFlag) {
                        if (replaceFlag) {
                            fs.unlink(destination, function(err) {
                                //TODO - log error.
                                startCopy(source, destination, i, function(err, i) {

                                    callback(err, source, i)
                                })
                            })
                        } else {
                            startCopy(source, destination, i, function(err, i) {
                                //TODO - log error.
                                callback(err, source, i)
                            })
                        }
                    })
                }//EO if (err)
            })
        } else {
            callback(false, source, i)
        }

        var startCopy = function(source, destination, i, callback) {

            copyFile(source, destination, i, function(err, i) {
                if (err) {
                    console.error(err.stack)
                }
                callback(err, i)
            })
        }
    }

    var copyFile = function(source, destination, i, callback) {

        var sourceStream = fs.createReadStream(source);
        var destinationStream = fs.createWriteStream(destination);

        sourceStream
            .pipe(destinationStream)
            .on('error', function() {
                var err = 'Error on Path.cp(...): Not found ' + source +' or ' + destination;
                callback(err, i)
            })
            .on('close', function() {
                callback(false, i)
            })
    }


    /**
     * move or rename, file or folder
     *
     * @param {string} target
     *
     * @callback callback
     * @param {string} errResponse
     * @param {string} [pathResponse]
     * */

    _.prototype.mv = function(target, callback) {

        var self = this;
        //Enter dir & start rm.
        var p = self.value;
        exists(p, function(found){
            if ( !found ) {
                var err = new Error(' mv() - source [ '+p+' ] does not exists !');
                console.error(err);
                if ( !callback ) {
                    throw err
                }
                callback(err)
            } else {
                mv(self, target)
                    .onComplete( function(err, path){
                        if (err) {
                            console.error(err);
                            return callback(err)
                        }
                        if (p == path && typeof(callback) != 'undefined') {
                            callback(err)
                        }
                    })
            }
        })
    }

    var mv = function(self, target) {
        console.debug("starting mv/copy from ", self.value, " to ", target);
        cp(self.value, target)
            .onComplete(function onCpMv(err) {
                console.debug("cp done... now unlinking source ", self.value);
                if (err) {
                    e.emit('mv#complete', err);
                    return;
                }


                rm(self.value).onComplete( function(err, path){
                    console.debug('rm() complete');
                    e.emit('mv#complete', err, path)
                })
            })

        return {
            /**
             * Complete event
             * @event mv#onComplete
             * */
            onComplete : function(callback) {
                //We want it once for the object path.
                e.once('mv#complete', function(err, path) {
                    if (err) {
                        console.error(err.stack)
                    }
                    callback(err, path)
                })
            }
        }
    }

    /**
     * _.rmSync() Delete a folder recursively
     *      if doesn't exists,
     *
     *      return
     *          err string if failed
     *          else return instance
     *
     * */
    _.prototype.rmSync = function() {

        if ( !existsSync(this.value) ) {
            return this // always return the instance for sync
        }
        cleanSlashes(this);

        try {
            // console.debug('rmSync() of ['+ this.value +'] : symlink ? '+ fs.lstatSync(this.value).isSymbolicLink());
            if ( fs.lstatSync(this.value).isSymbolicLink() ) {
                fs.unlinkSync(this.value);
                return this;
            }
            browseRemoveSync(this.value);
            return this // always return the instance for sync
        } catch (err) {
            return err // it has to be thrown clean to be "instanceof Error"
        }
    }

    var removeFoldersSync = function(list, l, i) {
        i = i || 0;
        if ( typeof(list[l]) == "undefined") {
            return list[l-1][list[l-1].length -1]
        } else {
            if (i === list[l].length-1 ) {
                i = 0;
                try {
                    fs.rmdirSync(list[l][i]);
                    ++l;
                    removeFoldersSync(list, l, i)
                } catch(err) {
                    console.debug(err.stack); // always keep trace of the original stack
                    throw new Error(err.message)
                }
            } else {
                ++i;
                try {
                    fs.rmdirSync(list[l][i]);
                    removeFoldersSync(list, l, i)
                } catch(err) {
                    console.debug(err.stack); // always keep trace of the original stack
                    throw new Error(err.message)
                }
            }
        }
    }

    var removeFileSync = function(filename) {
        try {
            fs.unlinkSync(filename)
        } catch (err) {
            console.debug(err.stack); // always keep trace of the original stack
            throw new Error(err.message)
        }
    }

    var browseRemoveSync = function(source, list, folders, i) {
        list = ( typeof(list) != 'undefined' ) ? list : [];
        folders = ( typeof(folders) != 'undefined' ) ? folders : [];
        i = ( typeof(i) != 'undefined' ) ? i : 0;
        var err = false;

        if (list.length === 0) {
            list.push(source)
        }

        if (source == undefined) {
            if (folders.length > 0) {
                removeFoldersSync(folders.reverse(), 0, 0)
            } else {
                return list[list.length -1]
            }
        } else {

            var stats = fs.lstatSync(source);

            if (stats instanceof Error)
                return stats;

            if ( stats.isSymbolicLink() ) {
                err = removeFileSync(source);
                if (err instanceof Error)
                    return err;

                ++i;
                browseRemoveSync(list[i], list, folders, i)
            } else if ( stats.isDirectory() ) {

                if (folders.length == 0) {
                    folders[0] = [];
                    folders[0].push(source)
                } else {
                    var l =  source.substring( (folders[0][0].length) ).match(/\//g);
                    if (l == null) {
                        l = 0
                    } else {
                        l = l.length
                    }
                    if ( typeof(folders[l]) == 'undefined') {
                        folders[l] = []
                    }
                    folders[l].push(source)
                }

                var files = fs.readdirSync(source);

                if ( files instanceof Error)
                    return files;

                if ( typeof(files) != 'undefined') {
                    for (var f=0; f<files.length; ++f) {
                        list.push( _(source +'/'+ files[f]) )
                    }
                }
                ++i;
                browseRemoveSync(list[i], list, folders, i)

            } else {
                err = removeFileSync(source);
                if (err instanceof Error)
                    return err;

                ++i;
                browseRemoveSync(list[i], list, folders, i)
            }
        }
    }

    /**
     * rm
     *
     * @callback callback
     * @param {string} errResponse
     * @param {string} [pathResponse]
     * */
    _.prototype.rm = function(callback) {
        var self = this;
        //Enter dir & start rm.
        self = cleanSlashes(self);
        var p = self.value;
        exists(p, function(found) {
            //console.debug(" does it exists ? ", p, exists );
            if (!found) {
                //console.debug("done removing ", p);
                callback(new Error('`'+p+'` not found'), p)

            } else {
                rm(p).onComplete( function(err, path) {
                    //console.debug("done removing... ", err);
                    callback(err, path)
                })
            }
        })
    }

    var rm = function(source) {

        browseRemove(source,  function(err, path) {
            //console.debug('rm done...', err, path, " VS ", source);
            e.emit('rm#complete', err, path)
        });

        return {
            /**
             * Complete event
             * @event rm#onComplete
             * */
            onComplete : function(callback) {
                e.once('rm#complete', function(err, path) {
                    if (err) {
                        console.error(err.stack)
                    }
                    //console.debug('calling back now...', err, path);
                    //This one is listened by several rm().
                    callback(err, path)
                })
            }
        }
    }

    /**
     * Remove file, symlinks or folders recursively
     *
     * @param {string} path - Path to delete
     *
     * @callback callback
     * @param {string} errResponse
     * @param {string} [pathResponse]
     *
     * @param {array} [list] - Paths list regardless of type
     * @param {number} [i] - Path iterator
     * @param {string} [root] - Path to delete last
     * @param {array} [rootList] - List of files & folder for the path to delete
     *
     * @fires rm#onComplete
     * @fires rm#onError
     * @fires rm#onSuccess
     *
     * @private
     * */

    var removeFolders = function(list, l, i, callback) {
        i = i || 0
        if ( typeof(list[l]) == "undefined") {
            callback(false, list[l-1][list[l-1].length -1])
        } else {
            if (i === list[l].length-1 ) {
                i = 0;
                fs.rmdir(list[l][i], function(err) {
                    if (err) callback(err);

                    ++l;
                    removeFolders(list, l, i, callback)
                })

            } else {
                ++i;
                fs.rmdir(list[l][i], function(err) {
                    if (err) callback(err);

                    removeFolders(list, l, i, callback)
                })
            }
        }
    }


    var readContentToRemove = function(source, list, cb) {
        fs.readdir(source, function(err, files) {
            if (!err) {
                if ( typeof(files) != 'undefined') {
                    for (var f=0; f<files.length; ++f) {
                        list.push( _(source +'/'+ files[f]) )
                    }
                }
                cb(list)
            } else {
                console.error(err)
            }
        })
    }

    var browseRemove = function(source, callback, list, folders, i) {
        list = ( typeof(list) != 'undefined' ) ? list : [];
        folders = ( typeof(folders) != 'undefined' ) ? folders : [];
        i = ( typeof(i) != 'undefined' ) ? i : 0;

        if (list.length === 0) {
            list.push(source)
        }

        if (source == undefined) {
            if (folders.length > 0) {
                removeFolders(folders.reverse(), 0, 0, callback)
            } else {
                callback(false, list[list.length -1])
            }
        } else {

            fs.lstat(source, function(err, stats) {
                if (!err) {
                    if ( stats.isDirectory() ) {

                        if (folders.length == 0) {
                            folders[0] = [];
                            folders[0].push(source)
                        } else {
                            //console.debug("want it !! ", source, " VS ", folders[0][0], folders[0][0].length );
                            var l =  source.substring( (folders[0][0].length) ).match(/\//g);
                            if (l == null) {
                                l = 0
                            } else {
                                l = l.length
                            }
                            if ( typeof(folders[l]) == 'undefined') {
                                folders[l] = []
                            }
                            folders[l].push(source)
                        }

                        readContentToRemove(source, list, function(_list){
                            ++i;
                            browseRemove(_list[i], callback, _list, folders, i)
                        })

                    } else {
                        removeFile(source, function(err) {
                            ++i;
                            browseRemove(list[i], callback, list, folders, i)
                        })
                    }
                } else {
                    console.error(err)
                }

            })
        }
    }

    /**
     * Remove file
     *
     * @param {string} filename
     *
     * @callback callback
     * @param {string|boolean} error
     * @param {string} filename
     *
     *
     *
     * @private
     * */

    var removeFile = function(filename, callback) {
        fs.unlink(filename, function(err){
            if (err) {
                console.error(err.stack);
                callback(err)
            } else {
                callback(false)
            }
        })
    }

    var toUnixStyle = function(self) {
        var i = _this.paths.indexOf(self.value);
        return ( i > -1 ) ? _this.paths[i].replace(/\\/g, "/") : self.value;
    }
    _.prototype.toUnixStyle = function() {
        // var self = this;
        // var i = _this.paths.indexOf(self.value);
        // return ( i > -1 ) ? _this.paths[i].replace(/\\/g, "/") : self.value;
        return toUnixStyle(this)
    }

    var toWin32Style = function(self) {
        var i = _this.paths.indexOf(self.value);
        return ( i > -1 ) ? _this.paths[i].replace(/\//g, "\\") : self.value;
    }
    _.prototype.toWin32Style = function() {
        // var self = this;
        // var i = _this.paths.indexOf(self.value);
        // return ( i > -1 ) ? _this.paths[i].replace(/\//g, "\\") : self.value;
        return toWin32Style(this)
    }

    /**
     * Check if a given path is valid
     *
     * Will pass as valid:
     * -------------------
     * C:\data\folder\file (  "C:\\data\\folder\\file" )
     * C:\data\folder\other file (  "C:\\data\\folder\\other\ file" )
     * /data/folder/file
     * /data/folder/other file ( "/data/folder/other\ file" )
     * \\192.168.0.1\folder\file ( "\\\\192.168.0.1\\folder\\file" )
     *
     * @returns {boolean} isReal
     *
     * @callback [ cb ]
     * @param {boolean} isReal
     * */
    _.prototype.isValidPath = function(cb) {
        // compatible nix & win32 - (sensitive) case handled for posix
        var re = /(^(?!:[\w]\:|\\)(\/[a-zA-Z_\-\s0-9\.]+)+|^(?:[\w]\:|\\)(\\[a-z_\-\s0-9\.]+)+)/;

        cleanSlashes(this); // ??
        if ( typeof(cb) != 'undefined' && typeof(cb) == 'function') {
            cb( re.test(this.value) )
        } else {
            return re.test(this.value)
        }
    }



    var parseCtxObject = function (o, obj) {

        for (let i in o) {
            if (o[i] !== null && typeof(o[i]) == 'object') {
                parseCtxObject(o[i], obj);
            } else if (o[i] == '_content_'){
                o[i] = obj
            }
        }

        return o
    }

    /**
     * setPath
     * Set path by name
     *
     * @param {String} name - Path name
     * @returns {String} path
     * */
    setPath = function(name, path) {

        if ( !path || typeof(path) == 'undefined' || path == '' ) {
            throw new Error('setPath(name, path): path cannot be empty or undefined')
        }
        // check if symlink to get realpath
        // var stats = fs.lstatSync(path);
        // if (stats instanceof Error) {
        //     throw new stats
        // }
        // if ( stats.isSymbolicLink() ) {
        //     path = fs.realpathSync(path)
        // }
        var paths = null;
        if ( typeof(name) == 'string' && /\./.test(name) ) {
            var keys        = name.split(/\./g)
                , newObj    = {}
                , str       = '{'
                , _count    = 0;

            for (let k = 0, len = keys.length; k<len; ++k) {
                str +=  "\""+ keys.splice(0,1)[0] + "\":{";

                ++_count;
                if (k == len-1) {
                    str = str.substr(0, str.length-1);
                    str += "\"_content_\"";
                    for (let c = 0; c<_count; ++c) {
                        str += "}"
                    }
                }
            }

            newObj = parseCtxObject(JSON.parse(str), path);

            paths = getContext('paths');
            paths = merge(paths, newObj);
            setContext("paths", paths)

        } else {
            // normal case
            paths = getContext('paths');

            var userPaths = {};
            if ( typeof(name) == 'object') {
                for (let n in name) {
                    if ( typeof(name) == 'string' && /\./.test(name) ) {
                        setPath(n, name[n])
                    } else {
                        userPaths[n] = _(name[n]);
                        merge(paths, userPaths, true)
                    }
                }
                setContext('paths', paths)

            } else {
                paths[name] = path;
                setContext('paths', paths)
            }
        }
    }



    /**
     * Get path by name
     * @param {String} name Path name
     * @returns {String} path
     * */
    getPath = function(name) {
        var paths = getContext('paths');
        if ( typeof(paths[name]) != "undefined" ) {
            return paths[name]
        } else {
            throw new Error('Path `'+ name+'` not found. Check the spelling or add a new one using setPath("'+name+'", "\/your\/new\/pathname")')
        }
    }

    setPaths = function(paths) {
        setContext('paths', paths)
    }

    getPaths = function() {
        return getContext("paths")
    }

}//EO PathHelper.

module.exports = PathHelper