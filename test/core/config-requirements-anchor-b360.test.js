/**
 * #B360 — the unanchored-`requirements` boot warning.
 *
 * A routing `requirements` regex is tested with `RegExp#test` when a request is matched, a
 * partial (search) match: `/[0-9]+/` accepts `123abc`. core/config.requirements-anchor.js
 * decides which regex requirements are anchored at both ends; core/config.js warns ONCE per
 * bundle listing the ones that are not, and never rewrites a requirement (the #P46
 * route-candidate index caches per routing table and reads requirement keys).
 *
 *   01  the predicate over a generic corpus — anchored per top-level alternative (a group
 *       spanning an alternative is unwrapped), the `m` flag counts as not anchored, escaped
 *       `$` / `|` and `|` inside a character class are handled, `validator::` and non-strings
 *       are not regex requirements.
 *   02  findUnanchoredRequirements lists them in table order and leaves the table untouched.
 *   03  formatUnanchoredWarning: one line naming the bundle and every item.
 *   04  config.js wiring: required once, gated to the bundle the process runs (or every bundle
 *       of a standalone process), called before setRouting, and nothing in the block assigns
 *       to a requirement.
 *
 * The booted arm (the warning printed once, naming only the unanchored requirement, and the
 * partial match itself: `/[0-9]+/` accepting `123abc` while `/^[0-9]+$/` answers 404) is in
 * test/integration/container-boot-swig-autoescape.test.js.
 *
 * Run standalone:
 *   node --test test/core/config-requirements-anchor-b360.test.js
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');
var anchor = require(path.join(FW, 'core/config.requirements-anchor.js'));
var CONFIG_SRC = fs.readFileSync(process.env.GINA_CONFIG_SRC || path.join(FW, 'core/config.js'), 'utf8');

describe('#B360 — which regex requirements are anchored at both ends', function () {

    describe('01 - isUnanchoredRequirement', function () {
        var ANCHORED = [
            '/^[0-9]+$/',
            '/^(intro|quickstart|reference)$/i',
            '/(^draft$|^[0-9]+$)/',
            '/(?:^a$|^b$)/',
            '/^\\d{4}-\\d{2}$/',
            '/^[a-z0-9-]+$/',
            '/^[|]+$/',                 // a pipe inside a character class is not an alternation
            '/^a\\|b$/',                // an escaped pipe is not an alternation
            '/^a\\\\$/',                // an escaped BACKSLASH, then an anchoring $
            '/^$/',
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i'
        ];
        var UNANCHORED = [
            '/[0-9]+/',
            '/^[0-9]+/',                // start only
            '/[0-9]+$/',                // end only
            '/^a|b$/',                  // top-level alternation: ^a has no end, b$ no start
            '/^txt|text|html$/i',
            '/([0-9]*)/',
            '/(^add|^[0-9]+$)/i',       // one alternative lacks $
            '/^(a|b)|c$/',
            '/^a\\$/',                  // an escaped $ is a literal
            '/^[0-9]+$/m',              // the m flag: ^ and $ match at line breaks
            '/^[0-9]+$/gm',
            '/^a$|/',                   // an empty alternative matches anything
            '//',                       // an empty pattern
            '/'
        ];
        ANCHORED.forEach(function (v) {
            it('anchored: ' + v, function () { assert.equal(anchor.isUnanchoredRequirement(v), false); });
        });
        UNANCHORED.forEach(function (v) {
            it('NOT anchored: ' + v, function () { assert.equal(anchor.isUnanchoredRequirement(v), true); });
        });
        it('validator:: values and non-strings are not regex requirements', function () {
            ['validator::{ isRequired: true, isEmail: true }', 'VALIDATOR::{ isEmail: true }', null, undefined, 42, {}, [], true]
                .forEach(function (v) { assert.equal(anchor.isUnanchoredRequirement(v), false, String(v)); });
        });
        it('CONTROL — the partial match it describes is real: RegExp#test accepts a value that only contains a match', function () {
            assert.equal(new RegExp('[0-9]+').test('123abc'), true);
            assert.equal(new RegExp('^[0-9]+$').test('123abc'), false);
            assert.equal(new RegExp('^[0-9]+$', 'm').test('123\nabc'), true, 'the m flag lets a newline through');
        });
    });

    describe('02 - findUnanchoredRequirements', function () {
        function table() {
            return {
                '$schema': 'https://gina.io/schema/routing.json',
                home   : { url: '/', param: { control: 'home' } },
                item   : { url: '/item/:id', requirements: { id: '/[0-9]+/' }, param: { control: 'item', id: ':id' } },
                page   : { url: '/page/:slug/:n', requirements: { slug: '/^[a-z-]+$/', n: '/^[0-9]+/' }, param: { control: 'page' } },
                search : { url: '/search/:q', requirements: { q: 'validator::{ isString: true }' }, param: { control: 'search' } },
                broken : null
            };
        }
        it('lists every unanchored regex requirement, in table order, with rule, key and value', function () {
            assert.deepEqual(anchor.findUnanchoredRequirements(table()), [
                { rule: 'item', key: 'id', value: '/[0-9]+/' },
                { rule: 'page', key: 'n',  value: '/^[0-9]+/' }
            ]);
        });
        it('reads only: the table and each requirements object are left untouched', function () {
            var t = table(), before = JSON.stringify(t), reqItem = t.item.requirements, reqPage = t.page.requirements;
            anchor.findUnanchoredRequirements(t);
            assert.equal(JSON.stringify(t), before);
            assert.strictEqual(t.item.requirements, reqItem);
            assert.strictEqual(t.page.requirements, reqPage);
        });
        it('an empty or missing table lists nothing', function () {
            assert.deepEqual(anchor.findUnanchoredRequirements({}), []);
            assert.deepEqual(anchor.findUnanchoredRequirements(null), []);
        });
    });

    describe('03 - formatUnanchoredWarning', function () {
        it('one requirement: singular wording, the bundle, the item and the guide link', function () {
            var s = anchor.formatUnanchoredWarning('api', [ { rule: 'item', key: 'id', value: '/[0-9]+/' } ]);
            assert.ok(s.indexOf('[CONFIG][loadBundleConfig] [ api ] 1 routing requirement is not anchored at both ends') === 0, s);
            assert.ok(s.indexOf('item { id: /[0-9]+/ }') > -1);
            assert.ok(s.indexOf('https://gina.io/docs/guides/routing#regex-requirements') > -1);
            assert.equal(s.indexOf('\n'), -1, 'one line');
        });
        it('several: plural wording and every item', function () {
            var s = anchor.formatUnanchoredWarning('api', [
                { rule: 'item', key: 'id', value: '/[0-9]+/' }, { rule: 'page', key: 'n', value: '/^[0-9]+/' } ]);
            assert.ok(s.indexOf('[ api ] 2 routing requirements are not anchored') > -1, s);
            assert.ok(s.indexOf('item { id: /[0-9]+/ }, page { n: /^[0-9]+/ }') > -1, s);
        });
    });

    describe('04 - core/config.js wiring', function () {
        function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/mg, ''); }
        var CODE = strip(CONFIG_SRC);
        var at = CODE.indexOf('var _requirementsApply = ');
        var block = CODE.slice(at, CODE.indexOf('self.setRouting(bundle, env, scope, routing);', at));

        it('the module is required once', function () {
            assert.equal(CODE.split("require('./config.requirements-anchor')").length - 1, 1);
        });
        it('gated to the bundle this process runs, or every bundle of a standalone process', function () {
            assert.ok(at > -1, 'the gate is present');
            assert.ok(block.indexOf('( bundle === self.startingApp ) || ( self.Host && typeof(self.Host.isStandalone) == \'function\' && self.Host.isStandalone() === true )') > -1);
        });
        it('one warning per bundle, emitted before setRouting', function () {
            assert.ok(block.indexOf('requirementsAnchor.findUnanchoredRequirements(routing)') > -1);
            assert.equal(block.split('console.warn(').length - 1, 1);
            assert.ok(block.indexOf('requirementsAnchor.formatUnanchoredWarning(bundle, _unanchored)') > -1);
        });
        it('nothing in the block assigns to a requirement', function () {
            assert.equal(/requirements\s*(\[[^\]]*\])?\s*=[^=]/.test(block), false);
            assert.ok(block.length > 0, 'the block was found (anti-vacuity)');
        });
    });
});
