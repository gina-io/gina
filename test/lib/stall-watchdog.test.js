'use strict';
/**
 * lib/stall-watchdog — the main-thread side, in process:
 *
 *   §01 resolveConfig(): absent / off / truthy-non-boolean / non-object blocks
 *       resolve off (with a warning where a typo would otherwise be silent); an
 *       enabled block resolves its defaults; every wrong key or value on an
 *       enabled block throws (the boot refusal), and the messages name the key.
 *   §02 resolveLogGroup(): the twin of the logger's group derivation.
 *   §03 buildLogContext(): what the worker needs to write the logger's line.
 *   §04 off: init() starts nothing without an enabled conf, and enter() is a
 *       no-op (no mark on the request) while no thread runs.
 *   §05 the registry: a plain require in lib/index.js, so a dev-mode hot reload
 *       never re-evaluates the module that owns the thread.
 *   §06 the parseTimeout replica this file installs is pinned to its source.
 *
 * The worker itself, the sinks and the timing are driven in child processes:
 * test/lib/stall-watchdog-worker.test.js.
 *
 * Run: node --test test/lib/stall-watchdog.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW = require('../fw');

// The lib calls the framework-global `parseTimeout` (installed at boot by
// utils/helper.js; the lib/rate-limit house precedent). Standalone, install a
// verbatim replica — §06 pins it against the real source so it cannot drift.
var PARSE_TIMEOUT_REPLICA = function(value) {
    if (value === false || value === null || typeof value === 'undefined' || value === '') {
        return null;
    }
    if (typeof value === 'number') {
        // 0 is a valid value — it disables the timeout in Node.js APIs
        return value;
    }
    if (typeof value === 'string') {
        var _match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
        if (!_match) return null;
        var _n = parseFloat(_match[1]);
        switch (_match[2]) {
            case 'ms': return Math.round(_n);
            case 's':  return Math.round(_n * 1000);
            case 'm':  return Math.round(_n * 60000);
            case 'h':  return Math.round(_n * 3600000);
        }
    }
    return null;
};
if ( typeof(global.parseTimeout) == 'undefined' ) { global.parseTimeout = PARSE_TIMEOUT_REPLICA; }

var SW_PATH    = path.join(FW, 'lib/stall-watchdog/src/main.js');
var sw         = require(SW_PATH);
var HELPER_SRC = fs.readFileSync(path.resolve(__dirname, '../../utils/helper.js'), 'utf8');
var INDEX_SRC  = fs.readFileSync(path.join(FW, 'lib/index.js'), 'utf8');

describe('01 - resolveConfig()', function() {

    it('01.01 - an absent block is off, with no warning', function() {
        assert.deepEqual(sw.resolveConfig(undefined), { enabled: false, warning: null });
        assert.deepEqual(sw.resolveConfig(null), { enabled: false, warning: null });
    });

    it('01.02 - enabled false or absent is off, with no warning', function() {
        assert.deepEqual(sw.resolveConfig({}), { enabled: false, warning: null });
        assert.deepEqual(sw.resolveConfig({ enabled: false, threshold: 'nonsense' }), { enabled: false, warning: null }, 'an off block is not validated');
    });

    it('01.03 - a truthy non-boolean enabled is off, WITH a warning naming the value', function() {
        var r = sw.resolveConfig({ enabled: 'true' });
        assert.equal(r.enabled, false);
        assert.match(r.warning, /server\.stallWatchdog\.enabled` is "true" \(a string\), expected the boolean true: the watchdog stays off/);
        assert.equal(sw.resolveConfig({ enabled: 1 }).enabled, false);
        assert.match(sw.resolveConfig({ enabled: 1 }).warning, /\(a number\)/);
    });

    it('01.04 - a block that is not an object is off, with a warning', function() {
        [true, 'yes', 5, ['enabled']].forEach(function(block) {
            var r = sw.resolveConfig(block);
            assert.equal(r.enabled, false, show(block));
            assert.match(r.warning, /`server\.stallWatchdog` must be an object/, show(block));
        });
    });

    it('01.05 - an enabled block resolves the defaults', function() {
        assert.deepEqual(sw.resolveConfig({ enabled: true }), {
            enabled: true, warning: null, thresholdMs: 5000, captureFrames: true, frames: 8, inFlight: 8
        });
        assert.deepEqual(sw.DEFAULTS, { threshold: '5s', captureFrames: true, frames: 8, inFlight: 8 });
    });

    it('01.06 - threshold accepts a unit string or milliseconds, from 1s', function() {
        assert.equal(sw.resolveConfig({ enabled: true, threshold: '2s' }).thresholdMs, 2000);
        assert.equal(sw.resolveConfig({ enabled: true, threshold: '1500ms' }).thresholdMs, 1500);
        assert.equal(sw.resolveConfig({ enabled: true, threshold: '1m' }).thresholdMs, 60000);
        assert.equal(sw.resolveConfig({ enabled: true, threshold: 1000 }).thresholdMs, 1000);
        assert.equal(sw.resolveConfig({ enabled: true, threshold: '1s' }).thresholdMs, sw.MIN_THRESHOLD_MS);
    });

    it('01.07 - a threshold under 1s, unparseable or of another type refuses, naming the key and the value', function() {
        ['500ms', '0.9s', 999, 0, -5, 'soon', '5', '', NaN, Infinity, true, {}, null].forEach(function(v) {
            assert.throws(function() { sw.resolveConfig({ enabled: true, threshold: v }); },
                /^Error: \[SERVER\]\[stallWatchdog\] `server\.stallWatchdog\.threshold` must be a timeout of at least 1s \(e\.g\. "5s", 2000\), got `/,
                'threshold ' + show(v));
        });
    });

    it('01.08 - frames: an integer from 1 to 32', function() {
        assert.equal(sw.resolveConfig({ enabled: true, frames: 1 }).frames, 1);
        assert.equal(sw.resolveConfig({ enabled: true, frames: 32 }).frames, 32);
        [0, 33, 1.5, '8', null, true].forEach(function(v) {
            assert.throws(function() { sw.resolveConfig({ enabled: true, frames: v }); },
                /`server\.stallWatchdog\.frames` must be an integer from 1 to 32, got `/, 'frames ' + show(v));
        });
    });

    it('01.09 - inFlight: an integer from 1 to 64', function() {
        assert.equal(sw.resolveConfig({ enabled: true, inFlight: 64 }).inFlight, 64);
        [0, 65, 2.5, '8', null].forEach(function(v) {
            assert.throws(function() { sw.resolveConfig({ enabled: true, inFlight: v }); },
                /`server\.stallWatchdog\.inFlight` must be an integer from 1 to 64, got `/, 'inFlight ' + show(v));
        });
    });

    it('01.10 - captureFrames: a boolean', function() {
        assert.equal(sw.resolveConfig({ enabled: true, captureFrames: false }).captureFrames, false);
        ['false', 0, 1, null].forEach(function(v) {
            assert.throws(function() { sw.resolveConfig({ enabled: true, captureFrames: v }); },
                /`server\.stallWatchdog\.captureFrames` must be a boolean, got `/, 'captureFrames ' + show(v));
        });
    });

    it('01.11 - an unknown key on an enabled block refuses, naming it and the known keys', function() {
        assert.throws(function() { sw.resolveConfig({ enabled: true, treshold: '2s' }); },
            /`server\.stallWatchdog\.treshold` is not a key of this block \(its keys: enabled, threshold, captureFrames, frames, inFlight\)/);
    });
});

describe('02 - resolveLogGroup(name, title)', function() {

    it('02.01 - a bundle title names the group, without its gina: prefix', function() {
        assert.equal(sw.resolveLogGroup('gina', 'gina: api@myproject'), 'api@myproject');
        assert.equal(sw.resolveLogGroup('gina', 'gina:api@myproject'), 'api@myproject');
    });

    it('02.02 - a node title keeps the logger\'s name', function() {
        assert.equal(sw.resolveLogGroup('gina', 'node'), 'gina');
        assert.equal(sw.resolveLogGroup('gina', '/usr/local/bin/node'), 'gina');
        assert.equal(sw.resolveLogGroup('custom', 'node'), 'custom');
        assert.equal(sw.resolveLogGroup(undefined, 'node'), 'gina');
    });

    it('02.03 - a gina-… title falls back to gina', function() {
        assert.equal(sw.resolveLogGroup('gina', 'gina-inspector'), 'gina');
    });

    it('02.04 - the twin carries the logger\'s own lines (source pin)', function() {
        var src = fs.readFileSync(path.join(FW, 'lib/logger/src/main.js'), 'utf8');
        assert.ok(src.indexOf("if ( process.title != 'node' && !/(\\\\|\\/)*node$/.test(process.title) ) {") > -1, 'the logger\'s title test');
        assert.ok(src.indexOf("group = process.title.replace(/^gina\\:\\s*/, '');") > -1, 'the logger\'s prefix strip');
        assert.ok(src.indexOf("if ( typeof(group) == 'undefined' || /^gina\\-/.test(group) ) {") > -1, 'the logger\'s gina- fallback');
    });
});

