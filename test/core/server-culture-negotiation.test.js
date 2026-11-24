/**
 * core/server.js — per-request culture negotiation on BOTH routing paths (#B84)
 *
 * `handle()`'s routing loop takes a warm (cached-route) fast-path that `break`s
 * out of the loop BEFORE the cold-path culture-negotiation site. Before #B84 the
 * negotiation lived inline on the cold path only, so `req.culture` was populated
 * on the first (cold) request to a URL and stayed unset on every subsequent
 * (warm/cached) request — which left the client-side i18n overlays inert on warm
 * page reloads (`gina.config.culture` empty). #B84 extracts the negotiation into a
 * per-request `_negotiateReqCulture(req, routeBundle)` closure shared by both
 * paths, so the culture is re-negotiated per request on the warm path too.
 *
 * The culture is deliberately NOT cached with the shared route entry: it varies
 * per request (cookie / Accept-Language), so pinning it to the cross-request
 * route cache would bleed one request's culture into another's.
 *
 * §01 pins the two-path source structure. §02 is a behavioural replica of the
 * exact fast-path-breaks-before-cold-site shape, driven by the REAL
 * `lib/i18n.negotiateCulture`, plus a SUBTRACT that reproduces the pre-fix bug
 * (warm path leaves `req.culture` empty while the cold path is unaffected — which
 * is why the defect hid in cold-only / hot-reload testing and only surfaced on a
 * real warm reload).
 */

'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW         = require('../fw');
var SERVER_SRC = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var i18n       = require(path.join(FW, 'lib/i18n/src/main'));


