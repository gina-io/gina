'use strict';
/**
 * lib/stall-watchdog — the blocked thread's call frames (`captureFrames`, Node only).
 * The watchdog thread connects to the main thread's inspector, pauses it for about a
 * millisecond, reads its frames, resumes it and disconnects, every step against a
 * deadline. Child processes play a bundle's main thread with the REAL logger and thread
 * (test/fixtures/stall-watchdog/frames-child.js); their stdout lines are stamped at
 * ARRIVAL, against the child's own markers (one host clock).
 *
 *   §01 frames.js (pure): a frame's file from the scriptParsed map, relative to the
 *       longest root it lies under, 1-based; `(anonymous)`, `(unknown)`, node's own urls;
 *       the `frames` limit and the trailing `…`; the reasons' wording; errorReason().
 *   §02 resolveRoots(): real paths, duplicates dropped, longest first; by default the
 *       framework directory and getPath('project') when it is registered.
 *   §03 a JavaScript block: the line names the frames, innermost first, while the main
 *       thread is still blocked, and the pause does not hold it; JSON `captured: true`
 *       with the frames as objects; `frames: 2` keeps two and adds `…`. Control: with
 *       `captureFrames` off the line names no frames.
 *   §04 a native call (a child process run synchronously): no inspector answer, so
 *       `frames: none (native-call-or-outside-js)` after the step deadline, while blocked;
 *       the main thread is not paused afterwards.
 *   §05 a block that ends as the capture starts: `frames: none (ended)` (the frames read
 *       would be the idle loop's), and the warn line still comes after the crit line.
 *   §06 another inspector session already holds the main thread paused (a debugger):
 *       `frames: none (debugger)`, and that pause lasts its whole hold.
 *   §07 a thread that pauses the main thread and goes away while holding the pause
 *       (disconnect, an uncaught error thrown from a timer, exit): the main thread runs
 *       again each time. Control: a thread that keeps the pause leaves the main thread
 *       stopped (the instrument fires). And the watchdog's own guard: an error inside its
 *       handling of the pause is caught (thrown out of the inspector's callback, it would
 *       leave the main thread paused for good — measured), the main thread runs again,
 *       and the line says `frames: none (error:Error)`.
 *   §08 Bun: `frames: none (bun)`, while blocked (Bun only: §03–§07 are Node only).
 *
 * The MQ flow dials a collector on an ephemeral loopback port written into an isolated
 * GINA_HOMEDIR, so no frame reaches a framework daemon on this host.
 *
 * Run: node --test test/lib/stall-watchdog-frames.test.js
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var os     = require('os');
var net    = require('net');
var path   = require('path');
var { spawn } = require('child_process');

var FW       = require('../fw');
var REPO     = path.resolve(__dirname, '..', '..');
var FIXTURES = path.join(__dirname, '..', 'fixtures', 'stall-watchdog');
var CHILD    = path.join(FIXTURES, 'frames-child.js');
var BLOCKER  = path.join(FIXTURES, 'deep', 'blocker.js');

var framesLib = require(path.join(FW, 'lib', 'stall-watchdog', 'src', 'frames.js'));
var sw        = require(path.join(FW, 'lib', 'stall-watchdog'));

var IS_BUN    = ( typeof(Bun) !== 'undefined' );
var NODE_ONLY = IS_BUN && 'the frame capture is Node only: Bun\'s inspector needs inspector.open(), which the watchdog never calls';
var BUN_ONLY  = !IS_BUN && 'Bun only: on Node the frames are read (§03)';
// Whole blocks are skipped on the other runtime: Bun 1.2 runs an `it` whose `{ skip }`
// option is set (measured), and a skipped block's hooks never start a child.
var describeNode = ( NODE_ONLY ) ? describe.skip : describe;
var describeBun  = ( BUN_ONLY ) ? describe.skip : describe;

// A resolveConfig() result: the smallest threshold, so a block of a few seconds leaves
// room for the capture and the line before the block ends.
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
 * Escape a string for a RegExp.
 *
 * @param {string} s
 * @returns {string}
 */
