'use strict';
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/secrets
 * @description Substitutes `${secret:KEY}` placeholders in a merged bundle
 * config tree at config-load time. The default backend resolves keys from
 * the framework environment tier then `process.env`; `selectBackend` adds
 * the declared-file tier (`settings.secrets.file`) or the exec-bridge tier
 * (`settings.secrets.exec` — mutually exclusive with `file`, both layered
 * UNDER the environment). The module also owns
 * the shared config-source walk (`getProjectRequiredKeys`, from ./sources)
 * that the `secrets:scan` / `secrets:check` CLIs enumerate keys with.
 *
 * **Syntax.** `${secret:KEY}` where `KEY` matches `^[A-Z_][A-Z0-9_]*$`.
 * The placeholder must be the entire JSON string value — mixed-content
 * strings like `'prefix-${secret:K}-suffix'` are passed through unchanged
 * (no substitution attempted).
 *
 * **Timing.** Runs once per bundle slice during `loadBundleConfig`,
 * mutating the merged config object in place. Subsequent reads see the
 * resolved values; no dynamic re-resolution.
 *
 * **Fail-closed.** Unset / empty backend values cause the backend to
 * throw `Error('Secret resolution failed')`. The error message does NOT
 * include the key name.
 *
 * **Path tracking.** The dotted paths that were substituted are recorded
 * in an internal `WeakMap`; callers can retrieve them via
 * `getResolvedPaths(config)`.
 *
 * Scope of that hook, measured (#B274) — it is NOT a general redaction
 * substrate, and in particular it cannot serve the Inspector. Two reasons,
 * either sufficient: the paths address the config object itself, while the
 * Inspector redacts a payload built from the controller's VIEW data
 * (`{gina, user}`), a different coordinate space in which `db.password`
 * names nothing; and the lookup is keyed on object IDENTITY, while that
 * payload is a `JSON.parse(JSON.stringify(...))` clone, so the WeakMap
 * returns `[]` for it by construction. Redacting a surface that holds
 * VALUES rather than the config needs a value-based pass — see
 * `core/connectors/param-redact.js`, built for exactly that reason.
 *
 * **Introspection.** `getRequiredKeys(config)` enumerates the placeholder
 * keys a config requires without resolving them — read-only and
 * non-throwing. It backs the `gina secrets:scan` / `secrets:check` CLI.
 *
 * @example
 * var secrets = lib.secrets;
 * process.env.DB_PASSWORD = 's3cret';
 * var conf = { db: { password: '${secret:DB_PASSWORD}' }, db_host: 'localhost' };
 * secrets.resolve(conf);
 * conf.db.password;                  // → 's3cret'
 * secrets.getResolvedPaths(conf);    // → ['db.password']
 *
 * @example
 * // Fail-closed when env var is missing:
 * delete process.env.MISSING;
 * try {
 *     secrets.resolve({ a: '${secret:MISSING}' });
 * } catch (e) {
 *     e.message;   // 'Secret resolution failed'
 * }
 */

var defaultBackend = require('./backends/env');
var fileBackend    = require('./backends/file');
var execBackend    = require('./backends/exec');
var envFile        = require('./env-file');
// Declaration validation is shared with the secrets:check CLI gate (#B408) —
// pure and require-free, so it adds nothing to the zero-setup load path.
var declaration    = require('./declaration');
// The config-source walk (./sources) is a FACTORY over this module's own
// getRequiredKeys — instantiated here, at the composition root, so the two
// files never require each other in a cycle. `getRequiredKeys` is a hoisted
// function declaration, so passing it above its definition is safe.
var sources        = require('./sources')(getRequiredKeys);

/**
 * Regex matching an entire `${secret:KEY}` placeholder. The capture group
 * is the key name. Anchored on both ends — embedded placeholders inside
 * longer strings do not match.
 *
 * @constant {RegExp} SECRET_RE
 * @memberof module:lib/secrets
 */
var SECRET_RE = /^\${secret:([A-Z_][A-Z0-9_]*)\}$/;

/**
 * Internal map of resolved-config object → array of dotted paths that
 * were substituted during the walk. `WeakMap` so entries are GC'd with
 * their config object.
 *
 * @inner
 * @private
 * @type {WeakMap<object, string[]>}
 */
var _resolvedPathsByConfig = new WeakMap();

/**
 * Walk `node` recursively, substituting any string value that matches
 * `SECRET_RE` in place. Records substituted dotted paths into `paths`.
 * Mixed-content strings pass through unchanged.
 *
 * @inner
 * @private
 * @param {*}        node        - Current subtree (object, array, or scalar)
 * @param {string[]} paths       - Mutable array of substituted dotted paths
 * @param {string}   currentPath - Dotted path of `node` from the walk root
 * @param {object}   backend     - Backend with `resolve(key) → string`
 * @returns {void}
 * @throws {Error} Propagates backend resolution errors
 */
function walkAndResolve(node, paths, currentPath, backend) {
    if (node === null || typeof node !== 'object') {
        return;
    }
    if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
            var elementPath = currentPath + '[' + i + ']';
            if (typeof node[i] === 'string') {
                var match = node[i].match(SECRET_RE);
                if (match) {
                    node[i] = backend.resolve(match[1]);
                    paths.push(elementPath);
                }
            } else if (node[i] !== null && typeof node[i] === 'object') {
                walkAndResolve(node[i], paths, elementPath, backend);
            }
        }
        return;
    }
    for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) {
            continue;
        }
        var keyPath = currentPath ? (currentPath + '.' + key) : key;
        if (typeof node[key] === 'string') {
            var keyMatch = node[key].match(SECRET_RE);
            if (keyMatch) {
                node[key] = backend.resolve(keyMatch[1]);
                paths.push(keyPath);
            }
        } else if (node[key] !== null && typeof node[key] === 'object') {
            walkAndResolve(node[key], paths, keyPath, backend);
        }
    }
}

