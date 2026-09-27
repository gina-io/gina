var { describe, it, before, after, beforeEach, afterEach } = require('node:test');   // `after`: #B676 §12 scratch-home teardown
var assert = require('node:assert/strict');
var EventEmitter = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');

var ginaRoot = path.resolve(__dirname, '../..');
var CONTEXT_SOURCE = path.join(ginaRoot, 'framework', 'v' + require(ginaRoot + '/package.json').version, 'helpers', 'context.js');
var HELPER_CMD_SOURCE = path.join(ginaRoot, 'framework', 'v' + require(ginaRoot + '/package.json').version, 'lib', 'cmd', 'helper.js');

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

    it('skips --gina-version and does not promote it to process.gina', function () {
        process.argv = ['node', 'cli', 'bundle:start', 'api', '@myproject', '--gina-version=0.1.8'];
        filterArgs();
        assert.equal(process.gina['GINA_GINA_VERSION'], undefined);
        assert.equal(process.gina['GINA_GINA-VERSION'], undefined);
    });

    it('--gina-version does not prevent other flags from being processed', function () {
        process.argv = ['node', 'cli', '--gina_test_skip_check=ok', '--gina-version=0.1.8'];
        filterArgs();
        assert.equal(process.gina['GINA_TEST_SKIP_CHECK'], 'ok');
        assert.equal(process.gina['GINA_GINA_VERSION'], undefined);
    });

    // #B40 — framework-connection flags hoist into GINA_* only for framework-scoped
    // commands. A sub-topic command's --port is the BUNDLE port and must not become
    // GINA_PORT (which framework:init would persist as the framework socket port).
    it('#B40: port:set --port=N does NOT hoist GINA_PORT', function () {
        delete process.env.GINA_PORT;
        process.argv = ['node', 'cli', 'port:set', 'frontend', '@myproject', '--port=3200'];
        filterArgs();
        assert.equal(process.gina['GINA_PORT'], undefined, 'port:set --port must not become GINA_PORT');
    });

    it('#B40: bundle:start --port=N does NOT hoist GINA_PORT', function () {
        delete process.env.GINA_PORT;
        process.argv = ['node', 'cli', 'bundle:start', 'frontend', '@myproject', '--port=3200'];
        filterArgs();
        assert.equal(process.gina['GINA_PORT'], undefined, 'bundle:start --port must not become GINA_PORT');
    });

    it('#B40: framework:set --port=N DOES hoist GINA_PORT', function () {
        delete process.env.GINA_PORT;
        process.argv = ['node', 'cli', 'framework:set', '--port=9001'];
        filterArgs();
        assert.equal(~~process.gina['GINA_PORT'], 9001, 'framework:set --port must become GINA_PORT');
    });

    it('#B40: bare `start --port=N` DOES hoist GINA_PORT (bare = framework-scoped)', function () {
        delete process.env.GINA_PORT;
        process.argv = ['node', 'cli', 'start', '--port=9002'];
        filterArgs();
        assert.equal(~~process.gina['GINA_PORT'], 9002, 'bare start --port must become GINA_PORT');
    });

    it('#B40: also guards --mq-port / --host-v4 / --hostname for sub-topic commands', function () {
        delete process.env.GINA_MQ_PORT; delete process.env.GINA_HOST_V4; delete process.env.GINA_HOSTNAME;
        process.argv = ['node', 'cli', 'port:set', 'frontend', '@myproject', '--mq-port=9125', '--host-v4=1.2.3.4', '--hostname=foo'];
        filterArgs();
        assert.equal(process.gina['GINA_MQ_PORT'], undefined);
        assert.equal(process.gina['GINA_HOST_V4'], undefined);
        assert.equal(process.gina['GINA_HOSTNAME'], undefined);
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


// 07b — onCompleteCall global
describe('07b - onCompleteCall global', function () {

    it('onCompleteCall is a global function', function () {
        assert.equal(typeof onCompleteCall, 'function');
    });

    it('returns a Promise', function () {
        var emitter = new EventEmitter();
        emitter.onComplete = function(cb) { cb(null, 'ok'); };
        var result = onCompleteCall(emitter);
        assert.ok(result instanceof Promise);
    });

    it('resolves with the result passed to onComplete', async function () {
        var emitter = new EventEmitter();
        emitter.onComplete = function(cb) { cb(null, 'resolved-value'); };
        var val = await onCompleteCall(emitter);
        assert.equal(val, 'resolved-value');
    });

    it('rejects with the error passed to onComplete', async function () {
        var emitter = new EventEmitter();
        var err = new Error('operation failed');
        emitter.onComplete = function(cb) { cb(err); };
        await assert.rejects(onCompleteCall(emitter), err);
    });

    it('works with any object that has .onComplete — not limited to PathObject', async function () {
        var customEmitter = {
            onComplete: function(cb) { cb(null, 42); }
        };
        var val = await onCompleteCall(customEmitter);
        assert.equal(val, 42);
    });

    it('resolves with undefined when onComplete passes no result', async function () {
        var emitter = new EventEmitter();
        emitter.onComplete = function(cb) { cb(null); };
        var val = await onCompleteCall(emitter);
        assert.equal(val, undefined);
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


// 08b — setContext / getContext: dot-key asymmetry
// Recommendation: Use flat keys (no dots) for setContext/getContext round-trip.
// setContext('a.b', val) splits on dots and creates nested structure { a: { b: val } },
// but getContext('a.b') does a flat lookup on self.contexts['a.b'] — returns undefined.
// Keys must NOT contain dots.
describe('08b - setContext / getContext: dot-key asymmetry', function () {

    it('source: setContext has dot-splitting logic (regex /\\./ test)', function () {
        var src = fs.readFileSync(CONTEXT_SOURCE, 'utf8');
        // setContext splits dotted names: if (/\./.test(name))
        assert.ok(
            /if\s*\(\s*\/\\\.\/\.test\(\s*name\s*\)/.test(src),
            'expected setContext to contain dot-detection regex /\\./.test(name)'
        );
    });

    it('source: getContext does flat lookup — no dot-splitting', function () {
        var src = fs.readFileSync(CONTEXT_SOURCE, 'utf8');
        // Extract the getContext function body
        var getCtxMatch = src.match(/getContext\s*=\s*function\s*\(name\)\s*\{([\s\S]*?)\n    \}/);
        assert.ok(getCtxMatch, 'expected to find getContext function body');
        var getCtxBody = getCtxMatch[1];
        // getContext does NOT split on dots — no /\./ test in its body
        assert.ok(
            !/\/\\\.\//.test(getCtxBody),
            'getContext must NOT contain dot-splitting logic — it does a flat lookup'
        );
    });

    it('dotted key: setContext("dotted.key", val) then getContext("dotted.key") returns undefined', function () {
        // This documents the asymmetry — setContext splits on dots,
        // getContext does a flat lookup. The round-trip fails.
        var uniqueVal = 'asymmetry-test-' + Date.now();
        setContext('_test_dotted.key', uniqueVal);
        var result = getContext('_test_dotted.key');
        assert.equal(result, undefined, 'dotted key round-trip must return undefined (asymmetry)');
    });

    it('flat key: setContext("flatKey", val) then getContext("flatKey") works correctly', function () {
        var uniqueVal = 'flat-test-' + Date.now();
        setContext('_test_flat_key', uniqueVal);
        var result = getContext('_test_flat_key');
        assert.equal(result, uniqueVal);
    });

    it('nested value from dotted set IS accessible via getContext() with no args', function () {
        // setContext('a.b', val) creates { a: { b: val } } in contexts.
        // getContext('a.b') fails, but getContext() returns all contexts,
        // so the nested value is reachable by drilling into the object.
        var uniqueVal = 'nested-drill-' + Date.now();
        setContext('_test_drill.nested', uniqueVal);
        var allContexts = getContext();
        assert.equal(typeof allContexts._test_drill, 'object', 'dotted set must create nested object');
        assert.equal(allContexts._test_drill.nested, uniqueVal, 'nested value must be accessible by drilling into getContext()');
    });

    it('getContext with the top-level segment of a dotted key returns the nested object', function () {
        var uniqueVal = 'toplevel-' + Date.now();
        setContext('_test_top.child', uniqueVal);
        var topLevel = getContext('_test_top');
        assert.equal(typeof topLevel, 'object');
        assert.equal(topLevel.child, uniqueVal);
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

    // #B676 — the reader resolves its dir from GINA_HOMEDIR (`getArgvDir()` = `<home>/run`).
    // The test process runs no bin/cli bootstrap, so the framework env carries no GINA_HOMEDIR
    // and the helper falls back to process.env: point it at a scratch home so no fixture is
    // ever written into the real `~/.gina/run`. `before()` only prepares state — every
    // discriminating assertion lives in its own `it()`.
    var _argvScratchHome = null;
    var _argvPrevEnvHome = null;
    before(function () {
        _argvPrevEnvHome = process.env.GINA_HOMEDIR;
        _argvScratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-argv-home-'));
        process.env.GINA_HOMEDIR = _argvScratchHome;
    });
    after(function () {
        if (typeof _argvPrevEnvHome === 'undefined') { delete process.env.GINA_HOMEDIR; }
        else { process.env.GINA_HOMEDIR = _argvPrevEnvHome; }
        try { fs.rmSync(_argvScratchHome, { recursive: true, force: true }); } catch (e) {}
    });

    it('returns null for non-existing bundle argv file', function () {
        var result = getBundleStartingArgv('nonexistent', 'nonexistent');
        assert.equal(result, null);
    });

    it('reads argv from the argv-dir file when present', function () {
        // #B676 — fixture written where the reader looks: getArgvDir(), no longer getTmpDir()
        var tmpDir = getArgvDir();
        var argvFile = path.join(tmpDir, 'testargv@testproj.argv');
        fs.writeFileSync(argvFile, 'node,cli,bundle:start,testargv,@testproj');

        var result = getBundleStartingArgv('testargv', 'testproj');
        assert.equal(typeof result, 'string');
        assert.ok(result.includes('bundle:start'));

        // Cleanup
        fs.unlinkSync(argvFile);
    });

    // #SEC - bundle/project may be parsed from log content (the `tail --follow`
    // auto-restart path), so unsafe identifiers must never compose a path that
    // escapes the tmp dir (the returned argv is executed by the caller).
    it('rejects path separators in bundle/project (returns null)', function () {
        assert.equal(getBundleStartingArgv('a/b', 'proj'), null);
        assert.equal(getBundleStartingArgv('bundle', 'a/b'), null);
        assert.equal(getBundleStartingArgv('a\\b', 'proj'), null);
        assert.equal(getBundleStartingArgv('bundle', 'a\\b'), null);
    });

    it('rejects `..` traversal in bundle/project (returns null)', function () {
        assert.equal(getBundleStartingArgv('..', '..'), null);
        assert.equal(getBundleStartingArgv('../../etc/x', 'proj'), null);
        assert.equal(getBundleStartingArgv('bundle', '../../x'), null);
    });

    it('rejects empty bundle/project (returns null)', function () {
        assert.equal(getBundleStartingArgv('', ''), null);
        assert.equal(getBundleStartingArgv('bundle', ''), null);
        assert.equal(getBundleStartingArgv('', 'proj'), null);
    });

    it('does not reach a real file via a separator-bearing name (subtract control)', function () {
        var tmpDir   = getArgvDir();   // #B676 — the reader's dir
        var argvFile = path.join(tmpDir, 'safedecoy@p.argv');
        fs.writeFileSync(argvFile, 'node,cli,bundle:start,safedecoy,@p');
        try {
            // control: the safe name reads the file
            var ok = getBundleStartingArgv('safedecoy', 'p');
            assert.equal(typeof ok, 'string');
            assert.ok(ok.includes('bundle:start'));
            // separator-bearing variants must NOT reach the same file
            assert.equal(getBundleStartingArgv('../safedecoy', 'p'), null);
            assert.equal(getBundleStartingArgv('./safedecoy', 'p'), null);
        } finally {
            fs.unlinkSync(argvFile);
        }
    });

    it('accepts benign names with dots and dashes (no false rejection)', function () {
        var tmpDir   = getArgvDir();   // #B676 — the reader's dir
        var argvFile = path.join(tmpDir, 'my-bundle@my.proj.argv');
        fs.writeFileSync(argvFile, 'node,cli,bundle:start,my-bundle,@my.proj');
        try {
            var result = getBundleStartingArgv('my-bundle', 'my.proj');
            assert.equal(typeof result, 'string');
            assert.ok(result.includes('bundle:start'));
        } finally {
            fs.unlinkSync(argvFile);
        }
    });
});


// 12b — #B676: the saved-argv file is trusted by OWNERSHIP, never by content or location.
// `gina tail --follow` executes the file's first token, so the reader must (a) look only in a
// user-owned dir (`<GINA_HOMEDIR>/run`), never the shared tmp dir another host user can write,
// and (b) refuse a file that is not a regular file owned by this uid, or that group/other can
// write. Every arm below FAILS on the pre-#B676 bytes (no getArgvDir; reader in getTmpDir;
// no stat guard) and passes on the fix; the one arm labelled CONTROL is green on both.
describe('12b - getBundleStartingArgv trusts the file by ownership (#B676)', function () {

    var posix = (typeof process.getuid === 'function');

    // Same scratch home as §12: that suite's before/after pair is scoped to §12 and has
    // restored process.env.GINA_HOMEDIR by the time this one runs, so without its own pair
    // every arm below resolves the REAL `~/.gina/run` and the first path.join()s undefined.
    var _scratchHome12b = null;
    var _prevEnvHome12b = null;
    before(function () {
        _prevEnvHome12b = process.env.GINA_HOMEDIR;
        _scratchHome12b = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-argv-home-'));
        process.env.GINA_HOMEDIR = _scratchHome12b;
    });
    after(function () {
        if (typeof _prevEnvHome12b === 'undefined') { delete process.env.GINA_HOMEDIR; }
        else { process.env.GINA_HOMEDIR = _prevEnvHome12b; }
        try { fs.rmSync(_scratchHome12b, { recursive: true, force: true }); } catch (e) {}
    });

    it('getArgvDir() is <GINA_HOMEDIR>/run, exists, and is not the tmp dir', function () {
        assert.equal(typeof getArgvDir, 'function', 'getArgvDir must be a global helper');
        var dir = getArgvDir();
        assert.equal(dir, path.join(process.env.GINA_HOMEDIR, 'run'));
        assert.ok(fs.existsSync(dir), 'getArgvDir() creates its dir');
        assert.notEqual(path.resolve(dir), path.resolve(getTmpDir()), 'the argv dir must not be the tmp dir');
    });

    it('CONTROL - a missing file still reads null (green before and after the fix)', function () {
        assert.equal(getBundleStartingArgv('never-written', 'nowhere'), null);
    });

    it('ignores a file planted in the tmp dir — the old location (subtract control)', function () {
        var decoy = path.join(getTmpDir(), 'oldloc@p.argv');
        fs.writeFileSync(decoy, 'node,cli,bundle:start,oldloc,@p');
        try {
            assert.equal(getBundleStartingArgv('oldloc', 'p'), null, 'a tmp-dir file must not be read');
        } finally {
            fs.unlinkSync(decoy);
        }
    });

    it('reads a 0600 file owned by this uid, and refuses the same file once group/other can write it', function () {
        if (!posix) { return; }
        var file = path.join(getArgvDir(), 'owned@p.argv');
        fs.writeFileSync(file, 'node,cli,bundle:start,owned,@p', { mode: 0o600 });
        try {
            var ok = getBundleStartingArgv('owned', 'p');                 // the discriminating half
            assert.equal(typeof ok, 'string');
            assert.ok(ok.includes('bundle:start'));
            fs.chmodSync(file, 0o666);
            assert.equal(getBundleStartingArgv('owned', 'p'), null, 'a group/other-writable file must be refused');
            fs.chmodSync(file, 0o644);
            assert.equal(typeof getBundleStartingArgv('owned', 'p'), 'string', '0644 (no group/other write bit) still reads');
        } finally {
            fs.unlinkSync(file);
        }
    });

    it('refuses a file owned by another uid (fs.statSync stubbed to report a foreign owner)', function () {
        if (!posix) { return; }
        var file = path.join(getArgvDir(), 'foreign@p.argv');
        fs.writeFileSync(file, 'node,cli,bundle:start,foreign,@p', { mode: 0o600 });
        var realStatSync = fs.statSync;
        try {
            assert.equal(typeof getBundleStartingArgv('foreign', 'p'), 'string', 'own file reads (discriminating half)');
            // utils/helper.js holds the shared `fs` module object, so a stub on it is what the reader calls.
            fs.statSync = function (p) {
                var st = realStatSync.apply(fs, arguments);
                if (('' + p).indexOf('foreign@p.argv') > -1) {
                    var uid = st.uid + 1;
                    return { isFile: function () { return st.isFile(); }, uid: uid, mode: st.mode };
                }
                return st;
            };
            assert.equal(getBundleStartingArgv('foreign', 'p'), null, 'a foreign-owned file must be refused');
        } finally {
            fs.statSync = realStatSync;
            fs.unlinkSync(file);
        }
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
var _testProjectExists = fs.existsSync(testProjectPath);
describe('14 - test project fixture', { skip: !_testProjectExists }, function () {

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


// 16 — whisper silent on missing keys (#B12): no console.error, returns original string.
describe('16 - whisper: silent on missing keys (#B12)', function () {

    it('context.js whisper no longer emits a [Whisper Error] on missing keys', function () {
        var src = fs.readFileSync(CONTEXT_SOURCE, 'utf8');
        // Before #B12, the third replace pass logged a red "[Whisper Error]"
        // console.error every time a ${key} token had no matching dictionary
        // entry — surfacing on every first-run `gina --version` after a fresh
        // install. The fix removes the error; the token is returned as-is.
        assert.equal(
            /\[Whisper Error\]/.test(src),
            false,
            'context.js still contains [Whisper Error] text — #B12 regressed'
        );
    });

    it('whisper does not throw on missing key — returns original string', function () {
        // whisper logs an error but must not throw or crash
        var result;
        assert.doesNotThrow(function () {
            result = whisper({ name: 'Gina' }, 'Hello ${missingKey}');
        });
        // Missing key token is left unreplaced
        assert.ok(result.indexOf('${missingKey}') > -1 || result === 'Hello ${missingKey}');
    });

    it('present keys are substituted even when other keys are missing', function () {
        var result = whisper({ name: 'Gina' }, '${name} v${version}');
        assert.ok(result.indexOf('Gina') > -1, 'expected present key to be substituted');
    });

});


// 17 — getCoreEnv: all required reps keys are present in helper.js
describe('17 - getCoreEnv: reps dictionary contains all required substitution keys', function () {

    var REQUIRED_KEYS = [
        'frameworkDir',
        'executionPath',
        'projectPath',
        'projectName',
        'homedir',
        'bundlesPath',
        'cachePath',
        'projectVersion',
        'projectVersionMajor',
        'env',
        'bundle',
        'version'
    ];

    REQUIRED_KEYS.forEach(function (key) {
        it('"' + key + '" is in the getCoreEnv reps object', function () {
            var src = fs.readFileSync(HELPER_CMD_SOURCE, 'utf8');
            // Match the key as an object property in the reps literal (quoted or unquoted)
            var re = new RegExp('"' + key + '"\\s*:');
            assert.ok(
                re.test(src),
                'expected "' + key + '" key in getCoreEnv reps — missing key causes ${' + key + '} to remain unreplaced in env.json'
            );
        });
    });

    it('bundlesPath is pre-computed as a local var and referenced in reps (not a forward reference)', function () {
        var src = fs.readFileSync(HELPER_CMD_SOURCE, 'utf8');
        // var bundlesPath = ... must exist
        assert.ok(/var bundlesPath\s*=/.test(src), 'expected `var bundlesPath =` pre-computation in getCoreEnv');
        // "bundlesPath" : bundlesPath  — reps references the local variable
        assert.ok(/"bundlesPath"\s*:\s*bundlesPath/.test(src), 'expected `"bundlesPath" : bundlesPath` in reps');
    });

    it('homedir is pre-computed as a local var and referenced in reps', function () {
        var src = fs.readFileSync(HELPER_CMD_SOURCE, 'utf8');
        assert.ok(/var homedir\s*=/.test(src), 'expected `var homedir =` pre-computation in getCoreEnv');
        assert.ok(/"homedir"\s*:\s*homedir/.test(src), 'expected `"homedir" : homedir` in reps');
    });

    it('cachePath is pre-computed as a local var and referenced in reps', function () {
        var src = fs.readFileSync(HELPER_CMD_SOURCE, 'utf8');
        assert.ok(/var cachePath\s*=/.test(src), 'expected `var cachePath =` pre-computation in getCoreEnv');
        assert.ok(/"cachePath"\s*:\s*cachePath/.test(src), 'expected `"cachePath" : cachePath` in reps');
    });

    it('documents the whisper single-pass limitation in a comment', function () {
        var src = fs.readFileSync(HELPER_CMD_SOURCE, 'utf8');
        assert.ok(
            /whisper.*single.pass|single.pass.*whisper|pre.comput/i.test(src),
            'expected a comment explaining whisper single-pass limitation in getCoreEnv'
        );
    });

});


// 18 — loadAssets: stale-manifest project skipped, not fatal (#B24)
//
// loadAssets() iterates every registered project. When a project's directory
// exists but its manifest.json is gone (a stale ~/.gina/projects.json entry),
// it warns and `continue`s — instead of falling through to
// requireJSON(...).bundles, which process-exits on ENOENT and aborted EVERY
// offline asset command (secrets:scan, i18n:scan, bundle:list) when ANY one
// registered project was stale, even when a specific @project was named.
describe('18 - loadAssets: stale-manifest project skipped not fatal (#B24)', function () {

    it('source: a `continue` sits between the missing-manifest warning and the requireJSON deref', function () {
        var src      = fs.readFileSync(HELPER_CMD_SOURCE, 'utf8');
        var warnIdx  = src.indexOf('not found ! Maybe, you can try to remove the project reference');
        var derefIdx = src.indexOf('requireJSON(projectPropertiesPath).bundles');
        assert.ok(warnIdx > -1, 'the missing-manifest warning must exist in loadAssets');
        assert.ok(derefIdx > warnIdx, 'the requireJSON(...).bundles deref must follow the warning');
        var between = src.slice(warnIdx, derefIdx);
        assert.match(between, /continue\s*;/,
            '#B24: a `continue` must skip the stale project before the unguarded requireJSON deref');
    });

    // --- Pure-logic replica of the per-project loadAssets decision ----------
    // No daemon / CmdHelper context (loadAssets needs the full CLI bootstrap to
    // run — same convention as cmd-noninteractive-guards.test.js). The replica
    // mirrors helper.js:1255-1296 for one project: pre-set bundles {} (1255),
    // dir-exists -> exists=true (1256-1257), manifest-missing -> warn+continue
    // (#B24, 1258-1260), else load bundles (1262); dir-missing -> exists=false.

    function throwingRequireJSON() {
        var e = new Error("ENOENT: no such file or directory, open 'manifest.json'");
        e.code = 'ENOENT';
        throw e;
    }

    // POST-#B24 (fixed): continue on a missing manifest.
    function loadOneProjectFixed(opts) {
        var entry   = {};
        var bundles = {};                 // helper.js:1255 pre-set
        if (opts.dirExists) {
            entry.exists = true;          // helper.js:1257
            if (!opts.manifestExists) {
                opts.warn();              // helper.js:1259
                return { entry: entry, bundles: bundles };  // #B24 continue -> skip
            }
            bundles = opts.requireJSON().bundles;           // helper.js:1262
        } else {
            entry.exists = false;         // helper.js:1295
        }
        return { entry: entry, bundles: bundles };
    }

    // PRE-#B24 (buggy): warn but NO continue -> falls through to requireJSON.
    function loadOneProjectOld(opts) {
        var entry   = {};
        var bundles = {};
        if (opts.dirExists) {
            entry.exists = true;
            if (!opts.manifestExists) {
                opts.warn();              // warns...
            }
            bundles = opts.requireJSON().bundles;  // ...but unguarded -> throws when manifest missing
        } else {
            entry.exists = false;
        }
        return { entry: entry, bundles: bundles };
    }

    it('MEASUREMENT: the old body aborts (throws ENOENT) on a stale manifest', function () {
        var warned = 0;
        assert.throws(function () {
            loadOneProjectOld({ dirExists: true, manifestExists: false, warn: function () { warned++; }, requireJSON: throwingRequireJSON });
        }, /ENOENT/);
        assert.equal(warned, 1, 'old body still warns before it throws');
    });

    it('fixed: stale manifest warns + skips to {} without calling requireJSON (no abort)', function () {
        var warned = 0, required = 0;
        var out = loadOneProjectFixed({
            dirExists: true, manifestExists: false,
            warn: function () { warned++; },
            requireJSON: function () { required++; return { bundles: { x: {} } }; }
        });
        assert.equal(warned, 1, 'the stale project is warned');
        assert.equal(required, 0, 'requireJSON is NOT called for the stale project (the skip)');
        assert.deepEqual(out.bundles, {}, 'bundlesByProject stays {} for the stale project');
        assert.equal(out.entry.exists, true, 'dir-exists flag stays true (the dir is present)');
    });

    it('fixed: a valid project still loads its bundles', function () {
        var warned = 0, required = 0;
        var out = loadOneProjectFixed({
            dirExists: true, manifestExists: true,
            warn: function () { warned++; },
            requireJSON: function () { required++; return { bundles: { testbundle: { version: '0.0.1' } } }; }
        });
        assert.equal(warned, 0, 'a valid project is not warned');
        assert.equal(required, 1, 'requireJSON loads the manifest for a valid project');
        assert.deepEqual(out.bundles, { testbundle: { version: '0.0.1' } });
        assert.equal(out.entry.exists, true);
    });

    it('fixed: a project whose directory is missing is flagged exists=false (unchanged)', function () {
        var warned = 0, required = 0;
        var out = loadOneProjectFixed({
            dirExists: false, manifestExists: false,
            warn: function () { warned++; },
            requireJSON: function () { required++; return { bundles: {} }; }
        });
        assert.equal(warned, 0);
        assert.equal(required, 0);
        assert.equal(out.entry.exists, false);
        assert.deepEqual(out.bundles, {});
    });
});


// 19 — loadAssets: per-bundle def_env uses the loop variable, not cmd.projectName (#B27)
//
// loadAssets()'s `for (project in bundlesByProject) { for (bundle in ...) }`
// double-loop sets each bundle's def_env. Every sibling write in the loop body
// indexes bundlesByProject by the loop variable `project`; ONE line
// (helper.js:1388) indexed by cmd.projectName instead. When the loop reached a
// project that is NOT the freshly-added @alias — and that alias had no
// bundlesByProject entry yet — the write dereferenced
// cmd.bundlesByProject[<alias>] === undefined and threw
// `TypeError: Cannot read properties of undefined (reading '<bundle>')`,
// hard-crashing `gina project:add` whenever projects.json already held another
// project whose on-disk bundles passed the existsSync gate (e.g. the same path
// registered under another alias). A first-ever add into an empty projects.json
// has no other project to iterate, so it never reached the line — why it stayed
// latent. Longstanding (blame: b489588d, 2025-07-29), not a #B24 regression.
describe('19 - loadAssets: per-bundle def_env uses loop variable not cmd.projectName (#B27)', function () {

    it('source: the def_env write inside the bundle loop is indexed by the loop variable `project`', function () {
        var src = fs.readFileSync(HELPER_CMD_SOURCE, 'utf8');
        assert.match(src, /cmd\.bundlesByProject\[project\]\[bundle\]\.def_env\s*=\s*\(cmd\.params\.env\)/,
            '#B27: the def_env write must index bundlesByProject by the loop variable `project`');
        // negative pin: the buggy cmd.projectName index must NOT reappear on the def_env write
        assert.doesNotMatch(src, /cmd\.bundlesByProject\[cmd\.projectName\]\[bundle\]\.def_env/,
            '#B27: the def_env write must NOT index bundlesByProject by cmd.projectName (the crash)');
    });

    // --- Pure-logic replica of the per-bundle def_env write ----------------
    // No daemon / CmdHelper context (loadAssets needs the full CLI bootstrap to
    // run — same convention as section 18 / cmd-noninteractive-guards.test.js).
    // The replica mirrors helper.js:1310-1394 for the exists branch: iterate
    // bundlesByProject[project][bundle] and set that bundle's def_env. The only
    // variable is the index used for the write — cmd.projectName (old) vs the
    // loop variable project (fixed).

    function runLoop(cmd, indexKey /* 'projectName' | 'project' */) {
        for (var project in cmd.bundlesByProject) {       // helper.js:1310
            for (var bundle in cmd.bundlesByProject[project]) {  // helper.js:1321
                // exists branch (existsSync passed) — helper.js:1354..1388
                var idx = (indexKey === 'projectName') ? cmd.projectName : project;
                cmd.bundlesByProject[idx][bundle].def_env =
                    (cmd.params.env) ? cmd.params.env : cmd.defaultEnv;  // helper.js:1388
            }
        }
    }

    // Multi-project scenario: the alias being added ('newalias') has NO
    // bundlesByProject entry yet; an already-registered project ('other') owns
    // one bundle whose src passed the existsSync gate.
    function makeMultiProjectScenario() {
        return {
            projectName : 'newalias',
            params      : {},        // no --env
            defaultEnv  : 'dev',
            bundlesByProject: {
                other: { web: { src: 'src/web', exists: true } }
            }
        };
    }

    it('MEASUREMENT: the old cmd.projectName index throws on a multi-project add', function () {
        var cmd = makeMultiProjectScenario();
        assert.throws(function () {
            runLoop(cmd, 'projectName');
        }, /Cannot read properties of undefined \(reading 'web'\)/,
        'the old index dereferences bundlesByProject[newalias] === undefined');
    });

    it('fixed: the loop-variable index sets def_env on the iterated bundle without throwing', function () {
        var cmd = makeMultiProjectScenario();
        assert.doesNotThrow(function () {
            runLoop(cmd, 'project');
        });
        assert.equal(cmd.bundlesByProject.other.web.def_env, 'dev',
            "the 'other' project's bundle gets def_env from defaultEnv");
    });

    it('fixed: an explicit --env param wins over defaultEnv', function () {
        var cmd = makeMultiProjectScenario();
        cmd.params.env = 'production';
        runLoop(cmd, 'project');
        assert.equal(cmd.bundlesByProject.other.web.def_env, 'production');
    });

    it('fixed: the active project\'s own bundles are still written (single-project case unchanged)', function () {
        // alias == the only project; old and fixed are equivalent here because
        // project === cmd.projectName, which is why the bug stayed latent.
        var cmd = {
            projectName: 'solo', params: {}, defaultEnv: 'dev',
            bundlesByProject: { solo: { api: { src: 'src/api', exists: true } } }
        };
        runLoop(cmd, 'project');
        assert.equal(cmd.bundlesByProject.solo.api.def_env, 'dev');
    });
});


// 20 — isCmdConfigured/loadAssets: a corrupt projects.json registration is
// skipped / clean-exited, not turned into an emerg stack-dump + exit(1) (#B59)
//
// A corrupt registration in ~/.gina/projects.json (an empty/undefined `.path`,
// or a valid-length `.path` at a deleted dir) used to hard-exit EVERY gina
// command: the global `_()` path helper throws on undefined / '' / length<=2
// (helpers/path.js:67), and lib/generator.createFileFromDataSync does no
// `mkdir -p`, so a write into a gone dir ENOENTs — all caught by isCmdConfigured's
// try (:537-541 -> console.emerg(err.stack) + exit(1)). Three throw sites:
//   Path 1  the :262 registry loop `new _(cmd.projects[p].path).existsSync()`
//           — fires for EVERY command that runs isCmdConfigured, whether or not
//             it targets the corrupt project.
//   Path 3  the :366 targeted deref `_(cmd.projects[name].path, true)`
//           — fires when the command TARGETS an empty-path project.
//   Path 2  loadAssets' auto-manifest write into a gone project dir.
// The fix: pre-check + warn+skip the corrupt entry (Path 1, mirrors #B24's
// degrade-and-continue), treat an empty targeted path like an undefined one so
// it reaches the clean guard (Path 3), and clean-exit with an actionable message
// when the targeted project's dir is gone (Path 2). Verified live via the
// isolated-home A/B smoke (scratchpad/b59-smoke.sh): PRE-FIX all three cases
// stack-dump; FIXED, `bundle:list` renders (Path 1) and the targeted cases exit
// cleanly with "path no longer exists — re-add / remove --force".
describe('20 - corrupt projects.json registration is skipped/clean-exited, not fatal (#B59)', function () {

    var SRC = fs.readFileSync(HELPER_CMD_SOURCE, 'utf8');

    // ---- Path 1: the :262 registry loop (fires for EVERY command) -----------
    describe('20a - Path 1: :262 registry loop warns + skips a corrupt-path project', function () {

        it('source: a warn + continue guards the loop before new _(path).existsSync()', function () {
            var loopIdx = SRC.indexOf('for (let p in cmd.projects) {');
            var pushIdx = SRC.indexOf('cmd.projectsList[pIndex] = p;', loopIdx);
            assert.ok(loopIdx > -1 && pushIdx > loopIdx, 'the projects loop + push must exist');
            var body = SRC.slice(loopIdx, pushIdx);
            assert.match(body, /empty\/invalid path in projects\.json/, 'a #B59 skip warning must precede the push');
            assert.match(body, /continue\s*;/, 'a `continue` must skip the corrupt entry');
            // the pre-check mirrors helpers/path.js:67's reject set (undefined / '' / length<=2)
            assert.match(body, /_projectPath\.length\s*<=\s*2/, 'the guard mirrors path.js length<=2 threshold');
            assert.match(body, /new _\(_projectPath\)\.existsSync\(\)/, 'existsSync now runs on the pre-checked local, not a raw deref');
        });

        // Pure-logic replica of the loop-body decision (no daemon / CmdHelper).
        var existingDirs = ['/real/project/alpha'];
        function throwingUnderscore(p) {   // mirrors helpers/path.js:67 + PathObject.existsSync
            if (typeof p == 'undefined' || !p || p == '' || p.length <= 2) {
                throw new Error('This source cannot be used: `' + p + '`');
            }
            return { existsSync: function () { return existingDirs.indexOf(p) > -1; } };
        }
        // PRE-#B59 (buggy): unguarded new _(path) inside the loop.
        function loopOld(projects) {
            var list = [];
            for (var p in projects) {
                if (throwingUnderscore(projects[p].path).existsSync()) list.push(p);   // throws on ''
            }
            return list;
        }
        // POST-#B59 (fixed): pre-check the path, warn+skip the corrupt set.
        function loopFixed(projects, warn) {
            var list = [];
            for (var p in projects) {
                var pp = (projects[p] && typeof projects[p] == 'object') ? projects[p].path : null;
                if (typeof pp == 'undefined' || !pp || pp == '' || pp.length <= 2) { warn(p); continue; }
                if (throwingUnderscore(pp).existsSync()) list.push(p);
            }
            return list;
        }

        it('MEASUREMENT: the old loop throws on a single empty-path entry (would abort every command)', function () {
            assert.throws(function () {
                loopOld({ alpha: { path: '/real/project/alpha' }, bad: { path: '' } });
            }, /This source cannot be used/);
        });

        it('fixed: an empty-path entry is warned + skipped; valid existing projects still listed', function () {
            var warned = [];
            var list = loopFixed({
                alpha: { path: '/real/project/alpha' },   // valid + existing -> listed
                bad:   { path: '' },                       // corrupt -> warn + skip
                gone:  { path: '/real/project/gone' }      // valid length, dir gone -> silently skipped
            }, function (p) { warned.push(p); });
            assert.deepEqual(list, ['alpha'], 'only the existing valid project is listed');
            assert.deepEqual(warned, ['bad'], 'only the corrupt-path entry is warned (not the gone-dir one)');
        });

        it('fixed: undefined / null / too-short paths and a non-object entry are all skipped without throwing', function () {
            var warned = [];
            assert.doesNotThrow(function () {
                var list = loopFixed({
                    u: { path: undefined }, n: { path: null }, s: { path: '/a' }, bad: 42, ok: { path: '/real/project/alpha' }
                }, function (p) { warned.push(p); });
                assert.deepEqual(list, ['ok'], 'only the valid existing project is listed');
            });
            assert.deepEqual(warned.sort(), ['bad', 'n', 's', 'u'], 'every corrupt/unusable entry is warned+skipped');
        });
    });

    // ---- Path 3: the :366 targeted deref (empty path treated like undefined) --
    describe('20b - Path 3: :366 targeted deref treats an empty path like an undefined one', function () {

        it('source: the else-if requires a non-empty length>2 path before _(path)', function () {
            var idx = SRC.indexOf('cmd.projectLocation = _(cmd.projects[cmd.projectName].path, true);');
            assert.ok(idx > -1, 'the :366 deref must exist');
            var head = SRC.lastIndexOf('else if (', idx);
            var cond = SRC.slice(head, idx);
            assert.match(cond, /&&\s*cmd\.projects\[cmd\.projectName\]\.path\b/, 'the condition requires a truthy .path');
            assert.match(cond, /String\(cmd\.projects\[cmd\.projectName\]\.path\)\.length\s*>\s*2/, 'the condition requires length>2 (mirrors path.js)');
        });

        // Replica of the if / else-if / else projectLocation decision, from a cwd
        // whose basename ('elsewhere') != the project name ('proj') so the first
        // `if` is false and the else-if is the deciding branch.
        function makeResolver(useFixedCond) {
            return function (path, registered) {
                var cwd = '/cwd/elsewhere', name = 'proj';
                var projects = {}; if (registered) projects[name] = { path: path };
                var _ = function (p) {   // mirrors helpers/path.js:67
                    if (typeof p == 'undefined' || !p || p == '' || p.length <= 2) throw new Error('This source cannot be used: `' + p + '`');
                    return p;
                };
                if (typeof projects[name] != 'undefined'
                    && (useFixedCond
                        ? (projects[name].path && String(projects[name].path).length > 2)   // #B59 fixed
                        : (typeof projects[name].path != 'undefined'))) {                    // pre-#B59
                    return _(projects[name].path);
                }
                return _(cwd);   // cwd fallback (undefined path already lands here; empty now too)
            };
        }
        var resolveOld   = makeResolver(false);
        var resolveFixed = makeResolver(true);

        it('MEASUREMENT: the old condition throws on a targeted empty path', function () {
            assert.throws(function () { resolveOld('', true); }, /This source cannot be used/);
        });
        it('fixed: a targeted empty path falls through to the cwd fallback (no throw, like an undefined path)', function () {
            assert.equal(resolveFixed('', true), '/cwd/elsewhere');
        });
        it('fixed: a targeted valid path is still resolved', function () {
            assert.equal(resolveFixed('/real/project/proj', true), '/real/project/proj');
        });
    });

    // ---- Path 2: loadAssets auto-manifest write into a GONE dir --------------
    describe('20c - Path 2: loadAssets fails cleanly when the targeted project dir is gone', function () {

        it('source: an fs.existsSync guard with a clean message + exit precedes the manifest auto-write', function () {
            var guardIdx = SRC.indexOf('fs.existsSync(cmd.projects[cmd.projectName].path)');
            assert.ok(guardIdx > -1, 'the #B59 gone-dir fs.existsSync guard must exist');
            var noLongerIdx = SRC.indexOf('no longer exists', guardIdx);
            var exitIdx     = SRC.indexOf('return exit(', guardIdx);
            var writeIdx    = SRC.indexOf('lib.generator.createFileFromDataSync(', guardIdx);
            assert.ok(noLongerIdx > guardIdx, 'the guard emits a clean "no longer exists" message');
            assert.ok(exitIdx > guardIdx, 'the guard clean-exits (exit(1))');
            assert.ok(writeIdx > exitIdx, 'the auto-manifest write follows the guard (i.e. is skipped when the dir is gone)');
        });

        function throwingCreate() { var e = new Error("ENOENT: no such file or directory, open '<gone>/manifest.json'"); e.code = 'ENOENT'; throw e; }

        // PRE-#B59 (buggy): auto-write with no dir check -> ENOENT when the dir is gone.
        function manifestBranchOld(opts) {
            if (opts.manifestExists) return { action: 'read' };
            opts.create();   // createFileFromDataSync -> ENOENT throw for a gone dir
            return { action: 'wrote' };
        }
        // POST-#B59 (fixed): gone dir -> clean exit sentinel, no write.
        function manifestBranchFixed(opts) {
            if (opts.manifestExists) return { action: 'read' };
            if (!opts.dirExists) { opts.exit(); return { action: 'clean-exit' }; }   // #B59
            opts.create();
            return { action: 'wrote' };
        }

        it('MEASUREMENT: the old branch throws ENOENT when the project dir is gone', function () {
            assert.throws(function () {
                manifestBranchOld({ manifestExists: false, create: throwingCreate });
            }, /ENOENT/);
        });

        it('fixed: a gone project dir -> clean exit, no createFileFromDataSync call', function () {
            var created = 0, exited = 0;
            var out = manifestBranchFixed({
                manifestExists: false, dirExists: false,
                create: function () { created++; throwingCreate(); },
                exit: function () { exited++; }
            });
            assert.equal(out.action, 'clean-exit');
            assert.equal(created, 0, 'the auto-write is NOT attempted when the dir is gone');
            assert.equal(exited, 1, 'a clean exit is taken instead of the emerg stack-dump');
        });

        it('fixed: dir present + manifest missing -> the auto-write still runs (legit recreate, unchanged)', function () {
            var created = 0;
            var out = manifestBranchFixed({
                manifestExists: false, dirExists: true,
                create: function () { created++; }, exit: function () {}
            });
            assert.equal(out.action, 'wrote');
            assert.equal(created, 1, 'the manifest is recreated when the dir exists but the manifest is missing');
        });

        it('fixed: dir present + manifest present -> read (unchanged)', function () {
            var out = manifestBranchFixed({ manifestExists: true, dirExists: true, create: function () {}, exit: function () {} });
            assert.equal(out.action, 'read');
        });
    });
});

describe('21 - malformed @project token rejected loudly, not silently dropped (#B69)', function () {

    var SRC = fs.readFileSync(HELPER_CMD_SOURCE, 'utf8');

    it('source: a catch-all `else if ( /^\\@/.test(argv[i]) )` reject sits between the detection if and the bundles else-if', function () {
        var detectIdx  = SRC.indexOf('if ( /^\\@[a-z0-9_.]/.test(argv[i]) ) {');
        var rejectIdx  = SRC.indexOf('} else if ( /^\\@/.test(argv[i]) ) {');
        var bundlesIdx = SRC.indexOf('} else if (mightBeASomeBundle && !/^\\@/.test(argv[i]) && isValidName(argv[i]) ) {');
        assert.ok(detectIdx > -1, 'the first-char detection if must exist');
        assert.ok(rejectIdx > detectIdx, 'the #B69 catch-all @ reject must follow the detection if');
        assert.ok(bundlesIdx > rejectIdx, 'the bundles else-if must follow the reject (reject wins for @ tokens)');
    });

    it('source: the reject branch errors + exits + returns false (no silent skip)', function () {
        var rejectIdx  = SRC.indexOf('} else if ( /^\\@/.test(argv[i]) ) {');
        var bundlesIdx = SRC.indexOf('} else if (mightBeASomeBundle', rejectIdx);
        assert.ok(rejectIdx > -1 && bundlesIdx > rejectIdx, 'both branches must exist, reject first');
        var body = SRC.slice(rejectIdx, bundlesIdx);
        assert.match(body, /is not a valid project name/, 'the reject reuses the canonical message');
        assert.match(body, /console\.error\(errMsg\)/, 'the reject prints the message');
        assert.match(body, /exit\(errMsg\)/, 'the reject exits non-zero (exit(truthy) -> process.exit(1))');
        assert.match(body, /return false;/, 'the reject returns false');
        assert.doesNotMatch(body, /continue\s*;/, 'no silent skip in the reject branch');
    });

    // Pure-logic replica of the argv-loop token classification. `fixed` toggles
    // the #B69 catch-all reject so the MEASUREMENT test can prove the old shape.
    function classify(tokens, fixed) {
        var projectName = null, bundles = [], rejected = null;
        var mightBeASomeBundle = true;
        for (var i = 0; i < tokens.length; i++) {
            var t = tokens[i];
            if (/^\@[a-z0-9_.]/.test(t)) {
                mightBeASomeBundle = false;
                if (projectName === null) projectName = t.replace('@', '');
            } else if (fixed && /^\@/.test(t)) {
                rejected = t;   // #B69: loud reject; exit(errMsg) aborts the process
                break;
            } else if (mightBeASomeBundle && !/^\@/.test(t) && /^[a-z0-9_.]/.test(t.replace('@', ''))) {
                bundles.push(t);
            }
            // pre-#B69: an out-of-class @ token falls through ALL branches (silently dropped)
        }
        return { projectName: projectName, bundles: bundles, rejected: rejected };
    }

    it('MEASUREMENT: the old loop silently drops an out-of-class @ token (projectName stays null)', function () {
        var out = classify(['demo', '@Myproject'], false);
        assert.equal(out.rejected, null);
        assert.equal(out.projectName, null, 'the malformed token leaves projectName null -> cwd/all-projects fallback');
        assert.deepEqual(out.bundles, ['demo'], 'the command would proceed against the wrong scope with exit 0');
    });

    it('fixed: an uppercase-first @ token is rejected loudly', function () {
        var out = classify(['demo', '@Myproject'], true);
        assert.equal(out.rejected, '@Myproject');
    });

    it('fixed: a bare `@` and a symbol-first @ token are rejected loudly', function () {
        assert.equal(classify(['@'], true).rejected, '@');
        assert.equal(classify(['@-x'], true).rejected, '@-x');
    });

    it('fixed: a malformed SECOND @ token is rejected too (multi-project argv lists)', function () {
        var out = classify(['@myproject', '@Other'], true);
        assert.equal(out.projectName, 'myproject');
        assert.equal(out.rejected, '@Other');
    });

    it('fixed: in-class tokens untouched — lowercase project, digit-first version shape, bundles, flags', function () {
        var out = classify(['demo', '@myproject'], true);
        assert.equal(out.rejected, null);
        assert.equal(out.projectName, 'myproject');
        assert.deepEqual(out.bundles, ['demo']);
        assert.equal(classify(['@0.5.11'], true).projectName, '0.5.11', 'digit-first (version-shaped) tokens still detected in-class');
        var flags = classify(['--format=json'], true);
        assert.equal(flags.rejected, null, 'flags never hit the reject');
        assert.deepEqual(flags.bundles, [], 'flags are not bundles either');
    });
});
