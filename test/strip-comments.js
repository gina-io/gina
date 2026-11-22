'use strict';
/**
 * Exact comment removal for source-pin tests (#B1157).
 *
 * A regex that removes block comments before anything else opens a phantom block at any `/*`
 * outside a real comment — inside a `//` comment (« /_gina/* handlers »), a string, a regex or a
 * template — and deletes live code up to the next real comment end. This module lexes the source
 * instead (code, string / regex / template text, line comment, block comment) and removes only
 * real comments. Every mode keeps every newline, so line numbers and line-based pins survive (the
 * opt-in `lines(src, { drop: true })` is the one exception).
 *
 * Modes (pick the one that keeps the strip's intent):
 *   - `blocks(src)` — block comments out; `//` comments kept.
 *   - `lines(src)`  — block comments out, and every line whose first non-space character starts a
 *                     `//` comment blanked; trailing `//` comments kept. `lines(src, { drop: true })`
 *                     removes each such line with its newline instead.
 *   - `all(src)`    — every comment out.
 *
 * @module test/strip-comments
 *
 * @example
 * var strip = require('../strip-comments');
 * var active = strip.lines(fs.readFileSync(SRC, 'utf8'));
 * assert.equal(active.indexOf('retiredCall('), -1);
 */

/**
 * Words after which a `/` starts a regex literal rather than a division.
 * @constant
 * @type {Object<string, boolean>}
 */
var REGEX_AFTER_WORD = { 'return': true, 'typeof': true, 'case': true, 'in': true, 'of': true, 'void': true,
    'delete': true, 'throw': true, 'new': true, 'do': true, 'else': true, 'instanceof': true, 'yield': true, 'await': true };

/**
 * Punctuators after which a `/` starts a regex literal.
 * @constant
 * @type {string}
 */
var REGEX_AFTER_PUNCT = '(,=:[!&|?{};+-*%<>~^}';

/** @constant @type {number} */ var CODE = 0;
/** @constant @type {number} */ var LINE_COMMENT = 1;
/** @constant @type {number} */ var TEXT = 2;
/** @constant @type {number} */ var BLOCK_COMMENT = 3;

/**
 * True for a character that continues an identifier (letters and digits of any script, `_`, `$`).
 *
 * @inner
 * @param {string} ch - One UTF-16 code unit.
 * @returns {boolean}
 */
