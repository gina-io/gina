var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SOURCE = path.join(require('../fw'), 'core/controller/controller.render-swig.js');


// 01 — Async conversion: exported render function and writeCache must be async (#P28-#P31)
describe('01 - async I/O conversion: render and writeCache are async functions', function() {

    it('module.exports is an async function (render)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /module\.exports\s*=\s*async\s+function\s+render/.test(src),
            'expected `module.exports = async function render` — async conversion (#P28-#P31) was reverted'
        );
    });

    it('writeCache is an async function', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /async\s+function\s+writeCache/.test(src),
            'expected `async function writeCache` — async conversion (#P30) was reverted'
        );
    });

});


// 02 — No synchronous blocking I/O calls remain in render-swig.js (#P28-#P31)
describe('02 - no synchronous blocking fs I/O in render-swig.js', function() {

    it('no fs.readFileSync calls (outside comments)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        // Strip single-line comments before checking
        var stripped = src.replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/fs\.readFileSync/.test(stripped),
            'fs.readFileSync found outside comments — async read (#P28, #P29) was reverted'
        );
    });

    it('no fs.openSync calls (outside comments)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var stripped = src.replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/fs\.openSync/.test(stripped),
            'fs.openSync found outside comments — async write (#P30, #P31) was reverted'
        );
    });

    it('no fs.writeSync calls (outside comments)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var stripped = src.replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/fs\.writeSync/.test(stripped),
            'fs.writeSync found outside comments — async write (#P30, #P31) was reverted'
        );
    });

    it('no fs.closeSync calls (outside comments)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var stripped = src.replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/fs\.closeSync/.test(stripped),
            'fs.closeSync found outside comments — async write (#P30, #P31) was reverted'
        );
    });

});


// 03 — Async replacements are present
describe('03 - async fs.promises calls are present', function() {

    it('uses fs.promises.readFile for template read (#P28)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /await\s+fs\.promises\.readFile\(path\)/.test(src),
            'expected `await fs.promises.readFile(path)` for template read (#P28)'
        );
    });

    it('uses fs.promises.readFile for layout read (#P29)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /await\s+fs\.promises\.readFile\(layoutPath/.test(src),
            'expected `await fs.promises.readFile(layoutPath` for layout read (#P29)'
        );
    });

    it('uses fs.promises.writeFile for cache write (#P30)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /await\s+fs\.promises\.writeFile\(htmlFilename/.test(src),
            'expected `await fs.promises.writeFile(htmlFilename` for cache write (#P30)'
        );
    });

    it('uses fs.promises.writeFile for layout cache write (#P31)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /await\s+fs\.promises\.writeFile\(newLayoutFilename/.test(src),
            'expected `await fs.promises.writeFile(newLayoutFilename` for layout cache write (#P31)'
        );
    });

});


// 04 — Error field priority: actual upstream error over generic statusCodes label (#Q1 / #Q2)
describe('04 - error field priority: data.page.data.error wins over statusCodes[status] (#Q1/#Q2)', function() {

    it('_errDetail is assigned from data.page.data.error first', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /var _errDetail\s*=\s*data\.page\.data\.error\s*\|\|/.test(src),
            'expected `var _errDetail = data.page.data.error ||` — normalization must start from the actual error (#Q2)'
        );
    });

    it('errorObject.error is built with _errDetail first (normalized string)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /error\s*:\s*_errDetail\s*\|\|/.test(src),
            'expected `error: _errDetail ||` — normalized string must be used, not raw data.page.data.error (#Q2)'
        );
    });

    it('statusCodes[...] is used as fallback only (after || _errDetail || _msgDetail)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /_errDetail\s*\|\|.*statusCodes\[/.test(src),
            'expected statusCodes[...] after _errDetail || in the error field (#Q1)'
        );
    });

    it('#Q1 marker is present in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('#Q1') > -1,
            'expected #Q1 marker — comment convention not applied'
        );
    });

    it('replaced comment documents old statusCodes-first pattern', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /replaced:.*statusCodes\[data\.page\.data\.status\]\s+first/.test(src),
            'expected "replaced: statusCodes[data.page.data.status] first" comment (#Q1)'
        );
    });

    it('pure logic: actual error takes priority over generic label', function() {
        // Replicate the errorObject.error assignment logic from render-swig.js
        var statusCodes = { '502': 'Bad Gateway' };
        var data = { status: 502, error: 'upstream timeout', message: 'connection reset' };
        var error = data.error || data.message || statusCodes[data.status] || '';
        assert.equal(error, 'upstream timeout');
    });

    it('pure logic: message used when error is absent', function() {
        var statusCodes = { '502': 'Bad Gateway' };
        var data = { status: 502, message: 'connection reset' };
        var error = data.error || data.message || statusCodes[data.status] || '';
        assert.equal(error, 'connection reset');
    });

    it('pure logic: statusCodes label used when both error and message are absent', function() {
        var statusCodes = { '502': 'Bad Gateway' };
        var data = { status: 502 };
        var error = data.error || data.message || statusCodes[data.status] || '';
        assert.equal(error, 'Bad Gateway');
    });

});


