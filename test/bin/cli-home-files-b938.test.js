/**
 * #B938 — every offline CLI command, the framework start and `env:add` accept a
 * `//` comment or a trailing comma in gina's own files in `~/.gina`.
 *
 * The first step of every offline command and of the framework start
 * (`lib/cmd/framework/init.js`, `checkIfMain()`) read `~/.gina/main.json` with a
 * plain `require()`, so a comment or a trailing comma left by a hand edit stopped
 * all of them with node's SyntaxError, although bin/cli and the command helper
 * read the same file with `parseJSONWithComments` (#B906). `env:add` read
 * `ports.json` and `ports.reverse.json` with `require()` right after the command
 * helper had accepted the same file with a warning. All of these now go through
 * the `parseJSONWithComments` global; a `main.json` that is still not JSON refuses
 * the command with « main.json cannot be used: <reason> » and is left as it was.
 *
 *   01  CONTROL: plain files: bundle:list exits 0
 *   02  main.json with a trailing comma: bundle:list exits 0, a warning names the
 *       file, and the init rewrites it as plain JSON
 *   03  main.json with a `//` comment line: bundle:list exits 0
 *   04  main.json malformed: bundle:list exits 1 with « main.json cannot be used:
 *       could not parse `<path>` », and the file is left as it was
 *   05  CONTROL: projects.json with a trailing comma: bundle:list exits 0 (the init
 *       rewrites projects.json before any command reads it)
 *   06  CONTROL: plain files: env:add exits 0 and adds the env
 *   07  env:add with a trailing comma in ports.json: exits 0 and adds the env
 *   08  env:add with a `//` comment line in ports.json: exits 0 and adds the env
 *   09  env:add with a trailing comma in ports.reverse.json: exits 0 and adds the env
 *   10  CONTROL: env:add with ports.json malformed: exits 1 with « ports.json cannot
 *       be used » (the command helper's refusal, #B906)
 *   11  CONTROL: plain files: the framework (`bin/cli start`) is ready and listens
 *   12  the framework with a trailing comma in main.json: ready and listening
 *   13  source: checkIfMain reads main.json with parseJSONWithComments
 *   14  source: env:add reads the ports files with parseJSONWithComments
 *
 * Pre-fix (measured on 48cc6dd11 through the seam below): 02-04, 07-09 and 12-14
 * fail, the five controls pass.
 *
 * Isolation (the daemon-bundle-start-exit-code-b851 shape): a throwaway HOME under
 * os.tmpdir() whose prefix holds `lib/node_modules/gina`, a link to the tree under
 * test, and every command runs through that link, so bin/cli starts its MQ
 * listener and a command that never exits is killed at the spawn timeout instead
 * of passing. The children get HOME, GINA_PREFIX, GINA_RUNDIR, GINA_LOGDIR,
 * GINA_TMPDIR, GINA_PORT, GINA_MQ_PORT and GINA_DEBUG_PORT pinned (the three ports
 * free when the file starts), no other GINA_* variable, no npm prefix and no Node
 * settings from this process, and run in the throwaway HOME. Before the framework
 * arms, settings.json is checked to carry the private ports and the temp run dir.
 * Each arm starts from the home as the setup left it. The framework is this file's
 * own child (`node <install>/bin/cli start`), killed by its handle — never through
 * `gina stop`, which stops every gina framework on the machine.
 *
 * Seam: `B938_GINA_ROOT=<tree>` links THAT tree into the prefix and reads its
 * sources.
 *
 * Run: node --test test/bin/cli-home-files-b938.test.js
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var net    = require('net');
var path   = require('path');
var { spawn, spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var commentStrip = require('../strip-comments');

var TREE      = process.env.B938_GINA_ROOT || path.resolve(__dirname, '..', '..');
var VERSION   = JSON.parse(fs.readFileSync(path.join(TREE, 'package.json'), 'utf8')).version;
var SHORT     = VERSION.split('.').slice(0, 2).join('.');
var FW        = path.join(TREE, 'framework', 'v' + VERSION);

var TMP       = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gina-b938-'));
var FAKE_HOME = path.join(TMP, 'home');
var GINA_HOME = path.join(FAKE_HOME, '.gina');
var PREFIX    = path.join(FAKE_HOME, 'prefix');
var RUN_DIR   = path.join(FAKE_HOME, 'run');
var LOG_DIR   = path.join(FAKE_HOME, 'log');
var TMP_DIR   = path.join(FAKE_HOME, 'tmp');
var SNAPSHOT  = path.join(TMP, 'snapshot');
var PROJ      = 'b938p' + Date.now();
var PROJ_DIR  = path.join(FAKE_HOME, 'proj');
var BUNDLE    = 'demo';
var ENV_NAME  = 'b938e';

// the commands run through the prefix, the path a global install gives them
var INSTALL   = path.join(PREFIX, 'lib', 'node_modules', 'gina');
var CLI       = path.join(INSTALL, 'bin', 'cli');

var CMD_TIMEOUT_MS    = 60000;
var DAEMON_TIMEOUT_MS = 30000;

var CHILD_ENV = {};
var daemonPort = null;
var setupError = null, skipReason = null;
var daemon = null;


/**
 * Removes the terminal colour codes the CLI prints.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function plain(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

/**
 * The last `n` characters of a command's output, for an assertion message.
 *
 * @inner
 * @param {string} s
 * @param {number} [n=1500]
 * @returns {string}
 */
