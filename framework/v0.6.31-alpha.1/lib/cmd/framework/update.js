var fs       = require('fs');
var nodePath = require('path');
var console  = lib.logger;

// Reuse the install-time strict-semver comparator that post_install.js uses to
// gate its def_framework overwrite (the "never regress" guard). It lives in the
// repo-root script/ tree (NOT under framework/v*/lib) because post_install runs
// before any framework helper is loadable; it ships to npm (not in .npmignore's
// denylist) and the relative depth from here to the repo root is invariant
// across framework-dir renames, so this require resolves for an npm-installed
// gina as well as the dev checkout. Single source of truth for the semver rules.
var versionCompare = require('../../../../../script/version_compare');

/**
 * @module gina/lib/cmd/framework/update
 */
/**
 * Reconcile the `~/.gina/` state files to the installed framework version.
 *
 * This is a STATE-MIGRATION command, not an npm self-update — it automates the
 * manual "Post-merge state check" a maintainer otherwise runs by hand after a
 * `git merge` bumps the framework version (npm's `post_install.js` does NOT run
 * on a git merge, so the state files drift). It brings three scalars back in
 * line with the active version:
 *
 *   - `~/.gina/main.json` `def_framework`
 *   - `~/.gina/main.json` `frameworks[<shortVersion>]` (registers the version)
 *   - `~/.gina/<shortVersion>/settings.json` `version` + `def_framework`
 *
 * `gina.db` (the canonical SQLite store) is reconciled automatically: every
 * write goes through `lib.generator.createFileFromDataSync`, which routes known
 * `~/.gina/` state paths through `lib/state.js` `StateStore.write` (SQLite +
 * JSON sidecar in lockstep). So a `--fix` repairs both stores even when a prior
 * raw write left them drifted.
 *
 * Default mode is a DRY RUN — nothing is written. Pass `--fix` (or `--apply`) to
 * reconcile. `--dry-run` forces read-only even alongside `--fix`. Output is a
 * human-readable summary by default, JSON with `--format=json`.
 *
 * A strict-semver "never regress" guard (shared with `post_install.js`) protects
 * the scalar pointers: when the target version is strictly OLDER than the value
 * already recorded, the scalar write is skipped (the newer recorded state is
 * preserved). The `frameworks[<short>]` LIST is still updated in that case, so a
 * locally-installed older tarball stays visible — exactly post_install's
 * behaviour.
 *
 * Per-shortVersion METADATA maps (`protocols` / `schemes` / `scopes` / `envs` /
 * `cultures` / ...) are NOT seeded here — that is `framework:init`'s job, run on
 * the first `bundle:start`. When the target short is missing those entries this
 * command WARNS and points at the seeding step; it never writes them. npm
 * self-update (the behaviour this command's name once advertised) is likewise
 * out of scope — run `npm i -g gina@latest` for that.
 *
 * Flags:
 *   --to-version=<v>  Reconcile to <v> instead of the installed GINA_VERSION.
 *   --fix | --apply   Apply the reconcile. Without it, the scan is read-only.
 *   --dry-run         Force read-only even when --fix is present.
 *   --format=json     Emit machine-readable JSON instead of the text summary.
 *
 * Usage:
 *   gina framework:update
 *   gina framework:update --fix
 *   gina framework:update --to-version=0.5.5-alpha.2 --fix
 *   gina framework:update --format=json
 *
 * @class Update
 * @constructor
 * @param {object} opt - Parsed command-line options (carries opt.client for socket output)
 */
