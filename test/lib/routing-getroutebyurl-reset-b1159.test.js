'use strict';
/**
 * #B1159 — a route candidate that does not match leaves the request as it found it.
 *
 * `lib/routing`'s getRouteByUrl tries each candidate rule in turn. compareUrls writes each value it
 * binds into `request.params` and into the method's bag (`request[request.method.toLowerCase()]`)
 * before a later segment fails, and a value reaches the bag only when the key is not there yet. So
 * the next candidate started from the failed one's keys (the matched route's own value lost to the
 * failed one's), and on a miss the caller kept them: redirect() looks its target up twice (its own
 * method, then GET) and carries the bag across a POST→GET redirect. getRouteByUrl now puts both
 * back, in place, before every candidate and after a lookup that matched nothing.
 *
 * §01 — controls: what a failed candidate writes (compareUrls alone), and a direct match.
 * §02 — the real getRouteByUrl: a hit after a failed candidate, and a miss (bag present, bag absent).
 * §03 — in place: the bag keeps its object (a shared query object, an array body).
 * §04 — the real redirect() over HTTP/1.1: a POST→GET redirect carries the client's keys only.
 * §05 — source and dist pins (lib/routing is in the browser bundle).
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var http = require('http');
var Module = require('module');

var FW = require('../fw');
var REPO = path.join(FW, '..', '..');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
var SRC_CTL = path.join(FW, 'core/controller/controller.js');
var strip = require('../strip-comments');

// node:test runs each file in its own process: the globals installed below stay in this file
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
Module._initPaths();
require(path.join(FW, 'helpers'));               // installs _, getPath, setContext/getContext …
require(path.join(REPO, 'utils', 'prototypes'));  // installs JSON.clone …
setPath('gina', { core: path.join(FW, 'core') });

var routing = require(ROUTING_SRC);               // the module exports a ready instance

// Each first rule binds `grp`, then fails its `id` requirement on a non-numeric segment: the
// partial write. Each second rule matches the same URL and binds `grp` from another segment.
var TABLE = {
    's1@b1159s': { method: 'GET', url: '/s/:grp/:id', bundle: 'b1159s', param: { control: 'one', grp: ':grp', id: ':id' }, requirements: { id: '/^\\d+$/' }, middleware: [] },
    's2@b1159s': { method: 'GET', url: '/s/:x/:grp', bundle: 'b1159s', param: { control: 'two', x: ':x', grp: ':grp' }, middleware: [] },
    'm1@b1159s': { method: 'GET', url: '/m/:grp/:id', bundle: 'b1159s', param: { control: 'mone', grp: ':grp', id: ':id' }, requirements: { id: '/^\\d+$/' }, middleware: [] },
    'p1@b1159p': { method: 'POST', url: '/p/:grp/:id', bundle: 'b1159p', param: { control: 'pone', grp: ':grp', id: ':id' }, requirements: { id: '/^\\d+$/' }, middleware: [] },
    'p2@b1159p': { method: 'POST', url: '/p/:x/:grp', bundle: 'b1159p', param: { control: 'ptwo', x: ':x', grp: ':grp' }, middleware: [] },
    'rp@b': { method: 'POST', url: '/r/:grp/:id', bundle: 'b', param: { control: 'rpost', grp: ':grp', id: ':id' }, requirements: { id: '/^\\d+$/' }, middleware: [] },
    'rg@b': { method: 'GET', url: '/r/:a/:b', bundle: 'b', param: { control: 'rget', a: ':a', b: ':b' }, middleware: [] }
};

/**
 * Points the routing lib at TABLE for `bundle` (getRouteByUrl reads getContext('gina').config).
 *
 * @inner
 * @param {string} bundle
 * @param {string} [hostname]
 * @returns {void}
 */
