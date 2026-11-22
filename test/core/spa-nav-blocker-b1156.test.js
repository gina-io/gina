'use strict';
/**
 * #B1156 — gina/nav: a route whose URL the module cannot match exactly still blocks.
 *
 * The server reads a placeholder over its whole URL segment and ignores any text around it:
 * `/page:number` answers `/page2` with number `page2`, and `/:lang-code` answers `/fr` with lang
 * `fr`. The navigation module leaves such a variant uncompiled (`compileVariant` returns null),
 * and its scan used to SKIP it: a later route declaring `negotiate: true` then took a link the
 * server answers from the earlier route, so the click was intercepted, the fragment answer came
 * back without `Vary: X-Gina-Navigate`, and the page reloaded in full after an `error` event.
 * `getCompiled` now compiles each such variant a second time by the server's reading (that name
 * counted as bound, the route's requirements kept) into `blockers`; when a blocker matches,
 * `matchUrl` returns null and the link navigates normally.
 *
 * The matcher functions are cut from the shipped files (source and the built dist) and built the
 * way spa-nav-module.test.js builds them: the same extractor, the same injected names.
 *
 *  01 — instrument: the functions are found in both files; a compilable first route matches and a
 *       pathname no route matches gives null
 *  02 — an uncompiled first route that the server would match blocks the later negotiable route
 *  03 — where the server would skip the uncompiled route, the later route still matches
 *  04 — the shipped bundle carries the blockers
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO    = path.join(__dirname, '..', '..');
const FW      = path.join(REPO, 'framework', 'v' + require(path.join(REPO, 'package.json')).version);
const NAV_SRC = path.join(FW, 'core/asset/plugin/src/vendor/gina/nav/main.js');
const DIST_JS = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
const DIST_MIN_JS = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

/**
 * Cuts one function expression out of a source text, from its declaration to its closing brace.
 *
 * @inner
 * @param {string} src
 * @param {string} decl - the unique declaration line start, e.g. `var matchUrl = function(pathname) {`
 * @returns {string} the function expression
 */
