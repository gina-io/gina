/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var fs              = require('fs');
var EventEmitter    = require('events').EventEmitter;
var lib             = require('gina').lib;
var console         = lib.logger;
var helpers         = lib.helpers;
var inherits        = lib.inherits;
var merge           = lib.merge;
var modelUtil       = new lib.Model();

/**
 * @class Model.EntitySuper class
 *
 *
 * @package     Gina
 * @namespace   Gina.Model
 * @author      Rhinostone <contact@gina.io>
 * @api         Public
 */
function EntitySuper(conn, caller) {

    this.initialized    = false;
    this._maxListeners  = 50;
    this._methods       = [];
    this._relations     = {};

    var local           = {}
    var self            = this;
    var caller          = caller || undefined;
    var cacheless       = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;

    var init = function(conn, caller) {

        local.conn = conn;

        if (!EntitySuper[self.name]) {
            EntitySuper[self.name] = {}
        }

        if ( !EntitySuper[self.name]._conn ) {
            EntitySuper[self.name]._conn = conn;
        }

        if ( !EntitySuper[self.name].instance ) {
            return setListeners(caller)
        } else {
            return EntitySuper[self.name].instance
        }
    }


    /**
     * Set all main listenners at once
     *
     * */
    var setListeners = function(caller) {

        var entityName  = self.name.substr(0, 1).toLowerCase() + self.name.substr(1);
        var shortName   = self.name.replace(/Entity/, '');
        shortName       = shortName.substr(0, 1).toLowerCase() + shortName.substr(1);

        var entity      = null;

        if ( EntitySuper[self.name].initialized ) {

            self.initialized = EntitySuper[self.name].initialized;
            entity = self

        } else {
            EntitySuper[self.name].initialized = true;
            entity = self.getEntity(self.name)
        }



        var eventName = '';
        for (var prop in entity) {
            eventName = shortName +'#'+ prop;
            if (self._methods.indexOf(prop) < 0 && typeof(entity[prop]) == 'function' && new RegExp('(' + eventName + '\'|' + eventName + '\"|' + eventName + '$)').test(entity[prop].toString()) ) {
                self._methods.push(prop)
            }
        }

        // use this property inside your entity to disable listeners
        if ( typeof(entity.hasOwnEvents) != 'undefined' && entity.hasOwnEvents ) return false;

        var events = []
            , triggers = []
            , i = 0
            , cb = {}
            , methods = self._methods;


        for (var m = 0, mLen = methods.length; m < mLen; ++m) {
            if (
                typeof(entity[methods[m]]) == 'function'
                && m != 'onComplete'
            ) {

                if ( triggers.indexOf(shortName + '#' + methods[m]) < 0 ) {
                    events[i] = {
                        index: i,
                        shortName: shortName + '#' + methods[m],
                        method: methods[m],
                        entityName: entityName
                    };


                    triggers.push(shortName + '#' + methods[m]);

                    ++i;
                }
            }
        }

        entity._listeners = events;
        entity._triggers = triggers;
        entity._callbacks = {};
        entity._maxListeners += i; // default max listeners is 10
        entity.setMaxListeners(entity._maxListeners || 50);
        //console.debug('['+self.name+'] setting max listeners to: ' + (entity.maxListeners || eCount) );

        var f           = null
            , fSource   = '';

        for (var i = 0; i < events.length; ++i) {

            entity.removeAllListeners(events[i].shortName); // added to prevent adding new listners on each new querie
            //console.debug('placing event: '+ events[i].shortName +'\n');
            f       = events[i].method;
            fSource = entity[f].toString();

            // only if method content is about the event
            if (methods.indexOf(f) > -1 && new RegExp('(' + events[i].shortName + '\'|' + events[i].shortName + '\"|' + events[i].shortName + '$)').test(fSource)) {

                // CRUD | model's methods, for the n1ql, look into connector/<connectorName>/index.js
                entity[f] = (function onEntityEvent(e, m, i, source) {

                    var cached      = entity[m];

                    var variables   = source.match(/\((.*)\)/g)[0];
                    var args        = [];

                    if (variables.length) {
                        variables = variables.replace(/\(|\)/g, '').replace(/\s*/g, '');
                        if (variables) args = variables.split(/\,/g);
                    }
                    // TODO - retrieve argument while the method is being rewritten
                    return function () {

                        // retrieving local arguments, & binding it to the event callback

                        /**
                         * handle promises with async/await
                         *
                         * NB.: Always use the prefix `db` inside an entity file
                         *      instead of using `this.getRelation(entityName)`
                         *
                         * e.g.:
                         *  var recordJob   = promisify(db.jobEntity.insert);
                         *  await recordJob(jobObj)
                         *      .then( function onJob(_jobObj) {
                         *          jobObj = _jobObj;
                         *      })
                         *      .catch( function onJobErr(_err) {
                         *          jobErr = _err;
                         *      });
                         *
                         */
                        if ( typeof(this[m]) == 'undefined' && typeof(arguments[arguments.length-1]) == 'function' ) {

                            var promise = function() {
                                var cb = arguments[arguments.length-1];

                                if (entity._triggers.indexOf(events[i].shortName) > -1) {
                                    console.debug('[ MODEL ][ ENTITY ] Setting promise listener for: [ ' + self.model + '/' + events[i].entityName + '::' + events[i].shortName + ' ]');

                                    if (typeof(entity._arguments) == 'undefined' || typeof(entity._arguments) != 'undefined' && typeof(entity._arguments[events[i].shortName]) == 'undefined') {

                                        if (entity.listenerCount(events[i].shortName) > 0) {
                                            entity.removeAllListeners([events[i].shortName])
                                        }

                                        entity.once(events[i].shortName, function () { // cannot be `entity.on` for prod/stage
                                            // check if not already fired
                                            if (entity._callbacks[events[i].shortName]) {

                                                entity.removeAllListeners([events[i].shortName]);
                                                console.log('\nFIRING #1 - promise ' + events[i].shortName +'('+ events[i].index  +')');
                                                cb.apply(this, arguments);
                                            }
                                        });


                                        // backing up callback
                                        entity._callbacks[events[i].shortName] = cb;
                                    } else { // in case the event is not ready yet
                                        console.log('\nFIRING #2 - promise' + events[i].shortName);
                                        cb.apply(entity[m], entity._arguments[events[i].shortName])
                                    }
                                }
                            }

                            promise.apply(null, arguments);
                            cached.apply(promise, arguments);
                            return promise;
                        } //else is normal case

                        cached.apply(this[m], arguments);

                        this[m].onComplete = function (cb) {

                            //Setting local listener : normal case
                            if (entity._triggers.indexOf(events[i].shortName) > -1) {
                                console.debug('[ MODEL ][ ENTITY ] Setting listener for: [ ' + self.model + '/' + events[i].entityName + '::' + events[i].shortName + ' ]');

                                if (typeof(entity._arguments) == 'undefined' || typeof(entity._arguments) != 'undefined' && typeof(entity._arguments[events[i].shortName]) == 'undefined') {

                                    if (entity.listenerCount(events[i].shortName) > 0) {
                                        entity.removeAllListeners([events[i].shortName])
                                    }

                                    entity.once(events[i].shortName, function () { // cannot be `entity.on` for prod/stage
                                        // check if not already fired
                                        if (entity._callbacks[events[i].shortName]) {

                                            entity.removeAllListeners([events[i].shortName]);
                                            console.log('\nFIRING #1 ' + events[i].shortName +'('+ events[i].index  +')');
                                            cb.apply(this[m], arguments);
                                            //cb.apply(this, arguments);
                                        }

                                    });


                                    // backing up callback
                                    entity._callbacks[events[i].shortName] = cb;
                                } else { // in case the event is not ready yet
                                    console.log('\nFIRING #2 ' + events[i].shortName);
                                    cb.apply(entity[m], entity._arguments[events[i].shortName])
                                }
                            }
                        }



                        return this[m] // chaining event & method
                    };

                }(events[i].shortName, f, i, fSource));

                // just for display purpose: will be overriden by the previous code
                entity[f].onComplete = function (cb) {}

            }
        }


        if (!/Entity$/.test(entityName)) {
            entityName = entityName + 'Entity'
        }

        if (caller) {
            if ( !EntitySuper[caller].instance ) {
                EntitySuper[caller].instance = {
                    _relations: {}
                }
            }

        } else {
            if ( !EntitySuper[self.name].instance ) {
                EntitySuper[self.name].instance = {
                    _relations: {}
                }
            }
        }

        if (caller) {
            EntitySuper[caller].instance._relations[entity.name] = merge(EntitySuper[caller].instance._relations[entity.name], entity);
            modelUtil.updateModel(self.bundle, self.model, entityName, EntitySuper[caller].instance._relations[entity.name] );

            self._relations[entity.name] = EntitySuper[caller].instance._relations[entity.name];

            return EntitySuper[caller].instance._relations[entity.name]
        } else {
            modelUtil.updateModel(self.bundle, self.model, entityName, entity);
            EntitySuper[self.name].instance = entity;

            return EntitySuper[self.name].instance
        }
    }

    var setListener = function() {
        arguments = arguments[0];

        var args = Array.prototype.slice.call(arguments);
        var trigger = args.splice(0, 1)[0];

        if ( !/\#/.test(trigger) ) {
            throw new Error('trigger name not properly set: use `#` between the entity name and the method reference');
            process.exit(1)
        } else {
            if ( self._triggers.indexOf(trigger) < 0 ) {
                self._triggers.push(trigger);

                ++self._maxListeners;
                self.setMaxListeners(self._maxListeners);

                var alias       = trigger.split(/\#/)[1]
                    , method    = alias.replace(/[0-9]/g, '')
                    , events    = null
                    , i         = 0
                    ;

                self._listeners.push({
                    shortName   : trigger,
                    method      : method,
                    entityName  : self.name
                });

                events  = self._listeners;
                i       = events.length-1;

                if ( self._triggers.indexOf(events[i].shortName) > -1 ) {
                    // reusable event
                    self
                        //.off(events[i].shortName, function(){ delete self._callbacks[trigger]; })
                        .on(events[i].shortName, function () {
                            console.log('\nFIRING #3 ' + trigger);
                            this._callbacks[trigger.replace(/[0-9]/g, '')].apply(this[method], arguments);
                            delete self._callbacks[trigger];
                        })
                }

            } else {
                if ( typeof(self._callbacks[trigger]) != 'undefined' ) {
                    console.log('\nFIRING #4 ' + trigger);
                    self._callbacks[trigger].apply(this, args);
                    delete self._callbacks[trigger];
                } else {
                    self
                        // .off(trigger, function(){
                        //     if (!this._arguments) {
                        //         this._arguments = {}
                        //     }

                        //     if ( typeof(this._arguments[trigger]) != 'undefined' ) {
                        //         delete this._arguments[trigger];
                        //     }
                        // })
                        .once(trigger, function () {// patched for Air Liquide: case when emit occurs before listener is ready
                            if (!this._arguments) {
                                this._arguments = {}
                            }

                            // retrieving local arguments, & binding it to the event callback
                            if ( typeof(this._arguments[trigger]) == 'undefined' ) {
                                console.log('\nFIRING #5 ' + trigger);

                                this._arguments[trigger] = arguments;
                            }

                        })
                }
            }
        }
    }


    var arrayClone = function(arr, i) {
        var copy = new Array(i);
        while (i--)
            copy[i] = arr[i];
        return copy;
    }

    var emitOne = function(handler, isFn, self, arg1) {
        if (isFn)
            handler.call(self, arg1);
        else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i)
                listeners[i].call(self, arg1);
        }
    }
    var emitTwo = function(handler, isFn, self, arg1, arg2) {
        if (isFn)
            handler.call(self, arg1, arg2);
        else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i)
                listeners[i].call(self, arg1, arg2);
        }
    }
    var emitThree = function(handler, isFn, self, arg1, arg2, arg3) {
        if (isFn)
            handler.call(self, arg1, arg2, arg3);
        else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i)
                listeners[i].call(self, arg1, arg2, arg3);
        }
    }

    var emitMany = function(handler, isFn, self, args) {
        if (isFn)
            handler.apply(self, args);
        else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i)
                listeners[i].apply(self, args);
        }
    }

    /**
     * custom emit based on node.js emit source
     * Added on 2016-02-09
     * */
    this.emit = function emit(type) {
        // BO Added to handle trigger with increment when `emit occurs whithin a loop or recursive function
        if (
            self._triggers && self._triggers.indexOf(type) == -1 && self._triggers.indexOf(type.replace(/[0-9]/g, '')) > -1
            || self._triggers && self._triggers.indexOf(type) > -1 && typeof(self._callbacks[type]) == 'undefined' && typeof(self._events[type]) == 'undefined'
            || self._triggers && self._triggers.indexOf(type) > -1 && typeof(self._callbacks[type]) != 'undefined'
        ) {
            setListener(arguments)
        }
        // EO Added to handle trigger with increment

        var er, handler, len, args, i, events, domain;
        var needDomainExit = false;
        var doError = (type === 'error');

        events = this._events;
        if (events)
            doError = (doError && events.error == null);
        else if (!doError)
            return false;

        domain = this.domain;

        // If there is no 'error' event listener then throw.
        if (doError) {
            er = arguments[1];
            if (domain) {
                if (!er)
                    er = new Error('Uncaught, unspecified "error" event');
                er.domainEmitter = this;
                er.domain = domain;
                er.domainThrown = false;
                domain.emit('error', er);
            } else if (er instanceof Error) {
                throw er; // Unhandled 'error' event
            } else {
                // At least give some kind of context to the user
                var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
                err.context = er;
                throw err;
            }
            return false;
        }

        handler = events[type];

        if (!handler)
            return false;

        if (domain && this !== process) {
            domain.enter();
            needDomainExit = true;
        }

        var isFn = typeof handler === 'function';
        len = arguments.length;
        switch (len) {
            // fast cases
            case 1:
                emitNone(handler, isFn, this);
                break;
            case 2:
                emitOne(handler, isFn, this, arguments[1]);
                break;
            case 3:
                emitTwo(handler, isFn, this, arguments[1], arguments[2]);
                break;
            case 4:
                emitThree(handler, isFn, this, arguments[1], arguments[2], arguments[3]);
                break;
            // slower
            default:
                args = new Array(len - 1);
                for (i = 1; i < len; i++)
                    args[i - 1] = arguments[i];
                emitMany(handler, isFn, this, args);
        }

        if (needDomainExit)
            domain.exit();

        return true;
    }


    /**
     * Get connection from entity
     * */
    this.getConnection = function(scope, collection) {
        var conn =  local.conn || self._conn || null;

        if ( typeof(conn) == 'undefined' || !conn) {
            return null;
        }

        if ( typeof(scope) == 'undefined' ) {
            scope = '_default';
        }
        var currentCollection = '_default';
        if ( typeof(collection) != 'undefined' ) {
            currentCollection = collection;
        }


        // retrieve & return the collection
        if ( typeof(conn.scope) != 'undefined' && typeof(conn._scope) == 'undefined' && typeof(conn.scope) != 'undefined' ) {
            var newConn = conn.scope(scope).collection(currentCollection);
            newConn.sdk = conn.sdk;
            return newConn;
        }

        // return the cached collection
        return conn;
    }

    this.getEntity = function(entity) {

        var ntt = entity;
        entity = entity.substr(0,1).toUpperCase() + entity.substr(1);
        var nttName = entity;

        if ( !/Entity$/.test(entity) ) {
            entity = entity + 'Entity'
        }

        try {
            var callerName = self.name;
            var entityName = entity.replace('Entity', '');

            if (!callerName) {
                throw new Error('no name defined for this Entity !!');
            } else { // imported
                if ( callerName == entity.replace('Entity', '')) {
                    if ( !EntitySuper[self.name].instance ) {
                        return getModelEntity(self.bundle, self.model, entity, self.getConnection())
                    } else {
                        return EntitySuper[self.name].instance
                    }

                } else if ( typeof(EntitySuper[callerName].instance) != 'undefined' && EntitySuper[callerName].instance._relations[entityName] ) {
                    return EntitySuper[callerName].instance._relations[entityName]
                } else {
                    if ( typeof(modelUtil.entities[self.bundle][self.model][entity]) != 'function' ) {
                        throw new Error('Model entity not found: `'+ entity + '` while trying to call '+ callerName +'Entity.getEntity('+ entity +')');
                    }

                    // fixed on May 2019, 21st : need for `this.getEntity(...)` inside the model
                    if (  typeof(EntitySuper[callerName].instance._relations[entityName]) == 'undefined' ) {

                        if ( typeof(EntitySuper[entityName]) != 'undefined' && typeof(EntitySuper[entityName].instance) != 'undefined' ) {

                            EntitySuper[callerName].instance._relations[entityName] = new modelUtil.entities[self.bundle][self.model][entity](self.getConnection(), callerName)
                        } else { // regular case
                            new modelUtil.entities[self.bundle][self.model][entity](self.getConnection(), callerName);
                        }
                    }


                    return EntitySuper[callerName].instance._relations[entityName]
                }
            }

        } catch (err) {
            throw err;
        }
    }

    this.setInstance = function(instance) {
        EntitySuper[self.name].instance = instance
    }


    return init(conn, caller)
};

EntitySuper = inherits(EntitySuper, EventEmitter);
module.exports = EntitySuper