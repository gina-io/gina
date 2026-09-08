/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/nunjucks-resolver
 *
 * Pure resolver that detects a project-installed `nunjucks` package and
 * caches the loaded module on `process.gina._nunjucks`. The framework never
 * depends on nunjucks — this library is opt-in via `settings.json >
 * render.engine === 'nunjucks'`. A bundle that opts in without installing
 * nunjucks in its project root fails loud at startup via
 * `load() → NUNJUCKS_NOT_INSTALLED`, not silently mid-render.
 *
 * Contrasts with `lib/swig-resolver`:
 *
 *  - **No framework fallback.** Swig is a framework `package.json` dep, so
 *    `lib/swig-resolver` can always fall back to the framework's bundled
 *    copy. Nunjucks is never declared in framework `package.json`, so the
 *    only source is `<projectPath>/node_modules/<pkg>/`. Not installed →
 *    hard error.
 *  - **No version floor.** The framework code never calls a nunjucks API
 *    directly (rendering lives in `controller.render-nunjucks.js`, which
 *    Gina controls). The user's version choice is the user's choice; we
 *    honour whatever they install.
 *  - **Same dev-mode hot-swap mechanism.** `get()` probes the project's
 *    `package.json` mtime on every call in dev mode and re-loads when
 *    drift is detected (`npm install nunjucks@<newer>` takes effect on
 *    the next request without a bundle restart).
 *
 * @example
 * var resolver = require('lib/nunjucks-resolver');
 * try {
 *     var nunjucks = resolver.load('/srv/app', { package: 'nunjucks' });
 * } catch (e) {
 *     if (e.code === 'NUNJUCKS_NOT_INSTALLED') {
 *         // Bundle misconfigured — log and fail.
 *     }
 *     throw e;
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
var DEFAULT_PACKAGE = 'nunjucks';

/**
 * Warning codes emitted by {@link resolve}. When `source === 'none'`, the
 * `warning` field names the reason — callers (`load()`, wiring code) use
 * this to decide whether to throw or log.
 *
 * @typedef {'not-installed'|'malformed-package-json'|'missing-version'} ResolverWarning
 */

/**
 * Shape returned by {@link resolve}.
 *
 * @typedef {Object} ResolverDecision
 * @property {'project'|'none'}     source   'project' iff nunjucks was found and parsed.
 * @property {string}               package  The package name that was considered.
 * @property {string|null}          version  Parsed version string when `source === 'project'`.
 * @property {string|null}          path     Absolute require path when `source === 'project'`.
 * @property {ResolverWarning|null} warning  Reason the project copy was unusable, or null on success.
 */

/**
 * @typedef {Object} ResolverOptions
 * @property {string} [package] Package name to look up. Defaults to {@link DEFAULT_PACKAGE}.
 */

/**
 * Walks up from `startDir` looking for a `package.json` whose `name` field
 * matches `expectedName`. Returns the absolute path, or null when nothing
 * matched before the filesystem root.
 *
 * `require.resolve('nunjucks', { paths })` returns the path to the package's
 * `main` entry — not to its `package.json`. For most packages the manifest
 * is in the parent of `main`, but monorepo layouts can nest; this helper
 * keeps us robust.
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
 * Resolves whether the project at `projectPath` has a usable nunjucks
 * installation. Pure — no `require()` of the target module, no cache.
 * Filesystem reads only against `<projectPath>/node_modules/<pkg>/`.
 *
 * @memberof module:gina/lib/nunjucks-resolver
 * @param   {string|null|undefined} projectPath
 * @param   {ResolverOptions}       [options]
 * @returns {ResolverDecision}
 *
 * @example <caption>Installed</caption>
 * resolve('/srv/app');
 * // { source: 'project', package: 'nunjucks', version: '3.2.4', path: '/srv/app/node_modules/nunjucks/index.js', warning: null }
 *
 * @example <caption>Not installed</caption>
 * resolve('/srv/app');
 * // { source: 'none', package: 'nunjucks', version: null, path: null, warning: 'not-installed' }
 */
function resolve(projectPath, options) {
    options = options || {};
    var pkgName = options['package'] || DEFAULT_PACKAGE;

    var decision = {
        source:  'none',
        'package': pkgName,
        version: null,
        path:    null,
        warning: null
    };

    if (!projectPath) {
        decision.warning = 'not-installed';
        return decision;
    }

    // Probe package.json directly before require.resolve so we can tell
    // 'not installed' apart from 'malformed package config' — Node's
    // resolver throws ERR_INVALID_PACKAGE_CONFIG on the latter, which is
    // indistinguishable from MODULE_NOT_FOUND to the caller otherwise.
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
        // Manifest parsed OK but entry file is missing (broken install,
        // corrupted node_modules). Treat as not-installed — nothing
        // loadable even if the directory exists.
        decision.warning = 'not-installed';
        return decision;
    }

    var pkgJsonPath = probedPkgJson;
    if (pkg.name !== pkgName) {
        // Monorepo safety net — walk up from the resolved entry to find
        // the manifest whose name matches.
        pkgJsonPath = findPackageJson(nodePath.dirname(entryPath), pkgName);
        if (!pkgJsonPath) {
            decision.warning = 'malformed-package-json';
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

    decision.source  = 'project';
    decision.version = pkg.version;
    decision.path    = entryPath;
    return decision;
}

/**
 * Resolves nunjucks + `require()`s the module + caches on
 * `process.gina._nunjucks`. First call per process actually loads; later
 * calls return the cached instance unless the project's `package.json`
 * mtime has drifted (dev mode hot-swap — see {@link refreshIfStale}).
 *
 * Hard error on misconfiguration: when the project does not have nunjucks
 * installed, `load()` throws an Error with `code: 'NUNJUCKS_NOT_INSTALLED'`
 * and the decision record attached. Bundles that opt into nunjucks are
 * expected to either install it or flip the `render.engine` setting back
 * to `"swig"`; silently rendering with a stub would mask the error.
 *
 * @memberof module:gina/lib/nunjucks-resolver
 * @param   {string|null|undefined} projectPath
 * @param   {ResolverOptions}       [options]
 * @returns {*} The loaded nunjucks module.
 * @throws  {Error} `code: 'NUNJUCKS_NOT_INSTALLED'` with `decision` attached.
 *
 * @example
 * try {
 *     var nunjucks = resolver.load('/srv/app');
 * } catch (e) {
 *     if (e.code === 'NUNJUCKS_NOT_INSTALLED') {
 *         console.error('Run npm install nunjucks in ' + projectPath);
 *         process.exit(1);
 *     }
 *     throw e;
 * }
 */
function load(projectPath, options) {
    options = options || {};
    var pkgName = options['package'] || DEFAULT_PACKAGE;

    if (typeof process.gina === 'undefined' || process.gina === null) {
        process.gina = {};
    }

    if (process.gina._nunjucks) {
        // Already loaded; log a warning on package-name conflict.
        if (process.gina._nunjucksPackage && process.gina._nunjucksPackage !== pkgName) {
            try {
                console.warn(
                    '[nunjucks-resolver] second bundle requested ' + pkgName +
                    ' but ' + process.gina._nunjucksPackage + ' is already loaded for this process; ignoring'
                );
            } catch (e) { /* console may be replaced mid-bootstrap */ }
        }
        return process.gina._nunjucks;
    }

    var decision = resolve(projectPath, options);
    if (decision.source !== 'project') {
        var err = new Error(
            '[nunjucks-resolver] ' + pkgName + ' not available' +
            (decision.warning ? ' (' + decision.warning + ')' : '') +
            (projectPath ? '; expected at ' + nodePath.join(projectPath, 'node_modules', pkgName) : '') +
            '. Install it in the project root: cd ' + (projectPath || '<project>') + ' && npm install ' + pkgName
        );
        err.code     = 'NUNJUCKS_NOT_INSTALLED';
        err.decision = decision;
        throw err;
    }

    var nunjucks = require(decision.path);
    process.gina._nunjucks            = nunjucks;
    process.gina._nunjucksDecision    = decision;
    process.gina._nunjucksPackage     = pkgName;
    process.gina._nunjucksProjectPath = projectPath || null;
    process.gina._nunjucksOptions     = options;
    process.gina._nunjucksMtime       = readProjectPkgMtime(projectPath, pkgName);

    try {
        console.log(
            '[nunjucks-resolver] using project ' + pkgName + '@' + decision.version +
            ' from ' + decision.path
        );
    } catch (e) { /* ignore */ }

    return nunjucks;
}

/**
 * Returns the cached nunjucks module. Throws when no `load()` has
 * succeeded. Unlike `lib/swig-resolver.get()`, there is no framework
 * fallback — nunjucks is opt-in; calling `get()` without a prior `load()`
 * is a programming error (usually: wiring code forgot to call `load()`
 * during bundle startup).
 *
 * In dev mode (`NODE_ENV_IS_DEV === 'true'`), probes the project's
 * `package.json` mtime on every call; when drift is detected, evicts the
 * cached module from `require.cache` and re-runs `load()` with the
 * original options. Zero cost in production (single env check).
 *
 * @memberof module:gina/lib/nunjucks-resolver
 * @returns {*} The loaded nunjucks module.
 * @throws  {Error} When no `load()` has succeeded yet for this process.
 */
function get() {
    if (typeof process.gina === 'undefined' || process.gina === null) {
        process.gina = {};
    }
    // Dev-mode hot-swap — runs before the cache read so a just-bumped
    // project version takes effect on the next request without restart.
    refreshIfStale();
    if (!process.gina._nunjucks) {
        throw new Error(
            '[nunjucks-resolver] get() called before load() succeeded. ' +
            'Bundle startup must call nunjucksResolver.load(executionPath, settings) ' +
            'before render-nunjucks tries to access the engine.'
        );
    }
    return process.gina._nunjucks;
}

/**
 * Returns the decision record from the last `load()`, or a
 * source='none' / warning=null record when nothing has been loaded.
 *
 * @memberof module:gina/lib/nunjucks-resolver
 * @returns {ResolverDecision}
 */
function getDecision() {
    if (typeof process.gina === 'undefined' || !process.gina._nunjucksDecision) {
        return {
            source:  'none',
            'package': DEFAULT_PACKAGE,
            version: null,
            path:    null,
            warning: null
        };
    }
    return process.gina._nunjucksDecision;
}

/**
 * Clears the cached nunjucks module and all associated state on
 * `process.gina._nunjucks*`. Intended for tests — production code never
 * needs this.
 *
 * @memberof module:gina/lib/nunjucks-resolver
 */
function reset() {
    if (typeof process.gina === 'object' && process.gina !== null) {
        delete process.gina._nunjucks;
        delete process.gina._nunjucksDecision;
        delete process.gina._nunjucksPackage;
        delete process.gina._nunjucksProjectPath;
        delete process.gina._nunjucksOptions;
        delete process.gina._nunjucksMtime;
    }
}

/**
 * Reads the mtime of the project's nunjucks `package.json`. Returns null
 * when the file does not exist, cannot be stat-ed, or when `projectPath`
 * is falsy. Cheap enough to call per-request in dev mode.
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
 * Dev-mode hot-swap. When `NODE_ENV_IS_DEV === 'true'` and the project's
 * nunjucks `package.json` mtime has drifted since the last `load()`,
 * evicts the cached module from `require.cache`, clears the in-process
 * state, and re-runs `load()` with the stashed options so the next access
 * picks up the new version.
 *
 * @inner
 */
function refreshIfStale() {
    if (process.env.NODE_ENV_IS_DEV !== 'true') { return; }

    var opts = process.gina._nunjucksOptions;
    if (!opts) { return; }

    var projectPath = process.gina._nunjucksProjectPath;
    if (!projectPath) { return; }

    var pkgName       = opts['package'] || DEFAULT_PACKAGE;
    var currentMtime  = readProjectPkgMtime(projectPath, pkgName);
    var previousMtime = process.gina._nunjucksMtime;

    if (currentMtime === previousMtime) { return; }

    var prev = process.gina._nunjucksDecision;
    if (prev && prev.path) {
        try { delete require.cache[prev.path]; } catch (e) { /* ignore */ }
    }

    // Clear just the cache-state fields; keep options + projectPath so
    // the next refresh uses the same parameters.
    delete process.gina._nunjucks;
    delete process.gina._nunjucksDecision;
    delete process.gina._nunjucksPackage;

    // Re-run load(). If nunjucks was uninstalled between the last load()
    // and now, this throws NUNJUCKS_NOT_INSTALLED — caller's
    // responsibility to surface it. In dev mode that surfaces as a red
    // render-error page on the next request, which is the correct signal.
    load(projectPath, opts);
}

module.exports = {
    resolve:         resolve,
    load:            load,
    get:             get,
    getDecision:     getDecision,
    reset:           reset,
    DEFAULT_PACKAGE: DEFAULT_PACKAGE
};
