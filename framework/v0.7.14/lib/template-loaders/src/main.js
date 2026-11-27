/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/template-loaders
 * @description Registry + factory for gina's async template-loader extension
 * point (`settings.template.<engine>.loader`). Builds a built-in loader from
 * its flat config — a named `type` plus type-specific keys, mirroring the
 * `connectors.json` convention — and wraps it with a CVE-2023-25345
 * segment-safety guard applied on EVERY `resolve()`, covering the whole
 * transitive extends/include chain (stronger than a first-hop-only guard).
 *
 * Ships two built-ins: `memory` (inline templates, no network) and `http`
 * (HTTP(S)-fetch from a configured origin + basePath, with a TTL'd source cache
 * and opt-in ETag revalidation). A custom project-supplied loader hook lands in
 * a later slice.
 *
 * @package gina.framework
 */

/**
 * Built-in loader factories keyed by `type`. Grows one entry per slice.
 *
 * @constant
 * @inner
 * @type {Object.<string, function>}
 */
var BUILTINS = {
    memory: require('./loaders/memory'),
    http:   require('./loaders/http')
};

/**
 * Assert a template identifier is segment-safe: not absolute and free of any
 * parent-traversal (`..`) segment. Runs on every `resolve()` so it guards the
 * full transitive extends/include chain, not just the first hop
 * (CVE-2023-25345).
 *
 * @inner
 * @param {string} id - Template identifier requested by the engine
 * @returns {void}
 * @throws {Error} When `id` is empty/non-string, absolute, or contains a `..` segment
 */
function assertSafeIdentifier(id) {
    if (typeof id !== 'string' || id === '') {
        throw new Error('[template-loader] invalid template identifier: ' + JSON.stringify(id));
    }
    if (id.charAt(0) === '/' || id.charAt(0) === '\\') {
        throw new Error('[template-loader] absolute template path rejected: ' + id);
    }
    var segs = id.split(/[\\/]/);
    for (var i = 0; i < segs.length; i++) {
        if (segs[i] === '..') {
            throw new Error('[CVE-2023-25345] template path traversal blocked: ' + id);
        }
    }
}

/**
 * Wrap a built-in (or, later, user-supplied) loader with the gina CVE
 * segment-guard. The guard runs inside `resolve()`; `load` is re-exposed via
 * `.bind()` so its `.length` (arity) is preserved — swig's `getTemplate()`
 * uses `load.length >= 2` to choose the callback load path, so a wrapper that
 * dropped the arity would silently break async loading.
 *
 * @inner
 * @param {object} inner - Loader exposing `resolve(to, from)` + `load(id, cb)` [+ `async`]
 * @returns {{async: boolean, resolve: function, load: function}} Guarded loader
 * @throws {Error} When `inner` does not expose both `resolve()` and `load()`
 */
function wrapWithGuard(inner) {
    if (!inner || typeof inner.resolve !== 'function' || typeof inner.load !== 'function') {
        throw new Error('[template-loader] loader must expose resolve(to, from) and load(identifier, cb)');
    }
    return {
        async: inner.async === true,
        resolve: function (to, from) {
            assertSafeIdentifier(to);
            return inner.resolve(to, from);
        },
        // .bind() preserves load.length (arity) — load-bearing for swig's
        // callback-vs-sync load dispatch.
        load: inner.load.bind(inner)
    };
}

/**
 * Build a guarded async loader from its bundle config, or return `null` when
 * no loader is configured. Throws on a bad config so the caller
 * (`initSwigEngine`) can let it propagate and fail bundle startup fast — the
 * same fail-fast contract as `initNunjucksEngine`/`NUNJUCKS_NOT_INSTALLED`.
 *
 * @param {?object} [cfg]    - `settings.template.<engine>.loader` (absent -> null)
 * @param {string}  cfg.type - Built-in loader name (`"memory"` | `"http"`)
 * @param {object}  [ctx]    - Build context (`{ bundle }`) forwarded to the built-in factory for cache-key namespacing
 * @returns {?{async: boolean, resolve: function, load: function}} Guarded loader, or null when `cfg` is absent
 * @throws {Error} On unknown `type`, a loader missing `resolve`/`load`, or a built-in's own config error
 *
 * @example
 * var loader = lib.templateLoaders.build({ type: 'memory', templates: { 'a.html': 'hi' } });
 * // loader.async === true
 * var remote = lib.templateLoaders.build({ type: 'http', origin: 'https://cdn.example.com' }, { bundle: 'site' });
 */
function build(cfg, ctx) {
    if (cfg === null || typeof cfg !== 'object') {
        return null;
    }
    var type = cfg.type;
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(BUILTINS, type)) {
        throw new Error(
            '[template-loader] unknown loader type ' + JSON.stringify(type) +
            ' - expected one of: ' + Object.keys(BUILTINS).join(', ')
        );
    }
    // The built-in factory validates its own flat config and throws on a bad
    // shape; we let that propagate (fail-fast at bundle startup). `ctx` (e.g.
    // `{ bundle }`) is forwarded for built-ins that namespace by bundle (the
    // http source cache); built-ins that don't need it (memory) ignore it.
    var inner = BUILTINS[type](cfg, ctx);
    return wrapWithGuard(inner);
}

module.exports = {
    build: build,
    // Exposed for unit tests and future-slice built-in registration.
    BUILTINS: BUILTINS,
    assertSafeIdentifier: assertSafeIdentifier,
    wrapWithGuard: wrapWithGuard
};
