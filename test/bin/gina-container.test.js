var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var CONTAINER_SOURCE = path.resolve(__dirname, '../../bin/gina-container');


// ---------------------------------------------------------------------------
// Helpers — isolate the logic functions from bin/gina-container without
// executing the spawn.  We replicate only the pure-logic parts here.
// ---------------------------------------------------------------------------

/**
 * Replica of the appPath resolution logic in gina-container (step 6).
 * Mirrors isRealApp() from lib/cmd/bundle/start.js.
 */
function resolveAppPath(projectRoot, bundleName, scope, env, isDev, manifest) {
    var bundlePkg = manifest.bundles[bundleName];
    if (!bundlePkg) {
        throw new Error('bundle `' + bundleName + '` not found in manifest.json');
    }
    if (typeof(bundlePkg.version) == 'undefined' && typeof(bundlePkg.tag) != 'undefined') {
        bundlePkg.version = bundlePkg.tag;
    }
    if (bundlePkg.src && isDev) {
        return projectRoot + '/' + bundlePkg.src + '/index.js';
    }
    return projectRoot + '/releases/' + bundleName + '/' + scope + '/' + env + '/' + bundlePkg.version + '/index.js';
}

/**
 * Replica of the context JSON build in gina-container (step 7).
 */
function buildCtxJSON(ginaPath, frameworkPath, envVars, launcherPid) {
    return JSON.stringify({
        paths: {
            gina: {
                root:    ginaPath,
                core:    frameworkPath + '/core',
                lib:     frameworkPath + '/lib',
                helpers: frameworkPath + '/helpers'
            },
            framework: frameworkPath,
            node:      process.argv[0]
        },
        envVars:     envVars,
        processList: [],
        ginaProcess: launcherPid,
        debugPort:   null
    });
}


// ---------------------------------------------------------------------------
// 01 — Source: gina-container exists and is executable
// ---------------------------------------------------------------------------
describe('01 - gina-container: file exists and is executable', function() {

    it('bin/gina-container file exists', function() {
        assert.ok(
            fs.existsSync(CONTAINER_SOURCE),
            'expected bin/gina-container to exist'
        );
    });

    it('bin/gina-container has execute permission', function() {
        var stat = fs.statSync(CONTAINER_SOURCE);
        var isExecutable = !!(stat.mode & 0o111);
        assert.ok(isExecutable, 'expected bin/gina-container to be executable (chmod +x)');
    });

    it('bin/gina-container has a node shebang', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /^#!\/usr\/bin\/env node/.test(src),
            'expected #!/usr/bin/env node shebang on first line'
        );
    });

    it('gina-container is registered in package.json bin', function() {
        var pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
        assert.ok(
            typeof pkg.bin['gina-container'] === 'string',
            'expected gina-container entry in package.json bin'
        );
        assert.ok(
            pkg.bin['gina-container'] === './bin/gina-container' ||
            pkg.bin['gina-container'] === 'bin/gina-container',
            'expected gina-container bin path to be bin/gina-container or ./bin/gina-container'
        );
    });

});


