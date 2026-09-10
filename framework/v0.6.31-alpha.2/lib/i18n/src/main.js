/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/i18n
 *
 * Internationalisation primitives. Per-bundle JSON catalogs, fallback chain
 * (specific culture → base language → bundle default → process default →
 * 'en'), CLDR plural rules via the Node-built-in `Intl.PluralRules`, and
 * `{name}`-style parameter interpolation.
 *
 * Backs three call surfaces:
 *
 *   - Global `gna.t(key, params, culture)` — explicit culture required.
 *   - Controller helper `self.t(key, params)` — auto-binds `req.culture`.
 *   - Swig / Nunjucks `t` filter — auto-binds via the existing factory shape.
 *
 * Catalogs live at `process.gina._i18nCatalogs[bundleName][culture]`. A
 * `Intl.PluralRules` instance per culture lives at
 * `process.gina._i18nPluralRules[culture]` for amortised cost.
 *
 * Loading is eager (one disk pass per bundle at boot, see {@link loadCatalogs}).
 * No hot-reload — bundle restart picks up edits, mirroring `routing.json` /
 * `connectors.json` policy.
 *
 * @package    gina.framework
 * @namespace  lib.i18n
 * @author     Rhinostone <contact@gina.io>
 */

'use strict';

var fs   = require('fs');
var path = require('path');

/**
 * CLDR plural categories recognised by `Intl.PluralRules` and matched
 * against catalog plural-form objects.
 *
 * @memberof module:gina/lib/i18n
 * @constant
 * @type {string[]}
 */
var CLDR_PLURAL_KEYS = ['zero', 'one', 'two', 'few', 'many', 'other'];

/**
 * Last-resort culture used when fallback chain is exhausted.
 *
 * @memberof module:gina/lib/i18n
 * @constant
 * @type {string}
 */
var DEFAULT_FALLBACK_LANG = 'en';

/**
 * Filename pattern accepted by {@link loadCatalogs}. Matches `<lang>.json`
 * and `<lang>_<region>.json` (e.g. `en.json`, `en_US.json`, `pt_BR.json`).
 * Hyphenated form (`en-US.json`) is intentionally NOT accepted — gina uses
 * underscore separators (`GINA_CULTURE`, `bin/gina-init`).
 *
 * @memberof module:gina/lib/i18n
 * @constant
 * @type {RegExp}
 */
var CULTURE_FILENAME = /^([a-z]{2,3})(_([A-Z]{2,3}))?\.json$/;

/**
 * Reserved catalog namespace holding gina's built-in FormValidator rule labels.
 * Both label overlays resolve this node — the server engine
 * (`core/plugins/lib/validator/src/form-validator.js`) and the client whisper
 * (`core/controller/controller.js`, which ships the subset to the browser).
 *
 * @memberof module:gina/lib/i18n
 * @constant
 * @type {string}
 */
var VALIDATOR_NAMESPACE = '_validator';

/**
 * Placeholder tokens the validator engine substitutes inside a rule label.
 * MUST mirror `local.keys` in `core/plugins/lib/validator/src/form-validator.js`
 * (`%l` -> label, `%n` -> name, `%s` -> size). Case-sensitive on purpose: the
 * engine looks each matched token up verbatim, so `%L` resolves to `undefined`
 * exactly as `%d` does.
 *
 * @memberof module:gina/lib/i18n
 * @constant
 * @type {string[]}
 */
var VALIDATOR_LABEL_TOKENS = ['%l', '%n', '%s'];

/**
 * Token shape the validator engine's `replace()` scans for. Kept identical to
 * the engine's own regex so this lint sees exactly what will be substituted.
 *
 * @memberof module:gina/lib/i18n
 * @constant
 * @type {RegExp}
 */
var VALIDATOR_TOKEN_RE = /%[a-z]+/gi;

/**
 * Track bundles for which a missing-catalog warn has already fired
 * (one warn per bundle per process lifetime, regardless of how many
 * lookups miss).
 *
 * @inner
 * @type {Object<string, true>}
 */
var _missingBundleWarned = Object.create(null);

/**
 * Track keys for which a missing-key warn has already fired (one warn
 * per `bundleName::key` per process lifetime).
 *
 * @inner
 * @type {Object<string, true>}
 */
var _missingKeyWarned = Object.create(null);

/**
 * #I18N2 — `intl-messageformat`'s `IntlMessageFormat` constructor, populated
 * once {@link ensureIcuLoaded} resolves. The package is ESM-only since v10
 * so it cannot be `require()`d from CJS gina; dynamic `import()` lands the
 * value here at first use.
 *
 * @inner
 * @type {*}
 */
var IntlMessageFormat = null;

/**
 * #I18N2 — pending load promise (singleton). Set on the first
 * {@link ensureIcuLoaded} call; reused for subsequent calls so the
 * `import()` only fires once per process.
 *
 * @inner
 * @type {Promise|null}
 */
var icuLoadPromise = null;

/**
 * #I18N2 — captured load error (e.g. dependency not installed). Once set,
 * subsequent {@link tIcu} calls surface this verbatim with an actionable
 * "npm install intl-messageformat" hint.
 *
 * @inner
 * @type {Error|null}
 */
var icuLoadError = null;

/**
 * Lazily create the `process.gina._i18nCatalogs` slot when first touched.
 *
 * @inner
 * @returns {Object<string, Object<string, object>>} The catalog registry.
 */
