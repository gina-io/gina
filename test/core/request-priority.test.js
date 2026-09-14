'use strict';
/**
 * #H12 — RFC 9218 request priority on the request path, the outbound call and the response.
 *
 * What ships (design of record: todo/h12-design.md):
 *   - `req.priority` is parsed ONCE per request by lib/priority, at the top of BOTH
 *     engine tops — isaac's request listener AND server.js's onInstance — with a
 *     fill-when-absent guard. Parsing only in onInstance would have left the two
 *     engines asymmetric: isaac's statics, /_gina/* and render-cache hits answer
 *     inside the listener and never reach onInstance, while on Express all of those
 *     run INSIDE onInstance (brace-depth measured: onInstance spans the express
 *     handleStatics call and the Band-A /_gina gate).
 *   - `self.query()` resolves an outbound `Priority` header ONCE, before dispatch —
 *     one site for both transports, every retry and `self.forward()` — after
 *     extracting the non-HTTP `priority` OPTION ahead of the merge (the `critical`
 *     idiom: on HTTP/2 every stray `options` key ships as a header).
 *   - `self.setPriority(spec)` emits the response header, headersSent-guarded.
 *
 * Suites:
 *  01 — both tops carry the SAME guarded parse block (byte-identical, in sync)
 *  02 — placement: after the #FI timeline init, before the #OBS1 hook — and on isaac
 *       BEFORE the static serve, the first /_gina handler and the cb() handoff
 *  03 — the parse block, lifted and driven: parses, fills-when-absent, never throws
 *  04 — query(): option stripped before the merge, header resolved after gina's own
 *       injections and before dispatch, null-guarded on local.req, single write site
 *  05 — setPriority(): source pins
 *  06 — setPriority(): behavioural, on a real SuperController test instance
 *  07 — the type surface declares every new member
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var SERVER     = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var ISAAC      = fs.readFileSync(path.join(FW, 'core/server.isaac.js'), 'utf8');
var CONTROLLER = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
var TYPES      = fs.readFileSync(path.join(__dirname, '..', '..', 'types', 'index.d.ts'), 'utf8');
var priority   = require(path.join(FW, 'lib/priority/src/main.js'));

var BLOCK_START = '// #H12 — RFC 9218 request priority.';
var BLOCK_END   = "request.priority = lib.priority.parse(request.headers['priority']);\n            }\n";

/** The guarded parse block of one engine file, banner comment included. */
function parseBlock(src, label) {
    var s = src.indexOf(BLOCK_START);
    assert.ok(s > -1, label + ': parse block banner not found');
    var e = src.indexOf(BLOCK_END, s);
    assert.ok(e > s, label + ': parse block end not found');
    return src.slice(s, e + BLOCK_END.length);
}

function region(src, startNeedle, endNeedle, label) {
    var s = src.indexOf(startNeedle);
    assert.ok(s > -1, label + ': region start not found: ' + startNeedle);
    var e = src.indexOf(endNeedle, s);
    assert.ok(e > s, label + ': region end not found after start: ' + endNeedle);
    return { start: s, end: e, text: src.slice(s, e) };
}


// ─── 01 — both tops, in sync ──────────────────────────────────────────────────

describe('01 - both engine tops carry the SAME guarded parse block', function() {

    it('the block exists exactly once per file and is byte-identical across the two', function() {
        assert.equal(ISAAC.split(BLOCK_START).length - 1,  1, 'isaac: exactly one parse block');
        assert.equal(SERVER.split(BLOCK_START).length - 1, 1, 'server.js: exactly one parse block');
        assert.equal(parseBlock(ISAAC, 'isaac'), parseBlock(SERVER, 'server.js'), 'the two tops must stay in sync');
    });

    it('the parse is fill-when-absent guarded (the #B65 typeof shape) and reads the lower-cased header', function() {
        var re = /if \( typeof\(request\.priority\) == 'undefined' \) \{\s*\n\s*request\.priority = lib\.priority\.parse\(request\.headers\['priority'\]\);\s*\n\s*\}/;
        assert.match(parseBlock(ISAAC, 'isaac'),      re, 'isaac guard shape');
        assert.match(parseBlock(SERVER, 'server.js'), re, 'server.js guard shape');
    });

    it('nothing else in either engine file assigns request.priority', function() {
        [ { n: 'isaac', s: ISAAC }, { n: 'server.js', s: SERVER } ].forEach(function(e) {
            assert.equal((e.s.match(/request\.priority\s*=/g) || []).length, 1, e.n + ': exactly one assignment');
        });
    });
});


