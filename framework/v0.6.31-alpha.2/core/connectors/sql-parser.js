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
 * @return {Object.<string, Array<{name: string, primary: boolean, columns: Array<string>}>>}
 *         Map of lowercase table name → array of index descriptors. Each
 *         descriptor carries its indexed `columns` (leftmost-first) for the
 *         #QI Phase C column-coverage check. Empty object when none found.
 */
function parseCreateIndexes(src) {
    var map = {};
    if (!src) return map;

    // Strip comments first so -- or /* inside strings doesn't confuse us
    var clean = stripComments(src);

    // Match CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <table> [USING <m>] (<cols>)
    // Captures: (1) index name, (2) table name, (3) column-list body (optional).
    // The table token stops at whitespace or "(" so "ON users(email)" still
    // splits cleanly; an optional "USING <method>" (PostgreSQL) is skipped.
    var re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s+ON\s+([^\s(]+)(?:\s+USING\s+\w+)?\s*(?:\(([^)]*)\))?/gi;
    var m;

    while ((m = re.exec(clean)) !== null) {
        var idxName   = unquoteIdentifier(m[1]);
        var tableName = unquoteIdentifier(m[2]);

        // Strip schema prefix (schema.table → table)
        var dotPos = tableName.lastIndexOf('.');
        if (dotPos > -1) tableName = tableName.substring(dotPos + 1);

        tableName = tableName.toLowerCase();

        if (!map[tableName]) map[tableName] = [];

        // #QI Phase C — capture the indexed column list (leftmost-first order)
        var columns = parseIndexColumns(m[3]);

        // Deduplicate by index name
        var exists = false;
        for (var i = 0; i < map[tableName].length; i++) {
            if (map[tableName][i].name === idxName) { exists = true; break; }
        }
        if (!exists) {
            map[tableName].push({ name: idxName, primary: false, columns: columns });
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
 * extractWhereColumns — heuristic extraction of the column names a query
 * filters on. Returns the bare lowercase identifiers that appear immediately
 * to the left of a comparison operator inside the WHERE clause.
 *
 * Heuristic, NOT a full parser: table/alias qualifiers are stripped
 * (`t.email` → `email`); ORDER BY / GROUP BY / HAVING columns are not
 * included; functional predicates (`LOWER(email) = ?`) yield no column (the
 * left-of-operator token is `)`, so nothing is captured — an index cannot be
 * matched on a bare name there anyway). Used by #QI Phase C column-coverage.
 *
 * @param  {string} queryString  Raw SQL (comments stripped internally)
 * @return {Array<string>}       Ordered, de-duplicated lowercase column names
 * @example
 *   extractWhereColumns("SELECT * FROM users WHERE t.email = ? AND status IN (?)")
 *   // → ['email', 'status']
 */
function extractWhereColumns(queryString) {
    if (!queryString) return [];
    var clean = stripComments(String(queryString));

    // Isolate the WHERE clause up to the next major clause or statement end.
    var wm = clean.match(/\bWHERE\b([\s\S]*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|\bUNION\b|\bRETURNING\b|;|$)/i);
    if (!wm) return [];

    var cols = [];
    var seen = {};
    // Identifier (optionally table-qualified) immediately left of a comparison op.
    var re = /([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*(?:<=|>=|<>|!=|=|<|>|\bLIKE\b|\bIN\b|\bBETWEEN\b|\bIS\b)/gi;
    var m;
    while ((m = re.exec(wm[1])) !== null) {
        var col = m[1];
        var dot = col.lastIndexOf('.');
        if (dot > -1) col = col.substring(dot + 1);   // strip table/alias qualifier
        col = col.toLowerCase();
        if (col === 'and' || col === 'or' || col === 'not') continue;
        if (!seen[col]) { seen[col] = true; cols.push(col); }
    }
    return cols;
}


/**
 * annotateCoverage — given a table's index descriptors and a query, compute
 * per-index column coverage using the leftmost-prefix rule: an index is
 * usable for the query's filter only if its FIRST column is among the queried
 * columns. Descriptors are cloned — the shared `_knownIndexes` entry is never
 * mutated. Used by #QI Phase C.
 *
 * @param  {Array<{name:string, primary:boolean, columns?:Array<string>}>} tableIndexes
 * @param  {string} queryString
 * @return {{whereColumns: Array<string>, indexes: Array<{name:string, primary:boolean, columns:Array<string>, covers:boolean}>, anyCovered: boolean}}
 * @example
 *   annotateCoverage([{name:'idx', primary:false, columns:['email','status']}],
 *                    "SELECT * FROM users WHERE email = ?")
 *   // → { whereColumns:['email'], indexes:[{..., covers:true}], anyCovered:true }
 */
function annotateCoverage(tableIndexes, queryString) {
    var whereColumns = extractWhereColumns(queryString);
    var out          = [];
    var anyCovered   = false;

    for (var i = 0; i < (tableIndexes ? tableIndexes.length : 0); i++) {
        var idx  = tableIndexes[i];
        var cols = idx.columns || [];
        // Leftmost-prefix: usable only if the index's leading column is filtered.
        var covers = (cols.length > 0 && whereColumns.length > 0 &&
                      whereColumns.indexOf(cols[0]) > -1);
        if (covers) anyCovered = true;
        out.push({
            name    : idx.name,
            primary : !!idx.primary,
            columns : cols.slice(),
            covers  : covers
        });
    }

    return { whereColumns: whereColumns, indexes: out, anyCovered: anyCovered };
}


/**
 * parseIndexColumns — parse a CREATE INDEX column-list body (the text between
 * the parens) into an ordered array of bare lowercase column names. Direction
 * keywords (ASC/DESC), operator classes, collations and prefix-length
 * specifiers are dropped; expression / functional parts (e.g. `lower(email)`)
 * reduce to their leading token and simply won't match a bare WHERE column
 * (conservative — no false coverage claim).
 * @inner
 * @param  {string} listStr
 * @return {Array<string>}
 */
function parseIndexColumns(listStr) {
    if (!listStr) return [];
    var parts = listStr.split(',');
    var cols  = [];
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (!p) continue;
        // Leading token: drops "DESC"/"ASC"/opclass and any "(...)" wrapping.
        var tok = unquoteIdentifier(p.split(/[\s(]/)[0]);
        if (tok) cols.push(tok.toLowerCase());
    }
    return cols;
}


/**
 * parseIndexDefColumns — extract the indexed column list from a PostgreSQL
 * `pg_indexes.indexdef` statement (e.g.
 * `CREATE INDEX i ON public.users USING btree (email, status)`) into an
 * ordered array of bare lowercase column names. Reuses parseIndexColumns on
 * the parenthesised column body, so the same direction-keyword / opclass /
 * functional-expression handling applies. Returns [] when no column list can
 * be located. Used by #QI Phase C.2 to give live-introspected PostgreSQL
 * indexes the same `columns` shape as the indexes.sql (Phase A) path.
 * @inner
 * @param  {string} indexDef  A CREATE INDEX statement (pg_indexes.indexdef)
 * @return {Array<string>}    Leftmost-first lowercase column names, or []
 * @example
 *   parseIndexDefColumns('CREATE INDEX i ON public.users USING btree (email, status)')
 *   // → ['email', 'status']
 */
function parseIndexDefColumns(indexDef) {
    if (!indexDef) return [];
    // Column list = first parenthesised group after "ON <table> [USING method]".
    var m = String(indexDef).match(/\bON\b[\s\S]*?\(([^)]*)\)/i);
    if (!m) return [];
    return parseIndexColumns(m[1]);
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
    extractTargetTable      : extractTargetTable,
    extractWhereColumns     : extractWhereColumns,
    annotateCoverage        : annotateCoverage,
    parseIndexDefColumns    : parseIndexDefColumns
};
