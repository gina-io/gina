'use strict';
/**
 * AI connector tests
 *
 * Strategy: source inspection + inline logic replicas.
 * No live AI API calls, no framework bootstrap, no project required.
 * Mock SDK clients stand in for @anthropic-ai/sdk and openai.
 */
var { describe, it, before } = require('node:test');
var assert  = require('node:assert/strict');
var path    = require('path');
var fs      = require('fs');

var FW = require('../fw');
var CONNECTOR_INDEX = path.join(FW, 'core/connectors/ai/index.js');
var CONNECTOR_LIB   = path.join(FW, 'core/connectors/ai/lib/connector.js');


// ─── 01 — source: lib/connector.js ───────────────────────────────────────────

describe('01 - AI connector: lib/connector.js source', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR_LIB, 'utf8'); });

    it('exports an AIConnector constructor', function() {
        assert.ok(/function AIConnector/.test(src));
        assert.ok(/module\.exports\s*=\s*AIConnector/.test(src));
    });

    it('defines PROVIDERS map with all expected protocols', function() {
        var protocols = [
            'anthropic', 'openai', 'deepseek', 'qwen', 'groq',
            'mistral', 'together', 'ollama', 'gemini', 'xai', 'perplexity'
        ];
        protocols.forEach(function(p) {
            assert.ok(src.indexOf("'" + p + "'") !== -1, 'missing protocol: ' + p);
        });
    });

    it('loads @anthropic-ai/sdk from project node_modules for anthropic://', function() {
        assert.ok(/getPath\('project'\)/.test(src));
        assert.ok(/@anthropic-ai\/sdk/.test(src));
    });

    it('loads openai from project node_modules for OpenAI-compatible protocols', function() {
        assert.ok(/node_modules\/openai/.test(src));
    });

    it('handles Mod.Anthropic || Mod.default || Mod for CJS/ESM compat', function() {
        assert.ok(/Mod\.Anthropic\s*\|\|\s*Mod\.default\s*\|\|\s*Mod/.test(src));
    });

    it('handles Mod.OpenAI || Mod.default || Mod for CJS/ESM compat', function() {
        assert.ok(/Mod\.OpenAI\s*\|\|\s*Mod\.default\s*\|\|\s*Mod/.test(src));
    });

    it('extracts scheme from protocol string via split(:)[0]', function() {
        assert.ok(/protocol\.split\(':'\)\[0\]/.test(src));
    });

    it('conf.baseURL overrides the provider default', function() {
        assert.ok(/conf\.baseURL\s*\|\|\s*provider\.baseURL/.test(src));
    });

    it('onReady() calls fn(null, _conn) on success', function() {
        assert.ok(/fn\(null,\s*_conn\)/.test(src));
    });

    it('onReady() calls fn(_err, null) when init failed', function() {
        assert.ok(/fn\(_err,\s*null\)/.test(src));
    });

    it('does NOT ping the AI API (no live call in onReady)', function() {
        // onReady must not call client.messages.create or chat.completions
        var onReadySection = src.substring(src.indexOf('this.onReady'));
        assert.ok(!/messages\.create/.test(onReadySection.substring(0, 200)));
        assert.ok(!/completions\.create/.test(onReadySection.substring(0, 200)));
    });

    it('stores modelName (not model) in _conn to avoid naming collision with infos.model', function() {
        assert.ok(/modelName\s*:\s*conf\.model/.test(src));
    });

    it('inherits from EventEmitter', function() {
        assert.ok(/EventEmitter/.test(src));
        assert.ok(/inherits\(AIConnector,\s*EventEmitter\)/.test(src));
    });

    it('errors on unknown protocol with informative message', function() {
        assert.ok(/Unknown protocol/.test(src));
        assert.ok(/Supported protocols/.test(src));
    });

    it('defaults apiKey to "no-key" for providers that do not require one (Ollama)', function() {
        assert.ok(/apiKey\s*:\s*conf\.apiKey\s*\|\|\s*'no-key'/.test(src));
    });

});


