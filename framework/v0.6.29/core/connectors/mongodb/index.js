/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var fs       = require('fs');
var loader   = require('./lib/pipeline-loader');
var lib      = require('./../../../lib') || require.cache[require.resolve('./../../../lib')];
var paramRedact = require('./../param-redact'); // #B350 — bound-value redaction for dev/Inspector sinks
var settleOnce  = require('./../settle-once');   // #B432 — per-call at-most-once settlement
var inherits = lib.inherits;
var console  = lib.logger;

/**
 * MongoDB ORM connector.
 *
 * Wires entity classes with Mongo operations described in pipeline files
 * under the bundle's `pipelines/` directory. Each pipeline file is a JSON
 * document describing one operation; an optional leading JSDoc block
 * carries `@param` / `@return` annotations that the connector uses for
 * argument coercion and result coercion.
 *
 * Bundle model layout:
 * ```
 * models/
 *   <database>/
 *     entities/
 *       user.js                  ← entity class
 *     pipelines/
 *       User/
 *         findById.json          ← {"op":"findOne","filter":{"_id":{"$arg":0}}}
 *         findAll.json
 *         insert.json
 * ```
 *
 * Pipeline file format:
 * ```json
 * /​*
 *  * @param  {objectid} arg0  user id
 *  * @return {object}
 *  *​/
 * { "op": "findOne", "filter": { "_id": {"$arg": 0}, "_scope": "$scope" } }
 * ```
 *
 * Supported `op` values map to the official mongodb driver:
 *   findOne | find | aggregate | countDocuments
 *   insertOne | insertMany
 *   updateOne | updateMany | replaceOne
 *   deleteOne | deleteMany
 *
 * `@return` annotation controls result shape:
 *   {object}  → first doc / single result, or null
 *   {array}   → array of docs
 *   {boolean} → for writes: acknowledged + something happened; for reads: rowLength > 0
 *   {number}  → numeric result (countDocuments, modifiedCount, etc.)
 *   (none)    → raw driver result
 *
 * Methods return a native Promise with `.onComplete(cb)` for backward
 * compatibility, OR accept a trailing callback in node-style.
 *
 * Argument placeholders inside the pipeline body use `{"$arg": N}`
 * (positional). ObjectId literals use `{"$oid": "<hex>"}`. The literal
 * string `"$scope"` is substituted at load time with the bundle's
 * data isolation scope.
 *
 * @class Mongodb
 * @constructor
 * @param {object} conn  - mongodb Db instance from MongodbConnector.onReady
 * @param {object} infos - { model, bundle, database, scope }
 * @returns {object}     - Entity class map: { UserEntity: Constructor, … }
 */
