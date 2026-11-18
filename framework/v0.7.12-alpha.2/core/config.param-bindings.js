'use strict';
/**
 * Two boot checks of a bundle's routing table, which core/config.js runs once per bundle. Both only
 * READ the table and never rewrite a value.
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
 * a rule's URL segment with `/:\w+/g` (lib/routing `fitsWithRequirements`; a DELETE route with
 * `requirements` is matched by another branch, which reads the whole segment), and a `culturePrefix`
 * route reads its culture binding with `/^:\w+$/` (#B1123). A name written with another character is
 * read up to it, on every route but a DELETE route with `requirements`: `/:lang-code/home` is read as
 * the placeholder `:lang`, so a binding under `lang-code` is never filled and the route matches only
 * when its `param` also binds `lang`. The config loader uses this module to warn once per bundle, listing each URL segment that
 * holds such a placeholder.
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
        + '. Except on a DELETE route with requirements, gina reads a placeholder\'s name up to that character: ":lang-code" is read as ":lang".'
        + ' Name each placeholder with letters, digits and underscores (":lang_code").'
        + ' See https://gina.io/docs/guides/routing#parameterized-url';
}

module.exports = {
    CONFIG_KEYS                       : CONFIG_KEYS,
    EXEMPT_KEYS                       : EXEMPT_KEYS,
    isConfigKeyBinding                : isConfigKeyBinding,
    findConfigKeyBindings             : findConfigKeyBindings,
    formatConfigKeyBindingWarning     : formatConfigKeyBindingWarning,
    findTruncatedPlaceholders         : findTruncatedPlaceholders,
    formatTruncatedPlaceholderWarning : formatTruncatedPlaceholderWarning
};
