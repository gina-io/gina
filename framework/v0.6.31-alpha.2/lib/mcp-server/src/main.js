/**
 * @module gina/lib/mcp-server
 *
 * Model Context Protocol server primitives. Spec revision 2025-06-18.
 *
 * Responsibilities:
 *  - JSON-RPC 2.0 parsing and framing
 *  - MCP lifecycle state machine (uninitialized → initializing → initialized)
 *  - Method handlers: initialize, ping, tools/list, tools/call
 *  - Notification handlers: notifications/initialized, notifications/cancelled
 *  - Input validation against tool inputSchema (type, required, pattern, enum)
 *  - Mapping dispatch results to MCP tool-result shape
 *
 * Out of scope (by design):
 *  - Transport I/O — attachStdio() is a thin convenience; otherwise consumers
 *    call handleMessage(rawFrame) with their own framing
 *  - Tool dispatch — injected as opts.dispatch(tool, args) → Promise<ToolResult>
 *  - Config reading, fs, network
 */

'use strict';

var MCP_PROTOCOL_VERSION    = '2025-06-18';
var JSONRPC_VERSION         = '2.0';

// JSON-RPC 2.0 error codes
var ERR_PARSE               = -32700;
var ERR_INVALID_REQUEST     = -32600;
var ERR_METHOD_NOT_FOUND    = -32601;
var ERR_INVALID_PARAMS      = -32602;
var ERR_INTERNAL            = -32603;


/**
 * Creates an MCP server instance bound to a manifest and a dispatch function.
 *
 * The returned server is transport-agnostic. Call `handleMessage(frame)` with
 * a raw JSON-RPC frame string to get back a response string (or null for
 * notifications). Use `attachStdio({input, output})` for newline-delimited
 * stdio transport.
 *
 * @param   {object}    opts
 * @param   {object}    opts.manifest     - Parsed mcp.json document
 * @param   {function}  opts.dispatch     - async (tool, args) => ToolResult
 * @param   {object}    opts.serverInfo   - { name, version, title? }
 * @param   {string}    [opts.instructions] - Optional server-level hint
 * @param   {string}    [opts.protocolVersion=2025-06-18] - MCP revision
 * @param   {function}  [opts.onError]    - (err) => void, for transport logs
 * @returns {object}    { handleMessage, attachStdio, state, close }
 *
 * @example
 *   var server = createServer({
 *       manifest: require('./mcp.json'),
 *       dispatch: dispatcher.dispatch,
 *       serverInfo: { name: 'gina-mcp', version: '0.3.8-alpha.1' }
 *   });
 *   server.attachStdio({ input: process.stdin, output: mcpStdout });
 */
