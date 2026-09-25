var fs       = require('fs');
var http     = require('http');
var https    = require('https');
var nodePath = require('path');

var CmdHelper  = require('./../helper');
var storageLib = require('../../index').storage;
var console    = lib.logger;

/**
 * @module gina/lib/cmd/storage/gc
 */
/**
 * Runs the cas GC sweep NOW for a bundle's storage drivers: blobs whose
 * reference count has sat at zero for longer than `sweepGrace` are collected
 * (row claimed first, file unlinked second — the loss-proof order the driver
 * owns). `sharded` drivers have no sweep and are named-and-skipped, never an
 * error. `--dry-run` lists what a pass would collect and touches NOTHING.
 *
 * Who does the work depends on who OWNS the store (#STO1):
 *   - bundle RUNNING — `POST /_gina/storage/gc` and the OWNING process
 *     sweeps (the endpoint drains: it loops the batch-capped pass until the
 *     driver reports `drained`);
 *   - bundle DOWN (every assigned port ECONNREFUSED) — the REAL driver is
 *     built offline (`sweepInterval: 0`) and `sweepNow()` is looped here
 *     until `drained`;
 *   - anything else (timeout, socket error) — reported as unknown, the
 *     store is NOT opened.
 *
 * Usage:
 *  gina storage:gc <bundle> @<project>
 *  gina storage:gc @<project>                — every bundle in the project
 *  gina storage:gc <bundle> @<project> --dry-run
 *  gina storage:gc <bundle> @<project> --driver=<name> --format=json
 *
 * @class Gc
 * @constructor
 * @param {object}   opt        - Parsed command-line options
 * @param {object}   opt.client - Socket client for terminal output
 * @param {string[]} opt.argv   - Full argv array
 * @param {object}   cmd        - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // collect everything past the grace window, now
 *  $ gina storage:gc api @myproject
 *
 * @example
 *  // preview — nothing is claimed, nothing is unlinked
 *  $ gina storage:gc api @myproject --dry-run
 */
