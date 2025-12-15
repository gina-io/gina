// "use strict";
var fs              = require('fs');
var util            = require('util');
var EventEmitter    = require('events').EventEmitter;
const exec          = require('child_process').exec;
uuid                = require('uuid');
var couchbase       = require(getPath('project') +'/node_modules/couchbase');// jshint ignore:line
var gina            = require('../../../../core/gna');
var lib             = gina.lib;
var console         = lib.logger;
var merge           = lib.merge;
var modelUtil       = new lib.Model();

//globalized
// N1qlQuery           = couchbase.N1qlQuery || null;
// N1qlStringQuery     = couchbase.N1qlStringQuery || null;
// ViewQuery           = couchbase.ViewQuery || null;
// uuid                = require('uuid');


/**
 * Connector for couchbase module v3
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
                useRestApi: false,
                useScopeAndCollections: true,
                scope: '_default', // by default
                collection: '_default', // by default
                keepAlive: true,
                pingInterval : "2m",
                configProfile: "wan"
            }
        }
        , sdk = {
            version: 3
        }
    ;

    /**
     * arrayToValues
     * Eg.: array like: ['a', 0.5, 'b', false]
     * @param {array} arr
     *
     * @return {string} stringifyiedArray
     */
    var arrayToValues = function(arr) {
        var val = '[';
        for (let i=0, len=arr.length; i<len; i++) {
            if ( /string/i.test( typeof(arr[i]) )) {
                val += '"'+ arr[i] + '"'+',';
                continue;
            }
            val += arr[i] +','
        }

        if ( typeof(arr.length) && arr.length > 0 ) {
            val = val.substring(0, val.length-1);
        }
        val += ']';

        return val;
    };

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
            console.debug('[CONNECTOR][' + local.bundle +'] Scope is: '+ process.env.NODE_SCOPE );
            console.debug('[CONNECTOR][' + local.bundle +'] Env is: '+ process.env.NODE_ENV );
            console.error('[ CONNECTOR ][ ' + local.bundle +' ] couchbase could not be reached !!\n'+ ( err.stack || err.message || err ) );

            // reconnecting
            console.debug('[ CONNECTOR ][ ' + local.bundle +' ][ ' + dbString.database +' ] trying to reconnect in a few secs...');
            self.instance.reconnecting = true;

            setTimeout( function onRetry(){
                if ( typeof(next) != 'undefined' ) {
                    self.connect(dbString, next)
                } else {
                    self.connect(dbString)
                }
            }, 5000)

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

            setTimeout(() => {
                self.emit('ready', false, self.instance);
            }, 300);
            // self.emit('ready', false, self.instance);
        }

        dbString.bucketName = dbString.database;

        try {

            // if ( typeof(dbString.password) != 'undefined' && typeof(self.cluster.authenticate) == 'undefined' ) {
            //     conn = await self.cluster.openBucket(dbString.database, dbString.password, function onBucketOpened(bErr) {
            //         if (bErr) {
            //             cb(bErr)
            //         } else {
            //             conn.sdk        = sdk;
            //             self.instance   = conn;
            //             onConnect(cb);
            //         }
            //     });
            // } else {
            //     conn = await self.cluster.openBucket(dbString.database, function onBucketOpened(bErr) {
            //         if (bErr) {
            //             cb(bErr)
            //         } else {
            //             conn.sdk        = sdk;
            //             self.instance   = conn;
            //             onConnect(cb);
            //         }
            //     });
            // }

            console.debug('[CONNECTOR][' + local.bundle +'][' + dbString.database +'] Trying to connect to bucket `'+ dbString.bucketName +'`');
            conn = await couchbase.connect(dbString.protocol + dbString.host, dbString, function onBucketOpened(bErr, conn) {
                if (bErr) {
                    // console.emerg('[CONNECTOR][' + local.bundle +'] Could not connect to couchbase @`'+ dbString.protocol + dbString.host +'`\n'+ (bErr.stack || bErr.message || bErr) + '\nCheck:\n - if couchbabse is running\n - if bucket `'+dbString.bucketName+'` exists\n - if you have permission to access couchbase' );
                    var cErr = new Error('[CONNECTOR][' + local.bundle +'] Could not connect to couchbase @`'+ dbString.protocol + dbString.host +'`\n'+ (bErr.stack || bErr.message || bErr) + '\nCheck:\n - if couchbabse is running\n - if bucket `'+dbString.bucketName+'` exists\n - if you have permission to access couchbase');

                    if ( typeof(cb) != 'undefined' ) {
                        return cb(cErr)
                    }
                    // return self.emit('ready', bErr, null);
                    self.instance   = {}
                    return onError(cErr, cb)
                }
                conn.sdk        = sdk;
                conn.useRestApi = local.options.useRestApi;

                // Default maxBuffer is 200KB (=> 1024 * 200)
                // Setting it to 10MB - preventing: stdout maxBuffer length exceeded
                var maxQueryBuffer = (1024 * 1024 * 10);
                var body = null;
                // When conn.useRestApi == true
                conn.restQuery = function(trigger, statement, queryParams, onQueryCallback) {
                    statement = statement.replace(/\'/g, '"');
                    body = statement;
                    body += '&args='+ arrayToValues(queryParams.parameters);
                    // body += '&auto_execute=true'
                    if ( typeof(queryParams.scanConsistency) != 'undefined' ) {
                        body += '&scan_consistency='+ queryParams.scanConsistency
                    }
                    body += '\'';
                    // https://docs.couchbase.com/server/current/n1ql-rest-query/index.html#Request
                    var cmd = [
                        '$(which curl)',
                        '-v http://'+ dbString.host.split(/\,/g)[0].trim() +':8093/query/service',
                        // '-d \'statement='+ statement +'&args='+ arrayToValues(queryParams.parameters) +'&auto_execute=true\'',
                        '-d \'statement='+ body,
                        '-u '+ dbString.username +':'+ dbString.password
                    ];
                    exec(cmd.join(' '), { maxBuffer: maxQueryBuffer }, function onResult(resErr, resTxt, infos) {
                        var error = null;
                        if (resErr) {
                            try {
                                error = new Error('[CONNECTOR][' + local.bundle +'] query '+ trigger +' aborted\n'+ resErr.stack);
                                console.error(error.stack);
                                onQueryCallback(error);
                            } catch (_err) {
                                console.error(_err.stack);
                            }
                            return;
                        }
                        let res = JSON.parse(resTxt);
                        let err = res.errors;
                        let data = {
                            rows: res.results,
                            meta: {
                                resquestId: res.requestID,
                                status: res.status,
                                metrics: res.metrics
                            }
                        };

                        if (err) {
                            try {
                                error = new Error(err.msg);
                                error.stack = trigger;
                                onQueryCallback(error);
                            } catch (_err) {
                                console.error(_err.stack);
                            }
                            return;
                        }
                        try {
                            if ( typeof(data) == 'undefined' ) {
                                data = { rows: []}
                            }
                            onQueryCallback(false, data.rows, data.meta);
                        } catch (_err) {
                            _err.stack = '[ ' + trigger + '] onQueryCallbackError: \n\t- Did you leave any bad comments ?\n\t- Did you try to run your query ?\r\n'+ query +'\r\n'+ _err.stack;
                            console.error(_err.stack);
                        }
                    });
                };

                // open bucket
                console.debug('[CONNECTOR][' + local.bundle +'][' + dbString.database +'] Connecting to bucket `'+ dbString.bucketName +'`');
                var bucketConn = conn.bucket(dbString.bucketName);
                bucketConn.sdk = sdk;
                bucketConn.useRestApi = local.options.useRestApi;
                // Get a reference to the default collection, required only for older Couchbase server versions
                // defaultCollection = bucketConn.defaultCollection();
                // default scope
                // default collection
                self.instance   = bucketConn;
                onConnect(cb);

                // return bucketConn
            });

        } catch (err) {
            console.error('[ CONNECTOR ][ ' + local.bundle +' ] '+ local.env +' ] couchbase could not connect to bucket `'+ dbString.database +'`\n'+ (err.stack || err.message || err) );
            onError(err, cb)
        }


        // return conn
        return self.instance
    }

    /**
     * init
     *
     * @param {object} dbString
     *
     * @contructor
     * */
    var init = function(dbString) {

        try {
            local.bundle    = getConfig().bundle;// jshint ignore:line
            console.debug('[CONNECTOR][' + local.bundle +'][' + dbString.connector +'][' + dbString.database +'] Checking dbString.host: '+ dbString.host);
            // console.debug('[CONNECTOR][' + local.bundle +'][' + dbString.connector +'][' + dbString.database +'] dbString:\n'+ JSON.stringify(dbString, null, 2));
            // console.debug('[CONNECTOR][' + local.bundle +'][' + dbString.connector +'][' + dbString.database +'] local.options:\n'+ JSON.stringify(local.options, null, 2));
            dbString        = merge(dbString, local.options);
            local.options   = dbString;


            console.info('[CONNECTOR][' + local.bundle +'][' + dbString.connector +'][' + dbString.database +'] authenticating to couchbase cluster @'+ dbString.protocol + dbString.host);

            try {
                self.cluster = new couchbase.Cluster(dbString.protocol + dbString.host);
                // version 5.x
                if ( typeof(self.cluster.authenticate) != 'undefined' )
                    self.cluster.authenticate(dbString.username, dbString.password);
            } catch(_err) {
                console.error('[CONNECTOR][' + local.bundle +'] Could not authenticate to couchbase @`'+ dbString.protocol + dbString.host +'`\n'+ (_err.stack || _err.message || _err) );
            }

            console.info('[CONNECTOR][' + local.bundle +'][' + dbString.connector +'][' + dbString.database +'] Connecting to couchbase cluster @'+ dbString.protocol + dbString.host);

            self.connect(dbString)

        } catch (err) {
            console.error(err.stack);
            self.emit('ready', err, null)
        }
    }



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
                clearInterval(self.pingId )
            }

            interval    = interval || options.pingInterval; // for a minute
            var value       = interval.match(/\d+/);
            var unit        = null; // will be seconds by default
            try {
                unit = interval.match(/[a-z]+/i)[0]
            } catch(err) {
                unit = 's'
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
                    interval = value * 1000
            }

            self.pingId = setInterval(function onTimeout(){

                if (!self.instance.connected) {
                    console.debug('[ CONNECTOR ][ ' + local.bundle +' ] connecting to couchbase');

                    self.instance.reconnected = false;
                    self.instance.reconnecting = true;
                    if ( typeof(next) != 'undefined' ) {
                        self.connect(dbString, next)
                    } else {
                        self.connect(dbString)
                    }

                } else {
                    self.ping(options.pingInterval, cb, ncb);
                }

            }, interval);
            ncb(cb)
        } else {
            console.debug('[ CONNECTOR ][ ' + local.bundle +' ] sent ping to couchbase ...');
            self.ping(interval, cb, ncb);
        }
    }

    this.getInstance = function() {
        return self.instance
    }

    this.onReady = function(cb) {
        self.once('ready', cb);
        init(dbString)
    }
};
util.inherits(Connector, EventEmitter);
module.exports = Connector;