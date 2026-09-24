'use strict';
/**
 * core/server.isaac.rapid-reset.js — the HTTP/2 rapid-reset guard's counting policy
 * (#H9, re-scoped by #B611; the never-firing rstCount listener, #B614).
 *
 * The module is framework-free, so these arms drive the REAL functions against a bare
 * `node:http2` server: which close shapes count as a client reset (a RST_STREAM of any
 * code, a client stream timeout), which do not (a server-side destroy, a session
 * teardown, a reset after the response completed), the window step, and — the defect
 * this guard replaced — that a caller multiplexing hundreds of completed requests on
 * ONE session inside one second never trips it (bundle-to-bundle audit, 2026-09-24:
 * the previous new-stream counter GOAWAY'd a sibling bundle at 200 calls/s).
 *
 * The former server.isaac.test.js §07b replica cases live here as §02, against the
 * real `countReset`.
 *
 * §03b / §03c (#B615): the discriminator is picked by RUNTIME at load — Bun's server
 * closes a stream before emitting `aborted` for a reset it received, so the Bun rule
 * reads `state.localClose`, while node keeps `stream.destroyed`. The §04 live arms
 * therefore run unchanged under both `node --test` and `bun test`: their expectations
 * are the correct behaviour on every runtime (the Bun CI leg turned red on exactly the
 * two arms the node rule missed on Bun 1.4).
 */
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var http2 = require('node:http2');

var MODULE = path.join(require('../fw'), 'core', 'server.isaac.rapid-reset.js');
var guard = require(MODULE);
var C = http2.constants;

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// Every live handle is registered here and torn down by the file-level after() as well
// as by each arm — a failed assertion must never leave a server holding the loop open.
var LIVE = { servers: [], clients: [] };
after(function() {
    LIVE.clients.forEach(function(c) { try { c.destroy(); } catch (e) {} });
    LIVE.servers.forEach(function(h) { h.S.sessions.forEach(function(s) { try { s.destroy(); } catch (e) {} }); try { h.server.close(); } catch (e) {} });
});

// One bare h2c server per live arm. `respond(stream)` is the responder; the guard is
// armed on every stream with spy hooks; on a breach the engine's three effect lines are
// mirrored (rapidResetBlocked++, GOAWAY(ENHANCE_YOUR_CALM), close) so the client-visible
// outcome is measured too.
function mkServer(max, respond, opts) {
    var server = http2.createServer(opts || {});
    var S = { streams: 0, resets: 0, breaches: [], blocked: 0, aborted: 0, sessions: [] };
    LIVE.servers.push({ server: server, S: S });
    server.on('session', function(session) {
        S.sessions.push(session);
        session.on('error', function() {});
        session.on('stream', function(stream) {
            S.streams++;
            stream.on('error', function() {});
            stream.on('aborted', function() { S.aborted++; });
            guard.attach(session, stream, max, {
                onReset  : function() { S.resets++; },
                onBreach : function(count, limit) {
                    S.breaches.push([count, limit]);
                    S.blocked++;
                    session.goaway(C.NGHTTP2_ENHANCE_YOUR_CALM);
                    session.close();
                }
            });
            respond(stream, session);
        });
    });
    return new Promise(function(res) {
        server.listen(0, '127.0.0.1', function() { res({ server: server, S: S, port: server.address().port }); });
    });
}
function teardown(h, client) {
    try { if (client) client.destroy(); } catch (e) {}
    h.S.sessions.forEach(function(s) { try { s.destroy(); } catch (e) {} });
    try { h.server.close(); } catch (e) {}
}
function connect(port) {
    var client = http2.connect('http://127.0.0.1:' + port);
    LIVE.clients.push(client);
    var st = { goaway: [] };
    client.on('error', function() {});
    client.on('goaway', function(code, last) { st.goaway.push({ code: code, lastStreamID: last }); });
    return new Promise(function(res) { client.on('connect', function() { res({ client: client, st: st }); }); });
}
var asyncResponder = function(ms) {
    return function(stream) {
        setTimeout(function() {
            if (!stream.closed && !stream.destroyed) { try { stream.respond({ ':status': 200 }); stream.end('ok'); } catch (e) {} }
        }, ms);
    };
};

