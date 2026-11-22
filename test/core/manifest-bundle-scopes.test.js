'use strict';
/**
 * #B373 — per-scope bundle deployment: `manifest.json` `bundles[<name>].scopes`.
 *
 * The gap this closes (measured 2026-08-15): a bundle registered in a project was
 * deployed in EVERY scope, with no way to say "this one is local-only while I build
 * it". The obvious workarounds were all measured and refuted:
 *
 *   - Deleting `releases[<scope>]` by hand does not hold — BOTH build verbs walk
 *     every project scope and re-seed any missing `releases[scope]` + `target`
 *     (project/build.js, bundle/build.js), so the absence regrows on the next build.
 *     Absence therefore cannot carry intent; an explicit key is required.
 *   - A boolean inside `releases[<scope>]` would be iterated as an environment by
 *     `bundle:copy` and `bundle:rename`, which both do `for (var env in
 *     entry.releases[scope])`.
 *   - Leaving the bundle out of `manifest.bundles` removes it from every scope at
 *     once (config.js's `typeof(pkg[app]) == 'undefined'` skip).
 *
 * SEMANTICS — `scopes` is an ALLOW-LIST, deliberately mirroring a route's rule-level
 * `scopes` (config.js defaults `routing[rule].scopes` to `[ scope ]`):
 *   absent / null  -> every scope (back-compat; every existing manifest is unchanged)
 *   ["local"]      -> that scope only
 *   []             -> parked: no scope at all
 *   non-array      -> a MANIFEST ERROR, refused by name — never silently "no scopes",
 *                     because the predicate returns false for both and reporting a
 *                     type error as "not deployed" sends the operator hunting the
 *                     wrong thing.
 *
 * Skip vs refuse is split by whether the exclusion was ASKED FOR:
 *   - boot loop (config.js) and `project:build` (bulk)  -> skip + say so
 *   - starting bundle (config.js + gna.js) and `bundle:build <name>` (explicit)
 *     -> refuse by name, naming the scope and the one-line remedy
 *
 * The predicate is DUPLICATED in core/gna.js because the mount-resolution path runs
 * before Config exists and cannot reach that closure; §03 pins both copies and
 * asserts they agree.
 *
 * §01 — config.js pins       §02 — gna.js pins (incl. the pre-deref ordering)
 * §03 — the two predicates are twins   §04 — behavioural replica + controls
 * §05 — build-verb pins (seeding filter + explicit refusal)
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var commentStrip = require('../strip-comments');
var CONFIG   = fs.readFileSync(path.join(FW, 'core/config.js'), 'utf8');
var GNA      = fs.readFileSync(path.join(FW, 'core/gna.js'), 'utf8');
var B_BUILD  = fs.readFileSync(path.join(FW, 'lib/cmd/bundle/build.js'), 'utf8');
var P_BUILD  = fs.readFileSync(path.join(FW, 'lib/cmd/project/build.js'), 'utf8');
var SCHEMA   = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schema/manifest.json'), 'utf8'));

describe('#B373 §01 — config.js honours the allow-list', function () {

    it('declares the predicate with back-compat defaults', function () {
        assert.match(CONFIG, /var isBundleDeployedInScope = function\(bundleEntry, scopeName\)/);
        var i = CONFIG.indexOf('var isBundleDeployedInScope');
        var body = CONFIG.substring(i, i + 700);
        assert.match(body, /typeof\(bundleEntry\.scopes\) == 'undefined'/,
            'an absent key must mean every scope, or every existing manifest changes behaviour');
        assert.match(body, /!Array\.isArray\(bundleEntry\.scopes\)/, 'a non-array must not be treated as a list');
        assert.match(body, /indexOf\(scopeName\) > -1/, 'allow-list membership');
    });

    it('the boot loop SKIPS an excluded bundle, and says why', function () {
        var i = CONFIG.indexOf("Skipping app [ '+ app +' ]; not registered");
        assert.ok(i > -1, 'the unregistered-skip anchor must exist');
        var region = CONFIG.substring(i, i + 1800);
        assert.match(region, /isBundleDeployedInScope\(pkg\[app\], scope\)/, 'the loop must consult the predicate');
        assert.ok(region.indexOf('continue;') > -1, 'an excluded bundle is skipped, not fatal');
        assert.ok(region.indexOf('console.warn(') > -1,
            'a bundle vanishing from the boot with no explanation is the #B183 lesson');
        assert.ok(region.indexOf('manifest.json') > -1, 'the notice names the file to edit');
    });

    it('a non-array `scopes` is refused, NOT read as "no scopes"', function () {
        var i = CONFIG.indexOf('must be an array of scope names');
        assert.ok(i > -1, 'config.js must carry the type refusal');
        var region = CONFIG.substring(i - 400, i + 400);
        assert.match(region, /return callback\(/, 'it refuses through the callback sink, reaching exit(1)');
    });

    it('the STARTING bundle is refused by name, before the env.json guard can mis-explain it', function () {
        var i = CONFIG.indexOf('cannot start `');
        assert.ok(i > -1, 'the starting-bundle refusal must exist');
        var region = CONFIG.substring(i - 700, i + 700);
        assert.match(region, /isBundleDeployedInScope\(pkg\[self\.startingApp\], scope\)/);
        assert.match(region, /return callback\(/, 'refusal travels the #B372 sink');
        assert.ok(region.indexOf('manifest.json') > -1, 'and names the remedy');
        // ordering: the refusal must precede the apps loop, or the #B181(b) guard
        // would report an env.json cause for a scope problem.
        assert.ok(i < CONFIG.indexOf('for (let app in content)'),
            'the starting-bundle refusal must sit BEFORE the apps loop');
    });
});

describe('#B373 §02 — gna.js honours it too, before Config exists', function () {

    it('carries its own copy of the predicate (documented as a twin)', function () {
        assert.match(GNA, /var isBundleDeployedInScope = function\(bundleEntry, scopeName\)/);
        var i = GNA.indexOf('var isBundleDeployedInScope');
        assert.ok(GNA.substring(i - 900, i).indexOf('TWIN') > -1,
            'the duplication must be labelled, or it reads as an accident');
    });

    it('the CLI mount refuses BEFORE the unguarded release deref', function () {
        var guard = GNA.indexOf('cannot mount `');
        var deref = GNA.indexOf("packs[appName].releases[scope][env].target = 'releases/'");
        assert.ok(guard > -1, 'the mount refusal must exist');
        assert.ok(deref > -1, 'the release deref must still exist');
        assert.ok(guard < deref,
            'the deref sits outside any try — a guard after it would still die as an opaque TypeError');
    });

    it('the mount-resolution loop SKIPS excluded siblings before their deref', function () {
        var i = GNA.indexOf('for (let bundle in packs)');
        assert.ok(i > -1, 'the mount-resolution loop must exist');
        // Absolute offsets from the loop, NOT a fixed-width window: a window wide
        // enough today silently stops reaching the deref the moment anything is
        // added between the two, and the pin then fails for the wrong reason.
        var skip  = GNA.indexOf('isBundleDeployedInScope(packs[bundle], scope)', i);
        var deref = GNA.indexOf('releases[scope][env].target', i);
        assert.ok(skip > -1, 'the loop must consult the predicate');
        assert.ok(deref > -1, 'the release deref must still exist');
        assert.ok(skip < deref,
            'the skip must precede the deref whose catch aborts the whole mount');
        assert.ok(GNA.substring(skip, deref).indexOf('continue;') > -1,
            'and it must skip the bundle, not merely test it');
    });

    it('reports a malformed `scopes` as a manifest error, not as "not deployed"', function () {
        var i = GNA.indexOf('must be an array of scope names');
        assert.ok(i > -1, 'gna.js must distinguish the type error');
        assert.ok(i < GNA.indexOf('cannot mount `'),
            'the type check must run first, or a malformed key reports the wrong cause');
    });
});

describe('#B373 §03 — the two predicates are genuine twins', function () {
    /** Extracts a predicate body by its declaration, brace-matched. */
    function extract(src) {
        var at = src.indexOf('var isBundleDeployedInScope = function(bundleEntry, scopeName)');
        if (at < 0) return null;
        var open = src.indexOf('{', at);
        var depth = 0, end = -1;
        for (var i = open; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        return src.slice(open + 1, end);
    }

    it('both bodies exist and are behaviourally identical (whitespace-normalised)', function () {
        var a = extract(CONFIG), b = extract(GNA);
        assert.ok(a && a.length > 60, 'config.js predicate not extracted');
        assert.ok(b && b.length > 60, 'gna.js predicate not extracted');
        var norm = function (s) {
            return commentStrip.all(s)
                    .replace(/\s+/g, ' ')
                    .trim();
        };
        assert.equal(norm(a), norm(b),
            'the twins have drifted — a bundle would be skipped at one layer and mounted at the other');
    });
});

