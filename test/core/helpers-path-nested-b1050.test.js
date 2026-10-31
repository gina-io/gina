/**
 * #B1050 — a folder copied or moved onto a folder that holds it, or into itself.
 *
 * `cp()` clears an existing destination first. When that destination holds the source, both were
 * destroyed, everything else in it too, and only then did the copy fail. A folder copied into itself
 * walked its own copy until the path was too long, and left that nest behind. Both are now refused
 * before anything is written, as node's own `fs.cp()` refuses them.
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
 * @param {string} dir - The trial directory
 * @returns {{p: string, c: string, f: string, keep: string}} `p/keep` and `p/c/f`
 */
function nest(dir) {
    var p = path.join(dir, 'p'), c = path.join(p, 'c'), f = path.join(c, 'f'), keep = path.join(p, 'keep');
    fs.mkdirSync(c, { recursive: true });
    fs.writeFileSync(f, PRECIOUS);
    fs.writeFileSync(keep, PRECIOUS);
    return { p: p, c: c, f: f, keep: keep };
}

/**
 * Runs one call and returns its first error, with what reached the process.
 *
 * @param {function(function): void} call
 * @returns {Promise<{err: *, calls: number, seen: Error[]}>}
 */
async function run(call) {
    var rec = h.recorder(2000);
    var seen = await h.processLevel(async function () {
        call(rec.cb);
        await rec.done();
        await h.wait(30);
    });
    return { err: rec.firstError(), calls: rec.calls.length, seen: seen };
}

/**
 * @param {{err: *, calls: number, seen: Error[]}} r
 * @returns {void}
 */
function assertRefused(r) {
    assert.equal(r.seen.length, 0);
    assert.equal(r.calls, 1);
    assert.ok(r.err instanceof Error);
    assert.equal(r.err.code, 'EINVAL');
}

/**
 * @param {{p: string, c: string, f: string, keep: string}} n
 * @returns {void}
 */
function assertIntact(n) {
    assert.equal(fs.readFileSync(n.f, 'utf8'), PRECIOUS);
    assert.equal(fs.readFileSync(n.keep, 'utf8'), PRECIOUS);
    assert.deepEqual(fs.readdirSync(n.p).sort(), ['c', 'keep']);
    assert.deepEqual(fs.readdirSync(n.c), ['f']);
}

describe('01 - onto a folder that holds it', function () {

    it('mv(): refused, and nothing is lost', async function () {
        var n = nest(h.trialDir());
        var r = await run(function (cb) { new _(n.c, true).mv(n.p, cb); });
        assertRefused(r);
        assertIntact(n);
    });

    it('cp(): refused, and nothing is lost', async function () {
        var n = nest(h.trialDir());
        var r = await run(function (cb) { new _(n.c, true).cp(n.p, cb); });
        assertRefused(r);
        assertIntact(n);
    });

    it('from two levels down', async function () {
        var n = nest(h.trialDir()), g = path.join(n.c, 'g');
        fs.mkdirSync(g);
        fs.writeFileSync(path.join(g, 'x'), PRECIOUS);
        var r = await run(function (cb) { new _(g, true).mv(n.p, cb); });
        assertRefused(r);
        assert.equal(fs.readFileSync(path.join(g, 'x'), 'utf8'), PRECIOUS);
        assert.equal(fs.readFileSync(n.keep, 'utf8'), PRECIOUS);
    });

    it('through a symlinked parent', async function () {
        var dir = h.trialDir(), n = nest(dir), link = path.join(dir, 'l');
        fs.symlinkSync(n.p, link);
        var r = await run(function (cb) { new _(path.join(link, 'c'), true).mv(n.p, cb); });
        assertRefused(r);
        assertIntact(n);
    });

    it('in another case, where the disk ignores case', async function () {
        var dir = h.trialDir(), n = nest(dir), other = path.join(dir, 'P');
        var r = await run(function (cb) { new _(n.c, true).mv(other, cb); });
        // A case-sensitive disk sees another folder: a plain move, and the bytes arrive there
        if ( fs.existsSync(n.keep) && fs.existsSync(n.f) ) {
            assertRefused(r);
            assertIntact(n);
        } else {
            assert.equal(!!r.err, false);
            assert.equal(fs.readFileSync(path.join(other, 'f'), 'utf8'), PRECIOUS);
            assert.equal(fs.readFileSync(n.keep, 'utf8'), PRECIOUS);
        }
    });

    it('CONTROL: a file still moves up into a folder that holds it', async function () {
        var n = nest(h.trialDir());
        var r = await run(function (cb) { new _(n.f, true).mv(n.p, cb); });
        assert.equal(!!r.err, false);
        assert.equal(fs.existsSync(n.f), false);
        assert.equal(fs.readFileSync(path.join(n.p, 'f'), 'utf8'), PRECIOUS);
    });

    it('CONTROL: a symlink to that folder is only unlinked, and replaced', async function () {
        var dir = h.trialDir(), n = nest(dir), link = path.join(dir, 'l');
        fs.symlinkSync(n.p, link);
        var r = await run(function (cb) { new _(n.c, true).cp(link, cb); });
        assert.equal(!!r.err, false);
        assert.equal(fs.lstatSync(link).isDirectory(), true);
        assert.equal(fs.readFileSync(path.join(link, 'f'), 'utf8'), PRECIOUS);
        assertIntact(n);
    });
});