describe('01 - resolveMaxResetsPerSecond', function() {
    it('defaults to 200 when http2Options is absent, not an object, empty, or carries no numeric limit', function() {
        assert.equal(guard.resolveMaxResetsPerSecond(undefined), 200);
        assert.equal(guard.resolveMaxResetsPerSecond(null), 200);
        assert.equal(guard.resolveMaxResetsPerSecond('string'), 200);
        assert.equal(guard.resolveMaxResetsPerSecond({}), 200);
        assert.equal(guard.resolveMaxResetsPerSecond({ maxStreamResetsPerSecond: 'many' }), 200);
        assert.equal(guard.DEFAULT_MAX_RESETS_PER_SECOND, 200);
    });
    it('honours a custom maxStreamResetsPerSecond (floored to an integer)', function() {
        assert.equal(guard.resolveMaxResetsPerSecond({ maxStreamResetsPerSecond: 50 }), 50);
        assert.equal(guard.resolveMaxResetsPerSecond({ maxStreamResetsPerSecond: 1000 }), 1000);
        assert.equal(guard.resolveMaxResetsPerSecond({ maxStreamResetsPerSecond: 7.9 }), 7);
    });
    it('0 and negative values fall back to 200 — the guard cannot be disabled', function() {
        assert.equal(guard.resolveMaxResetsPerSecond({ maxStreamResetsPerSecond: 0 }), 200);
        assert.equal(guard.resolveMaxResetsPerSecond({ maxStreamResetsPerSecond: -5 }), 200);
    });
    it('the pre-0.6.33 key maxStreamsPerSecond is NOT read (#B611): a raised workaround value does not widen the reset limit', function() {
        assert.equal(guard.resolveMaxResetsPerSecond({ maxStreamsPerSecond: 1000000 }), 200);
        assert.equal(guard.resolveMaxResetsPerSecond({ maxStreamsPerSecond: 1000000, maxStreamResetsPerSecond: 50 }), 50);
    });
});

describe('02 - countReset: the per-session rolling window step', function() {
    it('the first reset initialises the window and does not breach', function() {
        var session = {};
        assert.equal(guard.countReset(session, 1000, 5), false);
        assert.equal(session._resetWindowStart, 1000);
        assert.equal(session._resetWindowCount, 1);
    });
    it('resets up to the limit within one window do not breach', function() {
        var session = {};
        for (var i = 0; i < 5; i++) { assert.equal(guard.countReset(session, 1000, 5), false, 'reset ' + (i + 1) + ' must not breach'); }
        assert.equal(session._resetWindowCount, 5);
    });
    it('the reset past the limit within one window breaches (count > max)', function() {
        var session = {};
        for (var i = 0; i < 5; i++) { guard.countReset(session, 1000, 5); }
        assert.equal(guard.countReset(session, 1000, 5), true, '6th reset in a window with limit 5 must breach');
        assert.equal(session._resetWindowCount, 6);
    });
    it('the window resets after 1000ms — count starts over, no breach', function() {
        var session = {};
        for (var i = 0; i < 5; i++) { guard.countReset(session, 1000, 5); }
        assert.equal(guard.countReset(session, 2000, 5), false);
        assert.equal(session._resetWindowStart, 2000);
        assert.equal(session._resetWindowCount, 1);
    });
    it('the window boundary is inclusive — exactly 1000ms elapsed starts a fresh window (>= WINDOW_MS)', function() {
        var session = {};
        guard.countReset(session, 1000, 5);
        guard.countReset(session, 1999, 5);
        assert.equal(session._resetWindowCount, 2);
        guard.countReset(session, 2000, 5);
        assert.equal(session._resetWindowStart, 2000);
        assert.equal(session._resetWindowCount, 1);
        assert.equal(guard.WINDOW_MS, 1000);
    });
    it('a sustained flood breaches once per over-limit reset; a quiet next window does not', function() {
        var session = {}, w1 = 0, w2 = 0;
        for (var i = 0; i < 10; i++) { if (guard.countReset(session, 1000, 5)) { w1++; } }
        assert.equal(w1, 5, 'resets 6-10 in window 1 each breach');
        for (var j = 0; j < 3; j++) { if (guard.countReset(session, 2000, 5)) { w2++; } }
        assert.equal(w2, 0);
        assert.equal(session._resetWindowCount, 3);
    });
    it('per-session windows are independent — one session flooding does not breach another', function() {
        var a = {}, b = {};
        for (var i = 0; i < 6; i++) { guard.countReset(a, 1000, 5); }
        assert.equal(guard.countReset(b, 1000, 5), false);
        assert.equal(a._resetWindowCount, 6);
        assert.equal(b._resetWindowCount, 1);
    });
});

