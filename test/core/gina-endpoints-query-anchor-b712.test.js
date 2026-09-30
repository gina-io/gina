/**
 * #B712 — the `/_gina/*` handlers left out of #B709's exact-path matching (the health check,
 * jobs/:id, instrument, and the dev-only inspector, logs, agent, indexes and reveal) match the
 * url's PATH, not its query string, on both engines; the `$`-anchored dev endpoints answer a url
 * that carries a query string (the #B717 residual); the two agent WebSocket upgrade listeners
 * agree; the Inspector reads its asset path from the url's path.
 *
 * The defects: each matcher tested the RAW url with no start anchor, so an application url whose
 * QUERY ended in an endpoint path (`/web/?next=/_gina/health/check`) was answered by the
 * endpoint instead of the page — outside a maintenance window and inside one, where the page's
 * 503 was due — and a WebSocket upgrade to such a url was taken by the agent. And logs, indexes,
 * reveal and the bare inspector ended in `$`, so `/_gina/logs?x=1` missed them: a 404 on
 * express, and on isaac the maintenance 503 during a window.
 *
 * The fix: each matcher gains `^[^?]*` — the endpoint path must end the url's path — and the
 * dev endpoints' `$` becomes `(?:\?|$)`; each keeps its prefix tolerance (the Inspector puts the
 * opener page's full pathname before `/_gina/`), its letter case, its methods and its gates. The
 * agent upgrade listeners keep their literal and test the query-free path. The Inspector asset
 * path is read from the query-free url, like its matcher.
 *
 * Instrument: each handler's `if ( … ) {` condition, the jobs match expression, the listeners'
 * conditions and the asset-path statements are EXTRACTED from the shipped source and EXECUTED —
 * no replica, so nothing can drift from the source. Every extraction anchor exists once in each
 * engine before and after the fix, so a red run fails on behaviour, never on a missing anchor;
 * the bare endpoint path is the control on every handler, and a closed gate or a wrong method
 * proves the extracted condition is the handler's real one.
 *
 * Red-first seam (the #B498 harness names): GINA_SERVER_SRC / GINA_ISAAC_SRC point the file at
 * another tree's sources.
 *
 * Run standalone:
 *   node --test test/core/gina-endpoints-query-anchor-b712.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var SERVER_SRC = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');
var ISAAC_SRC  = process.env.GINA_ISAAC_SRC  || path.join(FW, 'core/server.isaac.js');
var SOURCES    = {
    'server.js'      : fs.readFileSync(SERVER_SRC, 'utf8'),
    'server.isaac.js': fs.readFileSync(ISAAC_SRC, 'utf8')
};


// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** The index of a needle that must occur exactly once in `src`. */
function uniqueAt(src, needle, label) {
    var at = src.indexOf(needle);
    assert.ok(at > -1, label + ': anchor not found: ' + needle);
    assert.equal(src.indexOf(needle, at + 1), -1, label + ': the anchor must be unique: ' + needle);
    return at;
}

/**
 * The condition of the `if (…) {` that holds a unique needle: from the `if (` before it to the
 * `) {` after it — comments inside the condition included, so newlines are kept.
 */
function conditionAround(src, needle, label) {
    var at      = uniqueAt(src, needle, label);
    var ifAt    = src.lastIndexOf('if (', at);
    var closeAt = src.indexOf(') {', at);
    assert.ok(ifAt > -1 && closeAt > at, label + ': could not bound the condition');
    return src.slice(ifAt + 'if ('.length, closeAt);
}

/** The right-hand side of a unique `var <name> = …;` statement. */
function assignmentOf(src, decl, label) {
    var at  = uniqueAt(src, decl, label);
    var end = src.indexOf(';', at);
    assert.ok(end > at, label + ': the statement has no end');
    return src.slice(at + decl.length, end);
}

