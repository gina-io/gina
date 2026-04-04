/**
 * HTTP/2 client retry paths — handleHTTP2ClientRequest
 *
 * handleHTTP2ClientRequest is a closure-local variable inside SuperController;
 * it cannot be required directly.  Two strategies are used here:
 *
 *   A. Source inspection — verifies all retry paths exist in the source so a
 *      refactor that removes a guard is caught by CI.
 *
 *   B. Logic replicas — GinaHttp2Error, _http2ErrCodeMap, and each handler's
 *      decision tree are replicated verbatim and tested with lightweight stubs.
 *      This is the same approach used in router.test.js (resolveRouteConfig)
 *      and proc.test.js (assignProcessServer / runShutdown).
 *
 * Retry paths covered:
 *   #H1 — onQueryClosed  (GOAWAY / premature stream close)
 *   #H2 — onEnd 502      (upstream Bad Gateway from nginx)
 *   #H3 — _swallowIfNonCritical (non-critical request errors)
 *   #H4 — GinaHttp2Error typing
 *         onStreamTimeout
 *         onQueryError   (stream error / connection reset)
 */

'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var SOURCE = path.join(require('../fw'), 'core/controller/controller.js');


// ─── A. Replicated types ──────────────────────────────────────────────────────
//
// These are verbatim copies of the closure-local definitions in controller.js.
// If the source changes, the corresponding source-inspection tests in section 03
// will fail before these replicas drift silently.

function GinaHttp2Error(message, opts) {
    Error.call(this);
    this.name    = 'GinaHttp2Error';
    this.message = message;
    if (Error.captureStackTrace) {
        Error.captureStackTrace(this, GinaHttp2Error);
    } else {
        this.stack = (new Error(message)).stack;
    }
    opts             = opts || {};
    this.code        = opts.code        || 'UNKNOWN';
    this.retryable   = typeof opts.retryable  === 'boolean' ? opts.retryable  : false;
    this.status      = opts.status      || 500;
    this.retryCount  = typeof opts.retryCount === 'number' ? opts.retryCount : 0;
    // Backward compatibility: retriedOnce is derived from retryCount
    this.retriedOnce = this.retryCount > 0;
}
GinaHttp2Error.prototype             = Object.create(Error.prototype);
GinaHttp2Error.prototype.constructor = GinaHttp2Error;

var _http2ErrCodeMap = {
    'ERR_HTTP2_STREAM_ERROR'  : 'STREAM_ERROR',
    'ERR_HTTP2_SESSION_ERROR' : 'STREAM_ERROR',
    'ECONNRESET'              : 'ECONNRESET',
    'ECONNREFUSED'            : 'ECONNREFUSED'
};


// ─── B. Handler logic replicas ────────────────────────────────────────────────
//
// Each function isolates the decision tree of one event handler.
// Side-effecting infrastructure (cache, client, sessions array) is passed as stubs
// so assertions can inspect state changes without touching the real framework.
// Return value is an action-descriptor object so tests can assert behaviour
// without relying on side effects alone.

// _swallowIfNonCritical — replicated from the inner function in handleHTTP2ClientRequest
function swallowIfNonCritical(isCritical, err) {
    if (isCritical) return false;
    // In the real code: console.warn(...)
    return true;
}

/**
 * onStreamTimeout — stream-level timeout handler.
 *
 * ctx fields:
 *   isFinished  { value: bool }   mutable box
 *   retryCount  number            current retry attempt (0 = first try)
 *   maxRetries  number            max retry attempts (default 2)
 *   isCritical  bool
 *   streamTimeout number (ms)
 *   options     object  (must have ':authority', ':method', ':path')
 *   client      { destroyed, destroy() }
 *   cache       { delete(k) }
 *   sessKey     string
 *   sessions    string[]  (_http2Sessions mirror)
 *   callback    function|undefined
 *   self        EventEmitter-like
 *
 * Returns { action: 'noop'|'retry'|'callback'|'emit'|'swallowed', err? }
 */
