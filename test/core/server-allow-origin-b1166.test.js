/**
 * #B1166 — the Access-Control-Allow-Origin rule (core/server.js `allowOriginFor`) built regular expressions from
 * the request: a dead store compiled from the request's origin (or host), and, for an HTTP/1.1 request without an
 * Origin, a pattern compiled from its Host and tested against a Referer that is always '' or null there. A malformed
 * `Origin` (`http://a(`), a malformed Host (`a(`), a Host whose pattern matches "null" or '' (`n`, `a*`) and a
 * request with no Host at all (HTTP/1.0) threw. completeHeaders() runs the rule for a configured
 * `access-control-allow-origin` name; on a static file it runs inside an fs callback, so the throw reached
 * uncaughtException and stopped the bundle (measured on a booted bundle), and on a page it left the request
 * unanswered. A `{name@x}` token naming an `Object.prototype` member (or another own key of the configuration)
 * threw too.
 * #B1167 — with the configured value empty, the rule resolved `{bundle@project}` tokens in the request's own
 * origin, so `Origin: {api@proj}` was answered with that bundle's configured hostname.
 *
 * Like server-allow-origin-b1104.test.js, this file lifts the SHIPPED bytes of `allowOriginFor`, the stamp
 * `instance._renderCacheAllowOrigin` and `completeHeaders`, and runs them against a fake `self`. The source is
 * GINA_SERVER_SRC when set (a module-path seam: the whole file runs red-first against a pre-fix copy, such as
 * `git show <sha>:framework/v<version>/core/server.js`), else the tree's core/server.js.
 *
 * Arm 02.4 of server-allow-origin-b1104.test.js fed `Origin: http://a(` to make the rule throw. That Origin no
 * longer throws, so the arms that discriminate the guards live here (§04): a configured value that is not a
 * string still throws, which arm 04.0 checks first.
 *
 * Run standalone:
 *   node --test test/core/server-allow-origin-b1166.test.js
 *   GINA_SERVER_SRC=/path/to/pre-fix/server.js node --test test/core/server-allow-origin-b1166.test.js
 */

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW         = require('../fw');
var SERVER_SRC = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');
var SRC        = fs.readFileSync(SERVER_SRC, 'utf8');

var OA = 'http://oa.example', OB = 'http://ob.example', OC = 'http://oc.example';
var LIST = OA + ', ' + OB;
var HOST = '127.0.0.1:3100';

/** The text of a closure inside the Server constructor, from its declaration to its closing brace. */
function lift(decl) {
    var start = SRC.indexOf(decl);
    assert.ok(start > -1, 'extraction control: `' + decl + '` is in ' + SERVER_SRC);
    assert.equal(SRC.indexOf(decl, start + 1), -1, 'extraction control: `' + decl + '` is declared once');
    var end = SRC.indexOf('\n    }\n', start);
    assert.ok(end > start, 'extraction control: the closing brace of `' + decl + '` is found');
    return SRC.slice(start, end + '\n    }'.length);
}

/** The stamp's function expression. */
function liftStampText() {
    var at = SRC.indexOf('instance._renderCacheAllowOrigin = function(req, res) {');
    assert.ok(at > -1, 'extraction control: the stamp is in ' + SERVER_SRC);
    var fnStart = SRC.indexOf('function(req, res) {', at);
    var fnEnd   = SRC.indexOf('\n                };', fnStart);
    assert.ok(fnEnd > fnStart, 'extraction control: the stamp\'s closing brace is found');
    return SRC.slice(fnStart, fnEnd + '\n                }'.length);
}

/** The source with its whole-line comments removed (`//`, `/*`, ` *`). */
function code(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\/\*|\*)/.test(l); }).join('\n');
}

/**
 * A fake Server `self`: bundle `web` (env `prod`) and a second bundle `api` for `{api@proj}` tokens.
 * opts.protocol / opts.scheme / opts.hostname shape `web`; opts.extra adds own keys to `conf`.
 */
