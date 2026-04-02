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

    it('start.js uses exec() for delegation', function() {
        startSrc = startSrc || getSrc('start.js');
        assert.ok(
            startSrc.indexOf("require('child_process').exec") > -1,
            'start.js must use child_process.exec'
        );
    });

    it('stop.js uses exec() for delegation', function() {
        stopSrc = stopSrc || getSrc('stop.js');
        assert.ok(
            stopSrc.indexOf("require('child_process').exec") > -1,
            'stop.js must use child_process.exec'
        );
    });

    it('restart.js uses exec() for delegation', function() {
        restartSrc = restartSrc || getSrc('restart.js');
        assert.ok(
            restartSrc.indexOf("require('child_process').exec") > -1,
            'restart.js must use child_process.exec'
        );
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


// ── 06 — Command string construction (pure logic) ───────────────────────────

describe('06 - command string construction', function() {

    // Replica of the $gina replacement logic
    function buildCmd(cmdStr, projectName, inheritedArgv, debugPort, debugBrkEnabled) {
        var _cmd = '$gina bundle:start @' + projectName;
        if (inheritedArgv != '') {
            _cmd += ' ' + inheritedArgv;
        }
        if (debugPort) {
            _cmd += ' --inspect';
            if (debugBrkEnabled) {
                _cmd += '-brk';
            }
            _cmd += '=' + debugPort;
        }
        _cmd = _cmd.replace(/\$(gina)/g, cmdStr);
        return _cmd;
    }

    it('basic command without flags', function() {
        assert.equal(
            buildCmd('/usr/bin/node /usr/local/bin/gina', 'myproject', '', null, false),
            '/usr/bin/node /usr/local/bin/gina bundle:start @myproject'
        );
    });

    it('with --env flag', function() {
        assert.equal(
            buildCmd('/usr/bin/node /usr/local/bin/gina', 'myproject', '--env=dev', null, false),
            '/usr/bin/node /usr/local/bin/gina bundle:start @myproject --env=dev'
        );
    });

    it('with --env and --scope flags', function() {
        assert.equal(
            buildCmd('/usr/bin/node /usr/local/bin/gina', 'myproject', '--env=dev --scope=local', null, false),
            '/usr/bin/node /usr/local/bin/gina bundle:start @myproject --env=dev --scope=local'
        );
    });

    it('with --inspect-brk flag', function() {
        assert.equal(
            buildCmd('/usr/bin/node /usr/local/bin/gina', 'myproject', '', 5000, true),
            '/usr/bin/node /usr/local/bin/gina bundle:start @myproject --inspect-brk=5000'
        );
    });

    it('with --inspect (no brk) flag', function() {
        assert.equal(
            buildCmd('/usr/bin/node /usr/local/bin/gina', 'myproject', '', 9229, false),
            '/usr/bin/node /usr/local/bin/gina bundle:start @myproject --inspect=9229'
        );
    });

    it('with all flags combined', function() {
        assert.equal(
            buildCmd('/usr/bin/node /usr/local/bin/gina', 'myproject', '--env=dev --scope=local', 5000, true),
            '/usr/bin/node /usr/local/bin/gina bundle:start @myproject --env=dev --scope=local --inspect-brk=5000'
        );
    });

    it('$gina replacement works with special characters in path', function() {
        var cmdStr = '/home/user/.npm-global/bin/node /home/user/.npm-global/lib/node_modules/gina/bin/gina';
        var result = buildCmd(cmdStr, 'test', '', null, false);
        assert.ok(result.indexOf('$gina') === -1, '$gina placeholder should be replaced');
        assert.ok(result.indexOf(cmdStr) > -1, 'full path should appear in result');
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
