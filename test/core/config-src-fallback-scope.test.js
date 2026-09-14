'use strict';
/**
 * #B542 — one config-less bundle poisoned every later bundle's config root, and
 * an aborted Config init then fabricated an instance from the global context.
 *
 * Mechanism (measured 2026-09-14 on fresh isolated scenes, one child process per
 * arm): inside `loadWithTemplate`'s per-app loop, a bundle whose release tree
 * carries no `config/` falls back to the source tree. That fallback did two
 * things that outlived the single bundle it was recovering:
 *
 *   1. `setPath('bundles', _(appSrcPath, true))` wrote that ONE bundle's own
 *      directory into the process-global `bundles` registry, which every other
 *      writer (gna.js, helpers/context.js) and reader (this loop's own
 *      `bundlesPath` initialiser, lib/proc.js's unmount) treats as the CONTAINER
 *      of all bundles. Nothing restored it.
 *   2. `newContent[app][env].bundlesPath = bundlesPath = ...` reassigned the
 *      function-scoped loop local that the guarded assignment hands to every app
 *      walked AFTER it.
 *
 * So in a non-dev env a later, perfectly healthy bundle silently loaded its
 * SOURCE config instead of its release config — or died on a spliced path,
 * because the container was derived by stripping `'/'+ app` with an UNANCHORED,
 * UNESCAPED RegExp keyed on the manifest KEY while the path carries the src
 * DIRNAME. When that splice aborted the init, `getInstance()` merged the global
 * context's `gina.config` — which on the worker branch is the Config CONSTRUCTOR
 * — and `lib/merge` returns a non-object source wholesale, so `Config.instance`
 * became the constructor, whose `.Env` is undefined: the reporter's opaque
 * `TypeError: Cannot set properties of undefined (setting 'parent')`.
 *
 * §01 — source pins: the global write is gone, the loop local is untouched, the
 *       container comes from path.dirname(), and the three aborts are named.
 * §02 — live arms: the per-app fallback, driven end to end. The CONTROL arm is
 *       what proves the fix cannot break a working boot.
 * §03 — live arms: the named refusals actually reach stderr.
 * §04 — live arm: getInstance() after an aborted init reports the retained
 *       reason instead of fabricating an instance.
 *
 * Every live arm is a child process: Config's `initialized`/`instance`/`initError`
 * are statics on the module, and `resetContext()` require-caches projects.json,
 * so two arms cannot share one process or one project path.
 *
 * Red-first: §02's stub-first arm read `<proj>/src` for the LATER bundle, §02's
 * key-mismatch arm died on `<proj>/src/realb/stubb/config` (the doubled segment),
 * §02's path-collision arm exited 1, and §04 threw the opaque TypeError — all
 * against the pre-fix bytes, with the control arm passing throughout.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { spawnSync } = require('child_process');

var FW        = require('../fw');
var GINA_ROOT = path.resolve(FW, '..', '..');
var SRC       = fs.readFileSync(path.join(FW, 'core/config.js'), 'utf8');

// Comment-stripped, so neither the #B542 rationale blocks (which quote the very
// call they removed) nor the commented-out legacy assignments a few lines above
// can satisfy an absence pin. Each absence assertion below is RAW-GUARDED: it
// also asserts the token is still present in SRC, so a strip that silently ate
// the whole file cannot make the pin pass vacuously.
var ACTIVE = SRC.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

var W_START = ACTIVE.indexOf('var loadWithTemplate = function(userConf, template, callback)');
var W_END   = ACTIVE.indexOf('}//EO for.', W_START);
var W       = ACTIVE.substring(W_START, W_END);

// ─── 01 — source pins ────────────────────────────────────────────────────────
describe('#B542 §01 — the src fallback is scoped to the bundle it recovers', function () {

    it('slice anchors resolve, and the comment strip kept the file (instrument control)', function () {
        assert.ok(W_START > -1, 'the loadWithTemplate declaration must exist');
        assert.ok(W_END > W_START, 'the per-app for-loop terminator must follow it');
        assert.ok(ACTIVE.length > SRC.length * 0.5,
            'the comment strip must leave the bulk of the file — otherwise every absence pin below passes vacuously');
    });

    it('the process-global `bundles` registry is NOT written from the per-app fallback', function () {
        assert.ok(SRC.indexOf("setPath('bundles'") > -1,
            'raw guard: the token must still appear in the file (inside the #B542 comment) — '
            + 'if it does not, this pin is testing nothing');
        assert.equal(W.indexOf("setPath('bundles'"), -1,
            'a per-app fallback that rewrites the container of ALL bundles outlives the one bundle it recovers');
    });

    it('the loop-local `bundlesPath` is read, never reassigned, inside the loop', function () {
        assert.ok(W.indexOf('bundlesPath       = getPath(\'bundles\')') > -1,
            'the loop local must still be initialised from the registry');
        assert.equal(W.indexOf('bundlesPath = appSrcPath'), -1,
            'reassigning the loop local leaks this app\'s value into every app walked after it');
        assert.equal(W.indexOf('= bundlesPath = '), -1,
            'no chained assignment may write through the loop local');
    });

    it('the per-app container comes from path.dirname(), not a RegExp strip', function () {
        assert.ok(W.indexOf('newContent[app][env].bundlesPath = path.dirname(appSrcPath);') > -1,
            'path.dirname answers "which directory contains this bundle?" without splicing');
        assert.equal(W.indexOf("appSrcPath.replace( new RegExp('/'+ app)"), -1,
            'an unanchored, unescaped RegExp keyed on the manifest KEY cannot strip a path built from the src DIRNAME');
        assert.ok(ACTIVE.indexOf("var path            = require('path');") > -1,
            'path.dirname needs the module required at the head');
    });

    it('the #B183 guarded assignment is untouched and still appears exactly once', function () {
        // Coupled pin: config-envjson-failfast.test.js §04a counts this exact
        // string too. The #B542 rewrite deliberately does not reintroduce it.
        assert.equal(W.split('newContent[app][env].bundlesPath = bundlesPath;').length - 1, 1,
            'the guarded assignment stays as-is; a second copy would make both files\' ordering pins ambiguous');
    });
});

describe('#B542 §01b — the config-directory aborts name the bundle', function () {

    var BARE = ['return callback(srcReadErr);',
                'return callback(configReadErr);',
                'return callback(sharedReadErr);'];

    BARE.forEach(function (bare) {
        var which = bare.match(/\((\w+)\)/)[1];
        it('the ' + which + ' abort is no longer bare', function () {
            assert.ok(SRC.indexOf(which) > -1,
                'raw guard: the catch binding must still exist, or this pin is testing nothing');
            assert.equal(ACTIVE.indexOf(bare), -1,
                'a bare callback(err) sends up a raw ENOENT naming neither the bundle nor the env');
        });
    });

    it('each named refusal carries the house wording and the stderr flush', function () {
        var refusals = ACTIVE.split('refusing to start').length - 1;
        assert.ok(refusals >= 5,
            'the two pre-existing refusals (#B132, #B181(b)) plus the three added here — got ' + refusals);
        ['config directory not readable at',
         'shared config directory not readable at',
         'no readable config/ in the release tree'].forEach(function (needle) {
            var at = ACTIVE.indexOf(needle);
            assert.ok(at > -1, 'the refusal message must exist: ' + needle);
            var region = ACTIVE.substring(at, at + 700);
            assert.ok(region.indexOf('fs.writeSync(2,') > -1,
                'the reason must survive process.exit() on an async pipe (#B181(b)): ' + needle);
            assert.match(region, /return callback\(new Error\(/,
                'config.js refuses through its callback, which init() turns into process.exit(1): ' + needle);
        });
    });

    it('the last-chance refusal reports BOTH trees it tried', function () {
        // `at` is asserted BEFORE it is used as a slice bound: substring(-1, n)
        // silently starts at 0, which made this arm match the WHOLE file and pass
        // against the pre-fix bytes — a control that could not fail.
        var at = ACTIVE.indexOf('no readable config/ in the release tree');
        assert.ok(at > -1, 'the last-chance refusal message must exist');
        var end = ACTIVE.indexOf('refusing to start', at);
        assert.ok(end > at, 'and must end in the house refusal wording');
        var stmt = ACTIVE.substring(at, end);
        assert.ok(stmt.indexOf('appPath') > -1, 'the release link is the first thing tried');
        assert.ok(stmt.indexOf('appSrcPath') > -1, 'the source tree is the second');
    });
});

describe('#B542 §01c — getInstance refuses instead of fabricating', function () {

    var G_START = ACTIVE.indexOf('this.getInstance = function(bundle)');
    var G_END   = ACTIVE.indexOf('this.getInstance = function(bundle)') > -1
                ? ACTIVE.indexOf('Config.instance.Host.setMaster(bundle);', G_START)
                : -1;
    var G       = ACTIVE.substring(G_START, G_END);

    it('slice anchors resolve (instrument control)', function () {
        assert.ok(G_START > -1, 'the getInstance declaration must exist');
        assert.ok(G_END > G_START, 'the setMaster call must follow it');
    });

    it('the init failure is RETAINED before the deferred exit', function () {
        var at = ACTIVE.indexOf('Config.initError = err;');
        assert.ok(at > -1, 'without a retained reason getInstance has nothing to report');
        var exitAt = ACTIVE.indexOf('process.exit(1);', at);
        assert.ok(exitAt > at && exitAt - at < 200,
            'it must be recorded on the same failure branch that schedules the exit');
    });

    it('getInstance reports the retained reason before touching Config.instance', function () {
        var guardAt = G.indexOf('Config.initError');
        var mergeAt = G.indexOf('merge( self, getContext(\'gina\').config, true )');
        assert.ok(guardAt > -1, 'the guard must exist');
        assert.ok(mergeAt > guardAt, 'it must precede the merge it protects');
        assert.match(G.substring(guardAt, mergeAt), /throw new Error\(/,
            'returning something-that-is-not-a-Config is what produced the opaque downstream TypeError');
    });

    it('a merge that does not yield an object is refused, not stored', function () {
        var mergeAt = G.indexOf('var _merged = merge(');
        assert.ok(mergeAt > -1, 'the merge result must be captured before assignment');
        var region = G.substring(mergeAt, G.indexOf('Config.instance = _merged;'));
        assert.match(region, /typeof\(_merged\) != 'object'/,
            'lib/merge returns a non-object source WHOLESALE — a function reaches here on the worker branch');
        assert.match(region, /throw new Error\(/);
    });
});

// ─── live arms ───────────────────────────────────────────────────────────────
// One child process per arm. The runner builds its own isolated home + project,
// boots Config in-process, and reports the resolved per-bundle config roots.
var RUNNER = null;

function runnerSource() {
    return [
        'var path = require("path"); var fs = require("fs");',
        'var spec = JSON.parse(process.argv[2]);',
        'var FW = spec.fw, PROJ = path.join(spec.home, "proj"), GHOME = path.join(spec.home, ".gina");',
        'fs.mkdirSync(GHOME, { recursive: true });',
        'fs.mkdirSync(path.join(PROJ, "bundles"), { recursive: true });',
        'fs.mkdirSync(path.join(PROJ, ".gna"), { recursive: true });',
        'var manifest = { name: spec.projName, version: "0.0.1", bundles: {} }, envJson = {}, portsRev = {}, port = 3100;',
        'spec.bundles.forEach(function (b) {',
        '  var srcRel = "src/" + (b.srcDir || b.name);',
        '  fs.mkdirSync(path.join(PROJ, srcRel, "config"), { recursive: true });',
        '  fs.writeFileSync(path.join(PROJ, srcRel, "config/settings.json"), "{}");',
        '  fs.writeFileSync(path.join(PROJ, srcRel, "config/routing.json"), "{}");',
        '  fs.writeFileSync(path.join(PROJ, srcRel, "config/connectors.json"), "{}");',
        '  if (b.noSrcConfig) { fs.rmSync(path.join(PROJ, srcRel, "config"), { recursive: true, force: true }); }',
        '  var relTarget = "releases/" + b.name + "/local/prod/0.0.1";',
        '  fs.mkdirSync(path.join(PROJ, relTarget), { recursive: true });',
        '  if (b.hasReleaseConfig !== false) {',
        '    fs.mkdirSync(path.join(PROJ, relTarget, "config"), { recursive: true });',
        '    fs.writeFileSync(path.join(PROJ, relTarget, "config/settings.json"), "{}");',
        '    fs.writeFileSync(path.join(PROJ, relTarget, "config/routing.json"), "{}");',
        '    fs.writeFileSync(path.join(PROJ, relTarget, "config/connectors.json"), "{}");',
        '  }',
        '  var entry = { version: "0.0.1", tag: "001", src: srcRel, link: "bundles/" + b.name,',
        '                releases: { local: { prod: { target: relTarget } } } };',
        '  if (b.scopes) { entry.scopes = b.scopes; }',
        '  manifest.bundles[b.name] = entry; envJson[b.name] = { prod: {} };',
        '  portsRev[b.name + "@" + spec.projName] = { prod: { "http/1.1": { http: port++ } } };',
        '});',
        'fs.writeFileSync(path.join(PROJ, "manifest.json"), JSON.stringify(manifest));',
        'fs.writeFileSync(path.join(PROJ, "env.json"), JSON.stringify(envJson));',
        'fs.writeFileSync(path.join(GHOME, "ports.json"), "{}");',
        'fs.writeFileSync(path.join(GHOME, "ports.reverse.json"), JSON.stringify(portsRev));',
        'var projects = {}; projects[spec.projName] = { path: PROJ, def_env: "prod", def_scope: "local",',
        '  local_scope: "local", production_scope: "remote", dev_env: "dev", envs: ["dev","prod"],',
        '  scopes: ["local","remote"], def_protocol: "http/1.1", def_scheme: "http" };',
        'fs.writeFileSync(path.join(GHOME, "projects.json"), JSON.stringify(projects));',
        'fs.writeFileSync(path.join(PROJ, ".gna/locals.json"), JSON.stringify({ project: null,',
        '  paths: { project: spec.projName, gina: FW, lib: FW, root: PROJ,',
        '           env: path.join(PROJ, "env.json"), tmp: path.join(PROJ, "tmp") },',
        '  bundles: spec.bundles.map(function (b) { return b.name; }) }));',
        '',
        'process.gina = { GINA_DIR: spec.ginaRoot, GINA_CORE: path.join(FW, "core"), GINA_HOMEDIR: GHOME,',
        '                 GINA_FRAMEWORK_DIR: FW, NODE_ENV: "prod", NODE_ENV_IS_DEV: "false", GINA_LOG_STDOUT: "true" };',
        'require(path.join(FW, "helpers"));',
        'setContext("envs", ["dev","prod"]); setContext("scopes", ["local","remote"]);',
        'setPath("bundles", path.join(PROJ, "bundles")); setPath("project", PROJ);',
        'var Config = require(path.join(FW, "core/config.js"));',
        'if (spec.seedContextConfig) { var g = getContext("gina") || {}; g.config = Config; setContext("gina", g); }',
        'var out = { bundlesPath: {}, registry: null, exitCode: null, getInstance: null, PROJ: PROJ, ctor: null };',
        'var emitted = false;',
        'function emit() { if (emitted) { return; } emitted = true;',
        '  process.stdout.write("\\nB542RESULT " + JSON.stringify(out) + "\\n"); }',
        'process.on("exit", function (code) { out.exitCode = code; emit(); });',
        '// NB: on the success path poll() emits first, so exitCode stays null there —',
        '// it is populated only when the abort beats us to the exit.',
        'var opt = { env: "prod", scope: "local", projectName: spec.projName,',
        '            startingApp: spec.bundles[0].name, ginaPath: FW, executionPath: PROJ, task: "run" };',
        'var c = null;',
        'try { c = new Config(opt, true); out.ctor = "OK"; }',
        'catch (e) { out.ctor = "THREW: " + e.message; }',
        'if (spec.callGetInstance) {',
        '  try { var gi = c.getInstance(spec.bundles[0].name);',
        '        out.getInstance = (gi === Config) ? "THE_CONSTRUCTOR" : typeof gi; }',
        '  catch (e) { out.getInstance = "THREW: " + e.message; }',
        '  emit(); process.exit(0);',
        '}',
        'var deadline = Date.now() + 20000;',
        'function poll() {',
        '  var ready = true;',
        '  spec.bundles.forEach(function (b) {',
        '    if (b.expectSkipped) { return; }',
        '    var slot = c && c.envConf && c.envConf[b.name] && c.envConf[b.name].prod;',
        '    if (!slot || typeof slot.bundlesPath == "undefined") { ready = false; }',
        '  });',
        '  if (!ready && Date.now() < deadline) { return setTimeout(poll, 25); }',
        '  spec.bundles.forEach(function (b) {',
        '    var slot = c && c.envConf && c.envConf[b.name] && c.envConf[b.name].prod;',
        '    out.bundlesPath[b.name] = slot ? (slot.bundlesPath || null) : null;',
        '  });',
        '  out.registry = String(getPath("bundles"));',
        '  emit(); process.exit(0);',
        '}',
        'setTimeout(poll, 25);'
    ].join('\n');
}

/**
 * Runs one arm in a child process and returns its report.
 *
 * @inner
 * @param {string} id      - Arm name, used for the scene directory.
 * @param {object} spec    - Arm spec: `bundles`, and optional `homePrefix`,
 *                           `seedContextConfig`, `callGetInstance`.
 * @returns {object} `{ bundlesPath, registry, exitCode, getInstance, PROJ, stderr }`
 *
 * @example
 * var r = arm('control', { bundles: [{ name: 'aaa' }, { name: 'zzz' }] });
 * assert.equal(r.bundlesPath.zzz, r.PROJ + '/bundles');
 */