function tail(s, n) { s = String(s || ''); return s.slice(-(n || 1500)); }

/**
 * Reads a JSON file written by gina (plain JSON).
 *
 * @inner
 * @param {string} file
 * @returns {*}
 */
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/**
 * Resolves after `ms` milliseconds.
 *
 * @inner
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

/**
 * A port the kernel just handed out on the loopback, closed again.
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
 * Whether something accepts a TCP connection on `port` on the loopback.
 *
 * @inner
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isTcpPortOpen(port) {
    return new Promise(function (resolve) {
        var sock = new net.Socket();
        sock.setTimeout(800);
        sock.on('connect', function () { sock.destroy(); resolve(true); });
        sock.on('error',   function () { resolve(false); });
        sock.on('timeout', function () { sock.destroy(); resolve(false); });
        sock.connect(port, '127.0.0.1');
    });
}

/**
 * Polls `check` until it returns true or `ms` milliseconds have passed.
 *
 * @inner
 * @param {function(): (boolean|Promise<boolean>)} check
 * @param {number} ms
 * @param {number} [step=200]
 * @returns {Promise<boolean>} the last result of `check`
 */
async function waitFor(check, ms, step) {
    var until = Date.now() + ms;
    while (Date.now() < until) {
        if (await check()) return true;
        await sleep(step || 200);
    }
    return !!(await check());
}

/**
 * Runs an offline gina CLI command through the install link.
 *
 * @inner
 * @param {string[]} args - CLI arguments, starting with the task
 * @returns {{status: (number|null), signal: (string|null), out: string}}
 */
function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), {
        cwd: FAKE_HOME, env: CHILD_ENV, encoding: 'utf8', timeout: CMD_TIMEOUT_MS
    });
    return { status: r.status, signal: r.signal, out: plain((r.stdout || '') + (r.stderr || '')) };
}

/**
 * Rewrites a file of the throwaway home the way a hand edit would.
 *
 * @inner
 * @param {string} file - Absolute path
 * @param {('comma'|'comment'|'malformed')} how - A trailing comma before the last
 *   `}`, a `//` comment line first, or the last `}` removed
 * @returns {string} the new content
 */
