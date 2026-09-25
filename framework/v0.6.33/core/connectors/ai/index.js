/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var EventEmitter = require('events').EventEmitter;

// #AISTREAM — monotonic per-process stream id (client-side disambiguation of
// interleaved token streams on the shared /_gina/agent channel).
var _aiStreamSeq = 0;

/**
 * AI connector wrapper.
 *
 * Exposes a unified `.infer(messages, options)` method that normalises the
 * response shape across Anthropic and all OpenAI-compatible providers
 * (OpenAI, DeepSeek, Qwen, Groq, Mistral, Gemini, xAI, Ollama, …).
 *
 * Returned by getModel('<connectorName>') in controllers.
 *
 * Usage:
 * ```js
 * var ai = getModel('claude');
 *
 * // async/await
 * var result = await ai.infer([
 *     { role: 'system',    content: 'You are a helpful assistant.' },
 *     { role: 'user',      content: req.body.message }
 * ]);
 * self.renderJSON({ reply: result.content });
 *
 * // .onComplete() callback
 * ai.infer(messages).onComplete(function(err, result) {
 *     if (err) return self.throwError(500, err.message);
 *     self.renderJSON({ reply: result.content });
 * });
 *
 * // streaming (token-by-token) — see stream() below
 * ai.stream(messages)
 *     .on('delta', function(d) { process.stdout.write(d.text); })
 *     .onComplete(function(err, result) { });
 * ```
 *
 * Response shape (normalised across all providers):
 * ```js
 * {
 *   content : string,              // text response
 *   model   : string,              // model that answered
 *   usage   : {
 *     inputTokens  : number,
 *     outputTokens : number
 *   },
 *   raw     : object               // original provider response
 * }
 * ```
 *
 * @class AI
 * @constructor
 * @param {object} conn  - Internal connection object from AIConnector.onReady
 * @param {object} infos - { model, bundle, database, scope } from the framework loader
 * @returns {object}     - { client, provider, model, infer, stream }
 */
