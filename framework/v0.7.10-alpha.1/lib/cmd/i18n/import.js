var fs      = require('fs');
var path    = require('path');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/i18n/import
 */
/**
 * Imports a translator-edited PO / CSV / JSON file back into a culture's
 * catalog at `<bundle>/locales/<culture>.json`. The complement of
 * `gina i18n:export`; together they close the translator round-trip.
 *
 * Usage:
 *  gina i18n:import <culture> @<project> --file=<path>
 *  gina i18n:import <culture> <bundle> @<project> --file=fr.po --format=po
 *  gina i18n:import <culture> @<project> --file=fr.json --merge=union
 *  gina i18n:import <culture> @<project> --file=fr.json --merge=replace
 *
 * Format auto-detection:
 *  - When `--format` is omitted, the format is detected from `--file`'s
 *    extension (`.po`, `.csv`, `.json`).
 *  - JSON wrapper inputs (`{ "<bundle>": { ...catalog }, ... }`) are split
 *    per bundle when no `<bundle>` positional is given.
 *  - PO `msgctxt` and CSV `bundle` column carry the bundle name when
 *    multi-bundle.
 *
 * Merge strategies (`--merge=<mode>`):
 *  - `union` (default): deep-merge — imported keys win for conflicts;
 *    existing keys absent from the import are preserved. Translator-friendly:
 *    a partial PO/CSV touches only the keys it lists.
 *  - `replace`: imported catalog wins entirely; existing keys absent from
 *    the import are dropped. Surfaced via a "dropped N keys" log.
 *
 * Plural-form reconstruction: PO `msgid_plural` + `msgstr[N]` entries
 * carry a `#. cldr-keys: <list>` extracted comment recording the present
 * CLDR plural keys in canonical order; the importer maps `msgstr[N]`
 * back to the original CLDR keys. CSV plural rows reach the catalog via
 * dotted-suffix nesting (`items.one` + `items.other` → `items: { one, other }`).
 *
 * Write-back uses the comment-preserving three-function pattern from
 * `connector:add` (`readExistingFile` / `mergeEntry` / `writeFile`):
 * leading comment headers (everything before the first `{`) are preserved
 * verbatim; the JSON body is rewritten from the parsed object graph.
 *
 * Flags:
 *   --file=<path>           Input file. Required.
 *   --format=<json|po|csv>  Override the auto-detected format.
 *   --merge=<union|replace> Merge strategy. Defaults to `union`.
 *   --dry-run               Print what would change; skip the disk write.
 *   --force                 Allow creating a new catalog when the target
 *                           does not exist (default: error and recommend
 *                           `gina i18n:add` first).
 *
 * @class Import
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Import(opt, cmd) {
    var self = { file: null, format: null, merge: 'union', dryRun: false, force: false };

    var i18n = lib.i18n;

    /**
     * Allowed `--format` values.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var ALLOWED_FORMATS = ['json', 'po', 'csv'];

    /**
     * Allowed `--merge` values.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var ALLOWED_MERGE = ['union', 'replace'];

    /**
     * Culture-string shape (`<lang>` or `<lang>_<REGION>`). Mirrors
     * `lib/i18n/src/main.js CULTURE_FILENAME`.
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var CULTURE_RE = /^[a-z]{2,3}(_[A-Z]{2,3})?$/;

    /**
     * CLDR plural categories — pinned in order so the PO `msgstr[N]` →
     * CLDR-key reconstruction is deterministic.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var CLDR_PLURAL_KEYS = ['zero', 'one', 'two', 'few', 'many', 'other'];

    /**
     * Set of CLDR keys for fast last-segment matching during nested
     * catalog reassembly.
     *
     * @inner
     * @constant
     * @type {Object<string, true>}
     */
    var CLDR_PLURAL_SET = {
        'zero':true, 'one':true, 'two':true, 'few':true, 'many':true, 'other':true
    };

    /**
     * Parses positionals + flags via CmdHelper, validates inputs, dispatches
     * to the project-wide or bundle-scoped importer, and exits.
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
            console.error('Missing <culture> argument. Usage: gina i18n:import <culture> [<bundle>] @<project> --file=<path> [--format=<json|po|csv>] [--merge=<union|replace>]');
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
            if ( /^\-\-file\=/.test(arg) ) {
                self.file = arg.split(/\=/)[1] || null;
            } else if ( /^\-\-format\=/.test(arg) ) {
                self.format = arg.split(/\=/)[1] || null;
            } else if ( /^\-\-merge\=/.test(arg) ) {
                self.merge = arg.split(/\=/)[1] || 'union';
            } else if (arg === '--dry-run') {
                self.dryRun = true;
            } else if (arg === '--force') {
                self.force = true;
            }
        }

        if (!self.file) {
            console.error('Missing --file=<path> argument.');
            process.exit(1);
            return;
        }
        if ( !fs.existsSync(self.file) ) {
            console.error('Input file not found: `' + self.file + '`.');
            process.exit(1);
            return;
        }

        if (!self.format) {
            self.format = detectFormatFromPath(self.file);
        }
        if (!self.format) {
            console.error('--format must be set when --file extension is not `.po` / `.csv` / `.json`.');
            process.exit(1);
            return;
        }
        if ( ALLOWED_FORMATS.indexOf(self.format) < 0 ) {
            console.error('--format must be `json`, `po`, or `csv` (got `' + self.format + '`).');
            process.exit(1);
            return;
        }
        if ( ALLOWED_MERGE.indexOf(self.merge) < 0 ) {
            console.error('--merge must be `union` or `replace` (got `' + self.merge + '`).');
            process.exit(1);
            return;
        }

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            console.error('`i18n:import <culture>` requires `@<project>`. Did you forget `@<project_name>`?');
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
            importBundleOnly(self.projectName, bundleName, culture);
        } else {
            importProjectWide(self.projectName, culture);
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
     * `null` on any I/O or parse error.
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
     * Loads `<projectPath>/manifest.json`.
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
     * Auto-detects format from the input file extension. Returns `null`
     * for unrecognised extensions so the caller can error with guidance.
     *
     * @memberof module:gina/lib/cmd/i18n/import
     * @param   {string} inputPath
     * @returns {string|null}
     */
    var detectFormatFromPath = function (inputPath) {
        var ext = path.extname(String(inputPath || '')).toLowerCase();
        if (ext === '.po')   return 'po';
        if (ext === '.csv')  return 'csv';
        if (ext === '.json') return 'json';
        return null;
    };

    /**
     * Reverse of `export.js poQuote` — unescapes `\\`, `\"`, `\n`, `\t`,
     * `\r`. Trailing surrogate sequences (`\xNN`, `\uNNNN`) are passed
     * through verbatim; PO consumers don't typically emit them and the
     * roundtrip stays byte-stable.
     *
     * @memberof module:gina/lib/cmd/i18n/import
     * @param   {string} str - Quoted PO string content (without surrounding quotes)
     * @returns {string}
     */
    var poUnescape = function (str) {
        return String(str || '').replace(/\\(.)/g, function (m, ch) {
            if (ch === 'n')  return '\n';
            if (ch === 't')  return '\t';
            if (ch === 'r')  return '\r';
            if (ch === '"')  return '"';
            if (ch === '\\') return '\\';
            return m;
        });
    };

    /**
     * Strips surrounding double-quotes from a PO line value (the bytes
     * between the leading directive and the trailing comment, if any).
     *
     * @inner
     * @private
     * @param {string} raw
     * @returns {string}
     */
    var unwrapPoQuoted = function (raw) {
        var s = String(raw || '').trim();
        if (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
            return s.slice(1, -1);
        }
        return s;
    };

    /**
     * Parses a PO file into entries. Supports:
     *   - Header entry (msgid "" / msgstr "...") — discarded.
     *   - Single-string entries (msgid + msgstr).
     *   - Plural entries (msgid + msgid_plural + msgstr[N], with optional
     *     `#. cldr-keys: <list>` comment for CLDR-key reconstruction).
     *   - Optional `msgctxt` for bundle disambiguation.
     *   - Multi-line strings via PO continuation (msgid ""\n"line1"\n"line2").
     *   - Backslash escapes (`\n`, `\t`, `\r`, `\"`, `\\`).
     *
     * Plural entries with a `#. cldr-keys` marker reconstruct the original
     * CLDR plural-form object exactly. Entries without the marker fall back
     * to canonical CLDR order (`zero`, `one`, `two`, `few`, `many`, `other`)
     * — best-effort for PO files authored outside this tooling.
     *
     * @memberof module:gina/lib/cmd/i18n/import
     * @param   {string} body
     * @returns {Array<{bundle:string|null, key:string, value:string|null, plural:object|null}>}
     */
    var parsePO = function (body) {
        var lines = String(body || '').split(/\r?\n/);
        var entries = [];
        var cur = newPoEntry();
        var lastDirective = null;

        function flush() {
            if (cur.key !== null && cur.key !== '') {
                entries.push(buildEntryFromPo(cur));
            }
            cur = newPoEntry();
            lastDirective = null;
        }

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var trimmed = line.replace(/^\s+/, '');
            if (trimmed === '') {
                flush();
                continue;
            }
            if (trimmed.charAt(0) === '#') {
                var ckm = trimmed.match(/^#\.\s*cldr-keys\s*:\s*(.+)$/);
                if (ckm) {
                    cur.cldrKeys = ckm[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
                }
                lastDirective = null;
                continue;
            }
            var ctx = trimmed.match(/^msgctxt\s+(.*)$/);
            if (ctx) {
                cur.msgctxt = poUnescape(unwrapPoQuoted(ctx[1]));
                lastDirective = 'msgctxt';
                continue;
            }
            var idp = trimmed.match(/^msgid_plural\s+(.*)$/);
            if (idp) {
                cur.msgidPlural = poUnescape(unwrapPoQuoted(idp[1]));
                lastDirective = 'msgid_plural';
                continue;
            }
            var id = trimmed.match(/^msgid\s+(.*)$/);
            if (id) {
                cur.key = poUnescape(unwrapPoQuoted(id[1]));
                lastDirective = 'msgid';
                continue;
            }
            var sn = trimmed.match(/^msgstr\[(\d+)\]\s+(.*)$/);
            if (sn) {
                var idx = parseInt(sn[1], 10);
                cur.msgstrN[idx] = poUnescape(unwrapPoQuoted(sn[2]));
                lastDirective = 'msgstr[' + idx + ']';
                continue;
            }
            var ms = trimmed.match(/^msgstr\s+(.*)$/);
            if (ms) {
                cur.msgstr = poUnescape(unwrapPoQuoted(ms[1]));
                lastDirective = 'msgstr';
                continue;
            }
            // Continuation line: starts with `"` and continues the last directive
            if (trimmed.charAt(0) === '"' && lastDirective) {
                var add = poUnescape(unwrapPoQuoted(trimmed));
                appendToDirective(cur, lastDirective, add);
                continue;
            }
        }
        flush();
        return entries;
    };

    /**
     * Allocate an empty PO entry buffer.
     *
     * @inner
     * @private
     * @returns {object}
     */
    var newPoEntry = function () {
        return {
            msgctxt    : null,
            key        : null,
            msgidPlural: null,
            msgstr     : null,
            msgstrN    : {},
            cldrKeys   : null
        };
    };

    /**
     * Append a continuation-line value to the last seen PO directive.
     *
     * @inner
     * @private
     * @param {object} cur
     * @param {string} directive
     * @param {string} add
     */
    var appendToDirective = function (cur, directive, add) {
        if (directive === 'msgctxt')      cur.msgctxt = (cur.msgctxt || '') + add;
        else if (directive === 'msgid')        cur.key = (cur.key || '') + add;
        else if (directive === 'msgid_plural') cur.msgidPlural = (cur.msgidPlural || '') + add;
        else if (directive === 'msgstr')       cur.msgstr = (cur.msgstr || '') + add;
        else {
            var m = directive.match(/^msgstr\[(\d+)\]$/);
            if (m) {
                var idx = parseInt(m[1], 10);
                cur.msgstrN[idx] = (cur.msgstrN[idx] || '') + add;
            }
        }
    };

    /**
     * Map a parsed PO entry into the flat-entry shape that
     * `buildCatalogFromEntries` consumes.
     *
     * @inner
     * @private
     * @param {object} cur
     * @returns {{bundle:string|null, key:string, value:string|null, plural:object|null}}
     */
    var buildEntryFromPo = function (cur) {
        var bundle = (cur.msgctxt && cur.msgctxt.length > 0) ? cur.msgctxt : null;
        if (cur.msgidPlural !== null) {
            var indices = Object.keys(cur.msgstrN).map(function (k) { return parseInt(k, 10); }).sort(function (a, b) { return a - b; });
            var keys    = (cur.cldrKeys && cur.cldrKeys.length > 0) ? cur.cldrKeys : CLDR_PLURAL_KEYS.slice(0, indices.length);
            var plural  = {};
            for (var n = 0; n < indices.length && n < keys.length; n++) {
                plural[keys[n]] = cur.msgstrN[indices[n]];
            }
            return { bundle: bundle, key: cur.key, value: null, plural: plural };
        }
        return { bundle: bundle, key: cur.key, value: cur.msgstr || '', plural: null };
    };

    /**
     * RFC 4180 CSV reader — state machine over chars. Handles quoted cells
     * with embedded commas / doubled quotes / newlines / CRLF line endings.
     * Returns rows as arrays of strings.
     *
     * @memberof module:gina/lib/cmd/i18n/import
     * @param   {string} body
     * @returns {Array<string[]>}
     */
    var parseCSVRows = function (body) {
        var rows = [];
        var row  = [];
        var cell = '';
        var inQ  = false;
        var s    = String(body || '');
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (inQ) {
                if (c === '"') {
                    if (s.charAt(i + 1) === '"') { cell += '"'; i++; }
                    else                          { inQ = false; }
                } else {
                    cell += c;
                }
            } else {
                if (c === '"' && cell === '') {
                    inQ = true;
                } else if (c === ',') {
                    row.push(cell); cell = '';
                } else if (c === '\n') {
                    row.push(cell); rows.push(row); row = []; cell = '';
                } else if (c === '\r') {
                    // peek for LF and skip together; treat lone CR as line break too
                    if (s.charAt(i + 1) === '\n') { i++; }
                    row.push(cell); rows.push(row); row = []; cell = '';
                } else {
                    cell += c;
                }
            }
        }
        if (cell.length > 0 || row.length > 0) {
            row.push(cell); rows.push(row);
        }
        return rows;
    };

    /**
     * Parses a CSV body into entries. Detects single-bundle (`key,value`)
     * vs multi-bundle (`bundle,key,value`) shape from the header row.
     * Plural-form rows surface as dotted-suffix keys; nesting reassembly
     * happens later in `buildCatalogFromEntries`.
     *
     * @memberof module:gina/lib/cmd/i18n/import
     * @param   {string} body
     * @returns {Array<{bundle:string|null, key:string, value:string, plural:null}>}
     */
    var parseCSV = function (body) {
        var rows = parseCSVRows(body);
        if (rows.length === 0) return [];
        var header = rows[0];
        var hasBundle = false;
        var keyIdx, valIdx, bundleIdx;
        if (header.length === 3 && header[0] === 'bundle' && header[1] === 'key' && header[2] === 'value') {
            hasBundle = true; bundleIdx = 0; keyIdx = 1; valIdx = 2;
        } else if (header.length >= 2 && header[0] === 'key' && header[1] === 'value') {
            hasBundle = false; keyIdx = 0; valIdx = 1;
        } else {
            return [];
        }
        var entries = [];
        for (var r = 1; r < rows.length; r++) {
            var row = rows[r];
            if (row.length === 0) continue;
            if (row.length === 1 && row[0] === '') continue;
            var k = row[keyIdx];
            if (typeof k !== 'string' || k.length === 0) continue;
            entries.push({
                bundle: hasBundle ? (row[bundleIdx] || null) : null,
                key   : k,
                value : (typeof row[valIdx] === 'string') ? row[valIdx] : '',
                plural: null
            });
        }
        return entries;
    };

    /**
     * Reassembles a flat list of dotted-key entries into a nested catalog
     * object. CLDR-key terminal segments (`*.one`, `*.other`, etc.) collect
     * into plural-form objects so round-tripped CSV / unmarked PO inputs
     * land back as valid catalog plurals.
     *
     * @memberof module:gina/lib/cmd/i18n/import
     * @param   {Array<{key:string, value:string|null, plural:object|null}>} entries
     * @returns {object}
     */
    var buildCatalogFromEntries = function (entries) {
        var out = {};
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.plural) {
                setNested(out, e.key.split('.'), e.plural, true);
            } else {
                setNested(out, e.key.split('.'), e.value, false);
            }
        }
        return out;
    };

    /**
     * Walks `parts` into `out`, creating intermediate objects where needed,
     * and assigns `value` at the leaf. When `isPluralFormValue` is true,
     * the value is assigned atomically (a plural-form object replaces the
     * leaf wholesale).
     *
     * @inner
     * @private
     * @param {object}   out
     * @param {string[]} parts
     * @param {*}        value
     * @param {boolean}  isPluralFormValue
     */
    var setNested = function (out, parts, value, isPluralFormValue) {
        var cursor = out;
        for (var i = 0; i < parts.length - 1; i++) {
            var seg = parts[i];
            if (typeof cursor[seg] !== 'object' || cursor[seg] === null || Array.isArray(cursor[seg])) {
                cursor[seg] = {};
            }
            cursor = cursor[seg];
        }
        var leafKey = parts[parts.length - 1];
        if (isPluralFormValue) {
            cursor[leafKey] = value;
        } else {
            cursor[leafKey] = value;
        }
    };

    /**
     * Detects whether a parsed JSON object is a multi-bundle wrapper or a
     * flat catalog. Heuristic: every top-level value is a plain object AND
     * at least one of those nested values has its own object children
     * (catalogs nest). For the flat-catalog edge case where every leaf is a
     * top-level string, the heuristic correctly identifies it as flat.
     *
     * @memberof module:gina/lib/cmd/i18n/import
     * @param   {object} data
     * @returns {boolean}
     */
    var looksLikeWrapper = function (data) {
        if ( !data || typeof data !== 'object' || Array.isArray(data) ) return false;
        var keys = Object.keys(data);
        if (keys.length === 0) return false;
        var allObjects = true;
        var anyNested  = false;
        for (var i = 0; i < keys.length; i++) {
            var v = data[keys[i]];
            if ( !v || typeof v !== 'object' || Array.isArray(v) ) { allObjects = false; break; }
            // Any nested object key holding an object value indicates this top-level
            // value is itself a catalog (so the parent is the wrapper).
            var inner = Object.keys(v);
            for (var j = 0; j < inner.length; j++) {
                if ( v[inner[j]] && typeof v[inner[j]] === 'object' && !Array.isArray(v[inner[j]]) ) {
                    anyNested = true;
                    break;
                }
            }
        }
        return allObjects && anyNested;
    };

    /**
     * Group flat entries by their `bundle` field. Entries without a bundle
     * fall under `null`.
     *
     * @inner
     * @private
     * @param {Array<{bundle:string|null}>} entries
     * @returns {Object<string, Array<object>>}
     */
    var groupEntriesByBundle = function (entries) {
        var out = {};
        for (var i = 0; i < entries.length; i++) {
            var b = entries[i].bundle || '__no_bundle__';
            if (!out[b]) out[b] = [];
            out[b].push(entries[i]);
        }
        return out;
    };

    /**
     * Deep-merge `imported` over `existing` for `--merge=union`. Imported
     * keys win for shared paths; existing keys absent from the import are
     * preserved. Plural-form objects merge per-CLDR-key (a partial import
     * with only `{one}` keeps the existing `{other}` etc.).
     *
     * @memberof module:gina/lib/cmd/i18n/import
     * @param   {object} existing
     * @param   {object} imported
     * @returns {object}
     */
    var mergeUnion = function (existing, imported) {
        var out = {};
        var ek = Object.keys(existing || {});
        for (var i = 0; i < ek.length; i++) {
            out[ek[i]] = existing[ek[i]];
        }
        var ik = Object.keys(imported || {});
        for (var j = 0; j < ik.length; j++) {
            var k = ik[j];
            var ev = out[k];
            var iv = imported[k];
            if ( ev && typeof ev === 'object' && !Array.isArray(ev)
                && iv && typeof iv === 'object' && !Array.isArray(iv) ) {
                out[k] = mergeUnion(ev, iv);
            } else {
                out[k] = iv;
            }
        }
        return out;
    };

    /**
     * Reads the existing catalog at `target` while preserving any leading
     * comment header (everything before the first `{`). Mirrors
     * `connector:add::readExistingFile`.
     *
     * Returns `{ header, data }`. When the file does not exist, returns
     * an empty shape so the caller can decide whether to create.
     *
     * @inner
     * @private
     * @param {string} target
     * @returns {{header:string, data:object}|null}
     */
    var readExistingFile = function (target) {
        if ( !fs.existsSync(target) ) {
            return { header: '', data: {} };
        }
        var raw;
        try {
            raw = fs.readFileSync(target, 'utf8');
        } catch (e) {
            console.error('Cannot read `' + target + '`: ' + e.message);
            process.exit(1);
            return null;
        }
        var firstBrace = raw.indexOf('{');
        var header     = (firstBrace > 0) ? raw.slice(0, firstBrace) : '';
        var data;
        try {
            data = requireJSON(target) || {};
        } catch (e) {
            console.error('Cannot parse `' + target + '`: ' + e.message);
            process.exit(1);
            return null;
        }
        return { header: header, data: data };
    };

    /**
     * Writes the merged catalog back, preserving the leading comment header
     * verbatim. Body is serialised with 4-space indent + trailing newline,
     * matching `i18n:add` and the rest of the framework's catalog writers.
     *
     * @inner
     * @private
     * @param {string} target
     * @param {string} header
     * @param {object} data
     */
    var writeFile = function (target, header, data) {
        var body = JSON.stringify(data, null, 4);
        var text = (header || '') + body + '\n';
        lib.generator.createFileFromDataSync(text, target);
    };

    /**
     * Counts how many keys exist in `existing` that are absent from
     * `imported` — surfaces the dropped-keys count in `--merge=replace`
     * mode so translators see what they wiped.
     *
     * @inner
     * @private
     * @param {object} existing
     * @param {object} imported
     * @param {string} [prefix]
     * @returns {number}
     */
    var countDroppedKeys = function (existing, imported, prefix) {
        if ( !existing || typeof existing !== 'object' ) return 0;
        if ( i18n.isPluralForm(existing) ) {
            return i18n.isPluralForm(imported) ? 0 : 1;
        }
        var dropped = 0;
        var ek = Object.keys(existing);
        for (var i = 0; i < ek.length; i++) {
            var k = ek[i];
            var ev = existing[k];
            var iv = imported ? imported[k] : undefined;
            if (typeof iv === 'undefined') {
                dropped += isLeaf(ev) ? 1 : countLeaves(ev);
            } else if (typeof ev === 'object' && ev !== null && typeof iv === 'object' && iv !== null) {
                dropped += countDroppedKeys(ev, iv, prefix);
            }
        }
        return dropped;
    };

    /**
     * @inner
     * @private
     */
    var isLeaf = function (v) {
        return v === null || typeof v !== 'object' || Array.isArray(v) || i18n.isPluralForm(v);
    };

    /**
     * @inner
     * @private
     */
    var countLeaves = function (v) {
        if (isLeaf(v)) return 1;
        var n = 0;
        var ks = Object.keys(v);
        for (var i = 0; i < ks.length; i++) n += countLeaves(v[ks[i]]);
        return n;
    };

    /**
     * Imports one bundle's worth of entries (or a parsed catalog) into
     * `<bundle>/locales/<culture>.json`, applying `--merge` strategy and
     * the comment-preserving writer. Returns true on success / dry-run,
     * false on a recoverable per-bundle error.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string} bundleName
     * @param {string} culture
     * @param {object} importedCatalog
     * @returns {boolean}
     */
    var importBundle = function (projectPath, bundleName, culture, importedCatalog) {
        var bundlePath = path.join(projectPath, bundleName);
        var localesDir = path.join(bundlePath, 'locales');
        var targetPath = path.join(localesDir, culture + '.json');

        if ( !fs.existsSync(targetPath) && !self.force ) {
            console.error('[' + bundleName + '] no catalog at ' + targetPath
                + ' — run `gina i18n:add ' + culture + ' ' + bundleName + ' @' + self.projectName + '` first, or pass --force to create.');
            return false;
        }

        var parsed = readExistingFile(targetPath);
        if (!parsed) return false;

        var merged;
        var dropped = 0;
        if (self.merge === 'replace') {
            dropped = countDroppedKeys(parsed.data, importedCatalog);
            merged = importedCatalog;
        } else {
            merged = mergeUnion(parsed.data, importedCatalog);
        }

        if (self.dryRun) {
            var preview = JSON.stringify(merged, null, 4) + '\n';
            console.log('[' + bundleName + '] [dry-run] would write ' + targetPath
                + ' (' + preview.length + ' bytes; --merge=' + self.merge
                + (self.merge === 'replace' && dropped > 0 ? '; ' + dropped + ' key(s) dropped' : '') + ')');
            return true;
        }

        if ( !fs.existsSync(localesDir) ) {
            try {
                fs.mkdirSync(localesDir, { recursive: true });
            } catch (e) {
                console.error('[' + bundleName + '] cannot create ' + localesDir + ': ' + e.message);
                return false;
            }
        }

        try {
            writeFile(targetPath, parsed.header, merged);
        } catch (e) {
            console.error('[' + bundleName + '] cannot write ' + targetPath + ': ' + e.message);
            return false;
        }

        console.log('[' + bundleName + '] merged ' + targetPath + ' (--merge=' + self.merge
            + (self.merge === 'replace' && dropped > 0 ? '; ' + dropped + ' key(s) dropped' : '') + ')');
        return true;
    };

    /**
     * Reads + parses the input file and returns a per-bundle map of
     * imported catalogs:
     *   { '<bundle>': <catalog> }
     * For single-bundle inputs (no msgctxt / no bundle column / flat JSON),
     * returns `{ '__no_bundle__': <catalog> }` so the caller can route to
     * the explicit `<bundle>` positional.
     *
     * @inner
     * @private
     * @returns {Object<string, object>|null}
     */
    var loadImport = function () {
        var raw;
        try {
            raw = fs.readFileSync(self.file, 'utf8');
        } catch (e) {
            console.error('Cannot read --file `' + self.file + '`: ' + e.message);
            process.exit(1);
            return null;
        }

        if (self.format === 'json') {
            var parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                console.error('Cannot parse JSON `' + self.file + '`: ' + e.message);
                process.exit(1);
                return null;
            }
            if ( parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ) {
                console.error('JSON input root must be an object: `' + self.file + '`.');
                process.exit(1);
                return null;
            }
            if ( looksLikeWrapper(parsed) ) {
                return parsed;
            }
            return { '__no_bundle__': parsed };
        }

        var entries;
        if (self.format === 'po') {
            entries = parsePO(raw);
        } else {
            entries = parseCSV(raw);
        }

        var byBundle = groupEntriesByBundle(entries);
        var out = {};
        var keys = Object.keys(byBundle);
        for (var i = 0; i < keys.length; i++) {
            out[keys[i]] = buildCatalogFromEntries(byBundle[keys[i]]);
        }
        return out;
    };

    /**
     * Imports into a single bundle. Routes the input file's contents via
     * `loadImport`; if the input is multi-bundle, only the specified
     * bundle's section is applied (with a warning when other bundles are
     * present in the input).
     *
     * @inner
     * @private
     * @param {string} projectName
     * @param {string} bundleName
     * @param {string} culture
     */
    var importBundleOnly = function (projectName, bundleName, culture) {
        var project   = self.projects[projectName];
        var perBundle = loadImport();
        if (!perBundle) return;

        var importedCatalog;
        if ( typeof perBundle[bundleName] !== 'undefined' ) {
            importedCatalog = perBundle[bundleName];
        } else if ( typeof perBundle['__no_bundle__'] !== 'undefined' ) {
            importedCatalog = perBundle['__no_bundle__'];
        } else {
            console.error('Input file does not contain entries for bundle `' + bundleName + '`. Found: '
                + Object.keys(perBundle).filter(function (k) { return k !== '__no_bundle__'; }).join(', ') + '.');
            process.exit(1);
            return;
        }

        var others = Object.keys(perBundle).filter(function (k) {
            return k !== bundleName && k !== '__no_bundle__';
        });
        if (others.length > 0) {
            console.error('[warn] input also contains entries for bundle(s) `' + others.join(', ')
                + '` — ignored under single-bundle scope. Re-run without <bundle> positional to import them too.');
        }

        var ok = importBundle(project.path, bundleName, culture, importedCatalog);
        if (!ok) {
            process.exit(1);
            return;
        }
    };

    /**
     * Imports into every bundle present in the input file. Warns when an
     * input bundle is not registered in the manifest (entries skipped).
     *
     * @inner
     * @private
     * @param {string} projectName
     * @param {string} culture
     */
    var importProjectWide = function (projectName, culture) {
        var project   = self.projects[projectName];
        var manifest  = loadManifest(project.path);
        if (!manifest || !manifest.bundles) {
            console.error('Project @' + projectName + ' has no manifest.json or no bundles registered.');
            process.exit(1);
            return;
        }

        var perBundle = loadImport();
        if (!perBundle) return;

        if ( typeof perBundle['__no_bundle__'] !== 'undefined' && Object.keys(perBundle).length === 1 ) {
            console.error('Input file is single-bundle (no msgctxt / no bundle column / flat JSON). Pass <bundle> as the second positional, or import a multi-bundle export.');
            process.exit(1);
            return;
        }

        var bundleNames = Object.keys(perBundle).filter(function (k) { return k !== '__no_bundle__'; });
        var ok = 0;
        var fail = 0;
        for (var i = 0; i < bundleNames.length; i++) {
            var b = bundleNames[i];
            if ( !manifest.bundles[b] ) {
                console.error('[warn] input bundle `' + b + '` is not registered in @' + projectName + ' — entries skipped.');
                fail++;
                continue;
            }
            var r = importBundle(project.path, b, culture, perBundle[b]);
            if (r) ok++; else fail++;
        }
        console.log('\n@' + projectName + ': ' + ok + ' bundle(s) merged, ' + fail + ' skipped.');
    };

    init();
}

module.exports = Import;
