/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/lib/stall-watchdog
 *
 * Stall watchdog — reports a blocked main thread while it is still blocked.
 *
 * A request that blocks a bundle's main thread (a long synchronous body parse,
 * merge, action or render) stops the process's own logging with it: nothing the
 * main thread schedules runs until the block ends, and an orchestrator's liveness
 * probe may kill the process before it does. Opt-in with
 * `settings.json > server.stallWatchdog`. A worker thread watches a heartbeat the
 * main thread bumps every 250 ms; after `threshold` of silence it writes ONE
 * `crit` line itself — to fd 1 and, when `mq` is a log flow, through its own
 * connection to the framework's MQ listener — naming the silence and the requests
 * in flight. When the main thread resumes, it logs one warn line through the
 * normal logger and, with metrics on, counts the stall.
 *
 * This file is the main-thread side: the config resolution (called pre-listen by
 * `core/server.js` `init()`), the thread's start (called by `core/gna.js`'s
 * `server.on('started')` band), the heartbeat, the in-flight ring's posts (called
 * at the request-entry site of `core/server.js`) and the resume line. The watching
 * side is `worker.js`.
 *
 * Registered with a plain `require` in `lib/index.js`: it owns a thread, a timer
 * and the ring's sequence, which a dev-mode hot reload must never re-evaluate.
 */

var path        = require('path');
var netLocality = require('../../net-locality');

/**
 * The watching thread's script.
 * @inner
 * @constant
 * @type {string}
 */
var WORKER_PATH = path.join(__dirname, 'worker.js');

/**
 * The heartbeat period in ms: the main thread bumps the shared counter this often,
 * and the worker reads it this often.
 * @memberof module:gina/lib/stall-watchdog
 * @constant
 * @type {number}
 */
var HEARTBEAT_MS = 250;

/**
 * The smallest `threshold` accepted, in ms. A dev-mode hot reload re-requires the
 * framework per request, which can take hundreds of milliseconds.
 * @memberof module:gina/lib/stall-watchdog
 * @constant
 * @type {number}
 */
var MIN_THRESHOLD_MS = 1000;

/**
 * The values of the keys an enabled block leaves out.
 * @memberof module:gina/lib/stall-watchdog
 * @constant
 * @type {{threshold: string, captureFrames: boolean, frames: number, inFlight: number}}
 */
var DEFAULTS = { threshold: '5s', captureFrames: true, frames: 8, inFlight: 8 };

/**
 * The integer keys' accepted ranges, bounds included.
 * @inner
 * @constant
 * @type {Object<string, number[]>}
 */
var RANGES = { frames: [1, 32], inFlight: [1, 64] };

/**
 * Every key the block may hold.
 * @inner
 * @constant
 * @type {string[]}
 */
var KEYS = ['enabled', 'threshold', 'captureFrames', 'frames', 'inFlight'];

/**
 * The prefix of a boot refusal's message (the `#MS5` style).
 * @inner
 * @constant
 * @type {string}
 */
var REFUSAL = '[SERVER][stallWatchdog] ';

/** @inner @type {boolean} `true` while the watching thread runs; read once per request by {@link enter}. */
var _enabled = false;
/** @inner @type {?Object} The `Worker`. */
var _worker = null;
/** @inner @type {?Int32Array} The heartbeat counter, over a SharedArrayBuffer. */
var _hb = null;
/** @inner @type {?Object} The heartbeat interval (unref'd). */
var _hbTimer = null;
/** @inner @type {number} The ring's key sequence: a request id can repeat (a client sends it), a key cannot. */
var _seq = 0;
/** @inner @type {?Object} The logger the resume and failure lines go through. */
var _logger = null;
/** @inner @type {?Object} The metrics module the stalls are counted in. */
var _metrics = null;
/** @inner @type {?function} The `logger#redaction` listener. */
var _onRedaction = null;

/**
 * Render a config value for a message: JSON where it can, `String()` otherwise.
 *
 * @inner
 * @param {*} value
 * @returns {string}
 */
function show(value) {
    try {
        var s = JSON.stringify(value);
        return ( typeof(s) == 'string' ) ? s : String(value);
    } catch (err) {
        return String(value);
    }
}

/**
 * A duration in seconds with one decimal, for the lines (`5.3s`).
 *
 * @inner
 * @param {number} ms
 * @returns {string}
 */
function seconds(ms) {
    return (ms / 1000).toFixed(1) + 's';
}

