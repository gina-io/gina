/**
 * #B541 — a couchbase connector that cannot CONNECT at boot must fail LOUDLY.
 *
 * The defect. Consumers wait on a ONE-SHOT `ready` event (`onReady()` registers
 * `self.once('ready', cb)`), and EVERY failure path in `connect()` routes to
 * `onError()`, which only re-arms a retry — it never emits. So a connector that
 * cannot reach couchbase at boot never settles: `lib/model.js`'s all-or-nothing
 * ready gate never closes, the bundle never prints the two flags
 * `bundle:start` watches for, and the CLI SIGKILLs it at ~64 s
 * (`lib/cmd/bundle/start.js`: maxRetry 15 x maxTimeout 4000 ms) with no terminal
 * error logged anywhere. Driven pre-fix on the shipped bytes of BOTH files:
 * the fail arm settled 0 times, the success arm 1 — so the zero was a real
 * absence, not a dead harness.
 *
 * The fix arms our own deadline at `init()` and, if nothing has settled by
 * then, emits the terminal error so `lib/model.js`'s existing loud path
 * (`console.error` + `process.exit(1)`) runs before the SIGKILL.
 *
 * What each arm exists for:
 *   §01 controls      — the SUCCESS arm must settle exactly once with an
 *                       instance. It is the firing control: without it, a fail
 *                       arm reading "one error" cannot be distinguished from a
 *                       harness that errors on everything. `getConfig()` is the
 *                       specific hazard — `init()` calls it inside a try whose
 *                       catch emits `ready(err)`, so an unwired harness makes
 *                       the FAIL arm settle and read as no-defect.
 *   §02 the deadline  — a boot that never connects settles EXACTLY ONCE, with
 *                       an Error naming the bundle, connector, target and the
 *                       timeout, and it reaches a `onReady()` consumer.
 *   §03 retry intact  — the deadline is NOT a retry cap: the connector still
 *                       re-attempts after the deadline has fired, and a later
 *                       success still emits. Asserted positively by counting
 *                       SDK `connect` invocations, not by absence of error.
 *   §04 no double     — a success DISARMS the deadline, so ticking well past it
 *                       adds no second settle.
 *   §05 repeat emits  — `ready` is deliberately NOT gated: `core/model/index.js`
 *                       attaches a persistent `.on('ready')` that surfaces
 *                       reconnect churn on the Inspector event signal, and both
 *                       `onReady` consumers use `once`, which already drops a
 *                       late delivery. So a reconnect must still emit.
 *   §06 source pins   — the deadline and the option default are present in BOTH
 *                       files, and the two pre-existing emits are unchanged.
 *   §07 schema        — `readyTimeout` is documented where consumers configure it.
 *
 * Harness notes:
 *   - The SDK is a PROJECT-side require (`connector.v*.js:7` reads
 *     `getPath('project') + '/node_modules/couchbase'`), so it can never exist
 *     in this repo — and that is exactly what makes it injectable. Planting
 *     `<TMP>/node_modules/couchbase/` IS the seam; recipe mirrors
 *     `test/core/couchbase-concurrency.test.js`.
 *   - The stub mirrors the real SDK's failure shape: it invokes the
 *     `onBucketOpened` callback AND rejects the awaited promise. That ordering
 *     matters — the callback channel sets `self.instance = {}`, which is what
 *     stops `onError`'s `delete self.instance.reconnecting` from throwing on
 *     the promise channel.
 *   - Timers are mocked. `onError` arms a retry whose handle it does not store,
 *     so a real 5 s chain would re-fail and re-arm forever and the FILE would
 *     never exit. Mocked timers also make the deadline observable in
 *     milliseconds instead of tens of seconds.
 *   - In production the deadline's error reaches `lib/model.js`, which exits the
 *     process; nothing here exits, which is why §03's post-deadline recovery is
 *     observable at all.
 */
'use strict';

