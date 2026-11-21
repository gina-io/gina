/**
 * lib/cmd/framework/add.js — install a published gina version side-by-side.
 *
 * `framework:add` downloads a published gina version, installs its deps, places
 * the framework tree in ~/.gina/archives/framework, symlinks it into the active
 * install, and registers it in main.json frameworks[<short>] so a bundle can pin
 * it via --gina-version. It runs inside the CLI bootstrap with the gina globals
 * injected (_ / requireJSON / getEnvVar / lib / GINA_DIR), which is heavy to
 * replicate, so the bulk of these tests are source-inspection pins (same style as
 * framework-update.test.js / connector-migrate.test.js). The decision logic that
 * CAN be exercised in isolation — version parsing, the frameworks[] push-if-absent,
 * the dry-run / --force / symlink-skip gates — is covered by a pure-logic replica
 * (§15).
 *
 * Pinned structure:
 *   (a) module shape — function Add(opt), exports, console=lib.logger
 *   (b) reuses utils/runtime for the (Bun-aware) dep install; shells out via execSync
 *   (c) homedir resolution mirrors lib/state.js; GINA_DIR resolves the install root
 *   (d) version positional parse + semver validation + short derivation
 *   (e) flag reading — --force / --dry-run (bare) + --format (=value)
 *   (f) path construction — archive / install / tmp
 *   (g) the 6 pipeline steps (pack → extract → cp → install → symlink → register)
 *   (h) register via lib.generator.createFileFromDataSync (gina.db auto-sync)
 *   (i) NEVER writes def_framework (additive — never changes the default)
 *   (j) symlink skipped when the active install is a real (non-symlink) dir
 *   (k) --force / --dry-run gating
 *   (l) negative invariants — no def_framework write, no metadata seeding, no CmdHelper
 *   (m) arguments.json — reuses existing flags, --version NOT registered
 *   (n) docs surfaces — help.txt line + man page entry
 *   (o) pure-logic replica (behavioural)
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var commentStrip = require('../strip-comments');

var ADD_SOURCE = path.join(require('../fw'), 'lib/cmd/framework/add.js');
var ARGS_FILE  = path.join(require('../fw'), 'lib/cmd/framework/arguments.json');
var HELP_TXT   = path.join(require('../fw'), 'lib/cmd/framework/help.txt');
var MAN_PAGE   = path.join(require('../fw'), 'lib/cmd/gina-framework.1.md');

var src     = fs.readFileSync(ADD_SOURCE, 'utf8');
var argsArr = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8'));
var helpTxt = fs.readFileSync(HELP_TXT, 'utf8');
var manPage = fs.readFileSync(MAN_PAGE, 'utf8');

// Comment-stripped source for negative-invariant pins, so a forbidden token
// mentioned in JSDoc/comments (e.g. "def_framework" in prose, a map name) cannot
// trip a code-absence assertion. (jsdoc.md: "A negative source pin trips on the
// file's own JSDoc".)
var srcNoComments = commentStrip.all(src);


// ---------------------------------------------------------------------------
// 01 — Module shape
// ---------------------------------------------------------------------------

describe('01 - module shape', function () {

    it('exports the Add constructor', function () {
        assert.match(src, /module\.exports\s*=\s*Add;?/);
    });

    it('declares a function Add(opt)', function () {
        assert.match(src, /function\s+Add\s*\(\s*opt\s*\)\s*\{/);
    });

    it('uses lib.logger as console', function () {
        assert.match(src, /var console\s*=\s*lib\.logger;/);
    });

    it('uses fs + path + os + execSync from Node.js', function () {
        assert.match(src, /var fs\s*=\s*require\('fs'\);/);
        assert.match(src, /var nodePath\s*=\s*require\('path'\);/);
        assert.match(src, /var os\s*=\s*require\('os'\);/);
        assert.match(src, /var execSync\s*=\s*require\('child_process'\)\.execSync;/);
    });

    it('runs init() at the end of the constructor', function () {
        assert.match(src, /\n\s*init\(\);\s*\n\}/);
    });
});


// ---------------------------------------------------------------------------
// 02 — Reuses utils/runtime; shells out for the real work
// ---------------------------------------------------------------------------

describe('02 - runtime reuse + shell-out', function () {

    it('requires the shared runtime helper from utils/ (5x ../ to package root)', function () {
        assert.match(src, /var runtime\s*=\s*require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/utils\/runtime\.js'\);/);
    });

    it('install command is Bun-aware (runtime.isBun) — zero Node delta', function () {
        assert.match(src, /runtime\.isBun\(\)/);
        assert.match(src, /'bun install'/);
        assert.match(src, /'npm install'/);
    });

    it('DOES shell out (download/extract/install are the feature)', function () {
        // Unlike framework:update, add.js legitimately runs npm/tar.
        assert.match(src, /require\('child_process'\)/);
        assert.match(src, /execSync\(/);
    });
});


// ---------------------------------------------------------------------------
// 03 — homedir + install-root resolution
// ---------------------------------------------------------------------------

describe('03 - path roots', function () {

    it('resolveHomeDir prefers the GINA_HOMEDIR override (mirrors lib/state.js)', function () {
        assert.match(src, /var override = getEnvVar\('GINA_HOMEDIR'\);/);
    });

    it('resolveGinaDir reads GINA_DIR for the active install root', function () {
        assert.match(src, /getEnvVar\('GINA_DIR'\)/);
    });
});


// ---------------------------------------------------------------------------
// 04 — version positional parse + validation
// ---------------------------------------------------------------------------

describe('04 - version arg', function () {

    it('reads the first non-flag positional from argv', function () {
        assert.match(src, /for \(var i = 3; i < process\.argv\.length; i\+\+\)/);
        assert.match(src, /charAt\(0\) !== '-'/);
    });

    it('strips a leading v and validates semver before doing anything', function () {
        assert.match(src, /\.replace\(\/\^v\/, ''\)/);
        assert.match(src, /is not a valid version/);
    });

    it('derives the short (major.minor)', function () {
        assert.match(src, /\.splice\(0, 2\)\.join\('\.'\)/);
    });
});


// ---------------------------------------------------------------------------
// 05 — flag reading
// ---------------------------------------------------------------------------

describe('05 - flag reading', function () {

    it('reads bare --force / --dry-run via an argv scan', function () {
        assert.match(src, /var hasFlag\s*=\s*function/);
        assert.match(src, /hasFlag\('force'\)/);
        assert.match(src, /hasFlag\('dry-run'\)/);
    });

    it('reads --format=value (argv first, process.gina fallback)', function () {
        assert.match(src, /var readFlagValue\s*=\s*function/);
        assert.match(src, /readFlagValue\('format'\)/);
        assert.match(src, /process\.gina\[envKey\]/);
    });
});


// ---------------------------------------------------------------------------
// 06 — path construction
// ---------------------------------------------------------------------------

describe('06 - paths', function () {

    it('archive dir is ~/.gina/archives/framework/v<version>', function () {
        assert.match(src, /_\(homeDir \+ '\/archives\/framework\/v' \+ version, true\)/);
    });

    it('install dir is <GINA_DIR>/framework/v<version>', function () {
        assert.match(src, /_\(ginaDir \+ '\/framework\/v' \+ version, true\)/);
    });

    it('uses a temp dir under os.tmpdir()', function () {
        assert.match(src, /os\.tmpdir\(\)/);
    });
});


// ---------------------------------------------------------------------------
// 07 — the six pipeline steps
// ---------------------------------------------------------------------------

describe('07 - pipeline steps', function () {

    it('1. downloads via npm pack gina@<version>', function () {
        assert.match(src, /' pack gina@' \+ version/);
        assert.match(src, /--pack-destination/);
    });

    it('2. extracts the tarball with tar -xzf', function () {
        assert.match(src, /tar -xzf /);
    });

    it('3. copies the tree into the archive via fs.cpSync (recursive)', function () {
        assert.match(src, /fs\.cpSync\(extracted, archiveDir, \{ recursive: true \}\)/);
    });

    it('4. installs the archived tree deps (npm_config_global=false, like start.js)', function () {
        assert.match(src, /run\(installCmd\(\), archiveDir\)/);
        assert.match(src, /npm_config_global = false/);
    });

    it('5. symlinks the archive into the active install', function () {
        assert.match(src, /fs\.symlinkSync\(archiveDir, installDir\)/);
    });

    it('6. registers via push-if-absent then createFileFromDataSync', function () {
        assert.match(src, /if \(!Array\.isArray\(main\.frameworks\[short\]\)\) main\.frameworks\[short\] = \[\];/);
        assert.match(src, /main\.frameworks\[short\]\.indexOf\(version\) < 0/);
        assert.match(src, /main\.frameworks\[short\]\.push\(version\)/);
        assert.match(src, /lib\.generator\.createFileFromDataSync\(main, mainPath\)/);
    });
});


// ---------------------------------------------------------------------------
// 08 — additive: NEVER changes def_framework
// ---------------------------------------------------------------------------

describe('08 - never changes def_framework', function () {

    it('does NOT assign main.def_framework (additive — adding never sets the default)', function () {
        assert.doesNotMatch(srcNoComments, /main\.def_framework\s*=[^=]/);
        assert.doesNotMatch(srcNoComments, /\.def_framework\s*=[^=]/);
    });

    it('only READS def_framework for the summary', function () {
        assert.match(src, /requireJSON\(mainPath\)\.def_framework/);
    });

    it('does NOT touch settings.json at all', function () {
        assert.doesNotMatch(srcNoComments, /settings\.def_framework/);
        assert.doesNotMatch(srcNoComments, /settings\.version/);
    });
});


// ---------------------------------------------------------------------------
// 09 — symlink skip when the active install is a real dir
// ---------------------------------------------------------------------------

describe('09 - symlink skip on active install', function () {

    it('detects a real (non-symlink) install dir', function () {
        assert.match(src, /installIsRealDir/);
        assert.match(src, /lstatSync\(installDir\)\.isSymbolicLink\(\)/);
    });

    it('skips the symlink rather than clobbering the active version', function () {
        assert.match(src, /skipping symlink/);
    });
});


// ---------------------------------------------------------------------------
// 10 — --force / --dry-run gating
// ---------------------------------------------------------------------------

describe('10 - force / dry-run gates', function () {

    it('refuses an existing archive without --force', function () {
        assert.match(src, /archiveExists && !force/);
        assert.match(src, /already archived/);
    });

    it('--dry-run prints the plan and writes nothing', function () {
        assert.match(src, /if \(dryRun\) \{/);
        assert.match(src, /no changes will be made/);
    });
});


// ---------------------------------------------------------------------------
// 11 — negative invariants
// ---------------------------------------------------------------------------

describe('11 - negative invariants', function () {

    it('does NOT seed per-version metadata maps', function () {
        assert.doesNotMatch(srcNoComments, /main\.(protocols|schemes|scopes|envs|cultures|log_levels)/);
        assert.doesNotMatch(srcNoComments, /(protocols|schemes|scopes|envs|cultures|log_levels)\]\s*\[[^\]]*\]\s*=/);
    });

    it('declares SEED_MAPS for the new-short warning only', function () {
        assert.match(src, /var SEED_MAPS\s*=\s*\['protocols', 'schemes', 'scopes', 'envs', 'cultures', 'log_levels'\];/);
    });

    it('does NOT use CmdHelper (it is a no-project framework command)', function () {
        assert.doesNotMatch(srcNoComments, /new CmdHelper/);
    });

    it('routes the state write through createFileFromDataSync, not raw fs.writeFileSync', function () {
        assert.doesNotMatch(srcNoComments, /fs\.writeFileSync/);
    });
});


// ---------------------------------------------------------------------------
// 12 — arguments.json
// ---------------------------------------------------------------------------

describe('12 - arguments.json', function () {

    it('reuses the already-registered --force / --dry-run / --format flags', function () {
        ['--force', '--dry-run', '--format'].forEach(function (f) {
            assert.ok(argsArr.indexOf(f) > -1, f + ' must be registered in framework/arguments.json');
        });
    });

    it('does NOT register --version (the version is a positional, and --version is reserved)', function () {
        assert.strictEqual(argsArr.indexOf('--version'), -1);
    });
});


// ---------------------------------------------------------------------------
// 13 — docs surfaces
// ---------------------------------------------------------------------------

describe('13 - docs surfaces', function () {

    it('help.txt documents framework:add', function () {
        assert.match(helpTxt, /\$ gina framework:add/);
    });

    it('gina-framework.1.md has an add TASKS entry', function () {
        assert.match(manPage, /\*\*add\*\*/);
    });
});


