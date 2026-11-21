'use strict';
/**
 * Routing bug-fix regression tests
 *
 * Strategy: source inspection + inline logic replicas.
 * No live HTTP server, no framework bootstrap, no project required.
 *
 * Suites:
 *  01 — lib/routing/src/main.js source: fitsWithRequirements no-requirements guard
 *  02 — inline logic: fitsWithRequirements param binding and req.params population
 *  03 — lib/routing/src/main.js source: the slow path's old no-requirements guard is no longer live (#B692)
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('path');
var path   = require('path');

var FW          = require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');

var src = require('fs').readFileSync(ROUTING_SRC, 'utf8');

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

// Since #B692 the slow path's old body survives as a block of `//` comments, which a pin on `src`
// would still match: the slow-path pins read `live`.
var live = stripComments(src);


// ─── 01 — source structure: fitsWithRequirements no-requirements guard ─────────

describe('01 - fitsWithRequirements: source structure (no-requirements guard)', function() {

    it('fast path: guard for undefined requirements exists in fitsWithRequirements', function() {
        // The fix added an early-return block when params.requirements is undefined
        // or params.requirements[key] is undefined
        assert.ok(
            /typeof\(params\.requirements\)\s*==\s*['"]undefined['"]/.test(src) &&
            /typeof\(params\.requirements\[key\]\)\s*==\s*['"]undefined['"]/.test(src),
            'fitsWithRequirements must guard against undefined params.requirements and params.requirements[key]'
        );
    });

    it('fast path: no-requirements guard checks params.param[key] exists before binding', function() {
        // The guard must check params.param[key] is defined before populating req.params
        assert.ok(
            /typeof\(params\.param\[key\]\)\s*!=\s*['"]undefined['"]/.test(src),
            'no-requirements guard must check params.param[key] != undefined before binding'
        );
    });

    it('fast path: no-requirements guard populates request.params[key]', function() {
        assert.ok(
            /request\.params\[key\]\s*=\s*urlVal/.test(src),
            'no-requirements guard must set request.params[key] = urlVal'
        );
    });

    it('fast path: no-requirements guard populates request[requestMethod][key]', function() {
        assert.ok(
            /request\[requestMethod\]\[key\]\s*=\s*urlVal/.test(src),
            'no-requirements guard must set request[requestMethod][key] = urlVal'
        );
    });

    it('slow path: a segment holding two or more placeholders returns false, as its first live statement (#B692)', function() {
        // Multi-param slow path: since #B692 it returns false before anything else; its old
        // requirements guard and body remain only as comments (routing-multi-placeholder-b692.test.js
        // drives the behaviour)
        assert.ok(
            /\} else \{ \/\/ slow one\s*return false;/.test(live),
            'the slow path must return false as its first live statement'
        );
    });
});


// ─── 02 — inline logic: fitsWithRequirements param binding ────────────────────

describe('02 - fitsWithRequirements: inline logic (param binding and req.params)', function() {

    /**
     * Minimal replica of the fitsWithRequirements fast-path fix.
     * Covers the case where requirements is undefined or the specific key is absent.
     */
    function fitsWithRequirements_fastPath(urlVar, urlVal, params, request) {
        var _param = urlVar.match(/:\w+/g);
        if (!_param || !_param.length) return false;

        var matched = (_param.indexOf(urlVar) > -1) ? _param.indexOf(urlVar) : 0;
        if (matched === false) return false;

        var requestMethod = 'get';
        if (typeof(request[requestMethod]) === 'undefined') {
            request[requestMethod] = {};
        }

        var key = _param[matched].substring(1);

        // ── the fix ──
        if (typeof(params.requirements) === 'undefined' || typeof(params.requirements[key]) === 'undefined') {
            if (typeof(params.param[key]) !== 'undefined' && typeof(request.params) !== 'undefined' && urlVal) {
                request.params[key] = urlVal;
                if (typeof(request[requestMethod][key]) === 'undefined') {
                    request[requestMethod][key] = urlVal;
                }
                return true;
            }
            return false;
        }

        // requirements defined — test regex
        var tested = new RegExp(params.requirements[key]).test(urlVal);
        if (typeof(params.param[key]) !== 'undefined' && typeof(request.params) !== 'undefined' && tested) {
            request.params[key] = urlVal;
            if (typeof(request[requestMethod][key]) === 'undefined') {
                request[requestMethod][key] = urlVal;
            }
            return true;
        }
        return false;
    }

    it('returns true and populates req.params when no requirements and param[key] declared', function() {
        var req = { method: 'GET', params: {}, get: {} };
        var params = { param: { control: 'getById', id: ':id' }, requirements: undefined };
        var result = fitsWithRequirements_fastPath(':id', '42', params, req);
        assert.ok(result, 'should return true');
        assert.equal(req.params.id, '42');
        assert.equal(req.get.id, '42');
    });

    it('returns false when no requirements and param[key] NOT declared', function() {
        // The link-shortener bug: requirements defined but "slug" NOT in param
        var req = { method: 'GET', params: {}, get: {} };
        var params = { param: { control: 'stats' }, requirements: undefined };
        var result = fitsWithRequirements_fastPath(':slug', 'abc123', params, req);
        assert.ok(!result, 'should return false when param key is missing');
        assert.strictEqual(req.params.slug, undefined);
    });

    it('returns true when requirements defined, regex matches, and param[key] declared', function() {
        var req = { method: 'GET', params: {}, get: {} };
        var params = {
            param: { control: 'stats', slug: ':slug' },
            requirements: { slug: '^[A-Za-z0-9]{6}$' }
        };
        var result = fitsWithRequirements_fastPath(':slug', 'Abc123', params, req);
        assert.ok(result, 'valid slug should match');
        assert.equal(req.params.slug, 'Abc123');
        assert.equal(req.get.slug, 'Abc123');
    });

    it('returns false when requirements defined, regex does NOT match (even if param[key] declared)', function() {
        var req = { method: 'GET', params: {}, get: {} };
        var params = {
            param: { control: 'stats', slug: ':slug' },
            requirements: { slug: '^[A-Za-z0-9]{6}$' }
        };
        var result = fitsWithRequirements_fastPath(':slug', 'too-long-slug', params, req);
        assert.ok(!result, 'invalid slug should not match');
        assert.strictEqual(req.params.slug, undefined);
    });

    it('returns false when requirements defined for key but param[key] NOT declared', function() {
        // requirements alone is NOT enough — param binding must also be present
        var req = { method: 'GET', params: {}, get: {} };
        var params = {
            param: { control: 'stats' },   // no slug binding
            requirements: { slug: '^[A-Za-z0-9]{6}$' }
        };
        var result = fitsWithRequirements_fastPath(':slug', 'Abc123', params, req);
        assert.ok(!result, 'requirements alone without param binding must return false');
    });

    it('returns false when urlVal is empty string even with param[key] declared', function() {
        var req = { method: 'GET', params: {}, get: {} };
        var params = { param: { control: 'get', id: ':id' }, requirements: undefined };
        var result = fitsWithRequirements_fastPath(':id', '', params, req);
        assert.ok(!result, 'empty urlVal must return false');
    });

    it('does not overwrite an already-set req[method][key]', function() {
        var req = { method: 'GET', params: {}, get: { id: 'already-set' } };
        var params = { param: { control: 'get', id: ':id' }, requirements: undefined };
        fitsWithRequirements_fastPath(':id', 'new-value', params, req);
        assert.equal(req.get.id, 'already-set', 'existing req[method][key] must not be overwritten');
    });
});


