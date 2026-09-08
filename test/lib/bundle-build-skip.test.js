/**
 * `--skip-unchanged` on bundle:build + project:build — the opt-in whole-release
 * copy skip. The primitives (content signature, marker, decision) live in
 * lib/release-watch; the two hand-mirrored build verbs carry wiring only.
 *
 * Shape:
 *   (01) both arguments.json memberships (an undeclared `--` token falls
 *        through to NODE_OPTIONS for the prepare hook)
 *   (02) help.txt: the new [ Building a bundle ] section + the project one
 *   (03-08) source pins on BOTH handlers — the flag read, `--dry-run` fencing
 *        the hooks and the manifest write, the decision preceding the wipe,
 *        the marker written inside the copy callback after the link, the
 *        guarded link on the skip path (never a blind symlinkSync), the
 *        non-fatal warn literal, the hook-signal keys, JSON via fs.writeSync
 *   (09) the twin deltas the design says to PRESERVE, not harmonise
 *   (10-11) decideBuildAction driven through every fail-safe branch, and
 *        diffBuildFiles — REAL bytes, not a replica
 *
 * No build verb is executed here (CmdHelper + globals); the live two-build
 * scaffold is the integration gate.
 *
 * Run: node --test test/lib/bundle-build-skip.test.js
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');
var rw = require(FW + '/lib/release-watch/src/main');

var B_BUILD  = fs.readFileSync(path.join(FW, 'lib/cmd/bundle/build.js'), 'utf8');
var P_BUILD  = fs.readFileSync(path.join(FW, 'lib/cmd/project/build.js'), 'utf8');
var B_ARGS   = JSON.parse(fs.readFileSync(path.join(FW, 'lib/cmd/bundle/arguments.json'), 'utf8'));
var P_ARGS   = JSON.parse(fs.readFileSync(path.join(FW, 'lib/cmd/project/arguments.json'), 'utf8'));
var B_HELP   = fs.readFileSync(path.join(FW, 'lib/cmd/bundle/help.txt'), 'utf8');
var P_HELP   = fs.readFileSync(path.join(FW, 'lib/cmd/project/help.txt'), 'utf8');

var BOTH = [ [ 'bundle/build.js', B_BUILD ], [ 'project/build.js', P_BUILD ] ];

/**
 * Counts non-overlapping occurrences of a literal.
 * @param {string} src
 * @param {string} needle
 * @returns {number}
 */
function count(src, needle) {
    return src.split(needle).length - 1;
}


// ---------------------------------------------------------------------------
// 01 — arguments.json memberships
// ---------------------------------------------------------------------------

describe('skip-unchanged §01 — arguments.json whitelists', function () {

    it('01.01 — bundle group declares --skip-unchanged (and still --dry-run / --format / --force)', function () {
        ['--skip-unchanged', '--dry-run', '--format', '--force', '--env', '--scope'].forEach(function (flag) {
            assert.ok(B_ARGS.indexOf(flag) > -1, 'bundle/arguments.json must whitelist ' + flag);
        });
    });

    it('01.02 — project group gains --skip-unchanged, --dry-run and --format (it had none of the three)', function () {
        ['--skip-unchanged', '--dry-run', '--format', '--force', '--env', '--scope'].forEach(function (flag) {
            assert.ok(P_ARGS.indexOf(flag) > -1, 'project/arguments.json must whitelist ' + flag);
        });
    });
});


// ---------------------------------------------------------------------------
// 02 — help.txt
// ---------------------------------------------------------------------------

describe('skip-unchanged §02 — help.txt', function () {

    it('02.01 — bundle/help.txt carries a [ Building a bundle ] section naming the flags and the hook signal', function () {
        var i = B_HELP.indexOf('[ Building a bundle ]');
        assert.ok(i > -1, 'the section must exist (it did not before this slice)');
        var section = B_HELP.substring(i, B_HELP.indexOf('\n[ ', i + 1));
        ['bundle:build', '--skip-unchanged', '--dry-run', '--format=json', '--force',
         'GINA_BUILD_SKIPPED_BUNDLES', 'GINA_BUILD_SKIPPED_ALL', '.gina-build.json'].forEach(function (needle) {
            assert.ok(section.indexOf(needle) > -1, 'section must mention ' + needle);
        });
    });

    it('02.02 — project/help.txt [ Build project ] names the same flags', function () {
        var i = P_HELP.indexOf('[ Build project ]');
        assert.ok(i > -1);
        var section = P_HELP.substring(i, P_HELP.indexOf('\n[ ', i + 1));
        ['--skip-unchanged', '--dry-run', '--format=json', 'GINA_BUILD_SKIPPED_BUNDLES'].forEach(function (needle) {
            assert.ok(section.indexOf(needle) > -1, 'section must mention ' + needle);
        });
    });
});


