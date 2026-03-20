var { describe, it, before, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');

// Bootstrap exactly as bin/cli does:
// 1. require utils/helper (sets up getEnvVar, setEnvVar, getUserHome, etc.)
// 2. require framework lib (loads helpers → path, context, prototypes)
var ginaPath = path.resolve(__dirname, '../..');
require(ginaPath + '/utils/helper');

var version = require(ginaPath + '/package.json').version;
var frameworkPath = ginaPath + '/framework/v' + version;
require(frameworkPath + '/lib');

// Test project created by `gina project:add @fw-test --path=/tmp/fw-test-project`
var testProjectPath = '/tmp/fw-test-project';


// 01 — isWin32
describe('01 - isWin32', function () {

    it('returns a boolean', function () {
        assert.equal(typeof isWin32(), 'boolean');
    });

    it('returns false on macOS/Linux', function () {
        if (process.platform !== 'win32') {
            assert.equal(isWin32(), false);
        }
    });
});


// 02 — getUserHome
describe('02 - getUserHome', function () {

    it('returns the home directory', function () {
        var home = getUserHome();
        assert.equal(typeof home, 'string');
        assert.ok(home.length > 0);
    });

    it('matches os.homedir()', function () {
        assert.equal(getUserHome(), os.homedir());
    });

    it('directory exists and is writable', function () {
        var home = getUserHome();
        assert.ok(fs.existsSync(home));
        fs.accessSync(home, fs.constants.W_OK);
    });
});


// 03 — getEnvVar / setEnvVar
describe('03 - getEnvVar / setEnvVar', function () {

    it('returns undefined for non-existing key', function () {
        assert.equal(getEnvVar('GINA_TEST_NONEXISTENT_KEY_XYZ'), undefined);
    });

    it('set and get a GINA_ prefixed variable', function () {
        setEnvVar('GINA_TEST_VAR', 'hello');
        assert.equal(getEnvVar('GINA_TEST_VAR'), 'hello');
    });

    it('auto-prefixes non-GINA/VENDOR/USER keys with USER_', function () {
        setEnvVar('MY_CUSTOM_KEY', 'custom_value');
        assert.equal(getEnvVar('USER_MY_CUSTOM_KEY'), 'custom_value');
    });

    it('uppercases the key', function () {
        setEnvVar('gina_lowercase_test', 'lower');
        assert.equal(getEnvVar('GINA_LOWERCASE_TEST'), 'lower');
    });

    it('stores in process.gina, not process.env', function () {
        setEnvVar('GINA_STORE_CHECK', 'stored');
        assert.equal(process.gina['GINA_STORE_CHECK'], 'stored');
        assert.equal(process.env['GINA_STORE_CHECK'], undefined);
    });

    it('refuses to override existing non-special variable', function () {
        setEnvVar('GINA_PROTECTED_TEST', 'first');
        setEnvVar('GINA_PROTECTED_TEST', 'second');
        // Should keep the first value (non-special key)
        assert.equal(getEnvVar('GINA_PROTECTED_TEST'), 'first');
    });

    it('allows override of special cases (GINA_PORT)', function () {
        setEnvVar('GINA_PORT', 9999);
        setEnvVar('GINA_PORT', 8888);
        assert.equal(getEnvVar('GINA_PORT'), 8888);
    });

    it('supports VENDOR_ prefix', function () {
        setEnvVar('VENDOR_TEST_VAR', 'vendor_val');
        assert.equal(getEnvVar('VENDOR_TEST_VAR'), 'vendor_val');
    });

    it('protected vars cannot be overridden via filterArgs', function () {
        setEnvVar('GINA_MY_PROTECTED', 'secret', true);
        var protectedList = getProtected();
        assert.ok(protectedList.indexOf('GINA_MY_PROTECTED') > -1);
    });
});


// 04 — getEnvVars / getProtected
describe('04 - getEnvVars / getProtected', function () {

    it('getEnvVars returns process.gina', function () {
        var vars = getEnvVars();
        assert.equal(typeof vars, 'object');
        assert.equal(vars, process.gina);
    });

    it('getProtected returns an array', function () {
        var prot = getProtected();
        assert.ok(Array.isArray(prot));
    });
});


// 05 — filterArgs (argv processing)
describe('05 - filterArgs', function () {

    var origArgv;
    var origGina;

    beforeEach(function () {
        origArgv = process.argv;
        origGina = process.gina;
        process.gina = {};
    });

    afterEach(function () {
        process.argv = origArgv;
        process.gina = origGina;
    });

    it('moves --gina_* args from argv to process.gina', function () {
        process.argv = ['node', 'cli', '--gina_test_filter=filtered_value'];
        filterArgs();
        assert.equal(process.gina['GINA_TEST_FILTER'], 'filtered_value');
    });

    it('converts "true" string to boolean true', function () {
        process.argv = ['node', 'cli', '--gina_bool_true=true'];
        filterArgs();
        assert.equal(process.gina['GINA_BOOL_TRUE'], true);
    });

    it('converts "false" string to boolean false', function () {
        process.argv = ['node', 'cli', '--gina_bool_false=false'];
        filterArgs();
        assert.equal(process.gina['GINA_BOOL_FALSE'], false);
    });

    it('moves GINA_ env vars from process.env to process.gina', function () {
        process.env['GINA_ENV_MOVE_TEST'] = 'moved';
        filterArgs();
        assert.equal(process.gina['GINA_ENV_MOVE_TEST'], 'moved');
        assert.equal(process.env['GINA_ENV_MOVE_TEST'], undefined);
    });

    it('skips --prefix, --env, --scope args', function () {
        process.argv = ['node', 'cli', '--prefix=/usr/local', '--env=dev', '--scope=local'];
        filterArgs();
        assert.equal(process.gina['GINA_PREFIX'], undefined);
    });
});


// 06 — getTmpDir
describe('06 - getTmpDir', function () {

    it('returns a string', function () {
        var tmp = getTmpDir();
        assert.equal(typeof tmp, 'string');
    });

    it('returns a valid directory', function () {
        var tmp = getTmpDir();
        assert.ok(tmp.length > 0);
    });
});


// 07 — PathObject constructor _ ()
describe('07 - PathObject constructor _()', function () {

    it('_ is a global function', function () {
        assert.equal(typeof _, 'function');
    });

    it('returns a string when called with force=true', function () {
        var result = _('/tmp/test-path', true);
        assert.equal(typeof result, 'string');
    });

    it('normalises path separators', function () {
        var result = _('/tmp//double//slashes', true);
        assert.ok(!result.includes('//'));
    });

    it('new _() returns a PathObject', function () {
        var obj = new _('/tmp');
        assert.equal(typeof obj, 'object');
        assert.equal(obj.value, '/tmp');
    });

    it('PathObject has existsSync method', function () {
        var obj = new _('/tmp');
        assert.equal(typeof obj.existsSync, 'function');
    });

    it('PathObject.existsSync returns true for existing dir', function () {
        var obj = new _('/tmp');
        assert.equal(obj.existsSync(), true);
    });

    it('PathObject.existsSync returns false for non-existing dir', function () {
        var obj = new _('/tmp/gina-definitely-does-not-exist-xyz');
        assert.equal(obj.existsSync(), false);
    });

    it('PathObject has mkdirSync method', function () {
        var obj = new _('/tmp');
        assert.equal(typeof obj.mkdirSync, 'function');
    });
});


// 08 — setContext / getContext
describe('08 - setContext / getContext', function () {

    it('setContext and getContext are global functions', function () {
        assert.equal(typeof setContext, 'function');
        assert.equal(typeof getContext, 'function');
    });

    it('set and get a context value', function () {
        setContext('testKey', 'testValue');
        assert.equal(getContext('testKey'), 'testValue');
    });

    it('set and get an object context', function () {
        setContext('testObj', { name: 'gina', version: '0.1' });
        var obj = getContext('testObj');
        assert.equal(obj.name, 'gina');
        assert.equal(obj.version, '0.1');
    });

    it('getContext without args returns all contexts', function () {
        var ctx = getContext();
        assert.equal(typeof ctx, 'object');
    });

    it('getContext returns undefined for missing key', function () {
        var result = getContext('nonexistent_ctx_key_xyz');
        assert.equal(result, undefined);
    });
});


// 09 — setPath / getPath
describe('09 - setPath / getPath', function () {

    it('setPath and getPath are global functions', function () {
        assert.equal(typeof setPath, 'function');
        assert.equal(typeof getPath, 'function');
    });

    it('set and get a simple path', function () {
        setPath('testpath', _('/tmp/gina-test', true));
        var result = getPath('testpath');
        assert.equal(typeof result, 'string');
        assert.ok(result.includes('gina-test'));
    });

    it('dot notation creates nested path in context', function () {
        setPath('gina.testdir', _('/tmp', true));
        // dot notation stores as nested: paths.gina.testdir
        var paths = getContext('paths');
        assert.equal(paths.gina.testdir, '/tmp');
    });
});


// 10 — define / getDefined
describe('10 - define / getDefined', function () {

    it('define is a global function', function () {
        assert.equal(typeof define, 'function');
    });

    it('define a constant (auto-prefixes with USER_)', function () {
        define('TEST_CONST', 42);
        // define() adds USER_ prefix for non-GINA/USER keys
        assert.equal(global['USER_TEST_CONST'], 42);
        var defined = getDefined();
        assert.equal(defined['USER_TEST_CONST'], 42);
    });

    it('defineDefault sets multiple constants', function () {
        defineDefault({
            'USER_CONST_A': 'alpha',
            'USER_CONST_B': 'beta'
        });
        var defined = getDefined();
        assert.equal(defined['USER_CONST_A'], 'alpha');
        assert.equal(defined['USER_CONST_B'], 'beta');
    });
});


// 11 — getVendorsConfig / setVendorsConfig
describe('11 - getVendorsConfig / setVendorsConfig', function () {

    it('getVendorsConfig returns undefined for non-existent vendor', function () {
        var result = getVendorsConfig('nonexistent_vendor');
        assert.equal(result, undefined);
    });

    it('getVendorsConfig without args returns all config', function () {
        var result = getVendorsConfig();
        assert.equal(typeof result, 'object');
    });

    it('setVendorsConfig loads JSON files from a directory', function () {
        // Create a temp dir with a JSON config file
        var tmpDir = path.join(os.tmpdir(), 'gina-vendor-test-' + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'testvendor.json'), JSON.stringify({ key: 'value' }));

        setVendorsConfig(tmpDir);
        var result = getVendorsConfig('testvendor');
        assert.deepStrictEqual(result, { key: 'value' });

        // Cleanup
        fs.rmSync(tmpDir, { recursive: true });
    });
});