// 05 — console.error fires before throwError on non-2xx interception (#Q1)
describe('05 - console.error fires before throwError in error interception block (#Q1)', function() {

    it('console.error call is present in the error interception block', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /console\.error\(/.test(src),
            'expected console.error() call in error interception block (#Q1)'
        );
    });

    it('[render] prefix is used in console.error log line', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /\[render\].*from upstream/.test(src),
            'expected `[render] ... from upstream` in console.error call (#Q1)'
        );
    });

    it('_errDetail is used in the log to include the actual error reason', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /_errDetail/.test(src),
            'expected `_errDetail` variable used for log detail in error interception (#Q1)'
        );
    });

    it('console.error appears before return self.throwError(errorObject) in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var errLogIdx    = src.indexOf("'[render] '");
        var throwErrIdx  = src.indexOf('return self.throwError(errorObject)');
        assert.ok(errLogIdx > -1,   'console.error with [render] prefix not found');
        assert.ok(throwErrIdx > -1, 'return self.throwError(errorObject) not found');
        assert.ok(
            errLogIdx < throwErrIdx,
            'console.error must appear before return self.throwError(errorObject) (#Q1)'
        );
    });

});


// 06 — Object error normalization: upstream object errors do not render as "[object Object]" (#Q2)
describe('06 - object error normalization: error/message objects coerced to strings (#Q2)', function() {

    it('#Q2 marker is present in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('#Q2') > -1,
            'expected #Q2 marker — comment convention not applied'
        );
    });

    it('normalization guard checks typeof _errDetail === object', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /typeof\(_errDetail\)\s*===\s*'object'/.test(src),
            'expected typeof(_errDetail) === \'object\' guard for normalization (#Q2)'
        );
    });

    it('normalization guard checks typeof _msgDetail === object', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /typeof\(_msgDetail\)\s*===\s*'object'/.test(src),
            'expected typeof(_msgDetail) === \'object\' guard for normalization (#Q2)'
        );
    });

    it('normalization appears before errorObject construction in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var normIdx = src.indexOf('var _errDetail = data.page.data.error');
        var objIdx  = src.indexOf('var errorObject = {');
        assert.ok(normIdx > -1, 'var _errDetail assignment not found');
        assert.ok(objIdx  > -1, 'var errorObject = { not found');
        assert.ok(
            normIdx < objIdx,
            '_errDetail normalization must appear before errorObject construction (#Q2)'
        );
    });

    it('pure logic: object error is coerced via .message', function() {
        var raw = { message: 'upstream timeout', code: 503 };
        var errDetail = raw;
        if (errDetail && typeof errDetail === 'object') {
            errDetail = errDetail.message || errDetail.error || JSON.stringify(errDetail);
        }
        assert.equal(errDetail, 'upstream timeout');
    });

    it('pure logic: object error falls back to .error when .message absent', function() {
        var raw = { error: 'service unavailable' };
        var errDetail = raw;
        if (errDetail && typeof errDetail === 'object') {
            errDetail = errDetail.message || errDetail.error || JSON.stringify(errDetail);
        }
        assert.equal(errDetail, 'service unavailable');
    });

    it('pure logic: object error falls back to JSON.stringify when both absent', function() {
        var raw = { code: 503, reason: 'quota exceeded' };
        var errDetail = raw;
        if (errDetail && typeof errDetail === 'object') {
            errDetail = errDetail.message || errDetail.error || JSON.stringify(errDetail);
        }
        assert.equal(errDetail, JSON.stringify(raw));
    });

    it('pure logic: string error passes through unchanged', function() {
        var raw = 'plain string error';
        var errDetail = raw;
        if (errDetail && typeof errDetail === 'object') {
            errDetail = errDetail.message || errDetail.error || JSON.stringify(errDetail);
        }
        assert.equal(errDetail, 'plain string error');
    });

    it('pure logic: null/undefined error does not trigger normalization', function() {
        var errDetail = null;
        if (errDetail && typeof errDetail === 'object') {
            errDetail = errDetail.message || errDetail.error || JSON.stringify(errDetail);
        }
        assert.equal(errDetail, null);
    });

});


