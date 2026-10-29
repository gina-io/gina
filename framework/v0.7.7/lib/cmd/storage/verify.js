var fs       = require('fs');
var http     = require('http');
var https    = require('https');
var nodePath = require('path');

var CmdHelper  = require('./../helper');
var storageLib = require('../../index').storage;
var console    = lib.logger;

/**
 * @module gina/lib/cmd/storage/verify
 */
/**
 * Files ↔ rows consistency scan for a bundle's cas storage drivers. Two
 * finding classes, asymmetric by design:
 *   - `file-without-row` — the sweep's documented crash residue. Harmless,
 *     and FIXABLE: `--fix` unlinks it (OFFLINE ONLY);
 *   - `row-without-file` — LOSS EVIDENCE. Reported, never auto-fixed:
 *     deleting the row would destroy the only signal that content vanished.
 * Both directions are age-gated past `sweepGrace` inside the driver, so
 * in-flight work is never reported. Drivers without verify (sharded, v1) are
 * named-and-skipped.
 *
 * Who does the work depends on who OWNS the store (#STO1):
 *   - bundle RUNNING — `GET /_gina/storage/verify` (REPORT-ONLY over HTTP —
 *     the endpoint does not even parse a fix flag). `--fix` while the bundle
 *     runs is REFUSED: stop the bundle, then re-run;
 *   - bundle DOWN (every assigned port ECONNREFUSED) — the REAL driver is
 *     built offline (`sweepInterval: 0`) and `verify({fix})` runs here;
 *   - anything else (timeout, socket error) — reported as unknown, the
 *     store is NOT opened.
 *
 * Usage:
 *  gina storage:verify <bundle> @<project>
 *  gina storage:verify @<project>                — every bundle in the project
 *  gina storage:verify <bundle> @<project> --fix
 *  gina storage:verify <bundle> @<project> --driver=<name> --format=json
 *
 * @class Verify
 * @constructor
 * @param {object}   opt        - Parsed command-line options
 * @param {object}   opt.client - Socket client for terminal output
 * @param {string[]} opt.argv   - Full argv array
 * @param {object}   cmd        - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // report-only scan (works running or stopped)
 *  $ gina storage:verify api @myproject
 *
 * @example
 *  // scrub sweep crash residue — the bundle must be STOPPED
 *  $ gina storage:verify api @myproject --fix
 */