describe('03 - buildLogContext(logger, title)', function() {

    function fakeLogger(opt, loggers) {
        return {
            getOptions : function() { return opt; },
            getLoggers : function() { return loggers; }
        };
    }

    it('03.01 - reads the group, format, flows, template, level width and crit colour', function() {
        var ctx = sw.buildLogContext(fakeLogger({
            name: 'gina', format: 'json', flows: ['default', 'mq'], template: '[%d] [%s][%a] %m',
            levels: { emerg: {}, crit: { color: 'magenta' }, warning: {}, info: {} }
        }, {
            'api@app': { colors: { magenta: { open: '\u001b[35m', close: '\u001b[39m' } } }
        }), 'gina: api@app');
        assert.deepEqual(ctx, {
            group: 'api@app', format: 'json', flows: ['default', 'mq'], template: '[%d] [%s][%a] %m',
            maxLevelLen: 7, colorCode: 'magenta', color: { open: '\u001b[35m', close: '\u001b[39m' }
        });
    });

    it('03.02 - a group with no registry yet takes gina\'s colours (format()\'s own fallback)', function() {
        var ctx = sw.buildLogContext(fakeLogger({ name: 'gina', levels: { crit: { color: 'magenta' } } }, {
            gina: { colors: { magenta: { open: 'O', close: 'C' } } }
        }), 'gina: fresh@app');
        assert.equal(ctx.group, 'fresh@app');
        assert.deepEqual(ctx.color, { open: 'O', close: 'C' });
    });

    it('03.03 - text by default; no colour when none is registered; an explicit level width wins', function() {
        var ctx = sw.buildLogContext(fakeLogger({ name: 'gina', _maxLevelLen: 9, levels: { crit: {} } }, {}), 'node');
        assert.equal(ctx.format, 'text');
        assert.equal(ctx.color, null);
        assert.equal(ctx.maxLevelLen, 9);
        assert.deepEqual(ctx.flows, ['default']);
    });
});

