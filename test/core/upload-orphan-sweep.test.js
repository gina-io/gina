'use strict';
/**
 * server.js — #B469 staged-upload orphan sweep (boot-time)
 *
 * A staged multipart part (`<32 lowercase hex>.part`, written to the group's
 * `path` or the global landing dir at parse time) has exactly two reclaim
 * paths: the `movefiles()` unlink when `self.store()` publishes it, and the
 * per-upload `autoTmpCleanupTimeout` timer. The timer is in-process, so a
 * restart strands every part it was holding — and a part that never reaches
 * `store()` (a request failing AFTER the multipart parse, or an app consuming
 * the staged file some other way) then has NO reclaim path at all. #B469 adds
 * a boot-time sweep, armed ONLY when `autoTmpCleanupTimeout` itself is armed:
 * the same reclaim policy, applied across process lifetimes.
 *
 * Strategy: brace-walk extraction of the shipped `sweepStagedUploadOrphans`
 * (server.js cannot be require()d in isolation) + a real-fs behavioural arm
 * over a scratch directory, plus source pins on the init-site wiring and a
 * two-sided contract pin tying the sweep's name gate to what the staging
 * write site actually generates. Comment-stripped views are used for the
 * wiring pins — the init block's own comment names the tokens being pinned.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');

var SOURCE = path.join(require('../fw'), 'core/server.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');

/** Full-line comment strip — keeps inline code, drops `//` and `*` lines. */
function stripComments(src) {
    return src.split('\n').filter(function(l) {
        var t = l.trim();
        return t.indexOf('//') !== 0 && t.indexOf('*') !== 0 && t.indexOf('/*') !== 0;
    }).join('\n');
}
var ACTIVE = stripComments(SRC);

/**
 * Brace-walk extraction: slice `decl` → its balanced closing brace.
 * started-flag form (the decl need not carry the opening brace itself);
 * uniqueness + balance are asserted by the caller as extraction controls.
 */
function extractFn(src, decl) {
    var declIdx = src.indexOf(decl);
    if (declIdx < 0) return null;
    if (src.indexOf(decl, declIdx + 1) > -1) return { dup: true };
    var i = declIdx, depth = 0, started = false;
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') { depth--; }
        if (started && depth === 0) break;
    }
    if (!started || depth !== 0) return { unbalanced: true };
    return { text: src.slice(declIdx, i + 1), declIdx: declIdx };
}

var DECL = 'var sweepStagedUploadOrphans = function(dirs, olderThanMs, done) {';
var extracted = extractFn(SRC, DECL);

// Compiled once; `fs` is the function's only free variable (module const in
// server.js) — injected here so the extracted bytes run against the real fs.
var sweep = null;
if (extracted && extracted.text) {
    var fnSrc = extracted.text.replace(/^var sweepStagedUploadOrphans = /, '');
    sweep = new Function('fs', 'return (' + fnSrc + ');')(fs);
}

// scratch dirs for the behavioural arms
var scratchA, scratchB, missingDir;
var OLD_SEC  = (Date.now() - 7200 * 1000) / 1000; // 2h ago, past any test threshold

function seed(dir, name, opts) {
    var full = path.join(dir, name);
    if (opts && opts.dir) { fs.mkdirSync(full); return full; }
    if (opts && opts.symlinkTo) { fs.symlinkSync(opts.symlinkTo, full); return full; }
    fs.writeFileSync(full, opts && opts.body || 'x');
    if (opts && opts.old) fs.utimesSync(full, OLD_SEC, OLD_SEC);
    return full;
}

describe('01 - extraction controls (instruments that can fail)', function() {

    it('the declaration exists exactly once and brace-matches', function() {
        assert.ok(extracted, 'declaration not found in server.js');
        assert.ok(!extracted.dup, 'declaration matched more than once — slice would be ambiguous');
        assert.ok(!extracted.unbalanced, 'brace walk did not balance — extraction slice is wrong');
        assert.ok(extracted.text.length > 200, 'suspiciously small slice');
    });

    it('the extracted bytes compile and take (dirs, olderThanMs, done)', function() {
        assert.equal(typeof sweep, 'function');
        assert.equal(sweep.length, 3);
    });
});

describe('02 - behavioural: removes exactly the old, staged-shaped regular files', function() {

    var report;
    var removedName = 'a1b2c3d4e5f60718293a4b5c6d7e8f90.part';

    before(async function() {
        scratchA = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-sweep-a-'));
        // (a) staged shape + old               -> REMOVED
        seed(scratchA, removedName, { old: true });
        // (b) staged shape + fresh             -> kept (age gate)
        seed(scratchA, '00112233445566778899aabbccddeeff.part', {});
        // (c) ordinary file + old              -> kept (name gate)
        seed(scratchA, 'summary.txt', { old: true });
        // (d) 31-hex + old                     -> kept (name gate: not 32 hex)
        seed(scratchA, '0112233445566778899aabbccddeeff.part', { old: true });
        // (e) uppercase hex + old              -> kept (name gate: staging emits lowercase).
        //     Digits deliberately do NOT case-collide with (a): on a
        //     case-insensitive filesystem (macOS default) a case-colliding
        //     name is the SAME file, and the fixture would test nothing.
        seed(scratchA, 'B1B2C3D4E5F60718293A4B5C6D7E8F91.part', { old: true });
        // (f) DIRECTORY named like a part      -> kept (regular-files-only)
        seed(scratchA, 'ffeeddccbbaa99887766554433221100.part', { dir: true });
        // (g) SYMLINK named like a part        -> kept (lstat never follows)
        var target = seed(scratchA, 'target.bin', { old: true });
        seed(scratchA, '123456789abcdef0123456789abcdef0.part', { symlinkTo: target });
        // (h) client-named orphan (pre-staged-naming shape) -> kept
        seed(scratchA, 'photo.jpg', { old: true });

        report = await new Promise(function(resolve) {
            sweep([scratchA], 1000, resolve);
        });
    });

    after(function() {
        fs.rmSync(scratchA, { recursive: true, force: true });
    });

    it('removes ONLY the old staged-shaped regular file', function() {
        var left = fs.readdirSync(scratchA).sort();
        assert.ok(left.indexOf(removedName) < 0, 'the old staged part must be removed');
        assert.deepEqual(left, [
            '00112233445566778899aabbccddeeff.part',
            '0112233445566778899aabbccddeeff.part',
            '123456789abcdef0123456789abcdef0.part',
            'B1B2C3D4E5F60718293A4B5C6D7E8F91.part',
            'ffeeddccbbaa99887766554433221100.part',
            'photo.jpg',
            'summary.txt',
            'target.bin'
        ]);
    });

    it('report counters: scanned = name-matching entries, removed = 1, errors = 0', function() {
        // name-matching entries considered: (a) removed, (b) fresh, (f) dir, (g) symlink
        assert.equal(report.scanned, 4);
        assert.equal(report.removed, 1);
        assert.equal(report.errors, 0);
    });

    it('the symlink itself survives AND its target survives', function() {
        var lst = fs.lstatSync(path.join(scratchA, '123456789abcdef0123456789abcdef0.part'));
        assert.ok(lst.isSymbolicLink());
        assert.ok(fs.existsSync(path.join(scratchA, 'target.bin')));
    });
});

