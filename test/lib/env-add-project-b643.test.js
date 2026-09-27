/**
 * #B643 — `gina env:add <env> @<project>` registers the environment, gives every
 * bundle of the project its own ports for it, writes its env.json block, prints
 * what it did and exits; a failure rolls every file back.
 *
 * `lib/cmd/env/add.js` declared its orchestrator and its projects.json writer under
 * the same name, and the later declaration won: the project form ran the writer
 * alone, so the environment was registered with no ports and no env.json block (it
 * could not start), nothing was printed, and nothing ended the process — a hang
 * wherever `bin/cli` holds its MQ listener (the #B648 class). Reviving the
 * orchestrator exposed three older defects, fixed with it:
 *  - the port scan was sized from the project's env list before the new env was on
 *    it, so the first bundle's last slot was written as port 0;
 *  - `getPortsList` read the registries through a cached `require()` that stayed
 *    stale after `setPorts` rewrote them whenever the home path holds a symlink (as
 *    macOS's temporary directory does), so every bundle got the same new ports;
 *  - rollback wrote back the in-memory projects, which by then listed the new env.
 *
 * The CLI runs in an isolated HOME under the system temporary directory, through a
 * symlink NAMED `gina` with its own MQ port, and the listener line is asserted as a
 * control (the #B648 test's shape).
 *
 * Red-first: on the pre-change handler arm 01 is killed at the spawn timeout, and
 * arms 02-04 fail.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var TMP       = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b643-'));
var FAKE_HOME = path.join(TMP, 'home');
var GINA_HOME = path.join(FAKE_HOME, '.gina');
var LINK      = path.join(TMP, 'gina');                 // named like an install
var CLI       = path.join(LINK, 'bin', 'cli');
var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var PROJECT = 'b643p' + Date.now();

/**
 * Run an offline gina CLI command through the `gina`-named link.
 *
 * @inner
 * @param {string[]} args - CLI arguments, starting with the task
 * @param {number} [timeout] - Spawn timeout in milliseconds
 * @returns {{ status: (number|null), signal: (string|null), out: string }}
 */
function runCli(args, timeout) {
    var r = spawnSync(process.execPath, [CLI].concat(args), {
        env: CHILD_ENV, cwd: FAKE_HOME, encoding: 'utf8', timeout: timeout || 20000
    });
    return { status: r.status, signal: r.signal, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Read a JSON file of the isolated gina home.
 *
 * @inner
 * @param {string} name - File name under ~/.gina
 * @returns {object}
 */
function home(name) {
    return JSON.parse(fs.readFileSync(path.join(GINA_HOME, name), 'utf8'));
}

/**
 * The ports each bundle of the test project holds for one env, from
 * ports.reverse.json.
 *
 * @inner
 * @param {string} env - Environment name
 * @returns {Object<string, number[]>} Bundle name to its ports
 */
function portsFor(env) {
    var reverse = home('ports.reverse.json'), out = {};
    for (var key in reverse) {
        if ( key.split('@')[1] !== PROJECT || !reverse[key][env] ) continue;
        var list = [];
        for (var protocol in reverse[key][env]) {
            for (var scheme in reverse[key][env][protocol]) list.push(reverse[key][env][protocol][scheme]);
        }
        out[key.split('@')[0]] = list;
    }
    return out;
}

/**
 * The env names each bundle has a block for in the project's env.json.
 *
 * @inner
 * @returns {Object<string, string[]>}
 */
function envJsonEnvs() {
    var envJson = JSON.parse(fs.readFileSync(path.join(FAKE_HOME, PROJECT, 'env.json'), 'utf8')), out = {};
    for (var bundle in envJson) out[bundle] = Object.keys(envJson[bundle]);
    return out;
}

/**
 * A free TCP port on the loopback, for the children's MQ listener.
 *
 * @inner
 * @returns {Promise<number>}
 */
function freePort() {
    return new Promise(function (resolve, reject) {
        var srv = require('net').createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', function () {
            var port = srv.address().port;
            srv.close(function () { resolve(port); });
        });
    });
}

var setupError = null;

before(async function () {
    CHILD_ENV.GINA_MQ_PORT = String(await freePort());
    fs.mkdirSync(FAKE_HOME, { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, '../..'), LINK);
    var steps = [
        ['project:add', '@' + PROJECT, '--path=' + path.join(FAKE_HOME, PROJECT)],
        ['bundle:add', 'demo', '@' + PROJECT],
        ['bundle:add', 'api', '@' + PROJECT]
    ];
    for (var i = 0; i < steps.length; i++) {
        var r = runCli(steps[i], 60000);
        if ( r.status !== 0 ) { setupError = steps[i].join(' ') + ' failed:\n' + r.out; return; }
    }
});

