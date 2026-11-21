/**
 * lib/nunjucks-filters — source-inspection tests.
 *
 * The filter factory references gina globals (`_`, `GINA_FRAMEWORK_DIR`,
 * `JSON.clone`, `merge`, `routing`) that are only set up by `gna.js` at
 * real bundle boot. Exercising the factory end-to-end would require a
 * live bundle — heavy for near-zero extra coverage over the structural
 * assertions here. Matches the source-inspection style of
 * `render-engine-dispatch.test.js` and `swig-resolver.test.js`.
 *
 * What these tests lock in:
 *
 *   (a) lib/nunjucks-filters/src/main.js exports a `NunjucksFilters`
 *       factory with the same public surface as the swig-side sibling
 *       (`getUrl`, `getWebroot`, `length`, `nl2br`, `addHours`, `addDays`,
 *       `addYears`, plus internal `getConfig`)
 *   (b) lib/index.js registers `nunjucksFilters` via `_require`
 *   (c) render-nunjucks.js has the `registerGinaFilters` helper and
 *       invokes it once per request after env construction
 *   (d) the `env.addFilter` loop skips `getConfig` (matches swig path)
 *   (e) header docstring item #7 flips from Deferred to shipped
 *   (f) negative invariants — does NOT reference swig.setFilter, does NOT
 *       require('swig'), does NOT leak SwigFilters.instance into nunjucks
 *       code paths
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW             = require('../fw');
var commentStrip = require('../strip-comments');
var NF_SRC         = fs.readFileSync(path.join(FW, 'lib/nunjucks-filters/src/main.js'), 'utf8');
var NF_PKG         = JSON.parse(fs.readFileSync(path.join(FW, 'lib/nunjucks-filters/package.json'), 'utf8'));
var LIB_INDEX_SRC  = fs.readFileSync(path.join(FW, 'lib/index.js'), 'utf8');
var RENDER_NJ_SRC  = fs.readFileSync(path.join(FW, 'core/controller/controller.render-nunjucks.js'), 'utf8');
var SF_SRC         = fs.readFileSync(path.join(FW, 'lib/swig-filters/src/main.js'), 'utf8');

/**
 * Strip block and line comments from a JS source string. Used by the
 * negative-invariant assertions below so JSDoc examples mentioning
 * `env.addFilter` or `swig.setFilter` don't trip a "does not call X"
 * check. The shared lexer in test/strip-comments.js removes only real
 * comments (#B1157).
 */
function stripComments(src) {
    return commentStrip.all(src);
}
var NF_CODE       = stripComments(NF_SRC);
var RENDER_NJ_CODE = stripComments(RENDER_NJ_SRC);


// ---------------------------------------------------------------------------
// 01 - Module shape + package.json
// ---------------------------------------------------------------------------

describe('01 - lib/nunjucks-filters module shape', function () {

    it('package.json is named gina-lib-nunjucks-filters', function () {
        assert.equal(NF_PKG.name, 'gina-lib-nunjucks-filters');
    });

    it('package.json main points to src/main', function () {
        assert.equal(NF_PKG.main, 'src/main');
    });

    it('defines a top-level NunjucksFilters factory function', function () {
        assert.match(NF_SRC, /function\s+NunjucksFilters\s*\(\s*conf\s*\)/);
    });

    it('exports NunjucksFilters via module.exports', function () {
        assert.match(NF_SRC, /module\.exports\s*=\s*NunjucksFilters/);
    });

    it('declares AMD publish path too (isGFFCtx fallback)', function () {
        assert.match(NF_SRC, /define\s*\(\s*function\s*\(\s*\)\s*\{\s*return\s+NunjucksFilters\s*;?\s*\}\s*\)/);
    });
});


// ---------------------------------------------------------------------------
// 02 - Singleton + factory wiring
// ---------------------------------------------------------------------------