// ─── 02 — placement ───────────────────────────────────────────────────────────

describe('02 - placement: after the #FI init, before the #OBS1 hook, and ahead of every isaac fast path', function() {

    it('isaac: inside the request listener, after the #FI timeline init, before the #OBS1 metrics hook', function() {
        var listener = region(ISAAC, "server.on('request', (request, response) => {", '// #OBS1 slice 3 — HTTP request lifecycle hook for Prometheus metrics.', 'isaac');
        var blk = listener.text.indexOf(BLOCK_START);
        var fi  = listener.text.indexOf('request._devTimeline = { requestStart');
        assert.ok(blk > -1, 'the parse block sits in the listener head');
        assert.ok(fi > -1 && fi < blk, 'the #FI init precedes the parse block (same order as onInstance)');
    });

    it('isaac: the parse precedes the static serve, the first /_gina handler and the cb() handoff', function() {
        var start   = ISAAC.indexOf("server.on('request', (request, response) => {");
        var blk     = ISAAC.indexOf(BLOCK_START, start);
        var statics = ISAAC.indexOf('return response.end(localAsset.content);', start);
        var gina    = ISAAC.indexOf("'/_gina/", start);
        var cb      = ISAAC.indexOf('cb(request, response);', start);
        assert.ok(blk > start && statics > blk, 'parse before the static-asset serve');
        assert.ok(gina > blk,                    'parse before the first /_gina/* handler');
        assert.ok(cb > blk,                      'parse before the handoff to onInstance');
    });

    it('server.js: inside onInstance, after the #FI init, before the #OBS1 hook, before the express statics call', function() {
        var head = region(SERVER, 'function onInstance(request, response, next)', '// #OBS1 slice 3 — HTTP request lifecycle hook for Prometheus metrics.', 'server.js');
        var blk  = head.text.indexOf(BLOCK_START);
        var fi   = head.text.indexOf('request._devTimeline = { requestStart');
        assert.ok(blk > -1, 'the parse block sits in the onInstance head');
        assert.ok(fi > -1 && fi < blk, 'the #FI init precedes the parse block');
        var statics = SERVER.indexOf('handleStatics(', head.start);
        assert.ok(statics > head.start + blk, 'parse before the express statics call');
    });

    it('the onInstance-head pins of server.test.js keep their anchors (the block is OUTSIDE their slice)', function() {
        // server.test.js slices `function onInstance(…)` → '#FI — dev-mode request timeline'; the parse
        // block lands AFTER the #FI init, so that slice is unchanged by this feature.
        var s = SERVER.indexOf('function onInstance(request, response, next)');
        var e = SERVER.indexOf('#FI — dev-mode request timeline', s);
        assert.ok(e > s);
        assert.equal(SERVER.slice(s, e).indexOf(BLOCK_START), -1, 'the parse block must not enter the onInstance-head slice');
    });
});


// ─── 03 — the block, lifted and driven ───────────────────────────────────────

