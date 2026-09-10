'use strict';
var fs       = require('fs');
var nodePath = require('path');
var os       = require('os');
var execSync = require('child_process').execSync;
// `lib` is injected as a global by the framework bootstrap — this file is
// required by the cmd dispatcher (lib/cmd/framework/init.js) in a scope where
// `lib` already exists (same as update.js / reset.js use it at top level).
var console  = lib.logger;
// The Node-vs-Bun runtime helper, reused (NOT re-implemented) for the
// dependency-install step. Required by a plain relative path — the bare
// `lib/<name>` form is unavailable in CLI/daemon scope. From
// framework/v<version>/lib/cmd/framework/ it is exactly 5×'../' up to the gina
// package root, the same depth bundle/start.js uses.
var runtime  = require('../../../../../utils/runtime.js');

/**
 * @module gina/lib/cmd/framework/add
 */
/**
 * Install a published gina framework version side-by-side with the active one,
 * so a bundle pinned via `--gina-version=<v>` (or manifest.json
 * `bundles[<name>].gina_version`) can actually resolve and boot on it.
 *
 * A normal `npm install gina@<v>` ships exactly ONE `framework/v<version>/`
 * tree. Multiple versions coexist through `~/.gina/archives/framework/` (a
 * persistent user-home store) plus install-time symlinking: `post_install.js`
 * `restoreSymlinks()` links every archived version into the active install's
 * `framework/` dir. This command automates the manual "download → install deps
 * → place in archive → symlink → register" dance maintainers otherwise do by
 * hand. Pipeline (all synchronous):
 *
 *   1. `npm pack gina@<version>` — download the published tarball to a temp dir.
 *   2. Extract it (`tar -xzf`) → `package/framework/v<version>/`.
 *   3. Copy that subtree into `~/.gina/archives/framework/v<version>/`.
 *   4. `npm install` inside the archived copy — resolve its OWN deps
 *      (@rhinostone/swig, psl, …) so the version can render. Runtime-aware
 *      (`bun install` under Bun), mirroring bundle/start.js.
 *   5. Symlink `~/.gina/archives/framework/v<version>` →
 *      `<GINA_DIR>/framework/v<version>` so the active install resolves it.
 *      Skipped when a real (non-symlink) dir already occupies that path — the
 *      active version is never clobbered.
 *   6. Register `<version>` in `~/.gina/main.json` `frameworks[<short>]` (the
 *      list `--gina-version` validates against) via the StateStore write path
 *      (`lib.generator.createFileFromDataSync` → gina.db + JSON sidecar in
 *      lockstep). `def_framework` is NEVER changed — adding a version is
 *      additive and never makes it the default.
 *
 * Per-shortVersion metadata maps (`protocols` / `schemes` / `scopes` / `envs` /
 * `cultures` / …) are NOT seeded here — `framework:init` seeds them on the first
 * `bundle:start` for the version (the same deferral `framework:update` uses). A
 * brand-new short emits a warning so the operator knows the first boot seeds it.
 *
 * Offline command (the `framework:` topic is already in `bin/cli`'s
 * `allowedOffline`). Default output is a human-readable summary; `--format=json`
 * emits a machine-readable object. Errors print via `lib.logger` then
 * `process.exit(1)`; success exits 0.
 *
 * @class Add
 * @constructor
 * @param {object} opt - Parsed command-line options (carries `opt.client` for socket output).
 *
 * @example
 * // Install a published version side-by-side with the active one:
 * gina framework:add 0.4.7
 *
 * @example
 * // Preview every step without writing anything:
 * gina framework:add 0.4.7 --dry-run
 *
 * @example
 * // Re-install over an existing archived copy, JSON output:
 * gina framework:add 0.4.7 --force --format=json
 */
