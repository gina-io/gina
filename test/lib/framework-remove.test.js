/**
 * lib/cmd/framework/remove.js — remove a side-by-side installed framework version.
 *
 * `framework:remove` is the inverse of `framework:add`: it deregisters the version
 * from main.json frameworks[<short>], unlinks the <GINA_DIR>/framework/v* symlink,
 * and deletes the ~/.gina/archives/framework/v* copy — behind three safety gates
 * (active default + real shipped dir are hard refusals; a bundle pin is overridable
 * with --force). It runs inside the CLI bootstrap with the gina globals injected
 * (_ / requireJSON / getEnvVar / lib / GINA_DIR), heavy to replicate, so the bulk
 * of these tests are source-inspection pins (same style as framework-add.test.js).
 * The decision + mutation logic that CAN be exercised in isolation — the gates, the
 * deregister splice, the plan derivation, idempotency — is covered by a pure-logic
 * replica (§14).
 *
 * Pinned structure:
 *   (a) module shape — function Remove(opt), exports, console=lib.logger
 *   (b) no shell-out (read + fs mutation only)
 *   (c) homedir / install-root resolution mirrors add.js
 *   (d) version positional parse + semver validation + short derivation
 *   (e) flag reading — --force / --dry-run (bare) + --format (=value)
 *   (f) path construction — archive / install / main / projects
 *   (g) inverse ops — deregister splice + drop-empty-key, unlink, rmSync, createFileFromDataSync
 *   (h) HARD gates — def_framework + real-dir refusals (NOT --force overridable)
 *   (i) SOFT gate — bundle-pin scan, --force override
 *   (j) idempotency — nothing-to-remove clean exit
 *   (k) NEVER writes def_framework
 *   (l) arguments.json — reuses --force / --dry-run / --format
 *   (m) docs surfaces — help.txt line + man page entry
 *   (n) pure-logic replica (behavioural)
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var commentStrip = require('../strip-comments');

var RM_SOURCE = path.join(require('../fw'), 'lib/cmd/framework/remove.js');
var ARGS_FILE = path.join(require('../fw'), 'lib/cmd/framework/arguments.json');
var HELP_TXT  = path.join(require('../fw'), 'lib/cmd/framework/help.txt');
var MAN_PAGE  = path.join(require('../fw'), 'lib/cmd/gina-framework.1.md');

var src     = fs.readFileSync(RM_SOURCE, 'utf8');
var argsArr = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8'));
var helpTxt = fs.readFileSync(HELP_TXT, 'utf8');
var manPage = fs.readFileSync(MAN_PAGE, 'utf8');

// Comment-stripped source for negative-invariant pins, so a forbidden token
// mentioned in JSDoc/comments cannot trip a code-absence assertion.
// (jsdoc.md: "A negative source pin trips on the file's own JSDoc".)
var srcNoComments = commentStrip.all(src);


// ---------------------------------------------------------------------------
// 01 — Module shape
// ---------------------------------------------------------------------------

describe('01 - module shape', function () {

    it('exports the Remove constructor', function () {
        assert.match(src, /module\.exports\s*=\s*Remove;?/);
    });

    it('declares a function Remove(opt)', function () {
        assert.match(src, /function\s+Remove\s*\(\s*opt\s*\)\s*\{/);
    });

    it('uses lib.logger as console', function () {
        assert.match(src, /var console\s*=\s*lib\.logger;/);
    });

    it('uses fs + path + os from Node.js', function () {
        assert.match(src, /var fs\s*=\s*require\('fs'\);/);
        assert.match(src, /var nodePath\s*=\s*require\('path'\);/);
        assert.match(src, /var os\s*=\s*require\('os'\);/);
    });

    it('runs init() at the end of the constructor', function () {
        assert.match(src, /\n\s*init\(\);\s*\n\}/);
    });
});


// ---------------------------------------------------------------------------
// 02 — no shell-out (a local fs operation, not a network/registry op)
// ---------------------------------------------------------------------------

describe('02 - no shell-out', function () {

    it('does NOT spawn npm/tar (unlike add.js — removal is local)', function () {
        assert.doesNotMatch(srcNoComments, /require\('child_process'\)/);
        assert.doesNotMatch(srcNoComments, /execSync/);
    });
});


// ---------------------------------------------------------------------------
// 03 — path roots
// ---------------------------------------------------------------------------

describe('03 - path roots', function () {

    it('resolveHomeDir prefers the GINA_HOMEDIR override', function () {
        assert.match(src, /var override = getEnvVar\('GINA_HOMEDIR'\);/);
    });

    it('resolveGinaDir reads GINA_DIR for the active install root', function () {
        assert.match(src, /getEnvVar\('GINA_DIR'\)/);
    });
});


// ---------------------------------------------------------------------------
// 04 — version arg + validation
// ---------------------------------------------------------------------------

describe('04 - version arg', function () {

    it('reads the first non-flag positional from argv', function () {
        assert.match(src, /for \(var i = 3; i < process\.argv\.length; i\+\+\)/);
        assert.match(src, /charAt\(0\) !== '-'/);
    });

    it('strips a leading v and validates semver', function () {
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
        assert.match(src, /hasFlag\('force'\)/);
        assert.match(src, /hasFlag\('dry-run'\)/);
    });

    it('reads --format=value', function () {
        assert.match(src, /readFlagValue\('format'\)/);
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

    it('reads main.json and projects.json', function () {
        assert.match(src, /_\(homeDir \+ '\/main\.json', true\)/);
        assert.match(src, /_\(homeDir \+ '\/projects\.json', true\)/);
    });
});


// ---------------------------------------------------------------------------
// 07 — inverse operations
// ---------------------------------------------------------------------------

describe('07 - inverse ops', function () {

    it('deregisters by splicing the version out and dropping an emptied key', function () {
        assert.match(src, /main\.frameworks\[short\]\.splice\(idx, 1\)/);
        assert.match(src, /delete main\.frameworks\[short\]/);
    });

    it('writes the registry via createFileFromDataSync (not raw fs.writeFileSync)', function () {
        assert.match(src, /lib\.generator\.createFileFromDataSync\(main, mainPath\)/);
        assert.doesNotMatch(srcNoComments, /fs\.writeFileSync/);
    });

    it('unlinks the symlink and deletes the archive', function () {
        assert.match(src, /fs\.unlinkSync\(installDir\)/);
        assert.match(src, /fs\.rmSync\(archiveDir, \{ recursive: true, force: true \}\)/);
    });
});


// ---------------------------------------------------------------------------
// 08 — HARD gates (not --force overridable)
// ---------------------------------------------------------------------------

describe('08 - hard gates', function () {

    it('refuses the active default (def_framework)', function () {
        assert.match(src, /version === def/);
        assert.match(src, /is the active default/);
    });

    it('refuses the real shipped framework dir (lstat isSymbolicLink / isDirectory)', function () {
        assert.match(src, /fs\.lstatSync\(installDir\)/);
        assert.match(src, /\.isSymbolicLink\(\)/);
        assert.match(src, /\.isDirectory\(\)/);
        assert.match(src, /is the real framework dir/);
    });

    it('the hard gates fire before the --force-gated pin check (force cannot reach them)', function () {
        var defIdx  = src.indexOf('is the active default');
        var realIdx = src.indexOf('is the real framework dir');
        var pinIdx  = src.indexOf('is pinned by bundle');
        assert.ok(defIdx > -1 && realIdx > -1 && pinIdx > -1);
        assert.ok(defIdx < pinIdx, 'def gate precedes the pin gate');
        assert.ok(realIdx < pinIdx, 'real-dir gate precedes the pin gate');
    });
});


// ---------------------------------------------------------------------------
// 09 — SOFT gate (bundle pin, --force overridable)
// ---------------------------------------------------------------------------

describe('09 - pin gate', function () {

    it('scans projects for a bundle pin via manifest gina_version', function () {
        assert.match(src, /var scanPinnedBy\s*=\s*function/);
        assert.match(src, /gina_version/);
        assert.match(src, /manifest\.json/);
    });

    it('refuses a pinned version without --force, warns with --force', function () {
        assert.match(src, /pinnedBy\.length && !force/);
        assert.match(src, /is pinned by bundle/);
        assert.match(src, /pinnedBy\.length && force/);
    });

    it('the pin scan is best-effort (per-project try/catch)', function () {
        assert.match(src, /skip an unreadable project/);
    });
});


// ---------------------------------------------------------------------------
// 10 — idempotency + dry-run
// ---------------------------------------------------------------------------

describe('10 - idempotency + dry-run', function () {

    it('nothing-to-remove exits cleanly', function () {
        assert.match(src, /!installEntryExists && !archived && !registered/);
        assert.match(src, /is not installed — nothing to remove/);
    });

    it('--dry-run previews and writes nothing', function () {
        assert.match(src, /if \(dryRun\) \{/);
        assert.match(src, /no changes will be made/);
    });
});


// ---------------------------------------------------------------------------
// 11 — never changes def_framework
// ---------------------------------------------------------------------------

describe('11 - never changes def_framework', function () {

    it('does NOT assign def_framework', function () {
        assert.doesNotMatch(srcNoComments, /\.def_framework\s*=[^=]/);
    });

    it('only READS def_framework (for the gate + summary)', function () {
        assert.match(src, /main\.def_framework/);
    });

    it('does NOT use CmdHelper', function () {
        assert.doesNotMatch(srcNoComments, /new CmdHelper/);
    });
});


// ---------------------------------------------------------------------------
// 12 — arguments.json
// ---------------------------------------------------------------------------

describe('12 - arguments.json', function () {

    it('reuses --force / --dry-run / --format', function () {
        ['--force', '--dry-run', '--format'].forEach(function (f) {
            assert.ok(argsArr.indexOf(f) > -1, f + ' must be registered');
        });
    });
});


// ---------------------------------------------------------------------------
// 13 — docs surfaces
// ---------------------------------------------------------------------------

describe('13 - docs surfaces', function () {

    it('help.txt documents framework:remove', function () {
        assert.match(helpTxt, /\$ gina framework:remove/);
    });

    it('gina-framework.1.md has a remove TASKS entry', function () {
        assert.match(manPage, /\*\*remove\*\*/);
    });
});