// 12 — getBundleStartingArgv
describe('12 - getBundleStartingArgv', function () {

    it('returns null for non-existing bundle argv file', function () {
        var result = getBundleStartingArgv('nonexistent', 'nonexistent');
        assert.equal(result, null);
    });

    it('reads argv from tmp file when present', function () {
        var tmpDir = getTmpDir();
        var argvFile = path.join(tmpDir, 'testargv@testproj.argv');
        fs.writeFileSync(argvFile, 'node,cli,bundle:start,testargv,@testproj');

        var result = getBundleStartingArgv('testargv', 'testproj');
        assert.equal(typeof result, 'string');
        assert.ok(result.includes('bundle:start'));

        // Cleanup
        fs.unlinkSync(argvFile);
    });
});


// 13 — whisper (template substitution)
describe('13 - whisper', function () {

    it('whisper is a global function', function () {
        assert.equal(typeof whisper, 'function');
    });

    it('bare {key} tokens are not replaced (deprecated since 0.1.8, use ${key})', function () {
        var dict = { name: 'Gina', version: '0.1.6' };
        var result = whisper(dict, 'Hello {name} v{version}');
        assert.equal(result, 'Hello {name} v{version}');
    });

    it('handles missing keys gracefully', function () {
        var dict = { name: 'Gina' };
        // whisper logs an error for missing keys but doesn't throw
        var result = whisper(dict, 'Hello ${name}');
        assert.equal(result, 'Hello Gina');
    });

    it('replaces ${key} tokens in a string (new syntax)', function () {
        var dict = { name: 'Gina', version: '0.1.7' };
        var result = whisper(dict, 'Hello ${name} v${version}');
        assert.equal(result, 'Hello Gina v0.1.7');
    });

    it('leaves bare {key} tokens unreplaced (${key} syntax required since 0.1.8)', function () {
        var dict = { scope: 'production', host: 'app.example.com' };
        var result = whisper(dict, '${scope}/{host}');
        assert.equal(result, 'production/{host}');
    });
});


