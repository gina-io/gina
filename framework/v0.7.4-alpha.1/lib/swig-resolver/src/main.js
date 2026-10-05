/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/swig-resolver
 *
 * Pure resolver that picks between a project-installed swig package and the
 * framework's bundled copy. Opt-in via `swig.useProject: true` in the bundle
 * or project settings; default-off so the current behaviour (framework copy
 * always wins) is preserved.
 *
 * The resolver does **not** `require()` the swig module itself — it returns
 * a decision record containing the path to require. The caller (server.js /
 * gna.js) performs the actual require. This keeps the library pure and
 * testable without loading the heavy template engine during unit tests.
 *
 * Three safety gates on the project override:
 *
 *  1. **Package name allowlist** — only the configured `package` (default
 *     `@rhinostone/swig`) is honoured. `swig.package: "@rhinostone/swig-twig"`
 *     lets a project opt into the Twig frontend, and
 *     `swig.package: "@rhinostone/swig-jinja2"` opts into the Jinja2 frontend
 *     (sibling packages from the same multi-flavor release as
 *     `@rhinostone/swig`), without re-keying anything. The abandoned upstream
 *     `swig` package name is never resolvable — it is not in the default or
 *     any of the known alternates, so a project that only has `"swig"` in
 *     node_modules gets the framework copy (which fixes CVE-2023-25345 at
 *     the controller layer).
 *
 *  2. **Same-major rule** — the project's version must share the major
 *     component with the floor. Different major → fall back, because the
 *     framework code was written against the major's API surface.
 *
 *  3. **Minimum floor** — within the same major, the project's version must
 *     be >= the floor constant below. Bump the floor in the same commit that
 *     introduces a framework dependency on a new fork API.
 *
 * @example
 * var resolver = require('lib/swig-resolver');
 * var decision = resolver.resolve('/path/to/project', {
 *     useProject: true,
 *     package:    '@rhinostone/swig',
 *     min:        '2.0.0'
 * });
 * if (decision.source === 'project') {
 *     var swig = require(decision.path);
 * } else {
 *     var swig = require('@rhinostone/swig');
 * }
 */

var fs       = require('fs');
var nodePath = require('path');

/**
 * Default npm package name resolved when `options.package` is omitted.
 *
 * @constant
 * @type {string}
 */
var DEFAULT_PACKAGE = '@rhinostone/swig';

/**
 * Framework floor — minimum project-pinned swig version the framework can
 * safely delegate to. Bump in the same commit that adds a framework
 * dependency on a new fork API.
 *
 * @constant
 * @type {string}
 */
var DEFAULT_MIN = '2.0.0';

/**
 * Known warning codes emitted by {@link resolve}. A non-null `warning` on the
 * decision record always pairs with `source: 'framework'` — the caller logs
 * it once at bundle startup.
 *
 * @typedef {'not-installed'|'package-json-not-found'|'malformed-package-json'|'missing-version'|'version-mismatch'} ResolverWarning
 */

/**
 * Shape returned by {@link resolve}.
 *
 * @typedef {Object} ResolverDecision
 * @property {'framework'|'project'}    source   Which copy the caller should load.
 * @property {string}                   package  The package name that was considered.
 * @property {string|null}              version  The resolved version string, or null when no project copy was read.
 * @property {string|null}              path     Absolute require path when `source === 'project'`; null otherwise.
 * @property {ResolverWarning|null}     warning  Reason the project copy was rejected, or null on success / when `useProject` was false.
 */

/**
 * @typedef {Object} ResolverOptions
 * @property {boolean} [useProject=false] Opt-in flag. When false (default),
 *                                        the resolver short-circuits to the
 *                                        framework copy without touching the
 *                                        filesystem.
 * @property {string}  [package]          Package name to look up.
 *                                        Defaults to {@link DEFAULT_PACKAGE}.
 * @property {string}  [min]              Minimum-version floor (same major
 *                                        required). Defaults to
 *                                        {@link DEFAULT_MIN}.
 */

