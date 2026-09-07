"use strict";
// Imports.
var fs              = require('fs');
var sqlParser       = require('./../sql-parser'); // #SQL1 state-machine comment stripper
var paramRedact     = require('./../param-redact'); // #B350 — bound-value redaction for dev/Inspector sinks
// CB-LOW-3 fix: removed dead `const { version } = require('os')` — `version` was never referenced.
// Use couchbase module from the user's project dependencies if not found
var couchbasePath   = _(getPath('project') +'/node_modules/couchbase');
var couchbase       = require(couchbasePath);
// globalized
// N1qlQuery           = couchbase.N1qlQuery;

var lib             = require('./../../../lib') || require.cache[require.resolve('./../../../lib')];
var inherits        = lib.inherits;
var merge           = lib.merge;
var console         = lib.logger;

/**
 * Couchbase Class
 *
 * @package     Connectors.Couchbase
 * @author      Rhinostone
 */

function Couchbase(conn, infos) {
    var EntitySuperClass    = null, EntityN1qlClass = null;
    var envIsDev            = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) ) ? true : false;
    var scopeIsLocal        = ( /^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL) ) ? true : false;
    var scopeIsProduction   = ( /^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION) ) ? true : false;

    /**
     * Walk a Couchbase N1QL query plan tree and extract index names.
     * Accepts either a `meta.profile` object (with `executionTimings`) or
     * a bare EXPLAIN plan object (the first row of an EXPLAIN result).
     *
     * Detects three operator types:
     * - `IndexScan3` — secondary index access (green badge)
     * - `PrimaryScan3` — primary index scan (amber badge)
     * - `ExpressionScan` / `KeyScan` — USE KEYS direct KV lookup (green badge,
     *   reported as "KV lookup (USE KEYS)")
     *
     * Recursion covers the four child containers plans actually use: `~child`,
     * `~children`, plus (#B193) the nested-scan containers `scans`
     * (IntersectScan / UnionScan / OrderedIntersectScan) and `scan`
     * (DistinctScan) — so a plan the planner serves with MULTIPLE indexes
     * reports all of them instead of reading as "no index".
     *
     * @inner
     * @param {object} profile - The plan object (meta.profile or EXPLAIN row)
     * @returns {Array<{name: string, primary: boolean}>|null} Array of index descriptors,
     *          empty array if no indexes found in the plan, or null if profile is unavailable
     */
    var extractIndexes = function(profile) {
        if (!profile || typeof(profile) !== 'object') return null;
        var root = profile.executionTimings || profile;
        if (!root || typeof(root) !== 'object') return null;

        var results = [];
        var seen = {};
        var walk = function(node) {
            if (!node || typeof(node) !== 'object') return;
            var op = node['#operator'];
            if (op) {
                // IndexScan3 / PrimaryScan3 — standard index access
                if (typeof(node.index) === 'string' && !seen[node.index]) {
                    seen[node.index] = true;
                    results.push({
                        name    : node.index,
                        primary : /Primary/i.test(op)
                    });
                }
                // ExpressionScan / KeyScan — USE KEYS direct KV lookup (no index needed)
                if (/ExpressionScan|KeyScan/i.test(op) && !seen['__kv_lookup']) {
                    seen['__kv_lookup'] = true;
                    results.push({
                        name    : 'KV lookup (USE KEYS)',
                        primary : false
                    });
                }
            }
            if (node['~child'])    walk(node['~child']);
            if (node['~children'] && Array.isArray(node['~children'])) {
                for (var i = 0; i < node['~children'].length; i++) {
                    walk(node['~children'][i]);
                }
            }
            // #B193 — the multi-index operators nest their child scans under
            // `scans` (IntersectScan / UnionScan / OrderedIntersectScan) or
            // `scan` (DistinctScan), NOT ~child/~children. Unwalked, every
            // multi-index plan returned [] and the Inspector rendered it as
            // "no index — full bucket scan" — a false negative that invites a
            // pointless (write-amplifying) index build for a query the planner
            // was already serving with several indexes. seen[] above already
            // dedupes an index appearing in more than one child scan.
            if (node['scan'])  walk(node['scan']);
            if (node['scans'] && Array.isArray(node['scans'])) {
                for (var j = 0; j < node['scans'].length; j++) {
                    walk(node['scans'][j]);
                }
            }
        };
        walk(root);
        return results;
    };

    /**
     * Per-statement EXPLAIN cache for dev-mode index extraction.
     * Keyed by the N1QL statement string. Each entry holds the
     * extracted indexes array (or null on EXPLAIN failure).
     * Populated lazily — first query triggers the EXPLAIN, subsequent
     * queries with the same statement reuse the cached result.
     * @type {Map<string, Array<{name: string, primary: boolean}>|null>}
     * @private
     */
    var _explainCache = new Map();

    /**
     * Resolve the underlying Couchbase SDK Cluster handle from a connection
     * object, tolerating both shapes the connector produces:
     *   - entity query path: the cluster sits directly at `conn._cluster`
     *   - bulk-insert / scope-collection path: `conn` is scope-shaped and the
     *     cluster is nested at `conn._scope._bucket._cluster`
     *
     * Single source of truth for cluster resolution — `explainForIndexes`,
     * `bulkInsert` and the public `getCluster()` accessor all consume it, so the
     * dual-shape lookup lives in exactly one place.
     *
     * @param {object} conn - A Couchbase connection object (bucket- or scope-shaped).
     * @returns {object} The SDK Cluster (guaranteed to expose a `query()` method).
     * @throws {Error} `GINA_COUCHBASE_CLUSTER_UNRESOLVED` when neither shape yields a usable cluster.
     * @private
     */
    var resolveCluster = function(conn) {
        var cluster = (conn && conn._cluster)
            ? conn._cluster
            : (conn && conn._scope && conn._scope._bucket && conn._scope._bucket._cluster)
                ? conn._scope._bucket._cluster
                : null;

        if (!cluster || typeof(cluster.query) !== 'function') {
            var _err = new Error('[ CONNECTOR ][ couchbase ] Unable to resolve the SDK Cluster from the connection — '
                + 'neither `conn._cluster` nor `conn._scope._bucket._cluster` exposes a query() method. '
                + 'The connection shape may have changed across an SDK or framework upgrade.');
            _err.code = 'GINA_COUCHBASE_CLUSTER_UNRESOLVED';
            throw _err;
        }

        return cluster;
    };

    /**
     * #B243 — guards the assembled N1QL parameter list against values the
     * Couchbase SDK cannot serialize. This defends against a PROCESS ABORT,
     * not a normal validation failure.
     *
     * The SDK maps `JSON.stringify` over the parameter list. For a `function`,
     * a `symbol`, or an `undefined`, `JSON.stringify` returns the VALUE
     * `undefined` rather than a string; the native binding coerces that to the
     * empty string, and the C++ core's JSON parse of `""` throws
     * `tao::pegtl::parse_error` on an internal thread, reaching
     * `std::terminate()` and then `abort()`. That kills the whole bundle — no
     * `try/catch`, `uncaughtException` or `unhandledRejection` can intercept
     * it, so the request cannot even fail with a 500. Measured against a live
     * cluster on SDK 4.1.3 and 4.7.1 (4.2.0+ maps a bare `undefined` to null,
     * but still aborts on functions and symbols).
     *
     * Reachable WITHOUT any misuse of the SDK: the cursor-style assembly branch
     * fills `queryParams[i]` for every `i < params.length` while guarding only
     * `undefined`, so a caller that under-supplies one argument AND passes a
     * trailing callback puts the CALLBACK itself into a parameter slot. The
     * arity check at the top of the query method cannot catch that shape — it
     * only fires when the LAST argument is not a function.
     *
     * Scope: `typeof` covers every value `JSON.stringify` renders as
     * `undefined` EXCEPT an object whose own `toJSON()` returns undefined,
     * which is left unguarded deliberately — detecting it would cost a full
     * `JSON.stringify` per parameter on every query, and no realistic call site
     * produces it.
     *
     * @param {Array|object} queryParams - Assembled parameter list: a positional array, or a named map.
     * @param {string} entityName - Entity the query belongs to (message only).
     * @param {string} name - Query method name (message only).
     * @param {string} source - Path of the backing `.sql` file (message only).
     * @param {Array} [params] - Declared placeholders, used for the arity hint.
     * @returns {TypeError|null} A ready-to-surface error, or `null` when every parameter is serializable.
     * @private
     *
     * @example
     * var err = getUnserializableParamError(['a', undefined], 'invoice', 'getByRef', src, ['$1','$2']);
     * if (err) { return cb(err); } // never reaches the SDK, so the process survives
     */
    var getUnserializableParamError = function(queryParams, entityName, name, source, params) {
        if ( !queryParams || typeof(queryParams) != 'object' ) {
            return null;
        }

        var isPositional = Array.isArray(queryParams)
            , keys        = isPositional ? null : Object.keys(queryParams)
            , len         = isPositional ? queryParams.length : keys.length
            , declared    = ( params && params.length ) ? params.length : 0
        ;

        for (var i = 0; i < len; ++i) {
            var key  = isPositional ? i : keys[i]
                , type = typeof(queryParams[key])
            ;

            if ( type != 'undefined' && type != 'function' && type != 'symbol' ) {
                continue;
            }

            var label = isPositional ? ('$' + (i + 1)) : ('$' + key);
            var hint  = ( type == 'function' )
                ? 'A callback landed in a parameter slot: the query declares ' + declared
                    + ' parameter(s), so every one of them must be passed BEFORE the callback.'
                : 'Pass `null` for an intentionally empty parameter — `null` serializes correctly.';

            var _err = new TypeError('[N1QL][ ' + entityName + '#' + name + '() ] parameter ' + label
                + ' is a `' + type + '`, which the Couchbase SDK cannot serialize: dispatching it would '
                + 'abort the process instead of raising an error. ' + hint
                + ' Please refer to [ ' + source + ' ]');
            _err.code = 'GINA_COUCHBASE_UNSERIALIZABLE_PARAM';
            return _err;
        }

        return null;
    };

    /**
     * Runs EXPLAIN on a N1QL statement asynchronously and caches the
     * extracted indexes. Patches `queryEntry.indexes` in-place once
     * the EXPLAIN result is available.
     *
     * @param {object} conn - The Couchbase connection object. May have `_cluster`
     *   directly (entity query path) or nested at `_scope._bucket._cluster` (bulk insert path).
     * @param {string} statement - The original N1QL statement (without EXPLAIN prefix)
     * @param {object} queryEntry - The QI entry to patch with index info
     * @param {object} queryOptions - Query options (for parameters)
     * @private
     */
    var explainForIndexes = function(conn, statement, queryEntry, queryOptions) {
        // #QI is fire-and-forget instrumentation — resolve the cluster via the
        // shared helper but keep this path non-fatal (warn + skip) so a
        // resolution failure never breaks the actual query.
        var cluster;
        try {
            cluster = resolveCluster(conn);
        } catch (_clusterErr) {
            console.warn('[explainForIndexes] Cannot resolve cluster from conn — skipping EXPLAIN for: ' + statement.substring(0, 80));
            return;
        }

        // Mark as pending so we don't fire multiple EXPLAINs for the same statement
        _explainCache.set(statement, null);

        var explainOpts = {
            adhoc: true,
            parameters: queryOptions.parameters || []
        };

        try {
            cluster.query('EXPLAIN ' + statement, explainOpts)
                .then(function(data) {
                    var plan = (data && data.rows && data.rows[0]) ? data.rows[0].plan || data.rows[0] : null;
                    var indexes = extractIndexes(plan);
                    _explainCache.set(statement, indexes);
                    // Patch the current query entry in-place (it's already in _devLog)
                    queryEntry.indexes = indexes;
                })
                .catch(function() {
                    // EXPLAIN failed — leave indexes as null (N/A badge)
                    _explainCache.set(statement, null);
                });
        } catch (_explainErr) {
            console.warn('[explainForIndexes] ' + _explainErr.message);
            _explainCache.set(statement, null);
        }
    };

    /**
     * Init
     * @constructor
     * */
    var init = function(conn, infos) {
        // load on startup
        var isCacheless         = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;
        var path                = getPath('bundle') + '/models/'+ infos.database +'/entities'
            , n1qlDefault       = __dirname + '/lib'
            , files             = fs.readdirSync(path)
            , entities          = {}
            , entityName        = ''
            , Entity            = null
            , className         = null
            , filename          = null
        ;


        // superEntity
        filename = getPath('gina').core + '/model/entity.js';
        if (isCacheless)
            delete require.cache[require.resolve(_(filename, true))]; //EntitySuperClass

        EntitySuperClass = require(_(filename, true));


        // first one for the N1QL queries without entity ( check `/lib/n1ql.js` )
        files.unshift('n1ql.js');
        for (var f = 0, len = files.length; f < len; ++f) {

            if ( ! /^\./.test(files[f]) || f == len-1 ) {

                if (isCacheless && files[f] != 'n1ql.js') {
                    delete require.cache[require.resolve(_(path + '/' +files[f], true))];//child
                }

                entityName      = files[f].replace(/.js/, '');
                className       = entityName.substring(0,1).toUpperCase() + entityName.substring(1);

                if ( files[f] == 'n1ql.js' ) {
                    Entity = require(_(n1qlDefault + '/' +files[f], true));
                    EntityN1qlClass = Entity
                } else {
                    Entity = require(_(path + '/' +files[f], true));

                    // Skip helper/utility modules that export objects, not constructors.
                    // Only constructor functions (entity classes) should be wrapped with inherits.
                    if ( typeof(Entity) !== 'function' ) {
                        continue;
                    }

                    Entity = inherits(Entity, EntitySuperClass);

                    Entity.prototype.name           = className;
                    Entity.prototype.model          = infos.model;
                    Entity.prototype.bundle         = infos.bundle;
                    Entity.prototype.database       = infos.database;
                    Entity.prototype._collection    = entityName;
                    Entity.prototype._scope         = infos.scope || process.env.NODE_SCOPE;
                    Entity.prototype._filename      = _(path + '/' +files[f], true);

                    // extra CRUD methods
                    Entity.prototype.bulkInsert     = bulkInsert;
                    // public SDK Cluster accessor — supported entry point for
                    // SDK-level features (e.g. transactions) the entity layer
                    // does not wrap; see resolveCluster()/getCluster().
                    Entity.prototype.getCluster     = getCluster;


                    entities[className] = Entity
                }
            }
        }


        // loading N1QL
        var dir = _( getPath('bundle') + '/models/'+ infos.database +'/n1ql' );
        if ( fs.existsSync(dir) ) {
            f           = 0;
            files       = fs.readdirSync(dir);
            filename    = null;
            len         = files.length;


            for (; f<files.length; ++f) {
                // skip hidden
                if ( /^\./.test(files[f]) ) {
                    continue;
                }

                filename    = _(dir +'/'+ files[f]);
                loadN1QL(entities, filename)
            }
        }

        return entities
    };


    var loadN1QL = function(entities, filename, originalInfos) {
        var arr = null
            , entityName = null
        ;
        // n1ql/<entityName>/
        if ( fs.statSync(filename).isDirectory() ) {
            var files           = fs.readdirSync(filename)
                , f             = 0
            ;
            arr         = filename.split(/\//g);
            entityName  = arr[arr.length-1];
            entityName  = entityName.charAt(0).toUpperCase() + entityName.slice(1);
            if ( typeof(originalInfos) != 'undefined' ) {
                entityName  = originalInfos.entityName;
            }
            // n1ql/<entityName>/<method>
            for (; f < files.length; ++f) {
                // skip hidden
                if ( /^\./.test(files[f]) ) {
                    continue;
                }

                let methodFilename = _(filename + '/' + files[f], true);
                // will ignore <sub folder> excepted when `<sub folder>/_main.sql` is found
                if ( fs.statSync(methodFilename).isDirectory() ) {
                    // skip empty
                    if (fs.readdirSync(methodFilename).length === 0) {
                        continue;
                    }

                    // _main.sql case
                    let altFilenameObj = new _(methodFilename + '/_main.sql', true);
                    if (altFilenameObj.existsSync()) {
                        let arr             = methodFilename.split(/\//g);
                        let altMethodName   =  arr[arr.length-1].replace(/\.sql/, '') || null;
                        readSource(entities, entityName, altFilenameObj.toString(), altMethodName);
                        continue;
                    }
                    // TODO - See if <sub folder>For/<anything> is possible
                    // loadN1QL(entities, methodFilename, {entityName: entityName});
                    continue;
                }


                // ignoring filename starting with . & sub folders
                if (
                    /^\./.test(files[f])
                    ||
                    !/\.sql$/i.test(files[f])
                ) {
                    continue;
                }
                readSource(entities, entityName, methodFilename)
            }

            return;
        }

        arr         = filename.split(/\//g);
        entityName  = arr[arr.length-1].replace(/\.sql/, '').split(/\_/)[0];
        entityName  = entityName.charAt(0).toUpperCase() + entityName.slice(1);
        if ( typeof(originalInfos) != 'undefined' ) {
            entityName  = originalInfos.entityName;
        }

        readSource(entities, entityName, filename);
    }

    var readSource = function (entities, entityName, source, altMethodName) {
        var arr             = source.split(/\//g)
            , name          = altMethodName || arr[arr.length-1].replace(/\.sql/, '') || null
            , optionsArr    = null
            , options       = null
            , queryString   = null
            , includes      = null
            , queryStatement= null // this is the usable queryString
            , params        = []
            , paramTypes    = []
            , inlineParams  = [] // order of use inside the query
            , returnType    = null // Array or Object : Array by default
        ;


        if (! /^\./.test(source) && name && typeof(conn[name]) == 'undefined' ) {
            // N.B: because of the cache, if replacement of placeholders is done, it will affect the statement
            queryString = fs.readFileSync( source ).toString();
            // handle includes
            includes = queryString.match(/\@include(.*)\;/g) || null;
            if ( includes && includes.length > 0 ) {
                for (let i = 0, len = includes.length; i < len; i++) {
                    let filename = includes[i].replace(/\"|\'|\;|(\@include\s+|\@include)/g, '');
                    if (
                        /^\./.test(filename)
                        ||
                        // windows style location
                        /^[a-z]:(\\|\/\/)/i.test(filename)
                        ||
                        // not unix absolut
                        !/^\//.test(filename)
                        && !/^[a-z]:(\\|\/\/)/i.test(filename)

                    ) {
                        let dir = new _(source).toUnixStyle();
                        dir = dir.substring(0, dir.lastIndexOf('/')) + '/'
                        filename = _(dir + filename.replace(/^\.\//, ''), true);
                    }
                    // remove @include calls
                    //console.debug('including .....'+ filename);
                    queryString = queryString.replace(includes[i], fs.readFileSync( filename ).toString() );
                }
            }

            optionsArr = queryString.match(/\@options \{(.*)\}/gm);
            if (optionsArr) {
                // CB-QUAL-2 fix: replaced eval() with JSON.parse() for @options parsing.
                // @options uses JavaScript object literal syntax with unquoted keys
                // (e.g. { consistency: "request_plus" }) — not strict JSON.
                // We normalise unquoted property names to quoted form before parsing so
                // JSON.parse() can handle them. Parse errors now surface explicitly
                // instead of silently corrupting the `options` variable in scope.
                // Original broken implementation:
                // eval('options='+optionsArr[0].replace(/\@options\ /, ''));
                try {
                    var _rawOpts = optionsArr[0].replace(/\@options\s+/, '');
                    // Quote any bare identifier keys: { foo: → { "foo":
                    var _jsonOpts = _rawOpts.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, '$1"$2"$3');
                    options = JSON.parse(_jsonOpts);
                } catch (parseErr) {
                    console.warn('[CONNECTOR] @options parse error in .sql file: ' + parseErr.message);
                }
            } else if ( /\@options/.test(queryString) ) {
                // #B155 — the file SAYS `@options` but the annotation regex above matched
                // nothing, so the whole annotation is a silent no-op. The regex demands
                // `@options { … }` (single space, braces) — the historical docs taught a
                // brace-less `key=value` form, and a double space before the brace misses
                // too. Warn with the exact expected shape. (A prose mention of `@options`
                // inside a comment also lands here — accepted: a spurious warn is cheaper
                // than a silently-dead annotation.)
                console.warn('[CONNECTOR] found `@options` but could not parse a brace-delimited object — '
                    + 'annotation ignored. Write it as: @options { consistency: "request_plus" }\n'
                    + 'Found on: ' + queryString.substring(0, 80));
            }
            optionsArr = null;

            // #B413 — `[^}]+` on both expressions, and normalise like the return type
            // below. Greedy `(.*)` over-captured a second brace pair on the same line
            // (`@param {a} and {b}` yielded `a} and {b`), and the extracted type feeds an
            // exact-match `switch` in cast() whose arms are all lowercase — so both an
            // over-captured and a capitalised type (`{Number}`) match no arm and the
            // parameter is SILENTLY left uncast rather than erroring.
            paramTypes = queryString.match(/\@param \{([^}]+)\}/gm);
            if ( paramTypes && Array.isArray(paramTypes) ) {
                for (let t=0, tLen = paramTypes.length; t<tLen; t++) {
                    paramTypes[t] = paramTypes[t].match(/\{([^}]+)\}/)[1].trim().toLowerCase();
                }
            }
            // extract return type (before stripping — annotation lives in the comment block)
            // #B412 — `[^}]+`, not `(.*)`: the greedy form over-captures when a second
            // `{...}` appears later on the SAME line (`@return {object} note {x}` yielded
            // `object} note {x`), producing an unknown returnType that falls through every
            // branch and hands the caller the raw row array instead of the declared shape.
            // Same expression the mysql / postgresql / scylladb / sqlite connectors use.
            returnType = queryString.match(/@return\s+\{([^}]+)\}/);
            if ( Array.isArray(returnType) ) {
                // #B413 — normalise like mysql / postgresql / scylladb / sqlite, all of
                // which do `retMatch[1].trim().toLowerCase()`. Without it every branch
                // below compares against a lowercase literal, so `{Number}`, `{ number }`
                // and `{NUMBER}` fall through ALL of them and the caller silently receives
                // the raw row array instead of the declared shape. Measured: zero incidence
                // in a 486-declaration consumer corpus — but that is convention, not
                // protection, and nothing stops an author writing it.
                returnType = returnType[1].trim().toLowerCase();
            }

            // #SQL1 — extract $param names from the first block comment using state-machine
            // parser (handles nested /* */ and -- / // inside string literals correctly)
            var _firstComment = sqlParser.extractFirstBlockComment(queryString);
            if (_firstComment) {
                params = _firstComment.match(/\$\w+/g); // param list from comment
            }

            // #SQL1 — strip all comments and collapse whitespace
            queryString = sqlParser.stripComments(queryString).replace(/\s+/g, ' ').trim();

            inlineParams    = queryString.match(/\$\w+/g);

            // getting rid of duplicated
            if ( typeof(Set) == 'function' ) { // ES6
                inlineParams = Array.from(new Set(inlineParams))
            } else { // ES5 + gina
                inlineParams = Array.from(inlineParams)
            }

            var cast = function(dataArray, paramTypes) {
                for (let t=0, tLen=paramTypes.length; t<tLen; t++) {
                    switch (paramTypes[t]) {
                        case 'number':
                        case 'integer':
                            dataArray[t] = parseInt(dataArray[t]);
                            break;

                        case 'float':
                            dataArray[t] = parseFloat(dataArray[t].replace(/\,/, '.'));
                            break;

                        case 'string':
                            dataArray[t] = ''+dataArray[t];
                            break;

                        // default:
                        //     break;
                    }
                }
            }

            try {

                if ( typeof(entities[entityName]) == 'undefined' ) {

                    entities[entityName] = inherits(EntityN1qlClass, EntitySuperClass);

                    entities[entityName].prototype.name           = entityName.substring(0,1).toUpperCase() + entityName.substring(1);
                    entities[entityName].prototype.model          = infos.model;
                    entities[entityName].prototype.bundle         = infos.bundle;
                    entities[entityName].prototype._collection    = entityName;
                    entities[entityName].prototype._scope         = infos.scope || process.env.NODE_SCOPE;
                    entities[entityName].prototype._filename      = _( __dirname + '/lib/n1ql.js', true );
                    // public SDK Cluster accessor — parity with model entities so a
                    // consumer never hits an asymmetric `undefined` (see getCluster()).
                    entities[entityName].prototype.getCluster     = getCluster;
                }

                // #B174: the attach below is deliberately UNCONDITIONAL — a colliding
                // name overwrites/shadows the existing member (the documented exception
                // to the six-connector skip guard, see #B173). Warn when that collision
                // clobbers machinery: an own member (a stamped entity property like
                // `name`/`getCluster`, or a previously attached query method) or an
                // inherited member NOT on `Object.prototype` (the EventEmitter API —
                // an `on.sql` file breaks event wiring for this entity). Shadowing
                // gina's `Object.prototype` helpers (`count()`/`functionCount()`) is
                // the desired outcome and stays silent. Warn only — never skip.
                if (typeof entities[entityName].prototype[name] !== 'undefined') {
                    var _isOwnMember = Object.prototype.hasOwnProperty.call(entities[entityName].prototype, name);
                    if ( _isOwnMember || !Object.prototype.hasOwnProperty.call(Object.prototype, name) ) {
                        console.warn('[couchbase] query method \'' + name + '\' (' + source + ') on the ' + entityName + ' entity ' + (_isOwnMember ? 'overwrites an existing own member (a stamped entity property or a previously attached query method)' : 'shadows an inherited member on the prototype chain (e.g. the EventEmitter API)') + ' — the query file WINS and the original member becomes unreachable on this entity. Rename the file, e.g. \'' + name + 'Rows.sql\'.');
                    }
                }

                entities[entityName].prototype[name] = function() {
                    // #B11 fix: recover the entity singleton when called via util.promisify
                    // without .bind(). In strict mode `this` is undefined when a prototype
                    // method is detached from its object. Fall back to the singleton stored
                    // at EntitySuperClass[CapitalizedName].instance (set by entity.js:427).
                    // This makes `util.promisify(entity.method)` work transparently without
                    // requiring callers to add .bind(entity) everywhere.
                    var _capitalizedName = entityName.substring(0,1).toUpperCase() + entityName.substring(1);
                    var self = this || (EntitySuperClass[_capitalizedName] && EntitySuperClass[_capitalizedName].instance) || null;
                    var key     = null
                        , index = null
                        , i     = null
                        , len   = null
                        , args  = Array.prototype.slice.call(arguments)
                        , _mainCallback = null;

                    if (!self) {
                        var _ctxErr = new TypeError('[entity] ' + entityName + '#' + name + '() called without context: `this` is undefined and no singleton found at EntitySuperClass[' + _capitalizedName + '].instance');
                        var _cbArg = (args.length > 0 && typeof args[args.length - 1] === 'function') ? args[args.length - 1] : null;
                        if (_cbArg) { return _cbArg(_ctxErr); }
                        throw _ctxErr;
                    }

                    if ( params && params.length != args.length && !/function/.test(typeof(args[args.length-1])) ) {
                        throw new Error('[N1QL][ ' + entityName+'#'+name+'() ] arguments must match parameters length. Please refer to [ '+ source +' ]\nFound in param list: ('+ params.join(', ') +') !')
                    } else if ( /function/.test( typeof(args[args.length-1]) ) ) {
                        // to hande Nodejs Util.promisify
                        _mainCallback = args[args.length-1]
                    }

                    if ( paramTypes && paramTypes.length > 0 ) {
                        cast(args, paramTypes)
                    }

                    var sdkVersion = conn.sdk.version || 3;
                    var queryParams = [];
                    // #sql-dev-nocache: in dev mode re-read the .sql file from disk on
                    // every call so edits are picked up without restarting the server.
                    // Mirrors the controller cacheless-require pattern.
                    // Fixed: also re-expand @include directives — the original code re-read the
                    // raw source without expanding includes, sending @include tokens to Couchbase.
                    if (envIsDev) {
                        try {
                            var _devSrc      = fs.readFileSync(source).toString();
                            var _devIncludes = _devSrc.match(/\@include(.*)\;/g) || null;
                            if (_devIncludes && _devIncludes.length > 0) {
                                for (var _di = 0, _dLen = _devIncludes.length; _di < _dLen; _di++) {
                                    var _devFilename = _devIncludes[_di].replace(/\"|\'|\;|(\@include\s+|\@include)/g, '');
                                    if (
                                        /^\./.test(_devFilename)
                                        ||
                                        /^[a-z]:(\\|\/\/)/i.test(_devFilename)
                                        ||
                                        !/^\//.test(_devFilename)
                                        && !/^[a-z]:(\\|\/\/)/i.test(_devFilename)
                                    ) {
                                        var _devDir = new _(source).toUnixStyle();
                                        _devDir = _devDir.substring(0, _devDir.lastIndexOf('/')) + '/';
                                        _devFilename = _(_devDir + _devFilename.replace(/^\.\//, ''), true);
                                    }
                                    _devSrc = _devSrc.replace(_devIncludes[_di], fs.readFileSync(_devFilename).toString());
                                }
                            }
                            _devSrc = _devSrc.replace(/\n/g, ' ');
                            var _devCmts = _devSrc.match(/(\/\*([^*]|[\r\n]|(\*+([^*\/]|[\r\n])))*\*+\/)|(\/\/.*)/g);
                            queryString  = (_devCmts ? _devSrc.replace(_devCmts[0], '') : _devSrc).trim();
                        } catch (_e) { /* keep cached queryString on read error */ }
                    }
                    queryStatement = queryString.slice(0);
                    if (params) {
                        // BO - patch prepared statement case when placeholder is used as a cursor
                        var p                       = []
                            // cloning queryString
                            , qStr                  = queryString.slice(0)
                            , inl                   = inlineParams.slice()
                            , re                    = null
                            , foundSpecialLeftCase  = /\w+\.(\$|\%)/.test(qStr)
                            // rightCase already handled by default
                            //, foundSpecialRightCase = /(\$|\%)\d+\.\w+/.test(qStr)
                        ;

                        // e.g.: doc.counters.$2 = $3
                        // e.g.: doc.flags.$1 = true
                        if (foundSpecialLeftCase) {
                            i = 0; len = args.length;
                            for (; i < len; ++i) {
                                key = inl.indexOf(params[i]);
                                if (key > -1) {
                                    p[key] = args[key];

                                    // Fixed: a $N used as a dynamic field-path key must be substituted at
                                    // EVERY occurrence, not just the last. The previous gate + replace both
                                    // used a greedy `(.*)\.$N` with no /g flag: the greedy prefix bound to
                                    // the LAST `.$N`, so an earlier same-$N field-path (e.g. once in SET and
                                    // once in WHERE) survived as a literal $N -> malformed N1QL; a lower $N
                                    // could also greedily consume a higher `.$NN` ($3 vs $30). The leading
                                    // dot gates this to field-path position, so value params (`= $N`,
                                    // `LIMIT $N`) are untouched and still bind positionally; `(?![0-9])`
                                    // keeps `$3` from matching inside `$30`.
                                    var paramKeyEsc = params[i].replace(/([$%]+)/, '\\$1');
                                    re = new RegExp('\\.'+ paramKeyEsc + '(?![0-9])');
                                    if ( re.test(qStr) ) {
                                        p[key] = args[key];
                                        // global + dollar-safe function replacer: a plain string replacement
                                        // would expand $&/$`/$' inside a dynamic field-key value.
                                        qStr = qStr.replace(new RegExp('\\.'+ paramKeyEsc + '(?![0-9])', 'g'), function () { return '.' + args[i]; });
                                        inl.splice(key, 1);
                                    }
                                }
                            }


                            if ( sdkVersion == 3 ) { // SDK v3 ONLY
                                queryParams = {};
                                index = 0; i = 0; len = inlineParams.length;
                                var matched = null;
                                for (; i < len; ++i) {
                                    //matched = params.indexOf( inlineParams[i] );
                                    matched = params.indexOf( inl[i] );
                                    if ( matched > -1 && typeof(p[matched]) != 'undefined' )  {
                                        // e.g.: queryParams[ $3 ] = 1
                                        // queryParams[ inl[i] ] = p[matched];
                                        // qStr = qStr.replace( new RegExp('\\'+ inl[i], 'g'), '"' + p[matched] + '"')
                                    }
                                }
                            } else { // SDK v4+ (v3 handled in the branch above)

                                // April 2023 patch - Replaced p[i] by args[i]
                                index = 0; i = 0; len = params.length;
                                for (; i < len; ++i) {
                                    if ( typeof(args[i]) != 'undefined' )  {
                                        queryParams[i] = args[i];
                                    } else { // means that placeholder has been replaced
                                        // But we still need to keep the reference in the list
                                        queryParams[i] = null
                                    }
                                }
                            }

                            queryStatement = qStr;

                        }

                        // e.g.: c.id = $1.id
                        // if (foundSpecialRightCase) {
                        //     console.debug('foundSpecialRightCase...')
                        // }

                        // normal case
                        if (
                            !foundSpecialLeftCase
                            || Array.isArray(queryParams) && queryParams.length == 0
                        ) {
                            queryParams = JSON.clone(args);
                            // starting from SDK v3
                            if ( typeof(queryParams[queryParams.length-1]) == 'function' ) {
                                queryParams.splice(queryParams.length-1, 1)
                            }
                        }
                        // EO - patch
                    }
                    queryStatement = queryStatement.replace(/^\s+/, '');

                    var query           = null
                        , execQuery     = null
                        , _collection   = null
                    ;
                    // adhoc option: @param {boolean} options.adhoc [ true | false ]
                    // default is set to false
                    //queryOptions.adhoc = false;

                    // scan consistency level: @param {number} options.consistency [ 1 | 2 | 3 ]
                    // Default is set to 1
                    //
                    // Default
                    //  code        : NOT_BOUNDED
                    //  number      : 1
                    //  description : This is the default (for single-statement requests).
                    //
                    // Request plus (Recommended for insert,read right after)
                    //  code        : REQUEST_PLUS
                    //  number      : 2
                    //  description : This implements strong consistency per request.
                    //                Update cycle every «20ms for memdb & 200ms for forestdb»
                    //
                    // Statement plus (Not available on SDKv4)
                    //  code        : STATEMENT_PLUS or AT_PLUS
                    //  number      : 3
                    //  description : This implements strong consistency per statement.
                    //                Update cycle every «20ms for memdb & 200ms for forestdb»
                    //
                    //
                    // For more, visit :
                    // - https://blog.couchbase.com/high-performance-consistency/
                    // - https://developer.couchbase.com/documentation/server/current/architecture/querying-data-with-n1ql.html
                    // Query options values by default
                    var queryOptions = {
                        // Do not turn off the adhoc flag for each query since
                        // only a finite number of query plans (currently 5000) can be stored in the SDK
                        // false to use plan optimization, but need a statement `name param` or `num param`
                        adhoc: false
                    };

                    // #QI — enable query profiling in dev mode so extractIndexes() can read meta.profile.
                    // Note: SDK v4 C++ binding does not surface meta.profile — the EXPLAIN
                    // fallback in onQueryCallback handles index extraction instead. The
                    // profile option is kept so that future SDK versions that fix the
                    // binding will work via the fast path without code changes.
                    if (envIsDev) {
                        queryOptions.profile = 'timings';
                    }

                    // NOT_BOUNDED, but REQUEST_PLUS should be set for SELECT operation following an INSERT or an UPDATE
                    // starting from SDK v3
                    var userConsistencyOpt = null;
                    queryOptions.scanConsistency = couchbase.QueryScanConsistency.NotBounded;
                    if (options && typeof(options.consistency) != 'undefined') {
                        // request_plus -> RequestPlus
                        userConsistencyOpt = options.consistency.replace(/(^[a-z]{0,1}|_[a-z]{0,1})/g, str => str.toUpperCase().replace(/\_/, ''));
                        if ( typeof(couchbase.QueryScanConsistency[userConsistencyOpt]) != 'undefined' ) {
                            queryOptions.scanConsistency = couchbase.QueryScanConsistency[userConsistencyOpt];
                        } else {
                            console.warn('couchbase.QueryScanConsistency['+ userConsistencyOpt +'] option is being ignore: might not be a real option or the optoins is not handled by your SDK.\nFound on: '+ queryStatement );
                        }

                        for (let o in options) {
                            if (o == 'consistency') continue;
                            queryOptions[o] = options[o];
                        }
                    } else if ( options && Object.keys(options).length ) {
                        // #B155 — a parsed `@options` with no `consistency` key never reaches
                        // the SDK: the passthrough above is gated on `consistency`, so every
                        // other key is dropped. Warn instead of silently ignoring; the gate
                        // itself stays (un-gating would make historically-inert options
                        // suddenly live for every consumer). An empty `@options {}` drops
                        // nothing and stays quiet.
                        console.warn('[CONNECTOR] @options is missing a `consistency` key — ignoring: '
                            + Object.keys(options).join(', ')
                            + '. Add e.g. "consistency": "not_bounded" alongside them to apply.\nFound on: '+ queryStatement);
                    }


                    // _collection = queryStatement.match(/\_collection(\s+\=|=)(.*)(\'|\")/);
                    // if (_collection.length > 0) {
                    //     _collection = _collection[0];
                    //     if ( /\_collection/.test(_collection) ) {
                    //         _collection = _collection.replace(/\_collection|\W+/ig, '');
                    //     } else {
                    //         _collection = null
                    //     }
                    // }

                    //var scope = conn.scope(conn._name);
                    //var coll = (_collection) ? scope.collection(_collection) :  scope.defaultCollection();
                    //execQuery = conn._cluster.query;
                    execQuery = inherits(conn, conn._cluster.query);

                    query = queryStatement;
                    // Replace $scope placeholder with the connector's resolved scope value.
                    // Uses a string literal (not a positional param) so existing $1, $2…
                    // numbering is preserved and no call-site changes are needed.
                    if ( query.indexOf('$scope') > -1 ) {
                        query = query.replace(/\$scope/g, "'" + (infos.scope || process.env.NODE_SCOPE) + "'");
                    }
                    // #B243 — refuse a parameter the SDK cannot serialize BEFORE dispatch.
                    // This is the single site where `queryOptions.parameters` is assigned,
                    // so both assembly branches above (and any future one) are covered by
                    // this one gate. It has to run here: once the value reaches the SDK the
                    // failure is an uncatchable `abort()`, so there is no downstream
                    // recovery point. Surfacing matches the missing-context precedent at
                    // the top of this method — callback when the caller passed one, throw
                    // otherwise — which turns a bundle-killing crash into an ordinary 500.
                    var _unserializableErr = getUnserializableParamError(queryParams, entityName, name, source, params);
                    if (_unserializableErr) {
                        if (_mainCallback) {
                            return _mainCallback(_unserializableErr);
                        }
                        throw _unserializableErr;
                    }

                    queryOptions.parameters = queryParams;

                    // JUNE 2021 patch
                    // FTS (Full Text Search): N1QL parameters are not interpolated into
                    // SEARCH() predicates by the SDK, so substitute them into the statement manually.
                    // looking for FTS (Full Text Search)
                    var ftsClause = query.match(/(search\(|search\s+\().*\)/i);
                    if (ftsClause && Array.isArray(queryParams) ) {
                        var originalFtsClauses = JSON.clone(ftsClause), _queryParams = null;

                        if ( Array.isArray(queryOptions.parameters) ) {
                            _queryParams = queryOptions.parameters;
                        }

                        for (let s = 0, sLen = ftsClause.length; s < sLen; s++) {
                            if ( !/\)$/.test(ftsClause[s]) ) continue;
                            for (let p = 0, pLen = _queryParams.length; p < pLen; p++) {
                                if ( typeof(_queryParams[p]) == 'function' ) continue;
                                let searchValue = ( /^(true|false)$/i.test(_queryParams[p]) ) ? _queryParams[p] : '"'+_queryParams[p]+'"';
                                ftsClause[s] = ftsClause[s].replace( new RegExp('\\$'+ (p+1),'g'), searchValue)
                            }

                            query = query.replace(originalFtsClauses[s], ftsClause[s]);
                        }

                        originalFtsClauses = null;
                    }
                    ftsClause = null;




                    // trick to set event on the fly
                    var trigger = 'N1QL:'+entityName.toLowerCase()+ '#'+ name;
                    var statement = query;

                    // #QI — dev-mode query instrumentation: push a query entry into the
                    // request-scoped _devQueryLog via AsyncLocalStorage. Timing starts
                    // here; finalized in onQueryCallback. AsyncLocalStorage ensures each
                    // request's async callbacks push to the correct array, even when
                    // concurrent requests interleave.
                    var _queryEntry = null;
                    // #INS10 — capture during a prod instrumentation window too (not just dev mode).
                    if (envIsDev || (process.gina && process.gina._inspectorWindowUntil > Date.now())) {
                        console.debug('[ ' + trigger +' ] '+ statement);
                        //console.debug('[ ' + trigger +' ] options: '+ JSON.stringify(queryOptions, null, 2));
                        if (queryParams.length > 0) {
                            // #B350 — bound values are secrets to the calling app (tokens, key
                            // hashes); this line previously printed them verbatim. A positional
                            // bind array has no key names for the key-based redactor, so the
                            // default is count + types; `inspector.queries.captureValues` opts in.
                            console.debug('[ ' + trigger +' ] Found query params: '+ (paramRedact.captureValues() ? queryParams : paramRedact.describeParams(queryParams)));
                        }

                        var _alsStore = process.gina && process.gina._queryALS ? process.gina._queryALS.getStore() : null;
                        var _devLog = _alsStore ? _alsStore._devQueryLog : null;
                        if (_devLog) {
                            _queryEntry = {
                                type        : 'N1QL',
                                trigger     : entityName.toLowerCase() + '#' + name,
                                statement   : String(statement),
                                params      : queryParams.length > 0 ? (paramRedact.captureValues() ? queryParams.slice() : paramRedact.summarize(queryParams)) : [],
                                durationMs  : 0,
                                resultCount : 0,
                                resultSize  : 0,
                                indexes     : null,
                                error       : null,
                                source      : source || '',
                                origin      : infos.bundle,
                                connector   : 'couchbase'
                            };
                            _queryEntry._startMs = Date.now();
                            _devLog.push(_queryEntry);
                        }
                    }



                    // #B429 — per-call settlement. The completion trigger
                    // ('N1QL:<entity>#<method>') carries NO call identity and `self` is a
                    // process-wide entity singleton, so the shared-emitter rendezvous that
                    // used to settle the Promise/.onComplete() path BROADCAST each result to
                    // every in-flight caller of the same method (measured: two concurrent
                    // callers both received whichever query finished first — on IN-ORDER
                    // completion too, not just out-of-order). Every path now settles through
                    // THIS call's own closure, exactly once; the trigger is emitted purely as
                    // an observability signal (see the end of onQueryCallback).
                    var _delivered = false;
                    /**
                     * Settle THIS call, at most once.
                     *
                     * @inner
                     * @param {Error|boolean} err - the error, or `false` on success.
                     * @param {*} data - rows, or the coerced value for a declared `@return` type.
                     * @param {object} [meta] - the driver's result metadata.
                     * @returns {void}
                     */
                    var _deliver = function(err, data, meta) {
                        if (_delivered) {
                            return;
                        }
                        _delivered = true;
                        if (_mainCallback == null) {
                            return;
                        }
                        try {
                            _mainCallback(err, data, meta);
                        } catch (_cbErr) {
                            // #B430 — the caller's own callback threw. Never re-invoke it with
                            // the same payload (the previous catch did exactly that, running a
                            // throwing callback twice). Surface the throw instead.
                            _cbErr.stack = '[ '+ trigger +' ] callback exception:\n'+ (_cbErr.stack || _cbErr.message);
                            console.error(_cbErr.stack);
                        }
                    };

                    var onQueryCallback = function(err, data, meta) {
                        // #QI — finalize query entry timing and index extraction
                        if (_queryEntry) {
                            _queryEntry.durationMs = Date.now() - _queryEntry._startMs;
                            // _startMs is kept for the Flow tab timeline (#FI)
                            if (err) {
                                _queryEntry.error = err.message || String(err);
                            } else {
                                _queryEntry.resultCount = data ? (Array.isArray(data) ? data.length : 1) : 0;
                                try { _queryEntry.resultSize = data ? JSON.stringify(data).length : 0; } catch(_e) { _queryEntry.resultSize = 0; }
                            }
                            // #QI — extract index usage from query profile or EXPLAIN cache
                            if (meta && meta.profile) {
                                // Fast path: SDK returned profile data (SDK v3 or future fix)
                                _queryEntry.indexes = extractIndexes(meta.profile);
                            } else {
                                // Fallback: SDK C++ binding does not surface meta.profile.
                                // Use cached EXPLAIN result or trigger one asynchronously.
                                var _stmt = _queryEntry.statement;
                                if (_explainCache.has(_stmt)) {
                                    _queryEntry.indexes = _explainCache.get(_stmt);
                                } else {
                                    explainForIndexes(conn, _stmt, _queryEntry, queryOptions);
                                }
                            }
                        }

                        if (!data || data.length == 0) {
                            data = null
                        }

                        if (!err && meta && typeof(meta.errors) != 'undefined' ) {
                            err = new Error('[ '+source+' ]\n'+meta.errors[0].msg);
                            err.status = 403;
                        } else if (err) {
                            err.status  = 500;
                            err.message = '[ '+source+' ]\n'+ err.message;
                            err.stack   = '[ '+source+' ]\n'+ err.stack;
                        }

                        if (err) {
                            lib.connectorError.stamp(err); // #CE1: classify transient vs permanent (one stamp; err flows to every downstream emit/callback)
                            // #B429 — the early `self.emit(trigger, err)` that used to sit here
                            // is REMOVED. It fired the shared trigger BEFORE this call was
                            // settled, so a concurrent caller's listener consumed THIS call's
                            // error (measured: an `await` caller rejected with an explicit-
                            // callback call's error). Settlement and the single observability
                            // emit both happen at the end of onQueryCallback now.
                        }

                        // handle return type
                        if ( returnType && returnType == 'boolean' ) {
                            // CASE #1
                            // SELECT COUNT(a) AS someField <- means that keyword `COUNT(` is found in queryString
                            // [ { someField: 1 }] <- a collection with only one object which has prop: <number>
                            if (
                                /count\(|count\s+\(/i.test(queryString)
                                && Array.isArray(data)
                                && /object/i.test(typeof(data[0]))
                                && Object.keys(data[0]).length == 1
                                && /number/i.test( typeof(data[0][Object.keys(data[0])]) )
                            ) {
                                data = ( data[0][Object.keys(data[0])] > 0 ) ? true : false
                            }
                            // CASE #2
                            // regular query, just counting result
                            else {
                                data = ( typeof(data.length) != 'undefined' && data.length > 0 ) ? true : false
                            }
                        } else if ( returnType && returnType == 'object' ) {

                            data = (data) ? data[0] : data

                        } else if ( returnType && returnType == 'number' && /count\s*\(/i.test(queryString) ) {
                            // #B412 — derive the count from the first projected column instead of
                            // parsing the COUNT alias out of the query text. The former alias regex
                            // (`COUNT\(\S+\)\s+AS\s+(\w+)`) could match NEITHER `COUNT(DISTINCT a.b) AS n`
                            // (`\S+` cannot span the space) NOR an unaliased `COUNT(*)`, and the deref of
                            // the resulting null match was unguarded. Because that throw happened INSIDE
                            // this result callback, a promisified caller never settled: the request hung
                            // with no response and no 5xx, visible only as an uncorrelated log line.
                            // It was also dev-invisible — the dev path strips only the first comment
                            // block, so a commented-out parsable COUNT elsewhere in the file kept the
                            // regex satisfied locally while production (which strips every comment) threw.
                            // Mirrors mysql / postgresql / scylladb / sqlite, none of which use a regex
                            // here. `data[0] !== null` because typeof null === 'object'.
                            if ( Array.isArray(data) && data.length > 0 && typeof(data[0]) == 'object' && data[0] !== null ) {
                                var countKeys = Object.keys(data[0]);
                                data = ( countKeys.length > 0 ) ? data[0][countKeys[0]] : 0;
                            } else {
                                data = 0;
                            }
                        }

                        // #B429 — settle THIS call through its own closure, exactly once.
                        // Both call forms converge here: the explicit trailing callback IS
                        // _mainCallback, and the Promise/.onComplete() path assigns its own
                        // per-call resolver to _mainCallback before dispatching.
                        _deliver(err, data, meta);

                        // #B429 — ONE observability emit per completion, after settlement and
                        // never as the delivery mechanism. This is a documented signal, not
                        // dead code: entity.js's emit override forwards a trigger matching the
                        // `N1QL:*` allow-list to lib/inspector-events (verified live), which is
                        // what the Inspector's event stream renders. It is deliberately outside
                        // _deliver's guard so a listener throwing can never affect settlement.
                        try {
                            if ( typeof(self.emit) != 'undefined' ) {
                                self.emit(trigger, err, data, meta);
                            }
                        } catch (_emitErr) {
                            console.error('[ '+ trigger +' ] listener exception:\n'+ (_emitErr.stack || _emitErr.message));
                        }
                    }; // EO onQueryCallback

                    /**
                     * Dispatch this call's N1QL query and hand every outcome to
                     * `onQueryCallback`, which settles the caller through `_deliver()`.
                     *
                     * Since #B429 there is exactly ONE dispatch path and no settlement
                     * hook: the previous `cb` parameter registered a `self.once(trigger)`
                     * listener on the shared entity singleton, which broadcast each result
                     * to every in-flight caller of the same method.
                     *
                     * @inner
                     * @param {string} trigger - `N1QL:<entity>#<method>`; the REST transport's
                     *   correlation label and the observability event name. NOT a call identity.
                     * @param {object} queryParams - forwarded to `restQuery` when the REST
                     *   transport is enabled (`conn.useRestApi`).
                     * @param {function(*, *, *): void} onQueryCallback - `(err, data, meta)`
                     *   terminal for both branches of the dispatch.
                     * @returns {void}
                     */
                    var register = async function (trigger, queryParams, onQueryCallback) {
                        // // JUNE 2021 patch
                        // // Adding support for FTS since it is not implemented in sdkVersion 2:
                        // // variables not replaced by value
                        // // looking for FTS (Full Text Search)
                        // var ftsClause = query.options.statement.match(/(search\(|search\s+\().*\)/i);
                        // if (ftsClause && Array.isArray(queryParams) ) {
                        //     var originalFtsClauses = JSON.clone(ftsClause);
                        //     for (let s = 0, sLen = ftsClause.length; s < sLen; s++) {
                        //         if ( !/\)$/.test(ftsClause[s]) ) continue;
                        //         for (let p = 0, pLen = queryParams.length; p < pLen; p++) {
                        //             if ( typeof(queryParams[p]) == 'function' ) continue;
                        //             let searchValue = ( /^(true|false)$/i.test(queryParams[p]) ) ? queryParams[p] : '"'+queryParams[p]+'"';
                        //             ftsClause[s] = ftsClause[s].replace( new RegExp('\\$'+ (p+1),'g'), searchValue)
                        //         }
                        //         query.options.statement = query.options.statement.replace(originalFtsClauses[s], ftsClause[s]);
                        //     }
                        //     originalFtsClauses = null;
                        // }
                        // ftsClause = null;


                        // #B429 — ONE dispatch path. `cb` is gone from the signature: it was
                        // always the caller's settlement hook, and settlement no longer happens
                        // here. The explicit trailing callback is already in onQueryCallback's
                        // closure as _mainCallback, and the Promise/.onComplete() path assigns
                        // its own per-call resolver to _mainCallback before calling register().
                        //
                        // The shared-emitter registration this function used to perform is
                        // REMOVED. It read:
                        //
                        //     if ( typeof(self.once) === 'function' && typeof(cb) === 'function' ) {
                        //         self._isRegisteredFromProto = true;
                        //         self.once(trigger, function onComplete(err, data, meta){
                        //             try { cb(err, data, meta) } catch (e) { cb(e) }
                        //         });
                        //         ... byte-identical copy of the dispatch below ...
                        //     }
                        //
                        // The trigger is keyed on entity+method only and `self` is a process-wide
                        // singleton, so ONE completion woke EVERY in-flight caller of that method
                        // and removed their listeners — measured cross-delivery on in-order AND
                        // out-of-order completion, plus an error leaking from one call form into
                        // another. `self._isRegisteredFromProto` is removed with it: it gated only
                        // the second dispatch block and was reset to false at the top of every
                        // invocation, so it never actually starved a query (measured: both
                        // mixed-call-form orders settle correctly), but as a mutable flag on the
                        // shared entity it was a standing hazard with no remaining purpose.

                        if ( /^true$/i.test(conn.useRestApi) ) {
                            conn._cluster.restQuery(trigger, query, queryParams, onQueryCallback);
                            return;
                        }

                        // #B431 — two-argument .then(onResult, onError), NOT .catch(...).then(...).
                        // A .catch() handler that returns normally RESOLVES the promise it
                        // produces, so a trailing .then() ran on EVERY error with `data`
                        // undefined and settled the caller a SECOND time with a bogus empty
                        // success. Measured: one failed query invoked an explicit callback twice
                        // — (Error, null, undefined) then (false, null, {}). The two-argument
                        // form makes the handlers mutually exclusive branches.
                        conn._cluster.query(query, queryOptions)
                            .then(
                                function onResult(data) {
                                    try {
                                        let rows = (data && typeof(data.rows) != 'undefined') ? data.rows : [];
                                        let meta = (data && typeof(data.meta) != 'undefined') ? data.meta : {};
                                        onQueryCallback(false, rows, meta);
                                    } catch (_err) {
                                        _err.stack = '[ ' + trigger + '] onQueryCallbackError: \n\t- Did you leave any bad comments ?\n\t- Did you try to run your query ?\r\n'+ query +'\r\n'+ _err.stack;
                                        console.error(_err.stack);
                                    }
                                },
                                function onError(err) {
                                    // #B153 — guard the N1QL `cause` envelope. A socket-level /
                                    // pre-query failure (node warming up, connection loss) has no
                                    // `cause`; reading err.cause.first_error_message on it threw a
                                    // TypeError that the catch below swallowed, so onQueryCallback
                                    // never fired and the request hung forever. Build a usable error
                                    // on BOTH paths (forwarding the raw error preserves its
                                    // code/errno for downstream classification) and always settle.
                                    //
                                    // #B153 residual — synthesize ONLY when there is envelope text to
                                    // surface. The node binding marshals first_error_code /
                                    // first_error_message onto EVERY query error, so a CLIENT-side SDK
                                    // timeout arrives with a defined-but-EMPTY message; building
                                    // `new Error('')` from it destroyed the typed class name
                                    // (Un/AmbiguousTimeoutError) the classifier matches on, and a
                                    // retryable timeout was reported permanent. Raw-forwarding is
                                    // lossless here: the raw error keeps `.cause`, so even an
                                    // empty-message server envelope still classifies off the code table.
                                    var error;
                                    if ( err && err.cause && typeof(err.cause.first_error_message) != 'undefined' && err.cause.first_error_message !== '' ) {
                                        error = new Error(err.cause.first_error_message);
                                        // #B509 — the envelope carries the failing statement's own RESULT
                                        // ROWS (a RETURNING DML losing a CAS race, a SELECT timing out
                                        // part-way); verbatim on `.stack` and `.cause.http_body` it wrote
                                        // application records into every log that printed the error.
                                        // Redact the rows, keep every diagnostic field, and COPY `cause`
                                        // rather than mutate the SDK's object — the classifier reads only
                                        // `first_error_code` / `retry`, both preserved by the shallow copy.
                                        var _redactedBody = paramRedact.redactResultRows(err.cause.http_body);
                                        error.stack = trigger +'\n'+ _redactedBody;
                                        error.cause = Object.assign({}, err.cause, { http_body: _redactedBody });
                                    } else {
                                        error = (err instanceof Error) ? err : new Error(String(err));
                                    }
                                    try {
                                        onQueryCallback(error);
                                    } catch (_err) {
                                        console.error(_err.stack);
                                    }
                                }
                            );
                    } //EO register

                    // ─────────────────────────────────────────────────────────────
                    // Option B — native Promise return (2026-03-20)
                    //
                    // Why: N1QL methods previously returned a plain _proto object
                    //   { onComplete: fn }. This made them:
                    //   • not directly awaitable — `await entity.method()` resolved
                    //     to the _proto object, not the query result
                    //   • fragile with util.promisify — promisify injects a trailing
                    //     callback, caught here via the _mainCallback detection, but
                    //     losing `this` context made certain methods hang silently
                    //
                    // What changed: when no _mainCallback is present we now return
                    //   a native Promise instead of _proto. The Promise resolves
                    //   with `data` (rows) so `await entity.method(args)` works
                    //   directly — V8 native fast path, zero extra microtask hops.
                    //
                    //   `.onComplete(cb)` is attached to the Promise so ALL
                    //   existing callers keep working unchanged:
                    //     entity.method(args).onComplete(function(err, data, meta) {...})
                    //
                    //   meta is captured alongside data so .onComplete() callbacks
                    //   receive the original (err, data, meta) signature unchanged.
                    //
                    //   The query executes exactly once — register() is called with
                    //   _internalCb in the setTimeout(0), same deferred-execution
                    //   timing as before. .onComplete() chains on the resolved
                    //   Promise instead of calling register() again.
                    //
                    // The _mainCallback path (util.promisify / explicit callback) is
                    //   unchanged — register() is still called synchronously.
                    // ─────────────────────────────────────────────────────────────

                    if ( _mainCallback == null ) {

                        var _resolve, _reject, _internalData, _internalMeta;

                        var _promise = new Promise(function(resolve, reject) {
                            _resolve = resolve;
                            _reject  = reject;
                        });

                        // Internal callback fed to register() — resolves/rejects
                        // the Promise and captures meta for .onComplete() callers.
                        var _internalCb = function(err, data, meta) {
                            if (err) {
                                _reject(err);
                            } else {
                                _internalData = data;
                                _internalMeta = meta;
                                _resolve(data);
                            }
                        };

                        // #B429 — the Promise path settles through the SAME per-call closure
                        // the explicit-callback path uses. onQueryCallback reads _mainCallback
                        // from this method's scope, so assigning it here (after the
                        // unserializable-parameter check above, which must keep throwing for
                        // this form) routes completion into _deliver() instead of the shared
                        // `self.once(trigger)` rendezvous that used to broadcast it.
                        _mainCallback = _internalCb;

                        // Backward-compatible .onComplete(cb):
                        //   chains on the Promise resolution so the callback
                        //   receives (err, data, meta) exactly as before.
                        _promise.onComplete = function(cb) {
                            _promise.then(
                                function()    { cb(null, _internalData, _internalMeta); },
                                function(err) { cb(err); }
                            );
                            return _promise; // preserve chaining
                        };

                        // Trigger the query via the existing setTimeout(0) mechanism.
                        // Preserves original timing: .onComplete() and await both
                        // have time to set up before the query fires.
                        //
                        // #B429 — `_isRegisteredFromProto` is GONE from this connector.
                        // It was a mutable flag on the shared entity singleton used to gate
                        // register()'s second dispatch block; with a single dispatch path and
                        // per-call settlement it has no remaining purpose. The hazard it was
                        // last documented as causing — a callback-path call setting it true so
                        // a subsequent Promise-path call skipped register() and hung forever —
                        // cannot recur: nothing reads it. (It was in fact already inert, since
                        // every invocation reset it to false before dispatching; measured, both
                        // mixed-call-form orders settle correctly.)
                        //
                        setTimeout(function() {
                            register(trigger, queryOptions, onQueryCallback);
                        }, 0);

                        return _promise;

                    } else {
                        // Direct callback path (util.promisify or an explicit trailing
                        // callback). _mainCallback is already in onQueryCallback's closure;
                        // register() dispatches the query and onQueryCallback settles this
                        // call through _deliver(). Identical to the Promise path above apart
                        // from who supplies _mainCallback.
                        register(trigger, queryOptions, onQueryCallback)
                    }
                }

            } catch (err) {
                // #B461 — say WHICH entity failed to register, and from which file.
                // This catch guards the whole entity-class construction and .sql method
                // attachment above it (~770 lines: inherits(), the prototype stamping,
                // the per-method attachment). None of readSource()'s three call sites
                // captures a result or takes an error argument, so a throw here used to
                // leave the entity partially built — or absent — with nothing but a bare
                // stack in the log: the first symptom a consumer saw was a missing method
                // at request time, arbitrarily far from the cause.
                //
                // Boot deliberately still CONTINUES. Whether an unbuildable entity should
                // be fatal is a separate, consumer-visible decision (a project booting
                // today through a swallowed error would start failing to boot), so this
                // change is diagnostic only and does not alter control flow.
                console.error('[couchbase] entity `' + entityName + '` failed to register from `'
                    + source + '`'
                    + ( name ? ' while attaching method `' + name + '`' : '' )
                    + ' — it may be missing that method or be incompletely built, and the first '
                    + 'symptom is usually a missing method at request time. Cause: '
                    + ( err && err.message ? err.message : String(err) ));
                console.error(err.stack);
            }
        }

    }

    /**
     * bulkInsert
     *
     * Supported options
     *  - adhoc : [ true | false ]
     *  // scan consistency level - here, default is 3
     *  - consistency : [ 1 | 2 | 3 ] where 1 = NOT_BOUNDED, 2 = REQUEST_PLUS, 3 = STATEMENT_PLUS
     *      not_bounded:
     *          Executes the query immediately, without requiring any consistency for the query. If index-maintenance is running behind, out-of-date results may be returned.
     *      at_plus:
     *          Executes the query, requiring indexes first to be updated to the timestamp of the last update. If index-maintenance is running behind, the query waits for it to catch up.
     *      request_plus:
     *          Executes the query, requiring the indexes first to be updated to the timestamp of the current query-request. If index-maintenance is running behind, the query waits for it to catch up.
     *
     * @param {array} rec collection
     * @param {object} [options] e.g: { consistency: 2 }
     *
     * @returns {Promise<Array>} resolves with the RETURNING rows. Carries an
     *   `.onComplete(cb)` shim for backward compatibility, called as
     *   `(err, data, meta)`. Since #B429 the promise is settled by THIS call's own
     *   resolver — concurrent bulkInsert calls on one entity no longer cross-deliver.
     *
     * @example
     * // Promise form
     * var rows = await myEntity.bulkInsert({ 'doc-1': { values: { a: 1 } } });
     *
     * @example
     * // Callback shim
     * myEntity.bulkInsert({ 'doc-1': { values: { a: 1 } } })
     *     .onComplete(function (err, rows) {
     *         if (err) { return next(err); }
     *         // rows === the RETURNING payload
     *     });
     */
    var bulkInsert = function(rec, options) {

        // #B460 — the promise, its one-shot resolver and the .onComplete shim are
        // built BEFORE the try, not inside it. The try below wraps this function's OWN
        // body, so a synchronous throw in the prologue (a failed getConnection(), or
        // either of the two deliberate `rec` validations) lands in the outer catch. When
        // the plumbing lived inside the try, that catch ran with _promise/_settle/the
        // shim still hoisted-but-unassigned, so the function fell off the end and
        // returned `undefined`: `.onComplete(cb)` threw on undefined and the documented
        // `await` form resolved with undefined, hiding the error from the caller
        // entirely. Built here, they exist unconditionally and the catch can settle.
        // #B429 — bulkInsert settles per call, exactly once, like the query path.
        // The Promise below used to be created AFTER the dispatch and woken by
        // `self.once(trigger)` on the shared entity singleton, so two concurrent
        // bulkInsert calls on one entity both received whichever finished first
        // (measured). The resolver is hoisted here so the handlers can settle THIS
        // call directly; the trigger is still emitted, purely for observability.
        var _resolve, _reject, _internalData, _internalMeta;
        var _promise = new Promise(function(resolve, reject) {
            _resolve = resolve;
            _reject  = reject;
        });
        var _settled = false;
        /**
         * Settle THIS bulkInsert call's promise, at most once.
         *
         * @inner
         * @param {Error|boolean} err - the error, or `false` on success.
         * @param {Array} data - the RETURNING rows.
         * @param {object} [meta] - the driver's result metadata.
         * @returns {void}
         */
        var _settle = function(err, data, meta) {
            if (_settled) {
                return;
            }
            _settled = true;
            if (err) {
                _reject(err);
            } else {
                _internalData = data;
                _internalMeta = meta;
                _resolve(data);
            }
        };
        _promise.onComplete = function(cb) {
            _promise.then(
                function()    { cb(null, _internalData, _internalMeta); },
                function(err) { cb(err); }
            );
            return _promise;
        };

        try {
            var conn        = this.getConnection();
            // retrieve & return the collection
            // if ( typeof(conn._scope) == 'undefined' && typeof(conn.scope) != 'undefined' ) {
            //     var newConn = conn.scope(scope).collection(currentCollection);
            //     newConn.sdk = conn.sdk;
            //     conn = newConn;
            // }
            // by default
            var queryOptions = {
                adhoc: true
            };
            // #QI — enable query profiling in dev mode for index extraction
            if (envIsDev) {
                queryOptions.profile = 'timings';
            }

            if ( typeof(options) != 'undefined' ) {
                queryOptions = merge(options, queryOptions)
            }

            var name = 'bulkInsert';

            if ( typeof(rec) == 'undefined' || !rec) {
                throw new Error('[ '+ this._scope +'.'+ this._collection +'::'+name+'(rec) ] : `rec` argument cannot be left empty !')
            }


            var queryString = 'INSERT INTO '+ this.database +' (KEY, VALUE)';
            var recCount = 0;
            for (let id in rec) {
                if ( typeof(rec[id].values) == 'undefined' )
                    throw new Error('rec["'+ id +'"].values not found ! Please inspect your record root: type must be an Array.');

                if ( typeof(rec[id].values.id) == 'undefined' )
                    rec[id].values.id = id;

                rec[id].values._collection  = this._collection;
                rec[id].values._scope       = this._scope;

                // CB-QUAL-4 fix: id was interpolated bare — a key containing `"` broke the N1QL string.
                // JSON.stringify() escapes any special characters and wraps in double quotes.
                queryString += '\t\nVALUES ('+ JSON.stringify(String(id)) +', '+ JSON.stringify(rec[id].values) +'),';
                recCount++;
            }

            queryString = queryString.substring(0, queryString.length-1);
            queryString += '\nRETURNING '+ this.database +'.*;';


            // starting SDK v3, the query is the raw N1QL string (prepared-statement
            // builder objects were SDK v2 only — removed in #CN8).
            var query = queryString;


            // trick to set event on the fly
            var trigger = 'N1QL:'+ this.name.toLowerCase()+ '#'+ name;
            // trick to set event on the fly
            var statement = query;

            // #QI — dev-mode query instrumentation for bulkInsert
            var _biQueryEntry = null;
            // #INS10 — capture during a prod instrumentation window too (not just dev mode).
            if (envIsDev || (process.gina && process.gina._inspectorWindowUntil > Date.now())) {
                // #B350 — the bulkInsert statement inlines every record's full document
                // values (stringified per record above), so the raw statement is itself a
                // value disclosure; the default logs op + record count, and
                // `inspector.queries.captureValues` opts back in to the full statement.
                var _biStatementForLog = paramRedact.captureValues()
                    ? statement
                    : 'INSERT INTO ' + this.database + ' (KEY, VALUE) -- ' + recCount + ' record(s) [values redacted]';
                console.debug('[ ' + trigger +' ] '+_biStatementForLog);

                var _biAlsStore = process.gina && process.gina._queryALS ? process.gina._queryALS.getStore() : null;
                var _biDevLog = _biAlsStore ? _biAlsStore._devQueryLog : null;
                if (_biDevLog) {
                    _biQueryEntry = {
                        type        : 'N1QL',
                        trigger     : this.name.toLowerCase() + '#' + name,
                        statement   : String(_biStatementForLog),
                        params      : [],
                        durationMs  : 0,
                        resultCount : 0,
                        resultSize  : 0,
                        indexes     : null,
                        error       : null,
                        source      : 'bulkInsert',
                        origin      : infos.bundle,
                        connector   : 'couchbase'
                    };
                    _biQueryEntry._startMs = Date.now();
                    _biDevLog.push(_biQueryEntry);
                }
            }

            var self = this;

            // #B460 — the resolver/_settle pair moved ABOVE the try (see the top of this
            // function); the #B429 per-call settlement contract they implement is unchanged.

            var err = false;
            // cluster resolved via the shared dual-shape helper (was a bare
            // conn._scope._bucket._cluster deref).
            // #B431 — two-argument .then(onResult, onError), NOT .catch(...).then(...):
            // the trailing .then() used to run on EVERY error with `data` undefined, which
            // here threw `TypeError: Cannot read properties of undefined (reading 'rows')`
            // into the inner try and logged a spurious error on every failed bulkInsert
            // (measured). register()'s dispatch carries the same fix.
            resolveCluster(conn).query(query, queryOptions)
                .then(
                    function onResult(data) {
                        try {
                            // #B431 — guard the payload the way register()'s onResult does.
                            var _data = (data && typeof(data.rows) != 'undefined') ? data.rows : [];
                            var _meta = (data && typeof(data.meta) != 'undefined') ? data.meta : {};
                            if (!_data || _data.length == 0) {
                                _data = null
                            }

                            // #QI — finalize bulkInsert query entry on success
                            if (_biQueryEntry) {
                                _biQueryEntry.durationMs = Date.now() - _biQueryEntry._startMs;
                                // _startMs is kept for the Flow tab timeline (#FI)
                                _biQueryEntry.resultCount = _data ? (Array.isArray(_data) ? _data.length : 1) : 0;
                                try { _biQueryEntry.resultSize = _data ? JSON.stringify(_data).length : 0; } catch(_e) { _biQueryEntry.resultSize = 0; }
                                // #QI — extract index usage from query profile or EXPLAIN cache
                                if (_meta && _meta.profile) {
                                    _biQueryEntry.indexes = extractIndexes(_meta.profile);
                                } else {
                                    var _biStmt = _biQueryEntry.statement;
                                    if (_explainCache.has(_biStmt)) {
                                        _biQueryEntry.indexes = _explainCache.get(_biStmt);
                                    } else {
                                        explainForIndexes(conn, _biStmt, _biQueryEntry, queryOptions);
                                    }
                                }
                            }

                            if (!err && _meta && typeof(_meta.errors) != 'undefined' ) {
                                err = new Error('`GenericN1QLError::bulkInsert`\n'+_meta.errors[0].msg);
                                err.status = 403;
                                if (_biQueryEntry) _biQueryEntry.error = err.message;
                            } else if (err) {
                                err.status  = 500;
                                err.message = '`GenericN1QLError::bulkInsert`\n'+ err.message;
                                err.stack   = '`GenericN1QLError::bulkInsert`\n'+ err.stack;
                                if (_biQueryEntry) _biQueryEntry.error = err.message;
                            }
                            if (envIsDev) {
                                console.debug('[ bulkInsert response ] : err ? '+ err + ', meta : \n'+ JSON.stringify(_meta) +'\n data :\n'+ JSON.stringify(_data) );
                            }

                            // #B429 — settle THIS call first, then emit for observability only.
                            _settle(err, _data, _meta);
                            self.emit(trigger, err, _data, _meta);

                        } catch (_err) {
                            console.error(_err.stack);
                        }
                    },
                    function onError(err) {
                        try {
                            // #QI — finalize bulkInsert query entry on error
                            if (_biQueryEntry) {
                                _biQueryEntry.durationMs = Date.now() - _biQueryEntry._startMs;
                                // _startMs is kept for the Flow tab timeline (#FI)
                                _biQueryEntry.error = err.message || String(err);
                            }
                            // #B153 — guard the N1QL `cause` envelope (see the register() onError
                            // sites): a socket-level failure has no `cause`, and reading
                            // err.cause.first_error_message on it threw a swallowed TypeError so
                            // self.emit never fired and the request hung. Emit a usable error on
                            // BOTH paths (the raw error preserves its code/errno).
                            // #B153 residual — the empty-message clause: a CLIENT-side SDK timeout
                            // carries a defined-but-EMPTY first_error_message, so synthesizing from it
                            // destroyed the typed class name the classifier matches on. Synthesize only
                            // when there is envelope text; raw-forwarding keeps `.cause` either way.
                            var error;
                            if ( err && err.cause && typeof(err.cause.first_error_message) != 'undefined' && err.cause.first_error_message !== '' ) {
                                error = new Error(err.cause.first_error_message);
                                // #B509 — see the register() onError site: the envelope's result
                                // rows are redacted out of `.stack` and `.cause.http_body`.
                                var _redactedBody = paramRedact.redactResultRows(err.cause.http_body);
                                error.stack = trigger +'\n'+ _redactedBody;
                                error.cause = Object.assign({}, err.cause, { http_body: _redactedBody });
                            } else {
                                error = (err instanceof Error) ? err : new Error(String(err));
                            }
                            // #CE1: classify transient vs permanent — stamped ONCE here, then
                            // carried unchanged into both the settlement and the emit below.
                            error = lib.connectorError.stamp(error);
                            // #B429 — settle THIS call first; the emit is observability only.
                            _settle(error);
                            self.emit(trigger, error);
                        } catch (_err) {
                            console.error(_err.stack);
                        }
                    }
                );


            // CB-QUAL-3 fix: bulkInsert previously returned a plain {onComplete} _proto object.
            // `await entity.bulkInsert(...)` resolved to the object, not the data — silently
            // wrong for any async controller using bulkInsert. Fixed with the same Option B
            // Promise + .onComplete() pattern used by all other N1QL entity methods.
            // Original broken implementation:
            // return {
            //     onComplete : function(cb) {
            //         self.once(trigger, function(err, data, meta){
            //             if (envIsDev) {
            //                 console.debug('[ bulkInsert triggerd ] '+ trigger + ' - Rec count: '+ recCount);
            //             }
            //             cb(err, data, meta)
            //         })
            //     }
            // }
            // #B429 — the resolver is created ABOVE the dispatch now (see _settle), so the
            // duplicate construction that used to sit here is gone, and with it the
            // shared-emitter rendezvous that settled this call:
            //
            //     self.once(trigger, function(err, data, meta){
            //         if (envIsDev) { console.debug('[ bulkInsert triggered ] '+ trigger + ' - Rec count: '+ recCount); }
            //         if (err) { _reject(err); } else { _internalData = data; _internalMeta = meta; _resolve(data); }
            //     });
            //
            // `trigger` is keyed on entity+method only and `self` is a process-wide
            // singleton, so two concurrent bulkInsert calls on one entity both settled
            // from whichever completed first (measured). The CB-QUAL-3 note above is
            // therefore only half-true as written: bulkInsert did adopt Option B's
            // Promise + .onComplete() shape, but kept the shared `once` as the thing that
            // settled it — which is exactly the defect the query path carried.
            // #B460 — the .onComplete shim is attached above the try now, so a prologue
            // throw still returns a promise that carries it. Contract unchanged.

            if (envIsDev) {
                _promise.then(
                    function() { console.debug('[ bulkInsert triggered ] '+ trigger + ' - Rec count: '+ recCount); },
                    function() {}
                );
            }

            return _promise;

        } catch (err) {
            console.error(err.stack);
            // #B460 — settle THIS call's promise instead of falling off the end. _settle's
            // `_settled` latch makes this a no-op when the dispatch already settled, so a
            // late throw cannot double-settle. Returning _promise keeps both documented
            // shapes working on the failure path: .onComplete(cb) delivers (err), and the
            // `await` form rejects rather than resolving with undefined.
            _settle(err);
            return _promise;
        }
    }

    /**
     * getCluster
     *
     * Returns the underlying Couchbase SDK Cluster handle backing this entity's
     * connection, resolved across the connection shapes the connector produces
     * (see `resolveCluster`). This is the supported, non-underscore way to reach
     * SDK-level features the entity layer does not wrap — most notably
     * multi-document ACID transactions via `cluster.transactions().run(...)`.
     *
     * Note: gina does not bundle or pin the `couchbase` driver — it is resolved
     * from your project's `node_modules`. Transaction support (`.transactions()`)
     * therefore depends on the Couchbase SDK version your project installs
     * (3.2+ / 4.x). gina guarantees only that this returns the resolved Cluster
     * handle; it makes no promise about which SDK-level capabilities that handle
     * exposes.
     *
     * @returns {object} The Couchbase SDK Cluster.
     * @throws {Error} `GINA_COUCHBASE_CLUSTER_UNRESOLVED` when the cluster cannot be resolved.
     *
     * @example
     * // Inside a controller action holding an entity instance:
     * var cluster = myEntity.getCluster();
     * await cluster.transactions().run(async function (ctx) {
     *     var doc = await ctx.get(collection, 'doc-id');
     *     await ctx.replace(doc, Object.assign({}, doc.content, { balance: 0 }));
     * });
     */
    var getCluster = function() {
        return resolveCluster(this.getConnection());
    };


    return init(conn, infos)
}

module.exports = Couchbase;