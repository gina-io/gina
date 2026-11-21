/**
 * lib/cmd/framework/list.js — list the framework versions known to this install.
 *
 * `framework:list` reconciles three surfaces — `<GINA_DIR>/framework/v*` install
 * entries (real dir vs symlink), `~/.gina/archives/framework/v*`, and main.json
 * frameworks[]/def_framework — into one read-only view. It runs inside the CLI
 * bootstrap with the gina globals injected (_ / requireJSON / getEnvVar / lib /
 * GINA_DIR), which is heavy to replicate, so the bulk of these tests are
 * source-inspection pins (same style as framework-add.test.js). The reconciliation
 * logic that CAN be exercised in isolation — kind/onDisk derivation, the sort, the
 * STATUS note, version-dir filtering — is covered by a pure-logic replica (§11).
 *
 * Pinned structure:
 *   (a) module shape — function List(opt), exports, console=lib.logger
 *   (b) reuses lib.cmdStatusFormat.pad for column alignment
 *   (c) homedir / install-root resolution mirrors add.js
 *   (d) flag reading — --all (bare) + --format (=value)
 *   (e) the three surfaces (install dirs / archives / main.json registry)
 *   (f) classifyInstall via lstatSync isSymbolicLink + existsSync (resolves)
 *   (g) reconciliation + def_framework read
 *   (h) READ-ONLY — no state writes, no fs mutation, no def_framework write
 *   (i) graceful degrade when main.json is absent
 *   (j) arguments.json — --all + --format registered
 *   (k) docs surfaces — help.txt line + man page entry
 *   (l) pure-logic replica (behavioural)
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var commentStrip = require('../strip-comments');

var LIST_SOURCE = path.join(require('../fw'), 'lib/cmd/framework/list.js');
var ARGS_FILE   = path.join(require('../fw'), 'lib/cmd/framework/arguments.json');
var HELP_TXT    = path.join(require('../fw'), 'lib/cmd/framework/help.txt');
var MAN_PAGE    = path.join(require('../fw'), 'lib/cmd/gina-framework.1.md');

var src     = fs.readFileSync(LIST_SOURCE, 'utf8');
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

    it('exports the List constructor', function () {
        assert.match(src, /module\.exports\s*=\s*List;?/);
    });

    it('declares a function List(opt)', function () {
        assert.match(src, /function\s+List\s*\(\s*opt\s*\)\s*\{/);
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
// 02 — Reuses cmd-status-format
// ---------------------------------------------------------------------------

describe('02 - cmd-status-format reuse', function () {

    it('binds lib.cmdStatusFormat', function () {
        assert.match(src, /var fmt\s*=\s*lib\.cmdStatusFormat;/);
    });

    it('aligns columns with fmt.pad', function () {
        assert.match(src, /fmt\.pad\(/);
    });

    it('does NOT shell out (list is a pure read)', function () {
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
// 04 — flag reading
// ---------------------------------------------------------------------------

describe('04 - flag reading', function () {

    it('reads the bare --all flag via an argv scan', function () {
        assert.match(src, /var hasFlag\s*=\s*function/);
        assert.match(src, /hasFlag\('all'\)/);
    });

    it('reads --format=value (argv first, process.gina fallback)', function () {
        assert.match(src, /var readFlagValue\s*=\s*function/);
        assert.match(src, /readFlagValue\('format'\)/);
        assert.match(src, /process\.gina\[envKey\]/);
    });
});


// ---------------------------------------------------------------------------
// 05 — the three surfaces
// ---------------------------------------------------------------------------

describe('05 - surfaces', function () {

    it('install root is <GINA_DIR>/framework', function () {
        assert.match(src, /_\(ginaDir \+ '\/framework', true\)/);
    });

    it('archives root is ~/.gina/archives/framework', function () {
        assert.match(src, /_\(homeDir \+ '\/archives\/framework', true\)/);
    });

    it('registry is ~/.gina/main.json', function () {
        assert.match(src, /_\(homeDir \+ '\/main\.json', true\)/);
    });

    it('enumerates v<version> dirs (strips the leading v)', function () {
        assert.match(src, /\/\^v\\d\/\.test\(entry\)/);
        assert.match(src, /\.replace\(\/\^v\/, ''\)/);
    });
});


// ---------------------------------------------------------------------------
// 06 — install classification + registry read
// ---------------------------------------------------------------------------

describe('06 - classify + registry', function () {

    it('classifyInstall uses lstatSync + isSymbolicLink', function () {
        assert.match(src, /fs\.lstatSync\(installPath\)/);
        assert.match(src, /\.isSymbolicLink\(\)/);
    });

    it('resolves a symlink via existsSync (dangling => not resolved)', function () {
        assert.match(src, /resolves: fs\.existsSync\(installPath\)/);
    });

    it('reads def_framework + frameworks from main.json', function () {
        assert.match(src, /requireJSON\(mainPath\)/);
        assert.match(src, /main\.def_framework/);
        assert.match(src, /main\.frameworks/);
    });
});


// ---------------------------------------------------------------------------
// 07 — READ-ONLY invariants
// ---------------------------------------------------------------------------

describe('07 - read-only', function () {

    it('does NOT write state (no createFileFromDataSync / writeFileSync)', function () {
        assert.doesNotMatch(srcNoComments, /createFileFromDataSync/);
        assert.doesNotMatch(srcNoComments, /fs\.writeFileSync/);
    });

    it('does NOT mutate the filesystem (no symlink/unlink/rm/cp/mkdir)', function () {
        assert.doesNotMatch(srcNoComments, /fs\.symlinkSync/);
        assert.doesNotMatch(srcNoComments, /fs\.unlinkSync/);
        assert.doesNotMatch(srcNoComments, /fs\.rmSync/);
        assert.doesNotMatch(srcNoComments, /fs\.cpSync/);
        assert.doesNotMatch(srcNoComments, /fs\.mkdirSync/);
    });

    it('never assigns def_framework', function () {
        assert.doesNotMatch(srcNoComments, /\.def_framework\s*=[^=]/);
    });

    it('does NOT use CmdHelper (it is a no-project framework command)', function () {
        assert.doesNotMatch(srcNoComments, /new CmdHelper/);
    });
});


// ---------------------------------------------------------------------------
// 08 — graceful degrade
// ---------------------------------------------------------------------------

describe('08 - graceful degrade', function () {

    it('warns and continues when main.json is absent', function () {
        assert.match(src, /not found — listing on-disk dirs only/);
    });

    it('listVersionDirs tolerates a missing dir (returns empty)', function () {
        assert.match(src, /if \(!fs\.existsSync\(dir\)\) return out;/);
    });
});


// ---------------------------------------------------------------------------
// 09 — arguments.json
// ---------------------------------------------------------------------------

describe('09 - arguments.json', function () {

    it('--all is registered in framework/arguments.json', function () {
        assert.ok(argsArr.indexOf('--all') > -1, '--all must be registered');
    });

    it('--format is registered (reused)', function () {
        assert.ok(argsArr.indexOf('--format') > -1, '--format must be registered');
    });
});


// ---------------------------------------------------------------------------
// 10 — docs surfaces
// ---------------------------------------------------------------------------

describe('10 - docs surfaces', function () {

    it('help.txt documents framework:list', function () {
        assert.match(helpTxt, /\$ gina framework:list/);
    });

    it('gina-framework.1.md has a list TASKS entry', function () {
        assert.match(manPage, /\*\*list\*\*/);
    });
});