var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW   = path.resolve(require('../fw'));
var REPO = path.resolve(__dirname, '../..');

// ─── globals bootstrap (mirrors test/core/couchbase-concurrency.test.js) ─────
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(FW + '/helpers');
setPath('gina', { core: path.join(FW, 'core') });

// ─── throwaway project carrying the planted SDK stub ────────────────────────
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b541-'));
fs.mkdirSync(path.join(TMP, 'node_modules/couchbase'), { recursive: true });
fs.writeFileSync(
    path.join(TMP, 'node_modules/couchbase/index.js'),
    // Defers to a mutable global so each arm chooses the outcome. `Cluster` and
    // `connect` are the two members the CONNECT path reads (the query path's
    // `QueryScanConsistency` is kept so the module shape stays realistic).
    "module.exports = {\n" +
    "    QueryScanConsistency: { NotBounded: 'not_bounded', RequestPlus: 'request_plus' },\n" +
    "    Cluster: function Cluster(url) { this.url = url; },\n" +
    "    connect: function connect(url, opts, cb) { return global.__B541_CONNECT__(url, opts, cb); }\n" +
    "};\n"
);
setPath('project', TMP);
setPath('bundle',  path.join(TMP, 'bundle'));

// ─── core/gna + gina package stubs ──────────────────────────────────────────
// `connector.v*.js:8` requires `core/gna` for `lib.logger` / `lib.merge` /
// `lib.Model`, and `onConnect` calls `gina.onError(...)`.
var _inherits = require(FW + '/lib/inherits/src/main.js');
var _merge    = require(FW + '/lib/merge/src/main.js');
var ModelUtil = require(FW + '/lib/model');
var quietConsole = {
    log: function() {}, info: function() {}, debug: function() {},
    warn: function() {}, error: function() {}, emerg: function() {}
};
var registeredErrorHandlers = [];
var ginaExports = {
    lib: {
        logger: quietConsole, helpers: {}, inherits: _inherits,
        merge: _merge, Model: ModelUtil
    },
    onError: function(fn) { registeredErrorHandlers.push(fn); }
};
[ require.resolve(path.join(FW, 'core/gna')), require.resolve(REPO) ].forEach(function(id) {
    require.cache[id] = { id: id, filename: id, loaded: true, exports: ginaExports };
});

// ─── context wiring ─────────────────────────────────────────────────────────
// `init()` reads getConfig().bundle at its very first statement, INSIDE a try
// whose catch emits ready(err) — so an unwired getConfig() makes every arm
// settle and the fail arm reads as no-defect. Use the documented seam.
var BUNDLE = 'b541bundle';
var ENV     = 'dev';
setContext('__mock__', { config: function() { return { bundle: BUNDLE }; } });
setContext('bundle', BUNDLE);
setContext('env', ENV);
setContext('gina', {
    config: {
        envConf: (function() {
            var e = {}; e[BUNDLE] = {};
            // a deliberately nonexistent modelsPath keeps onConnect short
            e[BUNDLE][ENV] = { modelsPath: path.join(TMP, 'no/such/models') };
            return e;
        })()
    }
});

var FILES = {
    v4: path.join(FW, 'core/connectors/couchbase/lib/connector.v4.js'),
    v3: path.join(FW, 'core/connectors/couchbase/lib/connector.v3.js')
};

/** Strip `//` and block comments so a negative pin cannot match a commented twin. */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** A dbString shaped like a real connectors.json couchbase entry. */
function dbStringFor(name, extra) {
    var d = {
        connector: 'couchbase', database: name, protocol: 'couchbase://',
        host: '127.0.0.1', username: 'u', password: 'p'
    };
    for (var k in (extra || {})) d[k] = extra[k];
    return d;
}

/** Let queued microtasks (the awaited SDK promise) run; timers stay mocked. */
async function flush(n) {
    for (var i = 0; i < (n || 6); i++) await Promise.resolve();
}

