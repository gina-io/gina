/**
 * #B1045 — `PathObject.mv()` and `.rm()` settle every call, whatever happens to the path meanwhile.
 *
 * `mv()` is a copy then a remove, and nothing stops another move or remove from taking its source at
 * any point:
 *   - gone between `mv()`'s check and `cp()`'s own, `cp()` threw from an async callback, where nothing
 *     but the process could see it;
 *   - gone between the copy and the remove, `browseRemove()` logged the lstat failure and never called
 *     back, so the move never completed. A failed lstat or readdir did the same to `rm()`.
 * And in the other direction: a denied unlink read as a success, and a failure of a move given no
 * callback reached the process.
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var h = require('../fixtures/path-helper-harness');

var PRECIOUS = 'precious bytes';

before(h.load);
after(h.unload);

describe('01 - a move whose source goes away', function () {

    it('CONTROL: a plain move calls back once, with the bytes moved', async function () {
        var dir = h.trialDir(), src = path.join(dir, 'src'), dst = path.join(dir, 'dst');
        fs.writeFileSync(src, PRECIOUS);
        var rec = h.recorder();
        new _(src, true).mv(dst, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(rec.calls.length, 1);
        assert.equal(!!rec.firstError(), false);
        assert.equal(fs.readFileSync(dst, 'utf8'), PRECIOUS);
        assert.equal(fs.existsSync(src), false);
    });

    it('CONTROL: a source already gone reaches the callback', async function () {
        var dir = h.trialDir();
        var rec = h.recorder();
        new _(path.join(dir, 'nope'), true).mv(path.join(dir, 'dst'), rec.cb);
        await rec.done();
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
    });

    it('gone after the check: an error at the callback, nothing at the process', async function () {
        var dir = h.trialDir(), src = path.join(dir, 'src');
        fs.writeFileSync(src, PRECIOUS);
        var rec = h.recorder();
        var restore = h.wrapFs('access', function (a) { return a[0] === src; }, function () { fs.unlinkSync(src); }, 'after');
        var reached;
        try {
            reached = await h.processLevel(async function () {
                new _(src, true).mv(path.join(dir, 'dst'), rec.cb);
                await rec.done();
            });
        } finally {
            restore();
        }
        assert.deepEqual(reached.map(String), []);
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
    });

    it('gone after the copy: a success, the copy in place', async function () {
        var dir = h.trialDir(), src = path.join(dir, 'src'), dst = path.join(dir, 'dst');
        fs.writeFileSync(src, PRECIOUS);
        var rec = h.recorder();
        var lstats = 0;
        // the source's second lstat is the remove's: the first is the copy's
        var restore = h.wrapFs('lstat', function (a) { return a[0] === src; }, function () {
            if (++lstats === 2) { fs.unlinkSync(src); }
        });
        try {
            new _(src, true).mv(dst, rec.cb);
            await rec.done();
        } finally {
            restore();
        }
        assert.equal(lstats, 2);
        assert.equal(rec.calls.length, 1);
        assert.equal(!!rec.firstError(), false);
        assert.equal(fs.readFileSync(dst, 'utf8'), PRECIOUS);
    });

    // Depends on timing by design, in the only direction that can fail: on code that loses a
    // callback the race does so most of the time, and on this code it has nothing to lose.
    it('two overlapping moves of one file: each calls back once, and nothing reaches the process', async function () {
        var delays = [0, 1, 2, 4], settled = 0, expected = 0, intact = true;
        var size = 1024 * 1024;
        var reached = await h.processLevel(async function () {
            for (var t = 0; t < 24; ++t) {
                var dir = h.trialDir(), src = path.join(dir, 'src'), a = path.join(dir, 'a'), b = path.join(dir, 'b');
                fs.writeFileSync(src, Buffer.alloc(size, 0x5a));
                var ra = h.recorder(), rb = h.recorder();
                new _(src, true).mv(a, ra.cb);
                var delay = delays[t % delays.length];
                if (delay) { await h.wait(delay); }
                new _(src, true).mv(b, rb.cb);
                await ra.done();
                await rb.done();
                await h.wait(10);
                expected += 2;
                settled += ra.calls.length + rb.calls.length;
                [a, b].forEach(function (f) {
                    if ( fs.existsSync(f) && fs.statSync(f).size !== size ) { intact = false; }
                });
            }
        });
        assert.deepEqual(reached.map(String), []);
        assert.equal(settled, expected);
        assert.equal(intact, true);
    });

    it('no callback: a missing source is logged, not thrown', async function () {
        var dir = h.trialDir();
        var reached = await h.processLevel(async function () {
            new _(path.join(dir, 'nope'), true).mv(path.join(dir, 'dst'));
            await h.wait(40);
        });
        assert.deepEqual(reached.map(String), []);
    });

    it('no callback: a failed copy is logged, not thrown, and the source stays', async function () {
        var dir = h.trialDir(), src = path.join(dir, 'src');
        fs.writeFileSync(src, PRECIOUS);
        var reached = await h.processLevel(async function () {
            new _(src, true).mv(path.join(dir, 'missing', 'dst'));
            await h.wait(60);
        });
        assert.deepEqual(reached.map(String), []);
        assert.equal(fs.readFileSync(src, 'utf8'), PRECIOUS);
    });

    it('a denied unlink is a failure, the source still there', { skip: h.asRoot }, async function () {
        var dir = h.trialDir(), ro = path.join(dir, 'ro'), src = path.join(ro, 'src'), dst = path.join(dir, 'dst');
        fs.mkdirSync(ro);
        fs.writeFileSync(src, PRECIOUS);
        fs.chmodSync(ro, 0o555);
        var rec = h.recorder();
        try {
            new _(src, true).mv(dst, rec.cb);
            await rec.done();
        } finally {
            fs.chmodSync(ro, 0o755);
        }
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
        assert.equal(rec.firstError().code, 'EACCES');
        assert.equal(fs.existsSync(src), true);
    });
});

describe('02 - a remove', function () {

    it('CONTROL: a plain remove calls back with the path', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f');
        fs.writeFileSync(f, PRECIOUS);
        var seen;
        var rec = h.recorder();
        new _(f, true).rm(function (err, p) { seen = p; rec.cb(err); });
        await rec.done();
        assert.equal(!!rec.firstError(), false);
        assert.equal(seen, f);
        assert.equal(fs.existsSync(f), false);
    });

    it('gone after the check: a success', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f');
        fs.writeFileSync(f, PRECIOUS);
        var rec = h.recorder();
        var restore = h.wrapFs('access', function (a) { return a[0] === f; }, function () { fs.unlinkSync(f); }, 'after');
        try {
            new _(f, true).rm(rec.cb);
            await rec.done();
        } finally {
            restore();
        }
        assert.equal(rec.calls.length, 1);
        assert.equal(!!rec.firstError(), false);
    });

    it('a folder that cannot be read reaches the callback', { skip: h.asRoot }, async function () {
        var dir = h.trialDir(), d = path.join(dir, 'd'), sub = path.join(d, 'sub');
        fs.mkdirSync(d);
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'f'), PRECIOUS);
        fs.chmodSync(sub, 0);
        var rec = h.recorder();
        try {
            new _(d, true).rm(rec.cb);
            await rec.done();
        } finally {
            fs.chmodSync(sub, 0o755);
        }
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
        assert.equal(rec.firstError().code, 'EACCES');
    });

    it('an lstat denied after the check reaches the callback', { skip: h.asRoot }, async function () {
        var dir = h.trialDir(), d = path.join(dir, 'd'), f = path.join(d, 'f');
        fs.mkdirSync(d);
        fs.writeFileSync(f, PRECIOUS);
        var rec = h.recorder();
        var restore = h.wrapFs('access', function (a) { return a[0] === f; }, function () { fs.chmodSync(d, 0); }, 'after');
        try {
            new _(f, true).rm(rec.cb);
            await rec.done();
        } finally {
            restore();
            fs.chmodSync(d, 0o755);
        }
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
        assert.equal(rec.firstError().code, 'EACCES');
    });
});