function useConfig(bundle, hostname) {
    var envConf = {};
    ['b1159s', 'b1159p', 'b'].forEach(function (b) {
        envConf[b] = { dev: { hostname: hostname || 'http://localhost:3159', server: { webroot: '/' } } };
    });
    process.gina = process.gina || {};
    setContext('isProxyHost', false);
    setContext('gina', { config: { env: 'dev', bundle: bundle, getRouting: function () { return TABLE; }, envConf: envConf } });
}

/**
 * A request as getRouteByUrl receives it; `bag` (when given) is the method's bag.
 *
 * @inner
 * @param {string} method - lower case, as the writers key the bag
 * @param {string} url
 * @param {object} [bag]
 * @returns {object}
 */
function request(method, url, bag) {
    var r = { routing: {}, isXMLRequest: false, method: method, params: {}, url: url };
    if ( typeof(bag) != 'undefined' ) { r[method] = bag; }
    return r;
}

/**
 * Runs getRouteByUrl with console.warn collected (a miss warns on the server).
 *
 * @inner
 * @returns {Promise<{route: (object|boolean), warns: number}>}
 */
async function lookup(url, bundle, method, req) {
    var saved = console.warn, warns = 0;
    console.warn = function () { warns++; };
    try {
        var route = await routing.getRouteByUrl(url, bundle, method, req);
        return { route: route, warns: warns };
    } finally {
        console.warn = saved;
    }
}

// ─── 01 — controls ────────────────────────────────────────────────────────────
describe('#B1159 §01 — controls', function () {

    it('CONTROL: compareUrls alone — a failed candidate binds `grp` before its `id` requirement fails', async function () {
        useConfig('b1159s');
        var rule = TABLE['s1@b1159s'];
        var params = { method: 'GET', requirements: rule.requirements, url: '/s/g1/xyz', rule: 's1@b1159s',
            param: JSON.clone(rule.param), middleware: [], bundle: 'b1159s', isXMLRequest: false };
        var req = request('get', '/s/g1/xyz', {});
        var r = await routing.compareUrls(params, rule.url, req);
        assert.equal(r.past, false, 'the candidate does not match');
        assert.equal(req.params.grp, 'g1', 'the partial write in params');
        assert.equal(req.get.grp, 'g1', 'the partial write in the bag');
    });

    it('CONTROL: a direct match keeps the values it bound', async function () {
        useConfig('b1159s');
        var req = request('get', '/s/g1/42', {});
        var r = await lookup('/s/g1/42', 'b1159s', 'GET', req);
        assert.equal(r.route.name, 's1@b1159s');
        assert.deepEqual(Object.assign({}, req.params), { grp: 'g1', id: '42' });
        assert.equal(req.get.grp, 'g1');
        assert.equal(req.get.id, '42');
    });
});