function _store() {
    if ( !process.gina ) {
        process.gina = {};
    }
    if ( !process.gina._i18nCatalogs ) {
        process.gina._i18nCatalogs = Object.create(null);
    }
    return process.gina._i18nCatalogs;
}

/**
 * Lazily create the `process.gina._i18nPluralRules` cache.
 *
 * @inner
 * @returns {Object<string, Intl.PluralRules>}
 */
function _pluralCache() {
    if ( !process.gina ) {
        process.gina = {};
    }
    if ( !process.gina._i18nPluralRules ) {
        process.gina._i18nPluralRules = Object.create(null);
    }
    return process.gina._i18nPluralRules;
}

/**
 * #I18N2 — lazily create the per-process IcuFormatter cache slot. Keys are
 * `<bundleName>::<culture>::<key>`; values are `IntlMessageFormat`
 * instances (or `null` for entries that failed to parse).
 *
 * @inner
 * @returns {Object<string, *>}
 */
function _icuFormatterCache() {
    if ( !process.gina ) {
        process.gina = {};
    }
    if ( !process.gina._i18nIcuFormatters ) {
        process.gina._i18nIcuFormatters = Object.create(null);
    }
    return process.gina._i18nIcuFormatters;
}

/**
 * Convert a culture string to the form `Intl.PluralRules` expects (BCP-47
 * with `-` rather than `_`). `en_US` → `en-US`. Pass-through for already
 * BCP-47 input.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string} culture
 * @returns {string}
 */
function toBcp47(culture) {
    return String(culture || '').replace(/_/g, '-');
}

/**
 * Split a culture string into `[language, region]`. `en_US` → `['en','US']`,
 * `fr` → `['fr', null]`.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string} culture
 * @returns {string[]}
 */
function splitCulture(culture) {
    var s = String(culture || '');
    var i = s.indexOf('_');
    if ( i < 0 ) {
        return [s, null];
    }
    return [s.substring(0, i), s.substring(i + 1)];
}

/**
 * Warn on `_validator` labels the FormValidator engine cannot render correctly.
 *
 * The engine substitutes every token matching {@link VALIDATOR_TOKEN_RE} it finds
 * in a label, looking each one up verbatim in its `local.keys` map. An unknown
 * token — `%d`, `%L`, or a bare percent glued to letters as in `20%sur le prix` —
 * resolves to `undefined` and is spliced into user-facing copy; a non-string label is
 * discarded by the engine, which renders the rule's English default instead. Both are
 * catalog-authoring mistakes, and the catalog is parsed only here, so this is the
 * one place to surface them before a request renders them.
 *
 * Warns once per offending label at boot and never throws — a translation typo
 * must not take a bundle down. This covers the client too: the browser's
 * `gina.config.validatorLabels` is a subset of this same boot-loaded catalog.
 * It does NOT cover labels supplied at runtime via `gina.validator.setErrorLabels()`,
 * nor a rule's `errorMessage` argument — for those, the engine's own fail-soft guard
 * warns at the point of degradation.
 *
 * @memberof module:gina/lib/i18n
 * @inner
 * @param   {object} catalog  - Parsed catalog root.
 * @param   {string} filePath - Absolute path to the catalog, for the operator message.
 * @returns {number} Number of warnings emitted; `0` when the catalog is clean.
 *
 * @example
 *   // locales/fr.json -> { "_validator": { "isRequired": "Remise 100%sur le prix" } }
 *   warnOnSuspectValidatorLabels(catalog, '/srv/app/dashboard/locales/fr.json');
 *   // -> [i18n] `_validator.isRequired` in ... contains unknown placeholder `%sur` ...
 */
function warnOnSuspectValidatorLabels(catalog, filePath) {
    var node = catalog[VALIDATOR_NAMESPACE];
    if ( typeof node === 'undefined' || node === null ) {
        return 0; // absent: the normal case for a bundle that translates nothing else
    }
    if ( typeof node !== 'object' || Array.isArray(node) ) {
        console.warn('[i18n] `' + VALIDATOR_NAMESPACE + '` in ' + filePath
            + ' must be an object mapping rule names to labels — ignoring it');
        return 1;
    }
    var count = 0;
    for (var rule in node) {
        if ( !Object.prototype.hasOwnProperty.call(node, rule) ) {
            continue;
        }
        var label = node[rule];
        if ( typeof label !== 'string' ) {
            console.warn('[i18n] `' + VALIDATOR_NAMESPACE + '.' + rule + '` in ' + filePath
                + ' must be a string — the validator discards it and renders the English default');
            count++;
            continue;
        }
        var tokens = label.match(VALIDATOR_TOKEN_RE);
        if ( !tokens ) {
            continue;
        }
        for (var t = 0; t < tokens.length; t++) {
            if ( VALIDATOR_LABEL_TOKENS.indexOf(tokens[t]) < 0 ) {
                console.warn('[i18n] `' + VALIDATOR_NAMESPACE + '.' + rule + '` in ' + filePath
                    + ' contains unknown placeholder `' + tokens[t] + '` — it renders as "undefined".'
                    + ' Known tokens: ' + VALIDATOR_LABEL_TOKENS.join(', ')
                    + ' (a literal percent must not be followed by letters)');
                count++;
            }
        }
    }
    return count;
}