function Update(opt) {

    /**
     * Per-short metadata maps in `main.json` keyed by `<shortVersion>`. This
     * command only CHECKS their presence (to warn) — it never seeds them.
     * Accessed as `main[m]` (string key), never via a literal map-name
     * dot-access, so the "does not seed metadata" negative invariant stays a
     * clean code-absence check. `framework:init` owns seeding these on the
     * first bundle start.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var SEED_MAPS = ['protocols', 'schemes', 'scopes', 'envs', 'cultures', 'log_levels'];

    /**
     * Resolve the home dir, target version, and flags; scan the state files;
     * optionally apply the reconcile; emit the report in the chosen format.
     *
     * @inner
     * @private
     */
    var init = function () {

        var homeDir = resolveHomeDir();

        var format = readFlagValue('format');
        if (format && format !== 'json') {
            console.error('Unknown --format value `' + format + '`. Supported: json.');
            process.exit(1);
            return;
        }
        var asJson = (format === 'json');

        var target = readFlagValue('to-version') || (typeof(GINA_VERSION) != 'undefined' ? GINA_VERSION : null);
        if (!target || !/^v?\d+\.\d+\.\d+/.test(String(target))) {
            console.error('Cannot determine a target version. Pass --to-version=<version> (got `' + target + '`).');
            process.exit(1);
            return;
        }
        target = String(target).replace(/^v/, '');
        var targetShort = target.split(/\./g).splice(0, 2).join('.');

        var fix     = hasFlag('fix') || hasFlag('apply');
        var dryRun  = hasFlag('dry-run');
        var write   = fix && !dryRun;

        // --- read main.json (hard error if missing/unparseable) -------------
        var mainPath = _(homeDir + '/main.json', true);
        if (!fs.existsSync(mainPath)) {
            console.error('`' + mainPath + '` not found. Run `gina framework:init` (or reinstall gina) first.');
            process.exit(1);
            return;
        }
        var main;
        try {
            main = requireJSON(mainPath);
        } catch (e) {
            console.error('Cannot parse `' + mainPath + '`: ' + (e.message || e));
            process.exit(1);
            return;
        }

        // --- read <short>/settings.json (soft — may not exist on a new short)
        var settingsPath = _(homeDir + '/' + targetShort + '/settings.json', true);
        var settingsExists = fs.existsSync(settingsPath);
        var settings = null;
        var settingsParseError = null;
        if (settingsExists) {
            try {
                settings = requireJSON(settingsPath);
            } catch (e) {
                settingsParseError = e.message || String(e);
            }
        }

        // The "never regress" guard compares the target against the recorded
        // def_framework (the same axis post_install guards). When the target is
        // strictly older we preserve the recorded scalar but still register the
        // version in the frameworks list.
        var regress = versionCompare.isStrictlyOlder(target, main.def_framework);

        var report = buildReport(main, settings, settingsPath, settingsExists, settingsParseError, target, targetShort, regress, homeDir, write);

        if (write && report.fixableCount > 0) {
            applyFixes(report, main, settings, mainPath, settingsPath, target, targetShort, regress);
        }

        if (asJson) {
            emitJson(report);
        } else {
            emitText(report);
        }

        process.exit(0);
    };

    /**
     * Resolve `~/.gina` the same way `lib/state.js` does, so the paths this
     * handler builds satisfy `StateStore.isStatePath` (which routes the write to
     * SQLite + sidecar) and a `GINA_HOMEDIR` override (tests / containers) is
     * honoured on both the read and write side.
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
        return require('os').homedir() + nodePath.sep + '.gina';
    };

    /**
     * True when a bare boolean flag (`--fix`, `--apply`, `--dry-run`) is present
     * on argv. filterArgs never strips a no-`=` token, so argv is authoritative.
     *
     * @inner
     * @private
     * @param {string} name - Flag name without the leading `--`
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
     * Read a `--name=value` flag. Reads argv first (where it survives for this
     * command — `framework:update` trips filterArgs' `setget` gate so argv is not
     * rewritten); falls back to `process.gina.GINA_<NAME>` for the case where
     * filterArgs hoisted the `=value` token. Mirrors the project:backup flag idiom.
     *
     * @inner
     * @private
     * @param {string} name - Flag name without the leading `--`
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
     * Build the reconcile report: one entry per checked field, plus warnings for
     * deferred metadata seeding and a missing/unparseable settings.json. Does NOT
     * mutate any state — pure analysis. `applyFixes` performs the writes.
     *
     * @inner
     * @private
     * @returns {Report}
     */
    var buildReport = function (main, settings, settingsPath, settingsExists, settingsParseError, target, targetShort, regress, homeDir, write) {
        var checks   = [];
        var warnings = [];

        // main.json def_framework (regress-guarded scalar)
        checks.push(scalarCheck('main.json', 'def_framework', main.def_framework, target, regress));

        // main.json frameworks[<short>] membership (always reconcilable — register the version)
        var list = (main.frameworks && Array.isArray(main.frameworks[targetShort])) ? main.frameworks[targetShort] : null;
        var listed = !!(list && list.indexOf(target) > -1);
        checks.push({
            file    : 'main.json',
            field   : 'frameworks[' + targetShort + ']',
            current : listed ? ('contains ' + target) : (list ? 'missing ' + target : 'no ' + targetShort + ' entry'),
            target  : 'contains ' + target,
            status  : listed ? 'in-sync' : 'drift',
            fixable : !listed
        });

        // <short>/settings.json version + def_framework
        if (!settingsExists) {
            warnings.push('`' + settingsPath + '` not found — settings for short `' + targetShort + '` are not seeded yet. Run `gina bundle:start` or `gina framework:init` to create it. (framework:update does not scaffold settings.json.)');
        } else if (settingsParseError) {
            warnings.push('`' + settingsPath + '` could not be parsed (' + settingsParseError + ') — skipped.');
        } else {
            checks.push(scalarCheck(targetShort + '/settings.json', 'version', settings.version, target, regress));
            checks.push(scalarCheck(targetShort + '/settings.json', 'def_framework', settings.def_framework, target, regress));
        }

        // deferred metadata-seeding warning (we never write these maps)
        var missingMaps = [];
        for (var i = 0; i < SEED_MAPS.length; i++) {
            var m = SEED_MAPS[i];
            if (!main[m] || typeof(main[m][targetShort]) == 'undefined') missingMaps.push(m);
        }
        if (missingMaps.length > 0) {
            warnings.push('main.json has no `' + targetShort + '` entry for: ' + missingMaps.join(', ') + '. These per-version metadata maps are seeded by `gina framework:init` on the first `gina bundle:start` — framework:update does not seed them.');
        }

        var fixableCount = 0;
        var driftCount   = 0;
        var skipCount    = 0;
        for (var c = 0; c < checks.length; c++) {
            if (checks[c].fixable) fixableCount++;
            if (checks[c].status === 'drift') driftCount++;
            if (checks[c].status === 'regression-skip') skipCount++;
        }

        return {
            mode         : write ? 'fix' : 'dry-run',
            homeDir      : homeDir,
            target       : target,
            targetShort  : targetShort,
            regress      : regress,
            checks       : checks,
            warnings     : warnings,
            fixableCount : fixableCount,
            driftCount   : driftCount,
            skipCount    : skipCount,
            inSync       : (driftCount === 0 && skipCount === 0)
        };
    };

    /**
     * Classify one scalar field against the target under the regression guard.
     * Equal → in-sync; different & target newer-or-equal → drift (fixable);
     * different & target older → regression-skip (preserve recorded value).
     *
     * @inner
     * @private
     * @param {string} file
     * @param {string} field
     * @param {*} current
     * @param {string} target
     * @param {boolean} regress
     * @returns {Check}
     */
    var scalarCheck = function (file, field, current, target, regress) {
        if (current === target) {
            return { file: file, field: field, current: current, target: target, status: 'in-sync', fixable: false };
        }
        if (regress) {
            return { file: file, field: field, current: current, target: target, status: 'regression-skip', fixable: false };
        }
        return { file: file, field: field, current: (typeof(current) == 'undefined' ? '(unset)' : current), target: target, status: 'drift', fixable: true };
    };

    /**
     * Apply the fixable checks in place and persist via createFileFromDataSync
     * (which routes the state paths through StateStore → SQLite + JSON sidecar).
     * The regression guard has already been folded into each check's `fixable`
     * flag, so the scalar writes only fire when the target is not a regression;
     * the frameworks-list registration always fires. Marks each applied check
     * `fixed: true`.
     *
     * @inner
     * @private
     */
    var applyFixes = function (report, main, settings, mainPath, settingsPath, target, targetShort, regress) {
        var mainDirty     = false;
        var settingsDirty = false;

        for (var i = 0; i < report.checks.length; i++) {
            var chk = report.checks[i];
            if (!chk.fixable) continue;

            if (chk.file === 'main.json' && chk.field === 'def_framework') {
                main.def_framework = target;
                mainDirty = true;
                chk.fixed = true;
            } else if (chk.file === 'main.json' && /^frameworks\[/.test(chk.field)) {
                if (!main.frameworks) main.frameworks = {};
                if (!Array.isArray(main.frameworks[targetShort])) main.frameworks[targetShort] = [];
                if (main.frameworks[targetShort].indexOf(target) < 0) main.frameworks[targetShort].push(target);
                mainDirty = true;
                chk.fixed = true;
            } else if (/settings\.json$/.test(chk.file) && chk.field === 'version') {
                settings.version = target;
                settingsDirty = true;
                chk.fixed = true;
            } else if (/settings\.json$/.test(chk.file) && chk.field === 'def_framework') {
                settings.def_framework = target;
                settingsDirty = true;
                chk.fixed = true;
            }
        }

        if (mainDirty)     lib.generator.createFileFromDataSync(main, mainPath);
        if (settingsDirty) lib.generator.createFileFromDataSync(settings, settingsPath);
    };

    /**
     * Print the human-readable summary to the socket client / terminal.
     *
     * @inner
     * @private
     * @param {Report} report
     */
    var emitText = function (report) {
        var prefix = (report.mode === 'fix') ? '[fix]' : '[dry-run]';
        console.log(prefix + ' framework:update — target ' + report.target + ' (short ' + report.targetShort + ')');

        var lastFile = null;
        for (var i = 0; i < report.checks.length; i++) {
            var c = report.checks[i];
            if (c.file !== lastFile) {
                console.log('  ' + c.file);
                lastFile = c.file;
            }
            var line;
            if (c.status === 'in-sync') {
                line = c.field + ': ' + c.current + ' — in sync';
            } else if (c.status === 'regression-skip') {
                line = c.field + ': ' + c.current + ' (recorded) vs ' + c.target + ' (target) — SKIPPED (regression guard: target is older; preserving recorded)';
            } else { // drift
                var verb = c.fixed ? 'FIXED' : 'DRIFT';
                line = c.field + ': ' + c.current + ' → ' + c.target + ' — ' + verb + (c.fixed ? '' : ' (fixable)');
            }
            console.log('    ' + line);
        }

        for (var w = 0; w < report.warnings.length; w++) {
            console.log('  WARN  ' + report.warnings[w]);
        }

        console.log('');
        if (report.mode === 'fix') {
            var fixedCount = 0;
            for (var f = 0; f < report.checks.length; f++) { if (report.checks[f].fixed) fixedCount++; }
            if (fixedCount > 0) {
                console.log('Reconciled ' + fixedCount + ' item(s) to ' + report.target + '.' + (report.skipCount > 0 ? ' ' + report.skipCount + ' skipped by the regression guard.' : ''));
            } else if (report.skipCount > 0) {
                console.log('Nothing written — ' + report.skipCount + ' item(s) skipped by the regression guard (target older than recorded).');
            } else {
                console.log('Already in sync — nothing to reconcile.');
            }
        } else {
            if (report.fixableCount > 0) {
                console.log('Re-run with --fix to reconcile ' + report.fixableCount + ' item(s).' + (report.skipCount > 0 ? ' ' + report.skipCount + ' item(s) would be skipped by the regression guard.' : ''));
            } else if (report.skipCount > 0) {
                console.log(report.skipCount + ' item(s) skipped by the regression guard (target older than recorded) — nothing to fix.');
            } else {
                console.log('Already in sync — nothing to reconcile.');
            }
        }
    };

    /**
     * Emit the machine-readable JSON report to the socket client / terminal.
     *
     * @inner
     * @private
     * @param {Report} report
     */
    var emitJson = function (report) {
        console.log(JSON.stringify({
            command      : 'framework:update',
            mode         : report.mode,
            homeDir      : report.homeDir,
            target       : report.target,
            targetShort  : report.targetShort,
            regressionGuard : report.regress,
            inSync       : report.inSync,
            fixableCount : report.fixableCount,
            skippedCount : report.skipCount,
            checks       : report.checks,
            warnings     : report.warnings
        }, null, 2));
    };

    init();
}

/**
 * @typedef {object} Check
 * @property {string} file - `main.json` or `<short>/settings.json`
 * @property {string} field - The reconciled field (e.g. `def_framework`)
 * @property {*} current - Current recorded value (or membership description)
 * @property {string} target - Desired value
 * @property {string} status - `in-sync` | `drift` | `regression-skip`
 * @property {boolean} fixable - True when `--fix` would write this field
 * @property {boolean} [fixed] - True once `applyFixes` wrote it
 */

/**
 * @typedef {object} Report
 * @property {string} mode - `dry-run` | `fix`
 * @property {string} homeDir - Resolved `~/.gina` directory
 * @property {string} target - Reconcile target version
 * @property {string} targetShort - Target `major.minor`
 * @property {boolean} regress - True when the target is strictly older than the recorded def_framework
 * @property {Check[]} checks - Per-field findings
 * @property {string[]} warnings - Deferred-seeding / missing-file notices
 * @property {number} fixableCount - Count of fixable checks
 * @property {number} driftCount - Count of drift checks
 * @property {number} skipCount - Count of regression-skip checks
 * @property {boolean} inSync - True when no drift and no regression-skip
 */

module.exports = Update;
