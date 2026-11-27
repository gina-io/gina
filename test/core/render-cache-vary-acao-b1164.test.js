/**
 * #B1164 / #B1104 — where the render-cache fix is wired (source pins).
 *
 * #B1164: every place gina sends a cached route's `Cache-Control: <visibility>, max-age=` —
 * the four render-delegate miss sites (render-swig ×2, render-json, render-nunjucks) and the
 * two hit sites (isaac's pre-routing read, `serveRenderCacheHit` in core/server.js) — appends
 * the variant's request headers to `Vary` right after it (`RenderCache.appendVariantVary`).
 *
 * #B1104: both replay loops skip the stored `Access-Control-Allow-Origin`
 * (`RenderCache.isRecomputedHeader`); isaac's pre-routing hit, which runs no completeHeaders(),
 * then sets THIS request's value through `server._renderCacheAllowOrigin`, which core/server.js
 * stamps from the same rule completeHeaders() calls (`allowOriginFor`), held once. The rule's
 * behaviour is driven in test/core/server-allow-origin-b1104.test.js; the booted miss/hit
 * readings live in the arc's harness.
 *
 * Comment lines are removed before matching, so a comment that names a call cannot satisfy a pin.
 *
 * Run standalone:
 *   node --test test/core/render-cache-vary-acao-b1164.test.js
 */

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');

function read(rel) { return fs.readFileSync(path.join(FW, rel), 'utf8'); }

/** The source with its whole-line comments removed (`//`, `/*`, ` *`). */
function code(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\/\*|\*)/.test(l); }).join('\n');
}

/** The text from `start` to the first `end` after it, or '' when either is missing. */
function between(src, start, end) {
    var a = src.indexOf(start);
    if ( a < 0 ) { return ''; }
    var b = src.indexOf(end, a + start.length);
    return ( b < 0 ) ? '' : src.slice(a, b + end.length);
}

function count(src, re) { return ( src.match(re) || [] ).length; }

var SWIG     = code(read('core/controller/controller.render-swig.js'));
var NUNJUCKS = code(read('core/controller/controller.render-nunjucks.js'));
var JSONR    = code(read('core/controller/controller.render-json.js'));
var ISAAC    = code(read('core/server.isaac.js'));
var SERVER   = code(read('core/server.js'));

var MISS_CC = /res\.setHeader\('Cache-Control', \( _ccCfg\.visibility === 'public' \? 'public' : 'private' \) \+ ', max-age=' \+ ~~\(_ccTtl\)\);/g;


