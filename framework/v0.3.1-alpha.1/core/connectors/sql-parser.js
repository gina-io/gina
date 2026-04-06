'use strict';
/**
 * sql-parser.js — state-machine SQL comment utilities (#SQL1)
 *
 * Shared by the Couchbase N1QL connector and the SQLite connector.
 *
 * Both parsers previously used single-pass regexes that broke on:
 *   - Nested block comments:  /* outer /* inner *‌/ still-outer *‌/
 *   - -- or // inside string literals: WHERE name = 'it''s -- not a comment'
 *
 * The state machine below tracks four states:
 *   DEFAULT      — normal query text
 *   BLOCK        — inside /* ... *‌/ (depth counter handles nesting)
 *   LINE         — inside -- ... or // ... until \n
 *   STRING       — inside '...' or "..." (doubled-quote escape '' / "")
 *
 * SQL uses doubled-quote escapes ('' not \') — backslash escapes are not
 * recognised here to match standard SQL behaviour.
 */


/**
 * stripComments — remove all SQL/N1QL comments from src.
 *
 * Block comments /* ... *‌/ are replaced with a single space to preserve
 * token separation. Line comments produce no output. String content is
 * passed through verbatim so -- or /* inside a string literal is never
 * treated as a comment opener.
 *
 * @param  {string} src
 * @return {string}
 */
function stripComments(src) {
    var out   = '';
    var i     = 0;
    var len   = src.length;
    var depth = 0;

    while (i < len) {
        var c    = src[i];
        var peek = src[i + 1];

        if (depth > 0) {
            // Inside a block comment
            if (c === '/' && peek === '*')      { depth++; i += 2; }
            else if (c === '*' && peek === '/') { depth--; i += 2; if (depth === 0) out += ' '; }
            else                                { i++; }
            continue;
        }

        // Enter block comment
        if (c === '/' && peek === '*') { depth++; i += 2; continue; }

        // Line comment (SQL -- or C-style //) — skip to end of line
        if ((c === '-' && peek === '-') || (c === '/' && peek === '/')) {
            while (i < len && src[i] !== '\n') i++;
            continue;
        }

        // String literal — pass through verbatim; handle doubled-quote escapes
        if (c === "'" || c === '"') {
            var q = c;
            out += c;
            i++;
            while (i < len) {
                var ch = src[i++];
                out += ch;
                if (ch === q) {
                    if (src[i] === q) { out += src[i++]; } // '' or "" escape
                    else break;                              // end of string
                }
            }
            continue;
        }

        out += c;
        i++;
    }

    return out;
}


/**
 * extractFirstBlockComment — return the first /* ... *‌/ comment verbatim
 * (including the /* and *‌/ delimiters), or null if none is found.
 *
 * Nesting is handled: /* outer /* inner *‌/ *‌/ is treated as one comment
 * and the full extent is returned. String literals are skipped — a /* inside
 * a string does not open a comment.
 *
 * Used by the Couchbase N1QL parser to extract $param references from the
 * leading annotation comment before stripping all comments from the query.
 *
 * @param  {string} src
 * @return {string|null}
 */
function extractFirstBlockComment(src) {
    var i     = 0;
    var len   = src.length;
    var depth = 0;
    var start = -1;

    while (i < len) {
        var c    = src[i];
        var peek = src[i + 1];

        if (depth > 0) {
            if (c === '/' && peek === '*') {
                depth++; i += 2;
            } else if (c === '*' && peek === '/') {
                depth--; i += 2;
                if (depth === 0) return src.slice(start, i);
            } else {
                i++;
            }
            continue;
        }

        // Enter block comment
        if (c === '/' && peek === '*') {
            start = i;
            depth++;
            i += 2;
            continue;
        }

        // String literal — skip, do not scan for comment openers inside strings
        if (c === "'" || c === '"') {
            var q = c;
            i++;
            while (i < len) {
                var ch = src[i++];
                if (ch === q) {
                    if (src[i] === q) i++; // '' or "" escape
                    else break;
                }
            }
            continue;
        }

        i++;
    }

    return null; // no block comment found
}


module.exports = {
    stripComments           : stripComments,
    extractFirstBlockComment: extractFirstBlockComment
};
