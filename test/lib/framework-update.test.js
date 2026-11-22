/**
 * lib/cmd/framework/update.js — reconcile ~/.gina state to the installed version.
 *
 * `framework:update` is a STATE-MIGRATION command (NOT an npm self-update — see
 * the §10 negative invariants). It runs inside the CLI bootstrap with the gina
 * globals injected (GINA_HOMEDIR / GINA_VERSION / _ / requireJSON / lib), which
 * is heavy to replicate, so the bulk of these tests are source-inspection pins
 * (same style as connector-migrate.test.js / project-restore.test.js). The
 * behaviour that CAN be exercised in isolation — the scalar-check classification
 * and the reconcile decision (including the strict-semver "never regress" guard)
 * — is covered by a pure-logic replica driven by the REAL script/version_compare
 * module (§14), so a refactor that breaks the regression semantics fails here.
 *
 * Pinned structure:
 *   (a) module shape — function Update(opt), exports, console=lib.logger
 *   (b) reuses script/version_compare (single source of truth for semver)
 *   (c) homedir resolution mirrors lib/state.js (getEnvVar GINA_HOMEDIR first)
 *   (d) target/short derivation (--to-version || GINA_VERSION, semver-validated)
 *   (e) flag reading — argv-first + process.gina fallback; --fix/--apply/--dry-run
 *   (f) scalarCheck + regression guard
 *   (g) frameworks[<short>] membership (always reconcilable — register version)
 *   (h) applyFixes via lib.generator.createFileFromDataSync (gina.db auto-sync)
 *   (i) emitText / emitJson
 *   (j) SEED_MAPS + deferred metadata-seeding warning
 *   (k) §6 negative invariants — no metadata seeding, no npm self-update,
 *       no raw fs.writeFileSync, no CmdHelper
 *   (l) arguments.json — new flags registered, --version NOT registered
 *   (m) man page desc fixed + help.txt line
 *   (n) error paths + exit codes
 *   (o) pure-logic replica (behavioural)
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var commentStrip = require('../strip-comments');

var UPDATE_SOURCE  = path.join(require('../fw'), 'lib/cmd/framework/update.js');
var ARGS_FILE      = path.join(require('../fw'), 'lib/cmd/framework/arguments.json');
var HELP_TXT       = path.join(require('../fw'), 'lib/cmd/framework/help.txt');
var MAN_PAGE       = path.join(require('../fw'), 'lib/cmd/gina-framework.1.md');
var VERSION_CMP    = path.join(__dirname, '..', '..', 'script', 'version_compare.js');

var src      = fs.readFileSync(UPDATE_SOURCE, 'utf8');
var argsArr  = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8'));
var helpTxt  = fs.readFileSync(HELP_TXT, 'utf8');
var manPage  = fs.readFileSync(MAN_PAGE, 'utf8');

// Comment-stripped source for negative-invariant pins, so a forbidden token
// mentioned in JSDoc/comments (e.g. "npm self-update", a map name in prose)
// cannot trip a code-absence assertion. (jsdoc.md: "A negative source pin trips
// on the file's own JSDoc".)
var srcNoComments = commentStrip.all(src);


// ---------------------------------------------------------------------------
// 01 — Module shape
// ---------------------------------------------------------------------------

describe('01 - module shape', function () {

    it('exports the Update constructor', function () {
        assert.match(src, /module\.exports\s*=\s*Update;?/);
    });

    it('declares a function Update(opt)', function () {
        assert.match(src, /function\s+Update\s*\(\s*opt\s*\)\s*\{/);
    });

    it('uses lib.logger as console', function () {
        assert.match(src, /var console\s*=\s*lib\.logger;/);
    });

    it('uses fs + path from Node.js', function () {
        assert.match(src, /var fs\s*=\s*require\('fs'\);/);
        assert.match(src, /var nodePath\s*=\s*require\('path'\);/);
    });

    it('runs init() at the end of the constructor', function () {
        assert.match(src, /\n\s*init\(\);\s*\n\}/);
    });
});


// ---------------------------------------------------------------------------
// 02 — Reuses script/version_compare (single source of truth for semver)
// ---------------------------------------------------------------------------

describe('02 - version_compare reuse', function () {

    it('requires the shared install-time comparator from script/', function () {
        assert.match(src, /var versionCompare\s*=\s*require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/script\/version_compare'\);/);
    });

    it('uses isStrictlyOlder for the never-regress guard', function () {
        assert.match(src, /versionCompare\.isStrictlyOlder\(target,\s*main\.def_framework\)/);
    });

    it('the comparator module is present on disk (ships to npm)', function () {
        assert.ok(fs.existsSync(VERSION_CMP), 'script/version_compare.js must exist (it is not in the .npmignore denylist)');
        var vc = require(VERSION_CMP);
        assert.equal(typeof vc.isStrictlyOlder, 'function');
    });
});


// ---------------------------------------------------------------------------
// 03 — Homedir resolution (mirrors lib/state.js so isStatePath matches)
// ---------------------------------------------------------------------------

describe('03 - homedir resolution', function () {

    it('declares resolveHomeDir()', function () {
        assert.match(src, /var resolveHomeDir\s*=\s*function \(\) \{/);
    });

    it('prefers getEnvVar(GINA_HOMEDIR) first (matches StateStore._homeDir)', function () {
        assert.match(src, /getEnvVar\('GINA_HOMEDIR'\)/);
    });

    it('falls back to the GINA_HOMEDIR global, then os.homedir()/.gina', function () {
        assert.match(src, /typeof\(GINA_HOMEDIR\)\s*!==\s*'undefined'/);
        assert.match(src, /require\('os'\)\.homedir\(\)\s*\+\s*nodePath\.sep\s*\+\s*'\.gina'/);
    });
});


// ---------------------------------------------------------------------------
// 04 — Target + short derivation
// ---------------------------------------------------------------------------

describe('04 - target derivation', function () {

    it('defaults the target to GINA_VERSION when --to-version is absent', function () {
        assert.match(src, /readFlagValue\('to-version'\)\s*\|\|\s*\(typeof\(GINA_VERSION\)/);
    });

    it('validates the target looks like a semver', function () {
        assert.match(src, /\/\^v\?\\d\+\\\.\\d\+\\\.\\d\+\/\.test/);
    });

    it('strips a leading v and derives major.minor as the short', function () {
        assert.match(src, /\.replace\(\/\^v\/,\s*''\)/);
        assert.match(src, /split\(\/\\\.\/g\)\.splice\(0,\s*2\)\.join\('\.'\)/);
    });
});


// ---------------------------------------------------------------------------
// 05 — Flag reading (no CmdHelper — argv-first + process.gina fallback)
// ---------------------------------------------------------------------------

describe('05 - flag reading', function () {

    it('declares hasFlag(name) for bare boolean flags', function () {
        assert.match(src, /var hasFlag\s*=\s*function \(name\) \{/);
    });

    it('declares readFlagValue(name) for --name=value flags', function () {
        assert.match(src, /var readFlagValue\s*=\s*function \(name\) \{/);
    });

    it('readFlagValue reads argv first then process.gina.GINA_<NAME>', function () {
        assert.match(src, /var prefix\s*=\s*'--'\s*\+\s*name\s*\+\s*'=';/);
        assert.match(src, /var envKey\s*=\s*'GINA_'\s*\+\s*name\.replace\(\/-\/g,\s*'_'\)\.toUpperCase\(\);/);
        assert.match(src, /process\.gina\[envKey\]/);
    });

    it('--fix OR --apply enables the write; --dry-run forces read-only', function () {
        assert.match(src, /var fix\s*=\s*hasFlag\('fix'\)\s*\|\|\s*hasFlag\('apply'\);/);
        assert.match(src, /var dryRun\s*=\s*hasFlag\('dry-run'\);/);
        assert.match(src, /var write\s*=\s*fix\s*&&\s*!dryRun;/);
    });
});


// ---------------------------------------------------------------------------
// 06 — scalarCheck + regression guard
// ---------------------------------------------------------------------------

describe('06 - scalarCheck', function () {

    it('declares scalarCheck(file, field, current, target, regress)', function () {
        assert.match(src, /var scalarCheck\s*=\s*function \(file, field, current, target, regress\) \{/);
    });

    it('equal values are in-sync', function () {
        assert.match(src, /if \(current === target\) \{[\s\S]*?status: 'in-sync'/);
    });

    it('a strictly-older target is regression-skip (preserve recorded)', function () {
        assert.match(src, /if \(regress\) \{[\s\S]*?status: 'regression-skip'/);
    });

    it('otherwise it is drift (fixable)', function () {
        assert.match(src, /status: 'drift', fixable: true/);
    });
});


// ---------------------------------------------------------------------------
// 07 — frameworks[<short>] membership
// ---------------------------------------------------------------------------

describe('07 - frameworks membership', function () {

    it('checks Array membership of the target in frameworks[<short>]', function () {
        assert.match(src, /main\.frameworks\[targetShort\]/);
        assert.match(src, /list\.indexOf\(target\)\s*>\s*-1/);
    });

    it('an absent target is a fixable drift', function () {
        assert.match(src, /status\s*:\s*listed\s*\?\s*'in-sync'\s*:\s*'drift'/);
        assert.match(src, /fixable\s*:\s*!listed/);
    });
});


// ---------------------------------------------------------------------------
// 08 — applyFixes (writes via createFileFromDataSync; gina.db auto-syncs)
// ---------------------------------------------------------------------------

describe('08 - applyFixes', function () {

    it('declares applyFixes(report, main, settings, mainPath, settingsPath, target, targetShort, regress)', function () {
        assert.match(src, /var applyFixes\s*=\s*function \(report, main, settings, mainPath, settingsPath, target, targetShort, regress\) \{/);
    });

    it('reconciles main.def_framework when fixable', function () {
        assert.match(src, /main\.def_framework = target;/);
    });

    it('registers the target in frameworks[<short>] (creates the array if missing)', function () {
        assert.match(src, /if \(!Array\.isArray\(main\.frameworks\[targetShort\]\)\) main\.frameworks\[targetShort\] = \[\];/);
        assert.match(src, /main\.frameworks\[targetShort\]\.push\(target\);/);
    });

    it('reconciles settings.version + settings.def_framework when fixable', function () {
        assert.match(src, /settings\.version = target;/);
        assert.match(src, /settings\.def_framework = target;/);
    });

    it('persists through lib.generator.createFileFromDataSync (state-store routed)', function () {
        assert.match(src, /lib\.generator\.createFileFromDataSync\(main, mainPath\);/);
        assert.match(src, /lib\.generator\.createFileFromDataSync\(settings, settingsPath\);/);
    });
});


// ---------------------------------------------------------------------------
// 09 — emitText / emitJson
// ---------------------------------------------------------------------------

describe('09 - output', function () {

    it('declares emitText(report) and emitJson(report)', function () {
        assert.match(src, /var emitText\s*=\s*function \(report\) \{/);
        assert.match(src, /var emitJson\s*=\s*function \(report\) \{/);
    });

    it('uses [fix] vs [dry-run] prefix', function () {
        assert.match(src, /var prefix\s*=\s*\(report\.mode === 'fix'\)\s*\?\s*'\[fix\]'\s*:\s*'\[dry-run\]';/);
    });

    it('emitJson exposes inSync + the regression-guard flag for programmatic consumers', function () {
        assert.match(src, /inSync\s*:\s*report\.inSync/);
        assert.match(src, /regressionGuard\s*:\s*report\.regress/);
    });

    it('text output labels regression-skip explicitly', function () {
        assert.match(src, /SKIPPED \(regression guard/);
    });
});


// ---------------------------------------------------------------------------
// 10 — §6 negative invariants
// ---------------------------------------------------------------------------

describe('10 - negative invariants (state-reconcile, not self-update)', function () {

    it('does NOT seed per-version metadata maps (only checks their presence)', function () {
        // No dot-access by map name on `main` — the handler reads via main[m]
        // (variable bracket) and never assigns protocols/schemes/scopes/etc.
        assert.doesNotMatch(srcNoComments, /main\.(protocols|schemes|scopes|envs|cultures|log_levels)/);
        // No bracket-assignment to any of those maps either.
        assert.doesNotMatch(srcNoComments, /(protocols|schemes|scopes|envs|cultures|log_levels)\]\s*\[[^\]]*\]\s*=/);
    });

    it('declares SEED_MAPS for presence-checking only', function () {
        assert.match(src, /var SEED_MAPS\s*=\s*\['protocols', 'schemes', 'scopes', 'envs', 'cultures', 'log_levels'\];/);
    });

    it('does NOT shell out to npm (no self-update)', function () {
        assert.ok(srcNoComments.indexOf("require('child_process')") === -1, 'no child_process require');
        assert.doesNotMatch(srcNoComments, /\bexecSync\s*\(/);
        assert.doesNotMatch(srcNoComments, /\bspawn(Sync)?\s*\(/);
    });

    it('does NOT use raw fs.writeFileSync for state (routes through createFileFromDataSync)', function () {
        assert.doesNotMatch(srcNoComments, /fs\.writeFileSync/);
    });

    it('does NOT use CmdHelper (it is a no-project framework command)', function () {
        assert.doesNotMatch(srcNoComments, /new CmdHelper/);
        assert.doesNotMatch(srcNoComments, /isCmdConfigured/);
    });
});


// ---------------------------------------------------------------------------
// 11 — arguments.json
// ---------------------------------------------------------------------------

describe('11 - arguments.json', function () {

    it('registers --to-version, --fix, --apply, --dry-run, --format', function () {
        ['--to-version', '--fix', '--apply', '--dry-run', '--format'].forEach(function (f) {
            assert.ok(argsArr.indexOf(f) > -1, f + ' must be registered in framework/arguments.json');
        });
    });

    it('does NOT register --version (reserved → selects the framework dir)', function () {
        assert.strictEqual(argsArr.indexOf('--version'), -1);
    });
});


// ---------------------------------------------------------------------------
// 12 — man page + help.txt
// ---------------------------------------------------------------------------

describe('12 - docs surfaces', function () {

    it('gina-framework.1.md update entry no longer copy-pastes the status description', function () {
        // The stub used the -t/--status wording ("Get status of the framework.")
        // on the update entry; it must now describe the reconcile.
        assert.doesNotMatch(manPage, /\*\*update\*\*\s*\n\s*Get status of the framework\./);
        assert.match(manPage, /\*\*update\*\*/);
        assert.match(manPage, /[Rr]econcile/);
    });

    it('framework help.txt advertises framework:update', function () {
        assert.match(helpTxt, /framework:update/);
    });
});


