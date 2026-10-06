/**
 * #B763 — framework:status and gina stop find a framework whose pid file is gone, from its own
 * procs.json record, also on Bun.
 *
 * A framework daemon titles its process gina-v<version>. framework:status re-registered a
 * daemon whose pid file was missing from that title in `ps -f`, and gina stop's fallback looked
 * for it with `ps -ef | grep gina-v<version>`. Bun does not show process.title to ps (a Bun
 * framework shows `<bun> …/bin/cli start …`), so a Bun framework without its pid file read as
 * not running in framework:status, and gina stop exited 0 leaving it running. Both now also read
 * procs.json, the record each framework writes of itself, and accept an entry only when ps shows
 * its pid still running as that framework: titled with the entry's title on Node, or running the
 * framework's start command on Bun (findRecordedDaemons() in inc/ps-titles.js).
 *
 * Sections:
 *   01 — findRecordedDaemons() over readings of ps (its probe replaced): what is listed, and
 *        what is not. Fails on the pre-fix bytes, where the function does not exist.
 *   02 — findRecordedDaemons() over REAL processes (the #B761 02.7 technique): a child running
 *        …/bin/cli start, as a Bun framework shows to ps; a child titled gina-v…; an unrelated
 *        child.
 *   03 — framework:status: the REAL status.js bytes in a vm context. 03.1 fails on the pre-fix
 *        bytes; 03.2 is a control.
 *   04 — gina stop: the REAL stop.js bytes in a vm context, process.kill recorded and never
 *        sent. 04.1 fails on the pre-fix bytes; 04.2 and 04.3 are controls.
 * Sections 02-04 need ps, and are skipped under Bun (the Bun CI image ships no ps).
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var vm     = require('vm');
var { spawn, execFileSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW         = require(path.join(__dirname, '..', 'fw'));
var CMD        = path.join(FW, 'lib', 'cmd', 'framework');
var STATUS_SRC = path.join(CMD, 'status.js');
var STOP_SRC   = path.join(CMD, 'stop.js');
var VERSION    = '9.9.9-b763';
var TITLE      = 'gina-v' + VERSION;

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

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-recorded-daemons-b763-'));

/**
 * The real inc/ps-titles module, loaded fresh.
 *
 * @inner
 * @returns {object}
 */
function psTitles() {
    return require(path.join(CMD, 'inc', 'ps-titles'));
}

/** @type {{bunLike: ?import('child_process').ChildProcess, titled: ?import('child_process').ChildProcess, other: ?import('child_process').ChildProcess}} */
var kids = { bunLike: null, titled: null, other: null };

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
 * Runs one framework command module (status.js or stop.js) from its REAL bytes in a vm
 * context: gina's globals stubbed, `process.kill` recorded (signal 0 alone is forwarded, for
 * the liveness checks), `process.exit` recorded, the logger's lines captured.
 *
 * @inner
 * @param {string} srcPath - status.js or stop.js
 * @param {object} homes - `{ runDir, homeDir }`
 * @returns {{logs: string[], kills: Array<Array<(number|string)>>, exit: (number|undefined), threw: ?Error, execSync: string[]}}
 */
