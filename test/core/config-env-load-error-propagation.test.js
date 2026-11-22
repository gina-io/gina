'use strict';
/**
 * #B372 — a failed `loadWithTemplate` was discarded by an unchecked `err`, turning
 * any release-path failure into an opaque `TypeError` naming neither the bundle
 * nor the path.
 *
 * Mechanism (code-read on the published 0.6.5 + 0.6.8 tarballs by the reporting
 * consumer, re-verified first-hand on this tree): `loadWithTemplate` links each
 * registered bundle's release target for a non-dev env and, on failure, calls back
 * with a well-formed `[ releaseError ]` carrying the offending path — via
 * `return callback(_releaseError)`, i.e. ONE argument, so `envConf` is `undefined`
 * at the receiving end. `Env.load`'s callback never inspected `err`: its first
 * statements were `self.envConf = envConf` then `envConf.env = self.env`, so the
 * real reason was dropped and the process died on
 * `TypeError: Cannot set properties of undefined (setting 'env')` at config.js:404,
 * escaping as an uncaughtException. The server never binds, so a startup probe sees
 * only `connection refused`.
 *
 * Impact: the config load is SHARED, so one bundle's missing release tree takes
 * down every bundle in the project — with an error pointing at framework internals
 * rather than at the path, which the framework had already computed and thrown away.
 *
 * The fix has two halves, and the first alone is NOT sufficient: propagating from
 * `Env.load` only moves the failure, because `getConf`'s callback did not inspect
 * `err` either. So the error is also given a SINK, mirroring the
 * `loadBundlesConfiguration` refusal that lives ~45 lines below it in the same
 * function (`console.error` + a synchronous `fs.writeSync(2, …)` so the reason
 * survives `process.exit()` on an async pipe, then `exit(1)`).
 *
 * Third change: the message now names the bundle, env and scope. It deliberately
 * no longer reports `targetAppPathObj` — when the throw comes from
 * `pkg[app].releases[scope][env]` itself, that assignment never ran and the object
 * still holds the LINK path, so the old message named the wrong file in exactly the
 * "no release entry for this scope" case.
 *
 * §01 — source pins: the guard, its ordering BEFORE the deref it protects, the
 *       sink idiom, and the message contents.
 * §02 — replica of the callback contract: the pre-fix shape reproduces the exact
 *       TypeError (the subtract control), the fixed shape propagates instead.
 * §03 — instrument validation: the anchors resolve and the slices are non-empty,
 *       so the negative pins above cannot pass vacuously.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW  = require('../fw');
var commentStrip = require('../strip-comments');
var SRC = fs.readFileSync(path.join(FW, 'core/config.js'), 'utf8');

// Env.load region: declaration → the FIRST envConf dereference. End-anchored on the
// deref, so a guard that drifted below it would fall outside the slice and trip §01
// (ordering enforced by construction, the #B181(b) idiom).
var E_START = SRC.indexOf('load : function(callback) {');
var E_END   = SRC.indexOf('self.envConf            = envConf;');
var E       = (E_START > -1 && E_END > E_START) ? SRC.substring(E_START, E_END) : '';

// getConf's Env.load callback region: the call → the first statement of the success path.
var G_START = SRC.indexOf('self.Env.load( function(err, envConf) {');
var G_END   = SRC.indexOf("if ( typeof(self.Env.loaded) == 'undefined')");
var G       = (G_START > -1 && G_END > G_START) ? SRC.substring(G_START, G_END) : '';

// the releaseError catch block
var R_START = SRC.indexOf("} catch (releaseError) {");
var R_END   = SRC.indexOf('return callback(_releaseError);');
var R       = (R_START > -1 && R_END > R_START) ? SRC.substring(R_START, R_END) : '';

describe('#B372 §01 — the env-load failure is propagated and sunk, not dereferenced', function () {

    it('slice anchors resolve (instrument control)', function () {
        assert.ok(E_START > -1, 'the Env.load declaration must exist');
        assert.ok(E_END > E_START, 'the envConf deref must follow the declaration');
        assert.ok(G_START > -1, 'the getConf -> Env.load call must exist');
        assert.ok(G_END > G_START, 'the success path must follow the call');
        assert.ok(R_START > -1, 'the releaseError catch must exist');
        assert.ok(R_END > R_START, 'the callback must follow the catch');
    });

    it('Env.load checks err BEFORE touching envConf (ordering)', function () {
        // E is end-anchored on `self.envConf = envConf`, so presence inside E IS the
        // ordering proof — an unguarded deref is exactly what #B372 was.
        assert.match(E, /if\s*\(\s*err\s*\)/, 'Env.load must inspect err');
        assert.match(E, /return callback\(\s*err\s*\)/,
            'the original error must be forwarded unchanged — it already carries the path');
    });

    it('getConf gives the propagated error a SINK (propagating alone is not enough)', function () {
        assert.match(G, /if\s*\(\s*err\s*\)/, 'getConf must inspect err');
        assert.ok(G.indexOf('console.error(') > -1, 'the reason is logged');
        assert.match(G, /fs\.writeSync\(\s*2\s*,/,
            'a synchronous stderr flush, so the reason survives process.exit() on an async pipe');
        assert.ok(G.indexOf('process.exit(1)') > -1, 'and the boot refuses rather than limping on');
    });

    it('the releaseError message names the bundle, env and scope', function () {
        assert.ok(R.indexOf("bundle: `'+ app +'`") > -1,
            'one bundle aborts the shared config load, so the message must say which');
        assert.ok(R.indexOf("env: `'+ env +'`") > -1, 'env must be named');
        assert.ok(R.indexOf("scope: `'+ scope +'`") > -1, 'scope must be named');
        assert.ok(R.indexOf('releaseError.message') > -1,
            'the underlying reason must survive — it is what carries the real path');
    });

    it('the message no longer reports targetAppPathObj (it names the wrong file)', function () {
        var stripped = commentStrip.all(R);
        assert.equal(/targetAppPathObj\.toString\(\)/.test(stripped), false,
            'when releases[scope][env] is what threw, that object still holds the LINK path');
        // control: the comment explaining WHY does mention it, so a broken strip is visible
        assert.ok(/targetAppPathObj/.test(R), 'the rationale comment should still name it');
    });
});

describe('#B372 §02 — replica of the callback contract', function () {

    /**
     * Models Env.load's callback both ways. `fixed:false` is the shipped pre-fix
     * shape; `fixed:true` is what this change installs.
     */
    function envLoadCallback(fixed, err, envConf, callback) {
        var self = { env: 'prod', scope: 'local', isStandalone: false, envConf: null };
        if (fixed && err) {
            return callback(err);
        }
        self.envConf         = envConf;
        envConf.env          = self.env;          // <-- the #B372 deref
        envConf.scope        = self.scope;
        envConf.isStandalone = self.isStandalone;
        callback(false, envConf);
    }

    it('SUBTRACT CONTROL: the pre-fix shape reproduces the exact shipped TypeError', function () {
        var releaseError = new Error('[ releaseError ] bundle: `api` (env: `prod`, scope: `local`)');
        assert.throws(
            function () { envLoadCallback(false, releaseError, undefined, function () {}); },
            function (e) {
                return e instanceof TypeError
                    && /Cannot set properties of undefined \(setting 'env'\)/.test(e.message);
            },
            'the unguarded callback must still reproduce the failure this fixes');
    });

    it('the fixed shape forwards the original error, unchanged and unwrapped', function () {
        var releaseError = new Error('[ releaseError ] bundle: `api` (env: `prod`, scope: `local`)');
        var got = [];
        envLoadCallback(true, releaseError, undefined, function (e) { got.push(e); });
        assert.equal(got.length, 1, 'the callback must fire exactly once');
        assert.equal(got[0], releaseError, 'the SAME error object — no re-wrapping, no loss');
        assert.ok(/\[ releaseError \]/.test(got[0].message), 'and it still carries its own text');
    });

    it('POSITIVE CONTROL: a successful load is unaffected by the guard', function () {
        var envConf = { some: 'conf' };
        var got = [];
        envLoadCallback(true, false, envConf, function (e, c) { got.push([ e, c ]); });
        assert.equal(got.length, 1);
        assert.equal(got[0][0], false, 'the success path still passes its falsy error arg');
        assert.equal(got[0][1].env, 'prod', 'and still stamps env onto the conf');
        assert.equal(got[0][1].scope, 'local');
    });

    it('a falsy-but-present err (the house `false`) is NOT treated as a failure', function () {
        // config.js signals success as callback(false, envConf); `if (err)` must let it through,
        // or the guard would refuse every successful boot.
        var envConf = { some: 'conf' };
        var got = [];
        envLoadCallback(true, false, envConf, function (e, c) { got.push([ e, c ]); });
        assert.equal(got[0][1], envConf, 'success must reach the success path');
    });
});

describe('#B372 §03 — the slices are real (negative pins cannot pass vacuously)', function () {
    it('every slice is non-empty and bounded', function () {
        assert.ok(E.length > 40, 'Env.load slice too small to be the real region');
        assert.ok(G.length > 40, 'getConf slice too small to be the real region');
        assert.ok(R.length > 40, 'releaseError slice too small to be the real region');
        assert.ok(E.length < 4000 && G.length < 4000 && R.length < 4000,
            'a runaway slice would make the positive pins meaningless');
    });
});
