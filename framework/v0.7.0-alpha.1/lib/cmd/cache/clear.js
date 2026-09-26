var fs    = require('fs');
var http  = require('http');
var https = require('https');

var CmdHelper   = require('./../helper');
var RenderCache = require('../../index').RenderCache;
var console     = lib.logger;

/**
 * @module gina/lib/cmd/cache/clear
 */
/**
 * Flushes a bundle's rendered-output cache — the `static:` (HTML) and `data:`
 * (JSON) namespaces — in two coordinated passes:
 *
 *   1. OFFLINE fs reclaim (`clearFsBundle`): removes the bundle's on-disk
 *      render-output dirs under the cache root, INCLUDING orphaned prior-release
 *      token dirs a redeploy left behind (`GINA_CACHE_NAMESPACE`/`GINA_VERSION`
 *      partition the cache into per-token subdirs). The `config`/`swig` infra
 *      caches are preserved. Runs even when the bundle is not running.
 *   2. IN-HEAP flush: POSTs the running bundle's admin-gated
 *      `/_gina/cache/clear` endpoint, which drops the live Map entries (and, via
 *      each entry's cleanup fn, their CURRENT-namespace fs body + `.meta`).
 *
 * `swig:` compiled templates and `http2session:` entries are never touched.
 *
 * The fs reclaim targets `<projectPath>/cache` — the resolved default
 * `server.cache.path` (`env.json`: `"path": "${cachePath}"` →
 * `"${projectPath}/cache"`, which is exactly CmdHelper's `projectCachePath`). A
 * bundle that overrides `server.cache.path` to a custom absolute path is NOT
 * auto-discovered by the offline reclaim; its CURRENT entries are still flushed
 * in-heap by the POST (the endpoint's cleanup fns close over the real filename),
 * only its old-namespace on-disk orphans are left.
 *
 * `--dry-run` previews without mutating: the fs pass reports what WOULD be
 * removed (via `clearFsBundle({ dryRun:true })`), and the in-heap pass does a
 * read-only `GET /_gina/cache/stats` REACHABILITY probe (never the mutating
 * POST). It reports reachable/not-running but NOT a would-clear count — the only
 * CLI-visible count comes from `stats()`, which drops string-valued entries (a
 * different code path than the real `clear()`), so a count could silently
 * diverge from the real run. The accurate count comes from the real POST
 * (`{ cleared:N }`).
 *
 * Usage:
 *  gina cache:clear <bundle> @<project>
 *  gina cache:clear @<project>                    — every bundle in the project
 *  gina cache:clear <bundle> @<project> --dry-run — preview (removes nothing)
 *  gina cache:clear <bundle> @<project> --format=json
 *
 * @class Clear
 * @constructor
 * @param {object}   opt        - Parsed command-line options
 * @param {object}   opt.client - Socket client for terminal output
 * @param {string[]} opt.argv   - Full argv array
 * @param {object}   cmd        - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // flush one bundle's render cache
 *  $ gina cache:clear api @myproject
 *
 * @example
 *  // preview only — nothing is removed
 *  $ gina cache:clear api @myproject --dry-run
 */
