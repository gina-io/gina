'use strict';
/**
 * #P49 — `lib/lane`, the fast lane: the boot registry and its lints, the
 * handler context, the dispatcher and the dev-mode reload of handler modules.
 *
 * A route opts in with `param.lane` (a module under `<bundle>/lanes/`) and keeps
 * `param.control` for the name of the export that answers it. The two writers
 * (`ctx.json()`, `ctx.error()`) are driven in test/lib/lane-writers.test.js, the
 * server wiring in test/core/server-lane-dispatch.test.js, and a booted bundle
 * in test/integration/container-boot-lane.test.js.
 *
 *  §01 registerRoutes() — every refusal names the route; what a lane route may
 *      declare; the count, the registry keys and the entry shape; skipped routes.
 *  §02 lookup() — null without a lane, the registered entry itself, the
 *      `missing` placeholder.
 *  §03 LaneContext — fields, prototype-only methods, `session`, `isXMLRequest()`,
 *      `hasRole()`, `getConfig()` (view, named, clone mode, the #B66 proxy
 *      re-point), `pauseRequest()`.
 *  §04 dispatch() — sync and async handlers, `this`, a throw, a rejection, a
 *      non-Error throw, a failure after the answer, a missing or failed entry,
 *      `next` never called, the Inspector Flow bars.
 *  §05 dev-mode reload — the watcher flag, a fresh module per change, the
 *      `module.children` prune (against a control copy without the prune), a
 *      broken file and its recovery, a removed export, the no-watcher fallback,
 *      and no reload outside dev mode.
 *  §06 watchDirs() — what dev mode watches.
 *  §07 wiring pins — the registry's plain require, the GinaLib declaration, no
 *      assignment to the `headersSent` getter.
 *
 * Seam: `GINA_LANE_MAIN=<file>` loads that file instead of the tree's
 * `lib/lane`. The module is loaded on first use, so a tree without it fails
 * arm by arm instead of failing the file.
 */
