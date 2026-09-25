/**
 * #B634 / #B623 — the couchbase connector's REST query transport is retired.
 *
 * `useRestApi: true` (opt-in, off by default, documented nowhere) switched every
 * N1QL query from the SDK to `conn.restQuery`, a hand-written `http.request()` to
 * the query service. It always used plain http — so on a `couchbases://`
 * connection the cluster credentials left in an `Authorization: Basic` header,
 * unencrypted (#B634) — rewrote every `'` in the statement to `"`, and spliced
 * parameters in without escaping through `arrayToValues` (#B623). The transport is
 * retired: the option is ignored with ONE warning per connector, and queries go
 * through the SDK like every other query.
 *
 * Sections:
 *   01 — source pins (comment-stripped): no `restQuery`, `arrayToValues` or
 *        `http.request` in either connector's live code, no REST branch in the
 *        query dispatch (index.js), and the warning present in both connectors.
 *   02 — live, per SDK connector (stub SDK): a connector configured with
 *        `useRestApi: true` still boots, logs exactly one warning naming the
 *        option — also across a second connect — and attaches no `restQuery`
 *        to the cluster connection.
 *   03 — CONTROL: without the option, no such warning.
 *
 * Red-first: on the pre-change files every 01 pin fails, and 02's warning and
 * `restQuery` assertions fail; 02's boot assertion and 03 pass on both.
 *
 * Harness: the stub-SDK recipe of `couchbase-boot-deadline.test.js` (the SDK is a
 * project-side require, so planting `<TMP>/node_modules/couchbase/` is the seam;
 * timers are mocked so the boot deadline and the ping interval never hold the file).
 */
'use strict';

var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');

var FW   = path.resolve(require('../fw'));
var REPO = path.resolve(__dirname, '../..');

// ─── globals bootstrap (mirrors test/core/couchbase-boot-deadline.test.js) ───
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(FW + '/helpers');
setPath('gina', { core: path.join(FW, 'core') });

// ─── throwaway project carrying the planted SDK stub ────────────────────────
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b634-'));
fs.mkdirSync(path.join(TMP, 'node_modules/couchbase'), { recursive: true });
fs.writeFileSync(
    path.join(TMP, 'node_modules/couchbase/index.js'),
    "module.exports = {\n" +
    "    QueryScanConsistency: { NotBounded: 'not_bounded', RequestPlus: 'request_plus' },\n" +
    "    Cluster: function Cluster(url) { this.url = url; },\n" +
    "    connect: function connect(url, opts, cb) { return global.__B634_CONNECT__(url, opts, cb); }\n" +
    "};\n"
);
setPath('project', TMP);
setPath('bundle',  path.join(TMP, 'bundle'));

// ─── core/gna + gina package stubs, with a logger that records warnings ──────
var _inherits = require(FW + '/lib/inherits/src/main.js');
var _merge    = require(FW + '/lib/merge/src/main.js');
var ModelUtil = require(FW + '/lib/model');
var warnings  = [];
var capturingConsole = {
    log: function() {}, info: function() {}, debug: function() {},
    warn: function(m) { warnings.push(String(m)); },
    error: function() {}, emerg: function() {}
};
var ginaExports = {
    lib: {
        logger: capturingConsole, helpers: {}, inherits: _inherits,
        merge: _merge, Model: ModelUtil
    },
    onError: function() {}
};
[ require.resolve(path.join(FW, 'core/gna')), require.resolve(REPO) ].forEach(function(id) {
    require.cache[id] = { id: id, filename: id, loaded: true, exports: ginaExports };
});

// ─── context wiring (the documented getConfig() seam) ───────────────────────
var BUNDLE = 'b634bundle';
var ENV    = 'dev';
setContext('__mock__', { config: function() { return { bundle: BUNDLE }; } });
setContext('bundle', BUNDLE);
setContext('env', ENV);
setContext('gina', {
    config: {
        envConf: (function() {
            var e = {}; e[BUNDLE] = {};
            e[BUNDLE][ENV] = { modelsPath: path.join(TMP, 'no/such/models') };
            return e;
        })()
    }
});

var FILES = {
    v4: path.join(FW, 'core/connectors/couchbase/lib/connector.v4.js'),
    v3: path.join(FW, 'core/connectors/couchbase/lib/connector.v3.js')
};
var INDEX = path.join(FW, 'core/connectors/couchbase/index.js');

/** Strip `//` and block comments so a negative pin cannot match a commented twin. */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** A dbString shaped like a real connectors.json couchbase entry. */
function dbStringFor(name, extra) {
    var d = {
        connector: 'couchbase', database: name, protocol: 'couchbases://',
        host: '127.0.0.1', username: 'u', password: 'p'
    };
    for (var k in (extra || {})) d[k] = extra[k];
    return d;
}

