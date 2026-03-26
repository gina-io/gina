/**
 * #R5 — init.js short-version migration
 *
 * Why source inspection + simulation instead of requiring the module:
 *   init.js calls lib.logger, getPath('gina'), lib.Domain, etc. which are
 *   injected globals only present inside a running gina process. Loading it
 *   in a bare node:test context is not practical.
 *
 *   These tests cover:
 *     (a) source structure — both migration blocks are present and well-formed
 *     (b) checkIfMain migration — pure data transformation simulated inline
 *     (c) checkIfSettings migration — env-var seeding logic simulated inline
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it, beforeEach } = require('node:test');
var assert = require('node:assert/strict');

var SOURCE_PATH = path.resolve(
    __dirname,
    '../../framework/v0.1.8-alpha.1/lib/cmd/framework/init.js'
);
var src = fs.readFileSync(SOURCE_PATH, 'utf8');


// ─── helpers ─────────────────────────────────────────────────────────────────

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Inline simulation of the checkIfMain migration block.
 * Mirrors the exact logic in init.js:
 *   - finds the most recent previous short version via parseFloat
 *   - copies all namespaced keys (objects whose subkey matches prevShort)
 *   - skips '_comment' and 'def_framework'
 *   - seeds frameworks[release] from the template data entry
 */
function runMainMigration(mainConfig, release, templateData) {
    if (typeof(mainConfig['frameworks'][release]) !== 'undefined') {
        return mainConfig; // no migration needed
    }

    var _prevShort = null;
    for (var _fk in mainConfig['frameworks']) {
        if (_fk === '_comment') continue;
        if (!_prevShort || parseFloat(_fk) > parseFloat(_prevShort)) _prevShort = _fk;
    }

    if (_prevShort) {
        for (var _mk in mainConfig) {
            if (_mk === '_comment' || _mk === 'def_framework') continue;
            var _mv = mainConfig[_mk];
            if (_mv !== null && typeof _mv === 'object' && !Array.isArray(_mv) && typeof(_mv[_prevShort]) !== 'undefined') {
                mainConfig[_mk][release] = clone(_mv[_prevShort]);
            }
        }
        mainConfig['frameworks'][release] = clone(templateData['frameworks'][release] || []);
    }

    return mainConfig;
}

/**
 * Inline simulation of the checkIfSettings migration block.
 * Mirrors the env-var seeding logic in init.js.
 * Returns the set of env-var keys that would be assigned, keyed by env-var name.
 */
function runSettingsMigration(mainFrameworks, release, prevSettingsContent, currentEnvVars) {
    var envVars = Object.assign({}, currentEnvVars || {});

    var _prevShort = null;
    for (var _sfk in mainFrameworks) {
        if (_sfk === '_comment' || _sfk === release) continue;
        if (!_prevShort || parseFloat(_sfk) > parseFloat(_prevShort)) {
            _prevShort = _sfk;
        }
    }

    if (_prevShort && prevSettingsContent) {
        var _map = {
            'port'       : 'GINA_PORT',
            'debug_port' : 'GINA_DEBUG_PORT',
            'mq_port'    : 'GINA_MQ_PORT',
            'host_v4'    : 'GINA_HOST_V4',
            'hostname'   : 'GINA_HOSTNAME'
        };
        for (var _smk in _map) {
            if (!envVars[_map[_smk]] && typeof(prevSettingsContent[_smk]) !== 'undefined') {
                envVars[_map[_smk]] = prevSettingsContent[_smk];
            }
        }
    }

    return { envVars: envVars, prevShort: _prevShort };
}


// ─── fixtures ─────────────────────────────────────────────────────────────────

