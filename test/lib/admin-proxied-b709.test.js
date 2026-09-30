'use strict';
/**
 * #B709 — the admin `/_gina/*` endpoints and `/_gina/metrics` admit a loopback caller only
 * when it connects directly.
 *
 * Both gates authorise a caller by its socket address alone, and the default list is
 * loopback. A reverse proxy on the bundle's own host connects from loopback, so before this
 * fix it relayed every client it forwarded into the family — no browser, no credential
 * (driven live: the canonical nginx snippet turned maintenance mode on, a site-wide 503).
 *
 * This file pins the rule through lib/admin and lib/metrics:
 *   01  a loopback caller whose request carries a proxy signal is refused — the signals are
 *       lib/maintenance's `isProxiedRequest` (any `x-forwarded-*` header, RFC 7239
 *       `Forwarded`, a `true` #B65 stamp, a port-less `Host`/`:authority` unless
 *       `server.proxy.requireForwardedHeaders`); a direct loopback caller is admitted; the
 *       residual — a proxy that forwards `Host` with its port and adds no forwarding header —
 *       is admitted, byte-identical to a direct client
 *   02  the list itself keeps its meaning: an explicitly listed NON-loopback address (a
 *       proxy on another host) still admits relayed requests, a listed loopback entry never
 *       does, `[]` denies everyone
 *   03  the per-request stamp: taken once from the pristine headers, it wins over headers
 *       rewritten after it (isaac rewrites an h1 `Host` port-less before server.js runs)
 *   04  `controlPath()` — the query-free path the engines match the family on: the root
 *       form or the bundle's own webroot form, nothing else
 *   05  the metrics twin applies the same rule on its own list
 *   06  the refusal is logged once per process and axis, never per request
 *
 * Red-first: against the previous lib/admin + lib/metrics (socket-only gates, no
 * `controlPath`/`stampProxied`) the refusal and helper arms go red; the controls — direct
 * loopback admitted, `[]` denies, a listed non-loopback proxy admitted, the residual
 * admitted — stay green.
 */

var { describe, it, before, after, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');

var FW      = require('../fw');
var admin   = require(path.join(FW, 'lib/admin/src/main'));
var metrics = require(path.join(FW, 'lib/metrics/src/main'));


/** A request as the engines hand it over: socket address + headers (+ optional extras). */
function req(ip, headers, extra) {
    var r = { socket: { remoteAddress: ip }, headers: headers || {}, url: '/_gina/maintenance' };
    if (extra) { Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); }
    return r;
}

var hadGina, savedList, savedForwarded;

function saveGina() {
    hadGina        = (typeof process.gina === 'object' && process.gina !== null);
    savedList      = hadGina ? process.gina._adminAllowList : undefined;
    savedForwarded = hadGina ? process.gina._proxyRequireForwarded : undefined;
}
function restoreGina() {
    if (!hadGina) { delete process.gina; return; }
    if (savedList === undefined) { delete process.gina._adminAllowList; } else { process.gina._adminAllowList = savedList; }
    if (savedForwarded === undefined) { delete process.gina._proxyRequireForwarded; } else { process.gina._proxyRequireForwarded = savedForwarded; }
}
function useList(list) {
    process.gina = process.gina || {};
    if (list === undefined) { delete process.gina._adminAllowList; } else { process.gina._adminAllowList = list; }
    delete process.gina._proxyRequireForwarded;
}

/** Silence (and count) the one-time refusal warning while an arm runs. */
var warnings = [], realWarn = console.warn;
function muteWarn()   { warnings = []; console.warn = function () { warnings.push(Array.prototype.join.call(arguments, ' ')); }; }
function unmuteWarn() { console.warn = realWarn; }


