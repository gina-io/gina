/**
 * #B644 — `project:add` / `project:import` read their flags whole, and a failed
 * `node_modules/gina` removal reports its own error.
 *
 * The handler re-read its flags from argv with unanchored tests and
 * `split(/\=/)[1]`, and the shared helper read `project:import`'s `--path` the
 * same way. So:
 *  - a `--path` holding `=` was cut at the second `=` — on a fresh registry the
 *    manifest was written into the cut directory, which does not exist (exit 1,
 *    ENOENT), and an import to such a path was refused as "no longer exists";
 *  - `--scope=a=b` / `--env=a=b` registered `a` instead of refusing the name;
 *  - a `--path` value containing `--scope=` or `--env=` was read as that flag too.
 * The import-only branch that was meant to set the project's default scope and
 * environment from `--scope` / `--env` could never run (`/^$true/`); it stays
 * off, and the CLI reference now says those flags register a missing scope or
 * environment — the defaults are set with `scope:use` / `env:use`. Finally, the
 * removal branch of `end()` printed an undeclared `err`, so a failed removal
 * died on a ReferenceError.
 *
 * Sections:
 *   01 — add.js (comment-stripped source pins): every flag of the argv loop is
 *        read through `flagValue()`, none by `split`; the default-setting branch
 *        does not execute.
 *   02 — live, through a symlink NAMED `gina` (the install shape, so the CLI's MQ
 *        listener is bound — asserted as a control on every run), in isolated
 *        homes with a free MQ port.
 *
 * Red-first: on the pre-change tree both 01 pins fail, and every 02 arm not
 * marked CONTROL fails — each for the defect it names (the ENOENT, the refused
 * path, the registered truncated name, the "no longer exists" refusal, the
 * ReferenceError). The CONTROLs pass on both.
 *
 * `GINA_B644_TREE` points the `gina` link at another checkout, and
 * `GINA_B644_ADD` the 01 pins at another add.js, so the file can be re-run
 * against pre-change bytes without touching this tree.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var net    = require('net');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW      = require('../fw');
var ADD_SRC = fs.readFileSync(process.env.GINA_B644_ADD || path.join(FW, 'lib/cmd/project/add.js'), 'utf8');

// comment-stripped handler source, so a pin never matches the fix's own comments
var ADD_ACTIVE = ADD_SRC.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

/**
 * The argv loop of init(): from the `init` declaration to the #B640 name check
 * that follows the loop.
 *
 * @inner
 * @returns {string} Empty when an anchor is missing
 */
function argvLoop() {
    var start = ADD_ACTIVE.indexOf('var init = function()');
    var stop  = ADD_ACTIVE.indexOf('if ( !/\\:import/i.test(process.argv[2]) )', start);
    return (start > -1 && stop > start) ? ADD_ACTIVE.slice(start, stop) : '';
}

