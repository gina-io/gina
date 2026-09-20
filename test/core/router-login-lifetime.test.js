'use strict';
/**
 * The router half of the per-bundle login session lifetime: the dispatch band
 * that stamps a bundle's policy on the request, and the three places inside the
 * login shim where the resolved lifetime is applied.
 *
 * §01 pins the wiring in source, because placement is the whole correctness
 * argument here and no unit test can observe it: the lifetime must be written
 * AFTER the session is bound and BEFORE it is saved, on every branch the shim
 * can take. §02 extracts the shim and executes it against the REAL library, the
 * same brace-walk `router-login.test.js` uses, so the arms exercise shipped
 * source rather than a replica that can drift.
 *
 * Why the shim reads `req._ginaLoginLifetime` instead of closing over the
 * module: the shim is extracted and compiled in isolation by these tests and by
 * `router-login.test.js`, whose fixtures inject no library. A request without
 * the property never evaluates the identifier, so those fixtures keep working
 * untouched — and that is a pinned property below, not a happy accident.
 *
 * §01 — source pins: the band, its placement, and the three apply sites.
 * §02 — the extracted shim, driven both ways with a control fixture.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW  = require('../fw');
var SRC = fs.readFileSync(path.join(FW, 'core/router.js'), 'utf8');
var sl  = require(path.join(FW, 'lib/session-lifetime'));

var ACTIVE = SRC.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

var D = 24 * 60 * 60 * 1000;
var M = 60 * 1000;

// ─── 01 — source pins ────────────────────────────────────────────────────────
describe('session lifetime §01 — the router wiring', function () {

    it('the comment strip kept the file (instrument control)', function () {
        assert.ok(ACTIVE.length > SRC.length * 0.5,
            'a strip that ate the file would make every pin below pass vacuously');
    });

    it('the module binding is present, so the band reaches the live library', function () {
        assert.ok(ACTIVE.indexOf('sessionLifetime   = lib.sessionLifetime') > -1);
    });

    it('the band stamps the policy and wraps an installed logIn', function () {
        assert.ok(ACTIVE.indexOf('request._ginaLoginLifetime = conf.sessionLifetime;') > -1,
            'the policy must reach the request; the shim reads it from there');
        assert.ok(ACTIVE.indexOf('sessionLifetime.wrapLogin(request, conf.sessionLifetime);') > -1,
            'a passport-installed req.logIn is never replaced by the shim, so it needs wrapping');
    });

    it('the band runs BEFORE the shim installs req.login', function () {
        var band = ACTIVE.indexOf('request._ginaLoginLifetime = conf.sessionLifetime;');
        var shim = ACTIVE.indexOf('request.login =');
        assert.ok(band > -1 && shim > -1);
        assert.ok(band < shim,
            'the shim reads the property; stamping it afterwards would be a no-op on the first login');
    });

    it('the band is gated on a declared policy AND an existing session', function () {
        assert.ok(ACTIVE.indexOf(
            "if ( conf.sessionLifetime && request.session && typeof(request.session) == 'object' ) {") > -1,
            'bundles declaring neither key resolve to null and must cost one falsy check, nothing more');
    });

    it('the band does NOT assign request.login — that count belongs to the shim', function () {
        // Coupled pin: router-login.test.js’s extractor treats a second
        // `request.login =` as a failed extraction, so a band that assigned it
        // would silently break that file’s arms rather than this one’s.
        assert.equal(ACTIVE.split('request.login =').length - 1, 1,
            'exactly one `request.login =` may exist in the router');
    });

    it('the lifetime is applied on all three login branches', function () {
        var applies = ACTIVE.split('sessionLifetime.apply(').length - 1;
        assert.equal(applies, 3,
            'rotation branch, no-rotation branch, and the passport-flavoured callback — '
            + 'a missing one is a branch where the declared lifetime silently does not apply');
    });

    it('every apply is guarded by the request property, so an un-stamped request evaluates nothing', function () {
        // This is what keeps router-login.test.js’s library-less fixtures
        // working: a free `sessionLifetime` identifier reached at runtime would
        // throw ReferenceError inside its `new Function` sandbox.
        var guards = (ACTIVE.split('if ( req._ginaLoginLifetime ) {').length - 1)
                   + (ACTIVE.split('if ( self._ginaLoginLifetime ) {').length - 1);
        assert.equal(guards, 3, 'one guard per apply site');
    });

    it('the lifetime lands after the session is bound and before it is saved', function () {
        // The ordering IS the fix: express-session persists the cookie in the
        // save, so an assignment after it would not be written, and one before
        // regenerate() would be discarded with the old session.
        ['                            ', '                    '].forEach(function (indent) {
            var anchor = indent + 'req.session._ginaCreatedAt = Date.now();\n'
                       + indent + 'if ( req._ginaLoginLifetime ) {';
            assert.ok(ACTIVE.indexOf(anchor) > -1,
                'apply must immediately follow the bind on the branch indented ' + indent.length);
        });
        var applyAt = ACTIVE.indexOf('if ( req._ginaLoginLifetime ) {');
        var saveAt  = ACTIVE.indexOf('req.session.save(function onLoginSessionSaved(');
        assert.ok(applyAt > -1 && saveAt > applyAt, 'the first apply precedes the first save');
    });

    it('the existing shim anchors other suites pin are untouched', function () {
        // These four counts are asserted by router-login.test.js and
        // session-compat-send-b550.test.js. Re-pinned here so a regression in
        // THIS file’s edits is attributed here rather than surfacing as a
        // puzzling failure two suites away.
        [['req.session.save(function onLoginSessionSaved(', 1],
         ['req.session.save(function onLoginSessionSavedNoRotation(', 1],
         ['_sm.logIn(this, user,', 1]].forEach(function (pair) {
            assert.equal(SRC.split(pair[0]).length - 1, pair[1],
                pair[0] + ' must appear exactly ' + pair[1] + ' time(s)');
        });
    });
});

// ─── extraction (mirrors router-login.test.js) ───────────────────────────────

/**
 * Brace-match the login shim function expression out of the source.
 *
 * @inner
 * @param {string} source - `core/router.js` contents.
 * @returns {{fnSrc: (string|null), declCount: number, balanced: boolean}}
 */