// ---------------------------------------------------------------------------
// 03 — flag read (both handlers)
// ---------------------------------------------------------------------------

describe('skip-unchanged §03 — flag read from self.params, in both handlers', function () {

    it('03.01 — the four flags are read once, into local, off self.params', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.match(src, /var p = self\.params \|\| \{\};/, name + ': params guard');
            assert.match(src, /local\.skipUnchanged\s*=\s*!!p\['skip-unchanged'\];/, name + ': --skip-unchanged');
            assert.match(src, /local\.force\s*=\s*!!p\['force'\];/, name + ': --force');
            assert.match(src, /local\.dryRun\s*=\s*!!p\['dry-run'\];/, name + ': --dry-run');
            assert.match(src, /local\.format\s*=\s*p\['format'\]\s*\|\|\s*null;/, name + ': --format');
        });
    });

    it('03.02 — --force does NOT switch the machinery off: the signature is gated on the flag alone, force reaches the decision', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.match(src, /if \( local\.skipUnchanged \) \{\s*\n\s*try \{\s*\n\s*local\.signatures\[bundle\] = lib\.releaseWatch\.buildSignature\(/, name + ': signature gated on the flag');
            assert.match(src, /force\s*:\s*local\.force,/, name + ': force is an input of the decision');
            assert.doesNotMatch(src, /skip-unchanged'\]\s*&&\s*!p\['force'\]/, name + ': force must not disable the mechanism');
        });
    });
});


// ---------------------------------------------------------------------------
// 04 — --dry-run fences the hooks and the manifest write
// ---------------------------------------------------------------------------

describe('skip-unchanged §04 — --dry-run writes nothing and runs no hook', function () {

    it('04.01 — the prepare hook condition starts with !local.dryRun', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.match(src, /if \(\s*\n\s*!local\.dryRun\s*\n\s*&& globalBuildScripts\s*\n\s*&& typeof\(globalBuildScripts\.prepare\) != 'undefined'/, name + ': prepare fenced');
        });
    });

    it('04.02 — the postbuild hook never runs under --dry-run', function () {
        // bundle:build: the terminal branch returns the report before the hook block
        assert.match(B_BUILD, /if \( b > self\.bundles\.length-1 \) \{[\s\S]*?if \( local\.dryRun \) \{\s*\n\s*return report\(\);\s*\n\s*\}[\s\S]*?globalBuildScripts\.postbuild/, 'bundle/build.js: dry-run returns before the postbuild block');
        // project:build: the hook lives in end(), whose condition starts with !local.dryRun
        assert.match(P_BUILD, /if \(\s*\n\s*!local\.dryRun\s*\n\s*&& globalBuildScripts\s*\n\s*&& typeof\(globalBuildScripts\.postbuild\) != 'undefined'/, 'project/build.js: postbuild fenced');
    });

    it('04.03 — the manifest write is guarded by !local.dryRun (the seeding + #RW1 stamp still run in memory)', function () {
        assert.match(B_BUILD, /if \( !local\.dryRun \) \{\s*\n\s*lib\.generator\.createFileFromDataSync\(/, 'bundle/build.js');
        assert.match(P_BUILD, /if \( !local\.dryRun \) \{\s*\n\s*lib\.generator\.createFileFromDataSync\(/, 'project/build.js');
        BOTH.forEach(function (pair) {
            assert.equal(count(pair[1], 'createFileFromDataSync('), 1, pair[0] + ': exactly one manifest write site');
        });
    });
});


// ---------------------------------------------------------------------------
// 05 — the decision precedes the wipe; the skip path never wipes or copies
// ---------------------------------------------------------------------------

describe('skip-unchanged §05 — decision before the wipe, inside buildEnv', function () {

    it('05.01 — decideRelease() is called once, before release.rmSync(), and the skip returns before the cleanup', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.equal(count(src, 'var decision = decideRelease(bundle, release, releasePath);'), 1, name + ': one decision site');
            assert.equal(count(src, 'release.rmSync()'), 1, name + ': one wipe site');
            var decideIdx = src.indexOf('var decision = decideRelease(bundle, release, releasePath);');
            var wipeIdx   = src.indexOf('release.rmSync()');
            assert.ok(decideIdx < wipeIdx, name + ': the decision must precede the wipe');
            var between = src.substring(decideIdx, wipeIdx);
            assert.match(between, /if \( decision\.action === 'skip' \) \{[\s\S]*?ensureNodeModulesLink\(releasePath\);\s*\n\s*return buildEnv\(scope, b, e\+1\);/, name + ': the skip path links (guarded) and advances');
            assert.match(between, /if \( local\.dryRun \) \{\s*\n\s*return buildEnv\(scope, b, e\+1\);/, name + ': dry-run advances without copying');
        });
    });

    it('05.02 — every decision is recorded, so the dry-run report and the real run resolve the SAME set from the SAME code', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.equal(count(src, 'local.decisions.push({'), 1, name + ': one record site');
            assert.ok(src.indexOf('local.decisions.push({') < src.indexOf('if ( local.dryRun ) {\n            return buildEnv(scope, b, e+1);'), name + ': recorded before the dry-run branch');
        });
    });
});


