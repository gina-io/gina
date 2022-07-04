/**
 * Gina Local Storage
 * N.B.: this is based on Web StorageAPI & Node LocalStorage
 * See.:
 *  - https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API
 *  - https://www.npmjs.com/package/node-localstorage
 * */
function StoragePlugin(options) {

    var merge       = merge || require('utils/merge');
    var Collection  = Collection || require('utils/collection');
    var uuid        = uuid || require('vendor/uuid');


    var self = {
        'options' : {
            'bucket': 'default'
        }
    };

    var bucketInstance = {};
    var storage     = null;

    var entities    = {}, collections = {}; // entities & collections (data) objects
    var keywords    = ['not null']; // TODO - null, exists


    var proto = {
        'bucket'    : undefined,
        'drop'      : bucketDrop,
        'Collection': Collection
    };

    var entityProto = {
        'insert'    : collectionInsert,
        'find'      : collectionFind,
        'findOne'   : collectionFindOne,
        'update'    : null,
        'delete'    : collectionDelete,
        'drop'      : collectionDrop
    };

    var init = function(options) {

        // detect if cookies are enabled
        if ( !window.localStorage || window.localStorage && ! typeof(window.localStorage.setItem) == 'undefined' ) {
            throw new Error('Make sure your browser supports `window.localStorage` to use Gina Storage. See: `https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API#Browser_compatibility`');
        }

        if ( typeof(options) != 'object' && typeof(options) != 'undefined' ) {
            throw new Error('`options` must be an object')
        } else if ( typeof(options) == 'undefined' ) {
            var options = {}
        }

        self.options    = merge(options, self.options);
        storage         = window.localStorage;

        var bucketName  = self.options['bucket'];
        var bucket      = storage.getItem(bucketName);

        if (!bucket && bucketName != undefined) {
            //console.log('creating new bucket !');
            bucketCreate(bucketName);
        } else if (bucketName == undefined) {
            throw new Error('`bucket` name cannot be undefined')
        }

        bucketInstance['bucket'] = bucketName;
        bucketInstance = merge(bucketInstance, proto);
    }



    /**
     * Create bucket
     *
     * @param {string} bucketName
     * */
    var bucketCreate = function(bucketName) {
        storage.setItem(bucketName, JSON.stringify(collections));
    }

    /**
     * Drop bucket
     *
     * */
    function bucketDrop() {
        storage.removeItem(self.options['bucket']);
        bucketInstance = null;

        for (var prop in this) {
            delete this[prop]
        }

        return bucketInstance;
    }

    /**
     * Create or Get Collection by name
     *
     * @param {string} name - Collection name
     * */
    function Collection(name) {
        // retrieve collections state
        collections = JSON.parse(storage.getItem(this['bucket']));
        //console.log('collections ', (collections || null) );
        if ( typeof(collections[name]) == 'undefined' ) {
            collections[name] = [];
            storage.setItem(this['bucket'], JSON.stringify(collections));
            collections = JSON.parse(storage.getItem(this['bucket']));
        }

        entities[name]      = { '_collection': name, '_bucket': this['bucket'] };
        entities[name]      = merge(entities[name], entityProto);

        return entities[name]
    }

    /**
     * Drop collection
     *
     * @param {string} name
     * */
    function collectionDrop(name) {
        if ( typeof(collections[ this['_collection'] ]) == 'undefined' ) {
            throw new Error('Collection `'+name+'` not found')
        }

        delete entities[ this['_collection'] ]; // delete entity
        delete collections[ this['_collection'] ]; // delete data

        storage.setItem(this['_bucket'], JSON.stringify(collections));
    }

    /**
     * Insert into collection
     *
     * @param {object} content
     * */
    function collectionInsert(content) {

        // TODO - add uuid
        content['_id']         = uuid.v1();
        content['_createdAt']  = new Date().format("isoDateTime");
        content['_updatedAt']  = new Date().format("isoDateTime");

        collections[ this['_collection'] ][ collections[ this['_collection'] ].length ] = content;

        storage.setItem(this['_bucket'], JSON.stringify(collections));
    }

    /**
     * Find from collection
     *
     * // TODO - add options
     *
     * @param {object} filter
     * @param {object} [options] - e.g.: limit
     *
     * @return {array} result
     * */
    function collectionFind(filter, options) {
        if (!filter) {
            // TODO - limit of ten by
            return collections[ this['_collection'] ]
        }

        if ( typeof(filter) !== 'object' ) { // == findAll
            throw new Error('filter must be an object');
        } else {
            //console.log('search into ', this['_collection'], collections[ this['_collection'] ], collections);
            var content             = collections[ this['_collection'] ]
                , condition         = filter.count()
                , i                 = 0
                , found             = []
                , localeLowerCase   = '';

            for (var o in content) {
                for (var f in filter) {
                    localeLowerCase = ( typeof(filter[f]) != 'boolean' ) ? filter[f].toLocaleLowerCase() : filter[f];
                    if ( filter[f] && keywords.indexOf(localeLowerCase) > -1 && localeLowerCase == 'not null' && typeof(content[o][f]) != 'undefined' && typeof(content[o][f]) !== 'object' && content[o][f] != 'null' && content[o][f] != 'undefined' ) {
                        if (found.indexOf(content[o][f]) < 0 ) {
                            found[i] = content[o][f];
                            ++i
                        }

                    } else if ( typeof(content[o][f]) != 'undefined' && typeof(content[o][f]) !== 'object' && content[o][f] === filter[f] ) {
                        found[i] = content[o];
                        ++i
                    }
                }
            }
        }

        return found
    }

    //function collectionLimit(limit) {}

    /**
     * Find a single result from collection
     *
     * e.g:
     *  // getting a record
     *  > var objectRecord = <bucket>.Collection('myBucket').findOne({_name: "someName"});
     *
     *  // updating record by adding or updating an existing property
     *  > objectRecord.myProperty = 'some value';
     *  > objectRecord.save();
     *
     *  // deleting record
     *  > objectRecord.myProperty.delete()
     *
     * @param {object} filter
     *
     * @returns {object|array|string} result
     *
     * */
    function collectionFindOne(filter) {

        if ( typeof(filter) !== 'object' ) {
            throw new Error('filter must be an object');
        } else {
            var content             = collections[ this['_collection'] ]
                , condition         = filter.count()
                , i                 = 0
                , result            = null
                , localeLowerCase   = '';


            //console.log('condition ', condition, '\nfitler', filter, '\ncontent', content);
            if (condition == 0) return null;

            for (var o in content) {
                for (var f in filter) {
                    localeLowerCase = ( typeof(filter[f]) != 'boolean' ) ? filter[f].toLocaleLowerCase() : filter[f];
                    if ( filter[f] && keywords.indexOf(localeLowerCase) > -1 && localeLowerCase == 'not null' && typeof(content[o][f]) != 'undefined' && typeof(content[o][f]) !== 'object' && content[o][f] === filter[f] && content[o][f] != 'null' && content[o][f] != 'undefined' ) {
                        if (result.indexOf(content[o][f]) < 0 ) {
                            ++i;
                            if (i === condition) {
                                result                   = content[o];
                                result['_index']         = o;
                                result['_collection']    = this['_collection'];
                                result['_bucket']        = this['_bucket'];
                            }

                        }

                    } else if ( typeof(content[o][f]) != 'undefined' && typeof(content[o][f]) !== 'object' && content[o][f] === filter[f] ) {
                        ++i;
                        if (i === condition) {
                            result                   = content[o];
                            result['_index']         = o;
                            result['_collection']    = this['_collection'];
                            result['_bucket']        = this['_bucket'];
                            result['_filter']        = filter;
                        }
                    }
                }
            }
        }

        if (result) {
            /**
             * save
             *  e.g.:
             *      // updating property
             *      <obj>.property = 'value';
             *      <obj>.save();
             *
             *      // deleting property
             *      delete <obj>.property;
             *      <obj>.save(true);
             *
             * @param {boolean} enforceDeleted
             * */
            result['save'] = function(enforceDeleted) {

                var enforceDeleted = enforceDeleted || false;

                try {
                    //backing up collections
                    var tmpCollections  = JSON.parse(JSON.stringify(collections));
                    var index           = this['_index'];
                    var collection      = this['_collection'];
                    var bucket          = this['_bucket'];
                    var filter          = this['_filter'];
                    this['_updatedAt']  = new Date().format("isoDateTime");

                    merge(tmpCollections[ collection ][ index ], this, true);

                    // cleaning
                    delete tmpCollections[ collection ][ index ]['_index'];
                    delete tmpCollections[ collection ][ index ]['_collection'];
                    delete tmpCollections[ collection ][ index ]['_bucket'];
                    delete tmpCollections[ collection ][ index ]['save'];
                    delete tmpCollections[ collection ][ index ]['_filter'];

                    if (enforceDeleted && typeof(tmpCollections[ collection ][ index ]) == 'object' ) {

                        var parseEnforcedCollection = function (arr, target) {
                            for (var i = 0, len = arr.length; i < len; ++i) {
                                if ( typeof (target[i]) == 'object' && typeof(arr[i]) != 'undefined' && !Array.isArray(arr[i]) ) {
                                    parseEnforced(arr[i], target[i])
                                } else if ( !Array.isArray(arr[i]) ){
                                    if (typeof(arr[i]) == 'undefined') {
                                        delete target[i]
                                    }
                                } else { // is collection type
                                    parseEnforcedCollection(arr[i], target[i])
                                }
                            }

                            return target
                        }

                        var parseEnforced = function (obj, target) {
                            for (var prop in target) {
                                if ( typeof (target[prop]) == 'object' && typeof(obj[prop]) != 'undefined' && !Array.isArray(obj[prop]) ) {
                                    parseEnforced(obj[prop], target[prop])
                                } else if ( !Array.isArray(obj[prop]) ){
                                    if (typeof(obj[prop]) == 'undefined') {
                                        delete target[ prop ]
                                    }
                                } else { // is collection type
                                    parseEnforcedCollection(obj[prop], target[prop])
                                }
                            }

                            return target
                        };

                        if ( Array.isArray(tmpCollections[ collection ][ index ]) ) {
                            tmpCollections[ collection ][ index ] = parseEnforcedCollection(this, tmpCollections[ collection ][ index ])
                        } else if ( typeof(tmpCollections[ collection ][ index ] ) == 'object' ) {
                            tmpCollections[ collection ][ index ] = parseEnforced(this, tmpCollections[ collection ][ index ])
                        } else {
                            if (typeof(this[prop]) == 'undefined') {
                                delete tmpCollections[ collection ][ index ]
                            }
                        }
                    }

                    collections[ collection ][ index ] = tmpCollections[ collection ][ index ];

                    // saving
                    storage.setItem(bucket, JSON.stringify(collections));

                    return collectionFindOne(filter)

                } catch (err) {
                    throw err
                }
            }
        }


        return result
    }

    /**
     * Delete from collection
     *
     * @param {object} filter
     *
     * @return {array} result
     * */
    function collectionDelete(filter) {

        if ( typeof(filter) !== 'object' ) {
            throw new Error('filter must be an object');
        } else {
            var content     = JSON.parse(JSON.stringify( collections[ this['_collection'] ] ))
                //, condition = filter.count()
                , i         = 0
                , found     = [];

            for (var o in content) {
                for (var f in filter) {
                    if ( filter[f] && keywords.indexOf(filter[f].toLocaleLowerCase()) > -1 && filter[f].toLowerCase() == 'not null' && typeof(content[o][f]) != 'undefined' && typeof(content[o][f]) !== 'object' && content[o][f] != 'null' && content[o][f] != 'undefined' ) {
                        if (found.indexOf(content[o][f]) < 0 ) {
                            found[i] = content[o][f];
                            delete collections[ this['_collection'] ][o][f];
                            ++i
                        }

                    } else if ( typeof(content[o][f]) != 'undefined' && typeof(content[o][f]) !== 'object' && content[o][f] === filter[f] ) {
                        found[i] = content[o];
                        collections[ this['_collection'] ].splice(o, 1);
                        ++i
                    }
                }
            }
        }

        if (found.length > 0 ) {
            storage.setItem(this['_bucket'], JSON.stringify(collections));
            return true
        }

        return false
    }

    init(options);


    return bucketInstance
};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    var merge       = require('../../../../utils/lib/merge');
    var Collection  = require('../../../../utils/collection');
    var uuid        = require('uuid');

    module.exports = StoragePlugin
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define('gina/storage',function() { return StoragePlugin })
}