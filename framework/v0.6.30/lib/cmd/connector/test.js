var fs      = require('fs');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/connector/test
 */
/**
 * Probes a project's configured connectors for readiness OUTSIDE a request —
 * resolves the connector config (shared, or shared+bundle merged), and for
 * each connector validates that (a) its `connector` type / `ai` protocol is
 * recognised, (b) its npm driver is installed at `<project>/node_modules`,
 * (c) every `${secret:KEY}` placeholder it requires resolves from the current
 * environment, and (d) no config value is a bare `${ENV_VAR}` placeholder
 * (config-load substitutes only `${secret:KEY}`, so a bare `${ENV_VAR}` would be
 * used verbatim as the value). Exits non-zero when ANY connector fails a check,
 * so it can gate
 * a CI / pre-deploy step. The runtime sibling of `connector:list` (which only
 * reports driver-install status) and `secrets:check` (which only reports env
 * presence) — `connector:test` answers the single question "is this connector
 * ready to use?".
 *
 * The DEFAULT is validate-only: no network, no credentials beyond the env, no
 * connector class instantiated — so it is safe to run in CI. The `--connect`
 * opt-in adds a REAL connectivity probe. This release implements the live probe
 * for `ai` connectors only — it calls `client.models.list()` (a credentialed
 * GET that authenticates with ZERO generation tokens; for an `ollama://`
 * connector it confirms the local server is up). A `--connect` against a
 * DB/cache connector reports the live probe as SKIPPED and validates config /
 * driver / secrets only — the live DB/cache probe is a follow-up, because every
 * DB connector class loads `core/gna` (which exits the process outside a booted
 * bundle), so it cannot be instantiated the way the (core/gna-free) AI
 * connector is. `--connect` NEVER spends generation tokens: when a provider
 * client exposes no `models.list`, the live probe reports inconclusive rather
 * than falling back to a paid completion.
 *
 * Like `connector:infer`, the connector classes are NOT instantiated through
 * `getModel` (its per-bundle registry is empty in CLI scope). The AI connector
 * is built directly: `setPath('project', <projectPath>)` so the provider SDK
 * resolves from the target project, then `new AIConnector(entry).onReady(...)`.
 * `${secret:KEY}` placeholders are resolved from `process.env` via `lib.secrets`
 * — fail-closed, and the resolved value is NEVER echoed (only the key NAME is
 * surfaced, and only as part of the SET/UNSET status, never the secret value).
 *
 * Operational note (mirrors `connector:infer` / `secrets:check`): a detached
 * CLI invocation only sees its own shell environment, not secrets a supervisor
 * injects at bundle start. Run against a shell that exports the keys.
 *
 * Usage:
 *   gina connector:test                                  # every connector in every project
 *   gina connector:test @<project>                       # every connector in one project (shared + bundles)
 *   gina connector:test <connector> @<project>           # one connector (shared / merged view)
 *   gina connector:test <connector> <bundle> @<project>  # one connector as <bundle> sees it
 *   gina connector:test @<project> --format=json         # machine-readable report
 *   gina connector:test <connector> @<project> --connect  # add the live probe (ai: models.list)
 *
 * Exit codes: 0 when every probed connector passes every check; 1 when any
 * connector fails (unknown type / driver not installed / required secret unset
 * / inert `${ENV_VAR}` placeholder / live `--connect` probe failed), or on a
 * usage error (unregistered project / bundle, missing project directory, bad
 * `--format`, connector not found).
 *
 * @class Test
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 * // Gate a deploy: fail the pipeline if any connector is misconfigured.
 * //   $ gina connector:test @myproject --format=json || exit 1
 */
