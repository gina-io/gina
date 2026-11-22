/**
 * #B364 — SuperController.push() recipient contract.
 *
 * The shipped defect, live in every release up to and including 0.6.7: the
 * recipient was read from the REQUEST BODY (`req[method].sessionID`), so a
 * caller could aim a push at any session by sending an id — and an ABSENT id
 * meant "send to EVERY connected client". The payload defaults to request
 * input too, so any route reaching push() handed an unprivileged caller a
 * broadcast primitive. Measured pre-fix with a faithful closure: no id in the
 * body delivered to every socket; an id in the body delivered to that session.
 *
 * ⚠️ INSTRUMENT WARNING — READ BEFORE REUSING THIS HARNESS.
 * controller.js cannot be required standalone (it needs the framework
 * bootstrap), so these tests slice the real shipped body of push() out of the
 * file and execute it. `new Function` compiles its body in GLOBAL scope and
 * captures NO lexical closure, so every identifier push() closes over must be
 * supplied deliberately. `push()` is nested inside `function
 * SuperController(options)`, and the send site's `options` is THAT CONSTRUCTOR
 * PARAMETER — not a free variable. A harness that omits it manufactures a
 * ReferenceError that production never raises, and will report "nothing is
 * ever delivered" no matter what the code does. That mistake was made during
 * this triage and produced a confidently wrong "not exploitable" verdict, so:
 * model the closure, and prove it by checking the harness reproduces the
 * PRE-fix behaviour you already know to be true.
 *
 * §01 source-pins the fixed shape so the slice cannot silently drift.
 * §07 is the INSTRUMENT VALIDATION: a case that must DELIVER. Without it the
 * zero-delivery assertions below cannot be distinguished from a broken probe —
 * though note that a delivery control alone does NOT catch the scope error
 * above, which is exactly why it went unnoticed.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var path = require('path');
var commentStrip = require('../strip-comments');

var SOURCE = path.join(require('../fw'), 'core/controller/controller.js');
var src    = fs.readFileSync(SOURCE, 'utf8');

// ── slice the real push() body ────────────────────────────────────────────────
var SIG  = 'this.push = function(payload, option, callback) {';
var at   = src.indexOf(SIG);
var open = src.indexOf('{', at + SIG.length - 1);
var depth = 0, end = -1;
for (var i = open; i < src.length && at > -1; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
var BODY = (at > -1 && end > -1) ? src.slice(open + 1, end) : null;

// The negative pins below assert an identifier is ABSENT — but the fix's own
// comments name the defects they replaced ("was `options`…", "used to be
// `req[method].sessionID`"), so grepping the raw slice matches the PROSE and
// reports the bug as still present. Strip comments first: the pins must read
// executable code only. (The shared lexer leaves a `//` inside a string, such as `http://`, alone.)
var CODE = BODY == null ? null : commentStrip.all(BODY);

/**
 * Runs the real push() body against fake engine.io clients.
 * @returns {{delivered: array, thrown: (Error|null), warned: array}}
 */
function drive(opts) {
    opts = opts || {};
    var delivered = [], warned = [], thrown = null;

    function sock(id, ctorName) {
        return {
            sessionId: id,
            constructor: { name: ctorName || 'Socket' },
            sendPacket: function(type, payload, option, cb) {
                delivered.push({ to: id, type: type, payload: payload, option: option });
            }
        };
    }

    var clients = {};
    (opts.clients || [ { id: 'SESSION-CALLER' }, { id: 'SESSION-OTHER' } ]).forEach(function(c, n) {
        clients['c' + n] = sock(c.id, c.ctor);
    });

    var req = {
        method: 'POST',
        post: opts.body || {},
        params: {}, get: {}
    };
    if (typeof opts.reqSessionID !== 'undefined') { req.sessionID = opts.reqSessionID; }

    var local = { req: opts.released ? null : req, res: {} };
    // #B371 — `noChannel` models the express engine, which attaches no engine.io.
    // Default is unchanged, so every arm written before this option is untouched.
    var self  = {
        serverInstance: opts.noChannel ? {} : { eio: { clients: clients } },
        throwError: function(err) { thrown = err; }
    };

    var realWarn = console.warn;
    console.warn = function(m) { warned.push(String(m)); };
    try {
        var fn = new Function('payload,option,callback,local,self', BODY);
        fn(opts.payload || { evt: 'x' }, opts.option, opts.callback, local, self);
    } catch (e) {
        thrown = e;
    } finally {
        console.warn = realWarn;
    }

    return { delivered: delivered, thrown: thrown, warned: warned };
}

