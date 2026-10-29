'use strict';
/**
 * #B360 — which routing `requirements` regexes are anchored at both ends.
 *
 * A `requirements` value such as `"/[0-9]+/"` is tested with `RegExp#test` when a request is
 * matched, which is a partial (search) match: it accepts `123abc`, because the value CONTAINS a
 * match. Only a pattern anchored at both ends (`^…$`) constrains the whole value. The config
 * loader uses this module to warn once per bundle, listing the requirements that are not
 * anchored; it only READS the routing table and never rewrites a requirement (the #P46
 * route-candidate index caches per routing table object and reads requirement keys).
 *
 * "Anchored" is decided per top-level alternative, so `/(^draft$|^[0-9]+$)/` is anchored (each
 * alternative is) while `/^txt|html$/` is not (`^txt` has no end anchor, `html$` no start
 * anchor). The `m` flag makes `^` and `$` match at line breaks, so a value carrying a newline
 * could pass: a pattern with it counts as not anchored. `validator::` requirements are not
 * regexes and are skipped.
 *
 * Server-side only: the browser bundle never loads this file.
 *
 * @module core/config.requirements-anchor
 */

/**
 * Split a regex body on its top-level `|` — outside groups and character classes, and not
 * escaped.
 *
 * @inner
 * @private
 * @param {string} body - The pattern between the slashes
 * @returns {string[]} The top-level alternatives (one entry when there is no top-level `|`)
 *
 * @example
 *   splitTopLevel('^a|b$');         // ['^a', 'b$']
 *   splitTopLevel('^(a|b)$');       // ['^(a|b)$']
 */
