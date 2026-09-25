/**
 * #B648 — `gina scope:link-local`, `scope:link-production` and `env:link-dev` end
 * the process after a successful write, even where `bin/cli` holds its MQ listener.
 *
 * `bin/cli` starts the MQ log listener only when `process.argv[1]` ends in
 * `gina/bin/cli` (or `gina//bin/gina`) — the shape of an npm install
 * (`…/node_modules/gina/bin/cli`) and of CI's checkout, but not of a checkout
 * directory named otherwise. The three handlers' success path wrote `projects.json`
 * and returned without `process.exit`, so wherever the listener was bound nothing
 * ever ended the process: the command hung after its write (measured: killed at
 * the timeout with the slot already written; exit 0 in ~0.1 s from a checkout
 * whose directory is not named `gina`).
 *
 * This test runs the CLI through a temporary symlink NAMED `gina`, so the listener
 * starts in any checkout, and asserts the listener line as a positive control: a
 * run where the listener never started would pass vacuously.
 *
 * Red-first: on the pre-change handlers every arm fails (the spawn times out, no
 * exit status); the listener control passes on both.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var STAMP     = Date.now();
var TMP       = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b648-'));
var FAKE_HOME = path.join(TMP, 'home');
var GINA_HOME = path.join(FAKE_HOME, '.gina');
var LINK      = path.join(TMP, 'gina');                 // named like an install
var CLI       = path.join(LINK, 'bin', 'cli');
var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var PROJECT = 'b648p' + STAMP;

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
        env: CHILD_ENV, cwd: FAKE_HOME, encoding: 'utf8', timeout: timeout || 90000
    });
    return { status: r.status, signal: r.signal, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * The isolated home's registry entry for the test project.
 *
 * @inner
 * @returns {object}
 */
function projectEntry() {
    return JSON.parse(fs.readFileSync(path.join(GINA_HOME, 'projects.json'), 'utf8'))[PROJECT] || {};
}

var setupError = null;

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

before(async function () {
    // The children's own MQ port: on CI every CLI child competes for the default
    // 8125, and a child that finds it taken never becomes the listener, which
    // would make the CONTROL below fail for a reason unrelated to the fix.
    CHILD_ENV.GINA_MQ_PORT = String(await freePort());
    fs.mkdirSync(FAKE_HOME, { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, '../..'), LINK);
    var r = runCli(['project:add', '@' + PROJECT, '--path=' + path.join(FAKE_HOME, PROJECT)]);
    var entry = fs.existsSync(path.join(GINA_HOME, 'projects.json')) ? projectEntry() : {};
    if ( !entry.path ) setupError = 'project:add did not register @' + PROJECT + ':\n' + r.out;
});

after(function () {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('01 - the slot commands exit after a successful write, with the MQ listener bound', function () {

    [['scope:link-local', 'production', 'local_scope'],
     ['scope:link-production', 'local', 'production_scope'],
     ['env:link-dev', 'prod', 'dev_env']].forEach(function (h) {

        it('[' + h[0] + '] exits 0 and writes ' + h[2], function () {
            assert.equal(setupError, null, setupError || '');
            var r = runCli([h[0], h[1], '@' + PROJECT], 15000);
            assert.match(r.out, /is wait+ing for speakers on port/, 'CONTROL: the MQ listener started (the install shape):\n' + r.out);
            assert.equal(r.signal, null, 'the command hung and was killed:\n' + r.out);
            assert.equal(r.status, 0, 'exit 0:\n' + r.out);
            assert.equal(projectEntry()[h[2]], h[1], h[2] + ' written');
        });
    });
});