describe('01 - #B364 source pins (the slice must stay the fixed shape)', function() {
    it('slices a non-empty push() body', function() {
        assert.ok(BODY && BODY.length > 200, 'push() body not sliced from ' + SOURCE);
    });

    it('strips comments for the negative pins (instrument check)', function() {
        // The control: the raw slice DOES contain the words, in the fix's own
        // comments. If this ever reads false the strip has stopped working and
        // the negative pins below would pass vacuously.
        assert.ok(/options/.test(BODY), 'expected the comments to mention `options`');
        assert.equal(/options/.test(CODE), false, 'comment strip failed — negative pins are unreliable');
    });

    it('sends with `option` — never the undeclared `options`', function() {
        assert.match(CODE, /sendPacket\("message", payload, option, callback\)/);
        assert.equal(/sendPacket\([^)]*\boptions\b/.test(CODE), false,
            'the undeclared `options` identifier is back at the send site');
    });

    it('uses a strict !== type guard, not the always-false `!x == "Socket"`', function() {
        assert.match(CODE, /constructor\.name\s*!==\s*'Socket'/);
        assert.equal(/!clients\[s\]\.constructor\.name\s*==/.test(CODE), false,
            'the inert (!name) == "Socket" guard is back');
    });

    it('never reads the recipient from the request body', function() {
        assert.equal(/req\[method\]\.sessionID/.test(CODE), false,
            'the recipient is being read from request input again');
    });

    it('broadcasts only on a strict `option.broadcast === true`', function() {
        assert.match(CODE, /option\.broadcast === true/);
    });
});

describe('02 - #B364 default recipient is the caller\'s own session', function() {
    it('delivers to the caller session only', function() {
        var r = drive({ reqSessionID: 'SESSION-CALLER' });
        assert.equal(r.thrown, null);
        assert.deepEqual(r.delivered.map(function(d) { return d.to; }), [ 'SESSION-CALLER' ]);
    });

    it('forwards `option` to the transport (the identifier that used to throw)', function() {
        var opt = { compress: true };
        var r = drive({ reqSessionID: 'SESSION-CALLER', option: opt });
        assert.equal(r.delivered.length, 1);
        assert.equal(r.delivered[0].option, opt);
    });

    it('falls back to req.session.id when req.sessionID is absent', function() {
        var r = drive({ reqSessionID: undefined, clients: [ { id: 'SID-9' } ] });
        assert.equal(r.delivered.length, 0);   // neither present in this arm
        var r2 = drive({ reqSessionID: 'SID-9', clients: [ { id: 'SID-9' } ] });
        assert.equal(r2.delivered.length, 1);
    });
});

describe('03 - #B364 an explicit server-supplied sessionID wins', function() {
    it('targets option.sessionID over the caller session', function() {
        var r = drive({ reqSessionID: 'SESSION-CALLER', option: { sessionID: 'SESSION-OTHER' } });
        assert.deepEqual(r.delivered.map(function(d) { return d.to; }), [ 'SESSION-OTHER' ]);
    });

    it('ignores a non-string / empty sessionID and uses the caller session', function() {
        var r = drive({ reqSessionID: 'SESSION-CALLER', option: { sessionID: '' } });
        assert.deepEqual(r.delivered.map(function(d) { return d.to; }), [ 'SESSION-CALLER' ]);
    });
});

describe('04 - #B364 broadcast is opt-in and strict', function() {
    it('reaches every client on { broadcast: true }', function() {
        var r = drive({ reqSessionID: 'SESSION-CALLER', option: { broadcast: true } });
        assert.equal(r.delivered.length, 2);
    });

    it('a truthy-but-not-true broadcast does NOT broadcast', function() {
        var r = drive({ reqSessionID: 'SESSION-CALLER', option: { broadcast: 'yes' } });
        assert.deepEqual(r.delivered.map(function(d) { return d.to; }), [ 'SESSION-CALLER' ]);
    });
});

