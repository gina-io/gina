/**
 * #B782 — gina stop signals only a pid that ps shows still running as the framework, and reads
 * and removes only its own version's pid file.
 *
 * `gina stop` (lib/cmd/framework/stop.js) read AND removed every `gina-*` pid file in the run
 * directory before choosing the version to stop, so stopping one framework version
 * deregistered every other version running beside it. It then sent SIGTERM to the pid that
 * procs.json records for the version whenever a removed pid file held the same pid, without
 * checking what that pid is now: a reused pid, or a record written in another container's pid
 * namespace where the run directory is shared, names an unrelated process. It also sent SIGCONT
 * to the record's fakeDaemonPid (the `bin/gina` wrapper's pid; the wrapper exits on the ready
 * line), and printed « has been stopped » whenever the record named a pid, signalled or not.
 *
 * Sections (the REAL stop.js bytes in a vm context, as in the #B763 test: process.kill recorded
 * and never sent, the timers run at once, ps real unless replaced):
 *   01 — a pid that is not this framework is never signalled. 01.1-01.4 fail on the pre-fix bytes.
 *   02 — only this version's pid file is read and removed. 02.1-02.2 fail on the pre-fix bytes.
 *   03 — controls: this framework is still sent SIGTERM, titled on Node or running its start
 *        command on Bun, and so is the pid where ps cannot tell (Windows, an image without ps).
 *        They pass before and after the fix.
 * The arms that read ps or need real child processes are skipped under Bun (the Bun CI image ships
 * no ps), as the #B763 test skips its own. 01.4, 02.2 and 03.3 read no ps and run there too, which
 * also keeps this file in the Bun suite's JUnit report: a file whose every test is skipped registers
 * nothing under bun test, and the Bun gate (script/check_bun_suite.js) then reads it as MISSING.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var vm     = require('vm');
var { spawn, execFileSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW       = require(path.join(__dirname, '..', 'fw'));
var CMD      = path.join(FW, 'lib', 'cmd', 'framework');
var STOP_SRC = path.join(CMD, 'stop.js');
var VERSION  = '9.9.9-b782';
var TITLE    = 'gina-v' + VERSION;
var READY    = 'process.stdout.write("ready\\n"); setInterval(function () {}, 1000);';

var IS_BUN = typeof Bun !== 'undefined';
var HAS_PS = (function () {
    try {
        execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'stat=,command='], { stdio: ['ignore', 'pipe', 'ignore'] });
        return true;
    } catch (e) {
        return false;
    }
})();
var SKIP_LIVE = (IS_BUN && 'under Bun (the Bun CI image ships no ps)') || (!HAS_PS && 'no ps -p on this host') || false;

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-stop-pidfile-b782-'));

/**
 * A pid no process can have (above Linux's 4194304 pid_max ceiling and macOS's 99998), for the arms
 * that never ask ps about it: the stop reads it from a file and records it, and nothing signals it.
 *
 * @constant
 * @type {number}
 */
var FAKE_PID = 4242424;

/** @type {{other: ?import('child_process').ChildProcess, other2: ?import('child_process').ChildProcess, bunLike: ?import('child_process').ChildProcess}} */
var kids = { other: null, other2: null, bunLike: null };

/**
 * Starts a child and resolves once it has written its first line (it is then fully started,
 * and a titled child has set its title).
 *
 * @inner
 * @param {string[]} args - Arguments to the running node
 * @returns {Promise<import('child_process').ChildProcess>}
 */
function startChild(args) {
    return new Promise(function (resolve, reject) {
        var c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        c.stdout.once('data', function () { resolve(c); });
        c.on('error', reject);
    });
}

/**
 * A pid no process has: a child that has already exited.
 *
 * @inner
 * @returns {Promise<number>}
 */
function deadPid() {
    return new Promise(function (resolve) {
        var c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
        c.on('exit', function () { resolve(c.pid); });
    });
}