function extractFn(src, decl) {
    const i = src.indexOf(decl);
    assert.ok(i > -1, 'declaration not found: ' + decl);
    assert.equal(src.indexOf(decl, i + 1), -1, 'declaration must be unique: ' + decl);
    let j = i, depth = 0, started = false;
    for (; j < src.length; j++) {
        if (src[j] === '{') { depth++; started = true; }
        else if (src[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
    }
    assert.ok(started && depth === 0, 'unbalanced braces walking: ' + decl);
    return src.substring(i + decl.indexOf('function'), j);
}

/**
 * Builds a matcher factory from one file: `make(table, bundle)` returns `{ match, compile }`.
 *
 * @inner
 * @param {string} file
 * @returns {function} make
 */
function factory(file) {
    const src = fs.readFileSync(file, 'utf8');
    const EX = {
        parseRequirement: extractFn(src, 'var parseRequirement = function(requirement) {'),
        compileVariant  : extractFn(src, 'var compileVariant = function(url, route) {'),
        getCompiled     : extractFn(src, 'var getCompiled = function() {'),
        safeDecode      : extractFn(src, 'var safeDecode = function(str) {'),
        matchUrl        : extractFn(src, 'var matchUrl = function(pathname) {')
    };
    return function make(table, bundle) {
        const fakeWindow  = { gina: { config: { bundle: bundle, routing: table } } };
        const parse       = new Function('return (' + EX.parseRequirement + ');')();
        const compile     = new Function('parseRequirement', 'return (' + EX.compileVariant + ');')(parse);
        const getCompiled = new Function('window', '_compiled', '_compiledFor', 'compileVariant',
            'return (' + EX.getCompiled + ');')(fakeWindow, null, null, compile);
        const safeDecode  = new Function('return (' + EX.safeDecode + ');')();
        const match       = new Function('getCompiled', 'safeDecode', 'return (' + EX.matchUrl + ');')(getCompiled, safeDecode);
        return { match: match, compile: compile };
    };
}

const R = function (url, extra) { return Object.assign({ bundle: 'demo', method: 'GET', url: url, param: { control: 'x' } }, extra || {}); };
const SLUG = R('/:slug', { negotiate: true, param: { control: 'b', slug: ':slug' } });
const TWO  = R('/:a/:b', { negotiate: true, param: { control: 'b', a: ':a', b: ':b' } });
const DIGITS = { number: '/^[0-9]+$/' };
const TABLES = {
    textBefore    : { pageA: R('/page:number', { param: { control: 'a', number: ':number' } }), slugB: SLUG },
    textBeforeReq : { pageA: R('/page:number', { param: { control: 'a', number: ':number' }, requirements: DIGITS }), slugB: SLUG },
    hyphenName    : { langA: R('/:lang-code', { param: { control: 'a', lang: ':lang' } }), slugB: SLUG },
    negotiableA   : { pageA: R('/page:number', { negotiate: true, param: { control: 'a', number: ':number' } }), slugB: SLUG },
    multiVariant  : { multiA: R('/x/page:n,/list', { param: { control: 'a', n: ':n' } }), slugB: SLUG, twoB: TWO },
    compilableA   : { pageA: R('/page/:number', { param: { control: 'a', number: ':number' }, requirements: DIGITS }), slugB: SLUG },
    uncompiledLast: { slugB: SLUG, pageA: R('/page:number', { param: { control: 'a', number: ':number' } }) },
    unboundKey    : { itemA: R('/item/:id', { param: { control: 'a' } }), twoB: TWO },
    rawEquality   : { 'mixed@demo': R('/section/page:number', { param: { number: ':number' }, negotiate: true }) },
    twoPlaceholders: { rangeA: R('/r/:from-:to', { param: { control: 'a', from: ':from', to: ':to' } }),
                       slugR: R('/r/:slug', { negotiate: true, param: { control: 'b', slug: ':slug' } }) }
};
const ruleOf = function (m) { return m ? m.rule : null; };

[['source', NAV_SRC], ['dist gina.js', DIST_JS]].forEach(function (pair) {
    const label = pair[0];
    const make  = factory(pair[1]);
    const match = function (table, pathname) { return ruleOf(make(TABLES[table], 'demo').match(pathname)); };

    describe('#B1156 01 (' + label + ') — instrument', function () {
        it('01.1  a compilable first route matches (no interception: it is not negotiable)', function () {
            assert.equal(match('compilableA', '/page/2'), 'pageA');
        });
        it('01.2  a pathname no route matches gives null', function () {
            assert.equal(match('compilableA', '/a/b/c'), null);
        });
        it('01.3  compileVariant still returns null for a segment with text before its placeholder', function () {
            assert.equal(make({}, 'demo').compile('/section/page:number', { param: { number: ':number' }, requirements: DIGITS }), null);
        });
    });

    describe('#B1156 02 (' + label + ') — an uncompiled first route the server would match blocks the later route', function () {
        it('02.1  `/page:number` (no requirement) before a negotiable `/:slug`: /page2, /42 and /foo give null', function () {
            assert.equal(match('textBefore', '/page2'), null);
            assert.equal(match('textBefore', '/42'), null);
            assert.equal(match('textBefore', '/foo'), null);
        });
        it('02.2  with a digits requirement on number: /42 gives null', function () {
            assert.equal(match('textBeforeReq', '/42'), null);
        });
        it('02.3  `/:lang-code` (lang bound) before a negotiable `/:slug`: /fr gives null', function () {
            assert.equal(match('hyphenName', '/fr'), null);
        });
        it('02.4  a negotiable `/page:number` first: /page2 gives null (such links navigate normally)', function () {
            assert.equal(match('negotiableA', '/page2'), null);
        });
        it('02.5  a route with two variants: its uncompiled variant blocks /x/foo; its compiled one still matches /list', function () {
            assert.equal(match('multiVariant', '/x/foo'), null);
            assert.equal(match('multiVariant', '/list'), 'multiA');
        });
    });

    describe('#B1156 03 (' + label + ') — where the server would skip the uncompiled route, the later route still matches', function () {
        it('03.1  the requirement fails on the whole segment (/page2 against digits): the later route matches', function () {
            assert.equal(match('textBeforeReq', '/page2'), 'slugB');
        });
        it('03.2  the uncompiled route comes after the negotiable one: the negotiable one matches first', function () {
            assert.equal(match('uncompiledLast', '/page2'), 'slugB');
        });
        it('03.3  a pure placeholder bound in neither param nor requirements stays skipped (the server refuses it)', function () {
            assert.equal(match('unboundKey', '/item/7'), 'twoB');
        });
        it('03.4  a pathname byte-equal to the raw pattern still matches that route', function () {
            assert.equal(match('rawEquality', '/section/page:number'), 'mixed@demo');
        });
        it('03.5  a segment holding two placeholders is compared as written by the server: no blocker, the later route matches', function () {
            assert.equal(match('twoPlaceholders', '/r/1-5'), 'slugR');
        });
    });
});

describe('#B1156 04 — the shipped bundle carries the blockers', function () {
    it('04.1  gina.min.js holds the `blockers` key (control: the `variants` key it sits beside)', function () {
        const min = fs.readFileSync(DIST_MIN_JS, 'utf8');
        assert.ok(min.split('variants').length - 1 > 0, 'control: the variants key must be in the bundle');
        assert.ok(min.split('blockers').length - 1 > 0, 'the blockers key must be in the bundle');
    });
});
