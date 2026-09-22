'use strict';
/**
 * The boot seam that derives each bundle's login session lifetime policy from
 * its resolved `security.json`, once per bundle, onto the same config slot the
 * router reads at dispatch (`config[bundle][env]`).
 *
 * The arm that carries the weight is §02's malformed one. These two keys were
 * documented but uninterpreted before this release, so applications already have
 * values of their own shape sitting in them — expression strings, numbers,
 * whatever their own code evaluated. Beginning to interpret the key must not
 * turn an upgrade into a boot failure for them, so an unusable value is reported
 * and ignored and the bundle boots. That arm asserts the boot SUCCEEDS; asserting
 * only the warning would pass just as well if the boot had died.
 *
 * Each arm is a child process: Config's `initialized`/`instance` are module
 * statics and `resetContext()` require-caches projects.json, so two arms cannot
 * share one.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { spawnSync } = require('child_process');

var FW        = require('../fw');
var GINA_ROOT = path.resolve(FW, '..', '..');

var H = 60 * 60 * 1000;
var D = 24 * H;

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
        '  var srcRel = "src/" + b.name;',
        '  var relTarget = "releases/" + b.name + "/local/prod/0.0.1";',
        '  [path.join(PROJ, srcRel, "config"), path.join(PROJ, relTarget, "config")].forEach(function (d) {',
        '    fs.mkdirSync(d, { recursive: true });',
        '    fs.writeFileSync(path.join(d, "settings.json"), "{}");',
        '    fs.writeFileSync(path.join(d, "routing.json"), "{}");',
        '    fs.writeFileSync(path.join(d, "connectors.json"), "{}");',
        '    if (spec.security) { fs.writeFileSync(path.join(d, "security.json"), JSON.stringify(spec.security)); }',
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
        'var out = { policy: "PENDING", booted: false, ctor: null };',
        'var emitted = false;',
        'function emit() { if (emitted) { return; } emitted = true;',
        '  process.stdout.write("\\nSLRESULT " + JSON.stringify(out) + "\\n"); }',
        'process.on("exit", function () { emit(); });',
        'var opt = { env: "prod", scope: "local", projectName: spec.projName,',
        '            startingApp: spec.bundles[0].name, ginaPath: FW, executionPath: PROJ, task: "run" };',
        'var c = null;',
        'try { c = new Config(opt, true); out.ctor = "OK"; }',
        'catch (e) { out.ctor = "THREW: " + e.message; }',
        'var deadline = Date.now() + 20000;',
        'function poll() {',
        '  var b = spec.bundles[0].name;',
        '  var slot = c && c.envConf && c.envConf[b] && c.envConf[b].prod;',
        '  var ready = slot && typeof slot.sessionLifetime != "undefined";',
        '  if (!ready && Date.now() < deadline) { return setTimeout(poll, 25); }',
        '  if (ready) { out.policy = slot.sessionLifetime; out.booted = true; }',
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
 * @param {object} spec - `{ security }`; `security` omitted writes no file.
 * @returns {object} `{ policy, booted, ctor, stderr }`
 *
 * @example
 * var r = arm('declared', { security: { session: { expires: '3h' } } });
 * assert.equal(r.policy.expires, 10800000);
 */
function arm(id, spec) {
    var base = path.join(fs.realpathSync(os.tmpdir()),
                         'gina-sl-' + id + '-' + process.pid + '-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    var full = Object.assign({ fw: FW, ginaRoot: GINA_ROOT, home: base,
                               projName: 'sl' + id.replace(/[^a-z0-9]/g, ''),
                               bundles: [{ name: 'aaa' }] }, spec);
    var r = spawnSync(process.execPath, [RUNNER, JSON.stringify(full)],
                      { encoding: 'utf8', timeout: 60000,
                        env: Object.assign({}, process.env, { GINA_LOG_STDOUT: 'true' }) });
    var m = (r.stdout || '').match(/\nSLRESULT (.*)\n/);
    assert.ok(m, 'arm `' + id + '` produced no report'
        + '\n  status=' + r.status
        + '\n  stdout: ' + String(r.stdout || '').slice(-800)
        + '\n  stderr: ' + String(r.stderr || '').slice(-800));
    var out = JSON.parse(m[1]);
    out.stderr = String(r.stderr || '') + String(r.stdout || '');
    return out;
}

before(function () {
    RUNNER = path.join(fs.realpathSync(os.tmpdir()), 'gina-sl-runner-' + process.pid + '.js');
    fs.writeFileSync(RUNNER, runnerSource());
});

describe('session lifetime — the config boot seam', function () {

    it('a declared policy reaches the slot the router reads', function () {
        var r = arm('declared', { security: { session: { expires: '3h', remember: '15d' } } });
        assert.ok(r.booted, 'the bundle must boot: ' + r.stderr.slice(-600));
        assert.deepEqual(r.policy, { expires: 3 * H, remember: 15 * D });
    });

    it('CONTROL: a bundle with no security.json resolves to null, not an empty policy', function () {
        var r = arm('absent', {});
        assert.ok(r.booted, 'the bundle must boot: ' + r.stderr.slice(-600));
        assert.equal(r.policy, null,
            'null is what the router band short-circuits on — an object would cost a lookup per login');
    });

    it('a security.json with no session keys also resolves to null', function () {
        var r = arm('nokeys', { security: { jwt: { global: { secret: 'x' } } } });
        assert.ok(r.booted);
        assert.equal(r.policy, null, 'the rest of the file is the application\'s and must not opt it in');
    });

    it('an unusable value is reported and IGNORED — the bundle still boots', function () {
        // The shape a real application already had in this key before the
        // framework began interpreting it. Asserting `booted` is the point of
        // this arm: a warning assertion alone would pass on a dead boot too.
        var r = arm('malformed', { security: { session: { expires: '60000*15' } } });
        assert.ok(r.booted,
            'a value that predates this contract must never refuse the boot: ' + r.stderr.slice(-600));
        assert.equal(r.policy, null);
        assert.match(r.stderr, /session\.expires/, 'the warning must name the key');
        assert.match(r.stderr, /aaa/, 'the warning must name the bundle');
    });

    it('one unusable key does not discard its usable sibling', function () {
        var r = arm('partial', { security: { session: { expires: '60000*15', remember: '15d' } } });
        assert.ok(r.booted);
        assert.deepEqual(r.policy, { expires: null, remember: 15 * D });
    });
});
