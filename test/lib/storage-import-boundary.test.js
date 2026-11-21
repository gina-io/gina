/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * #STO1 — the framework-independence guard for `lib/storage`.
 *
 * The whole go/no-go for the storage layer turns on one structural claim: the
 * contract is implementable WITHOUT reaching into gina core. This file is that
 * claim's proof, and it is deliberately a negative-invariant sweep rather than
 * a lint rule, because no lint infrastructure exists to hang one on.
 *
 * Three layers, because a guard with only the first is a guard that passes
 * forever without inspecting anything:
 *   1. the sweep itself (walk every source file, assert zero violations);
 *   2. a NOT-A-NO-OP control pinning that the walked tree is non-empty AND
 *      contains named known files, so a directory move fails loudly instead of
 *      hollowing the sweep out;
 *   3. known-positive / known-negative replicas of every forbidden pattern, so
 *      a regex that can no longer match anything is caught as a broken
 *      instrument rather than read as a clean result.
 *
 * The shape is lifted from `test/lib/e2e-no-version-pins.test.js`, which learnt
 * it the hard way (the bundle-freshness `:(glob)` lesson).
 *
 * ⚠️ SELF-TRIP: the replica section below necessarily CONTAINS the very import
 * strings it forbids. This file lives in `test/lib`, outside the swept tree, so
 * it cannot trip its own sweep — do not move it under the framework lib tree.
 */

var { describe, it } = require('node:test');
var assert   = require('node:assert');
var fs       = require('node:fs');
var nodePath = require('node:path');

var ROOT        = nodePath.join(__dirname, '..', '..');
var VERSION     = require(nodePath.join(ROOT, 'package.json')).version;
var commentStrip = require('../strip-comments');
var STORAGE_DIR = nodePath.join(ROOT, 'framework', 'v' + VERSION, 'lib', 'storage');

/**
 * Recursively collect every regular file under a directory.
 *
 * @inner
 * @param {string} dir - Absolute directory path to walk.
 * @returns {string[]} Absolute paths of every file found under `dir`.
 */
var collectFiles = function (dir) {
    var out = [];
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
        var full = nodePath.join(dir, entries[i].name);
        if (entries[i].isDirectory()) {
            out = out.concat(collectFiles(full));
        } else if (entries[i].isFile()) {
            out.push(full);
        }
    }
    return out;
};

/**
 * The forbidden imports and globals.
 *
 * `label` is what a failure prints; `re` is the matcher; `positive` is a real
 * offending line the pattern MUST match; `negative` is a legitimate line it
 * must NOT match. The last two are what make each entry an instrument rather
 * than a hopeful regex.
 *
 * @inner
 * @constant
 * @type {Array.<{label: string, re: RegExp, positive: string, negative: string}>}
 */
