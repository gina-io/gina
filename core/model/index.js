/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

//Imports.
var fs              = require('fs');
var EventEmitter    = require('events').EventEmitter;
//var corePath        = getPath('gina.core');
var corePath        = getPath('gina').core;
var Config          = require( corePath + '/config' );
var config          = new Config();
var utils           = require('gina').utils;
var console         = utils.logger;
var math            = utils.math;
var inherits        = utils.inherits;
//var merge           = utils.merge;
var utilsConfig     = new utils.Config();
var modelUtil       = new utils.Model();
var Module          = require('module');

//UtilsConfig = Utils.Config(),
//dev     = require(_(corePath + '/dev') ),


/**
 * @class Model class
 *
 *
 * @package     Gina
 * @namespace
 * @author      Rhinostone <gina@rhinostone.com>
 * @api         Public
 */
function Model(namespace) {
    var self = this;
    this.i = 0;
    var local = {
        modelPath: null,
        entitiesPath: null,
        connection: null,
        files: {},
        toReload: [],
        trying: 0
    };

    var _configuration = null;
    var _connector = null;

    var cacheless = (process.env.IS_CACHELESS == 'false') ? false : true;
    var standalone = config.Host.isStandalone();


    var setup = function(namespace) {
        if ( typeof(namespace) == 'undefined' || namespace == '') {
            console.error('gina', 'MODEL:ERR:1', 'EEMPTY: Model namespace', __stack);
        }

        var model, namespace = namespace.split(/\//g);
        _connector = namespace[1];//Has to be writtien the same for the connetors.json decalration or for the model folder
        var bundle = namespace[0];
        namespace.shift();
        //Capitalize - Normalize
        if (namespace.length > 1) {
            //            for (var i; i<namespace.length; ++i) {
            //                namespace[i] = namespace[i].substring(0, 1).toUpperCase() + namespace[i].substring(1);
            //            }

            model = namespace.join(".");
        } else {
            //Dir name.
            model = namespace[0];
        }


        console.debug("\nBundle: ", bundle);
        console.debug("Model: ", model);
        self.name       = _connector;
        self.bundle     = bundle;
        self.model      = model;
        self.modelDirName = model;
        var modelConnectors = getContext('modelConnectors');
        if (modelConnectors) {
            self.connectors = getContext('modelConnectors')[self.name];
            self.database = self.connectors.database;
        } else {
            self.connectors = {};
        }

    }

    /**
     * Init
     *
     * @param {string} namesapce
     *
     * @private
     * */
    var init = function(reload) {

        var bundle          = self.bundle;
        var model           = self.model;
        var modelDirName    = self.modelDirName;

        // this is supposed to happen on load or for dev env; on reload, with a checksum
        var conf        = getConfigSync(bundle);
        local.locals    = conf.locals;

        if (conf) {
            _configuration = conf.connectors;

            console.debug("CONF READY ", model, conf.path);
            //TODO - More controls...

            //For now, I just need the F..ing entity name.
            var modelPath       = local.modelPath = _(conf.path + '/' + modelDirName);
            var entitiesPath    = local.entitiesPath = _(modelPath + '/entities');
            console.debug('models scaning... ', entitiesPath, fs.existsSync(entitiesPath));
            if (!fs.existsSync(entitiesPath)) {
                fs.mkdirSync(entitiesPath) // creating empty path
            }

            var connectorPath   = _(modelPath + '/lib/connector.js');
            //Getting Entities Manager.
            var exists = fs.existsSync(connectorPath);
            if (exists) {
                if (cacheless)
                    delete require.cache[_(connectorPath, true)];

                var Connector = require(_(connectorPath, true));

                self.connect(
                    Connector,
                    function onConnect(err, conn) {
                        if (err) {
                            console.error(err.stack);
                            self.emit('model#ready', err, self.bundle, self.name, null)

                        } else {
                            local.connection = conn;
                            self.emit('model#ready', false, self.bundle, self.name, conn)
                        }
                    }
                )
            } else {//Means that no connector was found in models.

                //finished.
                self.emit('model#ready', new Error('[ '+self.name+' ] No connector found'), self.bundle, self.name, conn)
            }

        } else {
            console.debug("no configuration found...");
            self.emit('model#ready', new Error('no configuration found for your model: ' + model), self.bundle, self.name, null)
        }

        return self
    }


    this.connect = function(Connector, callback) {
        if ( typeof(self.connectors[_connector]) == 'undefined' ) {
            self.connectors[_connector] = {};
            var connector = new Connector( self.getConfig(_connector) );

            connector.onReady( function(err, conn){
                self.connectors[_connector].err = err;
                self.connectors[_connector].conn = conn;

                callback(err, conn);
            });

        } else {
            callback(self.connectors[_connector].err, self.connectors[_connector].conn);
        }
    }

    this.reload = function(conf, cb) {
        setup(namespace);
        init(cb)
    }

    /**
     * Get Model configuration
     *
     * @param {string} bundle
     *
     * @callback callback
     * @param {boolean|string} err - Error Status response
     * @param {object} conf - Configuration response
     *
     * @private
     * */
    var getConfigSync = function(bundle, i) {
        var i = i || 0;
        var configuration = config.getInstance(bundle);

        try {

            var locals = _locals = utilsConfig.getSync('gina', 'locals.json')
        } catch (err) {
            console.emerg('Error while calling `Model::getConfigSync()` '+ err.stack||err.message);
            if ( i < 10) {
                console.debug('about to retry to load locals.json');
                setTimeout(function(){

                    i = i+1;
                    console.debug('retry ('+i+') ...');
                    return getConfigSync(bundle, i)
                }, 300)

            } else {
                throw new Error('Config could not be loaded');
                process.exit(1)
            }
            return false
        }

        if ( typeof(configuration) != 'undefined' && locals) {

            var env = configuration.Env.current;
            var conf = configuration.Env.getConf(bundle, env);

            // configuration object.
            var confObj = {
                connectors  : conf.content.connectors,
                path        : conf.modelsPath,
                locals      : locals
            };

            return confObj
        } else {
            throw new Error('Config not instantiated');
            return undefined
        }
    }

    /**
     * Get Model Configuration
     *
     * @return {object|undefined} configuration
     * */
    this.getConfig = function(connector){
        var connector = ( typeof(connector) == 'undefined' ) ?  _connector : connector;

        if (_configuration) {
            return ( typeof(connector) != 'undefined' ) ? _configuration[connector] : undefined
        } else {
            return undefined
        }
    }


    this.onReady = function(callback) {
        self.once('model#ready', function(err, bundle, model, conn) {
            // entities == null when the database server has not started.
            if ( err ) {
                console.error(err.stack||err.message)
                //console.log('No entities found for [ '+ self.name +':'+ entityName +'].\n 1) Check if the database is started.\n2) Check if exists: /models/entities/'+ entityName);
            }
            callback(err, bundle, model, conn)
        });
        setup(namespace);
        return init()
    };

    return this
};
Model = inherits(Model, EventEmitter);
module.exports = Model
