/**
 * test/fw.js — the guard against a tree whose node_modules/gina is another directory.
 *
 * Suite files that `require('gina')` resolve it through
 * `<tree>/node_modules/gina`. When that path leads to another directory (a
 * `node_modules` linked whole to another clone's, a `gina` entry linked to
 * another clone, an installed copy), those tests run that code beside this
 * tree's, and the run describes neither tree. test/fw.js, which most suite
 * files load, refuses such a tree when it is loaded. A tree without
 * `node_modules/gina`, or with a dangling one, loads as before: the tests that
 * need the module fail on their own, as CONTRIBUTING.md describes.
 *
 * Every arm builds throwaway trees under os.tmpdir(), each holding a
 * package.json and a copy of this repository's test/fw.js, and requires that
 * copy. Nothing is linked outside the temporary directory, and this file does
 * not load test/fw.js itself, so it also runs in a tree the guard refuses.
 *
 *   01  a self-symlink (CI's shape, and a clone's): loads
 *   02  per-package links to another tree's packages plus its own self-symlink: loads
 *   03  a tree placed at .../node_modules/gina with its own self-symlink: loads
 *   04  no node_modules, or a node_modules without gina: loads
 *   05  a dangling node_modules/gina: loads
 *   06  a node_modules linked whole to another tree's: refused, naming both trees
 *   07  a node_modules/gina linked to another tree: refused
 *   08  an installed copy (a real node_modules/gina directory): refused
 *   09  a self-symlink written in another letter case: loads (case-insensitive volumes only)
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

/** @constant {string} FW_SRC - This repository's test/fw.js, copied into each tree. */
var FW_SRC  = path.join(__dirname, '..', 'fw.js');
/** @constant {string} VERSION - The package.json version of every throwaway tree. */
var VERSION = '0.0.0-fw-guard';

/**
 * Whether the temporary volume ignores letter case (APFS and HFS+ by default,
 * not ext4): a directory created with an upper-case letter is found under its
 * lower-case spelling.
 * @constant {boolean} CASE_INSENSITIVE
 */
var CASE_INSENSITIVE = (function () {
    var probe = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-fw-guard-Case-'));
    try {
        return fs.existsSync(path.join(path.dirname(probe), path.basename(probe).toLowerCase()));
    } finally {
        fs.rmdirSync(probe);
    }
})();

/** @type {?string} The temporary directory holding every tree. */
var TMP = null;

/**
 * Creates a throwaway tree: package.json, test/fw.js (a copy of this
 * repository's) and the framework directory the copy exports.
 * @inner
 * @param {string} dir - The tree's root (created).
 * @returns {string} The root.
 */
function makeTree(dir) {
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'framework', 'v' + VERSION), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'gina', version: VERSION }) + '\n');
    fs.copyFileSync(FW_SRC, path.join(dir, 'test', 'fw.js'));
    return dir;
}

/**
 * Creates a tree whose real node_modules directory holds one package and the
 * tree's own self-symlink.
 * @inner
 * @param {string} dir - The tree's root (created).
 * @returns {string} The root.
 */
