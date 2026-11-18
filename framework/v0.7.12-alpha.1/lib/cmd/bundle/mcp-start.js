var fs          = require('fs');
var CmdHelper   = require('./../helper');
var console     = lib.logger;
var mcpServer   = lib.mcpServer;
var mcpDispatch = lib.mcpDispatch;
var mcpHttp     = lib.mcpHttp;
var secrets     = lib.secrets;

/**
 * @module gina/lib/cmd/bundle/mcp-start
 */
/**
 * Starts a Model Context Protocol server for a running bundle. Speaks
 * JSON-RPC 2.0 either over stdio (newline-delimited UTF-8) or over HTTP
 * (Streamable HTTP) per MCP spec revision 2025-06-18.
 *
 * The server reads the static tool manifest written by `gina bundle:mcp`,
 * advertises every tool over `tools/list`, and dispatches incoming
 * `tools/call` requests by issuing real HTTP requests against the bundle's
 * configured port on localhost.
 *
 * **Prerequisites.** The bundle must already be running (`gina bundle:start`)
 * and its manifest must exist (`gina bundle:mcp`). The MCP server process is
 * stateless — it holds no session, no auth, no config beyond what lives in
 * mcp.json and the bundle's own routing.
 *
 * **Stdio discipline.** The bin/cli early intercept redirects process.stdout
 * to stderr when `bundle:mcp-start` is detected in argv, and stashes the real
 * write on `process.__ginaMcpStdout`. The MCP wire uses that stashed write;
 * every framework log line ends up on stderr where it belongs. The redirect
 * is harmless under `--transport=http` (nothing writes to stdout in that
 * path), so it is not conditionalised.
 *
 * Usage:
 *  gina bundle:mcp-start <bundle_name> @<project_name>
 *  gina bundle:mcp-start <bundle_name> @<project_name> --timeout-ms=5000
 *  gina bundle:mcp-start <bundle_name> @<project_name> --transport=http
 *  gina bundle:mcp-start <bundle_name> @<project_name> --transport=http --http-port=3107
 *  gina bundle:mcp-start <bundle_name> @<project_name> --transport=http --auth-token=<token>
 *
 * Flag precedence at every resolver: CLI > `mcp.json > server > <field>` >
 * environment (where applicable) > default. Non-numeric / out-of-range
 * values at any layer fall through to the next layer with a stderr warning.
 *
 * @class MCPStart
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output (points at stderr in this path)
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function MCPStart(opt, cmd) {
    var self = {};

    var server        = null;
    var dispatcher    = null;
    var httpTransport = null;
    var shuttingDown  = false;


    var init = function() {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        if ( !isCmdConfigured() ) return false;

        if ( typeof(self.projects[self.projectName]) == 'undefined' || typeof(self.projects[self.projectName].path) == 'undefined' ) {
            return end( new Error('project path not defined in ~/.gina/projects.json for [ '+ self.projectName + ' ]') );
        }

        if (!isDefined('project', self.projectName)) {
            return end( new Error('Missing argument @<project_name>') );
        }

        // Exactly one bundle — MCP is point-to-point, whether over stdio or HTTP.
        if (!self.bundles.length) {
            return end( new Error('Missing argument <bundle_name>. Usage: gina bundle:mcp-start <bundle> @<project>') );
        }
        if (self.bundles.length > 1) {
            return end( new Error('bundle:mcp-start takes exactly one bundle. Got: '+ self.bundles.join(', ')) );
        }

        startServer();
    };


    /**
     * Loads the manifest, wires dispatcher + server, attaches the selected
     * transport (stdio or HTTP), and installs shutdown handlers. Never
     * returns — the process lives until stdin closes (stdio) or a signal
     * arrives.
     *
     * @private
     */
    var startServer = function() {

        var bundle      = self.bundles[0];
        var manifest    = self.projectData;
        var bundleSrc   = manifest.bundles[bundle].src;
        var srcPath     = _(self.projects[self.projectName].path + '/' + bundleSrc, true);
        var mcpPath     = _(srcPath + '/config/mcp.json', true);
        var routingPath = _(srcPath + '/config/routing.json', true);

        if ( !fs.existsSync(mcpPath) ) {
            return end( new Error(
                'MCP manifest not found at '+ mcpPath +'.\n' +
                'Run `gina bundle:mcp '+ bundle +' @'+ self.projectName +'` first to generate it.'
            ) );
        }

        // Warn on staleness — routing changed after the manifest was written.
        if ( fs.existsSync(routingPath) ) {
            try {
                var mcpMtime     = fs.statSync(mcpPath).mtimeMs;
                var routingMtime = fs.statSync(routingPath).mtimeMs;
                if (routingMtime > mcpMtime) {
                    console.warn(
                        '[ '+ bundle +' ] routing.json has been modified after mcp.json was generated. ' +
                        'Run `gina bundle:mcp` to regenerate before serving, or clients may see stale tools.'
                    );
                }
            } catch (statErr) {
                // non-fatal
            }
        }

        var mcpDoc = null;
        try {
            mcpDoc = requireJSON(mcpPath);
        } catch (parseErr) {
            return end( new Error('Failed to parse '+ mcpPath +': '+ parseErr.message) );
        }

        if (!mcpDoc || !Array.isArray(mcpDoc.tools)) {
            return end( new Error(mcpPath +' is not a valid MCP manifest (missing `tools` array)') );
        }

        // ${secret:KEY} placeholder substitution. The cmd handler loads mcp.json
        // directly (it is not part of the bundle-config tree walked by
        // core/config.js::loadBundleConfig), so the resolver hook on bundle
        // start does NOT see this document. Run resolve() here so that
        // `server.authToken` (and any other future placeholder field in
        // mcp.json) gets filled from process.env before downstream readers
        // pick it up.
        try {
            secrets.resolve(mcpDoc);
        } catch (secretErr) {
            return end( new Error('Failed to resolve secrets in '+ mcpPath +': '+ secretErr.message) );
        }

        var baseUrl = buildBaseUrl(bundle, mcpDoc);

        // Loud, one-time notice about the tools that look session-scoped.
        warnSessionScopedTools(mcpDoc.tools);

        // Framework package version — the user-facing server version. Read
        // GINA_DIR through the framework env reader first: the CLI sweep
        // empties process.env of GINA_* keys, so the direct read alone made
        // every CLI-launched server degrade to the '0.0.0' catch below.
        var packVersion = null;
        try {
            var ginaDir  = (typeof getEnvVar === 'function' && getEnvVar('GINA_DIR'))
                           || process.env.GINA_DIR;
            var packPath = _(ginaDir + '/package.json', true);
            packVersion = require(packPath).version;
        } catch (pkgErr) {
            packVersion = '0.0.0';
        }

        var transport   = resolveTransport(mcpDoc);
        var timeoutMs   = resolveTimeoutMs(mcpDoc);
        var maxInFlight = resolveMaxInFlight(mcpDoc);

        dispatcher = mcpDispatch.createDispatcher({
            baseUrl:     baseUrl,
            timeoutMs:   timeoutMs,
            maxInFlight: maxInFlight
        });

        server = mcpServer.createServer({
            manifest:   mcpDoc,
            dispatch:   dispatcher.dispatch,
            serverInfo: {
                name:    'gina-mcp/'+ bundle,
                version: packVersion,
                title:   bundle + ' (via gina bundle:mcp-start)'
            },
            instructions:
                'This server exposes HTTP routes from the `'+ bundle +'` Gina bundle as MCP tools. '+
                'Tool results mirror the upstream HTTP response. Session-scoped routes may require '+
                'out-of-band authentication — consult `_meta["io.gina.middleware"]` on each tool.',
            onError: function(err) {
                // Transport / unexpected errors — surfaced on stderr for ops.
                console.error('[ '+ bundle +' ][mcp] ' + (err && err.message || err));
            }
        });

        if (transport === 'http') {
            return startHttp(bundle, mcpDoc, baseUrl, timeoutMs, maxInFlight);
        }

        return startStdio(bundle, mcpDoc, baseUrl, timeoutMs);
    };


    /**
     * Wires the server to stdio and blocks on stdin.
     *
     * @private
     */
    var startStdio = function(bundle, mcpDoc, baseUrl, timeoutMs) {
        // Output stream: the real stdout stashed by bin/cli before redirect.
        var output = (typeof(process.__ginaMcpStdout) === 'function')
            ? { write: process.__ginaMcpStdout }
            : process.stdout;

        server.attachStdio({
            input:  process.stdin,
            output: output,
            onClose: function() { gracefulExit(0); }
        });

        console.info('[ '+ bundle +' ][mcp] MCP server listening on stdio. Dispatch target: '+ baseUrl +' (timeout: '+ timeoutMs +' ms). '+ mcpDoc.tools.length +' tool'+ (mcpDoc.tools.length === 1 ? '' : 's') +' exposed.');

        process.on('SIGTERM', function() { gracefulExit(0); });
        process.on('SIGINT',  function() { gracefulExit(0); });
    };


    /**
     * Wires the server to a Streamable HTTP transport on the resolved
     * host/port. Does NOT block — the process stays alive because the
     * http.Server keeps the event loop busy.
     *
     * @private
     */
    var startHttp = function(bundle, mcpDoc, baseUrl, timeoutMs, maxInFlight) {

        var host           = resolveHttpHost(mcpDoc);
        var port           = resolveHttpPort(mcpDoc);
        var authToken      = resolveAuthToken(mcpDoc);
        var allowedOrigins = resolveAllowedOrigins(mcpDoc);
        var allowInsecure  = resolveAllowInsecure(mcpDoc);

        httpTransport = mcpHttp.createHttpTransport({
            mcpServer:      server,
            host:           host,
            port:           port,
            authToken:      authToken,
            allowedOrigins: allowedOrigins,
            allowInsecure:  allowInsecure,
            onError: function(err) {
                console.error('[ '+ bundle +' ][mcp] HTTP transport: ' + (err && err.message || err));
            }
        });

        httpTransport.start().then(function(info) {
            var authNote = authToken
                ? ' (bearer auth: enabled)'
                : (allowInsecure ? ' (bearer auth: none — allowInsecure asserted)' : '');
            console.info('[ '+ bundle +' ][mcp] MCP server listening on http://'+ info.host +':'+ info.port + authNote +'. Dispatch target: '+ baseUrl +' (timeout: '+ timeoutMs +' ms, maxInFlight: '+ maxInFlight +'). '+ mcpDoc.tools.length +' tool'+ (mcpDoc.tools.length === 1 ? '' : 's') +' exposed.');
        }, function(err) {
            return end( new Error('Failed to start HTTP transport on '+ host +':'+ port +': '+ (err && err.message || err)) );
        });

        process.on('SIGTERM', function() { gracefulExit(0); });
        process.on('SIGINT',  function() { gracefulExit(0); });
    };


    /**
     * Resolves the transport name. Precedence:
     *   1. `--transport=<stdio|http>` CLI flag
     *   2. `mcp.json > server > transport`
     *   3. `'stdio'` default (preserves pre-#AI8 Phase 2b behaviour)
     *
     * @private
     * @param   {object} mcpDoc
     * @returns {'stdio'|'http'}
     */
    var resolveTransport = function(mcpDoc) {
        var cli = self.params && self.params['transport'];
        if (typeof(cli) === 'string' && cli) {
            var c = cli.toLowerCase();
            if (c === 'stdio' || c === 'http') return c;
            console.warn('[mcp] Ignoring --transport='+ cli +' (must be "stdio" or "http"). Falling back to manifest / default.');
        }
        if (mcpDoc && mcpDoc.server && typeof(mcpDoc.server.transport) === 'string') {
            var m = mcpDoc.server.transport.toLowerCase();
            if (m === 'stdio' || m === 'http') return m;
            console.warn('[mcp] Ignoring mcp.json > server > transport='+ mcpDoc.server.transport +' (must be "stdio" or "http"). Falling back to default.');
        }
        return 'stdio';
    };


    /**
     * Resolves the dispatch timeout in milliseconds. Precedence:
     *   1. `--timeout-ms=<n>` CLI flag
     *   2. `mcp.json > server > timeoutMs`
     *   3. 30 000 ms default
     *
     * Non-numeric or non-positive values at any layer are rejected in favour
     * of the next layer, so a malformed CLI flag or manifest field cannot
     * silently disable the timeout.
     *
     * @private
     * @param   {object} mcpDoc
     * @returns {number} Positive integer milliseconds
     */
    var resolveTimeoutMs = function(mcpDoc) {

        var DEFAULT_MS = 30000;

        var cli = self.params && self.params['timeout-ms'];
        if (typeof(cli) !== 'undefined' && cli !== null && cli !== true && cli !== false) {
            var parsedCli = Number(cli);
            if (isFinite(parsedCli) && parsedCli > 0) {
                return Math.floor(parsedCli);
            }
            console.warn('[mcp] Ignoring --timeout-ms='+ cli +' (must be a positive number). Falling back to manifest / default.');
        }

        if (mcpDoc && mcpDoc.server && typeof(mcpDoc.server.timeoutMs) !== 'undefined') {
            var parsedManifest = Number(mcpDoc.server.timeoutMs);
            if (isFinite(parsedManifest) && parsedManifest > 0) {
                return Math.floor(parsedManifest);
            }
            console.warn('[mcp] Ignoring mcp.json > server > timeoutMs='+ mcpDoc.server.timeoutMs +' (must be a positive number). Falling back to default.');
        }

        return DEFAULT_MS;
    };


    /**
     * Resolves the dispatcher in-flight request cap. Precedence:
     *   1. `--max-in-flight=<n>` CLI flag
     *   2. `mcp.json > server > maxInFlight`
     *   3. `mcpDispatch.DEFAULT_MAX_IN_FLIGHT`
     *
     * @private
     * @param   {object} mcpDoc
     * @returns {number} Positive integer
     */
    var resolveMaxInFlight = function(mcpDoc) {
        var cli = self.params && self.params['max-in-flight'];
        if (typeof(cli) !== 'undefined' && cli !== null && cli !== true && cli !== false) {
            var parsedCli = Number(cli);
            if (isFinite(parsedCli) && parsedCli > 0 && Math.floor(parsedCli) === parsedCli) {
                return parsedCli;
            }
            console.warn('[mcp] Ignoring --max-in-flight='+ cli +' (must be a positive integer). Falling back to manifest / default.');
        }
        if (mcpDoc && mcpDoc.server && typeof(mcpDoc.server.maxInFlight) !== 'undefined') {
            var parsedManifest = Number(mcpDoc.server.maxInFlight);
            if (isFinite(parsedManifest) && parsedManifest > 0 && Math.floor(parsedManifest) === parsedManifest) {
                return parsedManifest;
            }
            console.warn('[mcp] Ignoring mcp.json > server > maxInFlight='+ mcpDoc.server.maxInFlight +' (must be a positive integer). Falling back to default.');
        }
        return mcpDispatch.DEFAULT_MAX_IN_FLIGHT;
    };


    /**
     * Resolves the HTTP bind host. Precedence:
     *   1. `--http-host=<host>` CLI flag
     *   2. `mcp.json > server > httpHost`
     *   3. `GINA_BIND_HOST` — the framework env reader first, then the raw
     *      process environment (for embedders that never ran the CLI sweep).
     *      This is the control plane's dedicated BIND key, same bind/connect
     *      separation as `bin/cli`. The former `GINA_HOST_V4` tier was
     *      removed (#B157): it was inert under the CLI (the sweep empties
     *      the process environment of GINA_* keys), and reviving it would
     *      have moved the default bind OFF loopback — `host_v4` is the
     *      address clients CONNECT to (commonly a LAN address), never a
     *      bind address.
     *   4. `'127.0.0.1'`
     *
     * @private
     * @param   {object} mcpDoc
     * @returns {string}
     */
    var resolveHttpHost = function(mcpDoc) {
        var cli = self.params && self.params['http-host'];
        if (typeof(cli) === 'string' && cli) return cli;
        if (mcpDoc && mcpDoc.server && typeof(mcpDoc.server.httpHost) === 'string' && mcpDoc.server.httpHost) {
            return mcpDoc.server.httpHost;
        }
        // #B157 — bind_host, never host_v4: the string guard below also keeps
        // a sweep-coerced boolean from ever reaching the bind.
        var env = (typeof getEnvVar === 'function' && getEnvVar('GINA_BIND_HOST'))
                  || process.env.GINA_BIND_HOST;
        if (typeof(env) === 'string' && env) return env;
        return '127.0.0.1';
    };


    /**
     * Resolves the HTTP bind port. Precedence:
     *   1. `--http-port=<n>` CLI flag (integer 0–65535; 0 = OS-assigned)
     *   2. `mcp.json > server > httpPort`
     *   3. `0` default (OS-assigned ephemeral port)
     *
     * @private
     * @param   {object} mcpDoc
     * @returns {number}
     */
    var resolveHttpPort = function(mcpDoc) {
        var cli = self.params && self.params['http-port'];
        if (typeof(cli) !== 'undefined' && cli !== null && cli !== true && cli !== false) {
            var parsedCli = Number(cli);
            if (isFinite(parsedCli) && parsedCli >= 0 && parsedCli < 65536 && Math.floor(parsedCli) === parsedCli) {
                return parsedCli;
            }
            console.warn('[mcp] Ignoring --http-port='+ cli +' (must be an integer between 0 and 65535). Falling back to manifest / default.');
        }
        if (mcpDoc && mcpDoc.server && typeof(mcpDoc.server.httpPort) !== 'undefined') {
            var parsedManifest = Number(mcpDoc.server.httpPort);
            if (isFinite(parsedManifest) && parsedManifest >= 0 && parsedManifest < 65536 && Math.floor(parsedManifest) === parsedManifest) {
                return parsedManifest;
            }
            console.warn('[mcp] Ignoring mcp.json > server > httpPort='+ mcpDoc.server.httpPort +' (must be an integer between 0 and 65535). Falling back to default.');
        }
        return 0;
    };


    /**
     * Resolves the static bearer token. Precedence:
     *   1. `--auth-token=<token>` CLI flag
     *   2. `mcp.json > server > authToken` — supports `${secret:KEY}` placeholders
     *      (resolved at handler entry by `lib/secrets` against `process.env`).
     *   3. `process.env.GINA_MCP_AUTH_TOKEN` — direct fallback when neither the
     *      CLI flag nor the mcp.json field is set.
     *   4. `null` (no auth; loopback bind is the security boundary)
     *
     * @private
     * @param   {object} mcpDoc
     * @returns {string|null}
     */
    var resolveAuthToken = function(mcpDoc) {
        var cli = self.params && self.params['auth-token'];
        if (typeof(cli) === 'string' && cli) return cli;
        if (mcpDoc && mcpDoc.server && typeof(mcpDoc.server.authToken) === 'string' && mcpDoc.server.authToken) {
            return mcpDoc.server.authToken;
        }
        // `filterArgs()` (bin/cli) moves every GINA_* key OUT of `process.env`
        // into `process.gina` and deletes the original, so a bare
        // `process.env.GINA_MCP_AUTH_TOKEN` read is always undefined under the
        // CLI — the documented env path silently yielded NO token, leaving the
        // transport unauthenticated. `getEnvVar` is the supported reader; the
        // direct read stays as the fallback for embedders that never ran the sweep.
        var env = (typeof(getEnvVar) === 'function' && getEnvVar('GINA_MCP_AUTH_TOKEN'))
                  || process.env.GINA_MCP_AUTH_TOKEN;
        if (typeof(env) === 'string' && env) return env;
        return null;
    };


    /**
     * Resolves the insecure-transport waiver. Precedence:
     *   1. `--allow-insecure` CLI flag
     *   2. `mcp.json > server > allowInsecure` (strict boolean)
     *   3. `false`
     *
     * Only meaningful when no bearer token is configured: it tells the
     * transport that a non-loopback bind (or a wildcard Origin allowlist) is
     * fronted by something else — a mesh, a NetworkPolicy, or an
     * authenticating reverse proxy — rather than genuinely open.
     *
     * @private
     * @param   {object} mcpDoc
     * @returns {boolean}
     */
    var resolveAllowInsecure = function(mcpDoc) {
        var cli = self.params && self.params['allow-insecure'];
        if (cli === true || cli === 'true') return true;
        if (mcpDoc && mcpDoc.server && mcpDoc.server.allowInsecure === true) {
            return true;
        }
        return false;
    };


    /**
     * Resolves the CORS `Origin` allowlist. Precedence:
     *   1. `--cors-origin=<list>` CLI flag (comma-separated; use `*` to disable)
     *   2. `mcp.json > server > allowedOrigins` (array)
     *   3. Empty array — `lib/mcp-http` falls back to its built-in loopback
     *      allowlist (`http(s)://localhost`, `127.0.0.1`, `[::1]` any port)
     *
     * @private
     * @param   {object} mcpDoc
     * @returns {string[]}
     */
    var resolveAllowedOrigins = function(mcpDoc) {
        var cli = self.params && self.params['cors-origin'];
        if (typeof(cli) === 'string' && cli) {
            return cli.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length; });
        }
        if (mcpDoc && mcpDoc.server && Array.isArray(mcpDoc.server.allowedOrigins)) {
            return mcpDoc.server.allowedOrigins;
        }
        return [];
    };


    /**
     * Resolves the upstream bundle baseUrl. Prefers the live port registry,
     * falls back to the baseUrl embedded in the manifest at generation time.
     *
     * @private
     * @param   {string} bundle
     * @param   {object} mcpDoc
     * @returns {string}
     */
    var buildBaseUrl = function(bundle, mcpDoc) {

        var key = bundle + '@' + self.projectName;
        if ( typeof(self.portsReverseData) != 'undefined' && typeof(self.portsReverseData[key]) != 'undefined' ) {
            var entry  = self.portsReverseData[key];
            var scheme = entry.scheme || 'http';
            var port   = entry.port;
            if (port) {
                return scheme + '://localhost:' + port;
            }
        }

        if (mcpDoc.server && mcpDoc.server.baseUrl) {
            return mcpDoc.server.baseUrl;
        }

        // Last resort — the dispatcher will fail loudly on ECONNREFUSED.
        return 'http://localhost';
    };


    /**
     * Emits one stderr warning line per tool whose middleware list looks
     * session-scoped. Purely informational — the handler does not filter
     * those tools out; agents are free to call them and receive the
     * upstream 401/403 as `isError: true`.
     *
     * @private
     * @param   {object[]} tools
     */
    var warnSessionScopedTools = function(tools) {
        var hits = [];
        for (var i = 0; i < tools.length; i++) {
            var meta = tools[i]._meta || {};
            var mw = meta['io.gina.middleware'];
            if (Array.isArray(mw) && mw.length) {
                for (var j = 0; j < mw.length; j++) {
                    var name = String(mw[j]).toLowerCase();
                    if ( /(auth|session|login)/.test(name) ) {
                        hits.push(tools[i].name);
                        break;
                    }
                }
            }
        }
        if (hits.length) {
            console.warn(
                '[mcp] ' + hits.length + ' tool' + (hits.length === 1 ? '' : 's') +
                ' appear session-scoped (auth/session/login middleware): ' +
                hits.slice(0, 5).join(', ') + (hits.length > 5 ? ', …' : '') +
                '. These may return 401/403 until the bundle recognises the caller.'
            );
        }
    };


    /**
     * Closes the server cleanly and exits. Idempotent. For HTTP transport,
     * stop() is awaited so in-flight responses drain before the process goes.
     *
     * @private
     * @param   {number} code
     */
    var gracefulExit = function(code) {
        if (shuttingDown) return;
        shuttingDown = true;
        var finish = function() {
            try { if (server) server.close(); } catch (e) { /* ignore */ }
            process.exit(code || 0);
        };
        if (httpTransport) {
            httpTransport.stop().then(finish, finish);
        } else {
            finish();
        }
    };


    var end = function(output, type, messageOnly) {
        var err = false;
        if ( typeof(output) != 'undefined') {
            if ( output instanceof Error ) {
                err = output = ( typeof(messageOnly) != 'undefined' && /^true$/i.test(messageOnly) ) ? output.message : (output.stack||output.message);
            }
            if ( typeof(type) != 'undefined' ) {
                console[type](output);
            } else {
                console.log(output);
            }
        }

        process.exit( err ? 1 : 0 );
    };

    init();
}

module.exports = MCPStart;
