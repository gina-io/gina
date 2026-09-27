'use strict';
/**
 * #B367 — reflected XSS via unsanitised X-Forwarded-* / Host headers
 *
 * Request-derived values reached the always-emitted client loader UNESCAPED and
 * landed inside SINGLE-QUOTED JS string literals, so a quote in a header closed
 * the literal and executed arbitrary script on every rendered page, with no
 * authentication:
 *
 *   gina.onload.min.js :  window.__ginaWebroot='{{ page.environment.webroot }}';
 *                         hostname:'{{ page.environment.hostname }}'
 *
 * The chain (all links measured 2026-08-15, reproduced over real HTTP):
 *   server.isaac.js  x-forwarded-host / -proto / -prefix  -> request._ginaProxy*
 *   router.js        the deliberate twin, plus Host/:authority
 *   controller.js    _publicHostname / _publicWebroot -> set('page.environment.*')
 *   render-*.js      whisper(dic, layout, /\{{ ([a-zA-Z.]+) \}}/g)
 *   context.js:798   whisper case 1 = replace(rule, (s,key) => dictionary[key] || s)
 *                    -- a RAW splice; whisper performs no escaping anywhere.
 *
 * Fix shape: SANITISE AT INGEST, not escape at emission. `whisper()` runs over the
 * whole layout, so the same dictionary feeds HTML contexts too — a blanket JS-string
 * escape there would emit literal backslashes into HTML. Rejecting a malformed value
 * at the header-read site instead protects every downstream consumer of these slots
 * and is fail-safe (the request falls back to the bundle's internal configured
 * values, exactly as if the header had been absent). Server-side only: no client
 * decode is introduced, so pickup is a bundle RESTART with no re-bake.
 *
 * ⚠️ INSTRUMENT NOTE (why this file carries behavioral arms, not just source pins):
 * a source pin asserts a line EXISTS in a shape, never what it DOES (jsdoc.md
 * "A source pin is NOT a behavioral test"). A charset guard is exactly the kind of
 * line that can be present, correctly-shaped and semantically wrong. So §03/§04/§05
 * EXTRACT the real regex literals from the shipped source and EVALUATE them against
 * a payload matrix. Regex literals close over nothing, so reconstructing one is safe
 * -- unlike lifting a FUNCTION out of its lexical context, which is what produced the
 * wrong "not exploitable" verdict in #B364 (see post-mortem.md 2026-08-15).
 * Every matrix carries BOTH polarities: a guard that rejected everything would break
 * the legitimate proxy feature, and the accept-arms are what stop that passing here.
 *
 * Strategy: source inspection + regex-literal extraction + behavioral matrices.
 * No live HTTP server, no framework bootstrap, no project required. The live
 * end-to-end reproduction (both vectors, before/after, with a known-true control)
 * was run separately at fix time and is recorded in bug-fixes.md #B367.
 *
 * Suites:
 *  01 — server.isaac.js source pins (helper present, gate + assignments use the token)
 *  02 — router.js twin source pins (helper present, Host/:authority sanitised too)
 *  03 — behavioral: the host-token guard rejects injection, accepts real hosts
 *  04 — behavioral: the x-forwarded-prefix guard rejects injection, accepts real paths
 *  05 — behavioral: the forwarded-scheme guard is a two-value whitelist
 *  06 — twin parity: both files enforce the SAME host-token charset (anti-drift)
 *  07 — the loader still splices into single-quoted literals (the fix's premise)
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW = require('../fw');

var ISAAC_PATH  = path.join(FW, 'core/server.isaac.js');
var ROUTER_PATH = path.join(FW, 'core/router.js');
var LOADER_PATH = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.onload.min.js');

var isaacSrc  = fs.readFileSync(ISAAC_PATH, 'utf8');
var routerSrc = fs.readFileSync(ROUTER_PATH, 'utf8');
var loaderSrc = fs.readFileSync(LOADER_PATH, 'utf8');

/**
 * Pulls the host-token charset regex out of the `_isSafeHostToken` helper in the
 * given source. Anchors on the DECLARATION form (not the bare name, which also
 * appears in the surrounding rationale comment) per the jsdoc.md slice-anchor rule.
 */
