#!/usr/bin/env node

/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @file script/resolve_release_state.js
 *
 * Decides, for one release run, which framework version the working tree
 * carries, where the release happens, and whether a local gina state store
 * exists to keep in step. Wired into `script/prepare_version.js →
 * getSelectedVersion`, the step that renames `framework/v<current>` to the
 * version being released.
 *
 * The state store (`~/.gina/main.json` + `~/.gina/<M.N>/settings.json`) is
 * OPTIONAL, so a release can run on a machine that never installed gina —
 * a CI runner. The two version sources are never mixed:
 *
 *  - store present: the version is the store's `def_framework`. A re-run
 *    after a cut that renamed the framework dir but stopped before its
 *    commit is only correct this way — the store already records the
 *    released version, while the git index still names the old dir.
 *    `def_framework` must name either the git-tracked dir or the released
 *    version: anything else is a side-by-side install (they are symlinked
 *    into `framework/`), which the cut would otherwise rename by mistake.
 *  - store absent: the version is the single `framework/v*` directory git
 *    tracks — exactly what the release commit will carry. Zero, several, or
 *    a tracked dir missing from disk fail closed rather than guess.
 *
 * The release ROOT is always the checkout the script runs from, never the
 * install dir the store records: honouring that record let a stale value
 * split one release across two trees (rename + commit in one, build +
 * `npm pack` in the other) or fail outright with MODULE_NOT_FOUND.
 *
 * Pure function modulo `fs.existsSync` / `fs.readFileSync` — pass `fs` to
 * swap the driver in tests. It never writes: the caller updates the store.
 */

'use strict';

var fs       = require('fs');
var nodePath = require('path');


/**
 * @typedef {object} ReleaseState
 * @property {boolean}  ok                 True when the release can proceed.
 * @property {string}   reason             `store` / `no-store` on success, otherwise the failure reason.
 * @property {boolean}  hasStore           Whether `<ginaHomeDir>/main.json` exists.
 * @property {?string}  selectedVersion    The framework version the tree carries now (no leading `v`).
 * @property {?string}  targetedVersion    The version being released (no leading `v`).
 * @property {?string}  shortVersion       `M.N` of `targetedVersion` — the store key the caller writes.
 * @property {?string}  ginaPath           The release root: always the normalised `repoRoot`.
 * @property {?string}  mainConfigPath     Store only: `<ginaHomeDir>/main.json`.
 * @property {?string}  settingsConfigPath Store only: `<ginaHomeDir>/<shortVersion>/settings.json`.
 * @property {?object}  mainConfig         Store only: parsed main.json — the caller mutates and writes it back.
 * @property {?object}  settingsConfig     Store only: parsed settings.json — the caller mutates and writes it back.
 * @property {string[]} trackedDirs        The git-tracked framework dirs the decision was made against.
 */


/**
 * Strips one leading `v` from a version label (`v0.6.33` → `0.6.33`).
 *
 * @inner
 * @param   {string} version
 * @returns {string}
 */
function stripV(version) {
    return String(version).replace(/^v/, '');
}

/**
 * Returns the `M.N` store key of a version (`0.6.33-alpha.2` → `0.6`).
 *
 * @inner
 * @param   {string} version Version without a leading `v`.
 * @returns {string}
 */
function shortVersionOf(version) {
    return version.split('.').slice(0, 2).join('.');
}

/**
 * Marks a state as failed and returns it.
 *
 * @inner
 * @param   {ReleaseState} state
 * @param   {string}       reason
 * @returns {ReleaseState}
 */
function fail(state, reason) {
    state.ok     = false;
    state.reason = reason;
    return state;
}

/**
 * Reduces `git ls-files -- framework/` output to the distinct framework
 * version directories it names, in first-seen order. Only paths INSIDE a
 * `framework/v<digit>…/` directory count.
 *
 * @param   {string}   lsFilesOutput Raw stdout: one repo-relative path per line.
 * @returns {string[]} Directory basenames, e.g. `['v0.6.33-alpha.2']`.
 *
 * @example
 * parseTrackedFrameworkDirs('framework/v0.6.33/AUTHORS\nframework/v0.6.33/core/gna.js\n');
 * // → ['v0.6.33']
 */