/**
 * Strips a pre-release suffix (`1.6.0-alpha.2` → `1.6.0`) and splits into
 * `[major, minor, patch]`. Missing components default to `0`.
 *
 * @memberof module:gina/lib/swig-resolver
 * @param   {string} version
 * @returns {number[]} Three-element array.
 *
 * @example
 * splitVersion('1.6.2');        // [1, 6, 2]
 * splitVersion('2.0.0-alpha.8'); // [2, 0, 0]
 * splitVersion('1.6');           // [1, 6, 0]
 */
function splitVersion(version) {
    var core = String(version).split('-')[0].split('+')[0];
    var parts = core.split('.').map(function (n) {
        var v = parseInt(n, 10);
        return isNaN(v) ? 0 : v;
    });
    while (parts.length < 3) { parts.push(0); }
    return parts.slice(0, 3);
}

/**
 * Compares two version strings. Pre-release suffixes are ignored (an alpha
 * and its final are treated as equal — adequate for a runtime peer floor).
 *
 * @memberof module:gina/lib/swig-resolver
 * @param   {string} a
 * @param   {string} b
 * @returns {number} -1 when `a < b`, 0 when equal, 1 when `a > b`.
 *
 * @example
 * compareSemver('1.6.0', '1.6.2'); // -1
 * compareSemver('1.6.2', '1.6.2'); // 0
 * compareSemver('2.0.0', '1.9.9'); // 1
 */
function compareSemver(a, b) {
    var ap = splitVersion(a);
    var bp = splitVersion(b);
    for (var i = 0; i < 3; i++) {
        if (ap[i] !== bp[i]) { return ap[i] < bp[i] ? -1 : 1; }
    }
    return 0;
}

/**
 * True when `version` shares the major component with `min` **and** is
 * greater than or equal to `min` within that major.
 *
 * @memberof module:gina/lib/swig-resolver
 * @param   {string} version
 * @param   {string} min
 * @returns {boolean}
 *
 * @example
 * satisfiesMajorAndFloor('1.6.2', '1.6.0'); // true
 * satisfiesMajorAndFloor('1.5.0', '1.6.0'); // false (below floor)
 * satisfiesMajorAndFloor('2.0.0', '1.6.0'); // false (different major)
 */
function satisfiesMajorAndFloor(version, min) {
    var vp = splitVersion(version);
    var mp = splitVersion(min);
    if (vp[0] !== mp[0]) { return false; }
    return compareSemver(version, min) >= 0;
}

/**
 * Walks up from `startDir` looking for a `package.json` whose `name` field
 * matches `expectedName`. Returns the absolute path, or null when nothing
 * matched before the filesystem root.
 *
 * Needed because `require.resolve('@rhinostone/swig', { paths })` returns the
 * path to the package's `main` entry (e.g. `.../lib/index.js`), not to its
 * `package.json` — and the entry's directory is not guaranteed to contain
 * the manifest (monorepos frequently nest a `lib/` or `src/` level).
 *
 * @inner
 * @param  {string} startDir
 * @param  {string} expectedName
 * @returns {string|null}
 */
function findPackageJson(startDir, expectedName) {
    var dir = startDir;
    while (dir && dir !== nodePath.dirname(dir)) {
        var candidate = nodePath.join(dir, 'package.json');
        if (fs.existsSync(candidate)) {
            try {
                var pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                if (pkg && pkg.name === expectedName) { return candidate; }
            } catch (e) { /* malformed — keep walking */ }
        }
        dir = nodePath.dirname(dir);
    }
    return null;
}