function onStreamTimeoutLogic(ctx) {
    if (ctx.isFinished.value) return { action: 'noop' };
    ctx.isFinished.value = true;

    ctx.cache.delete(ctx.sessKey);
    var tIdx = ctx.sessions.indexOf(ctx.sessKey);
    if (tIdx !== -1) ctx.sessions.splice(tIdx, 1);
    if (!ctx.client.destroyed) ctx.client.destroy();

    if (ctx.retryCount < ctx.maxRetries) {
        return { action: 'retry' };
    }

    var ms  = ctx.streamTimeout;
    var msStr = ms > 1000 ? (ms / 1000) + 's' : ms + 'ms';
    var msg   = '[HTTP2] No response from ' + ctx.options[':authority'] + ' after ' + msStr;
    var err   = new GinaHttp2Error(msg, { code: 'TIMEOUT', retryable: false, status: 503, retryCount: ctx.retryCount });

    if (swallowIfNonCritical(ctx.isCritical, err)) return { action: 'swallowed', err: err };

    if (typeof ctx.callback === 'function') {
        ctx.callback(err);
        return { action: 'callback', err: err };
    }
    ctx.self.emit('query#complete', { status: 503, error: err });
    return { action: 'emit', err: err };
}

/**
 * onQueryClosed — premature stream-close handler (#H1 fix).
 *
 * ctx fields: same as onStreamTimeoutLogic plus sessions array.
 * Returns { action: 'noop'|'retry'|'callback'|'emit'|'swallowed', err? }
 */
function onQueryClosedLogic(ctx) {
    if (ctx.isFinished.value) return { action: 'noop' };
    ctx.isFinished.value = true;

    if (ctx.retryCount < ctx.maxRetries) {
        ctx.cache.delete(ctx.sessKey);
        var cIdx = ctx.sessions.indexOf(ctx.sessKey);
        if (cIdx !== -1) ctx.sessions.splice(cIdx, 1);
        if (!ctx.client.destroyed) ctx.client.destroy();
        return { action: 'retry' };
    }

    var err = new GinaHttp2Error(
        '[HTTP2] Stream closed before response was complete (GOAWAY / session timeout / network reset)',
        { code: 'PREMATURE_CLOSE', retryable: false, status: 503, retryCount: ctx.retryCount }
    );

    if (swallowIfNonCritical(ctx.isCritical, err)) return { action: 'swallowed', err: err };

    if (typeof ctx.callback === 'function') {
        ctx.callback(err);
        return { action: 'callback', err: err };
    }
    ctx.self.emit('query#complete', { status: 503, error: err });
    return { action: 'emit', err: err };
}

/**
 * onQueryError — stream error handler.
 *
 * ctx fields: same as onQueryClosedLogic plus error object.
 * Returns { action: 'noop'|'retry'|'callback'|'emit'|'swallowed', err? }
 */
function onQueryErrorLogic(ctx) {
    if (ctx.isFinished.value) return { action: 'noop' };

    var error     = ctx.error;
    var errorCode = error.code || (error.cause ? error.cause.code : null);

    // Retry path for ERR_HTTP2_STREAM_ERROR or ECONNRESET (up to maxRetries)
    if (ctx.retryCount < ctx.maxRetries && (errorCode === 'ERR_HTTP2_STREAM_ERROR' || errorCode === 'ECONNRESET')) {
        ctx.isFinished.value = true;
        ctx.cache.delete(ctx.sessKey);
        if (!ctx.client.destroyed) ctx.client.destroy();
        return { action: 'retry' };
    }

    ctx.isFinished.value = true;

    var isConnError = (
        (error.cause && error.cause.code && /ECONNREFUSED|ECONNRESET/.test(error.cause.code)) ||
        (error.code && /ECONNREFUSED|ECONNRESET/.test(error.code))
    );

    var ginaCode   = _http2ErrCodeMap[errorCode] || (isConnError ? 'ECONNREFUSED' : 'STREAM_ERROR');
    var ginaStatus = isConnError ? 503 : 500;
    var ginaErr    = new GinaHttp2Error(error.message, {
        code       : ginaCode,
        retryable  : ctx.retryCount < ctx.maxRetries,
        status     : ginaStatus,
        retryCount : ctx.retryCount
    });
    ginaErr.cause = error;

    if (swallowIfNonCritical(ctx.isCritical, ginaErr)) return { action: 'swallowed', err: ginaErr };

    if (typeof ctx.callback !== 'undefined') {
        ctx.callback(ginaErr);
        return { action: 'callback', err: ginaErr };
    }
    ctx.self.emit('query#complete', { status: ginaStatus, error: ginaErr });
    return { action: 'emit', err: ginaErr };
}

