'use strict';
/**
 * Four boot checks of a bundle's routing table, which core/config.js runs once per bundle. All four
 * only READ the table and never rewrite a value.
 *
 * #B1124 — route `param` bindings that use a key gina reads as configuration.
 *
 * A route declares a URL binding in its `param` block as `"<key>": ":<key>"`: the key's presence
 * tells the matcher to capture that URL segment into `req.params.<key>`. The `param` object itself
 * (`req.routing.param` at request time) keeps the placeholder text for every key the matcher does
 * not fill. So a binding under a key gina reads AS configuration hands gina the literal text:
 * `"section": ":section"` makes `page.section` `":section"`, `"code": ":code"` makes the redirect
 * status `":code"` (answered `301` since #B1122), `"isPopinContext": ":isPopinContext"` reads as
 * false. The config loader uses this module to warn once per bundle, listing such bindings; it only
 * READS the routing table and never rewrites a value.
 *
 * Warned (CONFIG_KEYS): the 24 keys gina reads from a route's `param` block as configuration. A
 * placeholder under one of them is refused at boot for some (`requireAuth`, `public`, `roles`,
 * `policy`, `dto`, `responseDto`, `messageValidator`, `lane`, `wsHandler`, `wsOptions`), fails per
 * request for others (`control`, `route`, `url`, `urlIndex`, `ext`, `project`, `hostname`, `port`,
 * `method`), and gives a wrong value with no error for the rest (`ignoreWebRoot`, `section`,
 * `isPopinContext`, `keep-params`, `code`). `code`, `route`, `url` and `keep-params` are read only
 * when the route's action redirects, and `url`, `urlIndex`, `project`, `hostname`, `port` and
 * `method` only by `forward()`: the warning does not try to tell, like the routing guide's rule it
 * enforces (bind a URL segment under a name gina does not read as configuration).
 *
 * Exempt (EXEMPT_KEYS): `path`, `namespace`, `title` and `file`, which the matcher fills from the
 * URL; `culture`, read from `req.params` on a `culturePrefix` route (#B1123) and never read
 * otherwise; `error`, `displayInspector` and `isLocalOptionResetNeeded`, which gina writes itself on
 * its injected custom-error route before reading them; `action`, which nothing reads. Any other key
 * is a plain binding gina never reads as configuration.
 *
 * #B1143 — a URL placeholder followed by a character other than a letter, a digit or an underscore.
 *
 * A placeholder's name is its letters, digits and underscores (`\w`): the router reads the names in
 * a rule's URL segment with `/:\w+/g` (lib/routing `fitsWithRequirements`, and the DELETE branch of
 * `parseRouting` since #B1149), the WebSocket matcher reads them the same way (#B1151), and a
 * `culturePrefix` route reads its culture binding with `/^:\w+$/` (#B1123). A name written with
 * another character is read up to it: `/:lang-code/home` is read as the placeholder `:lang`, so a
 * binding under `lang-code` is never filled and the route matches only when its `param` also binds
 * `lang`. The config loader uses this module to warn once per bundle, listing each URL segment that
 * holds such a placeholder.
 *
 * #B646 — text before a placeholder in its URL segment.
 *
 * The router neither compares nor removes text written before a placeholder in the same segment
 * (`/articles/page:number`): the placeholder takes the whole segment (lib/routing
 * `fitsWithRequirements` tests and binds the whole request segment), so the rule also matches
 * `/articles/42`, reads `page3` from `/articles/page3`, and a requirement tests the whole segment. A
 * DELETE route with `requirements` is matched by another branch, which compares such a segment as
 * written. The config loader uses this module to warn once per bundle, listing each URL segment that
 * holds text before a placeholder its rule binds in `param`.
 *
 * #B692 — two or more placeholders in one URL segment.
 *
 * The router never matches such a segment (`/shop/item-:sku-:lang`, `/range/:from-:to`) against a
 * value: a request matches it only by carrying its text as written. The config loader uses this
 * module to warn once per bundle, listing each such segment; the #B1143 and #B646 lists leave it out.
 *
 * Server-side only: the browser bundle never loads this file.
 *
 * @module core/config.param-bindings
 */

