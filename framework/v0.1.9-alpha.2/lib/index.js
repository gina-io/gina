/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib
 * @description Central registry that loads and exposes every framework library.
 * Assigned to the global `lib` variable on first require so all framework code
 * can access `lib.merge`, `lib.Collection`, etc. without an explicit `require`.
 *
 * @package    gina.framework
 * @namespace  lib
 * @author     Rhinostone <contact@gina.io>
 */

//var merge = require('./merge');

/**
 * Library registry constructor — returns a plain object `self`, not `this`.
 * Consumed via `lib = new Lib()` in `gna.js`.
 *
 * @class Lib
 * @constructor
 */
function Lib() {


    var _require = function(path) {

        var cacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;
        if (cacheless) {
            delete require.cache[require.resolve(path)];
            return require(path)
        } else {
            return require(path)
        }
    }



    var self = {
        Config          : _require('./config'),
        //dev     : require('./lib/dev'),//must be at the same level than gina.lib => gina.dev
        inherits        : _require('./inherits'),
        helpers         : _require('./../helpers'),
        //this one must move to Dev since it's dev related
        Domain          : _require('./domain'),
        Model           : _require('./model'),
        Collection      : _require('./collection'),
        merge           : _require('./merge'),
        generator       : _require('./generator'),//move to gina.dev
        Proc            : _require('./proc'),
        Shell           : _require('./shell'),
        // replaced: _require('./logger') — Logger is a singleton persisted via getContext('loggerInstance').
        // refreshCore() (server.isaac.js) re-runs Lib() on every dev-mode HTTP request by deleting and
        // re-requiring lib/index.js. _require would then delete logger from require.cache and re-require it,
        // calling Logger() again → "Logger instance already exists: reusing it ;)" once per request (#4).
        // Logger hot-reload is unnecessary: the singleton state survives through getContext regardless of
        // module eviction, and Logger() returns the existing instance anyway. Use plain require (cache hit).
        logger          : require('./logger'),
        math            : _require('./math'),
        routing         : _require('./routing'),
        archiver        : _require('./archiver'),
        cmd             : _require('./cmd'),
        SessionStore    : _require('./session-store'),
        SwigFilters     : _require('./swig-filters'),
        Cache           : _require('./cache'),
        // replaced: _require('./state') — StateStore is a singleton backed by node:sqlite
        // (DatabaseSync). Hot-reloading it in dev mode would close and re-open the DB
        // connection on every HTTP request, racing with in-flight writes. Use plain
        // require() so the singleton survives refreshCore() evictions. (#CN2v3)
        State           : require('./state'),
    };

    /**
     * Strip macOS dot-files (`.DS_Store`, `._*`, etc.) from a directory listing.
     *
     * @memberof module:lib
     * @param {string[]} files - Array of filenames from `fs.readdirSync`
     * @returns {string[]} Filtered array
     *
     * @deprecated Use once in `server.js`; TODO — remove entirely
     */
    self.cleanFiles = function(files){
        for(var f=0; f< files.length; f++){
            if(files[f].substring(0,1) == '.')
                files.splice(0,1);
        }
        return files;
    };



    return self
}
// Making it global
lib = new Lib();

/**
 * Bootstrap the command dispatcher when running inside the daemon process.
 * Sets Gina paths, seeds CLI options from the package manifest, and calls
 * `lib.cmd.onExec()` to start processing commands.
 *
 * @memberof module:lib
 * @param {object}  opt                    - Bootstrap options
 * @param {Array}   opt.argv               - `process.argv`-style argument array
 * @param {string}  opt.ginaPath           - Absolute path to gina root
 * @param {string}  opt.frameworkPath      - Absolute path to the framework version dir
 * @param {object}  opt.pack               - Package manifest (`version`, `copyright`)
 * @param {string}  opt.task               - CLI task name
 * @param {string}  opt.homedir            - User home directory
 * @param {object}  opt.client             - Socket client reference
 * @param {boolean} [opt.isFromFramework]  - `true` when invoked from framework internals
 * @returns {void}
 */
lib.cmd.load = function(opt){

    process.argv = opt.argv;

    //Set gina paths.
    setPath('gina.root', _(opt.ginaPath));
    setPath('framework', _(opt.frameworkPath));
    setPath('gina.core', _(opt.frameworkPath +'/core'));
    setPath('gina.lib', _(opt.frameworkPath +'/lib'));
    setPath('gina.helpers', _(opt.frameworkPath +'/helpers'));

    //Getting package.
    var p = opt.pack;

    //Setting default options.
    lib.cmd.setOption([
        {
            'name' : 'version',
            'content' : p.version
        },
        {
            'name' : 'copyright',
            'content' : p.copyright
        },
        {
            'name' : 'task',
            'content' : opt.task
        },
        {
            'name' : 'homedir',
            'content' : opt.homedir
        }
    ]);

    var isFromFramework = ( typeof(opt.isFromFramework) != 'undefined') ? true : false;
    lib.cmd.onExec(opt.client, isFromFramework, opt)
};

module.exports = lib