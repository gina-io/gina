'use strict';
/**
 * Route-candidate index for the cold routing path of `server.js` (#P46).
 *
 * `_handleDispatch` matches a request by walking the bundle's routing table in
 * declaration order and running `lib/routing`'s `compareUrls` on each rule: a cold
 * match costs about 1.1 µs per rule scanned, and a request no rule matches pays for
 * the whole table (≈ 440 µs at 380 rules, measured 2026-09-25). This module answers,
 * for one request, the SET of rule names that could match it; the loop skips every
 * other rule. The loop, its order and every per-rule check are unchanged, so the
 * first match in declaration order still wins.
 *
 * The set is a SUPERSET of the rules the loop can accept, never a subset:
 *
 * - a URL variant is split on `,` exactly as `compareUrls` splits it (untrimmed);
 * - a segment holding a `:` ANYWHERE is a parameter (`hasParams` in lib/routing
 *   tests `/\:/`), so an inline parameter such as `page:number` is one;
 * - a static segment must equal the request's segment exactly, as `parseRouting`
 *   compares it;
 * - the loop's own equality clause (`pathname == routing[name].url`) compares the
 *   RAW pathname with the WHOLE raw url string, so every rule is also indexed under
 *   its raw url and looked up with the raw pathname;
 * - a rule the path index cannot model is evaluated for every request (`always`):
 *   one declaring two or more requirements that are not bound as a whole `:key`
 *   segment (for GET and DELETE, `parseRouting` writes each such request key over
 *   the compared segments from index 0, so two or more replace real path segments),
 *   one variant with a requirement of that kind that does not start with `/` (its
 *   index 0 is a real segment), a variant with surrounding whitespace, `?` or `#`,
 *   and a url that is not a string (the loop still evaluates it; `compareUrls`
 *   throws on it and the loop answers 500, which stays so).
 *
 * `lookup()` returns `null` — "no filter, scan every rule", today's behaviour — for
 * a path the index does not model: one that does not start with `/`, holds `?` or
 * `#` (express keeps the query in the pathname), or has an empty segment after the
 * leading `/` (`/`, a trailing `/`, `//`: a parameter whose requirement accepts `''`
 * can match an empty segment, and these paths are few and meet the warm route cache
 * after their first request).
 *
 * A rule skipped by the index no longer runs `compareUrls`, so two things it used to
 * do stop: its `validator::` requirements no longer run for that request (a throwing
 * validator on a rule that cannot match the URL no longer answers 500), and it no
 * longer leaves captured values in `req.params` / the method bag when no rule matches
 * (visible only to a custom error page).
 *
 * The index is built once per routing table object and bundle (a `WeakMap`), from the
 * table `config.getRouting()` returns. Nothing adds or removes a rule in that table
 * after boot: the per-request writes go to copies (`router.js` per-rule copy,
 * ws-query's `JSON.clone`), and a table object replaced by a reload is indexed anew.
 *
 * Server-only: not part of the browser bundle. It lives under `core/` on purpose — the
 * pre-commit gate treats `lib/routing/src/` as bundled source.
 *
 * @module gina/core/server.route-candidates
 */

/**
 * The result of classifying one URL variant of a rule.
 *
 * @constant
 * @type {{TRIE: number, SKIP: number, ALWAYS: number}}
 */
var CLASS = { TRIE: 1, SKIP: 2, ALWAYS: 3 };

/**
 * One node of the path index.
 *
 * @typedef {object} RouteIndexNode
 * @property {Object<string, RouteIndexNode>} s - static children, keyed by the exact segment (a null-prototype map, so `toString` or `__proto__` is an ordinary key)
 * @property {RouteIndexNode|null} p - the parameter child: any segment holding a `:`
 * @property {string[]} n - the rule names whose url variant ends at this node
 */

/**
 * The candidate index of one bundle's rules in one routing table.
 *
 * @typedef {object} RouteIndex
 * @property {RouteIndexNode} root - the path index; the leading empty segment is not stored
 * @property {Object<string, string[]>} literal - raw url string → rule names (null-prototype map)
 * @property {string[]} always - rule names evaluated for every request the index models
 * @property {number} size - the number of rules indexed (all three parts together)
 */

/**
 * Indexes built so far: routing table object → Map(bundle → RouteIndex).
 *
 * @type {WeakMap<object, Map<string, RouteIndex>>}
 */