/**
 * Boot a connector and capture BOTH channels:
 *  - `all`  : every emit, via a persistent `.on('ready')` (the #EVTBUS shape)
 *  - `once` : what an `onReady()` consumer actually receives
 * `.on` is attached BEFORE `onReady()` because `onReady()` calls `init()`, which
 * is the same order `core/model/index.js` uses.
 */
function boot(Connector, dbString) {
    var c = new Connector(dbString);
    var all = [], once = [];
    c.on('ready', function(err, inst) { all.push({ err: err, inst: inst }); });
    c.onReady(function(err, inst) { once.push({ err: err, inst: inst }); });
    return { c: c, all: all, once: once };
}

/** Fail both SDK channels the way the real SDK does; count invocations. */
function failingSdk(calls) {
    return function(url, opts, cb) {
        calls.push(url);
        var err = new Error('ECONNREFUSED ' + url);
        // callback channel FIRST — it sets self.instance = {}, which is what
        // keeps onError's `delete self.instance.reconnecting` from throwing
        // when the promise channel runs second.
        queueMicrotask(function() { cb(err, null); });
        return Promise.reject(err);
    };
}

/** Succeed: hand back a cluster whose bucket() yields a usable stand-in. */
function succeedingSdk(calls) {
    return function(url, opts, cb) {
        calls.push(url);
        var conn = {
            bucket: function() { return { name: 'b', defaultCollection: function() { return {}; } }; },
            query: function() {}, close: function() {}
        };
        queueMicrotask(function() { cb(null, conn); });
        return Promise.resolve(conn);
    };
}

after(function() {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});


// ─── 01 — controls: the harness can read a SUCCESSFUL boot ───────────────────
describe('01 - controls: a successful boot settles exactly once (firing control)', function() {

    Object.keys(FILES).forEach(function(v) {
        it(v + ': success settles once, with an instance and no error', async function(t) {
            t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
            try {
                var calls = [];
                global.__B541_CONNECT__ = succeedingSdk(calls);
                var Connector = require(FILES[v]);
                var b = boot(Connector, dbStringFor('ctl_ok_' + v, { readyTimeout: 250 }));

                await flush();

                assert.equal(b.once.length, 1, 'the onReady consumer settled exactly once');
                assert.ok(!b.once[0].err, 'no error on the success arm: ' + (b.once[0].err && b.once[0].err.message));
                assert.ok(b.once[0].inst, 'an instance was delivered');
                assert.equal(calls.length, 1, 'the SDK was reached exactly once');
                try { clearInterval(b.c.pingId); } catch (e) {}
            } finally {
                t.mock.timers.reset();
            }
        });
    });

    it('the getConfig() seam is wired — an unwired one would settle the fail arm too', function() {
        var conf = getConfig();
        assert.ok(conf && conf.bundle === BUNDLE, 'getConfig().bundle must resolve through the __mock__ seam');
    });
});


// ─── 02 — the deadline: a boot that never connects settles ONCE, with an error ─
describe('02 - #B541: a boot that cannot connect settles exactly once, loudly', function() {

    Object.keys(FILES).forEach(function(v) {
        it(v + ': emits exactly one ready carrying an Error naming the target', async function(t) {
            t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
            try {
                var calls = [];
                global.__B541_CONNECT__ = failingSdk(calls);
                var Connector = require(FILES[v]);
                var b = boot(Connector, dbStringFor('deadline_' + v, { readyTimeout: 250 }));

                await flush();
                // pre-deadline: the defect's signature — nothing has settled
                assert.equal(b.once.length, 0, 'nothing settles before the deadline (both channels only retry)');

                t.mock.timers.tick(250);
                await flush();

                assert.equal(b.once.length, 1, 'the onReady consumer settled exactly once');
                var err = b.once[0].err;
                assert.ok(err instanceof Error, 'an Error reaches the consumer, so lib/model.js exits');
                assert.equal(b.once[0].inst, null, 'no instance is handed out on the failure path');
                assert.match(err.message, /did not become ready within 0\.25s/, 'names the timeout it waited');
                assert.match(err.message, new RegExp(BUNDLE), 'names the bundle');
                assert.match(err.message, /couchbase/, 'names the connector');
                assert.match(err.message, new RegExp('deadline_' + v), 'names the database');
                assert.match(err.message, /127\.0\.0\.1/, 'names the target host');
                assert.match(err.message, /readyTimeout/, 'tells the operator which knob to raise');

                // and the deadline is the ONLY settle — not one per failed channel
                assert.equal(b.all.length, 1, 'exactly one emit total, despite two failing SDK channels');
            } finally {
                t.mock.timers.reset();
            }
        });
    });
});


