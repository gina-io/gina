/**
 * #B779 — `gina image:run <image>` without `--name` leaves the container name to podman.
 *
 * The shared CmdHelper turns a lone positional argument into `name` (a bundle command's
 * bundle). For `image:run` that positional is the IMAGE, and `--name=` is the container's
 * name, so the image reference became the container name whenever `--name` was absent: a
 * usual `repo:tag` reference was refused as « invalid --name », and a reference that is also a
 * valid container name (`demo`) named the container after the image. The documented default
 * is that podman picks the name, and `name` is `null` in the output.
 *
 * Sections, each running the real bin/cli in an isolated home:
 *   01 — a `repo:tag` reference and no `--name`: not refused as a name; with no container host
 *        configured it stops at « no container host », past every gate. Fails on the pre-fix
 *        bytes.
 *   02 — a reference that is a valid container name and no `--name`, `--stream`: the `start`
 *        frame's `name` is null and podman gets no `--name`. GINA_CONTAINER_HOST names an ssh
 *        host under the never-resolving `.invalid` TLD, and a stub `ssh` first on PATH records
 *        its argv and exits 255, so no host is ever reached. Fails on the pre-fix bytes.
 *   03 — CONTROL: `--name=probe` still names the container (passes on both).
 *   04 — CONTROL: an invalid `--name` is still refused (passes on both).
 *
 * Isolation (the gina-version-refusal-b584 shape): HOME points at a temp dir, every inherited
 * GINA_* variable is removed, and GINA_PREFIX, GINA_RUNDIR, GINA_LOGDIR, GINA_TMPDIR and
 * GINA_MQ_PORT are pinned into the temp home.
 */

'use strict';

var fs   = require('fs');
var os   = require('os');
var net  = require('net');
var path = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var GINA_ROOT = path.resolve(__dirname, '..', '..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');

var TMP       = fs.mkdtempSync(path.join(os.tmpdir(), 'image-run-name-b779-'));
var HOME      = path.join(TMP, 'home');
var STUB_DIR  = path.join(TMP, 'stub-bin');
var SSH_LOG   = path.join(TMP, 'ssh-argv.log');
var HOST      = 'ssh://probe@b779.invalid';
var MQ_PORT   = null;

/**
 * Finds a free TCP port on 127.0.0.1 for the MQ listener.
 *
 * @inner
 * @returns {Promise<number>}
 */
function freePort() {
    return new Promise(function (resolve, reject) {
        var srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', function () {
            var port = srv.address().port;
            srv.close(function () { resolve(port); });
        });
    });
}

/**
 * Runs bin/cli in the isolated home.
 *
 * @inner
 * @param {string[]} args - CLI arguments, e.g. ['image:run', 'demo']
 * @param {object} [extraEnv] - Variables added after the GINA_* cleanup
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(args, extraEnv) {
    var env = Object.assign({}, process.env);
    Object.keys(env).forEach(function (k) {
        if (/^GINA_/.test(k)) delete env[k];
    });
    delete env.NPM_CONFIG_PREFIX;
    delete env.npm_config_prefix;
    ['prefix', 'run', 'log', 'tmp'].forEach(function (d) {
        fs.mkdirSync(path.join(HOME, d), { recursive: true });
    });
    Object.assign(env, {
        HOME         : HOME,
        GINA_PREFIX  : path.join(HOME, 'prefix'),
        GINA_RUNDIR  : path.join(HOME, 'run'),
        GINA_LOGDIR  : path.join(HOME, 'log'),
        GINA_TMPDIR  : path.join(HOME, 'tmp'),
        GINA_MQ_PORT : String(MQ_PORT)
    }, extraEnv || {});
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: env, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Runs `image:run` against the stub ssh host, the argv log emptied first.
 *
 * @inner
 * @param {string[]} args - Arguments after `image:run`
 * @returns {{status: number, stdout: string, stderr: string, start: ?object, sshArgv: string}}
 *   The run, its `start` frame (parsed) and what the stub ssh received
 */
function runOnStubHost(args) {
    fs.writeFileSync(SSH_LOG, '');
    var r = run(['image:run'].concat(args), {
        GINA_CONTAINER_HOST : HOST,
        PATH                : STUB_DIR + path.delimiter + process.env.PATH
    });
    var start = null;
    r.stdout.split('\n').forEach(function (line) {
        if (line.indexOf('"type":"start"') > -1) {
            start = JSON.parse(line.slice(line.indexOf('{')));
        }
    });
    r.start   = start;
    r.sshArgv = fs.readFileSync(SSH_LOG, 'utf8');
    return r;
}

/**
 * @inner
 * @param {{status: number, stdout: string, stderr: string}} r
 * @returns {string} A diagnostic block for assertion messages
 */
function out(r) {
    return 'rc=' + r.status + '\n--- stdout\n' + r.stdout.slice(-1500) + '\n--- stderr\n' + r.stderr.slice(-1500);
}

before(async function () {
    MQ_PORT = await freePort();
    fs.mkdirSync(STUB_DIR, { recursive: true });
    fs.writeFileSync(path.join(STUB_DIR, 'ssh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "' + SSH_LOG + '"\nexit 255\n');
    fs.chmodSync(path.join(STUB_DIR, 'ssh'), 0o755);
    // seed the home: a first command initialises it, as on a fresh install
    var r = run(['version']);
    assert.ok(fs.existsSync(path.join(HOME, '.gina', 'main.json')), 'the home was not initialised\n' + out(r));
});

after(function () {
    fs.rmSync(TMP, { recursive: true, force: true });
});


describe('01 - a repo:tag reference and no --name', function () {

    it('01.1 is not refused as a container name; it stops at the missing container host', function () {
        var r = run(['image:run', 'localhost/b779/probe:v1']);
        var text = r.stdout + r.stderr;
        assert.equal(text.indexOf('invalid --name'), -1, 'the image reference was refused as a container name\n' + out(r));
        assert.ok(text.indexOf('no container host') > -1, 'expected the host error, past every gate\n' + out(r));
        assert.equal(r.status, 1);
    });
});


describe('02 - a reference that is also a valid container name, no --name', function () {

    it('02.1 the start frame names no container, and podman gets no --name', function () {
        var r = runOnStubHost(['demo', '--stream', '--publish=none']);
        assert.ok(r.start, 'no start frame\n' + out(r));
        assert.equal(r.start.name, null, 'the container was named ' + JSON.stringify(r.start.name) + '\n' + out(r));
        assert.ok(r.sshArgv.indexOf('podman run') > -1, 'the stub ssh never received the podman command\n' + r.sshArgv);
        assert.doesNotMatch(r.sshArgv, /--name/, 'podman was given a name: ' + r.sshArgv);
    });
});


describe('03 - CONTROL: --name=probe still names the container', function () {

    it('03.1 the start frame and podman both carry probe', function () {
        var r = runOnStubHost(['demo', '--stream', '--publish=none', '--name=probe']);
        assert.ok(r.start, 'no start frame\n' + out(r));
        assert.equal(r.start.name, 'probe');
        assert.match(r.sshArgv, /--name probe\b/, r.sshArgv);
    });
});


describe('04 - CONTROL: an invalid --name is still refused', function () {

    it('04.1 a name with a space is refused before any host is resolved', function () {
        var r = run(['image:run', 'demo', '--name=bad name']);
        var text = r.stdout + r.stderr;
        assert.ok(text.indexOf('invalid --name') > -1, out(r));
        assert.equal(text.indexOf('no container host'), -1, 'the gate let it through\n' + out(r));
        assert.equal(r.status, 1);
    });
});
