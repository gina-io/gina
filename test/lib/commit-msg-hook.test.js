/**
 * .githooks/commit-msg — pattern-parity pin + behavioural gate (#S10).
 *
 * The pre-commit hook scans staged CONTENT (#S7) and has since 0.3.6, but
 * nothing ever received a commit MESSAGE. Measured 2026-09-18: 13 messages on
 * the public branches name local configuration paths, every one of them
 * authored while the content scan was already in place. commit-msg closes
 * that surface, and also covers a message typed straight into a terminal,
 * which no editor-side tooling can reach.
 *
 * Two axes are pinned here.
 *
 * 1. PARITY. commit-msg carries its own copy of S7_LEAK_RE and
 *    S7_EXCEPTION_RE. The copies were extracted from pre-commit rather than
 *    retyped, and these pins assert they stay byte-identical — so the pair
 *    cannot drift apart silently. The pin reads both files at run time and
 *    compares them to each other; it deliberately embeds NO pattern literal,
 *    so it can never go stale against a legitimate future edit of both.
 *
 * 2. BEHAVIOUR. The shared pattern alone catches only 10 of the 13 known
 *    leaks — it matches a configuration path with a trailing slash, but not a
 *    bare filename mention nor the directory named without one. The shared
 *    pattern is NOT widened to close that: `.claude` as a bare token is also
 *    the AI connector's provider key, and test/lib/connector-config.test.js
 *    legitimately carries `shared.claude.model` in fixtures, so widening the
 *    CONTENT scan would reject product functionality the rule allows. A
 *    message is prose rather than code, so commit-msg adds MSG_EXTRA_RE of
 *    its own. §04 is the arm that justifies that shape: it asserts the
 *    connector key is still allowed while the prose forms are caught.
 *
 * This file joins S7_EXCLUDED_FILES for the same reason its siblings do — a
 * scanner's test must be able to write the shapes it pins.
 */

'use strict';

var nodePath = require('path');
var fs = require('fs');
var os = require('os');
var { execFileSync } = require('child_process');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var ROOT = nodePath.join(__dirname, '..', '..');
var HOOK = nodePath.join(ROOT, '.githooks', 'commit-msg');
var PRE = nodePath.join(ROOT, '.githooks', 'pre-commit');
var CI = nodePath.join(ROOT, '.github', 'workflows', 'security.yml');
var HOOK_SRC = fs.readFileSync(HOOK, 'utf8');
var PRE_SRC = fs.readFileSync(PRE, 'utf8');
var CI_SRC = fs.readFileSync(CI, 'utf8');

/** Return the single line declaring `name=` in `src`, or null. */
function declLine(src, name) {
    var found = src.split('\n').filter(function (l) {
        return l.indexOf(name + '=') === 0;
    });
    return found.length === 1 ? found[0] : null;
}

/** Return the single line declaring `name=` in `src`, ignoring indentation. */
function declLineAnywhere(src, name) {
    var found = src.split('\n').filter(function (l) {
        return l.trim().indexOf(name + '=') === 0;
    });
    return found.length === 1 ? found[0].trim() : null;
}

/** Run the hook against a message body; return its exit code. */
function runHook(body) {
    var f = nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cmsg-')), 'MSG');
    fs.writeFileSync(f, body, 'utf8');
    try {
        execFileSync('bash', [HOOK, f], { stdio: 'pipe' });
        return 0;
    } catch (e) {
        return typeof e.status === 'number' ? e.status : -1;
    }
}

// The forbidden literals are assembled at run time so this file does not carry
// an attribution footer verbatim — the same reason the hook's own banner spells
// the guidance out rather than quoting one.
var COAUTHOR = 'Co-Authored' + '-By: ' + 'Cla' + 'ude';


describe('01 - commit-msg exists and is executable', function () {

    it('is present with a bash shebang', function () {
        assert.ok(HOOK_SRC.indexOf('#!/usr/bin/env bash') === 0, 'commit-msg must start with a bash shebang');
    });

    it('is executable', function () {
        assert.ok((fs.statSync(HOOK).mode & 0o111) !== 0, 'commit-msg must be executable or git will not run it');
    });
});