/**
 * Walk `node` recursively, collecting the KEY of every string value that
 * matches `SECRET_RE` into `keys`. Unlike `walkAndResolve`, this never
 * calls a backend and never mutates `node` — it only enumerates the
 * placeholder keys present, so it cannot throw on unset / empty values.
 * Mixed-content strings (`'prefix-${secret:K}-suffix'`) do not match,
 * exactly as `walkAndResolve` leaves them untouched.
 *
 * @inner
 * @private
 * @param {*}      node - Current subtree (object, array, or scalar)
 * @param {object} keys - Mutable null-proto set; each required key name maps to `true`
 * @returns {void}
 */
function walkAndCollect(node, keys) {
    if (node === null || typeof node !== 'object') {
        return;
    }
    if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
            if (typeof node[i] === 'string') {
                var match = node[i].match(SECRET_RE);
                if (match) {
                    keys[match[1]] = true;
                }
            } else if (node[i] !== null && typeof node[i] === 'object') {
                walkAndCollect(node[i], keys);
            }
        }
        return;
    }
    for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) {
            continue;
        }
        if (typeof node[key] === 'string') {
            var keyMatch = node[key].match(SECRET_RE);
            if (keyMatch) {
                keys[keyMatch[1]] = true;
            }
        } else if (node[key] !== null && typeof node[key] === 'object') {
            walkAndCollect(node[key], keys);
        }
    }
}

/**
 * Resolve all `${secret:KEY}` placeholders in `config` in place. Returns
 * the same `config` reference (for chaining).
 *
 * Walks every object key and array element; replaces any string value
 * matching `^\${secret:KEY\}$` with the value returned by `backend.resolve(KEY)`.
 * Substitution is one-pass — placeholders inside already-resolved values
 * are NOT re-walked. Mixed-content strings (`'prefix-${secret:K}-suffix'`)
 * return unchanged.
 *
 * @memberof module:lib/secrets
 * @function resolve
 * @param {object|Array} config    - The merged bundle config object to walk in place
 * @param {object}       [backend] - Optional backend override. Defaults to the env-var backend.
 * @param {function}     backend.resolve - `function(key) ⇒ string`. Throws on failure.
 * @returns {object|Array|*} The same `config` reference (mutated in place). Non-object inputs return unchanged.
 * @throws {Error} `'Secret resolution failed'` if any placeholder cannot be resolved
 *
 * @example
 * var secrets = lib.secrets;
 * process.env.API_KEY = 'abc';
 * secrets.resolve({ api: { key: '${secret:API_KEY}' } });
 * // → { api: { key: 'abc' } }
 *
 * @example
 * // Custom backend (test fixture or future plug-in shape):
 * secrets.resolve(conf, {
 *     resolve: function(key) {
 *         if (key === 'TEST') return 'value';
 *         throw new Error('Secret resolution failed');
 *     }
 * });
 */