describe('01 - the default loopback list refuses a relayed request, admits a direct one', function () {
    before(saveGina);
    after(restoreGina);
    beforeEach(function () { useList(undefined); muteWarn(); });
    afterEach(unmuteWarn);

    it('CONTROL: a direct loopback caller (no headers at all) is admitted', function () {
        assert.equal(admin.isClientAllowed(req('127.0.0.1')), true);
        assert.equal(admin.isClientAllowed(req('::1')), true);
    });

    it('CONTROL: a direct loopback caller with the port-bearing Host node/curl send is admitted', function () {
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: '127.0.0.1:3100' })), true);
        assert.equal(admin.isClientAllowed(req('::ffff:127.0.0.1', { host: 'localhost:3100' })), true);
    });

    it('the canonical nginx snippet (port-less Host + X-Forwarded-For/Proto + X-Real-IP) is refused', function () {
        var r = req('127.0.0.1', { host: 'www.example.com', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.9' });
        assert.equal(admin.isClientAllowed(r), false);
    });

    it('any single x-forwarded-* header is a proxy signal, whatever the Host', function () {
        [ { 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-proto': 'https' }, { 'x-forwarded-host': 'www.example.com' },
          { 'X-Forwarded-Prefix': '/app' } ].forEach(function (h) {
            h.host = '127.0.0.1:3100';
            assert.equal(admin.isClientAllowed(req('127.0.0.1', h)), false, JSON.stringify(h));
        });
    });

    it('an RFC 7239 Forwarded header is a proxy signal', function () {
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: '127.0.0.1:3100', forwarded: 'for=203.0.113.9' })), false);
    });

    it('a port-less Host (what `proxy_set_header Host $host` sends) is a proxy signal — HTTP/1.1 and HTTP/2', function () {
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: 'web-prod.example.test' })), false, 'the health-nginx shape: fixed Host, no header');
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: '127.0.0.1' })), false);
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { ':authority': 'www.example.com' })), false);
    });

    it('a `true` #B65 stamp is a proxy signal', function () {
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: '127.0.0.1:3100' }, { _ginaIsProxyHost: true })), false);
    });

    it('IPv6 loopback, the IPv6-mapped form and the whole 127/8 block are loopback too', function () {
        assert.equal(admin.isClientAllowed(req('::1', { host: 'x.test', 'x-forwarded-for': '1.2.3.4' })), false);
        assert.equal(admin.isClientAllowed(req('::ffff:127.0.0.1', { host: 'x.test' })), false);
        useList(['127.0.0.2']);
        assert.equal(admin.isClientAllowed(req('127.0.0.2', { host: '127.0.0.2:3100', 'x-forwarded-for': '1.2.3.4' })), false);
        assert.equal(admin.isClientAllowed(req('127.0.0.2', { host: '127.0.0.2:3100' })), true, 'control: the same address, direct');
    });

    it('server.proxy.requireForwardedHeaders turns the port-less-Host heuristic off, never the header signals', function () {
        process.gina._proxyRequireForwarded = true;
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: 'www.example.com' })), true,
            'with the heuristic off, a bundle bound to 80/443 keeps its direct loopback admin access');
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: 'www.example.com', 'x-forwarded-for': '1.2.3.4' })), false);
    });

    it('RESIDUAL, pinned deliberately: a proxy forwarding a port-bearing Host with no forwarding header is admitted', function () {
        // nginx's DEFAULT proxy (Host = $proxy_host, no header) is byte-identical to a direct
        // client — measured on a real nginx at the #B709 gate. No header classifier can close
        // it; the docs say to call the bundle's port directly and to block /_gina/ at the edge.
        // Pinned so a change to this behaviour is a deliberate decision.
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: '127.0.0.1:18090' })), true);
    });
});


describe('02 - the list keeps its meaning', function () {
    before(saveGina);
    after(restoreGina);
    beforeEach(muteWarn);
    afterEach(unmuteWarn);

    it('an explicitly listed NON-loopback address (a proxy on another host) still admits a relayed request', function () {
        useList(['10.0.0.5']);
        assert.equal(admin.isClientAllowed(req('10.0.0.5', { host: 'www.example.com', 'x-forwarded-for': '203.0.113.9' })), true,
            'listing a remote proxy\'s address is the documented opt-in');
    });

    it('a loopback entry never admits a relayed request, even listed explicitly', function () {
        useList(['127.0.0.1']);
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: 'www.example.com', 'x-forwarded-for': '203.0.113.9' })), false);
    });

    it('CONTROL: [] denies everyone, direct loopback included', function () {
        useList([]);
        assert.equal(admin.isClientAllowed(req('127.0.0.1')), false);
        assert.equal(admin.isClientAllowed(req('::1', { host: '127.0.0.1:3100' })), false);
    });

    it('CONTROL: an address outside the list is refused whatever its headers', function () {
        useList(['10.0.0.5']);
        assert.equal(admin.isClientAllowed(req('127.0.0.1')), false);
        assert.equal(admin.isClientAllowed(req('203.0.113.9', { host: '203.0.113.9:3100' })), false);
    });
});


