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
 * SQLite ORM connector — v2.
 *
 * Wires entity classes with SQL methods read from the bundle's `sql/` directory.
 * SQL files use standard SQLite syntax with `?` positional placeholders.
 * Backed by `node:sqlite` (Node.js built-in, available since Node 22.5.0).
 *
 * Bundle model layout:
 * ```
 * models/
 *   <database>/
 *     entities/
 *       UserEntity.js        ← entity class (same pattern as Couchbase)
 *     sql/
 *       User/
 *         findById.sql       ← SELECT … WHERE id = ?
 *         findAll.sql
 *         insert.sql
 *       Product/
 *         findAll.sql
 * ```
 *
 * SQL file format:
 * ```sql
 * / *
 *  * @param {string}  $id
 *  * @return {object}
 *  * /
 * SELECT * FROM users WHERE id = ?
 * ```
 *
 * `@return` annotation controls how results are presented:
 *   {object}  → `stmt.get()` — first row or null
 *   {Array}   → `stmt.all()` — all rows (default for SELECT)
 *   {boolean} → `stmt.run().changes > 0` for write ops; `rows.length > 0` for SELECT
 *   {number}  → first key of first row (COUNT(*) queries)
 *   (none)    → `stmt.all()` for SELECT, `stmt.run()` for write ops
 *
 * Methods return a native Promise with `.onComplete(cb)` attached for backward
 * compatibility (same Option-B pattern as the Couchbase N1QL connector).
 *
 * @class Sqlite
 * @constructor
 * @param {object} conn  - DatabaseSync instance from SqliteConnector.onReady
 * @param {object} infos - { model, bundle, database, scope }
 * @returns {object}     - Entity class map: { UserEntity: Constructor, … }
 */
