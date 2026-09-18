'use strict';
/**
 * #B550 — response-method hooks are skipped on the HTTP/2 render path.
 *
 * On HTTP/2 every render delegate writes with `stream.respond()` + `stream.end()`
 * on the raw stream and folds `res.getHeaders()` into the headers frame. It never
 * calls `res.writeHead` or `res.end`. A middleware that installs itself by WRAPPING
 * those two methods therefore never runs:
 *
 *   - a session middleware sets its cookie from an `on-headers` hook, which wraps
 *     ONLY `writeHead` — so no cookie is emitted, and a "rolling" expiry never rolls;
 *   - it persists the session from a proxy on `end` — so a mutation made during a
 *     rendered response is silently dropped.
 *
 * `getHeaders()` can only carry what `setHeader()` already wrote, so the existing
 * fold cannot recover a cookie that was never set.
 *
 * SCOPE OF THIS FIX (deliberately narrow — the class is NOT closed here):
 *   1. `redirect()`'s two XHR exits terminate through the compat response, as the
 *      sibling 303 exit already did. A session rotated immediately before the
 *      redirect now gets its new cookie to the client.
 *   2. the router's one-shot `inheritedData` consume persists itself instead of
 *      relying on the save-on-end proxy that the render path never triggers.
 * Still open, tracked separately: `rolling` on ordinary renders, and application
 * session mutations made during a render.
 *
 * WHICH PINS CAN GO RED — read this before trusting a green run:
 *   §01-§03 pin THE FIX. They are red on pre-change source (validated).
 *   §04-§05 pin THE MECHANISM the fix relies on — Node's own compat behaviour and
 *           the wrap contract of on-headers/express-session. They pass on BOTH
 *           corpora BY DESIGN. A green §04/§05 is NOT evidence the fix is present;
 *           it only says the ground the fix stands on has not moved.
 */
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var http2  = require('http2');

var FW          = require('../fw');
var RENDER_JSON = fs.readFileSync(path.join(FW, 'core/controller/controller.render-json.js'), 'utf8');
var CONTROLLER  = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
var ROUTER      = fs.readFileSync(path.join(FW, 'core/router.js'), 'utf8');

/** Strip line comments so a pin cannot be satisfied by the prose that documents it. */
function decomment(src) {
    return src.split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n');
}
var RENDER_JSON_CODE = decomment(RENDER_JSON);
var CONTROLLER_CODE  = decomment(CONTROLLER);
var ROUTER_CODE      = decomment(ROUTER);

function count(hay, needle) {
    var n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) > -1) { n++; i += needle.length; }
    return n;
}

// ── 01 — render-json.js honours and consumes the compat-send flag ────────────

describe('01 - render-json.js: compat-send opt-out of the raw HTTP/2 stream path', function() {

    it('the stream selection is gated on the flag', function() {
        assert.ok(
            RENDER_JSON_CODE.indexOf("if ( typeof(local.res.stream) != 'undefined' && !_forceCompatSend ) {") > -1,
            'expected the stream pick to carry the !_forceCompatSend term'
        );
    });

    it('the un-gated form is gone', function() {
        // Guard against a vacuous pass: the raw file must still contain the token
        // the negative pin is about, or a broken read would satisfy it trivially.
        assert.ok(RENDER_JSON.indexOf('local.res.stream') > -1, 'instrument check: token absent from the raw file');
        assert.equal(
            count(RENDER_JSON_CODE, "if ( typeof(local.res.stream) != 'undefined') {"), 0,
            'the un-gated stream pick must not survive'
        );
    });

    it('the flag is read strictly and cleared after one use', function() {
        assert.ok(
            RENDER_JSON_CODE.indexOf('var _forceCompatSend = !!(local.req && local.req._ginaForceCompatSend === true);') > -1,
            'expected a strict === true read'
        );
        assert.ok(
            RENDER_JSON_CODE.indexOf('delete local.req._ginaForceCompatSend;') > -1,
            'expected the flag to be consumed, so it cannot leak into a later render'
        );
    });

    it('the flag is consumed BEFORE the stream is picked', function() {
        var consume = RENDER_JSON_CODE.indexOf('delete local.req._ginaForceCompatSend;');
        var pick    = RENDER_JSON_CODE.indexOf("&& !_forceCompatSend ) {");
        assert.ok(consume > -1 && pick > -1, 'both sites must exist');
        assert.ok(consume < pick, 'the consume must precede the stream pick');
    });
});

// ── 02 — controller.js sets the flag at both redirect XHR exits ──────────────

