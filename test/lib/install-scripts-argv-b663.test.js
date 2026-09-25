/**
 * #B663 — the install scripts start their child processes from argument vectors,
 * never from a shell command line.
 *
 * `script/pre_install.js` and `script/post_install.js` spliced paths into shell
 * command lines unquoted. For a user whose home path contains a space (the
 * documented `npm install -g gina --prefix=~/.npm-global` install), a first
 * install failed:
 *  - pre_install ran `chown -R $(whoami) <home>/.gina` right after creating that
 *    directory — a no-op that could only fail — and exited 1;
 *  - post_install created `~/.profile` through a runner that splits its command
 *    line on spaces, then `source`d the profile through bash (in a child that
 *    exits at once, so it never reached the user's shell), and exited 1;
 * and the `npm config get prefix` / `npm list` probes and the two `framework:set`
 * calls failed silently (caught) under such paths.
 *
 * Sections:
 *   01 — pre_install.js (comment-stripped source pins)
 *   02 — post_install.js (comment-stripped source pins)
 *   03 — live: pre_install.js run from a scratch copy, with the home, the npm
 *        prefix and an npm stand-in all under paths containing a space (the
 *        stand-in records every call it gets); CONTROL — the same run with no
 *        space anywhere.
 *
 * Red-first: on the pre-change scripts every 01 and 02 pin fails except 02's
 * raw-text check (it only proves the comment strip), and 03's run exits 1 on
 * `chown: …/Home: No such file or directory`; the CONTROL passes on both.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');

var REPO     = path.resolve(__dirname, '../..');
var PRE_RAW  = fs.readFileSync(path.join(REPO, 'script/pre_install.js'), 'utf8');
var POST_RAW = fs.readFileSync(path.join(REPO, 'script/post_install.js'), 'utf8');

/**
 * A script without its whole-line comments, so a pin never matches a line kept
 * as a comment or the text explaining the fix.
 *
 * @inner
 * @param {string} src - Script source
 * @returns {string} The source without `//`, `/*` and ` *` lines
 */