/**
 * Eager-load every culture catalog under `<dir>/locales/`. Called once per
 * bundle at boot. Files must match {@link CULTURE_FILENAME}; non-matching
 * files are skipped with a `console.warn`. Malformed JSON throws.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string} bundleName - Bundle name; keys the registry slot.
 * @param   {string} dir        - Absolute path to the bundle's `locales/` directory.
 * @returns {string[]} Sorted list of culture codes loaded (e.g. `['en','en_US','fr']`).
 *
 * @example
 *   var loaded = loadCatalogs('dashboard', '/path/to/bundle/locales');
 *   // → ['en', 'fr']
 */
function loadCatalogs(bundleName, dir) {
    if ( !bundleName || typeof bundleName !== 'string' ) {
        throw new TypeError('loadCatalogs: bundleName must be a non-empty string');
    }
    var store = _store();
    store[bundleName] = Object.create(null);

    if ( !dir || !fs.existsSync(dir) ) {
        return [];
    }

    var stat;
    try {
        stat = fs.statSync(dir);
    } catch (err) {
        return [];
    }
    if ( !stat.isDirectory() ) {
        return [];
    }

    var entries = fs.readdirSync(dir);
    var loaded  = [];
    for (var i = 0; i < entries.length; i++) {
        var name = entries[i];
        var match = CULTURE_FILENAME.exec(name);
        if ( !match ) {
            // Skip dotfiles silently; warn on other unrecognised JSON.
            if ( name.charAt(0) !== '.' && /\.json$/.test(name) ) {
                console.warn('[i18n] skipping `' + name + '` in ' + dir + ' — filename must match <lang>(_<REGION>)?.json');
            }
            continue;
        }
        var culture  = match[3] ? (match[1] + '_' + match[3]) : match[1];
        var filePath = path.join(dir, name);
        var raw;
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            throw new Error('[i18n] failed to read ' + filePath + ': ' + err.message);
        }
        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            throw new Error('[i18n] malformed catalog at ' + filePath + ': ' + err.message);
        }
        if ( parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ) {
            throw new Error('[i18n] catalog root must be an object: ' + filePath);
        }
        // Surface unrenderable built-in validator labels while the catalog is in hand.
        warnOnSuspectValidatorLabels(parsed, filePath);
        store[bundleName][culture] = parsed;
        loaded.push(culture);
    }
    loaded.sort();
    // #I18N2 — kick off the ICU loader in the background. Fire-and-forget;
    // the `.catch()` prevents UnhandledPromiseRejection when the package is
    // not installed — `tIcu()` surfaces that error clearly on first call.
    ensureIcuLoaded().catch(function () { /* error captured on icuLoadError */ });
    return loaded;
}

/**
 * Manually inject a catalog (test fixtures, `i18n:add` CLI). Replaces any
 * existing catalog for the same `(bundleName, culture)`.
 *
 * @memberof module:gina/lib/i18n
 * @param {string} bundleName
 * @param {string} culture
 * @param {object} catalog    - Plain object; nested objects + plural forms allowed.
 *
 * @example
 *   setCatalog('test', 'en', { common: { welcome: 'Hi!' } });
 */
function setCatalog(bundleName, culture, catalog) {
    if ( !bundleName || !culture ) {
        throw new TypeError('setCatalog: bundleName and culture are required');
    }
    if ( catalog === null || typeof catalog !== 'object' || Array.isArray(catalog) ) {
        throw new TypeError('setCatalog: catalog must be a plain object');
    }
    var store = _store();
    if ( !store[bundleName] ) {
        store[bundleName] = Object.create(null);
    }
    store[bundleName][culture] = catalog;
}

/**
 * Read a single culture catalog. Returns `null` when not loaded.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string} bundleName
 * @param   {string} culture
 * @returns {object|null}
 */
function getCatalog(bundleName, culture) {
    var store = _store();
    if ( !store[bundleName] || !store[bundleName][culture] ) {
        return null;
    }
    return store[bundleName][culture];
}

/**
 * Read every catalog loaded for a bundle. Returns an empty object when the
 * bundle has no catalogs.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string} bundleName
 * @returns {Object<string, object>}
 */
function getCatalogs(bundleName) {
    var store = _store();
    return store[bundleName] || Object.create(null);
}

/**
 * Drop every catalog for a bundle. Used by tests and (eventually) bundle
 * hot-reload.
 *
 * @memberof module:gina/lib/i18n
 * @param {string} bundleName
 */
function clearCatalogs(bundleName) {
    var store = _store();
    delete store[bundleName];
    // Clear matching warn flags so a subsequent reload can re-warn cleanly.
    for ( var k in _missingBundleWarned ) {
        if ( k === bundleName ) {
            delete _missingBundleWarned[k];
        }
    }
    var prefix = bundleName + '::';
    for ( var kk in _missingKeyWarned ) {
        if ( kk.indexOf(prefix) === 0 ) {
            delete _missingKeyWarned[kk];
        }
    }
    // #I18N2 — drop cached IcuFormatters for this bundle.
    var icuCache = _icuFormatterCache();
    for ( var ick in icuCache ) {
        if ( ick.indexOf(prefix) === 0 ) {
            delete icuCache[ick];
        }
    }
}

/**
 * Walk a dotted-path key into a nested catalog. `common.welcome` →
 * `catalog['common']['welcome']`. Returns `undefined` if any step misses.
 *
 * @memberof module:gina/lib/i18n
 * @param   {object} catalog
 * @param   {string} key
 * @returns {*|undefined}
 *
 * @example
 *   resolveKey({ common: { welcome: 'Hi!' } }, 'common.welcome'); // → 'Hi!'
 *   resolveKey({ common: { welcome: 'Hi!' } }, 'missing.key');    // → undefined
 */
