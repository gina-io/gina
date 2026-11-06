'use strict';
/**
 * lib/stall-watchdog — the watchdog thread, driven in child processes that play a
 * bundle's main thread with the REAL logger (test/fixtures/stall-watchdog/child.js):
 * a few requests in flight, then a synchronous block. The child's stdout lines and
 * every frame reaching an MQ collector are stamped at ARRIVAL, against the child's
 * own @@BLOCK-START / @@BLOCK-END markers (one host clock).
 *
 *   §01 text mode — the crit line reaches stdout AND the MQ listener while the main
 *       thread is still blocked; its prefix is the logger's own crit prefix (date
 *       stripped); it names the silence and the open requests oldest first (not a
 *       finished one); a client path's backtick comes out as %60; one physical line;
 *       none of the tokens `gina tail` acts on; the warn line and the metric follow
 *       the block.
 *   §02 JSON mode — one JSON object: the default container's keys plus `stall`.
 *   §03 redaction — the rules the thread starts with AND the rules set after it
 *       started (the logger#redaction event) mask the line on both sinks.
 *   §04 the ring — capped at 256, the oldest dropped; `inFlight` shown, total given.
 *   §05 suspension — a stopped process (SIGSTOP … SIGCONT) is not a stall; a real
 *       block in the same process still is (the control). ⚠️ This arm cannot prove
 *       the suspension rule on its own: after SIGCONT the OS picks which thread runs
 *       first, and when the main thread beats first no stall is seen even without the
 *       rule (measured: the arm stayed green with the rule removed). The rule's
 *       deterministic proof is test/lib/stall-watchdog.test.js §07.05 (synthetic
 *       time); this arm checks the real process end to end.
 *   §06 a thread that fails — the main thread logs one warn line, turns the
 *       watchdog off, and keeps running (no uncaughtException).
 *   §07 off — no conf, no line (the control for §01).
 *   §08 the MQ endpoint twin — resolveMqEndpoint() names the endpoint the logger's
 *       own MQ speaker dials, under a settings file whose bind_host is foreign.
 *
 * The MQ collector listens on an ephemeral loopback port written into an isolated
 * GINA_HOMEDIR, so no frame reaches a framework daemon on this host.
 *
 * Run: node --test test/lib/stall-watchdog-worker.test.js
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var os     = require('os');
var net    = require('net');
var path   = require('path');
var { spawn } = require('child_process');

var FW      = require('../fw');
var REPO    = path.resolve(__dirname, '..', '..');
var CHILD   = path.join(__dirname, '..', 'fixtures', 'stall-watchdog', 'child.js');
var THROWER = path.join(__dirname, '..', 'fixtures', 'stall-watchdog', 'throwing-worker.js');

var SECRET = 'correct-horse-battery-staple';

// A resolveConfig() result: the smallest threshold, so a block of a few seconds
// leaves a wide margin between the report and the block's end.
var CONF = { enabled: true, warning: null, thresholdMs: 1000, captureFrames: true, frames: 8, inFlight: 8 };

/**
 * Strip ANSI colour codes.
 *
 * @param {string} s
 * @returns {string}
 */
