'use strict';
/**
 * lib/session-lifetime — per-bundle login session cookie lifetimes declared in
 * `security.json` (`session.expires` / `session.remember`) and applied by the
 * router at `req.login()`.
 *
 * Behavioural throughout: every arm drives the real module, none inspects source
 * text. The module is pure with respect to process state — it reads a config
 * object and writes `req.session.cookie.maxAge` — so one process serves them all.
 *
 * The disposition worth stating, because it is a deliberate choice and not an
 * oversight: an unusable duration is WARNED and treated as undeclared, never
 * fatal. Both keys were documented but uninterpreted before this release, so a
 * value already sitting in one was never a statement about this contract;
 * refusing a boot over it would turn an upgrade into an outage for a key that
 * did nothing yesterday. §01's "unusable" arms pin exactly that.
 *
 * §01 — fromConfig: the declaration matrix, including the undeclared null path.
 * §02 — the remember-me signal: field coercion, source precedence, option wins.
 * §03 — resolveMs / apply: which lifetime lands, and the no-op paths.
 * §04 — wrapLogin: the passport path, ordering, and the pass-throughs.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');

var FW = require('../fw');
var sl = require(path.join(FW, 'lib/session-lifetime'));

var H = 60 * 60 * 1000;
var D = 24 * H;
var M = 60 * 1000;

/** Swallow the module's warnings for the arms that deliberately provoke one. */
function quiet(fn) {
    var warn = console.warn, seen = [];
    console.warn = function () { seen.push(Array.prototype.join.call(arguments, ' ')); };
    try { fn(seen); } finally { console.warn = warn; }
    return seen;
}

// ─── 01 — fromConfig ─────────────────────────────────────────────────────────
describe('lib/session-lifetime §01 — deriving a bundle policy from security.json', function () {

    it('reads both keys as unit-suffixed durations', function () {
        assert.deepEqual(sl.fromConfig({ session: { expires: '3h', remember: '15d' } }, 'api', 'prod'),
            { expires: 3 * H, remember: 15 * D });
    });

    it('accepts either key alone, leaving the other null', function () {
        assert.deepEqual(sl.fromConfig({ session: { expires: '15m' } }, 'api', 'prod'),
            { expires: 15 * M, remember: null });
        assert.deepEqual(sl.fromConfig({ session: { remember: '30d' } }, 'api', 'prod'),
            { expires: null, remember: 30 * D });
    });

    it('returns null — not an empty policy — when the bundle declares neither key', function () {
        // The router band short-circuits on this, so it is the zero-cost path for
        // every bundle that never opted in. An empty object would cost a lookup
        // per login for nothing.
        assert.equal(sl.fromConfig({ session: {} }, 'api', 'prod'), null);
        assert.equal(sl.fromConfig({}, 'api', 'prod'), null);
        assert.equal(sl.fromConfig(undefined, 'api', 'prod'), null);
        assert.equal(sl.fromConfig(null, 'api', 'prod'), null);
        assert.equal(sl.fromConfig('not an object', 'api', 'prod'), null);
    });

    it('treats an explicit null or empty string as undeclared, silently', function () {
        var seen = quiet(function () {
            assert.equal(sl.fromConfig({ session: { expires: null, remember: '' } }, 'api', 'prod'), null);
        });
        assert.equal(seen.length, 0, 'an explicitly-cleared key is a choice, not a mistake — it must not warn');
    });

    it('WARNS and ignores a value that is not a duration, rather than failing the boot', function () {
        var seen = quiet(function () {
            // The shape a real application already had in this key before the
            // framework began interpreting it.
            assert.equal(sl.fromConfig({ session: { expires: '60000*15' } }, 'api', 'prod'), null);
        });
        assert.equal(seen.length, 1, 'exactly one warning');
        assert.match(seen[0], /api/,     'the warning must name the bundle');
        assert.match(seen[0], /prod/,    'the warning must name the environment');
        assert.match(seen[0], /expires/, 'the warning must name the key');
        assert.match(seen[0], /60000\*15/, 'the warning must quote the offending value');
    });

    it('WARNS and ignores a bare number, a non-positive duration, and a bad unit', function () {
        [['expires', '15'], ['expires', 15], ['expires', '0s'], ['expires', '-5m'], ['expires', '3 days']]
            .forEach(function (pair) {
                var seen = quiet(function () {
                    assert.equal(sl.fromConfig({ session: { expires: pair[1] } }, 'api', 'prod'), null,
                        'unusable value must be ignored: ' + JSON.stringify(pair[1]));
                });
                assert.equal(seen.length, 1, 'must warn for ' + JSON.stringify(pair[1]));
            });
    });

    it('keeps the usable key when only its sibling is unusable', function () {
        var got;
        var seen = quiet(function () {
            got = sl.fromConfig({ session: { expires: 'nonsense', remember: '15d' } }, 'api', 'prod');
        });
        assert.deepEqual(got, { expires: null, remember: 15 * D },
            'one bad key must not discard the other');
        assert.equal(seen.length, 1);
    });

    it('WARNS and ignores a non-object session block', function () {
        var seen = quiet(function () {
            assert.equal(sl.fromConfig({ session: 'nope' }, 'api', 'prod'), null);
            assert.equal(sl.fromConfig({ session: ['nope'] }, 'api', 'prod'), null);
        });
        assert.equal(seen.length, 2);
    });

    it('returns a frozen policy, so no caller can mutate another request\'s lifetime', function () {
        var p = sl.fromConfig({ session: { expires: '3h' } }, 'api', 'prod');
        assert.ok(Object.isFrozen(p));
    });
});

