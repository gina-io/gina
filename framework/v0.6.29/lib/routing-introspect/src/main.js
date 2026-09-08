/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/routing-introspect
 *
 * Semantic extractor for `routing.json`. Shared by `bundle:openapi` and
 * `bundle:mcp`. Parses URL patterns, HTTP methods, parameter requirements,
 * and derives stable tool / operation identifiers from a bundle routing
 * manifest.
 *
 * This module is pure — it does not read the filesystem, does not require
 * lib.*, and does not touch global state. Callers pass a parsed routing
 * object (the shape published as `schema/routing.json`) and receive back
 * JSON-serialisable descriptors.
 *
 * @example
 * var introspect = require('lib/routing-introspect');
 * var tools = [];
 * introspect.eachRoute(routing, function(routeName, route) {
 *     var urls = introspect.parseUrls(route.url);
 *     var methods = introspect.parseMethods(route.method);
 *     // ...
 * });
 */

/**
 * @typedef {Object} UrlInfo
 * @property {string}   openApiPath - OpenAPI path form (`{param}` placeholders).
 * @property {string}   mcpPath     - Colon-prefix form preserved verbatim (`:param`).
 * @property {string[]} params      - Ordered list of parameter names.
 */

/**
 * @typedef {Object} PatternInfo
 * @property {'pattern'|'enum'} type
 * @property {string|string[]}  value
 */

/**
 * Parses a `url` field (string, comma-separated string, or array) into an
 * array of {@link UrlInfo} entries.
 *
 * Accepts any of these routing.json shapes:
 * - `"url": "/path/:id"`
 * - `"url": "/path/:id, /path/:id/:slug"`
 * - `"url": ["/path/:id", "/path/:id/:slug"]`
 *
 * @memberof module:gina/lib/routing-introspect
 * @param   {string|string[]} raw
 * @returns {UrlInfo[]}
 *
 * @example
 * parseUrls('/user/:id');
 * // [{ openApiPath: '/user/{id}', mcpPath: '/user/:id', params: ['id'] }]
 *
 * @example
 * parseUrls('/a, /a/:b');
 * // [
 * //   { openApiPath: '/a',     mcpPath: '/a',     params: [] },
 * //   { openApiPath: '/a/{b}', mcpPath: '/a/:b',  params: ['b'] }
 * // ]
 */
var parseUrls = function(raw) {
    var patterns = [];

    if ( Array.isArray(raw) ) {
        patterns = raw;
    } else if ( typeof(raw) === 'string' ) {
        patterns = raw.split(',');
    }

    var results = [];
    for (var i = 0; i < patterns.length; i++) {
        var p = String(patterns[i]).trim();
        if (!p) continue;

        var params = [];
        var oaPath = p.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, function(match, name) {
            params.push(name);
            return '{' + name + '}';
        });

        // OpenAPI disallows trailing slash (except for "/")
        if (oaPath.length > 1 && oaPath.charAt(oaPath.length - 1) === '/') {
            oaPath = oaPath.slice(0, -1);
        }

        results.push({ openApiPath: oaPath, mcpPath: p, params: params });
    }

    return results;
};

/**
 * Parses the `method` field into an array of lowercase HTTP method strings.
 * Defaults to `['get']` when missing or non-string.
 *
 * @memberof module:gina/lib/routing-introspect
 * @param   {string} [raw]
 * @returns {string[]}
 *
 * @example
 * parseMethods('GET, POST');     // ['get', 'post']
 * parseMethods(undefined);       // ['get']
 * parseMethods('put , delete '); // ['put', 'delete']
 */
var parseMethods = function(raw) {
    if ( !raw || typeof(raw) !== 'string' ) return ['get'];

    return raw.split(',').map(function(m) {
        return m.trim().toLowerCase();
    }).filter(function(m) {
        return m.length > 0;
    });
};

/**
 * Converts a routing.json `requirements` value into a portable
 * {@link PatternInfo} descriptor suitable for JSON Schema `pattern` or `enum`.
 *
 * Handles four input shapes:
 * 1. Regex with slash delimiters: `/^[a-z]+$/i` → `{ type: 'pattern', value: '^[a-z]+$' }` (flags stripped)
 * 2. Simple pipe alternatives: `"admin|user|guest"` → `{ type: 'enum', value: [...] }`
 * 3. Bare regex body: `"(^foo|bar$)"` → `{ type: 'pattern', value: '^foo|bar$' }` (wrapping parens stripped)
 * 4. Validator reference: `"validator::email"` → `{ type: 'pattern', value: '.*' }` (runtime-only)
 *
 * JSON Schema does not support regex flags — `/^X$/i` loses case-insensitivity
 * in the emitted pattern. Document this limitation in the generator output when
 * emitting the schema.
 *
 * @memberof module:gina/lib/routing-introspect
 * @param   {string} raw
 * @returns {PatternInfo}
 *
 * @example
 * requirementToPattern('/^[0-9a-f]{8}-/i');     // { type: 'pattern', value: '^[0-9a-f]{8}-' }
 * requirementToPattern('admin|user|guest');     // { type: 'enum', value: ['admin','user','guest'] }
 * requirementToPattern('validator::email');     // { type: 'pattern', value: '.*' }
 * requirementToPattern('(^foo|bar$)');          // { type: 'pattern', value: '^foo|bar$' }
 */
