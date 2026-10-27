/**
 * @module gina/lib/mcp-dispatch
 *
 * HTTP(S) loopback dispatcher for MCP tool calls. Given a tool from the
 * bundle's mcp.json manifest and an `arguments` object from the MCP client,
 * resolves the URL template, issues the request against the running bundle,
 * and maps the response into MCP ToolResult shape.
 *
 * Design decisions:
 *  - HTTP loopback rather than in-process dispatch. The bundle has its own
 *    connectors, scopes, session store, and middleware chain. Re-entering
 *    that chain from an out-of-process MCP server would duplicate half the
 *    framework; loopback reuses the real bundle.
 *  - `rejectUnauthorized: false` for HTTPS to localhost — bundles often use
 *    self-signed certs for local dev, and the loopback is by definition on
 *    the same machine.
 *  - Timeout defaults to 30s. Override via `timeoutMs`.
 *  - No auth tokens sent on the wire. Session-required routes will respond
 *    with their own 401/403 which becomes `isError: true` at the MCP layer.
 */

'use strict';

var http  = require('http');
var https = require('https');
var url   = require('url');

var DEFAULT_TIMEOUT_MS   = 30000;
var DEFAULT_MAX_IN_FLIGHT = 16;


/**
 * Creates a dispatcher bound to a single bundle base URL.
 *
 * @param   {object} opts
 * @param   {string} opts.baseUrl    - e.g. "http://localhost:3106"
 * @param   {number} [opts.timeoutMs=30000]
 * @param   {number} [opts.maxInFlight=16] - Max concurrent HTTP requests. When
 *                                           exceeded, dispatch() short-circuits
 *                                           with `{ isError: true }` instead of
 *                                           queueing. Prevents pile-up behind a
 *                                           slow upstream when multiple MCP
 *                                           clients share one dispatcher (HTTP
 *                                           transport in #AI8 Phase 2b).
 * @param   {object} [opts.defaultHeaders] - Extra headers added to every request
 * @returns {{ dispatch: function }}
 *
 * @example
 *   var d = createDispatcher({ baseUrl: 'http://localhost:3106', maxInFlight: 32 });
 *   var result = await d.dispatch(tool, { id: '42', body: { name: 'x' } });
 */
