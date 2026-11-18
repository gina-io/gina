/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module lib/storage/local-stream
 * @description The `local` adapter crossed with the `stream` strategy — large
 * sequential media on the local filesystem, with **resumable uploads**.
 *
 * **The key names an ASSET, not a file**: `assets/<ulid>/original<ext>`. The
 * per-asset directory is the namespace future renditions land in (`preview`,
 * `thumb`, a transcoded variant); `original` is the reserved base-rendition
 * name. No rendition API ships in this slice — the layout reserves the room.
 * Keys stay OPAQUE: callers store what `finalize()`/`put()` returns and never
 * parse the directory out of it.
 *
 * **What per-asset colocation actually buys, stated honestly.** It is
 * OPERATIONAL grouping — one `rm -rf` removes an asset and everything derived
 * from it, one `rsync` moves a subtree. It is NOT physical locality: a
 * directory does not place extents, the allocator does. And gina neither
 * prevents nor can prevent fragmentation — Node exposes no `fallocate`
 * binding, native addons are not shipped, and `ftruncate` produces a fully
 * SPARSE file (measured: 256MB truncate ⇒ 0 blocks on disk), so it reserves
 * nothing and gives neither anti-fragmentation nor an early ENOSPC.
 * Contiguity is a filesystem/volume concern (XFS extent hints and the like).
 * The same honesty the `cas` slice applied to `F_FULLFSYNC`.
 *
 * **Resumable uploads: the filesystem IS the manifest.** A session lives at
 * `<root>/.uploads/<uploadId>/` and holds exactly three kinds of entry —
 * `data` (the file being assembled in place, written POSITIONALLY so segments
 * may arrive out of order), `meta.json` (written ONCE at create through
 * temp+rename, so its state is binary: present-and-parseable, or absent), and
 * one zero-byte `<offset>-<length>.ok` marker per DURABLE range. Nothing about
 * a session touches the metadata store, and the seam gains ZERO new verbs.
 *
 * The argument for that home is FATE-SHARING, not seam economy: the manifest
 * must share crash-fate and fsync-ordering with the bytes it describes.
 * `fsync(data)` happens-before the marker is created, which is enforceable
 * only while both live on the same medium. A store-backed manifest (SQLite
 * WAL, redis, couchbase) can survive a crash the bytes did not, and a manifest
 * claiming a range the bytes lost passes the coverage check and publishes
 * ZEROS — reintroducing, through desync, exactly the hazard the coverage check
 * exists to close.
 *
 * **The zero-fill hazard, and why coverage is an INTERVAL UNION.** A hole in a
 * sparse file reads back as zeros, not as an error (measured). So a finalise
 * that did not verify coverage would publish a plausible, silently zero-filled
 * object. Verifying by SUMMING marker lengths is not enough either: markers
 * `0–8MB` and `4–12MB` sum to 16MB while `12–16MB` is uncovered. Coverage is
 * therefore computed by sorting the markers, merging overlapping and adjacent
 * spans, and requiring exactly ONE span equal to `[0, expectedSize)`.
 *
 * **Durability (`fsync: true`, the stream default).** Per segment: positional
 * write → `fsync(data)` → create the marker. Only the DATA fsync is
 * load-bearing; the marker's own durability is deliberately not guaranteed,
 * because a lost marker beside present bytes costs a re-send, which is the
 * safe direction. Measured: a process killed with SIGKILL after an un-fsynced
 * write still yields the full bytes to a later reader — the page cache carries
 * them — so markers stay honest across PROCESS death without fsync; only power
 * loss or a kernel panic opens the window. The cost is a RANGE, not the single
 * flattering figure: ~12ms per 8MB segment is ~2% of network-paced ingest at
 * 100 Mbps, ~19% at 1 Gbps, and fsync-DOMINANT at 10 Gbps. A LAN-ingest
 * consumer sets `fsync: false` and accepts the documented window. Inherits the
 * `cas` slice's per-platform honesty: the parent-directory flush is
 * best-effort, and macOS honours `fsync` as the platform defines it.
 *
 * **Multi-process: documented, not enforced.** Parallel segment writes are
 * safe when the ranges are DISJOINT — measured on a POSIX-coherent local
 * filesystem: two uncoordinated processes interleaving 1MB stripes into one
 * shared file produced byte-exact output. On relaxed-coherence network mounts
 * (GlusterFS and friends) that has NOT been measured; route one session's
 * segments to one process there. Nothing in this driver enforces affinity —
 * cross-process discovery does not exist in this layer.
 *
 * **No tiering, no hashing.** A multi-gigabyte strategy has no business
 * inlining its payload into a metadata row, and the write path deliberately
 * does not hash. Setting `inlineThreshold` or `hash` on a `stream` driver
 * therefore warns as an ignored key rather than silently doing nothing —
 * `capabilities.inline` and `capabilities.dedup` are both `false`.
 *
 * @example
 * // settings.json — a stream driver for large media
 * // { "storage": { "drivers": { "media": {
 * //     "adapter": "local", "strategy": "stream",
 * //     "root": "/var/data/media", "maxObjectSize": "5GB", "chunkSize": "8MB"
 * // } } } }
 * var s = gina.storage('media');
 * s.createUpload({ expectedSize: 4294967296, originalName: 'talk.mp4' },
 *     function (err, session) {
 *         if (err) { return next(err); }
 *         // session => { uploadId, chunkSize, expectedSize }
 *     });
 */

var fs       = require('fs');
var nodePath = require('path');

var util = require('./util');

/**
 * Directory holding in-flight `put()` temp files, relative to the driver root.
 * Same name as the other local strategies' — one temp namespace per root.
 *
 * @inner
 * @constant
 * @type {string}
 */
var TMP_DIR = '.tmp';

/**
 * Directory holding resumable upload sessions, relative to the driver root.
 * A dot segment, so it is structurally uncollidable with any caller key — the
 * key guards refuse dot segments, the same trick `.tmp` and the `.driver`
 * stamp row already use.
 *
 * @inner
 * @constant
 * @type {string}
 */
var UPLOADS_DIR = '.uploads';

/**
 * Name of the file a session assembles bytes into, inside its own directory.
 * Its mtime — not the directory's — is the session's liveness signal: it
 * advances on every segment write, whereas a directory mtime only moves when
 * entries are added or removed.
 *
 * @inner
 * @constant
 * @type {string}
 */
var DATA_FILE = 'data';

/**
 * Name of a session's manifest, inside its own directory. Written ONCE, at
 * create, through temp+rename — never mutated, so no read-modify-write hazard
 * exists and no crash can leave it half-written.
 *
 * @inner
 * @constant
 * @type {string}
 */
var META_FILE = 'meta.json';

/**
 * The reserved base-rendition file name inside an asset directory.
 *
 * @inner
 * @constant
 * @type {string}
 */
