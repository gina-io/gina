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
 * @example
 * var redact = require('./redact');
 * var state  = redact.compileState([redact.compileBlock({ patterns: ['(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])'] }, 'demo')]);
 * redact.apply(state, 'GET [200] /reset?token=abc123def456'); // → 'GET [200] /reset?token=[REDACTED]'
 * redact.apply(null,  'GET [200] /reset?token=abc123def456'); // → unchanged (no state)
 */

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
            list.sort(function (a, b) { return b.length - a.length; });
            secretRe = new RegExp(list.map(escapeRegExp).join('|'), 'g');
            secretCount = list.length;
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
 * @constant
 * @type {RegExp}
 */
var VISIBLE_ESCAPE_RE = /\\(?:([nrt])|u([0-9a-fA-F]{4}))/g;

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
 * inverse: a `\n` the caller wrote on purpose reads as a line feed too. That
 * is why {@link apply} never matches on this reading ALONE.
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
        } else {
            cp = parseInt(m[2], 16);
            if (!isEscapedCodePoint(cp)) { continue; }
            ch = String.fromCharCode(cp);
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
 * Mask the secret values on BOTH readings at once: the spans found in the
 * message as written and the spans found on its decoded reading are merged,
 * and every merged span becomes one marker. Merging keeps the longest-first
 * guarantee across the two readings — a short value found as written inside
 * a longer one found decoded cannot leave the longer one's head in the clear.
 *
 * @inner
 * @private
 * @param {RegExp} secretRe - The compiled alternation (never matches the empty string)
 * @param {string} raw      - The message as written
 * @param {{text: string, map: number[]}} view - Its decoded reading
 * @returns {string} The message with every span masked
 */
function maskSecretsOnBothReadings(secretRe, raw, view) {
    var spans = [], m, i;
    secretRe.lastIndex = 0;
    while ((m = secretRe.exec(raw)) !== null) {
        spans.push([m.index, m.index + m[0].length]);
    }
    secretRe.lastIndex = 0;
    while ((m = secretRe.exec(view.text)) !== null) {
        spans.push([view.map[m.index], view.map[m.index + m[0].length]]);
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
    if (view === null) {
        // no visible escape: the message as written is the only reading
        if (state.secretRe !== null) {
            content = content.replace(state.secretRe, MARKER);
        }
        for (i = 0; i < state.rules.length; i++) {
            content = content.replace(state.rules[i].re, state.rules[i].replacement);
        }
        return content;
    }
    if (state.secretRe !== null) {
        next = maskSecretsOnBothReadings(state.secretRe, content, view);
        if (next !== content) { content = next; view = decodeView(content); }
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
    replaceThroughView: replaceThroughView,
    partitionSecrets  : partitionSecrets
};
