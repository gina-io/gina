"use strict";
/**
 * Isaac Server Integration
 *
 */
const fs                    = require('fs');
const {EventEmitter}        = require('events');
const Eio                   = require('engine.io');

const lib               = require('./../lib');
const inherits          = lib.inherits;
const merge             = lib.merge;
const console           = lib.logger;


const env               = process.env.NODE_ENV
    , isDev             = (/^true$/i.test(process.env.NODE_ENV_IS_DEV)) ? true : false
    , scope             = process.env.NODE_SCOPE
    , isLocalScope      = (/^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL)) ? true : false
    , isProductionScope = (/^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION)) ? true : false
;

var refreshCore = function() {

    var corePath    = getPath('gina').core;
    var libPath     = getPath('gina').lib;

    var core        = new RegExp( corePath );
    var excluded    = [
        _(corePath + '/gna.js', true)
    ];

    for (let c in require.cache) {
        if ( (core).test(c) && excluded.indexOf(c) < 0 ) {
            require.cache[c].exports = require( _(c, true) )
        }
    }

    // Update lib & helpers
    delete require.cache[require.resolve(_(libPath +'/index.js', true))];
    require.cache[_(libPath +'/index.js', true)] = require( _(libPath +'/index.js', true) );
    require.cache[_(corePath + '/gna.js', true)].exports.lib = require.cache[_(libPath +'/index.js', true)];

    // Update plugins
    delete require.cache[require.resolve(_(corePath +'/plugins/index.js', true))];
    require.cache[_(corePath +'/plugins/index.js', true)] = require( _(corePath +'/plugins/index.js', true) );
    require.cache[_(corePath + '/gna.js', true)].exports.plugins = require.cache[_(corePath +'/plugins/index.js', true)];
}

// Express compatibility
const slice = Array.prototype.slice;


