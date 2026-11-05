/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Content-Security-Policy plugin (#HDR5) — emits the
 * `Content-Security-Policy` (or `Content-Security-Policy-Report-Only`)
 * response header on every response, limiting which resources the browser
 * is allowed to load and from where.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp = require('gina');
 *     var csp   = require('gina').plugins.Csp({
 *         directives: {
 *             'default-src': ["'self'"],
 *             'script-src':  ["'self'", 'https://cdn.example.com'],
 *             'style-src':   ["'self'", "'unsafe-inline'"],
 *             'img-src':     ["'self'", 'data:', 'https:']
 *         }
 *     });
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(csp);
 *         event.emit('complete', app);
 *     });
 *
 * **Per-response CSP nonce (`useNonce: true`)** — opt-in (default `false`).
 * When enabled, the middleware generates a fresh cryptographically-random
 * nonce per response (`crypto.randomBytes(16).toString('base64')` — 128 bits,
 * the W3C CSP3 nonce-entropy floor), stamps it on `req._ginaCspNonce`, and
 * appends `'nonce-XXXX'` to the `script-src` directive (falling back to
 * `default-src` when `script-src` is absent; throws at factory call time if
 * neither is present, since the nonce would have nowhere to attach). The swig
 * and nunjucks render delegates read `req._ginaCspNonce` and set a matching
 * `nonce="XXXX"` attribute on every framework-injected inline `<script>` (the
 * `onGinaLoaded` bootstrap, plus the dev-only Inspector blocks). This lets a
 * bundle drop `'unsafe-inline'` from `script-src` without breaking the
 * framework bootstrap.
 *
 * When `useNonce` is `false`, the header value is computed once at factory
 * time and reused on every response (zero per-request allocation) and no
 * `req` slot is written — applications that don't opt in get the exact
 * pre-nonce behaviour.
 *
 * `req._ginaCspNonce` is the documented per-request carrier (mirrors the
 * `req._ginaProxyPrefix` precedent). It is written ONLY when gina is the one
 * setting the CSP header (the idempotent first-writer-wins guard): if an
 * upstream proxy / ingress already set the header, no nonce is generated and
 * none is emitted on the tags, keeping the header and the tags consistent.
 *
 * **Configuration is the primary API surface** — there is no sensible
 * cross-bundle default. Every bundle has its own resource graph; a default
 * policy would either be too restrictive (breaks every bundle that loads
 * external resources) or too permissive (gives no real protection). The
 * factory throws at call time if `directives` is missing or empty.
 *
 * **Strict whitelist of CSP Level 3 standard directives** — unknown
 * directive names throw at factory call time. CSP typos are silent:
 * browsers ignore unknown directive names with no error, no console
 * warning. A `scrpt-src 'self'` typo would mean NO script-source policy is
 * applied, the page is unprotected, and the developer doesn't know.
 * Fail-fast at factory call time is the only mechanism that catches this
 * class.
 *
 * Experimental / future directives (e.g. `webrtc`, `fenced-frame-src`)
 * are not yet supported. The whitelist tracks the W3C CSP Level 3 spec
 * (https://www.w3.org/TR/CSP3/#csp-directives); new entries land when the
 * spec adds them.
 *
 * **`reportOnly: true`** switches the response header name from
 * `Content-Security-Policy` to `Content-Security-Policy-Report-Only` —
 * useful for non-enforcing migration testing. The browser reports
 * violations but does not block any resources.
 *
 * In report-only mode the plugin also OMITS directives that browsers ignore
 * there (`REPORT_ONLY_IGNORED_DIRECTIVES` — currently just `sandbox`, which
 * every engine ignores in report-only: it applies a restriction but produces
 * no violation report and triggers a browser console warning). The omission
 * is functionally identical (the directive does nothing in report-only) and
 * silences that console warning; a one-time factory-time `console.warn`
 * names what was dropped. The omitted directives remain in the configured
 * set, so an enforcing factory built from the same config still emits them.
 * `frame-ancestors` is NOT omitted — its report-only behaviour is
 * engine-divergent: the CSP3 spec, Gecko and Blink evaluate it and send
 * violation reports (without enforcing), while WebKit alone ignores it with
 * a console warning and no report (it retains CSP2's rule that the directive
 * MUST be ignored when monitoring, which CSP3 dropped). Keeping it preserves
 * the observation-phase signal on Chrome + Firefox; WebKit-heavy consumers
 * can opt it out via `reportOnlyOmit` (below). A report-only policy whose
 * every directive is inert (e.g. only `sandbox`) throws at factory call
 * time.
 *
 * **`reportOnlyOmit: ['frame-ancestors']`** (opt-in, default `[]`) extends
 * the report-only omission to consumer-chosen directives: every directive
 * named is omitted from the report-only header and emitted again
 * automatically when `reportOnly` flips to `false` — one directive set
 * across both modes, no remove-then-re-add churn. Built for the
 * engine-divergent case above: a consumer serving WebKit-heavy audiences can
 * drop `frame-ancestors` for a clean Safari console, explicitly trading away
 * the Chrome + Firefox report-only signal (the header is engine-blind; the
 * option just makes that trade an explicit, lifecycle-managed choice). The
 * factory-time `console.warn` for these uses wording distinct from the
 * browser-inert omission above — they are NOT ignored by browsers. Entries
 * are validated against the same CSP Level 3 whitelist as `directives` keys
 * (unknown names throw); an entry not present in `directives` warns in
 * report-only mode (likely a config mistake) and no-ops; with
 * `reportOnly: false` the option is inert and silent — an enforce-mode
 * config is EXPECTED to keep carrying it.
 * `useNonce: true` with the nonce-target directive (script-src /
 * default-src) in `reportOnlyOmit` throws at factory call time — the nonce
 * would be stamped on the request and the tags but never referenced by the
 * emitted policy.
 *
 * Opens Phase 2 of the gina security-headers track (Phase 1 = HDR1-4 +
 * HDR7 shipped in 0.3.15-alpha). Single-header plugin shape — composes
 * cleanly under the future `SecurityHeaders` combined wrapper (#HDR15).
 *
 * @module plugins/security-headers/csp
 */

var crypto = require('crypto');

var HEADER_NAME             = 'content-security-policy';
var HEADER_NAME_REPORT_ONLY = 'content-security-policy-report-only';
var DEFAULT_REPORT_ONLY     = false;
var DEFAULT_USE_NONCE       = false;
var NONCE_BYTES             = 16;   // 128 bits — the W3C CSP3 nonce-entropy floor

/**
 * CSP Level 3 standard directives, alphabetical within category.
 *
 * Reference: https://www.w3.org/TR/CSP3/#csp-directives
 *
 * @constant
 * @type {string[]}
 */
var VALID_DIRECTIVES = [
    // Fetch directives
    'child-src',
    'connect-src',
    'default-src',
    'font-src',
    'frame-src',
    'img-src',
    'manifest-src',
    'media-src',
    'object-src',
    'prefetch-src',
    'script-src',
    'script-src-attr',
    'script-src-elem',
    'style-src',
    'style-src-attr',
    'style-src-elem',
    'worker-src',
    // Document directives
    'base-uri',
    'sandbox',
    // Navigation directives
    'form-action',
    'frame-ancestors',
    // Reporting directives
    'report-to',
    'report-uri',
    // Document policies
    'block-all-mixed-content',
    'upgrade-insecure-requests',
    // Trusted Types
    'require-trusted-types-for',
    'trusted-types'
];

/**
 * Boolean-only directives (presence-or-absence semantics — value must be
 * `true` to emit or `false` to omit; string/array values throw).
 *
 * @constant
 * @type {string[]}
 */
var BOOLEAN_ONLY_DIRECTIVES = [
    'block-all-mixed-content',
    'upgrade-insecure-requests'
];

/**
 * Hybrid directives that accept EITHER boolean true (emit name alone) OR a
 * source-list value (string / array). Per CSP Level 3, `sandbox` with no
 * value applies all sandbox restrictions; with a value, allows specific
 * exceptions (e.g. `sandbox allow-scripts`).
 *
 * @constant
 * @type {string[]}
 */
var HYBRID_DIRECTIVES = [
    'sandbox'
];

/**
 * Directives that browsers IGNORE when delivered in a
 * `Content-Security-Policy-Report-Only` header. A report-only policy monitors
 * and reports violations but enforces nothing; `sandbox` applies a
 * document-level restriction that produces no reportable violation, so the
 * browser drops it in report-only mode AND emits a console warning
 * ("Ignoring sandbox directive when delivered in a report-only policy"). It
 * therefore contributes browser-console noise and zero monitoring value, so
 * the plugin omits it from a report-only header (see the `reportOnly` notes in
 * the module docstring above).
 *
 * Deliberately conservative — `sandbox` is the only directive confirmed
 * ignored in report-only across ALL engines: CSP2 spec text ("The sandbox
 * directive will be ignored when monitoring a policy"), MDN's Report-Only
 * page ("supports all Content-Security-Policy directives except sandbox,
 * which is ignored"), Chromium's SupportedInReportOnly() (false for
 * Sandbox), and WebKit's console warning. Intentionally NOT included:
 *  - `frame-ancestors` — report-only behaviour is ENGINE-DIVERGENT. The CSP3
 *    spec, Gecko and Blink evaluate it and send violation reports without
 *    enforcing (Chromium's SupportedInReportOnly() is true for
 *    FrameAncestors; the WPT report-only frame-ancestors test asserts the
 *    report). WebKit alone ignores it, logs "The Content Security Policy
 *    directive 'frame-ancestors' is ignored when delivered in a report-only
 *    policy." and sends no report — it retains CSP2's "MUST be ignored when
 *    monitoring a policy", which CSP3 dropped (CSP3 restricts only `<meta>`
 *    delivery, which a report-only policy cannot use anyway). Omitting it
 *    would discard the observation-phase signal on Chrome + Firefox;
 *    consumers serving WebKit-heavy audiences that want a clean Safari
 *    console can opt it out per-config via `reportOnlyOmit:
 *    ['frame-ancestors']` — omitted in report-only, auto-restored in
 *    enforce mode (clickjacking stays enforced by X-Frame-Options and/or an
 *    enforcing frame-ancestors regardless).
 *  - `upgrade-insecure-requests` / `block-all-mixed-content` — not confirmed
 *    inert across engines: Chromium ignores-and-warns
 *    `upgrade-insecure-requests` in report-only but supports
 *    `block-all-mixed-content` there, and Gecko/WebKit behaviour is
 *    unverified; excluded under uncertainty (omitting a directive that may
 *    still act/report would lose behaviour or signal). Expanding this list
 *    requires an empirical per-engine check first.
 *
 * @constant
 * @type {string[]}
 */
var REPORT_ONLY_IGNORED_DIRECTIVES = [
    'sandbox'
];


/**
 * Read the active bundle's `settings.json > csp.*` block and return the
 * merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `Csp()` invoked at module-require time, before `onInitialize`).
 *
 * @returns {object}
 * @inner
 * @private
 */
function resolveSettingsDefaults() {
    var defaults   = {};
    var pluginConf = {};

    try {
        var ctx    = getContext();
        var bundle = ctx && ctx.bundle;
        var env    = ctx && ctx.env;
        var conf   = (typeof getConfig === 'function') ? getConfig() : null;
        if (bundle && env && conf && conf[bundle] && conf[bundle][env]) {
            var content  = conf[bundle][env].content || {};
            var settings = content.settings || {};
            pluginConf   = settings.csp || {};
        }
    } catch (ignored) {
        pluginConf = {};
    }

    for (var k in pluginConf) {
        if (Object.prototype.hasOwnProperty.call(pluginConf, k)) {
            defaults[k] = pluginConf[k];
        }
    }

    return defaults;
}


/**
 * Merge caller-supplied options on top of the resolved defaults. Caller-
 * supplied values always win (`hasOwnProperty`-guarded). Shallow — the
 * `directives` object is replaced wholesale by the caller's `directives`,
 * not key-by-key merged. Callers that want to merge with settings
 * explicitly can do so before passing.
 *
 * @param {object|undefined} caller
 * @param {object}           defaults
 * @returns {object}
 * @inner
 * @private
 */
function mergeOptions(caller, defaults) {
    caller = caller || {};
    var merged = {};
    for (var dk in defaults) {
        if (Object.prototype.hasOwnProperty.call(defaults, dk)) merged[dk] = defaults[dk];
    }
    for (var ck in caller) {
        if (Object.prototype.hasOwnProperty.call(caller, ck)) merged[ck] = caller[ck];
    }
    return merged;
}


/**
 * Validate and normalise the `directives` object.
 *
 * Throws at factory call time for:
 *  - missing / non-object / empty `directives`
 *  - unknown directive name (not in CSP Level 3 standard whitelist)
 *  - boolean value on a source-list directive that isn't `sandbox`
 *  - non-boolean value on a boolean-only directive
 *  - non-string array entries
 *  - all-omitted result (every entry resolved to `false`)
 *
 * Returns a normalised dict where values are one of: `true` (emit name
 * alone), string (emit name + space + string), array (emit name + space +
 * space-joined). Omitted directives (`false`) are excluded.
 *
 * @param {object} directives
 * @returns {object}
 * @throws  {Error}
 * @inner
 * @private
 */
function resolveDirectives(directives) {
    if (!directives || typeof directives !== 'object' || Array.isArray(directives)) {
        throw new Error(
            '[gina.plugins.Csp] directives is required and must be a non-empty object. '
            + 'There is no sensible cross-bundle default; every bundle has its own '
            + 'resource graph. See https://www.w3.org/TR/CSP3/#csp-directives for the '
            + 'directive list.'
        );
    }

    var keys = Object.keys(directives);
    if (keys.length === 0) {
        throw new Error(
            '[gina.plugins.Csp] directives must contain at least one directive — '
            + 'received an empty object. See https://www.w3.org/TR/CSP3/#csp-directives'
        );
    }

    var normalised = {};
    for (var i = 0; i < keys.length; i++) {
        var originalKey   = keys[i];
        var directiveName = String(originalKey).toLowerCase();
        var value         = directives[originalKey];

        if (VALID_DIRECTIVES.indexOf(directiveName) === -1) {
            throw new Error(
                '[gina.plugins.Csp] unknown directive name "' + originalKey + '". '
                + 'Expected one of: ' + VALID_DIRECTIVES.join(', ') + '. '
                + '(Per CSP Level 3 — https://www.w3.org/TR/CSP3/#csp-directives. '
                + 'Experimental / future directives are not yet supported; '
                + 'open an issue to request inclusion.)'
            );
        }

        // false omits the directive (regardless of category)
        if (value === false) continue;

        var isBooleanOnly = BOOLEAN_ONLY_DIRECTIVES.indexOf(directiveName) !== -1;
        var isHybrid      = HYBRID_DIRECTIVES.indexOf(directiveName) !== -1;

        if (isBooleanOnly) {
            if (value !== true) {
                throw new Error(
                    '[gina.plugins.Csp] directive "' + directiveName + '" is boolean-only '
                    + '(presence-or-absence per CSP Level 3); value must be true (emit) '
                    + 'or false (omit). Received: ' + JSON.stringify(value) + '.'
                );
            }
            normalised[directiveName] = true;
            continue;
        }

        if (value === true) {
            if (!isHybrid) {
                throw new Error(
                    '[gina.plugins.Csp] directive "' + directiveName + '" is a source-list '
                    + 'directive; value must be a string (e.g. "\'self\' https:"), an array '
                    + 'of source-list tokens (e.g. ["\'self\'", "https:"]), or false to '
                    + 'omit. Boolean true is only valid for boolean-only and hybrid '
                    + 'directives (sandbox).'
                );
            }
            normalised[directiveName] = true;
            continue;
        }

        if (typeof value === 'string') {
            normalised[directiveName] = value;
            continue;
        }

        if (Array.isArray(value)) {
            for (var j = 0; j < value.length; j++) {
                if (typeof value[j] !== 'string') {
                    throw new Error(
                        '[gina.plugins.Csp] directive "' + directiveName + '" array '
                        + 'entries must be strings; received ' + typeof value[j]
                        + ' at index ' + j + '.'
                    );
                }
            }
            normalised[directiveName] = value.slice();
            continue;
        }

        throw new Error(
            '[gina.plugins.Csp] directive "' + directiveName + '" value must be a '
            + 'string, an array of strings, or false; received ' + typeof value + '.'
        );
    }

    if (Object.keys(normalised).length === 0) {
        throw new Error(
            '[gina.plugins.Csp] directives object resolved to zero enabled directives '
            + '— every entry was omitted (false). Set at least one directive to a '
            + 'source-list value or true.'
        );
    }

    return normalised;
}


/**
 * Coerce reportOnly to a strict boolean. Defaults to false (emit
 * Content-Security-Policy). True emits Content-Security-Policy-Report-Only
 * instead — browsers report violations but do not block resources.
 *
 * @param {*} value
 * @returns {boolean}
 * @throws  {Error}
 * @inner
 * @private
 */
function resolveReportOnly(value) {
    if (typeof value === 'undefined' || value === null) {
        return DEFAULT_REPORT_ONLY;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    throw new Error(
        '[gina.plugins.Csp] reportOnly must be a boolean (true emits '
        + 'Content-Security-Policy-Report-Only, false emits '
        + 'Content-Security-Policy); received ' + typeof value + '.'
    );
}


/**
 * Validate and normalise the `reportOnlyOmit` option — consumer-chosen
 * directives to ALSO omit from a report-only header, on top of the
 * universally-inert `REPORT_ONLY_IGNORED_DIRECTIVES`. Defaults to `[]`.
 *
 * Entries are lowercased and validated against the same CSP Level 3
 * whitelist as `directives` keys; duplicates are dropped. Only consulted
 * when `reportOnly` is true (inert and silent otherwise — keeping it in an
 * enforce-mode config is the expected lifecycle state, not a mistake), but
 * validated unconditionally so a malformed entry fails at boot rather than
 * surfacing on the next `reportOnly` flip.
 *
 * @param {*} value
 * @returns {string[]} normalised, deduplicated directive names.
 * @throws  {Error} on non-array shapes, non-string entries, unknown names.
 * @inner
 * @private
 */
function resolveReportOnlyOmit(value) {
    if (typeof value === 'undefined' || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(
            '[gina.plugins.Csp] reportOnlyOmit must be an array of CSP directive '
            + 'names to omit from a report-only header (e.g. ["frame-ancestors"]); '
            + 'received ' + typeof value + '.'
        );
    }
    var out = [];
    for (var i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') {
            throw new Error(
                '[gina.plugins.Csp] reportOnlyOmit entries must be strings; '
                + 'received ' + typeof value[i] + ' at index ' + i + '.'
            );
        }
        var name = String(value[i]).toLowerCase();
        if (VALID_DIRECTIVES.indexOf(name) === -1) {
            throw new Error(
                '[gina.plugins.Csp] unknown directive name "' + value[i] + '" in '
                + 'reportOnlyOmit. Expected one of: ' + VALID_DIRECTIVES.join(', ')
                + '. (Per CSP Level 3 — https://www.w3.org/TR/CSP3/#csp-directives.)'
            );
        }
        if (out.indexOf(name) === -1) {
            out.push(name);
        }
    }
    return out;
}


/**
 * Build the header value string from a normalised directive dict.
 *
 * Per CSP Level 3 §3.1: directives are separated by `;`; each directive
 * consists of a directive name + space + space-separated source-list
 * values (or just the directive name for boolean-only / empty `sandbox`).
 *
 * When `nonce` is supplied, the matching `'nonce-<value>'` source-expression
 * is appended to the `nonceTarget` directive only (the rest are untouched).
 * Called with one argument (the static path), `nonce` is `undefined` and the
 * output is identical to the pre-nonce behaviour.
 *
 * @param {object}  normalised
 * @param {string} [nonce]       — raw base64 nonce value (no `nonce-` prefix).
 * @param {string} [nonceTarget] — directive name to append the nonce to.
 * @returns {string}
 * @inner
 * @private
 */
function buildHeaderValue(normalised, nonce, nonceTarget) {
    var parts = [];
    var keys  = Object.keys(normalised);
    for (var i = 0; i < keys.length; i++) {
        var name  = keys[i];
        var value = normalised[name];
        var extra = (nonce && name === nonceTarget) ? (" 'nonce-" + nonce + "'") : '';
        if (value === true) {
            parts.push(name + extra);
        } else if (typeof value === 'string') {
            parts.push(name + ' ' + value + extra);
        } else if (Array.isArray(value)) {
            parts.push(name + ' ' + value.join(' ') + extra);
        }
    }
    return parts.join('; ');
}


/**
 * Return a shallow copy of the normalised directive dict with the
 * report-only-inert directives (`REPORT_ONLY_IGNORED_DIRECTIVES`) removed,
 * plus any consumer-chosen `extraOmit` names (the validated `reportOnlyOmit`
 * option). Used only when `reportOnly` is true. Pure — never mutates the
 * input, so the full configured set survives for an enforcing factory built
 * from the same directives. Called with one argument, behaviour is identical
 * to the pre-`reportOnlyOmit` shape (inert set only).
 *
 * @param {object}    normalised — validated directive dict from resolveDirectives.
 * @param {string[]} [extraOmit] — validated `reportOnlyOmit` names (default none).
 * @returns {object} a new dict without the omitted directives.
 * @inner
 * @private
 */
function stripReportOnlyIgnored(normalised, extraOmit) {
    var omit = extraOmit || [];
    var out  = {};
    var keys = Object.keys(normalised);
    for (var i = 0; i < keys.length; i++) {
        var name = keys[i];
        if (REPORT_ONLY_IGNORED_DIRECTIVES.indexOf(name) !== -1 || omit.indexOf(name) !== -1) {
            continue;
        }
        out[name] = normalised[name];
    }
    return out;
}


/**
 * Coerce `useNonce` to a strict boolean. Defaults to `false` (static header,
 * no per-request nonce). `true` opts into per-response nonce generation.
 *
 * @param {*} value
 * @returns {boolean}
 * @throws  {Error}
 * @inner
 * @private
 */
function resolveUseNonce(value) {
    if (typeof value === 'undefined' || value === null) {
        return DEFAULT_USE_NONCE;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    throw new Error(
        '[gina.plugins.Csp] useNonce must be a boolean (true generates a '
        + 'per-response nonce and appends it to script-src; false emits a '
        + 'static policy); received ' + typeof value + '.'
    );
}


/**
 * Resolve which directive the per-response nonce attaches to. Prefers
 * `script-src` (the directive governing inline `<script>` execution), falling
 * back to `default-src`. Throws at factory call time when neither is present —
 * `useNonce: true` is meaningless if there is no script-governing directive
 * for the nonce to extend.
 *
 * @param {object} normalised — the validated directive dict.
 * @returns {string}
 * @throws  {Error}
 * @inner
 * @private
 */
function resolveNonceTarget(normalised) {
    if (Object.prototype.hasOwnProperty.call(normalised, 'script-src')) {
        return 'script-src';
    }
    if (Object.prototype.hasOwnProperty.call(normalised, 'default-src')) {
        return 'default-src';
    }
    throw new Error(
        '[gina.plugins.Csp] useNonce:true requires a "script-src" (or '
        + '"default-src") directive for the per-response nonce to attach to; '
        + 'neither is present. Add "script-src" to your directives — that is '
        + 'the directive governing inline <script> execution.'
    );
}


/**
 * Return an express-compatible middleware that sets the
 * `Content-Security-Policy` (or `Content-Security-Policy-Report-Only`)
 * response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var csp = require('gina').plugins.Csp({
 *     directives: {
 *         'default-src': ["'self'"],
 *         'script-src':  ["'self'", 'https://cdn.example.com'],
 *         'upgrade-insecure-requests': true
 *     },
 *     reportOnly: false
 * });
 * app.use(csp);
 *
 * @example
 * // Per-response nonce — drop 'unsafe-inline' from script-src. The framework
 * // bootstrap + Inspector inline <script>s automatically carry the nonce.
 * var csp = require('gina').plugins.Csp({
 *     directives: { 'script-src': ["'self'"] },
 *     useNonce: true
 * });
 * app.use(csp);
 * // → Content-Security-Policy: script-src 'self' 'nonce-<base64>'
 *
 * @param   {object}  opts
 * @param   {object}  opts.directives          — CSP Level 3 directives.
 *                                               Required; throws if missing
 *                                               or empty. Keys: directive
 *                                               names (case-insensitive,
 *                                               validated against CSP
 *                                               Level 3 whitelist). Values:
 *                                               string (source list), array
 *                                               of strings, true (boolean-
 *                                               only / sandbox-with-no-
 *                                               value), or false (omit).
 * @param   {boolean} [opts.reportOnly=false]  — emit
 *                                               Content-Security-Policy-
 *                                               Report-Only instead of
 *                                               Content-Security-Policy.
 * @param   {string[]} [opts.reportOnlyOmit=[]] — directive names to ALSO
 *                                               omit when reportOnly is
 *                                               true (validated against
 *                                               the CSP Level 3
 *                                               whitelist); emitted again
 *                                               automatically when
 *                                               reportOnly is false. Inert
 *                                               and silent in enforce
 *                                               mode.
 * @param   {boolean} [opts.useNonce=false]    — generate a per-response
 *                                               nonce, stamp it on
 *                                               `req._ginaCspNonce`, and
 *                                               append `'nonce-XXXX'` to
 *                                               script-src (fallback
 *                                               default-src). Lets bundles
 *                                               drop `'unsafe-inline'`.
 * @returns {function}                         — express middleware
 *                                               `(req, res, next) => void`
 * @throws  {Error}                            — when `directives` is
 *                                               missing/empty, contains an
 *                                               unknown directive name, has
 *                                               invalid value shapes,
 *                                               `useNonce:true` with no
 *                                               script-src/default-src,
 *                                               `reportOnlyOmit` is
 *                                               malformed or names an
 *                                               unknown directive, the
 *                                               report-only set is empty
 *                                               after omissions, or
 *                                               `reportOnlyOmit` omits the
 *                                               nonce target in report-only
 *                                               mode.
 *
 * @example
 * // Engine-divergent directive opt-out: omit frame-ancestors from the
 * // report-only header (clean WebKit console; forgoes the Gecko + Blink
 * // report signal) — restored automatically at the enforce flip.
 * var csp = require('gina').plugins.Csp({
 *     reportOnly: true,
 *     directives: { 'script-src': ["'self'"], 'frame-ancestors': ["'self'"] },
 *     reportOnlyOmit: ['frame-ancestors']
 * });
 * app.use(csp);
 */
function Csp(opts) {
    var defaults    = resolveSettingsDefaults();
    var merged      = mergeOptions(opts, defaults);

    var directives  = resolveDirectives(merged.directives);
    var reportOnly  = resolveReportOnly(merged.reportOnly);
    var useNonce    = resolveUseNonce(merged.useNonce);
    var reportOnlyOmit = resolveReportOnlyOmit(merged.reportOnlyOmit);

    // Report-only mode: drop directives browsers ignore in a report-only
    // header (REPORT_ONLY_IGNORED_DIRECTIVES — currently `sandbox`), plus any
    // consumer-chosen `reportOnlyOmit` names (typically engine-divergent
    // directives like frame-ancestors). Both survive in `directives`, so an
    // enforcing factory built from the same config still emits them.
    var emitDirectives = directives;
    if (reportOnly) {
        emitDirectives = stripReportOnlyIgnored(directives, reportOnlyOmit);
        var dropped = Object.keys(directives).filter(function (d) {
            return !Object.prototype.hasOwnProperty.call(emitDirectives, d);
        });
        // Split by cause — the warn/throw wording must not claim "ignored by
        // browsers" for a directive the consumer chose to drop: an opted-out
        // directive like frame-ancestors IS evaluated + reported by some
        // engines (Gecko, Blink) in report-only mode.
        var droppedInert = dropped.filter(function (d) {
            return REPORT_ONLY_IGNORED_DIRECTIVES.indexOf(d) !== -1;
        });
        var droppedOpted = dropped.filter(function (d) {
            return REPORT_ONLY_IGNORED_DIRECTIVES.indexOf(d) === -1;
        });
        var absentOmit = reportOnlyOmit.filter(function (d) {
            return !Object.prototype.hasOwnProperty.call(directives, d);
        });
        if (Object.keys(emitDirectives).length === 0) {
            if (droppedOpted.length > 0) {
                throw new Error(
                    '[gina.plugins.Csp] reportOnly:true but the emitted directive set is '
                    + 'empty after omissions ('
                    + (droppedInert.length > 0 ? 'ignored by browsers: ' + droppedInert.join(', ') + '; ' : '')
                    + 'per reportOnlyOmit: ' + droppedOpted.join(', ') + '). '
                    + 'A report-only policy needs at least one emitted directive that '
                    + 'produces violation reports (e.g. script-src / default-src). '
                    + 'Remove entries from reportOnlyOmit or add directives.'
                );
            }
            // Mirrors the all-omitted throw in resolveDirectives: an empty CSP
            // is invalid, and a report-only policy made entirely of inert
            // directives reports nothing — surface it at factory (boot) time.
            throw new Error(
                '[gina.plugins.Csp] reportOnly:true but every configured directive is '
                + 'ignored by browsers in report-only mode (' + dropped.join(', ') + '). '
                + 'A report-only policy needs at least one directive that produces '
                + 'violation reports (e.g. script-src / default-src / frame-ancestors). '
                + 'sandbox applies a restriction but reports nothing, so it is dropped '
                + 'in report-only mode.'
            );
        }
        if (droppedInert.length > 0) {
            // Transparency: the emitted header diverges from the configured
            // directives. One line at factory (boot) time — per call, no
            // module-level latch — so the operator knows why a configured
            // directive is absent from the wire.
            console.warn(
                '[gina.plugins.Csp] reportOnly:true — omitting directive(s) ignored by '
                + 'browsers in report-only mode: ' + droppedInert.join(', ') + '. They apply no '
                + 'restriction and emit a browser console warning in report-only mode; they '
                + 'are included automatically when reportOnly is false.'
            );
        }
        if (droppedOpted.length > 0) {
            // Distinct wording — these are NOT browser-inert: some engines
            // (Gecko + Blink for frame-ancestors) evaluate and report them in
            // report-only mode; the consumer is forgoing that signal.
            console.warn(
                '[gina.plugins.Csp] reportOnly:true — omitting directive(s) per '
                + 'reportOnlyOmit: ' + droppedOpted.join(', ') + '. These are evaluated and '
                + 'reported by some engines in report-only mode; you are forgoing that '
                + 'monitoring signal. They are emitted automatically when reportOnly is '
                + 'false.'
            );
        }
        if (absentOmit.length > 0) {
            // Omitting something you don't emit signals a config mistake.
            // Emitted AFTER the empty-set throws above so a fatally-broken
            // config surfaces only its throw, not a warn-then-throw sequence.
            console.warn(
                '[gina.plugins.Csp] reportOnlyOmit names directive(s) not present in '
                + 'directives (no-op): ' + absentOmit.join(', ') + '.'
            );
        }
    }

    var headerName  = reportOnly ? HEADER_NAME_REPORT_ONLY : HEADER_NAME;
    // Static value — reused on every response when useNonce is off.
    var headerValue = buildHeaderValue(emitDirectives);
    // Fail-fast at factory time: a nonce needs a script-governing directive.
    // Resolved from `directives` (not emitDirectives) — the nonce target is
    // always script-src/default-src, which REPORT_ONLY_IGNORED_DIRECTIVES
    // never contains and the guard below keeps out of reportOnlyOmit, so the
    // two sets agree; the middleware still serialises emitDirectives.
    var nonceTarget = useNonce ? resolveNonceTarget(directives) : null;
    if (nonceTarget && reportOnly && reportOnlyOmit.indexOf(nonceTarget) !== -1) {
        // The nonce would be stamped on req._ginaCspNonce and mirrored onto
        // the framework inline <script> tags, but the emitted report-only
        // policy would never reference it — incoherent header/tag state.
        throw new Error(
            '[gina.plugins.Csp] useNonce:true with reportOnly:true requires the '
            + 'nonce target directive ("' + nonceTarget + '") to be emitted in the '
            + 'report-only header, but reportOnlyOmit omits it. Remove "'
            + nonceTarget + '" from reportOnlyOmit.'
        );
    }

    return function ginaCsp(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(headerName)) {
            return next();
        }
        if (useNonce) {
            // Fresh per-response nonce; stamp the per-request carrier so the
            // render delegates can mirror it onto framework inline <script>s.
            var nonce = crypto.randomBytes(NONCE_BYTES).toString('base64');
            if (req) { req._ginaCspNonce = nonce; }
            res.setHeader(headerName, buildHeaderValue(emitDirectives, nonce, nonceTarget));
        } else {
            res.setHeader(headerName, headerValue);
        }
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
Csp._HEADER_NAME              = HEADER_NAME;
Csp._HEADER_NAME_REPORT_ONLY  = HEADER_NAME_REPORT_ONLY;
Csp._DEFAULT_REPORT_ONLY      = DEFAULT_REPORT_ONLY;
Csp._DEFAULT_USE_NONCE        = DEFAULT_USE_NONCE;
Csp._NONCE_BYTES              = NONCE_BYTES;
Csp._VALID_DIRECTIVES         = VALID_DIRECTIVES;
Csp._BOOLEAN_ONLY_DIRECTIVES  = BOOLEAN_ONLY_DIRECTIVES;
Csp._HYBRID_DIRECTIVES        = HYBRID_DIRECTIVES;
Csp._resolveSettingsDefaults  = resolveSettingsDefaults;
Csp._mergeOptions             = mergeOptions;
Csp._resolveDirectives        = resolveDirectives;
Csp._resolveReportOnly        = resolveReportOnly;
Csp._resolveReportOnlyOmit    = resolveReportOnlyOmit;
Csp._resolveUseNonce          = resolveUseNonce;
Csp._resolveNonceTarget       = resolveNonceTarget;
Csp._buildHeaderValue         = buildHeaderValue;
Csp._REPORT_ONLY_IGNORED_DIRECTIVES = REPORT_ONLY_IGNORED_DIRECTIVES;
Csp._stripReportOnlyIgnored         = stripReportOnlyIgnored;

module.exports = Csp;