describe('#B373 §04 — replica of the predicate contract', function () {

    // Mirrors both shipped copies (§03 pins that they agree).
    function deployed(entry, scopeName) {
        if (!entry || typeof (entry.scopes) === 'undefined' || entry.scopes === null) return true;
        if (!Array.isArray(entry.scopes)) return false;
        return entry.scopes.indexOf(scopeName) > -1;
    }

    it('BACK-COMPAT: no key means every scope (the control that would catch an over-firing guard)', function () {
        var legacy = { src: 'src/api', link: 'bundles/api', releases: {} };
        [ 'local', 'production', 'staging', 'anything' ].forEach(function (s) {
            assert.equal(deployed(legacy, s), true, 'an existing manifest must be untouched in scope ' + s);
        });
        assert.equal(deployed({ scopes: null }, 'production'), true, 'explicit null is also "every scope"');
    });

    it('the local-only case works in both directions', function () {
        var entry = { scopes: [ 'local' ] };
        assert.equal(deployed(entry, 'local'), true);
        assert.equal(deployed(entry, 'production'), false);
    });

    it('an empty array parks the bundle everywhere', function () {
        assert.equal(deployed({ scopes: [] }, 'local'), false);
        assert.equal(deployed({ scopes: [] }, 'production'), false);
    });

    it('multi-scope membership is exact, not prefix or substring', function () {
        var entry = { scopes: [ 'local', 'staging' ] };
        assert.equal(deployed(entry, 'staging'), true);
        assert.equal(deployed(entry, 'stag'), false, 'a prefix must not match');
        assert.equal(deployed(entry, 'staging2'), false, 'a superstring must not match');
        assert.equal(deployed(entry, 'production'), false);
    });

    it('a non-array yields false, so callers must type-check FIRST (pinned in §01/§02)', function () {
        assert.equal(deployed({ scopes: 'local' }, 'local'), false,
            'a string is not an allow-list — the callers refuse it by name before relying on this');
    });
});