// ---------------------------------------------------------------------------
// 11 — pure-logic replica (behavioural)
// ---------------------------------------------------------------------------

describe('11 - pure-logic replica', function () {

    function shortOf(v) { return v.split(/\./g).splice(0, 2).join('.'); }

    function statusOf(r) {
        var flags = [];
        if (r.active)                          flags.push('active');
        if (!r.registered)                     flags.push('unregistered');
        if (r.kind === 'symlink' && !r.onDisk) flags.push('broken link');
        if (r.kind === 'archived')             flags.push('not linked');
        if (r.kind === 'registered')           flags.push('not installed');
        return flags.length ? flags.join(', ') : 'ok';
    }

    function reconcile(candidates, installMap, archiveSet, registeredSet, def) {
        return candidates.map(function (v) {
            var inst     = installMap[v] || null;
            var archived = !!archiveSet[v];
            var kind     = inst ? inst.kind : (archived ? 'archived' : 'registered');
            var resolves = inst ? inst.resolves : false;
            var onDisk   = (kind === 'real') || (kind === 'symlink' && resolves);
            return {
                version: v, short: shortOf(v), active: v === def,
                kind: kind, registered: !!registeredSet[v], archived: archived, onDisk: onDisk
            };
        });
    }

    function sortRows(rows) {
        return rows.slice().sort(function (a, b) {
            if (a.active !== b.active) return a.active ? -1 : 1;
            if (a.onDisk !== b.onDisk) return a.onDisk ? -1 : 1;
            return String(b.version).localeCompare(String(a.version), undefined, { numeric: true });
        });
    }

    function versionDirFilter(entries) {
        return entries.filter(function (e) { return /^v\d/.test(e); }).map(function (e) { return e.replace(/^v/, ''); });
    }

    it('shortOf derives major.minor', function () {
        assert.equal(shortOf('0.4.7'), '0.4');
        assert.equal(shortOf('0.3.7-alpha.2'), '0.3');
    });

    it('classifies a real install dir (onDisk, active)', function () {
        var rows = reconcile(['0.5.5-alpha.2'], { '0.5.5-alpha.2': { kind: 'real', resolves: true } }, {}, { '0.5.5-alpha.2': true }, '0.5.5-alpha.2');
        assert.equal(rows[0].kind, 'real');
        assert.equal(rows[0].onDisk, true);
        assert.equal(rows[0].active, true);
        assert.equal(statusOf(rows[0]), 'active');
    });

    it('classifies a resolving symlink (onDisk, ok)', function () {
        var rows = reconcile(['0.4.7'], { '0.4.7': { kind: 'symlink', resolves: true } }, { '0.4.7': true }, { '0.4.7': true }, '0.5.5-alpha.2');
        assert.equal(rows[0].kind, 'symlink');
        assert.equal(rows[0].onDisk, true);
        assert.equal(statusOf(rows[0]), 'ok');
    });

    it('flags a dangling symlink as broken (not onDisk)', function () {
        var rows = reconcile(['0.4.7'], { '0.4.7': { kind: 'symlink', resolves: false } }, {}, { '0.4.7': true }, '0.5.5-alpha.2');
        assert.equal(rows[0].onDisk, false);
        assert.equal(statusOf(rows[0]), 'broken link');
    });

    it('flags an archived-but-not-linked version', function () {
        var rows = reconcile(['0.3.0'], {}, { '0.3.0': true }, { '0.3.0': true }, '0.5.5-alpha.2');
        assert.equal(rows[0].kind, 'archived');
        assert.equal(rows[0].onDisk, false);
        assert.equal(statusOf(rows[0]), 'not linked');
    });

    it('flags a registered-only version (--all) as not installed', function () {
        var rows = reconcile(['0.1.0'], {}, {}, { '0.1.0': true }, '0.5.5-alpha.2');
        assert.equal(rows[0].kind, 'registered');
        assert.equal(rows[0].onDisk, false);
        assert.equal(statusOf(rows[0]), 'not installed');
    });

    it('flags an on-disk version absent from the registry as unregistered', function () {
        var rows = reconcile(['0.9.9'], { '0.9.9': { kind: 'symlink', resolves: true } }, { '0.9.9': true }, {}, '0.5.5-alpha.2');
        assert.equal(rows[0].registered, false);
        assert.equal(statusOf(rows[0]), 'unregistered');
    });

    it('sorts active first, then on-disk, then version descending', function () {
        var rows = reconcile(
            ['0.4.0', '0.5.5-alpha.2', '0.4.7', '0.2.0'],
            {
                '0.5.5-alpha.2': { kind: 'real', resolves: true },
                '0.4.7': { kind: 'symlink', resolves: true },
                '0.4.0': { kind: 'symlink', resolves: true }
            },
            { '0.2.0': true },
            { '0.5.5-alpha.2': true, '0.4.7': true, '0.4.0': true, '0.2.0': true },
            '0.5.5-alpha.2'
        );
        var sorted = sortRows(rows).map(function (r) { return r.version; });
        // active first, then on-disk symlinks newest-first, then the archived (not onDisk) last
        assert.deepEqual(sorted, ['0.5.5-alpha.2', '0.4.7', '0.4.0', '0.2.0']);
    });

    it('versionDirFilter keeps v<digit> entries and strips the v', function () {
        assert.deepEqual(
            versionDirFilter(['v0.4.7', 'v0.5.5-alpha.2', '.DS_Store', 'README', 'vendor']),
            ['0.4.7', '0.5.5-alpha.2']
        );
    });
});