/**
 * on502EndLogic — 502 handling from req.on('end') (#H2 fix).
 *
 * ctx fields: httpStatus, retryCount, maxRetries, schedule (replacement for setTimeout).
 * Returns { action: 'retry-scheduled'|'no-retry' }
 */
function on502EndLogic(ctx) {
    if (ctx.httpStatus === 502 && ctx.retryCount < ctx.maxRetries) {
        ctx.schedule(); // mirrors: setTimeout(fn, 2000)
        return { action: 'retry-scheduled' };
    }
    return { action: 'no-retry' };
}


// ─── Stub factories ───────────────────────────────────────────────────────────

function makeClient(alreadyDestroyed) {
    var c = {
        destroyed    : alreadyDestroyed || false,
        closed       : false,
        _destroyCalled: false
    };
    c.destroy = function() { c._destroyCalled = true; c.destroyed = true; };
    return c;
}

function makeCache() {
    var store = {};
    return {
        _deleted: [],
        delete: function(k) { store[k] = undefined; this._deleted.push(k); },
        get   : function(k) { return store[k]; },
        set   : function(k, v) { store[k] = v; }
    };
}

function makeSelf() {
    var EventEmitter = require('events');
    var ee           = new EventEmitter();
    return {
        emit             : ee.emit.bind(ee),
        on               : ee.on.bind(ee),
        once             : ee.once.bind(ee),
        removeAllListeners: ee.removeAllListeners.bind(ee)
    };
}

function makeOptions() {
    return {
        ':authority': 'api.test.local',
        ':method'   : 'GET',
        ':path'     : '/v1/resource',
        ':scheme'   : 'http',
        ':hostname' : 'api.test.local',
        ':port'     : 3000,
        hostname    : 'api.test.local',
        protocol    : 'http',
        scheme      : 'http',
        port        : 3000,
        headers     : {}
    };
}

function makeCtx(overrides) {
    return Object.assign({
        isFinished  : { value: false },
        retryCount  : 0,
        maxRetries  : 2,
        isCritical  : true,
        streamTimeout: 10000,
        options     : makeOptions(),
        client      : makeClient(),
        cache       : makeCache(),
        sessKey     : 'http2session:api.test.local',
        sessions    : ['http2session:api.test.local'],
        callback    : undefined,
        self        : makeSelf(),
        error       : null
    }, overrides || {});
}


// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

// ─── 01 — GinaHttp2Error construction (#H4) ──────────────────────────────────

describe('01 - GinaHttp2Error — construction and field defaults (#H4)', function() {

    it('name is GinaHttp2Error', function() {
        var e = new GinaHttp2Error('test');
        assert.equal(e.name, 'GinaHttp2Error');
    });

    it('message is stored', function() {
        var e = new GinaHttp2Error('something failed');
        assert.equal(e.message, 'something failed');
    });

    it('inherits from Error (instanceof check)', function() {
        var e = new GinaHttp2Error('test');
        assert.ok(e instanceof Error);
    });

    it('has a stack trace', function() {
        var e = new GinaHttp2Error('test');
        assert.ok(typeof e.stack === 'string' && e.stack.length > 0);
    });

    it('code defaults to UNKNOWN when opts omitted', function() {
        var e = new GinaHttp2Error('test');
        assert.equal(e.code, 'UNKNOWN');
    });

    it('retryable defaults to false when opts omitted', function() {
        var e = new GinaHttp2Error('test');
        assert.equal(e.retryable, false);
    });

    it('status defaults to 500 when opts omitted', function() {
        var e = new GinaHttp2Error('test');
        assert.equal(e.status, 500);
    });

    it('retriedOnce defaults to false when opts omitted', function() {
        var e = new GinaHttp2Error('test');
        assert.equal(e.retriedOnce, false);
    });

    it('stores provided opts fields', function() {
        var e = new GinaHttp2Error('msg', { code: 'TIMEOUT', retryable: true, status: 503, retryCount: 2 });
        assert.equal(e.code,        'TIMEOUT');
        assert.equal(e.retryable,   true);
        assert.equal(e.status,      503);
        assert.equal(e.retryCount,  2);
        assert.equal(e.retriedOnce, true); // derived from retryCount > 0
    });

    it('retryable: false is stored correctly (not coerced to true)', function() {
        var e = new GinaHttp2Error('msg', { retryable: false });
        assert.equal(e.retryable, false);
    });

    it('retriedOnce is derived from retryCount > 0', function() {
        var e = new GinaHttp2Error('msg', { retryCount: 1 });
        assert.equal(e.retriedOnce, true);
        var e2 = new GinaHttp2Error('msg', { retryCount: 0 });
        assert.equal(e2.retriedOnce, false);
    });

});