var requirementToPattern = function(raw) {
    if ( typeof(raw) !== 'string' ) return { type: 'pattern', value: '.*' };

    if ( raw.indexOf('validator::') === 0 ) {
        return { type: 'pattern', value: '.*' };
    }

    // Regex with slash delimiters
    if ( raw.charAt(0) === '/' ) {
        var lastSlash = raw.lastIndexOf('/');
        if (lastSlash > 0) {
            return { type: 'pattern', value: raw.substring(1, lastSlash) };
        }
        return { type: 'pattern', value: raw.substring(1) };
    }

    // Pipe alternatives that look like a plain enum (no regex meta-chars)
    if ( raw.indexOf('|') !== -1 && !/[\\()\[\]{}^$.*+?]/.test(raw.replace(/\|/g, '')) ) {
        return { type: 'enum', value: raw.split('|') };
    }

    // Regex body without slash delimiters — strip wrapping parens if balanced
    var cleaned = raw;
    if (cleaned.charAt(0) === '(' && cleaned.charAt(cleaned.length - 1) === ')') {
        cleaned = cleaned.substring(1, cleaned.length - 1);
    }

    return { type: 'pattern', value: cleaned };
};

/**
 * #B201 — annotates a numeric-type schema fragment with the rule's DIGIT bounds.
 *
 * `isInteger` / `isNumber` bounds constrain the LENGTH OF THE VALUE'S STRING
 * FORM (a negative sign counts toward it), not the value's range — so they are
 * deliberately NOT mapped to `minimum`/`maximum` (wrong for any negative:
 * digit bounds [2,4] admit `[-999,-1] ∪ [10,9999]`, which no single range
 * expresses) nor to `minLength`/`maxLength` (string-only assertions, inert on
 * numeric types — a documented bound nothing enforces). Instead the fragment
 * gains an honest human-readable `description` plus a namespaced
 * machine-readable `x-gina-digitBounds` extension; both bundle:openapi and
 * bundle:mcp copy fragment keys verbatim, so the annotations reach the
 * generated schemas as-is.
 *
 * @inner
 * @param   {object} s - the fragment being built (mutated)
 * @param   {number|Array|boolean} v - the rule's declared value
 * @returns {undefined}
 */
var annotateDigitBounds = function(s, v) {
    var min = null, max = null;
    if ( typeof(v) === 'number' ) {
        min = v; // scalar N supplies minLength only — same arity contract as isString
    } else if ( Array.isArray(v) ) {
        if ( typeof(v[0]) === 'number' ) min = v[0];
        if ( typeof(v[1]) === 'number' ) max = v[1];
    }
    if ( min === null && max === null ) return; // bare `true` — nothing declared

    var bounds = {};
    var text = null;
    if ( min !== null && max !== null ) {
        text = (min === max) ? ('exactly ' + min + ' digits') : (min + '-' + max + ' digits');
    } else if ( min !== null ) {
        text = 'at least ' + min + ' digits';
    } else {
        text = 'at most ' + max + ' digits';
    }
    if ( min !== null ) bounds.min = min;
    if ( max !== null ) bounds.max = max;

    s.description = text + ' (string-form length; a negative sign counts)';
    s['x-gina-digitBounds'] = bounds;
};

/**
 * Maps a single-field form-validator rules-object to a JSON Schema fragment
 * (the inverse of the DTO builder's toRules, for the curated vocabulary). Pure
 * and inline — routing-introspect does not require lib.dto (its purity contract).
 *
 * Length bounds (#B201): `isString` maps its scalar and array forms to real
 * `minLength`/`maxLength` facets (`isString: 8` === `isString: [8]` — the
 * scalar supplies a minimum, per the engine's arity contract). `isInteger` /
 * `isNumber` digit bounds are annotated via {@link annotateDigitBounds}
 * (description + `x-gina-digitBounds`) rather than mapped to value facets —
 * see that function's JSDoc for why both facet mappings would be wrong.
 *
 * @memberof module:gina/lib/routing-introspect
 * @param   {object} rules - e.g. `{ isEmail: true, isString: [7] }`
 * @returns {object} a JSON Schema fragment (always includes `type`)
 *
 * @example
 * rulesToSchemaFragment({ isEmail: true, isString: [7] });
 * // { type: 'string', format: 'email', minLength: 7 }
 *
 * @example
 * rulesToSchemaFragment({ isInteger: [2, 4] });
 * // { type: 'integer',
 * //   description: '2-4 digits (string-form length; a negative sign counts)',
 * //   'x-gina-digitBounds': { min: 2, max: 4 } }
 */