// ─── 02 — source: index.js ───────────────────────────────────────────────────

describe('02 - AI connector: index.js source', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR_INDEX, 'utf8'); });

    it('exports an AI constructor function', function() {
        assert.ok(/function AI\(/.test(src));
        assert.ok(/module\.exports\s*=\s*AI/.test(src));
    });

    it('returns { client, provider, model, infer }', function() {
        assert.ok(/client\s*:\s*conn\.client/.test(src));
        assert.ok(/provider\s*:\s*conn\.provider/.test(src));
        assert.ok(/model\s*:\s*conn\.modelName/.test(src));
        assert.ok(/infer\s*:\s*infer/.test(src));
    });

    it('returns a native Promise with .onComplete() shim', function() {
        assert.ok(/new Promise/.test(src));
        assert.ok(/\.onComplete\s*=\s*function/.test(src));
    });

    it('does NOT use setTimeout(0) — SDK calls are natively async', function() {
        assert.ok(!/setTimeout\(function\(\)\s*\{/.test(src));
    });

    it('uses conn.client.messages.create() for Anthropic', function() {
        assert.ok(/conn\.client\.messages\.create/.test(src));
    });

    it('uses conn.client.chat.completions.create() for OpenAI-compat', function() {
        assert.ok(/conn\.client\.chat\.completions\.create/.test(src));
    });

    it('normalises response to { content, model, usage, raw }', function() {
        assert.ok(/content\s*:/.test(src));
        assert.ok(/usage\s*:/.test(src));
        assert.ok(/inputTokens/.test(src));
        assert.ok(/outputTokens/.test(src));
        assert.ok(/raw\s*:/.test(src));
    });

    it('maps Anthropic usage.input_tokens → inputTokens', function() {
        assert.ok(/response\.usage\.input_tokens/.test(src));
    });

    it('maps OpenAI usage.prompt_tokens → inputTokens', function() {
        assert.ok(/response\.usage\.prompt_tokens/.test(src));
    });

    it('maps Anthropic usage.output_tokens → outputTokens', function() {
        assert.ok(/response\.usage\.output_tokens/.test(src));
    });

    it('maps OpenAI usage.completion_tokens → outputTokens', function() {
        assert.ok(/response\.usage\.completion_tokens/.test(src));
    });

    it('extracts system message from messages array for Anthropic', function() {
        assert.ok(/role.*system/.test(src));
        assert.ok(/params\.system\s*=\s*systemMsg/.test(src));
    });

    it('rejects immediately when no model is specified', function() {
        assert.ok(/No model specified/.test(src));
        assert.ok(/_reject/.test(src));
    });

    it('options.system prepends a system message for OpenAI-compat', function() {
        assert.ok(/options\.system/.test(src));
        assert.ok(/role.*system.*content.*options\.system/.test(src));
    });

    it('options.model overrides the connector default', function() {
        assert.ok(/options\.model\s*\|\|\s*conn\.modelName/.test(src));
    });

    it('options.maxTokens overrides the default of 1024', function() {
        assert.ok(/options\.maxTokens\s*\|\|\s*1024/.test(src));
    });

});


// ─── 03 — AIConnector protocol resolution ────────────────────────────────────

describe('03 - AIConnector protocol resolution logic', function() {

    // Replicate the PROVIDERS map and scheme extraction from connector.js.
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

    var resolve = function(conf) {
        var protocol = conf.protocol || 'openai://';
        var scheme   = protocol.split(':')[0].toLowerCase();
        var provider = PROVIDERS[scheme];
        if (!provider) return null;
        return {
            scheme  : scheme,
            type    : provider.type,
            baseURL : conf.baseURL || provider.baseURL
        };
    };

    it('anthropic:// → type anthropic', function() {
        assert.equal(resolve({ protocol: 'anthropic://' }).type, 'anthropic');
    });

    it('openai:// → type openai, no baseURL', function() {
        var r = resolve({ protocol: 'openai://' });
        assert.equal(r.type, 'openai');
        assert.equal(r.baseURL, null);
    });

    it('deepseek:// → type openai, DeepSeek base URL', function() {
        var r = resolve({ protocol: 'deepseek://' });
        assert.equal(r.type, 'openai');
        assert.equal(r.baseURL, 'https://api.deepseek.com/v1');
    });

    it('qwen:// → type openai, DashScope base URL', function() {
        var r = resolve({ protocol: 'qwen://' });
        assert.ok(/dashscope/.test(r.baseURL));
    });

    it('groq:// → type openai, Groq base URL', function() {
        var r = resolve({ protocol: 'groq://' });
        assert.ok(/groq\.com/.test(r.baseURL));
    });

    it('mistral:// → type openai, Mistral base URL', function() {
        var r = resolve({ protocol: 'mistral://' });
        assert.ok(/mistral\.ai/.test(r.baseURL));
    });

    it('gemini:// → type openai, Google base URL', function() {
        var r = resolve({ protocol: 'gemini://' });
        assert.ok(/googleapis\.com/.test(r.baseURL));
    });

    it('xai:// → type openai, xAI base URL', function() {
        var r = resolve({ protocol: 'xai://' });
        assert.ok(/x\.ai/.test(r.baseURL));
    });

    it('perplexity:// → type openai, Perplexity base URL', function() {
        var r = resolve({ protocol: 'perplexity://' });
        assert.ok(/perplexity\.ai/.test(r.baseURL));
    });

    it('ollama:// → type openai, localhost:11434 base URL', function() {
        var r = resolve({ protocol: 'ollama://' });
        assert.ok(/localhost:11434/.test(r.baseURL));
    });

    it('ollama:// + baseURL override → uses custom baseURL', function() {
        var r = resolve({ protocol: 'ollama://', baseURL: 'http://gpu-server.local:11434/v1' });
        assert.ok(/gpu-server\.local/.test(r.baseURL));
    });

    it('openai:// + baseURL override → uses custom URL', function() {
        var r = resolve({ protocol: 'openai://', baseURL: 'http://localhost:8080/v1' });
        assert.equal(r.baseURL, 'http://localhost:8080/v1');
    });

    it('unknown protocol → returns null', function() {
        assert.equal(resolve({ protocol: 'mysql://' }), null);
    });

    it('scheme extraction is case-insensitive', function() {
        assert.ok(resolve({ protocol: 'DEEPSEEK://' }));
        assert.ok(resolve({ protocol: 'Ollama://' }));
    });

});


// ─── 04 — AIConnector onReady logic ──────────────────────────────────────────

describe('04 - AIConnector onReady logic', function() {

    var makeOnReady = function(conn, err) {
        return function(fn) {
            if (err) return fn(err, null);
            fn(null, conn);
        };
    };

    it('calls fn(null, conn) immediately when init succeeded', function(_, done) {
        var mockConn = { client: {}, provider: 'deepseek', type: 'openai', modelName: 'deepseek-chat' };
        var onReady = makeOnReady(mockConn, null);
        onReady(function(err, conn) {
            assert.equal(err, null);
            assert.strictEqual(conn, mockConn);
            done();
        });
    });

    it('calls fn(err, null) when init failed (SDK missing)', function(_, done) {
        var initErr = new Error('[AIConnector] openai is not installed');
        var onReady = makeOnReady(null, initErr);
        onReady(function(err, conn) {
            assert.strictEqual(err, initErr);
            assert.equal(conn, null);
            done();
        });
    });

    it('does not make any API call (no tokens spent at startup)', function(_, done) {
        var called = false;
        var mockConn = {
            client: {
                chat: { completions: { create: function() { called = true; } } },
                messages: { create: function() { called = true; } }
            },
            provider: 'openai', type: 'openai', modelName: 'gpt-4o'
        };
        var onReady = makeOnReady(mockConn, null);
        onReady(function() {
            assert.equal(called, false, 'no API call should be made during onReady');
            done();
        });
    });

});


// ─── 05 — infer() with mock Anthropic client ─────────────────────────────────

describe('05 - infer() — Anthropic provider', function() {

    // Replicate the infer() function from index.js for Anthropic.
    var makeInfer = function(mockClient) {
        var conn = { client: mockClient, provider: 'anthropic', type: 'anthropic', modelName: 'claude-opus-4-6' };

        return function infer(messages, options) {
            options = options || {};
            var modelName = options.model || conn.modelName || '';
            var maxTokens = options.maxTokens || 1024;
            var temperature = (options.temperature !== undefined) ? options.temperature : undefined;

            var _resolve, _reject, _internalData;
            var _promise = new Promise(function(resolve, reject) {
                _resolve = resolve; _reject = reject;
            });
            _promise.onComplete = function(cb) {
                _promise.then(function() { cb(null, _internalData); }, function(e) { cb(e); });
                return _promise;
            };

            if (!modelName) { _reject(new Error('[AI] No model specified.')); return _promise; }

            var systemMsg = options.system || null;
            var filteredMessages = messages.filter(function(m) {
                if (m.role === 'system') { if (!systemMsg) systemMsg = m.content; return false; }
                return true;
            });
            var params = { model: modelName, max_tokens: maxTokens, messages: filteredMessages };
            if (systemMsg) params.system = systemMsg;
            if (temperature !== undefined) params.temperature = temperature;

            conn.client.messages.create(params)
                .then(function(r) {
                    var result = {
                        content: r.content[0].text,
                        model: r.model,
                        usage: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens },
                        raw: r
                    };
                    _internalData = result; _resolve(result);
                })
                .catch(function(e) { _reject(e); });

            return _promise;
        };
    };

    var mockAnthropicClient = function(response, err) {
        return {
            messages: {
                create: function() {
                    return err ? Promise.reject(err) : Promise.resolve(response);
                }
            }
        };
    };

    var anthropicResponse = function(text) {
        return {
            content: [{ text: text }],
            model: 'claude-opus-4-6',
            usage: { input_tokens: 10, output_tokens: 5 }
        };
    };

    it('resolves with normalised { content, model, usage, raw }', function(_, done) {
        var client = mockAnthropicClient(anthropicResponse('Paris.'));
        var infer  = makeInfer(client);
        infer([{ role: 'user', content: 'Capital of France?' }]).then(function(r) {
            assert.equal(r.content, 'Paris.');
            assert.equal(r.model, 'claude-opus-4-6');
            assert.equal(r.usage.inputTokens, 10);
            assert.equal(r.usage.outputTokens, 5);
            assert.ok(r.raw);
            done();
        });
    });

    it('extracts system role from messages array', function(_, done) {
        var capturedParams;
        var client = {
            messages: {
                create: function(p) { capturedParams = p; return Promise.resolve(anthropicResponse('ok')); }
            }
        };
        var infer = makeInfer(client);
        infer([
            { role: 'system', content: 'Be brief.' },
            { role: 'user',   content: 'Hi' }
        ]).then(function() {
            assert.equal(capturedParams.system, 'Be brief.');
            assert.equal(capturedParams.messages.length, 1);
            assert.equal(capturedParams.messages[0].role, 'user');
            done();
        });
    });

    it('options.system sets system parameter', function(_, done) {
        var capturedParams;
        var client = {
            messages: {
                create: function(p) { capturedParams = p; return Promise.resolve(anthropicResponse('ok')); }
            }
        };
        var infer = makeInfer(client);
        infer([{ role: 'user', content: 'Hi' }], { system: 'You are a bot.' }).then(function() {
            assert.equal(capturedParams.system, 'You are a bot.');
            done();
        });
    });

    it('.onComplete(cb) receives (null, result) on success', function(_, done) {
        var client = mockAnthropicClient(anthropicResponse('Hello!'));
        var infer  = makeInfer(client);
        infer([{ role: 'user', content: 'Hi' }]).onComplete(function(err, r) {
            assert.equal(err, null);
            assert.equal(r.content, 'Hello!');
            done();
        });
    });

    it('.onComplete(cb) receives (err) on API failure', function(_, done) {
        var client = mockAnthropicClient(null, new Error('rate_limit_error'));
        var infer  = makeInfer(client);
        infer([{ role: 'user', content: 'Hi' }]).onComplete(function(err) {
            assert.ok(err instanceof Error);
            assert.ok(/rate_limit_error/.test(err.message));
            done();
        });
    });

    it('rejects when no model is configured', function(_, done) {
        var client = { messages: { create: function() { return Promise.resolve({}); } } };
        var conn   = { client: client, provider: 'anthropic', type: 'anthropic', modelName: null };
        var infer = function(messages, options) {
            options = options || {};
            var modelName = options.model || conn.modelName || '';
            var _resolve, _reject, _internalData;
            var _promise = new Promise(function(r, j) { _resolve = r; _reject = j; });
            _promise.onComplete = function(cb) {
                _promise.then(function() { cb(null, _internalData); }, function(e) { cb(e); });
                return _promise;
            };
            if (!modelName) { _reject(new Error('[AI] No model specified.')); return _promise; }
            return _promise;
        };
        infer([{ role: 'user', content: 'Hi' }]).onComplete(function(err) {
            assert.ok(err instanceof Error);
            assert.ok(/No model/.test(err.message));
            done();
        });
    });

});