function makeMainConfig(release) {
    var cfg = {
        'frameworks'     : {},
        'def_framework'  : '0.1.8-alpha.1',
        'def_prefix'     : {},
        'def_global_mode': {},
        'archs'          : {},
        'def_arch'       : {},
        'platforms'      : {},
        'def_platform'   : {},
        'scopes'         : {},
        'def_scope'      : {},
        'local_scope'    : {},
        'production_scope': {},
        'envs'           : {},
        'def_env'        : {},
        'dev_env'        : {},
        'protocols'      : { '_comment': 'e.g. http/1.1, http/2.0' },
        'def_protocol'   : {},
        'schemes'        : { '_comment': 'e.g. http, https' },
        'def_scheme'     : {},
        'cultures'       : { '_comment': 'e.g. en_CM' },
        'def_culture'    : {},
        'def_iso_short'  : {},
        'def_timezone'   : {},
        'def_date'       : {},
        'log_levels'     : { '_comment': 'hierarchy' },
        'def_log_level'  : {}
    };
    // seed with the existing release data
    cfg['frameworks'][release]       = ['0.1.8-alpha.1'];
    cfg['def_prefix'][release]       = '/usr/local';
    cfg['def_global_mode'][release]  = false;
    cfg['archs'][release]            = ['arm64', 'x64'];
    cfg['def_arch'][release]         = 'arm64';
    cfg['platforms'][release]        = ['darwin', 'linux'];
    cfg['def_platform'][release]     = 'darwin';
    cfg['scopes'][release]           = ['local', 'production'];
    cfg['def_scope'][release]        = 'local';
    cfg['local_scope'][release]      = 'local';
    cfg['production_scope'][release] = 'production';
    cfg['envs'][release]             = ['dev', 'prod'];
    cfg['def_env'][release]          = 'dev';
    cfg['dev_env'][release]          = 'dev';
    cfg['protocols'][release]        = ['http/1.1', 'http/2.0'];
    cfg['def_protocol'][release]     = 'http/1.1';
    cfg['schemes'][release]          = ['http', 'https'];
    cfg['def_scheme'][release]       = 'http';
    cfg['cultures'][release]         = ['en_CM', 'fr_CM'];
    cfg['def_culture'][release]      = 'en_CM';
    cfg['def_iso_short'][release]    = 'en';
    cfg['def_timezone'][release]     = 'Africa/Douala';
    cfg['def_date'][release]         = 'dd/mm/yyyy';
    cfg['log_levels'][release]       = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    cfg['def_log_level'][release]    = 'info';
    return cfg;
}

function makeTemplateData(newRelease, newVersion) {
    return {
        'frameworks': { [newRelease]: [newVersion] }
    };
}

var prevSettings = {
    port: 8124, debug_port: 9229, mq_port: 8125,
    host_v4: '10.0.0.5', hostname: 'my-server.local'
};


// ─── (a) source structure ────────────────────────────────────────────────────

describe('init.js migration — source structure', function() {

    it('checkIfMain migration block is present', function() {
        assert.ok(
            src.indexOf("mainConfig['frameworks'][self.release]) === 'undefined'") > -1,
            'expected migration guard in checkIfMain'
        );
    });

    it('checkIfMain migration copies namespaced keys via JSON.clone', function() {
        assert.ok(
            src.indexOf('JSON.clone(_mv[_prevShort])') > -1,
            'expected JSON.clone copy of previous short version keys'
        );
    });

    it('checkIfMain migration skips def_framework', function() {
        assert.ok(
            src.indexOf("_mk === 'def_framework'") > -1,
            'expected def_framework exclusion in migration loop'
        );
    });

    it('checkIfMain seeds frameworks[newRelease] from template data', function() {
        assert.ok(
            src.indexOf("data['frameworks'][self.release]") > -1,
            'expected template data seed for new frameworks entry'
        );
    });

    it('checkIfSettings migration block is present', function() {
        assert.ok(
            src.indexOf('_prevShortForSettings') > -1,
            'expected settings migration block in checkIfSettings'
        );
    });

    it('checkIfSettings migration map covers all five networking keys', function() {
        ['port', 'debug_port', 'mq_port', 'host_v4', 'hostname'].forEach(function(key) {
            assert.ok(
                src.indexOf("'" + key + "'") > -1,
                'expected key ' + key + ' in settings migration map'
            );
        });
    });

    it('checkIfSettings env var assignments are gated on !getEnvVar', function() {
        assert.ok(
            src.indexOf('!getEnvVar(_settingsMigrationMap[_smk])') > -1,
            'expected env-var gate in settings migration loop'
        );
    });

});