function fakeSelf(header, opts) {
    opts = opts || {};
    var conf = {
        web : { prod: { hostname: opts.hostname || 'http://127.0.0.1:3100', host: '127.0.0.1',
            server: { protocol: opts.protocol || 'http/1.1', scheme: opts.scheme || 'http', port: 3100, response: { header: header } } } },
        api : { prod: { hostname: 'https://api.example', host: 'api.example',
            server: { protocol: 'http/1.1', scheme: 'https', port: 443, response: { header: {} } } } }
    };
    if ( opts.extra ) { Object.keys(opts.extra).forEach(function (k) { conf[k] = opts.extra[k]; }); }
    return { appName: 'web', env: 'prod', scope: 'local', conf: conf };
}

/* eslint-disable no-new-func */
function helperFor(self) {
    return new Function('self', "'use strict';\n" + lift('var allowOriginFor = function(request) {') + '\nreturn allowOriginFor;')(self);
}

function stampFor(self) {
    return new Function('self', 'allowOriginFor', "'use strict';\nreturn (" + liftStampText() + ');')(self, helperFor(self));
}

/**
 * completeHeaders() with the names it reads besides `self`: `merge` (reached only with extra headers),
 * `JSON.clone`, given here as a scoped JSON whose clone carries gina's `count()` (own enumerable keys,
 * helpers/prototypes.js) as a non-enumerable own method, so no global prototype is touched, and a `console`
 * whose `error` calls are recorded in `logged` (the guard logs what it catches).
 */
function completeHeadersFor(self, logged) {
    var scopedJSON = {
        parse     : JSON.parse,
        stringify : JSON.stringify,
        clone     : function (o) {
            var c = JSON.parse(JSON.stringify(o || {}));
            Object.defineProperty(c, 'count', { enumerable: false, value: function () { return Object.keys(this).length; } });
            return c;
        }
    };
    var merge = function (a, b) { return Object.assign({}, b, a); };
    var scopedConsole = { error: function (e) { ( logged || [] ).push(e); }, log: function () {}, warn: function () {}, debug: function () {} };
    return new Function('self', 'merge', 'JSON', 'console', "'use strict';\n"
        + lift('var allowOriginFor = function(request) {') + '\n'
        + lift('var completeHeaders = function(responseHeaders, request, response) {')
        + '\nreturn completeHeaders;')(self, merge, scopedJSON, scopedConsole);
}
/* eslint-enable no-new-func */

/** A fake response recording what is set. */
function fakeRes(sent) {
    return { headersSent: !!sent, h: {},
        setHeader : function (n, v) { this.h[String(n).toLowerCase()] = v; },
        getHeader : function (n) { return this.h[String(n).toLowerCase()]; },
        getHeaders: function () { return Object.assign({}, this.h); } };
}

/** A request completeHeaders() accepts. */
function fakeReq(headers) {
    return { url: '/', method: 'GET', routing: { url: '/', method: 'GET' }, headers: headers };
}

/** Calls fn(); returns its value, or a string naming what it threw. */
function outcome(fn) {
    try { return fn(); } catch (e) { return 'THREW ' + ( ( e && e.name ) || typeof(e) ) + ': ' + ( ( e && e.message ) || String(e) ); }
}

var MALFORMED = ['http://a(', '(', 'http://a)', '[', '\\', '*', '+', 'a{2,1}', '(?<'];


describe('00 - the instrument: the lifted bytes answer as the booted bundle did', function () {

    it('00.1 allowOriginFor, completeHeaders and the stamp are each found once (source: ' + ( process.env.GINA_SERVER_SRC ? 'GINA_SERVER_SRC' : 'the tree' ) + ')', function () {
        lift('var allowOriginFor = function(request) {');
        lift('var completeHeaders = function(responseHeaders, request, response) {');
        liftStampText();
    });

    it('00.2 CONTROL: a listed origin gets its own, an unlisted one none (measured on a booted bundle, #B1104)', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': LIST }));
        assert.equal(f({ headers: { origin: OA, host: HOST } }), OA);
        assert.equal(f({ headers: { origin: OC, host: HOST } }), null);
    });
});