function extractLogin(source) {
    var decl    = 'request.login =';
    var declIdx = source.indexOf(decl);
    if (declIdx < 0) { return { fnSrc: null, declCount: 0, balanced: false }; }
    var declCount = (source.indexOf(decl, declIdx + 1) < 0) ? 1 : 2;
    var funcIdx   = source.indexOf('function', declIdx);
    if (funcIdx < 0 || funcIdx - declIdx > 80) {
        return { fnSrc: null, declCount: declCount, balanced: false };
    }
    var i = source.indexOf('{', funcIdx);
    if (i < 0) { return { fnSrc: null, declCount: declCount, balanced: false }; }
    var depth = 1;
    while (depth > 0 && ++i < source.length) {
        if (source[i] === '{') { depth++; }
        else if (source[i] === '}') { depth--; }
    }
    return {
        fnSrc     : (depth === 0) ? source.slice(funcIdx, i + 1) : null,
        declCount : declCount,
        balanced  : depth === 0
    };
}

/**
 * Compile the extracted shim with the logger stubbed and the REAL library in scope.
 *
 * @inner
 * @param {string} fnSrc          - The extracted function expression.
 * @param {object} [libOverride]  - Library to inject; defaults to the real one.
 * @returns {function} The shim, to be called with the request as `this`.
 */
function makeLogin(fnSrc, libOverride) {
    var consoleStub = { warn: function () {}, error: function () {}, debug: function () {} };
    return new Function('console', 'sessionLifetime', 'return (' + fnSrc + ');')(
        consoleStub, libOverride || sl);
}

/**
 * A session that rotates and saves, as express-session does.
 *
 * @inner
 * @param {object} [opts] - `{ post, lifetime, noRegenerate }`.
 * @returns {object} The request fixture.
 */
