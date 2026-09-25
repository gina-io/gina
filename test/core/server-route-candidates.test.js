'use strict';
/**
 * #P46 S6 A — the cold routing loop's route-candidate index (`core/server.route-candidates.js`).
 *
 * `_handleDispatch` scans the bundle's routing table in declaration order and runs
 * `lib/routing`'s `compareUrls` on every rule; the index narrows the scan to the rules
 * that could match the request. Its one obligation is to be a SUPERSET of what the loop
 * accepts: skipping a rule the loop would have accepted changes the answer.
 *
 * Strategy: the REAL `lib/routing` (loaded through the framework's helpers bootstrap, the
 * routing-inherited-keys-b650 shape) and ONE copy of the loop, run twice per request —
 * without the index (today's full scan) and with it — over a catalogue table holding every
 * rule shape the index classifies, plus seeded generated tables. Both runs share the copy,
 * so a drift between the copy and `server.js` cannot hide an effect of the filter.
 *
 * Suites:
 *  01 — the index on its own: prototype-named paths, inline segments, classification,
 *       the paths it does not model, the raw-url lookup, the per-table cache
 *  02 — the differential proof: same winner, same status, same follow-up status,
 *       every arm; a sabotaged index must diverge (the harness can fail)
 *  03 — source pins: server.js wires the index where the dead trie lookup was
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var SERVER_SRC = path.join(FW, 'core/server.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var TABLE = {};
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));
var RC      = require(path.join(FW, 'core/server.route-candidates'));

var B     = 'b';
var SCOPE = 'local';

var RE_NUM   = '/^[0-9]+$/';
var RE_ALPHA = '/^[a-z]+$/';
var RE_EMPTY = '/^[0-9]*$/';

/**
 * A routing rule shaped as config.js stores it: every `:key` of every variant, and every
 * requirement key, declared in `param` as `":key"` (the binding `fitsWithRequirements`
 * needs), the bundle, the scopes and an empty middleware list.
 *
 * @inner
 * @param {*} url
 * @param {string} [method]
 * @param {object|null} [requirements]
 * @param {object} [opts] - `bundle`, `scopes`, `noParam` (drop `param`), `noUnboundParam` (do not declare requirement keys absent from the url)
 * @returns {object}
 */
function rule(url, method, requirements, opts) {
    opts = opts || {};
    var param = { control: 'act' };
    if (typeof url === 'string') {
        url.split(/\,/g).forEach(function (v) {
            v.split('/').forEach(function (s) {
                var m = s.match(/:(\w+)/);
                if (m) param[m[1]] = ':' + m[1];
            });
        });
    }
    if (requirements && !opts.noUnboundParam) {
        Object.keys(requirements).forEach(function (k) { if (!param[k]) param[k] = ':' + k; });
    }
    var r = { url: url, method: method || 'GET', param: param, bundle: opts.bundle || B, scopes: opts.scopes || [SCOPE], middleware: [] };
    if (requirements) r.requirements = requirements;
    if (opts.noParam) delete r.param;
    return r;
}

/**
 * Every rule shape the index classifies, in one table (declaration order matters: a
 * generic rule sits last so an earlier specific rule must still win).
 *
 * @constant
 * @type {Object<string, object>}
 */