var ORIGINAL = 'original';

/**
 * A durable-range marker's file name grammar: `<offset>-<length>.ok`.
 * Anything else in a session directory is ignored by the coverage scan.
 *
 * @inner
 * @constant
 * @type {RegExp}
 */
var MARKER_RE = /^([0-9]+)-([0-9]+)\.ok$/;

/**
 * A driver-minted upload id: a ULID in Crockford base32, which excludes I, L,
 * O and U. Validated BEFORE any path join — an id reaches the filesystem as a
 * directory name, so this is a security boundary, not a formatting nicety
 * (`findByDigest`'s posture in the cas strategy).
 *
 * @inner
 * @constant
 * @type {RegExp}
 */
var UPLOAD_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A resumable upload session, as returned by `createUpload()`.
 *
 * @typedef  {Object} StorageUploadSession
 * @property {string} uploadId     - Opaque, driver-minted session id. Hand it back to
 *                                   `writeSegment`/`statUpload`/`finalize`/`abortUpload`.
 * @property {number} chunkSize    - The driver's configured segment size, in bytes. Advisory:
 *                                   a client may send any segment size, but this is the size
 *                                   the write path is tuned for.
 * @property {number} expectedSize - The declared total, echoed back.
 */

/**
 * One durable byte range of a session, as reported by `statUpload()`.
 *
 * @typedef  {Object} StorageUploadSpan
 * @property {number} offset - First byte of the span.
 * @property {number} length - Span length in bytes; the span covers `[offset, offset+length)`.
 */

/**
 * The state of a resumable upload, as returned by `statUpload()` — the verb
 * that makes resuming possible at all.
 *
 * @typedef  {Object} StorageUploadState
 * @property {number}              expectedSize - The declared total, from `createUpload`.
 * @property {?string}             contentType  - Client-supplied MIME type, verbatim.
 * @property {?string}             originalName - Client-supplied filename, verbatim.
 * @property {number}              createdAt    - Epoch ms at session creation.
 * @property {StorageUploadSpan[]} received     - Durable ranges, merged and offset-ordered.
 * @property {StorageUploadSpan[]} missing      - The gaps within `[0, expectedSize)` — what a
 *                                                resuming client must still send. An HTTP
 *                                                protocol that reports only a contiguous
 *                                                offset (tus) reads `received[0]`.
 * @property {boolean}             complete     - `true` when `missing` is empty, i.e. when
 *                                                `finalize()` would succeed.
 */

/**
 * Build a `local` filesystem driver with the `stream` (large sequential media,
 * resumable) strategy.
 *
 * @param {string}           name                        - Driver name, used only in error messages.
 * @param {object}           conf                        - Resolved driver configuration (defaults
 *                                                         resolve in `start()`, never here — the
 *                                                         `maxObjectSize` pattern).
 * @param {string}           conf.root                   - Absolute driver root. Validated at boot
 *                                                         to be absolute and outside every
 *                                                         web-served tree.
 * @param {number}           conf.maxObjectSize          - Per-object byte ceiling, already parsed.
 * @param {number}           conf.chunkSize              - Write-stream `highWaterMark`, in bytes.
 * @param {boolean}          conf.fsync                  - Whether segment writes and the finalise
 *                                                         publish flush to disk (file hard, parent
 *                                                         dir best-effort).
 * @param {number}           conf.sessionTtl             - How long an untouched session survives
 *                                                         before the sweep reclaims it, in ms.
 * @param {number}           conf.sessionSweepInterval   - Sweep period in ms; `0` disables the
 *                                                         periodic sweep (the build-time pass
 *                                                         still runs).
 * @param {StorageMetaStore} metaStore                   - Metadata backend (embedded SQLite by
 *                                                         default). No refcount verbs required —
 *                                                         `stream` uses the four required ones.
 * @returns {StorageDriver} A ready driver (plus the five resumable verbs).
 *
 * @example
 * var driver = createLocalStreamDriver('media', conf, metaStore);
 */
