/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Route radix trie — O(m) URL candidate lookup, where m = segment count.
 *
 * Built once at startup from the routing config; never mutated after build.
 * The trie is a "candidate selector": it returns route names whose URL
 * structure matches the request pathname. The existing `compareUrls()` /
 * `parseRouting()` machinery validates the final match (HTTP method,
 * requirements, param extraction) — this file only handles structure.
 *
 * Node shape:
 *   {
 *     static : { segment: node, … },  // exact segment children
 *     param  : node | null,           // wildcard child for :param segments
 *     names  : [ routeName, … ]       // route names terminating here
 *   }
 *
 * Build: O(n × m)   n = routes, m = segments per URL
 * Lookup: O(m)
 */

/**
 * Create an empty trie node.
 * @returns {object}
 */
function createNode() {
    return { static: {}, param: null, names: [] };
}

/**
 * Insert one URL pattern + route name into the trie.
 *
 * @param {object} root  - root trie node
 * @param {string} url   - URL pattern, e.g. "/api/users/:id/posts"
 * @param {string} name  - route key,   e.g. "getPost@api"
 */
function insert(root, url, name) {
    // Strip query string / fragment if present
    var clean = url.split('?')[0].split('#')[0].trim();
    var segs  = clean.split('/');
    var node  = root;

    for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (s === '') continue;         // skip empty: leading slash, double slashes

        if (s.charAt(0) === ':') {
            // Wildcard (param) segment — matches any single path component
            if (!node.param) node.param = createNode();
            node = node.param;
        } else {
            // Static segment — exact match only
            if (!node.static[s]) node.static[s] = createNode();
            node = node.static[s];
        }
    }

    // Terminal: record this route name as a candidate at this depth
    if (node.names.indexOf(name) < 0) node.names.push(name);
}

/**
 * Return all candidate route names whose URL structure matches pathname.
 * May return multiple candidates when static and param paths overlap.
 *
 * @param {object} root      - root trie node (from buildTrie)
 * @param {string} pathname  - request pathname, e.g. "/api/users/42/posts"
 * @returns {string[]}       - candidate route names (may be empty)
 */
function lookup(root, pathname) {
    var clean = pathname.split('?')[0].split('#')[0];
    var segs  = clean.split('/');
    var out   = [];
    _match(root, segs, 0, out);
    return out;
}

/**
 * Recursive trie traversal.
 *
 * @param {object}   node
 * @param {string[]} segs
 * @param {number}   depth
 * @param {string[]} out
 * @private
 */
function _match(node, segs, depth, out) {
    // Skip empty segments (leading slash, consecutive slashes)
    while (depth < segs.length && segs[depth] === '') depth++;

    if (depth === segs.length) {
        // End of URL — collect all route names terminating here
        for (var i = 0; i < node.names.length; i++) out.push(node.names[i]);
        return;
    }

    var s = segs[depth];

    // Static child takes priority (more specific than param)
    if (node.static[s]) _match(node.static[s], segs, depth + 1, out);

    // Param child matches any segment — always try if present
    if (node.param) _match(node.param, segs, depth + 1, out);
}

module.exports = { createNode: createNode, insert: insert, lookup: lookup };
