/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var EventEmitter = require('events').EventEmitter;
var gina         = require('../../../../core/gna');
var lib          = gina.lib;
var console      = lib.logger;
var inherits     = lib.inherits;

/**
 * AI connector — creates a configured AI provider client.
 *
 * The SDK (`@anthropic-ai/sdk` or `openai`) is loaded from the **project's**
 * node_modules so the framework has zero hard dependency on either.
 *
 * Named protocol shortcuts resolve the base URL automatically:
 *
 * | Protocol       | SDK                | Default base URL                                         |
 * |----------------|--------------------|----------------------------------------------------------|
 * | anthropic://   | @anthropic-ai/sdk  | https://api.anthropic.com                                |
 * | openai://      | openai             | https://api.openai.com/v1                                |
 * | deepseek://    | openai             | https://api.deepseek.com/v1                              |
 * | qwen://        | openai             | https://dashscope.aliyuncs.com/compatible-mode/v1        |
 * | groq://        | openai             | https://api.groq.com/openai/v1                           |
 * | mistral://     | openai             | https://api.mistral.ai/v1                                |
 * | together://    | openai             | https://api.together.xyz/v1                              |
 * | ollama://      | openai             | http://localhost:11434/v1                                |
 * | gemini://      | openai             | https://generativelanguage.googleapis.com/v1beta/openai/ |
 * | xai://         | openai             | https://api.x.ai/v1                                      |
 * | perplexity://  | openai             | https://api.perplexity.ai                                |
 *
 * Any `openai://`-family protocol accepts an optional `baseURL` override in
 * connectors.json to point at any OpenAI-compatible endpoint, including
 * self-hosted vLLM or custom inference servers.
 *
 * connectors.json entry:
 * {
 *   "claude": {
 *     "connector" : "ai",
 *     "protocol"  : "anthropic://",
 *     "apiKey"    : "${ANTHROPIC_API_KEY}",
 *     "model"     : "claude-opus-4-6"
 *   },
 *   "deepseek": {
 *     "connector" : "ai",
 *     "protocol"  : "deepseek://",
 *     "apiKey"    : "${DEEPSEEK_API_KEY}",
 *     "model"     : "deepseek-chat"
 *   },
 *   "local": {
 *     "connector" : "ai",
 *     "protocol"  : "ollama://",
 *     "model"     : "mimo"
 *   }
 * }
 *
 * No live connectivity ping is performed at startup — AI API calls cost tokens.
 *
 * @class AIConnector
 * @constructor
 * @param {object}  conf             - Connector config from connectors.json
 * @param {string}  conf.protocol    - Provider protocol (e.g. "anthropic://", "deepseek://")
 * @param {string}  [conf.apiKey]    - API key. Supports ${ENV_VAR} substitution
 * @param {string}  [conf.model]     - Default model identifier
 * @param {string}  [conf.baseURL]   - Override the default base URL (openai-family only)
 */
function AIConnector(conf) {
    var _conn = null;
    var _err  = null;

    // ── Known providers ───────────────────────────────────────────────────────
    var PROVIDERS = {
        'anthropic' : { type: 'anthropic', baseURL: null },
        'openai'    : { type: 'openai',    baseURL: null },
        'deepseek'  : { type: 'openai',    baseURL: 'https://api.deepseek.com/v1' },
        'qwen'      : { type: 'openai',    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
        'groq'      : { type: 'openai',    baseURL: 'https://api.groq.com/openai/v1' },
        'mistral'   : { type: 'openai',    baseURL: 'https://api.mistral.ai/v1' },
        'together'  : { type: 'openai',    baseURL: 'https://api.together.xyz/v1' },
        'ollama'    : { type: 'openai',    baseURL: 'http://localhost:11434/v1' },
        'gemini'    : { type: 'openai',    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
        'xai'       : { type: 'openai',    baseURL: 'https://api.x.ai/v1' },
        'perplexity': { type: 'openai',    baseURL: 'https://api.perplexity.ai' }
    };

    var init = function(conf) {
        var protocol = (conf.protocol || 'openai://');
        var scheme   = protocol.split(':')[0].toLowerCase();
        var provider = PROVIDERS[scheme];

        if (!provider) {
            _err = new Error(
                '[AIConnector] Unknown protocol: "' + protocol + '".\n'
                + 'Supported protocols: '
                + Object.keys(PROVIDERS).map(function(k) { return k + '://'; }).join(', ')
            );
            return;
        }

        // conf.baseURL overrides the provider default (useful for custom ollama port,
        // corporate proxies, or any unlisted OpenAI-compatible endpoint).
        var baseURL = conf.baseURL || provider.baseURL;

        if (provider.type === 'anthropic') {
            var Mod;
            try {
                var sdkPath = _(getPath('project') + '/node_modules/@anthropic-ai/sdk', true);
                Mod = require(sdkPath);
            } catch (e) {
                _err = new Error(
                    '[AIConnector] @anthropic-ai/sdk is not installed in your project.\n'
                    + 'Run: npm install @anthropic-ai/sdk\n'
                    + e.message
                );
                return;
            }
            try {
                var Anthropic = Mod.Anthropic || Mod.default || Mod;
                var client    = new Anthropic({ apiKey: conf.apiKey });
                _conn = {
                    client   : client,
                    provider : scheme,
                    type     : 'anthropic',
                    modelName: conf.model || null
                };
                console.debug('[AIConnector] Anthropic client created');
            } catch (e) {
                _err = new Error('[AIConnector] Failed to create Anthropic client: ' + e.message);
            }

        } else {
            // OpenAI-compatible (openai, deepseek, qwen, groq, mistral, together,
            //                    ollama, gemini, xai, perplexity, or any custom endpoint)
            var Mod;
            try {
                var sdkPath = _(getPath('project') + '/node_modules/openai', true);
                Mod = require(sdkPath);
            } catch (e) {
                _err = new Error(
                    '[AIConnector] openai is not installed in your project.\n'
                    + 'Run: npm install openai\n'
                    + e.message
                );
                return;
            }
            try {
                var OpenAI     = Mod.OpenAI || Mod.default || Mod;
                var clientConf = { apiKey: conf.apiKey || 'no-key' };
                if (baseURL) clientConf.baseURL = baseURL;
                var client = new OpenAI(clientConf);
                _conn = {
                    client   : client,
                    provider : scheme,
                    type     : 'openai',
                    modelName: conf.model || null
                };
                console.debug('[AIConnector] OpenAI-compatible client created for: ' + scheme);
            } catch (e) {
                _err = new Error('[AIConnector] Failed to create OpenAI client: ' + e.message);
            }
        }
    };

    /**
     * Register a one-time ready callback.
     * No live API ping is performed — AI calls cost tokens.
     * Config errors (unknown protocol, missing SDK) are reported immediately.
     *
     * @param {function} fn - `fn(err, conn)` where `conn` is the internal connection object.
     */
    this.onReady = function(fn) {
        if (_err) return fn(_err, null);
        fn(null, _conn);
    };

    init(conf);
}

AIConnector = inherits(AIConnector, EventEmitter);
module.exports = AIConnector;
