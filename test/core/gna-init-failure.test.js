/**
 * #B576 — a throw from the application's `onInitialize` callback fails the
 * boot LOUDLY instead of leaving the bundle alive but unbound.
 *
 * core/gna.js ran the callback inside a try whose catch only did
 * `console.error(...)` and returned: no `[ emerg` marker for start.js's
 * stdout-only startup watchdog, no non-zero exit, and nothing listening (the
 * app never reached its `event.emit('complete')`). Under the daemon the CLI
 * timed out after ~60 s with "Check your logs"; under bin/gina-container the
 * process could even exit with code 0, a success status (the integration file
 * measures that on the pre-fix tree). An async callback's rejection took a
 * second route to the same outcome — the process-level unhandledRejection net,
 * which also only logs.
 *
 * The fix registers a one-shot 'complete' flag before the callback runs and
 * routes a sync throw or a returned promise's rejection through ONE handler:
 * BEFORE 'complete' it aborts in the #B57 shape (console.emerg + fs.writeSync(2)
 * + process.exit(1)); AFTER 'complete' — the server start has already been
 * triggered inside the framework's own 'complete' listener — it logs at error
 * level and the bundle keeps starting.
 *
 * gna.js boots a bundle at require time, so the real module is PINNED, not
 * loaded: section 01 locks the shape in source, through a module-path seam so
 * the pins run red-first against `git show` bytes with zero tree touch;
 * section 02 executes a verbatim replica of the frame with the terminal and
 * the logger injected, including a SUBTRACT arm that reproduces the pre-fix
 * shape and a CONTROL for a throw from the 'complete' listener itself. The
 * real-bytes behaviour (exit 1 with the reason on a piped stderr; the
 * after-'complete' bundle still binding its port) is covered by
 * test/integration/container-boot-init-failure.test.js.
 */
'use strict';
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var path = require('path');
var EventEmitter = require('events').EventEmitter;

var FW = require('../fw');
// Module-path seam: `B576_GNA_SRC=<path>` pins THAT text instead of the tree's
// gna.js — the whole section 01 goes red against the pre-fix bytes.
var SRC = fs.readFileSync(process.env.B576_GNA_SRC || path.join(FW, 'core/gna.js'), 'utf8');

/** @returns {Promise<void>} resolves after pending microtasks + one tick */
var tick = function () { return new Promise(function (r) { setImmediate(r); }); };

/**
 * Strips `//` and block comments outside string literals (single, double and
 * template quotes). Regex literals are not handled — the frame this file
 * slices contains none.
 *
 * @param {string} s - Source text
 * @returns {string} The text without comments
 */
