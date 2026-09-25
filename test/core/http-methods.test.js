'use strict';
/**
 * PATCH and HEAD method support — server + controller layer tests
 *
 * Strategy: source inspection + inline logic replicas.
 * No live HTTP server, no framework bootstrap, no project required.
 *
 * Suites:
 *  01 — server.js: request object initialisation
 *  02 — server.js: processRequestData PATCH case
 *  03 — server.js: processRequestData HEAD case
 *  04 — server.js: handle() method matching (HEAD→GET fallback, PATCH URI params)
 *  05 — controller.js: getParams / getParam PATCH and HEAD cases
 *  06 — render-json.js: HEAD body suppression guard
 *  07 — render-swig.js: HEAD body suppression guard
 *  08 — inline logic: PATCH body parsing replica
 *  09 — inline logic: HEAD query-string processing replica
 *  10 — server.js source: method-routing fix (405 continue instead of break)
 *  11 — inline logic: method-routing 405 after full scan
 *  12 — body parser: '+' → space decoding for application/x-www-form-urlencoded
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW              = require('../fw');
var SERVER_SRC      = path.join(FW, 'core/server.js');
var CONTROLLER_SRC  = path.join(FW, 'core/controller/controller.js');
var RENDER_JSON_SRC = path.join(FW, 'core/controller/controller.render-json.js');
var RENDER_SWIG_SRC = path.join(FW, 'core/controller/controller.render-swig.js');


// ─── 01 — server.js: request object initialisation ───────────────────────────

describe('01 - HTTP methods: server.js request init', function() {

    var src;
    before(function() { src = fs.readFileSync(SERVER_SRC, 'utf8'); });

    it('initialises request.patch = {}', function() {
        assert.ok(/request\.patch\s*=\s*\{\}/.test(src));
    });

    it('initialises request.head = {}', function() {
        assert.ok(/request\.head\s*=\s*\{\}/.test(src));
    });

    it('initialises request.patch before request.files', function() {
        var patchIdx = src.indexOf('request.patch   = {};');
        var filesIdx = src.indexOf('request.files   = [];');
        assert.ok(patchIdx > 0 && filesIdx > 0 && patchIdx < filesIdx,
            'patch init should appear before files init');
    });

    it('no longer has the commented-out //request.patch = {}; ??? line', function() {
        assert.ok(!/\/\/request\.patch\s*=\s*\{\}/.test(src));
    });
});


// ─── 02 — server.js: processRequestData PATCH case ───────────────────────────

describe('02 - HTTP methods: server.js processRequestData PATCH', function() {

    var src;
    before(function() { src = fs.readFileSync(SERVER_SRC, 'utf8'); });

    it("has a case 'patch': branch in processRequestData", function() {
        assert.ok(/case\s+'patch'\s*:/.test(src));
    });

    it('assigns parsed body to request.patch', function() {
        assert.ok(/request\.patch\s*=\s*obj/.test(src));
    });

    it('aliases request.body to request.patch on success', function() {
        assert.ok(/request\.body\s*=\s*request\.patch\s*=\s*obj/.test(src));
    });

    it('sets cache-control no-cache headers for PATCH (not cacheable)', function() {
        // The cache-control block appears inside the patch case
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.ok(/cache-control.*no-cache/.test(patchCase));
        assert.ok(/pragma.*no-cache/.test(patchCase));
    });

    it('clears request.get after PATCH processing', function() {
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.ok(/request\.get\s*=\s*undefined/.test(patchCase));
    });

    it('clears request.post after PATCH processing', function() {
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.ok(/request\.post\s*=\s*undefined/.test(patchCase));
    });

    it('clears request.put after PATCH processing', function() {
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.ok(/request\.put\s*=\s*undefined/.test(patchCase));
    });

    it('clears request.delete after PATCH processing', function() {
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.ok(/request\.delete\s*=\s*undefined/.test(patchCase));
    });

    it('handles string body with decodeURIComponent', function() {
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.ok(/decodeURIComponent/.test(patchCase));
    });

    it('handles object body via JSON.stringify + JSON.parse round-trip', function() {
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.ok(/JSON\.stringify/.test(patchCase));
        assert.ok(/JSON\.parse/.test(patchCase));
    });

    it('logs a warning on PATCH body parse failure instead of throwing', function() {
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.ok(/console\.warn/.test(patchCase));
    });
});


// ─── 03 — server.js: processRequestData HEAD case ────────────────────────────

describe('03 - HTTP methods: server.js processRequestData HEAD', function() {

    var src;
    before(function() { src = fs.readFileSync(SERVER_SRC, 'utf8'); });

    it("has a case 'head': branch in processRequestData", function() {
        assert.ok(/case\s+'head'\s*:/.test(src));
    });

    it('assigns processed query string to request.head', function() {
        assert.ok(/request\.head\s*=\s*request\.query/.test(src));
    });

    it('clears request.get after HEAD processing (HEAD has its own req.head)', function() {
        var headStart = src.indexOf("case 'head':");
        var headCase  = src.slice(headStart, headStart + 3000);
        assert.ok(/request\.get\s*=\s*undefined/.test(headCase));
    });

    it('clears request.post after HEAD processing', function() {
        var headStart = src.indexOf("case 'head':");
        var headCase  = src.slice(headStart, headStart + 3000);
        assert.ok(/request\.post\s*=\s*undefined/.test(headCase));
    });

    it('clears request.put after HEAD processing', function() {
        var headStart = src.indexOf("case 'head':");
        var headCase  = src.slice(headStart, headStart + 3000);
        assert.ok(/request\.put\s*=\s*undefined/.test(headCase));
    });

    it('clears request.patch after HEAD processing', function() {
        var headStart = src.indexOf("case 'head':");
        var headCase  = src.slice(headStart, headStart + 3000);
        assert.ok(/request\.patch\s*=\s*undefined/.test(headCase));
    });

    it('does NOT set cache-control headers for HEAD (read-only, cacheable)', function() {
        var headStart = src.indexOf("case 'head':");
        var headCase  = src.slice(headStart, headStart + 3000);
        assert.ok(!/setHeader\('cache-control'/.test(headCase));
    });
});


// ─── 04 — server.js: handle() method matching ────────────────────────────────

describe('04 - HTTP methods: server.js handle() routing', function() {

    var src;
    before(function() { src = fs.readFileSync(SERVER_SRC, 'utf8'); });

    it('has a HEAD→GET fallback in isMethodAllowed check', function() {
        assert.ok(/\/\^head\$\/i\.test\(req\.method\)\s*&&\s*\/\^get\$\/i\.test\(_routing\.method\)/.test(src));
    });

    it('HEAD→GET fallback sets isMethodAllowed = true without overwriting req.method', function() {
        // Unlike the GET→DELETE override which rewrites req.method,
        // the HEAD→GET fallback must leave req.method as 'HEAD'
        var headFallback = src.match(/\/\^head\$\/i\.test\(req\.method\)[^}]+}/);
        assert.ok(headFallback, 'HEAD fallback block not found');
        assert.ok(!/req\.method\s*=\s*_routing\.method/.test(headFallback[0]),
            'HEAD fallback should not overwrite req.method');
    });

    it("has an else if (method === 'patch') URI param merging block", function() {
        assert.ok(/else if \( method === 'patch' \)/.test(src));
    });

    it('PATCH URI param merging assigns to req.patch', function() {
        var patchBlock = src.slice(
            src.indexOf("else if ( method === 'patch' )"),
            src.indexOf("else if ( method === 'head' )")
        );
        assert.ok(/req\.patch\[parameter\]\s*=\s*req\.params\[parameter\]/.test(patchBlock));
    });

    it("has an else if (method === 'head') URI param merging block", function() {
        assert.ok(/else if \( method === 'head' \)/.test(src));
    });

    it('HEAD URI param merging assigns to req.head (not req.get)', function() {
        var headBlock = src.slice(src.indexOf("else if ( method === 'head' )"));
        var blockEnd  = headBlock.indexOf('\n                    }');
        var block     = headBlock.slice(0, blockEnd + 1);
        assert.ok(/req\.head\[parameter\]\s*=\s*req\.params\[parameter\]/.test(block));
        assert.ok(!/req\.get\[parameter\]/.test(block));
    });
});


// ─── 05 — controller.js: getParams / getParam ────────────────────────────────

describe('05 - HTTP methods: controller.js getParams and getParam', function() {

    var src;
    before(function() { src = fs.readFileSync(CONTROLLER_SRC, 'utf8'); });

    it("getParams() has case 'patch': merging req.patch", function() {
        assert.ok(/case\s+'patch'\s*:\s*\n\s*params\s*=\s*merge\(params,\s*req\.patch/.test(src));
    });

    it("getParams() has case 'head': merging req.head", function() {
        assert.ok(/case\s+'head'\s*:\s*\n\s*params\s*=\s*merge\(params,\s*req\.head/.test(src));
    });

    it("getParam() has case 'patch': reading req.patch[name]", function() {
        assert.ok(/case\s+'patch'\s*:\s*\n\s*param\s*=\s*req\.patch\[name\]/.test(src));
    });

    it("getParam() has case 'head': reading req.head[name]", function() {
        assert.ok(/case\s+'head'\s*:\s*\n\s*param\s*=\s*req\.head\[name\]/.test(src));
    });

    it('getParams() switch covers all six methods', function() {
        var getParamsFn = src.slice(src.indexOf('req.getParams = function()'), src.indexOf('req.getParam = function(name)'));
        ['get', 'post', 'put', 'delete', 'patch', 'head'].forEach(function(method) {
            assert.ok(new RegExp("case\\s+'" + method + "'").test(getParamsFn),
                'getParams() missing case for ' + method);
        });
    });

    it('getParam() switch covers all six methods', function() {
        var getParamStart = src.indexOf('req.getParam = function(name)');
        var getParamFn = src.slice(getParamStart, src.indexOf('}\n    }', getParamStart) + 6);
        ['get', 'post', 'put', 'delete', 'patch', 'head'].forEach(function(method) {
            assert.ok(new RegExp("case\\s+'" + method + "'").test(getParamFn),
                'getParam() missing case for ' + method);
        });
    });
});


// ─── 06 — render-json.js: HEAD body suppression ──────────────────────────────

describe('06 - HTTP methods: render-json.js HEAD suppression', function() {

    var src;
    before(function() { src = fs.readFileSync(RENDER_JSON_SRC, 'utf8'); });

    it('has a HEAD method guard', function() {
        assert.ok(/\/\^HEAD\$\/i\.test\(request\.method\)/.test(src));
    });

    it('calculates content-length from Buffer.byteLength for HEAD response', function() {
        assert.ok(/Buffer\.byteLength\(data/.test(src));
    });

    it('calls stream.end() without body for HTTP/2 HEAD', function() {
        var headBlock = src.slice(src.indexOf('/^HEAD$/i.test(request.method)'));
        var blockEnd  = headBlock.indexOf('\n        return;\n        }');
        var block     = headBlock.slice(0, blockEnd);
        assert.ok(/stream\.end\(\)/.test(block));
    });

    it('calls response.end() without body for HTTP/1.1 HEAD', function() {
        var headBlock = src.slice(src.indexOf('/^HEAD$/i.test(request.method)'));
        var blockEnd  = headBlock.indexOf('\n        return;\n        }');
        var block     = headBlock.slice(0, blockEnd);
        assert.ok(/response\.end\(\)/.test(block));
    });

    it('nulls local.req, local.res, local.next after HEAD response', function() {
        var headBlock = src.slice(src.indexOf('/^HEAD$/i.test(request.method)'));
        var blockEnd  = headBlock.indexOf('\n        return;\n        }');
        var block     = headBlock.slice(0, blockEnd);
        assert.ok(/local\.req\s*=\s*null/.test(block));
        assert.ok(/local\.res\s*=\s*null/.test(block));
        assert.ok(/local\.next\s*=\s*null/.test(block));
    });

    it('HEAD guard appears before the XHR and stream write paths', function() {
        var headIdx   = src.indexOf('/^HEAD$/i.test(request.method)');
        var streamIdx = src.indexOf('stream.end(data)');
        assert.ok(headIdx < streamIdx, 'HEAD guard should appear before stream.end(data)');
    });
});


// ─── 07 — render-swig.js: HEAD body suppression ──────────────────────────────

describe('07 - HTTP methods: render-swig.js HEAD suppression', function() {

    var src;
    before(function() { src = fs.readFileSync(RENDER_SWIG_SRC, 'utf8'); });

    it('has a HEAD method guard in the Swig render path', function() {
        // Post-#M1 retrofit: `local.req.method` reads were renamed to the
        // function-scoped capture `req.method` (race-safe against external
        // null-outs of local.req during render's async awaits).
        assert.ok(/\/\^HEAD\$\/i\.test\(req\.method\)/.test(src));
    });

    it('sets content-type header for HEAD HTML response', function() {
        assert.ok(/setHeader\('content-type'/.test(src));
    });

    it('calculates content-length from Buffer.byteLength for HEAD HTML response', function() {
        assert.ok(/Buffer\.byteLength\(htmlContent/.test(src));
    });

    it('calls res.end() without body for HEAD', function() {
        // The HEAD path should call res.end() with no argument (HTTP/1.1 fallback).
        // #H8 added an inner stream branch: if (stream) { stream.end() } else { res.end() }
        // so we look for res.end() within the full HEAD block (up to `} else if`).
        // Word-boundary anchor since `res` is the function-scoped capture (no `local.` prefix).
        var headGuards = src.split('/^HEAD$/i.test(req.method)');
        assert.ok(headGuards.length >= 2, 'Expected at least one HEAD guard in render-swig');
        headGuards.slice(1).forEach(function(block) {
            var blockEnd = block.indexOf('} else if');
            assert.ok(/\bres\.end\(\)/.test(block.slice(0, blockEnd)),
                'HEAD branch should call res.end() with no body');
        });
    });

    it('has HEAD suppression in both render code paths (cache hit and normal)', function() {
        var count = (src.match(/\/\^HEAD\$\/i\.test\(req\.method\)/g) || []).length;
        assert.strictEqual(count, 2, 'Expected HEAD guard in 2 render paths, found ' + count);
    });
});


// ─── 08 — inline logic: PATCH body parsing replica ───────────────────────────

describe('08 - HTTP methods: PATCH body parsing logic (inline replica)', function() {

    // Replica of the PATCH body parsing logic from processRequestData.
    // #B28 — application/json bodies are now parsed verbatim (no url-decode,
    // no "true"/"false"/"on"/"null" coercion); only the urlencoded / legacy
    // path still decodes + coerces.
    function parsePatchBody(body, contentType) {
        var obj = null, bodyStr = null;
        contentType = contentType || 'application/json';

        if (typeof body === 'string') {
            if (!/multipart\/form-data;/.test(contentType)) {
                if (/application\/json/i.test(contentType)) {
                    try { obj = JSON.parse(body); } catch (e) { obj = null; }
                } else {
                    if (/application\/x-www-form-urlencoded/.test(contentType) && /\+/.test(body)) {
                        body = body.replace(/\+/g, ' ');
                    }
                    if (body.substring(0, 1) === '?') body = body.substring(1);
                    // #B588 — the site hands the body over VERBATIM now (no whole-body decode, no
                    // quoted-token pass of its own); the three replace() lines below model the
                    // data helper's DOCUMENT-branch casting, which is where the coercion lives.
                    bodyStr = body;
                    bodyStr = bodyStr
                        .replace(/"false"/g, false)
                        .replace(/"true"/g, true)
                        .replace(/"null"/ig, null);
                    try { obj = JSON.parse(bodyStr); } catch (e) { obj = null; }
                }
            }
        } else {
            bodyStr = JSON.stringify(body);
            bodyStr = bodyStr.replace(/"false"/g, false).replace(/"true"/g, true);
            obj = JSON.parse(bodyStr);
        }

        if (obj && Object.keys(obj).length > 0) {
            return { patch: obj, body: obj };
        }
        return { patch: {}, body: {} };
    }

    it('parses a JSON string body into req.patch', function() {
        var result = parsePatchBody('{"email":"new@example.com"}');
        assert.deepEqual(result.patch, { email: 'new@example.com' });
    });

    it('aliases req.body to the same object as req.patch', function() {
        var result = parsePatchBody('{"name":"Alice"}');
        assert.deepEqual(result.body, result.patch);
    });

    it('strips a leading ? from the body string (form-encoded edge case)', function() {
        var result = parsePatchBody('?{"role":"admin"}', 'application/x-www-form-urlencoded');
        assert.deepEqual(result.patch, { role: 'admin' });
    });

    it('preserves literal + in non-form-encoded bodies (JSON contentType)', function() {
        var result = parsePatchBody('{"tag":"hello+world"}');
        assert.strictEqual(result.patch.tag, 'hello+world',
            "JSON body must preserve literal '+' — only urlencoded bodies get '+' → space");
    });

    it('preserves "true" as a string under application/json (no coercion) — #B28', function() {
        var result = parsePatchBody('{"active":"true"}');
        assert.strictEqual(result.patch.active, 'true');
    });

    it('preserves "false" as a string under application/json (no coercion) — #B28', function() {
        var result = parsePatchBody('{"active":"false"}');
        assert.strictEqual(result.patch.active, 'false');
    });

    it('preserves "null" as a string under application/json (no coercion) — #B28', function() {
        var result = parsePatchBody('{"value":"null"}');
        assert.strictEqual(result.patch.value, 'null');
    });

    it('still coerces "true"→boolean on the urlencoded / legacy path', function() {
        var result = parsePatchBody('{"active":"true"}', 'application/x-www-form-urlencoded');
        assert.strictEqual(result.patch.active, true);
    });

    it('handles an already-parsed object body', function() {
        var result = parsePatchBody({ score: 42 });
        assert.deepEqual(result.patch, { score: 42 });
    });

    it('returns empty patch for an empty body', function() {
        var result = parsePatchBody('{}');
        assert.deepEqual(result.patch, {});
    });

    it('PATCH only changes sent fields — unsent fields are absent from req.patch', function() {
        // This verifies the contract: PATCH body contains only what was sent
        var result = parsePatchBody('{"email":"new@example.com"}');
        assert.ok(!('name' in result.patch), 'unsent field should not appear in req.patch');
        assert.ok(!('role' in result.patch), 'unsent field should not appear in req.patch');
    });
});


// ─── 09 — inline logic: HEAD query-string processing replica ─────────────────

describe('09 - HTTP methods: HEAD query-string processing (inline replica)', function() {

    // Replica of HEAD query processing from processRequestData
    // HEAD uses req.head (not req.get) to store query params
    function processHeadQuery(query) {
        if (!query || Object.keys(query).length === 0) {
            return { head: {}, get: undefined, post: undefined, put: undefined };
        }
        var head = Object.assign({}, query);
        return { head: head, get: undefined, post: undefined, put: undefined };
    }

    it('populates req.head from query string', function() {
        var result = processHeadQuery({ id: '42', format: 'json' });
        assert.deepEqual(result.head, { id: '42', format: 'json' });
    });

    it('sets req.get to undefined (HEAD has its own req.head)', function() {
        var result = processHeadQuery({ q: 'test' });
        assert.strictEqual(result.get, undefined);
    });

    it('sets req.post to undefined for HEAD', function() {
        var result = processHeadQuery({ q: 'test' });
        assert.strictEqual(result.post, undefined);
    });

    it('sets req.put to undefined for HEAD', function() {
        var result = processHeadQuery({ q: 'test' });
        assert.strictEqual(result.put, undefined);
    });

    it('sets req.head to empty object when no query params', function() {
        var result = processHeadQuery({});
        assert.deepEqual(result.head, {});
    });

    it('HEAD does not set req.body (HEAD has no request body)', function() {
        var result = processHeadQuery({ id: '1' });
        assert.ok(!('body' in result), 'HEAD processing should not set req.body');
    });

    it('GET routes automatically match HEAD — verified in server.js source', function() {
        var src = fs.readFileSync(SERVER_SRC, 'utf8');
        assert.ok(/\/\^head\$\/i\.test\(req\.method\)\s*&&\s*\/\^get\$\/i\.test\(_routing\.method\)/.test(src),
            'server.js must have HEAD→GET fallback in isMethodAllowed');
    });

    it('HEAD response body is suppressed — req.head holds same data as GET would in req.get', function() {
        var getResult = { get: { page: '2', q: 'gina' } };
        var headResult = processHeadQuery({ page: '2', q: 'gina' });
        // Same params, different storage key
        assert.deepEqual(headResult.head, getResult.get);
    });
});


// ─── 10 — server.js source: method-routing fix (405 continue instead of break) ─

describe('10 - method-routing fix: server.js source structure', function() {

    var src;
    before(function() { src = fs.readFileSync(SERVER_SRC, 'utf8'); });

    it('_methodMismatch405msg variable is declared in handle()', function() {
        assert.ok(/_methodMismatch405msg\s*=\s*null/.test(src),
            'server.js must declare _methodMismatch405msg = null');
    });

    it('method mismatch assigns _methodMismatch405msg and uses continue (not break)', function() {
        // Must assign message then continue scanning — not break
        // Find the specific mismatch assignment (not the initialisation = null)
        var assignStr = "_methodMismatch405msg = 'Method Not Allowed";
        var idx = src.indexOf(assignStr);
        assert.ok(idx >= 0, 'server.js must set _methodMismatch405msg on method mismatch');
        // `continue` must appear within ~200 chars after the assignment
        var context = src.slice(idx, idx + 250);
        assert.ok(/continue/.test(context),
            'method mismatch assignment must be followed by continue (not break)');
    });

    it('does NOT have a bare break immediately after method mismatch assignment', function() {
        // Old code had: throwError(405) + break; new code: assign message + continue
        var assignStr = "_methodMismatch405msg = 'Method Not Allowed";
        var lines = src.split('\n');
        var mismatchLine = lines.findIndex(function(l) { return l.indexOf(assignStr) >= 0; });
        assert.ok(mismatchLine >= 0, 'mismatch assignment line not found');
        // Next non-blank line must be `continue`, not `break` or `throwError`
        var next = lines.slice(mismatchLine + 1).find(function(l) { return /\S/.test(l); }) || '';
        assert.ok(/\bcontinue\b/.test(next), 'line after mismatch assignment must be continue, got: ' + next.trim());
        assert.ok(!/\bbreak\b/.test(next), 'line after mismatch assignment must not be break');
    });

    it('404 check after loop only fires when no match AND no method mismatch was recorded', function() {
        // The 405 guard must come BEFORE the generic 404
        var idx405 = src.indexOf('if (!matched && _methodMismatch405msg)');
        var idx404 = src.indexOf("throwError(res, 404, 'Page not found");
        assert.ok(idx405 >= 0, '405 guard not found in server.js');
        assert.ok(idx404 >= 0, '404 handler not found in server.js');
        assert.ok(idx405 < idx404, '405 guard must come before generic 404');
    });
});


// ─── 11 — inline logic: method-routing 405 after full scan ────────────────────

describe('11 - method-routing fix: inline scan logic', function() {

    /**
     * Minimal replica of the server.js routing loop that implements the fix:
     * – continue on method mismatch (not break)
     * – emit 405 only if no route matched AND a method mismatch was recorded
     */
    function runScan(routes, reqMethod, reqUrl) {
        var matched = false;
        var _methodMismatch405msg = null;

        for (var name in routes) {
            var route = routes[name];
            if (route.url !== reqUrl) continue;            // URL doesn't match
            if (route.method !== reqMethod) {
                // method mismatch — record but KEEP scanning
                _methodMismatch405msg = 'Method Not Allowed';
                continue;
            }
            matched = true;
            break;
        }

        if (!matched && _methodMismatch405msg) return { status: 405, matched: false };
        if (!matched)                           return { status: 404, matched: false };
        return { status: 200, matched: true };
    }

    it('GET /notes matches list-notes and returns 200', function() {
        var routes = {
            'list-notes':   { url: '/notes', method: 'GET' },
            'create-note':  { url: '/notes', method: 'POST' }
        };
        assert.deepEqual(runScan(routes, 'GET',  '/notes'), { status: 200, matched: true });
    });

    it('POST /notes matches create-note and returns 200 (GET rule does not break the scan)', function() {
        var routes = {
            'list-notes':   { url: '/notes', method: 'GET' },
            'create-note':  { url: '/notes', method: 'POST' }
        };
        assert.deepEqual(runScan(routes, 'POST', '/notes'), { status: 200, matched: true });
    });

    it('PUT /notes returns 405 when only GET and POST are declared', function() {
        var routes = {
            'list-notes':   { url: '/notes', method: 'GET' },
            'create-note':  { url: '/notes', method: 'POST' }
        };
        assert.deepEqual(runScan(routes, 'PUT',  '/notes'), { status: 405, matched: false });
    });

    it('GET /unknown returns 404 (no URL match at all, not 405)', function() {
        var routes = {
            'list-notes':   { url: '/notes', method: 'GET' },
            'create-note':  { url: '/notes', method: 'POST' }
        };
        assert.deepEqual(runScan(routes, 'GET',  '/unknown'), { status: 404, matched: false });
    });

    it('DELETE /notes returns 405 after scanning all three routes', function() {
        var routes = {
            'r1': { url: '/notes', method: 'GET' },
            'r2': { url: '/notes', method: 'POST' },
            'r3': { url: '/notes', method: 'PUT' }
        };
        assert.deepEqual(runScan(routes, 'DELETE', '/notes'), { status: 405, matched: false });
    });

    it('first route method mismatch does NOT stop the scan — second route with correct method wins', function() {
        // This is the core regression: old `break` would stop after the GET mismatch
        var routes = {
            'wrong-method': { url: '/api', method: 'GET' },
            'correct':      { url: '/api', method: 'POST' }
        };
        assert.deepEqual(runScan(routes, 'POST', '/api'), { status: 200, matched: true });
    });
});