function plain(s) {
    return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Run the fixture child once.
 *
 * @param {Object} spec - The child's spec (see the fixture); `fw` is added
 * @param {Object} [opts]
 * @param {string} [opts.format] - `json` sets GINA_LOG_FORMAT=json
 * @param {function} [opts.onReady] - Called with the child at @@READY
 * @returns {Promise<{code: number, signal: ?string, lines: Array<{at: number, text: string}>, frames: Array<{at: number, conn: number, text: string}>, at: function}>}
 */
function runChild(spec, opts) {
    opts = opts || {};
    return new Promise(function(resolve, reject) {
        var lines = [], frames = [], conns = 0;
        var collector = net.createServer(function(conn) {
            var id = ++conns, buf = '';
            conn.on('data', function(d) {
                var now = Date.now();
                buf += d.toString();
                var parts = buf.split('\r\n');
                buf = parts.pop();
                parts.forEach(function(text) { frames.push({ at: now, conn: id, text: text }); });
            });
            conn.on('error', function() { /* the child's exit resets it */ });
        });
        collector.listen({ host: '127.0.0.1', port: 0 }, function() {
            var version = require(path.join(REPO, 'package.json')).version;
            var short   = version.split('.').slice(0, 2).join('.');
            var home    = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-stall-watchdog-'));
            fs.mkdirSync(path.join(home, short));
            // A FOREIGN bind_host (TEST-NET-2): both the speaker and the twin must stay on loopback.
            fs.writeFileSync(path.join(home, short, 'settings.json'), JSON.stringify({ mq_port: collector.address().port, bind_host: '198.51.100.9' }));

            var env = Object.assign({}, process.env, { GINA_HOMEDIR: home, LOG_LEVEL: 'info' });
            delete env.GINA_BIND_HOST;
            delete env.GINA_LOG_STDOUT;
            delete env.GINA_LOG_FORMAT;
            if ( opts.format === 'json' ) { env.GINA_LOG_FORMAT = 'json'; }

            var child = spawn(process.execPath, [CHILD, JSON.stringify(Object.assign({ fw: FW }, spec))], { env: env });
            var killer = setTimeout(function() { child.kill('SIGKILL'); }, 30000);
            var out = '';
            child.stdout.on('data', function(d) {
                var now = Date.now();
                out += d.toString();
                var parts = out.split('\n');
                out = parts.pop();
                parts.forEach(function(text) {
                    lines.push({ at: now, text: text });
                    if ( /^@@READY/.test(text) && opts.onReady ) { opts.onReady(child); }
                });
            });
            child.stderr.on('data', function(d) { lines.push({ at: Date.now(), text: '@@STDERR ' + d.toString() }); });
            child.on('error', reject);
            child.on('exit', function(code, signal) {
                clearTimeout(killer);
                setTimeout(function() {
                    collector.close();
                    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* best effort */ }
                    resolve({
                        code   : code,
                        signal : signal,
                        lines  : lines,
                        frames : frames,
                        at     : function(marker) {
                            var l = lines.filter(function(x) { return x.text === '@@' + marker; })[0];
                            return l ? l.at : null;
                        }
                    });
                }, 200);
            });
        });
    });
}

/**
 * The stdout lines holding the watchdog's report.
 *
 * @param {Object} run
 * @returns {Array<{at: number, text: string}>}
 */
function stallLines(run) {
    return run.lines.filter(function(l) { return l.text.indexOf('[ STALL ] main thread blocked') > -1; });
}

/**
 * The MQ frames holding the watchdog's report.
 *
 * @param {Object} run
 * @returns {Array<{at: number, conn: number, text: string}>}
 */
function stallFrames(run) {
    return run.frames.filter(function(f) { return f.text.indexOf('[ STALL ] main thread blocked') > -1; });
}

