/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/json-config-header
 *
 * Comment-aware header/body splitter for JSON-with-comments config files
 * (`connectors.json`, and any config a CLI handler rewrites from the parsed
 * object graph while preserving a leading comment header).
 *
 * The framework's config loader (`requireJSON`) tolerates `//` and
 * `/* ... *\/` comments, so a `connectors.json` legitimately carries a
 * comment header — and the scaffolded template's example block literally
 * contains `// "couchbase": {`, i.e. a `{` INSIDE a comment. A naive
 * `raw.indexOf('{')` to find where the JSON body starts therefore lands
 * inside that comment, so a rewrite (`header + JSON.stringify(...)`) comments
 * out the body's real opening brace and truncates the header — corrupting the
 * file. {@link firstStructuralBraceIndex} finds the first `{` that is NOT
 * inside a `//` or `/* *\/` comment, so {@link splitHeader} keeps the whole
 * comment header verbatim and the rewritten body stays valid JSON.
 *
 * This module is pure — it requires no node builtins, no `lib.*`, and reads
 * no framework globals, so it is unit-testable by a direct `require`. Same
 * contract as {@link module:gina/lib/cmd-status-format} and
 * {@link module:gina/lib/routing-introspect}. Consumed via the `lib` registry
 * (`lib.jsonConfigHeader`) by the connector:add / connector:rm /
 * connector:migrate handlers.
 *
 * @example
 * var jch   = lib.jsonConfigHeader;
 * var raw   = fs.readFileSync(target, 'utf8');
 * var split = jch.splitHeader(raw);   // { header: '// ...\n', braceIndex: 536 }
 * var text  = split.header + JSON.stringify(data, null, 4) + '\n';
 */

/**
 * Returns the index of the first STRUCTURAL `{` in `raw` — the first `{` that
 * is not inside a `//` line comment or a `/* ... *\/` block comment — or `-1`
 * when there is no such brace. A `{` sitting inside a comment (as in the
 * scaffolded `// "couchbase": {` example block) is skipped.
 *
 * Comment detection mirrors `requireJSON`'s intent (`//` and `/* *\/`). It
 * does NOT track string literals, and does not need to: for a well-formed
 * JSON-with-comments config nothing but comments and whitespace can precede
 * the first structural `{`, so no string can appear before it. A genuinely
 * malformed file fails `requireJSON` before any rewrite, so the split never
 * runs on it.
 *
 * @memberof module:gina/lib/json-config-header
 * @param   {string} raw - Full file text.
 * @returns {number} Index of the first non-comment `{`, or `-1` if none.
 *
 * @example
 * firstStructuralBraceIndex('{ "a": 1 }');                 // 0
 * firstStructuralBraceIndex('// { in a comment\n{ "a":1 }'); // 17  (the real brace)
 * firstStructuralBraceIndex('/* { *\/ { "a": 1 }');          // 8
 * firstStructuralBraceIndex('// only comments\n');          // -1
 */
var firstStructuralBraceIndex = function (raw) {
    var s = String(raw == null ? '' : raw);
    var inLine = false, inBlock = false;
    for (var i = 0, len = s.length; i < len; i++) {
        var c = s.charAt(i), n = s.charAt(i + 1);
        if (inLine)  { if (c === '\n') { inLine = false; } continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
        if (c === '/' && n === '/') { inLine  = true; i++; continue; }
        if (c === '/' && n === '*') { inBlock = true; i++; continue; }
        if (c === '{') { return i; }
    }
    return -1;
};

/**
 * Splits `raw` into its leading comment header (everything before the first
 * STRUCTURAL `{`) and reports that brace's index. When the structural brace is
 * at index 0 (a comment-free file starting with `{`) or absent (`-1`), the
 * header is the empty string — matching the original `(firstBrace > 0) ? ... :
 * ''` semantics, so a comment-free config rewrites byte-for-byte as before.
 *
 * The returned `header` is verbatim (comments + whitespace, trailing newline
 * included), so a caller can reassemble a valid file as
 * `header + JSON.stringify(data, null, 4) + '\n'`.
 *
 * @memberof module:gina/lib/json-config-header
 * @param   {string} raw - Full file text.
 * @returns {{header: string, braceIndex: number}}
 *
 * @example
 * // scaffolded connectors.json (comment header ending with a bare `{` line)
 * var s = splitHeader(raw);
 * // s.braceIndex -> index of the real `{`
 * // s.header     -> the ENTIRE comment header, verbatim
 *
 * @example
 * splitHeader('{ "$schema": "..." }'); // { header: '', braceIndex: 0 }
 * splitHeader('// note\n');            // { header: '', braceIndex: -1 }
 */
var splitHeader = function (raw) {
    var s          = String(raw == null ? '' : raw);
    var braceIndex = firstStructuralBraceIndex(s);
    var header     = (braceIndex > 0) ? s.slice(0, braceIndex) : '';
    return { header: header, braceIndex: braceIndex };
};

module.exports = {
    firstStructuralBraceIndex : firstStructuralBraceIndex,
    splitHeader               : splitHeader
};