describe('02 - into itself', function () {

    it('mv() to a new child: refused, and nothing is written', async function () {
        var n = nest(h.trialDir());
        var r = await run(function (cb) { new _(n.p, true).mv(path.join(n.p, 'new'), cb); });
        assertRefused(r);
        assertIntact(n);
    });

    it('cp() to a new child: refused, and nothing is written', async function () {
        var n = nest(h.trialDir());
        var r = await run(function (cb) { new _(n.p, true).cp(path.join(n.p, 'new'), cb); });
        assertRefused(r);
        assertIntact(n);
    });

    it('onto an existing child: refused, and the child is not cleared', async function () {
        var n = nest(h.trialDir());
        var r = await run(function (cb) { new _(n.p, true).mv(n.c, cb); });
        assertRefused(r);
        assertIntact(n);
    });

    it('through a symlink that leads inside it', async function () {
        var dir = h.trialDir(), n = nest(dir), link = path.join(dir, 'l');
        fs.symlinkSync(n.c, link);
        var r = await run(function (cb) { new _(n.p, true).mv(path.join(link, 'new'), cb); });
        assertRefused(r);
        assertIntact(n);
    });

    it('CONTROL: excluded keeps the destination out of the walk, and the copy runs', async function () {
        var dir = h.trialDir(), p = path.join(dir, 'p');
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, 'keep'), PRECIOUS);
        var r = await run(function (cb) { new _(p, true).cp(path.join(p, 'new'), ['new'], cb); });
        assert.equal(!!r.err, false);
        assert.deepEqual(fs.readdirSync(path.join(p, 'new')), ['keep']);
    });

    it('CONTROL: a sibling whose name starts the same is not inside', async function () {
        var dir = h.trialDir(), p = path.join(dir, 'p'), p2 = path.join(dir, 'p2');
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, 'keep'), PRECIOUS);
        var r = await run(function (cb) { new _(p, true).mv(p2, cb); });
        assert.equal(!!r.err, false);
        assert.equal(fs.existsSync(p), false);
        assert.equal(fs.readFileSync(path.join(p2, 'keep'), 'utf8'), PRECIOUS);
    });

    it('CONTROL: a symlink to the source, outside it, is only unlinked, and replaced', async function () {
        var dir = h.trialDir(), s = path.join(dir, 's'), link = path.join(dir, 'l');
        fs.mkdirSync(s);
        fs.writeFileSync(path.join(s, 'f'), PRECIOUS);
        fs.symlinkSync(s, link);
        var r = await run(function (cb) { new _(s, true).mv(link, cb); });
        assert.equal(!!r.err, false);
        assert.equal(fs.lstatSync(link).isDirectory(), true);
        assert.equal(fs.readFileSync(path.join(link, 'f'), 'utf8'), PRECIOUS);
        assert.equal(fs.existsSync(s), false);
    });
});
