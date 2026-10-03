/**
 * #B584 — a GINA_VERSION that names no installed framework is refused before any
 * state is written.
 *
 * GINA_VERSION reaches the CLI two ways: exported in the environment, or promoted
 * from a `--version=<v>` flag (the man page documents both). bin/cli's existing
 * « is not installed » guard runs before either is visible, so a value naming no
 * installed framework went on to the framework init, which migrated main.json to
 * that phantom version (a `latest` key in every per-version dict, an empty
 * `<home>/latest/`) and let the command carry on. And the flag promotion turned
 * the first hyphen of a hyphen-free flag name's VALUE into `_`, so
 * `--version=0.7.2-alpha.2` reached GINA_VERSION as `0.7.2_alpha.2`.
 *
 * Drives the REAL bin/cli against an isolated home (the shape of
 * test/bin/minor-crossing-init.test.js):
 *
 *   01 — exported GINA_VERSION=latest: exit 1 with the « is not installed »
 *        message, and main.json, gina.db and the home's directories untouched.
 *   02 — exported GINA_VERSION=0.0.1 (numeric, not installed): the same, and the
 *        message names the command that installs it.
 *   03 — `--version=latest` on the argv: the same refusal.
 *   04 — `--version=<the installed package version>`: exit 0, and the version
 *        banner prints the value exactly as given (hyphens kept).
 *   05 — control: exported GINA_VERSION=<the installed package version>: exit 0.
 *   06 — control: GINA_VERSION unset: exit 0.
 *   07 — filterArgs() itself: a promoted value keeps its hyphens; the flag-name
 *        rule (first hyphen → `_`) is unchanged.
 *
 * Isolation: HOME points at a temp dir (GINA_HOMEDIR derives from it), every
 * inherited GINA_* variable is removed, and GINA_PREFIX, GINA_RUNDIR, GINA_LOGDIR,
 * GINA_TMPDIR and GINA_MQ_PORT are pinned into the temp home.
 */

'use strict';

var crypto = require('crypto');
var fs   = require('fs');
var os   = require('os');
var net  = require('net');
var path = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');

var GINA_ROOT = path.resolve(__dirname, '..', '..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var VERSION   = require(path.join(GINA_ROOT, 'package.json')).version;

var TMP       = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-version-refusal-'));
var SEED_HOME = path.join(TMP, 'seed');
var MQ_PORT   = null;

/**
 * Finds a free TCP port on 127.0.0.1, so a checkout whose bin/cli path matches the
 * MQ listener pattern binds a private port instead of the default 8125.
 *
 * @returns {Promise<number>}
 */
function freePort() {
    return new Promise(function(resolve, reject) {
        var srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', function() {
            var port = srv.address().port;
            srv.close(function() { resolve(port); });
        });
    });
}

/**
 * Runs bin/cli in an isolated home.
 *
 * @param {string} home - The fake HOME (its `.gina` is the gina home)
 * @param {string[]} args - CLI arguments, e.g. ['version']
 * @param {object} [extraEnv] - Variables added after the GINA_* cleanup, e.g. { GINA_VERSION: 'latest' }
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(home, args, extraEnv) {
    var env = Object.assign({}, process.env);
    Object.keys(env).forEach(function(k) {
        if (/^GINA_/.test(k)) delete env[k];
    });
    delete env.NPM_CONFIG_PREFIX;
    delete env.npm_config_prefix;
    ['prefix', 'run', 'log', 'tmp'].forEach(function(d) {
        fs.mkdirSync(path.join(home, d), { recursive: true });
    });
    Object.assign(env, {
        HOME         : home,
        GINA_PREFIX  : path.join(home, 'prefix'),
        GINA_RUNDIR  : path.join(home, 'run'),
        GINA_LOGDIR  : path.join(home, 'log'),
        GINA_TMPDIR  : path.join(home, 'tmp'),
        GINA_MQ_PORT : String(MQ_PORT)
    }, extraEnv || {});
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: env, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * @param {{status: number, stdout: string, stderr: string}} r
 * @returns {string} A diagnostic block for assertion messages
 */
function out(r) {
    return 'rc=' + r.status + '\n--- stdout\n' + r.stdout.slice(-1500) + '\n--- stderr\n' + r.stderr.slice(-1500);
}

/**
 * Copies the seeded home into a fresh directory, so each arm starts from the same
 * state and its writes are its own.
 *
 * @param {string} name - Directory name under the temp root
 * @returns {string} The fake HOME
 */
function cloneSeed(name) {
    var home = path.join(TMP, name);
    fs.cpSync(path.join(SEED_HOME, '.gina'), path.join(home, '.gina'), { recursive: true });
    return home;
}

/**
 * A fingerprint of the gina home: the md5 of main.json and gina.db, and the sorted
 * list of its top-level entries.
 *
 * @param {string} home - The fake HOME
 * @returns {string}
 */
function fingerprint(home) {
    var g = path.join(home, '.gina');
    var md5 = function(f) {
        return fs.existsSync(f) ? crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex') : 'absent';
    };
    return 'main.json=' + md5(path.join(g, 'main.json'))
        + ' gina.db=' + md5(path.join(g, 'gina.db'))
        + ' entries=' + fs.readdirSync(g).sort().join(',');
}