/**
 * Resolves which swig copy a running bundle should load.
 *
 * Pure function: the only side effects are `fs.existsSync` and
 * `fs.readFileSync` against the project's `node_modules/`. Never `require()`s
 * the swig module itself — that stays the caller's responsibility so the
 * heavy template engine does not need to load during unit tests.
 *
 * @memberof module:gina/lib/swig-resolver
 * @param   {string|null|undefined} projectPath  Absolute path to the project root. When falsy, the resolver returns the framework decision immediately.
 * @param   {ResolverOptions}       [options]
 * @returns {ResolverDecision}
 *
 * @example <caption>Default (opt-out) — always framework</caption>
 * resolve('/srv/app', { useProject: false });
 * // { source: 'framework', package: '@rhinostone/swig', version: null, path: null, warning: null }
 *
 * @example <caption>Project has a satisfying pin</caption>
 * resolve('/srv/app', { useProject: true });
 * // { source: 'project', package: '@rhinostone/swig', version: '1.6.2', path: '/srv/app/node_modules/@rhinostone/swig/lib/index.js', warning: null }
 *
 * @example <caption>Project pins below the floor</caption>
 * resolve('/srv/app', { useProject: true, min: '1.6.0' });
 * // { source: 'framework', package: '@rhinostone/swig', version: '1.5.0', path: null, warning: 'version-mismatch' }
 */
function resolve(projectPath, options) {
    options = options || {};
    var pkgName    = options['package'] || DEFAULT_PACKAGE;
    var useProject = options.useProject === true;
    var min        = options.min || DEFAULT_MIN;

    var decision = {
        source:  'framework',
        'package': pkgName,
        version: null,
        path:    null,
        warning: null
    };

    if (!useProject || !projectPath) { return decision; }

    // Direct probe of <projectPath>/node_modules/<pkgName>/package.json. We
    // do this BEFORE require.resolve because Node's resolver parses the
    // manifest to pick `main` — a malformed manifest there throws
    // ERR_INVALID_PACKAGE_CONFIG, which would look identical to
    // MODULE_NOT_FOUND if we only relied on the resolver's error. Splitting
    // the concerns lets us surface an accurate warning code to the caller.
    var probedPkgJson = nodePath.join(projectPath, 'node_modules', pkgName, 'package.json');
    if (!fs.existsSync(probedPkgJson)) {
        decision.warning = 'not-installed';
        return decision;
    }

    var pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(probedPkgJson, 'utf8'));
    } catch (e) {
        decision.warning = 'malformed-package-json';
        return decision;
    }

    var entryPath;
    try {
        entryPath = require.resolve(pkgName, { paths: [projectPath] });
    } catch (e) {
        // Manifest parsed OK but the entry file is missing (broken install,
        // corrupted node_modules). Treat as not-installed — there is
        // nothing loadable even if the directory exists.
        decision.warning = 'not-installed';
        return decision;
    }

    // Belt and braces: the directly-read manifest is the source of truth
    // for the name/version checks below. findPackageJson is kept as a
    // safety net for monorepo layouts that may relocate the manifest.
    var pkgJsonPath = probedPkgJson;
    if (pkg.name !== pkgName) {
        pkgJsonPath = findPackageJson(nodePath.dirname(entryPath), pkgName);
        if (!pkgJsonPath) {
            decision.warning = 'package-json-not-found';
            return decision;
        }
        try {
            pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        } catch (e) {
            decision.warning = 'malformed-package-json';
            return decision;
        }
    }

    if (!pkg.version) {
        decision.warning = 'missing-version';
        return decision;
    }

    if (!satisfiesMajorAndFloor(pkg.version, min)) {
        decision.warning = 'version-mismatch';
        decision.version = pkg.version;
        return decision;
    }

    decision.source  = 'project';
    decision.version = pkg.version;
    decision.path    = entryPath;
    return decision;
}

