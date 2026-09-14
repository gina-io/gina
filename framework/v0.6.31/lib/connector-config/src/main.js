/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/lib/connector-config
 *
 * Pure connector-entry resolver shared by the `connector:*` runtime CLI
 * commands (`connector:infer`, and any future sibling such as a connectivity
 * probe). Given the already-parsed `connectors.json` objects for a project's
 * shared dir and (optionally) one bundle, it merges them — bundle winning on a
 * key collision, mirroring the runtime precedence in `core/config.js` — and
 * selects a single connector entry by name, reporting which layer it came from.
 *
 * Pure module: requires no node builtins, does not require `lib.*`, and reads
 * no framework globals (`_`, `requireJSON`, `GINA_*`). The CALLER does the file
 * I/O (via the comment-tolerant `requireJSON`, as `connector:list` does) and
 * passes the parsed objects in, so the module is unit-testable by a direct
 * `require`. Same contract as `lib/connector-registry` and `lib/cmd-status-format`.
 *
 * The selected entry is always a FRESH DEEP COPY (never an alias of the input
 * JSON at any nesting level), so the caller may resolve `${secret:KEY}`
 * placeholders on it in place — `lib.secrets.resolve(entry)` mutates its
 * argument, recursing into nested objects — without poisoning the `requireJSON`
 * cache the parsed JSON came from.
 *
 * @example
 * var cfg    = lib.connectorConfig;
 * var shared = requireJSON(_(project.path + '/shared/config/connectors.json', true));
 * var bundle = requireJSON(_(project.path + '/' + src + '/config/connectors.json', true));
 * var res    = cfg.resolve(shared, bundle, 'claude'); // { entry, source }
 * if (res.entry && cfg.isAIConnector(res.entry, 'claude')) { ... }
 */

/**
 * Plain-object test (rejects `null` and arrays).
 *
 * @inner
 * @private
 * @param {*} v
 * @returns {boolean}
 */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-clone a plain-object or array value; primitives (and any non-plain
 * object such as `null`) are returned as-is. Recurses so no nested object or
 * array is shared by reference with the input.
 *
 * @inner
 * @private
 * @param {*} v
 * @returns {*}
 */
function deepCloneValue(v) {
    if (Array.isArray(v)) {
        var arr = [];
        for (var i = 0; i < v.length; i++) { arr[i] = deepCloneValue(v[i]); }
        return arr;
    }
    if (isPlainObject(v)) {
        var obj = {};
        for (var ok in v) {
            if (Object.prototype.hasOwnProperty.call(v, ok)) { obj[ok] = deepCloneValue(v[ok]); }
        }
        return obj;
    }
    return v;
}

/**
 * Deep-copy a connector entry into a fresh object — every nested object / array
 * is a fresh copy, never an alias of the input JSON. A non-plain-object input
 * (a malformed `connectors.json` value) is returned unchanged — the caller's
 * {@link isAIConnector} guard rejects it downstream. The deep copy lets the
 * caller resolve `${secret:KEY}` placeholders on the entry in place (which
 * recurses into nested values) without mutating the `requireJSON` cache.
 *
 * @inner
 * @private
 * @param {*} entry
 * @returns {*} A new deep-cloned object when `entry` is a plain object; otherwise `entry`.
 */
function cloneEntry(entry) {
    if (!isPlainObject(entry)) {
        return entry;
    }
    return deepCloneValue(entry);
}

/**
 * Deep-merge two connector entries into a fresh object, `bundle` winning on a
 * key collision — the same precedence the runtime applies in `core/config.js`
 * (a bundle `connectors.json` overrides the shared one). Every value is a fresh
 * deep copy, so no nested object / array is shared with either input. When
 * either side is not a plain object, the plain-object side is returned (cloned).
 *
 * @inner
 * @private
 * @param {*} shared - The shared-dir entry.
 * @param {*} bundle - The bundle entry (wins on collision).
 * @returns {*} A new deep-merged object.
 */
