/**
 * @module inspector-redact
 *
 * Redacts secret-looking keys from Inspector payloads before they are shipped
 * to window.__ginaData, localStorage.__ginaData, or /_gina/agent SSE frames.
 *
 * Dev-mode only. Never applied to the actual HTTP response body — the template
 * still receives the real data object; only the Inspector clone is redacted.
 *
 * Configuration is read from settings.json:
 *
 *   "inspector": {
 *       "redact": {
 *           "patterns": ["password", "pwd", "token", ...],   // optional — extends/replaces defaults
 *           "types":    ["password"],                         // client-side DOM input types
 *           "replacement": "[redacted]"                        // optional
 *       }
 *   }
 *
 * Matching strategy:
 *   The key is tokenized on `_-.[]:/whitespace` and camelCase boundaries, then
 *   each anchored pattern is tested against (a) every individual token, and
 *   (b) the joined-tokens form. So `apiKey`, `api_key`, and `apikey` all match
 *   the pattern `apikey`, while `companyName` and `lastCompanyUsedId` no longer
 *   false-positive on `pan` / `ssn` / `cvv` substrings.
 *
 * When `patterns` or `types` is omitted, the defaults below are used.
 */

'use strict';

// Patterns are matched against individual tokens or the joined-tokens form,
// not raw key substrings. `apikey` covers `apiKey` / `api_key` / `apikey`
// because `tokenize` strips separators and case before matching.
var DEFAULT_PATTERNS = [
    'password', 'passwd', 'pwd',
    'secret',
    'token', 'apikey',
    'cvv', 'cvc', 'ccv',
    'pan', 'ssn',
    'authorization', 'credentials',
    'privatekey'
];

var DEFAULT_TYPES = ['password'];
var REPLACEMENT   = '[redacted]';

// Anchored at both ends so a single token equal to the suffix word triggers
// the carve-out (e.g. last token `rule` in `passwordRule`). Prevents false
// positives like `overrules` (one token, not exactly `rules`).
var NON_SECRET_SUFFIX = /^(rule|rules|policy|policies|validator|config|configuration|settings|setting|meta|metadata|format|requirements|strength|constraint|constraints|options|option|schema|definition|definitions|spec|specs)$/i;

/**
 * Split a key into lowercase tokens. Separators (`_-.[]:/whitespace`) and
 * camelCase boundaries both produce token breaks.
 * @param {string} key
 * @returns {string[]}
 */
function tokenize(key) {
    if (typeof key !== 'string' || key.length === 0) return [];
    // Insert spaces at camelCase boundaries: `apiKey` → `api Key`,
    // `XMLParser` → `XML Parser`, `lastCompanyUsedId` → `last Company Used Id`.
    var spaced = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    var parts = spaced.split(/[\s_\-.\[\]:\/]+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].length > 0) out.push(parts[i].toLowerCase());
    }
    return out;
}

/**
 * Compile an array of regex source strings into anchored RegExp objects.
 * Each pattern is wrapped as `^(?:<source>)$` so it must match the whole
 * token (or whole joined-tokens string), never a substring. Invalid entries
 * are dropped silently so a bad config key cannot crash a render.
 * @param {string[]} patterns
 * @returns {RegExp[]}
 */
function compile(patterns) {
    var out = [];
    if (!Array.isArray(patterns)) return out;
    for (var i = 0; i < patterns.length; i++) {
        try { out.push(new RegExp('^(?:' + patterns[i] + ')$', 'i')); } catch (e) { /* skip */ }
    }
    return out;
}

/**
 * @param {string} key
 * @param {RegExp[]} compiled
 * @returns {boolean}
 */
function keyMatches(key, compiled) {
    if (typeof key !== 'string') return false;
    var tokens = tokenize(key);
    if (tokens.length === 0) return false;
    // Suffix carve-out: keys whose last token is a metadata word describe
    // validation rules / config / schema, not user input — pass through.
    if (NON_SECRET_SUFFIX.test(tokens[tokens.length - 1])) return false;
    var joined = tokens.join('');
    for (var i = 0; i < compiled.length; i++) {
        var re = compiled[i];
        if (re.test(joined)) return true;
        for (var t = 0; t < tokens.length; t++) {
            if (re.test(tokens[t])) return true;
        }
    }
    return false;
}

