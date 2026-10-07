'use strict';
/**
 * #B812 — a route middleware whose returned promise rejects is answered with a 500.
 *
 * `processMiddlewares` (core/router.js) called a route middleware's method and discarded what it
 * returned. An `async` middleware that threw after an await, or that handed over through `done` to a
 * later middleware that threw (the throw then becomes the first one's rejection), left its request
 * unanswered until the client or a proxy timed out, and the rejection reached the process unhandled.
 * The call site now owns the promise the way the reserved hooks and the action do (#B399): a
 * rejection is answered through `serverInstance.throwError(res, 500, …)`, naming the middleware.
 *
 *  01 extraction control — the region is sliced from the source under test.
 *  02 behavioural — the REAL `processMiddlewares` bytes, real middleware files, run in a child
 *     process: on the pre-change bytes the rejection is unhandled, and the child records it with a
 *     listener of its own instead of letting it reach the test runner.
 *  03 source pins on the call site, comment-stripped, with the strip's own control.
 *
 * Seam: GINA_ROUTER_SRC=<absolute file> runs every arm against that text (the child inherits it).
 * Red-first against the pre-change bytes: the arms that pin the change read RED, the arms labelled
 * CONTROL stay GREEN.
 */
var { describe, it, before, after } = require('node:test');
var assert       = require('node:assert/strict');
var fs           = require('fs');
var os           = require('os');
var path         = require('path');
var childProcess = require('child_process');

var FW            = require('../fw');
var ROUTER_SOURCE = process.env.GINA_ROUTER_SRC || path.join(FW, 'core/router.js');
var ROUTER_SRC    = fs.readFileSync(ROUTER_SOURCE, 'utf8');

var DECL = '    var processMiddlewares = function(serverInstance, middlewares, controller, action, req, res, next, cb){';
var END  = '\n    init()\n';
function count(hay, needle) { return hay.split(needle).length - 1; }
function stripComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}
function region() {
    var a = ROUTER_SRC.indexOf(DECL);
    if ( a < 0 || ROUTER_SRC.indexOf(DECL, a + 1) > -1 ) { return null; }
    var b = ROUTER_SRC.indexOf(END, a);
    return ( b > a ) ? ROUTER_SRC.slice(a, b) : null;
}
var PM_SRC = region();

// ---- the child: compiles the region, drives four arms, prints one JSON line -------------------
var CHILD = [
    "'use strict';",
    "var fs = require('fs'), path = require('path'), Module = require('module');",
    "var SOURCE = process.env.GINA_ROUTER_SRC, TMP = process.env.B812_TMP;",
    "var inherits = require(path.join(process.env.B812_FW, 'lib/inherits/src/main'));",
    "var SRC = fs.readFileSync(SOURCE, 'utf8');",
    "var DECL = " + JSON.stringify(DECL) + ";",
    "var a = SRC.indexOf(DECL), b = SRC.indexOf(" + JSON.stringify(END) + ", a);",
    "function PathStub(p) { if (!(this instanceof PathStub)) { return p; } this.p = p; }",
    "PathStub.prototype.toString = function () { return this.p; };",
    "PathStub.prototype.existsSync = function () { return fs.existsSync(this.p); };",
    "var pm = new Function('local', '_', 'inherits', 'require', SRC.slice(a, b) + '\\nreturn processMiddlewares;')(",
    "    { conf: { bundlePath: path.join(TMP, 'bundle'), sharedPath: path.join(TMP, 'shared') }, isCacheless: false },",
    "    PathStub, inherits, Module.createRequire(SOURCE));",
    "var unhandled = [];",
    "process.on('unhandledRejection', function (reason) { unhandled.push(String(reason && reason.message || reason)); });",
    "function settle() { return new Promise(function (r) { setImmediate(function () { setImmediate(r); }); }); }",
    "async function arm(refs) {",
    "    unhandled.length = 0;",
    "    var answered = [], actions = 0, syncThrow = null, release;",
    "    var server = { throwError: function (res, code, msg) { answered.push(code + ' ' + String(msg).split('\\n')[0]); } };",
    "    var req = { release: new Promise(function (r) { release = r; }) };",
    "    try { pm(server, refs.slice(), {}, 'act', req, {}, function () {}, function () { actions++; }); }",
    "    catch (e) { syncThrow = e.message; }",
    "    release();",
    "    await settle();",
    "    return { answered: answered, actions: actions, unhandled: unhandled.slice(), syncThrow: syncThrow };",
    "}",
    "(async function () {",
    "    var out = {};",
    "    out.rejects    = await arm(['middlewares.arms.rejects']);",
    "    out.resolves   = await arm(['middlewares.arms.resolves']);",
    "    out.throwsSync = await arm(['middlewares.arms.throwsSync']);",
    "    out.chained    = await arm(['middlewares.arms.resolves', 'middlewares.arms.throwsSync']);",
    "    out.sync       = await arm(['middlewares.arms.pass']);",
    "    process.stdout.write(JSON.stringify(out) + '\\n');",
    "})();"
].join('\n');

var TMP = null, RESULT = null, CHILD_RUN = null;