/**
 * Resolves + loads the swig module for the running bundle. Idempotent within
 * a single process: the loaded module is cached on `process.gina._swig` so
 * that (a) repeated calls during bundle startup return the same instance and
 * (b) `controller.js` — which is re-required on every request in dev mode
 * via `refreshCoreDependencies()` — always sees the same swig reference
 * without re-running the resolver.
 *
 * Standalone-mode note: when multiple bundles share a process and disagree
 * on `swig.useProject`, the first caller to reach `load()` wins. A
 * subsequent caller with a different package/version will log a one-line
 * `[swig-resolver]` warning and keep the already-loaded copy. Split the
 * process (one bundle per port) if you need per-bundle swig isolation.
 *
 * @memberof module:gina/lib/swig-resolver
 * @param   {string|null|undefined} projectPath
 * @param   {ResolverOptions}       [options]
 * @returns {*} The loaded swig module (or whatever `require()` returned for the project package).
 *
 * @example
 * var swig = require('lib/swig-resolver').load('/srv/app', {
 *     useProject: true,
 *     package:    '@rhinostone/swig'
 * });
 * swig.setDefaults({ ... });
 */
function load(projectPath, options) {
    options = options || {};
    var pkgName = options['package'] || DEFAULT_PACKAGE;

    if (typeof process.gina === 'undefined' || process.gina === null) {
        process.gina = {};
    }

    if (process.gina._swig) {
        // Already loaded. Log a warning if the new caller disagrees on the
        // package name — that is the only shape of standalone-mode conflict
        // worth surfacing; version drift below the floor falls back to the
        // framework's copy, which is also what the first bundle got.
        if (process.gina._swigPackage && process.gina._swigPackage !== pkgName) {
            try {
                console.warn(
                    '[swig-resolver] second bundle requested ' + pkgName +
                    ' but ' + process.gina._swigPackage + ' is already loaded for this process; ignoring'
                );
            } catch (e) { /* console may be replaced mid-bootstrap */ }
        }
        return process.gina._swig;
    }

    var decision = resolve(projectPath, options);
    var swig;
    if (decision.source === 'project') {
        swig = require(decision.path);
    } else {
        swig = require(pkgName);
    }

    process.gina._swig            = swig;
    process.gina._swigDecision    = decision;
    process.gina._swigPackage     = pkgName;
    process.gina._swigProjectPath = projectPath || null;
    process.gina._swigOptions     = options;
    process.gina._swigMtime       = readProjectPkgMtime(projectPath, pkgName);

    if (decision.warning) {
        try {
            console.warn(
                '[swig-resolver] project override ignored (' + decision.warning + ')' +
                (decision.version ? ' — project pinned ' + decision.version : '') +
                '; using framework copy of ' + pkgName
            );
        } catch (e) { /* ignore console replacement races */ }
    } else if (decision.source === 'project') {
        try {
            console.log(
                '[swig-resolver] using project ' + pkgName + '@' + decision.version +
                ' from ' + decision.path
            );
        } catch (e) { /* ignore */ }
    }

    return swig;
}

/**
 * Returns the swig module cached by the most recent {@link load} call. When
 * called before `load()` (tests, early bootstrap paths), falls back to the
 * framework's default `require(DEFAULT_PACKAGE)` so callers never see null.
 * The first fallback is memoised on `process.gina._swig` — subsequent calls
 * return the same instance without re-requiring.
 *
 * @memberof module:gina/lib/swig-resolver
 * @returns {*}
 */
function get() {
    if (typeof process.gina === 'undefined' || process.gina === null) {
        process.gina = {};
    }
    // Dev-mode only: if the project's swig `package.json` mtime has drifted
    // since the last load() — e.g. after `npm install @rhinostone/swig@<newer>`
    // in the bundle's project — evict the cached module from require.cache
    // and re-run the resolver. No-op in production.
    refreshIfStale();
    if (!process.gina._swig) {
        process.gina._swig         = require(DEFAULT_PACKAGE);
        process.gina._swigDecision = {
            source:  'framework',
            'package': DEFAULT_PACKAGE,
            version: null,
            path:    null,
            warning: null
        };
        process.gina._swigPackage  = DEFAULT_PACKAGE;
    }
    return process.gina._swig;
}