describe('01 - #B1164 the four miss sites append the variant headers to Vary after their max-age', function () {

    it('the instrument: the miss-path Cache-Control lines are found (swig 2, nunjucks 1, json 1)', function () {
        assert.equal(count(SWIG, MISS_CC), 2);
        assert.equal(count(NUNJUCKS, MISS_CC), 1);
        assert.equal(count(JSONR, /_cc = \( _ccCfg\.visibility === 'public' \? 'public' : 'private' \) \+ ', max-age=' \+ ~~\(_ccTtl\);/g), 1);
    });

    it('render-swig: right after each of its two #B744 blocks, when that block sent a max-age', function () {
        assert.equal(count(SWIG, /max-age=' \+ ~~\(_ccTtl\)\);\s*\}\s*\}\s*if \( _ccTtl > 0 \) \{\s*lib\.RenderCache\.appendVariantVary\(res\);\s*\}/g), 2);
    });

    it('render-nunjucks: right after its #B744 block, when that block sent a max-age', function () {
        assert.equal(count(NUNJUCKS, /max-age=' \+ ~~\(_ccTtl\)\);\s*\}\s*\}\s*if \( _ccTtl > 0 \) \{\s*libRef\.RenderCache\.appendVariantVary\(res\);\s*\}/g), 1);
    });

    it('render-json: right after its #B744 block, on the response, when it decided a max-age (both sends then carry it)', function () {
        assert.equal(count(JSONR, /max-age=' \+ ~~\(_ccTtl\);\s*\}\s*\}\s*if \( _cc \) \{\s*lib\.RenderCache\.appendVariantVary\(response\);\s*\}/g), 1);
    });

    it('the #B744 blocks themselves stay without the call (test/core/render-cache-control-b744.test.js runs their bytes without lib)', function () {
        var ANCHOR = '// Cache-Control: miss path';
        [['swig', read('core/controller/controller.render-swig.js'), 2], ['json', read('core/controller/controller.render-json.js'), 1],
         ['nunjucks', read('core/controller/controller.render-nunjucks.js'), 1]].forEach(function (d) {
            var src = d[1], from = 0, n = 0;
            for (;;) {
                var at = src.indexOf(ANCHOR, from);
                if ( at < 0 ) { break; }
                var i = src.indexOf('{', src.indexOf('if (', at)), depth = 0;
                for (; i < src.length; i++) {
                    if ( src[i] === '{' ) { depth++; }
                    else if ( src[i] === '}' ) { depth--; if ( depth === 0 ) { break; } }
                }
                assert.equal(src.slice(at, i + 1).indexOf('appendVariantVary'), -1, d[0] + ': block ' + n);
                n++; from = i + 1;
            }
            assert.equal(n, d[2], d[0] + ': the #B744 blocks are found');
        });
    });
});


describe('02 - #B1164 both hit sites re-append after their Cache-Control', function () {

    it('isaac\'s pre-routing hit', function () {
        assert.match(ISAAC, /response\.setHeader\('Cache-Control', _ccHitVis \+ ', max-age=' \+ _ccHitMaxAge\);\s*lib\.RenderCache\.appendVariantVary\(response\);\s*\}/);
    });

    it('serveRenderCacheHit (the shared redis hit, both engines)', function () {
        var block = between(SERVER, 'var serveRenderCacheHit', 'var tryServeRenderCacheHit');
        assert.ok(block.length > 0, 'serveRenderCacheHit is found');
        assert.match(block, /res\.setHeader\('Cache-Control', _vis \+ ', max-age=' \+ _remaining\);\s*lib\.RenderCache\.appendVariantVary\(res\);\s*\}/);
    });
});


describe('03 - #B1104 both replay loops skip the stored Access-Control-Allow-Origin', function () {

    it('serveRenderCacheHit', function () {
        var block = between(SERVER, 'var serveRenderCacheHit', 'var tryServeRenderCacheHit');
        var loop  = between(block, 'for (var h in _hitHeaders)', 'res.setHeader(h, _hitHeaders[h]);');
        assert.ok(loop.length > 0, 'its replay loop is found');
        assert.match(loop, /if\s*\(\s*lib\.RenderCache\.isRecomputedHeader\(\s*h\s*\)\s*\)\s*\{\s*continue;\s*\}/);
        assert.match(loop, /if\s*\(\s*lib\.RenderCache\.isPerRequestHeader\(\s*h\s*\)\s*\)\s*\{\s*continue;\s*\}/, 'the #B1100 skip stays');
    });

    it('isaac\'s pre-routing hit', function () {
        var loop = between(ISAAC, 'for (let h in _rnHeaders )', 'response.setHeader(h, _rnHeaders[h]);');
        assert.ok(loop.length > 0, 'its replay loop is found');
        assert.match(loop, /if\s*\(\s*lib\.RenderCache\.isRecomputedHeader\(\s*h\s*\)\s*\)\s*\{\s*continue;\s*\}/);
        assert.match(loop, /if\s*\(\s*lib\.RenderCache\.isPerRequestHeader\(\s*h\s*\)\s*\)\s*\{\s*continue;\s*\}/, 'the #B1100 skip stays');
    });
});


describe('04 - #B1104 one rule: completeHeaders() and isaac\'s hit both apply allowOriginFor()', function () {
    var chBlock = between(SERVER, 'var completeHeaders = function(responseHeaders', 'var appendVary = function');

    it('the instrument: completeHeaders() is found, its #B13 guard intact', function () {
        assert.ok(chBlock.length > 0, 'completeHeaders is found');
        assert.ok(between(read('core/server.js'),'var completeHeaders = function(responseHeaders', 'var appendVary = function').indexOf('#B13') > -1, 'the #B13 marker is in its raw text');
        assert.match(chBlock, /response\.setHeader\(h, headerValue\)/);
    });

    it('allowOriginFor() is defined once, before completeHeaders()', function () {
        assert.equal(count(SERVER, /var allowOriginFor = function\(request\) \{/g), 1);
        assert.ok(SERVER.indexOf('var allowOriginFor = function(request) {') < SERVER.indexOf('var completeHeaders = function(responseHeaders'));
    });

    it('completeHeaders() takes the value from it and computes none itself', function () {
        assert.match(chBlock, /allowOrigin = allowOriginFor\(request\);/);
        assert.match(chBlock, /response\.setHeader\(h, allowOrigin\);/);
        ['originHostReplacement', 'sameOrigin', 'allowedOrigin', 'new RegExp('].forEach(function (n) {
            assert.equal(chBlock.indexOf(n), -1, n + ' must live in allowOriginFor() only');
        });
    });

    it('completeHeaders() runs it only for a configured access-control-allow-origin name, before the headers are sent, where develop picked the value', function () {
        var loop   = chBlock.indexOf('for (let h in resHeaders) {');
        var sent   = chBlock.indexOf('!response.headersSent', loop);
        var branch = chBlock.indexOf('if ( /access\\-control\\-allow\\-origin/i.test(h) ) {', sent);
        var other  = chBlock.indexOf('} else {', branch);
        var call   = chBlock.indexOf('allowOrigin = allowOriginFor(request);');
        assert.ok(loop > -1 && sent > loop && branch > sent && other > branch, 'the loop, its headersSent guard and its access-control-allow-origin branch are found');
        assert.ok(call > branch && call < other, 'the call sits inside that branch');
        assert.equal(count(chBlock, /allowOriginFor\(/g), 1, 'and nowhere else in completeHeaders()');
    });

    it('server.js stamps instance._renderCacheAllowOrigin from the same rule, guarded', function () {
        var stamp = between(SERVER, 'instance._renderCacheAllowOrigin = function(req, res) {', '};');
        assert.ok(stamp.length > 0, 'the stamp is found');
        assert.match(stamp, /try \{ _ao = allowOriginFor\(req\); \} catch \(_aoErr\) \{ _ao = null; \}/);
        assert.match(stamp, /res\.setHeader\(_aoName, _ao\)/);
    });

    it('isaac\'s hit calls it after the replay loop and before it answers', function () {
        var loopEnd = ISAAC.indexOf('response.setHeader(h, _rnHeaders[h]);');
        var call    = ISAAC.indexOf('server._renderCacheAllowOrigin(request, response);');
        var serve   = ISAAC.indexOf('return response.end(_hitBody);');
        assert.ok(loopEnd > -1 && serve > -1, 'the loop and the memory serve are found');
        assert.ok(call > loopEnd, 'the call follows the replay loop');
        assert.ok(call < serve, 'the call precedes the memory serve (the fs serve comes after it too)');
        assert.equal(count(ISAAC, /server\._renderCacheAllowOrigin\(request, response\);/g), 1);
    });
});