function resolveKey(catalog, key) {
    if ( !catalog || typeof catalog !== 'object' ) {
        return undefined;
    }
    if ( typeof key !== 'string' || key.length === 0 ) {
        return undefined;
    }
    var parts = key.split('.');
    var cursor = catalog;
    for (var i = 0; i < parts.length; i++) {
        if ( cursor === null || typeof cursor !== 'object' ) {
            return undefined;
        }
        var part = parts[i];
        if ( part.length === 0 ) {
            // empty segment from `..` or leading/trailing `.` — fail closed.
            return undefined;
        }
        cursor = cursor[part];
        if ( typeof cursor === 'undefined' ) {
            return undefined;
        }
    }
    return cursor;
}

/**
 * Replace `{name}`-style placeholders in `str` with values from `params`.
 * Missing params leave the placeholder as a literal (and emit a one-time
 * dev-mode warn). `{{name}}` renders as the literal `{name}` (single
 * de-quote pass).
 *
 * @memberof module:gina/lib/i18n
 * @param   {string} str
 * @param   {Object<string, *>} [params]
 * @returns {string}
 *
 * @example
 *   interpolate('Hello, {name}!', { name: 'Ada' });      // → 'Hello, Ada!'
 *   interpolate('{a} and {b}',     { a: 1, b: 2 });       // → '1 and 2'
 *   interpolate('Unknown {x}',     {});                   // → 'Unknown {x}'
 *   interpolate('Literal {{x}}',   {});                   // → 'Literal {x}'
 */
function interpolate(str, params) {
    if ( typeof str !== 'string' ) {
        return String(str);
    }
    var p = params || {};
    // Two-pass to handle escapes: first sub a sentinel for `{{...}}`,
    // then replace `{name}`, then restore.
    var SENT_OPEN  = '';
    var SENT_CLOSE = '';
    var s = str
        .replace(/\{\{/g, SENT_OPEN)
        .replace(/\}\}/g, SENT_CLOSE);
    s = s.replace(/\{(\w+)\}/g, function(match, name) {
        if ( Object.prototype.hasOwnProperty.call(p, name) && typeof p[name] !== 'undefined' ) {
            return String(p[name]);
        }
        return match;
    });
    return s
        .replace(new RegExp(SENT_OPEN, 'g'),  '{')
        .replace(new RegExp(SENT_CLOSE, 'g'), '}');
}

/**
 * Get (or lazily build) a cached `Intl.PluralRules` instance for `culture`.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string} culture
 * @returns {Intl.PluralRules}
 */
function getPluralRules(culture) {
    var cache = _pluralCache();
    var bcp47 = toBcp47(culture);
    if ( !cache[bcp47] ) {
        try {
            cache[bcp47] = new Intl.PluralRules(bcp47);
        } catch (err) {
            // Unknown culture — fall back to the default lang.
            cache[bcp47] = new Intl.PluralRules(DEFAULT_FALLBACK_LANG);
        }
    }
    return cache[bcp47];
}

/**
 * Pick a plural form from a value. Caller has already determined that
 * `count` was provided AND that `value` is an object with at least one
 * CLDR plural key. Returns the chosen form (string), or `undefined` if
 * the value lacks both the selected category AND the `'other'` fallback.
 *
 * @memberof module:gina/lib/i18n
 * @param   {object} value
 * @param   {number} count
 * @param   {string} culture
 * @returns {string|undefined}
 */
function selectPlural(value, count, culture) {
    var pr = getPluralRules(culture);
    var category = pr.select(count);
    if ( typeof value[category] === 'string' ) {
        return value[category];
    }
    if ( typeof value.other === 'string' ) {
        return value.other;
    }
    return undefined;
}

/**
 * Test whether `value` looks like a plural-form object (object whose own
 * keys are all in {@link CLDR_PLURAL_KEYS} and whose values are all
 * strings). Conservative: even one unrecognised key means it's a nested
 * category, not a plural form.
 *
 * @memberof module:gina/lib/i18n
 * @param   {*} value
 * @returns {boolean}
 */
function isPluralForm(value) {
    if ( !value || typeof value !== 'object' || Array.isArray(value) ) {
        return false;
    }
    var keys = Object.keys(value);
    if ( keys.length === 0 ) {
        return false;
    }
    for (var i = 0; i < keys.length; i++) {
        if ( CLDR_PLURAL_KEYS.indexOf(keys[i]) < 0 ) {
            return false;
        }
        if ( typeof value[keys[i]] !== 'string' ) {
            return false;
        }
    }
    return true;
}

/**
 * Build the ordered fallback chain for a requested culture. Returns an
 * array of cultures to try in order. Each entry is unique (de-duped while
 * preserving order).
 *
 * @memberof module:gina/lib/i18n
 * @param   {string}   culture          - Requested culture (e.g. `'fr_CA'`).
 * @param   {string}   [defaultCulture] - Bundle / process default (e.g. `'en_US'`).
 * @param   {string[]} [customChain]    - Optional override appended after the
 *                                        specific/base lookups (from
 *                                        `settings.i18n.fallbackChain`).
 * @returns {string[]}
 *
 * @example
 *   walkFallback('fr_CA', 'en_US');
 *   // → ['fr_CA', 'fr', 'en_US', 'en', 'en']
 *   //   (final 'en' is the hardcoded last resort; de-dupe keeps it once)
 */