function parseTrackedFrameworkDirs(lsFilesOutput) {
    var seen  = {};
    var dirs  = [];
    var lines = String(lsFilesOutput || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var m = /^framework\/(v\d[^/]*)\//.exec(lines[i].trim());
        if (m && !Object.prototype.hasOwnProperty.call(seen, m[1])) {
            seen[m[1]] = true;
            dirs.push(m[1]);
        }
    }
    return dirs;
}

/**
 * Resolves the release state for one run. Never throws on bad state and never
 * writes: every unusable input comes back as `{ ok: false, reason }`, before
 * the caller has renamed or written anything.
 *
 * @param   {object}   opts
 * @param   {string}   opts.ginaHomeDir            Absolute path to the gina home (`~/.gina`), no trailing slash.
 * @param   {string}   opts.repoRoot               The checkout the release runs from (normalised with `path.resolve`).
 * @param   {string}   opts.packageVersion         `version` from that checkout's package.json — the version being released.
 * @param   {string[]} [opts.trackedFrameworkDirs] Output of {@link parseTrackedFrameworkDirs}; defaults to `[]`.
 * @param   {object}   [opts.fs]                   Injected fs driver (test-only); defaults to node's `fs`.
 * @returns {ReleaseState}
 *
 * @example <caption>Maintainer machine, stable cut</caption>
 * resolve({ ginaHomeDir: '/home/x/.gina', repoRoot: '/srv/gina', packageVersion: '0.6.33',
 *           trackedFrameworkDirs: ['v0.6.33-alpha.2'] });
 * // → { ok: true, reason: 'store', hasStore: true, selectedVersion: '0.6.33-alpha.2',
 * //     targetedVersion: '0.6.33', shortVersion: '0.6', ginaPath: '/srv/gina', ... }
 *
 * @example <caption>Fresh CI runner (no ~/.gina)</caption>
 * resolve({ ginaHomeDir: '/home/runner/.gina', repoRoot: '/home/runner/work/gina/gina',
 *           packageVersion: '0.6.33', trackedFrameworkDirs: ['v0.6.33-alpha.2'] });
 * // → { ok: true, reason: 'no-store', hasStore: false, selectedVersion: '0.6.33-alpha.2', ... }
 */
function resolve(opts) {
    opts = opts || {};
    var driver = opts.fs || fs;

    var state = {
        ok                 : false,
        reason             : null,
        hasStore           : false,
        selectedVersion    : null,
        targetedVersion    : null,
        shortVersion       : null,
        ginaPath           : null,
        mainConfigPath     : null,
        settingsConfigPath : null,
        mainConfig         : null,
        settingsConfig     : null,
        trackedDirs        : Array.isArray(opts.trackedFrameworkDirs) ? opts.trackedFrameworkDirs.slice() : []
    };

    if (!opts.ginaHomeDir || !opts.repoRoot || !opts.packageVersion) {
        return fail(state, 'missing-input');
    }

    state.ginaPath        = nodePath.resolve(opts.repoRoot);
    state.targetedVersion = stripV(opts.packageVersion);
    state.shortVersion    = shortVersionOf(state.targetedVersion);

    var mainConfigPath = nodePath.join(opts.ginaHomeDir, 'main.json');

    if (driver.existsSync(mainConfigPath)) {
        state.hasStore       = true;
        state.mainConfigPath = mainConfigPath;
        try {
            state.mainConfig = JSON.parse(driver.readFileSync(mainConfigPath, 'utf8'));
        } catch (err) {
            return fail(state, 'malformed-main-json');
        }

        var defFramework = state.mainConfig && state.mainConfig.def_framework;
        if (!defFramework || typeof defFramework !== 'string') {
            return fail(state, 'missing-def-framework');
        }
        state.selectedVersion = stripV(defFramework);

        if (
            state.trackedDirs.length > 0
            && state.trackedDirs.indexOf('v' + state.selectedVersion) < 0
            && state.selectedVersion !== state.targetedVersion
        ) {
            return fail(state, 'def-framework-not-tracked');
        }

        state.settingsConfigPath = nodePath.join(opts.ginaHomeDir, state.shortVersion, 'settings.json');
        if (!driver.existsSync(state.settingsConfigPath)) {
            return fail(state, 'settings-json-absent');
        }
        try {
            state.settingsConfig = JSON.parse(driver.readFileSync(state.settingsConfigPath, 'utf8'));
        } catch (err) {
            return fail(state, 'malformed-settings-json');
        }

        state.ok     = true;
        state.reason = 'store';
        return state;
    }

    if (state.trackedDirs.length === 0) {
        return fail(state, 'no-tracked-framework-dir');
    }
    if (state.trackedDirs.length > 1) {
        return fail(state, 'multiple-tracked-framework-dirs');
    }
    if (!driver.existsSync(nodePath.join(state.ginaPath, 'framework', state.trackedDirs[0]))) {
        return fail(state, 'tracked-framework-dir-missing');
    }

    state.selectedVersion = stripV(state.trackedDirs[0]);
    state.ok              = true;
    state.reason          = 'no-store';
    return state;
}