describe('#B373 §05 — the build verbs make the opt-out durable', function () {

    it('bundle:build REFUSES an explicitly-targeted excluded bundle', function () {
        assert.ok(B_BUILD.indexOf('Cannot build `') > -1, 'an explicit ask must not silently no-op');
        assert.ok(B_BUILD.indexOf('is not deployed there') > -1);
        assert.ok(B_BUILD.indexOf('must be an array of scope names') > -1, 'and type-checks the key');
    });

    it('project:build SKIPS rather than refusing (one parked bundle must not block the project)', function () {
        var i = P_BUILD.indexOf('Skipping bundle [ ');
        assert.ok(i > -1, 'the bulk verb skips');
        var region = P_BUILD.substring(i - 600, i + 400);
        assert.match(region, /return buildBundle\(b\+1\)/, 'and advances to the next bundle');
    });

    it('BOTH seeding loops filter, or the opt-out regrows on the next build', function () {
        [ [ 'bundle/build.js', B_BUILD ], [ 'project/build.js', P_BUILD ] ].forEach(function (pair) {
            var name = pair[0], src = pair[1];
            var i = src.indexOf('releases[scope] = {}');
            assert.ok(i > -1, name + ': the seeding assignment must exist');
            var region = src.substring(i - 800, i);
            assert.match(region, /\.scopes\)\s*\n?\s*&&\s*.*\.scopes\.indexOf\(scope\) < 0|scopes\.indexOf\(scope\) < 0/,
                name + ': the seeding loop must skip scopes the bundle opts out of');
        });
    });
});

describe('#B373 §06 — the schema documents the key', function () {
    it('bundleEntry.scopes is declared as an optional string array', function () {
        var e = SCHEMA.definitions.bundleEntry.properties;
        assert.ok(e.scopes, 'schema must document the key consumers will hand-edit');
        assert.equal(e.scopes.type, 'array');
        assert.equal(e.scopes.items.type, 'string');
        assert.equal((SCHEMA.definitions.bundleEntry.required || []).indexOf('scopes'), -1,
            'it must stay OPTIONAL — requiring it would break every existing manifest');
    });
});
