/**
 * #B665 S1 — the daemon-reachable and name-fed CLI sites start their children
 * from argument vectors, without a shell.
 *
 * Before, these sites built a command line with names and flags spliced in
 * unquoted (or single-quoted) and ran it through `sh`: the CmdHelper auto-link
 * children (`link-node-modules` / `link`, every `--flag=value` listed in the
 * group's arguments.json appended), bundle:start's `framework:link` reinstall
 * step (after a `which gina`), framework:link's `node_modules` repair step,
 * project:start/stop/restart's bundle delegations (runtime and CLI paths joined
 * by a space), and the `ps | grep | awk` sweeps of bundle:stop and minion:kill.
 * Shell syntax in a registered name or a forwarded flag ran; a value holding a
 * space was split in two; an install path holding a space broke project:*.
 * Each child now runs through execFile / execFileSync with every value its own
 * argument, and the `ps -ef` listing is filtered in JS, where a title must end
 * at whitespace or the end of the line (bundle:stop matched `api@shop` inside
 * `api@shopping` before). framework/start.js and framework/restart.js lose the
 * dead copies of restartRunningBunldes(), and restart.js the dead start() that
 * was its only caller.
 *
 * Sections:
 *   01 — comment-stripped source pins, per file (these fail on the pre-change
 *        bytes)
 *   02 — replicas of the params list, the project argument assembly and the
 *        two `ps` filters (locked to the source by 01), over macOS and Linux
 *        `ps -ef` listings; the real escapeRegex is used
 *   03 — driven: the argument vectors against a fake CLI under a path with a
 *        space — each argument arrives whole and shell syntax in a flag stays
 *        text — with SUBTRACT arms on the pre-change command lines; and a live
 *        `ps` arm, skipped where there is no `ps` (the Bun CI image ships none)
 *        and under Bun
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { execFile, execFileSync, exec, execSync, spawn } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW          = require('../fw');
var CMD         = path.join(FW, 'lib/cmd');
var escapeRegex = require(path.join(CMD, 'bundle/inc/name-rewrite')).escapeRegex;

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
 * Comment-stripped source (full-line `//` comments and JSDoc/block lines), so a
 * pin never matches a kept `was:` line.
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
 * Asserts the live source carries a needle.
 *
 * @inner
 * @param {string} src - Comment-stripped source
 * @param {string} needle
 * @param {string} what - What the needle proves
 */
function has(src, needle, what) {
    assert.ok(src.indexOf(needle) > -1, what + ' — expected `' + needle + '`');
}

/**
 * Asserts the live source does NOT carry a needle.
 *
 * @inner
 * @param {string} src - Comment-stripped source
 * @param {string} needle
 * @param {string} what - What the absence proves
 */
function hasNot(src, needle, what) {
    assert.equal(src.indexOf(needle), -1, what + ' — found `' + needle + '`');
}


// ---------------------------------------------------------------------------
// 01 — source
// ---------------------------------------------------------------------------
describe('01a - helper.js: the auto-link children take an argument vector', function () {

    var SRC = live(raw('helper.js'));

    it('requires execFileSync', function () {
        has(SRC, "const { execFileSync } = require('child_process');", 'the require');
    });

    it('declares the paramsArgv list beside paramsStringified', function () {
        assert.match(SRC, /paramsArgv\s*:\s*\[\]/);
    });

    it('getParams fills paramsArgv with the same tokens as paramsStringified, one per argument', function () {
        has(SRC, "cmd.paramsArgv.push('--' + arr[0] +'='+ arr[1]);", 'the --key=value push');
        has(SRC, "cmd.paramsArgv.push(process.argv[a] +'='+ true);", 'the bare --flag push');
    });

    it('link-node-modules and link run from process.execPath + selfCli, the flags as a list, with the home re-exported', function () {
        has(SRC, "execFileSync(process.execPath, [selfCli, 'link-node-modules', '@' + cmd.projectName].concat(cmd.paramsArgv), { env: _linkEnv });", 'the link-node-modules child');
        has(SRC, "execFileSync(process.execPath, [selfCli, 'link', '@' + cmd.projectName].concat(cmd.paramsArgv), { env: _linkEnv })", 'the link child');
    });

    it('no quoted command line reaches execSync any more', function () {
        hasNot(SRC, "execSync('\"'+ process.execPath", 'a shell command line');
    });
});