describe('05 - #B364 fails CLOSED with no resolvable recipient', function() {
    it('sends nothing and warns when there is no session and no option', function() {
        var r = drive({ reqSessionID: undefined });
        assert.equal(r.delivered.length, 0);
        assert.equal(r.thrown, null);
        assert.equal(r.warned.length, 1);
        assert.match(r.warned[0], /no recipient/i);
    });

    it('is a no-op on a released request (#B38)', function() {
        var r = drive({ released: true, reqSessionID: 'SESSION-CALLER' });
        assert.equal(r.delivered.length, 0);
        assert.equal(r.warned.length, 0);
    });
});

describe('06 - #B364 SECURITY: the request body cannot choose recipients', function() {
    it('a sessionID in the request body is ignored, not honoured', function() {
        var r = drive({
            reqSessionID: 'SESSION-CALLER',
            body: { sessionID: 'SESSION-OTHER', payload: { evt: 'x' } }
        });
        assert.deepEqual(r.delivered.map(function(d) { return d.to; }), [ 'SESSION-CALLER' ],
            'request input steered the push to another session');
    });

    it('a request with NO sessionID does not broadcast (the pre-fix failure)', function() {
        var r = drive({ reqSessionID: undefined, body: { payload: { evt: 'x' } } });
        assert.equal(r.delivered.length, 0,
            'absent recipient fell back to broadcasting at every connected client');
    });
});

describe('07 - #B364 instrument validation + non-socket skip', function() {
    // Without this the zeros above could come from a probe that never delivers.
    it('POSITIVE CONTROL: the harness can and does report delivery', function() {
        var r = drive({ reqSessionID: 'SESSION-CALLER', option: { broadcast: true } });
        assert.ok(r.delivered.length > 0, 'harness cannot report delivery — every other assertion here is void');
    });

    it('skips entries whose constructor is not Socket (guard now fires)', function() {
        var r = drive({
            option: { broadcast: true },
            reqSessionID: 'SESSION-CALLER',
            clients: [ { id: 'A' }, { id: 'B', ctor: 'NotASocket' } ]
        });
        assert.deepEqual(r.delivered.map(function(d) { return d.to; }), [ 'A' ]);
    });
});

describe('08 - #B371 a missing engine.io channel refuses by name', function() {
    it('pins the guard in source, not just in behaviour', function() {
        assert.match(CODE, /serverInstance\.eio == null/);
        assert.match(CODE, /PUSH_CHANNEL_NOT_CONFIGURED/);
    });

    it('sends nothing and does NOT fail the request', function() {
        var r = drive({ reqSessionID: 'SESSION-CALLER', noChannel: true });
        assert.equal(r.delivered.length, 0, 'nothing may be sent without a channel');
        assert.equal(r.thrown, null, 'a missing channel must not take down the request');
    });

    it('warns, naming the engine that carries the channel', function() {
        var r = drive({ reqSessionID: 'SESSION-CALLER', noChannel: true });
        assert.equal(r.warned.length, 1);
        assert.match(r.warned[0], /no engine\.io channel/);
        assert.match(r.warned[0], /isaac/);
    });

    it('reports PUSH_CHANNEL_NOT_CONFIGURED to a supplied callback', function() {
        var got = [];
        drive({
            reqSessionID: 'SESSION-CALLER',
            noChannel: true,
            callback: function(err) { got.push(err); }
        });
        assert.equal(got.length, 1, 'the documented callback(err, result) contract must fire');
        assert.equal(got[0].code, 'PUSH_CHANNEL_NOT_CONFIGURED');
    });

    it('does not fire when a channel IS present (control)', function() {
        var r = drive({ reqSessionID: 'SESSION-CALLER' });
        assert.equal(r.delivered.length, 1);
        assert.equal(r.warned.length, 0, 'the channel warn must not fire when eio exists');
    });
});