/**
 * Reads the mtime of the project's swig package.json. Returns null when the
 * file does not exist, cannot be stat-ed, or when `projectPath` is falsy.
 * Cheap enough to call on every HTTP request in dev mode (single fs.stat).
 *
 * @inner
 * @param   {string|null} projectPath
 * @param   {string}      pkgName
 * @returns {number|null} mtimeMs or null.
 */
function readProjectPkgMtime(projectPath, pkgName) {
    if (!projectPath) { return null; }
    try {
        var pkgJson = nodePath.join(projectPath, 'node_modules', pkgName, 'package.json');
        return fs.statSync(pkgJson).mtimeMs;
    } catch (e) {
        return null;
    }
}

/**
 * Dev-mode hot-swap hook. Compares the current project-swig `package.json`
 * mtime against the value cached at the last `load()`. When they differ — or
 * when the file has appeared/disappeared — evicts the cached swig from
 * `require.cache`, clears the in-process cache, and re-runs `load()` with
 * the original options so the next access picks up the new version.
 *
 * No-op unless all of these hold:
 *   - `process.env.NODE_ENV_IS_DEV === 'true'`
 *   - A previous `load()` stashed `_swigOptions` + `_swigProjectPath`
 *   - `_swigOptions.useProject === true` (nothing to hot-swap otherwise)
 *
 * @inner
 */
function refreshIfStale() {
    if (process.env.NODE_ENV_IS_DEV !== 'true') { return; }

    var opts = process.gina._swigOptions;
    if (!opts || opts.useProject !== true) { return; }

    var projectPath = process.gina._swigProjectPath;
    if (!projectPath) { return; }

    var pkgName       = opts['package'] || DEFAULT_PACKAGE;
    var currentMtime  = readProjectPkgMtime(projectPath, pkgName);
    var previousMtime = process.gina._swigMtime;

    if (currentMtime === previousMtime) { return; }

    // Mtime drift (or file appeared/disappeared). Evict any cached project-
    // copy from require.cache so the next require() re-parses the new file.
    // Framework-copy decisions keep the framework require.cache entry — that
    // never goes stale across project-side reinstalls.
    var prev = process.gina._swigDecision;
    if (prev && prev.source === 'project' && prev.path) {
        try { delete require.cache[prev.path]; } catch (e) { /* ignore */ }
    }

    // Clear just enough state to force load() to re-enter; keep options and
    // projectPath so the next refresh uses the same parameters.
    delete process.gina._swig;
    delete process.gina._swigDecision;
    delete process.gina._swigPackage;

    load(projectPath, opts);
}

/**
 * Returns the decision record from the most recent {@link load} call, or a
 * framework-default record when nothing has been loaded yet. Exposed for
 * logging and test assertions.
 *
 * @memberof module:gina/lib/swig-resolver
 * @returns {ResolverDecision}
 */
function getDecision() {
    if (typeof process.gina === 'undefined' || !process.gina._swigDecision) {
        return {
            source:  'framework',
            'package': DEFAULT_PACKAGE,
            version: null,
            path:    null,
            warning: null
        };
    }
    return process.gina._swigDecision;
}

/**
 * Clears the cached swig module and decision. Intended for tests — callers
 * should never need this in production code.
 *
 * @memberof module:gina/lib/swig-resolver
 */
function reset() {
    if (typeof process.gina === 'object' && process.gina !== null) {
        delete process.gina._swig;
        delete process.gina._swigDecision;
        delete process.gina._swigPackage;
        delete process.gina._swigOptions;
        delete process.gina._swigProjectPath;
        delete process.gina._swigMtime;
    }
}

module.exports = {
    resolve:                resolve,
    load:                   load,
    get:                    get,
    getDecision:            getDecision,
    reset:                  reset,
    compareSemver:          compareSemver,
    satisfiesMajorAndFloor: satisfiesMajorAndFloor,
    splitVersion:           splitVersion,
    DEFAULT_PACKAGE:        DEFAULT_PACKAGE,
    DEFAULT_MIN:            DEFAULT_MIN
};