function createDispatcher(opts) {

    if (!opts || !opts.baseUrl) {
        throw new Error('createDispatcher: opts.baseUrl is required');
    }

    var baseUrl         = opts.baseUrl;
    var timeoutMs       = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var maxInFlight     = (typeof(opts.maxInFlight) === 'number' && opts.maxInFlight > 0)
                            ? opts.maxInFlight
                            : DEFAULT_MAX_IN_FLIGHT;
    var defaultHeaders  = opts.defaultHeaders || {};

    var parsed = url.parse(baseUrl);
    if (!parsed.protocol || !parsed.hostname) {
        throw new Error('createDispatcher: baseUrl must include protocol and host');
    }

    var isHttps = (parsed.protocol === 'https:');
    var httpLib = isHttps ? https : http;
    var port    = parsed.port ? ~~parsed.port : (isHttps ? 443 : 80);

    // Concurrency accounting. Incremented the moment an HTTP request is about
    // to be issued; decremented inside settle(). Early-exit paths (missing
    // tool meta, unresolved path param, over-limit) do NOT consume a slot —
    // they never touch the upstream.
    var inFlightCount = 0;


    /**
     * Dispatches a single MCP tool call. Always resolves — never rejects —
     * so the caller can wrap errors uniformly as `isError: true` results.
     *
     * Rejects with `isError: true` (never a JSON-RPC error) when the
     * concurrency cap is reached; see `maxInFlight` on createDispatcher.
     *
     * @param   {object} tool - The manifest entry
     * @param   {object} args - The `arguments` object from tools/call
     * @returns {Promise<object>} ToolResult
     */
    function dispatch(tool, args) {
        return new Promise(function(resolve) {

            var meta = (tool && tool._meta) || {};
            var pathTpl = meta['io.gina.url'];
            var method  = (meta['io.gina.method'] || 'GET').toUpperCase();

            if (!pathTpl) {
                return resolve(errorResult(
                    'Tool `' + tool.name + '` is missing `_meta["io.gina.url"]` — ' +
                    'regenerate the manifest with `gina bundle:mcp`.'
                ));
            }

            var paramNames = extractParamNames(pathTpl);
            var resolvedPath;
            try {
                resolvedPath = resolvePath(pathTpl, paramNames, args);
            } catch (resolveErr) {
                return resolve(errorResult(resolveErr.message));
            }

            if (inFlightCount >= maxInFlight) {
                return resolve(errorResult(
                    'MCP dispatcher busy — '+ inFlightCount +' request'+
                    (inFlightCount === 1 ? '' : 's') +' in flight, limit is '+
                    maxInFlight +'. Retry after current requests complete.'
                ));
            }

            // Build query string / body from args minus path params.
            var remaining = extraArgs(args, paramNames);
            var bodyObj   = null;
            var finalPath = resolvedPath;

            if (method === 'GET' || method === 'DELETE' || method === 'HEAD') {
                var qs = buildQueryString(remaining);
                if (qs) finalPath += (finalPath.indexOf('?') === -1 ? '?' : '&') + qs;
            } else {
                // POST/PUT/PATCH — prefer an explicit `body` argument, else
                // use everything that isn't a path param as the body.
                if (Object.prototype.hasOwnProperty.call(remaining, 'body') && Object.keys(remaining).length === 1) {
                    bodyObj = remaining.body;
                } else {
                    bodyObj = remaining;
                }
            }

            var headers = Object.assign({
                'Accept':       'application/json, */*',
                'User-Agent':   'gina-mcp/1.0'
            }, defaultHeaders);

            var bodyBuf = null;
            if (bodyObj != null && method !== 'GET' && method !== 'DELETE' && method !== 'HEAD') {
                bodyBuf = Buffer.from(JSON.stringify(bodyObj), 'utf8');
                headers['Content-Type']   = 'application/json';
                headers['Content-Length'] = String(bodyBuf.length);
            }

            var reqOpts = {
                hostname: parsed.hostname,
                port:     port,
                path:     finalPath,
                method:   method,
                headers:  headers
            };

            if (isHttps) {
                // Loopback self-signed certs are the norm for local dev bundles.
                reqOpts.rejectUnauthorized = false;
            }

            var settled = false;
            function settle(value) {
                if (settled) return;
                settled = true;
                inFlightCount--;
                resolve(value);
            }

            inFlightCount++;

            var req = httpLib.request(reqOpts, function(res) {
                var chunks = [];
                res.on('data', function(chunk) { chunks.push(chunk); });
                res.on('end', function() {
                    var raw = Buffer.concat(chunks).toString('utf8');
                    settle(mapResponse(res.statusCode, res.headers, raw, method, finalPath));
                });
                res.on('error', function(streamErr) {
                    settle(errorResult('Response stream error: ' + streamErr.message));
                });
            });

            req.on('error', function(reqErr) {
                if (reqErr.code === 'ECONNREFUSED') {
                    return settle(errorResult(
                        'Bundle is not running at ' + baseUrl + ' (ECONNREFUSED). ' +
                        'Start it with `gina bundle:start` and retry.'
                    ));
                }
                settle(errorResult('Dispatch error: ' + (reqErr.message || reqErr.code || String(reqErr))));
            });

            req.setTimeout(timeoutMs, function() {
                req.destroy(new Error('TIMEOUT'));
                settle(errorResult('Dispatch timed out after ' + timeoutMs + ' ms (' + method + ' ' + finalPath + ')'));
            });

            if (bodyBuf) req.write(bodyBuf);
            req.end();
        });
    }


    /**
     * Current in-flight request count. Exposed for tests and for ops
     * instrumentation once the HTTP transport lands in #AI8 Phase 2b.
     *
     * @returns {number}
     */
    function getInFlightCount() {
        return inFlightCount;
    }

    return {
        dispatch:          dispatch,
        getInFlightCount:  getInFlightCount
    };
}


/**
 * Extracts `:param` names from a URL template. Preserves order. Ignores
 * regex shapes like `:id(\d+)` — just keeps the name.
 *
 * @private
 * @param   {string} template - e.g. "/user/:id/posts/:postId"
 * @returns {string[]}        - e.g. ["id", "postId"]
 */
function extractParamNames(template) {
    var names = [];
    var re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
    var m;
    while ((m = re.exec(template)) !== null) {
        names.push(m[1]);
    }
    return names;
}


