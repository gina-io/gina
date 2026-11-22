var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var commentStrip = require('../strip-comments');

var SOURCE = path.join(require('../fw'), 'core/controller/controller.render-json.js');


// ─── 01 — Function-scoped captures of per-request refs (#M1 race fix) ────────
//
// renderJSON() is SYNCHRONOUS (not async), so its main body has no await
// boundaries — no race window between the captures at the top and the
// terminal-exit closure-nulling at the bottom. BUT the writeCache helper IS
// async and is called fire-and-forget at the end of renderJSON. After
// writeCache yields at `await fs.promises.writeFile(...)`, control returns
// to renderJSON which can complete and null `local.req` / `local.res` /
// `local.next` on the closure. If writeCache then resumes and reads
// `local.res` post-await (the narrow `invalidateOnEvents` non-Array branch
// at the bottom), it dereferences null. The fix passes `res` (the renderJSON-
// captured response) into writeCache as a parameter, so the post-await read
// goes through the function-scoped capture instead of the closure.

describe('01 - function-scoped captures of per-request refs (#M1 race fix)', function() {

    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    // ── (a) source structure: renderJSON's existing captures preserved ──

    it("renderJSON() body captures `var request = local.req` after the deps unpack", function() {
        var src = getSrc();
        assert.ok(
            /var\s+request\s*=\s*local\.req\s*;/.test(src),
            'expected `var request = local.req;` capture in renderJSON()'
        );
    });

    it("renderJSON() body captures `var response = local.res`", function() {
        var src = getSrc();
        assert.ok(
            /var\s+response\s*=\s*local\.res\s*;/.test(src),
            'expected `var response = local.res;` capture in renderJSON()'
        );
    });

    it("renderJSON() body captures `var next = local.next || null`", function() {
        var src = getSrc();
        assert.ok(
            /var\s+next\s*=\s*local\.next\s*\|\|\s*null\s*;/.test(src),
            'expected `var next = local.next || null;` capture in renderJSON()'
        );
    });

    // ── (b) source structure: writeCache signature takes res param ──────

    it('writeCache signature threads the per-request captures as parameters', function() {
        var src = getSrc();
        assert.ok(
            /async\s+function\s+writeCache\s*\(\s*bundle\s*,\s*opt\s*,\s*jsonContent\s*,\s*req\s*,\s*res\s*,\s*cacheIsEnabled\s*,\s*throwError\s*\)/.test(src),
            'writeCache must take `bundle, opt, jsonContent, req, res, cacheIsEnabled, throwError` — every render-scoped value is threaded (race-safe, #M1/#B63)'
        );
    });

    it('writeCache post-await throwError uses `res` parameter, not `local.res`', function() {
        var src = getSrc();
        // The post-await throwError sits in the `invalidateOnEvents` non-Array
        // validation branch. After the `await fs.promises.writeFile(...)` at
        // line 100, `local.res` may have been nulled by renderJSON's terminal
        // exit. The fix routes the throwError through the captured `res` instead.
        assert.ok(
            /return\s+throwError\(\s*res\s*,\s*500\s*,\s*new\s+Error\('cache\.invalidateOn must be an array'/.test(src),
            "expected `return throwError(res, 500, new Error('cache.invalidateOn must be an array'))` (post-await throwError uses the threaded params — captured res + render-scoped throwError, #B63)"
        );
    });

    it('writeCache call site passes `response` (the renderJSON-captured ref)', function() {
        var src = getSrc();
        assert.ok(
            /writeCache\(self\._options\.bundle,\s*local\.options\.conf\.server\.cache,\s*data,\s*request,\s*response,\s*self\.serverInstance\._cacheIsEnabled,\s*self\.throwError\)/.test(src),
            'writeCache call site must pass the renderJSON captures + the server cache flag + the controller throwError (#B63)'
        );
    });

    // ── (c) negative invariant: no `local.res` reads remain post-await in writeCache ─

    it('writeCache body has no `local.res` reads after the first await', function() {
        var src = getSrc();
        // Find writeCache function span
        var fnStart = src.indexOf('async function writeCache');
        assert.ok(fnStart > -1, 'writeCache not found');
        var fnBodyStart = src.indexOf('{', fnStart);
        // Find first await within writeCache (the render-cache dispatch await —
        // #P30's inline fs.promises.writeFile moved into lib/render-cache in Slice 0).
        var awaitIdx = src.indexOf('await renderCache.set', fnBodyStart);
        assert.ok(awaitIdx > -1, 'first await in writeCache not found');
        // Find the end of writeCache (matching closing brace) — approximate
        // by scanning forward to the next module-scope function declaration.
        var fnEnd = src.indexOf('\n}', awaitIdx);
        assert.ok(fnEnd > -1, 'writeCache closing brace not found');
        var postAwaitBlock = src.substring(awaitIdx, fnEnd);
        // Strip comments
        var stripped = commentStrip.all(postAwaitBlock);
        assert.ok(
            !/local\.res\b/.test(stripped),
            'no `local.res` reads allowed after writeCache\'s first await — must go through the captured `res` parameter'
        );
    });

    // ── (d) pure-logic replica: race-safety property ────────────────────

    it('captured `res` survives `local.res = null` (function-scoped vs closure-scoped)', function() {
        // Simulates: renderJSON captures response = local.res, kicks off
        // writeCache fire-and-forget, completes and nulls local.res, then
        // writeCache resumes and would have dereferenced local.res — but
        // now reads via the captured `res` parameter instead.
        var local = { req: { method: 'POST', url: '/x' }, res: { statusCode: 200 }, next: function() {} };
        var response = local.res;
        // Simulate renderJSON's terminal-exit null:
        local.res = null;
        // Simulate writeCache's post-await access via captured ref:
        assert.equal(response.statusCode, 200, 'captured response survives the closure null-out');
        assert.notEqual(response, null, 'captured response is still the same reference');
    });

});


// 02 — HTTP/2 response trailers (#H10)
describe('02 - HTTP/2 response trailers (#H10)', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    it('captures _trailers from local._trailers', function() {
        assert.ok(/var _trailers\s*=.*local\._trailers/.test(src()), 'expected _trailers capture from local._trailers');
    });

    it('wires waitForTrailers + wantTrailers + sendTrailers in the body path', function() {
        var s = src();
        assert.ok(s.indexOf('#H10') > -1, 'expected #H10 marker');
        assert.ok(s.indexOf('waitForTrailers') > -1, 'expected waitForTrailers');
        assert.ok(s.indexOf("'wantTrailers'") > -1, 'expected wantTrailers listener');
        assert.ok(s.indexOf('sendTrailers') > -1, 'expected sendTrailers call');
    });

    it('gates the trailer wiring on registered trailers (if (_trailers))', function() {
        assert.ok(/if\s*\(\s*_trailers\s*\)/.test(src()), 'expected `if (_trailers)` gate');
    });

    it('passes waitForTrailers conditionally to a single stream.respond() (no extra respond call)', function() {
        assert.ok(
            /stream\.respond\(_streamHeaders,\s*_trailers\s*\?\s*\{\s*waitForTrailers:\s*true\s*\}\s*:\s*undefined\)/.test(src()),
            'expected single conditional stream.respond(_streamHeaders, _trailers ? {...} : undefined)'
        );
    });
});

describe('03 - released-response guard (#B36)', function() {

    function src() { return fs.readFileSync(SOURCE, 'utf8'); }

    // renderJSON() reads `local.res.stream` (~:165, the first local.res deref after the
    // #M1 captures) with NO headersSent guard before it, and the exported renderJSON is
    // synchronous — so a terminal exit (redirect-then-continue) that nulled local.res made
    // it crash the bundle (uncaughtException → SIGTERM). Measured via a standalone harness
    // driving the real delegate: CONTROL (live) rendered, RELEASE (after renderTEXT) threw
    // `reading 'stream'`. Fixed with a top-of-function released-response guard.

    it('renderJSON guards a released response before the local.res.stream read', function() {
        var s = src();
        var guardIdx  = s.search(/if\s*\(\s*local\.res\s*==\s*null\s*\)\s*\{[\s\S]{0,40}?return;/);
        var errIdx    = s.indexOf('if ( self.isProcessingError )');
        var cacheIdx  = s.indexOf('renderCache.from(self.serverInstance._cached)');
        var streamIdx = s.indexOf('typeof(local.res.stream)');
        assert.ok(guardIdx > -1, 'expected an `if ( local.res == null ) return;` guard in renderJSON()');
        assert.ok(errIdx > -1 && errIdx < guardIdx, 'guard must follow the isProcessingError early-return');
        assert.ok(cacheIdx > guardIdx, 'guard must precede renderCache.from(self.serverInstance._cached)');
        assert.ok(streamIdx > guardIdx, 'guard must precede the local.res.stream read (the crash site)');
    });

    // ---- pure-logic replica of the guard + the crash site ----
    function renderJSONHead(localRes, mode) {
        // mode: 'fixed' (post-#B36) | 'prefix' (pre-#B36, no guard)
        if (mode === 'fixed' && localRes == null) return 'no-op (released)';
        // crash site (render-json.js:165): `if ( typeof(local.res.stream) != 'undefined' )`
        var stream = (typeof localRes.stream != 'undefined') ? localRes.stream : null;
        return 'rendered (stream=' + stream + ')';
    }

    it('replica: released response no-ops; live response proceeds', function() {
        assert.strictEqual(renderJSONHead(null, 'fixed'), 'no-op (released)');
        assert.strictEqual(renderJSONHead({}, 'fixed'), 'rendered (stream=null)');
    });

    it('subtract: the pre-fix head throws reading `stream` on a released response', function() {
        assert.throws(function() { renderJSONHead(null, 'prefix'); },
            function(err) {
                return err instanceof TypeError
                    && /Cannot read properties of null \(reading 'stream'\)/.test(err.message);
            },
            'the unguarded renderJSON head must reproduce the released-response crash');
    });
});


// ─── 04 — per-request deps are function-scoped (#B63) ───────────────────────

describe('04 - per-request deps are function-scoped; writeCache reads only its parameters (#B63 module-scope race)', function() {

    var _src = null;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }
    function stripComments(s) { return commentStrip.all(s); }

    it('module scope declares no per-request state', function() {
        var src = getSrc();
        var prefix = stripComments(src.substring(0, src.indexOf('async function writeCache')));
        assert.ok(
            !/var\s+(self|local|headersSent|cachePath)\b/.test(prefix),
            'a per-request binding is declared at module scope — it must be function-scoped inside renderJSON() (#B63)'
        );
        assert.ok(
            !/,\s*(local|headersSent|cachePath)\s*=\s*null/.test(prefix),
            'the pre-#B63 comma-continued module declaration block is back'
        );
    });

    it('renderJSON captures the deps with `var` (function-scoped)', function() {
        var src = getSrc();
        ['self', 'local', 'headersSent'].forEach(function(name) {
            assert.match(
                src,
                new RegExp('var\\s+' + name + '\\s*=\\s*deps\\.' + name + '\\s*;'),
                '`var ' + name + ' = deps.' + name + ';` missing from renderJSON() — dep no longer function-scoped'
            );
        });
        // The dead module-scoped cachePath (assigned, never read) must not return
        // as an implicit global now that the module declaration is gone.
        assert.ok(
            !/^\s*cachePath\s*=/m.test(stripComments(src)),
            'a `cachePath =` assignment exists — it was removed as dead (write-only) in #B63 and would now be an implicit global'
        );
    });

    it('writeCache body reads only its parameters — never the per-request bindings', function() {
        var src = getSrc();
        var start = src.indexOf('async function writeCache');
        var end = src.indexOf('module.exports');
        assert.ok(start > 0 && end > start, 'expected writeCache followed by module.exports');
        var body = stripComments(src.substring(start, end));
        assert.ok(!/\bself\b/.test(body),
            'writeCache references `self` — it is function-scoped inside renderJSON; thread values as parameters (#B60/#B63)');
        assert.ok(!/\blocal\b/.test(body),
            'writeCache references `local` — it is function-scoped inside renderJSON; thread values as parameters (#B63)');
    });

    it('interleaved replica: a module-scoped controller capture routes the post-await error through the CONCURRENT request; the threaded parameter does not (subtract)', async function() {
        // Mirror of the writeCache shape: fire-and-forget async helper, one
        // await (the cache write), then an error-path call on the controller.
        // Two renders in the same tick both suspend at the await before either
        // resumes, so under module scope the second assignment always wins.
        function mkDelegate(mode) {
            var modSelf = null; // module-scope analog: shared across calls
            return function renderJSON(deps) {
                if (mode === 'module') { modSelf = deps.self; }
                ;(async function writeCache(throwError) {
                    await Promise.resolve(); // the cache-write suspension
                    if (mode === 'module') { modSelf.throwError(); }
                    else { throwError(); }
                })(deps.self.throwError);
            };
        }
        function mkDeps(threwOn, tag) {
            return { self: { throwError: function() { threwOn.push(tag); } } };
        }
        // settle() must be scheduled in a LATER event-loop phase than the
        // replica's continuations, structurally — not by wall-clock. A
        // setTimeout-based settle races on a delayed event-loop turn: the
        // timers phase runs before the check phase, so an elapsed timer
        // asserts before setImmediate continuations ever fire (measured on
        // the 2-core CI runners as tm=[]). Microtask continuations + a
        // setImmediate settle cannot reorder: pending microtasks always
        // drain before the check phase.
        function settle() { return new Promise(function(r) { setImmediate(r); }); }

        // SUBTRACT — the pre-#B63 module-scope shape: A's error lands on B's controller.
        var tm = [];
        var dm = mkDelegate('module');
        dm(mkDeps(tm, 'A')); dm(mkDeps(tm, 'B'));
        await settle();
        assert.deepStrictEqual(tm, ['B', 'B'],
            'module-scope shape must route BOTH post-await errors through the last-assigned controller (the measured wrong-controller routing)');

        // Fixed shape: the controller method is threaded as a parameter.
        var tf = [];
        var df = mkDelegate('param');
        df(mkDeps(tf, 'A')); df(mkDeps(tf, 'B'));
        await settle();
        assert.deepStrictEqual(tf.sort(), ['A', 'B'],
            'threaded-parameter shape must route each error through its own controller');
    });
});


// ---------------------------------------------------------------------------
// 05 - bundle-wide sliding / maxAge cache defaults (server.cache)
// ---------------------------------------------------------------------------
describe('05 - bundle-wide sliding / maxAge cache defaults (server.cache)', function() {
    // JSON-response writeCache inherits sliding/maxAge from opt (= conf.server.cache)
    // when the route omits them, mirroring the ttl fallback and staying in lockstep
    // with render-swig.js and render-nunjucks.js.
    function getSrc() { return fs.readFileSync(SOURCE, 'utf8'); }
    it('falls back to opt.sliding / opt.maxAge next to the ttl fallback', function() {
        var s   = getSrc();
        var idx = s.indexOf('async function writeCache');
        assert.ok(idx > 0, 'writeCache found');
        var body = s.slice(idx, idx + 2600);
        assert.match(body, /typeof\(\s*cachingOption\.ttl\s*\)\s*==\s*['"]undefined['"][\s\S]{0,120}cachingOption\.ttl\s*=\s*opt\.ttl/);
        assert.match(body, /typeof\(\s*cachingOption\.sliding\s*\)\s*==\s*['"]undefined['"]\s*&&\s*typeof\(\s*opt\.sliding\s*\)\s*!=\s*['"]undefined['"][\s\S]{0,80}cachingOption\.sliding\s*=\s*opt\.sliding/);
        assert.match(body, /typeof\(\s*cachingOption\.maxAge\s*\)\s*==\s*['"]undefined['"]\s*&&\s*typeof\(\s*opt\.maxAge\s*\)\s*!=\s*['"]undefined['"][\s\S]{0,80}cachingOption\.maxAge\s*=\s*opt\.maxAge/);
    });
    it('documents opt.sliding / opt.maxAge in the writeCache @param opt JSDoc', function() {
        assert.match(getSrc(), /@param\s+\{object\}\s+opt[\s\S]{0,120}opt\.sliding[\s\S]{0,40}opt\.maxAge/);
    });
});


// ---------------------------------------------------------------------------
// 06 - responseDto dev warn checks the SERVED contract (#B110)
// ---------------------------------------------------------------------------
describe('06 - responseDto dev warn checks the SERVED contract (#B110)', function() {
    // The dev-only missing-required warn reads required[] off the schema. A field
    // that is `.required()` AND `.exclude()`d can never reach the wire (apply()
    // deletes it before the single JSON.stringify feeding every body branch AND
    // the cache write), so the warn must check the response projection — not the
    // declared shape — or an action legitimately omitting such a field would warn
    // on every dev render.
    function getSrc() { return fs.readFileSync(SOURCE, 'utf8'); }
    it('the missing-required warn reads the response projection (dropExcluded)', function() {
        assert.match(getSrc(), /_respDto\.toJsonSchema\(null, \{ dropExcluded: true \}\)/);
    });
    it('the wire transform itself remains apply() — the strip is not schema-driven', function() {
        assert.match(getSrc(), /jsonObj = _respDto\.apply\(jsonObj\)/);
    });
});


// ---------------------------------------------------------------------------
// 07 - HTTP/2 body :status honours response.statusCode (#B172)
// ---------------------------------------------------------------------------
// The engine-agnostic status resolution (`response.statusCode = jsonObj.status`)
// ran correctly, but the HTTP/2 body branch built its header frame with a
// LITERAL `':status': 200` — and the pending-header merge below it only fills
// keys not already present, while `res.setHeader(':status', …)` throws
// ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED anyway, so the resolved code could never
// reach the wire. Every renderJSON({status: 4xx}) was served as 200 on a
// genuine HTTP/2 stream. The HEAD branch in the same file already used
// `response.statusCode || 200`; the body branch now matches it.
//
// Strategy: controller.render-json.js cannot be require()d standalone (it
// loads the lib registry + framework globals at module scope), so the body
// branch is EXTRACTED from the shipped source via brace-matching and executed
// as real bytes against a stream.respond() spy — no drift-prone replica. The
// extraction is control-gated (the anchor appears exactly once; the brace
// walk balances).
describe('07 - HTTP/2 body :status honours response.statusCode (#B172)', function() {

    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    // NOTE the anchor's spacing is load-bearing: the HEAD branch spells its
    // guard `if ( !stream.headersSent ) {` — only the body branch uses the
    // space-free form, which keeps the anchor unique.
    var BODY_ANCHOR = 'if (!stream.headersSent) {';

    /**
     * Brace-match-extract a block from `open` to its balanced close.
     * @param {string} src
     * @param {string} open - the opening anchor (must contain the first `{`)
     * @returns {string}
     * @inner
     */
    function extractBlock(src, open) {
        var start = src.indexOf(open);
        assert.notStrictEqual(start, -1, 'anchor not found: ' + open);
        assert.strictEqual(src.indexOf(open, start + 1), -1, 'anchor not unique: ' + open);
        var i = src.indexOf('{', start);
        var depth = 0;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') {
                depth--;
                if (depth === 0) return src.slice(start, i + 1);
            }
        }
        throw new Error('unbalanced block for anchor: ' + open);
    }

    /**
     * Compile + run the REAL extracted body-branch bytes against a
     * stream.respond() spy.
     * @param {object} opts - { statusCode, pendingHeaders, cc, trailers }
     * @returns {{responded: (object|null), respondOptions: *}}
     * @inner
     */
    function runBodyBranch(opts) {
        var block = extractBlock(getSrc(), BODY_ANCHOR);
        var responded = null, respondOptions;
        var stream = {
            headersSent : false,
            destroyed   : false,
            closed      : false,
            once        : function() {},
            respond     : function(h, o) { responded = h; respondOptions = o; stream.headersSent = true; }
        };
        var response = {
            statusCode : opts.statusCode,
            getHeaders : function() { return opts.pendingHeaders || {}; }
        };
        var local = { options: { conf: {
            encoding: 'utf-8',
            server: { coreConfiguration: { mime: { json: 'application/json' } } }
        } } };
        /* eslint-disable no-new-func */
        var fn = new Function('stream', 'local', '_cc', 'response', '_trailers', block);
        fn(stream, local, opts.cc || null, response, opts.trailers || null);
        return { responded: responded, respondOptions: respondOptions };
    }

    // ── source pins ──

    it('the body branch frame reads response.statusCode (no hardcoded 200)', function() {
        var block = extractBlock(getSrc(), BODY_ANCHOR);
        assert.ok(block.indexOf("':status': response.statusCode || 200") > -1,
            "expected `':status': response.statusCode || 200` in the body branch");
        assert.strictEqual(block.indexOf("':status': 200"), -1,
            'the hardcoded `:status: 200` literal must be gone from the body branch');
    });

    it('the whole file carries no hardcoded `:status: 200` literal left', function() {
        assert.strictEqual(getSrc().indexOf("':status': 200"), -1,
            'no frame in render-json may hardcode the status');
    });

    // ── behavioural: the real bytes, both directions ──

    it('a resolved non-200 statusCode reaches the HTTP/2 frame', function() {
        var h = runBodyBranch({ statusCode: 404 });
        assert.ok(h.responded, 'stream.respond() should have been called');
        assert.strictEqual(h.responded[':status'], 404);
    });

    it('a 200 statusCode still ships 200', function() {
        var h = runBodyBranch({ statusCode: 200 });
        assert.strictEqual(h.responded[':status'], 200);
    });

    it('an unset statusCode falls back to 200', function() {
        var h = runBodyBranch({ statusCode: undefined });
        assert.strictEqual(h.responded[':status'], 200);
    });

    it('pending response headers still merge and cannot clobber :status', function() {
        var h = runBodyBranch({ statusCode: 500, pendingHeaders: { 'access-control-allow-origin': '*' } });
        assert.strictEqual(h.responded[':status'], 500);
        assert.strictEqual(h.responded['access-control-allow-origin'], '*');
    });

    it('cache-control + content-type survive on a non-200 frame', function() {
        var h = runBodyBranch({ statusCode: 404, cc: 'private, max-age=60' });
        assert.strictEqual(h.responded[':status'], 404);
        assert.strictEqual(h.responded['cache-control'], 'private, max-age=60');
        assert.strictEqual(h.responded['content-type'], 'application/json; charset=utf-8');
    });

    // ── subtract: the pre-fix literal shape drops the code (documents #B172) ──

    it('subtract — a hardcoded-200 frame ignores the resolved statusCode', function() {
        // Hand-built pre-fix shape: same merge, literal status. Proves the test
        // discriminates — the defect was the literal, not the merge.
        var _streamHeaders = { 'content-type': 'application/json', ':status': 200 };
        var _pendingHeaders = {};
        for (var _rhk in _pendingHeaders) {
            if (!(_rhk in _streamHeaders)) _streamHeaders[_rhk] = _pendingHeaders[_rhk];
        }
        assert.strictEqual(_streamHeaders[':status'], 200,
            'the pre-fix shape serves 200 no matter what statusCode resolved to');
    });
});


// ---------------------------------------------------------------------------
// 08 - the errno half of the status branch is guarded (#B172 rider)
// ---------------------------------------------------------------------------
// `{errno: X}` with no usable `status` used to enter the branch and assign
// `response.statusCode = jsonObj.status` — i.e. undefined. On HTTP/1.1 the
// later response.end() then throws ERR_HTTP_INVALID_STATUS_CODE, which the
// empty catch below swallows: the response is never sent and the client
// hangs. On HTTP/2 the compat statusCode setter throws at assignment → the
// branch's catch → 500. The swig and v1 delegates already guard their errno
// halves with the same statusCodes[...] conjunct (and were measured safe);
// render-json was the only delegate without it. With the guard, an
// errno-only payload skips the branch and is served as a normal 200 with the
// payload in the body — measured wire-identical to dropping the clause on
// every input.
//
// This block is ALSO the HTTP/1.1 arm of #B172: on h1 the compat layer
// serves response.statusCode directly, so asserting the resolution here is
// asserting the h1 wire.
describe('08 - the errno half of the status branch is guarded (#B172 rider)', function() {

    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(SOURCE, 'utf8')); }

    var STATUS_ANCHOR = '//catching errors';

    /**
     * Extract the status-resolution if-block (condition + body) and compile
     * it into a runnable function over real bytes.
     * @returns {function(object, object): {statusCode: *}}
     * @inner
     */
    function makeResolver() {
        var src = getSrc();
        var start = src.indexOf(STATUS_ANCHOR);
        assert.notStrictEqual(start, -1, 'status anchor not found');
        assert.strictEqual(src.indexOf(STATUS_ANCHOR, start + 1), -1, 'status anchor not unique');
        var ifIdx = src.indexOf('if (', start);
        var p = src.indexOf('(', ifIdx), depth = 0, i = p;
        for (; i < src.length; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')') { depth--; if (depth === 0) break; }
        }
        var bOpen = src.indexOf('{', i); depth = 0;
        var j = bOpen;
        for (; j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') { depth--; if (depth === 0) break; }
        }
        var block = src.slice(ifIdx, j + 1);
        var quiet = { error: function() {}, warn: function() {}, info: function() {} };
        /* eslint-disable no-new-func */
        var fn = new Function('jsonObj', 'response', 'local', 'console', block + '\nreturn response;');
        return function(jsonObj, statusCodeIn) {
            var response = { statusCode: (typeof statusCodeIn !== 'undefined') ? statusCodeIn : 200, statusMessage: '' };
            var local = { options: { conf: { server: {
                protocol: 'http/1.1',
                coreConfiguration: { statusCodes: { 200: 'OK', 404: 'Not Found', 500: 'Internal Server Error' } }
            } } } };
            return fn(jsonObj, response, local, quiet);
        };
    }

    // ── source pin: the guard conjunct sits on the errno half, like the siblings ──

    it('the errno half carries the statusCodes[...] conjunct (sibling parity)', function() {
        assert.match(getSrc(),
            /typeof\(jsonObj\.errno\) != 'undefined' && response\.statusCode == 200\s*&& typeof\(local\.options\.conf\.server\.coreConfiguration\.statusCodes\[jsonObj\.status\]\) != 'undefined'/,
            'expected the errno half guarded exactly like render-swig/render-v1');
    });

    // ── behavioural: real extracted bytes ──

    it('errno-only payload no longer poisons statusCode (stays 200)', function() {
        var resolve = makeResolver();
        assert.strictEqual(resolve({ errno: 5 }).statusCode, 200);
    });

    it('errno + invalid status skips the branch (stays 200)', function() {
        var resolve = makeResolver();
        assert.strictEqual(resolve({ errno: 5, status: 9999 }).statusCode, 200);
    });

    it('errno + valid non-200 status still resolves the status', function() {
        var resolve = makeResolver();
        assert.strictEqual(resolve({ errno: 5, status: 404 }).statusCode, 404);
    });

    it('status-only payloads are untouched by the guard (regression)', function() {
        var resolve = makeResolver();
        assert.strictEqual(resolve({ status: 404 }).statusCode, 404);
        assert.strictEqual(resolve({ status: 200 }).statusCode, 200);
        assert.strictEqual(resolve({ status: 9999 }).statusCode, 200);
        assert.strictEqual(resolve({ ok: true }).statusCode, 200);
    });

    it('a pre-set non-200 statusCode is never overridden by errno', function() {
        var resolve = makeResolver();
        assert.strictEqual(resolve({ errno: 5 }, 403).statusCode, 403);
    });

    // ── subtract: the unguarded pre-fix condition poisons statusCode ──

    it('subtract — without the conjunct, errno-only assigns statusCode = undefined', function() {
        // The pre-fix condition shape, run against the same body semantics:
        // entering via the bare errno half assigns jsonObj.status verbatim.
        var jsonObj = { errno: 5 };
        var response = { statusCode: 200 };
        if (
            typeof(jsonObj.errno) != 'undefined' && response.statusCode == 200
            ||
            typeof(jsonObj.status) != 'undefined' && jsonObj.status != 200
        ) {
            response.statusCode = jsonObj.status;
        }
        assert.strictEqual(response.statusCode, undefined,
            'the unguarded shape poisons statusCode — this is the defect the guard closes');
    });
});