var _indexes = new WeakMap();

/**
 * A new, empty path-index node.
 *
 * @inner
 * @returns {RouteIndexNode}
 */
function createNode() {
    return { s: Object.create(null), p: null, n: [] };
}

/**
 * Counts a rule's own requirements that are NOT bound as a whole `:key` segment of
 * one url variant — the keys `parseRouting` may write over the compared segments for
 * a GET or DELETE request carrying them (#B650 limited them to the rule's OWN keys).
 * A requirement used only inside a segment (`page:number`) counts, as it does there.
 * Exported for the unit tests.
 *
 * @private
 * @param {*} requirements - the rule's `requirements`
 * @param {string[]} segments - the variant split on `/`
 * @returns {number} the count, or `Infinity` when `requirements` is not an object
 */
function countUnboundRequirements(requirements, segments) {
    if (typeof requirements === 'undefined' || requirements === null) {
        return 0;
    }
    if (typeof requirements !== 'object') {
        // lib/routing tests these with hasOwnProperty.call: a string or a function has
        // own properties (`length`, `name`) that would count — never model it
        return Infinity;
    }
    var keys = Object.getOwnPropertyNames(requirements), count = 0;
    for (var i = 0; i < keys.length; i++) {
        if (typeof requirements[keys[i]] === 'undefined') continue;
        if (segments.indexOf(':' + keys[i]) < 0) ++count;
    }
    return count;
}

/**
 * Decides how one url variant of a rule is indexed. Exported for the unit tests.
 *
 * @private
 * @param {*} requirements - the rule's `requirements`
 * @param {string} variant - one comma-separated part of the rule's url, untrimmed
 * @returns {number} `CLASS.TRIE` (insert it), `CLASS.SKIP` (it cannot match a path the index models) or `CLASS.ALWAYS` (evaluate the rule for every request)
 */