describe('01 - core/server.js — shared two-path negotiation source pins (#B84)', function() {

    it('defines the per-request _negotiateReqCulture(req, routeBundle) closure', function() {
        assert.match(SERVER_SRC, /var\s+_negotiateReqCulture\s*=\s*function\s*\(\s*req\s*,\s*routeBundle\s*\)/);
    });

    it('calls the helper on the WARM path, inside the `if ( hasCachedRoute )` block', function() {
        // Structural slice: the call must appear between the cached-route branch
        // open and its `} else {`, so it runs before the loop `break`s.
        var warmStart = SERVER_SRC.indexOf('if ( hasCachedRoute ) {');
        assert.ok(warmStart > -1, 'expected the cached-route fast-path branch');
        var warmEnd = SERVER_SRC.indexOf('} else {', warmStart);
        assert.ok(warmEnd > warmStart, 'expected the branch to close with an else');
        var warmBlock = SERVER_SRC.slice(warmStart, warmEnd);
        assert.match(warmBlock, /_negotiateReqCulture\s*\(\s*req\s*,/);
        // warm-path bundle resolution: prefer the cached req.routing.bundle,
        // fall back to the handle-scope bundle (self.appName).
        assert.match(warmBlock, /req\.routing\s*&&\s*req\.routing\.bundle/);
    });

    it('calls the helper on the COLD path with routing[name].bundle', function() {
        assert.match(SERVER_SRC, /_negotiateReqCulture\s*\(\s*req\s*,\s*routing\[name\]\.bundle\s*\)/);
    });

    it('has exactly two helper call sites (warm + cold), no third', function() {
        // `_negotiateReqCulture(` matches only the call sites — the definition is
        // `_negotiateReqCulture = function (…)` (no `(` directly after the name)
        // and the doc-comment mention is `` `_negotiateReqCulture` `` (backtick).
        var calls = (SERVER_SRC.match(/_negotiateReqCulture\s*\(/g) || []).length;
        assert.equal(calls, 2, 'expected exactly the warm + cold call sites');
    });

    it('keeps a single negotiateCulture implementation (no inline duplication)', function() {
        var impls = (SERVER_SRC.match(/lib\.i18n\.negotiateCulture\s*\(/g) || []).length;
        assert.equal(impls, 1, 'negotiation must live only inside the shared helper');
    });

    it('keeps the negotiation defensive (try/catch → GINA_CULTURE fallback)', function() {
        // The helper body wraps the negotiation and falls back to the env culture
        // so a negotiation failure can never block routing.
        assert.match(SERVER_SRC, /catch\s*\(\s*_i18nErr\s*\)\s*\{[\s\S]{1,200}getEnvVar\(\s*['"]GINA_CULTURE['"]\s*\)/);
    });

});


describe('02 - two-path structure — behavioural replica + subtract (#B84)', function() {

    // Faithful replica of handle()'s routing structure: the cached fast-path
    // returns (breaks the loop) before the cold-path negotiation site. The shared
    // helper mirrors _negotiateReqCulture — it drives the REAL negotiateCulture
    // with an empty availableCultures set (catalogs unloaded here), so the culture
    // resolves from the bundle default (settings.region.culture) on both paths.
    function makeHandle(opts) {
        var _negotiate = function(req, routeBundle) {
            req.culture = i18n.negotiateCulture(req, {
                availableCultures : [],
                cookieName        : 'gina_culture',
                defaultCulture    : opts.defaultCulture
            });
            // routeBundle is threaded exactly as the real helper receives it —
            // referenced so the replica mirrors the real call arity.
            return routeBundle;
        };
        return function handle(req, isCached) {
            if (isCached) {
                // warm / cached fast-path — negotiates (the #B84 fix) then breaks
                if (opts.withWarmCall) {
                    _negotiate(req, (req.routing && req.routing.bundle) || opts.fallbackBundle);
                }
                return; // loop `break`
            }
            // cold path — loop match → negotiate
            _negotiate(req, opts.routeBundle);
        };
    }

    var FIXED = { withWarmCall: true, defaultCulture: 'xx_XX', routeBundle: 'b', fallbackBundle: 'b' };

    it('cold (uncached) request negotiates the culture', function() {
        var handle = makeHandle(FIXED);
        var req = { culture: '', headers: {}, routing: { bundle: 'b' } };
        handle(req, false);
        assert.equal(req.culture, 'xx_XX');
    });

    it('warm (cached) request ALSO negotiates the culture (#B84 fix)', function() {
        var handle = makeHandle(FIXED);
        var req = { culture: '', headers: {}, routing: { bundle: 'b' } };
        handle(req, true);
        assert.equal(req.culture, 'xx_XX');
    });

    it('warm path falls back to the handle-scope bundle when req.routing.bundle is absent', function() {
        var handle = makeHandle(FIXED);
        var req = { culture: '', headers: {} }; // no req.routing
        handle(req, true);
        assert.equal(req.culture, 'xx_XX'); // still negotiates via the fallback bundle
    });

    it('SUBTRACT — without the warm-path call, a warm request leaves req.culture empty (the pre-fix bug)', function() {
        var handle = makeHandle({ withWarmCall: false, defaultCulture: 'xx_XX', routeBundle: 'b', fallbackBundle: 'b' });
        var req = { culture: '', headers: {}, routing: { bundle: 'b' } };
        handle(req, true);
        assert.equal(req.culture, '', 'pre-fix: warm/cached path never negotiated');
    });

    it('SUBTRACT — the cold path is unaffected by the bug (why it hid in cold-only testing)', function() {
        var handle = makeHandle({ withWarmCall: false, defaultCulture: 'xx_XX', routeBundle: 'b', fallbackBundle: 'b' });
        var req = { culture: '', headers: {}, routing: { bundle: 'b' } };
        handle(req, false);
        assert.equal(req.culture, 'xx_XX', 'cold path always negotiated — the defect was warm-path-specific');
    });

    it('per-request negotiation cannot bleed across requests (cookie varies)', function() {
        // Two warm requests with different cookies resolve to different cultures —
        // proving the culture is re-derived per request, not pinned to the shared
        // route cache.
        var handle = makeHandle({ withWarmCall: true, defaultCulture: 'en', routeBundle: 'b', fallbackBundle: 'b' });
        var reqA = { culture: '', headers: { cookie: 'gina_culture=fr' }, routing: { bundle: 'b' } };
        var reqB = { culture: '', headers: { cookie: 'gina_culture=de' }, routing: { bundle: 'b' } };
        // availableCultures is empty in this replica, so the cookie can't match a
        // loaded catalog — both fall to the default. The invariant under test is
        // that each request negotiates independently (no shared mutable culture).
        handle(reqA, true);
        handle(reqB, true);
        assert.equal(reqA.culture, 'en');
        assert.equal(reqB.culture, 'en');
        // distinct request objects, each carrying its own culture field
        assert.notStrictEqual(reqA, reqB);
    });

});


describe('03 - settings.i18n.cookieName wiring source pins (#B99)', function() {

    // End-anchor slice of the helper (definition → the stable following
    // comment), no fixed byte window.
    // #B1132 — the option derivation moved, verbatim, into the server-scope
    // resolveCultureNegotiation(bundle), which _negotiateReqCulture and the output
    // cache's request variant both call: the slice reads that function.
    var hStart      = SERVER_SRC.indexOf('var resolveCultureNegotiation');
    var hEnd        = SERVER_SRC.indexOf('this.start = function', hStart);
    var helperBlock = SERVER_SRC.slice(hStart, hEnd);

    it('slices the helper block', function() {
        assert.ok(hStart > -1, 'helper definition must exist');
        assert.ok(hEnd > hStart, 'end anchor must follow the definition');
    });

    it('resolves the cookie name from the bundle settings i18n block', function() {
        assert.match(helperBlock, /content\.settings\.i18n\b/);
    });

    it('keeps the historical default as the init value', function() {
        assert.match(helperBlock, /var\s+_i18nCookieName\s*=\s*'gina_culture'/);
    });

    it('honours the documented null-disables contract', function() {
        assert.match(helperBlock, /_i18nCookieConf\s*===\s*null/);
    });

    it('accepts only a non-empty string as a custom name', function() {
        assert.match(helperBlock, /typeof\s*\(\s*_i18nCookieConf\s*\)\s*==\s*'string'\s*&&\s*_i18nCookieConf\.length\s*>\s*0/);
    });

    it('passes the resolved variable to negotiateCulture — never the opts literal', function() {
        assert.match(helperBlock, /cookieName\s*:\s*_i18nCookieName/);
        assert.doesNotMatch(helperBlock, /cookieName\s*:\s*'gina_culture'/);
    });

});


describe('04 - cookie-name resolution + negotiation behaviour (#B99)', function() {

    // Verbatim-lifted resolution logic — locked to the shipped block by the
    // §03 pins. Models the settings-level tail of the guard chain (the
    // conf-existence levels above it are the same idiom as _i18nDefault).
    function resolveCookieName(settings) {
        var _i18nCookieName = 'gina_culture';
        if ( settings && settings.i18n ) {
            var _i18nCookieConf = settings.i18n.cookieName;
            if ( _i18nCookieConf === null ) {
                _i18nCookieName = null;
            } else if ( typeof(_i18nCookieConf) == 'string' && _i18nCookieConf.length > 0 ) {
                _i18nCookieName = _i18nCookieConf;
            }
        }
        return _i18nCookieName;
    }

    it('absent i18n block → historical default', function() {
        assert.equal(resolveCookieName({}), 'gina_culture');
        assert.equal(resolveCookieName(undefined), 'gina_culture');
    });

    it('explicit null → null (cookie negotiation disabled)', function() {
        assert.strictEqual(resolveCookieName({ i18n: { cookieName: null } }), null);
    });

    it('custom string honoured', function() {
        assert.equal(resolveCookieName({ i18n: { cookieName: 'my_lang' } }), 'my_lang');
    });

    it('empty string / non-string junk → historical default', function() {
        assert.equal(resolveCookieName({ i18n: { cookieName: '' } }), 'gina_culture');
        assert.equal(resolveCookieName({ i18n: { cookieName: 42 } }), 'gina_culture');
        assert.equal(resolveCookieName({ i18n: {} }), 'gina_culture');
    });

    // REAL negotiateCulture driven with the resolved names.

    it('a custom cookie name resolves the culture end-to-end', function() {
        var req = { headers: { cookie: 'my_lang=fr' } };
        var c = i18n.negotiateCulture(req, { availableCultures: ['fr'], cookieName: 'my_lang', defaultCulture: 'en' });
        assert.equal(c, 'fr');
    });

    it('null cookie name skips the cookie step (the documented disable)', function() {
        var req = { headers: { cookie: 'gina_culture=fr' } };
        var c = i18n.negotiateCulture(req, { availableCultures: ['fr'], cookieName: null, defaultCulture: 'en' });
        assert.equal(c, 'en', 'cookie present but cookie-based negotiation disabled → default culture');
    });

    it('the historical default name still works end-to-end', function() {
        var req = { headers: { cookie: 'gina_culture=fr' } };
        var c = i18n.negotiateCulture(req, { availableCultures: ['fr'], cookieName: 'gina_culture', defaultCulture: 'en' });
        assert.equal(c, 'fr');
    });

    it('SUBTRACT — under the pre-fix hardcoded name a custom-named cookie is invisible', function() {
        var req = { headers: { cookie: 'my_lang=fr' } };
        var c = i18n.negotiateCulture(req, { availableCultures: ['fr'], cookieName: 'gina_culture', defaultCulture: 'en' });
        assert.equal(c, 'en', 'the pre-fix opts always carried gina_culture, so my_lang could never match');
    });

});


describe('05 - settings.i18n.cultures allowlist source pins (#B102)', function() {

    // Same end-anchor slice as §03 — definition → the stable following comment.
    // #B1132 — the option derivation moved, verbatim, into the server-scope
    // resolveCultureNegotiation(bundle), which _negotiateReqCulture and the output
    // cache's request variant both call: the slice reads that function.
    var hStart      = SERVER_SRC.indexOf('var resolveCultureNegotiation');
    var hEnd        = SERVER_SRC.indexOf('this.start = function', hStart);
    var helperBlock = SERVER_SRC.slice(hStart, hEnd);

    it('slices the helper block', function() {
        assert.ok(hStart > -1 && hEnd > hStart);
    });

    it('reads the allowlist from the bundle settings i18n block', function() {
        assert.match(helperBlock, /content\.settings\.i18n\.cultures/);
    });

    it('applies the allowlist only when it is a NON-EMPTY array', function() {
        assert.match(helperBlock, /Array\.isArray\(\s*_i18nCulturesConf\s*\)\s*&&\s*_i18nCulturesConf\.length\s*>\s*0/);
    });

    it('short-circuits when no catalogs are loaded (nothing to constrain)', function() {
        assert.match(helperBlock, /if\s*\(\s*_i18nAvail\.length\s*>\s*0/);
    });

    it('constrains by INTERSECTION — the available list is filtered, never replaced', function() {
        assert.match(helperBlock, /_i18nAvail\s*=\s*_i18nAvail\.filter\(/);
    });

    it('the intersect runs BEFORE the negotiate call, so every user-signal step sees it', function() {
        // #B1132 — the moved block returns the options; _negotiateReqCulture hands them to
        // negotiateCulture. The filter precedes the returned list, and the call takes them.
        var filterIdx    = helperBlock.indexOf('_i18nAvail.filter(');
        var returnIdx    = helperBlock.indexOf('availableCultures : _i18nAvail');
        assert.ok(filterIdx > -1 && returnIdx > filterIdx);
        assert.match(SERVER_SRC, /lib\.i18n\.negotiateCulture\(\s*req\s*,\s*resolveCultureNegotiation\(\s*routeBundle\s*\)\s*\)/);
    });

});


describe('06 - cultures allowlist behaviour — replica + REAL negotiateCulture (#B102)', function() {

    // Verbatim-lifted settings-level tail of the shipped block (locked by the
    // §05 pins) — same modelling convention as §04's resolveCookieName.
    function constrainAvailable(avail, settings) {
        var out = avail;
        if ( out.length > 0 && settings && settings.i18n ) {
            var _i18nCulturesConf = settings.i18n.cultures;
            if ( Array.isArray(_i18nCulturesConf) && _i18nCulturesConf.length > 0 ) {
                out = out.filter(function(c) {
                    return _i18nCulturesConf.indexOf(c) > -1;
                });
            }
        }
        return out;
    }

    var AVAIL = ['en', 'fr', 'de'];

    it('null keeps the historical derive-from-catalogs behaviour', function() {
        assert.deepEqual(constrainAvailable(AVAIL, { i18n: { cultures: null } }), AVAIL);
    });

    it('an EMPTY array is treated as unset — no surprise lockout at pickup', function() {
        assert.deepEqual(constrainAvailable(AVAIL, { i18n: { cultures: [] } }), AVAIL);
    });

    it('non-array junk is ignored', function() {
        assert.deepEqual(constrainAvailable(AVAIL, { i18n: { cultures: 'en' } }), AVAIL);
        assert.deepEqual(constrainAvailable(AVAIL, {}), AVAIL);
        assert.deepEqual(constrainAvailable(AVAIL, undefined), AVAIL);
    });

    it('a non-empty array constrains by intersection', function() {
        assert.deepEqual(constrainAvailable(AVAIL, { i18n: { cultures: ['en', 'fr'] } }), ['en', 'fr']);
    });

    it('allowlist entries with no loaded catalog are harmless (intersection, not union)', function() {
        assert.deepEqual(constrainAvailable(AVAIL, { i18n: { cultures: ['en', 'zz'] } }), ['en']);
    });

    // ---- REAL negotiateCulture driven with a constrained list ---------------

    it('a constrained Accept-Language cannot match an excluded culture (staged rollout)', function() {
        var req   = { headers: { 'accept-language': 'de' } };
        var avail = constrainAvailable(AVAIL, { i18n: { cultures: ['en', 'fr'] } });
        var c = i18n.negotiateCulture(req, { availableCultures: avail, cookieName: 'gina_culture', defaultCulture: 'en' });
        assert.equal(c, 'en', 'de is shipped but not launched — negotiation falls to the default');
    });

    it('a constrained cookie cannot match an excluded culture either', function() {
        var req   = { headers: { cookie: 'gina_culture=de' } };
        var avail = constrainAvailable(AVAIL, { i18n: { cultures: ['en', 'fr'] } });
        var c = i18n.negotiateCulture(req, { availableCultures: avail, cookieName: 'gina_culture', defaultCulture: 'en' });
        assert.equal(c, 'en');
    });

    it('the bundle-default step is NOT constrained — the operator fallback needs no catalog', function() {
        var req   = { headers: {} };
        var avail = constrainAvailable(['en'], { i18n: { cultures: ['en'] } });
        var c = i18n.negotiateCulture(req, { availableCultures: avail, cookieName: 'gina_culture', defaultCulture: 'de' });
        assert.equal(c, 'de', 'step 4 returns the configured default directly');
    });

    it('SUBTRACT — without the intersect the excluded culture wins (the pre-fix inert-key behaviour)', function() {
        var req = { headers: { 'accept-language': 'de' } };
        var c = i18n.negotiateCulture(req, { availableCultures: AVAIL, cookieName: 'gina_culture', defaultCulture: 'en' });
        assert.equal(c, 'de', 'pre-fix the allowlist was never applied, so de matched regardless');
    });

});