/**
 * Asserts a refused run: exit 1, the « is not installed » message naming the
 * value, no migration, and the home exactly as it was.
 *
 * @param {{status: number, stdout: string, stderr: string}} r
 * @param {string} value - The GINA_VERSION value that was refused
 * @param {string} before - fingerprint() of the home before the run
 * @param {string} home - The fake HOME
 */
function assertRefused(r, value, before, home) {
    assert.equal(r.status, 1, 'the command was not refused\n' + out(r));
    assert.ok(r.stderr.indexOf('gina: framework version ' + value + ' is not installed') > -1, 'no « is not installed » message for ' + value + '\n' + out(r));
    assert.equal(r.stdout.indexOf('Migrating main.json'), -1, 'main.json was migrated\n' + out(r));
    assert.equal(fingerprint(home), before, 'the gina home changed although the command was refused');
}

describe('#B584 — GINA_VERSION naming no installed framework is refused before any state is written', function() {

    before(async function() {
        MQ_PORT = await freePort();
        var r = run(SEED_HOME, ['version']);
        assert.equal(r.status, 0, 'seeding a fresh home failed\n' + out(r));
        assert.ok(fs.existsSync(path.join(SEED_HOME, '.gina', 'main.json')), 'the fresh home has no main.json');
    });

    after(function() {
        fs.rmSync(TMP, { recursive: true, force: true });
    });

    it('01 - an exported GINA_VERSION=latest is refused and writes nothing', function() {
        var home = cloneSeed('arm-01');
        var before = fingerprint(home);
        var r = run(home, ['version'], { GINA_VERSION: 'latest' });
        assertRefused(r, 'latest', before, home);
        assert.equal(fs.existsSync(path.join(home, '.gina', 'latest')), false, 'a <home>/latest/ directory was created');
    });

    it('02 - an exported numeric version that is not installed is refused, with the command that installs it', function() {
        var home = cloneSeed('arm-02');
        var before = fingerprint(home);
        var r = run(home, ['version'], { GINA_VERSION: '0.0.1' });
        assertRefused(r, '0.0.1', before, home);
        assert.ok(r.stderr.indexOf('framework:add 0.0.1') > -1, 'no install hint for a version-shaped value\n' + out(r));
    });

    it('03 - --version=latest on the argv is refused and writes nothing', function() {
        var home = cloneSeed('arm-03');
        var before = fingerprint(home);
        var r = run(home, ['version', '--version=latest']);
        assertRefused(r, 'latest', before, home);
    });

    it('04 - --version=<the installed version> runs, and its value keeps its hyphens', function() {
        var home = cloneSeed('arm-04');
        var r = run(home, ['version', '--version=' + VERSION]);
        assert.equal(r.status, 0, out(r));
        assert.ok(r.stdout.indexOf('Gina I/O v' + VERSION + ' ') > -1, 'the banner does not print v' + VERSION + ' exactly\n' + out(r));
    });

    it('05 - control: an exported GINA_VERSION naming the installed version runs', function() {
        var home = cloneSeed('arm-05');
        var r = run(home, ['version'], { GINA_VERSION: VERSION });
        assert.equal(r.status, 0, out(r));
        assert.ok(r.stdout.indexOf('Gina I/O v' + VERSION + ' ') > -1, 'no version banner\n' + out(r));
        assert.equal(r.stdout.indexOf('Migrating main.json'), -1, 'main.json was migrated\n' + out(r));
    });

    it('06 - control: with GINA_VERSION unset the command runs', function() {
        var home = cloneSeed('arm-06');
        var r = run(home, ['version']);
        assert.equal(r.status, 0, out(r));
        assert.ok(r.stdout.indexOf('Gina I/O v' + VERSION + ' ') > -1, 'no version banner\n' + out(r));
    });
});

describe('#B584 — filterArgs() keeps a promoted value as given', function() {

    var origArgv, origGina, savedEnv;

    before(function() {
        require(path.join(GINA_ROOT, 'utils', 'helper'));
    });

    beforeEach(function() {
        origArgv = process.argv;
        origGina = process.gina;
        process.gina = {};
        // filterArgs() moves every GINA_* variable out of process.env: keep this process's own.
        savedEnv = {};
        Object.keys(process.env).forEach(function(k) {
            if (/^GINA_/.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
        });
    });

    afterEach(function() {
        process.argv = origArgv;
        process.gina = origGina;
        Object.keys(savedEnv).forEach(function(k) { process.env[k] = savedEnv[k]; });
    });

    it('07 - a hyphen-free flag name keeps its value\'s hyphens; a hyphenated name is still normalised', function() {
        process.argv = ['node', 'cli', 'framework:version', '--version=9.9.9-beta.1', '--plainkey=a-b', '--logs-path=/a/b-c', '--user-key=x-y-z'];
        filterArgs();// jshint ignore:line
        assert.equal(process.gina['GINA_VERSION'], '9.9.9-beta.1', 'the --version value was rewritten');
        assert.equal(process.gina['GINA_PLAINKEY'], 'a-b', 'a hyphen-free name\'s value was rewritten');
        // controls: the first hyphen of a hyphenated name is the one the rule normalises, so these never changed
        assert.equal(process.gina['GINA_LOGS_PATH'], '/a/b-c');
        assert.equal(process.gina['USER_KEY'], 'x-y-z');
    });
});