function fixture(opts) {
    opts = opts || {};
    var req = {
        post    : opts.post || {},
        order   : [],
        session : {
            cookie : {},
            regenerate : opts.noRegenerate ? undefined : function (cb) { req.order.push('regenerate'); cb(null); },
            save       : function (cb) {
                req.order.push('save');
                req.cookieAtSave = req.session.cookie.maxAge;
                cb(null);
            }
        }
    };
    if (opts.lifetime) { req._ginaLoginLifetime = opts.lifetime; }
    return req;
}

// ─── 02 — the extracted shim, driven ─────────────────────────────────────────
describe('session lifetime §02 — the shim applies the policy it was stamped with', function () {

    var POLICY = { expires: 15 * M, remember: 15 * D };

    it('extraction control: exactly one declaration and a balanced walk', function () {
        var ex = extractLogin(SRC);
        assert.equal(ex.declCount, 1);
        assert.ok(ex.balanced && ex.fnSrc, 'the shim must extract cleanly, or every arm below is vacuous');
        assert.equal(extractLogin('var x = 1;').declCount, 0, 'known-negative: the extractor can fail');
    });

    it('CONTROL: a request with no stamped policy leaves the cookie untouched', function (t, done) {
        // Also the guard pin, executed: this fixture injects no policy, so a
        // shim that evaluated the library unguarded would throw here.
        var req = fixture();
        var login = makeLogin(extractLogin(SRC).fnSrc);
        login.call(req, { id: 1 }, {}, function (err) {
            assert.equal(err, null);
            assert.equal(req.session.cookie.maxAge, undefined,
                'a bundle that declares nothing must behave exactly as before');
            done();
        });
    });

    it('an ordinary login takes the expires lifetime, written before the save', function (t, done) {
        var req = fixture({ lifetime: POLICY });
        var login = makeLogin(extractLogin(SRC).fnSrc);
        login.call(req, { id: 1 }, {}, function (err) {
            assert.equal(err, null);
            assert.equal(req.session.cookie.maxAge, 15 * M);
            assert.equal(req.cookieAtSave, 15 * M,
                'the cookie must already carry the lifetime when the session is persisted');
            assert.deepEqual(req.order, ['regenerate', 'save'],
                'and it must land after rotation, or it would be discarded with the old session');
            done();
        });
    });

    it('a remembered login takes the remember lifetime, from the request field', function (t, done) {
        var req = fixture({ lifetime: POLICY, post: { remember: 'on' } });
        var login = makeLogin(extractLogin(SRC).fnSrc);
        login.call(req, { id: 1 }, {}, function () {
            assert.equal(req.session.cookie.maxAge, 15 * D);
            done();
        });
    });

    it('an explicit option beats the request field through the shim too', function (t, done) {
        var req = fixture({ lifetime: POLICY, post: { remember: 'on' } });
        var login = makeLogin(extractLogin(SRC).fnSrc);
        login.call(req, { id: 1 }, { remember: false }, function () {
            assert.equal(req.session.cookie.maxAge, 15 * M);
            done();
        });
    });

    it('the no-rotation branch applies it too', function (t, done) {
        var req = fixture({ lifetime: POLICY, post: { remember: 'on' }, noRegenerate: true });
        var login = makeLogin(extractLogin(SRC).fnSrc);
        login.call(req, { id: 1 }, {}, function () {
            assert.equal(req.session.cookie.maxAge, 15 * D,
                'a session provider without regenerate() still gets the declared lifetime');
            assert.equal(req.cookieAtSave, 15 * D);
            assert.deepEqual(req.order, ['save']);
            done();
        });
    });

    it('a transient login writes no cookie lifetime', function (t, done) {
        var req = fixture({ lifetime: POLICY, post: { remember: 'on' } });
        var login = makeLogin(extractLogin(SRC).fnSrc);
        login.call(req, { id: 1 }, { session: false }, function () {
            assert.equal(req.session.cookie.maxAge, undefined,
                '{session:false} touches no session, so there is no cookie to govern');
            done();
        });
    });
});
