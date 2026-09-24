'use strict';
/**
 * #B610 — every request re-read and re-parsed the framework's env template from disk.
 *
 * Mechanism (measured 2026-09-24 with a `NODE_OPTIONS=--require` preload counting
 * `fs.readFileSync` on a prod-built bundle): `new Config()` runs THREE times per
 * request — `hasViews` (core/server.js), `loadBundleConfiguration`
 * (core/server.js) and `resolveRouteConfig` (core/router.js) — and the
 * constructor evaluated
 * `template : requireJSON(getEnvVar('GINA_FRAMEWORK_DIR') + '/core/template/conf/env.json')`
 * for BOTH `this.Env` and `this.Scope` on every construction. `requireJSON` has
 * no cache (it is `fs.readFileSync` + comment strip + `JSON.parse` on every
 * call; its dev-mode `require.cache` eviction touches a cache it never
 * populates), so that was exactly six synchronous disk reads + parses per
 * request in every bundle — 27% of a trivial JSON route's CPU on the
 * 2026-09-24 bundle-to-bundle performance profile (finding F7).
 *
 * The fix reads the template once per process, lazily on the first
 * construction (`GINA_FRAMEWORK_DIR` is resolved then, never at module load),
 * and shares that object with every instance. Sharing is safe because the
 * template is read-only: every use in core/config.js is a field read
 * (`defEnv`, `defScope`, `defExt`, `registeredEnvs`, the `${bundle}` /
 * `${env}` lookups in `loadWithTemplate`); nothing assigns into it. §02's
 * accumulation control is what proves that claim on the REAL boot rather than
 * asserting it from a grep: after fifty per-request-style constructions, each
 * of which runs `getInstance()`'s `merge(self, gina.config, true)` against the
 * shared object, the template must still deep-equal a fresh parse.
 *
 * §01 — source pins, comment-stripped: both template sites go through the memo,
 *       and the file reads the template path exactly once (the memo body).
 * §02 — LIVE: a real Config boot in a child process with `fs.readFileSync`
 *       wrapped BEFORE core/config.js loads. One boot + fifty
 *       `new Config().getInstance()` (the router.js:56 shape) must read the
 *       template ONCE. Instrument control: the same wrapper must see the
 *       project's `projects.json` being read, or the counter is not counting.
 *
 * Red-first: run against the pre-fix bytes, §01's memo pins find nothing, the
 * path-count pin reads 2, and §02 counts 2 + 2×50 = 102 template reads while
 * the projects.json control and the boot itself pass — so the instrument
 * discriminates.
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

// Comment-stripped: the #B610 rationale block names the very expression it
// replaced, so an un-stripped pin could be satisfied by prose.
var ACTIVE = SRC.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

var TEMPLATE_READ = "requireJSON( getEnvVar('GINA_FRAMEWORK_DIR') +'/core/template/conf/env.json')";

// ─── 01 — source pins ────────────────────────────────────────────────────────
describe('#B610 §01 — the framework env template is read through one memo', function () {

    it('the comment strip kept the file (instrument control)', function () {
        assert.ok(SRC.indexOf(TEMPLATE_READ) > -1, 'the RAW source must still carry the template read expression');
        assert.ok(ACTIVE.length > SRC.length * 0.5, 'the strip must leave the bulk of the file');
    });

    it('the template path is read in exactly one place — the memo body', function () {
        // Pre-fix this read 2: one per sub-object (`this.Env`, `this.Scope`), both
        // evaluated on every construction.
        assert.equal(ACTIVE.split(TEMPLATE_READ).length - 1, 1,
            'the env template must be read from disk in ONE place; a second copy is a per-construction read returning');
    });

    it('both sub-objects take their template from the memo', function () {
        assert.ok(ACTIVE.indexOf('function getFrameworkEnvTemplate()') > -1, 'the memo accessor must exist');
        assert.equal(ACTIVE.split('template : getFrameworkEnvTemplate(),').length - 1, 2,
            '`this.Env` and `this.Scope` must BOTH take `template : getFrameworkEnvTemplate(),`');
    });

    it('the memo is lazy — nothing reads the template at module load', function () {
        var memoAt = ACTIVE.indexOf('function getFrameworkEnvTemplate()');
        var body   = ACTIVE.substring(memoAt, ACTIVE.indexOf('}', ACTIVE.indexOf(TEMPLATE_READ)) + 1);
        assert.ok(body.indexOf('if ( _frameworkEnvTemplate === null )') > -1 || body.indexOf('if (_frameworkEnvTemplate === null)') > -1,
            'the read must sit behind a null check so GINA_FRAMEWORK_DIR is resolved at first construction, not at require time');
    });
});

// ─── live arm ────────────────────────────────────────────────────────────────
// One child process: Config's `initialized`/`instance` are module statics.
var RUNNER = null;

function runnerSource() {
    return [
        'var path = require("path"); var fs = require("fs");',
        'var spec = JSON.parse(process.argv[2]);',
        'var FW = spec.fw, PROJ = path.join(spec.home, "proj"), GHOME = path.join(spec.home, ".gina");',
        // ── the instrument: wrap BEFORE anything framework-side loads ──
        'var TPL = "/core/template/conf/env.json";',
        'var counts = { template: 0, projects: 0, all: 0 };',
        'var origRead = fs.readFileSync;',
        'fs.readFileSync = function (p) {',
        '  counts.all++;',
        '  if (typeof p === "string") {',
        '    if (p.slice(-TPL.length) === TPL) { counts.template++; }',
        '    if (p.slice(-"projects.json".length) === "projects.json") { counts.projects++; }',
        '  }',
        '  return origRead.apply(this, arguments);',
        '};',
        'fs.mkdirSync(GHOME, { recursive: true });',
        'fs.mkdirSync(path.join(PROJ, "bundles"), { recursive: true });',
        'fs.mkdirSync(path.join(PROJ, ".gna"), { recursive: true });',
        'var b = "aaa", srcRel = "src/" + b, relTarget = "releases/" + b + "/local/prod/0.0.1";',
        '[path.join(PROJ, srcRel, "config"), path.join(PROJ, relTarget, "config")].forEach(function (d) {',
        '  fs.mkdirSync(d, { recursive: true });',
        '  fs.writeFileSync(path.join(d, "settings.json"), "{}");',
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
        '',
        'process.gina = { GINA_DIR: spec.ginaRoot, GINA_CORE: path.join(FW, "core"), GINA_HOMEDIR: GHOME,',
        '                 GINA_FRAMEWORK_DIR: FW, NODE_ENV: "prod", NODE_ENV_IS_DEV: "false", GINA_LOG_STDOUT: "true" };',
        'require(path.join(FW, "helpers"));',
        'setContext("envs", ["dev","prod"]); setContext("scopes", ["local","remote"]);',
        'setPath("bundles", path.join(PROJ, "bundles")); setPath("project", PROJ);',
        // counts taken from here on: the scaffold writes above never read the template
        'counts.template = 0; counts.projects = 0; counts.all = 0;',
        'var Config = require(path.join(FW, "core/config.js"));',
        'var out = { ctor: null, exitCode: null, afterBoot: null, afterExtras: null, extras: spec.extras,',
        '            routerShapeReturnedConfig: null, templateStillFresh: null, registeredEnvsLen: null,',
        '            defEnv: null, defScope: null, PROJ: PROJ };',
        'var emitted = false;',
        'function emit() { if (emitted) { return; } emitted = true;',
        '  process.stdout.write("\\nB610RESULT " + JSON.stringify(out) + "\\n"); }',
        'process.on("exit", function (code) { out.exitCode = code; emit(); });',
        'var opt = { env: "prod", scope: "local", projectName: spec.projName,',
        '            startingApp: b, ginaPath: FW, executionPath: PROJ, task: "run" };',
        'var c = null;',
        'try { c = new Config(opt, true); out.ctor = "OK"; }',
        'catch (e) { out.ctor = "THREW: " + e.message; }',
        'var deadline = Date.now() + 20000;',
        'function poll() {',
        '  var slot = c && c.envConf && c.envConf[b] && c.envConf[b].prod;',
        '  if (!slot && Date.now() < deadline) { return setTimeout(poll, 25); }',
        '  out.afterBoot = { template: counts.template, projects: counts.projects, all: counts.all };',
        // the per-request shape (core/router.js `resolveRouteConfig`), N times
        '  var last = null;',
        '  for (var i = 0; i < spec.extras; i++) { last = new Config().getInstance(); }',
        '  out.afterExtras = { template: counts.template, projects: counts.projects, all: counts.all };',
        // `getInstance()` with no bundle returns the resolved env configuration (what the
        // router consumes), never the Config object — so the shared template is probed
        // off a further construction, whose `.Env.template` IS the memo object post-fix.
        '  out.routerShapeReturnedConfig = !!(last && typeof last === "object" && last[b] && last[b].prod);',
        '  var probe = new Config();',
        // accumulation control: the shared template must be byte-for-byte what a fresh parse gives
        '  var fresh = requireJSON(FW + TPL);',
        '  out.templateStillFresh = ( JSON.stringify(probe.Env.template) === JSON.stringify(fresh) )',
        '                        && ( JSON.stringify(probe.Scope.template) === JSON.stringify(fresh) );',
        '  out.registeredEnvsLen = probe.Env.template.registeredEnvs ? probe.Env.template.registeredEnvs.length : null;',
        '  out.defEnv = probe.Env.template.defEnv; out.defScope = probe.Scope.template.defScope;',
        '  emit(); process.exit(0);',
        '}',
        'setTimeout(poll, 25);'
    ].join('\n');
}

/**
 * Runs the live arm in a child process and returns its report.
 *
 * @inner
 * @param {number} extras - How many per-request-style constructions to run after the boot.
 * @returns {object} the child's `B610RESULT` payload plus captured output
 *
 * @example
 * var r = arm(50);
 * assert.equal(r.afterExtras.template, 1);
 */
