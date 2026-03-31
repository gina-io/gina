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