describe('01 - #B1166 no request makes the rule throw', function () {

    // the request that stopped a booted bundle on a static file (2026-11-25, develop 24108d4f2)
    it('01.1 Origin: http://a( with a configured list: none', function () {
        assert.equal(outcome(function () { return helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { origin: 'http://a(', host: HOST } }); }), null);
    });

    it('01.2 every malformed origin, with a configured list: none', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': LIST }));
        MALFORMED.forEach(function (o) {
            assert.equal(outcome(function () { return f({ headers: { origin: o, host: HOST } }); }), null, 'Origin: ' + o);
        });
    });

    it('01.3 every malformed origin, with a single configured value: that value', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': 'https://one.example' }));
        MALFORMED.forEach(function (o) {
            assert.equal(outcome(function () { return f({ headers: { origin: o, host: HOST } }); }), 'https://one.example', 'Origin: ' + o);
        });
    });

    // a comma makes the rule read the value as a list, which never holds the whole origin: none, as for any origin
    // carrying a comma (that branch is unchanged; measured 2026-11-25 on `a{2,1}`, which threw before the fix)
    it('01.4 every malformed origin, with an empty configured value: the origin as received, or none when it holds a comma', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': '' }));
        MALFORMED.forEach(function (o) {
            assert.equal(outcome(function () { return f({ headers: { origin: o, host: HOST } }); }), ( o.indexOf(',') > -1 ) ? null : o, 'Origin: ' + o);
        });
    });

    it('01.5 HTTP/1.1, no Origin, Host: a( (not a valid pattern): none', function () {
        assert.equal(outcome(function () { return helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { host: 'a(' } }); }), null);
    });

    it('01.6 HTTP/1.1, no Origin, Host: n (its pattern matches "null"): none', function () {
        assert.equal(outcome(function () { return helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { host: 'n' } }); }), null);
    });

    it('01.7 HTTP/1.1, no Origin and no Host (an HTTP/1.0 request): none', function () {
        assert.equal(outcome(function () { return helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: {} }); }), null);
    });

    it('01.8 HTTP/1.1, no Origin, a Referer and Host: a* (its pattern matches \'\'): none', function () {
        assert.equal(outcome(function () { return helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { host: 'a*', referer: 'http://x.example/page' } }); }), null);
    });

    it('01.9 an empty configured value, an Origin naming an Object.prototype member as a {name@x} token: the origin as received', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': '' }));
        ['{constructor@y}', 'http://x{__proto__@y}', '{toString@y}', '{hasOwnProperty@y}'].forEach(function (o) {
            assert.equal(outcome(function () { return f({ headers: { origin: o, host: HOST } }); }), o, 'Origin: ' + o);
        });
    });

    it('01.10 a configured list naming an Object.prototype member or another own key: the token is skipped, a listed origin still gets its own', function () {
        [OA + ', {constructor@x}', OA + ', {__proto__@x}', OA + ', {env@x}'].forEach(function (cfg) {
            var f = helperFor(fakeSelf({ 'access-control-allow-origin': cfg }, { extra: { env: 'prod' } }));
            assert.equal(outcome(function () { return f({ headers: { origin: OA, host: HOST } }); }), OA, 'configured: ' + cfg);
            assert.equal(outcome(function () { return f({ headers: { origin: OC, host: HOST } }); }), null, 'configured: ' + cfg);
        });
    });

    it('01.11 #B1167 an empty configured value echoes Origin: {api@proj} as received, not that bundle\'s hostname', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': '' }));
        assert.equal(outcome(function () { return f({ headers: { origin: '{api@proj}', host: HOST } }); }), '{api@proj}');
    });
});