describe('03 - isClientReset: the aborted-time discriminator', function() {
    it('a live stream on a live session is a client reset', function() {
        assert.equal(guard.isClientReset({ closed: false, destroyed: false }, { destroyed: false }), true);
    });
    it('a stream the engine destroyed is not (stream.destroyed at aborted time)', function() {
        assert.equal(guard.isClientReset({ closed: false, destroyed: false }, { destroyed: true }), false);
    });
    it('a session teardown is not (session.closed / session.destroyed)', function() {
        assert.equal(guard.isClientReset({ closed: true, destroyed: false }, { destroyed: false }), false);
        assert.equal(guard.isClientReset({ closed: false, destroyed: true }, { destroyed: false }), false);
    });
    it('missing arguments never count', function() {
        assert.equal(guard.isClientReset(null, { destroyed: false }), false);
        assert.equal(guard.isClientReset({ closed: false }, null), false);
    });
});

describe('03b - isClientResetOnBun: the aborted-time discriminator on Bun (#B615)', function() {
    var live = { closed: false, destroyed: false };

    it('a received reset — Bun closes the stream before emitting aborted, so state.localClose reads 1 — is a client reset whatever stream.destroyed reads', function() {
        assert.equal(guard.isClientResetOnBun(live, { destroyed: true,  state: { state: 7, localClose: 1, remoteClose: 1 } }), true, 'the Bun 1.4 shape: destroyed already true for a non-CANCEL reset');
        assert.equal(guard.isClientResetOnBun(live, { destroyed: false, state: { state: 7, localClose: 1, remoteClose: 1 } }), true, 'the Bun 1.2 / 1.3 shape');
    });

    it('the engine\'s own destroy() / close() emits aborted with the local side still open (localClose 0) — not a client reset, whatever stream.destroyed reads', function() {
        assert.equal(guard.isClientResetOnBun(live, { destroyed: true,  state: { state: 6, localClose: 0, remoteClose: 1 } }), false, 'Bun 1.4: own destroy');
        assert.equal(guard.isClientResetOnBun(live, { destroyed: false, state: { state: 6, localClose: 0, remoteClose: 1 } }), false, 'Bun 1.2 / 1.3: own destroy, or close(code) on any Bun');
        assert.equal(guard.isClientResetOnBun(live, { destroyed: false, state: { state: 2, localClose: 0, remoteClose: 0 } }), false, 'own destroy with the request body still open');
    });

    it('a session teardown is not — even when the stream reads localClose 1', function() {
        assert.equal(guard.isClientResetOnBun({ closed: true,  destroyed: false }, { destroyed: false, state: { localClose: 1 } }), false);
        assert.equal(guard.isClientResetOnBun({ closed: false, destroyed: true  }, { destroyed: false, state: { localClose: 1 } }), false);
    });

    it('fail-closed: an unreadable state COUNTS — a missed reset is the hole the guard exists to close', function() {
        assert.equal(guard.isClientResetOnBun(live, { destroyed: false }), true, 'no state at all');
        assert.equal(guard.isClientResetOnBun(live, { destroyed: true, state: {} }), true, 'an empty state (node\'s shape for a destroyed stream)');
        assert.equal(guard.isClientResetOnBun(live, { destroyed: false, state: { localClose: '1' } }), true, 'a non-numeric localClose');
        var throwing = { destroyed: false };
        Object.defineProperty(throwing, 'state', { get: function() { throw new Error('gone'); } });
        assert.equal(guard.isClientResetOnBun(live, throwing), true, 'a throwing state getter');
    });

    it('missing arguments never count', function() {
        assert.equal(guard.isClientResetOnBun(null, { destroyed: false, state: { localClose: 1 } }), false);
        assert.equal(guard.isClientResetOnBun(live, null), false);
    });
});

