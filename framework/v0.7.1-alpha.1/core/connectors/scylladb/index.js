/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var fs        = require('fs');
var sqlParser = require('./../sql-parser');
var paramRedact = require('./../param-redact'); // #B350 — bound-value redaction for dev/Inspector sinks
var settleOnce  = require('./../settle-once');   // #B432 — per-call at-most-once settlement
var lib       = require('./../../../lib') || require.cache[require.resolve('./../../../lib')];
var inherits  = lib.inherits;
var console   = lib.logger;

/**
 * ScyllaDB / Cassandra ORM connector.
 *
 * Wires entity classes with CQL methods read from the bundle's `cql/` directory.
 * CQL files use Cassandra Query Language with `?` positional placeholders.
 * Backed by a cassandra-driver Client passed from ScylladbConnector.onReady.
 *
 * Bundle model layout:
 * ```
 * models/
 *   <keyspace>/
 *     entities/
 *       UserEntity.js        ← entity class
 *     cql/
 *       User/
 *         findById.sql       ← SELECT * FROM users WHERE id = ?
 *         findAll.sql
 *         insert.sql
 * ```
 *
 * CQL file format:
 * ```sql
 * / *
 *  * @param  {uuid}    ?    user id
 *  * @return {object}
 *  * /
 * SELECT * FROM users WHERE id = ?
 * ```
 *
 * `@return` annotation controls result shape:
 *   {object}  → first row or null
 *   {Array}   → all rows (default for SELECT)
 *   {boolean} → rowLength > 0 (SELECT) / [applied] for LWT writes / true for unconditional writes
 *   {number}  → first column of first row (COUNT(*) queries)
 *   (none)    → all rows for SELECT, null for write ops
 *
 * Methods return a native Promise with `.onComplete(cb)` for backward compatibility.
 *
 * Note on shard awareness: cassandra-driver provides token-aware routing on Node.js
 * but not the shard-aware optimization available in the Python / Java / Go / Rust
 * ScyllaDB drivers. Use the framework `@scylladb` connector for ergonomic ORM access;
 * if shard-aware latency is critical, run that path via a separate service.
 *
 * @class Scylladb
 * @constructor
 * @param {object} conn  - cassandra-driver Client from ScylladbConnector.onReady
 * @param {object} infos - { model, bundle, database, scope }
 * @returns {object}     - Entity class map: { UserEntity: Constructor, … }
 */
