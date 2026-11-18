'use strict';
var fs       = require('fs');
var nodePath = require('path');
var os       = require('os');
// `lib` is injected as a global by the framework bootstrap — this file is
// required by the cmd dispatcher (lib/cmd/framework/init.js) in a scope where
// `lib` already exists (same as add.js / update.js use it at top level).
var console  = lib.logger;
// Shared status-format primitive — only `pad` is needed here (column alignment).
var fmt      = lib.cmdStatusFormat;

/**
 * @module gina/lib/cmd/framework/list
 */
/**
 * List the gina framework versions known to this install — the read-side
 * counterpart of `framework:add` / `framework:remove`.
 *
 * Three surfaces are reconciled into one view:
 *
 *   1. `<GINA_DIR>/framework/v<version>/` — the install entries. Exactly ONE is
 *      a real directory (the version shipped by `npm install gina`, i.e. the
 *      active default); every other is a SYMLINK that `framework:add` created
 *      pointing into the archive. A dangling symlink (target gone) is surfaced
 *      as a broken link.
 *   2. `~/.gina/archives/framework/v<version>/` — the persistent side-by-side
 *      store `framework:add` populates. Normally every symlinked version is also
 *      archived; an archived-but-not-linked version is reported as such.
 *   3. `~/.gina/main.json` `frameworks[<short>]` — the registry a bundle's
 *      `--gina-version` / manifest `gina_version` validates against, plus
 *      `def_framework` (the active default, flagged with `*`).
 *
 * Default output lists only the versions physically present (a real dir, a
 * symlink, or an archive). `--all` additionally includes versions that are
 * registered in `main.json` but not on disk (`not installed`) — the full
 * registry can hold a hundred-plus historical entries, so it is opt-in.
 *
 * Offline command (the `framework:` topic is already in `bin/cli`'s
 * `allowedOffline`). Read-only — it never writes any state. Default output is a
 * human-readable table; `--format=json` emits a machine-readable object. A
 * missing `main.json` degrades gracefully (the on-disk dirs are still listed,
 * `def_framework`/registry shown as unknown/empty).
 *
 * @class List
 * @constructor
 * @param {object} opt - Parsed command-line options.
 *
 * @example
 * // List the installed versions (the active real dir + any side-by-side symlinks):
 * gina framework:list
 *
 * @example
 * // Include every version registered in main.json, even if not on disk:
 * gina framework:list --all
 *
 * @example
 * // Machine-readable output:
 * gina framework:list --format=json
 */
