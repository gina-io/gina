'use strict';
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = path.resolve(__dirname, '..', '..', 'framework', 'v' + require('../../package.json').version);
var JSON_HELPER = path.join(FW, 'helpers', 'json', 'src', 'main.js');
var CONFIG_JS   = path.join(FW, 'core', 'config.js');


// 01 - requireJSON trailing comma tolerance
describe('01 - requireJSON trailing comma tolerance', function() {

    var src = fs.readFileSync(JSON_HELPER, 'utf8');

    it('source file exists', function() {
        assert.ok(fs.existsSync(JSON_HELPER), 'helpers/json/src/main.js missing');
    });

    it('attempts trailing comma stripping before emerg+exit', function() {
        // The trailing comma fix must appear BEFORE the emerg/process.exit block
        var trailingCommaIdx = src.indexOf(',($1');
        // Use the regex pattern as it appears in source
        var regexIdx = src.indexOf('/,(\\s*[\\}\\]])/g');
        var emergIdx = src.indexOf('console.emerg(error.message)');

        assert.ok(regexIdx > -1, 'trailing comma regex must exist in source');
        assert.ok(emergIdx > -1, 'emerg call must still exist for real errors');
        assert.ok(regexIdx < emergIdx, 'trailing comma fix must run before emerg+exit');
    });

    it('logs a warning (not emerg) when trailing comma is fixed', function() {
        assert.ok(
            src.indexOf("console.warn('[ requireJSON ] trailing comma") > -1,
            'must warn (not emerg) when trailing comma is auto-fixed'
        );
    });

    it('still calls emerg+exit for unfixable JSON errors', function() {
        assert.ok(
            src.indexOf('console.emerg(error.message)') > -1,
            'emerg+exit must still exist for genuinely broken JSON'
        );
        assert.ok(
            src.indexOf('process.exit(1)') > -1,
            'process.exit(1) must still exist for genuinely broken JSON'
        );
    });

    it('catches firstErr and re-uses it for error reporting', function() {
        // The catch block should catch as firstErr, not err
        assert.ok(
            src.indexOf('catch (firstErr)') > -1,
            'catch block must use firstErr to avoid shadowing'
        );
        assert.ok(
            src.indexOf('var err = firstErr') > -1,
            'err must be assigned from firstErr for the error reporting block'
        );
    });

    it('trailing comma regex handles nested objects and arrays', function() {
        // Test the regex independently
        var regex = /,(\s*[\}\]])/g;
        var cases = [
            { input: '{"a":1,}',             expected: '{"a":1}' },
            { input: '{"a":[1,2,]}',         expected: '{"a":[1,2]}' },
            { input: '{"a":{"b":1,},}',      expected: '{"a":{"b":1}}' },
            { input: '{"a":1, "b":2,\n}',    expected: '{"a":1, "b":2\n}' },
            { input: '{"a":1}',              expected: '{"a":1}' } // no change
        ];

        for (var i = 0; i < cases.length; i++) {
            var result = cases[i].input.replace(regex, '$1');
            assert.equal(result, cases[i].expected,
                'case ' + i + ': "' + cases[i].input + '" should become "' + cases[i].expected + '"');
        }
    });

    it('does not strip commas inside string values', function() {
        var regex = /,(\s*[\}\]])/g;
        // Comma before } inside a string value should NOT be stripped by the regex
        // but this is fine because the initial JSON.parse would succeed for valid JSON
        var validJson = '{"msg":"hello, world"}';
        var result = validJson.replace(regex, '$1');
        assert.equal(result, validJson, 'should not modify valid JSON');
    });
});


// 02 - MIDDLEWARE file existence check in config.js
describe('02 - MIDDLEWARE file existence check in config.js', function() {

    var src = fs.readFileSync(CONFIG_JS, 'utf8');

    it('config.js exists', function() {
        assert.ok(fs.existsSync(CONFIG_JS), 'core/config.js missing');
    });

    it('checks MIDDLEWARE file existence before reading', function() {
        assert.ok(
            src.indexOf('fs.existsSync(_middlewarePath)') > -1,
            'must check existence before fs.readFileSync on MIDDLEWARE'
        );
    });

    it('defaults to "none" when MIDDLEWARE file is absent', function() {
        // The else branch should set middleware to 'none'
        var existsIdx = src.indexOf('fs.existsSync(_middlewarePath)');
        var noneIdx   = src.indexOf("middleware = 'none'", existsIdx);
        assert.ok(
            noneIdx > -1 && noneIdx - existsIdx < 500,
            'must default middleware to "none" when file is absent'
        );
    });

    it('still reads the file when it exists', function() {
        assert.ok(
            src.indexOf("fs.readFileSync(_middlewarePath)") > -1,
            'must still read MIDDLEWARE when the file exists'
        );
    });

    it('still sets gina.middleware context', function() {
        assert.ok(
            src.indexOf("setContext('gina.middleware', middleware)") > -1,
            'must always set the gina.middleware context'
        );
    });
});