function Add(opt) {

    /**
     * Per-short metadata maps in `main.json` keyed by `<shortVersion>`. This
     * command does not seed them (that is `framework:init`'s job on first
     * `bundle:start`); it only checks whether the target short is brand-new to
     * decide whether to warn. Accessed as `main[m]` (string key), never via a
     * literal map-name dot-access, so the "does not seed metadata" negative
     * invariant stays a clean code-absence check.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var SEED_MAPS = ['protocols', 'schemes', 'scopes', 'envs', 'cultures', 'log_levels'];

    /**
     * Resolve `~/.gina` the same way `lib/state.js` does, so the paths this
     * handler builds satisfy `StateStore.isStatePath` (routing the write to
     * SQLite + sidecar) and a `GINA_HOMEDIR` override (tests / containers) is
     * honoured. Mirrors framework:update's `resolveHomeDir`.
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
     * live and get symlinked). `GINA_DIR` is set by `bin/cli` for every command,
     * offline included.
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
     * The first non-flag positional after the `framework:add` task token is the
     * version. `filterArgs` never strips a no-`=` token, so a bare positional
     * survives in argv regardless of flag hoisting.
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
     * fallback). Mirrors framework:update's `readFlagValue`.
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
        console.error('[framework:add] ' + msg);
        process.exit(1);
    };

    /**
     * `npm` / `npm.cmd` per platform (the registry fetch needs npm; Bun has no
     * `bun pack` equivalent in this codebase).
     *
     * @inner
     * @private
     * @returns {string}
     */
    var npmBin = function () {
        return (process.platform === 'win32') ? 'npm.cmd' : 'npm';
    };

    /**
     * Runtime-aware dependency install command, mirroring bundle/start.js. Zero
     * Node delta: `isBun()` is false on Node, so this is byte-identical to
     * `npm install` there.
     *
     * @inner
     * @private
     * @returns {string}
     */
    var installCmd = function () {
        return runtime.isBun()
            ? 'bun install'
            : ((process.platform === 'win32') ? 'npm.cmd install' : 'npm install');
    };

    /**
     * Register `version` into `main.frameworks[short]` (push-if-absent), the same
     * idiom as `post_install.js` and `framework:update`. Mutates `main` in place
     * and returns whether a change was made. Never touches `def_framework`.
     *
     * @inner
     * @private
     * @param {object} main - Parsed main.json.
     * @param {string} short - Target `major.minor`.
     * @param {string} version - Full version.
     * @returns {boolean} True when the list gained the version.
     */
    var registerVersion = function (main, short, version) {
        if (!main.frameworks) main.frameworks = {};
        if (!Array.isArray(main.frameworks[short])) main.frameworks[short] = [];
        if (main.frameworks[short].indexOf(version) < 0) {
            main.frameworks[short].push(version);
            return true;
        }
        return false;
    };

    /**
     * Run a shell command synchronously, surfacing stdout. Throws on non-zero
     * exit (caught by the step that called it).
     *
     * @inner
     * @private
     * @param {string} cmd
     * @param {string} [cwd]
     */
    var run = function (cmd, cwd) {
        console.info('[framework:add] running: ' + cmd + (cwd ? '  (cwd: ' + cwd + ')' : ''));
        var out = execSync(cmd, cwd ? { cwd: cwd } : undefined);
        if (out) { var s = out.toString().trim(); if (s) console.debug(s); }
    };

    /**
     * Orchestrate the pipeline.
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
            fail('Missing <version>. Usage: gina framework:add <version> [--force] [--dry-run]');
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

        var archiveDir = _(homeDir + '/archives/framework/v' + version, true);
        var installDir = _(ginaDir + '/framework/v' + version, true);
        var tmpDir     = _(os.tmpdir() + '/gina-framework-add-' + version, true);
        var tgz        = _(tmpDir + '/gina-' + version + '.tgz', true);
        var extracted  = _(tmpDir + '/package/framework/v' + version, true);
        var mainPath   = _(homeDir + '/main.json', true);

        var installExists = fs.existsSync(installDir);
        var installIsRealDir = installExists && !fs.lstatSync(installDir).isSymbolicLink();
        var archiveExists = fs.existsSync(archiveDir);

        var plan = {
            version       : version,
            short         : short,
            archiveDir    : archiveDir,
            installDir    : installDir,
            archiveExists : archiveExists,
            installIsRealDir : installIsRealDir,
            force         : force,
            dryRun        : dryRun
        };

        // Adding the active (real, non-symlink) version is a no-op for the symlink
        // step; warn but still allow re-archiving + registering.
        if (installIsRealDir) {
            console.warn('[framework:add] v' + version + ' is already installed as a real framework dir; '
                + 'the symlink step will be skipped (the active install is never clobbered).');
        }
        // --dry-run always previews (even when the archive exists) — it writes
        // nothing, so the --force refuse below must not pre-empt the plan.
        if (dryRun) {
            console.info('[framework:add] --dry-run: no changes will be made.');
            emit(plan, asJson, true);
            process.exit(0);
            return;
        }

        if (archiveExists && !force) {
            fail('v' + version + ' is already archived at ' + archiveDir + '. Re-run with --force to overwrite.');
            return;
        }

        // --- 1. download ----------------------------------------------------
        try {
            if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
            fs.mkdirSync(tmpDir, { recursive: true });
            run(npmBin() + ' pack gina@' + version + ' --pack-destination ' + JSON.stringify(tmpDir));
        } catch (e) {
            fail('could not download gina@' + version + ' from npm (unpublished version or network error): '
                + (e.message || e));
            return;
        }
        if (!fs.existsSync(tgz)) {
            fail('expected tarball not found after npm pack: ' + tgz);
            return;
        }

        // --- 2. extract -----------------------------------------------------
        try {
            run('tar -xzf ' + JSON.stringify(tgz) + ' -C ' + JSON.stringify(tmpDir));
        } catch (e) {
            fail('could not extract ' + tgz + ': ' + (e.message || e));
            return;
        }
        if (!fs.existsSync(extracted)) {
            fail('the published gina@' + version + ' tarball does not contain framework/v' + version
                + ' (got no ' + extracted + '). This version may predate the current layout.');
            return;
        }

        // --- 3. place in the archive ---------------------------------------
        try {
            if (archiveExists) fs.rmSync(archiveDir, { recursive: true, force: true });
            fs.mkdirSync(nodePath.dirname(archiveDir), { recursive: true });
            // fs.cpSync (Node >= 16.7, well within gina's engine floor) is the robust
            // synchronous tree copy. The framework `_().cp()` is callback-style and
            // prepare_version.js:586's `await` of it is a latent no-op (awaits undefined).
            fs.cpSync(extracted, archiveDir, { recursive: true });
        } catch (e) {
            fail('could not copy the framework tree into ' + archiveDir + ': ' + (e.message || e));
            return;
        }

        // --- 4. install the archived tree's own deps -----------------------
        try {
            var initialDir = process.cwd();
            var oldGlobal  = process.env.npm_config_global;
            process.env.npm_config_global = false;
            try {
                run(installCmd(), archiveDir);
            } finally {
                process.env.npm_config_global = oldGlobal;
                process.chdir(initialDir);
            }
        } catch (e) {
            fail('dependency install failed inside ' + archiveDir + ': ' + (e.message || e));
            return;
        }

        // --- 5. symlink into the active install ----------------------------
        var symlinked = false;
        if (installIsRealDir) {
            console.info('[framework:add] skipping symlink — v' + version + ' is the active install.');
        } else {
            try {
                if (installExists) fs.unlinkSync(installDir); // replace a stale symlink
                fs.mkdirSync(nodePath.dirname(installDir), { recursive: true });
                // Link at <install>/framework/v<v> pointing to the archive copy —
                // same source→dest direction as post_install.js restoreSymlinks().
                fs.symlinkSync(archiveDir, installDir);
                symlinked = true;
            } catch (e) {
                fail('could not symlink ' + installDir + ' -> ' + archiveDir + ': ' + (e.message || e));
                return;
            }
        }

        // --- 6. register in main.json (never touch def_framework) ----------
        var registered = false;
        var newShort   = false;
        try {
            if (!fs.existsSync(mainPath)) {
                fail('`' + mainPath + '` not found. Run `gina framework:init` (or reinstall gina) first.');
                return;
            }
            var main = requireJSON(mainPath);
            newShort = !main.frameworks || !Array.isArray(main.frameworks[short]) || main.frameworks[short].length === 0;
            registered = registerVersion(main, short, version);
            if (registered) {
                lib.generator.createFileFromDataSync(main, mainPath);
            }
        } catch (e) {
            fail('could not register v' + version + ' in main.json: ' + (e.message || e));
            return;
        }

        // --- cleanup + warnings + summary ----------------------------------
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }

        // A brand-new short has no per-short metadata maps yet; the first
        // bundle:start on this version seeds them (framework:init's job).
        if (newShort) {
            console.warn('[framework:add] ' + short + ' is a new short version — its metadata maps '
                + '(' + SEED_MAPS.join(', ') + ', …) are seeded by framework:init on the first '
                + '`bundle:start` for v' + version + '.');
        }

        var def = (function () { try { return requireJSON(mainPath).def_framework; } catch (e) { return null; } })();

        emit({
            version          : version,
            short            : short,
            archiveDir       : archiveDir,
            installDir       : installDir,
            symlinked        : symlinked,
            registered       : registered,
            alreadyRegistered: !registered,
            newShort         : newShort,
            def_framework    : def,
            pinHint          : 'gina bundle:start <bundle> @<project> --gina-version=' + version
        }, asJson, false);

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
        if (isPlan) {
            console.info('[framework:add] plan for v' + result.version + ':');
            console.info('  • download gina@' + result.version + ' from npm');
            console.info('  • archive  → ' + result.archiveDir + (result.archiveExists ? '  (overwrite, --force)' : ''));
            console.info('  • install its deps in the archive');
            console.info('  • symlink  → ' + result.installDir + (result.installIsRealDir ? '  (SKIPPED — active install)' : ''));
            console.info('  • register v' + result.version + ' in main.json frameworks[' + result.short + ']  (def_framework unchanged)');
            return;
        }
        console.info('[framework:add] v' + result.version + ' is ready.');
        console.info('  • archived : ' + result.archiveDir);
        console.info('  • symlink  : ' + (result.symlinked ? result.installDir : 'skipped (active install)'));
        console.info('  • registered in frameworks[' + result.short + ']: '
            + (result.registered ? 'yes' : 'already present'));
        console.info('  • def_framework: ' + result.def_framework + '  (unchanged)');
        console.info('  Pin a bundle to it: ' + result.pinHint);
    };

    init();
}

module.exports = Add;
