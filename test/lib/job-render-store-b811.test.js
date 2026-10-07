/**
 * #B811 — a queued job runs with NO render store.
 *
 * `process.gina._renderALS` is the store a render delegate enters around a
 * render. It carries that request's `{ options, isProxyHost, throwError, req,
 * res }`, and it is the FIRST place the template filters (`getUrl`,
 * `getWebroot`, `t`, `tIcu`) look for their context. `lib/job` detached a job
 * from the REQUEST store (`process.gina._reqALS`, #B543) and left this one
 * alone, so a job kept the render store of the async chain that started it —
 * measured on the real module, `maxConcurrency: 1`:
 *
 *   - a job created in a frame that carried a render store ran with it: that
 *     request's `req` / `res`, after its response had gone out;
 *   - under a busy worker, the job drained next from that job's settle chain
 *     ran with it too — a job created by ANOTHER request, or by no request at
 *     all — and so did its retry.
 *
 * A template filter called inside such a job resolved that request's context,
 * even when the job had passed a context of its own to the filter factory: the
 * render store is read before anything a factory call binds. § 05 reads the
 * host of the URL the filter built, on the real filters.
 *
 * The fix: `runInRequestContext()` — the wrapper `runOne()` puts around a
 * job's whole lifecycle — also runs the job with NO render store, through
 * `runWithoutRenderStore()`: `_renderALS.run(undefined, …)`, a `run` and not a
 * plain call for the reason #B543 gives. Nothing is read off the store and
 * nothing is copied onto the job; a job that needs a render context enters one
 * itself, inside its deferred function (§ 04, a control).
 *
 * WHAT THIS FILE IS. The REAL `lib/job` under real `AsyncLocalStorage` stores.
 * Each simulated request, and each caller with no request, starts from its own
 * fresh async resource, spawned from a context no store was ever entered into
 * — as a real request starts from its own I/O callback. One resource per actor
 * matters: where AsyncLocalStorage rides async_hooks, `enterWith()` binds to
 * the current async resource, so a shared root would carry one scene's render
 * store into the next.
 *
 * The scenes hold the single worker with a LATCH, never a timer, so the order
 * « A1 is running, then the next job is queued » does not depend on the load.
 *
 * The two stores are installed AFTER `lib/job` is loaded, as in a bundle (the
 * render store is created lazily by the first render): an implementation that
 * resolved either at module load would turn every arm of §§ 02–03 red.
 *
 * Module-path SEAM: `GINA_JOB_MAIN` points the whole file at another copy of
 * lib/job (see job-request-context.test.js), so the red-first reading needs no
 * working-tree revert. Red-first on the pre-fix bytes: the 11 arms that carry
 * no label are red — every job read the render context named `A`, and § 05
 * built its URL from `a.example`. The 9 arms labelled CONTROL or INSTRUMENT
 * pin what the change kept, or prove a scene is what it claims to be; they are
 * green on both sides.
 *
 * HONEST SCOPE. The requests are simulated: nothing here boots a bundle or
 * opens a socket, and the render contexts are entered by the test, shaped as
 * the delegates shape them.
 */

'use strict';

