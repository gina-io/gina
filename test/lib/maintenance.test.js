'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW          = require('../fw');
var MT_SRC      = path.join(FW, 'lib/maintenance/src/main.js');
var LIB_INDEX   = path.join(FW, 'lib/index.js');
var SERVER_SRC  = path.join(FW, 'core/server.js');
var ISAAC_SRC   = path.join(FW, 'core/server.isaac.js');
var GNA_SRC     = path.join(FW, 'core/gna.js');
var mt          = require(path.join(FW, 'lib/maintenance/src/main'));

// ─────────────────────────────────────────────────────────────────────────
// #MAINT1 — maintenance mode
// ─────────────────────────────────────────────────────────────────────────
//
// The gate answers 503 for every request EXCEPT /_gina/*, and sits above
// statics, the render/output cache and routing — coverage a route middleware
// structurally cannot reach, because middleware only runs once a route has
// matched (core/router.js processMiddlewares).
//
// The security-bearing part is the BYPASS. Its whole point is being
// topology-independent: an IP allowlist is meaningless behind a reverse proxy
// (every socket address is the proxy's), so `allowFrom` is honoured ONLY for
// requests that do not classify as proxied, and `bypassKey` — a constant-time
// compare plus a stateless HMAC cookie — is the bypass that works either way.
//
// §05 is the load-bearing suite: it proves the IP arm CAN succeed (direct)
// before proving it correctly refuses (proxied). Without that positive control
// the negative assertions would pass just as happily against a bypass that was
// broken outright.

var KEY = 'a-good-long-key-0123456789';
var NOW = 1700000000000;

/**
 * The `_mtStatus` builder's body on one engine, sliced STRUCTURALLY — from the
 * builder's opening line to its closing `};` — never by a fixed byte count. A
 * byte window silently stops covering the payload's tail when anything above
 * it grows (measured 2026-09-20: the `source` expression gained 40 chars and a
 * 1500-char window lost `hasBypassKey`), and a miss of either anchor must fail
 * by name rather than slice to end-of-file.
 */
function mtStatusBody(src, label) {
    var at = src.indexOf('var _mtStatus = function()');
    assert.ok(at > -1, label + ' must build the status payload in _mtStatus');
    var end = src.indexOf('\n                };', at);
    assert.ok(end > -1, label + ' the _mtStatus builder must close with `};` at its own indentation');
    return src.slice(at, end);
}

/** Build a minimal request object. */
function req(opts) {
    opts = opts || {};
    return {
        url     : opts.url || '/',
        method  : opts.method || 'GET',
        headers : opts.headers || {},
        socket  : opts.socket || {}
    };
}

