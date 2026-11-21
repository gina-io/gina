/**
 * #B646 — the boot warning for text before a URL placeholder in its segment.
 *
 * The router neither compares nor removes text written before a placeholder in the same URL segment
 * (`/articles/page:number`): the placeholder takes the whole segment, except on a DELETE route with
 * requirements, whose branch compares the segment as written. core/config.param-bindings.js lists
 * each URL segment that holds text before a placeholder its rule binds in `param`; core/config.js
 * warns ONCE per bundle, on the bundles the #B360 warning judges, and never rewrites a value.
 *
 *   01  findPrefixedPlaceholders: each segment holding text before a placeholder its rule binds, with
 *       the rule, the URL, the segment and the names the router reads in it; and nothing else (a
 *       segment that starts with its placeholder, a name the rule does not bind, a `ws` route, static
 *       text, a rule with no string url or no param).
 *   02  formatPrefixedPlaceholderWarning: one line naming the bundle and every segment.
 *   03  config.js wiring: called after the #B1143 check, in an `if ( _requirementsApply )` block of
 *       its own; one warning; nothing assigned to the table.
 *   04  premises the warning states (unchanged by #B646): a `:` anywhere makes a segment a parameter
 *       segment, the matcher binds the whole request segment, the DELETE branch scores only a segment
 *       that starts with `:`, Isaac's WebSocket matcher compares any other segment as written, and
 *       core/server.js reads a route as a WebSocket route by `/^ws$/i` on its method.
 *
 * Seams, for a red-first run against other bytes without touching a tree:
 *   GINA_PARAM_BINDINGS_SRC=<a copy of core/config.param-bindings.js>
 *   GINA_CONFIG_SRC=<a copy of core/config.js>
 * Against the bytes before #B646 (`git show <base>:framework/v<version>/core/…` into two files),
 * §01, §02 and §03 fail except §03's « required once »; §04 passes on both.
 *
 * Run standalone:
 *   node --test test/core/config-placeholder-prefix-b646.test.js
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');
var bindings    = require(process.env.GINA_PARAM_BINDINGS_SRC || path.join(FW, 'core/config.param-bindings.js'));
var commentStrip = require('../strip-comments');
var CONFIG_SRC  = fs.readFileSync(process.env.GINA_CONFIG_SRC || path.join(FW, 'core/config.js'), 'utf8');
var ROUTING_SRC = fs.readFileSync(path.join(FW, 'lib/routing/src/main.js'), 'utf8');
var ISAAC_SRC   = fs.readFileSync(path.join(FW, 'core/server.isaac.js'), 'utf8');
var SERVER_SRC  = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');

/** Removes block comments and whole-line `//` comments (the #B360 test's strip). */
function strip(s) { return commentStrip.lines(s); }

/** The routing table of §01: five rules with such a segment, and controls. */
function table() {
    return {
        '$schema'       : 'https://example.com/routing.json',
        'list@site'     : { url: '/articles/page:number', param: { control: 'list', number: ':number' } },
        'plain@site'    : { url: '/item/:id', param: { control: 'item', id: ':id' } },
        'sku@site'      : { url: '/shop/item-:sku/:lang', param: { control: 'sku', sku: ':sku', lang: ':lang' } },
        'time@site'     : { url: '/time/12:30', param: { control: 'time' } },
        'other@site'    : { url: '/r/v:id', requirements: { id: '/^[0-9]+$/' }, param: { control: 'r', ident: ':id' } },
        'del@site'      : { method: 'DELETE', url: '/articles/page:number', requirements: { number: '/^[0-9]+$/' }, param: { control: 'rm', number: ':number' } },
        'socket@site'   : { method: 'ws', url: '/live/room:id', param: { control: 'live', id: ':id' } },
        'multi@site'    : { url: '/a/:id, /b/v:id', param: { control: 'm', id: ':id' } },
        'both@site'     : { url: '/feed/item:id.json', param: { control: 'feed', id: ':id' } },
        'static@site'   : { url: '/a-b/c.d/e_f', param: { control: 'page' } },
        'noparam@site'  : { url: '/x/page:n' },
        'nourl@site'    : { param: { control: 'x' } },
        'arrurl@site'   : { url: ['/x/v:id'], param: { control: 'x', id: ':id' } },
        'null@site'     : null
    };
}

/** The segments findPrefixedPlaceholders lists for `{ 'r@b': { url: url, param: param } }`. */
function segmentsOf(url, param, method) {
    var rule = { url: url, param: param || {} };
    if (method) { rule.method = method; }
    return bindings.findPrefixedPlaceholders({ 'r@b': rule }).map(function (p) { return p.segment; });
}

