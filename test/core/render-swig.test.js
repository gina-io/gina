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

    it('dispatches the output-cache write through renderCache.set (#P30 moved to lib/render-cache)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        // Slice 0: #P30's async fs write moved into lib/render-cache. The
        // delegate now hands (type, key, entry, payload) to the strategy
        // dispatcher; the async fs.promises.writeFile is covered by
        // test/lib/render-cache.test.js.
        assert.ok(
            /await\s+renderCache\.set\(\s*cachingOption\.type\s*,\s*cacheKey\s*,\s*cacheObject\s*,\s*\{[\s\S]{0,200}content\s*:\s*htmlContent[\s\S]{0,200}kind\s*:\s*['"]html['"]/.test(src),
            'expected the output-cache write to go through renderCache.set(cachingOption.type, cacheKey, cacheObject, { content: htmlContent, …, kind: "html" })'
        );
    });

    it('uses async fs.promises for layout cache placement (#P31)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        // The layout cache write must be async (#P31). After the
        // 2026-05-11 atomic-rename race fix, the cache file is placed via
        // a temp+rename pair: writeFile to a per-process temp, then rename
        // onto newLayoutFilename. The rename target identifier is the
        // load-bearing signal — section 02 already guards globally against
        // fs.openSync / fs.writeSync, so any path reaching the rename
        // below has gone through async fs.promises.
        assert.ok(
            /await\s+fs\.promises\.rename\([^,)]+,\s*newLayoutFilename\s*\)/.test(src),
            'expected `await fs.promises.rename(<temp>, newLayoutFilename)` for atomic layout cache placement (#P31)'
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

    it('cache-hit: res.end(htmlContent) exists on the cache-hit path', function() {
        var src = getSrc();
        // cache.get(cacheKey) is unique to the cache-HIT path (line 766); cache.has(cacheKey)
        // first appears on the cache-WRITE path (line 47) and would anchor the search wrong.
        // Robust anchor form (indexOf-from-cacheGet, matching the sibling tests below at the
        // content-type / nulling checks): finds res.end on the cache-hit path regardless of
        // how much inspector-data injection precedes it — the prior fixed 12000-char window
        // was brittle (#AISTREAM's snapshot attach tipped res.end past it). Per
        // inspector-server.md "Source-scanning tests" / jsdoc.md fixed-window gotcha: prefer
        // a structural anchor over a char-distance window.
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        assert.ok(cacheGetIdx > -1, 'cache.get(cacheKey) not found');
        assert.ok(
            src.indexOf('res.end( htmlContent )', cacheGetIdx) > -1,
            'expected res.end( htmlContent ) on the cache-hit path after cache.get(cacheKey)'
        );
    });

    it('cache-hit: HEAD branch calls res.end() without body', function() {
        var src = getSrc();
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        // End-anchor, not a char window (same idiom as the sibling test below, and as
        // the comment above prescribes). The HEAD branch always precedes the body
        // res.end() on the cache-hit path, so slice TO it instead of guessing a
        // distance: the old +10000 window was down to 164 bytes of headroom once the
        // writeCache try/catch landed. Per jsdoc.md § fixed-window block slicers.
        var endIdx = src.indexOf('res.end( htmlContent )', cacheGetIdx);
        assert.ok(endIdx > -1, 'res.end( htmlContent ) not found after cache.get(cacheKey)');
        var block = src.substring(cacheGetIdx, endIdx);
        // HEAD check pattern: /^HEAD$/i.test(req.method)
        assert.ok(
            /HEAD.*\.test\(req\.method\)/.test(block),
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
        var endIdx = src.indexOf('res.end( htmlContent )', cacheGetIdx);
        var between = src.substring(cacheGetIdx, endIdx);
        assert.ok(
            between.indexOf("setHeader('content-type'") > -1,
            'expected content-type header set before .end() on cache-hit path'
        );
    });

    it('cache-hit: per-request refs nulled after response', function() {
        var src = getSrc();
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        var endIdx = src.indexOf('res.end( htmlContent )', cacheGetIdx);
        var after = src.substring(endIdx, endIdx + 500);
        assert.ok(after.indexOf('local.req = null') > -1, 'expected local.req = null after cache-hit .end()');
        assert.ok(after.indexOf('local.res = null') > -1, 'expected local.res = null after cache-hit .end()');
        assert.ok(after.indexOf('local.next = null') > -1, 'expected local.next = null after cache-hit .end()');
    });

    it('cache-hit: _next() called after cleanup', function() {
        var src = getSrc();
        var cacheGetIdx = src.indexOf('cache.get(cacheKey)');
        var endIdx = src.indexOf('res.end( htmlContent )', cacheGetIdx);
        // Window grew from 500 → 800 after the #M1 retrofit added an inline
        // explanation of the function-scoped captures pattern alongside the
        // closure-null cleanup. The pattern we want (`if (_next) return _next()`)
        // still sits in the same block, just further down the source.
        var after = src.substring(endIdx, endIdx + 800);
        assert.ok(
            /if\s*\(\s*_next\s*\)\s*return\s+_next\(\)/.test(after),
            'expected _next() call after cache-hit cleanup'
        );
    });

    // ── Cache-miss (fresh compile) path ─────────────────────────────────

    it('cache-miss: res.end(htmlContent) exists on the fresh-compile path', function() {
        var src = getSrc();
        // Find the second .end(htmlContent) — the first is cache-hit, second is cache-miss
        var first = src.indexOf('res.end( htmlContent )');
        assert.ok(first > -1, 'first res.end( htmlContent ) not found');
        var second = src.indexOf('res.end( htmlContent )', first + 1);
        assert.ok(second > -1, 'second res.end( htmlContent ) not found (cache-miss path)');
    });

    it('cache-miss: HEAD branch exists with content-length', function() {
        var src = getSrc();
        var first = src.indexOf('res.end( htmlContent )');
        var second = src.indexOf('res.end( htmlContent )', first + 1);
        // Start-anchor on swig.compile( — the defining token of the fresh-compile path,
        // already used as an anchor below — instead of a lookback window. The old
        // `second - 3400` had 195 bytes of slack: invariant to upstream edits, but any
        // future line added BETWEEN the HEAD check and the body res.end() would break
        // it. Per jsdoc.md § fixed-window block slicers.
        var compileIdx = src.indexOf('swig.compile(');
        assert.ok(compileIdx > -1 && compileIdx < second, 'swig.compile( not found before the cache-miss res.end()');
        var before = src.substring(compileIdx, second);
        assert.ok(
            /HEAD.*\.test\(req\.method\)/.test(before),
            'expected HEAD method check on cache-miss path'
        );
    });

    it('cache-miss: per-request refs nulled after response', function() {
        var src = getSrc();
        var first = src.indexOf('res.end( htmlContent )');
        var second = src.indexOf('res.end( htmlContent )', first + 1);
        var after = src.substring(second, second + 500);
        assert.ok(after.indexOf('local.req = null') > -1, 'expected local.req = null after cache-miss .end()');
        assert.ok(after.indexOf('local.res = null') > -1, 'expected local.res = null after cache-miss .end()');
    });

    // ── Fallthrough error path ─────────────────────────���────────────────

    it('fallthrough: safety-net .end() with error message', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf("res.end('Unexpected controller error while trying to render.')") > -1,
            'expected fallthrough safety-net .end() with error message'
        );
    });

    it('fallthrough: per-request refs nulled after safety-net', function() {
        var src = getSrc();
        var idx = src.indexOf("res.end('Unexpected controller error");
        var after = src.substring(idx, idx + 500);
        assert.ok(after.indexOf('local.req = null') > -1, 'expected local.req = null after fallthrough .end()');
        assert.ok(after.indexOf('local.res = null') > -1, 'expected local.res = null after fallthrough .end()');
    });

    // ── Total .end() count ──────────────────────────────────────────────

    it('exactly 5 res.end() calls in the file', function() {
        var src = getSrc();
        // Word-boundary anchor since `res` is now used as the function-scoped
        // capture name (no `local.` prefix to disambiguate).
        var matches = src.match(/\bres\.end\s*\(/g);
        assert.ok(matches, 'no res.end() calls found');
        assert.strictEqual(matches.length, 9, 'expected exactly 9 res.end() calls (5 original: 2 HEAD + 2 body + 1 fallthrough; plus 4 #B562 deferral branches, one per converted raw-stream site)');
    });

    it('zero res.write() calls — all writes use .end(body)', function() {
        var src = getSrc();
        // Strip comments
        var stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        assert.ok(
            !/\bres\.write\(/.test(stripped),
            'expected no res.write() — all responses should use .end(body) for HTTP/2 compatibility'
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

    it('deferred error object forwarding: return self.throwError(req.params.errorObject)', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('return self.throwError(req.params.errorObject)') > -1,
            'expected deferred error object forwarding'
        );
    });

    it('catch-all: return self.throwError(res, 500, err)', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('return self.throwError(res, 500, err)') > -1,
            'expected catch-all throwError at the end of the try block'
        );
    });

    it('catch-all is in a catch block', function() {
        var src = getSrc();
        var catchAllIdx = src.indexOf('return self.throwError(res, 500, err)');
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

    it('stream variable set up from res.stream', function() {
        var src = getSrc();
        assert.ok(
            /stream\s*=\s*res\.stream/.test(src),
            'expected stream = res.stream assignment'
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
        // Post-retrofit shape (#M1 race-fix): _next is captured ONCE at the top
        // of render() from local.next, then used at each terminal exit. Pre-retrofit
        // the file had 3 redundant `var _next = local.next` captures (one per
        // exit block); those are now consolidated into the single top-of-render
        // capture, with terminal exits relying on the function-scoped _next.
        var matches = src.match(/var _next\s*=.*local\.next/g);
        assert.ok(matches && matches.length >= 1, 'expected at least 1 _next capture from local.next at top of render()');
        // _next must still be invoked at terminal exits (the `if (_next) return _next()` pattern).
        var invokes = src.match(/if\s*\(\s*_next\s*\)\s*return\s+_next\(\)/g);
        assert.ok(invokes && invokes.length >= 3, 'expected at least 3 `if (_next) return _next()` terminal-exit invocations');
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

    it('stream.destroyed guard exists in active code (3 response-path + 2 trailer-callback guards)', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/stream\.destroyed/g);
        assert.ok(matches, 'no stream.destroyed guard found');
        // 3 response-path guards (cache-hit body, cache-miss body, error) + 2 #H10
        // trailer-callback guards (cache-hit + cache-miss wantTrailers handlers).
        assert.strictEqual(matches.length, 5, 'expected 5 stream.destroyed guards (3 response-path + 2 trailer-callback)');
    });

    it('res.getHeaders merge exists in active code (5 paths)', function() {
        var stripped = stripComments(getSrc());
        // Word-boundary anchor since `res` is now the function-scoped capture
        // name (no `local.` prefix to disambiguate from other identifiers).
        var matches = stripped.match(/\bres\.getHeaders/g);
        assert.ok(matches, 'no res.getHeaders found');
        assert.ok(matches.length >= 5, 'expected at least 5 getHeaders merges (2 HEAD + 2 body + 1 error)');
    });

    it('res.headersSent = true assignment exists in active code (5 paths)', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/\bres\.headersSent\s*=\s*true/g);
        assert.ok(matches, 'no res.headersSent = true found');
        assert.strictEqual(matches.length, 5, 'expected 5 headersSent = true assignments');
    });

    it('dynamic :status from res.statusCode || 200 in body/HEAD paths', function() {
        var stripped = stripComments(getSrc());
        var matches = stripped.match(/\bres\.statusCode\s*\|\|\s*200/g);
        assert.ok(matches, 'no dynamic :status found');
        assert.strictEqual(matches.length, 8, 'expected 8 dynamic :status (4 original: 2 HEAD + 2 body; plus 4 in the #B562 writeHead calls; error still uses hardcoded 500)');
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

    it('res.end() calls preserved for HTTP/1.1 fallback', function() {
        var src = getSrc();
        // Word-boundary anchor: `res` is the function-scoped capture name.
        var matches = src.match(/\bres\.end\s*\(/g);
        assert.ok(matches, 'no res.end() found');
        assert.strictEqual(matches.length, 9, 'expected 9 res.end() calls (5 for the HTTP/1.1 fallback + 4 #B562 deferral branches)');
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

    it('pure logic: dynamic :status uses res.statusCode', function() {
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


// 11 — Layout cache uses atomic temp+rename to avoid ENOENT under concurrent renders
//
// In dev mode (_cacheIsEnabled !== 'true'), two concurrent renders of the
// same template (via `{% extends "layout.html" %}`) used to race because the
// priming block deleted the cached layout file (rmSync) before rewriting it,
// opening a gap window where a parallel render could observe the file as
// absent at the readFile call ~340 lines below. Atomic temp+rename closes
// the gap — readers always see the previous content or the new content,
// never an absent file.
describe('11 - layout cache atomic temp+rename (race fix, 2026-05-11)', function() {

    it('priming block: no rmSync on newLayoutFilename (race surface removed)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        // Strip both line and block comments before checking — the leading
        // comment of the new block describes the old rmSync pattern.
        var stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/fs\.rmSync\(\s*newLayoutFilename/.test(stripped),
            'fs.rmSync(newLayoutFilename) was reintroduced — the race fix was reverted'
        );
    });

    it('priming block: writeFile target is a temp file, then rename onto newLayoutFilename', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /await\s+fs\.promises\.writeFile\(\s*_layoutTmp\s*,\s*buffer\s*\)/.test(src),
            'expected `await fs.promises.writeFile(_layoutTmp, buffer)` at the priming block'
        );
        assert.ok(
            /await\s+fs\.promises\.rename\(\s*_layoutTmp\s*,\s*newLayoutFilename\s*\)/.test(src),
            'expected `await fs.promises.rename(_layoutTmp, newLayoutFilename)` at the priming block'
        );
    });

    it('post-asset-injection write: writeFile target is a temp file, then rename onto newLayoutFilename', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /await\s+fs\.promises\.writeFile\(\s*_layoutTmpAssets\s*,\s*_persistedLayout\s*\)/.test(src),
            'expected `await fs.promises.writeFile(_layoutTmpAssets, _persistedLayout)` at the post-asset write (#SPA1 fragment composition)'
        );
        assert.ok(
            /await\s+fs\.promises\.rename\(\s*_layoutTmpAssets\s*,\s*newLayoutFilename\s*\)/.test(src),
            'expected `await fs.promises.rename(_layoutTmpAssets, newLayoutFilename)` at the post-asset write'
        );
    });

    it('temp file names embed process.pid, Date.now(), and Math.random() for collision-safety', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        // Two temp-file derivations are expected, both anchored on
        // newLayoutFilename + '.tmp.' — pin the pattern by counting matches
        // and asserting each carries pid/time/random.
        var matches = src.match(/newLayoutFilename\s*\+\s*'\.tmp\.'\s*\+\s*process\.pid\s*\+\s*'\.'\s*\+\s*Date\.now\(\)\s*\+\s*'\.'\s*\+\s*Math\.random\(\)/g);
        assert.ok(
            matches && matches.length >= 2,
            'expected two temp-file derivations (priming + post-asset) both embedding pid + Date.now() + Math.random()'
        );
    });

    it('CVE-2023-25345 boundary check preserved verbatim at the priming block', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            /\[CVE-2023-25345\] Path traversal attempt blocked in \{% extends %\}/.test(src),
            'CVE-2023-25345 throw guard must be preserved'
        );
        assert.ok(
            /nodePath\.resolve\(_layoutTemplateRoot,\s*layoutPath\)/.test(src),
            'CVE-2023-25345 boundary resolve must be preserved'
        );
        assert.ok(
            /!_layoutResolvedPath\.startsWith\(_layoutTemplateRoot \+ '\/'\)/.test(src),
            'CVE-2023-25345 startsWith guard must be preserved'
        );
    });

    // Behavior test: run the atomic-rename pattern under concurrent load and
    // verify 0 ENOENT failures. The harness extracts the pattern from the
    // source fix; the source pins above guarantee the source file uses this
    // pattern. Race tests are stochastic so we run several iterations; with
    // the atomic pattern, 0 failures is the deterministic outcome regardless
    // of timing.
    it('behavior: 0 ENOENT across 200 concurrent atomic writes (10 iter × 20)', { timeout: 60000 }, async function() {
        var os       = require('os');
        var nodePath = require('path');
        var ROOT     = nodePath.join(os.tmpdir(), 'gina-render-swig-race-' + process.pid + '-' + Date.now());
        var SRC      = nodePath.join(ROOT, 'source', 'layout.html');
        var TARGET   = nodePath.join(ROOT, 'cache',  'layout.html');
        var CONTENT  = '<!doctype html><html>{% block content %}{% endblock %}</html>\n';

        fs.mkdirSync(nodePath.dirname(SRC),    { recursive: true });
        fs.mkdirSync(nodePath.dirname(TARGET), { recursive: true });
        fs.writeFileSync(SRC, CONTENT);

        async function atomicWrite() {
            var buf = await fs.promises.readFile(SRC);
            var tmp = TARGET + '.tmp.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2);
            await fs.promises.writeFile(tmp, buf);
            await fs.promises.rename(tmp, TARGET);
        }

        // Approximates one render in dev mode: pre-block async work to
        // create natural stagger (the request-lifecycle awaits before the
        // racy block), the atomic write, ~340 lines of sync intervening
        // work, then the racy readFile.
        async function render() {
            for (var k = 0; k < 5; k++) await Promise.resolve();
            await atomicWrite();
            var sink = 0;
            for (var i = 0; i < 5000000; i++) sink += i;
            return await fs.promises.readFile(TARGET, 'utf8');
        }

        var ITER = 10;
        var N    = 20;
        var fails = [];

        try {
            for (var iter = 0; iter < ITER; iter++) {
                var promises = [];
                for (var i = 0; i < N; i++) {
                    promises.push(new Promise(function(resolve) {
                        setTimeout(function() {
                            render().then(
                                function() { resolve(null); },
                                function(err) { resolve({ code: err.code, message: err.message }); }
                            );
                        }, Math.floor(Math.random() * 30));
                    }));
                }
                var results = await Promise.all(promises);
                for (var r = 0; r < results.length; r++) {
                    if (results[r]) fails.push(results[r]);
                }
            }
        } finally {
            try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
        }

        assert.strictEqual(
            fails.length, 0,
            'expected 0 failures across ' + (ITER * N) + ' concurrent atomic writes — saw ' + fails.length + ' (codes: ' + JSON.stringify(fails.map(function(f) { return f.code; })) + ')'
        );
    });

});


// ─── 12 — Function-scoped captures of per-request refs (#M1 race fix) ────────
//
// The exported render() is async. Between awaits, the controller's `local`
// closure can have its `req` / `res` / `next` properties nulled by another
// code path — most commonly throwError's generic-error fallthrough that
// runs when a second throwError fires after renderCustomError already
// started this render. Pre-retrofit, render-swig.js read `local.req` /
// `local.res` / `local.next` directly throughout, so any post-await read
// after such a null-out crashed with `Cannot read properties of null
// (reading 'method')` at the first such site.
//
// The retrofit captures `local.req` / `local.res` / `local.next` into
// function-scoped `var req` / `var res` / `var _next` at the very top of
// render() (immediately after the deps unpack, before any await), then
// uses those captures for every post-deps read. The closure properties
// are still nulled at terminal exits for early per-request memory release.

describe('12 - function-scoped captures of per-request refs (#M1 race fix)', function() {

    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    // ── (a) source structure: captures at top of render() ───────────────

    it("render() body captures `var req = local.req` after the deps unpack", function() {
        var src = getSrc();
        var renderIdx = src.indexOf('module.exports = async function render');
        assert.ok(renderIdx > -1, 'render() exported declaration not found');
        // Window from render() declaration to the first `await` — this is the
        // synchronous prologue where the captures must live to be set before
        // any yield point that another path could exploit to null the closure.
        // Use the first CODE await (fs.promises is unambiguously code; the
        // word `await` also appears in the doc comment about "await boundaries"
        // which we must skip).
        var awaitIdx = src.indexOf('await fs.promises.', renderIdx);
        assert.ok(awaitIdx > -1, 'first await fs.promises in render() not found');
        var prologue = src.substring(renderIdx, awaitIdx);
        assert.ok(
            /var\s+req\s*=\s*local\.req\s*;/.test(prologue),
            'expected `var req = local.req;` capture before any await in render()'
        );
    });

    it("render() body captures `var res = local.res` after the deps unpack", function() {
        var src = getSrc();
        var renderIdx = src.indexOf('module.exports = async function render');
        var awaitIdx  = src.indexOf('await fs.promises.', renderIdx);
        var prologue  = src.substring(renderIdx, awaitIdx);
        assert.ok(
            /var\s+res\s*=\s*local\.res\s*;/.test(prologue),
            'expected `var res = local.res;` capture before any await in render()'
        );
    });

    it("render() body captures `var _next = local.next` after the deps unpack", function() {
        var src = getSrc();
        var renderIdx = src.indexOf('module.exports = async function render');
        var awaitIdx  = src.indexOf('await fs.promises.', renderIdx);
        var prologue  = src.substring(renderIdx, awaitIdx);
        assert.ok(
            /var\s+_next\s*=\s*local\.next\s*;/.test(prologue),
            'expected `var _next = local.next;` capture before any await in render()'
        );
    });

    it("captures come AFTER `local = deps.local;` so they read the populated closure", function() {
        var src = getSrc();
        var depsIdx    = src.indexOf('local           = deps.local;');
        var captureIdx = src.indexOf('var req         = local.req;');
        assert.ok(depsIdx > -1, '`local = deps.local;` deps assignment not found');
        assert.ok(captureIdx > -1, '`var req = local.req;` capture not found');
        assert.ok(
            captureIdx > depsIdx,
            'captures must come AFTER `local = deps.local;` so `local` is populated when read'
        );
    });

    // ── (a2) #INS10 race fix: self / local are ALSO function-scoped ──────
    //
    // Pre-fix render-swig.js assigned `self` / `local` at MODULE scope, so a
    // render suspended at an await could have them overwritten by a concurrent
    // render — and the post-await Inspector emit (#INS10 prod-window egress +
    // dev `inspector#data`) would then carry the OTHER request's _queryLog /
    // _timeline. They are now captured FUNCTION-scoped via `var`, matching the
    // req/res/_next captures above and render-nunjucks.js (which was already
    // function-scoped, hence race-clean).

    it("render() declares `self` function-scoped (`var self = deps.self`) — #INS10 race fix", function() {
        var src = getSrc();
        var renderIdx = src.indexOf('module.exports = async function render');
        var awaitIdx  = src.indexOf('await fs.promises.', renderIdx);
        var prologue  = src.substring(renderIdx, awaitIdx);
        assert.ok(
            /var\s+self\s*=\s*deps\.self\s*;/.test(prologue),
            'expected `var self = deps.self;` (function-scoped) in render() prologue'
        );
    });

    it("render() declares `local` function-scoped (`var local = deps.local`) — #INS10 race fix", function() {
        var src = getSrc();
        var renderIdx = src.indexOf('module.exports = async function render');
        var awaitIdx  = src.indexOf('await fs.promises.', renderIdx);
        var prologue  = src.substring(renderIdx, awaitIdx);
        assert.ok(
            /var\s+local\s*=\s*deps\.local\s*;/.test(prologue),
            'expected `var local = deps.local;` (function-scoped) in render() prologue'
        );
    });

    it("module scope no longer declares `self` / `local` as shared bindings (#INS10)", function() {
        var src = getSrc();
        var renderIdx = src.indexOf('module.exports = async function render');
        // Everything before render() — the module-scope prologue. Were self/local
        // still declared here as `= null` inherited-ref bindings, the function-
        // scoped `var` inside render() would merely SHADOW a live shared binding,
        // not remove the cross-request sharing.
        var head = src.substring(0, renderIdx);
        assert.ok(!/\bself\s+=\s*null\b/.test(head),  '`self = null` must not appear at module scope');
        assert.ok(!/\blocal\s+=\s*null\b/.test(head), '`local = null` must not appear at module scope');
    });

    // ── (b) source structure: writeCache signature takes req, res params ─

    it('writeCache signature includes `req, res, cacheIsEnabled, throwError` parameters', function() {
        var src = getSrc();
        assert.ok(
            /async\s+function\s+writeCache\s*\(\s*bundle\s*,\s*opt\s*,\s*htmlContent\s*,\s*req\s*,\s*res\s*,\s*cacheIsEnabled\s*,\s*throwError\s*\)/.test(src),
            'writeCache must take `bundle, opt, htmlContent, req, res, cacheIsEnabled, throwError` — everything render()-scoped is threaded as parameters (module scope has no render()-scoped bindings)'
        );
    });

    it('writeCache call sites pass `req, res` and the render-scoped flag + throwError', function() {
        var src = getSrc();
        var matches = src.match(/await\s+writeCache\([^)]*,\s*req\s*,\s*res\s*,\s*self\.serverInstance\._cacheIsEnabled\s*,\s*self\.throwError\s*\)/g);
        assert.ok(matches && matches.length >= 2, 'expected at least 2 `writeCache(..., req, res, self.serverInstance._cacheIsEnabled, self.throwError)` call sites (cache-write + post-asset-injection)');
    });

    // ── (c) source structure: terminal exits still null the CLOSURE ─────

    it("terminal exits null local.req / local.res / local.next on the closure (early memory release)", function() {
        var src = getSrc();
        // The block-style null trio must appear exactly 3 times — once per
        // terminal exit (cache-hit, cache-miss, fallthrough). Renaming
        // these to `req = null` etc. would be a regression (the function-
        // scoped captures are GC'd on return anyway; nulling the closure
        // releases the per-request payload earlier while the controller
        // instance may still be alive via pending event listeners).
        var matches = src.match(/local\.req\s*=\s*null\s*;\s*\n\s*local\.res\s*=\s*null\s*;\s*\n\s*local\.next\s*=\s*null\s*;/g);
        assert.ok(matches, 'no closure-nulling blocks found');
        assert.strictEqual(matches.length, 3, 'expected exactly 3 closure-nulling blocks (cache-hit + cache-miss + fallthrough)');
    });

    // ── (d) negative invariant: no post-deps `local.req` / `local.res`
    //     reads (apart from the captures and the terminal-exit nulling) ───

    it('no `local.req` reads remain outside the capture line and the terminal-exit nulling', function() {
        var src = getSrc();
        // Strip comments so commented-out historical code does not match.
        var stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        var allReads = stripped.match(/local\.req\b/g) || [];
        // Allowed: `var req = local.req;` (1×) + `local.req = null;` (3×) = 4
        assert.strictEqual(
            allReads.length, 4,
            'expected exactly 4 `local.req` references in active code (1 capture + 3 closure-nulls), found ' + allReads.length
        );
    });

    it('no `local.res` reads remain outside the capture line and the terminal-exit nulling', function() {
        var src = getSrc();
        var stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        var allReads = stripped.match(/local\.res\b/g) || [];
        assert.strictEqual(
            allReads.length, 5,
            'expected exactly 5 `local.res` references in active code (1 capture + 1 #B45 released-response guard + 3 closure-nulls), found ' + allReads.length
        );
    });

    it('no `local.next` reads remain outside the capture line and the terminal-exit nulling', function() {
        var src = getSrc();
        var stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        var allReads = stripped.match(/local\.next\b/g) || [];
        assert.strictEqual(
            allReads.length, 4,
            'expected exactly 4 `local.next` references in active code (1 capture + 3 closure-nulls), found ' + allReads.length
        );
    });

    // ── (e) pure-logic replica: race-safety property ────────────────────
    //
    // Simulates the exact race shape: a captured `req` reference must
    // continue to point at the original req object even after the closure
    // property is nulled. This is the property the retrofit relies on.

    it('captured `req` survives `local.req = null` (function-scoped vs closure-scoped)', function() {
        // Simulate the shape of the controller's per-request closure
        var local = { req: { method: 'POST', url: '/x' }, res: {}, next: function() {} };
        // Capture function-scoped refs (mirrors `var req = local.req;` in render())
        var req = local.req;
        var res = local.res;
        var _next = local.next;
        // External path nulls the closure properties (mirrors throwError's
        // generic-error fallthrough at controller.js:5342-5344).
        local.req = null;
        local.res = null;
        local.next = null;
        // Pre-retrofit: `local.req.method.toLowerCase()` would have thrown
        // "Cannot read properties of null (reading 'method')". Post-retrofit:
        // the captured `req` still references the original object.
        assert.equal(req.method, 'POST', 'captured req survives the closure null-out');
        assert.equal(req.url, '/x', 'captured req object is still the same reference');
        assert.notEqual(res, null, 'captured res survives the closure null-out');
        assert.equal(typeof _next, 'function', 'captured _next survives the closure null-out');
    });

    it('repro of the original crash: `local.req.method.toLowerCase()` after null-out throws TypeError', function() {
        // This is the EXACT pre-retrofit access at render-swig.js:467.
        // Locks the failure mode the retrofit eliminates: any post-await
        // read via `local.req.X` crashes when `local.req` was nulled.
        var local = { req: { method: 'GET' } };
        local.req = null;
        assert.throws(
            function() {
                /* eslint-disable no-unused-vars */
                var x = typeof(local.req[ local.req.method.toLowerCase() ]);
                /* eslint-enable no-unused-vars */
            },
            /Cannot read prop(erty|erties).+null.+(reading\s+'method'|of\s+null)/,
            'pre-retrofit access pattern must throw TypeError on null local.req'
        );
    });

    it('post-retrofit: the same access via the captured `req` does NOT throw', function() {
        var local = { req: { method: 'GET', get: { debug: 'true' } } };
        var req = local.req;
        // External null-out (the race window — `req` capture is unaffected).
        local.req = null;
        // Mirrors line 467's cacheless-debug detection (the canonical crash site).
        var value = typeof(req[ req.method.toLowerCase() ]);
        assert.equal(value, 'object', 'captured `req[method]` returns the per-method bucket — no TypeError on null');
    });

});


// 13 — HTTP/2 response trailers (#H10)
describe('13 - HTTP/2 response trailers (#H10)', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    it('captures _trailers from local._trailers', function() {
        assert.ok(/var _trailers\s*=.*local\._trailers/.test(src()), 'expected _trailers capture from local._trailers');
    });

    it('wires waitForTrailers + wantTrailers + sendTrailers (#H10 marker present)', function() {
        var s = src();
        assert.ok(s.indexOf('#H10') > -1, 'expected #H10 marker');
        assert.ok(s.indexOf('waitForTrailers') > -1, 'expected waitForTrailers');
        assert.ok(s.indexOf("'wantTrailers'") > -1, 'expected wantTrailers listener');
        assert.ok(s.indexOf('sendTrailers') > -1, 'expected sendTrailers call');
    });

    it('wires trailers on BOTH body paths (cache-hit + cache-miss), each gated on if (_trailers)', function() {
        var s = src();
        assert.ok(/stream\.respond\(_streamHeaders,\s*_trailers\s*\?/.test(s),  'expected conditional respond on the cache-hit body path');
        assert.ok(/stream\.respond\(_streamHeaders2,\s*_trailers\s*\?/.test(s), 'expected conditional respond on the cache-miss body path');
        var ifMatches = s.match(/if\s*\(\s*_trailers\s*\)/g) || [];
        assert.ok(ifMatches.length >= 2, 'expected an `if (_trailers)` gate on each body path');
    });

    it('does not add extra stream.respond() calls — single-conditional-arg form keeps the 5-path count (section 10)', function() {
        // The trailer wiring uses stream.respond(headers, _trailers ? {...} : undefined),
        // so each path still has exactly one respond() call; section 10 pins the total at 5.
        var stripped = src().replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        var matches = stripped.match(/stream\.respond\(/g) || [];
        assert.strictEqual(matches.length, 5, 'expected 5 stream.respond() calls — trailers must not add respond calls');
    });
});


// 14 — CSP nonce on framework-injected inline scripts (#HDR5)
describe('14 - CSP nonce: onGinaLoaded bootstrap carries req._ginaCspNonce', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    it('captures _cspNonce from req._ginaCspNonce', function() {
        assert.ok(
            /var _cspNonce\s*=\s*\(req && req\._ginaCspNonce\)\s*\?\s*req\._ginaCspNonce\s*:\s*null/.test(src()),
            'expected _cspNonce captured from req._ginaCspNonce'
        );
    });

    it('defines the _nonceLoader helper that stamps the bootstrap <script> (#HDR5/#B130)', function() {
        var s = src();
        assert.ok(/var _nonceLoader\s*=\s*function/.test(s), 'expected the _nonceLoader helper');
        assert.ok(s.indexOf('#HDR5') > -1, 'expected #HDR5 marker');
        // #B130 — the injection is the RENDER-TIME swig conditional (re-evaluated per
        // compiledTemplate(data) execute), never a literal value that would freeze in
        // the per-view compiled-template cache + the persisted layout-cache file.
        assert.ok(
            s.indexOf('\'<script type="text/javascript"{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}>\'') > -1,
            'expected the render-time swig-conditional nonce injected into the bootstrap script tag'
        );
    });

    it('routes every ginaLoader injection site through _nonceLoader()', function() {
        var s = src();
        var direct  = s.match(/localOptions\.template\.ginaLoader/g) || [];
        var wrapped = s.match(/_nonceLoader\(localOptions\.template\.ginaLoader\)/g) || [];
        assert.ok(wrapped.length >= 3, 'expected all 3 ginaLoader injection sites wrapped in _nonceLoader()');
        assert.strictEqual(direct.length, wrapped.length,
            'every localOptions.template.ginaLoader occurrence should be inside a _nonceLoader() call');
    });

    // pure-logic replica of the _nonceLoader transform (#B130 conditional form)
    var NONCE_TPL = '{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}';
    function nonceLoader(loaderTag, cspNonce) {
        if (cspNonce && typeof loaderTag === 'string') {
            return loaderTag.replace(
                '<script type="text/javascript">',
                '<script type="text/javascript"' + NONCE_TPL + '>'
            );
        }
        return loaderTag;
    }

    var LOADER = '\n\t\t<script type="text/javascript">\n\t\t<!--\n\t\tvar x=1;\n\t\t//-->\n\t\t</script>';

    it('replica: injects the swig conditional — never the literal value (#B130)', function() {
        var out = nonceLoader(LOADER, 'ABC+/=');
        assert.ok(out.indexOf('<script type="text/javascript"' + NONCE_TPL + '>') > -1,
            'the conditional should land in the opening tag');
        assert.strictEqual(out.indexOf('ABC+/='), -1,
            'the request nonce VALUE must not be baked into the compile-time output');
        assert.strictEqual(out.indexOf('<script type="text/javascript">'), -1,
            'the bare opening tag should be rewritten');
    });

    it('replica: returns the loader unchanged when no nonce (back-compat)', function() {
        assert.strictEqual(nonceLoader(LOADER, null), LOADER);
        assert.strictEqual(nonceLoader(LOADER, undefined), LOADER);
    });

    it('replica: only the opening tag is rewritten (closing </script> untouched)', function() {
        var out = nonceLoader(LOADER, 'XYZ');
        assert.ok(out.indexOf('</script>') > -1, 'closing tag preserved');
        assert.strictEqual((out.match(/<script/g) || []).length, 1, 'exactly one <script opening');
    });

});


// 15 — CSP nonce on the dev-only Inspector + metrics-patch inline scripts (#HDR16)
describe('15 - CSP nonce: dev-only Inspector + patch inline scripts', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    it('derives _cspNonceAttr from the captured _cspNonce', function() {
        assert.ok(
            /var _cspNonceAttr\s*=\s*_cspNonce\s*\?\s*\(\s*' nonce="'\s*\+\s*_cspNonce\s*\+\s*'"'\s*\)\s*:\s*''/.test(src()),
            'expected _cspNonceAttr derived from _cspNonce'
        );
    });

    it('splits the attr forms by injection time (#B130): post-execute literal, compile-baked template', function() {
        var s = src();
        var literal = (s.match(/'<script' \+ _cspNonceAttr \+ '>/g) || []);
        var tpl     = (s.match(/'<script' \+ _cspNonceTplAttr \+ '>/g) || []);
        // _cachePatchScript + _patchScript splice into htmlContent AFTER
        // compiledTemplate(data) ran, and since #B464 so does the Inspector
        // data script (buildInspectorDataScript, module bottom) — the
        // per-request literal is correct at all three.
        assert.strictEqual(literal.length, 3,
            'expected exactly 3 post-execute dev-script openings on _cspNonceAttr (got ' + literal.length + ')');
        // __logsScript is the one script still baked into the swig-compiled
        // layout (the cached compiled template) — it takes the render-time
        // template form. The data script left the template with #B464: baked
        // in, it froze request 1's page data into every later execute.
        assert.strictEqual(tpl.length, 1,
            'expected exactly 1 compile-baked dev-script opening on _cspNonceTplAttr (got ' + tpl.length + ')');
    });

    it('leaves no bare framework-assembled <script> opening assignment', function() {
        var s = src();
        assert.ok(!/=\s*'<script>'/.test(s),          'no bare <script> assignment should remain');
        assert.ok(!/=\s*'<script>\(function/.test(s), 'no bare <script>(function assignment should remain');
        assert.ok(!/=\s*'<script>window/.test(s),     'no bare <script>window assignment should remain');
    });

    // pure-logic replica of the _cspNonceAttr fragment
    function nonceAttr(nonce) { return nonce ? (' nonce="' + nonce + '"') : ''; }

    it('replica: emits a nonce attribute when a nonce is present (base64 chars)', function() {
        assert.strictEqual(nonceAttr('AbC+/=='), ' nonce="AbC+/=="');
        assert.strictEqual('<script' + nonceAttr('AbC+/==') + '>', '<script nonce="AbC+/==">');
    });

    it('replica: emits nothing (back-compat bare tag) when no nonce', function() {
        assert.strictEqual(nonceAttr(null), '');
        assert.strictEqual('<script' + nonceAttr(null) + '>', '<script>');
        assert.strictEqual('<script' + nonceAttr(undefined) + '>', '<script>');
    });

});


// 16 — CSP nonce app-template helper: data.page.cspNonce + statusbar.html (#HDR16 follow-up)
describe('16 - CSP nonce: page.cspNonce template var + statusbar include', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    var FW             = require('../fw');
    var STATUSBAR_SRC  = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/html/statusbar.html');
    var STATUSBAR_DIST = path.join(FW, 'core/asset/plugin/dist/vendor/gina/html/statusbar.html');

    // ── data.page.cspNonce wiring (the application-template nonce helper) ──

    it('exposes the nonce on data.page.cspNonce, guarded so the key is absent when no nonce', function() {
        assert.ok(
            /if \(_cspNonce\) \{ data\.page\.cspNonce = _cspNonce; \}/.test(src()),
            'expected `if (_cspNonce) { data.page.cspNonce = _cspNonce; }` guard'
        );
    });

    it('sets data.page.cspNonce before BOTH compiledTemplate(data) sites (cache-hit + cache-miss)', function() {
        var s = src();
        var assigns = (s.match(/data\.page\.cspNonce = _cspNonce/g) || []);
        assert.strictEqual(assigns.length, 2,
            'expected exactly 2 data.page.cspNonce assignments — one before each compiledTemplate(data) call');
        // each assignment must immediately precede a compiledTemplate(data) call
        var paired = (s.match(/data\.page\.cspNonce = _cspNonce;[\s\S]{0,200}?htmlContent = compiledTemplate\(data\);/g) || []);
        assert.strictEqual(paired.length, 2,
            'expected both data.page.cspNonce assignments immediately before a compiledTemplate(data) call');
    });

    // ── statusbar.html — dev-only swig include carries the nonce attribute ──

    var NONCE_COND = '<script{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}>';

    it('dist statusbar.html OPENS with the page.cspNonce conditional (runtime include artifact)', function() {
        var dist = fs.readFileSync(STATUSBAR_DIST, 'utf8');
        assert.strictEqual(dist.indexOf(NONCE_COND), 0,
            'expected dist statusbar.html to open with the page.cspNonce conditional <script> tag');
    });

    it('src statusbar.html carries the same conditional', function() {
        var srcSb = fs.readFileSync(STATUSBAR_SRC, 'utf8');
        assert.strictEqual(srcSb.indexOf(NONCE_COND), 0,
            'expected src statusbar.html to open with the page.cspNonce conditional <script> tag');
    });

    it('src and dist statusbar.html are byte-identical (dist is a plain copy, not in build.json)', function() {
        var srcSb = fs.readFileSync(STATUSBAR_SRC, 'utf8');
        var dist  = fs.readFileSync(STATUSBAR_DIST, 'utf8');
        assert.strictEqual(srcSb, dist, 'src and dist statusbar.html must stay byte-identical');
    });

    it('statusbar.html JS body has no swig delimiters beyond the line-1 conditional (no collision)', function() {
        var dist = fs.readFileSync(STATUSBAR_DIST, 'utf8');
        // The only swig constructs are on line 1 ({% if %}, {{ }}, {% endif %});
        // the JS body must contain none or swig would try to interpret it.
        var body = dist.slice(dist.indexOf('\n'));
        assert.ok(!/\{\{|\}\}|\{%|%\}|\{#|#\}/.test(body),
            'statusbar.html JS body must contain no swig delimiters (template-processing collision)');
    });

    // ── pure-logic replica of the guarded page.cspNonce assignment ──

    function applyPageNonce(page, nonce) {
        if (nonce) { page.cspNonce = nonce; }
        return page;
    }

    it('replica: sets page.cspNonce when a nonce is present', function() {
        assert.strictEqual(applyPageNonce({}, 'AbC+/==').cspNonce, 'AbC+/==');
    });

    it('replica: leaves the key ABSENT when no nonce (back-compat for non-useNonce bundles)', function() {
        assert.ok(!('cspNonce' in applyPageNonce({}, null)),      'absent when null');
        assert.ok(!('cspNonce' in applyPageNonce({}, undefined)), 'absent when undefined');
    });

});


// 17 — browser-session cookie: a null _expires must be SKIPPED, not .format()-ed (HTTP 500 fix)
// A session with no expiry (express-session `cookie.expires` unset) presents
// `req.session.cookie._expires === null` after one store round-trip (the store
// serialises to JSON, dropping the key; express-session's Cookie constructor
// then rebuilds it with a null `_expires`). `typeof null === 'object'`, so the
// old `!= 'undefined'` guard passed, `dateEnd` became null, and
// `null.format('isoDateTime')` threw — HTTP 500 for every request on that
// session. The guard is now `instanceof Date` (the block also subtracts dates
// and calls `.format`, both of which require a real Date). render-v1.js (the
// legacy delegate) carries the byte-identical fix.
describe('17 - browser-session cookie: null _expires skipped, not .format()-ed (HTTP 500 fix)', function() {

    var SOURCE_V1 = path.join(require('../fw'), 'core/controller/controller.render-v1.js');

    // Comment-strip so the explanatory comments above each guard (which mention
    // the historical `!= 'undefined'` wording) cannot satisfy the source pins.
    function strip(s) { return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); }
    function swigCode() { return strip(fs.readFileSync(SOURCE, 'utf8')); }
    function v1Code()   { return strip(fs.readFileSync(SOURCE_V1, 'utf8')); }

    // ── (a) source pins: the FIXED guard is in place, the OLD buggy guard is gone ──

    it('render-swig.js gates the expiry block on `_expires instanceof Date`', function() {
        assert.ok(
            /req\.session\.cookie\._expires\s+instanceof\s+Date/.test(swigCode()),
            'expected `req.session.cookie._expires instanceof Date` guard in render-swig.js'
        );
    });

    it("render-swig.js no longer uses the `typeof(... _expires) != 'undefined'` guard (null passes it)", function() {
        assert.ok(
            !/typeof\(\s*req\.session\.cookie\._expires\s*\)\s*!=\s*'undefined'/.test(swigCode()),
            "the buggy `typeof(req.session.cookie._expires) != 'undefined'` guard must be gone"
        );
    });

    it("render-swig.js still calls .format('isoDateTime') INSIDE the Date-gated block (happy path intact)", function() {
        assert.ok(
            /req\.session\.cookie\._expires\s+instanceof\s+Date[\s\S]{0,1000}?\.format\('isoDateTime'\)/.test(swigCode()),
            "expected .format('isoDateTime') to remain inside the instanceof-Date-gated block"
        );
    });

    it('render-v1.js (legacy delegate) carries the identical instanceof-Date fix', function() {
        var s = v1Code();
        assert.ok(
            /local\.req\.session\.cookie\._expires\s+instanceof\s+Date/.test(s),
            'expected `local.req.session.cookie._expires instanceof Date` guard in render-v1.js'
        );
        assert.ok(
            !/typeof\(\s*local\.req\.session\.cookie\._expires\s*\)\s*!=\s*'undefined'/.test(s),
            'the buggy typeof guard must be gone from render-v1.js too'
        );
    });

    // ── (b) pure-logic replica of the session-expiry-display block ──
    // The guard is injected so the SAME body can be exercised under the FIXED
    // guard and the OLD buggy guard (the subtract check in (c)). The source pins
    // in (a) lock that the shipped delegates use the `instanceof Date` form, so
    // this replica cannot silently drift from the real code.
    function runSessionExpiryBlock(reqSession, dataPage, guard) {
        if ( typeof(reqSession) != 'undefined' ) {
            if ( typeof(dataPage.data) == 'undefined' ) {
                dataPage.data = {};
            }
            if ( guard(reqSession) ) {
                var dateEnd = reqSession.cookie._expires;
                var dateStart = ( typeof(reqSession.lastModified) != 'undefined' )
                                ? new Date(reqSession.lastModified)
                                : new Date();
                var elapsed = dateEnd - dateStart;
                if ( typeof(dataPage.data.session) == 'undefined' ) {
                    dataPage.data.session = {
                        id          : reqSession.id,
                        lastModified: reqSession.lastModified
                    };
                }
                dataPage.data.session.createdAt = reqSession.createdAt;
                dataPage.data.session.expiresAt = dateEnd.format('isoDateTime');
                dataPage.data.session.timeout   = elapsed;
            }
        }
        return dataPage;
    }

    var FIXED_GUARD = function(s) { return s.cookie._expires instanceof Date; };
    var OLD_GUARD   = function(s) { return typeof(s.cookie._expires) != 'undefined'; };

    function makeSession(expires) {
        return {
            id          : 'sess-abc',
            createdAt   : '2026-05-28T00:00:00.000Z',
            lastModified: '2026-05-28T00:00:00.000Z',
            cookie      : { _expires: expires }
        };
    }

    // A real Date (so `instanceof Date` holds) carrying a `.format` stub. The stub
    // keeps this unit isolated from the dateFormat Date.prototype augmentation
    // while still proving the block invokes `.format('isoDateTime')`.
    function realExpiry() {
        var d = new Date('2026-05-28T00:30:00.000Z'); // +30 min after lastModified
        d.format = function(fmt) { return 'FMT(' + fmt + ')'; };
        return d;
    }

    it('FIXED guard: null _expires (browser-session cookie) does NOT throw and leaves session absent', function() {
        var page;
        assert.doesNotThrow(function() {
            page = runSessionExpiryBlock(makeSession(null), {}, FIXED_GUARD);
        });
        assert.strictEqual(page.data.session, undefined, 'no expiry → page.data.session must stay absent');
    });

    it('FIXED guard: undefined _expires also skips cleanly (session absent, no throw)', function() {
        var page;
        assert.doesNotThrow(function() {
            page = runSessionExpiryBlock(makeSession(undefined), {}, FIXED_GUARD);
        });
        assert.strictEqual(page.data.session, undefined, 'undefined expiry → page.data.session must stay absent');
    });

    it('FIXED guard: a real Date expiry STILL produces a formatted expiresAt + numeric timeout (happy path)', function() {
        var page = runSessionExpiryBlock(makeSession(realExpiry()), {}, FIXED_GUARD);
        assert.ok(page.data.session, 'real expiry → page.data.session must be present');
        assert.strictEqual(page.data.session.expiresAt, 'FMT(isoDateTime)', 'expiresAt must be the formatted value');
        assert.strictEqual(page.data.session.timeout, 30 * 60 * 1000, 'timeout = dateEnd - dateStart (30 min)');
        assert.strictEqual(page.data.session.id, 'sess-abc', 'session id still carried through on the happy path');
    });

    // ── (c) subtract check: the OLD guard is what caused the crash ──

    it('SUBTRACT: the OLD `!= undefined` guard THROWS on a null _expires (proves the guard is the fix)', function() {
        assert.throws(
            function() { runSessionExpiryBlock(makeSession(null), {}, OLD_GUARD); },
            /Cannot read propert(y|ies) of null|null is not an object|\.format/,
            'old guard let null reach null.format() — must throw (this is the bug being fixed)'
        );
    });

    it('SUBTRACT: the OLD guard was fine for a real Date (only null/object slipped past it)', function() {
        var page = runSessionExpiryBlock(makeSession(realExpiry()), {}, OLD_GUARD);
        assert.strictEqual(page.data.session.expiresAt, 'FMT(isoDateTime)');
    });

});


// Layoutless renders: userData exposed at top level AND under page.data (nunjucks parity)
describe('layoutless renders — isWithoutLayout branch exposes userData at top level AND under page.data', function() {

    var src = function() { return fs.readFileSync(SOURCE, 'utf8'); };

    it('has an `isWithoutLayout` branch in the userData-merge chain', function() {
        var s = src();
        // Branch sits between the `!userData` initialiser and the existing `userData && !userData["page"]` gate
        assert.ok(
            /if\s*\(!userData\)\s*\{[\s\S]{0,200}\}\s*else if\s*\(\s*isWithoutLayout\s*\)/.test(s),
            'expected `else if ( isWithoutLayout )` immediately after the `!userData` initialiser — layoutless top-level scope branch was reverted'
        );
    });

    it('layoutless branch exposes userData both at top level AND under page.data (nunjucks parity)', function() {
        var s = src();
        // Within the isWithoutLayout branch userData must reach the template two ways:
        //   (1) top level via `data = ... merge(userData, data) ...` (bare `{{ var }}`), and
        //   (2) under page.data via a per-key copy BEFORE that merge (`{% set data = page.data %}`
        //       / data.X consumers — the layoutless contract popins rely on).
        var branchMatch = s.match(/else if\s*\(\s*isWithoutLayout\s*\)\s*\{([\s\S]*?)\}\s*else if/);
        assert.ok(branchMatch, 'could not locate `else if ( isWithoutLayout )` branch body');
        var body = branchMatch[1];
        assert.ok(
            /data\s*=\s*\(isRenderingCustomError\)\s*\?\s*userData\s*:\s*merge\(\s*userData,\s*data\s*\)/.test(body),
            'expected layoutless branch to assign `data = (isRenderingCustomError) ? userData : merge(userData, data)` — top-level merge missing'
        );
        assert.ok(
            /data\['page'\]\['data'\]\[\s*_udk\s*\]\s*=\s*userData\[\s*_udk\s*\]/.test(body),
            'expected layoutless branch to copy userData keys into data.page.data (per-key) for data.X / page.data.X consumers'
        );
        // The page.data stash must precede the top-level merge — afterwards `data === userData`
        // and a page.data write would alias `data` (circular ref → JSON.stringify throw).
        var stashIdx = body.indexOf("data['page']['data'][_udk]");
        var mergeIdx = body.search(/data\s*=\s*\(isRenderingCustomError\)\s*\?\s*userData\s*:\s*merge\(\s*userData,\s*data\s*\)/);
        assert.ok(
            stashIdx > -1 && mergeIdx > -1 && stashIdx < mergeIdx,
            'page.data stash must run BEFORE the top-level merge to avoid a circular reference'
        );
    });

    it('full-page branch (userData has no `page` key) keeps the data.page.data nesting', function() {
        var s = src();
        // Zero-change-for-full-pages invariant: the original branch must still exist with its original shape.
        assert.ok(
            /else if\s*\(\s*userData\s*&&\s*!userData\['page'\]\s*\)\s*\{[\s\S]*?data\['page'\]\['data'\]\s*=/.test(s),
            'full-page branch (`userData && !userData["page"]`) must still bury userData under data.page.data — invariant violated'
        );
    });

});


// Layoutless render context — behavioural replica (real merge): top-level + page.data, no circular ref
describe('layoutless userData merge — top-level + page.data, JSON-serializable (real merge)', function() {

    var merge = require(path.join(require('../fw'), 'lib/merge'));

    // Pure-logic replica of the render-swig isWithoutLayout branch: the page.data
    // stash + the top-level merge + the framework-data restore (render-swig.js:610),
    // exercising the REAL framework deep-merge.
    function applyLayoutlessMerge(userData, getData) {
        var data = getData();
        if ( userData && !userData['page'] ) {
            if ( typeof(data['page']) == 'undefined' ) { data['page'] = {}; }
            if ( typeof(data['page']['data']) == 'undefined' ) { data['page']['data'] = {}; }
            for ( var _udk in userData ) {
                if ( Object.prototype.hasOwnProperty.call(userData, _udk) ) {
                    data['page']['data'][_udk] = userData[_udk];
                }
            }
        }
        data = merge(userData, data);
        data = merge(data, getData()); // framework page.* restore (render-swig.js:610)
        return data;
    }

    function freshFrameworkData() {
        return { page: {
            environment: { webroot: '/', hostname: 'h', version: '0.4.2' },
            view: { file: 'fragment' },
            data: { session: { id: 'sid' } }
        } };
    }

    it('promotes flat userData to top level AND stashes it under page.data', function() {
        var out = applyLayoutlessMerge({ note: 'hello', total: 42 }, freshFrameworkData);
        assert.strictEqual(out.note, 'hello', 'flat userData promoted to top-level ({{ note }} resolves)');
        assert.strictEqual(out.total, 42);
        assert.strictEqual(out.page.data.note, 'hello', 'flat userData also stashed under page.data (data.note / page.data.note)');
        assert.strictEqual(out.page.data.total, 42);
    });

    it('keeps framework page.data.session across the layoutless merge', function() {
        var out = applyLayoutlessMerge({ note: 'hello' }, freshFrameworkData);
        assert.ok(out.page.data.session && out.page.data.session.id === 'sid', 'framework page.data.session must survive');
    });

    it('render context is JSON-serializable — stash-before-merge avoids a circular ref', function() {
        var out = applyLayoutlessMerge({ note: 'hello', n: 1 }, freshFrameworkData);
        assert.doesNotThrow(function() { JSON.stringify(out.page.data); }, 'JSON.stringify(page.data) must not throw (layoutless XHR-data serialization)');
        assert.doesNotThrow(function() { JSON.stringify(out); }, 'JSON.stringify(renderContext) must not throw');
    });

    it('SUBTRACT: stashing AFTER the top-level merge creates a circular ref (proves the ordering is load-bearing)', function() {
        function stashAfter(userData, getData) {
            var data = getData();
            data = merge(userData, data);                                  // now data === userData
            data['page']['data'] = merge(userData, data['page']['data']);  // aliases data → cycle
            return data;
        }
        var out = stashAfter({ note: 'hello' }, freshFrameworkData);
        assert.throws(function() { JSON.stringify(out.page.data); }, /circular/i, 'stashing after the merge must create a circular structure');
    });

});


// #27 — self.setTemplate() override reader (render-swig path resolution)
describe('setTemplate override — render-swig honours _templateOverride with no namespace prefix (#27)', function() {

    var src = function() { return fs.readFileSync(SOURCE, 'utf8'); };

    it('has a _templateOverride branch ahead of the namespace branch', function() {
        var s = src();
        assert.ok(
            /if\s*\(\s*!isRenderingCustomError\s*&&\s*localOptions\._templateOverride[\s\S]*?\}\s*else if\s*\(\s*typeof\(localOptions\.namespace\)/.test(s),
            'expected `if ( !isRenderingCustomError && localOptions._templateOverride... )` immediately before the namespace `else if` — setTemplate swig reader missing'
        );
    });

    it('builds the override path with NO namespace prefix', function() {
        var s = src();
        var m = s.match(/localOptions\._templateOverride\.file\s*\)\s*\{([\s\S]*?)\}\s*else if/);
        assert.ok(m, 'override branch body not found');
        var body = m[1];
        assert.ok(
            /path\s*=\s*_\(\s*localOptions\.template\.html\s*\+\s*'\/'\s*\+\s*file\s*\)/.test(body),
            'override path must be _(localOptions.template.html + "/" + file) — no namespace segment'
        );
        assert.ok(
            !/localOptions\.namespace/.test(body),
            'override branch must NOT reference localOptions.namespace'
        );
    });

    // Pure-logic replica of the render-swig path-resolution branch order
    // (override -> namespace -> plain), mirroring controller.render-swig.js.
    function resolvePath(opts) {
        var localOptions = opts.localOptions;
        var data = opts.data;
        var isRenderingCustomError = !!opts.isRenderingCustomError;
        var file = (isRenderingCustomError) ? localOptions.file : data.page.view.file;
        var path;
        if ( !isRenderingCustomError && localOptions._templateOverride && typeof(localOptions._templateOverride.file) === 'string' && localOptions._templateOverride.file ) {
            file = data.page.view.file = localOptions._templateOverride.file;
            if ( typeof(localOptions._templateOverride.ext) === 'string' && localOptions._templateOverride.ext ) {
                data.page.view.ext = localOptions._templateOverride.ext;
            }
            path = localOptions.template.html + '/' + file;
        } else if ( typeof(localOptions.namespace) !== 'undefined' && localOptions.namespace ) {
            path = (isRenderingCustomError) ? file : (localOptions.template.html + '/' + localOptions.namespace + '/' + file);
        } else {
            path = (isRenderingCustomError) ? file : (localOptions.template.html + '/' + file);
        }
        if ( data.page.view.ext && !file.endsWith(data.page.view.ext) ) {
            path += data.page.view.ext;
        }
        return path;
    }

    it('override bypasses the namespace directory (errors/404 -> <root>/errors/404)', function() {
        var path = resolvePath({
            localOptions: { template: { html: '/t' }, namespace: 'content', _templateOverride: { file: 'errors/404' } },
            data: { page: { view: { file: 'home', ext: '.html' } } }
        });
        assert.strictEqual(path, '/t/errors/404.html');
    });

    it('without an override, the namespace prefix is still applied', function() {
        var path = resolvePath({
            localOptions: { template: { html: '/t' }, namespace: 'content', _templateOverride: undefined },
            data: { page: { view: { file: 'list', ext: '.html' } } }
        });
        assert.strictEqual(path, '/t/content/list.html');
    });

    it('override honours an explicit ext and avoids a double extension', function() {
        var path = resolvePath({
            localOptions: { template: { html: '/t' }, namespace: 'content', _templateOverride: { file: 'mail/welcome', ext: '.njk' } },
            data: { page: { view: { file: 'home', ext: '.html' } } }
        });
        assert.strictEqual(path, '/t/mail/welcome.njk');
    });

    it('override is ignored during custom-error rendering (no override path leakage)', function() {
        var path = resolvePath({
            isRenderingCustomError: true,
            localOptions: { template: { html: '/t' }, file: 'errors/500', namespace: 'content', _templateOverride: { file: 'hijack/attempt' } },
            data: { page: { view: { file: 'home', ext: '.html' } } }
        });
        assert.strictEqual(path.indexOf('hijack/attempt'), -1, 'custom-error render must not use the setTemplate override');
    });

});


// 18 — $-safe </body> splice: dev-Inspector script injection must not expand
//      String.replace dollar-patterns (prematch / postmatch / match) and nest the
//      page document into the statusbar <script>. Root cause of the disappearing
//      "Inspector" launch link on content-heavy pages: #TPL2 inlined the statusbar
//      body (which legitimately carries a dollar-backtick + dollar-quote) into a
//      STRING replacement, so String.prototype.replace expanded the prematch —
//      splicing the whole document before </body> INTO the statusbar script
//      (SyntaxError, so the statusbar IIFE never ran and the link never rendered).
describe('18 - $-safe </body> splice for dev-Inspector script injection', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    // ── source pins: the three dev-Inspector </body> splices use FUNCTION replacers ──
    it('statusbar splice uses a function replacer, not a string replacement', function() {
        var s = src();
        assert.ok(
            /layout\.replace\(\/<\\\/body>\/i,\s*function\s*\(\)\s*\{\s*return\s+plugin\s*\+/.test(s),
            'expected the statusbar plugin splice to use a function replacer'
        );
        assert.ok(
            !/layout\.replace\(\/<\\\/body>\/i,\s*plugin\s*\+/.test(s),
            'the vulnerable string form replace(/<\\/body>/i, plugin + ...) must be gone'
        );
    });

    it('cache-hit flow-patch splice uses a function replacer', function() {
        var s = src();
        assert.ok(
            /htmlContent\.replace\(\/<\\\/body>\/i,\s*function\s*\(\)\s*\{\s*return\s+_cachePatchScript\s*\+/.test(s),
            'expected the cache-hit patch splice to use a function replacer'
        );
        assert.ok(
            !/htmlContent\.replace\(\/<\\\/body>\/i,\s*_cachePatchScript\s*\+/.test(s),
            'the vulnerable string form must be gone (cache-hit patch)'
        );
    });

    it('cache-miss flow-patch splice uses a function replacer', function() {
        var s = src();
        assert.ok(
            /htmlContent\.replace\(\/<\\\/body>\/i,\s*function\s*\(\)\s*\{\s*return\s+_patchScript\s*\+/.test(s),
            'expected the cache-miss patch splice to use a function replacer'
        );
        assert.ok(
            !/htmlContent\.replace\(\/<\\\/body>\/i,\s*_patchScript\s*\+/.test(s),
            'the vulnerable string form must be gone (cache-miss patch)'
        );
    });

    // ── pure-logic behavioral replica: prove the function replacer is $-safe ──
    // The trigger bytes are built by concatenation so this test's own source is
    // unambiguous (and is never itself a String.replace replacement).
    var DOLLAR_BACKTICK = '$' + '`';
    var DOLLAR_QUOTE    = '$' + "'";

    function spliceUnsafe(doc, inject) {                              // the OLD, vulnerable form
        return doc.replace(/<\/body>/i, inject + '</body>');
    }
    function spliceSafe(doc, inject) {                               // the fix
        return doc.replace(/<\/body>/i, function () { return inject + '</body>'; });
    }

    var DOC    = '<!DOCTYPE html><html><head></head><body class="x"><div>PAGEBODY</div></body></html>';
    var SCRIPT = '<script>/* ' + DOLLAR_BACKTICK + ' and ' + DOLLAR_QUOTE + ' */var x=1;</script>';

    it('replica: the old string form nests the document (reproduces the bug)', function() {
        var out = spliceUnsafe(DOC, SCRIPT);
        assert.ok((out.match(/PAGEBODY/g) || []).length > 1,
            'a string replacement must duplicate the page body via the prematch pattern (bug repro)');
        assert.ok((out.match(/<!DOCTYPE html>/g) || []).length > 1,
            'a string replacement must duplicate the document');
    });

    it('replica: the function-replacer form inserts the script verbatim (the fix)', function() {
        var out = spliceSafe(DOC, SCRIPT);
        assert.strictEqual((out.match(/PAGEBODY/g) || []).length, 1,
            'no page-body duplication with a function replacer');
        assert.strictEqual((out.match(/<!DOCTYPE html>/g) || []).length, 1,
            'exactly one document with a function replacer');
        assert.ok(out.indexOf(DOLLAR_BACKTICK) > -1 && out.indexOf(DOLLAR_QUOTE) > -1,
            'the dollar-backtick and dollar-quote survive verbatim in the injected script');
    });

    // ── the trigger is real: the shipped dev statusbar body carries a $-sequence ──
    it('the dev statusbar template actually contains a $-special sequence (real trigger)', function() {
        var STATUSBAR_DIST = path.join(require('../fw'), 'core/asset/plugin/dist/vendor/gina/html/statusbar.html');
        var body = fs.readFileSync(STATUSBAR_DIST, 'utf8');
        assert.ok(
            body.indexOf(DOLLAR_BACKTICK) > -1 || body.indexOf(DOLLAR_QUOTE) > -1,
            'statusbar body should carry a dollar-backtick or dollar-quote — the real trigger this splice fix neutralizes'
        );
    });

});


describe('19 - released-response guard (#B45)', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    // render() captures req/res/next (#M1) then reads `res.stream` (~:259, the first res
    // deref) with no released-response guard. The exported render is async, so when a
    // controller fires several parallel self.query() calls against a downed upstream — the
    // first failure callback renders a degraded response and releases the triplet, then a
    // later callback re-enters render() here with local.res === null — `res.stream` threw
    // `reading 'stream'` → an unhandled promise rejection (and setResources' local.req.headers
    // read crashed the same way, caught by the #B31 throwError guard). Fixed with a
    // top-of-function released-response guard, mirroring render-json.js (#B36).

    it('render guards a released response after the #M1 captures, before the res.stream read', function() {
        var s = src();
        var guardIdx   = s.search(/if\s*\(\s*local\.res\s*==\s*null\s*\)\s*\{[\s\S]{0,40}?return;/);
        var captureIdx = s.search(/var\s+_next\s*=\s*local\.next;/);
        var streamIdx  = s.indexOf('typeof(res.stream)');
        assert.ok(guardIdx > -1, 'expected an `if ( local.res == null ) return;` guard in render()');
        assert.ok(captureIdx > -1 && captureIdx < guardIdx, 'guard must follow the #M1 req/res/next captures');
        assert.ok(streamIdx > guardIdx, 'guard must precede the res.stream read (the crash site)');
    });

    // ---- pure-logic replica of the guard + the crash site (render-swig.js:259) ----
    function renderHead(localRes, mode) {
        // mode: 'fixed' (post-#B45) | 'prefix' (pre-#B45, no guard)
        var res = localRes;                       // #M1 capture: var res = local.res
        if (mode === 'fixed' && localRes == null) return 'no-op (released)';
        var stream = (typeof res.stream != 'undefined') ? res.stream : null;   // :259
        return 'rendered (stream=' + stream + ')';
    }

    it('replica: released response no-ops; live response proceeds', function() {
        assert.strictEqual(renderHead(null, 'fixed'), 'no-op (released)');
        assert.strictEqual(renderHead({}, 'fixed'), 'rendered (stream=null)');
    });

    it('subtract: the pre-fix head throws reading `stream` on a released response', function() {
        assert.throws(function() { renderHead(null, 'prefix'); },
            function(err) {
                return err instanceof TypeError
                    && /Cannot read properties of null \(reading 'stream'\)/.test(err.message);
            },
            'the unguarded render head must reproduce the released-response crash');
    });
});

// 20 — writeCache module-scope safety: the prod cache-path 500 regression.
// writeCache is a MODULE-LEVEL function while `self`/`local` are deliberately
// FUNCTION-scoped inside render() (#INS10 race fix), so any bare `self`
// reference inside writeCache is a ReferenceError on every prod request whose
// route carries a `cache` setting (the guard short-circuits first when the
// route has none, and dev/cacheless callers skip writeCache under default
// settings — which is why the crash surfaced only on production deployments).
describe('20 - writeCache module-scope safety (prod cache-path 500 regression)', function() {
    var _src = null;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    /**
     * Slices the module-level region from the writeCache declaration to
     * `module.exports` (writeCache is the last declaration before it), with
     * comments stripped so prose mentions can never satisfy or trip the pins.
     *
     * @inner
     * @returns {string} comment-stripped module-level tail region
     */
    function getWriteCacheRegion() {
        var src = getSrc();
        var start = src.indexOf('async function writeCache');
        var end = src.indexOf('module.exports');
        assert.ok(start > 0 && end > start, 'expected `async function writeCache` followed by `module.exports`');
        return src.substring(start, end)
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');
    }

    it('writeCache body never references `self` (module scope has no render()-scoped bindings)', function() {
        var region = getWriteCacheRegion();
        assert.ok(!/\bself\b/.test(region),
            'writeCache (module-level) must not reference `self` — it is function-scoped inside render() per the #INS10 race fix; thread values as parameters instead');
    });

    it('module-level guard reading a function-scoped binding throws ReferenceError (the pre-fix 500); the param-threaded guard does not', function() {
        // Premise: Node defines no global `self` (unlike browsers/workers) —
        // that absence is exactly what turned the pre-fix guard into a crash.
        assert.strictEqual(typeof self, 'undefined', 'premise: no global `self` in Node');

        // Pre-fix replica of the writeCache guard (controller.render-swig.js:47 shape).
        var preFix = function(routingCache) {
            if (
                typeof(routingCache) == 'undefined'
                || !routingCache
                || String(self.serverInstance._cacheIsEnabled).toLowerCase() !== 'true'
            ) {
                return 'skip';
            }
            return 'write';
        };
        // Route WITH a cache setting → the third condition is evaluated → ReferenceError (the production 500).
        assert.throws(function() { preFix('memory'); }, ReferenceError,
            'pre-fix shape must throw ReferenceError when a route carries a cache setting');
        // Route WITHOUT a cache key short-circuits before the deref — bundles with
        // zero cached routes were unaffected, matching the field report.
        assert.strictEqual(preFix(undefined), 'skip');
        assert.strictEqual(preFix(false), 'skip');

        // Post-fix replica: the flag is threaded as a parameter.
        var postFix = function(routingCache, cacheIsEnabled) {
            if (
                typeof(routingCache) == 'undefined'
                || !routingCache
                || String(cacheIsEnabled).toLowerCase() !== 'true'
            ) {
                return 'skip';
            }
            return 'write';
        };
        assert.strictEqual(postFix('memory', true), 'write');
        assert.strictEqual(postFix('memory', 'true'), 'write');
        assert.strictEqual(postFix('memory', 'false'), 'skip');
        assert.strictEqual(postFix('memory', undefined), 'skip');
        assert.strictEqual(postFix(undefined, true), 'skip');
    });

    it('both call sites thread the flag + throwError from the render-scoped controller', function() {
        var src = getSrc();
        var matches = src.match(/await\s+writeCache\([^)]*self\.serverInstance\._cacheIsEnabled\s*,\s*self\.throwError\s*\)/g);
        assert.ok(matches, 'no flag-threading writeCache call sites found');
        assert.strictEqual(matches.length, 2,
            'expected exactly 2 call sites threading self.serverInstance._cacheIsEnabled + self.throwError into writeCache (cache-write + post-asset-injection)');
    });
});

describe('21 - per-request deps are function-scoped in render() (#B61 module-scope race)', function() {
    var _src = null;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }
    function stripComments(s) { return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); }

    /**
     * Comment-stripped module prefix: file start → the writeCache declaration
     * (the first and only module-level function). In prod this module is a
     * shared singleton across concurrent requests, so nothing per-request may
     * be declared in this region — a module-scoped capture reassigned by every
     * incoming render() makes a render suspended at an await resume with a
     * concurrent request's closures.
     *
     * @inner
     * @returns {string} comment-stripped module-level prefix region
     */
    function getModulePrefix() {
        var src = getSrc();
        var end = src.indexOf('async function writeCache');
        assert.ok(end > 0, 'expected `async function writeCache` in source');
        return stripComments(src.substring(0, end));
    }

    it('module scope declares no per-request state', function() {
        var prefix = getModulePrefix();
        assert.ok(
            !/var\s+(getData|hasViews|setResources|SwigFilters|headersSent|cachePath|self|local)\b/.test(prefix),
            'a per-request binding is declared at module scope — it must be function-scoped inside render() (#B61)'
        );
        // The pre-fix block used the comma-continued `, name = null` declaration form.
        assert.ok(
            !/,\s*(getData|hasViews|setResources|SwigFilters|headersSent|cachePath)\s*=\s*null/.test(prefix),
            'the pre-#B61 comma-continued module declaration block is back — per-request deps must be function-scoped'
        );
    });

    it('render() captures every dep with `var` (function-scoped), including the engine ref', function() {
        var src = getSrc();
        ['self', 'local', 'getData', 'hasViews', 'setResources', 'swig', 'SwigFilters', 'headersSent'].forEach(function(name) {
            assert.match(
                src,
                new RegExp('var\\s+' + name + '\\s*=\\s*deps\\.' + name + '\\s*;'),
                '`var ' + name + ' = deps.' + name + ';` missing from render() — dep no longer function-scoped'
            );
        });
        assert.match(src, /var\s+cachePath\s*=\s*null\s*;/,
            'function-scoped `var cachePath = null;` missing from render()');
        // A declaration-less dep assignment recreates the shared module slot
        // (or, for the engine ref, an implicit global — the file is non-strict).
        assert.ok(
            !/^\s*(getData|hasViews|setResources|swig|SwigFilters|headersSent)\s*=\s*deps\./m.test(stripComments(src)),
            'a dep is assigned without `var` — module-scope / implicit-global capture reintroduced (#B61)'
        );
    });

    it('interleaved-render replica: module-scoped capture executes the concurrent request\'s closure; function-scoped does not (subtract)', async function() {
        // Mirrors the delegate shape: a capture assigned at entry, one call
        // before the template-read await (the getData at the top of the try),
        // one after it (the `merge(data, getData())` restore). Two renders in
        // the same tick both suspend at the await before either resumes, so
        // under module scope the second assignment always clobbers the first.
        function mkDelegate(mode) {
            var modGetData = null; // module-scope analog: shared across calls
            return async function render(deps) {
                var fnGetData = null;
                if (mode === 'module') { modGetData = deps.getData; }
                else { fnGetData = deps.getData; }
                var read = function() { return (mode === 'module') ? modGetData : fnGetData; };
                read()();                                            // pre-await call
                await new Promise(function(r) { setImmediate(r); }); // the template read
                read()();                                            // post-await restore
            };
        }
        function mkDeps(counts, tag) { return { getData: function() { counts[tag]++; } }; }

        // SUBTRACT — the pre-#B61 module-scope shape: render A resumes with B's closure.
        var cm = { A: 0, B: 0 };
        var dm = mkDelegate('module');
        await Promise.all([dm(mkDeps(cm, 'A')), dm(mkDeps(cm, 'B'))]);
        assert.deepStrictEqual(cm, { A: 1, B: 3 },
            'module-scope shape must show the measured 1/3 asymmetry (A\'s post-await call lands on B\'s closure)');

        // Fixed function-scope shape: each render keeps its own closure.
        var cf = { A: 0, B: 0 };
        var df = mkDelegate('function');
        await Promise.all([df(mkDeps(cf, 'A')), df(mkDeps(cf, 'B'))]);
        assert.deepStrictEqual(cf, { A: 2, B: 2 },
            'function-scope shape must call each render\'s own closure exactly twice');
    });
});


// ---------------------------------------------------------------------------
// 22 - bundle-wide sliding / maxAge cache defaults (server.cache)
// ---------------------------------------------------------------------------
describe('22 - bundle-wide sliding / maxAge cache defaults (server.cache)', function() {
    // writeCache inherits sliding/maxAge from opt (= conf.server.cache) when the
    // route omits them, mirroring the existing ttl fallback. Kept in lockstep
    // with render-nunjucks.js and render-json.js; the behavioural proof lives in
    // test/lib/render-engine-dispatch.test.js §05e (a-d).
    it('falls back to opt.sliding / opt.maxAge next to the ttl fallback', function() {
        var src  = fs.readFileSync(SOURCE, 'utf8');
        var idx  = src.indexOf('async function writeCache');
        assert.ok(idx > 0, 'writeCache found');
        // Window widened again for the #SPA1 negotiate-refusal guard added at the top
        // of writeCache (same class as the #B158 widening below in the sibling file):
        // the guard shifts the sliding/maxAge fallbacks past the old 2600 ceiling.
        var body = src.slice(idx, idx + 4600);
        // ttl fallback still present (regression)
        assert.match(body, /typeof\(\s*cachingOption\.ttl\s*\)\s*==\s*['"]undefined['"][\s\S]{0,120}cachingOption\.ttl\s*=\s*opt\.ttl/);
        // new sliding + maxAge fallbacks (route value wins; opt only fills an omitted field)
        assert.match(body, /typeof\(\s*cachingOption\.sliding\s*\)\s*==\s*['"]undefined['"]\s*&&\s*typeof\(\s*opt\.sliding\s*\)\s*!=\s*['"]undefined['"][\s\S]{0,80}cachingOption\.sliding\s*=\s*opt\.sliding/);
        assert.match(body, /typeof\(\s*cachingOption\.maxAge\s*\)\s*==\s*['"]undefined['"]\s*&&\s*typeof\(\s*opt\.maxAge\s*\)\s*!=\s*['"]undefined['"][\s\S]{0,80}cachingOption\.maxAge\s*=\s*opt\.maxAge/);
    });
    it('documents opt.sliding / opt.maxAge in the writeCache @param opt JSDoc', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.match(src, /@param\s+\{object\}\s+opt[\s\S]{0,120}opt\.sliding[\s\S]{0,40}opt\.maxAge/);
    });
});

// ── 23 — a cache-write failure must not destroy a good render ────────────────
//
// Both `await writeCache(...)` sites sit inside render()'s FUNCTION-LEVEL try,
// whose catch answers 500. So an unguarded cache-write rejection discarded a page
// that had already rendered perfectly and served a 500 instead. (It did NOT hang
// the request — the outer catch always sent a response.) The two sibling delegates
// already degraded correctly: render-nunjucks.js try/catch, render-json.js .catch().
describe('23 - writeCache failures degrade, they do not 500 the render', function() {

    it('both writeCache call sites are wrapped in try/catch (cacheErr)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var guarded = src.match(/try \{[\s\S]{0,30}?await\s+writeCache\([\s\S]{0,260}?\}\s*catch\s*\(cacheErr\)\s*\{/g);
        assert.ok(guarded, 'no guarded writeCache call site found');
        assert.strictEqual(guarded.length, 2,
            'expected both writeCache call sites (cache-write + post-asset-injection) wrapped in try/catch');
    });

    it('the guard logs and never rethrows', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var logs = src.match(/\[render-swig\] writeCache failed/g);
        assert.ok(logs && logs.length === 2, 'expected both guards to log with the [render-swig] tag');
        assert.doesNotMatch(src, /catch\s*\(cacheErr\)\s*\{[\s\S]{0,400}?throw/,
            'a cacheErr guard must never rethrow — that would re-enter the function-level catch and 500');
    });

    // Pure-logic replica of render()'s cache-write step, including the outer
    // function-level try whose catch answers 500.
    function renderStep(writeCacheFn, guarded) {
        return (async function () {
            try {
                var htmlContent = '<html>rendered fine</html>';   // the render already succeeded
                if ( guarded ) {
                    try { await writeCacheFn(); } catch (cacheErr) { /* log only */ }
                } else {
                    await writeCacheFn();
                }
                return { status: 200, body: htmlContent };        // res.end( htmlContent )
            } catch (err) {
                return { status: 500, body: 'throwError' };       // render()'s function-level catch
            }
        })();
    }

    var rejects = function() { return Promise.reject(new Error('cache write blew up')); };
    var resolves = function() { return Promise.resolve(); };

    it('guarded: a failing cache write still serves the rendered page', async function() {
        var res = await renderStep(rejects, true);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body, '<html>rendered fine</html>');
    });

    it('guarded: a successful cache write is unchanged', async function() {
        var res = await renderStep(resolves, true);
        assert.strictEqual(res.status, 200);
    });

    // SUBTRACT — proves the guard is load-bearing, and pins the real pre-fix
    // symptom: a 500 on an otherwise-perfect page (not a hang).
    it('SUBTRACT — without the guard, a failing cache write 500s a good page', async function() {
        var res = await renderStep(rejects, false);
        assert.strictEqual(res.status, 500, 'unguarded, the rejection reaches the function-level catch');
        assert.notStrictEqual(res.body, '<html>rendered fine</html>', 'the rendered page is discarded');
    });
});


// 24 — #RWATCH stale-release banner injection (S3). render-swig calls
// releaseBanner.maybeInject() on the finalized HTML at BOTH finalize sites,
// BEFORE writeCache, so the banner rides both cache-miss renders and cache-hit
// replays (a cache hit is served verbatim from the stored bytes and never
// re-enters the delegate). The injector is a shared, standalone module — the
// behavioral tests below drive the REAL release-banner.js.
describe('24 - #RWATCH stale-release banner injection', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    var BANNER_SRC = path.join(require('../fw'), 'core/controller/release-banner.js');
    function bannerSrc() { return fs.readFileSync(BANNER_SRC, 'utf8'); }
    var releaseBanner = require(BANNER_SRC);

    // ── delegate source pins ──
    it('render-swig requires the release-banner injector', function() {
        assert.match(src(), /var\s+releaseBanner\s*=\s*require\('\.\/release-banner'\)/,
            "expected `var releaseBanner = require('./release-banner')` in render-swig.js");
    });

    it('maybeInject is called at BOTH finalize sites, before writeCache', function() {
        var s = src();
        var calls = s.match(/releaseBanner\.maybeInject\(\s*htmlContent\s*,\s*localOptions\.conf\s*,\s*_cspNonceAttr\s*\)/g);
        assert.ok(calls && calls.length === 2,
            'expected exactly 2 releaseBanner.maybeInject(htmlContent, localOptions.conf, _cspNonceAttr) sites');
        // both inject sites precede a writeCache — the banner must be in the stored bytes
        assert.ok(s.indexOf('releaseBanner.maybeInject(') < s.indexOf('await writeCache('),
            'the first inject must precede the first writeCache');
        assert.ok(s.lastIndexOf('releaseBanner.maybeInject(') < s.lastIndexOf('await writeCache('),
            'the second inject must precede the second writeCache');
    });

    // ── banner source pin: the </body> splice is a FUNCTION replacer ($-safe form) ──
    it('maybeInject splices via a function replacer, not a string replacement', function() {
        var b = bannerSrc();
        assert.match(b, /html\.replace\(\/<\\\/body>\/i,\s*function\s*\(\)\s*\{\s*return\s+'\\n'\s*\+\s*snippet/,
            'expected the </body> splice to use a function replacer (String.replace $-expansion safety)');
        assert.doesNotMatch(b, /html\.replace\(\/<\\\/body>\/i,\s*'\\n'\s*\+\s*snippet/,
            'the vulnerable string-replacement form must be absent');
    });

    // ── behavioral against the real release-banner module ──
    function setOrDel(k, v) { if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; } }
    function withGate(scopeLocal, envDev, fn) {
        var s = process.env.NODE_SCOPE_IS_LOCAL, d = process.env.NODE_ENV_IS_DEV;
        setOrDel('NODE_SCOPE_IS_LOCAL', scopeLocal);
        setOrDel('NODE_ENV_IS_DEV', envDev);
        try { return fn(); } finally { setOrDel('NODE_SCOPE_IS_LOCAL', s); setOrDel('NODE_ENV_IS_DEV', d); }
    }
    var CONF_ON  = { server: { releaseWatch: { enabled: true  } } };
    var CONF_OFF = { server: { releaseWatch: { enabled: false } } };
    var PAGE = '<!DOCTYPE html><html><head></head><body><div>PAGEBODY</div></body></html>';

    it('gate ON (local + !dev + enabled): injects the shadow-DOM banner into the stored HTML', function() {
        var out = withGate('true', undefined, function() { return releaseBanner.maybeInject(PAGE, CONF_ON, ''); });
        assert.notStrictEqual(out, PAGE, 'the banner must be injected when the gate passes');
        assert.ok(out.indexOf(releaseBanner.MARKER) > -1, 'the marker (double-injection guard token) must be present');
        assert.ok(out.indexOf('attachShadow') > -1, 'the shadow-DOM client must be present');
        assert.ok(out.indexOf('EventSource(') > -1 && out.indexOf('/_gina/release/status') > -1,
            'the live client (SSE + status fetch) must be present');
        assert.strictEqual((out.match(/<\/body>/g) || []).length, 1, 'exactly one </body> (function replacer, no duplication)');
        assert.strictEqual((out.match(/PAGEBODY/g) || []).length, 1, 'no page-body duplication (function replacer)');
        assert.match(out, /<\/script>\s*<\/body>/, 'the snippet is spliced immediately before </body>');
    });

    it('gate OFF — scope not local: HTML unchanged', function() {
        assert.strictEqual(withGate('false', undefined, function() { return releaseBanner.maybeInject(PAGE, CONF_ON, ''); }), PAGE);
    });

    it('gate OFF — dev env: HTML unchanged', function() {
        assert.strictEqual(withGate('true', 'true', function() { return releaseBanner.maybeInject(PAGE, CONF_ON, ''); }), PAGE);
    });

    it('gate OFF — releaseWatch.enabled false: HTML unchanged', function() {
        assert.strictEqual(withGate('true', undefined, function() { return releaseBanner.maybeInject(PAGE, CONF_OFF, ''); }), PAGE);
    });

    it('gate OFF — releaseWatch config missing: HTML unchanged', function() {
        assert.strictEqual(withGate('true', undefined, function() { return releaseBanner.maybeInject(PAGE, { server: {} }, ''); }), PAGE);
    });

    it('non-HTML (no </body>, e.g. a JSON/API body) is skipped', function() {
        var json = '{"ok":true}';
        assert.strictEqual(withGate('true', undefined, function() { return releaseBanner.maybeInject(json, CONF_ON, ''); }), json);
    });

    it('non-string input is returned as-is', function() {
        var obj = { page: 1 };
        assert.strictEqual(withGate('true', undefined, function() { return releaseBanner.maybeInject(obj, CONF_ON); }), obj);
    });

    it('double injection is a no-op (marker guard — a cached page already carrying the banner)', function() {
        var once  = withGate('true', undefined, function() { return releaseBanner.maybeInject(PAGE, CONF_ON, ''); });
        var twice = withGate('true', undefined, function() { return releaseBanner.maybeInject(once, CONF_ON, ''); });
        assert.strictEqual(twice, once, 'a second inject on already-injected HTML must be a no-op');
        assert.strictEqual(once.split(releaseBanner.MARKER).length - 1, 1, 'the marker must appear exactly once');
    });

    it('the CSP nonce is applied to the injected <script> (#HDR16)', function() {
        var out = withGate('true', undefined, function() {
            return releaseBanner.maybeInject(PAGE, CONF_ON, ' nonce="abc123"');
        });
        assert.ok(out.indexOf('<script nonce="abc123">') > -1, 'the nonce attribute must ride the injected script tag');
    });

    // ── pure-logic $-safe replica (mirrors §18): the function-replacer FORM maybeInject
    //    uses inserts content verbatim; the string form would $-expand / duplicate the doc.
    //    (Measured 2026-07-15: today's serialised snippet carries NO $-special sequence, so
    //    the form is DEFENSIVE here — it guards any future $-content in the client, per the
    //    codebase $-splice rule — not strictly load-bearing for the current snippet.)
    var DOLLAR_BACKTICK = '$' + '`';
    var DOLLAR_QUOTE    = '$' + "'";
    function spliceUnsafe(doc, inj) { return doc.replace(/<\/body>/i, inj + '</body>'); }
    function spliceSafe(doc, inj)   { return doc.replace(/<\/body>/i, function () { return inj + '</body>'; }); }
    var DOC = '<!DOCTYPE html><html><body><div>PAGEBODY</div></body></html>';
    var INJ = '<script>/* ' + DOLLAR_BACKTICK + ' ' + DOLLAR_QUOTE + ' */</script>';

    it('replica: the string form nests the document (why the injector avoids it)', function() {
        var out = spliceUnsafe(DOC, INJ);
        assert.ok((out.match(/PAGEBODY/g) || []).length > 1,
            'a string replacement duplicates the page body via the prematch pattern');
    });

    it('replica: the function-replacer form inserts verbatim (the form maybeInject uses)', function() {
        var out = spliceSafe(DOC, INJ);
        assert.strictEqual((out.match(/PAGEBODY/g) || []).length, 1, 'no duplication with a function replacer');
        assert.ok(out.indexOf(DOLLAR_BACKTICK) > -1 && out.indexOf(DOLLAR_QUOTE) > -1,
            'the $-sequences survive verbatim in the injected content');
    });

});


// 25 — #B130: render-time bootstrap nonce vs the two caches (compiled-template + layout-cache file)
describe('25 - #B130 render-time nonce: swig-conditional mechanism + layout-cache healing', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    var NONCE_TPL = '{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}';

    // ── source pins ──

    it('derives _cspNonceTplAttr (the template form) alongside the literal _cspNonceAttr', function() {
        assert.ok(
            src().indexOf('var _cspNonceTplAttr = _cspNonce ? \'{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}\' : \'\';') > -1,
            'expected the _cspNonceTplAttr derivation (swig-conditional form)'
        );
    });

    it('carries the layout-cache normalization regexes (upgrade path for stale literal-nonce files)', function() {
        var s = src();
        // Exact-literal pins: these lock the regexes the replicas below drive, so the
        // replicas cannot silently drift from the shipped source.
        assert.ok(s.indexOf('/<script type="text\\/javascript" nonce="[^"]*">(\\s*<!--)/g') > -1,
            'expected the loader-anchored normalization regex');
        assert.ok(s.indexOf('/<script nonce="[^"]*">(window\\.__gina(Data|Logs))/g') > -1,
            'expected the Inspector-script-anchored normalization regex');
    });

    it('normalization runs after the layout read, before the cache-hit/compile branch split', function() {
        var s = src();
        var readAt = s.indexOf("layout = await fs.promises.readFile(layoutPath, 'utf8')");
        var normAt = s.indexOf('/<script type="text\\/javascript" nonce="[^"]*">(\\s*<!--)/g');
        var hitAt  = s.indexOf('cache.has(cacheKey)', readAt);
        assert.ok(readAt > -1 && normAt > readAt, 'normalization sits after the layout read');
        assert.ok(hitAt > normAt, 'normalization sits before the hit/compile branch');
    });

    // ── behavioral: the REAL swig engine proves per-execute rotation from ONE compile ──

    var swig = require('@rhinostone/swig');
    var LOADER_RAW = '\n\t\t<script type="text/javascript">\n\t\t<!--\n\t\tfunction onGinaLoaded(){}\n\t\t//-->\n\t\t</script>';

    it('real swig: one compiled template serves a DIFFERENT nonce per execute (the defect, inverted)', function() {
        var injected = LOADER_RAW.replace(
            '<script type="text/javascript">',
            '<script type="text/javascript">'.replace('>', NONCE_TPL + '>')
        );
        var tpl  = swig.compile('<head>' + injected + '\n</head>');
        var out1 = tpl({ page: { cspNonce: 'AbC+/1==' } });
        var out2 = tpl({ page: { cspNonce: 'XyZ/9+w=' } });
        assert.ok(out1.indexOf(' nonce="AbC+/1=="') > -1, 'execute 1 carries its own nonce');
        assert.ok(out2.indexOf(' nonce="XyZ/9+w="') > -1, 'execute 2 carries its own nonce');
        assert.strictEqual(out2.indexOf('AbC+/1=='), -1, 'execute 2 must NOT carry execute 1\'s nonce');
    });

    it('real swig: base64 nonce chars (+ / =) survive autoescape intact', function() {
        var tpl = swig.compile('<s' + 'cript' + NONCE_TPL + '>');
        var out = tpl({ page: { cspNonce: 'a+b/c=d=' } });
        assert.ok(out.indexOf(' nonce="a+b/c=d="') > -1, 'the base64 alphabet must pass through unescaped');
    });

    it('real swig: no attr at all when page.cspNonce is absent', function() {
        var tpl = swig.compile('<head><script type="text/javascript"' + NONCE_TPL + '></head>');
        var out = tpl({ page: {} });
        assert.strictEqual(out.indexOf('nonce'), -1, 'no nonce attribute without a request nonce');
        assert.ok(out.indexOf('<script type="text/javascript">') > -1, 'bare tag preserved');
    });

    // ── normalization replicas (regex literals locked by the source pins above) ──

    var NORM_LOADER = /<script type="text\/javascript" nonce="[^"]*">(\s*<!--)/g;
    var NORM_GINA   = /<script nonce="[^"]*">(window\.__gina(Data|Logs))/g;
    function normalize(layout) {
        layout = layout.replace(NORM_LOADER, '<script type="text/javascript"' + '{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}' + '>$1');
        layout = layout.replace(NORM_GINA,   '<script' + '{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}' + '>$1');
        return layout;
    }

    it('replica: heals a stale literal-nonce loader tag written by a pre-fix build', function() {
        var stale  = '<head>\n\t\t<script type="text/javascript" nonce="OLDNONCE+/=">\n\t\t<!--\n\t\tfunction onGinaLoaded(){}\n\t\t//-->\n\t\t</script></head>';
        var healed = normalize(stale);
        assert.strictEqual(healed.indexOf('OLDNONCE+/='), -1, 'the frozen literal must be gone');
        assert.ok(healed.indexOf('{% if page.cspNonce %}') > -1, 'the conditional replaces it');
        // and the healed layout executes with a fresh per-request nonce
        var out = swig.compile(healed)({ page: { cspNonce: 'FRESH123' } });
        assert.ok(out.indexOf(' nonce="FRESH123"') > -1, 'healed layout serves the request nonce');
    });

    it('replica: heals stale Inspector-script tags (dev + cache-enabled combination)', function() {
        var stale  = '<script nonce="OLD1">window.__ginaData = {};</script><script nonce="OLD2">window.__ginaLogs = [];</script>';
        var healed = normalize(stale);
        assert.strictEqual(healed.indexOf('OLD1'), -1);
        assert.strictEqual(healed.indexOf('OLD2'), -1);
        assert.strictEqual((healed.match(/\{% if page\.cspNonce %\}/g) || []).length, 2);
    });

    it('replica: idempotent — a healed layout is not re-touched', function() {
        var stale  = '<script type="text/javascript" nonce="X">\n<!--\nfunction onGinaLoaded(){}\n//-->\n</script>';
        var once   = normalize(stale);
        assert.strictEqual(normalize(once), once, 'second pass must be a no-op');
    });

    it('replica: application script tags are NOT touched (anchor safety)', function() {
        // a literal-nonce app tag with no <!-- right after, and a non-__gina inline script
        var app = '<script type="text/javascript" nonce="APP1">var x=1;</script>'
                + '<script nonce="APP2">appBoot();</script>';
        assert.strictEqual(normalize(app), app, 'app-authored tags must pass through verbatim');
    });

});