/**
 * The `param` keys gina reads as configuration, in the order of the module comment's three groups.
 *
 * @constant
 * @type {ReadonlyArray<string>}
 */
var CONFIG_KEYS = Object.freeze([
    // refused at boot when given a placeholder
    'requireAuth', 'public', 'roles', 'policy', 'dto', 'responseDto', 'messageValidator', 'lane', 'wsHandler', 'wsOptions',
    // accepted at boot, failing per request
    'control', 'route', 'url', 'urlIndex', 'ext', 'project', 'hostname', 'port', 'method',
    // accepted with a wrong value and no error
    'ignoreWebRoot', 'section', 'isPopinContext', 'keep-params', 'code'
]);

/**
 * The other `param` keys gina reads, which a placeholder does not misconfigure: filled from the URL,
 * read from `req.params`, written by gina itself, or never read.
 *
 * @constant
 * @type {ReadonlyArray<string>}
 */
var EXEMPT_KEYS = Object.freeze([
    'path', 'namespace', 'title', 'file',
    'culture',
    'error', 'displayInspector', 'isLocalOptionResetNeeded',
    'action'
]);

/**
 * CONFIG_KEYS as a lookup with no prototype, so `toString` or `__proto__` is never a member.
 *
 * @inner
 * @private
 * @type {Object<string, boolean>}
 */
var CONFIG_KEY_SET = Object.create(null);
CONFIG_KEYS.forEach(function (k) { CONFIG_KEY_SET[k] = true; });

/**
 * A whole URL placeholder: a colon followed by name characters, nothing else.
 *
 * @inner
 * @private
 * @constant
 * @type {RegExp}
 */
var PLACEHOLDER = /^:[A-Za-z0-9_-]+$/;

/**
 * Whether a `param` entry binds a URL placeholder under a key gina reads as configuration.
 *
 * @param {string} key - The `param` key
 * @param {*} value - Its value as declared in routing.json
 * @returns {boolean} True when `key` is one of CONFIG_KEYS and `value` is a whole placeholder string
 *
 * @example
 *   isConfigKeyBinding('section', ':section');   // true
 *   isConfigKeyBinding('code', ':status');       // true (any placeholder name)
 *   isConfigKeyBinding('section', 'billing');    // false (a static value)
 *   isConfigKeyBinding('id', ':id');             // false (gina does not read `param.id`)
 *   isConfigKeyBinding('path', '/item/:id');     // false (filled from the URL)
 */
function isConfigKeyBinding(key, value) {
    return typeof(key) === 'string'
        && CONFIG_KEY_SET[key] === true
        && typeof(value) === 'string'
        && PLACEHOLDER.test(value);
}

/**
 * List a routing table's `param` bindings that use a key gina reads as configuration, in table
 * order. Reads only; the table and its `param` objects are left untouched.
 *
 * @param {object} routing - A bundle's routing table (rule name → rule)
 * @returns {Array<{rule: string, key: string, value: string}>} The bindings found
 *
 * @example
 *   findConfigKeyBindings({ 'item@shop': { url: '/item/:section', param: { control: 'item', section: ':section' } } });
 *   // [ { rule: 'item@shop', key: 'section', value: ':section' } ]
 */
function findConfigKeyBindings(routing) {
    var found = [];
    if (!routing || typeof(routing) !== 'object') { return found; }
    var rules = Object.keys(routing);
    for (var r = 0; r < rules.length; r++) {
        var rule = routing[rules[r]];
        if (!rule || typeof(rule) !== 'object' || !rule.param || typeof(rule.param) !== 'object') { continue; }
        var keys = Object.keys(rule.param);
        for (var k = 0; k < keys.length; k++) {
            if (isConfigKeyBinding(keys[k], rule.param[keys[k]])) {
                found.push({ rule: rules[r], key: keys[k], value: rule.param[keys[k]] });
            }
        }
    }
    return found;
}