function walkFallback(culture, defaultCulture, customChain) {
    var seen   = Object.create(null);
    var chain  = [];
    function push(c) {
        if ( !c || typeof c !== 'string' ) {
            return;
        }
        if ( seen[c] ) {
            return;
        }
        seen[c] = true;
        chain.push(c);
    }
    push(culture);
    var parts = splitCulture(culture);
    if ( parts[1] ) {
        push(parts[0]);
    }
    if ( Array.isArray(customChain) ) {
        for (var i = 0; i < customChain.length; i++) {
            push(customChain[i]);
        }
    }
    if ( defaultCulture && defaultCulture !== culture ) {
        push(defaultCulture);
        var dParts = splitCulture(defaultCulture);
        if ( dParts[1] ) {
            push(dParts[0]);
        }
    }
    push(DEFAULT_FALLBACK_LANG);
    return chain;
}

/**
 * Translate a key. Walks the fallback chain, resolves the key, applies
 * plural rules if `params.count` is present and the value is a plural
 * form, then runs interpolation.
 *
 * Behaviour when no translation is found:
 * - If `options.devMissingKey` is a string (and `process.env.NODE_ENV_IS_DEV === 'true'`),
 *   returns `<marker> <key>`.
 * - Otherwise returns the key verbatim.
 * - Always emits a one-time `console.warn` per `(bundleName, key)` in dev mode.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string}            key
 * @param   {Object|null}       [params]
 * @param   {string}            [culture] - Required for actual lookup; if
 *                                          omitted, returns key verbatim
 *                                          (back-compat with the legacy `__()`
 *                                          no-op stub).
 * @param   {Object}            [options]
 * @param   {string}            [options.bundleName]    - Defaults to `process.env.GINA_BUNDLE`.
 * @param   {string}            [options.defaultCulture] - Bundle default culture.
 * @param   {string[]}          [options.fallbackChain]  - Optional override.
 * @param   {string}            [options.devMissingKey]  - Dev-mode prefix marker.
 * @returns {string}
 *
 * @example
 *   t('common.welcome', {},                'en_US', { bundleName: 'dashboard' });
 *   t('common.greeting', { name: 'Ada' },  'fr',    { bundleName: 'dashboard' });
 *   t('common.items',    { count: 5 },     'en',    { bundleName: 'dashboard' });
 */
function t(key, params, culture, options) {
    if ( typeof key !== 'string' || key.length === 0 ) {
        return '';
    }
    if ( !culture ) {
        // Back-compat: no culture → key verbatim, no warn (this is the
        // legacy `__()` no-op shape). Callers who need a translation
        // must supply culture explicitly.
        return key;
    }
    var opts       = options || {};
    var bundleName = opts.bundleName || process.env.GINA_BUNDLE || null;
    if ( !bundleName ) {
        return _missingResult(key, opts);
    }
    var catalogs = getCatalogs(bundleName);
    if ( !catalogs || Object.keys(catalogs).length === 0 ) {
        if ( !_missingBundleWarned[bundleName] && _isDev() ) {
            console.warn('[i18n] no catalogs loaded for bundle `' + bundleName + '` — t() returning key verbatim');
            _missingBundleWarned[bundleName] = true;
        }
        return _missingResult(key, opts);
    }
    var chain = walkFallback(culture, opts.defaultCulture, opts.fallbackChain);
    var value = undefined;
    for (var i = 0; i < chain.length; i++) {
        var cat = catalogs[chain[i]];
        if ( !cat ) continue;
        var resolved = resolveKey(cat, key);
        if ( typeof resolved !== 'undefined' ) {
            value = resolved;
            break;
        }
    }
    if ( typeof value === 'undefined' ) {
        return _missingResult(key, opts, bundleName);
    }

    var p = params || {};
    var hasCount = Object.prototype.hasOwnProperty.call(p, 'count') && typeof p.count === 'number';
    if ( hasCount && isPluralForm(value) ) {
        var form = selectPlural(value, p.count, culture);
        if ( typeof form !== 'string' ) {
            return _missingResult(key, opts, bundleName);
        }
        return interpolate(form, p);
    }
    if ( typeof value === 'string' ) {
        return interpolate(value, p);
    }
    // Resolved to a non-string (deeper nesting node) — treat as missing.
    return _missingResult(key, opts, bundleName);
}

/**
 * @inner
 * @returns {boolean}
 */
function _isDev() {
    return process.env.NODE_ENV_IS_DEV === 'true';
}

/**
 * @inner
 * @param   {string} key
 * @param   {Object} opts
 * @param   {string} [bundleName] - Pass to enable per-key warn dedup.
 * @returns {string}
 */
function _missingResult(key, opts, bundleName) {
    if ( bundleName && _isDev() ) {
        var flagKey = bundleName + '::' + key;
        if ( !_missingKeyWarned[flagKey] ) {
            console.warn('[i18n] missing key `' + key + '` in bundle `' + bundleName + '`');
            _missingKeyWarned[flagKey] = true;
        }
    }
    if ( typeof opts.devMissingKey === 'string' && _isDev() ) {
        return opts.devMissingKey + ' ' + key;
    }
    return key;
}