// ── 07 — Normal render exit paths: cache-hit and cache-miss (#H8-prereq) ─────

describe('07 - normal render exit paths: response.end() sites and guards', function() {

    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    // ── Cache-hit path ──────────────────────────────────────────────────

    it('cache-hit: local.res.end(htmlContent) exists on the cache-hit path', function() {
        var src = getSrc();
        // cache.get(cacheKey) is unique to the cache-HIT path (line 766); cache.has(cacheKey)
        // first appears on the cache-WRITE path (line 47) and would anchor the search wrong.
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        assert.ok(cacheGetIdx > -1, 'cache.get(cacheKey) not found');
        var block = src.substring(cacheGetIdx, cacheGetIdx + 10000);
        assert.ok(
            block.indexOf('local.res.end( htmlContent )') > -1,
            'expected local.res.end( htmlContent ) on cache-hit path'
        );
    });

    it('cache-hit: HEAD branch calls local.res.end() without body', function() {
        var src = getSrc();
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        var block = src.substring(cacheGetIdx, cacheGetIdx + 10000);
        // HEAD check pattern: /^HEAD$/i.test(local.req.method)
        assert.ok(
            /HEAD.*\.test\(local\.req\.method\)/.test(block),
            'expected HEAD method check on cache-hit path'
        );
        // content-length set for HEAD
        assert.ok(
            block.indexOf("'content-length'") > -1,
            'expected content-length header set on HEAD cache-hit path'
        );
    });

    it('cache-hit: content-type header set before response', function() {
        var src = getSrc();
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        var endIdx = src.indexOf('local.res.end( htmlContent )', cacheGetIdx);
        var between = src.substring(cacheGetIdx, endIdx);
        assert.ok(
            between.indexOf("setHeader('content-type'") > -1,
            'expected content-type header set before .end() on cache-hit path'
        );
    });

    it('cache-hit: per-request refs nulled after response', function() {
        var src = getSrc();
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        var endIdx = src.indexOf('local.res.end( htmlContent )', cacheGetIdx);
        var after = src.substring(endIdx, endIdx + 500);
        assert.ok(after.indexOf('local.req = null') > -1, 'expected local.req = null after cache-hit .end()');
        assert.ok(after.indexOf('local.res = null') > -1, 'expected local.res = null after cache-hit .end()');
        assert.ok(after.indexOf('local.next = null') > -1, 'expected local.next = null after cache-hit .end()');
    });

    it('cache-hit: _next() called after cleanup', function() {
        var src = getSrc();
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        var endIdx = src.indexOf('local.res.end( htmlContent )', cacheGetIdx);
        var after = src.substring(endIdx, endIdx + 500);
        assert.ok(
            /if\s*\(\s*_next\s*\)\s*return\s+_next\(\)/.test(after),
            'expected _next() call after cache-hit cleanup'
        );
    });

    // ── Cache-miss (fresh compile) path ─────────────────────────────────

    it('cache-miss: local.res.end(htmlContent) exists on the fresh-compile path', function() {
        var src = getSrc();
        // Find the second .end(htmlContent) — the first is cache-hit, second is cache-miss
        var first = src.indexOf('local.res.end( htmlContent )');
        assert.ok(first > -1, 'first local.res.end( htmlContent ) not found');
        var second = src.indexOf('local.res.end( htmlContent )', first + 1);
        assert.ok(second > -1, 'second local.res.end( htmlContent ) not found (cache-miss path)');
    });

    it('cache-miss: HEAD branch exists with content-length', function() {
        var src = getSrc();
        var first = src.indexOf('local.res.end( htmlContent )');
        var second = src.indexOf('local.res.end( htmlContent )', first + 1);
        // Look for HEAD check before the second .end(htmlContent)
        var before = src.substring(second - 3000, second);
        assert.ok(
            /HEAD.*\.test\(local\.req\.method\)/.test(before),
            'expected HEAD method check on cache-miss path'
        );
    });

    it('cache-miss: per-request refs nulled after response', function() {
        var src = getSrc();
        var first = src.indexOf('local.res.end( htmlContent )');
        var second = src.indexOf('local.res.end( htmlContent )', first + 1);
        var after = src.substring(second, second + 500);
        assert.ok(after.indexOf('local.req = null') > -1, 'expected local.req = null after cache-miss .end()');
        assert.ok(after.indexOf('local.res = null') > -1, 'expected local.res = null after cache-miss .end()');
    });

    // ── Fallthrough error path ─────────────────────────���────────────────

    it('fallthrough: safety-net .end() with error message', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf("local.res.end('Unexpected controller error while trying to render.')") > -1,
            'expected fallthrough safety-net .end() with error message'
        );
    });

    it('fallthrough: per-request refs nulled after safety-net', function() {
        var src = getSrc();
        var idx = src.indexOf("local.res.end('Unexpected controller error");
        var after = src.substring(idx, idx + 500);
        assert.ok(after.indexOf('local.req = null') > -1, 'expected local.req = null after fallthrough .end()');
        assert.ok(after.indexOf('local.res = null') > -1, 'expected local.res = null after fallthrough .end()');
    });

    // ── Total .end() count ──────────────────────────────────────────────

    it('exactly 5 local.res.end() calls in the file', function() {
        var src = getSrc();
        var matches = src.match(/local\.res\.end\s*\(/g);
        assert.ok(matches, 'no local.res.end() calls found');
        assert.strictEqual(matches.length, 5, 'expected exactly 5 local.res.end() calls (2 HEAD + 2 body + 1 fallthrough)');
    });

    it('zero local.res.write() calls — all writes use .end(body)', function() {
        var src = getSrc();
        // Strip comments
        var stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        assert.ok(
            stripped.indexOf('local.res.write(') === -1,
            'expected no local.res.write() — all responses should use .end(body) for HTTP/2 compatibility'
        );
    });

});


