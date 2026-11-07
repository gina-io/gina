/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Stall watchdog — the watching thread (started by `main.js`'s `init()`).
 *
 * Reads the heartbeat the main thread bumps every 250 ms; when it has not moved for
 * `threshold`, writes ONE `crit` line itself, while the main thread is still
 * blocked: to fd 1 with `fs.writeSync` (a write this thread makes on its own — a
 * `process.stdout` write would wait for the main thread's loop) and, when `mq` is a
 * log flow, through its own connection to the MQ listener (the frame `gina tail`
 * renders). When the heartbeat moves again it posts `{ t: 'resumed', ms }` to the
 * main thread, which writes the warn line through the logger and counts the stall.
 *
 * With `captureFrames` (Node only), the line first names the blocked thread's call
 * frames: this thread connects to the main thread's inspector
 * (`connectToMainThread()`, no `--inspect` flag), pauses it for about a millisecond,
 * reads its frames, resumes it and disconnects — every step against a deadline,
 * since a main thread inside a native call answers nothing until the call returns.
 * A session that goes away resumes a pause it made, so a failed step disconnects.
 * When another session already holds the main thread paused (a debugger), the
 * watchdog neither pauses nor resumes it. Frames read when the main thread had
 * started running again are withheld: they would be the idle loop's.
 *
 * Plain Node modules only, plus its own `detector.js` (the reading rules) and
 * `frames.js` (the frames' wording), both pure, and two modules of the logger that
 * need no framework globals: `redact.js` (the line is masked with a copy of the
 * logger's rules) and `helper.js` (the text line is rendered by the logger's own
 * `format()`). fd 2 is never written: the framework daemon re-logs a bundle's
 * stderr under its own name. Every path is caught; a fault would reach the main
 * thread as an `'error'` event, which turns the watchdog off.
 *
 * @module gina/lib/stall-watchdog/worker
 */

var wt  = require('worker_threads');
var fs  = require('fs');
var net = require('net');

/**
 * The most in-flight requests the ring holds; a newer entry drops the oldest.
 * @inner
 * @constant
 * @type {number}
 */
var RING_MAX = 256;

/**
 * The longest path written, in characters; a longer one is cut and ends with `…`.
 * Keeps the line short enough to reach a pipe in one write.
 * @inner
 * @constant
 * @type {number}
 */
var PATH_MAX = 256;

/**
 * The longest method written, in characters.
 * @inner
 * @constant
 * @type {number}
 */
var METHOD_MAX = 32;

/**
 * How long a full stdout pipe is waited for, in ms, before the line is given up on
 * that sink (a non-blocking pipe throws `EAGAIN` while it is full).
 * @inner
 * @constant
 * @type {number}
 */
var FD1_WAIT_MS = 50;

/**
 * The MQ connect deadline, in ms (the speaker's).
 * @inner
 * @constant
 * @type {number}
 */
var MQ_CONNECT_MS = 2000;

/**
 * The longest function name written, in characters.
 * @inner
 * @constant
 * @type {number}
 */
var FN_MAX = 128;

/**
 * The deadline of each inspector step of a capture, in ms (enable, the pause's
 * arrival, resume, disable). Measured: an enable over 1,101 loaded scripts took
 * 20–39 ms, a pause about 1 ms; a main thread inside a native call answers none.
 * @inner
 * @constant
 * @type {number}
 */
var STEP_MS = 1000;

/**
 * The deadline of a whole capture, in ms.
 * @inner
 * @constant
 * @type {number}
 */
var CAPTURE_MS = 3000;

/**
 * How long a capture waits, once over, for a main thread that ran again to bump
 * the heartbeat, in ms; a heartbeat still silent after it means the frames are the
 * stall's.
 * @inner
 * @constant
 * @type {number}
 */
var SETTLE_MS = 20;

var data   = wt.workerData || {};
var parent = wt.parentPort;
var log    = data.log || {};
var mq     = data.mq || null;

var hb          = new Int32Array(data.hb);
var intervalMs  = data.intervalMs || 250;
var thresholdMs = data.thresholdMs || 5000;
var inFlightMax = data.inFlight || 8;
var framesMax   = data.frames || 8;
var roots       = Array.isArray(data.roots) ? data.roots : [];

/**
 * How a stall's frames are read: `node` (through the inspector), `bun` (not read:
 * Bun's inspector needs `inspector.open()`, a debugging port), or `null` when
 * `captureFrames` is off (the line names no frames at all).
 * @inner
 * @type {?string}
 */
var frameMode = ( data.captureFrames === true ) ? ( ( data.runtime === 'bun' ) ? 'bun' : 'node' ) : null;

var framesLib = require('./frames.js');

/** @inner @type {Int32Array} A cell nobody signals: `Atomics.wait` on it is a sleep. */
var sleeper = new Int32Array(new SharedArrayBuffer(4));

/** @inner @type {Map<number, Object>} The in-flight ring: key → `{k, id, m, p, at}`, oldest first. */
var ring = new Map();

/** @inner @type {?Object} The compiled redaction state (`null`: nothing to mask). */
var redactState = data.redaction || null;

var redact = null;
try {
    redact = require('../../logger/src/redact.js');
} catch (err) {
    redact = null;
}

var format = null;
try {
    var colors = {};
    if ( log.colorCode && log.color ) {
        colors[log.colorCode] = log.color;
    }
    var registry = {};
    registry[log.group] = { colors: colors };
    format = require('../../logger/src/helper.js')({
        _maxLevelLen : log.maxLevelLen,
        template     : log.template,
        levels       : { crit: { color: log.colorCode } }
    }, registry).format;
} catch (err) {
    format = null;
}

/** @inner @type {Object<string, boolean>} The trouble already reported, once each. */
var complained = {};

/**
 * Tell the main thread about this thread's own trouble, once per kind; it is logged
 * when the main thread runs again.
 *
 * @inner
 * @param {string} kind
 * @param {string} text
 * @returns {void}
 */
function complain(kind, text) {
    if ( complained[kind] ) {
        return;
    }
    complained[kind] = true;
    try {
        parent.postMessage({ t: 'warn', text: text });
    } catch (err) {
        // the main thread is gone
    }
}

/**
 * Mask a string with the logger's redaction rules. Rules that cannot be applied
 * withhold the string: an unmasked value could be a secret.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function mask(s) {
    if ( !redactState ) {
        return s;
    }
    if ( !redact ) {
        complain('redact', 'the log redaction module could not be loaded: the stall line\'s content is withheld');
        return '[withheld]';
    }
    try {
        return redact.apply(redactState, s);
    } catch (err) {
        complain('redact', 'the log redaction rules could not be applied to the stall line (' + ( err.message || err ) + '): its content is withheld');
        return '[withheld]';
    }
}

/**
 * A client-sent value as the line writes it: the backtick becomes `%60` (the
 * framework's `gina tail` reads a backtick-quoted `bundle@project` in a line as the
 * bundle to act on), and a long value is cut.
 *
 * @inner
 * @param {*} value
 * @param {number} max
 * @returns {string}
 */
function neutral(value, max) {
    var s = String(( value === null || typeof(value) == 'undefined' ) ? '-' : value).replace(/`/g, '%60');
    return ( s.length > max ) ? s.slice(0, max) + '…' : s;
}

/**
 * A duration in seconds with one decimal (`5.3s`).
 *
 * @inner
 * @param {number} ms
 * @returns {string}
 */
function seconds(ms) {
    return (ms / 1000).toFixed(1) + 's';
}

/**
 * Write a whole line to fd 1, waiting up to {@link FD1_WAIT_MS} for a full pipe.
 *
 * @inner
 * @param {string} str
 * @returns {boolean} `false` when the line could not be written whole
 */
function writeFd1(str) {
    var buf    = Buffer.from(str, 'utf8');
    var off    = 0;
    var waited = 0;
    while ( off < buf.length ) {
        try {
            off += fs.writeSync(1, buf, off, buf.length - off);
        } catch (err) {
            if ( err && err.code === 'EAGAIN' && waited < FD1_WAIT_MS ) {
                Atomics.wait(sleeper, 0, 0, 5);
                waited += 5;
                continue;
            }
            return false;
        }
    }
    return true;
}

/** @inner @type {?Object} The MQ socket (connecting or connected). */
var mqSock = null;
/** @inner @type {number} Consecutive failed dials, for the backoff. */
var mqAttempts = 0;
/** @inner @type {?Object} The redial timer. */
var mqTimer = null;

/**
 * Arm the next MQ dial: 500 ms, then doubling, capped at 30 s (the speaker's).
 *
 * @inner
 * @returns {void}
 */
function scheduleMq() {
    if ( mqTimer || !mq ) {
        return;
    }
    var delay = Math.min(500 * Math.pow(2, mqAttempts), 30000);
    mqAttempts++;
    mqTimer = setTimeout(function() {
        mqTimer = null;
        dialMq();
    }, delay);
    if ( typeof(mqTimer.unref) == 'function' ) {
        mqTimer.unref();
    }
}

/**
 * Open this thread's own connection to the MQ listener, and keep it: a closed one
 * is dialled again. The first frame names the connection a report (the speaker's
 * handshake); what the listener writes back is read and dropped.
 *
 * @inner
 * @returns {void}
 */
function dialMq() {
    if ( !mq ) {
        return;
    }
    var sock;
    try {
        sock = net.createConnection({ host: mq.host, port: mq.port });
    } catch (err) {
        scheduleMq();
        return;
    }
    mqSock = sock;
    var deadline = setTimeout(function() {
        setImmediate(function() {
            if ( sock.connecting ) {
                sock.destroy();
            }
        });
    }, MQ_CONNECT_MS);
    if ( typeof(deadline.unref) == 'function' ) {
        deadline.unref();
    }
    sock.once('connect', function() {
        clearTimeout(deadline);
        mqAttempts = 0;
        try {
            sock.write(JSON.stringify({ host: mq.host, port: mq.port, request: 'report' }) + '\r\n');
        } catch (err) {
            // the close below redials
        }
    });
    sock.on('data', function() { /* the session id and the echoes: dropped */ });
    sock.on('error', function() { clearTimeout(deadline); });
    sock.on('close', function() {
        clearTimeout(deadline);
        if ( mqSock === sock ) {
            mqSock = null;
        }
        scheduleMq();
    });
    sock.unref();
}

/**
 * Send one frame to the MQ listener; a socket still connecting queues it.
 *
 * @inner
 * @param {string} frame
 * @returns {boolean}
 */
function sendMq(frame) {
    if ( !mqSock || mqSock.destroyed ) {
        return false;
    }
    try {
        mqSock.write(frame);
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Write the stall line: the silence, the blocked thread's call frames (with
 * `captureFrames`), then the requests in flight, oldest first.
 *
 * Text: `[ STALL ] main thread blocked: no heartbeat for 5.3s — frames: mergeBody (lib/merge/src/main.js:412:9) <- … — in flight 2: PUT /orders/42 [ req <id> ] 5.4s, …`,
 * rendered with the logger's `format()` at `crit`; a capture that read no frames
 * writes `— frames: none (<reason>)` ({@link module:gina/lib/stall-watchdog/frames.REASONS}),
 * and with `captureFrames` off the line names no frames. JSON: the default
 * container's shape `{ts, level, bundle, message, group, msg}` plus `stall` —
 * `{ms, runtime, captured, frames: [{fn, file, line, col}], inFlight: [{id, method, path, ms}]}`
 * (`captured` is `false` and `frames` empty when no frames were read). The MQ frame
 * carries the text in the logger's envelope.
 *
 * The silence and the requests' ages are read now, when the line is written: a
 * capture takes some milliseconds (up to its deadline when the main thread is in a
 * native call). Should the main thread have run again meanwhile, the silence stays
 * the one measured when the stall was found.
 *
 * @inner
 * @param {{ms: number, at: number, hb: number}} item - The stall as found: its silence, when, and the heartbeat's value then
 * @param {?{captured: boolean, frames?: Array<Object>, more?: boolean, reason?: string}} cap - What the capture read; `null` with `captureFrames` off
 * @returns {void}
 */
function report(item, cap) {
    var now       = Date.now();
    var silenceMs = ( Atomics.load(hb, 0) === item.hb ) ? Math.max(item.ms, now - ( item.at - item.ms )) : item.ms;

    var entries = Array.from(ring.values());
    entries.sort(function(a, b) { return a.at - b.at; });
    var total = entries.length;
    var shown = entries.slice(0, inFlightMax).map(function(e) {
        return {
            id     : ( typeof(e.id) == 'string' ) ? e.id : null,
            method : neutral(e.m, METHOD_MAX),
            path   : neutral(e.p, PATH_MAX),
            ms     : Math.max(0, now - e.at)
        };
    });

    var captured   = false;
    var stallFrames = [];
    var framesText = '';
    if ( cap ) {
        if ( cap.captured ) {
            captured    = true;
            stallFrames = ( cap.frames || [] ).map(function(f) {
                return { fn: neutral(f.fn, FN_MAX), file: neutral(f.file, PATH_MAX), line: f.line, col: f.col };
            });
            framesText  = ' — frames: ' + framesLib.describeFrames(stallFrames, cap.more);
        } else {
            framesText  = ' — frames: none (' + cap.reason + ')';
        }
    }

    var text = '[ STALL ] main thread blocked: no heartbeat for ' + seconds(silenceMs)
        + framesText
        + ' — in flight ' + total
        + ( ( total > shown.length ) ? ' (oldest ' + shown.length + ')' : '' )
        + ( ( shown.length > 0 ) ? ': ' + shown.map(function(e) {
            return e.method + ' ' + e.path + ' [ req ' + ( e.id || '-' ) + ' ] ' + seconds(e.ms);
        }).join(', ') : '' );
    var content = mask(text);

    var line;
    if ( log.format === 'json' ) {
        line = JSON.stringify({
            ts      : new Date(now).toISOString(),
            level   : 'crit',
            bundle  : log.group,
            message : content,
            group   : log.group,
            msg     : content,
            stall   : {
                ms       : silenceMs,
                runtime  : data.runtime,
                captured : captured,
                frames   : stallFrames.map(function(f) {
                    return { fn: mask(f.fn), file: mask(f.file), line: f.line, col: f.col };
                }),
                inFlight : shown.map(function(e) {
                    return { id: e.id, method: e.method, path: mask(e.path), ms: e.ms };
                })
            }
        }) + '\n';
    } else {
        try {
            line = format(log.group, 'crit', content);
        } catch (err) {
            line = '[' + new Date(now).toISOString() + '] [crit][' + log.group + '] ' + content + '\n';
        }
    }

    if ( !writeFd1(line) ) {
        complain('fd1', 'the stall line could not be written to stdout (the pipe stayed full for ' + FD1_WAIT_MS + ' ms)');
    }
    if ( mq ) {
        sendMq(JSON.stringify({ group: log.group, level: 'crit', content: content, skipFormating: false }) + '\r\n');
    }
}

/** @inner @type {?(Object|boolean)} The `inspector` module, loaded at the first capture; `false` when it could not be. */
var inspectorLib = null;

/**
 * Read the main thread's call frames through its inspector: connect, enable the
 * debugger (its `scriptParsed` replay names each script's url), pause, read the
 * frames, resume, disable, disconnect. Each step has {@link STEP_MS}, the whole
 * capture {@link CAPTURE_MS}. A step that fails or runs out of time ends the
 * capture with a disconnect, which resumes a pause this session made (measured);
 * a late answer to a step already given up on is ignored, since a `post()` after
 * the disconnect throws. Frames read before a later step failed are kept: they
 * were read while the thread was paused. `done` is called once.
 *
 * When another session already holds the main thread paused (a debugger at a
 * breakpoint: `Debugger.paused` arrives before `Debugger.enable` answers), the
 * capture neither pauses nor resumes it, and disconnects, which leaves that pause
 * in place (measured).
 *
 * ⚠️ Nothing may throw out of an inspector callback: measured on Node 25.3.0, an
 * error thrown inside the `Debugger.paused` handler, while the pause is held, kills
 * this thread and leaves the main thread paused for good (the same error thrown from
 * a timer resumes it). So every callback body runs under {@link guard}, and `done`
 * is called on a clean stack (`setImmediate`), outside any inspector callback.
 *
 * @inner
 * @param {function({captured: boolean, frames?: Array<Object>, more?: boolean, reason?: string}): void} done
 * @returns {void}
 */
function capture(done) {
    var finished   = false;
    var session    = null;
    var urls       = new Map();
    var asked      = false;
    var held       = false;
    var got        = null;
    var stepTimer  = null;
    var wholeTimer = null;

    // Ends the capture, once: disconnects (which resumes a pause this session holds),
    // then hands over the frames read so far, or `reason`, on a clean stack.
    var finish = function(reason) {
        if ( finished ) {
            return;
        }
        finished = true;
        clearTimeout(stepTimer);
        clearTimeout(wholeTimer);
        if ( session ) {
            try {
                session.disconnect();
            } catch (err) {
                // already gone
            }
        }
        session = null;
        urls    = null;
        var result = ( got ) ? { captured: true, frames: got.frames, more: got.more } : { captured: false, reason: reason };
        setImmediate(function() { done(result); });
    };

    // A callback body that can never throw out: an error ends the capture.
    var guard = function(fn) {
        return function() {
            try {
                fn.apply(null, arguments);
            } catch (err) {
                try {
                    finish(framesLib.errorReason(err));
                } catch (e) {
                    // finish() catches its own steps: nothing left to do
                }
            }
        };
    };

    // The deadline of the step about to start.
    var arm = function() {
        clearTimeout(stepTimer);
        stepTimer = setTimeout(function() { finish(framesLib.REASONS.outsideJs); }, STEP_MS);
    };

    // One inspector command; its answer, unless the capture is over, goes to `onReply`.
    var send = function(method, onReply) {
        if ( finished ) {
            return;
        }
        try {
            session.post(method, {}, guard(function(err) {
                if ( finished ) {
                    return;
                }
                if ( err ) {
                    finish(framesLib.errorReason(err));
                    return;
                }
                if ( onReply ) {
                    onReply();
                }
            }));
        } catch (err) {
            finish(framesLib.errorReason(err));
        }
    };

    wholeTimer = setTimeout(function() { finish(framesLib.REASONS.outsideJs); }, CAPTURE_MS);

    if ( inspectorLib === null ) {
        try {
            inspectorLib = require('inspector');
        } catch (err) {
            inspectorLib = false;
        }
    }
    if (
        !inspectorLib || typeof(inspectorLib.Session) != 'function'
        || typeof(inspectorLib.Session.prototype.connectToMainThread) != 'function'
    ) {
        finish(framesLib.REASONS.unavailable);
        return;
    }

    try {
        session = new inspectorLib.Session();
        session.on('Debugger.scriptParsed', guard(function(m) {
            if ( !finished && m && m.params ) {
                urls.set(m.params.scriptId, m.params.url);
            }
        }));
        session.on('Debugger.paused', guard(function(m) {
            if ( finished || got ) {
                return;
            }
            if ( !asked ) {
                // paused before this session asked: another session holds the thread
                held = true;
                return;
            }
            clearTimeout(stepTimer);
            got = framesLib.toFrames(m && m.params && m.params.callFrames, urls, roots, framesMax);
            arm();
            send('Debugger.resume', function() {
                arm();
                send('Debugger.disable', function() {
                    finish(null);
                });
            });
        }));
        session.connectToMainThread();
    } catch (err) {
        finish(framesLib.errorReason(err));
        return;
    }

    arm();
    send('Debugger.enable', function() {
        if ( held ) {
            finish(framesLib.REASONS.debugger);
            return;
        }
        asked = true;
        // the deadline for the pause to land: it comes as the `Debugger.paused` event
        arm();
        send('Debugger.pause', null);
    });
}

/**
 * Whether the heartbeat is still at `value` after {@link SETTLE_MS}: a capture's
 * frames are the stall's only then. Measured: when the block ends as a capture
 * starts, the pause lands on the next JavaScript to run, the heartbeat's own timer,
 * sometimes before the counter moves.
 *
 * @inner
 * @param {number} value - The heartbeat's value when the stall was found
 * @returns {boolean}
 */
function stillSilent(value) {
    if ( Atomics.load(hb, 0) !== value ) {
        return false;
    }
    Atomics.wait(sleeper, 0, 0, SETTLE_MS);
    return Atomics.load(hb, 0) === value;
}

/** @inner @type {boolean} `true` while a capture runs; what the readings find meanwhile waits in {@link pending}. */
var capturing = false;

/**
 * The readings' results found during a capture, in order. A `resumed` posted at
 * once would put the warn line before the crit line it ends (measured: 14 ms early).
 * @inner
 * @type {Array<{t: string, ms: number, at: number, hb: number}>}
 */
var pending = [];

/**
 * Report a stall: at once when `captureFrames` is off (no frames) or on Bun
 * (`frames: none (bun)`), otherwise after a capture of the frames.
 *
 * @inner
 * @param {{t: string, ms: number, at: number, hb: number}} item - The stall as found
 * @returns {void}
 */
function startReport(item) {
    if ( frameMode !== 'node' ) {
        report(item, ( frameMode === 'bun' ) ? { captured: false, reason: framesLib.REASONS.bun } : null);
        return;
    }
    capturing = true;
    capture(function(cap) {
        try {
            if ( cap.captured && !stillSilent(item.hb) ) {
                cap = { captured: false, reason: framesLib.REASONS.ended };
            }
            report(item, cap);
        } catch (err) {
            complain('report', 'the stall line could not be written (' + ( err.message || err ) + ')');
        }
        capturing = false;
        drain();
    });
}

/**
 * Act on one result of the readings: report a stall, or post its end to the main
 * thread (which writes the warn line and counts it).
 *
 * @inner
 * @param {{t: string, ms: number, at: number, hb: number}} item
 * @returns {void}
 */
function handle(item) {
    try {
        if ( item.t === 'stall' ) {
            startReport(item);
        } else if ( item.t === 'resumed' ) {
            parent.postMessage({ t: 'resumed', ms: item.ms });
        }
    } catch (err) {
        complain('report', 'a stall could not be reported (' + ( err.message || err ) + ')');
    }
}

/**
 * Act on the results that waited for a capture, in order, until one starts another.
 *
 * @inner
 * @returns {void}
 */
function drain() {
    while ( !capturing && pending.length > 0 ) {
        handle(pending.shift());
    }
}

/** @inner @type {Object} The reading rules (detector.js): the start, a stall, its end, a suspension. */
var detector = require('./detector.js').createDetector(thresholdMs);
detector.step(Date.now(), Atomics.load(hb, 0));

/**
 * One reading of the heartbeat: a stall is reported, its end posted to the main
 * thread; while a capture runs, either waits for it.
 *
 * @inner
 * @param {number} now
 * @returns {void}
 */
function tick(now) {
    var value  = Atomics.load(hb, 0);
    var result = detector.step(now, value);
    if ( !result ) {
        return;
    }
    var item = { t: result.t, ms: result.ms, at: now, hb: value };
    if ( capturing || pending.length > 0 ) {
        pending.push(item);
        return;
    }
    handle(item);
}

parent.on('message', function(msg) {
    try {
        if ( !msg || typeof(msg) != 'object' ) {
            return;
        }
        if ( msg.t === 'in' ) {
            if ( ring.size >= RING_MAX ) {
                ring.delete(ring.keys().next().value);
            }
            ring.set(msg.k, msg);
        } else if ( msg.t === 'out' ) {
            ring.delete(msg.k);
        } else if ( msg.t === 'redact' ) {
            redactState = msg.state || null;
        }
    } catch (err) {
        complain('message', 'a message from the main thread could not be read (' + ( err.message || err ) + ')');
    }
});

// Ref'd on purpose: this interval is what keeps the thread alive between readings.
setInterval(function() {
    try {
        tick(Date.now());
    } catch (err) {
        complain('tick', 'a heartbeat reading failed (' + ( err.message || err ) + ')');
    }
}, intervalMs);

dialMq();
