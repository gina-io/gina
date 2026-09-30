/**
 * #B665 S2 — the CLI's remaining command lines run from argument vectors on macOS and Linux.
 *
 * S1 (cmd-argv-b665.test.js) moved the daemon-reachable and name-fed sites. S2 moves the sites
 * fed by the operator's own arguments, settings, environment and files, which still reached
 * `sh`: `framework:status`, `bundle:stop`'s kill, `framework:restart`, `framework:build`,
 * `framework:add`'s pack and extract steps, `gina .` (`framework:dot`), `framework:open`,
 * `inspector:open`, and the npm prefix probes in utils/helper.js and `framework:init`. The win32 branches are
 * unchanged (#B694): `start` is a cmd.exe builtin, and Node does not start npm.cmd without a
 * shell. The isaac engine's brotli and gzip compressions of the routing files, which run at every
 * boot, take the same shape (core/server.isaac.js).
 *
 * Two defects ride along:
 * - #B677: `framework:status` listed every user's processes and turned any `gina-`-titled
 *   process's title into a pid-file name, which `_()` normalises, so `gina-v/../../x` wrote
 *   outside the run directory. It now lists the current user's processes only and accepts only
 *   a daemon's `gina-v<version>` title (inc/ps-titles.js).
 * - #B693: `bundle:stop` sent SIGKILL to whatever `parseInt` made of its pid file: `-1`
 *   signalled every process the user may signal. Only a positive integer is a pid now.
 *
 * Sections:
 *   01 — comment-stripped source pins, per file (the change arms fail on the pre-change bytes)
 *   02 — the real inc/ps-titles module over macOS and Linux `ps -f` listings, its pid rule, and
 *        bundle:stop's pid rule, with SUBTRACT arms running the old gates
 *   03 — driven: each argument-vector call shape against a fake child, with shell syntax and
 *        spaces in its arguments, and SUBTRACT arms on the pre-change command lines; and a live
 *        `ps` arm, skipped where there is no `ps` and under Bun
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { execFile, execFileSync, exec, execSync, spawn } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW     = require('../fw');
var CMD    = path.join(FW, 'lib/cmd');
var REPO   = path.resolve(FW, '..', '..');

/**
 * A handler's raw source.
 *
 * @inner
 * @param {string} rel - Path under lib/cmd
 * @returns {string}
 */
function raw(rel) {
    return fs.readFileSync(path.join(CMD, rel), 'utf8');
}

/**
 * Comment-stripped source (full-line `//` comments and JSDoc/block lines), so a pin never
 * matches a kept `was:` line.
 *
 * @inner
 * @param {string} src
 * @returns {string}
 */
