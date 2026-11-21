/**
 * #B227 — `helpers/path.js` copyFile: atomic temp+rename publish, both-stream
 * error listeners, settled latch, real Error propagation.
 *
 * The byte-writer behind `_.cp()` / `PathObject.mv()` carried the same defect
 * class #B223 fixed in the controller's `movefiles`:
 *   (1) wrote DIRECTLY to the final destination name (readers could observe a
 *       truncated file mid-copy);
 *   (2) on overwrite, unlinked the destination BEFORE the copy started (a
 *       404/zero-byte window — and a copy failure after the unlink had already
 *       destroyed the previous content);
 *   (3) had NO 'error' listener on the SOURCE stream (an unreadable/vanished
 *       source raised an unhandled 'error' event → uncaughtException);
 *   (4) settled the callback TWICE on a destination-side failure ('close'
 *       follows 'error' under stream autoDestroy) — the second time as a
 *       SUCCESS, which forked browseCopy's directory walk;
 *   (5) reported failures as a plain string, so callers printing `err.stack`
 *       logged `undefined`.
 *
 * Fix mirrors #B223 (`controller.js movefiles`): temp sibling in the
 * destination's own directory + atomic `renameSync` publish + both-stream
 * listeners + settled latch + real `Error`.
 *
 * §01 pins the mechanisms on the comment-stripped source (the `// was:`
 * blocks preserve the pre-fix shape as comments, so negatives MUST strip
 * first — and each stripped-away negative is guarded by a raw-text presence
 * assertion so a broken strip cannot pass the pin vacuously).
 * §02 drives the REAL helpers through real-filesystem arms.
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');

var ginaRoot = path.resolve(__dirname, '../..');
var version = require(ginaRoot + '/package.json').version;
var commentStrip = require('../strip-comments');
var FW = path.join(ginaRoot, 'framework', 'v' + version);
var SOURCE = path.join(FW, 'helpers', 'path.js');

var RAW = fs.readFileSync(SOURCE, 'utf8');

// line-based comment strip: whole-line `//` comments + block comments.
// Sufficient here — every pre-fix shape is preserved as full-line `// was:`
// comments, and no pinned needle contains `//` inside a string literal.
function stripComments(src) {
    return commentStrip.lines(src);
}
var ST = stripComments(RAW);

// ---------------------------------------------------------------------------
// 01 — source pins (comment-stripped)
// ---------------------------------------------------------------------------
describe('01 - source pins: the #B227 mechanisms are in the ACTIVE code', function () {

    it('strip validity: the stripped source still holds the function under pin', function () {
        assert.ok(ST.indexOf('var copyFile = function') > -1,
            'stripComments must not have destroyed the corpus');
    });

    it('bytes stage to a temp sibling and publish via renameSync', function () {
        assert.ok(ST.indexOf('_tmpTarget') > -1, 'temp sibling variable missing');
        assert.ok(ST.indexOf('renameSync(_tmpTarget, destination)') > -1,
            'atomic rename publish missing');
        assert.ok(ST.indexOf('createWriteStream(_tmpTarget)') > -1,
            'write stream must target the temp sibling');
    });

    it('the SOURCE stream has its own error listener', function () {
        assert.ok(ST.indexOf("sourceStream.on('error', onCopyError)") > -1,
            'source-side error listener missing (pre-fix: unhandled error event)');
    });

    it('a settled latch guards the close-after-error double settle', function () {
        assert.ok(ST.indexOf('_settled') > -1, 'settled latch missing');
        assert.ok(ST.indexOf('if (_settled) return') > -1,
            'latch must gate the close handler');
    });

    it('negative: no direct write to the final destination name', function () {
        // raw-guard: the pre-fix token survives in the `// was:` comment, so a
        // broken strip cannot pass this pin vacuously
        assert.ok(RAW.indexOf('createWriteStream(destination)') > -1,
            'raw-guard: the commented pre-fix shape should still document the change');
        assert.ok(ST.indexOf('createWriteStream(destination)') === -1,
            'ACTIVE code must not write directly to the destination');
    });

    it('negative: no destination pre-delete in copyFileToFile', function () {
        assert.ok(RAW.indexOf('fs.unlink(destination') > -1,
            'raw-guard: the commented pre-fix shape should still document the change');
        assert.ok(ST.indexOf('fs.unlink(destination') === -1,
            'ACTIVE code must not destroy the previous content before the copy succeeds');
    });

    it('negative: the plain-string error shape is gone', function () {
        assert.ok(ST.indexOf("var err = 'Error on Path.cp(...): Not found ") === -1,
            'stream-copy failures must propagate a real Error, not a string');
    });
});

// ---------------------------------------------------------------------------
// 02 — behavioral arms (real helpers, real filesystem)
// ---------------------------------------------------------------------------
describe('02 - behavioral arms (real fs)', function () {

    var work = null;
    var lockedSrc = null;  // chmod 000 — restored in after() so rmSync can reap it

    before(function () {
        process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
        require('module').Module._initPaths();
        require(path.join(FW, 'helpers'));                              // _, existsSync, ...
        require(path.resolve(FW, '..', '..', 'utils', 'prototypes'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-path-copy-'));
    });

    after(function () {
        try { if (lockedSrc) fs.chmodSync(lockedSrc, 448 /* 0o700 */); } catch (e) { /* best effort */ }
        try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    });

    function noTmpResidue(dir) {
        return fs.readdirSync(dir).filter(function (f) { return /\.tmp$/.test(f); });
    }

    it('copies a file and leaves no temp residue', function (t, done) {
        var src = path.join(work, 'a.txt');
        var dst = path.join(work, 'b.txt');
        fs.writeFileSync(src, 'PAYLOAD-A');
        new _(src).cp(dst, function (err) {
            assert.ok(!err, 'unexpected error: ' + (err && err.message));
            assert.equal(fs.readFileSync(dst, 'utf8'), 'PAYLOAD-A');
            assert.deepEqual(noTmpResidue(work), [], 'temp sibling must not survive a success');
            done();
        });
    });

    it('overwrites an existing destination with the new content', function (t, done) {
        var src = path.join(work, 'over-src.txt');
        var dst = path.join(work, 'over-dst.txt');
        fs.writeFileSync(src, 'NEW-CONTENT');
        fs.writeFileSync(dst, 'OLD-CONTENT');
        new _(src).cp(dst, function (err) {
            assert.ok(!err, 'unexpected error: ' + (err && err.message));
            assert.equal(fs.readFileSync(dst, 'utf8'), 'NEW-CONTENT');
            done();
        });
    });

    it('a FAILED copy preserves the previous destination content (#B227 headline)', function (t, done) {
        if (typeof process.getuid === 'function' && process.getuid() === 0) {
            // root ignores mode bits — the EACCES trigger cannot fire
            return done();
        }
        var src = path.join(work, 'locked-src.txt');
        var dst = path.join(work, 'survivor.txt');
        fs.writeFileSync(src, 'UNREACHABLE');
        fs.writeFileSync(dst, 'PRECIOUS-OLD');
        fs.chmodSync(src, 0);          // read stream errors EACCES at open
        lockedSrc = src;
        new _(src).cp(dst, function (err) {
            // pre-fix: the source-side 'error' had NO listener → uncaughtException
            // (this whole file dies), and the overwrite path had ALREADY unlinked
            // the destination — 'PRECIOUS-OLD' was gone either way
            assert.ok(err instanceof Error, 'a real Error must be propagated, got: ' + typeof err);
            assert.equal(typeof err.stack, 'string',
                'callers print err.stack (lib/cmd/view/add.js shape) — it must exist');
            assert.equal(fs.readFileSync(dst, 'utf8'), 'PRECIOUS-OLD',
                'the previous content must survive a failed copy');
            assert.deepEqual(noTmpResidue(work), [], 'the temp sibling must be reaped on failure');
            done();
        });
    });

    it('a destination-side failure settles the callback exactly ONCE, as an Error', function (t, done) {
        var src = path.join(work, 'single-settle-src.txt');
        var dst = path.join(work, 'no-such-dir', 'out.txt');   // parent dir absent → dest stream ENOENT
        fs.writeFileSync(src, 'X');
        var calls = [];
        new _(src).cp(dst, function (err) {
            calls.push(err);
            if (calls.length > 1) {
                // a second settle is the pre-fix double-settle shape — fail loudly
                assert.fail('callback settled ' + calls.length + ' times; second value: ' + calls[1]);
            }
            // give the pre-fix 'close'-after-'error' shape time to fire a second settle
            setTimeout(function () {
                assert.equal(calls.length, 1, 'exactly one settle');
                assert.ok(calls[0] instanceof Error, 'the single settle must carry the real Error');
                done();
            }, 250);
        });
    });

    it('mv() moves the bytes and removes the source', function (t, done) {
        var src = path.join(work, 'mv-src.txt');
        var dst = path.join(work, 'mv-dst.txt');
        fs.writeFileSync(src, 'MOVED-PAYLOAD');
        new _(src).mv(dst, function (err) {
            assert.ok(!err, 'unexpected error: ' + (err && err.message));
            assert.equal(fs.readFileSync(dst, 'utf8'), 'MOVED-PAYLOAD');
            assert.equal(fs.existsSync(src), false, 'source must be removed after a successful move');
            done();
        });
    });

    it('directory copy still walks every entry (browseCopy recursion intact)', function (t, done) {
        var srcDir = path.join(work, 'dir-src');
        var dstDir = path.join(work, 'dir-dst');
        fs.mkdirSync(srcDir);
        fs.writeFileSync(path.join(srcDir, 'one.txt'), 'ONE');
        fs.writeFileSync(path.join(srcDir, 'two.txt'), 'TWO');
        new _(srcDir).cp(dstDir, function (err) {
            assert.ok(!err, 'unexpected error: ' + (err && err.message));
            assert.equal(fs.readFileSync(path.join(dstDir, 'one.txt'), 'utf8'), 'ONE');
            assert.equal(fs.readFileSync(path.join(dstDir, 'two.txt'), 'utf8'), 'TWO');
            assert.deepEqual(noTmpResidue(dstDir), [], 'no temp residue in the copied tree');
            done();
        });
    });
});