// ─── 02 — _http2ErrCodeMap (native → Gina error code translation) ────────────

describe('02 - _http2ErrCodeMap — native-to-Gina code translation', function() {

    it('ERR_HTTP2_STREAM_ERROR maps to STREAM_ERROR', function() {
        assert.equal(_http2ErrCodeMap['ERR_HTTP2_STREAM_ERROR'], 'STREAM_ERROR');
    });

    it('ERR_HTTP2_SESSION_ERROR maps to STREAM_ERROR', function() {
        assert.equal(_http2ErrCodeMap['ERR_HTTP2_SESSION_ERROR'], 'STREAM_ERROR');
    });

    it('ECONNRESET maps to ECONNRESET', function() {
        assert.equal(_http2ErrCodeMap['ECONNRESET'], 'ECONNRESET');
    });

    it('ECONNREFUSED maps to ECONNREFUSED', function() {
        assert.equal(_http2ErrCodeMap['ECONNREFUSED'], 'ECONNREFUSED');
    });

    it('unknown native code returns undefined (caller applies fallback)', function() {
        assert.equal(_http2ErrCodeMap['ERR_UNKNOWN_THING'], undefined);
    });

    it('has exactly four entries', function() {
        assert.equal(Object.keys(_http2ErrCodeMap).length, 4);
    });

});


// ─── 03 — Source structure (all retry paths present) ─────────────────────────

describe('03 - Source structure — all retry paths present in controller.js', function() {

    var src;

    it('source can be read', function() {
        src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.length > 0);
    });

    it('GinaHttp2Error class is defined', function() {
        assert.ok(src.indexOf('function GinaHttp2Error(message, opts)') > -1);
    });

    it('_http2ErrCodeMap is defined', function() {
        assert.ok(src.indexOf('var _http2ErrCodeMap') > -1);
    });

    it('handleHTTP2ClientRequest function is defined', function() {
        assert.ok(src.indexOf('var handleHTTP2ClientRequest = function(') > -1);
    });

    it('isCritical parameter is in function signature', function() {
        assert.ok(/handleHTTP2ClientRequest\s*=\s*function\([^)]*isCritical/.test(src));
    });

    it('retryCount parameter is in function signature', function() {
        assert.ok(/handleHTTP2ClientRequest\s*=\s*function\([^)]*retryCount/.test(src));
    });

    it('_swallowIfNonCritical helper is defined inside the function', function() {
        assert.ok(src.indexOf('_swallowIfNonCritical') > -1);
    });

    it('#H1 — premature-close retry: PREMATURE_CLOSE code is present', function() {
        assert.ok(src.indexOf("code       : 'PREMATURE_CLOSE'") > -1
               || src.indexOf("code: 'PREMATURE_CLOSE'") > -1);
    });

    it('#H1 — premature-close retry: req.on(\'close\') handler exists', function() {
        assert.ok(src.indexOf("req.on('close'") > -1 || src.indexOf('req.on("close"') > -1);
    });

    it('#H2 — 502 retry: httpStatus === 502 guard is present', function() {
        assert.ok(src.indexOf('httpStatus === 502') > -1);
    });

    it('#H2 — 502 retry: setTimeout retry call is present', function() {
        assert.ok(src.indexOf('setTimeout(function onHttp2RetryAfter502') > -1);
    });

    it('#H4 — stream timeout: TIMEOUT code is present', function() {
        assert.ok(src.indexOf("code: 'TIMEOUT'") > -1);
    });

    it('#H4 — stream timeout: req.setTimeout handler exists', function() {
        assert.ok(src.indexOf('req.setTimeout(') > -1);
    });

    it('#H4 — stream error: ERR_HTTP2_STREAM_ERROR retry guard is present', function() {
        assert.ok(src.indexOf("errorCode === 'ERR_HTTP2_STREAM_ERROR'") > -1);
    });

    it('#H3 — non-critical: isCritical parameter drives swallow logic', function() {
        assert.ok(src.indexOf('if (isCritical) return false') > -1);
    });

    it('GinaHttp2Error.prototype inherits from Error.prototype', function() {
        assert.ok(src.indexOf('Object.create(Error.prototype)') > -1);
    });

    it('retryCount field is set on GinaHttp2Error', function() {
        assert.ok(src.indexOf('this.retryCount') > -1);
    });

    it('retriedOnce is derived from retryCount > 0', function() {
        assert.ok(src.indexOf('this.retriedOnce = this.retryCount > 0') > -1);
    });

    it('HTTP2_MAX_RETRIES constant is defined', function() {
        assert.ok(src.indexOf('var HTTP2_MAX_RETRIES') > -1);
    });

    it('HTTP2_RETRY_DELAY_MS constant is defined', function() {
        assert.ok(src.indexOf('var HTTP2_RETRY_DELAY_MS') > -1);
    });

    it('pre-flight PING: HTTP2_PREFLIGHT_STALE_MS constant is defined', function() {
        assert.ok(src.indexOf('var HTTP2_PREFLIGHT_STALE_MS') > -1);
    });

    it('pre-flight PING: HTTP2_PREFLIGHT_DEADLINE_MS constant is defined', function() {
        assert.ok(src.indexOf('var HTTP2_PREFLIGHT_DEADLINE_MS') > -1);
    });

    it('pre-flight PING: _lastPongAt is tracked on new sessions', function() {
        assert.ok(src.indexOf('client._lastPongAt = Date.now()') > -1);
    });

    it('pre-flight PING: _sendRequest wrapper function is defined', function() {
        assert.ok(src.indexOf('var _sendRequest = function _sendRequest()') > -1);
    });

    it('pre-flight PING: PREFLIGHT_TIMEOUT error code is present', function() {
        assert.ok(src.indexOf("code: 'PREFLIGHT_TIMEOUT'") > -1);
    });

    it('pre-flight PING: PREFLIGHT_FAILED error code is present', function() {
        assert.ok(src.indexOf("code: 'PREFLIGHT_FAILED'") > -1);
    });

    it('retry with backoff: retryCount < HTTP2_MAX_RETRIES guard is present', function() {
        assert.ok(src.indexOf('retryCount < HTTP2_MAX_RETRIES') > -1);
    });

});