function resolve(config, backend) {
    if (config === null || typeof config !== 'object') {
        return config;
    }
    var paths = [];
    walkAndResolve(config, paths, '', backend || defaultBackend);
    if (paths.length > 0) {
        _resolvedPathsByConfig.set(config, paths);
    }
    return config;
}

/**
 * Return the dotted paths that were substituted in `config` during the
 * most recent `resolve(config)` call, so a caller holding that config can
 * tell which of its fields originated as secrets.
 *
 * Paths use dotted notation for object keys (`'db.password'`) and
 * bracketed indices for array elements (`'items[0]'`).
 *
 * The lookup is keyed on the IDENTITY of `config` (#B274), so a caller must
 * pass the very object `resolve()` mutated — a structural clone returns `[]`.
 * The paths likewise address that object and no other, which is why this is
 * not a redaction hook for downstream payloads; see the module note above.
 *
 * @memberof module:lib/secrets
 * @function getResolvedPaths
 * @param {object|Array} config - The resolved config object
 * @returns {string[]} Array of substituted dotted paths. Empty if none.
 *
 * @example
 * var conf = { db: { password: '${secret:DB_PASSWORD}' }, items: ['${secret:A}', 'literal'] };
 * process.env.DB_PASSWORD = 'pw';
 * process.env.A = 'va';
 * secrets.resolve(conf);
 * secrets.getResolvedPaths(conf); // → ['db.password', 'items[0]']
 */
function getResolvedPaths(config) {
    if (config === null || typeof config !== 'object') {
        return [];
    }
    return _resolvedPathsByConfig.get(config) || [];
}

/**
 * Read the value now sitting at one dotted path recorded by `resolve()`
 * (`db.password`, `items[0]`, `a.b[2].c`).
 *
 * @inner
 * @private
 * @param {object} config - The walked config object
 * @param {string} dotted - A path in `getResolvedPaths()`'s notation
 * @returns {*} The value, or `undefined` when the path no longer resolves
 */
function readPath(config, dotted) {
    var node = config;
    var re   = /([^.\[\]]+)|\[(\d+)\]/g;
    var m;
    while ((m = re.exec(dotted)) !== null) {
        if (node === null || typeof node !== 'object') {
            return undefined;
        }
        node = node[ typeof m[2] !== 'undefined' ? Number(m[2]) : m[1] ];
    }
    return node;
}

/**
 * Return every `${secret:KEY}` substitution `resolve()` performed on
 * `config`, as `{ path, value }` pairs — the values as they now sit in the
 * config. Backs the log-redaction seam (#B433): the logger masks these values
 * verbatim wherever they appear in a log line, so a connection string or a
 * misconfigured connector never prints a secret. Must be called with the
 * SAME object `resolve()` walked (the record is keyed by identity).
 *
 * @memberof module:lib/secrets
 * @function getResolvedValues
 * @param {object} config - The config object previously passed to `resolve()`
 * @returns {Array<{path: string, value: *}>} One entry per substituted path;
 *   empty when `config` was never resolved or nothing was substituted
 *
 * @example
 * var conf = { db: { password: '${secret:DB_PASSWORD}' }, items: ['${secret:A}', 'literal'] };
 * process.env.DB_PASSWORD = 'correct-horse';
 * process.env.A = 'battery-staple';
 * secrets.resolve(conf);
 * secrets.getResolvedValues(conf);
 * // → [{ path: 'db.password', value: 'correct-horse' }, { path: 'items[0]', value: 'battery-staple' }]
 * secrets.getResolvedValues({}); // → []
 */
function getResolvedValues(config) {
    var paths = getResolvedPaths(config);
    var out   = [];
    for (var i = 0; i < paths.length; i++) {
        out.push({ path: paths[i], value: readPath(config, paths[i]) });
    }
    return out;
}