// ── 08 — Error exit paths: throwError sites and early returns (#H8-prereq) ───

describe('08 - error exit paths: throwError calls and early returns', function() {

    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    it('upstream non-2xx interception: return self.throwError(errorObject)', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('return self.throwError(errorObject)') > -1,
            'expected return self.throwError(errorObject) for upstream error interception'
        );
    });

    it('non-2xx interception guarded by status not starting with 2', function() {
        var src = getSrc();
        assert.ok(
            /String\(data\.page\.data\.status\)\.startsWith\('2'\)/.test(src),
            'expected status.startsWith("2") guard for non-2xx interception'
        );
    });

    it('non-2xx interception requires data.page.data.error to be defined', function() {
        var src = getSrc();
        var interceptIdx = src.indexOf('return self.throwError(errorObject)');
        var before = src.substring(Math.max(0, interceptIdx - 3500), interceptIdx);
        assert.ok(
            before.indexOf("data.page.data.error") > -1,
            'expected data.page.data.error check before interception'
        );
    });

    it('template not found: throwError + return', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf("fs.existsSync(path)") > -1,
            'expected fs.existsSync(path) check for template existence'
        );
        // throwError with ApiError followed by return
        var tplCheckIdx = src.indexOf("!fs.existsSync(path)");
        assert.ok(tplCheckIdx > -1, '!fs.existsSync(path) not found');
        var block = src.substring(tplCheckIdx, tplCheckIdx + 1000);
        assert.ok(
            /self\.throwError\(err\)\s*;[\s\S]*?return\s*;/.test(block),
            'expected self.throwError(err); return; after template not found'
        );
    });

    it('swig filter exception: throwError + return', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('[SwigFilters]') > -1,
            'expected [SwigFilters] error message in throwError call'
        );
    });

    it('layout not found: throwError + return', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('could not locate the file') > -1,
            'expected layout not found error message'
        );
    });

    it('data blacklist escaping failure: throwError + return', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('compilation error') > -1,
            'expected compilation error message for blacklist escaping failure'
        );
    });

    it('getAssets failure: throwError + return', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('calling getAssets') > -1,
            'expected getAssets error message in throwError call'
        );
    });

    it('deferred error object forwarding: return self.throwError(local.req.params.errorObject)', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('return self.throwError(local.req.params.errorObject)') > -1,
            'expected deferred error object forwarding'
        );
    });

    it('catch-all: return self.throwError(local.res, 500, err)', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('return self.throwError(local.res, 500, err)') > -1,
            'expected catch-all throwError at the end of the try block'
        );
    });

    it('catch-all is in a catch block', function() {
        var src = getSrc();
        var catchAllIdx = src.indexOf('return self.throwError(local.res, 500, err)');
        var before = src.substring(Math.max(0, catchAllIdx - 100), catchAllIdx);
        assert.ok(
            /\}\s*catch\s*\(err\)\s*\{/.test(before),
            'expected catch(err) block before the catch-all throwError'
        );
    });

    it('rendering stack guard: return false when length > 1', function() {
        var src = getSrc();
        assert.ok(
            /renderingStack\.length\s*>\s*1/.test(src),
            'expected renderingStack.length > 1 guard'
        );
        // Must return false
        var guardIdx = src.indexOf('renderingStack.length > 1');
        var block = src.substring(guardIdx, guardIdx + 200);
        assert.ok(
            block.indexOf('return false') > -1,
            'expected return false after rendering stack guard'
        );
    });

    it('CVE-2023-25345 path traversal throw', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('[CVE-2023-25345] Path traversal attempt blocked') > -1,
            'expected CVE-2023-25345 path traversal throw'
        );
    });

});