describe('01 - text mode: the line reaches both sinks while the main thread is blocked', function() {
    var run;
    before(async function() {
        run = await runChild({
            conf    : CONF,
            enters  : [
                { id: 'req-oldest', m: 'PUT', p: '/orders/42' },
                { id: 'req-done',   m: 'GET', p: '/done', finish: true },
                { id: 'req-tick',   m: 'GET', p: '/x/`a@b` SIGTERM' }
            ],
            blockMs : 3000
        });
    });

    it('01.01 - the child ran the block and exited on its own (harness control)', function() {
        assert.equal(run.signal, null);
        assert.equal(run.code, 0);
        assert.ok(run.lines.some(function(l) { return l.text === '@@READY true'; }), 'the thread started');
        assert.ok(run.at('BLOCK-START') && run.at('BLOCK-END'), 'both block markers arrived');
    });

    it('01.02 - exactly one crit line on stdout, arriving after the threshold and BEFORE the block ends', function() {
        var found = stallLines(run);
        assert.equal(found.length, 1, 'one line per stall: ' + JSON.stringify(found));
        assert.ok(found[0].at < run.at('BLOCK-END'), 'the line arrived while the main thread was still blocked (' + (found[0].at - run.at('BLOCK-START')) + ' ms into a 3000 ms block)');
        assert.ok(found[0].at - run.at('BLOCK-START') >= 500, 'not before the threshold could pass');
    });

    it('01.03 - the same report reaches the MQ listener, on its own connection, while blocked', function() {
        var found = stallFrames(run);
        assert.equal(found.length, 1);
        assert.ok(found[0].at < run.at('BLOCK-END'), 'the frame arrived while the main thread was still blocked');
        var frame = JSON.parse(found[0].text);
        assert.equal(frame.level, 'crit');
        assert.equal(frame.group, 'demo@proj');
        assert.equal(typeof(frame.content), 'string');
        var probe = run.frames.filter(function(f) { return f.text.indexOf('PARITY-PROBE') > -1; })[0];
        assert.ok(probe, 'the logger\'s own frame reached the collector (the speaker dials the same listener)');
        assert.notEqual(found[0].conn, probe.conn, 'the thread dials its own connection');
        var handshake = run.frames.filter(function(f) { return f.conn === found[0].conn; })[0];
        assert.equal(JSON.parse(handshake.text).request, 'report', 'its first frame is the speaker\'s report handshake');
    });

    it('01.04 - the line carries the logger\'s crit prefix and colour (the date stripped)', function() {
        var probe = run.lines.filter(function(l) { return l.text.indexOf('PARITY-PROBE') > -1; })[0];
        assert.ok(probe, 'the logger\'s own crit line (harness control)');
        var dateless = function(s) { return s.replace(/\[\d{4} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2}\]/, '[DATE]'); };
        var expected = dateless(probe.text).split('PARITY-PROBE')[0];
        var line     = dateless(stallLines(run)[0].text);
        assert.equal(line.indexOf(expected), 0, 'prefix ' + JSON.stringify(expected) + ' vs ' + JSON.stringify(line.slice(0, 80)));
        assert.match(plain(line), /^\[DATE\] \[crit {3}\]\[demo@proj\] \[ STALL \] /);
        var close = probe.text.slice(probe.text.indexOf('PARITY-PROBE') + 'PARITY-PROBE '.length);
        assert.ok(line.endsWith(close), 'the same closing colour code');
    });

    it('01.05 - it names the silence and the open requests, oldest first, without the finished one', function() {
        var text = plain(stallLines(run)[0].text);
        assert.match(text, /\[ STALL \] main thread blocked: no heartbeat for \d+\.\ds — in flight 2: PUT \/orders\/42 \[ req req-oldest \] \d+\.\ds, GET \/x\/%60a@b%60 SIGTERM \[ req req-tick \] \d+\.\ds/);
        assert.equal(text.indexOf('req-done'), -1, 'a finished request left the ring');
    });

    it('01.06 - a client path\'s backtick comes out as %60: no backtick anywhere in the report', function() {
        assert.equal(stallLines(run)[0].text.indexOf('`'), -1);
        assert.equal(JSON.parse(stallFrames(run)[0].text).content.indexOf('`'), -1);
    });

    it('01.07 - the wording carries none of the tokens gina tail acts on', function() {
        // the client path above holds SIGTERM by construction; strip it, then check the line's own words
        var own = plain(stallLines(run)[0].text).replace('SIGTERM', '');
        assert.doesNotMatch(own, /SIGTERM|SIGINT|SIGKILL|SIGABRT|exiting|Got exit code|JavaScript heap out of memory/);
        var warn = run.lines.filter(function(l) { return l.text.indexOf('main thread resumed') > -1; })[0];
        assert.doesNotMatch(plain(warn.text), /SIGTERM|SIGINT|SIGKILL|SIGABRT|exiting|Got exit code|JavaScript heap out of memory|`/);
    });

    it('01.08 - after the block: one warn line with the whole silence, and the stall counted', function() {
        var warn = run.lines.filter(function(l) { return l.text.indexOf('main thread resumed') > -1; });
        assert.equal(warn.length, 1);
        assert.ok(warn[0].at >= run.at('BLOCK-END'), 'written once the main thread runs again');
        assert.match(plain(warn[0].text), /\[warn {3}\]\[demo@proj\] \[ STALL \] main thread resumed: no heartbeat for (\d+\.\d)s in all/);
        var secs = Number(plain(warn[0].text).match(/no heartbeat for (\d+\.\d)s/)[1]);
        assert.ok(secs >= 2.9 && secs <= 4.5, 'the whole silence, about the 3 s block: ' + secs);
        var metric = run.lines.filter(function(l) { return /^@@METRIC /.test(l.text); });
        assert.equal(metric.length, 1);
        assert.ok(Math.abs(Number(metric[0].text.split(' ')[1]) - secs) < 0.1, 'the metric observes the same seconds');
    });
});

describe('02 - JSON mode: one object, the default container\'s keys plus `stall`', function() {
    var run;
    before(async function() {
        run = await runChild({
            conf    : CONF,
            enters  : [
                { id: 'req-a', m: 'POST', p: '/upload' },
                { id: 'req-long', m: 'GET', p: '/' + 'x'.repeat(299) }
            ],
            blockMs : 2500
        }, { format: 'json' });
    });

    it('02.01 - the line parses, at crit, with the bundle\'s group and the summary as message', function() {
        var found = stallLines(run);
        assert.equal(found.length, 1);
        var obj = JSON.parse(found[0].text);
        assert.equal(obj.level, 'crit');
        assert.equal(obj.bundle, 'demo@proj');
        assert.equal(obj.group, 'demo@proj');
        assert.equal(obj.message, obj.msg);
        assert.match(obj.message, /^\[ STALL \] main thread blocked: no heartbeat for \d+\.\ds — in flight 2: POST \/upload \[ req req-a \] \d+\.\ds, GET \/x{255}… \[ req req-long \] \d+\.\ds$/);
        assert.ok(!isNaN(Date.parse(obj.ts)));
    });

    it('02.02 - `stall` holds the silence, the runtime, no frames and the in-flight requests', function() {
        var stall = JSON.parse(stallLines(run)[0].text).stall;
        assert.equal(typeof(stall.ms), 'number');
        assert.ok(stall.ms >= 1000);
        assert.equal(stall.runtime, ( process.versions.bun ) ? 'bun' : 'node');
        assert.equal(stall.captured, false);
        assert.deepEqual(stall.frames, []);
        assert.equal(stall.inFlight.length, 2);
        assert.deepEqual(Object.keys(stall.inFlight[0]), ['id', 'method', 'path', 'ms']);
        assert.equal(stall.inFlight[0].id, 'req-a');
        assert.equal(stall.inFlight[0].method, 'POST');
        assert.equal(stall.inFlight[0].path, '/upload');
    });

    it('02.03b - a path longer than 256 characters is cut there and ends with …', function() {
        var long = JSON.parse(stallLines(run)[0].text).stall.inFlight[1];
        assert.equal(long.id, 'req-long');
        assert.equal(long.path, '/' + 'x'.repeat(255) + '…');
    });

    it('02.03 - the logger\'s own lines are JSON in this mode too (harness control)', function() {
        var probe = run.lines.filter(function(l) { return l.text.indexOf('PARITY-PROBE') > -1; })[0];
        assert.equal(JSON.parse(probe.text).level, 'crit');
    });
});

describe('03 - redaction: the rules at start and the rules set later both mask the line', function() {
    var run;
    before(async function() {
        run = await runChild({
            conf         : CONF,
            redactBefore : { block: { patterns: ['tok_[a-z0-9]{8}'] }, secret: SECRET },
            redactAfter  : { block: { patterns: ['late_[a-z0-9]{6}'] } },
            enters       : [
                { id: 'r1', m: 'GET', p: '/a/tok_abcd1234/b' },
                { id: 'r2', m: 'GET', p: '/s/' + SECRET },
                { id: 'r3', m: 'GET', p: '/l/late_abc123' }
            ],
            blockMs      : 2500
        });
    });

    it('03.01 - neither the start rules\' values nor the later rule\'s value reach stdout', function() {
        var line = stallLines(run)[0].text;
        assert.equal(line.indexOf('tok_abcd1234'), -1, 'the start pattern masks');
        assert.equal(line.indexOf(SECRET), -1, 'the resolved secret masks');
        assert.equal(line.indexOf('late_abc123'), -1, 'the rule set after the thread started masks (the event)');
        assert.ok(line.indexOf('[REDACTED]') > -1, 'masked, not dropped');
        assert.ok(line.indexOf('[ req r3 ]') > -1, 'the requests are still named (a control that can fail)');
    });

    it('03.02 - nor the MQ frame', function() {
        var content = JSON.parse(stallFrames(run)[0].text).content;
        assert.equal(content.indexOf('tok_abcd1234'), -1);
        assert.equal(content.indexOf(SECRET), -1);
        assert.equal(content.indexOf('late_abc123'), -1);
        assert.ok(content.indexOf('[REDACTED]') > -1);
    });
});

describe('04 - the ring: capped at 256, the oldest dropped; `inFlight` shown, the total given', function() {
    var run;
    before(async function() {
        run = await runChild({
            conf    : Object.assign({}, CONF, { inFlight: 3 }),
            enters  : [{ id: 'req-first', m: 'GET', p: '/first' }],
            many    : { count: 300, m: 'GET', p: '/many/' },
            blockMs : 2500
        });
    });

    it('04.01 - 301 open requests: the 256 newest kept, the 3 oldest of them shown', function() {
        // 301 entries into 256 slots: req-first and many-0 … many-43 are dropped, many-44 is the oldest kept
        var text = plain(stallLines(run)[0].text);
        assert.match(text, /— in flight 256 \(oldest 3\): GET \/many\/44 \[ req many-44 \] \d+\.\ds, GET \/many\/45 \[ req many-45 \] \d+\.\ds, GET \/many\/46 \[ req many-46 \] \d+\.\ds/);
        assert.equal(text.indexOf('req-first'), -1, 'the oldest entries were dropped');
        assert.equal(text.indexOf('many-43 '), -1);
    });
});

describe('05 - a suspended process is not a stall', { skip: ( process.platform === 'win32' ) ? 'no SIGSTOP on Windows' : false }, function() {
    var run;
    before(async function() {
        run = await runChild({
            conf    : CONF,
            enters  : [{ id: 'req-s', m: 'GET', p: '/s' }],
            idleMs  : 4000,
            blockMs : 2500
        }, {
            onReady: function(child) {
                setTimeout(function() {
                    child.kill('SIGSTOP');
                    setTimeout(function() { child.kill('SIGCONT'); }, 2500);
                }, 400);
            }
        });
    });

    it('05.01 - no report before the block, though the process stood still for 2.5 s', function() {
        var start = run.at('BLOCK-START');
        assert.ok(start, 'the block ran (harness control)');
        var early = stallLines(run).filter(function(l) { return l.at < start; });
        assert.deepEqual(early, []);
    });

    it('05.02 - the real block that follows is reported (the control)', function() {
        var late = stallLines(run).filter(function(l) { return l.at >= run.at('BLOCK-START'); });
        assert.equal(late.length, 1);
    });
});

describe('06 - a thread that fails turns the watchdog off; the main thread keeps running', function() {
    var run;
    before(async function() {
        run = await runChild({ conf: CONF, workerPath: THROWER, blockMs: 0, holdMs: 600 });
    });

    it('06.01 - one warn line, the watchdog off, a clean exit', function() {
        assert.equal(run.signal, null);
        assert.equal(run.code, 0, 'no uncaughtException took the process down');
        var warn = run.lines.filter(function(l) { return l.text.indexOf('the watchdog thread failed and stays off until the bundle restarts') > -1; });
        assert.equal(warn.length, 1, JSON.stringify(run.lines.map(function(l) { return l.text; })));
        assert.ok(warn[0].text.indexOf('watchdog fixture failure') > -1, 'the fault is named');
        assert.ok(run.lines.some(function(l) { return l.text === '@@ALIVE false'; }));
    });
});

describe('07 - off: no conf, no line (the control for §01)', function() {
    var run;
    before(async function() {
        run = await runChild({ conf: { enabled: false }, enters: [{ id: 'req-off', m: 'GET', p: '/off' }], blockMs: 2500 });
    });

    it('07.01 - the block ran, and nothing reported it', function() {
        assert.ok(run.lines.some(function(l) { return l.text === '@@READY false'; }));
        assert.ok(run.at('BLOCK-END'));
        assert.deepEqual(stallLines(run), []);
        assert.deepEqual(stallFrames(run), []);
    });
});

describe('08 - resolveMqEndpoint() names the endpoint the logger\'s own speaker dials', function() {
    var run;
    before(async function() {
        run = await runChild({ conf: { enabled: false }, endpoint: true, blockMs: 0, holdMs: 400 });
    });

    it('08.01 - the speaker\'s handshake and the twin agree, on loopback, at the settings port', function() {
        var line = run.lines.filter(function(l) { return /^@@ENDPOINT /.test(l.text); })[0];
        assert.ok(line, 'the twin answered');
        var twin = JSON.parse(line.text.slice('@@ENDPOINT '.length));
        var handshakes = run.frames.filter(function(f) { return f.text.indexOf('"request":"report"') > -1; });
        assert.equal(handshakes.length, 1, 'the speaker reached the collector, and only the speaker (the watchdog is off)');
        var speaker = JSON.parse(handshakes[0].text);
        assert.deepEqual({ host: speaker.host, port: speaker.port }, twin);
        assert.equal(twin.host, '127.0.0.1', 'the foreign bind_host is not dialled');
    });
});