// ─── 12 — body parser: '+' → space decoding for application/x-www-form-urlencoded ───

describe("12 - body parser: '+' → space decoding for application/x-www-form-urlencoded", function() {

    var src;
    before(function() { src = fs.readFileSync(SERVER_SRC, 'utf8'); });

    // Source-level pins: confirm the urlencoded test fires WHEN content-type IS urlencoded
    // (no leading ! on the inner test) at all three sites — POST, PUT, PATCH branches.

    it('POST branch: urlencoded test fires WHEN content-type IS urlencoded (no leading !)', function() {
        var postCase = src.slice(src.indexOf("case 'post':"), src.indexOf("case 'put':"));
        assert.match(
            postCase,
            /if\s*\(\s*\/application\\\/x\\-www\\-form\\-urlencoded\/\.test\(request\.headers\['content-type'\]\)\s*&&\s*\/\\\+\/\.test\(request\.body\)\s*\)/,
            'POST branch must check IS urlencoded (no leading !) and short-circuit on absent + char'
        );
    });

    it('PUT branch: urlencoded test fires WHEN content-type IS urlencoded (no leading !)', function() {
        var putCase = src.slice(src.indexOf("case 'put':"), src.indexOf("case 'delete':"));
        assert.match(
            putCase,
            /if\s*\(\s*\/application\\\/x\\-www\\-form\\-urlencoded\/\.test\(request\.headers\['content-type'\]\)\s*\)/,
            'PUT branch must check IS urlencoded (no leading !)'
        );
    });

    it('PATCH branch: urlencoded test fires WHEN content-type IS urlencoded (no leading !)', function() {
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.match(
            patchCase,
            /if\s*\(\s*\/application\\\/x\\-www\\-form\\-urlencoded\/\.test\(request\.headers\['content-type'\]\)\s*&&\s*\/\\\+\/\.test\(request\.body\)\s*\)/,
            'PATCH branch must check IS urlencoded (no leading !) and short-circuit on absent + char'
        );
    });

    // Negative-invariant lock: no inverted shape remains anywhere in server.js.
    it('no inverted (!/...urlencoded.../) tests remain in server.js', function() {
        var inverted = src.match(/!\s*\/application\\\/x\\-www\\-form\\-urlencoded\/\.test/g) || [];
        assert.strictEqual(inverted.length, 0, 'inverted urlencoded tests must not return — would re-introduce the +→space spec inversion');
    });

    // Pure-logic replica of the corrected body-parser transform shared across
    // POST/PUT/PATCH branches: the gated +→space step and the leading-? strip. Since
    // #B588 the site hands the body to the data helper VERBATIM — the helper decodes
    // each key and value exactly once, after the split — so the replica no longer
    // decodes (it used to model the whole-body decode #B588 removed).
    function parseBodyAfterFix(body, contentType) {
        if (typeof body !== 'string') return body;
        if (/multipart\/form-data;/.test(contentType || '')) return body;
        if (/application\/x-www-form-urlencoded/.test(contentType || '')) {
            body = body.replace(/\+/g, ' ');
        }
        if (body.substring(0, 1) === '?') body = body.substring(1);
        return body;
    }

    // The real data helper, for the arms that follow a %20 through to the parsed object
    // (same idiom as §19 below and test/lib/format-data-from-string.test.js).
    require(path.join(FW, 'helpers', 'data', 'src', 'main'))();
    var formatDataFromString = global.formatDataFromString;

    // Positive cases — urlencoded path

    it("urlencoded body 'name=Hello+World' decodes to 'name=Hello World'", function() {
        var bodyStr = parseBodyAfterFix('name=Hello+World', 'application/x-www-form-urlencoded');
        assert.strictEqual(bodyStr, 'name=Hello World');
    });

    it("urlencoded body 'name=Hello%20World': the site leaves %20 in place, the data helper decodes it once (#B588)", function() {
        var bodyStr = parseBodyAfterFix('name=Hello%20World', 'application/x-www-form-urlencoded');
        assert.strictEqual(bodyStr, 'name=Hello%20World');
        assert.deepEqual(formatDataFromString(bodyStr), { name: 'Hello World' });
    });

    it('urlencoded body: + becomes a space at the site, %20 in the helper — both reach the app as a space', function() {
        var bodyStr = parseBodyAfterFix('a=Hello+World&b=Hi%20there', 'application/x-www-form-urlencoded');
        assert.strictEqual(bodyStr, 'a=Hello World&b=Hi%20there');
        assert.deepEqual(formatDataFromString(bodyStr), { a: 'Hello World', b: 'Hi there' });
    });

    it('URLSearchParams.toString() output → urlencoded branch yields decoded space', function() {
        var params = new URLSearchParams({ name: 'Hello World' });
        // URLSearchParams.toString() encodes space as '+'
        assert.ok(/\+/.test(params.toString()), 'URLSearchParams must encode space as +');
        var bodyStr = parseBodyAfterFix(params.toString(), 'application/x-www-form-urlencoded');
        assert.strictEqual(bodyStr, 'name=Hello World');
    });

    // Negative cases — non-urlencoded paths preserve literal '+'

    it("JSON body '{\"version\":\"1.0+rc1\"}' is preserved (no '+' → space replacement)", function() {
        var bodyStr = parseBodyAfterFix('{"version":"1.0+rc1"}', 'application/json');
        assert.strictEqual(bodyStr, '{"version":"1.0+rc1"}');
    });

    it("JSON body parsed: literal '+' survives to the controller", function() {
        var bodyStr = parseBodyAfterFix('{"version":"1.0+rc1"}', 'application/json');
        var obj = JSON.parse(bodyStr);
        assert.strictEqual(obj.version, '1.0+rc1');
    });

    it("multipart body: '+' is left untouched (multipart guard skips the inner branch)", function() {
        var bodyStr = parseBodyAfterFix('name=Hello+World', 'multipart/form-data; boundary=----abc');
        assert.strictEqual(bodyStr, 'name=Hello+World');
    });

    it("text/plain body: '+' is preserved (not urlencoded, no replacement)", function() {
        var bodyStr = parseBodyAfterFix('Hello+World', 'text/plain');
        assert.strictEqual(bodyStr, 'Hello+World');
    });

    it("missing content-type header: '+' is preserved (defensive — no replacement without explicit urlencoded)", function() {
        var bodyStr = parseBodyAfterFix('Hello+World', undefined);
        assert.strictEqual(bodyStr, 'Hello+World');
    });
});