describe('#B646 — text before a URL placeholder in its segment', function () {

    describe('01 - findPrefixedPlaceholders', function () {
        it('lists each such segment in table order, with its rule, URL, segment and the names the router reads', function () {
            assert.deepEqual(bindings.findPrefixedPlaceholders(table()), [
                { rule: 'list@site', url: '/articles/page:number', segment: 'page:number', names: [':number'] },
                { rule: 'sku@site', url: '/shop/item-:sku/:lang', segment: 'item-:sku', names: [':sku'] },
                { rule: 'del@site', url: '/articles/page:number', segment: 'page:number', names: [':number'] },
                { rule: 'multi@site', url: '/b/v:id', segment: 'v:id', names: [':id'] },
                { rule: 'both@site', url: '/feed/item:id.json', segment: 'item:id.json', names: [':id'] }
            ]);
        });
        it('any text before the first placeholder counts, and every method but ws', function () {
            ['a', 'page', 'item-', 'v.', '12', 'x~', 'é'].forEach(function (pre) {
                assert.deepEqual(segmentsOf('/x/' + pre + ':id', { id: ':id' }), [pre + ':id'], JSON.stringify(pre));
            });
            ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'GET, POST'].forEach(function (m) {
                assert.deepEqual(segmentsOf('/x/page:n', { n: ':n' }, m), ['page:n'], m);
            });
        });
        it('every such segment of a URL is listed, and each URL of a multi-URL rule', function () {
            assert.deepEqual(segmentsOf('/p:a/c/q:b', { a: ':a', b: ':b' }), ['p:a', 'q:b']);
            assert.deepEqual(bindings.findPrefixedPlaceholders({ 'r@b': { url: '/one/p:a,/two/q:a', param: { a: ':a' } } }).map(function (p) { return p.url; }), ['/one/p:a', '/two/q:a']);
        });
        it('CONTROL — a segment that starts with its placeholder, or holds no name, is not listed', function () {
            ['/:id', '/x/:id/y', '/:lang-code/home', '/x/:a:b', '/x/12:', '/x/a:', '/x/a:-b', '/', ''].forEach(function (u) {
                assert.deepEqual(segmentsOf(u, { id: ':id', lang: ':lang', 'lang-code': ':lang-code', a: ':a', b: ':b' }), [], JSON.stringify(u));
            });
        });
        it('CONTROL — a name the rule does not bind under its own key is not listed', function () {
            assert.deepEqual(segmentsOf('/time/12:30', { control: 'time' }), [], 'nothing bound');
            assert.deepEqual(segmentsOf('/r/v:id', { ident: ':id' }), [], 'bound under another key');
            assert.deepEqual(segmentsOf('/r/v:id', Object.create({ id: ':id' })), [], 'an inherited key is not a binding');
        });
        it('CONTROL — a ws route is not listed, whatever the case of its method', function () {
            ['ws', 'WS', 'Ws'].forEach(function (m) {
                assert.deepEqual(segmentsOf('/live/room:id', { id: ':id' }, m), [], m);
            });
        });
        it('CONTROL — static text, a rule with no param and a rule with no string url are not listed', function () {
            assert.deepEqual(segmentsOf('/a-b/c.d/e_f', { control: 'page' }), []);
            assert.deepEqual(bindings.findPrefixedPlaceholders({ 'r@b': { url: '/x/page:n' } }), []);
            assert.deepEqual(bindings.findPrefixedPlaceholders({ 'r@b': { url: '/x/page:n', param: null } }), []);
            assert.deepEqual(bindings.findPrefixedPlaceholders({ 'r@b': { url: ['/x/page:n'], param: { n: ':n' } } }), []);
        });
        it('reads only: the table and each rule are left untouched', function () {
            var t = table(), before = JSON.stringify(t);
            Object.keys(t).forEach(function (r) {
                if (t[r] && typeof(t[r]) === 'object') {
                    if (t[r].param) { Object.freeze(t[r].param); }
                    Object.freeze(t[r]);
                }
            });
            Object.freeze(t);
            bindings.findPrefixedPlaceholders(t);
            assert.equal(JSON.stringify(t), before);
        });
        it('an empty, missing or non-object table lists nothing', function () {
            assert.deepEqual(bindings.findPrefixedPlaceholders({}), []);
            assert.deepEqual(bindings.findPrefixedPlaceholders(undefined), []);
            assert.deepEqual(bindings.findPrefixedPlaceholders(null), []);
            assert.deepEqual(bindings.findPrefixedPlaceholders('routing'), []);
        });
    });

    describe('02 - formatPrefixedPlaceholderWarning', function () {
        it('one segment: singular wording, the bundle, the segment, the behaviour, the fix and the guide link, on one line', function () {
            var s = bindings.formatPrefixedPlaceholderWarning('site', [
                { rule: 'list@site', url: '/articles/page:number', segment: 'page:number', names: [':number'] }
            ]);
            assert.ok(s.indexOf('[CONFIG][loadBundleConfig] [ site ] 1 route URL segment holds text before a placeholder its route binds: list@site "page:number".') === 0, s);
            assert.ok(s.indexOf('gina neither compares nor removes that text, except on a DELETE route with requirements, which compares the segment as written:') > -1, s);
            assert.ok(s.indexOf('the placeholder takes the whole segment, so "/articles/page:number" also matches "/articles/42", reads "page3" from "/articles/page3", and a requirement tests the whole segment.') > -1, s);
            assert.ok(s.indexOf('Put the fixed text in a segment of its own ("/articles/page/:number").') > -1, s);
            assert.ok(s.indexOf('https://gina.io/docs/guides/routing#inline-parameters') > -1, s);
            assert.equal(s.indexOf('\n'), -1);
        });
        it('several: plural wording and every segment, each quoted as JSON', function () {
            var s = bindings.formatPrefixedPlaceholderWarning('site', [
                { rule: 'list@site', url: '/articles/page:number', segment: 'page:number', names: [':number'] },
                { rule: 'odd@site', url: '/x/a"b:c', segment: 'a"b:c', names: [':c'] }
            ]);
            assert.ok(s.indexOf('[ site ] 2 route URL segments hold text before a placeholder their routes bind: list@site "page:number", odd@site "a\\"b:c".') > -1, s);
        });
    });

    describe('03 - core/config.js wiring', function () {
        var CODE = strip(CONFIG_SRC);
        var b1143 = CODE.indexOf('paramBindings.findTruncatedPlaceholders(routing)');
        var call = CODE.indexOf('paramBindings.findPrefixedPlaceholders(routing)');
        var open = call > -1 ? CODE.lastIndexOf('if ( _requirementsApply ) {', call) : -1;
        var close = call > -1 ? CODE.indexOf('\n        }\n', call) : -1;
        var block = (open > -1 && close > -1) ? CODE.slice(open, close) : '';

        it('the module is required once', function () {
            assert.equal(CODE.split("require('./config.param-bindings')").length - 1, 1);
        });
        it('listed once, after the #B1143 check, in an `if ( _requirementsApply )` block of its own', function () {
            assert.ok(b1143 > -1, 'the #B1143 call is present (instrument control)');
            assert.ok(call > b1143, 'the segments are listed after the #B1143 check');
            assert.equal(CODE.split('paramBindings.findPrefixedPlaceholders(').length - 1, 1);
            assert.ok(open > b1143 && open < call, 'its own `if ( _requirementsApply )` block, opened after the #B1143 call');
        });
        it('one warning, built by formatPrefixedPlaceholderWarning', function () {
            assert.equal(block.split('console.warn(').length - 1, 1, block);
            assert.ok(block.indexOf('paramBindings.formatPrefixedPlaceholderWarning(bundle, _prefixedPlaceholders)') > -1, block);
        });
        it('nothing in the block assigns to the routing table', function () {
            assert.ok(block.length > 0, 'the block was found (anti-vacuity)');
            assert.equal(/routing\s*(\[[^\]]*\]|\.[\w$]+)*\s*=[^=]/.test(block), false, block);
        });
    });

    describe('04 - premises the warning states', function () {
        it('a `:` anywhere in a segment makes it a parameter segment (hasParams)', function () {
            assert.ok(ROUTING_SRC.indexOf('return (/\\:/.test(pathname)) ? true : false;') > -1);
        });
        it('the matcher binds the whole request segment (fitsWithRequirements)', function () {
            assert.ok(ROUTING_SRC.indexOf('request.params[key] = urlVal;') > -1);
        });
        it('the DELETE branch for a route with requirements scores only a segment that starts with `:`', function () {
            assert.ok(ROUTING_SRC.indexOf('if ( /^:/.test(uRo[p]) && uRe[p] ) {') > -1);
        });
        it('Isaac\'s WebSocket matcher captures a segment that starts with `:` and compares any other as written', function () {
            assert.ok(ISAAC_SRC.indexOf("if (pat.charAt(0) === ':') {") > -1);
            assert.ok(ISAAC_SRC.indexOf('} else if (pat !== reqSegs[s]) {') > -1);
        });
        it('core/server.js reads a route as a WebSocket route by /^ws$/i on its method', function () {
            assert.ok(SERVER_SRC.indexOf("!/^ws$/i.test(_wsRoute.method || '')") > -1);
        });
    });
});