describe('02 - #B1166 the values the rule gave without throwing are kept', function () {

    it('02.1 HTTP/1.1, no Origin, the bundle\'s own host: its own origin', function () {
        assert.equal(helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { host: HOST } }), 'http://127.0.0.1:3100');
    });

    it('02.2 HTTP/1.1, no Origin, a bundle configured https: the configured scheme', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': LIST }, { scheme: 'https', hostname: 'https://127.0.0.1:3100' }));
        assert.equal(f({ headers: { host: HOST } }), 'https://127.0.0.1:3100');
    });

    it('02.3 HTTP/1.1, no Origin, a Referer, the bundle\'s own host: its own origin', function () {
        assert.equal(helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { host: HOST, referer: 'http://127.0.0.1:3100/page' } }), 'http://127.0.0.1:3100');
    });

    it('02.4 a configured {api@proj} token still resolves to that bundle\'s hostname (a single value, and in a list)', function () {
        assert.equal(helperFor(fakeSelf({ 'access-control-allow-origin': '{api@proj}' }))({ headers: { origin: OC, host: HOST } }), 'https://api.example');
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': OA + ', {api@proj}' }));
        assert.equal(f({ headers: { origin: 'https://api.example', host: HOST } }), 'https://api.example');
        assert.equal(f({ headers: { origin: OB, host: HOST } }), null);
    });

    it('02.5 an empty configured value echoes a plain origin', function () {
        assert.equal(helperFor(fakeSelf({ 'access-control-allow-origin': '' }))({ headers: { origin: OB, host: HOST } }), OB);
    });

    it('02.6 HTTP/2, no Origin: its :scheme and :authority make its origin', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': LIST }, { protocol: 'http/2.0', scheme: 'https', hostname: 'https://127.0.0.1:3100' }));
        assert.equal(f({ headers: { ':authority': HOST, ':scheme': 'https' } }), 'https://127.0.0.1:3100');
    });
});


