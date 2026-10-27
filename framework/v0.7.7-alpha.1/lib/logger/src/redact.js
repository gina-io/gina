/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

'use strict';

/**
 * @module lib/logger/redact
 *
 * Pre-render log redaction (#B433). Pure, dependency-free: compiles a
 * bundle's `settings.json > log.redact` block into a rule set and applies it
 * to a log MESSAGE before the message is rendered into a line. The logger
 * applies it at its single pre-render choke point (`emit()`), so every sink —
 * stdout, the MQ speaker / `gina tail`, the file transport, the Inspector
 * taps — receives the redacted payload, and JSON mode can never be corrupted
 * (the marker lands inside the message string, never across the rendered
 * line's structure).
 *
 * Two rule sources compose:
 *
 *   - PATTERNS — regexes over the message text. A built-in set masks the
 *     credential shapes that reach an access line through a URL (JWT, URL
 *     userinfo, `Bearer`/`Basic` credentials, named credential query keys,
 *     api-key style headers); a bundle extends it with `patterns`.
 *   - SECRET VALUES — every value the secrets resolver substituted from a
 *     `${secret:KEY}` placeholder is masked verbatim wherever it appears.
 *     Zero false positives by construction: the values are the bundle's own.
 *
 * Deliberately NOT a default: a bare long-hex path segment. A sha256
 * content-address key served from storage and an opaque 64-hex bearer
 * credential are the same regex class, so no default can tell them apart —
 * a bundle whose credentials are opaque path segments adds one pattern.
 *
 * Every default is linear (no nested quantifiers): measured 0.9 µs per access
 * line and 11 ms across five 200 KB adversarial inputs. Consumer-supplied
 * patterns are compiled at config load and refused when invalid or when they
 * match the empty string; their backtracking behaviour is the consumer's.
 *
 * Anchor a hex-credential pattern on the character class (lookarounds), not
 * `\b`: a leading `\b` never fires against a prefixed segment (`key_<hex>` —
 * `_` is a word character), and the miss is silent.
 *
 * TWO READINGS (#B830). The log writers render a control character held by a
 * logged value as a visible escape (`\n`, `\r`, `\t`, `\uXXXX`), and they do
 * it before the message reaches this module. `apply()` therefore reads a
 * message that holds such an escape twice — as written, then with each escape
 * read as the character it stands for — and masks, in the message as written,
 * whatever either reading finds. See `apply()` and `decodeView()`.
 *
 * QUOTE ESCAPES (#B834). The object writers also escape a string value's
 * quotes before the message reaches this module: the levelled writer writes
 * `\"` and `\'`, and the raw `console.log` path renders an object with
 * `JSON.stringify` (`\"`). A secret value holding a quote then no longer
 * matches as written; the decoded reading reads the two quote escapes too, so
 * it is found and masked like a secret holding a line break.
 *
 * ESCAPE LAYERS (#B838). Two more renderers write a value before the message
 * reaches this module, and both escape the backslash itself: `JSON.stringify`
 * (the raw `console.log` path, and any JSON string a caller builds) and
 * `util.inspect` (an `Error`, on both paths). The secret values are therefore
 * searched on more readings: each layer of that escaping is read back, up to
 * `MAX_ESCAPE_DEPTH` layers, from the message as written and from its decoded
 * reading. `util.inspect` also lays a value's line breaks out (a long string
 * is split after each line feed, a nested Error's message is indented), and
 * the levelled string path writes a carriage return as a line feed: a secret's
 * line breaks match those layouts. See `decodeEscapes()`, `secretSource()`
 * and `apply()`.
 *
 * @example
 * var redact = require('./redact');
 * var state  = redact.compileState([redact.compileBlock({ patterns: ['(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])'] }, 'demo')]);
 * redact.apply(state, 'GET [200] /reset?token=abc123def456'); // → 'GET [200] /reset?token=[REDACTED]'
 * redact.apply(null,  'GET [200] /reset?token=abc123def456'); // → unchanged (no state)
 */

// #B838 — read for one default only: util.inspect's `maxStringLength` (see compileState)
var util = require('util');

/**
 * The replacement text. Contains no `$`, so it is inert under
 * `String.prototype.replace`'s dollar-pattern expansion.
 *
 * @constant
 * @type {string}
 */
var MARKER = '[REDACTED]';

/**
 * Resolved secret values shorter than this are NOT added to the redaction set
 * (a 3-character value would mask ordinary text everywhere); the caller is
 * told which paths were skipped so it can warn.
 *
 * @constant
 * @type {number}
 */
var MIN_SECRET_LENGTH = 8;

/**
 * The built-in pattern set. Stored as sources (not RegExp objects) so every
 * compiled state owns fresh instances. Order matters only for readability —
 * each rule is applied with the `g` flag over the whole message.
 *
 * @constant
 * @type {Array<{name: string, pattern: string, flags: string, replacement: string}>}
 */