describe('01b - bundle/start.js: framework:link runs this install\'s bin/gina from an argument vector', function () {

    var SRC = live(raw('bundle/start.js'));

    it('requires execFileSync', function () {
        has(SRC, "const { execFileSync } = require('child_process');", 'the require');
    });

    it('resolves bin/gina from its own location, and never asks PATH', function () {
        has(SRC, "var ginaBin = require('path').resolve(__dirname, '../../../../..', 'bin/gina');", 'the self-located bin/gina');
        hasNot(SRC, 'which gina', 'a PATH lookup');
        var resolved = path.resolve(path.join(CMD, 'bundle'), '../../../../..', 'bin/gina');
        assert.ok(fs.existsSync(resolved), resolved + ' exists');
    });

    it('runs framework:link under runtimeBinary(process.execPath), the project as its own argument', function () {
        has(SRC, "execFileSync(runtime.runtimeBinary(process.execPath), [ginaBin, 'framework:link', '@' + self.projectName]);", 'the link call');
        hasNot(SRC, 'linkCmd', 'the command-line string');
    });
});

describe('01c - framework/link.js: link-node-modules runs from an argument vector', function () {

    var SRC = live(raw('framework/link.js'));

    it('requires execFileSync and calls no execSync', function () {
        has(SRC, "const { execFileSync } = require('child_process');", 'the require');
        hasNot(SRC, 'execSync(', 'an execSync call');
    });

    it('passes the CLI script and the project as separate arguments', function () {
        has(SRC, "execFileSync(process.execPath, [cli, 'link-node-modules', '@' + self.projectName]);", 'the repair child');
    });
});

describe('01d - framework/restart.js and framework/start.js: the dead restartRunningBunldes copies are gone', function () {

    var RESTART = live(raw('framework/restart.js'));
    var START   = live(raw('framework/start.js'));

    it('restart.js keeps neither restartRunningBunldes nor the start() that was its only caller', function () {
        hasNot(RESTART, 'restartRunningBunldes', 'the helper');
        hasNot(RESTART, 'var start = ', 'the dead start()');
        hasNot(RESTART, 'spawn(', 'its detached spawn');
    });

    it('start.js keeps no restartRunningBunldes and no execSync', function () {
        hasNot(START, 'restartRunningBunldes', 'the helper');
        hasNot(START, 'execSync', 'execSync');
    });
});

describe('01e - bundle/stop.js and minion/kill.js: ps runs without a shell and is filtered in JS', function () {

    var STOP = live(raw('bundle/stop.js'));
    var KILL = live(raw('minion/kill.js'));

    it('both require execFileSync and escapeRegex, and cap the listing at PS_MAX_BUFFER', function () {
        has(STOP, "const { execFileSync } = require('child_process');", 'stop.js require');
        has(KILL, "const { execFileSync } = require('child_process');", 'kill.js require');
        has(STOP, "var escapeRegex = require('./inc/name-rewrite').escapeRegex;", 'stop.js escapeRegex');
        has(KILL, "var escapeRegex = require('./../bundle/inc/name-rewrite').escapeRegex;", 'kill.js escapeRegex');
        has(STOP, 'var PS_MAX_BUFFER = 64 * 1024 * 1024;', 'stop.js cap');
        has(KILL, 'var PS_MAX_BUFFER = 64 * 1024 * 1024;', 'kill.js cap');
    });

    it('both list processes with execFileSync(\'ps\', [\'-ef\']), and no ps pipeline is left', function () {
        has(STOP, "execFileSync('ps', ['-ef'], { maxBuffer: PS_MAX_BUFFER })", 'stop.js listing');
        has(KILL, "execFileSync('ps', ['-ef'], { maxBuffer: PS_MAX_BUFFER })", 'kill.js listing');
        hasNot(STOP, 'ps -ef |', 'stop.js pipeline');
        hasNot(KILL, 'ps -ef |', 'kill.js pipeline');
        hasNot(STOP, 'execSync(', 'stop.js execSync');
        hasNot(KILL, 'execSync(', 'kill.js execSync');
    });

    it('bundle:stop matches its exact title, ending at whitespace or the end of the line', function () {
        has(STOP, "var titleRe = new RegExp('gina: ' + escapeRegex(bundle + '@' + self.projectName) + '(\\\\s|$)');", 'the title regex');
        has(STOP, "return line.indexOf('grep') < 0 && titleRe.test(line);", 'the line filter');
        has(STOP, 'proc = ~~list[0].trim().split(/\\s+/)[1];', 'the PID column');
    });

    it('minion:kill matches any bundle of the escaped project, ending at whitespace or the end of the line', function () {
        has(KILL, "var titleRe = new RegExp('gina: [^ ]+@' + escapeRegex(self.projectName) + '(\\\\s|$)');", 'the title regex');
        has(KILL, "if ( lines[j].indexOf('grep') > -1 || !titleRe.test(lines[j]) ) {", 'the line filter');
        has(KILL, 'var pid       = ~~cols[1];', 'the PID column');
        has(KILL, "var titleTail = cols[cols.length - 1] || '';", 'the title column');
    });
});