function re(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where the fixture's frames must point: 1-based lines and columns read from the file.
 *
 * @returns {{loop: number[], merge: string, parse: string}} `loop`: the busy loop's two
 *   lines (the pause lands on either); `merge`/`parse`: `line:col` of the calls
 *   `mergeBody` and `parseBody` make
 */
function blockerPositions() {
    var src = fs.readFileSync(BLOCKER, 'utf8').split('\n');
    var find = function(needle) {
        var hits = [];
        src.forEach(function(l, i) { if ( l.indexOf(needle) > -1 ) { hits.push(i); } });
        if ( hits.length !== 1 ) { throw new Error('fixture anchor « ' + needle + ' » found ' + hits.length + ' times'); }
        return hits[0];
    };
    var w = find('while ( Date.now() < deadline )');
    var f = find('if ( flag && Atomics.load(flag, 0) === 1 )');
    var m = find('return spinUntil(Date.now() + ms, flag);');
    var p = find('return mergeBody(ms, flag);');
    return {
        loop  : [w + 1, f + 1],
        merge : ( m + 1 ) + ':' + ( src[m].indexOf('spinUntil(') + 1 ),
        parse : ( p + 1 ) + ':' + ( src[p].indexOf('mergeBody(') + 1 )
    };
}

/**
 * Run the fixture child once.
 *
 * @param {Object} spec - The child's spec (see the fixture); `fw` is added
 * @param {Object} [opts]
 * @param {string} [opts.format] - `json` sets GINA_LOG_FORMAT=json
 * @param {number} [opts.killAfterMs=30000] - SIGKILL the child after this long
 * @returns {Promise<{code: ?number, signal: ?string, lines: Array<{at: number, text: string}>, at: function(string): ?number}>}
 */
function runChild(spec, opts) {
    opts = opts || {};
    return new Promise(function(resolve, reject) {
        var lines = [];
        var collector = net.createServer(function(conn) {
            conn.on('data', function() { /* the logger's own frames: not read here */ });
            conn.on('error', function() { /* the child's exit resets it */ });
        });
        collector.listen({ host: '127.0.0.1', port: 0 }, function() {
            var version = require(path.join(REPO, 'package.json')).version;
            var short   = version.split('.').slice(0, 2).join('.');
            var home    = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-stall-frames-'));
            fs.mkdirSync(path.join(home, short));
            fs.writeFileSync(path.join(home, short, 'settings.json'), JSON.stringify({ mq_port: collector.address().port }));

            var env = Object.assign({}, process.env, { GINA_HOMEDIR: home, LOG_LEVEL: 'info' });
            delete env.GINA_BIND_HOST;
            delete env.GINA_LOG_STDOUT;
            delete env.GINA_LOG_FORMAT;
            if ( opts.format === 'json' ) { env.GINA_LOG_FORMAT = 'json'; }

            var child  = spawn(process.execPath, [CHILD, JSON.stringify(Object.assign({ fw: FW }, spec))], { env: env });
            var killer = setTimeout(function() { child.kill('SIGKILL'); }, opts.killAfterMs || 30000);
            var out    = '';
            child.stdout.on('data', function(d) {
                var now = Date.now();
                out += d.toString();
                var parts = out.split('\n');
                out = parts.pop();
                parts.forEach(function(text) { lines.push({ at: now, text: text }); });
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
                        at     : function(marker) {
                            var l = lines.filter(function(x) { return x.text === '@@' + marker || x.text.indexOf('@@' + marker + ' ') === 0; })[0];
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
 * The marker's value (`@@LATE 3` → 3).
 *
 * @param {Object} run
 * @param {string} marker
 * @returns {?string}
 */
function markerValue(run, marker) {
    var l = run.lines.filter(function(x) { return x.text.indexOf('@@' + marker + ' ') === 0; })[0];
    return l ? l.text.slice(('@@' + marker + ' ').length) : null;
}

/**
 * The child's output, for an assertion message.
 *
 * @param {Object} run
 * @returns {string}
 */
function dump(run) {
    return run.lines.map(function(l) { return plain(l.text); }).join('\n').slice(-3000);
}

describe('01 - frames.js: the frames as the line names them', function() {
    var ROOT  = path.join(path.sep, 'srv', 'gina', 'framework', 'v1.0.0');
    var PROJ  = path.join(path.sep, 'srv', 'gina', 'framework', 'v1.0.0', 'tests', 'project');
    var url   = function(p) { return require('url').pathToFileURL(p).href; };

    it('01.01 - a frame\'s file comes from the scriptParsed map (its own url is empty), relative to the root; 1-based', function() {
        var r = framesLib.toFrames(
            [{ functionName: 'mergeBody', url: '', location: { scriptId: '42', lineNumber: 411, columnNumber: 8 } }],
            new Map([['42', url(path.join(ROOT, 'lib', 'merge', 'src', 'main.js'))]]), [ROOT], 8);
        assert.deepEqual(r, { frames: [{ fn: 'mergeBody', file: 'lib/merge/src/main.js', line: 412, col: 9 }], more: false });
    });

    it('01.02 - the longest root wins; a file under no root, node\'s own url and none at all are written as given', function() {
        var map = new Map([
            ['1', url(path.join(PROJ, 'src', 'api', 'controllers', 'controller.js'))],
            ['2', url(path.join(ROOT, 'core', 'router.js'))],
            ['3', url(path.join(path.sep, 'opt', 'other place', 'x.js'))],
            ['4', 'node:internal/timers'],
            ['5', '']
        ]);
        var cfs = ['1', '2', '3', '4', '5'].map(function(id) { return { functionName: 'f' + id, url: '', location: { scriptId: id, lineNumber: 0, columnNumber: 0 } }; });
        var files = framesLib.toFrames(cfs, map, [PROJ, ROOT], 8).frames.map(function(f) { return f.file; });
        assert.deepEqual(files, [
            'src/api/controllers/controller.js',
            'core/router.js',
            path.join(path.sep, 'opt', 'other place', 'x.js'),
            'node:internal/timers',
            '(unknown)'
        ]);
    });

    it('01.03 - no name reads (anonymous); a frame\'s own url is used when the map has none', function() {
        var r = framesLib.toFrames([{ functionName: '', url: url(path.join(ROOT, 'a.js')), location: { scriptId: '9', lineNumber: 2, columnNumber: 4 } }], new Map(), [ROOT], 8);
        assert.deepEqual(r.frames, [{ fn: '(anonymous)', file: 'a.js', line: 3, col: 5 }]);
    });

    it('01.04 - `max` keeps the innermost frames and flags the rest; the text joins them with <- and ends with …', function() {
        var cfs = [0, 1, 2].map(function(i) { return { functionName: 'f' + i, url: 'node:x', location: { scriptId: 's', lineNumber: i, columnNumber: 0 } }; });
        var r = framesLib.toFrames(cfs, new Map(), [], 2);
        assert.deepEqual(r.frames.map(function(f) { return f.fn; }), ['f0', 'f1']);
        assert.equal(r.more, true);
        assert.equal(framesLib.describeFrames(r.frames, r.more), 'f0 (node:x:1:1) <- f1 (node:x:2:1) <- …');
        assert.equal(framesLib.describeFrames(r.frames, false), 'f0 (node:x:1:1) <- f1 (node:x:2:1)');
        assert.equal(framesLib.toFrames(cfs, new Map(), [], 8).more, false);
    });

    it('01.05 - errorReason: the code, else the name; unsafe characters dropped', function() {
        assert.equal(framesLib.errorReason(Object.assign(new Error('x'), { code: 'ERR_INSPECTOR_NOT_CONNECTED' })), 'error:ERR_INSPECTOR_NOT_CONNECTED');
        assert.equal(framesLib.errorReason(new TypeError('x')), 'error:TypeError');
        assert.equal(framesLib.errorReason({ name: 'a b`c' }), 'error:abc');
        assert.equal(framesLib.errorReason(null), 'error:Error');
    });

    it('01.06 - the reasons\' wording (the documentation names them)', function() {
        assert.deepEqual(framesLib.REASONS, {
            outsideJs   : 'native-call-or-outside-js',
            bun         : 'bun',
            debugger    : 'debugger',
            ended       : 'ended',
            unavailable : 'unavailable'
        });
    });
});

describe('02 - resolveRoots(): the directories a frame\'s file is written relative to', function() {
    var tmp = null;
    var hadGetPath = ( typeof(global.getPath) !== 'undefined' );

    before(function() {
        tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gina-stall-roots-')));
        fs.mkdirSync(path.join(tmp, 'real', 'deeper'), { recursive: true });
        fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'));
    });
    after(function() {
        if ( !hadGetPath ) { delete global.getPath; }
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    });

    it('02.01 - real paths, duplicates dropped, longest first', function() {
        var roots = sw.resolveRoots([path.join(tmp, 'link'), path.join(tmp, 'real', 'deeper'), path.join(tmp, 'real'), '', 7]);
        assert.deepEqual(roots, [path.join(tmp, 'real', 'deeper'), path.join(tmp, 'real')]);
    });

    it('02.02 - by default: the framework directory, and the project when getPath() names one', function() {
        assert.equal(hadGetPath, false, 'no framework globals in this process (harness control)');
        assert.deepEqual(sw.resolveRoots(), [fs.realpathSync(FW)]);
        global.getPath = function(name) {
            if ( name !== 'project' ) { throw new Error('Path `' + name + '` not found'); }
            return path.join(tmp, 'link');
        };
        assert.deepEqual(sw.resolveRoots(), [fs.realpathSync(FW), path.join(tmp, 'real')].sort(function(a, b) { return b.length - a.length; }));
        global.getPath = function(name) { throw new Error('Path `' + name + '` not found'); };
        assert.deepEqual(sw.resolveRoots(), [fs.realpathSync(FW)]);
    });
});

describeNode('03 - a JavaScript block: the frames, while the main thread is still blocked', function() {
    var BLOCK_MS = 2500;
    var pos = null, text = null, json = null, off = null;
    var spec = function(conf) {
        return {
            conf    : conf,
            roots   : [FIXTURES],
            block   : 'js',
            blockMs : BLOCK_MS,
            enters  : [{ id: 'req-a', m: 'GET', p: '/x' }]
        };
    };
    before(async function() {
        if ( NODE_ONLY ) { return; }
        pos  = blockerPositions();
        text = await runChild(spec(CONF));
        json = await runChild(spec(Object.assign({}, CONF, { frames: 2 })), { format: 'json' });
        off  = await runChild(spec(Object.assign({}, CONF, { captureFrames: false })));
    });

    it('03.01 - one crit line before the block ends, naming the frames innermost first, then the request', function() {
        var found = stallLines(text);
        assert.equal(found.length, 1, dump(text));
        assert.ok(found[0].at < text.at('BLOCK-END'), 'written while the main thread is still blocked');
        var line = plain(found[0].text);
        var m = line.match(/— frames: spinUntil \(deep\/blocker\.js:(\d+):(\d+)\) <- mergeBody \(deep\/blocker\.js:(\d+:\d+)\) <- parseBody \(deep\/blocker\.js:(\d+:\d+)\) <- \(anonymous\) \(frames-child\.js:\d+:\d+\) <- /);
        assert.ok(m, 'the frames, relative to the root: ' + line);
        assert.ok(pos.loop.indexOf(Number(m[1])) > -1, 'spinUntil is paused inside its loop (line ' + m[1] + ', expected one of ' + pos.loop + ')');
        assert.equal(m[3], pos.merge, 'mergeBody\'s frame points at its call of spinUntil');
        assert.equal(m[4], pos.parse, 'parseBody\'s frame points at its call of mergeBody');
        assert.match(line, /^\[[^\]]+\] \[crit {3}\]\[demo@proj\] \[ STALL \] main thread blocked: no heartbeat for \d+\.\ds — frames: .+ — in flight 1: GET \/x \[ req req-a \] \d+\.\ds\s*$/);
    });

    it('03.02 - the pause does not hold the main thread: the block ends on time, the next timer too', function() {
        var took = text.at('BLOCK-END') - text.at('BLOCK-START');
        assert.ok(took < BLOCK_MS + 300, 'the block took ' + took + ' ms');
        assert.ok(Number(markerValue(text, 'LATE')) < 100, 'the first timer after the block was ' + markerValue(text, 'LATE') + ' ms late');
        assert.equal(markerValue(text, 'ALIVE'), 'true');
    });

    it('03.03 - JSON: `captured: true`, the frames as objects; `frames: 2` keeps two and adds …', function() {
        var found = stallLines(json);
        assert.equal(found.length, 1, dump(json));
        var obj = JSON.parse(found[0].text);
        assert.equal(obj.stall.captured, true);
        assert.equal(obj.stall.frames.length, 2);
        assert.deepEqual(Object.keys(obj.stall.frames[0]), ['fn', 'file', 'line', 'col']);
        assert.equal(obj.stall.frames[0].fn, 'spinUntil');
        assert.equal(obj.stall.frames[0].file, 'deep/blocker.js');
        assert.deepEqual(obj.stall.frames[1], { fn: 'mergeBody', file: 'deep/blocker.js', line: Number(pos.merge.split(':')[0]), col: Number(pos.merge.split(':')[1]) });
        assert.match(obj.message, new RegExp('— frames: spinUntil \\(deep/blocker\\.js:\\d+:\\d+\\) <- mergeBody \\(deep/blocker\\.js:' + re(pos.merge) + '\\) <- … — in flight 1: GET /x '));
    });

    it('03.04 - control: with captureFrames off, the line names no frames', function() {
        var found = stallLines(off);
        assert.equal(found.length, 1, dump(off));
        var line = plain(found[0].text);
        assert.equal(line.indexOf('frames:'), -1, line);
        assert.match(line, /\[ STALL \] main thread blocked: no heartbeat for \d+\.\ds — in flight 1: GET \/x \[ req req-a \] \d+\.\ds\s*$/);
    });
});

describeNode('04 - a native call: no answer, no frames, and no pause left behind', function() {
    var BLOCK_MS = 4000;
    var run = null;
    before(async function() {
        if ( NODE_ONLY ) { return; }
        run = await runChild({ conf: CONF, roots: [FIXTURES], block: 'native', blockMs: BLOCK_MS, enters: [{ id: 'req-n', m: 'POST', p: '/n' }] });
    });

    it('04.01 - `frames: none (native-call-or-outside-js)`, written while the call still runs', function() {
        var found = stallLines(run);
        assert.equal(found.length, 1, dump(run));
        assert.ok(found[0].at < run.at('BLOCK-END'), 'written while the main thread is still blocked');
        assert.match(plain(found[0].text), /— frames: none \(native-call-or-outside-js\) — in flight 1: POST \/n \[ req req-n \] /);
    });

    it('04.02 - the main thread is not paused once the call returns', function() {
        var took = run.at('BLOCK-END') - run.at('BLOCK-START');
        assert.ok(took >= BLOCK_MS - 100 && took < BLOCK_MS + 500, 'the call took ' + took + ' ms');
        assert.ok(Number(markerValue(run, 'LATE')) < 100, 'the first timer after the call was ' + markerValue(run, 'LATE') + ' ms late');
    });
});

describeNode('05 - a block that ends as the capture starts: no frames, and the lines in order', function() {
    var run = null;
    before(async function() {
        if ( NODE_ONLY ) { return; }
        run = await runChild({
            conf       : CONF,
            roots      : [FIXTURES],
            workerPath : path.join(FIXTURES, 'wrap-worker.js'),
            test       : { signal: true, delayDisableMs: 600 },
            block      : 'js',
            blockMs    : 6000,
            enters     : [{ id: 'req-e', m: 'GET', p: '/e' }],
            // the capture outlives the block: the pause lands on the next JavaScript (up
            // to a heartbeat, 250 ms, later), then the disable is held 600 ms
            afterMs    : 2500
        });
    });

    it('05.01 - `frames: none (ended)`: the frames read would be the idle loop\'s', function() {
        var found = stallLines(run);
        assert.equal(found.length, 1, dump(run));
        assert.ok(run.at('BLOCK-END') !== null && run.at('BLOCK-END') <= found[0].at, 'the block ended as the capture started (harness control)');
        assert.match(plain(found[0].text), /— frames: none \(ended\) — in flight 1: GET \/e \[ req req-e \] /);
    });

    it('05.02 - the warn line comes after the crit line it ends', function() {
        var crit = -1, warn = -1;
        run.lines.forEach(function(l, i) {
            if ( crit < 0 && l.text.indexOf('[ STALL ] main thread blocked') > -1 ) { crit = i; }
            if ( warn < 0 && l.text.indexOf('[ STALL ] main thread resumed') > -1 ) { warn = i; }
        });
        assert.ok(crit > -1 && warn > -1, dump(run));
        assert.ok(crit < warn, 'crit line ' + crit + ', warn line ' + warn);
    });
});

describeNode('06 - a debugger already holds the main thread: its pause is left alone', function() {
    var HOLD_MS = 3000;
    var run = null;
    before(async function() {
        if ( NODE_ONLY ) { return; }
        run = await runChild({ conf: CONF, roots: [FIXTURES], block: 'held', holdMs: HOLD_MS, enters: [{ id: 'req-d', m: 'GET', p: '/d' }] });
    });

    it('06.01 - `frames: none (debugger)`, written during the hold', function() {
        var found = stallLines(run);
        assert.equal(found.length, 1, dump(run));
        assert.ok(run.at('HOLD-START') !== null && run.at('HOLD-START') < found[0].at && found[0].at < run.at('HOLD-END'), dump(run));
        assert.match(plain(found[0].text), /— frames: none \(debugger\) — in flight 1: GET \/d \[ req req-d \] /);
    });

    it('06.02 - the hold lasted its whole time: nobody else resumed the main thread', function() {
        assert.equal(run.at('HOLD-EARLY'), null, dump(run));
        var held = run.at('HOLD-END') - run.at('HOLD-START');
        assert.ok(held >= HOLD_MS - 100, 'held ' + held + ' ms');
    });
});

describeNode('07 - a thread that goes away while the main thread is paused: the main thread runs again', function() {
    var BLOCK_MS = 2500;
    var runs = {};
    var spec = function(fault) {
        return {
            conf       : CONF,
            workerPath : path.join(FIXTURES, 'pausing-worker.js'),
            test       : { fault: fault },
            block      : 'js',
            blockMs    : BLOCK_MS
        };
    };
    before(async function() {
        if ( NODE_ONLY ) { return; }
        runs.disconnect = await runChild(spec('disconnect'));
        runs.throw      = await runChild(spec('throw'));
        runs.exit       = await runChild(spec('exit'));
        runs.hold       = await runChild(spec('hold'), { killAfterMs: 5000 });
        runs.guard      = await runChild({
            conf       : CONF,
            roots      : [FIXTURES],
            workerPath : path.join(FIXTURES, 'wrap-worker.js'),
            test       : { throwInFrames: true },
            block      : 'js',
            blockMs    : BLOCK_MS,
            enters     : [{ id: 'req-g', m: 'GET', p: '/g' }]
        }, { killAfterMs: 12000 });
    });

    var ranAgain = function(run, fault) {
        assert.ok(run.at('TEST-PAUSED') !== null, 'the test thread paused the main thread (' + fault + '): ' + dump(run));
        assert.ok(run.at('TEST-PAUSED') < run.at('BLOCK-END'), 'inside the block');
        var took = run.at('BLOCK-END') - run.at('BLOCK-START');
        assert.ok(took < BLOCK_MS + 600, 'the block took ' + took + ' ms');
    };
    var warned = function(run, needle) {
        return run.lines.filter(function(l) { return plain(l.text).indexOf(needle) > -1; }).length;
    };

    it('07.01 - the session disconnects: the main thread runs again, the thread lives on', function() {
        ranAgain(runs.disconnect, 'disconnect');
        assert.equal(markerValue(runs.disconnect, 'ALIVE'), 'true');
    });

    it('07.02 - the thread throws: the main thread runs again, the watchdog turns off with one warn line', function() {
        ranAgain(runs.throw, 'throw');
        assert.equal(warned(runs.throw, '[stallWatchdog] the watchdog thread failed'), 1, dump(runs.throw));
        assert.equal(markerValue(runs.throw, 'ALIVE'), 'false');
    });

    it('07.03 - the thread exits: the main thread runs again, the watchdog turns off with one warn line', function() {
        ranAgain(runs.exit, 'exit');
        assert.equal(warned(runs.exit, '[stallWatchdog] the watchdog thread ended (code 0)'), 1, dump(runs.exit));
        assert.equal(markerValue(runs.exit, 'ALIVE'), 'false');
    });

    it('07.04 - control: a thread that keeps the pause leaves the main thread stopped (the instrument fires)', function() {
        assert.ok(runs.hold.at('TEST-PAUSED') !== null, dump(runs.hold));
        assert.equal(runs.hold.at('BLOCK-END'), null, 'the block never ended: the main thread stayed paused');
        assert.equal(runs.hold.signal, 'SIGKILL');
    });

    it('07.05 - an error inside the watchdog\'s own handling of the pause: caught, the main thread runs again, `frames: none (error:Error)`', function() {
        var run = runs.guard;
        assert.equal(run.signal, null, 'the child was not killed: ' + dump(run));
        var found = stallLines(run);
        assert.equal(found.length, 1, dump(run));
        assert.ok(found[0].at < run.at('BLOCK-END'), 'written while the main thread is still blocked');
        assert.match(plain(found[0].text), /— frames: none \(error:Error\) — in flight 1: GET \/g \[ req req-g \] /);
        var took = run.at('BLOCK-END') - run.at('BLOCK-START');
        assert.ok(took < BLOCK_MS + 600, 'the block took ' + took + ' ms');
        assert.equal(markerValue(run, 'ALIVE'), 'true', 'the watchdog is still on');
    });
});

describeBun('08 - Bun: no frames, said so, while blocked', function() {
    var run = null;
    before(async function() {
        if ( BUN_ONLY ) { return; }
        run = await runChild({ conf: CONF, roots: [FIXTURES], block: 'js', blockMs: 2500, enters: [{ id: 'req-b', m: 'GET', p: '/b' }] });
    });

    it('08.01 - `frames: none (bun)`, before the block ends', function() {
        var found = stallLines(run);
        assert.equal(found.length, 1, dump(run));
        assert.ok(found[0].at < run.at('BLOCK-END'), 'written while the main thread is still blocked');
        assert.match(plain(found[0].text), /— frames: none \(bun\) — in flight 1: GET \/b \[ req req-b \] /);
    });
});