function arm(id, spec) {
    var stamp = id + '-' + process.pid + '-' + Date.now();
    var base  = spec.homePrefix
              ? path.join(fs.realpathSync(os.tmpdir()), spec.homePrefix, 'gina-b542-' + stamp)
              : path.join(fs.realpathSync(os.tmpdir()), 'gina-b542-' + stamp);
    fs.mkdirSync(base, { recursive: true });
    var full = Object.assign({ fw: FW, ginaRoot: GINA_ROOT, home: base,
                               projName: 'b542' + id.replace(/[^a-z0-9]/g, '') }, spec);
    var r = spawnSync(process.execPath, [RUNNER, JSON.stringify(full)],
                      { encoding: 'utf8', timeout: 60000,
                        env: Object.assign({}, process.env, { GINA_LOG_STDOUT: 'true' }) });
    var m = (r.stdout || '').match(/\nB542RESULT (.*)\n/);
    assert.ok(m, 'arm `' + id + '` produced no report'
        + '\n  status=' + r.status + (r.signal ? ' signal=' + r.signal : '')
        + '\n  stdout: ' + String(r.stdout || '').slice(-800)
        + '\n  stderr: ' + String(r.stderr || '').slice(-800));
    var out = JSON.parse(m[1]);
    out.stderr = String(r.stderr || '') + String(r.stdout || '');
    return out;
}

