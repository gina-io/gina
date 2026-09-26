/**
 * #B680 + #B681 — the first commands after a minor crossing (a shortVersion bump,
 * e.g. 0.6 → 0.7).
 *
 * Drives the REAL bin/cli against an isolated home. A fresh home is created at the
 * tree's own short version, then rewritten into a previous-short home (every
 * per-version main.json dict re-keyed to the previous short, settings.json moved,
 * the sqlite store removed so init reads the JSON files), and the tree then crosses
 * into it:
 *
 *   01 (#B681) — the first command after the crossing exits 0 and every per-version
 *        main.json dict carries the new short. Before the fix it exited 1 once:
 *        checkIfMain wrote a migrated COPY of main.json while later readers in the
 *        same process got the stale object from Node's require cache.
 *   02 (#B680) — a registrar ran first (bin/cli's bundle|project:start sync, a
 *        gina-container boot or post_install's end() writes frameworks[<new>] before
 *        init runs): the next command still migrates the dicts and exits 0, and so
 *        does the one after. Before the fix the migration was keyed on
 *        frameworks[<new>] being absent, so it never ran and every later command
 *        exited 1 until main.json and gina.db were repaired by hand.
 *   03 (control) — an already-migrated home: exit 0 and no migration.
 *
 * Why a real spawn: both defects live in init.js's interplay with Node's require
 * cache and with state another process wrote; an inline replica cannot see either
 * (test/lib/init-migration.test.js keeps the replica-level cases).
 *
 * Isolation: HOME points at a temp dir (GINA_HOMEDIR derives from it), every
 * inherited GINA_* variable is removed, and GINA_PREFIX, GINA_RUNDIR, GINA_LOGDIR,
 * GINA_TMPDIR and GINA_MQ_PORT are pinned into the temp home. The prefix pin alone
 * does not keep the default run/log dirs inside the temp home — checkIfMain
 * re-exports GINA_PREFIX from main.json's def_prefix, and the defaults derive from
 * it — so the three dirs are pinned explicitly.
 */

'use strict';

var fs   = require('fs');
var os   = require('os');
var net  = require('net');
var path = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var GINA_ROOT    = path.resolve(__dirname, '..', '..');
var CLI          = path.join(GINA_ROOT, 'bin', 'cli');
var VERSION      = require(path.join(GINA_ROOT, 'package.json')).version;
var NEW_SHORT    = VERSION.split('.').slice(0, 2).join('.');
var PREV_SHORT   = previousShort(NEW_SHORT);
var PREV_VERSION = PREV_SHORT + '.99';

var TMP       = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-minor-crossing-'));
var SEED_HOME = path.join(TMP, 'seed');
var MQ_PORT   = null;

/**
 * Returns a short version strictly below `short` by parseFloat, the ordering
 * init.js uses to pick the previous short.
 *
 * @param {string} short - e.g. '0.7'
 * @returns {string} e.g. '0.6' ('1.0' → '0.9')
 * @example
 * previousShort('0.7'); // '0.6'
 */
function previousShort(short) {
    var parts = short.split('.').map(Number);
    if (parts[1] > 0) {
        return parts[0] + '.' + (parts[1] - 1);
    }
    return (parts[0] - 1) + '.9';
}

/**
 * Finds a free TCP port on 127.0.0.1, so a CI checkout whose bin/cli path matches
 * the MQ listener pattern binds a private port instead of the default 8125.
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
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(home, args) {
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
    });
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
 * @param {string} file
 * @returns {object}
 */
function readJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string} file
 * @param {object} data
 */
function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 4));
}

/**
 * Lists main.json's per-version dicts: plain objects with an entry for `short`
 * (the `frameworks` registry is listed separately by the callers).
 *
 * @param {object} main - Parsed main.json
 * @param {string} short
 * @returns {string[]}
 */
function perVersionKeys(main, short) {
    return Object.keys(main).filter(function(k) {
        var v = main[k];
        return k !== 'frameworks' && v !== null && typeof v === 'object' && !Array.isArray(v)
            && Object.prototype.hasOwnProperty.call(v, short);
    });
}

/**
 * Builds a previous-short home from the seed: every per-version dict re-keyed from
 * the new short to the previous one, settings.json moved, the sqlite store removed.
 *
 * @param {string} name - Directory name under the temp root
 * @param {{registered: boolean}} [opts] - registered: also write frameworks[<new>]
 *        and def_framework the way bin/cli's bundle|project:start sync does
 * @returns {string} The fake HOME
 */
