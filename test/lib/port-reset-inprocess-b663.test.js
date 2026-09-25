/**
 * #B663 — `gina port:reset` reads the project's bundle list in-process instead of
 * running `$(which gina) bundle:list …` through a shell.
 *
 * reset() needs the project's bundle names. It got them from a child
 * `$(which gina) bundle:list @<project> --format=json` run through `sh`: with no
 * `gina` on PATH (a CI runner, a container, `node bin/cli`) or `gina` under a path
 * containing a space, the child failed, the catch swallowed it, and the reset died
 * on a null list — `TypeError: Cannot read properties of null (reading 'length')`,
 * exit 1 — before writing anything. The child also ran whichever `gina` PATH found
 * first (possibly another install), without the parent's GINA_HOMEDIR, and the
 * project name reached the shell unquoted. The list now comes from the manifest
 * the command has already loaded (`self.bundlesByProject[<project>]`: the same
 * `manifest.json` `bundles` keys that `bundle:list` prints).
 *
 * Sections:
 *   01 — reset.js (comment-stripped source pins)
 *   02 — live, against an isolated home, with no `gina` on PATH: the stale entries
 *        of the project's bundles are removed and the bundles get fresh ports,
 *        while another project's entries are kept. CONTROLS — no `gina` resolves
 *        on the test PATH (and the probe does find one when there is one), the
 *        children's temp files stay in this file's own directory (#B664), and the
 *        setup registered both bundles with ports.
 *
 * Red-first: on the pre-change reset.js the two 01 pins fail (the raw-text check
 * passes on both — it only proves the comment strip), and 02's reset exits 1 on
 * the TypeError (after `/bin/sh: bundle:list: command not found`), leaving the
 * stale entries in place; the CONTROLS pass on both.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW        = require('../fw');
var RESET_RAW = fs.readFileSync(path.join(FW, 'lib/cmd/port/reset.js'), 'utf8');
// comment-stripped handler source, so a pin never matches the kept pre-change lines
var RESET     = RESET_RAW.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

/**
 * The text from the first `start` to the first `end` after it.
 *
 * @inner
 * @param {string} src - Text to slice
 * @param {string} start - Opening anchor
 * @param {string} end - Closing anchor
 * @returns {string}
 */
function between(src, start, end) {
    var i = src.indexOf(start);
    assert.ok(i > -1, '`' + start + '` not found — test needs updating');
    var j = src.indexOf(end, i + start.length);
    assert.ok(j > -1, '`' + end + '` not found after `' + start + '`');
    return src.slice(i, j);
}

describe('01 - port/reset.js source pins', function () {

    it('reset() takes the bundle names from the loaded manifest', function () {
        var blk = between(RESET, 'var reset = function', 'var hasPastProtocolAndSchemeCheck');
        assert.match(blk, /self\.bundlesByProject\[self\.projectName\]/);
        assert.match(blk, /bundlesCollection\.push\(\s*\{\s*bundle\s*:\s*bundleName\s*,\s*project\s*:\s*self\.projectName\s*\}\s*\)/);
    });

    it('starts no child process: no execSync, no `which gina`, no child_process', function () {
        assert.equal(RESET.indexOf('execSync'), -1, 'no execSync');
        assert.equal(RESET.indexOf('which gina'), -1, 'no `which gina`');
        assert.equal(RESET.indexOf("require('child_process')"), -1, 'child_process is not required');
    });

    it('the pre-change lines survive only as comments (the strip is real)', function () {
        assert.ok(RESET_RAW.indexOf("execSync('$(which gina) bundle:list @'") > -1, 'kept as a comment');
    });
});


// ---------------------------------------------------------------------------
// 02 — live, against an isolated home (the cli-exit-b653.test.js shape: the CLI
// runs through a link NAMED `gina`, as an install does, with its own MQ port;
// HOME overridden and GINA_HOMEDIR removed so nothing touches the developer's
// `~/.gina`). Every child gets a private TMPDIR, which the CLI records as its
// `tmpdir` setting, so it never shares `<tmpdir>/err.log` with another test
// file's CLI children (#B664).
// ---------------------------------------------------------------------------
var ROOT      = path.resolve(__dirname, '../..');
var TMP       = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b663-reset-'));
var LINK      = path.join(TMP, 'gina');
var CLI       = path.join(LINK, 'bin', 'cli');
var HOME      = path.join(TMP, 'home');
var GINA_HOME = path.join(HOME, '.gina');
var CHILD_TMP = path.join(TMP, 'tmp');
var PROJECT   = 'b663p' + Date.now();
var MQ_PORT   = null;

// the inherited PATH minus every directory that holds a `gina` executable
var NO_GINA_PATH = (process.env.PATH || '').split(path.delimiter).filter(function (d) {
    try { fs.accessSync(path.join(d, 'gina'), fs.constants.X_OK); return false; } catch (e) { return true; }
}).join(path.delimiter);

/**
 * Run an offline gina CLI command against the isolated home.
 *
 * @inner
 * @param {string[]} args - CLI arguments, starting with the task
 * @returns {{ status: (number|null), signal: (string|null), out: string }}
 */
