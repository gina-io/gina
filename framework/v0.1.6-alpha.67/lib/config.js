/* Gina.Lib.Config
 *
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */


//Imports.
var fs          = require('fs');
var console     = require('./logger');
var math        = require('./math');
var generator   = require('./generator');


/**
 * Config constructor
 * @contructor
 * */
function ConfigUtil() {

    var self = this; //, mainConfig

    /**
     * Init
     * @contructor
     * */
    var init = function() {

        if ( !ConfigUtil.instance ) {
            try {
                self.paths = getContext('paths');
            } catch (err) {
                self.paths = {};
            }

            var path = new _(__dirname).toUnixStyle();
            self.__dirname =  _( path.substring(0, (path.length - 4)) );

            ConfigUtil.instance = self;
            return self;
        } else {
            self = ConfigUtil.instance;
            return ConfigUtil.instance;
        }
    }


    /**
     * Set config file if !exists
     *
     * @param {string} app - App name
     * @param {string} file - File to save
     * @param {object} content - JSON content to save
     * */
    this.set = function(app, file, content, callback){
        switch (app) {
            case 'gina':
            case 'gina.lib':
                setFile(app, file, content, function(err){
                    callback(err);
                });
                break;
        }
    }

    /**
     * Get config file if exists
     *
     * @param {string} project - Project name
     * @param {strins} key - File name to save + .ext
     *
     * @callback callback
     * @param {string|boolean} err
     * @param {object} config - Bundle Configuration
     * */
    this.get = function(project, file, callback){

        var config = null, err = false;

        switch (project) {
            case 'gina':
            case 'gina.lib':
                try {
                    //You are under gina.lib/lib/...
                    if ( typeof(self.value) != "undefined" ) {

                        try {
                            config = self.value;//????
                        } catch (_err) {
                            err = 'Lib.Config.get(...) : self.value['+ file +'] : key not found.\n' + _err;
                        }

                    } else {
                        //Getting paths.
                        if ( typeof(self.paths.project) != 'undefined' ) {
                            //console.error("requiring :=> ",  self.paths.project + '/.gna/locals.json');
                            try {
                                config = require(self.paths.project  + '/.gna/' + file);
                                self.value = config;
                                self.paths = config['paths'];

                            } catch (_err) {
                                //Means that the file was not found..
                                err = new Error(self.__dirname  + '/.gna/locals.json: project configuration file not found.\n'+ (_err.stack||_err.message));
                                console.emerg(err);
                                process.exit(1)
                            }
                        }
                    }
                    callback(err, config)

                } catch (_err) {
                    err = new Error('[ LibConfig ]  .gna/locals.json: project configuration file not found. \n' + (_err.stack||_err.message));
                    //logger.error('gina', 'LIB:CONFIG:ERR:3', err, __stack);
                    callback(err);
                }
                break;

            default :
                callback('[ LibConfig ] Config.get('+project+'): case not found');
        }
    }

    /**
     * Get sync config file if exists
     *
     * @param {string} app - App name
     * @returns {object} config - App Configuration
     *
     * @private
     * */
    this.getSync = function(project, file, i){
        i = i || 0;
        var maxRetry    = 7
            , delay     = 300
        ;

        if (typeof(file) == 'undefined') {
            file = 'locals.json'
        }

        if ( typeof(self.value) != 'undefined' ) {
            return self.value;
        } else {
            var filename = self.paths.root +'/.gna/'+ file;
            if (i > 0) {
                console.debug('[ LibConfig ] retrying [ '+i+' ] to load: `' + filename +'`')
            }

            try {
                if ( fs.existsSync(filename) ) {
                    return require(filename)
                } else {
                    // you might just be experimenting some latencies
                    if (i < maxRetry) {
                        console.debug('[ LibConfig ] retrying to load config after timeout `' + filename +'`');
                        setTimeout(function(){
                            console.debug('[ LibConfig ] It is time re reload config');
                            self.getSync(project, file, i+1)
                        }, delay);
                        //return
                    } else {
                        var err = new Error('[ LibConfig ] '+ filename + ' not found');
                        console.emerg(err.stack||err.message);
                        process.exit(1);
                    }
                }
            } catch (err) {
                if (i < maxRetry) {
                    console.debug('[ LibConfig ] (catched) retrying to load config after timeout');
                    setTimeout(function(){
                        console.debug('[ LibConfig ] It is time re reload config');
                        self.getSync(project, file, i+1)
                    }, delay);
                } else {
                    console.error(err.stack);
                    throw new Error(err.message);
                }
            }
        }
    }

    /**
     * Create a config file
     *
     * @param {string} app - Targeted application
     * @param {string} file - File save
     * @param {string} content - Content fo the file to save
     *
     *
     * TOTO - Avoid systematics file override.
     * @private
     * */

    var setFile = function(app, file, content, callback) {

        var paths = {
            root    : content.paths.root,
            lib     : content.paths.lib
        };
        var gnaFolder = content.paths.root + '/.gna';
        console.debug('Checking for `'+ gnaFolder +'` ...');

        // !! Not the project name
        self.project = content.project;

        self.paths = paths;

        //Create path.
        var createFolder = function(){
            if ( fs.existsSync(gnaFolder) ) {
                if ( !fs.existsSync(gnaFolder +'/'+ file) ) {
                    createContent(gnaFolder +'/'+ file, gnaFolder, content, function(err){
                        setTimeout(function(){
                            callback(err)
                        }, 500)
                    })
                } else { // already existing ... won't overwrite
                    callback(false)
                }

            } else {
                fs.mkdir(gnaFolder, 0777, function(err){
                    if (err) {
                        console.error(err.stack);
                        callback(err)
                    } else {
                        //Creating content.
                        createContent(gnaFolder+ '/' +file, gnaFolder, content, function(err){
                            setTimeout(function(){
                                callback(err)
                            }, 500)
                        })
                    }
                })
            }

        };

        fs.exists(gnaFolder, function(exists){
            if (!exists) {
                createFolder()
            } else {
                // test if decalred path matches real path and overwrite if not the same
                // in case you move your project
                var filename        = _(gnaFolder +'/'+ file, true);

                if ( !fs.existsSync(filename) ) {
                    generator.createFileFromDataSync(
                        JSON.stringify(content),
                        filename
                    )
                }

                var checksumFileOld = null;
                try {
                    checksumFileOld = _(gnaFolder +'/'+ math.checkSumSync( JSON.stringify( require(filename) ), 'sha1'), true) + '.txt';
                } catch (err) {
                    // must be empty
                }

                var checksumFile    = _(gnaFolder +'/'+ math.checkSumSync( JSON.stringify(content), 'sha1'), true) + '.txt';

                var verified        = (checksumFileOld == checksumFile) ? true : false;


                if ( !fs.existsSync(checksumFile) && fs.existsSync(filename) || !fs.existsSync(filename) || !verified) {
                    if ( fs.existsSync(filename) ) fs.unlinkSync(filename);
                    if ( fs.existsSync(checksumFile) ) fs.unlinkSync(checksumFile);

                    createContent(filename, gnaFolder, content, function(err){
                        fs.openSync(checksumFile, 'w');
                        setTimeout(function(){
                            callback(err)
                        }, 500)
                    })
                } else if ( fs.existsSync(filename) ) {

                    var locals = require(gnaFolder +'/'+ file);

                    if (paths.lib != locals.paths.lib) {

                        new _(gnaFolder).rm( function(err){
                            if (err) {
                                console.warn('found error while trying to remove `.gna`\n' + err.stack)
                            }

                            //setTimeout(function(){
                                //console.debug('Done removing `gnaFolder` : '+ gnaFolder);
                            createFolder();
                            //}, 200);
                        })
                    } else {
                        callback(false)// nothing to do
                    }
                } else {
                    callback(false)// nothing to do
                }
            }
        })
    }


    /**
     * Remove symbolic link
     *
     * @param {string} path
     * @callback callback
     *
     * @private
     * */
    var removeSymlink = function(path, callback){

        fs.exists(path, function(exists){
            if (exists) {
                fs.lstat(path, function(err, stats){
                    if (err) console.error(err.stack);

                    if ( stats.isSymbolicLink() ) fs.unlink(path, function(err){
                        if (err) {
                            console.error(err.stack);
                            callback(err)
                        } else {
                            //Trigger.
                            onSymlinkRemoved(self.paths, function(err){
                                if (err) console.error(err.stack);

                                callback(false)
                            })
                        }
                    })
                })
            } else {
                //log & ignore. This is not a real issue.
                //logger.warn('gina', 'LIB:CONFIG:WARN:1', 'Path not found: ' + path, __stack);
                console.warn( 'Path not found: ' + path, __stack);
                onSymlinkRemoved(self.paths, function(err){
                    //if (err) logger.error('gina', 'LIB:CONFIG:ERR:9', err, __stack);
                    if (err) console.error(err.stack||err.message);

                    callback(false)
                })
            }
        })
    }

    /**
     * Symbolic link remove event
     *
     * @param {string} [err]
     * @callback callback
     *
     * @private
     * */
    var onSymlinkRemoved = function(paths, callback){
        //Remove original.
        var p = new _(paths.root + '/.gna');
        var path = p.toString();

        //Remove folers.
        fs.exists(path, function(exists){
            //delete when exists.
            if (exists) {
                //console.log("yeah about to delete main folder: ", p.toString());
                //Delete ans die here..
                p.rm(function(err, path){
                    //console.log("receives ", err, path);
                    if (err) {
                        //logger.error('gina', 'LIB:CONFIG:ERR:8', err, __stack);
                        console.error(err.stack||err.message);
                        callback(err)
                    } else {
                        //logger.info('gina', 'LIB:CONFIG:INFO:1', path +': deleted with success !');
                        console.info( path +': deleted with success !');
                        callback(false)
                    }
                })
            }
        })
    }

    /**
     * Create content
     *
     * @param {string} filename - Fullpath
     * @content {string} content
     *
     * @private
     * */
    var createContent = function(filename, gnaFolder, content, callback){
        if ( fs.existsSync(filename) ) {
            fs.unlinkSync(filename)
        }
        fs.appendFile(
            filename,
            JSON.stringify(content, null, '\t'),
            null,
            function(err){
                if (err) {
                    //logger.error('gina', 'LIB:CONFIG:ERR:2', err, __stack);
                    console.error('`Error on while calling createContent()`: ' + err.stack||err.message);
                    callback(err)
                } else {
                    setTimeout(function(){
                        callback(err)
                    }, 1000)
                }
            }//EO function
        )//EO fs.appendFile
    }

    /**
     * Get var value by namespace
     *
     * @param {string} namespace
     * @param {object} [config ] - Config object
     * @returns {*} value - Can be String or Array
     *
     * @private
     * */
    var getVar = function(namespace, config) {
        if ( typeof(config) == "undefined" )
            var config = self.getSync(app);

        if (config != null) {
            var split = namespace.split('.'), k=0;
            while (k<split.length) {
                config = config[split[k++]]
            }
            return config
        } else {
            return null
        }
    }

    /**
     * Get path by app & namespance
     *
     * @param {string} app
     * @param {string} namespace
     *
     * @callback callback
     * @param {string} err
     * @param {string} path
     *
     * @private
     * */
    var getPath = function(app, namespace, callback){

        self.get(app, function(err, config){
            if (err) {
                //logger.error('gina', 'LIB:CONFIG:ERR:4', err, __stack);
                console.error(err.stack||err.message);
                callback(err + 'Lib.Config.get(...)');
            }

            try {
                callback( false, getVar('paths.' + namespace, config) );

            } catch (err) {
                var err = new Error('Config.getPath(app, cat, callback): cat not found');
                callback(err)
            }
        })
    }


    /**
     * Get project name
     *
     * @returns {string} projectName
     *
     * */
    this.getProjectName = function(){
        if ( self.paths != undefined && self.paths.root != undefined ) {
            var arr = self.paths.root.split("/");
            return arr[arr.length-1]
        } else {
            return null
        }
    }

    return init();
}
module.exports = ConfigUtil;