'use strict';
/**
 * #B1123 — the URL-prefix step of locale negotiation reads the URL value bound to `param.culture`.
 *
 * A `culturePrefix` route binds its culture segment like any URL parameter (`"url": "/:culture/…"`,
 * `"param": { "culture": ":culture" }`). `negotiateCulture()` read `req.routing.param.culture`, which is
 * the route's raw routing config: the matcher captures the URL value in `req.params.culture` and leaves
 * the placeholder text `":culture"` in `req.routing.param`. So the URL step never matched a catalog, and
 * negotiation fell through to the cookie, `Accept-Language` and the bundle default: `GET /fr/dash/42`
 * answered in the bundle default, and `GET /en/…` with a `fr` cookie answered in `fr`. Reproduced on a
 * booted bundle (develop `35ae7b425`, 2026-11-15). The fix: when `param.culture` is a whole placeholder
 * (`:name`), the URL step reads `req.params[name]` (an own key only); a literal is used as is.
 *
 * Strategy: the REAL `lib/routing` (`compareUrls`, on a route description shaped as core/server.js
 * builds it) and the REAL `lib/i18n` (`negotiateCulture`, with the options core/server.js passes),
 * loaded through the framework's helpers bootstrap (the routing-param-file-matched-b877 shape).
 * Seam: `B1123_FW=<framework dir>` loads another tree's framework (for example the pre-fix main
 * worktree), for its pins AND its arms.
 *
 * Suites:
 *  01 — the instrument and the controls (hold before and after the fix)
 *  02 — the URL prefix takes the URL value (fix-sensitive)
 *  03 — fails closed: a value that names no loaded catalog never becomes the culture (holds on both)
 *  04 — source pins (comment-stripped, fix-sensitive)
 *
 * Red-first: run against the pre-fix framework (develop `35ae7b425`) — suites 02 and 04 red, the
 * others green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW       = process.env.B1123_FW || require('../fw');
var I18N_SRC = path.join(FW, 'lib/i18n/src/main.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var TABLE = {
    // the binding the routing guide prescribes for any URL parameter
    'bound@b':   { method: 'GET', url: '/:culture/dash/:id', bundle: 'b', culturePrefix: true,
                   param: { control: 'show', culture: ':culture', id: ':id' } },
    // the same with a requirement on the culture segment
    'req@b':     { method: 'GET', url: '/:culture/req/:id', bundle: 'b', culturePrefix: true,
                   requirements: { culture: '/^(en|fr)$/' },
                   param: { control: 'show', culture: ':culture', id: ':id' } },
    // a binding under another name: `lang` is the URL parameter, `culture` points at it
    'lang@b':    { method: 'GET', url: '/:lang/lang/:id', bundle: 'b', culturePrefix: true,
                   param: { control: 'show', lang: ':lang', culture: ':lang', id: ':id' } },
    // no culturePrefix: the URL is not a culture source
    'plain@b':   { method: 'GET', url: '/:culture/plain/:id', bundle: 'b',
                   param: { control: 'show', culture: ':culture', id: ':id' } },
    // a literal culture (a route that always serves one culture)
    'literal@b': { method: 'GET', url: '/lit/:id', bundle: 'b', culturePrefix: true,
                   param: { control: 'show', culture: 'fr', id: ':id' } },
    // `:culture` in the url, not bound in param: the route never matches
    'unbound@b': { method: 'GET', url: '/:culture/unbound/:id', bundle: 'b', culturePrefix: true,
                   param: { control: 'show', id: ':id' } },
    // a placeholder that names a prototype member
    'proto@b':   { method: 'GET', url: '/p/:id', bundle: 'b', culturePrefix: true,
                   param: { control: 'show', culture: ':toString', id: ':id' } }
};
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));
var i18n    = require(I18N_SRC);

// the options core/server.js's _negotiateReqCulture passes: the loaded catalogs, the cookie name,
// settings.region.culture (here a culture with no catalog, so it can only come from step 4)
var OPTS = { availableCultures: ['en', 'fr'], cookieName: 'gina_culture', defaultCulture: 'de_DE' };

/**
 * Match `url` against a rule the way the engine does (core/server.js builds this route description
 * on the cold path), then negotiate the culture as core/server.js does after a match.
 *
 * @param {string} rule
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<{past: boolean, req: object, culture: (string|undefined)}>}
 */
async function negotiate(rule, url, headers) {
    var r = TABLE[rule];
    var req = { method: 'GET', url: url, params: { 0: url }, get: {}, headers: headers || {} };
    var params = {
        method: 'get', control: r.param.control, requirements: r.requirements, namespace: undefined,
        url: url, rule: rule, cache: null, queryTimeout: null, csrfExempt: false, rateLimit: null,
        idempotency: null, culturePrefix: r.culturePrefix || false, negotiate: false,
        param: JSON.clone(r.param), middleware: [], bundle: r.bundle, isXMLRequest: false, isWithCredentials: false
    };
    var found = await routing.compareUrls(params, r.url, req, {}, function () {});
    var past = !!(found && found.past);
    return { past: past, req: req, culture: past ? i18n.negotiateCulture(req, OPTS) : undefined };
}

