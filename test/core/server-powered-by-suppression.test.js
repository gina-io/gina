'use strict';
/**
 * server.js — X-Powered-By suppression uniformity (static + error paths)
 *
 * Two invariants:
 *
 *  1. The engine-agnostic per-request emission (`onInstance`'s
 *     `response.setHeader('X-Powered-By', 'Gina/'+ GINA_VERSION)`) is gated on
 *     `settings.json > server.hidePoweredBy` — so static-asset serves,
 *     static/traversal 404s and framework error pages (none of which traverse
 *     the express middleware chain) honor the same suppression as routed
 *     responses, on both engines.
 *
 *  2. In `throwError`, the HTTP/1.1 flush (`res.writeHead`) comes AFTER the
 *     `completeHeaders(...)` call. `writeHead` marks headers as sent and
 *     completeHeaders' header loop is `!response.headersSent`-guarded, so the
 *     legacy writeHead-first order made the env.json `server.response.header`
 *     overrides a guaranteed no-op on HTTP/1.1 error responses (the HTTP/2
 *     branch already merged them into the headers object passed to
 *     stream.respond — the wire asymmetry a reverse-proxied deployment
 *     observed as `x-powered-by: Gina/<version>` on static 404s while routed
 *     responses carried the configured override).
 *
 * Strategy: source inspection + a pure-logic replica of the header lifecycle
 * (with a subtract control reproducing the legacy order). No live HTTP server
 * or project required.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var SOURCE = path.join(require('../fw'), 'core/server.js');


// ─── 01 — engine-agnostic hidePoweredBy gate on the per-request emission ─────

describe('01 - server.js X-Powered-By emission is gated on server.hidePoweredBy', function() {

    var src;

    before(function() {
        src = fs.readFileSync(SOURCE, 'utf8');
    });

    it('has exactly ONE X-Powered-By setHeader emission in server.js', function() {
        var matches = src.match(/response\.setHeader\('X-Powered-By'/g);
        assert.ok(matches && matches.length === 1,
            'expected exactly one response.setHeader(\'X-Powered-By\', …) emission; found ' + (matches ? matches.length : 0));
    });

    it('that emission sits immediately inside the hidePoweredBy gate', function() {
        var shIdx = src.indexOf("response.setHeader('X-Powered-By'");
        assert.ok(shIdx > -1, 'emission must exist');
        var gateToken = 'if ( !self.conf[self.appName][self.env].server.hidePoweredBy ) {';
        var gateIdx = src.lastIndexOf(gateToken, shIdx);
        assert.ok(gateIdx > -1, 'gate `' + gateToken + '` must precede the emission');
        // structural adjacency: between the gate opener and the setHeader there
        // is only whitespace — the emission is the gate's first statement
        var between = src.slice(gateIdx + gateToken.length, shIdx);
        assert.match(between, /^\s*$/,
            'the setHeader must be the first statement inside the gate (found: ' + JSON.stringify(between.slice(0, 60)) + ')');
    });

    it('reads the same settings key the Isaac /_gina gate reads (server.hidePoweredBy)', function() {
        // the Isaac engine gates its own writeHead sites on options.hidePoweredBy,
        // resolved from the same settings.json server block — the two gates must
        // stay keyed to the same flag name
        assert.ok(src.indexOf('.server.hidePoweredBy') > -1,
            'server.js must read the hidePoweredBy flag from the server settings block');
    });
});


// ─── 02 — throwError: completeHeaders BEFORE the HTTP/1.1 writeHead flush ────

describe('02 - throwError applies completeHeaders before the HTTP/1.1 flush', function() {

    var T; // throwError body

    before(function() {
        var src    = fs.readFileSync(SOURCE, 'utf8');
        var tStart = src.indexOf('var throwError = function(res, code, msg, next)');
        assert.ok(tStart > -1, 'throwError declaration must exist');
        var tEnd   = src.indexOf('Server = inherits', tStart);
        assert.ok(tEnd > tStart, 'end anchor must follow throwError');
        T = src.slice(tStart, tEnd);
    });

    it('declares the deferred HTTP/1.1 content-type carrier', function() {
        assert.ok(T.indexOf('var _h1ContentType') > -1,
            'throwError must declare _h1ContentType for the deferred flush');
    });

    it('XHR/JSON branch: writeHead comes AFTER completeHeaders', function() {
        var ch1 = T.indexOf('header = completeHeaders(header, _req, res);');
        assert.ok(ch1 > -1, 'first completeHeaders call must exist');
        var wh1 = T.indexOf("res.writeHead(code, { 'content-type': _h1ContentType } );");
        assert.ok(wh1 > -1, 'deferred writeHead must exist');
        assert.ok(wh1 > ch1,
            'the HTTP/1.1 writeHead must come AFTER completeHeaders (env response.header overrides are !headersSent-gated)');
    });

    it('HTML/asset branch: writeHead comes AFTER completeHeaders too', function() {
        var ch1 = T.indexOf('header = completeHeaders(header, _req, res);');
        var ch2 = T.indexOf('header = completeHeaders(header, _req, res);', ch1 + 1);
        assert.ok(ch2 > -1, 'second completeHeaders call (HTML/asset branch) must exist');
        var wh1 = T.indexOf("res.writeHead(code, { 'content-type': _h1ContentType } );");
        var wh2 = T.indexOf("res.writeHead(code, { 'content-type': _h1ContentType } );", wh1 + 1);
        assert.ok(wh2 > -1, 'second deferred writeHead (HTML/asset branch) must exist');
        assert.ok(wh2 > ch2,
            'the HTML/asset-branch writeHead must come AFTER its completeHeaders call');
    });

    it('no immediate writeHead flush remains before completeHeaders (legacy forms gone)', function() {
        // legacy XHR/JSON immediate flush
        assert.ok(T.indexOf("res.writeHead(code, { 'content-type': 'application/json") < 0,
            'legacy inline JSON writeHead must be gone from throwError');
        // legacy HTML/asset immediate flush
        assert.ok(T.indexOf("res.writeHead(code, { 'content-type': bundleConf.server.coreConfiguration.mime[ext]") < 0,
            'legacy inline mime writeHead must be gone from throwError');
        // legacy MSIE 3-arg form (set a bogus statusMessage and no content-type header)
        assert.ok(T.indexOf("res.writeHead(code, 'content-type'") < 0,
            'legacy 3-arg writeHead form must be gone from throwError');
    });

    it('every static error branch exits through the shared throwError responder', function() {
        // handleStatics' 404s (missing file, unreadable file, traversal/confinement
        // escape) all route through throwError — one ordering fix covers them all
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var hIdx  = src.indexOf('var handleStatics = function(');
        assert.ok(hIdx > -1, 'handleStatics must exist');
        var hEnd  = src.indexOf('completeHeaders(null, request, response);', hIdx);
        var hBody = src.slice(hIdx, hEnd > hIdx ? hEnd : hIdx + 20000);
        var calls = hBody.match(/throwError\(response,\s*40[34]/g);
        assert.ok(calls && calls.length >= 2,
            'handleStatics must route its error branches through throwError (found ' + (calls ? calls.length : 0) + ')');
    });
});


// ─── 03 — pure-logic replica: header lifecycle + subtract control ────────────

describe('03 - header-lifecycle replica: suppression semantics + subtract', function() {

    // Minimal Node-response semantics: setHeader stores case-insensitively and
    // throws once headers are sent; writeHead merges its object over pending
    // headers and marks them sent.
    function makeRes() {
        var pending = {};
        var res = {
            statusCode: null,
            headersSent: false,
            setHeader: function(name, value) {
                if (res.headersSent) { throw new Error('ERR_HTTP_HEADERS_SENT'); }
                pending[name.toLowerCase()] = value;
            },
            getHeaders: function() { return pending; },
            writeHead: function(code, obj) {
                if (res.headersSent) { throw new Error('ERR_HTTP_HEADERS_SENT'); }
                for (var k in obj) { pending[k.toLowerCase()] = obj[k]; }
                res.statusCode  = code;
                res.headersSent = true;
            }
        };
        return res;
    }

    // mirrors onInstance's gated per-request emission
    function emitPoweredBy(hidePoweredBy, res) {
        if ( !hidePoweredBy ) {
            res.setHeader('X-Powered-By', 'Gina/1.0.0-replica');
        }
    }

    // mirrors completeHeaders' env `server.response.header` loop — each
    // setHeader is gated on !headersSent, exactly like the source
    function applyResponseHeaderConf(resHeaders, res) {
        for (var h in resHeaders) {
            if ( !res.headersSent ) {
                res.setHeader(h, resHeaders[h]);
            }
        }
    }

    // the HTTP/1.1 error tail — 'fixed' = completeHeaders THEN writeHead
    // (shipped); 'legacy' = writeHead THEN completeHeaders (the subtract)
    function errorTailH1(order, resHeaders, res) {
        if (order === 'legacy') {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf8' });
            applyResponseHeaderConf(resHeaders, res);
        } else {
            applyResponseHeaderConf(resHeaders, res);
            res.writeHead(404, { 'content-type': 'application/json; charset=utf8' });
        }
    }

    it('default (no opt-in): the static-404 keeps the framework emission', function() {
        var res = makeRes();
        emitPoweredBy(false, res);
        errorTailH1('fixed', {}, res);
        assert.equal(res.getHeaders()['x-powered-by'], 'Gina/1.0.0-replica');
        assert.equal(res.statusCode, 404);
        assert.equal(res.getHeaders()['content-type'], 'application/json; charset=utf8');
    });

    it('server.hidePoweredBy: true — no header on the static-404 at all', function() {
        var res = makeRes();
        emitPoweredBy(true, res);
        errorTailH1('fixed', {}, res);
        assert.equal(typeof res.getHeaders()['x-powered-by'], 'undefined');
    });

    it('env response.header override reaches the HTTP/1.1 error response (fixed order)', function() {
        var res = makeRes();
        emitPoweredBy(false, res);
        errorTailH1('fixed', { 'X-Powered-By': '' }, res);
        assert.equal(res.getHeaders()['x-powered-by'], '',
            'the configured override must replace the framework emission on the 404');
    });

    it('SUBTRACT: the legacy writeHead-first order silently drops the override', function() {
        var res = makeRes();
        emitPoweredBy(false, res);
        errorTailH1('legacy', { 'X-Powered-By': '' }, res);
        assert.equal(res.getHeaders()['x-powered-by'], 'Gina/1.0.0-replica',
            'pre-fix order: headersSent gates the override loop, the raw emission survives — the reorder is load-bearing');
    });

    it('override still applies when the flag also suppressed the default emission', function() {
        var res = makeRes();
        emitPoweredBy(true, res);
        errorTailH1('fixed', { 'X-Powered-By': '' }, res);
        assert.equal(res.getHeaders()['x-powered-by'], '',
            'an explicit response.header entry wins regardless of the flag');
    });

    it('gate replica matrix: flag=false emits, flag=true does not', function() {
        var on = makeRes(), off = makeRes();
        emitPoweredBy(false, on);
        emitPoweredBy(true, off);
        assert.equal(on.getHeaders()['x-powered-by'], 'Gina/1.0.0-replica');
        assert.equal(typeof off.getHeaders()['x-powered-by'], 'undefined');
    });
});
