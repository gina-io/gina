var net     = require('net');
var console = lib.logger;
/**
 * @module gina/lib/cmd/port/inc/scan
 */
/**
 * @callback ScanCallback
 * @param {Error|false} err - Error if scan failed; false on success
 * @param {number[]} [ports] - Sorted array of available port numbers
 */
/**
 * Scans for available TCP ports in a configurable range by attempting socket
 * connections and collecting ports that return ECONNREFUSED (not in use).
 * Wraps `net.Socket` — do not call the underlying module directly.
 *
 * @function Scanner
 * @param {object} [opt] - Scan options
 * @param {string} [opt.host='127.0.0.1'] - Host to scan against
 * @param {number} [opt.start=3100] - First port number to test
 * @param {number} [opt.startFrom] - Override for opt.start (parsed from --start-port-from)
 * @param {number} [opt.maxEnd=49151] - Hard upper bound (RFC 6335 user-assigned range)
 * @param {number} [opt.timeout=2000] - Socket connection timeout in milliseconds
 * @param {string[]} [opt.ignore=[]] - Port numbers to skip (as strings)
 * @param {number} [opt.limit=1] - Number of available ports to find
 * @param {ScanCallback} cb - Called with found ports or an error
 */
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
    opt.end = Math.min(~~(opt.start) + Math.max(899, ~~opt.limit + 99), opt.maxEnd)

    // Just in case
    opt.end = ~~(opt.end);
    opt.ignore.sort();

    console.debug('[SCAN] Init with options: ', opt);

    var self    = opt
        , port  = ~~self.start
        , ports = []
        , total = ~~opt.limit
    ;

    /**
     * Recursively tests one port at a time until `limit` available ports are found
     * or the scan range is exhausted.
     *
     * @inner
     * @private
     * @param {number} port - Port number to test next
     * @param {ScanCallback} cb - Completion callback
     */
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

        // Skip Gina infrastructure reserved range 4100–4199 (RFC 6335 / Gina port policy)
        // 4100 = socket server, 4101 = Inspector, 4102 = engine.io, 4103–4199 = reserved
        if ( port >= 4100 && port <= 4199 ) {
            port = 4200;
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