describe('01f - project/{start,stop,restart}.js: the bundle delegations run from an argument vector', function () {

    ['start', 'stop', 'restart'].forEach(function (verb) {
        var RAW = raw('project/' + verb + '.js');
        var SRC = live(RAW);

        it('[' + verb + '] requires execFile, and neither requires nor calls exec', function () {
            has(SRC, "require('child_process').execFile;", 'the require');
            hasNot(SRC, "require('child_process').exec;", 'the exec require');
            assert.equal(/\bexec\(/.test(SRC), false, 'no exec( call');
        });

        it('[' + verb + '] keeps the runtime and CLI script paths as an argument pair, with no $gina command line', function () {
            has(SRC, 'self.cliArgv = process.argv.splice(0, 2);', 'the pair');
            hasNot(SRC, "'$gina ", 'the $gina placeholder');
            hasNot(SRC, 'self.cmdStr', 'the joined string');
        });

        it('[' + verb + '] delegates to bundle:' + verb + ' with the same maxBuffer and re-exported home', function () {
            var assembly = "var argv = [self.cliArgv[1], 'bundle:" + verb + "', '@' + self.projectName]";
            has(SRC, assembly, 'the argument vector');
            has(SRC, 'execFile(self.cliArgv[0], argv, { maxBuffer: 1024 * 500, env: Object.assign({}, process.env, { GINA_HOMEDIR: GINA_HOMEDIR }) }', 'the child');
        });

        if (verb !== 'stop') {
            it('[' + verb + '] forwards the inherited flags as a list, and the debug flag as one argument', function () {
                has(SRC, ".concat(self.inheritedArgv);", 'the flags');
                hasNot(SRC, 'self.inheritedArgv = self.inheritedArgv.join(', 'the join');
                has(SRC, "argv.push('--inspect' + (opt.debugBrkEnabled ? '-brk' : '') + '=' + opt.debugPort);", 'the debug flag');
            });
        }

        it('[' + verb + '] the pre-change lines survive only as comments (the strip is real)', function () {
            assert.ok(RAW.indexOf('self.cmdStr = process.argv.splice(0, 2).join') > -1, 'kept as a comment');
            hasNot(SRC, 'self.cmdStr = process.argv.splice(0, 2).join', 'not live');
        });
    });

    it('[restart] keeps its stdout filter', function () {
        has(live(raw('project/restart.js')), "stdout.replace(/\\n\\rTrying to.*/gm, '')", 'the filter');
    });
});


// ---------------------------------------------------------------------------
// 02 — replicas (locked to the source by 01)
// ---------------------------------------------------------------------------

/**
 * Mirror of CmdHelper.getParams()'s flag parsing, returning both forwarded forms.
 *
 * @inner
 * @param {string[]} argv - process.argv
 * @param {string[]} cmdArguments - The group's arguments.json entries
 * @returns {{ stringified: string, list: string[], nodeParams: string[] }}
 */
function parseParams(argv, cmdArguments) {
    var stringified = '', list = [], nodeParams = [], arr = [];
    for (let a in argv) {
        if ( argv[a].indexOf('--') > -1 && argv[a].indexOf('=') > -1) {
            var _raw = argv[a].replace(/--/, '');
            var _eq  = _raw.indexOf('=');
            arr      = (_eq > -1) ? [ _raw.substring(0, _eq), _raw.substring(_eq + 1) ] : [ _raw ];
            arr[0] = arr[0].toLowerCase();
            if ( typeof(arr[1]) == 'undefined' || arr[1] === "true" ) {
                arr[1] = true
            }
            if (arr[1] === "false") {
                arr[1] = false
            }
            if ( cmdArguments.indexOf('--' + arr[0]) > -1 ) {
                stringified += ' --' + arr[0] +'='+ arr[1];
                list.push('--' + arr[0] +'='+ arr[1]);
            } else {
                nodeParams.push('--' + arr[0] +'='+ arr[1]);
            }
        } else if ( argv[a].indexOf('--') > -1 ) {
            if ( cmdArguments.indexOf(argv[a]) > -1 ) {
                stringified += ' '+argv[a] +'='+ true;
                list.push(argv[a] +'='+ true);
            } else {
                nodeParams.push(argv[a]);
            }
        }
    }
    return { stringified: stringified, list: list, nodeParams: nodeParams };
}

/**
 * Mirror of bundle:stop's `ps` filter: the PID of the first process titled
 * `gina: <bundle>@<project>`, or 0.
 *
 * @inner
 * @param {string} psOut - A `ps -ef` listing
 * @param {string} bundle
 * @param {string} project
 * @returns {number}
 */
function stopPid(psOut, bundle, project) {
    var titleRe = new RegExp('gina: ' + escapeRegex(bundle + '@' + project) + '(\\s|$)');
    var list = psOut.split(/\n/).filter(function(line) {
        return line.indexOf('grep') < 0 && titleRe.test(line);
    });
    return list.length ? ~~list[0].trim().split(/\s+/)[1] : 0;
}

/**
 * The pre-change bundle:stop match, on the same listing: a plain substring
 * (what `grep -v grep | grep 'gina: <b>@<p>'` kept) and awk's `$2`.
 *
 * @inner
 * @param {string} psOut
 * @param {string} bundle
 * @param {string} project
 * @returns {number}
 */
function preChangeStopPid(psOut, bundle, project) {
    var needle = 'gina: ' + bundle + '@' + project;
    var list = psOut.split(/\n/).filter(function(line) {
        return line.indexOf('grep') < 0 && line.indexOf(needle) > -1;
    });
    return list.length ? ~~list[0].trim().split(/\s+/)[1] : 0;
}

/**
 * Mirror of minion:kill's `ps` pass: every process of the project, as
 * `{ pid, bundle }`.
 *
 * @inner
 * @param {string} psOut
 * @param {string} project
 * @returns {Array<{pid: number, bundle: string}>}
 */
function minionTargets(psOut, project) {
    var titleRe = new RegExp('gina: [^ ]+@' + escapeRegex(project) + '(\\s|$)');
    var found   = [];
    var lines   = psOut.split(/\n/);
    for (var j = 0; j < lines.length; j++) {
        if ( lines[j].indexOf('grep') > -1 || !titleRe.test(lines[j]) ) {
            continue;
        }
        var cols      = lines[j].trim().split(/\s+/);
        var pid       = ~~cols[1];
        if ( !pid ) {
            continue;
        }
        var titleTail = cols[cols.length - 1] || '';
        var psAt      = titleTail.lastIndexOf('@');
        found.push({ pid: pid, bundle: (psAt > 0) ? titleTail.substring(0, psAt) : titleTail });
    }
    return found;
}

// `ps -ef` listings as the two platforms print them (shapes measured 2026-09-27:
// macOS pads a set title with spaces; Linux procps ends the line at the title)
var MACOS_PS = [
    '  UID   PID  PPID   C STIME   TTY           TIME CMD',
    '  501 11111     1   0 12:57AM ??         0:00.04 gina: api@shop  ',
    '  501 11112     1   0 12:57AM ??         0:00.04 gina: api@shopping  ',
    '  501 11113 11100   0 12:57AM ttys001    0:00.00 grep gina: api@shop',
    '  501 11114     1   0 12:57AM ??         0:00.04 gina: my.app@shop  ',
    '  501 11115     1   0 12:57AM ??         0:00.04 gina: web@my.shop  ',
    ''
].join('\n');
var LINUX_PS = [
    'UID          PID    PPID  C STIME TTY          TIME CMD',
    'root          14       7  2 00:05 ?        00:00:00 gina: api@shop',
    'root          15       7  2 00:05 ?        00:00:00 gina: api@shopping',
    'root          16       7  0 00:05 pts/0    00:00:00 grep gina: api@shop',
    'root          17       7  2 00:05 ?        00:00:00 gina: my-app@shop',
    'root          18       7  2 00:05 ?        00:00:00 gina: web@myXshop',
    ''
].join('\n');

describe('02a - replica: the params list carries the same tokens as the string, one argument each', function () {

    var ARGS = ['--env', '--scope', '--verbose', '--label'];

    it('a list entry per forwarded flag, and node flags kept apart', function () {
        var p = parseParams(['node', 'cli', 'bundle:start', 'api', '@shop', '--env=dev', '--scope=local', '--verbose', '--max-old-space-size=2048'], ARGS);
        assert.deepEqual(p.list, ['--env=dev', '--scope=local', '--verbose=true']);
        assert.equal(p.stringified, ' ' + p.list.join(' '), 'the string is the list joined');
        assert.deepEqual(p.nodeParams, ['--max-old-space-size=2048']);
    });

    it('a value holding a space stays one entry', function () {
        var p = parseParams(['node', 'cli', 'bundle:start', 'api', '@shop', '--label=a b'], ARGS);
        assert.deepEqual(p.list, ['--label=a b']);
    });
});

describe('02b - replica: bundle:stop\'s ps filter', function () {

    it('finds the exact title on both platforms, never a sibling title or a grep line', function () {
        assert.equal(stopPid(MACOS_PS, 'api', 'shop'), 11111);
        assert.equal(stopPid(LINUX_PS, 'api', 'shop'), 14);
    });

    it('a title that is only a sibling\'s prefix is not running', function () {
        var siblingOnly = MACOS_PS.split('\n').filter(function (l) { return l.indexOf('api@shop  ') < 0; }).join('\n');
        assert.equal(stopPid(siblingOnly, 'api', 'shop'), 0);
    });

    it('SUBTRACT: the pre-change substring match takes the sibling\'s PID', function () {
        var siblingOnly = LINUX_PS.split('\n').filter(function (l) { return !/ gina: api@shop$/.test(l); }).join('\n');
        assert.equal(preChangeStopPid(siblingOnly, 'api', 'shop'), 15, 'api@shopping');
        assert.equal(stopPid(siblingOnly, 'api', 'shop'), 0);
    });

    it('a `.` in a name matches only a `.`', function () {
        assert.equal(stopPid(MACOS_PS, 'my.app', 'shop'), 11114);
        assert.equal(stopPid(LINUX_PS, 'my.app', 'shop'), 0, 'my-app is another bundle');
    });

    it('a `\'` in a name is a character to match, and matches nothing here', function () {
        assert.equal(stopPid(LINUX_PS, "a'b", 'shop'), 0);
    });
});

describe('02c - replica: minion:kill\'s ps pass', function () {

    it('every bundle of the project, with its name from the last column', function () {
        assert.deepEqual(minionTargets(MACOS_PS, 'shop'), [{ pid: 11111, bundle: 'api' }, { pid: 11114, bundle: 'my.app' }]);
        assert.deepEqual(minionTargets(LINUX_PS, 'shop'), [{ pid: 14, bundle: 'api' }, { pid: 17, bundle: 'my-app' }]);
    });

    it('the project name is escaped: `my.shop` does not match `myXshop`', function () {
        assert.deepEqual(minionTargets(LINUX_PS, 'my.shop'), []);
        assert.deepEqual(minionTargets(MACOS_PS, 'my.shop'), [{ pid: 11115, bundle: 'web' }]);
    });

    it('SUBTRACT: the pre-change unescaped ERE, run by grep -E, matches `myXshop` for `my.shop`', function () {
        var out = execFileSync('grep', ['-E', 'gina: [^ ]+@my.shop([[:space:]]|$)'], { input: LINUX_PS }).toString();
        assert.match(out, /gina: web@myXshop/);
    });
});


// ---------------------------------------------------------------------------
// 03 — driven
// ---------------------------------------------------------------------------
var TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b665-argv-'));
var LOG      = path.join(TMP, 'calls.log');
var FAKE_SRC = [
    "var fs = require('fs');",
    "fs.appendFileSync(process.env.B665_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "process.stdout.write('ran ' + process.argv[2] + '\\n');",
    ''
].join('\n');

/**
 * Writes a fake CLI that records its arguments, one JSON line per call.
 *
 * @inner
 * @param {string} dir - Directory to create `bin/cli` in
 * @returns {string} The fake CLI path
 */
function fakeCli(dir) {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'cli'), FAKE_SRC);
    return path.join(dir, 'bin', 'cli');
}