describe('01 - lib/maintenance structure + registry wiring', function () {
    var src = fs.readFileSync(MT_SRC, 'utf8');

    it('exports the full documented surface', function () {
        [
            'resolveConf', 'lintConf', 'isActive', 'effectiveConf',
            'langTag', 'negotiate', 'buildBody', 'responseHeaders',
            'isSecureRequest', 'isProxiedRequest', 'readCookie',
            'mintBypassCookie', 'verifyBypassCookie', 'readPresentedKey',
            'stripKeyParam', 'evaluateBypass', 'buildBypassCookieHeader'
        ].forEach(function (fn) {
            assert.equal(typeof mt[fn], 'function', fn + ' must be exported as a function');
        });
    });

    it('is registered as a PLAIN require in lib/index.js (security primitive, not hot-reloaded)', function () {
        var idx = fs.readFileSync(LIB_INDEX, 'utf8');
        assert.ok(
            /maintenance\s*:\s*require\('\.\/maintenance'\)/.test(idx),
            'lib/index.js must register maintenance with a plain require, NOT _require'
        );
    });

    it('is declared on GinaLib in types/index.d.ts (the two-way parity gate)', function () {
        var types = fs.readFileSync(path.join(FW, '../../types/index.d.ts'), 'utf8');
        assert.ok(/^\s*maintenance:\s*any;/m.test(types), 'GinaLib must declare `maintenance`');
    });

    it('imports nothing from the framework — only node crypto', function () {
        var requires = src.match(/require\((['"])([^'"]+)\1\)/g) || [];
        assert.deepEqual(requires, ["require('crypto')"],
            'the lib must stay framework-independent so every branch is testable without a bundle');
    });

    it('uses timingSafeEqual for every secret comparison', function () {
        assert.ok(src.indexOf('crypto.timingSafeEqual') > -1, 'must compare secrets in constant time');
    });
});

describe('02 - resolveConf: per-key fallback, never all-or-nothing', function () {
    it('a null/absent block yields every default, feature off', function () {
        var c = mt.resolveConf(null);
        assert.equal(c.enabled, false);
        assert.equal(c.retryAfter, 300);
        assert.equal(c.message, 'Service Unavailable');
        assert.equal(c.bypassKey, '');
        assert.deepEqual(c.allowFrom, []);
    });

    it('only a STRICT boolean true enables it', function () {
        assert.equal(mt.resolveConf({ enabled: true }).enabled, true);
        ['true', 1, 'yes', {}, [], null].forEach(function (v) {
            assert.equal(mt.resolveConf({ enabled: v }).enabled, false, JSON.stringify(v) + ' must not enable');
        });
    });

    it('a bad retryAfter falls back WITHOUT disabling the feature', function () {
        var c = mt.resolveConf({ enabled: true, retryAfter: 0 });
        assert.equal(c.retryAfter, 300, 'falls back to the default');
        assert.equal(c.enabled, true, 'and the feature stays ON — a bad knob must not silently re-open the site');
    });

    it('retryAfter accepts only integers within 1..86400', function () {
        assert.equal(mt.resolveConf({ retryAfter: 1 }).retryAfter, 1);
        assert.equal(mt.resolveConf({ retryAfter: 86400 }).retryAfter, 86400);
        assert.equal(mt.resolveConf({ retryAfter: 86401 }).retryAfter, 300);
        assert.equal(mt.resolveConf({ retryAfter: 1.5 }).retryAfter, 300);
        assert.equal(mt.resolveConf({ retryAfter: '60' }).retryAfter, 300);
    });

    it('allowFrom keeps only non-empty strings', function () {
        assert.deepEqual(mt.resolveConf({ allowFrom: ['1.2.3.4', '', 5, null, '::1'] }).allowFrom, ['1.2.3.4', '::1']);
        assert.deepEqual(mt.resolveConf({ allowFrom: 'nope' }).allowFrom, []);
    });
});

describe('03 - lintConf: explains every silent fallback, never fatal', function () {
    it('an absent block is valid', function () {
        assert.deepEqual(mt.lintConf(undefined), []);
        assert.deepEqual(mt.lintConf(null), []);
    });

    it('a non-object block warns once and stops', function () {
        assert.equal(mt.lintConf('on').length, 1);
        assert.equal(mt.lintConf([]).length, 1);
    });

    it('warns on a non-strict-boolean enabled', function () {
        assert.match(mt.lintConf({ enabled: 'true' })[0], /strict boolean/);
    });

    it('warns on an out-of-range retryAfter, naming the default', function () {
        assert.match(mt.lintConf({ retryAfter: 99999 })[0], /1 and 86400.*300/);
    });

    it('warns when a short bypassKey is configured', function () {
        assert.match(mt.lintConf({ bypassKey: 'short' })[0], /shorter than 16/);
    });

    it('warns when maintenance is enabled with NO bypass key — the lockout footgun', function () {
        var w = mt.lintConf({ enabled: true }).join(' ');
        assert.match(w, /nobody can bypass/);
    });

    it('a fully valid block produces no warnings', function () {
        assert.deepEqual(
            mt.lintConf({ enabled: true, retryAfter: 60, message: 'back soon', bypassKey: KEY }),
            []
        );
    });

    it('a non-empty allowFrom always earns the shared-egress advisory', function () {
        var w = mt.lintConf({ enabled: true, bypassKey: KEY, allowFrom: ['203.0.113.4'] });
        assert.equal(w.length, 1);
        assert.match(w[0], /never list a proxy\/load-balancer\/NAT address/);
    });

    it('a LOOPBACK allowFrom entry earns the sharper same-host-proxy warning', function () {
        // The nginx-in-front deployment makes every visitor arrive from 127.0.0.1,
        // so loopback — the value operators copy from admin.allowFrom — is the
        // riskiest entry on THIS axis, not the safest.
        ['127.0.0.1', '::1'].forEach(function (ip) {
            var w = mt.lintConf({ enabled: true, bypassKey: KEY, allowFrom: [ip] }).join(' ');
            assert.match(w, /LOOPBACK address/);
            assert.match(w, /NOT a safe default/);
        });
        // control: a non-loopback entry must NOT carry the sharper clause
        var w2 = mt.lintConf({ enabled: true, bypassKey: KEY, allowFrom: ['203.0.113.4'] }).join(' ');
        assert.ok(w2.indexOf('LOOPBACK address') < 0, 'the sharper clause must be loopback-specific');
    });
});

describe('04 - isActive / effectiveConf: runtime override + dead-man switch', function () {
    it('follows config when there is no runtime override', function () {
        assert.equal(mt.isActive({ conf: { enabled: false }, runtime: null }), false);
        assert.equal(mt.isActive({ conf: { enabled: true }, runtime: null }), true);
    });

    it('a live runtime override wins in BOTH directions', function () {
        assert.equal(mt.isActive({ conf: { enabled: false }, runtime: { active: true } }), true);
        assert.equal(mt.isActive({ conf: { enabled: true }, runtime: { active: false } }), false);
    });

    it('an EXPIRED ttl reverts to CONFIG, never to "off"', function () {
        // The safe direction: a forgotten timer must not re-open a site that
        // settings.json says is closed.
        assert.equal(mt.isActive({ conf: { enabled: true }, runtime: { active: false, until: 100 } }, 200), true);
        assert.equal(mt.isActive({ conf: { enabled: false }, runtime: { active: true, until: 100 } }, 200), false);
    });

    it('a live ttl is still honoured', function () {
        assert.equal(mt.isActive({ conf: { enabled: false }, runtime: { active: true, until: 100 } }, 50), true);
    });

    it('effectiveConf applies live runtime message/retryAfter and drops them on expiry', function () {
        var state = { conf: mt.resolveConf({ message: 'cfg', retryAfter: 300 }), runtime: { active: true, message: 'rt', retryAfter: 60, until: 100 } };
        assert.equal(mt.effectiveConf(state, 50).message, 'rt');
        assert.equal(mt.effectiveConf(state, 50).retryAfter, 60);
        assert.equal(mt.effectiveConf(state, 200).message, 'cfg');
        assert.equal(mt.effectiveConf(state, 200).retryAfter, 300);
    });

    it('a malformed state is inert', function () {
        assert.equal(mt.isActive(null), false);
        assert.equal(mt.isActive({}), false);
    });
});

describe('05 - bypass: the IP arm is proxy-aware (POSITIVE CONTROL FIRST)', function () {
    var conf = mt.resolveConf({ enabled: true, bypassKey: KEY, allowFrom: ['203.0.113.4'] });

    // ── positive control ──────────────────────────────────────────────────
    // These MUST pass, or every negative assertion below is vacuous: a bypass
    // that never admits anyone would satisfy the proxied-refusal tests too.
    it('CONTROL: a listed IP on a DIRECT request is admitted', function () {
        var v = mt.evaluateBypass(req({ headers: { host: 'ex.com:8080' }, socket: { remoteAddress: '203.0.113.4' } }), conf, NOW);
        assert.equal(v.allowed, true);
        assert.equal(v.reason, 'ip');
    });

    it('CONTROL: ::ffff: IPv4-mapped form matches the same entry', function () {
        var v = mt.evaluateBypass(req({ headers: { host: 'ex.com:8080' }, socket: { remoteAddress: '::ffff:203.0.113.4' } }), conf, NOW);
        assert.equal(v.reason, 'ip');
    });

    it('CONTROL: an unlisted IP on a direct request is refused', function () {
        var v = mt.evaluateBypass(req({ headers: { host: 'ex.com:8080' }, socket: { remoteAddress: '198.51.100.9' } }), conf, NOW);
        assert.equal(v.allowed, false);
    });

    // ── the fix ───────────────────────────────────────────────────────────
    it('THE FIX: the SAME listed IP is refused when the request is proxied (port-less Host)', function () {
        var v = mt.evaluateBypass(req({ headers: { host: 'ex.com' }, socket: { remoteAddress: '203.0.113.4' } }), conf, NOW);
        assert.equal(v.allowed, false,
            'behind a proxy every socket address is the proxy\'s — honouring the list would admit the whole internet');
    });

    it('THE FIX: refused when proxied via X-Forwarded-Host', function () {
        var v = mt.evaluateBypass(req({ headers: { host: 'ex.com:8080', 'x-forwarded-host': 'ex.com' }, socket: { remoteAddress: '203.0.113.4' } }), conf, NOW);
        assert.equal(v.allowed, false);
    });

    it('the #B65 stamp may ADD proxy evidence but can never VETO it', function () {
        // Hardened 2026-08-16 (adversarial review). The stamp is derived from the
        // same client-supplied Host heuristic, so treating `false` as authoritative
        // inherited its spoofability.
        var r = req({ headers: { host: 'ex.com' }, socket: { remoteAddress: '203.0.113.4' } });
        r._ginaIsProxyHost = false;          // stamp says direct; the heuristic says proxied
        assert.equal(mt.evaluateBypass(r, conf, NOW).allowed, false, 'a false stamp must not re-open the IP arm');

        var r2 = req({ headers: { host: 'ex.com:8080' }, socket: { remoteAddress: '203.0.113.4' } });
        r2._ginaIsProxyHost = true;          // stamp says proxied; heuristic would say direct
        assert.equal(mt.evaluateBypass(r2, conf, NOW).allowed, false, 'a true stamp must close the IP arm');
    });

    it('ANY x-forwarded-* header (or RFC 7239 Forwarded) closes the IP arm', function () {
        // The vector that WAS exploitable: a spoofed Host with a port read as
        // "direct" and re-opened the allowlist behind a proxy.
        [
            { host: 'a.com:1', 'x-forwarded-proto': 'https' },
            { host: 'a.com:1', 'x-forwarded-for': '1.2.3.4' },
            { host: 'a.com:1', 'X-Forwarded-For': '1.2.3.4' },   // case-insensitive
            { host: 'a.com:1', 'x-forwarded-prefix': '/app' },
            { host: 'a.com:1', forwarded: 'for=1.2.3.4' }
        ].forEach(function (h) {
            var v = mt.evaluateBypass(req({ headers: h, socket: { remoteAddress: '203.0.113.4' } }), conf, NOW);
            assert.equal(v.allowed, false, 'proxy signal ' + Object.keys(h).join(',') + ' must close the IP arm');
        });
    });

    it('a malformed request fails CLOSED (classified proxied)', function () {
        assert.equal(mt.isProxiedRequest(null), true);
        assert.equal(mt.isProxiedRequest(undefined), true);
    });

    it('KNOWN RESIDUAL, pinned deliberately: a signal-less host:port still reaches the IP arm', function () {
        // This is NOT a fix gap that can be closed by classification — a proxy
        // forwarding Host verbatim while stripping every x-forwarded-* header is
        // byte-identical to a direct client. It is the generic IP-allowlist
        // property (app.json > admin.allowFrom behaves the same), mitigated by
        // the boot warning in lintConf and by the docs. Pinned so a future
        // change that alters this behaviour is a DELIBERATE decision.
        var v = mt.evaluateBypass(req({ headers: { host: 'app.internal:8080' }, socket: { remoteAddress: '203.0.113.4' } }), conf, NOW);
        assert.equal(v.reason, 'ip', 'a genuinely direct client must still be admitted');
    });

    it('requireForwardedHeaders (#B152) disables the port-less heuristic', function () {
        var v = mt.evaluateBypass(req({ headers: { host: 'ex.com' }, socket: { remoteAddress: '203.0.113.4' } }), conf, NOW, true);
        assert.equal(v.reason, 'ip', 'with the heuristic off, a port-less Host no longer reads as proxied');
    });
});

describe('06 - bypass: the key arm is topology-independent', function () {
    var conf = mt.resolveConf({ enabled: true, bypassKey: KEY });

    it('a header key works on a DIRECT request', function () {
        var v = mt.evaluateBypass(req({ headers: { host: 'ex.com:8080', 'x-gina-maintenance-key': KEY } }), conf, NOW);
        assert.equal(v.reason, 'header');
    });

    it('the same header key works on a PROXIED request — the point of the whole design', function () {
        var v = mt.evaluateBypass(req({ headers: { host: 'ex.com', 'x-gina-maintenance-key': KEY } }), conf, NOW);
        assert.equal(v.reason, 'header');
    });

    it('a wrong key is reported distinctly (so the call site can log a probe)', function () {
        var v = mt.evaluateBypass(req({ headers: { host: 'ex.com', 'x-gina-maintenance-key': 'nope' } }), conf, NOW);
        assert.equal(v.allowed, false);
        assert.equal(v.reason, 'invalid-key');
    });

    it('fails CLOSED when no key is configured — a presented key cannot conjure access', function () {
        var noKey = mt.resolveConf({ enabled: true });
        var v = mt.evaluateBypass(req({ headers: { 'x-gina-maintenance-key': KEY } }), noKey, NOW);
        assert.equal(v.allowed, false);
    });

    it('a near-miss of differing length does not throw (timingSafeEqual length guard)', function () {
        assert.doesNotThrow(function () {
            mt.evaluateBypass(req({ headers: { 'x-gina-maintenance-key': KEY + 'x' } }), conf, NOW);
        });
    });
});

describe('07 - bypass: the query grant + stateless cookie round trip', function () {
    var conf = mt.resolveConf({ enabled: true, bypassKey: KEY });

    it('a valid ?gina-maintenance-key grants, mints a cookie and redirects', function () {
        var v = mt.evaluateBypass(req({ url: '/dash?gina-maintenance-key=' + KEY + '&page=2', headers: { host: 'ex.com' } }), conf, NOW);
        assert.equal(v.allowed, true);
        assert.equal(v.grant, true);
        assert.equal(v.redirectTo, '/dash?page=2', 'the secret is stripped, everything else preserved');
        assert.ok(v.cookie.length > 0);
    });

    it('the redirect target is PATH-ONLY — never rebuilt from Host or X-Forwarded-* (#B367)', function () {
        var v = mt.evaluateBypass(req({
            url: '/dash?gina-maintenance-key=' + KEY,
            headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' }
        }), conf, NOW);
        assert.equal(v.redirectTo, '/dash');
        assert.ok(v.redirectTo.indexOf('evil.example') < 0, 'an attacker-controlled host must never reach the Location');
    });

    it('OPEN-REDIRECT corpus: a hostile request URL can never produce an off-site Location', function () {
        // ⚠️ The predecessor of this test asserted `!/^https?:\/\//` while feeding
        // a BENIGN url — a control that could not fail. It passed while
        // stripKeyParam returned `//evil.com/x` verbatim. Feed the hostile corpus.
        [
            '//evil.com/x',            // protocol-relative
            '/\\/evil.com',            // backslash-folded protocol-relative
            '/\\evil.com',             // single backslash
            'https://evil.com/x',      // absolute
            'http://evil.com/x',
            'javascript:alert(1)',     // scheme, non-http
            '////evil.com'
        ].forEach(function (hostile) {
            var v = mt.evaluateBypass(req({
                url: hostile + '?gina-maintenance-key=' + KEY,
                headers: { host: 'ok.example' }
            }), conf, NOW);
            assert.equal(v.redirectTo, '/', JSON.stringify(hostile) + ' must collapse to "/"');
        });
    });

    it('CONTROL for the corpus above: benign URLs survive intact', function () {
        // Without this, a stripKeyParam that returned "/" unconditionally would
        // pass every assertion in the corpus test.
        [
            ['/dash?gina-maintenance-key=' + KEY, '/dash'],
            ['/dash?gina-maintenance-key=' + KEY + '&page=2', '/dash?page=2'],
            ['/a/b/c?gina-maintenance-key=' + KEY, '/a/b/c']
        ].forEach(function (pair) {
            var v = mt.evaluateBypass(req({ url: pair[0], headers: { host: 'ok.example' } }), conf, NOW);
            assert.equal(v.redirectTo, pair[1]);
        });
    });

    it('the minted cookie is accepted on the next request, with no server state', function () {
        var g = mt.evaluateBypass(req({ url: '/dash?gina-maintenance-key=' + KEY, headers: { host: 'ex.com' } }), conf, NOW);
        var v = mt.evaluateBypass(req({ url: '/dash', headers: { host: 'ex.com', cookie: 'a=1; ' + mt.BYPASS_COOKIE + '=' + g.cookie } }), conf, NOW);
        assert.equal(v.reason, 'cookie');
        assert.equal(v.grant, false, 'an existing cookie must not re-issue itself');
    });

    it('the cookie expires', function () {
        var c = mt.mintBypassCookie(KEY, NOW);
        assert.equal(mt.verifyBypassCookie(c, KEY, NOW), true);
        assert.equal(mt.verifyBypassCookie(c, KEY, NOW + mt.BYPASS_TTL_MS + 1000), false);
    });

    it('rotating the key revokes every outstanding cookie', function () {
        var c = mt.mintBypassCookie(KEY, NOW);
        assert.equal(mt.verifyBypassCookie(c, 'a-different-key-987654321', NOW), false);
    });

    it('a forged / tampered cookie is refused', function () {
        var c = mt.mintBypassCookie(KEY, NOW);
        var exp = c.split('.')[0];
        assert.equal(mt.verifyBypassCookie(exp + '.' + 'f'.repeat(64), KEY, NOW), false, 'wrong MAC');
        assert.equal(mt.verifyBypassCookie('9999999999.' + c.split('.')[1], KEY, NOW), false, 'expiry extended without re-MAC');
        ['', 'garbage', '.', 'abc.def', '123', '.abc', '123.'].forEach(function (bad) {
            assert.equal(mt.verifyBypassCookie(bad, KEY, NOW), false, JSON.stringify(bad) + ' must be refused');
        });
        // Canonical encoding only — a leading zero used to verify, because the
        // MAC is computed over the PARSED integer (measured 2026-08-16).
        assert.equal(mt.verifyBypassCookie('0' + exp + '.' + c.split('.')[1], KEY, NOW), false,
            'a non-canonical (zero-padded) expiry must not carry a valid signature');
    });

    it('the Set-Cookie header carries the hardening attributes', function () {
        var h = mt.buildBypassCookieHeader('v', true);
        assert.match(h, /^gina\.maintenance=v;/);
        assert.match(h, /HttpOnly/);
        assert.match(h, /SameSite=Lax/);
        assert.match(h, /Path=\//);
        assert.match(h, /Secure/);
        assert.ok(mt.buildBypassCookieHeader('v', false).indexOf('Secure') < 0, 'no Secure on a cleartext hop');
    });
});

describe('08 - the 503 body', function () {
    it('negotiates JSON for XHR, SPA fragments and json-only Accept', function () {
        assert.equal(mt.negotiate(req({ headers: { 'x-requested-with': 'XMLHttpRequest' } })), 'json');
        assert.equal(mt.negotiate(req({ headers: { 'x-gina-navigate': 'fragment' } })), 'json');
        assert.equal(mt.negotiate(req({ headers: { accept: 'application/json' } })), 'json');
    });

    it('negotiates HTML for a browser navigation', function () {
        assert.equal(mt.negotiate(req({ headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.9' } })), 'html');
        assert.equal(mt.negotiate(req({ headers: {} })), 'html');
    });

    it('the JSON body matches the shipped 503.json shape', function () {
        var b = JSON.parse(mt.buildBody({ message: 'Back at 14:00 UTC' }, 'json').body);
        assert.equal(b.error.code, '503');
        assert.equal(b.error.message, 'GNA:GLOBAL:ERR:503');
        assert.equal(b.error.explicit, 'Back at 14:00 UTC');
    });

    it('the HTML body is a conforming document (#A11Y3: doctype, lang, title)', function () {
        var h = mt.buildBody({ message: 'Back soon' }, 'html', 'fr-CA').body;
        assert.ok(h.indexOf('<!doctype html>') === 0);
        assert.ok(h.indexOf('<html lang="fr-CA">') > -1);
        assert.match(h, /<title>[^<]+<\/title>/);
    });

    it('the HTML body is SELF-CONTAINED — the gate blocks the assets it could reference', function () {
        var h = mt.buildBody({ message: 'x' }, 'html').body;
        assert.ok(!/\ssrc=/.test(h), 'no external script/image');
        assert.ok(!/\shref=/.test(h), 'no external stylesheet/link');
    });

    it('escapes the operator message (defence in depth, #B367 lesson)', function () {
        var h = mt.buildBody({ message: '<script>alert(1)</script>' }, 'html').body;
        assert.ok(h.indexOf('<script>alert(1)</script>') < 0, 'the raw tag must not survive');
        assert.ok(h.indexOf('&lt;script&gt;') > -1);
    });

    it('always emits Retry-After and no-store', function () {
        var h = mt.responseHeaders({ retryAfter: 42 }, 'text/html; charset=utf8');
        assert.equal(h['retry-after'], '42');
        assert.equal(h['cache-control'], 'no-store',
            'a cached 503 would outlive the window and keep the site closed after it reopened');
    });

    it('langTag normalises culture and Accept-Language forms', function () {
        assert.equal(mt.langTag('en_CM'), 'en-CM');
        assert.equal(mt.langTag('fr;q=0.9,en'), 'fr');
        assert.equal(mt.langTag('!!!'), 'en');
        assert.equal(mt.langTag(undefined), 'en');
    });

    it('isSecureRequest reads the socket, :scheme and x-forwarded-proto', function () {
        assert.equal(mt.isSecureRequest({ socket: { encrypted: true }, headers: {} }), true);
        assert.equal(mt.isSecureRequest({ headers: { ':scheme': 'https' } }), true);
        assert.equal(mt.isSecureRequest({ headers: { 'x-forwarded-proto': 'https,http' } }), true);
        assert.equal(mt.isSecureRequest({ headers: { 'x-forwarded-proto': 'http' } }), false);
        assert.equal(mt.isSecureRequest({ headers: {} }), false);
    });
});

describe('09 - engine wiring: both engines, and the gate is placed correctly', function () {
    var server = fs.readFileSync(SERVER_SRC, 'utf8');
    var isaac  = fs.readFileSync(ISAAC_SRC, 'utf8');

    it('BOTH engines carry the gate (the /_gina/* endpoint-sync rule)', function () {
        assert.ok(server.indexOf('#MAINT1 — maintenance gate') > -1, 'core/server.js must carry the gate');
        assert.ok(isaac.indexOf('#MAINT1 — maintenance gate') > -1, 'core/server.isaac.js must carry the twin');
    });

    it('BOTH engines expose /_gina/maintenance', function () {
        assert.ok(/\/_gina\\\/maintenance/.test(server) || server.indexOf('/_gina/maintenance') > -1);
        assert.ok(isaac.indexOf('/_gina/maintenance') > -1);
    });

    it('server.js: the gate sits AFTER the /_gina handlers and BEFORE statics', function () {
        var health  = server.indexOf('/_gina/health/check — liveness probe');
        var gate    = server.indexOf('#MAINT1 — maintenance gate');
        var statics = server.indexOf('priority to statics');
        assert.ok(health > -1 && gate > -1 && statics > -1, 'all three anchors must exist');
        assert.ok(gate > health,  'liveness must answer 200 during maintenance — an orchestrator must not restart pods');
        assert.ok(gate < statics, 'the gate MUST precede static serving, or assets keep serving 200 while the site is "closed"');
    });

    it('isaac: the gate sits BEFORE the pre-routing render-cache read', function () {
        var gate  = isaac.indexOf('#MAINT1 — maintenance gate');
        var cache = isaac.indexOf("if (!isCacheless || String(server._cacheIsEnabled)");
        assert.ok(gate > -1 && cache > -1);
        assert.ok(gate < cache, 'a cache serve point above the gate would replay cached pages during maintenance (#B158 shape)');
    });

    it('both engines declare the toggle ABOVE the gate, so the off switch stays reachable', function () {
        assert.ok(server.indexOf('/_gina/maintenance — maintenance-mode control') < server.indexOf('#MAINT1 — maintenance gate'));
        assert.ok(isaac.indexOf('/_gina/maintenance — maintenance-mode control') < isaac.indexOf('#MAINT1 — maintenance gate'));
    });

    it('the toggle is admin-gated on both engines', function () {
        [['server.js', server], ['server.isaac.js', isaac]].forEach(function (pair) {
            var at  = pair[1].indexOf('/_gina/maintenance — maintenance-mode control');
            var seg = pair[1].slice(at, at + 4000);
            assert.ok(seg.indexOf('lib.admin.isClientAllowed') > -1, pair[0] + ' must admin-gate the toggle');
        });
    });

    it('the status payload names the process that answered: pid + hostname, on both engines', function () {
        // The override is per process — it lives on engine.instance._maintenance and
        // is never written or broadcast — so an operator fanning the POST out over
        // replicas needs to read back WHICH process applied it. Pin both fields on
        // both engines inside the _mtStatus builder; the hasBypassKey check proves
        // the slice reaches the end of the payload rather than passing on a stub.
        [['server.js', server], ['server.isaac.js', isaac]].forEach(function (pair) {
            var seg = mtStatusBody(pair[1], pair[0]);
            assert.ok(/pid\s*:\s*process\.pid/.test(seg),          pair[0] + ' payload must carry pid');
            assert.ok(/hostname\s*:\s*os\.hostname\(\)/.test(seg), pair[0] + ' payload must carry hostname');
            assert.ok(seg.indexOf('hasBypassKey') > -1,           pair[0] + ' the slice must reach the end of the payload');
        });
    });

    it('server.js boot-resolves the state onto the engine instance (one server = one bundle)', function () {
        assert.ok(server.indexOf('engine.instance._maintenance') > -1);
        assert.ok(server.indexOf('lib.maintenance.resolveConf') > -1);
    });

    it('gna.js lints the block warn-only, never fatally', function () {
        var gna = fs.readFileSync(GNA_SRC, 'utf8');
        var at  = gna.indexOf('#MAINT1 — `server.maintenance` boot-time shape check');
        assert.ok(at > -1, 'gna.js must carry the boot lint');
        var seg = gna.slice(at, at + 1600);
        assert.ok(seg.indexOf('lib.maintenance.lintConf') > -1);
        assert.ok(seg.indexOf('console.warn') > -1);
        assert.ok(seg.indexOf('callback(new Error') < 0, 'a malformed block must never refuse a boot');
    });

    it('neither engine logs a presented bypass key (#B365)', function () {
        [['server.js', server], ['server.isaac.js', isaac]].forEach(function (pair) {
            var at  = pair[1].indexOf('#MAINT1 — maintenance gate');
            var seg = pair[1].slice(at, at + 5000);
            assert.ok(
                !/console\.(warn|log|info|error)\([^)]*_mtVerdict\.(value|key)/.test(seg),
                pair[0] + ' must never log the presented key value'
            );
        });
    });
});

describe('10 - the schema declares the block', function () {
    it('settings.json schema carries server.maintenance with all five keys', function () {
        var schema = JSON.parse(fs.readFileSync(path.join(FW, '../../schema/settings.json'), 'utf8'));
        var m = schema.properties.server.properties.maintenance;
        assert.ok(m, 'server.maintenance must be declared');
        assert.equal(m.additionalProperties, false);
        assert.deepEqual(
            Object.keys(m.properties).sort(),
            ['allowFrom', 'bypassKey', 'enabled', 'message', 'retryAfter']
        );
        assert.equal(m.properties.retryAfter.default, 300);
        assert.match(m.properties.allowFrom.description, /NOT classify as proxied/i);
    });
});


describe('11 - GINA_MAINTENANCE boot env: resolveBootEnv + the engine read (C3 slice b)', function () {
    var server = fs.readFileSync(SERVER_SRC, 'utf8');
    var isaac  = fs.readFileSync(ISAAC_SRC, 'utf8');

    it('is exported', function () {
        assert.equal(typeof mt.resolveBootEnv, 'function');
    });

    it('`1` and `true` force maintenance ON, case-insensitively and trimmed', function () {
        ['1', 'true', 'TRUE', 'True', ' 1 ', '\ttrue\n'].forEach(function (v) {
            var r = mt.resolveBootEnv(v);
            assert.equal(r.forced, true, JSON.stringify(v) + ' must force');
            assert.equal(r.explicitOff, false);
            assert.equal(r.warning, null, JSON.stringify(v) + ' must not warn');
        });
    });

    it('unset / null / empty do nothing and do not warn', function () {
        [undefined, null, '', '   '].forEach(function (v) {
            var r = mt.resolveBootEnv(v);
            assert.equal(r.forced, false);
            assert.equal(r.explicitOff, false);
            assert.equal(r.warning, null);
        });
    });

    it('`0` / `false` are explicit-off: accepted silently, never a force', function () {
        ['0', 'false', 'FALSE', ' false '].forEach(function (v) {
            var r = mt.resolveBootEnv(v);
            assert.equal(r.forced, false);
            assert.equal(r.explicitOff, true);
            assert.equal(r.warning, null);
        });
    });

    it('any other value is IGNORED with a warning naming the accepted values (the lint contract: never silent, never fatal)', function () {
        ['yes', 'on', '2', 'enabled', 'maintenance'].forEach(function (v) {
            var r = mt.resolveBootEnv(v);
            assert.equal(r.forced, false);
            assert.equal(r.explicitOff, false);
            assert.equal(typeof r.warning, 'string');
            assert.ok(r.warning.indexOf(JSON.stringify(v)) > -1, 'the warning must quote the offending value');
            assert.ok(r.warning.indexOf('`1`') > -1 && r.warning.indexOf('`true`') > -1, 'the warning must name the accepted values');
        });
    });

    it('CLOSE-ONLY: an explicit-off result folded into an enabled config leaves the site closed', function () {
        // the engine folds `forced` into conf.enabled and nothing else — so an
        // explicit-off result must never be able to open a site settings.json closed
        var conf = mt.resolveConf({ enabled: true });
        var r = mt.resolveBootEnv('false');
        if ( r.forced ) { conf.enabled = true; }
        assert.equal(conf.enabled, true);
        assert.equal(mt.isActive({ conf: conf, runtime: null }), true);
    });

    it('a forced result composes with the runtime toggle: POST {enable:false} still wins', function () {
        var conf = mt.resolveConf({ enabled: false });
        var r = mt.resolveBootEnv('1');
        if ( r.forced ) { conf.enabled = true; }
        assert.equal(mt.isActive({ conf: conf, runtime: null }), true);
        assert.equal(mt.isActive({ conf: conf, runtime: { active: false } }), false, 'the runtime override must still reopen the process');
    });

    it('server.js reads GINA_MAINTENANCE through resolveBootEnv inside the boot-resolve block, on BOTH transports', function () {
        var at = server.indexOf('#MAINT1 — maintenance mode: boot-resolve');
        assert.ok(at > -1, 'the boot-resolve anchor must exist');
        var end = server.indexOf('#RWATCH — stale built-release watch', at);
        assert.ok(end > -1, 'the end anchor (the next boot block) must exist');
        var seg = server.slice(at, end);
        assert.ok(seg.indexOf('lib.maintenance.resolveBootEnv(') > -1, 'must resolve through lib.maintenance.resolveBootEnv');
        assert.ok(/getEnvVar\(\s*'GINA_MAINTENANCE'\s*\)/.test(seg), 'must read the daemon transport (process.gina via getEnvVar)');
        assert.ok(seg.indexOf('process.env.GINA_MAINTENANCE') > -1, 'must read the launcher transport (process.env, #B570)');
        assert.ok(/conf\.enabled\s*=\s*true/.test(seg), 'a forced result must fold into the CONFIG layer');
        assert.ok(seg.indexOf('envForced') > -1, 'must stamp envForced for the status payload');
    });

    it('BOTH _mtStatus builders report source "env" for an env-forced closure with no live override', function () {
        [['server.js', server], ['server.isaac.js', isaac]].forEach(function (pair) {
            var seg = mtStatusBody(pair[1], pair[0]);
            assert.ok(
                /source\s*:\s*_rtLive\s*\?\s*'runtime'\s*:\s*\(\s*_mtCtl\.envForced\s*===\s*true\s*\?\s*'env'\s*:\s*'config'\s*\)/.test(seg),
                pair[0] + ' source must resolve runtime > env > config'
            );
        });
    });
});