describe('#B1123 01 — the instrument and the controls', function () {

    it('the matcher captures the URL value in req.params and keeps the placeholder in req.routing.param', async function () {
        var got = await negotiate('bound@b', '/fr/dash/42');
        assert.equal(got.past, true);
        assert.equal(got.req.params.culture, 'fr');
        assert.equal(got.req.params.id, '42');
        assert.equal(got.req.routing.param.culture, ':culture');
        assert.equal(got.req.routing.culturePrefix, true);
    });

    it('CONTROL: the cookie gives fr when it names a loaded catalog', async function () {
        assert.equal((await negotiate('plain@b', '/fr/plain/43', { cookie: 'gina_culture=fr' })).culture, 'fr');
    });

    it('CONTROL: Accept-Language gives fr when it names a loaded catalog', async function () {
        assert.equal((await negotiate('plain@b', '/fr/plain/44', { 'accept-language': 'fr' })).culture, 'fr');
    });

    it('CONTROL: without culturePrefix the URL is not a source (the bundle default)', async function () {
        assert.equal((await negotiate('plain@b', '/fr/plain/45')).culture, 'de_DE');
    });

    it('CONTROL: a literal param.culture is used as is', async function () {
        var got = await negotiate('literal@b', '/lit/46');
        assert.equal(got.req.routing.param.culture, 'fr');
        assert.equal(got.culture, 'fr');
    });

    it('CONTROL: a culture segment left unbound never matches', async function () {
        assert.equal((await negotiate('unbound@b', '/fr/unbound/47')).past, false);
    });
});

describe('#B1123 02 — the URL prefix takes the URL value', function () {

    it('/fr/ gives fr', async function () {
        assert.equal((await negotiate('bound@b', '/fr/dash/48')).culture, 'fr');
    });

    it('the URL wins over the cookie: /en/ with a fr cookie gives en', async function () {
        assert.equal((await negotiate('bound@b', '/en/dash/49', { cookie: 'gina_culture=fr' })).culture, 'en');
    });

    it('the URL wins over Accept-Language: /en/ with Accept-Language fr gives en', async function () {
        assert.equal((await negotiate('bound@b', '/en/dash/50', { 'accept-language': 'fr' })).culture, 'en');
    });

    it('with a requirement on the culture segment', async function () {
        assert.equal((await negotiate('req@b', '/fr/req/51')).culture, 'fr');
    });

    it('a binding under another name reads that parameter', async function () {
        var got = await negotiate('lang@b', '/fr/lang/52');
        assert.equal(got.req.routing.param.culture, ':lang');
        assert.equal(got.culture, 'fr');
    });

    it('a hyphenated value falls back to its base language when only the base has a catalog', async function () {
        assert.equal((await negotiate('bound@b', '/en-US/dash/53')).culture, 'en');
    });
});

describe('#B1123 03 — fails closed', function () {

    it('a culture with no catalog falls through to the next source', async function () {
        assert.equal((await negotiate('bound@b', '/xx/dash/54')).culture, 'de_DE');
        assert.equal((await negotiate('bound@b', '/xx/dash/55', { cookie: 'gina_culture=fr' })).culture, 'fr');
    });

    it('a URL value naming a prototype member never matches', async function () {
        assert.equal((await negotiate('bound@b', '/constructor/dash/56')).culture, 'de_DE');
        assert.equal((await negotiate('bound@b', '/__proto__/dash/57')).culture, 'de_DE');
    });

    it('a placeholder naming a prototype member reads no inherited value', async function () {
        var got = await negotiate('proto@b', '/p/58');
        assert.equal(got.req.routing.param.culture, ':toString');
        assert.equal(got.culture, 'de_DE');
    });

    it('a placeholder with no req.params, or a null one, falls through', function () {
        var routingObj = { culturePrefix: true, param: { culture: ':culture' } };
        assert.equal(i18n.negotiateCulture({ routing: routingObj, headers: {} }, OPTS), 'de_DE');
        assert.equal(i18n.negotiateCulture({ routing: routingObj, params: null, headers: {} }, OPTS), 'de_DE');
        assert.equal(i18n.negotiateCulture({ routing: routingObj, params: { culture: 42 }, headers: {} }, OPTS), 'de_DE');
    });
});

describe('#B1123 04 — source pins', function () {
    var raw = fs.readFileSync(I18N_SRC, 'utf8');
    var start = raw.indexOf('function negotiateCulture(');
    var end = raw.indexOf('// 2. Cookie', start);
    var body = raw.slice(start, end);
    var code = body.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');

    it('the instrument: the URL-prefix step is found and its comment-stripped text kept code', function () {
        assert.ok(start > -1 && end > start, 'negotiateCulture and its cookie step');
        assert.match(code, /var pfx = req\.routing\.param\.culture;/);
    });

    it('a whole placeholder reads req.params under its name, an own key only', function () {
        assert.match(code, /\/\^:\\w\+\$\/\.test\(pfx\)/);
        assert.match(code, /Object\.prototype\.hasOwnProperty\.call\(req\.params, pfxName\)/);
        assert.match(code, /\? req\.params\[pfxName\]/);
    });
});
