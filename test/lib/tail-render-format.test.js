/**
 * lib/cmd/framework/tail.js — `gina tail` honours the logger's JSON render mode (#B524)
 *
 * The relay is the ONLY path a daemon-spawned bundle's runtime lines have to an
 * operator (the daemon discards the bundle's own stdout once it has started), so a
 * container that runs a framework daemon could not get JSON logs at all: tail.js
 * always rendered through the coloured `format()` helper. It now reads the render
 * mode its own logger resolved (`console.getOptions().format`, the logger's single
 * precedence rule) and writes one JSON object per line when that mode is `json`.
 *
 * tail.js cannot be required standalone (it reads framework globals at load), so
 * this suite source-pins the change and replicates `renderLine` as pure logic.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW       = require('../fw');
var TAIL_SRC = fs.readFileSync(path.join(FW, 'lib/cmd/framework/tail.js'), 'utf8');
var ESC      = String.fromCharCode(27);

/**
 * Replica of the render helper in tail.js. `format` is the coloured text renderer
 * the helper delegates to in text mode.
 */
function makeRenderLine(loggerOptions, format) {
    var isJsonMode = (loggerOptions && loggerOptions.format === 'json');
    return function renderLine(pl) {
        if (isJsonMode) {
            return JSON.stringify({
                ts     : new Date().toISOString(),
                level  : pl.level,
                bundle : pl.group,
                message: pl.content,
                group  : pl.group,
                msg    : pl.content
            }) + '\n';
        }
        return format(pl.group, pl.level, pl.content);
    };
}

describe('01 - tail.js render mode (source pins)', function () {

    it('derives the mode from the logger\'s resolved format — the one precedence rule, no env re-test', function () {
        assert.match(TAIL_SRC, /var isJsonMode = \(loggerOptions && loggerOptions\.format === 'json'\);/);
        assert.equal(TAIL_SRC.indexOf('process.env.GINA_LOG_FORMAT'), -1, 'tail.js must not re-derive the mode from the environment');
        assert.equal(TAIL_SRC.indexOf('process.env.GINA_LOG_STDOUT'), -1, 'tail.js must not re-derive the mode from the environment');
    });

    it('defines renderLine with a JSON branch shaped like the default container\'s line', function () {
        assert.match(TAIL_SRC, /var renderLine = function\(pl\) \{/);
        assert.match(TAIL_SRC, /bundle : pl\.group,\s*\n\s*message: pl\.content,\s*\n\s*group  : pl\.group,\s*\n\s*msg    : pl\.content/);
    });

    it('BOTH render sites — the replay of delayed messages and the live stream — go through renderLine', function () {
        var sites = TAIL_SRC.match(/process\.stdout\.write\( renderLine\(pl\) \);/g) || [];
        assert.equal(sites.length, 2, 'expected exactly two renderLine call sites, found ' + sites.length);
        assert.equal(TAIL_SRC.indexOf('process.stdout.write( format(pl.group, pl.level, pl.content) );'), -1,
            'no render site may bypass renderLine');
    });
});

describe('02 - renderLine (pure-logic replica)', function () {
    var fakeFormat = function (group, level, content) { return ESC + '[36m' + group + '|' + level + '|' + content + ESC + '[39m'; };
    var pl = { group: 'api@shop', level: 'info', content: 'GET [200] /health ' };

    it('text mode delegates to the coloured formatter untouched', function () {
        var render = makeRenderLine({ format: 'text' }, fakeFormat);
        assert.equal(render(pl), ESC + '[36mapi@shop|info|GET [200] /health ' + ESC + '[39m');
    });

    it('an absent format (a logger init path that predates #M12) renders text', function () {
        assert.equal(makeRenderLine({}, fakeFormat)(pl), fakeFormat(pl.group, pl.level, pl.content));
        assert.equal(makeRenderLine(null, fakeFormat)(pl), fakeFormat(pl.group, pl.level, pl.content));
    });

    it('json mode writes one newline-terminated object per line, never touching the formatter', function () {
        var called = false;
        var render = makeRenderLine({ format: 'json' }, function () { called = true; return 'X'; });
        var out = render(pl);
        assert.ok(/\n$/.test(out) && out.indexOf('\n') === out.length - 1, 'exactly one trailing newline');
        assert.equal(called, false);
        var obj = JSON.parse(out);
        assert.deepEqual(Object.keys(obj), ['ts', 'level', 'bundle', 'message', 'group', 'msg']);
        assert.equal(obj.level, 'info');
        assert.equal(obj.bundle, 'api@shop');
        assert.equal(obj.group, obj.bundle, 'group is the back-compat alias of bundle');
        assert.equal(obj.message, 'GET [200] /health ');
        assert.equal(obj.msg, obj.message, 'msg is the back-compat alias of message');
        assert.ok(!isNaN(Date.parse(obj.ts)) && /Z$/.test(obj.ts), 'ts is ISO 8601 UTC');
    });

    it('json mode carries no request context — the relay payload has none to give', function () {
        var obj = JSON.parse(makeRenderLine({ format: 'json' }, fakeFormat)(pl));
        assert.equal('requestId' in obj, false);
        assert.equal('durationMs' in obj, false);
    });

    it('json mode emits no ANSI escape even for a level the text formatter colours (the text control DOES)', function () {
        var warn = { group: 'api@shop', level: 'warn', content: 'x' };
        assert.equal(makeRenderLine({ format: 'json' }, fakeFormat)(warn).indexOf(ESC + '['), -1);
        assert.ok(makeRenderLine({ format: 'text' }, fakeFormat)(warn).indexOf(ESC + '[') > -1, 'the text control must carry the escape');
    });
});