/** A fake `process` for the conditions that read the dev flag or the Inspector opt-ins. */
function fakeProcess(opt) {
    return {
        env : { NODE_ENV_IS_DEV: opt.dev ? 'true' : 'false' },
        gina: { _inspectorInstrumentEnabled: !!opt.instrument, _inspectorAgentEnabled: !!opt.agentEnabled }
    };
}

/**
 * Each engine's handler conditions as functions of the url (and, where the handler has one, the
 * method and the gate): `(url, opt) → boolean`, with `opt` = { method, dev, instrument,
 * agentEnabled }. isaac's dev handlers read `isCacheless`; core/server.js's read
 * `process.env.NODE_ENV_IS_DEV`; both read `process.gina` for the opt-ins.
 */
function compile(engine) {
    var src = SOURCES[engine];
    var cond = function (needle, label) {
        return new Function('request', '_healthMethod', 'isCacheless', 'process',
            'return !!(' + conditionAround(src, needle, engine + ' ' + label) + '\n);');
    };
    var run = function (fn) {
        return function (url, opt) {
            opt = opt || {};
            var method = opt.method || 'GET';
            var dev    = ( typeof(opt.dev) == 'undefined' ) ? true : opt.dev;
            return fn({ method: method, url: url }, method.toUpperCase(), dev,
                fakeProcess({ dev: dev, instrument: opt.instrument, agentEnabled: opt.agentEnabled }));
        };
    };
    var jobsDecl = ( engine === 'server.js' ) ? 'var _ginaJobsMatch = ' : 'var _jobsMatch = ';
    var pathDecl = ( engine === 'server.js' ) ? 'var _bmPath = '        : 'var _inspPath = ';
    var jobs     = new Function('request', 'return (' + assignmentOf(src, jobsDecl, engine + ' jobs') + '\n);');
    var assetOf  = new Function('request', 'return (' + assignmentOf(src, pathDecl, engine + ' inspector asset path') + '\n);');
    var ws       = new Function('req', 'return !!(' + conditionAround(src, '_gina\\/agent(?:\\?|$)/.test(req.url', engine + ' agent upgrade listener') + '\n);');
    return {
        health    : run(cond('_gina\\/health\\/check(?:\\?|$)/i.test(request.url)', 'health')),
        instrument: run(cond('_gina\\/instrument(?:\\?|$)/.test(request.url)', 'instrument')),
        inspector : run(cond('_gina\\/inspector(\\/', 'inspector')),
        logs      : run(cond('_gina\\/logs', 'logs')),
        agent     : run(cond('_gina\\/agent(?:\\?|$)/.test(request.url)', 'agent')),
        indexes   : run(cond('_gina\\/indexes', 'indexes')),
        reveal    : run(cond('_gina\\/reveal', 'reveal')),
        jobId     : function (url, method) { var m = jobs({ method: method || 'GET', url: url }); return m ? m[1] : null; },
        assetPath : function (url) { return assetOf({ url: url }); },
        upgrade   : function (url) { return ws({ url: url }); }
    };
}

var ENGINES = {
    'server.js'      : compile('server.js'),
    'server.isaac.js': compile('server.isaac.js')
};

/** The HTTP endpoints, the path each one answers, and the options that open its gate. */
var ENDPOINTS = [
    { key: 'health',     ep: 'health/check', open: {} },
    { key: 'instrument', ep: 'instrument',   open: { instrument: true } },
    { key: 'inspector',  ep: 'inspector',    open: {} },
    { key: 'logs',       ep: 'logs',         open: {} },
    { key: 'agent',      ep: 'agent',        open: {} },
    { key: 'indexes',    ep: 'indexes',      open: {} },
    { key: 'reveal',     ep: 'reveal',       open: {} }
];


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

