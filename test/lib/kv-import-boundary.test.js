/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * #KV1 — the framework-independence guard for `lib/kv`.
 *
 * Same structural claim as the `lib/storage` boundary test this mirrors: the
 * KV facade is implementable WITHOUT reaching into gina core — everything it
 * needs (the validated `kv` block, connector-backed stores, a warn sink) is
 * injected by `gna.js` at boot. Three layers, because a guard with only the
 * sweep is a guard that passes forever without inspecting anything:
 *   1. the sweep itself (walk every source file, assert zero violations);
 *   2. a NOT-A-NO-OP control pinning that the walked tree is non-empty AND
 *      contains named known files;
 *   3. known-positive / known-negative replicas of every forbidden pattern.
 *
 * Unlike `lib/storage` (whose meta-store makes ONE sanctioned sqlite-driver
 * import), `lib/kv` sanctions NO framework import at all: connector backends
 * live under the connectors tree and reach the facade only through the
 * `lib/kv-store` dispatcher, which `gna.js` invokes — never this module.
 *
 * ⚠️ SELF-TRIP: the replica section below necessarily CONTAINS the very import
 * strings it forbids. This file lives in `test/lib`, outside the swept tree, so
 * it cannot trip its own sweep — do not move it under the framework lib tree.
 */

var { describe, it } = require('node:test');
var assert   = require('node:assert');
var fs       = require('node:fs');
var nodePath = require('node:path');

var ROOT    = nodePath.join(__dirname, '..', '..');
var VERSION = require(nodePath.join(ROOT, 'package.json')).version;
var commentStrip = require('../strip-comments');
var KV_DIR  = nodePath.join(ROOT, 'framework', 'v' + VERSION, 'lib', 'kv');

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
 * The forbidden imports and globals — the same roster the storage boundary
 * test carries, because the rule is the same rule.
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
        negative : "var helper = require('./main');"
    },
    {
        label    : 'a require() of the lib registry',
        re       : /require\s*\(\s*['"](?:[^'"]*\/)?lib\/index['"]|require\s*\(\s*['"]\.\.\/\.\.\/index['"]/,
        positive : "var lib = require('../../index');",
        negative : "var driver = require('./../../sqlite-driver');"
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

var files = collectFiles(KV_DIR).filter(function (f) { return /\.js$/.test(f); });

describe('01 - instrument validation (every pattern can fire, and can stay silent)', function () {

    it('sweeps a non-empty lib/kv tree (the guard is not a silent no-op)', function () {
        assert.ok(files.length > 0, 'expected .js files under lib/kv — an empty sweep inspects nothing');
        var names = files.map(function (f) { return nodePath.basename(f); });
        ['main.js'].forEach(function (n) {
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
});

describe('02 - lib/kv imports no gina core, registry, or injected global', function () {

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
            'lib/kv must be implementable without gina core — everything it needs is '
            + 'injected by gna.js at boot, and the boundary IS what keeps the facade '
            + 'testable and portable:\n' + violations.join('\n')
        );
    });

    it('no file makes ANY framework import — kv sanctions no exception', function () {
        // storage sanctions exactly one (its meta-store's sqlite-driver seam);
        // kv sanctions none, pinned so a first exception has to be a
        // deliberate act rather than drift.
        var frameworkImport = /require\s*\(\s*['"](?:\.\.\/)+(?!\.\.)[^'"]*['"]\s*\)/;
        var importers = files.filter(function (f) {
            var src  = fs.readFileSync(f, 'utf8');
            var code = commentStrip.lines(src);
            return frameworkImport.test(code);
        }).map(function (f) { return nodePath.basename(f); });
        assert.deepEqual(importers, [],
            'no lib/kv source file may require() outside its own tree');
    });
});

describe('03 - the module loads with no gina bootstrap at all', function () {

    it('require()s cleanly outside a bundle context', function () {
        // The behavioural half of the boundary claim: a module that imports no
        // core still fails here if it TOUCHES an injected global at load time.
        // No try/catch — a throw should surface as the failure it is.
        var kv = require(nodePath.join(KV_DIR, 'src', 'main.js'));
        assert.equal(typeof kv.validateConfig, 'function');
        assert.equal(typeof kv.start, 'function');
        assert.equal(typeof kv.get, 'function');
        assert.equal(typeof kv.reset, 'function');
    });

    it('does no work at require time (lazy by contract — resolving the lib must not build anything)', function () {
        var kv = require(nodePath.join(KV_DIR, 'src', 'main.js'));
        assert.equal(kv.isStarted(), false,
            'requiring lib/kv must not install namespaces — test/lib/types-runtime-parity.test.js '
            + 'require()s the real registry, so require-time work here reds a test pointing nowhere near this module');
    });
});