/**
 * The single warning line for a bundle's bindings under keys gina reads as configuration.
 *
 * @param {string} bundle - The bundle name
 * @param {Array<{rule: string, key: string, value: string}>} list - From findConfigKeyBindings
 * @returns {string} The warning text
 *
 * @example
 *   formatConfigKeyBindingWarning('shop', [ { rule: 'item@shop', key: 'section', value: ':section' } ]);
 *   // '[CONFIG][loadBundleConfig] [ shop ] 1 route param binding uses a key gina reads as configuration, ...: item@shop { section: ":section" }. ...'
 */
function formatConfigKeyBindingWarning(bundle, list) {
    var n = list.length;
    var items = list.map(function (b) { return b.rule + ' { ' + b.key + ': ' + JSON.stringify(b.value) + ' }'; }).join(', ');
    return '[CONFIG][loadBundleConfig] [ ' + bundle + ' ] ' + n + ' route param binding' + (n === 1 ? ' uses' : 's use')
        + ' a key gina reads as configuration, so gina reads ' + (n === 1 ? 'its' : 'their') + ' placeholder text, not the URL value: '
        + items + '. Bind ' + (n === 1 ? 'the URL segment' : 'each URL segment') + ' under another name (e.g. "url": "/item/:itemCode"'
        + ' with "itemCode": ":itemCode"). See https://gina.io/docs/guides/routing#parameterized-url';
}

/**
 * #B1143 — a placeholder followed, in its URL segment, by a character other than a letter, a digit
 * or an underscore: a `\W` after a `\w` run, in the grammar the router reads names with.
 *
 * @inner
 * @private
 * @constant
 * @type {RegExp}
 */
var TRUNCATED_PLACEHOLDER = /:\w+\W/;

/**
 * #B1143 — the placeholder names the router reads in a URL segment (lib/routing's own pattern).
 *
 * @inner
 * @private
 * @constant
 * @type {RegExp}
 */
var PLACEHOLDER_NAMES = /:\w+/g;

/**
 * #B1143 — list a routing table's URL segments that hold a placeholder followed by a character
 * other than a letter, a digit or an underscore, in table order. Each rule's `url` is split on `,`,
 * each URL trimmed (core/config.js removes a multi-URL rule's whitespace before the router reads
 * it), then split on `/`. Reads only; the table is left untouched.
 *
 * @param {object} routing - A bundle's routing table (rule name → rule)
 * @returns {Array<{rule: string, url: string, segment: string, names: Array<string>}>} One entry per
 *   such segment: the rule, the URL that holds the segment, the segment as written, and the
 *   placeholder names the router reads in it
 *
 * @example
 *   findTruncatedPlaceholders({ 'home@site': { url: '/:lang-code/home', param: { control: 'home', 'lang-code': ':lang-code' } } });
 *   // [ { rule: 'home@site', url: '/:lang-code/home', segment: ':lang-code', names: [ ':lang' ] } ]
 *   findTruncatedPlaceholders({ 'list@site': { url: '/articles/page:number' } });   // [] (the name ends its segment)
 */
function findTruncatedPlaceholders(routing) {
    var found = [];
    if (!routing || typeof(routing) !== 'object') { return found; }
    var rules = Object.keys(routing);
    for (var r = 0; r < rules.length; r++) {
        var rule = routing[rules[r]];
        if (!rule || typeof(rule) !== 'object' || typeof(rule.url) !== 'string') { continue; }
        var urls = rule.url.split(',');
        for (var u = 0; u < urls.length; u++) {
            var url = urls[u].trim();
            var segments = url.split('/');
            for (var s = 0; s < segments.length; s++) {
                // #B692 — a segment with two or more placeholders is listed by
                // findMultiPlaceholderSegments, whose sentence describes it.
                if (isMultiPlaceholderSegment(segments[s])) { continue; }
                if (TRUNCATED_PLACEHOLDER.test(segments[s])) {
                    found.push({ rule: rules[r], url: url, segment: segments[s], names: segments[s].match(PLACEHOLDER_NAMES) });
                }
            }
        }
    }
    return found;
}