describe('02 - controller.js: both XHR redirect exits take the compat path', function() {

    it('exactly two exits set the flag', function() {
        assert.equal(
            count(CONTROLLER_CODE, 'req._ginaForceCompatSend = true;'), 2,
            'expected exactly 2 flagged exits (the XHR redirect and the popin redirect)'
        );
    });

    it('each flag is set immediately before a renderJSON call', function() {
        var re = /req\._ginaForceCompatSend = true;\s*(return\s+)?self\.renderJSON\(/g;
        var m = CONTROLLER_CODE.match(re) || [];
        assert.equal(m.length, 2, 'each flag must immediately precede its renderJSON call');
    });

    it('the 303 exit still terminates through the compat response', function() {
        // The fix makes the XHR exits agree with this one; if it ever stops using
        // writeHead/end, the premise of §02 is gone and this file must be revisited.
        assert.ok(CONTROLLER_CODE.indexOf('res.writeHead(code, headInfos);') > -1,
            'the 303 exit must still call res.writeHead');
        assert.ok(CONTROLLER_CODE.indexOf('res.end(redirectObject);') > -1,
            'the 303 exit must still call res.end');
    });
});

// ── 03 — router.js persists the one-shot inheritedData consume ───────────────

describe('03 - router.js: the inheritedData consume reaches the store', function() {

    it('a guarded session save follows the delete', function() {
        var del  = ROUTER_CODE.indexOf('delete userSession.inheritedData;');
        var save = ROUTER_CODE.indexOf('request.session.save(function onInheritedDataConsumePersisted(');
        assert.ok(del > -1, 'the one-shot delete must still exist');
        assert.ok(save > -1, 'expected an explicit save for the consume');
        assert.ok(save > del, 'the save must follow the delete');
    });

    it('the save is typeof-guarded, like the login save sites', function() {
        var save = ROUTER_CODE.indexOf('request.session.save(function onInheritedDataConsumePersisted(');
        var head = ROUTER_CODE.lastIndexOf("if ( typeof(request.session.save) == 'function' ) {", save);
        assert.ok(head > -1 && head < save, 'expected a typeof guard immediately above the save');
    });

    it('the pre-existing login saves are untouched', function() {
        assert.equal(count(ROUTER_CODE, 'req.session.save(function onLoginSessionSaved('), 1);
        assert.equal(count(ROUTER_CODE, 'req.session.save(function onLoginSessionSavedNoRotation('), 1);
    });
});

// ── 04/05 — MECHANISM pins (green on both corpora by design; see the header) ──

var servers = [];
after(function() { servers.forEach(function(s) { try { s.close(); } catch (e) {} }); });

/**
 * Minimal stand-in for the wrap contract this fix depends on, modelled on the
 * real modules: `on-headers` replaces ONLY `res.writeHead` and fires its listener
 * once, before the original; a session middleware replaces ONLY `res.end` and
 * commits before delegating. Drives REAL node HTTP/2 objects.
 */
function installHooks(res, seen) {
    var prevWriteHead = res.writeHead, fired = false;
    res.writeHead = function() {
        if (!fired) { fired = true; seen.writeHead = true; res.setHeader('set-cookie', 'probe.sid=1; Path=/'); }
        return prevWriteHead.apply(res, arguments);
    };
    var prevEnd = res.end;
    res.end = function() { seen.end = true; return prevEnd.apply(res, arguments); };
}

function drive(handler, cb) {
    var server = http2.createServer();
    servers.push(server);
    server.listen(0, '127.0.0.1', function() {
        var client = http2.connect('http://127.0.0.1:' + server.address().port);
        var req = client.request({ ':path': '/' });
        var headers = null;
        req.on('response', function(h) { headers = h; });
        req.on('end', function() { client.close(); server.close(); cb(headers); });
        req.resume();
    });
    server.on('request', handler);
}

describe('04 - MECHANISM: the raw stream path fires neither hook', function() {
    it('stream.respond()/stream.end() skip writeHead and end', function(t, done) {
        var seen = {};
        drive(function(req, res) {
            installHooks(res, seen);
            res.setHeader('content-type', 'application/json');
            res.stream.respond(Object.assign({ ':status': 200 }, res.getHeaders()));
            res.stream.end('{}');
        }, function(headers) {
            assert.equal(seen.writeHead, undefined, 'writeHead must NOT have fired');
            assert.equal(seen.end, undefined, 'end must NOT have fired');
            assert.equal(headers['set-cookie'], undefined, 'no cookie can reach the wire');
            done();
        });
    });
});

describe('05 - MECHANISM: the compat path fires both hooks', function() {
    it('a bare res.end() fires writeHead, and the cookie reaches the wire', function(t, done) {
        var seen = {};
        drive(function(req, res) {
            installHooks(res, seen);
            res.setHeader('content-type', 'application/json');
            res.end('{}');                     // the shape render-json's compat branch uses
        }, function(headers) {
            assert.equal(seen.end, true, 'the end proxy must run — this is what persists a session');
            assert.equal(seen.writeHead, true, 'node drives writeHead from end(), firing the cookie hook');
            assert.deepEqual(headers['set-cookie'], ['probe.sid=1; Path=/'],
                'the cookie set from the writeHead hook must reach the wire');
            done();
        });
    });
});
