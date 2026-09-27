/**
 * framework:init checkRunningPids — run-dir pidfile liveness / cleanup
 *
 * Why source inspection + simulation instead of requiring the module:
 *   init.js depends on injected globals (lib.logger, getPath, getEnvVar, _,
 *   GINA_RUNDIR) only present inside a running gina process — so it cannot be
 *   required in a bare node:test context (the same constraint
 *   framework-init-middleware.test.js / framework-reset.test.js document). The
 *   end-to-end behaviour is validated by the Bun container smoke.
 *
 * Background: checkRunningPids runs in the framework:init chain ahead of every
 * command's handler. It enumerates the run dir's pidfiles and prunes the stale
 * ones. It used to liveness-check each pid with a `ps -p <pid> -o pid=`
 * shell-out and prune on any throw — two latent defects: (a) on a minimal image
 * WITHOUT `ps` (bare oven/bun is Debian-slim, no procps) every check throws, so
 * init prunes ALL pidfiles on every command (bundle:list / minion:list /
 * framework:reset's guard then see nothing running); (b) the pid was read
 * untrimmed, so a trailing newline broke the interpolated `ps` command. The fix
 * replaces the shell-out with process.kill(pid, 0) (ps-independent, identical
 * Node/Bun) + a trimmed, parsed pid — mirroring lib/cmd/framework/reset.js
 * detectRunning.
 *
 * Covers:
 *   (a) source structure — process.kill(pid, 0) liveness (no `ps` shell-out in
 *       the block, while execFileSync legitimately survives elsewhere in the file),
 *       trimmed + parsed pid, EPERM-as-alive, the rmSync prune, the run-dir
 *       enumeration + dotfile skip
 *   (b) the prune decision (pure-logic replica) incl. the trailing-newline
 *       regression and a subtract vs the pre-fix `ps` shell-out
 */
'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var SOURCE_PATH = path.join(require('../fw'), 'lib/cmd/framework/init.js');
var src = fs.readFileSync(SOURCE_PATH, 'utf8');

/** Strip block + line comments so negative code-absence pins don't trip on the
 *  file's own comments (the jsdoc.md "negative pin trips on the file's own
 *  comment" trap). */
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Slice the checkRunningPids body, start-anchored on its declaration and
 *  end-anchored on the next declaration (self.end) so the window can't drift. */
function checkRunningPidsBlock() {
    var start = src.indexOf('self.checkRunningPids = function(done) {');
    var end   = src.indexOf('self.end = function(done) {', start);
    assert.ok(start > -1 && end > start, 'could not slice checkRunningPids body');
    return src.slice(start, end);
}


// ---------------------------------------------------------------------------
// 01 — source structure
// ---------------------------------------------------------------------------
describe('01 - checkRunningPids source structure', function() {

    it('probes liveness via process.kill(pid, 0), not a ps shell-out', function() {
        var blk = checkRunningPidsBlock();
        assert.ok(blk.indexOf('process.kill(pid, 0)') > -1, 'expected a process.kill(pid, 0) liveness probe');
        var clean = stripComments(blk);
        assert.ok(clean.indexOf('ps -p') < 0, 'expected no `ps -p` shell-out in checkRunningPids');
        assert.ok(clean.indexOf('execSync(') < 0, 'expected no execSync(...) call in checkRunningPids');
        // execFileSync legitimately survives elsewhere in init.js (the npm-prefix lookup, an
        // argument vector since #B665 S2); comment-stripped, so a kept `was:` line cannot pass it.
        assert.ok(stripComments(src).indexOf('execFileSync(') > -1, 'execFileSync import/use must remain elsewhere in init.js');
    });

    it('reads the pid trimmed and parsed (so a trailing newline cannot break it)', function() {
        var blk = checkRunningPidsBlock();
        assert.ok(blk.indexOf('parseInt(') > -1, 'expected parseInt(...) of the pidfile content');
        assert.ok(blk.indexOf('.trim()') > -1, 'expected the pidfile content to be trimmed');
    });

    it('counts EPERM as alive and prunes stale pidfiles with rmSync', function() {
        var blk = checkRunningPidsBlock();
        assert.ok(blk.indexOf("'EPERM'") > -1, 'expected EPERM handled as alive (conservative)');
        assert.ok(blk.indexOf('filenameObj.rmSync()') > -1, 'expected the stale-pidfile prune via rmSync');
    });

    it('enumerates the run dir and skips dotfiles', function() {
        var blk = checkRunningPidsBlock();
        assert.ok(blk.indexOf('fs.readdirSync(runDir)') > -1, 'expected the run-dir enumeration');
        assert.ok(blk.indexOf('/^\\./') > -1, 'expected the dotfile skip');
    });

});


