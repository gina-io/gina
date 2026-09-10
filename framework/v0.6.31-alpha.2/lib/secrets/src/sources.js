'use strict';
/**
 * @module lib/secrets/sources
 * @description The config-source walk: which config files exist for a
 * project's bundles, and which `${secret:KEY}` placeholders they require.
 * Shared so that every consumer walks the SAME source set.
 *
 * Consumers today are the `gina secrets:scan` and `gina secrets:check` CLI
 * handlers; the walk is also the enumeration a boot-time consumer (e.g. a
 * prefetching secrets backend) would need. Before this module existed, the
 * two CLI handlers each carried a hand-kept copy of the walk — and two
 * hand-kept copies of "which sources does a bundle read" drifted once
 * already (#B263: the gate and the runtime consulted different source
 * sets, producing a false verdict on the exact command that exists to
 * prevent surprises). One implementation makes that class of disagreement
 * structurally impossible rather than merely unlikely.
 *
 * Config sources walked, matching `core/config.js::loadBundleConfig`:
 *   - `<bundleSrc>/config/` per bundle, where `bundleSrc` comes from
 *     `manifest.bundles[<name>].src` (falling back to the bundle name).
 *   - the project-level `shared/config/`, which the loader merges into
 *     every bundle — so its keys are attributed to each bundle.
 * Every `.json` in those dirs is read (the loader globs the dir rather
 * than using a fixed whitelist); dotfiles and `* copy` files are skipped.
 *
 * With a `scope`, the sibling `config_<scope>/` dir of each config dir
 * (e.g. `shared/config_production/`) is read-only overlaid on top of the
 * base via deep-merge (scope wins) — mirroring how a deploy applies its
 * per-scope config — so the report shows the *effective* keys that scope's
 * deploy will require. This is pure introspection: it does NOT change the
 * runtime config loader, which stays scope-agnostic (the deploy owns
 * per-scope selection).
 *
 * Caveat: this reports the *authored* placeholders on disk, not the merged
 * runtime config — correct today because placeholders are always authored
 * literals.
 *
 * Shape: a FACTORY taking the key-enumeration primitive. `main.js` (which
 * owns `getRequiredKeys`) instantiates it and spreads the result into the
 * `lib.secrets` surface — the factory form exists so this file never
 * requires `./main` back (no load cycle) and never touches the `lib`
 * registry (so a bare `require` of `lib/secrets` stays dependency-free).
 *
 * Framework global context: the walk resolves `_()` (path normalisation)
 * and `requireJSON` (comment-tolerant JSON read) at CALL time — they are
 * the gna.js / helpers-injected globals every runtime and CLI scope
 * carries. Module LOAD touches neither, so requiring `lib/secrets` in a
 * bare test process needs no global setup; only *calling* the walk does
 * (a test installs them by requiring the framework `helpers/` tree).
 */

var fs = require('fs');
// Deep merge for the scope overlay. Required relatively (server-side only;
// this module is not in the browser bundle) — and its node export path also
// installs `JSON.clone` when absent (#M22), which the overlay clone needs.
var merge = require('../../merge');

/**
 * Builds the config-source walk over the supplied key-enumeration
 * primitive.
 *
 * @function module:lib/secrets/sources
 * @param {function} getRequiredKeys - `lib/secrets`'s own `getRequiredKeys(config)` — read-only, non-throwing, backend-free
 * @returns {{getProjectRequiredKeys: function, loadManifest: function, readJsonSafe: function, resolveBundleSrc: function}}
 */