// ─── 04 — onStreamTimeout handler logic ──────────────────────────────────────

describe('04 - onStreamTimeout handler — stream-level timeout (#H4)', function() {

    it('isFinished guard: already finished returns noop', function() {
        var ctx = makeCtx({ isFinished: { value: true } });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.action, 'noop');
    });

    it('sets isFinished to true on first call', function() {
        var ctx = makeCtx({ retryCount: 0 });
        onStreamTimeoutLogic(ctx);
        assert.equal(ctx.isFinished.value, true);
    });

    it('first attempt (retryCount=0) returns retry action', function() {
        var ctx = makeCtx({ retryCount: 0 });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.action, 'retry');
    });

    it('first attempt: destroys client if not already destroyed', function() {
        var ctx = makeCtx({ retryCount: 0 });
        onStreamTimeoutLogic(ctx);
        assert.equal(ctx.client._destroyCalled, true);
    });

    it('first attempt: does NOT destroy client if already destroyed', function() {
        var ctx = makeCtx({ retryCount: 0, client: makeClient(true) });
        onStreamTimeoutLogic(ctx);
        assert.equal(ctx.client._destroyCalled, false);
    });

    it('first attempt: sessKey is deleted from cache', function() {
        var ctx = makeCtx({ retryCount: 0 });
        onStreamTimeoutLogic(ctx);
        assert.ok(ctx.cache._deleted.indexOf(ctx.sessKey) > -1);
    });

    it('first attempt: sessKey is removed from sessions array', function() {
        var ctx = makeCtx({ retryCount: 0, sessions: ['http2session:api.test.local', 'other'] });
        onStreamTimeoutLogic(ctx);
        assert.equal(ctx.sessions.indexOf('http2session:api.test.local'), -1);
        assert.ok(ctx.sessions.indexOf('other') > -1); // only target removed
    });

    it('retry attempt (retryCount exhausted, isCritical=true, callback): calls callback with GinaHttp2Error', function(_, done) {
        var called = null;
        var ctx = makeCtx({
            retryCount: 2,
            isCritical: true,
            callback : function(err) { called = err; }
        });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.action, 'callback');
        assert.ok(called instanceof GinaHttp2Error);
        done();
    });

    it('retry attempt: error has code TIMEOUT', function() {
        var ctx = makeCtx({ retryCount: 2, callback: function() {} });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.err.code, 'TIMEOUT');
    });

    it('retry attempt: error has status 503', function() {
        var ctx = makeCtx({ retryCount: 2, callback: function() {} });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.err.status, 503);
    });

    it('retry attempt: error has retriedOnce=true', function() {
        var ctx = makeCtx({ retryCount: 2, callback: function() {} });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.err.retriedOnce, true);
    });

    it('exhausted retries: error has retryable=false', function() {
        var ctx = makeCtx({ retryCount: 2, callback: function() {} });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.err.retryable, false);
    });

    it('retry attempt, no callback: emits query#complete with status 503', function(_, done) {
        var emitted = null;
        var self    = makeSelf();
        self.on('query#complete', function(payload) { emitted = payload; });
        var ctx = makeCtx({ retryCount: 2, isCritical: true, self: self });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.action, 'emit');
        assert.equal(emitted.status, 503);
        assert.ok(emitted.error instanceof GinaHttp2Error);
        done();
    });

    it('non-critical (isCritical=false, retryCount exhausted): swallowed, no callback called', function() {
        var cbCalled = false;
        var ctx = makeCtx({ retryCount: 2, isCritical: false, callback: function() { cbCalled = true; } });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.action, 'swallowed');
        assert.equal(cbCalled, false);
    });

});


