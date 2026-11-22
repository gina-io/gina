/**
 * #B692 — the boot warning for a URL segment that holds two or more placeholders.
 *
 * The router never matches such a segment (`/range/:from-:to`, `/shop/item-:sku-:lang`) against a
 * value: a request matches it only by carrying its text as written (lib/routing, and the WebSocket
 * matcher). core/config.param-bindings.js lists each such segment, whatever its rule's method and
 * whether or not the rule binds its names; core/config.js warns ONCE per bundle, on the bundles the
 * #B360 warning judges, and never rewrites a value. The #B1143 and #B646 lists leave such a segment
 * out, so it is described by one sentence only.
 *
 *   01  findMultiPlaceholderSegments: each such segment, with the rule, the URL, the segment and the
 *       names the router reads in it; and nothing else.
 *   02  formatMultiPlaceholderWarning: one line naming the bundle and every segment.
 *   03  the #B1143 and #B646 lists leave such a segment out (the cases those two files listed before).
 *   04  config.js wiring: called after the #B646 check, in an `if ( _requirementsApply )` block of
 *       its own; one warning; nothing assigned to the table.
 *
 * Seams, for a red-first run against other bytes without touching a tree:
 *   GINA_PARAM_BINDINGS_SRC=<a copy of core/config.param-bindings.js>
 *   GINA_CONFIG_SRC=<a copy of core/config.js>
 * Against the bytes before #B692's warning, every suite fails except §03's CONTROL: §01's CONTROL
 * calls `find()`, which asserts the export those bytes lack.
 *
 * Run standalone:
 *   node --test test/core/config-placeholder-multi-b692.test.js
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');
var bindings   = require(process.env.GINA_PARAM_BINDINGS_SRC || path.join(FW, 'core/config.param-bindings.js'));
var commentStrip = require('../strip-comments');
var CONFIG_SRC = fs.readFileSync(process.env.GINA_CONFIG_SRC || path.join(FW, 'core/config.js'), 'utf8');

/** Removes block comments and whole-line `//` comments (the #B360 test's strip). */
function strip(s) { return commentStrip.lines(s); }

/** Calls findMultiPlaceholderSegments, which the bytes before #B692's warning do not export. */
function find(routing) {
    assert.equal(typeof bindings.findMultiPlaceholderSegments, 'function', 'findMultiPlaceholderSegments must be exported');
    return bindings.findMultiPlaceholderSegments(routing);
}

/** The routing table of §01: six rules with such a segment, and controls. */
function table() {
    return {
        '$schema'      : 'https://example.com/routing.json',
        'range@site'   : { url: '/range/:from-:to', requirements: { from: '/^[0-9]+$/', to: '/^[0-9]+$/' }, param: { control: 'range', from: ':from', to: ':to' } },
        'plain@site'   : { url: '/item/:id', param: { control: 'item', id: ':id' } },
        'sku@site'     : { url: '/shop/item-:sku-:lang', param: { control: 'sku', sku: ':sku', lang: ':lang' } },
        'home@site'    : { url: '/:lang-code/home', param: { control: 'home', lang: ':lang' } },
        'colon@site'   : { url: '/x/:a:b', param: { control: 'x' } },
        'list@site'    : { url: '/articles/page:number', param: { control: 'list', number: ':number' } },
        'prefix@site'  : { url: '/x/a:b:c', param: { control: 'x', c: ':c' } },
        'time@site'    : { url: '/time/12:30', param: { control: 'time' } },
        'socket@site'  : { method: 'ws', url: '/live/:a-:b', param: { wsHandler: 'live' } },
        'del@site'     : { method: 'DELETE', url: '/d/:x.:y', requirements: { x: '/^[0-9]+$/' }, param: { control: 'rm', x: ':x', y: ':y' } },
        'multi@site'   : { url: '/a/:id, /b/:p-:q', param: { control: 'm', id: ':id' } },
        'static@site'  : { url: '/a-b/c.d/e_f', param: { control: 'page' } },
        'nourl@site'   : { param: { control: 'x' } },
        'arrurl@site'  : { url: ['/x/:a-:b'] },
        'null@site'    : null
    };
}

