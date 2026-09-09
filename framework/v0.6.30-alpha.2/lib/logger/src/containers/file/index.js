'use strict';
// Imports
const fs = require('fs');

/**
 * FileContainer — the logger's opt-in `file` flow.
 *
 * An IN-PROCESS sink, exactly like `containers/default`: it listens on the
 * `logger#file` event that `main.js emit()` already raises for every flow in
 * `opt.flows`, and writes the lines THIS process logged. It opens no socket and
 * needs no framework daemon, so it works in a container, under `gina-container`
 * and under a daemon-spawned bundle alike.
 *
 * It used to receive its lines over the MQ socket instead. That shape had three
 * consequences, all measured on a live daemon topology (`audit/2026-09-09-b523-logrot-review.md`):
 *
 *   1. The container dialled the MQ port at construction, and any socket error
 *      ran `process.exit(0)`. In the daemon that dial happens BEFORE the daemon's
 *      own listener binds, so `gina start` died before "Framework ready" (3/3)
 *      whenever this flow was enabled; a bundle without a daemon exited the same
 *      way, with status 0.
 *   2. The listener FORWARDS every speaker's line to every `writeToFile` session,
 *      so every process carrying this flow wrote EVERY bundle's lines into one
 *      shared per-host file — measured twice-over with two bundles — and built a
 *      full `Config` for a bundle it is not, which crashed the `bundle:start` CLI.
 *   3. N processes appending to one file each kept their own rotation state and
 *      their own size counter, so rotation raced and silently lost lines.
 *
 * Writing in-process removes all three by construction: one writer per file, no
 * dial, no foreign configuration. The file is named after the LOG GROUP
 * (`<logdir>/<bundle>@<project>.log`), which is what makes "one writer" true;
 * lines whose group carries no `@` — the CLI's and the daemon's own `gina` lines
 * — are not written, matching the guard the previous `write()` already applied.
 *
 * @package     Gina.Lib.Logger.Containers
 * @namespace   Gina.Lib.Logger.Containers.FileContainer
 * @param   {object} opt     - Logger options, cloned per container by `loadContainers()`
 *                             and merged with `~/.gina/user/extensions/logger/file/config.json`.
 * @param   {object} loggers - The logger registry (used by `format()`).
 * @returns {void}
 *
 * @example
 * // enabled by adding "file" to `flows` in
 * // ~/.gina/user/extensions/logger/default/config.json
 * new FileContainer(opt, loggers);
 */