// ─── 13 — body parser: application/json parsed verbatim (no decode, no coercion) — #B28 ───

describe('13 - body parser: application/json verbatim parse (no url-decode, no coercion) — #B28', function() {

    var src;
    before(function() { src = fs.readFileSync(SERVER_SRC, 'utf8'); });

    // Source-level pins: each of POST/PUT/PATCH must branch on application/json
    // and JSON.parse the raw request.body (bypassing decodeURIComponent + the
    // "true"/"false"/"on"/"null" coercion + formatDataFromString bracket-expansion).

    it('POST branch: has an application/json check that JSON.parse(request.body) verbatim', function() {
        var postCase = src.slice(src.indexOf("case 'post':"), src.indexOf("case 'put':"));
        assert.match(postCase, /\/application\\\/json\/i\.test\(request\.headers\['content-type'\]\)/,
            'POST must branch on application/json');
        assert.match(postCase, /obj\s*=\s*JSON\.parse\(request\.body\)/,
            'POST json branch must JSON.parse(request.body) verbatim');
    });

    it('PUT branch: has an application/json check that JSON.parse(request.body) verbatim', function() {
        var putCase = src.slice(src.indexOf("case 'put':"), src.indexOf("case 'delete':"));
        assert.match(putCase, /\/application\\\/json\/i\.test\(request\.headers\['content-type'\]\)/,
            'PUT must branch on application/json');
        assert.match(putCase, /obj\s*=\s*JSON\.parse\(request\.body\)/,
            'PUT json branch must JSON.parse(request.body) verbatim');
    });

    it('PATCH branch: has an application/json check that JSON.parse(request.body) verbatim', function() {
        var patchCase = src.slice(src.indexOf("case 'patch':"), src.indexOf("case 'head':"));
        assert.match(patchCase, /\/application\\\/json\/i\.test\(request\.headers\['content-type'\]\)/,
            'PATCH must branch on application/json');
        assert.match(patchCase, /obj\s*=\s*JSON\.parse\(request\.body\)/,
            'PATCH json branch must JSON.parse(request.body) verbatim');
    });

    // The json branch must NOT route application/json through formatDataFromString
    // (that helper is the one that double-decodes + coerces). Pin it stays only on
    // the urlencoded / GET / HEAD paths, never inside an application/json branch.
    it('the application/json branches do not call formatDataFromString, and decode only as a fallback', function() {
        // For each method, the substring between the application/json test and the
        // closing of its branch (the `} else {`) must not contain formatDataFromString.
        // #B28 intent preserved: the FIRST parse attempt is verbatim JSON.parse(request.body)
        // — no url-decode on the happy path, so valid JSON (incl. a %XX inside a string value)
        // is never double-decoded. A decodeURIComponent fallback is allowed ONLY after the
        // verbatim attempt throws — that tolerates a percent-encoded JSON body emitted by the
        // framework's own client (the self.query() self-consistency fix), never a raw-JSON body.
        ['post', 'put', 'patch'].forEach(function(m) {
            var nextCase = { post: 'put', put: 'delete', patch: 'head' }[m];
            var caseSrc  = src.slice(src.indexOf("case '" + m + "':"), src.indexOf("case '" + nextCase + "':"));
            var jsonIdx  = caseSrc.indexOf("/application\\/json/i.test");
            assert.ok(jsonIdx >= 0, m + ' must have an application/json branch');
            var branch   = caseSrc.slice(jsonIdx, caseSrc.indexOf('} else {', jsonIdx));
            assert.doesNotMatch(branch, /formatDataFromString/,
                m + ' json branch must not call formatDataFromString');
            var verbatimIdx = branch.indexOf('JSON.parse(request.body)');
            var decodeIdx   = branch.indexOf('decodeURIComponent');
            assert.ok(verbatimIdx >= 0,
                m + ' json branch must JSON.parse(request.body) verbatim on the happy path');
            if (decodeIdx >= 0) {
                assert.ok(decodeIdx > verbatimIdx,
                    m + ' json branch may only decodeURIComponent as a fallback AFTER the verbatim parse');
            }
        });
    });

    // Pure-logic replicas: the NEW json branch (verbatim) vs the LEGACY decode+coerce
    // path that application/json bodies wrongly flowed through before #B28.

    function parseJsonBranch(body) {
        // #B28 — application/json: verbatim, no decodeURIComponent, no coercion
        return JSON.parse(body);
    }

    function legacyDecodeCoerce(body) {
        // the pre-#B28 path: decodeURIComponent + "true"/"false"/"on"/"null" coercion
        var bodyStr;
        try { bodyStr = decodeURIComponent(body); } catch (e) { bodyStr = body; }
        bodyStr = bodyStr
            .replace(/"false"/g, false)
            .replace(/"true"/g, true)
            .replace(/"on"/g, true)
            .replace(/"null"/ig, null);
        return JSON.parse(bodyStr);
    }

    it('%XX inside a JSON string value is PRESERVED (was corrupted by decodeURIComponent)', function() {
        assert.strictEqual(parseJsonBranch('{"v":"50%20off"}').v, '50%20off',
            'json branch must not url-decode %XX inside a string value');
        // contrast: the legacy decode path is exactly what corrupted it
        assert.strictEqual(legacyDecodeCoerce('{"v":"50%20off"}').v, '50 off',
            'sanity: legacy decodeURIComponent turned 50%20off into "50 off"');
    });

    it('a JSON string value "true" stays the string "true" (was coerced to boolean)', function() {
        var v = parseJsonBranch('{"active":"true"}');
        assert.strictEqual(v.active, 'true');
        assert.strictEqual(typeof v.active, 'string');
        assert.strictEqual(legacyDecodeCoerce('{"active":"true"}').active, true);
    });

    it('a JSON string value "false" stays the string "false"', function() {
        assert.strictEqual(parseJsonBranch('{"active":"false"}').active, 'false');
        assert.strictEqual(legacyDecodeCoerce('{"active":"false"}').active, false);
    });

    it('a JSON string value "null" stays the string "null" (was coerced to null)', function() {
        assert.strictEqual(parseJsonBranch('{"x":"null"}').x, 'null');
        assert.strictEqual(legacyDecodeCoerce('{"x":"null"}').x, null);
    });

    it('real JSON types are preserved verbatim (boolean, number, null, nested object)', function() {
        var v = parseJsonBranch('{"b":true,"n":42,"z":null,"o":{"k":"v"}}');
        assert.strictEqual(v.b, true);
        assert.strictEqual(v.n, 42);
        assert.strictEqual(v.z, null);
        assert.deepEqual(v.o, { k: 'v' });
    });

    it('a literal bracket-notation JSON key is preserved (no form-style expansion)', function() {
        var v = parseJsonBranch('{"a[b]":1}');
        assert.deepEqual(v, { 'a[b]': 1 });
        assert.ok('a[b]' in v, 'json branch keeps the literal key, does not expand a[b] → {a:{b}}');
    });

    it('a literal + in a JSON string value is preserved', function() {
        assert.strictEqual(parseJsonBranch('{"v":"1.0+rc1"}').v, '1.0+rc1');
    });
});


