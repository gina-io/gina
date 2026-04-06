/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var fs        = require('fs');
var sqlParser = require('./../sql-parser'); // #SQL1 state-machine comment stripper
var lib       = require('./../../../lib') || require.cache[require.resolve('./../../../lib')];
var inherits  = lib.inherits;
var console   = lib.logger;

/**
 * MySQL ORM connector.
 *
 * Wires entity classes with SQL methods read from the bundle's `sql/` directory.
 * SQL files use standard MySQL syntax with `?` positional placeholders.
 * Backed by the `mysql2` pool passed from MysqlConnector.onReady.
 *
 * Bundle model layout:
 * ```
 * models/
 *   <database>/
 *     entities/
 *       UserEntity.js        ← entity class
 *     sql/
 *       User/
 *         findById.sql       ← SELECT … WHERE id = ?
 *         findAll.sql
 *         insert.sql
 * ```
 *
 * SQL file format:
 * ```sql
 * / *
 *  * @param {string}  ?   user id
 *  * @return {object}
 *  * /
 * SELECT * FROM users WHERE id = ?
 * ```
 *
 * `@return` annotation controls result shape:
 *   {object}  → first row or null
 *   {Array}   → all rows (default for SELECT)
 *   {boolean} → affectedRows > 0 (write) / rows.length > 0 (SELECT)
 *   {number}  → first key of first row (COUNT(*) queries)
 *   (none)    → { changes, insertId } for write ops; all rows for SELECT
 *
 * Methods return a native Promise with `.onComplete(cb)` for backward compatibility.
 *
 * @class Mysql
 * @constructor
 * @param {object} conn  - mysql2 Pool from MysqlConnector.onReady
 * @param {object} infos - { model, bundle, database, scope }
 * @returns {object}     - Entity class map: { UserEntity: Constructor, … }
 */