/**
 * A fresh home dir and run dir.
 *
 * @inner
 * @param {Object<string, (number|string)>} pidFiles - Pid-file names (without `.pid`) and their content
 * @param {?{pid: (number|string), fakeDaemonPid: number}} record - This version's procs.json
 *   entry, in lib/proc.js's shape; `null` writes no procs.json
 * @returns {{runDir: string, homeDir: string}}
 */
function homes(pidFiles, record) {
    var homeDir = fs.mkdtempSync(path.join(TMP, 'home-'));
    var runDir  = path.join(homeDir, 'run');
    fs.mkdirSync(runDir);
    Object.keys(pidFiles).forEach(function (name) {
        fs.writeFileSync(path.join(runDir, name + '.pid'), String(pidFiles[name]));
    });
    if (record) {
        var entry = { pid: record.pid, title: TITLE, version: VERSION, port: 65000 };
        if (typeof record.fakeDaemonPid !== 'undefined') {
            entry.fakeDaemonPid = record.fakeDaemonPid;
        }
        var procs = {};
        procs[TITLE] = entry;
        fs.writeFileSync(path.join(homeDir, 'procs.json'), JSON.stringify(procs, null, 2));
    }
    return { runDir: runDir, homeDir: homeDir };
}

/**
 * This version's pid file, holding `pid`.
 *
 * @inner
 * @param {(number|string)} pid
 * @returns {Object<string, (number|string)>}
 */
function ownPidFile(pid) {
    var files = {};
    files[TITLE] = pid;
    return files;
}

/**
 * Runs the REAL stop.js bytes in a vm context, as the #B763 test's runCmd() does (gina's
 * globals stubbed, `process.kill` recorded and signal 0 alone forwarded, `process.exit`
 * recorded, the title grep's execSync recorded and answering nothing, the logger's lines
 * captured), with two changes: the timers are queued and run once the constructor returns (the
 * pid-file path ends in a setTimeout chain, whose process.exit would otherwise fire outside this
 * function), and the ps-titles module can have its readPidTitle() replaced.
 *
 * @inner
 * @param {{runDir: string, homeDir: string}} h - From homes()
 * @param {{readPidTitle: function(*): (?object|undefined)}} [opts]
 * @returns {{logs: string[], kills: Array<Array<(number|string)>>, exit: (number|undefined), threw: ?Error, execSync: string[]}}
 */
function runStop(h, opts) {
    var res = { logs: [], kills: [], exit: undefined, threw: null, execSync: [] };
    var EXIT = { exit: true };
    var timers = [];
    var log = function () { res.logs.push(Array.prototype.join.call(arguments, ' ')); };
    var logger = { debug: function () {}, log: log, info: log, warn: log, error: log, notice: log };
    function PathStub(p) {
        if (!(this instanceof PathStub)) return p;
        this.p = p;
    }
    PathStub.prototype.rmSync = function () { fs.rmSync(this.p, { force: true }); };
    PathStub.prototype.existsSync = function () { return fs.existsSync(this.p); };
    var psTitles = require(path.join(CMD, 'inc', 'ps-titles'));
    if (opts && typeof opts.readPidTitle === 'function') {
        psTitles = Object.assign({}, psTitles, { readPidTitle: opts.readPidTitle });
    }
    var modules = {
        'fs'              : fs,
        'child_process'   : {
            spawn    : function () { throw new Error('[instrument] spawn is not expected'); },
            execSync : function (cmd) { res.execSync.push(String(cmd)); return Buffer.from(''); }
        },
        './../helper'     : function CmdHelper() {},
        './inc/ps-titles' : psTitles
    };
    var sandbox = {
        lib          : { logger: logger, cmdStatusFormat: require(path.join(FW, 'lib', 'cmd-status-format', 'src', 'main.js')) },
        GINA_VERSION : VERSION,
        GINA_RUNDIR  : h.runDir,
        GINA_HOMEDIR : h.homeDir,
        _            : PathStub,
        requireJSON  : function (p) { return JSON.parse(fs.readFileSync(p, 'utf8')); },
        isWin32      : function () { return false; },
        setTimeout   : function (fn) { timers.push(fn); return timers.length; },
        Buffer       : Buffer,
        process      : {
            execPath : process.execPath,
            platform : process.platform,
            getuid   : process.getuid,
            exit     : function (code) { res.exit = code; throw EXIT; },
            kill     : function (pid, signal) {
                if (signal === 0) return process.kill(pid, 0);
                res.kills.push([Number(pid), signal]);
                return true;
            }
        }
    };
    var localRequire = function (id) {
        if (!Object.prototype.hasOwnProperty.call(modules, id)) {
            throw new Error('[instrument] unexpected require: ' + id);
        }
        return modules[id];
    };
    var src = fs.readFileSync(STOP_SRC, 'utf8');
    var fn = vm.runInNewContext('(function (require, module, exports, __filename, __dirname) {\n' + src + '\n})', sandbox, { filename: STOP_SRC });
    var mod = { exports: {} };
    fn(localRequire, mod, mod.exports, STOP_SRC, path.dirname(STOP_SRC));
    try {
        new mod.exports({ argv: ['node', 'gina', 'framework:stop'], client: null }, {});
        while (timers.length) {
            timers.shift()();
        }
    } catch (e) {
        if (e !== EXIT) res.threw = e;
    }
    return res;
}

