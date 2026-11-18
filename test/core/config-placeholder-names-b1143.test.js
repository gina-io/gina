/**
 * #B1143 — the boot warning for a URL placeholder followed by a character other than a letter, a
 * digit or an underscore.
 *
 * A placeholder's name is its letters, digits and underscores: the router reads the names in a URL
 * segment with `/:\w+/g`, so except on a DELETE route with requirements `/:lang-code/home` is read as
 * the placeholder `:lang`. core/config.param-bindings.js lists each URL segment that holds a placeholder followed by
 * another character; core/config.js warns ONCE per bundle, on the bundles the #B360 warning judges,
 * and never rewrites a value.
 *
 *   01  findTruncatedPlaceholders: each segment with a placeholder followed by any character outside
 *       `[A-Za-z0-9_]` (a hyphen, a dot, a second placeholder, a non-ASCII letter...), with the rule,
 *       the URL, the segment and the names the router reads in it; and nothing else (a name that ends
 *       its segment, static text, a multi-URL rule's spaces, a rule with no string url).
 *   02  formatTruncatedPlaceholderWarning: one line naming the bundle and every segment.
 *   03  config.js wiring: called after setRouting and after the #B1124 bindings, in an
 *       `if ( _requirementsApply )` block of its own; one warning; nothing assigned to the table.
 *   04  premises the warning states (unchanged by #B1143): the router's name pattern `/:\w+/g`, the
 *       culture read's `/^:\w+$/`, and the DELETE branch that keys the whole segment.
 *
 * Seams, for a red-first run against other bytes without touching a tree:
 *   GINA_PARAM_BINDINGS_SRC=<a copy of core/config.param-bindings.js>
 *   GINA_CONFIG_SRC=<a copy of core/config.js>
 * Against the bytes before #B1143 (`git show <base>:framework/v<version>/core/…` into two files),
 * §01, §02 and §03 fail except §03's « required once »; §04 passes on both.
 *
 * Run standalone:
 *   node --test test/core/config-placeholder-names-b1143.test.js
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');
var bindings    = require(process.env.GINA_PARAM_BINDINGS_SRC || path.join(FW, 'core/config.param-bindings.js'));
var CONFIG_SRC  = fs.readFileSync(process.env.GINA_CONFIG_SRC || path.join(FW, 'core/config.js'), 'utf8');
var ROUTING_SRC = fs.readFileSync(path.join(FW, 'lib/routing/src/main.js'), 'utf8');
var I18N_SRC    = fs.readFileSync(path.join(FW, 'lib/i18n/src/main.js'), 'utf8');

/** Removes block comments and whole-line `//` comments (the #B360 test's strip). */
function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/mg, ''); }

/** The routing table of §01: four rules with such a segment, and controls. */
function table() {
    return {
        '$schema'      : 'https://example.com/routing.json',
        'home@site'    : { url: '/:lang-code/home', param: { control: 'home', 'lang-code': ':lang-code' } },
        'plain@site'   : { url: '/item/:id', param: { control: 'item', id: ':id' } },
        'feed@site'    : { url: '/feed/:id.json', param: { control: 'feed', id: ':id' } },
        'range@site'   : { url: '/range/:from-:to', requirements: { from: '/^[0-9]+$/', to: '/^[0-9]+$/' }, param: { control: 'range', from: ':from', to: ':to' } },
        'under@site'   : { url: '/:lang_code/x/:Id2', param: { control: 'x', lang_code: ':lang_code', Id2: ':Id2' } },
        'help@site'    : { url: '/help/:id, /aide/:lang-code', param: { control: 'help', id: ':id' } },
        'inline@site'  : { url: '/articles/page:number', param: { control: 'list', number: ':number' } },
        'static@site'  : { url: '/a-b/c.d/e_f', param: { control: 'page' } },
        'noparam@site' : { url: '/none' },
        'nourl@site'   : { param: { control: 'x' } },
        'arrurl@site'  : { url: ['/x/:a-b'] },
        'null@site'    : null
    };
}