describe('03 - #B1166 seeded fuzz: no Origin, Host or Referer makes the rule throw', function () {

    it('03.1 4,000 requests over five configurations and both protocols: no throw, a string or null each time', function () {
        var seed = 1166;
        var rnd = function () { // mulberry32
            seed |= 0; seed = seed + 0x6D2B79F5 | 0;
            var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
        var ALPHA = 'abcdnulxyzAZ0129:/.-_@{}()[]*+?^$|\\, \t';
        var str = function () { var n = Math.floor(rnd() * 20), s = ''; while (n--) { s += ALPHA[Math.floor(rnd() * ALPHA.length)]; } return s; };
        var pick = function (a) { return a[Math.floor(rnd() * a.length)]; };
        var CONFIGS = [LIST, 'https://one.example', '', OA + ', {api@proj}', undefined];
        var rules = {};
        var first = null, n = 0;
        for (var i = 0; i < 4000 && !first; i++) {
            var cfg = pick(CONFIGS), proto = pick(['http/1.1', 'http/2.0']);
            var key = String(cfg) + '|' + proto;
            if ( !rules[key] ) {
                var header = ( typeof(cfg) == 'undefined' ) ? { 'vary': 'Origin' } : { 'access-control-allow-origin': cfg };
                rules[key] = helperFor(fakeSelf(header, { protocol: proto }));
            }
            var h = {};
            if ( rnd() < 0.7 ) { h.origin = str(); }
            if ( rnd() < 0.8 ) { h.host = str(); }
            if ( rnd() < 0.4 ) { h.referer = str(); }
            if ( proto === 'http/2.0' && rnd() < 0.6 ) { h[':authority'] = str(); h[':scheme'] = pick(['http', 'https', str()]); }
            try {
                var v = rules[key]({ headers: h });
                if ( v !== null && typeof(v) != 'string' ) { first = { headers: h, config: cfg, protocol: proto, got: typeof(v) }; }
            } catch (e) {
                first = { headers: h, config: cfg, protocol: proto, threw: ( e && e.name ) + ': ' + ( e && e.message ) };
            }
            n++;
        }
        assert.equal(first, null, 'request ' + n + ': ' + JSON.stringify(first));
        assert.equal(n, 4000);
    });
});


describe('04 - the guards: a rule that still throws sends none and throws nothing', function () {
    var ARRAY_CFG = ['https://a.example', 'https://b.example']; // not a string: the rule still throws on it

    it('04.0 the instrument: with a configured value that is not a string, the lifted rule throws', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': ARRAY_CFG }));
        assert.throws(function () { f({ headers: { origin: OA, host: HOST } }); }, TypeError);
    });

    it('04.1 isaac\'s render-cache stamp: sets none, throws nothing (the arm 02.4 of the #B1104 file relocated)', function () {
        var res = fakeRes();
        assert.doesNotThrow(function () {
            stampFor(fakeSelf({ 'access-control-allow-origin': ARRAY_CFG }))({ headers: { origin: OA, host: HOST } }, res);
        });
        assert.deepEqual(res.h, {});
    });

    it('04.2 completeHeaders(): no Access-Control-Allow-Origin, the other configured headers sent, nothing thrown, the error logged once', function () {
        var res = fakeRes(), logged = [];
        var ch  = completeHeadersFor(fakeSelf({ 'access-control-allow-origin': ARRAY_CFG, 'vary': 'Origin' }), logged);
        assert.equal(outcome(function () { ch(null, fakeReq({ origin: OA, host: HOST }), res); return 'answered'; }), 'answered');
        assert.equal(res.h['access-control-allow-origin'], undefined);
        assert.equal(res.h['vary'], 'Origin');
        assert.equal(logged.length, 1);
        assert.ok(logged[0] instanceof TypeError, 'the logged error: ' + logged[0]);
    });

    it('04.3 completeHeaders(), a configured list and Origin: http://a(: no Access-Control-Allow-Origin, nothing thrown or logged', function () {
        var res = fakeRes(), logged = [];
        var ch  = completeHeadersFor(fakeSelf({ 'access-control-allow-origin': LIST, 'vary': 'Origin' }), logged);
        assert.equal(outcome(function () { ch(null, fakeReq({ origin: 'http://a(', host: HOST }), res); return 'answered'; }), 'answered');
        assert.equal(res.h['access-control-allow-origin'], undefined);
        assert.equal(res.h['vary'], 'Origin');
        assert.equal(logged.length, 0);
    });

    it('04.4 CONTROL completeHeaders(), a configured list and a listed origin: that origin', function () {
        var res = fakeRes();
        completeHeadersFor(fakeSelf({ 'access-control-allow-origin': LIST, 'vary': 'Origin' }))(null, fakeReq({ origin: OB, host: HOST }), res);
        assert.equal(res.h['access-control-allow-origin'], OB);
    });
});


describe('05 - source pins (whole-line comments stripped)', function () {
    var RULE = code(lift('var allowOriginFor = function(request) {'));
    var CH   = code(lift('var completeHeaders = function(responseHeaders, request, response) {'));

    it('05.1 the rule compiles one regular expression, the constant {…} token pattern, and none from the request', function () {
        var all = RULE.match(/new RegExp\([^\n]*/g) || [];
        assert.equal(all.length, 1, 'compiled patterns: ' + JSON.stringify(all));
        assert.ok(all[0].indexOf("new RegExp('\\{\\s*(.*)\\s*\\}', 'g')") === 0, 'the constant token pattern: ' + all[0]);
    });

    it('05.2 completeHeaders() calls the rule inside a try whose catch sends none', function () {
        assert.match(CH, /try \{\s*allowOrigin = allowOriginFor\(request\);\s*\} catch \(allowOriginErr\) \{\s*console\.error\(allowOriginErr\);\s*allowOrigin = null;\s*\}/);
    });

    it('05.3 #B1167 the token substitution runs on a configured value only', function () {
        assert.match(RULE, /var originHostReplacement = function\(name\) \{\s*if \( !isConfigured \) \{\s*return name\s*\}/);
        assert.match(RULE, /allowedOrigin = \( isConfigured \) \? conf\.server\.response\.header\['access-control-allow-origin'\] : authority;/);
    });
});