// ─── (b) checkIfMain migration — behavioural ─────────────────────────────────

describe('init.js checkIfMain migration — behaviour', function() {

    it('does nothing when the release key already exists', function() {
        var cfg = makeMainConfig('0.1');
        var before = clone(cfg);
        runMainMigration(cfg, '0.1', makeTemplateData('0.1', '0.1.8-alpha.1'));
        assert.deepEqual(cfg, before);
    });

    it('adds the new release key when upgrading 0.1 → 0.2', function() {
        var cfg = makeMainConfig('0.1');
        runMainMigration(cfg, '0.2', makeTemplateData('0.2', '0.2.0-alpha.1'));
        assert.ok(typeof cfg['frameworks']['0.2'] !== 'undefined', 'frameworks["0.2"] should exist');
    });

    it('copies all namespaced keys from 0.1 to 0.2', function() {
        var cfg = makeMainConfig('0.1');
        runMainMigration(cfg, '0.2', makeTemplateData('0.2', '0.2.0-alpha.1'));

        var namespacedKeys = [
            'def_prefix', 'def_global_mode', 'archs', 'def_arch',
            'platforms', 'def_platform', 'scopes', 'def_scope',
            'local_scope', 'production_scope', 'envs', 'def_env', 'dev_env',
            'protocols', 'def_protocol', 'schemes', 'def_scheme',
            'cultures', 'def_culture', 'def_iso_short', 'def_timezone',
            'def_date', 'log_levels', 'def_log_level'
        ];
        namespacedKeys.forEach(function(key) {
            assert.ok(
                typeof cfg[key]['0.2'] !== 'undefined',
                key + '["0.2"] should be present after migration'
            );
        });
    });

    it('copied values equal the source values', function() {
        var cfg = makeMainConfig('0.1');
        runMainMigration(cfg, '0.2', makeTemplateData('0.2', '0.2.0-alpha.1'));
        assert.equal(cfg['def_culture']['0.2'], 'en_CM');
        assert.equal(cfg['def_scope']['0.2'], 'local');
        assert.equal(cfg['def_iso_short']['0.2'], 'en');
        assert.deepEqual(cfg['archs']['0.2'], ['arm64', 'x64']);
    });

    it('does not overwrite def_framework', function() {
        var cfg = makeMainConfig('0.1');
        runMainMigration(cfg, '0.2', makeTemplateData('0.2', '0.2.0-alpha.1'));
        assert.equal(cfg['def_framework'], '0.1.8-alpha.1');
    });

    it('_comment subkeys are preserved in objects that have them', function() {
        var cfg = makeMainConfig('0.1');
        runMainMigration(cfg, '0.2', makeTemplateData('0.2', '0.2.0-alpha.1'));
        assert.equal(cfg['protocols']['_comment'], 'e.g. http/1.1, http/2.0');
        assert.equal(cfg['schemes']['_comment'], 'e.g. http, https');
    });

    it('frameworks[0.2] is seeded from template, not copied from 0.1', function() {
        var cfg = makeMainConfig('0.1');
        runMainMigration(cfg, '0.2', makeTemplateData('0.2', '0.2.0-alpha.1'));
        assert.deepEqual(cfg['frameworks']['0.2'], ['0.2.0-alpha.1']);
        // original 0.1 entry is untouched
        assert.deepEqual(cfg['frameworks']['0.1'], ['0.1.8-alpha.1']);
    });

    it('handles multi-hop: 0.1 and 0.2 both present, migrating to 0.3', function() {
        var cfg = makeMainConfig('0.1');
        // simulate 0.2 already migrated
        runMainMigration(cfg, '0.2', makeTemplateData('0.2', '0.2.0-alpha.1'));
        cfg['def_culture']['0.2'] = 'fr_FR'; // user customised 0.2

        // now migrate to 0.3 — should copy from 0.2 (most recent)
        runMainMigration(cfg, '0.3', makeTemplateData('0.3', '0.3.0-alpha.1'));
        assert.equal(cfg['def_culture']['0.3'], 'fr_FR',
            'should have migrated from 0.2 (most recent), not 0.1');
    });

    it('handles major version bump: 0.5 → 1.0', function() {
        var cfg = makeMainConfig('0.5');
        cfg['frameworks']['0.5'] = ['0.5.0'];
        runMainMigration(cfg, '1.0', makeTemplateData('1.0', '1.0.0'));
        assert.ok(typeof cfg['frameworks']['1.0'] !== 'undefined');
        assert.equal(cfg['def_culture']['1.0'], 'en_CM');
    });

    it('copied values are independent clones — mutating new release does not affect old', function() {
        var cfg = makeMainConfig('0.1');
        runMainMigration(cfg, '0.2', makeTemplateData('0.2', '0.2.0-alpha.1'));
        cfg['archs']['0.2'].push('s390x');
        assert.deepEqual(cfg['archs']['0.1'], ['arm64', 'x64'],
            '0.1 archs must not be affected by mutation of 0.2 copy');
    });

});


