/**
 * @module gina/lib/cmd/bundle/inc/name-rewrite
 *
 * Pure, dependency-free helpers for rewriting a bundle's name footprint in
 * copied/renamed source files. Shared by `bundle:copy` and `bundle:rename`.
 *
 * The rewrite is **word-boundary anchored**: it renames the PascalCase
 * identifiers the scaffolder derives from the bundle name (`<Name>Controller`,
 * the gina require-var, etc.) and the lowercase whole-word name, but never a
 * name embedded inside a larger token (`apiClient`, `rapid`, `api_key`). It is
 * the caller's job to limit which files this runs on (`bundle:copy` /
 * `bundle:rename` apply it to `.js`/`.json` only).
 *
 * No `fs`, no framework globals — require-by-path unit-testable.
 */

/**
 * Escapes regular-expression metacharacters so a bundle name can be embedded
 * literally in a dynamically-built `RegExp`.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the name with its first character upper-cased (the `${Bundle}`
 * convention the scaffolder uses for controller class names, etc.).
 *
 * @param {string} s
 * @returns {string}
 */
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Rewrites the bundle-name footprint in a single file's content:
 *  - `\b<Source>` (PascalCase prefix + standalone, e.g. `ApiController`, `Api`) → `<Dest>`
 *  - `\b<source>\b` (lowercase whole-word, e.g. require-var, `"name"`, webroot path) → `<dest>`
 *  - when `opts.fixWebroot` is true: a first-bundle webroot of `"/"` → `"/<dest>"`
 *
 * The two case-disjoint passes never collide. The webroot fix is opt-in because
 * it is only correct for `bundle:copy` (a copied first bundle's `"/"` webroot
 * would collide with the source's) — `bundle:rename` MUST leave a `"/"` webroot
 * alone (it moves the only bundle, so there is no collision), while still
 * rewriting a name-derived `"/<old>"` webroot via the lowercase pass.
 *
 * @param {string} content
 * @param {string} source
 * @param {string} dest
 * @param {{fixWebroot?: boolean}} [opts]
 * @returns {string}
 */
function renameContent(content, source, dest, opts) {
    opts = opts || {};
    var SrcCap = capitalize(source)
        , DstCap = capitalize(dest);

    // PascalCase-prefix + standalone capitalized form (ApiController, "Api bundle")
    content = content.replace(new RegExp('\\b' + escapeRegex(SrcCap), 'g'), DstCap);
    // lowercase whole-word form (var api, "api", /api, api@project)
    content = content.replace(new RegExp('\\b' + escapeRegex(source) + '\\b', 'g'), dest);

    // first-bundle webroot collision (copy only): a verbatim "/" would clash with
    // the source bundle — repoint to "/<dest>" (string op preserves comments).
    if ( opts.fixWebroot ) {
        content = content.replace(/("webroot"\s*:\s*)"\/"/, '$1"/' + dest + '"');
    }
    return content;
}

/**
 * Counts how many name occurrences `renameContent` would rewrite in `content`
 * (the PascalCase-prefix hits plus the lowercase whole-word hits). Used to
 * preview rewrite sites in `--dry-run`. Does NOT count the webroot fix (it is a
 * follow-on edit, not a name occurrence).
 *
 * @param {string} content
 * @param {string} source
 * @returns {number}
 */
function countOccurrences(content, source) {
    var reCap = new RegExp('\\b' + escapeRegex(capitalize(source)), 'g')
        , reLow = new RegExp('\\b' + escapeRegex(source) + '\\b', 'g');
    return (content.match(reCap) || []).length + (content.match(reLow) || []).length;
}

module.exports = {
    escapeRegex      : escapeRegex,
    capitalize       : capitalize,
    renameContent    : renameContent,
    countOccurrences : countOccurrences
};
