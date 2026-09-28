'use strict';
/**
 * #B491 (a) — `run()` (helpers/task.js, the implicit global also exported as
 * `gna.run`) must refuse a non-function callback AT THE CALLER'S LINE.
 *
 * Measured before the fix, on the real function: `run([...]).onComplete('oops')`
 * and `run([...], opt, 'oops')` both register/accept silently, the command
 * completes, and the resulting `TypeError: callback is not a function` is
 * caught by the spawn `close` handler's try/catch and merely logged — the
 * caller's completion never arrives. Its sibling `onData` passes the callback
 * straight to `e.once`, so Node's own `ERR_INVALID_ARG_TYPE` already fails
 * fast there; it is left as is and pinned as the control.
 *
 * §01 — source pins (helpers/task.js): the two guards, their placement, the
 *       untouched onData.
 * §02 — behavioural, driving the REAL `run()` on `echo` with cwd/tmp isolated
 *       (`run()` chdirs to `opt.cwd` — restored after every arm).
 *
 * This is the first test file to load helpers/task.js.
 */

var assert   = require('node:assert');
var fs       = require('node:fs');
var os       = require('node:os');
var path     = require('node:path');
var describe = require('node:test').describe;
var it       = require('node:test').it;
var afterEach = require('node:test').afterEach;

var FW   = require('../fw');
var ROOT = path.resolve(FW, '..', '..');
var SRC  = fs.readFileSync(path.join(FW, 'helpers/task.js'), 'utf8');

describe('01 - #B491 (a) source pins: run() guards its callbacks at registration', function() {

    it('onComplete throws a TypeError naming run and the received type, before registering the listener', function() {
        assert.match(
            SRC,
            /e\.onComplete\s*=\s*function\s*\(callback\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*if\s*\(\s*typeof\s*\(\s*callback\s*\)\s*!=\s*'function'\s*\)\s*\{\s*throw new TypeError\('run — onComplete expects a function, got '\s*\+\s*\(\s*callback\s*===\s*null\s*\?\s*'null'\s*:\s*typeof\s*\(\s*callback\s*\)\s*\)\);?\s*\}\s*e\.once\('run#complete'/,
            '#B491 (a): a non-function used to be swallowed by the close handler\'s try/catch — fail fast at the caller\'s line, mirroring Controller::store / Controller::query'
        );
    });

    it('the positional cb of run(cmdline, opt, cb) is type-checked BEFORE any side effect (chdir, log files, spawn)', function() {
        var guardIdx = SRC.search(/if\s*\(\s*cb\s*!=\s*null\s*&&\s*typeof\s*\(\s*cb\s*\)\s*!=\s*'function'\s*\)\s*\{\s*throw new TypeError\('run — callback expects a function, got '/);
        var chdirIdx = SRC.indexOf('process.chdir(opt.cwd)');
        var spawnIdx = SRC.indexOf('spawn(');
        assert.ok(guardIdx > -1, '#B491 (a): the positional callback needs the same guard — `if (cb) { cb(error, result) }` swallowed a truthy non-function the same way');
        assert.ok(chdirIdx > -1 && spawnIdx > -1, 'anchors present (control)');
        assert.ok(guardIdx < chdirIdx && guardIdx < spawnIdx, 'the guard must precede the chdir and the spawn');
    });

    it('null and undefined stay the "no positional callback" signal (the guard uses != null)', function() {
        assert.match(SRC, /cb\s*!=\s*null\s*&&\s*typeof\s*\(\s*cb\s*\)\s*!=\s*'function'/);
    });

    it('control — onData still hands the callback straight to e.once (Node already fails fast there)', function() {
        assert.match(SRC, /e\.onData\s*=\s*function\s*\(callback\)\s*\{\s*e\.once\('run#data',\s*callback\);/);
    });
});

describe('02 - #B491 (a) behavioural: the real run() on echo', function() {

    require(path.join(ROOT, 'utils/helper'));
    require(path.join(FW, 'lib'));
    assert.equal(typeof run, 'function', 'run is the implicit global installed by the helpers bootstrap (harness control)');

    var origCwd = process.cwd();
    afterEach(function() { process.chdir(origCwd); });

    function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'b491a-')); }

    it('onComplete("oops") throws at registration, naming run and the type', function() {
        var tmp = mkTmp();
        var h = run(['echo', 'b491'], { cwd: tmp, tmp: tmp });
        assert.throws(function() { h.onComplete('oops'); }, /^TypeError: run — onComplete expects a function, got string$/);
    });

    it('onComplete(null) names null (typeof null would read "object")', function() {
        var tmp = mkTmp();
        assert.throws(function() { run(['echo', 'b491'], { cwd: tmp, tmp: tmp }).onComplete(null); }, /got null$/);
    });

    it('onComplete(42) names number', function() {
        var tmp = mkTmp();
        assert.throws(function() { run(['echo', 'b491'], { cwd: tmp, tmp: tmp }).onComplete(42); }, /got number$/);
    });

    it('control — a function registration still delivers (err, output)', async function() {
        var tmp = mkTmp();
        var out = await new Promise(function(resolve, reject) {
            run(['echo', 'b491'], { cwd: tmp, tmp: tmp }).onComplete(function(err, data) { err ? reject(err) : resolve(data); });
        });
        assert.match(String(out), /b491/);
    });

    it('a truthy non-function positional cb throws before run() touches the filesystem', function() {
        var tmp = mkTmp();
        assert.throws(function() { run(['echo', 'x'], { cwd: tmp, tmp: tmp }, 'oops'); }, /^TypeError: run — callback expects a function, got string$/);
        assert.deepStrictEqual(fs.readdirSync(tmp), [], 'the guard must precede the private run dir and the log-file opens');
        assert.strictEqual(process.cwd(), origCwd, 'and the chdir');
    });

    it('control — a null positional cb is "use onComplete", not an error', async function() {
        var tmp = mkTmp();
        var out = await new Promise(function(resolve, reject) {
            var h = run(['echo', 'b491'], { cwd: tmp, tmp: tmp }, null);
            h.onComplete(function(err, data) { err ? reject(err) : resolve(data); });
        });
        assert.match(String(out), /b491/);
    });

    it('control — onData("oops") already fails fast with Node\'s own ERR_INVALID_ARG_TYPE', function() {
        var tmp = mkTmp();
        assert.throws(function() { run(['echo', 'z'], { cwd: tmp, tmp: tmp }).onData('oops'); }, { code: 'ERR_INVALID_ARG_TYPE' });
    });
});