var { describe, it, before, after, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var { AsyncLocalStorage, AsyncResource } = require('node:async_hooks');

var FW       = require('../fw');
var JOB_MAIN = process.env.GINA_JOB_MAIN || path.join(FW, 'lib/job/src/main');
var JOB_FILE = require.resolve(JOB_MAIN);
var job      = require(JOB_MAIN);
var SRC      = fs.readFileSync(JOB_FILE, 'utf8');

var CLEAN = new AsyncResource('b811-clean');   // no store is ever entered into it: it only spawns the actors

/** A fresh async context with no store: what a request's own I/O callback, a boot hook or a cron tick starts from. */
function actor() {
    return CLEAN.runInAsyncScope(function() { return new AsyncResource('b811-actor'); });
}

/** Strip block and line comments so a NEGATIVE pin cannot trip on prose. */
function codeOnly(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(function(l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
}
/** The text of a top-level function from its declaration to its closing `\n}` (every function pinned here closes at column 0). */
function fnBlock(src, decl) {
    var at = src.indexOf(decl);
    assert.ok(at > -1, decl + ' present');
    var end = src.indexOf('\n}', at);
    assert.ok(end > at, decl + ' closes');
    return src.slice(at, end + 2);
}

/** A request store shaped like the one core/server.js handle() enters. */
function requestStore(id) {
    return {
        req:       { url: '/' + id },
        res:       { headersSent: true },
        next:      function() {},
        requestId: id,
        startMs:   1000,
        proxy:     { isProxyHost: false, proxyHostname: null, proxyHost: 'host-' + id }
    };
}
/** A render context shaped as a delegate shapes it; `owner` names it in the readings. */
function renderContext(id) {
    return { owner: id, options: {}, isProxyHost: false, throwError: function() {}, req: { url: '/' + id }, res: { headersSent: true } };
}
/** A one-shot gate: `wait()` resolves once `open()` is called. */
function latch() {
    var open;
    var p = new Promise(function(r) { open = r; });
    return { wait: function() { return p; }, open: open };
}
/** Resolve once no job is running, queued or waiting on a retry timer (4 s guard). */
function settled() {
    return new Promise(function(resolve, reject) {
        var guard = setTimeout(function() { clearInterval(t); reject(new Error('scene did not settle')); }, 4000);
        var t = setInterval(function() {
            var s = job.stats();
            if (s.running === 0 && s.queued === 0 && s.retryWaiting === 0) { clearInterval(t); clearTimeout(guard); resolve(); }
        }, 3);
    });
}
function record(id) { return new Promise(function(r) { job.get(id, function(e, x) { r(x); }); }); }

/** What the running code sees: the request store's identity, and the render store's owner. */
function seen() {
    var q = process.gina._reqALS, v = process.gina._renderALS;
    var r = q ? q.getStore() : undefined, s = v ? v.getStore() : undefined;
    return {
        request: !q ? 'NO-ALS' : (r === undefined ? 'NO-STORE' : r.requestId + (r.detached === true ? ' (detached)' : '')),
        render:  !v ? 'NO-ALS' : (s === undefined ? 'NO-STORE' : s.owner)
    };
}

var reqALS, renderALS, hadGina, prevReqALS, prevRenderALS;

before(function() {
    hadGina = Object.prototype.hasOwnProperty.call(process, 'gina');
    process.gina = process.gina || {};
    prevReqALS    = process.gina._reqALS;
    prevRenderALS = process.gina._renderALS;
    reqALS    = new AsyncLocalStorage();
    renderALS = new AsyncLocalStorage();
    process.gina._reqALS    = reqALS;
    process.gina._renderALS = renderALS;
});
after(function() {
    if (!hadGina) { delete process.gina; return; }
    if (prevReqALS === undefined) { delete process.gina._reqALS; } else { process.gina._reqALS = prevReqALS; }
    if (prevRenderALS === undefined) { delete process.gina._renderALS; } else { process.gina._renderALS = prevRenderALS; }
});

// ─── the actors ─────────────────────────────────────────────────────────────

/** A request whose frame a render context was ENTERED into (`enterWith`), which then creates a job. */
function requestWithEnteredRender(id, fn, opts) {
    var at = {};
    actor().runInAsyncScope(function() {
        reqALS.run(requestStore(id), function() {
            renderALS.enterWith(renderContext(id));
            at.frame = seen();
            at.id    = job.create(fn, opts);
        });
    });
    return at;
}
/** A request that creates a job INSIDE a `run()` block of the render store. */
function requestInsideRenderRun(id, fn, opts) {
    var at = {};
    actor().runInAsyncScope(function() {
        reqALS.run(requestStore(id), function() {
            renderALS.run(renderContext(id), function() {
                at.frame = seen();
                at.id    = job.create(fn, opts);
            });
        });
    });
    return at;
}
/** A request that creates a job and has no render context. */
function requestThatCreates(id, fn, opts) {
    var at = {};
    actor().runInAsyncScope(function() {
        reqALS.run(requestStore(id), function() {
            at.frame = seen();
            at.id    = job.create(fn, opts);
        });
    });
    return at;
}
/** A caller with no request at all: boot, a cron task, a worker. */
function outsideAnyRequest(fn, opts) {
    var at = {};
    actor().runInAsyncScope(function() {
        at.frame = seen();
        at.id    = job.create(fn, opts);
    });
    return at;
}

/**
 * The busy worker. A1 — created by request A in a frame that carries A's render
 * context — holds the single worker until the gate opens; `queue()` creates the
 * job(s) that A1's settle chain will then drain.
 */
async function behindA1(queue, startOpts) {
    var started = latch(), gate = latch(), out = {};
    job.start(Object.assign({ maxConcurrency: 1, sweepInterval: 0 }, startOpts || {}));
    out.atA1 = requestWithEnteredRender('A', function() { out.A1 = seen(); started.open(); return gate.wait(); });
    await started.wait();                       // A1 is running and holds the worker
    queue(out);
    gate.open();
    await settled();
    return out;
}

// ─── 01 — source pins ───────────────────────────────────────────────────────

describe('job-render-store § 01 — source pins', function() {

    it('runWithoutRenderStore() runs cb under NO render store, and never reads the store it clears', function() {
        var code = codeOnly(fnBlock(SRC, 'function runWithoutRenderStore('));
        assert.ok(code.indexOf('process.gina._renderALS') > -1, 'the render store is resolved inside the helper — at RUN time, not at module load');
        assert.ok(code.indexOf('als.run(undefined, cb)') > -1, 'run(undefined) rather than a plain call — a plain call inherits the pump\'s store');
        assert.ok(code.indexOf('if (!als) return cb();') > -1, 'no render store in the process ⇒ plain call');
        assert.ok(code.indexOf('getStore') === -1, 'nothing is read off the render store: no part of a render context is copied onto a job');
    });

    it('runInRequestContext() enters the request context INSIDE it, so one wrapper scopes both stores', function() {
        var code  = codeOnly(fnBlock(SRC, 'function runInRequestContext('));
        var outer = code.indexOf('runWithoutRenderStore(');
        var inner = code.indexOf('als.run(context || undefined, cb)');
        assert.ok(outer > -1, 'the render store is cleared for the job');
        assert.ok(inner > outer, 'and the job\'s own request context is entered inside that');
    });
});

// ─── behavioural arms — the real module under real AsyncLocalStorage stores ──

describe('job-render-store §§ 02–04 — the scenes', function() {

    beforeEach(function() { job.reset(); });
    afterEach(function()  { job.reset(); });

    describe('§ 02 — a job created in a frame that carries a render store', function() {

        it('entered with enterWith() (the default swig delegate\'s entry): the job runs with no render store', async function() {
            var out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            requestWithEnteredRender('A', function() { out.J = seen(); });
            await settled();
            assert.equal(out.J.render, 'NO-STORE', 'the job must not keep the render context of the request that created it');
        });

        it('inside a run() block (the other delegates\' entry, or an application\'s own): the job runs with no render store', async function() {
            var out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            requestInsideRenderRun('A', function() { out.J = seen(); });
            await settled();
            assert.equal(out.J.render, 'NO-STORE');
        });

        it('INSTRUMENT: in both scenes the creating frame did carry A\'s render context', async function() {
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            var entered = requestWithEnteredRender('A', function() {});
            var inRun   = requestInsideRenderRun('A', function() {});
            await settled();
            assert.deepEqual(entered.frame, { request: 'A', render: 'A' });
            assert.deepEqual(inRun.frame,   { request: 'A', render: 'A' });
        });

        it('CONTROL: the job still runs inside its creator\'s DETACHED request context (#B543)', async function() {
            var out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            requestWithEnteredRender('A', function() { out.J = seen(); });
            await settled();
            assert.equal(out.J.request, 'A (detached)');
        });
    });

    describe('§ 03 — the bleed: a job drained from another job\'s settle chain', function() {

        it("a job created by ANOTHER request, which has no render context, runs with none — not with A's", async function() {
            var out = await behindA1(function(o) {
                o.atB1 = requestThatCreates('B', function() { o.B1 = seen(); });
            });
            assert.equal(out.B1.render, 'NO-STORE', "B's job must not see the render context of the request whose job freed the worker");
        });

        it("a job created outside any request runs with no render store — not with A's", async function() {
            var out = await behindA1(function(o) {
                o.atN = outsideAnyRequest(function() { o.N = seen(); });
            });
            assert.equal(out.N.render, 'NO-STORE');
        });

        it('a retried job runs with no render store on BOTH attempts — the one drained from A1, and the one its backoff timer re-queues', async function() {
            var out = await behindA1(function(o) {
                o.R   = [];
                o.atR = requestThatCreates('B', function() {
                    o.R.push(seen());
                    if (o.R.length === 1) throw new Error('first attempt fails');
                }, { maxAttempts: 2 });
            }, { retryBackoffMs: 1 });
            assert.deepEqual(out.R.map(function(s) { return s.render; }), ['NO-STORE', 'NO-STORE'], 'two attempts ran, neither under A\'s render context');
        });

        it('A1 itself — the job that holds the worker — runs with no render store', async function() {
            var out = await behindA1(function() {});
            assert.equal(out.A1.render, 'NO-STORE');
        });

        it('INSTRUMENT: A1 was created in a frame carrying A\'s render context, the queued jobs in frames carrying none', async function() {
            var out = await behindA1(function(o) {
                o.atB1 = requestThatCreates('B', function() {});
                o.atN  = outsideAnyRequest(function() {});
            });
            assert.deepEqual(out.atA1.frame, { request: 'A',        render: 'A' });
            assert.deepEqual(out.atB1.frame, { request: 'B',        render: 'NO-STORE' });
            assert.deepEqual(out.atN.frame,  { request: 'NO-STORE', render: 'NO-STORE' });
        });

        it('CONTROL: every job of the scene keeps its OWN request context (#B543), and the retry contract is untouched', async function() {
            var out = await behindA1(function(o) {
                o.atB1 = requestThatCreates('B', function() { o.B1 = seen(); });
                o.atN  = outsideAnyRequest(function() { o.N = seen(); });
                o.R    = [];
                o.atR  = requestThatCreates('C', function() {
                    o.R.push(seen());
                    if (o.R.length === 1) throw new Error('first attempt fails');
                }, { maxAttempts: 2 });
            }, { retryBackoffMs: 1 });
            assert.equal(out.A1.request, 'A (detached)');
            assert.equal(out.B1.request, 'B (detached)');
            assert.equal(out.N.request,  'NO-STORE');
            assert.deepEqual(out.R.map(function(s) { return s.request; }), ['C (detached)', 'C (detached)']);
            var rec = await record(out.atR.id);
            assert.equal(rec.state, 'completed');
            assert.equal(rec.attempts, 2);
        });
    });

    describe('§ 04 — what the change kept, and the processes that hold one store only', function() {

        it('CONTROL: a job may enter a render store ITSELF — the code it wraps keeps it across an await', async function() {
            var out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            requestThatCreates('A', function() {
                return renderALS.run(renderContext('JOB'), async function() {
                    out.entered = seen();
                    await new Promise(function(r) { setImmediate(r); });
                    out.afterAwait = seen();
                });
            });
            await settled();
            assert.equal(out.entered.render, 'JOB');
            assert.equal(out.afterAwait.render, 'JOB');
        });

        it('CONTROL: a render store a job entered itself does not reach the job drained after it', async function() {
            var started = latch(), gate = latch(), out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            requestThatCreates('A', function() {
                return renderALS.run(renderContext('JOB'), function() { started.open(); return gate.wait(); });
            });
            await started.wait();
            requestThatCreates('B', function() { out.next = seen(); });
            gate.open();
            await settled();
            assert.deepEqual(out.next, { request: 'B (detached)', render: 'NO-STORE' });
        });

        it('CONTROL: an idle worker runs the job of a request that has no render context with no render store', async function() {
            var out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            var at = requestThatCreates('C', function() { out.J = seen(); });
            await settled();
            assert.deepEqual(at.frame, { request: 'C', render: 'NO-STORE' });
            assert.deepEqual(out.J,    { request: 'C (detached)', render: 'NO-STORE' });
        });

        it('CONTROL: with NO render store in the process, a job still runs in its detached request context and completes', async function() {
            var out = {}, at;
            delete process.gina._renderALS;
            try {
                job.start({ maxConcurrency: 1, sweepInterval: 0 });
                at = requestThatCreates('C', function() { out.J = seen(); return 'ok'; });
                await settled();
            } finally {
                process.gina._renderALS = renderALS;
            }
            assert.deepEqual(out.J, { request: 'C (detached)', render: 'NO-ALS' });
            assert.equal((await record(at.id)).state, 'completed');
        });

        it('with a render store but NO request store in the process, the job still runs with no render store, and completes', async function() {
            var out = {}, at = {};
            delete process.gina._reqALS;
            try {
                job.start({ maxConcurrency: 1, sweepInterval: 0 });
                actor().runInAsyncScope(function() {
                    renderALS.enterWith(renderContext('A'));
                    at.frame = seen();
                    at.id    = job.create(function() { out.J = seen(); return 'ok'; });
                });
                await settled();
            } finally {
                process.gina._reqALS = reqALS;
            }
            assert.deepEqual(at.frame, { request: 'NO-ALS', render: 'A' }, 'INSTRUMENT: the creating frame carried a render context');
            assert.deepEqual(out.J,    { request: 'NO-ALS', render: 'NO-STORE' });
            assert.equal((await record(at.id)).state, 'completed');
        });
    });
});

// ─── 05 — the consequence, on the real filters ──────────────────────────────

describe('job-render-store § 05 — a template filter called in a job (real lib/swig-filters)', function() {

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function confFor(bundle, port) {
        return {
            bundle   : bundle,
            bundles  : ['web', 'api'],
            hostname : 'http://localhost:' + port,
            host     : 'localhost',
            server   : { webroot: '/', protocol: 'http/1.1', scheme: 'http' },
            port     : { 'http/1.1': { http: port } },
            routing  : {}
        };
    }
    var CONF = { web: confFor('web', 3100), api: confFor('api', 3200) };
    var GINA = {
        Config: { instance: {
            allBundles : ['web', 'api'],
            bundles    : ['web', 'api'],
            env        : 'dev',
            Env        : { getConf: function(b) { return CONF[b] ? clone(CONF[b]) : null; } }
        } }
    };
    var ARGS = ['/dashboard', null, 'api'];             // a path, with the `api` bundle as its base

    /** A request as an engine hands it on: classified proxied, with ITS OWN proxy host. */
    function requestFor(host) {
        return { headers: { host: host, port: '443' }, method: 'GET', _ginaIsProxyHost: true, _ginaProxyHost: host, _ginaProxyHostname: 'https://' + host };
    }
    /** The store handle() opens for it. */
    function handleStore(req) {
        return { requestId: 'r-' + req.headers.host, startMs: Date.now(), proxy: null, req: req, res: {}, next: function() {} };
    }
    /** The context a render delegate builds for it. */
    function delegateCtx(req) {
        return { options: { conf: clone(CONF.web), rule: 'home@web', method: 'GET' }, isProxyHost: true, throwError: function() {}, req: req, res: {} };
    }
    function hostOf(url) { return String(url).replace(/^https?:\/\//, '').split('/')[0]; }

    var Factory = null, filters = null, prior = {};

    /** A boot-shaped factory call, outside any request: what the process-wide slot holds before each arm. */
    function bootStamp() {
        return actor().runInAsyncScope(function() {
            return Factory({ options: clone(CONF.web), isProxyHost: undefined });
        });
    }

    before(function() {
        prior.FWDIR = global.GINA_FRAMEWORK_DIR;
        prior.under = global._;
        global.GINA_FRAMEWORK_DIR = FW;
        if (typeof global._ !== 'function') { global._ = function(p) { return String(p); }; }
        Factory = require(path.join(FW, 'lib/swig-filters'));
        filters = bootStamp();                      // the process's first factory call
        setContext('gina', GINA);
        setContext('bundle', 'web');
    });
    after(function() {
        if (typeof prior.FWDIR === 'undefined') { delete global.GINA_FRAMEWORK_DIR; } else { global.GINA_FRAMEWORK_DIR = prior.FWDIR; }
        if (typeof prior.under === 'undefined') { delete global._; } else { global._ = prior.under; }
    });
    beforeEach(function() { job.reset(); bootStamp(); });
    afterEach(function()  { job.reset(); });

    /**
     * Runs `fn` in B's job. That job is drained from the settle chain of A's job,
     * and A's job was created in a frame carrying A's render context.
     */
    async function inJobBehindA(fn) {
        var started = latch(), gate = latch(), out = {};
        job.start({ maxConcurrency: 1, sweepInterval: 0 });
        actor().runInAsyncScope(function() {
            var reqA = requestFor('a.example');
            reqALS.run(handleStore(reqA), function() {
                renderALS.enterWith(delegateCtx(reqA));
                job.create(function() { started.open(); return gate.wait(); });
            });
        });
        await started.wait();
        actor().runInAsyncScope(function() {
            reqALS.run(handleStore(requestFor('b.example')), function() {
                job.create(function() { out.value = fn(); });
            });
        });
        gate.open();
        await settled();
        return out.value;
    }

    it('INSTRUMENT: the host in the URL names the context that was resolved', function() {
        var inRender = actor().runInAsyncScope(function() {
            return renderALS.run(delegateCtx(requestFor('a.example')), function() { return filters.getUrl.apply(filters, ARGS); });
        });
        var noContext = actor().runInAsyncScope(function() { return filters.getUrl.apply(filters, ARGS); });
        assert.equal(hostOf(inRender),  'a.example',      'inside a render context: that request\'s host');
        assert.equal(hostOf(noContext), 'localhost:3200', 'with no request and no render context: the target bundle\'s configured host');
    });

    it("a filter called in B's job, drained from the settle chain of A's job, builds its URL from no request — not from A's host", async function() {
        var url = await inJobBehindA(function() { return filters.getUrl.apply(filters, ARGS); });
        assert.notEqual(hostOf(url), 'a.example', 'the job must not resolve the context of the request whose job freed the worker');
        assert.equal(hostOf(url), 'localhost:3200', 'a job has no render context: the filter resolves as outside a request');
    });

    it("a job that calls the filter factory with a context of its own resolves that call — not A's render context", async function() {
        var url = await inJobBehindA(function() {
            var own = Factory({ options: { conf: clone(CONF.web) }, isProxyHost: false });
            return own.getUrl.apply(own, ARGS);
        });
        assert.notEqual(hostOf(url), 'a.example', 'a render store the job inherited must not win over the context the job passed');
        assert.equal(hostOf(url), 'localhost:3200');
    });
});
