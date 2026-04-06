//"use strict";
var fs              = require('fs');
var util            = require('util');
var EventEmitter    = require('events').EventEmitter;
// Use couchbase module from the user's project dependencies if not found
var couchbasePath   = _(getPath('project') +'/node_modules/couchbase');
var couchbase       = require(couchbasePath);

var gina            = require('../../../../core/gna');
var lib             = gina.lib;
var console         = lib.logger;
var merge           = lib.merge;
var modelUtil       = new lib.Model();

//globalized
// CB-LOW-1 fix: uuid import removed in 0.3.1 — was imported but never called.
N1qlQuery           = couchbase.N1qlQuery || null;
N1qlStringQuery     = couchbase.N1qlStringQuery || null;
ViewQuery           = couchbase.ViewQuery || null;


/**
 * Connector
 *
 * Options :
 *  - keepAlive
 *      if set to `true`, will ping based on `pingInterval`
 *      if set to `false`, will not ping the database server
 *  - pingInterval
 *      `30s` will set the ping interval to 30 seconds
 *      `1m` will set the ping interval to 1 minute
 *      `1h` will set the ping interval to 1 hour
 *      `1d` will set the ping interval to 1 day
 *
 * @class
 * */
function Connector(dbString) {
    var self    = this
        , local = {
            bundle: null,
            env: null,
            options: {
                keepAlive: true,
                pingInterval : "2m"
            }
        }
        , sdk = {
            version: 2
        }
    ;

    /**
     * connect
     *
     * @param {object} dbString
     * @callback cb
     * */
    this.connect = async function(dbString, cb) {
        // Attention: the connection is lost 5 minutes once the bucket is opened.
        var conn        = null;

        var onError = function (err, next) {
            delete self.instance.reconnecting;
            self.instance.reconnected = self.instance.connected = false;
            console.error('[ CONNECTOR ][ ' + local.bundle +' ] couchbase could not be reached !!\n'+ ( err.stack || err.message || err ) );

            // CB-LOW-5 fix: exponential backoff replaces hardcoded 5s retry.
            // Delay sequence: 5s → 10s → 20s → 40s → 60s (cap). Counter reset in onConnect().
            self._reconnectAttempts = (self._reconnectAttempts || 0) + 1;
            var _backoffDelay = Math.min(5000 * Math.pow(2, self._reconnectAttempts - 1), 60000);
            if (self._reconnectAttempts >= 10) {
                console.error('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] reconnect attempt ' + self._reconnectAttempts + ' — max backoff reached (' + (_backoffDelay/1000) + 's). Couchbase may be unavailable.');
            } else {
                console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] reconnect attempt ' + self._reconnectAttempts + ' — retrying in ' + (_backoffDelay/1000) + 's...');
            }
            self.instance.reconnecting = true;

            setTimeout( function onRetry(){
                if ( typeof(next) != 'undefined' ) {
                    self.connect(dbString, next);
                } else {
                    self.connect(dbString);
                }
            }, _backoffDelay);

        };

        // once
        var onConnect = function onConnect(cb){
            console.debug('[ CONNECTOR ][ ' + local.bundle +' ] couchbase is alive !!');
            console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.connector +' ] now connected...');

            // #CB-V2-DEPRECATED — Couchbase SDK v2 reached end-of-life in 2021.
            // Formal deprecation in gina 0.2.0 (Q2 2026). Removal planned for gina 0.4.0 (Q4 2026).
            // To upgrade: set sdk.version to 3 or 4 in your bundle's connectors.json.
            console.warn('[ CONNECTOR ][ couchbase ] SDK v2 is deprecated and will be removed in gina 0.4.0. '
                + 'Couchbase Server SDK v2 reached end-of-life in 2021. '
                + 'Update your bundle\'s connectors.json: set sdk.version to 3 or 4.');
            if (/^true$/i.test(process.env.GINA_V8_POINTER_COMPRESSED)) {
                console.error('[ CONNECTOR ][ couchbase ] FATAL: SDK v2 uses NAN bindings which are incompatible '
                    + 'with V8 pointer compression. The process may segfault. '
                    + 'Switch to sdk.version 3 or 4 in connectors.json immediately.');
            }

            // CB-LOW-5 fix: reset backoff counter on successful (re)connect.
            self._reconnectAttempts = 0;
            self.instance.reconnected  = self.instance.connected   = true;
            var options = local.options;

            // updating context
            var ctx = getContext()
                , bundle = ctx.bundle
                , env = ctx.env
                , conf = ctx['gina'].config.envConf[bundle][env]
                , name = dbString.database
                //Reload models.
                , modelsPath = _(conf.modelsPath)
            ;
            // will send heartbeat every 4 minutes if keepAlive == `true`
            self.ping(options.pingInterval, cb, function onPing(cb){

                local.bundle = bundle;
                local.env = env;

                if ( typeof(cb) != 'undefined' ) { // this portition is not working yet on Mac OS X
                    console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ '+ env +' ] connected to couchbase !!');


                    // CB-PERF-3 fix: first setConnection call was redundant (identical args, outside the existsSync guard)
                    // modelUtil.setConnection(bundle, name, self.instance);
                    if ( fs.existsSync(modelsPath) ) {
                        modelUtil.setConnection(bundle, name, self.instance);
                        modelUtil.reloadModels(
                            conf,
                            function doneReloadingModel(err) {
                                self.reconnecting = false;
                                cb(err)
                            })
                    } else {
                        cb(new Error('[ CONNECTOR ][ ' + local.bundle +' ][ '+ env +' ] '+ modelsPath+ ' not found') )
                    }

                } else {
                    console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ '+ env +' ] connection to bucket `'+ name +'` is being kept alive ...');
                }
            });
            // intercepting conn event thru gina
            // CB-BUG-1 fix: guard against handler accumulation on reconnect
            // — onConnect() fires on every reconnection; without this guard each reconnect stacks a new gina.onError handler,
            //   and N handlers all race to call res.end() on the same error, causing "Cannot set headers after sent"
            if (!self._errorHandlerRegistered) {
                self._errorHandlerRegistered = true;
                gina.onError(function(err, req, res, next){
                // (code)   message
                // (16)     Generic network failure. Enable detailed error codes (via LCB_CNTL_DETAILED_ERRCODES, or via `detailed_errcodes` in the connection string) and/or enable logging to get more information
                // (23)     Client-Side timeout exceeded for operation. Inspect network conditions or increase the timeout
                //          cannot perform operations on a shutdown bucket
                //          err instanceof CouchbaseError

                if (!self.instance.connected) {
                    self.instance.reconnected = false;
                    self.instance.reconnecting = false;
                }

                if (
                    err instanceof couchbase.Error && err.code == 16 && !self.reconnected
                    //|| err instanceof couchbase.Error && err.code == 23 && !self.reconnecting
                    || /cannot perform operations on a shutdown bucket/.test(err.message ) && !self.reconnecting && !self.reconnected
                ) {
                    // CB-LOW-5 fix: exponential backoff (shared counter with connect onError).
                    self._reconnectAttempts = (self._reconnectAttempts || 0) + 1;
                    var _backoffDelay = Math.min(5000 * Math.pow(2, self._reconnectAttempts - 1), 60000);
                    if (self._reconnectAttempts >= 10) {
                        console.error('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] reconnect attempt ' + self._reconnectAttempts + ' — max backoff reached (' + (_backoffDelay/1000) + 's). Couchbase may be unavailable.');
                    } else {
                        console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] reconnect attempt ' + self._reconnectAttempts + ' — retrying in ' + (_backoffDelay/1000) + 's...');
                    }
                    self.reconnecting = true;

                    setTimeout( function onRetry(){
                        if ( typeof(next) != 'undefined' ) {
                            self.connect(dbString, next)
                        } else {
                            self.connect(dbString)
                        }
                    }, _backoffDelay)

                } else if (err instanceof couchbase.Error && err.code == 23 && !self.reconnecting) {
                    self.instance.disconnect();
                    // express js patch
                    if (typeof(next) != 'undefined') {
                        next(err); // might just be a "false" error: `err` is replaced with cb() caller `data`
                    } else {
                        console.error('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] gina fatal error ('+ err.code +'): ' + (err.message||err) + '\nstack: '+ err.stack);
                        return;
                    }
                } else {

                    if (err && err instanceof Error) {

                        console.error('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] gina fatal error ('+ err.code +'): ' + (err.message||err) + '\nstack: '+ err.stack);

                        if ( typeof(err) == 'object' ) {
                            // CB-QUAL-1 fix: stack trace removed — logged server-side only, never sent to client
                            res.end(JSON.stringify({
                                status: 500,
                                error: err.message
                            }))
                        } else {
                            res.end(err)
                        }

                        res.headersSent = true;
                    } else {
                        // express js patch
                        if (typeof(next) != 'undefined') {
                            next(err); // might just be a "false" error: `err` is replaced with cb() caller `data`
                        } else {
                            console.error('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] gina fatal error ('+ err.code +'): ' + (err.message||err) + '\nstack: '+ err.stack);
                            return;
                        }
                    }
                }
                });
            }


            self.emit('ready', false, self.instance);
        };

        try {
            //console.debug('[ CONNECTOR ][ ' + local.bundle +' ] Now creating instance for '+ dbString.database +'...');
            if ( typeof(dbString.password) != 'undefined' && typeof(self.cluster.authenticate) == 'undefined' ) {
                conn = await self.cluster.openBucket(dbString.database, dbString.password, function onBucketOpened(bErr) {
                    if (bErr) {
                        cb(bErr)
                    } else {
                        conn.sdk        = sdk;
                        self.instance   = conn;
                        onConnect(cb);
                    }
                });
            } else {
                conn = await self.cluster.openBucket(dbString.database, function onBucketOpened(bErr) {
                    if (bErr) {
                        if ( typeof(cb) == 'undefined' ) {
                            console.error('*******************************************   Couchbase might be offline !   ***********************');
                            console.emerg(bErr)
                        }
                        cb(bErr)
                    } else {
                        conn.sdk        = sdk;
                        self.instance   = conn;
                        onConnect(cb);
                    }
                });
            }


        } catch (err) {
            console.error('[ CONNECTOR ][ ' + local.bundle +' ] couchbase could not connect to bucket `'+ dbString.database +'`\n'+ (err.stack || err.message || err) );
            onError(err, cb)
        }

        return conn;
    };

    /**
     * init
     *
     * @param {object} dbString
     *
     * @contructor
     * */
    var init = function(dbString) {

        var err = false;
        try {
            dbString        = merge(dbString, local.options);
            local.options   = dbString;
            local.bundle    = getConfig().bundle;

            console.info('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.connector +' ][ ' + dbString.database +' ] authenticating to couchbase cluster @'+ dbString.protocol + dbString.host);

            try {
                self.cluster = new couchbase.Cluster(dbString.protocol + dbString.host);
                // version 5.x
                if ( typeof(self.cluster.authenticate) != 'undefined' )
                    self.cluster.authenticate(dbString.username, dbString.password);
            } catch(_err) {
                console.error('[ CONNECTOR ][ ' + local.bundle +' ] could not authenticate to couchbase @`'+ dbString.protocol + dbString.host +'`\n'+ (_err.stack || _err.message || _err) );
            }

            console.info('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.connector +' ][ ' + dbString.database +' ] connecting to couchbase cluster @'+ dbString.protocol + dbString.host);

            self
                .connect(dbString);
                // .on('error', function(err){
                //     if (!self.reconnecting)
                //         console.emerg('[ CONNECTOR ][ ' + local.bundle +' ][ '+ dbString.database +' ] Handshake aborted ! PLease check that Couchbase is running.\n',  err.message);

                //     if (err)
                //         console.error(err.stack);
                // })
                // .once('connect', function () {
                //     console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.connector +' ] connected...');
                //     // intercepting conn event thru gina
                //     gina.onError(function(err, req, res, next){
                //         // (code)   message
                //         // (16)     Generic network failure. Enable detailed error codes (via LCB_CNTL_DETAILED_ERRCODES, or via `detailed_errcodes` in the connection string) and/or enable logging to get more information
                //         // (23)     Client-Side timeout exceeded for operation. Inspect network conditions or increase the timeout
                //         //          cannot perform operations on a shutdown bucket
                //         //          err instanceof CouchbaseError

                //         if (!self.instance.connected) {
                //             self.reconnected = false;
                //             self.reconnecting = false;
                //         }

                //         if (
                //             err instanceof couchbase.Error && err.code == 16 && !self.reconnected
                //             //|| err instanceof couchbase.Error && err.code == 23 && !self.reconnecting
                //             || /cannot perform operations on a shutdown bucket/.test(err.message ) && !self.reconnecting && !self.reconnected
                //         ) {
                //             // reconnecting
                //             console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] trying to reconnect in 5 secs...');
                //             self.reconnecting = true;

                //             setTimeout( function onRetry(){
                //                 if ( typeof(next) != 'undefined' ) {
                //                     self.connect(dbString, next)
                //                 } else {
                //                     self.connect(dbString)
                //                 }
                //             }, 5000)

                //         } else if (err instanceof couchbase.Error && err.code == 23 && !self.reconnecting) {
                //             self.instance.disconnect();
                //             // express js patch
                //             if (typeof(next) != 'undefined') {
                //                 next(err); // might just be a "false" error: `err` is replaced with cb() caller `data`
                //             } else {
                //                 console.error('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] gina fatal error ('+ err.code +'): ' + (err.message||err) + '\nstack: '+ err.stack);
                //                 return;
                //             }
                //         } else {

                //             if (err && err instanceof Error) {

                //                 console.error('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] gina fatal error ('+ err.code +'): ' + (err.message||err) + '\nstack: '+ err.stack);

                //                 if ( typeof(err) == 'object' ) {
                //                     res.end(JSON.stringify({
                //                         status: 500,
                //                         error: err.message,
                //                         stack: err.stack
                //                     }))
                //                 } else {
                //                     res.end(err)
                //                 }

                //                 res.headersSent = true;
                //             } else {
                //                 // express js patch
                //                 if (typeof(next) != 'undefined') {
                //                     next(err); // might just be a "false" error: `err` is replaced with cb() caller `data`
                //                 } else {
                //                     console.error('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] gina fatal error ('+ err.code +'): ' + (err.message||err) + '\nstack: '+ err.stack);
                //                     return;
                //                 }
                //             }
                //         }
                //     })
                // })

        } catch (_err) {
            console.error(_err.stack);
            self.emit('ready', _err, null);
        }
    };


    /**
     * ping
     * Heartbeat to keep connection alive
     *
     * @param {string} interval
     * @callback cb
     * */
    this.ping = function(interval, cb, ncb) {
        var options = local.options;
        if (options.keepAlive) {
            if ( self.pingId ) {
                clearInterval(self.pingId);
            }

            interval    = interval || options.pingInterval; // for a minute
            var value       = interval.match(/\d+/);
            var unit        = null; // will be seconds by default
            try {
                unit = interval.match(/[a-z]+/i)[0];
            } catch(err) {
                unit = 's';
            }

            switch ( unit.toLowerCase() ) {
                case 's':
                    interval = value * 1000;
                    break;

                case 'm':
                    interval = value * 60 * 1000;
                    break;

                case 'h':
                    interval = value * 60 * 60 * 1000;
                    break;

                case 'd':
                    interval = value * 60 * 60 * 1000 * 24;
                    break;

                default: // seconds
                    interval = value * 1000;
            }

            self.pingId = setInterval(function onTimeout(){

                if (!self.instance.connected) {
                    console.debug('[ CONNECTOR ][ ' + local.bundle +' ] connecting to couchbase');

                    self.instance.reconnected = false;
                    self.instance.reconnecting = true;
                    // CB-PERF-2 fix: `next` was not in scope inside ping() — typeof(next)
                    // always evaluated to 'undefined', so reconnect from ping never passed
                    // the callback and errors were silently dropped. Fixed to use `ncb`
                    // (the no-connection callback param of ping(interval, cb, ncb)).
                    if ( typeof(ncb) != 'undefined' ) {
                        self.connect(dbString, ncb);
                    } else {
                        self.connect(dbString);
                    }

                } else {
                    self.ping(options.pingInterval, cb, ncb);
                }

            }, interval);
            ncb(cb);
        } else {
            // CB-BUG-4 fix: keepAlive is false — ping is a no-op; do not recurse
            // old: console.debug('[ CONNECTOR ][ ' + local.bundle +' ] sent ping to couchbase ...');
            // old: self.ping(interval, cb, ncb);  ← unconditional recursion → stack overflow
            return;
        }
    };

    this.getInstance = function() {
        return self.instance;
    };

    this.onReady = function(cb) {
        self.once('ready', cb);
        init(dbString);
    };
}
util.inherits(Connector, EventEmitter);
module.exports = Connector;