// ─── 03 — the deadline is NOT a retry cap ───────────────────────────────────
describe('03 - #B541: retry survives the deadline, and a later success still emits', function() {

    Object.keys(FILES).forEach(function(v) {
        it(v + ': re-attempts after the deadline, and the recovery emits again', async function(t) {
            t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
            try {
                var calls = [];
                global.__B541_CONNECT__ = failingSdk(calls);
                var Connector = require(FILES[v]);
                var b = boot(Connector, dbStringFor('retry_' + v, { readyTimeout: 250 }));

                await flush();
                var callsBeforeDeadline = calls.length;
                assert.ok(callsBeforeDeadline >= 1, 'the SDK was reached at least once');

                t.mock.timers.tick(250);
                await flush();
                assert.equal(b.once.length, 1, 'the deadline settled the consumer');

                // POSITIVE evidence the retry is untouched: let the backoff elapse
                // and watch the SDK get called again. In production lib/model.js
                // has exited by now, which is why this is only observable here.
                global.__B541_CONNECT__ = succeedingSdk(calls);
                t.mock.timers.tick(60000);
                await flush();

                assert.ok(calls.length > callsBeforeDeadline,
                    'the connector re-attempted after the deadline (retry is not capped): ' +
                    callsBeforeDeadline + ' -> ' + calls.length);
                assert.ok(b.all.length >= 2,
                    'the later success emitted again, so a recovered connector is still observable: ' + b.all.length);
                assert.ok(!b.all[b.all.length - 1].err, 'the last emit is the successful (re)connect');
                assert.equal(b.once.length, 1, 'the one-shot consumer still received only the first settle');
                try { clearInterval(b.c.pingId); } catch (e) {}
            } finally {
                t.mock.timers.reset();
            }
        });
    });
});


// ─── 04 — a success disarms the deadline ────────────────────────────────────
describe('04 - #B541: a successful boot disarms the deadline (no second settle)', function() {

    Object.keys(FILES).forEach(function(v) {
        it(v + ': ticking far past the deadline adds no settle', async function(t) {
            t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
            try {
                var calls = [];
                global.__B541_CONNECT__ = succeedingSdk(calls);
                var Connector = require(FILES[v]);
                var b = boot(Connector, dbStringFor('disarm_' + v, { readyTimeout: 250 }));

                await flush();
                assert.equal(b.once.length, 1, 'settled on success');
                var after = b.all.length;

                t.mock.timers.tick(10000);
                await flush();

                assert.equal(b.all.length, after, 'no further emit — the deadline was cleared, not merely ignored');
                assert.ok(!b.once[0].err, 'and the consumer never saw a timeout error');
                try { clearInterval(b.c.pingId); } catch (e) {}
            } finally {
                t.mock.timers.reset();
            }
        });
    });
});