/**
 * #I18N2 — load `intl-messageformat` via dynamic `import()` (the package is
 * ESM-only since v10 so it cannot be `require()`d from CJS gina). Returns
 * a Promise that resolves to the `IntlMessageFormat` constructor.
 * Idempotent — subsequent calls return the cached promise. Failure is
 * captured on `icuLoadError` so future calls surface a clear "package not
 * installed" message via {@link tIcu}.
 *
 * Called fire-and-forget from {@link loadCatalogs} at bundle boot, so by
 * the time the first request is served the load has resolved and
 * {@link tIcu} is sync. Tests can `await ensureIcuLoaded()` explicitly.
 *
 * @memberof module:gina/lib/i18n
 * @returns {Promise<*>} Resolves to IntlMessageFormat, or rejects with the load error.
 *
 * @example
 *   await i18n.ensureIcuLoaded();
 *   var msg = i18n.tIcu('items', { count: 3 }, 'en', { bundleName: 'dashboard' });
 */
function ensureIcuLoaded() {
    if ( icuLoadError ) return Promise.reject(icuLoadError);
    if ( IntlMessageFormat ) return Promise.resolve(IntlMessageFormat);
    if ( icuLoadPromise ) return icuLoadPromise;
    icuLoadPromise = import('intl-messageformat').then(function (mod) {
        IntlMessageFormat = mod.IntlMessageFormat
            || (mod.default && mod.default.IntlMessageFormat);
        if ( !IntlMessageFormat ) {
            throw new Error('[i18n] `intl-messageformat` loaded but the IntlMessageFormat export was not found.');
        }
        return IntlMessageFormat;
    }).catch(function (err) {
        icuLoadError = err;
        throw err;
    });
    return icuLoadPromise;
}

/**
 * #I18N2 — get or build the cached `IntlMessageFormat` for a
 * `(bundle, culture, key)` tuple. Caches `null` on parse failure so we
 * don't re-parse a malformed catalog string on every request.
 *
 * @inner
 * @private
 * @param   {string} bundleName
 * @param   {string} culture
 * @param   {string} key
 * @param   {string} value - The catalog string containing ICU MessageFormat syntax.
 * @returns {*|null}
 */
function _getIcuFormatter(bundleName, culture, key, value) {
    var cache = _icuFormatterCache();
    var cacheKey = bundleName + '::' + culture + '::' + key;
    if ( typeof cache[cacheKey] !== 'undefined' ) {
        return cache[cacheKey];
    }
    try {
        cache[cacheKey] = new IntlMessageFormat(value, toBcp47(culture));
    } catch (err) {
        if ( _isDev() ) {
            console.warn('[i18n] t.icu() parse error for key `' + key + '` in bundle `' + bundleName + '` (' + culture + '): ' + err.message);
        }
        cache[cacheKey] = null;
    }
    return cache[cacheKey];
}

/**
 * #I18N2 — translate a key with ICU MessageFormat semantics. Resolves the
 * key against the bundle's catalog using the same fallback chain as
 * {@link t}, then formats the resolved string via `intl-messageformat`.
 *
 * Catalog values that are NOT strings (plural-form objects, nested
 * categories) fall through to {@link t} — both shapes can coexist in the
 * same catalog. Strings are interpreted as ICU MF syntax:
 *  - `{count, plural, one {# item} other {# items}}` (plural)
 *  - `{gender, select, female {…} male {…} other {…}}` (select / gender)
 *  - nested combinators are supported
 *
 * `IntlMessageFormat` instances are memoised per
 * `<bundleName>::<culture>::<key>` on `process.gina._i18nIcuFormatters`,
 * so the parse cost is paid once per (bundle, culture, key) per process.
 *
 * Called sync after {@link ensureIcuLoaded} resolves. Throws clearly if
 * called before the loader settles, or if the package is not installed.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string}      key
 * @param   {Object|null} [params]
 * @param   {string}      [culture] - Required for lookup; omitting returns the key verbatim.
 * @param   {Object}      [options]
 * @param   {string}      [options.bundleName]    - Defaults to `process.env.GINA_BUNDLE`.
 * @param   {string}      [options.defaultCulture] - Bundle default culture.
 * @param   {string[]}    [options.fallbackChain]  - Override of the fallback chain.
 * @param   {string}      [options.devMissingKey]  - Dev-mode prefix for missing keys.
 * @returns {string}
 *
 * @example
 *   tIcu('items', { count: 5 }, 'en', { bundleName: 'dashboard' });
 *   // → '5 items' when catalog says: "items": "{count, plural, one {# item} other {# items}}"
 *
 * @example
 *   tIcu('greeting', { gender: 'female', name: 'Ada' }, 'en', { bundleName: 'dashboard' });
 *   // → 'Hi, Ada!' when catalog says: "greeting": "{gender, select, female {Hi, {name}!} other {Hello, {name}!}}"
 */