/**
 * #B1143 — the single warning line for a bundle's URL segments that hold a placeholder followed by
 * a character other than a letter, a digit or an underscore.
 *
 * @param {string} bundle - The bundle name
 * @param {Array<{rule: string, url: string, segment: string, names: Array<string>}>} list - From findTruncatedPlaceholders
 * @returns {string} The warning text
 *
 * @example
 *   formatTruncatedPlaceholderWarning('site', [ { rule: 'home@site', url: '/:lang-code/home', segment: ':lang-code', names: [ ':lang' ] } ]);
 *   // '[CONFIG][loadBundleConfig] [ site ] 1 route URL segment holds a placeholder followed by a character other than a letter, a digit or an underscore: home@site ":lang-code". ...'
 */
function formatTruncatedPlaceholderWarning(bundle, list) {
    var n = list.length;
    var items = list.map(function (p) { return p.rule + ' ' + JSON.stringify(p.segment); }).join(', ');
    return '[CONFIG][loadBundleConfig] [ ' + bundle + ' ] ' + n + ' route URL segment' + (n === 1 ? ' holds' : 's hold')
        + ' a placeholder followed by a character other than a letter, a digit or an underscore: ' + items
        // #B1149 — the DELETE branch reads names like every other route; was:
        // + '. Except on a DELETE route with requirements, gina reads a placeholder\'s name up to that character: ":lang-code" is read as ":lang".'
        + '. gina reads a placeholder\'s name up to that character: ":lang-code" is read as ":lang".'
        + ' Name each placeholder with letters, digits and underscores (":lang_code").'
        + ' See https://gina.io/docs/guides/routing#parameterized-url';
}

/**
 * #B646 — text before the first placeholder of a URL segment (`page:number`, `item-:sku`): one or
 * more characters other than `:`, then a `:` that a name character follows.
 *
 * @inner
 * @private
 * @constant
 * @type {RegExp}
 */
var PREFIXED_PLACEHOLDER = /^[^:]+:\w/;

/**
 * #B646 — list a routing table's URL segments that hold text before a placeholder the rule binds in
 * its own `param`, in table order. The router neither compares nor removes that text: the
 * placeholder takes the whole segment (lib/routing `fitsWithRequirements` tests and binds the whole
 * request segment), except on a DELETE route with `requirements`, whose branch compares the segment
 * as written. Not listed: a segment whose names the rule does not bind, which the router matches
 * only as written (`/time/12:30`), and a `ws` route (`/^ws$/i` on its method, as core/server.js
 * reads it), whose matcher compares such a segment as written. Each rule's `url` is split on `,`,
 * each URL trimmed, then split on `/`, as findTruncatedPlaceholders does. Reads only; the table is
 * left untouched.
 *
 * @param {object} routing - A bundle's routing table (rule name → rule)
 * @returns {Array<{rule: string, url: string, segment: string, names: Array<string>}>} One entry per
 *   such segment: the rule, the URL that holds the segment, the segment as written, and the
 *   placeholder names the router reads in it
 *
 * @example
 *   findPrefixedPlaceholders({ 'list@site': { url: '/articles/page:number', param: { control: 'list', number: ':number' } } });
 *   // [ { rule: 'list@site', url: '/articles/page:number', segment: 'page:number', names: [ ':number' ] } ]
 *   findPrefixedPlaceholders({ 'time@site': { url: '/time/12:30', param: { control: 'time' } } });   // [] (nothing bound)
 */