/**
 * Prints the actionable diagnostic for a failed {@link resolve} result: one
 * line naming the reason, one line saying what is wrong and how to fix it.
 *
 * @param   {ReleaseState} result
 * @param   {object}       [logger] Anything with an `error(message)` method; defaults to `console`.
 * @returns {void}
 *
 * @example
 * var state = resolve({ ginaHomeDir: '/home/runner/.gina', repoRoot: '/srv/gina',
 *                       packageVersion: '0.6.33', trackedFrameworkDirs: [] });
 * if (!state.ok) renderFailure(state);
 * // [release-state] ERROR: cannot resolve the release state — no-tracked-framework-dir
 * //   git tracks no framework/v* directory under /srv/gina — run the release from a git checkout of gina.
 */
function renderFailure(result, logger) {
    var r   = result || {};
    var log = logger || console;
    var tracked = (r.trackedDirs && r.trackedDirs.length) ? r.trackedDirs.join(', ') : '<none>';
    var details = {
        'missing-input':
            'internal: resolve() needs ginaHomeDir, repoRoot and packageVersion.',
        'malformed-main-json':
            (r.mainConfigPath || 'main.json') + ' exists but is not valid JSON.',
        'missing-def-framework':
            (r.mainConfigPath || 'main.json') + ' has no def_framework string.',
        'def-framework-not-tracked':
            'def_framework "' + r.selectedVersion + '" in ' + (r.mainConfigPath || 'main.json')
            + ' is neither the framework dir git tracks (' + tracked + ') nor the version being released ('
            + r.targetedVersion + '), so the cut would rename the wrong directory. Point def_framework'
            + ' (main.json and settings.json) at the tracked version, then retry.',
        'settings-json-absent':
            (r.settingsConfigPath || 'settings.json') + ' is missing: the store has no settings for the'
            + ' released version\'s M.N. Create it before the cut, or retry without a store.',
        'malformed-settings-json':
            (r.settingsConfigPath || 'settings.json') + ' exists but is not valid JSON.',
        'no-tracked-framework-dir':
            'git tracks no framework/v* directory under ' + r.ginaPath
            + ' — run the release from a git checkout of gina.',
        'multiple-tracked-framework-dirs':
            'git tracks more than one framework directory (' + tracked + ') — a release needs exactly one.',
        'tracked-framework-dir-missing':
            'git tracks framework/' + tracked + ' but it is not on disk under ' + r.ginaPath
            + ' — a previous run may have renamed it without committing. Reconcile the working tree'
            + ' with git before retrying.'
    };
    log.error('[release-state] ERROR: cannot resolve the release state — ' + r.reason);
    log.error('  ' + (details[r.reason] || 'unknown reason'));
}


module.exports = {
    resolve                   : resolve,
    parseTrackedFrameworkDirs : parseTrackedFrameworkDirs,
    renderFailure             : renderFailure
};
