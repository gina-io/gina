var fs      = require('fs');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/connector/models
 */
/**
 * Lists the models a configured AI connector's provider can serve, OUTSIDE a
 * request. Resolves the connector config (shared, or shared+bundle merged),
 * instantiates the `ai` connector directly, and calls the provider client's
 * `models.list()` — the provider's LIVE model catalogue. This is the read
 * sibling of `connector:test --connect`, which makes the very same call but
 * keeps only the count and throws the array away; `connector:models` surfaces
 * the model ids themselves, so a caller can populate a model picker, script a
 * "does the provider offer model X?" check, or audit which models a project's
 * connector can actually reach.
 *
 * Like `connector:infer` / `connector:test`, the connector class is NOT
 * instantiated through `getModel` (its per-bundle registry is empty in CLI
 * scope). The AI connector is built directly: `setPath('project', <path>)` so
 * the provider SDK resolves from the target project's node_modules, then
 * `new AIConnector(entry).onReady(...)`. `${secret:KEY}` placeholders (typically
 * the `apiKey`) are resolved from `process.env` via `lib.secrets` — fail-closed,
 * and the resolved value is NEVER echoed; only the model list is printed, which
 * carries no secrets.
 *
 * When the provider client exposes no `models.list` (a defensive case — every
 * currently-supported provider's SDK client does), the command reports the
 * connector as UNSUPPORTED and exits non-zero rather than fabricating an empty
 * list as if the provider offered nothing. A non-`ai` connector is rejected
 * cleanly (this command is AI-subtype-specific).
 *
 * Operational note (mirrors `connector:infer` / `connector:test`): a detached
 * CLI invocation only sees its own shell environment, not secrets a supervisor
 * injects at bundle start. Run against a shell that exports the keys, or pass
 * `--api-key=<literal>`. Offline / local providers such as `ollama://`
 * (localhost, no key) work with no internet — `models.list()` returns the
 * locally-pulled models.
 *
 * Usage:
 *   gina connector:models <connector> @<project>             # shared config view
 *   gina connector:models <connector> <bundle> @<project>    # merged shared+bundle view
 *   gina connector:models <connector> @<project> --format=json
 *
 * Text mode prints one model id per line to stdout (a count footer goes to
 * stderr, so `> file` captures only the ids). `--format=json` emits
 * `{ project, connector, provider, count, models }` (plus `bundle` when a bundle
 * is named); each `models[]` entry is passed through verbatim from the provider
 * (the SDK shapes differ — Anthropic vs OpenAI-compatible — so only `id` is
 * guaranteed present). The JSON payload is written with synchronous
 * `fs.writeSync` so `process.exit()` cannot truncate it on a pipe.
 *
 * Exit codes: 0 on a successful list; 1 on a usage error (missing `@<project>`,
 * unregistered project / bundle, connector not found, non-`ai` connector, bad
 * `--format`), a secret-resolution failure, a provider client that exposes no
 * `models.list`, or any transport error from the `models.list` call.
 *
 * @class Models
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 * // Discover which models a configured connector can serve.
 * //   $ gina connector:models claude @myproject
 * //   claude-opus-4
 * //   claude-sonnet-4
 *
 * @example
 * // Script a "does the provider offer model X?" check.
 * //   $ gina connector:models claude @myproject --format=json \
 * //       | jq -e '.models[] | select(.id=="claude-opus-4")' >/dev/null
 */