var { describe, it, after, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');

var FW        = require('../fw');
var LANE_MAIN = process.env.GINA_LANE_MAIN || path.join(FW, 'lib/lane/src/main.js');
var INDEX_SRC = fs.readFileSync(path.join(FW, 'lib/index.js'), 'utf8');
var DTS_SRC   = fs.readFileSync(path.join(FW, '../../types/index.d.ts'), 'utf8');
var SCHEMA    = JSON.parse(fs.readFileSync(path.join(FW, '../../schema/routing.json'), 'utf8'));

// The lane reads NODE_ENV_IS_DEV and NODE_SCOPE_IS_LOCAL once, on first use:
// start every copy in production, non-local scope, and restore at the end.
var ENV_KEYS = ['NODE_ENV_IS_DEV', 'NODE_SCOPE_IS_LOCAL'];
var ENV0 = {};
ENV_KEYS.forEach(function (k) { ENV0[k] = process.env[k]; delete process.env[k]; });
function restoreEnv() {
    ENV_KEYS.forEach(function (k) {
        if ( typeof(ENV0[k]) == 'undefined' ) { delete process.env[k]; } else { process.env[k] = ENV0[k]; }
    });
}

var LOGGER   = require(path.join(FW, 'lib/logger'));
var CONFVIEW = require(path.join(FW, 'lib/conf-view'));


// ─── the module under test ────────────────────────────────────────────────────
var _lane = null;
/** The lane module, loaded on first use. */
function lane() {
    if ( !_lane ) { _lane = require(LANE_MAIN); }
    return _lane;
}

/**
 * A fresh copy of the lane module (it caches the dev and scope flags on first
 * use). The registry survives: it lives on `process.gina`.
 *
 * @returns {{lane: object, module: object}} the exports and the copy's `Module`
 */
function freshLane() {
    var id = require.resolve(LANE_MAIN);
    delete require.cache[id];
    var l = require(LANE_MAIN);
    return { lane: l, module: require.cache[id] };
}

/**
 * A copy of the lane whose `pruneChildren()` call is removed — the control for
 * the prune arm. Written next to the fixtures with its relative requires made
 * absolute, so it loads the same sibling modules.
 *
 * @returns {{lane: object, module: object}}
 */
function noPruneLane() {
    var src = fs.readFileSync(LANE_MAIN, 'utf8');
    src = src.replace(/require\('(\.[^']*)'\)/g, function (m, p) {
        return 'require(' + JSON.stringify(path.resolve(path.dirname(LANE_MAIN), p)) + ')';
    });
    assert.equal(( src.match(/require\("\//g) || [] ).length, 7, 'harness: the seven requires of lib/lane resolve absolutely');
    assert.equal(src.split('pruneChildren();').length - 1, 1, 'harness: one prune call to remove');
    src = src.replace('pruneChildren();', '/* prune removed: control */');
    var file = path.join(ROOT, 'lane-noprune-' + (++noPruneSeq) + '.js');
    fs.writeFileSync(file, src);
    var l = require(file);
    return { lane: l, module: require.cache[require.resolve(file)] };
}
var noPruneSeq = 0;


// ─── fixtures ─────────────────────────────────────────────────────────────────
var ROOT    = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-lane-'));
var BUNDLES = path.join(ROOT, 'src');

function write(rel, src) {
    var f = path.join(BUNDLES, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, src);
    return f;
}

write('api/lanes/users.js', [
    "'use strict';",
    "module.exports.list  = function (ctx) { ctx.json({ users: [] }); };",
    "module.exports.get   = async function (ctx) { ctx.json({ id: ctx.params.id }); };",
    "module.exports.notFn = 42;"
].join('\n'));
write('api/lanes/admin/users.js', "module.exports.list = function (ctx) { ctx.json({ admin: true }); };");
write('api/lanes/broken.js', "module.exports.list = function (ctx) {\n");
write('api/lanes/throwsAtLoad.js', "throw new Error('lane fixture fails at load');");
write('api/lanes/whole.js', "module.exports = function (ctx) { ctx.json({}); };");
write('api/lanes/behaviours.js', [
    "'use strict';",
    "function tick() { return new Promise(function (r) { setImmediate(r); }); }",
    "module.exports.sync      = function (ctx) { ctx.json({ ok: 1 }); };",
    "module.exports.whoami    = function (ctx) { ctx.json({ isModule: this === module.exports }); };",
    "module.exports.async     = async function (ctx) { await tick(); ctx.json({ ok: 2 }); };",
    "module.exports.boom      = function () { throw new Error('lane boom'); };",
    "module.exports.rej       = async function () { await tick(); throw new Error('lane rejected'); };",
    "module.exports.obj       = function () { throw { code: 42 }; };",
    "module.exports.str       = function () { throw 'plain text failure'; };",
    "module.exports.late      = function (ctx) { ctx.json({ first: true }); throw new Error('after the answer'); };",
    "module.exports.lateAsync = async function (ctx) { ctx.json({ first: true }); await tick(); throw new Error('rejected after the answer'); };",
    "module.exports.silent    = function () {};"
].join('\n'));
write('other/lanes/x.js', "module.exports.list = function (ctx) { ctx.json({ other: true }); };");

/** Drop every fixture module from the require cache (a rewritten file reloads). */
function evictFixtures() {
    var real = fs.realpathSync(ROOT);
    Object.keys(require.cache).forEach(function (id) {
        if ( id.indexOf(real) === 0 || id.indexOf(ROOT) === 0 ) { delete require.cache[id]; }
    });
}

function resetRegistry() {
    if ( process.gina ) { delete process.gina._lanes; }
}

after(function () {
    evictFixtures();
    resetRegistry();
    restoreEnv();
    fs.rmSync(ROOT, { recursive: true, force: true });
});


// ─── request / response / configuration stubs ────────────────────────────────
/** The status table as core/config.js builds it (comments and `_comment` dropped). */
function loadStatusCodes() {
    var raw  = fs.readFileSync(path.join(FW, 'core/status.codes'), 'utf8');
    var json = JSON.parse(raw.split('\n').filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n'));
    delete json._comment;
    return json;
}
var STATUS = loadStatusCodes();

function makeConf(o) {
    o = o || {};
    return {
        bundle   : 'api',
        encoding : 'utf8',
        hostname : 'http://api.local:3100',
        host     : 'api.local:3100',
        server   : {
            protocol          : o.protocol || 'http/1.1',
            coreConfiguration : { mime: { json: 'application/json' }, statusCodes: STATUS }
        },
        content  : {
            settings : o.settings || {},
            app      : { name: 'demo', nested: { a: 1 } },
            proxyable: { hostname: 'http://inner.local', host: 'inner.local' }
        }
    };
}

function makeReq(o) {
    o = o || {};
    return {
        method       : o.method || 'GET',
        url          : o.url || '/users',
        originalUrl  : o.originalUrl,
        headers      : o.headers || {},
        params       : o.params || {},
        get          : o.get || {},
        body         : o.body,
        routing      : o.routing || { rule: 'users-list@api', bundle: 'api', param: { lane: 'users', control: 'list' } },
        _ginaReqId   : o.reqId || 'REQ-1',
        culture      : o.culture,
        session      : o.session,
        machineCaller: o.machineCaller,
        isXMLRequest : o.isXMLRequest,
        _devTimeline : o.timeline
    };
}

/** An HTTP/1-shaped response: `headersSent` and `writableEnded` are getters, as on Node's. */
function makeRes() {
    var st = { headers: {}, sent: false, ended: false, body: undefined, writeHead: [], ends: 0 };
    var res = {
        statusCode    : 200,
        statusMessage : undefined,
        setHeader     : function (k, v) {
            if ( st.sent ) { throw new Error('ERR_HTTP_HEADERS_SENT'); }
            st.headers[String(k).toLowerCase()] = v;
            return this;
        },
        getHeader     : function (k) { return st.headers[String(k).toLowerCase()]; },
        getHeaders    : function () { return Object.assign({}, st.headers); },
        writeHead     : function (code, hdrs) {
            st.writeHead.push({ code: code, headers: hdrs });
            this.statusCode = code;
            for (var k in hdrs) { st.headers[k.toLowerCase()] = hdrs[k]; }
            st.sent = true;
            return this;
        },
        end           : function (chunk) {
            st.sent = true; st.ended = true; ++st.ends;
            st.body = ( chunk == null ) ? '' : String(chunk);
            return this;
        }
    };
    Object.defineProperty(res, 'headersSent',   { get: function () { return st.sent; } });
    Object.defineProperty(res, 'writableEnded', { get: function () { return st.ended; } });
    res._st = st;
    return res;
}

/** Capture (and silence) the logger the lane binds. */
function captureLogs() {
    var levels = ['info', 'warn', 'error', 'debug'];
    var saved  = {};
    var out    = { info: [], warn: [], error: [], debug: [] };
    levels.forEach(function (l) {
        saved[l]  = LOGGER[l];
        LOGGER[l] = function () { out[l].push(Array.prototype.slice.call(arguments).join(' ')); };
    });
    out.restore = function () { levels.forEach(function (l) { LOGGER[l] = saved[l]; }); };
    return out;
}

function tick() { return new Promise(function (r) { setImmediate(r); }); }
async function settle() { for (var i = 0; i < 6; ++i) { await tick(); } }

function baseRoute(over) {
    var r = { url: '/users', method: 'GET', param: { lane: 'users', control: 'list' } };
    over = over || {};
    for (var k in over) {
        if ( k === 'param' ) {
            for (var p in over.param) { r.param[p] = over.param[p]; }
        } else {
            r[k] = over[k];
        }
    }
    return r;
}

function register(routing, opt, api) {
    return ( api || lane() ).registerRoutes(routing, Object.assign({ bundle: 'api', bundlesPath: BUNDLES }, opt || {}));
}

function refuses(route, re, opt) {
    assert.throws(function () { register({ 'r1@api': route }, opt); }, function (err) {
        assert.ok(err instanceof Error, 'an Error');
        assert.equal(err.message.indexOf('[ SERVER ] Route `r1@api`'), 0, 'route-named: ' + err.message);
        assert.match(err.message, re);
        return true;
    });
}

function accepts(route, opt) {
    assert.equal(register({ 'r1@api': route }, opt), 1);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

/** Dispatch an entry on fresh stubs and capture the logs. */
function run(api, entry, reqOpt, confOpt) {
    var req  = makeReq(reqOpt);
    var res  = makeRes();
    var conf = makeConf(confOpt);
    var nexts = 0;
    var logs = captureLogs();
    var ret;
    try {
        ret = api.dispatch(entry, req, res, function () { ++nexts; }, { engine: 'stub' }, conf);
    } finally {
        logs.restore();
    }
    return {
        req   : req,
        res   : res,
        ret   : ret,
        logs  : logs,
        nexts : function () { return nexts; },
        body  : function () { return JSON.parse(res._st.body); }
    };
}

/** Run an async arm with the logger captured until `settle()` returns. */
async function runSettled(api, entry, reqOpt) {
    var req  = makeReq(reqOpt);
    var res  = makeRes();
    var nexts = 0;
    var logs = captureLogs();
    var ret;
    try {
        ret = api.dispatch(entry, req, res, function () { ++nexts; }, { engine: 'stub' }, makeConf());
        await settle();
    } finally {
        logs.restore();
    }
    return { req: req, res: res, ret: ret, logs: logs, nexts: nexts, body: function () { return JSON.parse(res._st.body); } };
}


// ─── 00 — the harness ────────────────────────────────────────────────────────
describe('#P49 lib/lane §00 — the harness (green without the lane)', function () {

    it('the status table is built as core/config.js builds it', function () {
        assert.equal(STATUS['404'], 'Not Found');
        assert.equal(STATUS['422'], 'Unprocessable Entity');
        assert.ok(!('_comment' in STATUS));
    });

    it('the fixtures are on disk and the response stub behaves like Node\'s', function () {
        assert.ok(fs.existsSync(path.join(BUNDLES, 'api', 'lanes', 'users.js')));
        assert.ok(fs.existsSync(path.join(BUNDLES, 'api', 'lanes', 'admin', 'users.js')));
        var res = makeRes();
        assert.equal(res.headersSent, false);
        res.end('x');
        assert.equal(res.headersSent, true);
        assert.throws(function () { res.headersSent = false; }, TypeError, 'a getter: assigning it throws in strict mode');
    });
});


// ─── 01 — registerRoutes() ───────────────────────────────────────────────────
describe('#P49 lib/lane §01 — registerRoutes(): the boot lints', function () {

    beforeEach(resetRegistry);

    it('control — a well-formed lane route registers', function () {
        assert.equal(register({ 'users-list@api': baseRoute() }), 1);
        assert.ok(process.gina._lanes['api::users#list'], 'registered under <bundle>::<lane>#<control>');
    });

    it('param.lane must name a module under lanes/ — traversal, absolute, hidden, empty segment, a binding, a non-string', function () {
        ['../x', '/x', './x', 'a//b', '.h', 'a/', 'a/../b', 'a:b', ':id', 'a b', 'a\\b', 42, true, {}, ['users']].forEach(function (v) {
            refuses(baseRoute({ param: { lane: v } }), /`param\.lane` must name a module under `lanes\/`/);
        });
    });

    it('isLaneName() and the published schema pattern agree', function () {
        var re = new RegExp(SCHEMA.definitions.route.properties.param.properties.lane.pattern);
        [
            'users', 'admin/users', 'v2.users', 'a-b', '_x', '0', 'a/b/c', 'users.js',
            '', '../x', '/x', './x', 'a//b', '.h', 'a/', 'a/../b', 'a:b', ':id', 'a b', 'é', '-x', 'a/-b'
        ].forEach(function (v) {
            assert.equal(lane().isLaneName(v), re.test(v), JSON.stringify(v));
        });
        assert.equal(lane().isLaneName(42), false);
        assert.equal(lane().isLaneName(null), false);
    });

    it('param.control must be a non-empty string, not a reserved action, not a redirect', function () {
        [undefined, '', 42, null].forEach(function (v) {
            refuses(baseRoute({ param: { control: v } }), /must be a non-empty string/);
        });
        ['onReady', 'setup'].forEach(function (v) {
            refuses(baseRoute({ param: { control: v } }), /`param\.control` `\w+` is reserved for the framework/);
        });
        ['redirect', 'Redirect'].forEach(function (v) {
            refuses(baseRoute({ param: { control: v } }), /marks a redirect route/);
        });
    });

    it('a rule kept for another bundle is refused; one naming its own bundle is accepted', function () {
        refuses(baseRoute({ bundle: 'other' }), /belongs to bundle `other` but is declared for bundle `api`/);
        accepts(baseRoute({ bundle: 'api' }));
    });

    it('route middleware is refused, naming routing.global.json and the middleware; an empty list is accepted', function () {
        refuses(baseRoute({ middleware: ['auth.check'] }), /cannot run route middleware[\s\S]*routing\.global\.json[\s\S]*auth\.check/);
        accepts(baseRoute({ middleware: [] }));
    });

    it('cache is refused in every truthy form; cache: false is accepted', function () {
        [{ type: 'memory', ttl: 60 }, 'memory', true].forEach(function (v) {
            refuses(baseRoute({ cache: v }), /cannot declare `cache`/);
        });
        accepts(baseRoute({ cache: false }));
    });

    it('negotiate, a namespace and a ws route are refused; an empty namespace is accepted', function () {
        refuses(baseRoute({ negotiate: true }), /cannot declare `negotiate`/);
        refuses(baseRoute({ namespace: 'v1' }), /cannot declare `namespace`/);
        accepts(baseRoute({ namespace: '' }));
        ['ws', 'WS'].forEach(function (m) {
            refuses(baseRoute({ method: m }), /`method: "ws"` route/);
        });
    });

    it('every gate key is refused and named — this slice does not run the gates', function () {
        [
            [{ param: { requireAuth: true } },             'param.requireAuth'],
            [{ param: { requireAuth: 'true' } },           'param.requireAuth'],
            [{ param: { roles: [] } },                     'param.roles'],
            [{ param: { roles: ['admin'] } },              'param.roles'],
            [{ param: { policy: 'owner' } },               'param.policy'],
            [{ rateLimit: { limit: 10, window: '1m' } },   'rateLimit'],
            [{ idempotency: true },                        'idempotency'],
            [{ idempotency: { ttl: '1h' } },               'idempotency'],
            [{ param: { messageValidator: 'pain001' } },   'param.messageValidator'],
            [{ param: { dto: 'CreateUser' } },             'param.dto']
        ].forEach(function (c) {
            refuses(baseRoute(c[0]), new RegExp('cannot declare `' + c[1].replace('.', '\\.') + '` yet[\\s\\S]*would be silently skipped'));
        });
    });

    it('several gate keys are named together, in the gate order', function () {
        refuses(
            baseRoute({ param: { dto: 'D', requireAuth: true }, idempotency: true, rateLimit: { limit: 1 } }),
            /cannot declare `param\.requireAuth`, `rateLimit`, `idempotency`, `param\.dto` yet/
        );
    });

    it('the explicit "no" values are accepted: requireAuth false, rateLimit false/null, idempotency false/null, an empty dto or messageValidator', function () {
        [
            { param: { requireAuth: false } },
            { rateLimit: false }, { rateLimit: null },
            { idempotency: false }, { idempotency: null },
            { param: { dto: '' } }, { param: { dto: null } },
            { param: { messageValidator: '' } }, { param: { messageValidator: null } }
        ].forEach(function (over) {
            resetRegistry();
            accepts(baseRoute(over));
        });
    });

    it('auth.requireAuthByDefault refuses a lane route unless it is marked public: true', function () {
        var settings = { auth: { requireAuthByDefault: true } };
        refuses(baseRoute(), /`auth\.requireAuthByDefault` gates every route not marked `"public": true`/, { settings: settings });
        refuses(baseRoute({ param: { public: 'true' } }), /requireAuthByDefault/, { settings: settings });
        accepts(baseRoute({ param: { public: true } }), { settings: settings });
        // only a literal `true` turns the mode on (the authz boot lint refuses any other type)
        accepts(baseRoute(), { settings: { auth: { requireAuthByDefault: 'true' } } });
        accepts(baseRoute(), { settings: { auth: { requireAuthByDefault: false } } });
    });

    it('a bundle-wide server.rateLimit refuses a lane route that does not declare rateLimit: false', function () {
        var server = { rateLimit: { enabled: true } };
        refuses(baseRoute(), /`server\.rateLimit` is enabled[\s\S]*"rateLimit": false/, { server: server });
        accepts(baseRoute({ rateLimit: false }), { server: server });
        accepts(baseRoute(), { server: { rateLimit: { enabled: 'true' } } });
        accepts(baseRoute(), { server: { rateLimit: { enabled: false } } });
    });

    it('a missing module is refused — with the extension hint when the name carries `.js`', function () {
        refuses(baseRoute({ param: { lane: 'nope' } }), /declares `param\.lane` `nope` but `[^`]*nope\.js` is missing\.$/);
        refuses(baseRoute({ param: { lane: 'users.js' } }), /is missing \(name the module without its `\.js` extension\)\./);
    });

    it('a module that fails to load is refused with its error', function () {
        // The runtime's own load error, whatever its class: Node throws a SyntaxError,
        // Bun a BuildMessage without a stack. The refusal must carry its message.
        var loadMsg = null;
        try { require(path.join(BUNDLES, 'api/lanes/broken.js')); } catch (err) { loadMsg = err && err.message; }
        assert.ok(typeof(loadMsg) == 'string' && loadMsg.length > 0, 'harness: requiring the broken fixture throws a message');
        refuses(baseRoute({ param: { lane: 'broken' } }), new RegExp('lane module `lanes/broken\\.js` could not be loaded[\\s\\S]*' + escapeRe(loadMsg)));
        refuses(baseRoute({ param: { lane: 'throwsAtLoad' } }), /could not be loaded[\s\S]*lane fixture fails at load/);
    });

    it('the export must be an own function named after param.control', function () {
        refuses(baseRoute({ param: { control: 'absent' } }), /does not export a function named `absent`/);
        refuses(baseRoute({ param: { control: 'notFn' } }), /does not export a function named `notFn`/);
        refuses(baseRoute({ param: { control: 'constructor' } }), /does not export a function named `constructor`/);
        refuses(baseRoute({ param: { control: 'hasOwnProperty' } }), /does not export a function named `hasOwnProperty`/);
        refuses(baseRoute({ param: { lane: 'whole', control: 'list' } }), /does not export a function named `list`/);
        refuses(baseRoute({ param: { lane: 'whole', control: 'call' } }), /does not export a function named `call`/);
    });

    it('an async function export is accepted (dispatched like an action)', function () {
        accepts(baseRoute({ param: { control: 'get' } }));
    });

    it('without the bundle name or the bundles path, a lane route is refused', function () {
        refuses(baseRoute(), /cannot resolve `lanes\/users\.js`/, { bundlesPath: '' });
        refuses(baseRoute(), /cannot resolve/, { bundlesPath: undefined });
        refuses(baseRoute(), /cannot resolve/, { bundle: '' });
    });

    it('responseDto, csrfExempt, requirements, scopes, public and a title are accepted', function () {
        accepts(baseRoute({
            param        : { responseDto: 'UserView', public: true, title: 'Users' },
            csrfExempt   : true,
            requirements : { id: '^\\d+$' },
            scopes       : ['local']
        }));
    });

    it('registers every lane route of the bundle — two exports of one module, a nested module — and returns the count', function () {
        var n = register({
            'users-list@api'  : baseRoute(),
            'users-get@api'   : baseRoute({ url: '/users/:id', param: { control: 'get' } }),
            'admin-users@api' : baseRoute({ url: '/admin/users', param: { lane: 'admin/users' } }),
            'home@api'        : { url: '/', method: 'GET', param: { control: 'home' } }
        });
        assert.equal(n, 3);
        var reg = process.gina._lanes;
        assert.equal(Object.getPrototypeOf(reg), null, 'a prototype-less map');
        assert.deepEqual(Object.keys(reg).sort(), ['api::admin/users#list', 'api::users#get', 'api::users#list']);
        var list = reg['api::users#list'];
        var get  = reg['api::users#get'];
        assert.equal(list.module, get.module, 'one module object serves both exports');
        assert.equal(list.fn, list.module.list);
        assert.equal(get.fn, get.module.get);
        assert.deepEqual(
            { lane: list.lane, control: list.control, bundle: list.bundle, rule: list.rule, error: list.error },
            { lane: 'users', control: 'list', bundle: 'api', rule: 'users-list@api', error: null }
        );
        assert.equal(list.file, path.join(BUNDLES, 'api', 'lanes', 'users.js'));
        assert.equal(list.resolved, require.resolve(list.file));
        assert.equal(reg['api::admin/users#list'].file, path.join(BUNDLES, 'api', 'lanes', 'admin', 'users.js'));
    });

    it('skips every route without a lane, and entries that are not routes', function () {
        var n = register({
            'a@api' : { url: '/a', param: { control: 'a' } },
            'b@api' : { url: '/b' },
            'c@api' : { url: '/c', param: null },
            'd@api' : { url: '/d', param: { control: 'd', lane: '' } },
            'e@api' : { url: '/e', param: { control: 'e', lane: null } },
            'f@api' : null,
            'g@api' : 'not a route'
        });
        assert.equal(n, 0);
        assert.equal(Object.keys(process.gina._lanes).length, 0);
        assert.equal(lane().registerRoutes({}, { bundle: 'api', bundlesPath: BUNDLES }), 0);
    });
});


// ─── 02 — lookup() ───────────────────────────────────────────────────────────
describe('#P49 lib/lane §02 — lookup()', function () {

    beforeEach(resetRegistry);

    it('null when the route declares no lane', function () {
        [null, undefined, {}, { param: null }, { param: {} }, { param: { lane: '' } }, { param: { lane: 42 } }].forEach(function (r) {
            assert.equal(lane().lookup(r), null, JSON.stringify(r));
        });
    });

    it('the registered entry itself — identity, not a copy', function () {
        register({ 'users-list@api': baseRoute() });
        var e = lane().lookup({ bundle: 'api', rule: 'users-list@api', param: { lane: 'users', control: 'list' } });
        assert.equal(e, process.gina._lanes['api::users#list']);
    });

    it('a `missing` placeholder when the registry does not hold the lane — never null, so the route cannot fall through to a controller', function () {
        var key = { bundle: 'api', rule: 'x@api', param: { lane: 'users', control: 'list' } };
        assert.deepEqual(lane().lookup(key), { missing: true, key: 'api::users#list', bundle: 'api', lane: 'users', control: 'list', rule: 'x@api' });
        delete process.gina._lanes;
        assert.equal(lane().lookup(key).missing, true, 'no registry at all');
        register({ 'users-list@api': baseRoute() });
        assert.equal(lane().lookup({ bundle: 'other', rule: 'y@other', param: { lane: 'users', control: 'list' } }).missing, true, 'another bundle is another key');
        assert.equal(lane().lookup({ bundle: 'api', rule: 'z@api', param: { lane: 'users', control: 'get' } }).missing, true, 'another export is another key');
    });
});


// ─── 03 — LaneContext ────────────────────────────────────────────────────────
describe('#P49 lib/lane §03 — LaneContext', function () {

    function ctxOf(reqOpt, confOpt, res) {
        return new (lane().LaneContext)(makeReq(reqOpt), res || makeRes(), { lane: 'users', control: 'list' }, makeConf(confOpt));
    }

    it('carries the routing, params, method bag, body, request id and culture of the request', function () {
        var req  = makeReq({ params: { id: '7' }, get: { q: 'x' }, body: { b: 1 }, culture: 'fr-FR', reqId: 'RID-9' });
        var res  = makeRes();
        var conf = makeConf();
        var entry = { lane: 'users', control: 'list' };
        var srv  = { engine: 'stub' };
        var ctx  = new (lane().LaneContext)(req, res, entry, conf, srv);
        assert.equal(ctx.req, req);
        assert.equal(ctx.res, res);
        assert.equal(ctx.params, req.params);
        assert.equal(ctx.get, req.get);
        assert.equal(ctx.body, req.body);
        assert.equal(ctx.routing, req.routing);
        assert.equal(ctx.requestId, 'RID-9');
        assert.equal(ctx.culture, 'fr-FR');
        assert.equal(ctx._entry, entry);
        assert.equal(ctx._conf, conf);
        assert.equal(ctx._server, srv);
        assert.equal(ctx._t0, 0, 'no timeline, no clock read');
        var ctx2 = new (lane().LaneContext)(makeReq({ timeline: { requestStart: 1, entries: [] } }), res, entry, conf);
        assert.ok(ctx2._t0 > 0, 'a timeline stamps the dispatch start');
        assert.equal(ctx2._server, null);
    });

    it('every method lives on the prototype — building one allocates no closure', function () {
        var LaneContext = lane().LaneContext;
        var ctx = ctxOf();
        Object.keys(ctx).forEach(function (k) {
            assert.notEqual(typeof ctx[k], 'function', 'own property ' + k);
        });
        ['json', 'error', 'throwError', 'getConfig', 'hasRole', 'isXMLRequest', 'pauseRequest'].forEach(function (m) {
            assert.equal(typeof LaneContext.prototype[m], 'function', m);
        });
        assert.equal(LaneContext.prototype.throwError, LaneContext.prototype.error, 'the name the gate libraries call is the same function');
        assert.ok(!Object.prototype.hasOwnProperty.call(ctx, 'session'), 'session is a prototype getter');
    });

    it('session: req.session, undefined without one, undefined once the response is written', function () {
        var s = { user: { id: 1 } };
        var ctx = ctxOf({ session: s });
        assert.equal(ctx.session, s);
        assert.equal(ctxOf().session, undefined);
        var logs = captureLogs();
        try { ctx.json({ ok: 1 }); } finally { logs.restore(); }
        assert.equal(ctx.req, null, 'released');
        assert.equal(ctx.res, null, 'released');
        assert.equal(ctx.session, undefined);
    });

    it('isXMLRequest(): only a literal true stamp, and false once released', function () {
        assert.equal(ctxOf({ isXMLRequest: true }).isXMLRequest(), true);
        assert.equal(ctxOf({ isXMLRequest: 'true' }).isXMLRequest(), false);
        assert.equal(ctxOf().isXMLRequest(), false);
        var ctx = ctxOf({ isXMLRequest: true });
        ctx.req = null;
        assert.equal(ctx.isXMLRequest(), false);
    });

    it('hasRole(): the session user, else a verified machine caller; the session wins; no principal or released → false', function () {
        assert.equal(ctxOf({ session: { user: { roles: ['admin'] } } }).hasRole('admin'), true);
        assert.equal(ctxOf({ session: { user: { roles: ['admin'] } } }).hasRole('editor'), false);
        assert.equal(ctxOf({ machineCaller: { roles: ['svc'] } }).hasRole('svc'), true, 'a machine caller without a session');
        assert.equal(ctxOf({ session: { user: { roles: ['a'] } }, machineCaller: { roles: ['b'] } }).hasRole('b'), false, 'the session user wins');
        assert.equal(ctxOf({ session: {}, machineCaller: { roles: ['b'] } }).hasRole('b'), true, 'a session without a user falls back to the machine caller');
        assert.equal(ctxOf().hasRole('admin'), false);
        assert.equal(ctxOf({ session: { user: { roles: 'admin' } } }).hasRole('admin'), false, 'roles must be an array');
        var ctx = ctxOf({ session: { user: { roles: ['admin'] } } });
        ctx.req = null;
        assert.equal(ctx.hasRole('admin'), false);
    });

    it('getConfig(): a copy-on-write view of the bundle conf, or of one file by name; an unknown name → undefined', function () {
        var conf = makeConf();
        var ctx  = new (lane().LaneContext)(makeReq(), makeRes(), {}, conf);
        var all  = ctx.getConfig();
        assert.equal(CONFVIEW.isView(all), true);
        all.content.app.name = 'changed';
        assert.equal(conf.content.app.name, 'demo', 'the shared conf is untouched');
        var app = ctx.getConfig('app');
        assert.equal(CONFVIEW.isView(app), true);
        assert.equal(app.name, 'demo', 'a new view per call');
        app.nested.a = 9;
        assert.equal(conf.content.app.nested.a, 1);
        assert.equal(ctx.getConfig('nope'), undefined);
    });

    it('getConfig() in clone mode (settings.controller.getConfig.mode) returns a plain deep copy', function () {
        var conf = makeConf({ settings: { controller: { getConfig: { mode: 'clone' } } } });
        var ctx  = new (lane().LaneContext)(makeReq(), makeRes(), {}, conf);
        var all  = ctx.getConfig();
        assert.equal(CONFVIEW.isView(all), false);
        assert.deepEqual(all.content.app, conf.content.app);
        all.content.app.nested.a = 5;
        assert.equal(conf.content.app.nested.a, 1);
        assert.equal(CONFVIEW.isView(ctx.getConfig('app')), false);
    });

    it('getConfig() re-points hostname/host to this request\'s proxy (#B66), else to the worker latch, else leaves them', function () {
        var conf = makeConf();
        var proxied = new (lane().LaneContext)(makeReq(), makeRes(), {}, conf);
        proxied.req._ginaIsProxyHost   = true;
        proxied.req._ginaProxyHostname = 'https://public.example';
        proxied.req._ginaProxyHost     = 'public.example';
        var v = proxied.getConfig();
        assert.equal(v.hostname, 'https://public.example');
        assert.equal(v.host, 'public.example');
        assert.equal(conf.hostname, 'http://api.local:3100', 'the shared conf keeps its hostname');
        assert.equal(proxied.getConfig('proxyable').hostname, 'https://public.example', 'a named config holding a hostname too');
        assert.equal(proxied.getConfig('app').hostname, undefined, 'a config without a hostname gains none');

        var direct = new (lane().LaneContext)(makeReq(), makeRes(), {}, conf);
        direct.req._ginaIsProxyHost = false;
        assert.equal(direct.getConfig().hostname, 'http://api.local:3100', 'a direct request keeps the bundle hostname');

        // no per-request slot: the worker-global latch decides
        var savedGetContext = global.getContext;
        var savedPH = process.gina && process.gina.PROXY_HOSTNAME;
        var savedP  = process.gina && process.gina.PROXY_HOST;
        process.gina = process.gina || {};
        process.gina.PROXY_HOSTNAME = 'https://latched.example';
        process.gina.PROXY_HOST     = 'latched.example';
        global.getContext = function (k) { return ( k === 'isProxyHost' ) ? true : undefined; };
        try {
            var latched = new (lane().LaneContext)(makeReq(), makeRes(), {}, conf);
            assert.equal(latched.getConfig().hostname, 'https://latched.example');
            latched.req = null;
            assert.equal(latched.getConfig().host, 'latched.example', 'req-less: the latch still applies');
        } finally {
            if ( typeof(savedGetContext) == 'undefined' ) { delete global.getContext; } else { global.getContext = savedGetContext; }
            process.gina.PROXY_HOSTNAME = savedPH;
            process.gina.PROXY_HOST     = savedP;
        }
    });

    it('pauseRequest(): originalUrl, the routing, the lower-case method, a deep copy of the data, the params after the first', function () {
        var session = {};
        var req = makeReq({ method: 'POST', url: '/users', originalUrl: '/users?draft=1', params: { first: 'x', id: '7', tab: 'a' }, session: session });
        var ctx = new (lane().LaneContext)(req, makeRes(), {}, makeConf());
        var data = { name: 'Ada', nested: { a: 1 } };
        assert.equal(ctx.pauseRequest(data), session);
        var h = session.haltedRequest;
        assert.deepEqual(Object.keys(h), ['url', 'routing', 'method', 'data', 'params']);
        assert.equal(h.url, '/users?draft=1');
        assert.equal(h.routing, req.routing);
        assert.equal(h.method, 'post');
        assert.deepEqual(h.data, data);
        data.nested.a = 2;
        assert.equal(h.data.nested.a, 1, 'a deep copy');
        assert.deepEqual(h.params, { id: '7', tab: 'a' });
    });

    it('pauseRequest(): without originalUrl it keeps req.url; one param or none records no params', function () {
        var s1 = {};
        new (lane().LaneContext)(makeReq({ url: '/a', params: { only: '1' }, session: s1 }), makeRes(), {}, makeConf()).pauseRequest({});
        assert.equal(s1.haltedRequest.url, '/a');
        assert.ok(!('params' in s1.haltedRequest));
        var s2 = {};
        new (lane().LaneContext)(makeReq({ session: s2 }), makeRes(), {}, makeConf()).pauseRequest(undefined);
        assert.ok(!('params' in s2.haltedRequest));
        assert.equal(s2.haltedRequest.data, undefined);
    });

    it('pauseRequest(): an explicit storage receives the snapshot; the session is untouched', function () {
        var session = {};
        var store   = {};
        var ctx = new (lane().LaneContext)(makeReq({ session: session }), makeRes(), {}, makeConf());
        assert.equal(ctx.pauseRequest({ a: 1 }, store), store);
        assert.ok(store.haltedRequest);
        assert.ok(!('haltedRequest' in session));
    });

    it('pauseRequest(): no storage and no session answers 424 and returns undefined', function () {
        var res = makeRes();
        var ctx = new (lane().LaneContext)(makeReq(), res, {}, makeConf());
        var logs = captureLogs();
        var out;
        try { out = ctx.pauseRequest({}); } finally { logs.restore(); }
        assert.equal(out, undefined);
        assert.equal(res._st.writeHead[0].code, 424);
        var body = JSON.parse(res._st.body);
        assert.equal(body.status, 424);
        assert.equal(body.message, '`requestStorage` is required');
    });

    it('pauseRequest(): a no-op once the response is written', function () {
        var session = {};
        var ctx = new (lane().LaneContext)(makeReq({ session: session }), makeRes(), {}, makeConf());
        ctx.req = null;
        assert.equal(ctx.pauseRequest({ a: 1 }), undefined);
        assert.ok(!('haltedRequest' in session));
    });
});


// ─── 04 — dispatch() ─────────────────────────────────────────────────────────
describe('#P49 lib/lane §04 — dispatch()', function () {

    var ENTRIES = null;
    function entry(control) {
        if ( !ENTRIES ) {
            resetRegistry();
            var routing = {};
            ['sync', 'whoami', 'async', 'boom', 'rej', 'obj', 'str', 'late', 'lateAsync', 'silent'].forEach(function (c) {
                routing['b-' + c + '@api'] = baseRoute({ param: { lane: 'behaviours', control: c } });
            });
            assert.equal(register(routing), 10);
            ENTRIES = process.gina._lanes;
        }
        return ENTRIES['api::behaviours#' + control];
    }
    var HEX6 = /^[0-9A-F]{6}$/;

    it('a synchronous handler answers through ctx.json(); dispatch returns undefined and never calls next', function () {
        var r = run(lane(), entry('sync'));
        assert.equal(r.ret, undefined);
        assert.equal(r.res._st.ends, 1);
        assert.equal(r.res.statusCode, 200);
        assert.deepEqual(r.body(), { ok: 1 });
        assert.equal(r.res._st.headers['content-type'], 'application/json; charset=utf8');
        assert.equal(r.nexts(), 0);
        assert.ok(r.logs.info.indexOf('GET [200] /users') > -1, 'the access line: ' + JSON.stringify(r.logs.info));
    });

    it('the handler runs with `this` bound to its module', function () {
        assert.deepEqual(run(lane(), entry('whoami')).body(), { isModule: true });
    });

    it('an async handler answers when it resolves; dispatch still returns undefined, not the promise', async function () {
        var r = await runSettled(lane(), entry('async'));
        assert.equal(r.ret, undefined, 'the promise never leaves dispatch (an async caller would turn a rejection into an unhandled one)');
        assert.deepEqual(r.body(), { ok: 2 });
        assert.equal(r.nexts, 0);
    });

    it('a synchronous throw answers 500 with the controller envelope and one pairing line', function () {
        var r = run(lane(), entry('boom'));
        assert.equal(r.res._st.writeHead[0].code, 500);
        var b = r.body();
        assert.deepEqual(Object.keys(b), ['status', 'error', 'message', 'ref'], 'non-local: no stack');
        assert.equal(b.status, 500);
        assert.equal(b.error, 'Internal Server Error');
        assert.equal(b.message, 'lane boom');
        assert.match(b.ref, HEX6);
        assert.equal(r.logs.error.length, 1, 'ONE pairing line');
        assert.equal(r.logs.error[0].indexOf('[ BUNDLE ][ api ][ Lane ][ ref ' + b.ref + ' ][ req REQ-1 ] GET [ 500 ] /users\n'), 0, r.logs.error[0]);
        assert.ok(r.logs.error[0].indexOf('lane boom') > -1 && /\n\s+at\s/.test(r.logs.error[0]), 'the log keeps the stack');
        assert.equal(r.nexts(), 0);
    });

    it('a rejection answers 500 the same way', async function () {
        var r = await runSettled(lane(), entry('rej'));
        assert.equal(r.res._st.writeHead[0].code, 500);
        assert.equal(r.body().message, 'lane rejected');
        assert.equal(r.logs.error.length, 1);
        assert.equal(r.nexts, 0);
    });

    it('a thrown non-Error is wrapped; a thrown string is the message', function () {
        var o = run(lane(), entry('obj'));
        assert.equal(o.res._st.writeHead[0].code, 500);
        assert.equal(o.body().message, 'lane handler failed with a non-Error value: {"code":42}');
        var s = run(lane(), entry('str'));
        assert.equal(s.res._st.writeHead[0].code, 500);
        assert.equal(s.body().message, 'plain text failure');
    });

    it('a failure after the answer leaves the answer standing and logs the late call', async function () {
        var r = run(lane(), entry('late'));
        assert.equal(r.res._st.ends, 1, 'one write');
        assert.equal(r.res.statusCode, 200);
        assert.deepEqual(r.body(), { first: true });
        assert.equal(r.res._st.writeHead.length, 0, 'no error head');
        assert.ok(r.logs.warn.some(function (l) { return l.indexOf('[ Lane ] error() called after the response was released — ignoring: ') === 0 && l.indexOf('after the answer') > -1; }), JSON.stringify(r.logs.warn));
        var a = await runSettled(lane(), entry('lateAsync'));
        assert.equal(a.res._st.ends, 1);
        assert.deepEqual(a.body(), { first: true });
        assert.ok(a.logs.warn.some(function (l) { return l.indexOf('rejected after the answer') > -1; }));
    });

    it('a handler that never answers leaves the response open (the lane does not invent an answer)', function () {
        var r = run(lane(), entry('silent'));
        assert.equal(r.res._st.ends, 0);
        assert.equal(r.nexts(), 0);
    });

    it('an unregistered lane (the `missing` placeholder) answers 500 naming it', function () {
        var placeholder = lane().lookup({ bundle: 'api', rule: 'ghost@api', param: { lane: 'ghost', control: 'list' } });
        var r = run(lane(), placeholder);
        assert.equal(r.res._st.writeHead[0].code, 500);
        assert.match(r.body().message, /^lane route `ghost@api` names `ghost#list`, which is not registered for bundle `api`/);
        assert.equal(r.nexts(), 0);
    });

    it('an entry marked failed answers 500 with its error', function () {
        var failed = Object.assign({}, entry('sync'), { error: new Error('module could not be reloaded') });
        var r = run(lane(), failed);
        assert.equal(r.res._st.writeHead[0].code, 500);
        assert.equal(r.body().message, 'module could not be reloaded');
    });

    it('pushes the Flow bars in order when the request carries a timeline: lane-dispatch, response-write, total', function () {
        var tl = { requestStart: Date.now() - 3, entries: [] };
        run(lane(), entry('sync'), { timeline: tl });
        assert.deepEqual(tl.entries.map(function (e) { return e.label; }), ['lane-dispatch', 'response-write', 'total']);
        assert.equal(tl.entries[0].cat, 'controller');
        assert.equal(tl.entries[0].detail, 'behaviours#sync');
        tl.entries.forEach(function (e) {
            assert.ok(e.endMs >= e.startMs && e.durationMs >= 0, JSON.stringify(e));
        });
        var none = run(lane(), entry('sync'), { timeline: undefined });
        assert.deepEqual(none.body(), { ok: 1 }, 'no timeline: no bars, same answer');
    });
});


// ─── 05 — dev-mode reload ────────────────────────────────────────────────────
describe('#P49 lib/lane §05 — dev-mode reload of the lane modules', function () {

    var hot = null;
    var savedGetContext;
    var HOT_FILE = path.join(BUNDLES, 'hot', 'lanes', 'hot.js');

    function writeHot(v) {
        fs.mkdirSync(path.dirname(HOT_FILE), { recursive: true });
        fs.writeFileSync(HOT_FILE, 'module.exports.v = function (ctx) { ctx.json({ v: ' + JSON.stringify(v) + ' }); };\n');
    }
    function registerHot(api) {
        assert.equal(api.registerRoutes({ 'hot@hot': { url: '/hot', param: { lane: 'hot', control: 'v' } } }, { bundle: 'hot', bundlesPath: BUNDLES }), 1);
        return process.gina._lanes['hot::hot#v'];
    }
    function dispatchHot(api, e) {
        return run(api, e, { url: '/hot', routing: { rule: 'hot@hot', bundle: 'hot', param: { lane: 'hot', control: 'v' } } });
    }
    function useWatcher(on) {
        global.getContext = function (k) { return ( on && k === '__hotReload' ) ? hot : undefined; };
    }

    beforeEach(function () {
        resetRegistry();
        evictFixtures();
        hot = { core: false, action: false, lane: false };
        savedGetContext = global.getContext;
        useWatcher(true);
        process.env.NODE_ENV_IS_DEV = 'true';
    });
    afterEach(function () {
        if ( typeof(savedGetContext) == 'undefined' ) { delete global.getContext; } else { global.getContext = savedGetContext; }
        delete process.env.NODE_ENV_IS_DEV;
    });

    it('the watcher flag gates the reload: unset keeps the loaded code, set loads the new file and is cleared', function () {
        writeHot(1);
        var f = freshLane();
        var e = registerHot(f.lane);
        assert.equal(dispatchHot(f.lane, e).body().v, 1);
        writeHot(2);
        assert.equal(dispatchHot(f.lane, e).body().v, 1, 'no flag: no reload, no file read');
        hot.lane = true;
        assert.equal(dispatchHot(f.lane, e).body().v, 2);
        assert.equal(hot.lane, false, 'the flag is cleared after the reload');
        assert.equal(e.error, null);
    });

    it('each reload leaves one child per handler file — the evicted module is pruned (control: without the prune they accumulate)', function () {
        writeHot(1);
        var f = freshLane();
        var e = registerHot(f.lane);
        function kids(mod, id) { return mod.children.filter(function (c) { return c.id === id; }).length; }
        assert.equal(kids(f.module, e.resolved), 1, 'one child after the boot registration (control: the instrument sees it)');
        for (var i = 2; i <= 4; ++i) {
            writeHot(i);
            hot.lane = true;
            assert.equal(dispatchHot(f.lane, e).body().v, i);
        }
        assert.equal(kids(f.module, e.resolved), 1, 'still one after three reloads');
        assert.ok(f.module.children.every(function (c) { return require.cache[c.id] === c; }), 'no evicted module left reachable');

        resetRegistry();
        evictFixtures();
        writeHot(1);
        var ctl = noPruneLane();
        var e2  = registerHot(ctl.lane);
        for (i = 2; i <= 4; ++i) {
            writeHot(i);
            hot.lane = true;
            assert.equal(dispatchHot(ctl.lane, e2).body().v, i);
        }
        assert.equal(kids(ctl.module, e2.resolved), 4, 'without the prune, every evicted module stays reachable');
    });

    it('a file that no longer loads answers 500 naming the module until it is fixed, then recovers', function () {
        writeHot(1);
        var f = freshLane();
        var e = registerHot(f.lane);
        fs.writeFileSync(HOT_FILE, 'module.exports.v = function (ctx) {\n');
        hot.lane = true;
        var r = dispatchHot(f.lane, e);
        assert.equal(r.res._st.writeHead[0].code, 500);
        assert.match(r.body().message, /^lane module `lanes\/hot\.js` could not be reloaded/);
        assert.ok(e.error instanceof Error);
        assert.equal(dispatchHot(f.lane, e).res._st.writeHead[0].code, 500, 'still 500 until the next change');
        writeHot(5);
        hot.lane = true;
        var ok = dispatchHot(f.lane, e);
        assert.equal(ok.res.statusCode, 200);
        assert.equal(ok.body().v, 5);
        assert.equal(e.error, null);
    });

    it('a removed export answers 500 naming it; restoring it recovers', function () {
        writeHot(1);
        var f = freshLane();
        var e = registerHot(f.lane);
        fs.writeFileSync(HOT_FILE, 'module.exports.other = function (ctx) { ctx.json({}); };\n');
        hot.lane = true;
        var r = dispatchHot(f.lane, e);
        assert.equal(r.res._st.writeHead[0].code, 500);
        assert.match(r.body().message, /no longer exports a function named `v` \(route `hot@hot`\)/);
        writeHot(6);
        hot.lane = true;
        assert.equal(dispatchHot(f.lane, e).body().v, 6);
    });

    it('without a watcher, every dispatch reloads (the controllers\' fallback)', function () {
        useWatcher(false);
        writeHot(1);
        var f = freshLane();
        var e = registerHot(f.lane);
        writeHot(2);
        assert.equal(dispatchHot(f.lane, e).body().v, 2);
        writeHot(3);
        assert.equal(dispatchHot(f.lane, e).body().v, 3);
    });

    it('outside dev mode nothing reloads, whatever the flag says', function () {
        delete process.env.NODE_ENV_IS_DEV;
        writeHot(1);
        var f = freshLane();
        var e = registerHot(f.lane);
        writeHot(2);
        hot.lane = true;
        assert.equal(dispatchHot(f.lane, e).body().v, 1);
        assert.equal(hot.lane, true, 'the flag is not consumed');
    });
});


// ─── 06 — watchDirs() ────────────────────────────────────────────────────────
describe('#P49 lib/lane §06 — watchDirs()', function () {

    beforeEach(resetRegistry);
    var API_LANES = path.join(BUNDLES, 'api', 'lanes');

    it('nothing to watch without a registered lane', function () {
        assert.deepEqual(lane().watchDirs(API_LANES), []);
    });

    it('the lanes root first, then each directory holding a registered module, once each', function () {
        register({
            'u1@api' : baseRoute(),
            'u2@api' : baseRoute({ param: { control: 'get' } }),
            'a1@api' : baseRoute({ param: { lane: 'admin/users' } })
        });
        assert.deepEqual(lane().watchDirs(API_LANES), [API_LANES, path.join(API_LANES, 'admin')]);
    });

    it('the root is watched even when only a nested module is registered', function () {
        register({ 'a1@api': baseRoute({ param: { lane: 'admin/users' } }) });
        assert.deepEqual(lane().watchDirs(API_LANES), [API_LANES, path.join(API_LANES, 'admin')]);
    });

    it('another bundle\'s lanes are not watched for this one, and a sibling directory sharing the prefix is excluded', function () {
        register({ 'x@other': { url: '/x', param: { lane: 'x', control: 'list' } } }, { bundle: 'other' });
        assert.deepEqual(lane().watchDirs(API_LANES), []);
        assert.deepEqual(lane().watchDirs(path.join(BUNDLES, 'other', 'lanes')), [path.join(BUNDLES, 'other', 'lanes')]);
        process.gina._lanes['api::stray#list'] = { file: path.join(BUNDLES, 'api', 'lanes-old', 'stray.js') };
        assert.deepEqual(lane().watchDirs(API_LANES), [], 'lanes-old is not under lanes/');
    });
});


// ─── 07 — wiring pins ────────────────────────────────────────────────────────
describe('#P49 lib/lane §07 — wiring pins', function () {

    /** Drop comments so a pin cannot be satisfied by prose. */
    function live(src) {
        return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(function (l) {
            return ( l.trim().indexOf('//') === 0 ) ? '' : l.replace(/\s\/\/\s.*$/, '');
        }).join('\n');
    }

    it('lib/index.js registers the lane with a plain require (core/server.js binds it at load)', function () {
        assert.match(INDEX_SRC, /\n\s+lane\s*:\s*require\('\.\/lane'\)/);
        assert.doesNotMatch(INDEX_SRC, /\blane\s*:\s*_require\(/);
    });

    it('GinaLib declares the lane with its six members', function () {
        var at = DTS_SRC.indexOf('interface GinaLib {');
        assert.ok(at > -1);
        var block = DTS_SRC.substring(at, DTS_SRC.indexOf('\n    }\n', at));
        var l = block.search(/\n\s+lane\s*:\s*\{/);
        assert.ok(l > -1, 'lane is declared');
        var laneBlock = block.substring(l, block.indexOf('\n        };', l));
        ['registerRoutes(', 'lookup(', 'dispatch(', 'watchDirs(', 'isLaneName(', 'LaneContext:'].forEach(function (m) {
            assert.ok(laneBlock.indexOf(m) > -1, m);
        });
    });

    it('the lane never assigns the native headersSent getter (a TypeError in strict mode)', function () {
        var src = live(fs.readFileSync(LANE_MAIN, 'utf8'));
        assert.ok(src.indexOf('headersSent') > -1, 'control: the getter is read');
        assert.doesNotMatch(src, /headersSent\s*=(?!=)/);
    });
});
