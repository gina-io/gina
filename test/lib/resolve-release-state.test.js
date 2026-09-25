/**
 * script/resolve_release_state.js — behavioural tests, plus the source pins
 * that keep script/prepare_version.js and script/post_publish.js runnable
 * without a local gina state store (#R10 phase 2).
 *
 * The module is driven through an injected fs driver, so no real ~/.gina and
 * no real framework/ tree are touched. The two release scripts cannot be
 * required — each one instantiates itself on load and runs the release chain,
 * commits included — so their wiring is pinned against the source text, with
 * comments stripped first so a comment that merely names a call can neither
 * satisfy nor trip a pin.
 *
 * Negative-invariant pattern: resolve() must never answer ok:true for a state
 * it cannot vouch for — no tracked framework dir, more than one, a tracked dir
 * missing from disk, or a store whose def_framework names a version that is
 * neither tracked nor the one being released.
 */

'use strict';

var fs       = require('fs');
var nodePath = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var ROOT_DIR = nodePath.join(__dirname, '..', '..');
var MOD      = require(nodePath.join(ROOT_DIR, 'script', 'resolve_release_state.js'));

var GINA_HOME   = '/fake/home/.gina';
var REPO        = '/fake/srv/gina';
var MAIN_JSON   = nodePath.join(GINA_HOME, 'main.json');
var SETTINGS_06 = nodePath.join(GINA_HOME, '0.6', 'settings.json');


/**
 * Fake fs driver for resolve(): `files` maps an absolute path to its contents,
 * `dirs` lists the absolute directory paths that exist. Records every
 * readFileSync call so a test can assert what was (not) read.
 *
 * @param {object}   files map of absolute path → contents (string).
 * @param {string[]} dirs  absolute directory paths that exist.
 */
function fakeFs(files, dirs) {
    files = files || {};
    dirs  = dirs  || [];
    var reads = [];
    return {
        reads: reads,
        existsSync: function (p) {
            return Object.prototype.hasOwnProperty.call(files, p) || dirs.indexOf(p) > -1;
        },
        readFileSync: function (p) {
            reads.push(p);
            if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
            var err = new Error('ENOENT: ' + p);
            err.code = 'ENOENT';
            throw err;
        }
    };
}

function fwDir(name) {
    return nodePath.join(REPO, 'framework', name);
}

/** A healthy maintainer store: def_framework on the tracked alpha dir. */
function storeFiles(defFramework, extra) {
    var files = {};
    files[MAIN_JSON]   = JSON.stringify({ def_framework: defFramework, frameworks: { '0.6': [defFramework] } });
    files[SETTINGS_06] = JSON.stringify({ version: defFramework, def_framework: defFramework, dir: REPO });
    for (var k in (extra || {})) files[k] = extra[k];
    return files;
}


// ---------------------------------------------------------------------------
// 01 — module shape
// ---------------------------------------------------------------------------

describe('01 - module shape', function () {

    it('exports resolve', function () {
        assert.equal(typeof MOD.resolve, 'function');
    });

    it('exports parseTrackedFrameworkDirs', function () {
        assert.equal(typeof MOD.parseTrackedFrameworkDirs, 'function');
    });

    it('exports renderFailure', function () {
        assert.equal(typeof MOD.renderFailure, 'function');
    });
});


// ---------------------------------------------------------------------------
// 02 — parseTrackedFrameworkDirs(): `git ls-files -- framework/` → dir names
// ---------------------------------------------------------------------------

describe('02 - parseTrackedFrameworkDirs()', function () {

    it('reduces ls-files output to the distinct framework dirs', function () {
        var out = 'framework/v0.6.33-alpha.2/AUTHORS\n'
            + 'framework/v0.6.33-alpha.2/core/gna.js\n'
            + 'framework/v0.6.33-alpha.2/lib/index.js\n';
        assert.deepEqual(MOD.parseTrackedFrameworkDirs(out), ['v0.6.33-alpha.2']);
    });

    it('keeps every distinct dir, in first-seen order', function () {
        var out = 'framework/v0.6.33/a.js\nframework/v0.6.32/b.js\nframework/v0.6.33/c.js\n';
        assert.deepEqual(MOD.parseTrackedFrameworkDirs(out), ['v0.6.33', 'v0.6.32']);
    });

    it('ignores paths that are not inside a framework/v<digit> directory', function () {
        var out = 'framework/README.md\nframework/vendor/x.js\nlib/framework/v1/y.js\nframework/v0.6.33\n';
        assert.deepEqual(MOD.parseTrackedFrameworkDirs(out), []);
    });

    it('tolerates CRLF line endings, blank lines and empty input', function () {
        assert.deepEqual(MOD.parseTrackedFrameworkDirs('\r\nframework/v1.0.0/a.js\r\n\r\n'), ['v1.0.0']);
        assert.deepEqual(MOD.parseTrackedFrameworkDirs(''), []);
        assert.deepEqual(MOD.parseTrackedFrameworkDirs(undefined), []);
    });
});