// ─── 05 — repeat emits are preserved (the #EVTBUS churn signal) ─────────────
describe('05 - #B541: ready is NOT gated — a reconnect still emits', function() {

    Object.keys(FILES).forEach(function(v) {
        it(v + ': a second successful connect emits ready again', async function(t) {
            t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
            try {
                var calls = [];
                global.__B541_CONNECT__ = succeedingSdk(calls);
                var Connector = require(FILES[v]);
                var dbString = dbStringFor('churn_' + v, { readyTimeout: 250 });
                var b = boot(Connector, dbString);

                await flush();
                assert.equal(b.all.length, 1, 'first (re)connect emitted');

                // drive a reconnect the way onError's retry and ping() both do
                b.c.connect(dbString);
                await flush();

                assert.equal(b.all.length, 2,
                    'the persistent .on(ready) listener sees the reconnect — core/model/index.js ' +
                    'bridges these onto the Inspector event signal, so gating the emit would ' +
                    'silently kill that signal');
                assert.equal(b.once.length, 1, 'while the one-shot consumer is unaffected');
                try { clearInterval(b.c.pingId); } catch (e) {}
            } finally {
                t.mock.timers.reset();
            }
        });
    });
});


// ─── 06 — source pins, both files ───────────────────────────────────────────
describe('06 - #B541: source pins (both files, comments stripped)', function() {

    var srcs = {}, stripped = {};
    before(function() {
        Object.keys(FILES).forEach(function(v) {
            srcs[v] = fs.readFileSync(FILES[v], 'utf8');
            stripped[v] = stripComments(srcs[v]);
        });
    });

    Object.keys(FILES).forEach(function(v) {

        it(v + ': arms a deadline in init() and defaults readyTimeout to 50000', function() {
            // raw guard: the tokens must exist, so a broken strip cannot pass vacuously
            assert.ok(srcs[v].indexOf('readyTimeout') > -1, 'raw source carries readyTimeout');
            assert.ok(srcs[v].indexOf('onReadyDeadline') > -1, 'raw source carries the deadline callback');

            assert.ok(/readyTimeout:\s*50000/.test(stripped[v]), 'default is 50000 ms in local.options');
            assert.ok(/setTimeout\(\s*function onReadyDeadline/.test(stripped[v]), 'the deadline is armed with a named callback');
            assert.ok(/_deadlineId\s*=\s*setTimeout/.test(stripped[v]), 'the handle is retained so it can be disarmed');
        });

        it(v + ': the deadline emits only when nothing has settled', function() {
            var s = stripped[v];
            var i = s.indexOf('function onReadyDeadline');
            assert.ok(i > -1, 'deadline body found');
            var body = s.slice(i, i + 700);
            assert.ok(/if\s*\(_settled\)\s*return/.test(body), 'guards on _settled before emitting');
            assert.ok(/_markSettled\(\)/.test(body), 'records the settle so nothing else can double-fire');
            assert.ok(/self\.emit\('ready',\s*new Error/.test(body), 'emits a real Error, which is what lib/model.js exits on');
        });

        it(v + ': _markSettled disarms the timer and does NOT emit', function() {
            var s = stripped[v];
            var i = s.indexOf('var _markSettled');
            assert.ok(i > -1, '_markSettled found');
            var body = s.slice(i, s.indexOf('};', i));
            assert.ok(/clearTimeout\(_deadlineId\)/.test(body), 'disarms the deadline');
            assert.ok(/_settled\s*=\s*true/.test(body), 'records the settle');
            assert.equal(body.indexOf("emit('ready'"), -1,
                '_markSettled must NOT emit — the two pre-existing emit sites stay unconditional ' +
                'so core/model/index.js keeps seeing reconnect churn');
        });

        it(v + ': the two pre-existing emit sites are unchanged and ungated', function() {
            var s = stripped[v];
            // the success emit inside onConnect, and init()'s synchronous-throw catch
            assert.ok(s.indexOf("self.emit('ready', false, self.instance);") > -1, 'success emit intact');
            assert.ok(s.indexOf("self.emit('ready', err, null)") > -1, "init()'s catch emit intact");
            // exactly three live emits: success, the new deadline, init's catch
            var live = (s.match(/self\.emit\('ready'/g) || []).length;
            assert.equal(live, 3, 'exactly three live ready emits (success + deadline + init catch), got ' + live);
        });

        it(v + ': the reconnect backoff is NOT capped by the deadline work', function() {
            var s = stripped[v];
            var i = s.indexOf('var onError');
            assert.ok(i > -1, 'onError found');
            var body = s.slice(i, i + 2000);
            assert.ok(/setTimeout\(\s*function onRetry/.test(body), 'onError still arms a retry');
            assert.equal(body.indexOf('_settled'), -1,
                'the retry path must not consult _settled — D1 keeps reconnect uncapped after a settle');
        });
    });
});


// ─── 07 — the option is documented where consumers set it ───────────────────
describe('07 - #B541: readyTimeout is documented in the connectors schema', function() {

    it('schema/connectors.json documents readyTimeout with its default', function() {
        var schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema/connectors.json'), 'utf8'));
        var props = schema.definitions.connector.properties;
        assert.ok(props.readyTimeout, 'readyTimeout is a documented connector property');
        assert.equal(props.readyTimeout.type, 'number');
        assert.equal(props.readyTimeout.default, 50000);
        assert.match(props.readyTimeout.description, /millisecond/i, 'states the unit');
        // control: the sibling couchbase option is still there, so the lookup path is right
        assert.ok(props.pingInterval, 'control: pingInterval still resolves at the same path');
    });
});


// ─── 08 — one failed attempt reports exactly once (#B541 commit 2) ───────────
describe('08 - #B541: one failed connect attempt reports exactly once', function() {

    /**
     * The real SDK settles BOTH channels on failure — it invokes the
     * onBucketOpened callback AND rejects the awaited promise — so `onError`
     * used to run twice per attempt, arming two retry chains that each armed
     * two more, and double-counting the backoff counter.
     *
     * `self._reconnectAttempts` is incremented once per `onError` invocation, so
     * it reads the double-report directly, with no timer ticking. Measured on
     * the pre-fix bytes: 2 for this shape, and `undefined` for the
     * rejection-only shape below.
     */
    function bothChannels(calls) {
        return function(url, opts, cb) {
            calls.push(url);
            var err = new Error('ECONNREFUSED ' + url);
            queueMicrotask(function() { cb(err, null); });
            return Promise.reject(err);
        };
    }

    /**
     * A rejection that never calls back. Only the callback channel assigns
     * `self.instance`, which is not initialised at construction — so pre-fix
     * `onError` threw on `delete self.instance.reconnecting` at its first
     * statement, counted nothing, armed NO retry and emitted nothing. The throw
     * surfaced only as an unhandled rejection of the bare `self.connect()` call.
     */
    function rejectOnly(calls) {
        return function(url, opts, cb) {
            calls.push(url);
            return Promise.reject(new Error('ECONNREFUSED ' + url));
        };
    }

    [['both SDK channels fail', bothChannels], ['the SDK rejects without calling back', rejectOnly]]
    .forEach(function(shape) {
        Object.keys(FILES).forEach(function(v) {
            it(v + ': ' + shape[0] + ' — reports once and arms one retry', async function(t) {
                t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
                try {
                    var calls = [];
                    global.__B541_CONNECT__ = shape[1](calls);
                    var Connector = require(FILES[v]);
                    // deadline parked far away so this arm measures onError alone
                    var b = boot(Connector, dbStringFor('dbl_' + v, { readyTimeout: 3000000 }));

                    await flush(10);

                    assert.equal(calls.length, 1, 'exactly one SDK attempt was made');
                    assert.equal(b.c._reconnectAttempts, 1,
                        'the attempt reported exactly once — 2 means both SDK channels reported ' +
                        'and two retry chains are now racing; undefined means onError threw on ' +
                        'self.instance before arming any retry');
                    assert.equal(b.once.length, 0, 'and nothing settled, which is what the deadline exists for');
                } finally {
                    t.mock.timers.reset();
                }
            });
        });
    });
});