function findPrefixedPlaceholders(routing) {
    var found = [];
    if (!routing || typeof(routing) !== 'object') { return found; }
    var rules = Object.keys(routing);
    for (var r = 0; r < rules.length; r++) {
        var rule = routing[rules[r]];
        if (!rule || typeof(rule) !== 'object' || typeof(rule.url) !== 'string') { continue; }
        if (!rule.param || typeof(rule.param) !== 'object') { continue; }
        if (/^ws$/i.test(rule.method || '')) { continue; }
        var urls = rule.url.split(',');
        for (var u = 0; u < urls.length; u++) {
            var url = urls[u].trim();
            var segments = url.split('/');
            for (var s = 0; s < segments.length; s++) {
                if (!PREFIXED_PLACEHOLDER.test(segments[s])) { continue; }
                // #B692 — listed by findMultiPlaceholderSegments instead.
                if (isMultiPlaceholderSegment(segments[s])) { continue; }
                var names = segments[s].match(PLACEHOLDER_NAMES);
                var bound = false;
                for (var n = 0; n < names.length && !bound; n++) {
                    bound = Object.prototype.hasOwnProperty.call(rule.param, names[n].substring(1));
                }
                if (bound) {
                    found.push({ rule: rules[r], url: url, segment: segments[s], names: names });
                }
            }
        }
    }
    return found;
}

/**
 * #B646 — the single warning line for a bundle's URL segments that hold text before a placeholder
 * their rule binds.
 *
 * @param {string} bundle - The bundle name
 * @param {Array<{rule: string, url: string, segment: string, names: Array<string>}>} list - From findPrefixedPlaceholders
 * @returns {string} The warning text
 *
 * @example
 *   formatPrefixedPlaceholderWarning('site', [ { rule: 'list@site', url: '/articles/page:number', segment: 'page:number', names: [ ':number' ] } ]);
 *   // '[CONFIG][loadBundleConfig] [ site ] 1 route URL segment holds text before a placeholder its route binds: list@site "page:number". ...'
 */
function formatPrefixedPlaceholderWarning(bundle, list) {
    var n = list.length;
    var items = list.map(function (p) { return p.rule + ' ' + JSON.stringify(p.segment); }).join(', ');
    return '[CONFIG][loadBundleConfig] [ ' + bundle + ' ] ' + n + ' route URL segment' + (n === 1 ? ' holds' : 's hold')
        + ' text before a placeholder ' + (n === 1 ? 'its route binds' : 'their routes bind') + ': ' + items
        + '. gina neither compares nor removes that text, except on a DELETE route with requirements, which compares the segment as written:'
        + ' the placeholder takes the whole segment, so "/articles/page:number" also matches "/articles/42", reads "page3" from "/articles/page3",'
        + ' and a requirement tests the whole segment. Put the fixed text in a segment of its own ("/articles/page/:number").'
        + ' See https://gina.io/docs/guides/routing#inline-parameters';
}

/**
 * #B692 — whether a URL segment holds two or more placeholders, in the grammar the router reads
 * names with (`/:\w+/g`).
 *
 * @inner
 * @private
 * @param {string} segment - A URL segment
 * @returns {boolean}
 *
 * @example
 *   isMultiPlaceholderSegment(':from-:to');   // true
 *   isMultiPlaceholderSegment('page:number'); // false
 */
function isMultiPlaceholderSegment(segment) {
    var names = String(segment).match(PLACEHOLDER_NAMES);
    return !!names && names.length > 1;
}

