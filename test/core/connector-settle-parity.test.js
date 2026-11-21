'use strict';
/**
 * #B432 — connector settlement parity: one contract, every fixed connector.
 *
 * A connector delivers its result by invoking a callback the CALLER supplied.
 * That callback is application code and can throw for reasons unrelated to the
 * query. Two shapes then ran it a SECOND time with a different payload:
 *
 *   sync   `try { cb(null, rows); } catch (e) { cb(e); }`
 *   async  `.then(function () { cb(null, rows); }).catch(function (e) { cb(e); })`
 *
 * Both delivered a success and then an error for one operation, so the
 * canonical `if (err) { return next(err); } render(data);` shape ran BOTH
 * branches — and the second call reported the caller's own exception as though
 * the database had failed.
 *
 * Shape of this file (the N-backend parity matrix):
 *   §01 harness controls  — the instrument can read CORRECT, and it can SEE a
 *                           double settle at all. Both must pass, or every
 *                           reading below is void.
 *   §02 the SPEC          — declared ONCE, run against every fixed connector.
 *                           Arms are labelled discriminating (red pre-fix) or
 *                           control (green pre-fix), because a tally of reds is
 *                           meaningless unless you know which bucket each is in.
 *   §03 broken backend    — the same spec run against a deliberately UNGUARDED
 *                           delivery, asserting the discriminating arms FAIL.
 *                           Without this, a spec every backend passes could be a
 *                           spec that asserts nothing.
 *   §04 source pins       — the guard is wired at each site, checked against
 *                           COMMENT-STRIPPED source so the fix's own prose
 *                           cannot satisfy a pin vacuously.
 *
 * Harness notes:
 *   - Boots the REAL connector against a controllable driver stub — the same
 *     approach as `couchbase-concurrency.test.js`. The connector is shipped
 *     bytes; only the driver is stubbed.
 *   - Calls the generated prototype method DIRECTLY rather than through the
 *     entity singleton. #B429 was about the shared singleton, so that test had
 *     to route through it; #B432 lives entirely in the per-call closure, so the
 *     prototype method is the honest unit and it keeps three connectors from
 *     colliding on one `EntitySuper` entry.
 *   - Callback arms CAPTURE EVERY invocation and hold a grace window before
 *     asserting. A resolve-on-first promise wrapper cannot observe a second
 *     settle — it is the defect's natural blind spot.
 *   - Every wait is BOUNDED, so a regression to a never-settling shape FAILS
 *     rather than hanging the gated suite.
 */

process.env.NODE_ENV_IS_DEV = 'false';

var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW   = path.resolve(require('../fw'));
var REPO = path.resolve(__dirname, '../..');

// ─── globals bootstrap (mirrors couchbase-concurrency.test.js) ───────────────
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(FW + '/helpers');
setPath('gina', { core: path.join(FW, 'core') });

var ginaMain  = require.resolve(REPO);
var _inherits = require(FW + '/lib/inherits/src/main.js');
var _merge    = require(FW + '/lib/merge/src/main.js');
var ModelUtil = require(FW + '/lib/model');
var commentStrip = require('../strip-comments');
if (!require.cache[ginaMain] || !require.cache[ginaMain].exports.lib) {
    require.cache[ginaMain] = {
        id: ginaMain, filename: ginaMain, loaded: true,
        exports: { lib: { logger: console, helpers: {}, inherits: _inherits, merge: _merge, Model: ModelUtil } }
    };
}

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b432-'));

/** Driver behaviour for the arm currently running. @type {{value:string}} */
var MODE = { value: 'ok' };

/** @inner @param {number} [ms=10] @returns {Promise<void>} */
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 10); }); }

/**
 * Capture EVERY invocation of a callback-style call, then settle after a grace
 * window so a SECOND (wrong) invocation is observable. A never-called callback
 * resolves `timedOut` rather than hanging the suite.
 *
 * @inner
 * @param {function(function)} run - receives the callback to hand the connector
 * @returns {Promise<{calls: Array<Array>, timedOut: boolean}>}
 */
function captureCalls(run) {
    return new Promise(function (resolve) {
        var calls = [];
        var guard = setTimeout(function () { resolve({ calls: calls, timedOut: true }); }, 3000);
        run(function () {
            calls.push(Array.prototype.slice.call(arguments));
            if (calls.length === 1) {
                setTimeout(function () { clearTimeout(guard); resolve({ calls: calls, timedOut: false }); }, 250);
            }
        });
    });
}

/**
 * Write a throwaway bundle for one connector and return its query-method handle.
 *
 * @inner
 * @param {object} b - backend descriptor
 * @returns {function} the generated prototype method (shipped bytes)
 */