function Sqlite(conn, infos) {
    var envIsDev    = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) ) ? true : false;
    var isCacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;

    // #QI1 — in-memory index map built from indexes.sql at startup.
    // Keys are lowercase table names; values are [{ name, primary }].
    // null when no indexes.sql exists (grey N/A badge in Inspector).
    var _knownIndexes = null;
    /** @type {boolean} #QI2 — true after live introspection has populated _knownIndexes */
    var _liveIntrospected = false;

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

            Entity.prototype.name       = className;
            Entity.prototype.model      = infos.model;
            Entity.prototype.bundle     = infos.bundle;
            Entity.prototype.database   = infos.database;
            Entity.prototype._collection = entityName;
            Entity.prototype._scope     = infos.scope || process.env.NODE_SCOPE;
            Entity.prototype._filename  = _(entitiesPath + '/' + files[f], true);

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

            // #QI1 — load indexes.sql if present
            var indexesFile = _(sqlDir + '/indexes.sql', true);
            if (fs.existsSync(indexesFile)) {
                try {
                    var indexesSrc = fs.readFileSync(indexesFile).toString();
                    _knownIndexes = sqlParser.parseCreateIndexes(indexesSrc);
                } catch (e) {
                    console.warn('[sqlite] Failed to parse indexes.sql: ' + e.message);
                    _knownIndexes = {};
                }
            }
        }

        // #QI2 — live index introspection listener (dev mode only).
        // The /_gina/indexes endpoint emits this event; the connector responds
        // with live index data from PRAGMA index_list, updating _knownIndexes
        // so all subsequent QI entries benefit automatically.
        if (envIsDev) {
            process.on('inspector#indexes', function(_cb) {
                if (_liveIntrospected) {
                    return _cb(null, 'sqlite', infos.database, _knownIndexes);
                }
                try {
                    var tables = conn.prepare(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    ).all();
                    var map = {};
                    for (var ti = 0; ti < tables.length; ti++) {
                        var tbl = tables[ti].name.toLowerCase();
                        var idxList = conn.prepare(
                            'PRAGMA index_list("' + tables[ti].name + '")'
                        ).all();
                        if (idxList.length > 0) {
                            map[tbl] = [];
                            for (var ii = 0; ii < idxList.length; ii++) {
                                map[tbl].push({
                                    name: idxList[ii].name,
                                    primary: idxList[ii].origin === 'pk'
                                });
                            }
                        }
                    }
                    // Merge live data into _knownIndexes (live wins)
                    if (_knownIndexes === null) _knownIndexes = {};
                    var mapTables = Object.keys(map);
                    for (var i = 0; i < mapTables.length; i++) {
                        _knownIndexes[mapTables[i]] = map[mapTables[i]];
                    }
                    _liveIntrospected = true;
                    _cb(null, 'sqlite', infos.database, _knownIndexes);
                } catch (e) {
                    _cb(e, 'sqlite', infos.database, _knownIndexes);
                }
            });
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
            // entityName inferred from the underscore-separated filename prefix
            readSQL(entities, conn, null, sqlPath);
        }
    };


    // -------------------------------------------------------------------------
    // readSQL — parse one .sql file and attach a method to the entity
    // -------------------------------------------------------------------------
    var readSQL = function(entities, conn, entityName, source) {
        var arr    = source.split(/\//g);
        var name   = arr[arr.length - 1].replace(/\.sql$/i, '');

        // Infer entity from flat filename prefix when not given (e.g. User_findById.sql)
        if (!entityName) {
            var parts = name.split('_');
            if (parts.length < 2) return; // can't determine entity — skip
            entityName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
            name       = parts.slice(1).join('_');
        }

        if (!entities[entityName]) return; // entity not loaded — skip
        if (typeof entities[entityName].prototype[name] !== 'undefined') return; // already defined

        // ── Parse the SQL file ────────────────────────────────────────────────
        var rawSource  = fs.readFileSync(source).toString();

        // Extract @return {type} from comment block
        var returnType = null;
        var retMatch   = rawSource.match(/@return\s+\{([^}]+)\}/);
        if (retMatch) returnType = retMatch[1].trim().toLowerCase();

        // Extract @param {type} from comment block (in declaration order)
        var paramTypes = [];
        var ptMatches  = rawSource.match(/@param\s+\{([^}]+)\}/g);
        if (ptMatches) {
            for (var pt = 0; pt < ptMatches.length; pt++) {
                paramTypes.push(ptMatches[pt].match(/\{([^}]+)\}/)[1].trim().toLowerCase());
            }
        }

        // Strip comments, collapse whitespace
        // #SQL1 — state-machine stripper handles nested block comments and
        // -- / // inside string literals correctly (replaces single-pass regex)
        var queryString = sqlParser.stripComments(rawSource)
            .replace(/\s+/g, ' ')
            .trim();

        if (!queryString) return; // empty file — skip

        var isSELECT = /^\s*SELECT\b/i.test(queryString);
        var trigger  = 'SQL:' + entityName.toLowerCase() + '#' + name;

        // Pre-compile the statement once at load time.
        var stmt      = null;
        var stmtError = null;
        try {
            stmt = conn.prepare(queryString);
        } catch (e) {
            stmtError = new Error(
                '[SQLite][' + entityName + '#' + name + '] Failed to prepare statement: '
                + e.message + '\nSQL: ' + queryString
            );
            console.error(stmtError.message);
        }

        // ── Helper: execute the prepared statement ────────────────────────────
        var execute = function(args) {
            if (stmtError) throw stmtError;

            var raw;
            if (isSELECT) {
                if (returnType === 'object') {
                    raw = stmt.get.apply(stmt, args);
                    raw = (raw != null && raw !== undefined) ? raw : null;
                } else {
                    raw = stmt.all.apply(stmt, args);
                }
            } else {
                raw = stmt.run.apply(stmt, args);
            }

            // ── Return-type coercions ─────────────────────────────────────────
            if (raw === undefined) raw = null;

            if (returnType === 'boolean') {
                if (Array.isArray(raw)) {
                    raw = raw.length > 0;
                } else if (raw !== null && typeof raw === 'object' && 'changes' in raw) {
                    raw = raw.changes > 0;
                } else {
                    raw = !!raw;
                }
            } else if (returnType === 'number' && /count\s*\(/i.test(queryString)) {
                // COUNT(*) AS alias → extract the numeric value from the first row
                if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object') {
                    var keys = Object.keys(raw[0]);
                    raw = raw[0][keys[0]];
                } else if (raw !== null && !Array.isArray(raw) && typeof raw === 'object') {
                    var keys = Object.keys(raw);
                    raw = raw[keys[0]];
                }
            } else if (!returnType && !isSELECT) {
                // Write ops with no annotation — return the run result object
                // { changes: <n>, lastInsertRowid: <id> }
                // Keeps raw as-is.
            } else if (Array.isArray(raw) && raw.length === 0) {
                raw = null; // normalise empty result set to null (matches N1QL behaviour)
            }

            return raw;
        };

        // ── Entity method ─────────────────────────────────────────────────────
        entities[entityName].prototype[name] = function() {
            var self = this;
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
                    case 'integer': args[t] = parseInt(args[t], 10); break;
                    case 'float':   args[t] = parseFloat(String(args[t]).replace(/,/, '.')); break;
                    case 'string':  args[t] = String(args[t]); break;
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
                    // #QI1 — resolve indexes from _knownIndexes map
                    var _indexes = null;
                    if (_knownIndexes !== null) {
                        var _tbl = sqlParser.extractTargetTable(queryString);
                        _indexes = (_tbl && _knownIndexes[_tbl]) ? _knownIndexes[_tbl] : [];
                    }
                    _queryEntry = {
                        type        : 'SQL',
                        trigger     : entityName.toLowerCase() + '#' + name,
                        statement   : String(queryString),
                        params      : args.length > 0 ? args.slice() : [],
                        durationMs  : 0,
                        resultCount : 0,
                        resultSize  : 0,
                        indexes     : _indexes,
                        table       : _tbl || null,
                        error       : null,
                        source      : source || '',
                        origin      : infos.bundle,
                        connector   : 'sqlite'
                    };
                    _queryEntry._startMs = Date.now();
                    _devLog.push(_queryEntry);
                }
            }

            // ── Option B — native Promise with .onComplete() shim ─────────────
            //
            // Mirrors the Couchbase N1QL Option-B pattern (connector/index.js).
            // setTimeout(0) gives callers time to attach .onComplete() or await
            // before the synchronous DatabaseSync call fires.
            // ─────────────────────────────────────────────────────────────────
            if (_mainCallback === null) {
                var _resolve, _reject, _internalData;

                var _promise = new Promise(function(resolve, reject) {
                    _resolve = resolve;
                    _reject  = reject;
                });

                // Backward-compatible .onComplete(cb) shim — chains on the Promise.
                _promise.onComplete = function(cb) {
                    _promise.then(
                        function()    { cb(null, _internalData); },
                        function(err) { cb(err); }
                    );
                    return _promise;
                };

                setTimeout(function() {
                    try {
                        var result = execute(args);
                        if (_queryEntry) {
                            _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                            // _startMs is kept for the Flow tab timeline (#FI)
                            _queryEntry.resultCount = result ? (Array.isArray(result) ? result.length : 1) : 0;
                            try { _queryEntry.resultSize = result ? JSON.stringify(result).length : 0; } catch(_e) { _queryEntry.resultSize = 0; }
                        }
                        _internalData = result;
                        _resolve(result);
                    } catch (e) {
                        if (_queryEntry) {
                            _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                            _queryEntry.error = e.message || String(e);
                        }
                        e.message = '[ ' + source + ' ]\n' + e.message;
                        _reject(e);
                    }
                }, 0);

                return _promise;

            } else {
                // Direct callback path (util.promisify or explicit callback)
                try {
                    var result = execute(args);
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                        _queryEntry.resultCount = result ? (Array.isArray(result) ? result.length : 1) : 0;
                        try { _queryEntry.resultSize = result ? JSON.stringify(result).length : 0; } catch(_e) { _queryEntry.resultSize = 0; }
                    }
                    _mainCallback(null, result);
                } catch (e) {
                    if (_queryEntry) {
                        _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                        _queryEntry.error = e.message || String(e);
                    }
                    e.message = '[ ' + source + ' ]\n' + e.message;
                    _mainCallback(e);
                }
            }
        };
    };


    return init(conn, infos);
}

module.exports = Sqlite;