// ─── 02 — the remember-me signal ─────────────────────────────────────────────
describe('lib/session-lifetime §02 — deciding whether a login is remembered', function () {

    it('coerces the shapes a checkbox, a JSON body and a query string produce', function () {
        ['on', 'ON', ' on ', '1', 'true', 'True', 'yes', true, 1].forEach(function (v) {
            assert.equal(sl.coerceField(v), true, 'should mean remembered: ' + JSON.stringify(v));
        });
        ['off', '0', 'false', 'False', '', 'banana', false, 0, null, undefined, {}, []].forEach(function (v) {
            assert.equal(sl.coerceField(v), false, 'should NOT mean remembered: ' + JSON.stringify(v));
        });
    });

    it('reads the field from req.post first, then req.body', function () {
        assert.equal(sl.readField({ post: { remember: 'on' } }), 'on');
        assert.equal(sl.readField({ body: { remember: true } }), true);
        // req.post is the framework's normalised payload and already carries form,
        // JSON and multipart fields, so it wins when both are present.
        assert.equal(sl.readField({ post: { remember: 'on' }, body: { remember: 'off' } }), 'on');
        assert.equal(sl.readField({}), undefined);
        assert.equal(sl.readField(null), undefined);
    });

    it('an explicit boolean option beats the request field in both directions', function () {
        assert.equal(sl.isRemembered({ post: { remember: 'on' } }, { remember: false }), false,
            'a server-side decision must not be overridden by the client');
        assert.equal(sl.isRemembered({ post: { remember: 'off' } }, { remember: true }), true);
    });

    it('falls back to the field when the option is absent or not a boolean', function () {
        assert.equal(sl.isRemembered({ post: { remember: 'on' } }, {}), true);
        assert.equal(sl.isRemembered({ post: { remember: 'on' } }, undefined), true);
        assert.equal(sl.isRemembered({ post: { remember: 'on' } }, { remember: 'yes' }), true,
            'a non-boolean option is not a decision — the field still answers');
        assert.equal(sl.isRemembered({}, {}), false);
    });
});

// ─── 03 — resolving and applying ─────────────────────────────────────────────
describe('lib/session-lifetime §03 — which lifetime lands on the cookie', function () {

    var full = { expires: 15 * M, remember: 15 * D };

    it('a remembered login takes remember, an ordinary one takes expires', function () {
        assert.equal(sl.resolveMs(full, true), 15 * D);
        assert.equal(sl.resolveMs(full, false), 15 * M);
    });

    it('a remembered login falls back to expires when no remember is declared', function () {
        assert.equal(sl.resolveMs({ expires: 15 * M, remember: null }, true), 15 * M);
    });

    it('an ordinary login never borrows the longer remembered lifetime', function () {
        assert.equal(sl.resolveMs({ expires: null, remember: 15 * D }, false), null,
            'declaring only `remember` must leave an ordinary login untouched, not extend it');
    });

    it('applies the resolved value to the session cookie', function () {
        var req = { session: { cookie: {} }, post: { remember: 'on' } };
        assert.equal(sl.apply(req, true, full), 15 * D);
        assert.equal(req.session.cookie.maxAge, 15 * D);
    });

    it('is a no-op — never a throw — when there is nothing to apply to', function () {
        assert.equal(sl.apply({ session: { cookie: {} } }, false, null), null);
        assert.equal(sl.apply({ session: { cookie: {} } }, false, { expires: null, remember: null }), null);
        assert.equal(sl.apply({}, true, full), null, 'no session');
        assert.equal(sl.apply({ session: {} }, true, full), null, 'no cookie');
        assert.equal(sl.apply(null, true, full), null);
    });

    it('leaves a cookie the application already set when nothing resolves', function () {
        var req = { session: { cookie: { maxAge: 1234 } } };
        sl.apply(req, false, { expires: null, remember: 15 * D });
        assert.equal(req.session.cookie.maxAge, 1234, 'the factory value must survive untouched');
    });
});

