/**
 * #B1047 — a folder copy reports what it could not copy, so `mv()` keeps the source.
 *
 * The walk dropped a per-file error: a folder move with an unreadable file reported a success and then
 * removed the source, and the file was gone. A failed readdir or lstat, or a symlink that resolves to
 * nothing, threw from an async callback, and an existing destination that could not be cleared called
 * `process.exit(1)` from the helper. The walk still copies all it can and reports its first failure at
 * the end.
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var h = require('../fixtures/path-helper-harness');

var PRECIOUS = 'precious bytes';

before(h.load);
after(h.unload);

function tree(dir) {
    var d = path.join(dir, 'd');
    fs.mkdirSync(d);
    fs.mkdirSync(path.join(d, 'sub'));
    fs.writeFileSync(path.join(d, 'a'), 'a');
    fs.writeFileSync(path.join(d, 'sub', 'b'), 'b');
    return d;
}

describe('01 - a folder copy that fails part-way', function () {

    it('CONTROL: a plain folder move carries every file', async function () {
        var dir = h.trialDir(), d = tree(dir), to = path.join(dir, 'to');
        var rec = h.recorder();
        new _(d, true).mv(to, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(!!rec.firstError(), false);
        assert.equal(fs.readFileSync(path.join(to, 'a'), 'utf8'), 'a');
        assert.equal(fs.readFileSync(path.join(to, 'sub', 'b'), 'utf8'), 'b');
        assert.equal(fs.existsSync(d), false);
    });

    it('a file that cannot be read: a move reports it and keeps the source', { skip: h.asRoot }, async function () {
        var dir = h.trialDir(), d = tree(dir), locked = path.join(d, 'locked');
        fs.writeFileSync(locked, PRECIOUS);
        fs.chmodSync(locked, 0);
        var rec = h.recorder();
        try {
            new _(d, true).mv(path.join(dir, 'to'), rec.cb);
            await rec.done();
            await h.wait(20);
            assert.equal(rec.calls.length, 1);
            assert.ok(rec.firstError() instanceof Error);
            assert.equal(rec.firstError().code, 'EACCES');
            assert.equal(fs.existsSync(locked), true);
        } finally {
            if ( fs.existsSync(locked) ) { fs.chmodSync(locked, 0o644); }
        }
        assert.equal(fs.readFileSync(locked, 'utf8'), PRECIOUS);
    });

    it('a file that cannot be read: a copy still copies the rest, and reports it', { skip: h.asRoot }, async function () {
        var dir = h.trialDir(), d = tree(dir), locked = path.join(d, 'locked'), to = path.join(dir, 'to');
        fs.writeFileSync(locked, PRECIOUS);
        fs.writeFileSync(path.join(d, 'zlast'), 'z');
        fs.chmodSync(locked, 0);
        var rec = h.recorder();
        try {
            new _(d, true).cp(to, rec.cb);
            await rec.done();
        } finally {
            fs.chmodSync(locked, 0o644);
        }
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
        assert.equal(fs.readFileSync(path.join(to, 'a'), 'utf8'), 'a');
        assert.equal(fs.readFileSync(path.join(to, 'sub', 'b'), 'utf8'), 'b');
        assert.equal(fs.readFileSync(path.join(to, 'zlast'), 'utf8'), 'z');
    });

    it('a folder gone before its read: an error at the callback, nothing at the process', async function () {
        var dir = h.trialDir(), d = tree(dir), sub = path.join(d, 'sub');
        var rec = h.recorder();
        var restore = h.wrapFs('readdir', function (a) { return a[0] === sub; }, function () { fs.rmSync(sub, { recursive: true, force: true }); });
        var reached;
        try {
            reached = await h.processLevel(async function () {
                new _(d, true).cp(path.join(dir, 'to'), rec.cb);
                await rec.done();
            });
        } finally {
            restore();
        }
        assert.deepEqual(reached.map(String), []);
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
    });

    it('an entry gone before its lstat: an error at the callback, nothing at the process', async function () {
        var dir = h.trialDir(), d = tree(dir), a = path.join(d, 'a');
        var rec = h.recorder();
        var restore = h.wrapFs('lstat', function (args) { return args[0] === a; }, function () {
            try { fs.unlinkSync(a); } catch (e) { /* an earlier lstat of this entry took it */ }
        });
        var reached;
        try {
            reached = await h.processLevel(async function () {
                new _(d, true).cp(path.join(dir, 'to'), rec.cb);
                await rec.done();
            });
        } finally {
            restore();
        }
        assert.deepEqual(reached.map(String), []);
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
    });

    it('a symlink that resolves to nothing: an error at the callback, nothing at the process', async function () {
        var dir = h.trialDir(), d = tree(dir), to = path.join(dir, 'to');
        fs.symlinkSync(path.join(dir, 'nothing-here'), path.join(d, 'dangling'));
        var rec = h.recorder();
        var reached = await h.processLevel(async function () {
            new _(d, true).cp(to, rec.cb);
            await rec.done();
        });
        assert.deepEqual(reached.map(String), []);
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
    });

    it('a destination that cannot be cleared: an error at the callback, the process left running', { skip: h.asRoot }, async function () {
        var dir = h.trialDir(), d = tree(dir), to = path.join(dir, 'to'), sub = path.join(to, 'sub');
        fs.mkdirSync(to);
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'kept'), 'k');
        fs.chmodSync(sub, 0o555);
        var exits = [];
        var realExit = process.exit;
        process.exit = function (c) { exits.push(c); };
        var rec = h.recorder();
        try {
            new _(d, true).mv(to, rec.cb);
            await rec.done();
        } finally {
            process.exit = realExit;
            fs.chmodSync(sub, 0o755);
        }
        assert.deepEqual(exits, []);
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
        assert.equal(fs.readFileSync(path.join(d, 'a'), 'utf8'), 'a');
    });
});