function hostTokenRe(src, label) {
    var i = src.indexOf('var _isSafeHostToken = function');
    assert.ok(i > -1, label + ': `var _isSafeHostToken = function` helper not found');
    var body = src.slice(i, i + 400);
    var m = body.match(/(\/\^\[[^\n]*?\]\+\$\/)/);
    assert.ok(m, label + ': host-token regex literal not found in the helper body');
    var lit = m[1];
    return new RegExp(lit.slice(1, lit.lastIndexOf('/')));
}

// Payloads that MUST be rejected. Each is a real break-out shape for a
// single-quoted JS string literal, or a script-block terminator.
var INJECTION_HOSTS = [
    "x.example';window.__B367=1;'",     // the reproduced ARM-INJECT payload
    "x.example'",                        // bare quote — closes the literal
    'x.example"',                        // double quote
    'x.example\\',                       // backslash — escapes the closing quote
    'x.example</script><script>a()',     // script-block break-out
    'x.example\nevil',                   // newline — statement separator
    'x.example evil',                    // whitespace
    'x.example<b>',                      // angle brackets
    'x.example`a`',                      // template literal
    'x.example;alert(1)'                 // statement separator
];

// Values that MUST be accepted, or the fix would have broken the proxy feature
// rather than secured it. This polarity is the control on the matrix.
var LEGITIMATE_HOSTS = [
    'example.com',
    'sub.example.com',
    'example.com:8443',
    'localhost',
    'localhost:9840',
    'my-host.internal',
    'my_host.internal',
    '127.0.0.1',
    '127.0.0.1:3000',
    '[::1]',
    '[2001:db8::1]:8080'
];