function runCli(args) {
    var env = Object.assign({}, process.env, {
        HOME: HOME, GINA_LOG_STDOUT: 'true', GINA_MQ_PORT: MQ_PORT, TMPDIR: CHILD_TMP, PATH: NO_GINA_PATH
    });
    delete env.GINA_HOMEDIR;
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: env, cwd: HOME, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, signal: r.signal, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Read a JSON state file of the isolated home.
 *
 * @inner
 * @param {string} name - File name inside the isolated `.gina`
 * @returns {object}
 */
function readState(name) {
    return JSON.parse(fs.readFileSync(path.join(GINA_HOME, name), 'utf8'));
}

/**
 * Write a JSON state file of the isolated home.
 *
 * @inner
 * @param {string} name - File name inside the isolated `.gina`
 * @param {object} data
 */
function writeState(name, data) {
    fs.writeFileSync(path.join(GINA_HOME, name), JSON.stringify(data, null, 4));
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

/**
 * Where `command -v gina` finds a gina on the given PATH, or null.
 *
 * @inner
 * @param {string} searchPath
 * @returns {?string}
 */
function whichGina(searchPath) {
    var r = spawnSync('/bin/sh', ['-c', 'command -v gina'], { env: { PATH: searchPath }, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
}

describe('02 - live: port:reset with no gina on PATH', function () {
    var setupError = null;

    before(async function () {
        MQ_PORT = String(await freePort());
        fs.symlinkSync(ROOT, LINK);
        fs.mkdirSync(HOME, { recursive: true });
        fs.mkdirSync(CHILD_TMP, { recursive: true });
        var steps = [
            ['project:add', '@' + PROJECT, '--path=' + path.join(HOME, PROJECT)],
            ['bundle:add', 'api', '@' + PROJECT],
            ['bundle:add', 'demo', '@' + PROJECT]
        ];
        for (var i = 0; i < steps.length; i++) {
            var r = runCli(steps[i]);
            if ( r.status !== 0 ) { setupError = steps[i].join(' ') + ' failed:\n' + r.out; return; }
        }
    });

    after(function () {
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    it('CONTROL: no gina resolves on the test PATH, and the probe finds one when there is one', function () {
        assert.equal(whichGina(NO_GINA_PATH), null, 'a gina is on the test PATH');
        var fakeBin = path.join(TMP, 'fakebin');
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.writeFileSync(path.join(fakeBin, 'gina'), '#!/bin/sh\nexit 0\n');
        fs.chmodSync(path.join(fakeBin, 'gina'), 493 /* 0o755 */);
        assert.equal(whichGina(fakeBin + path.delimiter + NO_GINA_PATH), path.join(fakeBin, 'gina'));
    });

    it('CONTROL: the children keep their temp files in this file\'s own directory (#B664)', function () {
        assert.equal(setupError, null, setupError || '');
        var shortDirs = fs.readdirSync(GINA_HOME).filter(function (d) { return /^\d+\.\d+$/.test(d); });
        assert.ok(shortDirs.length > 0, 'the isolated home has a release settings directory');
        shortDirs.forEach(function (d) {
            var settings = JSON.parse(fs.readFileSync(path.join(GINA_HOME, d, 'settings.json'), 'utf8'));
            assert.equal(fs.realpathSync(settings.tmpdir), fs.realpathSync(CHILD_TMP), d + '/settings.json tmpdir');
        });
    });

    it('CONTROL: the setup registered both bundles with ports', function () {
        assert.equal(setupError, null, setupError || '');
        var reverse = readState('ports.reverse.json');
        ['api', 'demo'].forEach(function (b) {
            assert.ok(reverse[b + '@' + PROJECT] && Object.keys(reverse[b + '@' + PROJECT]).length > 0, b + ' has ports');
        });
    });

    it('removes the stale entries of the project\'s bundles, keeps another project\'s, and re-assigns ports', function () {
        assert.equal(setupError, null, setupError || '');
        var ports   = readState('ports.json');
        var reverse = readState('ports.reverse.json');
        // a stale port and a stale environment for a registered bundle, and another project's entries
        ports['http/1.1'].http['65010'] = 'demo@' + PROJECT + '/stale';
        ports['http/1.1'].http['65001'] = 'other@elsewhere/dev';
        reverse['demo@' + PROJECT].stale = { 'http/1.1': { http: 65010 } };
        reverse['other@elsewhere'] = { dev: { 'http/1.1': { http: 65001 } } };
        writeState('ports.json', ports);
        writeState('ports.reverse.json', reverse);

        var r = runCli(['port:reset', '@' + PROJECT]);
        assert.equal(r.signal, null, 'killed:\n' + r.out);
        assert.equal(r.status, 0, 'port:reset exits 0:\n' + r.out);

        ports   = readState('ports.json');
        reverse = readState('ports.reverse.json');
        assert.equal(ports['http/1.1'].http['65010'], undefined, 'the stale port of a registered bundle is removed');
        assert.equal(reverse['demo@' + PROJECT].stale, undefined, 'the stale environment of a registered bundle is removed');
        assert.equal(ports['http/1.1'].http['65001'], 'other@elsewhere/dev', 'another project\'s port is kept');
        assert.deepEqual(reverse['other@elsewhere'], { dev: { 'http/1.1': { http: 65001 } } }, 'another project\'s entry is kept');
        ['api', 'demo'].forEach(function (b) {
            var entry = reverse[b + '@' + PROJECT];
            assert.ok(entry && entry.dev && entry.prod, b + ' has fresh ports for each environment');
            var values = Object.keys(ports['http/1.1'].http).map(function (p) { return ports['http/1.1'].http[p]; });
            assert.ok(values.indexOf(b + '@' + PROJECT + '/dev') > -1, b + '@' + PROJECT + '/dev has a port again');
        });
    });
});
