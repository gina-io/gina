/**
 * lib/swig-filters — source-inspection + length-filter null-guard tests.
 *
 * Sister of test/lib/nunjucks-filters.test.js (Section 08). The two filter
 * modules (`lib/swig-filters/src/main.js` and `lib/nunjucks-filters/src/main.js`)
 * carry the same `self.length` shape and were patched together to guard
 * against null/undefined input — templates that piped a missing variable
 * through `| length` previously crashed with a TypeError surfacing as a
 * 500 on the route.
 *
 * Strategy: source inspection + a pure-logic replica of self.length so we
 * can exercise behaviour without booting a real gina bundle (the factory
 * references `_`, `GINA_FRAMEWORK_DIR`, `JSON.clone`, `merge`, `routing`
 * — all set up by `gna.js` at bundle boot, not by the test runtime).
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW     = require('../fw');
var commentStrip = require('../strip-comments');
var SF_SRC = fs.readFileSync(path.join(FW, 'lib/swig-filters/src/main.js'), 'utf8');

// Strip line comments so the patch-comment mention of `typeof(input.count)`
// doesn't trip the negative-invariant search inside self.length.
function stripComments(src) {
    return commentStrip.all(src);
}
var SF_CODE = stripComments(SF_SRC);


// ---------------------------------------------------------------------------
// 01 - Module shape
// ---------------------------------------------------------------------------

describe('01 - lib/swig-filters module shape', function () {

    it('defines a top-level SwigFilters factory function', function () {
        assert.match(SF_SRC, /function\s+SwigFilters\s*\(\s*conf\s*\)/);
    });

    it('exports SwigFilters via module.exports', function () {
        assert.match(SF_SRC, /module\.exports\s*=\s*SwigFilters/);
    });

    it('declares self.length(input, obj)', function () {
        assert.match(SF_SRC, /self\.length\s*=\s*function\s*\(\s*input\s*,\s*obj\s*\)/);
    });
});


// ---------------------------------------------------------------------------
// 02 - length filter null/undefined guard (#FX-length-null-guard)
// ---------------------------------------------------------------------------
//
// Sister of nunjucks-filters Section 08. Both filter modules return 0 for
// null/undefined input; the guard MUST sit before the `input.count`
// dereference so a missing template variable doesn't crash the render.

describe('02 - length filter null/undefined guard (#FX-length-null-guard)', function () {

    it('source: null/undefined guard sits before `.count` dereference', function () {
        // Use SF_CODE (comments stripped) so the explanatory `typeof(input.count)`
        // mention in the patch comment doesn't trip the search.
        var lengthIdx = SF_CODE.indexOf('self.length = function');
        assert.ok(lengthIdx > 0, 'self.length declaration must exist');
        var nextDecl  = SF_CODE.indexOf('self.', lengthIdx + 1);
        var body      = SF_CODE.slice(lengthIdx, nextDecl > lengthIdx ? nextDecl : lengthIdx + 800);
        var guardIdx  = body.search(/input\s*==\s*null/);
        var countIdx  = body.search(/if\s*\(\s*typeof\s*\(\s*input\.count\s*\)/);
        assert.ok(guardIdx > -1, 'expected `input == null` guard inside self.length');
        assert.ok(countIdx > -1, 'expected `if ( typeof(input.count) ... )` dereference inside self.length');
        assert.ok(guardIdx < countIdx, 'guard must precede the `.count` dereference');
    });

    // Inline simulator mirroring framework/v*/lib/swig-filters/src/main.js
    // self.length byte-for-byte. Pure function with no gina globals.
    function simulatedLength(input /*, obj */) {
        if ( input == null ) {
            return 0;
        }
        if ( typeof(input.count) != 'undefined' ) {
            return input.count();
        } else {
            return input.length;
        }
    }

    it('returns 0 for undefined input', function () {
        assert.equal(simulatedLength(undefined), 0);
    });

    it('returns 0 for null input', function () {
        assert.equal(simulatedLength(null), 0);
    });

    it('returns array length for arrays', function () {
        assert.equal(simulatedLength([1, 2, 3]), 3);
        assert.equal(simulatedLength([]), 0);
    });

    it('returns string length for strings', function () {
        assert.equal(simulatedLength('abc'), 3);
        assert.equal(simulatedLength(''), 0);
    });

    it('returns count() for collection-like objects with .count()', function () {
        var fakeCollection = { count: function () { return 5; } };
        assert.equal(simulatedLength(fakeCollection), 5);
    });

    it('returns .length for plain objects with a numeric length property', function () {
        var obj = { length: 7 };
        assert.equal(simulatedLength(obj), 7);
    });
});


// ---------------------------------------------------------------------------
// 03 - getWebroot context-lookup fix (#B26)
// ---------------------------------------------------------------------------
//
// getWebroot used to read `self.options.envObj.getConf(obj, options.conf.env)`.
// `self.options` is the per-request wrapper ({ options, isProxyHost, throwError,
// req, res }) — it has no `.envObj` — and bare `options` was undeclared in the
// filter scope, so any invocation threw `TypeError: Cannot read properties of
// undefined (reading 'getConf')`. Latent because getWebroot (cross-bundle
// absolute links) is rarely invoked and no running test exercised it. The fix
// mirrors the sibling getUrl filter: resolve the bundle env config via the
// global Config registry (getContext('gina').Config.instance.Env.getConf).