var FORBIDDEN = [
    {
        label    : 'a require() reaching into gina core',
        re       : /require\s*\(\s*['"][^'"]*\bcore\//,
        positive : "var server = require('../../../core/server');",
        negative : "var util = require('./util');"
    },
    {
        label    : 'a require() of the lib registry',
        re       : /require\s*\(\s*['"](?:[^'"]*\/)?lib\/index['"]|require\s*\(\s*['"]\.\.\/\.\.\/index['"]/,
        positive : "var lib = require('../../index');",
        negative : "var sqliteDriver = require('./../../sqlite-driver');"
    },
    {
        label    : 'a bare-module require resolved through NODE_PATH',
        re       : /require\s*\(\s*['"]lib\/[^'"]+['"]\s*\)/,
        positive : "var uuid = require('lib/uuid');",
        negative : "var nodePath = require('path');"
    },
    {
        label    : 'an injected framework global',
        re       : /\b(?:getContext|getConfig|setPath|getPath|requireJSON)\s*\(|\bGINA_FRAMEWORK_DIR\b/,
        positive : "var ctx = getContext();",
        negative : "var full = nodePath.resolve(base);"
    }
];

/**
 * The ONE sanctioned framework import, pinned so that adding a second has to be
 * a deliberate act rather than drift.
 *
 * `lib/sqlite-driver` is a dependency-free driver seam (node:sqlite first, a
 * bun:sqlite adapter under Bun) whose own header documents staying out of the
 * `lib` registry. The independence rule targets gina CORE, the registry and the
 * injected globals — not this.
 *
 * @inner
 * @constant
 * @type {RegExp}
 */
var SANCTIONED_IMPORT = /require\s*\(\s*['"]\.\/\.\.\/\.\.\/sqlite-driver['"]\s*\)/;

var files = collectFiles(STORAGE_DIR).filter(function (f) { return /\.js$/.test(f); });

describe('01 - instrument validation (every pattern can fire, and can stay silent)', function () {

    it('sweeps a non-empty lib/storage tree (the guard is not a silent no-op)', function () {
        // A guard that matches zero files passes forever without inspecting
        // anything. Pin the known surfaces so a future dir move or rename fails
        // loudly instead of hollowing out the sweep.
        assert.ok(files.length > 0, 'expected .js files under lib/storage — an empty sweep inspects nothing');
        var names = files.map(function (f) { return nodePath.basename(f); });
        ['main.js', 'util.js', 'local.js', 'meta-store.js'].forEach(function (n) {
            assert.ok(names.indexOf(n) > -1, 'expected ' + n + ' in the sweep, got: ' + names.join(', '));
        });
    });

    FORBIDDEN.forEach(function (rule) {
        it('pattern fires on a real violation: ' + rule.label, function () {
            assert.ok(rule.re.test(rule.positive),
                'the pattern for "' + rule.label + '" must match its own known-positive: ' + rule.positive);
        });
        it('pattern stays silent on a legitimate line: ' + rule.label, function () {
            assert.ok(!rule.re.test(rule.negative),
                'the pattern for "' + rule.label + '" must NOT match: ' + rule.negative);
        });
    });

    it('the sanctioned-import pattern fires on the real require', function () {
        assert.ok(SANCTIONED_IMPORT.test("var sqliteDriver = require('./../../sqlite-driver');"));
        assert.ok(!SANCTIONED_IMPORT.test("var util = require('./util');"));
    });
});

describe('02 - lib/storage imports no gina core, registry, or injected global', function () {

    it('no source file violates the boundary', function () {
        var violations = [];
        for (var i = 0; i < files.length; i++) {
            var src = fs.readFileSync(files[i], 'utf8');
            // Strip block and line comments: the module docs legitimately NAME
            // the forbidden constructs to explain why they are avoided, and a
            // pin that trips on its own documentation is the own-JSDoc trap.
            var code = commentStrip.lines(src);
            var lines = code.split('\n');
            for (var l = 0; l < lines.length; l++) {
                for (var r = 0; r < FORBIDDEN.length; r++) {
                    if ( FORBIDDEN[r].re.test(lines[l]) ) {
                        violations.push(
                            nodePath.relative(ROOT, files[i]) + ':' + (l + 1)
                            + ': ' + FORBIDDEN[r].label + ' -> ' + lines[l].trim()
                        );
                    }
                }
            }
        }
        assert.deepEqual(
            violations, [],
            'lib/storage must be implementable without gina core — that independence IS the '
            + 'contract this slice exists to prove, and the traversal guard / size parser / id '
            + 'generator are lib-local copies precisely to keep it true:\n' + violations.join('\n')
        );
    });

    it('exactly one file makes the sanctioned lib/sqlite-driver import', function () {
        // Pinned as an EXACT count, so a second framework import cannot be added
        // quietly under cover of "there was already an exception".
        var importers = files.filter(function (f) {
            return SANCTIONED_IMPORT.test(fs.readFileSync(f, 'utf8'));
        }).map(function (f) { return nodePath.basename(f); });

        assert.deepEqual(importers, ['meta-store.js'],
            'only lib/storage/src/meta-store.js may import the sqlite-driver seam');
    });
});

describe('03 - the module loads with no gina bootstrap at all', function () {

    it('require()s cleanly outside a bundle context', function () {
        // The behavioural half of the boundary claim: a module that imports no
        // core still fails here if it TOUCHES an injected global at load time.
        // No try/catch — a throw should surface as the failure it is.
        var storage = require(nodePath.join(STORAGE_DIR, 'src', 'main.js'));
        assert.equal(typeof storage.validateConfig, 'function');
        assert.equal(typeof storage.start, 'function');
        assert.equal(typeof storage.get, 'function');
        assert.equal(typeof storage.reset, 'function');
    });

    it('does no I/O at require time (the parity test loads the whole registry in-process)', function () {
        var storage = require(nodePath.join(STORAGE_DIR, 'src', 'main.js'));
        assert.equal(storage.isStarted(), false,
            'requiring lib/storage must not install drivers — test/lib/types-runtime-parity.test.js '
            + 'require()s the real registry, so require-time I/O here reds a test pointing nowhere near this module');
    });
});
