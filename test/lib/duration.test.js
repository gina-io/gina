'use strict';
/**
 * lib/duration — unit-suffixed duration strings to milliseconds, the ONE dialect
 *
 * §01 behavioural matrix against the REAL module: the five units, case and
 *     whitespace tolerance, decimals, the legal zero, and every refusal — the
 *     parser never throws, it answers NaN so a caller can gate its own message.
 * §02 registry + delegation: `lib.duration.parse` is the module's function, and
 *     lib/storage's `parseDuration` IS that same function object (two dialects
 *     cannot drift when there is only one function) — plus a source pin that
 *     storage's util no longer carries a parser body of its own.
 *
 * Red-first (validated against a detached worktree at the pre-promotion HEAD):
 * §01 cannot load the module at all, and §02's delegation pins read the old
 * `function parseDuration(` body in storage's util.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var duration = require(path.join(FW, 'lib/duration/src/main.js'));
var UTIL_SRC = fs.readFileSync(path.join(FW, 'lib/storage/src/util.js'), 'utf8');

/**
 * Drop full-line comments so a negative pin cannot anchor on a JSDoc mention.
 *
 * @param   {string} source
 * @returns {string}
 * @inner
 */
function stripComments(source) {
    return source.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

// ─── 01 — behavioural matrix ─────────────────────────────────────────────────

describe('01 - lib/duration parse(): the dialect', function () {

    var TABLE = [
        ['500ms',   500],
        ['30s',     30000],
        ['15m',     900000],
        ['1h',      3600000],
        ['3h',      10800000],
        ['7d',      604800000],
        ['15d',     1296000000],
        ['1.5h',    5400000],
        ['0s',      0],
        ['0m',      0],
        ['15M',     900000],          // unit is case-insensitive
        ['3H',      10800000],
        ['30 s',    30000],           // whitespace between number and unit
        ['  15m  ', 900000]           // surrounding whitespace is trimmed
    ];

    TABLE.forEach(function (row) {
        it('parse(' + JSON.stringify(row[0]) + ') === ' + row[1], function () {
            assert.strictEqual(duration.parse(row[0]), row[1]);
        });
    });

    var REFUSED = [
        ['15',        'a bare number string carries no unit — refused, never assumed'],
        [15,          'a bare number — refused'],
        ['15x',       'an unknown unit'],
        ['ms',        'a unit with no number'],
        ['-5s',       'a negative span'],
        ['1e3s',      'exponent notation'],
        ['',          'the empty string'],
        [null,        'null'],
        [undefined,   'undefined'],
        [{},          'an object'],
        [['15m'],     'an array'],
        ['15m 30s',   'two components']
    ];

    REFUSED.forEach(function (row) {
        it('parse(' + JSON.stringify(row[0]) + ') is NaN — ' + row[1], function () {
            var out = duration.parse(row[0]);
            assert.ok(typeof out === 'number' && isNaN(out), 'expected NaN, got ' + JSON.stringify(out));
        });
    });

    it('never throws, whatever it is handed', function () {
        [null, undefined, 0, 1, true, {}, [], function () {}, Symbol('s')].forEach(function (v) {
            assert.doesNotThrow(function () { duration.parse(v); });
        });
    });

    it('CONTROL: a valid string does not read NaN (the refusal arms above can fail)', function () {
        assert.ok(!isNaN(duration.parse('1h')));
    });
});

// ─── 02 — registry + delegation ──────────────────────────────────────────────

describe('02 - one function, two consumers', function () {

    it('the module exports exactly { parse }', function () {
        assert.deepEqual(Object.keys(duration), ['parse']);
        assert.equal(typeof duration.parse, 'function');
    });

    it('lib/storage util delegates: its parseDuration IS lib/duration\'s parse', function () {
        var util = require(path.join(FW, 'lib/storage/src/util.js'));
        assert.strictEqual(util.parseDuration, duration.parse,
            'storage must delegate to the shared parser — a second body is a second dialect');
    });

    it('the storage util requires the shared module and carries no parser body of its own', function () {
        assert.ok(UTIL_SRC.indexOf("require('../../duration')") > -1,
            'storage/util must require lib/duration');
        assert.ok(UTIL_SRC.indexOf('var parseDuration = duration.parse;') > -1,
            'the delegation is a plain alias of the shared function');
        var active = stripComments(UTIL_SRC);
        assert.ok(UTIL_SRC.indexOf('parseDuration') > -1,
            'raw guard: the token must still appear (in the JSDoc) or the strip below proves nothing');
        assert.equal(active.indexOf('function parseDuration('), -1,
            'a parser body in storage/util would fork the dialect');
        assert.equal(active.indexOf('(ms|s|m|h|d)$/i'), -1,
            'the unit regex lives in lib/duration only');
    });
});