describe('03 - the parse block, lifted from the source and driven with the real lib/priority', function() {
    // The block closes over exactly two identifiers — `request` and `lib` — so a
    // lifted copy with both supplied models the engine scope faithfully.
    var block = parseBlock(SERVER, 'server.js');
    var run   = new Function('request', 'lib', block);
    var lib   = { priority: priority };

    it('parses a present header', function() {
        var req = { headers: { priority: 'u=1, i' } };
        run(req, lib);
        assert.deepEqual(req.priority, { urgency: 1, incremental: true, present: true });
    });

    it('an absent header yields the RFC defaults with present:false', function() {
        var req = { headers: {} };
        run(req, lib);
        assert.deepEqual(req.priority, { urgency: 3, incremental: false, present: false });
    });

    it('fills-when-absent: the isaac listener claims first, onInstance (the cb) must not re-parse', function() {
        var req = { headers: { priority: 'u=1' }, priority: { urgency: 0, incremental: true, present: true } };
        run(req, lib);
        assert.deepEqual(req.priority, { urgency: 0, incremental: true, present: true }, 'the earlier parse is kept');
    });

    it('a malformed header is ignored whole — and never throws', function() {
        var req = { headers: { priority: 'U=1,' } };
        assert.doesNotThrow(function() { run(req, lib); });
        assert.deepEqual(req.priority, { urgency: 3, incremental: false, present: false });
    });
});


// ─── 04 — query() ─────────────────────────────────────────────────────────────

describe('04 - query(): the option is stripped before the merge; the header is resolved once, before dispatch', function() {
    var q = region(CONTROLLER, 'this.query = function(', 'handleHTTP2ClientRequest(browser, options, callback, 0, isCritical)', 'query()');

    it('the priority OPTION is captured and deleted beside `critical`, BEFORE the merge/clone', function() {
        var strip = q.text.indexOf('var _prioOption = options.priority;');
        var del   = q.text.indexOf('delete options.priority;');
        var crit  = q.text.indexOf('delete options.critical;');
        var merge = q.text.indexOf('options = merge(JSON.clone(options), defaultOptions);');
        assert.ok(strip > -1 && del > strip, 'capture then delete');
        assert.ok(crit > -1 && crit < strip, 'sits right after the critical strip');
        assert.ok(merge > del, 'both precede the merge — a stray key would otherwise ship as a header on HTTP/2');
    });

    it('the header is resolved AFTER the x-forwarded-* injection and BEFORE the Inspector header and dispatch', function() {
        var resolve = q.text.indexOf('lib.priority.resolveOutbound({');
        var xfp     = q.text.indexOf("options.headers['x-forwarded-proto'] = process.gina.PROXY_SCHEME;");
        var insp    = q.text.indexOf("options.headers['x-gina-inspector'] = 'true';");
        assert.ok(resolve > -1, 'resolveOutbound is called');
        assert.ok(xfp > -1 && xfp < resolve, 'after the proxy-context forward');
        assert.ok(insp > resolve, 'before the Inspector header');
        // dispatch is the region's END anchor, so `resolve` inside the region IS before dispatch
    });

    it('the inbound value is null-guarded on local.req (a released response, #B31) and the option is the stripped one', function() {
        var call = region(q.text, 'lib.priority.resolveOutbound({', '});', 'resolve call').text;
        assert.ok(call.indexOf('inbound : ( local.req != null ) ? local.req.priority : null') > -1, 'null-guarded inbound');
        assert.ok(call.indexOf('option  : _prioOption') > -1, 'the stripped option feeds the chain');
        assert.ok(call.indexOf('headers : options.headers') > -1, 'the outbound header map is what the caller-wins rung reads');
    });

    it('exactly ONE site writes the outbound priority header, and it is conditional', function() {
        var writes = q.text.match(/options\.headers\['priority'\] = /g) || [];
        assert.equal(writes.length, 1, 'one write site');
        assert.ok(q.text.indexOf('if ( _prioHeader ) {') > -1, 'guarded on a resolved value');
    });

    it('the HTTP/2 header fold never has to denylist `priority` — it is deleted before the fold', function() {
        var fold = region(CONTROLLER, 'var _NON_HTTP_OPTS = new Set([', ']);', 'denylist').text;
        assert.equal(fold.indexOf("'priority'"), -1, 'not in _NON_HTTP_OPTS (the delete makes it unnecessary)');
    });
});


// ─── 05 — setPriority() pins ──────────────────────────────────────────────────