function Models(opt, cmd) {
    var self = { format: 'text' };

    /**
     * Pure connector-entry resolver — merges shared + bundle `connectors.json`
     * maps (bundle wins) and selects one entry by name; also exposes
     * `isAIConnector(entry, key)`. See `lib/connector-config/src/main.js`.
     *
     * @inner
     * @constant
     */
    var cfg = lib.connectorConfig;

    /**
     * Secrets resolver — `resolve(entry)` substitutes every `${secret:KEY}`
     * placeholder in place from `process.env` (fail-closed; the missing KEY
     * name is surfaced, never the value). See `lib/secrets/src/main.js`.
     *
     * @inner
     * @constant
     */
    var secrets = lib.secrets;

    /**
     * Deadline for the live `models.list()` call. A bad endpoint would
     * otherwise hang a CI process; the AI HTTP client carries no connection
     * pool, so `process.exit()` at the end is the only teardown needed.
     *
     * @inner
     * @constant
     * @type {number}
     */
    var CONNECT_TIMEOUT_MS = 15000;

    /**
     * Parse --format, resolve project + optional bundle via CmdHelper, select
     * the AI connector entry, resolve its secrets, then instantiate the
     * connector directly and list its provider's models.
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

        // Positionals: [0] connector logical name, [1] optional bundle name
        // (same convention as `connector:infer` / `connector:test`).
        var positionals   = extractPositionals(process.argv);
        var connectorName = positionals[0] || null;
        var bundleName    = positionals[1] || null;

        if (!connectorName) {
            console.error('Usage: gina connector:models <connector> [<bundle>] @<project> [--format=json]');
            process.exit(1);
            return;
        }

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            console.error('`connector:models` requires `@<project>`. Did you forget `@<project_name>`?');
            process.exit(1);
            return;
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('Project @' + self.projectName + ' is not registered. Run `gina project:list` to see registered projects.');
            process.exit(1);
            return;
        }

        var projectPath = self.projects[self.projectName].path;

        // Merged connector entry (shared + bundle, bundle wins). Exits on a
        // bad bundle; returns null when the connector is declared nowhere.
        var entry = resolveConnectorEntry(projectPath, bundleName, connectorName);
        if (!entry) {
            console.error(
                'Connector `' + connectorName + '` not found in '
                + (bundleName ? ('bundle `' + bundleName + '` (merged with shared) of ') : 'shared config of ')
                + '@' + self.projectName + '. Run `gina connector:list @' + self.projectName + '` to see configured connectors.'
            );
            process.exit(1);
            return;
        }

        // models.list is AI-specific — reject any non-`ai` connector cleanly.
        // Pass connectorName so a connector written as just `"ai": {…}` (no
        // `connector` field) is recognised via the key-fallback (matches
        // connector:list / connector:infer / connector:test).
        if (!cfg.isAIConnector(entry, connectorName)) {
            var type = (entry && entry.connector) ? entry.connector : connectorName;
            console.error('Connector `' + connectorName + '` is a `' + type + '` connector, not `ai`. `connector:models` only works with AI connectors.');
            process.exit(1);
            return;
        }

        // Ad-hoc connector-level overrides (NOT written back to disk), mirroring
        // connector:infer. Applied BEFORE secrets.resolve so an --api-key literal
        // bypasses ${secret:} resolution.
        var p = self.params || {};
        if (p['protocol'] && p['protocol'] !== true) entry.protocol = String(p['protocol']);
        if (p['base-url'] && p['base-url'] !== true) entry.baseURL  = String(p['base-url']);
        if (p['api-key']  && p['api-key']  !== true) entry.apiKey   = String(p['api-key']); // literal — bypasses ${secret:}

        // Resolve ${secret:KEY} placeholders (apiKey etc.) from process.env.
        // Fail-closed; the missing KEY name is surfaced (never the value).
        try {
            secrets.resolve(entry);
        } catch (secretErr) {
            console.error(
                '[connector:models] secret resolution failed for `' + (secretErr._ginaSecretKey || '<unknown>') + '`. '
                + 'Set it in this shell (export ' + (secretErr._ginaSecretKey || 'KEY') + '=...), or pass --api-key=<literal>. '
                + 'A detached CLI sees only its own environment, not secrets injected by a supervisor at bundle start.'
            );
            process.exit(1);
            return;
        }

        listModels(projectPath, connectorName, bundleName, entry);
    };

    /**
     * Walks `process.argv` from index 3 and returns every non-flag,
     * non-`@<project>` token in order: `[0]` the connector logical name,
     * `[1]` the optional bundle name. CmdHelper already consumes `--` flags
     * and `@<project>` tokens; the remainder are our positionals. Mirrors
     * `connector:infer` / `connector:test`.
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
     * `null` on any parse or I/O error. Mirrors `connector:infer`.
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
     * Resolves the connector entry for `connectorName`: reads the shared
     * connectors.json and (when a bundle is supplied) the bundle's, then
     * delegates the merge + select to the shared pure resolver
     * (`lib.connectorConfig.resolve`, bundle wins). The returned object is a
     * fresh copy, safe to mutate in place (overrides + secrets.resolve).
     *
     * Exits the process (code 1) when the named bundle is not registered.
     * Returns `null` when the connector is declared in neither file.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string|null} bundleName
     * @param {string} connectorName
     * @returns {object|null}
     */
    var resolveConnectorEntry = function (projectPath, bundleName, connectorName) {
        var sharedJson = readJsonSafe(_(projectPath + '/shared/config/connectors.json', true)) || {};

        var bundleJson = {};
        if (bundleName) {
            var manifest = loadManifest(projectPath);
            if (!manifest || !manifest.bundles || !manifest.bundles[bundleName]) {
                console.error('Bundle [ ' + bundleName + ' ] is not registered inside `@' + self.projectName + '`.');
                process.exit(1);
                return null;
            }
            var bSrc = manifest.bundles[bundleName].src;
            if (bSrc) {
                bundleJson = readJsonSafe(_(projectPath + '/' + bSrc + '/config/connectors.json', true)) || {};
            }
        }

        return cfg.resolve(sharedJson, bundleJson, connectorName).entry;
    };

    /**
     * Loads the AI connector core (the connector class only — `models.list()`
     * is read off the raw provider client, so the `AI` wrapper is not needed)
     * and points `getPath('project')` at the target project so the provider
     * SDK resolves from its node_modules. Mirrors `connector:infer`'s
     * `loadAiCore` / `connector:test`'s `probeAI` require.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @returns {{AIConnector: function}|null} The loaded core, or `null` after a
     *   fatal load error (the process has already exited).
     */
    var loadAiCore = function (projectPath) {
        var AIConnector;
        try {
            AIConnector = require('../../../core/connectors/ai/lib/connector');
        } catch (e) {
            console.error('[connector:models] failed to load the AI connector core: ' + e.message);
            process.exit(1);
            return null;
        }
        // AIConnector requires the provider SDK from getPath('project')/node_modules.
        setPath('project', projectPath);
        return { AIConnector: AIConnector };
    };

    /**
     * Instantiates the AI connector directly and lists its provider's models
     * via a single `client.models.list()` call. `onReady` is synchronous and
     * performs no network ping; the network cost is the one `models.list()`
     * GET (a credentialed catalogue read that spends ZERO generation tokens —
     * for `ollama://` it just hits the local server). A capability check emits
     * an honest UNSUPPORTED verdict (never a fabricated empty list) when the
     * client exposes no `models.list`.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string} connectorName
     * @param {string|null} bundleName
     * @param {object} entry - Resolved connector entry (secrets already substituted)
     */
    var listModels = function (projectPath, connectorName, bundleName, entry) {
        var core = loadAiCore(projectPath);
        if (!core) return;
        var AIConnector = core.AIConnector;

        var connector;
        try {
            connector = new AIConnector(entry);
        } catch (buildErr) {
            console.error('[connector:models] ' + ((buildErr && buildErr.message) ? buildErr.message : String(buildErr)));
            process.exit(1);
            return;
        }

        connector.onReady(function (err, conn) {
            if (err) {
                console.error('[connector:models] ' + err.message);
                process.exit(1);
                return;
            }

            var client   = conn && conn.client;
            var provider = conn && conn.provider;

            // Capability check — honest UNSUPPORTED rather than a fabricated
            // empty list. Every currently-supported provider's SDK client
            // defines models.list, so this is a defensive / forward-looking
            // branch. Mirrors connector:test's inconclusive-`ok:null` guard.
            if (!client || !client.models || typeof client.models.list !== 'function') {
                emitUnsupported(connectorName, bundleName, provider);
                return; // emitUnsupported exits non-zero
            }

            var settled = false;
            var timer   = setTimeout(function () {
                if (settled) return;
                settled = true;
                console.error('[connector:models] models.list timed out after ' + CONNECT_TIMEOUT_MS + 'ms');
                process.exit(1);
            }, CONNECT_TIMEOUT_MS);

            try {
                Promise.resolve(client.models.list()).then(function (res) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    // Both the OpenAI and Anthropic SDKs return a `{ data: [...] }`
                    // envelope. The per-entry shape is the SDK's, unmodified —
                    // surfaced verbatim (only `id` is guaranteed across providers).
                    var models = (res && Array.isArray(res.data)) ? res.data : [];
                    emitModels(connectorName, bundleName, provider, models);
                    process.exit(0);
                }).catch(function (callErr) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    console.error('[connector:models] models.list failed: ' + ((callErr && callErr.message) ? callErr.message : String(callErr)));
                    process.exit(1);
                });
            } catch (syncErr) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                console.error('[connector:models] models.list failed: ' + ((syncErr && syncErr.message) ? syncErr.message : String(syncErr)));
                process.exit(1);
            }
        });
    };

    /**
     * Writes the model list. JSON mode (`--format=json`, matched strictly with
     * `===` so `jsonl`/`json5` fall to text) emits
     * `{ project, connector, provider, count, models }` (+ `bundle` when named);
     * each `models[]` entry is passed through verbatim from the provider SDK.
     * Text mode prints one model `id` per line to stdout (so `> file` captures
     * only the ids) and a count footer to stderr.
     *
     * Both paths use synchronous `fs.writeSync` (fd 1 / fd 2) rather than the
     * async `process.stdout` / `process.stderr` writers, so the output is not
     * truncated by the `process.exit(0)` that {@link listModels} fires on the
     * next line (`process.stdout` is ASYNCHRONOUS on a pipe — `| jq`, `$(…)`,
     * CI — and `process.exit()` tears the process down without draining its
     * buffer; the framework's boot-exit-flush rule). Mirrors
     * `connector:infer`'s `emitResult`.
     *
     * @inner
     * @private
     * @param {string} connectorName
     * @param {string|null} bundleName
     * @param {string|null} provider - Provider scheme (e.g. 'anthropic', 'ollama')
     * @param {object[]} models - The provider's model-entry array (passthrough)
     */
    var emitModels = function (connectorName, bundleName, provider, models) {
        if ( self.format === 'json' ) {
            var payload = {
                project   : self.projectName,
                connector : connectorName,
                provider  : provider || null,
                count     : models.length,
                models    : models
            };
            if (bundleName) payload.bundle = bundleName;
            fs.writeSync(1, JSON.stringify(payload));
            return;
        }
        // Text: one model id per line on stdout (grep/pipe-friendly).
        var lines = '';
        for (var i = 0; i < models.length; i++) {
            var id = (models[i] && models[i].id != null) ? String(models[i].id) : '<unknown>';
            lines += id + '\n';
        }
        if (lines) fs.writeSync(1, lines);
        fs.writeSync(2, '— ' + models.length + ' model' + (models.length === 1 ? '' : 's')
            + ' via `' + connectorName + '`' + (provider ? (' (' + provider + ')') : '') + '\n');
    };

    /**
     * Reports a connector whose provider client exposes no `models.list` as
     * UNSUPPORTED and exits non-zero — an honest "this provider cannot enumerate
     * models", never a fabricated empty list. JSON mode emits
     * `{ project, connector, provider, supported:false, models:null, reason }`
     * (+ `bundle` when named) on stdout via `fs.writeSync`; text mode writes the
     * reason to stderr. Either way the exit code is 1, distinct from a
     * successful empty list (exit 0, `models:[]`).
     *
     * @inner
     * @private
     * @param {string} connectorName
     * @param {string|null} bundleName
     * @param {string|null} provider
     */
    var emitUnsupported = function (connectorName, bundleName, provider) {
        if ( self.format === 'json' ) {
            var payload = {
                project   : self.projectName,
                connector : connectorName,
                provider  : provider || null,
                supported : false,
                models    : null,
                reason    : 'provider client exposes no models.list'
            };
            if (bundleName) payload.bundle = bundleName;
            fs.writeSync(1, JSON.stringify(payload));
            process.exit(1);
            return;
        }
        console.error('[connector:models] connector `' + connectorName + '`'
            + (provider ? (' (' + provider + ')') : '')
            + ' exposes no models.list — this provider client does not support model enumeration.');
        process.exit(1);
    };

    init();
}

module.exports = Models;