// ─── 03 — source structure: the slow path's old no-requirements guard (#B692) ────

describe('03 - fitsWithRequirements: slow path (the old no-requirements guard is no longer live, #B692)', function() {

    it('control: the strip removes a full-line comment and keeps live code (the instrument)', function() {
        var probe = stripComments('    // if ( a ) return false;\n    b();\n');
        assert.equal(probe.indexOf('if ( a )'), -1, 'the strip must remove a full-line comment');
        assert.ok(probe.indexOf('b();') > -1, 'the strip must keep live code');
        assert.ok(live.indexOf('} else { // slow one') > -1, 'the strip must keep the slow path\'s head');
    });

    it('the old guard is not live code', function() {
        assert.equal(live.indexOf("if ( typeof(params.requirements) == 'undefined' ) return false"), -1,
            'the slow path\'s old no-requirements guard must not be live (#B692 returns false first)');
    });
});


// ─── 04 — #B52-residual finding-2: getRouteByUrl clones param + propagates substitution ───
//
// getRouteByUrl built `params.param` as a BY-REFERENCE alias of the shared config
// singleton (config.getRouting() returns content.routing by reference), while its
// sibling `middleware` was cloned. The matcher (fitsWithRequirements / checkRouteParams)
// then rewrites param.{path,namespace,file,title} IN PLACE for :placeholder routes, so
// it mutated the shared singleton — a cross-request (server) / cross-navigation (client)
// contamination. The fix is TWO coordinated edits: (1) clone param at the params build,
// (2) carry the per-request substituted param onto the returned `route` (getRouteByUrl
// returns a fresh clone of the singleton, NOT the mutated `params`).

describe('04 - getRouteByUrl: param is cloned + substitution propagated (no singleton pollution)', function() {

    it('source: params.param is JSON.clone(routing[name].param), not a bare alias', function() {
        assert.ok(
            /param\s*:\s*JSON\.clone\(routing\[name\]\.param\)/.test(src),
            'getRouteByUrl must clone routing[name].param (mirrors the middleware clone / server.js)'
        );
    });

    it('source: the substituted param is propagated onto the returned route (route.param = params.param)', function() {
        var cloneIdx = src.indexOf('route = JSON.clone(routing[name])');
        var propIdx  = src.indexOf('route.param = params.param');
        assert.ok(cloneIdx >= 0, 'route = JSON.clone(routing[name]) not found');
        assert.ok(propIdx  >= 0, 'route.param = params.param propagation not found');
        assert.ok(propIdx > cloneIdx, 'route.param = params.param must come AFTER route = JSON.clone(routing[name])');
    });

    // ── pure-logic replica of getRouteByUrl's match + return shape ────────────────
    // `cloneParam` models edit (1); `propagate` models edit (2). The in-place
    // substitution is guarded by /:/ exactly like the real fitsWithRequirements /
    // checkRouteParams — that guard is what makes a polluted singleton go stale.
    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    function freshSingleton() {
        return {
            widget: {
                bundle : 'demo',
                url    : '/widget/open/:id',
                param  : { id: ':id', file: 'includes/widget-:id', path: '/w/:id' }
            }
        };
    }

    function matchOnce(singleton, name, idVal, opts) {
        var params = {
            param: opts.cloneParam ? clone(singleton[name].param) : singleton[name].param
        };
        // in-place :placeholder rewrite, only when the placeholder is still present
        if (/:/.test(params.param.file)) params.param.file = params.param.file.replace(/:id/g, idVal);
        if (/:/.test(params.param.path)) params.param.path = params.param.path.replace(/:id/g, idVal);
        // getRouteByUrl returns a fresh clone of the singleton, NOT params
        var route = clone(singleton[name]);
        route.name = name;
        if (opts.propagate) route.param = params.param; // the 2nd edit
        return route;
    }

    it('FIXED (clone + propagate): isolated, correct, and the singleton stays clean across requests', function() {
        var s  = freshSingleton();
        var r1 = matchOnce(s, 'widget', '123', { cloneParam: true, propagate: true });
        assert.equal(r1.param.file, 'includes/widget-123', 'request 1 resolves its own id');
        assert.equal(s.widget.param.file, 'includes/widget-:id', 'singleton keeps its :placeholder (not polluted)');
        var r2 = matchOnce(s, 'widget', '456', { cloneParam: true, propagate: true });
        assert.equal(r2.param.file, 'includes/widget-456', 'request 2 resolves its OWN id, no stale value');
        assert.equal(r1.param.file, 'includes/widget-123', 'request 1 result is unaffected by request 2');
    });

    it('SUBTRACT (bare alias = the bug): singleton polluted -> request 2 inherits request 1 stale value', function() {
        var s  = freshSingleton();
        var r1 = matchOnce(s, 'widget', '123', { cloneParam: false, propagate: false });
        assert.equal(r1.param.file, 'includes/widget-123', 'request 1 still resolves (via in-place singleton mutation)');
        assert.equal(s.widget.param.file, 'includes/widget-123', 'the shared singleton is POLLUTED in place');
        var r2 = matchOnce(s, 'widget', '456', { cloneParam: false, propagate: false });
        assert.equal(r2.param.file, 'includes/widget-123', 'request 2 inherits request 1 STALE value — the contamination');
    });

    it('clone-only WITHOUT propagation regresses request 1 (proves the 2nd edit is load-bearing)', function() {
        var s  = freshSingleton();
        var r1 = matchOnce(s, 'widget', '123', { cloneParam: true, propagate: false });
        assert.equal(s.widget.param.file, 'includes/widget-:id', 'clone-only keeps the singleton clean...');
        assert.equal(r1.param.file, 'includes/widget-:id', '...but the returned route keeps the un-substituted :placeholder — broken');
    });
});