function classifyVariant(requirements, variant) {
    if (variant !== variant.trim() || /[?#]/.test(variant)) {
        return CLASS.ALWAYS;
    }
    var segments = variant.split('/');
    var unbound  = countUnboundRequirements(requirements, segments);
    if (unbound >= 2) {
        return CLASS.ALWAYS;
    }
    if (variant.charAt(0) !== '/') {
        // index 0 is a real segment here, and one unbound key replaces it; without
        // one, the variant has one segment fewer than any path starting with `/`
        return (unbound >= 1) ? CLASS.ALWAYS : CLASS.SKIP;
    }
    for (var i = 1; i < segments.length; i++) {
        // an empty segment can only equal an empty request segment, and lookup()
        // returns null for every path holding one
        if (segments[i] === '') return CLASS.SKIP;
    }
    return CLASS.TRIE;
}

/**
 * Inserts one url variant (starting with `/`, no empty segment after it).
 *
 * @inner
 * @param {RouteIndexNode} root
 * @param {string} variant
 * @param {string} name - the rule name
 * @returns {void}
 */
function insert(root, variant, name) {
    var segments = variant.split('/'), node = root;
    for (var i = 1; i < segments.length; i++) {
        var s = segments[i];
        if (s.indexOf(':') > -1) {
            if (node.p === null) node.p = createNode();
            node = node.p;
        } else {
            if (typeof node.s[s] === 'undefined') node.s[s] = createNode();
            node = node.s[s];
        }
    }
    if (node.n.indexOf(name) < 0) node.n.push(name);
}

/**
 * Builds the candidate index of one bundle's rules. Walks the table the way the
 * routing loop does (`for…in`, non-object entries skipped, `bundle` compared with
 * `!=`), so a rule the loop would skip for another bundle is left out.
 *
 * @param {object} routing - the table `config.getRouting(bundle, env)` returns
 * @param {string} bundle - the bundle being routed
 * @returns {RouteIndex}
 *
 * @example
 * var index = build({
 *     'item@api': { bundle: 'api', url: '/items/:id', method: 'GET', param: { control: 'get', id: ':id' } }
 * }, 'api');
 * lookup(index, '/items/7', '/items/7'); // Set { 'item@api' }
 */
function build(routing, bundle) {
    var index = { root: createNode(), literal: Object.create(null), always: [], size: 0 };
    for (var name in routing) {
        var rule = routing[name];
        if (typeof rule !== 'object' || rule === null) continue;
        if (rule.bundle != bundle) continue;
        ++index.size;

        var url = rule.url;
        if (typeof url !== 'string') {
            index.always.push(name);
            continue;
        }

        if (typeof index.literal[url] === 'undefined') index.literal[url] = [];
        index.literal[url].push(name);

        var variants = url.split(/\,/g), toInsert = [], always = false;
        for (var v = 0; v < variants.length; v++) {
            var c = classifyVariant(rule.requirements, variants[v]);
            if (c === CLASS.ALWAYS) { always = true; break; }
            if (c === CLASS.TRIE) toInsert.push(variants[v]);
        }
        if (always) {
            index.always.push(name);
            continue;
        }
        for (var i = 0; i < toInsert.length; i++) {
            insert(index.root, toInsert[i], name);
        }
    }
    return index;
}

/**
 * Collects the rule names whose variant structurally matches `segments[i…]`.
 *
 * @inner
 * @param {RouteIndexNode} node
 * @param {string[]} segments - the decoded request path split on `/`
 * @param {number} i - the next segment to match
 * @param {Set<string>} out
 * @returns {void}
 */
function collect(node, segments, i, out) {
    if (i === segments.length) {
        for (var k = 0; k < node.n.length; k++) out.add(node.n[k]);
        return;
    }
    var child = node.s[segments[i]];
    if (typeof child !== 'undefined') collect(child, segments, i + 1, out);
    if (node.p !== null) collect(node.p, segments, i + 1, out);
}

/**
 * The candidate rule names for one request.
 *
 * @param {RouteIndex} index
 * @param {string} rawPathname - the request path as the routing loop compares it (`pathname`)
 * @param {string} decodedPathname - the same path through `safeDecodeURI`, as `compareUrls` receives it
 * @returns {Set<string>|null} the candidates (possibly empty: no rule can match), or `null` when the path is one the index does not model — scan every rule
 *
 * @example
 * lookup(index, '/items/7', '/items/7');   // Set { 'item@api' }
 * lookup(index, '/nothing', '/nothing');   // Set {} — a 404 without scanning
 * lookup(index, '/items/', '/items/');     // null — full scan
 */
function lookup(index, rawPathname, decodedPathname) {
    if (typeof decodedPathname !== 'string' || decodedPathname.charAt(0) !== '/' || /[?#]/.test(decodedPathname)) {
        return null;
    }
    var segments = decodedPathname.split('/');
    for (var i = 1; i < segments.length; i++) {
        if (segments[i] === '') return null;
    }

    var out = new Set();
    collect(index.root, segments, 1, out);

    var literal = index.literal[rawPathname];
    if (typeof literal !== 'undefined') {
        for (var l = 0; l < literal.length; l++) out.add(literal[l]);
    }
    for (var a = 0; a < index.always.length; a++) out.add(index.always[a]);
    return out;
}

/**
 * The candidate rule names for one request against a routing table, building and
 * caching the table's index on first use. Any unexpected error yields `null` (scan
 * every rule, as before): the caller awaits nothing here and has no `try` around it.
 *
 * @param {object} routing - the table `config.getRouting(bundle, env)` returns
 * @param {string} bundle - the bundle being routed
 * @param {string} rawPathname - the request path as the routing loop compares it
 * @param {string} decodedPathname - `safeDecodeURI(rawPathname)`
 * @returns {Set<string>|null}
 *
 * @example
 * var candidates = candidatesFor(routing, bundle, pathname, safeDecodeURI(pathname));
 * // in the loop: if ( candidates !== null && !candidates.has(name) ) continue;
 */
function candidatesFor(routing, bundle, rawPathname, decodedPathname) {
    try {
        if (routing === null || typeof routing !== 'object') return null;
        var byBundle = _indexes.get(routing);
        if (typeof byBundle === 'undefined') {
            byBundle = new Map();
            _indexes.set(routing, byBundle);
        }
        var index = byBundle.get(bundle);
        if (typeof index === 'undefined') {
            index = build(routing, bundle);
            byBundle.set(bundle, index);
        }
        return lookup(index, rawPathname, decodedPathname);
    } catch (err) {
        return null;
    }
}

module.exports = {
    CLASS                    : CLASS,
    build                    : build,
    lookup                   : lookup,
    candidatesFor            : candidatesFor,
    classifyVariant          : classifyVariant,
    countUnboundRequirements : countUnboundRequirements
};