var CATALOG = {
    'home@b'            : rule('/,/app'),                                             // the webroot rule's shape
    'static@b'          : rule('/app/a'),
    'static-multi@b'    : rule('/app/b', 'GET, POST'),
    'item@b'            : rule('/app/items/:id', 'GET', { id: RE_NUM }),
    'item-del@b'        : rule('/app/items/:id', 'DELETE', { id: RE_NUM }),
    'item-put@b'        : rule('/app/items/:id', 'PUT', { id: RE_NUM }),
    'slug@b'            : rule('/app/p/:slug'),
    'inline@b'          : rule('/app/articles/page:number', 'GET', { number: RE_NUM }),
    'inline-free@b'     : rule('/app/articles2/page:number'),                        // no requirement: captures the whole segment (#B646)
    'comma@b'           : rule('/app/help,/app/aide'),
    'comma-param@b'     : rule('/app/x/:a,/app/y,/app/z/:a', 'GET', { a: RE_ALPHA }),
    'search1@b'         : rule('/app/search', 'GET', { q: RE_ALPHA }),
    'search2@b'         : rule('/app/s2', 'GET', { q: RE_ALPHA, r: RE_ALPHA }),
    'search3@b'         : rule('/app/s3', 'GET', { q: RE_ALPHA, r: RE_ALPHA, t: RE_ALPHA }),
    'search1-bare@b'    : rule('/app/search-bare', 'GET', { q: RE_ALPHA }, { noUnboundParam: true }),
    'del-unbound@b'     : rule('/app/d/:id', 'DELETE', { id: RE_NUM, q: RE_ALPHA }),
    'proto-ctor@b'      : rule('/app/constructor'),
    'proto-tostring@b'  : rule('/app/toString'),
    'proto-dunder@b'    : rule('/app/__proto__/:id', 'GET', { id: RE_NUM }),
    'trailing@b'        : rule('/app/t/'),
    'relative0@b'       : rule('app/rel'),
    'relative1@b'       : rule('app/rel1', 'GET', { q: RE_ALPHA }),
    'encoded@b'         : rule('/app/a%20b'),
    'withquery@b'       : rule('/app/qq?x=1'),
    'spaced@b'          : rule('/app/w ,/app/w2'),
    'validator@b'       : rule('/app/v/:n', 'GET', { n: 'validator::{ isInteger: true }' }),
    'empty-ok@b'        : rule('/app/e/:id', 'GET', { id: RE_EMPTY }),
    'scoped@b'          : rule('/app/scoped', 'GET', null, { scopes: ['other'] }),
    'foreign@other'     : rule('/app/a', 'GET', null, { bundle: 'other' }),
    'noparam@b'         : rule('/app/np', 'GET', null, { noParam: true }),
    'notes-get@b'       : rule('/app/notes', 'GET'),
    'notes-post@b'      : rule('/app/notes', 'POST'),
    'multi@b'           : rule('/app/m', 'GET, POST'),
    'ws@b'              : rule('/app/ws', 'ws'),
    'generic@b'         : rule('/app/:x/:y')
};

/**
 * A value that passes `new RegExp(String(Object.prototype[name]))` on THIS engine (the
 * routing-inherited-keys-b650 instrument): after #B650 such keys must change nothing.
 *
 * @inner
 * @param {string} name
 * @returns {string}
 */
function craft(name) {
    return String(Object.prototype[name]).replace('()', '').replace('[native code]', 'n');
}

var noop = function () {};

/**
 * A request as the routing loop sees it: the path in `url`, `params[0]` set by the engine,
 * the placeholder `routing` `completeHeaders` gives an unrouted request, and the method bag.
 *
 * @inner
 * @param {{method: string, url: string, bag: (object|null)}} spec
 * @returns {object}
 */
function mkReq(spec) {
    var req = {
        url: spec.url, method: spec.method, headers: {}, params: { 0: spec.url },
        routing: { url: spec.url, method: spec.method, bundle: B },
        isXMLRequest: false, isWithCredentials: false
    };
    if (spec.bag !== null) req[spec.method.toLowerCase()] = Object.assign({}, spec.bag);
    return req;
}

/**
 * ONE copy of `_handleDispatch`'s cold loop (core/server.js, the `for (let name in routing)`
 * scan and its post-loop status), with the candidate filter where the engine applies it.
 * The per-method bag merge inside the match block is left out: it writes the request bags
 * only, never the winner or the status.
 *
 * @inner
 * @param {object} table
 * @param {string} bundle
 * @param {{method: string, url: string, bag: (object|null)}} spec
 * @param {function|null} candidatesOf - `(table, bundle, raw, decoded) → Set|null`, or null for the full scan
 * @returns {Promise<{status: number, rule: (string|null), second: (number|null), evaluated: number, candidates: (number|null), params: object}>}
 */
