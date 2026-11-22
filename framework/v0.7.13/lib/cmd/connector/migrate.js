var fs      = require('fs');
var path    = require('path');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/connector/migrate
 */
/**
 * CLI-only lint + fix for `connectors.json` files. Positional-absence
 * scoping:
 *
 *   gina connector:migrate @<project>           → shared + every bundle
 *   gina connector:migrate <bundle> @<project>  → just that bundle
 *
 * Default mode is a dry run — nothing is written. Pass `--fix` to apply
 * auto-fixable issues. Output format is human-readable text by default
 * and JSON with `--format=json`.
 *
 * Checks performed:
 *   1. `missing-schema` — top-level `$schema` key is absent. Fixable:
 *      inject `"$schema": "https://gina.io/schema/connectors.json"` at
 *      the top of the object, preserving key order.
 *   2. `bare-key-no-connector` — an entry has no `connector` field and
 *      the logical key is not in the built-in enum (couchbase, mysql,
 *      postgresql, sqlite, redis, ai). Not auto-fixable — we can't
 *      infer which driver the user meant. Prints the manual fix path.
 *
 * The framework config loader (`core/config.js`) is NOT modified by this
 * session. There is no runtime auto-migration hook — this subcommand is
 * explicit, opt-in, and CI-friendly only. See
 * the internal plan doc § "Recommendation (narrower C)"
 * for the rationale: no real old-shape → new-shape delta exists today, so
 * touching `Config.load()` on the boot path would be premature. Revisit
 * when a concrete migration (e.g. #CN8 Couchbase SDK v2 removal at
 * `0.4.0`) lands with a real before/after shape.
 *
 * Leading comment headers (everything before the first non-comment `{`) are preserved
 * verbatim when `--fix` writes the file — same convention as `add.js` and
 * `remove.js`. Mid-body comments are lost on rewrite.
 *
 * Flags:
 *   --fix            Apply auto-fixable issues. Without it, scan is
 *                    read-only (dry run).
 *   --format=json    Emit machine-readable JSON instead of the text
 *                    summary.
 *
 * Usage:
 *   gina connector:migrate @myproject
 *   gina connector:migrate api @myproject
 *   gina connector:migrate @myproject --fix
 *   gina connector:migrate @myproject --format=json
 *
 * @class Migrate
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Migrate(opt, cmd) {
    var self = {};

    /**
     * Allowed `connector` driver types — mirrors the enum in
     * `schema/connectors.json`. Kept in sync with `list.js`, `add.js`,
     * and `remove.js` by hand.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var ALLOWED_CONNECTOR_TYPES = ['couchbase', 'mysql', 'postgresql', 'sqlite', 'redis', 'ai', 'scylladb', 'mongodb', 'duckdb'];

    /**
     * Canonical `$schema` URL injected by the `missing-schema` auto-fix.
     * Matches the value written by `add.js::mergeEntry`.
     *
     * @inner
     * @constant
     * @type {string}
     */
    var SCHEMA_URL = 'https://gina.io/schema/connectors.json';

    /**
     * Resolve scope, scan every target file, optionally apply fixes, and
     * emit the report in the chosen format.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        var positionals = extractPositionals(process.argv);
        var bundleName  = positionals[0] || null;

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            console.error('`connector:migrate` requires `@<project>`. Did you forget `@<project_name>`?');
            process.exit(1);
            return;
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('Project @' + self.projectName + ' is not registered. Run `gina project:list` to see registered projects.');
            process.exit(1);
            return;
        }

        var projectPath = self.projects[self.projectName].path;
        var manifest    = loadManifest(projectPath);
        if (!manifest || !manifest.bundles) {
            console.error('Cannot read `' + projectPath + '/manifest.json`. Project is missing or malformed.');
            process.exit(1);
            return;
        }

        var p       = self.params || {};
        var fix     = !!p['fix'];
        var format  = p['format'] || null;
        if (format && format !== 'json') {
            console.error('Unknown --format value `' + format + '`. Supported: json.');
            process.exit(1);
            return;
        }
        var asJson  = (format === 'json');

        var targets = resolveTargets(projectPath, manifest, bundleName);
        if (!targets) return;

        var reports = [];
        for (var i = 0; i < targets.length; i++) {
            var report = scanFile(targets[i].path, targets[i].bundle);
            if (fix && report.fixable.length > 0) {
                applyFixes(report);
            }
            reports.push(report);
        }

        if (asJson) {
            emitJson(reports, bundleName, fix);
        } else {
            emitText(reports, fix);
        }

        process.exit(0);
    };

    /**
     * Walks `process.argv` from index 3 and returns every non-flag,
     * non-`@<project>` token in order. Mirrors `remove.js::extractPositionals`.
     * For `connector:migrate` there is at most one positional (the bundle
     * name); extras are ignored.
     *
     * @inner
     * @private
     * @param {string[]} argv - process.argv
     * @returns {string[]}
     */
    var extractPositionals = function (argv) {
        var out = [];
        for (var i = 3, len = argv.length; i < len; i++) {
            var tok = argv[i];
            if ( typeof(tok) != 'string' ) continue;
            if ( /^\-\-/.test(tok) ) continue;
            if ( /^\-/.test(tok)  ) continue;
            if ( /^\@/.test(tok)  ) continue;
            out.push(tok);
        }
        return out;
    };

    /**
     * Loads `<projectPath>/manifest.json` with comment tolerance. Returns
     * null on missing or malformed file so the caller can exit with a
     * precise error.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @returns {object|null}
     */
    var loadManifest = function (projectPath) {
        try {
            var p = _(projectPath + '/manifest.json', true);
            if ( !fs.existsSync(p) ) return null;
            return requireJSON(p);
        } catch (e) {
            return null;
        }
    };

    /**
     * Builds the list of `{path, bundle}` targets to scan. For a
     * project-scope invocation (no `<bundle>`), returns shared +
     * every registered bundle. For a bundle-scope invocation, returns
     * just that bundle's file.
     *
     * Validates the bundle exists in the manifest when supplied. Exits
     * on error and returns null.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {object} manifest
     * @param {string|null} bundleName
     * @returns {Array<{path: string, bundle: string|null}>|null}
     */
    var resolveTargets = function (projectPath, manifest, bundleName) {
        if (bundleName) {
            if ( !manifest.bundles[bundleName] ) {
                console.error('Bundle [ ' + bundleName + ' ] is not registered inside `@' + self.projectName + '`.');
                process.exit(1);
                return null;
            }
            var bundleSrc = manifest.bundles[bundleName].src;
            if (!bundleSrc) {
                console.error('Bundle [ ' + bundleName + ' ] has no `src` entry in manifest.json.');
                process.exit(1);
                return null;
            }
            return [ {
                path   : _(projectPath + '/' + bundleSrc + '/config/connectors.json', true),
                bundle : bundleName
            } ];
        }

        var out = [ {
            path   : _(projectPath + '/shared/config/connectors.json', true),
            bundle : null
        } ];
        var bundleNames = Object.keys(manifest.bundles);
        for (var i = 0; i < bundleNames.length; i++) {
            var bName = bundleNames[i];
            var bSrc  = manifest.bundles[bName].src;
            if (!bSrc) continue;
            out.push({
                path   : _(projectPath + '/' + bSrc + '/config/connectors.json', true),
                bundle : bName
            });
        }
        return out;
    };

    /**
     * Scans a single `connectors.json` for known lintable issues. Returns
     * a `Report` shape carrying both the findings and enough parsed state
     * for `applyFixes` to rewrite the file in place.
     *
     * Non-existent files are reported as `exists: false` and contribute
     * no issues — they are skipped cleanly, not treated as errors. A
     * parse failure is recorded under `parseError` and suppresses further
     * scanning for that file.
     *
     * @inner
     * @private
     * @param {string} filePath - Absolute path to connectors.json
     * @param {string|null} bundleName
     * @returns {Report}
     */
    var scanFile = function (filePath, bundleName) {
        var report = {
            path           : filePath,
            bundle         : bundleName,
            exists         : fs.existsSync(filePath),
            parseError     : null,
            connectorCount : 0,
            issues         : [],
            fixable        : [],
            fixed          : [],
            parsed         : null,
            header         : ''
        };
        if (!report.exists) return report;

        var raw;
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            report.parseError = 'read failed: ' + e.message;
            return report;
        }
        // Comment-aware: the scaffolded template's `// "couchbase": {` puts a
        // brace inside a comment, so a naive first-brace scan lands there and
        // corrupts a --fix rewrite. splitHeader finds the first STRUCTURAL `{`.
        report.header = lib.jsonConfigHeader.splitHeader(raw).header;

        var data;
        try {
            data = requireJSON(filePath) || {};
        } catch (e) {
            report.parseError = 'parse failed: ' + e.message;
            return report;
        }
        report.parsed = data;

        for (var k in data) {
            if (k === '$schema') continue;
            report.connectorCount++;
        }

        if (typeof data.$schema == 'undefined') {
            var schemaIssue = {
                type     : 'missing-schema',
                severity : 'info',
                fixable  : true,
                message  : 'Top-level `$schema` key missing. Auto-fix adds `"$schema": "' + SCHEMA_URL + '"`.'
            };
            report.issues.push(schemaIssue);
            report.fixable.push(schemaIssue);
        }

        for (var name in data) {
            if (name === '$schema') continue;
            var entry = data[name];
            if (!entry || typeof entry != 'object') continue;
            var hasConnectorField = (typeof entry.connector == 'string');
            var keyInEnum         = (ALLOWED_CONNECTOR_TYPES.indexOf(name) > -1);
            if (!hasConnectorField && !keyInEnum) {
                report.issues.push({
                    type     : 'bare-key-no-connector',
                    key      : name,
                    severity : 'warn',
                    fixable  : false,
                    message  : 'Entry `' + name + '` has no `connector` field and key `' + name + '` is not in the built-in enum (' + ALLOWED_CONNECTOR_TYPES.join(', ') + '). Add `"connector": "<type>"` by hand, or re-declare via `gina connector:add ' + name + ' @<project> --connector=<type> --force`.'
                });
            }
        }

        return report;
    };

    /**
     * Applies the fixable issues on `report` in place. Today the only
     * auto-fixable issue is `missing-schema`; when it fires we rewrite
     * the file with `$schema` pinned at the top and every existing key
     * preserved in its original order. The file's leading comment header
     * is preserved verbatim.
     *
     * Mutates `report.parsed`, appends to `report.fixed`, and empties
     * `report.fixable` for the fixes that were applied. Issues are
     * removed from `report.issues` as they get fixed so the final
     * report reflects only issues that still need user attention.
     *
     * @inner
     * @private
     * @param {Report} report
     */
    var applyFixes = function (report) {
        var applied = [];
        var needsSchemaFix = false;
        for (var i = 0; i < report.fixable.length; i++) {
            if (report.fixable[i].type === 'missing-schema') {
                needsSchemaFix = true;
                applied.push(report.fixable[i]);
            }
        }

        if (needsSchemaFix) {
            var out = { $schema: SCHEMA_URL };
            for (var k in report.parsed) {
                if (k === '$schema') continue;
                out[k] = report.parsed[k];
            }
            var body = JSON.stringify(out, null, 4);
            var text = (report.header || '') + body + '\n';
            lib.generator.createFileFromDataSync(text, report.path);
            report.parsed = out;
        }

        report.fixed = report.fixed.concat(applied);
        var appliedSet = {};
        for (var a = 0; a < applied.length; a++) appliedSet[applied[a].type] = true;
        report.issues  = report.issues.filter(function (iss) { return !appliedSet[iss.type]; });
        report.fixable = report.fixable.filter(function (iss) { return !appliedSet[iss.type]; });
    };

    /**
     * Prints the human-readable summary to the socket client. Grouped by
     * file, one line per issue, with a totals footer when running in
     * dry-run mode and issues were found.
     *
     * @inner
     * @private
     * @param {Report[]} reports
     * @param {boolean} fix
     */
    var emitText = function (reports, fix) {
        var prefix       = fix ? '[fix]' : '[dry-run]';
        var totalIssues  = 0;
        var totalFixable = 0;
        var totalFixed   = 0;
        var totalWarn    = 0;

        for (var i = 0; i < reports.length; i++) {
            var r      = reports[i];
            var label  = r.bundle ? ('bundle `' + r.bundle + '`') : 'shared';

            if (!r.exists) {
                console.log(prefix + ' ' + r.path + ' (' + label + ') — missing (skipped)');
                continue;
            }
            if (r.parseError) {
                console.log(prefix + ' ' + r.path + ' (' + label + ') — ' + r.parseError);
                continue;
            }

            var fixedCount = r.fixed.length;
            var issueCount = r.issues.length;
            var warnCount  = 0;
            for (var w = 0; w < r.issues.length; w++) {
                if (r.issues[w].severity === 'warn') warnCount++;
                if (r.issues[w].fixable) totalFixable++;
            }
            totalIssues += issueCount;
            totalFixed  += fixedCount;
            totalWarn   += warnCount;

            var summary = r.connectorCount + ' connector(s)';
            if (fixedCount) summary += ', ' + fixedCount + ' fixed';
            if (issueCount) summary += ', ' + issueCount + ' issue(s) remaining';
            if (!fixedCount && !issueCount) summary += ', no issues';

            console.log(prefix + ' ' + r.path + ' (' + label + ') — ' + summary);
            for (var j = 0; j < r.fixed.length; j++) {
                console.log('    FIXED  ' + r.fixed[j].type + ' — ' + r.fixed[j].message);
            }
            for (var m = 0; m < r.issues.length; m++) {
                var iss = r.issues[m];
                var tag = (iss.severity === 'warn') ? 'WARN ' : 'INFO ';
                var keyPart = iss.key ? ('`' + iss.key + '` ') : '';
                console.log('    ' + tag + ' ' + iss.type + ' — ' + keyPart + iss.message);
            }
        }

        if (!fix && totalFixable > 0) {
            var manual = totalWarn;
            var autoFix = totalFixable;
            console.log('');
            console.log('Re-run with --fix to apply ' + autoFix + ' auto-fixable issue(s).' + (manual > 0 ? ' ' + manual + ' issue(s) need manual attention.' : ''));
        } else if (!fix && totalWarn > 0) {
            console.log('');
            console.log(totalWarn + ' issue(s) need manual attention — no auto-fix available.');
        } else if (fix && totalIssues > 0) {
            console.log('');
            console.log('Applied ' + totalFixed + ' fix(es). ' + totalIssues + ' issue(s) still need manual attention.');
        } else if (fix && totalFixed > 0) {
            console.log('');
            console.log('Applied ' + totalFixed + ' fix(es). No issues remaining.');
        }
    };

    /**
     * Emits the machine-readable JSON report to the socket client. Wraps
     * per-file reports inside a top-level object with scope metadata.
     *
     * @inner
     * @private
     * @param {Report[]} reports
     * @param {string|null} bundleName
     * @param {boolean} fix
     */
    var emitJson = function (reports, bundleName, fix) {
        var files = [];
        for (var i = 0; i < reports.length; i++) {
            var r = reports[i];
            files.push({
                path           : r.path,
                bundle         : r.bundle,
                exists         : r.exists,
                parseError     : r.parseError,
                connectorCount : r.connectorCount,
                fixed          : r.fixed,
                issues         : r.issues
            });
        }
        console.log(JSON.stringify({
            project    : self.projectName,
            scope      : bundleName ? 'bundle' : 'project',
            bundle     : bundleName,
            fixApplied : fix,
            files      : files
        }, null, 2));
    };

    init();
}

/**
 * @typedef {object} Issue
 * @property {string} type - `missing-schema` | `bare-key-no-connector`
 * @property {string} [key] - Logical connector name (present for entry-level issues)
 * @property {string} severity - `info` | `warn`
 * @property {boolean} fixable - True when the issue has an auto-fix
 * @property {string} message - Human-readable description
 */

/**
 * @typedef {object} Report
 * @property {string} path - Absolute path to the scanned connectors.json
 * @property {string|null} bundle - Bundle name, or null for shared
 * @property {boolean} exists - False if the file does not exist
 * @property {string|null} parseError - Non-null when the file could not be parsed
 * @property {number} connectorCount - Count of declared connectors (excluding $schema)
 * @property {Issue[]} issues - Issues still present after any --fix applied
 * @property {Issue[]} fixable - Subset of issues that can be auto-fixed
 * @property {Issue[]} fixed - Issues resolved by --fix
 * @property {object|null} parsed - Parsed JSON graph (nullable on parse error)
 * @property {string} header - Comment header above the first `{` (preserved on rewrite)
 */

module.exports = Migrate;