after(function () {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('01 - env:add <env> @<project> completes and exits', function () {

    it('registers the env, prints it, and exits 0 with the MQ listener bound', function () {
        assert.equal(setupError, null, setupError || '');
        var r = runCli(['env:add', 'staging', '@' + PROJECT]);
        assert.match(r.out, /is wait+ing for speakers on port/, 'CONTROL: the MQ listener started (the install shape):\n' + r.out);
        assert.equal(r.signal, null, 'the command hung and was killed:\n' + r.out);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);
        assert.match(r.out, /environment \[ staging \] created/, 'it says what it did');
        assert.ok(home('projects.json')[PROJECT].envs.indexOf('staging') > -1, 'staging is registered on the project');
    });
});

describe('02 - every bundle gets its own real ports and an env.json block', function () {

    it('assigns each bundle distinct non-zero ports for the new env', function () {
        var ports = portsFor('staging');
        assert.deepEqual(Object.keys(ports).sort(), ['api', 'demo'], 'both bundles have staging ports: ' + JSON.stringify(ports));
        var all = ports.demo.concat(ports.api);
        all.forEach(function (p) { assert.ok(Number.isInteger(p) && p > 0, 'a real port, got ' + p); });
        assert.equal(new Set(all).size, all.length, 'no port is shared between bundles: ' + JSON.stringify(ports));
        assert.equal(ports.demo.length, portsFor('dev').demo.length, 'as many ports as the dev env has');
        assert.doesNotMatch(fs.readFileSync(path.join(GINA_HOME, 'ports.json'), 'utf8'), /"undefined"/, 'no port was written as undefined');
    });

    it('adds a staging block for each bundle to env.json', function () {
        var envs = envJsonEnvs();
        assert.ok(envs.demo.indexOf('staging') > -1, 'demo: ' + JSON.stringify(envs));
        assert.ok(envs.api.indexOf('staging') > -1, 'api: ' + JSON.stringify(envs));
    });
});

describe('03 - a re-run changes nothing', function () {

    it('keeps the same ports and lists the env once', function () {
        var before = JSON.stringify(portsFor('staging'));
        var r = runCli(['env:add', 'staging', '@' + PROJECT]);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);
        assert.equal(JSON.stringify(portsFor('staging')), before, 'same ports');
        var envs = home('projects.json')[PROJECT].envs;
        assert.equal(envs.filter(function (e) { return e === 'staging'; }).length, 1, 'listed once: ' + JSON.stringify(envs));
    });
});

describe('04 - a failed port scan rolls every file back', function () {

    it('exits 1 and restores projects.json, env.json and ports.json', function () {
        // occupy the whole default scan window so the first bundle's scan fails
        var reversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var reverse = JSON.parse(fs.readFileSync(reversePath, 'utf8')), blocker = {};
        for (var p = 3100; p <= 3999; p++) blocker['s' + p] = p;
        reverse['blocker@elsewhere'] = { dev: { 'http/1.1': blocker } };
        fs.writeFileSync(reversePath, JSON.stringify(reverse, null, 2));

        var projectsBefore = fs.readFileSync(path.join(GINA_HOME, 'projects.json'), 'utf8');
        var envBefore      = fs.readFileSync(path.join(FAKE_HOME, PROJECT, 'env.json'), 'utf8');
        var portsBefore    = fs.readFileSync(path.join(GINA_HOME, 'ports.json'), 'utf8');

        var r = runCli(['env:add', 'broken', '@' + PROJECT]);
        assert.equal(r.signal, null, 'the command hung and was killed:\n' + r.out);
        assert.equal(r.status, 1, 'exit 1:\n' + r.out);
        assert.match(r.out, /could not complete env registration/);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(GINA_HOME, 'projects.json'), 'utf8')), JSON.parse(projectsBefore),
            'projects.json restored (the failed env is not registered)');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(FAKE_HOME, PROJECT, 'env.json'), 'utf8')), JSON.parse(envBefore), 'env.json restored');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(GINA_HOME, 'ports.json'), 'utf8')), JSON.parse(portsBefore), 'ports.json restored');
    });
});