describe('proxy-header-injection — #B367 forwarded-header sanitisation at ingest', function() {

    describe('01 - server.isaac.js source pins', function() {

        it('01a - declares the _isSafeHostToken guard', function() {
            assert.ok(
                isaacSrc.indexOf('var _isSafeHostToken = function') > -1,
                'server.isaac.js must declare the _isSafeHostToken guard'
            );
        });

        it('01b - caps the token length (charset alone does not bound it)', function() {
            var i = isaacSrc.indexOf('var _isSafeHostToken = function');
            var body = isaacSrc.slice(i, i + 400);
            assert.match(body, /length\s*<=\s*255/,
                'the host-token guard must cap length, not only charset');
        });

        it('01c - the proxied gate reads the SANITISED token, not the raw header', function() {
            var i = isaacSrc.indexOf('var _thisReqProxied = (');
            assert.ok(i > -1, '_thisReqProxied gate not found');
            var gate = isaacSrc.slice(i, i + 300);
            assert.ok(gate.indexOf('|| _xfh') > -1,
                'the gate must classify on the sanitised _xfh');
            assert.ok(gate.indexOf("request.headers['x-forwarded-host']") < 0,
                'the gate must NOT read the raw x-forwarded-host header');
        });

        it('01d - the proxy slots are assigned from sanitised tokens only', function() {
            // Window-INDEPENDENT positives: both assignment forms are globally unique,
            // so assert them against the whole source. A fixed-width slice here is the
            // very char-distance brittleness this fix's own comment inflated past —
            // measured at authoring time: anchor→last-assignment is 664 chars, so a
            // 700-char window truncated mid-statement (jsdoc.md, proximity-pin trap).
            assert.ok(isaacSrc.indexOf('request._ginaProxyHost     = _xfh;') > -1,
                '_ginaProxyHost must take the sanitised token');
            assert.ok(isaacSrc.indexOf('request._ginaProxyHost     = _safeRequestHost;') > -1,
                'the port-less-Host branch must take the sanitised request host');
            // The negative MUST stay scoped: the raw header is still read once, legitimately,
            // at the _xfhRaw capture — which sits BEFORE this anchor (measured), so slicing
            // forward from it excludes the capture and still catches a re-introduced raw read.
            var i = isaacSrc.indexOf('request._ginaIsProxyHost = _thisReqProxied;');
            assert.ok(i > -1, 'slot-assignment block not found');
            var block = isaacSrc.slice(i, i + 900);
            assert.ok(block.indexOf("request.headers['x-forwarded-host']") < 0,
                'no raw x-forwarded-host read may survive in the assignment block');
        });

        it('01e - the x-forwarded-prefix block carries a charset gate', function() {
            var i = isaacSrc.indexOf("if (request.headers['x-forwarded-prefix'])");
            assert.ok(i > -1, 'x-forwarded-prefix block not found');
            var block = isaacSrc.slice(i, i + 900);
            assert.match(block, /_xfp\.length\s*>\s*255\s*\|\|\s*!\/\^\[/,
                'the prefix block must reject on length AND charset before use');
        });

        // #B679 — the trailing-slash trim `/\/+$/` backtracks quadratically on a long run of
        // slashes (a 15 KB header cost 100–170 ms per request on a booted bundle; the regex alone
        // ~8 s at the 64 KB the HTTP/2 header-list cap admits), and the block runs on every request.
        // The length+charset gate must therefore run BEFORE that trim, so a >255 value is zeroed
        // before the regex ever sees it. Pinned by ORDER inside the block, comment-stripped so this
        // comment and the fix's own cannot satisfy it: on the pre-#B679 bytes the gate sits AFTER
        // the replace and the arm is red.
        it('01f - the length+charset gate runs BEFORE the trailing-slash trim (#B679)', function() {
            var i = isaacSrc.indexOf("if (request.headers['x-forwarded-prefix'])");
            assert.ok(i > -1, 'x-forwarded-prefix block not found');
            var end = isaacSrc.indexOf('request._ginaProxyPrefix = _xfp;', i);
            assert.ok(end > i, 'x-forwarded-prefix assign not found');
            var block = isaacSrc.slice(i, end).split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
            var gate    = block.indexOf('_xfp.length > 255');
            var replace = block.indexOf("_xfp.replace(/\\/+$/, '')");
            assert.ok(gate > -1,    'the 255-char cap must be present in the block');
            assert.ok(replace > -1, 'the trailing-slash trim must be present in the block');
            assert.ok(gate < replace,
                'the length+charset gate must run BEFORE the trailing-slash trim (gate at ' + gate + ', replace at ' + replace + ')');
        });
    });

    describe('02 - router.js twin source pins', function() {

        it('02a - declares the same _isSafeHostToken guard', function() {
            assert.ok(
                routerSrc.indexOf('var _isSafeHostToken = function') > -1,
                'router.js (the deliberate twin) must declare the guard too'
            );
        });

        it('02b - sanitises the caller-supplied Host/:authority header', function() {
            assert.ok(
                routerSrc.indexOf('var _rawProxyReqHost = request.headers.host || request.headers[\':authority\'];') > -1,
                'the raw Host/:authority read must be captured separately'
            );
            assert.match(routerSrc, /var proxyReqHost\s*=\s*_isSafeHostToken\(_rawProxyReqHost\)/,
                'proxyReqHost must be the SANITISED form — it is attacker-supplied too');
        });

        it('02c - the proxied gate and both slot writers use sanitised tokens', function() {
            var i = routerSrc.indexOf('var proxyReqIsProxied = (');
            assert.ok(i > -1, 'proxyReqIsProxied gate not found');
            var block = routerSrc.slice(i, i + 1400);
            assert.ok(block.indexOf('|| _xfh') > -1,
                'the gate must classify on the sanitised _xfh');
            assert.ok(block.indexOf("request.headers['x-forwarded-host']") < 0,
                'no raw x-forwarded-host read may survive in the gate/assignment block');
            assert.ok(block.indexOf('process.gina.PROXY_HOST     = _xfh;') > -1,
                'the worker-global must take the sanitised token');
        });
    });

    describe('03 - behavioral: the host-token guard (evaluated, not pinned)', function() {

        [['server.isaac.js', function(){ return hostTokenRe(isaacSrc, 'isaac'); }],
         ['router.js',       function(){ return hostTokenRe(routerSrc, 'router'); }]
        ].forEach(function(pair) {
            var label = pair[0], get = pair[1];

            it('03 - ' + label + ' REJECTS every injection payload', function() {
                var re = get();
                INJECTION_HOSTS.forEach(function(payload) {
                    assert.equal(re.test(payload), false,
                        label + ' must reject host payload: ' + JSON.stringify(payload));
                });
            });

            it('03 - ' + label + ' ACCEPTS every legitimate host (control)', function() {
                var re = get();
                LEGITIMATE_HOSTS.forEach(function(host) {
                    assert.equal(re.test(host), true,
                        label + ' must still accept legitimate host: ' + JSON.stringify(host) +
                        ' — a guard that rejects everything breaks the proxy feature');
                });
            });
        });
    });

    describe('04 - behavioral: the x-forwarded-prefix guard (evaluated)', function() {

        function prefixRe() {
            var i = isaacSrc.indexOf("if (request.headers['x-forwarded-prefix'])");
            assert.ok(i > -1, 'x-forwarded-prefix block not found');
            var block = isaacSrc.slice(i, i + 900);
            var m = block.match(/!(\/\^\[[^\n]*?\]\*\$\/)\.test\(_xfp\)/);
            assert.ok(m, 'prefix charset regex literal not found');
            var lit = m[1];
            return new RegExp(lit.slice(1, lit.lastIndexOf('/')));
        }

        it('04a - rejects prefix injection payloads', function() {
            var re = prefixRe();
            [
                "/a';window.__B367B=1;'",      // the reproduced ARM-INJECT-2 payload
                "/a'",
                '/a"',
                '/a\\',
                '/a</script><script>b()',
                '/a evil',
                '/a\nevil',
                '/a<b>'
            ].forEach(function(payload) {
                assert.equal(re.test(payload), false,
                    'must reject prefix payload: ' + JSON.stringify(payload));
            });
        });

        it('04b - accepts legitimate mount prefixes (control)', function() {
            var re = prefixRe();
            ['/admin', '/app/v1', '/a-b_c', '/team.one', '/%C3%A9', '/~user', ''
            ].forEach(function(prefix) {
                assert.equal(re.test(prefix), true,
                    'must still accept legitimate prefix: ' + JSON.stringify(prefix));
            });
        });
    });

    describe('05 - behavioral: the forwarded-scheme whitelist', function() {

        // Both files gate the scheme identically; extract and evaluate the predicate
        // shape rather than trusting the literal to be spelled the same way.
        [['server.isaac.js', isaacSrc, '_xfpr'],
         ['router.js',       routerSrc, '_rawXfProto']
        ].forEach(function(t) {
            var label = t[0], src = t[1], vname = t[2];

            it('05 - ' + label + ' admits only http/https for the forwarded scheme', function() {
                var re = new RegExp(vname + "\\s*===\\s*'http'\\s*\\|\\|\\s*" + vname + "\\s*===\\s*'https'");
                assert.match(src, re,
                    label + ' must whitelist the forwarded scheme to exactly http|https ' +
                    '(it is concatenated straight into the whispered origin)');
            });
        });
    });

    describe('06 - twin parity (anti-drift)', function() {

        it('06a - both twins enforce an IDENTICAL host-token charset', function() {
            var a = hostTokenRe(isaacSrc, 'isaac').source;
            var b = hostTokenRe(routerSrc, 'router').source;
            assert.equal(a, b,
                'server.isaac.js and router.js are deliberate twins — their host-token ' +
                'guards must not drift apart, or one engine becomes exploitable again');
        });

        it('06b - both twins name each other in the sync comment', function() {
            assert.ok(isaacSrc.indexOf('Keep in sync with the core/router.js twin') > -1,
                'server.isaac.js must point at its twin');
            assert.ok(routerSrc.indexOf('Keep in sync with the core/server.isaac.js twin') > -1,
                'router.js must point at its twin');
        });
    });

    describe('07 - the fix premise: the loader still splices into JS string literals', function() {

        it('07a - the shipped loader wraps these values in single-quoted literals', function() {
            [
                "window.__ginaWebroot='{{ page.environment.webroot }}'",
                "hostname:'{{ page.environment.hostname }}'",
                "protocol:'{{ page.environment.protocol }}'",
                "culture:'{{ page.environment.culture }}'"
            ].forEach(function(frag) {
                assert.ok(loaderSrc.indexOf(frag) > -1,
                    'loader must still contain ' + JSON.stringify(frag) + ' — if this fails, the ' +
                    'emission context changed and #B367\'s ingest-sanitisation rationale needs re-checking');
            });
        });

        it('07b - whisper() still performs no escaping (the reason ingest must sanitise)', function() {
            var ctxSrc = fs.readFileSync(path.join(FW, 'helpers/context.js'), 'utf8');
            var i = ctxSrc.indexOf('global.whisper = function');
            assert.ok(i > -1, 'whisper definition not found');
            var body = ctxSrc.slice(i, i + 300);
            assert.match(body, /return\s+replaceable\.replace\(rule,\s*function\(s,\s*key\)/,
                'whisper case 1 is the loader substitution path');
            assert.match(body, /return\s+dictionary\[key\]\s*\|\|\s*s;/,
                'whisper case 1 splices RAW — if this ever gains an escape step, revisit #B367');
        });
    });
});
