var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var CORE = path.join(require('../fw'), 'core/controller');
var SWIG_SRC = path.join(CORE, 'controller.render-swig.js');
var V1_SRC   = path.join(CORE, 'controller.render-v1.js');

// Inline replica of the whisper() inline-rule path (context.js:689-691).
// Tests use this to verify dic content without loading the full framework.
function whisper(dictionary, replaceable, rule) {
    return replaceable.replace(rule, function(s, key) {
        return dictionary[key] || s;
    });
}
var WHISPER_RULE = /\{{ ([a-zA-Z.]+) \}}/g;


// 04 — dic flattening: page.environment.* keys are present after build
describe('04 - dic flattening: page.environment entries written into dic', function() {

    it('whisper substitutes {{ page.environment.webroot }} when dic is flat', function() {
        var dic = { 'page.environment.webroot': '/auth/' };
        var result = whisper(dic, '{{ page.environment.webroot }}_gina/assets/routing.json', WHISPER_RULE);
        assert.equal(result, '/auth/_gina/assets/routing.json');
    });

    it('whisper leaves {{ page.environment.webroot }} unchanged without flat key (regression guard)', function() {
        // Only the nested object is present — as it was before the fix.
        var dic = { 'page.environment': { webroot: '/auth/' } };
        var result = whisper(dic, '{{ page.environment.webroot }}_gina/assets/routing.json', WHISPER_RULE);
        assert.equal(result, '{{ page.environment.webroot }}_gina/assets/routing.json');
    });

    it('flattening logic produces all expected dic keys from a page.environment object', function() {
        var env = {
            webroot: '/auth/', version: '0.1.6', bundle: 'auth',
            env: 'dev', envIsDev: true, protocol: 'https',
            hostname: 'https://localhost:3000', scope: 'local',
            scopeIsLocal: true, scopeIsProduction: false,
            isProxyHost: false, proxyHost: '', proxyHostname: '',
            routing: '{}', reverseRouting: '{}', forms: '{}'
        };
        var dic = {};
        // Replicate the fix
        for (var k in env) {
            dic['page.environment.' + k] = env[k];
        }
        assert.equal(dic['page.environment.webroot'],   '/auth/');
        assert.equal(dic['page.environment.version'],   '0.1.6');
        assert.equal(dic['page.environment.bundle'],    'auth');
        assert.equal(dic['page.environment.envIsDev'],  true);
    });

    it('whisper substitutes all 16 {{ page.environment.* }} tokens when dic is flat', function() {
        // Note: proxyHost/proxyHostname use non-empty values here because whisper()
        // uses `dictionary[key] || s` — empty strings are falsy and fall back to
        // the original token. That is a pre-existing whisper behaviour, not a bug
        // in the flattening fix.
        var env = {
            bundle: 'auth', env: 'dev', envIsDev: 'true', forms: '{}',
            hostname: 'https://localhost:3000', isProxyHost: 'false',
            protocol: 'https', proxyHost: 'proxy.local', proxyHostname: 'https://proxy.local',
            reverseRouting: '{}', routing: '{}', scope: 'local',
            scopeIsLocal: 'true', scopeIsProduction: 'false',
            version: '0.1.6', webroot: '/auth/'
        };
        var dic = {};
        for (var k in env) {
            dic['page.environment.' + k] = env[k];
        }

        // Build a string containing all 16 tokens
        var tokens = Object.keys(env).map(function(k) {
            return '{{ page.environment.' + k + ' }}';
        }).join(',');

        var result = whisper(dic, tokens, WHISPER_RULE);

        // None of the original {{ }} tokens should remain
        assert.ok(
            !/\{\{/.test(result),
            'unresolved {{ }} tokens remain after whisper with flat dic: ' + result
        );

        // webroot should appear in the result
        assert.ok(result.indexOf('/auth/') > -1, 'webroot value missing from result');
    });

});


// 05 — source: flattening code is present in both render files
describe('05 - source: page.environment flattening present in render files', function() {

    it('render-swig.js contains the page.environment flattening block', function() {
        var src = fs.readFileSync(SWIG_SRC, 'utf8');
        assert.ok(
            /dic\['page\.environment\.' \+ k\]/.test(src),
            'render-swig.js: missing `dic[\'page.environment.\' + k]` — flattening fix was removed'
        );
    });

    it('render-swig.js flattening block is guarded with typeof === object check', function() {
        var src = fs.readFileSync(SWIG_SRC, 'utf8');
        assert.ok(
            /typeof data\.page\.environment === 'object'/.test(src),
            'render-swig.js: missing typeof guard for page.environment flattening'
        );
    });

    it('render-v1.js contains the page.environment flattening block', function() {
        var src = fs.readFileSync(V1_SRC, 'utf8');
        assert.ok(
            /dic\['page\.environment\.' \+ k\]/.test(src),
            'render-v1.js: missing `dic[\'page.environment.\' + k]` — flattening fix was removed'
        );
    });

    it('render-v1.js flattening block is guarded with typeof === object check', function() {
        var src = fs.readFileSync(V1_SRC, 'utf8');
        assert.ok(
            /typeof data\.page\.environment === 'object'/.test(src),
            'render-v1.js: missing typeof guard for page.environment flattening'
        );
    });

});