/**
 * Resolve and validate `settings.json > server.stallWatchdog`.
 *
 * An absent block, or `enabled` other than the boolean `true`, resolves to
 * `{ enabled: false }`; a truthy non-boolean `enabled` (the string `"true"`), or a
 * block that is not an object, comes back with a `warning` for the caller to log,
 * since it would otherwise leave the watchdog off without a word. On an enabled
 * block every key is checked, and a wrong one — an unknown key, a threshold under
 * 1s, a count out of range, a non-boolean `captureFrames` — throws: running
 * without the watchdog, or with a value the operator did not write, is a config
 * error, not a silent default. `core/server.js` calls this in `init()`, before any
 * `listen()`, so a throw refuses the boot.
 *
 * `threshold` goes through the framework-global `parseTimeout()` (`"5s"`,
 * `"1500ms"`, `"1m"`, or a number of milliseconds).
 *
 * @memberof module:gina/lib/stall-watchdog
 * @param {*} block - The post-fold `server.stallWatchdog` value
 * @returns {{enabled: boolean, warning: ?string, thresholdMs?: number, captureFrames?: boolean, frames?: number, inFlight?: number}}
 * @throws {Error} On an enabled block holding a wrong key or value
 * @example
 * resolveConfig(undefined);                          // { enabled: false, warning: null }
 * resolveConfig({ enabled: true });                  // { enabled: true, warning: null, thresholdMs: 5000, captureFrames: true, frames: 8, inFlight: 8 }
 * resolveConfig({ enabled: true, threshold: '2s' }); // … thresholdMs: 2000 …
 * resolveConfig({ enabled: 'true' });                // { enabled: false, warning: '[stallWatchdog] … stays off' }
 * resolveConfig({ enabled: true, threshold: '500ms' }); // throws: at least 1s
 */
function resolveConfig(block) {
    if ( typeof(block) == 'undefined' || block === null ) {
        return { enabled: false, warning: null };
    }
    if ( typeof(block) != 'object' || Array.isArray(block) ) {
        return {
            enabled: false,
            warning: '[stallWatchdog] `server.stallWatchdog` must be an object, got ' + show(block) + ': the watchdog stays off'
        };
    }
    if ( block.enabled !== true ) {
        return {
            enabled: false,
            warning: ( block.enabled )
                ? '[stallWatchdog] `server.stallWatchdog.enabled` is ' + show(block.enabled) + ' (a ' + typeof(block.enabled) + '), expected the boolean true: the watchdog stays off'
                : null
        };
    }

    for (var key in block) {
        if ( KEYS.indexOf(key) < 0 ) {
            throw new Error(REFUSAL + '`server.stallWatchdog.' + key + '` is not a key of this block (its keys: ' + KEYS.join(', ') + ')');
        }
    }

    var rawThreshold = ( typeof(block.threshold) == 'undefined' ) ? DEFAULTS.threshold : block.threshold;
    var thresholdMs  = ( typeof(rawThreshold) == 'string' || typeof(rawThreshold) == 'number' ) ? parseTimeout(rawThreshold) : null;
    if ( typeof(thresholdMs) != 'number' || !isFinite(thresholdMs) || thresholdMs < MIN_THRESHOLD_MS ) {
        throw new Error(REFUSAL + '`server.stallWatchdog.threshold` must be a timeout of at least 1s (e.g. "5s", 2000), got `' + show(rawThreshold) + '`');
    }

    var captureFrames = ( typeof(block.captureFrames) == 'undefined' ) ? DEFAULTS.captureFrames : block.captureFrames;
    if ( typeof(captureFrames) != 'boolean' ) {
        throw new Error(REFUSAL + '`server.stallWatchdog.captureFrames` must be a boolean, got `' + show(captureFrames) + '`');
    }

    var counts = {};
    for (var name in RANGES) {
        var value = ( typeof(block[name]) == 'undefined' ) ? DEFAULTS[name] : block[name];
        if ( typeof(value) != 'number' || value !== Math.floor(value) || value < RANGES[name][0] || value > RANGES[name][1] ) {
            throw new Error(REFUSAL + '`server.stallWatchdog.' + name + '` must be an integer from ' + RANGES[name][0] + ' to ' + RANGES[name][1] + ', got `' + show(value) + '`');
        }
        counts[name] = value;
    }

    return {
        enabled       : true,
        warning       : null,
        thresholdMs   : thresholdMs,
        captureFrames : captureFrames,
        frames        : counts.frames,
        inFlight      : counts.inFlight
    };
}

