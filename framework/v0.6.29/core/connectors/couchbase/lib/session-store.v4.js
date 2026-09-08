"use strict";
var fs              = require('fs');
var util            = require('util');

var gina            = require('../../../../core/gna');
var lib             = gina.lib;
var console         = lib.logger;
// #B432 — express-session must see exactly one callback. Each method below
// wraps `fn` at entry, so a callback that THROWS can no longer be re-invoked
// by that method's own error path (see core/connectors/settle-once.js).
var settleOnce      = require('./../../settle-once');
var helpers         = lib.helpers;
var dateFormat      = helpers.dateFormat;

/*!
 * Connect - Couchbase
 * Copyright(c) 2014 Christopher Mina <christopher.mina@gmail.com>
 *
 * MIT Licensed
 *
 * This is an adaption from connect-redis, see:
 * https://github.com/tj/connect-redis
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
     * The store does not open its own connection. `options.db` is REQUIRED and
     * must be the already-open Couchbase bucket the model layer created from
     * the bundle's `session` connector entry — obtained with
     * `getModel('session').getConnection()`. Session documents go through the
     * bucket's default collection.
     *
     * #B167 — the former self-connect fallback (host/hosts/username/password/
     * bucket/cachefile options) was removed: it called `cluster.openBucket()`,
     * an SDK v2 API that does not exist on the supported v3/v4 SDKs, so
     * reaching it always threw at bundle init. The options that only fed that
     * path were removed with it.
     *
     * @class CouchbaseStore
     * @constructor
     * @param {object}  options
     * @param {object}  options.db                        - Open Couchbase bucket (required).
     * @param {number}  [options.ttl=null]                - Expiry in seconds. Unset, the cookie's maxAge applies, then one day. Must be > 0 when set — non-positive refuses (#B207).
     * @param {string}  [options.prefix='sess:']          - Document key prefix.
     * @param {number}  [options.connectionTimeout=10000] - Connect-time timeout in ms.
     * @param {number}  [options.operationTimeout=10000]  - Per-operation timeout in ms.
     * @api public
     */

    function CouchbaseStore(options) {

        options = options || {};
        Store.call(this, options);
        this.prefix = null == options.prefix
            ? 'sess:'
            : options.prefix;

        if ( !options.db || typeof(options.db.defaultCollection) != 'function' ) {
            throw new Error('['+ bundle +'][SessionStore v4] `options.db` is required and must be an already-open '
                + 'Couchbase bucket: new CouchbaseStore({ db: getModel(\'session\').getConnection() }) — the '
                + 'zero-argument getConnection() on the model, not an entity\'s getConnection(scope, collection), '
                + 'which returns a collection. The former self-connect fallback (host/bucket/username/password '
                + 'options) was removed: it relied on the SDK v2 openBucket() API, absent from SDK v3/v4 (#B167).');
        }

        this.client = options.db.defaultCollection();

        this.client.connectionTimeout = options.connectionTimeout || 10000;
        this.client.operationTimeout = options.operationTimeout || 10000;

        // #B207 — parity with the redis/sqlite/mongodb/scylladb stores: a
        // non-positive ttl is refused at construction. couchbase collapsed 0
        // at the constructor and still upserted a ZERO expiry — a document
        // that never expires — when the cookie's decaying maxAge resolved to
        // <= 0 at set()/touch().
        if (options.ttl != null && !(options.ttl > 0)) {
            throw new Error('['+ bundle +'][SessionStore v4] `ttl` must be a positive number of seconds or unset — got '
                + JSON.stringify(options.ttl) + ' (store options). `ttl: 0` is not supported (it previously behaved as unset).');
        }
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
        fn = settleOnce('couchbase:session#get', fn, console);
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
        // FRAMEWORK PATCH: handle the case where data.value is
        // already a parsed object (Couchbase Node.js SDK 4.x JsonTranscoder
        // returns the decoded value, not the raw bytes). Without this, calling
        // .toString() on an object produces "[object Object]" which JSON.parse
        // can't handle and every authenticated request 500s on session-retrieval.
        // Push upstream to gina-io/gina.
        if (typeof data.value === 'object' && !Buffer.isBuffer(data.value)) {
            console.debug('[SessionStore v4] (1) GOT data (already-parsed object)');
            return fn(null, data.value);
        }
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
     * Stamps `sess.lastModified` (ISO 8601, UTC) when `ttl > 0`, matching the
     * redis / sqlite / mongodb / scylladb session stores.
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} fn
     * @api public
     */

    CouchbaseStore.prototype.set = function(sid, sess, fn){
        if ('function' !== typeof fn) { fn = noop; }
        fn = settleOnce('couchbase:session#set', fn, console);
        sid = this.prefix + sid;
        try {

            var maxAge = sess.cookie.maxAge
                , ttl = this.ttl || ('number' == typeof maxAge
                    ? maxAge / 1000 | 0
                    : oneDay)
                ;

            // #B207 — a resolved ttl <= 0 (decaying cookie.maxAge at/past
            // expiry) must never reach the SDK: a zero expiry stores the
            // document WITHOUT expiration, and a negative one is SDK-version-
            // dependent. No-op — the existing record keeps its original
            // expiry (mirrors the #B166 guard the sibling stores carry).
            if (ttl <= 0) {
                return fn(null);
            }

            if (ttl > 0) {
                // #B165 — was `.format('isoDateTime')`, a zone-less local-time
                // string ("yyyy-mm-dd'T'HH:MM:ss", helpers/dateFormat.js). The
                // browser re-parses this stamp (utils/loader.js getTimeout) and
                // a zone-less form is read as BROWSER-local, so the session
                // countdown skewed by the server/browser offset. `toISOString()`
                // is unambiguous UTC and matches the other four session stores.
                sess.lastModified = new Date().toISOString();
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
        fn = settleOnce('couchbase:session#destroy', fn, console);
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
     * Also re-stamps `sess.lastModified` (ISO 8601, UTC) whenever `ttl > 0`.
     * The stamp is unconditional by design: the `upsert` extends the document's
     * expiry on every call, and the client-side session countdown derives its
     * origin from that stamp, so it must track every extension (#B165). A
     * resolved ttl <= 0 is a no-op — never extend with a non-positive
     * expiry (#B207).
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} fn
     * @api public
     */

    CouchbaseStore.prototype.touch = function (sid, sess, fn) {
        if ('function' !== typeof fn) { fn = noop; }
        fn = settleOnce('couchbase:session#touch', fn, console);

        sid = this.prefix + sid;
        var maxAge = sess.cookie.maxAge
            , ttl = this.ttl || ('number' == typeof maxAge
                ? maxAge / 1000 | 0
                : oneDay)
            ;

        // #B207 — same guard as set(): never extend with a non-positive
        // expiry (zero = the document never expires; negative is SDK-version-
        // dependent). The #B166 sibling-store guards are identical.
        if (ttl <= 0) {
            return fn(null);
        }

        // #B165 — an idle-check used to gate this stamp. It compared an elapsed
        // value in MILLISECONDS against `ttl` in SECONDS, so it fired ~1000x too
        // eagerly (86.4s idle on the 86400s default). Correcting only the units
        // would have been worse: the `upsert` below refreshes expiry on EVERY
        // touch, so `lastModified` must track every extension. Gating it on `ttl`
        // seconds idle would freeze the stamp at the first `set()`, and the
        // client-side countdown (`expiresAt = lastModified + maxAge`, see
        // core/asset/plugin/src/vendor/gina/utils/loader.js) would then inflate
        // from a stale origin. The `touchAfter` option the old comment referenced
        // never existed in this codebase.
        if (ttl > 0) {
            sess.lastModified = new Date().toISOString();
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