// ─── 14 — body parser: application/json tolerant parse (verbatim first, decode fallback) ───
//
// The framework's own server-to-server client (controller.js this.query) historically
// percent-encoded application/json bodies (encodeRFC5987ValueChars(JSON.stringify(data))),
// while the #B28 server parses them verbatim — so the framework emitted bodies its own
// parser rejected (POST/PATCH 500, PUT silent body loss). The server now tries the verbatim
// JSON.parse first and falls back to a single decodeURIComponent only when that throws, so a
// percent-encoded body is tolerated WITHOUT double-decoding a genuine raw-JSON body.

describe('14 - body parser: application/json tolerant parse (verbatim first, decode fallback)', function() {

    var src;
    before(function() { src = fs.readFileSync(SERVER_SRC, 'utf8'); });

    // Faithful replica of helpers/data/src/main.js encodeRFC5987ValueChars — what the
    // client actually emitted for a json/text/x-www-form PUT/POST body.
    function encodeRFC5987ValueChars(str) {
        return encodeURIComponent(str)
            .replace(/['()]/g, escape)
            .replace(/\*/g, '%2A')
            .replace(/%(?:7C|60|5E)/g, unescape);
    }

    // Pure-logic replica of the new application/json branch: verbatim first, decode fallback.
    function parseJsonTolerant(body) {
        try { return JSON.parse(body); }
        catch (e) { return JSON.parse(decodeURIComponent(body)); }
    }

    // ── source pins: each json branch keeps the verbatim parse and adds the fallback ──
    ['post', 'put', 'patch'].forEach(function(m) {
        it(m.toUpperCase() + ' json branch: verbatim parse first, decodeURIComponent fallback after it', function() {
            var nextCase = { post: 'put', put: 'delete', patch: 'head' }[m];
            var caseSrc  = src.slice(src.indexOf("case '" + m + "':"), src.indexOf("case '" + nextCase + "':"));
            var jsonIdx  = caseSrc.indexOf("/application\\/json/i.test");
            assert.ok(jsonIdx >= 0, m + ' must have an application/json branch');
            var branch   = caseSrc.slice(jsonIdx, caseSrc.indexOf('} else {', jsonIdx));
            var verbatimIdx = branch.indexOf('JSON.parse(request.body)');
            var fallbackIdx = branch.indexOf('JSON.parse(decodeURIComponent(request.body))');
            assert.ok(verbatimIdx >= 0, m + ' json branch must JSON.parse(request.body) verbatim');
            assert.ok(fallbackIdx > verbatimIdx,
                m + ' json branch must JSON.parse(decodeURIComponent(request.body)) only as a fallback after the verbatim parse');
        });
    });

    it('POST/PATCH still 500 on total parse failure; PUT still warn-only (no throwError in its json branch)', function() {
        function jsonBranch(m) {
            var nextCase = { post: 'put', put: 'delete', patch: 'head' }[m];
            var caseSrc  = src.slice(src.indexOf("case '" + m + "':"), src.indexOf("case '" + nextCase + "':"));
            var jsonIdx  = caseSrc.indexOf("/application\\/json/i.test");
            return caseSrc.slice(jsonIdx, caseSrc.indexOf('} else {', jsonIdx));
        }
        assert.match(jsonBranch('post'),  /throwError\(response, 500,/, 'POST json branch must 500 when both attempts fail');
        assert.match(jsonBranch('patch'), /throwError\(response, 500,/, 'PATCH json branch must 500 when both attempts fail');
        assert.doesNotMatch(jsonBranch('put'), /throwError/, 'PUT json branch stays warn-only (asymmetric, unchanged)');
        assert.match(jsonBranch('put'), /console\.warn/, 'PUT json branch warns on total failure');
    });

    // ── behavioural replicas ──

    it('a percent-encoded JSON body (the client emitted form) parses to the right object', function() {
        var wire = encodeRFC5987ValueChars(JSON.stringify({ a: 1, b: 'x' }));
        assert.match(wire, /^%7B/, 'sanity: the encoded wire body starts percent-encoded, not raw JSON');
        assert.deepEqual(parseJsonTolerant(wire), { a: 1, b: 'x' });
    });

    it('regression — a raw JSON body still parses (verbatim attempt wins)', function() {
        assert.deepEqual(parseJsonTolerant('{"a":1}'), { a: 1 });
        assert.deepEqual(parseJsonTolerant('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
    });

    it('regression — #B28 intent preserved: %XX inside a raw-JSON string value is NOT double-decoded', function() {
        // Valid JSON parses on the verbatim attempt, so the fallback never runs and %20 survives.
        assert.strictEqual(parseJsonTolerant('{"u":"x%20y"}').u, 'x%20y',
            'a raw-JSON %XX must stay literal — the fallback must not touch valid JSON');
    });

    it('regression — a real-typed raw JSON body is preserved verbatim', function() {
        var v = parseJsonTolerant('{"b":true,"n":42,"z":null,"o":{"k":"v"}}');
        assert.strictEqual(v.b, true);
        assert.strictEqual(v.n, 42);
        assert.strictEqual(v.z, null);
        assert.deepEqual(v.o, { k: 'v' });
    });

    it('a genuinely malformed body still throws (→ 500 for POST/PATCH) — both attempts fail', function() {
        assert.throws(function() { parseJsonTolerant('%%%'); }, 'malformed: verbatim throws, decodeURIComponent throws');
        assert.throws(function() { parseJsonTolerant('not json'); }, 'plain text: both attempts fail');
    });
});


// ─── 15 — client this.query: application/json body is raw JSON, not RFC5987-encoded ───
//
// Root-cause half of the self-consistency fix: this.query must send the body as raw
// JSON.stringify(data) for the application/json path (the wire content-type is forced to
// application/json), NOT encodeRFC5987ValueChars(JSON.stringify(data)). RFC5987 value-encoding
// is for HTTP header values, not request bodies.

describe('15 - client this.query: application/json body is raw JSON (not RFC5987-encoded)', function() {

    var src;
    before(function() { src = fs.readFileSync(CONTROLLER_SRC, 'utf8'); });

    // The PUT/POST json body branch lives between the `['put', 'post'].indexOf(...)` test and
    // its closing `} else {` (the urlencoded-into-path branch).
    function jsonBodyBranch() {
        var i = src.indexOf("['put', 'post'].indexOf(options.method.toLowerCase())");
        assert.ok(i >= 0, 'this.query must have the PUT/POST content-type body branch');
        return src.slice(i, src.indexOf('} else {', i));
    }

    it('sends queryData = JSON.stringify(data) for the application/json body', function() {
        assert.match(jsonBodyBranch(), /queryData\s*=\s*JSON\.stringify\(data\)/,
            'the json body branch must assign raw JSON.stringify(data)');
    });

    it('does NOT wrap the application/json body in encodeRFC5987ValueChars', function() {
        assert.doesNotMatch(jsonBodyBranch(), /encodeRFC5987ValueChars\(JSON\.stringify\(data\)\)/,
            'the json body must not be percent-encoded — it produced a body the server rejected');
    });

    // ── round-trip: the body the client now emits parses through the new server branch ──

    function parseJsonTolerant(body) {
        try { return JSON.parse(body); }
        catch (e) { return JSON.parse(decodeURIComponent(body)); }
    }

    it('the raw-JSON body the client now emits round-trips through the server parser', function() {
        var data = { a: 1, b: 'x', nested: { k: 'v' } };
        var wire = JSON.stringify(data); // what this.query now puts on the wire
        assert.deepEqual(parseJsonTolerant(wire), data);
    });

    it('version-skew safety: an already-deployed encoded sender also still round-trips (A complements B)', function() {
        function encodeRFC5987ValueChars(str) {
            return encodeURIComponent(str)
                .replace(/['()]/g, escape)
                .replace(/\*/g, '%2A')
                .replace(/%(?:7C|60|5E)/g, unescape);
        }
        var data = { a: 1, b: 'x' };
        var legacyWire = encodeRFC5987ValueChars(JSON.stringify(data)); // old client form
        assert.deepEqual(parseJsonTolerant(legacyWire), data);
    });
});


// ─── 16 — server.js: request.rawBody snapshot for HMAC webhook verification ───
//
// Inbound webhooks that authenticate by an HMAC over the exact raw request bytes need the
// unparsed body. The non-multipart end-of-stream handler now snapshots request.rawBody from
// the fully-accumulated request.body BEFORE processRequestData mutates it into the parsed
// object. Always-on (a reference assignment); the multipart/Busboy path never reaches it.

describe('16 - server.js: request.rawBody snapshot before processRequestData', function() {

    var crypto = require('node:crypto');
    var src;
    before(function() { src = fs.readFileSync(SERVER_SRC, 'utf8'); });

    // ── source pins ──

    it('the onEnd handler assigns request.rawBody before calling processRequestData', function() {
        var endIdx = src.indexOf('function onEnd()');
        assert.ok(endIdx >= 0, 'the non-multipart end-of-stream handler must exist');
        var handler = src.slice(endIdx, src.indexOf('});', endIdx));
        var rawIdx     = handler.indexOf('request.rawBody');
        var processIdx = handler.indexOf('processRequestData(request, response, next)');
        assert.ok(rawIdx >= 0, 'onEnd must snapshot request.rawBody');
        assert.ok(processIdx >= 0, 'onEnd must call processRequestData');
        assert.ok(rawIdx < processIdx, 'the rawBody snapshot must happen BEFORE processRequestData mutates request.body');
    });

    it('the snapshot is string-guarded (empty body → empty string, never the {} init object)', function() {
        var endIdx  = src.indexOf('function onEnd()');
        var handler = src.slice(endIdx, src.indexOf('});', endIdx));
        assert.match(handler, /request\.rawBody\s*=\s*\(\s*typeof\s+request\.body\s*===?\s*'string'\s*\)\s*\?\s*request\.body\s*:\s*''/,
            'rawBody must be the accumulated string, or "" when body was empty/object');
    });

    it('there is exactly one rawBody snapshot, and it lives on the non-multipart path (after request.pipe(busboy))', function() {
        var count = (src.match(/request\.rawBody\s*=/g) || []).length;
        assert.strictEqual(count, 1, 'exactly one rawBody snapshot site');
        var busboyIdx = src.indexOf('request.pipe(busboy)');
        var rawIdx    = src.indexOf('request.rawBody =');
        assert.ok(busboyIdx >= 0 && rawIdx > busboyIdx,
            'the snapshot is in the non-multipart else branch — the multipart/Busboy path is unaffected');
    });

    // ── behavioural replica of the data-accumulation + snapshot ──

    // Mirrors server.js: request.body inits to {} (request init), the data handler resets it
    // to '' on the first chunk and appends chunk.toString(), then onEnd snapshots rawBody.
    function accumulateAndSnapshot(chunks) {
        var request = { body: {} };
        chunks.forEach(function(chunk) {
            if (typeof request.body === 'object') { request.body = ''; }
            request.body += chunk;
        });
        request.rawBody = (typeof request.body === 'string') ? request.body : '';
        return request;
    }

    it('rawBody equals the exact bytes sent (pre-parse) and the body still parses normally', function() {
        var raw = '{"event":"thing.updated","id":42,"v":"x%20y"}';
        var req = accumulateAndSnapshot([raw]);
        assert.strictEqual(req.rawBody, raw, 'rawBody is the exact unparsed bytes');
        // a subsequent JSON.parse (what processRequestData does for application/json) still works
        var parsed = JSON.parse(req.rawBody);
        assert.strictEqual(parsed.id, 42);
        assert.strictEqual(parsed.v, 'x%20y', 'the raw bytes are untouched — %XX preserved');
    });

    it('rawBody is reassembled across multiple chunks', function() {
        var req = accumulateAndSnapshot(['{"a":', '1,"b":', '"two"}']);
        assert.strictEqual(req.rawBody, '{"a":1,"b":"two"}');
        assert.deepEqual(JSON.parse(req.rawBody), { a: 1, b: 'two' });
    });

    it('an empty body yields rawBody = "" (never the {} init object)', function() {
        var req = accumulateAndSnapshot([]);
        assert.strictEqual(req.rawBody, '');
    });

    it('HMAC round-trip: a signature recomputed over rawBody matches the sender signature', function() {
        var secret  = 'a-shared-webhook-secret';
        var rawBody = JSON.stringify({ event: 'invoice.paid', id: 'abc123', amount: 1000 });
        // sender signs the exact bytes it transmits
        var sentSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        // server snapshots rawBody and recomputes
        var req = accumulateAndSnapshot([rawBody]);
        var recomputed = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
        assert.strictEqual(recomputed, sentSig, 'HMAC over req.rawBody must match the sender signature');
        // and the parsed body remains available to the controller
        assert.deepEqual(JSON.parse(req.rawBody), { event: 'invoice.paid', id: 'abc123', amount: 1000 });
    });

    it('subtract-my-contribution: rawBody is required — signing the re-stringified parse does not match', function() {
        var secret = 'a-shared-webhook-secret';
        // a body whose formatting would NOT survive a parse → stringify round-trip
        var rawBody = '{ "a" : 1 }';
        var sentSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

        var req = accumulateAndSnapshot([rawBody]);

        // correct path: HMAC over the preserved raw bytes matches the sender
        var overRaw = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
        assert.strictEqual(overRaw, sentSig, 'HMAC over rawBody matches the sender signature');

        // wrong path: HMAC over the re-stringified parsed object differs (whitespace lost)
        var reStringified = JSON.stringify(JSON.parse(req.rawBody)); // '{"a":1}'
        assert.notStrictEqual(reStringified, rawBody, 'sanity: parse→stringify changed the bytes');
        var overParsed = crypto.createHmac('sha256', secret).update(reStringified).digest('hex');
        assert.notStrictEqual(overParsed, sentSig,
            'without rawBody, a signature over the parsed-then-restringified object would fail verification');
    });
});


// ─── 17 — GET/HEAD query decode: malformed-% crash-safety (#B30) ──────────────
//
// processRequestData's GET and HEAD branches build the template context from
// request.query (and its `inheritedData` member). That value is ALREADY
// percent-decoded once by the engine query parser, and formatDataFromString
// performs its OWN guarded internal decode — so the prior explicit
// decodeURIComponent was a redundant SECOND decode that threw URIError (→
// uncaught → bundle crash) whenever a literal '%' survived the first decode
// (e.g. inheritedData carrying {"x":"50%off"}). #B30 drops the redundant decode
// at all four GET/HEAD sites; the genuine first-decode sites (isaac query parse,
// static-asset path) are guarded by safeDecodeURIComponent instead. Behavioural
// coverage of the helper + formatDataFromString crash-safety lives in
// test/lib/format-data-from-string.test.js; the isaac parser in
// test/core/server.isaac.test.js § 10.

describe('17 - GET/HEAD query decode: malformed-% crash-safety (#B30)', function() {

    var src, helperSrc, getCaseLive, headCaseLive;

    // Strip full-line // comments so the negative pins don't trip on the
    // `// was:` commented-out old code (jsdoc.md § "A negative source-inspection
    // pin trips on the file's own ... comment").
    function stripComments(block) {
        return block.split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n');
    }

    before(function() {
        src       = fs.readFileSync(SERVER_SRC, 'utf8');
        helperSrc = fs.readFileSync(path.join(FW, 'helpers/data/src/main.js'), 'utf8');
        var getCase  = src.slice(src.indexOf("case 'get':"), src.indexOf("case 'put':"));
        var headIdx  = src.indexOf("case 'head':");
        var headCase = src.slice(headIdx, src.indexOf('loadBundleConfiguration', headIdx));
        getCaseLive  = stripComments(getCase);
        headCaseLive = stripComments(headCase);
    });

    // ── the shared helper ──

    it('helpers/data defines a safeDecodeURIComponent global with try/decode/fallback-to-raw', function() {
        assert.match(helperSrc, /safeDecodeURIComponent\s*=\s*function\s*\(\s*str\s*\)\s*\{/);
        var fn = helperSrc.slice(helperSrc.indexOf('safeDecodeURIComponent = function'));
        fn = fn.slice(0, fn.indexOf('};') + 2);
        assert.match(fn, /try\s*\{[\s\S]*?return decodeURIComponent\(str\)/);
        assert.match(fn, /catch[\s\S]*?return str/);
    });

    // ── GET: redundant explicit decode dropped ──

    it('GET inheritedData: formatDataFromString(request.query.inheritedData) WITHOUT an explicit decode', function() {
        assert.match(getCaseLive, /inheritedDataObj\s*=\s*formatDataFromString\(request\.query\.inheritedData\)/);
        assert.doesNotMatch(getCaseLive, /formatDataFromString\(decodeURIComponent\(request\.query\.inheritedData\)\)/);
    });

    it('GET query bodyStr: formatDataFromString(bodyStr) WITHOUT an explicit decode', function() {
        assert.match(getCaseLive, /obj\s*=\s*formatDataFromString\(bodyStr\)/);
        assert.doesNotMatch(getCaseLive, /formatDataFromString\(decodeURIComponent\(bodyStr\)\)/);
    });

    // ── HEAD: redundant explicit decode dropped (mirrors GET) ──

    it('HEAD inheritedData: formatDataFromString(request.query.inheritedData) WITHOUT an explicit decode', function() {
        assert.match(headCaseLive, /headInheritedDataObj\s*=\s*formatDataFromString\(request\.query\.inheritedData\)/);
        assert.doesNotMatch(headCaseLive, /formatDataFromString\(decodeURIComponent\(request\.query\.inheritedData\)\)/);
    });

    it('HEAD query bodyStr: formatDataFromString(bodyStr) WITHOUT an explicit decode', function() {
        assert.match(headCaseLive, /obj\s*=\s*formatDataFromString\(bodyStr\)/);
        assert.doesNotMatch(headCaseLive, /formatDataFromString\(decodeURIComponent\(bodyStr\)\)/);
    });

    // ── genuine first-decode sites guarded with safeDecodeURIComponent ──

    it('static-asset path (handleStatics) uses safeDecodeURIComponent(filename)', function() {
        assert.match(src, /filename\s*=\s*safeDecodeURIComponent\(\s*filename\s*\)/);
    });

    it('getAssetFilenameFromUrl (HTTP/2 static path) uses safeDecodeURIComponent(url)', function() {
        assert.match(src, /url\s*=\s*safeDecodeURIComponent\(\s*url\s*\)/);
    });

    // ── negative invariant: no LIVE redundant double-decode anywhere in server.js ──

    it('no live formatDataFromString(decodeURIComponent(...)) remains in server.js', function() {
        var live = stripComments(src);
        assert.doesNotMatch(live, /formatDataFromString\(decodeURIComponent/);
    });
});


// ─── 18 — decodeURI (whole-URI) crash-safety (#B30 review follow-up) ──────────
//
// Separate from decodeURIComponent: decodeURI (used across the routing + error
// paths with a `/// avoid %20` comment, to decode the URL/pathname without
// touching path separators) throws the SAME URIError on a malformed escape. An
// unguarded decodeURI of the request URL/pathname crashes the bundle the same
// way — and the site inside throwError (server.js error responder) even turns a
// would-be-graceful 404 on a malformed-% URL into a crash. #B30 routes every
// server-side decodeURI of attacker-controllable input through safeDecodeURI.
// Sites: server.js x3 (trie lookup, route params, throwError); lib/routing x4
// (cached params, routing.path x2, linear-scan params); controller.js x1 (error
// path). Behavioural coverage of safeDecodeURI lives in
// test/lib/format-data-from-string.test.js.

describe('18 - decodeURI (whole-URI) crash-safety (#B30 review follow-up)', function() {

    var serverSrc, routingSrc, controllerSrc, helperSrc;
    var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');

    function stripComments(s) {
        return s.split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n');
    }
    // bare decodeURI( NOT prefixed by a letter (so safeDecodeURI( is excluded;
    // decodeURIComponent( never matches — the char after decodeURI is 'C', not '(')
    var BARE_DECODE_URI = /(?<![A-Za-z])decodeURI\(/;

    before(function() {
        serverSrc     = fs.readFileSync(SERVER_SRC, 'utf8');
        routingSrc    = fs.readFileSync(ROUTING_SRC, 'utf8');
        controllerSrc = fs.readFileSync(CONTROLLER_SRC, 'utf8');
        helperSrc     = fs.readFileSync(path.join(FW, 'helpers/data/src/main.js'), 'utf8');
    });

    it('helpers/data defines safeDecodeURI with try/decodeURI/fallback-to-raw', function() {
        assert.match(helperSrc, /safeDecodeURI\s*=\s*function\s*\(\s*str\s*\)\s*\{/);
        var fn = helperSrc.slice(helperSrc.indexOf('safeDecodeURI = function'));
        fn = fn.slice(0, fn.indexOf('};') + 2);
        assert.match(fn, /try\s*\{[\s\S]*?return decodeURI\(str\)/);
        assert.match(fn, /catch[\s\S]*?return str/);
    });

    it('server.js: all 3 decodeURI sites use safeDecodeURI; no bare decodeURI remains', function() {
        var live = stripComments(serverSrc);
        var hits = (live.match(/safeDecodeURI\(/g) || []).length;
        assert.ok(hits >= 3, 'expected >=3 safeDecodeURI( calls in server.js, got ' + hits);
        assert.doesNotMatch(live, BARE_DECODE_URI, 'a bare (unguarded) decodeURI( would crash the bundle on a malformed %');
    });

    it('lib/routing: all 4 decodeURI sites use safeDecodeURI; no bare decodeURI remains', function() {
        var live = stripComments(routingSrc);
        var hits = (live.match(/safeDecodeURI\(/g) || []).length;
        assert.ok(hits >= 4, 'expected >=4 safeDecodeURI( calls in lib/routing, got ' + hits);
        assert.doesNotMatch(live, BARE_DECODE_URI);
    });

    it('controller.js: the error-path decodeURI uses safeDecodeURI(local.req.url); no bare decodeURI remains', function() {
        var live = stripComments(controllerSrc);
        assert.match(live, /safeDecodeURI\(local\.req\.url\)/);
        assert.doesNotMatch(live, BARE_DECODE_URI);
    });

    it('the throwError site (server.js) specifically routes through safeDecodeURI(local.request.url)', function() {
        var live = stripComments(serverSrc);
        assert.match(live, /var url\s*=\s*safeDecodeURI\(local\.request\.url\)/);
    });
});


// ─── 19 — #FIN1: XML request bodies reach the application verbatim ───────────
//
// The correctness claim here is a runtime VALUE (does the document survive
// byte-for-byte?), not a shape, so every pin below is backed by a behavioural
// arm driving the REAL formatDataFromString, each with a subtract control.
//
// Red-first validation was run during development as a one-off `git show HEAD:`
// harness comparing each pin against the pre-change bytes; it is deliberately
// NOT baked in here, because HEAD becomes the post-change tree the moment this
// lands and such an arm would then invert.

describe('19 - body parser: XML bodies reach the application verbatim (#FIN1)', function() {
    var src, live;

    // helpers/data exposes formatDataFromString as an implicit global once the
    // DataHelper constructor runs — same idiom as test/lib/format-data-from-string.test.js.
    require(path.join(FW, 'helpers', 'data', 'src', 'main'))();
    var formatDataFromString = global.formatDataFromString;
    // utils/prototypes installs Object.prototype.count(), which the shared
    // POST/PATCH tail calls. The replica mirrors the source, so it needs it too.
    require(path.join(FW, '..', '..', 'utils', 'prototypes'));

    function stripComments(s) {
        return s.split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n');
    }

    // Lift the SHIPPED matcher out of the source rather than retyping it: a
    // retyped copy could drift from what actually ships, and the table below
    // would then certify a regex nobody runs.
    function shippedXmlMatcher(source) {
        var m = source.match(/request\.isXmlBody\s*=\s*\/([\s\S]*?)\/i\.test\(/);
        assert.ok(m, 'could not lift the #FIN1 content-type matcher out of server.js');
        return new RegExp(m[1], 'i');
    }

    // Faithful replica of the POST string-body branch (processRequestData),
    // including the shared tail. `subtractArm` disables ONLY the #FIN1 arm,
    // reproducing the pre-fix path while leaving everything else intact — a
    // syntax-breaking subtract would discriminate nothing.
    function postBranch(rawBody, contentType, opts) {
        opts = opts || {};
        var XML     = shippedXmlMatcher(src);
        var request = {
            body        : rawBody,
            rawBody     : rawBody,
            headers     : { 'content-type': contentType },
            isMultipart : false
        };
        request.isXmlBody = opts.subtractArm ? false : XML.test(contentType || '');

        var obj = null, bodyStr = null;

        if ( !request.isMultipart ) {
            if ( /application\/json/i.test(contentType) ) {
                obj = JSON.parse(request.body);
                request.post = obj;
            } else if ( request.isXmlBody ) {
                obj = {};                                  // ← the #FIN1 arm
            } else {
                if ( /application\/x\-www\-form\-urlencoded/.test(contentType) && /\+/.test(request.body) ) {
                    request.body = request.body.replace(/\+/g, ' ');
                }
                if ( request.body.substring(0,1) == '?' ) {
                    request.body = request.body.substring(1);
                }
                // #B588 — verbatim body: the site no longer decodes it as a whole nor runs the
                // quoted-token pass (the helper decodes once per pair; the casting is a document feature)
                bodyStr = request.body;
                obj = formatDataFromString(bodyStr);
                request.post = obj;
            }
        }
        // Shared tail, verbatim from server.js. `typeof null === 'object'`, which
        // is exactly why the arm above must set an object rather than leave null.
        if ( typeof(obj) == 'object' && obj.count() > 0 ) {
            request.body = request.post = obj;
        }
        return request;
    }

    var ISO20022 = '<?xml version="1.0" encoding="UTF-8"?>'
                 + '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">'
                 + '<CstmrCdtTrfInitn><GrpHdr><MsgId>MSG-001</MsgId></GrpHdr>'
                 + '<Amt Ccy="EUR">123.45</Amt><Note>50% off &amp; more</Note>'
                 + '</CstmrCdtTrfInitn></Document>';

    before(function() {
        src  = fs.readFileSync(SERVER_SRC, 'utf8');
        live = stripComments(src);
    });

    // ── 19a — structural pins (comment-stripped: the new block comments quote
    //          several of these tokens deliberately, per the anchor-theft trap) ──

    it('the content-type matcher is defined at exactly ONE site (the #B103 single-flag lesson)', function() {
        var hits = (live.match(/request\.isXmlBody\s*=/g) || []).length;
        assert.equal(hits, 1, 'expected exactly 1 matcher definition, got ' + hits);
    });

    it('all three body branches (POST/PUT/PATCH) read the flag rather than re-testing the header', function() {
        var arms = (live.match(/else if \( request\.isXmlBody \)/g) || []).length;
        assert.equal(arms, 3, 'expected 3 XML arms, got ' + arms);
    });

    it('each XML arm precedes its legacy urlencoded else', function() {
        ['POST', 'PUT', 'PATCH'].forEach(function(m) {
            var jsonMsg = live.indexOf('application/json ' + m + ' body');
            assert.ok(jsonMsg > -1, m + ': json-branch anchor not found');
            var arm     = live.indexOf('else if ( request.isXmlBody )', jsonMsg);
            var legacy  = live.indexOf('} else {', arm);
            assert.ok(arm > -1,        m + ': no XML arm after the json branch');
            assert.ok(arm < legacy,    m + ': XML arm does not precede the legacy else');
        });
    });

    it('every arm seeds obj with an object — the shared tail calls obj.count() and typeof null is object', function() {
        var seeds = (live.match(/obj = \{\}/g) || []).length;
        assert.equal(seeds, 3, 'expected 3 obj={} seeds, got ' + seeds);
    });

    // ── 19b — the matched SET, driven through the shipped matcher ──
    //
    // The set is the one ASP.NET Core, Spring and type-is converge on:
    // application/xml + text/xml + application/*+xml. The wildcard is scoped to
    // `application/` in all three, which is why image/svg+xml is absent below.

    it('matches the industry-standard set (application/xml, text/xml, application/*+xml)', function() {
        var XML = shippedXmlMatcher(src);
        [
            'application/xml',
            'text/xml',
            'application/xml; charset=utf-8',
            'application/xml;charset=utf-8',
            '  APPLICATION/XML  ',
            'application/soap+xml;action="urn:x"',
            'application/atom+xml',
            'application/rss+xml',
            'application/xhtml+xml',
            'application/vnd.acme.thing+xml'
        ].forEach(function(ct) {
            assert.ok(XML.test(ct), 'should match: ' + JSON.stringify(ct));
        });
    });

    it('rejects the RFC 7303 types that are not XML documents, and every non-XML control', function() {
        var XML = shippedXmlMatcher(src);
        [
            'application/xml-dtd',                     // RFC 7303 §9.5
            'application/xml-external-parsed-entity',  // RFC 7303 §9.3
            'text/xml-external-parsed-entity',         // RFC 7303 §9.4
            'application/xmlfoo',
            'image/svg+xml',                           // no framework registers image/*+xml
            'application/json',
            'application/x-www-form-urlencoded',
            'multipart/form-data; boundary=x',
            'text/plain',
            ''
        ].forEach(function(ct) {
            assert.ok(!XML.test(ct), 'should NOT match: ' + JSON.stringify(ct));
        });
    });

    // ── 19c — behavioural: the document survives, and the subtract proves it ──

    it('an ISO 20022 body reaches the application byte-identical', function() {
        var req = postBranch(ISO20022, 'application/xml');
        assert.equal(typeof req.body, 'string', 'body must remain a string');
        assert.equal(req.body, ISO20022);
        assert.equal(req.rawBody, ISO20022, 'rawBody is unaffected either way');
    });

    it('SUBTRACT: without the arm the same document is truncated to a single bogus pair', function() {
        var req = postBranch(ISO20022, 'application/xml', { subtractArm: true });
        assert.equal(typeof req.body, 'object', 'pre-fix, the garbage object REPLACED the body');
        assert.notEqual(req.body, ISO20022);
        // formatDataFromString splits on '=' and keeps only the first pair, so the
        // XML declaration alone collapses the whole document.
        assert.deepEqual(Object.keys(req.body), ['<?xml version']);
    });

    it('a SOAP envelope survives too (application/*+xml, the Spring-documented case)', function() {
        var soap = '<?xml version="1.0"?><soap:Envelope '
                 + 'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
                 + '<soap:Body><m:Pay xmlns:m="urn:x"><m:Amt>1.00</m:Amt></m:Pay></soap:Body></soap:Envelope>';
        assert.equal(postBranch(soap, 'application/soap+xml').body, soap);
        assert.notEqual(postBranch(soap, 'application/soap+xml', { subtractArm: true }).body, soap);
    });

    it('no boolean/null coercion touches attribute values that read "true"/"on"', function() {
        var doc = '<?xml version="1.0"?><cfg><flag>"true"</flag><mode>"on"</mode></cfg>';
        assert.equal(postBranch(doc, 'text/xml').body, doc);
        // pre-fix the coercion stripped the quotes off both values
        assert.notEqual(postBranch(doc, 'text/xml', { subtractArm: true }).body, doc);
    });

    it('the arm never throws through the shared tail (the typeof-null-is-object trap)', function() {
        assert.doesNotThrow(function() { postBranch(ISO20022, 'application/xml'); });
        assert.doesNotThrow(function() { postBranch('<a/>', 'application/xml'); });
    });

    // ── 19d — controls: the legacy and JSON paths are untouched ──

    it('CONTROL: urlencoded bodies still nest as before; raw quotes are now kept (#B588)', function() {
        var req = postBranch('user[name]=Ada&user[age]=37&ok="true"', 'application/x-www-form-urlencoded');
        assert.equal(req.body.user.name, 'Ada');
        assert.equal(req.body.user.age, '37');
        // Measured, not assumed: since #B588 the site hands the body to the data
        // helper verbatim and a urlencoded pair is never coerced, so the raw-quoted
        // ok="true" reaches the app WITH its quotes (six characters) — a real boot
        // returns the same (container-boot-request-parsing 01.5). Before #B588 the
        // site's text pass rewrote the raw TEXT to ok=true and the helper read the
        // plain string 'true'. This control shows the #FIN1 arm leaves that path alone.
        assert.equal(req.body.ok, '"true"');
        assert.equal(typeof req.body.ok, 'string');
    });

    it('CONTROL: application/json bodies still parse verbatim (#B28 untouched)', function() {
        var req = postBranch('{"v":"50%20off","t":"true"}', 'application/json');
        assert.equal(req.body.v, '50%20off', 'no double-decode');
        assert.equal(req.body.t, 'true', 'no form coercion on the JSON path');
    });
});
