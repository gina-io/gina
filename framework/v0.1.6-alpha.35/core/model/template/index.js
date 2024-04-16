/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @class Model class
 *
 *
 * @package     Gina
 * @namespace
 * @author      Rhinostone <contact@gina.io>
 * @api         Public
 */

var Model;

//Imports.
var fs      = require('fs');
var Module  = require('module');
var lib     = require('gina').lib;
var merge   = lib.merge;
var EventEmitter  = require('events').EventEmitter;
var Config  = require('./../config');

Model = function(namespace){
    var _this = this;
    var configuration = null;

    /**
     * Init
     *
     * @param {string} namesapce
     *
     * @private
     * */
    var init = function(namespace){
        //TODO - if intance...


        if ( typeof(namespace) == "undefined" || namespace == "") {
            //logger.error('gina', 'MODEL:ERR:1', 'EEMPTY: Model namespace', __stack);
            console.error(new Error('EEMPTY: Model namespace'));
        }
        var suffix = 'Entity';
        namespace = namespace.split(/\//g);
        var bundle = namespace[0];
        namespace.shift();

        var model = null;
        //Capitalize - Normalize
        if (namespace.length > 1) {
            for (var i; i<namespace.length; ++i)
                namespace[i] = namespace[i].substring(0, 1).toUpperCase() + namespace[i].substring(1);

            model = namespace.join(".");
        } else {
            //Dir name.
            var modelDirName = namespace[0];
            namespace[0] = namespace[0].substring(0, 1).toUpperCase() + namespace[0].substring(1);
            model = namespace[0];
        }

        //console.log("\nBundle", bundle);
        //console.log("Model", model);


        getContext(bundle, function(err, conf){

            if (!err) {
                configuration = conf.model;
                //console.log("CONF READY ", model, conf.path/** conf*/);
                //TODO - More tries & catches...
                //Getting Entities Manager.
                var entitiesManager = new require(conf.path)();
                //var Entities = entitiesManager[model];

                //For now, I just need the F..ing entity name.
                var modelPath = conf.path + '/' + modelDirName
                //console.log('modelPath: ', modelPath);
                fs.readdir(modelPath, function(err, files){

                    var entityName, exluded = ['index.js'];

                    //Will be in Dev.Lib.Factory soon.
                    var produce = function(entityName, i){
                        console.debug("producing ", files[i]);

                        lib.config.get('gina', 'project.json', function(err, config){
                            //if (err) logger.error('gina', 'MODEL:ERR:2', 'EEMPTY: EntitySuper' + err, __stack);
                            if (err) console.error(err.stack||err.message);

                            var filename = config.paths.gina + '/model/entityFactory.js';

                            //TODO - Factory class
                            //var Factory = new Factory({source: , target: ).onComplete();
                            console.debug("LOADING ", filename);
                            //Getting source.
                            loadFile(filename, entityName, function(err, source){
                                console.log("got source ", err, source);

                                try {
                                    if (entityName != "undefiend") {
                                        console.log("preparing entity ", entityName);
                                        //TODO - Would be great to implement in Dev.Lib
                                        var EntityFactorySource = source
                                            .replace(/\{Entity\}/g, entityName)
                                            .replace(/\{Model\}/g, model);

                                        var EntityFactoryClass = requireFromString(EntityFactorySource);
                                        var EntityFactory = new EntityFactoryClass( _this.getConfig() );
                                        console.log("Factory is ",  EntityFactory);

                                        // merge(Entity, EntityFactory, true);
                                        Entity = merge(Entity, EntityFactory, true);
                                        //console.debug("\nEntity CONTENT ", Entity, " \nVS\n", EntityFactory);

                                    } else {
                                        throw new Error('Gina.Model.getContext(...): [entityName] is undefined.');
                                    }
                                } catch (err) {
                                    //logger.error('gina', 'MODEL:ERR:4', 'EEMPTY: EntitySuper\n' + err, __stack);
                                    console.error( 'EEMPTY: EntitySuper\n' + (err.stack||err.message))
                                }

                                //Entity = new entitiesManager[model]();
                                //lib.merge(_this, Entity, true);
                                //console.debug("EntityManager  \n",  entitiesManager,"\n VS \n",  EntityFactory);
                                if (i == files.length-1) {
                                    //console.debug("All done !");
                                    _this.emit('ready', false, entitiesManager);
                                    ++i;
                                }

                            })//EO loadFile

                        })//EO lib.config.get()

                    };//EO produce

                    var i = 0;
                    while (i < files.length) {
                        //console.log("TEsting entity exclusion ",  i + ": ", exluded.indexOf(files[i]) != -1 && files[i].match(/.js/), files[i]);
                        if ( files[i].match(/.js/) && exluded.indexOf(files[i]) == -1 && !files[i].match(/.json/)) {
                            entityName = files[i].replace(/.js/, "") + suffix;
                            console.log("entityName  : ", entityName );
                            produce(entityName, i++);
                        } else if (i == files.length-1) {
                            console.log("All done !");
                            _this.emit('ready', false, entitiesManager);
                            ++i;
                        } else {
                            console.log("missed ", i, files[i]);
                            ++i;
                        }
                    }//EO while.

                });//EO fs.readdir.

            } else {
                _this.emit('ready', 'no configuration found for your model: ' + model);
                console.log("no configuration found...");
            }
        });


    };
    /**
     * Get Model Configuration
     *
     * @returns {object|undefined} configuration
     * */
    this.getConfig = function(){
        if (configuration) {
            return configuration
        } else {
            return undefined
        }
    };

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
    var getContext = function(bundle, callback){
        var configuration = Config.getInstance(bundle);

        console.log("getting for bundle ", bundle, configuration);
        if ( typeof(configuration) != 'undefined' ) {
            //Response.
            var confObj = {
                model : configuration.content.model,
                path : configuration.modelsPath
            };
            callback(false, confObj);
        } else {
            callback('Config not instantiated')
        }
    };

    var loadFile = function(filename, entityName, callback){


        fs.readFile(filename, function (err, data){

            if (err) {
                //logger.error('gina', 'MODEL:ERR:3', err, __stack);
                console.error(err.stack||err.message);
                callback(err);
            }

            console.log("Evaluating...", data.toString() );
            var entityFactory = data.toString().replace(/\{Entity\}/g, entityName);
            console.log("SHIT ");
            //process.exit(42);
            callback(false, entityFactory);
        });

    };

    var requireFromString = function(src, filename) {
        var Module = module.constructor;
        var m = new Module();
        m._compile(src, filename);
        return m.exports;
    }

//    this.getEntitiesManager = function(){
//
//    };

    init(namespace);

    return {
        onReady : function(callback){
            _this.on('ready', function(err, entities){
                //console.log("foudn entities ", entities);
                callback(err, new entities() );
            });
        },
        getInstance : function(){
            return
        }
    }
};

Model = inherits(Model, EventEmitter);
module.exports = Model;