function Scylladb(conn, infos) {
    var envIsDev    = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) ) ? true : false;
    var isCacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;

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

            entities[className] = Entity;
        }

        var cqlDir = _(getPath('bundle') + '/models/' + infos.database + '/cql');
        if (fs.existsSync(cqlDir)) {
            var cqlEntries = fs.readdirSync(cqlDir);
            for (var s = 0, sLen = cqlEntries.length; s < sLen; s++) {
                if ( /^\./.test(cqlEntries[s]) ) continue;
                loadCQL(entities, conn, _(cqlDir + '/' + cqlEntries[s]));
            }
        }

        return entities;
    };


    var loadCQL = function(entities, conn, cqlPath) {
        var stat = fs.statSync(cqlPath);

        if (stat.isDirectory()) {
            var arr        = cqlPath.split(/\//g);
            var entityName = arr[arr.length - 1];
            entityName = entityName.charAt(0).toUpperCase() + entityName.slice(1);

            var cqlFiles = fs.readdirSync(cqlPath);
            for (var f = 0, fLen = cqlFiles.length; f < fLen; f++) {
                if ( /^\./.test(cqlFiles[f]) || !/\.sql$/i.test(cqlFiles[f]) ) continue;
                readCQL(entities, conn, entityName, _(cqlPath + '/' + cqlFiles[f], true));
            }
        } else {
            readCQL(entities, conn, null, cqlPath);
        }
    };


    var readCQL = function(entities, conn, entityName, source) {
        var arr  = source.split(/\//g);
        var name = arr[arr.length - 1].replace(/\.sql$/i, '');

        if (!entityName) {
            var parts = name.split('_');
            if (parts.length < 2) return;
            entityName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
            name       = parts.slice(1).join('_');
        }

        if (!entities[entityName]) return;
        if (typeof entities[entityName].prototype[name] !== 'undefined') {
            // Own property = user code in the entity .js wins (designed intent).
            // Inherited name = the file is silently shadowed (e.g. gina's
            // Object.prototype count()) — warn so the skip is diagnosable (#B173).
            if ( !Object.prototype.hasOwnProperty.call(entities[entityName].prototype, name) ) {
                console.warn('[scylladb] skipping query method \'' + name + '\' (' + source + '): the name is inherited on the ' + entityName + ' prototype chain (EventEmitter, entity base API, or gina\'s Object.prototype helpers like count()) — calls would run the inherited member instead. Rename the file, e.g. \'' + name + 'Rows.sql\'.');
            }
            return;
        }

        var rawSource = fs.readFileSync(source).toString();

        var returnType = null;
        var retMatch   = rawSource.match(/@return\s+\{([^}]+)\}/);
        if (retMatch) returnType = retMatch[1].trim().toLowerCase();

        var paramTypes = [];
        var ptMatches  = rawSource.match(/@param\s+\{([^}]+)\}/g);
        if (ptMatches) {
            for (var pt = 0; pt < ptMatches.length; pt++) {
                paramTypes.push(ptMatches[pt].match(/\{([^}]+)\}/)[1].trim().toLowerCase());
            }
        }

        var queryString = sqlParser.stripComments(rawSource)
            .replace(/\s+/g, ' ')
            .trim();

        if (!queryString) return;

        var isSELECT = /^\s*SELECT\b/i.test(queryString);
        var isLWT    = /\bIF\s+(NOT\s+)?EXISTS\b/i.test(queryString) || /\bIF\s+\w+\s*=/i.test(queryString);
        var trigger  = 'CQL:' + entityName.toLowerCase() + '#' + name;

        // Coerce a cassandra-driver ResultSet to the annotated return type.
        // CQL writes (INSERT/UPDATE/DELETE) return an empty rows array unless
        // they are LWT (IF NOT EXISTS / IF condition); LWTs return one row
        // with an [applied] column. SELECT returns rows as plain objects.
        var coerce = function(result) {
            if (isSELECT) {
                var rows = result.rows || [];
                if (returnType === 'object') {
                    return (rows.length > 0) ? rows[0] : null;
                }
                if (returnType === 'boolean') {
                    return rows.length > 0;
                }
                if (returnType === 'number' && /count\s*\(/i.test(queryString)) {
                    if (rows.length > 0 && typeof rows[0] === 'object') {
                        var keys = Object.keys(rows[0]);
                        if (keys.length === 0) return 0;
                        var v = rows[0][keys[0]];
                        return (v && typeof v.toNumber === 'function') ? v.toNumber() : Number(v);
                    }
                    return 0;
                }
                return rows.length > 0 ? rows : null;
            }

            if (isLWT) {
                var lwtRows = result.rows || [];
                var applied = (lwtRows.length > 0 && lwtRows[0]['[applied]'] === true);
                if (returnType === 'boolean') return applied;
                return applied ? lwtRows[0] : null;
            }

            if (returnType === 'boolean') return true;
            return null;
        };

        // Pre-execute coercion of arguments based on @param annotations.
        // CQL types follow cassandra-driver's expected JS shapes — strings for
        // text/varchar/uuid/timeuuid/inet, numbers for int/bigint/decimal/double/float,
        // Buffer for blob, Date for timestamp.
        var castParam = function(value, type) {
            if (value === null || typeof value === 'undefined') return value;
            switch (type) {
                case 'int':
                case 'smallint':
                case 'tinyint':
                case 'counter':
                    return parseInt(value, 10);
                case 'bigint':
                case 'varint':
                    return (typeof value === 'bigint') ? value : parseInt(value, 10);
                case 'decimal':
                case 'double':
                case 'float':
                    return (typeof value === 'number') ? value
                        : parseFloat(String(value).replace(/,/, '.'));
                case 'boolean':
                    return /^true$/i.test(String(value));
                case 'text':
                case 'varchar':
                case 'ascii':
                case 'inet':
                case 'uuid':
                case 'timeuuid':
                    return String(value);
                case 'timestamp':
                    return (value instanceof Date) ? value : new Date(value);
                default:
                    return value;
            }
        };

        entities[entityName].prototype[name] = function() {
            var args = Array.prototype.slice.call(arguments);
            var _mainCallback = null;

            if (typeof args[args.length - 1] === 'function') {
                _mainCallback = args.pop();
            }

            for (var t = 0, tLen = paramTypes.length; t < tLen && t < args.length; t++) {
                args[t] = castParam(args[t], paramTypes[t]);
            }

            if (envIsDev) {
                console.debug('[ ' + trigger + ' ] ' + queryString);
                if (args.length > 0) {
                    // #B350 — bound values redacted by default (count + types);
                    // `inspector.queries.captureValues` opts in to real values.
                    console.debug('[ ' + trigger + ' ] params: ' + (paramRedact.captureValues() ? JSON.stringify(args) : paramRedact.describeParams(args)));
                }
            }

            var _devLog = null, _queryEntry = null;
            // #INS10 — capture during a prod instrumentation window too (not just dev mode).
            if (envIsDev || (process.gina && process.gina._inspectorWindowUntil > Date.now())) {
                var _alsStore = process.gina && process.gina._queryALS
                    ? process.gina._queryALS.getStore() : null;
                _devLog = _alsStore ? _alsStore._devQueryLog : null;
                if (_devLog) {
                    _queryEntry = {
                        type        : 'CQL',
                        trigger     : entityName.toLowerCase() + '#' + name,
                        statement   : String(queryString),
                        params      : args.length > 0 ? (paramRedact.captureValues() ? args.slice() : paramRedact.summarize(args)) : [],
                        durationMs  : 0,
                        resultCount : 0,
                        resultSize  : 0,
                        indexes     : null,
                        error       : null,
                        source      : source || '',
                        origin      : infos.bundle,
                        connector   : 'scylladb'
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

                conn.execute(queryString, args, { prepare: true }).then(function(result) {
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                    }
                    var raw = coerce(result);
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
                // #B432 — settle at most once; a throwing callback is reported, never re-invoked.
                var _deliver = settleOnce(trigger, _mainCallback, console);
                conn.execute(queryString, args, { prepare: true }).then(function(result) {
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                    }
                    var raw = coerce(result);
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


    return init(conn, infos);
}

module.exports = Scylladb;
