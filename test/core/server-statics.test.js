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

    it('HTTP/1.x prod path uses writeHead(200) with ETag + Last-Modified headers', function() {
        assert.ok(
            /\}\s*else\s*\{\s*\/\/ production[\s\S]*?response\.writeHead\(200,\s*\{[\s\S]*?'last-modified'[\s\S]*?'etag'/.test(src),
            'HTTP/1.x prod path must use writeHead(200, { last-modified, etag }) after the ETag/304 work (#Next)'
        );
    });

});


// ─── 04 — stat is cached and reused ──────────────────────────────────────────

describe('04 - stat is cached at the entry point and reused for ETag', function() {

    var src;
    before(function() { src = fs.readFileSync(SOURCE, 'utf8'); });

    it('stat is declared in the handleStatics variable block alongside isFilenameDir', function() {
        assert.ok(
            /var isFilenameDir\s*=\s*null[\s\S]{0,200},\s*stat\s*=\s*null/.test(src),
            'stat = null must be declared with isFilenameDir in the handleStatics variable block'
        );
    });

    it('stat is assigned before isDirectory() is called', function() {
        assert.ok(
            /stat\s*=\s*fs\.statSync\(filename\);\s*\n\s*isFilenameDir\s*=\s*stat\.isDirectory\(\)/.test(src),
            'stat = fs.statSync(filename) must immediately precede isFilenameDir = stat.isDirectory()'
        );
    });

    it('ETag uses stat.size and stat.mtime.getTime()', function() {
        assert.ok(
            /var etag\s*=\s*'"'\s*\+\s*stat\.size\s*\+\s*'-'\s*\+\s*stat\.mtime\.getTime\(\)\s*\+\s*'"'/.test(src),
            'ETag must be constructed as "<size>-<mtime.getTime()>"'
        );
    });

    it('Last-Modified uses stat.mtime.toUTCString()', function() {
        assert.ok(
            /var lastModified\s*=\s*stat\.mtime\.toUTCString\(\)/.test(src),
            'lastModified must use stat.mtime.toUTCString()'
        );
    });

});


// ─── 05 — 304 conditional check logic ────────────────────────────────────────

describe('05 - 304 conditional check logic', function() {

    var src, region;

    before(function() {
        src = fs.readFileSync(SOURCE, 'utf8');
        // Locate the 304 check block: back-track from the if-none-match read to the
        // enclosing !isCacheless guard, forward to the return; that exits the 304 branch.
        var ifNoneMatchIdx = src.indexOf("request.headers['if-none-match']");
        var guardIdx       = src.lastIndexOf('if (!isCacheless)', ifNoneMatchIdx);
        var regionEnd      = src.indexOf('return;', ifNoneMatchIdx) + 'return;'.length;
        region = src.slice(guardIdx, regionEnd);
    });

    it('isolates the 304 check region correctly', function() {
        assert.ok(region.indexOf("request.headers['if-none-match']") > -1, 'region must contain if-none-match read');
        assert.ok(region.indexOf('!isCacheless') > -1,                     'region must start with !isCacheless guard');
    });

    it('304 check is guarded by !isCacheless — never fires in dev mode', function() {
        var guardPos       = region.indexOf('!isCacheless');
        var ifNoneMatchPos = region.indexOf("request.headers['if-none-match']");
        assert.ok(guardPos < ifNoneMatchPos, '!isCacheless guard must precede the if-none-match read');
    });

    it('if-none-match takes strict equality precedence over if-modified-since', function() {
        // Compare the positions of the actual conditional evaluations, not the variable declarations.
        var ifNoneMatchCheckPos   = region.indexOf('ifNoneMatch === etag');
        var ifModifiedSinceUsePos = region.indexOf('new Date(ifModifiedSince)');
        assert.ok(ifNoneMatchCheckPos > -1,                          'if-none-match === etag check must be present');
        assert.ok(ifModifiedSinceUsePos > -1,                        'new Date(ifModifiedSince) evaluation must be present');
        assert.ok(ifNoneMatchCheckPos < ifModifiedSinceUsePos,       'if-none-match check must be evaluated before if-modified-since');
    });

    it('if-modified-since is only evaluated when if-none-match is absent', function() {
        assert.ok(
            /!ifNoneMatch\s*&&\s*ifModifiedSince/.test(region),
            'if-modified-since must only be evaluated when ifNoneMatch is falsy'
        );
    });

    it('if-modified-since uses >= comparison against stat.mtime', function() {
        assert.ok(
            /new Date\(ifModifiedSince\)\s*>=\s*stat\.mtime/.test(region),
            'if-modified-since must compare new Date(ifModifiedSince) >= stat.mtime'
        );
    });

});


// ─── 06 — 304 response mechanism (HTTP/2 and HTTP/1.x) ───────────────────────

