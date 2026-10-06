/**
 * #B780 — `gina framework:restart` reports a framework that does not start again.
 *
 * restart.js runs `gina stop`, then, in a timer, `gina start` through execFileSync. When the
 * start returned non-zero, it counted the restart as a success whenever
 * `gina-v<version>.pid` existed — a fallback for the warning exit that #B760 removed — and
 * otherwise rethrew inside the timer: an uncaught dump and exit 1. A start that failed after
 * registering its pid file was therefore reported as a restart (exit 0, nothing running), and
 * the start's own code was lost either way. A failed start is now reported once: its captured
 * output relayed, one line on stderr, and the start's exit code (128 + the signal number for a
 * signal).
 *
 * The REAL restart.js bytes run in a vm context whose `require` hands them a stubbed
 * execFileSync (no `gina stop` ever runs: it SIGKILLs every `gina-v<version>` process on the
 * machine), an fs whose writes to fd 1 and 2 are recorded, and a `process` whose `exit` is
 * recorded. Timers are the host's, wrapped so a throw inside the restart timer is recorded
 * rather than crashing the test.
 *
 * Sections:
 *   01 — source pins: the pid file fallback is gone from the active code, and the start and
 *        stop calls test/lib/cmd-argv-b665-s2.test.js §01d pins are unchanged.
 *   02 — the real bytes, driven. 02.1-02.3 fail on the pre-fix bytes; 02.4 is a control that
 *        passes on both.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var vm     = require('vm');
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');

var FW          = require(path.join(__dirname, '..', 'fw'));
var RESTART_SRC = path.join(FW, 'lib', 'cmd', 'framework', 'restart.js');
var VERSION     = '9.9.9-b780';

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-restart-b780-'));

/**
 * Strips comment lines, so a negative pin cannot be satisfied or tripped by a `// was:` record.
 *
 * @inner
 * @param {string} src
 * @returns {string}
 */
function live(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}

/**
 * Runs the real restart.js once, `gina start` doing what `start` names.
 *
 * @inner
 * @param {object} arm
 * @param {('ok'|'exit3'|'sigkill')} arm.start - What the stubbed `gina start` does
 * @param {boolean} arm.pidFile - Whether gina-v<version>.pid exists when the start returns
 * @returns {Promise<{exit: (number|undefined), threw: ?Error, fd1: string, fd2: string, calls: string[][]}>}
 *
 * @example
 * var r = await runRestart({ start: 'exit3', pidFile: true });
 * r.exit; // 3
 */
function runRestart(arm) {
    var runDir = fs.mkdtempSync(path.join(TMP, 'run-'));
    if (arm.pidFile) {
        fs.writeFileSync(path.join(runDir, 'gina-v' + VERSION + '.pid'), '4242');
    }
    var res = { exit: undefined, threw: null, fd1: '', fd2: '', calls: [] };
    var EXIT = { exit: true };

    var execFileSync = function (bin, args) {
        res.calls.push(Array.from(args).slice(1));   // a host-realm copy: `args` comes from the vm realm
        if (args[1] === 'stop') {
            return Buffer.from('Gina v' + VERSION + ' has been stopped\n');
        }
        if (arm.start === 'ok') {
            return Buffer.from('Framework ready for connections\n');
        }
        var e = new Error('Command failed: ' + bin + ' ' + args.join(' '));
        e.stdout = Buffer.from('framework: the boot failed\n');
        e.stderr = Buffer.from('');
        if (arm.start === 'sigkill') { e.status = null; e.signal = 'SIGKILL'; }
        else { e.status = 3; e.signal = null; }
        throw e;
    };
    var fsProxy = Object.assign({}, fs, {
        writeSync: function (fd, data) {
            if (fd === 1 || fd === 2) {
                res['fd' + fd] += Buffer.isBuffer(data) ? data.toString() : String(data);
                return 0;
            }
            return fs.writeSync.apply(fs, arguments);
        }
    });
    var noop = function () {};
    var logger = { debug: noop, log: noop, info: noop, warn: noop, error: noop, notice: noop };
    var modules = {
        'fs'            : fsProxy,
        'child_process' : { execFileSync: execFileSync },
        'util'          : require('util'),
        'path'          : path,
        'os'            : os,
        './../helper'   : function CmdHelper() {}
    };
    var localRequire = function (id) {
        if (!Object.prototype.hasOwnProperty.call(modules, id)) {
            throw new Error('[instrument] restart.js required an unexpected module: ' + id);
        }
        return modules[id];
    };

    return new Promise(function (resolve) {
        var done = function () { setImmediate(function () { resolve(res); }); };
        var wrappedSetTimeout = function (fn, ms) {
            return setTimeout(function () {
                try { fn(); }
                catch (e) { if (e !== EXIT) { res.threw = e; } }
                done();
            }, ms);
        };
        var sandbox = {
            lib          : { logger: logger },
            GINA_VERSION : VERSION,
            GINA_RUNDIR  : runDir,
            GINA_HOMEDIR : TMP,
            _            : function (p) { return p; },
            requireJSON  : function () { throw new Error('[instrument] requireJSON is not expected without @<version>'); },
            setTimeout   : wrappedSetTimeout,
            Buffer       : Buffer,
            process      : {
                execPath : process.execPath,
                exit     : function (code) { res.exit = code; throw EXIT; }
            }
        };
        var src = fs.readFileSync(RESTART_SRC, 'utf8');
        var fn = vm.runInNewContext('(function (require, module, exports, __filename, __dirname) {\n' + src + '\n})', sandbox, { filename: RESTART_SRC });
        var mod = { exports: {} };
        fn(localRequire, mod, mod.exports, RESTART_SRC, path.dirname(RESTART_SRC));
        try {
            new mod.exports({ argv: ['node', 'gina', 'framework:restart'], client: null }, {});
        } catch (e) {
            if (e !== EXIT) { res.threw = e; }
            done();
        }
    });
}