describe('03 - behavioural: a missing dir is silently skipped, later dirs still swept', function() {

    it('sweeps dir 2 with zero errors when dir 1 does not exist', async function() {
        scratchB   = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-sweep-b-'));
        missingDir = path.join(os.tmpdir(), 'gina-sweep-definitely-missing-' + process.pid);
        seed(scratchB, 'deadbeefdeadbeefdeadbeefdeadbeef.part', { old: true });
        var report = await new Promise(function(resolve) {
            sweep([missingDir, scratchB], 1000, resolve);
        });
        assert.equal(report.errors, 0, 'ENOENT on a staging dir is not an error');
        assert.equal(report.removed, 1);
        assert.ok(!fs.existsSync(path.join(scratchB, 'deadbeefdeadbeefdeadbeefdeadbeef.part')));
        fs.rmSync(scratchB, { recursive: true, force: true });
    });

    it('a broken threshold (NaN / 0 / negative) makes the whole sweep a no-op', async function() {
        var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-sweep-c-'));
        seed(dir, 'deadbeefdeadbeefdeadbeefdeadbeef.part', { old: true });
        for (var _i = 0; _i < 3; _i++) {
            var threshold = [NaN, 0, -5][_i];
            var report = await new Promise(function(resolve) {
                sweep([dir], threshold, resolve);
            });
            assert.deepEqual(report, { scanned: 0, removed: 0, errors: 0 });
        }
        assert.ok(fs.existsSync(path.join(dir, 'deadbeefdeadbeefdeadbeefdeadbeef.part')),
            'nothing may be deleted on a broken threshold');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('04 - wiring pins: the init site arms the sweep the way the timer itself is armed', function() {

    it('the sweep is gated on the SAME four-condition arming shape as the request-path timer', function() {
        // access-prefixed, comment-stripped: the init block's own comment names
        // the bare key, so pins anchor on forms prose does not carry
        assert.match(ACTIVE, /typeof\(_uploadSettings\.autoTmpCleanupTimeout\)\s*!=\s*'undefined'/);
        assert.match(ACTIVE, /!\/false\/i\.test\(_uploadSettings\.autoTmpCleanupTimeout\)/);
        assert.match(ACTIVE, /parseTimeout\(_uploadSettings\.autoTmpCleanupTimeout\)/);
    });

    it('the call is deferred (setImmediate) and given a 1h margin above the timeout', function() {
        assert.match(ACTIVE, /setImmediate\(function\(\)\s*\{\s*sweepStagedUploadOrphans\(_sweepDirs,\s*_sweepTimeoutMs\s*\+\s*3600000\s*,/);
    });

    it('the staging-dir set mirrors the write site: global landing dir + per-group paths', function() {
        assert.match(ACTIVE, /_uploadSettings\.uploadDir\s*\|\|\s*_uploadSettings\.tmpPath\s*\|\|\s*os\.tmpdir\(\)/);
        assert.match(ACTIVE, /_sweepDirs\.indexOf\(_sgPath\)\s*<\s*0/);
    });

    it('ordering: the truthy-parse gate precedes the sweep call (no sweep on a null/invalid parse)', function() {
        var gateIdx = ACTIVE.indexOf('if (_sweepTimeoutMs) {');
        var callIdx = ACTIVE.indexOf('sweepStagedUploadOrphans(_sweepDirs');
        assert.ok(gateIdx > -1, 'truthiness gate not found');
        assert.ok(callIdx > -1, 'init call site not found');
        assert.ok(gateIdx < callIdx, 'the sweep call must sit behind the truthy-parse gate');
    });
});

describe('05 - two-sided contract: the name gate matches what the staging write site generates', function() {

    it('the sweep gates on 32 lowercase hex + .part', function() {
        assert.ok(ACTIVE.indexOf('/^[0-9a-f]{32}\\.part$/.test(name)') > -1,
            'the sweep name gate changed shape — re-pair it with the staged-name generator');
    });

    it('the write site still generates exactly that shape', function() {
        assert.ok(ACTIVE.indexOf("crypto.randomBytes(16).toString('hex') + '.part'") > -1,
            'the staged-name generator changed — the sweep name gate at the pin above must follow');
    });
});