describe('03 - the per-request stamp', function () {
    before(saveGina);
    after(restoreGina);
    beforeEach(function () { useList(undefined); muteWarn(); });
    afterEach(unmuteWarn);

    it('stampProxied takes the classification once, from the headers as they are at that moment', function () {
        var r = req('127.0.0.1', { host: '127.0.0.1:3100' });
        assert.equal(admin.stampProxied(r), false);
        assert.equal(r._ginaAdminProxied, false);
        r.headers.host = '127.0.0.1';                       // what isaac's h1 rewrite does later
        assert.equal(admin.stampProxied(r), false, 'first-seer: a second call keeps the first reading');
    });

    it('the stamp wins over a Host rewritten after it was taken (the isaac h1 case)', function () {
        var r = req('127.0.0.1', { host: '127.0.0.1:3100' });
        admin.stampProxied(r);
        r.headers.host = '127.0.0.1';
        assert.equal(admin.isClientAllowed(r), true, 'a direct CLI call must not read as proxied after the rewrite');
    });

    it('a stamp saying proxied refuses even with clean headers', function () {
        assert.equal(admin.isClientAllowed(req('127.0.0.1', { host: '127.0.0.1:3100' }, { _ginaAdminProxied: true })), false);
    });

    it('without a stamp the request is classified live (tests, express, req-less callers)', function () {
        var r = req('127.0.0.1', { host: 'www.example.com' });
        assert.equal(r._ginaAdminProxied, undefined);
        assert.equal(admin.isRelayedLoopback(r), true);
    });

    it('isRelayedLoopback is false for a non-loopback socket whatever its headers (the list decides those)', function () {
        assert.equal(admin.isRelayedLoopback(req('10.0.0.5', { host: 'x.test', 'x-forwarded-for': '1.2.3.4' })), false);
    });

    it('a malformed request fails closed: stamped proxied, never admitted, never a throw', function () {
        assert.equal(admin.stampProxied(null), true);
        assert.equal(admin.isRelayedLoopback(null), false, 'no socket, so no loopback caller to refuse');
        assert.equal(admin.isClientAllowed({}), false, 'no socket address: refused by the list');
    });
});


describe('04 - controlPath: the root form or the bundle\'s own webroot form, nothing else', function () {
    var cp = function (u, w) { return admin.controlPath(u, w); };

    it('the root form, query dropped', function () {
        assert.equal(cp('/_gina/info'), '/_gina/info');
        assert.equal(cp('/_gina/cache/clear?bundle=web'), '/_gina/cache/clear');
        assert.equal(cp('/_gina/maintenance', '/web/'), '/_gina/maintenance');
    });

    it('the bundle\'s own webroot form — normalised or not', function () {
        assert.equal(cp('/web/_gina/info', '/web/'), '/_gina/info');
        assert.equal(cp('/web/_gina/maintenance?x=1', '/web'), '/_gina/maintenance');
        assert.equal(cp('/api/v1/_gina/info', '/api/v1/'), '/_gina/info');
    });

    it('no other prefix: another segment, an empty segment, a doubled slash', function () {
        assert.equal(cp('/zzz/_gina/info', '/web/'), '');
        assert.equal(cp('/web/_gina/info', '/'), '', 'a root webroot has no prefixed form');
        assert.equal(cp('/web/_gina/info'), '', 'no webroot given');
        assert.equal(cp('//_gina/info', '/web/'), '');
        assert.equal(cp('/web//_gina/info', '/web/'), '');
    });

    it('no other case, no query channel, no absolute-form target', function () {
        assert.equal(cp('/_GINA/info'), '');
        assert.equal(cp('/_Gina/cache/clear'), '');
        assert.equal(cp('/?next=/_gina/maintenance'), '');
        assert.equal(cp('/web/page?next=/_gina/info', '/web/'), '');
        assert.equal(cp('http://example.com/_gina/info'), '');
    });

    it('a nested endpoint path is returned whole, so an exact compare cannot match its tail', function () {
        // the v3 health-nginx composition: `location /_gina/health/check` forwards
        // /_gina/health/check/_gina/maintenance verbatim
        assert.equal(cp('/_gina/health/check/_gina/maintenance'), '/_gina/health/check/_gina/maintenance');
        assert.notEqual(cp('/_gina/health/check/_gina/maintenance'), '/_gina/maintenance');
    });

    it('a non-string url is no control path', function () {
        [undefined, null, 42, {}].forEach(function (u) { assert.equal(cp(u, '/web/'), ''); });
    });
});


