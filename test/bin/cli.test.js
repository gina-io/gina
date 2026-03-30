var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var CLI_SOURCE = path.resolve(__dirname, '../../bin/cli');


// ---------------------------------------------------------------------------
// 01 — Source: def_framework sync block is present in bin/cli
// ---------------------------------------------------------------------------
describe('01 - bin/cli: def_framework sync block', function() {

    it('def_framework sync block is present in source', function() {
        var src = fs.readFileSync(CLI_SOURCE, 'utf8');
        assert.ok(
            /def_framework/.test(src),
            'expected def_framework sync block in bin/cli'
        );
    });

    it('sync is gated on bundle|project start|restart commands', function() {
        var src = fs.readFileSync(CLI_SOURCE, 'utf8');
        assert.ok(
            /\(bundle\|project\):\(start\|restart\)/.test(src),
            'expected sync to be gated on bundle|project start|restart in bin/cli'
        );
    });

    it('compares _mainData.def_framework !== version before updating', function() {
        var src = fs.readFileSync(CLI_SOURCE, 'utf8');
        assert.ok(
            /_mainData\.def_framework\s*!==\s*version/.test(src),
            'expected `_mainData.def_framework !== version` guard in bin/cli'
        );
    });

    it('reads main.json from the gina home directory', function() {
        var src = fs.readFileSync(CLI_SOURCE, 'utf8');
        assert.ok(
            /main\.json/.test(src),
            'expected main.json path in bin/cli def_framework sync'
        );
    });

    it('updates frameworks[shortVersion] array when syncing', function() {
        var src = fs.readFileSync(CLI_SOURCE, 'utf8');
        assert.ok(
            /frameworks\[shortVersion\]/.test(src),
            'expected frameworks[shortVersion] update in bin/cli'
        );
    });

    it('uses lib.generator.createFileFromDataSync to write main.json', function() {
        var src = fs.readFileSync(CLI_SOURCE, 'utf8');
        assert.ok(
            /generator\.createFileFromDataSync\(_mainData/.test(src),
            'expected generator.createFileFromDataSync(_mainData...) in bin/cli — use the canonical write API'
        );
    });

    it('emits a stdout warning on sync error', function() {
        var src = fs.readFileSync(CLI_SOURCE, 'utf8');
        assert.ok(
            /could not sync def_framework/.test(src),
            'expected "could not sync def_framework" warning in bin/cli'
        );
    });

});


// ---------------------------------------------------------------------------
// 02 — bin/cli file exists and has a node shebang
// ---------------------------------------------------------------------------
describe('02 - bin/cli: file exists and is valid', function() {

    it('bin/cli file exists', function() {
        assert.ok(
            fs.existsSync(CLI_SOURCE),
            'expected bin/cli to exist'
        );
    });

    it('bin/cli has a node shebang', function() {
        var src = fs.readFileSync(CLI_SOURCE, 'utf8');
        assert.ok(
            /^#!\/usr\/bin\/env node/.test(src),
            'expected #!/usr/bin/env node shebang on first line'
        );
    });

    it('bin/cli is referenced by bin/gina (the public entry point)', function() {
        var ginaSrc = fs.readFileSync(path.resolve(__dirname, '../../bin/gina'), 'utf8');
        assert.ok(
            /bin\/cli/.test(ginaSrc) || /require.*cli/.test(ginaSrc),
            'expected bin/gina to reference bin/cli'
        );
    });

});