/** Let queued microtasks (the awaited SDK promise) run; timers stay mocked. */
async function flush(n) {
    for (var i = 0; i < (n || 6); i++) await Promise.resolve();
}

/** Succeed, and record every cluster connection handed back. */
function succeedingSdk(conns) {
    return function(url, opts, cb) {
        var conn = {
            bucket: function() { return { name: 'b', defaultCollection: function() { return {}; } }; },
            query: function() {}, close: function() {}
        };
        conns.push(conn);
        queueMicrotask(function() { cb(null, conn); });
        return Promise.resolve(conn);
    };
}

/** Warnings naming the retired option. */
function restWarnings() {
    return warnings.filter(function(w) { return /useRestApi/.test(w); });
}

after(function() {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});


// ─── 01 — source pins ───────────────────────────────────────────────────────
describe('01 - the REST transport is gone from the live code', function() {

    Object.keys(FILES).forEach(function(v) {
        it(v + ': no restQuery, arrayToValues or http.request; the warning is present', function() {
            var live = stripComments(fs.readFileSync(FILES[v], 'utf8'));
            assert.equal(live.indexOf('restQuery'), -1, 'restQuery is live');
            assert.equal(live.indexOf('arrayToValues'), -1, 'arrayToValues is live');
            assert.equal(live.indexOf('http.request'), -1, 'an http.request is live');
            assert.ok(live.indexOf('is no longer supported and is ignored') > -1, 'the warning is missing');
        });
    });

    it('index.js: the query dispatch has no REST branch', function() {
        var live = stripComments(fs.readFileSync(INDEX, 'utf8'));
        assert.equal(live.indexOf('restQuery'), -1, 'a restQuery dispatch is live');
        assert.equal(live.indexOf('useRestApi'), -1, 'the dispatch still reads useRestApi');
        assert.ok(live.indexOf('conn._cluster.query(query, queryOptions)') > -1, 'the SDK dispatch is present (control)');
    });
});


// ─── 02 — live: useRestApi: true is ignored, with one warning ───────────────
describe('02 - useRestApi: true boots, warns once, and attaches no REST transport', function() {

    Object.keys(FILES).forEach(function(v) {
        it(v + ': one warning, also across a second connect; no restQuery on the connection', async function(t) {
            t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
            try {
                warnings.length = 0;
                var conns = [];
                global.__B634_CONNECT__ = succeedingSdk(conns);
                var Connector = require(FILES[v]);
                var dbString = dbStringFor('rest_' + v, { useRestApi: true, readyTimeout: 250 });
                var c = new Connector(dbString);
                var once = [];
                c.onReady(function(err, inst) { once.push({ err: err, inst: inst }); });
                await flush();

                assert.equal(once.length, 1, 'the connector booted (control)');
                assert.ok(!once[0].err, 'no boot error: ' + (once[0].err && once[0].err.message));
                assert.equal(restWarnings().length, 1, 'exactly one useRestApi warning: ' + JSON.stringify(warnings));
                assert.ok(/no longer supported/.test(restWarnings()[0]), 'the warning says the option is retired');
                assert.equal(typeof conns[0].restQuery, 'undefined', 'no restQuery attached to the cluster connection');
                assert.notEqual(once[0].inst && once[0].inst.useRestApi, true, 'the bucket connection does not carry useRestApi');

                await c.connect(dbString);
                await flush();
                assert.equal(conns.length, 2, 'the second connect reached the SDK (control)');
                assert.equal(restWarnings().length, 1, 'still one warning after the second connect');
                try { clearInterval(c.pingId); } catch (e) {}
            } finally {
                t.mock.timers.reset();
            }
        });
    });
});


// ─── 03 — CONTROL: without the option, no warning ───────────────────────────
describe('03 - CONTROL: a connector without useRestApi does not warn', function() {

    Object.keys(FILES).forEach(function(v) {
        it(v + ': no useRestApi warning', async function(t) {
            t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
            try {
                warnings.length = 0;
                var conns = [];
                global.__B634_CONNECT__ = succeedingSdk(conns);
                var Connector = require(FILES[v]);
                var c = new Connector(dbStringFor('plain_' + v, { readyTimeout: 250 }));
                var once = [];
                c.onReady(function(err, inst) { once.push({ err: err, inst: inst }); });
                await flush();

                assert.equal(once.length, 1, 'the connector booted');
                assert.equal(restWarnings().length, 0, 'no useRestApi warning: ' + JSON.stringify(warnings));
                try { clearInterval(c.pingId); } catch (e) {}
            } finally {
                t.mock.timers.reset();
            }
        });
    });
});