after(function () {
    fs.rmSync(TMP, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 01 — source pins
// ---------------------------------------------------------------------------
describe('01 - framework/restart.js source pins (#B780)', function () {

    var SRC = live(fs.readFileSync(RESTART_SRC, 'utf8'));

    it('01.1 the pid file fallback is gone from the active code', function () {
        assert.equal(SRC.indexOf('fs.existsSync(pidFile)'), -1, 'the fallback is still active');
        assert.equal(SRC.indexOf('restarted successfully'), -1, 'the masked success message is still active');
    });

    it('01.2 the start and stop calls are unchanged (cmd-argv-b665-s2 §01d)', function () {
        assert.ok(SRC.indexOf("out = execFileSync(process.execPath, [ginaBin, 'start', '@' + self.version]).toString();") > -1);
        assert.ok(SRC.indexOf("out = execFileSync(process.execPath, [ginaBin, 'stop', '@' + self.version]).toString();") > -1);
    });
});


// ---------------------------------------------------------------------------
// 02 — the real bytes, driven
// ---------------------------------------------------------------------------
describe('02 - framework:restart: a start that fails is reported, with its exit code', function () {

    it('02.1 the start exits 3 after writing its pid file → exit 3, its output relayed, one line on stderr', async function () {
        var r = await runRestart({ start: 'exit3', pidFile: true });
        assert.deepEqual(r.calls, [['stop', '@' + VERSION], ['start', '@' + VERSION]], 'stop, then start');
        assert.equal(r.threw, null, 'nothing may be thrown: ' + (r.threw && r.threw.message));
        assert.match(r.fd1, /framework: the boot failed/, 'the start\'s captured output must be relayed');
        assert.match(r.fd2, /^gina: framework:restart could not start the framework v9\.9\.9-b780 again \(gina start exited 3\)\.\n$/);
        assert.equal(r.exit, 3);
    });

    it('02.2 the start exits 3 before writing its pid file → exit 3, nothing thrown', async function () {
        var r = await runRestart({ start: 'exit3', pidFile: false });
        assert.equal(r.threw, null, 'nothing may be thrown: ' + (r.threw && r.threw.message));
        assert.match(r.fd2, /could not start the framework v9\.9\.9-b780 again \(gina start exited 3\)/);
        assert.equal(r.exit, 3);
    });

    it('02.3 the start is killed by SIGKILL → exit 137', async function () {
        var r = await runRestart({ start: 'sigkill', pidFile: false });
        assert.equal(r.threw, null, 'nothing may be thrown: ' + (r.threw && r.threw.message));
        assert.match(r.fd2, /could not start the framework v9\.9\.9-b780 again \(gina start exited 137\)/);
        assert.equal(r.exit, 137);
    });

    it('02.4 CONTROL - the start succeeds → no exit call, nothing on stderr, nothing thrown', async function () {
        var r = await runRestart({ start: 'ok', pidFile: true });
        assert.deepEqual(r.calls, [['stop', '@' + VERSION], ['start', '@' + VERSION]]);
        assert.equal(r.threw, null);
        assert.equal(r.fd2, '');
        assert.equal(r.exit, undefined);
    });
});