function createServer(opts) {

    if (!opts || typeof(opts) !== 'object') {
        throw new Error('createServer: opts is required');
    }
    if (!opts.manifest || !Array.isArray(opts.manifest.tools)) {
        throw new Error('createServer: opts.manifest.tools must be an array');
    }
    if (typeof(opts.dispatch) !== 'function') {
        throw new Error('createServer: opts.dispatch must be a function');
    }
    if (!opts.serverInfo || !opts.serverInfo.name) {
        throw new Error('createServer: opts.serverInfo.name is required');
    }

    var manifest            = opts.manifest;
    var dispatch            = opts.dispatch;
    var serverInfo          = opts.serverInfo;
    var instructions        = opts.instructions || null;
    var protocolVersion     = opts.protocolVersion || MCP_PROTOCOL_VERSION;
    var onError             = (typeof(opts.onError) === 'function') ? opts.onError : function() {};

    var state = {
        phase:                      'uninitialized',
        negotiatedProtocolVersion:  null,
        clientInfo:                 null,
        cancelled:                  {}
    };

    // Fast lookup by tool name
    var toolsByName = {};
    for (var i = 0; i < manifest.tools.length; i++) {
        toolsByName[manifest.tools[i].name] = manifest.tools[i];
    }

    var closed = false;
    var stdioDetach = null;


    /**
     * Parses, routes, and responds to one JSON-RPC frame.
     *
     * @param   {string} raw - A single JSON-RPC frame (no newline needed)
     * @returns {Promise<string|null>} Response frame (JSON string, no newline)
     *                                 or null for notifications.
     */
    function handleMessage(raw) {
        return new Promise(function(resolve) {

            var msg = null;
            try {
                msg = JSON.parse(raw);
            } catch (parseErr) {
                return resolve(encodeResponse(null, null, {
                    code:    ERR_PARSE,
                    message: 'Parse error: ' + parseErr.message
                }));
            }

            if (!msg || typeof(msg) !== 'object' || msg.jsonrpc !== JSONRPC_VERSION) {
                return resolve(encodeResponse(null, null, {
                    code:    ERR_INVALID_REQUEST,
                    message: 'Invalid JSON-RPC 2.0 request'
                }));
            }

            var isNotification = (typeof(msg.id) === 'undefined');

            if (typeof(msg.method) !== 'string') {
                if (isNotification) return resolve(null);
                return resolve(encodeResponse(msg.id, null, {
                    code:    ERR_INVALID_REQUEST,
                    message: 'Request is missing `method`'
                }));
            }

            // Notifications are fire-and-forget; they never produce responses.
            if (isNotification) {
                handleNotification(msg);
                return resolve(null);
            }

            // Request — every branch must resolve exactly once.
            Promise.resolve().then(function() {
                return routeRequest(msg);
            }).then(function(result) {
                resolve(encodeResponse(msg.id, result, null));
            }).catch(function(err) {
                var rpcErr = errToRpc(err);
                resolve(encodeResponse(msg.id, null, rpcErr));
            });
        });
    }


    /**
     * Dispatches a request message to the right handler. Resolves with the
     * `result` payload; throws a RpcError (via `makeRpcError`) for protocol
     * failures.
     *
     * @private
     * @param   {object} msg - Parsed JSON-RPC request
     * @returns {Promise<object>}
     */
    function routeRequest(msg) {
        var method = msg.method;

        // Before initialize(), only initialize itself is allowed.
        if (state.phase === 'uninitialized' && method !== 'initialize') {
            throw makeRpcError(ERR_INVALID_REQUEST,
                'Server must receive `initialize` before any other request. Got: ' + method);
        }

        switch (method) {
            case 'initialize':          return handleInitialize(msg);
            case 'ping':                return Promise.resolve({});
            case 'tools/list':          return handleToolsList(msg);
            case 'tools/call':          return handleToolsCall(msg);
            default:
                throw makeRpcError(ERR_METHOD_NOT_FOUND, 'Method not found: ' + method);
        }
    }


    /**
     * Handles `initialize` — negotiates protocol version and advertises
     * server capabilities. Transitions state to `initializing`. The state
     * moves to `initialized` when the client sends the `notifications/initialized`
     * notification (per MCP lifecycle spec).
     *
     * @private
     * @param   {object} msg
     * @returns {Promise<object>} InitializeResult
     */
    function handleInitialize(msg) {
        if (state.phase !== 'uninitialized') {
            throw makeRpcError(ERR_INVALID_REQUEST,
                'initialize may only be called once');
        }

        var params = msg.params || {};
        var requested = params.protocolVersion || protocolVersion;

        // Per spec: server echoes the version it supports. If the client asks
        // for something older or newer, server replies with its own version
        // and the client decides whether to continue.
        var negotiated = (requested === protocolVersion) ? requested : protocolVersion;

        state.phase                     = 'initializing';
        state.negotiatedProtocolVersion = negotiated;
        state.clientInfo                = params.clientInfo || null;

        var result = {
            protocolVersion: negotiated,
            capabilities: {
                tools: {
                    listChanged: false
                }
            },
            serverInfo: serverInfo
        };

        if (instructions) {
            result.instructions = instructions;
        }

        return Promise.resolve(result);
    }


    /**
     * Handles `tools/list` — returns every tool from the manifest.
     *
     * Pagination (`cursor`, `nextCursor`) is not used; manifests are bounded
     * in size and shipping them in one shot simplifies client code. If a
     * future manifest exceeds the practical frame size, add cursor paging.
     *
     * @private
     * @returns {Promise<object>} { tools: Tool[] }
     */
    function handleToolsList(/* msg */) {
        var out = [];
        for (var i = 0; i < manifest.tools.length; i++) {
            var t = manifest.tools[i];
            var pub = {
                name:        t.name,
                description: t.description || '',
                inputSchema: t.inputSchema || { type: 'object' }
            };
            if (t.title)         pub.title       = t.title;
            if (t.annotations)   pub.annotations = t.annotations;
            if (t.outputSchema)  pub.outputSchema= t.outputSchema;
            if (t._meta)         pub._meta       = t._meta;
            out.push(pub);
        }
        return Promise.resolve({ tools: out });
    }


    /**
     * Handles `tools/call` — validates arguments against inputSchema, calls
     * the injected dispatch function, and maps the result into MCP ToolResult
     * shape. Tool-execution failures are returned as `isError: true` results,
     * NOT as JSON-RPC errors (per MCP spec §Tools).
     *
     * Only protocol-level problems (missing params, unknown tool, cancelled
     * request) surface as JSON-RPC errors.
     *
     * @private
     * @param   {object} msg
     * @returns {Promise<object>} MCP ToolResult
     */
    function handleToolsCall(msg) {
        var params = msg.params || {};
        var name   = params.name;
        var args   = params.arguments || {};

        if (typeof(name) !== 'string' || !name) {
            throw makeRpcError(ERR_INVALID_PARAMS, '`name` is required');
        }

        var tool = toolsByName[name];
        if (!tool) {
            throw makeRpcError(ERR_METHOD_NOT_FOUND, 'Unknown tool: ' + name);
        }

        var validationErr = validateArguments(tool.inputSchema || {}, args);
        if (validationErr) {
            throw makeRpcError(ERR_INVALID_PARAMS, validationErr);
        }

        // Check cancellation flag (set by notifications/cancelled before call).
        if (msg.id != null && state.cancelled[String(msg.id)]) {
            delete state.cancelled[String(msg.id)];
            throw makeRpcError(ERR_INTERNAL, 'Request cancelled by client');
        }

        return Promise.resolve().then(function() {
            return dispatch(tool, args);
        }).then(function(result) {
            // Normalise result shape. dispatch() is expected to return either:
            //   { content: [...], structuredContent?, isError? }
            //   or a plain value (coerce to text content).
            if (result && Array.isArray(result.content)) {
                return result;
            }
            return {
                content: [{
                    type: 'text',
                    text: (typeof(result) === 'string') ? result : JSON.stringify(result)
                }]
            };
        }).catch(function(err) {
            // Tool execution failure — spec says return isError, not RPC error.
            return {
                content: [{
                    type: 'text',
                    text: (err && err.message) ? err.message : String(err)
                }],
                isError: true
            };
        });
    }


    /**
     * Handles incoming notifications. `notifications/initialized` completes
     * the lifecycle handshake. `notifications/cancelled` marks a request id
     * as cancelled — if the corresponding tools/call has not yet returned,
     * the dispatch result is discarded.
     *
     * @private
     * @param   {object} msg
     * @returns {void}
     */
    function handleNotification(msg) {
        switch (msg.method) {
            case 'notifications/initialized':
                if (state.phase === 'initializing') {
                    state.phase = 'initialized';
                }
                break;
            case 'notifications/cancelled':
                var p = msg.params || {};
                if (p.requestId != null) {
                    state.cancelled[String(p.requestId)] = true;
                }
                break;
            // Unknown notifications are silently ignored per JSON-RPC 2.0.
        }
    }


    /**
     * Validates call arguments against a tool's inputSchema.
     *
     * Supports the subset of JSON Schema actually emitted by `bundle:mcp`:
     *  - `type: "object"` root
     *  - `required: [...]`
     *  - `properties.<name>.type` (string / object only — URL params are
     *    always strings; `body` is always object)
     *  - `properties.<name>.pattern`  (RegExp)
     *  - `properties.<name>.enum`     (value in list)
     *
     * Returns null on success, or a human-readable error string on failure.
     *
     * @private
     * @param   {object} schema
     * @param   {object} args
     * @returns {string|null}
     */
    function validateArguments(schema, args) {

        if (!schema || typeof(schema) !== 'object') return null;
        if (args == null || typeof(args) !== 'object') {
            return 'arguments must be an object';
        }

        if (Array.isArray(schema.required)) {
            for (var i = 0; i < schema.required.length; i++) {
                var r = schema.required[i];
                if (typeof(args[r]) === 'undefined') {
                    return 'missing required argument: ' + r;
                }
            }
        }

        var props = schema.properties || {};
        for (var name in props) {
            if (!Object.prototype.hasOwnProperty.call(props, name)) continue;
            if (typeof(args[name]) === 'undefined') continue;

            var p = props[name];
            var v = args[name];

            if (p.type === 'string') {
                if (typeof(v) !== 'string') {
                    return 'argument `' + name + '` must be a string';
                }
                if (p.pattern) {
                    var re;
                    try { re = new RegExp(p.pattern); } catch (e) { re = null; }
                    if (re && !re.test(v)) {
                        return 'argument `' + name + '` does not match pattern ' + p.pattern;
                    }
                }
                if (Array.isArray(p.enum) && p.enum.indexOf(v) === -1) {
                    return 'argument `' + name + '` must be one of: ' + p.enum.join(', ');
                }
            } else if (p.type === 'object') {
                if (v === null || typeof(v) !== 'object' || Array.isArray(v)) {
                    return 'argument `' + name + '` must be an object';
                }
            } else if (p.type === 'number' || p.type === 'integer') {
                if (typeof(v) !== 'number') {
                    return 'argument `' + name + '` must be a number';
                }
            } else if (p.type === 'boolean') {
                if (typeof(v) !== 'boolean') {
                    return 'argument `' + name + '` must be a boolean';
                }
            }
        }

        return null;
    }


    /**
     * Encodes a JSON-RPC 2.0 response frame. Exactly one of `result` or
     * `error` is set. Returns a JSON string with no trailing newline; the
     * transport layer is responsible for framing.
     *
     * @private
     * @param   {string|number|null} id
     * @param   {*} result
     * @param   {{code: number, message: string}|null} error
     * @returns {string}
     */
    function encodeResponse(id, result, error) {
        var frame = { jsonrpc: JSONRPC_VERSION };
        // For parse errors and malformed requests, id may be null.
        frame.id = (typeof(id) === 'undefined') ? null : id;
        if (error) {
            frame.error = error;
        } else {
            frame.result = (typeof(result) === 'undefined') ? null : result;
        }
        return JSON.stringify(frame);
    }


    /**
     * Attaches this server to a stdio-style transport. Reads newline-delimited
     * UTF-8 JSON frames from `input` and writes responses to `output` (also
     * newline-delimited). Returns a detach function.
     *
     * @param   {object}            io
     * @param   {stream.Readable}   io.input
     * @param   {function|object}   io.output - Either a writable stream with
     *                                          .write(), or a write function.
     * @param   {function}          [io.onClose] - Called when input ends/closes.
     * @returns {function}          detach
     *
     * @example
     *   server.attachStdio({
     *       input:  process.stdin,
     *       output: { write: process.__ginaMcpStdout },
     *       onClose: function () { process.exit(0); }
     *   });
     */
    function attachStdio(io) {

        if (stdioDetach) {
            throw new Error('attachStdio: already attached — detach first');
        }

        var input  = io.input;
        var output = io.output;
        var onClose = (typeof(io.onClose) === 'function') ? io.onClose : null;

        if (!input || typeof(input.on) !== 'function') {
            throw new Error('attachStdio: input must be a Readable stream');
        }
        var write = null;
        if (typeof(output) === 'function') {
            write = output;
        } else if (output && typeof(output.write) === 'function') {
            write = output.write.bind(output);
        } else {
            throw new Error('attachStdio: output must be a writable stream or function');
        }

        var buffer = '';

        function onData(chunk) {
            buffer += chunk.toString('utf8');
            var newlineIndex;
            // Drain every complete frame synchronously; process each async.
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                var line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (!line.trim()) continue;
                processFrame(line);
            }
        }

        function processFrame(line) {
            handleMessage(line).then(function(response) {
                if (response != null && !closed) {
                    try {
                        write(response + '\n');
                    } catch (writeErr) {
                        onError(writeErr);
                    }
                }
            }, function(unexpected) {
                // handleMessage() always resolves — this branch is defensive.
                onError(unexpected);
            });
        }

        function onEnd() {
            if (onClose) onClose();
        }

        input.setEncoding && input.setEncoding('utf8');
        input.on('data', onData);
        input.on('end', onEnd);
        input.on('close', onEnd);

        stdioDetach = function() {
            input.removeListener('data', onData);
            input.removeListener('end', onEnd);
            input.removeListener('close', onEnd);
            stdioDetach = null;
        };

        return stdioDetach;
    }


    /**
     * Releases any transport wiring. Further handleMessage calls still work
     * but responses will not be auto-written anywhere.
     *
     * @returns {void}
     */
    function close() {
        closed = true;
        if (stdioDetach) stdioDetach();
    }


    return {
        handleMessage:  handleMessage,
        attachStdio:    attachStdio,
        state:          state,
        toolsByName:    toolsByName,
        close:          close
    };
}