// ─── 06 — infer() with mock OpenAI-compatible client ─────────────────────────

describe('06 - infer() — OpenAI-compatible providers (DeepSeek, Qwen, Groq, Ollama…)', function() {

    var makeInfer = function(mockClient, providerName, modelName) {
        var conn = {
            client: mockClient,
            provider: providerName || 'deepseek',
            type: 'openai',
            modelName: modelName || 'deepseek-chat'
        };

        return function infer(messages, options) {
            options = options || {};
            var model     = options.model || conn.modelName || '';
            var maxTokens = options.maxTokens || 1024;
            var temperature = (options.temperature !== undefined) ? options.temperature : undefined;

            var _resolve, _reject, _internalData;
            var _promise = new Promise(function(r, j) { _resolve = r; _reject = j; });
            _promise.onComplete = function(cb) {
                _promise.then(function() { cb(null, _internalData); }, function(e) { cb(e); });
                return _promise;
            };

            if (!model) { _reject(new Error('[AI] No model specified.')); return _promise; }

            var msgs = messages.slice();
            if (options.system) msgs = [{ role: 'system', content: options.system }].concat(msgs);

            var params = { model: model, messages: msgs, max_tokens: maxTokens };
            if (temperature !== undefined) params.temperature = temperature;

            conn.client.chat.completions.create(params)
                .then(function(r) {
                    var result = {
                        content: r.choices[0].message.content,
                        model: r.model,
                        usage: { inputTokens: r.usage.prompt_tokens, outputTokens: r.usage.completion_tokens },
                        raw: r
                    };
                    _internalData = result; _resolve(result);
                })
                .catch(function(e) { _reject(e); });

            return _promise;
        };
    };

    var openaiResponse = function(text, model) {
        return {
            choices: [{ message: { content: text } }],
            model: model || 'deepseek-chat',
            usage: { prompt_tokens: 8, completion_tokens: 3 }
        };
    };

    var mockClient = function(response, err) {
        return {
            chat: {
                completions: {
                    create: function() {
                        return err ? Promise.reject(err) : Promise.resolve(response);
                    }
                }
            }
        };
    };

    it('DeepSeek — resolves with normalised response', function(_, done) {
        var client = mockClient(openaiResponse('Bonjour!', 'deepseek-chat'));
        var infer  = makeInfer(client, 'deepseek', 'deepseek-chat');
        infer([{ role: 'user', content: 'Say hello in French' }]).then(function(r) {
            assert.equal(r.content, 'Bonjour!');
            assert.equal(r.model, 'deepseek-chat');
            assert.equal(r.usage.inputTokens, 8);
            assert.equal(r.usage.outputTokens, 3);
            done();
        });
    });

    it('Ollama / MiMo — resolves with normalised response', function(_, done) {
        var client = mockClient(openaiResponse('I am MiMo.', 'mimo'));
        var infer  = makeInfer(client, 'ollama', 'mimo');
        infer([{ role: 'user', content: 'Who are you?' }]).then(function(r) {
            assert.equal(r.content, 'I am MiMo.');
            assert.equal(r.model, 'mimo');
            done();
        });
    });

    it('options.system prepends system message to messages array', function(_, done) {
        var capturedParams;
        var client = {
            chat: {
                completions: {
                    create: function(p) {
                        capturedParams = p;
                        return Promise.resolve(openaiResponse('ok'));
                    }
                }
            }
        };
        var infer = makeInfer(client, 'groq', 'llama-3.3-70b-versatile');
        infer([{ role: 'user', content: 'Hi' }], { system: 'You are concise.' }).then(function() {
            assert.equal(capturedParams.messages[0].role, 'system');
            assert.equal(capturedParams.messages[0].content, 'You are concise.');
            assert.equal(capturedParams.messages[1].role, 'user');
            done();
        });
    });

    it('options.model overrides connector default model', function(_, done) {
        var capturedParams;
        var client = {
            chat: {
                completions: {
                    create: function(p) {
                        capturedParams = p;
                        return Promise.resolve(openaiResponse('ok', 'deepseek-reasoner'));
                    }
                }
            }
        };
        var infer = makeInfer(client, 'deepseek', 'deepseek-chat');
        infer([{ role: 'user', content: 'Reason about this.' }], { model: 'deepseek-reasoner' }).then(function() {
            assert.equal(capturedParams.model, 'deepseek-reasoner');
            done();
        });
    });

    it('options.maxTokens is passed to the API', function(_, done) {
        var capturedParams;
        var client = {
            chat: {
                completions: {
                    create: function(p) {
                        capturedParams = p;
                        return Promise.resolve(openaiResponse('ok'));
                    }
                }
            }
        };
        var infer = makeInfer(client, 'qwen', 'qwen-plus');
        infer([{ role: 'user', content: 'hi' }], { maxTokens: 256 }).then(function() {
            assert.equal(capturedParams.max_tokens, 256);
            done();
        });
    });

    it('.onComplete(cb) callback works for OpenAI-compat', function(_, done) {
        var client = mockClient(openaiResponse('42', 'mistral-large-latest'));
        var infer  = makeInfer(client, 'mistral', 'mistral-large-latest');
        infer([{ role: 'user', content: 'What is 6x7?' }]).onComplete(function(err, r) {
            assert.equal(err, null);
            assert.equal(r.content, '42');
            done();
        });
    });

    it('rejects on API error', function(_, done) {
        var client = mockClient(null, new Error('invalid_api_key'));
        var infer  = makeInfer(client, 'xai', 'grok-3');
        infer([{ role: 'user', content: 'Hi' }]).onComplete(function(err) {
            assert.ok(err instanceof Error);
            assert.ok(/invalid_api_key/.test(err.message));
            done();
        });
    });

    it('multi-turn conversation is passed intact', function(_, done) {
        var capturedParams;
        var client = {
            chat: {
                completions: {
                    create: function(p) {
                        capturedParams = p;
                        return Promise.resolve(openaiResponse('Germany.'));
                    }
                }
            }
        };
        var infer = makeInfer(client, 'gemini', 'gemini-2.0-flash');
        var messages = [
            { role: 'user',      content: 'Capital of France?' },
            { role: 'assistant', content: 'Paris.' },
            { role: 'user',      content: 'And Germany?' }
        ];
        infer(messages).then(function() {
            assert.equal(capturedParams.messages.length, 3);
            assert.equal(capturedParams.messages[2].content, 'And Germany?');
            done();
        });
    });

});