function Mongodb(conn, infos) {
    var envIsDev    = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) ) ? true : false;
    var isCacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;

    // ObjectId from the runtime-loaded mongodb package. require() is cached
    // since connector.js already loaded it during the connect cycle.
    var ObjectId;
    try {
        var driverPath = _(getPath('project') + '/node_modules/mongodb', true);
        ObjectId = require(driverPath).ObjectId;
    } catch (e) {
        // Not fatal here — only matters if a pipeline file uses {$oid}
        // or @param {objectid}. Methods that touch those will throw at
        // query time with a clearer error.
        ObjectId = null;
    }

    /**
     * Resolve the underlying MongoDB driver `MongoClient` from a connection
     * object. The entity layer is handed the `Db` instance (what
     * `getConnection()` returns); the connector decorates that Db with a
     * `_client` back-reference to the owning `MongoClient` one level up (see
     * `MongodbConnector.onReady`), because session and multi-document
     * transaction APIs live on the `MongoClient`, not the `Db`.
     *
     * Single source of truth for client resolution, so the lookup — and its
     * coded failure mode — live in exactly one place.
     *
     * @param {object} conn - A MongoDB connection object (the `Db` from getConnection()).
     * @returns {object} The MongoDB driver MongoClient (guaranteed to expose a `startSession()` method).
     * @throws {Error} `GINA_MONGODB_CLIENT_UNRESOLVED` when the client cannot be resolved.
     * @private
     */
    var resolveClient = function(conn) {
        var client = (conn && conn._client) ? conn._client : null;

        if (!client || typeof(client.startSession) !== 'function') {
            var _err = new Error('[ CONNECTOR ][ mongodb ] Unable to resolve the MongoClient from the connection — '
                + '`conn._client` does not expose a startSession() method. '
                + 'The connection shape may have changed across a driver or framework upgrade.');
            _err.code = 'GINA_MONGODB_CLIENT_UNRESOLVED';
            throw _err;
        }

        return client;
    };

    var init = function(conn, infos) {
        var EntitySuperClass = null;
        var entitiesPath     = getPath('bundle') + '/models/' + infos.database + '/entities';
        var files            = [];
        var entities         = {};
        var entityName       = '';
        var Entity           = null;
        var className        = null;
        var filename         = null;

        filename = getPath('gina').core + '/model/entity.js';
        if (isCacheless) {
            delete require.cache[require.resolve(_(filename, true))];
        }
        EntitySuperClass = require(_(filename, true));

        if (!fs.existsSync(entitiesPath)) {
            new _(entitiesPath).mkdirSync();
        }
        files = fs.readdirSync(entitiesPath);

        for (var f = 0, fLen = files.length; f < fLen; ++f) {
            if ( /^\./.test(files[f]) || !/\.js$/i.test(files[f]) ) continue;

            if (isCacheless) {
                delete require.cache[require.resolve(_(entitiesPath + '/' + files[f], true))];
            }

            entityName = files[f].replace(/\.js$/i, '');
            className  = entityName.substring(0, 1).toUpperCase() + entityName.substring(1);

            Entity = require(_(entitiesPath + '/' + files[f], true));
            if (typeof Entity !== 'function') continue;

            Entity = inherits(Entity, EntitySuperClass);

            Entity.prototype.name        = className;
            Entity.prototype.model       = infos.model;
            Entity.prototype.bundle      = infos.bundle;
            Entity.prototype.database    = infos.database;
            Entity.prototype._collection = entityName;
            Entity.prototype._scope      = infos.scope || process.env.NODE_SCOPE;
            Entity.prototype._filename   = _(entitiesPath + '/' + files[f], true);
            // public MongoClient accessor — supported entry point for driver-level
            // features (sessions, multi-document transactions, change streams) the
            // entity layer does not wrap; see resolveClient()/getClient().
            Entity.prototype.getClient   = getClient;

            entities[className] = Entity;
        }

        var pipelinesDir = _(getPath('bundle') + '/models/' + infos.database + '/pipelines');
        if (fs.existsSync(pipelinesDir)) {
            var entries = fs.readdirSync(pipelinesDir);
            for (var s = 0, sLen = entries.length; s < sLen; s++) {
                if ( /^\./.test(entries[s]) ) continue;
                loadPipelines(entities, conn, _(pipelinesDir + '/' + entries[s]), infos.scope);
            }
        }

        return entities;
    };


    var loadPipelines = function(entities, conn, dir, scope) {
        var stat = fs.statSync(dir);
        if (!stat.isDirectory()) return;

        var arr        = dir.split(/\//g);
        var entityName = arr[arr.length - 1];
        entityName = entityName.charAt(0).toUpperCase() + entityName.slice(1);

        if (!entities[entityName]) return;

        var pipelineFiles = fs.readdirSync(dir);
        for (var f = 0, fLen = pipelineFiles.length; f < fLen; f++) {
            if ( /^\./.test(pipelineFiles[f]) || !/\.json$/i.test(pipelineFiles[f]) ) continue;
            readPipeline(entities, conn, entityName, _(dir + '/' + pipelineFiles[f], true), scope);
        }
    };


    var readPipeline = function(entities, conn, entityName, source, scope) {
        var arr  = source.split(/\//g);
        var name = arr[arr.length - 1].replace(/\.json$/i, '');

        if (!entities[entityName]) return;
        if (typeof entities[entityName].prototype[name] !== 'undefined') {
            // Own property = user code in the entity .js wins (designed intent).
            // Inherited name = the file is silently shadowed (e.g. gina's
            // Object.prototype count()) — warn so the skip is diagnosable (#B173).
            if ( !Object.prototype.hasOwnProperty.call(entities[entityName].prototype, name) ) {
                console.warn('[Mongodb] skipping pipeline method \'' + name + '\' (' + source + '): the name is inherited on the ' + entityName + ' prototype chain (EventEmitter, entity base API, or gina\'s Object.prototype helpers like count()) — calls would run the inherited member instead. Rename the file, e.g. \'' + name + 'Rows.json\'.');
            }
            return;
        }

        var rawSource = fs.readFileSync(source).toString();

        var parsed;
        try {
            parsed = loader.parse(rawSource, scope || process.env.NODE_SCOPE);
        } catch (e) {
            console.error('[Mongodb] failed to parse pipeline file: ' + source + '\n' + e.message);
            return;
        }

        var paramTypes = parsed.paramTypes;
        var returnType = parsed.returnType;
        var body       = parsed.body;
        var op         = body.op;

        if (!op) {
            console.error('[Mongodb] pipeline file missing `op` field: ' + source);
            return;
        }

        var trigger    = 'MQL:' + entityName.toLowerCase() + '#' + name;
        var isWriteOp  = /^(insert|update|delete|replace|findOneAndUpdate|findOneAndDelete|findOneAndReplace)/i.test(op);

        // Coerce a Mongo driver result to the annotated return type.
        // Reads (find/findOne/aggregate) return docs or arrays directly;
        // writes return InsertOneResult / UpdateResult / DeleteResult.
        var coerce = function(result, isWrite) {
            if (returnType === 'boolean') {
                if (isWrite) {
                    if (!result || result.acknowledged !== true) return false;
                    if (typeof result.insertedId !== 'undefined' && result.insertedId !== null) return true;
                    if (typeof result.modifiedCount === 'number' && result.modifiedCount > 0) return true;
                    if (typeof result.deletedCount === 'number' && result.deletedCount > 0) return true;
                    if (typeof result.upsertedCount === 'number' && result.upsertedCount > 0) return true;
                    if (typeof result.matchedCount === 'number' && result.matchedCount > 0) return true;
                    return false;
                }
                return Array.isArray(result) ? result.length > 0 : !!result;
            }
            if (returnType === 'number') {
                if (typeof result === 'number') return result;
                if (Array.isArray(result)) return result.length;
                if (result && typeof result.modifiedCount === 'number') return result.modifiedCount;
                if (result && typeof result.deletedCount === 'number') return result.deletedCount;
                if (result && typeof result.insertedCount === 'number') return result.insertedCount;
                if (result && typeof result.matchedCount === 'number') return result.matchedCount;
                return 0;
            }
            if (returnType === 'object') {
                if (Array.isArray(result)) return result.length > 0 ? result[0] : null;
                return result || null;
            }
            if (returnType === 'array') {
                if (Array.isArray(result)) return result;
                return result ? [result] : [];
            }
            return result;
        };

        // Pre-execute coercion of arguments based on @param annotations.
        // Mongo BSON shapes: objectid, string, int, long, double, boolean, date.
        // Decimal128 / Binary intentionally deferred to a follow-up.
        var castParam = function(value, type) {
            if (value === null || typeof value === 'undefined') return value;
            switch (type) {
                case 'objectid':
                    if (!ObjectId) {
                        throw new Error('[Mongodb] @param {objectid} requires the mongodb driver to be installed in your project');
                    }
                    return (value instanceof ObjectId) ? value : new ObjectId(value);
                case 'int':
                case 'int32':
                    return parseInt(value, 10);
                case 'long':
                case 'int64':
                    return (typeof value === 'bigint') ? value : parseInt(value, 10);
                case 'double':
                case 'number':
                    return (typeof value === 'number') ? value
                        : parseFloat(String(value).replace(/,/, '.'));
                case 'boolean':
                    return /^true$/i.test(String(value));
                case 'string':
                case 'text':
                    return String(value);
                case 'date':
                case 'timestamp':
                    return (value instanceof Date) ? value : new Date(value);
                default:
                    return value;
            }
        };

        // Walk the pipeline body, replacing {$arg: N} with args[N] and
        // {$oid: "<hex>"} with new ObjectId(...). Returns a fresh tree —
        // never mutates `body` so the prototype method is reusable.
        var resolveArgs = function(node, args) {
            if (Array.isArray(node)) {
                var arrCopy = [];
                for (var i = 0; i < node.length; i++) {
                    arrCopy.push(resolveArgs(node[i], args));
                }
                return arrCopy;
            }
            if (node && typeof node === 'object') {
                var keys = Object.keys(node);
                if (keys.length === 1 && keys[0] === '$arg') {
                    var idx = node.$arg;
                    return (idx >= 0 && idx < args.length) ? args[idx] : null;
                }
                if (keys.length === 1 && keys[0] === '$oid') {
                    if (!ObjectId) {
                        throw new Error('[Mongodb] {"$oid": ...} requires the mongodb driver to be installed in your project');
                    }
                    return new ObjectId(node.$oid);
                }
                var objCopy = {};
                for (var k = 0; k < keys.length; k++) {
                    objCopy[keys[k]] = resolveArgs(node[keys[k]], args);
                }
                return objCopy;
            }
            return node;
        };

        entities[entityName].prototype[name] = function() {
            var self = this;
            var args = Array.prototype.slice.call(arguments);
            var _mainCallback = null;

            if (typeof args[args.length - 1] === 'function') {
                _mainCallback = args.pop();
            }

            // #B432 — ONE per-call guard for every settle path below (unknown-op
            // branch and callback-mode dispatch both used to settle twice).
            var _deliver = settleOnce(trigger, _mainCallback, console);

            for (var t = 0, tLen = paramTypes.length; t < tLen && t < args.length; t++) {
                args[t] = castParam(args[t], paramTypes[t]);
            }

            var resolvedBody;
            try {
                resolvedBody = resolveArgs(body, args);
            } catch (e) {
                if (_mainCallback) { _deliver(e); return; }
                return Promise.reject(e);
            }

            var coll = conn.collection(self._collection);
            var execPromise;
            try {
                switch (op) {
                    case 'findOne':
                        execPromise = coll.findOne(resolvedBody.filter || {}, resolvedBody.options || {});
                        break;
                    case 'find':
                        execPromise = coll.find(resolvedBody.filter || {}, resolvedBody.options || {}).toArray();
                        break;
                    case 'aggregate':
                        execPromise = coll.aggregate(resolvedBody.pipeline || [], resolvedBody.options || {}).toArray();
                        break;
                    case 'countDocuments':
                        execPromise = coll.countDocuments(resolvedBody.filter || {}, resolvedBody.options || {});
                        break;
                    case 'insertOne':
                        execPromise = coll.insertOne(resolvedBody.doc || {}, resolvedBody.options || {});
                        break;
                    case 'insertMany':
                        execPromise = coll.insertMany(resolvedBody.docs || [], resolvedBody.options || {});
                        break;
                    case 'updateOne':
                        execPromise = coll.updateOne(resolvedBody.filter || {}, resolvedBody.update || {}, resolvedBody.options || {});
                        break;
                    case 'updateMany':
                        execPromise = coll.updateMany(resolvedBody.filter || {}, resolvedBody.update || {}, resolvedBody.options || {});
                        break;
                    case 'replaceOne':
                        execPromise = coll.replaceOne(resolvedBody.filter || {}, resolvedBody.replacement || {}, resolvedBody.options || {});
                        break;
                    case 'deleteOne':
                        execPromise = coll.deleteOne(resolvedBody.filter || {}, resolvedBody.options || {});
                        break;
                    case 'deleteMany':
                        execPromise = coll.deleteMany(resolvedBody.filter || {}, resolvedBody.options || {});
                        break;
                    default:
                        var unknownErr = new Error('[Mongodb] unknown op `' + op + '` in ' + source);
                        if (_mainCallback) { _deliver(unknownErr); return; }
                        return Promise.reject(unknownErr);
                }
            } catch (e) {
                if (_mainCallback) { _deliver(e); return; }
                return Promise.reject(e);
            }

            if (envIsDev) {
                // #B350 — the resolved body inlines the caller's values (filter values,
                // whole documents); the default logs a structure-preserving redaction
                // (keys + nesting kept, every primitive leaf replaced by its type marker),
                // and `inspector.queries.captureValues` opts back in to real values.
                console.debug('[ ' + trigger + ' ] op=' + op + ' body=' + JSON.stringify(paramRedact.captureValues() ? resolvedBody : paramRedact.redactValuesDeep(resolvedBody)));
            }

            var _devLog = null, _queryEntry = null;
            // #INS10 — capture during a prod instrumentation window too (not just dev mode).
            if (envIsDev || (process.gina && process.gina._inspectorWindowUntil > Date.now())) {
                var _alsStore = process.gina && process.gina._queryALS
                    ? process.gina._queryALS.getStore() : null;
                _devLog = _alsStore ? _alsStore._devQueryLog : null;
                if (_devLog) {
                    _queryEntry = {
                        type        : 'MQL',
                        trigger     : entityName.toLowerCase() + '#' + name,
                        statement   : op + ' ' + JSON.stringify(paramRedact.captureValues() ? resolvedBody : paramRedact.redactValuesDeep(resolvedBody)),
                        params      : args.length > 0 ? (paramRedact.captureValues() ? args.slice() : paramRedact.summarize(args)) : [],
                        durationMs  : 0,
                        resultCount : 0,
                        resultSize  : 0,
                        indexes     : null,
                        error       : null,
                        source      : source || '',
                        origin      : infos.bundle,
                        connector   : 'mongodb'
                    };
                    _queryEntry._startMs = Date.now();
                    _devLog.push(_queryEntry);
                }
            }

            if (_mainCallback === null) {
                var _resolve, _reject, _internalData;

                var _promise = new Promise(function(resolve, reject) {
                    _resolve = resolve;
                    _reject  = reject;
                });

                _promise.onComplete = function(cb) {
                    _promise.then(
                        function()    { cb(null, _internalData); },
                        function(err) { cb(err); }
                    );
                    return _promise;
                };

                execPromise.then(function(result) {
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                    }
                    var raw = coerce(result, isWriteOp);
                    if (_queryEntry) {
                        _queryEntry.resultCount = raw ? (Array.isArray(raw) ? raw.length : 1) : 0;
                        try { _queryEntry.resultSize = raw ? JSON.stringify(raw).length : 0; } catch(_e) { _queryEntry.resultSize = 0; }
                    }
                    _internalData = raw;
                    _resolve(raw);
                }).catch(function(err) {
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                        _queryEntry.error      = err.message || String(err);
                    }
                    err.message = '[ ' + source + ' ]\n' + err.message;
                    _reject(lib.connectorError.stamp(err));
                });

                return _promise;

            } else {
                execPromise.then(function(result) {
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                    }
                    var raw = coerce(result, isWriteOp);
                    if (_queryEntry) {
                        _queryEntry.resultCount = raw ? (Array.isArray(raw) ? raw.length : 1) : 0;
                        try { _queryEntry.resultSize = raw ? JSON.stringify(raw).length : 0; } catch(_e) { _queryEntry.resultSize = 0; }
                    }
                    _deliver(null, raw);
                }).catch(function(err) {
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                        _queryEntry.error      = err.message || String(err);
                    }
                    err.message = '[ ' + source + ' ]\n' + err.message;
                    _deliver(lib.connectorError.stamp(err));
                });
            }
        };
    };


    /**
     * getClient
     *
     * Returns the underlying MongoDB driver `MongoClient` backing this entity's
     * connection. The entity layer is handed the `Db` (what `getConnection()`
     * returns); the `MongoClient` lives one level up and is where session and
     * multi-document transaction APIs are exposed — so this is the supported,
     * non-underscore way to reach driver-level features the entity layer does
     * not wrap, chiefly ACID transactions via
     * `client.startSession()` → `session.withTransaction(...)`, plus change
     * streams and `bulkWrite`.
     *
     * Note: gina does not bundle or pin the `mongodb` driver — it is resolved
     * from your project's `node_modules`. Session/transaction support therefore
     * depends on the driver your project installs, and multi-document
     * transactions additionally require a replica-set or sharded deployment
     * (not a standalone mongod). gina guarantees only that this returns the
     * resolved client handle; it makes no promise about which driver-level
     * capabilities that handle exposes.
     *
     * @returns {object} The MongoDB driver MongoClient.
     * @throws {Error} `GINA_MONGODB_CLIENT_UNRESOLVED` when the client cannot be resolved.
     *
     * @example
     * // Inside a controller action holding an entity instance:
     * var client  = myEntity.getClient();
     * var session = client.startSession();
     * try {
     *     await session.withTransaction(async function () {
     *         var db = client.db();
     *         await db.collection('accounts').updateOne({ _id: from }, { $inc: { balance: -100 } }, { session: session });
     *         await db.collection('accounts').updateOne({ _id: to },   { $inc: { balance:  100 } }, { session: session });
     *     });
     * } finally {
     *     await session.endSession();
     * }
     */
    var getClient = function() {
        return resolveClient(this.getConnection());
    };


    return init(conn, infos);
}

module.exports = Mongodb;
