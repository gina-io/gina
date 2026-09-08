var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/secrets/scan
 */
/**
 * Walks every bundle in a project (or a single named bundle) and reports
 * the `${secret:KEY}` placeholders each bundle requires, aggregated as
 * KEY -> originating config file(s). Read-only: it never resolves a
 * placeholder, never reads `process.env`, and never writes anything.
 *
 * Usage:
 *  gina secrets:scan
 *  gina secrets:scan @<project>
 *  gina secrets:scan <bundle> @<project>
 *  gina secrets:scan @<project> --format=json
 *  gina secrets:scan @<project> --scope=<scope>
 *
 * The walk itself — which config sources a bundle reads, how the
 * `--scope` overlay applies, which files are skipped — lives in
 * `lib/secrets` (the sources module) and is consumed here through the
 * registry, so this command, `secrets:check` and any future boot-time
 * consumer enumerate the SAME source set by construction. See that
 * module's header for the full walk semantics and the drift incident
 * that motivated sharing it.
 *
 * @class Scan
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Scan(opt, cmd) {
    var self = { format: 'text', scopeName: null };

    var secrets = lib.secrets;

    /**
     * Parses `--format`, resolves project + optional bundle via CmdHelper,
     * dispatches to the right walker, and exits.
     *
     * @inner
     * @private
     */
    var init = function () {
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            if ( /^\-\-format\=/.test(arg) ) {
                self.format = arg.split(/\=/)[1] || 'text';
            }
        }
        if (self.format !== 'text' && self.format !== 'json') {
            console.error('--format must be `text` or `json` (got `' + self.format + '`)');
            process.exit(1);
            return;
        }

        // --scope is the framework scope flag (declared in arguments.json, like
        // bundle:*; CmdHelper captures it into self.params). null when absent.
        self.scopeName = (self.params && self.params.scope) ? self.params.scope : null;

        var bundleFilter = self.name || null;

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            if (bundleFilter) {
                console.error('`secrets:scan <bundle>` requires `@<project>`. Did you forget `@<project_name>`?');
                process.exit(1);
                return;
            }
            scanAll();
            process.exit(0);
            return;
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('Project @' + self.projectName + ' is not registered. Run `gina project:list` to see registered projects.');
            process.exit(1);
            return;
        }

        if (bundleFilter) {
            var manifest = secrets.loadManifest(self.projects[self.projectName].path);
            if (manifest && manifest.bundles && !manifest.bundles[bundleFilter]) {
                console.error('Bundle [ ' + bundleFilter + ' ] is not registered inside `@' + self.projectName + '`.');
                process.exit(1);
                return;
            }
            scanBundleOnly(self.projectName, bundleFilter);
        } else {
            scanProjectOnly(self.projectName);
        }

        process.exit(0);
    };

    // The config-dir walk itself (manifest read, dir globbing, scope overlay,
    // key enumeration) moved to lib/secrets' sources module, consumed below
    // via secrets.getProjectRequiredKeys — see that module's header for the
    // walk semantics and the sharing rationale.

    /**
     * Shapes one walk entry into this command's per-bundle report block.
     *
     * @inner
     * @private
     * @param {{bundle: string, byKey: Object<string, string[]>}} entry - One walk entry
     * @returns {{bundle:string, totalKeys:number, byKey:Object<string, string[]>}}
     */
    var toBundleReport = function (entry) {
        return {
            bundle    : entry.bundle,
            totalKeys : Object.keys(entry.byKey).length,
            byKey     : entry.byKey
        };
    };

    /**
     * Iterates every registered project, scanning all bundles in each.
     *
     * @inner
     * @private
     */
    var scanAll = function () {
        var report = { projects: [] };
        var names  = Object.keys(self.projects).sort();
        for (var i = 0; i < names.length; i++) {
            var walked = secrets.getProjectRequiredKeys(self.projects[names[i]].path, { scope: self.scopeName });
            if (!walked) continue;
            var entry = { project: names[i], bundles: [] };
            for (var b = 0; b < walked.bundles.length; b++) {
                entry.bundles.push(toBundleReport(walked.bundles[b]));
            }
            report.projects.push(entry);
        }
        emit(report);
    };

    /**
     * Scans every bundle in a single named project.
     *
     * @inner
     * @private
     * @param {string} projectName
     */
    var scanProjectOnly = function (projectName) {
        var project = self.projects[projectName];
        var walked  = secrets.getProjectRequiredKeys(project.path, { scope: self.scopeName });
        if (!walked) {
            console.error('Project @' + projectName + ' has no manifest.json or no bundles registered.');
            process.exit(1);
            return;
        }
        var report = { project: projectName, bundles: [] };
        for (var i = 0; i < walked.bundles.length; i++) {
            report.bundles.push(toBundleReport(walked.bundles[i]));
        }
        emit(report);
    };

    /**
     * Scans a single bundle in a single project.
     *
     * @inner
     * @private
     * @param {string} projectName
     * @param {string} bundleName
     */
    var scanBundleOnly = function (projectName, bundleName) {
        var project = self.projects[projectName];
        var walked  = secrets.getProjectRequiredKeys(project.path, { scope: self.scopeName, bundle: bundleName });
        var report  = { project: projectName, bundles: [toBundleReport(walked.bundles[0])] };
        emit(report);
    };

    /**
     * Dispatches to the JSON or text renderer based on `self.format`.
     *
     * @inner
     * @private
     * @param {object} report
     */
    var emit = function (report) {
        if (self.format === 'json') {
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        emitText(report);
    };

    /**
     * Renders the human-readable text report.
     *
     * @inner
     * @private
     * @param {object} report
     */
    var emitText = function (report) {
        var projects = report.projects
            ? report.projects
            : [{ project: report.project, bundles: report.bundles }];
        for (var p = 0; p < projects.length; p++) {
            var proj = projects[p];
            console.log('\n@' + proj.project + (self.scopeName ? ' (scope: ' + self.scopeName + ')' : '') + ':');
            if (proj.bundles.length === 0) {
                console.log('  (no bundles)');
                continue;
            }
            for (var b = 0; b < proj.bundles.length; b++) {
                emitTextBundle(proj.bundles[b]);
            }
        }
    };

    /**
     * Renders one bundle's required-secrets block.
     *
     * @inner
     * @private
     * @param {object} br - One bundle report from `scanBundle`
     */
    var emitTextBundle = function (br) {
        console.log('  ' + br.bundle + ':');
        if (br.totalKeys === 0) {
            console.log('    No ${secret:KEY} placeholders found in config.');
            return;
        }
        var keys  = Object.keys(br.byKey).sort();
        var width = 0;
        for (var w = 0; w < keys.length; w++) {
            if (keys[w].length > width) width = keys[w].length;
        }
        console.log('    Required secrets (' + br.totalKeys + '):');
        for (var k = 0; k < keys.length; k++) {
            console.log('      ' + padRight(keys[k], width) + '   <-  ' + br.byKey[keys[k]].join(', '));
        }
    };

    /**
     * Right-pads `s` with spaces to reach `n` characters.
     *
     * @inner
     * @private
     * @param {string} s
     * @param {number} n
     * @returns {string}
     */
    var padRight = function (s, n) {
        var o = String(s || '');
        while (o.length < n) o += ' ';
        return o;
    };

    init();
}

module.exports = Scan;