// ─── 04 — wrapLogin, the passport path ───────────────────────────────────────
/**
 * Run a callback-style arm as a promise.
 *
 * Assertions made inside an asynchronous callback need somewhere to land: a
 * throw there escapes the test rather than failing it. This also keeps the file
 * runner-portable — node:test passes `(t, done)` to an arm, `bun test` does not,
 * so an arm written against that signature fails under Bun with `done is not a
 * function` while testing nothing at all.
 *
 * @inner
 * @param {function} body - Receives `ok`; call `ok(fn)` with the assertions.
 * @returns {Promise} Resolves when `ok` runs cleanly, rejects with its error.
 *
 * @example
 * it('…', function () {
 *     return promised(function (ok) {
 *         thing.run(function (err) { ok(function () { assert.equal(err, null); }); });
 *     });
 * });
 */
function promised(body) {
    return new Promise(function (resolve, reject) {
        body(function (assertions) {
            try { assertions(); resolve(); } catch (e) { reject(e); }
        });
    });
}

describe('lib/session-lifetime §04 — wrapping an already-installed req.logIn', function () {

    var full = { expires: 15 * M, remember: 15 * D };

    /** A stand-in for passport's req.logIn: succeeds asynchronously. */
    function stubReq(opts) {
        opts = opts || {};
        var req = {
            session: { cookie: {} },
            post: opts.post || {},
            calls: []
        };
        req.logIn = req.login = function (user, options, done) {
            if (typeof options == 'function') { done = options; options = {}; }
            req.calls.push({ user: user, options: options, hasDone: typeof done == 'function' });
            // The lifetime must land AFTER this, so record what the cookie held
            // at the moment the underlying login finished.
            req.cookieAtUpstream = req.session.cookie.maxAge;
            if (done) { return done(opts.err || null); }
        };
        return req;
    }

    it('applies the lifetime after the underlying login succeeds, not before', function () {
        return promised(function (ok) {
            var req = stubReq({ post: { remember: 'on' } });
            sl.wrapLogin(req, full);
            req.logIn({ id: 1 }, {}, function (err) {
                ok(function () {
                    assert.equal(err, null);
                    assert.equal(req.cookieAtUpstream, undefined,
                        'passport regenerates and saves inside its own logIn — writing the cookie first would be lost');
                    assert.equal(req.session.cookie.maxAge, 15 * D);
                });
            });
        });
    });

    it('applies the ordinary lifetime when the login is not remembered', function () {
        return promised(function (ok) {
            var req = stubReq();
            sl.wrapLogin(req, full);
            req.logIn({ id: 1 }, {}, function () {
                ok(function () { assert.equal(req.session.cookie.maxAge, 15 * M); });
            });
        });
    });

    it('normalises the (user, done) two-argument form', function () {
        return promised(function (ok) {
            var req = stubReq({ post: { remember: 'on' } });
            sl.wrapLogin(req, full);
            req.logIn({ id: 1 }, function (err) {
                ok(function () {
                    assert.equal(err, null);
                    assert.equal(req.session.cookie.maxAge, 15 * D);
                });
            });
        });
    });

    it('applies nothing when the underlying login fails', function () {
        return promised(function (ok) {
            var req = stubReq({ err: new Error('nope') });
            sl.wrapLogin(req, full);
            req.logIn({ id: 1 }, {}, function (err) {
                ok(function () {
                    assert.equal(err.message, 'nope');
                    assert.equal(req.session.cookie.maxAge, undefined,
                        'a failed login must not extend anything');
                });
            });
        });
    });

    it('passes a transient login straight through', function () {
        return promised(function (ok) {
            var req = stubReq({ post: { remember: 'on' } });
            sl.wrapLogin(req, full);
            req.logIn({ id: 1 }, { session: false }, function () {
                ok(function () {
                    assert.equal(req.session.cookie.maxAge, undefined,
                        '{session:false} writes no session — there is no cookie to govern');
                    assert.equal(req.calls[0].options.session, false,
                        'the options must reach passport unchanged');
                });
            });
        });
    });

    it('passes a callback-less call straight through, leaving passport its own behaviour', function () {
        var req = stubReq();
        sl.wrapLogin(req, full);
        req.logIn({ id: 1 }, {});
        assert.equal(req.calls.length, 1);
        assert.equal(req.calls[0].hasDone, false,
            'the wrapper must not manufacture a callback passport would have complained about');
    });

    it('is idempotent, and a no-op without a policy or an installed logIn', function () {
        var req = stubReq();
        assert.equal(sl.wrapLogin(req, full), true);
        assert.equal(sl.wrapLogin(req, full), false, 'a second wrap would apply the lifetime twice');
        assert.equal(sl.wrapLogin({ session: {} }, full), false, 'nothing to wrap');
        assert.equal(sl.wrapLogin(stubReq(), null), false, 'no policy');
    });

    it('keeps req.login and req.logIn the same function after wrapping', function () {
        var req = stubReq();
        sl.wrapLogin(req, full);
        assert.equal(req.login, req.logIn,
            'callers reach the shim through either name; wrapping one and not the other would split behaviour');
    });
});