describe('03 - getWebroot context-lookup fix (#B26)', function () {

    // Slice the getWebroot body out of the comment-stripped source so the
    // commented-out old line and the explanatory patch comment don't trip the
    // negative pins (mirrors section 02's stripComments approach).
    var wIdx     = SF_CODE.indexOf('self.getWebroot = function');
    var nextDecl = SF_CODE.indexOf('self.', wIdx + 1);
    var WEBROOT  = SF_CODE.slice(wIdx, nextDecl > wIdx ? nextDecl : wIdx + 1200);

    it('source: getWebroot declaration exists', function () {
        assert.ok(wIdx > 0, 'self.getWebroot declaration must exist');
    });

    it('source: no longer reads self.options.envObj (#B26)', function () {
        assert.doesNotMatch(WEBROOT, /self\.options\.envObj/);
    });

    it('source: no longer references the undeclared bare options.conf.env (#B26)', function () {
        assert.doesNotMatch(WEBROOT, /getConf\(\s*obj\s*,\s*options\.conf\.env\s*\)/);
    });

    it('source: resolves config via the proven getUrl pattern (Config.instance.Env.getConf)', function () {
        assert.match(WEBROOT, /getContext\(\s*['"]gina['"]\s*\)\.Config\.instance/);
        assert.match(WEBROOT, /mainConf\.Env\.getConf\(\s*obj\s*,\s*mainConf\.env\s*\)/);
    });

    it('source: still reads per-request context via getRenderCtx()/ctx.isProxyHost (#B25 preserved)', function () {
        assert.match(WEBROOT, /getRenderCtx\(\)/);
        assert.match(WEBROOT, /ctx\.isProxyHost/);
    });

    // --- Behavioural replicas -------------------------------------------------
    // Pure-logic mirrors with no gina globals (same convention as section 02's
    // simulatedLength). The OLD replica proves the pre-fix throw; the FIXED
    // replica proves the post-fix URL output for both branches.

    // Mirrors the PRE-#B26 buggy line: self.options.envObj.getConf(...).
    function simulatedGetWebrootOld(obj, selfOptions) {
        // selfOptions is the per-request wrapper — it has no .envObj, so the
        // `.getConf` dereference on `undefined` throws (the observable #B26
        // symptom; the bare `options.conf.env` arg is a second, later defect).
        var prop = selfOptions.envObj.getConf(obj);
        return prop;
    }

    // Mirrors the FIXED body (deps stand in for the gina globals:
    // mainConf <- getContext('gina').Config.instance,
    // proxyHostname <- process.gina.PROXY_HOSTNAME).
    function simulatedGetWebrootFixed(obj, ctx, mainConf, proxyHostname) {
        var url     = null
            , prop  = mainConf.Env.getConf(obj, mainConf.env)
            , isProxyHost  = ( ctx.isProxyHost && String(ctx.isProxyHost).toLowerCase() === 'true' ) ? true : (( typeof(proxyHostname) != 'undefined' ) ? true : false)
        ;
        if ( isProxyHost ) {
            url = prop.server.scheme + '://'+ prop.host;
        } else {
            url = prop.server.scheme + '://'+ prop.host +':'+ prop.port[prop.server.protocol][prop.server.scheme];
        }
        if ( typeof(prop.server['webroot']) != 'undefined') {
            url += prop.server['webroot'];
        }
        return url;
    }

    function makeMainConf(getConfReturn, recorder) {
        return {
            env: 'dev',
            Env: {
                getConf: function (bundle, env) {
                    if (recorder) { recorder.bundle = bundle; recorder.env = env; }
                    return getConfReturn;
                }
            }
        };
    }

    var sampleConf = {
        server : { scheme: 'https', protocol: 'http/1.1', webroot: '/admin' },
        host   : 'admin.example.com',
        port   : { 'http/1.1': { https: 8443 } }
    };

    it("MEASUREMENT: the old body throws \"Cannot read properties of undefined (reading 'getConf')\"", function () {
        var wrapper = { options: {}, isProxyHost: false, throwError: function () {}, req: {}, res: {} };
        assert.throws(function () {
            simulatedGetWebrootOld('admin', wrapper);
        }, /Cannot read properties of undefined \(reading 'getConf'\)/);
    });

    it('fixed: non-proxy build returns scheme://host:port/webroot', function () {
        var url = simulatedGetWebrootFixed('admin', { isProxyHost: false }, makeMainConf(sampleConf), undefined);
        assert.equal(url, 'https://admin.example.com:8443/admin');
    });

    it('fixed: proxy via ctx.isProxyHost drops the port', function () {
        var url = simulatedGetWebrootFixed('admin', { isProxyHost: 'true' }, makeMainConf(sampleConf), undefined);
        assert.equal(url, 'https://admin.example.com/admin');
    });

    it('fixed: proxy via process.gina.PROXY_HOSTNAME drops the port', function () {
        var url = simulatedGetWebrootFixed('admin', { isProxyHost: false }, makeMainConf(sampleConf), 'proxy.example.com');
        assert.equal(url, 'https://admin.example.com/admin');
    });

    it('fixed: omits webroot when server.webroot is absent', function () {
        var noWebroot = {
            server : { scheme: 'http', protocol: 'http/1.1' },
            host   : 'admin.example.com',
            port   : { 'http/1.1': { http: 8080 } }
        };
        var url = simulatedGetWebrootFixed('admin', { isProxyHost: false }, makeMainConf(noWebroot), undefined);
        assert.equal(url, 'http://admin.example.com:8080');
    });

    it('fixed: forwards (obj, mainConf.env) to Env.getConf', function () {
        var rec = {};
        simulatedGetWebrootFixed('admin', { isProxyHost: false }, makeMainConf(sampleConf, rec), undefined);
        assert.equal(rec.bundle, 'admin');
        assert.equal(rec.env, 'dev');
    });
});