describe('05 - the metrics twin (app.json > metrics.allowFrom)', function () {
    before(saveGina);
    after(function () { metrics.reset(); restoreGina(); });
    beforeEach(function () { useList(undefined); metrics.reset(); muteWarn(); });
    afterEach(unmuteWarn);

    it('CONTROL: a direct loopback scrape is admitted on the default list', function () {
        assert.equal(metrics.isClientAllowed(req('127.0.0.1', { host: '127.0.0.1:3100' })), true);
    });

    it('a scrape relayed by a same-host proxy is refused', function () {
        assert.equal(metrics.isClientAllowed(req('127.0.0.1', { host: 'metrics.example.com', 'x-forwarded-for': '198.51.100.7' })), false);
        assert.equal(metrics.isClientAllowed(req('::ffff:127.0.0.1', { host: 'metrics.example.com' })), false);
    });

    it('the stamp wins here too', function () {
        var r = req('127.0.0.1', { host: '127.0.0.1:3100' });
        admin.stampProxied(r);
        r.headers.host = '127.0.0.1';
        assert.equal(metrics.isClientAllowed(r), true);
    });

    it('an explicitly listed remote scraper or proxy address is admitted; the residual stays admitted', function () {
        metrics.setAllowList(['127.0.0.1', '10.0.0.42']);
        assert.equal(metrics.isClientAllowed(req('10.0.0.42', { host: 'x.test', 'x-forwarded-for': '1.2.3.4' })), true);
        assert.equal(metrics.isClientAllowed(req('127.0.0.1', { host: '127.0.0.1:9100' })), true, 'residual: port-bearing Host, no header');
    });

    it('CONTROL: [] still denies everyone', function () {
        metrics.setAllowList([]);
        assert.equal(metrics.isClientAllowed(req('127.0.0.1')), false);
    });
});


describe('06 - the refusal is logged once per process and axis, never per request', function () {
    before(saveGina);
    after(function () { metrics.reset(); restoreGina(); });
    beforeEach(function () {
        useList(undefined); metrics.reset();
        if (typeof admin._resetRelayedWarnings === 'function') { admin._resetRelayedWarnings(); }
        muteWarn();
    });
    afterEach(unmuteWarn);

    it('two refusals on the admin axis: one warning naming the path, the list and the guide', function () {
        var relayed = function () { return req('127.0.0.1', { host: 'www.example.com' }, { url: '/_gina/maintenance?x=1' }); };
        admin.isClientAllowed(relayed());
        admin.isClientAllowed(relayed());
        assert.equal(warnings.length, 1, JSON.stringify(warnings));
        assert.match(warnings[0], /\/_gina\/maintenance/);
        assert.equal(warnings[0].indexOf('?x=1'), -1, 'the query is not logged');
        assert.match(warnings[0], /admin\.allowFrom/);
        assert.match(warnings[0], /gina\.io\/docs\/reference\/app#admin/);
    });

    it('the metrics axis warns on its own, once', function () {
        var r = function () { return req('127.0.0.1', { host: 'www.example.com' }, { url: '/_gina/metrics' }); };
        metrics.isClientAllowed(r());
        metrics.isClientAllowed(r());
        assert.equal(warnings.length, 1, JSON.stringify(warnings));
        assert.match(warnings[0], /metrics\.allowFrom/);
    });

    it('CONTROL: an admitted or list-refused request logs nothing', function () {
        admin.isClientAllowed(req('127.0.0.1', { host: '127.0.0.1:3100' }));
        useList([]);
        admin.isClientAllowed(req('127.0.0.1', { host: 'www.example.com' }));
        assert.deepEqual(warnings, []);
    });
});