// ── 09 — Guard patterns: headersSent, HEAD, stream variable (#H8-prereq) ────

describe('09 - guard patterns: headersSent, HEAD, stream setup', function() {

    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    it('headersSent() guard exists on cache-hit path', function() {
        var src = getSrc();
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        var block = src.substring(cacheGetIdx, cacheGetIdx + 4000);
        assert.ok(
            /if\s*\(\s*!headersSent\(\)\s*\)/.test(block),
            'expected !headersSent() guard on cache-hit path'
        );
    });

    it('headersSent() guard exists on cache-miss path', function() {
        var src = getSrc();
        // The cache-miss path headersSent guard is after the swig.compile section
        var compileIdx = src.indexOf('swig.compile(');
        assert.ok(compileIdx > -1, 'swig.compile not found');
        var block = src.substring(compileIdx, compileIdx + 5000);
        assert.ok(
            /if\s*\(\s*!headersSent\(\)\s*\)/.test(block),
            'expected !headersSent() guard on cache-miss path'
        );
    });

    it('stream variable set up from local.res.stream', function() {
        var src = getSrc();
        assert.ok(
            /stream\s*=\s*local\.res\.stream/.test(src),
            'expected stream = local.res.stream assignment'
        );
    });

    it('stream variable initialized to null', function() {
        var src = getSrc();
        assert.ok(
            /,\s*stream\s*=\s*null/.test(src),
            'expected stream = null initialization'
        );
    });

    it('3 cleanup blocks with local.req/res/next = null', function() {
        var src = getSrc();
        var matches = src.match(/local\.req\s*=\s*null\s*;\s*\n\s*local\.res\s*=\s*null/g);
        assert.ok(matches, 'no cleanup blocks found');
        assert.strictEqual(matches.length, 3, 'expected exactly 3 cleanup blocks (cache-hit, cache-miss, fallthrough)');
    });

    it('_next alias pattern used (not direct local.next())', function() {
        var src = getSrc();
        // _next should be captured before local.next is nulled
        var matches = src.match(/var _next\s*=.*local\.next/g);
        assert.ok(matches && matches.length >= 3, 'expected at least 3 _next alias captures');
    });

    it('isRenderingCustomError flag cleared on cache-hit and cache-miss paths', function() {
        var src = getSrc();
        var matches = src.match(/localOptions\.isRenderingCustomError\s*=\s*false/g);
        assert.ok(matches && matches.length >= 2, 'expected isRenderingCustomError = false on at least 2 paths');
    });

});


