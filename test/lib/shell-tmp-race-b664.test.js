'use strict';
/**
 * #B664 / #B702 — `Shell::run()` (lib/shell.js) and the `run()` global
 * (helpers/task.js, also `gna.run`) wrote every run's output to ONE fixed pair,
 * `<tmpdir>/out.log` + `<tmpdir>/err.log`, opened for append, read back and
 * unlinked on close. Measured on the pre-fix bytes (`todo/b664-harness/`):
 * two runs sharing a tmpdir cross-read each other's output — the later run
 * received the earlier run's stdout AND stderr as its own and the earlier run
 * got `null` — a burst of 40 got exactly its own output 0/40, and a sibling's
 * unlink landing between `existsSync` and `readFileSync` threw inside the
 * close handler's try/catch, which only logged: `run#complete` was never
 * emitted and the caller waited forever (CI: `env-add-project-b643` red three
 * times in two days on Node 24). In a shared `/tmp` the fixed names are also
 * another local user's to create first (CWE-377; #B676 covered the same
 * directory).
 *
 * The fix gives every run a PRIVATE directory (`gina-run-*`, mode 0700,
 * unpredictable name) under the configured base, holding its `out.log` /
 * `err.log`, released with the two descriptors whatever the reads did; the
 * close handler always delivers the completion, a failed read as the error.
 *
 * §01 — two overlapping Shell runs on ONE shared GINA_TMPDIR get exactly their own output
 * §02 — the same for run() on ONE opt.tmp
 * §03 — a burst of 20 Shell runs on one base: 20/20 own output, nothing left behind
 * §04 — the private directory is 0700 while the run is in flight, gone after
 * §05 — the close handler still completes when a read throws (both sites)
 * §06 — source pins on both sites
 *
 * Every arm drives the REAL code on `sh -c` with an isolated mkdtemp base —
 * never the default tmpdir: real CLI runs on this machine share it.
 */

var assert    = require('node:assert');
var fs        = require('node:fs');
var os        = require('node:os');
var path      = require('node:path');
var describe  = require('node:test').describe;
var it        = require('node:test').it;
var afterEach = require('node:test').afterEach;

var FW        = require('../fw');
var ROOT      = path.resolve(FW, '..', '..');
var SHELL_SRC = fs.readFileSync(path.join(FW, 'lib/shell.js'), 'utf8');
var TASK_SRC  = fs.readFileSync(path.join(FW, 'helpers/task.js'), 'utf8');

require(path.join(ROOT, 'utils/helper'));
var lib = require(path.join(FW, 'lib'));
assert.equal(typeof lib.Shell, 'function', 'lib.Shell is the registered constructor (harness control)');
assert.equal(typeof run, 'function', 'run is the implicit global installed by the helpers bootstrap (harness control)');

var IS_WIN = process.platform === 'win32';
var TIMEOUT_MS = 8000;

function mkBase(label) { return fs.mkdtempSync(path.join(os.tmpdir(), 'b664-' + label + '-')); }
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// Resolve with the delivery, or with `delivered: false` after the timeout —
// a red-first run must FAIL, never hang.
function deliver(handle) {
    return new Promise(function(resolve) {
        var t = setTimeout(function() { resolve({ delivered: false }); }, TIMEOUT_MS);
        handle.onComplete(function(err, out) {
            clearTimeout(t);
            resolve({ delivered: true, err: err, out: out });
        });
    });
}

function shell(base, cwd) {
    global.GINA_TMPDIR = base;
    var sh = new lib.Shell();
    sh.setOptions({ chdir: cwd });
    return sh;
}

var SLOW = ['sh', '-c', 'echo A-out; echo A-err 1>&2; sleep 0.6'];
var FAST = ['sh', '-c', 'echo B-out; echo B-err 1>&2'];

