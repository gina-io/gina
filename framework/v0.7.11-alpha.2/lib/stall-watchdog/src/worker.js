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
 * Plain Node modules only, plus its own `detector.js` (the reading rules, pure) and
 * two modules of the logger that need no framework globals: `redact.js` (the line
 * is masked with a copy of the logger's rules) and `helper.js` (the text line is
 * rendered by the logger's own `format()`). fd 2 is
 * never written: the framework daemon re-logs a bundle's stderr under its own name.
 * Every path is caught; a fault would reach the main thread as an `'error'` event,
 * which turns the watchdog off.
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

var data   = wt.workerData || {};
var parent = wt.parentPort;
var log    = data.log || {};
var mq     = data.mq || null;

var hb          = new Int32Array(data.hb);
var intervalMs  = data.intervalMs || 250;
var thresholdMs = data.thresholdMs || 5000;
var inFlightMax = data.inFlight || 8;

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
 * Write the stall line: the silence, then the requests in flight, oldest first.
 *
 * Text: `[ STALL ] main thread blocked: no heartbeat for 5.3s — in flight 2: PUT /orders/42 [ req <id> ] 5.4s, …`,
 * rendered with the logger's `format()` at `crit`. JSON: the default container's
 * shape `{ts, level, bundle, message, group, msg}` plus `stall` —
 * `{ms, runtime, captured, frames, inFlight: [{id, method, path, ms}]}` (`captured`
 * is `false` and `frames` empty: this thread does not read the blocked thread's
 * frames). The MQ frame carries the text in the logger's envelope.
 *
 * @inner
 * @param {number} silenceMs - Time since the heartbeat last moved
 * @param {number} now
 * @returns {void}
 */
function report(silenceMs, now) {
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

    var text = '[ STALL ] main thread blocked: no heartbeat for ' + seconds(silenceMs)
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
                captured : false,
                frames   : [],
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

/** @inner @type {Object} The reading rules (detector.js): the start, a stall, its end, a suspension. */
var detector = require('./detector.js').createDetector(thresholdMs);
detector.step(Date.now(), Atomics.load(hb, 0));

/**
 * One reading of the heartbeat: a stall is reported here, its end posted to the
 * main thread (which writes the warn line and counts it).
 *
 * @inner
 * @param {number} now
 * @returns {void}
 */
function tick(now) {
    var result = detector.step(now, Atomics.load(hb, 0));
    if ( !result ) {
        return;
    }
    if ( result.t === 'stall' ) {
        report(result.ms, now);
    } else if ( result.t === 'resumed' ) {
        parent.postMessage({ t: 'resumed', ms: result.ms });
    }
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
