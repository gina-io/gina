/**
 * #B761 — `gina start` when the framework port is held by something that is not a running gina
 * framework, and when the command socket cannot listen at all.
 *
 * bin/cli binds the MQ listener, then requires bin/cmd, whose command socket listens on the
 * framework port. Its `framework.on('error')` handler trusted a `procs.json` entry for that port
 * without checking it, returned when there was none, and only logged any other listen error; the
 * process never ended. So a foreign listener on the framework port read « already running » with
 * « PID `null` », a stale entry « already running [<dead pid>] », both exited 0 and left a
 * half-started daemon holding the MQ port, and an EACCES made `gina start` hang.
 *
 * The handler now asks lib/cmd/framework/inc/listen-error.js. « Framework already running … [pid] »
 * (the line bin/gina exits 0 on) is printed only when a procs.json pid for the port is alive and a
 * framework daemon, read with inc/ps-titles.js `readPidTitle()`: titled `gina-v<version>` on Node,
 * or, on Bun (which does not show process.title to ps), still running its own `…/bin/cli start`;
 * anything else writes its reason to stderr and exits 1, which also frees the MQ port. bin/gina no
 * longer prints « PID `null` » for a line without a pid.
 *
 * Sections:
 *   01 — decide(), pure: every branch and its wording, two entries for the port, and
 *        classifyPid() through its probe (kill and readPidTitle replaced).
 *   02 — readPidTitle() and classifyPid() over REAL processes: a child titled `gina-v…`, the test
 *        process itself (alive, not gina), a pid that has exited, pid 1 (another user's process
 *        on most hosts: EPERM counts as alive), and a process running `…/bin/cli start` (the
 *        form a framework on Bun keeps), read whole under a narrow COLUMNS. Needs a host whose
 *        `ps` shows a process title, checked once: asserted on Node under macOS and Linux
 *        wherever `ps` exists, skipped with the reason elsewhere (Bun, Windows, no `ps`).
 *   03 — bin/cmd source: the handler decides through the module, writes synchronously, exits 1,
 *        keeps the « already running » line in the shape bin/gina matches, and only logs an
 *        error that comes once the socket listens (net.Server emits accept failures as `error`).
 *   04 — bin/gina, driven: the real wrapper bytes beside a scripted bin/cli (the shape of
 *        test/bin/gina-start-exit-code-b759.test.js): a line without a pid prints no
 *        « PID `null` » and still exits 0; a line with a pid prints it.
 *
 * Red-first: 01, 02.0, 02.4, 02.6, 03.1–03.2 and 03.4 fail on the pre-fix tree (the module,
 * readPidTitle(), the handler's exit and its listening guard are absent; 02.0 is the arm that
 * flags the missing readPidTitle(), which the other 02 arms skip on), and 04.1 fails on the pre-fix
 * bin/gina; 03.3 and 04.2 are controls that pass on both. The real
 * daemon's paths (a foreign listener, a stale entry, an injected EACCES, and the controls: a first
 * start and a second start while it runs) were driven end to end outside this suite.
 *
 * Run: node --test test/bin/gina-start-held-port-b761.test.js
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawn, spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW          = require('../fw');
var REPO        = path.resolve(__dirname, '..', '..');
var CMD_SOURCE  = path.join(REPO, 'bin', 'cmd');
var GINA_SOURCE = path.join(REPO, 'bin', 'gina');
var LISTEN_ERROR = path.join(FW, 'lib', 'cmd', 'framework', 'inc', 'listen-error');
var PS_TITLES    = path.join(FW, 'lib', 'cmd', 'framework', 'inc', 'ps-titles');

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-start-held-port-'));

/** The title the section 02 child gives itself. @constant @type {string} */
var CHILD_TITLE = 'gina-v0.0.0-b761';

/**
 * Loads the decision module on demand, so that on the pre-fix tree (where it does not exist)
 * each arm fails on its own instead of the whole file failing to load.
 *
 * @inner
 * @returns {object} lib/cmd/framework/inc/listen-error.js
 */
function listenError() {
    return require(LISTEN_ERROR);
}

/**
 * @inner
 * @returns {object} lib/cmd/framework/inc/ps-titles.js
 */
function psTitles() {
    return require(PS_TITLES);
}

/**
 * Tells whether a process is alive.
 *
 * @inner
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/**
 * Waits for a condition, polling every 50 ms.
 *
 * @inner
 * @param {function(): boolean} cond
 * @param {number} ms - The budget
 * @returns {Promise<boolean>} Whether the condition held in time
 */
