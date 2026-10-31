/**
 * #B1046, second part — what the first part's check did not cover.
 *
 * The inode comparison moved two different files as one on a filesystem that reports an inode of 0, or
 * inodes past 2^53 (they round alike as a Number): a no-op that reported a success, where the file used
 * to move. A file moved to the folder it already sits in landed on itself and was removed. A rename that
 * only changes the case reported a success and kept the old name.
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var h = require('../fixtures/path-helper-harness');

var PRECIOUS = 'precious bytes';

before(h.load);
after(h.unload);

/**
 * Serves `lstatSync` with a chosen inode for one arm.
 *
 * @param {function(string, boolean): (number|bigint)} ino - From the path, and whether the call asked for `bigint`
 * @returns {function(): void} the restore
 */
function fakeInode(ino) {
    var real = fs.lstatSync;
    fs.lstatSync = function (p, opt) {
        var stats = real.apply(fs, arguments);
        stats.ino = ino(String(p), !!(opt && opt.bigint));
        return stats;
    };
    return function () { fs.lstatSync = real; };
}

describe('01 - two files are not one because of how their inodes read', function () {

    it('an inode of 0 on both is not the same file', async function () {
        var dir = h.trialDir(), a = path.join(dir, 'a'), b = path.join(dir, 'b');
        fs.writeFileSync(a, PRECIOUS);
        fs.writeFileSync(b, 'old');
        var restore = fakeInode(function (p, big) { return big ? 0n : 0; });
        var rec = h.recorder();
        new _(a, true).mv(b, rec.cb);
        await rec.done();
        restore();
        assert.equal(!!rec.firstError(), false);
        assert.equal(fs.existsSync(a), false);
        assert.equal(fs.readFileSync(b, 'utf8'), PRECIOUS);
    });

    it('inodes past 2^53 that round alike are not the same file', async function () {
        var dir = h.trialDir(), a = path.join(dir, 'a'), b = path.join(dir, 'b');
        fs.writeFileSync(a, PRECIOUS);
        fs.writeFileSync(b, 'old');
        var restore = fakeInode(function (p, big) {
            var ino = 72057594037927936n + (p === a ? 1n : 2n);
            return big ? ino : Number(ino);
        });
        var rec = h.recorder();
        new _(a, true).mv(b, rec.cb);
        await rec.done();
        restore();
        assert.equal(!!rec.firstError(), false);
        assert.equal(fs.existsSync(a), false);
        assert.equal(fs.readFileSync(b, 'utf8'), PRECIOUS);
    });

    it('CONTROL: one real file by two names still is one file', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f'), g = path.join(dir, 'g');
        fs.writeFileSync(f, PRECIOUS);
        fs.linkSync(f, g);
        var rec = h.recorder();
        new _(f, true).cp(g, rec.cb);
        await rec.done();
        assert.equal(fs.statSync(f).ino, fs.statSync(g).ino);
    });
});

describe('02 - a file moved to the folder it already sits in', function () {

    it('stays', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f');
        fs.writeFileSync(f, PRECIOUS);
        var rec = h.recorder();
        new _(f, true).mv(dir, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(rec.calls.length, 1);
        assert.equal(!!rec.firstError(), false);
        assert.equal(fs.readFileSync(f, 'utf8'), PRECIOUS);
    });

    it('stays when the target ends with a slash', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f');
        fs.writeFileSync(f, PRECIOUS);
        var rec = h.recorder();
        new _(f, true).mv(dir + '/', rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(fs.readFileSync(f, 'utf8'), PRECIOUS);
    });

    it('CONTROL: to another folder it still moves, under its own name', async function () {
        var dir = h.trialDir(), o = path.join(dir, 'o'), f = path.join(dir, 'f');
        fs.mkdirSync(o);
        fs.writeFileSync(f, PRECIOUS);
        var rec = h.recorder();
        new _(f, true).mv(o, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(fs.existsSync(f), false);
        assert.equal(fs.readFileSync(path.join(o, 'f'), 'utf8'), PRECIOUS);
    });
});

describe('03 - a rename that only changes the case', function () {

    it('a file takes the new name', async function () {
        var dir = h.trialDir(), from = path.join(dir, 'File'), to = path.join(dir, 'file');
        fs.writeFileSync(from, PRECIOUS);
        var oneName = fs.existsSync(to);
        var rec = h.recorder();
        new _(from, true).mv(to, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(rec.calls.length, 1);
        assert.equal(!!rec.firstError(), false);
        assert.equal(fs.readFileSync(to, 'utf8'), PRECIOUS);
        // A Linux mount of a case-insensitive disk: rename(2) sees one name and does nothing
        if ( !(oneName && process.platform == 'linux') ) {
            assert.deepEqual(fs.readdirSync(dir), ['file']);
        }
    });

    it('a folder takes the new name', async function () {
        var dir = h.trialDir(), from = path.join(dir, 'Dir'), to = path.join(dir, 'dir');
        fs.mkdirSync(from);
        fs.writeFileSync(path.join(from, 'f'), PRECIOUS);
        var oneName = fs.existsSync(to);
        var rec = h.recorder();
        new _(from, true).mv(to, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(!!rec.firstError(), false);
        assert.equal(fs.readFileSync(path.join(to, 'f'), 'utf8'), PRECIOUS);
        if ( !(oneName && process.platform == 'linux') ) {
            assert.deepEqual(fs.readdirSync(dir), ['dir']);
        }
    });

    it('CONTROL: a hard link stays a hard link, and both names stay', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f'), g = path.join(dir, 'g');
        fs.writeFileSync(f, PRECIOUS);
        fs.linkSync(f, g);
        var rec = h.recorder();
        new _(f, true).mv(g, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(!!rec.firstError(), false);
        assert.deepEqual(fs.readdirSync(dir).sort(), ['f', 'g']);
    });

    it('CONTROL: the same file through a symlinked parent stays where it is', async function () {
        var dir = h.trialDir(), d = path.join(dir, 'd'), f = path.join(d, 'f'), link = path.join(dir, 'link');
        fs.mkdirSync(d);
        fs.writeFileSync(f, PRECIOUS);
        fs.symlinkSync(d, link);
        var rec = h.recorder();
        new _(f, true).mv(path.join(link, 'f'), rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(!!rec.firstError(), false);
        assert.deepEqual(fs.readdirSync(d), ['f']);
        assert.equal(fs.readFileSync(f, 'utf8'), PRECIOUS);
    });
});