describe('#B692 — a URL segment that holds two or more placeholders', function () {

    describe('01 - findMultiPlaceholderSegments', function () {
        it('lists each such segment in table order, with its rule, URL, segment and the names the router reads', function () {
            assert.deepEqual(find(table()), [
                { rule: 'range@site', url: '/range/:from-:to', segment: ':from-:to', names: [':from', ':to'] },
                { rule: 'sku@site', url: '/shop/item-:sku-:lang', segment: 'item-:sku-:lang', names: [':sku', ':lang'] },
                { rule: 'colon@site', url: '/x/:a:b', segment: ':a:b', names: [':a', ':b'] },
                { rule: 'prefix@site', url: '/x/a:b:c', segment: 'a:b:c', names: [':b', ':c'] },
                { rule: 'socket@site', url: '/live/:a-:b', segment: ':a-:b', names: [':a', ':b'] },
                { rule: 'del@site', url: '/d/:x.:y', segment: ':x.:y', names: [':x', ':y'] },
                { rule: 'multi@site', url: '/b/:p-:q', segment: ':p-:q', names: [':p', ':q'] }
            ]);
        });
        it('CONTROL — a segment with one placeholder or none is not listed', function () {
            ['/item/:id', '/:lang-code/home', '/articles/page:number', '/time/12:30', '/x/:a/:b', '/a-b/c.d/e_f', '/', ''].forEach(function (u) {
                assert.deepEqual(find({ 'r@b': { url: u, param: { a: ':a' } } }), [], JSON.stringify(u));
            });
        });
        it('every method is judged, `ws` included, whether or not the rule binds the names', function () {
            ['GET', 'POST', 'DELETE', 'ws', 'GET, POST'].forEach(function (m) {
                assert.deepEqual(find({ 'r@b': { method: m, url: '/x/:a-:b' } }).map(function (p) { return p.segment; }), [':a-:b'], m);
            });
        });
        it('reads only: the table and each rule are left untouched', function () {
            var t = table(), before = JSON.stringify(t);
            Object.keys(t).forEach(function (r) { if (t[r] && typeof(t[r]) === 'object') { Object.freeze(t[r]); } });
            Object.freeze(t);
            find(t);
            assert.equal(JSON.stringify(t), before);
        });
        it('an empty, missing or non-object table lists nothing', function () {
            assert.deepEqual(find({}), []);
            assert.deepEqual(find(undefined), []);
            assert.deepEqual(find(null), []);
            assert.deepEqual(find('routing'), []);
        });
    });

    describe('02 - formatMultiPlaceholderWarning', function () {
        it('one segment: singular wording, the bundle, the segment, the behaviour, the fix and the guide link, on one line', function () {
            assert.equal(typeof bindings.formatMultiPlaceholderWarning, 'function', 'formatMultiPlaceholderWarning must be exported');
            var s = bindings.formatMultiPlaceholderWarning('site', [
                { rule: 'range@site', url: '/range/:from-:to', segment: ':from-:to', names: [':from', ':to'] }
            ]);
            assert.ok(s.indexOf('[CONFIG][loadBundleConfig] [ site ] 1 route URL segment holds two or more placeholders: range@site ":from-:to".') === 0, s);
            assert.ok(s.indexOf('. gina never matches such a segment against a value: a request matches it only by carrying its text as written.') > -1, s);
            assert.ok(s.indexOf('Give each placeholder a segment of its own ("/range/:from/:to").') > -1, s);
            assert.ok(s.indexOf('https://gina.io/docs/guides/routing#parameterized-url') > -1, s);
            assert.equal(s.indexOf('\n'), -1);
        });
        it('several: plural wording and every segment, each quoted as JSON', function () {
            assert.equal(typeof bindings.formatMultiPlaceholderWarning, 'function', 'formatMultiPlaceholderWarning must be exported');
            var s = bindings.formatMultiPlaceholderWarning('site', [
                { rule: 'range@site', url: '/range/:from-:to', segment: ':from-:to', names: [':from', ':to'] },
                { rule: 'odd@site', url: '/x/:a"-:b', segment: ':a"-:b', names: [':a', ':b'] }
            ]);
            assert.ok(s.indexOf('[ site ] 2 route URL segments hold two or more placeholders: range@site ":from-:to", odd@site ":a\\"-:b".') > -1, s);
        });
    });

    describe('03 - the #B1143 and #B646 lists leave such a segment out', function () {
        it('the #B1143 list: `:a:b` and `:from-:to` are not listed', function () {
            assert.deepEqual(bindings.findTruncatedPlaceholders({ 'r@b': { url: '/x/:a:b' } }), []);
            assert.deepEqual(bindings.findTruncatedPlaceholders({ 'r@b': { url: '/range/:from-:to' } }), []);
        });
        it('the #B646 list: `a:b:c` is not listed, though its rule binds `c`', function () {
            assert.deepEqual(bindings.findPrefixedPlaceholders({ 'r@b': { url: '/x/a:b:c', param: { c: ':c' } } }), []);
        });
        it('CONTROL — both lists still list a segment with one placeholder', function () {
            assert.deepEqual(bindings.findTruncatedPlaceholders({ 'r@b': { url: '/x/:a-b' } }).map(function (p) { return p.segment; }), [':a-b']);
            assert.deepEqual(bindings.findPrefixedPlaceholders({ 'r@b': { url: '/x/a:c', param: { c: ':c' } } }).map(function (p) { return p.segment; }), ['a:c']);
        });
    });

    describe('04 - core/config.js wiring', function () {
        var CODE = strip(CONFIG_SRC);
        var b646 = CODE.indexOf('paramBindings.findPrefixedPlaceholders(routing)');
        var call = CODE.indexOf('paramBindings.findMultiPlaceholderSegments(routing)');
        var open = call > -1 ? CODE.lastIndexOf('if ( _requirementsApply ) {', call) : -1;
        var close = call > -1 ? CODE.indexOf('\n        }\n', call) : -1;
        var block = (open > -1 && close > -1) ? CODE.slice(open, close) : '';

        it('listed once, after the #B646 check, in an `if ( _requirementsApply )` block of its own', function () {
            assert.ok(b646 > -1, 'the #B646 call is present (instrument control)');
            assert.ok(call > b646, 'the segments are listed after the #B646 check');
            assert.equal(CODE.split('paramBindings.findMultiPlaceholderSegments(').length - 1, 1);
            assert.ok(open > b646 && open < call, 'its own `if ( _requirementsApply )` block, opened after the #B646 call');
        });
        it('one warning, built by formatMultiPlaceholderWarning', function () {
            assert.equal(block.split('console.warn(').length - 1, 1, block);
            assert.ok(block.indexOf('paramBindings.formatMultiPlaceholderWarning(bundle, _multiPlaceholders)') > -1, block);
        });
        it('nothing in the block assigns to the routing table', function () {
            assert.ok(block.length > 0, 'the block was found (anti-vacuity)');
            assert.equal(/routing\s*(\[[^\]]*\]|\.[\w$]+)*\s*=[^=]/.test(block), false, block);
        });
    });
});
