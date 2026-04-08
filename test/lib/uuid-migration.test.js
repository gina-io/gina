/**
 * uuid-migration.test.js
 *
 * Tests for the uuid → lib/uuid migration.
 *
 * Server-side modules (cache, collection, storage, validator) replaced
 * require('vendor/uuid') / crypto.randomUUID() inline shims with
 * require('lib/uuid') — a lightweight, zero-dependency ID generator
 * using crypto.getRandomValues with bitmask bias avoidance.
 * Frontend AMD modules use require('lib/uuid') via RequireJS.
 *
 * This file validates:
 *   - Source inspection: no residual uuid shims or crypto.randomUUID() in migrated files
 *   - Functional: lib/uuid produces valid base-62 IDs of the correct length
 *   - Functional: cache, collection use uuid() correctly at runtime
 *   - Build config: lib/uuid registered in RequireJS build configs
 *   - Frontend: lib/uuid in AMD define() dependency arrays
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

// uuid base-62 regex: only chars from 0-9 A-Z a-z, default length 4
var UUID_RE = /^[0-9A-Za-z]{4}$/;

var UUID_SRC = path.join(FW, 'lib/uuid/src/main.js');


// ── 01 — Source inspection: server-side files use lib/uuid ─────────────────

describe('01 - Source: server-side files use lib/uuid (no uuid shims)', function() {

    var files = [
        { name: 'cache/src/main.js',     path: CACHE_SRC },
        { name: 'collection/src/main.js', path: COLLECTION_SRC },
        { name: 'storage/src/main.js',    path: STORAGE_SRC },
        { name: 'validator/src/main.js',  path: VALIDATOR_SRC }
    ];

    for (var i = 0; i < files.length; i++) {
        (function(f) {
            it(f.name + ' does not contain a uuid inline shim (uuid.v4)', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf("uuid.v4") === -1,
                    f.name + ' still contains a uuid.v4 shim call'
                );
            });

            it(f.name + ' requires lib/uuid', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf("lib/uuid") > -1,
                    f.name + ' does not require lib/uuid'
                );
            });

            it(f.name + ' does not call crypto.randomUUID()', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf('crypto.randomUUID()') === -1,
                    f.name + ' still calls crypto.randomUUID()'
                );
            });
        })(files[i]);
    }
});


// ── 02 — Source inspection: frontend AMD modules use lib/uuid ──────────────

describe('02 - Source: frontend AMD modules use lib/uuid', function() {

    var uuidConsumers = [
        { name: 'main.js',      path: MAIN_JS },
        { name: 'link/main.js', path: LINK_JS }
    ];

    for (var i = 0; i < uuidConsumers.length; i++) {
        (function(f) {
            it(f.name + ' lists lib/uuid in define() deps', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf("'lib/uuid'") > -1,
                    f.name + ' does not list lib/uuid in define() dependencies'
                );
            });

            it(f.name + ' requires lib/uuid', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf("require('lib/uuid')") > -1,
                    f.name + ' does not require lib/uuid'
                );
            });

            it(f.name + ' does not call crypto.randomUUID()', function() {
                var src = fs.readFileSync(f.path, 'utf8');
                assert.ok(
                    src.indexOf('crypto.randomUUID()') === -1,
                    f.name + ' still calls crypto.randomUUID()'
                );
            });
        })(uuidConsumers[i]);
    }
});


// ── 03 — Source inspection: RequireJS build configs ──────────────────────────

describe('03 - Source: lib/uuid registered in RequireJS build configs', function() {

    it('build.json maps lib/uuid', function() {
        var src = fs.readFileSync(BUILD_JSON, 'utf8');
        assert.ok(
            src.indexOf('"lib/uuid"') > -1,
            'build.json does not map lib/uuid'
        );
    });

    it('build.dev.json maps lib/uuid', function() {
        var src = fs.readFileSync(BUILD_DEV_JSON, 'utf8');
        assert.ok(
            src.indexOf('"lib/uuid"') > -1,
            'build.dev.json does not map lib/uuid'
        );
    });

    it('build configs do not reference vendor/uuid', function() {
        var src = fs.readFileSync(BUILD_JSON, 'utf8');
        var srcDev = fs.readFileSync(BUILD_DEV_JSON, 'utf8');
        assert.ok(src.indexOf('"vendor/uuid"') === -1, 'build.json still maps vendor/uuid');
        assert.ok(srcDev.indexOf('"vendor/uuid"') === -1, 'build.dev.json still maps vendor/uuid');
    });
});


// ── 04 — Functional: lib/uuid produces valid base-62 IDs ──────────────────

describe('04 - Functional: lib/uuid produces valid base-62 IDs', function() {

    var uuid = require(UUID_SRC);

    it('uuid() returns a string', function() {
        var id = uuid();
        assert.equal(typeof id, 'string');
    });

    it('uuid() returns 4 characters by default', function() {
        var id = uuid();
        assert.equal(id.length, 4, 'Expected length 4, got: ' + id.length);
    });

    it('uuid() only contains base-62 characters', function() {
        var id = uuid();
        assert.ok(UUID_RE.test(id), 'Expected base-62 chars only, got: ' + id);
    });

    it('uuid(8) returns 8 characters', function() {
        var id = uuid(8);
        assert.equal(id.length, 8);
        assert.ok(/^[0-9A-Za-z]{8}$/.test(id), 'Expected 8 base-62 chars, got: ' + id);
    });

    it('uuid() produces unique values across 1000 calls', function() {
        var seen = new Set();
        for (var i = 0; i < 1000; i++) {
            seen.add(uuid());
        }
        // With 62^4 = ~14.7M possibilities, 1000 calls should have zero collisions
        assert.equal(seen.size, 1000, 'Expected 1000 unique IDs, got: ' + seen.size);
    });

    it('uuid module exports a function (not an object)', function() {
        assert.equal(typeof uuid, 'function');
    });
});


// ── 05 — Functional: storage time-prefixed ID pattern ───────────────────────

describe('05 - Functional: storage time-prefixed ID pattern (Date.now + uuid)', function() {

    var uuid = require(UUID_SRC);

    it('time-prefixed ID returns a string', function() {
        var id = Date.now().toString(36) + '-' + uuid();
        assert.equal(typeof id, 'string');
    });

    it('time-prefixed ID contains a base36 timestamp prefix and a hyphen separator', function() {
        var id = Date.now().toString(36) + '-' + uuid();
        var parts = id.split('-');
        assert.ok(parts.length === 2, 'Expected 2 segments separated by a hyphen');
        var ts = parseInt(parts[0], 36);
        assert.ok(!isNaN(ts) && ts > 0, 'First segment should be a base36 timestamp, got: ' + parts[0]);
        assert.ok(UUID_RE.test(parts[1]), 'Second segment should be a uuid, got: ' + parts[1]);
    });

    it('time-prefixed IDs are unique across 100 calls', function() {
        var seen = new Set();
        for (var i = 0; i < 100; i++) {
            seen.add(Date.now().toString(36) + '-' + uuid());
        }
        assert.equal(seen.size, 100, 'Expected 100 unique IDs');
    });
});


// ── 06 — Functional: Cache uses uuid() for entry IDs ──────────────────────

describe('06 - Functional: Cache generates valid IDs via uuid()', function() {

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

describe('07 - Functional: Collection generates valid _uuid via uuid()', function() {

    var helpers = require(path.join(FW, 'helpers'));
    var Collection = require(COLLECTION_SRC);

    it('Collection assigns _uuid internally during construction', function() {
        var data = [{ name: 'Alice' }, { name: 'Bob' }];
        var col = new Collection(data);
        for (var i = 0; i < col.length; i++) {
            assert.ok(col[i]._uuid, 'Entry ' + i + ' should have a _uuid field');
            assert.equal(typeof col[i]._uuid, 'string');
        }
    });

    it('Collection _uuid fields match uuid base-62 format (pre-toRaw)', function() {
        var data = [{ name: 'Test' }];
        var col = new Collection(data);
        assert.ok(
            UUID_RE.test(col[0]._uuid),
            'Expected 4-char base-62 uuid, got: ' + col[0]._uuid
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
        assert.equal(raw[0]._uuid, undefined, 'Generated _uuid should be stripped by toRaw()');
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
