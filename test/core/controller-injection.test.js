/**
 * #R4 — SuperController.createTestInstance
 *
 * Verifies that the static factory method exists in the source and that its
 * pattern (per-instance closure isolation) behaves as documented.
 *
 * Why source inspection instead of requiring the module:
 *   controller.js calls `requireJSON(_(getPath('gina').core + '/status.codes'))`
 *   at module load time and uses `require('./../../lib')` which itself bootstraps
 *   swig, routing, session stores etc.  Loading the full controller in a pure
 *   unit-test context without a running gina server is not practical.
 *   These tests therefore cover:
 *     (a) source structure — the factory is present and well-formed
 *     (b) isolation contract — simulated with a minimal constructor clone that
 *         mirrors the actual init() + createTestInstance() logic
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var SOURCE_PATH = path.join(require('../fw'), 'core/controller/controller.js');
var src = fs.readFileSync(SOURCE_PATH, 'utf8');


// ─── (a) source structure ────────────────────────────────────────────────────

describe('SuperController.createTestInstance — source structure', function() {

    it('createTestInstance is defined as a static property on SuperController', function() {
        assert.ok(
            src.indexOf('SuperController.createTestInstance = function') > -1,
            'expected `SuperController.createTestInstance = function` in controller.js'
        );
    });

    it('_isTestInstance flag is set inside createTestInstance', function() {
        assert.ok(
            src.indexOf('inst._isTestInstance = true') > -1,
            'expected `inst._isTestInstance = true` inside createTestInstance'
        );
    });

    it('createTestInstance calls setOptions', function() {
        assert.ok(
            src.indexOf('inst.setOptions(') > -1,
            'expected `inst.setOptions(` call inside createTestInstance'
        );
    });

    it('createTestInstance is placed after inherits() and before module.exports', function() {
        var inheritsPos    = src.lastIndexOf('SuperController = inherits(');
        var factoryPos     = src.indexOf('SuperController.createTestInstance');
        var exportsPos     = src.lastIndexOf('module.exports = SuperController');

        assert.ok(inheritsPos > -1,  'inherits() call not found');
        assert.ok(factoryPos  > -1,  'createTestInstance not found');
        assert.ok(exportsPos  > -1,  'module.exports not found');

        assert.ok(
            inheritsPos < factoryPos && factoryPos < exportsPos,
            'createTestInstance must appear after inherits() and before module.exports'
        );
    });

    it('options normalisation guard is present (conf.content.routing)', function() {
        assert.ok(
            src.indexOf('_opts.conf.content.routing') > -1,
            'expected routing normalisation guard inside createTestInstance'
        );
    });

});


// ─── (b) isolation contract ──────────────────────────────────────────────────
//
// Minimal simulation of the SuperController singleton + createTestInstance
// pattern so we can verify the per-instance closure guarantee without
// loading the full controller module.

describe('SuperController.createTestInstance — isolation contract', function() {

    /**
     * Minimal clone of the SuperController pattern:
     *   - Each new call creates an independent `local` closure.
     *   - `init()` is called without `return` so `new` always returns `this`.
     *   - Static `SuperController.initialized` and `.instance` track the singleton.
     */
    function buildMiniController() {

        function MiniController(options) {
            var self  = this;
            var local = { options: options || null, req: null, res: null, next: null };

            var init = function() {
                if (typeof MiniController.initialized !== 'undefined') {
                    // existing instance path — returns old instance but caller gets `this`
                    return MiniController.instance;
                }
                MiniController.instance    = self;
                MiniController.initialized = true;
            };

            this.setOptions = function(req, res, next, opts) {
                local.req     = req;
                local.res     = res;
                local.next    = next;
                local.options = opts;
            };

            this.getLocal = function() { return local; };

            init();
        }

        MiniController.createTestInstance = function(deps) {
            deps  = deps || {};
            var inst = new MiniController(deps.options || {});
            inst._isTestInstance = true;
            inst.setOptions(
                deps.req   || {},
                deps.res   || {},
                deps.next  || function() {},
                deps.options || {}
            );
            return inst;
        };

        return MiniController;
    }


    it('each createTestInstance call returns a distinct object', function() {
        var SC = buildMiniController();
        var a = SC.createTestInstance({ req: { id: 1 } });
        var b = SC.createTestInstance({ req: { id: 2 } });
        assert.notStrictEqual(a, b);
    });

    it('_isTestInstance is true on every returned instance', function() {
        var SC = buildMiniController();
        var inst = SC.createTestInstance();
        assert.strictEqual(inst._isTestInstance, true);
    });

    it('each instance has its own independent local closure', function() {
        var SC = buildMiniController();
        var mockReqA = { id: 'A' };
        var mockReqB = { id: 'B' };

        var a = SC.createTestInstance({ req: mockReqA });
        var b = SC.createTestInstance({ req: mockReqB });

        assert.strictEqual(a.getLocal().req, mockReqA, 'a should hold its own req');
        assert.strictEqual(b.getLocal().req, mockReqB, 'b should hold its own req');
        assert.notStrictEqual(a.getLocal().req, b.getLocal().req);
    });

    it('production singleton is untouched after createTestInstance calls', function() {
        var SC = buildMiniController();

        // Prime the singleton with a "production" call
        var prod = new SC({ _prod: true });
        assert.strictEqual(SC.instance, prod, 'production singleton set');

        // Now call the test factory
        SC.createTestInstance();
        SC.createTestInstance();

        // Singleton must still be the original production instance
        assert.strictEqual(SC.instance, prod, 'singleton must be unchanged');
    });

    it('setOptions is called with the provided deps', function() {
        var SC = buildMiniController();
        var mockReq  = { method: 'GET' };
        var mockRes  = { statusCode: 200 };
        var mockNext = function next() {};
        var mockOpts = { rule: 'home' };

        var inst = SC.createTestInstance({
            req:     mockReq,
            res:     mockRes,
            next:    mockNext,
            options: mockOpts
        });

        var local = inst.getLocal();
        assert.strictEqual(local.req,     mockReq);
        assert.strictEqual(local.res,     mockRes);
        assert.strictEqual(local.next,    mockNext);
        assert.strictEqual(local.options, mockOpts);
    });

    it('works with no deps (all defaults applied without crash)', function() {
        var SC = buildMiniController();
        assert.doesNotThrow(function() {
            SC.createTestInstance();
        });
    });

});