before(function () {
    TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b812-')));
    var file = path.join(TMP, 'bundle', 'middlewares', 'arms', 'index.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
        'function ArmsMiddleware() {',
        '    this.rejects = async function (req, res, next, done) { await req.release; throw new Error("rejected after the await"); };',
        '    this.resolves = async function (req, res, next, done) { await req.release; done(req, res, next); };',
        '    this.throwsSync = function (req, res, next, done) { throw new Error("thrown synchronously"); };',
        '    this.pass = function (req, res, next, done) { done(req, res, next); };',
        '}',
        'module.exports = ArmsMiddleware;'
    ].join('\n') + '\n');
    var script = path.join(TMP, 'child.js');
    fs.writeFileSync(script, CHILD);
    CHILD_RUN = childProcess.spawnSync(process.execPath, [script], {
        encoding : 'utf8',
        timeout  : 30000,
        env      : Object.assign({}, process.env, { GINA_ROUTER_SRC: ROUTER_SOURCE, B812_FW: FW, B812_TMP: TMP })
    });
    var line = (CHILD_RUN.stdout || '').split('\n').filter(function (l) { return l.charAt(0) === '{'; })[0];
    RESULT = line ? JSON.parse(line) : null;
});

after(function () { if ( TMP ) { fs.rmSync(TMP, { recursive: true, force: true }); } });


describe('01 - extraction control', function () {

    it('CONTROL — processMiddlewares is declared once and the slice reaches the middleware call', function () {
        assert.ok(PM_SRC, 'the processMiddlewares region must be extractable');
        assert.equal(count(ROUTER_SRC, DECL), 1);
        assert.ok(PM_SRC.indexOf('middleware[constructor](req, res, next,') > -1);
    });
});


describe('02 - behavioural: the real processMiddlewares in a child process', function () {

    it('CONTROL — the child ran every arm and printed its result', function () {
        assert.equal(CHILD_RUN.status, 0, 'child exit status (stderr: ' + String(CHILD_RUN.stderr).slice(0, 400) + ')');
        assert.ok(RESULT, 'the child printed one JSON line');
        assert.deepEqual(Object.keys(RESULT).sort(), ['chained', 'rejects', 'resolves', 'sync', 'throwsSync']);
    });

    it('an async middleware that rejects after an await is answered 500, naming the middleware', function () {
        assert.deepEqual(RESULT.rejects.unhandled, [], 'the rejection is owned');
        assert.equal(RESULT.rejects.answered.length, 1);
        assert.ok(RESULT.rejects.answered[0].indexOf('500 route middleware `middlewares.arms.rejects` rejected: ') === 0, RESULT.rejects.answered[0]);
        assert.ok(RESULT.rejects.answered[0].indexOf('rejected after the await') > -1, 'the detail carries the error');
        assert.equal(RESULT.rejects.actions, 0, 'the action does not run');
    });

    it('a later middleware that throws, reached through done after an await, is answered 500', function () {
        assert.deepEqual(RESULT.chained.unhandled, [], 'the rejection is owned');
        assert.equal(RESULT.chained.answered.length, 1);
        assert.ok(/^500 route middleware `middlewares\.arms\.resolves` rejected: .*thrown synchronously/.test(RESULT.chained.answered[0]), RESULT.chained.answered[0]);
        assert.equal(RESULT.chained.actions, 0);
    });

    it('CONTROL — an async middleware that resolves and calls done runs the action once, unanswered by the guard', function () {
        assert.deepEqual(RESULT.resolves, { answered: [], actions: 1, unhandled: [], syncThrow: null });
    });

    it('CONTROL — a synchronous middleware that calls done runs the action once', function () {
        assert.deepEqual(RESULT.sync, { answered: [], actions: 1, unhandled: [], syncThrow: null });
    });

    it('CONTROL — a synchronous throw still leaves processMiddlewares synchronously (the router\'s own try answers it)', function () {
        assert.deepEqual(RESULT.throwsSync, { answered: [], actions: 0, unhandled: [], syncThrow: 'thrown synchronously' });
    });
});


describe('03 - source pins on the call site, comment-stripped', function () {

    var live = stripComments(PM_SRC || '');

    it('the middleware name is read before the call, and the call keeps its result', function () {
        assert.equal(count(live, 'let _mwName   = middlewares[m];'), 1);
        assert.equal(count(live, 'let _mwResult = middleware[constructor](req, res, next,'), 1);
        assert.ok(live.indexOf('let _mwName   = middlewares[m];') < live.indexOf('let _mwResult = middleware[constructor](req, res, next,'));
    });

    it('a thenable result gets a catch that answers 500 through serverInstance.throwError', function () {
        assert.equal(count(live, "if ( _mwResult && typeof _mwResult.then === 'function' ) {"), 1);
        assert.equal(count(live, '_mwResult.catch(function(err) {'), 1);
        assert.equal(count(live, "serverInstance.throwError(res, 500, 'route middleware `'+ _mwName +'` rejected: '"), 1);
    });

    it('CONTROL — the two 501 returns of the fail-closed guards are still there', function () {
        assert.equal(count(PM_SRC || '', 'return serverInstance.throwError(res, 501'), 2);
    });

    it('CONTROL — the strip is load-bearing: the raw region names #P15 in a comment, the stripped copy does not', function () {
        assert.ok((PM_SRC || '').indexOf('#P15') > -1);
        assert.equal(live.indexOf('#P15'), -1);
    });
});
