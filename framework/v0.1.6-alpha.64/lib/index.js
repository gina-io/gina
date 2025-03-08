/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Lib Class
 *
 * @package    gina.framework
 * @namespace  lib
 * @author     Rhinostone <contact@gina.io>
 */

//var merge = require('./merge');

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
        logger          : _require('./logger'),
        math            : _require('./math'),
        routing         : _require('./routing'),
        archiver        : _require('./archiver'),
        cmd             : _require('./cmd'),
        SessionStore    : _require('./session-store'),
        SwigFilters     : _require('./swig-filters')
    };

    /**
     * Clean files on directory read
     * Mac os Hack
     * NB.: use once in the server.js
     * TODO - remove it...
     **/
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

// Needed for by the daemon
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