var DEFAULT_RULES = Object.freeze([
    // JSON Web Tokens: header.payload.signature, both leading segments are base64url of `{"`.
    { name: 'jwt',       pattern: '(?<![\\w-])eyJ[\\w-]{10,}\\.eyJ[\\w-]{10,}\\.[\\w-]{10,}(?![\\w-])', flags: 'g',  replacement: MARKER },
    // RFC 3986 userinfo: scheme://user:PASSWORD@host — keeps the user, masks the password.
    { name: 'userinfo',  pattern: '(\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\/\\s:@]+:)[^\\/\\s@]+@',           flags: 'gi', replacement: '$1' + MARKER + '@' },
    // `Bearer <token>` — 20+ token chars so prose ("Bearer authentication") stays untouched.
    { name: 'bearer',    pattern: '(\\bBearer\\s+)[A-Za-z0-9._~+\\/=-]{20,}',                          flags: 'g',  replacement: '$1' + MARKER },
    // `Basic <base64>` — 16+ chars, same reason.
    { name: 'basic',     pattern: '(\\bBasic\\s+)[A-Za-z0-9+\\/=]{16,}',                                flags: 'g',  replacement: '$1' + MARKER },
    // Named credential keys in a query string / form body: keeps the key, masks the value.
    { name: 'querykey',  pattern: '((?<![\\w.-])(?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|client_secret|secret|password|passwd|pwd|passcode|authorization|auth|signature|sig|otp|session_?token)=)[^&\\s#\'"]+', flags: 'gi', replacement: '$1' + MARKER },
    // api-key style headers when a header line is logged.
    { name: 'headerkey', pattern: '(\\b(?:x-api-key|api-key|x-auth-token|x-access-token|x-amz-security-token)\\s*[:=]\\s*)[^\\s,;\'"]+',           flags: 'gi', replacement: '$1' + MARKER }
]);

/**
 * The keys a `log.redact` block may carry. Anything else is refused — a
 * misspelt `pattern` would otherwise be ignored silently, which is a leak.
 *
 * @constant
 * @type {string[]}
 */
var BLOCK_KEYS = ['enabled', 'defaults', 'secrets', 'patterns'];

/**
 * Escape a literal for use inside a RegExp source.
 *
 * @inner
 * @private
 * @param {string} s - Literal text
 * @returns {string} The escaped source
 */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/**
 * The characters a renderer lays around a line break of a value (#B838):
 * whitespace — the indentation `util.inspect` adds after each line feed of a
 * nested Error's message or stack, and of a string a custom inspector
 * returns — and the quotes and the plus sign of the joint it writes when it
 * splits a long string after each line feed (`'line 1\n' +\n  'line 2'`).
 *
 * @constant
 * @type {string}
 */
var LAYOUT_CLASS = '[\\s\'"`+]';

/**
 * One character of {@link LAYOUT_CLASS}, to test a character of a value.
 *
 * @constant
 * @type {RegExp}
 */