function Gc(opt, cmd) {
    var self = { format: null, driver: null, dryRun: false, results: [] };

    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // Full pre-scan of argv for --format, --driver and --dry-run —
        // whitelisted in `storage/arguments.json` (mirrors cache:clear).
        for (let i = 3, len = process.argv.length; i < len; i++) {
            if ( /^\-\-format\=/.test(process.argv[i]) ) {
                self.format = process.argv[i].split(/\=/)[1];
            } else if ( /^\-\-driver\=/.test(process.argv[i]) ) {
                self.driver = process.argv[i].split(/\=/)[1];
            } else if ( /^\-\-dry-run$/.test(process.argv[i]) ) {
                self.dryRun = true;
            }
        }

        if (!self.name) {
            // No bundle specified — sweep every bundle in the project.
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
        probeAndSweep(bundle, function(outcome) {
            if ( outcome.mode === 'down' ) {
                return gcOffline(bundle, advance);
            }
            advance(outcome);
        });
    }

    /**
     * Sends `POST /_gina/storage/gc` (the request IS the probe — a POST is
     * safe as a probe here because executing the sweep is exactly what the
     * caller asked for): a response classifies the bundle RUNNING and carries
     * the result; ECONNREFUSED advances; every candidate refused classifies
     * it DOWN. The response timeout is 120s, not the 5s probe class: the
     * server drains the whole backlog before answering, and a big store
     * legitimately takes a while (the work is chunked server-side, the
     * response is not).
     *
     * @inner
     * @param {string} bundle
     * @param {function(object)} done - Result object, or `{mode:'down'}`.
     */
    var probeAndSweep = function(bundle, done) {
        var env      = self.projects[self.projectName].def_env;
        var portsRev = self.portsReverseData[bundle + '@' + self.projectName];

        if (!portsRev || !portsRev[env]) {
            return done({ bundle: bundle, mode: 'error', error: 'no port assignment found — is the bundle registered?' });
        }

        var candidates = [];
        for (var protocol in portsRev[env]) {
            for (var s in portsRev[env][protocol]) {
                candidates.push({ port: portsRev[env][protocol][s], scheme: s });
            }
        }
        if (!candidates.length) {
            return done({ bundle: bundle, mode: 'error', error: 'could not determine port' });
        }

        var query = [];
        if (self.dryRun) { query.push('dryRun=1'); }
        if (self.driver) { query.push('driver=' + encodeURIComponent(self.driver)); }
        var endpointPath = '/_gina/storage/gc' + ( query.length ? '?' + query.join('&') : '' );

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
                method             : 'POST',
                timeout            : 120000,
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
                        return done({ bundle: bundle, mode: 'error', error: 'invalid response from /_gina/storage/gc' });
                    }
                    if ( parsed && parsed.error ) {
                        return done({ bundle: bundle, mode: 'running', error: ( parsed.error === 'forbidden' )
                            ? 'reachable but admin-gated (app.json admin.allowFrom?)'
                            : (parsed.message || parsed.error) });
                    }
                    done({ bundle: bundle, mode: 'running', configured: !!parsed.configured, dryRun: !!parsed.dryRun, drivers: parsed.drivers || [] });
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
     * The DOWN path: resolve the bundle's `storage` block offline, build each
     * local cas driver through the boot's own resolver/factories, and loop
     * `sweepNow()` until `drained` (each pass is batch-capped by the driver;
     * the loop is hard-bounded so a pathological store cannot spin forever).
     * `--dry-run` runs a single listing pass and touches nothing.
     *
     * @inner
     * @param {string} bundle
     * @param {function(object)} done
     */
    var gcOffline = function(bundle, done) {
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

        var out = { bundle: bundle, mode: 'offline', configured: true, dryRun: self.dryRun, drivers: [] };
        var nextDriver = function(i) {
            if ( i >= names.length ) { return done(out); }
            var name = names[i];
            var d    = block.drivers[name];
            // s3 first — before the `store` check, so a warn-ignored `store`
            // key on a remote driver cannot produce a misleading skip reason.
            if ( d.adapter === 's3' ) {
                out.drivers.push({ name: name, skipped: true, reason: 'remote adapter (`s3`) — no sweep to run (only `cas` collects garbage)' });
                return nextDriver(i + 1);
            }
            if ( d.store ) {
                out.drivers.push({ name: name, skipped: true, reason: 'connector-backed store (`' + d.store + '`) — nothing local to open; start the bundle and re-run' });
                return nextDriver(i + 1);
            }
            if ( d.strategy !== 'cas' ) {
                out.drivers.push({ name: name, skipped: true, reason: 'this driver\'s strategy has no sweep (only `cas` collects garbage)' });
                return nextDriver(i + 1);
            }
            if ( !fs.existsSync(d.root) ) {
                out.drivers.push({ name: name, collected: 0, drained: true, note: 'root not created yet (nothing stored)' });
                return nextDriver(i + 1);
            }
            var driver = null;
            try {
                var resolved = storageLib._resolveDriverConf(d);
                resolved.sweepInterval = 0; // no GC timer in a CLI process
                var metaStore = storageLib._createEmbeddedMetaStore(nodePath.join(d.root, '.meta.db'));
                driver = storageLib._FACTORIES[d.strategy](name, resolved, metaStore);
            } catch (buildErr) {
                out.drivers.push({ name: name, error: buildErr.message || String(buildErr) });
                return nextDriver(i + 1);
            }
            var finish = function(entry) {
                try { driver.close(); } catch (e) { /* already closed */ }
                out.drivers.push(entry);
                nextDriver(i + 1);
            };
            if ( self.dryRun ) {
                return driver.sweepNow({ dryRun: true }, function(err, res) {
                    finish(err
                        ? { name: name, error: err.message || String(err) }
                        : { name: name, collectable: res.collectable, drained: res.drained });
                });
            }
            // full drain: loop the batch-capped pass until `drained`,
            // hard-bounded at 1000 passes (the endpoint's bound, mirrored)
            var total  = 0;
            var passes = 0;
            var loop = function() {
                driver.sweepNow(function(err, res) {
                    if (err) {
                        return finish({ name: name, error: err.message || String(err) });
                    }
                    total += res.collected;
                    passes++;
                    if ( !res.drained && passes < 1000 ) {
                        return setImmediate(loop);
                    }
                    finish({ name: name, collected: total, drained: res.drained, passes: passes });
                });
            };
            loop();
        };
        nextDriver(0);
    }

    /**
     * Builds the `--format=json` envelope. Pure. Single-bundle → flattened;
     * all-bundles → a `bundles` array.
     *
     * @inner
     * @param {string}        project
     * @param {Array<object>} results
     * @param {string|null}   singleBundle
     * @param {string|null}   driver
     * @returns {object}
     */
    var buildEnvelope = function(project, results, singleBundle, driver) {
        var base = { project: project, dryRun: self.dryRun };
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
        str += (self.dryRun ? '[ dry-run ] ' : '') + 'storage:gc @' + project + ( self.driver ? '  --driver=' + self.driver : '' ) + '\n\r';
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
                if ( typeof d.collectable !== 'undefined' ) {
                    // dry-run entry
                    str += '    driver `' + d.name + '`: would collect ' + d.collectable.length
                        + ' blob(s)' + ( d.drained ? '' : ' (more beyond this batch)' ) + '\n\r';
                    for (var c = 0; c < d.collectable.length; c++) {
                        str += '      ' + d.collectable[c] + '\n\r';
                    }
                    continue;
                }
                str += '    driver `' + d.name + '`: collected ' + d.collected + ' blob(s)'
                    + ( d.drained ? ' — drained' : ' — NOT drained (pass bound hit)' )
                    + ( typeof d.passes === 'number' ? ' (passes: ' + d.passes + ')' : '' )
                    + ( d.note ? ' — ' + d.note : '' ) + '\n\r';
            }
        }

        str += '\n\r';
        return str;
    }

    /**
     * Emits the result — JSON synchronously via fs.writeSync (pipe-safe
     * against the `process.exit` in `end()` — llms.txt #180), else text via
     * `opt.client` — then terminates. Exit code 1 when any per-bundle result
     * carries an error.
     * @inner
     */
    var report = function(opt, cmd) {
        var single   = (self.results.length === 1 && !!self.name) ? self.name : null;
        var hasError = self.results.some(function(r) { return !!r.error; });

        if ( /^json/i.test(String(self.format || '')) ) {
            var envelope = buildEnvelope(self.projectName, self.results, single, self.driver);
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
module.exports = Gc;
