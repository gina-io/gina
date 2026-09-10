/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Pipeline loader — parses MongoDB pipeline JSON files.
 *
 * A pipeline file describes a single Mongo operation:
 *
 *   /**
 *    * @param {objectid} arg0  user id
 *    * @return {object}
 *    *​/
 *   {
 *     "op": "findOne",
 *     "filter": { "_id": {"$arg": 0}, "_scope": "$scope" }
 *   }
 *
 * The optional leading JSDoc block carries `@param` / `@return` annotations
 * (mirrors the SQL/CQL convention used by every other gina connector).
 * The JSON body is parsed and walked at load time to substitute the
 * literal string `"$scope"` with the bundle's data isolation scope.
 *
 * Argument placeholders inside the pipeline body use the EJSON-like shape
 * `{"$arg": N}` (positional). They are NOT replaced here — the runtime
 * method walker substitutes them at query time, after castParam.
 *
 * ObjectId literals inside the pipeline body use `{"$oid": "<hex>"}`.
 * They are NOT replaced here either — the runtime walker passes them
 * to the mongodb ObjectId constructor at query time.
 *
 * @module gina/core/connectors/mongodb/lib/pipeline-loader
 */

/**
 * Extract the leading block comment from the source (verbatim, without
 * the surrounding `/​*` and `*​/`), or null.
 *
 * The header is recognised only when the file STARTS with optional
 * whitespace followed by `/​*`. Anything else is treated as comment-free.
 *
 * @param {string} source
 * @returns {string|null}
 */
function extractHeader(source) {
    var i = 0, len = source.length;
    while (i < len && /\s/.test(source[i])) i++;
    if (i + 2 >= len) return null;
    if (source[i] !== '/' || source[i + 1] !== '*') return null;
    i += 2;
    var start = i;
    while (i < len) {
        if (source[i] === '*' && source[i + 1] === '/') {
            return source.substring(start, i);
        }
        i++;
    }
    return null;
}

/**
 * Strip a leading block comment so JSON.parse can run on what remains.
 *
 * @param {string} source
 * @returns {string}
 */
function stripHeader(source) {
    var i = 0, len = source.length;
    while (i < len && /\s/.test(source[i])) i++;
    if (i + 2 >= len) return source;
    if (source[i] !== '/' || source[i + 1] !== '*') return source;
    i += 2;
    while (i < len) {
        if (source[i] === '*' && source[i + 1] === '/') {
            return source.substring(i + 2);
        }
        i++;
    }
    return source;
}

/**
 * Parse `@param` annotations from the header. Returns the type list
 * in declaration order; names and descriptions are ignored.
 *
 * Format: `@param {<type>} <name>  <description>`
 *
 * @param {string|null} header
 * @returns {string[]}
 */
function parseParamTypes(header) {
    if (!header) return [];
    var types = [];
    var matches = header.match(/@param\s+\{([^}]+)\}/g);
    if (!matches) return types;
    for (var i = 0; i < matches.length; i++) {
        var m = matches[i].match(/\{([^}]+)\}/);
        if (m) types.push(m[1].trim().toLowerCase());
    }
    return types;
}

/**
 * Parse the `@return` annotation from the header. Returns the type
 * lowercased, or null. Recognised types: object, array, boolean, number.
 *
 * @param {string|null} header
 * @returns {string|null}
 */
function parseReturnType(header) {
    if (!header) return null;
    var m = header.match(/@return\s+\{([^}]+)\}/);
    return m ? m[1].trim().toLowerCase() : null;
}

/**
 * Substitute the literal string `"$scope"` with the given scope value
 * at every position in the parsed tree. Mutates the input.
 *
 * @param {*} node
 * @param {string} scope
 * @returns {*}
 */
function substituteScope(node, scope) {
    if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
            if (node[i] === '$scope') {
                node[i] = scope;
            } else if (node[i] && typeof node[i] === 'object') {
                substituteScope(node[i], scope);
            }
        }
    } else if (node && typeof node === 'object') {
        var keys = Object.keys(node);
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            if (node[key] === '$scope') {
                node[key] = scope;
            } else if (node[key] && typeof node[key] === 'object') {
                substituteScope(node[key], scope);
            }
        }
    }
    return node;
}

/**
 * Parse a pipeline file source into `{ paramTypes, returnType, body }`.
 *
 * @param {string} source - Raw file content.
 * @param {string} scope  - Bundle data isolation scope (e.g. 'local').
 * @returns {{ paramTypes: string[], returnType: ?string, body: object }}
 * @throws {Error} If the JSON body is empty or malformed.
 */
function parse(source, scope) {
    var header     = extractHeader(source);
    var paramTypes = parseParamTypes(header);
    var returnType = parseReturnType(header);

    var json = stripHeader(source).trim();
    if (!json) {
        throw new Error('pipeline file is empty');
    }
    var body = JSON.parse(json);
    substituteScope(body, scope);

    return {
        paramTypes: paramTypes,
        returnType: returnType,
        body      : body
    };
}

module.exports = {
    parse           : parse,
    extractHeader   : extractHeader,
    stripHeader     : stripHeader,
    parseParamTypes : parseParamTypes,
    parseReturnType : parseReturnType,
    substituteScope : substituteScope
};