// ---------------------------------------------------------------------------
// 03 — store present: the maintainer path
// ---------------------------------------------------------------------------

describe('03 - resolve() with a state store', function () {

    it('takes the version from def_framework and reads the targeted M.N settings', function () {
        var fs = fakeFs(storeFiles('0.6.33-alpha.2'), [fwDir('v0.6.33-alpha.2')]);
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.6.33',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fs
        });
        assert.equal(r.ok, true);
        assert.equal(r.reason, 'store');
        assert.equal(r.hasStore, true);
        assert.equal(r.selectedVersion, '0.6.33-alpha.2');
        assert.equal(r.targetedVersion, '0.6.33');
        assert.equal(r.shortVersion, '0.6');
        assert.equal(r.mainConfigPath, MAIN_JSON);
        assert.equal(r.settingsConfigPath, SETTINGS_06);
        assert.equal(r.mainConfig.def_framework, '0.6.33-alpha.2');
        assert.equal(r.settingsConfig.version, '0.6.33-alpha.2');
    });

    it('strips a leading "v" from def_framework and from the package version', function () {
        var fs = fakeFs(storeFiles('v0.6.33-alpha.2'), [fwDir('v0.6.33-alpha.2')]);
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: 'v0.6.33-alpha.2',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fs
        });
        assert.equal(r.ok, true);
        assert.equal(r.selectedVersion, '0.6.33-alpha.2');
        assert.equal(r.targetedVersion, '0.6.33-alpha.2');
    });

    it('keys the settings file on the version being RELEASED, not the current one', function () {
        var extra = {};
        extra[nodePath.join(GINA_HOME, '0.7', 'settings.json')] = JSON.stringify({ version: '0.6.33-alpha.2' });
        var fs = fakeFs(storeFiles('0.6.33-alpha.2', extra), [fwDir('v0.6.33-alpha.2')]);
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.7.0',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fs
        });
        assert.equal(r.ok, true);
        assert.equal(r.shortVersion, '0.7');
        assert.equal(r.settingsConfigPath, nodePath.join(GINA_HOME, '0.7', 'settings.json'));
    });
});


// ---------------------------------------------------------------------------
// 04 — store present: every way the store can be unusable (fail closed, pre-rename)
// ---------------------------------------------------------------------------

describe('04 - resolve() with an unusable state store', function () {

    function run(files, pkgVersion) {
        return MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: pkgVersion || '0.6.33',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fakeFs(files, [fwDir('v0.6.33-alpha.2')])
        });
    }

    it('rejects a main.json that is not valid JSON', function () {
        var files = {};
        files[MAIN_JSON] = '{ not json';
        var r = run(files);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'malformed-main-json');
        assert.equal(r.hasStore, true);
    });

    it('rejects a main.json without a def_framework string', function () {
        var files = {};
        files[MAIN_JSON] = JSON.stringify({ frameworks: {} });
        assert.equal(run(files).reason, 'missing-def-framework');
        files[MAIN_JSON] = JSON.stringify({ def_framework: 42 });
        assert.equal(run(files).reason, 'missing-def-framework');
    });

    it('rejects a store that has no settings file for the released M.N', function () {
        var files = {};
        files[MAIN_JSON] = JSON.stringify({ def_framework: '0.6.33-alpha.2', frameworks: {} });
        var r = run(files);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'settings-json-absent');
        assert.equal(r.settingsConfigPath, SETTINGS_06);
    });

    it('rejects a settings file that is not valid JSON', function () {
        var files = storeFiles('0.6.33-alpha.2');
        files[SETTINGS_06] = '{ nope';
        assert.equal(run(files).reason, 'malformed-settings-json');
    });
});


// ---------------------------------------------------------------------------
// 05 — store present: def_framework must name a version the release can start from
// ---------------------------------------------------------------------------