describe('01 - #B664 two overlapping Shell runs on one shared GINA_TMPDIR', function() {

    it('each run receives exactly its own stdout and stderr', async function() {
        var base = mkBase('shell'), cwd = mkBase('cwd');
        var pa = deliver(shell(base, cwd).run(SLOW.slice(), true));
        await sleep(150);
        var pb = deliver(shell(base, cwd).run(FAST.slice(), true));
        var ra = await pa, rb = await pb;

        assert.ok(rb.delivered, 'B delivered');
        assert.strictEqual(rb.out, 'B-out\n', 'B got only its own stdout (it used to get "A-out\\nB-out\\n")');
        assert.ok(String(rb.err).indexOf('B-err') > -1, 'B got its own stderr');
        assert.strictEqual(String(rb.err).indexOf('A-err'), -1, 'and not A\'s');

        assert.ok(ra.delivered, 'A delivered');
        assert.strictEqual(ra.out, 'A-out\n', 'A got its own stdout (it used to get null)');
        assert.ok(String(ra.err).indexOf('A-err') > -1, 'A got its own stderr');
        assert.strictEqual(String(ra.err).indexOf('B-err'), -1, 'and not B\'s');

        assert.deepStrictEqual(fs.readdirSync(base), [], 'nothing left in the shared base');
    });
});

describe('02 - #B664 two overlapping run() calls on one shared opt.tmp', function() {

    var origCwd = process.cwd();
    afterEach(function() { process.chdir(origCwd); });

    it('each run receives exactly its own stdout and stderr', async function() {
        var tmp = mkBase('task'), cwd = mkBase('cwd');
        var pa = deliver(run(SLOW.slice(), { cwd: cwd, tmp: tmp }));
        await sleep(150);
        var pb = deliver(run(FAST.slice(), { cwd: cwd, tmp: tmp }));
        var ra = await pa, rb = await pb;

        assert.ok(rb.delivered, 'B delivered');
        assert.strictEqual(rb.out, 'B-out\n', 'B got only its own stdout');
        assert.strictEqual(rb.err, 'B-err\n', 'B got only its own stderr');

        assert.ok(ra.delivered, 'A delivered');
        assert.strictEqual(ra.out, 'A-out\n', 'A got its own stdout (it used to get undefined)');
        assert.strictEqual(ra.err, 'A-err\n', 'A got its own stderr');

        assert.deepStrictEqual(fs.readdirSync(tmp), [], 'nothing left in the shared base');
    });
});

describe('03 - #B664 a burst of Shell runs on one base', function() {

    it('20 runs closing together each get exactly their own output, and the base is left empty', async function() {
        var base = mkBase('burst'), cwd = mkBase('cwd'), N = 20, ps = [];
        for (var i = 0; i < N; i++) {
            ps.push(deliver(shell(base, cwd).run(['sh', '-c', 'echo run-' + i], true)));
        }
        var rs = await Promise.all(ps), delivered = 0, own = 0;
        rs.forEach(function(r, i) {
            if (r.delivered) delivered++;
            if (r.delivered && r.out === 'run-' + i + '\n') own++;
        });
        assert.strictEqual(delivered, N, 'every run delivered');
        assert.strictEqual(own, N, 'every run got exactly its own output (it used to be 0/' + N + ')');
        assert.deepStrictEqual(fs.readdirSync(base), [], 'nothing left in the shared base');
    });
});

describe('04 - #B702 the private per-run directory', function() {

    it('exists under the base while the run is in flight, is mode 0700, and is gone afterwards', { skip: IS_WIN }, async function() {
        var base = mkBase('mode'), cwd = mkBase('cwd');
        var p = deliver(shell(base, cwd).run(['sh', '-c', 'sleep 0.5'], true));
        await sleep(150);
        var entries = fs.readdirSync(base);
        assert.strictEqual(entries.length, 1, 'exactly one entry in the base while the run is in flight: ' + JSON.stringify(entries));
        assert.match(entries[0], /^gina-run-/, 'it is the private run directory, not a fixed log file');
        var st = fs.statSync(path.join(base, entries[0]));
        assert.ok(st.isDirectory(), 'a directory');
        assert.strictEqual((st.mode & 0o777).toString(8), '700', 'mode 0700');
        assert.deepStrictEqual(fs.readdirSync(path.join(base, entries[0])).sort(), ['err.log', 'out.log'], 'holding the two documented log files');
        var r = await p;
        assert.ok(r.delivered, 'delivered');
        assert.deepStrictEqual(fs.readdirSync(base), [], 'the private directory is removed with the run');
    });
});

