/**
 * #M2 — entity._arguments buffer management
 *
 * Verifies that entity._arguments[trigger] is cleared after consumption
 * in both the Promise path (Option B) and the DISPATCH:BUFFER_CALLBACK path (util.promisify
 * fast-path), so a buffered result from one call does not leak to the next.
 *
 * NODE_ENV_IS_DEV is set to 'false' before entity.js is loaded so that the
 * dev-mode per-call clear at the top of each method wrapper (which would mask
 * the DISPATCH:BUFFER_CALLBACK path) does not run during these tests.
 *
 * Bootstrap note — EntitySuper[name] = { initialized: true }
 * ─────────────────────────────────────────────────────────────
 * entity.js uses a two-pass setListeners design: the first new EntityClass()
 * call triggers setListeners, which calls getEntity(), which instantiates the
 * class a second time (second setListeners).  The second pass correctly wraps
 * methods and populates _triggers on the inner instance.  The first pass then
 * overwrites entity._triggers = [] on that same instance, clearing the array.
 *
 * By pre-setting EntitySuper[name] = { initialized: true } before the first
 * new EntityClass() call, setListeners skips getEntity() and uses entity = self
 * (the instance being constructed).  Methods are wrapped on the single instance
 * that new EntityClass() returns, and _triggers is populated correctly.
 * This is the correct setup for unit tests that target buffer management.
 *
 * new Function() cannot be used here because its toString() inserts a newline
 * inside the parameter list — breaking the /\((.*)\\)/g source-parse in entity.js:171.
 */

'use strict';

// Must be set BEFORE requiring entity.js — isCacheless is captured at module
// load time (entity.js:56).  Without this, isCacheless=true and the dev-mode
// delete at lines 186–188 fires on every call, preventing the buffer from
// being consumed via the DISPATCH:BUFFER_CALLBACK path.
process.env.NODE_ENV_IS_DEV = 'false';

var path    = require('path');
var { describe, it } = require('node:test');
var assert  = require('node:assert/strict');

// ─── bootstrap (mirrors entity-injection.test.js) ────────────────────────────

var GINA_FW = path.resolve(require('../fw'));

require(GINA_FW + '/helpers');

var ModelUtil   = require(GINA_FW + '/lib/model');
var mu          = new ModelUtil();
var ginaMain    = require.resolve(path.resolve(__dirname, '../../'));
var _inherits   = require(GINA_FW + '/lib/inherits/src/main.js');
var _merge      = require(GINA_FW + '/lib/merge/src/main.js');

if (!require.cache[ginaMain] || !require.cache[ginaMain].exports.lib) {
    require.cache[ginaMain] = {
        id       : ginaMain,
        filename : ginaMain,
        loaded   : true,
        exports  : {
            lib: {
                logger   : console,
                helpers  : {},
                inherits : _inherits,
                merge    : _merge,
                Model    : ModelUtil
            }
        }
    };
}

// Load entity.js fresh so it picks up NODE_ENV_IS_DEV='false' → isCacheless=false.
var entityPath = GINA_FW + '/core/model/entity.js';
delete require.cache[require.resolve(entityPath)];
var EntitySuper = require(entityPath);

// ─── entity classes ──────────────────────────────────────────────────────────
//
// Each class uses a unique prototype.name and bundle/model so tests do not
// share EntitySuper static state.
//
// IMPORTANT: the trigger string ('shortName#methodName') must appear as a
// literal in the method source so setListeners' regex detection fires.
// shortName = prototype.name.replace(/Entity/, '') with lowercase first char.
// e.g. name='M2PromisePath' → shortName='m2PromisePath' → trigger='m2PromisePath#findOne'
//
// IMPORTANT: EntitySuper[name] must be pre-set to { initialized: true } before
// constructing each entity so that setListeners wraps methods directly on the
// returned instance (see Bootstrap note in file header).
//
// new Function() cannot be used here because its toString() inserts a newline
// inside the parameter list — breaking the /\((.*)\\)/g source-parse in entity.js:171.

// ── Entity A — Promise path ──────────────────────────────────────────────────
// shortName: 'm2Promise', trigger: 'm2Promise#findOne'

function M2PromiseEntity() {}
M2PromiseEntity = _inherits(M2PromiseEntity, EntitySuper);
M2PromiseEntity.prototype.name     = 'M2Promise';
M2PromiseEntity.prototype.model    = 'model_m2_promise';
M2PromiseEntity.prototype.bundle   = 'bundle_m2_promise';
M2PromiseEntity.prototype.database = 'testdb';

// Trigger literal required for onEntityEvent detection.
// Does NOT emit — the Promise resolves from the pre-populated buffer.
M2PromiseEntity.prototype.findOne = function findOne(id) {
    var _t = 'm2Promise#findOne'; // trigger reference
};

mu.setConnection('bundle_m2_promise', 'model_m2_promise', null);
mu.setModelEntity('bundle_m2_promise', 'model_m2_promise', 'M2PromiseEntity', M2PromiseEntity);

// Pre-set so setListeners wraps on self directly, populating _triggers.
EntitySuper['M2Promise'] = { initialized: true };
var instA = new M2PromiseEntity(null, null);