function mount(b) {
    var root = path.join(TMP, b.name);
    fs.mkdirSync(path.join(root, 'bundle/models/db/entities'), { recursive: true });
    fs.mkdirSync(path.join(root, 'bundle/models/db/' + b.queryDir + '/thing'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bundle/models/db/entities/thing.js'),
        'function Thing(conn) {}\nmodule.exports = Thing;\n');
    fs.writeFileSync(path.join(root, 'bundle/models/db/' + b.queryDir + '/thing/getRecord' + b.queryExt), b.queryBody);
    setPath('project', root);
    setPath('bundle', path.join(root, 'bundle'));
    var Ctor = require(path.join(FW, b.src));
    var entities = new Ctor(b.conn, { database: 'db', model: 'model', bundle: 'bundle', scope: 'local' });
    assert.ok(entities.Thing, b.name + ': harness fault — the entity was not built');
    assert.equal(typeof entities.Thing.prototype.getRecord, 'function',
        b.name + ': harness fault — the query method was not attached');
    return entities.Thing.prototype.getRecord;
}

// ─── the three connectors fixed in this commit ───────────────────────────────
var BACKENDS = [
    {
        name: 'sqlite',
        src : 'core/connectors/sqlite/index.js',
        queryDir: 'sql', queryExt: '.sql',
        queryBody: '/**\n * @param {string} $key\n * @return {Array}\n */\nSELECT * FROM thing WHERE key = ?\n',
        conn: {
            prepare: function () {
                return {
                    all: function () { if (MODE.value === 'fail') { throw new Error('driver-boom'); } return [{ key: 'k1' }]; },
                    get: function () { if (MODE.value === 'fail') { throw new Error('driver-boom'); } return { key: 'k1' }; },
                    run: function () { if (MODE.value === 'fail') { throw new Error('driver-boom'); } return { changes: 1 }; }
                };
            }
        },
        self: { _collection: 'thing', _scope: 'local' }
    },
    {
        name: 'mongodb',
        src : 'core/connectors/mongodb/index.js',
        queryDir: 'pipelines', queryExt: '.json',
        queryBody: '/**\n * @param {string} arg0\n * @return {object}\n */\n{ "op": "findOne", "filter": { "key": { "$arg": 0 } } }\n',
        conn: {
            collection: function () {
                return {
                    findOne: function () {
                        return MODE.value === 'fail'
                            ? Promise.reject(new Error('driver-boom'))
                            : Promise.resolve({ key: 'k1' });
                    }
                };
            }
        },
        self: { _collection: 'thing', _scope: 'local' }
    },
    {
        name: 'scylladb',
        src : 'core/connectors/scylladb/index.js',
        queryDir: 'cql', queryExt: '.sql',
        queryBody: '/**\n * @param {string} ?\n * @return {Array}\n */\nSELECT * FROM thing WHERE key = ?\n',
        conn: {
            execute: function () {
                return MODE.value === 'fail'
                    ? Promise.reject(new Error('driver-boom'))
                    : Promise.resolve({ rows: [{ key: 'k1' }] });
            }
        },
        self: { _collection: 'thing', _scope: 'local' }
    }
];

/**
 * The settlement contract, declared ONCE. Each arm states its bucket:
 * `discriminating` arms go RED on the pre-fix bytes; `control` arms stay GREEN
 * both before and after, and exist to prove the harness reads correct behaviour.
 *
 * @type {Array<{name:string, bucket:string, run:function}>}
 */
var SPEC = [
    {
        name  : 'a callback that THROWS is invoked exactly once',
        bucket: 'discriminating',
        run   : async function (call) {
            MODE.value = 'ok';
            var r = await call(function () { throw new Error('cb-boom'); });
            assert.equal(r.timedOut, false, 'the callback must be invoked at all');
            assert.equal(r.calls.length, 1, 'a throwing callback must not be re-invoked');
        }
    },
    {
        name  : 'a throwing callback is never handed a fabricated query failure',
        bucket: 'discriminating',
        run   : async function (call) {
            MODE.value = 'ok';
            var seen = [];
            var r = await call(function (err) { seen.push(err); throw new Error('cb-boom'); });
            assert.equal(r.calls.length, 1);
            assert.ok(!(seen[0] instanceof Error),
                'the single settle is the SUCCESS; the caller\'s own throw must not come back as a query error');
        }
    },
    {
        name  : 'a FAILED query settles exactly once, carrying the error',
        bucket: 'control',
        run   : async function (call) {
            MODE.value = 'fail';
            var r = await call(function () {});
            MODE.value = 'ok';
            assert.equal(r.timedOut, false);
            assert.equal(r.calls.length, 1, 'a failed query must settle once');
            assert.ok(r.calls[0][0], 'the settle carries an error');
        }
    },
    {
        name  : 'a SUCCESSFUL query settles exactly once',
        bucket: 'control',
        run   : async function (call) {
            MODE.value = 'ok';
            var r = await call(function () {});
            assert.equal(r.timedOut, false);
            assert.equal(r.calls.length, 1, 'a successful query must settle once');
            assert.ok(!r.calls[0][0], 'success reports no error');
        }
    }
];

// ─── §01 harness controls ────────────────────────────────────────────────────
describe('01 - harness controls (an instrument that cannot fail is not one)', function () {

    it('captureCalls SEES a second invocation', async function () {
        var r = await captureCalls(function (cb) { cb(null, 1); cb(new Error('second')); });
        assert.equal(r.calls.length, 2, 'the harness must be able to observe a double settle');
    });

    it('captureCalls reads a single invocation as one', async function () {
        var r = await captureCalls(function (cb) { cb(null, 1); });
        assert.equal(r.calls.length, 1);
        assert.equal(r.timedOut, false);
    });

    it('captureCalls FAILS (does not hang) when the callback is never invoked', async function () {
        var r = await captureCalls(function () {});
        assert.equal(r.timedOut, true, 'a never-settling shape must time out, not hang the suite');
    });
});

// ─── §02 the spec, against every fixed connector ─────────────────────────────
BACKENDS.forEach(function (b) {
    describe('02 - settlement parity [' + b.name + ']', function () {

        var method;
        before(function () { method = mount(b); });

        SPEC.forEach(function (arm) {
            it(arm.name + '  (' + arm.bucket + ')', async function () {
                await arm.run(function (userCb) {
                    return captureCalls(function (cb) {
                        method.call(b.self, 'k1', function () {
                            cb.apply(null, arguments);
                            userCb.apply(null, arguments);
                        });
                    });
                });
            });
        });
    });
});

// ─── §03 broken backend — proves the discriminating arms discriminate ────────
describe('03 - the spec run against an UNGUARDED delivery must FAIL', function () {

    /**
     * A faithful replica of the PRE-fix delivery shape: the callback is invoked
     * inside a `try`, and the `catch` invokes it again. Nothing here is shipped
     * code — its only job is to prove the spec's arms can go red.
     *
     * @inner
     * @param {function} cb - the caller's callback
     * @returns {void}
     */
    function unguardedDelivery(cb) {
        try {
            cb(null, [{ key: 'k1' }]);
        } catch (e) {
            cb(new Error('[ replica ] ' + e.message));
        }
    }

    /**
     * Throw on the FIRST invocation only. A callback that throws every time makes
     * the replay's own throw escape `unguardedDelivery` and reject the capture
     * promise before any assertion runs — which reads as a failing control while
     * actually measuring the harness. Throwing once keeps the second (wrong)
     * settle observable, which is the whole point of this section.
     *
     * @inner
     * @param {function} cb - the capture sink
     * @returns {function} a callback that throws exactly once
     */
    function throwsOnce(cb) {
        var n = 0;
        return function () {
            cb.apply(null, arguments);
            if (++n === 1) { throw new Error('cb-boom'); }
        };
    }

    it('the throwing-callback arm goes RED on an unguarded delivery', async function () {
        var r = await captureCalls(function (cb) { unguardedDelivery(throwsOnce(cb)); });
        assert.equal(r.calls.length, 2,
            'the unguarded shape MUST invoke the callback twice — if it does not, the arms above assert nothing');
    });

    it('the second (wrong) settle carries a fabricated query failure', async function () {
        var r = await captureCalls(function (cb) { unguardedDelivery(throwsOnce(cb)); });
        assert.ok(r.calls[1][0] instanceof Error, 'the replay hands the caller an Error');
        assert.match(r.calls[1][0].message, /cb-boom/,
            'and it is the CALLER\'S OWN exception, dressed as a query error');
    });
});

// ─── §04 source pins ─────────────────────────────────────────────────────────
describe('04 - the guard is wired at each fixed site (source pins)', function () {

    /**
     * Strip BOTH comment forms. The fix's own comments name the defect and the
     * removed shape, so an unstripped negative pin would match the prose.
     *
     * @inner
     * @param {string} t - raw source
     * @returns {string} source with block and line comments removed
     */
    function live(t) {
        return commentStrip.lines(t);
    }

    var FILES = ['sqlite', 'mongodb', 'scylladb'].map(function (n) {
        return { name: n, src: fs.readFileSync(path.join(FW, 'core/connectors/' + n + '/index.js'), 'utf8') };
    });

    FILES.forEach(function (f) {
        var liveSrc = live(f.src);

        it(f.name + ': the comment strip is real AND does not eat live code', function () {
            // NB: the needle must live ONLY in a full-line comment. `#B432` does not
            // qualify — it also tags the require line as a TRAILING comment, which
            // this strip deliberately does not remove (stripping trailing `//` would
            // eat `://` inside string literals).
            assert.equal(liveSrc.indexOf('per-call guard'), -1, 'block/line comments are stripped');
            assert.ok(liveSrc.indexOf("require('./../settle-once')") > -1, 'live code survives the strip');
            assert.ok(liveSrc.length > f.src.length * 0.3, 'the strip must not blank the file');
        });

        it(f.name + ': requires the shared guard', function () {
            assert.match(liveSrc, /var settleOnce\s*=\s*require\('\.\/\.\.\/settle-once'\);/);
        });

        it(f.name + ': builds the guard PER CALL, not at module scope', function () {
            var decl = liveSrc.indexOf('var _deliver = settleOnce(');
            assert.ok(decl > -1, 'a per-call guard is built');
            var proto = liveSrc.indexOf('prototype[name] = function()');
            assert.ok(proto > -1 && decl > proto,
                'the guard must be built inside the entity method — a module-scope guard would let the FIRST call suppress every later one');
        });

        it(f.name + ': no live settle bypasses the guard on the callback path', function () {
            assert.equal(liveSrc.indexOf('_mainCallback(null, raw)'), -1, 'success settles through the guard');
            assert.equal(liveSrc.indexOf('_mainCallback(null, result)'), -1, 'success settles through the guard');
            assert.equal(liveSrc.indexOf('_mainCallback(lib.connectorError.stamp('), -1, 'errors settle through the guard');
        });
    });

    it('the shared helper never re-invokes a callback that threw', function () {
        var src = fs.readFileSync(path.join(FW, 'core/connectors/settle-once.js'), 'utf8');
        var liveSrc = live(src);
        assert.match(liveSrc, /if \(delivered\) \{[\s\S]{0,60}return false;/, 'at-most-once');
        assert.match(liveSrc, /catch \(cbErr\)/, 'a callback throw is caught');
        var cat = liveSrc.slice(liveSrc.indexOf('catch (cbErr)'));
        assert.equal(cat.indexOf('cb.apply'), -1, 'the catch must NOT call the callback again');
    });
});


// ─── §05 session-store parity — the same contract, over shipped store bytes ──
describe('05 - session stores settle their callback exactly once', function () {

    /**
     * Extract a prototype method's source and execute THOSE bytes.
     *
     * The stores are factory closures needing live config, a driver and gina
     * globals, so booting one is disproportionate for a defect that lives
     * entirely inside a method body. Extraction keeps the test on shipped bytes
     * with no drift-prone replica (the documented escape hatch for modules that
     * cannot be required in isolation).
     *
     * @inner
     * @param {string} src  - file source
     * @param {string} decl - the declaration to locate, e.g. 'Store.prototype.get = '
     * @returns {function} the compiled method, scope-injected
     */
    function extract(src, decl) {
        var at = src.indexOf(decl);
        assert.ok(at > -1, 'harness fault: declaration not found -> ' + decl);
        assert.equal(src.indexOf(decl, at + 1), -1, 'harness fault: declaration is not unique -> ' + decl);
        var i = at, depth = 0, started = false, end = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') { depth++; started = true; }
            else if (src[i] === '}') {
                depth--;
                if (started && depth === 0) { end = i; break; }
            }
        }
        assert.ok(end > -1, 'harness fault: unbalanced braces extracting ' + decl);
        var body = src.slice(at + decl.length, end + 1);
        var noop = function () {};
        return new Function('settleOnce', 'console', 'noop', 'bundle',
            'return (' + body + ');')(settleOnceReal, console, noop, 'testbundle');
    }

    var settleOnceReal = require(path.join(FW, 'core/connectors/settle-once.js'));

    var STORES = [
        {   name: 'sqlite',   file: 'sqlite/lib/session-store.js',
            decl: 'SqliteStore.prototype.get = ',
            self: { prefix: 's:', _stmtGet: { get: function () { return { data: '{"a":1}' }; } } },
            args: function (cb) { return ['sid', cb]; } },
        {   name: 'mongodb',  file: 'mongodb/lib/session-store.js',
            decl: 'MongodbStore.prototype.get = ',
            self: { _coll: { findOne: function () { return Promise.resolve({ sess: '{"a":1}' }); } } },
            args: function (cb) { return ['sid', cb]; } },
        {   name: 'scylladb', file: 'scylladb/lib/session-store.js',
            decl: 'ScylladbStore.prototype.get = ',
            self: { table: 't', client: { execute: function () { return Promise.resolve({ rows: [{ sess: '{"a":1}' }] }); } } },
            args: function (cb) { return ['sid', cb]; } },
        {   name: 'redis',    file: 'redis/lib/session-store.js',
            decl: 'RedisStore.prototype.get = ',
            self: { prefix: 's:', client: { get: function (k, cb) { cb(null, '{"a":1}'); } } },
            args: function (cb) { return ['sid', cb]; } },
        {   name: 'couchbase v3', file: 'couchbase/lib/session-store.v3.js',
            decl: 'CouchbaseStore.prototype.set = ',
            self: { prefix: 's:', ttl: 100, client: { upsert: function () { return Promise.resolve(); } } },
            args: function (cb) { return ['sid', { cookie: { maxAge: 100000 } }, cb]; } },
        {   name: 'couchbase v4', file: 'couchbase/lib/session-store.v4.js',
            decl: 'CouchbaseStore.prototype.set = ',
            self: { prefix: 's:', ttl: 100, client: { upsert: function () { return Promise.resolve(); } } },
            args: function (cb) { return ['sid', { cookie: { maxAge: 100000 } }, cb]; } }
    ];

    STORES.forEach(function (st) {
        it(st.name + ': a throwing callback is invoked exactly once  (discriminating)', async function () {
            var src = fs.readFileSync(path.join(FW, 'core/connectors/' + st.file), 'utf8');
            var method = extract(src, st.decl);
            var r = await captureCalls(function (cb) {
                // Throw on the FIRST invocation only. A callback that throws every
                // time makes the replay's own throw escape the method and reject the
                // capture promise, so the arm goes red via an escaped exception
                // rather than the assertion — red for the right reason, but it reads
                // like a harness fault. Throwing once keeps the second (wrong) settle
                // observable and makes the pre-fix failure a clean `2 !== 1`.
                var n = 0;
                var thrower = function () {
                    cb.apply(null, arguments);
                    if (++n === 1) { throw new Error('cb-boom'); }
                };
                method.apply(st.self, st.args(thrower));
            });
            assert.equal(r.timedOut, false, 'the callback must be invoked at all');
            assert.equal(r.calls.length, 1, 'a throwing store callback must not be re-invoked by the method error path');
        });
    });

    it('EVERY guarded store method wraps fn BEFORE any settle (wrap census)', function () {
        var FILES = [
            ['sqlite/lib/session-store.js', 4],
            ['mongodb/lib/session-store.js', 7],
            ['scylladb/lib/session-store.js', 7],
            ['redis/lib/session-store.js', 4],
            ['couchbase/lib/session-store.v3.js', 4],
            ['couchbase/lib/session-store.v4.js', 4]
        ];
        FILES.forEach(function (f) {
            var src = fs.readFileSync(path.join(FW, 'core/connectors/' + f[0]), 'utf8');
            var methods = src.match(/\.prototype\.[a-zA-Z]+\s*=\s*(?:async\s+)?function/g) || [];
            var wraps   = src.match(/fn = settleOnce\(/g) || [];
            assert.equal(methods.length, f[1], f[0] + ': unexpected method count — a new method may be unguarded');
            assert.equal(wraps.length, f[1], f[0] + ': every callback-taking method must wrap fn');
            // the wrap must precede the first settle in each method, or it guards nothing
            var firstWrap = src.indexOf('fn = settleOnce(');
            var firstNorm = src.indexOf("typeof fn");
            assert.ok(firstNorm > -1 && firstWrap > firstNorm, f[0] + ': the wrap must follow normalization');
        });
    });
});

// ─── §06 job-store parity — the same contract, over shipped store bytes ──────
describe('06 - job stores settle their callback exactly once', function () {

    var settleOnceReal = require(path.join(FW, 'core/connectors/settle-once.js'));

    /**
     * Extract an OBJECT-LITERAL method's source and execute THOSE bytes.
     *
     * §05's extractor cannot be reused: the session stores are prototype
     * methods reading instance state off `this`, so a stub `self` is enough.
     * The job stores are object literals over FACTORY-CLOSURE variables
     * (`stmtUpsert`, `coll`, `noop`, `STATES`) that no `this` can supply, so
     * the scope has to be injected by name — hence a second, scope-aware
     * extractor rather than a change to §05's.
     *
     * @inner
     * @param {string} src   - file source
     * @param {string} decl  - the declaration to locate, e.g. 'set: '
     * @param {object} scope - closure bindings the method body reads, by name
     * @returns {function} the compiled method, scope-injected
     */
    function extractMethod(src, decl, scope) {
        var at = src.indexOf(decl);
        assert.ok(at > -1, 'harness fault: declaration not found -> ' + decl);
        assert.equal(src.indexOf(decl, at + 1), -1, 'harness fault: declaration is not unique -> ' + decl);
        var i = at, depth = 0, started = false, end = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') { depth++; started = true; }
            else if (src[i] === '}') {
                depth--;
                if (started && depth === 0) { end = i; break; }
            }
        }
        assert.ok(end > -1, 'harness fault: unbalanced braces extracting ' + decl);
        var body  = src.slice(at + decl.length, end + 1);
        var names = Object.keys(scope);
        var args  = names.map(function (n) { return scope[n]; });
        // `new Function(array)` would pass the array as a SINGLE argument (joined
        // by commas into one parameter list, with no body). Applying the ctor
        // spreads the names, then the compiled function is called with the values.
        var ctor = Function.apply(null, names.concat(['return (' + body + ');']));
        return ctor.apply(null, args);
    }

    /** @inner @returns {object} a reporter that records instead of printing */
    function recorder() {
        var seen = [];
        return { seen: seen, error: function (m) { seen.push(String(m)); } };
    }

    var ROWS = [
        {
            name : 'sqlite set',   file: 'sqlite/lib/job-store.js',  decl: '        set: ',
            label: 'sqlite:job#set',
            scope: function (rep) {
                return { noop: function () {}, settleOnce: settleOnceReal, console: rep,
                         stmtUpsert: { run: function () { return { changes: 1 }; } } };
            },
            args : function (cb) { return ['j1', { state: 'completed', expiresAt: 1, updatedAt: 1 }, cb]; }
        },
        {
            // The most misleading pre-fix shape in the arc: the callback's own
            // throw was caught by the PARSE catch, so the caller was told the
            // stored record was corrupt.
            name : 'sqlite get',   file: 'sqlite/lib/job-store.js',  decl: '        get: ',
            label: 'sqlite:job#get',
            scope: function (rep) {
                return { noop: function () {}, settleOnce: settleOnceReal, console: rep,
                         stmtGet: { get: function () { return { record: '{"a":1}' }; } } };
            },
            args : function (cb) { return ['j1', cb]; },
            neverSays: 'could not parse'
        },
        {
            name : 'mongodb set',  file: 'mongodb/lib/job-store.js', decl: '        set: ',
            label: 'mongodb:job#set',
            scope: function (rep) {
                return { noop: function () {}, settleOnce: settleOnceReal, console: rep,
                         coll: { replaceOne: function () { return Promise.resolve(); } } };
            },
            args : function (cb) { return ['j1', { state: 'completed', expiresAt: 1, updatedAt: 1 }, cb]; }
        },
        {
            name : 'mongodb get',  file: 'mongodb/lib/job-store.js', decl: '        get: ',
            label: 'mongodb:job#get',
            scope: function (rep) {
                return { noop: function () {}, settleOnce: settleOnceReal, console: rep,
                         coll: { findOne: function () { return Promise.resolve({ record: '{"a":1}' }); } } };
            },
            args : function (cb) { return ['j1', cb]; }
        }
    ];

    ROWS.forEach(function (row) {
        it(row.name + ': a throwing callback is invoked exactly once  (discriminating)', async function () {
            var src = fs.readFileSync(path.join(FW, 'core/connectors/' + row.file), 'utf8');
            var rep = recorder();
            var method = extractMethod(src, row.decl, row.scope(rep));
            var seen = [];
            var r = await captureCalls(function (cb) {
                // Throw on the FIRST invocation only — §05's reasoning: a
                // callback that throws every time makes the replay's own throw
                // escape and read like a harness fault, instead of leaving the
                // second (wrong) settle observable as a clean `2 !== 1`.
                var n = 0;
                var thrower = function (err) {
                    seen.push(err);
                    cb.apply(null, arguments);
                    if (++n === 1) { throw new Error('cb-boom'); }
                };
                method.apply(null, row.args(thrower));
            });
            assert.equal(r.timedOut, false, 'the callback must be invoked at all');
            assert.equal(r.calls.length, 1,
                'a throwing job-store callback must not be re-invoked by the method error path');
            assert.ok(!(seen[0] instanceof Error),
                'the single settle is the SUCCESS; the caller\'s own throw must not come back as a store error');
            if (row.neverSays) {
                seen.forEach(function (e) {
                    assert.ok(!(e && String(e.message || '').indexOf(row.neverSays) > -1),
                        'the caller\'s exception must not be reported as: ' + row.neverSays);
                });
            }
            // POSITIVE evidence the guard ran, not merely an absence of a
            // second call: it reports the swallowed exception against its label.
            assert.equal(rep.seen.length, 1, 'the callback exception must be reported exactly once');
            assert.ok(rep.seen[0].indexOf(row.label) > -1,
                'the report must name the operation: ' + row.label + ' -> ' + rep.seen[0]);
            assert.ok(rep.seen[0].indexOf('cb-boom') > -1, 'the report must carry the caller\'s own throw');
        });
    });

    it('EVERY job-store method taking a callback wraps fn BEFORE any settle (wrap census)', function () {
        var FILES = [
            ['mongodb/lib/job-store.js', 'mongodb', 5],
            ['sqlite/lib/job-store.js',  'sqlite',  5]
        ];
        FILES.forEach(function (f) {
            var src = fs.readFileSync(path.join(FW, 'core/connectors/' + f[0]), 'utf8');

            // Object-literal methods at the store's own indentation. Counting
            // them (not just the wraps) is what makes a NEW unguarded method
            // fail this arm instead of passing unnoticed.
            var re = /^ {8}([a-zA-Z]+): function\(([^)]*)\)/gm;
            var methods = [], m;
            while ((m = re.exec(src)) !== null) {
                methods.push({ name: m[1], takesFn: /\bfn\b/.test(m[2]), at: m.index });
            }
            var cbMethods = methods.filter(function (x) { return x.takesFn; });
            var wraps     = src.match(/fn = settleOnce\(/g) || [];
            assert.equal(cbMethods.length, f[2],
                f[0] + ': unexpected callback-taking method count — a new method may be unguarded');
            assert.equal(wraps.length, f[2],
                f[0] + ': every callback-taking method must wrap fn');

            // Per method: the wrap must sit AFTER normalization and BEFORE the
            // method ends, and its label must name THAT method — a copy-pasted
            // label would otherwise tag every report with the wrong operation.
            cbMethods.forEach(function (meth, i) {
                var next  = methods[methods.indexOf(meth) + 1];
                var slice = src.slice(meth.at, next ? next.at : src.length);
                var norm  = slice.indexOf('typeof fn');
                var wrap  = slice.indexOf('fn = settleOnce(');
                assert.ok(norm > -1, f[0] + ' #' + meth.name + ': missing the fn normalization');
                assert.ok(wrap > -1, f[0] + ' #' + meth.name + ': missing the settleOnce wrap');
                assert.ok(wrap > norm, f[0] + ' #' + meth.name + ': the wrap must follow normalization');
                assert.ok(slice.indexOf("settleOnce('" + f[1] + ':job#' + meth.name + "'") > -1,
                    f[0] + ' #' + meth.name + ': the guard label must name this method');
            });
        });
    });
});

// ─── §07 connector open paths + the sqlite Inspector index listener ──────────
describe('07 - connector onReady and the sqlite inspector#indexes listener settle exactly once', function () {

    var settleOnceReal = require(path.join(FW, 'core/connectors/settle-once.js'));

    /**
     * Extract a declaration's function and execute THOSE bytes with a named
     * scope — the §06 extractor's shape. `onReady` is a constructor-closure
     * method over `_err` / `_client` / `_conn`, and the sqlite listener is an
     * anonymous function over `conn` / `infos` / `_liveIntrospected`; neither
     * can be reached through a booted instance without a live driver, so the
     * closure variables are injected by name.
     *
     * @inner
     * @param {string} src   - file source
     * @param {string} decl  - text immediately preceding the function, e.g. `this.onReady = `
     * @param {object} scope - closure bindings the body reads or assigns, by name
     * @returns {function} the compiled function
     */
    function extractScoped(src, decl, scope) {
        var at = src.indexOf(decl);
        assert.ok(at > -1, 'harness fault: declaration not found -> ' + decl);
        assert.equal(src.indexOf(decl, at + 1), -1, 'harness fault: declaration is not unique -> ' + decl);
        var i = at, depth = 0, started = false, end = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') { depth++; started = true; }
            else if (src[i] === '}') {
                depth--;
                if (started && depth === 0) { end = i; break; }
            }
        }
        assert.ok(end > -1, 'harness fault: unbalanced braces extracting ' + decl);
        var body  = src.slice(at + decl.length, end + 1);
        var names = Object.keys(scope);
        var ctor  = Function.apply(null, names.concat(['return (' + body + ');']));
        return ctor.apply(null, names.map(function (n) { return scope[n]; }));
    }

    /** @inner @returns {object} a logger stand-in that records `error` and swallows the rest */
    function recorder() {
        var seen = [];
        return { seen: seen, error: function (m) { seen.push(String(m)); }, debug: function () {}, warn: function () {}, info: function () {} };
    }

    /** @inner strip both comment forms so a pin cannot be satisfied by the fix's own prose */
    function liveOf(t) {
        return commentStrip.lines(t);
    }

    // ── the two connector open paths ─────────────────────────────────────────
    // `mode`: 'ok' (connect resolves) · 'connect-fails' (driver rejects) ·
    // 'ctor-failed' (`_err` already set — the synchronous early-return path).
    var CONNECTORS = [
        {   name: 'mongodb', file: 'mongodb/lib/connector.js', label: 'mongodb:connector#onReady',
            scope: function (rep, mode) {
                return {
                    _err: mode === 'ctor-failed' ? new Error('[MongodbConnector] Failed to create client: boom') : null,
                    _db: null, _dbName: 'db', console: rep, settleOnce: settleOnceReal,
                    _client: {
                        connect: function () { return mode === 'connect-fails' ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(); },
                        db: function () { return { real: true }; }
                    }
                };
            } },
        {   name: 'scylladb', file: 'scylladb/lib/connector.js', label: 'scylladb:connector#onReady',
            scope: function (rep, mode) {
                return {
                    _err: mode === 'ctor-failed' ? new Error('[ScylladbConnector] Failed to create client: boom') : null,
                    console: rep, settleOnce: settleOnceReal,
                    _conn: { _name: 'ks', connect: function () { return mode === 'connect-fails' ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(); } }
                };
            } }
    ];

    CONNECTORS.forEach(function (c) {
        function onReadyIn(mode, rep) {
            var src = fs.readFileSync(path.join(FW, 'core/connectors/' + c.file), 'utf8');
            return extractScoped(src, '    this.onReady = ', c.scope(rep, mode));
        }
        /** @inner run onReady with a handler that throws on its FIRST invocation only (see §05 for why once) */
        async function throwingHandler(mode, rep) {
            return captureCalls(function (cb) {
                var n = 0;
                onReadyIn(mode, rep)(function () {
                    cb.apply(null, arguments);
                    if (++n === 1) { throw new Error('cb-boom'); }
                });
            });
        }

        it(c.name + ': a throwing ready handler is invoked exactly once, and the single settle is the SUCCESS  (discriminating)', async function () {
            var rep = recorder();
            var r = await throwingHandler('ok', rep);
            assert.equal(r.timedOut, false, 'the handler must be invoked at all');
            assert.equal(r.calls.length, 1, 'a throwing ready handler must not be re-invoked by the connect error path');
            assert.ok(!r.calls[0][0] && r.calls[0][1], 'the one settle carries (null, conn)');
            assert.equal(rep.seen.length, 1, 'the handler exception is reported exactly once');
            assert.ok(rep.seen[0].indexOf(c.label) > -1 && rep.seen[0].indexOf('cb-boom') > -1, 'reported under the connector label: ' + rep.seen[0]);
        });

        it(c.name + ': a throwing ready handler is never handed a fabricated `Connection failed`  (discriminating)', async function () {
            var r = await throwingHandler('ok', recorder());
            r.calls.forEach(function (args) {
                assert.ok(!(args[0] && /Connection failed/.test(args[0].message)),
                    'the handler\'s own exception must not come back dressed as a connection failure: ' + (args[0] && args[0].message));
            });
        });

        it(c.name + ': a REAL connection failure settles once, carrying `Connection failed`  (control)', async function () {
            var rep = recorder();
            var r = await captureCalls(function (cb) { onReadyIn('connect-fails', rep)(cb); });
            assert.equal(r.timedOut, false);
            assert.equal(r.calls.length, 1);
            assert.match(r.calls[0][0].message, /Connection failed: ECONNREFUSED/);
            assert.equal(rep.seen.length, 0, 'a driver failure is not a handler exception');
        });

        it(c.name + ': a client construction failure settles once, synchronously  (control)', async function () {
            var rep = recorder();
            var r = await captureCalls(function (cb) { onReadyIn('ctor-failed', rep)(cb); });
            assert.equal(r.calls.length, 1);
            assert.match(r.calls[0][0].message, /Failed to create client/);
            assert.equal(rep.seen.length, 0);
        });

        it(c.name + ': wraps the ready callback at entry, and ONLY when it is a function (source pin)', function () {
            var live = liveOf(fs.readFileSync(path.join(FW, 'core/connectors/' + c.file), 'utf8'));
            assert.match(live, /var settleOnce\s*=\s*require\('\.\/\.\.\/\.\.\/settle-once'\);/, 'requires the shared guard');
            var decl = live.indexOf('this.onReady = function(fn) {');
            var wrap = live.indexOf("if (typeof fn === 'function') fn = settleOnce('" + c.label + "', fn, console);");
            var first = live.indexOf('fn(', decl);
            assert.ok(decl > -1 && wrap > decl, 'the guard is applied inside onReady');
            // an UNCONDITIONAL wrap would turn a missing callback from a loud
            // `fn is not a function` into a silent boot hang — measured
            assert.ok(wrap < first, 'the wrap precedes the first settle');
        });
    });

    // ── the sqlite Inspector index listener (synchronous driver ⇒ the settle sits INSIDE the try) ──
    function sqliteListener(rep, opts) {
        var src = fs.readFileSync(path.join(FW, 'core/connectors/sqlite/index.js'), 'utf8');
        return extractScoped(src, "process.on('inspector#indexes', ", {
            _liveIntrospected: !!opts.live, _knownIndexes: null, infos: { database: 'db' },
            console: rep, settleOnce: settleOnceReal,
            conn: { prepare: function () {
                if (opts.prepareThrows) { throw new Error('SQLITE_BUSY'); }
                return { all: function () { return []; } };
            } }
        });
    }

    it('sqlite listener: a throwing collector is invoked exactly once, with the live index payload  (discriminating)', async function () {
        var rep = recorder();
        var r = await captureCalls(function (cb) {
            var n = 0;
            sqliteListener(rep, {})(function () {
                cb.apply(null, arguments);
                if (++n === 1) { throw new Error('cb-boom'); }
            });
        });
        assert.equal(r.timedOut, false);
        assert.equal(r.calls.length, 1, 'a throwing collector must not be re-invoked by the introspection catch');
        assert.ok(!r.calls[0][0] && r.calls[0][1] === 'sqlite' && r.calls[0][2] === 'db', 'the one settle is the success payload');
        assert.equal(rep.seen.length, 1);
        assert.ok(rep.seen[0].indexOf('sqlite:inspector#indexes') > -1, 'reported under the listener label');
    });

    it('sqlite listener: an already-introspected connector answers once from cache  (control)', async function () {
        var rep = recorder();
        var r = await captureCalls(function (cb) { sqliteListener(rep, { live: true })(cb); });
        assert.equal(r.calls.length, 1);
        assert.equal(r.calls[0][1], 'sqlite');
        assert.equal(rep.seen.length, 0);
    });

    it('sqlite listener: a driver failure during introspection settles once, carrying the error  (control)', async function () {
        var rep = recorder();
        var r = await captureCalls(function (cb) { sqliteListener(rep, { prepareThrows: true })(cb); });
        assert.equal(r.calls.length, 1);
        assert.match(r.calls[0][0].message, /SQLITE_BUSY/);
        assert.equal(rep.seen.length, 0, 'a driver failure is not a collector exception');
    });

    it('sqlite listener: the collector is wrapped at listener entry, before the cache check (source pin)', function () {
        var live = liveOf(fs.readFileSync(path.join(FW, 'core/connectors/sqlite/index.js'), 'utf8'));
        var decl  = live.indexOf("process.on('inspector#indexes'");
        var wrap  = live.indexOf("_cb = settleOnce('sqlite:inspector#indexes', _cb, console);");
        var check = live.indexOf('if (_liveIntrospected)', decl);
        assert.ok(decl > -1 && wrap > decl && wrap < check, 'the wrap must sit inside the listener, ahead of the first settle');
    });
});