before(function () {
    RUNNER = path.join(fs.realpathSync(os.tmpdir()), 'gina-b542-runner-' + process.pid + '.js');
    fs.writeFileSync(RUNNER, runnerSource());
});

// ─── 02 — the per-app fallback, driven ───────────────────────────────────────
describe('#B542 §02 — a config-less bundle does not move any other bundle\'s config root', function () {

    it('CONTROL: with every release tree intact, both bundles resolve to the link container', function () {
        var r = arm('control', { bundles: [{ name: 'aaa' }, { name: 'zzz' }] });
        assert.equal(r.bundlesPath.aaa, r.PROJ + '/bundles');
        assert.equal(r.bundlesPath.zzz, r.PROJ + '/bundles',
            'this arm must be able to fail — it is what proves the fix cannot break a working boot');
        assert.equal(r.registry, r.PROJ + '/bundles', 'the process-global registry is untouched');
    });

    it('a LATER bundle keeps its own config root when an earlier one falls back to src', function () {
        var r = arm('stubfirst', { bundles: [{ name: 'aaa', hasReleaseConfig: false }, { name: 'zzz' }] });
        assert.equal(r.bundlesPath.zzz, r.PROJ + '/bundles',
            'pre-fix this read <proj>/src: the healthy bundle silently loaded its SOURCE config');
        assert.equal(r.bundlesPath.aaa, r.PROJ + '/src',
            'the recovering bundle gets the container of the tree its config was actually read from');
    });

    it('the process-global `bundles` registry survives a fallback', function () {
        var r = arm('registry', { bundles: [{ name: 'aaa', hasReleaseConfig: false }, { name: 'zzz' }] });
        assert.equal(r.registry, r.PROJ + '/bundles',
            'pre-fix this read <proj>/src/aaa — one bundle\'s own directory, as the container of all of them');
    });

    it('a manifest key that differs from the src dirname does not splice the two together', function () {
        var r = arm('keymismatch', { bundles: [{ name: 'stubb', srcDir: 'realb', hasReleaseConfig: false },
                                               { name: 'zzz' }] });
        assert.equal(r.stderr.indexOf('/src/realb/stubb/'), -1,
            'pre-fix the unanchored RegExp failed to strip, producing <proj>/src/realb/stubb/config');
        // This shape still cannot resolve — the src fallback is the one path that
        // does not go through the key-named link, so a key that is not the dirname
        // has no container/key form. What #B542 changes is that it now says so.
        assert.match(r.stderr, /\[ stubb \]\[ prod \] config directory not readable at/,
            'the refusal must name the bundle and the env');
    });

    it('a project path that repeats the bundle name earlier is not truncated', function () {
        var r = arm('collision', { homePrefix: 'demo-x',
                                   bundles: [{ name: 'demo', hasReleaseConfig: false }, { name: 'zzz' }] });
        assert.equal(r.stderr.indexOf('refusing to start'), -1,
            'pre-fix the RegExp stripped `/demo` from `/demo-x` and the boot died on the truncated path');
        assert.equal(r.bundlesPath.demo, r.PROJ + '/src',
            'the recovering bundle resolves to its own source container, name collision or not');
        assert.equal(r.bundlesPath.zzz, r.PROJ + '/bundles');
    });

    // Regression guard, not a red-first arm: this safety property held before the
    // fix too (the scope skip precedes the fallback), and the fix must not lose it.
    it('CONTROL: a bundle opted out of the booting scope is skipped before the fallback can run', function () {
        var r = arm('scopes', { bundles: [{ name: 'zzz' },
                                          { name: 'aaa', hasReleaseConfig: false, scopes: ['remote'],
                                            expectSkipped: true }] });
        assert.equal(r.bundlesPath.zzz, r.PROJ + '/bundles');
        assert.equal(r.registry, r.PROJ + '/bundles');
        assert.equal(r.bundlesPath.aaa, null, 'the opted-out bundle is not configured at all');
    });
});

