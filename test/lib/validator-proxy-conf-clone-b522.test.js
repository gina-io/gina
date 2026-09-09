'use strict';
/**
 * #B522 — the server-side `query` rule must not write into the process-wide
 * `app.proxy[<bundle>]` configuration object.
 *
 * `queryFromBackend` (core/plugins/lib/validator/src/form-validator.js) binds its
 * request options straight off the GLOBAL two-argument `getConfig(bundle, 'app')`,
 * which hands back the bundle's `app` conf BY REFERENCE — `resolveBundlesConf`
 * (helpers/context.js:389) returns `conf.bundlesConfiguration.conf` / `conf.envConf`
 * with no clone, and `getConfig` (:409) reads straight through it. It then wrote
 * `opt.method` and `opt.path` into that shared object, and `controller.query()`
 * added a third key (`requestTimeout`, controller.js:4997-5002) to the caller's
 * object BEFORE its own defensive copy at :5006. All three persisted on
 * `content.app.proxy[<bundle>]` for the whole process lifetime.
 *
 * `path` and `requestTimeout` are DOCUMENTED `proxyTarget` properties
 * (schema/app.json), so this clobbered configured values for every other reader
 * of that conf — controller.js:3692 (`self.getConfig('app').proxy[bundle]`) and
 * :3802 (`appConf.proxy[service]`) — not merely added stray keys.
 *
 * Harness: the REAL shipped module driven exactly as the router drives it
 * (`_validator[key]['query'](...)`), against a real http/2 stub, with the config
 * graph supplied through the sanctioned `setContext('__mock__', { config })` hook
 * (helpers/context.js:409). Modelled on validator-query-backend.test.js, with two
 * deliberate differences that are what make `:1092` execute at all: the rule
 * targets a bundle OTHER than the current one (`config.bundle !== bundle`), and
 * the mocked `app` conf carries a populated `proxy` block.
 *
 * The §02 arm is the instrument check and it CAN fail: it asserts the stub server
 * actually received a request whose `:path` is the route url, which is the
 * `opt.path = route.url` write itself. Without it, §01 could pass vacuously by the
 * flow never reaching the write site at all.
 *
 * Red-first MEASURED (2026-09-09), driving the pre-#B522 bytes of this file — the
 * bare reference bind restored, md5 7b0fc45d2306b08bcebe137087eb543a: 1 pass / 3
 * fail. §01 and §03 fail on ASSERTIONS about the polluted object (`the configured
 * proxyTarget \`path\` must survive the live-check`), not on an error, and §04's
 * clone pin fails with them. §02 stays GREEN on the pre-fix source, which is the
 * point of it: the harness reaches the write site either way, so §01 is measuring
 * the fix and not its own setup. Post-fix: 4 pass / 0 fail.
 *
 * Pre-existing and NOT from this change: the run logs eight `JSON.clone(...)
 * possible error detected: source[isProxyHost] is undefined` warnings from the
 * unrelated `JSON.clone(routing.getRoute(...))` a few lines below. Identical count
 * before and after (only the reported line moves, :1103 -> :1112, by this comment
 * block's own length).
 */