/**
 * The log group the logger writes this process's lines under — the twin of the
 * derivation in `lib/logger/src/main.js`'s level methods: the logger's name, unless
 * the process title names something other than node (a bundle's `gina: <bundle>@<project>`),
 * whose `gina:` prefix is dropped; a `gina-…` title falls back to `gina`.
 *
 * @memberof module:gina/lib/stall-watchdog
 * @param {string} [name] - The logger's option `name`
 * @param {string} [title] - The process title
 * @returns {string}
 * @example
 * resolveLogGroup('gina', 'gina: api@myproject'); // 'api@myproject'
 * resolveLogGroup('gina', '/usr/local/bin/node'); // 'gina'
 */
function resolveLogGroup(name, title) {
    var group = name || 'gina';
    if ( typeof(title) == 'string' && title != 'node' && !/(\\|\/)*node$/.test(title) ) {
        group = title.replace(/^gina\:\s*/, '');
        if ( typeof(group) == 'undefined' || /^gina\-/.test(group) ) {
            group = 'gina';
        }
    }
    return group;
}

/**
 * Read from the logger what the worker needs to write a line the way the logger's
 * default container does: the group, the render format (`json`/`text`), the flows,
 * the template, the level column's width and `crit`'s colour codes. The worker
 * renders the text line with the logger's own `format()` (`lib/logger/src/helper.js`)
 * over these values.
 *
 * @memberof module:gina/lib/stall-watchdog
 * @param {Object} logger - `lib.logger` (anything with `getOptions()` and `getLoggers()`)
 * @param {string} [title=process.title]
 * @returns {{group: string, format: string, flows: string[], template: string, maxLevelLen: number, colorCode: ?string, color: ?{open: string, close: string}}}
 * @example
 * buildLogContext(lib.logger);
 * // { group: 'api@myproject', format: 'text', flows: ['default', 'mq'], template: '[%d] [%s][%a] %m', maxLevelLen: 7, colorCode: 'magenta', color: { open: '…', close: '…' } }
 */
function buildLogContext(logger, title) {
    var opt     = ( logger && typeof(logger.getOptions) == 'function' ) ? ( logger.getOptions() || {} ) : {};
    var loggers = ( logger && typeof(logger.getLoggers) == 'function' ) ? ( logger.getLoggers() || {} ) : {};
    var group   = resolveLogGroup(opt.name, ( typeof(title) == 'string' ) ? title : process.title);
    var levels  = opt.levels || {};

    var maxLevelLen = 0;
    if ( typeof(opt._maxLevelLen) == 'number' && opt._maxLevelLen > 0 ) {
        maxLevelLen = opt._maxLevelLen;
    } else {
        for (var l in levels) {
            if ( l.length > maxLevelLen ) { maxLevelLen = l.length; }
        }
    }

    var colorCode = ( levels.crit && typeof(levels.crit.color) == 'string' ) ? levels.crit.color : null;
    // format() falls back to the `gina` group's registry when the group has none yet
    var registry  = loggers[group] || loggers.gina || {};
    var c         = ( colorCode && registry.colors ) ? registry.colors[colorCode] : null;

    return {
        group       : group,
        format      : ( opt.format === 'json' ) ? 'json' : 'text',
        flows       : Array.isArray(opt.flows) ? opt.flows.slice() : ['default'],
        template    : ( typeof(opt.template) == 'string' ) ? opt.template : '[%d] [%s][%a] %m',
        maxLevelLen : maxLevelLen,
        colorCode   : colorCode,
        color       : ( c && typeof(c.open) == 'string' && typeof(c.close) == 'string' ) ? { open: c.open, close: c.close } : null
    };
}

/**
 * Where the framework's MQ listener is dialled from this process — a deliberate
 * twin of the MQ speaker's resolution (`lib/logger/src/containers/mq/speaker.js`,
 * `init()` + `startMQSpeaker()`), so the watchdog's own connection reaches the
 * listener the bundle's log frames reach. The speaker's lines are not shared: two
 * source pins hold them (`test/bin/control-plane-dial.test.js`), and a parity test
 * runs both resolutions against one settings file.
 *
 * Home: `GINA_HOMEDIR` (framework env, then process env), else `~/.gina`; port: the
 * `mq_port` of `<home>/<major.minor>/settings.json` when it is 1–65535, else 8125;
 * host: `resolveLocalDialHost(GINA_BIND_HOST || settings.bind_host)` — a local
 * bind address, else loopback. `host_v4` is not read (#B320).
 *
 * @memberof module:gina/lib/stall-watchdog
 * @returns {{host: string, port: number}}
 * @example
 * resolveMqEndpoint(); // { host: '127.0.0.1', port: 8125 }
 */