describe('05 - #B664 the close handler completes when a read throws', function() {

    var origCwd = process.cwd();
    var realReadFileSync = fs.readFileSync;
    afterEach(function() { fs.readFileSync = realReadFileSync; process.chdir(origCwd); });

    // Throw once for the run's own `err.log` under `base` — the shape of a sibling's
    // unlink landing between the existsSync and the read.
    function armReadFailure(base) {
        var fired = false;
        fs.readFileSync = function(p) {
            if ( !fired && typeof p === 'string' && p.indexOf(base) === 0 && /err\.log$/.test(p) ) {
                fired = true;
                var e = new Error('ENOENT: no such file or directory, open \'' + p + '\' (injected by shell-tmp-race-b664)');
                e.code = 'ENOENT';
                throw e;
            }
            return realReadFileSync.apply(fs, arguments);
        };
        return function() { return fired; };
    }

    it('Shell::run delivers the failure as the run\'s error instead of hanging, and the base is left empty', async function() {
        var base = mkBase('throw'), cwd = mkBase('cwd');
        var fired = armReadFailure(base);
        var r = await deliver(shell(base, cwd).run(['sh', '-c', 'echo x'], true));
        assert.ok(fired(), 'the injected read failure fired (instrument control)');
        assert.ok(r.delivered, 'onComplete fired (it used to be swallowed by the close handler\'s catch — the caller hung)');
        assert.ok(r.err && /ENOENT/.test(String(r.err)), 'the failure is the run\'s error: ' + String(r.err).split('\n')[0]);
        assert.deepStrictEqual(fs.readdirSync(base), [], 'the private directory is still released');
    });

    it('run() delivers the failure as the run\'s error instead of hanging, and the base is left empty', async function() {
        var tmp = mkBase('throw-task'), cwd = mkBase('cwd');
        var fired = armReadFailure(tmp);
        var r = await deliver(run(['sh', '-c', 'echo x'], { cwd: cwd, tmp: tmp }));
        assert.ok(fired(), 'the injected read failure fired (instrument control)');
        assert.ok(r.delivered, 'onComplete fired (it used to be swallowed — the caller hung)');
        assert.ok(r.err && /ENOENT/.test(String(r.err)), 'the failure is the run\'s error: ' + String(r.err).split('\n')[0]);
        assert.deepStrictEqual(fs.readdirSync(tmp), [], 'the private directory is still released');
    });
});

describe('06 - source pins', function() {

    it('lib/shell.js no longer names the fixed pair and creates a private run directory after the platform check', function() {
        assert.strictEqual(SHELL_SRC.indexOf("GINA_TMPDIR + '/out.log'"), -1, 'the fixed `out.log` path is gone');
        assert.strictEqual(SHELL_SRC.indexOf("GINA_TMPDIR + '/err.log'"), -1, 'the fixed `err.log` path is gone');
        var win32 = SHELL_SRC.indexOf('isWin32()'), mk = SHELL_SRC.indexOf('mkdtempSync(');
        assert.ok(mk > -1, 'a private run directory is created');
        assert.ok(win32 > -1 && win32 < mk, 'the platform check precedes any file creation (two descriptors used to leak on it)');
        assert.ok(SHELL_SRC.indexOf('rmSync(runDir') > -1, 'the run directory is removed');
        assert.ok(SHELL_SRC.indexOf("{ cwd: root, stdio: [ 'ignore', out, err ], env: local.env }") > -1, 'the spawn line is unchanged (control)');
    });

    it('helpers/task.js no longer names the fixed pair and creates a private run directory under opt.tmp', function() {
        assert.strictEqual(TASK_SRC.indexOf("tmp + '/out.log'"), -1, 'the fixed `out.log` path is gone');
        assert.strictEqual(TASK_SRC.indexOf("tmp + '/err.log'"), -1, 'the fixed `err.log` path is gone');
        assert.ok(TASK_SRC.indexOf('mkdtempSync(') > -1, 'a private run directory is created');
        assert.ok(TASK_SRC.indexOf('rmSync(runDir') > -1, 'the run directory is removed');
        assert.ok(TASK_SRC.indexOf("{ cwd: opt.cwd, stdio: [ 'ignore', out, err ] }") > -1, 'the spawn line is unchanged (control)');
    });
});