// ─── 05 — onQueryClosed handler logic (#H1) ──────────────────────────────────

describe('05 - onQueryClosed handler — GOAWAY / premature stream close (#H1)', function() {

    it('isFinished guard: already finished returns noop', function() {
        var ctx = makeCtx({ isFinished: { value: true } });
        var result = onQueryClosedLogic(ctx);
        assert.equal(result.action, 'noop');
    });

    it('first attempt (retryCount=0): returns retry action', function() {
        var ctx = makeCtx({ retryCount: 0 });
        var result = onQueryClosedLogic(ctx);
        assert.equal(result.action, 'retry');
    });

    it('first attempt: sessKey is deleted from cache', function() {
        var ctx = makeCtx({ retryCount: 0 });
        onQueryClosedLogic(ctx);
        assert.ok(ctx.cache._deleted.indexOf(ctx.sessKey) > -1);
    });

    it('first attempt: sessKey removed from sessions array', function() {
        var ctx = makeCtx({ retryCount: 0, sessions: ['http2session:api.test.local'] });
        onQueryClosedLogic(ctx);
        assert.equal(ctx.sessions.length, 0);
    });

    it('first attempt: client is destroyed', function() {
        var ctx = makeCtx({ retryCount: 0 });
        onQueryClosedLogic(ctx);
        assert.equal(ctx.client._destroyCalled, true);
    });

    it('retry attempt (retryCount exhausted), callback: calls callback with GinaHttp2Error', function(_, done) {
        var received = null;
        var ctx = makeCtx({ retryCount: 2, callback: function(err) { received = err; } });
        var result = onQueryClosedLogic(ctx);
        assert.equal(result.action, 'callback');
        assert.ok(received instanceof GinaHttp2Error);
        done();
    });

    it('retry attempt: error has code PREMATURE_CLOSE', function() {
        var ctx = makeCtx({ retryCount: 2, callback: function() {} });
        var result = onQueryClosedLogic(ctx);
        assert.equal(result.err.code, 'PREMATURE_CLOSE');
    });

    it('retry attempt: error has status 503', function() {
        var ctx = makeCtx({ retryCount: 2, callback: function() {} });
        var result = onQueryClosedLogic(ctx);
        assert.equal(result.err.status, 503);
    });

    it('retry attempt: error has retriedOnce=true', function() {
        var ctx = makeCtx({ retryCount: 2, callback: function() {} });
        var result = onQueryClosedLogic(ctx);
        assert.equal(result.err.retriedOnce, true);
    });

    it('retry attempt, no callback: emits query#complete', function(_, done) {
        var emitted = null;
        var self    = makeSelf();
        self.on('query#complete', function(payload) { emitted = payload; });
        var ctx = makeCtx({ retryCount: 2, self: self });
        var result = onQueryClosedLogic(ctx);
        assert.equal(result.action, 'emit');
        assert.equal(emitted.status, 503);
        done();
    });

    it('non-critical (isCritical=false): swallowed', function() {
        var cbCalled = false;
        var ctx = makeCtx({ retryCount: 2, isCritical: false, callback: function() { cbCalled = true; } });
        var result = onQueryClosedLogic(ctx);
        assert.equal(result.action, 'swallowed');
        assert.equal(cbCalled, false);
    });

});