function mergeEntry(shared, bundle) {
    if (!isPlainObject(shared)) { return cloneEntry(bundle); }
    if (!isPlainObject(bundle)) { return cloneEntry(shared); }
    var out = {};
    var k;
    for (k in shared) {
        if (Object.prototype.hasOwnProperty.call(shared, k)) { out[k] = deepCloneValue(shared[k]); }
    }
    for (k in bundle) {
        if (Object.prototype.hasOwnProperty.call(bundle, k)) { out[k] = deepCloneValue(bundle[k]); }
    }
    return out;
}

/**
 * @typedef {object} ResolvedConnector
 * @property {?object} entry  - The selected connector entry (a fresh object), or
 *                              `null` when `name` is present in neither layer.
 * @property {?string} source - `'shared'`, `'bundle'`, `'merged'` (present in
 *                              both — bundle overrides shared), or `null` when
 *                              not found.
 */

/**
 * Select one connector entry by name from a project's shared and (optional)
 * bundle `connectors.json` maps, merging when the same name appears in both.
 *
 * The reserved `$schema` key is never selectable — `resolve(shared, bundle,
 * '$schema')` returns `{ entry: null, source: null }`.
 *
 * @memberof module:gina/lib/connector-config
 * @function resolve
 * @param {?object} sharedJson - Parsed `shared/config/connectors.json` (or null / `{}`).
 * @param {?object} bundleJson - Parsed `<bundle>/config/connectors.json` (or null / `{}` when no bundle was targeted).
 * @param {string}  name       - The connector key to select.
 * @returns {ResolvedConnector}
 *
 * @example
 * resolve({ db: {} }, { db: {} }, 'db');     // { entry: <merged>, source: 'merged' }
 * resolve({}, { local: {} }, 'local');       // { entry: <clone>,  source: 'bundle' }
 * resolve({ claude: {} }, null, 'claude');   // { entry: <clone>,  source: 'shared' }
 * resolve({}, {}, 'missing');                // { entry: null,     source: null }
 */
function resolve(sharedJson, bundleJson, name) {
    var shared = isPlainObject(sharedJson) ? sharedJson : {};
    var bundle = isPlainObject(bundleJson) ? bundleJson : {};

    if (name === '$schema') {
        return { entry: null, source: null };
    }

    var inShared = Object.prototype.hasOwnProperty.call(shared, name);
    var inBundle = Object.prototype.hasOwnProperty.call(bundle, name);

    if (!inShared && !inBundle) { return { entry: null, source: null }; }
    if (inShared && inBundle)   { return { entry: mergeEntry(shared[name], bundle[name]), source: 'merged' }; }
    if (inBundle)               { return { entry: cloneEntry(bundle[name]), source: 'bundle' }; }
    return { entry: cloneEntry(shared[name]), source: 'shared' };
}

/**
 * True when `entry` is an AI connector. Its `connector` field is `'ai'`, OR —
 * when the entry has no `connector` field — its logical `key` is `'ai'`. The
 * key-fallback (`entry.connector || key`) mirrors how `connector:list` /
 * `connector:test` resolve a connector's type, so an entry written by
 * `connector:add` as just `"ai": { ... }` (name === type ⇒ no `connector`
 * field) is recognised. Passing no `key` keeps the strict `connector === 'ai'`
 * behaviour. The AI-specific `infer()` / `stream()` surface only exists for
 * this subtype, so `connector:infer` rejects anything else.
 *
 * @memberof module:gina/lib/connector-config
 * @function isAIConnector
 * @param {*} entry - A connector entry (or anything).
 * @param {string} [key] - The connector's logical key, used as the type when
 *                         the entry has no explicit `connector` field.
 * @returns {boolean}
 *
 * @example
 * isAIConnector({ connector: 'ai', protocol: 'ollama://' }); // true
 * isAIConnector({ connector: 'mysql' });                     // false
 * isAIConnector({ protocol: 'ollama://' }, 'ai');            // true  (key fallback)
 * isAIConnector({ protocol: 'ollama://' });                  // false (no key, no connector field)
 * isAIConnector(null);                                       // false
 */
function isAIConnector(entry, key) {
    return !!(isPlainObject(entry) && ((entry.connector || key) === 'ai'));
}

module.exports = {
    resolve: resolve,
    isAIConnector: isAIConnector
};