function Mysql(conn, infos) {
    var envIsDev    = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) ) ? true : false;
    var isCacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;

    // -------------------------------------------------------------------------
    // init — load entities + SQL methods
    // -------------------------------------------------------------------------
    var init = function(conn, infos) {
        var EntitySuperClass = null;
        var entitiesPath     = getPath('bundle') + '/models/' + infos.database + '/entities';
        var files            = [];
        var entities         = {};
        var entityName       = '';
        var Entity           = null;
        var className        = null;
        var filename         = null;

        // EntitySuperClass ────────────────────────────────────────────────────
        filename = getPath('gina').core + '/model/entity.js';
        if (isCacheless) {
            delete require.cache[require.resolve(_(filename, true))];
        }
        EntitySuperClass = require(_(filename, true));

        // Entity JS files ─────────────────────────────────────────────────────
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

        // SQL method files ────────────────────────────────────────────────────
        var sqlDir = _(getPath('bundle') + '/models/' + infos.database + '/sql');
        if (fs.existsSync(sqlDir)) {
            var sqlEntries = fs.readdirSync(sqlDir);
            for (var s = 0, sLen = sqlEntries.length; s < sLen; s++) {
                if ( /^\./.test(sqlEntries[s]) ) continue;
                loadSQL(entities, conn, _(sqlDir + '/' + sqlEntries[s]));
            }
        }

        return entities;
    };


    // -------------------------------------------------------------------------
    // loadSQL — walk the sql/ entry (directory per entity or flat file)
    // -------------------------------------------------------------------------
    var loadSQL = function(entities, conn, sqlPath) {
        var stat = fs.statSync(sqlPath);

        if (stat.isDirectory()) {
            // sql/<EntityName>/methodName.sql
            var arr        = sqlPath.split(/\//g);
            var entityName = arr[arr.length - 1];
            entityName = entityName.charAt(0).toUpperCase() + entityName.slice(1);

            var sqlFiles = fs.readdirSync(sqlPath);
            for (var f = 0, fLen = sqlFiles.length; f < fLen; f++) {
                if ( /^\./.test(sqlFiles[f]) || !/\.sql$/i.test(sqlFiles[f]) ) continue;
                readSQL(entities, conn, entityName, _(sqlPath + '/' + sqlFiles[f], true));
            }
        } else {
            // flat file: <EntityName>_<methodName>.sql
            readSQL(entities, conn, null, sqlPath);
        }
    };


    // -------------------------------------------------------------------------
    // readSQL — parse one .sql file and attach a method to the entity
    // -------------------------------------------------------------------------
    var readSQL = function(entities, conn, entityName, source) {
        var arr  = source.split(/\//g);
        var name = arr[arr.length - 1].replace(/\.sql$/i, '');

        // Infer entity from flat filename prefix when not given
        if (!entityName) {
            var parts = name.split('_');
            if (parts.length < 2) return;
            entityName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
            name       = parts.slice(1).join('_');
        }

        if (!entities[entityName]) return;
        if (typeof entities[entityName].prototype[name] !== 'undefined') return;

        // ── Parse the SQL file ────────────────────────────────────────────────
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

        // #SQL1 — state-machine stripper handles nested comments and
        // -- / // inside string literals correctly
        var queryString = sqlParser.stripComments(rawSource)
            .replace(/\s+/g, ' ')
            .trim();

        if (!queryString) return;

        var isSELECT = /^\s*SELECT\b/i.test(queryString);
        var trigger  = 'MySQL:' + entityName.toLowerCase() + '#' + name;

        // ── Helper: coerce mysql2 result to the annotated return type ─────────
        //
        // SELECT → results is RowDataPacket[] (behaves like plain objects[])
        // Write  → results is ResultSetHeader { affectedRows, insertId, … }
        // ─────────────────────────────────────────────────────────────────────
        var coerce = function(results) {
            if (isSELECT) {
                var rows = results;

                if (returnType === 'object') {
                    return (rows.length > 0) ? rows[0] : null;
                }
                if (returnType === 'boolean') {
                    return rows.length > 0;
                }
                if (returnType === 'number' && /count\s*\(/i.test(queryString)) {
                    if (rows.length > 0 && typeof rows[0] === 'object') {
                        var keys = Object.keys(rows[0]);
                        return (keys.length > 0) ? rows[0][keys[0]] : 0;
                    }
                    return 0;
                }
                // {array} or no annotation — all rows, normalised to null when empty
                return rows.length > 0 ? rows : null;
            }

            // Write op
            if (returnType === 'boolean') return results.affectedRows > 0;
            if (returnType === 'number')  return results.affectedRows;
            // Default: normalised write result (mirrors SQLite semantics)
            return { changes: results.affectedRows, insertId: results.insertId };
        };

        // ── Entity method ─────────────────────────────────────────────────────
        entities[entityName].prototype[name] = function() {
            var args = Array.prototype.slice.call(arguments);
            var _mainCallback = null;

            // Trailing-function detection (util.promisify / explicit callback)
            if (typeof args[args.length - 1] === 'function') {
                _mainCallback = args.pop();
            }

            // Positional type casting from @param annotations
            for (var t = 0, tLen = paramTypes.length; t < tLen && t < args.length; t++) {
                switch (paramTypes[t]) {
                    case 'number':
                    case 'integer': args[t] = parseInt(args[t], 10);                          break;
                    case 'float':   args[t] = parseFloat(String(args[t]).replace(/,/, '.')); break;
                    case 'string':  args[t] = String(args[t]);                                break;
                }
            }

            if (envIsDev) {
                console.debug('[ ' + trigger + ' ] ' + queryString);
                if (args.length > 0) {
                    console.debug('[ ' + trigger + ' ] params: ' + JSON.stringify(args));
                }
            }

            // ── QI — dev-mode query instrumentation ──────────────────────────
            var _devLog = null, _queryEntry = null;
            if (envIsDev) {
                var _alsStore = process.gina && process.gina._queryALS
                    ? process.gina._queryALS.getStore() : null;
                _devLog = _alsStore ? _alsStore._devQueryLog : null;
                if (_devLog) {
                    _queryEntry = {
                        type        : 'MySQL',
                        trigger     : entityName.toLowerCase() + '#' + name,
                        statement   : String(queryString),
                        params      : args.length > 0 ? args.slice() : [],
                        durationMs  : 0,
                        resultCount : 0,
                        resultSize  : 0,
                        indexes     : null,
                        error       : null,
                        source      : source || '',
                        origin      : infos.bundle,
                        connector   : 'mysql'
                    };
                    _queryEntry._startMs = Date.now();
                    _devLog.push(_queryEntry);
                }
            }

            // ── Option B — native Promise with .onComplete() shim ─────────────
            //
            // mysql2 pool.execute() is natively async — no setTimeout(0) needed.
            // The Promise resolves inside the driver callback, giving callers the
            // same timing guarantees as the SQLite connector.
            // ─────────────────────────────────────────────────────────────────
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

                conn.execute(queryString, args, function(err, results) {
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                        // _startMs is kept for the Flow tab timeline (#FI)
                    }
                    if (err) {
                        if (_queryEntry) _queryEntry.error = err.message || String(err);
                        err.message = '[ ' + source + ' ]\n' + err.message;
                        _reject(err);
                        return;
                    }
                    var raw = coerce(results);
                    if (_queryEntry) {
                        _queryEntry.resultCount = raw ? (Array.isArray(raw) ? raw.length : 1) : 0;
                        try { _queryEntry.resultSize = raw ? JSON.stringify(raw).length : 0; } catch(_e) { _queryEntry.resultSize = 0; }
                    }
                    _internalData = raw;
                    _resolve(raw);
                });

                return _promise;

            } else {
                // Direct callback path (util.promisify or explicit callback)
                conn.execute(queryString, args, function(err, results) {
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                    }
                    if (err) {
                        if (_queryEntry) _queryEntry.error = err.message || String(err);
                        err.message = '[ ' + source + ' ]\n' + err.message;
                        _mainCallback(err);
                        return;
                    }
                    var raw = coerce(results);
                    if (_queryEntry) {
                        _queryEntry.resultCount = raw ? (Array.isArray(raw) ? raw.length : 1) : 0;
                        try { _queryEntry.resultSize = raw ? JSON.stringify(raw).length : 0; } catch(_e) { _queryEntry.resultSize = 0; }
                    }
                    _mainCallback(null, raw);
                });
            }
        };
    };


    return init(conn, infos);
}

module.exports = Mysql;