describe('05 - setPriority(): source pins', function() {
    var m = region(CONTROLLER, 'this.setPriority = function(spec) {', 'this.setEarlyHints = function(links) {', 'setPriority');

    it('serializes through lib/priority, guards a released or sent response, sets the lower-cased header, returns self', function() {
        assert.ok(m.text.indexOf('lib.priority.serialize(spec)') > -1, 'serialize via the lib');
        assert.ok(m.text.indexOf("if ( !_value ) return self;") > -1, 'nothing to say → no-op');
        assert.ok(m.text.indexOf('headersSent(_res)') > -1, 'headersSent guard (covers the #B31 released response)');
        assert.ok(m.text.indexOf("_res.setHeader('priority', _value);") > -1, 'the header write');
        assert.equal((m.text.match(/return self;/g) || []).length, 4, 'every exit returns self');
    });

    it('is declared before setEarlyHints, beside the other response-signalling methods', function() {
        assert.ok(CONTROLLER.indexOf('this.setPriority = function(spec) {') < CONTROLLER.indexOf('this.setEarlyHints = function(links) {'));
    });
});


// ─── 06 — setPriority() behavioural ───────────────────────────────────────────

describe('06 - setPriority(): behavioural, on a real SuperController test instance', function() {
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));
    setPath('gina', { core: path.join(FW, 'core') });
    var SuperController = require(path.join(FW, 'core/controller/controller.js'));

    function makeInstance(sent) {
        var headers = {};
        var res = {
            statusCode  : 200,
            headersSent : !!sent,
            _h          : headers,
            setHeader   : function(k, v) { headers[String(k).toLowerCase()] = v; },
            getHeader   : function(k)    { return headers[String(k).toLowerCase()]; },
            getHeaders  : function()     { return headers; }
        };
        var inst = SuperController.createTestInstance({
            req  : { method: 'GET', url: '/', headers: {}, routing: { param: {} } },
            res  : res,
            next : function() {}
        });
        return { inst: inst, res: res };
    }

    it('emits the normalized header and returns the instance for chaining', function() {
        var t = makeInstance(false);
        var r = t.inst.setPriority({ urgency: 6, incremental: true });
        assert.equal(t.res._h['priority'], 'u=6, i');
        assert.equal(r, t.inst, 'returns self');
    });

    it('an explicit default urgency IS emitted (only an explicit member overrides the client, RFC 9218 §8)', function() {
        var t = makeInstance(false);
        t.inst.setPriority({ urgency: 3 });
        assert.equal(t.res._h['priority'], 'u=3');
    });

    it('nothing to say → no header; an invalid urgency is dropped, not clamped', function() {
        var t = makeInstance(false);
        t.inst.setPriority({});
        t.inst.setPriority(undefined);
        t.inst.setPriority({ urgency: 9 });
        assert.equal(t.res._h['priority'], undefined);
    });

    it('headers already sent → no-op, still chainable', function() {
        var t = makeInstance(true);
        assert.equal(t.inst.setPriority({ urgency: 0 }), t.inst);
        assert.equal(t.res._h['priority'], undefined);
    });

    it('a later call overwrites (last explicit intent wins on the response)', function() {
        var t = makeInstance(false);
        t.inst.setPriority({ urgency: 1 }).setPriority({ urgency: 5, incremental: true });
        assert.equal(t.res._h['priority'], 'u=5, i');
    });
});


// ─── 07 — types ───────────────────────────────────────────────────────────────

describe('07 - the type surface declares every new member', function() {

    it('PriorityInfo, GinaRequest.priority, SuperController.setPriority, QueryOptions.priority, GinaLib.priority', function() {
        assert.ok(TYPES.indexOf('interface PriorityInfo {') > -1);
        assert.ok(TYPES.indexOf('priority?: PriorityInfo;') > -1, 'req.priority');
        assert.ok(TYPES.indexOf('setPriority(spec: { urgency?: number; incremental?: boolean }): this;') > -1, 'controller method');
        assert.ok(TYPES.indexOf('priority?: { urgency?: number; incremental?: boolean } | string | false;') > -1, 'query option');
        assert.ok(/^\s{8}priority: \{ parse\(/m.test(TYPES), 'GinaLib.priority at 8-space indent (the parity test reads members there)');
    });
});