describe('04 - off', function() {

    it('04.01 - init() starts nothing without an enabled conf', function() {
        assert.equal(sw.init(), false);
        assert.equal(sw.init({}), false);
        assert.equal(sw.init({ conf: { enabled: false } }), false);
        assert.equal(sw.isEnabled(), false);
    });

    it('04.02 - enter() is a no-op while no thread runs: no mark, no listener', function() {
        var request  = { _ginaReqId: 'r1', method: 'GET' };
        var listened = 0;
        var response = { once: function() { listened++; } };
        sw.enter(request, response, '/a');
        assert.equal(request._swTracked, undefined);
        assert.equal(listened, 0);
    });

    it('04.03 - stop() settles while nothing runs', async function() {
        await sw.stop();
        assert.equal(sw.isEnabled(), false);
    });
});

describe('05 - the registry', function() {

    it('05.01 - lib/index.js registers it with a plain require (never _require)', function() {
        assert.match(INDEX_SRC, /\n\s*stallWatchdog\s*:\s*require\('\.\/stall-watchdog'\),/);
        assert.doesNotMatch(INDEX_SRC, /stallWatchdog\s*:\s*_require\(/);
    });

    it('05.02 - the package resolves to the main-thread module', function() {
        assert.equal(require(path.join(FW, 'lib/stall-watchdog')), sw);
    });
});

describe('06 - the parseTimeout replica is pinned to the real source', function() {

    it('06.01 - the replica\'s grammar lines are in utils/helper.js', function() {
        assert.ok(HELPER_SRC.indexOf("var _match = value.match(/^(\\d+(?:\\.\\d+)?)(ms|s|m|h)$/);") > -1);
        assert.ok(HELPER_SRC.indexOf("case 'ms': return Math.round(_n);") > -1);
        assert.ok(HELPER_SRC.indexOf("case 's':  return Math.round(_n * 1000);") > -1);
    });

    it('06.02 - behaviour on the shapes the resolver meets', function() {
        assert.equal(PARSE_TIMEOUT_REPLICA('5s'), 5000);
        assert.equal(PARSE_TIMEOUT_REPLICA('1500ms'), 1500);
        assert.equal(PARSE_TIMEOUT_REPLICA(2000), 2000);
        assert.equal(PARSE_TIMEOUT_REPLICA('5'), null);
        assert.equal(PARSE_TIMEOUT_REPLICA(''), null);
    });
});

describe('07 - the reading rules (detector.js), with synthetic time', function() {
    var createDetector = require(path.join(FW, 'lib/stall-watchdog/src/detector.js')).createDetector;

    /**
     * Step a detector through readings and collect what it returns.
     *
     * @param {Object} d
     * @param {Array<number[]>} readings - [now, value] pairs
     * @returns {Array<?Object>}
     */
    function steps(d, readings) {
        return readings.map(function(r) { return d.step(r[0], r[1]); });
    }

    it('07.01 - a heartbeat that keeps moving reports nothing', function() {
        var d = createDetector(1000);
        var out = steps(d, [[0, 1], [250, 2], [500, 3], [750, 4], [1000, 5], [1250, 6], [1500, 7]]);
        assert.deepEqual(out, [null, null, null, null, null, null, null]);
    });

    it('07.02 - a silence of the threshold reports ONE stall, at the first reading that reaches it', function() {
        var d = createDetector(1000);
        var out = steps(d, [[0, 1], [250, 2], [500, 2], [750, 2], [1000, 2], [1250, 2], [1500, 2], [2000, 2]]);
        assert.deepEqual(out, [null, null, null, null, null, { t: 'stall', ms: 1000 }, null, null]);
    });

    it('07.03 - the move that ends a reported stall gives the whole silence; a later stall is a new one', function() {
        var d = createDetector(1000);
        var out = steps(d, [[0, 1], [250, 2], [500, 2], [750, 2], [1000, 2], [1250, 2], [1500, 2], [3250, 3], [3500, 4], [3750, 4], [4000, 4], [4250, 4], [4500, 4]]);
        assert.deepEqual(out[5], { t: 'stall', ms: 1000 });
        assert.deepEqual(out[7], { t: 'resumed', ms: 3000 });
        assert.deepEqual(out[12], { t: 'stall', ms: 1000 });
    });

    it('07.04 - a move after a silence SHORTER than the threshold is no resume', function() {
        var d = createDetector(1000);
        assert.deepEqual(steps(d, [[0, 1], [250, 1], [500, 1], [750, 1], [900, 2]]), [null, null, null, null, null]);
    });

    it('07.05 - a reader that did not run for a threshold (a suspended process) is no stall: the count starts again', function() {
        var d = createDetector(1000);
        // readings every 250 ms, then none for 3 s (SIGSTOP … SIGCONT), and the heartbeat has not moved yet
        var out = steps(d, [[0, 1], [250, 2], [500, 3], [3500, 3], [3750, 3], [4000, 3], [4250, 3], [4500, 3]]);
        assert.deepEqual(out.slice(0, 7), [null, null, null, null, null, null, null], 'no report from the suspension');
        assert.deepEqual(out[7], { t: 'stall', ms: 1000 }, 'a silence measured from the resume is still a stall (the control)');
    });

    it('07.06 - a late reading under the threshold keeps counting (only a whole threshold restarts it)', function() {
        var d = createDetector(1000);
        var out = steps(d, [[0, 1], [250, 2], [850, 2], [1250, 2]]);
        assert.deepEqual(out, [null, null, null, { t: 'stall', ms: 1000 }]);
    });

    it('07.07 - a gap DURING a reported stall does not hide it: the resume carries the whole silence', function() {
        var d = createDetector(1000);
        // readings every 250 ms until the stall is reported, then none for 5 s, then the move
        var out = steps(d, [[0, 1], [250, 2], [500, 2], [750, 2], [1000, 2], [1250, 2], [6250, 2], [6500, 3]]);
        assert.deepEqual(out[5], { t: 'stall', ms: 1000 });
        assert.equal(out[6], null);
        assert.deepEqual(out[7], { t: 'resumed', ms: 6250 });
    });
});

/**
 * Render a test value for an assertion message.
 *
 * @param {*} v
 * @returns {string}
 */
function show(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
}