// ─── 02 — the real getRouteByUrl ──────────────────────────────────────────────
describe('#B1159 §02 — a failed candidate leaves nothing on the request', function () {

    it('a hit after a failed candidate: the bag holds the matched route\'s value (bag present)', async function () {
        useConfig('b1159s');
        var req = request('get', '/s/g1/xyz', {});
        var r = await lookup('/s/g1/xyz', 'b1159s', 'GET', req);
        assert.equal(r.route.name, 's2@b1159s', 'the second rule matches');
        assert.equal(req.params.grp, 'xyz');
        assert.equal(req.get.x, 'g1');
        assert.equal(req.get.grp, 'xyz', 'the failed candidate\'s `grp` must not stay in the bag');
    });

    it('a hit after a failed candidate: the bag holds the matched route\'s value (bag absent)', async function () {
        useConfig('b1159s');
        var req = request('get', '/s/g1/xyz');
        var r = await lookup('/s/g1/xyz', 'b1159s', 'GET', req);
        assert.equal(r.route.name, 's2@b1159s', 'the second rule matches');
        assert.equal(req.get.grp, 'xyz', 'the failed candidate\'s `grp` must not stay in the bag');
    });

    it('a miss leaves params and a present bag as they came', async function () {
        useConfig('b1159s');
        var req = request('get', '/m/g1/xyz', { q: 'v' });
        var r = await lookup('/m/g1/xyz', 'b1159s', 'GET', req);
        assert.equal(r.route, false, 'nothing matches');
        assert.ok(r.warns > 0, 'the miss path ran');
        assert.deepEqual(Object.assign({}, req.params), {}, 'no key of the failed candidate in params');
        assert.deepEqual(Object.assign({}, req.get), { q: 'v' }, 'the bag as it came');
    });

    it('a miss leaves an absent bag absent', async function () {
        useConfig('b1159s');
        var req = request('get', '/m/g1/xyz');
        var r = await lookup('/m/g1/xyz', 'b1159s', 'GET', req);
        assert.equal(r.route, false, 'nothing matches');
        assert.equal(typeof(req.get), 'undefined', 'the bag the failed candidate created is gone');
        assert.deepEqual(Object.assign({}, req.params), {});
    });

    it('a POST lookup: the bag holds the matched route\'s value and the client\'s key', async function () {
        useConfig('b1159p');
        var req = request('post', '/p/g1/xyz', { note: 'n1' });
        var r = await lookup('/p/g1/xyz', 'b1159p', 'POST', req);
        assert.equal(r.route.name, 'p2@b1159p', 'the second rule matches');
        assert.equal(req.post.note, 'n1', 'the client\'s key stays');
        assert.equal(req.post.grp, 'xyz', 'the failed candidate\'s `grp` must not stay in the bag');
    });
});

// ─── 03 — in place ────────────────────────────────────────────────────────────
describe('#B1159 §03 — the bag keeps its object', function () {

    it('CONTRACT: a bag that is also the query object stays that object (a hit)', async function () {
        useConfig('b1159s');
        var q = { q: 'v' };
        var req = request('get', '/s/g1/xyz', q);
        req.query = q;
        await lookup('/s/g1/xyz', 'b1159s', 'GET', req);
        assert.equal(req.get, q);
        assert.equal(req.query, q);
    });

    it('CONTRACT: a bag that is also the query object stays that object (a miss)', async function () {
        useConfig('b1159s');
        var q = { q: 'v' };
        var req = request('get', '/m/g1/xyz', q);
        req.query = q;
        await lookup('/m/g1/xyz', 'b1159s', 'GET', req);
        assert.equal(req.get, q);
        assert.equal(req.query, q);
    });

    it('CONTRACT: an array body stays the array, shared with request.body', async function () {
        useConfig('b1159p');
        var body = [ { n: 1 } ];
        var req = request('post', '/p/g1/xyz', body);
        req.body = body;
        await lookup('/p/g1/xyz', 'b1159p', 'POST', req);
        assert.ok(Array.isArray(req.post), 'still an array');
        assert.equal(req.post, body);
        assert.equal(req.body, body);
        assert.equal(req.post.length, 1);
    });
});

// ─── 04 — the real redirect() ─────────────────────────────────────────────────
var STATUS_CODES = { '200': 'OK', '301': 'Moved Permanently', '302': 'Found', '303': 'See Other', '404': 'Not Found', '500': 'Internal Server Error' };
var SuperController = null, LIB = null, REAL_GRBU = null, SERVER = null, PORT = 0;
var CUR = null, SAVED_LOGGER = {};

/**
 * The server's handler: one controller instance per request, its redirect() called with the arm's
 * arguments; the request is a POST whose body bag is `{ note: 'n1' }` and that has no `get` bag.
 *
 * @inner
 * @returns {void}
 */