function Verify(opt, cmd) {
    var self = { format: null, driver: null, fix: false, results: [] };

    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // Full pre-scan of argv for --format, --driver and --fix —
        // whitelisted in `storage/arguments.json` (mirrors cache:clear).
        for (let i = 3, len = process.argv.length; i < len; i++) {
            if ( /^\-\-format\=/.test(process.argv[i]) ) {
                self.format = process.argv[i].split(/\=/)[1];
            } else if ( /^\-\-driver\=/.test(process.argv[i]) ) {
                self.driver = process.argv[i].split(/\=/)[1];
            } else if ( /^\-\-fix$/.test(process.argv[i]) ) {
                self.fix = true;
            }
        }

        if (!self.name) {
            // No bundle specified — verify every bundle in the project.
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
     * Resolves one bundle (running → endpoint report, down → offline verify),
     * records the result, then advances / reports. A RUNNING bundle under
     * `--fix` becomes a refusal: the racy half of verify only exists offline,
     * where it is safe by construction.
     * @inner
     */
    var runOne = function(bundle, opt, cmd, isBulk, next) {
        var advance = function(result) {
            self.results.push(result);
            if (isBulk && next) return next();
            report(opt, cmd);
        };
        probeAndVerify(bundle, function(outcome) {
            if ( outcome.mode === 'down' ) {
                return verifyOffline(bundle, advance);
            }
            if ( outcome.mode === 'running' && self.fix && !outcome.error ) {
                return advance({ bundle: bundle, mode: 'running', error: '--fix refused while the bundle runs — the running process owns the store; stop the bundle, then re-run' });
            }
            advance(outcome);
        });
    }

    /**
     * Sends `GET /_gina/storage/verify` (report-only — the request IS the
     * probe, and it mutates nothing): a response classifies the bundle
     * RUNNING and carries the report; ECONNREFUSED advances; every candidate
     * refused classifies it DOWN. The response timeout is 120s, not the 5s
     * probe class: the server walks the whole tree before answering (the
     * walk is chunked server-side, the response is not).
     *
     * @inner
     * @param {string} bundle
     * @param {function(object)} done - Result object, or `{mode:'down'}`.
     */
    var probeAndVerify = function(bundle, done) {
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

        var endpointPath = '/_gina/storage/verify'
            + ( self.driver ? '?driver=' + encodeURIComponent(self.driver) : '' );

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
                        return done({ bundle: bundle, mode: 'error', error: 'invalid response from /_gina/storage/verify' });
                    }
                    if ( parsed && parsed.error ) {
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
     * The DOWN path: resolve the bundle's `storage` block offline, build each
     * local cas driver through the boot's own resolver/factories, and run
     * `verify({fix})` — the ONLY place `--fix` is honoured.
     *
     * @inner
     * @param {string} bundle
     * @param {function(object)} done
     */
    var verifyOffline = function(bundle, done) {
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

        var out = { bundle: bundle, mode: 'offline', configured: true, fix: self.fix, drivers: [] };
        var nextDriver = function(i) {
            if ( i >= names.length ) { return done(out); }
            var name = names[i];
            var d    = block.drivers[name];
            // s3 first — before the `store` check, so a warn-ignored `store`
            // key on a remote driver cannot produce a misleading skip reason.
            if ( d.adapter === 's3' ) {
                out.drivers.push({ name: name, skipped: true, reason: 'remote adapter (`s3`) — verify is cas-only in v1' });
                return nextDriver(i + 1);
            }
            if ( d.store ) {
                out.drivers.push({ name: name, skipped: true, reason: 'connector-backed store (`' + d.store + '`) — nothing local to open; start the bundle and re-run' });
                return nextDriver(i + 1);
            }
            if ( d.strategy !== 'cas' ) {
                out.drivers.push({ name: name, skipped: true, reason: 'verify is cas-only in v1' });
                return nextDriver(i + 1);
            }
            if ( !fs.existsSync(d.root) ) {
                out.drivers.push({ name: name, skipped: true, reason: 'root not created yet (nothing stored)' });
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
            driver.verify({ fix: self.fix }, function(err, rep) {
                try { driver.close(); } catch (e) { /* already closed */ }
                out.drivers.push(err ? { name: name, error: err.message || String(err) } : rep);
                nextDriver(i + 1);
            });
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
        var base = { project: project, fix: self.fix };
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
     * A driver report line names both finding classes with their counts; the
     * itemised list prints each finding's full key (an operator pastes it
     * back into an investigation verbatim).
     *
     * @inner
     * @param {Array<object>} results
     * @param {string}        project
     * @returns {string}
     */
    var formatText = function(results, project) {
        var SEP = '------------------------------------------------------------\n\r';
        var str = '\n\r' + SEP;
        str += (self.fix ? '[ fix ] ' : '') + 'storage:verify @' + project + ( self.driver ? '  --driver=' + self.driver : '' ) + '\n\r';
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
                    str += '    driver `' + (d.name || d.driver) + '`: ' + d.error + '\n\r';
                    continue;
                }
                if (d.skipped) {
                    str += '    driver `' + d.name + '`: skipped — ' + d.reason + '\n\r';
                    continue;
                }
                // a driver verify report: {driver, strategy, checked, findings, findingCounts, …}
                var counts = d.findingCounts || { filesWithoutRows: 0, rowsWithoutFiles: 0 };
                var totalFindings = counts.filesWithoutRows + counts.rowsWithoutFiles;
                str += '    driver `' + d.driver + '` (' + d.strategy + '): files ' + d.checked.files
                    + ' / rows ' + d.checked.rows + ' checked — '
                    + ( totalFindings === 0
                        ? 'clean'
                        : totalFindings + ' finding(s): files-without-rows ' + counts.filesWithoutRows
                            + ( self.fix && typeof d.fixedCount === 'number' ? ' (fixed ' + d.fixedCount + ')' : ' (fixable)' )
                            + ', rows-without-files ' + counts.rowsWithoutFiles + ' (LOSS EVIDENCE — never auto-fixed)' )
                    + '\n\r';
                if ( d.rowsChecked === false ) {
                    str += '      rows direction skipped: the store cannot enumerate rows\n\r';
                }
                for (var f = 0; f < (d.findings || []).length; f++) {
                    var finding = d.findings[f];
                    if ( finding['class'] === 'file-without-row' ) {
                        str += '      file-without-row  ' + finding.key + '  (' + finding.size + ' B)'
                            + ( finding.fixed === true ? '  [fixed]' : ( finding.fixed === false ? '  [fix FAILED: ' + finding.error + ']' : '' ) ) + '\n\r';
                    } else {
                        str += '      row-without-file  ' + finding.key + '  refs=' + finding.refs
                            + ( finding.originalName ? '  (' + finding.originalName + ')' : '' )
                            + '  — loss evidence\n\r';
                    }
                }
                if ( d.findingsTruncated ) {
                    str += '      (findings list truncated — the counts above are exact)\n\r';
                }
            }
        }

        str += '\n\r';
        return str;
    }

    /**
     * Emits the result — JSON synchronously via fs.writeSync (pipe-safe
     * against the `process.exit` in `end()` — llms.txt #180), else text via
     * `opt.client` — then terminates. Exit code 1 when any per-bundle result
     * carries an error (a FINDING is a report, not a command failure).
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
module.exports = Verify;
