'use strict';
/**
 * A bundle's resolved env configuration stays in V8 fast mode (phase-2 per-request trims, slice C2).
 *
 * The router copies the bundle's env configuration on every routed request
 * (`options.conf = Object.assign({}, conf)`), and every request reads it. `loadBundleConfig`
 * (core/config.js) left that object in V8 DICTIONARY mode, which made the copy cost ~20 µs per
 * request in the profile scene against ~0.2 µs for the same keys in fast mode. Two sites did it,
 * measured with `%HasFastProperties` probes along the load: `merge(files, conf[bundle][env])` pours
 * the env keys into the non-empty `files` target by keyed stores, and — once that alone is undone —
 * `delete conf[bundle][env].tmpSettingFileContent` (a delete of a non-last property) flips it back.
 * The delete is now a rebuild without that key (object rest), and `files` and `conf[bundle][env]`
 * are re-pointed together — they are the same object from the merge until `files = whisper(…)`.
 * Everything written to the object afterwards is a named store, which keeps it fast. The rebuild
 * runs before `secrets.resolve()`, which keys its resolved-paths WeakMap by this very object.
 *
 *  §01 source pins — comment-stripped: no delete of `tmpSettingFileContent` in code, the rebuild
 *      re-pointing both names, and the order rebuild → `self.envConf[bundle][env]` bind →
 *      `secrets.resolve(self.envConf[bundle][env], …)`.
 *  §02 live — a real Config boots in a child process started with `--allow-natives-syntax`
 *      (the #B610 scaffold, plus a `${secret:…}` placeholder in settings.json): the bundle's env
 *      configuration is in fast mode and carries no `tmpSettingFileContent`, `content` is its own
 *      object, and `lib/secrets` holds the resolved placeholder for the LIVE object (a rebuild after
 *      `resolve()` would orphan that entry). Controls: the boot is real, the secret was resolved.
 *
 * Under `bun test` a Config booted in a child process does not complete (the sibling child-boot
 * tests list theirs in test/bun-expected-failures.txt); §02 is not registered under Bun instead —
 * Bun's node:test shim ignores `describe`'s `skip` option, so a skipped describe still runs there.
 *
 * Seam: GINA_CONFIG_SRC=<file> runs every arm against that text (the child compiles it AS
 * core/config.js). Red-first against `git show HEAD:<fw>/core/config.js`: the §01 delete and
 * rebuild pins and §02's fast-mode arm read RED; the ordering arm, the no-key arm, the content arm,
 * the secrets arm and both controls stay GREEN.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { spawnSync } = require('child_process');

var FW        = require('../fw');
var GINA_ROOT = path.resolve(FW, '..', '..');
var REAL      = path.join(FW, 'core/config.js');
var SOURCE    = process.env.GINA_CONFIG_SRC || REAL;
var SRC       = fs.readFileSync(SOURCE, 'utf8');
var ACTIVE    = SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
    return !/^\s*\/\//.test(l);
}).join('\n');
var IS_BUN    = typeof(globalThis.Bun) != 'undefined';

function count(hay, needle) { return hay.split(needle).length - 1; }

var REBUILD = 'var { tmpSettingFileContent: _tmpSettingFileContent, ..._envRest } = conf[bundle][env];';
var REPOINT = 'files = conf[bundle][env] = _envRest;';
var BIND    = 'self.envConf[bundle][env] = conf[bundle][env];';
var RESOLVE = 'secrets.resolve(self.envConf[bundle][env], secretsBackend);';

describe('§01 source pins — the rebuild replaces the delete, before the secrets pass', function () {

    it('anti-vacuity: the strip kept the load and the secrets pass', function () {
        assert.ok(ACTIVE.length < SRC.length);
        assert.ok(ACTIVE.indexOf('var loadBundleConfig = function(') > -1);
        assert.equal(count(ACTIVE, BIND), 1, 'the envConf bind');
        assert.equal(count(ACTIVE, RESOLVE), 1, 'the secrets pass');
    });

    it('no delete of tmpSettingFileContent in code', function () {
        assert.equal(count(ACTIVE, 'delete conf[bundle][env].tmpSettingFileContent'), 0);
    });

    it('the rebuild re-points files and conf[bundle][env] together', function () {
        assert.equal(count(ACTIVE, REBUILD), 1, 'the rest rebuild');
        assert.equal(count(ACTIVE, REPOINT), 1, 'both names re-pointed');
        assert.ok(ACTIVE.indexOf(REPOINT) > ACTIVE.indexOf(REBUILD), 'the re-point follows the rebuild');
    });

    it('order: the rebuild, then the envConf bind, then the secrets pass', function () {
        var at = ACTIVE.indexOf(REPOINT) > -1 ? ACTIVE.indexOf(REPOINT) : ACTIVE.indexOf('tmpSettingFileContent');
        assert.ok(at > -1 && at < ACTIVE.indexOf(BIND), 'the object is final before it is bound to self.envConf');
        assert.ok(ACTIVE.indexOf(BIND) < ACTIVE.indexOf(RESOLVE), 'the secrets pass keys the bound object');
    });
});

// ─── live arm ────────────────────────────────────────────────────────────────
var RUNNER = null;

function runnerSource() {
    return [
        'require("v8").setFlagsFromString("--allow-natives-syntax");',
        'var HFP = new Function("o", "return %HasFastProperties(o)");',
        'var path = require("path"); var fs = require("fs"); var Module = require("module");',
        'var spec = JSON.parse(process.argv[2]);',
        'var FW = spec.fw, PROJ = path.join(spec.home, "proj"), GHOME = path.join(spec.home, ".gina");',
        'fs.mkdirSync(GHOME, { recursive: true });',
        'fs.mkdirSync(path.join(PROJ, "bundles"), { recursive: true });',
        'fs.mkdirSync(path.join(PROJ, ".gna"), { recursive: true });',
        'var b = "aaa", srcRel = "src/" + b, relTarget = "releases/" + b + "/local/prod/0.0.1";',
        'var settings = JSON.stringify({ c2: { token: "${secret:GINA_C2_TEST_SECRET}" } });',
        '[path.join(PROJ, srcRel, "config"), path.join(PROJ, relTarget, "config")].forEach(function (d) {',
        '  fs.mkdirSync(d, { recursive: true });',
        '  fs.writeFileSync(path.join(d, "settings.json"), settings);',
        '  fs.writeFileSync(path.join(d, "routing.json"), "{}");',
        '  fs.writeFileSync(path.join(d, "connectors.json"), "{}");',
        '});',
        'var manifest = { name: spec.projName, version: "0.0.1", bundles: {} };',
        'manifest.bundles[b] = { version: "0.0.1", tag: "001", src: srcRel, link: "bundles/" + b,',
        '                        releases: { local: { prod: { target: relTarget } } } };',
        'fs.writeFileSync(path.join(PROJ, "manifest.json"), JSON.stringify(manifest));',
        'var envJson = {}; envJson[b] = { prod: {} };',
        'fs.writeFileSync(path.join(PROJ, "env.json"), JSON.stringify(envJson));',
        'var portsRev = {}; portsRev[b + "@" + spec.projName] = { prod: { "http/1.1": { http: 3100 } } };',
        'fs.writeFileSync(path.join(GHOME, "ports.json"), "{}");',
        'fs.writeFileSync(path.join(GHOME, "ports.reverse.json"), JSON.stringify(portsRev));',
        'var projects = {}; projects[spec.projName] = { path: PROJ, def_env: "prod", def_scope: "local",',
        '  local_scope: "local", production_scope: "remote", dev_env: "dev", envs: ["dev","prod"],',
        '  scopes: ["local","remote"], def_protocol: "http/1.1", def_scheme: "http" };',
        'fs.writeFileSync(path.join(GHOME, "projects.json"), JSON.stringify(projects));',
        'fs.writeFileSync(path.join(PROJ, ".gna/locals.json"), JSON.stringify({ project: null,',
        '  paths: { project: spec.projName, gina: FW, lib: FW, root: PROJ,',
        '           env: path.join(PROJ, "env.json"), tmp: path.join(PROJ, "tmp") },',
        '  bundles: [b] }));',
        'process.gina = { GINA_DIR: spec.ginaRoot, GINA_CORE: path.join(FW, "core"), GINA_HOMEDIR: GHOME,',
        '                 GINA_FRAMEWORK_DIR: FW, NODE_ENV: "prod", NODE_ENV_IS_DEV: "false", GINA_LOG_STDOUT: "true" };',
        'require(path.join(FW, "helpers"));',
        'setContext("envs", ["dev","prod"]); setContext("scopes", ["local","remote"]);',
        'setPath("bundles", path.join(PROJ, "bundles")); setPath("project", PROJ);',
        // the seam: the source under test compiled AS core/config.js and put in the require cache
        'var REAL = path.join(FW, "core/config.js");',
        'if (spec.configSrc && spec.configSrc !== REAL) {',
        '  var m = new Module(REAL, null); m.filename = REAL; m.paths = Module._nodeModulePaths(path.dirname(REAL));',
        '  m._compile(fs.readFileSync(spec.configSrc, "utf8"), REAL); m.loaded = true; require.cache[REAL] = m;',
        '}',
        'var Config = require(REAL);',
        'var secrets = require(path.join(FW, "lib/secrets"));',
        'var out = { ctor: null, slot: false, fast: null, hasTmpKey: null, contentIsObject: null, contentIsSelf: null,',
        '            secretPaths: null, secretResolved: null, keys: null };',
        'var emitted = false;',
        'function emit() { if (emitted) { return; } emitted = true; process.stdout.write("\\nC2RESULT " + JSON.stringify(out) + "\\n"); }',
        'process.on("exit", function () { emit(); });',
        'var opt = { env: "prod", scope: "local", projectName: spec.projName,',
        '            startingApp: b, ginaPath: FW, executionPath: PROJ, task: "run" };',
        'var c = null;',
        'try { c = new Config(opt, true); out.ctor = "OK"; } catch (e) { out.ctor = "THREW: " + e.message; }',
        'var deadline = Date.now() + 20000;',
        'function poll() {',
        '  var slot = c && c.envConf && c.envConf[b] && c.envConf[b].prod;',
        '  if ((!slot || typeof(slot.content) == "undefined") && Date.now() < deadline) { return setTimeout(poll, 25); }',
        '  out.slot = !!slot;',
        '  if (slot) {',
        '    out.fast = HFP(slot); out.keys = Object.keys(slot).length;',
        '    out.hasTmpKey = Object.prototype.hasOwnProperty.call(slot, "tmpSettingFileContent");',
        '    out.contentIsObject = (slot.content !== null && typeof(slot.content) == "object");',
        '    out.contentIsSelf = (slot.content === slot);',
        '    out.secretPaths = secrets.getResolvedPaths(slot);',
        '    out.secretResolved = (slot.content && slot.content.settings && slot.content.settings.c2) ? slot.content.settings.c2.token : null;',
        '  }',
        '  emit(); process.exit(0);',
        '}',
        'setTimeout(poll, 25);'
    ].join('\n');
}

function arm() {
    var stamp = process.pid + '-' + Date.now();
    var base  = path.join(fs.realpathSync(os.tmpdir()), 'gina-c2-' + stamp);
    fs.mkdirSync(base, { recursive: true });
    var spec = { fw: FW, ginaRoot: GINA_ROOT, home: base, projName: 'c2shape', configSrc: SOURCE };
    var r = spawnSync(process.execPath, [RUNNER, JSON.stringify(spec)],
                      { encoding: 'utf8', timeout: 60000,
                        env: Object.assign({}, process.env, { GINA_LOG_STDOUT: 'true', GINA_C2_TEST_SECRET: 's3cr3t-c2-value' }) });
    var m = (r.stdout || '').match(/\nC2RESULT (.*)\n/);
    assert.ok(m, 'the live arm produced no report'
        + '\n  status=' + r.status + (r.signal ? ' signal=' + r.signal : '')
        + '\n  stdout: ' + String(r.stdout || '').slice(-800)
        + '\n  stderr: ' + String(r.stderr || '').slice(-800));
    var out = JSON.parse(m[1]);
    out.output = String(r.stderr || '') + String(r.stdout || '');
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    return out;
}

// not registered under Bun: a Config booted in a child process does not complete there, and Bun's
// node:test shim ignores `describe`'s `skip` option (measured — the arms ran and failed)
if (!IS_BUN) describe('§02 live — the booted env configuration', function () {

    var r = null;
    before(function () {
        RUNNER = path.join(fs.realpathSync(os.tmpdir()), 'gina-c2-runner-' + process.pid + '.js');
        fs.writeFileSync(RUNNER, runnerSource());
        r = arm();
    });

    it('control: the boot is real (a Config booted and resolved the bundle env, content included)', function () {
        assert.equal(r.ctor, 'OK', r.output.slice(-600));
        assert.equal(r.slot, true, 'envConf never populated: ' + r.output.slice(-600));
        assert.equal(r.contentIsObject, true);
    });

    it('control: the secrets pass resolved the placeholder', function () {
        assert.equal(r.secretResolved, 's3cr3t-c2-value', r.output.slice(-600));
    });

    it('the env configuration is in V8 fast mode', function () {
        assert.equal(r.fast, true, 'keys=' + r.keys);
    });

    it('it carries no tmpSettingFileContent, and content is its own object', function () {
        assert.equal(r.hasTmpKey, false);
        assert.equal(r.contentIsSelf, false);
    });

    it('lib/secrets holds the resolved paths for the LIVE object', function () {
        assert.ok(Array.isArray(r.secretPaths) && r.secretPaths.length >= 1, 'resolved paths: ' + JSON.stringify(r.secretPaths));
        assert.ok(r.secretPaths.some(function (p) { return /c2\.token$/.test(p); }), 'the placeholder path: ' + JSON.stringify(r.secretPaths));
    });
});