// ─── (c) checkIfSettings migration — behavioural ─────────────────────────────

describe('init.js checkIfSettings migration — behaviour', function() {

    it('identifies the correct previous short version (0.1 → 0.2)', function() {
        var frameworks = { '0.1': ['0.1.8-alpha.1'], '0.2': ['0.2.0-alpha.1'] };
        var result = runSettingsMigration(frameworks, '0.2', prevSettings, {});
        assert.equal(result.prevShort, '0.1');
    });

    it('identifies the correct previous short version in multi-hop (0.3 with 0.1 and 0.2 present)', function() {
        var frameworks = {
            '0.1': ['0.1.8-alpha.1'],
            '0.2': ['0.2.0-alpha.1'],
            '0.3': ['0.3.0-alpha.1']
        };
        var result = runSettingsMigration(frameworks, '0.3', prevSettings, {});
        assert.equal(result.prevShort, '0.2', 'should pick 0.2 as the most recent prior release');
    });

    it('seeds all five networking env vars from previous settings', function() {
        var frameworks = { '0.1': ['0.1.8-alpha.1'], '0.2': ['0.2.0-alpha.1'] };
        var result = runSettingsMigration(frameworks, '0.2', prevSettings, {});
        assert.equal(result.envVars['GINA_PORT'],       8124);
        assert.equal(result.envVars['GINA_DEBUG_PORT'], 9229);
        assert.equal(result.envVars['GINA_MQ_PORT'],    8125);
        assert.equal(result.envVars['GINA_HOST_V4'],    '10.0.0.5');
        assert.equal(result.envVars['GINA_HOSTNAME'],   'my-server.local');
    });

    it('does not overwrite env vars that are already set', function() {
        var frameworks = { '0.1': ['0.1.8-alpha.1'], '0.2': ['0.2.0-alpha.1'] };
        var existing = { 'GINA_PORT': 9999 };
        var result = runSettingsMigration(frameworks, '0.2', prevSettings, existing);
        assert.equal(result.envVars['GINA_PORT'], 9999,
            'pre-existing GINA_PORT must not be overwritten');
        assert.equal(result.envVars['GINA_HOSTNAME'], 'my-server.local',
            'unset env vars are still seeded');
    });

    it('does nothing when there is no previous short version (first install)', function() {
        var frameworks = { '0.1': ['0.1.8-alpha.1'] };
        var result = runSettingsMigration(frameworks, '0.1', null, {});
        assert.equal(result.prevShort, null);
        assert.deepEqual(result.envVars, {});
    });

    it('handles major version bump: 0.5 → 1.0', function() {
        var frameworks = { '0.5': ['0.5.0'], '1.0': ['1.0.0'] };
        var result = runSettingsMigration(frameworks, '1.0', prevSettings, {});
        assert.equal(result.prevShort, '0.5');
        assert.equal(result.envVars['GINA_PORT'], 8124);
    });

});