describe('05 - resolve() cross-checks def_framework against the tracked dir', function () {

    it('fails closed when def_framework names an untracked side-by-side version', function () {
        // A side-by-side install is symlinked into framework/ — it EXISTS, so the
        // existence-only def_framework gate passes, and the cut would rename it.
        var fs = fakeFs(storeFiles('0.6.30'), [fwDir('v0.6.30'), fwDir('v0.6.33-alpha.2')]);
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.6.33',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fs
        });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'def-framework-not-tracked');
        assert.equal(r.selectedVersion, '0.6.30');
        assert.deepEqual(r.trackedDirs, ['v0.6.33-alpha.2']);
    });

    it('accepts def_framework == the released version (re-run after a partial cut)', function () {
        // The first run wrote the store and renamed the dir, then stopped before
        // its commit: git's index still names the old dir, the store is right.
        var fs = fakeFs(storeFiles('0.6.33'), [fwDir('v0.6.33')]);
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.6.33',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fs
        });
        assert.equal(r.ok, true);
        assert.equal(r.selectedVersion, '0.6.33');
        assert.equal(r.targetedVersion, '0.6.33');
    });

    it('skips the cross-check when no tracked dir is known (git unavailable)', function () {
        var fs = fakeFs(storeFiles('0.6.30'), [fwDir('v0.6.30')]);
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.6.33',
            trackedFrameworkDirs: [], fs: fs
        });
        assert.equal(r.ok, true);
        assert.equal(r.selectedVersion, '0.6.30');
    });
});


// ---------------------------------------------------------------------------
// 06 — no store: the fresh-machine / CI path
// ---------------------------------------------------------------------------

describe('06 - resolve() without a state store', function () {

    it('takes the version from the single tracked framework dir', function () {
        var fs = fakeFs({}, [fwDir('v0.6.33-alpha.2')]);
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.6.33',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fs
        });
        assert.equal(r.ok, true);
        assert.equal(r.reason, 'no-store');
        assert.equal(r.hasStore, false);
        assert.equal(r.selectedVersion, '0.6.33-alpha.2');
        assert.equal(r.targetedVersion, '0.6.33');
        assert.equal(r.shortVersion, '0.6');
        assert.equal(r.mainConfigPath, null);
        assert.equal(r.settingsConfigPath, null);
        assert.equal(r.mainConfig, null);
        assert.equal(r.settingsConfig, null);
    });

    it('reports the versions as in sync on an alpha run (no rename owed)', function () {
        var fs = fakeFs({}, [fwDir('v0.6.33-alpha.2')]);
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.6.33-alpha.2',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fs
        });
        assert.equal(r.ok, true);
        assert.equal(r.selectedVersion, r.targetedVersion);
    });

    it('reads no file at all when main.json is absent — not even a stray settings.json', function () {
        var files = {};
        files[SETTINGS_06] = JSON.stringify({ dir: '/somewhere/else' });
        var fs = fakeFs(files, [fwDir('v0.6.33-alpha.2')]);
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.6.33',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fs
        });
        assert.equal(r.ok, true);
        assert.equal(r.hasStore, false);
        assert.deepEqual(fs.reads, []);
    });
});


// ---------------------------------------------------------------------------
// 07 — no store: fail closed rather than guess
// ---------------------------------------------------------------------------

describe('07 - resolve() without a store fails closed on an ambiguous tree', function () {

    function run(tracked, dirs) {
        return MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.6.33',
            trackedFrameworkDirs: tracked, fs: fakeFs({}, dirs)
        });
    }

    it('rejects a tree where git tracks no framework dir', function () {
        var r = run([], []);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'no-tracked-framework-dir');
    });

    it('rejects a tree where git tracks two framework dirs (a head -1 would pick one silently)', function () {
        var r = run(['v0.6.33-alpha.2', 'v0.6.32'], [fwDir('v0.6.33-alpha.2'), fwDir('v0.6.32')]);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'multiple-tracked-framework-dirs');
        assert.equal(r.selectedVersion, null);
    });

    it('rejects a tracked dir that is not on disk (renamed by a run that never committed)', function () {
        var r = run(['v0.6.33-alpha.2'], [fwDir('v0.6.33')]);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'tracked-framework-dir-missing');
        assert.equal(r.selectedVersion, null);
    });
});


// ---------------------------------------------------------------------------
// 08 — the release root is always the checkout, never the store's recorded dir
// ---------------------------------------------------------------------------

describe('08 - resolve() release root', function () {

    it('ignores the store settings `dir` even when it names another tree', function () {
        var files = storeFiles('0.6.33-alpha.2');
        files[SETTINGS_06] = JSON.stringify({ version: '0.6.33-alpha.2', def_framework: '0.6.33-alpha.2', dir: '/stale/install/path' });
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO, packageVersion: '0.6.33',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fakeFs(files, [fwDir('v0.6.33-alpha.2')])
        });
        assert.equal(r.ok, true);
        assert.equal(r.ginaPath, REPO);
    });

    it('normalises a repoRoot given as <root>/script/.. (the script-relative form)', function () {
        var r = MOD.resolve({
            ginaHomeDir: GINA_HOME, repoRoot: REPO + '/script/..', packageVersion: '0.6.33',
            trackedFrameworkDirs: ['v0.6.33-alpha.2'], fs: fakeFs({}, [fwDir('v0.6.33-alpha.2')])
        });
        assert.equal(r.ok, true);
        assert.equal(r.ginaPath, REPO);
    });
});


