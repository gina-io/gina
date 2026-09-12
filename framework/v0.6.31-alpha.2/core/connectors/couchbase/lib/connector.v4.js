// "use strict";
var fs              = require('fs');
var util            = require('util');
var EventEmitter    = require('events').EventEmitter;
// const exec       = require('child_process').exec;  // CB-SEC-1/2: removed — restQuery now uses http.request()
// CB-LOW-1 fix: uuid import removed in 0.3.1 — was imported but never called.
var couchbase       = require(getPath('project') +'/node_modules/couchbase');// jshint ignore:line
var gina            = require('../../../../core/gna');
var lib             = gina.lib;
var console         = lib.logger;
var merge           = lib.merge;
var modelUtil       = new lib.Model();
// #B432 — per-call at-most-once settle guard for a connector outcome
// (core/connectors/settle-once.js).
var settleOnce      = require('./../../settle-once');



/**
 * Connector for couchbase module v4
 *
 * Options :
 *  - keepAlive (default: true)
 *      if set to `true`, will ping based on `pingInterval`
 *      if set to `false`, will not ping the database server
 *  - pingInterval (default: 2m)
 *      `30s` will set the ping interval to 30 seconds
 *      `1m` will set the ping interval to 1 minute
 *      `1h` will set the ping interval to 1 hour
 *      `1d` will set the ping interval to 1 day
 *  - readyTimeout (default: 50000)
 *      milliseconds to wait for the connector to become ready at boot before
 *      failing loudly. Values at or above the CLI's ~64s bundle-start budget
 *      (`lib/cmd/bundle/start.js`) cannot take effect.
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
                pingInterval: "2m",
                // #B541 — boot readiness deadline, in milliseconds.
                readyTimeout: 50000,
                // https://docs.couchbase.com/sdk-api/couchbase-node-client/interfaces/TimeoutConfig.html
                // timeouts:  {
                //     kvTimeout: 10000, // milliseconds
                // }
            }
        }
        , sdk = {
            version: 4
        }
    ;

    // #B541 — boot readiness state. `_markSettled()` records that `ready` has
    // been settled and disarms the boot deadline armed in init(); it does NOT
    // gate `self.emit('ready', …)`. Repeat emits are load-bearing:
    // `core/model/index.js` attaches a persistent `.on('ready')` that surfaces
    // reconnect churn on the Inspector event signal, and both `onReady`
    // consumers register `once`, which already drops a late delivery.
    var _settled        = false
        , _deadlineId   = null
    ;

    /**
     * Record that `ready` has been settled and disarm the boot deadline.
     *
     * Idempotent — a reconnect calls it again, by which point the timer is
     * already `null`.
     *
     * @memberof Connector
     * @inner
     * @returns {void}
     *
     * @example
     * _markSettled();
     * self.emit('ready', false, self.instance);
     */
    var _markSettled = function() {
        _settled = true;
        if (_deadlineId) {
            clearTimeout(_deadlineId);
            _deadlineId = null;
        }
    };

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
        var conn = null, defaultCollection = null;

        // #B541 — one outcome per connect attempt.
        //
        // On failure the couchbase SDK settles BOTH of its channels: it invokes
        // the onBucketOpened callback AND rejects the awaited promise. So a
        // single failed attempt called onError twice, arming TWO retry chains —
        // and each of those, failing in turn, armed two more (2 -> 4 -> 8 ...) —
        // while double-counting _reconnectAttempts, so the backoff escalated at
        // twice the intended rate and reached its 60s cap after five real
        // attempts instead of ten. The guard is minted PER connect() invocation,
        // never at module scope, so a later reconnect's own attempt stays
        // independently reportable.
        var onError = settleOnce('couchbase-v' + sdk.version + ':connector#connect', function onErrorImpl(err, next) {
            // The promise channel can run WITHOUT the callback channel having
            // run first (a rejection that never calls back), and only the
            // callback channel assigns self.instance — which is not initialised
            // at construction. Without this guard that ordering throws here,
            // before any retry is armed, and the throw surfaces only as an
            // unhandled rejection of the bare self.connect(dbString) call.
            if (!self.instance) self.instance = {};
            delete self.instance.reconnecting;
            self.instance.reconnected = self.instance.connected = false;
            console.debug('[CONNECTOR][' + local.bundle +'] Scope is: '+ process.env.NODE_SCOPE );
            console.debug('[CONNECTOR][' + local.bundle +'] Env is: '+ process.env.NODE_ENV );
            console.error('[CONNECTOR][' + local.bundle +'] Couchbase could not be reached !!\n'+ ( err.stack || err.message || err ) );

            // CB-LOW-5 fix: exponential backoff replaces hardcoded 5s retry.
            // Delay sequence: 5s → 10s → 20s → 40s → 60s (cap). Counter reset in onConnect().
            self._reconnectAttempts = (self._reconnectAttempts || 0) + 1;
            var _backoffDelay = Math.min(5000 * Math.pow(2, self._reconnectAttempts - 1), 60000);
            if (self._reconnectAttempts >= 10) {
                console.error('[CONNECTOR][' + local.bundle +'][' + dbString.database +'] Reconnect attempt ' + self._reconnectAttempts + ' — max backoff reached (' + (_backoffDelay/1000) + 's). Couchbase may be unavailable.');
            } else {
                console.debug('[CONNECTOR][' + local.bundle +'][' + dbString.database +'] Reconnect attempt ' + self._reconnectAttempts + ' — retrying in ' + (_backoffDelay/1000) + 's...');
            }
            self.instance.reconnecting = true;

            setTimeout( function onRetry(){
                if ( typeof(next) != 'undefined' ) {
                    self.connect(dbString, next)
                } else {
                    self.connect(dbString)
                }
            }, _backoffDelay)

        }, console);

        // once
        var onConnect = function onConnect(cb){
            console.debug('[CONNECTOR][' + local.bundle +'] Couchbase is alive !!');
            console.debug('[CONNECTOR][' + local.bundle +'][' + dbString.connector +'] Now connected...');

            // CB-LOW-5 fix: reset backoff counter on successful (re)connect.
            self._reconnectAttempts = 0;
            self.instance.reconnected  = self.instance.connected   = true;
            var options = local.options;

            // updating context
            var ctx = getContext()// jshint ignore:line
                , bundle = ctx.bundle
                , env = ctx.env
                , conf = ctx['gina'].config.envConf[bundle][env]
                , name = dbString.database
                //Reload models.
                , modelsPath = _(conf.modelsPath)// jshint ignore:line
            ;
            // will send heartbeat every 4 minutes if keepAlive == `true`
            self.ping(options.pingInterval, cb, function onPing(cb){

                local.bundle    = bundle;
                local.env       = env;

                if ( typeof(cb) != 'undefined' ) { // this portition is not working yet on Mac OS X
                    console.debug('[CONNECTOR][' + local.bundle +']['+ env +'] Connected to couchbase !!');


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
                        cb(new Error('[CONNECTOR][' + local.bundle +']['+ env +'] '+ modelsPath+ ' not found') )
                    }

                } else {
                    console.debug('[CONNECTOR][' + local.bundle +']['+ env +'] Connection to bucket `'+ name +'` is being kept alive ...');
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
                    // #B204 — no supported SDK (3.x/4.x) exports a bare `Error` class, so the
                    // un-guarded instanceof threw TypeError and, being evaluated first, made
                    // the message arm below unreachable too. Guarded: the arm is inert on
                    // modern SDKs (their errors carry no numeric .code), never a throw.
                    typeof(couchbase.Error) == 'function' && err instanceof couchbase.Error && err.code == 16 && !self.reconnected
                    //|| err instanceof couchbase.Error && err.code == 23 && !self.reconnecting
                    || /cannot perform operations on a shutdown bucket/.test(err.message ) && !self.reconnecting && !self.reconnected
                ) {
                    // CB-LOW-5 fix: exponential backoff (shared counter with connect onError).
                    self._reconnectAttempts = (self._reconnectAttempts || 0) + 1;
                    var _backoffDelay = Math.min(5000 * Math.pow(2, self._reconnectAttempts - 1), 60000);
                    if (self._reconnectAttempts >= 10) {
                        console.error('[CONNECTOR][' + local.bundle +'][' + dbString.database +'] Reconnect attempt ' + self._reconnectAttempts + ' — max backoff reached (' + (_backoffDelay/1000) + 's). Couchbase may be unavailable.');
                    } else {
                        console.debug('[CONNECTOR][' + local.bundle +'][' + dbString.database +'] Reconnect attempt ' + self._reconnectAttempts + ' — retrying in ' + (_backoffDelay/1000) + 's...');
                    }
                    self.reconnecting = true;

                    setTimeout( function onRetry(){
                        if ( typeof(next) != 'undefined' ) {
                            self.connect(dbString, next)
                        } else {
                            self.connect(dbString)
                        }
                    }, _backoffDelay)

                } else if (typeof(couchbase.Error) == 'function' && err instanceof couchbase.Error && err.code == 23 && !self.reconnecting) { // #B204 — guarded, same reason as above
                    self.instance.disconnect();
                    // express js patch
                    if (typeof(next) != 'undefined') {
                        next(err); // might just be a "false" error: `err` is replaced with cb() caller `data`
                    } else {
                        console.error('[CONNECTOR][' + local.bundle +'][' + dbString.database +'] gina fatal error ('+ err.code +'): ' + (err.message||err) + '\nstack: '+ err.stack);
                        return;
                    }
                } else {

                    if (err && err instanceof Error) {

                        console.error('[CONNECTOR][' + local.bundle +'][' + dbString.database +'] gina fatal error ('+ err.code +'): ' + (err.message||err) + '\nstack: '+ err.stack);

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
                            console.error('[CONNECTOR][' + local.bundle +'][' + dbString.database +'] gina fatal error ('+ err.code +'): ' + (err.message||err) + '\nstack: '+ err.stack);
                            return;
                        }
                    }
                }
                });
            }

            // CB-PERF-1 fix: replaced 300ms arbitrary timer with direct synchronous emit.
            // The timer was added because "something was not working yet on Mac OS X" —
            // root cause was never identified. It adds 300ms to every bundle startup and
            // is unreliable: if downstream setup takes >300ms, ready fires before setup
            // completes. Original broken implementation:
            // setTimeout(() => {
            //     self.emit('ready', false, self.instance);
            // }, 300);
            // #B541 — disarm the boot deadline; the emit itself stays ungated.
            _markSettled();
            self.emit('ready', false, self.instance);

        };


        dbString.bucketName = dbString.database;

        try {
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

                // CB-SEC-1 / CB-SEC-2 fix: replaced exec(curl...) with http.request()
                // — credentials sent via Authorization header, never in process list (ps aux)
                // — no shell involved; metacharacters in statement/parameters cannot execute commands
                // Original exec-based implementation (commented out — CB-SEC-1/CB-SEC-2):
                // var maxQueryBuffer = (1024 * 1024 * 10);
                // var body = null;
                // conn.restQuery = function(trigger, statement, queryParams, onQueryCallback) {
                //     statement = statement.replace(/\'/g, '"');
                //     body = statement;
                //     body += '&args='+ arrayToValues(queryParams.parameters);
                //     if ( typeof(queryParams.scanConsistency) != 'undefined' ) {
                //         body += '&scan_consistency='+ queryParams.scanConsistency
                //     }
                //     body += '\'';
                //     var cmd = [
                //         '$(which curl)',
                //         '-v http://'+ dbString.host.split(/\,/g)[0].trim() +':8093/query/service',
                //         '-d \'statement='+ body,
                //         '-u '+ dbString.username +':'+ dbString.password  // ← credentials in process list
                //     ];
                //     exec(cmd.join(' '), { maxBuffer: maxQueryBuffer }, function onResult(resErr, resTxt, infos) { ... });
                // };
                // When conn.useRestApi == true
                // https://docs.couchbase.com/server/current/n1ql-rest-query/index.html#Request
                conn.restQuery = function(trigger, statement, queryParams, onQueryCallback) {
                    var http = require('http');
                    statement = statement.replace(/\'/g, '"');
                    var postParts = ['statement=' + encodeURIComponent(statement)];
                    if (queryParams.parameters && queryParams.parameters.length > 0) {
                        postParts.push('args=' + encodeURIComponent(arrayToValues(queryParams.parameters)));
                    }
                    if (typeof(queryParams.scanConsistency) !== 'undefined') {
                        postParts.push('scan_consistency=' + encodeURIComponent(queryParams.scanConsistency));
                    }
                    var postBody   = postParts.join('&');
                    var hostParts  = dbString.host.split(/\,/g)[0].trim().split(':');
                    var reqOptions = {
                        hostname: hostParts[0],
                        port    : parseInt(hostParts[1], 10) || 8093,
                        path    : '/query/service',
                        method  : 'POST',
                        headers : {
                            'Content-Type'  : 'application/x-www-form-urlencoded',
                            'Content-Length': Buffer.byteLength(postBody),
                            'Authorization' : 'Basic ' + Buffer.from(dbString.username + ':' + dbString.password).toString('base64')
                        }
                    };
                    var req = http.request(reqOptions, function onResult(res) {
                        var chunks = [];
                        res.on('data', function(chunk) { chunks.push(chunk); });
                        res.on('end', function() {
                            var error = null;
                            try {
                                var result = JSON.parse(Buffer.concat(chunks).toString());
                                var resErr = result.errors;
                                var data   = {
                                    rows: result.results,
                                    meta: { requestId: result.requestID, status: result.status, metrics: result.metrics }
                                };
                                if (resErr) {
                                    try {
                                        error = new Error(resErr[0] ? resErr[0].msg : JSON.stringify(resErr));
                                        error.stack = trigger;
                                        onQueryCallback(error);
                                    } catch (_err) { console.error(_err.stack); }
                                    return;
                                }
                                try {
                                    if (typeof(data) === 'undefined') { data = { rows: [] }; }
                                    onQueryCallback(false, data.rows, data.meta);
                                } catch (_err) {
                                    _err.stack = '[ ' + trigger + '] onQueryCallbackError: \n\t- Did you leave any bad comments ?\n\t- Did you try to run your query ?\r\n'+ _err.stack;
                                    console.error(_err.stack);
                                }
                            } catch (_err) { console.error(_err.stack); onQueryCallback(_err); }
                        });
                    });
                    req.on('error', function(resErr) {
                        try {
                            var error = new Error('[CONNECTOR][' + local.bundle +'] query '+ trigger +' aborted\n'+ resErr.stack);
                            console.error(error.stack);
                            onQueryCallback(error);
                        } catch (_err) { console.error(_err.stack); }
                    });
                    req.write(postBody);
                    req.end();
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
            console.error('[CONNECTOR][' + local.bundle +']['+ local.env +'] Couchbase could not connect to bucket `'+ dbString.database +'`\n'+ (err.stack || err.message || err) );
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

            // #B541 — arm the boot readiness deadline.
            //
            // Every failure path in connect() routes to onError(), which only
            // re-arms a retry — it never emits. Without this, a connector that
            // cannot reach couchbase at boot NEVER settles: lib/model.js's
            // all-or-nothing ready gate never closes, the bundle never prints
            // the flags bundle:start watches for, and the CLI SIGKILLs it at
            // ~64s (lib/cmd/bundle/start.js: maxRetry 15 x maxTimeout 4000ms)
            // with no terminal error logged anywhere.
            //
            // lib/model.js's onModelReady ALREADY handles an error correctly —
            // console.error + process.exit(1) — and that is how every other
            // connector reports a dead database. It was simply unreachable
            // here. So if nothing has settled by the deadline, emit the error
            // ourselves and let that existing path run.
            //
            // NOT a retry cap: onError's uncapped reconnect is untouched, so a
            // connector that HAS settled still recovers from a later blip.
            // Deliberately NOT unref'd — were this the only handle holding the
            // event loop, unref would let node exit 0 silently instead of
            // reporting, and onError's retry timer already holds the loop.
            var _readyTimeout = ( typeof(local.options.readyTimeout) == 'number' && local.options.readyTimeout > 0 )
                ? local.options.readyTimeout
                : 50000;

            if ( !_settled && !_deadlineId ) {
                _deadlineId = setTimeout(function onReadyDeadline() {
                    _deadlineId = null;
                    if (_settled) return;

                    _markSettled();
                    self.emit('ready', new Error('[CONNECTOR][' + local.bundle +'][' + dbString.connector +'][' + dbString.database +'] Couchbase did not become ready within '+ (_readyTimeout/1000) +'s @`'+ dbString.protocol + dbString.host +'`\nCheck:\n - if couchbase is running and reachable from this host\n - if bucket `'+ dbString.database +'` exists\n - if the credentials are valid\nRaise `readyTimeout` on this connector entry to wait longer; it must stay under the ~64s bundle-start budget to take effect.'), null);
                }, _readyTimeout);
            }

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
            // #B541 — a synchronous throw already settles; disarm the deadline.
            _markSettled();
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
                clearInterval(self.pingId)
            }

            interval    = interval || options.pingInterval; // for a minute
            var value = interval.match(/\d+/);
            var unit  = null; // will be seconds by default
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
                    console.debug('[CONNECTOR][' + local.bundle +'] Connecting to couchbase');

                    self.instance.reconnected = false;
                    self.instance.reconnecting = true;
                    if ( typeof(cb) != 'undefined' ) {
                        self.connect(dbString, cb)
                    } else {
                        self.connect(dbString)
                    }

                } else {
                    self.ping(options.pingInterval, cb, ncb);
                }

            }, interval);

            ncb(cb)
        } else {
            // CB-BUG-4 fix: keepAlive is false — ping is a no-op; do not recurse
            // old: console.debug('[CONNECTOR][' + local.bundle +'] Sent ping to couchbase ...');
            // old: self.ping(interval, cb, ncb);  ← unconditional recursion → stack overflow
            return;
        }
    }

    this.getInstance = function() {
        return self.instance
    }

    this.onReady = function(cb) {
        self.once('ready', cb);
        init(dbString)
    }
}

util.inherits(Connector, EventEmitter);
module.exports = Connector;