function AI(conn, infos) {

    // ── infer(messages, options) ─────────────────────────────────────────────
    //
    // messages: OpenAI-format array  [{ role: 'user'|'assistant'|'system', content: string }]
    // options:
    //   model       {string}  — override the connector's default model
    //   maxTokens   {number}  — max tokens in the response (default: 1024)
    //   temperature {number}  — sampling temperature
    //   system      {string}  — system prompt (alternative to a system message in the array)
    //
    // Anthropic note: the system message is extracted from the messages array (or
    // taken from options.system) and passed as the separate `system` parameter
    // that the Messages API requires. Remaining messages go in `messages`.
    // ─────────────────────────────────────────────────────────────────────────
    var infer = function(messages, options) {
        options = options || {};

        var modelName = options.model     || conn.modelName || '';
        var maxTokens = options.maxTokens || 1024;
        var temperature = (options.temperature !== undefined) ? options.temperature : undefined;

        // ── Option B — native Promise with .onComplete() shim ─────────────────
        var _resolve, _reject, _internalData;

        var _promise = new Promise(function(resolve, reject) {
            _resolve = resolve;
            _reject  = reject;
        });

        _promise.onComplete = function(cb) {
            _promise.then(
                function()    { cb(null, _internalData); },
                function(err) { cb(err); }
            );
            return _promise;
        };

        if (!modelName) {
            _reject(new Error(
                '[AI] No model specified. '
                + 'Set "model" in connectors.json or pass { model: "..." } as the second argument.'
            ));
            return _promise;
        }

        if (conn.type === 'anthropic') {
            // ── Anthropic Messages API ─────────────────────────────────────────
            // System prompt is a top-level parameter, not a message role.
            var systemMsg = options.system || null;
            var filteredMessages = messages.filter(function(m) {
                if (m.role === 'system') {
                    if (!systemMsg) systemMsg = m.content;
                    return false;
                }
                return true;
            });

            var params = {
                model      : modelName,
                max_tokens : maxTokens,
                messages   : filteredMessages
            };
            if (systemMsg)              params.system      = systemMsg;
            if (temperature !== undefined) params.temperature = temperature;

            conn.client.messages.create(params)
                .then(function(response) {
                    var result = {
                        content : response.content[0].text,
                        model   : response.model,
                        usage   : {
                            inputTokens  : response.usage.input_tokens,
                            outputTokens : response.usage.output_tokens
                        },
                        raw     : response
                    };
                    _internalData = result;
                    _resolve(result);
                })
                .catch(function(err) { _reject(err); });

        } else {
            // ── OpenAI-compatible Chat Completions API ─────────────────────────
            // Works for: OpenAI, DeepSeek, Qwen, Groq, Mistral, Together,
            //            Gemini (OpenAI-compat), xAI, Perplexity, Ollama, vLLM…
            var msgs = messages.slice();
            if (options.system) {
                msgs = [{ role: 'system', content: options.system }].concat(msgs);
            }

            var params = {
                model      : modelName,
                messages   : msgs,
                max_tokens : maxTokens
            };
            if (temperature !== undefined) params.temperature = temperature;

            conn.client.chat.completions.create(params)
                .then(function(response) {
                    var result = {
                        content : response.choices[0].message.content,
                        model   : response.model,
                        usage   : {
                            inputTokens  : response.usage.prompt_tokens,
                            outputTokens : response.usage.completion_tokens
                        },
                        raw     : response
                    };
                    _internalData = result;
                    _resolve(result);
                })
                .catch(function(err) { _reject(err); });
        }

        return _promise;
    };

    /**
     * Streaming variant of infer().
     *
     * Returns a fresh EventEmitter surfacing the provider's token stream as
     * ordered events, leaving the buffered infer() untouched. A new emitter is
     * created per call (no shared-emitter listener accumulation).
     *
     * Events (in order):
     *   - `start` `{ model, role }` — once, when the first chunk arrives.
     *   - `delta` `{ index, text, outputTokens }` — once per token chunk. `index`
     *     is a framework-maintained 0-based counter (neither SDK numbers deltas).
     *     `outputTokens` is the running output-token total where the provider
     *     exposes it (Anthropic: cumulative on message_delta; OpenAI: null until
     *     the final usage chunk), else null/0.
     *   - `done` `{ content, model, usage:{inputTokens,outputTokens}, raw,
     *     latencyMs[, finishReason] }` — the assembled result (the same normalised
     *     shape infer() returns, plus framework-measured `latencyMs`). `raw` is the
     *     provider's final message for Anthropic, null for OpenAI-compatible
     *     streams (which expose no single final response object).
     *   - `error` `(err)` — emitted only when an `error` listener is attached, so a
     *     caller using only `.onComplete(cb)` cannot crash the process on an
     *     unhandled `error` event; the error still reaches `.onComplete(cb)`.
     *
     * Also exposes `.onComplete(cb)` (`cb(err)` | `cb(null, doneResult)`) mirroring
     * infer(), for callers that only want the assembled result.
     *
     * Token-counter honesty: neither SDK provides a per-delta output-token count.
     * Anthropic emits a cumulative running total on `message_delta`; OpenAI-compatible
     * providers emit a single end-of-stream usage chunk only when
     * `stream_options.include_usage` is honored (some providers omit it, so usage may
     * stay null). `latencyMs` is framework-measured at both branches.
     *
     * @param   {Array<object>} messages          - OpenAI-format [{ role, content }] array.
     * @param   {object}        [options]
     * @param   {string}        [options.model]       - Override the connector default model.
     * @param   {number}        [options.maxTokens=1024]
     * @param   {number}        [options.temperature]
     * @param   {string}        [options.system]      - System prompt (alternative to a system message).
     * @returns {EventEmitter}  emitter emitting start/delta/done/error, with an .onComplete(cb) shim.
     *
     * @example
     * // token-by-token
     * getModel('claude').stream([{ role: 'user', content: 'Tell me a joke.' }])
     *     .on('start', function(s) { })              // { model, role }
     *     .on('delta', function(d) { process.stdout.write(d.text); })
     *     .on('done',  function(r) { })              // { content, model, usage, latencyMs }
     *     .on('error', function(e) { });
     *
     * @example
     * // assembled result only (mirrors infer())
     * getModel('claude').stream(messages).onComplete(function(err, result) {
     *     if (err) return self.throwError(500, err.message);
     *     self.renderJSON({ reply: result.content });
     * });
     */
    var stream = function(messages, options) {
        options = options || {};
        var emitter = new EventEmitter();

        var modelName   = options.model || conn.modelName || '';
        var maxTokens   = options.maxTokens || 1024;
        var temperature = (options.temperature !== undefined) ? options.temperature : undefined;

        // Terminal-result shim — mirrors infer()'s .onComplete(cb).
        var _resolve, _reject, _internalData, _settled = false;
        var _done = new Promise(function(resolve, reject) {
            _resolve = resolve;
            _reject  = reject;
        });
        // Absorb the internal rejection so a caller observing failures only via
        // .on('error') does not also trip an unhandledRejection.
        _done.catch(function() {});

        emitter.onComplete = function(cb) {
            _done.then(
                function()    { cb(null, _internalData); },
                function(err) { cb(err); }
            );
            return emitter;
        };

        var _settleDone = function(result) {
            if (_settled) return;
            _settled = true;
            _internalData = result;
            emitter.emit('done', result);
            _resolve(result);
        };
        // 'error' is emitted only when a listener is attached, so a caller using
        // .onComplete() (and no 'error' listener) cannot crash the process on an
        // unhandled 'error' event; the rejection still reaches .onComplete(cb).
        var _settleError = function(err) {
            if (_settled) return;
            _settled = true;
            if (emitter.listenerCount('error') > 0) { emitter.emit('error', err); }
            _reject(err);
        };

        if (!modelName) {
            process.nextTick(function() {
                _settleError(new Error(
                    '[AI] No model specified. '
                    + 'Set "model" in connectors.json or pass { model: "..." } as the second argument.'
                ));
            });
            return emitter;
        }

        var _startMs = Date.now();
        var _index   = 0;
        var _started = false;
        var emitStart = function(model, role) {
            if (_started) return;
            _started = true;
            emitter.emit('start', { model: model, role: role });
        };

        // ── AI token-stream inspection (#AISTREAM) — gated, additive ──────────
        // Captured under the same dev / instrumentation-window gate the query
        // connectors use. The per-request buffer ref is grabbed synchronously (in
        // the request's async context, where setOptions ran enterWith) and mutated
        // via closure as events fire — mirroring the query-connector pattern. Chunk
        // TEXT (and the prompt) ride the wire ONLY when settings.inspector.ai
        // .captureText is on (seeded onto process.gina at boot); metadata is always
        // captured. Instrumentation attaches as listeners on the emitter so the
        // provider-specific paths below stay pure; infer() is unaffected. A live
        // inspector#token event is emitted per phase for the Inspector's streaming
        // view (no subscriber ⇒ a cheap no-op).
        var _aiEnvIsDev = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) );
        if (_aiEnvIsDev || (process.gina && process.gina._inspectorWindowUntil > Date.now())) {
            var _aiAls = (process.gina && process.gina._queryALS) ? process.gina._queryALS.getStore() : null;
            var _aiLog = _aiAls ? _aiAls._devAiLog : null;
            if (_aiLog) {
                var _captureText = !!(process.gina && process.gina._inspectorAiCaptureText);
                var _streamId    = 'ai-' + _startMs.toString(36) + '-' + (++_aiStreamSeq);
                var _aiEntry = {
                    type         : 'AI',
                    id           : _streamId,
                    provider     : conn.provider,
                    model        : modelName,
                    role         : null,
                    promptTokens : null,
                    outputTokens : null,
                    chunks       : 0,
                    durationMs   : 0,
                    error        : null,
                    origin       : (infos && infos.bundle) || ''
                };
                if (_captureText) {
                    _aiEntry.prompt = messages;   // raw prompt — captured only when captureText is on
                    _aiEntry.text   = '';
                }
                _aiEntry._startMs = _startMs;
                _aiLog.push(_aiEntry);

                // 'token' is the SSE/WS event NAME, never a payload key (a bare `token`
                // key would be wholesale-redacted); phase/index/outputTokens/deltaText
                // are redaction-safe.
                var _aiToken = function(frame) {
                    frame.t  = Date.now();
                    frame.id = _streamId;
                    process.emit('inspector#token', frame);
                };

                emitter.on('start', function(s) {
                    _aiEntry.model = s.model;
                    _aiEntry.role  = s.role;
                    _aiToken({ phase: 'start', model: s.model, role: s.role });
                });
                emitter.on('delta', function(d) {
                    _aiEntry.chunks += 1;
                    if (typeof d.outputTokens === 'number') { _aiEntry.outputTokens = d.outputTokens; }
                    if (_captureText && typeof _aiEntry.text === 'string') { _aiEntry.text += d.text; }
                    var frame = { phase: 'delta', index: d.index, outputTokens: (typeof d.outputTokens === 'number' ? d.outputTokens : null) };
                    if (_captureText) { frame.deltaText = d.text; }
                    _aiToken(frame);
                });
                emitter.on('done', function(r) {
                    _aiEntry.durationMs = r.latencyMs;
                    _aiEntry.model      = r.model;
                    if (r.usage) {
                        _aiEntry.promptTokens = r.usage.inputTokens;
                        _aiEntry.outputTokens = r.usage.outputTokens;
                    }
                    _aiToken({ phase: 'done', model: r.model, outputTokens: (r.usage ? r.usage.outputTokens : null), latencyMs: r.latencyMs });
                });
                // Internal 'error' listener — records the failure AND guarantees the
                // emitter always has an 'error' handler while capturing, so a caller
                // without its own 'error' listener cannot crash on an unhandled event.
                emitter.on('error', function(err) {
                    _aiEntry.error = (err && err.message) || String(err);
                    _aiToken({ phase: 'error', message: _captureText ? ((err && err.message) || String(err)) : null });
                });
            }
        }

        // Defer one tick so callers can attach .on('start'/'delta'/...) synchronously
        // after stream() returns, before any event fires (mirrors the Option-B timing).
        if (conn.type === 'anthropic') {
            process.nextTick(function() {
                try {
                    // System prompt is a top-level parameter, not a message role.
                    var systemMsg = options.system || null;
                    var filteredMessages = messages.filter(function(m) {
                        if (m.role === 'system') {
                            if (!systemMsg) systemMsg = m.content;
                            return false;
                        }
                        return true;
                    });

                    var params = {
                        model      : modelName,
                        max_tokens : maxTokens,
                        messages   : filteredMessages
                    };
                    if (systemMsg)                 params.system      = systemMsg;
                    if (temperature !== undefined) params.temperature = temperature;

                    var _model = modelName, _role = 'assistant',
                        _outputTokens = 0, _inputTokens = null, _text = '';

                    // The Anthropic MessageStream is itself an EventEmitter.
                    var sdkStream = conn.client.messages.stream(params);

                    // Raw SSE events carry model/role (message_start) and the
                    // CUMULATIVE running output-token total (message_delta.usage).
                    sdkStream.on('streamEvent', function(event) {
                        if (!event) return;
                        if (event.type === 'message_start' && event.message) {
                            _model = event.message.model || _model;
                            _role  = event.message.role  || _role;
                            if (event.message.usage
                                && typeof event.message.usage.input_tokens === 'number') {
                                _inputTokens = event.message.usage.input_tokens;
                            }
                            emitStart(_model, _role);
                        } else if (event.type === 'message_delta' && event.usage
                                && typeof event.usage.output_tokens === 'number') {
                            _outputTokens = event.usage.output_tokens;
                        }
                    });

                    // Incremental text chunks.
                    sdkStream.on('text', function(delta) {
                        emitStart(_model, _role);
                        _text += delta;
                        emitter.emit('delta', { index: _index++, text: delta, outputTokens: _outputTokens });
                    });

                    sdkStream.on('error', _settleError);

                    sdkStream.finalMessage().then(function(message) {
                        emitStart(_model, _role);
                        _settleDone({
                            content   : (message && message.content && message.content[0] && message.content[0].text) || _text,
                            model     : (message && message.model) || _model,
                            usage     : {
                                inputTokens  : (message && message.usage && message.usage.input_tokens  != null) ? message.usage.input_tokens  : _inputTokens,
                                outputTokens : (message && message.usage && message.usage.output_tokens != null) ? message.usage.output_tokens : _outputTokens
                            },
                            raw       : message || null,
                            latencyMs : Date.now() - _startMs
                        });
                    }, _settleError);
                } catch (err) {
                    _settleError(err);
                }
            });

        } else {
            // OpenAI-compatible streaming (chat.completions with stream: true).
            process.nextTick(function() {
                (async function() {
                    try {
                        var msgs = messages.slice();
                        if (options.system) {
                            msgs = [{ role: 'system', content: options.system }].concat(msgs);
                        }

                        var params = {
                            model          : modelName,
                            messages       : msgs,
                            max_tokens     : maxTokens,
                            stream         : true,
                            // Ask for a final usage chunk; honored by most OpenAI-compatible
                            // providers (some — e.g. Ollama — may omit it, so usage stays null).
                            stream_options : { include_usage: true }
                        };
                        if (temperature !== undefined) params.temperature = temperature;

                        var _model = modelName, _role = 'assistant',
                            _outputTokens = null, _inputTokens = null, _text = '', _finishReason = null;

                        var sdkStream = await conn.client.chat.completions.create(params);

                        for await (var chunk of sdkStream) {
                            if (!chunk) continue;
                            if (chunk.model) { _model = chunk.model; }
                            var choice = chunk.choices && chunk.choices[0];
                            if (choice && choice.delta) {
                                if (choice.delta.role) { _role = choice.delta.role; }
                                emitStart(_model, _role);
                                if (typeof choice.delta.content === 'string' && choice.delta.content.length > 0) {
                                    _text += choice.delta.content;
                                    emitter.emit('delta', { index: _index++, text: choice.delta.content, outputTokens: _outputTokens });
                                }
                                if (choice.finish_reason) { _finishReason = choice.finish_reason; }
                            }
                            // Final usage chunk (empty choices) when include_usage is honored.
                            if (chunk.usage) {
                                if (typeof chunk.usage.prompt_tokens     === 'number') { _inputTokens  = chunk.usage.prompt_tokens; }
                                if (typeof chunk.usage.completion_tokens === 'number') { _outputTokens = chunk.usage.completion_tokens; }
                            }
                        }

                        emitStart(_model, _role); // ensure 'start' fired even for an empty stream
                        _settleDone({
                            content      : _text,
                            model        : _model,
                            usage        : { inputTokens: _inputTokens, outputTokens: _outputTokens },
                            finishReason : _finishReason,
                            raw          : null,
                            latencyMs    : Date.now() - _startMs
                        });
                    } catch (err) {
                        _settleError(err);
                    }
                })();
            });
        }

        return emitter;
    };

    // ── Public interface ──────────────────────────────────────────────────────
    return {
        client   : conn.client,    // raw SDK instance for advanced use
        provider : conn.provider,  // e.g. 'anthropic', 'deepseek', 'ollama'
        model    : conn.modelName, // default model from connectors.json
        infer    : infer,
        stream   : stream          // streaming variant of infer() (EventEmitter: start/delta/done/error)
    };
}

module.exports = AI;