function onRequest(req, res) {
    var rec = CUR;
    if ( !rec || req.headers['x-arm'] !== rec.id ) { res.writeHead(599); res.end('no arm'); return; }
    req.routing = { rule: 'act@b', name: 'act@b', url: '/act', bundle: 'b', method: 'POST', param: { control: 'act' } };
    req.post = { note: 'n1' };
    req.body = req.post;
    req.params = {};
    req._ginaReqId = 'REQ-B1159';
    var p = null;
    try {
        var inst = SuperController.createTestInstance({ req: req, res: res, next: function () {}, options: {
            rule: 'act@b', control: 'act', encoding: 'utf8', isXMLRequest: false, isUsingTemplate: false,
            conf: {
                bundle: 'b', env: 'dev', encoding: 'utf8',
                hostname: 'http://127.0.0.1:' + PORT, host: '127.0.0.1:' + PORT,
                server: { scheme: 'http', webroot: '/', protocolShort: 'http/1.1',
                    coreConfiguration: { statusCodes: STATUS_CODES, mime: { html: 'text/html', json: 'application/json' } } },
                content: { routing: TABLE, templates: { _common: {} } }
            } } });
        p = inst.redirect.apply(inst, rec.args);
    } catch (e) {
        rec.syncThrow = e;
    }
    Promise.resolve(p).then(function () {
        rec.settled = 'resolved';
        if ( !res.headersSent ) { res.writeHead(598); res.end(); }
    }, function (err) {
        rec.settled = 'rejected';
        rec.rejection = err;
        if ( !res.headersSent ) { res.writeHead(500); res.end(); }
    });
}

/**
 * Drives the real redirect() once over HTTP/1.1 and reads what the client received.
 *
 * @inner
 * @param {Array} args - redirect()'s arguments
 * @returns {Promise<{settled: ?string, status: number, location: ?string, matcherCalls: number}>}
 */
async function drive(args) {
    var rec = { id: 'arm-' + Date.now(), args: args, settled: null, rejection: null, syncThrow: null, matcherCalls: 0 };
    useConfig('b', 'http://127.0.0.1:' + PORT);
    CUR = rec;
    var savedWarn = console.warn, savedDebug = console.debug;
    console.warn = function () {};
    console.debug = function () {};
    var client = null;
    try {
        client = await new Promise(function (resolve) {
            var r = http.request({ host: '127.0.0.1', port: PORT, path: '/act', method: 'POST', agent: false,
                headers: { 'x-arm': rec.id, 'connection': 'close', 'content-length': '0' } }, function (resp) {
                resp.resume();
                resp.on('end', function () { resolve({ status: resp.statusCode, location: resp.headers.location || null }); });
            });
            r.on('error', function (e) { resolve({ error: e.code || e.message }); });
            r.setTimeout(5000, function () { r.destroy(new Error('client timeout')); });
            r.end();
        });
        for (var k = 0; k < 40 && rec.settled === null; k++) { await new Promise(function (r) { setTimeout(r, 10); }); }
    } finally {
        console.warn = savedWarn;
        console.debug = savedDebug;
        CUR = null;
    }
    assert.equal(rec.syncThrow, null, 'harness: redirect() threw synchronously');
    return { settled: rec.settled, rejection: rec.rejection, status: client.status, location: client.location, matcherCalls: rec.matcherCalls };
}

