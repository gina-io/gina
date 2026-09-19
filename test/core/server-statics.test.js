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


// (§08 — the template.assets registry it guarded was removed with the HTTP/2 stream listener, #B566)

// ─── 09 — directory→index redirect sends 301 on BOTH protocols, dev or not ───
//
// The dir→index normalizer (a static request whose resolved filename is a
// directory containing an index.html) always answered :status 301 on HTTP/2,
// but the HTTP/1.x branch issued its writeHead(301) only inside the
// isCacheless gate — a NON-dev HTTP/1.x directory hit answered 200 with a
// Location header browsers ignore (a blank page instead of the index).
// Reproduced live on a default-configured bundle (http/1.1 + http, non-dev):
// GET /sub/ → HTTP/1.1 200 + location: /sub/index.html + empty body.

describe('09 - dir→index normalizer: unconditional 301, dev-gated no-cache set', function() {

    var src, region, h2Half, h1Half;

    // Strips /* */ blocks and // line comments so negative pins don't trip on
    // the explanatory comments kept next to the code.
    function stripComments(s) {
        return s
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .map(function(line) { return line.replace(/\/\/.*$/, ''); })
            .join('\n');
    }

    before(function() {
        src = fs.readFileSync(SOURCE, 'utf8');

        // The dir→index region: from the index.html rewrite to the
        // require-cache eviction that follows the protocol split.
        var dirIdx = src.indexOf("filename += 'index.html'");
        var endIdx = src.indexOf('delete require.cache', dirIdx);
        region = (dirIdx > -1 && endIdx > dirIdx) ? src.slice(dirIdx, endIdx) : '';

        // Split the region at the HTTP/1.x branch entry.
        var h1Idx = region.indexOf("response.setHeader('location', request.url)");
        h2Half = (h1Idx > -1) ? region.slice(0, h1Idx) : '';
        h1Half = (h1Idx > -1) ? region.slice(h1Idx) : '';
    });

    it('isolates the dir→index region and both protocol halves', function() {
        assert.ok(region.length > 0, 'dir→index region not found');
        assert.ok(h2Half.length > 0 && h1Half.length > 0, 'protocol split anchor not found');
    });

    it('HTTP/2 half: the 301 status is set outside the isCacheless gate', function() {
        var statusIdx = h2Half.indexOf("':status': 301");
        var gateIdx   = h2Half.indexOf('if (isCacheless)');
        assert.ok(statusIdx > -1, 'expected the hardcoded :status 301');
        assert.ok(gateIdx > statusIdx, 'the :status must be assigned before (outside) the dev gate');
    });

    it('HTTP/1.x half: the header set starts with an unconditional content-type', function() {
        var declIdx = h1Half.indexOf('var _dirHeaders');
        var ctIdx   = h1Half.indexOf("'content-type': bundleConf.server.coreConfiguration.mime[ext]");
        var gateIdx = h1Half.indexOf('if (isCacheless)');
        assert.ok(declIdx > -1, 'expected the _dirHeaders literal');
        assert.ok(ctIdx > declIdx && ctIdx < gateIdx, 'content-type must sit in the literal, before the dev gate');
    });

    it('HTTP/1.x half: the no-cache set stays dev-gated', function() {
        var gateIdx = h1Half.indexOf('if (isCacheless)');
        assert.ok(gateIdx > -1);
        ['cache-control', 'pragma', 'expires'].forEach(function(k) {
            var idx = h1Half.indexOf("_dirHeaders['" + k + "']");
            assert.ok(idx > gateIdx, k + ' must be assigned inside the dev gate only');
        });
    });

    it('HTTP/1.x half: writeHead(301, _dirHeaders) is unconditional — after the gate closes', function() {
        var whIdx  = h1Half.indexOf('response.writeHead(301, _dirHeaders)');
        var expIdx = h1Half.indexOf("_dirHeaders['expires']");
        var endIdx = h1Half.indexOf('response.end()');
        assert.ok(whIdx > -1, 'expected the unconditional writeHead(301, _dirHeaders)');
        assert.ok(whIdx > expIdx, 'the writeHead must follow the gated assignments (i.e. sit outside the gate)');
        assert.ok(endIdx > whIdx, 'the response must end after the status is written');
    });

    it('HTTP/1.x half: the pre-fix gated inline writeHead shape is gone', function() {
        assert.ok(
            stripComments(h1Half).indexOf('writeHead(301, {') < 0,
            'the inline-object writeHead inside the dev gate must not come back'
        );
    });

    // Mirrors the fixed header construction.
    function buildDirHeaders(isCacheless, mimeType) {
        var _dirHeaders = { 'content-type': mimeType };
        if (isCacheless) {
            _dirHeaders['cache-control'] = 'no-cache, no-store, must-revalidate';
            _dirHeaders['pragma'] = 'no-cache';
            _dirHeaders['expires'] = '0';
        }
        return { status: 301, headers: _dirHeaders };
    }

    it('replica: non-dev sends 301 with content-type only', function() {
        var r = buildDirHeaders(false, 'text/html');
        assert.equal(r.status, 301);
        assert.deepEqual(Object.keys(r.headers), ['content-type']);
    });

    it('replica: dev sends 301 with the no-cache set on top', function() {
        var r = buildDirHeaders(true, 'text/html');
        assert.equal(r.status, 301);
        assert.equal(r.headers['cache-control'], 'no-cache, no-store, must-revalidate');
        assert.equal(r.headers['pragma'], 'no-cache');
        assert.equal(r.headers['expires'], '0');
    });

    it('subtract: the pre-fix shape leaves the status unwritten outside dev (default 200 + Location)', function() {
        function preFixStatus(isCacheless) {
            var statusWritten = null;
            if (isCacheless) { statusWritten = 301; }
            return statusWritten; // null → the response goes out with the default 200
        }
        assert.equal(preFixStatus(false), null, 'non-dev: no writeHead — the defect (200 with a Location header)');
        assert.equal(preFixStatus(true), 301);
    });

});