var LAYOUT_CHAR_RE = /[\s'"`+]/;

/**
 * The regex source that finds one secret value (#B838). A value that holds no
 * line break is matched literally, exactly as before. A line break is matched
 * with the layout a renderer can give it:
 *
 *   - a carriage return matches a carriage return or a line feed — the
 *     levelled string path writes the first as the second before the
 *     redaction runs;
 *   - a line feed followed by more of the value matches the line feed, then
 *     any run of {@link LAYOUT_CLASS} characters. The layout characters the
 *     value itself holds right after that line feed are part of the run, so
 *     the run is always followed by a character outside the class: no two
 *     variable-length parts are adjacent, and the match stays linear;
 *   - at the very end of a value nothing is tolerated: the trailing characters
 *     are matched as they are, so the mask stops where the value stops.
 *
 * The tolerance only ever widens what is masked.
 *
 * @inner
 * @private
 * @param {string} v - A secret value
 * @returns {string} The regex source matching it
 *
 * @example
 * secretSource('p@ss.w0rd');        // → 'p@ss\\.w0rd' (escapeRegExp, unchanged)
 * secretSource('ab\r\ncd');         // → 'ab[\\r\\n]\\n[\\s\'"`+]*cd'
 * secretSource('ab\n');             // → 'ab\\n' (nothing tolerated at the end)
 */
function secretSource(v) {
    if (v.indexOf('\n') < 0 && v.indexOf('\r') < 0) {
        return escapeRegExp(v);
    }
    var out = '', last = 0, i = 0, len = v.length, c, j;
    while (i < len) {
        c = v.charCodeAt(i);
        if (c !== 13 && c !== 10) { i++; continue; }
        out += escapeRegExp(v.slice(last, i));
        if (c === 13) {
            out += '[\\r\\n]';
            i++;
        } else {
            j = i + 1;
            while (j < len && LAYOUT_CHAR_RE.test(v.charAt(j))) { j++; }
            if (j < len) {
                out += '\\n' + LAYOUT_CLASS + '*';
                i = j;
            } else {
                out += '\\n';
                i++;
            }
        }
        last = i;
    }
    return out + escapeRegExp(v.slice(last));
}

/**
 * Compile one pattern rule. Accepts the string form (whole match → marker)
 * or the object form `{ pattern, flags, replacement, name }`. The `g` flag
 * is always enforced — without it only the FIRST credential on a line would
 * be masked.
 *
 * @inner
 * @private
 * @param {string|object} rule   - A `patterns[]` entry
 * @param {string}        origin - Where the rule comes from, for the error message
 * @param {number}        index  - Its position in `patterns`, for the error message
 * @returns {{name: string, re: RegExp, replacement: string}} The compiled rule
 * @throws {Error} When the entry is not a string / object, `pattern` is not a
 *   non-empty string, `flags` / `replacement` are not strings, the regex does
 *   not compile, or it matches the empty string
 */
function compileRule(rule, origin, index) {
    var where = '`settings.log.redact.patterns[' + index + ']` (' + origin + ')';
    var source, flags = 'g', replacement = MARKER, name = null;

    if (typeof rule === 'string') {
        source = rule;
    } else if (rule !== null && typeof rule === 'object' && !Array.isArray(rule)) {
        source = rule.pattern;
        if (typeof rule.flags !== 'undefined') {
            if (typeof rule.flags !== 'string') {
                throw new Error(where + ': `flags` must be a string');
            }
            flags = rule.flags.indexOf('g') > -1 ? rule.flags : rule.flags + 'g';
        }
        if (typeof rule.replacement !== 'undefined') {
            if (typeof rule.replacement !== 'string') {
                throw new Error(where + ': `replacement` must be a string');
            }
            replacement = rule.replacement;
        }
        if (typeof rule.name !== 'undefined') {
            if (typeof rule.name !== 'string') {
                throw new Error(where + ': `name` must be a string');
            }
            name = rule.name;
        }
    } else {
        throw new Error(where + ': must be a regex source string or an object { pattern, flags, replacement }');
    }

    if (typeof source !== 'string' || source.length === 0) {
        throw new Error(where + ': `pattern` must be a non-empty regex source string');
    }

    var re;
    try {
        re = new RegExp(source, flags);
    } catch (reErr) {
        throw new Error(where + ': invalid regular expression — ' + reErr.message);
    }
    // A pattern matching the empty string would splice the marker between every
    // character of every line.
    re.lastIndex = 0;
    if (re.test('')) {
        throw new Error(where + ': the pattern matches the empty string and would redact every position of every line');
    }
    re.lastIndex = 0;

    return { name: name || ('patterns[' + index + ']'), re: re, replacement: replacement };
}

/**
 * Compile a compiled-rule descriptor from one of `DEFAULT_RULES`.
 *
 * @inner
 * @private
 * @param {{name: string, pattern: string, flags: string, replacement: string}} d
 * @returns {{name: string, re: RegExp, replacement: string}}
 */
function compileDefault(d) {
    return { name: d.name, re: new RegExp(d.pattern, d.flags), replacement: d.replacement };
}

/**
 * Validate and compile one bundle's `settings.log.redact` block.
 *
 * Booleans are STRICT: `"false"` (a string) is refused rather than read as
 * truthy — the same lint posture as `settings.audit.enabled`. An absent block
 * compiles to the defaults (everything on, no extra patterns).
 *
 * @memberof module:lib/logger/redact
 * @function compileBlock
 * @param {object} [block] - The `log.redact` object from settings.json
 * @param {string} [origin='settings.json'] - Where it comes from (bundle name), for error messages
 * @returns {{enabled: boolean, defaults: boolean, secrets: boolean, patterns: Array<{name: string, re: RegExp, replacement: string}>}}
 *   The compiled block
 * @throws {Error} On any shape violation (see `compileRule`) or an unknown key
 *
 * @example
 * redact.compileBlock(undefined);                       // → { enabled: true, defaults: true, secrets: true, patterns: [] }
 * redact.compileBlock({ enabled: false }, 'api');       // → everything off for that bundle
 * redact.compileBlock({ patterns: ['('] }, 'api');      // throws: invalid regular expression
 * redact.compileBlock({ pattern: ['x'] }, 'api');       // throws: unknown key `pattern` (a typo that would otherwise leak)
 */
function compileBlock(block, origin) {
    origin = origin || 'settings.json';
    var out = { enabled: true, defaults: true, secrets: true, patterns: [] };
    if (typeof block === 'undefined' || block === null) {
        return out;
    }
    if (typeof block !== 'object' || Array.isArray(block)) {
        throw new Error('`settings.log.redact` (' + origin + ') must be an object');
    }
    var keys = Object.keys(block);
    for (var k = 0; k < keys.length; k++) {
        if (BLOCK_KEYS.indexOf(keys[k]) < 0) {
            throw new Error('`settings.log.redact` (' + origin + '): unknown key `' + keys[k] + '` — allowed keys are ' + BLOCK_KEYS.join(', '));
        }
    }
    var bools = ['enabled', 'defaults', 'secrets'];
    for (var b = 0; b < bools.length; b++) {
        if (typeof block[bools[b]] !== 'undefined') {
            if (block[bools[b]] !== true && block[bools[b]] !== false) {
                throw new Error('`settings.log.redact.' + bools[b] + '` (' + origin + ') must be a strict boolean — got ' + JSON.stringify(block[bools[b]]));
            }
            out[bools[b]] = block[bools[b]];
        }
    }
    if (typeof block.patterns !== 'undefined') {
        if (!Array.isArray(block.patterns)) {
            throw new Error('`settings.log.redact.patterns` (' + origin + ') must be an array');
        }
        for (var i = 0; i < block.patterns.length; i++) {
            out.patterns.push(compileRule(block.patterns[i], origin, i));
        }
    }
    return out;
}

/**
 * Build the effective, process-wide state from every compiled block and every
 * resolved secret value. The union is the safe direction: one bundle asking
 * for redaction is enough for the whole process to redact (a merged process
 * has one logger for every bundle), and a pattern declared anywhere applies
 * everywhere. Duplicate patterns collapse to one.
 *
 * #B838 — each secret value is compiled with {@link secretSource}, so its line
 * breaks match the layout a renderer gives them, and a value longer than
 * `util.inspect`'s `maxStringLength` (read when this runs; 10,000 by default)
 * also masks the head `util.inspect` keeps of it. `secretCount` counts the
 * values, not the heads.
 *
 * @memberof module:lib/logger/redact
 * @function compileState
 * @param {Array<object>} blocks - Compiled blocks (from `compileBlock`)
 * @param {string[]} [secretValues] - Resolved secret values to mask verbatim
 * @returns {{enabled: boolean, rules: Array<{name: string, re: RegExp, replacement: string}>, secretRe: (RegExp|null), secretCount: number}|null}
 *   The state to hand to `apply()`, or `null` when redaction is off (no block
 *   enabled) or there is nothing to apply
 *
 * @example
 * redact.compileState([]);                              // → null (nothing to do)
 * redact.compileState([redact.compileBlock()]).rules.length; // → the built-in set
 * redact.compileState([redact.compileBlock({ enabled: false })]); // → null
 */
function compileState(blocks, secretValues) {
    blocks = blocks || [];
    if (blocks.length === 0) {
        return null;
    }
    var enabled = false, defaults = false, i;
    for (i = 0; i < blocks.length; i++) {
        if (blocks[i].enabled) { enabled = true; }
        if (blocks[i].enabled && blocks[i].defaults) { defaults = true; }
    }
    if (!enabled) {
        return null;
    }
    var rules = [], seen = {};
    var push = function (r) {
        var key = r.re.source + '/' + r.re.flags + '/' + r.replacement;
        if (seen[key]) { return; }
        seen[key] = true;
        rules.push(r);
    };
    if (defaults) {
        for (i = 0; i < DEFAULT_RULES.length; i++) { push(compileDefault(DEFAULT_RULES[i])); }
    }
    for (i = 0; i < blocks.length; i++) {
        if (!blocks[i].enabled) { continue; }
        for (var p = 0; p < blocks[i].patterns.length; p++) { push(blocks[i].patterns[p]); }
    }

    var secretRe = null, secretCount = 0;
    if (Array.isArray(secretValues) && secretValues.length > 0) {
        var uniq = {}, list = [];
        for (i = 0; i < secretValues.length; i++) {
            var v = secretValues[i];
            if (typeof v !== 'string' || v.length < MIN_SECRET_LENGTH || uniq[v]) { continue; }
            uniq[v] = true;
            list.push(v);
        }
        if (list.length > 0) {
            // Longest first: a value that is a prefix of another must not win the
            // alternation and leave the longer value's tail in the clear.
            secretCount = list.length;
            // #B838 — `util.inspect` cuts a string longer than its `maxStringLength`
            // (10,000 by default): what it keeps of such a value is its head, which
            // matches no reading of the whole value. The head is masked as a value of
            // its own; a secret that sits further inside a longer cut string is not
            // covered (the cut then falls elsewhere).
            var inspectMax = (util.inspect && util.inspect.defaultOptions) ? util.inspect.defaultOptions.maxStringLength : 10000;
            if (typeof inspectMax === 'number' && isFinite(inspectMax) && inspectMax >= MIN_SECRET_LENGTH) {
                for (i = 0; i < secretCount; i++) {
                    if (list[i].length > inspectMax && !uniq[list[i].slice(0, inspectMax)]) {
                        uniq[list[i].slice(0, inspectMax)] = true;
                        list.push(list[i].slice(0, inspectMax));
                    }
                }
            }
            list.sort(function (a, b) { return b.length - a.length; });
            // #B838 — a secret's line breaks match the layout a renderer gives them
            // was: secretRe = new RegExp(list.map(escapeRegExp).join('|'), 'g');
            secretRe = new RegExp(list.map(secretSource).join('|'), 'g');
        }
    }

    if (rules.length === 0 && secretRe === null) {
        return null;
    }
    return { enabled: true, rules: rules, secretRe: secretRe, secretCount: secretCount };
}

/**
 * The visible escapes a log writer produces for a control character (#B830):
 * `\n`, `\r`, `\t`, and `\uXXXX`. Which `\uXXXX` forms count is decided by
 * {@link isEscapedCodePoint} — the same set the escapers write, so the two
 * stay in step. Either hex case is read.
 *
 * #B834 — plus the two quote escapes the object writers add to a string
 * value: `\"` (the levelled writer, and `JSON.stringify` on the raw path) and
 * `\'` (the levelled writer). Group 1 holds `n`, `r` or `t`, group 2 the four
 * hex digits, group 3 the quote.
 *
 * @constant
 * @type {RegExp}
 */
var VISIBLE_ESCAPE_RE = /\\(?:([nrt])|u([0-9a-fA-F]{4})|(["']))/g;

/**
 * Is this code point one the log escapers write as `\uXXXX` (or as `\n`,
 * `\r`, `\t`)? C0 controls, DEL, C1 controls, and the two Unicode line
 * separators — every character a terminal or a line-based reader can take
 * for a line break or a control sequence.
 *
 * @inner
 * @private
 * @param {number} cp - A UTF-16 code unit
 * @returns {boolean}
 */
function isEscapedCodePoint(cp) {
    return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
}

/**
 * Build the DECODED reading of a message: the same text with every visible
 * escape replaced by the character it stands for, plus the offset of each
 * decoded character in the message as written.
 *
 * The escapers do not escape the backslash itself, so the reading is not an
 * inverse: a `\n` (or, since #B834, a `\"`) the caller wrote on purpose reads
 * as a line feed (or a quote) too. That is why {@link apply} never matches on
 * this reading ALONE. The renderers that DO escape the backslash —
 * `JSON.stringify` and `util.inspect` — are read by {@link decodeEscapes}
 * (#B838), one layer at a time; this reading is kept as it is for the
 * logger's own object writer, whose output it inverts.
 *
 * @memberof module:lib/logger/redact
 * @function decodeView
 * @param {string} text - The message as written
 * @returns {{text: string, map: number[]}|null} The decoded text and, for
 *   each of its characters, the offset where that character starts in `text`
 *   (one extra trailing entry holds `text.length`); `null` when `text` holds
 *   no visible escape
 *
 * @example
 * redact.decodeView('a\\nb');            // → { text: 'a\nb', map: [0, 1, 3, 4] }
 * redact.decodeView('a\\"b');            // → { text: 'a"b', map: [0, 1, 3, 4] } (#B834)
 * redact.decodeView('C:\\Users\\me');    // → null (no visible escape)
 */
function decodeView(text) {
    if (text.indexOf('\\') < 0) {
        return null;
    }
    var out = '', map = [], last = 0, count = 0, m, ch, cp, i;
    VISIBLE_ESCAPE_RE.lastIndex = 0;
    while ((m = VISIBLE_ESCAPE_RE.exec(text)) !== null) {
        if (m[1]) {
            ch = m[1] === 'n' ? '\n' : (m[1] === 'r' ? '\r' : '\t');
        } else if (m[2] != null) {
            cp = parseInt(m[2], 16);
            if (!isEscapedCodePoint(cp)) { continue; }
            ch = String.fromCharCode(cp);
        } else {
            ch = m[3];
        }
        for (i = last; i < m.index; i++) { map.push(i); }
        out += text.slice(last, m.index) + ch;
        map.push(m.index);
        last = m.index + m[0].length;
        count++;
    }
    if (count === 0) {
        return null;
    }
    for (i = last; i <= text.length; i++) { map.push(i); }
    return { text: out + text.slice(last), map: map };
}

/**
 * How many layers of backslash escaping are read back (#B838). The logger
 * itself stacks two — an `Error` held by an object logged through
 * `console.log` is rendered by `util.inspect`, then by `JSON.stringify` — and
 * a string the caller serialised before logging it adds a third.
 *
 * @constant
 * @type {number}
 */
var MAX_ESCAPE_DEPTH = 3;

/**
 * A backslash that does NOT start one of the object writer's simple escapes
 * (`\n`, `\r`, `\t`, `\"`, `\'`). A message that holds none of these and
 * has a decoded reading needs no further reading (#B838): every backslash in
 * it starts one of those five escapes, both grammars read each of them as the
 * same character, so reading a layer back would give the decoded reading
 * again. The common line — a logged object whose values hold quotes or line
 * breaks — is therefore searched exactly as before.
 *
 * @constant
 * @type {RegExp}
 */
var BEYOND_VIEW_RE = /\\(?![nrt"'])/;

/**
 * Read `n` hexadecimal digits of `text` starting at `at`.
 *
 * @inner
 * @private
 * @param {string} text
 * @param {number} at - Offset of the first digit
 * @param {number} n  - How many digits
 * @returns {number} Their value, or -1 when one of them is not a hex digit
 */
function hexValue(text, at, n) {
    var v = 0, c, k;
    for (k = 0; k < n; k++) {
        c = text.charCodeAt(at + k);
        if (c >= 48 && c <= 57) { c -= 48; }
        else if (c >= 97 && c <= 102) { c -= 87; }
        else if (c >= 65 && c <= 70) { c -= 55; }
        else { return -1; }
        v = v * 16 + c;
    }
    return v;
}

/**
 * Read ONE layer of backslash escaping back, as `JSON.stringify` and
 * `util.inspect` write it (#B838): `\\`, `\"`, `\'`, `\/`, `\b`, `\f`, `\n`,
 * `\r`, `\t`, `\xHH` (`util.inspect`: C0, U+007F to U+009F) and `\uHHHH`
 * (`JSON.stringify`: C0; both: a lone surrogate). Any `\xHH` or `\uHHHH` is
 * read, whatever the code unit, so a serialiser that escapes more characters
 * than those two is read as well; an escape outside the grammar stays as
 * written. One scan, with no regex: it runs on every logged line that holds a
 * backslash. The single implementation of the grammar — {@link unescapeLayer}
 * and {@link decodeEscapes} are its two forms.
 *
 * @inner
 * @private
 * @param {string}        text - A message, or a reading of it
 * @param {number[]|null} map  - Receives, for each character of the result, its
 *   offset in `text` (plus one trailing entry, `text.length`); `null` to skip
 * @returns {string|null} The text with one layer read back; `null` when it holds no escape
 */
function readLayer(text, map) {
    var i = text.indexOf('\\');
    if (i < 0) {
        return null;
    }
    var out = '', last = 0, len = text.length, ch, n, v, k;
    while (i > -1 && i + 1 < len) {
        n = 2; ch = null;
        switch (text.charCodeAt(i + 1)) {
            case 92:  ch = '\\'; break;
            case 34:  ch = '"';  break;
            case 39:  ch = '\''; break;
            case 47:  ch = '/';  break;
            case 98:  ch = '\b'; break;
            case 102: ch = '\f'; break;
            case 110: ch = '\n'; break;
            case 114: ch = '\r'; break;
            case 116: ch = '\t'; break;
            case 120: v = hexValue(text, i + 2, 2); if (v > -1) { ch = String.fromCharCode(v); n = 4; } break;
            case 117: v = hexValue(text, i + 2, 4); if (v > -1) { ch = String.fromCharCode(v); n = 6; } break;
        }
        if (ch === null) {
            // not an escape of the grammar: it stays as written
            i = text.indexOf('\\', i + 1);
            continue;
        }
        if (map !== null) {
            for (k = last; k < i; k++) { map.push(k); }
            map.push(i);
        }
        out += text.slice(last, i) + ch;
        last = i + n;
        i = text.indexOf('\\', last);
    }
    if (last === 0) {
        return null;
    }
    if (map !== null) {
        for (k = last; k <= len; k++) { map.push(k); }
    }
    return out + text.slice(last);
}

/**
 * Read one layer of backslash escaping back, text only: the fast form of
 * {@link decodeEscapes}, used to search a reading before any offset is built.
 *
 * @inner
 * @private
 * @param {string} text - A message, or a reading of it
 * @returns {string|null} The text with one layer removed; `null` when it holds no escape
 */
function unescapeLayer(text) {
    return readLayer(text, null);
}

/**
 * Build the UNESCAPED reading of a text (#B838): the same text with one layer
 * of backslash escaping read back, plus the offset of each of its characters
 * in the text it was read from — the shape {@link decodeView} returns.
 *
 * `JSON.stringify` and `util.inspect` both escape the backslash itself, so in
 * their output every backslash starts an escape and this reading is an exact
 * inverse of one layer. It is not one for the logger's own object writer,
 * which leaves the backslash alone: a backslash followed by an escaped line
 * feed is written `\\n` there, and reads here as a written `\n`. That writer
 * keeps its own reading ({@link decodeView}), and {@link apply} searches both.
 *
 * @memberof module:lib/logger/redact
 * @function decodeEscapes
 * @param {string} text - A message, or a reading of it
 * @returns {{text: string, map: number[]}|null} The unescaped text and, for
 *   each of its characters, the offset where that character starts in `text`
 *   (one extra trailing entry holds `text.length`); `null` when `text` holds
 *   no escape of the grammar
 *
 * @example
 * redact.decodeEscapes('a\\\\b');        // → { text: 'a\\b', map: [0, 1, 3, 4] } (an escaped backslash)
 * redact.decodeEscapes('a\\x01b');       // → { text: 'a\u0001b', map: [0, 1, 5, 6] } (util.inspect)
 * redact.decodeEscapes('a\\ud800b');     // → { text: 'a\ud800b', map: [0, 1, 7, 8] } (a lone surrogate)
 * redact.decodeEscapes('C:\\Users\\me'); // → null (`\U` and `\m` are not escapes)
 */
function decodeEscapes(text) {
    var map = [], out = readLayer(text, map);
    return out === null ? null : { text: out, map: map };
}

/**
 * Expand a replacement template the way `String.prototype.replace` does
 * (`$$`, `$&`, `` $` ``, `$'`, `$n`, `$nn`, `$<name>`), taking every piece
 * from the message AS WRITTEN: a kept group is copied with its escapes still
 * visible, so no control character is written back into the log.
 *
 * @inner
 * @private
 * @param {string}   tpl   - The rule's replacement
 * @param {string}   raw   - The message as written
 * @param {number}   start - Start of the match in `raw`
 * @param {number}   end   - End of the match in `raw`
 * @param {object}   match - The match on the decoded reading (compiled with the `d` flag)
 * @param {number[]} map   - Decoded offset → offset in `raw`
 * @returns {string} The text to write in place of `raw.slice(start, end)`
 */
function expandReplacement(tpl, raw, start, end, match, map) {
    if (tpl.indexOf('$') < 0) {
        return tpl;
    }
    var groupCount = match.length - 1;
    var named = match.indices.groups;
    var group = function (span) {
        return span ? raw.slice(map[span[0]], map[span[1]]) : '';
    };
    var out = '', i = 0, len = tpl.length, c, d1, d2, n, gt;
    while (i < len) {
        c = tpl.charAt(i);
        if (c !== '$' || i + 1 >= len) { out += c; i++; continue; }
        c = tpl.charAt(i + 1);
        if (c === '$') { out += '$'; i += 2; continue; }
        if (c === '&') { out += raw.slice(start, end); i += 2; continue; }
        if (c === '`') { out += raw.slice(0, start); i += 2; continue; }
        if (c === '\'') { out += raw.slice(end); i += 2; continue; }
        if (c >= '0' && c <= '9') {
            d1 = c.charCodeAt(0) - 48;
            d2 = (i + 2 < len) ? tpl.charCodeAt(i + 2) - 48 : -1;
            if (d2 >= 0 && d2 <= 9) {
                n = d1 * 10 + d2;
                if (n >= 1 && n <= groupCount) { out += group(match.indices[n]); i += 3; continue; }
            }
            if (d1 >= 1 && d1 <= groupCount) { out += group(match.indices[d1]); i += 2; continue; }
            out += '$'; i++; continue;
        }
        if (c === '<' && typeof named !== 'undefined') {
            gt = tpl.indexOf('>', i + 2);
            if (gt > -1) { out += group(named[tpl.slice(i + 2, gt)]); i = gt + 1; continue; }
        }
        out += '$'; i++;
    }
    return out;
}

/**
 * Apply one pattern rule on the decoded reading and write the result into
 * the message as written: each match is mapped back to the span it covers
 * there, and that span is replaced.
 *
 * @memberof module:lib/logger/redact
 * @function replaceThroughView
 * @param {{re: RegExp, replacement: string}} rule - A compiled rule
 * @param {string} raw - The message as written
 * @param {{text: string, map: number[]}} view - Its decoded reading (from `decodeView`)
 * @returns {string} The message with every match on the decoded reading replaced
 *
 * @example
 * // `password=` sits right after an escaped line feed: the rule cannot see
 * // the boundary in the text as written, it can on the decoded reading
 * var rule = redact.compileState([redact.compileBlock()]).rules[4];
 * var raw  = 'A=1\\npassword=hunter2';
 * redact.replaceThroughView(rule, raw, redact.decodeView(raw)); // → 'A=1\\npassword=[REDACTED]'
 */
function replaceThroughView(rule, raw, view) {
    if (!rule.reD) {
        // the `d` flag gives each group's offsets, which the mapping needs
        rule.reD = new RegExp(rule.re.source, rule.re.flags.indexOf('d') > -1 ? rule.re.flags : rule.re.flags + 'd');
    }
    rule.reD.lastIndex = 0;
    var it = view.text.matchAll(rule.reD), step, m, start, end;
    var out = '', pos = 0, changed = false;
    while (!(step = it.next()).done) {
        m     = step.value;
        start = view.map[m.index];
        end   = view.map[m.index + m[0].length];
        out  += raw.slice(pos, start) + expandReplacement(rule.replacement, raw, start, end, m, view.map);
        pos   = end;
        changed = true;
    }
    return changed ? out + raw.slice(pos) : raw;
}

/**
 * Push every span of one reading that the secret alternation matches, as
 * offsets in the message as written.
 *
 * @inner
 * @private
 * @param {RegExp}        secretRe - The compiled alternation (never matches the empty string)
 * @param {string}        text     - The reading to search
 * @param {number[]|null} map      - Offset in `text` → offset in the message as written; `null` when `text` is that message
 * @param {Array<number[]>} spans  - Receives `[start, end]` pairs
 * @returns {void}
 */
function collectSpans(secretRe, text, map, spans) {
    var m;
    secretRe.lastIndex = 0;
    while ((m = secretRe.exec(text)) !== null) {
        spans.push(map === null ? [m.index, m.index + m[0].length] : [map[m.index], map[m.index + m[0].length]]);
    }
    secretRe.lastIndex = 0;
}

/**
 * Mask the secret values on EVERY reading at once: the spans found in the
 * message as written, on its decoded reading, and on each layer of backslash
 * escaping read back from either (#B838) are merged, and every merged span
 * becomes one marker. Merging keeps the longest-first guarantee across the
 * readings — a short value found as written inside a longer one found on
 * another reading cannot leave the longer one's head in the clear.
 *
 * A layer is first read as text only ({@link unescapeLayer}); its offsets are
 * built ({@link decodeEscapes}) only when a secret is found on it, so a line
 * that holds escapes and no secret pays for the search alone. A reading equal
 * to one already searched is not searched again.
 *
 * (Before #B838: `maskSecretsOnBothReadings`, the first two readings only.)
 *
 * @inner
 * @private
 * @param {RegExp} secretRe - The compiled alternation (never matches the empty string)
 * @param {string} raw      - The message as written
 * @param {{text: string, map: number[]}|null} view - Its decoded reading, or `null` when it has none
 * @returns {string} The message with every span masked
 */
function maskSecretsOnReadings(secretRe, raw, view) {
    var spans = [], seen = [raw], bases = [[raw, null]];
    var b, d, k, i, text, next, map, froms;
    collectSpans(secretRe, raw, null, spans);
    if (view !== null) {
        collectSpans(secretRe, view.text, view.map, spans);
        seen.push(view.text);
        bases.push([view.text, view.map]);
        // nothing but the object writer's simple escapes: the two readings above are all there is
        if (!BEYOND_VIEW_RE.test(raw)) { bases = []; }
    }
    for (b = 0; b < bases.length; b++) {
        text  = bases[b][0];
        froms = [];
        for (d = 0; d < MAX_ESCAPE_DEPTH; d++) {
            next = unescapeLayer(text);
            if (next === null) { break; }
            froms.push(text);
            text = next;
            if (seen.indexOf(text) > -1) { continue; }
            seen.push(text);
            secretRe.lastIndex = 0;
            if (!secretRe.test(text)) { continue; }
            // a secret is on this reading: build its offsets, layer by layer,
            // down to the message as written
            map = bases[b][1];
            for (k = 0; k < froms.length; k++) {
                next = decodeEscapes(froms[k]).map;
                if (map !== null) {
                    for (i = 0; i < next.length; i++) { next[i] = map[next[i]]; }
                }
                map = next;
            }
            collectSpans(secretRe, text, map, spans);
        }
    }
    secretRe.lastIndex = 0;
    if (spans.length === 0) {
        return raw;
    }
    spans.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    var out = '', pos = 0, cur = spans[0];
    for (i = 1; i < spans.length; i++) {
        if (spans[i][0] < cur[1]) {
            if (spans[i][1] > cur[1]) { cur[1] = spans[i][1]; }
        } else {
            out += raw.slice(pos, cur[0]) + MARKER;
            pos  = cur[1];
            cur  = spans[i];
        }
    }
    return out + raw.slice(pos, cur[0]) + MARKER + raw.slice(cur[1]);
}

/**
 * Redact one message. Secret values are applied FIRST (an exact literal beats
 * a pattern), then every pattern rule. Idempotent: a redacted message
 * re-redacts to itself. Anything that is not a string is returned untouched.
 *
 * #B830 — a message can reach this point with control characters already
 * written as visible escapes (`\n`, `\r`, `\t`, `\uXXXX`): a logged object's
 * values, an error detail, a client value a framework site escaped. A visible
 * escape ends in a word character and stands where whitespace stood, so a
 * rule anchored on `\b`, a lookbehind or `\s`, and a secret value holding a
 * line break, would stop matching. Such a message is therefore read TWICE:
 * as written, then decoded (each visible escape read as the character it
 * stands for), and a span found on the decoded reading is masked in the
 * message as written. The decoded reading only ever ADDS masks — the escapers
 * leave the backslash alone, so a `\n` the caller wrote on purpose is not
 * told from an escaped line feed, and a credential holding one must still be
 * found as written. A message with no visible escape takes the first reading
 * only: one `replace` per rule, as before.
 *
 * #B834 — the decoded reading also reads the quote escapes an object's string
 * values receive (`\"`, `\'`), so a secret holding a quote, logged inside an
 * object or through `console.log`, is masked as well.
 *
 * #B838 — the secret values are searched on more readings than the pattern
 * rules: `JSON.stringify` (the raw path, a JSON string a caller builds) and
 * `util.inspect` (an `Error`) escape the backslash itself, so a message that
 * holds a backslash is also read with each layer of that escaping read back
 * ({@link decodeEscapes}), up to `MAX_ESCAPE_DEPTH` layers, from the message
 * as written and from its decoded reading. A secret holding a backslash, a
 * control character or a lone surrogate is then found whichever renderer
 * wrote it, and so is one rendered more than once. The pattern rules keep
 * their two readings. Not found: a value that is not written as its own
 * characters (a Buffer's bytes, base64, URL-encoding), and a secret that sits
 * inside a longer string `util.inspect` cut at its `maxStringLength`.
 *
 * @memberof module:lib/logger/redact
 * @function apply
 * @param {object|null} state   - From `compileState()`; `null` = pass-through
 * @param {string}      content - The assembled log message, before rendering
 * @returns {string} The redacted message (or the input when there is nothing to do)
 *
 * @example
 * var st = redact.compileState([redact.compileBlock()]);
 * redact.apply(st, 'POST [200] /login Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop');
 * // → 'POST [200] /login Authorization: Bearer [REDACTED]'
 * redact.apply(st, 'GET [200] /files/42');   // → unchanged
 * redact.apply(null, 'anything');            // → 'anything'
 * redact.apply(st, '"env": "A=1\\npassword=hunter2"');
 * // → '"env": "A=1\\npassword=[REDACTED]"' (found on the decoded reading)
 */
function apply(state, content) {
    if (!state || !state.enabled || typeof content !== 'string' || content.length === 0) {
        return content;
    }
    var view = decodeView(content), i, next;
    // #B838 — the secret values are read on every escape layer of a message that
    // holds a backslash, whether or not it holds a visible escape of the object writer.
    // was: (inside `if (view === null)`) content = content.replace(state.secretRe, MARKER);
    //      (otherwise) next = maskSecretsOnBothReadings(state.secretRe, content, view);
    if (state.secretRe !== null) {
        if (content.indexOf('\\') < 0) {
            // no backslash: the message as written is the only reading
            content = content.replace(state.secretRe, MARKER);
        } else {
            next = maskSecretsOnReadings(state.secretRe, content, view);
            if (next !== content) { content = next; view = decodeView(content); }
        }
    }
    if (view === null) {
        // no visible escape: the pattern rules read the message as written only
        for (i = 0; i < state.rules.length; i++) {
            content = content.replace(state.rules[i].re, state.rules[i].replacement);
        }
        return content;
    }
    for (i = 0; i < state.rules.length; i++) {
        next = content.replace(state.rules[i].re, state.rules[i].replacement);
        if (next !== content) { content = next; view = decodeView(content); }
        if (view !== null) {
            next = replaceThroughView(state.rules[i], content, view);
            if (next !== content) { content = next; view = decodeView(content); }
        }
    }
    return content;
}

/**
 * Filter the secret values that `compileState` would accept, returning the
 * ones it would SKIP (too short) so a caller can warn with their paths.
 *
 * @memberof module:lib/logger/redact
 * @function partitionSecrets
 * @param {Array<{path: string, value: *}>} entries - Resolved secrets with their config paths
 * @returns {{values: string[], skipped: string[]}} Accepted values + the skipped paths
 *
 * @example
 * redact.partitionSecrets([{ path: 'db.password', value: 'correct-horse-battery' }, { path: 'pin', value: '1234' }]);
 * // → { values: ['correct-horse-battery'], skipped: ['pin'] }
 */
function partitionSecrets(entries) {
    var out = { values: [], skipped: [] };
    if (!Array.isArray(entries)) { return out; }
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e || typeof e.value !== 'string') { continue; }
        if (e.value.length < MIN_SECRET_LENGTH) {
            out.skipped.push(e.path);
        } else {
            out.values.push(e.value);
        }
    }
    return out;
}

module.exports = {
    MARKER            : MARKER,
    MIN_SECRET_LENGTH : MIN_SECRET_LENGTH,
    DEFAULT_RULES     : DEFAULT_RULES,
    compileBlock      : compileBlock,
    compileState      : compileState,
    apply             : apply,
    decodeView        : decodeView,
    decodeEscapes     : decodeEscapes,
    replaceThroughView: replaceThroughView,
    partitionSecrets  : partitionSecrets
};