// ---------------------------------------------------------------------------
// 02 — prune decision (pure-logic replica)
// ---------------------------------------------------------------------------
describe('02 - run-dir prune logic', function() {

    /**
     * Mirror of checkRunningPids' loop: skip dotfiles; for every other file read
     * the pid (trimmed + parsed); prune (rmSync) empty/garbage/zero pids and any
     * whose process is not alive; keep alive (or EPERM) ones. NOTE: no `.pid`
     * filter — checkRunningPids processes all non-dot files (incl. the gina-*
     * daemon pidfile), matching the shipped behaviour.
     * @param {Object.<string,string>} files  filename -> pidfile content
     * @param {function(number):string} kill   pid -> 'alive' | 'ESRCH' | 'EPERM'
     * @returns {{kept:string[], pruned:string[]}}
     */
    function runCheck(files, kill) {
        var kept = [], pruned = [];
        Object.keys(files).forEach(function(file) {
            if (/^\./.test(file)) return;                          // dotfile -> skipped entirely
            var pid = parseInt(String(files[file]).trim(), 10);
            if (!pid || isNaN(pid)) { pruned.push(file); return; } // empty/garbage/zero -> prune
            var v = kill(pid);
            if (v === 'alive' || v === 'EPERM') kept.push(file);   // alive (or foreign-owned) -> keep
            else pruned.push(file);                                // ESRCH (stale) -> prune
        });
        return { kept: kept, pruned: pruned };
    }

    it('keeps live bundle AND gina-* daemon pidfiles, prunes stale (ESRCH)', function() {
        var files = { 'api@demo.pid': '111', 'web@demo.pid': '222', 'gina-v0.5.5-alpha.2.pid': '333' };
        var res = runCheck(files, function(pid) { return pid === 222 ? 'ESRCH' : 'alive'; });
        assert.deepEqual(res.kept.sort(), ['api@demo.pid', 'gina-v0.5.5-alpha.2.pid']);
        assert.deepEqual(res.pruned, ['web@demo.pid']);
    });

    it('counts an EPERM pid (foreign-owned, alive) as kept', function() {
        var res = runCheck({ 'api@demo.pid': '999' }, function() { return 'EPERM'; });
        assert.deepEqual(res.kept, ['api@demo.pid']);
        assert.deepEqual(res.pruned, []);
    });

    it('keeps a LIVE process whose pidfile has a trailing newline (defect-b regression)', function() {
        var res = runCheck({ 'api@demo.pid': '12345\n' }, function(pid) { return pid === 12345 ? 'alive' : 'ESRCH'; });
        assert.deepEqual(res.kept, ['api@demo.pid']);
        assert.deepEqual(res.pruned, []);
    });

    it('prunes empty/garbage/zero pids and non-pid files; skips dotfiles', function() {
        var files = { '.DS_Store': 'x', 'notes.txt': 'y', 'bad.pid': 'notanumber', 'zero.pid': '0', 'ok.pid': '42' };
        var res = runCheck(files, function() { return 'alive'; });
        assert.deepEqual(res.kept, ['ok.pid']);
        // .DS_Store skipped (neither kept nor pruned); the rest pruned (no .pid filter).
        assert.deepEqual(res.pruned.sort(), ['bad.pid', 'notes.txt', 'zero.pid']);
    });

    it('subtract: the pre-fix ps shell-out prunes a live newline-pidfile process; the fix keeps it', function() {
        // Pre-fix: execSync("ps -p " + raw + " -o pid=") with an UNTRIMMED pid.
        // A trailing newline splits the shell command (the fragment after the
        // newline runs as its own failing command), so execSync throws and the
        // live process is treated as dead -> pruned.
        function oldPsThrows(raw) { return !/^\d+$/.test(raw); }   // newline / non-digit -> ps command fails
        var raw = '12345\n';
        assert.equal(oldPsThrows(raw), true, 'pre-fix: the newline breaks the ps command -> live process pruned (the bug)');

        var res = runCheck({ 'api@demo.pid': raw }, function(pid) { return pid === 12345 ? 'alive' : 'ESRCH'; });
        assert.deepEqual(res.kept, ['api@demo.pid'], 'fix: trimmed + parsed pid + process.kill keeps the live process');
        assert.deepEqual(res.pruned, []);
    });

});