// ---------------------------------------------------------------------------
// 06 — marker written inside the copy callback, after the link
// ---------------------------------------------------------------------------

describe('skip-unchanged §06 — the marker is written in the copy callback, after the symlink, before the next env', function () {

    it('06.01 — order: onCopied → symlinkSync → writeBuildMarker → buildEnv(e+1)', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            var cbIdx     = src.indexOf('function onCopied(err, destination)');
            var nullIdx   = src.indexOf('internalNodeModulesPathObj = null;');
            var markerIdx = src.indexOf('lib.releaseWatch.writeBuildMarker(destination, local.signatures[bundle], { ginaVersion: GINA_VERSION });');
            var nextIdx   = src.lastIndexOf('buildEnv(scope, b, e+1);');
            assert.ok(cbIdx > -1 && nullIdx > -1 && markerIdx > -1 && nextIdx > -1, name + ': all four anchors present');
            assert.equal(count(src, 'writeBuildMarker('), 1, name + ': exactly one marker write');
            assert.ok(cbIdx < nullIdx && nullIdx < markerIdx && markerIdx < nextIdx, name + ': callback → link → marker → next env');
        });
    });

    it('06.02 — the marker write is gated on the flag AND a signature, and is non-fatal', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.match(src, /if \( local\.skipUnchanged && local\.signatures\[bundle\] \) \{\s*\n\s*try \{\s*\n\s*lib\.releaseWatch\.writeBuildMarker\(/, name + ': gated + try');
            assert.ok(src.indexOf('could not write the build marker') > -1, name + ': warn literal');
        });
    });
});


// ---------------------------------------------------------------------------
// 07 — the skip path's node_modules link is guarded; the evaluation is non-fatal
// ---------------------------------------------------------------------------

describe('skip-unchanged §07 — never a blind symlinkSync on a skip; evaluation errors rebuild', function () {

    it('07.01 — ensureNodeModulesLink lstat-guards before linking', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.match(src, /var ensureNodeModulesLink = function\(releasePath\) \{[\s\S]*?try \{\s*\n\s*fs\.lstatSync\(linkPath\);\s*\n\s*\} catch \(absentErr\) \{\s*\n\s*present = false;/, name + ': lstat guard');
            assert.match(src, /if \( !present \) \{[\s\S]*?internalNodeModulesPathObj\.symlinkSync\(linkPath\);/, name + ': link only when absent');
        });
    });

    it('07.02 — both the signature and the decision fall back to a rebuild with the shared warn literal', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.equal(count(src, 'could not evaluate --skip-unchanged for `'), 2, name + ': the literal at BOTH catch sites (signature + decision)');
            assert.ok(src.indexOf("return { action: 'rebuild', reason: 'evaluation failed' };") > -1, name + ': the decision catch rebuilds');
            assert.ok(src.indexOf("return { action: 'rebuild', reason: '--skip-unchanged not given' };") > -1, name + ': the flag-absent path rebuilds');
            assert.match(src, /var decideRelease = function\(bundle, release, releasePath\) \{[\s\S]*?marker\s*:\s*lib\.releaseWatch\.readBuildMarker\(releasePath\),[\s\S]*?releaseExists\s*:\s*release\.existsSync\(\),[\s\S]*?signature\s*:\s*local\.signatures\[bundle\]/, name + ': the decision inputs');
        });
    });
});


