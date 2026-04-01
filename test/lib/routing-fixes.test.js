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
 *  03 — lib/routing/src/main.js source: multi-param no-requirements guard (slow path)
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('path');
var path   = require('path');

var FW          = require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');

var src = require('fs').readFileSync(ROUTING_SRC, 'utf8');


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

    it('slow path: guard for undefined requirements returns false immediately', function() {
        // Multi-param slow path: if no requirements defined, return false
        assert.ok(
            /if \( typeof\(params\.requirements\)\s*==\s*['"]undefined['"]\s*\) return false/.test(src),
            'slow path must return false immediately when params.requirements is undefined'
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


// ─── 03 — source structure: slow path no-requirements guard ────────────────────

describe('03 - fitsWithRequirements: slow path (multi-param no-requirements guard)', function() {

    it('slow path guard appears after the fast path block (correct position)', function() {
        var fastPathEnd = src.indexOf('} else { // slow one');
        var slowGuard   = src.indexOf("if ( typeof(params.requirements) == 'undefined' ) return false");
        assert.ok(fastPathEnd >= 0, 'slow path branch not found');
        assert.ok(slowGuard >= 0,   'slow path guard not found');
        assert.ok(slowGuard > fastPathEnd, 'slow path guard must be inside the else { // slow one } block');
    });
});
