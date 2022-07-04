/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var fs          = require('fs');
var merge       = require('./merge');
var console     = require('./logger');
var inherits    = require('./inherits');
var math        = require('./math');
//var checkSum    = math.checkSum;

/**
 * Model uitl
 *
 * @package     Gina.Utils
 * @author      Rhinostone <gina@rhinostone.com>
 * @api public
 * */
function ModelUtil() {
    var self        = this;
    var cacheless   = (process.env.IS_CACHELESS == 'false') ? false : true;

    /**
     * Init
     * @contructor
     * */
    var init = function() {

        if ( !ModelUtil.instance && !getContext('modelUtil') ) {
            self.models             = self.models || {}; // used when getModel(modelName) is called
            self.entities           = {};
            self.entitiesCollection = {}; // used when getEntity(entityName) is called - handles entity relations
            self.files              = {};
            ModelUtil.instance      = self;

            setContext('modelUtil', ModelUtil.instance);

            return self
        } else {
            //if (!ModelUtil.instance) {
            //    ModelUtil.instance = getContext('modelUtil')
            //}
            //self = ModelUtil.instance;
            //ModelUtil.instance = getContext('modelUtil');
            //ModelUtil.instance = ModelUtil.instance || getContext('modelUtil');
            //self = merge(self, ModelUtil.instance, true);
            // return self
            return ModelUtil.instance || getContext('modelUtil')
        }
    }

    this.setConnection = function(bundle, name, conn) {
        if (arguments.length > 1) {
            if (!self.models) {
                self.models = {}
            }
            if (!self.entitiesCollection) {
                self.entitiesCollection = {}
            }
            if (!self.models[bundle]) {
                self.models[bundle] = {}
            }
            if (!self.entitiesCollection[bundle]) {
                self.entitiesCollection[bundle] = {}
            }
            if ( typeof(name) == 'undefined' || name == '' ) {
                throw new Error('Connection must have a name !')
            }

            if (typeof(self.models[bundle][name]) == 'undefined') {
                self.models[bundle][name] = {};
                if (!self.files[bundle]) {
                    self.files[bundle] = {}
                }
                self.files[bundle][name] = {}
            }

            if (typeof(self.entitiesCollection[bundle][name]) == 'undefined') {
                self.entitiesCollection[bundle][name] = {};
            }


            self.models[bundle][name]['_connection'] = conn;
            self.entitiesCollection[bundle][name]['_connection'] = conn;
        } else {
            self.models[bundle] = {};
            self.entitiesCollection[bundle] = {}
        }

        //setContext('modelUtil.entitiesCollection', self.entitiesCollection, true)
        ModelUtil.instance.entitiesCollection = self.entitiesCollection;
    }

    /**
    *
    * @param {string} name - Entity name
    * @param {object} module
    *
    * */
    this.setModelEntity = function(bundle, model, name, module) {
        var cacheless   = (process.env.IS_CACHELESS == 'false') ? false : true;
        
        if (arguments.length > 1) {
            if (!self.entities) {
                self.entities = {}
            }

            if (!self.entities[bundle]) {
                self.entities[bundle] = {}
            }

            if ( typeof(name) == 'undefined' || name == '' ) {
                throw new Error('`modelUtil cannot set `modelEntity whitout a name !')
            }

            if( !self.entities[bundle][model] ) {
                self.entities[bundle][model] = {}
            }

            if ( !/Entity$/.test(name) ) {
                name = name + 'Entity'
            }
            self.entities[bundle][model][name] = module

        } else {
            self.entities[bundle][model] = arguments[0]
        }

        setContext('modelUtil.entities', self.entities, true);
        ModelUtil.instance.entities = self.entities;
    }

    this.updateModel = function(bundle, model, name, entityObject) {

        if ( typeof(model) == 'undefined' || model == '' ) {
            throw new Error('`modelUtil` cannot update `entityObject` whitout a connector !')
        }

        if ( typeof(name) == 'undefined' || name == '' ) {
            throw new Error('`modelUtil` cannot set `modelEntity` whitout a name !')
        }

        if (!self.models[bundle][model][name]) {
            self.models[bundle][model][name] = {}
        }

        self.models[bundle][model][name] =  entityObject;


        ModelUtil.instance.models = self.models;
        setContext('modelUtil.models', self.models, true);

        return self.models[bundle][model][name]
    }

    this.updateEntities = function(bundle, model, name, entityObject) {

        if ( typeof(model) == 'undefined' || model == '' ) {
            throw new Error('`modelUtil` cannot update `entityObject` whitout a connector !')
        }

        if ( typeof(name) == 'undefined' || name == '' ) {
            throw new Error('`modelUtil` cannot set `modelEntity` whitout a name !')
        }

        if (!self.entitiesCollection[bundle][model][name]) {
            self.entitiesCollection[bundle][model][name] = {}
        }

        self.entitiesCollection[bundle][model][name] =  entityObject;

        return self.entitiesCollection[bundle][model][name]
    }

    this.setModel = function(bundle, name, obj) {
        if (arguments.length > 2) {
            if ( typeof(name) == 'undefined' || name == '' ) {
                var name = 'global'
            }

            if (!self.models[bundle]) {
                self.models[bundle] = {}
            }
            if (!self.entitiesCollection[bundle]) {
                self.entitiesCollection[bundle] = {}
            }
            //entitiesCollection

            if (!self.models[bundle][name]) {
                self.models[bundle][name] = {}
            }
            if (!self.entitiesCollection[bundle][name]) {
                self.entitiesCollection[bundle][name] = {}
            }

            self.models[bundle][name] = merge(self.models[bundle][name], obj);
            self.entitiesCollection[bundle][name] = merge(self.entitiesCollection[bundle][name], obj)

        } else {
            self.models[bundle][name] = {};
            self.entitiesCollection[bundle][name] = {}
        }
    }


    this.loadAllModels = function(bundles, configuration, env, cb) {

        var loadModel = function(b, bundles, configuration, env, cb) {
            var modelObject     = getContext('modelUtil').entities[bundles[b]] // to check if already laoded
                , bundle        = bundles[b]
                , len           = bundles.length
                , conf          = configuration[bundle][env]
                , connectors    = conf.content['connectors'] || undefined
                , modelConnectors  = {};


            if ( typeof(connectors) != 'undefined' && connectors != null) {
                var Model = require( _( getPath('gina').core + '/model') );
                var mObj = {};

                var models = connectors;

                var t = 0;

                var done = function(connector, modelConnectors) {
                    if ( typeof(models[connector]) != 'undefined' ) {
                        ++t
                    } else {
                        console.error('connector '+ connector +' not found in configuration')
                    }

                    if ( t == models.count() ) {
                        setContext('modelConnectors', modelConnectors);

                        var conn                = null
                            , entitiesManager   = null
                            , modelPath         = null
                            , entitiesPath      = null
                            , entitiesObject    = null
                            , foundInitError    = false;

                        // end - now, loading entities for each `loaded` model
                        for (var bundle in self.models) {

                            for (var name in self.models[bundle]) {//name as connector name
                                conn            = self.models[bundle][name]['_connection'];
                                modelPath       = _(conf.modelsPath + '/' + name);
                                entitiesPath    = _(modelPath + '/entities');
                                //Getting Entities Manager thru connector.
                                entitiesManager = new require( _(conf.modelsPath + '/index.js', true) )(conn)[name](conn, { model: name, bundle: bundle, database: conf.content['connectors'][name].database });

                                self.setConnection(bundle, name, conn);

                                // step 1: creating entities classes in the context
                                // must be done only when all models conn are alive because of `cross models/database use cases`
                                for (var nttClass in entitiesManager) {
                                    if ( !/^[A-Z]/.test( nttClass ) ) {
                                        throw new Error('Entity Class `'+ nttClass +'` should start with an uppercase !');
                                        foundInitError = true
                                    }
                                    self.setModelEntity(bundle, name, nttClass, entitiesManager[nttClass])
                                }

                                // step 2: creating entities instances
                                for (var nttClass in entitiesManager) {
                                    new entitiesManager[nttClass](conn);
                                }

                            }
                        }

                        setContext('modelUtil', ModelUtil.instance, true);
                        if (foundInitError) process.exit(1);


                        cb()
                    }
                }

                for (var c in models) {//c as connector name
                    if ( modelObject && typeof(modelObject[c]) != 'undefined' ) {
                        done(connector, modelConnectors)
                    } else {
                        //e.g. var apiModel    = new Model(config.bundle + "/api");
                        // => var apiModel = getContext('apiModel')
                        console.debug('....model ', conf.bundle + "/"+c + 'Model');
                        mObj[c+'Model'] = new Model(conf.bundle + "/" + c);
                        mObj[c+'Model']
                            .onReady(
                            function onModelReady( err, bundle, connector, conn) {
                                if (err) {
                                    console.error('found error ...');
                                    console.error(err.stack||err.message||err);
                                } else {

                                    if (!modelConnectors[bundle]) {
                                        modelConnectors[bundle] = {}
                                    }
                                    if (!modelConnectors[bundle][connector]) {
                                        modelConnectors[bundle][connector] = {
                                            conn: conn
                                        }
                                    }

                                    if ( typeof(self.models[bundle]) == 'undefined') {
                                        self.models[bundle] = {}
                                    }

                                    if ( typeof(self.models[bundle][connector]) == 'undefined') {
                                        self.models[bundle][connector] = {}
                                    }

                                    if ( typeof(self.models[bundle][connector]['_connection']) == 'undefined' ) {
                                        self.models[bundle][connector]['_connection'] = conn
                                    }

                                    if ( typeof(self.models[bundle][connector]['getConnection']) == 'undefined' ) {// only used when tryin to import multiple models into the same entity
                                        self.models[bundle][connector]['getConnection'] = function() {
                                            return self.models[bundle][connector]['_connection']
                                        }
                                    }
                                }

                                done(connector, modelConnectors)
                            })
                   }

                }


            } else {
                //throw new Error('no connector found for bundle [ '+ bundle +' ]');
                // this is normal if there is no connector.json found in the source
                if (b < bundles.length-1) {
                    loadModel(b+1, bundles, configuration, env, cb)
                } else {
                    cb()
                }

            }
        };

        loadModel(0, bundles, configuration, env, cb)
    }


    /**
     * Reload modes
     * cacheless mode only
     *
     * @param {obj} conf
     * @callback cb
     * */
    this.reloadModels = function(conf, cb) {

        if ( typeof(conf.content['connectors']) != 'undefined' && conf.content['connectors'] != null ) {

            var models              = conf.content.connectors
                , conn              = null
                , foundInitError    = false
                , entitiesManager   = null
                , modelPath         = null
                , entitiesPath      = null
                , modelConnectors   = null;


            // end - now, loading entities for each `loaded` model
            for (var bundle in self.models) {

                for (var name in self.models[bundle]) { //name as connector name
                    
                    self.models[bundle][name] = {};

                    if ( typeof(self.models[bundle][name]['_connection']) == 'undefined' ) {
                        self.models[bundle][name]['_connection'] = getContext('modelConnectors')[bundle][name].conn
                    }

                    if ( typeof(self.models[bundle][name]['getConnection']) == 'undefined' ) {// only used when tryin to import multiple models into the same entity
                        self.models[bundle][name]['getConnection'] = function() {
                            return self.models[bundle][name]['_connection']
                        }
                    }

                    conn            = getContext('modelConnectors')[bundle][name].conn;

                    modelPath       = _(conf.modelsPath + '/' + name);
                    entitiesPath    = _(modelPath + '/entities');

                    //Getting Entities Manager thru connector.
                    delete require.cache[_(conf.modelsPath + '/index.js', true)];//child
                    try {
                        entitiesManager = new require( _(conf.modelsPath + '/index.js', true) )(conn)[name](conn, { model: name, bundle: bundle, database: conf.content['connectors'][name].database });
                    } catch (err) {
                        cb(err)
                    }

                    self.setConnection(bundle, name, conn);
                    // creating entities instances
                    // must be done only when all models conn are alive because of `cross models/database use cases`
                    for (var nttClass in entitiesManager) {
                        if ( !/^[A-Z]/.test( nttClass ) ) {
                            throw new Error('Entity Class `'+ nttClass +'` should start with an uppercase ?');
                            foundInitError = true
                        }
                        self.setModelEntity(bundle, name, nttClass, entitiesManager[nttClass])
                    }

                    for (var nttClass in entitiesManager) {
                        // will force updates on self.models
                        new entitiesManager[nttClass](conn);
                    }

                    console.log('loaded model ', bundle+'/'+name);
                }
            }


            setContext('modelUtil', self, true);
            ModelUtil.instance = self;

            cb(false)

        } else {
            cb(new Error('[ '+ conf.bundle+' ] no connector found !'))
        }
    }


    /**
     * Get Model by [ bundleName ] & modelName
     *
     * @param {string} [ bundle ] - Bundle name
     * @param {string} model - Model name
     *
     * @return {object} model - Model entities
     * */
    getModel = function(bundle, model) {

        var ctx       = getContext();

        if (arguments.length == 1 || !bundle) {
            //console.debug(
            //    '\n[ 0 ] = '+ __stack[0].getFileName(),
            //    '\n[ 1 ] = '+ __stack[1].getFileName(),
            //    '\n[ 2 ] = '+ __stack[2].getFileName(),
            //    '\n[ 3 ] = '+ __stack[3].getFileName(),
            //    '\n[ 4 ] = '+ __stack[4].getFileName(),
            //    '\n[ 5 ] = '+ __stack[5].getFileName(),
            //    '\n[ 6 ] = '+ __stack[6].getFileName()
            //);


            // var model       = (arguments.length == 1) ? bundle : model
            //     , file      = ( !/node_modules/.test(__stack[1].getFileName()) ) ?  __stack[1].getFileName() : __stack[2].getFileName()
            //     , a         = file.replace('.js', '').split('/')
            //     , i         = a.length-1
            //     , bundle    = null;
            //
            // var conf        = getContext('gina').config || null;
            // if (conf) {
            //     var bundles     = conf.bundles
            //         , index     = 0;
            //
            //     for (; i >= 0; --i) {
            //         index = bundles.indexOf(a[i]);
            //         if ( index > -1 ) {
            //             bundle = bundles[index];
            //             break
            //         }
            //     }
            // } else {
            //     conf    = getContext();
            //     bundle  = conf.bundle;
            // }




            var model         = (arguments.length == 1) ? bundle : model
                , bundle    = null
                , modelPath   = null
                , file      = null
                , stackFileName = null;
            //, file      = ( !/node_modules/.test(__stack[1].getFileName()) ) ?  __stack[1].getFileName() : __stack[2].getFileName()
            for (var i = 1, len = 10; i<len; ++i) {
                stackFileName = __stack[i].getFileName();
                if ( stackFileName && !/node_modules/.test(stackFileName) ) {
                    file = stackFileName;
                    break;
                }
            }
            var a           = file.replace('.js', '').split('/')
                , i         = a.length-1;

            if (bundle == model) {
                bundle = ctx.bundle
            } else {

                if (ctx.bundles) {
                    for (; i >= 0; --i) {
                        index = ctx.bundles.indexOf(a[i]);
                        if ( index > -1 ) {
                            ctx.bundle = bundle = ctx.bundles[index];

                            break
                        }
                    }
                } else if (ctx.bundle) {
                    bundle = ctx.bundle
                }

            }
        }

        //if (!self.models) {
            self.models = ModelUtil.instance.models
        //}

        if ( typeof(model) != 'undefined' && typeof(self.models[bundle]) != 'undefined' ) {

            try {

                if ( typeof(self.models[bundle][model]['getConnection']) == 'undefined' ) {
                    self.models[bundle][model]['getConnection'] = function() {
                        return self.models[bundle][model]['_connection']
                    }
                }

                return self.models[bundle][model]
            } catch (err) {
                return undefined
            }
        }
    }

    /**
     * Get Model Entity
     *
     * @param {string} model
     * @param {string} entityName
     * @param {object} conn
     *
     * @return {object} entity
     * */
    getModelEntity = function(bundle, model, entityClassName, conn) {
        if ( typeof(entityClassName) != 'undefined' ) {
            var cacheless   = (process.env.IS_CACHELESS == 'false') ? false : true;
            try {
                var shortName = entityClassName.substr(0, 1).toLowerCase() + entityClassName.substr(1);

                if (!self.entities) {
                    if (!ModelUtil.instance) {
                        ModelUtil.instance = getContext('modelUtil')
                    }
                    self.entities           = ModelUtil.instance.entities;
                    self.entitiesCollection = ModelUtil.instance.entitiesCollection;
                    self.models             = ModelUtil.instance.models;

                    if (typeof(self.models) == 'function' ) {
                        self.models                 = {};
                        self.models[bundle]         = {};
                        self.models[bundle][model]  = {}
                    }

                }

                //console.debug(parent+'->getEntity('+shortName+')');
                if ( self.models[bundle][model][shortName] /**&& !cacheless*/) { // cacheless is filtered thanks to self.reloadModels(...)
                    //return self.models[bundle][model][shortName]
                    return self.entitiesCollection[bundle][model][shortName]
                } else {
                    var entityObject = new self.entities[bundle][model][entityClassName](conn)
                    self.entitiesCollection[bundle][model][shortName] = entityObject;

                    //setContext('modelUtil.entitiesCollection', self.entitiesCollection, true);
                    ModelUtil.instance.entitiesCollection = self.entitiesCollection;

                    return entityObject;
                }

            } catch (err) {
                throw err;
                return undefined
            }
        } else {
            return self.entities[bundle][model]
        }
    }


    return init()
};

module.exports = ModelUtil;