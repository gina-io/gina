var fs      = require('fs');
var path    = require('path');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/i18n/scan
 */
/**
 * Walks every bundle in a project (or a single named bundle) and reports
 * translation coverage per culture: which keys the bundle's source code
 * uses, and how many of those keys each `bundle/locales/<culture>.json`
 * catalog covers.
 *
 * Usage:
 *  gina i18n:scan
 *  gina i18n:scan @<project>
 *  gina i18n:scan <bundle> @<project>
 *  gina i18n:scan @<project> --format=json
 *
 * Detects keys via three regex patterns:
 *   - `t("key")` / `self.t("key")` — JS source (controllers, middleware,
 *     models, lib, top-level .js).
 *   - `__("key")` — legacy alias.
 *   - `"key" | t` — template filter (swig / nunjucks / njk / html).
 *
 * Walks: `controllers/`, `middleware/`, `models/`, `lib/`, `src/`,
 * `views/`, `public/`, plus any top-level `.js`. Excludes `node_modules`,
 * `dist`, `.git`, `locales/`, and dotfiles.
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
    var self = { format: 'text' };

    var i18n = lib.i18n;

    /**
     * Subdirectories under `<bundle>/` that may contain source code with
     * translation keys.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var SOURCE_DIRS = ['controllers', 'middleware', 'models', 'lib', 'src', 'views', 'public'];

    /**
     * Directory names skipped during walk — vendored deps, build outputs,
     * VCS metadata, and the catalog dir itself.
     *
     * @inner
     * @constant
     * @type {Object<string, true>}
     */
    var EXCLUDE_DIRS = { 'node_modules': true, 'dist': true, '.git': true, 'locales': true };

    /**
     * File extensions scanned for `t()` / `self.t()` / `__()` calls.
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var JS_EXT = /\.(js|mjs|cjs)$/;

    /**
     * File extensions scanned for the `| t` template filter.
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var TEMPLATE_EXT = /\.(swig|nunjucks|njk|html|htm)$/;

    /**
     * `t("key")` / `self.t("key")` matcher — `t` preceded by a
     * non-identifier character so we don't false-match on `qrt(`, `mt(`, etc.
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var T_CALL_RE = /(?:^|[^A-Za-z0-9_$])t\s*\(\s*['"]([^'"\\]+)['"]/g;

    /**
     * `__("key")` matcher — the legacy alias.
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var LEGACY_CALL_RE = /(?:^|[^A-Za-z0-9_$])__\s*\(\s*['"]([^'"\\]+)['"]/g;

    /**
     * Template filter matcher: `"key" | t` or `'key' | t` (optionally
     * followed by `(...)` for `t({ name: x })`).
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var TEMPLATE_T_RE = /['"]([^'"\\]+)['"]\s*\|\s*t\b/g;

    /**
     * Catalog filename pattern — `<lang>(_<REGION>)?.json`.
     * Mirrors `lib/i18n/src/main.js` `CULTURE_FILENAME`.
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var CULTURE_RE = /^([a-z]{2,3})(_([A-Z]{2,3}))?\.json$/;

    /**
     * Cap on per-culture missing-key listing in text output to avoid
     * runaway logs. JSON output has no cap.
     *
     * @inner
     * @constant
     * @type {number}
     */
    var TEXT_MISSING_CAP = 50;

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

        var bundleFilter = self.name || null;

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            if (bundleFilter) {
                console.error('`i18n:scan <bundle>` requires `@<project>`. Did you forget `@<project_name>`?');
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
            var manifest = loadManifest(self.projects[self.projectName].path);
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

    /**
     * Reads a JSON file with comment tolerance via `requireJSON`. Returns
     * `null` on any I/O or parse error so callers can choose how to
     * surface the failure.
     *
     * @inner
     * @private
     * @param {string} filePath
     * @returns {object|null}
     */
    var readJsonSafe = function (filePath) {
        try {
            if ( !fs.existsSync(filePath) ) return null;
            return requireJSON(filePath);
        } catch (e) {
            return null;
        }
    };

    /**
     * Loads `<projectPath>/manifest.json`. Returns `null` on failure so
     * the caller can choose how to report.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @returns {object|null}
     */
    var loadManifest = function (projectPath) {
        return readJsonSafe(_(projectPath + '/manifest.json', true));
    };

    /**
     * Recursive file walker — returns absolute paths of every JS or
     * template file under `dir` whose ancestor chain is not in
     * `EXCLUDE_DIRS`. Uses an explicit stack to avoid deep recursion.
     *
     * @inner
     * @private
     * @param {string} dir - Absolute directory to walk
     * @returns {string[]}
     */
    var walkSourceFiles = function (dir) {
        var out = [];
        if ( !fs.existsSync(dir) ) return out;
        var stack = [dir];
        while (stack.length) {
            var cur = stack.pop();
            var entries;
            try {
                entries = fs.readdirSync(cur, { withFileTypes: true });
            } catch (e) {
                continue;
            }
            for (var i = 0; i < entries.length; i++) {
                var ent = entries[i];
                var p   = path.join(cur, ent.name);
                if (ent.isDirectory()) {
                    if ( EXCLUDE_DIRS[ent.name] ) continue;
                    if ( ent.name.charAt(0) === '.' ) continue;
                    stack.push(p);
                } else if (ent.isFile()) {
                    if ( JS_EXT.test(ent.name) || TEMPLATE_EXT.test(ent.name) ) {
                        out.push(p);
                    }
                }
            }
        }
        return out;
    };

    /**
     * Extracts every translation key found in a single source file.
     * Lines are 1-based to match common editor conventions.
     *
     * @inner
     * @private
     * @param {string} filePath
     * @returns {Array<{key: string, line: number}>}
     */
    var extractKeysFromFile = function (filePath) {
        var raw;
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            return [];
        }
        var lines = raw.split(/\r?\n/);
        var hits  = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            extractFromLine(line, T_CALL_RE,      hits, i + 1);
            extractFromLine(line, LEGACY_CALL_RE, hits, i + 1);
            extractFromLine(line, TEMPLATE_T_RE,  hits, i + 1);
        }
        return hits;
    };

    /**
     * Pushes every regex match against `line` into `out` with the given
     * line number. Resets `re.lastIndex` so the regex is reusable.
     *
     * @inner
     * @private
     * @param {string} line
     * @param {RegExp} re
     * @param {Array} out
     * @param {number} lineNo
     */
    var extractFromLine = function (line, re, out, lineNo) {
        re.lastIndex = 0;
        var m;
        while ( (m = re.exec(line)) !== null ) {
            out.push({ key: m[1], line: lineNo });
        }
    };

    /**
     * Returns the sorted list of culture codes present in
     * `<bundlePath>/locales/`.
     *
     * @inner
     * @private
     * @param {string} bundlePath
     * @returns {string[]}
     */
    var listBundleCultures = function (bundlePath) {
        var dir = path.join(bundlePath, 'locales');
        if ( !fs.existsSync(dir) ) return [];
        var entries;
        try { entries = fs.readdirSync(dir); } catch (e) { return []; }
        var out = [];
        for (var i = 0; i < entries.length; i++) {
            var name  = entries[i];
            var match = CULTURE_RE.exec(name);
            if (!match) continue;
            out.push(match[3] ? (match[1] + '_' + match[3]) : match[1]);
        }
        out.sort();
        return out;
    };

    /**
     * Builds a full coverage report for one bundle.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string} bundleName
     * @returns {{bundle:string, totalKeys:number, cultures:string[], byKey:object, coverage:object}}
     */
    var scanBundle = function (projectPath, bundleName) {
        var bundlePath = path.join(projectPath, bundleName);
        var files      = collectFiles(bundlePath);
        var byKey      = collectKeys(files, bundlePath);
        var keys       = Object.keys(byKey).sort();
        var cultures   = listBundleCultures(bundlePath);
        var catalogs   = Object.create(null);
        for (var c = 0; c < cultures.length; c++) {
            var catalogPath = path.join(bundlePath, 'locales', cultures[c] + '.json');
            catalogs[cultures[c]] = readJsonSafe(catalogPath) || {};
        }

        var coverage = Object.create(null);
        for (var ci = 0; ci < cultures.length; ci++) {
            coverage[cultures[ci]] = computeCoverage(catalogs[cultures[ci]], keys);
        }

        return {
            bundle    : bundleName,
            totalKeys : keys.length,
            cultures  : cultures,
            byKey     : byKey,
            coverage  : coverage
        };
    };

    /**
     * Walks every `SOURCE_DIRS` subdir under `bundlePath` plus top-level
     * `.js` files at the bundle root.
     *
     * @inner
     * @private
     * @param {string} bundlePath
     * @returns {string[]}
     */
    var collectFiles = function (bundlePath) {
        var files = [];
        for (var i = 0; i < SOURCE_DIRS.length; i++) {
            var sub = path.join(bundlePath, SOURCE_DIRS[i]);
            files = files.concat(walkSourceFiles(sub));
        }
        try {
            var topEntries = fs.readdirSync(bundlePath, { withFileTypes: true });
            for (var j = 0; j < topEntries.length; j++) {
                if (topEntries[j].isFile() && JS_EXT.test(topEntries[j].name)) {
                    files.push(path.join(bundlePath, topEntries[j].name));
                }
            }
        } catch (e) {}
        return files;
    };

    /**
     * Aggregates `extractKeysFromFile` over a file list into a
     * `{ <key>: [{file, line}, ...] }` map. File paths are bundle-relative.
     *
     * @inner
     * @private
     * @param {string[]} files
     * @param {string} bundlePath
     * @returns {Object<string, Array<{file:string, line:number}>>}
     */
    var collectKeys = function (files, bundlePath) {
        var byKey = Object.create(null);
        for (var k = 0; k < files.length; k++) {
            var hits = extractKeysFromFile(files[k]);
            var rel  = path.relative(bundlePath, files[k]);
            for (var h = 0; h < hits.length; h++) {
                if ( !byKey[hits[h].key] ) {
                    byKey[hits[h].key] = [];
                }
                byKey[hits[h].key].push({ file: rel, line: hits[h].line });
            }
        }
        return byKey;
    };

    /**
     * Computes per-culture coverage stats given a catalog and the union
     * of keys used in source. Coverage walks `lib.i18n.resolveKey` so
     * dotted-path keys (`common.welcome`) resolve correctly.
     *
     * @inner
     * @private
     * @param {object} catalog
     * @param {string[]} keys
     * @returns {{translated:number, missing:number, percent:number, missingKeys:string[]}}
     */
    var computeCoverage = function (catalog, keys) {
        var hit  = 0;
        var miss = [];
        for (var i = 0; i < keys.length; i++) {
            if ( typeof i18n.resolveKey(catalog, keys[i]) !== 'undefined' ) {
                hit++;
            } else {
                miss.push(keys[i]);
            }
        }
        return {
            translated : hit,
            missing    : miss.length,
            percent    : keys.length === 0 ? 100 : Math.round((hit / keys.length) * 1000) / 10,
            missingKeys: miss
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
            var pp = self.projects[names[i]];
            var mf = loadManifest(pp.path);
            if (!mf || !mf.bundles) continue;
            var entry  = { project: names[i], bundles: [] };
            var bnames = Object.keys(mf.bundles).sort();
            for (var b = 0; b < bnames.length; b++) {
                entry.bundles.push(scanBundle(pp.path, bnames[b]));
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
        var project  = self.projects[projectName];
        var manifest = loadManifest(project.path);
        if (!manifest || !manifest.bundles) {
            console.error('Project @' + projectName + ' has no manifest.json or no bundles registered.');
            process.exit(1);
            return;
        }
        var bundles = Object.keys(manifest.bundles).sort();
        var report  = { project: projectName, bundles: [] };
        for (var i = 0; i < bundles.length; i++) {
            report.bundles.push(scanBundle(project.path, bundles[i]));
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
        var report  = { project: projectName, bundles: [scanBundle(project.path, bundleName)] };
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
            console.log('\n@' + proj.project + ':');
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
     * Renders one bundle's coverage block.
     *
     * @inner
     * @private
     * @param {object} br - One bundle report from `scanBundle`
     */
    var emitTextBundle = function (br) {
        console.log('  ' + br.bundle + ':');
        if (br.cultures.length === 0) {
            console.log('    No catalogs found at bundle/locales/. '
                + 'Run `gina i18n:add <culture> ' + br.bundle + ' @<project>` to seed one.');
            return;
        }
        if (br.totalKeys === 0) {
            console.log('    No translation keys found in source.');
            return;
        }
        console.log('    Cultures: ' + br.cultures.join(', '));
        console.log('    Coverage:');
        for (var c = 0; c < br.cultures.length; c++) {
            var cult = br.cultures[c];
            var cov  = br.coverage[cult];
            console.log('      ' + padRight(cult, 8)
                + ' [' + padLeft(cov.percent + '%', 6) + ']  '
                + cov.translated + '/' + br.totalKeys + ' keys'
                + (cov.missing > 0 ? '  (' + cov.missing + ' missing)' : ''));
        }
        for (var c2 = 0; c2 < br.cultures.length; c2++) {
            var cu = br.cultures[c2];
            var cv = br.coverage[cu];
            if (cv.missing === 0) continue;
            console.log('    Missing in ' + cu + ':');
            var cap = Math.min(cv.missingKeys.length, TEXT_MISSING_CAP);
            for (var m = 0; m < cap; m++) {
                console.log('      - ' + cv.missingKeys[m]);
            }
            if (cv.missingKeys.length > TEXT_MISSING_CAP) {
                console.log('      ... (' + (cv.missingKeys.length - TEXT_MISSING_CAP) + ' more)');
            }
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

    /**
     * Left-pads `s` with spaces to reach `n` characters.
     *
     * @inner
     * @private
     * @param {string} s
     * @param {number} n
     * @returns {string}
     */
    var padLeft = function (s, n) {
        var o = String(s || '');
        while (o.length < n) o = ' ' + o;
        return o;
    };

    init();
}

module.exports = Scan;
