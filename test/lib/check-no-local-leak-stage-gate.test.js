/**
 * script/check_no_local_leak.js — the stable-publish gate under STAGED
 * publishing (#R10 phase 2, S3 by-catch F1).
 *
 * The prepack hook's third gate fails a stable publish closed when the
 * maintainer-local sidecar `script/.private-tokens.json` is absent, so a
 * fresh clone, a restored machine or a CI runner cannot ship with the
 * content-level scan silently disabled. Until 2026-09-23 the gate keyed on
 * `npm_command === 'publish'` only — `npm stage publish` (the #R10 phase-1
 * flow, which runs the WHOLE lifecycle at stage time) sets
 * `npm_command=stage` (measured), so a staged stable publish sailed past it.
 *
 * Two layers:
 *   - source-structure pins (house style) locking the gate's shape;
 *   - a behavioural arm that runs the script from a COPY where no sidecar
 *     exists, with a stub `npm` on PATH so a passed gate ends
 *     deterministically at "[prepack] OK" instead of shelling out to the
 *     real `npm pack` (which would run against whatever cwd the suite has).
 *
 * Seam: GINA_LEAK_SCRIPT_SRC — path of the script source to exercise
 * (default: the repo's). Used to validate these pins RED-FIRST against
 * `git show HEAD:script/check_no_local_leak.js`.
 */

'use strict';

var fs = require('fs');
var os = require('os');
var nodePath = require('path');
var { spawnSync } = require('child_process');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var SCRIPT_DIR = nodePath.join(__dirname, '..', '..', 'script');
var SOURCE = process.env.GINA_LEAK_SCRIPT_SRC || nodePath.join(SCRIPT_DIR, 'check_no_local_leak.js');
var LOADER = nodePath.join(SCRIPT_DIR, '_load_private_tokens.js');
var SRC = fs.readFileSync(SOURCE, 'utf8');

var BLOCKED = 'STABLE PUBLISH BLOCKED';
var PASSED_GATE = '[prepack] OK: pack listing and contents are clean.';

