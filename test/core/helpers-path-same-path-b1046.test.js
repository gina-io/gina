/**
 * #B1046 — a target that already is the source is a no-op.
 *
 * `mv()` is a copy then a remove: a file moved onto itself was copied through its temp sibling and
 * then removed. A folder moved or copied onto itself was removed first (the copy's strategy 3C clears
 * an existing destination), then copied from nothing. All of them reported a success.
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var h = require('../fixtures/path-helper-harness');

var PRECIOUS = 'precious bytes';

before(h.load);
after(h.unload);

describe('01 - a target that already is the source', function () {

    it('a file moved onto itself stays', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f');
        fs.writeFileSync(f, PRECIOUS);
        var rec = h.recorder();
        new _(f, true).mv(f, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(rec.calls.length, 1);
        assert.equal(!!rec.firstError(), false);
        assert.equal(fs.readFileSync(f, 'utf8'), PRECIOUS);
    });

    it('the same file by another spelling stays', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f');
        fs.writeFileSync(f, PRECIOUS);
        var rec = h.recorder();
        new _(f, true).mv(dir + '/./f', rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(fs.readFileSync(f, 'utf8'), PRECIOUS);
    });

    it('the same file through a symlinked parent stays', async function () {
        var dir = h.trialDir(), d = path.join(dir, 'd'), f = path.join(d, 'f'), link = path.join(dir, 'link');
        fs.mkdirSync(d);
        fs.writeFileSync(f, PRECIOUS);
        fs.symlinkSync(d, link);
        var rec = h.recorder();
        new _(f, true).mv(path.join(link, 'f'), rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(fs.readFileSync(f, 'utf8'), PRECIOUS);
    });

    it('CONTROL: a hard link of the file keeps the bytes', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f'), g = path.join(dir, 'g');
        fs.writeFileSync(f, PRECIOUS);
        fs.linkSync(f, g);
        var rec = h.recorder();
        new _(f, true).mv(g, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(fs.readFileSync(g, 'utf8'), PRECIOUS);
    });

    it('a folder moved onto itself stays', async function () {
        var dir = h.trialDir(), d = path.join(dir, 'd');
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'f'), PRECIOUS);
        var rec = h.recorder();
        new _(d, true).mv(d, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(fs.readFileSync(path.join(d, 'f'), 'utf8'), PRECIOUS);
    });

    it('a folder copied onto itself stays', async function () {
        var dir = h.trialDir(), d = path.join(dir, 'd');
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'f'), PRECIOUS);
        var rec = h.recorder();
        new _(d, true).cp(d, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(fs.readFileSync(path.join(d, 'f'), 'utf8'), PRECIOUS);
    });

    it('CONTROL: another path is still a move', async function () {
        var dir = h.trialDir(), f = path.join(dir, 'f'), g = path.join(dir, 'g');
        fs.writeFileSync(f, PRECIOUS);
        var rec = h.recorder();
        new _(f, true).mv(g, rec.cb);
        await rec.done();
        await h.wait(20);
        assert.equal(fs.existsSync(f), false);
        assert.equal(fs.readFileSync(g, 'utf8'), PRECIOUS);
    });
});