function splitTopLevel(body) {
    var parts = [], depth = 0, inClass = false, start = 0;
    for (var i = 0; i < body.length; i++) {
        var c = body[i];
        if (c === '\\') { i++; continue; }
        if (inClass) {
            if (c === ']') { inClass = false; }
        } else if (c === '[') {
            inClass = true;
        } else if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth--;
        } else if (c === '|' && depth === 0) {
            parts.push(body.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(body.slice(start));
    return parts;
}

/**
 * The inner body of a group that spans the whole alternative — `(…)` or `(?:…)` — or null.
 *
 * @inner
 * @private
 * @param {string} alt - One alternative
 * @returns {?string} The group's inner body, without a leading `?:`, or null
 *
 * @example
 *   wholeGroupBody('(^a$|^b$)');    // '^a$|^b$'
 *   wholeGroupBody('(a)b');         // null
 */
function wholeGroupBody(alt) {
    if (alt.charAt(0) !== '(') { return null; }
    var depth = 0, inClass = false;
    for (var i = 0; i < alt.length; i++) {
        var c = alt[i];
        if (c === '\\') { i++; continue; }
        if (inClass) {
            if (c === ']') { inClass = false; }
        } else if (c === '[') {
            inClass = true;
        } else if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth--;
            if (depth === 0) {
                if (i !== alt.length - 1) { return null; }
                var inner = alt.slice(1, i);
                return (inner.slice(0, 2) === '?:') ? inner.slice(2) : inner;
            }
        }
    }
    return null;
}

/**
 * Whether a pattern ends with an unescaped `$` (an even count of backslashes before it).
 *
 * @inner
 * @private
 * @param {string} s - A pattern
 * @returns {boolean} true when the final `$` is an anchor, not a literal
 *
 * @example
 *   endsWithAnchor('a$');           // true
 *   endsWithAnchor('a\\$');         // false (a literal dollar)
 */
function endsWithAnchor(s) {
    if (s.charAt(s.length - 1) !== '$') { return false; }
    var backslashes = 0;
    for (var j = s.length - 2; j >= 0 && s[j] === '\\'; j--) { backslashes++; }
    return backslashes % 2 === 0;
}

/**
 * Whether a regex body matches only whole values: every top-level alternative starts with
 * `^` and ends with an unescaped `$`, or is one group spanning it whose body is anchored.
 *
 * @inner
 * @private
 * @param {string} body - The pattern between the slashes
 * @returns {boolean} true when the body is anchored at both ends
 *
 * @example
 *   isAnchoredBody('^[0-9]+$');           // true
 *   isAnchoredBody('(^draft$|^[0-9]+$)'); // true
 *   isAnchoredBody('^[0-9]+');            // false
 */
function isAnchoredBody(body) {
    var alts = splitTopLevel(body);
    if (alts.length > 1) {
        return alts.every(isAnchoredBody);
    }
    var alt = alts[0];
    if (alt.charAt(0) === '^' && alt.length > 1 && endsWithAnchor(alt)) {
        return true;
    }
    var inner = wholeGroupBody(alt);
    return (inner !== null && inner !== '') ? isAnchoredBody(inner) : false;
}

/**
 * Whether a routing `requirements` value is a regex that is NOT anchored at both ends.
 * A `validator::` value, a non-string or a value not written as `/body/flags` is not a
 * regex requirement and returns false (the config loader refuses any value that is neither
 * `/…` nor `validator::` at boot).
 *
 * @param {*} value - A requirements value as written in routing.json
 * @returns {boolean} true when the value is a regex a partial match can satisfy
 *
 * @example
 *   isUnanchoredRequirement('/[0-9]+/');                  // true
 *   isUnanchoredRequirement('/^[0-9]+$/');                // false
 *   isUnanchoredRequirement('/^[0-9]+$/m');               // true (the m flag)
 *   isUnanchoredRequirement('validator::{ isEmail: true }'); // false
 */
function isUnanchoredRequirement(value) {
    if (typeof(value) !== 'string' || value.charAt(0) !== '/') { return false; }
    var last = value.lastIndexOf('/');
    if (last < 1) { return true; }                       // `/` alone: an empty pattern matches anything
    var body  = value.slice(1, last);
    var flags = value.slice(last + 1);
    if (flags.indexOf('m') > -1) { return true; }
    return !isAnchoredBody(body);
}

/**
 * List a routing table's regex requirements that are not anchored at both ends, in table
 * order. Reads only; the table and its requirement objects are left untouched.
 *
 * @param {object} routing - A bundle's routing table (rule name → rule)
 * @returns {Array<{rule: string, key: string, value: string}>} The unanchored requirements
 *
 * @example
 *   findUnanchoredRequirements({ item: { url: '/item/:id', requirements: { id: '/[0-9]+/' } } });
 *   // [ { rule: 'item', key: 'id', value: '/[0-9]+/' } ]
 */
function findUnanchoredRequirements(routing) {
    var found = [];
    if (!routing || typeof(routing) !== 'object') { return found; }
    var rules = Object.keys(routing);
    for (var r = 0; r < rules.length; r++) {
        var rule = routing[rules[r]];
        if (!rule || typeof(rule) !== 'object' || !rule.requirements || typeof(rule.requirements) !== 'object') { continue; }
        var keys = Object.keys(rule.requirements);
        for (var k = 0; k < keys.length; k++) {
            var value = rule.requirements[keys[k]];
            if (isUnanchoredRequirement(value)) {
                found.push({ rule: rules[r], key: keys[k], value: value });
            }
        }
    }
    return found;
}

/**
 * The single warning line for a bundle's unanchored requirements.
 *
 * @param {string} bundle - The bundle name
 * @param {Array<{rule: string, key: string, value: string}>} list - From findUnanchoredRequirements
 * @returns {string} The warning text
 *
 * @example
 *   formatUnanchoredWarning('api', [ { rule: 'item', key: 'id', value: '/[0-9]+/' } ]);
 *   // '[CONFIG][loadBundleConfig] [ api ] 1 routing requirement is not anchored ...: item { id: /[0-9]+/ } ...'
 */
function formatUnanchoredWarning(bundle, list) {
    var n = list.length;
    var items = list.map(function (u) { return u.rule + ' { ' + u.key + ': ' + u.value + ' }'; }).join(', ');
    return '[CONFIG][loadBundleConfig] [ ' + bundle + ' ] ' + n + ' routing requirement' + (n === 1 ? ' is' : 's are')
        + ' not anchored at both ends (^…$), so ' + (n === 1 ? 'it is' : 'each is') + ' tested as a partial match and a value'
        + ' that only contains a match passes: ' + items + '. Anchor ' + (n === 1 ? 'it' : 'them') + ' (e.g. /^[0-9]+$/),'
        + ' or write an intended partial match in full (e.g. /^pk_.*$/). See https://gina.io/docs/guides/routing#regex-requirements';
}

module.exports = {
    isUnanchoredRequirement    : isUnanchoredRequirement,
    findUnanchoredRequirements : findUnanchoredRequirements,
    formatUnanchoredWarning    : formatUnanchoredWarning
};
