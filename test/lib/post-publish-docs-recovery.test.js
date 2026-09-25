/**
 * script/post_publish.js syncDocs — the docs-repo recovery recipes it PRINTS (source-structure pin).
 *
 * When the post-publish lockfile regeneration is outrun by the registry — which happens on
 * EVERY staged cut, because a staged version is not installable until it is approved —
 * syncDocs fails closed and prints a one-line recovery recipe for the operator to paste.
 * It has two recovery branches:
 *   - revert: the lockfile still pins the previous release, so the devDependency was put
 *     back to match it and develop WAS merged into main. The pin is caught up later on
 *     develop, and that ONE commit has to reach main (the docs API reference is generated
 *     from the installed gina, i.e. from the lock pin).
 *   - skipped merge: the locked version was unreadable, so develop was NOT merged into main.
 *     The recovery regenerates the pair on develop, then performs the merge syncDocs skipped.
 *
 * The docs repo's main and develop are permanently SHA-diverged (syncDocs lands a merge
 * commit on main at every cut), so the recipes this pin replaced — `git checkout main &&
 * git merge --ff-only develop` — could never succeed, and because the checkout came first,
 * a paste left the operator's docs checkout parked on main: the state that halts the next
 * cut's syncDocs at its first step. They also committed with `-am`, sweeping any
 * uncommitted docs work into the lockfile commit, and never pushed develop.
 *
 * The shipped recipes were run against a replica of the docs topology before this pin was
 * written (a local bare origin, main diverged by merge commits, a second clone pushing the
 * next release's docs to develop, uncommitted work in the primary checkout, a conflicting
 * main for the merge branch). The pin renders every printed command line with a stub
 * version and asserts the properties that replica measured.
 */

'use strict';

var nodePath = require('path');
var fs = require('fs');
var spawnSync = require('child_process').spawnSync;
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

// GINA_POST_PUBLISH_SRC runs the pin against another revision of the script
// (red-first validation against `git show HEAD:script/post_publish.js`).
var SOURCE = process.env.GINA_POST_PUBLISH_SRC || nodePath.join(__dirname, '..', '..', 'script', 'post_publish.js');
var SRC = fs.readFileSync(SOURCE, 'utf8');
var VERSION = '9.8.7';

/**
 * Renders every `console.warn('[syncDocs]   cd …')` command line of syncDocs with a stub
 * `self.publishedVersion`, and records which recovery branch printed it. The revert branch
 * precedes the skipped-merge branch in the source, so a line's branch is decided by which
 * of the two warnings it follows.
 *
 * @inner
 * @returns {Array<{branch: string, text: string}>} each printed command line, rendered
 * @throws {Error} when a command line references anything but `self.publishedVersion`
 */
