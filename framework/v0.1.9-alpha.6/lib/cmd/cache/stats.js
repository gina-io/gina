var http  = require('http');
var https = require('https');

var CmdHelper = require('./../helper');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/cache/stats
 */
/**
 * Prints a table of in-memory cache entries for a running bundle,
 * grouped by key prefix (static:, data:, swig:, http2session:).
 *
 * Fetches data from the bundle's internal `/_gina/cache/stats` endpoint,
 * which requires the bundle to be running.
 *
 * Usage:
 *  gina cache:stats <bundle> @<project>
 *  gina cache:stats @<project>          — stats for all bundles
 *
 * @class Stats
 * @constructor
 * @param {object} opt        - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {object} cmd        - The cmd dispatcher object (lib/cmd/index.js)
 */
function Stats(opt, cmd) {
    var self = {};

    var init = function(opt, cmd) {
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if (!isCmdConfigured()) return false;

        if (!self.name) {
            // No bundle specified — iterate all bundles for the project
            fetchAll(opt, cmd, 0);
        } else {
            fetchOne(self.name, opt, cmd, false);
        }
    }

    /**
     * Fetches stats for every bundle in the project sequentially.
     * @inner
     */
    var fetchAll = function(opt, cmd, index) {
        if (index >= self.bundles.length) {
            end(opt, cmd);
            return;
        }
        fetchOne(self.bundles[index], opt, cmd, true, function() {
            fetchAll(opt, cmd, index + 1);
        });
    }

    /**
     * Resolves the bundle's host/port and fetches `/_gina/cache/stats`.
     * @inner
     */
    var fetchOne = function(bundle, opt, cmd, isBulk, next) {
        var env      = self.projects[self.projectName].def_env;
        var portsRev = self.portsReverseData[bundle + '@' + self.projectName];

        if (!portsRev || !portsRev[env]) {
            opt.client.write(
                '  [ ' + bundle + '@' + self.projectName + ' ] ' +
                'no port assignment found — is the bundle registered?\n\r'
            );
            if (isBulk && next) return next();
            return end(opt, cmd, true);
        }

        // Collect all port/scheme combos for this bundle+env so we can try
        // each in turn — a bundle may only listen on a subset (e.g. http/2 only)
        var candidates = [];
        for (var protocol in portsRev[env]) {
            for (var s in portsRev[env][protocol]) {
                candidates.push({ port: portsRev[env][protocol][s], scheme: s });
            }
        }

        if (!candidates.length) {
            opt.client.write(
                '  [ ' + bundle + '@' + self.projectName + ' ] ' +
                'could not determine port\n\r'
            );
            if (isBulk && next) return next();
            return end(opt, cmd, true);
        }

        // Try each candidate in order; advance on ECONNREFUSED, stop on first success
        var tryNext = function(index) {
            if (index >= candidates.length) {
                opt.client.write(
                    '  [ ' + bundle + '@' + self.projectName + ' ] ' +
                    'connection refused on all assigned ports — bundle not running?\n\r'
                );
                if (isBulk && next) return next();
                return end(opt, cmd, true);
            }

            var candidate  = candidates[index];
            var port       = candidate.port;
            var scheme     = candidate.scheme;
            var transport  = (scheme === 'https') ? https : http;
            var reqOptions = {
                hostname           : '127.0.0.1',
                port               : port,
                path               : '/_gina/cache/stats',
                method             : 'GET',
                timeout            : 5000,
                rejectUnauthorized : false  // allow self-signed certs on internal endpoints
            };

            var req = transport.request(reqOptions, function(res) {
                var raw = '';
                res.on('data', function(chunk) { raw += chunk; });
                res.on('end', function() {
                    var stats;
                    try {
                        stats = JSON.parse(raw);
                    } catch(e) {
                        opt.client.write(
                            '  [ ' + bundle + '@' + self.projectName + ' ] ' +
                            'invalid response from /_gina/cache/stats\n\r'
                        );
                        if (isBulk && next) return next();
                        return end(opt, cmd, true);
                    }
                    opt.client.write(formatStats(bundle, stats));
                    if (isBulk && next) return next();
                    end(opt, cmd);
                });
            });

            req.on('timeout', function() {
                req.destroy();
                opt.client.write(
                    '  [ ' + bundle + '@' + self.projectName + ' ] ' +
                    'request timed out — is the bundle running?\n\r'
                );
                if (isBulk && next) return next();
                end(opt, cmd, true);
            });

            req.on('error', function(err) {
                if (err.code === 'ECONNREFUSED') {
                    // This port is not listening — try the next candidate
                    return tryNext(index + 1);
                }
                opt.client.write(
                    '  [ ' + bundle + '@' + self.projectName + ' ] ' +
                    err.message + '\n\r'
                );
                if (isBulk && next) return next();
                end(opt, cmd, true);
            });

            req.end();
        };

        tryNext(0);
    }

    /**
     * Formats a stats payload as a grouped table string.
     * @inner
     */
    var formatStats = function(bundle, stats) {
        var SEP  = '------------------------------------------------------------\n\r';
        var str  = '\n\r' + SEP;
        str += bundle + ' @ ' + self.projectName + '\n\r';
        str += SEP;
        str += 'Cache size: ' + stats.size + ' entries\n\r';

        var groups = {
            'static:'      : [],
            'data:'        : [],
            'swig:'        : [],
            'http2session:': [],
            'other:'       : []
        };

        for (var i = 0; i < stats.entries.length; i++) {
            var entry = stats.entries[i];
            var matched = false;
            for (var prefix in groups) {
                if (prefix !== 'other:' && entry.key.indexOf(prefix) === 0) {
                    groups[prefix].push(entry);
                    matched = true;
                    break;
                }
            }
            if (!matched) groups['other:'].push(entry);
        }

        var labels = {
            'static:'      : 'static',
            'data:'        : 'data',
            'swig:'        : 'swig',
            'http2session:': 'http2session',
            'other:'       : 'other'
        };

        for (var prefix in groups) {
            var list = groups[prefix];
            str += '\n\r  [ ' + labels[prefix] + ': ]\n\r';
            if (!list.length) {
                str += '    (none)\n\r';
                continue;
            }
            for (var j = 0; j < list.length; j++) {
                var e    = list[j];
                var key  = e.key.replace(new RegExp('^' + prefix.replace(':', '\\:')), '');
                var ttl  = e.ttlRemaining !== null ? e.ttlRemaining + ' s' : '—';
                var line = '    ' + pad(key, 40) + pad(e.type, 10) + pad(ttl, 12);
                if (e.sliding)          line += 'sliding';
                if (e.maxAgeRemaining !== null) {
                    line += (e.sliding ? '  ' : '') + 'max-age: ' + e.maxAgeRemaining + ' s';
                }
                str += line + '\n\r';
            }
        }

        str += '\n\r';
        return str;
    }

    /**
     * Right-pads `str` to `len` characters.
     * @inner
     */
    var pad = function(str, len) {
        str = String(str);
        while (str.length < len) str += ' ';
        return str;
    }

    var end = function(opt, cmd, error) {
        if (!opt.client.destroyed) opt.client.emit('end');
        process.exit(error ? 1 : 0);
    }

    init(opt, cmd);
}
module.exports = Stats;