// ── Entity B — DISPATCH:BUFFER_CALLBACK: buffer consumed and deleted ────────────────────────
// shortName: 'm2Firing2A', trigger: 'm2Firing2A#findOne'

function M2Firing2AEntity() {}
M2Firing2AEntity = _inherits(M2Firing2AEntity, EntitySuper);
M2Firing2AEntity.prototype.name     = 'M2Firing2A';
M2Firing2AEntity.prototype.model    = 'model_m2_f2a';
M2Firing2AEntity.prototype.bundle   = 'bundle_m2_f2a';
M2Firing2AEntity.prototype.database = 'testdb';

M2Firing2AEntity.prototype.findOne = function findOne(id) {
    var _t = 'm2Firing2A#findOne'; // trigger reference
};

mu.setConnection('bundle_m2_f2a', 'model_m2_f2a', null);
mu.setModelEntity('bundle_m2_f2a', 'model_m2_f2a', 'M2Firing2AEntity', M2Firing2AEntity);

EntitySuper['M2Firing2A'] = { initialized: true };
var instB = new M2Firing2AEntity(null, null);


// ── Entity C — DISPATCH:BUFFER_CALLBACK: subsequent call not poisoned ───────────────────────
// shortName: 'm2Firing2B', trigger: 'm2Firing2B#findOne'

function M2Firing2BEntity() {}
M2Firing2BEntity = _inherits(M2Firing2BEntity, EntitySuper);
M2Firing2BEntity.prototype.name     = 'M2Firing2B';
M2Firing2BEntity.prototype.model    = 'model_m2_f2b';
M2Firing2BEntity.prototype.bundle   = 'bundle_m2_f2b';
M2Firing2BEntity.prototype.database = 'testdb';

M2Firing2BEntity.prototype.findOne = function findOne(id) {
    var _t = 'm2Firing2B#findOne'; // trigger reference
};

mu.setConnection('bundle_m2_f2b', 'model_m2_f2b', null);
mu.setModelEntity('bundle_m2_f2b', 'model_m2_f2b', 'M2Firing2BEntity', M2Firing2BEntity);

EntitySuper['M2Firing2B'] = { initialized: true };
var instC = new M2Firing2BEntity(null, null);


// ─── tests ───────────────────────────────────────────────────────────────────

describe('entity._arguments buffer — DISPATCH:BUFFER_CALLBACK (#M2)', function() {

    it('Promise path: _arguments[trigger] deleted after consuming buffered result', function(_, done) {
        var trigger = 'm2Promise#findOne';

        // Simulate DISPATCH:PREEMPTIVE_BUFFER: pre-populate the buffer as if a concurrent call's
        // emit fired before any once-listener was registered.
        instA._arguments          = instA._arguments || {};
        instA._arguments[trigger] = [null, {id: 'promise-path-result'}];

        // Call via the Promise path (entity context preserved: this[m] is defined).
        var p = instA.findOne('x');

        p.then(function(data) {
            // Buffer consumed and deleted — next caller must not reuse it.
            assert.equal(
                typeof instA._arguments[trigger],
                'undefined',
                'Promise path must delete _arguments[trigger] after consuming'
            );
            assert.deepEqual(data, {id: 'promise-path-result'});
            done();
        }).catch(done);
    });


    it('DISPATCH:BUFFER_CALLBACK: _arguments[trigger] deleted after consuming buffered result', function(_, done) {
        var trigger = 'm2Firing2A#findOne';

        instB._arguments          = instB._arguments || {};
        instB._arguments[trigger] = [null, {id: 'firing2-result'}];

        // Call the wrapper detached from entity context (this = global/undefined
        // in non-strict mode → this[m] is undefined → DISPATCH:BUFFER_CALLBACK path).
        var wrapper  = instB.findOne;
        var received = null;
        wrapper('x', function(err, data) {
            received = {err: err, data: data};
        });

        // DISPATCH:BUFFER_CALLBACK must have consumed and deleted the buffer synchronously.
        assert.equal(
            typeof instB._arguments[trigger],
            'undefined',
            'DISPATCH:BUFFER_CALLBACK must delete _arguments[trigger] after consuming it'
        );
        assert.deepEqual(received, {err: null, data: {id: 'firing2-result'}});

        done();
    });


    it('DISPATCH:BUFFER_CALLBACK: subsequent call is not poisoned after buffer is cleared', function(_, done) {
        var trigger = 'm2Firing2B#findOne';
        var wrapper = instC.findOne;

        // Simulate DISPATCH:PREEMPTIVE_BUFFER buffering a result for a first concurrent call
        instC._arguments          = instC._arguments || {};
        instC._arguments[trigger] = [null, {id: 'first'}];

        // First call — consumes buffer via DISPATCH:BUFFER_CALLBACK
        wrapper('a', function() {});

        // Buffer must be gone so the next call gets a fresh listener
        assert.equal(
            typeof instC._arguments[trigger],
            'undefined',
            'buffer must be cleared so the next call cannot reuse the stale result'
        );

        done();
    });

});