// ---------------------------------------------------------------------------
// 08 — hook signal + JSON envelope
// ---------------------------------------------------------------------------

describe('skip-unchanged §08 — postbuild hook signal and the JSON envelope', function () {

    it('08.01 — the postbuild env clone carries GINA_BUILD_SKIPPED_BUNDLES / _ALL when the flag is on', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.match(src, /if \( local\.skipUnchanged \) \{\s*\n\s*let skipSignal = skippedBundles\(\);\s*\n\s*currentEnv\['GINA_BUILD_SKIPPED_BUNDLES'\] = skipSignal\.bundles\.join\(','\);\s*\n\s*currentEnv\['GINA_BUILD_SKIPPED_ALL'\]\s*= skipSignal\.all \? '1' : '0';/, name + ': signal set on the clone');
            var hookIdx   = src.indexOf('globalBuildScripts.postbuild +');
            var signalIdx = src.indexOf("currentEnv['GINA_BUILD_SKIPPED_BUNDLES']");
            var execIdx   = src.indexOf('execSync( cmd , execOptions);');
            assert.ok(hookIdx < signalIdx && signalIdx < execIdx, name + ': signal set between building the command and executing it');
        });
    });

    it('08.02 — the envelope goes out through fs.writeSync(1, …), never process.stdout.write', function () {
        BOTH.forEach(function (pair) {
            var name = pair[0], src = pair[1];
            assert.ok(src.indexOf("fs.writeSync(1, JSON.stringify(envelope) + '\\n');") > -1, name + ': sync write');
            assert.equal(count(src, 'process.stdout.write'), 0, name + ': no async stdout write (64KB truncation before exit)');
            assert.match(src, /releases\s*:\s*local\.decisions/, name + ': the envelope carries the recorded decisions');
        });
    });
});


// ---------------------------------------------------------------------------
// 09 — twin deltas PRESERVED (regression guards; pass before and after by design)
// ---------------------------------------------------------------------------