async function dispatch(table, bundle, spec, candidatesOf) {
    var req      = mkReq(spec);
    var pathname = req.url;
    var method   = req.method, reMethod = new RegExp(method, 'i');
    var _reqMethodKey  = (method || 'GET').toLowerCase();
    var _origParams    = Object.assign({}, req.params);
    var _origReqMethod = (typeof(req[_reqMethodKey]) != 'undefined') ? Object.assign({}, req[_reqMethodKey]) : undefined;
    var candidates     = candidatesOf ? candidatesOf(table, bundle, pathname, safeDecodeURI(pathname)) : null;

    var matched = false, isRoute = null, _routing = {}, params = {}, winner = null, e500 = null, mismatch405 = null, evaluated = 0;
    for (let name in table) {
        if ( typeof(table[name]) != 'object' || table[name] === null ) continue;
        if ( candidates !== null && !candidates.has(name) ) continue;
        if ( table[name].scopes.indexOf(SCOPE) < 0 ) continue;
        if ( typeof(table[name]['param']) == 'undefined' ) continue;

        req.params = Object.assign({}, _origParams);
        req[_reqMethodKey] = _origReqMethod ? Object.assign({}, _origReqMethod) : {};

        if (table[name].bundle != bundle) continue;

        var _routeMethod = table[name].method;
        if ( !/\,/.test(_routeMethod) && !reMethod.test(_routeMethod) ) {
            if ( /^head$/i.test(req.method) && /^get$/i.test(_routeMethod) ) {
                /* fall through */
            } else if ( /^get$/i.test(req.method) && /^delete$/i.test(_routeMethod) ) {
                /* fall through */
            } else {
                continue;
            }
        }

        method = table[name].method;
        if ( /\,/.test( method ) && reMethod.test(method) ) {
            method = req.method;
        }

        params = {
            method: method, control: table[name].param.control, requirements: table[name].requirements,
            namespace: table[name].namespace || undefined, url: safeDecodeURI(pathname),
            rule: table[name].originalRule || name, param: JSON.clone(table[name].param),
            middleware: JSON.clone(table[name].middleware), bundle: table[name].bundle,
            isXMLRequest: req.isXMLRequest, isWithCredentials: req.isWithCredentials
        };

        ++evaluated;
        try {
            isRoute = await routing.compareUrls(params, table[name].url, req, {}, noop);
        } catch (err) {
            e500 = name;
            break;
        }

        if ( pathname == table[name].url || isRoute.past ) {
            _routing = req.routing;
            var isMethodAllowed = reMethod.test(_routing.method);
            if (!isMethodAllowed) {
                if ( /^head$/i.test(req.method) && /^get$/i.test(_routing.method) ) {
                    isMethodAllowed = true;
                } else if ( /get/i.test(req.method) && /delete/i.test(_routing.method) ) {
                    req.method = _routing.method;
                    isMethodAllowed = true;
                } else {
                    mismatch405 = 'Method Not Allowed';
                    continue;
                }
            }
            if (isRoute.past) {
                matched = true;
                winner  = name;
                break;
            }
        }
    }

    var status = e500 ? 500 : (matched ? 200 : (mismatch405 ? 405 : 404));
    // after a compareUrls throw the engine answers 500, breaks, and throwError runs again for
    // the post-loop status (logged; the response is already sent)
    var second = e500 ? ((!matched && mismatch405) ? 405 : 404) : null;
    return { status: status, rule: winner || e500, second: second, evaluated: evaluated,
             candidates: (candidates === null) ? null : candidates.size, params: req.params };
}

/**
 * A deterministic PRNG (mulberry32).
 *
 * @inner
 * @param {number} seed
 * @returns {function(): number}
 */
