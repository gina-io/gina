'use strict';
if ( typeof(module) !== 'undefined' && module.exports ) {
    var lib = require('../../index');
}

/**
 * Collection cLass
 * Allows you to handle your own collections as you would normaly with mongodb
 * Dependencies :
 *  - lib/merge
 *  - uuid
 *
 *
 * @param {array} collection
 * @param {object} [options]
 *
 * @returns {object} instance
 *
 * Collection.length will return result length : dont't use .count() which is going to include functions to the count
 *
 * Collection::find
 *  @param {object} filter
 *      eg.: { uid: 'someUID' }
 *      eg.: { type: 'not null', country: 'France' } // `AND` clause
 *      NB.: To filter `not empty`, use { type: '!=""' }
 *      eg.: { country: 'The Hashemite Kingdom of Jordan' }, { country: 'Libanon'} // `OR` clause
 *      eg.: { 'obj.prop': true }
 *      eg.: { 'contacts[*].name': 'Doe' } // `WITHIN` (array|collection) clause
 *      eg.: { lastUpdate: '>= 2016-12-01T00:00:00' }  // also available for date comparison `=`, `<`, `>`
 *      eg.: { activity: null }
 *      eg.: { isActive: false }
 *
 *  @returns {array} result
 *
 * Collection::findOne
 *  @param {object} filter
 *  @returns {object|array|string} result
 *
 * Collection::update
 *  @param {object} filter
 *  @param {object} set
 *
 *  @returns {array} result
 *      rasult.toRaw() will give result without chaining & _uuid
 *
 * */
