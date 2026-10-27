var fs      = require('fs');
var path    = require('path');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/i18n/add
 */
/**
 * Seeds a new culture catalog at `<bundle>/locales/<culture>.json` by
 * copying the structure of an existing source culture and prefixing every
 * string value with `[TODO] `. Translators replace the prefixed values in
 * place; `gina i18n:scan` reports the remaining gap.
 *
 * Usage:
 *  gina i18n:add <culture> @<project>
 *  gina i18n:add <culture> <bundle> @<project>
 *  gina i18n:add fr @<project> --from=en
 *  gina i18n:add ja_JP <bundle> @<project> --force
 *
 * Source-culture resolution order (per bundle):
 *   1. `--from=<culture>` flag
 *   2. `<bundle>/config/settings.json > region.culture`
 *   3. `process.env.GINA_CULTURE`
 *   4. `'en'` (last resort)
 *
 * Refuses to overwrite an existing target catalog unless `--force`. With
 * `--dry-run`, prints what would be written and exits without touching the
 * disk. Creates `<bundle>/locales/` if it does not exist.
 *
 * @class Add
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Add(opt, cmd) {
    var self = { from: null, force: false, dryRun: false };

    /**
     * Marker prepended to every string value when seeding a new catalog,
     * so translators can grep / search-replace through the file.
     *
     * @inner
     * @constant
     * @type {string}
     */
    var TODO_PREFIX = '[TODO] ';

    /**
     * Last-resort source culture when neither `--from`, the bundle's
     * `settings.region.culture`, nor `GINA_CULTURE` is set.
     *
     * @inner
     * @constant
     * @type {string}
     */
    var DEFAULT_FALLBACK_CULTURE = 'en';

    /**
     * Culture-string shape: `<lang>` or `<lang>_<REGION>`. Mirrors
     * `lib/i18n/src/main.js CULTURE_FILENAME` (filename form is the same
     * pattern with `.json` suffix).
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var CULTURE_RE = /^[a-z]{2,3}(_[A-Z]{2,3})?$/;

    /**
     * Parses positionals + flags via CmdHelper, validates the target
     * culture, dispatches to the project-wide or bundle-scoped seeder,
     * and exits.
     *
     * @inner
     * @private
     */
    var init = function () {
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        var positionals = extractPositionals(process.argv);
        var culture     = positionals[0] || null;
        var bundleArg   = positionals[1] || null;

        if (!culture) {
            console.error('Missing <culture> argument. Usage: gina i18n:add <culture> [<bundle>] @<project>');
            process.exit(1);
            return;
        }
        if ( !CULTURE_RE.test(culture) ) {
            console.error('Invalid culture `' + culture + '` — expected <lang> or <lang>_<REGION> (e.g. en, en_US, pt_BR).');
            process.exit(1);
            return;
        }

        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            if ( /^\-\-from\=/.test(arg) ) {
                self.from = arg.split(/\=/)[1] || null;
            } else if (arg === '--force') {
                self.force = true;
            } else if (arg === '--dry-run') {
                self.dryRun = true;
            }
        }

        if ( self.from && !CULTURE_RE.test(self.from) ) {
            console.error('Invalid --from culture `' + self.from + '` — expected <lang> or <lang>_<REGION>.');
            process.exit(1);
            return;
        }

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            console.error('`i18n:add <culture>` requires `@<project>`. Did you forget `@<project_name>`?');
            process.exit(1);
            return;
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('Project @' + self.projectName + ' is not registered. Run `gina project:list` to see registered projects.');
            process.exit(1);
            return;
        }

        // CmdHelper sets self.name from the first non-flag positional, which
        // for us is always the <culture> token. The optional <bundle> sits at
        // positionals[1].
        var bundleName = bundleArg;
        if (bundleName) {
            var manifest = loadManifest(self.projects[self.projectName].path);
            if (manifest && manifest.bundles && !manifest.bundles[bundleName]) {
                console.error('Bundle [ ' + bundleName + ' ] is not registered inside `@' + self.projectName + '`.');
                process.exit(1);
                return;
            }
            addBundleOnly(self.projectName, bundleName, culture);
        } else {
            addProjectOnly(self.projectName, culture);
        }

        process.exit(0);
    };

    /**
     * Pulls every non-flag, non-`@<project>` token from argv. Mirrors the
     * `connector:add` extractPositionals.
     *
     * @inner
     * @private
     * @param {string[]} argv
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
     * Reads a JSON file with comment tolerance via `requireJSON`.
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

    var loadManifest = function (projectPath) {
        return readJsonSafe(_(projectPath + '/manifest.json', true));
    };

    /**
     * Resolves the source culture for a bundle. Order: `--from`, then the
     * bundle's `config/settings.json > region.culture`, then
     * `GINA_CULTURE`, then `'en'`.
     *
     * @inner
     * @private
     * @param {string} bundlePath
     * @returns {string}
     */
    var resolveSourceCulture = function (bundlePath) {
        if (self.from) return self.from;
        var settingsPath = path.join(bundlePath, 'config', 'settings.json');
        var settings     = readJsonSafe(settingsPath);
        if (settings && settings.region && settings.region.culture) {
            return String(settings.region.culture);
        }
        if (typeof getEnvVar === 'function' && getEnvVar('GINA_CULTURE')) {
            return String(getEnvVar('GINA_CULTURE'));
        }
        return DEFAULT_FALLBACK_CULTURE;
    };

    /**
     * Recursively transforms a source catalog into a seed for a new
     * culture: every string value is prefixed with `TODO_PREFIX`; nested
     * objects + plural-form objects are walked depth-first; non-string,
     * non-object leaves (numbers, booleans, null) are passed through
     * unchanged. Arrays are passed through as-is — catalog values aren't
     * arrays in the documented shape.
     *
     * @memberof module:gina/lib/cmd/i18n/add
     * @param {*} source
     * @returns {*}
     */
    var seedCatalog = function (source) {
        if (typeof source === 'string') {
            return TODO_PREFIX + source;
        }
        if (source === null || typeof source !== 'object' || Array.isArray(source)) {
            return source;
        }
        var out  = {};
        var keys = Object.keys(source);
        for (var i = 0; i < keys.length; i++) {
            out[keys[i]] = seedCatalog(source[keys[i]]);
        }
        return out;
    };

    /**
     * Seeds one bundle's target-culture catalog. Returns true on success
     * (or successful dry-run), false on any error condition that should
     * not abort sibling bundles.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string} bundleName
     * @param {string} culture
     * @returns {boolean}
     */
    var addBundle = function (projectPath, bundleName, culture) {
        var bundlePath    = path.join(projectPath, bundleName);
        var sourceCulture = resolveSourceCulture(bundlePath);
        var sourcePath    = path.join(bundlePath, 'locales', sourceCulture + '.json');
        var targetPath    = path.join(bundlePath, 'locales', culture + '.json');

        if (sourceCulture === culture) {
            console.error('[' + bundleName + '] source culture `' + sourceCulture + '` is the same as the target — pass --from=<other> to seed from a different culture.');
            return false;
        }

        if ( !fs.existsSync(sourcePath) ) {
            console.error('[' + bundleName + '] no source catalog at ' + sourcePath
                + ' (try --from=<culture> to point at a different source).');
            return false;
        }

        var sourceData;
        try {
            sourceData = requireJSON(sourcePath);
        } catch (e) {
            console.error('[' + bundleName + '] cannot parse source catalog ' + sourcePath + ': ' + e.message);
            return false;
        }
        if ( sourceData === null || typeof sourceData !== 'object' || Array.isArray(sourceData) ) {
            console.error('[' + bundleName + '] source catalog root must be an object: ' + sourcePath);
            return false;
        }

        if ( fs.existsSync(targetPath) && !self.force ) {
            console.error('[' + bundleName + '] target catalog already exists at ' + targetPath
                + ' — re-run with --force to overwrite.');
            return false;
        }

        var targetData = seedCatalog(sourceData);
        var body       = JSON.stringify(targetData, null, 4) + '\n';

        if (self.dryRun) {
            console.log('[' + bundleName + '] [dry-run] would write '
                + targetPath + ' (' + body.length + ' bytes; source: ' + sourceCulture + ')');
            return true;
        }

        var localesDir = path.join(bundlePath, 'locales');
        if ( !fs.existsSync(localesDir) ) {
            try {
                fs.mkdirSync(localesDir, { recursive: true });
            } catch (e) {
                console.error('[' + bundleName + '] cannot create ' + localesDir + ': ' + e.message);
                return false;
            }
        }

        try {
            lib.generator.createFileFromDataSync(body, targetPath);
        } catch (e) {
            console.error('[' + bundleName + '] cannot write ' + targetPath + ': ' + e.message);
            return false;
        }
        console.log('[' + bundleName + '] created ' + targetPath + ' (source: ' + sourceCulture + ')');
        return true;
    };

    /**
     * Seeds the target culture across every bundle declared in the
     * project's manifest.
     *
     * @inner
     * @private
     * @param {string} projectName
     * @param {string} culture
     */
    var addProjectOnly = function (projectName, culture) {
        var project  = self.projects[projectName];
        var manifest = loadManifest(project.path);
        if (!manifest || !manifest.bundles) {
            console.error('Project @' + projectName + ' has no manifest.json or no bundles registered.');
            process.exit(1);
            return;
        }
        var bundles = Object.keys(manifest.bundles).sort();
        if (bundles.length === 0) {
            console.error('Project @' + projectName + ' has no bundles in manifest.json.');
            process.exit(1);
            return;
        }
        var ok = 0;
        var fail = 0;
        for (var i = 0; i < bundles.length; i++) {
            var r = addBundle(project.path, bundles[i], culture);
            if (r) ok++; else fail++;
        }
        console.log('\n@' + projectName + ': ' + ok + ' bundle(s) seeded, ' + fail + ' skipped.');
    };

    /**
     * Seeds the target culture in a single bundle.
     *
     * @inner
     * @private
     * @param {string} projectName
     * @param {string} bundleName
     * @param {string} culture
     */
    var addBundleOnly = function (projectName, bundleName, culture) {
        var project = self.projects[projectName];
        var ok = addBundle(project.path, bundleName, culture);
        if (!ok) {
            process.exit(1);
            return;
        }
    };

    init();
}

module.exports = Add;