describe('skip-unchanged §09 — the two verbs stay hand-mirrored twins, deltas intact', function () {

    it('09.01 — project:build still skips the dev env; bundle:build still builds it', function () {
        assert.match(P_BUILD, /if \( env === self\.projects\[self\.projectName\]\.dev_env \) \{\s*\n\s*continue;/, 'project/build.js skips dev');
        assert.match(B_BUILD, /\/\/ if \( env === self\.projects\[self\.projectName\]\.dev_env \) \{/, 'bundle/build.js keeps the skip commented out');
    });

    it('09.02 — bundle:build merges the bundle record; project:build replaces the manifest', function () {
        assert.ok(B_BUILD.indexOf('merge(self.projectData.bundles[bundle], local.manifest.bundles[bundle], true)') > -1);
        assert.ok(P_BUILD.indexOf('self.projectData = local.manifest;') > -1);
    });

    it('09.03 — the #RW1 stamp precedes the manifest write in both (the §07 release-watch pins, restated)', function () {
        BOTH.forEach(function (pair) {
            var src = pair[1];
            assert.ok(src.indexOf('lib.releaseWatch.fingerprintTree(') < src.indexOf('createFileFromDataSync'), pair[0]);
        });
    });
});


// ---------------------------------------------------------------------------
// 10 — decideBuildAction: every fail-safe branch, real bytes
// ---------------------------------------------------------------------------

describe('skip-unchanged §10 — decideBuildAction (lib/release-watch, real bytes)', function () {

    var SIG = { spec: 1, hash: 'a'.repeat(40), fileCount: 2, files: { 'a.js': '1|100|' + 'b'.repeat(40), 'b.js': '2|100|' + 'c'.repeat(40) } };
    var MARKER = { spec: 1, srcSignature: 'a'.repeat(40), fileCount: 2, builtAt: '2026-09-08T00:00:00.000Z', files: SIG.files };

    it('10.01 — the ONE skip: marker present + current spec + release present + equal signatures', function () {
        var d = rw.decideBuildAction({ force: false, marker: MARKER, releaseExists: true, signature: SIG });
        assert.equal(d.action, 'skip');
        assert.equal(d.reason, 'unchanged');
        assert.equal(d.builtAt, MARKER.builtAt);
        assert.equal(d.fileCount, 2);
    });

    it('10.02 — --force rebuilds even on a perfect match, and says so', function () {
        var d = rw.decideBuildAction({ force: true, marker: MARKER, releaseExists: true, signature: SIG });
        assert.equal(d.action, 'rebuild');
        assert.equal(d.reason, '--force');
    });

    it('10.03 — no marker', function () {
        var d = rw.decideBuildAction({ force: false, marker: null, releaseExists: true, signature: SIG });
        assert.equal(d.action, 'rebuild');
        assert.equal(d.reason, 'no marker');
    });

    it('10.04 — a foreign marker spec is named', function () {
        var d = rw.decideBuildAction({ force: false, marker: Object.assign({}, MARKER, { spec: 0 }), releaseExists: true, signature: SIG });
        assert.equal(d.action, 'rebuild');
        assert.equal(d.reason, 'marker spec 0 ≠ 1');
    });

    it('10.05 — release missing (a marker cannot vouch for a tree that is not there)', function () {
        var d = rw.decideBuildAction({ force: false, marker: MARKER, releaseExists: false, signature: SIG });
        assert.equal(d.action, 'rebuild');
        assert.equal(d.reason, 'release missing');
    });

    it('10.06 — a signature mismatch names the changed files (sorted) and counts them', function () {
        var sig2 = { spec: 1, hash: 'd'.repeat(40), fileCount: 3, files: { 'a.js': '1|100|' + 'b'.repeat(40), 'b.js': '2|999|' + 'e'.repeat(40), 'c.js': '3|100|' + 'f'.repeat(40) } };
        var d = rw.decideBuildAction({ force: false, marker: MARKER, releaseExists: true, signature: sig2 });
        assert.equal(d.action, 'rebuild');
        assert.equal(d.reason, '2 file(s) changed');
        assert.deepEqual(d.changed, ['b.js', 'c.js']);
        assert.equal(d.builtAt, MARKER.builtAt, 'the old marker time is carried for the report');
    });

    it('10.07 — hashes differ but the per-file records do not (a tampered srcSignature) → still a rebuild', function () {
        var d = rw.decideBuildAction({ force: false, marker: Object.assign({}, MARKER, { srcSignature: 'z'.repeat(40) }), releaseExists: true, signature: SIG });
        assert.equal(d.action, 'rebuild');
        assert.equal(d.reason, 'signature mismatch');
        assert.deepEqual(d.changed, []);
    });

    it('10.08 — no signature (the walk failed upstream) → rebuild, before any marker is consulted', function () {
        var d = rw.decideBuildAction({ force: false, marker: MARKER, releaseExists: true, signature: null });
        assert.equal(d.action, 'rebuild');
        assert.equal(d.reason, 'signature unavailable');
    });

    it('10.09 — garbage never throws and never skips', function () {
        [ {}, null, undefined, { marker: 'x', signature: 'y' }, { marker: { spec: 1, srcSignature: 1, files: 'nope' }, releaseExists: true, signature: SIG } ].forEach(function (input) {
            var d = rw.decideBuildAction(input);
            assert.equal(d.action, 'rebuild', JSON.stringify(input));
            assert.equal(typeof d.reason, 'string');
        });
    });
});


// ---------------------------------------------------------------------------
// 11 — diffBuildFiles
// ---------------------------------------------------------------------------

describe('skip-unchanged §11 — diffBuildFiles compares content identity, not mtime', function () {

    it('11.01 — added, removed, content-changed and symlink-retargeted are reported; an mtime-only move is not', function () {
        var prev = { 'a.js': '1|100|' + 'a'.repeat(40), 'b.js': '1|100|' + 'b'.repeat(40), 'gone.js': '1|100|' + 'g'.repeat(40), 'l': 'symlink|/x', 'same.js': '5|100|' + 's'.repeat(40) };
        var next = { 'a.js': '1|999|' + 'a'.repeat(40), 'b.js': '1|100|' + 'B'.repeat(40), 'new.js': '1|100|' + 'n'.repeat(40), 'l': 'symlink|/y', 'same.js': '5|100|' + 's'.repeat(40) };
        assert.deepEqual(rw.diffBuildFiles(prev, next), ['b.js', 'gone.js', 'l', 'new.js']);
    });

    it('11.02 — identical maps diff empty; null / non-object args are tolerated', function () {
        var m = { 'a.js': '1|1|' + 'a'.repeat(40) };
        assert.deepEqual(rw.diffBuildFiles(m, m), []);
        assert.deepEqual(rw.diffBuildFiles(null, m), ['a.js']);
        assert.deepEqual(rw.diffBuildFiles(m, null), ['a.js']);
        assert.deepEqual(rw.diffBuildFiles('x', 42), []);
    });
});
