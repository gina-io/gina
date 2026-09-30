/**
 * lib/cmd/minion/kill.js — project-scoped minion reaper (pidfiles + ps sweep,
 * SIGTERM -> grace -> SIGKILL, --dry-run preview).
 *
 * Source-inspection tests (same style as minion-list.test.js,
 * connector-list.test.js): kill.js runs inside the CLI daemon context and signals
 * other processes, so replicating it live is heavy and unsafe for a unit test.
 * These assertions prove the source structure of:
 *
 *   (a) module shape + CmdHelper wiring + KILL_GRACE_MS
 *   (b) argv parsing — --format=<x> and --dry-run
 *   (c) project guard — projectName==null + unregistered-project errors
 *   (d) hybrid kill-set collection — pidfile pass + ps sweep, dedup by pid,
 *       self-PID skip, stale tracking
 *   (e) SIGTERM -> grace -> SIGKILL escalation
 *   (f) pidfile clean-up
 *   (g) --dry-run preview (no kill)
 *   (h) JSON output shape
 *   (i) Help module + help.txt (--dry-run documented) + arguments.json
 *
 * Section 10 is a pure-logic replica of the collect/dedup logic — the genuinely
 * new bit (everything terminal mirrors bundle:stop / framework:stop). The source
 * pins in sections 04-05 lock the operators so the replica cannot silently drift.
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var KILL_SOURCE = path.join(require('../fw'), 'lib/cmd/minion/kill.js');
var HELP_TXT    = path.join(require('../fw'), 'lib/cmd/minion/help.txt');
var ARGS_FILE   = path.join(require('../fw'), 'lib/cmd/minion/arguments.json');

var src     = fs.readFileSync(KILL_SOURCE, 'utf8');
var helpTxt = fs.readFileSync(HELP_TXT, 'utf8');
var argsArr = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8'));


// ---------------------------------------------------------------------------
// 01 — Module shape
// ---------------------------------------------------------------------------

describe('01 - module shape', function () {

    it('exports the Kill constructor', function () {
        assert.match(src, /module\.exports\s*=\s*Kill;?/);
    });

    it('declares a function Kill(opt, cmd)', function () {
        assert.match(src, /function\s+Kill\s*\(\s*opt\s*,\s*cmd\s*\)\s*\{/);
    });

    it('initialises self with null format and dryRun false', function () {
        assert.match(src, /var self\s*=\s*\{\s*format\s*:\s*null\s*,\s*dryRun\s*:\s*false\s*\}/);
    });

    it('wires CmdHelper with opt.client and debug flags', function () {
        assert.match(src, /new CmdHelper\(self, opt\.client, \{ port: opt\.debugPort, brkEnabled: opt\.debugBrkEnabled \}\)/);
    });

    it('gates on isCmdConfigured()', function () {
        assert.match(src, /if \(!isCmdConfigured\(\)\) return false;/);
    });

    it('defines a KILL_GRACE_MS constant', function () {
        assert.match(src, /var KILL_GRACE_MS = \d+;/);
    });
});


// ---------------------------------------------------------------------------
// 02 — argv parsing
// ---------------------------------------------------------------------------

describe('02 - argv parsing', function () {

    it('captures --format=', function () {
        assert.match(src, /self\.format = process\.argv\[i\]\.split\(\/\\=\/\)\[1\]/);
    });

    it('captures the --dry-run boolean flag', function () {
        assert.match(src, /\/\^\\-\\-dry-run\$\/\.test\(process\.argv\[i\]\)/);
        assert.match(src, /self\.dryRun = true;/);
    });
});


// ---------------------------------------------------------------------------
// 03 — project guard
// ---------------------------------------------------------------------------

describe('03 - project guard', function () {

    it('errors when no project is given (project-scoped)', function () {
        assert.match(src, /if \( self\.projectName == null \)/);
        assert.match(src, /minion:kill requires a project/);
    });

    it('errors on an unregistered project', function () {
        assert.match(src, /typeof\(self\.projects\[self\.projectName\]\) == 'undefined'/);
        assert.match(src, /is not a registered project/);
    });
});


// ---------------------------------------------------------------------------
// 04 — hybrid kill-set collection
// ---------------------------------------------------------------------------

describe('04 - kill-set collection', function () {

    it('pidfile pass: reads run dir and skips hidden/non-pid/daemon files', function () {
        assert.match(src, /fs\.readdirSync\(self\.runDir\)/);
        assert.match(src, /\/\^\\\.\/\.test\(file\)/);
        assert.match(src, /!\/\\\.pid\$\/\.test\(file\)/);
        assert.match(src, /\/\^gina\\-\/\.test\(file\)/);
    });

    it('pidfile pass: splits <bundle>@<project> and filters to the project', function () {
        assert.match(src, /base\.lastIndexOf\('@'\)/);
        assert.match(src, /if \( project !== self\.projectName \)/);
        assert.match(src, /fmt\.readPidfile\(self\.runDir, bundle, project\)/);
    });

    it('pidfile pass: separates running targets from stale pidfiles', function () {
        assert.match(src, /if \( runState\.running \)/);
        assert.match(src, /stale\.push\(\{ bundle: bundle, pidfile: pidfilePath \}\)/);
    });

    it('never targets the handler PID or its parent', function () {
        assert.match(src, /runState\.pid === process\.pid \|\| runState\.pid === process\.ppid/);
        assert.match(src, /pid === process\.pid \|\| pid === process\.ppid/);
    });

    it('ps sweep: POSIX-guarded, no shell, precise project boundary, pid|title from the ps columns', function () {
        // comment-stripped: the pre-#B665 `ps | grep | awk` pipeline survives as a `was:`
        // comment, which the raw source would still match
        var live = src.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
        assert.match(live, /if \( !isWin32\(\) \)/);
        assert.ok(live.indexOf("execFileSync('ps', ['-ef'], { maxBuffer: PS_MAX_BUFFER })") > -1, 'ps runs from an argument vector');
        assert.equal(live.indexOf('ps -ef |'), -1, 'no ps pipeline');
        // the project name escaped, and the (\s|$) boundary
        assert.ok(live.indexOf("new RegExp('gina: [^ ]+@' + escapeRegex(self.projectName) + '(\\\\s|$)')") > -1, 'the title pattern');
        assert.ok(live.indexOf("lines[j].indexOf('grep') > -1") > -1, 'grep lines skipped');
        assert.match(live, /var pid\s+= ~~cols\[1\];/);             // column 2 = the PID
        assert.match(live, /var titleTail = cols\[cols\.length - 1\]/); // last column = <bundle>@<project>
    });

    it('ps sweep: dedups by pid across pidfile + ps sources', function () {
        assert.match(src, /targets\[pid\]\.sources\.push\('ps'\)/);
        assert.match(src, /targets\[pid\] = \{ bundle: psBundle, pid: pid, sources: \['ps'\] \}/);
    });
});


// ---------------------------------------------------------------------------
// 05 — SIGTERM -> grace -> SIGKILL escalation
// ---------------------------------------------------------------------------

describe('05 - termination escalation', function () {

    it('sends SIGTERM to every target first', function () {
        assert.match(src, /process\.kill\(pids\[i\], 'SIGTERM'\)/);
    });

    it('waits KILL_GRACE_MS then SIGKILLs survivors', function () {
        assert.match(src, /setTimeout\(function \(\) \{/);
        assert.match(src, /\}, KILL_GRACE_MS\)/);
        assert.match(src, /process\.kill\(pids\[j\], 0\)/);          // liveness probe
        assert.match(src, /process\.kill\(pids\[j\], 'SIGKILL'\)/);
        assert.match(src, /forced\.push\(pids\[j\]\)/);
    });
});


// ---------------------------------------------------------------------------
// 06 — pidfile clean-up
// ---------------------------------------------------------------------------

describe('06 - pidfile clean-up', function () {

    it('unlinks killed-target and stale pidfiles via existsSync guard', function () {
        assert.match(src, /new _\(targets\[p\]\.pidfile\)\.existsSync\(\)/);
        assert.match(src, /fs\.unlinkSync\(targets\[p\]\.pidfile\)/);
        assert.match(src, /new _\(stale\[i\]\.pidfile\)\.existsSync\(\)/);
    });
});


// ---------------------------------------------------------------------------
// 07 — --dry-run preview
// ---------------------------------------------------------------------------

describe('07 - dry-run', function () {

    it('returns a preview without killing when --dry-run is set', function () {
        assert.match(src, /if \( self\.dryRun \) \{\s*\n\s*return report\(targets, stale, true, \[\]\)/);
    });

    it('preview wording differs from the kill wording', function () {
        assert.match(src, /would terminate/);
        assert.match(src, /terminated /);
        assert.match(src, /would kill/);
    });
});


// ---------------------------------------------------------------------------
// 08 — JSON output shape
// ---------------------------------------------------------------------------

describe('08 - JSON output shape', function () {

    it('detects --format=json with the /^json?/ regex', function () {
        assert.match(src, /\/\^json\?\/\.test\(self\.format\)/);
    });

    it('emits a { project, dryRun, killed, staleCleaned } envelope', function () {
        assert.match(src, /process\.stdout\.write\(JSON\.stringify\(\{/);
        assert.match(src, /staleCleaned\s*:\s*staleList/);
    });
});


// ---------------------------------------------------------------------------
// 09 — help + arguments
// ---------------------------------------------------------------------------

describe('09 - help + arguments', function () {

    it('help.txt documents the kill and --dry-run forms', function () {
        assert.match(helpTxt, /gina minion:kill @<project_name>/);
        assert.match(helpTxt, /--dry-run/);
    });

    it('arguments.json declares --format and --dry-run', function () {
        assert.ok(Array.isArray(argsArr));
        assert.ok(argsArr.indexOf('--format') > -1);
        assert.ok(argsArr.indexOf('--dry-run') > -1);
    });
});


// ---------------------------------------------------------------------------
// 10 — pure-logic replica of collect/dedup
//      (mirrors collectTargets; sections 04-05 source-pins lock the operators)
// ---------------------------------------------------------------------------

describe('10 - collect/dedup replica', function () {

    // Replica of collectTargets' pure logic. `runStateOf(file)` stands in for
    // fmt.readPidfile; `psLines` are the already-project-grepped ps rows
    // (`pid|<bundle>@<project>`).
    function collect(files, runStateOf, psLines, project, selfPid, parentPid) {
        var targets = {}, stale = [];
        // pidfile pass
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if ( /^\./.test(file) || !/\.pid$/.test(file) || /^gina\-/.test(file) ) continue;
            var base = file.replace(/\.pid$/, '');
            var at   = base.lastIndexOf('@');
            if ( at < 1 || at === base.length - 1 ) continue;
            var bundle = base.substring(0, at), proj = base.substring(at + 1);
            if ( proj !== project ) continue;
            var rs = runStateOf(file);
            if ( rs.running ) {
                if ( rs.pid === selfPid || rs.pid === parentPid ) continue;
                targets[rs.pid] = targets[rs.pid] || { bundle: bundle, pid: rs.pid, sources: [] };
                targets[rs.pid].sources.push('pidfile');
                targets[rs.pid].pidfile = 'run/' + file;
            } else {
                stale.push({ bundle: bundle, pidfile: 'run/' + file });
            }
        }
        // ps pass
        for (var j = 0; j < psLines.length; j++) {
            var parts = psLines[j].split(/\|/);
            var pid   = ~~parts[0];
            if ( !pid || pid === selfPid || pid === parentPid ) continue;
            var tail = parts[1] || '';
            var psAt = tail.lastIndexOf('@');
            var psBundle = (psAt > 0) ? tail.substring(0, psAt) : tail;
            if ( targets[pid] ) targets[pid].sources.push('ps');
            else targets[pid] = { bundle: psBundle, pid: pid, sources: ['ps'] };
        }
        return { targets: targets, stale: stale };
    }

    var alive = { 'api@myproject.pid': { running: true, pid: 100 },
                  'web@myproject.pid': { running: false, pid: null },   // stale
                  'db@other.pid'     : { running: true, pid: 999 } };
    var runStateOf = function (f) { return alive[f] || { running: false, pid: null }; };

    it('collects a running pidfile minion (sources = pidfile)', function () {
        var r = collect(['api@myproject.pid'], runStateOf, [], 'myproject', 1, 2);
        assert.equal(Object.keys(r.targets).length, 1);
        assert.deepEqual(r.targets[100].sources, ['pidfile']);
        assert.equal(r.stale.length, 0);
    });

    it('routes a dead pidfile to stale, not targets', function () {
        var r = collect(['web@myproject.pid'], runStateOf, [], 'myproject', 1, 2);
        assert.equal(Object.keys(r.targets).length, 0);
        assert.equal(r.stale.length, 1);
        assert.equal(r.stale[0].bundle, 'web');
    });

    it('excludes other-project pidfiles', function () {
        var r = collect(['db@other.pid'], runStateOf, [], 'myproject', 1, 2);
        assert.equal(Object.keys(r.targets).length, 0);
    });

    it('adds a ps-only orphan (sources = ps)', function () {
        var r = collect([], runStateOf, ['555|orphan@myproject'], 'myproject', 1, 2);
        assert.deepEqual(r.targets[555].sources, ['ps']);
        assert.equal(r.targets[555].bundle, 'orphan');
    });

    it('dedups a process tracked by BOTH pidfile and ps (sources = pidfile,ps)', function () {
        var r = collect(['api@myproject.pid'], runStateOf, ['100|api@myproject'], 'myproject', 1, 2);
        assert.equal(Object.keys(r.targets).length, 1);
        assert.deepEqual(r.targets[100].sources, ['pidfile', 'ps']);
    });

    it('never targets the handler PID or its parent', function () {
        var r1 = collect(['api@myproject.pid'], function () { return { running: true, pid: 100 }; }, [], 'myproject', 100, 2);
        assert.equal(Object.keys(r1.targets).length, 0);  // pid == selfPid -> skipped
        var r2 = collect([], runStateOf, ['7|x@myproject'], 'myproject', 1, 7);
        assert.equal(Object.keys(r2.targets).length, 0);  // pid == parentPid -> skipped
    });

    it('skips hidden, non-pid, and daemon pidfiles', function () {
        var files = ['.hidden@myproject.pid', 'api@myproject.txt', 'gina-v0.4.1-alpha.2.pid'];
        var r = collect(files, function () { return { running: true, pid: 100 }; }, [], 'myproject', 1, 2);
        assert.equal(Object.keys(r.targets).length, 0);
        assert.equal(r.stale.length, 0);
    });
});
