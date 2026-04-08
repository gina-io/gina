var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var CMD_DIR = path.join(FW, 'lib/cmd/framework');


// ── 01 — Handler file exists and is non-empty ─────────────────────────────────

describe('01 - framework:get handler file exists', function() {

    it('get.js exists and is non-empty', function() {
        var f = path.join(CMD_DIR, 'get.js');
        assert.ok(fs.existsSync(f), 'get.js does not exist');
        assert.ok(fs.statSync(f).size > 0, 'get.js is empty');
    });

});


// ── 02 — Source structure: exports a constructor ──────────────────────────────

describe('02 - framework:get source structure', function() {

    var src;

    function getSrc() {
        return src || (src = fs.readFileSync(path.join(CMD_DIR, 'get.js'), 'utf8'));
    }

    it('exports Get', function() {
        assert.ok(/module\.exports\s*=\s*Get/.test(getSrc()));
    });

    it('defines function Get(opt, cmd)', function() {
        assert.ok(/function Get\(opt,?\s*cmd\)/.test(getSrc()));
    });

    it('uses lib.logger', function() {
        assert.ok(getSrc().indexOf('lib.logger') > -1);
    });

    it('reads GINA_SHORT_VERSION settings path', function() {
        assert.ok(getSrc().indexOf('GINA_SHORT_VERSION') > -1);
    });

    it('calls process.exit(0)', function() {
        assert.ok(getSrc().indexOf('process.exit(0)') > -1);
    });

});


// ── 03 — Pure logic: key lookup and formatting ────────────────────────────────

describe('03 - framework:get key lookup logic', function() {

    // Replica of the get() key-lookup logic from get.js
    function getSettings(settings, argv) {
        var str = '', key = '';
        var bulk = argv.length > 3;

        if (!bulk) {
            for (var prop in settings) {
                str += prop +' = '+ settings[prop] +'\n';
            }
        } else {
            // check for explicit all
            for (var i = 3; i < argv.length; ++i) {
                if ( /^(\-\-all|all)$/i.test(argv[i]) ) {
                    for (var prop in settings) {
                        str += prop +' = '+ settings[prop] +'\n';
                    }
                    break;
                }
            }

            if (str == '') {
                for (var i = 3; i < argv.length; ++i) {
                    if ( /^(\-\-)/.test(argv[i]) ) {
                        key = argv[i].replace(/\-\-/, '').replace(/\-/g, '_');
                    } else {
                        key = argv[i].replace(/\-/g, '_');
                    }
                    if ( typeof(settings[key]) != 'undefined' ) {
                        str += settings[key] +'\n';
                    }
                }
            }
        }

        return (str != '') ? str.substring(0, str.length-1) : '';
    }

    var testSettings = {
        port: 3100,
        log_level: 'info',
        env: 'dev',
        hostname: 'test-host'
    };

    it('prints all keys when no args', function() {
        var result = getSettings(testSettings, ['node', 'gina', 'framework:get']);
        assert.ok(result.indexOf('port = 3100') > -1);
        assert.ok(result.indexOf('log_level = info') > -1);
        assert.ok(result.indexOf('env = dev') > -1);
        assert.ok(result.indexOf('hostname = test-host') > -1);
    });

    it('prints all keys with explicit "all"', function() {
        var result = getSettings(testSettings, ['node', 'gina', 'framework:get', 'all']);
        assert.ok(result.indexOf('port = 3100') > -1);
        assert.ok(result.indexOf('log_level = info') > -1);
    });

    it('prints all keys with "--all"', function() {
        var result = getSettings(testSettings, ['node', 'gina', 'framework:get', '--all']);
        assert.ok(result.indexOf('port = 3100') > -1);
    });

    it('prints single key with --flag style', function() {
        var result = getSettings(testSettings, ['node', 'gina', 'framework:get', '--port']);
        assert.equal(result, '3100');
    });

    it('prints single key with bare name', function() {
        var result = getSettings(testSettings, ['node', 'gina', 'framework:get', 'port']);
        assert.equal(result, '3100');
    });

    it('converts hyphens to underscores in --flag style', function() {
        var result = getSettings(testSettings, ['node', 'gina', 'framework:get', '--log-level']);
        assert.equal(result, 'info');
    });

    it('converts hyphens to underscores in bare key', function() {
        var result = getSettings(testSettings, ['node', 'gina', 'framework:get', 'log-level']);
        assert.equal(result, 'info');
    });

    it('prints multiple keys', function() {
        var result = getSettings(testSettings, ['node', 'gina', 'framework:get', '--port', '--env']);
        assert.equal(result, '3100\ndev');
    });

    it('returns empty string for unknown key', function() {
        var result = getSettings(testSettings, ['node', 'gina', 'framework:get', '--nonexistent']);
        assert.equal(result, '');
    });

});


// ── 04 — help.txt documents get/set pair ──────────────────────────────────────

describe('04 - help.txt documents framework:get', function() {

    var helpPath = path.join(CMD_DIR, 'help.txt');
    var helpSrc;

    function getHelp() {
        return helpSrc || (helpSrc = fs.readFileSync(helpPath, 'utf8'));
    }

    it('help.txt exists', function() {
        assert.ok(fs.existsSync(helpPath));
    });

    it('documents gina get', function() {
        assert.ok(getHelp().indexOf('gina get') > -1);
    });

    it('documents --key syntax', function() {
        assert.ok(getHelp().indexOf('--key') > -1);
    });

    it('documents --all / all syntax', function() {
        assert.ok(getHelp().indexOf('all') > -1);
    });

});
