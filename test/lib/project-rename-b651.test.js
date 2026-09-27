/**
 * #B651 — `gina project:rename @<old> @<new>` renames to a free name, refuses a
 * name or a directory that is already taken, and renames port entries exactly.
 *
 * The target check was inverted: the command renamed only when the new name was
 * ALREADY registered (running the rename onto another project) and refused every
 * free name as "already taken". The rename body behind it had two defects of its
 * own, which already fired on that path: it replaced `@<source>` across the whole
 * ports.reverse.json as a string, so another project whose name starts with the
 * source (`app2` for `app`) was renamed too, and it wrote the new ports.json value
 * one level too high (`ports[protocol][port]`), leaving the old value in place and a
 * stray key beside it.
 *
 * Every arm runs the CLI in an isolated HOME through a symlink NAMED `gina` with its
 * own MQ port (the #B648 test's shape), so it never touches the real ~/.gina.
 *
 * Red-first: on the pre-change handler arms 01, 02, 03 and 04 fail (01: the free
 * name is refused; 02: no rename happened; 03: the rename onto a registered
 * project goes through; 04: refused for the wrong reason, "already taken").
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var TMP       = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b651-'));
var FAKE_HOME = path.join(TMP, 'home');
var GINA_HOME = path.join(FAKE_HOME, '.gina');
var LINK      = path.join(TMP, 'gina');                 // named like an install
var CLI       = path.join(LINK, 'bin', 'cli');
var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

/**
 * Run an offline gina CLI command through the `gina`-named link.
 *
 * @inner
 * @param {string[]} args - CLI arguments, starting with the task
 * @returns {{ status: (number|null), signal: (string|null), out: string }}
 */
function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), {
        env: CHILD_ENV, cwd: FAKE_HOME, encoding: 'utf8', timeout: 60000
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
 * The raw bytes of the three registry files, to compare before and after a refusal.
 *
 * @inner
 * @returns {string}
 */
function registryBytes() {
    return ['projects.json', 'ports.json', 'ports.reverse.json'].map(function (f) {
        return fs.readFileSync(path.join(GINA_HOME, f), 'utf8');
    }).join('\n---\n');
}

/**
 * Every ports.json value, and any value found one level too high (a string where a
 * scheme object belongs).
 *
 * @inner
 * @returns {{ values: string[], stray: string[] }}
 */
function portsValues() {
    var ports = home('ports.json'), values = [], stray = [];
    for (var protocol in ports) {
        for (var key in ports[protocol]) {
            if ( typeof ports[protocol][key] === 'string' ) {
                stray.push(protocol + '/' + key + '=' + ports[protocol][key]);
                continue;
            }
            for (var port in ports[protocol][key]) values.push(ports[protocol][key][port]);
        }
    }
    return { values: values, stray: stray };
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
        ['project:add', '@app', '--path=' + path.join(FAKE_HOME, 'app')],
        ['bundle:add', 'demo', '@app'],
        ['project:add', '@app2', '--path=' + path.join(FAKE_HOME, 'app2')],
        ['bundle:add', 'web', '@app2'],
        ['project:add', '@other', '--path=' + path.join(FAKE_HOME, 'other')]
    ];
    for (var i = 0; i < steps.length; i++) {
        var r = runCli(steps[i]);
        if ( r.status !== 0 ) { setupError = steps[i].join(' ') + ' failed:\n' + r.out; return; }
    }
    // an unregistered directory where a rename would land
    fs.mkdirSync(path.join(FAKE_HOME, 'occupied'));
    fs.writeFileSync(path.join(FAKE_HOME, 'occupied', 'keep.txt'), 'UNRELATED');
});

after(function () {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('01 - project:rename to a free name', function () {

    it('renames the registry entry, the directory, the manifest and the port entries exactly', function () {
        assert.equal(setupError, null, setupError || '');
        var r = runCli(['project:rename', '@app', '@shop']);
        assert.equal(r.signal, null, 'the command was killed:\n' + r.out);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);

        var projects = home('projects.json');
        assert.ok(projects.shop, 'the new name is registered');
        assert.equal(projects.app, undefined, 'the old name is gone');
        assert.equal(projects.shop.path, path.join(FAKE_HOME, 'shop'), 'the registry points at the moved directory');
        assert.ok(fs.existsSync(path.join(FAKE_HOME, 'shop', 'manifest.json')), 'the directory moved');
        assert.ok(!fs.existsSync(path.join(FAKE_HOME, 'app')), 'the old directory is gone');
        assert.equal(JSON.parse(fs.readFileSync(path.join(FAKE_HOME, 'shop', 'manifest.json'), 'utf8')).name, 'shop');

        var pv = portsValues();
        assert.deepEqual(pv.stray, [], 'no value written one level too high in ports.json');
        assert.ok(pv.values.some(function (v) { return /^demo@shop\//.test(v); }), 'the renamed bundle ports name the new project');
        assert.ok(!pv.values.some(function (v) { return /^demo@app\//.test(v); }), 'no ports.json value names the old project');

        var reverse = home('ports.reverse.json');
        assert.ok(reverse['demo@shop'], 'the reverse key is renamed');
        assert.equal(reverse['demo@app'], undefined, 'the old reverse key is gone');
    });

    it('leaves a project whose name starts with the old name alone', function () {
        var projects = home('projects.json');
        assert.ok(projects.shop, 'precondition: the rename above happened');
        assert.ok(projects.app2, '@app2 is still registered');
        var reverse = home('ports.reverse.json');
        assert.ok(reverse['web@app2'], 'web@app2 keeps its reverse key');
        assert.equal(reverse['web@shop2'], undefined, 'no reverse key was renamed by prefix');
        var values = portsValues().values;
        assert.ok(values.some(function (v) { return /^web@app2\//.test(v); }), 'web@app2 keeps its ports.json values');
        assert.ok(!values.some(function (v) { return /^web@shop2\//.test(v); }), 'no ports.json value was renamed by prefix');
    });
});

describe('02 - project:rename refuses a target that is taken', function () {

    it('refuses a name that is already registered, changing nothing', function () {
        assert.equal(setupError, null, setupError || '');
        var before = registryBytes();
        var r = runCli(['project:rename', '@shop', '@other']);
        assert.equal(r.status, 1, 'exit 1:\n' + r.out);
        assert.match(r.out, /already taken/);
        assert.equal(registryBytes(), before, 'projects.json, ports.json and ports.reverse.json unchanged');
        assert.ok(fs.existsSync(path.join(FAKE_HOME, 'other')), '@other keeps its directory');
    });

    it('refuses a directory that already exists, changing nothing', function () {
        var before = registryBytes();
        var r = runCli(['project:rename', '@shop', '@occupied']);
        assert.equal(r.status, 1, 'exit 1:\n' + r.out);
        assert.match(r.out, /already exists/, 'refused because the directory exists:\n' + r.out);
        assert.equal(registryBytes(), before, 'registry files unchanged');
        assert.deepEqual(fs.readdirSync(path.join(FAKE_HOME, 'occupied')), ['keep.txt'], 'the existing directory is untouched');
        assert.ok(fs.existsSync(path.join(FAKE_HOME, 'shop', 'manifest.json')), 'the project stayed where it was');
    });
});
