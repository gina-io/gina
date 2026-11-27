/**
 * #B1104 — the Access-Control-Allow-Origin rule, held once (core/server.js `allowOriginFor`).
 *
 * completeHeaders() picked the value per request: with a comma-separated list configured in
 * `server.response.header`, the request's origin when the list holds it and none otherwise;
 * the request's own origin when it is the bundle's hostname; else the configured value, or the
 * request's origin when the configured value is empty. A render-cache hit replayed the value
 * picked for the request that FILLED the entry, and isaac's pre-routing hit runs no
 * completeHeaders(). The rule now lives in `allowOriginFor(request)`, called by
 * completeHeaders() and by the stamp `instance._renderCacheAllowOrigin(req, res)` that isaac's
 * hit calls (wiring pinned in test/core/render-cache-vary-acao-b1164.test.js).
 *
 * Both are closures inside the Server constructor: this file lifts their SHIPPED bytes and runs
 * them against a fake `self` (the only name they close over), the #B121 extract-and-execute
 * shape. Arms 01.1–01.3 reproduce what a booted bundle answered before the fix on uncached
 * requests (listed origin → its own, second listed origin → its own, unlisted → none), so the
 * lifted rule is checked against measured behaviour, not only against itself.
 *
 * Run standalone:
 *   node --test test/core/server-allow-origin-b1104.test.js
 */

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW  = require('../fw');
var SRC = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');

var OA = 'http://oa.example', OB = 'http://ob.example', OC = 'http://oc.example';
var LIST = OA + ', ' + OB;

/** The shipped `allowOriginFor` declaration, from its first line to its closing brace. */
function liftHelperText() {
    var start = SRC.indexOf('var allowOriginFor = function(request) {');
    assert.ok(start > -1, 'extraction control: allowOriginFor is declared in core/server.js');
    assert.equal(SRC.indexOf('var allowOriginFor = function(request) {', start + 1), -1, 'extraction control: declared once');
    var end = SRC.indexOf('\n    }\n', start);
    assert.ok(end > start, 'extraction control: its closing brace is found');
    return SRC.slice(start, end + '\n    }'.length);
}

/** The shipped stamp's function expression. */
function liftStampText() {
    var at = SRC.indexOf('instance._renderCacheAllowOrigin = function(req, res) {');
    assert.ok(at > -1, 'extraction control: the stamp is in core/server.js');
    var fnStart = SRC.indexOf('function(req, res) {', at);
    var fnEnd   = SRC.indexOf('\n                };', fnStart);
    assert.ok(fnEnd > fnStart, 'extraction control: the stamp\'s closing brace is found');
    return SRC.slice(fnStart, fnEnd + '\n                }'.length);
}

/** A fake Server `self`: bundle `web` (env `prod`) and a second bundle `api` for `{api@proj}` tokens. */
function fakeSelf(header, opts) {
    opts = opts || {};
    return {
        appName : 'web',
        env     : 'prod',
        scope   : 'local',
        conf    : {
            web : { prod: { hostname: opts.hostname || 'http://127.0.0.1:3100', host: '127.0.0.1',
                server: { protocol: opts.protocol || 'http/1.1', scheme: opts.scheme || 'http', port: 3100, response: { header: header } } } },
            api : { prod: { hostname: 'https://api.example', host: 'api.example',
                server: { protocol: 'http/1.1', scheme: 'https', port: 443, response: { header: {} } } } }
        }
    };
}

function helperFor(self) {
    /* eslint-disable no-new-func */
    return new Function('self', "'use strict';\n" + liftHelperText() + '\nreturn allowOriginFor;')(self);
    /* eslint-enable no-new-func */
}

function stampFor(self) {
    var allowOriginFor = helperFor(self);
    /* eslint-disable no-new-func */
    return new Function('self', 'allowOriginFor', "'use strict';\nreturn (" + liftStampText() + ');')(self, allowOriginFor);
    /* eslint-enable no-new-func */
}

/** A fake response recording what is set. */
function fakeRes(sent) {
    return { headersSent: !!sent, set: {}, setHeader: function (n, v) { this.set[n] = v; } };
}


