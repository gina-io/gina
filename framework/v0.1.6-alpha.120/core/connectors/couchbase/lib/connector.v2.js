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
uuid                = require('uuid');
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

            // reconnecting
            console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] trying to reconnect in a few secs...');
            self.instance.reconnecting = true;

            setTimeout( function onRetry(){
                if ( typeof(next) != 'undefined' ) {
                    self.connect(dbString, next);
                } else {
                    self.connect(dbString);
                }
            }, 5000);

        };

        // once
        var onConnect = function onConnect(cb){
            console.debug('[ CONNECTOR ][ ' + local.bundle +' ] couchbase is alive !!');
            console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.connector +' ] now connected...');

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


                    modelUtil.setConnection(bundle, name, self.instance);

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
                    // reconnecting
                    console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] trying to reconnect in 5 secs...');
                    self.reconnecting = true;

                    setTimeout( function onRetry(){
                        if ( typeof(next) != 'undefined' ) {
                            self.connect(dbString, next)
                        } else {
                            self.connect(dbString)
                        }
                    }, 5000)

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
                            res.end(JSON.stringify({
                                status: 500,
                                error: err.message,
                                stack: err.stack
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
                    if ( typeof(next) != 'undefined' ) {
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
            console.debug('[ CONNECTOR ][ ' + local.bundle +' ] sent ping to couchbase ...');
            self.ping(interval, cb, ncb);
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