function makePrevHome(name, opts) {
    var home = path.join(TMP, name);
    fs.cpSync(path.join(SEED_HOME, '.gina'), path.join(home, '.gina'), { recursive: true });
    var g = path.join(home, '.gina');

    var m = readJSON(path.join(g, 'main.json'));
    perVersionKeys(m, NEW_SHORT).forEach(function(k) {
        m[k][PREV_SHORT] = m[k][NEW_SHORT];
        delete m[k][NEW_SHORT];
    });
    m.frameworks = {};
    m.frameworks[PREV_SHORT] = [PREV_VERSION];
    m.def_framework = PREV_VERSION;
    if (opts && opts.registered) {
        m.frameworks[NEW_SHORT] = [VERSION];
        m.def_framework = VERSION;
    }
    writeJSON(path.join(g, 'main.json'), m);

    var s = readJSON(path.join(g, NEW_SHORT, 'settings.json'));
    s.version = PREV_VERSION;
    s.def_framework = PREV_VERSION;
    fs.mkdirSync(path.join(g, PREV_SHORT), { recursive: true });
    writeJSON(path.join(g, PREV_SHORT, 'settings.json'), s);
    fs.rmSync(path.join(g, NEW_SHORT), { recursive: true, force: true });
    fs.rmSync(path.join(g, 'gina.db'), { force: true });
    return home;
}

describe('minor crossing: the first commands after a shortVersion bump (#B680, #B681)', function() {

    before(async function() {
        MQ_PORT = await freePort();
        var r = run(SEED_HOME, ['version']);
        assert.equal(r.status, 0, 'seeding a fresh home failed\n' + out(r));
        var m = readJSON(path.join(SEED_HOME, '.gina', 'main.json'));
        assert.ok(m.frameworks && m.frameworks[NEW_SHORT], 'the fresh home has no frameworks[' + NEW_SHORT + ']');
        assert.ok(perVersionKeys(m, NEW_SHORT).length > 10, 'the fresh home has too few per-version dicts to model a crossing');
    });

    after(function() {
        fs.rmSync(TMP, { recursive: true, force: true });
    });

    it('01 - #B681: the first command after the crossing exits 0 and migrates every per-version dict', function() {
        var home = makePrevHome('arm-b681');
        var before = readJSON(path.join(home, '.gina', 'main.json'));
        var expected = perVersionKeys(before, PREV_SHORT);

        var r = run(home, ['version']);
        assert.equal(r.status, 0, out(r));
        assert.ok(r.stdout.indexOf('Gina I/O v' + VERSION) > -1, 'no version banner\n' + out(r));
        assert.ok(r.stdout.indexOf('Migrating main.json: ' + PREV_SHORT) > -1, 'the migration did not run\n' + out(r));

        var m = readJSON(path.join(home, '.gina', 'main.json'));
        var missing = expected.filter(function(k) { return !Object.prototype.hasOwnProperty.call(m[k], NEW_SHORT); });
        assert.deepEqual(missing, [], 'dicts without ' + NEW_SHORT + ': ' + missing.join(', '));
        assert.ok(Array.isArray(m.frameworks[NEW_SHORT]), 'frameworks[' + NEW_SHORT + '] not seeded');
    });

    it('02 - #B680: a start that registered the new short first does not arm a permanent failure', function() {
        var home = makePrevHome('arm-b680', { registered: true });
        var before = readJSON(path.join(home, '.gina', 'main.json'));
        var expected = perVersionKeys(before, PREV_SHORT);
        assert.ok(expected.indexOf('def_culture') > -1, 'control: the previous-short home carries def_culture');
        assert.ok(!Object.prototype.hasOwnProperty.call(before.def_culture, NEW_SHORT), 'control: def_culture lacks ' + NEW_SHORT + ' before the first command');

        var r1 = run(home, ['version']);
        assert.equal(r1.status, 0, 'first command\n' + out(r1));
        var r2 = run(home, ['version']);
        assert.equal(r2.status, 0, 'second command\n' + out(r2));

        var m = readJSON(path.join(home, '.gina', 'main.json'));
        var missing = expected.filter(function(k) { return !Object.prototype.hasOwnProperty.call(m[k], NEW_SHORT); });
        assert.deepEqual(missing, [], 'dicts without ' + NEW_SHORT + ': ' + missing.join(', '));
        assert.ok(m.frameworks[NEW_SHORT].indexOf(VERSION) > -1, 'the registrar\'s frameworks[' + NEW_SHORT + '] entry was lost');
    });

    it('03 - control: an already-migrated home runs without migrating', function() {
        var r = run(SEED_HOME, ['version']);
        assert.equal(r.status, 0, out(r));
        assert.equal(r.stdout.indexOf('Migrating main.json'), -1, 'an up-to-date home was migrated\n' + out(r));
    });
});
