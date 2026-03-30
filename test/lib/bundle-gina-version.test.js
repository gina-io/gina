'use strict';
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW              = require('../fw');
var HELPER_SOURCE   = path.join(FW, 'lib/cmd/helper.js');
var START_SOURCE    = path.join(FW, 'lib/cmd/bundle/start.js');
var BUNDLE_ARGS     = path.join(FW, 'lib/cmd/bundle/arguments.json');


// ---------------------------------------------------------------------------
// Replicas of the pure logic added to the framework — tested in isolation
// without requiring the full socket-server context.
// ---------------------------------------------------------------------------

/**
 * Replica of the bundleGinaVersion resolution logic from loadAssets()
 * in lib/cmd/helper.js.
 *
 * Priority: CLI flag (paramVersion) > manifest.json gina_version > null.
 * Throws when a declared version is not in the frameworks registry.
 */
function resolveBundleGinaVersion(paramVersion, projectBundles, bundleName, frameworks) {
    var bundleGinaVersion = paramVersion || null;
    if (
        !bundleGinaVersion
        && typeof(projectBundles) != 'undefined'
        && typeof(projectBundles[bundleName]) != 'undefined'
    ) {
        bundleGinaVersion = projectBundles[bundleName]['gina_version'] || null;
    }
    if ( bundleGinaVersion ) {
        var bvShort = bundleGinaVersion.split('.').splice(0,2).join('.');
        var knownVersions = ( frameworks && frameworks[bvShort] ) ? frameworks[bvShort] : null;
        if ( !Array.isArray(knownVersions) || knownVersions.indexOf(bundleGinaVersion) < 0 ) {
            throw new Error('gina_version `'+ bundleGinaVersion +'` is not an installed version');
        }
    }
    return bundleGinaVersion;
}

/**
 * Replica of the context override logic added to the spawn section of
 * lib/cmd/bundle/start.js.
 *
 * Returns the original context reference when no override is needed.
 * Returns a deep clone with GINA_VERSION / GINA_FRAMEWORK_DIR / GINA_CORE
 * overridden when bundleGinaVersion is set, so concurrent bundle starts each
 * get their own context copy.
 */
function overrideCtxForBundle(ctx, bundleGinaVersion, ginaDir) {
    if ( !bundleGinaVersion ) {
        return ctx;
    }
    var cloned = JSON.parse(JSON.stringify(ctx));
    cloned.envVars['GINA_VERSION']       = bundleGinaVersion;
    cloned.envVars['GINA_FRAMEWORK_DIR'] = ginaDir + '/framework/v' + bundleGinaVersion;
    cloned.envVars['GINA_CORE']          = ginaDir + '/framework/v' + bundleGinaVersion + '/core';
    return cloned;
}


// ---------------------------------------------------------------------------
// 01 — bundle/arguments.json: --gina-version is whitelisted
// ---------------------------------------------------------------------------
describe('01 - bundle/arguments.json: --gina-version is whitelisted', function() {

    it('bundle/arguments.json exists', function() {
        assert.ok(fs.existsSync(BUNDLE_ARGS));
    });

    it('--gina-version is in the whitelist', function() {
        var args = JSON.parse(fs.readFileSync(BUNDLE_ARGS, 'utf8'));
        assert.ok(
            args.indexOf('--gina-version') > -1,
            'expected --gina-version in bundle/arguments.json'
        );
    });

    it('pre-existing flags are still present', function() {
        var args = JSON.parse(fs.readFileSync(BUNDLE_ARGS, 'utf8'));
        assert.ok(args.indexOf('--env') > -1,   'expected --env');
        assert.ok(args.indexOf('--scope') > -1, 'expected --scope');
        assert.ok(args.indexOf('--force') > -1, 'expected --force');
    });
});