// ---------------------------------------------------------------------------
// 14 — error paths
// ---------------------------------------------------------------------------

describe('14 - error paths', function () {

    it('a single fatal egress (console.error + process.exit(1))', function () {
        assert.match(src, /var fail\s*=\s*function/);
        assert.match(src, /process\.exit\(1\)/);
    });

    it('errors clearly when the version is unpublished / network fails', function () {
        assert.match(src, /unpublished version or network error/);
    });

    it('errors when the tarball lacks framework/v<version> (old layout)', function () {
        assert.match(src, /does not contain framework\/v/);
    });
});


// ---------------------------------------------------------------------------
// 15 — pure-logic replica (behavioural)
// ---------------------------------------------------------------------------

describe('15 - pure-logic replica', function () {

    // Mirror of registerVersion (push-if-absent into frameworks[<short>]).
    function registerVersion(main, short, version) {
        if (!main.frameworks) main.frameworks = {};
        if (!Array.isArray(main.frameworks[short])) main.frameworks[short] = [];
        if (main.frameworks[short].indexOf(version) < 0) { main.frameworks[short].push(version); return true; }
        return false;
    }
    // Mirror of readVersionArg (first non-flag positional from index 3).
    function firstPositional(argv) {
        for (var i = 3; i < argv.length; i++) {
            var t = argv[i];
            if (typeof t === 'string' && t.length && t.charAt(0) !== '-') return t;
        }
        return null;
    }
    function normalize(raw) { return String(raw).replace(/^v/, ''); }
    function isValid(v) { return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v); }
    function shortOf(v) { return v.split(/\./g).splice(0, 2).join('.'); }
    function shouldSkipSymlink(installExists, isSymlink) { return installExists && !isSymlink; }
    function refuseExistingArchive(archiveExists, force) { return archiveExists && !force; }

    it('registerVersion pushes an absent version and reports the change', function () {
        var main = { def_framework: '0.5.5-alpha.2', frameworks: { '0.4': ['0.4.0'] } };
        var changed = registerVersion(main, '0.4', '0.4.7');
        assert.equal(changed, true);
        assert.deepEqual(main.frameworks['0.4'], ['0.4.0', '0.4.7']);
    });

    it('registerVersion is a no-op when already present', function () {
        var main = { frameworks: { '0.4': ['0.4.7'] } };
        var changed = registerVersion(main, '0.4', '0.4.7');
        assert.equal(changed, false);
        assert.deepEqual(main.frameworks['0.4'], ['0.4.7']);
    });

    it('registerVersion creates the short array when brand new', function () {
        var main = { frameworks: {} };
        registerVersion(main, '0.4', '0.4.7');
        assert.deepEqual(main.frameworks['0.4'], ['0.4.7']);
    });

    it('registerVersion NEVER touches def_framework', function () {
        var main = { def_framework: '0.5.5-alpha.2', frameworks: {} };
        registerVersion(main, '0.4', '0.4.7');           // add an OLDER version
        assert.equal(main.def_framework, '0.5.5-alpha.2', 'default must be unchanged');
    });

    it('firstPositional finds the version after the task token', function () {
        assert.equal(firstPositional(['node', 'cli', 'framework:add', '0.4.7', '--force']), '0.4.7');
    });

    it('firstPositional skips leading flags', function () {
        assert.equal(firstPositional(['node', 'cli', 'framework:add', '--force', '0.4.7']), '0.4.7');
    });

    it('firstPositional returns null when no version is given', function () {
        assert.equal(firstPositional(['node', 'cli', 'framework:add', '--dry-run']), null);
    });

    it('normalize strips a leading v', function () {
        assert.equal(normalize('v0.4.7'), '0.4.7');
        assert.equal(normalize('0.4.7'), '0.4.7');
    });

    it('isValid accepts stable + prerelease, rejects partial/garbage', function () {
        assert.equal(isValid('0.4.7'), true);
        assert.equal(isValid('0.3.7-alpha.2'), true);
        assert.equal(isValid('0.4'), false);
        assert.equal(isValid('nope'), false);
    });

    it('shortOf derives major.minor', function () {
        assert.equal(shortOf('0.4.7'), '0.4');
        assert.equal(shortOf('0.3.7-alpha.2'), '0.3');
    });

    it('shouldSkipSymlink only when a REAL dir occupies the install path', function () {
        assert.equal(shouldSkipSymlink(true, false), true);   // real dir → skip
        assert.equal(shouldSkipSymlink(true, true), false);   // stale symlink → replace
        assert.equal(shouldSkipSymlink(false, false), false); // absent → create
    });

    it('refuseExistingArchive only without --force', function () {
        assert.equal(refuseExistingArchive(true, false), true);
        assert.equal(refuseExistingArchive(true, true), false);
        assert.equal(refuseExistingArchive(false, false), false);
    });
});