function FileContainer(opt, loggers) {
    var self = {
        // flow or container name/id
        name: 'file'
    };

    var tag = '[logger#'+ self.name +']';

    var loggerHelper    = require(__dirname +'/../../helper.js')(opt, loggers);
    var format          = loggerHelper.format;

    /** @type {object} One entry per group this process actually logs for. */
    var files       = {};
    /** @type {?object} Rotation policy, resolved ONCE at construction. */
    var rotate      = null;
    /** @type {?string} Resolved log directory, resolved on the first line. */
    var logDir      = null;
    /** @type {boolean} Whether to render JSON lines instead of the text format. */
    var isJsonMode  = false;
    /** @type {boolean} Set once the sink has given up (no resolvable log dir). */
    var disabled    = false;

    // ── Rotation ────────────────────────────────────────────────────────────
    //
    // Options arrive as `opt.rotate`: loadContainers() merges this container's
    // own `~/.gina/user/extensions/logger/file/config.json` over the logger
    // options with override:true (lib/logger/src/main.js), so the sink is
    // configured where it is enabled.
    //
    // Mechanism is rename-then-reopen, NOT copy-then-truncate. This process owns
    // the descriptor and is the only writer of this file, so renaming it and
    // opening a fresh one loses nothing. The retired vendored rotator copied then
    // truncated, which drops every line appended during the copy window — a
    // window that grows with the file, so the bigger the log the more it lost.
    //
    // Defaults are ON at 10MB x 5, deliberately mirroring the kubelet's
    // containerLogMaxSize/containerLogMaxFiles, because this sink appends
    // without bound otherwise and a silent unbounded file is the worst of the
    // available behaviours.
    var DEFAULT_ROTATE = {
        enabled : true,
        when    : 'daily',
        size    : '10MB',
        count   : 5,
        maxAge  : null
    };

    /** Largest amount a stream may hold before lines are dropped, in bytes. */
    var MAX_BUFFERED = 4 * 1024 * 1024;
    /** How long to wait before reopening a stream that errored, in ms. */
    var REOPEN_AFTER = 5000;

    /**
     * Reports a container-level condition through the LOGGER, not through raw
     * stdout.
     *
     * `console` in this file is node's, not gina's (gna.js's `console = lib.logger`
     * is module-scoped), and a raw `process.stdout.write` here reaches nobody
     * under a daemon: `lib/cmd/bundle/start.js` consumes the child's stdout and
     * relays nothing after start. Measured with an invalid `rotate.size`: the
     * refusal appeared on a `gina-container` launcher's own stdout and NOWHERE
     * else — not in the daemon log, not at a tail client, not in the file.
     * Emitting one payload per flow is what `emit()` itself does, so the message
     * takes every transport the process has.
     *
     * Deferred by a tick so it can be called from construction, before the
     * sibling containers have registered their listeners.
     *
     * @inner
     * @param {string}  level    - A configured level name, e.g. `warn` / `err`.
     * @param {string}  content  - The message, without the container tag.
     * @param {boolean} [skipSelf] - Skip the `file` flow. Set for anything raised
     *  from inside the write path, so a broken sink cannot report into itself.
     * @returns {void}
     *
     * Measured reach, with the daemon running: the daemon's own log, every
     * connected tail client, and the invoking CLI's output. NOT the log file
     * itself in the usual case — the report is emitted under `opt.name`, which is
     * still `gina` when a container is constructed, and this sink files bundle
     * groups only. Stdout and the tail are where an operator looks for a
     * configuration refusal, so that is the reach this needs.
     *
     * @example
     * report('warn', 'rotation disabled: ...');        // stdout + tail + CLI output
     * report('err', 'write failed: ...', true);        // same, minus the file flow
     */
    function report(level, content, skipSelf) {
        var flows = ( opt && Array.isArray(opt.flows) && opt.flows.length ) ? opt.flows : ['default'];
        var payload = JSON.stringify({
            group        : opt.name,
            level        : level,
            content      : tag +' '+ content,
            skipFormating: false
        });
        setImmediate(function () {
            for (var i = 0, len = flows.length; i < len; i++) {
                if ( skipSelf && flows[i] === self.name ) {
                    continue;
                }
                process.emit('logger#'+ flows[i], payload);
            }
        });
    }

    /**
     * Parse a size string (`'10MB'`, `'512KB'`, `'1.5GB'`) into bytes.
     *
     * Mirrors the convention of `lib/storage/src/util.js parseSize` on purpose:
     * a unit is REQUIRED and a bare number is refused, so a value can never be
     * silently read as bytes when megabytes were meant. The convention is
     * mirrored rather than imported because the logger is constructed during
     * bootstrap and stays dependency-minimal.
     *
     * @inner
     * @param {string} value - Size with an explicit unit.
     * @returns {number} Bytes, or NaN when unparseable.
     *
     * @example
     * parseSize('10MB');   // 10485760
     * parseSize('10');     // NaN — refused, never read as bytes
     */
    function parseSize(value) {
        if ( typeof(value) != 'string' ) return NaN;
        var m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)\s*$/i.exec(value);
        if (!m) return NaN;
        var mult = { b:1, kb:1024, mb:1048576, gb:1073741824, tb:1099511627776 };
        return Math.floor( parseFloat(m[1]) * mult[ m[2].toLowerCase() ] );
    }

    /**
     * Parse an age string (`'30d'`, `'12h'`) into milliseconds.
     *
     * @inner
     * @param {string} value - Age with an explicit unit.
     * @returns {number} Milliseconds, or NaN when unparseable.
     *
     * @example
     * parseAgeMs('30d');   // 2592000000
     */
    function parseAgeMs(value) {
        if ( typeof(value) != 'string' ) return NaN;
        var m = /^\s*([0-9]+)\s*(h|d|w)\s*$/i.exec(value);
        if (!m) return NaN;
        var mult = { h:3600000, d:86400000, w:604800000 };
        return parseInt(m[1], 10) * mult[ m[2].toLowerCase() ];
    }

    /**
     * Resolve and validate the rotation options ONCE, at construction.
     *
     * The policy is process-wide configuration, not per-file, so resolving it
     * here keeps a refusal outside the write path — which is what lets the
     * refusal be reported through the logger rather than shouted at a stdout
     * nobody reads.
     *
     * Invalid values REFUSE LOUDLY rather than falling back to a default: a
     * rotation policy that silently did something other than what was written
     * is how a log directory fills a disk. The refusal disables rotation and
     * says so; logging itself continues.
     *
     * @inner
     * @returns {object} Resolved options; `enabled:false` when disabled or refused.
     *
     * @example
     * resolveRotate();   // { enabled:true, bytes:10485760, ageMs:null, count:5, daily:true }
     */
    function resolveRotate() {
        // Resolved explicitly, key by key, rather than through lib/merge: this is
        // a small fixed set of scalars, and an unset key must fall back to the
        // default deterministically. `opt.rotate` arrives from a user-authored
        // JSON file, so it may be absent, partial, or not an object at all.
        var user = ( opt.rotate && typeof(opt.rotate) == 'object' && !Array.isArray(opt.rotate) )
                    ? opt.rotate : {};
        // OWN properties only — a `typeof(user.<key>) != 'undefined'` guard is
        // WRONG here, and silently so. The repo-root `utils/prototypes.js` installs
        // `Object.prototype.count` + `functionCount` and `Array.prototype.clone` +
        // `inArray` the moment it is REQUIRED — unguarded — so ANY object, `{}`
        // included, answers `typeof user.count === 'function'`. (`count` is the
        // own-property counter behind idioms like `forwardList.count()` in the MQ
        // listener.) Do NOT cite or patch `helpers/prototypes.js`: it declares the
        // same names, but its guard is `typeof(Object.count) == 'undefined'`, and
        // `Object` inherits through Function.prototype to Object.prototype — so once
        // utils/ has run, the guard reads 'function' and every declaration there is
        // skipped. The trap defeats its own guard. A typeof guard
        // therefore hands the inherited METHOD back as the configured value;
        // `~~(function)` is 0, and rotation refuses itself with "keeps no files"
        // on a perfectly valid default. It is defined `enumerable: false`, so
        // `Object.keys(user)` still reports `[]` and `JSON.stringify` drops the
        // function — which is why the failure reads as "count is undefined" and
        // why an isolated repro outside the framework cannot reproduce it at all.
        // Measured on a live boot, not reasoned from the source.
        var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
        var cfg = {};
        cfg.enabled = has(user, 'enabled') ? user.enabled : DEFAULT_ROTATE.enabled;
        cfg.when    = has(user, 'when')    ? user.when    : DEFAULT_ROTATE.when;
        cfg.size    = has(user, 'size')    ? user.size    : DEFAULT_ROTATE.size;
        cfg.count   = has(user, 'count')   ? user.count   : DEFAULT_ROTATE.count;
        cfg.maxAge  = has(user, 'maxAge')  ? user.maxAge  : DEFAULT_ROTATE.maxAge;
        if ( cfg.enabled === false ) return { enabled: false };

        var refuse = function(why) {
            report('warn', 'log rotation DISABLED: '+ why
                + ' — the file will grow without bound until this is corrected.');
            return { enabled: false };
        };

        var bytes = null;
        if ( cfg.size !== null && typeof(cfg.size) != 'undefined' ) {
            bytes = parseSize(cfg.size);
            if ( isNaN(bytes) || bytes <= 0 ) {
                return refuse('`rotate.size` is '+ JSON.stringify(cfg.size)
                    + ', which is not a size with an explicit unit (e.g. "10MB")');
            }
        }
        var ageMs = null;
        if ( cfg.maxAge !== null && typeof(cfg.maxAge) != 'undefined' ) {
            ageMs = parseAgeMs(cfg.maxAge);
            if ( isNaN(ageMs) || ageMs <= 0 ) {
                return refuse('`rotate.maxAge` is '+ JSON.stringify(cfg.maxAge)
                    + ', which is not an age with an explicit unit (e.g. "30d")');
            }
        }
        var count = ~~(cfg.count);
        if ( count < 1 ) {
            return refuse('`rotate.count` is '+ JSON.stringify(cfg.count) +', which keeps no files');
        }
        if ( cfg.when !== null && typeof(cfg.when) != 'undefined' && !/^daily$/i.test(cfg.when) ) {
            return refuse('`rotate.when` is '+ JSON.stringify(cfg.when) +', expected "daily" or null');
        }
        if ( bytes === null && (cfg.when === null || typeof(cfg.when) == 'undefined') ) {
            return refuse('neither `rotate.size` nor `rotate.when` is set, so nothing would ever trigger');
        }
        return {
            enabled : true,
            bytes   : bytes,
            ageMs   : ageMs,
            count   : count,
            daily   : ( cfg.when !== null && typeof(cfg.when) != 'undefined' )
        };
    }

    /**
     * Resolve the log directory, once, on the first line.
     *
     * Both readers are framework globals that are not guaranteed to exist when a
     * container is constructed, so this is deferred to the first write and every
     * read is guarded. `getLogDir()` creates the directory when it resolves one.
     *
     * @inner
     * @returns {?string} The directory, or null when none can be resolved.
     *
     * @example
     * resolveLogDir();   // '/Users/me/.gina/log'
     */
    function resolveLogDir() {
        if (logDir) return logDir;
        var dir = null;
        try {
            dir = ( typeof getLogDir === 'function' ) ? getLogDir() : null;// jshint ignore:line
        } catch (e) { dir = null; }
        if (!dir) {
            try {
                dir = ( typeof getEnvVar === 'function' ) ? getEnvVar('GINA_LOGDIR') : null;// jshint ignore:line
            } catch (e) { dir = null; }
        }
        if (!dir) {
            dir = process.env.GINA_LOGDIR || null;
        }
        logDir = dir;
        return logDir;
    }

    /**
     * Open (or reopen) the append stream for a group and record its size.
     *
     * @inner
     * @param {object} entry - The group's file entry.
     * @returns {?object} The stream, or null when it could not be opened.
     *
     * @example
     * openStream(entry);
     */
    function openStream(entry) {
        entry.day = new Date().toISOString().slice(0, 10);
        var fd = null;
        try {
            // Opened SYNCHRONOUSLY, then wrapped: `createWriteStream(path)` opens
            // asynchronously, so a burst of lines logged within one tick reaches a
            // size trigger while the file does not exist on disk yet — the
            // cascade's renameSync then throws ENOENT, rotation "fails" once per
            // crossing, and the whole burst stays in a single oversized file.
            // Measured with 60 lines emitted in one tick. Opening the descriptor
            // up front also gives the true starting size, and makes the rename
            // safe: the bytes still queued flush into the file that was renamed,
            // which is the segment they belong to.
            fd = fs.openSync(entry.filename, 'a');
            entry.size   = fs.fstatSync(fd).size;
            entry.stream = fs.createWriteStream(null, { fd: fd });
        } catch (openErr) {
            if ( fd !== null ) {
                try { fs.closeSync(fd); } catch (closeErr) { /* already gone */ }
            }
            entry.size    = 0;
            entry.stream  = null;
            entry.retryAt = Date.now() + REOPEN_AFTER;
            if (!entry.failed) {
                entry.failed = true;
                report('err', 'cannot open `'+ entry.filename +'`: '+ openErr.message
                    +' — retrying, log lines for `'+ entry.group +'` are dropped meanwhile.', true);
            }
            return null;
        }
        // A destroyed stream keeps its reference and silently swallows every later
        // write, so the handler drops the reference instead: the next line reopens,
        // after a cooldown so a permanently broken path cannot spin one failed open
        // per line. The pre-#B523 sink reopened the file for every record, which is
        // why it never had this state to get stuck in.
        entry.stream.on('error', function (streamErr) {
            if (!entry.failed) {
                entry.failed = true;
                report('err', 'log write failed on `'+ entry.filename +'`: '+ streamErr.message
                    +' — retrying on the next line.', true);
            }
            try { entry.stream.destroy(); } catch (destroyErr) { /* already gone */ }
            entry.stream  = null;
            entry.retryAt = Date.now() + REOPEN_AFTER;
        });
        entry.failed  = false;
        entry.retryAt = 0;
        return entry.stream;
    }

    /**
     * Rotate a group's file: close the stream, cascade `.1..N`, rename the live
     * file to `.1`, prune by age, then reopen. Failure is non-fatal by design —
     * losing rotation is preferable to losing the log line that triggered it, so
     * on error the current stream is reopened and writing continues.
     *
     * @inner
     * @param {object} entry - The group's file entry.
     * @returns {void}
     *
     * @example
     * rotateNow(entry);
     */
    function rotateNow(entry) {
        var f = entry.filename, keep = rotate.count;
        try {
            if (entry.stream) { entry.stream.end(); entry.stream = null; }

            try { fs.unlinkSync(f + '.' + keep); } catch (e) { /* absent is fine */ }
            for (var i = keep - 1; i >= 1; i--) {
                try { fs.renameSync(f + '.' + i, f + '.' + (i + 1)); } catch (e) { /* absent is fine */ }
            }
            fs.renameSync(f, f + '.1');

            if (rotate.ageMs) {
                var cutoff = Date.now() - rotate.ageMs;
                for (var n = 1; n <= keep; n++) {
                    try {
                        if ( fs.statSync(f + '.' + n).mtimeMs < cutoff ) { fs.unlinkSync(f + '.' + n); }
                    } catch (e) { /* absent is fine */ }
                }
            }
        } catch (rotErr) {
            report('warn', 'log rotation failed for `'+ f +'`: '+ rotErr.message
                + ' — continuing to write to the current file.', true);
        }
        openStream(entry);
    }

    /**
     * Return the file entry for a group, creating it on first use.
     *
     * @inner
     * @param {string} group - The log group, e.g. `web@myproject`.
     * @returns {?object} The entry, or null when this group cannot be written.
     *
     * @example
     * entryFor('web@myproject');
     */
    function entryFor(group) {
        if ( files[group] ) {
            // A refused group is remembered as a marker rather than as a falsy
            // value: storing `null` would fall through this guard on every later
            // line and report the same refusal once per record.
            return files[group].refused ? null : files[group];
        }
        var dir = resolveLogDir();
        if (!dir) {
            if (!disabled) {
                disabled = true;
                report('warn', 'no log directory could be resolved (GINA_LOGDIR is unset)'
                    +' — the `file` flow is inactive for this process.', true);
            }
            return null;
        }
        // The group reaches a filesystem path, so a separator in it would escape
        // the log directory. Framework-controlled today; refused rather than
        // sanitised, so a surprising group name is visible instead of silently
        // renamed.
        if ( /[\/\\]/.test(group) ) {
            files[group] = { refused: true };
            report('warn', 'log group `'+ group +'` contains a path separator and is not written to file.', true);
            return null;
        }
        files[group] = {
            group    : group,
            filename : dir + '/' + group + '.log',
            stream   : null,
            size     : 0,
            day      : null,
            failed   : false,
            retryAt  : 0,
            dropping : false,
            dropped  : 0
        };
        openStream(files[group]);
        return files[group];
    }

    /**
     * Render one payload as the line that goes to disk.
     *
     * Text mode is the `format()` output with the ANSI colour sequences removed:
     * a log file is not a terminal, and the escapes made every record unreadable
     * to `grep` and to any collector reading the file.
     *
     * @inner
     * @param {object} pl - The parsed `logger#file` payload.
     * @returns {string} The line, newline-terminated.
     *
     * @example
     * render({ group:'web@p', level:'info', content:'hello' });
     */
    function render(pl) {
        if (isJsonMode) {
            // #M12 — the same line shape `containers/default` writes to stdout:
            // `bundle`/`message` canonical, `group`/`msg` kept as back-compat
            // aliases. Deliberately duplicated rather than shared, so the stdout
            // contract stays owned by one file.
            var line = {
                ts     : new Date().toISOString(),
                level  : pl.level,
                bundle : pl.group,
                message: pl.content,
                group  : pl.group,
                msg    : pl.content
            };
            // #M12b — per-request id + elapsed ms when a request context is active.
            if (process.gina && process.gina._reqALS) {
                var store = process.gina._reqALS.getStore();
                if (store) {
                    line.requestId  = store.requestId;
                    line.durationMs = Date.now() - store.startMs;
                }
            }
            return JSON.stringify(line) + '\n';
        }
        // Anchored on the ESCAPE character, written as \u001b so it stays visible:
        // `/\[[0-9;]*m/` without it would eat bracketed text out of the message
        // itself (a payload containing `[30m` is not a colour code).
        return format(pl.group, pl.level, pl.content, pl.skipFormating)
                    .replace(/\u001b\[[0-9;]*m/g, '');
    }

    /**
     * Write one rendered line, rotating first when a trigger is due.
     *
     * @inner
     * @param {object} entry - The group's file entry.
     * @param {Buffer} buf   - The line.
     * @returns {void}
     *
     * @example
     * write(entry, Buffer.from('...\n'));
     */
    function write(entry, buf) {
        if ( !entry.stream ) {
            if ( entry.retryAt && Date.now() < entry.retryAt ) {
                return;
            }
            if ( !openStream(entry) ) {
                return;
            }
        }

        // Trigger BEFORE the write, so a line never straddles a rotation and the
        // cap is an upper bound rather than an overshoot.
        if ( rotate && rotate.enabled ) {
            var bySize = ( rotate.bytes !== null
                        && (entry.size + buf.length) > rotate.bytes
                        && entry.size > 0 );
            var byDay  = ( rotate.daily
                        && entry.day !== new Date().toISOString().slice(0, 10) );
            if ( bySize || byDay ) { rotateNow(entry); }
            if ( !entry.stream ) { return; }
        }

        // A stream whose consumer cannot keep up queues in memory without bound —
        // "a memory leak wearing a logging transport's clothes", which is why the
        // MQ speaker drops rather than buffers. Same posture here: past the cap the
        // line is dropped and the outage is reported once, not once per line.
        if ( entry.stream.writableLength > MAX_BUFFERED ) {
            if ( !entry.dropping ) {
                entry.dropping = true;
                report('warn', 'log file `'+ entry.filename +'` is not draining ('
                    + entry.stream.writableLength +' bytes buffered) — dropping lines until it does.', true);
            }
            entry.dropped++;
            return;
        }
        if ( entry.dropping ) {
            entry.dropping = false;
            report('warn', 'log file `'+ entry.filename +'` is draining again — '
                + entry.dropped +' line(s) were dropped.', true);
            entry.dropped = 0;
        }

        entry.stream.write(buf);
        entry.size += buf.length;
    }

    /**
     * Handle one `logger#file` payload.
     *
     * @inner
     * @param {string} payload - The JSON envelope `emit()` raised.
     * @returns {void}
     *
     * @example
     * onLine('{"group":"web@p","level":"info","content":"hello"}');
     */
    function onLine(payload) {
        if (disabled) {
            return;
        }
        var pl = null;
        try {
            pl = JSON.parse(payload);
        } catch (parseErr) {
            // Unlike the stdout container there is no useful raw fallback for a
            // file: an unparseable envelope is a framework bug, not content.
            return;
        }
        // Only a bundle's own lines are written. A group without `@` is the CLI's
        // or the daemon's own `gina` output, which the previous implementation
        // also refused to file (its `write()` guard printed those to stdout
        // instead) — they still reach stdout through the `default` container.
        if ( !pl.group || !/\@/.test(pl.group) ) {
            return;
        }
        var entry = entryFor(pl.group);
        if (!entry) {
            return;
        }
        try {
            write(entry, Buffer.from(render(pl)));
        } catch (writeErr) {
            if (!entry.failed) {
                entry.failed = true;
                report('err', 'could not write to `'+ entry.filename +'`: '+ writeErr.message, true);
            }
        }
    }

    /**
     * Best-effort flush at process exit.
     *
     * `end()` is asynchronous, so bytes still queued when the process exits can
     * still be lost — a bound this sink cannot remove without making every write
     * synchronous, which would let a slow or full disk block the request loop.
     * Under normal load the queue is empty and this closes the descriptor
     * cleanly.
     *
     * @inner
     * @returns {void}
     *
     * @example
     * process.on('exit', flushOnExit);
     */
    function flushOnExit() {
        for (var group in files) {
            var entry = files[group];
            if ( entry && entry.stream ) {
                try { entry.stream.end(); } catch (endErr) { /* already closing */ }
                entry.stream = null;
            }
        }
    }

    /**
     * Register the sink.
     *
     * @inner
     * @returns {void}
     *
     * @example
     * init();
     */
    function init() {
        rotate = resolveRotate();

        // #M12 — the render format is resolved once at logger init (main.js ->
        // opt.format) and cloned into this container's `opt`; the GINA_LOG_STDOUT
        // fallback covers an init path that predates it.
        isJsonMode = (opt && opt.format)
            ? (opt.format === 'json')
            : /^true$/i.test(process.env.GINA_LOG_STDOUT);

        process.on('logger#'+ self.name, onLine);
        process.on('exit', flushOnExit);

        // ----------------------------Debug---------------------------------------
        var level = 'debug';
        // Init debugging - Logs not in hierarchy will just be ignored
        if (opt.hierarchies[opt.hierarchy].indexOf( opt.levels[level].code) > -1) {
            process.emit('logger#'+self.name, JSON.stringify({
                group       : opt.name,
                level       : level,
                // Raw content !
                content     : '`'+ self.name +'` logger container loaded !'
            }));
        }
        level = null;
        // ------------------------------------------------------------------------
    }

    init();
}
module.exports = FileContainer;
