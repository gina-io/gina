var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var CMD_DIR = path.join(FW, 'lib/cmd/project');


// ── 01 — Handler files exist and are non-empty ──────────────────────────────

describe('01 - project:start/stop/restart handler files exist', function() {

    it('start.js exists and is non-empty', function() {
        var f = path.join(CMD_DIR, 'start.js');
        assert.ok(fs.existsSync(f), 'start.js does not exist');
        assert.ok(fs.statSync(f).size > 0, 'start.js is empty');
    });

    it('stop.js exists and is non-empty', function() {
        var f = path.join(CMD_DIR, 'stop.js');
        assert.ok(fs.existsSync(f), 'stop.js does not exist');
        assert.ok(fs.statSync(f).size > 0, 'stop.js is empty');
    });

    it('restart.js exists and is non-empty', function() {
        var f = path.join(CMD_DIR, 'restart.js');
        assert.ok(fs.existsSync(f), 'restart.js does not exist');
        assert.ok(fs.statSync(f).size > 0, 'restart.js is empty');
    });

});


// ── 02 — Source structure: delegation pattern ────────────────────────────────

describe('02 - project handlers delegate to bundle commands', function() {

    var startSrc, stopSrc, restartSrc;

    function getSrc(name) {
        return fs.readFileSync(path.join(CMD_DIR, name), 'utf8');
    }

    it('start.js shells out to gina bundle:start', function() {
        startSrc = getSrc('start.js');
        assert.ok(
            startSrc.indexOf('bundle:start') > -1,
            'start.js must delegate to bundle:start'
        );
    });

    it('stop.js shells out to gina bundle:stop', function() {
        stopSrc = getSrc('stop.js');
        assert.ok(
            stopSrc.indexOf('bundle:stop') > -1,
            'stop.js must delegate to bundle:stop'
        );
    });

    it('restart.js shells out to gina bundle:restart', function() {
        restartSrc = getSrc('restart.js');
        assert.ok(
            restartSrc.indexOf('bundle:restart') > -1,
            'restart.js must delegate to bundle:restart'
        );
    });

    // #B665 — comment-stripped: the pre-change `exec` lines survive as `was:` comments, and
    // `require('child_process').execFile` contains `require('child_process').exec` as a
    // substring, so the raw source cannot tell the two apart.
    function liveSrc(src) {
        return src.split('\n').filter(function(l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
    }

    it('start.js uses execFile() for delegation (no shell)', function() {
        startSrc = startSrc || getSrc('start.js');
        var live = liveSrc(startSrc);
        assert.ok(
            live.indexOf("require('child_process').execFile;") > -1,
            'start.js must use child_process.execFile'
        );
        assert.equal(/\bexec\(/.test(live), false, 'start.js must not call exec(');
    });

    it('stop.js uses execFile() for delegation (no shell)', function() {
        stopSrc = stopSrc || getSrc('stop.js');
        var live = liveSrc(stopSrc);
        assert.ok(
            live.indexOf("require('child_process').execFile;") > -1,
            'stop.js must use child_process.execFile'
        );
        assert.equal(/\bexec\(/.test(live), false, 'stop.js must not call exec(');
    });

    it('restart.js uses execFile() for delegation (no shell)', function() {
        restartSrc = restartSrc || getSrc('restart.js');
        var live = liveSrc(restartSrc);
        assert.ok(
            live.indexOf("require('child_process').execFile;") > -1,
            'restart.js must use child_process.execFile'
        );
        assert.equal(/\bexec\(/.test(live), false, 'restart.js must not call exec(');
    });

});


// ── 03 — Source structure: CmdHelper and isCmdConfigured ─────────────────────

describe('03 - project handlers use CmdHelper pattern', function() {

    function getSrc(name) {
        return fs.readFileSync(path.join(CMD_DIR, name), 'utf8');
    }

    it('start.js imports CmdHelper', function() {
        assert.ok(getSrc('start.js').indexOf('CmdHelper') > -1);
    });

    it('stop.js imports CmdHelper', function() {
        assert.ok(getSrc('stop.js').indexOf('CmdHelper') > -1);
    });

    it('restart.js imports CmdHelper', function() {
        assert.ok(getSrc('restart.js').indexOf('CmdHelper') > -1);
    });

    it('start.js calls isCmdConfigured()', function() {
        assert.ok(getSrc('start.js').indexOf('isCmdConfigured()') > -1);
    });

    it('stop.js calls isCmdConfigured()', function() {
        assert.ok(getSrc('stop.js').indexOf('isCmdConfigured()') > -1);
    });

    it('restart.js calls isCmdConfigured()', function() {
        assert.ok(getSrc('restart.js').indexOf('isCmdConfigured()') > -1);
    });

});


// ── 04 — Source structure: exports a constructor ─────────────────────────────

describe('04 - project handlers export constructors', function() {

    function getSrc(name) {
        return fs.readFileSync(path.join(CMD_DIR, name), 'utf8');
    }

    it('start.js exports Start', function() {
        assert.ok(/module\.exports\s*=\s*Start/.test(getSrc('start.js')));
    });

    it('stop.js exports Stop', function() {
        assert.ok(/module\.exports\s*=\s*Stop/.test(getSrc('stop.js')));
    });

    it('restart.js exports Restart', function() {
        assert.ok(/module\.exports\s*=\s*Restart/.test(getSrc('restart.js')));
    });

});


// ── 05 — Flag forwarding ────────────────────────────────────────────────────

describe('05 - project:start and project:restart forward flags', function() {

    function getSrc(name) {
        return fs.readFileSync(path.join(CMD_DIR, name), 'utf8');
    }

    it('start.js collects inheritedArgv', function() {
        assert.ok(getSrc('start.js').indexOf('inheritedArgv') > -1);
    });

    it('restart.js collects inheritedArgv', function() {
        assert.ok(getSrc('restart.js').indexOf('inheritedArgv') > -1);
    });

    it('start.js handles debugPort', function() {
        assert.ok(getSrc('start.js').indexOf('opt.debugPort') > -1);
    });

    it('restart.js handles debugPort', function() {
        assert.ok(getSrc('restart.js').indexOf('opt.debugPort') > -1);
    });

    it('start.js handles debugBrkEnabled', function() {
        assert.ok(getSrc('start.js').indexOf('opt.debugBrkEnabled') > -1);
    });

    it('restart.js handles debugBrkEnabled', function() {
        assert.ok(getSrc('restart.js').indexOf('opt.debugBrkEnabled') > -1);
    });

});


// ── 06 — Argument vector construction (pure logic) ──────────────────────────

describe('06 - argument vector construction (#B665)', function() {

    // Replica of the argument assembly (was: a `$gina …` command line run through a shell)
    function buildArgv(cliArgv, projectName, inheritedArgv, debugPort, debugBrkEnabled) {
        var argv = [cliArgv[1], 'bundle:start', '@' + projectName].concat(inheritedArgv);
        if (debugPort) {
            argv.push('--inspect' + (debugBrkEnabled ? '-brk' : '') + '=' + debugPort);
        }
        return { file: cliArgv[0], args: argv };
    }

    var CLI = ['/usr/bin/node', '/usr/local/lib/node_modules/gina/bin/cli'];

    it('basic command without flags', function() {
        assert.deepEqual(
            buildArgv(CLI, 'myproject', [], null, false),
            { file: '/usr/bin/node', args: [CLI[1], 'bundle:start', '@myproject'] }
        );
    });

    it('with --env flag', function() {
        assert.deepEqual(
            buildArgv(CLI, 'myproject', ['--env=dev'], null, false).args,
            [CLI[1], 'bundle:start', '@myproject', '--env=dev']
        );
    });

    it('with --env and --scope flags', function() {
        assert.deepEqual(
            buildArgv(CLI, 'myproject', ['--env=dev', '--scope=local'], null, false).args,
            [CLI[1], 'bundle:start', '@myproject', '--env=dev', '--scope=local']
        );
    });

    it('with --inspect-brk flag', function() {
        assert.deepEqual(
            buildArgv(CLI, 'myproject', [], 5000, true).args,
            [CLI[1], 'bundle:start', '@myproject', '--inspect-brk=5000']
        );
    });

    it('with --inspect (no brk) flag', function() {
        assert.deepEqual(
            buildArgv(CLI, 'myproject', [], 9229, false).args,
            [CLI[1], 'bundle:start', '@myproject', '--inspect=9229']
        );
    });

    it('with all flags combined', function() {
        assert.deepEqual(
            buildArgv(CLI, 'myproject', ['--env=dev', '--scope=local'], 5000, true).args,
            [CLI[1], 'bundle:start', '@myproject', '--env=dev', '--scope=local', '--inspect-brk=5000']
        );
    });

    it('a path with a space stays one argument', function() {
        var spaced = ['/home/user/My Tools/bin/node', '/home/user/My Tools/lib/node_modules/gina/bin/cli'];
        var result = buildArgv(spaced, 'test', [], null, false);
        assert.equal(result.file, spaced[0], 'the runtime path is the file to run, whole');
        assert.equal(result.args[0], spaced[1], 'the CLI script path is one argument, whole');
        assert.equal(result.args.length, 3);
    });

});


// ── 07 — help.txt documents all three commands ──────────────────────────────

describe('07 - help.txt documents project:start/stop/restart', function() {

    var helpPath = path.join(CMD_DIR, 'help.txt');
    var helpSrc;

    function getHelp() {
        return helpSrc || (helpSrc = fs.readFileSync(helpPath, 'utf8'));
    }

    it('help.txt exists', function() {
        assert.ok(fs.existsSync(helpPath));
    });

    it('documents project:start', function() {
        assert.ok(getHelp().indexOf('project:start') > -1);
    });

    it('documents project:stop', function() {
        assert.ok(getHelp().indexOf('project:stop') > -1);
    });

    it('documents project:restart', function() {
        assert.ok(getHelp().indexOf('project:restart') > -1);
    });

    it('documents --env flag', function() {
        assert.ok(getHelp().indexOf('--env=') > -1);
    });

    it('documents --scope flag', function() {
        assert.ok(getHelp().indexOf('--scope') > -1);
    });

    it('documents --inspect-brk flag', function() {
        assert.ok(getHelp().indexOf('--inspect-brk') > -1);
    });

});


// ── 08 — arguments.json includes expected flags ─────────────────────────────

describe('08 - arguments.json includes expected flags', function() {

    var args = require(path.join(CMD_DIR, 'arguments.json'));

    it('includes --env', function() {
        assert.ok(args.indexOf('--env') > -1);
    });

    it('includes --scope', function() {
        assert.ok(args.indexOf('--scope') > -1);
    });

    it('is an array', function() {
        assert.ok(Array.isArray(args));
    });

});


// ── 09 — project:add terminates when package.json already exists ────────────
// Regression guard: the `else` branch at add.js:~115 used to do nothing, so
// the process hung forever (MQSpeaker on 8125 kept the event loop alive) when
// running `gina project:add @foo --path=<dir with existing package.json>`.
// Fix: call createPackageFile(target, true) to merge+rewrite+end().

describe('09 - project:add handles existing package.json', function() {

    var addPath = path.join(CMD_DIR, 'add.js');
    var addSrc;

    function getSrc() {
        return addSrc || (addSrc = fs.readFileSync(addPath, 'utf8'));
    }

    it('add.js exists and is non-empty', function() {
        assert.ok(fs.existsSync(addPath), 'add.js does not exist');
        assert.ok(fs.statSync(addPath).size > 0, 'add.js is empty');
    });

    it('createPackageFile accepts isCreatedFromExistingPackage flag', function() {
        assert.ok(
            /function\s*\(\s*target\s*,\s*isCreatedFromExistingPackage\s*\)/.test(getSrc()),
            'createPackageFile signature must accept isCreatedFromExistingPackage'
        );
    });

    it('createPackageFile branch merges with existing and deletes old file', function() {
        var src = getSrc();
        assert.ok(
            src.indexOf('existingPack = require(target)') > -1,
            'createPackageFile must load the existing package.json via require(target)'
        );
        assert.ok(
            /merge\s*\(\s*contentFile\s*,\s*existingPack\s*\)/.test(src),
            'createPackageFile must merge framework template with existing package'
        );
    });

    it('createPackageFile ends the process after writing (calls end)', function() {
        var src = getSrc();
        var fnStart = src.indexOf('var createPackageFile');
        assert.ok(fnStart > -1, 'createPackageFile definition not found');
        var fnBody = src.slice(fnStart, fnStart + 2000);
        assert.ok(
            /end\s*\(\s*true\s*\)/.test(fnBody),
            'createPackageFile must call end(true) to exit the process'
        );
    });

    it('package.json-already-exists branch invokes createPackageFile(target, true)', function() {
        var src = getSrc();
        var warnIdx = src.indexOf('already exists in this location');
        assert.ok(warnIdx > -1, 'existing-package.json warning message not found');
        var followUp = src.slice(warnIdx, warnIdx + 500);
        assert.ok(
            /createPackageFile\s*\(\s*file\.toString\(\)\s*,\s*true\s*\)/.test(followUp),
            'else branch must call createPackageFile(file.toString(), true) to terminate the process'
        );
    });

});