function resolveMqEndpoint() {
    var settings = { mq_port: 8125, host_v4: '127.0.0.1' };
    try {
        var version      = require(path.resolve(__dirname, '../../../../../package.json')).version;
        var shortVersion = version.split('.');
        shortVersion.splice(2);
        shortVersion = shortVersion.join('.');
        var ginaHome = ( typeof(getEnvVar) === 'function' && getEnvVar('GINA_HOMEDIR') )
            || process.env.GINA_HOMEDIR
            || ( getUserHome() + '/.gina' );
        settings = require(ginaHome + '/' + shortVersion + '/settings.json');
    } catch (err) {
        // the speaker's defaults
    }
    var mqPort  = ~~settings.mq_port;
    var envBind = ( typeof(getEnvVar) === 'function' && getEnvVar('GINA_BIND_HOST') )
        || process.env.GINA_BIND_HOST
        || null;
    return {
        host : netLocality.resolveLocalDialHost(envBind || settings.bind_host),
        port : ( mqPort > 0 && mqPort < 65536 ) ? mqPort : 8125
    };
}

/**
 * The runtime the process runs on, for the JSON line.
 *
 * @inner
 * @returns {string} `bun` or `node`
 */
function runtimeName() {
    return ( process.versions && process.versions.bun ) ? 'bun' : 'node';
}

/**
 * Write one line through the logger, swallowing a failure: the watchdog's own
 * messages must never throw into the request path or the boot.
 *
 * @inner
 * @param {string} level - `warn` or `info`
 * @param {string} text
 * @returns {void}
 */
function say(level, text) {
    try {
        if ( _logger && typeof(_logger[level]) == 'function' ) {
            _logger[level](text);
        }
    } catch (err) {
        // nothing left to report it through
    }
}

/**
 * Stop feeding and watching: clear the heartbeat, drop the redaction listener and
 * forget the worker. Logs `text` (once) when the watchdog was running.
 *
 * @inner
 * @param {string} [text] - The warn line to write
 * @returns {?Object} The worker that was running, for the caller to terminate
 */
function disable(text) {
    var wasOn  = _enabled;
    var worker = _worker;
    _enabled = false;
    _worker  = null;
    if ( _hbTimer ) {
        clearInterval(_hbTimer);
        _hbTimer = null;
    }
    if ( _onRedaction ) {
        process.removeListener('logger#redaction', _onRedaction);
        _onRedaction = null;
    }
    if ( wasOn && text ) {
        say('warn', text);
    }
    return worker;
}

/**
 * Post one message to the worker; a worker that is gone drops it.
 *
 * @inner
 * @param {Object} msg
 * @returns {void}
 */
function post(msg) {
    if ( !_worker ) {
        return;
    }
    try {
        _worker.postMessage(msg);
    } catch (err) {
        // the worker is gone: its 'exit' handler turns the watchdog off
    }
}

/**
 * Send the logger's current redaction rules to the worker, after a
 * `setRedaction()` (the `logger#redaction` event). Rules that cannot be copied to
 * the thread stop the watchdog: a line it writes unmasked could carry a secret.
 *
 * @inner
 * @returns {void}
 */
function postRedaction() {
    if ( !_enabled || !_worker || !_logger || typeof(_logger.getRedactionState) != 'function' ) {
        return;
    }
    try {
        _worker.postMessage({ t: 'redact', state: _logger.getRedactionState() });
    } catch (err) {
        var worker = disable('[stallWatchdog] the new log redaction rules cannot be copied to the watchdog thread (' + ( err.message || err ) + '): the watchdog stops rather than write lines they would not mask');
        if ( worker ) {
            try { worker.terminate(); } catch (e) { /* already gone */ }
        }
    }
}

/**
 * The worker's messages: `resumed` (the main thread beats again after a reported
 * stall) writes the warn line and counts the stall; `warn` relays the worker's own
 * trouble (a full stdout pipe).
 *
 * @inner
 * @param {Object} msg
 * @returns {void}
 */