/**
 * #B692 — list a routing table's URL segments that hold two or more placeholders, in table order,
 * whatever the rule's method. The router never matches such a segment against a value (lib/routing
 * `fitsWithRequirements` and the DELETE branch of `parseRouting`, and the WebSocket matcher in
 * core/server.isaac.js): a request matches it only by carrying its text as written. Each rule's
 * `url` is split on `,`, each URL trimmed, then split on `/`, as findTruncatedPlaceholders does.
 * Reads only; the table is left untouched.
 *
 * @param {object} routing - A bundle's routing table (rule name → rule)
 * @returns {Array<{rule: string, url: string, segment: string, names: Array<string>}>} One entry per
 *   such segment: the rule, the URL that holds the segment, the segment as written, and the
 *   placeholder names the router reads in it
 *
 * @example
 *   findMultiPlaceholderSegments({ 'range@site': { url: '/range/:from-:to', param: { control: 'range' } } });
 *   // [ { rule: 'range@site', url: '/range/:from-:to', segment: ':from-:to', names: [ ':from', ':to' ] } ]
 *   findMultiPlaceholderSegments({ 'item@site': { url: '/item/:id' } });   // []
 */
function findMultiPlaceholderSegments(routing) {
    var found = [];
    if (!routing || typeof(routing) !== 'object') { return found; }
    var rules = Object.keys(routing);
    for (var r = 0; r < rules.length; r++) {
        var rule = routing[rules[r]];
        if (!rule || typeof(rule) !== 'object' || typeof(rule.url) !== 'string') { continue; }
        var urls = rule.url.split(',');
        for (var u = 0; u < urls.length; u++) {
            var url = urls[u].trim();
            var segments = url.split('/');
            for (var s = 0; s < segments.length; s++) {
                if (isMultiPlaceholderSegment(segments[s])) {
                    found.push({ rule: rules[r], url: url, segment: segments[s], names: segments[s].match(PLACEHOLDER_NAMES) });
                }
            }
        }
    }
    return found;
}

/**
 * #B692 — the single warning line for a bundle's URL segments that hold two or more placeholders.
 *
 * @param {string} bundle - The bundle name
 * @param {Array<{rule: string, url: string, segment: string, names: Array<string>}>} list - From findMultiPlaceholderSegments
 * @returns {string} The warning text
 *
 * @example
 *   formatMultiPlaceholderWarning('site', [ { rule: 'range@site', url: '/range/:from-:to', segment: ':from-:to', names: [ ':from', ':to' ] } ]);
 *   // '[CONFIG][loadBundleConfig] [ site ] 1 route URL segment holds two or more placeholders: range@site ":from-:to". ...'
 */
function formatMultiPlaceholderWarning(bundle, list) {
    var n = list.length;
    var items = list.map(function (p) { return p.rule + ' ' + JSON.stringify(p.segment); }).join(', ');
    return '[CONFIG][loadBundleConfig] [ ' + bundle + ' ] ' + n + ' route URL segment' + (n === 1 ? ' holds' : 's hold')
        + ' two or more placeholders: ' + items
        + '. gina never matches such a segment against a value: a request matches it only by carrying its text as written.'
        + ' Give each placeholder a segment of its own ("/range/:from/:to").'
        + ' See https://gina.io/docs/guides/routing#parameterized-url';
}

module.exports = {
    CONFIG_KEYS                       : CONFIG_KEYS,
    EXEMPT_KEYS                       : EXEMPT_KEYS,
    isConfigKeyBinding                : isConfigKeyBinding,
    findConfigKeyBindings             : findConfigKeyBindings,
    formatConfigKeyBindingWarning     : formatConfigKeyBindingWarning,
    findTruncatedPlaceholders         : findTruncatedPlaceholders,
    formatTruncatedPlaceholderWarning : formatTruncatedPlaceholderWarning,
    findPrefixedPlaceholders          : findPrefixedPlaceholders,
    formatPrefixedPlaceholderWarning  : formatPrefixedPlaceholderWarning,
    findMultiPlaceholderSegments      : findMultiPlaceholderSegments,
    formatMultiPlaceholderWarning     : formatMultiPlaceholderWarning
};
