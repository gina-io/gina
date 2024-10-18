//"use strict";
// Imports.
var fs              = require('fs');
const { version } = require('os');
//var util            = require('util');
//var promisify       = require('util').promisify;
// Use couchbase module from the user's project dependencies if not found
var couchbasePath   = _(getPath('project') +'/node_modules/couchbase');
var couchbase       = require(couchbasePath);

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
     * Init
     * @constructor
     * */
    var init = function(conn, infos) {
        // load on startup
        var cacheless           = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;
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
        if (cacheless)
            delete require.cache[require.resolve(_(filename, true))]; //EntitySuperClass

        EntitySuperClass = require(_(filename, true));


        // first one for the N1QL queries without entity ( check `/lib/n1ql.js` )
        files.unshift('n1ql.js');
        for (var f = 0, len = files.length; f < len; ++f) {

            if ( ! /^\./.test(files[f]) || f == len-1 ) {

                if (cacheless && files[f] != 'n1ql.js') {
                    delete require.cache[require.resolve(_(path + '/' +files[f], true))];//child
                }

                entityName      = files[f].replace(/.js/, '');
                className       = entityName.substr(0,1).toUpperCase() + entityName.substr(1);

                if ( files[f] == 'n1ql.js' ) {
                    Entity = require(_(n1qlDefault + '/' +files[f], true));
                    EntityN1qlClass = Entity
                } else {
                    Entity = require(_(path + '/' +files[f], true));

                    Entity = inherits(Entity, EntitySuperClass);

                    Entity.prototype.name           = className;
                    Entity.prototype.model          = infos.model;
                    Entity.prototype.bundle         = infos.bundle;
                    Entity.prototype.database       = infos.database;
                    Entity.prototype._collection    = entityName;
                    Entity.prototype._filename      = _(path + '/' +files[f], true);

                    // extra CRUD methods
                    Entity.prototype.bulkInsert     = bulkInsert;


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
            , comments      = ''
            , queryString   = null
            , includes      = null
            , queryStatement= null // this is the usable queryString
            , params        = []
            , paramTypes    = []
            , inlineParams  = [] // order of use inside the query
            , returnType    = null // Array or Object : Array by default
            , returnVariable= null // return variable
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
                        dir = dir.substr(0, dir.lastIndexOf('/')) + '/'
                        filename = _(dir + filename.replace(/^\.\//, ''), true);
                    }
                    // remove @include calls
                    //console.debug('including .....'+ filename);
                    queryString = queryString.replace(includes[i], fs.readFileSync( filename ).toString() );
                }
            }
            paramTypes = queryString.match(/\@param \{(.*)\}/gm);
            if ( paramTypes && Array.isArray(paramTypes) ) {
                for (let t=0, tLen = paramTypes.length; t<tLen; t++) {
                    paramTypes[t] = paramTypes[t].match(/\{(.*)\}/)[1];
                }
            }
            queryString = queryString.replace(/\n/g, ' ');

            // extract comments
            comments    = queryString.match(/(\/\*([^*]|[\r\n]|(\*+([^*\/]|[\r\n])))*\*+\/)|(\/\/.*)/g);
            // extract return type
            returnType  = queryString.match(/\@return\s+\{(.*)\}/);
            if ( Array.isArray(returnType) ) {
                returnType = returnType[1]
            }

            if (comments) {
                params = comments[0].match(/\$\w+/g); // param list from comments
                queryString = queryString.replace(comments[0], '');
            }

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

                    entities[entityName].prototype.name           = entityName.substr(0,1).toUpperCase() + entityName.substr(1);
                    entities[entityName].prototype.model          = infos.model;
                    entities[entityName].prototype.bundle         = infos.bundle;
                    entities[entityName].prototype._collection    = entityName;
                    entities[entityName].prototype._filename      = _( __dirname + '/lib/n1ql.js', true );
                }


                entities[entityName].prototype[name] = function() {
                    var self = this;
                    var key     = null
                        , index = null
                        , i     = null
                        , len   = null
                        , args  = Array.prototype.slice.call(arguments)
                        , _mainCallback = null;

                    if ( params && params.length != args.length && !/function/.test(typeof(args[args.length-1])) ) {
                        throw new Error('[N1QL][ ' + entityName+'#'+name+'() ] arguments must match parameters length. Please refer to [ '+ source +' ]\nFound in param list: ('+ params.join(', ') +') !')
                    } else if ( /function/.test( typeof(args[args.length-1]) ) ) {
                        // to hande Nodejs Util.promisify
                        _mainCallback = args[args.length-1]
                    }

                    if ( paramTypes && paramTypes.length > 0 ) {
                        cast(args, paramTypes)
                    }

                    var sdkVersion = conn.sdk.version || 2;
                    var queryParams = [];
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

                        // e.g.: c.documentNextId.$2 = $3
                        // e.g.: n.alertedOn.$1 = true
                        if (foundSpecialLeftCase) {
                            i = 0; len = args.length;
                            for (; i < len; ++i) {
                                key = inl.indexOf(params[i]);
                                if (key > -1) {
                                    p[key] = args[key];

                                    re = new RegExp('(.*)\\.'+ inl[key].replace(/([$%]+)/, '\\$1'));
                                    if ( re.test(qStr) ) {
                                        p[key] = args[key];
                                        qStr = qStr.replace( new RegExp('(.*)\\.'+ params[i].replace(/([$%]+)/, '\\$1')), '$1\.'+args[i]);
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
                            } else { // v2 & v > 3

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

                    var query = null, execQuery = null, _collection = null;
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
                    // Request plus
                    //  code        : REQUEST_PLUS
                    //  number      : 2
                    //  description : This implements strong consistency per request.
                    //                Update cycle every «20ms for memdb & 200ms for forestdb»
                    //
                    // Statement plus
                    //  code        : STATEMENT_PLUS
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
                        adhoc: false, // false to use plan optimization, but need a statement `name param` or `num param`
                        consistency: 1 // NOT_BOUNDED, but STATEMENT_PLUS is set by default for insert & update
                    };


                    if ( /^(insert|update)/i.test(statement) ) {
                        queryOptions.adhoc = true;
                        queryOptions.consistency = 3; // STATEMENT_PLUS
                    }

                    if ( sdkVersion > 2 ) { // starting from SDK v3
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
                        queryOptions.parameters = queryParams;

                    } else { // version 2
                        // prepared statement
                        query = N1qlQuery.fromString(queryStatement.replace(/^\s+/, ''));
                        // query options
                        // @param {object} options
                        // @param {string} options.sample


                        // Setting up consistency
                        query.consistency(queryOptions.consistency);
                        // merge options
                        for (var qOpt in queryOptions) {
                            if ( typeof(query[ qOpt ]) == 'undefined' ) {
                                console.warn('[N1QL]['+entityName.toLowerCase()+ '#'+ name + '] `'+ qOpt +'` is not a valid queryOption. Ignorig...');
                                continue;
                            }
                            query[ qOpt ]( queryOptions[ qOpt ] );
                        }

                    }

                    // JUNE 2021 patch
                    // Adding support for FTS since it is not implemented in sdkVersion 2:
                    // variables not replaced by value
                    // looking for FTS (Full Text Search)
                    var ftsClause = ( sdkVersion > 2 ) ? query.match(/(search\(|search\s+\().*\)/i) : query.options.statement.match(/(search\(|search\s+\().*\)/i);
                    if (ftsClause && Array.isArray(queryParams) ) {
                        var originalFtsClauses = JSON.clone(ftsClause), _queryParams = null;

                        if ( sdkVersion > 2 && Array.isArray(queryOptions.parameters) ) {
                            _queryParams = queryOptions.parameters;
                        } else if (sdkVersion <=2 && Array.isArray(queryParams) ) {
                            _queryParams = queryParams;
                        }

                        for (let s = 0, sLen = ftsClause.length; s < sLen; s++) {
                            if ( !/\)$/.test(ftsClause[s]) ) continue;
                            for (let p = 0, pLen = _queryParams.length; p < pLen; p++) {
                                if ( typeof(_queryParams[p]) == 'function' ) continue;
                                let searchValue = ( /^(true|false)$/i.test(_queryParams[p]) ) ? _queryParams[p] : '"'+_queryParams[p]+'"';
                                ftsClause[s] = ftsClause[s].replace( new RegExp('\\$'+ (p+1),'g'), searchValue)
                            }

                            if ( sdkVersion > 2 ) {
                                query = query.replace(originalFtsClauses[s], ftsClause[s]);
                            } else {
                                query.options.statement = query.options.statement.replace(originalFtsClauses[s], ftsClause[s]);
                            }
                        }

                        originalFtsClauses = null;
                    }
                    ftsClause = null;




                    // trick to set event on the fly
                    var trigger = 'N1QL:'+entityName.toLowerCase()+ '#'+ name;
                    var statement = (sdkVersion <= 2) ? query.options.statement : query;

                    if (envIsDev) {
                        //var statement = (sdkVersion <= 2) ? query.options.statement : query;
                        console.debug('[ ' + trigger +' ] '+ statement);
                        //console.debug('[ ' + trigger +' ] options: '+ JSON.stringify(queryOptions, null, 2));
                        if (queryParams.length > 0) {
                            console.debug('[ ' + trigger +' ] Found query params: '+ queryParams);
                        }
                    }



                    var onQueryCallback = function(err, data, meta) {
                        // if (/^company#getDocumentNextId$/.test(trigger)) {
                        //     console.log('[ ' + trigger + '] onQueryCallback => ', err, data, meta);
                        // }

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

                        } else if ( returnType && returnType == 'number' && /count\(|count\s+\(/i.test(queryString) ) {

                            var re = /(?:(?:COUNT\(\S+\)|COUNT\s+\(\S+\))\s+AS\s+)(\w+)/i;
                            re.lastIndex = 1; // defining last index
                            returnVariable = queryString.match(re)[re.lastIndex];

                            data = ( typeof(returnVariable) != 'undefined' ) ? data[0][returnVariable] : data[0];
                        }

                        try {
                            if ( _mainCallback != null ) {
                                _mainCallback(err, data, meta)
                            } else {
                                //console.debug('self.emit ? ', typeof(self), typeof(self.emit));
                                if (err) {
                                    if ( typeof(self.emit) != 'undefined' ) {
                                        self.emit(trigger, err);
                                    } else { // Promise case
                                        throw err
                                    }

                                } else {
                                    if ( typeof(self.emit) != 'undefined' ) {
                                        self.emit(trigger, err, data, meta);
                                    } else { // Promise case
                                        return data
                                    }
                                }
                                return
                            }

                        } catch (_err) {
                            if ( _mainCallback != null ) {
                                _mainCallback(err, data, meta)
                            } else {
                                if ( typeof(self.emit) != 'undefined' ) {
                                    self.emit(trigger, _err);
                                } else {
                                    throw new Error('[ Couchbase ][ Core Entity Exception] '+ trigger + '\n'+ _err.stack)
                                }
                            }
                        }
                    }; // EO onQueryCallback

                    self._isRegisteredFromProto = false;
                    // `register()` is only used for v2
                    var register = function (trigger, queryParams, onQueryCallback, cb) {
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


                        if ( typeof(self.once) != 'undefined' && typeof(cb) != 'undefined' ) {
                            self._isRegisteredFromProto = true;
                            //console.debug('registered trigger: ', trigger, self._isRegisteredFromProto);
                            self.once(trigger, function onComplete(err, data, meta){
                                //console.debug('received ', trigger, meta, err);
                                try {
                                    cb(err, data, meta)
                                } catch (onCompleteError) {
                                    // catch errors inside the call of the user code
                                    cb(onCompleteError)
                                }
                            });
                            // if (/triggerToDebug/.test(trigger)) {
                            //     console.log('[ ' + trigger + '] onQuery => ', query, queryParams);
                            // }

                            if (sdkVersion > 2) {
                                conn._cluster.query(query, queryParams)
                                    .catch( function onError(err) {
                                        try {
                                            var error = new Error(err.cause.first_error_message);
                                            error.stack = trigger +'\n'+ err.cause.http_body;
                                            onQueryCallback(error);
                                        } catch (_err) {
                                            console.error(_err.stack);
                                        }
                                    })
                                    .then( function onResult(data, meta) {
                                        try {
                                            onQueryCallback(false, data.rows, data.meta);
                                        } catch (_err) {
                                            _err.stack = '[ ' + trigger + '] onQueryCallbackError: \n\t- Did you leave any bad comments ?\n\t- Did you try to run your query ?\r\n'+ query +'\r\n'+ _err.stack;
                                            console.error(_err.stack);
                                        }
                                    });
                                    // Added on 2023-03-25
                                    return;
                            } else {
                                conn.query(query, queryParams, onQueryCallback);
                            }


                        } // else  promise case


                        if (!self._isRegisteredFromProto) {
                            //console.debug('regular trigger: ', trigger, self._isRegisteredFromProto);
                            // if (/triggerToDebug/.test(trigger)) {
                            //     console.log('[ ' + trigger + '] onQuery => ', query, queryParams);
                            // }

                            if (sdkVersion > 2) {
                                conn._cluster.query(query, queryParams)
                                    .catch( function onError(err) {
                                        try {
                                            var error = new Error(err.cause.first_error_message);
                                            error.stack = trigger +'\n'+ err.cause.http_body;
                                            onQueryCallback(error);
                                        } catch (_err) {
                                            console.error(_err.stack);
                                        }
                                    })
                                    .then( function onResult(data) {
                                        try {
                                            onQueryCallback(false, data.rows, data.meta);
                                        } catch (_err) {
                                            console.error(_err.stack);
                                        }
                                    });
                            } else {
                                conn.query(query, queryParams, onQueryCallback);
                            }
                        }
                    } //EO register

                    var _proto = {
                        onComplete : function(cb) {
                            // console.warn('onComplete trigger: ', trigger, self._isRegisteredFromProto);
                            if ( sdkVersion > 2 ) {
                                register(trigger, queryOptions, onQueryCallback, cb)
                            } else {
                                register(trigger, queryParams, onQueryCallback, cb)
                            }
                        }
                    };


                    if ( sdkVersion > 2 ) {
                        if ( _mainCallback == null ) {
                            setTimeout((trigger, queryOptions, onQueryCallback) => {
                                if (!self._isRegisteredFromProto) {
                                    // needed when used as a synchrone method
                                    register(trigger, queryOptions, onQueryCallback);
                                }
                            }, 0, trigger, queryOptions, onQueryCallback);
                            return _proto

                        } else {
                            register(trigger, queryOptions, onQueryCallback, _mainCallback)
                        }
                    } else {

                        if ( _mainCallback == null ) {
                            setTimeout((trigger, queryParams, onQueryCallback) => {
                                if (!self._isRegisteredFromProto) {
                                    // needed when used as a synchrone method
                                    register(trigger, queryParams, onQueryCallback);
                                }
                            }, 0, trigger, queryParams, onQueryCallback);
                            return _proto

                        } else {
                            register(trigger, queryParams, onQueryCallback, _mainCallback)
                        }
                    }
                }

            } catch (err) {
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
     */
    var bulkInsert = function(rec, options) {

        try {
            var conn        = this.getConnection();
            // retrieve & return the collection
            // if ( typeof(conn._scope) == 'undefined' && typeof(conn.scope) != 'undefined' ) {
            //     var newConn = conn.scope(scope).collection(currentCollection);
            //     newConn.sdk = conn.sdk;
            //     conn = newConn;
            // }
            var sdkVersion  = conn.sdk.version || 2;
            // by default
            var queryOptions = {
                adhoc: true,
                consistency: 3
            };

            if ( typeof(options) != 'undefined' ) {
                queryOptions = merge(options, queryOptions)
            }

            var name = 'bulkInsert';

            if ( typeof(rec) == 'undefined' || !rec) {
                throw new Error('[ '+ this._collection +'::'+name+'(rec) ] : `rec` argument cannot be left empty !')
            }


            var queryString = 'INSERT INTO '+ this.database +' (KEY, VALUE)';
            var recCount = 0;
            for (let id in rec) {
                if ( typeof(rec[id].values) == 'undefined' )
                    throw new Error('rec["'+ id +'"].values not found ! Please inspect your record root: type must be an Array.');

                if ( typeof(rec[id].values.id) == 'undefined' )
                    rec[id].values.id = id;

                rec[id].values._collection  = this._collection;

                queryString += '\t\nVALUES ("'+ id +'", '+ JSON.stringify(rec[id].values) +'),';
                recCount++;
            }

            queryString = queryString.substr(0, queryString.length-1);
            queryString += '\nRETURNING '+ this.database +'.*;';


            var query = null;
            if ( sdkVersion > 2) { // starting SDK v3
                query = queryString;
                // queryOptions.parameters = queryParams;
            } else {
                // prepared statement
                query = N1qlQuery.fromString(queryString);
                query.consistency(queryOptions.consistency);
                // merge options
                for (var qOpt in queryOptions) {
                    if ( typeof(query[ qOpt ]) == 'undefined' ) {
                        console.warn('[N1QL]['+entityName.toLowerCase()+ '#'+ name + '] `'+ qOpt +'` is not a valid queryOption. Ignorig...');
                        continue;
                    }
                    query[ qOpt ]( queryOptions[ qOpt ] )
                }
            }


            // trick to set event on the fly
            var trigger = 'N1QL:'+ this.name.toLowerCase()+ '#'+ name;
            // trick to set event on the fly
            var statement = (sdkVersion <= 2) ? query.options.statement : query;

            if (envIsDev) {
                console.debug('[ ' + trigger +' ] '+statement);
            }

            var self = this;

            if (sdkVersion > 2) {
                var err = false;
                conn._scope._bucket._cluster.query(query, queryOptions)
                    .catch( function onError(err) {
                        try {
                            var error = new Error(err.cause.first_error_message);
                            error.stack = trigger +'\n'+ err.cause.http_body;
                            self.emit(trigger, error);
                        } catch (_err) {
                            console.error(_err.stack);
                        }
                    })
                    .then( function onResult(data) {
                        try {
                            var _data = data.rows, _meta = data.meta;
                            if (!_data || _data.length == 0) {
                                _data = null
                            }

                            if (!err && _meta && typeof(_meta.errors) != 'undefined' ) {
                                err = new Error('`GenericN1QLError::bulkInsert`\n'+_meta.errors[0].msg);
                                err.status = 403;
                            } else if (err) {
                                err.status  = 500;
                                err.message = '`GenericN1QLError::bulkInsert`\n'+ err.message;
                                err.stack   = '`GenericN1QLError::bulkInsert`\n'+ err.stack;
                            }
                            if (envIsDev) {
                                console.debug('[ bulkInsert response ] : err ? '+ err + ', meta : \n'+ JSON.stringify(_meta) +'\n data :\n'+ JSON.stringify(_data) );
                            }

                            self.emit(trigger, err, data.rows, data.meta);
                            // Tempory fix
                            // setTimeout(() => {
                            //     self.emit(trigger, err, data.rows, data.meta);
                            // }, (9+recCount) );

                        } catch (_err) {
                            console.error(_err.stack);
                        }
                    });
            } else {
                conn.query(query, rec, function(err, data, meta) {
                    if (!data || data.length == 0) {
                        data = null
                    }

                    if (!err && meta && typeof(meta.errors) != 'undefined' ) {
                        err = new Error('`GenericN1QLError::bulkInsert`\n'+meta.errors[0].msg);
                        err.status = 403;
                    } else if (err) {
                        err.status  = 500;
                        err.message = '`GenericN1QLError::bulkInsert`\n'+ err.message;
                        err.stack   = '`GenericN1QLError::bulkInsert`\n'+ err.stack;
                    }
                    if (envIsDev) {
                        console.debug('[ bulkInsert response ] : err ? '+ err + ', meta : \n'+ JSON.stringify(meta) +'\n data :\n'+ JSON.stringify(data) );
                    }

                    self.emit(trigger, err, data, meta);
                });
            }


            return {
                onComplete : function(cb) {
                    self.once(trigger, function(err, data, meta){
                        if (envIsDev) {
                            console.debug('[ bulkInsert triggerd ] '+ trigger + ' - Rec count: '+ recCount);
                        }

                        cb(err, data, meta)
                    })
                }
            }

        } catch (err) {
            console.error(err.stack);
        }
    }

    return init(conn, infos)
}

module.exports = Couchbase;