function arm(extras) {
    var stamp = process.pid + '-' + Date.now();
    var base  = path.join(fs.realpathSync(os.tmpdir()), 'gina-b610-' + stamp);
    fs.mkdirSync(base, { recursive: true });
    var spec = { fw: FW, ginaRoot: GINA_ROOT, home: base, projName: 'b610memo', extras: extras };
    var r = spawnSync(process.execPath, [RUNNER, JSON.stringify(spec)],
                      { encoding: 'utf8', timeout: 60000,
                        env: Object.assign({}, process.env, { GINA_LOG_STDOUT: 'true' }) });
    var m = (r.stdout || '').match(/\nB610RESULT (.*)\n/);
    assert.ok(m, 'the live arm produced no report'
        + '\n  status=' + r.status + (r.signal ? ' signal=' + r.signal : '')
        + '\n  stdout: ' + String(r.stdout || '').slice(-800)
        + '\n  stderr: ' + String(r.stderr || '').slice(-800));
    var out = JSON.parse(m[1]);
    out.output = String(r.stderr || '') + String(r.stdout || '');
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    return out;
}

before(function () {
    RUNNER = path.join(fs.realpathSync(os.tmpdir()), 'gina-b610-runner-' + process.pid + '.js');
    fs.writeFileSync(RUNNER, runnerSource());
});

