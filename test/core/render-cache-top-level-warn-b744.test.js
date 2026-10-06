/**
 * #B744 — settings.json's top-level `cache` block: the six keys the framework template
 * defines under `server.cache` (`enable`, `path`, `ttl`, `sliding`, `maxAge`, `maxEntries`)
 * are inert there by construction (the #B114 fold is fill-only and runs after the template
 * has set them), so the boot now names each one found, with the block that works.
 *
 *  §01 — `RenderCache.inertTopLevelKeys` (pure) + the constant.
 *  §02 — the gna.js warn block: pinned OUTSIDE the #RC4 block the boot test slices (so no
 *        existing pin moves), reading `content.settings.cache`, try-guarded; then the block's
 *        REAL bytes are extracted and executed against fakes (two inert keys → two warns,
 *        `type` alone → none, a throwing config read → none and no throw).
 *  §03 — schema/settings.json marks the six keys `deprecated` with a pointer to `server.cache`.
 *
 * Seams: GINA_GNA_SRC=<file> (the gna.js text), GINA_RENDER_CACHE_MAIN=<module path> (the
 * lib). Red-first: against the pre-#B744 gna.js the §02 pins fail; against the pre-#B744 lib
 * `inertTopLevelKeys` is not a function.
 *
 * Usage: node --test test/core/render-cache-top-level-warn-b744.test.js
 */
'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = require('../fw');
var GNA_SRC     = fs.readFileSync(process.env.GINA_GNA_SRC || path.join(FW, 'core/gna.js'), 'utf8');
var RenderCache = require(process.env.GINA_RENDER_CACHE_MAIN || path.join(FW, 'lib/render-cache/src/main'));
var SCHEMA      = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schema', 'settings.json'), 'utf8'));

var SIX = ['enable', 'path', 'ttl', 'sliding', 'maxAge', 'maxEntries'];

describe('01 - RenderCache.inertTopLevelKeys (pure)', function() {
    it('exposes the six template-defined keys as a constant', function() {
        assert.deepEqual(RenderCache.INERT_TOP_LEVEL_KEYS, SIX);
    });
    it('a block carrying only the backend keys is clean', function() {
        assert.deepEqual(RenderCache.inertTopLevelKeys({ type: 'memory', store: 'cacheRedis', name: 'cache' }), []);
    });
    it('names each inert key present, in constant order, whatever its value', function() {
        assert.deepEqual(RenderCache.inertTopLevelKeys({ ttl: 120, enable: 'true', type: 'memory' }), ['enable', 'ttl']);
        assert.deepEqual(RenderCache.inertTopLevelKeys({ enable: false, path: '', ttl: 0, sliding: false, maxAge: 0, maxEntries: 0 }), SIX);
    });
    it('non-objects answer an empty list (undefined, null, string, array)', function() {
        assert.deepEqual(RenderCache.inertTopLevelKeys(), []);
        assert.deepEqual(RenderCache.inertTopLevelKeys(null), []);
        assert.deepEqual(RenderCache.inertTopLevelKeys('memory'), []);
        assert.deepEqual(RenderCache.inertTopLevelKeys(['enable']), []);
    });
    it('reads own properties only', function() {
        var proto = Object.create({ enable: true });
        assert.deepEqual(RenderCache.inertTopLevelKeys(proto), []);
    });
});

describe('02 - gna.js boot warn block', function() {
    var rc4Start = GNA_SRC.indexOf('// #RC4 — render/output-cache redis L2.');
    var rc4End   = GNA_SRC.indexOf("console.warn('[render-cache] config validation skipped:", rc4Start);
    var stoAt    = GNA_SRC.indexOf('// #STO1 — pluggable object storage.');
    var warnAt   = GNA_SRC.indexOf("// #B744 — settings.json's top-level `cache` block");

    it('sits after the #RC4 block (outside the boot test\'s rcBlock slice) and before #STO1', function() {
        assert.ok(rc4Start > -1 && rc4End > rc4Start, 'the #RC4 block is present');
        assert.ok(warnAt > rc4End + 120, 'the warn block starts after the rcBlock slice end (rc4End + 120)');
        assert.ok(stoAt > warnAt, 'the warn block precedes the #STO1 band');
    });

    var block = GNA_SRC.slice(warnAt, stoAt);

    it('reads the bundle\'s raw settings block and asks the lib which keys are inert', function() {
        assert.match(block, /config\.getInstance\(\)\[gna\.core\.startingApp\]\[env\]\.content\.settings\.cache/);
        assert.match(block, /lib\.RenderCache\.inertTopLevelKeys\(/);
        assert.match(block, /is ignored there/);
        assert.match(block, /server\.cache/);
    });

    it('is try-guarded twice (the read and the whole block) — advisory only', function() {
        assert.strictEqual((block.match(/\btry \{/g) || []).length, 2);
        assert.match(block, /catch \(rcTopErr\)/);
        assert.match(block, /catch \(rcTopWarnErr\)/);
    });

    /**
     * Executes the block's real bytes against fakes.
     * @param {*} settingsCache - what `config.getInstance()...content.settings.cache` answers
     * @param {boolean} [throwOnRead]
     * @returns {string[]} the warn lines
     * @inner
     */
    function runBlock(settingsCache, throwOnRead) {
        var warns = [];
        var config = { getInstance: function() {
            if (throwOnRead) throw new Error('no instance');
            return { app: { prod: { content: { settings: { cache: settingsCache } } } } };
        } };
        /* eslint-disable no-new-func */
        var fn = new Function('config', 'gna', 'env', 'lib', 'console', block);
        fn(config, { core: { startingApp: 'app' } }, 'prod', { RenderCache: RenderCache }, { warn: function(l) { warns.push(l); } });
        return warns;
    }

    it('BEHAVIOUR: two inert keys → two warns, each naming the key and server.cache', function() {
        var warns = runBlock({ enable: 'true', ttl: 120, type: 'memory' });
        assert.strictEqual(warns.length, 2);
        assert.match(warns[0], /settings\.json > cache\.enable is ignored there/);
        assert.match(warns[0], /server\.cache/);
        assert.match(warns[1], /settings\.json > cache\.ttl is ignored there/);
    });

    it('BEHAVIOUR: the backend keys alone → no warn; no block → no warn', function() {
        assert.deepEqual(runBlock({ type: 'memory', store: 'x', name: 'cache' }), []);
        assert.deepEqual(runBlock(undefined), []);
    });

    it('BEHAVIOUR: a failing config read → no warn and no throw', function() {
        assert.deepEqual(runBlock({ enable: true }, true), []);
    });
});

describe('03 - schema/settings.json marks the six keys deprecated under the top-level cache block', function() {
    var props = SCHEMA.properties.cache.properties;
    it('keeps the backend keys undeprecated', function() {
        ['type', 'store', 'name'].forEach(function(k) {
            assert.ok(props[k], k + ' declared');
            assert.notStrictEqual(props[k].deprecated, true, k + ' is not deprecated');
        });
    });
    SIX.forEach(function(k) {
        it('`' + k + '`: deprecated, with a description naming server.cache', function() {
            assert.ok(props[k], k + ' declared');
            assert.strictEqual(props[k].deprecated, true);
            assert.match(props[k].description, /server\.cache/);
        });
    });
    it('the block description says the six keys are ignored and warned about', function() {
        assert.match(SCHEMA.properties.cache.description, /boot warning/);
    });
});
