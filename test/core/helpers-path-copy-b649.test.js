/**
 * #B649 — a FAILED path-helper copy reaps its temp sibling even when the temp
 * file's open completes AFTER the failure is reported.
 *
 * `copyFile` (helpers/path.js) opens the source and the temp-sibling write stream
 * together. The temp stream's `open(O_CREAT)` runs on a libuv worker thread, so a
 * source that fails at open (EACCES) can be reported before the temp file exists:
 * the old error path checked `fs.existsSync(_tmpTarget)` at that moment, found
 * nothing, and the file the open created a moment later was never reaped (its
 * `destroy()` only closes the fd). Under CPU contention this made the #B227 arm
 * `helpers-path-copy §02` fail intermittently on CI.
 *
 * The arm below makes the ordering deterministic: it delays the temp file's
 * `fs.open` (the write stream routes its open through the `fs` module's property,
 * measured on Node and Bun) so the source failure always wins, and asserts the
 * delay actually fired as a control — without it the arm could pass vacuously.
 */
'use strict';

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');

var ginaRoot = path.resolve(__dirname, '../..');
var version = require(ginaRoot + '/package.json').version;
var FW = path.join(ginaRoot, 'framework', 'v' + version);

describe('01 - a failed copy reaps a temp sibling whose open completes late (#B649)', function () {

    var work = null;
    var lockedSrc = null;   // chmod 000 — restored in after() so rmSync can reap it
    var realOpen = fs.open;

    before(function () {
        process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
        require('module').Module._initPaths();
        require(path.join(FW, 'helpers'));                              // _, existsSync, ...
        require(path.resolve(FW, '..', '..', 'utils', 'prototypes'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-path-copy-b649-'));
    });

    after(function () {
        fs.open = realOpen;
        try { if (lockedSrc) fs.chmodSync(lockedSrc, 448 /* 0o700 */); } catch (e) { /* best effort */ }
        try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    });

    function tmpResidue(dir) {
        return fs.readdirSync(dir).filter(function (f) { return /\.tmp$/.test(f); });
    }

    // root ignores mode bits, so the EACCES trigger cannot fire there
    var isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

    it('no temp file is left behind, at the callback or after a settle delay', { skip: isRoot ? 'root ignores mode bits' : false }, function (t, done) {
        var src = path.join(work, 'locked-src.txt');
        var dst = path.join(work, 'survivor.txt');
        fs.writeFileSync(src, 'UNREACHABLE');
        fs.writeFileSync(dst, 'PRECIOUS-OLD');
        fs.chmodSync(src, 0);                  // the read stream errors EACCES at open
        lockedSrc = src;

        var delayed = 0;
        fs.open = function (p) {
            var args = arguments;
            if ( typeof p === 'string' && p.indexOf(dst + '.') === 0 && /\.tmp$/.test(p) ) {
                delayed++;
                setTimeout(function () { realOpen.apply(fs, args); }, 50);
                return;
            }
            return realOpen.apply(fs, args);
        };

        new _(src).cp(dst, function (err) {
            try {
                assert.equal(delayed, 1, 'CONTROL: the temp file\'s open was delayed (the ordering under test)');
                assert.ok(err instanceof Error, 'the failed copy reports an Error');
                assert.equal(fs.readFileSync(dst, 'utf8'), 'PRECIOUS-OLD', 'the previous content survives');
                assert.deepEqual(tmpResidue(work), [], 'no temp sibling at the callback');
            } catch (e) {
                fs.open = realOpen;
                return done(e);
            }
            // the late open has had time to land by now on the old code path
            setTimeout(function () {
                fs.open = realOpen;
                try {
                    assert.deepEqual(tmpResidue(work), [], 'no temp sibling after the late open completed');
                    done();
                } catch (e) { done(e); }
            }, 150);
        });
    });
});
