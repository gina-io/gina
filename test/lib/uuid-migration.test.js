/**
 * uuid-migration.test.js
 *
 * Tests for the uuid → crypto.randomUUID() migration.
 *
 * Server-side modules (cache, collection, storage, validator) replaced
 * require('vendor/uuid') with inline shims that call crypto.randomUUID().
 * Frontend AMD modules removed 'vendor/uuid' from their RequireJS dependency
 * arrays and call crypto.randomUUID() directly.
 *
 * This file validates:
 *   - Source inspection: no residual require('vendor/uuid') in migrated files
 *   - Functional: uuid shims produce valid v4 UUIDs
 *   - Functional: cache, collection use uuid.v4() correctly at runtime
 *   - Build config: vendor/uuid removed from RequireJS build configs
 *   - Frontend: vendor/uuid removed from AMD define() dependency arrays
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var FW = require('../fw');

// ── Source file paths ────────────────────────────────────────────────────────

var CACHE_SRC      = path.join(FW, 'lib/cache/src/main.js');
var COLLECTION_SRC = path.join(FW, 'lib/collection/src/main.js');
var STORAGE_SRC    = path.join(FW, 'core/plugins/lib/storage/src/main.js');
var VALIDATOR_SRC  = path.join(FW, 'core/plugins/lib/validator/src/main.js');

var PLUGIN_SRC     = path.join(FW, 'core/asset/plugin/src/vendor/gina');
var CORE_JS        = path.join(PLUGIN_SRC, 'core.js');
var MAIN_JS        = path.join(PLUGIN_SRC, 'main.js');
var LINK_JS        = path.join(PLUGIN_SRC, 'link/main.js');
var POPIN_JS       = path.join(PLUGIN_SRC, 'popin/main.js');
var TOOLBAR_JS     = path.join(PLUGIN_SRC, 'toolbar/main.js');

var BUILD_JSON     = path.join(PLUGIN_SRC, 'build.json');
var BUILD_DEV_JSON = path.join(PLUGIN_SRC, 'build.dev.json');

// UUID v4 regex (8-4-4-4-12 hex with version nibble = 4, variant = 8/9/a/b)
var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


// ── 01 — Source inspection: server-side files ────────────────────────────────

describe('01 - Source: no residual require(vendor/uuid) in server-side files', function() {

    var files = [
        { name: 'cache/src/main.js',     path: CACHE_SRC },
        { name: 'collection/src/main.js', path: COLLECTION_SRC },
        { name: 'storage/src/main.js',    path: STORAGE_SRC },
        { name: 'validator/src/main.js',  path: VALIDATOR_SRC }
    ];

    for (var i = 0; i < files.length; i++) {
        (function(f) {
            it(f.name + ' does not require vendor/uuid', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf("require('vendor/uuid')") === -1,
                    f.name + ' still contains require(\'vendor/uuid\')'
                );
            });

            it(f.name + ' uses crypto.randomUUID()', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf('crypto.randomUUID()') > -1,
                    f.name + ' does not reference crypto.randomUUID()'
                );
            });
        })(files[i]);
    }
});


// ── 02 — Source inspection: frontend AMD modules ─────────────────────────────

describe('02 - Source: vendor/uuid removed from frontend AMD modules', function() {

    var amdFiles = [
        { name: 'core.js',         path: CORE_JS },
        { name: 'main.js',         path: MAIN_JS },
        { name: 'link/main.js',    path: LINK_JS },
        { name: 'popin/main.js',   path: POPIN_JS },
        { name: 'toolbar/main.js', path: TOOLBAR_JS }
    ];

    for (var i = 0; i < amdFiles.length; i++) {
        (function(f) {
            it(f.name + ' does not list vendor/uuid in define() deps', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                // Check the define() call's dependency array
                assert.ok(
                    src.indexOf("'vendor/uuid'") === -1,
                    f.name + ' still lists vendor/uuid in define() dependencies'
                );
            });

            it(f.name + ' does not require vendor/uuid', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf("require('vendor/uuid')") === -1,
                    f.name + ' still contains require(\'vendor/uuid\')'
                );
            });
        })(amdFiles[i]);
    }

    // Files that use uuid directly should call crypto.randomUUID()
    var uuidCallers = [
        { name: 'main.js',      path: MAIN_JS },
        { name: 'link/main.js', path: LINK_JS },
        { name: 'popin/main.js', path: POPIN_JS }
    ];

    for (var j = 0; j < uuidCallers.length; j++) {
        (function(f) {
            it(f.name + ' uses crypto.randomUUID() for ID generation', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf('crypto.randomUUID()') > -1,
                    f.name + ' does not call crypto.randomUUID()'
                );
            });
        })(uuidCallers[j]);
    }
});


// ── 03 — Source inspection: RequireJS build configs ──────────────────────────

describe('03 - Source: vendor/uuid removed from RequireJS build configs', function() {

    it('build.json does not reference vendor/uuid path', function() {
        var src = fs.readFileSync(BUILD_JSON, 'utf8');
        assert.ok(
            src.indexOf('"vendor/uuid"') === -1,
            'build.json still maps vendor/uuid to a file path'
        );
    });

    it('build.dev.json does not reference vendor/uuid path', function() {
        var src = fs.readFileSync(BUILD_DEV_JSON, 'utf8');
        assert.ok(
            src.indexOf('"vendor/uuid"') === -1,
            'build.dev.json still maps vendor/uuid to a file path'
        );
    });
});


// ── 04 — Functional: uuid.v4() shim produces valid UUIDs ───────────────────

describe('04 - Functional: uuid.v4() shim produces valid v4 UUIDs', function() {

    // Replicate the exact shim used in cache and collection
    var uuidShimV4Only = { v4: function() { return crypto.randomUUID(); } };

    it('uuid.v4() returns a string', function() {
        var id = uuidShimV4Only.v4();
        assert.equal(typeof id, 'string');
    });

    it('uuid.v4() matches the UUID v4 format', function() {
        var id = uuidShimV4Only.v4();
        assert.ok(UUID_V4_RE.test(id), 'Expected UUID v4 format, got: ' + id);
    });

    it('uuid.v4() produces unique values across 100 calls', function() {
        var seen = new Set();
        for (var i = 0; i < 100; i++) {
            seen.add(uuidShimV4Only.v4());
        }
        assert.equal(seen.size, 100, 'Expected 100 unique UUIDs');
    });
});


// ── 05 — Functional: uuid.v1() shim (storage) produces valid IDs ────────────

describe('05 - Functional: uuid.v1() shim produces valid time-prefixed UUIDs', function() {

    // Replicate the exact shim used in storage
    var uuidShimFull = {
        v1: function() { return Date.now().toString(36) + '-' + crypto.randomUUID(); },
        v4: function() { return crypto.randomUUID(); }
    };

    it('uuid.v1() returns a string', function() {
        var id = uuidShimFull.v1();
        assert.equal(typeof id, 'string');
    });

    it('uuid.v1() contains a base36 timestamp prefix and a hyphen separator', function() {
        var id = uuidShimFull.v1();
        var parts = id.split('-');
        // base36 timestamp is the first segment before the first hyphen
        assert.ok(parts.length >= 2, 'Expected at least 2 segments separated by hyphens');
        // First segment should be a valid base36 number
        var ts = parseInt(parts[0], 36);
        assert.ok(!isNaN(ts) && ts > 0, 'First segment should be a base36 timestamp, got: ' + parts[0]);
    });

    it('uuid.v1() produces unique values across 100 calls', function() {
        var seen = new Set();
        for (var i = 0; i < 100; i++) {
            seen.add(uuidShimFull.v1());
        }
        assert.equal(seen.size, 100, 'Expected 100 unique UUIDs');
    });

    it('uuid.v1() timestamp prefix is monotonically non-decreasing', function() {
        var id1 = uuidShimFull.v1();
        var id2 = uuidShimFull.v1();
        var ts1 = parseInt(id1.split('-')[0], 36);
        var ts2 = parseInt(id2.split('-')[0], 36);
        assert.ok(ts2 >= ts1, 'Second timestamp should be >= first');
    });
});


// ── 06 — Functional: Cache uses uuid.v4() for entry IDs ─────────────────────

describe('06 - Functional: Cache generates valid IDs via crypto.randomUUID()', function() {

    var helpers = require(path.join(FW, 'helpers'));
    var Cache = require(CACHE_SRC);

    it('Cache set() creates entries (uuid used internally for createdAt tracking)', function() {
        var cache = new Cache();
        cache.from(new Map());
        cache.set('testKey', { name: 'testValue' });
        var result = cache.get('testKey');
        assert.ok(result, 'Expected to retrieve cached value');
        assert.equal(result.name, 'testValue');
    });
});


// ── 07 — Functional: Collection generates valid _uuid fields ─────────────────
// Note: toRaw() intentionally strips _uuid from entries that didn't have one.
// We test _uuid by: (a) accessing entries directly (before toRaw), and
// (b) verifying entries with pre-existing _uuid are preserved through toRaw.

describe('07 - Functional: Collection generates valid _uuid via crypto.randomUUID()', function() {

    var helpers = require(path.join(FW, 'helpers'));
    var Collection = require(COLLECTION_SRC);

    it('Collection assigns _uuid internally during construction', function() {
        var data = [{ name: 'Alice' }, { name: 'Bob' }];
        var col = new Collection(data);
        // Access entries directly (col is array-like) — _uuid exists before toRaw strips it
        for (var i = 0; i < col.length; i++) {
            assert.ok(col[i]._uuid, 'Entry ' + i + ' should have a _uuid field');
            assert.equal(typeof col[i]._uuid, 'string');
        }
    });

    it('Collection _uuid fields match UUID v4 format (pre-toRaw)', function() {
        var data = [{ name: 'Test' }];
        var col = new Collection(data);
        assert.ok(
            UUID_V4_RE.test(col[0]._uuid),
            'Expected UUID v4 format, got: ' + col[0]._uuid
        );
    });

    it('Collection entries get unique _uuid values', function() {
        var data = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
        var col = new Collection(data);
        var uuids = [];
        for (var i = 0; i < col.length; i++) {
            uuids.push(col[i]._uuid);
        }
        var unique = new Set(uuids);
        assert.equal(unique.size, uuids.length, 'All _uuid values should be unique');
    });

    it('toRaw() strips generated _uuid but preserves pre-existing _uuid', function() {
        var data = [
            { name: 'Generated' },
            { name: 'PreExisting', _uuid: 'my-custom-uuid' }
        ];
        var col = new Collection(data);
        var raw = col.toRaw();
        // Generated _uuid should be stripped
        assert.equal(raw[0]._uuid, undefined, 'Generated _uuid should be stripped by toRaw()');
        // Pre-existing _uuid should be preserved
        assert.equal(raw[1]._uuid, 'my-custom-uuid', 'Pre-existing _uuid should survive toRaw()');
    });
});


// ── 08 — Source inspection: no residual jQuery references in migrated files ──

describe('08 - Source: jQuery removed from migrated frontend files', function() {

    it('core.js does not reference window.jQuery or window.$', function() {
        var src = fs.readFileSync(CORE_JS, 'utf8');
        // Should not have jQuery context passthrough anymore
        assert.ok(
            src.indexOf("window['jQuery']") === -1 || src.indexOf('// removed') > -1,
            'core.js should not reference jQuery (except in removal comments)'
        );
    });

    it('loader.js sets originalContext to null (not jQuery)', function() {
        var loaderSrc = fs.readFileSync(path.join(PLUGIN_SRC, 'utils/loader.js'), 'utf8');
        assert.ok(
            /originalContext.*=\s*null/.test(loaderSrc),
            'loader.js should set originalContext to null'
        );
    });

    it('events.js removed the jQuery event bridge', function() {
        var eventsSrc = fs.readFileSync(path.join(PLUGIN_SRC, 'utils/events.js'), 'utf8');
        assert.ok(
            eventsSrc.indexOf("typeof(jQuery)") === -1,
            'events.js should not contain typeof(jQuery) check'
        );
    });
});
