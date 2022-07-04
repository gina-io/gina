/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var fs              = require('fs');
var EventEmitter    = require('events').EventEmitter;
var utils           = require('gina').utils;
var console         = utils.logger;
var helpers         = utils.helpers;
var inherits        = utils.inherits;
var merge           = utils.merge;
var modelUtil       = new utils.Model();

/**
 * @class Model.EntitySuper class
 *
 *
 * @package     Gina
 * @namespace   Gina.Model
 * @author      Rhinostone <gina@rhinostone.com>
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
    var cacheless       = (process.env.IS_CACHELESS == 'false') ? false : true;

    var init = function(conn, caller) {

        local.conn = conn;

        if (!EntitySuper[self.name]) {
            EntitySuper[self.name] = {}
        }

        if ( !EntitySuper[self.name].instance ) {
            return setListeners(caller)
        } else {
            return EntitySuper[self.name].instance
        }
    }

    // TODO - remove this ...
    // var loadMembers = function(caller) {
    //
    //     var filename    = self._filename
    //         , imports   = ''
    //         , str       = fs.readFileSync(filename).toString()
    //         , source    = str;
    //
    //     var first   = source.indexOf('{') + 1
    //     var last    = source.lastIndexOf('}') -1;
    //
    //     // extract imports
    //     imports = str.substring(0, first)
    //         .replace(/function(.*)/, '')
    //         .replace(/require\(/g, 'module.require(')
    //         .replace(/(\/\*([^*]|[\r\n]|(\*+([^*\/]|[\r\n])))*\*+\/)|(\/\/.*)/g, '');//remove comments
    //
    //     // extract function body
    //     source = source.substring(first, last);
    //
    //     source = 'var module = arguments[0];\n\r' + imports + source;
    //
    //
    //
    //     var EntityOrigin = new Function(source);
    //     for (var c in self) {
    //         if (!EntityOrigin[c])
    //             EntityOrigin.prototype[c] = self[c]
    //     }
    //
    //     var obj = new EntityOrigin(module);
    //
    //
    //
    //     var methodList      = {}
    //         , args          = []
    //         , variables     = ''
    //         , placeholder   = ''
    //         , functionBody  = '';
    //
    //     obj._methods = [];
    //     for (var prop in obj) {
    //         if (typeof(obj[prop]) != 'function') continue;
    //
    //         str         = obj[prop].toString();
    //         variables   = str.match(/\((.*)\)/g)[0];
    //         args        = [];
    //
    //         if (variables.length) {
    //             variables = variables.replace(/\(|\)/g, '').replace(/\s*/g, '');
    //             if (variables) args = variables.split(/\,/g);
    //         }
    //
    //         first   = str.indexOf('{') + 1
    //         last    = str.lastIndexOf('}') - 1;
    //         str     = str.substring(first, last);
    //
    //         if (!self[prop]) {
    //             if (typeof(obj[prop]) == 'function') {
    //                 self[prop] = obj[prop];
    //                 self._methods.push(prop);
    //             }
    //         }
    //     }
    //
    //
    //     if (caller) {
    //         if ( !EntitySuper[caller].instance ) {
    //             EntitySuper[caller].instance = {
    //                 _relations: {}
    //             }
    //         }
    //
    //     } else {
    //         if ( !EntitySuper[self.name].instance ) {
    //             EntitySuper[self.name].instance = {
    //                 _relations: {}
    //             }
    //         }
    //     }
    //
    //     return setListeners(caller)
    //
    // }

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
            if ( typeof(entity[prop]) == 'function' && new RegExp('(' + eventName + '\'|' + eventName + '\"|' + eventName + '$)').test(entity[prop].toString()) ) {
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


        for (var f = 0, fLen = methods.length; f < fLen; ++f) {
            if (
                typeof(entity[methods[f]]) == 'function'
                && f != 'onComplete'
            ) {

                events[i] = {
                    shortName: shortName + '#' + methods[f],
                    method: methods[f],
                    entityName: entityName
                };

                triggers.push(shortName + '#' + methods[f]);
                ++i;
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

            entity.removeAllListeners(events[i].shortName); // added on october 1st to prevent adding new listners on each new querie
            //console.debug('placing event: '+ events[i].shortName +'\n');
            f       = events[i].method;
            fSource = entity[f].toString();

            // only if method content is about the event
            if (methods.indexOf(f) > -1 && new RegExp('(' + events[i].shortName + '\'|' + events[i].shortName + '\"|' + events[i].shortName + '$)').test(fSource)) {


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

                        cached.apply(this[m], arguments);

                        this[m].onComplete = function (cb) {

                            console.debug('setting listener for: [ ' + self.model + '/' + events[i].entityName + '::' + events[i].shortName + ' ]');

                            //Setting local listener : normal case
                            if (entity._triggers.indexOf(events[i].shortName) > -1) {

                                if (typeof(entity._arguments) == 'undefined' || typeof(entity._arguments) != 'undefined' && typeof(entity._arguments[events[i].shortName]) == 'undefined') {
                                    entity.once(events[i].shortName, function () { // cannot be `entity.on` for prod/stage
                                        // check if not already fired
                                        if (entity._callbacks[events[i].shortName])
                                            cb.apply(this[m], arguments);
                                    });

                                    // backing up callback
                                    entity._callbacks[events[i].shortName] = cb;
                                } else { // in case the event is not ready yet
                                    cb.apply(entity[m], entity._arguments[events[i].shortName])
                                }
                            }
                        }

                        return this[m] // chaining event & method
                    };


                    // var func = function () {
                    //
                    //     // retrieving local arguments, & binding it to the event callback
                    //
                    //     cached.apply(this[m], arguments);
                    //
                    //     this[m].onComplete = function (cb) {
                    //
                    //         console.debug('setting listener for: [ ' + self.model + '/' + events[i].entityName + '::' + events[i].shortName + ' ]');
                    //
                    //         //Setting local listener : normal case
                    //         if (entity._triggers.indexOf(events[i].shortName) > -1) {
                    //
                    //             if (typeof(entity._arguments) == 'undefined' || typeof(entity._arguments) != 'undefined' && typeof(entity._arguments[events[i].shortName]) == 'undefined') {
                    //                 entity.once(events[i].shortName, function () { // cannot be `entity.on` for prod/stage
                    //                     // check if not already fired
                    //                     if (entity._callbacks[events[i].shortName])
                    //                         cb.apply(this[m], arguments);
                    //                 });
                    //
                    //                 // backing up callback
                    //                 entity._callbacks[events[i].shortName] = cb;
                    //             } else { // in case the event is not ready yet
                    //                 cb.apply(entity[m], entity._arguments[events[i].shortName])
                    //             }
                    //         }
                    //     }
                    //
                    //     return this[m] // chaining event & method
                    // };
                    //
                    // var funcStr = func.toString();
                    // var first   = funcStr.indexOf('{') + 1
                    // var last    = funcStr.lastIndexOf('}') -1;
                    //
                    // funcStr = funcStr.substring(first, last);
                    //
                    // return new Function(variables, funcStr)

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

        //self.removeAllListener(trigger);
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
                    self.on(events[i].shortName, function () {
                        //debugger;
                        this._callbacks[trigger.replace(/[0-9]/g, '')].apply(this[method], arguments);
                        delete self._callbacks[trigger];
                    })
                }

            } else {
                if ( typeof(self._callbacks[trigger]) != 'undefined' ) {
                    self._callbacks[trigger].apply(this, args);
                    delete self._callbacks[trigger];
                } else {
                    self.once(trigger, function () {// patched for Air Liquide: case when emit occurs before listener is ready
                        if (!this._arguments) {
                            this._arguments = {}
                        }
                        // retrieving local arguments, & binding it to the event callback
                        this._arguments[trigger] = arguments;
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
    this.getConnection = function() {
        var conn =  local.conn ;
        return ( typeof(conn) != 'undefined' ) ? conn : null;
    }

    this.getEntity = function(entity) {

        var ntt = entity;
        entity = entity.substr(0,1).toUpperCase() + entity.substr(1);

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
                    new modelUtil.entities[self.bundle][self.model][entity](self.getConnection(), callerName);
                    return EntitySuper[callerName].instance._relations[entityName]
                }
            }

        } catch (err) {
            throw err;
            return null
        }
    }

    this.setInstance = function(instance) {
        EntitySuper[self.name].instance = instance
    }



    ///**
    // * Get config
    // *
    // * @param {string} [name] - Conf name without extension.
    // * @return {object} result
    // *
    // * TODO - Protect result
    // * */
    //this.getConfig = function(name) {
    //    var tmp = null;
    //
    //    if ( typeof(name) != 'undefined' ) {
    //        try {
    //            // needs to be read only
    //            tmp = JSON.stringify(local.options.conf.content[name]);
    //            return JSON.parse(tmp)
    //        } catch (err) {
    //            return undefined
    //        }
    //    } else {
    //        tmp = JSON.stringify(local.options.conf);
    //        return JSON.parse(tmp)
    //    }
    //}

    return init(conn, caller)
};

EntitySuper = inherits(EntitySuper, EventEmitter);
module.exports = EntitySuper