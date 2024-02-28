/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

// nodejs dependencies
if ( typeof(module) !== 'undefined' && module.exports) {
    var fs              = require('fs');
    var os              = require('os');
    var dns             = require('dns');
    var execSync        = require('child_process').execSync;
    var util            = require('util');
    var promisify       = util.promisify;
    try {
        // With gina framework only
        var console         =  require('../../logger');
    } catch (err) {}
}
/**
 * Domain
 * Credits & thanks to the Mozilla Community :)
 * https://publicsuffix.org/
 *
 * This lib is using Fetch API (NodeJS >= 18.0.0)
 * See: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#browser_compatibility
 *
 * TODO - Write a cron to periodically check updates from `https://publicsuffix.org/`
 * TODO - Finalize AMD module support
 * TODO - Replace execSync of `curl` to a NodeJS based synchronous request
 *
 * @param {string} [options] - {
 *          // `.dat` configuration filename
 *          filename: "./dist/public_suffix_list.dat",
 *          // trigger PSL update pulling
 *          isUpdating: false
 *      }
 */
function Domain(options, cb) {

    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
    // Detect if user is on IE browser
    var isIE            = false;
    if (isGFFCtx) {
        isIE = !!window.MSInputMethodContext && !!document.documentMode;
    }

    if ( typeof(arguments[0]) == 'function' ) {
        cb = arguments[0];
        options = undefined;
    }

    var defaultOptions  = {
        // if isGFFCtx, should be place in the public folder to be served by your own host
        // e.g.: "./public_suffix_list.dat" located under "/my-www-folder/"
        filename            : "../dist/public_suffix_list.dat",
        url                 : "https://publicsuffix.org/list/public_suffix_list.dat",
        alternativeUrl      : "https://raw.githubusercontent.com/publicsuffix/list/master/public_suffix_list.dat",
        // only available from backend calls
        isCachingRequired  : false,
        isUpdating          : false
    }

    var self = {
        options : null,
        rawPSL  : null,
        PSL     : [],
    };


    var init = function(proto, options, cb) {
        if ( typeof(options) == 'undefined' ) {
            options = defaultOptions
        } else {
            // merge options
            for(let opt in defaultOptions) {
                if ( typeof(options[opt]) == 'undefined' ) {
                    options[opt] = defaultOptions[opt];
                }
            }
        }

        if (!isGFFCtx) {
            options.filename = __dirname +'/'+ options.filename;
        }

        if (isGFFCtx && options.isCachingRequired ) {
            console.warn('[DOMAIN] `options.isCachingRequired` is only available for backend');
            options.isCachingRequired = false
        }

        self.options = options;

        if (cb) {
            return loadPSL(options, function onPSLLoaded(err) {
                if (err) {
                    cb(err);
                    return
                }

                console.debug('[DOMAIN] PSL Loaded');
                // return proto

                cb(err, proto)
            });
        }

        // Assuming that you have previously initialized Domain
        loadPSL(options);
        console.debug('[DOMAIN] PSL Loaded');
        return proto
    }

    // TODO - for frontend calls only
    var onReady = function() {

    }

    var loadPSL = async function(opt, cb) {
        var filenameOrUrl   = (isGFFCtx || opt.isCachingRequired) ? opt.url : opt.filename;
        var isUpdating      = ( typeof(opt.isUpdating) != 'undefined' ) ? opt.isUpdating : false;
        var err             = null;

        if (isGFFCtx) {

            if (self.rawPSL && !isUpdating) {
                cb(false);
                return;
            }

            if (!window.fetch) {// just in case
                err = new Error('[DOMAIN] Fetch API not supported');
                cb(err);
                return;
            }

            var response = null
                , result = null
            ;
            try {
                response    = await fetch(filenameOrUrl);
                result      = await response.text();

                self.rawPSL = result;
            } catch (PSLErr) {
                // There was an error
                // console.warn('[DOMAIN] Could not load PSL', err.stack || err.message || err);
                err = new Error('[DOMAIN] Could not load PSL\n'+ (PSLErr.stack || PSLErr.message || PSLErr) );
                cb(err);
                return;
            }

            opt.isUpdating = false;
            cb(false);

            return;
        }

        // file exists ?
        var exists = false;
        if ( typeof(fs.accessSync) != 'undefined' ) {
            try {
                fs.accessSync(opt.filename, fs.constants.F_OK);
                exists = true;
            } catch (err) {
                exists = false;
                // to handle symlinks
                try {
                    if ( fs.lstatSync(opt.filename).isSymbolicLink() ) {
                        exists = true
                    }
                } catch (linkErr) {}
            }
        } else { // support for old version of nodejs
            exists = fs.existsSync(opt.filename);
        }

        if (!exists) {
            opt.isCachingRequired = true;
        }

        if (opt.isCachingRequired) { // Fetch is only supported from NodeJS >= 18.0.0
            var cmd = 'curl -o '+opt.filename +' '+ opt.url +' >/dev/null 2>&1';
            console.debug('[DOMAIN] Running: '+ cmd);
            try {
                execSync(cmd);
            } catch (err) {
                console.warn('[DOMAIN] could not fetch from `'+ opt.url +'`. Trying with `'+ opt.alternativeUrl +'`');
                cmd = 'curl -o '+opt.filename +' '+ opt.alternativeUrl +' >/dev/null 2>&1';
                try {
                    execSync(cmd);
                } catch (altErr) {
                    cb(altErr);
                    return;
                }
            }
            // Waiting for the file to be written
            var found = false;
            nIntervId = setInterval(() => {
                // Check for modules availability
                if ( typeof(fs.accessSync) != 'undefined' ) {
                    try {
                        fs.accessSync(opt.filename, fs.constants.F_OK);
                        found = true;
                    } catch (err) {
                        found = false;
                        // to handle symlinks
                        try {
                            if ( fs.lstatSync(opt.filename).isSymbolicLink() ) {
                                found = true
                            }
                        } catch (linkErr) {}
                    }
                } else { // support for old version of nodejs
                    found = fs.existsSync(opt.filename);
                }

                if ( found ) {
                    clearInterval(nIntervId);
                    self.rawPSL = fs.readFileSync(opt.filename).toString();
                    cb(false);

                    return
                }
            }, 200);


            // TODO - Synchronize this instead of using CURL
            // var http = require('http');

            // var port = 80;
            // var urlArr = opt.url.match(/^(http|https)\:\/\/(.*)\//)[0].split(/\//g);
            // if ( /\:\d+$/.test(urlArr[1]) ) {
            //     port = ~~(urlArr[1].match(/\:\d+$/)[0].replace(/^\:/, ''));
            //     urlArr[1] = urlArr[1].replace(/\:\d+$/, '');
            // }
            // var hostname = urlArr[0] +'//'+ urlArr[1];
            // var path = '/'+ opt.url.split(/\//g).splice(3).join("/");

            // var data = '';

            // var requestOpt = {
            //     hostname: hostname,
            //     port: port,
            //     path: path,
            //     method: 'GET'
            // };

            // var req = await http.request(options, (res) => {
            //     res.setEncoding('utf8');
            //     res.on('data', (chunk) => {
            //         console.log(`BODY: ${chunk}`);
            //         data += chunk;
            //     });
            //     res.on('end', () => {
            //         console.log('No more data in response.');
            //     });
            // });

            // req.on('error', (e) => {
            //     console.error(`problem with request: ${e.message}`);
            // });

            // req.end();

            // self.rawPSL = data.toString();



        }

        // Just in case some one delete it once `Domain` has been inatialized
        try {
            self.rawPSL = fs.readFileSync(opt.filename).toString();
            if (cb)
                cb(false)
        } catch (err) {
            console.warn('[DOMAIN] could not read from `'+ opt.filename +'`');
            loadPSL(options, cb)
        }
    }

    var updatePSL = function(cb) {
        self.options.isUpdating = true;
        loadPSL(self.options, cb);
    }

    /**
     * Usage : await domainInstance.getFQDN()
     * @param {string} hostname (one that can be resolved)
     *
     * @return {string} fqdn
     */
    var getFQDN = async function(hostname) {
        var host = (
            typeof(hostname) != 'undefined'
            && hostname != ''
        ) ? hostname : os.hostname();
        if ( /\./.test(host) ) {
            return host
        }

        console.debug('[DOMAIN][getFQDN] UQDN: ' + host);
        var ipObj       = null
            , err       = null
        ;
        ipObj = await promisify(dns.lookup)(host, { hints: dns.ADDRCONFIG || dns.V4MAPPED })
                    .then( function onIP(result) {
                        console.debug('[DOMAIN][getFQDN] IP: ' + result.address);
                        console.debug('[DOMAIN][getFQDN] FAMILY: ' + result.family);

                        return result;
                    })
                    .catch( function onIPErr(_err) {
                        err = _err;
                    });
        if (err) {
            throw err;
        }
        host = await promisify(dns.lookupService)(ipObj.address, 0)
                    .then( function onLookupService(result) {
                        console.debug('[DOMAIN][getFQDN] FQDN: ' + result.hostname);
                        console.debug('[DOMAIN][getFQDN] Service: ' + result.service);

                        return result.hostname;
                    })
                    .catch( function onLookupServiceErr(err) {
                        err = _err;
                    });
        if (err) {
            throw err;
        }

        if ( !/\./.test(host) ) {
            throw new Error('[DOMAIN][getFQDN] `'+ host +'` is not a FQDN !');
        }

        return host;
    }


    /**
     * Load a json file and removing comments if found
     *
     * @return {string} filename - path
     * @return {boolean} [jsonFormat] - false by default
     * */
    var getRootDomain = function(urlOrHostname, jsonFormat) {
        if ( typeof(jsonFormat) == 'undefined' ) {
            jsonFormat = false
        }
        var isSLD = false
            , isRegisteredTldOrSld = false
            , rootDomain = urlOrHostname.replace(/^(.*)\:\/\/|\/(.*)/g, '')
            // we don't want sub domains: that's why the `.reverse()` is for
            , rootDomainArr = rootDomain.split(/\./g).reverse()
            // TLD by default
            , rootDomainIndex = (rootDomainArr.length) ? rootDomainArr.length-1 : 0
        ;

        var list = self.rawPSL
                // remove comments & empty lines
                .replace(/\/\/\s*(.*)\n|^\s*\n/gm, '')
                .split(/\n/)
                .filter( function onFiltered(item, i, iArr) {
                    // formating ^!, ^. & removing extra junk
                    // this is specific to the ginven extensions list
                    if ( /[^a-z 0-9.]+/.test(item) ) {
                        item = item.replace(/[^a-z 0-9.]+/g, '').replace(/^\./g, '');
                    }

                    // retain only SLD
                    if ( /\./.test(item) ) {
                        if ( !isSLD && new RegExp('.'+item +'$').test(rootDomain) ) {
                            // Found SLD
                            isSLD = true;
                            // console.debug('Found '+ item);
                            rootDomainIndex = item.split(/\./g).length;
                            // Stop here
                            iArr.splice(0, iArr.length);
                            return false;
                        }

                        return item
                    }
                    // also get tld to check later if valid/registered
                    return item
                });

        // Local or unregistered domain
        rootDomain = rootDomainArr[rootDomainIndex];

        // TLD & SLD
        if (rootDomainIndex > 0 ) {
            // rootDomainArr  = rootDomainArr.splice(0, rootDomainIndex);
            // rootDomain += '.'+ rootDomainArr.reverse().join('.');

            rootDomainArr  = rootDomainArr.splice(0, rootDomainIndex);
            var suffix = rootDomainArr[0];
            // Remove port number
            if ( /\:(.*)$/.test(suffix) ) {
                suffix = suffix.replace(/\:(.*)$/, '');
            }
            isRegisteredTldOrSld = ( isSLD || !isSLD && list.indexOf(suffix) > -1 ) ? true : false;
            if (isRegisteredTldOrSld /**&& isSLD || !isSLD && list.indexOf(suffix) < 0*/ ) {
                if (rootDomainIndex > 1 && !isSLD) {
                    // This is a TLD
                    rootDomainArr.splice(2);
                    rootDomain = rootDomainArr.reverse().join('.');
                } else {
                    rootDomain += '.'+ rootDomainArr.reverse().join('.');
                }

            } else {
                if (rootDomainIndex > 1) {
                    // Only allowing pseudo TLD here
                    rootDomainArr.splice(2);
                    rootDomain = rootDomainArr.reverse().join('.');
                } else {
                    rootDomain += '.'+ rootDomainArr.reverse().join('.');
                }
            }
        }

        // Remove port number
        if ( /\:(.*)$/.test(rootDomain) ) {
            rootDomain = rootDomain.replace(/\:(.*)$/, '');
        }

        console.debug('[DOMAIN] isSLD: '+ isSLD, urlOrHostname, ' -> ', rootDomain);
        if ( /^true$/i.test(jsonFormat) ) {
            return {
                value               : rootDomain,
                isSLD               : isSLD,
                isRegisteredTldOrSld: isRegisteredTldOrSld
            }
        }
        return {
            value               : rootDomain,
            isSLD               : isSLD,
            isRegisteredTldOrSld: isRegisteredTldOrSld
        }
    }

    // Both backend & frontend
    var _proto = {
        getRootDomain   : getRootDomain
    };
    // Backend proto only
    if (!isGFFCtx) {
        _proto.updatePSL    = updatePSL;
        _proto.getFQDN      = getFQDN;
    }
    // Frontend only
    else {
        _proto.onReady = onReady;
    }


    if (isGFFCtx && isIE && !window.fetch) {
        // Create Promise polyfill script tag
        var promiseScript = document.createElement("script");
        promiseScript.type = "text/javascript";
        promiseScript.src =
            "https://cdn.jsdelivr.net/npm/promise-polyfill@8.1.3/dist/polyfill.min.js";

        // Create Fetch polyfill script tag
        var fetchScript = document.createElement("script");
        fetchScript.type = "text/javascript";
        fetchScript.src =
            "https://cdn.jsdelivr.net/npm/whatwg-fetch@3.4.0/dist/fetch.umd.min.js";

        // Add polyfills to head element
        document.head.appendChild(promiseScript);
        document.head.appendChild(fetchScript);

        // Wait for the polyfills to load and run the function.
        // TODO - add a setinterval to trigger `onFetchReady`event
        return setTimeout(() => {
            return init(_proto, options, cb)
        }, 500);
    } else {
        return init(_proto, options, cb)
    }



}//EO Domain.

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = Domain
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return Domain })
}