function walk(value, compiled, replacement, maxDepth, depth, seen) {
    if (depth > maxDepth) return value;
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        var arr = new Array(value.length);
        for (var i = 0; i < value.length; i++) {
            arr[i] = walk(value[i], compiled, replacement, maxDepth, depth + 1, seen);
        }
        return arr;
    }

    var out  = {};
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var v   = value[key];
        if (keyMatches(key, compiled)) {
            // Only primitive leaf values are redacted. Object/array values under
            // a secret-like key are metadata (validation rules, error maps,
            // validator specs keyed by form field name like `account[password]`)
            // — walk into them so any primitive secrets nested deeper still get
            // caught, but the rule structure itself passes through.
            if (v === null || typeof v === 'undefined') {
                out[key] = v;
            } else if (typeof v === 'object') {
                out[key] = walk(v, compiled, replacement, maxDepth, depth + 1, seen);
            } else {
                out[key] = replacement;
            }
        } else {
            out[key] = walk(v, compiled, replacement, maxDepth, depth + 1, seen);
        }
    }
    return out;
}

/**
 * Walk `obj` and replace values whose key matches any redaction pattern with
 * `replacement` (default `[redacted]`). Returns a deep-cloned copy — the
 * input object is never mutated. Circular references become `'[circular]'`.
 *
 * @param {*} obj
 * @param {object} [options]
 * @param {string[]} [options.patterns]            - raw regex source strings (ignored if compiledPatterns is set)
 * @param {RegExp[]} [options.compiledPatterns]
 * @param {string}   [options.replacement='[redacted]']
 * @param {number}   [options.maxDepth=50]
 * @returns {*}
 */
function redact(obj, options) {
    options = options || {};
    var compiled = options.compiledPatterns
        || compile(options.patterns || DEFAULT_PATTERNS);
    var replacement = (typeof options.replacement === 'string') ? options.replacement : REPLACEMENT;
    var maxDepth    = (typeof options.maxDepth === 'number') ? options.maxDepth : 50;
    return walk(obj, compiled, replacement, maxDepth, 0, new WeakSet());
}

/**
 * Resolve redaction configuration from a bundle's conf object. Accepts either
 * `conf.inspector.redact` or `conf.content.inspector.redact` — whichever
 * exists wins. Unknown/invalid keys fall back to defaults.
 *
 * @param {object} conf
 * @returns {{patterns:string[], types:string[], replacement:string, compiledPatterns:RegExp[]}}
 */
function getConfig(conf) {
    var redactConf = null;
    if (conf) {
        if (conf.inspector && conf.inspector.redact) {
            redactConf = conf.inspector.redact;
        } else if (conf.content && conf.content.settings && conf.content.settings.inspector && conf.content.settings.inspector.redact) {
            redactConf = conf.content.settings.inspector.redact;
        } else if (conf.content && conf.content.inspector && conf.content.inspector.redact) {
            redactConf = conf.content.inspector.redact;
        } else if (conf.settings && conf.settings.inspector && conf.settings.inspector.redact) {
            redactConf = conf.settings.inspector.redact;
        }
    }
    redactConf = redactConf || {};

    var patterns = (Array.isArray(redactConf.patterns) && redactConf.patterns.length > 0)
        ? redactConf.patterns : DEFAULT_PATTERNS;
    var types = (Array.isArray(redactConf.types) && redactConf.types.length > 0)
        ? redactConf.types : DEFAULT_TYPES;
    var replacement = (typeof redactConf.replacement === 'string' && redactConf.replacement)
        ? redactConf.replacement : REPLACEMENT;

    return {
        patterns         : patterns,
        types            : types,
        replacement      : replacement,
        compiledPatterns : compile(patterns)
    };
}

module.exports = {
    DEFAULT_PATTERNS    : DEFAULT_PATTERNS,
    DEFAULT_TYPES       : DEFAULT_TYPES,
    REPLACEMENT         : REPLACEMENT,
    NON_SECRET_SUFFIX   : NON_SECRET_SUFFIX,
    tokenize            : tokenize,
    compile             : compile,
    keyMatches          : keyMatches,
    redact              : redact,
    getConfig           : getConfig
};