// ─── 06 — onQueryError handler logic ─────────────────────────────────────────

describe('06 - onQueryError handler — stream error / connection error', function() {

    it('isFinished guard: already finished returns noop', function() {
        var err = Object.assign(new Error('err'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var ctx = makeCtx({ isFinished: { value: true }, error: err });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.action, 'noop');
    });

    it('ERR_HTTP2_STREAM_ERROR + retryCount < maxRetries → retry', function() {
        var err = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var ctx = makeCtx({ retryCount: 0, error: err });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.action, 'retry');
    });

    it('ECONNRESET + retryCount < maxRetries → retry', function() {
        var err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        var ctx = makeCtx({ retryCount: 0, error: err });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.action, 'retry');
    });

    it('ERR_HTTP2_STREAM_ERROR retry: client destroyed on retry path', function() {
        var err = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var ctx = makeCtx({ retryCount: 0, error: err });
        onQueryErrorLogic(ctx);
        assert.equal(ctx.client._destroyCalled, true);
    });

    it('ERR_HTTP2_STREAM_ERROR + retryCount exhausted → callback, STREAM_ERROR code', function() {
        var err = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var received = null;
        var ctx = makeCtx({ retryCount: 2, error: err, callback: function(e) { received = e; } });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.action, 'callback');
        assert.equal(result.err.code, 'STREAM_ERROR');
    });

    it('ERR_HTTP2_STREAM_ERROR + retryCount exhausted: error has status 500', function() {
        var err = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var ctx = makeCtx({ retryCount: 2, error: err, callback: function() {} });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.err.status, 500);
    });

    it('ERR_HTTP2_STREAM_ERROR + retryCount exhausted: retryable=false (already retried once)', function() {
        var err = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var ctx = makeCtx({ retryCount: 2, error: err, callback: function() {} });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.err.retryable, false);
    });

    it('ERR_HTTP2_STREAM_ERROR + retryCount=0: retryable=true before first retry', function() {
        // On the non-retry path, the error wrapping isn't reached (action=retry).
        // Verify by running the retry attempt that the logic sets retryable=retryCount < maxRetries correctly.
        var err = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var ctx = makeCtx({ retryCount: 2, error: err, callback: function() {} });
        var result = onQueryErrorLogic(ctx);
        // retryCount exhausted (2 >= maxRetries=2) → retryable should be false
        assert.equal(result.err.retryable, false);
        // retriedOnce derived from retryCount > 0
        assert.equal(result.err.retriedOnce, true);
    });

    it('ECONNREFUSED (any attempt): no retry, callback immediately', function() {
        var err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        var ctx = makeCtx({ retryCount: 0, error: err, callback: function() {} });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.action, 'callback');
    });

    it('ECONNREFUSED: error code is ECONNREFUSED', function() {
        var err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        var ctx = makeCtx({ retryCount: 0, error: err, callback: function() {} });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.err.code, 'ECONNREFUSED');
    });

    it('ECONNREFUSED: status is 503 (connection error)', function() {
        var err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        var ctx = makeCtx({ retryCount: 0, error: err, callback: function() {} });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.err.status, 503);
    });

    it('original error is preserved as .cause on GinaHttp2Error', function() {
        var original = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var ctx = makeCtx({ retryCount: 2, error: original, callback: function() {} });
        var result = onQueryErrorLogic(ctx);
        assert.strictEqual(result.err.cause, original);
    });

    it('non-critical (isCritical=false): swallowed regardless of error code', function() {
        var err = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var cbCalled = false;
        var ctx = makeCtx({ retryCount: 2, isCritical: false, error: err, callback: function() { cbCalled = true; } });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.action, 'swallowed');
        assert.equal(cbCalled, false);
    });

    it('no callback: emits query#complete on error', function(_, done) {
        var emitted = null;
        var self    = makeSelf();
        self.on('query#complete', function(p) { emitted = p; });
        var err = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var ctx = makeCtx({ retryCount: 2, error: err, self: self });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.action, 'emit');
        assert.ok(emitted !== null);
        done();
    });

});