function onWorkerMessage(msg) {
    if ( !msg || typeof(msg) != 'object' ) {
        return;
    }
    if ( msg.t === 'resumed' ) {
        var ms = ( typeof(msg.ms) == 'number' && isFinite(msg.ms) && msg.ms >= 0 ) ? msg.ms : 0;
        say('warn', '[ STALL ] main thread resumed: no heartbeat for ' + seconds(ms) + ' in all');
        if (
            _metrics
            && typeof(_metrics.isEnabled) == 'function' && _metrics.isEnabled()
            && typeof(_metrics.recordMainThreadStall) == 'function'
        ) {
            try {
                _metrics.recordMainThreadStall(ms / 1000);
            } catch (err) {
                say('warn', '[stallWatchdog] the stall could not be counted: ' + ( err.message || err ));
            }
        }
        return;
    }
    if ( msg.t === 'warn' && typeof(msg.text) == 'string' ) {
        say('warn', '[stallWatchdog] ' + msg.text);
    }
}

/**
 * A fault of the watching thread: the watchdog turns off and stays off (no
 * respawn: supervision is not the framework's). Attached on purpose — a worker
 * `'error'` with no listener would reach the main thread's `uncaughtException`.
 *
 * @inner
 * @param {Error} err
 * @returns {void}
 */
function onWorkerError(err) {
    disable('[stallWatchdog] the watchdog thread failed and stays off until the bundle restarts: ' + ( ( err && err.message ) || err ));
}

/**
 * The watching thread ended while the watchdog was on.
 *
 * @inner
 * @param {number} code
 * @returns {void}
 */
function onWorkerExit(code) {
    disable('[stallWatchdog] the watchdog thread ended (code ' + code + ') and stays off until the bundle restarts');
}

/**
 * The heartbeat: one atomic increment, every {@link HEARTBEAT_MS}.
 *
 * @inner
 * @returns {void}
 */
function beat() {
    if ( _hb ) {
        Atomics.add(_hb, 0, 1);
    }
}

/**
 * Start the watching thread and the heartbeat. Called once by `core/gna.js`'s
 * `server.on('started')` band, after the listener is up, with the conf
 * {@link resolveConfig} returned pre-listen; a second call while running is a no-op.
 *
 * The thread starts with `execArgv: []` (it would otherwise inherit `--inspect`
 * flags from `bundle:start --inspect`), a 64 MB heap ceiling, and `unref()`: a
 * diagnostic facility never keeps the process alive. Throws when the thread cannot
 * start (the caller logs a warn and boots without it), including when the log
 * redaction rules cannot be copied to it.
 *
 * @memberof module:gina/lib/stall-watchdog
 * @param {Object} opts
 * @param {Object} opts.conf - The {@link resolveConfig} result
 * @param {Object} [opts.logger] - `lib.logger` (default: required here)
 * @param {Object} [opts.metrics] - `lib.metrics`; the stalls are counted when it is enabled
 * @param {string} [opts.workerPath] - Test-only: another worker script
 * @returns {boolean} `true` when the thread started, `false` when off or already running
 * @throws {Error} When the thread cannot start
 * @example
 * lib.stallWatchdog.init({ conf: server._stallWatchdogConf, logger: lib.logger, metrics: lib.metrics });
 */
