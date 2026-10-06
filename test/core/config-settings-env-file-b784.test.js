/**
 * #B784 — a whole-settings per-env file, `settings.<env>.json`, used to be nested under a
 * `<env>` key of the bundle settings instead of merged at the top level: the settings
 * loader derived the section by stripping the `settings.` prefix FIRST, which left no
 * leading dot for the `.<env>` strip (`settings.prod.json` → section `prod`). Measured
 * live: `settings.prod.json` `{ server: { cache: { enable: true } } }` left the render
 * cache OFF while its `settings.server.prod.json` control turned it on.
 *
 *  §01 — the derivation, EXTRACTED from the shipped source and executed over a filename
 *        matrix: `settings[.<section>][.<env>].json` → `{ foundEnvVersion, name, section }`.
 *  §02 — the merge direction: an env version of the whole-settings file wins over
 *        `settings.json` whatever the directory order (pinned, and replayed with the real
 *        lib/merge in both orders).
 *
 * Seam: GINA_CONFIG_SRC=<file> runs every arm against that text. Red-first: against the
 * pre-#B784 bytes the extraction anchor is absent (§01 fails for the harness reason) and the
 * §02 pins fail; the merge replica passes on both (it tests lib/merge, the premise).
 *
 * Usage: node --test test/core/config-settings-env-file-b784.test.js
 */
'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var CONFIG_SRC = fs.readFileSync(process.env.GINA_CONFIG_SRC || path.join(FW, 'core/config.js'), 'utf8');
var merge      = require(path.join(FW, 'lib/merge/src/main'));

var DECL_START = 'foundEnvVersion     = new RegExp(';
var DECL_END   = "replace(/(^settings\\.|^settings$)/, '');";

describe('01 - settings filename → { foundEnvVersion, name, section } (the shipped derivation)', function() {
    var start = CONFIG_SRC.indexOf(DECL_START);
    var end   = CONFIG_SRC.indexOf(DECL_END, start);

    it('extracts the derivation exactly once (control)', function() {
        assert.notStrictEqual(start, -1, 'derivation start anchor present');
        assert.notStrictEqual(end, -1, 'derivation end anchor present');
        assert.strictEqual(CONFIG_SRC.indexOf(DECL_START, start + 1), -1, 'start anchor unique');
    });

    var lines = CONFIG_SRC.slice(start, end + DECL_END.length);
    /* eslint-disable no-new-func */
    var derive = new Function('fName', 'env', 'var foundEnvVersion = false;\n' + lines + '\nreturn { foundEnvVersion: foundEnvVersion, name: name, section: section };');

    var MATRIX = [
        ['settings.json',                   'prod', { foundEnvVersion: false, name: 'settings',                  section: '' }],
        ['settings.prod.json',              'prod', { foundEnvVersion: true,  name: 'settings',                  section: '' }],
        ['settings.server.json',            'prod', { foundEnvVersion: false, name: 'settings.server',           section: 'server' }],
        ['settings.server.prod.json',       'prod', { foundEnvVersion: true,  name: 'settings.server',           section: 'server' }],
        ['settings.cache.prod.json',        'prod', { foundEnvVersion: true,  name: 'settings.cache',            section: 'cache' }],
        ['settings.server.cache.prod.json', 'prod', { foundEnvVersion: true,  name: 'settings.server.cache',     section: 'server.cache' }],
        ['settings.server.cache.dev.json',  'prod', { foundEnvVersion: false, name: 'settings.server.cache.dev', section: 'server.cache.dev' }],
        ['settings.dev.json',               'prod', { foundEnvVersion: false, name: 'settings.dev',              section: 'dev' }],
        ['settings.server.cache.dev.json',  'dev',  { foundEnvVersion: true,  name: 'settings.server.cache',     section: 'server.cache' }]
    ];
    MATRIX.forEach(function(row) {
        it(row[0] + ' under env=' + row[1] + ' → ' + JSON.stringify(row[2]), function() {
            assert.deepEqual(derive(row[0], row[1]), row[2]);
        });
    });

    it('the env strip is anchored on a literal dot (a name merely ending in the env is not an env version)', function() {
        var r = derive('settingsprod.json', 'prod');
        assert.strictEqual(r.foundEnvVersion, false);
    });
});

describe('02 - the env version of the whole-settings file wins over settings.json', function() {
    it('pins the target-position merge under the foundEnvVersion branch', function() {
        assert.match(CONFIG_SRC, /else if \( foundEnvVersion && fileContent && typeof\(fileContent\) === 'object' \) \{\s*\n[^\n]*\n[^\n]*\n\s*tmpSettings = merge\(fileContent, tmpSettings\);/);
        assert.match(CONFIG_SRC, /\} else \{\s*\n\s*tmpSettings = merge\(tmpSettings, fileContent\);\s*\n\s*\}/);
    });

    /**
     * Replays the loop's two merge forms with the real lib/merge.
     * @param {Array<{env: boolean, content: object}>} files - in directory order
     * @returns {object}
     * @inner
     */
    function replay(files) {
        var tmpSettings = {};
        files.forEach(function(f) {
            var fileContent = JSON.parse(JSON.stringify(f.content));
            if (f.env && fileContent && typeof fileContent === 'object') {
                tmpSettings = merge(fileContent, tmpSettings);
            } else {
                tmpSettings = merge(tmpSettings, fileContent);
            }
        });
        return tmpSettings;
    }

    var base = { server: { cache: { enable: false, ttl: 3600 }, engine: 'isaac' }, region: { culture: 'en_US' } };
    var prod = { server: { cache: { enable: true } } };

    it('BEHAVIOUR: settings.json first, then settings.prod.json → prod wins on the shared key, the rest survives', function() {
        var out = replay([{ env: false, content: base }, { env: true, content: prod }]);
        assert.strictEqual(out.server.cache.enable, true);
        assert.strictEqual(out.server.cache.ttl, 3600);
        assert.strictEqual(out.server.engine, 'isaac');
        assert.strictEqual(out.region.culture, 'en_US');
    });

    it('BEHAVIOUR: settings.prod.json first, then settings.json → the same result (order-independent)', function() {
        var out = replay([{ env: true, content: prod }, { env: false, content: base }]);
        assert.strictEqual(out.server.cache.enable, true);
        assert.strictEqual(out.server.cache.ttl, 3600);
        assert.strictEqual(out.server.engine, 'isaac');
    });

    it('CONTROL: with the env file merged as the SOURCE (the pre-#B784 form), settings.json would win when read first', function() {
        var tmp = merge(JSON.parse(JSON.stringify(base)), JSON.parse(JSON.stringify(prod)));
        assert.strictEqual(tmp.server.cache.enable, false, 'lib/merge is fill-only: the target wins');
    });
});