// ─── 05 — DELETE-branch requirement un-delimit: off-by-one over-strip ("Unterminated group") ───
//
// parseRouting()'s DELETE-only branch (gated `/^(delete)$/i.test(method)`) un-delimits each scanned
// route's `/…/<flags>` requirement to its bare body before `new RegExp(condition).test(uRe)`. The
// body extraction used `substring(1, condition.lastIndexOf('/') - 1)`, which over-stripped the FINAL
// body char: a requirement ending `…)/i` (group-close immediately before the flag) lost its closing
// `)` → unterminated group → `new RegExp` threw SyntaxError, 500ing EVERY DELETE dispatch that
// scanned such a route (independent of the DELETE's actual target route). A `…)$/i` requirement
// merely lost its `$` end-anchor (silently looser). Fix: end index is lastIndexOf('/') (exclusive).

describe('05 - DELETE-branch requirement un-delimit: off-by-one over-strip (Unterminated group)', function() {

    // Pure replicas of the un-delimit step (the body guarded by /^\//.test(condition)).
    function undelimit(condition)       { return condition.substring(1, condition.lastIndexOf('/')); }     // fixed
    function undelimit_buggy(condition) { return condition.substring(1, condition.lastIndexOf('/') - 1); } // pre-fix

    // The two real requirement shapes a consuming app declares in routing.json:
    var UNSAFE = '/(^null$|^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^[0-9A-Za-z]{6}$)/i'; // ends `)/i`
    var SAFE   = '/^(add|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-Za-z]{6})$/i';      // ends `)$/i`

    it('source: the off-by-one `substring(1, lastIndexOf(\'/\') - 1)` over-strip is gone', function() {
        assert.ok(
            !/substring\(\s*1\s*,\s*condition\.lastIndexOf\(['"]\/['"]\)\s*-\s*1\s*\)/.test(src),
            "the buggy `substring(1, condition.lastIndexOf('/')-1)` un-delimit must be removed"
        );
    });

    it('source: the DELETE branch un-delimits with lastIndexOf(\'/\') (exclusive end, no -1)', function() {
        assert.ok(
            /condition\s*=\s*condition\.substring\(\s*1\s*,\s*condition\.lastIndexOf\(['"]\/['"]\)\s*\)/.test(src),
            "un-delimit must be condition.substring(1, condition.lastIndexOf('/'))"
        );
    });

    it('FIXED: a `)/i` requirement no longer mangles into an unterminated group', function() {
        var body = undelimit(UNSAFE);
        assert.doesNotThrow(function() { new RegExp(body); }, 'fixed un-delimit must produce a valid regex');
        assert.ok(new RegExp(body).test('a1b2c3'), 'a valid 6-char id must match');
        assert.ok(new RegExp(body).test('null'),   'the `null` literal alternative must match');
        assert.ok(!new RegExp(body).test('!!'),     'an invalid value must not match');
    });

    it('FIXED: a `)$/i` requirement keeps its `$` end-anchor (no longer silently dropped)', function() {
        var body = undelimit(SAFE);
        assert.doesNotThrow(function() { new RegExp(body); });
        assert.ok(new RegExp(body).test('add'),          'a valid literal must match');
        assert.ok(new RegExp(body).test('a1b2c3'),       'a valid 6-char id must match');
        assert.ok(!new RegExp(body).test('a1b2c3EXTRA'), 'the `$` anchor must reject an overlong value');
    });

    it('SUBTRACT (pre-fix `-1`): the `)/i` requirement throws "Unterminated group"', function() {
        var body = undelimit_buggy(UNSAFE);
        assert.throws(function() { new RegExp(body); }, SyntaxError,
            'the old over-strip must throw SyntaxError on a `)/i` requirement');
    });

    it('SUBTRACT (pre-fix `-1`): the `)$/i` requirement survives but loses its `$` end-anchor', function() {
        var body = undelimit_buggy(SAFE);
        assert.doesNotThrow(function() { new RegExp(body); }, 'a `)$/i` requirement does not crash under the old code...');
        assert.ok(new RegExp(body).test('a1b2c3EXTRA'),
            '...but its `$` anchor was dropped, so an overlong value wrongly matched');
    });
});


// ─── 06 — DELETE-branch requirement un-delimit: regex flags preserved (DELETE/GET parity) ───
//
// The DELETE branch un-delimits a `/…/<flags>` requirement to its bare body before compiling it.
// §05 fixed the body extraction (off-by-one); this section locks the follow-up: the trailing
// `/<flags>` segment is now preserved and passed as `new RegExp(condition, conditionFlags)`,
// mirroring the GET path (fitsWithRequirements, which compiles `new RegExp(re, flags)`). Before
// this, a `/…/i` requirement matched case-INSENSITIVELY on GET but case-SENSITIVELY on DELETE
// (the flag was silently dropped) — a DELETE/GET inconsistency.

describe('06 - DELETE-branch requirement un-delimit: regex flags preserved (DELETE/GET parity)', function() {

    // Pure replicas of the un-delimit step: body (between delimiters) + flags (after the closing /).
    function bodyOf(c)  { return c.substring(1, c.lastIndexOf('/')); }
    function flagsOf(c) { return c.substring(c.lastIndexOf('/') + 1); }

    var CI      = '/^foo$/i';                          // a case-insensitive requirement
    var NOFLAG  = '/^bar$/';                           // a flagless requirement (back-compat)
    var UNSAFE  = '/(^null$|^[0-9A-Za-z]{6}$)/i';      // the real `)/i` shape from §05, but with its flag exercised

    it('source: the DELETE branch extracts the trailing flags (substring after the closing /)', function() {
        assert.ok(
            /conditionFlags\s*=\s*condition\.substring\(\s*condition\.lastIndexOf\(['"]\/['"]\)\s*\+\s*1\s*\)/.test(src),
            "the DELETE branch must extract flags via condition.substring(condition.lastIndexOf('/') + 1)"
        );
    });

    it('source: the DELETE branch compiles with the preserved flags (new RegExp(condition, conditionFlags))', function() {
        assert.ok(
            /new RegExp\(\s*condition\s*,\s*conditionFlags\s*\)/.test(src),
            'the DELETE requirement must be compiled as new RegExp(condition, conditionFlags)'
        );
    });

    it('FIXED: a `/…/i` requirement preserves its `i` flag and matches case-insensitively', function() {
        var body = bodyOf(CI), flags = flagsOf(CI);
        assert.equal(body, '^foo$');
        assert.equal(flags, 'i');
        assert.ok(new RegExp(body, flags).test('FOO'), 'the i flag must make FOO match ^foo$');
        assert.ok(new RegExp(body, flags).test('foo'), 'and the exact-case value still matches');
    });

    it('SUBTRACT (flag dropped = old DELETE behaviour): `/…/i` matched case-sensitively', function() {
        var body = bodyOf(CI); // compiled WITHOUT flags, as the DELETE branch used to
        assert.ok(!new RegExp(body).test('FOO'), 'without the i flag, FOO must NOT match ^foo$ (the old bug)');
        assert.ok(new RegExp(body).test('foo'),  'only the exact-case value matched');
    });

    it('back-compat: a flagless `/…/` requirement yields empty flags and still matches', function() {
        assert.equal(flagsOf(NOFLAG), '');
        assert.ok(new RegExp(bodyOf(NOFLAG), flagsOf(NOFLAG)).test('bar'));
        assert.ok(!new RegExp(bodyOf(NOFLAG), flagsOf(NOFLAG)).test('BAR'), 'no flag → still case-sensitive');
    });

    it('parity: the real `)/i` requirement compiles AND is case-insensitive (body + flags together)', function() {
        var body = bodyOf(UNSAFE), flags = flagsOf(UNSAFE);
        assert.equal(flags, 'i');
        assert.doesNotThrow(function() { new RegExp(body, flags); }, 'body+flags must be a valid regex');
        assert.ok(new RegExp(body, flags).test('A1B2C3'), 'a 6-char id matches case-insensitively (uppercase)');
        assert.ok(new RegExp(body, flags).test('NULL'),   'the `null` literal matches case-insensitively too');
    });
});


// ─── 07 — #B120: getRoute() must not throw on a requirements-less GET route with extra params ───
//
// getRoute(rule, params)'s "extra params" loop (the GET query-append: leftover keys not declared in
// the rule land on route.url as ?key=value) skipped requirements-declared keys by dereferencing
// route.requirements[p] WITHOUT guarding that `route.requirements` exists. A routing.json rule that
// declares no `requirements` block composes with requirements: undefined, so ANY extra param key
// threw `TypeError: Cannot read properties of undefined (reading '<key>')`. Reached from
// resumeRequest()'s `getRoute(rule, haltedRequest.params || dataAsParams)` — a halted GET route
// carrying data with no `requirements` block 500'd on every replay — and from any other
// getRoute(rule, extraParams) caller (the `url` template filter / getUrl() family). Fix: guard the
// deref, matching the null-guard discipline fitsWithRequirements already applies (§01/§03).
//
// Coverage: source pins + REAL-module behavioural drive (the harness seeds the context getRoute
// reads: getContext('gina').config + isProxyHost + process.gina) + an extracted-source subtract
// executing the SHIPPED loop bytes with the guard perturbed away + dist-fidelity pins (lib/routing
// is browser-bundled via build.json; both dist pins validated failing against the pre-fix artifacts).

// -- real-module harness (node:test runs each file in its own process, so the global
//    injection below cannot leak into other test files) --
var REPO = path.join(FW, '..', '..');
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));               // installs _, getPath, setContext/getContext, requireJSON …
require(path.join(REPO, 'utils', 'prototypes'));  // installs JSON.clone, count() …

var routingInstance = require(ROUTING_SRC);       // the module exports a ready instance

var B120_TABLE = {
    'noreq@testb':   { method: 'GET',  url: '/deep',   bundle: 'testb', param: { control: 'render', file: 'deep' } },   // NO requirements block
    'withreq@testb': { method: 'GET',  url: '/scoped', bundle: 'testb', param: { control: 'render', file: 'scoped' }, requirements: { ref: '/^\\w+$/' } },
    'postr@testb':   { method: 'POST', url: '/write',  bundle: 'testb', param: { control: 'render', file: 'write' } }    // NO requirements block either
};

process.gina = process.gina || {};                // gna.js normally creates this; getRoute reads process.gina.PROXY_HOSTNAME
setContext('isProxyHost', false);
setContext('gina', {
    config: {
        env     : 'dev',
        bundle  : 'testb',
        getRouting: function () { return B120_TABLE; },
        envConf : {}
    }
});

describe('07 - #B120 getRoute: requirements-less GET route + extra params (guarded deref)', function() {

    it('source: the requirements deref is guarded — ( route.requirements && typeof(route.requirements[p]) != \'undefined\' )', function() {
        assert.ok(
            src.indexOf("( route.requirements && typeof(route.requirements[p]) != 'undefined' )") > -1,
            'the extra-params loop must guard route.requirements before dereferencing it'
        );
    });

    it('source: the bare unguarded deref is gone (no `|| typeof(route.requirements[p])` left)', function() {
        assert.ok(
            !/\|\|\s*typeof\(route\.requirements\[p\]\)/.test(src),
            'the pre-fix unguarded `|| typeof(route.requirements[p])` form must be removed'
        );
    });

    it('FIXED (real module): a requirements-less GET route with extra params composes ?query instead of throwing', function() {
        var route = routingInstance.getRoute('noreq@testb', { ref: 'deep', tab: '2' });
        assert.equal(route.url, '/deep?ref=deep&tab=2', 'extra params must land as query parameters');
    });

    it('control (real module): a requirements-DECLARED key is still skipped from the query append', function() {
        var route = routingInstance.getRoute('withreq@testb', { ref: 'deep', tab: '2' });
        assert.equal(route.url, '/scoped?tab=2', 'ref is requirements-declared (a fold candidate) and must NOT ride the query; tab must');
    });

    it('gate (real module): empty params on a requirements-less route leave the url untouched', function() {
        var route = routingInstance.getRoute('noreq@testb', {});
        assert.equal(route.url, '/deep');
    });

    it('gate (real module): a non-GET route never enters the extra-params block', function() {
        var route = routingInstance.getRoute('postr@testb', { ref: 'deep' });
        assert.equal(route.url, '/write', 'the block is /GET/i-gated, so a POST route must not compose a query');
    });

    // -- extracted-source subtract: execute the SHIPPED loop bytes, then the same bytes with the
    //    guard perturbed back to the pre-fix shape (a replace that no-ops fails the control) --

    function extractExtraParamsBlock() {
        var startIdx = src.indexOf('// Completeting url with extra params');
        assert.ok(startIdx > -1, 'extraction control: start anchor not found');
        var endIdx = src.indexOf('// recommanded for x-bundle coms', startIdx);
        assert.ok(endIdx > startIdx, 'extraction control: end anchor not found after start');
        var block = src.substring(startIdx, endIdx);
        assert.ok(block.indexOf('for (let p in params)') > -1, 'extraction control: block must contain the extra-params loop');
        assert.ok(block.indexOf('toUrl') === -1, 'extraction control: block must not over-slice into toUrl');
        return block;
    }

    function runBlock(block, route, params) {
        var routing = { 'r@b': { url: route.url } };
        var fn = new Function('route', 'params', 'routing', 'rule', 'self', 'encodeRFC5987ValueChars',
            block + '\nreturn route;');
        return fn(route, params, routing, 'r@b',
            { reservedParams: ['controle', 'file', 'title', 'namespace', 'path'] },
            function (v) { return encodeURIComponent(v); });
    }

    it('extracted shipped block: appends extra params as query on a requirements-less route (no throw)', function() {
        var route = runBlock(extractExtraParamsBlock(),
            { method: 'GET', url: '/deep', param: { control: 'render', file: 'deep' } },
            { ref: 'deep', tab: '2' });
        assert.equal(route.url, '/deep?ref=deep&tab=2');
    });

    it('SUBTRACT (guard perturbed away = the pre-fix shape): the same bytes throw the #B120 TypeError', function() {
        var block     = extractExtraParamsBlock();
        var perturbed = block.replace(
            "( route.requirements && typeof(route.requirements[p]) != 'undefined' )",
            "typeof(route.requirements[p]) != 'undefined'"
        );
        assert.notEqual(perturbed, block, 'perturbation control: the replace must have changed the block');
        assert.throws(
            function () {
                runBlock(perturbed,
                    { method: 'GET', url: '/deep', param: { control: 'render', file: 'deep' } },
                    { ref: 'deep', tab: '2' });
            },
            function (err) {
                return err instanceof TypeError && /reading 'ref'/.test(err.message);
            },
            'the unguarded deref must throw the #B120 TypeError on a requirements-less route'
        );
    });

    // -- dist fidelity: lib/routing is browser-bundled (build.json alias) — the fix must reach
    //    both built artifacts. Pre-fix validation: gina.js guarded-form count 0 / unguarded 1;
    //    gina.min.js `.requirements&&` count 0 (so both pins were measured able to fail). --

    var DIST_JS  = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
    var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

    it('dist: gina.js carries the guarded form verbatim', function() {
        var dist = require('fs').readFileSync(DIST_JS, 'utf8');
        assert.ok(dist.indexOf("( route.requirements && typeof(route.requirements[p]) != 'undefined' )") > -1,
            'gina.js must contain the guarded deref (rebuild the bundle if this fails)');
    });

    it('dist: gina.min.js carries a minified guard shape (`.requirements&&`)', function() {
        var dist = require('fs').readFileSync(DIST_MIN, 'utf8');
        assert.ok(/\.requirements&&/.test(dist),
            'gina.min.js must contain the minified guard (rebuild the bundle if this fails)');
    });
});


// ─── 08 — #B121: getRouteByUrl awaits the async compareUrls (server-side match restored) ───
//
// `compareUrls` has been async since the `validator::` routing-requirement support (it can
// await validator rules), but `getRouteByUrl` called it WITHOUT await: `isRoute` was a
// Promise, `isRoute.past` always undefined, so no rule could EVER match server-side — the
// function returned its `false` sentinel for every url. Its only server callers are the
// relative-path redirect form's two resolution attempts, which therefore always failed;
// the `false` written onto `req.routing` then crashed the bundle downstream (the falsy-
// routing write in the response-header composer — pinned in its own server test file).
// Fix: `getRouteByUrl` is async, awaits `compareUrls` at both its call sites, and gains
// the engine loop's exact-url fast-path so the two matchers stay identical (the in-source
// N.B. above the loop demands it — the drift WAS this bug).
//
// Coverage: source pins (incl. a cross-file parity pin on the fast-path both matchers now
// share) + REAL-module behavioural drive (exact + :param match, bogus/method rejects) + a
// mechanism subtract proving the un-awaited shape structurally cannot observe a match +
// dist-fidelity pins (lib/routing is browser-bundled; negative arm validated failing
// against the pre-fix artifact).

// -- §08 fixtures ride the §07 harness: same live table (bundle-filtered, so the new
//    rules are invisible to §07's getRoute-by-name tests) + an envConf entry, which
//    getRouteByUrl's server branch reads (hostname strip + webroot) and getRoute did not.

B120_TABLE['landing@b121b'] = { method: 'GET', url: '/b121/landing',    bundle: 'b121b', param: { control: 'render', file: 'landing' }, requirements: {}, middleware: [] };
B120_TABLE['user@b121b']    = { method: 'GET', url: '/b121/users/:id', bundle: 'b121b', param: { control: 'render', file: 'user', id: ':id' }, requirements: { id: '/^\\d+$/' }, middleware: [] };
getContext('gina').config.envConf.b121b = { dev: { hostname: 'http://localhost:3121', server: { webroot: '/b121/' } } };

describe('08 - #B121 getRouteByUrl: awaited async compareUrls (server-side match restored)', function() {

    // active source = comments stripped, so the `// was:` replace-code convention
    // lines cannot trip the negative pins (the documented own-comment trap)
    var activeSrc = src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');

    it('source: getRouteByUrl is declared async', function() {
        assert.ok(
            src.indexOf('self.getRouteByUrl = async function (url, bundle, method, request, isOverridingMethod)') > -1,
            'getRouteByUrl must be an async function — it awaits the async compareUrls'
        );
    });

    it('source: the loop awaits compareUrls (the #B121 root-cause site)', function() {
        assert.ok(
            src.indexOf('isRoute = await self.compareUrls(params, routing[name].url, request);') > -1,
            'the match loop must await compareUrls'
        );
    });

    it('source: the not-found bookkeeping altRoute is awaited too', function() {
        assert.ok(
            /var altRoute = \(\s*await self\.compareUrls\(params, url, request\)\s*\)\s*\|\|\s*null;/.test(activeSrc),
            'the altRoute probe must await compareUrls (a truthy Promise defeated both the .past test and the || null fallback)'
        );
    });

    it('source (negative, comment-stripped): no un-awaited compareUrls assignment remains in active code', function() {
        assert.ok(
            activeSrc.indexOf('isRoute = self.compareUrls(') === -1
            && activeSrc.indexOf('altRoute = self.compareUrls(') === -1,
            'active code must not assign a bare (un-awaited) compareUrls call'
        );
    });

    it('parity pin: BOTH matchers carry the exact-url fast-path (`pathname == routing[name].url ||`)', function() {
        var FAST = /if\s*\(\s*pathname == routing\[name\]\.url \|\| isRoute\.past\s*\)/;
        assert.ok(FAST.test(src), 'lib/routing getRouteByUrl must carry the engine loop\'s exact-url fast-path');
        var serverSrc = require('fs').readFileSync(path.join(FW, 'core/server.js'), 'utf8');
        assert.ok(FAST.test(serverSrc), 'core/server.js must still carry the same fast-path — the two matchers are parity-locked');
    });

    // ── behavioural — the REAL module, awaited ────────────────────────────────
    it('FIXED (real module): an exact composed url resolves to its route', async function() {
        var route = await routingInstance.getRouteByUrl('/b121/landing', 'b121b', 'GET',
            { routing: {}, isXMLRequest: false, method: 'get', params: {}, url: '/b121/landing' });
        assert.ok(route && route !== true, 'a route object must come back (was the `false` sentinel for EVERY url pre-fix)');
        assert.equal(route.name, 'landing@b121b');
        assert.equal(route.param.file, 'landing');
    });

    it('FIXED (real module): a `:param` url resolves through the awaited matcher (no fast-path shortcut)', async function() {
        var route = await routingInstance.getRouteByUrl('/b121/users/42', 'b121b', 'GET',
            { routing: {}, isXMLRequest: false, method: 'get', params: {}, url: '/b121/users/42' });
        assert.ok(route, ':param routes must match — this is the arm the exact-url fast-path alone could not deliver');
        assert.equal(route.name, 'user@b121b');
    });

    it('control (real module): an unknown url still rejects with the `false` sentinel', async function() {
        var route = await routingInstance.getRouteByUrl('/b121/definitely-not-a-route', 'b121b', 'GET',
            { routing: {}, isXMLRequest: false, method: 'get', params: {}, url: '/b121/definitely-not-a-route' });
        assert.equal(route, false, 'the reject path must still fire — a matcher that cannot say no proves nothing');
    });

    it('control (real module): a method mismatch still rejects', async function() {
        var route = await routingInstance.getRouteByUrl('/b121/landing', 'b121b', 'POST',
            { routing: {}, isXMLRequest: false, method: 'post', params: {}, url: '/b121/landing' });
        assert.equal(route, false, 'landing@b121b is GET-only; a POST lookup must not match');
    });

    // ── mechanism subtract: WHY the pre-fix shape could never match ───────────
    it('SUBTRACT (mechanism): the un-awaited call yields a truthy thenable whose .past is undefined', function() {
        var unawaited = routingInstance.compareUrls(
            { method: 'GET', requirements: {}, url: '/b121/landing', rule: 'landing',
              param: { control: 'render', file: 'landing' }, middleware: [], bundle: 'b121b', isXMLRequest: false },
            '/b121/landing',
            { routing: {}, isXMLRequest: false, method: 'get', params: {}, url: '/b121/landing' });
        assert.equal(typeof unawaited.then, 'function', 'compareUrls is async — the bare call returns a thenable');
        assert.equal(unawaited.past, undefined, 'so `.past` reads undefined and the pre-fix `if (isRoute.past)` could NEVER be true');
        assert.ok(unawaited, 'and the thenable is truthy — which also defeated the altRoute `|| null` fallback');
        unawaited.then(function(){}, function(){}); // settle: keep the harness free of unhandled rejections
    });

    // ── dist fidelity (lib/routing is browser-bundled) ────────────────────────
    // Negative arm validated against the PRE-fix artifact: `getRouteByUrl = async`
    // counted 0 in the shipped gina.js before this fix's rebuild.
    it('dist: the unminified bundle carries the async declaration', function() {
        var DIST = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
        var dist = require('fs').readFileSync(DIST, 'utf8');
        assert.ok(dist.indexOf('self.getRouteByUrl = async function') > -1,
            'gina.js must ship the async getRouteByUrl (rebuild the bundle if this fails)');
    });

    it('dist: the minified bundle carries an async getRouteByUrl assignment', function() {
        var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
        var dist = require('fs').readFileSync(DIST_MIN, 'utf8');
        assert.ok(/getRouteByUrl\s*=\s*async function/.test(dist),
            'gina.min.js must ship the async getRouteByUrl (rebuild the bundle if this fails)');
    });
});

// ─── 09 — #B132: the getRoute not-found message names the bundle + its rule count ───
//
// A bundle whose routing config never loaded (hydration is readdir-driven, so an
// absent config/routing.json is simply never iterated) holds only the
// framework-synthetic routes; a cross-bundle getRoute then throws hours after
// boot with a message indistinguishable from a plain mistyped rule. The message
// now appends `(bundle \`<b>\` holds N rules)` so a degraded/near-empty table is
// tellable at the call site. The boot-time fail-fast half of #B132 lives in
// core/config.js (test/core/config-routing-failfast.test.js). Rides the §07
// real-module harness/table.

describe('09 - #B132 getRoute not-found names the bundle + table size', function() {

    it('source: the enriched literal is present and keeps the exact historical prefix', function() {
        assert.ok(
            src.indexOf("` not found ! (bundle `'+ bundle +'` holds '+ Object.keys(routing).length +' rules)") > -1,
            'the not-found throw must append the bundle + rule count'
        );
        assert.ok(
            src.indexOf("[ RoutingHelper::getRouting(rule, params) ] : `' +rule + '` not found !") > -1,
            'the historical message prefix must survive byte-identical'
        );
    });

    it('FIXED (real module): a missing rule reports the bundle and the live table size', function() {
        var expected = Object.keys(getContext('gina').config.getRouting()).length;
        assert.throws(function() {
            routingInstance.getRoute('nope@testb');
        }, function(e) {
            assert.equal(e.message.indexOf('[ RoutingHelper::getRouting(rule, params) ] : `nope@testb` not found !'), 0,
                'the historical prefix must lead the message');
            assert.ok(e.message.indexOf('(bundle `testb` holds ' + expected + ' rules)') > -1,
                'the message must carry the bundle + its live rule count');
            return true;
        });
    });

    it('control (real module): an existing rule still resolves — the throw is reached only on a miss', function() {
        var route = routingInstance.getRoute('noreq@testb');
        assert.equal(route.url, '/deep');
    });

    // ── dist fidelity (lib/routing is browser-bundled) ────────────────────────
    // Negative arm validated against the PRE-fix artifacts: the ` not found ! (bundle `
    // literal counted 0 in the shipped gina.js AND gina.min.js before this fix's rebuild.
    it('dist: the unminified bundle carries the enriched not-found literal', function() {
        var DIST = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
        var dist = require('fs').readFileSync(DIST, 'utf8');
        assert.ok(dist.indexOf(' not found ! (bundle ') > -1,
            'gina.js must ship the enriched not-found message (rebuild the bundle if this fails)');
    });

    it('dist: the minified bundle carries the enriched not-found literal', function() {
        var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
        var dist = require('fs').readFileSync(DIST_MIN, 'utf8');
        assert.ok(dist.indexOf(' not found ! (bundle ') > -1,
            'gina.min.js must ship the enriched not-found message (rebuild the bundle if this fails)');
    });
});


// ─── 10 — #B168: proxied-context degrade when no proxy hostname is resolvable ──
//
// getRoute()'s server branch resolves route.proxy_hostname from the worker global
// with an envConf fallback — and BOTH are framework-produced falsy states (the
// global is boot-set only from a proxy config carrying a hostname, otherwise first
// written by a proxied request; the envConf fallback is deliberately written null
// for a request classified direct). With the worker-wide proxied latch true and
// both unset, the unguarded `.replace` rewrite threw
// `TypeError: Cannot read properties of null (reading 'replace')` on EVERY
// server-side getRoute() while the state lasted. Fix: truthiness-guard the rewrite
// and degrade to the route's direct hostname — flipping route.isProxyHost too,
// because toUrl() keys on that flag and would otherwise stringify the unset value
// straight into the emitted URL. A once-per-process warning names the degraded
// state. The non-proxied worker-global branch is hardened the same way (its
// typeof gate admitted a defined-but-falsy value).
//
// Coverage: source pins + REAL-module behavioural drives (the §07 harness) + an
// extracted-source subtract per guarded branch + dist-fidelity pins (lib/routing
// is browser-bundled; the warn literal survives minification).

B120_TABLE['pxguard@testb'] = { method: 'GET', url: '/pxguard', bundle: 'testb', hostname: 'https://direct.internal:3999', webroot: '/', param: { control: 'render', file: 'pxguard' }, requirements: {}, middleware: [] };

describe('10 - #B168 getRoute: proxied-context degrade when no proxy hostname is resolvable', function() {

    // comment-stripped source, so negative pins can't trip on rationale text
    var activeSrc10 = src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');

    function resetProxyState() {
        setContext('isProxyHost', false);
        delete process.gina.PROXY_HOSTNAME;
        delete getContext('gina').config.envConf._proxyHostname;
    }

    // -- source pins --

    it('source: the proxied rewrite is truthiness-guarded (guard immediately gates the replace)', function() {
        assert.match(src, /if \(route\.proxy_hostname\) \{\s*\n\s*route\.proxy_host\s+= route\.proxy_hostname\.replace/,
            'the proxied-arm rewrite must sit behind a truthy route.proxy_hostname guard');
    });

    it('source: the degrade drops the unset key, flips the flag, and latches the warn', function() {
        var delIdx  = src.indexOf('delete route.proxy_hostname;');
        var flipIdx = src.indexOf('route.isProxyHost = false;');
        var warnIdx = src.indexOf('_proxyHostDegradeWarned = true;');
        assert.ok(delIdx > -1 && flipIdx > -1 && warnIdx > -1, 'all three degrade statements must exist');
        assert.ok(delIdx < flipIdx && flipIdx < warnIdx, 'degrade order: drop key, flip flag, latch warn');
        assert.ok(src.indexOf('var _proxyHostDegradeWarned = false;') > -1,
            'the warn latch must be a module-scope var (once per process)');
    });

    it('source: the non-proxied worker-global branch requires a truthy value (anchored to the gate close)', function() {
        assert.match(src, /typeof\(process\.gina\.PROXY_HOSTNAME\) != 'undefined'[\s\S]{0,400}?&& process\.gina\.PROXY_HOSTNAME\s*\n\s*\) \{/,
            'the else-if gate must add a truthy conjunct after the typeof check, closing the condition');
    });

    it('source: the old typeof-only gate shape is gone (comment-stripped)', function() {
        assert.doesNotMatch(activeSrc10, /typeof\(process\.gina\.PROXY_HOSTNAME\) != 'undefined'\s*\n\s*\) \{/,
            'no bare typeof-gated else-if may remain — typeof admits a defined-but-falsy value');
    });

    it('source: the client arm is unchanged', function() {
        assert.ok(src.indexOf("route.proxy_hostname  = window.location.protocol +'//'+ document.location.hostname;") > -1,
            'the browser arm must keep resolving from window.location (it cannot be unset)');
    });

    // -- behavioural (real module; §07 harness context) --
    // NOTE: this warn test MUST be the first degrade-triggering real-module test in
    // the file — the latch is once-per-process by design.

    it('FIXED (real module): the degrade warn fires ONCE across two degraded calls', function() {
        resetProxyState();
        setContext('isProxyHost', true);
        getContext('gina').config.envConf._proxyHostname = null;
        var warns = [];
        var origWarn = console.warn;
        console.warn = function (m) { warns.push(String(m)); };
        try {
            routingInstance.getRoute('pxguard@testb', {});
            routingInstance.getRoute('pxguard@testb', {});
        } finally {
            console.warn = origWarn;
            resetProxyState();
        }
        var mine = warns.filter(function (m) { return m.indexOf('no proxy hostname is resolvable') > -1; });
        assert.equal(mine.length, 1, 'the degrade warn must be latched once per process');
    });

    it('FIXED (real module): proxied latch + both sources unset returns a direct-host route', function() {
        resetProxyState();
        setContext('isProxyHost', true);
        getContext('gina').config.envConf._proxyHostname = null;   // the deliberately-written null
        try {
            var route = routingInstance.getRoute('pxguard@testb', {});
            assert.equal(route.isProxyHost, false, 'the degraded route must not claim a proxied host');
            assert.ok(!('proxy_hostname' in route), 'no unset proxy_hostname key may survive on the route');
            assert.equal(route.toUrl(), 'https://direct.internal:3999/pxguard',
                'toUrl() must emit the route direct hostname — no throw, no stringified unset value');
        } finally { resetProxyState(); }
    });

    it('FIXED (real module): an unwritten envConf fallback (undefined) degrades identically', function() {
        resetProxyState();
        setContext('isProxyHost', true);   // envConf._proxyHostname never written
        try {
            var route = routingInstance.getRoute('pxguard@testb', {});
            assert.equal(route.isProxyHost, false);
            assert.equal(route.toUrl(), 'https://direct.internal:3999/pxguard');
        } finally { resetProxyState(); }
    });

    it('control (real module): a truthy worker global keeps full proxied behaviour', function() {
        resetProxyState();
        setContext('isProxyHost', true);
        process.gina.PROXY_HOSTNAME = 'https://public.example';
        try {
            var route = routingInstance.getRoute('pxguard@testb', {});
            assert.equal(route.isProxyHost, true);
            assert.equal(route.proxy_hostname, 'https://public.example');
            assert.equal(route.proxy_host, 'public.example');
            assert.equal(route.toUrl(), 'https://public.example/pxguard');
        } finally { resetProxyState(); }
    });

    it('control (real module): the envConf fallback still resolves when the global is unset', function() {
        resetProxyState();
        setContext('isProxyHost', true);
        getContext('gina').config.envConf._proxyHostname = 'http://fallback.example';
        try {
            var route = routingInstance.getRoute('pxguard@testb', {});
            assert.equal(route.isProxyHost, true, 'a usable envConf fallback must keep the proxied behaviour');
            assert.equal(route.proxy_hostname, 'http://fallback.example');
            assert.equal(route.toUrl(), 'http://fallback.example/pxguard');
        } finally { resetProxyState(); }
    });

    it('FIXED (real module): a null worker global no longer crashes the non-proxied branch', function() {
        resetProxyState();
        process.gina.PROXY_HOSTNAME = null;   // typeof null == 'object' — passed the old gate
        try {
            var route = routingInstance.getRoute('pxguard@testb', {});
            assert.equal(route.isProxyHost, false);
            assert.ok(!('proxy_hostname' in route), 'a falsy global must not be stamped onto the route');
        } finally { resetProxyState(); }
    });

    it('control (real module): a truthy global still stamps the non-proxied route (unchanged secondary behaviour)', function() {
        resetProxyState();
        process.gina.PROXY_HOSTNAME = 'https://public.example';
        try {
            var route = routingInstance.getRoute('pxguard@testb', {});
            assert.equal(route.isProxyHost, false, 'the secondary branch never flips the flag');
            assert.equal(route.proxy_hostname, 'https://public.example');
            assert.equal(route.proxy_host, 'public.example');
        } finally { resetProxyState(); }
    });

    // -- extracted-source subtracts: execute the SHIPPED block bytes, then the same
    //    bytes with each guard perturbed back to the pre-fix reachability --

    function extractProxyBlock() {
        var startIdx = src.indexOf('route.isProxyHost = isProxyHost;');
        assert.ok(startIdx > -1, 'extraction control: start anchor not found');
        var endIdx = src.indexOf('if ( /\\,/.test(route.url) ) {', startIdx);
        assert.ok(endIdx > startIdx, 'extraction control: end anchor not found after start');
        var block = src.substring(startIdx, endIdx);
        assert.ok(block.indexOf('proxy_hostname') > -1, 'extraction control: block must contain the proxy resolution');
        // declaration form, not the bare word — the block's own rationale comment names toUrl()
        assert.ok(block.indexOf('route.toUrl = function') === -1, 'extraction control: block must not over-slice into the toUrl definition');
        return block;
    }

    function runProxyBlock(block, opts) {
        // #B502 added `_stProxy` (the request-store proxy slot) to the block's free
        // variables; null is the req-less caller shape these arms model, so the
        // fallback chain short-circuits to the worker global exactly as before.
        var fn = new Function('route', 'isProxyHost', 'isGFFCtx', 'config', 'process', 'console', '_proxyHostDegradeWarned', '_stProxy',
            block + '\nreturn route;');
        return fn(opts.route, opts.isProxyHost, false, opts.config,
            { gina: opts.gina }, { warn: function () {}, debug: function () {} }, false, opts.stProxy || null);
    }

    it('extracted shipped block: proxied latch + both sources unset degrades without throwing', function() {
        var route = runProxyBlock(extractProxyBlock(), {
            route: { url: '/pxguard' }, isProxyHost: true,
            config: { envConf: { _proxyHostname: null } }, gina: {}
        });
        assert.equal(route.isProxyHost, false);
        assert.ok(!('proxy_hostname' in route));
    });

    it('SUBTRACT (proxied guard perturbed to always-true = the pre-fix reachability): the block throws the production TypeError', function() {
        var block     = extractProxyBlock();
        var perturbed = block.replace('if (route.proxy_hostname) {', 'if (true) {');
        assert.notEqual(perturbed, block, 'perturbation control: the replace must have changed the block');
        assert.throws(
            function () {
                runProxyBlock(perturbed, {
                    route: { url: '/pxguard' }, isProxyHost: true,
                    config: { envConf: { _proxyHostname: null } }, gina: {}
                });
            },
            function (err) { return err instanceof TypeError && /reading 'replace'/.test(err.message); },
            'the unguarded rewrite must throw the production TypeError on a both-unset proxied call'
        );
    });

    it('SUBTRACT (truthy conjunct perturbed away = the pre-fix typeof-only gate): a null global throws in the block', function() {
        var block     = extractProxyBlock();
        var perturbed = block.replace('\n            && process.gina.PROXY_HOSTNAME\n', '\n');
        assert.notEqual(perturbed, block, 'perturbation control: the replace must have changed the block');
        assert.throws(
            function () {
                runProxyBlock(perturbed, {
                    route: { url: '/pxguard' }, isProxyHost: false,
                    config: { envConf: {} }, gina: { PROXY_HOSTNAME: null }
                });
            },
            function (err) { return err instanceof TypeError && /reading 'replace'/.test(err.message); },
            'the typeof-only gate must admit null and crash on the rewrite'
        );
    });

    // -- dist fidelity: lib/routing is browser-bundled — the degrade must reach both
    //    built artifacts (the warn string literal survives minification) --

    it('dist: gina.js carries the degrade warn literal', function() {
        var DIST_JS = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
        var dist = require('fs').readFileSync(DIST_JS, 'utf8');
        assert.ok(dist.indexOf('no proxy hostname is resolvable') > -1,
            'gina.js must contain the degrade warn (rebuild the bundle if this fails)');
    });

    it('dist: gina.min.js carries the degrade warn literal', function() {
        var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
        var dist = require('fs').readFileSync(DIST_MIN, 'utf8');
        assert.ok(dist.indexOf('no proxy hostname is resolvable') > -1,
            'gina.min.js must contain the degrade warn (rebuild the bundle if this fails)');
    });
});