/**
 * Whether the stop printed `Gina v<version> <text>`.
 *
 * @inner
 * @param {{logs: string[]}} r - From runStop()
 * @param {string} text - `has been stopped` or `is not running`
 * @returns {boolean}
 */
function said(r, text) {
    return r.logs.some(function (l) { return l.indexOf('Gina v' + VERSION + ' ' + text) > -1; });
}

before(async function () {
    if (SKIP_LIVE) return;
    // a script at …/gina/bin/cli, run as `node …/bin/cli start --fake-daemon-pid=1`: how a
    // framework started on Bun shows to ps (the runtime, then its start command, no title)
    var cliDir = path.join(TMP, 'gina', 'bin');
    fs.mkdirSync(cliDir, { recursive: true });
    var cli = path.join(cliDir, 'cli');
    fs.writeFileSync(cli, READY + '\n');
    kids.bunLike = await startChild([cli, 'start', '--fake-daemon-pid=1']);
    kids.other   = await startChild(['-e', READY]);
    kids.other2  = await startChild(['-e', READY]);
});

after(function () {
    Object.keys(kids).forEach(function (k) { if (kids[k]) { try { kids[k].kill('SIGKILL'); } catch (e) {} } });
    fs.rmSync(TMP, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 01 — a pid that is not this framework is never signalled
// ---------------------------------------------------------------------------
describe('01 - gina stop never signals a pid that is not this framework', function () {

    it('01.1 the pid file and the record name another program, its fakeDaemonPid a third: no SIGTERM, no SIGCONT, « is not running »', { skip: SKIP_LIVE }, function () {
        var r = runStop(homes(ownPidFile(kids.other.pid), { pid: kids.other.pid, fakeDaemonPid: kids.other2.pid }));
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.deepEqual(r.kills, [], 'logs: ' + JSON.stringify(r.logs));
        assert.ok(said(r, 'is not running'), JSON.stringify(r.logs));
        assert.ok(!said(r, 'has been stopped'), JSON.stringify(r.logs));
        assert.equal(r.exit, 0);
    });

    it('01.2 the pid file and the record name two different programs: nothing is signalled, and the stop does not report it stopped', { skip: SKIP_LIVE }, function () {
        var r = runStop(homes(ownPidFile(kids.other.pid), { pid: kids.other2.pid }));
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.deepEqual(r.kills, [], 'logs: ' + JSON.stringify(r.logs));
        assert.ok(said(r, 'is not running'), JSON.stringify(r.logs));
        assert.ok(!said(r, 'has been stopped'), JSON.stringify(r.logs));
    });

    it('01.3 a dead pid in both: nothing is signalled, and the stale pid file is removed', { skip: SKIP_LIVE }, async function () {
        var dead = await deadPid();
        var h = homes(ownPidFile(dead), { pid: dead });
        var r = runStop(h);
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.deepEqual(r.kills, [], 'logs: ' + JSON.stringify(r.logs));
        assert.ok(said(r, 'is not running'), JSON.stringify(r.logs));
        assert.equal(fs.existsSync(path.join(h.runDir, TITLE + '.pid')), false);
    });

    it('01.4 -1 in the pid file and the record never reaches process.kill', function () {
        var r = runStop(homes(ownPidFile('-1'), { pid: -1 }));
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.deepEqual(r.kills, [], 'logs: ' + JSON.stringify(r.logs));
        assert.ok(said(r, 'is not running'), JSON.stringify(r.logs));
    });
});


// ---------------------------------------------------------------------------
// 02 — only this version's pid file is read and removed
// ---------------------------------------------------------------------------
describe('02 - gina stop reads and removes only its own version\'s pid file', function () {

    it('02.1 another framework version\'s pid file is left in place', { skip: SKIP_LIVE }, async function () {
        var dead = await deadPid();
        var files = ownPidFile(dead);
        files['gina-v9.9.8-b782'] = kids.other.pid;
        var h = homes(files, { pid: dead });
        var r = runStop(h);
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        var other = path.join(h.runDir, 'gina-v9.9.8-b782.pid');
        assert.ok(fs.existsSync(other), 'the other version\'s pid file must stay; logs: ' + JSON.stringify(r.logs));
        assert.equal(fs.readFileSync(other, 'utf8'), String(kids.other.pid));
        assert.equal(fs.existsSync(path.join(h.runDir, TITLE + '.pid')), false, 'this version\'s pid file is removed');
    });

    it('02.2 the pid file of a bundle whose name starts with gina- is left in place', function () {
        var h = homes({ 'gina-api@shop': FAKE_PID }, null);
        var r = runStop(h);
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.ok(fs.existsSync(path.join(h.runDir, 'gina-api@shop.pid')), 'logs: ' + JSON.stringify(r.logs));
        assert.deepEqual(r.kills, []);
    });
});


// ---------------------------------------------------------------------------
// 03 — CONTROLS: this framework is still stopped
// ---------------------------------------------------------------------------
describe('03 - CONTROLS: gina stop still stops this framework', function () {

    it('03.1 a framework on Node (titled gina-v<version>) is sent SIGTERM, its pid file is removed, and the stop reports it stopped', { skip: SKIP_LIVE }, async function () {
        var titled = await startChild(['-e', 'process.title = ' + JSON.stringify(TITLE) + '; ' + READY]);
        try {
            var h = homes(ownPidFile(titled.pid), { pid: titled.pid });
            var r = runStop(h);
            assert.equal(r.threw, null, r.threw && r.threw.stack);
            assert.deepEqual(r.kills, [[titled.pid, 'SIGTERM']], 'logs: ' + JSON.stringify(r.logs));
            assert.ok(said(r, 'has been stopped'), JSON.stringify(r.logs));
            assert.equal(r.exit, 0);
            assert.equal(fs.existsSync(path.join(h.runDir, TITLE + '.pid')), false);
        } finally {
            titled.kill('SIGKILL');
        }
    });

    it('03.2 a framework on Bun (…/bin/cli start) is sent SIGTERM, and the stop reports it stopped', { skip: SKIP_LIVE }, function () {
        var r = runStop(homes(ownPidFile(kids.bunLike.pid), { pid: kids.bunLike.pid }));
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.deepEqual(r.kills, [[kids.bunLike.pid, 'SIGTERM']], 'logs: ' + JSON.stringify(r.logs));
        assert.ok(said(r, 'has been stopped'), JSON.stringify(r.logs));
    });

    it('03.3 where ps cannot tell (Windows, an image without ps), the pid that the pid file and the record both name is sent SIGTERM, as before', function () {
        var r = runStop(homes(ownPidFile(FAKE_PID), { pid: FAKE_PID }), { readPidTitle: function () { return undefined; } });
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.deepEqual(r.kills, [[FAKE_PID, 'SIGTERM']], 'logs: ' + JSON.stringify(r.logs));
        assert.ok(said(r, 'has been stopped'), JSON.stringify(r.logs));
    });
});