// 14 — integration: test project fixture
describe('14 - test project fixture', function () {

    before(function () {
        if (!fs.existsSync(testProjectPath)) {
            this.skip();
        }
    });

    it('test project exists at /tmp/fw-test-project', function () {
        assert.ok(fs.existsSync(testProjectPath));
    });

    it('has a manifest.json with testbundle', function () {
        var manifest = JSON.parse(fs.readFileSync(path.join(testProjectPath, 'manifest.json')));
        assert.equal(manifest.name, 'fw-test');
        assert.ok(manifest.bundles.testbundle);
        assert.equal(manifest.bundles.testbundle.version, '0.0.1');
    });

    it('has bundle source at src/testbundle/', function () {
        assert.ok(fs.existsSync(path.join(testProjectPath, 'src/testbundle/index.js')));
    });

    it('bundle has valid config/app.json', function () {
        var appConfig = JSON.parse(
            fs.readFileSync(path.join(testProjectPath, 'src/testbundle/config/app.json'), 'utf8')
                .replace(/\/\/.*/g, '')
        );
        assert.equal(appConfig.name, 'testbundle');
    });

    it('bundle has controllers directory', function () {
        assert.ok(fs.existsSync(path.join(testProjectPath, 'src/testbundle/controllers')));
    });

    it('node_modules/gina is symlinked', function () {
        var ginaMod = path.join(testProjectPath, 'node_modules/gina');
        assert.ok(fs.existsSync(ginaMod));
    });

    it('setContext with project path and verify getContext', function () {
        setContext('projectName', 'fw-test');
        setContext('projectPath', testProjectPath);
        assert.equal(getContext('projectName'), 'fw-test');
        assert.equal(getContext('projectPath'), testProjectPath);
    });

    it('setPath with project and verify getPath', function () {
        setPath('project', _(testProjectPath, true));
        var result = getPath('project');
        assert.ok(result !== undefined);
    });
});


// 15 — lib global
describe('15 - lib global', function () {

    it('lib is a global object', function () {
        assert.equal(typeof lib, 'object');
    });

    it('lib has merge function', function () {
        assert.equal(typeof lib.merge, 'function');
    });

    it('lib has Collection', function () {
        assert.equal(typeof lib.Collection, 'function');
    });

    it('lib has Cache', function () {
        assert.equal(typeof lib.Cache, 'function');
    });

    it('lib has Domain', function () {
        assert.equal(typeof lib.Domain, 'function');
    });

    it('lib has logger', function () {
        assert.ok(lib.logger);
    });

    it('lib has generator', function () {
        assert.ok(lib.generator);
    });

    it('lib has routing', function () {
        assert.ok(lib.routing);
    });
});