var rulesToSchemaFragment = function(rules) {
    var s = {};
    if ( !rules || typeof(rules) !== 'object' ) return { type: 'string' };

    for (var rule in rules) {
        if ( !rules.hasOwnProperty(rule) ) continue;
        var v = rules[rule];
        switch (rule) {
            case 'isEmail':   s.type = 'string';  s.format = 'email'; break;
            case 'isString':
                s.type = 'string';
                if ( Array.isArray(v) ) {
                    if ( typeof(v[0]) === 'number' ) s.minLength = v[0];
                    if ( typeof(v[1]) === 'number' ) s.maxLength = v[1];
                } else if ( typeof(v) === 'number' ) {
                    // #B201 - the scalar form was silently dropped; the engine
                    // treats `isString: 8` as a minimum, identical to `[8]`.
                    s.minLength = v;
                }
                break;
            case 'isInteger': s.type = 'integer'; annotateDigitBounds(s, v); break;
            case 'isNumber':  s.type = 'number';  annotateDigitBounds(s, v); break;
            case 'isBoolean': s.type = 'boolean'; break;
            case 'isDate':    s.type = 'string';  s.format = 'date'; break;
            case 'isInList':  if ( Array.isArray(v) ) s.enum = v.slice(); break;
            // isRequired -> object/param level; is / toFloat / query / exclude / trim: not schema-expressible here.
        }
    }

    if ( !s.type ) {
        if ( Array.isArray(s.enum) && s.enum.length ) {
            var t = typeof(s.enum[0]), homo = true;
            for (var i = 1; i < s.enum.length; i++) {
                if ( typeof(s.enum[i]) !== t ) { homo = false; break; }
            }
            s.type = (homo && (t === 'string' || t === 'number' || t === 'boolean')) ? t : 'string';
        } else {
            s.type = 'string';
        }
    }
    return s;
};

/**
 * Converts a routing.json `requirements` value into a JSON Schema fragment,
 * UN-COLLAPSING an inline `validator::{...}` rule object into the schema keywords
 * it implies (isEmail -> format:email, isString:[min,max] -> minLength/maxLength,
 * isInList:[...] -> enum, isInteger -> integer, ...). Richer than
 * {@link requirementToPattern}: instead of collapsing a validator requirement to
 * `.*`, bundle:openapi / bundle:mcp now emit a real parameter schema.
 *
 * The inline validator:: object is parsed with the same split + JSON.parse the
 * router uses (lib/routing keys are quoted before the parse). A bare NAMED
 * validator (`validator::email`, no inline object) can't be resolved without the
 * Validator registry (which would break this module's purity), so it degrades to
 * `{ type: 'string' }`. Regex and pipe-enum requirements defer to
 * {@link requirementToPattern}.
 *
 * @memberof module:gina/lib/routing-introspect
 * @param   {string} raw
 * @returns {object} a JSON Schema fragment (always includes `type`)
 *
 * @example
 * requirementToSchema('validator::{ isEmail: true, isString: [7] }');
 * // { type: 'string', format: 'email', minLength: 7 }
 * requirementToSchema('admin|user');       // { type: 'string', enum: ['admin', 'user'] }
 * requirementToSchema('/^[0-9]+$/');        // { type: 'string', pattern: '^[0-9]+$' }
 * requirementToSchema('validator::email');  // { type: 'string' }  (named — unresolvable purely)
 */