/**
 * Enumerate the distinct `${secret:KEY}` placeholder keys present in
 * `config`, without resolving any of them. Read-only and non-throwing:
 * unlike `resolve()`, it never calls a backend, never mutates `config`,
 * and never fails on unset / empty values — it answers only the question
 * "which keys would this config require?".
 *
 * Backs the `gina secrets:scan` / `secrets:check` introspection CLI.
 * Mirrors `resolve()`'s matching rule exactly (anchored `SECRET_RE`), so
 * the reported set is precisely the set `resolve()` would substitute:
 * mixed-content strings (`'prefix-${secret:K}-suffix'`) are NOT reported.
 *
 * @memberof module:lib/secrets
 * @function getRequiredKeys
 * @param {object|Array} config - A bundle config object (or any subtree)
 * @returns {string[]} Sorted, de-duplicated list of required key names. Empty for non-object inputs or configs with no bare placeholders.
 *
 * @example
 * secrets.getRequiredKeys({
 *     db: { password: '${secret:DB_PASSWORD}' },
 *     api: { key: '${secret:API_KEY}', url: 'https://${secret:API_KEY}/v1' }
 * });
 * // → ['API_KEY', 'DB_PASSWORD']
 * // The mixed-content `url` is not reported (mirrors resolve()).
 */
function getRequiredKeys(config) {
    if (config === null || typeof config !== 'object') {
        return [];
    }
    var keys = Object.create(null);
    walkAndCollect(config, keys);
    return Object.keys(keys).sort();
}

/**
 * Select the backend a given bundle config should resolve through.
 *
 * Reads `content.settings.secrets.file` — one path or an array of paths,
 * lowest precedence first. When the key is absent the default `process.env`
 * backend is returned **unchanged**, so a config that does not opt in behaves
 * exactly as it did before this seam existed.
 *
 * Reads `content.settings` and not `settings`. For a config built by
 * `core/config.js::loadBundleConfig` the two are now the same object — since
 * #B257 the `.settings` alias is re-pointed at the post-substitution copy — so
 * either would do. `content.settings` stays the canonical read because this
 * function accepts any config-shaped object, including ones assembled by other
 * paths, where only `content` is guaranteed to have been through the `${…}`
 * substitution pass.
 *
 * Note the reason is NOT that `.settings` is unsubstituted wholesale (#B273): a
 * first substitution pass runs earlier still, so `${homedir}` / `${scope}` were
 * always resolved in both copies. What used to differ was the tokens only the
 * later pass knows — `${bundlePath}`, `${libPath}`, `${publicPath}`, … — which
 * is what #B257 closed.
 *
 * @memberof module:lib/secrets
 * @function selectBackend
 * @param {object} config - The merged per-bundle config (`envConf[bundle][env]`)
 * @returns {{resolve: function(string): string}} The env backend, an
 *   env-over-file backend, or an env-over-exec backend — the two declared
 *   tiers are mutually exclusive by validation
 * @throws {Error} If the block or a declared tier fails the shared
 *   declaration guards (./declaration): a non-object block, an unknown key,
 *   both tiers declared at once; a file entry that is non-string /
 *   whitespace-only / a `${secret:…}` placeholder / an unresolved `${…}`
 *   token / an empty path segment (`//`); an exec spec whose command is not
 *   a non-empty argv array of clean strings, or whose timeout is not a
 *   positive integer. Also propagates the exec backend's eager-fetch
 *   failures (timeout, missing binary, non-zero exit, bad output).
 *
 * @example
 * // settings.json:
 * //   "secrets": { "file": ["${homedir}/secrets.env",
 * //                         "${homedir}/${scope}/secrets.env"] }
 * var backend = secrets.selectBackend(conf);
 * secrets.resolve(conf, backend);
 *
 * @example
 * // settings.json (exec bridge — the operator's own CLI does the fetch):
 * //   "secrets": { "exec": { "command": ["sops", "decrypt",
 * //                          "--output-type", "json",
 * //                          "${project}/secrets.enc.json"] } }
 * var backend = secrets.selectBackend(conf);
 * secrets.resolve(conf, backend);
 */