// ---------------------------------------------------------------------------
// 02 — Source: required structural patterns in gina-container
// ---------------------------------------------------------------------------
describe('02 - gina-container: source structure', function() {

    it('spawns with detached: false', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /detached\s*:\s*false/.test(src),
            'expected detached: false in spawn call'
        );
    });

    it('uses stdio: inherit', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /stdio\s*:\s*['"]inherit['"]/.test(src),
            'expected stdio: \'inherit\' in spawn call'
        );
    });

    it('SIGTERM handler forwards to child', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /process\.on\('SIGTERM'/.test(src),
            'expected process.on(\'SIGTERM\') handler'
        );
        assert.ok(
            /child\.kill\(/.test(src),
            'expected child.kill() call in signal handler'
        );
    });

    it('SIGINT handler is also wired', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /process\.on\('SIGINT'/.test(src),
            'expected process.on(\'SIGINT\') handler'
        );
    });

    it('exits with child exit code on child exit', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /child\.on\('exit'/.test(src),
            'expected child.on(\'exit\') handler'
        );
        assert.ok(
            /process\.exit\(/.test(src),
            'expected process.exit() called in child exit handler'
        );
    });

    it('context JSON includes paths.gina.root', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /paths\s*:/.test(src) && /gina\s*:/.test(src) && /root\s*:/.test(src),
            'expected paths.gina.root in context JSON construction'
        );
    });

    it('context JSON includes envVars from process.gina', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /envVars\s*:\s*process\.gina/.test(src),
            'expected envVars: process.gina in context JSON'
        );
    });

    it('context JSON includes processList, ginaProcess, debugPort', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(/processList/.test(src), 'expected processList in context JSON');
        assert.ok(/ginaProcess/.test(src), 'expected ginaProcess in context JSON');
        assert.ok(/debugPort/.test(src),   'expected debugPort in context JSON');
    });

    it('reads settings from ~/.gina/<shortVersion>/settings.json', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /settings\.json/.test(src),
            'expected settings.json path read'
        );
    });

    it('loads projects.json from ~/.gina/', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /projects\.json/.test(src),
            'expected projects.json loaded from ~/.gina/'
        );
    });

    it('resolves appPath from manifest.json', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /manifest\.json/.test(src),
            'expected manifest.json read for appPath resolution'
        );
    });

    it('fallback appPath uses bundles/<bundle>/index.js', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /bundles.*index\.js/.test(src),
            'expected fallback to bundles/<bundle>/index.js'
        );
    });

});


// ---------------------------------------------------------------------------
// 03 — Logic: appPath resolution (isolated, no filesystem)
// ---------------------------------------------------------------------------
describe('03 - gina-container: appPath resolution logic', function() {

    it('dev mode uses src path', function() {
        var manifest = { bundles: { api: { src: 'src/api', version: '1.0.0' } } };
        var result = resolveAppPath('/app', 'api', 'local', 'dev', true, manifest);
        assert.equal(result, '/app/src/api/index.js');
    });

    it('non-dev mode uses releases path', function() {
        var manifest = { bundles: { api: { version: '1.0.0' } } };
        var result = resolveAppPath('/app', 'api', 'local', 'production', false, manifest);
        assert.equal(result, '/app/releases/api/local/production/1.0.0/index.js');
    });

    it('tag is promoted to version when version is absent', function() {
        var manifest = { bundles: { api: { tag: '2.0.0' } } };
        var result = resolveAppPath('/app', 'api', 'local', 'production', false, manifest);
        assert.equal(result, '/app/releases/api/local/production/2.0.0/index.js');
    });

    it('throws when bundle is not in manifest', function() {
        var manifest = { bundles: {} };
        assert.throws(
            function() { resolveAppPath('/app', 'missing', 'local', 'dev', true, manifest); },
            /not found in manifest/
        );
    });

    it('src present but isDev=false uses releases path', function() {
        var manifest = { bundles: { api: { src: 'src/api', version: '0.5.0' } } };
        var result = resolveAppPath('/app', 'api', 'container', 'production', false, manifest);
        assert.equal(result, '/app/releases/api/container/production/0.5.0/index.js');
    });

});


// ---------------------------------------------------------------------------
// 04 — Logic: context JSON structure (isolated, no filesystem)
// ---------------------------------------------------------------------------
describe('04 - gina-container: context JSON structure', function() {

    it('paths.gina.root equals ginaPath', function() {
        var ctx = JSON.parse(buildCtxJSON('/gina', '/gina/framework/v1', {}, 42));
        assert.equal(ctx.paths.gina.root, '/gina');
    });

    it('paths.gina.core equals frameworkPath/core', function() {
        var ctx = JSON.parse(buildCtxJSON('/gina', '/gina/framework/v1', {}, 42));
        assert.equal(ctx.paths.gina.core, '/gina/framework/v1/core');
    });

    it('paths.framework equals frameworkPath', function() {
        var ctx = JSON.parse(buildCtxJSON('/gina', '/gina/framework/v1', {}, 42));
        assert.equal(ctx.paths.framework, '/gina/framework/v1');
    });

    it('envVars is the object passed in', function() {
        var envVars = { GINA_VERSION: '0.1.6-alpha.177', GINA_DIR: '/gina' };
        var ctx = JSON.parse(buildCtxJSON('/gina', '/gina/framework/v1', envVars, 42));
        assert.deepEqual(ctx.envVars, envVars);
    });

    it('processList is an empty array', function() {
        var ctx = JSON.parse(buildCtxJSON('/gina', '/gina/framework/v1', {}, 42));
        assert.deepEqual(ctx.processList, []);
    });

    it('ginaProcess is the launcher PID', function() {
        var ctx = JSON.parse(buildCtxJSON('/gina', '/gina/framework/v1', {}, 99));
        assert.equal(ctx.ginaProcess, 99);
    });

    it('debugPort is null', function() {
        var ctx = JSON.parse(buildCtxJSON('/gina', '/gina/framework/v1', {}, 42));
        assert.equal(ctx.debugPort, null);
    });

    it('context JSON is valid JSON', function() {
        assert.doesNotThrow(function() {
            JSON.parse(buildCtxJSON('/gina', '/gina/framework/v1', { GINA_VERSION: '1.0' }, 1));
        });
    });

});