describe('01 - project/add.js source pins', function () {

    it('the argv loop reads all five flags through flagValue(), none by split', function () {
        var loop = argvLoop();
        assert.ok(loop.indexOf('process.argv') > -1, 'the loop region was found');
        assert.equal((loop.match(/split\(/g) || []).length, 0, 'no flag value is taken with split()');
        assert.equal((loop.match(/flagValue\(process\.argv\[i\], '/g) || []).length, 5,
            'start-port-from, homedir, scope, env and path go through flagValue()');
    });

    it('the import-only branch that would set the defaults from --scope / --env does not execute', function () {
        assert.equal(ADD_ACTIVE.indexOf('/^$true/i.test(local.imported)'), -1, 'the dead branch is not live code');
        // control: the stripped view still carries end()'s live import branch
        assert.ok(ADD_ACTIVE.indexOf('if ( /^true$/i.test(local.imported) ) {') > -1, 'end() is in the stripped view');
    });
});

// ---------------------------------------------------------------------------
// 02 — live. Each run goes through a symlink NAMED `gina` with its own MQ port:
// bin/cli binds its MQ listener there, as in an install, and every arm asserts
// the listener line so a run that never bound it cannot pass vacuously. The
// temporary root is realpath'd so the registered paths compare exactly.
// ---------------------------------------------------------------------------

var STAMP   = Date.now();
var TREE    = process.env.GINA_B644_TREE || path.resolve(__dirname, '../..');
var TMP     = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gina-b644-'));
var LINK    = path.join(TMP, 'gina');                  // named like an install
var CLI     = path.join(LINK, 'bin', 'cli');
var HOME    = path.join(TMP, 'home');                   // the shared, seeded home
var MQ_PORT = null;

/**
 * A free TCP port on the loopback, for the children's MQ listener.
 *
 * @inner
 * @returns {Promise<number>}
 */
function freePort() {
    return new Promise(function (resolve, reject) {
        var srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', function () {
            var port = srv.address().port;
            srv.close(function () { resolve(port); });
        });
    });
}

/**
 * Run an offline gina CLI command through the `gina`-named link with the given
 * HOME, from a working directory inside it.
 *
 * @inner
 * @param {string} home - HOME for the child
 * @param {string[]} args - CLI arguments, starting with the task
 * @returns {{ status: (number|null), signal: (string|null), out: string }}
 */
function runCli(home, args) {
    var env = Object.assign({}, process.env, { HOME: home, GINA_LOG_STDOUT: 'true', GINA_MQ_PORT: MQ_PORT });
    delete env.GINA_HOMEDIR;
    var r = spawnSync(process.execPath, [CLI].concat(args), {
        env: env, cwd: home, encoding: 'utf8', timeout: 60000
    });
    return { status: r.status, signal: r.signal, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Assert the run bound the MQ listener and ended on its own.
 *
 * @inner
 * @param {{ signal: (string|null), out: string }} r
 */
function assertRan(r) {
    assert.match(r.out, /is wait+ing for speakers on port/, 'CONTROL: the MQ listener started (the install shape):\n' + r.out);
    assert.equal(r.signal, null, 'the command hung and was killed:\n' + r.out);
}

/**
 * Read a JSON state file of a home's `.gina`, or null when it is absent.
 *
 * @inner
 * @param {string} home
 * @param {string} name - File name inside `.gina`
 * @returns {?object}
 */
function readState(home, name) {
    var p = path.join(home, '.gina', name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/**
 * The running release's entry of a main.json per-release map (a list such as
 * `envs`, or a value such as `def_env`).
 *
 * @inner
 * @param {object} map - For example main.envs or main.def_env
 * @returns {*}
 */
function releaseValue(map) {
    return map[Object.keys(map)[0]];
}

/**
 * Copy a registered project's three root files to a new directory (what an
 * import of a moved project finds there).
 *
 * @inner
 * @param {string} from - The registered project directory
 * @param {string} to - The new directory, created
 */
function copyProject(from, to) {
    fs.mkdirSync(to, { recursive: true });
    ['package.json', 'manifest.json', 'env.json'].forEach(function (f) {
        fs.copyFileSync(path.join(from, f), path.join(to, f));
    });
}

/**
 * A fresh, empty home.
 *
 * @inner
 * @param {string} name
 * @returns {string}
 */
function freshHome(name) {
    var home = path.join(TMP, name);
    fs.mkdirSync(home, { recursive: true });
    return home;
}

var setupError = null;

before(async function () {
    MQ_PORT = String(await freePort());
    fs.symlinkSync(TREE, LINK);
    fs.mkdirSync(HOME, { recursive: true });
    var r = runCli(HOME, ['project:add', '@seed' + STAMP, '--path=' + path.join(HOME, 'seed' + STAMP)]);
    if ( r.status !== 0 || !(readState(HOME, 'projects.json') || {})['seed' + STAMP] ) {
        setupError = 'seeding the shared home failed:\n' + r.out;
    }
});

after(function () {
    try { fs.chmodSync(path.join(HOME, 'rp' + STAMP, 'node_modules'), 0o755); } catch (e) { /* absent */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('02 - live: a `--path` holding `=`', function () {

    it('project:add on a fresh registry writes the project at the whole path', function () {
        var home = freshHome('fresh-eq');
        var dir  = path.join(home, 'a=b', 'z1');
        var r    = runCli(home, ['project:add', '@z1', '--path=' + dir]);
        assertRan(r);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);
        assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'the manifest is at the whole path:\n' + r.out);
        assert.equal(((readState(home, 'projects.json') || {}).z1 || {}).path, dir, 'the whole path is registered');
        assert.equal(fs.existsSync(path.join(home, 'a')), false, 'nothing was created at the cut path');
    });

    it('CONTROL: project:add on a fresh registry with a path without `=`', function () {
        var home = freshHome('fresh-plain');
        var dir  = path.join(home, 'ab', 'z2');
        var r    = runCli(home, ['project:add', '@z2', '--path=' + dir]);
        assertRan(r);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);
        assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'the manifest is at the path');
        assert.equal(((readState(home, 'projects.json') || {}).z2 || {}).path, dir, 'the path is registered');
    });

    it('project:import to a new path holding `=` registers the whole path', function () {
        assert.equal(setupError, null, setupError || '');
        var name = 'impq' + STAMP;
        var old  = path.join(HOME, name + '.app');
        assert.equal(runCli(HOME, ['project:add', '@' + name, '--path=' + old]).status, 0, 'registered');
        var dir = path.join(HOME, 'n=m', name + '.new');
        copyProject(old, dir);
        var r = runCli(HOME, ['project:import', '@' + name, '--path=' + dir]);
        assertRan(r);
        assert.doesNotMatch(r.out, /no longer exists/, 'the import did not refuse a cut path:\n' + r.out);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);
        assert.equal(((readState(HOME, 'projects.json') || {})[name] || {}).path, dir, 'the whole new path is registered');
    });

    it('CONTROL: project:import to a new path without `=` registers it', function () {
        assert.equal(setupError, null, setupError || '');
        var name = 'impp' + STAMP;
        var old  = path.join(HOME, name + '.app');
        assert.equal(runCli(HOME, ['project:add', '@' + name, '--path=' + old]).status, 0, 'registered');
        var dir = path.join(HOME, 'nm', name + '.new');
        copyProject(old, dir);
        var r = runCli(HOME, ['project:import', '@' + name, '--path=' + dir]);
        assertRan(r);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);
        assert.equal(((readState(HOME, 'projects.json') || {})[name] || {}).path, dir, 'the new path is registered');
    });
});

describe('02 - live: flags are matched at the start of an argument', function () {

    [['scope', 'is not a valid scope name'], ['env', 'is not a valid environment name']].forEach(function (spec) {
        it('a `--path` containing `--' + spec[0] + '=` is not read as --' + spec[0], function () {
            assert.equal(setupError, null, setupError || '');
            var name = 'in' + spec[0] + STAMP;
            var dir  = path.join(HOME, 'p--' + spec[0] + '=x', name);
            var r    = runCli(HOME, ['project:add', '@' + name, '--path=' + dir]);
            assertRan(r);
            assert.doesNotMatch(r.out, new RegExp(spec[1]), 'a piece of the path was checked as a name:\n' + r.out);
            assert.equal(r.status, 0, 'exit 0:\n' + r.out);
            assert.equal(((readState(HOME, 'projects.json') || {})[name] || {}).path, dir, 'the whole path is registered');
        });
    });
});

describe('02 - live: a `--scope` / `--env` value holding `=`', function () {

    [['scope', 'is not a valid scope name', 'scopes'], ['env', 'is not a valid environment name', 'envs']].forEach(function (spec) {
        it('--' + spec[0] + '=<name>=<more> is refused whole, and nothing is registered', function () {
            assert.equal(setupError, null, setupError || '');
            var project = 'eq' + spec[0] + STAMP;
            var value   = spec[0].slice(0, 2) + STAMP;
            var r = runCli(HOME, ['project:add', '@' + project, '--path=' + path.join(HOME, project), '--' + spec[0] + '=' + value + '=t']);
            assertRan(r);
            var list = releaseValue((readState(HOME, 'main.json') || {})[spec[2]] || { x: [] });
            assert.equal(list.indexOf(value), -1, 'the value cut at `=` was not registered:\n' + r.out);
            // the refusal is a JSON log record, where the quotes around the value are escaped
            assert.match(r.out, new RegExp(value + '=t\\\\?" ' + spec[1]), 'the whole value was refused:\n' + r.out);
            assert.equal(r.status, 1, 'exit 1:\n' + r.out);
            assert.equal((readState(HOME, 'projects.json') || {})[project], undefined, 'the project was not registered');
        });
    });
});

describe('02 - live: --scope / --env register, the defaults stay', function () {

    it('CONTROL: project:add registers a new scope and environment without making them the defaults', function () {
        assert.equal(setupError, null, setupError || '');
        var name  = 'dflt' + STAMP;
        var scope = 'stg' + STAMP;
        var env   = 'qa' + STAMP;
        var r = runCli(HOME, ['project:add', '@' + name, '--path=' + path.join(HOME, name), '--scope=' + scope, '--env=' + env]);
        assertRan(r);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);
        var main = readState(HOME, 'main.json') || {};
        var p    = (readState(HOME, 'projects.json') || {})[name] || {};
        assert.ok((p.scopes || []).indexOf(scope) > -1 && (p.envs || []).indexOf(env) > -1, 'both registered on the project');
        assert.equal(p.def_scope, releaseValue(main.def_scope), 'def_scope is the default');
        assert.equal(p.def_env, releaseValue(main.def_env), 'def_env is the default');
    });

    it('CONTROL: project:import --env=<registered> keeps the project default environment', function () {
        assert.equal(setupError, null, setupError || '');
        var name = 'dflti' + STAMP;
        var env  = 'uat' + STAMP;
        var dir  = path.join(HOME, name + '.app');
        assert.equal(runCli(HOME, ['project:add', '@' + name, '--path=' + dir, '--env=' + env]).status, 0, 'registered');
        var before = ((readState(HOME, 'projects.json') || {})[name] || {}).def_env;
        var r = runCli(HOME, ['project:import', '@' + name, '--path=' + dir, '--env=' + env]);
        assertRan(r);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);
        var after = ((readState(HOME, 'projects.json') || {})[name] || {}).def_env;
        assert.notEqual(before, env, 'the premise: the default was not ' + env + ' before');
        assert.equal(after, before, 'the import did not make ' + env + ' the default');
    });
});

describe('02 - live: a failed removal of node_modules/gina', function () {

    // As root, unlinking inside a read-only directory succeeds, so there is no
    // failure to report.
    var isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

    it('reports the removal error instead of dying on an undeclared name', { skip: isRoot }, function () {
        assert.equal(setupError, null, setupError || '');
        var name = 'rp' + STAMP;
        var dir  = path.join(HOME, name);
        var nm   = path.join(dir, 'node_modules');
        fs.mkdirSync(nm, { recursive: true });
        fs.symlinkSync(TREE, path.join(nm, 'gina'));
        fs.chmodSync(nm, 0o555);
        var r;
        try {
            r = runCli(HOME, ['project:add', '@' + name, '--path=' + dir]);
        } finally {
            fs.chmodSync(nm, 0o755);
        }
        assertRan(r);
        assert.doesNotMatch(r.out, /ReferenceError/, 'the branch died on a ReferenceError:\n' + r.out);
        assert.match(r.out, /EACCES|EPERM|permission denied|operation not permitted/i, 'the removal error was reported:\n' + r.out);
        assert.equal(r.status, 1, 'exit 1:\n' + r.out);
    });
});
