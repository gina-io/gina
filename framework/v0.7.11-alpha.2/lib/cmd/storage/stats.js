var fs       = require('fs');
var http     = require('http');
var https    = require('https');
var nodePath = require('path');

var CmdHelper  = require('./../helper');
var storageLib = require('../../index').storage;
var console    = lib.logger;

/**
 * @module gina/lib/cmd/storage/stats
 */
/**
 * Prints per-driver storage statistics for a bundle — driver identity
 * (strategy, root, capabilities) plus the metadata store's aggregate counts
 * (`{objects, refcounted, zeroRefPending, inline, bytes}`).
 *
 * Who answers depends on who OWNS the store (#STO1 — the embedded store is
 * single-process-per-root by contract):
 *   - bundle RUNNING (a port candidate answered) — fetched from the bundle's
 *     admin-gated `GET /_gina/storage/stats` endpoint, so the OWNING process
 *     does the reads;
 *   - bundle DOWN (every assigned port ECONNREFUSED) — the bundle's raw
 *     `config/settings.json` `storage` block is resolved offline and the REAL
 *     driver is built directly (`sweepInterval: 0` — no GC timer in a CLI
 *     process), through the exact resolver and factories a boot uses;
 *   - anything else (timeout, socket error) — the bundle may still be alive,
 *     so the store is NOT opened; the state is reported as unknown.
 *
 * Connector-backed stores have no offline path (nothing local to open) and
 * are named-and-skipped when the bundle is down.
 *
 * Usage:
 *  gina storage:stats <bundle> @<project>
 *  gina storage:stats @<project>            — stats for all bundles
 *  gina storage:stats <bundle> @<project> --driver=<name>
 *  gina storage:stats <bundle> @<project> --format=json
 *
 * @class Stats
 * @constructor
 * @param {object}   opt        - Parsed command-line options
 * @param {object}   opt.client - Socket client for terminal output
 * @param {string[]} opt.argv   - Full argv array
 * @param {object}   cmd        - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // per-driver stats for one bundle
 *  $ gina storage:stats api @myproject
 *
 * @example
 *  // machine-readable, one driver only
 *  $ gina storage:stats api @myproject --driver=documents --format=json
 */