// ---------------------------------------------------------------------------
// 13 — Error paths + exit codes
// ---------------------------------------------------------------------------

describe('13 - error paths', function () {

    it('errors when main.json is not found', function () {
        assert.match(src, /not found\. Run `gina framework:init`/);
    });

    it('rejects an unknown --format value', function () {
        assert.match(src, /Unknown --format value /);
        assert.match(src, /Supported: json\./);
    });

    it('rejects a target it cannot determine', function () {
        assert.match(src, /Cannot determine a target version/);
    });

    it('exits 0 on a successful scan/report', function () {
        assert.match(src, /process\.exit\(0\);/);
    });

    it('has at least three process.exit(1) sites (format / target / main.json)', function () {
        var exit1 = (src.match(/process\.exit\(1\)/g) || []).length;
        assert.ok(exit1 >= 3, 'expected ≥3 process.exit(1) sites, got ' + exit1);
    });
});


// ---------------------------------------------------------------------------
// 14 — Pure-logic replica (behavioural — uses the REAL version_compare)
// ---------------------------------------------------------------------------

describe('14 - pure-logic replica', function () {

    var versionCompare = require(VERSION_CMP);

    // Mirror of the handler's scalarCheck classification.
    function classify(current, target, regress) {
        if (current === target) return 'in-sync';
        if (regress) return 'regression-skip';
        return 'drift';
    }

    // Mirror of the handler's reconcile (applyFixes folded with the guard).
    function reconcile(main, settings, target, short) {
        var regress = versionCompare.isStrictlyOlder(target, main.def_framework);
        if (main.def_framework !== target && !regress) main.def_framework = target;
        if (!main.frameworks) main.frameworks = {};
        if (!Array.isArray(main.frameworks[short])) main.frameworks[short] = [];
        if (main.frameworks[short].indexOf(target) < 0) main.frameworks[short].push(target);
        if (settings) {
            if (settings.version !== target && !regress) settings.version = target;
            if (settings.def_framework !== target && !regress) settings.def_framework = target;
        }
        return regress;
    }

    it('classify: equal → in-sync', function () {
        assert.equal(classify('0.5.5-alpha.2', '0.5.5-alpha.2', false), 'in-sync');
    });

    it('classify: older recorded, newer target → drift', function () {
        var regress = versionCompare.isStrictlyOlder('0.5.5-alpha.2', '0.4.8'); // false
        assert.equal(classify('0.4.8', '0.5.5-alpha.2', regress), 'drift');
    });

    it('classify: newer recorded, older target → regression-skip', function () {
        var regress = versionCompare.isStrictlyOlder('0.4.0', '0.5.5-alpha.2'); // true
        assert.equal(classify('0.5.5-alpha.2', '0.4.0', regress), 'regression-skip');
    });

    it('reconcile forward: drifted def_framework + missing list entry are fixed', function () {
        var main = { def_framework: '0.4.8', frameworks: { '0.5': ['0.5.4'] } };
        var settings = { version: '0.4.8', def_framework: '0.4.8' };
        var regress = reconcile(main, settings, '0.5.5-alpha.2', '0.5');
        assert.equal(regress, false);
        assert.equal(main.def_framework, '0.5.5-alpha.2');
        assert.ok(main.frameworks['0.5'].indexOf('0.5.5-alpha.2') > -1);
        assert.equal(settings.version, '0.5.5-alpha.2');
        assert.equal(settings.def_framework, '0.5.5-alpha.2');
    });

    it('reconcile regression: scalar preserved BUT list still registers the version', function () {
        // post_install semantics: never regress the scalar, always register the version.
        var main = { def_framework: '0.5.5-alpha.2', frameworks: { '0.4': [] } };
        var settings = { version: '0.5.5-alpha.2', def_framework: '0.5.5-alpha.2' };
        var regress = reconcile(main, settings, '0.4.0', '0.4');
        assert.equal(regress, true);
        assert.equal(main.def_framework, '0.5.5-alpha.2', 'scalar preserved on regression');
        assert.ok(main.frameworks['0.4'].indexOf('0.4.0') > -1, 'list registers the version even on regression');
        assert.equal(settings.def_framework, '0.5.5-alpha.2', 'settings scalar preserved on regression');
    });

    it('reconcile in-sync: no mutation, idempotent', function () {
        var main = { def_framework: '0.5.5-alpha.2', frameworks: { '0.5': ['0.5.5-alpha.2'] } };
        var before = JSON.stringify(main);
        reconcile(main, null, '0.5.5-alpha.2', '0.5');
        assert.equal(JSON.stringify(main), before);
    });

    it('reconcile creates the frameworks[<short>] array when the short is brand new', function () {
        var main = { def_framework: '0.4.8', frameworks: {} };
        reconcile(main, null, '0.5.0', '0.5');
        assert.deepEqual(main.frameworks['0.5'], ['0.5.0']);
    });
});
