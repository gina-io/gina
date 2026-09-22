/**
 * script/post_publish.js publishAlpha — source-structure pin (#R10 staged publishing).
 *
 * publishAlpha runs a NESTED publish for the freshly bumped alpha after a stable
 * cut. It used to hard-code `npm publish --tag alpha`, which is wrong once the
 * release flow moves to staged publishing: a cut started with `npm stage publish`
 * would have staged the stable and then published the alpha outright, and a chain
 * whose PATH npm lacks the `stage` subcommand would die here — after the tag, the
 * master merge and the GitHub Release had already landed. publishAlpha is fail-fast
 * (its catch does `return done(err)`, which the chain turns into process.exit(1)),
 * so there is no recovery path at that point.
 *
 * The shipped shape resolves BOTH the verb and the npm binary from the environment
 * npm hands to a lifecycle script:
 *   - `npm_command` is `stage` under `npm stage publish` and `publish` under a plain
 *     `npm publish`, so the nested alpha always mirrors the cut the operator started.
 *   - `npm_execpath` points at the very npm running this script, so the nested call
 *     inherits the parent's npm and cannot fall back to a stage-incapable one.
 * Both were measured before this pin was written, together with the fact that
 * `--tag alpha` still reaches `npm_config_tag` under a staged publish (so
 * prepare_version.js's alpha temp-branch path is unaffected).
 *
 * Pin locks that shape. Without it a future refactor could quietly restore the
 * hard-coded form, which would only be discovered mid-cut on a real release.
 */

'use strict';

var nodePath = require('path');
var fs = require('fs');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var SOURCE = nodePath.join(__dirname, '..', '..', 'script', 'post_publish.js');
var SRC = fs.readFileSync(SOURCE, 'utf8');


describe('01 - publishAlpha mirrors the parent publish mode', function () {

    it('reads npm_command to decide the verb', function () {
        assert.ok(
            SRC.indexOf("process.env.npm_command") > -1,
            'expected publishAlpha to read process.env.npm_command — the nested alpha can no longer tell a staged cut from a plain one'
        );
    });

    it("resolves to 'stage publish' when the parent cut was staged", function () {
        assert.ok(
            /npm_command\s*===?\s*'stage'\s*\)?\s*\?\s*'stage publish'\s*:\s*'publish'/.test(SRC),
            "expected the `npm_command === 'stage' ? 'stage publish' : 'publish'` mode ternary in publishAlpha"
        );
    });
});


describe('02 - the nested call targets the parent own npm', function () {

    it('uses npm_execpath rather than trusting PATH', function () {
        assert.ok(
            SRC.indexOf('npm_execpath') > -1,
            'expected publishAlpha to use process.env.npm_execpath — without it the nested alpha resolves npm from PATH and may get a stage-incapable npm'
        );
    });

    it('invokes it through process.execPath', function () {
        assert.ok(
            SRC.indexOf('process.execPath') > -1,
            'expected process.execPath to run the resolved npm-cli.js in publishAlpha'
        );
    });
});


describe('03 - NEGATIVE INVARIANT: the hard-coded un-staged publish is gone', function () {

    it("no longer contains execSync('npm publish --tag alpha'", function () {
        assert.ok(
            SRC.indexOf("execSync('npm publish --tag alpha'") === -1,
            "publishAlpha still hard-codes execSync('npm publish --tag alpha') — a staged cut would publish its alpha outright, bypassing the approval gate"
        );
    });

    it('still contains the --tag alpha argument somewhere (guards a vacuous pass)', function () {
        assert.ok(
            SRC.indexOf('--tag alpha') > -1,
            'the --tag alpha argument vanished entirely — the negative invariant above would pass vacuously on a gutted function'
        );
    });
});


describe('04 - ordering: verb and binary are resolved before the call that uses them', function () {

    it('resolves the command string ahead of the execSync', function () {
        var verbIdx = SRC.indexOf('npm_command');
        var cmdIdx  = SRC.indexOf('execSync(publishCmd');
        assert.ok(verbIdx > -1, 'npm_command lookup not found');
        assert.ok(cmdIdx > -1, 'expected execSync(publishCmd, ...) — the built command string is not the one executed');
        assert.ok(
            verbIdx < cmdIdx,
            'the publish mode must be resolved BEFORE execSync uses it; found the execSync first'
        );
    });
});


describe('05 - falls back to bare npm when npm_execpath is unset', function () {

    it('keeps a PATH-resolved fallback branch', function () {
        assert.ok(
            /:\s*'npm '\s*\+\s*npmVerb\s*\+\s*' --tag alpha'/.test(SRC),
            "expected the `: 'npm ' + npmVerb + ' --tag alpha'` fallback — without it an unset npm_execpath would break a publish that works today"
        );
    });
});