function waitFor(cond, ms) {
    return new Promise(function (resolve) {
        var t0 = Date.now();
        (function tick() {
            if (cond()) return resolve(true);
            if (Date.now() - t0 > ms) return resolve(false);
            setTimeout(tick, 50);
        })();
    });
}

after(function () {
    fs.rmSync(TMP, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 01 — decide(), pure
// ---------------------------------------------------------------------------
describe('01 - decide(): what the command socket does when it cannot listen', function () {

    var PROCS_FILE = '/home/u/.gina/procs.json';
    var inUse = function () { var e = new Error('listen EADDRINUSE: address already in use 127.0.0.1:8124'); e.code = 'EADDRINUSE'; e.port = 8124; return e; };
    var ctx = function (procs, state, platform) {
        return {
            command     : 'framework:start',
            port        : 8124,
            procsFile   : PROCS_FILE,
            procs       : procs,
            platform    : platform || 'darwin',
            classifyPid : function () { return state; }
        };
    };
    var FIX    = 'Free the port, or move the framework: gina framework:set --port=<port>';
    var FINDER = 'Find the holder: lsof -nP -iTCP:8124 -sTCP:LISTEN';

    it('01.1 a foreign listener, no procs.json → exit 1: cause, fix and finder', function () {
        var d = listenError().decide(inUse(), ctx(null, 'framework'));
        assert.deepEqual(d, { action: 'exit', code: 1, message: [
            'gina: cannot start the framework: port 8124 is held by another program, not a running gina framework.', FIX, FINDER
        ].join('\n') });
    });

    it('01.2 an entry for another port only counts as no entry', function () {
        var d = listenError().decide(inUse(), ctx({ 'gina-v0.7.2': { pid: 4321, port: 8126 } }, 'framework'));
        assert.equal(d.action, 'exit');
        assert.match(d.message, /^gina: cannot start the framework: port 8124 is held by another program, not a running gina framework\.\n/);
    });

    it('01.3 a stale entry (its pid is not running) → exit 1, the entry named', function () {
        var d = listenError().decide(inUse(), ctx({ 'gina-v0.7.3': { pid: 4321, port: 8124 } }, 'dead'));
        assert.deepEqual(d, { action: 'exit', code: 1, message: [
            'gina: cannot start the framework: port 8124 is held by another program; ' + PROCS_FILE + ' names pid 4321, which is not running.', FIX, FINDER
        ].join('\n') });
    });

    it('01.4 an entry whose pid now runs another program → exit 1, « not a gina framework »', function () {
        var d = listenError().decide(inUse(), ctx({ 'gina-v0.7.3': { pid: 4321, port: 8124 } }, 'other'));
        assert.equal(d.action, 'exit');
        assert.match(d.message, /names pid 4321, which is not a gina framework\.\n/);
    });

    it('01.5 CONTROL: a running gina framework recorded for the port → « already running », with its pid', function () {
        var d = listenError().decide(inUse(), ctx({ 'gina-v0.7.3': { pid: 4321, port: 8124 } }, 'framework'));
        assert.deepEqual(d, { action: 'already-running', pid: 4321, port: 8124 });
    });

    it('01.6 any other listen error → exit 1 with its own message, one line', function () {
        var e = new Error('listen EACCES: permission denied 127.0.0.1:8124');
        e.code = 'EACCES';
        var d = listenError().decide(e, ctx(null, 'framework'));
        assert.deepEqual(d, { action: 'exit', code: 1, message: 'gina: cannot start the framework: listen EACCES: permission denied 127.0.0.1:8124' });
    });

    it('01.7 on Windows the finder line is left out', function () {
        var d = listenError().decide(inUse(), ctx(null, 'framework', 'win32'));
        assert.equal(d.message.split('\n').length, 2);
        assert.doesNotMatch(d.message, /lsof/);
    });

    it('01.8 no held-port message says « address already in use » (bin/gina exits on those words at once)', function () {
        ['dead', 'other'].forEach(function (state) {
            var d = listenError().decide(inUse(), ctx({ x: { pid: 4321, port: 8124 } }, state));
            assert.doesNotMatch(d.message, /address already in use/i);
        });
        assert.doesNotMatch(listenError().decide(inUse(), ctx(null, 'framework')).message, /address already in use/i);
    });

    it('01.9 a pid that is not a positive integer is not a recorded pid', function () {
        ['-1', '0', '12abc', null].forEach(function (pid) {
            assert.equal(listenError().findRecordedPid({ x: { pid: pid, port: 8124 } }, 8124), null, 'pid ' + pid);
        });
        assert.equal(listenError().findRecordedPid({ x: { pid: 4321, port: '8124' } }, 8124), 4321);
    });

    it('01.10 two entries for the port: a stale one before a running framework → « already running » with the live pid', function () {
        var c = ctx({ 'gina-v0.7.2': { pid: 111, port: 8124 }, 'gina-v0.7.3': { pid: 222, port: 8124 } }, null);
        c.classifyPid = function (pid) { return pid === 222 ? 'framework' : 'dead'; };
        assert.deepEqual(listenError().decide(inUse(), c), { action: 'already-running', pid: 222, port: 8124 });
        c.classifyPid = function () { return 'dead'; };
        assert.match(listenError().decide(inUse(), c).message, /names pid 111, which is not running\.\n/, 'none running: the first entry is named');
    });

    it('01.11 classifyPid(): the alive check first, then the title; where the title cannot be read, the alive check decides', function () {
        var thrower = function (code) { return function () { var e = new Error('kill ' + code); e.code = code; throw e; }; };
        var alive   = function () { return true; };
        var reads   = function (v) { return function () { return v; }; };
        var unread  = function () { throw new Error('readPidTitle must not run for a pid no process has'); };
        [
            [thrower('ESRCH'), unread,                                             'dead',      'no process has the pid'],
            [alive,            reads({ title: 'gina-v0.7.3', zombie: false }),     'framework', 'a gina-v title'],
            [alive,            reads({ title: 'nginx', zombie: false }),           'other',     'another program'],
            [alive,            reads({ title: 'gina-v0.7.3', zombie: true }),      'dead',      'a zombie holds no socket'],
            [alive,            reads(null),                                        'dead',      'our own process, not listed: it has just exited'],
            [thrower('EPERM'), reads(null),                                        'framework', 'another user\'s live process hidden from ps (hidepid)'],
            [alive,            reads(undefined),                                   'framework', 'ps cannot tell (Windows, busybox)'],
            [thrower('EPERM'), reads({ title: '/sbin/launchd', zombie: false }),   'other',     'another user\'s process, readable'],
            // Bun does not show process.title: a framework on Bun keeps the command it was started with
            [alive, reads({ title: '/usr/local/bin/bun', command: '/usr/local/bin/bun /opt/gina/bin/cli start --fake-daemon-pid=12', zombie: false }), 'framework', 'a framework on Bun: its own start command'],
            [alive, reads({ title: 'bun', command: 'bun /opt/gina/bin/cli framework:start', zombie: false }),   'framework', 'a framework on Bun started as framework:start'],
            [alive, reads({ title: 'bun', command: 'bun /srv/app/server.js --port 8124', zombie: false }),     'other',     'another Bun program'],
            [alive, reads({ title: 'node', command: 'node /opt/gina/bin/gina start', zombie: false }),         'other',     'the gina wrapper, not the daemon'],
            [alive, reads({ title: 'bun', command: 'bun /opt/gina/bin/cli status', zombie: false }),           'other',     'another bin/cli command'],
            [alive, reads({ title: 'bun', command: 'bun /opt/gina/bin/cli startx', zombie: false }),           'other',     'start must be a whole word']
        ].forEach(function (c) {
            assert.equal(listenError().classifyPid(4321, { kill: c[0], readPidTitle: c[1] }), c[2], c[3]);
        });
    });
});


// ---------------------------------------------------------------------------
// 02 — readPidTitle() and classifyPid() over real processes
// ---------------------------------------------------------------------------
describe('02 - readPidTitle() and classifyPid() over real processes', function () {

    var child = null;
    var titleShows = false;
    var reason = '';

    before(async function () {
        child = spawn(process.execPath, ['-e', "process.title = '" + CHILD_TITLE + "'; setInterval(function () {}, 1000);"], { stdio: 'ignore' });
        // the title is set when the child's script runs, a few ms after spawn
        var seen = null;
        await waitFor(function () {
            try { seen = psTitles().readPidTitle(child.pid); } catch (e) { seen = null; }
            return !!(seen && seen.title === CHILD_TITLE);
        }, 5000);
        titleShows = !!(seen && seen.title === CHILD_TITLE);
        reason = titleShows ? '' : 'this host does not show a process title through ps (read: ' + JSON.stringify(seen) + ')';
    });

    after(function () {
        if (child && isAlive(child.pid)) {
            try { process.kill(child.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
        }
    });

    it('02.0 on Node under macOS and Linux, where ps exists, the host can show a process title (so 02 never skips silently there)', function (t) {
        if (process.versions.bun || (process.platform !== 'darwin' && process.platform !== 'linux')) {
            return;
        }
        // a host without ps (a slim container image): readPidTitle() cannot tell, so classifyPid()
        // falls back to the alive check, as designed — not a failure of the code
        var probe = spawnSync('ps', ['-p', String(process.pid)], { stdio: 'ignore' });
        if (probe.error && probe.error.code === 'ENOENT') {
            return t.skip('no ps on this host: readPidTitle() cannot tell, and classifyPid() falls back to the alive check');
        }
        assert.ok(titleShows, reason);
    });

    it('02.1 readPidTitle() reads a live child\'s title', function (t) {
        if (!titleShows) return t.skip(reason);
        assert.deepEqual(psTitles().readPidTitle(child.pid), { title: CHILD_TITLE, command: CHILD_TITLE, zombie: false });
    });

    it('02.2 a live process titled gina-v… is a framework', function (t) {
        if (!titleShows) return t.skip(reason);
        assert.equal(listenError().classifyPid(child.pid), 'framework');
    });

    it('02.3 the test process (alive, not gina) is another program', function (t) {
        if (!titleShows) return t.skip(reason);
        assert.equal(listenError().classifyPid(process.pid), 'other');
    });

    it('02.4 a pid that has exited is dead, and ps lists nothing for it', async function (t) {
        var gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        var pid = gone.pid;
        await new Promise(function (resolve) { gone.on('exit', resolve); });
        assert.equal(listenError().classifyPid(pid), 'dead');
        if (!titleShows) return t.skip(reason);
        assert.equal(psTitles().readPidTitle(pid), null);
    });

    it('02.5 pid 1 (another user\'s process on most hosts: EPERM counts as alive) is another program', function (t) {
        if (!titleShows) return t.skip(reason);
        assert.ok(isAlive(1), 'pid 1 must read as alive, EPERM included');
        assert.equal(listenError().classifyPid(1), 'other');
    });

    it('02.6 readPidTitle() refuses a value that is not a pid', function () {
        ['-1', '0', '12abc', '', null].forEach(function (v) {
            assert.equal(psTitles().readPidTitle(v), null, 'pid ' + JSON.stringify(v));
        });
    });

    describe('02.7 a live process running `…/bin/cli start` (a framework on Bun, which does not show process.title)', function () {

        var daemon = null, other = null, listed = false;

        before(async function () {
            if (!titleShows) return;
            var dir = path.join(TMP, 'gina', 'bin');
            fs.mkdirSync(dir, { recursive: true });
            var cli = path.join(dir, 'cli');
            fs.writeFileSync(cli, 'setInterval(function () {}, 1000);\n');
            // a long last argument: without -ww, procps-ng cuts the command to $COLUMNS
            daemon = spawn(process.execPath, [cli, 'start', '--fake-daemon-pid=' + '1'.repeat(200)], { stdio: 'ignore' });
            other  = spawn(process.execPath, [cli, 'status'], { stdio: 'ignore' });
            listed = await waitFor(function () {
                var a = psTitles().readPidTitle(daemon.pid), b = psTitles().readPidTitle(other.pid);
                return !!(a && /\/bin\/cli start/.test(a.command) && b && /\/bin\/cli status/.test(b.command));
            }, 5000);
        });

        after(function () {
            [daemon, other].forEach(function (c) {
                if (c && isAlive(c.pid)) {
                    try { process.kill(c.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
                }
            });
        });

        it('02.7.1 it is a framework; another bin/cli command is not', function (t) {
            if (!titleShows) return t.skip(reason);
            assert.ok(listed, 'ps must list both command lines');
            assert.equal(listenError().classifyPid(daemon.pid), 'framework');
            assert.equal(listenError().classifyPid(other.pid), 'other');
        });

        it('02.7.2 the command is read whole under a narrow COLUMNS (procps-ng cuts it without -ww; macOS ignores COLUMNS when piped)', function (t) {
            if (!titleShows) return t.skip(reason);
            var saved = process.env.COLUMNS;
            process.env.COLUMNS = '20';
            try {
                var seen = psTitles().readPidTitle(daemon.pid);
                assert.ok(seen && /\/bin\/cli start --fake-daemon-pid=1{200}$/.test(seen.command), 'whole command: ' + JSON.stringify(seen));
                assert.equal(listenError().classifyPid(daemon.pid), 'framework');
            } finally {
                if (typeof saved === 'undefined') delete process.env.COLUMNS; else process.env.COLUMNS = saved;
            }
        });
    });
});


// ---------------------------------------------------------------------------
// 03 — bin/cmd source
// ---------------------------------------------------------------------------
describe('03 - bin/cmd: the listen-error handler decides, writes synchronously and exits', function () {

    /**
     * The handler's code with block comments and whole-line `//` comments removed, so a comment
     * that names a token cannot satisfy a pin.
     *
     * @inner
     * @returns {string}
     */
    function handler() {
        var raw = fs.readFileSync(CMD_SOURCE, 'utf8');
        var code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
        var start = code.indexOf("framework.on('error'");
        assert.ok(start > -1, 'the handler must be present (extraction control)');
        var depth = 0, i = code.indexOf('{', start), end = -1;
        for (; i < code.length; i++) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        assert.ok(end > start, 'the handler must close (extraction control)');
        return code.slice(start, end + 1);
    }

    it('03.1 decides through inc/listen-error', function () {
        assert.match(handler(), /require\([^)]*\/lib\/cmd\/framework\/inc\/listen-error['"]\)/);
        assert.match(handler(), /\.decide\(err,/);
    });

    it('03.2 writes the reason synchronously to stderr, then exits 1', function () {
        var h = handler();
        var w = h.indexOf('fs.writeSync(2,');
        var x = h.indexOf('process.exit(1)');
        assert.ok(w > -1, 'a synchronous stderr write');
        assert.ok(x > w, 'process.exit(1) after the write');
    });

    it('03.3 CONTROL: the « already running » line keeps the shape bin/gina matches (« Framework already running », « [ pid ] »)', function () {
        var h = handler();
        assert.match(h, /'Framework already running on port `'\s*\+/);
        assert.match(h, /'`: \[ '\s*\+[^+]*\+\s*' \]'/);
    });

    it('03.4 an error once the socket listens (an accept failure such as EMFILE) is logged, never decided: the running framework keeps serving', function () {
        var h = handler();
        var g = h.indexOf('if (framework.listening)');
        var d = h.indexOf('.decide(err,');
        assert.ok(g > -1, 'the listening guard');
        assert.ok(d > g, 'the guard comes before the decision');
        assert.match(h.slice(g, d), /^if \(framework\.listening\) \{[^}]*\breturn;\s*\}/, 'the guarded branch returns');
        assert.doesNotMatch(h.slice(g, d), /process\.exit\(/, 'the guarded branch never exits');
    });
});


// ---------------------------------------------------------------------------
// 04 — bin/gina, driven
// ---------------------------------------------------------------------------
describe('04 - bin/gina: an « already running » line without a pid prints no « PID `null` »', function () {

    var GINA = null;
    var CLI_STUB = [
        "var fs = require('fs');",
        "if (process.env.B761_STUB_PIDFILE) fs.writeFileSync(process.env.B761_STUB_PIDFILE, String(process.pid));",
        "var line = process.env.B761_STUB === 'nopid'",
        "    ? 'Framework already running on port`8124`. Use `gina status` to get the PID to kill.\\n'",
        "    : 'Framework already running on port `8124`: [ 4242 ]\\n';",
        "fs.writeSync(1, line);",
        "setInterval(function () {}, 1000);",
        ""
    ].join('\n');

    before(function () {
        var tree = path.join(TMP, 'tree');
        GINA = path.join(tree, 'bin', 'gina');
        fs.mkdirSync(path.join(tree, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tree, 'utils'), { recursive: true });
        fs.copyFileSync(GINA_SOURCE, GINA);
        fs.writeFileSync(path.join(tree, 'bin', 'cli'), CLI_STUB);
        fs.writeFileSync(path.join(tree, 'utils', 'runtime.js'),
            'module.exports = require(' + JSON.stringify(path.join(REPO, 'utils', 'runtime.js')) + ');\n');
    });

    /**
     * Runs the copied bin/gina with `start`; its stub child prints the « already running » line
     * that `mode` names, then stays alive until this helper kills it.
     *
     * @inner
     * @param {string} mode - `nopid` or `pid`
     * @returns {{status: ?number, stdout: string, stderr: string}}
     */
    function run(mode) {
        var pidFile = path.join(TMP, 'stub-' + mode + '.pid');
        var env = Object.assign({}, process.env, { B761_STUB: mode, B761_STUB_PIDFILE: pidFile });
        var r = spawnSync(process.execPath, [GINA, 'start'], { cwd: TMP, env: env, encoding: 'utf8', timeout: 30000 });
        var pid = null;
        try { pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10) || null; } catch (e) { pid = null; }
        if (pid && isAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
        }
        return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    }

    it('04.1 a line without a pid → exit 0, « already running », no « PID `null` »', function () {
        var r = run('nopid');
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Gina server is already running/);
        assert.doesNotMatch(r.stdout + r.stderr, /PID `null`/);
    });

    it('04.2 CONTROL: a line with a pid → exit 0, the pid printed', function () {
        var r = run('pid');
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Gina server is already running with PID `4242`/);
    });
});
