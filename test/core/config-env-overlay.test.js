'use strict';
/**
 * #D45 — an `<name>.<env>.json` overlay lost to its own base file on every key
 * both of them declared.
 *
 * Mechanism: inside `loadBundleConfig`'s config-files loop, the environment
 * version was read first and folded in with `merge(jsonFile, fileContent)` —
 * lib/merge is TARGET-wins, and the target there was the env content, so the
 * base file that landed afterwards overwrote it. The net effect was that
 * env-ONLY keys were added (nothing to lose to) while every actual OVERRIDE was
 * silently dropped — the one thing an overlay exists to do. Base-wins has held
 * since this loop's first cut, whose own comment reads "priority to env
 * version"; every reference page has promised override semantics throughout.
 *
 * The fix stashes the environment content and folds it in LAST, with lib/merge's
 * `override` flag, so the overlay wins. Two consequences worth stating because
 * they are observable: an env ARRAY now REPLACES the base array rather than
 * being unioned into it, and a `null` in the overlay overrides.
 *
 * Scope: this is the per-bundle config-files loop ONLY. The `settings.*`
 * template path (`loadWithTemplate`) is a separate mechanism with its own env
 * handling and is deliberately untouched — §01's count pin is sliced to the
 * loop for exactly that reason, since the same merge expression appears twice
 * more in that other function.
 *
 * §01 — source pins, comment-stripped and sliced to the loop.
 * §02 — live arms: the overlay driven end to end through a real Config boot.
 *       The CONTROL arm (no env file at all) is what proves the reorder cannot
 *       disturb a bundle that has no overlay.
 *
 * Red-first (measured against the pre-fix bytes in a detached worktree): §01's
 * three presence pins found nothing, §01's count pin read 2, and §02's overlay
 * arm reported k="base", arr=[1,2,3], nested.a="base" — while the control arm
 * passed throughout, so the instrument discriminates.
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

// Comment-stripped so the #D45 rationale block — which names the very merge it
// replaced — cannot satisfy a pin on its own. Every presence pin below is also
// slice-scoped, and the count pin is RAW-GUARDED by the slice anchors asserted
// in the instrument-control arm: a strip that ate the file would collapse the
// slice and fail there first, rather than passing a pin vacuously.
var ACTIVE = SRC.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

// The per-bundle config-files loop. NB the `let c` twin at the top of the file
// belongs to `loadWithTemplate`; anchoring on the `var c` terminator keeps this
// slice off it.
var L_START = ACTIVE.indexOf('for (; c < cLen; ++c) {');
var L_END   = ACTIVE.indexOf('} // EO for (var c = 0, cLen = configFiles.length; c < cLen; ++c)', L_START);
var L       = ACTIVE.substring(L_START, L_END);

// ─── 01 — source pins ────────────────────────────────────────────────────────
describe('#D45 §01 — the environment overlay is folded in last, with override', function () {

    it('slice anchors resolve and the comment strip kept the file (instrument control)', function () {
        assert.ok(L_START > -1, 'the config-files loop head must exist');
        assert.ok(L_END > L_START, 'the loop terminator must follow its head');
        assert.ok(ACTIVE.length > SRC.length * 0.5,
            'the comment strip must leave the bulk of the file — otherwise every pin below is meaningless');
        assert.ok(L.length > 2000, 'the slice must actually contain the loop body');
    });

    it('the environment content is stashed rather than merged where it is read', function () {
        assert.ok(L.indexOf('let envJsonFile = null;') > -1,
            'the stash must be declared per iteration, beside `jsonFile`');
        assert.ok(L.indexOf('envJsonFile = jsonFile;') > -1,
            'the env file read must hand its content to the stash instead of folding it in on the spot');
    });

    it('the stash is folded in with lib/merge\'s override flag', function () {
        assert.ok(L.indexOf('merge(fileContent, envJsonFile, true)') > -1,
            'the overlay must be the SOURCE and `override` must be on, or the base file wins again');
    });

    it('the base file is folded in exactly once inside the loop', function () {
        // Discriminating count: pre-fix this read 2 — the env read used the same
        // expression. One of those two is what the fix removed, so a regression
        // that reinstates the early merge shows up here even if the new fold is
        // still present. Sliced to the loop on purpose: `loadWithTemplate`
        // carries two more copies that are none of this fix's business.
        assert.equal(L.split('fileContent = merge(jsonFile, fileContent);').length - 1, 1,
            'the base fold belongs in the loop exactly once; a second copy is the pre-fix env merge returning');
    });

    it('the array-shape guard travels with the fold it protects', function () {
        var foldAt  = L.indexOf('fileContent = merge(fileContent, envJsonFile, true)');
        var guardAt = L.indexOf('if (Array.isArray(envJsonFile) && !Array.isArray(fileContent)');
        assert.ok(guardAt > -1, 'the overlay fold needs the same array-shape guard the base fold has');
        assert.ok(guardAt < foldAt, 'the guard must run before the fold it protects');
    });
});

// ─── live arms ───────────────────────────────────────────────────────────────
// One child process per arm: Config's `initialized`/`instance` are module
// statics and `resetContext()` require-caches projects.json, so two arms cannot
// share a process.
var RUNNER = null;

function runnerSource() {
    return [
        'var path = require("path"); var fs = require("fs");',
        'var spec = JSON.parse(process.argv[2]);',
        'var FW = spec.fw, PROJ = path.join(spec.home, "proj"), GHOME = path.join(spec.home, ".gina");',
        'fs.mkdirSync(GHOME, { recursive: true });',
        'fs.mkdirSync(path.join(PROJ, "bundles"), { recursive: true });',
        'fs.mkdirSync(path.join(PROJ, ".gna"), { recursive: true });',
        'var BASE = { k: "base", baseOnly: 1, arr: [1, 2], nested: { a: "base", b: "base" } };',
        'var OVER = { k: "env", envOnly: 1, arr: [3], nested: { a: "env" } };',
        'var manifest = { name: spec.projName, version: "0.0.1", bundles: {} }, envJson = {}, portsRev = {}, port = 3100;',
        'spec.bundles.forEach(function (b) {',
        '  var srcRel = "src/" + b.name;',
        '  var relTarget = "releases/" + b.name + "/local/prod/0.0.1";',
        '  [path.join(PROJ, srcRel, "config"), path.join(PROJ, relTarget, "config")].forEach(function (d) {',
        '    fs.mkdirSync(d, { recursive: true });',
        '    fs.writeFileSync(path.join(d, "settings.json"), "{}");',
        '    fs.writeFileSync(path.join(d, "routing.json"), "{}");',
        '    fs.writeFileSync(path.join(d, "connectors.json"), "{}");',
        '    fs.writeFileSync(path.join(d, "custom.json"), JSON.stringify(BASE));',
        '    if (spec.withEnvFile) { fs.writeFileSync(path.join(d, "custom.prod.json"), JSON.stringify(OVER)); }',
        '  });',
        '  manifest.bundles[b.name] = { version: "0.0.1", tag: "001", src: srcRel, link: "bundles/" + b.name,',
        '                               releases: { local: { prod: { target: relTarget } } } };',
        '  envJson[b.name] = { prod: {} };',
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
        'var out = { custom: null, exitCode: null, ctor: null, PROJ: PROJ };',
        'var emitted = false;',
        'function emit() { if (emitted) { return; } emitted = true;',
        '  process.stdout.write("\\nD45RESULT " + JSON.stringify(out) + "\\n"); }',
        'process.on("exit", function (code) { out.exitCode = code; emit(); });',
        'var opt = { env: "prod", scope: "local", projectName: spec.projName,',
        '            startingApp: spec.bundles[0].name, ginaPath: FW, executionPath: PROJ, task: "run" };',
        'var c = null;',
        'try { c = new Config(opt, true); out.ctor = "OK"; }',
        'catch (e) { out.ctor = "THREW: " + e.message; }',
        'var deadline = Date.now() + 20000;',
        'function poll() {',
        '  var b = spec.bundles[0].name;',
        '  var slot = c && c.envConf && c.envConf[b] && c.envConf[b].prod;',
        '  var got  = slot && slot.content && slot.content.custom;',
        '  if (!got && Date.now() < deadline) { return setTimeout(poll, 25); }',
        '  out.custom = got || null;',
        '  emit(); process.exit(0);',
        '}',
        'setTimeout(poll, 25);'
    ].join('\n');
}

/**
 * Runs one arm in a child process and returns its report.
 *
 * @inner
 * @param {string} id   - Arm name, used for the scene directory.
 * @param {object} spec - Arm spec: `bundles`, and optional `withEnvFile`.
 * @returns {object} `{ custom, exitCode, ctor, PROJ, stderr }`
 *
 * @example
 * var r = arm('overlay', { bundles: [{ name: 'aaa' }], withEnvFile: true });
 * assert.equal(r.custom.k, 'env');
 */