// ---------------------------------------------------------------------------
// 02 — Source: lib/cmd/helper.js wires bundleGinaVersion
// ---------------------------------------------------------------------------
describe('02 - lib/cmd/helper.js: bundleGinaVersion wiring', function() {

    it('declares bundleGinaVersion: null in CmdHelper self defaults', function() {
        var src = fs.readFileSync(HELPER_SOURCE, 'utf8');
        assert.ok(
            /bundleGinaVersion\s*:\s*null/.test(src),
            'expected bundleGinaVersion: null in CmdHelper self defaults'
        );
    });

    it('reads --gina-version from cmd.params', function() {
        var src = fs.readFileSync(HELPER_SOURCE, 'utf8');
        assert.ok(
            /cmd\.params\[.gina-version.\]/.test(src),
            "expected cmd.params['gina-version'] in loadAssets()"
        );
    });

    it('falls back to gina_version in projectData.bundles', function() {
        var src = fs.readFileSync(HELPER_SOURCE, 'utf8');
        assert.ok(
            /gina_version/.test(src),
            'expected gina_version field lookup in loadAssets()'
        );
    });

    it('validates against mainConfig.frameworks', function() {
        var src = fs.readFileSync(HELPER_SOURCE, 'utf8');
        assert.ok(
            /mainConfig\.frameworks/.test(src),
            'expected mainConfig.frameworks validation'
        );
    });

    it('stores result in cmd.bundleGinaVersion', function() {
        var src = fs.readFileSync(HELPER_SOURCE, 'utf8');
        assert.ok(
            /cmd\.bundleGinaVersion\s*=/.test(src),
            'expected cmd.bundleGinaVersion = ... assignment'
        );
    });
});


// ---------------------------------------------------------------------------
// 03 — Source: lib/cmd/bundle/start.js clones context for version override
// ---------------------------------------------------------------------------
describe('03 - lib/cmd/bundle/start.js: context isolation for version override', function() {

    it('clones the context via JSON.clone when bundleGinaVersion is set', function() {
        var src = fs.readFileSync(START_SOURCE, 'utf8');
        assert.ok(
            /JSON\.clone\(_ctx\)/.test(src),
            'expected JSON.clone(_ctx) for isolated context copy'
        );
    });

    it('overrides GINA_VERSION in cloned context envVars', function() {
        var src = fs.readFileSync(START_SOURCE, 'utf8');
        assert.ok(
            /_ctx\.envVars\[.GINA_VERSION.\]/.test(src),
            "expected _ctx.envVars['GINA_VERSION'] override"
        );
    });

    it('overrides GINA_FRAMEWORK_DIR in cloned context envVars', function() {
        var src = fs.readFileSync(START_SOURCE, 'utf8');
        assert.ok(
            /_ctx\.envVars\[.GINA_FRAMEWORK_DIR.\]/.test(src),
            "expected _ctx.envVars['GINA_FRAMEWORK_DIR'] override"
        );
    });

    it('overrides GINA_CORE in cloned context envVars', function() {
        var src = fs.readFileSync(START_SOURCE, 'utf8');
        assert.ok(
            /_ctx\.envVars\[.GINA_CORE.\]/.test(src),
            "expected _ctx.envVars['GINA_CORE'] override"
        );
    });

    it('passes _ctx (not raw getContext()) to JSON.stringify for params', function() {
        var src = fs.readFileSync(START_SOURCE, 'utf8');
        assert.ok(
            /JSON\.stringify\(_ctx\)/.test(src),
            'expected JSON.stringify(_ctx) — not JSON.stringify(getContext())'
        );
    });
});


// ---------------------------------------------------------------------------
// 04 — Logic: bundleGinaVersion resolution (isolated, no filesystem)
// ---------------------------------------------------------------------------
describe('04 - bundleGinaVersion resolution logic', function() {

    var frameworks = {
        '0.1': ['0.1.8'],
        '0.2': ['0.2.0', '0.2.1-alpha.3']
    };

    it('returns null when no CLI flag and no manifest declaration', function() {
        var result = resolveBundleGinaVersion(null, { api: { version: '1.0.0' } }, 'api', frameworks);
        assert.equal(result, null);
    });

    it('returns null when bundle is absent from manifest', function() {
        var result = resolveBundleGinaVersion(null, {}, 'api', frameworks);
        assert.equal(result, null);
    });

    it('CLI flag is used when provided', function() {
        var result = resolveBundleGinaVersion('0.2.0', {}, 'api', frameworks);
        assert.equal(result, '0.2.0');
    });

    it('manifest gina_version is used when no CLI flag', function() {
        var bundles = { api: { gina_version: '0.1.8' } };
        var result = resolveBundleGinaVersion(null, bundles, 'api', frameworks);
        assert.equal(result, '0.1.8');
    });

    it('CLI flag takes priority over manifest gina_version', function() {
        var bundles = { api: { gina_version: '0.1.8' } };
        var result = resolveBundleGinaVersion('0.2.0', bundles, 'api', frameworks);
        assert.equal(result, '0.2.0');
    });

    it('accepts a pre-release version that is installed', function() {
        var result = resolveBundleGinaVersion('0.2.1-alpha.3', {}, 'api', frameworks);
        assert.equal(result, '0.2.1-alpha.3');
    });

    it('throws when short version family is not in frameworks at all', function() {
        assert.throws(
            function() { resolveBundleGinaVersion('9.9.9', {}, 'api', frameworks); },
            /not an installed version/
        );
    });

    it('throws when version is in right family but not individually installed', function() {
        assert.throws(
            function() { resolveBundleGinaVersion('0.2.99-beta.1', {}, 'api', frameworks); },
            /not an installed version/
        );
    });

    it('throws when manifest declares an unknown version', function() {
        var bundles = { api: { gina_version: '0.1.0-unknown' } };
        assert.throws(
            function() { resolveBundleGinaVersion(null, bundles, 'api', frameworks); },
            /not an installed version/
        );
    });

    it('error message includes the bad version string', function() {
        assert.throws(
            function() { resolveBundleGinaVersion('0.2.99', {}, 'api', frameworks); },
            /0\.2\.99/
        );
    });
});