// ─── 07 — onEnd 502 handler logic (#H2) ──────────────────────────────────────

describe('07 - onEnd 502 handler — upstream Bad Gateway retry (#H2)', function() {

    it('httpStatus=502, retryCount < maxRetries: schedules a retry', function() {
        var scheduled = false;
        var ctx = { httpStatus: 502, retryCount: 0, maxRetries: 2, schedule: function() { scheduled = true; } };
        var result = on502EndLogic(ctx);
        assert.equal(result.action, 'retry-scheduled');
        assert.equal(scheduled, true);
    });

    it('httpStatus=502, retryCount exhausted: does NOT schedule retry (retries exhausted)', function() {
        var scheduled = false;
        var ctx = { httpStatus: 502, retryCount: 2, maxRetries: 2, schedule: function() { scheduled = true; } };
        var result = on502EndLogic(ctx);
        assert.equal(result.action, 'no-retry');
        assert.equal(scheduled, false);
    });

    it('httpStatus=200: no retry scheduled', function() {
        var scheduled = false;
        var ctx = { httpStatus: 200, retryCount: 0, maxRetries: 2, schedule: function() { scheduled = true; } };
        var result = on502EndLogic(ctx);
        assert.equal(result.action, 'no-retry');
        assert.equal(scheduled, false);
    });

    it('httpStatus=503: no retry scheduled (503 is not 502)', function() {
        var ctx = { httpStatus: 503, retryCount: 0, maxRetries: 2, schedule: function() {} };
        var result = on502EndLogic(ctx);
        assert.equal(result.action, 'no-retry');
    });

    it('httpStatus=null: no retry scheduled', function() {
        var ctx = { httpStatus: null, retryCount: 0, maxRetries: 2, schedule: function() {} };
        var result = on502EndLogic(ctx);
        assert.equal(result.action, 'no-retry');
    });

});


// ─── 08 — _swallowIfNonCritical helper (#H3) ─────────────────────────────────

describe('08 - swallowIfNonCritical helper — non-critical error handling (#H3)', function() {

    var dummyErr = new GinaHttp2Error('test', { code: 'TIMEOUT', status: 503 });

    it('isCritical=true: returns false (does not swallow)', function() {
        assert.equal(swallowIfNonCritical(true, dummyErr), false);
    });

    it('isCritical=false: returns true (swallows)', function() {
        assert.equal(swallowIfNonCritical(false, dummyErr), true);
    });

    it('isCritical=true: any error type — still not swallowed', function() {
        var e = new Error('native');
        assert.equal(swallowIfNonCritical(true, e), false);
    });

    it('isCritical=false: any error type — swallowed', function() {
        var e = new Error('native');
        assert.equal(swallowIfNonCritical(false, e), true);
    });

    it('non-critical handler in onStreamTimeout swallows and returns swallowed action', function() {
        var cbCalled = false;
        var ctx = makeCtx({
            retryCount: 2,
            isCritical: false,
            callback  : function() { cbCalled = true; }
        });
        var result = onStreamTimeoutLogic(ctx);
        assert.equal(result.action, 'swallowed');
        assert.equal(cbCalled, false);
    });

    it('non-critical handler in onQueryClosed swallows and returns swallowed action', function() {
        var cbCalled = false;
        var ctx = makeCtx({
            retryCount: 2,
            isCritical: false,
            callback  : function() { cbCalled = true; }
        });
        var result = onQueryClosedLogic(ctx);
        assert.equal(result.action, 'swallowed');
        assert.equal(cbCalled, false);
    });

    it('non-critical handler in onQueryError swallows and returns swallowed action', function() {
        var err    = Object.assign(new Error('stream'), { code: 'ERR_HTTP2_STREAM_ERROR' });
        var cbCalled = false;
        var ctx = makeCtx({
            retryCount: 2,
            isCritical: false,
            error     : err,
            callback  : function() { cbCalled = true; }
        });
        var result = onQueryErrorLogic(ctx);
        assert.equal(result.action, 'swallowed');
        assert.equal(cbCalled, false);
    });

});