// ─── §08 couchbase storage-store — the exception is REPORTED, not lost or misattributed ──
describe('08 - couchbase storage-store reports a throwing callback instead of losing it', function () {

    var settleOnceReal = require(path.join(FW, 'core/connectors/settle-once.js'));
    var STORE = path.join(FW, 'core/connectors/couchbase/lib/storage-store.js');

    /** @inner §07's extractor: decl + brace match, executed with a named scope */
    function extractScoped(src, decl, scope) {
        var at = src.indexOf(decl);
        assert.ok(at > -1, 'harness fault: declaration not found -> ' + decl);
        assert.equal(src.indexOf(decl, at + 1), -1, 'harness fault: declaration is not unique -> ' + decl);
        var i = at, depth = 0, started = false, end = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') { depth++; started = true; }
            else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i; break; } }
        }
        assert.ok(end > -1, 'harness fault: unbalanced braces extracting ' + decl);
        var body = src.slice(at + decl.length, end + 1), names = Object.keys(scope);
        return Function.apply(null, names.concat(['return (' + body + ');'])).apply(null, names.map(function (n) { return scope[n]; }));
    }
    function recorder() { var seen = []; return { seen: seen, error: function (m) { seen.push(String(m)); }, warn: function () {}, debug: function () {}, info: function () {} }; }
    function liveOf(t) { return commentStrip.lines(t); }

    /**
     * Build one verb over a resolving driver stub. `withCollection` and
     * `runQuery` are the store's OWN bytes, extracted the same way, so the
     * chain a throw travels through is the shipped one.
     *
     * The `once` entry is a PRE-FIX SCOPE SHIM: the store used to bind a local
     * `once()`, and the red-first run needs those bytes to compile so the arm
     * goes red on the assertion (no report) rather than on a ReferenceError.
     * Post-fix the file no longer references `once`, and the shim is inert.
     */
    function verb(name, rep) {
        var src  = fs.readFileSync(STORE, 'utf8');
        var coll = { upsert: function () { return Promise.resolve(); } };
        var scope = {
            settleOnce: settleOnceReal, console: rep, noop: function () {},
            once: function (fn) { var called = false; return function () { if (called) { return; } called = true; return fn.apply(null, arguments); }; },
            ready: Promise.resolve(coll), bundle: 'testbundle', driverName: 'assets', bucketName: 'bk', scopeName: 'sc', collectionName: 'co',
            cluster: { query: function () { return Promise.resolve({ rows: [{ objects: 1 }] }); } },
            couchbase: { QueryScanConsistency: { NotBounded: 'nb' } },
            docIdFor: function (key) { return { id: 'doc::' + key }; }, buildDoc: function () { return {}; },
            withDurability: function (o) { return o || {}; }, statsStatement: 'SELECT 1'
        };
        scope.withCollection = extractScoped(src, '    var withCollection = ', scope);
        scope.runQuery       = extractScoped(src, '    var runQuery = ', scope);
        return extractScoped(src, '        ' + name + ': ', scope);
    }
    var ROWS = [
        { name: 'set',   args: function (cb) { return ['k', { size: 3 }, cb]; } },   // withCollection family — the exception was LOST
        { name: 'stats', args: function (cb) { return [cb]; } }                     // runQuery family — the exception was logged as `stats failed`
    ];

    ROWS.forEach(function (row) {
        it(row.name + ': a throwing callback is reported once, under the verb label  (discriminating)', async function () {
            var rep = recorder();
            var r = await captureCalls(function (cb) {
                var n = 0;
                verb(row.name, rep).apply(null, row.args(function () { cb.apply(null, arguments); if (++n === 1) { throw new Error('cb-boom'); } }));
            });
            assert.equal(r.timedOut, false);
            assert.equal(r.calls.length, 1, 'delivery count is unchanged by the conversion');
            var labelled = rep.seen.filter(function (m) { return m.indexOf('couchbase:storage#' + row.name) > -1 && m.indexOf('cb-boom') > -1; });
            assert.equal(labelled.length, 1, 'the exception must be reported exactly once under the verb label; got: ' + JSON.stringify(rep.seen));
        });
        it(row.name + ': the caller\'s exception is never logged as a store failure  (discriminating for runQuery verbs)', async function () {
            var rep = recorder();
            await captureCalls(function (cb) {
                var n = 0;
                verb(row.name, rep).apply(null, row.args(function () { cb.apply(null, arguments); if (++n === 1) { throw new Error('cb-boom'); } }));
            });
            rep.seen.forEach(function (m) {
                assert.ok(!/\] \w+ failed \(bundle/.test(m), 'the store must not attribute the caller\'s throw to itself: ' + m);
            });
        });
    });

    it('a driver failure still reaches the callback once, with no exception report  (control)', async function () {
        var rep = recorder();
        var src = fs.readFileSync(STORE, 'utf8');
        var scope = { settleOnce: settleOnceReal, console: rep, noop: function () {},
            once: function (fn) { return fn; }, ready: Promise.reject(new Error('ECONNREFUSED')),
            docIdFor: function (key) { return { id: 'doc::' + key }; }, buildDoc: function () { return {}; }, withDurability: function (o) { return o || {}; } };
        scope.ready.catch(function () {});
        scope.withCollection = extractScoped(src, '    var withCollection = ', scope);
        var r = await captureCalls(function (cb) { extractScoped(src, '        set: ', scope)('k', {}, cb); });
        assert.equal(r.calls.length, 1);
        assert.match(r.calls[0][0].message, /ECONNREFUSED/);
        assert.equal(rep.seen.length, 0);
    });

    it('EVERY callback-taking verb wraps fn at entry with its own label; the local once() is gone (wrap census)', function () {
        var src  = fs.readFileSync(STORE, 'utf8');
        var live = liveOf(src);
        assert.equal(live.indexOf('laundered into'), -1, 'the comment strip is real');
        assert.ok(src.indexOf('once') > -1, 'control: the raw text still carries the token the negative pin is about');
        assert.equal(live.indexOf('function once('), -1, 'the local guard is retired');
        assert.match(live, /var settleOnce\s*=\s*require\('\.\/\.\.\/\.\.\/settle-once'\);/);
        var re = /^ {8}([a-zA-Z]+): function\(([^)]*)\)/gm, verbs = [], m;
        while ((m = re.exec(live)) !== null) { if (/\bfn\b/.test(m[2])) { verbs.push({ name: m[1], at: m.index }); } }
        assert.equal(verbs.length, 9, 'unexpected callback-taking verb count — a new verb may be unguarded');
        verbs.forEach(function (v, i) {
            var next  = verbs[i + 1];
            var slice = live.slice(v.at, next ? next.at : live.length);
            var wrap  = slice.indexOf("fn = settleOnce('couchbase:storage#" + v.name + "', fn, console);");
            var first = slice.indexOf('fn(');
            assert.ok(wrap > -1, v.name + ': must wrap fn under its own label');
            assert.ok(first === -1 || wrap < first, v.name + ': the wrap must precede the first settle');
        });
    });
});

after(function () { fs.rmSync(TMP, { recursive: true, force: true }); });