// ---------------------------------------------------------------------------
// 05 — Logic: context override for bundle spawn (isolated, no filesystem)
// ---------------------------------------------------------------------------
describe('05 - bundle spawn context override logic', function() {

    var baseCtx = {
        envVars: {
            GINA_VERSION:       '0.2.1-alpha.3',
            GINA_FRAMEWORK_DIR: '/opt/gina/framework/v0.2.1-alpha.3',
            GINA_CORE:          '/opt/gina/framework/v0.2.1-alpha.3/core',
            GINA_DIR:           '/opt/gina'
        },
        paths:       { framework: '/opt/gina/framework/v0.2.1-alpha.3' },
        processList: [],
        ginaProcess: 42
    };

    it('returns the original reference when no override is needed', function() {
        var result = overrideCtxForBundle(baseCtx, null, '/opt/gina');
        assert.equal(result, baseCtx);
    });

    it('returns a different object reference when override is set', function() {
        var result = overrideCtxForBundle(baseCtx, '0.1.8', '/opt/gina');
        assert.notEqual(result, baseCtx);
    });

    it('does not mutate the original context', function() {
        overrideCtxForBundle(baseCtx, '0.1.8', '/opt/gina');
        assert.equal(baseCtx.envVars.GINA_VERSION, '0.2.1-alpha.3');
        assert.equal(baseCtx.envVars.GINA_FRAMEWORK_DIR, '/opt/gina/framework/v0.2.1-alpha.3');
        assert.equal(baseCtx.envVars.GINA_CORE, '/opt/gina/framework/v0.2.1-alpha.3/core');
    });

    it('sets GINA_VERSION to the declared version', function() {
        var result = overrideCtxForBundle(baseCtx, '0.1.8', '/opt/gina');
        assert.equal(result.envVars.GINA_VERSION, '0.1.8');
    });

    it('sets GINA_FRAMEWORK_DIR to the declared version path', function() {
        var result = overrideCtxForBundle(baseCtx, '0.1.8', '/opt/gina');
        assert.equal(result.envVars.GINA_FRAMEWORK_DIR, '/opt/gina/framework/v0.1.8');
    });

    it('sets GINA_CORE to the declared version core path', function() {
        var result = overrideCtxForBundle(baseCtx, '0.1.8', '/opt/gina');
        assert.equal(result.envVars.GINA_CORE, '/opt/gina/framework/v0.1.8/core');
    });

    it('preserves GINA_DIR unchanged', function() {
        var result = overrideCtxForBundle(baseCtx, '0.1.8', '/opt/gina');
        assert.equal(result.envVars.GINA_DIR, '/opt/gina');
    });

    it('preserves non-envVars properties (processList, ginaProcess)', function() {
        var result = overrideCtxForBundle(baseCtx, '0.1.8', '/opt/gina');
        assert.deepEqual(result.processList, []);
        assert.equal(result.ginaProcess, 42);
    });

    it('two concurrent overrides do not share state', function() {
        var ctxA = overrideCtxForBundle(baseCtx, '0.1.8', '/opt/gina');
        var ctxB = overrideCtxForBundle(baseCtx, '0.2.0', '/opt/gina');
        assert.equal(ctxA.envVars.GINA_VERSION, '0.1.8');
        assert.equal(ctxB.envVars.GINA_VERSION, '0.2.0');
        assert.equal(baseCtx.envVars.GINA_VERSION, '0.2.1-alpha.3');
    });

    it('cloned context serialises to valid JSON', function() {
        var result = overrideCtxForBundle(baseCtx, '0.1.8', '/opt/gina');
        assert.doesNotThrow(function() { JSON.stringify(result); });
    });
});