function Collection(content, options) {

    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
    var uuid            = (isGFFCtx) ? require('vendor/uuid') : require('uuid');
    var merge           = (isGFFCtx) ? require('lib/merge') : require('../../../lib/merge');

    // defined search option rules
    var searchOptionRules = {
        isCaseSensitive: {
            false: {
                re: '^%s$',
                modifiers: 'i'
            },
            true: {
                re: '^%s$'
            }
        }
    };
    var withOrClause = false;
    var notInSearchModeEnabled = false;

    var localSearchOptions  = null;

    var defaultOptions = {
        useLocalStorage: false,
        locale: 'en', // TODO - get settigs.region, or user.region
        searchOptionRules: searchOptionRules
    };



    options = (typeof(options) == 'object') ? merge(options, defaultOptions) : defaultOptions;

    var keywords    = ['not null']; // TODO - null, exists (`true` if property is defined)
    var tryEval     = function(condition) {
        try {
            return eval(condition);
        } catch(err) {
            throw new Error('Could not evaluate condition `'+ condition +'`.\n' + err.stack );
        }
    }

    if (typeof(content) == 'undefined' || content == '' || content == null)
        content = [];

    if ( !Array.isArray(content) )
        throw new Error('`new Collection([content] [, options] )`: `content` argument must be an Array !');

    content = (content) ? JSON.clone(content) : []; // original content -> not to be touched

    // Indexing : uuids are generated for each entry
    var searchIndex = [], idx = 0;
    for (var entry = 0, entryLen = content.length; entry < entryLen; ++entry) {
        if (!content[entry]) {
            content[entry] = {};
        }
        content[entry]._uuid = uuid.v4();
        // To avoid duplicate entries
        searchIndex[idx] = content[entry]._uuid;
        ++idx;
    }

    var instance = content;
    /**
     * Set local search option for the current collection method call
     *
     * eg.:
     *  var recCollection = new Collection(arrayCollection);
     *  var rec =  recCollection
     *                  .setSearchOption('name', 'isCaseSensitive', false)
     *                  .find({ city: 'cap Town' });
     *
     * eg.:
     *  var recCollection = new Collection(arrayCollection);
     *  var searchOptions = {
     *      name: {
     *          isCaseSensitive: false
     *      }
     *  };
     *  var rec =  recCollection
     *                  .setSearchOption(searchOptions)
     *                  .find({ city: 'cap Town' });     *
     *
     * @param {object|string} searchOptionObject or searchOptionTargetedProperty
     * @param {string} [searchRule]
     * @param {boolean} [searchRuleValue] - true to enable, false to disabled
     *
     * @returns {object} instance with local search options
     */
    instance['setSearchOption'] = function() {

        if (!arguments.length)
            throw new Error('searchOption cannot be left blank');

        if (arguments.length > 3 || arguments.length < 3 && arguments.length > 1)
            throw new Error('argument length mismatch');

        var i       = 0
            , len   = arguments.length
        ;

        if (arguments.length == 1) {
            if ( typeof(arguments[0]) != 'object' )
                throw new Error('searchOption must be an object');

            for (var prop in arguments[0]) {
                if ( typeof(searchOptionRules[prop]) == 'undefined' )
                    throw new Error(arguments[1] + ' is not an allowed searchOption !');
            }

            localSearchOptions = arguments[0];
        } else {

            if ( !localSearchOptions )
                localSearchOptions = {};

            for (; i < len; ++i) {
                if ( typeof(searchOptionRules[arguments[1]]) == 'undefined' )
                    throw new Error(arguments[1] + ' is not an allowed searchOption !');

                if (typeof(localSearchOptions[arguments[0]]) == 'undefined')
                    localSearchOptions[arguments[0]] = {};

                if ( /true|false/i.test(arguments[2]) ) {
                    localSearchOptions[arguments[0]][arguments[1]] = /true/i.test(arguments[2]) ? true : false
                } else {
                    localSearchOptions[arguments[0]][arguments[1]] = arguments[2]
                }
            }
        }

        return instance
    }


    instance['find'] = function() {
        // reset
        withOrClause = false;

        if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
            withOrClause = arguments[arguments.length-1];
            delete arguments[arguments.length-1];
            --arguments.length;
        }

        var filtersStr      = null;
        var filters         = null;
        var filtersCount    = null;
        try {
            filtersStr      = JSON.stringify(arguments);
            filters         = JSON.parse(filtersStr);
            filtersCount    = filters.count();
        } catch( filtersError) {
            throw new Error('filter must be an object\n'+ filtersError.stack);
        }

        if ( typeof(filters) != 'undefined' && filtersCount > 0 ) {

            if (filtersCount > 1) {
                withOrClause = true;
            }
            // checking filter : this should be forbidden -> { type: 'red', type: 'orange'}
            // var filtersFields = null;
            // for (let f = 0, fLen = filters.count(); f < fLen; f++) {
            //     filtersFields = {};
            //     for (let fField in filters[f]) {
            //         if (  typeof(filtersFields[ fField ]) != 'undefined' ) {
            //             throw new Error('Filter field can only be defined once inside a filter object !\n`Field '+ fField +'` is already defined : '+ filters[f])
            //         }
            //         filtersFields[ fField ] = true;
            //     }
            // }

            var filter              = null
                , condition         = null
                , i                 = 0
                //, tmpContent        = ( Array.isArray(this) && !withOrClause) ? this : JSON.clone(content)
                , tmpContent        = ( Array.isArray(this) ) ? this : JSON.clone(content)
                , resultObj         = {}
                , result            = []
                , localeLowerCase   = ''
                , re                = null
                , field             = null
                , fieldWithin       = null
                , value             = null
                , searchOptions     = localSearchOptions
                , searchOptionRules = options.searchOptionRules
            ;

            var matched = null
                , filterIsArray = null
                , searchResult = [];

            /**
             *  Regular Search
             * @param {object} filter
             * @param {string} field
             * @param {strine|number|date} _content
             * @param {number} matched
             */
            var search = function(filter, field, _content, matched, searchOptionRules) {
                var reValidCount = null, searchOptCount = null;
                if (filter === null && _content === null) { // null case

                    ++matched;

                } else if (
                    filter
                    && keywords.indexOf(localeLowerCase) > -1
                    && localeLowerCase == 'not null'
                    && typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && _content != 'null'
                    && _content != 'undefined'
                ) {

                    if (result.indexOf(_content) < 0) {
                        ++matched;
                    }

                } else if (
                    typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && /(<|>|=)/.test(filter)
                    && !/undefined|function/.test(typeof(_content))
                ) { // with operations
                    let originalFilter = filter;
                    let condition = _content + filter;
                    if ( typeof(filter) == 'string' && typeof(_content) == 'string' ) {
                        let comparedValue = filter.replace(/^(<=|>=|!==|!=|===|!==)/g, '');
                        if ( typeof(_content) == 'string' && !/^\"(.*)\"$/.test(comparedValue) ) {
                            filter = filter.replace(comparedValue, '\"'+ comparedValue + '\"');
                        }
                        condition = '\"'+_content+'\"' + filter;
                        // restoring in case of datetime eval
                        filter = originalFilter;
                    }

                    // looking for a datetime ?
                    if (
                        /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test(_content)
                        && /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test(filter)
                    ) {

                        if (tryEval(_content.replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")') + filter.replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")'))) {
                            ++matched;
                        }

                    } else if (tryEval(condition)) {
                        ++matched;
                    }

                } else if (
                    typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && _content === filter
                    && !searchOptions
                    ||
                    typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && _content === filter
                    && typeof(searchOptions[field]) == 'undefined'
                ) {

                    ++matched;
                } else if (
                    typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && searchOptions
                    && typeof(searchOptions[field]) != 'undefined'
                ) {

                    reValidCount    = 0;
                    searchOptCount  = searchOptions[field].count();
                    for ( var rule in searchOptions[field]) {
                        searchOptionRules[rule][searchOptions[field][rule]].re = searchOptionRules[rule][searchOptions[field][rule]].re.replace(/\%s/, filter);

                        if (searchOptionRules[rule][searchOptions[field][rule]].modifiers) {
                            re = new RegExp(searchOptionRules[rule][searchOptions[field][rule]].re, searchOptionRules[rule][searchOptions[field][rule]].modifiers);
                        } else {
                            re = new RegExp(searchOptionRules[rule][searchOptions[field][rule]].re);
                        }

                        if ( re.test(_content) ) {
                            ++reValidCount
                        }
                    }

                    if (reValidCount == searchOptCount) {
                        ++matched;
                    }
                }

                return {
                    matched: matched
                };
            }

            var searchThroughProp = function(filter, f, _content, matched) {

                var field = f.split(/\./g);
                field = field[field.length - 1];
                re = new RegExp('("' + field + '":\\w+)');

                var value = null;

                try {
                    if ( _content )
                        value = eval('_content.'+f);
                } catch (err) {
                    // Nothing to do
                    // means that the field is not available in the collection
                }



                if (value /** && value.length > 0*/) {
                    if ( Array.isArray(value) )
                        value = value[1].split(/:/)[1];
                    else if ( typeof(value) == 'string' && /\:/.test(value) )
                        value = value.split(/:/)[1];


                    if (/(<|>|=)/.test(filter)) {

                        // looking for a datetime ?
                        if (
                            /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test(value)
                            && /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test(filter)
                        ) {

                            if (tryEval(value.replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")') + filter.replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")'))) {

                                ++matched;
                            }

                        } else if (tryEval(value + filter)) {

                            ++matched;
                        }

                    } else {
                        if (value == filter) {
                            ++matched;
                        }
                    }

                }

                return {
                    matched: matched
                }
            }

            // if one of the entry matches the given filter, tag the whole entry as matched
            var searchWithin = function(filter, f, _content, matched, i) {

                var collectionName  = null
                    , collection    = null
                    , arr           = null
                    , field         = null;


                arr = f.split(/\[\*\]/g);
                collectionName = arr[0].replace(/\[\*\]/, '');// only take the first collection
                collection = _content[ collectionName ];


                field = arr[1];
                if (/^\./.test(field) )
                    field = field.substr(1);

                var subMatched = 0;
                if (collection) {

                    for (var c = 0, cLen = collection.length; c < cLen; ++c) {
                        // cases with _filter.prop
                        if (/\./.test(field)) {

                            searchResult = searchThroughProp(filter, field, collection[c], subMatched);
                            subMatched = searchResult.matched;

                        } else { // normal case

                            searchResult = search(filter, field, collection[c], subMatched, searchOptionRules);
                            subMatched = searchResult.matched;
                        }

                        if (subMatched > 0) break;
                    }
                }

                return {
                    matched: (matched + subMatched)
                }
            }


            for (var o in tmpContent) {

                if (!tmpContent[o]) {
                    tmpContent[o] = {}
                }

                if (!/undefined|function/.test( typeof(tmpContent[o]))) {

                    for (let l = 0, lLen = filters.count(); l<lLen; ++l) {
                        filter = filters[l];
                        condition = filter.count();
                        // for each condition
                        matched = 0;

                        for (var f in filter) {
                            if ( typeof(filter[f]) == 'undefined' ) throw new Error('filter `'+f+'` cannot be left undefined');

                            localeLowerCase = ( filter[f] !== null && !/(boolean|number)/.test(typeof(filter[f])) ) ? filter[f].toLocaleLowerCase() : filter[f];

                            // cases with tmpContent.prop
                            if (/\./.test(f)) {
                                //JSON.stringify(tmpContent[o]).match(/("gross":\w+)/)[1].split(/:/)[1]

                                // detect if array|collection case
                                if (/\[\*\]/.test(f)) {

                                    searchResult = searchWithin(filter[f], f, tmpContent[o], matched, 0);
                                    matched = searchResult.matched;

                                } else {

                                    searchResult = searchThroughProp(filter[f], f, tmpContent[o], matched);
                                    matched = searchResult.matched;
                                }

                            } else { // normal case

                                searchResult = search(filter[f], f, tmpContent[o][f], matched, searchOptionRules);
                                matched = searchResult.matched;
                            }
                        }

                        if (matched == condition ) { // all conditions must be fulfilled to match
                            // `this` {Array} is the result of the previous search or the current content
                            // TODO - Add a switch
                            if (
                                withOrClause
                                && notInSearchModeEnabled
                                && searchIndex.indexOf(tmpContent[o]._uuid) < 0
                                || notInSearchModeEnabled
                                || !withOrClause
                            ) {
                                //console.debug('searchIndex ', searchIndex);
                                if (!withOrClause || withOrClause && result.indexOf(tmpContent[o]._uuid) < 0 || notInSearchModeEnabled) {
                                    result[i] = tmpContent[o];
                                    ++i;
                                }
                            } else if (
                                withOrClause
                                && !notInSearchModeEnabled
                            ) {
                                if (result.indexOf(tmpContent[o]._uuid) < 0) {
                                    result[i] = tmpContent[o];
                                    ++i;
                                }
                            }
                        }

                    }

                }
            }
        } else {
            result = content
        }

        // reset localSearchOptions for nest calls
        localSearchOptions = null;

        // TODO - remove this
        //if (withOrClause) {
            // merging with previous result
            //console.debug('withOrClause: supposed to merge ? \nnotInSearchModeEnabled: '+notInSearchModeEnabled+'\nResult: ' +result)//+'\nThis: '+ this.toRaw();
            // if (!notInSearchModeEnabled) {
            //     result  = merge(this, result);
            // }
            // TODO - remove this part
            // Removed this on 2021-01-21 because it was causing duplicate content
            //result  = merge(this, result, true)
        //}

        // chaining
        //result._options         = instance._options;
        //result.setSearchOption  = instance.setSearchOption;

        result.insert           = instance.insert;
        result.notIn            = instance.notIn;
        result.find             = this.find;
        result.update           = instance.update;
        result.replace          = instance.replace;
        result.or               = instance.or;
        result.findOne          = instance.findOne;
        result.limit            = instance.limit;
        result.orderBy          = instance.orderBy;
        result.delete           = instance.delete;
        result.toRaw            = instance.toRaw;
        result.filter           = instance.filter;

        return result
    }

    /**
     * findOne
     *
     * E.g.:
     *  - new Collection(projects).findOne({name: 'My Project'})
     *  - new Collection(projects)
     *              .setSearchOption({name: { isCaseSensitive: false }})
     *              .findOne({name: 'my project'})
     *
     *
     * Available options :
     *  isCaseSensitive: [true|false] - set to true by default
     *
     * @param {object} filter
     *
     * @returns {object} result
     *
    */
    instance['findOne'] = function() {
        var key         = null // comparison key
            , result    = null
            , filters   = null
            //, uuidSearchModeEnabled = true
        ;

        if ( typeof(arguments[arguments.length-1]) == 'string' ) {
            key = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        // if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
        //     uuidSearchModeEnabled = arguments[arguments.length - 1]
        //     delete arguments[arguments.length - 1];
        //     --arguments.length;
        // }

        if (arguments.length > 0) {
            filters = arguments;
        }


        if ( typeof(filters) == 'undefined' || !filters || typeof(filters) != 'object' ) {
            throw new Error('[ Collection ][ findOne ] `filters` argument must be defined: Array or Filter Object(s) expected');
        }

        // If an operation (find, insert ...) has been executed, get the previous result; if not, get the whole collection
        //var currentResult = JSON.clone( (Array.isArray(this)) ? this : content );
        var currentResult = null;
        var foundResults = null;
        if ( Array.isArray(arguments[0]) ) {
            foundResults = arguments[0];
        } else {
            foundResults = instance.find.apply(this, arguments) || [];
        }

        if (foundResults.length > 0) {
            currentResult = foundResults.limit(1).toRaw()[0];
        }

        result          = currentResult;
        return result
    }


    instance['or'] = function () {
        arguments[arguments.length] = true;
        ++arguments.length;

        return instance.find.apply(this, arguments);
    }

    instance['limit'] = function(resultLimit) {
        if ( typeof(resultLimit) == 'undefined' || typeof(resultLimit) != 'number' ) {
            throw new Error('[Collection::result->limit(resultLimit)] : `resultLimit` parametter must by a `number`')
        }

        var result = Array.isArray(this) ? this : JSON.clone(content);

        //resultLimit
        result = result.splice(0, resultLimit);

        // chaining
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.notIn    = instance.notIn;
        result.findOne  = instance.findOne;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }

    /**
     * notIn
     * Works like a filter to match results by `excluding` through given `filters` !!
     *
     *  filter can be like
     *      { car: 'toyota' }
     *      { car: 'toyota', color: 'red' }
     *
     *  You can pass more than one filter
     *      { car: 'toyota', color: 'red' }, { car: 'porche' }
     *
     * .notIn(filter) // AND syntax
     * .notIn(filter1, filter2, filter3) // OR syntax
     * .notIn(filter, 'id') where `id` is the uuid used for the DIFF - `_uuid
     * .noIn(collectionObj, 'id')
     *
     * By default, Collection use its own internal `_uuid` to search and compare.
     * This mode is called `uuidSearchModeEnabled`, and it is by default set to `true`.
     * If you want to disable this mode in order to MATCH/DIFF by forcing check on every single filter
     * of the resultset :
     *      .notIn(filter, false) where false must be a real boolean
     *
     *
     *
     * @param {object|array} filters|arrayToFilter - works like find filterss
     * @param {string} [key] - unique id for comparison; faster when provided
    */
    instance['notIn'] =  function(){

        var arrayToFilter           = null // [] those that we don't want in the result
            , key                   = null //  string comparison key
            , result                = null
            , filters               = null
            , uuidSearchModeEnabled = true
        ;

        if ( typeof(arguments[arguments.length-1]) == 'string' ) {
            key = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
            uuidSearchModeEnabled = arguments[arguments.length - 1]
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        if (arguments.length > 0) {
            filters = arguments;
        }


        if ( typeof(filters) == 'undefined' || !filters || typeof(filters) != 'object' ) {
            throw new Error('[ Collection ][ notIn ] `filters` argument must be defined: Array or Filter Object(s) expected');
        }

        // If an operation (find, insert ...) has been executed, get the previous result; if not, get the whole collection
        var currentResult = JSON.clone( (Array.isArray(this)) ? this : content );

        var foundResults = null;
        if ( Array.isArray(arguments[0]) ) {
            foundResults    = arguments[0];
        } else {
            notInSearchModeEnabled = true;
            foundResults    = instance.find.apply(this, arguments) || [];
            notInSearchModeEnabled = false;
        }


        if (foundResults.length > 0) {

            // check key
            if (
                uuidSearchModeEnabled
                && key
                && typeof(foundResults[0]) == 'undefined'
                && typeof(foundResults[0][key]) == 'undefined'
            ) {
                throw new Error('[ Collection ][ notIn ] `key` not valid');
            } else if ( uuidSearchModeEnabled && !key && typeof(foundResults[0]['_uuid']) != 'undefined' ) {
                key = '_uuid'
            } else if ( typeof(foundResults[0]['id']) != 'undefined' ) {
                key = 'id';
            }

            if ( !key || typeof(foundResults[0][key]) == 'undefined' ) {
                throw new Error('No comparison key defined !')
            }

            // fast search with key
            var r       = 0
                , rLen  = foundResults.length
                , c     = 0
                , cLen  = currentResult.length
                , f     = 0
                , fLen  = filters.count()
                , keyLen    = null
                , matched = 0
                , fullFiltersMatched = 0
            ;
            if ( uuidSearchModeEnabled && typeof(currentResult[c]) != 'undefined' && currentResult[c].hasOwnProperty(key) ) {
                // for every single result found
                for (; r < rLen; ++r) {

                    if (!currentResult.length) break;

                    c = 0; cLen = currentResult.length;
                    for (; c < cLen; ++c) {
                        if ( typeof(currentResult[c]) == 'undefined' || typeof(foundResults[r]) == 'undefined' ) {
                            continue
                        }
                        // when matched, we want to remove those not in current result
                        if (currentResult[c][key] === foundResults[r][key]) {
                            currentResult.splice(c,1);
                            break;
                        }
                    }
                }
            } else if ( typeof(currentResult[c]) == 'undefined' ) { //empty source case
                // means that since we don't have a source to compare, current === found
                currentResult = JSON.clone(foundResults);

            } else { // search based on provided filters
                // for every single result found
                for (; r < rLen; ++r) {
                    if (!currentResult.length) break;

                    //onRemoved:
                    c = 0; cLen = currentResult.length;
                    for (; c < cLen; ++c) { // current results

                        if ( typeof (currentResult[c]) != 'undefined' ) {

                            // for each filter
                            fullFiltersMatched = 0;
                            f = 0;
                            for (; f < fLen; ++f ) {
                                if ( typeof(filters[f]) == 'undefined' ) throw new Error('filter `'+f+'` cannot be left undefined');

                                keyLen = filters[f].count();
                                matched = 0;
                                for (key in filters[f]) {
                                    if ( currentResult[c].hasOwnProperty(key) && currentResult[c][key] === foundResults[r][key] ) {
                                        ++matched;
                                    }
                                }
                                if (matched == keyLen) {
                                    ++fullFiltersMatched
                                }
                            }

                            if (fullFiltersMatched) {
                                currentResult.splice(c,1);
                                //break onRemoved;
                                break;
                            }

                        }
                    }
                }
            }

        }

        result          = currentResult;
        result.notIn    = instance.notIn;
        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.insert   = instance.insert;
        result.replace  = instance.replace;
        result.update   = instance.update;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }

    instance['insert'] = function (set) {

        var result = null;
        if ( typeof(set) !== 'object' ) {
            throw new Error('filter must be an object');
        } else {

            var tmpContent = Array.isArray(this) ? this : content;

            // Indexing;
            set._uuid = uuid.v4();
            tmpContent.push(set);

            result = tmpContent;
        }

        // chaining
        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.notIn    = instance.notIn;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }

    /**
     * update
     *
     * @param {object} filter
     * @param {object} set
     *
     * @returns {objet} instance
     */
    instance['update'] = function() {
        var key         = '_uuid' // comparison key is _uuid by default
            , result    = null
            , filters   = null
            , set       = null
            //, uuidSearchModeEnabled = true
        ;

        // comparison key  : _uuid by default, but can be set to id
        if ( typeof(arguments[arguments.length-1]) == 'string' ) {
            key = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        if ( typeof(arguments[arguments.length-1]) == 'object' ) {
            set = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length
        }

        // if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
        //     uuidSearchModeEnabled = arguments[arguments.length - 1]
        //     delete arguments[arguments.length - 1];
        //     --arguments.length;
        // }

        if (arguments.length > 0) {
            filters = arguments;
        }


        if ( typeof(filters) == 'undefined' || !filters || typeof(filters) != 'object' ) {
            throw new Error('[ Collection ][ update ] `filters` argument must be defined: Array or Filter Object(s) expected');
        }

        if ( typeof(set) == 'undefined' || !set || typeof(set) != 'object' ) {
            throw new Error('[ Collection ][ update ] `set` argument must be defined: Object expected');
        }

        // If an operation (find, insert ...) has been executed, get the previous result; if not, get the whole collection
        var foundResults = null;
        if ( Array.isArray(arguments[0]) ) {
            foundResults = arguments[0];
        } else {
            foundResults = instance.find.apply(this, arguments) || [];
        }

        result = Array.isArray(this) ? this : JSON.clone(content);
        if (foundResults.length > 0 ) {
            var arr = foundResults.toRaw();
            for (var a = 0, aLen = arr.length; a < aLen; ++a) {
                arr[a] = merge(JSON.clone(set), arr[a]);
                // arr[a] = merge(set, arr[a]);
                for (var r = 0, rLen = result.length; r < rLen; ++r) {
                    if ( typeof(result[r][key]) == 'undefined' && key == '_uuid' && typeof(result[r]['id']) != 'undefined' ) {
                        key = 'id';
                    }

                    if ( result[r][key] == arr[a][key] ) {
                        result[r] = arr[a];
                        break;
                    }
                }
            }
        }

        // chaining
        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.notIn    = instance.notIn;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }


    instance['replace'] = function() {
        var key         = '_uuid' // comparison key
            , result    = null
            , filters   = null
            , set       = null
            //, uuidSearchModeEnabled = true
        ;


        if ( typeof(arguments[arguments.length-1]) == 'string' ) {
            key = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        if ( typeof(arguments[arguments.length-1]) == 'object' ) {
            set = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        // if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
        //     uuidSearchModeEnabled = arguments[arguments.length - 1]
        //     delete arguments[arguments.length - 1];
        //     --arguments.length;
        // }

        if (arguments.length > 0) {
            filters = arguments;
        }


        if ( typeof(filters) == 'undefined' || !filters || typeof(filters) != 'object' ) {
            throw new Error('[ Collection ][ update ] `filters` argument must be defined: Array or Filter Object(s) expected');
        }

        if ( typeof(set) == 'undefined' || !set || typeof(set) != 'object' ) {
            throw new Error('[ Collection ][ update ] `set` argument must be defined: Object expected');
        }

        // If an operation (find, insert ...) has been executed, get the previous result; if not, get the whole collection
        //var currentResult = JSON.clone( (Array.isArray(this)) ? this : content );
        var currentResult = null;
        var foundResults = null;
        if ( Array.isArray(arguments[0]) ) {
            foundResults = arguments[0];
        } else {
            foundResults = instance.find.apply(this, arguments) || [];
        }

        result = Array.isArray(this) ? this : JSON.clone(content);
        if (foundResults.length > 0 ) {
            var arr = foundResults.toRaw();
            for (var a = 0, aLen = arr.length; a < aLen; ++a) {
                arr[a] = JSON.clone(set);
                for (var r = 0, rLen = result.length; r < rLen; ++r) {
                    if ( typeof(result[r][key]) == 'undefined' && key == '_uuid' && typeof(result[r]['id']) != 'undefined' ) {
                        key = 'id';
                    } else if (typeof(result[r][key]) == 'undefined' && key == '_uuid') {
                        throw new Error('No comparison key defined !')
                    }

                    if ( result[r][key] == arr[a][key] ) {
                        result[r] = arr[a];
                        break;
                    }
                }
            }
        }

        // chaining
        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.notIn    = instance.notIn;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }

    /**
     * .delete({ key: 2 })
     * .delete({ name: 'Jordan' }, ''id) where id will be use as the `uuid` to compare records
     *
     * AND syntax
     * .delete({ car: 'toyota', color: 'red' })
     *
     * OR syntax
     * .delete({ car: 'toyota', color: red }, { car: 'ford' } ) // will delete all `toyota red cars` & all `ford cars`
     *
     *  N.B.: will not affect current result - just returning the DIFF
     *  If you
     * @param {object} filter - samme as `.find(filter)`
     * @param {string|boolean} [ uuid | disabled ] - by default, Collection is using its internal _uuid
     * If you want to delete without key comparison, disable `uuid` search mode
     * .delete({ name: 'Jordan' }, false)
     *
     * @returns {array} result
     */
    instance['delete'] = function() {

        var result = instance.notIn.apply(this, arguments);

        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.notIn    = instance.notIn;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;
        result.delete   = this.delete;

        return result
    }


    var sortKeywords = [ 'asc', 'desc' ];
    /**
     * sort
     *
     * @param {object|array} filter
     * */
    instance['orderBy'] = function () {

        if ( typeof(arguments) == 'undefined' || arguments.length < 1)
            throw new Error('[ Collection->orderBy(filter) ] where `filter` must not be empty or null' );

        var filter = null;
        if ( arguments.length == 1 ) {
            filter = arguments[0];
        } else {
            // converting arguments into array
            filter = new Array(arguments.length);
            for (var f = 0, fLen = filter.length; f < fLen; ++f) {
                filter[f] = arguments[f]
            }
        }

        var variableContent = (Array.isArray(this)) ? this : JSON.clone(content);
        return sortResult(filter, variableContent.toRaw())
    }

    /**
     * max
     * E.g:
     *  myCollection.max({ order: 'not null'})
     *      => 5
     *  myCollection.max({ createAt: 'not null'})
     *      => '2021-12-31T23:59:59'
     *  myCollection.max({ firstName: 'not null'})
     *      => 'Zora'
     *
     * @param {object|array} filter
     *
     * @returns {number|date|string}
     * */
    instance['max'] = function () {
        if ( typeof(arguments) == 'undefined' || arguments.length < 1)
            throw new Error('[ Collection->max(filter) ] where `filter` must not be empty or null' );

        var filter = null;
        if (
            arguments.length > 1
            || Array.isArray(arguments[0])
            || typeof(arguments[0]) == 'object' && arguments[0].count() > 1
        ) {
            throw new Error('[ Collection->max(filter) ] only accept one filter length, and fileter count must be equal to 1' );
        }
        filter = arguments[0];
        try {
            var key = Object.keys(filter)[0];
            var subFilter = {};
            subFilter[key] = 'desc';
            return instance['find'](filter).orderBy(subFilter).limit(1)[0][key];
        } catch (err) {
            throw err
        }
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
     *  // sorting boolean
     *  .orderBy({ isActive: 'desc'}) => will display all active(TRUE) first
     *  NB.: Boolean are 0 (FALSE) or 1 (TRUE)
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
            , multiSortOp       = null
            , sortRecursive     = null
            , key               = null
            , prop              = null
            , result            = []
        ;

        if (condition == 0) return null;


        // asc
        sortOp['asc'] = function (prop, content) {

            var mapped = content.map(function(obj, i) {
                var _m = {};
                _m.index = i;
                _m[prop] = obj[prop];
                return _m;
            });

            mapped.sort(function onAscSort(a, b) {


                var _compare = function(a, b) {
                    // handle booleans
                    if ( /^(true|false)$/i.test(a) ) {
                        a = ( /true/i.test(a) ) ? 1 : 0;
                    }

                    if ( /^(true|false)$/i.test(b) ) {
                        b = ( /true/i.test(b) ) ? 1 : 0;
                    }


                    if ( typeof(a) == 'string' && a != '' ||  typeof(b) == 'string' ) {

                        if ( typeof(a) == 'number' ) {
                            a = ''+a; // cast to string
                        }
                        if ( typeof(b) == 'number' ) {
                            b = ''+b; // cast to string
                        }

                        return a.localeCompare(b, undefined, {sensitivity: 'case', caseFirst: 'upper'})
                    }

                    if (a > b) {
                        return 1;
                    }
                    if (a < b) {
                        return -1;
                    }
                    // a must be equal to b
                    return 0;
                }


                if ( typeof(a) == 'object' ) {
                    return _compare(a[prop], b[prop])
                }

                return _compare(a, b)

            });

            return mapped.map(function(m, index, result){
                return content[m.index];
            });
        }

        // desc
        sortOp['desc'] = function (prop, content) {
            return sortOp['asc'](prop, content).reverse()
        }

        multiSortOp = function(content, filter) {

            var props = [], keys = [];

            if ( Array.isArray(filter) ) {
                for (var f = 0, fLen = filter.length; f < fLen; ++f) {
                    props[f] = Object.keys(filter[f])[0];
                    keys[f] = filter[f][ props[f]] ;
                }
            } else {
                var f = 0;
                for (var flt in filter) {
                    props[f] = flt;
                    keys[f] = filter[flt] ;
                    ++f;
                }
            }



            sortRecursive = function(a, b, columns, order_by, index) {

                var direction = order_by[index] == 'desc' ? 1 : 0;

                var res = null, x = null, y = null;

                if ( typeof(a[columns[index]]) == 'string' && a[columns[index]] != '' ) {

                    res = a[columns[index]].localeCompare(b[columns[index]]);

                    if ( direction == 0 && res != 0 ) {
                        return res < 0 ? -1 : 1
                    } else if (res != 0) {
                        return res < 0 ? 1 : -1
                    }

                    // a must be equal to b
                    return columns.length - 1 > index ? sortRecursive(a, b, columns, order_by, index + 1) : 0;

                } else if (typeof (a[columns[index]]) == 'number' || typeof(b[columns[index]]) == 'number' ) {

                    res = (''+ a[columns[index]]).localeCompare((''+ b[columns[index]]), undefined, { numeric: true });

                    if (direction == 0 && res != 0) {
                        return res < 0 ? -1 : 1
                    } else if (res != 0) {
                        return res < 0 ? 1 : -1
                    }

                    // a must be equal to b
                    return columns.length - 1 > index ? sortRecursive(a, b, columns, order_by, index + 1) : 0;

                } else if ( typeof(a[columns[index]]) == 'boolean' || typeof (b[columns[index]]) == 'boolean' ) {

                    if ( typeof(a[columns[index]]) == 'boolean' ) {
                        x = (a[columns[index]]) ? 1 : 0;
                    }

                    if ( typeof(b[columns[index]]) == 'boolean' ) {
                        y = (b[columns[index]]) ? 1 : 0;
                    }

                    if (x > y) {
                        return direction == 0 ? 1 : -1;
                    }

                    if (x < y) {
                        return direction == 0 ? -1: 1;
                    }

                    // a must be equal to b
                    return columns.length - 1 > index ? sortRecursive(a, b, columns, order_by, index + 1) : 0;

                } else {

                    if (a[columns[index]] > b[columns[index]]) {
                        return direction == 0 ? 1 : -1;
                    }

                    if (a[columns[index]] < b[columns[index]]) {
                        return direction == 0 ? -1 : 1;
                    }
                    // a must be equal to b
                    return columns.length - 1 > index ? sortRecursive(a, b, columns, order_by, index + 1) : 0;
                }
            }

            return content.sort(function onMultiSort(a, b) {
                return sortRecursive(a, b, props, keys, 0);
            });
            // return mapped.map(function(m, index, result){
            //     return content[m.index];
            // });
        }

        if ( Array.isArray(filter) || filter.count() > 1 ) {

            result = multiSortOp(content, filter);

        } else {

            prop    = Object.keys(filter)[0];
            key     = filter[prop];

            result  = sortOp[key](prop, content);
        }



        // chaining
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.limit    = instance.limit;
        result.notIn    = instance.notIn;
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.delete   = instance.delete;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    };

    /**
     * toRaw
     * Transform result into a clean format (without _uuid)
     *
     * @returns {array} result
     * */
    instance['toRaw'] = function() {

        var result = ( Array.isArray(this) ) ? this.slice() : content.slice();
        // cleanup
        for (var i = 0, len = result.length; i < len; ++i) {
            if (result[i]._uuid)
                delete result[i]._uuid;

        }

        // return JSON.clone(result);
        return result
    }

    /**
     * filter
     * Reduce record propName
     * @param {string|array} filter
     *  e.g: 'id'
     *  e.g: ['id', 'name']
     *
     * @returns {array} rawFilteredResult
     * */
     instance['filter'] = function(filter) {

        if ( typeof(filter) == 'undefined' ) {
            throw new Error('`filter` parametter must be a string or an array.');
        }
        var result = ( Array.isArray(this) ) ? this : content;
        if ( !result.length ) {
            return []
        }
        var i = 0, len = result.length;
        var rawFilteredResult = [], fCount = 0;

        if ( Array.isArray(filter) ) {
            var f = null, fLen = filter.length, wrote = null;
            for (; i < len; ++i) {
                wrote = false;
                f = 0;
                for (; f < fLen; ++f) {
                    if ( typeof(result[i][ filter[f] ]) != 'undefined' ) {
                        if ( typeof(rawFilteredResult[fCount]) == 'undefined' ) {
                            rawFilteredResult[fCount] = {}
                        }
                        rawFilteredResult[fCount][ filter[f] ] = result[i][ filter[f] ];
                        wrote = true;
                    }
                }
                if (wrote)
                    ++fCount;
            }
        } else {
            for (; i < len; ++i) {
                if ( typeof(result[i][filter]) != 'undefined' ) {
                    if ( typeof(rawFilteredResult[fCount]) == 'undefined' ) {
                        rawFilteredResult[fCount] = {}
                    }
                    rawFilteredResult[fCount][filter] = result[i][filter];
                    ++fCount;
                }
            }
        }

        return JSON.clone(rawFilteredResult);
    }


    return instance;
};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = Collection
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define(function() { return Collection })
}