function init(opts) {
    opts = opts || {};
    var conf = opts.conf;
    if ( _enabled || !conf || conf.enabled !== true ) {
        return false;
    }

    var logger    = opts.logger || require('../../logger');
    var log       = buildLogContext(logger);
    var redaction = ( typeof(logger.getRedactionState) == 'function' ) ? logger.getRedactionState() : null;
    if ( redaction ) {
        try {
            structuredClone(redaction);
        } catch (err) {
            throw new Error('the log redaction rules cannot be copied to the watchdog thread (' + ( err.message || err ) + '): it stays off rather than write lines they would not mask');
        }
    }

    var Worker = require('worker_threads').Worker;
    var sab    = new SharedArrayBuffer(8);
    var worker = new Worker(opts.workerPath || WORKER_PATH, {
        workerData: {
            hb            : sab,
            intervalMs    : HEARTBEAT_MS,
            thresholdMs   : conf.thresholdMs,
            captureFrames : conf.captureFrames,
            frames        : conf.frames,
            inFlight      : conf.inFlight,
            runtime       : runtimeName(),
            log           : log,
            mq            : ( log.flows.indexOf('mq') > -1 ) ? resolveMqEndpoint() : null,
            redaction     : redaction
        },
        execArgv       : [],
        resourceLimits : { maxOldGenerationSizeMb: 64 }
    });
    // Each handler answers for its own thread only: a thread stopped earlier can still
    // report its exit after a new one started.
    worker.on('message', function(msg) { if ( _worker === worker ) { onWorkerMessage(msg); } });
    worker.on('error', function(err) { if ( _worker === worker ) { onWorkerError(err); } });
    worker.on('exit', function(code) { if ( _worker === worker ) { onWorkerExit(code); } });
    worker.unref();

    _worker  = worker;
    _hb      = new Int32Array(sab);
    _logger  = logger;
    _metrics = opts.metrics || null;
    _enabled = true;

    _hbTimer = setInterval(beat, HEARTBEAT_MS);
    if ( typeof(_hbTimer.unref) == 'function' ) {
        _hbTimer.unref();
    }

    _onRedaction = postRedaction;
    process.on('logger#redaction', _onRedaction);

    if (
        _metrics
        && typeof(_metrics.isEnabled) == 'function' && _metrics.isEnabled()
        && typeof(_metrics.registerMainThreadStallMetrics) == 'function'
    ) {
        try {
            _metrics.registerMainThreadStallMetrics();
        } catch (err) {
            say('warn', '[stallWatchdog] the stall metrics could not be registered: ' + ( err.message || err ));
        }
    }

    say('info', '[stallWatchdog] watching the main thread: a silence of ' + seconds(conf.thresholdMs) + ' or more is reported');
    return true;
}

/**
 * Add a request to the in-flight ring, and remove it at its response's `finish`
 * or `close`. Called at `core/server.js`'s request-entry site for application
 * requests (not `/_gina/*`, static files or maintenance answers), before the body
 * is read. One boolean read when the watchdog is off; first-seer guarded, so a
 * re-entered dispatch adds the request once.
 *
 * @memberof module:gina/lib/stall-watchdog
 * @param {Object} request - The request (`_ginaReqId` and `method` are read)
 * @param {Object} [response] - Its response; without one the entry stays until the ring drops it
 * @param {string} path - The request path, its control characters already escaped (`escapeLogControlChars`)
 * @returns {void}
 * @example
 * lib.stallWatchdog.enter(request, response, escapeLogControlChars(request.url));
 */
function enter(request, response, path) {
    if ( !_enabled || !request || request._swTracked ) {
        return;
    }
    request._swTracked = true;
    var k = ++_seq;
    post({
        t  : 'in',
        k  : k,
        id : ( typeof(request._ginaReqId) == 'string' ) ? request._ginaReqId : null,
        m  : String(request.method),
        p  : ( typeof(path) == 'string' ) ? path : '-',
        at : Date.now()
    });
    if ( response && typeof(response.once) == 'function' ) {
        var done = false;
        var out = function() {
            if ( done ) {
                return;
            }
            done = true;
            post({ t: 'out', k: k });
        };
        response.once('finish', out);
        response.once('close', out);
    }
}

/**
 * Whether the watching thread runs.
 *
 * @memberof module:gina/lib/stall-watchdog
 * @returns {boolean}
 * @example
 * if ( lib.stallWatchdog.isEnabled() ) { … }
 */
function isEnabled() {
    return _enabled;
}

/**
 * Stop the watchdog: the heartbeat, the redaction listener and the thread. For
 * tests; a bundle never stops it (its exit ends the thread).
 *
 * @memberof module:gina/lib/stall-watchdog
 * @returns {Promise<*>} Settles when the thread has ended
 * @example
 * await lib.stallWatchdog.stop();
 */
function stop() {
    var worker = disable(null);
    if ( worker ) {
        try {
            return worker.terminate();
        } catch (err) {
            // already gone
        }
    }
    return Promise.resolve();
}

module.exports = {
    resolveConfig     : resolveConfig,
    init              : init,
    enter             : enter,
    isEnabled         : isEnabled,
    stop              : stop,
    resolveLogGroup   : resolveLogGroup,
    buildLogContext   : buildLogContext,
    resolveMqEndpoint : resolveMqEndpoint,
    HEARTBEAT_MS      : HEARTBEAT_MS,
    MIN_THRESHOLD_MS  : MIN_THRESHOLD_MS,
    DEFAULTS          : DEFAULTS
};