describe('06 - 304 response mechanism per protocol', function() {

    var src, region;

    before(function() {
        src = fs.readFileSync(SOURCE, 'utf8');
        var ifNoneMatchIdx = src.indexOf("request.headers['if-none-match']");
        var guardIdx       = src.lastIndexOf('if (!isCacheless)', ifNoneMatchIdx);
        var regionEnd      = src.indexOf('return;', ifNoneMatchIdx) + 'return;'.length;
        region = src.slice(guardIdx, regionEnd);
    });

    it("HTTP/2 304 uses stream.respond with ':status' 304", function() {
        assert.ok(
            /stream\.respond\(\s*\{\s*':status'\s*:\s*304\s*\}/.test(region),
            "HTTP/2 304 must use stream.respond({ ':status': 304 })"
        );
    });

    it('HTTP/2 304 calls stream.end() after stream.respond()', function() {
        var respondPos = region.search(/stream\.respond\(\s*\{\s*':status'\s*:\s*304/);
        var endPos     = region.indexOf('stream.end()', respondPos);
        assert.ok(endPos > respondPos, 'stream.end() must follow stream.respond() for HTTP/2 304');
    });

    it('HTTP/1.x 304 uses response.writeHead(304)', function() {
        assert.ok(
            /response\.writeHead\(304\)/.test(region),
            'HTTP/1.x 304 must call response.writeHead(304)'
        );
    });

    it('HTTP/1.x 304 calls response.end() after writeHead(304)', function() {
        var writeHeadPos = region.indexOf('response.writeHead(304)');
        var endPos       = region.indexOf('response.end()', writeHeadPos);
        assert.ok(endPos > writeHeadPos, 'response.end() must follow response.writeHead(304)');
    });

    it('304 path logs the request with [304] status marker', function() {
        assert.ok(
            /console\.info\(.*\[304\]/.test(region),
            '304 path must log the request with a [304] marker'
        );
    });

});


// ─── 07 — ETag + Last-Modified on production 200 responses ───────────────────

describe('07 - ETag + Last-Modified are set on production 200 responses', function() {

    var src;
    before(function() { src = fs.readFileSync(SOURCE, 'utf8'); });

    it('HTTP/2 production else branch sets header[last-modified] and header[etag]', function() {
        // Region: from the last X-SourceMap assignment to the completeHeaders call that follows.
        var xSourceMapIdx = src.lastIndexOf("header['X-SourceMap']");
        var regionEnd     = src.indexOf('header  = completeHeaders(header', xSourceMapIdx);
        var region        = src.slice(xSourceMapIdx, regionEnd);
        assert.ok(
            /header\['last-modified'\]\s*=\s*lastModified/.test(region),
            "HTTP/2 production path must set header['last-modified'] = lastModified"
        );
        assert.ok(
            /header\['etag'\]\s*=\s*etag/.test(region),
            "HTTP/2 production path must set header['etag'] = etag"
        );
    });

    it('HTTP/2 ETag + Last-Modified are in the else branch (not inside isCacheless dev block)', function() {
        var xSourceMapIdx   = src.lastIndexOf("header['X-SourceMap']");
        var regionEnd       = src.indexOf('header  = completeHeaders(header', xSourceMapIdx);
        var region          = src.slice(xSourceMapIdx, regionEnd);
        // The closing } of the inner source-map if must come before last-modified
        var firstBrace      = region.indexOf('}');
        var lastModifiedPos = region.indexOf("header['last-modified']");
        assert.ok(
            firstBrace < lastModifiedPos,
            'last-modified must appear after the closing } of the source-map guard (i.e. in the else branch)'
        );
    });

    it('HTTP/1.x production writeHead(200) includes last-modified and etag', function() {
        // Locate the HTTP/1.x X-SourceMap setHeader call, then the else branch that follows.
        var xSourceMapH1Idx = src.lastIndexOf('response.setHeader("X-SourceMap"');
        var elseIdx         = src.indexOf('} else {', xSourceMapH1Idx);
        var regionEnd       = src.indexOf('\n\n', elseIdx + 10);
        var region          = src.slice(elseIdx, regionEnd);
        assert.ok(
            /'last-modified'\s*:\s*lastModified/.test(region),
            "HTTP/1.x production writeHead must include 'last-modified': lastModified"
        );
        assert.ok(
            /'etag'\s*:\s*etag/.test(region),
            "HTTP/1.x production writeHead must include 'etag': etag"
        );
    });

    it('HTTP/1.x ETag + Last-Modified are in the else branch (not in the dev writeHead)', function() {
        var xSourceMapH1Idx = src.lastIndexOf('response.setHeader("X-SourceMap"');
        var devWriteHeadIdx = src.indexOf("'cache-control': 'no-cache, no-store, must-revalidate'", xSourceMapH1Idx);
        var elseIdx         = src.indexOf('} else {', xSourceMapH1Idx);
        // The else branch (with last-modified/etag) must appear after the dev writeHead block
        assert.ok(
            elseIdx > devWriteHeadIdx,
            'else branch (with last-modified/etag) must appear after the dev writeHead block'
        );
    });

});