describe('03c - the discriminator is picked by RUNTIME at load, never by feature (#B615)', function() {
    it('RUNTIME_IS_BUN reflects this process, and isClientResetActive is the matching rule', function() {
        var isBun = !!(process.versions && process.versions.bun);
        assert.equal(guard.RUNTIME_IS_BUN, isBun);
        assert.equal(guard.isClientResetActive, isBun ? guard.isClientResetOnBun : guard.isClientReset);
        assert.notEqual(guard.isClientResetOnBun, guard.isClientReset, 'control: the two rules are distinct functions');
    });

    it('the node rule and the Bun rule disagree on the shapes that made #B615 — which is why the pick is by runtime', function() {
        var live = { closed: false, destroyed: false };
        var bun14PeerReset  = { destroyed: true,  state: { localClose: 1, remoteClose: 1 } }; // Bun 1.4: a received non-CANCEL reset
        var bun13OwnDestroy = { destroyed: false, state: { localClose: 0, remoteClose: 1 } }; // Bun 1.2 / 1.3: the engine's own destroy
        var nodePeerReset   = { destroyed: false, state: { localClose: 0, remoteClose: 1 } }; // node: a received reset — the SAME state as the Bun own-destroy: only the runtime tells them apart
        assert.equal(guard.isClientReset(live, bun14PeerReset), false, 'the node rule misses it');
        assert.equal(guard.isClientResetOnBun(live, bun14PeerReset), true);
        assert.equal(guard.isClientReset(live, bun13OwnDestroy), true, 'the node rule over-counts it');
        assert.equal(guard.isClientResetOnBun(live, bun13OwnDestroy), false);
        assert.equal(guard.isClientReset(live, nodePeerReset), true);
        assert.equal(guard.isClientResetOnBun(live, nodePeerReset), false, 'the Bun rule would MISS a node peer reset — never select it on node');
    });
});

