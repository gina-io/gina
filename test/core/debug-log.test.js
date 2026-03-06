var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var CORE = path.resolve(__dirname, '../../framework/v0.1.6-alpha.177/core');

// Replica of the _isDebugLog function used in gna.js, server.js, and server.isaac.js.
// Tests below verify both the logic (via this replica) and that the three source files
// contain the matching implementation.
function _isDebugLog() {
    return process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
}


// 01 — _isDebugLog: enabled only for debug and trace
describe('01 - _isDebugLog: enabled only for debug and trace', function() {

    var _saved;

    beforeEach(function() {
        _saved = process.env.LOG_LEVEL;
    });

    afterEach(function() {
        if (typeof _saved === 'undefined') {
            delete process.env.LOG_LEVEL;
        } else {
            process.env.LOG_LEVEL = _saved;
        }
    });

    it('returns true when LOG_LEVEL is "debug"', function() {
        process.env.LOG_LEVEL = 'debug';
        assert.equal(_isDebugLog(), true);
    });

    it('returns true when LOG_LEVEL is "trace"', function() {
        process.env.LOG_LEVEL = 'trace';
        assert.equal(_isDebugLog(), true);
    });

    it('returns false when LOG_LEVEL is "info"', function() {
        process.env.LOG_LEVEL = 'info';
        assert.equal(_isDebugLog(), false);
    });

    it('returns false when LOG_LEVEL is "warn"', function() {
        process.env.LOG_LEVEL = 'warn';
        assert.equal(_isDebugLog(), false);
    });

    it('returns false when LOG_LEVEL is "error"', function() {
        process.env.LOG_LEVEL = 'error';
        assert.equal(_isDebugLog(), false);
    });

    it('returns false when LOG_LEVEL is "notice"', function() {
        process.env.LOG_LEVEL = 'notice';
        assert.equal(_isDebugLog(), false);
    });

    it('returns false when LOG_LEVEL is not set', function() {
        delete process.env.LOG_LEVEL;
        assert.equal(_isDebugLog(), false);
    });

    it('source: all three files use strict === comparison for "debug" and "trace"', function() {
        var files = ['gna.js', 'server.js', 'server.isaac.js'];
        for (var i = 0; i < files.length; ++i) {
            var src = fs.readFileSync(path.join(CORE, files[i]), 'utf8');
            assert.ok(
                src.indexOf("process.env.LOG_LEVEL === 'debug'") > -1,
                files[i] + ': missing `process.env.LOG_LEVEL === \'debug\'`'
            );
            assert.ok(
                src.indexOf("process.env.LOG_LEVEL === 'trace'") > -1,
                files[i] + ': missing `process.env.LOG_LEVEL === \'trace\'`'
            );
        }
    });

});


// 02 — _debugLog format: matches logger template [%d] [%s][%a] %m
describe('02 - _debugLog format: matches logger template [%d] [%s][%a] %m', function() {

    it('level tag is padded to _maxLevelLen=7 chars: "[debug  ]"', function() {
        // Gina logger pads level names to _maxLevelLen=7 ('warning' is the longest at 7 chars).
        // 'debug' is 5 chars → padded to 'debug  ' (2 trailing spaces).
        var level = 'debug';
        var _maxLevelLen = 7;
        var padded = level + ' '.repeat(_maxLevelLen - level.length);
        assert.equal(padded, 'debug  ');
        assert.equal('[' + padded + ']', '[debug  ]');
    });

    it('date formatter produces yyyy mmm dd HH:MM:ss pattern', function() {
        var _m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var p2 = function(n) { return (n < 10 ? '0' : '') + n; };
        var d = new Date(2026, 2, 5, 17, 37, 45); // 2026 Mar 05 17:37:45
        var formatted = d.getFullYear() + ' ' + _m[d.getMonth()] + ' ' + p2(d.getDate())
            + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
        assert.equal(formatted, '2026 Mar 05 17:37:45');
    });

    it('date formatter zero-pads single-digit day and time components', function() {
        var _m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var p2 = function(n) { return (n < 10 ? '0' : '') + n; };
        var d = new Date(2026, 0, 1, 8, 5, 3); // 2026 Jan 01 08:05:03
        var formatted = d.getFullYear() + ' ' + _m[d.getMonth()] + ' ' + p2(d.getDate())
            + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
        assert.equal(formatted, '2026 Jan 01 08:05:03');
    });

    it('all 12 month abbreviations are correct', function() {
        var _m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var expected = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        assert.deepEqual(_m, expected);
    });

    it('output line matches full format pattern with ANSI gray codes', function() {
        // Full pattern: ESC[90m[yyyy mmm dd HH:MM:ss] [debug  ][gina:<group>] <msg>ESC[39m\n
        // _maxLevelLen=7 ('warning' is longest), 'debug' (5 chars) → 2 trailing spaces
        var pattern = /^\u001b\[90m\[\d{4} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2}\] \[debug  \]\[gina:[a-z]+\] .+\u001b\[39m\n$/;
        var _m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var p2 = function(n) { return (n < 10 ? '0' : '') + n; };
        var d = new Date(2026, 2, 5, 17, 37, 45);
        var line = '\u001b[90m[' + d.getFullYear() + ' ' + _m[d.getMonth()] + ' ' + p2(d.getDate())
            + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
            + '] [debug  ][gina:gna] checkpoint A: loading lib\u001b[39m\n';
        assert.match(line, pattern);
    });

    it('source: all three files contain the [debug  ] level tag string', function() {
        var files = ['gna.js', 'server.js', 'server.isaac.js'];
        for (var i = 0; i < files.length; ++i) {
            var src = fs.readFileSync(path.join(CORE, files[i]), 'utf8');
            assert.ok(
                src.indexOf('] [debug  ][gina:') > -1,
                files[i] + ': missing `] [debug  ][gina:` in _debugLog format string'
            );
        }
    });

});


// 03 — source files: ANSI gray codes and group tags present in all three files
describe('03 - source files: ANSI gray codes and group tags present', function() {

    var files = [
        { name: 'gna.js',          group: 'gina:gna' },
        { name: 'server.js',       group: 'gina:server' },
        { name: 'server.isaac.js', group: 'gina:isaac' }
    ];

    for (var fi = 0; fi < files.length; ++fi) {
        (function(f) {

            it(f.name + ': contains ANSI gray open \\u001b[90m', function() {
                // Source files store the escape as the literal text \u001b[90m (not the ESC byte).
                // fs.readFileSync returns raw text, so we search for the backslash sequence.
                var src = fs.readFileSync(path.join(CORE, f.name), 'utf8');
                assert.ok(src.indexOf('\\u001b[90m') > -1, f.name + ' missing \\u001b[90m (ANSI gray open)');
            });

            it(f.name + ': contains ANSI gray close \\u001b[39m', function() {
                var src = fs.readFileSync(path.join(CORE, f.name), 'utf8');
                assert.ok(src.indexOf('\\u001b[39m') > -1, f.name + ' missing \\u001b[39m (ANSI default color reset)');
            });

            it(f.name + ': uses correct group tag [' + f.group + ']', function() {
                var src = fs.readFileSync(path.join(CORE, f.name), 'utf8');
                assert.ok(
                    src.indexOf('][' + f.group + ']') > -1,
                    f.name + ' missing group tag [' + f.group + '] in _debugLog format string'
                );
            });

        })(files[fi]);
    }

});