/** The segments findTruncatedPlaceholders lists for `{ 'r@b': { url: url } }`. */
function segmentsOf(url) {
    return bindings.findTruncatedPlaceholders({ 'r@b': { url: url } }).map(function (p) { return p.segment; });
}

describe('#B1143 — a URL placeholder followed by a character other than a letter, a digit or an underscore', function () {

    describe('01 - findTruncatedPlaceholders', function () {
        it('lists each such segment in table order, with its rule, URL, segment and the names the router reads', function () {
            assert.deepEqual(bindings.findTruncatedPlaceholders(table()), [
                { rule: 'home@site', url: '/:lang-code/home', segment: ':lang-code', names: [':lang'] },
                { rule: 'feed@site', url: '/feed/:id.json', segment: ':id.json', names: [':id'] },
                { rule: 'range@site', url: '/range/:from-:to', segment: ':from-:to', names: [':from', ':to'] },
                { rule: 'help@site', url: '/aide/:lang-code', segment: ':lang-code', names: [':lang'] }
            ]);
        });
        it('any character outside [A-Za-z0-9_] right after a name counts, a second placeholder and a non-ASCII letter included', function () {
            ['-', '.', '~', '+', '@', ':', '!', '$', '%', '*', '(', '\'', '"', ' ', 'é', 'ß'].forEach(function (ch) {
                assert.deepEqual(segmentsOf('/x/:a' + ch + 'b'), [':a' + ch + 'b'], JSON.stringify(ch));
            });
            assert.deepEqual(bindings.findTruncatedPlaceholders({ 'r@b': { url: '/x/:café' } })[0].names, [':caf']);
            assert.deepEqual(bindings.findTruncatedPlaceholders({ 'r@b': { url: '/x/:a:b' } })[0].names, [':a', ':b']);
            assert.deepEqual(segmentsOf('/x/page:a-b'), ['page:a-b'], 'a placeholder inside a segment');
        });
        it('every such segment of a URL is listed, and each URL of a multi-URL rule', function () {
            assert.deepEqual(segmentsOf('/:a-b/c/:d.e'), [':a-b', ':d.e']);
            assert.deepEqual(bindings.findTruncatedPlaceholders({ 'r@b': { url: '/one/:a-b,/two/:c.d' } }).map(function (p) { return p.url; }), ['/one/:a-b', '/two/:c.d']);
        });
        it('CONTROL — a name of letters, digits and underscores that ends its segment is not listed', function () {
            ['/:id', '/:lang_code/x', '/:Id2', '/x/:ID_2/y', '/x/:_a', '/x/:9', '/articles/page:number', '/x/:id/', '/:a/:b/:c',
             '/time/12:30'].forEach(function (u) {
                assert.deepEqual(segmentsOf(u), [], u);
            });
        });
        it('CONTROL — static text, an empty URL and the spaces of a multi-URL rule are not listed', function () {
            ['/a-b/c.d/e_f', '/', '', '/help, /aide', '/a/:id , /b/:id', ' /a/:id'].forEach(function (u) {
                assert.deepEqual(segmentsOf(u), [], JSON.stringify(u));
            });
        });
        it('reads only: the table and each rule are left untouched', function () {
            var t = table(), before = JSON.stringify(t);
            Object.keys(t).forEach(function (r) { if (t[r] && typeof(t[r]) === 'object') { Object.freeze(t[r]); } });
            Object.freeze(t);
            bindings.findTruncatedPlaceholders(t);
            assert.equal(JSON.stringify(t), before);
        });
        it('an empty, missing or non-object table lists nothing', function () {
            assert.deepEqual(bindings.findTruncatedPlaceholders({}), []);
            assert.deepEqual(bindings.findTruncatedPlaceholders(undefined), []);
            assert.deepEqual(bindings.findTruncatedPlaceholders(null), []);
            assert.deepEqual(bindings.findTruncatedPlaceholders('routing'), []);
        });
    });

    describe('02 - formatTruncatedPlaceholderWarning', function () {
        it('one segment: singular wording, the bundle, the segment, the grammar, the fix and the guide link, on one line', function () {
            var s = bindings.formatTruncatedPlaceholderWarning('site', [
                { rule: 'home@site', url: '/:lang-code/home', segment: ':lang-code', names: [':lang'] }
            ]);
            assert.ok(s.indexOf('[CONFIG][loadBundleConfig] [ site ] 1 route URL segment holds a placeholder followed by a character other than a letter, a digit or an underscore: home@site ":lang-code".') === 0, s);
            assert.ok(s.indexOf('Except on a DELETE route with requirements, gina reads a placeholder\'s name up to that character: ":lang-code" is read as ":lang".') > -1, s);
            assert.ok(s.indexOf('Name each placeholder with letters, digits and underscores (":lang_code").') > -1, s);
            assert.ok(s.indexOf('https://gina.io/docs/guides/routing#parameterized-url') > -1, s);
            assert.equal(s.indexOf('\n'), -1);
        });
        it('several: plural wording and every segment, each quoted as JSON', function () {
            var s = bindings.formatTruncatedPlaceholderWarning('site', [
                { rule: 'home@site', url: '/:lang-code/home', segment: ':lang-code', names: [':lang'] },
                { rule: 'odd@site', url: '/x/:a"b', segment: ':a"b', names: [':a'] }
            ]);
            assert.ok(s.indexOf('[ site ] 2 route URL segments hold a placeholder followed by a character other than a letter, a digit or an underscore: home@site ":lang-code", odd@site ":a\\"b".') > -1, s);
        });
    });

    describe('03 - core/config.js wiring', function () {
        var CODE = strip(CONFIG_SRC);
        var setRouting = CODE.indexOf('self.setRouting(bundle, env, scope, routing);');
        var b1124 = CODE.indexOf('paramBindings.findConfigKeyBindings(routing)');
        var call = CODE.indexOf('paramBindings.findTruncatedPlaceholders(routing)');
        var open = call > -1 ? CODE.lastIndexOf('if ( _requirementsApply ) {', call) : -1;
        var close = call > -1 ? CODE.indexOf('\n        }\n', call) : -1;
        var block = (open > -1 && close > -1) ? CODE.slice(open, close) : '';

        it('the module is required once', function () {
            assert.equal(CODE.split("require('./config.param-bindings')").length - 1, 1);
        });
        it('listed once, after setRouting and the #B1124 bindings, in an `if ( _requirementsApply )` block of its own', function () {
            assert.ok(setRouting > -1 && b1124 > setRouting, 'setRouting and the #B1124 call are present (instrument control)');
            assert.ok(call > b1124, 'the segments are listed after the #B1124 bindings');
            assert.equal(CODE.split('paramBindings.findTruncatedPlaceholders(').length - 1, 1);
            assert.ok(open > b1124 && open < call, 'its own `if ( _requirementsApply )` block, opened after the #B1124 call');
        });
        it('one warning, built by formatTruncatedPlaceholderWarning', function () {
            assert.equal(block.split('console.warn(').length - 1, 1, block);
            assert.ok(block.indexOf('paramBindings.formatTruncatedPlaceholderWarning(bundle, _truncatedPlaceholders)') > -1, block);
        });
        it('nothing in the block assigns to the routing table', function () {
            assert.ok(block.length > 0, 'the block was found (anti-vacuity)');
            assert.equal(/routing\s*(\[[^\]]*\]|\.[\w$]+)*\s*=[^=]/.test(block), false, block);
        });
    });

    describe('04 - premises the warning states', function () {
        it('the router reads the names in a URL segment with /:\\w+/g (fitsWithRequirements)', function () {
            assert.ok(ROUTING_SRC.indexOf('urlVar.match(/\\:\\w+/g)') > -1);
        });
        it('a culturePrefix route reads its culture binding with /^:\\w+$/ (#B1123)', function () {
            assert.ok(I18N_SRC.indexOf('/^:\\w+$/.test(pfx)') > -1);
        });
        it('the DELETE branch for a route with requirements keys a placeholder by its whole segment', function () {
            assert.ok(ROUTING_SRC.indexOf('let _key = uRo[p].substring(1);') > -1);
        });
    });
});