function mutate(file, how) {
    var text = fs.readFileSync(file, 'utf8');
    if (how === 'comma') {
        var at = text.lastIndexOf('}'), j = at - 1;
        while (j >= 0 && /\s/.test(text[j])) { j--; }
        text = text.slice(0, j + 1) + ',' + text.slice(j + 1);
    } else if (how === 'comment') {
        text = '// a comment line\n' + text;
    } else if (how === 'malformed') {
        text = text.slice(0, text.lastIndexOf('}'));
    }
    fs.writeFileSync(file, text);
    return text;
}

/**
 * Puts the home and the project's env.json back as the setup left them.
 *
 * @inner
 * @returns {void}
 */
function restore() {
    fs.rmSync(GINA_HOME, { recursive: true, force: true });
    fs.cpSync(path.join(SNAPSHOT, '.gina'), GINA_HOME, { recursive: true });
    fs.copyFileSync(path.join(SNAPSHOT, 'env.json'), path.join(PROJ_DIR, 'env.json'));
    fs.readdirSync(RUN_DIR).forEach(function (f) { fs.rmSync(path.join(RUN_DIR, f), { recursive: true, force: true }); });
}

/**
 * Whether the test env is registered on the project, in projects.json and in the
 * bundle's block of the project's env.json.
 *
 * @inner
 * @returns {{projects: boolean, envJson: boolean}}
 */
function envAdded() {
    var projects = false, envJson = false;
    try { projects = readJSON(path.join(GINA_HOME, 'projects.json'))[PROJ].envs.indexOf(ENV_NAME) > -1; } catch (e) { /* unreadable: false */ }
    try { envJson = Object.prototype.hasOwnProperty.call(readJSON(path.join(PROJ_DIR, 'env.json'))[BUNDLE], ENV_NAME); } catch (e) { /* unreadable: false */ }
    return { projects: projects, envJson: envJson };
}

/**
 * Starts the framework as this file's own child, waits for its ready line and its
 * port, then stops it by its handle.
 *
 * @inner
 * @returns {Promise<{ready: boolean, listening: boolean, exit: ?object, out: string}>}
 */
