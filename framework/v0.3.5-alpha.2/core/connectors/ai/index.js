/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

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
 * @returns {object}     - { client, provider, model, infer }
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

    // ── Public interface ──────────────────────────────────────────────────────
    return {
        client   : conn.client,    // raw SDK instance for advanced use
        provider : conn.provider,  // e.g. 'anthropic', 'deepseek', 'ollama'
        model    : conn.modelName, // default model from connectors.json
        infer    : infer
    };
}

module.exports = AI;
