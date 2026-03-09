//Imports.
var fs              = require('fs');
var path            = require('path');
var EventEmitter    = require('events').EventEmitter;
var express         = require('express');
var zlib            = require('zlib'); // gzip / deflate
var url             = require('url');
var Config          = require('./config');
var Router          = require('./router');
var util            = require('util');
var utils           = require('./utils');
var inherits        = utils.inherits;
var merge           = utils.merge;
var Proc            = utils.Proc;
var console         = utils.logger;
var multiparty      = utils.multiparty;


function Server(options) {
    var self = this;
    var local = {
        router : null,
        hasViews: {}
    };

    this.conf = {
        core: {}
    };

    this.routing = {};
    //this.activeChild = 0;

    /**
     * Set Configuration
     * @param {object} options Configuration
     *
     *
     * @callback callback responseCallback
     * @param {boolean} complete
     * @public
     */
    var init = function(options) {

        //Starting app.
        self.appName        = options.bundle;

        self.env            = options.env;
        self.version        = options.version;
        local.router        = new Router(self.env);

        //True => multiple bundles sharing the same server (port).
        self.isStandalone   = options.isStandalone;
        self.executionPath  = options.executionPath;
        self.bundles        = options.bundles;

        if (!self.isStandalone) {
            //Only load the related conf / env.
            self.conf[self.appName] = {};
            self.conf[self.appName][self.env] = options.conf[self.appName][self.env];
            self.conf[self.appName][self.env].bundlesPath = options.conf[self.appName][self.env].bundlesPath;
            self.conf[self.appName][self.env].modelsPath =  options.conf[self.appName][self.env].modelsPath;
            if (!self.conf[self.appName][self.env].server.request) {
                self.conf[self.appName][self.env].server.request = {
                    isXMLRequest: false
                }
            }
        } else {

            //console.log("Running mode not handled yet..", self.appName, " VS ", self.bundles);
            //Load all conf for the related apps & env.
            var apps = self.bundles;
            for (var i=0; i<apps.length; ++i) {
                self.conf[apps[i]] = {};
                self.conf[apps[i]][self.env] = options.conf[apps[i]][self.env];
                self.conf[apps[i]][self.env].bundlesPath = options.conf[apps[i]][self.env].bundlesPath;
                self.conf[apps[i]][self.env].modelsPath = options.conf[apps[i]][self.env].modelsPath;
                if (!self.conf[apps[i]][self.env].server.request) {
                    self.conf[apps[i]][self.env].server.request = {
                        isXMLRequest: false
                    }
                }
            }
        }

        // getting server core config
        var statusCodes = null
            , mime      = null;

        try {
            //var corePath = getPath('gina.core');
            var corePath = getPath('gina').core;
            statusCodes = fs.readFileSync( _( corePath + '/status.codes') ).toString();
            statusCodes = JSON.parse(statusCodes);
            if ( typeof(statusCodes['_comment']) != 'undefined' )
                delete statusCodes['_comment'];

            mime  = fs.readFileSync(corePath + '/mime.types').toString();
            mime  = JSON.parse(mime);
            if ( typeof(mime['_comment']) != 'undefined' )
                delete mime['_comment'];

            self.conf.core.statusCodes  = statusCodes;
            self.conf.core.mime         = mime

        } catch(err) {
            console.error(err.stack||err.message);
            process.exit(1)
        }

        self.emit('configured', false, express(), express, self.conf[self.appName][self.env]);
    }


    this.start = function(instance) {

        if (instance) {
            self.instance = instance
        }

        onRoutesLoaded( function(err) {//load all registered routes in routing.json
            console.debug('Routing loaded' + '\n'+ JSON.stringify(self.routing, null, '\t'));
            
            if ( hasViews(self.appName) ) {
                utils.url(self.conf[self.appName][self.env], self.routing)
            }

            if (!err) {
                onRequest()
            }
        })
    }

    /**
     * onRoutesLoaded
     *
     *
     * */
    var onRoutesLoaded = function(callback) {

        var config                  = new Config()
            , conf                  = config.getInstance(self.appName)
            , serverCoreConf        = self.conf.core
            , routing               = {}
            , reverseRouting        = {}
            , cacheless             = config.isCacheless()
            , env                   = self.env
            , apps                  = conf.allBundles//conf.bundles
            , filename              = ''
            , appName               = ''
            , tmp                   = {}
            , standaloneTmp         = {}
            , main                  = ''
            , tmpContent            = ''
            , i                     = 0
            , file                  = null // template file
            , wroot                 = null
            , hasWebRoot            = false
            , webrootAutoredirect   = null
            , localWroot            = null
            , originalRules         = []
            , oRuleCount            = 0;

        //Standalone or shared instance mode. It doesn't matter.
        for (; i<apps.length; ++i) {
            config.setServerCoreConf(apps[i], self.env, serverCoreConf);

            var appPath = _(conf.envConf[apps[i]][self.env].bundlesPath+ '/' + apps[i]);
            appName     =  apps[i];

            //Specific case.
            if (!self.isStandalone && i == 0) appName = apps[i];

            try {
                main        = _(appPath + '/config/' + conf.envConf[apps[i]][self.env].files.routing);
                filename    = main;//by default
                filename    = conf.envConf[apps[i]][self.env].files.routing.replace(/.json/, '.' +env + '.json');
                filename    = _(appPath + '/config/' + filename);
                //Can't do a thing without.
                if ( !fs.existsSync(filename) ) {
                    filename = main
                }

                if (cacheless) {
                    delete require.cache[_(filename, true)]
                }

                if (filename != main) {
                    routing = tmpContent = merge(require(main), require(filename), true);

                } else {
                    try {
                        tmpContent = require(filename);
                    } catch (err) {
                        // do not block here because the bundle is not build for the same env
                        console.warn(err.stack);
                        continue
                    }
                }

                try {

                    wroot               = conf.envConf[apps[i]][self.env].server.webroot;
                    webrootAutoredirect = conf.envConf[apps[i]][self.env].server.webrootAutoredirect;
                    // renaming rule for standalone setup
                    if ( self.isStandalone && apps[i] != self.appName && wroot == '/') {
                        wroot = '/'+ apps[i];
                        conf.envConf[apps[i]][self.env].server.webroot = wroot
                    }

                    if (wroot.length >1) {
                        hasWebRoot = true
                    } else {
                        hasWebRoot = false
                    }

                    tmp = tmpContent;
                    //Adding important properties; also done in core/config.
                    for (var rule in tmp){
                        tmp[rule +'@'+ appName] = tmp[rule];
                        delete tmp[rule];
                        file = rule;
                        rule = rule +'@'+ appName;


                        tmp[rule].bundle        = (tmp[rule].bundle) ? tmp[rule].bundle : apps[i]; // for reverse search
                        tmp[rule].param.file    = ( typeof(tmp) != 'string' && typeof(tmp[rule].param.file) != 'undefined' ) ? tmp[rule].param.file : file; // get template file
                        // by default, method is inherited from the request
                        if (
                            hasWebRoot && typeof(tmp[rule].param.path) != 'undefined' && typeof(tmp[rule].param.ignoreWebRoot) == 'undefined'
                            || hasWebRoot && typeof(tmp[rule].param.path) != 'undefined' && !tmp[rule].param.ignoreWebRoot
                        ) {
                            tmp[rule].param.path = wroot + tmp[rule].param.path
                        }

                        if (typeof(tmp[rule].url) != 'object') {
                            if (tmp[rule].url.length > 1 && tmp[rule].url.substr(0,1) != '/') {
                                tmp[rule].url = '/'+tmp[rule].url
                            } else if (tmp[rule].url.length > 1 && conf.envConf[apps[i]][self.env].server.webroot.substr(conf.envConf[apps[i]][self.env].server.webroot.length-1,1) == '/') {
                                tmp[rule].url = tmp[rule].url.substr(1)
                            } else {
                                if (wroot.substr(wroot.length-1,1) == '/') {
                                    wroot = wroot.substr(wroot.length-1,1).replace('/', '')
                                }
                            }


                            if (tmp[rule].bundle != apps[i]) { // allowing to override bundle name in routing.json
                                // originalRule is used to facilitate cross bundles (hypertext)linking
                                originalRules[oRuleCount] = ( self.isStandalone && tmp[rule] && apps[i] != self.appName) ? apps[i] + '-' + rule : rule;
                                ++oRuleCount;

                                localWroot = conf.envConf[tmp[rule].bundle][self.env].server.webroot;
                                // standalone setup
                                if ( self.isStandalone && tmp[rule].bundle != self.appName && localWroot == '/') {
                                    localWroot = '/'+ routing[rule].bundle;
                                    conf.envConf[tmp[rule].bundle][self.env].server.webroot = localWroot
                                }
                                if (localWroot.substr(localWroot.length-1,1) == '/') {
                                    localWroot = localWroot.substr(localWroot.length-1,1).replace('/', '')
                                }
                                if ( typeof(tmp[rule].param.ignoreWebRoot) == 'undefined' || !tmp[rule].param.ignoreWebRoot )
                                    tmp[rule].url = localWroot + tmp[rule].url
                            } else {
                                if ( typeof(tmp[rule].param.ignoreWebRoot) == 'undefined' || !tmp[rule].param.ignoreWebRoot )
                                    tmp[rule].url = wroot + tmp[rule].url
                                else if (!tmp[rule].url.length)
                                    tmp[rule].url += '/'
                            }

                        } else {

                            for (var u=0; u<tmp[rule].url.length; ++u) {
                                if (tmp[rule].url[u].length > 1 && tmp[rule].url[u].substr(0,1) != '/') {
                                    tmp[rule].url[u] = '/'+tmp[rule].url[u]
                                } else {
                                    if (wroot.substr(wroot.length-1,1) == '/') {
                                        wroot = wroot.substr(wroot.length-1,1).replace('/', '')
                                    }
                                }
                                if ( typeof(tmp[rule].param.ignoreWebRoot) == 'undefined' || !tmp[rule].param.ignoreWebRoot )
                                    tmp[rule].url[u] = wroot + tmp[rule].url[u]
                                else if (!tmp[rule].url.length)
                                    tmp[rule].url += '/'
                            }
                        }

                        if( hasViews(apps[i]) ) {
                            // This is only an issue when it comes to the frontend dev
                            // views.useRouteNameAsFilename is set to true by default
                            // IF [ false ] the action is used as filename
                            if ( !conf.envConf[apps[i]][self.env].content['views']['default'].useRouteNameAsFilename && tmp[rule].param.bundle != 'framework') {
                                var tmpRouting = [];
                                for (var r = 0, len = tmp[rule].param.file.length; r < len; ++r) {
                                    if (/[A-Z]/.test(tmp[rule].param.file.charAt(r))) {
                                        tmpRouting[0] = tmp[rule].param.file.substring(0, r);
                                        tmpRouting[1] = '-' + (tmp[rule].param.file.charAt(r)).toLocaleLowerCase();
                                        tmpRouting[2] = tmp[rule].param.file.substring(r + 1);
                                        tmp[rule].param.file = tmpRouting[0] + tmpRouting[1] + tmpRouting[2];
                                        ++r
                                    }
                                }
                            }
                        }

                        if ( self.isStandalone && tmp[rule]) {
                            // deprecated: rules are now unique per bundle : rule@bundle
                            //if (apps[i] != self.appName) {
                            //    standaloneTmp[apps[i] + '-' + rule] = JSON.parse(JSON.stringify(tmp[rule]))
                            //} else {
                                standaloneTmp[rule] = JSON.parse(JSON.stringify(tmp[rule]))
                            //}
                        }
                    }// EO for


                } catch (err) {
                    self.routing = routing = null;
                    console.error(err.stack||err.message);
                    callback(err)
                }

            } catch (err) {
                console.warn(err, err.stack||err.message);
                callback(err)
            }


            routing = merge(routing, ((self.isStandalone && apps[i] != self.appName ) ? standaloneTmp : tmp), true);
            // originalRule is used to facilitate cross bundles (hypertext)linking
            for (var r = 0, len = originalRules.length; r < len; r++) { // for each rule ( originalRules[r] )
                routing[originalRules[r]].originalRule = (routing[originalRules[r]].bundle === self.appName ) ?  config.getOriginalRule(originalRules[r], routing) : config.getOriginalRule(routing[originalRules[r]].bundle +'-'+ originalRules[r], routing)
            }

            // reverse routing
            for (var rule in routing) {
                if ( typeof(routing[rule].url) != 'object' ) {
                    reverseRouting[routing[rule].url] = rule
                } else {
                    for (var u = 0, len = routing[rule].url.length; u < len; ++u) {
                        reverseRouting[routing[rule].url[u]] = rule
                    }
                }
            }

            config.setRouting(apps[i], self.env, routing);
            config.setReverseRouting(apps[i], self.env, reverseRouting);

            if (apps[i] == self.appName) {
                self.routing        = routing;
                self.reverseRouting = reverseRouting
            }

        }//EO for.
        

        callback(false)
    }

    var hasViews = function(bundle) {
        var _hasViews = false, conf = new Config().getInstance(bundle);
        if (typeof(local.hasViews[bundle]) != 'undefined') {
            _hasViews = local.hasViews[bundle];
        } else {
            _hasViews = ( typeof(conf.envConf[bundle][self.env].content['views']) != 'undefined' ) ? true : false;
            local.hasViews[bundle] = _hasViews;
        }

        return _hasViews
    }

    var parseCollection = function (collection, obj) {

        for(var i = 0, len = collection.length; i<len; ++i) {
            obj[i] = parseObject(collection[i], obj);
        }

        return obj
    }

    var parseObject = function (tmp, obj) {
        var el      = []
            , key   = null
            ;


        for (var o in tmp) {
            //el[0]   = decodeURIComponent(o);
            //el[1]   = ( typeof(tmp[o]) == 'string') ? decodeURIComponent(tmp[o]) : tmp[o];
            el[0]   = o;
            el[1]   = tmp[o];

            //if ( Array.isArray(el[1]) ) {
            //    obj = parseCollection(el[1], obj)
            //} else {
            if ( /^(.*)\[(.*)\]/.test(el[0]) ) { // some[field] ?
                key = el[0].replace(/\]/g, '').split(/\[/g);
                obj = parseLocalObj(obj, key, 0, el[1])
            } else {
                obj[ el[0] ] = el[1]
            }
        }

        return obj
    }

    var parseBody = function(body) {

        if ( /^(\{|\[|\%7B|\%5B)/.test(body) ) {
            try {
                var obj = {}, tmp = null;

                if ( /^(\%7B|\%5B)/.test(body) ) {
                    tmp = JSON.parse(decodeURIComponent(body))
                } else {
                    tmp = JSON.parse(body)
                }

                if ( Array.isArray(tmp) ) {
                    obj = parseCollection(tmp, obj)
                } else {
                    obj = parseObject(tmp, obj)
                }

                return obj
            } catch (err) {
                console.error('[365] could not parse body:\n' + body)
            }

        } else {
            var obj = {}, arr = body.split(/&/g);
            if ( /(\"false\"|\"true\"|\"on\")/.test(body) )
                body = body.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);


            var el      = {}
                , value = null
                , key   = null;

            for (var i = 0, len = arr.length; i < len; ++i) {
                if (!arr[i]) continue;

                arr[i] = decodeURIComponent(arr[i]);

                if ( /^\{/.test(arr[i]) || /\=\{/.test(arr[i]) || /\=\[/.test(arr[i]) ) {
                    //if ( /^\{/.test(arr[i]) ) { // is a json string
                    try {
                        if (/^\{/.test(arr[i])) {
                            obj = JSON.parse(arr[i]);
                            break;
                        } else {
                            el = arr[i].match(/\=(.*)/);
                            el[0] =  arr[i].split(/\=/)[0];
                            obj[ el[0] ] = JSON.parse( el[1] );
                        }


                    } catch (err) {
                        console.error('[parseBody#1] could not parse body:\n' + arr[i])
                    }
                } else {
                    el = arr[i].split(/=/);
                    if ( /\{\}\"\:/.test(el[1]) ) { //might be a json
                        try {
                            el[1] = JSON.parse(el[1])
                        } catch (err) {
                            console.error('[parseBody#2] could not parse body:\n' + el[1])
                        }
                    }

                    if ( typeof(el[1]) == 'string' && !/\[object /.test(el[1])) {
                        key     = null;
                        el[0]   = decodeURIComponent(el[0]);
                        el[1]   = decodeURIComponent(el[1]);

                        if ( /^(.*)\[(.*)\]/.test(el[0]) ) { // some[field] ?
                            key = el[0].replace(/\]/g, '').split(/\[/g);
                            obj = parseLocalObj(obj, key, 0, el[1])
                        } else {
                            obj[ el[0] ] = el[1]
                        }
                    }
                }
            }

            return obj
        }


    }

    var parseLocalObj = function(obj, key, k, value) {

        if ( typeof(obj[ key[k] ]) == 'undefined' ) {
            obj[ key[k] ] = {};
        }

        for (var prop in obj) {

            if (k == key.length-1) {

                if (prop == key[k]) {
                    obj[prop] = ( typeof(value) != 'undefined' ) ? value : '';
                }

            } else if ( key.indexOf(prop) > -1 ) {
                ++k;
                if ( !obj[prop][ key[k] ] )
                    obj[prop][ key[k] ] = {};


                parseLocalObj(obj[prop], key, k, value)

            }
        }

        return obj;
    }

    var onRequest = function() {

        var apps = self.bundles;
        var webrootLen = self.conf[self.appName][self.env].server.webroot.length;

        self.instance.all('*', function onInstance(request, response, next) {
            local.request = request;
            response.setHeader('X-Powered-By', 'Gina/'+self.version );
            // Fixing an express js bug :(
            // express is trying to force : /path/dir => /path/dir/
            // which causes : /path/dir/path/dir/  <---- by trying to add a slash in the end
            if (
                webrootLen > 1
                && request.url === self.conf[self.appName][self.env].server.webroot + '/' + self.conf[self.appName][self.env].server.webroot + '/'
            ) {
                request.url = self.conf[self.appName][self.env].server.webroot
            }
            //Only for dev & debug purposes.
            self.conf[self.appName][self.env]['protocol'] = request.protocol || self.conf[self.appName][self.env]['hostname'];

            request.body    = {};
            request.get     = {};
            request.post    = {};
            request.put     = {};
            request.delete  = {};
            //request.patch = {}; ???
            //request.cookies = {}; // ???

            // be carfull, if you are using jQuery + cross domain, you have to set the header manually in your $.ajax query -> headers: {'X-Requested-With': 'XMLHttpRequest'}
            self.conf[self.appName][self.env].server.request.isXMLRequest       = ( request.headers['x-requested-with'] && request.headers['x-requested-with'] == 'XMLHttpRequest' ) ? true : false;

            // Passing credentials :
            //      - if you are using jQuery + cross domain, you have to set the `xhrFields` in your $.ajax query -> xhrFields: { withCredentials: true }
            //      - if you are using another solution or doing it by hand, make sure to properly set the header: headers: {'Access-Control-Allow-Credentials': true }
            /**
             * NB.: jQuery
             * The `withCredentials` property will include any cookies from the remote domain in the request,
             * and it will also set any cookies from the remote domain.
             * Note that these cookies still honor same-origin policies, so your JavaScript code can’t access the cookies
             * from document.cookie or the response headers.
             * They can only be controlled by the remote domain.
             * */
            self.conf[self.appName][self.env].server.request.isWithCredentials  = ( request.headers['access-control-allow-credentials'] && request.headers['access-control-allow-credentials'] == true ) ? true : false;

            // multipart wrapper for uploads
            // files are available from your controller or any middlewares:
            //  @param {object} req.files
            if ( /multipart\/form-data;/.test(request.headers['content-type']) ) {
                // TODO - get options from settings.json & settings.{env}.json ...
                // -> https://github.com/andrewrk/node-multiparty
                var opt = self.conf[self.appName][self.env].content.settings.upload;
                // checking size
                var maxSize     = parseInt(opt.maxFieldsSize);
                var fileSize    = request.headers["content-length"]/1024/1024; //MB

                if (fileSize > maxSize) {
                    throwError(response, 431, 'Attachment exceeded maximum file size [ '+ opt.maxFieldsSize +' ]');
                    return false
                }

                var i = 0, form = new multiparty.Form(opt);
                form.parse(request, function(err, fields, files) {
                    if (err) {
                        throwError(response, 400, err.stack||err.message);
                        return
                    }

                    if ( request.method.toLowerCase() === 'post') {
                        for (i in fields) {
                            // should be: request.post[i] = fields[i];
                            request.post[i] = fields[i][0]; // <-- to fixe on multiparty
                        }
                    } else if ( request.method.toLowerCase() === 'get') {
                        for (i in fields) {
                            // should be: request.get[i] = fields[i];
                            request.get[i] = fields[i][0]; // <-- to fixe on multiparty
                        }
                    }

                    request.files = {};
                    for (var i in files) {
                        // should be: request.files[i] = files[i];
                        request.files[i] = files[i][0]; // <-- to fixe on multiparty
                    }

                    if (request.fields) delete request.fields; // <- not needed anymore

                    loadBundleConfiguration(request, response, next, function (err, bundle, pathname, config, req, res, next) {
                        if (!req.handled) {
                            req.handled = true;
                            if (err) {
                                if (!res.headersSent)
                                    throwError(response, 500, 'Internal server error\n' + err.stack, next)
                            } else {
                                handle(req, res, next, bundle, pathname, config)
                            }
                        }
                    })
                })
            } else {

                request.on('data', function(chunk){ // for this to work, don't forget the name attr for you form elements
                    if ( typeof(request.body) == 'object') {
                        request.body = '';
                    }
                    request.body += chunk.toString()
                });

                request.on('end', function onEnd() {
                        // to compare with /core/controller/controller.js -> getParams()
                        switch( request.method.toLowerCase() ) {
                            case 'post':
                                var obj = {}, configuring = false;
                                if ( typeof(request.body) == 'string' ) {
                                    // get rid of encoding issues
                                    try {
                                        if ( !/multipart\/form-data;/.test(request.headers['content-type']) ) {
                                            if ( /application\/x\-www\-form\-urlencoded/.test(request.headers['content-type']) ) {
                                                request.body = request.body.replace(/\+/g, ' ');
                                            }

                                            if ( request.body.substr(0,1) == '?')
                                                request.body = request.body.substr(1);

                                            // false & true case
                                            if ( /(\"false\"|\"true\"|\"on\")/.test(request.body) )
                                                request.body = request.body.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);

                                            obj = parseBody(request.body);
                                            if (obj.count() == 0 && request.body.length > 1) {
                                                try {
                                                    request.post = JSON.parse(request.body);
                                                } catch (err) {}
                                            }
                                        }

                                    } catch (err) {
                                        var msg = '[ '+request.url+' ]\nCould not decodeURIComponent(requestBody).\n'+ err.stack;
                                        console.warn(msg);
                                    }

                                } else {
                                    // 2016-05-19: fix to handle requests from swagger/express
                                    if (request.body.count() == 0 && typeof(request.query) != 'string' && request.query.count() > 0 ) {
                                        request.body = request.query
                                    }
                                    var bodyStr = JSON.stringify(request.body);
                                    // false & true case
                                    if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                                        bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);

                                    obj = JSON.parse(bodyStr)
                                }

                                if ( obj.count() > 0 ) {
                                    // still need this to allow compatibility with express & connect middlewares
                                    request.body = request.post = obj;
                                }

                                // see.: https://www.w3.org/Protocols/rfc2616/rfc2616-sec9.html#POST
                                //     Responses to this method are not cacheable,
                                //     unless the response includes appropriate Cache-Control or Expires header fields.
                                //     However, the 303 (See Other) response can be used to direct the user agent to retrieve a cacheable resource.
                                response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                                response.setHeader('Pragma', 'no-cache');
                                response.setHeader('Expires', '0');

                                // cleaning
                                request.query   = undefined;
                                request.get     = undefined;
                                request.put     = undefined;
                                request.delete  = undefined;
                                break;

                            case 'get':
                                if ( request.query.count() > 0 ) {
                                    request.get = request.query;
                                }
                                // else, matching route params against url context instead once route is identified


                                // cleaning
                                request.query   = undefined;
                                request.post    = undefined;
                                request.put     = undefined;
                                request.delete  = undefined;
                                break;

                            case 'put':
                                // eg.: PUT /user/set/1
                                var obj = {};
                                if ( typeof(request.body) == 'string' ) {
                                    // get rid of encoding issues
                                    try {
                                        if ( !/multipart\/form-data;/.test(request.headers['content-type']) ) {
                                            if ( /application\/x\-www\-form\-urlencoded/.test(request.headers['content-type']) ) {
                                                request.body = request.body.replace(/\+/g, ' ');
                                            }

                                            if ( request.body.substr(0,1) == '?')
                                                request.body = request.body.substr(1);

                                            // false & true case
                                            if ( /(\"false\"|\"true\"|\"on\")/.test(request.body) )
                                                request.body = request.body.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);

                                            obj = parseBody(request.body);

                                            if ( typeof(obj) != 'undefined' && obj.count() == 0 && request.body.length > 1 ) {
                                                try {
                                                    request.put = merge(request.put, JSON.parse(request.body));
                                                } catch (err) {
                                                    console.log('Case `put` [ merge error ]: ' + (err.stack||err.message))
                                                }
                                            }
                                        }

                                    } catch (err) {
                                        var msg = '[ '+request.url+' ]\nCould not decodeURIComponent(requestBody).\n'+ err.stack;
                                        console.error(msg);
                                        throwError(response, 500, msg);
                                    }

                                } else {
                                    // 2016-05-19: fix to handle requests from swagger/express
                                    if (request.body.count() == 0 && typeof(request.query) != 'string' && request.query.count() > 0 ) {
                                        request.body = request.query
                                    }
                                    var bodyStr = JSON.stringify(request.body);
                                    // false & true case
                                    if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                                        bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);

                                    obj = JSON.parse(bodyStr)
                                }

                                if ( obj && typeof(obj) != 'undefined' && obj.count() > 0 ) {
                                    // still need this to allow compatibility with express & connect middlewares
                                    request.body = request.put = merge(request.put, obj);
                                }


                                request.query   = undefined; // added on september 13 2016
                                request.post    = undefined;
                                request.delete  = undefined;
                                request.get     = undefined;
                                break;


                            case 'delete':
                                if ( request.query.count() > 0 ) {
                                    request.delete = request.query;
                                }
                                // else, matching route params against url context instead once route is identified

                                request.post    = undefined;
                                request.put     = undefined;
                                request.get     = undefined;
                                break


                        };

                        loadBundleConfiguration(request, response, next, function (err, bundle, pathname, config, req, res, next) {
                            if (!req.handled) {
                                req.handled = true;
                                if (err) {
                                    if (!res.headersSent)
                                        throwError(response, 500, 'Internal server error\n' + err.stack, next)
                                } else {
                                    handle(req, res, next, bundle, pathname, config)
                                }
                            } else {
                                next()
                            }
                        })

                });

                if (request.end) request.end();

            } //EO if multipart

        });//EO this.instance

        var hostname = self.conf[self.appName][self.env].protocol + '://' + self.conf[self.appName][self.env].host + ':' + self.conf[self.appName][self.env].port[self.conf[self.appName][self.env].protocol];
        console.info(
                '\nbundle: [ ' + self.appName +' ]',
                '\nenv: [ '+ self.env +' ]',
                //'\nport: ' + self.conf[self.appName][self.env].port.http,
                '\npid: ' + process.pid,
                '\nThis way please -> '+ hostname
        );


        self.instance.listen(self.conf[self.appName][self.env].port.http);//By Default 3100
        //self.instance.timeout = 120000; // check node.js express & documentation
        self.emit('started', self.conf[self.appName][self.env])
    }

    var getHead = function(file) {
        var s       = file.split(/\./);
        var ext     = s[s.length-1];
        var type    = undefined;
        var mime    = self.conf[self.appName][self.env].server.coreConfiguration.mime;

        if( typeof(mime[ext]) != 'undefiend' ) {
            type = mime[ext];
            if (!type) {
                console.warn('[ '+file+' ] extension: `'+s[2]+'` not supported by gina: `core/mime.types`. Replacing with `plain/text` ')
            }
        }
        return type || 'plain/text'
    }

    var loadBundleConfiguration = function(req, res, next, callback) {

        var config = new Config();
        config.setBundles(self.bundles);
        var conf = config.getInstance(); // for all loaded bundles
        if ( typeof(conf) != 'undefined') {//for cacheless mode
            self.conf = conf
        }

        var pathname    = url.parse(req.url, true).pathname;
        var bundle      = self.appName; // by default

        // finding bundle
        if (self.isStandalone) {

        end:
            for (var b in conf) {
                if ( typeof(conf[b][self.env].content) != 'undefined' && typeof(conf[b][self.env].content.statics) != 'undefined' && conf[b][self.env].content.statics.count() > 0 ) {
                    for (var s in conf[b][self.env].content.statics) {
                        s = (s.substr(0,1) == '/') ? s.substr(1) : s;
                        if ( (new RegExp('^/'+s)).test(pathname) ) {
                            bundle = b;
                            break end
                        }
                    }
                } else {
                    // no statics ... use startingApp and leave it to handle()
                    self.isNotStatic = true
                    break
                }
            }
        }


        if ( /\/favicon\.ico/.test(pathname) && !hasViews(bundle)) {
            callback(false, bundle, pathname, config, req, res, next);
            return false
        }

        onBundleConfigLoaded(bundle, {
            err         : false,
            config      : config,
            pathname    : pathname,
            req         : req,
            res         : res,
            conf        : config,
            next        : next,
            callback    : callback
        })
    }

    var onBundleConfigLoaded = function(bundle, options) {
        var err         = options.err
            , cacheless = options.config.isCacheless()
            , pathname  = options.pathname
            , req       = options.req
            , res       = options.res
            , config    = options.conf
            , next      = options.next
            , callback  = options.callback;

        //Reloading assets & files.
        if (!cacheless) { // all but dev & debug
            callback(err, bundle, pathname, options.config, req, res, next)
        } else {
            config.refresh(bundle, function(err, routing) {
                if (err) {
                    throwError(res, 500, 'Internal Server Error: \n' + (err.stack||err), next)
                } else {
                    //refreshing routing at the same time.
                    self.routing = routing;
                    callback(err, bundle, pathname, options.config, req, res, next)
                }
            })
        }
    }

    var handle = function(req, res, next, bundle, pathname, config) {
        var matched             = false
            , isRoute           = {}
            , withViews         = hasViews(bundle)
            , router            = local.router
            , cacheless         = config.isCacheless()
            , wroot             = null
            , isXMLRequest      = self.conf[bundle][self.env].server.request.isXMLRequest;

        if (self.conf[bundle][self.env]['hostname'].replace(self.conf[bundle][self.env]['protocol'] + '://', '') != req.headers.host) {
            self.conf[bundle][self.env]['hostname'] = req.headers.host
        }

        router.setMiddlewareInstance(self.instance);

        //Middleware configuration.
        req.setEncoding(self.conf[bundle][self.env].encoding);

        try {
            var params      = {}
                , routing   = JSON.parse(JSON.stringify( config.getRouting(bundle, self.env) ));

            if ( routing == null || routing.count() == 0 ) {
                console.error('Malformed routing or Null value for bundle [' + bundle + '] => ' + req.originalUrl);
                throwError(res, 500, 'Internal server error\nMalformed routing or Null value for bundle [' + bundle + '] => ' + req.originalUrl, next);
            }

        } catch (err) {
            throwError(res, 500, err.stack, next)
        }


        out:
            for (var rule in routing) {
                if (typeof(routing[rule]['param']) == 'undefined')
                    break;

                if (routing[rule].bundle != bundle) continue;

                //Preparing params to relay to the router.
                params = {
                    method              : routing[rule].method || req.method,
                    requirements        : routing[rule].requirements,
                    namespace           : routing[rule].namespace || undefined,
                    url                 : unescape(pathname), /// avoid %20
                    rule                : routing[rule].originalRule || rule,
                    param               : routing[rule].param,
                    middleware          : routing[rule].middleware,
                    bundle              : routing[rule].bundle,
                    isXMLRequest        : isXMLRequest
                };
                //Parsing for the right url.
                try {
                    isRoute = router.compareUrls(req, params, routing[rule].url);
                } catch (err) {
                    throwError(res, 500, 'Rule [ '+rule+' ] needs your attention.\n'+err.stack);
                    break;
                }

                if (pathname === routing[rule].url || isRoute.past) {

                    //console.debug('Server is about to route to '+ pathname);

                    if (!routing[rule].method && req.method) { // setting client request method if no method is defined in routing
                        routing[rule].method  = req.method
                    } else if (!routing[rule].method) { // by default
                        routing[rule].method = 'GET'
                    }

                    var allowed = (typeof(routing[rule].method) == 'undefined' || routing[rule].method.length > 0 || routing[rule].method.indexOf(req.method) != -1)
                    if (!allowed) {
                        throwError(res, 405, 'Method Not Allowed for [' + params.bundle + '] => ' + req.originalUrl);
                        break;
                    } else {


                        // comparing routing method VS request.url method
                        if ( routing[rule].method.toLowerCase() != req.method.toLowerCase() ) {
                            throwError(res, 405, 'Method Not Allowed.\n'+ ' `'+req.originalUrl+'` is expecting `' + routing[rule].method.toUpperCase() +'` method but got `'+ req.method.toUpperCase() +'` instead');
                            break
                        }

                        // handling GET method exception - if no param found
                        var methods = ['get', 'delete'], method = req.method.toLowerCase();
                        if (
                            methods.indexOf(method) > -1 && typeof(req.query) != 'undefined' && req.query.count() == 0
                            || methods.indexOf(method) > -1 && typeof(req.query) == 'undefined' && typeof(req.params) != 'undefined' && req.params.count() > 1
                        ) {
                            var p = 0;
                            for (var parameter in req.params) {
                                if (p > 0) {
                                    req[method][parameter] = req.params[parameter]
                                }
                                ++p
                            }
                        } else if (method == 'put') {
                            var p = 0;
                            for (var parameter in req.params) {
                                if (p > 0) {
                                    req[method][parameter] = req.params[parameter]
                                }
                                ++p
                            }
                        }


                        // onRouting Event ???
                        if (isRoute.past) {
                            if ( cacheless ) {
                                config.refreshModels(params.bundle, self.env, function onModelRefreshed(err){
                                    if (err) {
                                        throwError(res, 500, err.msg||err.stack , next)
                                    } else {
                                        router.route(req, res, next, params)
                                    }
                                })
                            } else {
                                console.debug('[ 200 ] '+ pathname);
                                router.route(req, res, next, params)
                            }
                        }
                    }
                    matched = true;
                    isRoute = {};
                    break out;

                }
            }


        if (!matched) {

            //if ( typeof(self.isNotStatic) != 'undefined' && !res.headersSent) {
            //    delete self.isNotStatic;
            //    throwError(res, 404, 'Page not found: \n' + pathname, next)
            //}
            // find targeted bundle
            var allowed     = null
                , conf      = null
                , uri       = ''
                , score     = 0
                , tmpKey    = ''
                , key       = ''
                , filename  = ''
                , conf      = self.conf[bundle][self.env]
                , wroot     = conf.server.webroot;

            //webroot test
            if (wroot != '/') {
                uri = (pathname.replace(wroot, '')).split('/');
                for (var s in conf.content.statics) {
                    s = (s.substr(0,1) == '/') ? s.substr(1) : s;
                    if ( (new RegExp('^/'+s)).test( pathname ) ) {
                        score = s.length;
                        if ( score > 0 && score > tmpKey.length) {
                            tmpKey = s
                        }
                    }
                }

                if ( typeof(conf.content.statics) == 'undefined' || typeof(conf.content.statics[tmpKey]) != 'undefined' ) {
                    key = tmpKey
                } else {
                    key = pathname
                }

                // we add it into statics
                if ( withViews && typeof(conf.content.statics[key]) == 'undefined' && conf.content.views.default.views != conf.content.views.default.html) {
                    conf.content.statics[key] = conf.content.views.default.views +'/'+ uri.join('/')
                } else if (withViews && typeof(conf.content.statics[key]) == 'undefined') {
                    conf.content.statics[key] = conf.content.views.default.html +'/'+ uri.join('/') // normal case
                }



                uri = pathname.split('/');
                /** TODO - remove this
                uri = (pathname.replace(wroot, '')).split('/');
                var len = uri.length;

                uri.splice(0, 1);

                key = pathname.substr(1);
                // we add it into statics
                if ( withViews && typeof(conf.content.statics[key]) == 'undefined' && conf.content.views.default.views != conf.content.views.default.html) {
                    conf.content.statics[key] = conf.content.views.default.views +'/'+ uri.join('/')
                } else if (withViews && typeof(conf.content.statics[key]) == 'undefined') {
                    conf.content.statics[key] = conf.content.views.default.html +'/'+ uri.join('/') // normal case
                }
                */

            } else {

                for (var s in conf.content.statics) {
                    s = (s.substr(0,1) == '/') ? s.substr(1) : s;
                    if ( (new RegExp('^/'+s)).test( pathname ) ) {
                        score = s.length;
                        if ( score > 0 && score > tmpKey.length) {
                            tmpKey = s
                        }
                    }
                }
                uri = pathname.split('/');

                if ( typeof(conf.content.statics) == 'undefined' || typeof(conf.content.statics[tmpKey]) != 'undefined' ) {
                    key = tmpKey
                } else {
                    uri.splice(0, 1);
                    key = tmpKey + '/'+ uri.join('/')
                }
            }

            //static filter
            if ( typeof(conf.content.statics) != 'undefined'
                && typeof(conf.content.statics[key]) != 'undefined'
                && typeof(key) != 'undefined'
                && req.url === wroot + req.url.replace(wroot, '')
            ) {
                // No sessions for statics
                if (req.session) {
                    delete req['session']
                }

                uri = uri.join('/');
                //if ( !/\.(.*)$/.test(key) ) {
                if ( /\/$/.test(key) ) {
                    filename = _(path.join(conf.content.statics[key]), true)
                } else {

                    if ( /\//.test(key) ) {
                        filename = _(path.join(conf.content.statics[key], uri.replace((new RegExp('(/'+key+'|'+key +')')), '')), true)
                    } else {
                        // !!! this is adding a slash in the end .. not good !
                        filename = _(path.join(conf.content.statics[key], uri.replace(key, '')), true)
                        if (filename.substr(filename.length-1, 1) == '/' ) {
                            filename = filename.substr(0, filename.length-1)
                        }
                    }
                }

                fs.exists(filename, function(exists) {

                    if (exists) {

                        if (fs.statSync(filename).isDirectory()) filename += '/index.html';

                        if (cacheless) {
                            delete require.cache[filename]
                        }

                        fs.readFile(filename, "binary", function(err, file) {
                            if (err) {
                                throwError(res, 404, 'Page not found: \n' + filename, next);
                                return
                            }
                            if (!res.headersSent) {
                                try {
                                    res.setHeader("Content-Type", getHead(filename));
                                    // adding handler `gina.ready(...)` wrapper
                                    var conf = getContext('gina').config, hanlersPath = self.conf[conf.bundle][conf.env].content.statics.handlers;
                                    if ( new RegExp('^'+ hanlersPath).test(filename) ) {
                                        file = '(gina.ready(function onGinaReady($){\n'+ file + '\n},window["originalContext"]));'
                                    }

                                    if (cacheless) {
                                        // source maps integration for javascript & css
                                        if ( /(.js|.css)$/.test(filename) && fs.existsSync(filename +'.map') ) {
                                            res.setHeader("X-SourceMap", pathname +'.map')
                                        }

                                        // serve without cache
                                        res.writeHead(200, {
                                            'Cache-Control': 'no-cache, no-store, must-revalidate', // preventing browsers from caching it
                                            'Pragma': 'no-cache',
                                            'Expires': '0'
                                        });

                                    } else {
                                        res.writeHead(200)
                                    }

                                    res.write(file, 'binary');
                                    res.end()
                                } catch(err) {
                                    throwError(res, 500, err.stack)
                                }
                            }
                        });
                    } else {
                        // else
                        if (wroot.substr(wroot.length-1,1) == '/') {
                            wroot = wroot.substr(wroot.length-1,1).replace('/', '')
                        }
                        // web services case ... when you hit from a web browser
                        if (pathname === wroot + '/favicon.ico' && !withViews && !res.headersSent ) {
                            res.writeHead(200, {'Content-Type': 'image/x-icon'} );
                            res.end()
                        }

                        if (!res.headersSent)
                            throwError(res, 404, 'Page not found: \n' + pathname, next)

                    }//EO exists
                })//EO static filter

            } else if ( // might be rendering an existing static html page
                /\.html$/.test(key)
                && req.url === wroot + req.url.replace(wroot, '')
            ) {
                uri = uri.join('/');
                // publishing from views
                if ( /\//.test(key) ) {
                    filename = _(path.join(conf.content.statics['html'], uri.replace((new RegExp('(/'+key+'|'+key +')')), '')), true)
                } else {
                    filename = _(path.join(conf.content.statics['html'], uri.replace(key, '')), true)
                }

                fs.exists(filename, function(exists) {

                    if(exists) {

                        if (fs.statSync(filename).isDirectory()) filename += 'index.html';

                        if (cacheless) {
                            delete require.cache[filename]
                        }

                        fs.readFile(filename, "binary", function(err, file) {
                            if (err) {
                                throwError(res, 404, 'Page not found: \n' + filename, next);
                                return
                            }
                            if (!res.headersSent) {
                                try {
                                    res.setHeader("Content-Type", getHead(filename));
                                    if (cacheless) {
                                        // serve without cache
                                        res.writeHead(200, {
                                            'Cache-Control': 'no-cache, no-store, must-revalidate', // preventing browsers from caching it
                                            'Pragma': 'no-cache',
                                            'Expires': '0'
                                        });

                                    } else {
                                        res.writeHead(200)
                                    }

                                    res.write(file, 'binary');
                                    res.end()
                                } catch(err) {
                                    throwError(res, 500, err.stack)
                                }
                            }
                        });
                    } else {
                        // else
                        if (wroot.substr(wroot.length-1,1) == '/') {
                            wroot = wroot.substr(wroot.length-1,1).replace('/', '')
                        }
                        // web services case ... when you hit from a web browser
                        if (pathname === wroot + '/favicon.ico' && !withViews && !res.headersSent ) {
                            res.writeHead(200, {'Content-Type': 'image/x-icon'} );
                            res.end()
                        }

                        if (!res.headersSent)
                            throwError(res, 404, 'Page not found: \n' + pathname, next)

                    }//EO exists
                })//EO static filter

            } else {
                // else
                if (wroot.substr(wroot.length-1,1) == '/') {
                    wroot = wroot.substr(wroot.length-1,1).replace('/', '')
                }

                if (pathname === wroot + '/favicon.ico' && !withViews && !res.headersSent ) {
                    res.writeHead(200, {'Content-Type': 'image/x-icon'} );
                    res.end()
                }
                if (!res.headersSent)
                    throwError(res, 404, 'Page not found: \n' + pathname, next)
            }

        }
    }

    var throwError = function(res, code, msg, next) {
        var withViews       = local.hasViews[self.appName] || hasViews(self.appName);
        var isUsingTemplate = self.conf[self.appName][self.env].template;
        var isXMLRequest    = self.conf[self.appName][self.env].server.request.isXMLRequest;

        if (!res.headersSent) {
            if (isXMLRequest || !withViews || !isUsingTemplate ) {
                // allowing this.throwError(err)
                if ( typeof(code) == 'object' && !msg && typeof(code.status) != 'undefined' && typeof(code.error) != 'undefined' ) {
                    msg     = code.error;
                    code    = code.status;
                }

                // Internet Explorer override
                if ( /msie/i.test(local.request.headers['user-agent']) ) {
                    res.writeHead(code, "Content-Type", "text/plain")
                } else {
                    res.writeHead(code, { 'Content-Type': 'application/json'} )
                }

                console.error(res.req.method +' [ '+code+' ] '+ res.req.url);
                res.end(JSON.stringify({
                    status: code,
                    error: msg
                }));
                res.headersSent = true
            } else {
                res.writeHead(code, { 'Content-Type': 'text/html'} );
                console.error(res.req.method +' [ '+code+' ] '+ res.req.url);
                res.end('<h1>Error '+ code +'.</h1><pre>'+ msg + '</pre>');
                res.headersSent = true
            }
        } else {
            next()
        }
    }


    this.onConfigured = function(callback) {
        self.once('configured', function(err, instance, middleware, conf) {
            callback(err, instance, middleware, conf)
        });

        init(options);

        return {
            onStarted: self.onStarted
        }
    }

    this.onStarted = function(callback) {
        self.once('started', function(conf){
            callback(conf)
        });

        return {
            onConfigured: self.onConfigured
        }
    }

    return this
};

Server = inherits(Server, EventEmitter);
module.exports = Server