module.exports = function createLocalStreamDriver(name, conf, metaStore) {

    var root      = conf.root;
    var max       = conf.maxObjectSize;
    var fsyncOn   = ( conf.fsync === true );
    var chunkSize = ( typeof conf.chunkSize === 'number' && conf.chunkSize > 0 )
        ? conf.chunkSize
        : 0;
    var sessionTtlMs = ( typeof conf.sessionTtl === 'number' && conf.sessionTtl > 0 )
        ? conf.sessionTtl
        : 0;
    var sweepIntervalMs = ( typeof conf.sessionSweepInterval === 'number' && conf.sessionSweepInterval > 0 )
        ? conf.sessionSweepInterval
        : 0;

    /**
     * Key → confined absolute path. Shared, single-sourced guard sequence —
     * see {@link module:lib/storage/util.makeResolvePath} for the three guards
     * and why their ORDER is load-bearing.
     *
     * @inner
     * @type {function(string): {path: ?string, error: ?Error}}
     */
    var resolvePath = util.makeResolvePath(name, root);

    var tmpD     = nodePath.join(root, TMP_DIR);
    var uploadsD = nodePath.join(root, UPLOADS_DIR);

    /**
     * fsync a file by path — the HARD half of the durability contract: a
     * failure here fails the operation that asked for durability.
     *
     * @inner
     * @param {string} p - File path.
     * @returns {void}
     */
    var fsyncFile = function(p) {
        var fd = fs.openSync(p, 'r');
        try {
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    };

    /**
     * fsync a directory — the BEST-EFFORT half: platforms and filesystems that
     * cannot fsync a directory (Windows; some network mounts) throw here and
     * the publish proceeds, which the module header documents rather than
     * silently implies.
     *
     * @inner
     * @param {string} p - Directory path.
     * @returns {void}
     */
    var fsyncDirBestEffort = function(p) {
        try {
            var fd = fs.openSync(p, 'r');
            try {
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
        } catch (e) {
            // platform cannot fsync a directory — best-effort by contract
        }
    };

    /**
     * Validate an upload id and resolve its session directory.
     *
     * The id is charset-validated BEFORE any path join, so a traversal
     * attempt (`../`), a dot segment or a stray separator never reaches
     * `path.join` at all — the same posture `findByDigest` takes with a
     * caller-supplied digest.
     *
     * @inner
     * @param {*} uploadId - Caller-supplied session id, any type tolerated.
     * @returns {{dir: ?string, error: ?Error}} Exactly one side is set.
     */
    var resolveSession = function(uploadId) {
        if ( typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId) ) {
            return { dir: null, error: new Error('[storage:' + name + '] not a valid upload id: ' + JSON.stringify(uploadId)) };
        }
        return { dir: nodePath.join(uploadsD, uploadId), error: null };
    };

    /**
     * Read a session manifest.
     *
     * Fails LOUDLY on a missing or unparseable manifest rather than assuming
     * defaults: because the manifest is written atomically, "absent" and
     * "present and parseable" are the only two states a crash can leave, so
     * anything else is corruption or a stale/abandoned id — and inventing an
     * `expectedSize` for it would let the coverage check pass over nothing.
     *
     * @inner
     * @param {string} dir - Session directory.
     * @returns {{meta: ?object, error: ?Error}} Exactly one side is set.
     */
    var readManifest = function(dir) {
        var raw;
        try {
            raw = fs.readFileSync(nodePath.join(dir, META_FILE), 'utf8');
        } catch (e) {
            return { meta: null, error: new Error('[storage:' + name + '] no such upload session (or its manifest is gone): ' + nodePath.basename(dir)) };
        }
        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return { meta: null, error: new Error('[storage:' + name + '] the manifest for upload session `' + nodePath.basename(dir) + '` is unreadable (' + (e.message || e) + ') — the session cannot be resumed or finalised; abort it') };
        }
        if ( !parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.expectedSize) || typeof parsed.key !== 'string' ) {
            return { meta: null, error: new Error('[storage:' + name + '] the manifest for upload session `' + nodePath.basename(dir) + '` is malformed — the session cannot be resumed or finalised; abort it') };
        }
        return { meta: parsed, error: null };
    };

    /**
     * Merge byte spans into the minimal offset-ordered set covering the same
     * bytes. ADJACENT spans merge as well as overlapping ones (`8MB-16MB`
     * following `0MB-8MB` is one contiguous range, not two), which is what
     * makes "exactly one span equal to `[0, expectedSize)`" the completeness
     * test.
     *
     * @inner
     * @param {StorageUploadSpan[]} spans - Unordered, possibly overlapping spans.
     * @returns {StorageUploadSpan[]} Merged, offset-ordered.
     */
    var mergeSpans = function(spans) {
        var sorted = spans.slice().sort(function(a, b) { return a.offset - b.offset; });
        var out = [];
        for (var i = 0; i < sorted.length; i++) {
            var s = sorted[i];
            if ( s.length <= 0 ) { continue; }
            var last = out.length ? out[out.length - 1] : null;
            if ( last && s.offset <= last.offset + last.length ) {
                var end = Math.max(last.offset + last.length, s.offset + s.length);
                last.length = end - last.offset;
            } else {
                out.push({ offset: s.offset, length: s.length });
            }
        }
        return out;
    };

    /**
     * Read a session's durable ranges from its markers.
     *
     * The filesystem IS the manifest: one zero-byte `<offset>-<length>.ok`
     * file per range whose bytes are durable. Entries that do not match the
     * grammar (`data`, `meta.json`, anything an operator dropped in) are
     * ignored.
     *
     * @inner
     * @param {string} dir - Session directory.
     * @returns {StorageUploadSpan[]} Merged, offset-ordered durable ranges.
     */
    var readSpans = function(dir) {
        var entries;
        try {
            entries = fs.readdirSync(dir);
        } catch (e) {
            return [];
        }
        var spans = [];
        for (var i = 0; i < entries.length; i++) {
            var m = MARKER_RE.exec(entries[i]);
            if ( !m ) { continue; }
            spans.push({ offset: parseInt(m[1], 10), length: parseInt(m[2], 10) });
        }
        return mergeSpans(spans);
    };

    /**
     * The gaps in `[0, expectedSize)` left by a set of merged spans — what a
     * resuming client still has to send.
     *
     * @inner
     * @param {StorageUploadSpan[]} spans        - Merged, offset-ordered durable ranges.
     * @param {number}              expectedSize - The declared total.
     * @returns {StorageUploadSpan[]} Missing ranges, offset-ordered.
     */
    var missingSpans = function(spans, expectedSize) {
        var out    = [];
        var cursor = 0;
        for (var i = 0; i < spans.length; i++) {
            if ( spans[i].offset > cursor ) {
                out.push({ offset: cursor, length: spans[i].offset - cursor });
            }
            cursor = Math.max(cursor, spans[i].offset + spans[i].length);
        }
        if ( cursor < expectedSize ) {
            out.push({ offset: cursor, length: expectedSize - cursor });
        }
        return out;
    };

    /**
     * Total durable bytes across a merged span set.
     *
     * @inner
     * @param {StorageUploadSpan[]} spans - Merged spans.
     * @returns {number} Byte count.
     */
    var coveredBytes = function(spans) {
        var n = 0;
        for (var i = 0; i < spans.length; i++) { n += spans[i].length; }
        return n;
    };

    /**
     * Remove a session directory and everything in it. Used by `abortUpload`,
     * by a successful `finalize`, and by the sweep.
     *
     * @inner
     * @param {string} dir - Session directory.
     * @returns {void}
     */
    var dropSession = function(dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* raced or unreadable */ }
    };

    /**
     * One reclamation pass: abandoned upload sessions, plus `put()` temp
     * orphans, both age-gated at `sessionTtl`.
     *
     * Sessions get their own sweep rather than riding a shared one because
     * they legitimately live for DAYS — a paused multi-gigabyte upload is not
     * garbage — where a crashed `put()`'s temp is dead the moment its process
     * is. Liveness is `mtime(data)`, which advances on every segment write;
     * the session directory's own mtime only moves when entries are added or
     * removed, so a long segment write would look idle by that measure. A
     * session whose `data` is gone (a `finalize` that renamed the bytes away
     * and then failed to write the row) falls back to the directory mtime, so
     * it is reclaimable too.
     *
     * The temp half is the same age gate applied to `<root>/.tmp`: a crashed
     * `put()` leaves its temp behind and no verb ever looks at it again. Every
     * strategy now clears its own — `cas` and `sharded` at build (#B349 closed
     * the sharded gap), `stream` here at build AND on the interval, because
     * this pass has sessions to walk anyway. Each sweeps only its OWN root.
     *
     * Never throws: an unreadable directory is the next verb's problem to
     * report properly, and a sweep that took the build down would be a worse
     * failure than the leak it prevents.
     *
     * @inner
     * @returns {{sessions: number, temps: number}} What this pass reclaimed.
     */
    var sweepAbandoned = function() {
        var out = { sessions: 0, temps: 0 };
        if ( sessionTtlMs <= 0 ) { return out; }
        var cutoff = Date.now() - sessionTtlMs;

        try {
            if ( fs.existsSync(uploadsD) ) {
                var sessions = fs.readdirSync(uploadsD);
                for (var i = 0; i < sessions.length; i++) {
                    var dir = nodePath.join(uploadsD, sessions[i]);
                    try {
                        var liveness;
                        try {
                            liveness = fs.statSync(nodePath.join(dir, DATA_FILE)).mtimeMs;
                        } catch (e) {
                            liveness = fs.statSync(dir).mtimeMs;
                        }
                        if ( liveness < cutoff ) {
                            fs.rmSync(dir, { recursive: true, force: true });
                            out.sessions++;
                        }
                    } catch (e) { /* raced or unreadable — leave it */ }
                }
            }
        } catch (e) { /* never blocks the build */ }

        try {
            if ( fs.existsSync(tmpD) ) {
                var temps = fs.readdirSync(tmpD);
                for (var t = 0; t < temps.length; t++) {
                    var tp = nodePath.join(tmpD, temps[t]);
                    try {
                        if ( fs.statSync(tp).mtimeMs < cutoff ) {
                            fs.unlinkSync(tp);
                            out.temps++;
                        }
                    } catch (e) { /* raced or unreadable — leave it */ }
                }
            }
        } catch (e) { /* never blocks the build */ }

        return out;
    };

    // Build-time pass: a bundle that crashed mid-upload has sessions and temps
    // nothing else will ever remove, and a restart is the earliest moment we
    // can be sure the previous process is gone.
    sweepAbandoned();

    /**
     * The periodic sweep timer — self-contained and unref'd (the `lib/job`
     * scheduling precedent; `lib/cron` is dormant), so it never holds the
     * process open. Cleared by `close()`. The build-time pass alone would
     * suffice for short-lived temps but not for sessions abandoned by a client
     * that simply went away while the bundle kept running.
     *
     * @inner
     * @type {?object}
     */
    var sweepTimer = null;
    if ( sweepIntervalMs > 0 ) {
        sweepTimer = setInterval(sweepAbandoned, sweepIntervalMs);
        if ( sweepTimer.unref ) { sweepTimer.unref(); }
    }

    /**
     * What this driver can do — hoisted to a closure var so `stats()` can
     * include it in its report without reaching back into the returned
     * literal. Documented on the `capabilities` property below.
     *
     * @inner
     * @type {{offload: boolean, ranges: boolean, dedup: boolean, resumable: boolean, inline: boolean}}
     */
    var capabilities = {
        offload   : false,
        ranges    : true,
        dedup     : false,
        resumable : true,
        inline    : false
    };

    return {

        /**
         * Store a readable stream of known-at-the-end size and return its
         * opaque key — the one-shot path, for content whose total the caller
         * does not know up front or does not need to resume.
         *
         * Streams to a temp file inside the driver root and publishes with
         * `rename(2)`, so a reader never observes a partial object and a
         * crashed write leaves nothing visible. The write stream's
         * `highWaterMark` is the configured `chunkSize`, so the syscall size is
         * the tuned one with no hand-rolled buffer and no extra copy — memory
         * stays bounded by the stream machinery rather than by us. With
         * `fsync` on, the temp is flushed BEFORE the rename publishes it and
         * the parent directory best-effort after.
         *
         * No tiering branch: a `stream` driver never inlines. The reported
         * size is measured from the published file on disk, never from the
         * client and never from an in-flight counter (#B142).
         *
         * @param {object}   stream              - Any readable stream.
         * @param {object}   [meta]              - Client-supplied, untrusted.
         * @param {string}   [meta.originalName] - Filename; stored verbatim in metadata, and
         *                                         the only source of the path extension.
         * @param {string}   [meta.contentType]  - MIME type; stored verbatim.
         * @param {function} fn                  - `fn(err, {@link StoragePutResult})`.
         * @returns {void}
         *
         * @example
         * driver.put(req, { originalName: 'talk.mp4' }, function (err, res) {
         *     if (err) { return next(err); }
         *     record.assetKey = res.key;   // opaque — store it, never parse it
         * });
         */
        put: function(stream, meta, fn) {
            if ( typeof meta === 'function' ) { fn = meta; meta = {}; }
            meta = meta || {};
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] put() requires a callback');
            }
            if ( !stream || typeof stream.pipe !== 'function' ) {
                return fn(new Error('[storage:' + name + '] put() requires a readable stream'));
            }

            var now   = new Date();
            var id    = util.ulid(now.getTime());
            var ext   = util.sanitiseExtension(meta.originalName);
            var key   = 'assets/' + id + '/' + ORIGINAL + ext;
            var final = nodePath.join(root, key);
            var tmp   = nodePath.join(tmpD, id + '.tmp');

            try {
                fs.mkdirSync(nodePath.dirname(final), { recursive: true });
                fs.mkdirSync(tmpD, { recursive: true });
            } catch (mkErr) {
                return fn(mkErr);
            }

            var settled = false;
            var written = 0;

            var ws = fs.createWriteStream(tmp, { highWaterMark: chunkSize || undefined });

            /**
             * Abandon the put: tear both streams down, remove the temp, report.
             *
             * #B358 — the unlink WAITS for the write stream to close, and the
             * callback waits with it. `createWriteStream()` opens
             * asynchronously, so a refusal raised from the 'data' handler
             * (`maxObjectSize`) or an immediately failing source reaches here
             * while the open is still in the threadpool: the temp does not
             * exist YET at this instant but lands a tick later, on the worker
             * thread, with no event-loop turn in between for a synchronous
             * check to see. The previous `existsSync`-gated unlink therefore
             * read false, skipped, and orphaned the temp — measured at ~30% on
             * a 4096-byte refusal. Deferring to 'close' also fixes the contract
             * it broke: a caller told the put failed must not be able to
             * observe residue afterwards. `force` absorbs the open that never
             * happened at all, so the no-temp case costs nothing.
             *
             * @inner
             * @param {*} err - The failure to report; wrapped if not an Error.
             * @returns {void}
             */
            var onError = function(err) {
                if (settled) return;
                settled = true;
                try { stream.destroy(); } catch (_e) {}

                var finish = function() {
                    try { fs.rmSync(tmp, { force: true }); } catch (_e) {}
                    fn(( err instanceof Error ) ? err : new Error(String(err)));
                };

                // Already closed (an autoDestroyed ws that errored) would never
                // emit 'close' again — that arm must not wait for it.
                if ( ws.closed || ws.destroyed ) { return finish(); }
                ws.once('close', finish);
                try { ws.destroy(); } catch (_e) { finish(); }
            };

            // #B143 — armed at creation, never in a later handler: Node does not
            // replay 'error' for a listener attached after the fact, and an
            // unlistened stream 'error' becomes an uncaughtException that takes
            // the bundle down. Both streams need their own; `.pipe()` returns the
            // DESTINATION, so a single chained listener would cover only one.
            ws.on('error', onError);
            stream.on('error', onError);

            // 'close' also follows 'error' on an autoDestroyed stream, so the
            // settled latch is what keeps a failed write from publishing.
            ws.on('close', function() {
                if (settled) return;

                var size;
                try {
                    size = fs.statSync(tmp).size;
                    if ( fsyncOn ) { fsyncFile(tmp); }
                    fs.renameSync(tmp, final);
                    if ( fsyncOn ) { fsyncDirBestEffort(nodePath.dirname(final)); }
                } catch (err) {
                    return onError(err);
                }

                settled = true;
                metaStore.set(key, {
                    originalName : ( typeof meta.originalName === 'string' ) ? meta.originalName : null,
                    contentType  : ( typeof meta.contentType === 'string' ) ? meta.contentType : null,
                    size         : size,
                    createdAt    : now.getTime()
                }, function(metaErr) {
                    if (metaErr) {
                        // The bytes are published but unindexed. Roll the object
                        // back rather than leave a file `stat()` will deny exists
                        // — a caller that got no key can never reference it.
                        try { fs.unlinkSync(final); } catch (_e) {}
                        return fn(metaErr);
                    }
                    fn(null, {
                        key         : key,
                        size        : size,
                        contentType : ( typeof meta.contentType === 'string' ) ? meta.contentType : null
                    });
                });
            });

            stream.on('data', function(chunk) {
                if (settled) return;
                written += chunk.length;
                if ( written > max ) {
                    return onError(new Error('[storage:' + name + '] object exceeds maxObjectSize (' + max + ' bytes) — refused'));
                }
            });

            stream.pipe(ws);
        },

        /**
         * Open a resumable upload session.
         *
         * **`expectedSize` is REQUIRED**, and that is the deliberate exclusion
         * in this contract: without a declared total, `finalize()` cannot
         * verify that the received ranges actually cover the object, and
         * `statUpload()` cannot say what is MISSING — only what arrived. A
         * caller that does not know the size uses `put()`. (The equivalent
         * wire protocols agree in spirit: tus requires `Upload-Length` unless
         * a server opts into the separate defer-length extension, and S3
         * multipart simply cannot report missing parts because it never learns
         * the total.)
         *
         * The declared size permits an early `maxObjectSize` refusal before
         * any bytes move — **advisory only**: `expectedSize` is
         * client-supplied, so the running byte counter in `writeSegment` stays
         * the real enforcement.
         *
         * **The KEY is minted here**, not at finalise, and persisted in the
         * manifest. Minting it at finalise would mean that a row write failing
         * after the bytes are published leaves them at an address nobody
         * holds — an unreachable orphan plus a session that can never finalise
         * again, which is strictly worse than the row simply being retried.
         *
         * @param {object}   meta                - Session metadata.
         * @param {number}   meta.expectedSize   - The object's total size in bytes. Required;
         *                                         a positive integer, at most `maxObjectSize`.
         * @param {string}   [meta.originalName] - Filename; stored verbatim, and the only
         *                                         source of the key's extension.
         * @param {string}   [meta.contentType]  - MIME type; stored verbatim.
         * @param {function} fn                  - `fn(err, {@link StorageUploadSession})`.
         * @returns {void}
         *
         * @example
         * driver.createUpload({ expectedSize: 4294967296, originalName: 'talk.mp4' },
         *     function (err, session) {
         *         if (err) { return next(err); }
         *         res.setHeader('x-upload-id', session.uploadId);
         *     });
         */
        createUpload: function(meta, fn) {
            if ( typeof meta === 'function' ) { fn = meta; meta = {}; }
            meta = meta || {};
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] createUpload() requires a callback');
            }
            if ( !Number.isInteger(meta.expectedSize) || meta.expectedSize <= 0 ) {
                return fn(new Error('[storage:' + name + '] createUpload() needs `expectedSize`, a positive integer byte count (got: ' + JSON.stringify(meta.expectedSize) + ') — a resumable upload of unknown total size is not supported; use put() for that'));
            }
            if ( meta.expectedSize > max ) {
                return fn(new Error('[storage:' + name + '] expectedSize ' + meta.expectedSize + ' exceeds maxObjectSize (' + max + ' bytes) — refused before any bytes were transferred'));
            }

            var now = Date.now();
            var id  = util.ulid(now);
            var ext = util.sanitiseExtension(meta.originalName);
            // ONE ulid names the session AND the asset it becomes: an
            // operational convenience (the session dir and the asset dir share
            // a name in the same root), never something a caller may rely on —
            // both values stay opaque.
            var manifest = {
                key          : 'assets/' + id + '/' + ORIGINAL + ext,
                expectedSize : meta.expectedSize,
                originalName : ( typeof meta.originalName === 'string' ) ? meta.originalName : null,
                contentType  : ( typeof meta.contentType === 'string' ) ? meta.contentType : null,
                createdAt    : now,
                chunkSize    : chunkSize
            };
            var dir     = nodePath.join(uploadsD, id);
            var metaTmp = nodePath.join(dir, META_FILE + '.tmp');

            try {
                fs.mkdirSync(dir, { recursive: true });
                // The assembling file exists from the start, so `mtime(data)`
                // is a valid liveness signal for the sweep from the first
                // moment, and so a positional write can open it 'r+'.
                fs.closeSync(fs.openSync(nodePath.join(dir, DATA_FILE), 'w'));
                // temp+rename: a crash mid-write can only leave the manifest
                // ABSENT, never truncated, which is what makes "missing or
                // unparseable ⇒ fail loudly" a safe rule rather than a trap.
                fs.writeFileSync(metaTmp, JSON.stringify(manifest));
                if ( fsyncOn ) { fsyncFile(metaTmp); }
                fs.renameSync(metaTmp, nodePath.join(dir, META_FILE));
            } catch (err) {
                dropSession(dir);
                return fn(err);
            }

            fn(null, { uploadId: id, chunkSize: chunkSize, expectedSize: meta.expectedSize });
        },

        /**
         * Write one segment of a resumable upload at `offset`.
         *
         * Segments may arrive OUT OF ORDER and in parallel — the bytes are
         * written positionally into the session's `data` file, so no assembly
         * pass is needed at finalise (measured: a segment-per-file layout costs
         * ~1.9 s/GB of extra concatenation I/O at finalise; this costs ~4 ms).
         * Re-sending a range that already landed is idempotent, and re-sends
         * may overlap freely.
         *
         * A segment whose source ends early is NOT an error: the marker
         * records the RECEIVED length only, so the coverage union stays exact
         * and the client re-sends the remainder. A segment that would run past
         * `expectedSize` IS an error — that is where a lying `expectedSize` is
         * actually stopped, since the declared value is only advisory.
         *
         * Durability order is load-bearing: the data is fsynced BEFORE the
         * marker is created, so a surviving marker implies durable bytes. The
         * marker's own durability is deliberately not guaranteed — a lost
         * marker beside present bytes costs a re-send, which is the safe
         * direction.
         *
         * @param {string}   uploadId - The session id from `createUpload`.
         * @param {number}   offset   - Byte offset this segment starts at; integer >= 0.
         * @param {object}   stream   - Any readable stream carrying the segment's bytes.
         * @param {function} fn       - `fn(err, {offset, length, received})` — `length` is what
         *                              THIS call made durable, `received` the session's total
         *                              covered bytes afterwards.
         * @returns {void}
         *
         * @example
         * driver.writeSegment(uploadId, 8388608, req, function (err, r) {
         *     if (err) { return next(err); }
         *     res.setHeader('x-received', r.received);
         * });
         */
        writeSegment: function(uploadId, offset, stream, fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] writeSegment() requires a callback');
            }
            if ( !stream || typeof stream.pipe !== 'function' ) {
                return fn(new Error('[storage:' + name + '] writeSegment() requires a readable stream'));
            }
            var s = resolveSession(uploadId);
            if ( s.error ) { return fn(s.error); }
            if ( !Number.isInteger(offset) || offset < 0 ) {
                return fn(new Error('[storage:' + name + '] writeSegment(): offset must be an integer >= 0 (got: ' + JSON.stringify(offset) + ')'));
            }
            var man = readManifest(s.dir);
            if ( man.error ) { return fn(man.error); }
            if ( offset >= man.meta.expectedSize ) {
                return fn(new Error('[storage:' + name + '] writeSegment(): offset ' + offset + ' is at or beyond the declared size (' + man.meta.expectedSize + ') for upload `' + uploadId + '`'));
            }

            var dataPath  = nodePath.join(s.dir, DATA_FILE);
            var remaining = man.meta.expectedSize - offset;
            var settled   = false;
            var written   = 0;

            // 'r+' + `start` writes IN PLACE at the offset: no truncation, no
            // append, and the holes a not-yet-written range leaves read back
            // as zeros — which is exactly why finalise verifies coverage
            // rather than trusting the file's size.
            var ws = fs.createWriteStream(dataPath, {
                flags         : 'r+',
                start         : offset,
                highWaterMark : chunkSize || undefined
            });

            var onError = function(err) {
                if (settled) return;
                settled = true;
                try { stream.destroy(); } catch (_e) {}
                try { ws.destroy(); } catch (_e) {}
                // The session is NOT dropped: partial bytes with no marker are
                // invisible to the coverage check, so the client simply
                // re-sends this range.
                fn(( err instanceof Error ) ? err : new Error(String(err)));
            };

            // #B143 — armed at creation on both streams.
            ws.on('error', onError);
            stream.on('error', onError);

            ws.on('close', function() {
                if (settled) return;
                settled = true;
                try {
                    if ( written > 0 ) {
                        // data first, marker second — the whole durability
                        // contract of a resumable upload is in this order.
                        if ( fsyncOn ) { fsyncFile(dataPath); }
                        fs.closeSync(fs.openSync(nodePath.join(s.dir, offset + '-' + written + '.ok'), 'w'));
                    }
                } catch (err) {
                    return fn(err);
                }
                fn(null, {
                    offset   : offset,
                    length   : written,
                    received : coveredBytes(readSpans(s.dir))
                });
            });

            stream.on('data', function(chunk) {
                if (settled) return;
                written += chunk.length;
                if ( written > remaining ) {
                    return onError(new Error('[storage:' + name + '] writeSegment(): the segment at offset ' + offset + ' runs past the declared size (' + man.meta.expectedSize + ' bytes) for upload `' + uploadId + '` — refused'));
                }
            });

            stream.pipe(ws);
        },

        /**
         * The state of a resumable upload — what landed, what is missing, and
         * whether `finalize()` would succeed.
         *
         * The resumable twin of `stat()`, and not optional: resuming is
         * impossible unless a client can learn what already arrived. Read
         * straight from the session's markers, so it is accurate across a
         * process restart and needs no in-memory session table.
         *
         * @param {string}   uploadId - The session id from `createUpload`.
         * @param {function} fn       - `fn(err, {@link StorageUploadState})`.
         * @returns {void}
         *
         * @example
         * driver.statUpload(uploadId, function (err, st) {
         *     if (err) { return self.throwError(404); }
         *     if (st.complete) { return driver.finalize(uploadId, done); }
         *     res.json({ missing: st.missing });   // tell the client what to re-send
         * });
         */
        statUpload: function(uploadId, fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] statUpload() requires a callback');
            }
            var s = resolveSession(uploadId);
            if ( s.error ) { return fn(s.error); }
            var man = readManifest(s.dir);
            if ( man.error ) { return fn(man.error); }

            var spans   = readSpans(s.dir);
            var missing = missingSpans(spans, man.meta.expectedSize);
            fn(null, {
                expectedSize : man.meta.expectedSize,
                contentType  : man.meta.contentType,
                originalName : man.meta.originalName,
                createdAt    : man.meta.createdAt,
                received     : spans,
                missing      : missing,
                complete     : ( missing.length === 0 )
            });
        },

        /**
         * Publish a completed resumable upload and return its opaque key.
         *
         * **Coverage is verified as an INTERVAL UNION** — the markers are
         * merged and must form exactly one span equal to `[0, expectedSize)`.
         * Summing their lengths would not do: markers `0–8MB` and `4–12MB` sum
         * to 16MB with `12–16MB` uncovered, and because a hole reads back as
         * ZEROS a sum-based check would publish a plausible, silently
         * zero-filled object. A gap is a REAL error and the session is
         * PRESERVED so the client can complete it — never a silent publish.
         *
         * **Bytes are published BEFORE the metadata row.** The inverse
         * ordering would manufacture rows without files, which the `cas`
         * strategy's own verify classifies as loss evidence and never
         * auto-fixes. This ordering's residue is the benign kind: an object
         * whose row write failed is still readable by key (`get()` falls
         * through to the file), merely missing `originalName`/`contentType`.
         *
         * **Idempotent, with a heal path.** If the final path already exists
         * this call skips assembly, (re)writes the row and cleans the session
         * — so a `finalize` that published the bytes and then failed on the
         * row is completed by simply retrying it.
         *
         * `writeSegment` must not run concurrently with `finalize` on the same
         * session — that is a CLIENT contract, single-actor-per-finalise. The
         * pre-rename size check below is its cheap detection: bytes past the
         * declared size are truncated away, and bytes MISSING under a full set
         * of markers refuse the publish outright.
         *
         * @param {string}   uploadId - The session id from `createUpload`.
         * @param {function} fn       - `fn(err, {key, size, contentType})` — the same shape
         *                              `put()` returns.
         * @returns {void}
         *
         * @example
         * driver.finalize(uploadId, function (err, res) {
         *     if (err) { return next(err); }   // a coverage gap keeps the session alive
         *     record.assetKey = res.key;
         * });
         */
        finalize: function(uploadId, fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] finalize() requires a callback');
            }
            var s = resolveSession(uploadId);
            if ( s.error ) { return fn(s.error); }
            var man = readManifest(s.dir);
            if ( man.error ) { return fn(man.error); }

            var meta     = man.meta;
            var key      = meta.key;
            var r        = resolvePath(key);
            if ( r.error ) { return fn(r.error); }
            var final    = r.path;
            var dataPath = nodePath.join(s.dir, DATA_FILE);

            /**
             * Write the metadata row and, on success, drop the session. On
             * failure the session is KEPT: the bytes are already published, so
             * a retry takes the heal path above and completes the row.
             *
             * @inner
             * @param {number} size - The published object's size in bytes.
             * @returns {void}
             */
            var indexAndFinish = function(size) {
                metaStore.set(key, {
                    originalName : meta.originalName,
                    contentType  : meta.contentType,
                    size         : size,
                    createdAt    : ( typeof meta.createdAt === 'number' ) ? meta.createdAt : Date.now()
                }, function(metaErr) {
                    if (metaErr) { return fn(metaErr); }
                    dropSession(s.dir);
                    fn(null, { key: key, size: size, contentType: meta.contentType });
                });
            };

            // Heal path: the bytes are already where they belong, so this is a
            // retry of a finalise whose row write failed (or a duplicate call).
            if ( fs.existsSync(final) ) {
                var healSize;
                try {
                    healSize = fs.statSync(final).size;
                } catch (err) {
                    return fn(err);
                }
                return indexAndFinish(healSize);
            }

            var spans   = readSpans(s.dir);
            var missing = missingSpans(spans, meta.expectedSize);
            if ( missing.length ) {
                return fn(new Error('[storage:' + name + '] upload `' + uploadId + '` is incomplete — '
                    + missing.length + ' range(s) missing, ' + coveredBytes(missing) + ' of '
                    + meta.expectedSize + ' bytes (first gap at offset ' + missing[0].offset + ', '
                    + missing[0].length + ' bytes). The session is preserved; send the missing ranges and finalise again.'));
            }

            var size;
            try {
                size = fs.statSync(dataPath).size;
                if ( size < meta.expectedSize ) {
                    // Markers claim coverage the bytes do not back — the one
                    // shape that would publish zeros with a full marker set.
                    // Refuse and preserve; nothing here can safely repair it.
                    return fn(new Error('[storage:' + name + '] upload `' + uploadId + '` claims full coverage but its assembling file is only '
                        + size + ' of ' + meta.expectedSize + ' bytes — refusing to publish a short object. The session is preserved.'));
                }
                if ( size > meta.expectedSize ) {
                    // Unreachable through this API (every segment is capped),
                    // so this is external tampering or a client-contract
                    // violation. Coverage proves [0, expectedSize) is durable;
                    // drop whatever is past the declared end.
                    fs.truncateSync(dataPath, meta.expectedSize);
                    size = meta.expectedSize;
                }
                if ( fsyncOn ) { fsyncFile(dataPath); }
                fs.mkdirSync(nodePath.dirname(final), { recursive: true });
                fs.renameSync(dataPath, final);
                if ( fsyncOn ) { fsyncDirBestEffort(nodePath.dirname(final)); }
            } catch (err) {
                return fn(err);
            }

            indexAndFinish(size);
        },

        /**
         * Discard a resumable upload and everything it accumulated.
         *
         * Idempotent: aborting an unknown or already-aborted session answers
         * `{aborted: false}` rather than erroring — the caller asked for the
         * session to be gone, and it is. An invalid id is still refused, since
         * that is a caller bug rather than a state.
         *
         * @param {string}   uploadId - The session id from `createUpload`.
         * @param {function} [fn]     - `fn(err, {aborted})`.
         * @returns {void}
         *
         * @example
         * driver.abortUpload(uploadId, function (err, r) {
         *     // r.aborted === false when it was already gone
         * });
         */
        abortUpload: function(uploadId, fn) {
            if ( typeof fn !== 'function' ) { fn = function() {}; }
            var s = resolveSession(uploadId);
            if ( s.error ) { return fn(s.error); }
            var existed = fs.existsSync(s.dir);
            dropSession(s.dir);
            fn(null, { aborted: existed });
        },

        /**
         * Open a readable stream for `key`.
         *
         * Errors (rather than yielding `null`) on an unknown key: a caller
         * asking for bytes has no use for a null stream, and the existence
         * question belongs to `stat()`.
         *
         * @param {string}   key - The opaque storage key.
         * @param {function} fn  - `fn(err, stream)`.
         * @returns {void}
         *
         * @example
         * driver.get(key, function (err, stream) {
         *     if (err) { return self.throwError(404); }
         *     stream.pipe(res);
         * });
         */
        get: function(key, fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] get() requires a callback');
            }
            var r = resolvePath(key);
            if ( r.error ) { return fn(r.error); }
            if ( !fs.existsSync(r.path) ) {
                return fn(util.codedError('STORAGE_NO_OBJECT', '[storage:' + name + '] no object for key `' + key + '`'));
            }
            var rs = fs.createReadStream(r.path, { highWaterMark: chunkSize || undefined });
            // Armed before the caller can touch it (#B143) — an fs error after
            // handoff is the caller's, but one raised during open is ours.
            var handed = false;
            rs.on('error', function(err) {
                if (handed) return;
                handed = true;
                fn(err);
            });
            rs.on('open', function() {
                if (handed) return;
                handed = true;
                fn(null, rs);
            });
        },

        /**
         * Byte-range read — the driver half of HTTP Range serving, and the
         * verb this strategy exists to feed.
         *
         * `end` is INCLUSIVE, matching both the HTTP `Range` header and
         * `fs.createReadStream({start, end})`, so no arithmetic happens at the
         * boundary between them. An `end` past the last byte is CLAMPED rather
         * than refused (RFC 9110: a range whose start is satisfiable is
         * satisfiable); only a `start` at or beyond the object's size is
         * unsatisfiable, and that is the caller's 416.
         *
         * The framework consumes this verb through the controller's
         * `serveFromStorage()` facade, which answers 206/416 with
         * `Accept-Ranges`/`Content-Range` on both engines, gated on
         * `capabilities.ranges`.
         *
         * @param {string}   key   - The opaque storage key.
         * @param {number}   start - First byte offset, inclusive; integer >= 0.
         * @param {number}   end   - Last byte offset, INCLUSIVE; integer >= start.
         * @param {function} fn    - `fn(err, stream)`.
         * @returns {void}
         *
         * @example
         * // Serving `Range: bytes=0-1023`
         * driver.getRange(key, 0, 1023, function (err, stream) {
         *     if (err) { return self.throwError(416); }
         *     stream.pipe(res);
         * });
         */
        getRange: function(key, start, end, fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] getRange() requires a callback');
            }
            if ( !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start ) {
                return fn(util.codedError('STORAGE_INVALID_RANGE', '[storage:' + name + '] getRange(): invalid range [' + start + ', ' + end + '] — both bounds must be integers with 0 <= start <= end'));
            }
            var r = resolvePath(key);
            if ( r.error ) { return fn(r.error); }
            if ( !fs.existsSync(r.path) ) {
                return fn(util.codedError('STORAGE_NO_OBJECT', '[storage:' + name + '] no object for key `' + key + '`'));
            }
            var size = fs.statSync(r.path).size;
            if ( start >= size ) {
                return fn(util.codedError('STORAGE_RANGE_UNSATISFIABLE', '[storage:' + name + '] getRange(): start ' + start + ' is beyond the object size (' + size + ') for key `' + key + '`'));
            }
            var rs = fs.createReadStream(r.path, { start: start, end: Math.min(end, size - 1) });
            var handed = false;
            rs.on('error', function(err) {
                if (handed) return;
                handed = true;
                fn(err);
            });
            rs.on('open', function() {
                if (handed) return;
                handed = true;
                fn(null, rs);
            });
        },

        /**
         * Metadata for `key`.
         *
         * @param {string}   key - The opaque storage key.
         * @param {function} fn  - `fn(err, meta|null)`; `null` when the key is unknown.
         * @returns {void}
         *
         * @example
         * driver.stat(key, function (err, meta) {
         *     if (!meta) { return self.throwError(404); }
         *     res.setHeader('Content-Type', meta.contentType);
         * });
         */
        stat: function(key, fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] stat() requires a callback');
            }
            var r = resolvePath(key);
            if ( r.error ) { return fn(r.error); }
            metaStore.get(key, function(err, m) {
                if (err) { return fn(err); }
                if (!m) { return fn(null, null); }
                fn(null, {
                    originalName : m.originalName,
                    contentType  : m.contentType,
                    size         : m.size,
                    createdAt    : m.createdAt
                });
            });
        },

        /**
         * Delete the object and its metadata row.
         *
         * The asset's own directory is removed too when nothing else is left
         * in it — which is the operational half of the per-asset layout, and
         * why a future rendition sitting beside `original` correctly keeps the
         * directory alive.
         *
         * @param {string}   key  - The opaque storage key.
         * @param {function} [fn] - `fn(err, existed)`.
         * @returns {void}
         */
        release: function(key, fn) {
            if ( typeof fn !== 'function' ) { fn = function() {}; }
            var r = resolvePath(key);
            if ( r.error ) { return fn(r.error); }

            var existed = false;
            try {
                if ( fs.existsSync(r.path) ) {
                    fs.unlinkSync(r.path);
                    existed = true;
                }
            } catch (err) {
                // ENOENT means a concurrent release won the race, which is the
                // outcome the caller asked for; anything else is a real failure.
                if ( err.code !== 'ENOENT' ) { return fn(err); }
            }
            // Only succeeds while the asset directory is empty — a rendition
            // beside `original` keeps it, which is the point of the layout.
            try { fs.rmdirSync(nodePath.dirname(r.path)); } catch (e) { /* not empty, or gone */ }

            metaStore.remove(key, function(metaErr, metaExisted) {
                if (metaErr) { return fn(metaErr); }
                fn(null, existed || !!metaExisted);
            });
        },

        /**
         * How to serve `key` — always `{kind:'path'}` here: a `stream` driver
         * never inlines, and `'url'` arrives with the s3 adapter. Callers must
         * still branch on `kind` rather than assume a path is available,
         * because the driver behind a key is a configuration choice.
         *
         * @param {string}   key - The opaque storage key.
         * @param {function} fn  - `fn(err, {kind: 'path', path: string})`.
         * @returns {void}
         *
         * @example
         * driver.resolve(key, function (err, r) {
         *     if (err) { return next(err); }
         *     if (r.kind === 'path') { return res.sendFile(r.path); }
         * });
         */
        resolve: function(key, opts, fn) {
            // optional middle `opts` — offload response overrides, consumed
            // by offload-capable adapters (`s3`); accepted and IGNORED here
            // so one facade call site serves every driver.
            if ( typeof opts === 'function' ) { fn = opts; }
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] resolve() requires a callback');
            }
            var r = resolvePath(key);
            if ( r.error ) { return fn(r.error); }
            if ( !fs.existsSync(r.path) ) {
                return fn(util.codedError('STORAGE_NO_OBJECT', '[storage:' + name + '] no object for key `' + key + '`'));
            }
            fn(null, { kind: 'path', path: r.path });
        },

        /**
         * Driver-level statistics for the operator surface (`storage:stats`
         * and `GET /_gina/storage/stats`): the driver's identity — strategy,
         * root, capabilities — plus the metadata store's aggregate counts.
         *
         * The store half is OPTIONAL seam surface: a store lacking `stats()`
         * reports `store: null` ("store reports no stats") rather than
         * erroring, so a connector-backed driver degrades instead of failing
         * the whole stats sweep. In-flight upload sessions are NOT counted —
         * they hold no rows, and reporting them is deferred with the rest of
         * the stream maintenance surface.
         *
         * @param {function} fn - `fn(err, {name, strategy, root, capabilities, store})` —
         *                        `store` is `{objects, refcounted, zeroRefPending, inline,
         *                        bytes}`, or `null` when the store reports no stats.
         * @returns {void}
         *
         * @example
         * driver.stats(function (err, s) {
         *     if (err) { return next(err); }
         *     // s.store.objects, s.store.bytes …
         * });
         */
        stats: function(fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] stats() requires a callback');
            }
            var view = {
                name         : name,
                strategy     : conf.strategy,
                root         : root,
                capabilities : capabilities,
                store        : null
            };
            if ( typeof metaStore.stats !== 'function' ) {
                return fn(null, view);
            }
            metaStore.stats(function(err, s) {
                if (err) { return fn(err); }
                view.store = s;
                fn(null, view);
            });
        },

        /**
         * What this driver can do. `resumable` is the stream flag — it is what
         * gates the five session verbs. `inline` and `dedup` are `false` BY
         * DESIGN here, not pending: a multi-gigabyte strategy does not inline,
         * and the write path deliberately does not hash.
         *
         * `offload` is `false` and measured, not assumed: no X-Accel /
         * X-Sendfile handling exists anywhere in either engine today, so a
         * caller must stream bytes itself.
         *
         * @type {{offload: boolean, ranges: boolean, dedup: boolean, resumable: boolean, inline: boolean}}
         */
        capabilities: capabilities,

        /**
         * Stop the session sweep timer and release the metadata handle.
         * Teardown and tests only — the runtime never calls it.
         *
         * @returns {void}
         */
        close: function() {
            if ( sweepTimer ) {
                clearInterval(sweepTimer);
                sweepTimer = null;
            }
            try { metaStore.close(); } catch (e) { /* already closed */ }
        },

        // test seam — the sweep has no operator door in this slice (the
        // `storage:gc` family stays cas-only), so this is what drives it
        // deterministically instead of waiting on the interval.
        _sweepAbandoned: sweepAbandoned
    };
};