function runCmd(srcPath, homes) {
    var res = { logs: [], kills: [], exit: undefined, threw: null, execSync: [] };
    var EXIT = { exit: true };
    var log = function () { res.logs.push(Array.prototype.join.call(arguments, ' ')); };
    var logger = { debug: function () {}, log: log, info: log, warn: log, error: log, notice: log };
    function PathStub(p) {
        if (!(this instanceof PathStub)) return p;
        this.p = p;
    }
    PathStub.prototype.rmSync = function () { fs.rmSync(this.p, { force: true }); };
    PathStub.prototype.existsSync = function () { return fs.existsSync(this.p); };
    var modules = {
        'fs'              : fs,
        'child_process'   : {
            spawn    : function () { throw new Error('[instrument] spawn is not expected'); },
            execSync : function (cmd) { res.execSync.push(String(cmd)); return Buffer.from(''); }
        },
        './../helper'     : function CmdHelper() {},
        './inc/ps-titles' : psTitles()
    };
    var sandbox = {
        lib          : { logger: logger, cmdStatusFormat: require(path.join(FW, 'lib', 'cmd-status-format', 'src', 'main.js')) },
        GINA_VERSION : VERSION,
        GINA_RUNDIR  : homes.runDir,
        GINA_HOMEDIR : homes.homeDir,
        _            : PathStub,
        requireJSON  : function (p) { return JSON.parse(fs.readFileSync(p, 'utf8')); },
        isWin32      : function () { return false; },
        setTimeout   : setTimeout,
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
    var src = fs.readFileSync(srcPath, 'utf8');
    var fn = vm.runInNewContext('(function (require, module, exports, __filename, __dirname) {\n' + src + '\n})', sandbox, { filename: srcPath });
    var mod = { exports: {} };
    fn(localRequire, mod, mod.exports, srcPath, path.dirname(srcPath));
    try {
        new mod.exports({ argv: ['node', 'gina', 'framework:x'], client: null }, {});
    } catch (e) {
        if (e !== EXIT) res.threw = e;
    }
    return res;
}

/**
 * A fresh run dir and home dir, with procs.json recording `entries` (`{ title: pid }`).
 *
 * @inner
 * @param {Object<string, number>} entries
 * @returns {{runDir: string, homeDir: string}}
 */
function homesWith(entries) {
    var homeDir = fs.mkdtempSync(path.join(TMP, 'home-'));
    var runDir  = path.join(homeDir, 'run');
    fs.mkdirSync(runDir);
    var procs = {};
    Object.keys(entries).forEach(function (title) {
        procs[title] = { pid: entries[title], title: title, version: title.replace(/^gina-v/, ''), port: 65000 };
    });
    fs.writeFileSync(path.join(homeDir, 'procs.json'), JSON.stringify(procs, null, 2));
    return { runDir: runDir, homeDir: homeDir };
}

before(async function () {
    if (SKIP_LIVE) return;
    // a script at …/gina/bin/cli, run as `node …/bin/cli start --fake-daemon-pid=1`: how a
    // framework started on Bun shows to ps (the runtime, then its start command, no title)
    var cliDir = path.join(TMP, 'gina', 'bin');
    fs.mkdirSync(cliDir, { recursive: true });
    var cli = path.join(cliDir, 'cli');
    fs.writeFileSync(cli, 'process.stdout.write("ready\\n"); setInterval(function () {}, 1000);\n');
    kids.bunLike = await startChild([cli, 'start', '--fake-daemon-pid=1']);
    kids.titled  = await startChild(['-e', 'process.title = ' + JSON.stringify(TITLE + 't') + '; process.stdout.write("ready\\n"); setInterval(function () {}, 1000);']);
    kids.other   = await startChild(['-e', 'process.stdout.write("ready\\n"); setInterval(function () {}, 1000);']);
});

after(function () {
    Object.keys(kids).forEach(function (k) { if (kids[k]) { try { kids[k].kill('SIGKILL'); } catch (e) {} } });
    fs.rmSync(TMP, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 01 — findRecordedDaemons() over readings of ps
// ---------------------------------------------------------------------------
describe('01 - findRecordedDaemons(): a recorded framework that ps shows still running', function () {

    var READINGS = {
        101: { title: 'gina-v1.0.0', command: 'gina-v1.0.0', zombie: false },
        102: { title: '/usr/local/bin/bun', command: '/usr/local/bin/bun /opt/gina/bin/cli start --fake-daemon-pid=9', zombie: false },
        103: null,
        104: undefined,
        105: { title: '', command: '', zombie: true },
        106: { title: 'vim', command: 'vim notes.txt', zombie: false },
        107: { title: 'gina-v0.9.0', command: 'gina-v0.9.0', zombie: false },
        110: { title: 'gina-v1.0.4', command: 'gina-v1.0.4', zombie: false }
    };
    var PROCS = {
        'gina-v1.0.0'     : { pid: 101, title: 'gina-v1.0.0' },
        'gina-v1.0.1'     : { pid: 102, title: 'gina-v1.0.1' },
        'gina-v1.0.5'     : { pid: 103, title: 'gina-v1.0.5' },
        'gina-v1.0.6'     : { pid: 104, title: 'gina-v1.0.6' },
        'gina-v1.0.7'     : { pid: 105, title: 'gina-v1.0.7' },
        'gina-v1.0.8'     : { pid: 106, title: 'gina-v1.0.8' },
        'gina-v1.0.2'     : { pid: 107, title: 'gina-v1.0.2' },
        'gina-v1/../../x' : { pid: 108, title: 'gina-v1/../../x' },
        'gina-v1.0.3'     : { pid: '-1', title: 'gina-v1.0.3' },
        'gina-v1.0.4'     : { pid: 110 },
        'api@shop'        : { pid: 101, title: 'gina: api@shop' }
    };

    it('01.1 lists a titled framework (Node), a start command (Bun), and an entry without a title under its key', function () {
        var asked = [];
        var found = psTitles().findRecordedDaemons(PROCS, function (pid) { asked.push(pid); return READINGS[pid]; });
        assert.deepEqual(found, [
            { pid: 101, title: 'gina-v1.0.0' },
            { pid: 102, title: 'gina-v1.0.1' },
            { pid: 110, title: 'gina-v1.0.4' }
        ]);
        assert.equal(asked.indexOf(108), -1, 'a title that is not a daemon title must not reach ps');
    });

    it('01.2 leaves out a dead pid, a pid ps cannot read, a zombie, another program, another version, a non-pid', function () {
        var found = psTitles().findRecordedDaemons(PROCS, function (pid) { return READINGS[pid]; });
        var pids = found.map(function (d) { return d.pid; });
        [103, 104, 105, 106, 107, 108].forEach(function (p) {
            assert.equal(pids.indexOf(p), -1, 'pid ' + p + ' must not be listed');
        });
    });

    it('01.3 reads nothing when there is no record', function () {
        var never = function () { throw new Error('ps must not be read'); };
        assert.deepEqual(psTitles().findRecordedDaemons(null, never), []);
        assert.deepEqual(psTitles().findRecordedDaemons('procs', never), []);
        assert.deepEqual(psTitles().findRecordedDaemons({ 'gina-v1.0.0': null }, never), []);
    });
});


// ---------------------------------------------------------------------------
// 02 — findRecordedDaemons() over real processes
// ---------------------------------------------------------------------------
describe('02 - findRecordedDaemons() over real processes', { skip: SKIP_LIVE }, function () {

    it('02.1 a child running …/bin/cli start (a framework on Bun) is listed', function () {
        var found = psTitles().findRecordedDaemons({ 'gina-v9.9.9-b763': { pid: kids.bunLike.pid, title: TITLE } });
        assert.deepEqual(found, [{ pid: kids.bunLike.pid, title: TITLE }]);
    });

    it('02.2 a child titled with the recorded title (a framework on Node) is listed', function () {
        var found = psTitles().findRecordedDaemons({ 'gina-v9.9.9-b763t': { pid: kids.titled.pid, title: TITLE + 't' } });
        assert.deepEqual(found, [{ pid: kids.titled.pid, title: TITLE + 't' }]);
    });

    it('02.3 CONTROL - an unrelated child and a dead pid are not listed', async function () {
        var dead = await deadPid();
        var found = psTitles().findRecordedDaemons({
            'gina-v9.9.9-b763a': { pid: kids.other.pid, title: TITLE + 'a' },
            'gina-v9.9.9-b763b': { pid: dead, title: TITLE + 'b' }
        });
        assert.deepEqual(found, []);
    });
});


// ---------------------------------------------------------------------------
// 03 — framework:status
// ---------------------------------------------------------------------------
describe('03 - framework:status: a recorded framework without a pid file', { skip: SKIP_LIVE }, function () {

    it('03.1 is listed, and its pid file is written back', function () {
        var homes = homesWith({ 'gina-v9.9.9-b763': kids.bunLike.pid });
        var r = runCmd(STATUS_SRC, homes);
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        var pidFile = path.join(homes.runDir, TITLE + '.pid');
        assert.ok(fs.existsSync(pidFile), 'the pid file must be written back; logs: ' + JSON.stringify(r.logs));
        assert.equal(fs.readFileSync(pidFile, 'utf8'), String(kids.bunLike.pid));
        assert.ok(r.logs.some(function (l) { return l.indexOf('[' + kids.bunLike.pid + '] Running: v' + VERSION) > -1; }), JSON.stringify(r.logs));
        assert.equal(r.exit, 0);
    });

    it('03.2 CONTROL - a recorded pid that is dead is not listed, and no pid file is written', async function () {
        var homes = homesWith({ 'gina-v9.9.9-b763': await deadPid() });
        var r = runCmd(STATUS_SRC, homes);
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.equal(fs.existsSync(path.join(homes.runDir, TITLE + '.pid')), false);
        // exact: the titled live child (gina-v…b763t) is listed by the real `ps -f -U` and must not match
        var ours = new RegExp('Running: v' + VERSION.replace(/\./g, '\\.') + '( |$)', 'm');
        assert.ok(!r.logs.some(function (l) { return ours.test(l); }), JSON.stringify(r.logs));
    });
});


// ---------------------------------------------------------------------------
// 04 — gina stop
// ---------------------------------------------------------------------------
describe('04 - gina stop: a recorded framework without a pid file', { skip: SKIP_LIVE }, function () {

    it('04.1 is sent SIGTERM, and the stop reports it stopped', function () {
        var r = runCmd(STOP_SRC, homesWith({ 'gina-v9.9.9-b763': kids.bunLike.pid }));
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.deepEqual(r.kills, [[kids.bunLike.pid, 'SIGTERM']], 'logs: ' + JSON.stringify(r.logs));
        assert.ok(r.logs.some(function (l) { return l.indexOf('Gina v' + VERSION + ' has been stopped') > -1; }), JSON.stringify(r.logs));
        assert.equal(r.exit, 0);
    });

    it('04.2 CONTROL - a recorded pid that is dead: nothing is signalled, « is not running »', async function () {
        var r = runCmd(STOP_SRC, homesWith({ 'gina-v9.9.9-b763': await deadPid() }));
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.deepEqual(r.kills, []);
        assert.ok(r.logs.some(function (l) { return l.indexOf('Gina v' + VERSION + ' is not running') > -1; }), JSON.stringify(r.logs));
    });

    it('04.3 CONTROL - a recorded pid that another program now has: nothing is signalled', function () {
        var r = runCmd(STOP_SRC, homesWith({ 'gina-v9.9.9-b763': kids.other.pid }));
        assert.equal(r.threw, null, r.threw && r.threw.stack);
        assert.deepEqual(r.kills, []);
        assert.ok(r.logs.some(function (l) { return l.indexOf('Gina v' + VERSION + ' is not running') > -1; }), JSON.stringify(r.logs));
    });
});
