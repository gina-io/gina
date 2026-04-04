"use strict";
var fs              = require('fs');
var util            = require('util');

var gina            = require('../../../../core/gna');
var lib             = gina.lib;
var console         = lib.logger;
var helpers         = lib.helpers;
var dateFormat      = helpers.dateFormat;

/*!
 * Connect - Couchbase
 * Copyright(c) 2014 Christopher Mina <christopher.mina@gmail.com>
 *
 * MIT Licensed
 *
 * This is an adaption from connect-redis, see:
 * https://github.com/visionmedia/connect-redis
 */

// CB-LOW-4 fix: duplicate 'use strict' removed — file already has "use strict" at line 1.

/**
 * Module dependencies.
 */

// #B10 fix: require debug from project node_modules — same pattern as couchbase/index.js for the couchbase module itself.
// Plain require('debug') fails when loaded from within gina's framework path.
var debug = require(_(getPath('project') + '/node_modules/debug'))('connect:couchbase');

/**
 * One day in seconds.
 */

var oneDay = 86400;

/**
 * No op
 */
var noop = function () {};

/**
 * Return the `CouchbaseStore` extending `express`'s session Store.
 *
 * @param {object} express session
 * @returns {Function}
 * @api public
 */

module.exports = function(session, bundle){

    /**
     * Express's session Store.
     */

    var Store = session.Store;

    /**
     * Initialize CouchbaseStore with the given `options`.
     *
     * @param {Object} options
     *      {
     *          host: 127.0.0.1:8091 (default) -- Can be one or more address:ports, separated by semi-colon, or an array
     *          username: '',   -- Should be same as bucket name, if provided
     *          password: '',
     *          bucket: 'default' (default)
     *          cachefile: ''
     *          ttl: 86400,
     *          prefix: 'sess',
     *          operationTimeout:2000,
                connectionTimeout:2000,
     *      }
     * @api public
     */

    function CouchbaseStore(options) {
        var self = this;

        options = options || {};
        Store.call(this, options);
        this.prefix = null == options.prefix
            ? 'sess:'
            : options.prefix;

        var connectOptions = {};
        if (options.hasOwnProperty("host")) {
            connectOptions.host = options.host;
        } else if (options.hasOwnProperty("hosts")) {
            connectOptions.host = options.hosts;
        }

        if (options.hasOwnProperty("username")) {
            connectOptions.username = options.username;
        }

        if (options.hasOwnProperty("password")) {
            connectOptions.password = options.password;
        }

        if (options.hasOwnProperty("bucket")) {
            connectOptions.bucket = options.bucket;
        }

        if (options.hasOwnProperty("cachefile")) {
            connectOptions.cachefile = options.cachefile;
        }

        if (options.hasOwnProperty("connectionTimeout")) {
            connectOptions.connectionTimeout = options.connectionTimeout;
        }

        if (options.hasOwnProperty("operationTimeout")) {
            connectOptions.operationTimeout = options.operationTimeout;
        }

        if (options.hasOwnProperty("db")) {
            connectOptions.db = options.db; // DB Instance
        }

        if ( typeof(connectOptions.db) != 'undefined' ) {
            // var conn = connectOptions.db;
            // var scope = conn.scope(conn.name);
            // var coll  = ( typeof(bundle) != 'undefined' ) ? scope.collection(bundle) :  scope._bucket.defaultCollection();
            //var coll = connectOptions.db.collection(bundle);
            var coll = connectOptions.db.defaultCollection();
            //var coll  = ( typeof(bundle) != 'undefined' ) ? bucket.collection(bundle) : bucket.defaultCollection();

            this.client = coll;
        } else {
            var Couchbase = require('couchbase');
            var cluster = new Couchbase.Cluster(connectOptions.host);

            this.client = cluster.openBucket(connectOptions.bucket, connectOptions.password, function(err) {
                if (err) {
                    console.log("Could not connect to couchbase with bucket: " + connectOptions.bucket);
                    self.emit('disconnect');
                } else {
                    self.emit('connect');
                }
            });
        }

        this.client.connectionTimeout = connectOptions.connectionTimeout || 10000;
        this.client.operationTimeout = connectOptions.operationTimeout || 10000;

        this.ttl = options.ttl || null;
    }

    /**
     * Inherit from `Store`.
     */

    CouchbaseStore.prototype.__proto__ = Store.prototype;

    /**
     * Attempt to fetch session by the given `sid`.
     *
     * @param {String} sid
     * @param {Function} fn
     * @api public
     */

    CouchbaseStore.prototype.get = async function(sid, fn){
        if ('function' !== typeof fn) { fn = noop; }
        sid = this.prefix + sid;
        console.debug('[SessionStore v4] GET "' + sid + '"');


        var err = false, result = null, data = null;
        // this.client.get(sid, function(err, data){
        //     //Handle Key Not Found error
        //     if (err && err.code == 13) {
        //         return fn();
        //     }
        //     if (err) return fn(err);
        //     if (!data || !data.value) return fn();
        //     var result;
        //     data = data.value.toString();
        //     debug('GOT %s', data);
        //     try {
        //         result = JSON.parse(data);
        //     } catch (err) {
        //         return fn(err);
        //     }
        //     return fn(null, result);
        // });


        try {
            data = await this.client.get(sid)
        } catch (_err) {
            err = _err;
            if (!err.code)
                err.code = 'ENOENT';
        }
        if (err && err.code == 13) {
            return fn();
        }
        if (err) return fn(err);
        if (!data || !data.value) return fn();
        data = data.value.toString();
        console.debug('[SessionStore v4] (1) GOT data');
        // console.debug('[SessionStore v4] (2) GOT ' + data);
        try {
            result = JSON.parse(data);
        } catch (err) {
            var sessErr = new Error('['+ bundle +'][SessionStore v4] Could not retrieve session: "'+ sid +'"\n'+ err.stack);
            console.error(sessErr);
            return fn(sessErr);
        }
        return fn(null, result);


        // this.client
        //     .get(sid)
        //     .then(function onData(_data) {
        //         data = _data;
        //     })
        //     .catch(function onErr(_err){
        //         err = _err;
        //     });

        // //Handle Key Not Found error
        // if (err && err.code == 13) {
        //     return fn();
        // }
        // if (err) return fn(err);

        // if (!data || !data.value) return fn();
        // data = data.value.toString();
        // console.debug('GOT %s', data);
        // try {
        //     result = JSON.parse(data);
        // } catch (err) {
        //     return fn(err);
        // }
        // return fn(null, result);




        // if (!result || !result.value) return fn();
        // try {
        //     var data = result.value.toString();
        //     debug('GOT %s', data);
        //     result = JSON.parse( data );
        //     return fn(null, result);
        // } catch (err) {
        //     return fn(err);
        // }
    };

    /**
     * Commit the given `sess` object associated with the given `sid`.
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} fn
     * @api public
     */

    CouchbaseStore.prototype.set = function(sid, sess, fn){
        if ('function' !== typeof fn) { fn = noop; }
        sid = this.prefix + sid;
        try {

            var maxAge = sess.cookie.maxAge
                , ttl = this.ttl || ('number' == typeof maxAge
                    ? maxAge / 1000 | 0
                    : oneDay)
                ;

            if (ttl > 0) {
                sess.lastModified = new Date().format('isoDateTime');
            }

            sess = JSON.stringify(sess);

            console.debug('[SessionStore v4] SETEX "' + sid + '" ttl:' + ttl);
            // console.debug('[SessionStore v4] SETEX "' + sid + '" ttl:' + ttl + ' ' + sess);
            debug('[SessionStore v4] SETEX "%s" ttl:%s %s', sid, ttl, sess);
            this.client.upsert(sid, sess, {expiry:ttl}, function(err){
                err || debug('Session Set complete');
                if (err) {
                    console.error('[SessionStore v4] ', err.stack || err.message || err);
                }
                fn && fn.apply(this, arguments);
            });
            // var err = false, result = null;
            // this.client.upsert(sid, sess, {expiry:ttl})
            //     .then(function onResult(_result){
            //         result = _result;
            //         //fn && fn.apply(this, arguments);
            //         fn && fn(err, result);
            //     })
            //     .catch(function onError(_err) {
            //         err = _err
            //         // if(err)
            //         //     debug('Session Set complete', err.stack || err.message || err);

            //         //fn && fn.apply(this, arguments);
            //         fn && fn(err);
            //     });
            // if (err) {
            //      fn && fn(err);
            // }
            // fn && fn(err, result);

        } catch (err) {
            fn && fn(err);
        }
    };

    /**
     * Destroy the session associated with the given `sid`.
     *
     * @param {String} sid
     * @api public
     */

    CouchbaseStore.prototype.destroy = function(sid, fn){
        if ('function' !== typeof fn) { fn = noop; }
        sid = this.prefix + sid;
        //this.client.remove(sid, fn);
        this.client
                .remove(sid)
                // CB-BUG-4 fix: .then(fn) passes the MutationResult as fn's first arg,
                // which express-session interprets as an error and calls next(MutationResult).
                // Call fn(null) explicitly on success.
                .then(function onResult() { fn(null); })
                .catch(fn)
    };


    /**
     * Refresh the time-to-live for the session with the given `sid`.
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} fn
     * @api public
     */

    CouchbaseStore.prototype.touch = function (sid, sess, fn) {
        if ('function' !== typeof fn) { fn = noop; }

        sid = this.prefix + sid;
        var maxAge = sess.cookie.maxAge
            , ttl = this.ttl || ('number' == typeof maxAge
                ? maxAge / 1000 | 0
                : oneDay)
            , currentDate = new Date()
            , lastModified = sess.lastModified ? new Date(sess.lastModified).getTime() : 0;

        // if the given options has a touchAfter property, check if the
        // current timestamp - lastModified timestamp is bigger than
        // the specified, if it's not, don't touch the session
        if (ttl > 0 && lastModified > 0) {

            var timeElapsed = currentDate.getTime() - lastModified;

            if (timeElapsed > ttl) {
                sess.lastModified = currentDate.format('isoDateTime');
            }
        }

        sess = JSON.stringify(sess);
        this.client.upsert(sid, sess, {expiry:ttl})
            // CB-BUG-4 fix: .then(fn.apply(this,arguments)) passed the MutationResult
            // (the Promise resolved value) as fn's first argument, which express-session
            // interpreted as an error and called defer(next, MutationResult). This caused
            // express-session to propagate the Couchbase MutationResult ({cas, token})
            // as an error through the middleware chain, ultimately reaching the framework's
            // error handler and returning a 500 with the MutationResult as the body.
            // Fix: call fn(null) explicitly on success. (#CB-BUG-4)
            .then(function onResult() {
                fn && fn(null);
            })
            .catch(function onError(err) {
                debug('Session Touch error');
                fn && fn(err);
            })

    };

    return CouchbaseStore;
};
