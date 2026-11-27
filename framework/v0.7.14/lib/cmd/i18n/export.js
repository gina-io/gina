var fs      = require('fs');
var path    = require('path');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/i18n/export
 */
/**
 * Exports a culture's catalog from a project's bundle(s) into a single
 * file or stdout, in JSON / PO / CSV format. Translators run their
 * tooling against the exported file, then round-trip the result back via
 * `gina i18n:import`.
 *
 * Usage:
 *  gina i18n:export <culture> @<project>
 *  gina i18n:export <culture> <bundle> @<project> --format=po
 *  gina i18n:export <culture> @<project> --format=csv --output=/tmp/translations.csv
 *
 * Format defaults:
 *  - When `--format` is omitted, the format is auto-detected from
 *    `--output`'s extension (`.po`, `.csv`, `.json`).
 *  - When neither `--format` nor `--output` is given, defaults to JSON
 *    on stdout.
 *
 * Multi-bundle scoping (no `<bundle>` positional) emits a single combined
 * output:
 *  - JSON: `{ "<bundle>": { ...catalog }, ... }` wrapper.
 *  - PO:   each entry carries `msgctxt "<bundle>"` for disambiguation.
 *  - CSV:  the leading `bundle` column is added to the header row and
 *          every data row.
 *
 * Plural forms emit native PO syntax (`msgid_plural` + `msgstr[N]`) with
 * a `#. cldr-keys: <list>` extracted comment recording the present CLDR
 * plural keys in order, so `gina i18n:import` reconstructs the catalog
 * shape unambiguously regardless of the target culture's plural rules.
 * CSV plural entries flatten to dotted-suffix rows (`key.one`, `key.other`).
 *
 * @class Export
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Export(opt, cmd) {
    var self = { format: null, output: null };

    var i18n = lib.i18n;

    /**
     * Default format when `--format` is omitted and `--output`'s extension
     * does not narrow it.
     *
     * @inner
     * @constant
     * @type {string}
     */
    var DEFAULT_FORMAT = 'json';

    /**
     * Allowed `--format` values.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var ALLOWED_FORMATS = ['json', 'po', 'csv'];

    /**
     * Culture-string shape (`<lang>` or `<lang>_<REGION>`). Mirrors
     * `lib/i18n/src/main.js CULTURE_FILENAME` (filename form is the same
     * pattern with `.json` suffix).
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var CULTURE_RE = /^[a-z]{2,3}(_[A-Z]{2,3})?$/;

    /**
     * CLDR plural categories — same source-of-truth as `lib/i18n` exports.
     * Pinned here so the formatter can iterate plural keys in a stable
     * order without re-reading the i18n module's constant.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var CLDR_PLURAL_KEYS = ['zero', 'one', 'two', 'few', 'many', 'other'];

    /**
     * Per-culture `Plural-Forms` formula table for the PO header. Keys are
     * `<lang>` or `<lang>_<REGION>`; the resolver falls back to base
     * language, then to a generic Romance/Germanic 2-form formula.
     * Translators with locale-specific tooling typically override the
     * formula post-export — the default keeps PO files valid for editor
     * tooling that requires the header.
     *
     * @inner
     * @constant
     * @type {Object<string, string>}
     */
    var PLURAL_FORMS_TABLE = {
        'en'    : 'nplurals=2; plural=(n != 1);',
        'fr'    : 'nplurals=2; plural=(n > 1);',
        'pt_BR' : 'nplurals=2; plural=(n > 1);',
        'pt'    : 'nplurals=2; plural=(n != 1);',
        'es'    : 'nplurals=2; plural=(n != 1);',
        'it'    : 'nplurals=2; plural=(n != 1);',
        'de'    : 'nplurals=2; plural=(n != 1);',
        'nl'    : 'nplurals=2; plural=(n != 1);',
        'sv'    : 'nplurals=2; plural=(n != 1);',
        'ru'    : 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
        'pl'    : 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
        'cs'    : 'nplurals=3; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2;',
        'ja'    : 'nplurals=1; plural=0;',
        'zh'    : 'nplurals=1; plural=0;',
        'ko'    : 'nplurals=1; plural=0;',
        'ar'    : 'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);'
    };

    /**
     * Last-resort `Plural-Forms` formula — Romance/Germanic 2-form.
     *
     * @inner
     * @constant
     * @type {string}
     */
    var DEFAULT_PLURAL_FORMS = 'nplurals=2; plural=(n != 1);';

    /**
     * Parses positionals + flags via CmdHelper, validates culture + format,
     * dispatches to the project-wide or bundle-scoped exporter, and exits.
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
            console.error('Missing <culture> argument. Usage: gina i18n:export <culture> [<bundle>] @<project> [--format=<json|po|csv>] [--output=<path>]');
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
            if ( /^\-\-format\=/.test(arg) ) {
                self.format = arg.split(/\=/)[1] || null;
            } else if ( /^\-\-output\=/.test(arg) ) {
                self.output = arg.split(/\=/)[1] || null;
            }
        }

        if (!self.format && self.output) {
            self.format = detectFormatFromPath(self.output);
        }
        if (!self.format) {
            self.format = DEFAULT_FORMAT;
        }
        if ( ALLOWED_FORMATS.indexOf(self.format) < 0 ) {
            console.error('--format must be `json`, `po`, or `csv` (got `' + self.format + '`).');
            process.exit(1);
            return;
        }

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            console.error('`i18n:export <culture>` requires `@<project>`. Did you forget `@<project_name>`?');
            process.exit(1);
            return;
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('Project @' + self.projectName + ' is not registered. Run `gina project:list` to see registered projects.');
            process.exit(1);
            return;
        }

        var bundleName = bundleArg;
        if (bundleName) {
            var manifest = loadManifest(self.projects[self.projectName].path);
            if (manifest && manifest.bundles && !manifest.bundles[bundleName]) {
                console.error('Bundle [ ' + bundleName + ' ] is not registered inside `@' + self.projectName + '`.');
                process.exit(1);
                return;
            }
            exportBundleOnly(self.projectName, bundleName, culture);
        } else {
            exportProjectOnly(self.projectName, culture);
        }

        process.exit(0);
    };

    /**
     * Pulls every non-flag, non-`@<project>` token from argv. Mirrors the
     * `i18n:add` extractPositionals.
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
     * Loads `<projectPath>/manifest.json`. Returns `null` on failure so the
     * caller can choose how to report.
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
     * Auto-detects format from the output file extension. Returns `null`
     * when the extension is unrecognised so the caller falls back to
     * `DEFAULT_FORMAT`.
     *
     * @memberof module:gina/lib/cmd/i18n/export
     * @param   {string} outputPath
     * @returns {string|null}
     *
     * @example
     *   detectFormatFromPath('/tmp/fr.po');           // → 'po'
     *   detectFormatFromPath('/tmp/translations.csv'); // → 'csv'
     *   detectFormatFromPath('/tmp/fr.json');         // → 'json'
     *   detectFormatFromPath('/tmp/fr.txt');          // → null
     */
    var detectFormatFromPath = function (outputPath) {
        var ext = path.extname(String(outputPath || '')).toLowerCase();
        if (ext === '.po')   return 'po';
        if (ext === '.csv')  return 'csv';
        if (ext === '.json') return 'json';
        return null;
    };

    /**
     * Walks a nested catalog producing flat dotted-key entries. Plural-form
     * objects (detected via `lib.i18n.isPluralForm`) emit a single grouped
     * entry; the formatter decides per-format how to serialise the plural
     * shape. Non-string, non-object leaves are dropped (catalogs do not
     * declare them in the documented shape).
     *
     * @memberof module:gina/lib/cmd/i18n/export
     * @param   {object} catalog
     * @param   {string} [bundleName] - Stamped onto every entry when present (multi-bundle export).
     * @returns {Array<{bundle:string|null, key:string, value:string|null, plural:object|null}>}
     */
    var flattenCatalog = function (catalog, bundleName) {
        var out = [];
        var stamp = (typeof bundleName === 'string' && bundleName.length > 0) ? bundleName : null;
        function walk(prefix, node) {
            if (node === null || typeof node !== 'object' || Array.isArray(node)) {
                if (typeof node === 'string' && prefix) {
                    out.push({ bundle: stamp, key: prefix, value: node, plural: null });
                }
                return;
            }
            if (i18n.isPluralForm(node)) {
                if (prefix) {
                    out.push({ bundle: stamp, key: prefix, value: null, plural: node });
                }
                return;
            }
            var keys = Object.keys(node);
            for (var i = 0; i < keys.length; i++) {
                var k    = keys[i];
                var next = prefix ? (prefix + '.' + k) : k;
                walk(next, node[k]);
            }
        }
        walk('', catalog || {});
        return out;
    };

    /**
     * Returns the `Plural-Forms` formula for a culture's PO header. Lookup
     * order: exact match → base language → `DEFAULT_PLURAL_FORMS`.
     *
     * @memberof module:gina/lib/cmd/i18n/export
     * @param   {string} culture
     * @returns {string}
     */
    var pluralFormsFor = function (culture) {
        var c = String(culture || '');
        if ( PLURAL_FORMS_TABLE[c] ) return PLURAL_FORMS_TABLE[c];
        var base = c.split('_')[0];
        if ( PLURAL_FORMS_TABLE[base] ) return PLURAL_FORMS_TABLE[base];
        return DEFAULT_PLURAL_FORMS;
    };

    /**
     * Quotes a string for inclusion in a PO `msgid` / `msgstr` value.
     * Backslash, double-quote, newline, tab, carriage return are escaped.
     * Other control characters pass through; the caller is responsible
     * for keeping translations free of unsupported control bytes.
     *
     * @memberof module:gina/lib/cmd/i18n/export
     * @param   {string} str
     * @returns {string}
     *
     * @example
     *   poQuote('Hello, "world"!');  // → '"Hello, \"world\"!"'
     *   poQuote('Line 1\nLine 2');   // → '"Line 1\\nLine 2"'
     */
    var poQuote = function (str) {
        var s = String(str == null ? '' : str);
        s = s
            .replace(/\\/g, '\\\\')
            .replace(/"/g,  '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\t/g, '\\t')
            .replace(/\r/g, '\\r');
        return '"' + s + '"';
    };

    /**
     * Quotes a CSV cell per RFC 4180 — wraps in double-quotes and doubles
     * any existing quote when the cell contains a comma, double-quote,
     * newline, carriage return, or leading/trailing whitespace.
     *
     * @memberof module:gina/lib/cmd/i18n/export
     * @param   {string} str
     * @returns {string}
     *
     * @example
     *   csvQuote('plain');             // → 'plain'
     *   csvQuote('has,comma');         // → '"has,comma"'
     *   csvQuote('has "quote"');       // → '"has ""quote"""'
     *   csvQuote('multi\nline');       // → '"multi\nline"'
     */
    var csvQuote = function (str) {
        var s = String(str == null ? '' : str);
        if ( /[",\r\n]|^\s|\s$/.test(s) ) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    };

    /**
     * Serialises a catalog (or set of catalogs) as JSON. Multi-bundle
     * exports nest under bundle names; single-bundle exports emit the
     * catalog directly so the file matches the on-disk shape verbatim.
     *
     * @memberof module:gina/lib/cmd/i18n/export
     * @param   {object} data
     * @returns {string}
     */
    var formatJSON = function (data) {
        return JSON.stringify(data, null, 4) + '\n';
    };

    /**
     * Serialises flat entries as a PO file with a header block, one entry
     * per `msgid`/`msgstr` pair, and native `msgid_plural` + `msgstr[N]`
     * for plural forms. A `#. cldr-keys: <list>` extracted comment records
     * the present CLDR plural keys in order so `i18n:import` reconstructs
     * the catalog shape unambiguously across cultures with differing
     * plural categories.
     *
     * @memberof module:gina/lib/cmd/i18n/export
     * @param   {Array<{bundle:string|null, key:string, value:string|null, plural:object|null}>} entries
     * @param   {string} culture
     * @returns {string}
     */
    var formatPO = function (entries, culture) {
        var out = [];
        out.push('msgid ""');
        out.push('msgstr ""');
        out.push('"Project-Id-Version: gina-i18n-export\\n"');
        out.push('"Content-Type: text/plain; charset=UTF-8\\n"');
        out.push('"Content-Transfer-Encoding: 8bit\\n"');
        out.push('"Language: ' + String(culture || '') + '\\n"');
        out.push('"Plural-Forms: ' + pluralFormsFor(culture) + '\\n"');
        out.push('');

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.plural) {
                var presentKeys = [];
                for (var j = 0; j < CLDR_PLURAL_KEYS.length; j++) {
                    var k = CLDR_PLURAL_KEYS[j];
                    if ( typeof e.plural[k] === 'string' ) {
                        presentKeys.push(k);
                    }
                }
                out.push('#. cldr-keys: ' + presentKeys.join(','));
                if (e.bundle) {
                    out.push('msgctxt ' + poQuote(e.bundle));
                }
                out.push('msgid '        + poQuote(e.key));
                out.push('msgid_plural ' + poQuote(e.key + '.plural'));
                for (var n = 0; n < presentKeys.length; n++) {
                    out.push('msgstr[' + n + '] ' + poQuote(e.plural[presentKeys[n]]));
                }
            } else {
                if (e.bundle) {
                    out.push('msgctxt ' + poQuote(e.bundle));
                }
                out.push('msgid '  + poQuote(e.key));
                out.push('msgstr ' + poQuote(e.value));
            }
            out.push('');
        }
        return out.join('\n');
    };

    /**
     * Serialises flat entries as RFC 4180 CSV. Plural forms flatten to
     * dotted-suffix rows (`<key>.<cldr-cat>`), one row per CLDR category
     * present. Multi-bundle exports add a leading `bundle` column.
     *
     * @memberof module:gina/lib/cmd/i18n/export
     * @param   {Array<{bundle:string|null, key:string, value:string|null, plural:object|null}>} entries
     * @param   {boolean} includeBundle
     * @returns {string}
     */
    var formatCSV = function (entries, includeBundle) {
        var out = [];
        out.push(includeBundle ? 'bundle,key,value' : 'key,value');
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.plural) {
                for (var j = 0; j < CLDR_PLURAL_KEYS.length; j++) {
                    var k = CLDR_PLURAL_KEYS[j];
                    if ( typeof e.plural[k] === 'string' ) {
                        var pkey = e.key + '.' + k;
                        if (includeBundle) {
                            out.push(csvQuote(e.bundle || '') + ',' + csvQuote(pkey) + ',' + csvQuote(e.plural[k]));
                        } else {
                            out.push(csvQuote(pkey) + ',' + csvQuote(e.plural[k]));
                        }
                    }
                }
            } else {
                if (includeBundle) {
                    out.push(csvQuote(e.bundle || '') + ',' + csvQuote(e.key) + ',' + csvQuote(e.value));
                } else {
                    out.push(csvQuote(e.key) + ',' + csvQuote(e.value));
                }
            }
        }
        return out.join('\n') + '\n';
    };

    /**
     * Reads a single bundle's catalog for the requested culture. Returns
     * `null` when the catalog file is missing or unparseable so the caller
     * can warn / skip.
     *
     * @inner
     * @private
     * @param {string} bundlePath
     * @param {string} culture
     * @returns {object|null}
     */
    var readCatalog = function (bundlePath, culture) {
        var catalogPath = path.join(bundlePath, 'locales', culture + '.json');
        if ( !fs.existsSync(catalogPath) ) return null;
        var data = readJsonSafe(catalogPath);
        if ( data === null || typeof data !== 'object' || Array.isArray(data) ) {
            return null;
        }
        return data;
    };

    /**
     * Writes the serialised body to stdout (when `self.output` is null) or
     * to a file via `lib.generator.createFileFromDataSync`. Confirms the
     * parent directory exists first when writing to a file.
     *
     * @inner
     * @private
     * @param {string} body
     */
    var emit = function (body) {
        if ( !self.output ) {
            console.log(body);
            return;
        }
        var target = path.isAbsolute(self.output)
            ? self.output
            : _(process.cwd() + '/' + self.output, true);
        var parentDir = path.dirname(target);
        if ( !fs.existsSync(parentDir) ) {
            console.error('Output directory does not exist: `' + parentDir + '`.');
            process.exit(1);
            return;
        }
        try {
            lib.generator.createFileFromDataSync(body, target);
        } catch (e) {
            console.error('Cannot write ' + target + ': ' + e.message);
            process.exit(1);
            return;
        }
        console.log('[' + self.format + '] wrote ' + target + ' (' + body.length + ' bytes)');
    };

    /**
     * Exports a single bundle's catalog. Errors when the catalog is
     * missing — single-bundle scope cannot silently no-op the way
     * project-wide does.
     *
     * @inner
     * @private
     * @param {string} projectName
     * @param {string} bundleName
     * @param {string} culture
     */
    var exportBundleOnly = function (projectName, bundleName, culture) {
        var project    = self.projects[projectName];
        var bundlePath = path.join(project.path, bundleName);
        var catalog    = readCatalog(bundlePath, culture);
        if ( !catalog ) {
            console.error('[' + bundleName + '] no catalog at ' + path.join(bundlePath, 'locales', culture + '.json')
                + ' — run `gina i18n:add ' + culture + ' ' + bundleName + ' @' + projectName + '` first.');
            process.exit(1);
            return;
        }

        var body;
        if (self.format === 'json') {
            body = formatJSON(catalog);
        } else if (self.format === 'po') {
            body = formatPO(flattenCatalog(catalog, null), culture);
        } else {
            body = formatCSV(flattenCatalog(catalog, null), false);
        }
        emit(body);
    };

    /**
     * Exports every bundle's catalog for the requested culture. Bundles
     * without a matching catalog are skipped with a warning. Output is a
     * single combined file/stream regardless of bundle count.
     *
     * @inner
     * @private
     * @param {string} projectName
     * @param {string} culture
     */
    var exportProjectOnly = function (projectName, culture) {
        var project  = self.projects[projectName];
        var manifest = loadManifest(project.path);
        if ( !manifest || !manifest.bundles ) {
            console.error('Project @' + projectName + ' has no manifest.json or no bundles registered.');
            process.exit(1);
            return;
        }
        var bundles = Object.keys(manifest.bundles).sort();
        if ( bundles.length === 0 ) {
            console.error('Project @' + projectName + ' has no bundles in manifest.json.');
            process.exit(1);
            return;
        }

        var jsonOut = {};
        var allEntries = [];
        var seen = 0;
        for (var i = 0; i < bundles.length; i++) {
            var b          = bundles[i];
            var bundlePath = path.join(project.path, b);
            var catalog    = readCatalog(bundlePath, culture);
            if ( !catalog ) {
                console.error('[' + b + '] skipped — no catalog at ' + path.join(bundlePath, 'locales', culture + '.json'));
                continue;
            }
            seen++;
            if (self.format === 'json') {
                jsonOut[b] = catalog;
            } else {
                var entries = flattenCatalog(catalog, b);
                for (var j = 0; j < entries.length; j++) {
                    allEntries.push(entries[j]);
                }
            }
        }
        if ( seen === 0 ) {
            console.error('No bundles in @' + projectName + ' have a catalog for `' + culture + '`.');
            process.exit(1);
            return;
        }

        var body;
        if (self.format === 'json') {
            body = formatJSON(jsonOut);
        } else if (self.format === 'po') {
            body = formatPO(allEntries, culture);
        } else {
            body = formatCSV(allEntries, true);
        }
        emit(body);
    };

    init();
}

module.exports = Export;