/**
 * Runs a copy of the script from a temp tree with NO sidecar, a stub `npm`
 * first on PATH, and an empty cwd. Every npm_* variable is stripped from the
 * inherited env first — the suite itself runs under `npm test`, which exports
 * `npm_command=test` — then `env` is applied verbatim.
 *
 * @param {Object} env - the npm_* variables the arm sets
 * @param {boolean} [withSidecar] - write an empty sidecar next to the copy
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runGate(env, withSidecar) {
    var root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'leak-gate-'));
    var scriptDir = nodePath.join(root, 'script');
    var bin = nodePath.join(root, 'bin');
    var cwd = nodePath.join(root, 'work');
    fs.mkdirSync(scriptDir);
    fs.mkdirSync(bin);
    fs.mkdirSync(cwd);
    fs.copyFileSync(SOURCE, nodePath.join(scriptDir, 'check_no_local_leak.js'));
    fs.copyFileSync(LOADER, nodePath.join(scriptDir, '_load_private_tokens.js'));
    if (withSidecar) {
        fs.writeFileSync(nodePath.join(scriptDir, '.private-tokens.json'), '{"tokens":[]}\n');
    }
    // The stub answers `npm pack --dry-run --json --ignore-scripts` with one
    // listed file that does not exist in cwd, so the scan finds nothing and
    // the script exits 0 — a deterministic "the gate was passed" reading.
    fs.writeFileSync(
        nodePath.join(bin, 'npm'),
        '#!/bin/sh\nprintf \'%s\' \'[{"files":[{"path":"package.json"}]}]\'\n',
        { mode: 0o755 }
    );

    var baseEnv = {};
    Object.keys(process.env).forEach(function (k) {
        if (!/^npm_/i.test(k)) { baseEnv[k] = process.env[k]; }
    });
    baseEnv.PATH = bin + nodePath.delimiter + (process.env.PATH || '');
    Object.keys(env).forEach(function (k) { baseEnv[k] = env[k]; });

    var res = spawnSync(process.execPath, [nodePath.join(scriptDir, 'check_no_local_leak.js')], {
        cwd: cwd,
        env: baseEnv,
        encoding: 'utf8'
    });
    fs.rmSync(root, { recursive: true, force: true });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}


describe('01 - the stable-publish gate keys on npm_command publish OR stage (source pins)', function () {

    it('declares STABLE_PUBLISH_COMMANDS with both publish and stage', function () {
        assert.ok(
            SRC.indexOf('var STABLE_PUBLISH_COMMANDS = { publish: true, stage: true };') > -1,
            'expected `var STABLE_PUBLISH_COMMANDS = { publish: true, stage: true };` — the staged-publish mode must be a stable-publish command for the gate'
        );
    });

    it('tests the command through the map with a strict === true (never a bare truthy lookup)', function () {
        assert.ok(
            SRC.indexOf('STABLE_PUBLISH_COMMANDS[process.env.npm_command] === true') > -1,
            'expected `STABLE_PUBLISH_COMMANDS[process.env.npm_command] === true` in the gate condition'
        );
    });

    it('no longer keys on npm_command === publish alone (negative invariant)', function () {
        assert.ok(
            SRC.indexOf("process.env.npm_command === 'publish'") === -1,
            "the publish-only shape `process.env.npm_command === 'publish'` is back — `npm stage publish` (npm_command=stage) would sail past the gate again"
        );
    });

    it('anti-vacuity: the gate still exists (its BLOCKED message is present)', function () {
        assert.ok(
            SRC.indexOf(BLOCKED) > -1,
            'expected the `' + BLOCKED + '` message — the negative invariant above must not pass on a gutted gate'
        );
    });

    it('keeps the alpha carve-out (tag=latest or unset only)', function () {
        assert.ok(
            SRC.indexOf("(process.env.npm_config_tag === 'latest' || !process.env.npm_config_tag)") > -1,
            'expected the tag=latest/unset condition — alpha publishes must stay ungated'
        );
    });
});


describe('02 - behaviour: a sidecar-less copy blocks a stable stage publish and nothing else', function () {

    it('npm_command=stage, no tag → exit 1, STABLE PUBLISH BLOCKED', function () {
        var r = runGate({ npm_command: 'stage' });
        assert.equal(r.status, 1, 'expected exit 1, got ' + r.status + '\n' + r.stderr);
        assert.ok(r.stderr.indexOf(BLOCKED) > -1, 'expected `' + BLOCKED + '` on stderr, got:\n' + r.stderr);
    });

    it('npm_command=stage, tag=latest → exit 1, STABLE PUBLISH BLOCKED', function () {
        var r = runGate({ npm_command: 'stage', npm_config_tag: 'latest' });
        assert.equal(r.status, 1, 'expected exit 1, got ' + r.status + '\n' + r.stderr);
        assert.ok(r.stderr.indexOf(BLOCKED) > -1, 'expected `' + BLOCKED + '` on stderr, got:\n' + r.stderr);
    });

    it('npm_command=publish, no tag → exit 1, STABLE PUBLISH BLOCKED (the pre-existing behaviour, kept)', function () {
        var r = runGate({ npm_command: 'publish' });
        assert.equal(r.status, 1, 'expected exit 1, got ' + r.status + '\n' + r.stderr);
        assert.ok(r.stderr.indexOf(BLOCKED) > -1, 'expected `' + BLOCKED + '` on stderr, got:\n' + r.stderr);
    });

    it('npm_command=stage, tag=alpha → passes the gate (exit 0 through the stub pack)', function () {
        var r = runGate({ npm_command: 'stage', npm_config_tag: 'alpha' });
        assert.equal(r.stderr.indexOf(BLOCKED), -1, 'an alpha stage publish must not be blocked:\n' + r.stderr);
        assert.equal(r.status, 0, 'expected exit 0, got ' + r.status + '\n' + r.stderr);
        assert.ok(r.stdout.indexOf(PASSED_GATE) > -1, 'expected `' + PASSED_GATE + '` — the stub npm was not reached:\n' + r.stdout + r.stderr);
    });

    it('npm_command=pack → passes the gate (contributor flow untouched)', function () {
        var r = runGate({ npm_command: 'pack' });
        assert.equal(r.stderr.indexOf(BLOCKED), -1, 'npm pack must not be blocked:\n' + r.stderr);
        assert.equal(r.status, 0, 'expected exit 0, got ' + r.status + '\n' + r.stderr);
        assert.ok(r.stdout.indexOf(PASSED_GATE) > -1, 'expected `' + PASSED_GATE + '`:\n' + r.stdout + r.stderr);
    });

    it('npm_command=stage with the sidecar PRESENT → passes the gate', function () {
        var r = runGate({ npm_command: 'stage' }, true);
        assert.equal(r.stderr.indexOf(BLOCKED), -1, 'a stage publish with the sidecar present must not be blocked:\n' + r.stderr);
        assert.equal(r.status, 0, 'expected exit 0, got ' + r.status + '\n' + r.stderr);
        assert.ok(r.stdout.indexOf(PASSED_GATE) > -1, 'expected `' + PASSED_GATE + '`:\n' + r.stdout + r.stderr);
    });
});