Object.keys(ENGINES).forEach(function (engine) {
    var E = ENGINES[engine];

    describe('#B712 01 — ' + engine + ': an endpoint path in the QUERY string no longer reaches the handler', function () {

        ENDPOINTS.forEach(function (d) {
            var match = function (url) { return E[d.key](url, d.open); };

            it('01  ' + d.ep + ': control — the bare path and a prefixed path match', function () {
                assert.equal(match('/_gina/' + d.ep), true, 'the bare path');
                assert.equal(match('/web/deep/page/_gina/' + d.ep), true, 'any prefix still reaches it (the Inspector sends the opener\'s full pathname)');
            });

            it('01  ' + d.ep + ': a page url whose query string ends in the endpoint path does not match (#B712)', function () {
                [ '/web/?next=/_gina/' + d.ep,
                  '/app/page?a=1&next=/_gina/' + d.ep,
                  '/web/?next=/_gina/' + d.ep + '?x=1' ].forEach(function (u) {
                    assert.equal(match(u), false, u + ' is the page\'s, not the ' + d.ep + ' handler\'s');
                });
            });

            it('01  ' + d.ep + ': the path with a query string matches (#B717 residual for logs, indexes, reveal, inspector)', function () {
                assert.equal(match('/_gina/' + d.ep + '?x=1'), true, '/_gina/' + d.ep + '?x=1 must reach the handler');
                assert.equal(match('/web/_gina/' + d.ep + '?x=1'), true, 'a prefixed path with a query string too');
                assert.equal(match('/web/_gina/' + d.ep + '?next=/_gina/other'), true, 'a query naming another /_gina/ path does not stop it');
            });

            it('01  ' + d.ep + ': control — a longer name does not match', function () {
                assert.equal(match('/_gina/' + d.ep + 'x'), false, '/_gina/' + d.ep + 'x must not reach the handler');
            });
        });

        it('01  control — the health check keeps its letter-case tolerance; the dev endpoints stay case-sensitive', function () {
            assert.equal(E.health('/_GINA/HEALTH/CHECK'), true, 'the i flag is kept');
            assert.equal(E.logs('/_GINA/LOGS'), false, 'the dev endpoints never matched another case');
        });

        it('01  control — the inspector keeps its sub-paths, with or without a query string', function () {
            assert.equal(E.inspector('/_gina/inspector/'), true);
            assert.equal(E.inspector('/_gina/inspector/inspector.js'), true);
            assert.equal(E.inspector('/_gina/inspector/inspector.js?v=1'), true);
        });

        it('01  an Inspector sub-path inside a page\'s query string is the page\'s (#B712)', function () {
            assert.equal(E.inspector('/web/?next=/_gina/inspector/inspector.js'), false);
        });
    });

    describe('#B712 02 — ' + engine + ': the gates and methods are the handlers\' own', function () {

        it('02.1  the dev endpoints answer only in dev', function () {
            [ 'inspector', 'logs', 'indexes', 'reveal' ].forEach(function (k) {
                var d = ENDPOINTS.filter(function (x) { return x.key === k; })[0];
                assert.equal(E[k]('/_gina/' + d.ep, { dev: false }), false, k + ' outside dev');
                assert.equal(E[k]('/_gina/' + d.ep, { dev: true }), true, k + ' in dev');
            });
        });

        it('02.2  the agent answers in dev, or outside dev when it is enabled', function () {
            assert.equal(E.agent('/_gina/agent', { dev: false }), false);
            assert.equal(E.agent('/_gina/agent', { dev: false, agentEnabled: true }), true);
        });

        it('02.3  #B712 holds outside dev too: an enabled agent does not take a page url whose query ends in its path', function () {
            assert.equal(E.agent('/web/?next=/_gina/agent', { dev: false, agentEnabled: true }), false);
        });

        it('02.4  instrument exists only when enabled; the health check answers GET and HEAD, not POST', function () {
            assert.equal(E.instrument('/_gina/instrument', { instrument: false }), false);
            assert.equal(E.instrument('/_gina/instrument', { instrument: true, method: 'POST' }), true);
            assert.equal(E.health('/_gina/health/check', { method: 'HEAD' }), true);
            assert.equal(E.health('/_gina/health/check', { method: 'POST' }), false);
        });
    });

    describe('#B712 03 — ' + engine + ': jobs/:id reads the id from the url\'s path', function () {

        it('03.1  the id of the bare path (control), a trailing slash, a query string and a prefix', function () {
            assert.equal(E.jobId('/_gina/jobs/abc'), 'abc', 'control');
            assert.equal(E.jobId('/_gina/jobs/abc/'), 'abc');
            assert.equal(E.jobId('/_gina/jobs/abc?x=1'), 'abc');
            assert.equal(E.jobId('/web/_gina/jobs/abc'), 'abc');
            assert.equal(E.jobId('/_gina/jobs/abc?next=/_gina/jobs/def'), 'abc', 'the path\'s id, not the query\'s');
        });

        it('03.2  a page url whose query string ends in a job path is not the jobs handler\'s (#B712)', function () {
            assert.equal(E.jobId('/web/?next=/_gina/jobs/abc'), null);
            assert.equal(E.jobId('/app/page?a=1&next=/_gina/jobs/abc'), null);
        });

        it('03.3  GET only (control on the extraction)', function () {
            assert.equal(E.jobId('/_gina/jobs/abc', 'POST'), null);
        });
    });

    describe('#B712 04 — ' + engine + ': the Inspector reads its asset path from the url\'s path', function () {

        it('04.1  the asset named by the path, with or without a query string or a prefix', function () {
            assert.equal(E.assetPath('/_gina/inspector/'), '', 'control — the index');
            assert.equal(E.assetPath('/_gina/inspector/inspector.js'), 'inspector.js', 'control');
            assert.equal(E.assetPath('/_gina/inspector/inspector.js?v=1'), 'inspector.js');
            assert.equal(E.assetPath('/web/deep/page/_gina/inspector/inspector.css'), 'inspector.css');
            assert.equal(E.assetPath('/_gina/inspector?x=1'), '', 'the bare path with a query string is the index');
        });

        it('04.2  a query string naming another Inspector path does not pick the file (#B712)', function () {
            assert.equal(E.assetPath('/_gina/inspector/inspector.js?next=/_gina/inspector/logo.svg'), 'inspector.js');
        });
    });
});