function active(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

var PRE  = active(PRE_RAW);
var POST = active(POST_RAW);

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

// the #B126-guarded prefix probe, as an argument vector
var PROBE_RE = /execFileSync\(\s*'npm'\s*,\s*\[\s*'config'\s*,\s*'get'\s*,\s*'prefix'\s*,\s*'--quiet'\s*\]\s*\)/;
// the installed-gina probe: the prefix is one argument
var LIST_RE  = /cmd\s*=\s*\[\s*'list'\s*,\s*'gina'\s*,\s*'--long'\s*,\s*'--json'\s*,\s*'--prefix='\s*\+\s*self\.prefix\s*\]/;


// ---------------------------------------------------------------------------
// 01 — pre_install.js
// ---------------------------------------------------------------------------
describe('01 - pre_install.js starts no shell (comment-stripped source)', function () {

    it('requires execFileSync only, and calls neither execSync nor $(which …)', function () {
        assert.match(PRE, /var \{ execFileSync \} = require\('child_process'\);/);
        assert.equal(PRE.indexOf('execSync('), -1, 'no execSync call');
        assert.equal(PRE.indexOf('$(which'), -1, 'no $(which …) substitution');
    });

    it('the pre-change lines survive only as comments (the strip is real)', function () {
        assert.ok(PRE_RAW.indexOf("execSync('$(which npm) config get prefix --quiet')") > -1, 'kept as a comment');
        assert.ok(PRE_RAW.indexOf("'chown -R $(whoami) '+ ginaHomeDir") > -1, 'kept as a comment');
        assert.equal(PRE.indexOf("'chown -R $(whoami) '+ ginaHomeDir"), -1, 'not live');
    });

    it('the npm prefix probe is an argument vector', function () {
        assert.match(PRE, PROBE_RE);
    });

    it('`npm list` gets the prefix as ONE argument, and -g as its own', function () {
        var blk = between(PRE, 'var pkg = null, pkgObj = null, cmd = null;', 'catch(err)');
        assert.match(blk, LIST_RE);
        assert.match(blk, /cmd\.push\(\s*'-g'\s*\)/);
        assert.match(blk, /pkg\s*=\s*execFileSync\(\s*'npm'\s*,\s*cmd\s*\)/);
    });

    it('checkRequiredFolders still creates ~/.gina, without the chown', function () {
        var blk = between(PRE, 'self.checkRequiredFolders = function', 'self.checkIfGinaIsAlreadyInstalled');
        assert.ok(blk.indexOf('fs.mkdirSync(ginaHomeDir)') > -1, 'the mkdir stays');
        assert.equal(blk.indexOf('chown'), -1, 'no chown');
    });
});


// ---------------------------------------------------------------------------
// 02 — post_install.js
// ---------------------------------------------------------------------------
describe('02 - post_install.js builds no shell line from a path (comment-stripped source)', function () {

    it('requires execFileSync beside execSync', function () {
        assert.match(POST, /const \{ execSync, execFileSync \} = require\('child_process'\);/);
    });

    it('the npm prefix probe is an argument vector (the twin of pre_install\'s)', function () {
        assert.match(POST, PROBE_RE);
        assert.equal(POST.indexOf('$(which'), -1, 'no $(which …) substitution');
    });

    it('`npm list` gets the prefix as ONE argument, and -g as its own', function () {
        var blk = between(POST, 'var pkg = null, pkgObj = null, cmd = null;', 'catch(err)');
        assert.match(blk, LIST_RE);
        assert.match(blk, /cmd\.push\(\s*'-g'\s*\)/);
        assert.match(blk, /pkg\s*=\s*execFileSync\(\s*'npm'\s*,\s*cmd\s*\)/);
    });

    it('updateUserProfile creates ~/.profile with fs, and no longer sources it', function () {
        var blk = between(POST, 'self.updateUserProfile = async function', 'var restoreSymlinks = function');
        assert.match(blk, /fs\.appendFileSync\(\s*profilePath\s*,\s*''\s*\)/, '~/.profile is created with fs');
        assert.equal(blk.indexOf('promisify(run)'), -1, 'no task.js run() (it splits its command line on spaces)');
        assert.equal(blk.indexOf("'touch "), -1, 'no touch command line');
        assert.equal(blk.indexOf('source '), -1, 'no `source` of the profile');
    });

    it('the pre-change profile lines survive only as comments (the strip is real)', function () {
        var raw = between(POST_RAW, 'self.updateUserProfile = async function', 'var restoreSymlinks = function');
        assert.ok(raw.indexOf('promisify(run)') > -1 && raw.indexOf('cmd = "source "+ profilePath;') > -1, 'kept as comments');
    });

    it('framework:set runs the gina binary on this runtime, from argument vectors', function () {
        var blk = between(POST, 'self.end = function', 'var _mainJsonPath');
        assert.match(blk, /\[\s*ginaBinanry\s*,\s*'framework:set'\s*,\s*'--global-mode='\s*\+\s*self\.isGlobalInstall\s*\]/);
        assert.match(blk, /\[\s*ginaBinanry\s*,\s*'framework:set'\s*,\s*'--prefix='\s*\+\s*self\.defaultPrefix\s*\]/);
        assert.equal((blk.match(/execFileSync\(\s*process\.execPath\s*,\s*cmd\s*\)/g) || []).length, 2,
            'both calls run on process.execPath');
        assert.equal(blk.indexOf("ginaBinanry + ' framework:set"), -1, 'no command line is concatenated');
    });
});


// ---------------------------------------------------------------------------
// 03 — live: pre_install.js from a scratch copy (never the working tree: the
// global npm path may be a link to it). The run is sealed off: HOME, the npm
// prefix, TMPDIR and cwd sit in the scratch, the environment is built from
// scratch (no npm_config_* / NPM_CONFIG_* is inherited), and `npm` on PATH is a
// stand-in that records its arguments, answers the prefix probe and reports gina
// as not installed. The copy has no framework directory beside it, so the
// script's optional helpers preload is skipped (no log transport, no port).
// ---------------------------------------------------------------------------
var SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b663-pre-'));

after(function () {
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/**
 * Quote a value for a POSIX shell script.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function shq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Lay out one install scene under the scratch directory.
 *
 * @inner
 * @param {string} label - Scene directory name
 * @param {boolean} spaced - Put a space in the home, prefix and stand-in paths
 * @returns {{ root: string, home: string, prefix: string, shimBin: string, script: string, tmp: string, log: string }}
 */
function scene(label, spaced) {
    var root    = path.join(SCRATCH, label);
    var sep     = spaced ? ' ' : '';
    var home    = path.join(root, 'Home' + sep + 'Dir');
    var prefix  = path.join(home, '.npm-global');
    var shimBin = path.join(root, 'Tools' + sep + 'Dir', 'bin');
    var script  = path.join(root, 'pkg', 'script', 'pre_install.js');
    var tmp     = path.join(root, 'tmp');
    var log     = path.join(root, 'npm-calls.log');
    [home, path.join(prefix, 'bin'), path.join(prefix, 'lib'), shimBin, path.dirname(script), tmp].forEach(function (d) {
        fs.mkdirSync(d, { recursive: true });
    });
    fs.copyFileSync(path.join(REPO, 'script', 'pre_install.js'), script);
    fs.writeFileSync(path.join(shimBin, 'npm'), [
        '#!/bin/sh',
        '# npm stand-in: one line per call, each argument ended by a tab',
        '{ for a in "$@"; do printf \'%s\\t\' "$a"; done; printf \'\\n\'; } >> ' + shq(log),
        'case "$1" in',
        '  config) printf \'%s\\n\' ' + shq(prefix) + '; exit 0 ;;',
        '  list) printf \'{}\\n\'; exit 1 ;;',
        'esac',
        'exit 1',
        ''
    ].join('\n'));
    fs.chmodSync(path.join(shimBin, 'npm'), 493 /* 0o755 */);
    return { root: root, home: home, prefix: prefix, shimBin: shimBin, script: script, tmp: tmp, log: log };
}

/**
 * Run the scene's pre_install copy as a global install into the scene's prefix.
 *
 * @inner
 * @param {object} s - A scene from scene()
 * @returns {{ status: (number|null), signal: (string|null), out: string, calls: string[][] }}
 *   The exit, both streams joined, and the stand-in's calls (one argv per call)
 */
function runPreInstall(s) {
    var r = spawnSync(process.execPath, [s.script, '-g', '--prefix=' + s.prefix], {
        cwd: s.root,
        env: {
            HOME: s.home,
            PATH: s.shimBin + ':/usr/bin:/bin:/usr/sbin:/sbin',
            TMPDIR: s.tmp,
            GINA_LOG_STDOUT: 'true'
        },
        encoding: 'utf8',
        timeout: 60000
    });
    var calls = !fs.existsSync(s.log) ? [] : fs.readFileSync(s.log, 'utf8').split('\n').filter(Boolean).map(function (line) {
        return line.split('\t').slice(0, -1);
    });
    return { status: r.status, signal: r.signal, out: (r.stdout || '') + (r.stderr || ''), calls: calls };
}

/**
 * The calls of the stand-in whose first argument is `sub`.
 *
 * @inner
 * @param {string[][]} calls
 * @param {string} sub - npm subcommand
 * @returns {string[][]}
 */
function callsOf(calls, sub) {
    return calls.filter(function (c) { return c[0] === sub; });
}

describe('03 - live: pre_install.js from a scratch copy, home and npm prefix under a path with a space', function () {

    it('a first install succeeds: ~/.gina is created, and each npm call got its arguments whole', function () {
        var s = scene('spaced', true);
        var r = runPreInstall(s);
        assert.equal(r.signal, null, 'killed:\n' + r.out);
        assert.equal(r.status, 0, 'pre_install exits 0:\n' + r.out);
        assert.ok(fs.existsSync(path.join(s.home, '.gina')), '~/.gina was created in the scene home');
        assert.deepEqual(callsOf(r.calls, 'config'), [['config', 'get', 'prefix', '--quiet']],
            'the prefix probe reached npm (no fallback):\n' + r.out);
        assert.deepEqual(callsOf(r.calls, 'list'), [['list', 'gina', '--long', '--json', '--prefix=' + s.prefix, '-g']],
            'the prefix with a space reached `npm list` as one argument');
        assert.doesNotMatch(r.out, /was refused/, 'the prefix probe did not fall back:\n' + r.out);
    });

    it('CONTROL: the same run with no space anywhere succeeds (chown, whoami and the stand-in are reachable)', function () {
        var s = scene('plain', false);
        var r = runPreInstall(s);
        assert.equal(r.signal, null, 'killed:\n' + r.out);
        assert.equal(r.status, 0, 'pre_install exits 0:\n' + r.out);
        assert.ok(fs.existsSync(path.join(s.home, '.gina')), '~/.gina was created in the scene home');
        assert.deepEqual(callsOf(r.calls, 'config'), [['config', 'get', 'prefix', '--quiet']]);
        assert.deepEqual(callsOf(r.calls, 'list'), [['list', 'gina', '--long', '--json', '--prefix=' + s.prefix, '-g']]);
    });
});
