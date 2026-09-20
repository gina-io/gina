/**
 * #B90 — Popin registry: the published `gina.popin` accessors resolve EVERY
 * instance's popins (shared module registry + publish-once)
 *
 * The popin plugin used to publish itself with a target-wins deep copy on every
 * `new Popin()` construction. After the first construction the published object
 * therefore kept the FIRST instance's method closures and scalar state forever:
 *   - `gina.popin.getPopinByName` / `getPopinById` stayed bound to the boot
 *     instance's `$popins` and returned null for every popin registered by a
 *     later `new Popin()` — even though the published `$popins` accumulated the
 *     entries (its keys were re-copied at each construction);
 *   - `gina.popin.activePopinId` stayed frozen at its first-publish value, so
 *     `getActivePopin()`'s id-fallback never fired;
 *   - popins registered AFTER an instance's publish (click-time in-page dialog
 *     registrations) never reached the published registry at all, and destroyed
 *     popins lingered in it.
 * Blast radius: the validator's cross-popin redirect resolves the target via
 * `gina.popin.getPopinByName(...)` — it always threw "not found" for consumer
 * popins, surfacing as a 422 `error.<formId>` event (a form submit could not
 * redirect into a different popin).
 *
 * The fix: ONE module-scoped registry (`_sharedPopins`) aliased by every
 * instance's `$popins` (so all registrations/deletes/lookups hit the same
 * object), a publish-once `gina.popin = instance` (the published object IS the
 * first instance, LIVE — re-publishing was both the freeze defect and, with a
 * shared registry, a self-merge recursion hazard), and a `setActivePopinId`
 * write-through helper keeping `gina.popin.activePopinId` truthful no matter
 * which instance opens or closes a popin.
 *
 * Usage: node --test test/core/popin-registry.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC   = path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN_JS = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var _src, _distSrc, _distMinSrc;
function getSrc()        { return _src        || (_src        = fs.readFileSync(POPIN_SRC, 'utf8')); }
function getDistSrc()    { return _distSrc    || (_distSrc    = fs.readFileSync(DIST_JS, 'utf8')); }
function getDistMinSrc() { return _distMinSrc || (_distMinSrc = fs.readFileSync(DIST_MIN_JS, 'utf8')); }

// The REAL framework merge — the old-arm replicas below must reproduce the
// defect through the exact target-wins semantics the plugin used.
var merge = require(path.join(FW, 'lib/merge'));


// ── 01 — #B90 source pins: shared registry + publish-once + write-through ─────

describe('01 - Popin registry (#B90): source pins', function () {

    it('declares the module-scoped shared registry before the constructor', function () {
        var src = getSrc();
        var regIdx  = src.indexOf('var _sharedPopins = {};');
        var ctorIdx = src.indexOf('function Popin(options)');
        assert.ok(regIdx > -1, 'expected the module-scoped _sharedPopins declaration');
        assert.ok(ctorIdx > -1, 'the Popin constructor is missing?');
        assert.ok(regIdx < ctorIdx, '_sharedPopins must be module-scoped (declared before the constructor)');
    });

    it('every instance aliases the shared registry (no per-instance registry left)', function () {
        var src = getSrc();
        assert.match(src, /'\$popins'\s*:\s*_sharedPopins,/,
            'the instance literal must alias _sharedPopins');
        assert.doesNotMatch(src, /'\$popins'\s*:\s*\{\}/,
            'no per-instance `$popins : {}` init may remain — the registry is module-shared');
    });

    it('publishes ONCE: gina.popin is the first instance, no re-publish', function () {
        var src = getSrc();
        var guardIdx = src.indexOf("if ( typeof(gina.popin) == 'undefined' || !gina.popin ) {");
        assert.ok(guardIdx > -1, 'expected the publish-once guard');
        var block = src.substring(guardIdx, guardIdx + 120);
        assert.match(block, /gina\.popin = instance;/,
            'the publish must assign the instance itself (LIVE object), not a copy');
    });

    it('the target-wins re-publish is gone (whole source, comments included)', function () {
        // Globally-zero token: the defect construct must not exist anywhere in
        // the file — code or prose (the fix comments deliberately avoid it).
        assert.ok(getSrc().indexOf('merge(gina.popin') < 0,
            'no target-wins publish of gina.popin may remain');
    });

    it('setActivePopinId writes the instance mirror AND the published object', function () {
        var src = getSrc();
        var defIdx = src.indexOf('var setActivePopinId = function(id) {');
        assert.ok(defIdx > -1, 'expected the setActivePopinId helper');
        var block = src.substring(defIdx, defIdx + 320);
        assert.match(block, /instance\.activePopinId = id;/,
            'the helper must write the instance mirror');
        assert.match(block, /if \( typeof\(gina\.popin\) != 'undefined' && gina\.popin \) \{\s*\n\s*gina\.popin\.activePopinId = id;/,
            'the helper must write through to the published gina.popin (guarded pre-publish)');
    });

    it('every activePopinId write routes through the helper (exactly one raw assignment each)', function () {
        var src = getSrc();
        var instWrites = src.match(/instance\.activePopinId\s*=/g) || [];
        var pubWrites  = src.match(/gina\.popin\.activePopinId\s*=/g) || [];
        assert.equal(instWrites.length, 1,
            'expected exactly 1 raw `instance.activePopinId =` (inside setActivePopinId), got ' + instWrites.length);
        assert.equal(pubWrites.length, 1,
            'expected exactly 1 raw `gina.popin.activePopinId =` (inside setActivePopinId), got ' + pubWrites.length);
    });

    it('popinDestroy compares against the PUBLISHED active id, not the instance mirror', function () {
        var src = getSrc();
        var idx = src.indexOf("var _activePopinId = ( typeof(gina.popin) != 'undefined' && gina.popin ) ? gina.popin.activePopinId : instance.activePopinId;");
        assert.ok(idx > -1, 'expected the published-first active-id read in popinDestroy');
        var block = src.substring(idx, idx + 260);
        assert.match(block, /if \( _activePopinId === id \) \{\s*\n\s*setActivePopinId\(null\);/,
            'the destroy reset must compare the published value and clear through the helper');
    });

    it('the accessors keep reading instance.$popins — the aliasing IS the fix', function () {
        var src = getSrc();
        // getPopinById body
        assert.match(src, /return \( typeof\(instance\.\$popins\[id\]\) != 'undefined' \) \? instance\.\$popins\[id\] : null;/,
            'getPopinById must still read instance.$popins (which aliases the shared registry)');
        // getPopinByName loop
        assert.match(src, /for \(var p in instance\.\$popins\) \{/,
            'getPopinByName must still walk instance.$popins (which aliases the shared registry)');
    });

    it('getActivePopin still walks the published registry, preferring the OPEN activePopinId (#gh76 realigned)', function () {
        var src = getSrc();
        // #gh76 §8(a): the walk reads the published registry through a local alias, and the
        // activePopinId write-through is still load-bearing — as the PREFERRED popin when it
        // is open, no longer as an any-state fallback (a not-open popin is never returned).
        assert.match(src, /var \$popins = gina\.popin\.\$popins, activeId = gina\.popin\.activePopinId;/,
            'getActivePopin reads gina.popin.$popins and gina.popin.activePopinId');
        assert.match(src, /for \(var p in \$popins\) \{/,
            'getActivePopin walks the (aliased) published registry');
        assert.match(src, /activeId && \$popins\[activeId\] && \$popins\[activeId\]\.isOpen/,
            'getActivePopin prefers the activePopinId popin only when it is open (the write-through stays live)');
        assert.doesNotMatch(src, /\$popin = gina\.popin\.\$popins\[gina\.popin\.activePopinId\]/,
            'the any-state activePopinId fallback is gone (#gh76 §8(a))');
    });
});


// ── 02 — behavioral replicas against the REAL lib/merge ───────────────────────
//
// The OLD arm reproduces the published-accessor blindness through the exact
// pattern the plugin used (per-instance registries + a target-wins publish on
// every construction). The NEW arm mirrors the fixed pattern (shared registry +
// publish-once + write-through) and proves each defect is gone.

function makeOldStyleInstance(id) {
    var instance = {
        id: id,
        '$popins': {},          // per-instance registry (the defect)
        activePopinId: null
    };
    instance.getPopinByName = function (name) {
        var $popin = null;
        for (var p in instance.$popins) {
            if (instance.$popins[p].name === name) { $popin = instance.$popins[p]; break; }
        }
        return $popin;
    };
    instance.getPopinById = function (pid) {
        return (typeof (instance.$popins[pid]) != 'undefined') ? instance.$popins[pid] : null;
    };
    return instance;
}

function makeNewStyleInstance(id, sharedPopins, gina) {
    var instance = {
        id: id,
        '$popins': sharedPopins, // module-shared registry (the fix)
        activePopinId: null
    };
    instance.getPopinByName = function (name) {
        var $popin = null;
        for (var p in instance.$popins) {
            if (instance.$popins[p].name === name) { $popin = instance.$popins[p]; break; }
        }
        return $popin;
    };
    instance.getPopinById = function (pid) {
        return (typeof (instance.$popins[pid]) != 'undefined') ? instance.$popins[pid] : null;
    };
    instance.setActivePopinId = function (aid) {
        instance.activePopinId = aid;
        if (typeof (gina.popin) != 'undefined' && gina.popin) {
            gina.popin.activePopinId = aid;
        }
    };
    return instance;
}

// The publish-once shape from the fix.
function publishOnce(gina, instance) {
    if (typeof (gina.popin) == 'undefined' || !gina.popin) {
        gina.popin = instance;
    }
}

// getActivePopin as the plugin implements it since #gh76 §8(a): the activePopinId popin
// when it is OPEN, else the first open popin in registration order, else null (a
// registered-but-not-open popin is never returned).
function getActivePopinReplica(gina) {
    var $popins = gina.popin.$popins, activeId = gina.popin.activePopinId;
    if (activeId && $popins[activeId] && $popins[activeId].isOpen) {
        return $popins[activeId];
    }
    for (var p in $popins) {
        if (typeof ($popins[p].isOpen) != 'undefined' && $popins[p].isOpen) {
            return $popins[p];
        }
    }
    return null;
}

describe('02 - Popin registry (#B90): old-pattern subtract reproduces the defect', function () {

    it('OLD: the published accessor is blind to a later instance\'s popins while $popins accumulates', function () {
        var gina = {};
        var boot = makeOldStyleInstance('gina-popins-1');
        boot.$popins['gina-popin-gina-popins-1-gina-dialog-boot'] =
            { name: 'gina-dialog-boot', id: 'gina-popin-gina-popins-1-gina-dialog-boot', isOpen: false };
        gina.popin = merge(gina.popin, boot);

        var second = makeOldStyleInstance('gina-popins-2');
        second.$popins['gina-popin-gina-popins-2-p1'] =
            { name: 'p1', id: 'gina-popin-gina-popins-2-p1', isOpen: false };
        gina.popin = merge(gina.popin, second);

        // the accumulator DOES contain p1 (keys accumulate through the merge)...
        assert.ok(gina.popin.$popins['gina-popin-gina-popins-2-p1'],
            'the published $popins accumulates the later popin');
        // ...but the published accessor (first instance\'s closure) is blind — the defect
        assert.equal(gina.popin.getPopinByName('p1'), null,
            'OLD pattern: the published getPopinByName must be blind (subtract control)');
        assert.ok(gina.popin.getPopinByName('gina-dialog-boot'),
            'OLD pattern: the boot popin resolves (first instance\'s registry)');
    });

    it('OLD: activePopinId is frozen at its first-publish value', function () {
        var gina = {};
        var boot = makeOldStyleInstance('gina-popins-1');
        gina.popin = merge(gina.popin, boot);

        var second = makeOldStyleInstance('gina-popins-2');
        var p1 = { name: 'p1', id: 'p1-id', isOpen: false };
        second.$popins['p1-id'] = p1;
        gina.popin = merge(gina.popin, second);

        // runtime open on the second instance (the plugin wrote instance.activePopinId)
        second.activePopinId = 'p1-id';
        assert.equal(gina.popin.activePopinId, null,
            'OLD pattern: the published activePopinId never moves (frozen)');
        // and with nothing isOpen, the getActivePopin id-fallback can never fire
        assert.equal(getActivePopinReplica(gina), null,
            'OLD pattern: getActivePopin returns null as soon as nothing is open');
    });

    it('OLD: a registration AFTER the instance\'s publish never reaches the published registry', function () {
        var gina = {};
        var boot = makeOldStyleInstance('gina-popins-1');
        gina.popin = merge(gina.popin, boot);

        // click-time registration (in-page dialog ensure) — no re-publish happens
        boot.$popins['late-dialog'] = { name: 'late-dialog', id: 'late-dialog', isOpen: true };
        assert.equal(typeof gina.popin.$popins['late-dialog'], 'undefined',
            'OLD pattern: the published registry is a merge-time copy — late registrations are invisible');
        assert.equal(getActivePopinReplica(gina), null,
            'OLD pattern: an OPEN late-registered popin is invisible to getActivePopin');
    });
});

describe('02b - Popin registry (#B90): the fixed pattern resolves every popin', function () {

    it('NEW: the published accessor resolves popins registered by ANY instance', function () {
        var gina = {};
        var shared = {};
        var boot = makeNewStyleInstance('gina-popins-1', shared, gina);
        boot.$popins['gina-popin-gina-popins-1-gina-dialog-boot'] =
            { name: 'gina-dialog-boot', id: 'gina-popin-gina-popins-1-gina-dialog-boot', isOpen: false };
        publishOnce(gina, boot);

        var second = makeNewStyleInstance('gina-popins-2', shared, gina);
        second.$popins['gina-popin-gina-popins-2-p1'] =
            { name: 'p1', id: 'gina-popin-gina-popins-2-p1', isOpen: false };
        publishOnce(gina, second); // no-op — already published

        assert.ok(gina.popin.getPopinByName('p1'),
            'NEW pattern: the published getPopinByName resolves the later instance\'s popin');
        assert.ok(gina.popin.getPopinById('gina-popin-gina-popins-2-p1'),
            'NEW pattern: getPopinById resolves it too');
        assert.ok(gina.popin.getPopinByName('gina-dialog-boot'),
            'NEW pattern: the boot popin still resolves');
        assert.equal(gina.popin, boot,
            'NEW pattern: the published object IS the first instance (live)');
    });

    it('NEW: activePopinId written by ANY instance reaches the published object (id-fallback live)', function () {
        var gina = {};
        var shared = {};
        var boot = makeNewStyleInstance('gina-popins-1', shared, gina);
        publishOnce(gina, boot);

        var second = makeNewStyleInstance('gina-popins-2', shared, gina);
        var p1 = { name: 'p1', id: 'p1-id', isOpen: false };
        second.$popins['p1-id'] = p1;

        second.setActivePopinId('p1-id');
        assert.equal(gina.popin.activePopinId, 'p1-id',
            'NEW pattern: the write-through keeps the published activePopinId truthful');
        // #gh76 §8(a): with nothing open the accessor returns null even though the
        // write-through set the id; open the popin and the id-preference resolves it —
        // which is what proves the published activePopinId reaches the accessor.
        assert.equal(getActivePopinReplica(gina), null,
            'NEW pattern: a not-open popin is never returned, activePopinId or not (#gh76)');
        p1.isOpen = true;
        assert.equal(getActivePopinReplica(gina), p1,
            'NEW pattern: the OPEN activePopinId popin is preferred (the write-through is live)');
        p1.isOpen = false;

        // clearing through the helper clears the published value too
        second.setActivePopinId(null);
        assert.equal(gina.popin.activePopinId, null);
        assert.equal(getActivePopinReplica(gina), null);
    });

    it('NEW: late registrations and deletes are LIVE on the published registry', function () {
        var gina = {};
        var shared = {};
        var boot = makeNewStyleInstance('gina-popins-1', shared, gina);
        publishOnce(gina, boot);

        // click-time registration on a LATER instance, after every publish
        var second = makeNewStyleInstance('gina-popins-2', shared, gina);
        second.$popins['late-dialog'] = { name: 'late-dialog', id: 'late-dialog', isOpen: true };

        assert.ok(gina.popin.$popins['late-dialog'],
            'NEW pattern: late registrations are visible on the published registry (same object)');
        assert.equal(getActivePopinReplica(gina).id, 'late-dialog',
            'NEW pattern: an OPEN late-registered popin is visible to getActivePopin');

        // destroy from the second instance is visible everywhere
        delete second.$popins['late-dialog'];
        assert.equal(typeof gina.popin.$popins['late-dialog'], 'undefined',
            'NEW pattern: deletes are visible on the published registry (same object)');
    });

    it('NEW: pre-publish writes land on the instance and the first publish exposes them', function () {
        var gina = {};
        var shared = {};
        var boot = makeNewStyleInstance('gina-popins-1', shared, gina);

        // a write BEFORE any publish (guard path: gina.popin undefined)
        boot.setActivePopinId('early-id');
        assert.equal(boot.activePopinId, 'early-id');

        publishOnce(gina, boot);
        assert.equal(gina.popin.activePopinId, 'early-id',
            'the first publish exposes the pre-publish value (gina.popin IS the instance)');
    });
});


// ── 03 — dist fidelity: the fix is in the built artifacts ─────────────────────

describe('03 - Popin registry (#B90): dist fidelity', function () {

    it('gina.js (unminified bundle) carries the shared registry + helper, not the re-publish', function () {
        var dist = getDistSrc();
        assert.ok(dist.indexOf('var _sharedPopins = {};') > -1,
            'dist gina.js must carry the module-scoped shared registry');
        assert.ok(dist.indexOf('var setActivePopinId = function(id) {') > -1,
            'dist gina.js must carry the write-through helper');
        assert.ok(dist.indexOf('merge(gina.popin') < 0,
            'dist gina.js must not carry the target-wins re-publish');
    });

    it('gina.min.js (served bundle) publishes by direct assignment, not through a call', function () {
        var min = getDistMinSrc();
        // Minification renames locals but keeps the `gina.popin` global property
        // chain. The old publish minified to a call-result assignment
        // (`gina.popin=<fn>(gina.popin,<var>)`); the fix assigns the instance
        // variable directly inside the publish-once guard.
        assert.doesNotMatch(min, /gina\.popin=[$\w]+\(/,
            'the served bundle must not assign gina.popin from a function call (old merge publish)');
        assert.match(min, /gina\.popin=[$\w]+[,;})]/,
            'the served bundle must direct-assign the instance to gina.popin');
    });
});