function isWordChar(ch) {
    var c = ch.charCodeAt(0);
    if ( c < 128 ) {
        return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
    }
    return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * True for a letter (regex flags).
 *
 * @inner
 * @param {string} ch - One UTF-16 code unit.
 * @returns {boolean}
 */
function isLetter(ch) {
    var c = ch.charCodeAt(0);
    if ( c < 128 ) {
        return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    }
    return /\p{L}/u.test(ch);
}

/**
 * Classifies every character of a JavaScript source.
 *
 * @param {string} src - The source text.
 * @returns {Uint8Array} One class per UTF-16 code unit: 0 code, 1 line comment, 2 string /
 *   regex / template text, 3 block comment.
 *
 * @example
 * var cls = lex("var a = '/*'; // x\n");
 * // cls[8] === 2 (inside the string), cls[14] === 1 (the line comment)
 */
function lex(src) {
    var n = src.length;
    var cls = new Uint8Array(n);
    var i = 0, tstack = [], prev = '', word = '';
    var j, ch, c, d, opened, r;

    // scans template text from `i`; returns [next index, whether a `${` opened]
    var tpl = function(i) {
        while (i < n) {
            var ch = src[i];
            cls[i] = TEXT;
            if ( ch === '\\' ) {
                if ( i + 1 < n ) { cls[i + 1] = TEXT; }
                i += 2;
                continue;
            }
            if ( ch === '`' ) { return [i + 1, false]; }
            if ( ch === '$' && i + 1 < n && src[i + 1] === '{' ) {
                cls[i + 1] = TEXT;
                return [i + 2, true];
            }
            i += 1;
        }
        return [n, false];
    };

    while (i < n) {
        c = src[i];
        d = (i + 1 < n) ? src[i + 1] : '';
        if ( c === '/' && d === '/' ) {
            j = src.indexOf('\n', i);
            if ( j < 0 ) { j = n; }
            cls.fill(LINE_COMMENT, i, j);
            i = j;
            continue;
        }
        if ( c === '/' && d === '*' ) {
            j = src.indexOf('*/', i + 2);
            j = (j < 0) ? n : j + 2;
            cls.fill(BLOCK_COMMENT, i, j);
            i = j;
            continue;
        }
        if ( c === '"' || c === "'" ) {
            j = i + 1;
            while (j < n && src[j] !== c && src[j] !== '\n') {
                j += (src[j] === '\\') ? 2 : 1;
            }
            j = (j < n && src[j] === c) ? Math.min(j + 1, n) : Math.min(j, n);
            cls.fill(TEXT, i, j);
            prev = 'v'; word = ''; i = j;
            continue;
        }
        if ( c === '`' ) {
            cls[i] = TEXT;
            r = tpl(i + 1); i = r[0]; opened = r[1];
            if ( opened ) { tstack.push(0); } else { prev = 'v'; word = ''; }
            continue;
        }
        if ( c === '{' ) {
            if ( tstack.length ) { tstack[tstack.length - 1] += 1; }
            prev = c; word = ''; i += 1;
            continue;
        }
        if ( c === '}' ) {
            if ( tstack.length ) {
                if ( tstack[tstack.length - 1] === 0 ) {
                    tstack.pop();
                    cls[i] = TEXT;
                    r = tpl(i + 1); i = r[0]; opened = r[1];
                    if ( opened ) { tstack.push(0); } else { prev = 'v'; word = ''; }
                    continue;
                }
                tstack[tstack.length - 1] -= 1;
            }
            prev = c; word = ''; i += 1;
            continue;
        }
        if ( c === '/' ) {
            if ( prev === '' || REGEX_AFTER_PUNCT.indexOf(prev) > -1 && prev.length === 1 || (prev === 'w' && REGEX_AFTER_WORD[word] === true) ) {
                j = i + 1;
                var inClass = false, ok = false;
                while (j < n) {
                    ch = src[j];
                    if ( ch === '\\' ) { j += 2; continue; }
                    if ( ch === '\n' ) { break; }
                    if ( inClass ) {
                        if ( ch === ']' ) { inClass = false; }
                    } else if ( ch === '[' ) {
                        inClass = true;
                    } else if ( ch === '/' ) {
                        ok = true;
                        break;
                    }
                    j += 1;
                }
                if ( ok ) {
                    j += 1;
                    while (j < n && isLetter(src[j])) { j += 1; }
                    cls.fill(TEXT, i, j);
                    prev = 'v'; word = ''; i = j;
                    continue;
                }
            }
            prev = c; word = ''; i += 1;
            continue;
        }
        if ( isWordChar(c) ) {
            j = i + 1;
            while (j < n && isWordChar(src[j])) { j += 1; }
            word = src.slice(i, j); prev = 'w'; i = j;
            continue;
        }
        if ( /\s/.test(c) ) { i += 1; continue; }
        prev = c; word = ''; i += 1;
    }
    return cls;
}

/**
 * Concatenates the characters a predicate keeps (newlines always kept).
 *
 * @inner
 * @param {string} src - The source text.
 * @param {Uint8Array} cls - Its classes, from {@link lex}.
 * @param {boolean} dropLineComments - Also remove `//` comments.
 * @returns {string}
 */
function keep(src, cls, dropLineComments) {
    var parts = [], start = -1, k, kept;
    for (var i = 0, n = src.length; i < n; i++) {
        k = cls[i];
        kept = (k !== BLOCK_COMMENT && !(dropLineComments && k === LINE_COMMENT)) || src[i] === '\n';
        if ( kept ) {
            if ( start < 0 ) { start = i; }
        } else if ( start > -1 ) {
            parts.push(src.slice(start, i));
            start = -1;
        }
    }
    if ( start > -1 ) { parts.push(src.slice(start)); }
    return parts.join('');
}

/**
 * Removes every block comment; keeps `//` comments and every newline.
 *
 * @param {string} src - The source text.
 * @returns {string}
 * @example
 * blocks("a(); /* x *\/ b(); // y"); // "a();  b(); // y"
 */
function blocks(src) {
    return keep(src, lex(src), false);
}

/**
 * Removes every block comment, then blanks each line whose first non-space character starts a
 * `//` comment; trailing `//` comments and every newline are kept.
 *
 * With `opts.drop === true` each such line is removed together with its newline instead: the shape of
 * a line filter run after a block strip, done exactly. It is the one option that does not keep every
 * newline; the lines of a block comment still stay, as empty lines.
 *
 * @param {string} src - The source text.
 * @param {Object} [opts]
 * @param {boolean} [opts.drop=false] - Remove each comment-only line with its newline rather than
 *   blank it.
 * @returns {string}
 * @example
 * lines("  // note\nx(); // why\n"); // "\nx(); // why\n"
 * lines("  // note\nx(); // why\n", { drop: true }); // "x(); // why\n"
 */
function lines(src, opts) {
    var drop = !!(opts && opts.drop === true);
    var cls = lex(src);
    var out = [], cur = [], first = -1;
    for (var i = 0, n = src.length; i < n; i++) {
        var ch = src[i];
        if ( cls[i] === BLOCK_COMMENT && ch !== '\n' ) { continue; }
        if ( ch === '\n' ) {
            if ( !(drop && first === LINE_COMMENT) ) { out.push(first === LINE_COMMENT ? '' : cur.join('')); }
            cur = []; first = -1;
            continue;
        }
        cur.push(ch);
        if ( first < 0 && !/\s/.test(ch) ) { first = cls[i]; }
    }
    if ( !(drop && first === LINE_COMMENT) ) { out.push(first === LINE_COMMENT ? '' : cur.join('')); }
    return out.join('\n');
}

/**
 * Removes every comment, block and line; keeps every newline.
 *
 * @param {string} src - The source text.
 * @returns {string}
 * @example
 * all("x(); // why\n/* a *\/y();"); // "x(); \ny();"
 */
function all(src) {
    return keep(src, lex(src), true);
}

module.exports = { lex: lex, blocks: blocks, lines: lines, all: all };