function List(opt) {

    /**
     * Resolve `~/.gina` the same way `lib/state.js` / add.js do, so a
     * `GINA_HOMEDIR` override (tests / containers) is honoured.
     *
     * @inner
     * @private
     * @returns {string}
     */
    var resolveHomeDir = function () {
        if (typeof(getEnvVar) === 'function') {
            var override = getEnvVar('GINA_HOMEDIR');
            if (override) return override;
        }
        if (typeof(GINA_HOMEDIR) !== 'undefined' && GINA_HOMEDIR) return GINA_HOMEDIR;
        return os.homedir() + nodePath.sep + '.gina';
    };

    /**
     * Resolve the active gina install root (where `framework/v<version>/` dirs
     * live). `GINA_DIR` is set by `bin/cli` for every command, offline included.
     *
     * @inner
     * @private
     * @returns {string|null}
     */
    var resolveGinaDir = function () {
        if (typeof(getEnvVar) === 'function') {
            var dir = getEnvVar('GINA_DIR');
            if (dir) return dir;
        }
        return (typeof(GINA_DIR) !== 'undefined' && GINA_DIR) ? GINA_DIR : null;
    };

    /**
     * True when a bare boolean flag (`--all`) is present on argv.
     *
     * @inner
     * @private
     * @param {string} name - Flag name without the leading `--`.
     * @returns {boolean}
     */
    var hasFlag = function (name) {
        var re = new RegExp('^--' + name + '$');
        for (var i = 3; i < process.argv.length; i++) {
            if (typeof(process.argv[i]) == 'string' && re.test(process.argv[i])) return true;
        }
        return false;
    };

    /**
     * Read a `--name=value` flag (argv first, then the `GINA_<NAME>` hoist
     * fallback). Mirrors add.js's `readFlagValue`.
     *
     * @inner
     * @private
     * @param {string} name - Flag name without the leading `--`.
     * @returns {string|null}
     */
    var readFlagValue = function (name) {
        var prefix = '--' + name + '=';
        for (var i = 3; i < process.argv.length; i++) {
            if (typeof(process.argv[i]) == 'string' && process.argv[i].indexOf(prefix) === 0) {
                return process.argv[i].slice(prefix.length);
            }
        }
        var envKey = 'GINA_' + name.replace(/-/g, '_').toUpperCase();
        if (typeof(process.gina) != 'undefined' && typeof(process.gina[envKey]) != 'undefined') {
            return process.gina[envKey];
        }
        return null;
    };

    /**
     * Print a fatal message and exit non-zero. Single error egress.
     *
     * @inner
     * @private
     * @param {string} msg
     */
    var fail = function (msg) {
        console.error('[framework:list] ' + msg);
        process.exit(1);
    };

    /**
     * Derive the `major.minor` short for a full version (mirrors add.js).
     *
     * @inner
     * @private
     * @param {string} v
     * @returns {string}
     */
    var shortOf = function (v) {
        return v.split(/\./g).splice(0, 2).join('.');
    };

    /**
     * Enumerate `v<version>` entries directly under `dir`, returning the bare
     * versions (the leading `v` stripped). Tolerates a missing/unreadable dir
     * by returning an empty array.
     *
     * @inner
     * @private
     * @param {string} dir
     * @returns {string[]}
     */
    var listVersionDirs = function (dir) {
        var out = [];
        try {
            if (!fs.existsSync(dir)) return out;
            fs.readdirSync(dir).forEach(function (entry) {
                if (/^v\d/.test(entry)) out.push(entry.replace(/^v/, ''));
            });
        } catch (e) { /* unreadable → empty */ }
        return out;
    };

    /**
     * Classify the install entry at `<frameworkRoot>/v<version>`: whether it is
     * a real directory (the shipped active version), a symlink (a side-by-side
     * add), and whether it resolves on disk (a symlink whose target exists).
     *
     * @inner
     * @private
     * @param {string} installPath
     * @returns {{kind: ('real'|'symlink'|null), resolves: boolean}}
     */
    var classifyInstall = function (installPath) {
        var lst = null;
        try { lst = fs.lstatSync(installPath); } catch (e) { return { kind: null, resolves: false }; }
        var isSymlink = lst.isSymbolicLink();
        if (isSymlink) {
            return { kind: 'symlink', resolves: fs.existsSync(installPath) };
        }
        if (lst.isDirectory()) {
            return { kind: 'real', resolves: true };
        }
        return { kind: null, resolves: false };
    };

    /**
     * Build the per-version STATUS note for the human table from a row.
     *
     * @inner
     * @private
     * @param {object} r - Reconciled row.
     * @returns {string}
     */
    var statusOf = function (r) {
        var flags = [];
        if (r.active)                              flags.push('active');
        if (!r.registered)                         flags.push('unregistered');
        if (r.kind === 'symlink' && !r.onDisk)     flags.push('broken link');
        if (r.kind === 'archived')                 flags.push('not linked');
        if (r.kind === 'registered')               flags.push('not installed');
        return flags.length ? flags.join(', ') : 'ok';
    };

    /**
     * Orchestrate: gather the three surfaces, reconcile, sort, emit.
     *
     * @inner
     * @private
     */
    var init = function () {

        var format = readFlagValue('format');
        if (format && format !== 'json') {
            fail('Unknown --format value `' + format + '`. Supported: json.');
            return;
        }
        var asJson = (format === 'json');
        var all    = hasFlag('all');

        var homeDir = resolveHomeDir();
        var ginaDir = resolveGinaDir();
        if (!ginaDir) {
            fail('Cannot resolve GINA_DIR (the active install root). Reinstall gina or run from the CLI.');
            return;
        }

        var frameworkRoot = _(ginaDir + '/framework', true);
        var archivesDir   = _(homeDir + '/archives/framework', true);
        var mainPath      = _(homeDir + '/main.json', true);

        // --- registry (best-effort; a missing main.json degrades gracefully) ---
        var def = null;
        var registeredSet = {};
        try {
            if (fs.existsSync(mainPath)) {
                var main = requireJSON(mainPath);
                def = main.def_framework || null;
                var fw = main.frameworks || {};
                Object.keys(fw).forEach(function (s) {
                    if (Array.isArray(fw[s])) fw[s].forEach(function (v) { registeredSet[v] = true; });
                });
            } else {
                console.warn('[framework:list] ' + mainPath + ' not found — listing on-disk dirs only.');
            }
        } catch (e) {
            console.warn('[framework:list] could not read ' + mainPath + ' (' + (e.message || e) + ') — listing on-disk dirs only.');
        }

        // --- on-disk surfaces ---
        var installMap = {};
        listVersionDirs(frameworkRoot).forEach(function (v) {
            installMap[v] = classifyInstall(_(frameworkRoot + '/v' + v, true));
        });
        var archiveSet = {};
        listVersionDirs(archivesDir).forEach(function (v) { archiveSet[v] = true; });

        // --- union of candidate versions ---
        var seen = {};
        var candidates = [];
        var addCandidate = function (v) { if (!seen[v]) { seen[v] = true; candidates.push(v); } };
        Object.keys(installMap).forEach(addCandidate);
        Object.keys(archiveSet).forEach(addCandidate);
        if (all) Object.keys(registeredSet).forEach(addCandidate);

        // --- reconcile each candidate into a row ---
        var rows = candidates.map(function (v) {
            var inst     = installMap[v] || null;
            var archived = !!archiveSet[v];
            var kind     = inst ? inst.kind : (archived ? 'archived' : 'registered');
            var resolves = inst ? inst.resolves : false;
            var onDisk   = (kind === 'real') || (kind === 'symlink' && resolves);
            return {
                version    : v,
                short      : shortOf(v),
                active     : v === def,
                kind       : kind,
                registered : !!registeredSet[v],
                archived   : archived,
                onDisk     : onDisk
            };
        });

        // --- sort: active first, then on-disk, then version descending ---
        rows.sort(function (a, b) {
            if (a.active !== b.active) return a.active ? -1 : 1;
            if (a.onDisk !== b.onDisk) return a.onDisk ? -1 : 1;
            return String(b.version).localeCompare(String(a.version), undefined, { numeric: true });
        });

        emit(rows, def, all, asJson);
        process.exit(0);
    };

    /**
     * Emit the result — a human-readable table, or `--format=json`.
     *
     * @inner
     * @private
     * @param {object[]} rows - Reconciled, sorted rows.
     * @param {string|null} def - The active default version.
     * @param {boolean} all - Whether registered-only versions were included.
     * @param {boolean} asJson
     */
    var emit = function (rows, def, all, asJson) {
        if (asJson) {
            console.log(JSON.stringify({
                def_framework : def,
                all           : all,
                count         : rows.length,
                versions      : rows
            }, null, 2));
            return;
        }
        if (rows.length === 0) {
            console.log('No framework versions found' + (all ? '.' : ' (try --all for the registry).'));
            return;
        }
        var rule  = '------------------------------------------------------------';
        var lines = [];
        lines.push('gina frameworks' + (all ? ' (all registered)' : ' (installed)') + ':');
        lines.push(rule);
        lines.push('  ' + fmt.pad('VERSION', 22) + fmt.pad('KIND', 12) + 'STATUS');
        lines.push(rule);
        rows.forEach(function (r) {
            lines.push((r.active ? '* ' : '  ') + fmt.pad(r.version, 22) + fmt.pad(r.kind, 12) + statusOf(r));
        });
        lines.push(rule);
        lines.push('  ' + rows.length + ' shown   |   def_framework: ' + (def || '(unknown)')
            + (all ? '' : '   |   --all to include the full registry'));
        console.log(lines.join('\n'));
    };

    init();
}

module.exports = List;
