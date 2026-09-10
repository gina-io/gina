/**
 * @module gina/lib/cmd/controller/inc/reference-rewrite
 *
 * Pure, comment-preserving rewriters for `controller:rename`. Every rewrite is
 * anchored on a QUOTED-STRING structured site — never a bare word-boundary match
 * — so a namespace that is a substring of another token (`checkout` inside
 * `checkout_v2`), a comment, or an unrelated identifier is NEVER touched. The
 * rewrites are string-ops (no JSON parse→stringify), so routing.json comments,
 * key ordering and whitespace survive byte-for-byte. Anything a rename cannot
 * express as one of these anchored rewrites (a dynamic namespace, the cosmetic
 * controller class name) is the caller's job to REPORT, not rewrite.
 *
 * No `fs`, no framework globals — require-by-path unit-testable.
 */

/**
 * Escapes RegExp metacharacters so a namespace can be embedded literally.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites `"namespace": "<oldNs>"` → `"namespace": "<newNs>"` everywhere it
 * appears (a rule-level `namespace` AND a `param.namespace` are both textually
 * `"namespace": "<value>"`, so one anchored pass covers both). The closing quote
 * is part of the anchor, so `"namespace": "<oldNs>2"` is never matched, and a
 * `:variable` value (`":type"`) is left alone (it is not `<oldNs>`). Comments,
 * ordering and spacing outside the rewritten VALUE are untouched.
 *
 * @param {string} content - routing.json content (comments allowed)
 * @param {string} oldNs
 * @param {string} newNs
 * @returns {{content: string, count: number}}
 *
 * @example
 *  rewriteRoutingNamespace('{ "r": { "namespace": "checkout" } } // keep', 'checkout', 'basket');
 *  // { content: '{ "r": { "namespace": "basket" } } // keep', count: 1 }
 */
function rewriteRoutingNamespace(content, oldNs, newNs) {
    var re = new RegExp('("namespace"\\s*:\\s*")' + escapeRegex(oldNs) + '(")', 'g');
    var count = 0;
    var out = String(content).replace(re, function (m, pre, post) {
        count++;
        return pre + newNs + post;
    });
    return { content: out, count: count };
}

/**
 * Rewrites `requireController('<oldNs>')` → `requireController('<newNs>')` for
 * both quote styles, preserving the quote character and any surrounding
 * whitespace. Only a literal-string call for exactly `<oldNs>` is rewritten — a
 * different literal, an empty call, or a non-literal argument is left untouched.
 *
 * @param {string} content - `.js` file content
 * @param {string} oldNs
 * @param {string} newNs
 * @returns {{content: string, count: number}}
 *
 * @example
 *  rewriteRequireController("self.requireController('checkout');", 'checkout', 'basket');
 *  // { content: "self.requireController('basket');", count: 1 }
 */
function rewriteRequireController(content, oldNs, newNs) {
    var re = new RegExp('(requireController\\(\\s*)([\'"])' + escapeRegex(oldNs) + '\\2(\\s*\\))', 'g');
    var count = 0;
    var out = String(content).replace(re, function (m, pre, q, post) {
        count++;
        return pre + q + newNs + q + post;
    });
    return { content: out, count: count };
}

module.exports = {
    escapeRegex             : escapeRegex,
    rewriteRoutingNamespace : rewriteRoutingNamespace,
    rewriteRequireController: rewriteRequireController
};