describe('02 - Factory wiring', function () {

    it('uses NunjucksFilters.instance + NunjucksFilters.initialized singleton keys', function () {
        assert.match(NF_SRC, /NunjucksFilters\.instance/);
        assert.match(NF_SRC, /NunjucksFilters\.initialized/);
    });

    it('does NOT leak SwigFilters.instance/.initialized into runtime code', function () {
        // Copy-paste check — the port must rename SwigFilters runtime state
        // refs. Comment references (e.g. "Mirror of SwigFilters.getWebroot")
        // are allowed, so we strip comments first.
        assert.doesNotMatch(NF_CODE, /SwigFilters\.(instance|initialized)/);
    });

    it('refreshes instance._options by REFERENCE on every call (#P39)', function () {
        // #P39 realignment — the former per-call deep clone of `conf` was
        // measured as pure waste (the stash has no writer beyond this
        // assignment, and the wrapper's `.options` is already the render's
        // per-request local.options). The pin now locks the reference stash,
        // and the comment-stripped negative locks the clone OUT of the
        // getInstance body so it cannot silently return.
        assert.match(NF_SRC, /NunjucksFilters\.instance\._options\s*=\s*conf\s*;/);
        var giStart = NF_CODE.indexOf('var getInstance = function()');
        var giEnd   = NF_CODE.indexOf('return NunjucksFilters.instance', giStart);
        assert.ok(giStart > -1 && giEnd > giStart, 'getInstance body must resolve in comment-stripped code');
        assert.equal(NF_CODE.slice(giStart, giEnd).indexOf('JSON.clone') , -1,
            'no clone may sit on the per-call stash path');
    });

    it('lazy-loads the merge lib via GINA_FRAMEWORK_DIR', function () {
        assert.match(NF_SRC, /GINA_FRAMEWORK_DIR\s*\+\s*["']\/lib\/merge["']/);
    });

    it('lazy-loads the routing lib via GINA_FRAMEWORK_DIR', function () {
        assert.match(NF_SRC, /GINA_FRAMEWORK_DIR\s*\+\s*["']\/lib\/routing["']/);
    });
});


// ---------------------------------------------------------------------------
// 03 - Public filter surface
// ---------------------------------------------------------------------------

describe('03 - Public filter surface', function () {

    it('defines self.getUrl(route, params, base)', function () {
        assert.match(NF_SRC, /self\.getUrl\s*=\s*function\s*\(\s*route\s*,\s*params\s*,\s*base\s*\)/);
    });

    it('defines self.getWebroot(input, obj)', function () {
        assert.match(NF_SRC, /self\.getWebroot\s*=\s*function\s*\(\s*input\s*,\s*obj\s*\)/);
    });

    it('defines self.length(input, obj)', function () {
        assert.match(NF_SRC, /self\.length\s*=\s*function\s*\(\s*input\s*,\s*obj\s*\)/);
    });

    it('defines self.nl2br(text, replacement)', function () {
        assert.match(NF_SRC, /self\.nl2br\s*=\s*function\s*\(\s*text\s*,\s*replacement\s*\)/);
    });

    it('defines self.addHours(input, h)', function () {
        assert.match(NF_SRC, /self\.addHours\s*=\s*function\s*\(\s*input\s*,\s*h\s*\)/);
    });

    it('defines self.addDays(input, d)', function () {
        assert.match(NF_SRC, /self\.addDays\s*=\s*function\s*\(\s*input\s*,\s*d\s*\)/);
    });

    it('defines self.addYears(input, y)', function () {
        assert.match(NF_SRC, /self\.addYears\s*=\s*function\s*\(\s*input\s*,\s*y\s*\)/);
    });

    it('defines the internal self.getConfig() — excluded from registration', function () {
        assert.match(NF_SRC, /self\.getConfig\s*=\s*function\s*\(\s*\)/);
    });

    it('has the same 7 public filter names as swig-filters (same surface)', function () {
        var publicFilters = ['getUrl', 'getWebroot', 'length', 'nl2br', 'addHours', 'addDays', 'addYears'];
        publicFilters.forEach(function (name) {
            assert.match(SF_SRC, new RegExp('self\\.' + name + '\\s*=\\s*function'),
                'swig-filters has self.' + name);
            assert.match(NF_SRC, new RegExp('self\\.' + name + '\\s*=\\s*function'),
                'nunjucks-filters has self.' + name);
        });
    });
});


// ---------------------------------------------------------------------------
// 04 - JSDoc presence (every public method + the class block)
// ---------------------------------------------------------------------------

describe('04 - JSDoc presence on public surface', function () {

    it('has a @class / @constructor block for NunjucksFilters', function () {
        assert.match(NF_SRC, /@class\s+NunjucksFilters/);
        assert.match(NF_SRC, /@constructor/);
    });

    it('each public filter has at least one @example', function () {
        // Rough check: the comment blocks that precede the public self.X
        // assignments must contain `@example` somewhere in the preceding
        // 30 lines (the JSDoc block).
        ['getUrl', 'getWebroot', 'length', 'nl2br', 'addHours', 'addDays', 'addYears'].forEach(function (name) {
            var idx = NF_SRC.indexOf('self.' + name + ' = function');
            assert.ok(idx > 0, name + ' assignment found');
            // Look backwards from the method for a JSDoc block with @example
            var window = NF_SRC.slice(Math.max(0, idx - 2000), idx);
            assert.match(window, /@example/, name + ' has a @example somewhere in its JSDoc block');
        });
    });
});


// ---------------------------------------------------------------------------
// 05 - lib/index.js registration
// ---------------------------------------------------------------------------

describe('05 - lib/index.js registration', function () {

    it('registers nunjucksFilters via _require (hot-reloadable path)', function () {
        assert.match(LIB_INDEX_SRC, /nunjucksFilters:\s*_require\('\.\/nunjucks-filters'\)/);
    });

    it('keeps the sibling nunjucksResolver registered', function () {
        assert.match(LIB_INDEX_SRC, /nunjucksResolver:\s*_require\('\.\/nunjucks-resolver'\)/);
    });

    it('keeps SwigFilters registered (swig path unchanged)', function () {
        assert.match(LIB_INDEX_SRC, /SwigFilters\s*:\s*_require\('\.\/swig-filters'\)/);
    });
});


// ---------------------------------------------------------------------------
// 06 - render-nunjucks.js integration
// ---------------------------------------------------------------------------

describe('06 - render-nunjucks.js integration', function () {

    it('defines an inner registerGinaFilters helper function', function () {
        // Post-#M1 retrofit: takes `req, res` as trailing parameters (the
        // renderNunjucks-captured copies, race-safe against external
        // local.req/res null-outs during async awaits).
        assert.match(RENDER_NJ_SRC, /function\s+registerGinaFilters\s*\(\s*env\s*,\s*self\s*,\s*local\s*,\s*localOptions\s*,\s*req\s*,\s*res\s*\)/);
    });

    it('calls registerGinaFilters from the render flow (per-request)', function () {
        assert.match(RENDER_NJ_SRC, /registerGinaFilters\(\s*env\s*,\s*self\s*,\s*local\s*,\s*localOptions\s*,\s*req\s*,\s*res\s*\)/);
    });

    it('fetches the lib via require("../../lib").nunjucksFilters or libRef.nunjucksFilters', function () {
        // Accept either the original direct-require shape or the libRef
        // module-scope fallback shape (`(libRef && libRef.nunjucksFilters)`),
        // which mirrors render-swig.js's `|| require.cache[...]` defence
        // against refreshCore() cache poisoning.
        assert.match(
            RENDER_NJ_SRC,
            /require\(\s*['"]\.\.\/\.\.\/lib['"]\s*\)\.nunjucksFilters|libRef\.nunjucksFilters/
        );
    });

    it('has a fallback require("../../lib/nunjucks-filters") for bootstrap safety', function () {
        assert.match(RENDER_NJ_SRC, /require\(\s*['"]\.\.\/\.\.\/lib\/nunjucks-filters['"]\s*\)/);
    });

    it('iterates filters via env.addFilter(name, fn)', function () {
        assert.match(RENDER_NJ_SRC, /env\.addFilter\(\s*name\s*,\s*filters\[\s*name\s*\]\s*\)/);
    });

    it('skips getConfig in the registration loop (matches swig path)', function () {
        assert.match(RENDER_NJ_SRC, /name\s*!==\s*['"]getConfig['"]/);
    });

    it('passes {options, isProxyHost, throwError, req, res} to the factory', function () {
        // All five keys must appear in the factory call payload
        var factoryCall = RENDER_NJ_SRC.match(/nunjucksFilters\(\s*\{[^}]*\}\s*\)/);
        assert.ok(factoryCall, 'factory call object literal found');
        ['options', 'isProxyHost', 'throwError', 'req', 'res'].forEach(function (k) {
            assert.match(factoryCall[0], new RegExp('\\b' + k + '\\s*:'), 'key `' + k + '` in factory payload');
        });
    });

    it('wraps the registration in try/catch + routes errors through self.throwError', function () {
        assert.match(
            RENDER_NJ_SRC,
            /try\s*\{[\s\S]{0,200}registerGinaFilters\([\s\S]{0,200}catch\s*\(\s*filterErr\s*\)[\s\S]{0,80}self\.throwError\(\s*filterErr\s*\)/
        );
    });

    it('registers filters AFTER env construction but BEFORE template render', function () {
        // Single regex enforces the three landmarks in order:
        //   1. env = getEnvironment(nunjucks, templateRoot, ...)
        //   2. registerGinaFilters(env, ...)
        //   3. env.render(templateRel, ...)  — the main template render
        // (the error-path env.renderString() is a separate branch).
        assert.match(
            RENDER_NJ_CODE,
            /env\s*=\s*getEnvironment\(\s*nunjucks\s*,\s*templateRoot[\s\S]*?registerGinaFilters\(\s*env[\s\S]*?env\.render\(\s*templateRel/
        );
    });

    it('deferred-feature item #7 (SwigFilters registration) marked shipped', function () {
        // Header docstring must flag the port. Keep the assertion loose on
        // spacing but strict on intent.
        assert.match(RENDER_NJ_SRC, /Gina SwigFilters registration[\s\S]{0,120}shipped/i);
    });
});


// ---------------------------------------------------------------------------
// 07 - Negative invariants
// ---------------------------------------------------------------------------

describe('07 - negative invariants', function () {

    it('nunjucks-filters does NOT call swig.setFilter in runtime code', function () {
        // Comments referencing the swig API (for parallel-pattern docs) are fine;
        // the factory must not actually invoke it.
        assert.doesNotMatch(NF_CODE, /swig\.setFilter/);
    });

    it('nunjucks-filters does NOT require("swig") or any @rhinostone/swig path', function () {
        assert.doesNotMatch(NF_SRC, /require\(\s*[`'"][^`'"]*swig[^`'"]*[`'"]\s*\)/);
    });

    it('nunjucks-filters does NOT call env.addFilter itself (registration is caller-side)', function () {
        // The lib is a pure filter-function factory; registration lives in
        // render-nunjucks.js so the same functions could be re-registered
        // on a different env in the future without touching the lib.
        // JSDoc example blocks mentioning env.addFilter are allowed —
        // strip comments before the check.
        assert.doesNotMatch(NF_CODE, /env\.addFilter/);
    });

    it('nunjucks-filters never declares nunjucks as a runtime dep', function () {
        // Parallel of the swig-filters / render-nunjucks rule — the library
        // is engine-agnostic at the code level; the caller holds the engine.
        assert.doesNotMatch(NF_SRC, /require\(\s*[`'"]nunjucks[`'"]\s*\)/);
    });

    it('render-nunjucks.js registerGinaFilters uses env.addFilter, not swig.setFilter', function () {
        // Guard against a copy-paste mistake when the swig pattern is the
        // obvious template. env.addFilter is the nunjucks API.
        assert.doesNotMatch(RENDER_NJ_CODE, /swig\.setFilter/);
    });
});


// ---------------------------------------------------------------------------
// 08 - length filter null/undefined guard (#FX-length-null-guard)
// ---------------------------------------------------------------------------
//
// Templates that pipe a missing variable through `| length` (e.g.
// `{{ breadcrumb | length }}` in a layout-included partial) used to crash
// with `TypeError: Cannot read properties of undefined (reading 'count')`
// because the filter dereferenced `input.count` before any null check —
// surfaced as a 500 on every affected route. The fix returns 0 for null/
// undefined input, matching upstream nunjucks `runtime.length` and Jinja2.

describe('08 - length filter null/undefined guard (#FX-length-null-guard)', function () {

    it('source: null/undefined guard sits before `.count` dereference in nunjucks-filters', function () {
        // Negative-invariant lock against an accidental revert during a future
        // merge. The guard MUST appear in source before the `input.count`
        // dereference so the dereference is unreachable on null/undefined.
        // Use NF_CODE (comments stripped) so the explanatory `typeof(input.count)`
        // mention in the patch comment doesn't trip the search.
        var lengthIdx = NF_CODE.indexOf('self.length = function');
        assert.ok(lengthIdx > 0, 'self.length declaration must exist');
        var nextDecl  = NF_CODE.indexOf('self.', lengthIdx + 1);
        var body      = NF_CODE.slice(lengthIdx, nextDecl > lengthIdx ? nextDecl : lengthIdx + 800);
        var guardIdx  = body.search(/input\s*==\s*null/);
        var countIdx  = body.search(/if\s*\(\s*typeof\s*\(\s*input\.count\s*\)/);
        assert.ok(guardIdx > -1, 'expected `input == null` guard inside self.length');
        assert.ok(countIdx > -1, 'expected `if ( typeof(input.count) ... )` dereference inside self.length');
        assert.ok(guardIdx < countIdx, 'guard must precede the `.count` dereference');
    });

    // Inline simulator mirroring framework/v*/lib/nunjucks-filters/src/main.js
    // self.length byte-for-byte (and swig-filters/src/main.js self.length —
    // same logic). Pure function with no gina globals — safe to exercise.
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
        // Mirrors how a custom NodeList-like object would surface its size.
        var obj = { length: 7 };
        assert.equal(simulatedLength(obj), 7);
    });
});


// ---------------------------------------------------------------------------
// 09 - getWebroot context-lookup fix (#B26)
// ---------------------------------------------------------------------------
//
// Sister of swig-filters section 03. getWebroot used to read
// `self.options.envObj.getConf(obj, options.conf.env)`. `self.options` is the
// per-request wrapper ({ options, isProxyHost, throwError, req, res }) — no
// `.envObj` — and bare `options` was undeclared in the filter scope, so any
// invocation threw `TypeError: Cannot read properties of undefined (reading
// 'getConf')`. The fix mirrors the sibling getUrl filter: resolve the bundle
// env config via the global Config registry
// (getContext('gina').Config.instance.Env.getConf).

describe('09 - getWebroot context-lookup fix (#B26)', function () {

    // Slice the getWebroot body out of the comment-stripped source so the
    // commented-out old line and the explanatory patch comment don't trip the
    // negative pins (mirrors section 08's stripComments approach).
    var wIdx     = NF_CODE.indexOf('self.getWebroot = function');
    var nextDecl = NF_CODE.indexOf('self.', wIdx + 1);
    var WEBROOT  = NF_CODE.slice(wIdx, nextDecl > wIdx ? nextDecl : wIdx + 1200);

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

    it('source: JSDoc no longer documents the nonexistent envObj path (#B26)', function () {
        // The stale JSDoc said "Uses ctx.options.envObj.getConf" — envObj exists
        // nowhere on the data model. The corrected doc names Config.instance.Env.
        var jIdx = NF_SRC.indexOf('self.getWebroot = function');
        var jWin = NF_SRC.slice(Math.max(0, jIdx - 1200), jIdx);
        assert.doesNotMatch(jWin, /envObj/);
        assert.match(jWin, /Config\.instance\.Env\.getConf/);
    });

    // --- Behavioural replicas -------------------------------------------------
    // Pure-logic mirrors with no gina globals (same convention as section 08's
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