var SPACED_CLI = fakeCli(path.join(TMP, 'My Gina'));
var PLAIN_CLI  = fakeCli(path.join(TMP, 'plain'));
var ENV        = Object.assign({}, process.env, { B665_LOG: LOG });

after(function () {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/**
 * The calls the fake CLI recorded, oldest first; the log is then emptied.
 *
 * @inner
 * @returns {string[][]}
 */
function takeCalls() {
    if ( !fs.existsSync(LOG) ) return [];
    var calls = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
    fs.unlinkSync(LOG);
    return calls;
}

describe('03a - project delegation: execFile(runtime, [cli, bundle:<verb>, @project, ...flags])', function () {

    it('each argument arrives whole under a path with a space, and shell syntax in a flag stays text', function (t, done) {
        var marker = path.join(TMP, 'RAN-project-flag');
        var argv   = [SPACED_CLI, 'bundle:start', '@shop', '--label=a b', '--x=$(touch ' + marker + ')', '--inspect=9229'];
        execFile(process.execPath, argv, { maxBuffer: 1024 * 500, env: ENV }, function (err, stdout) {
            assert.equal(err, null, String(err));
            assert.deepEqual(takeCalls(), [['bundle:start', '@shop', '--label=a b', '--x=$(touch ' + marker + ')', '--inspect=9229']]);
            assert.equal(stdout, 'ran bundle:start\n');
            assert.equal(fs.existsSync(marker), false, 'the flag was not run as a command');
            done();
        });
    });

    /**
     * The pre-change delegation line for a CLI path and flags.
     *
     * @inner
     * @param {string} cliPath
     * @param {string} flags - The inherited flags, joined
     * @returns {string}
     */
    function preChangeLine(cliPath, flags) {
        var _cmd = '$gina bundle:start @shop';
        if (flags != '') _cmd += ' ' + flags;
        return _cmd.replace(/\$(gina)/g, [process.execPath, cliPath].join(' '));
    }

    it('SUBTRACT: the pre-change command line fails under a path with a space, and never reaches the CLI', function (t, done) {
        exec(preChangeLine(SPACED_CLI, ''), { env: ENV }, function (err) {
            assert.ok(err, 'the shell line failed');
            assert.deepEqual(takeCalls(), [], 'the CLI never ran');
            done();
        });
    });

    it('SUBTRACT: on a path without a space, the pre-change command line runs shell syntax carried by a flag', function (t, done) {
        var marker = path.join(TMP, 'RAN-project-pre-change');
        exec(preChangeLine(PLAIN_CLI, '--x=$(touch ' + marker + ')'), { env: ENV }, function (err) {
            assert.equal(err, null, String(err));
            takeCalls();
            assert.equal(fs.existsSync(marker), true, 'the flag ran as a command');
            done();
        });
    });
});

describe('03b - auto-link children: execFileSync(runtime, [cli, link-node-modules, @project].concat(paramsArgv))', function () {

    it('a value with a space stays one argument, and shell syntax in it stays text', function () {
        var marker = path.join(TMP, 'RAN-link-flag');
        execFileSync(process.execPath, [SPACED_CLI, 'link-node-modules', '@shop'].concat(['--label=a b', '--x=$(touch ' + marker + ')']), { env: ENV });
        assert.deepEqual(takeCalls(), [['link-node-modules', '@shop', '--label=a b', '--x=$(touch ' + marker + ')']]);
        assert.equal(fs.existsSync(marker), false, 'the flag was not run as a command');
    });

    it('SUBTRACT: the pre-change quoted command line splits the value and runs the shell syntax', function () {
        var marker = path.join(TMP, 'RAN-link-pre-change');
        var paramsStringified = ' --label=a b --x=$(touch ' + marker + ')';
        execSync('"'+ process.execPath +'" "'+ PLAIN_CLI +'" link-node-modules @shop' + paramsStringified, { env: ENV });
        assert.deepEqual(takeCalls(), [['link-node-modules', '@shop', '--label=a', 'b', '--x=']], 'split, and the substitution replaced');
        assert.equal(fs.existsSync(marker), true, 'the flag ran as a command');
    });
});

describe('03c - bundle:stop names: the pre-change ps line ran what a name carried', function () {

    it('SUBTRACT: a `\'` in the bundle name breaks out of the single-quoted grep and runs', function () {
        var marker = path.join(TMP, 'RAN-stop-pre-change');
        var bundle = "x'; touch " + marker + "; echo '";
        execSync("ps -ef | grep -v grep | grep 'gina: "+ bundle + '@' + 'shop' +"' | awk '{print $2\" \"$8$9}'", { stdio: ['ignore', 'pipe', 'ignore'] });
        assert.equal(fs.existsSync(marker), true, 'the name ran as a command');
    });

    it('the JS filter treats the same name as text to match', function () {
        var marker = path.join(TMP, 'RAN-stop-filter');
        assert.equal(stopPid(LINUX_PS, "x'; touch " + marker + "; echo '", 'shop'), 0);
        assert.equal(fs.existsSync(marker), false);
    });
});

var IS_BUN = typeof Bun !== 'undefined';
var HAS_PS = (function () {
    try {
        execFileSync('ps', ['-ef'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
        return true;
    } catch (e) {
        return false;
    }
})();

describe('03d - live: the filters against the real `ps -ef`', { skip: (IS_BUN && 'under Bun (the Bun CI image ships no ps)') || (!HAS_PS && 'no ps on this host') }, function () {

    var tag      = 'b665live' + process.pid;
    var project  = 'p' + tag;
    var children = [];

    /**
     * Starts a process titled `gina: <bundle>@<project>`; resolves once the
     * title is set.
     *
     * @inner
     * @param {string} title
     * @returns {Promise<import('child_process').ChildProcess>}
     */
    function titled(title) {
        return new Promise(function (resolve, reject) {
            var child = spawn(process.execPath, ['-e', 'process.title = ' + JSON.stringify(title) + "; process.stdout.write('ready\\n'); setInterval(function () {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
            children.push(child);
            var timer = setTimeout(function () { reject(new Error('child not ready: ' + title)); }, 10000);
            child.stdout.once('data', function () { clearTimeout(timer); resolve(child); });
            child.once('error', reject);
        });
    }

    var own = null, sibling = null, listing = '';

    before(async function () {
        own     = await titled('gina: api@' + project);
        sibling = await titled('gina: api@' + project + 'xx');
        listing = execFileSync('ps', ['-ef'], { maxBuffer: 64 * 1024 * 1024 }).toString();
    });

    after(function () {
        children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } });
    });

    it('CONTROL: the listing shows both titled children', function () {
        assert.ok(listing.indexOf('gina: api@' + project) > -1);
        assert.ok(listing.indexOf('gina: api@' + project + 'xx') > -1);
    });

    it('bundle:stop\'s filter returns the titled child\'s PID from column 2', function () {
        assert.equal(stopPid(listing, 'api', project), own.pid);
    });

    it('minion:kill\'s pass finds the child, and not the sibling project\'s', function () {
        var pids = minionTargets(listing, project).map(function (x) { return x.pid; });
        assert.ok(pids.indexOf(own.pid) > -1, 'the child');
        assert.equal(pids.indexOf(sibling.pid), -1, 'not the sibling');
    });

    it('SUBTRACT: the pre-change substring match also takes the sibling', function () {
        var withoutOwn = listing.split('\n').filter(function (l) { return l.trim().split(/\s+/)[1] !== String(own.pid); }).join('\n');
        assert.equal(preChangeStopPid(withoutOwn, 'api', project), sibling.pid);
        assert.equal(stopPid(withoutOwn, 'api', project), 0);
    });
});