function prng(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

var PROTO_NAMES = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty'];
var PARAM_VALUES = ['5', 'abc', '5x'];

/**
 * Request paths for one table: each variant of each rule instantiated (every parameter
 * value in PARAM_VALUES), then each instance with a segment added, dropped, emptied or
 * swapped, a trailing slash, a double slash, and prototype names in its last segment —
 * plus fixed paths for the root, the webroot, the raw-url cases and non-`/` paths.
 *
 * @inner
 * @param {object} table
 * @returns {string[]}
 */
function pathsFor(table) {
    var out = new Set([
        '/', '/app', '/app/', '//app', '/toString', '/constructor', '/__proto__', '/hasOwnProperty',
        '/app/help,/app/aide', '/app/a%20b', '/app/a b', '/app/qq?x=1', '/app/qq', '/app/items/5?x=1',
        '/app/w ', '/app/w2', 'app/rel', '/app/rel', 'app/rel1', '/app/articles/page5', '/app/articles/pagex', '/app/articles2/page5',
        '/app/e/', '/app/e/5', '/app/nothing/here/at/all'
    ]);
    Object.keys(table).forEach(function (name) {
        var url = table[name] && table[name].url;
        if (typeof url !== 'string') return;
        url.split(/\,/g).forEach(function (variant) {
            PARAM_VALUES.forEach(function (value) {
                var inst = variant.split('/').map(function (s) {
                    return (s.indexOf(':') > -1) ? s.replace(/:\w+/, value) : s;
                });
                var p = inst.join('/');
                out.add(p);
                out.add(p + '/x');
                out.add(p + '/');
                if (inst.length > 2) out.add(inst.slice(0, -1).join('/'));
                if (inst.length > 1) out.add(inst.slice(0, 1).concat('', inst.slice(1)).join('/'));
                if (inst.length > 2) { var sw = inst.slice(); sw[1] = 'zzz'; out.add(sw.join('/')); }
                if (inst.length > 1) { var em = inst.slice(); em[em.length - 1] = ''; out.add(em.join('/')); }
                PROTO_NAMES.forEach(function (pn) {
                    var pr = inst.slice(); pr[pr.length - 1] = pn; out.add(pr.join('/'));
                });
            });
        });
    });
    return Array.from(out);
}

var GET_BAGS = [
    null, {}, { q: 'abc' }, { q: 'abc', r: 'def' }, { q: 'abc', r: 'def', t: 'ghi' }, { id: '5' }, { q: '123' },
    { toString: craft('toString'), valueOf: craft('valueOf') }
];
var BODY_BAGS = [null, { q: 'abc' }];
var METHODS   = ['GET', 'HEAD', 'DELETE', 'POST', 'PUT'];

/**
 * Every (method, path, bag) arm for a table.
 *
 * @inner
 * @param {object} table
 * @returns {{method: string, url: string, bag: (object|null)}[]}
 */
function armsFor(table) {
    var arms = [];
    pathsFor(table).forEach(function (url) {
        METHODS.forEach(function (method) {
            var bags = /^(GET|HEAD|DELETE)$/.test(method) ? GET_BAGS : BODY_BAGS;
            bags.forEach(function (bag) { arms.push({ method: method, url: url, bag: bag }); });
        });
    });
    return arms;
}

/**
 * Runs every arm twice — full scan, then filtered — and returns the divergences and totals.
 *
 * @inner
 * @param {object} table
 * @param {{method: string, url: string, bag: (object|null)}[]} arms
 * @param {function} candidatesOf
 * @returns {Promise<{divergences: object[], arms: number, indexed: number, empty: number, evalFull: number, evalFiltered: number, bagDiffs: number}>}
 */
async function differential(table, arms, candidatesOf) {
    var res = { divergences: [], arms: 0, indexed: 0, empty: 0, evalFull: 0, evalFiltered: 0, bagDiffs: 0 };
    for (var i = 0; i < arms.length; i++) {
        var full = await dispatch(table, B, arms[i], null);
        var filt = await dispatch(table, B, arms[i], candidatesOf);
        ++res.arms;
        res.evalFull     += full.evaluated;
        res.evalFiltered += filt.evaluated;
        if (filt.candidates !== null) { ++res.indexed; if (filt.candidates === 0) ++res.empty; }
        if (full.status !== filt.status || full.rule !== filt.rule || full.second !== filt.second) {
            res.divergences.push({ arm: arms[i], full: [full.status, full.rule, full.second], filtered: [filt.status, filt.rule, filt.second] });
        }
        if (JSON.stringify(full.params) !== JSON.stringify(filt.params)) ++res.bagDiffs;
    }
    return res;
}

/**
 * A seeded table of generated rules: 1–4 segments drawn from a small vocabulary (so rules
 * collide), parameters, inline parameters, comma urls, trailing slashes, 0–3 requirements
 * not bound in the url, and every method shape.
 *
 * @inner
 * @param {number} seed
 * @param {number} count
 * @returns {object}
 */
function generatedTable(seed, count) {
    var rnd = prng(seed);
    var pick = function (a) { return a[Math.floor(rnd() * a.length)]; };
    var VOCAB = ['app', 'api', 'a', 'b', 'items', 'users', 'x', 'constructor', 'toString', 'help'];
    var table = {};
    for (var n = 0; n < count; n++) {
        var variants = [], nVariants = (rnd() < 0.15) ? 2 : 1, reqs = {};
        for (var v = 0; v < nVariants; v++) {
            var segs = ['', 'app'], len = 1 + Math.floor(rnd() * 3);
            for (var s = 0; s < len; s++) {
                var r = rnd();
                if (r < 0.55)      segs.push(pick(VOCAB));
                else if (r < 0.8)  { segs.push(':id'); if (rnd() < 0.7) reqs.id = pick([RE_NUM, RE_ALPHA, RE_EMPTY]); }
                else if (r < 0.9)  { segs.push(':slug'); }
                else               { segs.push('page:number'); if (rnd() < 0.7) reqs.number = RE_NUM; }
            }
            var u = segs.join('/');
            if (rnd() < 0.1) u += '/';
            variants.push(u);
        }
        var unbound = Math.floor(rnd() * 4);
        ['q', 'r', 't'].slice(0, unbound).forEach(function (k) { reqs[k] = RE_ALPHA; });
        var method = pick(['GET', 'GET', 'POST', 'DELETE', 'GET, POST', 'PUT']);
        table['g' + seed + '-' + n + '@b'] = rule(variants.join(','), method, Object.keys(reqs).length ? reqs : null);
    }
    return table;
}


// ─── 01 — the index on its own ─────────────────────────────────────────────────

describe('01 - #P46 S6 A: the candidate index', function () {

    it('01.1  prototype-named paths neither throw nor resolve inherited members (lookup and build)', function () {
        var t = { 'c@b': rule('/api/constructor'), 's@b': rule('/api/toString'), 'd@b': rule('/__proto__/:id') };
        var index = RC.build(t, B);
        PROTO_NAMES.forEach(function (pn) {
            var hit = RC.lookup(index, '/' + pn, '/' + pn);
            assert.ok(hit instanceof Set, 'lookup(/' + pn + ') returns a Set');
            assert.equal(hit.size, 0, '/' + pn + ' matches no rule: ' + Array.from(hit));
        });
        assert.deepEqual(Array.from(RC.lookup(index, '/api/constructor', '/api/constructor')), ['c@b']);
        assert.deepEqual(Array.from(RC.lookup(index, '/api/toString', '/api/toString')), ['s@b']);
        assert.deepEqual(Array.from(RC.lookup(index, '/__proto__/5', '/__proto__/5')), ['d@b']);
        assert.equal(RC.lookup(index, '/api/valueOf', '/api/valueOf').size, 0);
    });

    it('01.2  a `:` anywhere in a segment is a parameter (inline parameters are indexed)', function () {
        var index = RC.build({ 'p@b': rule('/articles/page:number', 'GET', { number: RE_NUM }) }, B);
        assert.deepEqual(Array.from(RC.lookup(index, '/articles/page3', '/articles/page3')), ['p@b']);
        assert.deepEqual(Array.from(RC.lookup(index, '/articles/anything', '/articles/anything')), ['p@b'],
            'the requirement decides, not the index');
    });

    it('01.3  classification: unbound requirements, non-`/` variants, whitespace, `?`/`#`, empty segments', function () {
        var C = RC.CLASS;
        assert.equal(RC.classifyVariant(undefined, '/a/:id'), C.TRIE);
        assert.equal(RC.classifyVariant({ id: RE_NUM }, '/a/:id'), C.TRIE, 'a bound key does not count');
        assert.equal(RC.classifyVariant({ q: RE_ALPHA }, '/a'), C.TRIE, 'ONE unbound key replaces only the leading empty slot');
        assert.equal(RC.classifyVariant({ q: RE_ALPHA, r: RE_ALPHA }, '/a'), C.ALWAYS, 'two replace a real segment');
        assert.equal(RC.classifyVariant({ number: RE_NUM }, '/a/page:number'), C.TRIE, 'an inline-only key counts as one unbound key');
        assert.equal(RC.classifyVariant({ number: RE_NUM, q: RE_ALPHA }, '/a/page:number'), C.ALWAYS);
        assert.equal(RC.classifyVariant(undefined, 'a/b'), C.SKIP, 'no leading `/`, no unbound key: one segment short of any path');
        assert.equal(RC.classifyVariant({ q: RE_ALPHA }, 'a/b'), C.ALWAYS, 'no leading `/`: index 0 is a real segment');
        assert.equal(RC.classifyVariant(undefined, '/a '), C.ALWAYS);
        assert.equal(RC.classifyVariant(undefined, ' /a'), C.ALWAYS);
        assert.equal(RC.classifyVariant(undefined, '/a?x=1'), C.ALWAYS);
        assert.equal(RC.classifyVariant(undefined, '/a#x'), C.ALWAYS);
        assert.equal(RC.classifyVariant(undefined, '/a/'), C.SKIP);
        assert.equal(RC.classifyVariant(undefined, '/'), C.SKIP);
        assert.equal(RC.classifyVariant(undefined, '/a//b'), C.SKIP);
        assert.equal(RC.classifyVariant('not-an-object', '/a'), C.ALWAYS, 'a string has own properties that would count');
        assert.equal(RC.countUnboundRequirements({ q: undefined, r: RE_ALPHA }, ['', 'a']), 1, 'an undefined requirement does not count');
        assert.equal(RC.countUnboundRequirements(Object.create({ q: RE_ALPHA }), ['', 'a']), 0, 'an inherited requirement does not count');
    });

    it('01.4  a rule is `always` when any of its variants is, and a non-string url is `always`', function () {
        var index = RC.build({
            'mixed@b': rule('/a,/b ', 'GET'),
            'num@b'  : { url: 42, method: 'GET', param: { control: 'act' }, bundle: B, scopes: [SCOPE] }
        }, B);
        assert.deepEqual(index.always.sort(), ['mixed@b', 'num@b']);
        assert.deepEqual(Array.from(RC.lookup(index, '/zzz', '/zzz')).sort(), ['mixed@b', 'num@b']);
    });

    it('01.5  the paths the index does not model return null (scan every rule)', function () {
        var index = RC.build(CATALOG, B);
        ['/', '/app/', '//app', '/app//a', '/app/qq?x=1', '/a#b', 'app/rel', ''].forEach(function (p) {
            assert.equal(RC.lookup(index, p, p), null, JSON.stringify(p) + ' must fall back to the full scan');
        });
        assert.equal(RC.lookup(index, '/app', undefined), null, 'a non-string decoded path');
        assert.ok(RC.lookup(index, '/app/a', '/app/a') instanceof Set, 'control: a modelled path returns a Set');
    });

    it('01.6  the raw-url lookup: a comma-bearing pathname equal to a comma url, and a url holding an escape', function () {
        var index = RC.build(CATALOG, B);
        assert.ok(RC.lookup(index, '/app/help,/app/aide', '/app/help,/app/aide').has('comma@b'));
        assert.ok(RC.lookup(index, '/app/a%20b', safeDecodeURI('/app/a%20b')).has('encoded@b'),
            'the raw pathname equals the raw url although the decoded one does not');
        assert.equal(RC.lookup(index, '/app/a%20c', safeDecodeURI('/app/a%20c')).has('encoded@b'), false, 'control');
    });

    it('01.7  other bundles and non-object entries are left out; the index is cached per table and rebuilt for a new one', function () {
        var t1 = { 'x@b': rule('/a'), 'y@other': rule('/a', 'GET', null, { bundle: 'other' }), 'junk': 'not a rule', 'nul': null };
        var s1 = RC.candidatesFor(t1, B, '/a', '/a');
        assert.deepEqual(Array.from(s1), ['x@b']);
        var s2 = RC.candidatesFor(t1, 'other', '/a', '/a');
        assert.deepEqual(Array.from(s2), ['y@other'], 'the same table, another bundle');
        var t2 = { 'z@b': rule('/a') };
        assert.deepEqual(Array.from(RC.candidatesFor(t2, B, '/a', '/a')), ['z@b'], 'a new table object is indexed anew');
        assert.equal(RC.candidatesFor(null, B, '/a', '/a'), null);
        assert.equal(RC.candidatesFor('nope', B, '/a', '/a'), null);
    });

    it('01.8  an index that cannot be built falls back to the full scan instead of throwing', function () {
        var hostile = {};
        Object.defineProperty(hostile, 'boom@b', { enumerable: true, get: function () { throw new Error('getter'); } });
        assert.equal(RC.candidatesFor(hostile, B, '/a', '/a'), null);
    });
});


// ─── 02 — the differential proof ───────────────────────────────────────────────

describe('02 - #P46 S6 A: the filtered scan answers exactly as the full scan', function () {

    it('02.1  the catalogue table: every arm, same winner / status / follow-up status', async function () {
        var arms = armsFor(CATALOG);
        var r = await differential(CATALOG, arms, RC.candidatesFor);
        assert.equal(r.divergences.length, 0, r.divergences.length + ' divergence(s) of ' + r.arms + ', first: ' + JSON.stringify(r.divergences.slice(0, 3)));
        assert.ok(r.arms > 5000, 'the corpus is not trivially small: ' + r.arms);
        assert.ok(r.indexed > r.arms / 2, 'most arms go through the index: ' + r.indexed + '/' + r.arms);
        assert.ok(r.evalFiltered < r.evalFull * 0.75, 'the filter is live: ' + r.evalFiltered + ' vs ' + r.evalFull + ' rules evaluated');
        if (process.env.GINA_S6A_STATS) console.log('[02.1 stats]', JSON.stringify({ arms: r.arms, indexed: r.indexed, empty: r.empty, evalFull: r.evalFull, evalFiltered: r.evalFiltered, bagDiffs: r.bagDiffs }));
    });

    it('02.5  the 404 fast path: without `always` rules, an unmatched path meets an EMPTY set and answers as the full scan does', async function () {
        var index = RC.build(CATALOG, B), trimmed = {};
        Object.keys(CATALOG).forEach(function (name) { if (index.always.indexOf(name) < 0) trimmed[name] = CATALOG[name]; });
        assert.ok(Object.keys(trimmed).length < Object.keys(CATALOG).length, 'control: the catalogue does hold always rules');
        var r = await differential(trimmed, armsFor(trimmed), RC.candidatesFor);
        assert.equal(r.divergences.length, 0, r.divergences.length + ' divergence(s) of ' + r.arms + ', first: ' + JSON.stringify(r.divergences.slice(0, 3)));
        assert.ok(r.empty > 100, 'many arms are answered from an EMPTY candidate set: ' + r.empty);
        if (process.env.GINA_S6A_STATS) console.log('[02.5 stats]', JSON.stringify({ arms: r.arms, indexed: r.indexed, empty: r.empty, evalFull: r.evalFull, evalFiltered: r.evalFiltered, bagDiffs: r.bagDiffs }));
    });

    it('02.2  seeded generated tables: every arm, same winner / status / follow-up status', async function () {
        var seeds = [11, 23, 37, 41, 59, 73];
        for (var i = 0; i < seeds.length; i++) {
            var table = generatedTable(seeds[i], 24);
            var arms  = armsFor(table);
            var r     = await differential(table, arms, RC.candidatesFor);
            assert.equal(r.divergences.length, 0, 'seed ' + seeds[i] + ': ' + r.divergences.length + ' divergence(s) of ' + r.arms + ', first: ' + JSON.stringify(r.divergences.slice(0, 3)));
            assert.ok(r.evalFiltered < r.evalFull, 'seed ' + seeds[i] + ': the filter is live');
        }
    });

    it('02.3  a table holding a url the loop cannot compare still answers 500 at that rule', async function () {
        var table = {
            'a@b'  : rule('/app/a'),
            'bad@b': { url: 42, method: 'GET', param: { control: 'act' }, bundle: B, scopes: [SCOPE], middleware: [] },
            'c@b'  : rule('/app/c')
        };
        var arms = [{ method: 'GET', url: '/app/c', bag: null }, { method: 'GET', url: '/app/a', bag: null }, { method: 'GET', url: '/app/zzz', bag: null }];
        var r = await differential(table, arms, RC.candidatesFor);
        assert.equal(r.divergences.length, 0, JSON.stringify(r.divergences));
        var c = await dispatch(table, B, arms[0], RC.candidatesFor);
        assert.deepEqual([c.status, c.rule], [500, 'bad@b'], 'control: /app/c meets the bad rule first and answers 500, as today');
    });

    it('02.4  the harness can fail: an index that drops parameter matches diverges', async function () {
        var staticOnly = function (table, bundle, raw) {
            var s = RC.candidatesFor(table, bundle, raw, safeDecodeURI(raw));
            if (s === null) return null;
            var out = new Set();
            s.forEach(function (name) { if (table[name] && table[name].url === raw) out.add(name); });
            return out;
        };
        var r = await differential(CATALOG, armsFor(CATALOG), staticOnly);
        assert.ok(r.divergences.length > 0, 'a filter that drops candidates must be caught: ' + r.divergences.length);
    });
});


// ─── 03 — source pins ──────────────────────────────────────────────────────────

/**
 * The source with its comments removed: full-line `//` comments and `/* … *\/` blocks.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

describe('03 - #P46 S6 A: server.js wires the index', function () {
    var src  = fs.readFileSync(SERVER_SRC, 'utf8');
    var live = stripComments(src);
    var start = live.indexOf('var _handleDispatch = async function(');
    var loop  = live.indexOf('for (let name in routing)', start);
    var region = live.slice(start, loop);

    it('03.1  the module is required once, at module scope', function () {
        var hits = live.match(/var\s+routeCandidates\s*=\s*require\(\s*'\.\/server\.route-candidates'\s*\)/g) || [];
        assert.equal(hits.length, 1);
    });

    it('03.2  _handleDispatch takes its candidates from the index, over the decoded path, before the loop', function () {
        assert.ok(start > -1 && loop > start, 'anchors');
        assert.match(region, /_trieCandidateSet\s*=\s*routeCandidates\.candidatesFor\(\s*routing\s*,\s*bundle\s*,\s*pathname\s*,\s*safeDecodeURI\(pathname\)\s*\)/);
    });

    it('03.3  the dead trie lookup is gone from the live code', function () {
        assert.equal(live.indexOf('routingLib.lookupTrie('), -1);
    });

    it('03.4  the loop still filters on the set, before the scope check', function () {
        var body = live.slice(loop, loop + 1200);
        var f = body.indexOf('if ( _trieCandidateSet !== null && !_trieCandidateSet.has(name) ) continue;');
        var s = body.indexOf('routing[name].scopes.indexOf(process.env.NODE_SCOPE)');
        assert.ok(f > -1 && s > f, 'filter at ' + f + ', scope check at ' + s);
    });
});