// ─── 03 — the named refusals, driven ─────────────────────────────────────────
describe('#B542 §03 — a config directory that cannot be read names the bundle', function () {

    it('neither tree readable: the refusal names BOTH the release link and the source tree', function () {
        var r = arm('noconfig', { bundles: [{ name: 'aaa', hasReleaseConfig: false, noSrcConfig: true },
                                            { name: 'zzz' }] });
        assert.match(r.stderr, /\[ aaa \]\[ prod \] no readable config\/ in the release tree \(/);
        assert.ok(r.stderr.indexOf('nor in the source tree (') > -1);
        assert.ok(r.stderr.indexOf('/bundles/aaa') > -1, 'the release link it tried first');
        assert.ok(r.stderr.indexOf('/src/aaa') > -1, 'the source tree it tried second');
        assert.ok(r.stderr.indexOf('refusing to start') > -1);
    });

    it('CONTROL: a healthy scene prints no refusal at all', function () {
        var r = arm('norefusal', { bundles: [{ name: 'aaa' }, { name: 'zzz' }] });
        assert.equal(r.stderr.indexOf('refusing to start'), -1,
            'this arm must be able to fail — a refusal that fires on a working boot is worse than the bug');
    });
});

// ─── 04 — getInstance after an aborted init ──────────────────────────────────
describe('#B542 §04 — getInstance reports the init failure instead of fabricating', function () {

    it('after an aborted init it throws the RETAINED reason, naming the bundle', function () {
        var r = arm('giabort', { seedContextConfig: true, callGetInstance: true,
                                 bundles: [{ name: 'stubb', srcDir: 'realb', hasReleaseConfig: false },
                                           { name: 'zzz' }] });
        assert.notEqual(r.getInstance, 'THE_CONSTRUCTOR',
            'pre-fix lib/merge returned the Config CONSTRUCTOR wholesale and it became Config.instance');
        assert.match(String(r.getInstance), /^THREW: \[ CONFIG \] initialisation failed — /);
        assert.match(String(r.getInstance), /\[ stubb \]\[ prod \]/,
            'the retained reason carries the named refusal, so one message explains the whole failure');
        assert.equal(String(r.getInstance).indexOf('Cannot set properties of undefined'), -1,
            'the opaque TypeError is what this replaces');
    });

    it('CONTROL: on a healthy scene getInstance still returns the instance', function () {
        var r = arm('giok', { seedContextConfig: true, callGetInstance: true,
                              bundles: [{ name: 'aaa' }, { name: 'zzz' }] });
        assert.equal(r.getInstance, 'object',
            'this arm must be able to fail — the guard must not refuse a boot that worked');
    });
});