// ---------------------------------------------------------------------------
// 09 — input validation
// ---------------------------------------------------------------------------

describe('09 - resolve() input validation', function () {

    it('reports missing-input when a required option is absent', function () {
        var fs = fakeFs({}, []);
        assert.equal(MOD.resolve({ repoRoot: REPO, packageVersion: '0.6.33', fs: fs }).reason, 'missing-input');
        assert.equal(MOD.resolve({ ginaHomeDir: GINA_HOME, packageVersion: '0.6.33', fs: fs }).reason, 'missing-input');
        assert.equal(MOD.resolve({ ginaHomeDir: GINA_HOME, repoRoot: REPO, fs: fs }).reason, 'missing-input');
        assert.equal(MOD.resolve().ok, false);
    });
});


// ---------------------------------------------------------------------------
// 10 — renderFailure(): an actionable line for every failure reason
// ---------------------------------------------------------------------------

describe('10 - renderFailure()', function () {

    var REASONS = [
        'missing-input', 'malformed-main-json', 'missing-def-framework', 'def-framework-not-tracked',
        'settings-json-absent', 'malformed-settings-json', 'no-tracked-framework-dir',
        'multiple-tracked-framework-dirs', 'tracked-framework-dir-missing'
    ];

    function capture(result) {
        var lines = [];
        MOD.renderFailure(result, { error: function (m) { lines.push(String(m)); } });
        return lines.join('\n');
    }

    it('prints a specific explanation for every reason resolve() can return', function () {
        for (var i = 0; i < REASONS.length; i++) {
            var out = capture({ ok: false, reason: REASONS[i], trackedDirs: [] });
            assert.ok(out.indexOf(REASONS[i]) > -1, 'reason missing from output for ' + REASONS[i]);
            assert.equal(/unknown reason/i.test(out), false, 'no specific explanation for ' + REASONS[i]);
        }
    });

    it('names both versions and the tracked dir for def-framework-not-tracked', function () {
        var out = capture({
            ok: false, reason: 'def-framework-not-tracked', selectedVersion: '0.6.30',
            targetedVersion: '0.6.33', trackedDirs: ['v0.6.33-alpha.2'], mainConfigPath: MAIN_JSON
        });
        assert.ok(out.indexOf('0.6.30') > -1);
        assert.ok(out.indexOf('0.6.33') > -1);
        assert.ok(out.indexOf('v0.6.33-alpha.2') > -1);
    });
});


// ---------------------------------------------------------------------------
// Source-pin helpers (the two release scripts cannot be required)
// ---------------------------------------------------------------------------

/**
 * Drops comment LINES — a line whose first non-blank characters are `//`, `*`
 * or `/*` (JSDoc and license blocks included). Deliberately line-level, not a
 * token-level regex strip: both scripts carry `pack.replace(/\//g, '\\')`, a
 * regex literal a `\/\/[^\n]*` strip reads as a line comment, cutting code
 * mid-expression (measured: the first version of this helper did exactly that
 * and the compile controls in §11/§12 caught it). End-of-line comments stay,
 * which can only make a negative pin fail spuriously, never pass vacuously.
 */
function stripComments(s) {
    return s.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/**
 * Returns the `{ … }` block opened by `opener` (which must end with `{`),
 * matched by brace depth with string literals skipped. Throws unless the
 * opener occurs exactly once, so a pin cannot silently read the wrong block.
 */
function blockOf(src, opener) {
    var at = src.indexOf(opener);
    if (at < 0) throw new Error('opener not found: ' + opener);
    if (src.indexOf(opener, at + 1) > -1) throw new Error('opener not unique: ' + opener);
    var i = at + opener.length - 1;
    if (src.charAt(i) !== '{') throw new Error('opener must end with "{": ' + opener);
    var depth = 0, quote = null;
    for (; i < src.length; i++) {
        var c = src.charAt(i);
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(at, i + 1);
        }
    }
    throw new Error('unbalanced block after: ' + opener);
}

function countOf(src, needle) {
    return src.split(needle).length - 1;
}