function makeSelfLinkedTree(dir) {
    makeTree(dir);
    fs.mkdirSync(path.join(dir, 'node_modules', 'some-dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'some-dep', 'index.js'), 'module.exports = 1;\n');
    fs.symlinkSync(dir, path.join(dir, 'node_modules', 'gina'));
    return dir;
}

/**
 * Requires a tree's copy of test/fw.js.
 * @inner
 * @param {string} dir - The tree's root.
 * @returns {string} The framework directory the copy exports.
 */
function load(dir) {
    return require(path.join(dir, 'test', 'fw.js'));
}

/**
 * Asserts that a tree's copy of test/fw.js loads and exports that tree's
 * framework directory.
 * @inner
 * @param {string} dir - The tree's root.
 * @returns {void}
 */
function assertLoads(dir) {
    var fw = load(dir);
    assert.equal(path.basename(fw), 'v' + VERSION);
    assert.equal(fs.realpathSync(path.dirname(path.dirname(fw))), fs.realpathSync(dir));
}

/**
 * Asserts that a tree's copy of test/fw.js refuses to load, and that the
 * error names both the tree and the directory its node_modules/gina leads to.
 * @inner
 * @param {string} dir - The tree's root.
 * @param {string} other - The directory node_modules/gina leads to.
 * @returns {void}
 */
function assertRefused(dir, other) {
    assert.throws(function () { load(dir); }, function (err) {
        assert.match(err.message, /^test\/fw\.js: /);
        assert.ok(err.message.indexOf(fs.realpathSync(other)) > -1, 'names the other directory: ' + err.message);
        assert.ok(err.message.indexOf(fs.realpathSync(dir) + ')') > -1, 'names the tree under test: ' + err.message);
        return true;
    });
}

describe('test/fw.js refuses a tree whose node_modules/gina is another directory', function () {
    var other;

    before(function () {
        TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-fw-guard-'));
        other = makeSelfLinkedTree(path.join(TMP, 'other'));
    });

    after(function () {
        if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
    });

    it('01 - a self-symlink loads', function () {
        assertLoads(makeSelfLinkedTree(path.join(TMP, 'self')));
    });

    it('02 - per-package links to another tree, with its own self-symlink, load', function () {
        var dir = makeTree(path.join(TMP, 'per-package'));
        fs.mkdirSync(path.join(dir, 'node_modules'));
        fs.symlinkSync(path.join(other, 'node_modules', 'some-dep'), path.join(dir, 'node_modules', 'some-dep'));
        fs.symlinkSync(dir, path.join(dir, 'node_modules', 'gina'));
        assertLoads(dir);
    });

    it('03 - a tree placed at .../node_modules/gina, with its own self-symlink, loads', function () {
        assertLoads(makeSelfLinkedTree(path.join(TMP, 'copy', 'node_modules', 'gina')));
    });

    it('04 - no node_modules, or a node_modules without gina, loads', function () {
        assertLoads(makeTree(path.join(TMP, 'bare')));
        var dir = makeTree(path.join(TMP, 'no-gina'));
        fs.mkdirSync(path.join(dir, 'node_modules'));
        assertLoads(dir);
    });

    it('05 - a dangling node_modules/gina loads', function () {
        var dir = makeTree(path.join(TMP, 'dangling'));
        fs.mkdirSync(path.join(dir, 'node_modules'));
        fs.symlinkSync(path.join(TMP, 'gone'), path.join(dir, 'node_modules', 'gina'));
        assertLoads(dir);
    });

    it('06 - a node_modules linked whole to another tree\'s is refused', function () {
        var dir = makeTree(path.join(TMP, 'whole-dir'));
        fs.symlinkSync(path.join(other, 'node_modules'), path.join(dir, 'node_modules'));
        assertRefused(dir, other);
    });

    it('07 - a node_modules/gina linked to another tree is refused', function () {
        var dir = makeTree(path.join(TMP, 'gina-elsewhere'));
        fs.mkdirSync(path.join(dir, 'node_modules'));
        fs.symlinkSync(other, path.join(dir, 'node_modules', 'gina'));
        assertRefused(dir, other);
    });

    it('08 - an installed copy (a real node_modules/gina directory) is refused', function () {
        var dir = makeTree(path.join(TMP, 'installed'));
        var copy = path.join(dir, 'node_modules', 'gina');
        fs.mkdirSync(copy, { recursive: true });
        fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: 'gina', version: VERSION }) + '\n');
        assertRefused(dir, copy);
    });

    it('09 - a self-symlink written in another letter case loads', { skip: CASE_INSENSITIVE ? false : 'the temporary volume is case-sensitive' }, function () {
        var dir = makeTree(path.join(TMP, 'CaseTree'));
        fs.mkdirSync(path.join(dir, 'node_modules'));
        fs.symlinkSync(path.join(TMP, 'casetree'), path.join(dir, 'node_modules', 'gina'));
        assertLoads(dir);
    });
});