async function startFramework() {
    var out = '', exit = null;
    daemon = spawn(process.execPath, [CLI, 'start'], { cwd: FAKE_HOME, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    var keep = function (d) { out += d; if (out.length > 400000) out = out.slice(-200000); };
    daemon.stdout.on('data', keep);
    daemon.stderr.on('data', keep);
    daemon.on('exit', function (code, signal) { exit = { code: code, signal: signal }; });
    var ready = await waitFor(function () { return exit !== null || /Framework ready for connections/.test(plain(out)); }, DAEMON_TIMEOUT_MS, 200)
        && exit === null;
    var listening = ready && await waitFor(function () { return isTcpPortOpen(daemonPort); }, 5000, 200);
    await stopFramework();
    return { ready: ready, listening: listening, exit: exit, out: plain(out) };
}

/**
 * Stops the framework child started by startFramework(), if it still runs, and waits
 * for its port to close.
 *
 * @inner
 * @returns {Promise<void>}
 */
async function stopFramework() {
    var child = daemon;
    daemon = null;
    if (!child) return;
    var gone = function () { return child.exitCode !== null || child.signalCode !== null; };
    if (!gone()) {
        try { child.kill('SIGTERM'); } catch (e) { /* gone */ }
        if (!(await waitFor(gone, 5000, 100))) {
            try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
            await waitFor(gone, 3000, 100);
        }
    }
    await waitFor(async function () { return !(await isTcpPortOpen(daemonPort)); }, 5000, 200);
}

/**
 * Drops comments from a source text: block comments and whole-line `//` comments.
 *
 * @inner
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
    return commentStrip.lines(src);
}

/**
 * Whether the arm may run: false (and the arm skipped) on a skipped file; an
 * assertion error when the setup failed.
 *
 * @inner
 * @param {object} t - The node:test context
 * @returns {boolean}
 */
function ready(t) {
    if (skipReason) { t.skip(skipReason); return false; }
    assert.equal(setupError, null, 'setup failed: ' + setupError);
    return true;
}


describe('#B938 - the CLI and the framework start accept a comment or a trailing comma in main.json and the ports files', function () {

    before(async function () {
        if (process.platform === 'win32') { skipReason = 'the CLI paths here are Unix-centric (win32 not supported)'; return; }

        Object.keys(process.env).forEach(function (k) {
            if (!/^(GINA_|NODE_OPTIONS$|NODE_ENV$|NODE_SCOPE$|NPM_CONFIG_PREFIX$|npm_config_prefix$)/.test(k)) {
                CHILD_ENV[k] = process.env[k];
            }
        });
        daemonPort = await freePort();
        Object.assign(CHILD_ENV, {
            HOME            : FAKE_HOME,
            GINA_LOG_STDOUT : 'true',
            GINA_PREFIX     : PREFIX,
            GINA_RUNDIR     : RUN_DIR,
            GINA_LOGDIR     : LOG_DIR,
            GINA_TMPDIR     : TMP_DIR,
            GINA_PORT       : String(daemonPort),
            GINA_MQ_PORT    : String(await freePort()),
            GINA_DEBUG_PORT : String(await freePort())
        });

        [PROJ_DIR, path.dirname(INSTALL), RUN_DIR, LOG_DIR, TMP_DIR].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
        fs.symlinkSync(TREE, INSTALL, 'dir');

        var r = runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) { setupError = 'project:add did not register @' + PROJ + ':\n' + tail(r.out); return; }
        r = runCli(['bundle:add', BUNDLE, '@' + PROJ]);
        var reversePath = path.join(GINA_HOME, 'ports.reverse.json');
        if (!fs.existsSync(reversePath) || !readJSON(reversePath)[BUNDLE + '@' + PROJ]) { setupError = 'bundle:add did not register ' + BUNDLE + '@' + PROJ + ':\n' + tail(r.out); return; }

        // nothing below may ever reach a framework other than this file's own
        var settingsPath = path.join(GINA_HOME, SHORT, 'settings.json'), settings = null;
        try { settings = readJSON(settingsPath); } catch (e) { setupError = 'could not read ' + settingsPath + ': ' + e.message; return; }
        if (String(settings.port) !== CHILD_ENV.GINA_PORT) { setupError = 'settings.json port is ' + settings.port + ', not ' + CHILD_ENV.GINA_PORT; return; }
        if (String(settings.mq_port) !== CHILD_ENV.GINA_MQ_PORT) { setupError = 'settings.json mq_port is ' + settings.mq_port + ', not ' + CHILD_ENV.GINA_MQ_PORT; return; }
        if (typeof settings.rundir !== 'string' || fs.realpathSync(settings.rundir) !== fs.realpathSync(RUN_DIR)) { setupError = 'settings.json rundir is ' + settings.rundir + ', not ' + RUN_DIR; return; }

        fs.mkdirSync(SNAPSHOT, { recursive: true });
        fs.cpSync(GINA_HOME, path.join(SNAPSHOT, '.gina'), { recursive: true });
        fs.copyFileSync(path.join(PROJ_DIR, 'env.json'), path.join(SNAPSHOT, 'env.json'));
    });

    after(async function () {
        await stopFramework();
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or not empty: leave it */ }
    });

    it('01  CONTROL: plain files: bundle:list exits 0', { timeout: CMD_TIMEOUT_MS + 10000 }, function (t) {
        if (!ready(t)) return;
        restore();
        var r = runCli(['bundle:list', '@' + PROJ]);
        assert.equal(r.status, 0, 'exit ' + r.status + ' (' + r.signal + '):\n' + tail(r.out));
        assert.doesNotMatch(r.out, /SyntaxError|cannot be used/, tail(r.out));
    });

    it('02  main.json with a trailing comma: bundle:list exits 0, a warning names it, the file is rewritten', { timeout: CMD_TIMEOUT_MS + 10000 }, function (t) {
        if (!ready(t)) return;
        restore();
        var file = path.join(GINA_HOME, 'main.json');
        mutate(file, 'comma');
        var r = runCli(['bundle:list', '@' + PROJ]);
        assert.equal(r.status, 0, 'exit ' + r.status + ' (' + r.signal + '):\n' + tail(r.out));
        assert.ok(r.out.indexOf('trailing comma in `' + file + '`') > -1, 'no warning naming main.json:\n' + tail(r.out));
        assert.doesNotThrow(function () { readJSON(file); }, 'main.json is still not plain JSON after the command');
    });

    it('03  main.json with a // comment line: bundle:list exits 0', { timeout: CMD_TIMEOUT_MS + 10000 }, function (t) {
        if (!ready(t)) return;
        restore();
        mutate(path.join(GINA_HOME, 'main.json'), 'comment');
        var r = runCli(['bundle:list', '@' + PROJ]);
        assert.equal(r.status, 0, 'exit ' + r.status + ' (' + r.signal + '):\n' + tail(r.out));
        assert.doesNotMatch(r.out, /SyntaxError/, tail(r.out));
    });

    it('04  main.json malformed: bundle:list exits 1 with « main.json cannot be used », the file left as it was', { timeout: CMD_TIMEOUT_MS + 10000 }, function (t) {
        if (!ready(t)) return;
        restore();
        var file = path.join(GINA_HOME, 'main.json');
        var text = mutate(file, 'malformed');
        var r = runCli(['bundle:list', '@' + PROJ]);
        assert.equal(r.status, 1, 'exit ' + r.status + ' (' + r.signal + '):\n' + tail(r.out));
        assert.ok(r.out.indexOf('main.json cannot be used: could not parse `' + file + '`') > -1, 'no « main.json cannot be used » line:\n' + tail(r.out));
        assert.equal(fs.readFileSync(file, 'utf8'), text, 'main.json was rewritten');
    });

    it('05  CONTROL: projects.json with a trailing comma: bundle:list exits 0', { timeout: CMD_TIMEOUT_MS + 10000 }, function (t) {
        if (!ready(t)) return;
        restore();
        mutate(path.join(GINA_HOME, 'projects.json'), 'comma');
        var r = runCli(['bundle:list', '@' + PROJ]);
        assert.equal(r.status, 0, 'exit ' + r.status + ' (' + r.signal + '):\n' + tail(r.out));
    });

    it('06  CONTROL: plain files: env:add exits 0 and adds the env', { timeout: CMD_TIMEOUT_MS + 10000 }, function (t) {
        if (!ready(t)) return;
        restore();
        var r = runCli(['env:add', ENV_NAME, '@' + PROJ]);
        assert.equal(r.status, 0, 'exit ' + r.status + ' (' + r.signal + '):\n' + tail(r.out));
        assert.match(r.out, new RegExp('environment \\[ ' + ENV_NAME + ' \\] created'), tail(r.out));
        assert.deepEqual(envAdded(), { projects: true, envJson: true });
    });

    [
        ['07', 'ports.json', 'comma', 'a trailing comma'],
        ['08', 'ports.json', 'comment', 'a // comment line'],
        ['09', 'ports.reverse.json', 'comma', 'a trailing comma']
    ].forEach(function (arm) {
        it(arm[0] + '  env:add with ' + arm[3] + ' in ' + arm[1] + ': exits 0 and adds the env', { timeout: CMD_TIMEOUT_MS + 10000 }, function (t) {
            if (!ready(t)) return;
            restore();
            mutate(path.join(GINA_HOME, arm[1]), arm[2]);
            var r = runCli(['env:add', ENV_NAME, '@' + PROJ]);
            assert.equal(r.status, 0, 'exit ' + r.status + ' (' + r.signal + '):\n' + tail(r.out));
            assert.doesNotMatch(r.out, /SyntaxError/, tail(r.out));
            assert.match(r.out, new RegExp('environment \\[ ' + ENV_NAME + ' \\] created'), tail(r.out));
            assert.deepEqual(envAdded(), { projects: true, envJson: true });
        });
    });

    it('10  CONTROL: env:add with ports.json malformed: exits 1 with « ports.json cannot be used »', { timeout: CMD_TIMEOUT_MS + 10000 }, function (t) {
        if (!ready(t)) return;
        restore();
        mutate(path.join(GINA_HOME, 'ports.json'), 'malformed');
        var r = runCli(['env:add', ENV_NAME, '@' + PROJ]);
        assert.equal(r.status, 1, 'exit ' + r.status + ' (' + r.signal + '):\n' + tail(r.out));
        assert.ok(r.out.indexOf('ports.json cannot be used: could not parse `' + path.join(GINA_HOME, 'ports.json') + '`') > -1, tail(r.out));
        assert.deepEqual(envAdded(), { projects: false, envJson: false });
    });

    it('11  CONTROL: plain files: the framework is ready and listens', { timeout: DAEMON_TIMEOUT_MS + 25000 }, async function (t) {
        if (!ready(t)) return;
        restore();
        var d = await startFramework();
        assert.ok(d.ready, 'no ready line (exit ' + JSON.stringify(d.exit) + '):\n' + tail(d.out));
        assert.ok(d.listening, 'nothing listens on ' + daemonPort + ':\n' + tail(d.out));
    });

    it('12  the framework with a trailing comma in main.json: ready and listening', { timeout: DAEMON_TIMEOUT_MS + 25000 }, async function (t) {
        if (!ready(t)) return;
        restore();
        var file = path.join(GINA_HOME, 'main.json');
        mutate(file, 'comma');
        var d = await startFramework();
        assert.ok(d.ready, 'no ready line (exit ' + JSON.stringify(d.exit) + '):\n' + tail(d.out));
        assert.ok(d.listening, 'nothing listens on ' + daemonPort + ':\n' + tail(d.out));
        assert.ok(d.out.indexOf('trailing comma in `' + file + '`') > -1, 'no warning naming main.json:\n' + tail(d.out));
    });

    it('13  source: checkIfMain reads main.json with parseJSONWithComments', function () {
        var src   = fs.readFileSync(path.join(FW, 'lib', 'cmd', 'framework', 'init.js'), 'utf8');
        var START = 'self.checkIfMain = function(done) {';
        var END   = 'self.checkArch = function(done) {';
        assert.equal(src.split(START).length, 2, 'the checkIfMain declaration must be unique');
        assert.equal(src.split(END).length, 2, 'the checkArch declaration must be unique');
        var raw  = src.slice(src.indexOf(START), src.indexOf(END));
        var code = stripComments(raw);
        assert.ok(raw.indexOf('require(target)') > -1, 'CONTROL: the raw text names require(target), so the strip below has something to remove');
        assert.equal(code.indexOf('require(target)'), -1, 'checkIfMain still reads main.json with require()');
        assert.ok(code.indexOf("parseJSONWithComments(fs.readFileSync(target, 'utf8'), target)") > -1, 'checkIfMain does not read main.json with parseJSONWithComments');
        assert.ok(code.indexOf("'main.json cannot be used: '") > -1, 'checkIfMain does not refuse an unusable main.json by name');
    });

    it('14  source: env:add reads the ports files with parseJSONWithComments', function () {
        var raw  = fs.readFileSync(path.join(FW, 'lib', 'cmd', 'env', 'add.js'), 'utf8');
        var code = stripComments(raw);
        assert.ok(raw.indexOf('require(self.portsPath)') > -1, 'CONTROL: the raw text names require(self.portsPath), so the strip below has something to remove');
        ['ports = require(', 'require(self.portsPath)', 'require(self.portsReversePath)'].forEach(function (needle) {
            assert.equal(code.indexOf(needle), -1, 'env:add still reads a ports file with ' + needle);
        });
        assert.equal(code.split("parseJSONWithComments(fs.readFileSync(").length - 1, 3, 'expected three parseJSONWithComments reads of the ports files');
    });
});
