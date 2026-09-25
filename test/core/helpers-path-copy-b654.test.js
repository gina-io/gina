/**
 * #B654 — a failed path-helper copy always reports an Error with a string `stack`.
 *
 * Bun (1.3, 1.4) reports stream errors such as EACCES as an Error with no `stack`
 * property at all (measured in `oven/bun` containers; Node gives a string). The
 * #B227 rework of `copyFile` (helpers/path.js) normalises only non-Error values, so
 * on Bun the Error went through without a stack and callers printing `err.stack`
 * (lib/cmd/view/add.js does) printed `undefined`.
 *
 * The arm below reproduces that shape on any runtime: it hands `copyFile` a source
 * stream that fails with an Error whose `stack` was deleted. It needs no file mode
 * trick, so it also runs as root (where CI's Bun job runs, and where the EACCES arms
 * of helpers-path-copy.test.js return early).
 *
 * Red-first: on the pre-change `copyFile` the callback's error has no string stack.
 */
'use strict';

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { Readable } = require('stream');

var ginaRoot = path.resolve(__dirname, '../..');
var version = require(ginaRoot + '/package.json').version;
var FW = path.join(ginaRoot, 'framework', 'v' + version);

describe('01 - a copy that fails with a stackless Error reports it with a stack (#B654)', function () {

    var work = null;
    var realCreateReadStream = fs.createReadStream;

    before(function () {
        process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
        require('module').Module._initPaths();
        require(path.join(FW, 'helpers'));                              // _, existsSync, ...
        require(path.resolve(FW, '..', '..', 'utils', 'prototypes'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-path-copy-b654-'));
    });

    after(function () {
        fs.createReadStream = realCreateReadStream;
        try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    });

    it('keeps the error, its code and message, and gives it a string stack', function (t, done) {
        var src = path.join(work, 'source.txt');
        var dst = path.join(work, 'destination.txt');
        fs.writeFileSync(src, 'SOURCE');
        fs.writeFileSync(dst, 'PRECIOUS-OLD');

        var served = 0;
        fs.createReadStream = function (p) {
            if ( p === src ) {
                served++;
                var stream = new Readable({ read: function () {} });
                process.nextTick(function () {
                    var err = new Error('EACCES: permission denied, open ' + src);
                    err.code = 'EACCES';
                    delete err.stack;                                    // the Bun shape
                    stream.destroy(err);
                });
                return stream;
            }
            return realCreateReadStream.apply(fs, arguments);
        };

        new _(src).cp(dst, function (err) {
            fs.createReadStream = realCreateReadStream;
            try {
                assert.equal(served, 1, 'CONTROL: the copy read the stubbed source');
                assert.ok(err instanceof Error, 'an Error is reported');
                assert.equal(err.code, 'EACCES', 'the original error is kept');
                assert.match(err.message, /permission denied/, 'with its message');
                assert.equal(typeof err.stack, 'string', 'callers print err.stack — it must be a string');
                assert.match(err.stack, /EACCES: permission denied/, 'the stack names the error');
                assert.equal(fs.readFileSync(dst, 'utf8'), 'PRECIOUS-OLD', 'the previous content survives');
                done();
            } catch (e) { done(e); }
        });
    });
});