var PV_RAW = fs.readFileSync(nodePath.join(ROOT_DIR, 'script', 'prepare_version.js'), 'utf8');
var PP_RAW = fs.readFileSync(nodePath.join(ROOT_DIR, 'script', 'post_publish.js'), 'utf8');
var PV = stripComments(PV_RAW);
var PP = stripComments(PP_RAW);


// ---------------------------------------------------------------------------
// 11 — prepare_version.js: getSelectedVersion runs without a state store
// ---------------------------------------------------------------------------

describe('11 - prepare_version.js wiring', function () {

    it('control: the comment-stripped source still compiles (the strip ate no code)', function () {
        assert.doesNotThrow(function () { new Function(PV.replace(/^#!.*\n/, '')); });
    });

    it('control: a comment names settingsConfig.dir and the strip removes it, so the negative pins below cannot pass vacuously', function () {
        assert.ok(PV_RAW.indexOf('settingsConfig.dir') > -1, 'the explanatory comment naming the retired read is gone');
        assert.equal(PV.indexOf('settingsConfig.dir'), -1);
    });

    it('delegates the decision to resolve_release_state', function () {
        assert.ok(PV.indexOf("require('./resolve_release_state')") > -1);
        assert.ok(PV.indexOf('resolveReleaseState.resolve(') > -1);
        assert.ok(PV.indexOf('resolveReleaseState.parseTrackedFrameworkDirs(') > -1);
        assert.ok(PV.indexOf('resolveReleaseState.renderFailure(') > -1);
    });

    it('no longer requires the store files (a missing one threw MODULE_NOT_FOUND)', function () {
        assert.equal(PV.indexOf('require(mainConfigPath)'), -1);
        assert.equal(PV.indexOf('require(settingsConfigPath)'), -1);
    });

    it('no longer takes the release root from the store (settingsConfig.dir)', function () {
        assert.equal(PV.indexOf('settingsConfig.dir'), -1);
    });

    it('no longer reads the never-assigned self.release', function () {
        assert.equal(PV.indexOf('self.release'), -1);
    });

    it('ends a failed resolution through done(), not a throw (the step is async under promisify)', function () {
        var body = blockOf(PV, 'if (!resolved.ok) {');
        assert.ok(body.indexOf('resolveReleaseState.renderFailure(resolved)') > -1);
        assert.ok(/return\s+done\(\s*new Error\(/.test(body));
    });

    it('writes the store and copies the archive ONLY inside the hasStore branch', function () {
        var guarded = blockOf(PV, 'if (resolved.hasStore) {');
        var needles = [
            'createFileFromDataSync(JSON.stringify(mainConfig, null, 2)',
            'createFileFromDataSync(JSON.stringify(settingsConfig, null, 2)',
            "'/archives/framework/v'",
            'frameworkPathObj.cp(destination)'
        ];
        for (var i = 0; i < needles.length; i++) {
            assert.equal(countOf(PV, needles[i]), 1, needles[i] + ' must appear exactly once in the file');
            assert.ok(guarded.indexOf(needles[i]) > -1, needles[i] + ' must sit inside the hasStore branch');
        }
    });
});


// ---------------------------------------------------------------------------
// 12 — post_publish.js: bumpVersion survives a missing store; self.git exists
// ---------------------------------------------------------------------------

describe('12 - post_publish.js wiring', function () {

    it('control: the comment-stripped source still compiles (the strip ate no code)', function () {
        assert.doesNotThrow(function () { new Function(PP.replace(/^#!.*\n/, '')); });
    });

    it('declares self.git before configure() writes self.git.tag (a direct --tag run threw a TypeError)', function () {
        var selfLiteral = blockOf(PP, 'var self    = {');
        assert.ok(/\bgit\s*:\s*\{/.test(selfLiteral), 'self literal has no git member');
        assert.ok(PP.indexOf('self.git.tag') > PP.indexOf('var self    = {'));
    });

    it('checks main.json exists before requireJSON reads it (requireJSON exits on a missing file)', function () {
        var guarded = blockOf(PP, 'if ( fs.existsSync(mainConfigPath) ) {');
        assert.ok(guarded.indexOf('requireJSON(mainConfigPath)') > -1);
        assert.equal(countOf(PP, 'requireJSON(mainConfigPath)'), 1);
    });

    it('checks the settings file exists before requireJSON reads it', function () {
        var guarded = blockOf(PP, 'if ( fs.existsSync(settingsConfigPath) ) {');
        assert.ok(guarded.indexOf('requireJSON(settingsConfigPath)') > -1);
        assert.equal(countOf(PP, 'requireJSON(settingsConfigPath)'), 1);
    });
});