function tIcu(key, params, culture, options) {
    if ( typeof key !== 'string' || key.length === 0 ) {
        return '';
    }
    if ( !culture ) {
        return key;
    }
    if ( icuLoadError ) {
        throw new Error('[i18n] t.icu() requires the `intl-messageformat` npm package — install with: npm install intl-messageformat. Original load error: ' + icuLoadError.message);
    }
    if ( !IntlMessageFormat ) {
        throw new Error('[i18n] t.icu() called before intl-messageformat finished loading. Either ensure `loadCatalogs()` ran at boot, or `await i18n.ensureIcuLoaded()` first.');
    }

    var opts = options || {};
    var bundleName = opts.bundleName || process.env.GINA_BUNDLE || null;
    if ( !bundleName ) {
        return _missingResult(key, opts);
    }

    var catalogs = getCatalogs(bundleName);
    if ( !catalogs || Object.keys(catalogs).length === 0 ) {
        if ( !_missingBundleWarned[bundleName] && _isDev() ) {
            console.warn('[i18n] no catalogs loaded for bundle `' + bundleName + '` — t.icu() returning key verbatim');
            _missingBundleWarned[bundleName] = true;
        }
        return _missingResult(key, opts);
    }

    var chain = walkFallback(culture, opts.defaultCulture, opts.fallbackChain);
    var value = undefined;
    var matchedCulture = culture;
    for (var i = 0; i < chain.length; i++) {
        var cat = catalogs[chain[i]];
        if ( !cat ) continue;
        var resolved = resolveKey(cat, key);
        if ( typeof resolved !== 'undefined' ) {
            value = resolved;
            matchedCulture = chain[i];
            break;
        }
    }
    if ( typeof value === 'undefined' ) {
        return _missingResult(key, opts, bundleName);
    }

    // Non-string values (plural-form objects, nested categories) fall
    // through to v1 t() — both shapes can coexist in the same catalog.
    if ( typeof value !== 'string' ) {
        return t(key, params, culture, opts);
    }

    var formatter = _getIcuFormatter(bundleName, matchedCulture, key, value);
    if ( !formatter ) {
        return _missingResult(key, opts, bundleName);
    }
    try {
        return String(formatter.format(params || {}));
    } catch (err) {
        if ( _isDev() ) {
            console.warn('[i18n] t.icu() format error for key `' + key + '` in bundle `' + bundleName + '` (' + matchedCulture + '): ' + err.message);
        }
        return _missingResult(key, opts, bundleName);
    }
}

/**
 * #I18N1 slice 3 — parse an `Accept-Language` header into an ordered list of
 * `{ tag, q }` entries (highest q-value first; equal-q entries preserve
 * source order). Tags are returned in canonical underscore form
 * (`en-US` → `en_US`); wildcards (`*`) are dropped.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string} header
 * @returns {Array<{tag: string, q: number}>}
 *
 * @example
 *   parseAcceptLanguage('en-US,en;q=0.9,fr;q=0.8');
 *   // → [{tag:'en_US',q:1}, {tag:'en',q:0.9}, {tag:'fr',q:0.8}]
 */
function parseAcceptLanguage(header) {
    if ( typeof header !== 'string' || header.length === 0 ) {
        return [];
    }
    var parts = header.split(',');
    var out   = [];
    for (var i = 0; i < parts.length; i++) {
        var raw = parts[i].trim();
        if ( raw.length === 0 || raw === '*' ) continue;
        var bits = raw.split(';');
        var tag  = bits[0].trim();
        if ( tag.length === 0 || tag === '*' ) continue;
        var q = 1;
        for (var j = 1; j < bits.length; j++) {
            var p = bits[j].trim();
            var m = p.match(/^q\s*=\s*([0-9.]+)\s*$/i);
            if ( m ) {
                var n = parseFloat(m[1]);
                if ( !isNaN(n) && n >= 0 && n <= 1 ) {
                    q = n;
                }
            }
        }
        out.push({ tag: tag.replace(/-/g, '_'), q: q, _i: i });
    }
    out.sort(function(a, b) {
        if ( b.q !== a.q ) return b.q - a.q;
        return a._i - b._i;
    });
    return out.map(function(e) { return { tag: e.tag, q: e.q }; });
}

/**
 * #I18N1 slice 3 — pick the best-matching available culture for a list of
 * requested cultures. Walks each requested entry in order, trying the exact
 * tag first, then the base language. Returns `null` when nothing matches.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string[]} requested - Ordered list (e.g. from {@link parseAcceptLanguage}).
 * @param   {string[]} available - Cultures the bundle has loaded catalogs for.
 * @returns {string|null}
 *
 * @example
 *   matchAvailable(['fr_CA', 'fr', 'en'], ['en', 'fr']);  // → 'fr'
 *   matchAvailable(['ja_JP'],             ['en', 'fr']);  // → null
 */
function matchAvailable(requested, available) {
    if ( !Array.isArray(requested) || !Array.isArray(available) || available.length === 0 ) {
        return null;
    }
    var availableSet = Object.create(null);
    for (var i = 0; i < available.length; i++) {
        availableSet[available[i]] = true;
    }
    for (var j = 0; j < requested.length; j++) {
        var tag = requested[j];
        if ( typeof tag !== 'string' || tag.length === 0 ) continue;
        if ( availableSet[tag] ) {
            return tag;
        }
        var base = splitCulture(tag)[0];
        if ( base && base !== tag && availableSet[base] ) {
            return base;
        }
    }
    return null;
}

/**
 * #I18N1 slice 3 — read a cookie value from a raw `Cookie` header.
 *
 * @memberof module:gina/lib/i18n
 * @param   {string} header - `req.headers.cookie` value
 * @param   {string} name   - Cookie name to extract
 * @returns {string|null}   - URL-decoded value, or `null` when absent
 *
 * @example
 *   readCookie('session=abc; gina_culture=fr_CA', 'gina_culture');
 *   // → 'fr_CA'
 */