// ── 10 — HTTP/2 readiness: commented blocks and render-json.js patterns (#H8) ─

describe('10 - HTTP/2 direct stream implementation (#H8)', function() {

    var _src, _jsonSrc;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }
    function getJsonSrc() {
        if (!_jsonSrc) {
            var jsonPath = path.join(path.dirname(SOURCE), 'controller.render-json.js');
            _jsonSrc = fs.readFileSync(jsonPath, 'utf8');
        }
        return _jsonSrc;
    }
    function stripComments(s) { return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); }

    // ── Commented HTTP/2 blocks exist ──────────────────────────���─────────

    it('5 active stream.respond() calls (2 HEAD + 2 body + 1 error)', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/stream\.respond\(/g);
        assert.ok(matches, 'no active stream.respond() found');
        assert.strictEqual(matches.length, 5, 'expected 5 stream.respond() calls');
    });

    it('5 active stream.end() calls (2 HEAD + 2 body + 1 error)', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/stream\.end\(/g);
        assert.ok(matches, 'no active stream.end() found');
        assert.strictEqual(matches.length, 5, 'expected 5 stream.end() calls');
    });

    // ── All 5 patterns from render-json.js are now present ───────────────

    it('stream.destroyed guard exists in active code (3 body/error paths)', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/stream\.destroyed/g);
        assert.ok(matches, 'no stream.destroyed guard found');
        assert.strictEqual(matches.length, 3, 'expected 3 stream.destroyed guards (cache-hit, cache-miss, error)');
    });

    it('local.res.getHeaders merge exists in active code (5 paths)', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/local\.res\.getHeaders/g);
        assert.ok(matches, 'no local.res.getHeaders found');
        assert.ok(matches.length >= 5, 'expected at least 5 getHeaders merges (2 HEAD + 2 body + 1 error)');
    });

    it('local.res.headersSent = true assignment exists in active code (5 paths)', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/local\.res\.headersSent\s*=\s*true/g);
        assert.ok(matches, 'no local.res.headersSent = true found');
        assert.strictEqual(matches.length, 5, 'expected 5 headersSent = true assignments');
    });

    it('dynamic :status from local.res.statusCode || 200 in body/HEAD paths', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/local\.res\.statusCode\s*\|\|\s*200/g);
        assert.ok(matches, 'no dynamic :status found');
        assert.strictEqual(matches.length, 4, 'expected 4 dynamic :status (2 HEAD + 2 body, error uses hardcoded 500)');
    });

    it('hardcoded :status 500 in error fallthrough path', function() {
        var src = getSrc();
        var errFallthru = src.indexOf("stream.end('Unexpected controller error");
        assert.ok(errFallthru > -1, 'error fallthrough stream.end() not found');
        var block = src.substring(Math.max(0, errFallthru - 500), errFallthru);
        assert.ok(
            /':status'\s*:\s*500/.test(block),
            'expected :status 500 before error stream.end()'
        );
    });

    it('!stream.headersSent check before every stream.respond() (5 paths)', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/!stream\.headersSent/g);
        assert.ok(matches, 'no !stream.headersSent found');
        assert.strictEqual(matches.length, 5, 'expected 5 !stream.headersSent checks');
    });

    // ── Pattern parity with render-json.js ──────────────────────────────

    it('render-swig.js now matches render-json.js stream patterns', function() {
        var swigStripped = stripComments(getSrc());
        var jsonStripped = stripComments(getJsonSrc());
        assert.ok(swigStripped.indexOf('stream.destroyed') > -1, 'render-swig.js must have stream.destroyed');
        assert.ok(jsonStripped.indexOf('stream.destroyed') > -1, 'render-json.js must have stream.destroyed');
        assert.ok(swigStripped.indexOf('.getHeaders') > -1, 'render-swig.js must merge pending headers');
        assert.ok(jsonStripped.indexOf('.getHeaders') > -1, 'render-json.js must merge pending headers');
        assert.ok(/headersSent\s*=\s*true/.test(swigStripped), 'render-swig.js must set headersSent = true');
        assert.ok(/headersSent\s*=\s*true/.test(jsonStripped), 'render-json.js must set headersSent = true');
    });

    // ── HTTP/1.1 fallback preserved ─────────────────────────────────────

    it('local.res.end() calls preserved for HTTP/1.1 fallback', function() {
        var src = getSrc();
        var matches = src.match(/local\.res\.end\s*\(/g);
        assert.ok(matches, 'no local.res.end() found');
        assert.strictEqual(matches.length, 5, 'expected 5 local.res.end() calls for HTTP/1.1 fallback');
    });

    // ── Pure logic: patterns that #H8 must implement ────────────────────

    it('pure logic: destroyed stream guard prevents ERR_HTTP2_INVALID_STREAM', function() {
        // Replicate the guard from render-json.js
        var stream = { destroyed: true, closed: false, respond: function() { throw new Error('should not call'); }, end: function() { throw new Error('should not call'); } };
        var called = false;
        if (stream.destroyed || stream.closed) {
            called = true; // guard triggers — skip response
        }
        assert.ok(called, 'destroyed stream must trigger the guard');
    });

    it('pure logic: pending headers merge preserves CORS headers', function() {
        // Replicate the getHeaders merge from render-json.js
        var _streamHeaders = { 'content-type': 'text/html', ':status': 200 };
        var _pendingHeaders = {
            'access-control-allow-origin': '*',
            'x-custom': 'value'
        };
        for (var k in _pendingHeaders) {
            if (!(k in _streamHeaders)) _streamHeaders[k] = _pendingHeaders[k];
        }
        assert.strictEqual(_streamHeaders['access-control-allow-origin'], '*');
        assert.strictEqual(_streamHeaders['x-custom'], 'value');
        // content-type must not be overridden
        assert.strictEqual(_streamHeaders['content-type'], 'text/html');
    });

    it('pure logic: dynamic :status uses local.res.statusCode', function() {
        var res = { statusCode: 404 };
        var status = res.statusCode || 200;
        assert.strictEqual(status, 404, ':status must use statusCode when set');
    });

    it('pure logic: :status defaults to 200 when statusCode is 0 or undefined', function() {
        var res1 = { statusCode: 0 };
        var res2 = {};
        assert.strictEqual(res1.statusCode || 200, 200, ':status must default to 200 for statusCode=0');
        assert.strictEqual(res2.statusCode || 200, 200, ':status must default to 200 for undefined statusCode');
    });

});