function arm(id, spec) {
    var stamp = id + '-' + process.pid + '-' + Date.now();
    var base  = path.join(fs.realpathSync(os.tmpdir()), 'gina-d45-' + stamp);
    fs.mkdirSync(base, { recursive: true });
    var full = Object.assign({ fw: FW, ginaRoot: GINA_ROOT, home: base,
                               projName: 'd45' + id.replace(/[^a-z0-9]/g, '') }, spec);
    var r = spawnSync(process.execPath, [RUNNER, JSON.stringify(full)],
                      { encoding: 'utf8', timeout: 60000,
                        env: Object.assign({}, process.env, { GINA_LOG_STDOUT: 'true' }) });
    var m = (r.stdout || '').match(/\nD45RESULT (.*)\n/);
    assert.ok(m, 'arm `' + id + '` produced no report'
        + '\n  status=' + r.status + (r.signal ? ' signal=' + r.signal : '')
        + '\n  stdout: ' + String(r.stdout || '').slice(-800)
        + '\n  stderr: ' + String(r.stderr || '').slice(-800));
    var out = JSON.parse(m[1]);
    out.stderr = String(r.stderr || '') + String(r.stdout || '');
    return out;
}

before(function () {
    RUNNER = path.join(fs.realpathSync(os.tmpdir()), 'gina-d45-runner-' + process.pid + '.js');
    fs.writeFileSync(RUNNER, runnerSource());
});

