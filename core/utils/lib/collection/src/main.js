/**
 * Collection cLass
 * Allows you to handle your own collections as you would normaly with mongodb
 * Dependencies :
 *  - utils/merge
 *  - uuid
 *
 *
 * @param {array} collection
 * @param {object} [options]
 *
 * @return {object} instance
 *
 * Collection::find
 *  @param {object} filter
 *      eg.: { uid: "someUID" }
 *      eg.: { type: "not null" }
 *      eg.: { "obj.prop": true }
 *      eg.: { "lastUpdate": ">= 2016-12-01T00:00:00" }
 *      eg.: { "activity": null }
 *
 *  @return {array} result
 *
 * Collection::findOne
 *  @param {object} filter
 *  @return {object|array|string} result
 *
 * Collection::update
 *  @param {object} filter
 *  @param {object} set
 *
 *  @return {array} result
 *
 * */
function Collection(content, option) {

    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
    var uuid            = (isGFFCtx) ? require('vendor/uuid') : require('uuid');
    var merge           = (isGFFCtx) ? require('utils/merge') : require('../../../../utils/lib/merge');

    var instance        = this;

    var defaultOptions = {
        'useLocalStorage': false,
        'locale': 'en' // get settigs.region, or user.region
    };

    var content     = (content) ? JSON.parse(JSON.stringify(content)) : [] // original content -> not to be touched
    //var content     = (Array.isArray(content)) ? content : [] // original content -> not to be touched
        , options   = (typeof(options) == 'object') ? merge(options, defaultOptions) : defaultOptions
        , keywords  = ['not null'] // TODO - null, exists (`true` if property is defined)
        ;
    ;

    this['uuids'] = {}; // uuids are generated for each new instance
    if ( content.length > 0 ) {
        for (var i = 0, len = content.length; i<len; ++i) {
            if (!content[i]) {
                //    throw new Error('field index `'+ i +'` cannot be left undefined or null !');
                //content.splice(i, 1);
                content[i] = { id: uuid.v4(), noEntryFound: true };
            }

            content[i]._uuid = uuid.v4();
            this['uuids'][ content[i]._uuid ] = content[i]
        }
    }

    //this.find = function(filter, withOrClause) {
    this['find'] = function() {

        var withOrClause = false;
        if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
            withOrClause = arguments[arguments.length-1];
            delete arguments[arguments.length-1];
            arguments.length -= 1;
        }

        var filters = JSON.parse(JSON.stringify(arguments));

        if ( typeof(filters) != 'undefined' && typeof(filters) !== 'object' ) {
            throw new Error('filter must be an object');
        } else if ( typeof(filters) != 'undefined' && filters.count() > 0 ) {

            var filter              = null
                , condition         = null
                , i                 = 0
                , tmpContent        = ( Array.isArray(this) && !withOrClause) ? this : JSON.parse(JSON.stringify(content))
                , resultObj         = {}
                , result            = []
                , localeLowerCase   = ''
                , re                = null
                , field             = null
                , value             = null
                ;

            for (var o in tmpContent) {

                if (!tmpContent[o]) {
                    tmpContent[o] = {}
                }
                tmpContent[o].matched = {};
                for (var l = 0, lLen = filters.count(); l<lLen; ++l) {
                    filter = filters[l];
                    condition = filter.count();

                    for (var f in filter) {
                        if ( typeof(filter[f]) == 'undefined' ) throw new Error('filter `'+f+'` cannot be left undefined');

                        localeLowerCase = ( typeof(filter[f]) != 'boolean' && filter[f] !== null ) ? filter[f].toLocaleLowerCase() : filter[f];
                        // cases with tmpContent.prop
                        if ( /\./.test(f) ) {
                            //JSON.stringify(tmpContent[o]).match(/("gross":\w+)/)[1].split(/:/)[1]
                            field = f.split(/\./g);
                            field = field[field.length-1];
                            re = new RegExp('("'+ field +'":\\w+)' );
                            if ( !/undefined|function/.test( typeof(tmpContent[o]) ) ) {
                                value = JSON.stringify(tmpContent[o]).match(re);
                                if ( value && value.length > 0) {
                                    value = value[1].split(/:/)[1];
                                    if ( /(<|>|=)/.test(filter[f]) ) {

                                        // looking for a datetime ?
                                        if (
                                            /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test( value )
                                            && /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test( filter[f] )
                                        ) {

                                            if ( eval( value.replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")') + filter[f].replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")') ) ) {
                                                tmpContent[o].matched[f] = true;
                                                resultObj[ tmpContent[o]._uuid ] = tmpContent[o]
                                            }

                                        } else if ( eval( value + filter[f] ) ) {

                                            tmpContent[o].matched[f] = true;
                                            resultObj[ tmpContent[o]._uuid ] = tmpContent[o]
                                        }
                                    } else {
                                        if (value == filter[f]) {

                                            tmpContent[o].matched[f] = true;
                                            resultObj[ tmpContent[o]._uuid ] = tmpContent[o]
                                        }
                                    }
                                } else {
                                    value = null
                                }
                            }


                        } else { // normal case

                            if ( filter[f] === null && tmpContent[o][f] === null ) { // null case

                                tmpContent[o].matched[f] = true;
                                resultObj[ tmpContent[o]._uuid ] = tmpContent[o]

                            } else if ( filter[f] && keywords.indexOf(localeLowerCase) > -1 && localeLowerCase == 'not null' && typeof(tmpContent[o][f]) != 'undefined' && typeof(tmpContent[o][f]) !== 'object' && tmpContent[o][f] != 'null' && tmpContent[o][f] != 'undefined' ) {
                                if (result.indexOf(tmpContent[o][f]) < 0 ) {
                                    tmpContent[o].matched[f] = true;
                                    //if (typeof(tmpContent[o][f]) == 'object' ) {
                                    //    resultObj[ tmpContent[o][f]._uuid ] = tmpContent[o][f]
                                    //} else {
                                    if ( !resultObj[o] ) {
                                        resultObj[o] = {}
                                    }

                                    resultObj[tmpContent[o]._uuid] = tmpContent[o];
                                    //}
                                }

                            } else if ( typeof(tmpContent[o][f]) != 'undefined' && typeof(tmpContent[o][f]) !== 'object' && /(<|>|=)/.test(filter[f]) && !/undefined|function/.test( typeof(tmpContent[o][f]) ) ) { // with operations
                                // looking for a datetime ?
                                if (
                                    /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test( tmpContent[o][f] )
                                    && /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test( filter[f] )
                                ) {

                                    if ( eval( tmpContent[o][f].replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")') + filter[f].replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")') ) ) {
                                        tmpContent[o].matched[f] = true;
                                        resultObj[ tmpContent[o]._uuid ] = tmpContent[o]
                                    }

                                } else if ( eval( tmpContent[o][f] + filter[f] ) ) {
                                    tmpContent[o].matched[f] = true;
                                    resultObj[ tmpContent[o]._uuid ] = tmpContent[o]
                                }
                            } else if ( typeof(tmpContent[o][f]) != 'undefined' && typeof(tmpContent[o][f]) !== 'object' && tmpContent[o][f] === filter[f] ) {

                                tmpContent[o].matched[f] = true;
                                resultObj[ tmpContent[o]._uuid ] = tmpContent[o]
                            }
                        }

                    }

                }
            }
        } else {
            result = content
        }

        if (withOrClause) {
            for (var obj in resultObj) {
                if ( typeof(resultObj[obj].matched) != 'undefined' && resultObj[obj].matched.count() == condition ) {
                    delete resultObj[obj].matched;
                    result[i] = resultObj[obj];
                    ++i
                }
            }

            // merging with previous result (this)
            result  = merge(this, result, true)
        } else {
            var matched = 0;
            for (var obj in resultObj) {
                if ( typeof(resultObj[obj].matched) != 'undefined' && resultObj[obj].matched.count() == condition ) {
                    delete resultObj[obj].matched;
                    result[i] = resultObj[obj];
                    ++i
                }
            }
        }

        // chaining
        result.notIn    = instance.notIn;
        result.find     = instance.find;
        result.update   = instance.update;
        result.or       = instance.or;
        result.findOne  = instance.findOne;
        result.limit    = instance.limit;
        result.orderBy  = instance.orderBy;

        return result
    }

    this['or'] = function () {
        arguments[arguments.length] = true;
        arguments.length += 1;

        return instance.find.apply(this, arguments);
    }

    this['limit'] = function(resultLimit) {
        if ( typeof(resultLimit) == 'undefined' || typeof(resultLimit) != 'number' ) {
            throw new Error('[Collection::result->limit(resultLimit)] : `resultLimit` parametter must by a `number`')
        }

        var result = Array.isArray(this) ? this : JSON.parse(JSON.stringify(content));

        //resultLimit
        result = result.splice(0, resultLimit);

        // chaining
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.notIn    = instance.notIn;
        result.findOne  = instance.findOne;
        result.orderBy  = instance.orderBy;

        return result
    }

    this['findOne'] = function(filter) {
        if ( typeof(filter) !== 'object' ) {
            throw new Error('filter must be an object');
        } else {
            var condition = filter.count()
                , i                 = 0
                , tmpContent        = Array.isArray(this) ? this : JSON.parse(JSON.stringify(content))
                , result            = []
                , localeLowerCase   = '';

            if (condition == 0) return null;

            for (var o in tmpContent) {
                for (var f in filter) {
                    if ( typeof(filter[f]) == 'undefined' ) throw new Error('filter `'+f+'` cannot be left undefined');

                    localeLowerCase = ( typeof(filter[f]) != 'boolean' ) ? filter[f].toLocaleLowerCase() : filter[f];
                    if ( filter[f] && keywords.indexOf(localeLowerCase) > -1 && localeLowerCase == 'not null' && typeof(tmpContent[o][f]) != 'undefined' && typeof(tmpContent[o][f]) !== 'object' && tmpContent[o][f] === filter[f] && tmpContent[o][f] != 'null' && tmpContent[o][f] != 'undefined' ) {
                        if (result.indexOf(tmpContent[o][f]) < 0 ) {
                            ++i;
                            if (i === condition) result = tmpContent[o]
                        }

                    } else if ( typeof(tmpContent[o][f]) != 'undefined' && typeof(tmpContent[o][f]) !== 'object' && tmpContent[o][f] === filter[f] ) {
                        ++i;
                        if (i === condition) result = tmpContent[o]
                    } else if ( filter[f] === null && tmpContent[o][f] === null ) { // null case
                        ++i;
                        if (i === condition) result = tmpContent[o]
                    }
                }
            }
        }


        return ( Array.isArray(result) && !result.length ) ? null : result
    }



    this['notIn'] =  function(collection){

        // where `this` is the source & `collection` is the target to be compared with

        if ( typeof(collection) == 'undefined' )
            return Array.isArray(this) ? this : content;

        if (!Array.isArray(this))
            throw new Error('<source>.notIn(<target>): `<source>` must be a valid `CollectionResultSet` (Array)');

        if (!Array.isArray(collection))
            throw new Error('<source>.notIn(<target>): `<target>` must be a valid CollectionResultSet (Array)');

        if (this.length == 0)
            return collection;

        var result          = []
            , r             = 0
            , source        = JSON.parse(JSON.stringify(this))
            , target        = JSON.parse(JSON.stringify(collection));

        // removing those not in collection
        for (var i = 0, len = target.length; i < len; ++i) {
            for (var s = 0, sLen = source.length; s < sLen; ++s) {
                if (target[i]._uuid == source[s]._uuid) {
                    target.splice(i, 1);
                    source.splice(s, 1);
                    --i;
                    break
                }
            }
        }

        result = target;

        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.orderBy  = instance.orderBy;

        return result
    }

    this['insert'] = function (set) {

        if ( typeof(set) !== 'object' ) {
            throw new Error('filter must be an object');
        } else {


            content.push(set);

            var index = content.length-1;
            content[ index ]._uuid = uuid.v4();
            instance['uuids'][ content[index]._uuid ] = content[index];

            var result = Array.isArray(this) ? this : JSON.parse(JSON.stringify(content));
        }

        // chaining
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.orderBy  = instance.orderBy;
        result.notIn    = instance.notIn;

        return result
    }

    this['update'] = function(filter, set) {
        if ( typeof(filter) !== 'object' ) {
            throw new Error('filter must be an object');
        } else {
            var condition           = filter.count()
                , i                 = 0
                , localeLowerCase   = ''
                , result            = Array.isArray(this) ? this : JSON.parse(JSON.stringify(content));

            for (var o in result) {
                for (var f in filter) {
                    if ( typeof(filter[f]) == 'undefined' ) throw new Error('filter `'+f+'` cannot be left undefined');

                    localeLowerCase = ( typeof(filter[f]) != 'boolean' ) ? filter[f].toLocaleLowerCase() : filter[f];
                    if ( filter[f] && keywords.indexOf(localeLowerCase) > -1 && localeLowerCase == 'not null' && typeof(result[o][f]) != 'undefined' && typeof(result[o][f]) !== 'object' && result[o][f] != 'null' && result[o][f] != 'undefined' ) {

                        result[o] = merge(result[o], set, true);

                    } else if ( typeof(result[o][f]) != 'undefined' && typeof(result[o][f]) !== 'object' && result[o][f] === filter[f] ) {
                        ++i;
                        if (i === condition) result[o] = merge(result[o], set, true);
                    } else if ( typeof(result[o][f]) != 'undefined' && typeof(result[o][f]) !== 'object' && result[o][f] === filter[f]) {

                        result[o] = merge(result[o], set, true);
                    }
                }
            }
        }

        // chaining
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.orderBy  = instance.orderBy;
        result.notIn    = instance.notIn;

        return result
    }

    this['replace'] = function(filter, set) {
        if ( typeof(filter) !== 'object' ) {
            throw new Error('filter must be an object');
        } else {
            var condition           = filter.count()
                , i                 = 0
                , localeLowerCase   = ''
                , result            = Array.isArray(this) ? this : JSON.parse(JSON.stringify(content));

            for (var o in result) {
                for (var f in filter) {
                    if ( typeof(filter[f]) == 'undefined' ) throw new Error('filter `'+f+'` cannot be left undefined');

                    localeLowerCase = ( typeof(filter[f]) != 'boolean' ) ? filter[f].toLocaleLowerCase() : filter[f];
                    if ( filter[f] && keywords.indexOf(localeLowerCase) > -1 && localeLowerCase == 'not null' && typeof(result[o][f]) != 'undefined' && typeof(result[o][f]) !== 'object' && result[o][f] != 'null' && result[o][f] != 'undefined' ) {

                        result[o] = set;

                    } else if ( typeof(result[o][f]) != 'undefined' && typeof(result[o][f]) !== 'object' && result[o][f] === filter[f] ) {
                        ++i;
                        if (i === condition) result[o] = set;
                    } else if ( typeof(result[o][f]) != 'undefined' && typeof(result[o][f]) !== 'object' && result[o][f] === filter[f]) {

                        result[o] = set;
                    }
                }
            }
        }

        // chaining
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.orderBy  = instance.orderBy;
        result.notIn    = instance.notIn;

        return result
    }

    this['delete'] = function(filter) {
        if ( typeof(filter) !== 'object' ) {
            throw new Error('filter must be an object');
        } else {
            var condition           = filter.count()
                , i                 = 0
                , localeLowerCase   = ''
                , _content          = Array.isArray(this) ? JSON.parse(JSON.stringify(this)) : JSON.parse(JSON.stringify(content))
                , result            = JSON.parse(JSON.stringify(_content));

            for (var o in _content) {
                for (var f in filter) {
                    if ( typeof(filter[f]) == 'undefined' ) throw new Error('filter `'+f+'` cannot be left undefined');

                    localeLowerCase = ( typeof(filter[f]) != 'boolean' ) ? filter[f].toLocaleLowerCase() : filter[f];
                    if ( filter[f] && keywords.indexOf(localeLowerCase) > -1 && localeLowerCase == 'not null' && typeof(_content[o][f]) != 'undefined' && typeof(_content[o][f]) !== 'object' && _content[o][f] != 'null' && _content[o][f] != 'undefined' ) {
                        result.splice(o, 1)
                    } else if ( typeof(_content[o][f]) != 'undefined' && typeof(_content[o][f]) !== 'object' && _content[o][f] === filter[f] ) {
                        ++i;
                        if (i === condition) result.splice(o, 1);
                    } else if ( typeof(_content[o][f]) != 'undefined' && typeof(_content[o][f]) !== 'object' && _content[o][f] === filter[f] ) {
                        result.splice(o, 1)
                    }
                }
            }
        }

        //content = result;
        return result
    }


    var sortKeywords = [ 'asc', 'desc' ];
    /**
     * sort
     *
     * @param {object|array} filter
     * */
    this['orderBy'] = function (filter) {

        if ( typeof(filter) == 'undefined' )
            throw new Error('[ Collection->sort(filter) ] where `filter` must not be empty or null' );


        var variableContent = (Array.isArray(this)) ? this : JSON.parse(JSON.stringify(content));
        return sortResult(filter, variableContent)
    }

    /**
     * sortResult
     * ref.:
     *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort
     *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/localeCompare#Browser_compatibility
     *
     * e.g.:
     *  .orderBy({ name: 'asc' })
     *
     *  // overriding filters -> last filter is always right
     *  .orderBy([ { updatedAt : 'desc'}, { name: 'asc' } ])
     *
     *  // combining filters -> the first one is always right
     *  .orderBy({ updatedAt : 'desc'}, { name: 'asc' })
     *
     * @param {object|array} filter
     * */
    var sortResult = function (filter, content) {
        if ( typeof(filter) != 'object') {
            throw new Error('`filter` parametter must be an object or an array')
        }

        var condition           = filter.count()
            , sortOp            = {}
            , key               = null
            , prop              = null
            , result            = []
            ;

        if (condition == 0) return null;


        // asc
        sortOp['asc'] = function (prop, content) {
            return content.sort(function onAscSort(a, b) {

                if ( typeof(a) == 'string' && a != '') {
                    // var fieldA = a.toUpperCase(); // ignore upper and lowercase
                    // var fieldB = b.toUpperCase(); // ignore upper and lowercase
                    //
                    // if (fieldA < fieldB) {
                    //     return -1;
                    // }
                    //
                    // if (fieldA > fieldB) {
                    //     return 1;
                    // }
                    //
                    // // fields must be equal
                    // return 0;

                    return a.localeCompare(b)

                } else if ( typeof(a) == 'boolean' || typeof(b) == 'boolean' ) {

                    if (typeof(a) == 'boolean' ) {
                        a = (a) ? 1: 0;
                    }
                    if (typeof(b) == 'boolean' ) {
                        b = (b) ? 1: 0;
                    }

                    if (a > b) {
                        return 1;
                    }
                    if (a < b) {
                        return -1;
                    }

                    // a must be equal to b
                    return 0;

                } else if ( typeof(a) == 'object' ) {
                    try {
                        if ( typeof(a[prop]) == 'number' ) {

                            a[prop] = '' + a[prop];
                            b[prop] = '' + b[prop];
                        }

                        return a[prop].localeCompare(b[prop], { numeric: true})

                    } catch (err) {
                        return -1
                    }

                } else {
                    if (a > b) {
                        return 1;
                    }
                    if (a < b) {
                        return -1;
                    }
                    // a must be equal to b
                    return 0;
                }
            })
        }

        // desc
        sortOp['desc'] = function (prop, content) {
            return sortOp['asc'](prop, content).reverse()
        }

        if ( Array.isArray(filter) ) {

            for (var f = 0, len = filter.length; f < len; ++f) {

                prop    = Object.keys(filter[f])[0];
                key     = filter[f][prop];

                result  = sortOp[key](prop, content);
            }
        } else {

            if (filter.count() > 1) {

                for (var f in filter) {
                    prop    = Object.keys(filter)[0];
                    key     = filter[prop];

                    result  = sortOp[key](prop, content);
                }

            } else {
                prop    = Object.keys(filter)[0];
                key     = filter[prop];

                result  = sortOp[key](prop, content);
            }
        }



        // chaining
        result.findOne  = instance.findOne;
        result.limit    = instance.limit;
        result.notIn    = instance.notIn;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.delete   = instance.delete;

        return result
    };

};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = Collection
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define(function() { return Collection })
}