// ---------------------------------------------------------------------------
// 03 — unreadable run-dir entry guard (source structure)
//
// checkRunningPids enumerates EVERY non-dot entry of the run dir and reads it as
// a pidfile. An entry that cannot be read — a nested directory (EISDIR), an entry
// pruned by a concurrent run (ENOENT), an unreadable one (EACCES) — used to throw
// straight out of the loop, aborting the whole framework:init chain and failing
// the command that triggered it. A run dir with a `gina/` child directory is not
// hypothetical: getRunDir's fallbacks compose both `<prefix>/var/run` and
// `<prefix>/var/run/gina`, so the un-suffixed parent enumerates the suffixed
// child as one of its entries.
// ---------------------------------------------------------------------------
describe('03 - unreadable run-dir entry guard', function() {

    /** Slice the read-failure catch handler, end-anchored on the statement that
     *  follows it (`if (!pid`) so the window cannot drift into the prune branch. */
    function readFailureHandler() {
        var blk   = checkRunningPidsBlock();
        var start = blk.indexOf('catch (readErr) {');
        var end   = blk.indexOf('if (!pid', start);
        assert.ok(start > -1 && end > start, 'could not slice the read-failure handler');
        return blk.slice(start, end);
    }

    it('wraps the pidfile read in a try/catch', function() {
        // Ordering pins are computed on the COMMENT-STRIPPED block: the block's own
        // explanatory comment names process.kill(pid, 0) ahead of the read, which
        // would otherwise satisfy the probe anchor at the wrong offset.
        var clean  = stripComments(checkRunningPidsBlock());
        var readAt = clean.indexOf('fs.readFileSync(filename)');
        assert.ok(readAt > -1, 'expected the pidfile read');
        var tryAt = clean.lastIndexOf('try {', readAt);
        assert.ok(tryAt > -1, 'expected a try block opening before the pidfile read');
        var catchAt = clean.indexOf('catch (readErr) {', readAt);
        assert.ok(catchAt > readAt, 'expected the read-failure catch clause after the pidfile read');
        // The liveness probe has its own try/catch (EPERM/ESRCH); the read guard must
        // be a DISTINCT one that opens before the read, not that same block reused.
        var killAt = clean.indexOf('process.kill(pid, 0);');
        assert.ok(killAt > catchAt, 'the liveness probe must follow the read guard, not share it');
    });

    it('skips an unreadable entry instead of throwing out of the loop', function() {
        var handler = stripComments(readFailureHandler());
        assert.ok(handler.indexOf('continue;') > -1, 'expected the read-failure handler to continue the loop');
    });

    it('never prunes an entry it could not read', function() {
        // The rmSync branches are only safe for entries whose CONTENT was read
        // (empty/garbage pid, or a dead process). Pruning on a read failure would
        // delete a live bundle's pidfile on a transient EACCES — and rmSync on the
        // nested run directory would destroy a sibling install's pidfiles.
        var handler = stripComments(readFailureHandler());
        assert.ok(handler.indexOf('rmSync') < 0, 'expected NO prune in the read-failure handler');
        // Control: the prune does still exist in the block as a whole.
        assert.ok(stripComments(checkRunningPidsBlock()).indexOf('filenameObj.rmSync()') > -1,
            'the garbage/stale prune must remain outside the read-failure handler');
    });

});


