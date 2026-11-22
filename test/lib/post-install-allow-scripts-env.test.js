/**
 * script/post_install.js — #B106: the nested framework-dir install must not
 * inherit the `allow-scripts` lifecycle export.
 *
 * npm exports every explicitly-set config value to lifecycle children as
 * `npm_config_*` env vars. `allow-scripts` (the npm 12 install-script
 * allowance, also present on late npm 11.x) is REJECTED in project-scoped
 * installs — `EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped
 * installs` — and `npmInstall()` runs exactly such an install (chdir into the
 * framework dir + `npm install`). So a user following the documented remedy
 * (`--allow-scripts=gina`, or `npm config set allow-scripts=gina
 * --location=user`) had the whole global install die inside post_install.
 * Measured in a node container on npm 12.0.1 and 11.18.0; the manifest-field
 * alternative (`allowScripts` in package.json) was measured NOT to help — the
 * inherited env var is rejected regardless, so dropping the env var for the
 * child is the only working shape.
 *
 * The fix mirrors the pre-existing `npm_config_global` guard at the same call
 * site: save → delete → execSync → restore-if-defined. The restore's typeof
 * guard is load-bearing: assigning `undefined` to a `process.env` key coerces
 * it to the string "undefined" — a bare restore would re-poison the env with a
 * truthy junk value when the var was never set.
 *
 * Tests are two-layered (post-install-bun-pm.test.js precedent):
 *   (a) source-inspection — save/delete/restore all present, ordered
 *       save → delete → execSync(cmd) → restore, delete co-located with the
 *       npm_config_global override, and no re-assignment between the delete
 *       and the child spawn. Pins use the full code forms
 *       (`delete process.env.npm_config_allow_scripts;` etc.) so prose
 *       mentions in comments cannot anchor them; comments are stripped anyway.
 *   (b) behaviour — a pure-logic replica of the guard proves the child never
 *       sees the var, the value is restored when it existed, the key is NOT
 *       created when it did not, and a subtract (the pre-fix shape) leaks the
 *       var to the child. A real-process.env probe demonstrates the
 *       string-coercion quirk the typeof guard exists for.
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var commentStrip = require('../strip-comments');

// post_install.js lives at the repo root under script/ (NOT in the framework
// dir), so resolve it directly rather than via test/fw.js.
var POST_INSTALL = path.resolve(__dirname, '..', '..', 'script', 'post_install.js');


// ---------------------------------------------------------------------------
// 01 — source: the nested install is guarded against the allow-scripts export
// ---------------------------------------------------------------------------
describe('01 - post_install nested install sanitizes the allow-scripts export (#B106)', function() {

    var code;
    before(function() {
        // Strip block comments (JSDoc) then line comments so prose mentions of
        // the config name cannot anchor any pin — only real code remains.
        code = commentStrip.all(fs.readFileSync(POST_INSTALL, 'utf8'));
    });

    it('saves the inherited value before the child runs', function() {
        assert.match(code, /var oldAllowScripts\s*=\s*process\.env\.npm_config_allow_scripts;/,
            'the inherited allow-scripts export must be saved before the nested install');
    });

    it('deletes the export for the child', function() {
        assert.match(code, /delete process\.env\.npm_config_allow_scripts;/,
            'the allow-scripts export must be deleted before the nested install');
    });

    it('restores the export only when it was defined', function() {
        assert.match(code, /if\s*\(\s*typeof\(oldAllowScripts\) != 'undefined'\s*\)/,
            'the restore must be gated on the saved value being defined');
        assert.match(code, /process\.env\.npm_config_allow_scripts\s*=\s*oldAllowScripts;/,
            'the restore must write the saved value back');
    });

    it('orders save → delete → execSync(cmd) → restore', function() {
        var saveIdx    = code.indexOf('var oldAllowScripts');
        var deleteIdx  = code.indexOf('delete process.env.npm_config_allow_scripts');
        var execIdx    = code.indexOf('execSync(cmd)', deleteIdx);
        var restoreIdx = code.indexOf('process.env.npm_config_allow_scripts = oldAllowScripts');

        assert.ok(saveIdx >= 0 && deleteIdx >= 0 && execIdx >= 0 && restoreIdx >= 0,
            'all four anchors must exist');
        assert.ok(saveIdx < deleteIdx, 'save must precede the delete');
        assert.ok(deleteIdx < execIdx, 'delete must precede the nested install child');
        assert.ok(execIdx < restoreIdx, 'restore must follow the nested install child');
    });

    it('the guard is co-located with the npm_config_global override', function() {
        var globalFalseIdx = code.indexOf('process.env.npm_config_global = false');
        var deleteIdx      = code.indexOf('delete process.env.npm_config_allow_scripts');
        assert.ok(globalFalseIdx >= 0 && deleteIdx >= 0, 'both guards must exist');
        assert.ok(deleteIdx > globalFalseIdx,
            'the allow-scripts delete belongs to the same guard cluster, after the global override');
    });

    it('nothing re-sets the export between the delete and the child', function() {
        var deleteIdx = code.indexOf('delete process.env.npm_config_allow_scripts');
        var execIdx   = code.indexOf('execSync(cmd)', deleteIdx);
        var between   = code.slice(deleteIdx + 'delete '.length, execIdx);
        assert.doesNotMatch(between, /npm_config_allow_scripts\s*=/,
            'no assignment may re-poison the env before the child spawns');
    });

});


// ---------------------------------------------------------------------------
// 02 — behaviour: pure-logic replica of the save/delete/restore guard
// ---------------------------------------------------------------------------
describe('02 - allow-scripts env guard semantics (replica)', function() {

    // Mirror of the post_install.js guard, over an injected env object.
    function withAllowScriptsDropped(env, runChild) {
        var oldAllowScripts = env.npm_config_allow_scripts;
        delete env.npm_config_allow_scripts;
        runChild(env);
        if ( typeof(oldAllowScripts) != 'undefined' ) {
            env.npm_config_allow_scripts = oldAllowScripts;
        }
    }

    // Pre-fix shape: the child inherits whatever the parent exported.
    function withoutGuard(env, runChild) {
        runChild(env);
    }

    it('the child never sees the export when it was set', function() {
        var env = { npm_config_allow_scripts: 'gina', npm_config_global: 'true' };
        var seen = 'sentinel';
        withAllowScriptsDropped(env, function(childEnv) {
            seen = childEnv.npm_config_allow_scripts;
        });
        assert.strictEqual(seen, undefined, 'the nested install must not inherit the export');
    });

    it('the export is restored to its original value afterwards', function() {
        var env = { npm_config_allow_scripts: 'gina' };
        withAllowScriptsDropped(env, function() {});
        assert.strictEqual(env.npm_config_allow_scripts, 'gina');
    });

    it('the key is NOT created when it was never set', function() {
        var env = {};
        withAllowScriptsDropped(env, function() {});
        assert.ok(!('npm_config_allow_scripts' in env),
            'an unset export must stay unset — a bare restore would create it');
    });

    it('other npm_config_* exports pass through untouched', function() {
        var env = { npm_config_allow_scripts: 'gina', npm_config_registry: 'https://registry.example' };
        var seenRegistry = null;
        withAllowScriptsDropped(env, function(childEnv) {
            seenRegistry = childEnv.npm_config_registry;
        });
        assert.strictEqual(seenRegistry, 'https://registry.example');
        assert.strictEqual(env.npm_config_registry, 'https://registry.example');
    });

    it('subtract: the pre-fix shape leaks the export to the child', function() {
        var env = { npm_config_allow_scripts: 'gina' };
        var seen = null;
        withoutGuard(env, function(childEnv) {
            seen = childEnv.npm_config_allow_scripts;
        });
        assert.strictEqual(seen, 'gina',
            'without the guard the nested install inherits the rejected config');
    });

    it('process.env coerces an undefined assignment to the string "undefined" (why the typeof guard exists)', function() {
        var key = '__b106_coercion_probe';
        try {
            process.env[key] = undefined;
            assert.strictEqual(process.env[key], 'undefined',
                'a bare restore of an unset value would write the junk string "undefined"');
        } finally {
            delete process.env[key];
        }
    });

});