function Stats(opt, cmd) {
    var self = { format: null, driver: null, results: [] };

    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // Full pre-scan of argv for --format and --driver. `storage/arguments.json`
        // whitelists both so CmdHelper does not treat them as positional (bundle)
        // args (mirrors cache:clear).
        for (let i = 3, len = process.argv.length; i < len; i++) {
            if ( /^\-\-format\=/.test(process.argv[i]) ) {
                self.format = process.argv[i].split(/\=/)[1];
            } else if ( /^\-\-driver\=/.test(process.argv[i]) ) {
                self.driver = process.argv[i].split(/\=/)[1];
            }
        }

        if (!self.name) {
            // No bundle specified — stats for every bundle in the project.
            runAll(opt, cmd, 0);
        } else {
            runOne(self.name, opt, cmd, false);
        }
    }

    /**
     * Runs every bundle in the project sequentially, then reports.
     * @inner
     */
    var runAll = function(opt, cmd, index) {
        if (index >= self.bundles.length) {
            report(opt, cmd);
            return;
        }
        runOne(self.bundles[index], opt, cmd, true, function() {
            runAll(opt, cmd, index + 1);
        });
    }

    /**
     * Resolves one bundle (running → endpoint, down → offline), records the
     * result, then advances / reports.
     * @inner
     */
    var runOne = function(bundle, opt, cmd, isBulk, next) {
        var advance = function(result) {
            self.results.push(result);
            if (isBulk && next) return next();
            report(opt, cmd);
        };
        probeAndFetch(bundle, function(outcome) {
            if ( outcome.mode === 'down' ) {
                return statsOffline(bundle, advance);
            }
            advance(outcome);
        });
    }

    /**
     * Sends `GET /_gina/storage/stats` to each assigned port in turn — the
     * request IS the probe (the cache:clear probeOrClear shape): a response
     * classifies the bundle RUNNING and carries the data; ECONNREFUSED
     * advances to the next candidate; every candidate refused classifies it
     * DOWN (the caller falls back to offline). A timeout or another socket
     * error is UNKNOWN — the bundle may be alive and owning its store, so
     * the offline path is NOT taken.
     *
     * @inner
     * @param {string} bundle
     * @param {function(object)} done - Result object, or `{mode:'down'}`.
     */
    var probeAndFetch = function(bundle, done) {
        var env      = self.projects[self.projectName].def_env;
        var portsRev = self.portsReverseData[bundle + '@' + self.projectName];

        if (!portsRev || !portsRev[env]) {
            return done({ bundle: bundle, mode: 'error', error: 'no port assignment found — is the bundle registered?' });
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
            return done({ bundle: bundle, mode: 'error', error: 'could not determine port' });
        }

        var endpointPath = '/_gina/storage/stats'
            + ( self.driver ? '?driver=' + encodeURIComponent(self.driver) : '' );

        // Try each candidate in order; advance on ECONNREFUSED, stop on first response.
        var tryNext = function(index) {
            if (index >= candidates.length) {
                return done({ mode: 'down' }); // refused on every assigned port — the offline path owns it
            }

            var candidate  = candidates[index];
            var transport  = (candidate.scheme === 'https') ? https : http;
            var reqOptions = {
                hostname           : '127.0.0.1',
                port               : candidate.port,
                path               : endpointPath,
                method             : 'GET',
                timeout            : 5000,
                rejectUnauthorized : false  // allow self-signed certs on internal endpoints
            };

            var req = transport.request(reqOptions, function(res) {
                var raw = '';
                res.on('data', function(chunk) { raw += chunk; });
                res.on('end', function() {
                    var parsed = null;
                    try {
                        parsed = JSON.parse(raw);
                    } catch (e) {
                        return done({ bundle: bundle, mode: 'error', error: 'invalid response from /_gina/storage/stats' });
                    }
                    if ( parsed && parsed.error ) {
                        // 403/404 bodies are {error, message} — reachable, so never offline
                        return done({ bundle: bundle, mode: 'running', error: ( parsed.error === 'forbidden' )
                            ? 'reachable but admin-gated (app.json admin.allowFrom?)'
                            : (parsed.message || parsed.error) });
                    }
                    done({ bundle: bundle, mode: 'running', configured: !!parsed.configured, drivers: parsed.drivers || [] });
                });
            });

            req.on('timeout', function() {
                req.destroy();
                done({ bundle: bundle, mode: 'error', error: 'request timed out — bundle state unknown; not opening its store offline (a live process may own it)' });
            });

            req.on('error', function(err) {
                if (err.code === 'ECONNREFUSED') {
                    return tryNext(index + 1); // this port is not listening — try the next
                }
                done({ bundle: bundle, mode: 'error', error: err.message + ' — bundle state unknown; not opening its store offline' });
            });

            req.end();
        };

        tryNext(0);
    }

    /**
     * The DOWN path: read the bundle's raw settings.json `storage` block
     * (requireJSON — scaffolded configs carry comments), validate it, then
     * build each local driver through the boot's own resolver/factories and
     * collect its `stats()`. Connector-backed stores are named-and-skipped
     * (nothing local to open); a root that does not exist yet is reported,
     * never created (a stats read must not mkdir).
     *
     * @inner
     * @param {string} bundle
     * @param {function(object)} done
     */
    var statsOffline = function(bundle, done) {
        var byProject = self.bundlesByProject[self.projectName] || {};
        var bundleMeta = byProject[bundle];
        var settingsPath = ( bundleMeta && bundleMeta.configPaths ) ? bundleMeta.configPaths.settings : null;
        if ( !settingsPath || !fs.existsSync(settingsPath) ) {
            return done({ bundle: bundle, mode: 'offline', error: 'no config/settings.json found for this bundle' });
        }
        var settings = null;
        try {
            settings = requireJSON(settingsPath);
        } catch (e) {
            return done({ bundle: bundle, mode: 'offline', error: 'could not parse settings.json: ' + (e.message || e) });
        }
        var block = settings ? settings.storage : null;
        if ( !block || !block.drivers || !Object.keys(block.drivers).length ) {
            return done({ bundle: bundle, mode: 'offline', configured: false, drivers: [] });
        }
        var lint = storageLib.validateConfig(block);
        if ( lint.fatal ) {
            return done({ bundle: bundle, mode: 'offline', error: 'invalid storage config: ' + lint.fatal });
        }

        var names = Object.keys(block.drivers);
        if ( self.driver ) {
            if ( names.indexOf(self.driver) < 0 ) {
                return done({ bundle: bundle, mode: 'offline', error: 'no driver `' + self.driver + '` (configured: ' + names.join(', ') + ')' });
            }
            names = [ self.driver ];
        }

        var out = { bundle: bundle, mode: 'offline', configured: true, drivers: [] };
        var nextDriver = function(i) {
            if ( i >= names.length ) { return done(out); }
            var name = names[i];
            var d    = block.drivers[name];
            // s3 first — a remote adapter has neither a root nor a local
            // store, and its SDK is resolvable only in a bundle's project
            // scope; the RUNNING path serves its stats.
            if ( d.adapter === 's3' ) {
                out.drivers.push({ name: name, adapter: 's3', strategy: d.strategy || 'sharded', skipped: true, reason: 'remote adapter (`s3`) — nothing local to open; start the bundle and re-run' });
                return nextDriver(i + 1);
            }
            if ( d.store ) {
                out.drivers.push({ name: name, strategy: d.strategy, skipped: true, reason: 'connector-backed store (`' + d.store + '`) — nothing local to open; start the bundle and re-run' });
                return nextDriver(i + 1);
            }
            if ( !fs.existsSync(d.root) ) {
                out.drivers.push({ name: name, strategy: d.strategy, root: d.root, missingRoot: true, store: null });
                return nextDriver(i + 1);
            }
            var driver = null;
            try {
                var resolved = storageLib._resolveDriverConf(d);
                resolved.sweepInterval = 0; // no GC timer in a CLI process
                var metaStore = storageLib._createEmbeddedMetaStore(nodePath.join(d.root, '.meta.db'));
                driver = storageLib._FACTORIES[d.strategy](name, resolved, metaStore);
            } catch (buildErr) {
                out.drivers.push({ name: name, strategy: d.strategy, error: buildErr.message || String(buildErr) });
                return nextDriver(i + 1);
            }
            driver.stats(function(err, view) {
                try { driver.close(); } catch (e) { /* already closed */ }
                out.drivers.push(err ? { name: name, strategy: d.strategy, error: err.message || String(err) } : view);
                nextDriver(i + 1);
            });
        };
        nextDriver(0);
    }

    /**
     * Builds the `--format=json` envelope from the per-bundle results. Pure.
     * Single-bundle → the fields are flattened onto the top object; all-bundles
     * → a `bundles` array of the same per-bundle objects.
     *
     * @inner
     * @param {string}        project      - Project name.
     * @param {Array<object>} results      - Per-bundle result objects.
     * @param {string|null}   singleBundle - The bundle name for a single-bundle run, else null.
     * @param {string|null}   driver       - The --driver filter, when given.
     * @returns {object}
     */
    var buildEnvelope = function(project, results, singleBundle, driver) {
        var base = { project: project };
        if (driver) {
            base.driver = driver;
        }
        if (singleBundle && results.length === 1) {
            var r = results[0];
            for (var k in r) { base[k] = r[k]; }
            return base;
        }
        base.bundles = results;
        return base;
    }

    /**
     * Formats the per-bundle results as a human-readable summary. Pure.
     *
     * @inner
     * @param {Array<object>} results
     * @param {string}        project
     * @returns {string}
     */
    var formatText = function(results, project) {
        var SEP = '------------------------------------------------------------\n\r';
        var str = '\n\r' + SEP;
        str += 'storage:stats @' + project + ( self.driver ? '  --driver=' + self.driver : '' ) + '\n\r';
        str += SEP;

        if (!results.length) {
            str += '  (no bundles)\n\r\n\r';
            return str;
        }

        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            str += '\n\r  [ ' + r.bundle + '@' + project + ' ]' + ( r.mode ? '  (' + r.mode + ')' : '' ) + '\n\r';
            if (r.error) {
                str += '    ' + r.error + '\n\r';
                continue;
            }
            if ( r.configured === false ) {
                str += '    storage not configured (no `storage` block)\n\r';
                continue;
            }
            for (var j = 0; j < r.drivers.length; j++) {
                var d = r.drivers[j];
                if (d.error) {
                    str += '    driver `' + d.name + '`: ' + d.error + '\n\r';
                    continue;
                }
                if (d.skipped) {
                    str += '    driver `' + d.name + '`: skipped — ' + d.reason + '\n\r';
                    continue;
                }
                str += '    driver `' + d.name + '` (' + d.strategy + ')  ' + (d.root || '') + '\n\r';
                if (d.missingRoot) {
                    str += '      root not created yet (nothing stored)\n\r';
                } else if ( !d.store ) {
                    str += '      store reports no stats\n\r';
                } else {
                    str += '      objects: ' + d.store.objects
                        + '   refcounted: ' + d.store.refcounted
                        + '   zero-ref pending: ' + d.store.zeroRefPending
                        + '   inline: ' + d.store.inline
                        + '   bytes: ' + d.store.bytes + '\n\r';
                }
            }
        }

        str += '\n\r';
        return str;
    }

    /**
     * Emits the result — the JSON envelope (`--format=json`) synchronously to
     * stdout (pipe-safe against the `process.exit` in `end()`), else a text
     * summary via `opt.client` — then terminates. Exit code 1 when any
     * per-bundle result carries an error.
     * @inner
     */
    var report = function(opt, cmd) {
        var single   = (self.results.length === 1 && !!self.name) ? self.name : null;
        var hasError = self.results.some(function(r) { return !!r.error; });

        if ( /^json/i.test(String(self.format || '')) ) {
            var envelope = buildEnvelope(self.projectName, self.results, single, self.driver);
            // fs.writeSync (not process.stdout.write): process.stdout is async on a
            // pipe, and end() calls process.exit right after — a plain write would
            // truncate a large envelope under `| jq` / `$(…)` (llms.txt #180).
            fs.writeSync(1, JSON.stringify(envelope) + '\n');
            return end(opt, cmd, hasError);
        }

        opt.client.write(formatText(self.results, self.projectName));
        end(opt, cmd, hasError);
    }

    var end = function(opt, cmd, error) {
        if (!opt.client.destroyed) opt.client.emit('end');
        process.exit(error ? 1 : 0);
    }

    init(opt, cmd);
}
module.exports = Stats;