describe('04 - live: which close shapes the guard counts (bare node:http2, real attach)', function() {

    it('a rapid-reset client (open + immediate RST_STREAM) breaches at max+1 and is GOAWAY\'d with ENHANCE_YOUR_CALM; the teardown\'s own aborts are not counted', async function() {
        var h = await mkServer(5, asyncResponder(60));
        var c = await connect(h.port);
        // 12 streams opened first (all in flight on the 60 ms responder), then 6 of them
        // reset by the client: the 6th reset breaches -> GOAWAY + close -> the other 6
        // in-flight streams abort as TEARDOWN, which must not be counted.
        var reqs = [];
        for (var i = 0; i < 12; i++) { var r = c.client.request({ ':path': '/' }); r.on('error', function() {}); r.resume(); reqs.push(r); }
        await sleep(10);
        for (var j = 0; j < 6; j++) { reqs[j].close(C.NGHTTP2_CANCEL); }
        await sleep(300);
        assert.equal(h.S.streams, 12, 'all 12 streams reached the server');
        assert.equal(h.S.resets, 6, '6 client resets counted (the breaching one included)');
        assert.deepEqual(h.S.breaches, [[6, 5]], 'exactly one breach, at count 6 > limit 5');
        assert.equal(h.S.blocked, 1);
        assert.ok(h.S.aborted >= 6, 'the teardown aborted the remaining in-flight streams too (' + h.S.aborted + ' aborted events in total)');
        assert.equal(c.st.goaway.length, 1, 'the client received exactly one GOAWAY');
        assert.equal(c.st.goaway[0].code, C.NGHTTP2_ENHANCE_YOUR_CALM, 'GOAWAY code 11 — not nghttp2\'s INTERNAL_ERROR');
        teardown(h, c.client);
    });

    it('#B611 control — 300 completed requests multiplexed on ONE session inside one second: 0 resets, 0 breaches, 300 answers', async function() {
        var h = await mkServer(5, function(stream) { stream.respond({ ':status': 200 }); stream.end('ok'); });
        var c = await connect(h.port);
        var answered = 0;
        var t0 = Date.now();
        for (var i = 0; i < 300; i++) {
            await new Promise(function(res) {
                var r = c.client.request({ ':path': '/' });
                r.on('error', function() { res(); });
                r.on('response', function(hd) { if (hd[':status'] === 200) answered++; });
                r.resume();
                r.on('end', res);
            });
        }
        var elapsed = Date.now() - t0;
        assert.equal(answered, 300);
        assert.equal(h.S.streams, 300);
        assert.equal(h.S.resets, 0, 'a completed stream is not a reset');
        assert.equal(h.S.blocked, 0, 'the caller was not GOAWAY\'d — the previous new-stream counter would have tripped at stream 6');
        assert.equal(c.st.goaway.length, 0);
        assert.ok(elapsed < 5000, 'the 300 calls ran in ' + elapsed + ' ms');
        teardown(h, c.client);
    });

    it('a client reset with code 0 (NO_ERROR) before the response is a reset all the same — the code is not the signal', async function() {
        var h = await mkServer(5, asyncResponder(60));
        var c = await connect(h.port);
        var r = c.client.request({ ':path': '/' }); r.on('error', function() {}); r.resume();
        await sleep(10);
        r.close(C.NGHTTP2_NO_ERROR);
        await sleep(150);
        assert.equal(h.S.resets, 1, 'counted');
        assert.equal(h.S.blocked, 0);
        teardown(h, c.client);
    });

    it('a client stream timeout (the caller destroys its request) before the response is a reset', async function() {
        var h = await mkServer(5, asyncResponder(300));
        var c = await connect(h.port);
        var r = c.client.request({ ':path': '/' }); r.on('error', function() {}); r.resume();
        r.setTimeout(20, function() { r.destroy(); });
        await sleep(200);
        assert.equal(h.S.resets, 1);
        teardown(h, c.client);
    });

    it('a SERVER-side destroy of an unfinished stream is not a client reset', async function() {
        var h = await mkServer(5, function(stream) {
            stream.respond({ ':status': 200 }); stream.write('partial');
            setTimeout(function() { stream.destroy(); }, 10);
        });
        var c = await connect(h.port);
        var r = c.client.request({ ':path': '/' }); r.on('error', function() {}); r.resume();
        await sleep(150);
        assert.equal(h.S.aborted, 1, 'control: the abort event itself fired');
        assert.equal(h.S.resets, 0, 'but the engine did it, so it is not counted');
        teardown(h, c.client);
    });

    it('a client RST_STREAM after the response completed never reaches this layer (the stream is already closed)', async function() {
        var h = await mkServer(5, function(stream) { stream.respond({ ':status': 200 }); stream.end('ok'); });
        var c = await connect(h.port);
        await new Promise(function(res) {
            var r = c.client.request({ ':path': '/' }); r.on('error', function() {}); r.resume();
            r.on('end', function() { try { r.close(C.NGHTTP2_CANCEL); } catch (e) {} setTimeout(res, 100); });
        });
        assert.equal(h.S.aborted, 0);
        assert.equal(h.S.resets, 0, 'post-completion resets are invisible here — only nghttp2\'s own limiter counts them');
        teardown(h, c.client);
    });

    it('a session the ENGINE tears down with streams in flight counts none of their aborts — goaway(ENHANCE_YOUR_CALM) + close(), the breach shape', async function() {
        var h = await mkServer(5, function(stream, session) {
            if (h.S.streams === 3) { session.goaway(C.NGHTTP2_ENHANCE_YOUR_CALM); session.close(); }
        });
        var c = await connect(h.port);
        for (var i = 0; i < 3; i++) { var r = c.client.request({ ':path': '/' }); r.on('error', function() {}); r.resume(); }
        await sleep(200);
        assert.equal(h.S.streams, 3);
        assert.ok(h.S.aborted >= 1, 'control: the teardown aborted in-flight streams (' + h.S.aborted + ')');
        assert.equal(h.S.resets, 0);
        assert.equal(h.S.blocked, 0);
        teardown(h, c.client);
    });

    it('a session the ENGINE destroys with streams in flight counts none of their aborts either', async function() {
        var h = await mkServer(5, function(stream, session) {
            if (h.S.streams === 3) { session.destroy(); }
        });
        var c = await connect(h.port);
        for (var i = 0; i < 3; i++) { var r = c.client.request({ ':path': '/' }); r.on('error', function() {}); r.resume(); }
        await sleep(200);
        assert.equal(h.S.streams, 3);
        assert.ok(h.S.aborted >= 1, 'control: the destroy aborted in-flight streams (' + h.S.aborted + ')');
        assert.equal(h.S.resets, 0);
        assert.equal(h.S.blocked, 0);
        teardown(h, c.client);
    });
});