describe('01 - allowOriginFor(): the value each request gets', function () {

    it('01.1 a listed origin gets its own (measured on develop, uncached: Origin oa → oa)', function () {
        assert.equal(helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { origin: OA, host: '127.0.0.1:3100' } }), OA);
    });

    it('01.2 a second listed origin gets its own, not the first (measured: Origin ob → ob)', function () {
        assert.equal(helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { origin: OB, host: '127.0.0.1:3100' } }), OB);
    });

    it('01.3 an unlisted origin gets none (measured: Origin oc → none)', function () {
        assert.equal(helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { origin: OC, host: '127.0.0.1:3100' } }), null);
    });

    it('01.4 no Origin, on the bundle\'s own host: its own origin (same-origin)', function () {
        assert.equal(helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { host: '127.0.0.1:3100' } }), 'http://127.0.0.1:3100');
    });

    it('01.5 no Origin, on another host: none', function () {
        assert.equal(helperFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { host: 'other.example' } }), null);
    });

    it('01.6 a single configured value: that value, whatever the request', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': 'https://one.example' }));
        assert.equal(f({ headers: { origin: OC, host: '127.0.0.1:3100' } }), 'https://one.example');
        assert.equal(f({ headers: { origin: OA, host: '127.0.0.1:3100' } }), 'https://one.example');
    });

    it('01.7 an empty configured value: the request\'s own origin', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': '' }));
        assert.equal(f({ headers: { origin: OA, host: '127.0.0.1:3100' } }), OA);
        assert.equal(f({ headers: { origin: OB, host: '127.0.0.1:3100' } }), OB);
    });

    it('01.8 a {bundle@project} token in the list is that bundle\'s hostname', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': OA + ', {api@proj}' }));
        assert.equal(f({ headers: { origin: 'https://api.example', host: '127.0.0.1:3100' } }), 'https://api.example');
        assert.equal(f({ headers: { origin: OB, host: '127.0.0.1:3100' } }), null);
    });

    it('01.9 HTTP/2, no Origin: its :scheme and :authority make its origin', function () {
        var f = helperFor(fakeSelf({ 'access-control-allow-origin': LIST }, { protocol: 'http/2.0', scheme: 'https', hostname: 'https://127.0.0.1:3100' }));
        assert.equal(f({ headers: { ':authority': '127.0.0.1:3100', ':scheme': 'https' } }), 'https://127.0.0.1:3100');
    });
});


describe('02 - instance._renderCacheAllowOrigin(): isaac\'s hit sets the request\'s own value', function () {

    it('02.1 sets the configured name to the request\'s value, and nothing else', function () {
        var res = fakeRes();
        stampFor(fakeSelf({ 'access-control-allow-origin': LIST, 'vary': 'Origin' }))({ headers: { origin: OB, host: '127.0.0.1:3100' } }, res);
        assert.deepEqual(res.set, { 'access-control-allow-origin': OB });
    });

    it('02.2 an unlisted origin: sets none', function () {
        var res = fakeRes();
        stampFor(fakeSelf({ 'access-control-allow-origin': LIST, 'vary': 'Origin' }))({ headers: { origin: OC, host: '127.0.0.1:3100' } }, res);
        assert.deepEqual(res.set, {});
    });

    it('02.3 no access-control-allow-origin configured: sets none', function () {
        var res = fakeRes();
        stampFor(fakeSelf({ 'vary': 'Origin' }))({ headers: { origin: OA, host: '127.0.0.1:3100' } }, res);
        assert.deepEqual(res.set, {});
        var res2 = fakeRes();
        stampFor(fakeSelf({}))({ headers: { origin: OA, host: '127.0.0.1:3100' } }, res2);
        assert.deepEqual(res2.set, {});
    });

    it('02.4 a request whose origin the rule cannot read (it throws): sets none and does not throw', function () {
        var res = fakeRes();
        assert.doesNotThrow(function () {
            stampFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { origin: 'http://a(', host: '127.0.0.1:3100' } }, res);
        });
        assert.deepEqual(res.set, {});
    });

    it('02.5 headers already sent: sets none', function () {
        var res = fakeRes(true);
        stampFor(fakeSelf({ 'access-control-allow-origin': LIST }))({ headers: { origin: OA, host: '127.0.0.1:3100' } }, res);
        assert.deepEqual(res.set, {});
    });
});