function selectBackend(config) {
    if (config === null || typeof config !== 'object') {
        return defaultBackend;
    }
    var content  = config.content;
    var settings = (content && typeof content === 'object') ? content.settings : null;
    var block    = (settings && typeof settings === 'object') ? settings.secrets : undefined;

    if (typeof block === 'undefined' || block === null) {
        return defaultBackend;
    }

    // Block-level guards first — shape, unknown-key refusal (runtime parity
    // with the schema's `additionalProperties: false`; a typo'd key used to
    // degrade SILENTLY to env-only), and the file/exec exclusivity rule with
    // its `"file": null` escape hatch. Shared with the secrets:check gate
    // (./declaration), like every guard below — #B408's lesson.
    var blockErrors = declaration.validateBlock(block);
    if (blockErrors.length) {
        throw new Error(blockErrors[0].message);
    }

    var declared = block.file;
    if (typeof declared !== 'undefined' && declared !== null) {
        var paths = Array.isArray(declared) ? declared : [declared];
        if (!paths.length) {
            // #B271 — `[]` disables the whole file tier exactly like `null`, but it is
            // not one of the documented shapes, so an operator emptying the array to
            // drop ONE layer silently drops the tier. Keep accepting it — an empty
            // list genuinely means "no files", and refusing boot over an undocumented
            // spelling would be a total outage for a harmless config — but say so once
            // rather than disabling a security tier without a word.
            console.warn('[ secrets ] `settings.secrets.file` is an empty array — the file tier is disabled. Use `null` to opt out explicitly, or list at least one path.');
            return defaultBackend;
        }

        // The per-entry guards (#B271 entry shape incl. trim, the `secret:`
        // placeholder refusal, the unresolved-token refusal, #B272's empty path
        // segment) live in ./declaration, SHARED with the secrets:check CLI gate.
        // #B408: two of those guards had drifted out of the checker's own copy —
        // the gate green-lit configs this function refuses to boot — so the loop
        // moved to one home, the same cure #B263 applied to the config-source
        // walk. The full rationale for each guard travels with it.
        var declErrors = declaration.validateFilePaths(paths);
        if (declErrors.length) {
            throw new Error(declErrors[0].message);
        }

        return fileBackend.build(paths);
    }

    var execSpec = block.exec;
    if (typeof execSpec !== 'undefined' && execSpec !== null) {
        var execErrors = declaration.validateExecSpec(execSpec);
        if (execErrors.length) {
            throw new Error(execErrors[0].message);
        }
        // build() runs the fetch EAGERLY — a timeout / missing binary /
        // non-zero exit / bad output throws here, and the caller reports it
        // as a per-bundle boot refusal, exactly like an unreadable file
        // layer (#B267). Fail fast, never hang: the fetch is SIGKILL-bounded.
        return execBackend.build(execSpec);
    }

    // `{}`, `{file: null}`, `{exec: null}` — the pinned inherit / opt-out
    // shapes: same default backend instance, byte-identical to no block.
    return defaultBackend;
}

module.exports = {
    // Config-source walk (which `${secret:KEY}` placeholders does a project /
    // bundle require, walked from the same sources `loadBundleConfig` reads),
    // re-exported from ./sources so that every consumer — the secrets:scan and
    // secrets:check CLIs today, any boot-time consumer tomorrow — walks the
    // SAME source set. Two hand-kept copies of this walk drifted once already
    // (#B263: the gate and the runtime consulted different sources); one
    // implementation makes that disagreement structurally impossible. The
    // leaf readers ride along for the CLI handlers' own single-file needs.
    getProjectRequiredKeys: sources.getProjectRequiredKeys,
    loadManifest: sources.loadManifest,
    readJsonSafe: sources.readJsonSafe,
    resolveBundleSrc: sources.resolveBundleSrc,
    resolve: resolve,
    getResolvedPaths: getResolvedPaths,
    getResolvedValues: getResolvedValues,
    getRequiredKeys: getRequiredKeys,
    selectBackend: selectBackend,
    // Declaration validation, re-exported from ./declaration so the
    // secrets:check gate validates with the RUNTIME's own guards rather than
    // a hand-kept copy — the copy drifted twice (#B408; drift class #B263).
    validateFilePaths: declaration.validateFilePaths,
    validateBlock: declaration.validateBlock,
    validateExecSpec: declaration.validateExecSpec,
    // The exec tier's fetch, re-exported so secrets:check runs the SAME
    // spawn (same timeout, same SIGKILL bound, same output contract) the
    // boot runs — a second spawn implementation in the checker would be the
    // #B408 drift class on the semantics axis.
    fetchExecMap: execBackend.fetchExecMap,
    SECRET_RE: SECRET_RE,
    // `.env`-style parsing, re-exported from ./env-file so that every reader
    // of a given file agrees on what it means. See that module's header for
    // why one implementation matters here.
    parseEnv: envFile.parseEnv,
    parseEnvFile: envFile.parseEnvFile,
    // `readEnvFile` is the discriminated form — it reports WHY a read failed, so
    // a caller can tell a genuinely absent layer (skip it) from one that exists
    // and cannot be read (refuse). Both the runtime backend and `secrets:check`
    // need that distinction to agree about the same file (#B267).
    readEnvFile: envFile.readEnvFile
};
