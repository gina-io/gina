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


/**
 * parseCreateIndexes — parse CREATE INDEX statements from a SQL source string
 * and build a table-keyed index map.
 *
 * Handles:
 *   CREATE INDEX <name> ON <table> (...)
 *   CREATE UNIQUE INDEX <name> ON <table> (...)
 *   CREATE INDEX IF NOT EXISTS <name> ON <table> (...)
 *   CREATE UNIQUE INDEX IF NOT EXISTS <name> ON <table> (...)
 *
 * Table names are normalised to lowercase. Quoted identifiers (`"tbl"`,
 * `` `tbl` ``) are unquoted. Schema-qualified names (`schema.table`) keep
 * only the table part.
 *
 * @param  {string} src  Raw SQL source (may contain comments)
 * @return {Object.<string, Array<{name: string, primary: boolean}>>}
 *         Map of lowercase table name → array of index descriptors.
 *         Returns an empty object when no CREATE INDEX statements are found.
 */
function parseCreateIndexes(src) {
    var map = {};
    if (!src) return map;

    // Strip comments first so -- or /* inside strings doesn't confuse us
    var clean = stripComments(src);

    // Match CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <table>
    // Captures: (1) index name, (2) table name
    var re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s+ON\s+(\S+)/gi;
    var m;

    while ((m = re.exec(clean)) !== null) {
        var idxName   = unquoteIdentifier(m[1]);
        var tableName = unquoteIdentifier(m[2]);

        // Strip schema prefix (schema.table → table)
        var dotPos = tableName.lastIndexOf('.');
        if (dotPos > -1) tableName = tableName.substring(dotPos + 1);

        // Strip trailing parenthesis if captured (e.g. "users(" from "ON users(email)")
        tableName = tableName.replace(/\(.*$/, '');

        tableName = tableName.toLowerCase();

        if (!map[tableName]) map[tableName] = [];

        // Deduplicate by index name
        var exists = false;
        for (var i = 0; i < map[tableName].length; i++) {
            if (map[tableName][i].name === idxName) { exists = true; break; }
        }
        if (!exists) {
            map[tableName].push({ name: idxName, primary: false });
        }
    }

    return map;
}


/**
 * extractTargetTable — extract the primary target table from a SQL statement.
 *
 * Handles SELECT ... FROM <table>, INSERT INTO <table>, UPDATE <table>,
 * DELETE FROM <table>. Returns the lowercase, unquoted table name, or null
 * if no table can be determined.
 *
 * For JOINs, only the first FROM target is returned (Phase A limitation —
 * full multi-table extraction is deferred to Phase B).
 *
 * @param  {string} queryString  Cleaned SQL (comments already stripped)
 * @return {string|null}         Lowercase table name, or null
 */
function extractTargetTable(queryString) {
    if (!queryString) return null;

    var m;

    // INSERT INTO <table>
    m = queryString.match(/\bINSERT\s+INTO\s+(\S+)/i);
    if (m) return normaliseTableName(m[1]);

    // UPDATE <table>
    m = queryString.match(/\bUPDATE\s+(\S+)/i);
    if (m) return normaliseTableName(m[1]);

    // DELETE FROM <table>
    m = queryString.match(/\bDELETE\s+FROM\s+(\S+)/i);
    if (m) return normaliseTableName(m[1]);

    // SELECT ... FROM <table>
    m = queryString.match(/\bFROM\s+(\S+)/i);
    if (m) return normaliseTableName(m[1]);

    return null;
}


/**
 * Unquote a SQL identifier — strips surrounding `"`, `` ` ``, or `[` `]`.
 * @inner
 * @param  {string} id
 * @return {string}
 */
function unquoteIdentifier(id) {
    if (!id) return id;
    if ((id[0] === '"' && id[id.length - 1] === '"') ||
        (id[0] === '`' && id[id.length - 1] === '`')) {
        return id.substring(1, id.length - 1);
    }
    if (id[0] === '[' && id[id.length - 1] === ']') {
        return id.substring(1, id.length - 1);
    }
    return id;
}


/**
 * Normalise a captured table token: unquote, strip schema prefix,
 * strip trailing punctuation, lowercase.
 * @inner
 * @param  {string} raw
 * @return {string|null}
 */
function normaliseTableName(raw) {
    if (!raw) return null;
    raw = unquoteIdentifier(raw);
    // Strip schema prefix
    var dot = raw.lastIndexOf('.');
    if (dot > -1) raw = raw.substring(dot + 1);
    // Strip trailing parens, commas, semicolons
    raw = raw.replace(/[,(;]+$/, '');
    raw = unquoteIdentifier(raw); // unquote again after schema strip (schema."table")
    return raw.toLowerCase() || null;
}


module.exports = {
    stripComments           : stripComments,
    extractFirstBlockComment: extractFirstBlockComment,
    parseCreateIndexes      : parseCreateIndexes,
    extractTargetTable      : extractTargetTable
};
