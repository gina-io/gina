var net     = require('net');
var console = lib.logger;
/**
 * Scan for available port between ranges
 *
 * @param {object} [opt]
 *
 * @callback cb
 *  @param {object|bool} err
 *  @param {array} ports
 * */
module.exports = function Scanner(opt, cb){

    var defaultOptions = {
        // default binding for localhost
        // remote scan can be added later if needed (e.g: for remote setup)
        host: '127.0.0.1',
        // --start-port-from
        startFrom: null,
        start: 3100,
        // max 65535, but user assigned == 49151 - see [RFC6335](https://www.rfc-editor.org/rfc/rfc6335.html)
        end: null,
        maxEnd: 49151,
        timeout: 2000,
        ignore: [],
        limit: 1
    };

    if ( arguments.length < 2 ) {
        console.warn('[SCAN] No options defined for your scan');
        cb  = opt;
        opt = defaultOptions;
    } else {
        opt = merge(opt, defaultOptions)
    }
    if (opt.startFrom) {
        opt.startFrom = ~~opt.startFrom;
        if (opt.start < opt.startFrom ) {
            opt.start = opt.startFrom;
        }
    }
    opt.end = (~~(opt.start)+899) // Shouldn't it be opt.limit+1 ?

    // Just in case
    opt.end = ~~(opt.end);
    opt.ignore.sort();

    console.debug('[SCAN] Init with options: ', opt);

    var self    = opt
        , port  = ~~self.start
        , ports = []
        , total = ~~opt.limit
    ;

    var find = function(port, cb) {

        // Not available port found
        if (port > self.end) {
            console.warn('[SCAN] Found '+ ports.length +'/'+ total);
            var err = new Error('[SCAN] Maximum port number reached: '+ self.end);
            cb(err);
            return;
        }

        // Skip port present in the `ignore list`
        if ( opt.ignore.length > 0 && opt.ignore.indexOf( ''+port ) > -1 ) {
            port++;
            return find(port, cb);
        }

        // Creating socket
        var s = new net.Socket();

        // Starting connection
        s.connect(port, self.host);

        // Just in case
        s.setTimeout(opt.timeout);
        s.on('timeout', function() {
            var err = new Error('[SCAN] '+ self.timeout +' timeout reached');
            s.destroy(err);
            cb(err)
        });


        // No one is listening ... port is available
        s.on('error', function(err) {
            s.destroy();
            // Silently catch all errors - assume the port is closed => available for use
            if ( /ECONNREFUSED/i.test(err.message) ) {
                if ( !opt.ignore.length || opt.ignore.length > 0 && opt.ignore.indexOf( port ) == -1 ) {
                    // ports.push(''+port);
                    ports.push(port);
                    ports.sort();
                    console.debug('[SCAN] Available port found '+ port +' ['+ ports.length +'/'+ total +']');
                    opt.limit--;
                }

                if (opt.limit <= 0) {
                    cb(false, ports);
                } else {
                    port++;
                    find(port, cb);
                }
                return;
            }

            if ( err instanceof AggregateError ) {
                var error = '', errors = err.errors;
                for (let i=0, len=errors.length; i<len; i++) {
                    if (/\:\:1/.test(errors[0]) ) {
                        error = '\n[SCAN] You shoud check your host definition: use local IP like `127.0.0.1` instead of `localhost`'
                        break;
                    }
                    error += '\n[SCAN] '+ errors[0].stack;
                }
                // console.warn('[SCAN] Errors:\n'+ error);

                cb( new Error(error) );

                error = null;
                return;
            }

            console.warn('[SCAN] Exeption not handled: '+ err);
            cb(err);

            return;
        });

        // If connection is made, this only means that service is using it
        s.on('connect', function() {
            s.destroy();

            port++;
            find(port, cb);
        })
    };

    find(port, cb)
}