function ServerEngineClass(options) {

    console.debug('[ ENGINE ] Isaac says hello !');

    // TOTO - See if it would be interesting to add it to Helper::Path & to extend it to also readdirSync, returning the directory content
    var readSync = function(filename) {
        var fileObj = new _(filename, true);
        if ( fileObj.isSymlinkSync() ) {
            filename = fileObj.getSymlinkSourceSync()
        }

        return fs.readFileSync(filename).toString()
    }

    // openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj "/CN=localhost" -keyout localhost-privkey.pem -out localhost-cert.pem
    var credentials = {};
    if ( /https/.test(options.scheme) ) {
        try {
            credentials = {
                key: readSync(options.credentials.privateKey),
                cert: readSync(options.credentials.certificate)
            };
        } catch(err) {
            console.emerg('You are trying to start a secured server (https) wihtout suficient credentials: check your `server settings`\n'+ err.stack);
            process.exit(1)
        }
    }


    var allowHTTP1 = true; // by default
    if (typeof (options.allowHTTP1) != 'undefined' && options.allowHTTP1 != '' ) {
        allowHTTP1 = options.allowHTTP1;
    }
    credentials.allowHTTP1 = allowHTTP1;


    if (typeof (options.credentials.ca) != 'undefined' && options.credentials.ca != '' )
        credentials.ca = options.credentials.ca;

    if (typeof (options.credentials.pfx) != 'undefined' && options.credentials.pfx != '' )
        credentials.pfx = readSync(options.credentials.pfx);

    if (typeof (options.credentials.passphrase) != 'undefined' && options.credentials.passphrase != '' )
        credentials.passphrase = options.credentials.passphrase;

    var server = null, http = null, ioServer = null;

    if ( /^http\/2/.test(options.protocol) ) {
        var http2   = require('http2');
        switch (options.scheme) {
            case 'http':
                server      = http2.createServer({ allowHTTP1: allowHTTP1 });
                break;

            case 'https':
                server      = http2.createSecureServer(credentials);
                break;

            default:
                server      = http2.createServer({ allowHTTP1: allowHTTP1 });
                break;
        }
    } else {

        switch (options.scheme) {
            case 'http':
                http        = require('http');
                server      = http.createServer();
                break;

            case 'https':
                var https   = require('https');
                server      = https.createServer(credentials);
                break;

            default:
                http        = require('http');
                server      = http.createServer();
                break;
        }
    }


    const middleware = function(path, cb) {

        // if (request.path === path) {
        //     onPath.call(this, path, cb)
        // }  else { // 404
        //     stream.respond({
        //         'content-type': 'text/html',
        //         ':status': 404
        //     });
        //     stream.end('<h1>404</h1>');
        // }
    }


    const onPath = function(path, cb, allowAll) {

        var queryParams = null
            , i         = null
            , len       = null
            , p         = null
            , arr       = null
            , a         = null
        ;

        // http2stream handle by the Router class & the SuperController class
        // See `${core}/router.js` & `${core}/controller/controller.js`

        server.on('request', (request, response) => {
            // healthcheck
            // TODO - add a top level API : server.api.js (check, get ...)
            // TODO - on 90% RAM usage, redirect to `come back later then restart bundle`
            // TODO - check url against wroot : getContext() ?
            if ( /^get$/i.test(request.method) && /\_gina\/health\/check$/i.test(request.url) ) {
                // server.toApi(reques, response)
                // console.debug('[200] '+ request.url);
                response.setHeader('content-type', 'application/json; charset=utf8' );
                response.setHeader('x-powered-by', 'Gina/'+ GINA_VERSION );
                return response.end('{"status":"ok"}');
            }
            if (isDev) {
                refreshCore()
            }

            if ( /engine.io/.test(request.url)) {
                console.debug('io request');
            }

            if (/^\*$/.test(path) || path == request.url) {
                request.params  = {};
                request.query   = {};

                if ( /\?/.test(request.url) ) {

                    queryParams = request.url.split(/\?/);

                    len = queryParams.length;
                    // fixing `?` > 1 occurence
                    if (len > 2) {
                        queryParams[1] = queryParams.slice(1).join('&');
                        // cleanup
                        queryParams.splice(2);
                        len = queryParams.length;
                    }
                    request.params[0] = queryParams[0];

                    if ( /\&/.test(queryParams[1]) ) {
                        i = 1;
                        for (; i < len; ++i) {

                            arr = queryParams[i].split(/\&/);
                            p = 0;
                            for (; p < arr.length; ++p) {
                                a = arr[p].split(/\=/);
                                // false & true case
                                if ( /^(false|true|on)$/i.test(a[1]) )
                                    a[1] = ( /^(true|on)$/i.test(a[1]) ) ? true : false;
                                else if (a[1] && a[1].indexOf('%') > -1)
                                    a[1] = decodeURIComponent(a[1]);

                                if (/^(\{|\[)/.test(a[1]) ) {
                                    try {
                                        a[1] = JSON.parse(a[1]);
                                    } catch(notAJsonError) {
                                        console.warn('[SERVER][INCOMING REQUEST]', 'Could not convert to JSON or Array this key/value to :' + a[0] + ': '+a[1] +'/nLeaving value as a string.');
                                    }
                                }
                                request.query[ a[0] ] = a[1]
                            }
                        }
                    } else {
                        a = queryParams[1].split(/\=/);

                        if (a.length > 1) {
                            // false & true case
                            if ( /^(false|true|on)$/i.test(a[1]) )
                                a[1] = ( /^(true|on)$/i.test(a[1]) ) ? true : false;

                            request.query[ a[0] ] = a[1]
                        } else { // for redirection purposes or when passing `?encodedJsonObject`
                            try {
                                if ( a[0].indexOf('%') > -1 ) { // encoded URI Component
                                    a[0] = decodeURIComponent(a[0])
                                }

                                request.query = a[0] ? JSON.parse(a[0]) : {};
                            } catch(err) {
                                console.error(err.stack)
                            }
                        }

                    }
                    request.url = request.url.replace(/\?.*/, '')
                } else {
                    request.params[0] = request.url
                }

                var referer     = null
                    , authority = request.scheme + '://'+ request.authority
                    , host      = null
                ;
                if ( typeof(request.headers.origin) != 'undefined' ) {
                    referer = request.headers.origin;
                } else if (request.headers.referer || request.authority) {
                    referer = request.headers.referer || authority;
                }
                var a = null;
                if (authority) {
                    a = authority.match(/^[https://|http://][a-z0-9-_.:/]+/);
                    if (a) {
                        a[0].split(/\//g);
                        a.splice(3);
                        authority = a.join('/');
                        host = authority;
                    }
                }

                if ( referer && /^(https\:\/\/|http\:\/\/)/.test(referer) ) {
                    if (referer != authority ) {
                        a = referer.match(/^[https://|http://][a-z0-9-_.:/]+\//)[0].split(/\//g);
                        a.splice(3);
                        referer = a.join('/');
                    }

                    a = null;
                }
                request.origin = referer;
                if (!host && referer) {
                    host = referer;
                } else if (!host && typeof(request.headers.host) != 'undefined' ) {
                    host = request.headers.host;
                }

                var port = null;
                try {
                    port = host.match(/\:\d+/);
                } catch (portError) {
                    console.warn('[SERVER] Port not in string for host `'+ host +'`.\nSetting default port to 80.');
                }
                if (port) {
                    host = host.replace(port[0], '');
                    port = ~~(port[0].substring(1));
                } else {
                    port = 80;
                }

                if (host) {
                    host = host.replace(/^(https\:\/\/|http\:\/\/)/, '');

                    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Origin
                    if ( /^http\/2/.test(options.protocol) ) {
                        request.headers[':host']    = host;
                        request.headers[':port']    = port;
                    } else if ( typeof(request.headers.hostname) == 'undefined') {
                        request.headers.host = host;
                        request.headers.port = port;
                    }

                    request.port    = port;
                    request.host    = host;

                    port    = null;
                    referer = null;
                }


                cb(request, response);
            }
        });

    }


    // All paths allowed
    server.all = function(path, cb) {
        onPath.call(this, path, cb, true)
    }

    // configuring express plugins|middlewares
    server._expressMiddlewares = [];
    /**
     * <server>.use()
     * Applies middleware for every single route
     *
     * @param {function} fn
     */
    server.use = function use(fn) {

        var offset = 0;
        //var path = '/';

        // default path to '/'
        // disambiguate app.use([fn])
        if (typeof fn !== 'function') {
          var arg = fn;

          while (Array.isArray(arg) && arg.length !== 0) {
            arg = arg[0];
          }

          // first arg is the path
          if (typeof arg !== 'function') {
            offset = 1;
            path = fn;
          }
        }


        var fns = merge(slice.call(arguments, offset));

        if (fns.length === 0) {
          throw new TypeError('server.use() requires a middleware function')
        }

        fns.forEach(function (fn) {
            server._expressMiddlewares[server._expressMiddlewares.length] = fn;
        });

        return this;
    }


    server.on('error', (err) => {
        console.error(err)
    });


    //------------------------------------
    // Engine IO server
    //------------------------------------
    if (
        typeof(options.ioServer) != 'undefined'
        && typeof(options.ioServer.integrationMode) != 'undefined'
        && /^attach$/.test(options.ioServer.integrationMode)
    ) {
        console.info('[IO SERVER ] `eio` found using `'+ options.ioServer.integrationMode +'` integration mode');
        delete options.ioServer.integrationMode;
        // test done in case we would like to switch to socket.io-server
        ioServer = ( typeof(Eio.attach) != 'undefined' ) ? new Eio.attach(server, options.ioServer) : new Eio(server, options.ioServer);

        ioServer.getClientsBySessionId = function(sessionId) {

            if (this.clients.count() == 0)
                return null;

            var clients = null;

            for (let id in this.clients) {

                if ( typeof(this.clients[id].sessionId) == 'undefined' )
                    continue;

                if (!clients) clients = {};

                clients[id] = this.clients[id];
            }

            if (clients) {
                // allowing to send for each client found sharing the same request session
                clients.send = function(payload, option, callback) {
                    for ( var id in this) {
                        if ( typeof(this[id].sessionId) == 'undefined')
                            continue;

                        this[id].send(payload, option, callback)
                    }
                }
            }


            return clients;
        }

        server.eio = ioServer;

        ioServer.on('connection', function (socket) {

            socket.send(JSON.stringify({
                id: this.id,//socket.id,
                handshake: 'Welcomed to `'+ options.bundle +'` main socket !',
                // how many ms before sending a new ping packet
                pingTimeout: options.ioServer.pingTimeout || options.ioServer.timeout,
                // how many ms without a pong packet to consider the connection closed
                pingInterval: options.ioServer.pingInterval || options.ioServer.interval
            }));

            socket.on('message', function(payload){

                try {
                    console.debug('[IO SERVER ] receiving '+ payload);
                    payload = JSON.parse(payload);
                    // bind to session ID
                    if ( typeof(payload.session) != 'undefined' ) {
                        this.sessionId = payload.session.id;
                    }
                } catch(err) {
                    console.error(err.stack||err.message|| err)
                }
            });

            socket.on('close', function(){
                console.debug('[IO SERVER ] closed socket #'+ this.id);
            });
        });

        server.on('upgrade', function(req, socket, head){
            console.debug('[IO SERVER ] upgrading socket #'+ this.id);
            ioServer.handleUpgrade(req, socket, head);
        });
        // httpServer.on('request', function(req, res){
        //     ioServer.handleRequest(req, res);
        // });


    }



    return {
        instance: server,
        middleware: middleware
    }
};

module.exports = ServerEngineClass;