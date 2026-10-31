/**
 * #B1048 — `PathObject.mkdir()` calls back on a failure.
 *
 * A failure carries no path, so the check that the completed path was the requested one dropped it:
 * the callback never ran, with a read-only parent, or on the loser of two concurrent calls of one
 * path. The copy's strategies 3B and 3C walk the path `mkdir()` hands them, so they now refuse to walk
 * with none: copying nothing would read as a success, and `mv()` would then remove the source.
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var h = require('../fixtures/path-helper-harness');

var PRECIOUS = 'precious bytes';

before(h.load);
after(h.unload);

describe('01 - mkdir', function () {

    it('CONTROL: a deep path calls back with the path', async function () {
        var dir = h.trialDir(), deep = path.join(dir, 'p', 'q', 'r');
        var seen;
        var rec = h.recorder();
        new _(deep, true).mkdir(function (err, p) { seen = p; rec.cb(err); });
        await rec.done();
        assert.equal(!!rec.firstError(), false);
        assert.equal(seen, deep);
        assert.equal(fs.statSync(deep).isDirectory(), true);
    });

    it('a parent that refuses it: an error at the callback', { skip: h.asRoot }, async function () {
        var dir = h.trialDir(), ro = path.join(dir, 'ro');
        fs.mkdirSync(ro);
        fs.chmodSync(ro, 0o555);
        var rec = h.recorder();
        try {
            new _(path.join(ro, 'x'), true).mkdir(rec.cb);
            await rec.done();
        } finally {
            fs.chmodSync(ro, 0o755);
        }
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
        assert.equal(rec.firstError().code, 'EACCES');
    });

    it('two concurrent calls of one path both succeed', async function () {
        for (var t = 0; t < 12; ++t) {
            var dir = h.trialDir(), deep = path.join(dir, 'p', 'q', 'r');
            var ra = h.recorder(), rb = h.recorder();
            new _(deep, true).mkdir(ra.cb);
            new _(deep, true).mkdir(rb.cb);
            await ra.done();
            await rb.done();
            assert.equal(ra.calls.length, 1);
            assert.equal(rb.calls.length, 1);
            assert.equal(!!ra.firstError(), false);
            assert.equal(!!rb.firstError(), false);
            assert.equal(fs.statSync(deep).isDirectory(), true);
        }
    });

    it('a folder move whose destination cannot be created: an error, the source kept', { skip: h.asRoot }, async function () {
        var dir = h.trialDir(), d = path.join(dir, 'd'), ro = path.join(dir, 'ro');
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'f'), PRECIOUS);
        fs.mkdirSync(ro);
        fs.chmodSync(ro, 0o555);
        var rec = h.recorder();
        try {
            new _(d, true).mv(path.join(ro, 'to'), rec.cb);
            await rec.done();
            await h.wait(20);
        } finally {
            fs.chmodSync(ro, 0o755);
        }
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.firstError() instanceof Error);
        assert.equal(fs.readFileSync(path.join(d, 'f'), 'utf8'), PRECIOUS);
    });
});