// ---------------------------------------------------------------------------
// 05 — Source: def_framework sync block is present in gina-container (§3b)
// ---------------------------------------------------------------------------
describe('05 - gina-container: def_framework sync block (§3b)', function() {

    it('def_framework sync block is present in source', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /def_framework/.test(src),
            'expected def_framework sync block in gina-container'
        );
    });

    it('compares _mainData.def_framework !== version before updating', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /_mainData\.def_framework\s*!==\s*version/.test(src),
            'expected `_mainData.def_framework !== version` guard in gina-container §3b'
        );
    });

    it('reads main.json from the gina home directory', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /main\.json/.test(src),
            'expected main.json path in gina-container def_framework sync'
        );
    });

    it('updates frameworks[shortVersion] array when syncing', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /frameworks\[shortVersion\]/.test(src),
            'expected frameworks[shortVersion] update in gina-container §3b'
        );
    });

    it('writes the updated main.json via fs.writeFileSync', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /fs\.writeFileSync\(_mainJsonPath/.test(src),
            'expected fs.writeFileSync(_mainJsonPath...) in gina-container §3b'
        );
    });

    it('emits a stdout warning on sync error', function() {
        var src = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
        assert.ok(
            /could not sync def_framework/.test(src),
            'expected "could not sync def_framework" warning in gina-container §3b'
        );
    });

    it('pure logic: sync is skipped when def_framework already matches version', function() {
        var version = '0.3.0-alpha.1';
        var mainData = { def_framework: '0.3.0-alpha.1', frameworks: { '0.3': ['0.3.0-alpha.1'] } };
        var updated = false;
        if (mainData.def_framework !== version) {
            mainData.def_framework = version;
            updated = true;
        }
        assert.equal(updated, false);
        assert.equal(mainData.def_framework, '0.3.0-alpha.1');
    });

    it('pure logic: def_framework is updated when stale', function() {
        var version = '0.3.0-alpha.1';
        var shortVersion = '0.3';
        var mainData = { def_framework: '0.2.1-alpha.3', frameworks: { '0.2': ['0.2.1-alpha.3'] } };
        if (mainData.def_framework !== version) {
            mainData.def_framework = version;
            if (!mainData.frameworks) { mainData.frameworks = {}; }
            if (!mainData.frameworks[shortVersion]) { mainData.frameworks[shortVersion] = []; }
            if (mainData.frameworks[shortVersion].indexOf(version) < 0) {
                mainData.frameworks[shortVersion].push(version);
            }
        }
        assert.equal(mainData.def_framework, '0.3.0-alpha.1');
        assert.ok(mainData.frameworks['0.3'].indexOf('0.3.0-alpha.1') > -1);
    });

    it('pure logic: version is not duplicated when already in frameworks array', function() {
        var version = '0.3.0-alpha.1';
        var shortVersion = '0.3';
        var mainData = {
            def_framework: '0.2.1-alpha.3',
            frameworks: { '0.3': ['0.3.0-alpha.1'] }
        };
        if (mainData.def_framework !== version) {
            mainData.def_framework = version;
            if (!mainData.frameworks[shortVersion]) { mainData.frameworks[shortVersion] = []; }
            if (mainData.frameworks[shortVersion].indexOf(version) < 0) {
                mainData.frameworks[shortVersion].push(version);
            }
        }
        assert.equal(mainData.frameworks['0.3'].filter(function(v) { return v === version; }).length, 1);
    });

});
