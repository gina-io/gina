/**
 * lib/cmd/secrets/{scan,check}.js — argv parsing, manifest-driven config
 * resolution, placeholder enumeration, env cross-reference, exit codes,
 * text + JSON output.
 *
 * Source-inspection tests (same style as i18n-scan.test.js): the handlers
 * run inside the CLI daemon context (CmdHelper, project registry, globals
 * injected by gna.js). Replicating that is heavy for near-zero extra
 * coverage, so these assertions prove the source structure of:
 *
 *   (a) module shape + CmdHelper wiring (scan + check)
 *   (b) argv loop — `--format=<x>` capture, CmdHelper-driven project/bundle
 *   (c) config resolution — manifest `src`, JSON glob, shared/config merge
 *   (d) pure-logic placeholder enumeration (real lib.secrets + aggregation)
 *   (e) check exit-code logic — fail-closed `isEnvSet`, anyUnset
 *   (f) JSON + text output shape
 *   (g) help.js + help.txt + arguments.json
 *   (h) bin/cli wiring (secrets: in allowedOffline)
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW           = require('../fw');
var SCAN_SOURCE  = path.join(FW, 'lib/cmd/secrets/scan.js');
var CHECK_SOURCE = path.join(FW, 'lib/cmd/secrets/check.js');
var HELP_SOURCE  = path.join(FW, 'lib/cmd/secrets/help.js');
var HELP_TXT     = path.join(FW, 'lib/cmd/secrets/help.txt');
var ARGS_FILE    = path.join(FW, 'lib/cmd/secrets/arguments.json');
var CLI_SOURCE   = path.join(__dirname, '..', '..', 'bin', 'cli');
var SECRETS_LIB  = path.join(FW, 'lib/secrets');

var scanSrc  = fs.readFileSync(SCAN_SOURCE, 'utf8');
var checkSrc = fs.readFileSync(CHECK_SOURCE, 'utf8');
var helpSrc  = fs.readFileSync(HELP_SOURCE, 'utf8');
var helpTxt  = fs.readFileSync(HELP_TXT, 'utf8');
var argsArr  = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8'));
var cliSrc   = fs.readFileSync(CLI_SOURCE, 'utf8');
var secrets  = require(SECRETS_LIB);
var merge    = require(path.join(FW, 'lib/merge'));   // also sets JSON.clone if undefined

// Handlers that share the project/bundle-resolution skeleton.
var HANDLERS = [['scan', scanSrc], ['check', checkSrc]];


// ---------------------------------------------------------------------------
// 01 — Module shape (scan + check)
// ---------------------------------------------------------------------------

describe('01 - module shape', function () {

    it('scan.js exports the Scan constructor', function () {
        assert.match(scanSrc, /module\.exports\s*=\s*Scan;?/);
        assert.match(scanSrc, /function\s+Scan\s*\(\s*opt\s*,\s*cmd\s*\)\s*\{/);
    });

    it('check.js exports the Check constructor', function () {
        assert.match(checkSrc, /module\.exports\s*=\s*Check;?/);
        assert.match(checkSrc, /function\s+Check\s*\(\s*opt\s*,\s*cmd\s*\)\s*\{/);
    });

    HANDLERS.forEach(function (h) {
        var name = h[0], src = h[1];

        it(name + '.js requires CmdHelper from ./../helper', function () {
            assert.match(src, /var\s+CmdHelper\s*=\s*require\(\s*['"]\.\/?\.\.\/helper['"]/);
        });

        it(name + '.js binds console = lib.logger', function () {
            assert.match(src, /var\s+console\s*=\s*lib\.logger/);
        });

        it(name + '.js consumes the secrets primitive via the lib registry (var secrets = lib.secrets)', function () {
            assert.match(src, /var\s+secrets\s*=\s*lib\.secrets;/);
            // Must NOT use the bare-module form, which does not resolve in cmd daemon scope.
            assert.equal(/require\(\s*['"]lib\/secrets['"]\s*\)/.test(src), false);
        });

        it(name + '.js initialises self.format = "text"', function () {
            assert.match(src, /var\s+self\s*=\s*\{\s*format:\s*['"]text['"]/);
        });

        it(name + '.js calls init() at the bottom of the constructor', function () {
            assert.match(src, new RegExp('init\\(\\);\\s*\\}\\s*module\\.exports\\s*=\\s*' + (name === 'scan' ? 'Scan' : 'Check')));
        });
    });

    it('check.js seeds self.anyUnset = false (exit-code accumulator)', function () {
        assert.match(checkSrc, /anyUnset:\s*false/);
        assert.match(checkSrc, /self\.anyUnset\s*=\s*false;/);
    });
});


// ---------------------------------------------------------------------------
// 02 — argv parsing & dispatch (shared skeleton)
// ---------------------------------------------------------------------------

describe('02 - argv parsing & dispatch', function () {

    HANDLERS.forEach(function (h) {
        var name = h[0], src = h[1];

        it(name + '.js instantiates CmdHelper with debugPort + brkEnabled', function () {
            assert.match(src, /new\s+CmdHelper\(\s*self,\s*opt\.client,\s*\{\s*port:\s*opt\.debugPort,\s*brkEnabled:\s*opt\.debugBrkEnabled\s*\}\s*\)/);
        });

        it(name + '.js gates execution on isCmdConfigured()', function () {
            assert.match(src, /if\s*\(\s*!isCmdConfigured\(\)\s*\)\s*return\s+false/);
        });

        it(name + '.js iterates process.argv from index 3', function () {
            assert.match(src, /for\s*\(\s*var\s+i\s*=\s*3\s*,/);
        });

        it(name + '.js captures --format=<x> from argv', function () {
            assert.match(src, /\/\^\\-\\-format\\=\/\.test\(arg\)/);
            assert.match(src, /self\.format\s*=\s*arg\.split\(\/\\=\/\)\[1\]/);
        });

        it(name + '.js rejects --format values other than text or json', function () {
            assert.match(src, /self\.format\s*!==\s*['"]text['"]\s*&&\s*self\.format\s*!==\s*['"]json['"]/);
            assert.match(src, /--format must be `text` or `json`/);
        });

        it(name + '.js errors when a bundle filter is given without @<project>', function () {
            assert.match(src, /requires\s*`@<project>`/);
        });

        it(name + '.js errors when the project is not registered', function () {
            assert.match(src, /is not registered/);
        });

        it(name + '.js validates the bundle exists in the manifest', function () {
            assert.match(src, /manifest\.bundles\s*&&\s*!manifest\.bundles\[bundleFilter\]/);
        });
    });

    it('scan.js routes to scanAll / scanProjectOnly / scanBundleOnly', function () {
        assert.match(scanSrc, /scanAll\(\);/);
        assert.match(scanSrc, /scanProjectOnly\(self\.projectName\)/);
        assert.match(scanSrc, /scanBundleOnly\(self\.projectName,\s*bundleFilter\)/);
    });

    it('check.js routes to checkAll / checkProjectOnly / checkBundleOnly', function () {
        assert.match(checkSrc, /checkAll\(\);/);
        assert.match(checkSrc, /checkProjectOnly\(self\.projectName\)/);
        assert.match(checkSrc, /checkBundleOnly\(self\.projectName,\s*bundleFilter\)/);
    });

    it('scan.js exits 0 on the success path', function () {
        assert.match(scanSrc, /process\.exit\(0\);/);
    });

    it('check.js exits non-zero when any required key is unset', function () {
        // Two exit sites: the no-project (checkAll) branch and the project/bundle branch.
        // #B409 realignment (approved) — the expression widened to
        // (anyUnset || anyError): a declaration error means the runtime
        // refuses the boot, so the gate fails on it too instead of exiting 0
        // whenever the environment happened to carry the keys. The widened
        // behaviour has its own pins in secrets-exec-backend.test.js §09;
        // this test keeps its original claim: unset ⇒ non-zero.
        var matches = checkSrc.match(/process\.exit\(\(\s*self\.anyUnset\s*\|\|\s*self\.anyError\s*\)\s*\?\s*1\s*:\s*0\s*\)/g) || [];
        assert.ok(matches.length >= 2, 'expected >= 2 anyUnset-driven exit sites, found ' + matches.length);
    });
});


// ---------------------------------------------------------------------------
// 03 — config-dir resolution (manifest src + JSON glob + shared/config)
// ---------------------------------------------------------------------------

describe('03 - config-dir resolution (delegated to the shared walk)', function () {

    // The walk itself (manifest src resolution, JSON_EXT globbing, dotfile /
    // "* copy" skips, shared/config folding, requireJSON reads, key
    // enumeration, scope-sibling overlay) moved to lib/secrets' sources
    // module; its structural pins moved with it — see
    // test/lib/secrets-sources.test.js §02. What the HANDLERS own now is the
    // delegation: consume the one shared implementation, keep no local copy.
    // (#B263 is the incident that motivated the single home: two hand-kept
    // copies of "which sources does a bundle read" drifted.)

    /**
     * Code-only view for the negative pins below: drops comment lines and
     * trailing line comments, so prose that legitimately NAMES a forbidden
     * construct (to explain why the handler avoids it) cannot trip them.
     */
    function stripComments(src) {
        return src.split('\n').filter(function (l) {
            return !/^\s*(\/\/|\*|\/\*)/.test(l);
        }).map(function (l) {
            return l.replace(/\/\/.*$/, '');
        }).join('\n');
    }

    HANDLERS.forEach(function (h) {
        var name = h[0], src = h[1];

        it(name + '.js delegates the config-source walk to lib.secrets (getProjectRequiredKeys)', function () {
            assert.match(src, /secrets\.getProjectRequiredKeys\(/);
        });

        it(name + '.js reads the manifest through the shared implementation (secrets.loadManifest)', function () {
            assert.match(src, /secrets\.loadManifest\(/);
        });

        it(name + '.js keeps no local copy of the walk (code view)', function () {
            var code = stripComments(src);
            // anti-vacuity: the stripped view still holds the handler's real code
            assert.ok(code.indexOf('var secrets = lib.secrets;') > -1,
                'stripping emptied the corpus - the negatives below would pass vacuously');
            assert.equal(/readdirSync/.test(code), false, name + '.js still globs config dirs locally');
            assert.equal(/requireJSON\(/.test(code), false, name + '.js still parses config JSON locally');
            assert.equal(/getRequiredKeys\(effective\)/.test(code), false, name + '.js still enumerates keys locally');
        });
    });
});


// ---------------------------------------------------------------------------
// 04 — pure-logic placeholder enumeration (real lib.secrets + aggregation)
// ---------------------------------------------------------------------------

describe('04 - placeholder enumeration', function () {

    // Replica of scan.js collectFromConfigDir aggregation over an in-memory
    // { filename: confObject } map, using the REAL lib.secrets.getRequiredKeys.
    function aggregate(filesByName, relBase) {
        var byKey = Object.create(null);
        var names = Object.keys(filesByName).sort();
        for (var i = 0; i < names.length; i++) {
            var keys  = secrets.getRequiredKeys(filesByName[names[i]]);
            var label = relBase + '/' + names[i];
            for (var k = 0; k < keys.length; k++) {
                if (!byKey[keys[k]]) byKey[keys[k]] = [];
                if (byKey[keys[k]].indexOf(label) < 0) byKey[keys[k]].push(label);
            }
        }
        return byKey;
    }

    it('aggregates KEY -> originating file(s)', function () {
        var byKey = aggregate({
            'connectors.json': { db: { password: '${secret:DB_PASSWORD}' } },
            'settings.json'  : { api: { key: '${secret:API_KEY}' } }
        }, 'src/demo/config');
        assert.deepStrictEqual(byKey['DB_PASSWORD'], ['src/demo/config/connectors.json']);
        assert.deepStrictEqual(byKey['API_KEY'], ['src/demo/config/settings.json']);
    });

    it('lists multiple files for a key used in more than one config', function () {
        var byKey = aggregate({
            'a.json': { x: '${secret:SHARED}' },
            'b.json': { y: '${secret:SHARED}' }
        }, 'src/demo/config');
        assert.deepStrictEqual(byKey['SHARED'].sort(), ['src/demo/config/a.json', 'src/demo/config/b.json']);
    });

    it('excludes mixed-content placeholders from the aggregate', function () {
        var byKey = aggregate({
            'settings.json': { key: '${secret:API_KEY}', url: 'https://${secret:API_KEY}/v1' }
        }, 'src/demo/config');
        assert.deepStrictEqual(Object.keys(byKey), ['API_KEY']);
        assert.equal(byKey['API_KEY'].length, 1);
    });

    it('shared/config keys merge into a bundle (loader merges shared into every bundle)', function () {
        var shared = aggregate({ 'app.json': { t: '${secret:SHARED_TOKEN}' } }, 'shared/config');
        var bundle = Object.create(null);
        for (var sk in shared) { bundle[sk] = shared[sk].slice(); }
        var own = aggregate({ 'connectors.json': { db: '${secret:DB_PASSWORD}' } }, 'src/demo/config');
        for (var ok in own) { bundle[ok] = (bundle[ok] || []).concat(own[ok]); }
        assert.deepStrictEqual(Object.keys(bundle).sort(), ['DB_PASSWORD', 'SHARED_TOKEN']);
        assert.deepStrictEqual(bundle['SHARED_TOKEN'], ['shared/config/app.json']);
    });

    it('empty config dir contributes nothing', function () {
        assert.deepStrictEqual(aggregate({}, 'src/demo/config'), Object.create(null));
    });
});


// ---------------------------------------------------------------------------
// 05 — check exit-code logic (fail-closed isEnvSet + anyUnset)
// ---------------------------------------------------------------------------

describe('05 - check fail-closed env logic', function () {

    // Replica of check.js isEnvSet — a key is "set" only when it is a
    // non-empty string, the same condition under which the env backend
    // resolves successfully.
    function isEnvSet(env, key) {
        return typeof env[key] === 'string' && env[key] !== '';
    }

    it('non-empty string is SET', function () {
        assert.equal(isEnvSet({ K: 'value' }, 'K'), true);
        assert.equal(isEnvSet({ K: '0' }, 'K'), true);
        assert.equal(isEnvSet({ K: ' ' }, 'K'), true);
    });

    it('unset is UNSET', function () {
        assert.equal(isEnvSet({}, 'K'), false);
    });

    it('empty string is UNSET (fail-closed, matches env backend)', function () {
        assert.equal(isEnvSet({ K: '' }, 'K'), false);
    });

    it('anyUnset flips true on the first missing key (CI gate)', function () {
        var env = { A: 'x', C: 'z' };       // B missing
        var keys = ['A', 'B', 'C'];
        var anyUnset = false;
        var set = 0;
        for (var i = 0; i < keys.length; i++) {
            if (isEnvSet(env, keys[i])) { set++; } else { anyUnset = true; }
        }
        assert.equal(set, 2);
        assert.equal(anyUnset, true);
    });

    it('anyUnset stays false when every key is set', function () {
        var env = { A: 'x', B: 'y' };
        var keys = ['A', 'B'];
        var anyUnset = false;
        for (var i = 0; i < keys.length; i++) {
            if (!isEnvSet(env, keys[i])) anyUnset = true;
        }
        assert.equal(anyUnset, false);
    });

    it('check.js source defines isEnvSet against the active env source (env-file map or process.env)', function () {
        assert.match(checkSrc, /var\s+source\s*=\s*self\.envMap\s*\|\|\s*process\.env/);
        assert.match(checkSrc, /typeof\s+source\[key\]\s*===\s*['"]string['"]\s*&&\s*source\[key\]\s*!==\s*['"]['"]/);
    });

    it('check.js flips self.anyUnset when a key is not set', function () {
        assert.match(checkSrc, /self\.anyUnset\s*=\s*true/);
    });
});


// ---------------------------------------------------------------------------
// 06 — output structure
// ---------------------------------------------------------------------------

describe('06 - report output', function () {

    HANDLERS.forEach(function (h) {
        var name = h[0], src = h[1];

        it(name + '.js emits JSON via JSON.stringify(report, null, 2)', function () {
            assert.match(src, /JSON\.stringify\(report,\s*null,\s*2\)/);
        });

        it(name + '.js text path branches on report.projects vs single project', function () {
            assert.match(src, /report\.projects[\s\S]{0,40}\?[\s\S]{0,80}:[\s\S]{0,120}\[\s*\{\s*project:\s*report\.project,\s*bundles:\s*report\.bundles\s*\}\s*\]/);
        });

        it(name + '.js text output prefixes project lines with `@<name>:` (with optional scope/env suffix)', function () {
            assert.match(src, /'\\n@'\s*\+\s*proj\.project/);
        });

        it(name + '.js text output reports `(no bundles)` for empty projects', function () {
            assert.match(src, /\(no bundles\)/);
        });

        it(name + '.js text output reports the no-placeholder case', function () {
            assert.match(src, /No \$\{secret:KEY\} placeholders found in config\./);
        });
    });

    it('scan.js bundle report shape — bundle, totalKeys, byKey', function () {
        ['bundle', 'totalKeys', 'byKey'].forEach(function (field) {
            assert.match(scanSrc, new RegExp(field + '\\s*:'));
        });
    });

    it('scan.js text output labels the required-secrets block', function () {
        assert.match(scanSrc, /Required secrets \(/);
    });

    it('check.js bundle report shape — bundle, totalKeys, set, unset, keys', function () {
        ['bundle', 'totalKeys', 'set', 'unset', 'keys'].forEach(function (field) {
            assert.match(checkSrc, new RegExp(field + '\\s*:'));
        });
    });

    it('check.js text output prints SET / UNSET and a per-bundle summary', function () {
        assert.match(checkSrc, /'SET'/);
        assert.match(checkSrc, /'UNSET'/);
        assert.match(checkSrc, /required:/);
    });
});


// ---------------------------------------------------------------------------
// 07 — help + arguments
// ---------------------------------------------------------------------------

describe('07 - help + arguments', function () {

    it('help.js exports the Help constructor', function () {
        assert.match(helpSrc, /module\.exports\s*=\s*Help;?/);
    });

    it('help.js calls getHelp() to print group help', function () {
        assert.match(helpSrc, /getHelp\(\);/);
    });

    it('help.txt documents the secrets: usage line', function () {
        assert.match(helpTxt, /Usage:\s*gina\s+secrets:/);
    });

    it('help.txt documents the scan, check and help actions', function () {
        ['scan', 'check', 'help'].forEach(function (action) {
            assert.match(helpTxt, new RegExp('\\b' + action + '\\b'));
        });
    });

    it('help.txt documents the honest caveats (process.env scope + authored-on-disk)', function () {
        assert.match(helpTxt, /process\.env|environment of THIS CLI process/i);
        assert.match(helpTxt, /authored on disk|not the merged\s+runtime config/i);
    });

    it('help.txt links to the secrets guide', function () {
        assert.match(helpTxt, /gina\.io\/docs\/guides\/secrets/);
    });

    it('arguments.json includes --format, --scope, --env-file', function () {
        ['--format', '--scope', '--env-file'].forEach(function (flag) {
            assert.ok(argsArr.indexOf(flag) > -1, 'expected ' + flag + ' in arguments.json');
        });
    });

    it('arguments.json avoids framework-reserved flag names', function () {
        // NB: --scope and --env are legitimate scope/env group flags (bundle:* declares
        // both); the forbidden set here is node/framework-infra flags only.
        var reserved = ['--port', '--mq-port', '--host-v4', '--hostname', '--debug-port',
                        '--inspect', '--inspect-brk', '--debug', '--version',
                        '--prefix', '--gina-version'];
        reserved.forEach(function (flag) {
            assert.equal(argsArr.indexOf(flag), -1, 'arguments.json must not contain reserved flag ' + flag);
        });
    });
});


// ---------------------------------------------------------------------------
// 08 — bin/cli wiring
// ---------------------------------------------------------------------------

describe('08 - bin/cli wiring', function () {

    it("bin/cli adds 'secrets:' to the allowedOffline array", function () {
        var m = cliSrc.match(/var\s+allowedOffline\s*=\s*\[([\s\S]*?)\]/);
        assert.ok(m, 'allowedOffline array not found in bin/cli');
        assert.match(m[1], /['"]secrets:['"]/);
    });

    it("'secrets:' is positioned alphabetically (between scheme: and service:)", function () {
        var m = cliSrc.match(/var\s+allowedOffline\s*=\s*\[([\s\S]*?)\]/);
        var listed       = m[1];
        var schemeIdx    = listed.indexOf("'scheme:'");
        var secretsIdx   = listed.indexOf("'secrets:'");
        var serviceIdx   = listed.indexOf("'service:'");
        assert.ok(schemeIdx > -1 && secretsIdx > -1 && serviceIdx > -1, 'one or more expected entries missing');
        assert.ok(schemeIdx < secretsIdx, "'secrets:' must come after 'scheme:'");
        assert.ok(secretsIdx < serviceIdx, "'secrets:' must come before 'service:'");
    });
});


// ---------------------------------------------------------------------------
// 09 — --scope overlay (config_<scope>/ deep-merge) + --env-file
// ---------------------------------------------------------------------------

describe('09 - scope overlay + env-file', function () {

    // Replica of the collectFromConfigDir scope overlay using the REAL lib.merge:
    // scope content deep-merges over base (scope wins on leaf collisions, base
    // back-fills omitted keys), then getRequiredKeys on the effective config.
    function effectiveKeys(baseContent, scopeContent) {
        var effective = scopeContent
            ? merge(JSON.clone(scopeContent), baseContent || {}, false)
            : baseContent;
        return secrets.getRequiredKeys(effective || {});
    }

    it('scope overlay swaps a base secret key for the scope one (scope wins on the leaf)', function () {
        var base  = { db: { password: '${secret:LOCAL_DB}', host: 'localhost' } };
        var scope = { db: { password: '${secret:PROD_DB}',  host: 'prod' } };
        assert.deepStrictEqual(effectiveKeys(base, scope), ['PROD_DB']);   // LOCAL_DB overridden → gone
    });

    it('scope overlay back-fills base-only secret keys the scope file omits', function () {
        var base  = { db: { password: '${secret:DB_PW}' }, cache: { token: '${secret:CACHE_PW}' } };
        var scope = { db: { password: '${secret:PROD_DB_PW}' } };          // omits cache
        assert.deepStrictEqual(effectiveKeys(base, scope), ['CACHE_PW', 'PROD_DB_PW']);  // cache survives
    });

    it('no scope content → base keys unchanged', function () {
        assert.deepStrictEqual(effectiveKeys({ db: { password: '${secret:DB_PW}' } }, null), ['DB_PW']);
    });

    // Replica of lib/secrets/src/env-file.js `parseEnv` (which `check.js` now
    // delegates to — it no longer parses inline). Kept in sync deliberately:
    // this file asserts the SCAN's view of an env file, so a drift here would
    // make these assertions describe a parser the runtime does not use.
    // Includes the #B269 inline-comment strip.
    function stripInlineComment(raw) {
        var quote = null;
        for (var i = 0; i < raw.length; i++) {
            var ch = raw[i];
            if (quote) { if (ch === quote) quote = null; continue; }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '#' && i > 0 && /\s/.test(raw[i - 1])) return raw.slice(0, i);
        }
        return raw;
    }
    function parseEnv(raw) {
        var map = Object.create(null);
        raw.split(/\r?\n/).forEach(function (line) {
            line = line.trim();
            if (!line || /^#/.test(line)) return;
            line = line.replace(/^export\s+/, '');
            var eq = line.indexOf('=');
            if (eq < 0) return;
            var key = line.slice(0, eq).trim();
            var val = stripInlineComment(line.slice(eq + 1)).trim();
            if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
            map[key] = val;
        });
        return map;
    }

    it('env-file parser handles KEY=val, comments, export prefix, quotes, empty', function () {
        var m = parseEnv('# comment\nexport DB_PW=secret\nAPI_KEY="quoted"\nEMPTY=\nNOEQ\n\nC=\'single\'\n');
        assert.equal(m.DB_PW, 'secret');
        assert.equal(m.API_KEY, 'quoted');
        assert.equal(m.C, 'single');
        assert.equal(m.EMPTY, '');
        assert.equal('NOEQ' in m, false);   // no '=' → skipped
    });

    it('isEnvSet against an env-file map: non-empty SET, empty/absent UNSET', function () {
        var map = parseEnv('SET_KEY=v\nEMPTY_KEY=\n');
        function isEnvSet(source, key) { return typeof source[key] === 'string' && source[key] !== ''; }
        assert.equal(isEnvSet(map, 'SET_KEY'), true);
        assert.equal(isEnvSet(map, 'EMPTY_KEY'), false);
        assert.equal(isEnvSet(map, 'ABSENT_KEY'), false);
    });

    HANDLERS.forEach(function (h) {
        var name = h[0], src = h[1];

        it(name + '.js reads the scope from self.params.scope (framework scope flag, not manual argv)', function () {
            assert.match(src, /self\.scopeName\s*=\s*\(self\.params\s*&&\s*self\.params\.scope\)/);
        });

        it(name + '.js passes the scope INTO the shared walk (the walk no longer reads closure state)', function () {
            assert.match(src, /getProjectRequiredKeys\([^)]*scope:\s*self\.scopeName/);
        });
    });

    // The walk-level scope-overlay pins (config_<scope> sibling derivation,
    // merge(JSON.clone(scopeContent), ..., false)) moved with the walk — see
    // test/lib/secrets-sources.test.js §02. check.js RETAINS its own scoped
    // single-file reader (readScopedConfig, the #B263 settings/env machinery),
    // which must stay merge-compatible with the walk:

    it('check.js readScopedConfig derives the config_<scope>/ sibling like the shared walk', function () {
        assert.match(checkSrc, /absDir\s*\+\s*['"]_['"]\s*\+\s*self\.scopeName/);
    });

    it('check.js readScopedConfig deep-merges scope over base with explicit override=false', function () {
        assert.match(checkSrc, /merge\(\s*JSON\.clone\(scope\)[^)]*,\s*false\s*\)/);
    });

    it('check.js reads --env-file from self.params and defines loadEnvFile', function () {
        assert.match(checkSrc, /self\.envFile\s*=\s*\(self\.params\s*&&\s*self\.params\[['"]env-file['"]\]\)/);
        assert.match(checkSrc, /var\s+loadEnvFile\s*=\s*function/);
    });

    // ---- two-tier lookup (env over file), matching backends/file.js ---------

    it('check.js consults the environment tier BEFORE the file tier', function () {
        var lookup = checkSrc.slice(checkSrc.indexOf('var lookupSecret'));
        assert.ok(lookup.length > 0, 'lookupSecret must exist');
        var envAt  = lookup.indexOf('source[key]');
        var fileAt = lookup.indexOf('chain.map[key]');
        assert.ok(envAt > -1, 'environment tier must be present');
        assert.ok(fileAt > -1, 'file tier must be present');
        assert.ok(envAt < fileAt, 'environment must be read before the file chain');
    });

    it('check.js builds the file chain with the shared whisper + secrets.readEnvFile (no second resolver)', function () {
        assert.match(checkSrc, /whisper\(\s*buildReps\(/);
        // #B267 moved this call site from `parseEnvFile` (map-or-null) to the
        // discriminated `readEnvFile`, so the checker can tell an absent layer
        // from an unreadable one exactly as the runtime does. Still the SHARED
        // parser from lib/secrets — which is what this pin actually guards.
        assert.match(checkSrc, /secrets\.readEnvFile\(\s*path\s*\)/);
    });

    it('check.js never sources ${homedir} from projects.json (the field the config loader never reads)', function () {
        assert.doesNotMatch(checkSrc, /self\.projectHomedir/);
        assert.doesNotMatch(checkSrc, /getCoreEnv\s*\(/);
        // It must read the project's own env.json instead.
        assert.match(checkSrc, /env\.json/);
    });

    it('check.js skips the file tier on an unresolved token rather than statting a literal path', function () {
        // #B408 realignment (approved) — the behaviour this test NAMES is
        // unchanged; the mechanic moved. The guard now lives in the SHARED
        // validator (lib/secrets/src/declaration.js), consumed by check.js
        // through secrets.validateFilePaths BEFORE any layer read — one
        // implementation with the runtime, so the gate cannot drift lax
        // again. Comment-stripped view: check.js's retirement comment
        // legitimately names the old UNRESOLVED_TOKEN constant.
        var stripped = checkSrc.split('\n').map(function (l) {
            if (/^\s*(\/\/|\*|\/\*)/.test(l)) { return ''; }
            return l.replace(/\/\/.*$/, '');
        }).join('\n');
        var callAt = stripped.indexOf('secrets.validateFilePaths(');
        var readAt = stripped.indexOf('secrets.readEnvFile(path)');
        assert.ok(callAt > -1, 'check.js must consume the shared validation');
        assert.ok(readAt > -1, 'stripping emptied the source — pin would pass vacuously');
        assert.ok(callAt < readAt, 'validation must precede the layer reads, as it does at boot');
        // The CLI-only hint survives on the unresolved-token verdict:
        assert.match(checkSrc, /pass --scope\/--env if it names one/);
    });

    it('check.js only seeds a reps key from a NON-EMPTY string (an empty one substitutes silently)', function () {
        // Guards the measured whisper behaviour: an absent key leaves its token
        // verbatim (caught loudly downstream), but an empty-string value IS
        // substituted, collapsing `<home>/${scope}/f.env` to `<home>//f.env`.
        assert.match(checkSrc, /typeof\s+value\s*===\s*['"]string['"]\s*&&\s*value\s*!==\s*['"]{2}/);
    });

    it('arguments.json declares --env (needed to pick the env block homedir is read from)', function () {
        assert.ok(argsArr.indexOf('--env') > -1, 'expected --env in arguments.json');
    });

    // ---- #B266: reps must carry every token a real chain uses ---------------

    it('check.js seeds the version tokens from the manifest (a ${projectVersionMajor} path must resolve)', function () {
        assert.match(checkSrc, /put\(\s*['"]projectVersion['"]\s*,\s*manifest\.version\s*\)/);
        assert.match(checkSrc, /put\(\s*['"]projectVersionMajor['"]\s*,\s*manifest\.version\.split/);
    });

    it('check.js resolves ${scope} from an ASSUMED scope, not from the overlay flag alone', function () {
        // scopeAssumed falls back to the project default...
        assert.match(checkSrc, /self\.scopeAssumed\s*=\s*self\.scopeName\s*\|\|\s*self\.defaultScope/);
        assert.match(checkSrc, /put\(\s*['"]scope['"]\s*,\s*self\.scopeAssumed\s*\)/);
        // ...while scopeName itself stays explicit-only, so the config_<scope>/
        // overlay is never applied by default (that would be a behaviour change).
        assert.match(checkSrc, /self\.scopeName\s*=\s*\(self\.params\s*&&\s*self\.params\.scope\)\s*\?\s*self\.params\.scope\s*:\s*null/);
    });

    it('check.js derives the project name from the PATH, so the all-projects form cannot build ~/.undefined', function () {
        assert.match(checkSrc, /self\.projects\[pn\]\.path\s*===\s*projectPath/);
        assert.doesNotMatch(checkSrc, /['"]~\/\.['"]\s*\+\s*self\.projectName/);
    });

    it('a versioned + scoped chain resolves end to end (regression for the shape that skipped the tier)', function () {
        // Replica of buildReps' seeding rules + the real substitution semantics.
        var manifest = { version: '3.0.0-beta.1' };
        var reps = {};
        var put  = function (k, v) { if (typeof v === 'string' && v !== '') reps[k] = v; };
        put('projectName', 'demoproject');
        put('scope', null || 'local');                 // no --scope -> project default
        put('projectVersion', manifest.version);
        put('projectVersionMajor', manifest.version.split(/\./g)[0]);
        put('homedir', '/home/u/.demoproject');

        var chain = [
            '${homedir}/v${projectVersionMajor}/credentials/secrets.env',
            '${homedir}/v${projectVersionMajor}/credentials/${scope}/secrets.env'
        ];
        var out = chain.map(function (p) {
            return p.replace(/\$\{(\w+)\}/g, function (s, k) {
                return (reps[k] !== undefined) ? reps[k] : s;
            });
        });

        assert.equal(out[0], '/home/u/.demoproject/v3/credentials/secrets.env');
        assert.equal(out[1], '/home/u/.demoproject/v3/credentials/local/secrets.env');
        out.forEach(function (p) {
            assert.doesNotMatch(p, /\$\{[^}]*\}/, 'no token may survive: ' + p);
        });
    });

    // ---- declaration resolution: shared/config vs the bundle's own ----------
    // Replicates the loader's own expression (`merge(sharedMain, jsonFile, true)`),
    // so these pin the RUNTIME's semantics, not just the CLI's copy of them.

    function effectiveChain(shared, bundle) {
        var eff = merge(JSON.clone(shared), JSON.clone(bundle), true);
        return (eff && eff.secrets && typeof eff.secrets === 'object') ? eff.secrets.file : undefined;
    }

    it('a bundle-level chain REPLACES the shared one outright (arrays do not concatenate)', function () {
        assert.deepStrictEqual(
            effectiveChain({ secrets: { file: ['SHARED'] } }, { secrets: { file: ['BUNDLE'] } }),
            ['BUNDLE']
        );
    });

    it('a bundle with no secrets block at all inherits the shared chain', function () {
        assert.deepStrictEqual(effectiveChain({ secrets: { file: ['SHARED'] } }, {}), ['SHARED']);
    });

    it('an EMPTY bundle secrets block does not silently disable a project-wide chain', function () {
        // The distinction matters: declaring `secrets: {}` for some future sibling
        // key must not strip the inherited file chain out from under the bundle.
        assert.deepStrictEqual(
            effectiveChain({ secrets: { file: ['SHARED'] } }, { secrets: {} }),
            ['SHARED']
        );
    });

    it('an explicit null IS the opt-out lever (distinct from an empty block)', function () {
        assert.equal(
            effectiveChain({ secrets: { file: ['SHARED'] } }, { secrets: { file: null } }),
            null
        );
        // and selectBackend treats null as "no chain" -> the unchanged env backend
        var envOnly = secrets.selectBackend({ content: { settings: { secrets: { file: null } } } });
        var plain   = secrets.selectBackend({ content: { settings: {} } });
        assert.equal(envOnly, plain, 'a nulled chain must yield the SAME default backend instance');
    });

    it('neither level declaring leaves no chain at all (control)', function () {
        assert.equal(effectiveChain({}, {}), undefined);
    });

    it('--env-file outranks the declared file tier (it stands in for the environment)', function () {
        // Replica of lookupSecret with an --env-file map occupying the env tier.
        var envFileMap = { SHARED_KEY: 'from-env-file' };
        var fileTier   = { SHARED_KEY: 'from-declared-file', FILE_ONLY: 'f' };
        function lookup(key) {
            if (typeof envFileMap[key] === 'string' && envFileMap[key] !== '') return 'env-file';
            if (typeof fileTier[key] === 'string' && fileTier[key] !== '') return 'file';
            return null;
        }
        assert.equal(lookup('SHARED_KEY'), 'env-file');   // explicit flag wins
        assert.equal(lookup('FILE_ONLY'), 'file');        // but does not mask the tier below
        assert.equal(lookup('NOWHERE'), null);
    });

    it('an underivable token still survives verbatim so the tier fails loudly (control for the test above)', function () {
        var reps = { homedir: '/home/u/.demoproject' };   // no version, no scope
        var out = '${homedir}/v${projectVersionMajor}/x.env'.replace(/\$\{(\w+)\}/g, function (s, k) {
            return (reps[k] !== undefined) ? reps[k] : s;
        });
        assert.match(out, /\$\{projectVersionMajor\}/);   // must NOT silently vanish
    });

    // ---- behavioural: real lib/secrets parser, real files -------------------

    it('layering a real chain: later entry wins, absent file contributes nothing', function () {
        var dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gina-secrets-chain-'));
        try {
            var base  = path.join(dir, 'base.env');
            var scope = path.join(dir, 'scope.env');
            fs.writeFileSync(base,  'SHARED=from-base\nONLY_BASE=b\n');
            fs.writeFileSync(scope, 'SHARED=from-scope\nONLY_SCOPE=s\n');

            // Replica of resolveSecretsFileChain's layering loop.
            var paths  = [base, scope, path.join(dir, 'missing.env')];
            var map    = Object.create(null);
            var layers = [];
            paths.forEach(function (p) {
                var m = secrets.parseEnvFile(p);
                layers.push({ path: p, found: m !== null });
                if (m === null) return;
                for (var k in m) map[k] = m[k];
            });

            assert.equal(map.SHARED, 'from-scope');      // later entry wins
            assert.equal(map.ONLY_BASE, 'b');            // earlier entry back-fills
            assert.equal(map.ONLY_SCOPE, 's');
            assert.deepStrictEqual(layers.map(function (l) { return l.found; }), [true, true, false]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('two-tier resolution: env wins over file, file fills a gap, neither → UNSET', function () {
        // Replica of lookupSecret with both tiers populated.
        var envTier  = { IN_BOTH: 'from-env', ONLY_ENV: 'e', EMPTY_IN_ENV: '' };
        var fileTier = { IN_BOTH: 'from-file', ONLY_FILE: 'f', EMPTY_IN_ENV: 'rescued' };
        function lookup(key) {
            if (typeof envTier[key] === 'string' && envTier[key] !== '') return 'env';
            if (typeof fileTier[key] === 'string' && fileTier[key] !== '') return 'file';
            return null;
        }
        assert.equal(lookup('IN_BOTH'), 'env');            // environment outranks the file
        assert.equal(lookup('ONLY_ENV'), 'env');
        assert.equal(lookup('ONLY_FILE'), 'file');         // file fills the gap
        assert.equal(lookup('EMPTY_IN_ENV'), 'file');      // empty env value is NOT "set"
        assert.equal(lookup('NOWHERE'), null);             // still fail-closed
    });
});


// ---------------------------------------------------------------------------
// 10 — #B583: a MALFORMED whole-value reference fails the gate and is listed
// ---------------------------------------------------------------------------
// The runtime REFUSES a config carrying `${secret:db_password}` (or a valid
// token padded with whitespace) at config load. A gate that green-lights
// such a config is the #B408 drift class, so check exits 1 on it and both
// commands list it beside the keys — it is not a key.

describe('10 - #B583 malformed references: check fails, scan lists', function () {

    it('the walk aggregation over the REAL lib.secrets lists each malformed value with its file (replica of collectFromConfigDir)', function () {
        // Replica of collectFromConfigDir's malformed accumulation over an in-memory
        // { filename: confObject } map, using the REAL secrets.getMalformedReferences.
        function aggregateMalformed(filesByName, relBase) {
            var out = [];
            Object.keys(filesByName).sort().forEach(function (name) {
                secrets.getMalformedReferences(filesByName[name]).forEach(function (e) {
                    out.push({ file: relBase + '/' + name, path: e.path, ref: e.ref });
                });
            });
            return out;
        }
        var got = aggregateMalformed({
            'connectors.json': { db: { password: '${secret:db_password}', user: '${secret:DB_USER}' } },
            'settings.json'  : { api: { key: '${secret:API_KEY} ' }, url: 'https://${secret:API_HOST}/v1' }
        }, 'src/demo/config');
        assert.deepStrictEqual(got, [
            { file: 'src/demo/config/connectors.json', path: 'db.password', ref: '${secret:db_password}' },
            { file: 'src/demo/config/settings.json',   path: 'api.key',     ref: '${secret:API_KEY} ' }
        ]);
    });

    it('check: a malformed reference flips anyError even when every required key is SET (replica of checkBundle)', function () {
        var env       = { DB_USER: 'u' };
        var keys      = ['DB_USER'];
        var malformed = [{ file: 'src/demo/config/connectors.json', path: 'db.password', ref: '${secret:db_password}' }];
        var anyUnset = false, anyError = false;
        keys.forEach(function (k) { if (!(typeof env[k] === 'string' && env[k] !== '')) anyUnset = true; });
        if (malformed.length) anyError = true;
        assert.equal(anyUnset, false);
        assert.equal(anyError, true, 'the runtime refuses this config; the gate must exit 1');
        assert.equal((anyUnset || anyError) ? 1 : 0, 1);
    });

    // ---- source pins: the shipped handlers carry the accounting -----------

    it('check.js: checkBundle takes the walk entry\'s malformed list and flips self.anyError on it', function () {
        assert.match(checkSrc, /var\s+checkBundle\s*=\s*function\s*\(\s*projectPath\s*,\s*manifest\s*,\s*bundleName\s*,\s*entryByKey\s*,\s*malformed\s*\)/);
        assert.match(checkSrc, /if\s*\(\s*bad\.length\s*\)\s*\{\s*self\.anyError\s*=\s*true;\s*\}/);
        // every caller passes the list from the SAME walk entry (file order)
        var callers = checkSrc.match(/checkBundle\([^)]*walked\.bundles\[[^\]]+\]\.malformed\s*\)/g) || [];
        assert.equal(callers.length, 3, 'checkAll, checkProjectOnly and checkBundleOnly pass walked.bundles[…].malformed; found ' + callers.length);
    });

    it('check.js: the report carries `malformed`, and the text renderer names file, path and text + counts them in the summary', function () {
        assert.match(checkSrc, /malformed\s*:\s*bad,/);
        assert.match(checkSrc, /var\s+emitTextMalformed\s*=\s*function/);
        assert.match(checkSrc, /MALFORMED reference at `/);
        assert.match(checkSrc, /the runtime REFUSES to boot on this/);
        assert.match(checkSrc, /' malformed'/);
    });

    it('scan.js: the bundle report carries `malformed` and the text renderer lists them under their own heading (exit stays 0)', function () {
        assert.match(scanSrc, /malformed\s*:\s*Array\.isArray\(entry\.malformed\)/);
        assert.match(scanSrc, /var\s+emitTextMalformed\s*=\s*function/);
        assert.match(scanSrc, /Malformed references \(/);
        assert.match(scanSrc, /process\.exit\(0\);/);
    });

    it('help.txt documents the malformed-reference refusal', function () {
        assert.match(helpTxt, /MALFORMED reference/);
    });

    it('lib/secrets exports getMalformedReferences and MALFORMED_RE (the CLI consumes the runtime\'s own view)', function () {
        assert.equal(typeof secrets.getMalformedReferences, 'function');
        assert.ok(secrets.MALFORMED_RE instanceof RegExp);
    });
});