module.exports = function sourcesFactory(getRequiredKeys) {

    /**
     * Config files are JSON. The loader globs every `.json` in a config
     * dir; this matches that, then drops dotfiles and `* copy` siblings.
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var JSON_EXT = /\.json$/;

    /**
     * Reads a JSON file with comment tolerance via `requireJSON`. Returns
     * `null` when the file is absent or unreadable so callers can choose
     * how to surface the failure. A file that exists but does not PARSE
     * follows `requireJSON`'s own loud-failure contract instead: in a full
     * framework context (where `console.emerg` exists) it emerg-logs and
     * exits the process, so the catch below never sees it — stated here
     * because the previous in-handler copies of this helper documented
     * "null on any parse error", which that contract makes unreachable.
     *
     * Note `requireJSON` caches by path (require-cache semantics), so the
     * returned object is SHARED — callers that mutate or merge it must
     * clone first (the scope overlay below does).
     *
     * @memberof module:lib/secrets/sources
     * @function readJsonSafe
     * @param {string} filePath - Absolute path
     * @returns {object|null}
     * @example
     * var pkg = readJsonSafe('/tmp/some-project/manifest.json');
     * if (pkg === null) { console.warn('unreadable or absent'); }
     */
    var readJsonSafe = function (filePath) {
        try {
            if ( !fs.existsSync(filePath) ) return null;
            return requireJSON(filePath);
        } catch (e) {
            return null;
        }
    };

    /**
     * Loads `<projectPath>/manifest.json`. Returns `null` on failure.
     *
     * @memberof module:lib/secrets/sources
     * @function loadManifest
     * @param {string} projectPath - Absolute project root
     * @returns {object|null}
     * @example
     * var manifest = loadManifest('/tmp/some-project');
     * var names = manifest ? Object.keys(manifest.bundles) : [];
     */
    var loadManifest = function (projectPath) {
        return readJsonSafe(_(projectPath + '/manifest.json', true));
    };

    /**
     * Resolves a bundle's source-dir (relative to the project root) from
     * the manifest, mirroring `bundle:openapi`. Falls back to the bundle
     * name when `src` is absent.
     *
     * @memberof module:lib/secrets/sources
     * @function resolveBundleSrc
     * @param {object|null} manifest
     * @param {string} bundleName
     * @returns {string}
     * @example
     * resolveBundleSrc({ bundles: { demo: { src: 'src/demo' } } }, 'demo'); // 'src/demo'
     * resolveBundleSrc(null, 'demo');                                      // 'demo'
     */
    var resolveBundleSrc = function (manifest, bundleName) {
        if ( manifest && manifest.bundles && manifest.bundles[bundleName] && manifest.bundles[bundleName].src ) {
            return manifest.bundles[bundleName].src;
        }
        return bundleName;
    };

    /**
     * Lists the `.json` files in `dir`, skipping dotfiles and `* copy`
     * siblings — the same filtering `loadBundleConfig` applies. Returns a
     * sorted list of bare filenames. Empty when the dir is absent.
     *
     * @inner
     * @private
     * @param {string} dir - Absolute config directory
     * @returns {string[]}
     */
    var listJsonFiles = function (dir) {
        if ( !fs.existsSync(dir) ) return [];
        var entries;
        try { entries = fs.readdirSync(dir); } catch (e) { return []; }
        var out = [];
        for (var i = 0; i < entries.length; i++) {
            var name = entries[i];
            if ( /^\./.test(name) ) continue;
            if ( /\s+copy/i.test(name) ) continue;
            if ( !JSON_EXT.test(name) ) continue;
            out.push(name);
        }
        out.sort();
        return out;
    };

    /**
     * Reads every `.json` under `absDir`, enumerates its required secret
     * keys via the injected `getRequiredKeys`, and records each key
     * against its originating file (labelled `relBase + '/' + filename`).
     * Mutates `byKey` in place.
     *
     * When `scopeName` is set, the sibling `<absDir>_<scope>/` directory
     * (e.g. `shared/config_production/`) is read-only overlaid on top of
     * the base dir per config file, mirroring how a deploy applies its
     * per-scope config: the scope file deep-merges over the base (scope
     * wins on collisions, base back-fills) so the keys reported are the
     * *effective* ones that scope's deploy will require. The scope file is
     * JSON.clone'd before merge so cached content is not mutated. This is
     * read-only introspection — it never touches the runtime config
     * loader.
     *
     * @inner
     * @private
     * @param {string} absDir  - Absolute base config directory to read
     * @param {string} relBase - Display prefix for file labels (e.g. `src/demo/config`)
     * @param {Object<string, string[]>} byKey - Mutable KEY -> [files] map
     * @param {string|null} scopeName - Scope overlay name, or `null`
     */
    var collectFromConfigDir = function (absDir, relBase, byKey, scopeName) {
        var scopeAbsDir  = scopeName ? (absDir + '_' + scopeName) : null;
        var scopeRelBase = scopeName ? (relBase + '_' + scopeName) : null;

        var baseNames  = listJsonFiles(absDir);
        var scopeNames = scopeAbsDir ? listJsonFiles(scopeAbsDir) : [];

        // union of config file names across base + scope-overlay dirs
        var names = baseNames.slice();
        for (var s = 0; s < scopeNames.length; s++) {
            if (names.indexOf(scopeNames[s]) < 0) names.push(scopeNames[s]);
        }

        for (var f = 0; f < names.length; f++) {
            var name         = names[f];
            var baseContent  = (baseNames.indexOf(name) > -1) ? readJsonSafe(_(absDir + '/' + name, true)) : null;
            var scopeContent = (scopeAbsDir && scopeNames.indexOf(name) > -1) ? readJsonSafe(_(scopeAbsDir + '/' + name, true)) : null;

            // effective config for this scope: scope deep-merges over base (scope wins).
            // override=false is explicit (not merge's default) so scope precedence stays
            // correct even if lib/merge's default override ever changes.
            var effective = scopeContent ? merge(JSON.clone(scopeContent), baseContent || {}, false) : baseContent;
            if (!effective) continue;

            var keys      = getRequiredKeys(effective);
            var scopeKeys = scopeContent ? getRequiredKeys(scopeContent) : [];
            for (var k = 0; k < keys.length; k++) {
                // attribute the key to the layer that actually provides it in the effective config
                var label = (scopeKeys.indexOf(keys[k]) > -1) ? (scopeRelBase + '/' + name) : (relBase + '/' + name);
                if (!byKey[keys[k]]) byKey[keys[k]] = [];
                if (byKey[keys[k]].indexOf(label) < 0) byKey[keys[k]].push(label);
            }
        }
    };

    /**
     * Computes the shared-config KEY -> [files] map once per project. The
     * loader merges `shared/config/` into every bundle, so these keys are
     * attributed to each bundle.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string|null} scopeName
     * @returns {Object<string, string[]>}
     */
    var computeSharedByKey = function (projectPath, scopeName) {
        var byKey = Object.create(null);
        collectFromConfigDir(_(projectPath + '/shared/config', true), 'shared/config', byKey, scopeName);
        return byKey;
    };

    /**
     * Enumerates the `${secret:KEY}` placeholders a project's bundles
     * require, walking the same config sources `loadBundleConfig` reads
     * (shared/config folded into every bundle; per-bundle `config/`; the
     * optional `config_<scope>/` overlay). Read-only and non-throwing —
     * the introspection family contract `getRequiredKeys` set.
     *
     * Provenance is always on: each key maps to the project-relative
     * config file(s) that require it, insertion-ordered and de-duplicated
     * (shared labels first, then the bundle's own).
     *
     * Semantics, precisely:
     *   - a non-string or empty `projectPath` returns `null`.
     *   - with `options.bundle`, the filter is honoured VERBATIM: that one
     *     bundle is walked even when the manifest is missing or does not
     *     list it (its src falls back to the bundle name; absent dirs
     *     simply contribute nothing) — matching the CLI, which validates
     *     membership itself before calling and, historically, walked a
     *     manifest-less project on an explicit bundle name.
     *   - without `options.bundle`, the manifest IS the bundle list: a
     *     missing/unreadable manifest, or one without a `bundles` object,
     *     returns `null` (callers decide how to surface it).
     *
     * @memberof module:lib/secrets/sources
     * @function getProjectRequiredKeys
     * @param {string} projectPath - Absolute project root
     * @param {object} [options]
     * @param {string|null} [options.scope=null]  - Scope overlay name (`config_<scope>/` siblings)
     * @param {string|null} [options.bundle=null] - Restrict the walk to one bundle
     * @returns {{bundles: Array<{bundle: string, byKey: Object<string, string[]>}>}|null}
     *          Bundles sorted by name; `byKey` is a null-proto KEY -> [labels] map
     * @example
     * // all bundles, production overlay:
     * var r = getProjectRequiredKeys('/tmp/some-project', { scope: 'production' });
     * // -> { bundles: [ { bundle: 'demo', byKey: { DB_PASSWORD: ['shared/config/app.json'] } } ] }
     * @example
     * // one bundle, no overlay — null projectPath and missing manifests are not thrown:
     * getProjectRequiredKeys('', {});                                // null
     * getProjectRequiredKeys('/tmp/some-project', { bundle: 'demo' }); // walks only demo
     */
    var getProjectRequiredKeys = function (projectPath, options) {
        if (typeof projectPath !== 'string' || projectPath === '') {
            return null;
        }
        var opts      = (options && typeof options === 'object') ? options : {};
        var scopeName = opts.scope || null;
        var manifest  = loadManifest(projectPath);

        var names;
        if (opts.bundle) {
            names = [opts.bundle];
        } else {
            if (!manifest || !manifest.bundles || typeof manifest.bundles !== 'object') {
                return null;
            }
            names = Object.keys(manifest.bundles).sort();
        }

        var sharedByKey = computeSharedByKey(projectPath, scopeName);
        var bundles     = [];
        for (var i = 0; i < names.length; i++) {
            var byKey = Object.create(null);
            for (var sk in sharedByKey) {
                byKey[sk] = sharedByKey[sk].slice();
            }
            var bundleSrc = resolveBundleSrc(manifest, names[i]);
            var rel       = bundleSrc + '/config';
            collectFromConfigDir(_(projectPath + '/' + rel, true), rel, byKey, scopeName);
            bundles.push({ bundle: names[i], byKey: byKey });
        }
        return { bundles: bundles };
    };

    return {
        getProjectRequiredKeys : getProjectRequiredKeys,
        loadManifest           : loadManifest,
        readJsonSafe           : readJsonSafe,
        resolveBundleSrc       : resolveBundleSrc
    };
};
