/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

//Imports.
var fs              = require('fs');
var EventEmitter    = require('events').EventEmitter;
var corePath        = getPath('gina').core;
var Config          = require( corePath + '/config' );
var config          = new Config();
var lib             = require('gina').lib;
var console         = lib.logger;
var math            = lib.math;
var inherits        = lib.inherits;
//var merge           = lib.merge;
var configLib     = new lib.Config();
var modelUtil       = new lib.Model();
var Module          = require('module');

//dev     = require(_(corePath + '/dev') ),


/**
 * @class Model class
 *
 *
 * @package     Gina
 * @namespace
 * @author      Rhinostone <contact@gina.io>
 * @api         Public
 */
function Model(namespace, _config) {
    var self = this;
    this.i = 0;
    var local = {
        connectorPath: null,
        modelPath: null,
        entitiesPath: null,
        connection: null,
        files: {},
        toReload: [],
        trying: 0
    };

    var _configuration = null;
    var _connector = null;

    var cacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;
    //var isStandalone = config.Host.isStandalone();


    var setup = function(namespace) {
        if ( typeof(namespace) == 'undefined' || namespace == '') {
            console.error('[ MODEL ][ '+ namespace +' ] MODEL:ERR:1 EEMPTY: Model namespace',  __stack);
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


        console.debug('[ MODEL ][ ' + model +' ] Bundle: '+ bundle);
        //console.debug('[ MODEL ][ ' + model +' ] Model: '+ model);
        self.name       = _connector;
        self.bundle     = bundle;
        self.model      = model;

        self.modelDirName = model;
        var modelConnectors = getContext('modelConnectors');
        if (modelConnectors) {
            self.connectors = getContext('modelConnectors')[self.name];
            self.database   = self.connectors.database;
            self.connector  = self.connectors.connector;
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
        var connectorPath   = null;

        // this is supposed to happen on load or for dev env; on reload, with a checksum
        var conf        = getConfigSync(bundle);
        //local.locals    = conf.locals;

        if (conf) {
            _configuration = conf.connectors;
            self.connector = _configuration[self.name].connector;

            console.debug('[ MODEL ][ ' + model +' ] About to scan: '+ conf.path);
            //TODO - More controls...

            //For now, I just need the F..ing entity name.
            connectorPath       = local.connectorPath = _(GINA_FRAMEWORK_DIR +'/core/connectors/'+ self.connector);
            var modelPath       = local.modelPath = _(conf.path + '/' + modelDirName);
            var entitiesPath    = local.entitiesPath = _(modelPath + '/entities');
            console.debug('[ MODEL ][ ' + model +' ] Scanning model entities: ', entitiesPath +' - Existing path ? '+ fs.existsSync(entitiesPath) );
            if (!fs.existsSync(entitiesPath)) {
                //fs.mkdirSync(entitiesPath) // creating empty path
                new _(entitiesPath).mkdirSync();
            }

            connectorPath   = _(connectorPath + '/lib/connector.js');
            console.debug('[ MODEL ][ ' + model +' ] Loading connector: ' + connectorPath);
            //Getting Entities Manager.
            var exists = fs.existsSync(connectorPath);
            if (exists) {
                if (cacheless)
                    delete require.cache[require.resolve(_(connectorPath, true))];

                var Connector = require(_(connectorPath, true));

                self.connect(
                    Connector,
                    function onConnect(err, conn) {
                        if (err) {
                            console.error('[MODEL][' + model +']', err.stack);
                            self.emit('model#ready', err, self.bundle, self.name, null)

                        } else {
                            local.connection = conn;
                            self.emit('model#ready', false, self.bundle, self.name, conn)
                        }
                    }
                )
            } else {//Means that no connector was found in models.

                //finished.
                self.emit('model#ready', new Error('[ MODEL ][ '+ model +' ] No connector found'), self.bundle, self.name, conn)
            }

        } else {
            console.warn('[ MODEL ][ ' + model +' ] no configuration found...');
            self.emit('model#ready', new Error('[ MODEL ][ ' + model +' ] no configuration found for your model: ' + model), self.bundle, self.name, null)
        }

        return self
    }


    this.connect = function(Connector, callback) {
        if ( typeof(self.connectors[_connector]) == 'undefined' ) {
            //console.debug('[ MODEL ] Need to create connector instance ...');
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

        var configuration = null;
        var env = null, conf = null, connectors = null;
        if ( typeof (_config) != 'undefined' ) {
            configuration = _config;
            env = _config.env;
            conf = _config;
            connectors = _config.content.connectors;
        } else {
            configuration = config.getInstance(bundle);
            env = configuration.Env.current;
            conf = configuration.Env.getConf(bundle, env);
        }
        console.debug('[ MODEL ][ ' + _connector + ' ] env ', conf.env);
        console.debug('[ MODEL ][ ' + _connector + ' ] configuration modelsPath ', conf.modelsPath);
        console.debug('[ MODEL ][ ' + _connector + ' ] connectors ', connectors);

        // try {

        //     var locals = _locals = configLib.getSync('gina', 'locals.json')
        // } catch (err) {
        //     console.emerg('[ MODEL ][ ' + _connector +' ] Error while calling `Model::getConfigSync()` '+ err.stack||err.message);
        //     if ( i < 10) {
        //         console.debug('[ MODEL ][ ' + _connector +' ] about to retry to load locals.json');
        //         setTimeout(function(){

        //             i = i+1;
        //             console.debug('[ MODEL ][ ' + _connector +' ] retry ('+i+') ...');
        //             return getConfigSync(bundle, i)
        //         }, 300)

        //     } else {
        //         throw new Error('Config could not be loaded');
        //         process.exit(1)
        //     }
        //     return false
        // }

        if ( typeof(configuration) != 'undefined' /**&& locals*/) {

            // configuration object.
            var confObj = {
                connectors  : connectors,
                path        : conf.modelsPath/**,
                locals      : locals*/
            };

            return confObj
        } else {
            throw new Error('[ MODEL ][ ' + _connector +' ] Config not instantiated');
            return undefined
        }
    }

    /**
     * Get Model Configuration
     *
     * @returns {object|undefined} configuration
     * */
    this.getConfig = function(connector){
        connector = ( typeof(connector) == 'undefined' ) ?  _connector : connector;

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