/**
 * Builds a protocol-level error suitable for `encodeResponse(..., err)`.
 *
 * @private
 * @param   {number} code
 * @param   {string} message
 * @returns {Error}
 */
function makeRpcError(code, message) {
    var err = new Error(message);
    err.isRpcError = true;
    err.rpcCode = code;
    return err;
}


/**
 * Maps a thrown error to a JSON-RPC error object. RpcErrors pass through;
 * anything else becomes an INTERNAL error with its message preserved.
 *
 * @private
 * @param   {Error} err
 * @returns {{code: number, message: string}}
 */
function errToRpc(err) {
    if (err && err.isRpcError) {
        return { code: err.rpcCode, message: err.message };
    }
    return {
        code:    ERR_INTERNAL,
        message: (err && err.message) ? err.message : 'Internal error'
    };
}


module.exports = {
    createServer:           createServer,
    MCP_PROTOCOL_VERSION:   MCP_PROTOCOL_VERSION,
    errors: {
        PARSE:              ERR_PARSE,
        INVALID_REQUEST:    ERR_INVALID_REQUEST,
        METHOD_NOT_FOUND:   ERR_METHOD_NOT_FOUND,
        INVALID_PARAMS:     ERR_INVALID_PARAMS,
        INTERNAL:           ERR_INTERNAL
    }
};