function Test(opt, cmd) {
    var self = { format: 'text', doConnect: false, anyFail: false };

    /**
     * Pure connector-entry resolver — merges shared + bundle `connectors.json`
     * maps (bundle wins) and selects one entry by name. See
     * `lib/connector-config/src/main.js`.
     *
     * @inner
     * @constant
     */
    var cfg = lib.connectorConfig;

    /**
     * Secrets resolver / enumerator — `getRequiredKeys(entry)` lists the
     * `${secret:KEY}` placeholders a connector requires (read-only,
     * non-throwing); `resolve(entry)` substitutes them in place from
     * `process.env` (used only for the `--connect` probe). See
     * `lib/secrets/src/main.js`.
     *
     * @inner
     * @constant
     */
    var secrets = lib.secrets;

    /**
     * Connector driver registry — logical `connector` type → npm driver
     * package (`DRIVER_MAP`) and AI `protocol` scheme → npm driver
     * (`AI_DRIVER_MAP`). Single source of truth shared with `connector:list`
     * / `connector:add`. See `lib/connector-registry/src/main.js`.
     *
     * @inner
     * @constant
     */
    var registry = lib.connectorRegistry;

    /**
     * Deadline for the `--connect` live probe (`ai` models.list). A bad
     * endpoint would otherwise hang a CI process; the AI HTTP client carries
     * no connection pool, so `process.exit()` at the end is the only teardown
     * needed.
     *
     * @inner
     * @constant
     * @type {number}
     */
    var CONNECT_TIMEOUT_MS = 15000;

    /**
     * Parse --format / --connect, resolve project + optional bundle via
     * CmdHelper, dispatch to the right tester, and (after any async probes)
     * exit non-zero when any connector failed.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            if ( /^\-\-format\=/.test(arg) ) {
                self.format = arg.split(/\=/)[1] || 'text';
            }
        }
        if (self.format !== 'text' && self.format !== 'json') {
            console.error('--format must be `text` or `json` (got `' + self.format + '`)');
            process.exit(1);
            return;
        }

        var p = self.params || {};
        self.doConnect = !!p['connect'];

        // Positionals: [0] connector logical name, [1] optional bundle name
        // (same convention as `connector:infer`). Absence of [0] selects the
        // "every connector" modes.
        var positionals   = extractPositionals(process.argv);
        var connectorName = positionals[0] || null;
        var bundleName    = positionals[1] || null;

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            if (connectorName) {
                console.error('`connector:test <connector>` requires `@<project>`. Did you forget `@<project_name>`?');
                process.exit(1);
                return;
            }
            // No project → test every connector in every registered project.
            testAllProjects();
            return;
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('Project @' + self.projectName + ' is not registered. Run `gina project:list` to see registered projects.');
            process.exit(1);
            return;
        }

        var projectPath = self.projects[self.projectName].path;

        if (connectorName) {
            if (bundleName) {
                var manifest = loadManifest(projectPath);
                if (!manifest || !manifest.bundles || !manifest.bundles[bundleName]) {
                    console.error('Bundle [ ' + bundleName + ' ] is not registered inside `@' + self.projectName + '`.');
                    process.exit(1);
                    return;
                }
            }
            testSingle(self.projectName, bundleName, connectorName);
        } else {
            testProject(self.projectName);
        }
    };

    /**
     * Walks `process.argv` from index 3 and returns every non-flag,
     * non-`@<project>` token in order: `[0]` the connector logical name,
     * `[1]` the optional bundle name. Mirrors `connector:infer`'s extractor.
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
     * Reads a JSON file with tolerance for line and block comments via
     * `requireJSON` (connectors files routinely carry comments). Returns
     * `null` on any parse or I/O error. Mirrors `connector:list` / `infer`.
     *
     * @inner
     * @private
     * @param {string} filePath
     * @returns {object|null}
     */
    var readJsonSafe = function (filePath) {
        try {
            if ( !fs.existsSync(filePath) ) return null;
            return requireJSON(filePath);
        } catch (e) {
            return null;
        }
    };

    /**
     * Loads `<projectPath>/manifest.json` (comment-tolerant). Returns null
     * on failure so the caller can report precisely.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @returns {object|null}
     */
    var loadManifest = function (projectPath) {
        return readJsonSafe(_(projectPath + '/manifest.json', true));
    };

    /**
     * Resolves the npm driver for a connector entry. For `ai`, reads
     * `entry.protocol` and resolves via `registry.getAIDriver(scheme)`;
     * otherwise via `registry.getDriver(type)` (falling back to the logical
     * key when `entry.connector` is absent, matching `connector:list`).
     *
     * @inner
     * @private
     * @param {object} entry
     * @param {string} key - Logical connector key
     * @returns {{type:string, npm:?string, range:?string, builtin:boolean, note:?string, unresolved:boolean}}
     */
    var resolveDriver = function (entry, key) {
        var type = (entry && entry.connector) ? entry.connector : key;

        if (type === 'ai') {
            var protocol = (entry && entry.protocol) ? String(entry.protocol) : '';
            var scheme   = protocol.split(':')[0].toLowerCase();
            var ai       = registry.getAIDriver(scheme);
            if (ai) {
                return { type: type, npm: ai.npm, range: ai.range, builtin: false, note: null, unresolved: false };
            }
            return {
                type       : type,
                npm        : null,
                range      : null,
                builtin    : false,
                note       : 'unknown `ai` protocol — set `protocol` to one of: ' + registry.getAISchemes().map(function (k) { return k + '://'; }).join(', '),
                unresolved : true
            };
        }

        var info = registry.getDriver(type);
        if (!info) {
            return { type: type, npm: null, range: null, builtin: false, note: 'unknown connector type — no driver mapping registered', unresolved: true };
        }
        if (info.builtin) {
            return { type: type, npm: null, range: null, builtin: true, note: info.note || null, unresolved: false };
        }
        return { type: type, npm: info.npm, range: info.range, builtin: false, note: null, unresolved: false };
    };

    /**
     * Probes `<projectPath>/node_modules/<driverNpm>/package.json` for the
     * driver's install status + version. Scoped packages (e.g.
     * `@anthropic-ai/sdk`) resolve naturally. Mirrors `connector:list`.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {?string} driverNpm
     * @returns {{installed:boolean, version:?string}}
     */
    var checkInstalled = function (projectPath, driverNpm) {
        if (!driverNpm) return { installed: false, version: null };
        var pkgPath = _(projectPath + '/node_modules/' + driverNpm + '/package.json', true);
        if ( !fs.existsSync(pkgPath) ) return { installed: false, version: null };
        var pkg = readJsonSafe(pkgPath);
        if (!pkg) return { installed: true, version: null };
        return { installed: true, version: pkg.version || null };
    };

    /**
     * True when `key` resolves to a non-empty string in `process.env` — the
     * exact condition under which the env secrets backend resolves
     * successfully. Mirrors `secrets:check`'s `isEnvSet`.
     *
     * @inner
     * @private
     * @param {string} key
     * @returns {boolean}
     */
    var isEnvSet = function (key) {
        return typeof process.env[key] === 'string' && process.env[key] !== '';
    };

    /**
     * Whole-string bare `${ENV_VAR}` placeholder — UPPER_SNAKE, NO `secret:`
     * prefix. `core/config.js` only substitutes `${secret:KEY}` (via
     * `lib.secrets`); a bare `${ENV_VAR}` is written verbatim, so the connector
     * would use the literal placeholder as its value. Lowercase whisper
     * templates (`${bundle}`, `${host}`, `${scope}`, …) ARE resolved at load, so
     * the anchored UPPER_SNAKE class deliberately excludes them — and excludes
     * `${secret:KEY}` too, whose `secret:` prefix has a lowercase letter and a
     * colon.
     *
     * @inner
     * @constant
     * @type {RegExp}
     */
    var INERT_PLACEHOLDER_RE = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

    /**
     * Collects every string value in `node` that is an inert bare `${ENV_VAR}`
     * placeholder (see `INERT_PLACEHOLDER_RE`). Walks nested objects / arrays so
     * a placeholder anywhere in the entry is surfaced. The collected value is
     * the placeholder text itself (e.g. `"${ANTHROPIC_API_KEY}"`), which is NOT
     * a secret — it is the literal, unresolved token — so it is safe to echo.
     *
     * @inner
     * @private
     * @param {*} node - Connector entry, or a nested value during recursion
     * @param {string} [path] - Dotted field path, for the report
     * @param {Array<{path:string, value:string}>} [out]
     * @returns {Array<{path:string, value:string}>}
     */
    var collectInertPlaceholders = function (node, path, out) {
        out  = out  || [];
        path = path || '';
        if (node == null) return out;
        if (typeof node === 'string') {
            if (INERT_PLACEHOLDER_RE.test(node)) out.push({ path: path || '(value)', value: node });
            return out;
        }
        if (typeof node === 'object') {
            for (var k in node) {
                if (Object.prototype.hasOwnProperty.call(node, k)) {
                    collectInertPlaceholders(node[k], path ? (path + '.' + k) : k, out);
                }
            }
        }
        return out;
    };

    /**
     * A connector passes overall when every NON-skipped check is `ok`. A
     * skipped check (e.g. a deferred DB `--connect` probe) does not fail the
     * connector. Pure — exercised directly by the test suite.
     *
     * @inner
     * @private
     * @param {{checks:Array<{ok:?boolean, skipped:boolean}>}} result
     * @returns {boolean}
     */
    var computeOk = function (result) {
        for (var i = 0; i < result.checks.length; i++) {
            var c = result.checks[i];
            if (c.skipped === true) continue;
            if (c.ok !== true) return false;
        }
        return true;
    };

    /**
     * Builds a single connector's validate-only result (config / driver /
     * secrets checks, all synchronous) and, when `--connect` is set, the
     * connect check. For an `ai` connector whose prerequisites pass, returns a
     * `runProbe` thunk that performs the async `models.list()` probe and fills
     * the connect check in place; otherwise `runProbe` is `null`.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {object} entry - Resolved connector entry
     * @param {string} name - Connector logical name
     * @param {string} source - `'shared'` | `'bundle'` | `'override'` | `'merged'`
     * @param {?string} bundle - Bundle name, or null for a shared entry
     * @returns {{result:object, runProbe:?function():Promise}}
     */
    var evaluateConnector = function (projectPath, entry, name, source, bundle) {
        entry = entry || {};
        var checks = [];

        // (1) config — connector type / ai protocol recognised
        var driver   = resolveDriver(entry, name);
        var configOk = !driver.unresolved;
        checks.push({
            name : 'config',
            ok   : configOk,
            detail : configOk
                ? (driver.type === 'ai'
                    ? ('ai connector (' + (entry.protocol ? String(entry.protocol) : 'no protocol') + ')')
                    : (driver.type + ' connector'))
                : (driver.note || 'unresolved connector type')
        });

        // (2) driver — npm package installed (or built-in)
        var driverOk, driverDetail;
        if (!configOk) {
            driverOk     = false;
            driverDetail = 'driver unresolved — fix the connector type / protocol first';
        } else if (driver.builtin) {
            driverOk     = true;
            driverDetail = driver.note || 'built-in';
        } else {
            var inst = checkInstalled(projectPath, driver.npm);
            driverOk     = inst.installed;
            driverDetail = inst.installed
                ? (driver.npm + (inst.version ? (' ' + inst.version) : '') + ' installed')
                : (driver.npm + ' not installed — run `npm install ' + driver.npm + '`');
        }
        checks.push({ name: 'driver', ok: driverOk, detail: driverDetail });

        // (3) secrets — every ${secret:KEY} placeholder resolves from env
        var keys     = secrets.getRequiredKeys(entry);
        var statuses = [];
        var allSet   = true;
        var setCount = 0;
        for (var ki = 0; ki < keys.length; ki++) {
            var ok = isEnvSet(keys[ki]);
            if (ok) { setCount++; } else { allSet = false; }
            statuses.push({ key: keys[ki], set: ok });
        }
        checks.push({
            name   : 'secrets',
            ok     : allSet,
            detail : (keys.length === 0)
                ? 'no secrets required'
                : (keys.length + ' required: ' + setCount + ' set, ' + (keys.length - setCount) + ' unset'),
            keys   : statuses
        });

        // (4) placeholders — a bare ${ENV_VAR} is INERT: config-load substitutes
        //     only ${secret:KEY}, so a bare ${ENV_VAR} is written verbatim and the
        //     connector would use the literal placeholder string as its value. The
        //     surfaced text is the unresolved token, not a secret, so it is safe
        //     to echo. (Lowercase whisper templates like ${bundle} are excluded.)
        var inert = collectInertPlaceholders(entry);
        checks.push({
            name   : 'envvar',
            ok     : inert.length === 0,
            detail : (inert.length === 0)
                ? 'no inert ${ENV_VAR} placeholders'
                : (inert.length + ' inert ${ENV_VAR} placeholder' + (inert.length === 1 ? '' : 's')
                    + ' — use ${secret:KEY}: ' + inert.map(function (p) { return p.path + '=' + p.value; }).join(', ')),
            inert  : inert
        });

        var result = {
            name      : name,
            connector : driver.type,
            source    : source,
            bundle    : bundle || null,
            checks    : checks,
            ok        : false
        };

        // (4) connect — opt-in live probe (ai only this release)
        var runProbe = null;
        if (self.doConnect) {
            if (driver.type === 'ai') {
                if (configOk && driverOk && allSet) {
                    var connectCheck = { name: 'connect', ok: null, skipped: false, detail: 'probing…' };
                    checks.push(connectCheck);
                    runProbe = function () {
                        return probeAI(projectPath, entry).then(function (r) {
                            connectCheck.ok      = (typeof r.ok === 'boolean') ? r.ok : null;
                            connectCheck.skipped = (r.skipped === true);
                            connectCheck.detail  = r.detail;
                        });
                    };
                } else {
                    checks.push({ name: 'connect', ok: null, skipped: true, detail: 'connect probe skipped — config / driver / secrets must pass first' });
                }
            } else {
                checks.push({
                    name    : 'connect',
                    ok      : null,
                    skipped : true,
                    detail  : 'live ' + driver.type + ' probe not yet available — config / driver / secrets validated only (DB/cache connect is a follow-up)'
                });
            }
        }

        return { result: result, runProbe: runProbe };
    };

    /**
     * Instantiates the `ai` connector directly and verifies connectivity +
     * credentials with a single zero-generation-token `client.models.list()`
     * call. `setPath('project', ...)` points the SDK require at the target
     * project; `${secret:KEY}` placeholders are resolved on a COPY of the
     * entry (never mutating the caller's). When the provider client exposes no
     * `models.list`, the probe is reported INCONCLUSIVE (skipped) rather than
     * falling back to a paid completion — `--connect` never spends tokens.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {object} entry - Resolved connector entry (secrets NOT yet substituted)
     * @returns {Promise<{ok:?boolean, skipped?:boolean, detail:string}>} Never rejects.
     */
    var probeAI = function (projectPath, entry) {
        return new Promise(function (resolveP) {
            var AIConnector;
            try {
                AIConnector = require('../../../core/connectors/ai/lib/connector');
            } catch (e) {
                resolveP({ ok: false, detail: 'failed to load the AI connector core: ' + e.message });
                return;
            }

            // SDK resolves from getPath('project')/node_modules.
            setPath('project', projectPath);

            // Resolve secrets on a copy — the validate-only secrets check already
            // confirmed every required key is set, so this should not throw.
            var probeEntry = {};
            for (var k in entry) {
                if (Object.prototype.hasOwnProperty.call(entry, k)) probeEntry[k] = entry[k];
            }
            try {
                secrets.resolve(probeEntry);
            } catch (secretErr) {
                resolveP({ ok: false, detail: 'secret resolution failed for `' + (secretErr._ginaSecretKey || '<unknown>') + '`' });
                return;
            }

            var connector;
            try {
                connector = new AIConnector(probeEntry);
            } catch (buildErr) {
                resolveP({ ok: false, detail: (buildErr && buildErr.message) ? buildErr.message : String(buildErr) });
                return;
            }

            connector.onReady(function (err, conn) {
                if (err) { resolveP({ ok: false, detail: err.message }); return; }

                var client = conn && conn.client;
                if (!client || !client.models || typeof client.models.list !== 'function') {
                    resolveP({ ok: null, skipped: true, detail: 'provider client exposes no models.list — use `connector:infer` for a generation probe (avoids token spend)' });
                    return;
                }

                var settled = false;
                var timer   = setTimeout(function () {
                    if (settled) return;
                    settled = true;
                    resolveP({ ok: false, detail: 'connect timed out after ' + CONNECT_TIMEOUT_MS + 'ms' });
                }, CONNECT_TIMEOUT_MS);

                try {
                    Promise.resolve(client.models.list()).then(function (res) {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        var count = (res && Array.isArray(res.data)) ? res.data.length : null;
                        resolveP({ ok: true, detail: 'models.list ok' + (count != null ? (' (' + count + ' model' + (count === 1 ? '' : 's') + ')') : '') });
                    }).catch(function (callErr) {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        resolveP({ ok: false, detail: (callErr && callErr.message) ? callErr.message : String(callErr) });
                    });
                } catch (syncErr) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolveP({ ok: false, detail: (syncErr && syncErr.message) ? syncErr.message : String(syncErr) });
                }
            });
        });
    };

    /**
     * Enumerates every connector declared in a project — shared entries plus
     * each bundle's. Each entry is resolved through the shared `cfg` resolver
     * (the same one resolveSingle uses): a fresh DEEP copy, never an alias of
     * the parsed-JSON (requireJSON) cache, with a bundle entry winning on a key
     * collision. Deep-copying means a downstream in-place secrets-resolve on the
     * entry can never poison that cache. Shared keys no bundle touches are
     * emitted once. Mirrors `connector:list`'s `gatherProjectRows`, but returns
     * the entry (not a formatted row).
     *
     * @inner
     * @private
     * @param {string} projectName
     * @returns {Array<{name:string, bundle:?string, source:string, entry:object}>}
     */
    var gatherConnectors = function (projectName) {
        var project  = self.projects[projectName];
        var manifest = loadManifest(project.path);
        var out      = [];

        var sharedJson = readJsonSafe(_(project.path + '/shared/config/connectors.json', true)) || {};
        var sharedKeys = {};
        for (var k in sharedJson) {
            if (k === '$schema') continue;
            sharedKeys[k] = sharedJson[k];
        }

        var sharedOverridden = {};
        if (manifest && manifest.bundles) {
            var bundleNames = Object.keys(manifest.bundles).sort();
            for (var bi = 0; bi < bundleNames.length; bi++) {
                var bName = bundleNames[bi];
                var bSrc  = manifest.bundles[bName].src;
                if (!bSrc) continue;
                var bJson = readJsonSafe(_(project.path + '/' + bSrc + '/config/connectors.json', true)) || {};
                for (var bk in bJson) {
                    if (bk === '$schema') continue;
                    var overrode = (typeof sharedKeys[bk] !== 'undefined');
                    if (overrode) sharedOverridden[bk] = true;
                    // Resolve through the shared cfg (deep copy, bundle wins) so
                    // every gathered entry is a fresh object — parity with
                    // resolveSingle, and safe against a downstream secrets-resolve.
                    out.push({
                        name   : bk,
                        bundle : bName,
                        source : overrode ? 'override' : 'bundle',
                        entry  : cfg.resolve(sharedJson, bJson, bk).entry
                    });
                }
            }
        }
        for (var sk in sharedKeys) {
            if (sharedOverridden[sk]) continue;
            out.push({ name: sk, bundle: null, source: 'shared', entry: cfg.resolve(sharedJson, {}, sk).entry });
        }
        return out;
    };

    /**
     * Resolves a single connector entry by name (shared, or shared+bundle
     * merged), delegating the merge/select to `cfg.resolve`. Mirrors
     * `connector:infer`'s `resolveConnectorEntry`.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {?string} bundleName
     * @param {string} connectorName
     * @returns {{entry:?object, source:?string}}
     */
    var resolveSingle = function (projectPath, bundleName, connectorName) {
        var sharedJson = readJsonSafe(_(projectPath + '/shared/config/connectors.json', true)) || {};
        var bundleJson = {};
        if (bundleName) {
            var manifest = loadManifest(projectPath);
            var bSrc = manifest && manifest.bundles && manifest.bundles[bundleName] && manifest.bundles[bundleName].src;
            if (bSrc) {
                bundleJson = readJsonSafe(_(projectPath + '/' + bSrc + '/config/connectors.json', true)) || {};
            }
        }
        return cfg.resolve(sharedJson, bundleJson, connectorName);
    };

    /**
     * Tests one connector. Exits (code 1) when the connector is declared in
     * neither shared nor the bundle.
     *
     * @inner
     * @private
     * @param {string} projectName
     * @param {?string} bundleName
     * @param {string} connectorName
     */
    var testSingle = function (projectName, bundleName, connectorName) {
        var projectPath = self.projects[projectName].path;
        var resolved    = resolveSingle(projectPath, bundleName, connectorName);
        if (!resolved || !resolved.entry) {
            console.error(
                'Connector `' + connectorName + '` not found in '
                + (bundleName ? ('bundle `' + bundleName + '` (merged with shared) of ') : 'shared config of ')
                + '@' + projectName + '. Run `gina connector:list @' + projectName + '` to see configured connectors.'
            );
            process.exit(1);
            return;
        }
        var ev     = evaluateConnector(projectPath, resolved.entry, connectorName, resolved.source, bundleName);
        var report = { project: projectName, connector: connectorName, connectors: [ev.result] };
        if (bundleName) report.bundle = bundleName;
        finalize(report, [ev.runProbe]);
    };

    /**
     * Tests every connector in one project (shared + all bundles).
     *
     * @inner
     * @private
     * @param {string} projectName
     */
    var testProject = function (projectName) {
        var projectPath = self.projects[projectName].path;
        var conns       = gatherConnectors(projectName);
        var results     = [];
        var probes      = [];
        for (var i = 0; i < conns.length; i++) {
            var ev = evaluateConnector(projectPath, conns[i].entry, conns[i].name, conns[i].source, conns[i].bundle);
            results.push(ev.result);
            probes.push(ev.runProbe);
        }
        finalize({ project: projectName, connectors: results }, probes);
    };

    /**
     * Tests every connector in every registered project.
     *
     * @inner
     * @private
     */
    var testAllProjects = function () {
        var names   = Object.keys(self.projects).sort();
        var report  = { projects: [] };
        var probes  = [];
        for (var i = 0; i < names.length; i++) {
            var pname = names[i];
            var ppath = self.projects[pname].path;
            if ( !ppath || !fs.existsSync(ppath) ) {
                self.anyFail = true;
                report.projects.push({ project: pname, status: 'missing', connectors: [] });
                continue;
            }
            var conns   = gatherConnectors(pname);
            var results = [];
            for (var c = 0; c < conns.length; c++) {
                var ev = evaluateConnector(ppath, conns[c].entry, conns[c].name, conns[c].source, conns[c].bundle);
                results.push(ev.result);
                probes.push(ev.runProbe);
            }
            report.projects.push({ project: pname, connectors: results });
        }
        finalize(report, probes);
    };

    /**
     * Runs any pending async connect probes, then stamps each connector's
     * overall `ok` (flipping `self.anyFail`), emits the report, and exits
     * non-zero when any connector failed.
     *
     * @inner
     * @private
     * @param {object} report
     * @param {Array<?function():Promise>} runProbes
     */
    var finalize = function (report, runProbes) {
        var tasks = [];
        for (var i = 0; i < runProbes.length; i++) {
            if (runProbes[i]) tasks.push(runProbes[i]());
        }
        Promise.all(tasks).then(function () {
            markResults(report);
            emit(report);
            process.exit(self.anyFail ? 1 : 0);
        }).catch(function (e) {
            console.error('[connector:test] unexpected error: ' + (e && e.message ? e.message : e));
            process.exit(1);
        });
    };

    /**
     * Walks the report, sets each connector's `ok = computeOk(result)`, and
     * flips `self.anyFail` when any connector failed.
     *
     * @inner
     * @private
     * @param {object} report
     */
    var markResults = function (report) {
        var groups = report.projects ? report.projects : [report];
        for (var g = 0; g < groups.length; g++) {
            var conns = groups[g].connectors || [];
            for (var c = 0; c < conns.length; c++) {
                conns[c].ok = computeOk(conns[c]);
                if (!conns[c].ok) self.anyFail = true;
            }
        }
    };

    /**
     * Dispatches to the JSON or text renderer based on `self.format`.
     *
     * @inner
     * @private
     * @param {object} report
     */
    var emit = function (report) {
        if (self.format === 'json') {
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        emitText(report);
    };

    /**
     * Renders the human-readable report.
     *
     * @inner
     * @private
     * @param {object} report
     */
    var emitText = function (report) {
        var projects = report.projects
            ? report.projects
            : [{ project: report.project, bundle: report.bundle, connectors: report.connectors }];

        var totalPass = 0;
        var totalFail = 0;

        for (var p = 0; p < projects.length; p++) {
            var proj = projects[p];
            console.log('\n@' + proj.project
                + (proj.bundle ? (' › ' + proj.bundle) : '')
                + (self.doConnect ? ' (with --connect)' : '')
                + ':');

            if (proj.status === 'missing') {
                console.log('  (project path missing — FAIL)');
                continue;
            }
            if (!proj.connectors || proj.connectors.length === 0) {
                console.log('  (no connectors declared)');
                continue;
            }
            for (var c = 0; c < proj.connectors.length; c++) {
                var r = proj.connectors[c];
                if (r.ok) { totalPass++; } else { totalFail++; }
                emitTextConnector(r);
            }
        }

        var total = totalPass + totalFail;
        console.log('\n(' + total + ' connector' + (total === 1 ? '' : 's') + ': ' + totalPass + ' passed, ' + totalFail + ' failed)');
    };

    /**
     * Renders one connector's check block + PASS/FAIL line.
     *
     * @inner
     * @private
     * @param {object} r - One connector result
     */
    var emitTextConnector = function (r) {
        var srcLabel;
        if (r.source === 'shared')        { srcLabel = '[shared]'; }
        else if (r.source === 'override') { srcLabel = '[' + r.bundle + ' override]'; }
        else if (r.source === 'merged')   { srcLabel = '[shared+' + (r.bundle || 'bundle') + ']'; }
        else if (r.bundle)                { srcLabel = '[' + r.bundle + ']'; }
        else                              { srcLabel = '[shared]'; }

        console.log('  ' + r.name + ' (' + r.connector + ') ' + srcLabel);
        for (var i = 0; i < r.checks.length; i++) {
            var c    = r.checks[i];
            var flag = (c.skipped === true) ? 'SKIP' : (c.ok ? 'OK  ' : 'FAIL');
            console.log('      ' + padRight(c.name, 8) + '  ' + flag + '  ' + c.detail);
        }
        console.log('    ' + (r.ok ? 'PASS' : 'FAIL'));
    };

    /**
     * Right-pads `s` with spaces to `n` characters.
     *
     * @inner
     * @private
     * @param {string} s
     * @param {number} n
     * @returns {string}
     */
    var padRight = function (s, n) {
        var o = String(s || '');
        while (o.length < n) o += ' ';
        return o;
    };

    init();
}

module.exports = Test;