function stripComments(s) {
    var out = '', i = 0, n = s.length, q = null;
    while (i < n) {
        var ch = s[i], nx = s[i + 1];
        if (q) {
            out += ch;
            if (ch === '\\') { out += (nx || ''); i += 2; continue; }
            if (ch === q) { q = null; }
            i++; continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') { q = ch; out += ch; i++; continue; }
        if (ch === '/' && nx === '/') { while (i < n && s[i] !== '\n') { i++; } continue; }
        if (ch === '/' && nx === '*') {
            i += 2;
            while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') { out += '\n'; } i++; }
            i += 2; continue;
        }
        out += ch; i++;
    }
    return out;
}


// ---------------------------------------------------------------------------
// 01 — source pins on the onInitialize frame
// ---------------------------------------------------------------------------

describe('01 - source pins: the onInitialize frame fails fast before \'complete\' (#B576)', function () {

    var hdrIdx = SRC.indexOf('gna.onInitialize = process.onInitialize = function(callback) {');
    var eoIdx  = SRC.indexOf('})// EO modelUtil', hdrIdx);
    var frame  = (hdrIdx > -1 && eoIdx > hdrIdx) ? SRC.slice(hdrIdx, eoIdx) : '';
    var code   = stripComments(frame);

    it('anchors exist (the pins below cannot pass vacuously)', function () {
        assert.ok(hdrIdx > -1, 'onInitialize declaration not found');
        assert.ok(eoIdx > hdrIdx, 'EO modelUtil marker not found after the declaration');
        assert.ok(code.indexOf('callback(e, instance, middleware)') > -1, 'the callback invocation is not in the frame');
    });

    it('the \'complete\' flag is armed BEFORE the callback runs', function () {
        var flagIdx = code.indexOf('e.once(\'complete\', function onInitComplete() { _initCompleted = true; });');
        var callIdx = code.indexOf('callback(e, instance, middleware)');
        assert.ok(flagIdx > -1, 'the one-shot complete flag is missing');
        assert.ok(flagIdx < callIdx, 'the flag must be armed before the callback can emit \'complete\'');
    });

    it('the callback runs inside try, its return value is captured, and the catch only delegates', function () {
        var callIdx = code.indexOf('var _initResult = callback(e, instance, middleware)');
        assert.ok(callIdx > -1, 'the call must capture the return value (then-able detection)');
        var tryIdx = code.lastIndexOf('try {', callIdx);
        assert.ok(tryIdx > -1, 'no try before the call');
        var catchIdx = code.indexOf('} catch (err) {', callIdx);
        assert.ok(catchIdx > -1, 'no catch after the call');
        var catchEnd = code.indexOf('}', catchIdx + '} catch (err) {'.length);
        var catchBlk = code.slice(catchIdx, catchEnd);
        assert.ok(catchBlk.indexOf('_onInitFailure(err)') > -1, 'the catch must delegate to the handler');
        assert.ok(catchBlk.indexOf('console.') < 0, 'the catch must not log-and-swallow on its own');
    });

    it('a returned then-able routes its rejection to the same handler', function () {
        var thenIdx = code.indexOf('typeof _initResult.then === \'function\'');
        assert.ok(thenIdx > -1, 'then-able detection missing');
        assert.ok(code.indexOf('_initResult.then(null, _onInitFailure)', thenIdx) > -1, 'rejection routing missing');
    });

    it('the handler: coercion first, the after-complete branch logs and returns, then the fatal trio in order', function () {
        var hIdx = code.indexOf('var _onInitFailure = function(err) {');
        assert.ok(hIdx > -1, 'handler declaration not found');
        // The handler ends where the frame's call begins — NOT at the next `try {`:
        // the handler's own flush is written `try { fs.writeSync(2, …) }`, so a
        // `try {` anchor would cut the slice before the flush and the exit.
        var hEnd = code.indexOf('var _initResult = callback(e, instance, middleware)', hIdx);
        assert.ok(hEnd > hIdx, 'the frame call must follow the handler');
        var h = code.slice(hIdx, hEnd);
        var pos = {
            coerce : h.indexOf('!(err instanceof Error)'),
            after  : h.indexOf('if (_initCompleted) {'),
            errLog : h.indexOf('console.error(\'[ FRAMEWORK ] onInitialize threw after emitting \\\'complete\\\''),
            msg    : h.indexOf('var _initMsg = \'[ FRAMEWORK ] onInitialize threw before emitting \\\'complete\\\' — aborting boot: \''),
            emerg  : h.indexOf('console.emerg(_initMsg)'),
            flush  : h.indexOf('fs.writeSync(2, _initMsg'),
            exit   : h.indexOf('process.exit(1)')
        };
        Object.keys(pos).forEach(function (k) { assert.ok(pos[k] > -1, 'handler token missing: ' + k); });
        pos.ret = h.indexOf('return;', pos.after);
        assert.ok(pos.ret > -1 && pos.ret < pos.msg, 'the after-complete branch must return before the fatal path');
        assert.ok(pos.coerce < pos.after, 'coercion must precede the branch (the terminal reads .stack)');
        assert.ok(pos.after < pos.errLog && pos.errLog < pos.ret, 'the after-complete branch logs then returns');
        assert.ok(pos.msg < pos.emerg && pos.emerg < pos.flush && pos.flush < pos.exit,
            'fatal order: message → console.emerg (the daemon watchdog matches [ emerg on stdout) → fs.writeSync(2 (survives exit on a pipe) → process.exit(1)');
        assert.equal(h.split('process.exit(').length - 1, 1, 'exactly one exit in the handler');
        assert.equal(h.split('console.emerg(').length - 1, 1, 'exactly one emerg in the handler (the after-complete branch must NOT emerg — the daemon watchdog would SIGKILL a bundle that is starting)');
    });

    it('NEGATIVE: the swallowing log is gone from the frame\'s CODE (comment-stripped)', function () {
        assert.equal(code.indexOf('Could not complete initialization'), -1, 'the pre-fix swallow is still in the code');
        // Anti-vacuity: the RAW frame still names it (the replace-code `// Was:`
        // comment), so the strip is what makes the pin above pass — a broken
        // strip could not satisfy both.
        assert.ok(frame.indexOf('Could not complete initialization') > -1,
            'control: the raw frame no longer carries the replace-code comment — re-check the strip');
    });
});


// ---------------------------------------------------------------------------
// 02 — replica: the frame routes every failure by the 'complete' rule
// ---------------------------------------------------------------------------

describe('02 - replica: every failure is routed by whether \'complete\' was emitted', function () {

    /**
     * Verbatim replica of the FIXED frame (gna.js, inside the 'init' listener's
     * loadAllModels callback) with the terminal and the logger injected. The
     * framework's own 'complete' listener — the one that calls server.start in
     * gna.start — is registered BEFORE the frame, as in gna.js.
     *
     * @param {object} spies - { terminal: [], errorLog: [], serverStart: [] }
     * @param {object} [opts] - { serverStartThrows: boolean }
     * @returns {function} runInit(callback)
     */
    function makeFixedFrame(spies, opts) {
        opts = opts || {};
        var e = new EventEmitter();
        e.on('complete', function (instance) {
            spies.serverStart.push(instance);
            if (opts.serverStartThrows) { throw new Error('server start failed'); }
        });
        return function runInit(callback) {
            var _initCompleted = false;
            e.once('complete', function onInitComplete() { _initCompleted = true; });
            var _onInitFailure = function (err) {
                if ( !(err instanceof Error) ) {
                    err = new Error('onInitialize failed with a non-Error value: ' + String(err));
                }
                if (_initCompleted) {
                    spies.errorLog.push('[ FRAMEWORK ] onInitialize threw after emitting \'complete\' — the bundle keeps starting, but the rest of its bootstrap did not run: ' + (err.stack || err.message));
                    return;
                }
                // stands in for: console.emerg(_initMsg) + fs.writeSync(2, …) + process.exit(1)
                spies.terminal.push('[ FRAMEWORK ] onInitialize threw before emitting \'complete\' — aborting boot: ' + (err.stack || err.message));
            };
            try {
                var _initResult = callback(e, { instance: true }, { middleware: true });
                if (_initResult && typeof _initResult.then === 'function') {
                    _initResult.then(null, _onInitFailure);
                }
            } catch (err) {
                _onInitFailure(err);
            }
        };
    }

    /**
     * The PRE-FIX frame shape (the SUBTRACT arm): try/catch around the bare
     * call, the catch logs at error level and returns; no flag, no then-able.
     *
     * @param {object} spies - as above
     * @returns {function} runInit(callback)
     */
    function makePreFixFrame(spies) {
        var e = new EventEmitter();
        e.on('complete', function (instance) { spies.serverStart.push(instance); });
        return function runInit(callback) {
            try {
                callback(e, { instance: true }, { middleware: true });
            } catch (err) {
                spies.errorLog.push('[ FRAMEWORK ] Could not complete initialization: ' + err.stack);
            }
        };
    }

    var freshSpies = function () { return { terminal: [], errorLog: [], serverStart: [] }; };
    var FATAL = /^\[ FRAMEWORK \] onInitialize threw before emitting 'complete' — aborting boot: Error: /;
    var AFTER = /^\[ FRAMEWORK \] onInitialize threw after emitting 'complete' — the bundle keeps starting, but the rest of its bootstrap did not run: Error: /;

    it('02.1 - a sync throw BEFORE complete reaches the terminal; the server never starts', function () {
        var s = freshSpies();
        makeFixedFrame(s)(function () { throw new Error('boot-time failure'); });
        assert.equal(s.terminal.length, 1, 'the terminal must fire exactly once');
        assert.match(s.terminal[0], FATAL);
        assert.ok(s.terminal[0].indexOf('boot-time failure') > -1, 'the reason must carry the app\'s own message');
        assert.equal(s.serverStart.length, 0);
        assert.equal(s.errorLog.length, 0);
    });

    it('02.2 - a sync throw AFTER complete is logged; the server start already happened; no terminal', function () {
        var s = freshSpies();
        makeFixedFrame(s)(function (event, instance) {
            event.emit('complete', instance);
            throw new Error('late failure');
        });
        assert.equal(s.serverStart.length, 1, 'the server start ran inside the emit');
        assert.equal(s.terminal.length, 0, 'a serving bundle must not be exited');
        assert.equal(s.errorLog.length, 1);
        assert.match(s.errorLog[0], AFTER);
        assert.ok(s.errorLog[0].indexOf('late failure') > -1);
    });

    it('02.3 - an async callback rejecting BEFORE complete reaches the terminal', async function () {
        var s = freshSpies();
        makeFixedFrame(s)(async function () { throw new Error('async boot-time failure'); });
        assert.equal(s.terminal.length, 0, 'nothing may fire synchronously — the rejection is a microtask');
        await tick();
        assert.equal(s.terminal.length, 1);
        assert.match(s.terminal[0], FATAL);
        assert.ok(s.terminal[0].indexOf('async boot-time failure') > -1);
        assert.equal(s.serverStart.length, 0);
    });

    it('02.4 - an async callback rejecting AFTER complete is logged; no terminal', async function () {
        var s = freshSpies();
        makeFixedFrame(s)(async function (event, instance) {
            event.emit('complete', instance);
            throw new Error('late async failure');
        });
        await tick();
        assert.equal(s.serverStart.length, 1);
        assert.equal(s.terminal.length, 0);
        assert.equal(s.errorLog.length, 1);
        assert.match(s.errorLog[0], AFTER);
    });

    it('02.5 - success path: complete emitted, nothing logged, no terminal (sync and async)', async function () {
        var s = freshSpies();
        makeFixedFrame(s)(function (event, instance) { event.emit('complete', instance); });
        makeFixedFrame(s)(async function (event, instance) { event.emit('complete', instance); });
        await tick();
        assert.equal(s.serverStart.length, 2);
        assert.equal(s.terminal.length, 0);
        assert.equal(s.errorLog.length, 0);
    });

    it('02.6 - a non-Error value is coerced BEFORE the terminal reads .stack', function () {
        var s = freshSpies();
        makeFixedFrame(s)(function () { throw null; });
        assert.equal(s.terminal.length, 1);
        assert.match(s.terminal[0], FATAL);
        assert.ok(s.terminal[0].indexOf('non-Error value: null') > -1, 'the coerced message must name the raw value');
    });

    it('02.7 - CONTROL: a throw from the framework\'s own \'complete\' listener is classified BEFORE complete (fatal)', function () {
        var s = freshSpies();
        // The server-start listener runs first (registration order) and throws
        // inside the emit, so the once-flag never runs: the boot must abort.
        makeFixedFrame(s, { serverStartThrows: true })(function (event, instance) {
            event.emit('complete', instance);
        });
        assert.equal(s.serverStart.length, 1);
        assert.equal(s.terminal.length, 1, 'a failed server start is a failed boot');
        assert.ok(s.terminal[0].indexOf('server start failed') > -1);
        assert.equal(s.errorLog.length, 0);
    });

    it('02.8 - SUBTRACT: the pre-fix shape swallows a sync throw before complete (no terminal, error log only)', function () {
        var s = freshSpies();
        makePreFixFrame(s)(function () { throw new Error('boot-time failure'); });
        assert.equal(s.terminal.length, 0, 'the defect: no terminal — nothing reports a failure');
        assert.equal(s.serverStart.length, 0, 'and it never starts serving');
        assert.equal(s.errorLog.length, 1);
        assert.ok(s.errorLog[0].indexOf('Could not complete initialization') > -1);
    });

    it('02.9 - SUBTRACT: the pre-fix shape attaches nothing to an async callback\'s promise — its rejection escapes the frame', async function () {
        var s = freshSpies();
        // The test keeps the promise the pre-fix frame DISCARDS, so the escape is
        // observed here rather than as an unhandled rejection in the runner.
        var escaped = null;
        makePreFixFrame(s)(function () {
            escaped = (async function () { throw new Error('async boot-time failure — escaped'); })();
            return escaped;   // the pre-fix frame ignores this return value
        });
        var caught = null;
        await escaped.then(null, function (e) { caught = e; });
        await tick();
        assert.equal(s.terminal.length, 0, 'the defect: no terminal');
        assert.equal(s.errorLog.length, 0, 'the pre-fix catch never sees a rejection');
        assert.ok(caught && caught.message.indexOf('escaped') > -1, 'only the test\'s own observer saw the rejection');
    });
});
