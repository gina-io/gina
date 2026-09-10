var fs      = require('fs');
var path    = require('path');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/connector/add
 */
/**
 * Adds a connector entry to a project's shared or bundle-level
 * `connectors.json`. Positional-absence scoping:
 *
 *   gina connector:add <name> @<project>           → shared/config/connectors.json
 *   gina connector:add <name> <bundle> @<project>  → <bundle>/config/connectors.json
 *
 * The driver type is inferred from `<name>` when it matches one of the
 * schema enum values (e.g. `redis`, `couchbase`), otherwise `--connector=`
 * (or its synonym `--driver=`) is required. The allowed values mirror the
 * schema enum at `schema/connectors.json`.
 *
 * After writing the entry, prints the exact `npm install <driver>@<range>`
 * command to run, using the resolved version range in this order:
 *   1. the entry's `version` field (set via `--version=`)
 *   2. the framework's built-in driver range table (DRIVER_MAP / AI_DRIVER_MAP)
 *
 * Leading header comments at the top of an existing `connectors.json` are
 * preserved verbatim (everything before the first non-comment `{`). Mid-body `//` or
 * `/* * /` comments are lost — the JSON body is rewritten from the parsed
 * object graph. See help.txt for the caveat.
 *
 * Flags:
 *   --connector=<type>        Driver type (enum: couchbase, mysql, postgresql,
 *                             sqlite, redis, ai). Required unless <name>
 *                             matches.
 *   --driver=<type>           Synonym for --connector=.
 *   --protocol=<uri>          Connection protocol URI scheme (couchbase://,
 *                             mysql://, anthropic://, …).
 *   --host=<host>             Hostname or IP. Comma-separated for clusters.
 *   --connector-port=<port>   Server port. Parsed as number when numeric.
 *                             (Not `--port=` — `--port` is reserved for the
 *                              gina framework socket port.)
 *   --database=<name>         Database / bucket / keyspace name.
 *   --username=<name>         Authentication username.
 *   --password=<value>        Authentication password. `${secret:KEY}` supported.
 *   --scope=<scope>           One of: local, beta, production, testing.
 *   --model=<id>              AI connector only. Default model identifier.
 *   --api-key=<value>         AI connector only. API key. `${secret:KEY}`
 *                             supported.
 *   --base-url=<url>          AI connector only. Custom base URL.
 *   --driver-version=<range>  Optional semver range to pin the driver install.
 *                             (Not `--version=` — `--version` is reserved
 *                              for the gina framework version override.)
 *   --force                   Overwrite an existing entry with the same name.
 *   --install                 After writing the entry, run the detected
 *                             package manager's install command for the
 *                             resolved driver+range. Opt-in; default is
 *                             "write entry, print hint".
 *
 * Usage:
 *   gina connector:add session @myproject --connector=redis --host=127.0.0.1 --connector-port=6379
 *   gina connector:add mydb api @myproject --connector=mysql --database=mydb --username=root
 *   gina connector:add claude @myproject --connector=ai --protocol=anthropic:// --api-key='${secret:ANTHROPIC_API_KEY}'
 *   gina connector:add redis @myproject --install
 *
 * @class Add
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Add(opt, cmd) {
    var self = {};

    /**
     * Allowed `connector` driver types — mirrors the enum in
     * `schema/connectors.json` (`connector.properties.connector.enum`).
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var ALLOWED_CONNECTOR_TYPES = ['couchbase', 'mysql', 'postgresql', 'sqlite', 'redis', 'ai', 'scylladb', 'mongodb', 'duckdb'];

    /**
     * Allowed `scope` values — mirrors the enum in `schema/connectors.json`
     * (`connector.properties.scope.enum`).
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var ALLOWED_SCOPES = ['local', 'beta', 'production', 'testing'];

    /**
     * Connector driver registry — single source of truth for the
     * logical `connector` type → npm driver package + semver range
     * mapping (`DRIVER_MAP`) and the AI `protocol` scheme → npm driver
     * mapping (`AI_DRIVER_MAP`). Previously duplicated inline here and
     * in `lib/cmd/connector/list.js`; both now read from the shared
     * module. See `lib/connector-registry/src/main.js`.
     *
     * @inner
     * @constant
     */
    var registry = lib.connectorRegistry;

    /**
     * Ordered package-manager probe list for `--install`. Lockfiles are
     * checked in this order; the first match wins; npm is the default
     * fallback when no lockfile is found. The `add` field names the install
     * subcommand for each manager (`npm install` / `yarn add` / `pnpm add` /
     * `bun add`).
     *
     * @inner
     * @constant
     * @type {Array<{pm: string, lockfile: string, add: string}>}
     */
    var PACKAGE_MANAGERS = [
        { pm: 'bun',  lockfile: 'bun.lockb',         add: 'add' },
        { pm: 'pnpm', lockfile: 'pnpm-lock.yaml',    add: 'add' },
        { pm: 'yarn', lockfile: 'yarn.lock',         add: 'add' },
        { pm: 'npm',  lockfile: 'package-lock.json', add: 'install' }
    ];

    /**
     * Parse positionals, validate scope/target, merge into the existing
     * `connectors.json`, write it back (preserving a leading comment
     * header when present), and print the install hint.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        var positionals = extractPositionals(process.argv);
        var connectorName = positionals[0] || null;
        var bundleName    = positionals[1] || null;

        if (!connectorName) {
            console.error('Usage: gina connector:add <name> [<bundle>] @<project> [--connector=<type>] [--host=...] [--connector-port=...]');
            process.exit(1);
            return;
        }

        if ( !/^[a-z0-9_\-]+$/i.test(connectorName) ) {
            console.error('Connector name `' + connectorName + '` is not valid. Use [a-zA-Z0-9_-] only.');
            process.exit(1);
            return;
        }

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            console.error('`connector:add` requires `@<project>`. Did you forget `@<project_name>`?');
            process.exit(1);
            return;
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('Project @' + self.projectName + ' is not registered. Run `gina project:list` to see registered projects.');
            process.exit(1);
            return;
        }

        var projectPath = self.projects[self.projectName].path;
        var target      = resolveTarget(projectPath, bundleName);
        if (!target) return; // resolveTarget already exited

        var p             = self.params || {};
        var connectorType = p['connector'] || p['driver'] || null;
        if (!connectorType && ALLOWED_CONNECTOR_TYPES.indexOf(connectorName) > -1) {
            connectorType = connectorName;
        }
        if (!connectorType) {
            console.error('`connector:add` needs a connector type — pass `--connector=<type>` or name the entry after one of: ' + ALLOWED_CONNECTOR_TYPES.join(', ') + '.');
            process.exit(1);
            return;
        }
        if (ALLOWED_CONNECTOR_TYPES.indexOf(connectorType) < 0) {
            console.error('Unknown connector type `' + connectorType + '`. Allowed values: ' + ALLOWED_CONNECTOR_TYPES.join(', ') + '.');
            process.exit(1);
            return;
        }

        var entry = buildEntry(connectorName, connectorType, p);
        if (!entry) return; // buildEntry already exited on invalid scope

        var parsed = readExistingFile(target);
        if (!parsed) return; // readExistingFile already exited on parse error

        if (typeof parsed.data[connectorName] != 'undefined' && !p['force']) {
            console.error('Connector `' + connectorName + '` already exists in ' + target + '. Re-run with --force to overwrite.');
            process.exit(1);
            return;
        }

        var overwrite = (typeof parsed.data[connectorName] != 'undefined');
        var out       = mergeEntry(parsed.data, connectorName, entry);
        writeFile(target, parsed.header, out);

        console.log(
            (overwrite ? 'Updated' : 'Added') +
            ' connector `' + connectorName + '` (' + connectorType + ')' +
            (bundleName ? ' in bundle `' + bundleName + '`' : ' in shared scope') +
            ' at ' + target
        );

        if (p['install']) {
            var installExit = runInstallForConnector(projectPath, connectorType, entry);
            process.exit(installExit);
            return;
        }

        var hint = buildInstallHint(connectorType, entry);
        if (hint) {
            console.log(hint);
        }

        process.exit(0);
    };

    /**
     * Walks `process.argv` from index 3 and returns every non-flag,
     * non-`@<project>` token in order. CmdHelper already consumes
     * `--` flags and `@<project>` tokens; the remainder are our
     * positionals: `[0]` is the connector logical name, `[1]` is the
     * optional bundle name.
     *
     * @inner
     * @private
     * @param {string[]} argv - process.argv
     * @returns {string[]}
     */
    var extractPositionals = function (argv) {
        var out = [];
        for (var i = 3, len = argv.length; i < len; i++) {
            var tok = argv[i];
            if ( typeof(tok) != 'string' ) continue;
            if ( /^\-\-/.test(tok) ) continue;
            if ( /^\-/.test(tok)  ) continue;
            if ( /^\@/.test(tok)  ) continue;
            out.push(tok);
        }
        return out;
    };

    /**
     * Resolves the target `connectors.json` path based on whether a bundle
     * was supplied. Validates the bundle against `manifest.json` when one
     * is given. Exits the process on any error and returns null.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string|null} bundleName
     * @returns {string|null}
     */
    var resolveTarget = function (projectPath, bundleName) {
        if (!bundleName) {
            return _(projectPath + '/shared/config/connectors.json', true);
        }
        var manifest = loadManifest(projectPath);
        if (!manifest || !manifest.bundles) {
            console.error('Cannot read `' + projectPath + '/manifest.json`. Project is missing or malformed.');
            process.exit(1);
            return null;
        }
        if ( !manifest.bundles[bundleName] ) {
            console.error('Bundle [ ' + bundleName + ' ] is not registered inside `@' + self.projectName + '`.');
            process.exit(1);
            return null;
        }
        var bundleSrc = manifest.bundles[bundleName].src;
        if (!bundleSrc) {
            console.error('Bundle [ ' + bundleName + ' ] has no `src` entry in manifest.json.');
            process.exit(1);
            return null;
        }
        return _(projectPath + '/' + bundleSrc + '/config/connectors.json', true);
    };

    /**
     * Loads `<projectPath>/manifest.json` with comment tolerance.
     * Returns null on missing or malformed file so the caller can exit
     * with a precise error message.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @returns {object|null}
     */
    var loadManifest = function (projectPath) {
        try {
            var p = _(projectPath + '/manifest.json', true);
            if ( !fs.existsSync(p) ) return null;
            return requireJSON(p);
        } catch (e) {
            return null;
        }
    };

    /**
     * Builds the connector entry object from the parsed flags. Only
     * supplied fields are written. `connector` is omitted when the
     * driver type matches the logical name (same convention as
     * `list.js::resolveDriver`). Validates `scope` against the enum.
     *
     * @inner
     * @private
     * @param {string} connectorName
     * @param {string} connectorType
     * @param {object} p - CmdHelper-parsed flags (self.params)
     * @returns {object|null} Entry object, or null after exiting on invalid scope
     */
    var buildEntry = function (connectorName, connectorType, p) {
        var entry = {};
        if (connectorType !== connectorName) {
            entry.connector = connectorType;
        }
        if (p['protocol']) entry.protocol = String(p['protocol']);
        if (p['host'])     entry.host     = String(p['host']);
        if (typeof p['connector-port'] != 'undefined' && p['connector-port'] !== true) {
            var portNum = Number(p['connector-port']);
            entry.port = isNaN(portNum) ? String(p['connector-port']) : portNum;
        }
        if (p['database']) entry.database = String(p['database']);
        if (p['username']) entry.username = String(p['username']);
        if (p['password']) entry.password = String(p['password']);
        if (p['scope']) {
            var sc = String(p['scope']);
            if (ALLOWED_SCOPES.indexOf(sc) < 0) {
                console.error('Scope `' + sc + '` is not valid. Allowed: ' + ALLOWED_SCOPES.join(', ') + '.');
                process.exit(1);
                return null;
            }
            entry.scope = sc;
        }
        if (p['model'])    entry.model   = String(p['model']);
        if (p['api-key'])  entry.apiKey  = String(p['api-key']);
        if (p['base-url']) entry.baseURL = String(p['base-url']);
        if (p['driver-version']) entry.version = String(p['driver-version']);
        return entry;
    };

    /**
     * Reads the existing `connectors.json` (if any), preserves any leading
     * comment header (everything before the first non-comment `{`), and parses the
     * JSON body with comment tolerance via `requireJSON`.
     *
     * Returns `{ header: string, data: object }`. On a parse failure, exits
     * with a clear message and returns null. When the file does not exist,
     * verifies the parent directory exists and returns an empty shape.
     *
     * @inner
     * @private
     * @param {string} target - Absolute path to connectors.json
     * @returns {{header: string, data: object}|null}
     */
    var readExistingFile = function (target) {
        if ( !fs.existsSync(target) ) {
            var parentDir = path.dirname(target);
            if ( !fs.existsSync(parentDir) ) {
                console.error('Config directory does not exist: `' + parentDir + '`. Create the bundle first (gina bundle:add), then re-run.');
                process.exit(1);
                return null;
            }
            return { header: '', data: {} };
        }
        var raw;
        try {
            raw = fs.readFileSync(target, 'utf8');
        } catch (e) {
            console.error('Cannot read `' + target + '`: ' + e.message);
            process.exit(1);
            return null;
        }
        // Comment-aware: the scaffolded template's `// "couchbase": {` puts a
        // brace inside a comment, so a naive first-brace scan lands there and
        // corrupts the rewrite. splitHeader finds the first STRUCTURAL `{`.
        var header = lib.jsonConfigHeader.splitHeader(raw).header;
        var data;
        try {
            data = requireJSON(target) || {};
        } catch (e) {
            console.error('Cannot parse `' + target + '`: ' + e.message);
            process.exit(1);
            return null;
        }
        return { header: header, data: data };
    };

    /**
     * Merges `entry` into `existing` under `connectorName`, preserving key
     * order. `$schema` is pinned at the top; existing keys keep their
     * order; a fresh entry is appended. An overwrite replaces the value
     * at the existing key position.
     *
     * @inner
     * @private
     * @param {object} existing
     * @param {string} connectorName
     * @param {object} entry
     * @returns {object}
     */
    var mergeEntry = function (existing, connectorName, entry) {
        var out = {};
        if (existing.$schema) {
            out.$schema = existing.$schema;
        } else {
            out.$schema = 'https://gina.io/schema/connectors.json';
        }
        var overwrite = (typeof existing[connectorName] != 'undefined');
        for (var k in existing) {
            if (k === '$schema') continue;
            if (k === connectorName) {
                out[connectorName] = entry;
            } else {
                out[k] = existing[k];
            }
        }
        if (!overwrite) {
            out[connectorName] = entry;
        }
        return out;
    };

    /**
     * Writes the merged config back to disk. Preserves the leading comment
     * header verbatim when present, then serialises the JSON body with
     * 4-space indentation and a trailing newline.
     *
     * @inner
     * @private
     * @param {string} target
     * @param {string} header - Text before the first non-comment `{` in the existing file
     * @param {object} data - Full merged config object
     */
    var writeFile = function (target, header, data) {
        var body = JSON.stringify(data, null, 4);
        var text = (header || '') + body + '\n';
        lib.generator.createFileFromDataSync(text, target);
    };

    /**
     * Builds the "Next: run npm install …" hint line. For AI connectors,
     * resolves the driver from `entry.protocol`; for everything else, from
     * the static DRIVER_MAP. When the entry carries a `version` pin that
     * overrides the framework-declared range.
     *
     * @inner
     * @private
     * @param {string} connectorType
     * @param {object} entry
     * @returns {string|null}
     */
    var buildInstallHint = function (connectorType, entry) {
        if (connectorType === 'ai') {
            var scheme = entry.protocol ? String(entry.protocol).split(':')[0].toLowerCase() : null;
            var ai     = scheme ? registry.getAIDriver(scheme) : null;
            if (!ai) {
                return 'Next: set `protocol` to one of: ' + registry.getAISchemes().map(function(k){ return k + '://'; }).join(', ') + ' — then run the matching npm install.';
            }
            var range = entry.version || ai.range;
            return 'Next: run `npm install ' + ai.npm + '@"' + range + '"` inside your project root.';
        }
        var info = registry.getDriver(connectorType);
        if (!info) return null;
        if (info.builtin) {
            return 'No install needed — ' + info.note + '.';
        }
        var r = entry.version || info.range;
        return 'Next: run `npm install ' + info.npm + '@"' + r + '"` inside your project root.';
    };

    /**
     * Detect the project's package manager by probing well-known lockfiles
     * in PACKAGE_MANAGERS order. Returns the first hit, or npm as the
     * fallback when no lockfile is present.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @returns {{pm: string, lockfile: string|null, add: string}}
     */
    var detectPackageManager = function (projectPath) {
        for (var i = 0; i < PACKAGE_MANAGERS.length; i++) {
            var lockPath = _(projectPath + '/' + PACKAGE_MANAGERS[i].lockfile, true);
            if ( fs.existsSync(lockPath) ) {
                return {
                    pm       : PACKAGE_MANAGERS[i].pm,
                    lockfile : PACKAGE_MANAGERS[i].lockfile,
                    add      : PACKAGE_MANAGERS[i].add
                };
            }
        }
        return { pm: 'npm', lockfile: null, add: 'install' };
    };

    /**
     * Resolve the install range for a driver in priority order:
     *   1. `entry.version` — the pin just written via --driver-version=
     *   2. project `package.json` > dependencies / devDependencies
     *   3. framework-declared driver range (DRIVER_MAP / AI_DRIVER_MAP)
     *
     * Returns both the resolved range and the source tag so the CLI can log
     * which tier won.
     *
     * @inner
     * @private
     * @param {object} entry - Connector entry object
     * @param {string} projectPath - Absolute project root
     * @param {string} pkgName - npm package name (e.g. `ioredis`)
     * @param {string} frameworkRange - Default range from the driver map
     * @returns {{range: string, source: 'entry'|'project'|'framework'}}
     */
    var resolveInstallRange = function (entry, projectPath, pkgName, frameworkRange) {
        if (entry && entry.version) {
            return { range: String(entry.version), source: 'entry' };
        }
        try {
            var pkgPath = _(projectPath + '/package.json', true);
            if ( fs.existsSync(pkgPath) ) {
                var pkg = requireJSON(pkgPath);
                if (pkg) {
                    var deps    = pkg.dependencies    || {};
                    var devDeps = pkg.devDependencies || {};
                    if (deps[pkgName])    return { range: String(deps[pkgName]),    source: 'project' };
                    if (devDeps[pkgName]) return { range: String(devDeps[pkgName]), source: 'project' };
                }
            }
        } catch (e) {
            // Swallow — fall through to the framework range.
        }
        return { range: frameworkRange, source: 'framework' };
    };

    /**
     * Spawn the detected package manager's install command for
     * `pkg@range` with `cwd=projectPath` and `stdio: 'inherit'` so the user
     * sees live install output. Returns the child's exit code (or 127 when
     * the PM binary is missing on PATH).
     *
     * @inner
     * @private
     * @param {{pm: string, add: string}} pmInfo - detectPackageManager result
     * @param {string} pkg - npm package name
     * @param {string} range - Semver range (will be quoted on the command line)
     * @param {string} projectPath - Spawn cwd
     * @returns {number} Propagated exit code
     */
    var runInstall = function (pmInfo, pkg, range, projectPath) {
        var child_process = require('child_process');
        var args          = [pmInfo.add, pkg + '@' + range];
        console.log('[' + pmInfo.pm + '] running: ' + pmInfo.pm + ' ' + args.join(' ') + ' (cwd: ' + projectPath + ')');
        var result = child_process.spawnSync(pmInfo.pm, args, { cwd: projectPath, stdio: 'inherit' });
        if (result.error && result.error.code === 'ENOENT') {
            console.error('`' + pmInfo.pm + '` binary not found on PATH. Install it or run the command manually:');
            console.error('  ' + pmInfo.pm + ' ' + args.join(' '));
            return 127;
        }
        if (typeof result.status === 'number' && result.status !== 0) {
            console.error('[' + pmInfo.pm + '] install exited with code ' + result.status);
        }
        return (typeof result.status === 'number') ? result.status : 1;
    };

    /**
     * Dispatch `--install` to the correct driver table
     * (`lib.connectorRegistry.getDriver` / `.getAIDriver`), resolve the
     * range and package manager, and run the install. Handles sqlite
     * (no-op, exit 0) and AI with missing/unknown protocol (exit 1
     * with guidance).
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string} connectorType
     * @param {object} entry
     * @returns {number} Exit code for the caller to propagate
     */
    var runInstallForConnector = function (projectPath, connectorType, entry) {
        if (connectorType === 'ai') {
            var scheme = entry.protocol ? String(entry.protocol).split(':')[0].toLowerCase() : null;
            var ai     = scheme ? registry.getAIDriver(scheme) : null;
            if (!ai) {
                console.error('Cannot auto-install — set `protocol` to one of: ' + registry.getAISchemes().map(function(k){ return k + '://'; }).join(', ') + ' and re-run.');
                return 1;
            }
            var aiResolv = resolveInstallRange(entry, projectPath, ai.npm, ai.range);
            var aiPm     = detectPackageManager(projectPath);
            console.log('[install] detected package manager: ' + aiPm.pm + (aiPm.lockfile ? ' (' + aiPm.lockfile + ')' : ' (fallback — no lockfile found)'));
            console.log('[install] resolving driver range: ' + aiResolv.range + ' (source: ' + aiResolv.source + ')');
            return runInstall(aiPm, ai.npm, aiResolv.range, projectPath);
        }
        var info = registry.getDriver(connectorType);
        if (!info) {
            console.error('Cannot auto-install — no driver mapping for connector type `' + connectorType + '`.');
            return 1;
        }
        if (info.builtin) {
            console.log('[install] no install needed — ' + (info.note || 'built-in driver') + '.');
            return 0;
        }
        var resolv = resolveInstallRange(entry, projectPath, info.npm, info.range);
        var pmInfo = detectPackageManager(projectPath);
        console.log('[install] detected package manager: ' + pmInfo.pm + (pmInfo.lockfile ? ' (' + pmInfo.lockfile + ')' : ' (fallback — no lockfile found)'));
        console.log('[install] resolving driver range: ' + resolv.range + ' (source: ' + resolv.source + ')');
        return runInstall(pmInfo, info.npm, resolv.range, projectPath);
    };

    init();
}

module.exports = Add;