function Clear(opt, cmd) {
    var self = { format: null, dryRun: false, event: null, results: [] };

    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // Full pre-scan of argv for --format, --dry-run and --event. `cache/arguments.json`
        // whitelists all three so CmdHelper does not treat them as positional (bundle)
        // args (mirrors minion:kill).
        for (let i = 3, len = process.argv.length; i < len; i++) {
            if ( /^\-\-format\=/.test(process.argv[i]) ) {
                self.format = process.argv[i].split(/\=/)[1];
            } else if ( /^\-\-dry-run$/.test(process.argv[i]) ) {
                self.dryRun = true;
            } else if ( /^\-\-event\=/.test(process.argv[i]) ) {
                self.event = process.argv[i].split(/\=/)[1];
            }
        }

        if (!self.name) {
            // No bundle specified — clear every bundle in the project.
            clearAll(opt, cmd, 0);
        } else {
            clearOne(self.name, opt, cmd, false);
        }
    }

    /**
     * Clears every bundle in the project sequentially, then reports.
     * @inner
     */
    var clearAll = function(opt, cmd, index) {
        if (index >= self.bundles.length) {
            report(opt, cmd);
            return;
        }
        clearOne(self.bundles[index], opt, cmd, true, function() {
            clearAll(opt, cmd, index + 1);
        });
    }

    /**
     * Runs the two passes for one bundle (offline fs reclaim, then the in-heap
     * flush / dry-run probe), records the result, then advances / reports.
     * @inner
     */
    var clearOne = function(bundle, opt, cmd, isBulk, next) {
        // --- pass 1: offline fs reclaim (always runs, even if the bundle is down) ---
        // SKIPPED under --event: clearFsBundle is a bundle-wide directory reclaim that
        // knows nothing about events, so running it here would wipe the bundle's ENTIRE
        // on-disk cache while the caller asked for one event's entries. Event
        // registrations live in the bundle's heap, so --event is the in-heap pass only —
        // and that pass still removes each evicted fs entry's body + sidecar via its
        // cleanup fn.
        var fsRemoved = [];
        if ( !self.event ) {
            try {
                // new RenderCache() (no store/path) is safe for the offline fs path —
                // clearFsBundle uses only `fs` + the passed root/bundle.
                fsRemoved = new RenderCache().clearFsBundle(self.projectCachePath, bundle, { dryRun: self.dryRun });
            } catch (e) {
                // best-effort — a broken cache dir must not abort the whole run.
            }
        }

        // --- pass 2: in-heap flush (real: POST /clear; dry-run: GET /stats probe) ---
        probeOrClear(bundle, function(inHeapCleared, reachable) {
            self.results.push({
                bundle        : bundle,
                fsRemoved     : fsRemoved,
                inHeapCleared : inHeapCleared,
                reachable     : reachable
            });
            if (isBulk && next) return next();
            report(opt, cmd);
        });
    }

    /**
     * Resolves the bundle's assigned port(s) and, on a REAL run, POSTs
     * `/_gina/cache/clear?bundle=<name>` (parsing `{ cleared }`); on a DRY run,
     * does a read-only `GET /_gina/cache/stats` reachability probe (never
     * mutating). Tries each assigned port in turn, advancing on ECONNREFUSED; a
     * bundle refusing every port (or with no port assignment) is reported as not
     * running.
     *
     * @inner
     * @param {string} bundle
     * @param {function(number|null, boolean)} done - (inHeapCleared, reachable)
     */
    var probeOrClear = function(bundle, done) {
        var env      = self.projects[self.projectName].def_env;
        var portsRev = self.portsReverseData[bundle + '@' + self.projectName];

        if (!portsRev || !portsRev[env]) {
            return done(null, false);
        }

        // Collect all port/scheme combos for this bundle+env so we can try each in
        // turn — a bundle may only listen on a subset (e.g. http/2 only).
        var candidates = [];
        for (var protocol in portsRev[env]) {
            for (var s in portsRev[env][protocol]) {
                candidates.push({ port: portsRev[env][protocol][s], scheme: s });
            }
        }
        if (!candidates.length) {
            return done(null, false);
        }

        var method = self.dryRun ? 'GET' : 'POST';
        // --event evicts by event name (server-side `event` wins over `bundle`), so it
        // is sent INSTEAD of ?bundle= — the registry has no bundle dimension.
        var clearQuery = self.event
            ? '?event='  + encodeURIComponent(self.event)
            : '?bundle=' + encodeURIComponent(bundle);
        var path   = self.dryRun
            ? '/_gina/cache/stats'
            : '/_gina/cache/clear' + clearQuery;

        // Try each candidate in order; advance on ECONNREFUSED, stop on first response.
        var tryNext = function(index) {
            if (index >= candidates.length) {
                return done(null, false); // refused on every assigned port — not running
            }

            var candidate  = candidates[index];
            var transport  = (candidate.scheme === 'https') ? https : http;
            var reqOptions = {
                hostname           : '127.0.0.1',
                port               : candidate.port,
                path               : path,
                method             : method,
                timeout            : 5000,
                rejectUnauthorized : false  // allow self-signed certs on internal endpoints
            };

            var req = transport.request(reqOptions, function(res) {
                if (self.dryRun) {
                    // Reachability only — drain the body (do not trust a count from
                    // /stats, a different code path than the real clear()).
                    res.resume();
                    return done(null, true);
                }
                var raw = '';
                res.on('data', function(chunk) { raw += chunk; });
                res.on('end', function() {
                    // The real /_gina/cache/clear returns `{ ok, bundle, cleared }`.
                    // A non-2xx / forbidden body has no numeric `cleared` → leave it
                    // null (reachable=true still distinguishes it from "not running").
                    var cleared = null;
                    try {
                        var parsed = JSON.parse(raw);
                        if (parsed && typeof parsed.cleared === 'number') {
                            cleared = parsed.cleared;
                        }
                    } catch (e) { /* leave cleared null on an unparseable body */ }
                    done(cleared, true);
                });
            });

            req.on('timeout', function() {
                req.destroy();
                done(null, false);
            });

            req.on('error', function(err) {
                if (err.code === 'ECONNREFUSED') {
                    return tryNext(index + 1); // this port is not listening — try the next
                }
                done(null, false);
            });

            req.end();
        };

        tryNext(0);
    }

    /**
     * Builds the `--format=json` envelope from the per-bundle results. Pure.
     * Single-bundle → the fields are flattened onto the top object
     * (`bundle`/`fsRemoved`/`inHeapCleared`/`reachable`); all-bundles → a
     * `bundles` array of the same per-bundle objects.
     *
     * @inner
     * @param {string}         project     - Project name.
     * @param {boolean}        dryRun       - Whether this was a preview run.
     * @param {Array<object>}  results      - Per-bundle `{ bundle, fsRemoved, inHeapCleared, reachable }`.
     * @param {string|null}    singleBundle - The bundle name for a single-bundle run, else null.
     * @returns {object}
     */
    var buildEnvelope = function(project, dryRun, results, singleBundle, event) {
        var base = { project: project, dryRun: dryRun };
        // Only present on an --event run, so the flat-flush envelope stays unchanged.
        if (event) {
            base.event = event;
        }
        if (singleBundle && results.length === 1) {
            base.bundle        = results[0].bundle;
            base.fsRemoved     = results[0].fsRemoved;
            base.inHeapCleared = results[0].inHeapCleared;
            base.reachable     = results[0].reachable;
            return base;
        }
        base.bundles = results.map(function(r) {
            return {
                bundle        : r.bundle,
                fsRemoved     : r.fsRemoved,
                inHeapCleared : r.inHeapCleared,
                reachable     : r.reachable
            };
        });
        return base;
    }

    /**
     * Formats the per-bundle results as a human-readable summary. Pure.
     *
     * @inner
     * @param {Array<object>} results
     * @param {string}        project
     * @param {boolean}       dryRun
     * @returns {string}
     */
    var formatText = function(results, project, dryRun, event) {
        var SEP = '------------------------------------------------------------\n\r';
        var str = '\n\r' + SEP;
        str += (dryRun ? '[ dry-run ] ' : '') + 'cache:clear @' + project;
        if (event) {
            str += '  --event=' + event;
        }
        str += '\n\r';
        str += SEP;

        if (!results.length) {
            str += '  (no bundles)\n\r\n\r';
            return str;
        }

        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            str += '\n\r  [ ' + r.bundle + '@' + project + ' ]\n\r';

            // fs pass — skipped entirely on an --event run (it is bundle-wide, and would
            // wipe far more than the event's entries). Say so rather than printing a
            // "nothing reclaimed" that reads like an empty cache dir.
            if (event) {
                str += '    fs      : skipped (--event evicts in-heap; each evicted fs entry is removed with it)\n\r';
            } else if (r.fsRemoved.length === 0) {
                str += '    fs      : ' + (dryRun ? 'nothing to reclaim' : 'nothing reclaimed') + '\n\r';
            } else {
                str += '    fs      : ' + (dryRun ? 'would remove ' : 'removed ') + r.fsRemoved.length + ' dir(s)\n\r';
                for (var j = 0; j < r.fsRemoved.length; j++) {
                    str += '              ' + r.fsRemoved[j] + '\n\r';
                }
            }

            // in-heap pass
            if (!r.reachable) {
                str += '    in-heap : not running (' + (event ? 'nothing to evict — event registrations live in the bundle heap' : 'fs ' + (dryRun ? 'preview only' : 'reclaimed offline') + ', in-heap skipped') + ')\n\r';
            } else if (dryRun) {
                str += '    in-heap : reachable (would ' + (event ? 'evict the entries registered to ' + event : 'flush the live static:/data: cache') + ')\n\r';
            } else if (r.inHeapCleared === null) {
                str += '    in-heap : reachable (no count returned — admin.allowFrom?)\n\r';
            } else if (event) {
                str += '    in-heap : evicted ' + r.inHeapCleared + ' entr' + (r.inHeapCleared === 1 ? 'y' : 'ies') + ' registered to ' + event + '\n\r';
            } else {
                str += '    in-heap : cleared ' + r.inHeapCleared + ' entr' + (r.inHeapCleared === 1 ? 'y' : 'ies') + '\n\r';
            }
        }

        str += '\n\r';
        return str;
    }

    /**
     * Emits the result — the JSON envelope (`--format=json`) synchronously to
     * stdout (pipe-safe against the `process.exit` in `end()`), else a text
     * summary via `opt.client` — then terminates.
     * @inner
     */
    var report = function(opt, cmd) {
        var single = (self.results.length === 1 && !!self.name) ? self.name : null;

        if ( /^json/i.test(String(self.format || '')) ) {
            var envelope = buildEnvelope(self.projectName, self.dryRun, self.results, single, self.event);
            // fs.writeSync (not process.stdout.write): process.stdout is async on a
            // pipe, and end() calls process.exit right after — a plain write would
            // truncate a large envelope under `| jq` / `$(…)` (llms.txt #180).
            fs.writeSync(1, JSON.stringify(envelope) + '\n');
            return end(opt, cmd);
        }

        opt.client.write(formatText(self.results, self.projectName, self.dryRun, self.event));
        end(opt, cmd);
    }

    var end = function(opt, cmd, error) {
        if (!opt.client.destroyed) opt.client.emit('end');
        process.exit(error ? 1 : 0);
    }

    init(opt, cmd);
}
module.exports = Clear;