describe('#B610 §02 — one boot plus fifty per-request constructions read the template once', function () {
    var r = null;
    before(function () { r = arm(50); });

    it('the boot is real (a Config booted and resolved the bundle env)', function () {
        var payload = JSON.stringify(Object.assign({}, r, { output: undefined }));
        assert.equal(r.ctor, 'OK', r.output.slice(-600));
        assert.ok(r.afterBoot !== null, 'envConf never populated: ' + r.output.slice(-600));
        assert.equal(r.defEnv, 'dev', 'the template must still supply defEnv through the shared object — payload: ' + payload);
        assert.equal(r.defScope, 'local', 'the template must still supply defScope through the shared object — payload: ' + payload);
    });

    it('the counter counts (instrument control): projects.json was read during the boot', function () {
        assert.ok(r.afterBoot.projects >= 1, 'the fs.readFileSync wrapper must see the boot reading projects.json, or every count below is meaningless');
        assert.ok(r.afterBoot.all > r.afterBoot.projects, 'the boot reads more than one file');
    });

    it('the boot itself reads the template exactly once', function () {
        // pre-fix: 2 (Env + Scope, each its own requireJSON)
        assert.equal(r.afterBoot.template, 1, 'the first construction must read the env template ONCE — the memo\'s single fill');
    });

    it('fifty per-request constructions read it zero more times', function () {
        // pre-fix: 2 per construction → 100 more
        assert.equal(r.afterExtras.template - r.afterBoot.template, 0,
            'per-request `new Config().getInstance()` must never touch the disk for the framework template (pre-fix: 2 reads each)');
        assert.equal(r.routerShapeReturnedConfig, true,
            'the router-shaped call must still hand back the bundle\'s resolved env configuration');
    });

    it('the shared template is not mutated by the per-request merges (accumulation control)', function () {
        var payload = JSON.stringify(Object.assign({}, r, { output: undefined }));
        assert.equal(r.templateStillFresh, true,
            'after 50 getInstance() merges the shared template must deep-equal a fresh parse — a write into it would accumulate across requests — payload: ' + payload);
    });
});