describe('#B1159 §04 — a POST→GET redirect carries the client\'s keys, not a failed candidate\'s', function () {

    before(async function () {
        process.env.NODE_SCOPE_IS_LOCAL = 'false';
        delete require.cache[require.resolve(SRC_CTL)];
        SuperController = require(SRC_CTL);
        LIB = require(path.join(FW, 'lib'));
        ['debug', 'info', 'warn'].forEach(function (lv) {
            SAVED_LOGGER[lv] = LIB.logger[lv];
            LIB.logger[lv] = function () {};
        });
        REAL_GRBU = LIB.routing.getRouteByUrl;
        LIB.routing.getRouteByUrl = async function () {
            if ( CUR ) { CUR.matcherCalls++; }
            return REAL_GRBU.apply(this, arguments);
        };
        SERVER = http.createServer(onRequest);
        PORT = await new Promise(function (r) { SERVER.listen(0, '127.0.0.1', function () { r(SERVER.address().port); }); });
    });

    after(async function () {
        if ( LIB ) {
            LIB.routing.getRouteByUrl = REAL_GRBU;
            Object.keys(SAVED_LOGGER).forEach(function (lv) { LIB.logger[lv] = SAVED_LOGGER[lv]; });
        }
        if ( SERVER ) { await new Promise(function (r) { SERVER.close(function () { r(); }); }); }
    });

    it('the redirect to a GET route after a POST candidate failed carries `note`, not `grp`', async function () {
        var r = await drive(['/r/g1/xyz', false]);
        assert.equal(r.settled, 'resolved', 'redirect() resolved' + (r.rejection ? ' (rejected: ' + r.rejection.message + ')' : ''));
        assert.equal(r.matcherCalls, 2, 'the POST lookup, then the GET one');
        assert.equal(r.status, 303, 'a POST redirected to a GET route');
        var m = /[?&]inheritedData=([^&#]*)/.exec(r.location || '');
        assert.ok(m, 'the request data rides the Location (no session): ' + r.location);
        var carried = JSON.parse(decodeURIComponent(m[1]));
        assert.equal(carried.note, 'n1', 'the client\'s key is carried');
        assert.equal(carried.b, 'xyz', 'the matched GET route\'s value is carried');
        assert.equal(Object.prototype.hasOwnProperty.call(carried, 'grp'), false,
            'the failed POST candidate\'s `grp` must not be carried: ' + JSON.stringify(carried));
    });
});

// ─── 05 — source and dist pins ────────────────────────────────────────────────
describe('#B1159 §05 — source and dist pins', function () {

    var NEEDLE = 'restoreRequestBag(request, reqMethodKey, bagSnapshot);';

    it('source: the snapshots precede the loop; a restore before each candidate and one on a miss', function () {
        var live = strip.all(fs.readFileSync(ROUTING_SRC, 'utf8'));
        var fn = live.indexOf('self.getRouteByUrl = async function');
        assert.ok(fn > -1, 'getRouteByUrl found');
        var snap = live.indexOf("var paramsSnapshot  = snapshotRequestBag(request, 'params');", fn);
        var bag = live.indexOf('var bagSnapshot     = snapshotRequestBag(request, reqMethodKey);', fn);
        var first = live.indexOf(NEEDLE, fn);
        var compare = live.indexOf('isRoute = await self.compareUrls(params, routing[name].url, request);', fn);
        var second = live.indexOf(NEEDLE, first + 1);
        var missArm = live.indexOf('var urlHasChanged = false;', fn);
        assert.ok(snap > fn && bag > snap, 'the snapshots, in getRouteByUrl');
        assert.ok(first > bag && first < compare, 'a restore before the candidate is compared');
        assert.ok(second > compare && second < missArm, 'a restore when nothing matched, before the miss arm');
        assert.equal(live.split(NEEDLE).length - 1, 2, 'two restores of the bag');
    });

    it('dist: gina.js carries the restore', function () {
        assert.ok(fs.readFileSync(DIST_JS, 'utf8').indexOf(NEEDLE) > -1, 'rebuild the bundle (lib/routing is browser-bundled)');
    });

    it('dist: gina.min.js carries the snapshot (its property names survive minification)', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8');
        assert.ok(min.indexOf('ownValues') > -1, 'rebuild the bundle (lib/routing is browser-bundled)');
    });

    it('CONTROL: both dist files are the bundle that holds getRouteByUrl', function () {
        assert.ok(fs.readFileSync(DIST_JS, 'utf8').indexOf('self.getRouteByUrl = async function') > -1);
        assert.ok(/getRouteByUrl\s*=\s*async function/.test(fs.readFileSync(DIST_MIN, 'utf8')));
    });
});