var requirementToSchema = function(raw) {
    if ( typeof(raw) !== 'string' ) return { type: 'string' };

    if ( raw.indexOf('validator::') === 0 ) {
        var body = raw.split('::').splice(1).join('::');
        if ( body.indexOf('{') < 0 ) {
            return { type: 'string' };   // bare named validator — unresolvable purely
        }
        var rules = null;
        try {
            // same key-quoting + JSON.parse the router uses (lib/routing/src/main.js)
            rules = JSON.parse(
                body
                    .replace(/([^\:\"\s+](\w+))\:/g, '"$1":')
                    .replace(/([^\:\"\s+](\w+))\s+\:/g, '"$1":')
            );
        } catch (e) {
            return { type: 'string' };   // malformed inline object — safe fallback
        }
        return rulesToSchemaFragment(rules);
    }

    var p = requirementToPattern(raw);
    if ( p.type === 'enum' ) return { type: 'string', enum: p.value };
    return { type: 'string', pattern: p.value };
};

/**
 * Converts a hyphenated / snake_case / camelCase route name to a
 * human-readable title. Used as a fallback when `route.param.title` is absent.
 *
 * @memberof module:gina/lib/routing-introspect
 * @param   {string} name
 * @returns {string}
 *
 * @example
 * humanise('user-get-profile'); // 'User get profile'
 * humanise('getUserProfile');   // 'Get user profile'
 */
var humanise = function(name) {
    if ( typeof(name) !== 'string' || !name.length ) return '';
    var words = name.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * Derives a stable identifier for a route. `namespace.control` when both are
 * present; falls back to the route name. Used as OpenAPI `operationId` and
 * MCP tool `name`.
 *
 * @memberof module:gina/lib/routing-introspect
 * @param   {string} routeName
 * @param   {object} route
 * @returns {string}
 *
 * @example
 * toolName('getProfile', { namespace: 'user', param: { control: 'getProfile' } });
 * // 'user.getProfile'
 *
 * @example
 * toolName('homepage', { param: { control: 'home' } });
 * // 'home'
 */
var toolName = function(routeName, route) {
    var param = route && route.param || {};
    if (route && route.namespace && param.control) {
        return route.namespace + '.' + param.control;
    }
    return param.control || routeName;
};

/**
 * Builds a human-readable Cache-Control descriptor from a `route.cache` value.
 *
 * @memberof module:gina/lib/routing-introspect
 * @param   {string|object} cache
 * @returns {string|null}
 *
 * @example
 * buildCacheHeader('memory');                       // 'private, cached (memory)'
 * buildCacheHeader({ visibility: 'public', ttl: 60 }); // 'public, max-age=60'
 * buildCacheHeader(null);                           // null
 */
var buildCacheHeader = function(cache) {
    if ( typeof(cache) === 'string' ) {
        return 'private, cached (' + cache + ')';
    }
    if ( cache && typeof(cache) === 'object' ) {
        var parts = [];
        parts.push(cache.visibility || 'private');
        if ( typeof(cache.ttl) !== 'undefined' ) {
            parts.push('max-age=' + cache.ttl);
        }
        return parts.join(', ');
    }
    return null;
};

/**
 * Returns true when the route should be treated as framework-internal and
 * excluded from agent-consumable manifests (OpenAPI, MCP). Currently this
 * means URLs under `/_gina/*` — the Inspector / live-reload endpoints.
 *
 * @memberof module:gina/lib/routing-introspect
 * @param   {object} route
 * @returns {boolean}
 */
var isFrameworkInternal = function(route) {
    if ( !route || typeof(route.url) !== 'string' ) return false;
    var first = route.url.split(',')[0].trim();
    return first.indexOf('/_gina/') === 0 || first === '/_gina';
};

/**
 * Iterates every valid route entry in a parsed `routing.json`. Skips the
 * `$schema` key and any non-object value. The callback receives the route
 * name and the raw route object — callers are free to ignore internal routes
 * (see {@link isFrameworkInternal}) or redirect control flows based on
 * `route.param.control`.
 *
 * @memberof module:gina/lib/routing-introspect
 * @param {object}   routing
 * @param {function} cb - `(routeName, route) => void`. Return `false` to stop iteration.
 * @returns {void}
 *
 * @example
 * var routing = require('/path/to/routing.json');
 * require('lib/routing-introspect').eachRoute(routing, function(name, route) {
 *     console.log(name, route.url);
 * });
 */
var eachRoute = function(routing, cb) {
    if ( !routing || typeof(routing) !== 'object' ) return;
    for (var routeName in routing) {
        if ( !routing.hasOwnProperty(routeName) ) continue;
        if ( routeName === '$schema' ) continue;
        var route = routing[routeName];
        if ( typeof(route) !== 'object' || route === null ) continue;
        if ( cb(routeName, route) === false ) return;
    }
};

module.exports = {
    parseUrls           : parseUrls,
    parseMethods        : parseMethods,
    requirementToPattern: requirementToPattern,
    requirementToSchema : requirementToSchema,
    rulesToSchemaFragment: rulesToSchemaFragment,
    humanise            : humanise,
    toolName            : toolName,
    buildCacheHeader    : buildCacheHeader,
    isFrameworkInternal : isFrameworkInternal,
    eachRoute           : eachRoute
};
