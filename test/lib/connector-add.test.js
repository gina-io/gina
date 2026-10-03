/**
 * lib/cmd/connector/add.js — positional parsing, connector type resolution,
 * target file resolution, entry building, comment-header preservation,
 * key-ordered merge, install-hint printing.
 *
 * Source-inspection tests (same style as connector-list.test.js): add.js
 * runs inside the CLI daemon context (CmdHelper, project registry, globals
 * injected by gna.js). Replicating that is heavy for near-zero extra
 * coverage, so these assertions prove the source structure of:
 *
 *   (a) module shape + CmdHelper wiring + isCmdConfigured gate
 *   (b) positional extraction — argv[3..], skips flags/@/dash tokens
 *   (c) ALLOWED_CONNECTOR_TYPES + ALLOWED_SCOPES (mirror schema enums)
 *   (d) lib.connectorRegistry consumption — no inline DRIVER_MAP/AI_DRIVER_MAP
 *   (e) connector type inference — infer from <name> when it matches enum,
 *       --driver= synonym for --connector=, reject unknown types
 *   (f) target resolution — shared vs bundle path, manifest.bundles lookup
 *   (g) buildEntry — flag-to-entry mapping, scope enum validation,
 *       `connector` omitted when type matches the logical name,
 *       port cast to Number when numeric
 *   (h) readExistingFile — existence check, comment-aware header capture
 *       (via lib.jsonConfigHeader.splitHeader), requireJSON for comment
 *       tolerance, parent-dir exists check
 *   (i) mergeEntry — $schema pinned first, existing key order preserved,
 *       overwrite replaces in place, new entry appended
 *   (j) writeFile — delegates to lib.generator.createFileFromDataSync,
 *       trailing newline, header concatenated verbatim
 *   (k) buildInstallHint — AI resolves from protocol scheme, entry.version
 *       pin overrides peerDeps range, sqlite reports built-in note
 *   (l) error paths — missing project, unregistered project, invalid bundle,
 *       existing entry without --force, invalid scope/type
 *   (m) help.txt + arguments.json — `add` section, all flags registered
 *   (n) --install (Session 5) — PACKAGE_MANAGERS lockfile-probe table,
 *       detectPackageManager (bun → pnpm → yarn → npm, npm fallback),
 *       resolveInstallRange (entry.version → project deps → framework range),
 *       runInstall (spawnSync, stdio inherit, ENOENT 127), dispatch for
 *       sqlite (no-op) and AI with unknown protocol (exit 1),
 *       opt-in wiring in init(), negative invariant that --install is not
 *       a default path
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var ADD_SOURCE  = path.join(require('../fw'), 'lib/cmd/connector/add.js');
var HELP_TXT    = path.join(require('../fw'), 'lib/cmd/connector/help.txt');
var ARGS_FILE   = path.join(require('../fw'), 'lib/cmd/connector/arguments.json');
var CLI_SOURCE  = path.join(__dirname, '..', '..', 'bin', 'cli');
var SCHEMA_FILE = path.join(__dirname, '..', '..', 'schema', 'connectors.json');

var src     = fs.readFileSync(ADD_SOURCE, 'utf8');
var helpTxt = fs.readFileSync(HELP_TXT, 'utf8');
var argsArr = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8'));
var cliSrc  = fs.readFileSync(CLI_SOURCE, 'utf8');
var schema  = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));


// ---------------------------------------------------------------------------
// 01 — Module shape
// ---------------------------------------------------------------------------

describe('01 - module shape', function () {

    it('exports the Add constructor', function () {
        assert.match(src, /module\.exports\s*=\s*Add;?/);
    });

    it('declares a function Add(opt, cmd)', function () {
        assert.match(src, /function\s+Add\s*\(\s*opt\s*,\s*cmd\s*\)\s*\{/);
    });

    it('wires CmdHelper with opt.client and debug flags', function () {
        assert.match(src, /new CmdHelper\(self, opt\.client, \{ port: opt\.debugPort, brkEnabled: opt\.debugBrkEnabled \}\)/);
    });

    it('gates on isCmdConfigured()', function () {
        assert.match(src, /if \(\s*!isCmdConfigured\(\)\s*\) return false;/);
    });

    it('uses fs + path from Node.js', function () {
        assert.match(src, /var fs\s*=\s*require\('fs'\);/);
        assert.match(src, /var path\s*=\s*require\('path'\);/);
    });

    it('uses lib.logger as console', function () {
        assert.match(src, /var console\s*=\s*lib\.logger;/);
    });
});


// ---------------------------------------------------------------------------
// 02 — Positional extraction
// ---------------------------------------------------------------------------

describe('02 - positional extraction', function () {

    it('declares extractPositionals(argv)', function () {
        assert.match(src, /var extractPositionals\s*=\s*function \(argv\) \{/);
    });

    it('iterates from index 3 (past node + bin + task)', function () {
        assert.match(src, /for \(var i = 3, len = argv\.length; i < len; i\+\+\)/);
    });

    it('skips `--flag` tokens', function () {
        assert.match(src, /if \(\s*\/\^\\-\\-\/\.test\(tok\)\s*\) continue;/);
    });

    it('skips `-flag` short tokens', function () {
        assert.match(src, /if \(\s*\/\^\\-\/\.test\(tok\)\s*\) continue;/);
    });

    it('skips `@project` tokens', function () {
        assert.match(src, /if \(\s*\/\^\\@\/\.test\(tok\)\s*\) continue;/);
    });

    it('connector name is positionals[0], bundle is positionals[1]', function () {
        assert.match(src, /var connectorName = positionals\[0\] \|\| null;/);
        assert.match(src, /var bundleName\s*= positionals\[1\] \|\| null;/);
    });

    it('validates connector name against [a-zA-Z0-9_-]', function () {
        assert.match(src, /\/\^\[a-z0-9_\\\-\]\+\$\/i\.test\(connectorName\)/);
    });
});


// ---------------------------------------------------------------------------
// 03 — ALLOWED_CONNECTOR_TYPES + ALLOWED_SCOPES (schema enum mirrors)
// ---------------------------------------------------------------------------

describe('03 - schema enum mirrors', function () {

    it('declares ALLOWED_CONNECTOR_TYPES', function () {
        assert.match(src, /var ALLOWED_CONNECTOR_TYPES\s*=\s*\[/);
    });

    it('ALLOWED_CONNECTOR_TYPES contains the eight schema enum values', function () {
        assert.match(src, /'couchbase'/);
        assert.match(src, /'mysql'/);
        assert.match(src, /'postgresql'/);
        assert.match(src, /'sqlite'/);
        assert.match(src, /'redis'/);
        assert.match(src, /'ai'/);
        assert.match(src, /'scylladb'/);
        assert.match(src, /'duckdb'/);
    });

    it('declares ALLOWED_SCOPES', function () {
        assert.match(src, /var ALLOWED_SCOPES\s*=\s*\[\s*'local',\s*'beta',\s*'production',\s*'testing'\s*\]/);
    });

    it('schema/connectors.json enum is the source of truth', function () {
        var enumValues = schema.definitions.connector.properties.connector.enum;
        assert.deepStrictEqual(enumValues.sort(), ['ai', 'couchbase', 'duckdb', 'mongodb', 'mysql', 'postgresql', 'redis', 'scylladb', 'sqlite']);
    });

    it('schema scope enum is [local, beta, production, testing]', function () {
        var scopes = schema.definitions.connector.properties.scope.enum;
        assert.deepStrictEqual(scopes.sort(), ['beta', 'local', 'production', 'testing']);
    });

    it('schema declares a `version` property (new in session 2)', function () {
        assert.ok(schema.definitions.connector.properties.version, '`version` property must exist on the connector schema');
        assert.strictEqual(schema.definitions.connector.properties.version.type, 'string');
    });
});


// ---------------------------------------------------------------------------
// 04 — Connector registry consumption
// ---------------------------------------------------------------------------

describe('04 - connector registry consumption', function () {

    it('declares `var registry = lib.connectorRegistry;`', function () {
        assert.match(src, /var registry = lib\.connectorRegistry;/);
    });

    it('does NOT declare an inline DRIVER_MAP — moved to the registry', function () {
        assert.doesNotMatch(src, /var DRIVER_MAP\s*=\s*\{/, 'DRIVER_MAP must live in lib/connector-registry, not inline');
    });

    it('does NOT declare an inline AI_DRIVER_MAP — moved to the registry', function () {
        assert.doesNotMatch(src, /var AI_DRIVER_MAP\s*=\s*\{/, 'AI_DRIVER_MAP must live in lib/connector-registry, not inline');
    });

    it('consumes via registry.getDriver(type) for non-AI connectors', function () {
        assert.match(src, /registry\.getDriver\(connectorType\)/);
    });

    it('consumes via registry.getAIDriver(scheme) for AI connectors', function () {
        assert.match(src, /registry\.getAIDriver\(scheme\)/);
    });

    it('consumes via registry.getAISchemes() for AI scheme help messages', function () {
        assert.match(src, /registry\.getAISchemes\(\)/);
    });
});


describe('05 - registry module exists and exposes the expected shape', function () {
    var registryPath = require('path').join(require('../fw'), 'lib/connector-registry');
    var registry     = require(registryPath);

    it('registry exports getDriver + getAIDriver', function () {
        assert.equal(typeof registry.getDriver, 'function');
        assert.equal(typeof registry.getAIDriver, 'function');
    });

    it('registry getDriver(redis) returns ioredis >=5.0.0', function () {
        assert.deepEqual(registry.getDriver('redis'), { npm: 'ioredis', range: '>=5.0.0' });
    });

    it('registry getAIDriver(anthropic) returns @anthropic-ai/sdk >=0.27.0', function () {
        assert.deepEqual(registry.getAIDriver('anthropic'), { npm: '@anthropic-ai/sdk', range: '>=0.27.0' });
    });
});


// ---------------------------------------------------------------------------
// 06 — Connector type inference
// ---------------------------------------------------------------------------

describe('06 - connector type inference', function () {

    it('reads --connector=<type> from self.params', function () {
        assert.match(src, /var connectorType = p\['connector'\] \|\| p\['driver'\] \|\| null;/);
    });

    it('--driver= is a synonym for --connector=', function () {
        assert.match(src, /p\['connector'\] \|\| p\['driver'\]/);
    });

    it('infers type from <name> when name matches an allowed type', function () {
        assert.match(src, /if \(!connectorType && ALLOWED_CONNECTOR_TYPES\.indexOf\(connectorName\) > -1\)/);
        assert.match(src, /connectorType = connectorName;/);
    });

    it('errors when connector type cannot be resolved', function () {
        assert.match(src, /pass `--connector=<type>` or name the entry after one of/);
    });

    it('rejects unknown connector types with a helpful hint', function () {
        assert.match(src, /Unknown connector type/);
        assert.match(src, /Allowed values/);
    });
});


// ---------------------------------------------------------------------------
// 07 — Target resolution
// ---------------------------------------------------------------------------

describe('07 - resolveTarget', function () {

    it('declares resolveTarget(projectPath, bundleName)', function () {
        assert.match(src, /var resolveTarget\s*=\s*function \(projectPath, bundleName\) \{/);
    });

    it('resolves shared path when no bundle passed', function () {
        assert.match(src, /projectPath \+ '\/shared\/config\/connectors\.json'/);
    });

    it('reads manifest.bundles for bundle-scoped writes', function () {
        assert.match(src, /manifest\.bundles\[bundleName\]/);
    });

    it('resolves <bundle-src>/config/connectors.json from manifest.src', function () {
        assert.match(src, /var bundleSrc = manifest\.bundles\[bundleName\]\.src;/);
        assert.match(src, /projectPath \+ '\/' \+ bundleSrc \+ '\/config\/connectors\.json'/);
    });

    it('errors when manifest.json cannot be read', function () {
        assert.match(src, /Cannot read `'.+'\/manifest\.json`/);
    });

    it('errors when the bundle is not registered in the manifest', function () {
        assert.match(src, /is not registered inside `@/);
    });
});


describe('08 - loadManifest', function () {

    it('declares loadManifest(projectPath)', function () {
        assert.match(src, /var loadManifest\s*=\s*function \(projectPath\) \{/);
    });

    it('reads <projectPath>/manifest.json via requireJSON', function () {
        assert.match(src, /return requireJSON\(p\);/);
    });

    it('returns null on missing file', function () {
        assert.match(src, /if \(\s*!fs\.existsSync\(p\)\s*\) return null;/);
    });

    it('swallows parse errors and returns null', function () {
        assert.match(src, /try\s*\{[\s\S]*?return requireJSON\(p\);[\s\S]*?\}\s*catch \(e\) \{\s*return null;/);
    });
});


// ---------------------------------------------------------------------------
// 09 — buildEntry (flag-to-entry mapping)
// ---------------------------------------------------------------------------

describe('09 - buildEntry', function () {

    it('declares buildEntry(connectorName, connectorType, p)', function () {
        assert.match(src, /var buildEntry\s*=\s*function \(connectorName, connectorType, p\) \{/);
    });

    it('omits `connector` field when type matches the logical name', function () {
        assert.match(src, /if \(connectorType !== connectorName\)\s*\{\s*entry\.connector = connectorType;/);
    });

    it('maps --protocol= to entry.protocol', function () {
        assert.match(src, /if \(p\['protocol'\]\) entry\.protocol\s*=\s*String\(p\['protocol'\]\);/);
    });

    it('maps --host= to entry.host', function () {
        assert.match(src, /if \(p\['host'\]\)\s+entry\.host\s*=\s*String\(p\['host'\]\);/);
    });

    it('casts --connector-port= to Number when numeric, keeps String otherwise', function () {
        assert.match(src, /var portNum = Number\(p\['connector-port'\]\);/);
        assert.match(src, /entry\.port = isNaN\(portNum\) \? String\(p\['connector-port'\]\) : portNum;/);
    });

    it('guards --connector-port=true (bare flag) so port isn\'t set to `true`', function () {
        assert.match(src, /typeof p\['connector-port'\] != 'undefined' && p\['connector-port'\] !== true/);
    });

    it('maps --database= to entry.database', function () {
        assert.match(src, /if \(p\['database'\]\) entry\.database\s*=\s*String\(p\['database'\]\);/);
    });

    it('maps --username= and --password= to entry.username/password', function () {
        assert.match(src, /if \(p\['username'\]\) entry\.username\s*=\s*String\(p\['username'\]\);/);
        assert.match(src, /if \(p\['password'\]\) entry\.password\s*=\s*String\(p\['password'\]\);/);
    });

    it('validates --scope= against ALLOWED_SCOPES', function () {
        assert.match(src, /if \(ALLOWED_SCOPES\.indexOf\(sc\) < 0\)/);
        assert.match(src, /Scope `' \+ sc \+ '` is not valid\. Allowed:/);
    });

    it('maps --model= to entry.model (AI connector)', function () {
        assert.match(src, /if \(p\['model'\]\)\s+entry\.model\s+=\s*String\(p\['model'\]\);/);
    });

    it('maps --api-key= to entry.apiKey (AI connector)', function () {
        assert.match(src, /if \(p\['api-key'\]\)\s+entry\.apiKey\s+=\s*String\(p\['api-key'\]\);/);
    });

    it('maps --base-url= to entry.baseURL (AI connector)', function () {
        assert.match(src, /if \(p\['base-url'\]\) entry\.baseURL\s+=\s*String\(p\['base-url'\]\);/);
    });

    it('maps --driver-version= to entry.version', function () {
        assert.match(src, /if \(p\['driver-version'\]\)\s+entry\.version\s+=\s*String\(p\['driver-version'\]\);/);
    });
});


// ---------------------------------------------------------------------------
// 10 — readExistingFile (comment-header preservation)
// ---------------------------------------------------------------------------

describe('10 - readExistingFile', function () {

    it('declares readExistingFile(target)', function () {
        assert.match(src, /var readExistingFile\s*=\s*function \(target\) \{/);
    });

    it('returns an empty shape when the file does not exist', function () {
        assert.match(src, /return \{ header: '', data: \{\} \};/);
    });

    it('errors when the parent directory does not exist', function () {
        assert.match(src, /Config directory does not exist/);
    });

    it('captures the header via the comment-aware lib.jsonConfigHeader.splitHeader', function () {
        assert.match(src, /var header = lib\.jsonConfigHeader\.splitHeader\(raw\)\.header;/);
        // the old raw.indexOf-of-brace split (which landed inside the template's
        // `// "couchbase": {` comment and corrupted the rewrite) must be gone
        assert.doesNotMatch(src, /raw\.indexOf\('\{'\)/);
    });

    it('parses the body with requireJSON for comment tolerance', function () {
        assert.match(src, /data = requireJSON\(target\) \|\| \{\};/);
    });

    it('errors on parse failure', function () {
        assert.match(src, /Cannot parse `/);
    });
});


// ---------------------------------------------------------------------------
// 11 — mergeEntry (key-ordered merge)
// ---------------------------------------------------------------------------

describe('11 - mergeEntry', function () {

    it('declares mergeEntry(existing, connectorName, entry)', function () {
        assert.match(src, /var mergeEntry\s*=\s*function \(existing, connectorName, entry\) \{/);
    });

    it('pins $schema at the top of the output', function () {
        assert.match(src, /if \(existing\.\$schema\)\s*\{\s*out\.\$schema = existing\.\$schema;/);
    });

    it('uses the canonical $schema URL when none is present', function () {
        assert.match(src, /out\.\$schema = 'https:\/\/gina\.io\/schema\/connectors\.json';/);
    });

    it('preserves existing key order during iteration', function () {
        assert.match(src, /for \(var k in existing\) \{\s*if \(k === '\$schema'\) continue;/);
    });

    it('replaces in place when the key already exists (overwrite path)', function () {
        assert.match(src, /if \(k === connectorName\)\s*\{\s*out\[connectorName\] = entry;/);
    });

    it('appends the new entry when it was not present', function () {
        assert.match(src, /if \(!overwrite\)\s*\{\s*out\[connectorName\] = entry;/);
    });
});


// ---------------------------------------------------------------------------
// 12 — writeFile (header + body + trailing newline)
// ---------------------------------------------------------------------------

describe('12 - writeFile', function () {

    it('declares writeFile(target, header, data)', function () {
        assert.match(src, /var writeFile\s*=\s*function \(target, header, data\) \{/);
    });

    it('serialises body with JSON.stringify(data, null, 4)', function () {
        assert.match(src, /var body = JSON\.stringify\(data, null, 4\);/);
    });

    it('concatenates header + body + trailing newline', function () {
        assert.match(src, /var text\s*=\s*\(header \|\| ''\) \+ body \+ '\\n';/);
    });

    it('routes writes through lib.generator.createFileFromDataSync', function () {
        assert.match(src, /lib\.generator\.createFileFromDataSync\(text, target\);/);
    });
});


// ---------------------------------------------------------------------------
// 13 — buildInstallHint (AI + driver resolution + version pin)
// ---------------------------------------------------------------------------

describe('13 - buildInstallHint', function () {

    it('declares buildInstallHint(connectorType, entry)', function () {
        assert.match(src, /var buildInstallHint\s*=\s*function \(connectorType, entry\) \{/);
    });

    it('AI path reads the protocol scheme from entry.protocol', function () {
        assert.match(src, /var scheme = entry\.protocol \? String\(entry\.protocol\)\.split\(':'\)\[0\]\.toLowerCase\(\) : null;/);
    });

    it('AI path hints to set a valid protocol when scheme is unknown', function () {
        assert.match(src, /set `protocol` to one of:/);
    });

    it('AI path uses entry.version pin over ai.range when present', function () {
        assert.match(src, /var range = entry\.version \|\| ai\.range;/);
    });

    it('non-AI path uses entry.version pin over info.range when present', function () {
        assert.match(src, /var r = entry\.version \|\| info\.range;/);
    });

    it('sqlite short-circuits to a "no install needed" note', function () {
        assert.match(src, /No install needed/);
    });

    it('prints `npm install <pkg>@"<range>"` for runnable paths', function () {
        var matches = src.match(/Next: run `npm install/g) || [];
        assert.ok(matches.length >= 2, 'expected at least two `Next: run `npm install ...`` hint strings (AI + driver), got ' + matches.length);
    });
});


// ---------------------------------------------------------------------------
// 14 — Error paths + exit codes
// ---------------------------------------------------------------------------

describe('14 - error paths', function () {

    it('requires @<project>', function () {
        assert.match(src, /requires `@<project>`/);
    });

    it('errors when the requested project is not registered', function () {
        assert.match(src, /is not registered\. Run `gina project:list`/);
    });

    it('rejects when an entry exists without --force', function () {
        assert.match(src, /already exists in/);
        assert.match(src, /Re-run with --force to overwrite/);
    });

    it('exits 0 on success and 1 on every error', function () {
        assert.match(src, /process\.exit\(0\);/);
        var exit1Count = (src.match(/process\.exit\(1\)/g) || []).length;
        assert.ok(exit1Count >= 5, 'expected ≥5 process.exit(1) sites (missing name, invalid name, no project, bad type, …), got ' + exit1Count);
    });

    it('distinguishes Added vs Updated in the success message', function () {
        assert.match(src, /\(overwrite \? 'Updated' : 'Added'\)/);
    });
});


// ---------------------------------------------------------------------------
// 15 — help.txt + arguments.json + bin/cli registration
// ---------------------------------------------------------------------------

describe('15 - help.txt + arguments.json', function () {

    it('help.txt documents the `add` action', function () {
        assert.match(helpTxt, /add <name> @<project>/);
        assert.match(helpTxt, /add <name> <bundle> @<project>/);
    });

    it('help.txt documents --connector, --driver synonym, and --force', function () {
        assert.match(helpTxt, /--connector=<type>/);
        assert.match(helpTxt, /--driver=<type>\s+Synonym/);
        assert.match(helpTxt, /--force\s+Overwrite/);
    });

    it('help.txt documents --driver-version (driver pin)', function () {
        assert.match(helpTxt, /--driver-version=<range>/);
        assert.match(helpTxt, /semver range/);
    });

    it('help.txt documents AI connector flags', function () {
        assert.match(helpTxt, /--model=<id>/);
        assert.match(helpTxt, /--api-key=<value>/);
        assert.match(helpTxt, /--base-url=<url>/);
    });

    it('help.txt documents scope enum (local, beta, production, testing)', function () {
        assert.match(helpTxt, /local,\s*\n?\s*beta, production, testing/);
    });

    it('help.txt shows at least one add example', function () {
        assert.match(helpTxt, /gina connector:add /);
    });

    it('arguments.json registers every flag consumed by add.js', function () {
        assert.ok(Array.isArray(argsArr), 'arguments.json must parse to an array');
        [
            '--format', '--connector', '--driver', '--protocol', '--host',
            '--connector-port', '--database', '--username', '--password', '--scope',
            '--model', '--api-key', '--base-url', '--driver-version', '--force',
            '--install'
        ].forEach(function (flag) {
            assert.ok(argsArr.indexOf(flag) > -1, flag + ' must be registered in arguments.json');
        });
    });

    it('arguments.json does NOT register `--port` or `--version` (reserved framework flags)', function () {
        assert.strictEqual(argsArr.indexOf('--port'), -1, '`--port` is reserved for the framework socket port and must not be exposed to connector:add');
        assert.strictEqual(argsArr.indexOf('--version'), -1, '`--version` maps to GINA_VERSION (a value naming no installed framework version is refused); must not be exposed to connector:add');
    });

    it('bin/cli registers `connector:` in allowedOffline (add inherits from list)', function () {
        assert.match(cliSrc, /allowedOffline\s*=\s*\[[\s\S]*?'connector:'[\s\S]*?\]/);
    });
});


// ---------------------------------------------------------------------------
// 16 — --install (Session 5): lockfile detection, range resolution, spawn
// ---------------------------------------------------------------------------

describe('16 - PACKAGE_MANAGERS table', function () {

    it('declares an ordered PACKAGE_MANAGERS probe list', function () {
        assert.match(src, /var PACKAGE_MANAGERS\s*=\s*\[/);
    });

    it('bun is probed first with bun.lockb → `bun add`', function () {
        assert.match(src, /\{\s*pm:\s*'bun',\s*lockfile:\s*'bun\.lockb',\s*add:\s*'add'\s*\}/);
    });

    it('pnpm is probed second with pnpm-lock.yaml → `pnpm add`', function () {
        assert.match(src, /\{\s*pm:\s*'pnpm',\s*lockfile:\s*'pnpm-lock\.yaml',\s*add:\s*'add'\s*\}/);
    });

    it('yarn is probed third with yarn.lock → `yarn add`', function () {
        assert.match(src, /\{\s*pm:\s*'yarn',\s*lockfile:\s*'yarn\.lock',\s*add:\s*'add'\s*\}/);
    });

    it('npm is the last entry with package-lock.json → `npm install`', function () {
        assert.match(src, /\{\s*pm:\s*'npm',\s*lockfile:\s*'package-lock\.json',\s*add:\s*'install'\s*\}/);
    });

    it('bun precedes pnpm precedes yarn precedes npm in source order', function () {
        var bunIdx  = src.indexOf("pm: 'bun'");
        var pnpmIdx = src.indexOf("pm: 'pnpm'");
        var yarnIdx = src.indexOf("pm: 'yarn'");
        var npmIdx  = src.indexOf("pm: 'npm'");
        assert.ok(bunIdx  > 0, 'bun entry must appear');
        assert.ok(pnpmIdx > bunIdx,  'pnpm must follow bun');
        assert.ok(yarnIdx > pnpmIdx, 'yarn must follow pnpm');
        assert.ok(npmIdx  > yarnIdx, 'npm must be the last probe (fallback)');
    });
});


describe('17 - detectPackageManager', function () {

    it('declares detectPackageManager(projectPath)', function () {
        assert.match(src, /var detectPackageManager\s*=\s*function \(projectPath\) \{/);
    });

    it('iterates PACKAGE_MANAGERS in order', function () {
        assert.match(src, /for \(var i = 0; i < PACKAGE_MANAGERS\.length; i\+\+\)/);
    });

    it('probes each lockfile via fs.existsSync on <projectPath>/<lockfile>', function () {
        assert.match(src, /var lockPath = _\(projectPath \+ '\/' \+ PACKAGE_MANAGERS\[i\]\.lockfile, true\);/);
        assert.match(src, /if \(\s*fs\.existsSync\(lockPath\)\s*\)/);
    });

    it('returns the first matching PM with its lockfile and add subcommand', function () {
        assert.match(src, /return \{[\s\S]*?pm\s*:\s*PACKAGE_MANAGERS\[i\]\.pm[\s\S]*?lockfile\s*:\s*PACKAGE_MANAGERS\[i\]\.lockfile[\s\S]*?add\s*:\s*PACKAGE_MANAGERS\[i\]\.add[\s\S]*?\};/);
    });

    it('falls back to npm with lockfile=null when nothing matches', function () {
        assert.match(src, /return \{\s*pm:\s*'npm',\s*lockfile:\s*null,\s*add:\s*'install'\s*\};/);
    });
});


describe('18 - resolveInstallRange', function () {

    it('declares resolveInstallRange(entry, projectPath, pkgName, frameworkRange)', function () {
        assert.match(src, /var resolveInstallRange\s*=\s*function \(entry, projectPath, pkgName, frameworkRange\) \{/);
    });

    it('returns entry.version with source=entry when the pin is set', function () {
        assert.match(src, /if \(entry && entry\.version\) \{\s*return \{ range: String\(entry\.version\), source: 'entry' \};/);
    });

    it('reads <projectPath>/package.json via requireJSON', function () {
        assert.match(src, /var pkgPath = _\(projectPath \+ '\/package\.json', true\);/);
        assert.match(src, /var pkg = requireJSON\(pkgPath\);/);
    });

    it('prefers dependencies over devDependencies', function () {
        assert.match(src, /var deps\s*=\s*pkg\.dependencies\s*\|\|\s*\{\};/);
        assert.match(src, /var devDeps\s*=\s*pkg\.devDependencies\s*\|\|\s*\{\};/);
        var depsIdx    = src.indexOf('if (deps[pkgName])');
        var devDepsIdx = src.indexOf('if (devDeps[pkgName])');
        assert.ok(depsIdx > 0 && devDepsIdx > depsIdx, 'deps[] must be checked before devDependencies[]');
    });

    it('returns source=project when the package is pinned in package.json', function () {
        assert.match(src, /return \{ range: String\(deps\[pkgName\]\),\s*source: 'project' \};/);
        assert.match(src, /return \{ range: String\(devDeps\[pkgName\]\), source: 'project' \};/);
    });

    it('falls back to frameworkRange with source=framework', function () {
        assert.match(src, /return \{ range: frameworkRange, source: 'framework' \};/);
    });

    it('swallows requireJSON errors and falls through to framework', function () {
        assert.match(src, /try \{[\s\S]*?requireJSON\(pkgPath\)[\s\S]*?\} catch \(e\) \{[\s\S]*?\}\s*\n\s*return \{ range: frameworkRange/);
    });
});


describe('19 - runInstall', function () {

    it('declares runInstall(pmInfo, pkg, range, projectPath)', function () {
        assert.match(src, /var runInstall\s*=\s*function \(pmInfo, pkg, range, projectPath\) \{/);
    });

    it('requires child_process lazily inside the function', function () {
        assert.match(src, /var child_process = require\('child_process'\);/);
    });

    it('builds args as [pmInfo.add, pkg + "@" + range]', function () {
        assert.match(src, /var args\s*=\s*\[pmInfo\.add, pkg \+ '@' \+ range\];/);
    });

    it('spawns with cwd=projectPath and stdio inherited', function () {
        assert.match(src, /child_process\.spawnSync\(pmInfo\.pm, args, \{ cwd: projectPath, stdio: 'inherit' \}\)/);
    });

    it('returns 127 on ENOENT (PM binary missing on PATH)', function () {
        assert.match(src, /if \(result\.error && result\.error\.code === 'ENOENT'\)/);
        assert.match(src, /return 127;/);
    });

    it('logs the PM + command + cwd before spawning', function () {
        assert.match(src, /running: ' \+ pmInfo\.pm \+ ' ' \+ args\.join\(' '\) \+ ' \(cwd: ' \+ projectPath/);
    });

    it('propagates result.status as the exit code', function () {
        assert.match(src, /return \(typeof result\.status === 'number'\) \? result\.status : 1;/);
    });
});


describe('20 - runInstallForConnector dispatch', function () {

    it('declares runInstallForConnector(projectPath, connectorType, entry)', function () {
        assert.match(src, /var runInstallForConnector\s*=\s*function \(projectPath, connectorType, entry\) \{/);
    });

    it('AI branch resolves scheme from entry.protocol', function () {
        assert.match(src, /if \(connectorType === 'ai'\) \{[\s\S]*?var scheme = entry\.protocol \? String\(entry\.protocol\)\.split\(':'\)\[0\]\.toLowerCase\(\) : null;/);
    });

    it('AI branch exits 1 when scheme is missing or unknown', function () {
        assert.match(src, /var ai\s*=\s*scheme\s*\?\s*registry\.getAIDriver\(scheme\)\s*:\s*null;[\s\S]*?if \(!ai\) \{[\s\S]*?Cannot auto-install[\s\S]*?return 1;/);
    });

    it('sqlite short-circuits to exit 0 with a "no install needed" note', function () {
        assert.match(src, /if \(info\.builtin\) \{[\s\S]*?no install needed[\s\S]*?return 0;/);
    });

    it('errors out cleanly for unknown connector types with return 1', function () {
        assert.match(src, /if \(!info\) \{[\s\S]*?no driver mapping for connector type[\s\S]*?return 1;/);
    });

    it('logs the detected PM before install (with lockfile name or fallback note)', function () {
        var matches = src.match(/detected package manager:/g) || [];
        assert.ok(matches.length >= 2, 'expected ≥2 "detected package manager:" logs (AI + driver paths), got ' + matches.length);
        assert.match(src, /fallback — no lockfile found/);
    });

    it('logs the resolved range + source tier before install', function () {
        var matches = src.match(/resolving driver range: /g) || [];
        assert.ok(matches.length >= 2, 'expected ≥2 "resolving driver range:" logs (AI + driver paths), got ' + matches.length);
    });

    it('dispatches to runInstall with resolved range and detected PM', function () {
        assert.match(src, /return runInstall\(aiPm, ai\.npm, aiResolv\.range, projectPath\);/);
        assert.match(src, /return runInstall\(pmInfo, info\.npm, resolv\.range, projectPath\);/);
    });
});


describe('21 - --install wiring in init()', function () {

    it('init() honors p[\'install\'] after writing the entry', function () {
        assert.match(src, /if \(p\['install'\]\) \{[\s\S]*?runInstallForConnector\(projectPath, connectorType, entry\);/);
    });

    it('propagates the runInstallForConnector return as process.exit()', function () {
        assert.match(src, /var installExit = runInstallForConnector\(projectPath, connectorType, entry\);\s*process\.exit\(installExit\);/);
    });

    it('suppresses the "Next: run npm install …" hint when --install runs', function () {
        // The install branch must return before buildInstallHint() — the
        // hint is misleading when the install has already started.
        var installBranch = src.match(/if \(p\['install'\]\) \{[\s\S]*?\}/);
        assert.ok(installBranch, '--install branch must exist in init()');
        assert.ok(!/buildInstallHint/.test(installBranch[0]), 'buildInstallHint must not run inside the --install branch');
    });

    it('negative invariant — --install is NOT a default (no "true" default, no auto-install)', function () {
        // A common regression would be to flip the default by checking
        // `p['install'] !== false` or by inverting `--no-install`. Assert
        // the branch uses a simple truthy check on `p['install']`.
        assert.match(src, /if \(p\['install'\]\)/);
        assert.ok(!/p\['install'\] !== false/.test(src), 'must not treat "missing" as true');
        assert.ok(!/p\['no-install'\]/.test(src), '--no-install is not part of Session 5');
        assert.ok(!/p\['yes'\]/.test(src), '--yes is not part of Session 5');
    });
});


describe('22 - help.txt + examples for --install', function () {

    it('help.txt documents --install as an opt-in flag', function () {
        assert.match(helpTxt, /--install\s+After writing the entry/);
        assert.match(helpTxt, /Opt-in; default is/);
    });

    it('help.txt documents the lockfile probe order', function () {
        assert.match(helpTxt, /bun\.lockb/);
        assert.match(helpTxt, /pnpm-lock\.yaml/);
        assert.match(helpTxt, /yarn\.lock/);
        assert.match(helpTxt, /package-lock\.json/);
    });

    it('help.txt documents the install-range resolution order', function () {
        assert.match(helpTxt, /Install range resolution order:/);
        assert.match(helpTxt, /--driver-version=/);
        assert.match(helpTxt, /built-in driver range/);
    });

    it('help.txt shows an --install example', function () {
        assert.match(helpTxt, /gina connector:add [^\n]+--install/);
    });
});
