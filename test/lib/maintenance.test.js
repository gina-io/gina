'use strict';

var { describe, it, beforeEach, afterEach, mock } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW          = require('../fw');
var MT_SRC      = process.env.GINA_MAINTENANCE_SRC || path.join(FW, 'lib/maintenance/src/main.js');
var LIB_INDEX   = path.join(FW, 'lib/index.js');
var SERVER_SRC  = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');         // red-first seam (the #B498 harness names)
var ISAAC_SRC   = process.env.GINA_ISAAC_SRC  || path.join(FW, 'core/server.isaac.js');
var GNA_SRC     = process.env.GINA_GNA_SRC    || path.join(FW, 'core/gna.js');
// Red-first seam: GINA_MAINTENANCE_SRC points BOTH the pins and the behavioural
// arms at a pre-change extract (`git show <sha>:<path> > /tmp/pre.js`) — the module is
// crypto-only, so a copy anywhere is faithful (measurement-traps § scratchpad copy of HEAD).
var MT_MAIN     = process.env.GINA_MAINTENANCE_SRC || path.join(FW, 'lib/maintenance/src/main.js');
var mt          = require(MT_MAIN);

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
    it('settings.json schema carries server.maintenance with all seven keys', function () {
        var schema = JSON.parse(fs.readFileSync(path.join(FW, '../../schema/settings.json'), 'utf8'));
        var m = schema.properties.server.properties.maintenance;
        assert.ok(m, 'server.maintenance must be declared');
        assert.equal(m.additionalProperties, false);
        assert.deepEqual(
            Object.keys(m.properties).sort(),
            ['allowFrom', 'bypassKey', 'enabled', 'message', 'pollInterval', 'retryAfter', 'store']
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


describe('12 - replica sync conf: resolveConf / lintConf gain `store` + `pollInterval` (C3 slice c)', function () {
    it('defaults: no store, pollInterval 2000', function () {
        var c = mt.resolveConf(null);
        assert.equal(c.store, '');
        assert.equal(c.pollInterval, 2000);
        assert.equal(mt.DEFAULTS.pollInterval, 2000);
    });

    it('store must be a non-empty string; anything else falls back to no sync', function () {
        assert.equal(mt.resolveConf({ store: 'maint' }).store, 'maint');
        [ '', 7, true, null, {} ].forEach(function (v) {
            assert.equal(mt.resolveConf({ store: v }).store, '', JSON.stringify(v) + ' must fall back');
        });
    });

    it('pollInterval accepts only integers within 250..60000 and falls back per key', function () {
        assert.equal(mt.resolveConf({ pollInterval: 250 }).pollInterval, 250);
        assert.equal(mt.resolveConf({ pollInterval: 60000 }).pollInterval, 60000);
        [ 249, 60001, 0, -1, 1.5, '500', NaN, Infinity ].forEach(function (v) {
            assert.equal(mt.resolveConf({ pollInterval: v }).pollInterval, 2000, JSON.stringify(v) + ' must fall back');
        });
        // per key: a bad pollInterval must not lose the store
        var c = mt.resolveConf({ store: 'maint', pollInterval: 5 });
        assert.equal(c.store, 'maint');
        assert.equal(c.pollInterval, 2000);
    });

    it('lintConf explains both fallbacks and stays silent when the keys are absent', function () {
        var w = mt.lintConf({ store: '', pollInterval: 5 });
        assert.equal(w.length, 2);
        assert.match(w[0], /server\.maintenance\.store.*non-empty string/);
        assert.match(w[1], /server\.maintenance\.pollInterval.*250.*60000.*2000/);
        assert.deepEqual(mt.lintConf({ enabled: false, retryAfter: 60 }), []);
    });
});


describe('13 - resolveStoreSync: the boot half — refuse a dangling namespace and failMode open, warn on memory', function () {
    /** A fake kv facade that hands out a handle only for the listed names. */
    function fakeKv(names) {
        return { get: function (n) {
            if ( names.indexOf(n) < 0 ) { throw new Error('[kv] no namespace `' + n + '` (configured: ' + names.join(', ') + ')'); }
            return { name: n, get: function () { return Promise.resolve(null); }, set: function () { return Promise.resolve(true); } };
        } };
    }
    function collect() { var a = []; a.warn = function (m) { a.push(m); }; return a; }

    it('returns null when no store is configured — zero cost, nothing consulted', function () {
        var kvTouched = 0;
        var r = mt.resolveStoreSync(mt.resolveConf(null), { kv: { get: function () { kvTouched++; } }, bundle: 'app' });
        assert.equal(r, null);
        assert.equal(kvTouched, 0);
    });

    it('returns the handle, name, key and cadence for a usable namespace', function () {
        var w = collect();
        var r = mt.resolveStoreSync(mt.resolveConf({ store: 'maint', pollInterval: 500 }), {
            kv: fakeKv(['maint']), bundle: 'app', warn: w.warn,
            kvSettings: { namespaces: { maint: { store: 'kvRedis' } } },
            connectors: { kvRedis: { connector: 'redis', enableOfflineQueue: false, commandTimeout: 2000 } }
        });
        assert.equal(r.name, 'maint');
        assert.equal(r.key, 'app');
        assert.equal(r.intervalMs, 500);
        assert.equal(typeof r.ns.get, 'function');
        assert.equal(w.length, 0, 'a redis namespace with the fail-fast trio earns no warning');
    });

    it('REFUSES (throws, named) when kv cannot hand out the namespace — carrying the kv message', function () {
        assert.throws(function () {
            mt.resolveStoreSync(mt.resolveConf({ store: 'nope' }), { kv: fakeKv(['maint']), bundle: 'app' });
        }, /\[SERVER\]\[#MAINT1\] `server\.maintenance\.store` = `nope` is not usable: \[kv\] no namespace `nope`/);
    });

    it('REFUSES (throws, named) a namespace running failMode open — an outage would reopen every replica', function () {
        assert.throws(function () {
            mt.resolveStoreSync(mt.resolveConf({ store: 'maint' }), {
                kv: fakeKv(['maint']), bundle: 'app',
                kvSettings: { namespaces: { maint: { store: 'kvRedis', failMode: 'open' } } }
            });
        }, /failMode: "open".*reopen every replica.*failMode: "closed"/);
    });

    it('WARNS on a memory-backed namespace (per process, no coherence) and still returns the handle', function () {
        var w = collect();
        var r = mt.resolveStoreSync(mt.resolveConf({ store: 'maint' }), {
            kv: fakeKv(['maint']), bundle: 'app', warn: w.warn, kvSettings: { namespaces: { maint: {} } }
        });
        assert.ok(r && r.ns, 'the feature still runs');
        assert.equal(w.length, 1);
        assert.match(w[0], /MEMORY-backed.*PER PROCESS.*replicas will NOT follow each other/);
    });

    it('WARNS on redis without the fail-fast trio (the shared precedent wording)', function () {
        var w = collect();
        mt.resolveStoreSync(mt.resolveConf({ store: 'maint' }), {
            kv: fakeKv(['maint']), bundle: 'app', warn: w.warn,
            kvSettings: { namespaces: { maint: { store: 'kvRedis' } } },
            connectors: { kvRedis: { connector: 'redis' } }
        });
        assert.equal(w.length, 1);
        assert.match(w[0], /enableOfflineQueue: false.*commandTimeout.*kvRedis/);
    });

    it('throws without a bundle key or without a kv facade (programming errors, named)', function () {
        assert.throws(function () { mt.resolveStoreSync(mt.resolveConf({ store: 'maint' }), { kv: fakeKv(['maint']) }); }, /bundle name as the record key/);
        assert.throws(function () { mt.resolveStoreSync(mt.resolveConf({ store: 'maint' }), { bundle: 'app' }); }, /no kv facade reached the resolver/);
    });
});


describe('14 - createStoreSync: the poll — apply / clear / keep-last-known / no overlap / warn once', function () {
    beforeEach(function () { mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] }); });
    afterEach(function () { mock.timers.reset(); });

    /**
     * A scripted namespace: each get() shifts the next outcome —
     * {value} resolves it, {reject} rejects, {hang} never settles.
     */
    function scriptedNs(script) {
        var calls = 0;
        return {
            calls: function () { return calls; },
            get: function () {
                calls++;
                var step = script.length ? script.shift() : { value: null };
                if ( step.hang )   { return new Promise(function () {}); }
                if ( step.reject ) { return Promise.reject(new Error(step.reject)); }
                return Promise.resolve(step.value);
            }
        };
    }
    function collect() { var a = []; a.warn = function (m) { a.push(m); }; return a; }
    var flush = function () { return new Promise(function (r) { setImmediate(r); }); };

    it('start() arms an unref-able interval, fires the first tick immediately, and applies the record', async function () {
        var state = { conf: { enabled: false }, runtime: null };
        var ns = scriptedNs([{ value: { v: 1, active: true, until: null, message: 'from the store' } }]);
        var s = mt.createStoreSync({ state: state, ns: ns, key: 'app', name: 'maint', intervalMs: 1000, warn: collect().warn });
        s.start();
        assert.equal(s.isRunning(), true);
        assert.equal(ns.calls(), 1, 'the first tick fires at start()');
        await flush();
        assert.equal(mt.isActive(state), true);
        assert.equal(state.runtime.message, 'from the store');
        assert.equal(state.sync.store, 'maint');
        assert.equal(state.sync.key, 'app');
        assert.equal(typeof state.sync.lastSyncAt, 'number');
        assert.equal(state.sync.lastError, null);
        s.stop();
        assert.equal(s.isRunning(), false);
    });

    it('a resolved null clears the runtime to CONFIG on a later tick', async function () {
        var state = { conf: { enabled: false }, runtime: { active: true, until: null } };
        var ns = scriptedNs([{ value: { v: 1, active: true, until: null } }, { value: null }]);
        var s = mt.createStoreSync({ state: state, ns: ns, key: 'app', intervalMs: 1000, warn: collect().warn });
        s.start(); await flush();
        assert.equal(mt.isActive(state), true);
        mock.timers.tick(1000); await flush();
        assert.equal(ns.calls(), 2);
        assert.equal(state.runtime, null, 'null ⇒ config');
        assert.equal(mt.isActive(state), false);
        s.stop();
    });

    it('a REJECTION keeps the last-known state, warns ONCE per outage, and warns once more on recovery', async function () {
        var state = { conf: { enabled: false }, runtime: null };
        var w = collect();
        var ns = scriptedNs([
            { value: { v: 1, active: true, until: null } },
            { reject: 'ECONNREFUSED' }, { reject: 'ECONNREFUSED' }, { reject: 'ECONNREFUSED' },
            { value: { v: 1, active: true, until: null } }
        ]);
        var s = mt.createStoreSync({ state: state, ns: ns, key: 'app', intervalMs: 1000, warn: w.warn });
        s.start(); await flush();
        assert.equal(mt.isActive(state), true);
        for (var i = 0; i < 3; i++) { mock.timers.tick(1000); await flush(); }
        assert.equal(ns.calls(), 4);
        assert.equal(mt.isActive(state), true, 'an outage must never reopen a closed site');
        assert.equal(state.sync.lastError, 'ECONNREFUSED');
        assert.equal(w.length, 1, 'one warning for the whole outage, not one per tick');
        assert.match(w[0], /unreachable.*never reopens a closed site/);
        mock.timers.tick(1000); await flush();
        assert.equal(state.sync.lastError, null);
        assert.equal(w.length, 2);
        assert.match(w[1], /reachable again/);
        s.stop();
    });

    it('a hanging get never overlaps: later ticks are skipped while it is in flight', async function () {
        var state = { conf: { enabled: false }, runtime: null };
        var ns = scriptedNs([{ hang: true }]);
        var s = mt.createStoreSync({ state: state, ns: ns, key: 'app', intervalMs: 1000, warn: collect().warn });
        s.start(); await flush();
        mock.timers.tick(1000); await flush();
        mock.timers.tick(1000); await flush();
        assert.equal(ns.calls(), 1, 'no second get while the first hangs');
        assert.equal(await s.tick(), 'skipped');
        s.stop();
    });

    it('a malformed record is ignored with a warning and the last-known state kept', async function () {
        var state = { conf: { enabled: false }, runtime: { active: true, until: null } };
        var w = collect();
        var ns = scriptedNs([{ value: { v: 99 } }]);
        var s = mt.createStoreSync({ state: state, ns: ns, key: 'app', name: 'maint', intervalMs: 1000, warn: w.warn });
        assert.equal(await s.tick(), 'malformed');
        assert.equal(mt.isActive(state), true);
        assert.equal(w.length, 1);
        assert.match(w[0], /malformed.*keeping the last-known state/);
    });

    it('tick() reports its outcome and never rejects', async function () {
        var state = { conf: { enabled: false }, runtime: null };
        var ns = scriptedNs([{ value: { v: 1, active: false, until: null } }, { value: null }, { reject: 'boom' }]);
        var s = mt.createStoreSync({ state: state, ns: ns, key: 'app', intervalMs: 1000, warn: collect().warn });
        assert.equal(await s.tick(), 'applied');
        assert.equal(await s.tick(), 'cleared');
        assert.equal(await s.tick(), 'error');
    });

    it('refuses to build without a state, a namespace handle or a key', function () {
        assert.throws(function () { mt.createStoreSync({ ns: { get: function () {} }, key: 'app' }); }, /engine state object/);
        assert.throws(function () { mt.createStoreSync({ state: {}, key: 'app' }); }, /namespace handle/);
        assert.throws(function () { mt.createStoreSync({ state: {}, ns: { get: function () {} } }); }, /record key/);
    });

    it('record round trip: build → ttl → apply, with the dead-man window carried as the store TTL', function () {
        var rec = mt.buildStoreRecord({ active: true, until: 61000, retryAfter: 60, message: 'deploying' }, { pid: 7, hostname: 'web-1' }, 1000);
        assert.deepEqual(rec, { v: 1, active: true, until: 61000, setBy: { pid: 7, hostname: 'web-1' }, at: 1000, retryAfter: 60, message: 'deploying' });
        assert.equal(mt.storeRecordTtl(rec, 1000), 60000);
        assert.equal(mt.storeRecordTtl({ v: 1, active: true, until: null }, 1000), null, 'no window ⇒ no expiry');
        var state = { conf: { enabled: false }, runtime: null };
        assert.equal(mt.applyStoreRecord(state, rec), 'applied');
        assert.deepEqual(state.runtime, { active: true, until: 61000, retryAfter: 60, message: 'deploying' });
        assert.equal(mt.isActive(state, 2000), true);
        assert.equal(mt.isActive(state, 61000), false, 'the local clock still honours until');
        assert.equal(mt.effectiveConf(state, 2000).message, 'deploying');
    });

    it('an enable:false POST writes {active:false}, which wins over a config enabled:true on every replica', function () {
        var rec = mt.buildStoreRecord({ active: false, until: null }, { pid: 1, hostname: 'h' }, 1);
        var state = { conf: mt.resolveConf({ enabled: true }), runtime: null };
        assert.equal(mt.isActive(state), true);
        assert.equal(mt.applyStoreRecord(state, rec), 'applied');
        assert.equal(mt.isActive(state), false, 'runtime off wins over config on — the shipped rule, now replica-wide');
    });
});


describe('15 - replica sync engine wiring: boot-resolve arms the poll, both POST twins write through, both payloads carry sync', function () {
    var server = fs.readFileSync(SERVER_SRC, 'utf8');
    var isaac  = fs.readFileSync(ISAAC_SRC, 'utf8');

    /** The POST callback of one engine's /_gina/maintenance handler (the #B498 harness geometry). */
    function postCallback(src, label) {
        var a = src.indexOf('── /_gina/maintenance');
        var b = src.indexOf('── /_gina/instrument');
        assert.ok(a > -1 && b > a, label + ': the maintenance region anchors must exist in order');
        var region = src.slice(a, b);
        var st = region.indexOf('function(_mbErr, _mbBody) {');
        assert.ok(st > -1, label + ': the POST callback must be present');
        return region.slice(st);
    }

    it('the store sync is armed in gna.js\'s started band — right AFTER lib.kv.start(), before the warn-only lints, with the #KV1 fatal shape — and NOT in server.js init, which runs before kv exists', function () {
        var gna = fs.readFileSync(GNA_SRC, 'utf8');
        var kvStart = gna.indexOf('lib.kv.start(');
        var lint    = gna.indexOf('lib.maintenance.lintConf(');
        var banner  = gna.indexOf('#MAINT1 slice (c) — replica sync');
        var next    = gna.indexOf('// #CE1 — `server.transientErrors` boot-time shape check', banner);
        assert.ok(kvStart > -1 && lint > -1, 'the kv start and the maintenance lint must exist');
        assert.ok(banner > -1, 'the slice (c) block must exist in gna.js');
        assert.ok(next > banner, 'the block must end at the #CE1 lint that follows it (structural end anchor)');
        assert.ok(kvStart < banner && banner < lint, 'kv start, then the store sync (fatal-shaped, beside #KV1), then the warn-only lints');
        var band = gna.slice(banner, next);
        assert.ok(band.indexOf('lib.maintenance.resolveStoreSync(') > -1, 'must resolve through the lib');
        assert.ok(band.indexOf('lib.maintenance.createStoreSync(') > -1 && band.indexOf('.syncer.start()') > -1, 'must arm and start the poll');
        assert.ok(/bundle\s*:\s*server\.appName/.test(band), 'the record key is the bundle name');
        assert.ok(/kv\s*:\s*lib\.kv/.test(band), 'the kv facade is injected, never required by the lib');
        assert.ok(/server\.instance\._maintenance/.test(band), 'the poll is armed on the engine state the boot-resolve published');
        assert.ok(band.indexOf('process.exit(1)') > -1 && band.indexOf('aborting boot') > -1, 'a refusal is FATAL, the #KV1 shape');
        // measured 2026-09-20: a resolve in server.js init fired "[kv] not configured" on a
        // bundle whose settings.json declared the block — init runs before the started band
        var at  = server.indexOf('#MAINT1 — maintenance mode: boot-resolve');
        var end = server.indexOf('#RWATCH — stale built-release watch', at);
        assert.ok(at > -1 && end > at, 'boot-resolve anchors');
        assert.equal(server.slice(at, end).indexOf('lib.maintenance.resolveStoreSync('), -1, 'server.js init must NOT resolve the store');
    });

    it('BOTH POST twins apply locally FIRST, keep the store-less path, then write the record through with buildStoreRecord + storeRecordTtl', function () {
        [['server.js', server], ['server.isaac.js', isaac]].forEach(function (pair) {
            var cb = postCallback(pair[1], pair[0]);
            var apply = cb.indexOf('_mtCtl.runtime = _rtNew;');
            var early = cb.indexOf('if ( !_mtCtl.store )');
            var rec   = cb.indexOf('lib.maintenance.buildStoreRecord(_rtNew');
            var ttl   = cb.indexOf('lib.maintenance.storeRecordTtl(');
            var set   = cb.indexOf('_mtCtl.store.ns.set(_mtCtl.store.key');
            assert.ok(apply > -1 && early > -1 && rec > -1 && ttl > -1 && set > -1, pair[0] + ': every step present');
            assert.ok(apply < early && early < rec && rec < ttl && ttl < set, pair[0] + ': local apply → store-less return → record → ttl → set');
            assert.ok(cb.indexOf("written: true") > -1 && cb.indexOf("written: false") > -1, pair[0] + ': both write outcomes are reported');
            assert.ok(cb.indexOf('.catch(') > -1, pair[0] + ': the reply chain owns its last terminal');
        });
    });

    it('BOTH status payloads carry `sync` (store, key, lastSyncAt, lastError) after hasBypassKey', function () {
        [['server.js', server], ['server.isaac.js', isaac]].forEach(function (pair) {
            var body = mtStatusBody(pair[1], pair[0]);
            var hb = body.indexOf('hasBypassKey');
            var sy = body.indexOf('sync         : _mtCtl.sync ?');
            assert.ok(hb > -1 && sy > hb, pair[0] + ': sync follows hasBypassKey');
            ['store: _mtCtl.sync.store', 'key: _mtCtl.sync.key', 'lastSyncAt', 'lastError: _mtCtl.sync.lastError'].forEach(function (needle) {
                assert.ok(body.indexOf(needle) > -1, pair[0] + ': payload must carry ' + needle);
            });
        });
    });

    it('the lib refuses by name at boot — the two refusal messages and the memory warning exist in the shipped source', function () {
        var src = fs.readFileSync(MT_SRC, 'utf8');
        assert.ok(src.indexOf("is not usable: ' + (kvErr.message || kvErr)") > -1, 'dangling-namespace refusal');
        assert.ok(src.indexOf('runs `failMode: "open"`') > -1, 'failMode-open refusal');
        assert.ok(src.indexOf('is MEMORY-backed: the maintenance state is PER PROCESS') > -1, 'memory-backed warning');
    });
});
