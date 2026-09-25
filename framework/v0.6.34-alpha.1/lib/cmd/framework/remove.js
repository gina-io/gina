'use strict';
var fs       = require('fs');
var nodePath = require('path');
var os       = require('os');
// `lib` is injected as a global by the framework bootstrap — this file is
// required by the cmd dispatcher (lib/cmd/framework/init.js) in a scope where
// `lib` already exists (same as add.js / list.js use it at top level).
var console  = lib.logger;

/**
 * @module gina/lib/cmd/framework/remove
 */
/**
 * Remove a side-by-side installed gina framework version — the inverse of
 * `framework:add`. It undoes the three things `add` does, in a crash-safe order
 * (deregister first, so a failure never leaves a registered-but-missing version):
 *
 *   1. Deregister `<version>` from `~/.gina/main.json` `frameworks[<short>]` via
 *      the StateStore write path (`lib.generator.createFileFromDataSync` →
 *      gina.db + JSON sidecar in lockstep). An emptied short key is dropped.
 *   2. Unlink the symlink `<GINA_DIR>/framework/v<version>` (a dangling symlink
 *      is unlinked too). The active install's REAL dir is never unlinked.
 *   3. Delete the archived copy `~/.gina/archives/framework/v<version>`.
 *
 * Three safety gates protect the install:
 *
 *   - **active default** — refuses if `<version>` is `def_framework`. Hard gate;
 *     `--force` does NOT override it (switch the default first).
 *   - **real shipped dir** — refuses if `<GINA_DIR>/framework/v<version>` is a
 *     real directory rather than a symlink (the version `npm install gina`
 *     shipped). Hard gate; `--force` does NOT override it (only side-by-side
 *     symlinked versions are removable).
 *   - **bundle pin** — refuses if any project's `manifest.json`
 *     `bundles[*].gina_version` pins `<version>`. Soft gate; `--force` overrides
 *     it with a warning. The scan is best-effort: projects whose `path` is not
 *     readable on this host (container/temp paths) are skipped.
 *
 * `def_framework` is never written. A version absent everywhere (no install
 * entry, no archive, not registered) is reported as "nothing to remove" and
 * exits 0.
 *
 * Offline command (the `framework:` topic is already in `bin/cli`'s
 * `allowedOffline`). Default output is a human-readable summary; `--format=json`
 * emits a machine-readable object; `--dry-run` previews without mutating.
 *
 * @class Remove
 * @constructor
 * @param {object} opt - Parsed command-line options.
 *
 * @example
 * // Remove a side-by-side version:
 * gina framework:remove 0.4.7
 *
 * @example
 * // Preview without changing anything:
 * gina framework:remove 0.4.7 --dry-run
 *
 * @example
 * // Remove even though a bundle pins it (overrides the pin gate only):
 * gina framework:remove 0.4.7 --force --format=json
 */