// ---------------------------------------------------------------------------
// 14 — pure-logic replica (behavioural)
// ---------------------------------------------------------------------------

describe('14 - pure-logic replica', function () {

    // Mirror of deregisterVersion (splice + drop-empty-key).
    function deregisterVersion(main, short, version) {
        if (!main.frameworks || !Array.isArray(main.frameworks[short])) return false;
        var idx = main.frameworks[short].indexOf(version);
        if (idx < 0) return false;
        main.frameworks[short].splice(idx, 1);
        if (main.frameworks[short].length === 0) delete main.frameworks[short];
        return true;
    }
    // Mirror of the gate decisions.
    function hardGate(version, def, isRealDir) {
        if (version === def) return 'default';
        if (isRealDir) return 'realdir';
        return null;
    }
    function pinGate(pinnedCount, force) {
        if (pinnedCount && !force) return 'refuse';
        if (pinnedCount && force) return 'warn';
        return 'ok';
    }
    function isIdempotent(installEntryExists, archived, registered) {
        return !installEntryExists && !archived && !registered;
    }
    function computePlan(s) {
        return {
            deregistered    : s.registered,
            symlinkUnlinked : s.installEntryExists && s.installIsSymlink,
            archiveRemoved  : s.archived
        };
    }

    it('deregisterVersion removes a present version and reports the change', function () {
        var main = { def_framework: '0.5.5-alpha.2', frameworks: { '0.4': ['0.4.0', '0.4.7'] } };
        assert.equal(deregisterVersion(main, '0.4', '0.4.7'), true);
        assert.deepEqual(main.frameworks['0.4'], ['0.4.0']);
    });

    it('deregisterVersion drops the short key when it empties', function () {
        var main = { frameworks: { '0.4': ['0.4.7'] } };
        deregisterVersion(main, '0.4', '0.4.7');
        assert.equal(main.frameworks['0.4'], undefined);
        assert.ok(!('0.4' in main.frameworks));
    });

    it('deregisterVersion is a no-op when the version / short is absent', function () {
        var main = { frameworks: { '0.4': ['0.4.7'] } };
        assert.equal(deregisterVersion(main, '0.4', '0.4.0'), false);
        assert.equal(deregisterVersion(main, '0.3', '0.3.0'), false);
        assert.deepEqual(main.frameworks['0.4'], ['0.4.7']);
    });

    it('deregisterVersion NEVER touches def_framework', function () {
        var main = { def_framework: '0.5.5-alpha.2', frameworks: { '0.4': ['0.4.7'] } };
        deregisterVersion(main, '0.4', '0.4.7');
        assert.equal(main.def_framework, '0.5.5-alpha.2');
    });

    it('hardGate refuses the active default (even before the real-dir check)', function () {
        assert.equal(hardGate('0.5.5-alpha.2', '0.5.5-alpha.2', false), 'default');
        assert.equal(hardGate('0.5.5-alpha.2', '0.5.5-alpha.2', true), 'default'); // default wins
    });

    it('hardGate refuses a real (non-symlink) install dir', function () {
        assert.equal(hardGate('0.1.0', '0.5.5-alpha.2', true), 'realdir');
    });

    it('hardGate allows a non-default symlink', function () {
        assert.equal(hardGate('0.4.7', '0.5.5-alpha.2', false), null);
    });

    it('pinGate: pinned blocks without --force, warns with --force, ok when unpinned', function () {
        assert.equal(pinGate(1, false), 'refuse');
        assert.equal(pinGate(1, true), 'warn');
        assert.equal(pinGate(0, false), 'ok');
        assert.equal(pinGate(0, true), 'ok');
    });

    it('isIdempotent only when nothing is present anywhere', function () {
        assert.equal(isIdempotent(false, false, false), true);
        assert.equal(isIdempotent(true, false, false), false);  // symlink present
        assert.equal(isIdempotent(false, true, false), false);  // archived
        assert.equal(isIdempotent(false, false, true), false);  // registered only
    });

    it('computePlan reflects the present surfaces', function () {
        // a normal added version: registered + symlink + archived → all three undone
        assert.deepEqual(
            computePlan({ registered: true, installEntryExists: true, installIsSymlink: true, archived: true }),
            { deregistered: true, symlinkUnlinked: true, archiveRemoved: true }
        );
        // registered-only stale entry → deregister only
        assert.deepEqual(
            computePlan({ registered: true, installEntryExists: false, installIsSymlink: false, archived: false }),
            { deregistered: true, symlinkUnlinked: false, archiveRemoved: false }
        );
        // a dangling symlink that was deregistered already → unlink only
        assert.deepEqual(
            computePlan({ registered: false, installEntryExists: true, installIsSymlink: true, archived: false }),
            { deregistered: false, symlinkUnlinked: true, archiveRemoved: false }
        );
    });
});
