/**
 * #B653 — six more CLI success paths end the process, even where `bin/cli` holds
 * its MQ listener (the #B648 class).
 *
 * `bin/cli` starts its MQ log listener when it runs by its own path inside a
 * directory named `gina` (an npm install's `…/node_modules/gina/bin/cli`, CI's
 * checkout, scripts calling bin/cli). These paths returned with nothing ending
 * the process, so there they hung after doing their work:
 *  - `port:reset` with no registered project,
 *  - `env:unset --<key>` (every run),
 *  - `env:set` with no key,
 *  - `port:list --format=json` (with or without `--filename`) and
 *    `--format=conf` without `--filename`,
 *  - `connector:list` without `@<project>`,
 *  - `protocol:set` when the interactive prompt is cancelled (TTY only — pinned
 *    on the source below).
 *
 * Each arm runs the CLI in an isolated HOME through a symlink NAMED `gina` with its
 * own MQ port and asserts the listener line as a control. The JSON outputs are
 * parsed whole: the listings exit only once stdout has been handed to the OS.
 *
 * Red-first: on the pre-change handlers every spawned arm is killed at the
 * timeout, and the source pin fails.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var ROOT      = path.resolve(__dirname, '../..');
var TMP       = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b653-'));
var LINK      = path.join(TMP, 'gina');                 // named like an install
var CLI       = path.join(LINK, 'bin', 'cli');
var PROJECT   = 'b653p' + Date.now();
var MQ_PORT   = null;

/**
 * Run an offline gina CLI command through the `gina`-named link with the given
 * HOME.
 *
 * @inner
 * @param {string} home - HOME for the child
 * @param {string[]} args - CLI arguments, starting with the task
 * @param {number} [timeout] - Spawn timeout in milliseconds
 * @returns {{ status: (number|null), signal: (string|null), stdout: string, out: string }}
 */
function runCli(home, args, timeout) {
    var env = Object.assign({}, process.env, { HOME: home, GINA_LOG_STDOUT: 'true', GINA_MQ_PORT: MQ_PORT });
    delete env.GINA_HOMEDIR;
    var r = spawnSync(process.execPath, [CLI].concat(args), {
        env: env, cwd: home, encoding: 'utf8', timeout: timeout || 15000
    });
    return { status: r.status, signal: r.signal, stdout: r.stdout || '', out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Assert the command exited 0 on its own with the MQ listener bound.
 *
 * @inner
 * @param {{ status: (number|null), signal: (string|null), out: string }} r
 */
function assertExited(r) {
    assert.match(r.out, /is wait+ing for speakers on port/, 'CONTROL: the MQ listener started (the install shape):\n' + r.out);
    assert.equal(r.signal, null, 'the command hung and was killed:\n' + r.out);
    assert.equal(r.status, 0, 'exit 0:\n' + r.out);
}

/**
 * The first JSON document in a command's stdout (the listener and log lines are
 * JSON log records on their own lines; the listing is the one that is not).
 *
 * @inner
 * @param {string} stdout
 * @returns {*}
 */
function listing(stdout) {
    var lines = stdout.split('\n').filter(function (l) { return l && !/^\{"ts":/.test(l); });
    return JSON.parse(lines.join('\n'));
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

var HOME = path.join(TMP, 'home');
var setupError = null;

before(async function () {
    MQ_PORT = String(await freePort());
    fs.symlinkSync(ROOT, LINK);
    fs.mkdirSync(HOME, { recursive: true });
    var steps = [
        ['project:add', '@' + PROJECT, '--path=' + path.join(HOME, PROJECT)],
        ['bundle:add', 'demo', '@' + PROJECT]
    ];
    for (var i = 0; i < steps.length; i++) {
        var r = runCli(HOME, steps[i], 60000);
        if ( r.status !== 0 ) { setupError = steps[i].join(' ') + ' failed:\n' + r.out; return; }
    }
});

after(function () {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('01 - commands that had no exit on a success path', function () {

    it('[port:reset] exits with no registered project (fresh registry)', function () {
        var fresh = path.join(TMP, 'fresh-home');
        fs.mkdirSync(fresh, { recursive: true });
        assertExited(runCli(fresh, ['port:reset']));
    });

    it('[env:unset] exits', function () {
        assert.equal(setupError, null, setupError || '');
        assertExited(runCli(HOME, ['env:unset', '--nosuchkey']));
    });

    it('[env:set] exits with no key', function () {
        assertExited(runCli(HOME, ['env:set']));
    });

    it('[connector:list] exits without @<project>', function () {
        var r = runCli(HOME, ['connector:list']);
        assertExited(r);
        assert.match(r.out, new RegExp(PROJECT), 'it listed the registered project');
    });

    it('[connector:list] exits without @<project> after a complete JSON listing', function () {
        var r = runCli(HOME, ['connector:list', '--format=json']);
        assertExited(r);
        var json = listing(r.stdout);
        assert.ok(json && typeof json === 'object', 'a JSON listing: ' + r.stdout);
        assert.ok(JSON.stringify(json).indexOf(PROJECT) > -1, 'it lists the registered project');
    });
});

describe('02 - port:list formats that had no exit', function () {

    it('[port:list --format=json] exits after a complete JSON listing', function () {
        assert.equal(setupError, null, setupError || '');
        var r = runCli(HOME, ['port:list', '@' + PROJECT, '--format=json']);
        assertExited(r);
        var json = listing(r.stdout);
        assert.ok(JSON.stringify(json).indexOf('demo') > -1, 'the listing names the bundle: ' + r.stdout);
    });

    it('[port:list --format=json --filename] exits after writing the file', function () {
        var file = path.join(TMP, 'ports.json');
        var r = runCli(HOME, ['port:list', '@' + PROJECT, '--format=json', '--filename=' + file]);
        assertExited(r);
        assert.match(r.out, /Saved to/);
        assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))).indexOf('demo') > -1, 'the file holds the listing');
    });

    it('[port:list --format=conf] exits after printing the listing', function () {
        var r = runCli(HOME, ['port:list', '@' + PROJECT, '--format=conf']);
        assertExited(r);
        assert.match(r.stdout, /_demo_[^=\n]+=\d+:\d+/, 'a conf line for the bundle: ' + r.stdout);
    });
});

describe('03 - protocol:set cancel (interactive, TTY only)', function () {

    it('the readline close handler ends the process', function () {
        var src = fs.readFileSync(path.join(ROOT, 'framework', 'v' + require(path.join(ROOT, 'package.json')).version,
            'lib', 'cmd', 'protocol', 'set.js'), 'utf8');
        var i = src.indexOf(".on('close', function() {");
        assert.ok(i > -1, 'the close handler is found');
        var body = src.slice(i, src.indexOf('});', i));
        assert.match(body, /console\.log\('Exiting protocol setup'\)/, 'the handler found is the cancel one');
        var code = body.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
        assert.match(code, /process\.exit\(0\)/, 'it exits (comments ignored)');
    });
});