function live(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/**
 * @inner
 * @param {string} src
 * @param {string} needle
 * @param {string} what
 */
function has(src, needle, what) {
    assert.ok(src.indexOf(needle) > -1, what + ' — expected `' + needle + '`');
}

/**
 * @inner
 * @param {string} src
 * @param {string} needle
 * @param {string} what
 */
function hasNot(src, needle, what) {
    assert.equal(src.indexOf(needle), -1, what + ' — found `' + needle + '`');
}

/**
 * The new ps-titles module, loaded on demand so that the pre-change bytes (where it does not
 * exist) fail only the arms that need it.
 *
 * @inner
 * @returns {object}
 */
function psTitles() {
    return require(path.join(CMD, 'framework/inc/ps-titles'));
}


// ---------------------------------------------------------------------------
// 01 — source pins
// ---------------------------------------------------------------------------
describe('01a - framework/status.js: no shell, the listing and the liveness check in JS (#B677)', function () {

    var SRC = live(raw('framework/status.js'));

    it('lists the daemons through inc/ps-titles', function () {
        has(SRC, "var psTitles    = require('./inc/ps-titles');", 'the module require');
        has(SRC, 'var list = psTitles.listOwnDaemons();', 'the listing');
        hasNot(SRC, 'ps -ef | grep', 'the old pipeline');
    });

    it('signals the defunct process in-process and checks liveness with process.kill(pid, 0)', function () {
        has(SRC, "process.kill(pid, 'SIGKILL');", 'the zombie kill');
        has(SRC, 'process.kill(n, 0);', 'the liveness check');
        has(SRC, 'var n = psTitles.parsePid(pid);', 'the strict pid read');
        hasNot(SRC, 'execSync("ps -a "', 'the pid file content reaching sh');
        hasNot(SRC, 'execSync("kill -9 "', 'the shell kill');
        hasNot(SRC, 'execSync(', 'any execSync');
    });
});

describe('01b - framework/inc/ps-titles.js: ps from an argument vector, the current user only', function () {

    it('runs ps -f -U <uid> without a shell and accepts only a daemon title', function () {
        var SRC = live(fs.readFileSync(path.join(CMD, 'framework/inc/ps-titles.js'), 'utf8'));
        has(SRC, "execFileSync('ps', ['-f', '-U', String(process.getuid())]", 'the listing');
        has(SRC, 'var DAEMON_TITLE_RE = /^gina-v[0-9][A-Za-z0-9.-]*$/;', 'the title rule');
    });
});

describe('01c - bundle/stop.js: a positive pid, signalled in-process (#B693)', function () {

    var SRC = live(raw('bundle/stop.js'));

    it('reads the pid file as a positive integer only', function () {
        has(SRC, 'proc = ( /^[1-9]\\d*$/.test(proc.trim()) ) ? parseInt(proc.trim(), 10) : null;', 'the pid rule');
        hasNot(SRC, 'proc = parseInt(proc);', 'the old parseInt');
    });

    it('sends SIGKILL with process.kill, not through sh', function () {
        has(SRC, "process.kill(proc, 'SIGKILL');", 'the kill');
        hasNot(SRC, "exec('kill -9 '", 'the shell kill');
    });
});

describe('01d - framework/restart.js: start and stop from argument vectors', function () {

    var SRC = live(raw('framework/restart.js'));

    it('runs bin/gina start and stop with process.execPath and an argument vector', function () {
        has(SRC, "out = execFileSync(process.execPath, [ginaBin, 'start', '@' + self.version]).toString();", 'start');
        has(SRC, "out = execFileSync(process.execPath, [ginaBin, 'stop', '@' + self.version]).toString();", 'stop');
        hasNot(SRC, "'\"'+ process.execPath +'\" \"'+ ginaBin", 'the double-quoted command lines');
    });
});

describe('01e - framework/build.js: the build script gets its arguments whole', function () {

    var SRC = live(raw('framework/build.js'));

    it('runs the script with execFileSync(bashScript, argv)', function () {
        has(SRC, 'console.log(execFileSync(bashScript, argv).toString());', 'the call');
        hasNot(SRC, 'bashScript += " "+argv.join(" ")', 'the joined command line');
        hasNot(SRC, 'execSync(bashScript)', 'the shell call');
    });
});

describe('01f - framework/add.js: pack and extract from argument vectors on macOS and Linux', function () {

    var SRC = live(raw('framework/add.js'));

    it('packs and extracts through runArgv', function () {
        has(SRC, "runArgv(npmBin(), ['pack', 'gina@' + version, '--pack-destination', tmpDir]);", 'the pack step');
        has(SRC, "runArgv('tar', ['-xzf', tgz, '-C', tmpDir]);", 'the extract step');
        has(SRC, 'var out = execFileSync(bin, args, cwd ? { cwd: cwd } : undefined);', 'runArgv');
    });

    it('CONTROL - Windows keeps its command lines (#B694)', function () {
        has(SRC, "run(npmBin() + ' pack gina@' + version + ' --pack-destination ' + JSON.stringify(tmpDir));", 'the win32 pack line');
        has(SRC, "run('tar -xzf ' + JSON.stringify(tgz) + ' -C ' + JSON.stringify(tmpDir));", 'the win32 extract line');
    });
});

describe('01g - framework/dot.js and framework/open.js: the directory is one argument', function () {

    it('dot.js opens Terminal.app from an argument vector', function () {
        var SRC = live(raw('framework/dot.js'));
        has(SRC, "execFile('open', ['-a', 'Terminal.app', target]);", 'the call');
        hasNot(SRC, "'open -a Terminal.app ' + target", 'the command line');
    });

    it('open.js opens the directory from an argument vector, and keeps start on Windows', function () {
        var SRC = live(raw('framework/open.js'));
        has(SRC, 'child.execFile(openCmd, [dir]);', 'the macOS/Linux call');
        has(SRC, "child.exec(openCmd + ' ' + dir);", 'the win32 start line');
        hasNot(SRC, "child.exec(openCmd + ' ' + GINA_", 'a per-case command line');
    });
});

describe('01h - inspector/open.js: probes, launch and fallback from argument vectors on macOS and Linux', function () {

    var SRC = live(raw('inspector/open.js'));

    it('runs the default-browser probes and the PATH lookup without a shell', function () {
        has(SRC, "'plutil', ['-convert', 'json', '-o', '-', plistPath]", 'plutil');
        has(SRC, "'xdg-settings', ['get', 'default-web-browser']", 'xdg-settings');
        has(SRC, "child.execFileSync('which', [bin], ", 'which');
        hasNot(SRC, "'plutil -convert json -o - \"'", 'the plutil command line');
        hasNot(SRC, "'which ' + bin", 'the which command line');
    });

    it('launches the browser and the system default from an argument vector', function () {
        has(SRC, "args    : ['--app=' + url]", 'the app-mode arguments');
        has(SRC, 'child.execFile(launch.bin, launch.args, onLaunched);', 'the launch');
        has(SRC, "child.execFile('open', [url]);", 'the macOS fallback');
        has(SRC, "child.execFile('xdg-open', [url]);", 'the Linux fallback');
        hasNot(SRC, "'open \"' + url + '\"'", 'the macOS fallback command line');
        hasNot(SRC, "'xdg-open \"' + url + '\"'", 'the Linux fallback command line');
    });

    it('Windows keeps start through cmd.exe (#B694)', function () {
        has(SRC, "child.exec('start \"\" \"' + url + '\"');", 'the win32 fallback');
        has(SRC, "'start \"\" ' + quoted + ' --app=\"' + url + '\"'", 'the win32 launch');
    });
});

describe('01i - utils/helper.js: npm from argument vectors (the form #B663 gave the install scripts)', function () {

    var SRC = live(fs.readFileSync(path.join(REPO, 'utils/helper.js'), 'utf8'));

    it('probes the npm prefix without a shell at all five sites', function () {
        var n = SRC.split("execFileSync('npm', ['config', 'get', 'prefix', '--quiet'])").length - 1;
        assert.equal(n, 5, 'expected five argument-vector prefix probes, got ' + n);
        hasNot(SRC, '$(which npm)', 'a shell probe');
    });

    it('lists the installed gina from an argument vector', function () {
        has(SRC, "cmd = ['list', 'gina', '--long', '--json', '--prefix='+ prefix];", 'the list arguments');
        has(SRC, "pkg = execFileSync('npm', cmd)", 'the call');
    });
});

describe('01j - framework/init.js: the npm prefix fallback from an argument vector', function () {

    it('probes the npm prefix without a shell when GINA_PREFIX is unset', function () {
        var SRC = live(raw('framework/init.js'));
        has(SRC, "getEnvVar('GINA_PREFIX') || execFileSync('npm', ['config', 'get', 'prefix', '--quiet'])", 'the probe');
        hasNot(SRC, '$(which npm)', 'a shell probe');
        hasNot(SRC, 'execSync(', 'any execSync');
    });
});

describe('01k - core/server.isaac.js: brotli and gzip from argument vectors', function () {

    var SRC = live(fs.readFileSync(path.join(FW, 'core/server.isaac.js'), 'utf8'));

    it('finds the binaries with which, from an argument vector', function () {
        has(SRC, "const { execFileSync, execFile } = require('child_process');", 'the require');
        has(SRC, "brotliBin = execFileSync( 'which', ['brotli'] ).toString().trim();", 'the brotli lookup');
        has(SRC, "gZipBin = execFileSync( 'which', ['gzip'] ).toString().trim();", 'the gzip lookup');
        hasNot(SRC, "execSync( 'which ", 'a shell lookup');
    });

    it('compresses routing.json and routing.stripped.json without a shell', function () {
        var br = SRC.split("execFile(brotliBin, ['--best', _(targetDir +'/'+ targetFile, true)], function(brCmdErr, stdout) {").length - 1;
        var gz = SRC.split("execFile(gZipBin, ['-9', '-k', _(targetDir +'/'+ targetFile, true)], function(gzCmdErr, stdout) {").length - 1;
        assert.equal(br, 2, 'expected the brotli call for both routing files, got ' + br);
        assert.equal(gz, 2, 'expected the gzip call for both routing files, got ' + gz);
        hasNot(SRC, 'exec(cmd,', 'the shell calls');
        hasNot(SRC, "+' --best '+", 'the brotli command line');
        hasNot(SRC, "+' -9 -k '+", 'the gzip command line');
    });
});


// ---------------------------------------------------------------------------
// 02 — the real ps-titles module, and bundle:stop's pid rule
// ---------------------------------------------------------------------------
// `ps -f` listings as the two platforms print them (the `ps -ef` layout; shapes measured
// 2026-09-27: macOS pads a set title with spaces, procps-ng 4.0.2 ends the line at it). The
// `<defunct>` line is the shape the old zombie branch read; it was not measured.
var MACOS_PSF = [
    '  UID   PID  PPID   C STIME   TTY           TIME CMD',
    '  501 22221     1   0 12:57AM ??         0:00.04 gina-v0.7.1-alpha.2  ',
    '  501 22222     1   0 12:57AM ??         0:00.04 gina-v/../../x  ',
    '  501 22223     1   0 12:57AM ??         0:00.04 gina: api@shop  ',
    '  501 22224     1   0 12:57AM ??         0:00.10 node /srv/gina-v0.7.1/bin/cli start',
    '  501 22225     1   0 12:57AM ??         0:00.00 gina-v0.7.1-alpha.2 <defunct>',
    '  501 22226 22200   0 12:57AM ttys001    0:00.00 ps -f -U 501',
    ''
].join('\n');
var LINUX_PSF = [
    'UID          PID    PPID  C STIME TTY          TIME CMD',
    'node           7       1 35 16:05 ?        00:00:00 gina-v0.7.1-alpha.2',
    'node          31       1  0 16:05 ?        00:00:00 gina-v/../../x',
    'node          40       1  2 16:05 ?        00:00:00 gina: api@shop',
    'node          41       1  0 16:05 ?        00:00:00 node /srv/gina-v0.7.1/bin/cli start',
    'node          20       1  0 16:05 ?        00:00:00 ps -f -U 1000',
    ''
].join('\n');

/**
 * The pre-change gate, verbatim from framework/status.js: `ps -ef | grep -v grep | grep
 * 'gina-v' | awk '{print $2" "$8" "$9}'`, then `/^\d+\s+gina\-/` on each line, and the title
 * field became the pid-file name. The pipeline runs for real over the listing.
 *
 * @inner
 * @param {string} listing - A `ps -ef`/`ps -f` listing
 * @returns {string[]} The titles the old code turned into pid-file names
 */
function preChangeTitles(listing) {
    var out = execFileSync('sh', ['-c', "grep -v grep | grep 'gina-v' | awk '{print $2\" \"$8\" \"$9}'"], { input: listing }).toString();
    return out.replace(/\n$/, '').split(/\n/g).filter(function (l) {
        return /^\d+\s+gina\-/.test(l);
    }).map(function (l) {
        return l.split(/\s/)[1];
    });
}

describe('02a - inc/ps-titles parseDaemonTitles: a daemon title, and nothing else (#B677)', function () {

    it('finds the daemon in the macOS listing, with the zombie flagged', function () {
        assert.deepEqual(psTitles().parseDaemonTitles(MACOS_PSF), [
            { pid: 22221, title: 'gina-v0.7.1-alpha.2', zombie: false },
            { pid: 22225, title: 'gina-v0.7.1-alpha.2', zombie: true }
        ]);
    });

    it('finds the daemon in the Linux listing', function () {
        assert.deepEqual(psTitles().parseDaemonTitles(LINUX_PSF), [
            { pid: 7, title: 'gina-v0.7.1-alpha.2', zombie: false }
        ]);
    });

    it('rejects a title that could leave the run directory, a bundle title, and a script path', function () {
        ['gina-v/../../x', 'gina-v0.7/..', 'gina: api@shop', 'gina-vx', 'gina-v', 'node', 'gina-v1 x'].forEach(function (t) {
            assert.equal(psTitles().DAEMON_TITLE_RE.test(t), false, t);
        });
        ['gina-v0.7.1-alpha.2', 'gina-v0.7.1', 'gina-v1'].forEach(function (t) {
            assert.equal(psTitles().DAEMON_TITLE_RE.test(t), true, t);
        });
    });

    it('SUBTRACT - the old gate turned `gina-v/../../x` into a pid-file name outside the run directory', function () {
        var titles = preChangeTitles(LINUX_PSF);
        assert.ok(titles.indexOf('gina-v/../../x') > -1, 'the old gate passes the hostile title: ' + JSON.stringify(titles));
        var runDir = '/home/u/.gina/run';
        var target = path.normalize(runDir + '/' + 'gina-v/../../x' + '.pid');
        assert.equal(target, '/home/u/.gina/x.pid');
        assert.ok(target.indexOf(runDir + '/') !== 0, 'the written file leaves the run directory');
    });
});

describe('02b - the pid rules: inc/ps-titles parsePid and bundle:stop (#B693)', function () {

    var CASES = [
        ['4242', 4242], ['4242\n', 4242], [' 42 ', 42],
        ['-1', null], ['0', null], ['12abc', null], ['0x10', null], ['1.5', null], ['007', null], ['', null]
    ];

    /**
     * bundle:stop's rule, locked to the source by 01c.
     *
     * @inner
     * @param {string} content
     * @returns {?number}
     */
    function stopPid(content) {
        var proc = content.replace(/\n/g, '');
        return ( /^[1-9]\d*$/.test(proc.trim()) ) ? parseInt(proc.trim(), 10) : null;
    }

    it('parsePid reads a positive integer and nothing else', function () {
        CASES.forEach(function (c) {
            assert.equal(psTitles().parsePid(c[0]), c[1], JSON.stringify(c[0]));
        });
        assert.equal(psTitles().parsePid(null), null);
        assert.equal(psTitles().parsePid(Buffer.from('77\n')), 77);
    });

    it('bundle:stop reads its pid file the same way', function () {
        CASES.forEach(function (c) {
            assert.equal(stopPid(c[0]), c[1], JSON.stringify(c[0]));
        });
    });

    it('SUBTRACT - the old parseInt made -1 a broadcast and 12abc pid 12', function () {
        assert.equal(parseInt('-1'), -1);
        assert.ok(parseInt('-1'), 'truthy: the old code went on to `kill -9 -1`');
        assert.equal(parseInt('12abc'), 12);
    });
});


// ---------------------------------------------------------------------------
// 03 — driven: the argument-vector call shapes against a fake child
// ---------------------------------------------------------------------------
var TMP        = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b665-s2-'));
var LOG        = path.join(TMP, 'calls.log');
var ENV        = Object.assign({}, process.env, { B665S2_LOG: LOG });
// The fake logs the arguments it receives, one JSON line per call. Its shebang names the running
// runtime, so it starts the same way under Node and under Bun.
var FAKE_SRC   = '#!' + process.execPath + '\n'
               + "require('fs').appendFileSync(process.env.B665S2_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n";

/**
 * Writes an executable fake into `dir` and returns its path.
 *
 * @inner
 * @param {string} dir
 * @returns {string}
 */
function fake(dir) {
    fs.mkdirSync(dir, { recursive: true });
    var p = path.join(dir, 'fake.js');
    fs.writeFileSync(p, FAKE_SRC, { mode: 0o755 });
    return p;
}

var SPACED_FAKE = fake(path.join(TMP, 'My Gina'));
var PLAIN_FAKE  = fake(path.join(TMP, 'plain'));

/**
 * The calls logged since the last read, oldest first; the log is removed.
 *
 * @inner
 * @returns {string[][]}
 */
function takeCalls() {
    if (!fs.existsSync(LOG)) return [];
    var calls = fs.readFileSync(LOG, 'utf8').replace(/\n$/, '').split('\n').map(function (l) { return JSON.parse(l); });
    fs.unlinkSync(LOG);
    return calls;
}

/**
 * A marker path a payload creates when a shell runs it.
 *
 * @inner
 * @param {string} name
 * @returns {string}
 */
function marker(name) {
    return path.join(TMP, 'marker-' + name);
}

after(function () {
    fs.rmSync(TMP, { recursive: true, force: true });
});

describe('03a - framework:build: the script receives each argument whole', function () {

    it('execFileSync(script, argv) keeps a space and leaves shell syntax as text', function () {
        var m = marker('build');
        execFileSync(SPACED_FAKE, ['--env=prod', '--x=$(touch ' + m + ')', 'two words'], { env: ENV });
        assert.deepEqual(takeCalls(), [['--env=prod', '--x=$(touch ' + m + ')', 'two words']]);
        assert.equal(fs.existsSync(m), false, 'the payload must not run');
    });

    it('SUBTRACT - the joined command line re-split the arguments and ran the payload', function () {
        var m = marker('build-pre');
        var argv = ['--env=prod', '--x=$(touch ' + m + ')', 'two words'];
        execSync(PLAIN_FAKE + ' ' + argv.join(' '), { env: ENV });
        assert.deepEqual(takeCalls(), [['--env=prod', '--x=', 'two', 'words']]);
        assert.equal(fs.existsSync(m), true, 'the payload ran');
    });
});

describe('03b - the openers (inspector:open, framework:open, gina .): the URL or path is one argument', function () {

    it('execFile(bin, [url]) leaves `$(...)` inside the URL as text', function (t, done) {
        var m = marker('open');
        var url = 'http://localhost:3100/_gina/inspector/?target=x$(touch ' + m + ')';
        execFile(SPACED_FAKE, [url], { env: ENV }, function (err) {
            assert.ifError(err);
            assert.deepEqual(takeCalls(), [[url]]);
            assert.equal(fs.existsSync(m), false, 'the payload must not run');
            done();
        });
    });

    it('SUBTRACT - a double-quoted URL on a command line still ran `$(...)`', function (t, done) {
        var m = marker('open-pre');
        var url = 'http://localhost:3100/_gina/inspector/?target=x$(touch ' + m + ')';
        exec(PLAIN_FAKE + ' "' + url + '"', { env: ENV }, function (err) {
            assert.ifError(err);
            assert.deepEqual(takeCalls(), [['http://localhost:3100/_gina/inspector/?target=x']]);
            assert.equal(fs.existsSync(m), true, 'the payload ran');
            done();
        });
    });
});

describe('03c - utils/helper.js: npm list receives the prefix whole', function () {

    it('execFileSync(npm, [..., --prefix=<p>]) keeps a space and shell syntax in the prefix', function () {
        var m = marker('npm');
        var prefix = path.join(TMP, 'My Prefix $(touch ' + m + ')');
        execFileSync(SPACED_FAKE, ['list', 'gina', '--long', '--json', '--prefix=' + prefix, '-g'], { env: ENV });
        assert.deepEqual(takeCalls(), [['list', 'gina', '--long', '--json', '--prefix=' + prefix, '-g']]);
        assert.equal(fs.existsSync(m), false, 'the payload must not run');
    });

    it('SUBTRACT - the prefix appended to a command line split and ran the payload', function () {
        var m = marker('npm-pre');
        var prefix = path.join(TMP, 'My Prefix $(touch ' + m + ')');
        execSync(PLAIN_FAKE + ' list gina --long --json --prefix=' + prefix + ' -g', { env: ENV });
        var calls = takeCalls();
        assert.deepEqual(calls[0].slice(0, 4), ['list', 'gina', '--long', '--json']);
        assert.notEqual(calls[0][4], '--prefix=' + prefix, 'the prefix did not arrive whole');
        assert.equal(fs.existsSync(m), true, 'the payload ran');
    });
});

describe('03d - framework:restart: bin/gina from process.execPath and an argument vector', function () {

    it('runs a script under a path holding a space and passes the version whole', function () {
        execFileSync(process.execPath, [SPACED_FAKE, 'start', '@0.7.1'], { env: ENV });
        assert.deepEqual(takeCalls(), [['start', '@0.7.1']]);
    });
});

describe('03e - liveness: process.kill(pid, 0) on a live and a dead child', function () {

    it('a live child answers; once it has exited the same pid is ESRCH', function (t, done) {
        var child = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 10000)'], { stdio: 'ignore' });
        var pid = psTitles().parsePid(String(child.pid));
        assert.equal(pid, child.pid);
        assert.doesNotThrow(function () { process.kill(pid, 0); });
        child.on('exit', function () {
            assert.throws(function () { process.kill(pid, 0); }, function (e) { return e.code === 'ESRCH'; });
            done();
        });
        child.kill('SIGKILL');
    });
});