/**
 * Substitutes `:param` placeholders in a URL template with URL-encoded
 * values from `args`. Throws on missing required values.
 *
 * @private
 * @param   {string} template
 * @param   {string[]} paramNames
 * @param   {object} args
 * @returns {string}
 */
function resolvePath(template, paramNames, args) {
    var out = template;
    for (var i = 0; i < paramNames.length; i++) {
        var name = paramNames[i];
        if (typeof(args[name]) === 'undefined') {
            throw new Error('Missing path parameter: ' + name);
        }
        var value = String(args[name]);
        // Replace :name as a whole token — must not match :names starting with
        // `name` (e.g. replacing :id in "/:id/:idKind" must not touch :idKind).
        var tokenRe = new RegExp(':' + name + '(?![a-zA-Z0-9_])', 'g');
        out = out.replace(tokenRe, encodeURIComponent(value));
    }
    return out;
}


/**
 * Returns the subset of `args` that is not a path parameter.
 *
 * @private
 * @param   {object} args
 * @param   {string[]} paramNames
 * @returns {object}
 */
function extraArgs(args, paramNames) {
    var out = {};
    var skip = {};
    for (var i = 0; i < paramNames.length; i++) skip[paramNames[i]] = true;
    for (var k in args) {
        if (!Object.prototype.hasOwnProperty.call(args, k)) continue;
        if (skip[k]) continue;
        out[k] = args[k];
    }
    return out;
}


/**
 * Builds a URL-encoded query string from a plain object. Array values are
 * repeated (?k=a&k=b). Object / nested values are JSON-stringified.
 *
 * @private
 * @param   {object} obj
 * @returns {string}
 */
function buildQueryString(obj) {
    var parts = [];
    for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        var v = obj[k];
        if (v == null) continue;
        if (Array.isArray(v)) {
            for (var i = 0; i < v.length; i++) {
                parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(stringifyValue(v[i])));
            }
        } else {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(stringifyValue(v)));
        }
    }
    return parts.join('&');
}


/**
 * @private
 */
function stringifyValue(v) {
    if (v == null) return '';
    if (typeof(v) === 'object') return JSON.stringify(v);
    return String(v);
}


/**
 * Maps an HTTP response to an MCP ToolResult.
 *
 * Rules:
 *  - 2xx + JSON body → { content: [text JSON], structuredContent: parsed }
 *  - 2xx + non-JSON body → { content: [text body] }
 *  - 2xx + empty body → { content: [text 'HTTP <status> (empty body)'] }
 *  - non-2xx → isError: true, body surfaced as text
 *
 * @private
 * @param   {number} status
 * @param   {object} headers
 * @param   {string} raw
 * @param   {string} method
 * @param   {string} path
 * @returns {object}
 */
function mapResponse(status, headers, raw, method, path) {

    var isSuccess = (status >= 200 && status < 300);
    var ct = (headers && headers['content-type']) || '';
    var isJson = /application\/(?:[a-z0-9.+-]+\+)?json/i.test(ct);

    if (!isSuccess) {
        return {
            content: [{
                type: 'text',
                text: 'HTTP ' + status + ' from ' + method + ' ' + path +
                      (raw ? ('\n\n' + raw) : '')
            }],
            isError: true
        };
    }

    if (!raw) {
        return {
            content: [{
                type: 'text',
                text: 'HTTP ' + status + ' (empty body)'
            }]
        };
    }

    if (isJson) {
        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (parseErr) {
            return {
                content: [{ type: 'text', text: raw }]
            };
        }
        return {
            content: [{ type: 'text', text: JSON.stringify(parsed) }],
            structuredContent: parsed
        };
    }

    return {
        content: [{ type: 'text', text: raw }]
    };
}


/**
 * @private
 */
function errorResult(message) {
    return {
        content: [{ type: 'text', text: message }],
        isError: true
    };
}


module.exports = {
    createDispatcher:      createDispatcher,
    DEFAULT_TIMEOUT_MS:    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_IN_FLIGHT: DEFAULT_MAX_IN_FLIGHT,
    // Exposed for unit testing
    _internals: {
        extractParamNames: extractParamNames,
        resolvePath:       resolvePath,
        extraArgs:         extraArgs,
        buildQueryString:  buildQueryString,
        mapResponse:       mapResponse
    }
};