// ─── 07 — AI() constructor via actual export ──────────────────────────────────
//
// Suites 05–06 replicate infer() inline. This suite requires the real exported
// AI() constructor and calls .infer() through it to catch any wiring bugs
// introduced by future refactors.

describe('07 - AI() constructor: exported interface', function() {

    var AI = require(CONNECTOR_INDEX);

    var makeConn = function(type, mockClient) {
        return {
            client    : mockClient,
            provider  : type === 'anthropic' ? 'anthropic' : 'deepseek',
            type      : type,
            modelName : type === 'anthropic' ? 'claude-opus-4-6' : 'deepseek-chat'
        };
    };

    var anthropicClient = function(text) {
        return {
            messages: {
                create: function() {
                    return Promise.resolve({
                        content : [{ text: text }],
                        model   : 'claude-opus-4-6',
                        usage   : { input_tokens: 5, output_tokens: 3 }
                    });
                }
            }
        };
    };

    var openaiClient = function(text) {
        return {
            chat: {
                completions: {
                    create: function() {
                        return Promise.resolve({
                            choices : [{ message: { content: text } }],
                            model   : 'deepseek-chat',
                            usage   : { prompt_tokens: 5, completion_tokens: 3 }
                        });
                    }
                }
            }
        };
    };

    it('returned object exposes { client, provider, model, infer }', function() {
        var conn = makeConn('openai', openaiClient('hi'));
        var ai   = AI(conn, {});
        assert.ok(typeof ai.infer    === 'function', 'infer should be a function');
        assert.ok(typeof ai.client   === 'object',   'client should be exposed');
        assert.equal(ai.provider, 'deepseek');
        assert.equal(ai.model,    'deepseek-chat');
    });

    it('returned object does NOT expose a "complete" key', function() {
        var conn = makeConn('openai', openaiClient('hi'));
        var ai   = AI(conn, {});
        assert.ok(!('complete' in ai), '"complete" must not appear on the public interface');
    });

    it('infer() returns a native Promise', function() {
        var conn = makeConn('openai', openaiClient('hi'));
        var ai   = AI(conn, {});
        var p = ai.infer([{ role: 'user', content: 'hi' }]);
        assert.ok(p instanceof Promise);
    });

    it('infer() promise has .onComplete() shim', function() {
        var conn = makeConn('openai', openaiClient('hi'));
        var ai   = AI(conn, {});
        var p = ai.infer([{ role: 'user', content: 'hi' }]);
        assert.ok(typeof p.onComplete === 'function');
    });

    it('infer() resolves — Anthropic path', function(_, done) {
        var conn = makeConn('anthropic', anthropicClient('Bonjour'));
        var ai   = AI(conn, {});
        ai.infer([{ role: 'user', content: 'Say hi in French' }]).then(function(r) {
            assert.equal(r.content, 'Bonjour');
            assert.equal(r.model,   'claude-opus-4-6');
            assert.equal(r.usage.inputTokens,  5);
            assert.equal(r.usage.outputTokens, 3);
            assert.ok(r.raw);
            done();
        });
    });

    it('infer() resolves — OpenAI-compat path', function(_, done) {
        var conn = makeConn('openai', openaiClient('Hello'));
        var ai   = AI(conn, {});
        ai.infer([{ role: 'user', content: 'Say hi' }]).then(function(r) {
            assert.equal(r.content, 'Hello');
            assert.equal(r.model,   'deepseek-chat');
            assert.equal(r.usage.inputTokens,  5);
            assert.equal(r.usage.outputTokens, 3);
            assert.ok(r.raw);
            done();
        });
    });

    it('infer() .onComplete() receives (null, result)', function(_, done) {
        var conn = makeConn('openai', openaiClient('42'));
        var ai   = AI(conn, {});
        ai.infer([{ role: 'user', content: 'What is 6×7?' }]).onComplete(function(err, r) {
            assert.equal(err, null);
            assert.equal(r.content, '42');
            done();
        });
    });

    it('infer() rejects when modelName is absent', function(_, done) {
        var conn = { client: openaiClient('x'), provider: 'openai', type: 'openai', modelName: null };
        var ai   = AI(conn, {});
        ai.infer([{ role: 'user', content: 'hi' }]).onComplete(function(err) {
            assert.ok(err instanceof Error);
            assert.ok(/No model/.test(err.message));
            done();
        });
    });

});
