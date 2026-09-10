'use strict';

/**
 * Unit tests for the explicit gna exports surface (#M8 / #AI3).
 *
 * Run with:
 *   node --test framework/v*\/test/unit/gna-exports.test.js
 *
 * Two tiers of assertion:
 *   1. Runtime — load the root barrel (`gina/gna`) with heavy dependencies
 *      stubbed, and verify every exported name resolves to the same reference
 *      as the injected global (`barrel.X === global.X`).
 *   2. Static — read `core/gna.js` and verify each expected name is explicitly
 *      assigned on the `gna` object (catches drift where a global is added but
 *      the static export surface is not updated).
 *
 * No bundle bootstrap is needed — the helper modules are loaded directly.
 */

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const fs         = require('fs');
const path       = require('path');

const FRAMEWORK  = path.resolve(__dirname, '../..');
const CORE_GNA   = path.join(FRAMEWORK, 'core/gna.js');
const ROOT_GNA   = path.resolve(FRAMEWORK, '../../gna.js');

// ---------------------------------------------------------------------------
// 1. Populate globals. Helper modules set `global.X` as a side-effect.
// ---------------------------------------------------------------------------

process.env.GINA_HOMEDIR = process.env.GINA_HOMEDIR
    || path.join(process.env.HOME || require('os').homedir(), '.gina');

require(path.join(FRAMEWORK, 'helpers'));                // context/path/json/…
new (require(path.join(FRAMEWORK, 'lib/model')))();      // getModel / getModelEntity
require(path.join(FRAMEWORK, 'core/plugins'));           // ApiError

// ---------------------------------------------------------------------------
// 2. Stub the heavy-bootstrap dependencies of the root barrel so it can be
//    loaded in isolation. `core/gna.js` normally reads projects.json etc. —
//    we just need its `module.exports` to exist; the real globals are already
//    populated above.
// ---------------------------------------------------------------------------

function stubModule(file) {
    const resolved = require.resolve(file);
    require.cache[resolved] = {
        id:       resolved,
        filename: resolved,
        loaded:   true,
        exports:  {}
    };
}

stubModule(path.join(FRAMEWORK, 'core/gna.js'));
stubModule(path.join(FRAMEWORK, 'core/controller'));
stubModule(path.join(FRAMEWORK, 'core/model/entity.js'));

const barrel = require(ROOT_GNA);

// ---------------------------------------------------------------------------
// 3. Inventory of globals re-exported through the barrel.
//    Keep this list in sync with gna.js (root) and core/gna.js.
// ---------------------------------------------------------------------------

const GLOBAL_EXPORTS = [
    // Context helpers
    'setContext', 'getContext', 'joinContext', 'resetContext',
    'getConfig', 'getLib', 'whisper', 'define', 'getDefined', 'isWin32',

    // Path helpers
    '_', 'setPath', 'getPath', 'setPaths', 'getPaths', 'onCompleteCall',

    // Model helpers
    'getModel', 'getModelEntity',

    // JSON helper
    'requireJSON',

    // Data helpers
    'encodeRFC5987ValueChars', 'formatDataFromString',

    // Text helper
    '__',

    // Console helper
    'log',

    // Task helper
    'run',

    // Env helpers
    'getUserHome',
    'getEnvVar', 'getEnvVars', 'setEnvVar',
    'getProtected', 'filterArgs', 'importEnvVars',
    'getLogDir', 'getRunDir', 'getTmpDir',
    'getBundleStartingArgv',
    'getVendorsConfig', 'setVendorsConfig',
    'defineDefault', 'parseTimeout', 'merge',

    // ApiError
    'ApiError'
];

// `core/gna.js` deliberately does NOT re-export `getConfig`: the `gna.getConfig`
// property is later re-bound as an instance method tied to the currently-loaded
// bundle's config. Surfacing the global would collide with that binding.
const CORE_SKIP = new Set(['getConfig']);

// ---------------------------------------------------------------------------
// 4. Runtime assertions — barrel.X === global.X.
// ---------------------------------------------------------------------------

for (const name of GLOBAL_EXPORTS) {
    test('barrel exports `' + name + '` === global.' + name, () => {
        assert.notEqual(typeof global[name], 'undefined',
            'global.' + name + ' is not defined — helper module did not inject it');
        assert.equal(barrel[name], global[name],
            'barrel.' + name + ' does not match global.' + name);
    });
}

// ---------------------------------------------------------------------------
// 5. Classes / uuid are directly-attached on the barrel, not getters.
// ---------------------------------------------------------------------------

test('barrel exposes SuperController, EntitySuper, uuid', () => {
    assert.ok('SuperController' in barrel, 'SuperController missing from barrel');
    assert.ok('EntitySuper'     in barrel, 'EntitySuper missing from barrel');
    assert.equal(typeof barrel.uuid, 'function', 'uuid must be a function');
});

// ---------------------------------------------------------------------------
// 6. Static assertions — core/gna.js must keep the same named export surface.
// ---------------------------------------------------------------------------

const coreSrc = fs.readFileSync(CORE_GNA, 'utf8');

for (const name of GLOBAL_EXPORTS) {
    if (CORE_SKIP.has(name)) continue;
    test('core/gna.js exports `' + name + '`', () => {
        // Match `gna.<name> =` at the start of a line.
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx      = new RegExp('^gna\\.' + escaped + '\\s*=', 'm');
        assert.ok(rx.test(coreSrc),
            'core/gna.js is missing explicit export: gna.' + name + ' = ...');
    });
}