describe('#B712 05 — the agent WebSocket upgrade listeners match the path, and agree', function () {

    // core/server.js: the condition is true when its listener RETURNS (not the agent's upgrade);
    // isaac: true when it DEFERS to core/server.js (the agent's upgrade). They must be opposites.
    var serverTakes = function (url) { return !ENGINES['server.js'].upgrade(url); };
    var isaacDefers = function (url) { return ENGINES['server.isaac.js'].upgrade(url); };

    it('05.1  the agent path, with a key and under a prefix, is the agent\'s (control)', function () {
        [ '/_gina/agent', '/_gina/agent?key=K', '/web/deep/page/_gina/agent' ].forEach(function (u) {
            assert.equal(serverTakes(u), true, 'core/server.js takes ' + u);
            assert.equal(isaacDefers(u), true, 'isaac defers ' + u);
        });
    });

    it('05.2  a page url whose query string ends in the agent path is not the agent\'s (#B712)', function () {
        [ '/web/?next=/_gina/agent', '/app/page?a=1&next=/_gina/agent' ].forEach(function (u) {
            assert.equal(serverTakes(u), false, 'core/server.js must leave ' + u);
            assert.equal(isaacDefers(u), false, 'isaac must keep ' + u + ' for engine.io');
        });
    });

    it('05.3  another upgrade and a missing url are not the agent\'s', function () {
        assert.equal(serverTakes('/socket.io/?EIO=4&transport=websocket'), false);
        assert.equal(isaacDefers('/socket.io/?EIO=4&transport=websocket'), false);
        assert.equal(serverTakes(undefined), false);
        assert.equal(isaacDefers(undefined), false);
    });
});