function Remove(opt) {

    /**
     * Resolve `~/.gina` the same way `lib/state.js` / add.js do, honouring a
     * `GINA_HOMEDIR` override (tests / containers).
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
     * The first non-flag positional after the `framework:remove` task token is
     * the version. Mirrors add.js's `readVersionArg`.
     *
     * @inner
     * @private
     * @returns {string|null}
     */
    var readVersionArg = function () {
        for (var i = 3; i < process.argv.length; i++) {
            var tok = process.argv[i];
            if (typeof(tok) === 'string' && tok.length && tok.charAt(0) !== '-') {
                return tok;
            }
        }
        return null;
    };

    /**
     * True when a bare boolean flag (`--force`, `--dry-run`) is present on argv.
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
        console.error('[framework:remove] ' + msg);
        process.exit(1);
    };

    /**
     * Remove `version` from `main.frameworks[short]` (the inverse of add.js's
     * push-if-absent). Drops an emptied short key. Mutates `main` in place and
     * returns whether a change was made. Never touches `def_framework`.
     *
     * @inner
     * @private
     * @param {object} main - Parsed main.json.
     * @param {string} short - Target `major.minor`.
     * @param {string} version - Full version.
     * @returns {boolean} True when the registry lost the version.
     */
    var deregisterVersion = function (main, short, version) {
        if (!main.frameworks || !Array.isArray(main.frameworks[short])) return false;
        var idx = main.frameworks[short].indexOf(version);
        if (idx < 0) return false;
        main.frameworks[short].splice(idx, 1);
        if (main.frameworks[short].length === 0) delete main.frameworks[short];
        return true;
    };

    /**
     * Scan every project's `manifest.json` for a bundle pinning `version` via
     * `bundles[*].gina_version`. Best-effort: a missing/unreadable projects.json,
     * a project with no host-readable `path`, or an unreadable manifest is
     * skipped silently (so container/temp project paths don't abort the scan).
     *
     * @inner
     * @private
     * @param {string} projectsPath - `~/.gina/projects.json`.
     * @param {string} version - Full version to match.
     * @returns {string[]} `bundle@project` identifiers pinning the version.
     */
    var scanPinnedBy = function (projectsPath, version) {
        var pinned = [];
        try {
            if (!fs.existsSync(projectsPath)) return pinned;
            var projects = requireJSON(projectsPath);
            Object.keys(projects).forEach(function (proj) {
                try {
                    var p = projects[proj];
                    if (!p || !p.path) return;
                    var manifestPath = nodePath.join(p.path, 'manifest.json');
                    if (!fs.existsSync(manifestPath)) return;
                    var manifest = requireJSON(manifestPath);
                    var bundles = manifest && manifest.bundles;
                    if (!bundles) return;
                    Object.keys(bundles).forEach(function (b) {
                        if (bundles[b] && bundles[b].gina_version === version) {
                            pinned.push(b + '@' + proj);
                        }
                    });
                } catch (e) { /* skip an unreadable project */ }
            });
        } catch (e) { /* projects.json unreadable → no pins surfaced */ }
        return pinned;
    };

    /**
     * Orchestrate the gated removal.
     *
     * @inner
     * @private
     */
    var init = function () {

        // --- parse + validate inputs ---------------------------------------
        var format = readFlagValue('format');
        if (format && format !== 'json') {
            fail('Unknown --format value `' + format + '`. Supported: json.');
            return;
        }
        var asJson = (format === 'json');
        var force  = hasFlag('force');
        var dryRun = hasFlag('dry-run');

        var raw = readVersionArg();
        if (!raw) {
            fail('Missing <version>. Usage: gina framework:remove <version> [--force] [--dry-run]');
            return;
        }
        var version = String(raw).replace(/^v/, '');
        if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
            fail('`' + raw + '` is not a valid version (expected e.g. 0.4.7 or 0.3.7-alpha.2).');
            return;
        }
        var short = version.split(/\./g).splice(0, 2).join('.');

        var homeDir = resolveHomeDir();
        var ginaDir = resolveGinaDir();
        if (!ginaDir) {
            fail('Cannot resolve GINA_DIR (the active install root). Reinstall gina or run from the CLI.');
            return;
        }

        var archiveDir   = _(homeDir + '/archives/framework/v' + version, true);
        var installDir   = _(ginaDir + '/framework/v' + version, true);
        var mainPath     = _(homeDir + '/main.json', true);
        var projectsPath = _(homeDir + '/projects.json', true);

        // --- read registry (needed to check def_framework + deregister) ----
        if (!fs.existsSync(mainPath)) {
            fail('`' + mainPath + '` not found. Run `gina framework:init` (or reinstall gina) first.');
            return;
        }
        var main;
        try {
            main = requireJSON(mainPath);
        } catch (e) {
            fail('could not read ' + mainPath + ': ' + (e.message || e));
            return;
        }
        var def = main.def_framework || null;

        // --- inspect the install entry -------------------------------------
        var installLstat = null;
        try { installLstat = fs.lstatSync(installDir); } catch (e) { installLstat = null; }
        var installEntryExists = installLstat !== null;
        var installIsSymlink   = installLstat && installLstat.isSymbolicLink();
        var installIsRealDir   = installLstat && installLstat.isDirectory() && !installIsSymlink;

        var archived   = fs.existsSync(archiveDir);
        var registered = !!(main.frameworks && Array.isArray(main.frameworks[short]) && main.frameworks[short].indexOf(version) > -1);

        // --- hard gates (never overridable) --------------------------------
        if (version === def) {
            fail('v' + version + ' is the active default (def_framework). Set a different default before removing it.');
            return;
        }
        if (installIsRealDir) {
            fail('v' + version + ' is the real framework dir shipped with this install, not a side-by-side symlink; '
                + 'removing it would break gina. Only added (symlinked) versions can be removed.');
            return;
        }

        // --- nothing to remove (idempotent) --------------------------------
        if (!installEntryExists && !archived && !registered) {
            console.info('[framework:remove] v' + version + ' is not installed — nothing to remove.');
            emit({
                version: version, short: short, dryRun: dryRun,
                deregistered: false, symlinkUnlinked: false, archiveRemoved: false,
                pinnedBy: [], def_framework: def, notInstalled: true
            }, asJson, false);
            process.exit(0);
            return;
        }

        // --- soft gate: bundle pin (overridable with --force) --------------
        var pinnedBy = scanPinnedBy(projectsPath, version);
        if (pinnedBy.length && !force) {
            fail('v' + version + ' is pinned by bundle(s): ' + pinnedBy.join(', ') + '. '
                + 'Re-run with --force to remove it anyway.');
            return;
        }
        if (pinnedBy.length && force) {
            console.warn('[framework:remove] v' + version + ' is pinned by: ' + pinnedBy.join(', ')
                + ' — removing anyway (--force).');
        }

        // --- compute the plan ----------------------------------------------
        var plan = {
            version         : version,
            short           : short,
            dryRun          : dryRun,
            deregistered    : registered,
            symlinkUnlinked : installEntryExists && installIsSymlink,
            archiveRemoved  : archived,
            pinnedBy        : pinnedBy,
            def_framework   : def,
            installDir      : installDir,
            archiveDir      : archiveDir
        };

        if (dryRun) {
            console.info('[framework:remove] --dry-run: no changes will be made.');
            emit(plan, asJson, true);
            process.exit(0);
            return;
        }

        // --- execute (safe order: deregister → unlink → delete) ------------
        try {
            if (plan.deregistered) {
                if (deregisterVersion(main, short, version)) {
                    lib.generator.createFileFromDataSync(main, mainPath);
                } else {
                    plan.deregistered = false; // raced/already gone — keep the summary honest
                }
            }
        } catch (e) {
            fail('could not deregister v' + version + ' from main.json: ' + (e.message || e));
            return;
        }
        try {
            if (plan.symlinkUnlinked) fs.unlinkSync(installDir);
        } catch (e) {
            fail('could not unlink ' + installDir + ': ' + (e.message || e));
            return;
        }
        try {
            if (plan.archiveRemoved) fs.rmSync(archiveDir, { recursive: true, force: true });
        } catch (e) {
            fail('could not delete the archive ' + archiveDir + ': ' + (e.message || e));
            return;
        }

        emit(plan, asJson, false);
        process.exit(0);
    };

    /**
     * Emit the result — human-readable summary, or `--format=json`.
     *
     * @inner
     * @private
     * @param {object} result
     * @param {boolean} asJson
     * @param {boolean} isPlan - True for a `--dry-run` plan (vs a completed run).
     */
    var emit = function (result, asJson, isPlan) {
        if (asJson) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        if (result.notInstalled) {
            return; // the info line was already printed
        }
        if (isPlan) {
            console.info('[framework:remove] plan for v' + result.version + ':');
            if (result.deregistered)    console.info('  • deregister from main.json frameworks[' + result.short + ']');
            if (result.symlinkUnlinked) console.info('  • unlink the symlink ' + result.installDir);
            if (result.archiveRemoved)  console.info('  • delete the archive ' + result.archiveDir);
            console.info('  (def_framework: ' + result.def_framework + ' — unchanged)');
            return;
        }
        console.info('[framework:remove] v' + result.version + ' removed.');
        console.info('  • deregistered from frameworks[' + result.short + ']: ' + (result.deregistered ? 'yes' : 'no'));
        console.info('  • symlink unlinked: ' + (result.symlinkUnlinked ? result.installDir : 'no'));
        console.info('  • archive deleted: ' + (result.archiveRemoved ? result.archiveDir : 'no'));
        console.info('  • def_framework: ' + result.def_framework + '  (unchanged)');
    };

    init();
}

module.exports = Remove;