function readCookie(header, name) {
    if ( typeof header !== 'string' || typeof name !== 'string' || name.length === 0 ) {
        return null;
    }
    var pairs = header.split(';');
    for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i].trim();
        var eq = p.indexOf('=');
        if ( eq < 0 ) continue;
        var k = p.substring(0, eq).trim();
        if ( k !== name ) continue;
        var v = p.substring(eq + 1).trim();
        try { return decodeURIComponent(v); } catch (e) { return v; }
    }
    return null;
}

/**
 * #I18N1 slice 3 — resolve the culture for a request. Negotiation order
 * (highest priority first):
 *
 *   1. URL prefix — `req.routing.param.culture` when the matched route's
 *      `culturePrefix` flag is set AND the captured value matches an
 *      `availableCultures` entry.
 *   2. Cookie — value of the cookie named `opts.cookieName`, if it matches
 *      an `availableCultures` entry.
 *   3. `Accept-Language` — parsed and best-matched against `availableCultures`
 *      with q-value ordering respected.
 *   4. `opts.defaultCulture` — bundle's `settings.region.culture`.
 *   5. `GINA_CULTURE` (read via the getEnvVar accessor) — process default.
 *   6. `'en'` — hardcoded last resort.
 *
 * Returned in underscore form (`en_US`, `fr`, etc.). When `availableCultures`
 * is empty (catalogs not loaded yet), only steps 4–6 are consulted.
 *
 * @memberof module:gina/lib/i18n
 * @param   {Object}   req
 * @param   {Object}   [opts]
 * @param   {string[]} [opts.availableCultures] - Cultures the bundle has catalogs for.
 * @param   {string}   [opts.cookieName]        - From `settings.i18n.cookieName`.
 * @param   {string}   [opts.defaultCulture]    - From `settings.region.culture`.
 * @returns {string}                            - Always returns a non-empty string.
 *
 * @example
 *   negotiateCulture(req, {
 *       availableCultures: ['en', 'fr', 'en_US'],
 *       cookieName: 'gina_culture',
 *       defaultCulture: 'en_US'
 *   });
 */
function negotiateCulture(req, opts) {
    opts = opts || {};
    var available = Array.isArray(opts.availableCultures) ? opts.availableCultures : [];

    // 1. URL prefix
    if ( req && req.routing && req.routing.culturePrefix && req.routing.param ) {
        var pfx = req.routing.param.culture;
        if ( typeof pfx === 'string' && pfx.length > 0 ) {
            var pfxNorm = pfx.replace(/-/g, '_');
            var pfxMatch = matchAvailable([pfxNorm], available);
            if ( pfxMatch ) return pfxMatch;
        }
    }

    // 2. Cookie
    if ( opts.cookieName && req && req.headers && req.headers.cookie ) {
        var cookieVal = readCookie(req.headers.cookie, opts.cookieName);
        if ( typeof cookieVal === 'string' && cookieVal.length > 0 ) {
            var cookieNorm  = cookieVal.replace(/-/g, '_');
            var cookieMatch = matchAvailable([cookieNorm], available);
            if ( cookieMatch ) return cookieMatch;
        }
    }

    // 3. Accept-Language
    if ( req && req.headers && req.headers['accept-language'] ) {
        var entries = parseAcceptLanguage(req.headers['accept-language']);
        var alTags  = entries.map(function(e) { return e.tag; });
        var alMatch = matchAvailable(alTags, available);
        if ( alMatch ) return alMatch;
    }

    // 4. settings.region.culture
    if ( typeof opts.defaultCulture === 'string' && opts.defaultCulture.length > 0 ) {
        return opts.defaultCulture.replace(/-/g, '_');
    }

    // 5. GINA_CULTURE — the framework moves GINA_* off process.env into
    // process.gina at init, so read it through the getEnvVar accessor. This
    // module is strict-mode and otherwise global-free; typeof-guard the bare
    // framework global so an isolated unit-require (no boot) never
    // ReferenceErrors here.
    if ( typeof getEnvVar === 'function' ) {
        var _envCulture = getEnvVar('GINA_CULTURE');
        if ( _envCulture ) {
            return String(_envCulture).replace(/-/g, '_');
        }
    }

    // 6. Last resort
    return DEFAULT_FALLBACK_LANG;
}

module.exports = {
    // Catalog management
    loadCatalogs   : loadCatalogs,
    setCatalog     : setCatalog,
    getCatalog     : getCatalog,
    getCatalogs    : getCatalogs,
    clearCatalogs  : clearCatalogs,
    // Translation
    t              : t,
    // #I18N2 — ICU MessageFormat opt-in
    tIcu           : tIcu,
    ensureIcuLoaded: ensureIcuLoaded,
    // #I18N1 slice 3 — locale negotiation
    parseAcceptLanguage : parseAcceptLanguage,
    matchAvailable      : matchAvailable,
    readCookie          : readCookie,
    negotiateCulture    : negotiateCulture,
    // Internals exposed for testing + slice 2/3 reuse
    resolveKey     : resolveKey,
    interpolate    : interpolate,
    selectPlural   : selectPlural,
    isPluralForm   : isPluralForm,
    walkFallback   : walkFallback,
    getPluralRules : getPluralRules,
    splitCulture   : splitCulture,
    toBcp47        : toBcp47,
    // Constants
    CLDR_PLURAL_KEYS     : CLDR_PLURAL_KEYS,
    DEFAULT_FALLBACK_LANG: DEFAULT_FALLBACK_LANG,
    CULTURE_FILENAME     : CULTURE_FILENAME
};