var { describe, it, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var http2  = require('http2');

var FW = require('../fw');

// Bare-module resolution (`require('lib/routing')`) + JSON.clone + framework globals.
process.env.NODE_ENV_IS_DEV = process.env.NODE_ENV_IS_DEV || 'false';
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes')); // Object.prototype.count() + JSON.clone
require(path.join(FW, 'helpers'));
/* global setPath, setContext */
process.setMaxListeners(0); // engine construction adds logger listeners per instance
setPath('gina', { core: path.join(FW, 'core') });

// queryFromBackend's very first statement resolves the framework dir off this global
// (form-validator.js:1074), and its teardown touches process.gina.
global.GINA_FRAMEWORK_DIR = FW;
if (!process.gina) { process.gina = {}; }
process.gina.GINA_FRAMEWORK_DIR = FW;

var RenderCache       = require(path.join(FW, 'lib/render-cache/src/main'));
var FormValidatorUtil = require(path.join(FW, 'core/plugins/lib/validator/src/form-validator.js'));
var Config            = require(path.join(FW, 'core/config.js'));

var FV_PATH = path.join(FW, 'core/plugins/lib/validator/src/form-validator.js');
var FV_SRC  = fs.readFileSync(FV_PATH, 'utf8');

// The bundle the request runs IN vs the bundle the rule targets. They must differ,
// or `if (config.bundle !== bundle)` is false and the proxy bind never happens.
var BUNDLE = 'wartest', TARGET = 'upstream', ENV = 'dev';
var RULEFULL = 'check-user@' + TARGET;
var ROUTE_URL = '/check-user';
var CONFIGURED_PATH = '/api/v1';          // a real proxyTarget `path` prefix, to be clobbered
var CONFIGURED_TIMEOUT = '30s';           // a real proxyTarget `requestTimeout`

function activeLines(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

describe('validator-proxy-conf-clone — the `query` rule must not mutate the shared app.proxy conf (#B522)', function () {

    var worlds = [];

    async function buildWorld(opts) {
        opts = opts || {};
        var seen = [];
        var server = http2.createServer();
        server.on('stream', function (stream, headers) {
            seen.push({ path: headers[':path'], method: headers[':method'] });
            stream.respond({ ':status': 200, 'content-type': 'application/json' });
            stream.end(JSON.stringify({ status: 200, isValid: true }));
        });
        await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
        var PORT = server.address().port;

        function bundleConf() {
            var serverDict = {
                cache: { path: '/tmp/b522-unused', enable: false },
                coreConfiguration: { mime: { json: 'application/json' }, statusCodes: { 200: 'OK' } }
            };
            var routingContent = {}; routingContent[RULEFULL] = { param: {} };
            return {
                content: { server: serverDict, routing: routingContent },
                server: {
                    scheme: 'http', protocol: 'http/2.0',
                    resolvers: [], credentials: {},
                    coreConfiguration: { mime: { json: 'application/json' }, statusCodes: { 200: 'OK' } }
                },
                host: '127.0.0.1:' + PORT,
                port: (function () { var p = {}; p['http/2.0'] = { http: PORT }; return p; })(),
                isCacheless: false
            };
        }

        // THE OBJECT UNDER OBSERVATION: the shared, process-wide proxy target.
        // `path` and `requestTimeout` are populated exactly as an operator would
        // configure them, so a clobber is visible as a changed value, not just a
        // new key.
        var proxyTarget = {
            hostname: 'http://127.0.0.1',
            port: PORT,
            path: CONFIGURED_PATH,
            protocol: 'http/2.0',
            rejectUnauthorized: false
        };
        if (opts.withTimeout) { proxyTarget.requestTimeout = CONFIGURED_TIMEOUT; }

        var appConf = { proxy: {} };
        appConf.proxy[TARGET] = proxyTarget;

        var routingDict = {};
        routingDict[RULEFULL] = {
            method: 'GET', url: ROUTE_URL, requirements: {},
            param: { control: 'checkUser' }, middleware: [], bundle: TARGET
        };

        var envConf = {};
        envConf[BUNDLE] = {}; envConf[BUNDLE][ENV] = bundleConf();
        envConf[TARGET] = {}; envConf[TARGET][ENV] = bundleConf();
        envConf.env = ENV; envConf.bundle = BUNDLE;

        var fakeConfig = {
            env: ENV, scope: 'local', bundle: BUNDLE,
            envConf: envConf,
            bundlesConfiguration: { conf: envConf },
            Env:   { set: function () {}, parent: null },
            Scope: { set: function () {}, parent: null },
            Host:  { setMaster: function () {}, parent: null },
            getRouting: function () { return routingDict; },
            isCacheless: function () { return false; }
        };
        fakeConfig[BUNDLE] = envConf[BUNDLE];
        fakeConfig[TARGET] = envConf[TARGET];
        fakeConfig.getInstance = function () { return fakeConfig; };

        setContext('bundle', BUNDLE);
        setContext('env', ENV);
        setContext('gina', { config: fakeConfig, forms: null });
        setContext('__mock__', { config: function (b, confName) {
            if (confName === 'app')      { return appConf; }
            if (confName === 'settings') { return { server: { credentials: {} } }; }
            return {};
        } });
        Config.initialized = true;
        Config.instance    = fakeConfig;

        var world = {
            server: server, seen: seen, appConf: appConf, proxyTarget: proxyTarget,
            // No sessKey: the pooled key is derived from the proxy conf's `hostname`
            // and carries no port, so recording a guess here only invites its reuse.
            maps: [ envConf[BUNDLE][ENV].content.server, envConf[TARGET][ENV].content.server ]
        };
        worlds.push(world);
        return world;
    }

    // Drive the REAL queryFromBackend exactly as the router does.
    async function drive() {
        var v = new FormValidatorUtil({ username: 'joe' });
        var reqMock = { headers: {}, isXMLRequest: false, isWithCredentials: false };
        var resMock = {
            setHeader: function () {}, getHeader: function () {}, getHeaders: function () { return {}; },
            end: function () {}, writeHead: function () {}, headersSent: false, statusCode: 200
        };
        return v['username'].query(
            { url: RULEFULL, method: 'GET', data: {} },
            reqMock, resMock, function next() {}
        );
    }

    // Teardown must not GUESS the pooled-session key. MEASURED: on the proxy branch the
    // conf supplies `hostname` and `port` as separate keys, so the session lands under
    // `http2session:http://127.0.0.1` with NO port — a key lookup finds nothing and the
    // live session survives teardown. On node 22 the file then never finishes: the runner
    // reports `cancelled` / `testTimeoutFailure`, which is NOT a failing assertion and is
    // how this first surfaced (CI, 120s). Reproduced deliberately on node 22 with the
    // pre-fix teardown, and green on 22/24/26 with the sweep below.
    // ⚠️ Node 25 TOLERATES the leak — both `server.close()` and the event-loop drain
    // complete there — so a local-only run on a newer node CANNOT see this. An earlier
    // draft of this comment blamed `server.close()` never calling back; that was measured
    // FALSE on node 25 (it returned in 2ms with the session still live) and is not the
    // mechanism. Sweep every entry instead of naming a key.
    afterEach(async function () {
        for (var w; (w = worlds.pop()); ) {
            w.maps.forEach(function (dict) {
                var m = dict && dict._cached;
                if (!m) { return; }
                try {
                    m.forEach(function (entry) {
                        var v = entry && entry.value;
                        if (v && typeof v.destroy === 'function' && !v.destroyed) { v.destroy(); }
                    });
                } catch (e) {}
                try { new RenderCache().from(m).clear(); } catch (e) {}
            });
            // Bounded: if anything still held the server open, fail fast rather than
            // hanging the whole file until the runner's timeout.
            await new Promise(function (r) {
                var settled = false;
                var fin = function () { if (!settled) { settled = true; r(); } };
                try { if (w.server.closeAllConnections) { w.server.closeAllConnections(); } } catch (e) {}
                w.server.close(fin);
                setTimeout(fin, 3000).unref();
            });
        }
        if (process.gina) { delete process.gina._serverInstance; }
    });

    it('01 — the shared app.proxy target keeps its configured `path` and gains no request keys', async function () {
        var world = await buildWorld();

        var result = await drive();
        assert.equal(result && result.status, 200, 'precondition: the validator query must succeed');

        var shared = world.appConf.proxy[TARGET];
        assert.equal(shared.path, CONFIGURED_PATH,
            'the configured proxyTarget `path` must survive the live-check (it was overwritten with the route url)');
        assert.equal(typeof shared.method, 'undefined',
            'no `method` key may be left on the shared proxy conf');
        assert.equal(typeof shared.requestTimeout, 'undefined',
            'no `requestTimeout` key may be left on the shared proxy conf by controller.query()');
    });

    it('02 — CONTROL (can fail): the request really went out carrying the route url as its path', async function () {
        var world = await buildWorld();

        await drive();

        // This is the `opt.path = route.url` write, observed from the far end. If the
        // flow never reached the write site, §01 would be vacuous — this arm is what
        // makes it mean something.
        assert.equal(world.seen.length, 1, 'the stub must have received exactly one request');
        assert.equal(world.seen[0].path, ROUTE_URL,
            'the outgoing request must carry the route url — proof the opt.path write executed');
        assert.equal(world.seen[0].method, 'GET', 'and the method the rule asked for');
    });

    it('03 — a second consecutive live-check still sends the route url, and the shared conf is still clean', async function () {
        var world = await buildWorld({ withTimeout: true });

        await drive();
        await drive();

        assert.equal(world.seen.length, 2, 'both live-checks must have reached the stub');
        assert.equal(world.seen[1].path, ROUTE_URL, 'the second request must not inherit a mutated path');

        var shared = world.appConf.proxy[TARGET];
        assert.equal(shared.path, CONFIGURED_PATH, 'the configured `path` must still be intact after two calls');
        assert.equal(shared.requestTimeout, CONFIGURED_TIMEOUT,
            'the operator-configured `requestTimeout` must be untouched');
        assert.equal(typeof shared.method, 'undefined', 'still no `method` key');
    });

    it('04 — source pins: the bind clones, and the bare-reference form is not live code', function () {
        var ACTIVE = activeLines(FV_SRC);
        var CLONED = "opt = JSON.clone( getConfig( currentBundle, 'app' ).proxy[bundle] );";
        var BARE   = "opt = getConfig( currentBundle, 'app' ).proxy[bundle];";

        assert.ok(ACTIVE.indexOf(CLONED) > -1, 'the proxy bind must clone');
        assert.equal(ACTIVE.split(CLONED).length, 2, 'exactly one cloning bind site');
        assert.equal(ACTIVE.indexOf(BARE), -1, 'the bare by-reference bind must not be live code');

        // CONTROL: the bare form IS still present in the raw file (kept as the
        // commented-out prior line). If the comment strip above silently returned raw
        // source, the assertion before this one would have failed — so this pair cannot
        // both pass with a broken instrument.
        assert.ok(FV_SRC.indexOf(BARE) > -1,
            'control: the prior line is retained as a comment, so `activeLines` is doing real work');
    });
});