// Live `ps`: a daemon-titled child and a child whose title would leave the run directory. The
// Bun CI image ships no `ps`.
var IS_BUN = typeof Bun !== 'undefined';
var HAS_PS = (function () {
    try {
        execFileSync('ps', ['-f', '-U', String(process.getuid())], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
        return true;
    } catch (e) {
        return false;
    }
})();

describe('03f - live: listOwnDaemons over the real `ps -f -U <uid>` (#B677)', { skip: (IS_BUN && 'under Bun (the Bun CI image ships no ps)') || (!HAS_PS && 'no ps -U on this host') }, function () {

    var tag      = 'b677' + process.pid;
    var goodT    = 'gina-v9.9.9-' + tag;
    var badT     = 'gina-v9/../../' + tag;
    var children = [];
    var listed   = null;

    /**
     * Starts a child titled `title` and resolves once it has set the title.
     *
     * @inner
     * @param {string} title
     * @returns {Promise<import('child_process').ChildProcess>}
     */
    function titled(title) {
        return new Promise(function (resolve, reject) {
            var c = spawn(process.execPath, ['-e', 'process.title = ' + JSON.stringify(title) + '; process.stdout.write("ready\\n"); setTimeout(function () {}, 10000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
            children.push(c);
            c.stdout.once('data', function () { resolve(c); });
            c.on('error', reject);
        });
    }

    before(async function () {
        await titled(goodT);
        await titled(badT);
    });

    after(function () {
        children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    });

    /**
     * One listing for the arms that need it, taken after both children are titled.
     *
     * @inner
     * @returns {Array<{pid: number, title: string, zombie: boolean}>}
     */
    function ownDaemons() {
        if (listed === null) listed = psTitles().listOwnDaemons();
        return listed;
    }

    it('lists the daemon-titled child with its pid', function () {
        var hit = ownDaemons().filter(function (d) { return d.title === goodT; });
        assert.equal(hit.length, 1, JSON.stringify(ownDaemons()));
        assert.equal(hit[0].pid, children[0].pid);
    });

    it('does not list the child whose title would leave the run directory', function () {
        assert.equal(ownDaemons().filter(function (d) { return d.title.indexOf(tag) > -1 && d.title !== goodT; }).length, 0);
    });

    it('CONTROL - the old pipeline over the real `ps -ef` did pass the hostile title', function () {
        var titles = preChangeTitles(execFileSync('ps', ['-ef'], { maxBuffer: 64 * 1024 * 1024 }).toString());
        assert.ok(titles.indexOf(badT) > -1, 'the fixture is live: ' + JSON.stringify(titles.filter(function (x) { return x.indexOf(tag) > -1; })));
    });
});

describe('03g - isaac compression: the cache path is one argument', function () {

    var FILE = path.join(TMP, 'My Cache', 'demo', 'config', 'routing.json');

    it('execFile(bin, [flag, file]) passes a path holding a space whole', function (t, done) {
        execFile(SPACED_FAKE, ['--best', FILE], { env: ENV }, function (err) {
            assert.ifError(err);
            assert.deepEqual(takeCalls(), [['--best', FILE]]);
            done();
        });
    });

    it('SUBTRACT - the command line split the path at the space', function (t, done) {
        exec(PLAIN_FAKE + ' --best ' + FILE, { env: ENV }, function (err) {
            assert.ifError(err);
            assert.deepEqual(takeCalls(), [['--best'].concat(FILE.split(' '))], 'the path arrived in pieces');
            done();
        });
    });
});