// ---------------------------------------------------------------------------
// 04 — unreadable run-dir entry guard (real-filesystem behaviour)
// ---------------------------------------------------------------------------
describe('04 - run-dir walk over a real directory', function() {

    var os = require('os');

    /** Build a throwaway run dir, hand it to fn, and always remove it. */
    function withRunDir(entries, fn) {
        var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-rundir-'));
        try {
            Object.keys(entries).forEach(function(name) {
                var target = path.join(dir, name);
                if (entries[name] === '<dir>') {
                    fs.mkdirSync(target);
                } else if (entries[name] === '<dangling-symlink>') {
                    fs.symlinkSync(path.join(dir, 'no-such-target-' + name), target);
                } else {
                    fs.writeFileSync(target, entries[name]);
                }
            });
            return fn(dir);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    /** Pre-fix loop body: every non-dot entry read UNGUARDED. */
    function walkUnguarded(runDir) {
        var seen  = [];
        var files = fs.readdirSync(runDir);
        for (let f in files) {
            if ( /^\./.test(files[f]) ) { continue; }
            let filename = path.join(runDir, files[f]);
            let pid = parseInt(String(fs.readFileSync(filename)).trim(), 10);
            seen.push(files[f] + ':' + pid);
        }
        return seen.sort();
    }

    /** Post-fix loop body: the read guarded -> continue, never pruning. */
    function walkGuarded(runDir) {
        var seen = [], skipped = [];
        var files = fs.readdirSync(runDir);
        for (let f in files) {
            if ( /^\./.test(files[f]) ) { continue; }
            let filename = path.join(runDir, files[f]);
            let pid = null;
            try {
                pid = parseInt(String(fs.readFileSync(filename)).trim(), 10);
            } catch (readErr) {
                skipped.push(files[f] + ':' + readErr.code);
                continue;
            }
            seen.push(files[f] + ':' + pid);
        }
        return { seen: seen.sort(), skipped: skipped.sort() };
    }

    it('instrument: reading a directory as a file really does throw EISDIR', function() {
        // Validates the FIXTURE before any conclusion rests on it — if this stopped
        // throwing, every arm below would pass for the wrong reason.
        withRunDir({ 'gina': '<dir>' }, function(dir) {
            var err = null;
            try { fs.readFileSync(path.join(dir, 'gina')); } catch (e) { err = e; }
            assert.ok(err, 'expected reading a directory to throw');
            assert.ok(['EISDIR', 'EPERM'].indexOf(err.code) > -1,   // POSIX / win32
                'expected EISDIR (POSIX), got ' + err.code);
        });
    });

    it('pre-fix: a nested run directory aborts the whole walk (the defect)', function() {
        withRunDir({ 'api@demo.pid': '111', 'gina': '<dir>', 'web@demo.pid': '222' }, function(dir) {
            var err = null;
            try { walkUnguarded(dir); } catch (e) { err = e; }
            assert.ok(err, 'expected the unguarded walk to throw on the nested directory');
            assert.equal(err.code, 'EISDIR');
        });
    });

    it('post-fix: the same run dir walks clean, reporting the entry as skipped', function() {
        withRunDir({ 'api@demo.pid': '111', 'gina': '<dir>', 'web@demo.pid': '222' }, function(dir) {
            var res = walkGuarded(dir);
            assert.deepEqual(res.seen, ['api@demo.pid:111', 'web@demo.pid:222'],
                'both real pidfiles must still be processed');
            assert.deepEqual(res.skipped, ['gina:EISDIR']);
        });
    });

    it('post-fix: an entry that vanishes before the read is skipped, not fatal', function() {
        // A dangling symlink reproduces the readdir-then-vanish race deterministically:
        // enumerated by readdirSync, ENOENT on read.
        withRunDir({ 'api@demo.pid': '111', 'ghost@demo.pid': '<dangling-symlink>' }, function(dir) {
            var res = walkGuarded(dir);
            assert.deepEqual(res.seen, ['api@demo.pid:111']);
            assert.deepEqual(res.skipped, ['ghost@demo.pid:ENOENT']);
        });
    });

    it('subtract: with no unreadable entry, guarded and unguarded walks agree', function() {
        // The guard must change NOTHING for a normal run dir.
        withRunDir({ 'api@demo.pid': '111', 'web@demo.pid': '222\n', '.DS_Store': 'x' }, function(dir) {
            var guarded = walkGuarded(dir);
            assert.deepEqual(guarded.seen, walkUnguarded(dir), 'guarded walk must match the unguarded one');
            assert.deepEqual(guarded.skipped, [], 'nothing to skip in a healthy run dir');
        });
    });

});