describe('02 - pattern parity with pre-commit (#S7)', function () {

    it('declares S7_LEAK_RE exactly once in each hook', function () {
        assert.ok(declLine(PRE_SRC, 'S7_LEAK_RE'), 'pre-commit must declare S7_LEAK_RE exactly once');
        assert.ok(declLine(HOOK_SRC, 'S7_LEAK_RE'), 'commit-msg must declare S7_LEAK_RE exactly once');
    });

    it('S7_LEAK_RE is byte-identical in both hooks', function () {
        assert.equal(
            declLine(HOOK_SRC, 'S7_LEAK_RE'),
            declLine(PRE_SRC, 'S7_LEAK_RE'),
            'the two S7_LEAK_RE declarations have drifted — change both, or neither'
        );
    });

    it('S7_EXCEPTION_RE is byte-identical in both hooks', function () {
        assert.equal(
            declLine(HOOK_SRC, 'S7_EXCEPTION_RE'),
            declLine(PRE_SRC, 'S7_EXCEPTION_RE'),
            'the two S7_EXCEPTION_RE declarations have drifted — change both, or neither'
        );
    });

    it('commit-msg is excluded from the pre-commit content scan', function () {
        var decl = declLine(PRE_SRC, 'S7_EXCLUDED_FILES');
        assert.ok(decl, 'pre-commit must declare S7_EXCLUDED_FILES exactly once');
        assert.ok(
            decl.indexOf('\\.githooks/commit-msg') > -1,
            'commit-msg carries the patterns by design and must be in S7_EXCLUDED_FILES'
        );
        assert.ok(
            decl.indexOf('test/lib/commit-msg-hook\\.test\\.js') > -1,
            'this test carries the shapes it pins and must be in S7_EXCLUDED_FILES'
        );
    });

    // The exclusion list is MIRRORED in the CI workflow. Adding a file to the
    // hook alone leaves CI red on the very commit that adds it — measured
    // 2026-09-18, when exactly that happened on f871d0e6d. Pin both copies.
    it('the CI mirror excludes the same two files', function () {
        var ci = declLineAnywhere(CI_SRC, 'EXCLUDED');
        assert.ok(ci, 'security.yml must declare EXCLUDED exactly once');
        assert.ok(
            ci.indexOf('\\.githooks/commit-msg') > -1,
            'security.yml mirrors the content scan and must exclude commit-msg too'
        );
        assert.ok(
            ci.indexOf('test/lib/commit-msg-hook\\.test\\.js') > -1,
            'security.yml must exclude this test too'
        );
    });

    it('the CI mirror carries the same leak and exception patterns', function () {
        assert.equal(
            declLineAnywhere(CI_SRC, 'LEAK_RE'),
            (declLine(PRE_SRC, 'S7_LEAK_RE') || '').replace(/^S7_/, ''),
            'security.yml LEAK_RE has drifted from the hook S7_LEAK_RE'
        );
        assert.equal(
            declLineAnywhere(CI_SRC, 'EXCEPTION_RE'),
            (declLine(PRE_SRC, 'S7_EXCEPTION_RE') || '').replace(/^S7_/, ''),
            'security.yml EXCEPTION_RE has drifted from the hook S7_EXCEPTION_RE'
        );
    });
});


describe('03 - blocks the message forms that actually leaked', function () {

    it('blocks a configuration directory with a trailing slash', function () {
        assert.equal(runHook('Updating the roadmap\n\nThe internal .claude/roadmap.md copy carries the same row.\n'), 1);
    });

    it('blocks a bare filename mention (the 70ca041dd form)', function () {
        assert.equal(runHook('Closing out the verification\n\nVerification outcome (b) per user-CLAUDE.md rule.\n'), 1);
    });

    it('blocks the directory named without a trailing slash (the 6bfac5402 form)', function () {
        assert.equal(runHook('Staging the release docs\n\nno .claude cross-reference for the leak scan to reject\n'), 1);
    });

    it('blocks an attribution trailer', function () {
        assert.equal(runHook('Fixing a thing\n\n' + COAUTHOR + '\n'), 1);
    });

    it('blocks a leak on the subject line', function () {
        assert.equal(runHook('Documenting the trap in .claude/git.md\n'), 1);
    });
});


describe('04 - allows what must stay allowed (the discriminating arm)', function () {

    it('allows a clean message', function () {
        assert.equal(runHook('Adding the interactive tutorial to the roadmap\n'), 0);
    });

    it('allows the AI connector provider key — product functionality, not a path', function () {
        assert.equal(runHook('Fixing shared.claude.model merge in the connector config\n'), 0);
    });

    it('allows the documented vendor exceptions', function () {
        assert.equal(runHook('Adding anthropic:// to the provider table\n'), 0);
        assert.equal(runHook('Reading ANTHROPIC_API_KEY from the environment\n'), 0);
        assert.equal(runHook('Bumping @anthropic-ai/sdk to the current major\n'), 0);
    });

    it('ignores git comment lines, which are not the author text', function () {
        assert.equal(runHook('Refreshing the bundle\n\n# Please enter the commit message.\n# On branch develop\n#\tmodified:   .claude/todo/index.md\n'), 0);
    });

    it('ignores everything below the scissors marker', function () {
        assert.equal(runHook('Refreshing the bundle\n\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n+see .claude/todo/index.md\n'), 0);
    });
});


describe('05 - fails open rather than blocking a commit it cannot judge', function () {

    it('allows when no message path is given', function () {
        var rc = 0;
        try { execFileSync('bash', [HOOK], { stdio: 'pipe' }); } catch (e) { rc = e.status; }
        assert.equal(rc, 0, 'a missing argument must not block a commit');
    });

    it('allows when the message file does not exist', function () {
        var rc = 0;
        try {
            execFileSync('bash', [HOOK, nodePath.join(os.tmpdir(), 'cmsg-does-not-exist-' + Date.now())], { stdio: 'pipe' });
        } catch (e) { rc = e.status; }
        assert.equal(rc, 0, 'an unreadable message file must not block a commit');
    });

    it('allows an empty message', function () {
        assert.equal(runHook(''), 0);
    });
});
