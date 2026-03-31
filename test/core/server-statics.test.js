'use strict';
/**
 * server.js — static file handler regression tests
 *
 * Strategy: source inspection.
 * No live HTTP server or project required.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var SOURCE = path.join(require('../fw'), 'core/server.js');


// ─── 01 — HTTP/2 dev path: cache headers apply to all static types ───────────

describe('01 - HTTP/2 dev path: cache headers cover all static types', function() {

    var src, region;

    before(function() {
        src = fs.readFileSync(SOURCE, 'utf8');

        // There are two HTTP/2 isCacheless blocks that contain header['X-SourceMap']:
        //  1. onHttp2Stream push-stream path (~line 1630)
        //  2. handleStatics direct-response path (~line 2046)
        // Both had the same bug; both were fixed. Test the handleStatics path (last occurrence).
        // The HTTP/1.x paths use response.setHeader("X-SourceMap") — different syntax, excluded.
        var xSourceMapIdx  = src.lastIndexOf("header['X-SourceMap']");
        var isCachelessIdx = src.lastIndexOf('if (isCacheless)', xSourceMapIdx);
        var regionEnd      = src.indexOf('header  = completeHeaders(header', xSourceMapIdx);
        region = src.slice(isCachelessIdx, regionEnd);
    });

    it('isolates the HTTP/2 isCacheless block correctly', function() {
        assert.ok(region.indexOf("header['X-SourceMap']") > -1,   'region must contain X-SourceMap assignment');
        assert.ok(region.indexOf("header['cache-control']") > -1, 'region must contain cache-control assignment');
    });

    it('cache-control appears AFTER X-SourceMap (i.e. outside the source-map inner if)', function() {
        // In the fixed code the structure is:
        //   if (isCacheless) {
        //     if (/(.js|.css)$/.test...) {    ← inner if: only source-map files
        //       header['X-SourceMap'] = ...;
        //     }                               ← closing } of inner if
        //     header['cache-control'] = ...;  ← must come AFTER the closing }
        //   }
        //
        // In the buggy code cache-control was INSIDE the inner if (before the closing }).
        var xSourceMapPos   = region.indexOf("header['X-SourceMap']");
        var cacheControlPos = region.indexOf("header['cache-control']");

        // cache-control must come after X-SourceMap
        assert.ok(
            cacheControlPos > xSourceMapPos,
            'cache-control must appear after X-SourceMap in the source — otherwise it is inside the source-map guard'
        );

        // The closing } of the inner if must sit between X-SourceMap and cache-control.
        // Find the first } after X-SourceMap.
        var firstClosingBrace = region.indexOf('}', xSourceMapPos);
        assert.ok(
            firstClosingBrace > xSourceMapPos && firstClosingBrace < cacheControlPos,
            'the closing } of the source-map inner if must appear between X-SourceMap and cache-control'
        );
    });

    it('pragma and expires are also outside the source-map guard', function() {
        var xSourceMapPos      = region.indexOf("header['X-SourceMap']");
        var firstClosingBrace  = region.indexOf('}', xSourceMapPos);
        var pragmaPos          = region.indexOf("header['pragma']");
        var expiresPos         = region.indexOf("header['expires']");

        assert.ok(pragmaPos > firstClosingBrace,  "pragma must appear after the source-map inner if's closing }");
        assert.ok(expiresPos > firstClosingBrace, "expires must appear after the source-map inner if's closing }");
    });

    it('X-SourceMap is still only set for .js/.css files with source maps', function() {
        // X-SourceMap must remain BEFORE the first closing } in the region,
        // i.e. still inside the source-map inner if guard.
        var xSourceMapPos     = region.indexOf("header['X-SourceMap']");
        var sourcemapGuardPos = region.indexOf('/(.js|.css)$/');
        assert.ok(
            xSourceMapPos > sourcemapGuardPos,
            'X-SourceMap must be inside the source-map .js/.css guard'
        );
    });

    it('cache-control value is no-cache, no-store, must-revalidate', function() {
        assert.ok(
            /header\['cache-control'\]\s*=\s*'no-cache, no-store, must-revalidate'/.test(region),
            "cache-control must be 'no-cache, no-store, must-revalidate' in HTTP/2 dev path"
        );
    });

});


// ─── 02 — HTTP/2 push-stream dev path: same fix ──────────────────────────────

describe('02 - HTTP/2 push-stream dev path: cache headers cover all pushed assets', function() {

    var src, region;

    before(function() {
        src = fs.readFileSync(SOURCE, 'utf8');

        // The push-stream isCacheless block is the FIRST occurrence of header['X-SourceMap'].
        var xSourceMapIdx  = src.indexOf("header['X-SourceMap']");
        var isCachelessIdx = src.lastIndexOf('if (isCacheless)', xSourceMapIdx);
        var regionEnd      = src.indexOf('header = completeHeaders(header', xSourceMapIdx);
        region = src.slice(isCachelessIdx, regionEnd);
    });

    it('cache-control appears AFTER X-SourceMap in the push-stream isCacheless block', function() {
        var xSourceMapPos   = region.indexOf("header['X-SourceMap']");
        var cacheControlPos = region.indexOf("header['cache-control']");
        assert.ok(cacheControlPos > xSourceMapPos, 'cache-control must appear after X-SourceMap');
        var firstClosingBrace = region.indexOf('}', xSourceMapPos);
        assert.ok(
            firstClosingBrace > xSourceMapPos && firstClosingBrace < cacheControlPos,
            'closing } of source-map inner if must be between X-SourceMap and cache-control'
        );
    });

    it('cache-control value is no-cache, no-store, must-revalidate in push-stream path', function() {
        assert.ok(
            /header\['cache-control'\]\s*=\s*'no-cache, no-store, must-revalidate'/.test(region),
            "cache-control must be 'no-cache, no-store, must-revalidate' in HTTP/2 push-stream dev path"
        );
    });

});


// ─── 03 — HTTP/1.x dev path: cache headers already cover all static types ────

describe('03 - HTTP/1.x dev path: cache-control baseline', function() {

    var src;
    before(function() { src = fs.readFileSync(SOURCE, 'utf8'); });

    it('writeHead(200) with cache-control is present in isCacheless branch', function() {
        assert.ok(
            /response\.writeHead\(200,\s*\{[\s\S]*?'cache-control'\s*:\s*'no-cache, no-store, must-revalidate'/.test(src),
            'HTTP/1.x dev path must call writeHead(200, { cache-control: no-cache... })'
        );
    });

    it('HTTP/1.x prod path uses plain writeHead(200) with no cache headers', function() {
        assert.ok(
            /\}\s*else\s*\{\s*response\.writeHead\(200\)/.test(src),
            'HTTP/1.x prod path must use plain writeHead(200) — cache headers added separately later (#Next)'
        );
    });

});
