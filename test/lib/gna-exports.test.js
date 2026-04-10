'use strict';
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var ROOT   = path.resolve(__dirname, '../..');
var GNA_JS = path.join(ROOT, 'gna.js');
var PKG    = require(path.join(ROOT, 'package.json'));


// 01 — gna.js explicit exports: module structure and lazy getters
describe('01 - gna.js explicit exports: module structure', function() {

    var src = fs.readFileSync(GNA_JS, 'utf8');

    it('gna.js exists at package root', function() {
        assert.ok(fs.existsSync(GNA_JS), 'gna.js missing from package root');
    });

    it('requires the current framework version directory', function() {
        var expected = './framework/v' + PKG.version + '/core/gna';
        assert.ok(
            src.indexOf(expected) > -1,
            'gna.js must require ' + expected + ' — framework path is stale'
        );
    });

    it('requires controller from the current framework version', function() {
        var expected = './framework/v' + PKG.version + '/core/controller';
        assert.ok(
            src.indexOf(expected) > -1,
            'gna.js must require ' + expected + ' for SuperController'
        );
    });

    it('requires entity from the current framework version', function() {
        var expected = './framework/v' + PKG.version + '/core/model/entity';
        assert.ok(
            src.indexOf(expected) > -1,
            'gna.js must require ' + expected + ' for EntitySuper'
        );
    });

    it('requires uuid from the current framework version', function() {
        var expected = './framework/v' + PKG.version + '/lib/uuid';
        assert.ok(
            src.indexOf(expected) > -1,
            'gna.js must require ' + expected + ' for uuid'
        );
    });

    // Context helpers — lazy getters
    var contextHelpers = [
        'setContext', 'getContext', 'resetContext', 'getConfig',
        'getLib', 'whisper', 'define', 'getDefined'
    ];
    contextHelpers.forEach(function(name) {
        it('exports lazy getter for ' + name, function() {
            var pattern = new RegExp('get\\s+' + name + '\\s*\\(\\)\\s*\\{\\s*return\\s+global\\.' + name);
            assert.ok(pattern.test(src), 'missing lazy getter for ' + name);
        });
    });

    // Path helpers — lazy getters
    var pathHelpers = ['setPath', 'getPath', 'setPaths', 'getPaths', 'onCompleteCall'];
    pathHelpers.forEach(function(name) {
        it('exports lazy getter for ' + name, function() {
            var pattern = new RegExp('get\\s+' + name + '\\s*\\(\\)\\s*\\{\\s*return\\s+global\\.' + name);
            assert.ok(pattern.test(src), 'missing lazy getter for ' + name);
        });
    });

    // _ is special (single character)
    it('exports lazy getter for _ (PathObject constructor)', function() {
        assert.ok(
            /get\s+_\s*\(\)\s*\{\s*return\s+global\._/.test(src),
            'missing lazy getter for _'
        );
    });

    // Model helpers
    var modelHelpers = ['getModel', 'getModelEntity'];
    modelHelpers.forEach(function(name) {
        it('exports lazy getter for ' + name, function() {
            var pattern = new RegExp('get\\s+' + name + '\\s*\\(\\)\\s*\\{\\s*return\\s+global\\.' + name);
            assert.ok(pattern.test(src), 'missing lazy getter for ' + name);
        });
    });

    // Env helpers
    var envHelpers = [
        'getUserHome', 'getEnvVar', 'getEnvVars', 'setEnvVar',
        'getLogDir', 'getRunDir', 'getTmpDir', 'parseTimeout', 'isWin32'
    ];
    envHelpers.forEach(function(name) {
        it('exports lazy getter for ' + name, function() {
            var pattern = new RegExp('get\\s+' + name + '\\s*\\(\\)\\s*\\{\\s*return\\s+global\\.' + name);
            assert.ok(pattern.test(src), 'missing lazy getter for ' + name);
        });
    });

    // Other lazy getters
    it('exports lazy getter for requireJSON', function() {
        assert.ok(
            /get\s+requireJSON\s*\(\)\s*\{\s*return\s+global\.requireJSON/.test(src),
            'missing lazy getter for requireJSON'
        );
    });

    it('exports lazy getter for run', function() {
        assert.ok(
            /get\s+run\s*\(\)\s*\{\s*return\s+global\.run/.test(src),
            'missing lazy getter for run'
        );
    });

    it('exports lazy getter for ApiError', function() {
        assert.ok(
            /get\s+ApiError\s*\(\)\s*\{\s*return\s+global\.ApiError/.test(src),
            'missing lazy getter for ApiError'
        );
    });

    // Direct property exports (not lazy getters)
    it('exports SuperController as a direct property', function() {
        assert.ok(
            /SuperController\s*:\s*SuperController/.test(src),
            'SuperController must be a direct property (not a getter)'
        );
    });

    it('exports EntitySuper as a direct property', function() {
        assert.ok(
            /EntitySuper\s*:\s*EntitySuper/.test(src),
            'EntitySuper must be a direct property (not a getter)'
        );
    });

    it('exports uuid as a direct property', function() {
        assert.ok(
            /uuid\s*:\s*uuid/.test(src),
            'uuid must be a direct property (not a getter)'
        );
    });
});


// 02 — package.json wiring for types and gna subpath
describe('02 - package.json: types and typesVersions wiring', function() {

    it('package.json has "types" pointing to types/index.d.ts', function() {
        assert.equal(PKG.types, './types/index.d.ts');
    });

    it('package.json has typesVersions mapping gna to types/gna.d.ts', function() {
        assert.ok(PKG.typesVersions, 'typesVersions missing from package.json');
        assert.ok(PKG.typesVersions['*'], 'typesVersions["*"] missing');
        var gnaTypes = PKG.typesVersions['*']['gna'];
        assert.ok(Array.isArray(gnaTypes), 'typesVersions["*"]["gna"] must be an array');
        assert.ok(gnaTypes.indexOf('./types/gna.d.ts') > -1, 'gna must map to ./types/gna.d.ts');
    });
});


// 03 — TypeScript declaration files: existence and key declarations
describe('03 - TypeScript declaration files: existence and key declarations', function() {

    var TYPES_DIR = path.join(ROOT, 'types');

    it('types/index.d.ts exists', function() {
        assert.ok(fs.existsSync(path.join(TYPES_DIR, 'index.d.ts')));
    });

    it('types/globals.d.ts exists', function() {
        assert.ok(fs.existsSync(path.join(TYPES_DIR, 'globals.d.ts')));
    });

    it('types/gna.d.ts exists', function() {
        assert.ok(fs.existsSync(path.join(TYPES_DIR, 'gna.d.ts')));
    });

    // index.d.ts — key type exports
    var indexSrc;
    it('index.d.ts declares GinaRequest', function() {
        indexSrc = indexSrc || fs.readFileSync(path.join(TYPES_DIR, 'index.d.ts'), 'utf8');
        assert.ok(/export\s+type\s+GinaRequest/.test(indexSrc));
    });

    it('index.d.ts declares GinaResponse', function() {
        indexSrc = indexSrc || fs.readFileSync(path.join(TYPES_DIR, 'index.d.ts'), 'utf8');
        assert.ok(/export\s+type\s+GinaResponse/.test(indexSrc));
    });

    it('index.d.ts declares SuperController class', function() {
        indexSrc = indexSrc || fs.readFileSync(path.join(TYPES_DIR, 'index.d.ts'), 'utf8');
        assert.ok(/export\s+class\s+SuperController/.test(indexSrc));
    });

    it('index.d.ts declares EntitySuper class', function() {
        indexSrc = indexSrc || fs.readFileSync(path.join(TYPES_DIR, 'index.d.ts'), 'utf8');
        assert.ok(/export\s+class\s+EntitySuper/.test(indexSrc));
    });

    // Config interfaces
    var configInterfaces = [
        'RoutingConfig', 'ConnectorsConfig', 'AppConfig',
        'SettingsConfig', 'ManifestConfig'
    ];
    configInterfaces.forEach(function(name) {
        it('index.d.ts declares ' + name + ' interface', function() {
            indexSrc = indexSrc || fs.readFileSync(path.join(TYPES_DIR, 'index.d.ts'), 'utf8');
            assert.ok(
                indexSrc.indexOf(name) > -1,
                'index.d.ts must declare ' + name
            );
        });
    });

    // globals.d.ts — key type declarations
    var globalsSrc;
    it('globals.d.ts declares PathObject interface', function() {
        globalsSrc = globalsSrc || fs.readFileSync(path.join(TYPES_DIR, 'globals.d.ts'), 'utf8');
        assert.ok(/interface\s+PathObject/.test(globalsSrc));
    });

    it('globals.d.ts declares UuidFunction', function() {
        globalsSrc = globalsSrc || fs.readFileSync(path.join(TYPES_DIR, 'globals.d.ts'), 'utf8');
        assert.ok(globalsSrc.indexOf('UuidFunction') > -1);
    });

    it('globals.d.ts augments globalThis with framework helpers', function() {
        globalsSrc = globalsSrc || fs.readFileSync(path.join(TYPES_DIR, 'globals.d.ts'), 'utf8');
        assert.ok(globalsSrc.indexOf('getContext') > -1, 'must declare getContext');
        assert.ok(globalsSrc.indexOf('setContext') > -1, 'must declare setContext');
        assert.ok(globalsSrc.indexOf('requireJSON') > -1, 'must declare requireJSON');
    });

    // gna.d.ts — GinaExports interface
    var gnaSrc;
    it('gna.d.ts declares GinaExports interface', function() {
        gnaSrc = gnaSrc || fs.readFileSync(path.join(TYPES_DIR, 'gna.d.ts'), 'utf8');
        assert.ok(/interface\s+GinaExports/.test(gnaSrc));
    });

    it('gna.d.ts GinaExports matches gna.js exports (same symbol count)', function() {
        gnaSrc = gnaSrc || fs.readFileSync(path.join(TYPES_DIR, 'gna.d.ts'), 'utf8');
        var gnajsSrc = fs.readFileSync(GNA_JS, 'utf8');

        // Count exported keys in gna.js (get X() or X: X patterns in module.exports)
        var jsGetters = (gnajsSrc.match(/get\s+\w+\s*\(\)/g) || []).length;
        var jsProps   = (gnajsSrc.match(/\w+\s*:\s*\w+,?\s*$/gm) || []).length;
        var jsExportCount = jsGetters + jsProps;

        // Count declared keys in GinaExports interface (word: type lines)
        var interfaceBody = gnaSrc.match(/interface\s+GinaExports\s*\{([\s\S]*?)\}/);
        assert.ok(interfaceBody, 'GinaExports interface body not found');
        var tsKeys = (interfaceBody[1].match(/^\s+\w+\s*:/gm) || []).length;

        assert.equal(tsKeys, jsExportCount,
            'GinaExports has ' + tsKeys + ' keys but gna.js exports ' + jsExportCount
        );
    });
});


// 04 — Swig require path: server.js and controller.js use @rhinostone/swig (not vendored)
describe('04 - Swig require path: @rhinostone/swig npm dependency', function() {

    var serverSrc = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
    var controllerSrc = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');

    it('server.js requires @rhinostone/swig', function() {
        assert.ok(
            serverSrc.indexOf("require('@rhinostone/swig')") > -1,
            'server.js must require @rhinostone/swig (not vendored deps/swig-1.4.2)'
        );
    });

    it('server.js does NOT require vendored deps/swig', function() {
        assert.ok(
            serverSrc.indexOf('deps/swig') === -1,
            'server.js must not reference vendored deps/swig — migration to @rhinostone/swig incomplete'
        );
    });

    it('controller.js requires @rhinostone/swig', function() {
        assert.ok(
            controllerSrc.indexOf("require('@rhinostone/swig')") > -1,
            'controller.js must require @rhinostone/swig (not vendored deps/swig-1.4.2)'
        );
    });

    it('controller.js does NOT require vendored deps/swig', function() {
        assert.ok(
            controllerSrc.indexOf('deps/swig') === -1,
            'controller.js must not reference vendored deps/swig — migration to @rhinostone/swig incomplete'
        );
    });

    it('vendored swig-1.4.2 directory does not exist', function() {
        var vendoredPath = path.join(FW, 'core/deps/swig-1.4.2');
        assert.ok(
            !fs.existsSync(vendoredPath),
            'core/deps/swig-1.4.2 must not exist — replaced by @rhinostone/swig npm dep'
        );
    });

    it('@rhinostone/swig resolves from the framework directory', function() {
        var resolved = null;
        try {
            resolved = require.resolve('@rhinostone/swig', {
                paths: [path.join(FW, 'core')]
            });
        } catch (e) { /* ignore */ }
        assert.ok(
            resolved !== null,
            '@rhinostone/swig must be resolvable from framework/core/ — run npm install in ' + FW
        );
    });
});


// 05 — Build script Phase 7: swig compilation uses npm dep path
describe('05 - Build script Phase 7: @rhinostone/swig npm dep path', function() {

    var buildSrc = fs.readFileSync(path.join(FW, 'core/asset/plugin/build'), 'utf8');

    it('build script references node_modules/@rhinostone/swig', function() {
        assert.ok(
            buildSrc.indexOf('node_modules/@rhinostone/swig') > -1,
            'build script Phase 7 must use node_modules/@rhinostone/swig path'
        );
    });

    it('build script does NOT use deps/swig-1.4.2 as a path operand', function() {
        // The build script may reference deps/swig-1.4.2 in comments (historical context).
        // What matters is that no --js or --js_output_file flag uses the vendored path.
        assert.ok(
            buildSrc.indexOf('--js core/deps/swig-1.4.2') === -1
            && buildSrc.indexOf('--js_output_file core/deps/swig-1.4.2') === -1,
            'build script must not use vendored deps/swig-1.4.2 as a Closure Compiler operand'
        );
    });

    it('build script has a missing-package guard for @rhinostone/swig', function() {
        assert.ok(
            buildSrc.indexOf('@rhinostone/swig not found') > -1,
            'build script must have an error message for missing @rhinostone/swig'
        );
    });
});