function renderCommandLines() {
    var revertAt = SRC.indexOf('reverted devDependencies.gina to');
    var skipAt = SRC.indexOf('could not read the locked gina version');
    var re = /console\.warn\((\s*'\[syncDocs\]   cd [^\n]*?)\);[ \t]*$/gm;
    var out = [];
    var m;
    while ((m = re.exec(SRC)) !== null) {
        var text;
        try {
            text = new Function('self', 'return ' + m[1])({ publishedVersion: VERSION });
        } catch (err) {
            throw new Error('could not render a printed recipe line (it references more than self.publishedVersion?): ' + m[1] + '\n' + err.message);
        }
        var branch = (skipAt > -1 && m.index > skipAt) ? 'skipped-merge'
            : (revertAt > -1 && m.index > revertAt) ? 'revert'
            : 'unknown';
        out.push({ branch: branch, text: text });
    }
    return out;
}

var LINES = renderCommandLines();
var MAIN_WRITERS = LINES.filter(function (l) { return /push origin main/.test(l.text); });


describe('00 - the pin sees the recipes (control)', function () {

    it('finds printed command lines in both recovery branches, rendered with the published version', function () {
        assert.ok(LINES.some(function (l) { return l.branch === 'revert'; }), 'no command line after the revert warning — the extraction is blind');
        assert.ok(LINES.some(function (l) { return l.branch === 'skipped-merge'; }), 'no command line after the skipped-merge warning — the extraction is blind');
        assert.equal(LINES.filter(function (l) { return l.branch === 'unknown'; }).length, 0, 'a command line precedes both warnings');
        var pinning = LINES.filter(function (l) { return /devDependencies\.gina/.test(l.text); });
        assert.ok(pinning.length >= 2, 'expected a devDependency catch-up in each branch, found ' + pinning.length);
        pinning.forEach(function (l) {
            assert.ok(l.text.indexOf('devDependencies.gina="^' + VERSION + '"') > -1, 'the published version did not render into: ' + l.text);
        });
    });
});


describe('01 - no line fast-forwards develop into main', function () {

    it('never runs `merge --ff-only develop` (docs main and develop are SHA-diverged)', function () {
        LINES.forEach(function (l) {
            assert.equal(/merge\s+--ff-only\s+develop/.test(l.text), false, l.branch + ': ' + l.text);
        });
    });
});


describe('02 - commits are path-scoped to the pair', function () {

    it('never stages with -a, and every commit names package.json and package-lock.json', function () {
        LINES.forEach(function (l) {
            assert.equal(/git commit\s+(-[a-zA-Z]*a[a-zA-Z]*\b|--all\b)/.test(l.text), false, 'a commit stages everything: ' + l.text);
            if (/git commit/.test(l.text)) {
                assert.ok(/git commit -m "[^"]*" -- package\.json package-lock\.json/.test(l.text), 'a commit is not path-scoped to the pair: ' + l.text);
            }
        });
    });
});


describe('03 - a develop commit reaches origin/develop', function () {

    it('pushes develop in the same line that commits on it', function () {
        LINES.forEach(function (l) {
            if (/git commit/.test(l.text)) {
                assert.ok(/git push origin develop/.test(l.text), 'commits on develop without pushing it: ' + l.text);
            }
        });
    });
});


describe('04 - main is only written from a temporary worktree', function () {

    it('never checks main out in the operator checkout', function () {
        LINES.forEach(function (l) {
            assert.equal(/git checkout main/.test(l.text), false, 'parks the operator checkout on main: ' + l.text);
        });
    });

    it('writes main from /tmp/docs-main and removes it on every exit path, keeping the exit status', function () {
        assert.ok(MAIN_WRITERS.length >= 2, 'expected a main-writing line in each branch, found ' + MAIN_WRITERS.length);
        MAIN_WRITERS.forEach(function (l) {
            assert.ok(/git worktree add \/tmp\/docs-main main/.test(l.text), 'writes main without a temporary worktree: ' + l.text);
            assert.ok(/; s=\$\?; git worktree remove --force \/tmp\/docs-main; \[ "\$s" = 0 \]$/.test(l.text), 'does not remove the worktree on every exit path, or loses the exit status: ' + l.text);
        });
    });
});


describe('05 - each branch lands main the way its state requires', function () {

    it('revert: cherry-picks the ONE catch-up commit — a merge would also ship whatever develop took since the cut', function () {
        var l = MAIN_WRITERS.filter(function (x) { return x.branch === 'revert'; });
        assert.equal(l.length, 1, 'expected one main-writing line in the revert branch');
        assert.ok(/C=\$\(git rev-parse HEAD\) && git worktree add [^;]*cherry-pick "\$C"/.test(l[0].text), 'does not cherry-pick the commit it just made: ' + l[0].text);
        assert.equal(/\bgit( -C \S+)? merge\b/.test(l[0].text), false, 'the revert branch merges into main: ' + l[0].text);
    });

    it('skipped merge: merges develop into main — the merge syncDocs skipped', function () {
        var l = MAIN_WRITERS.filter(function (x) { return x.branch === 'skipped-merge'; });
        assert.equal(l.length, 1, 'expected one main-writing line in the skipped-merge branch');
        assert.ok(/git -C \/tmp\/docs-main merge --no-edit develop/.test(l[0].text), 'does not merge develop into main: ' + l[0].text);
    });
});


describe('06 - every printed line parses as shell', function () {

    it('bash -n rejects a broken line (instrument control)', function () {
        var r = spawnSync('bash', ['-n', '-c', 'echo "unterminated'], { encoding: 'utf8' });
        assert.notEqual(r.status, 0, 'bash -n accepted a broken line — the parse check below cannot fail');
    });

    it('bash -n accepts each rendered line', function () {
        LINES.forEach(function (l) {
            var r = spawnSync('bash', ['-n', '-c', l.text], { encoding: 'utf8' });
            assert.equal(r.status, 0, 'bash -n rejects: ' + l.text + '\n' + r.stderr);
        });
    });
});