// ─── 02 — the overlay, driven ────────────────────────────────────────────────
describe('#D45 §02 — the environment overlay wins on every key it declares', function () {

    it('CONTROL: with no environment file, the base config is served unchanged', function () {
        var r = arm('control', { bundles: [{ name: 'aaa' }], withEnvFile: false });
        assert.ok(r.custom, 'the bundle must resolve its `custom` config: ' + r.stderr.slice(-600));
        assert.equal(r.custom.k, 'base');
        assert.equal(r.custom.baseOnly, 1);
        assert.deepEqual(r.custom.arr, [1, 2],
            'a bundle with no overlay must be untouched by the reorder');
        assert.deepEqual(r.custom.nested, { a: 'base', b: 'base' });
        assert.equal(typeof r.custom.envOnly, 'undefined');
    });

    it('a conflicting scalar takes the environment value', function () {
        var r = arm('scalar', { bundles: [{ name: 'aaa' }], withEnvFile: true });
        assert.ok(r.custom, 'the bundle must resolve its `custom` config: ' + r.stderr.slice(-600));
        assert.equal(r.custom.k, 'env',
            'pre-fix this read "base": the base file was folded in after the overlay, target-wins');
    });

    it('keys only one side declares survive from both sides', function () {
        var r = arm('union', { bundles: [{ name: 'aaa' }], withEnvFile: true });
        assert.equal(r.custom.baseOnly, 1, 'a base-only key must not be dropped by the overlay');
        assert.equal(r.custom.envOnly, 1, 'an env-only key must still be added');
    });

    it('a nested object merges key by key, the environment winning per key', function () {
        var r = arm('nested', { bundles: [{ name: 'aaa' }], withEnvFile: true });
        assert.deepEqual(r.custom.nested, { a: 'env', b: 'base' },
            'pre-fix `a` read "base"; `b` proves the merge is per-key, not a wholesale replace');
    });

    it('an environment array REPLACES the base array rather than being unioned into it', function () {
        var r = arm('array', { bundles: [{ name: 'aaa' }], withEnvFile: true });
        assert.deepEqual(r.custom.arr, [3],
            'pre-fix this read [1,2,3] — the observable behaviour change this fix ships');
    });
});
