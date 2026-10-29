/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module lib/storage/local
 * @description The `local` adapter crossed with the `sharded` strategy — bytes
 * on the local filesystem under a per-driver root, keys laid out as
 * `YYYY/MM/DD/<ulid><ext>`. With size tiering active (`inlineThreshold` > 0,
 * the default), objects strictly under the threshold never touch the
 * filesystem at all: their bytes live inline in the metadata store, under the
 * SAME key shape, and `resolve()` reports them as `{kind:'inline'}`.
 *
 * **Why a date prefix.** Directories with millions of sibling entries are slow
 * to list and unpleasant to operate; a day-level prefix keeps each directory
 * small, makes "everything from last Tuesday" a directory walk, and — because
 * a ULID sorts by creation time — keeps entries within a day ordered too.
 *
 * **Why the extension is the only untrusted byte that reaches disk.** The
 * client filename is stored verbatim in the metadata row, never in the path.
 * Only a hard-whitelisted extension is appended, purely so an operator
 * browsing the tree can tell a PDF from a PNG.
 *
 * **The write path is the #B223 discipline generalised.** Content is streamed
 * to a temp file inside the driver root and published with `rename(2)`, so a
 * reader never observes a partial object and a crashed write leaves nothing
 * visible. The temp lives under the SAME root (not the global upload tmp dir)
 * because `rename(2)` fails with `EXDEV` across filesystems, and gina's tmp and
 * asset trees are routinely on different ones. Error listeners are armed AT
 * STREAM CREATION, never later (#B143): an unlistened stream `'error'` takes
 * the whole bundle process down.
 *
 * @example
 * var driver = createLocalDriver('assets',
 *     { root: '/var/data/assets', strategy: 'sharded', maxObjectSize: 52428800 },
 *     metaStore);
 * driver.put(req, { originalName: 'a.pdf' }, function (err, res) { });
 */

var fs       = require('fs');
var nodePath = require('path');
var Readable = require('stream').Readable;

var util = require('./util');

/**
 * Directory holding in-flight temp files, relative to the driver root.
 *
 * @inner
 * @constant
 * @type {string}
 */
var TMP_DIR = '.tmp';

/**
 * A stored object, as returned by `put()`.
 *
 * @typedef  {Object} StoragePutResult
 * @property {string}  key         - The opaque storage key. Never parse or compose it.
 * @property {number}  size        - Object size in bytes, measured from the published file
 *                                   on disk — never taken from the client.
 * @property {?string} contentType - The client-supplied MIME type, echoed back untrusted.
 */

/**
 * The storage contract (v0), callback-shaped throughout — matching every other
 * seam in the tree (job-store, session-store, the upload mover) rather than
 * introducing a promise style the surrounding code does not use.
 *
 * Verbs arrive WITH the strategy that needs them. `getRange` (Range serving)
 * has LANDED on every local strategy — it is contract, not strategy detail, and
 * a Range verb that existed only on `stream` would serve nobody, since `sharded`
 * is the zero-config default. The five resumable verbs (`createUpload` /
 * `writeSegment` / `statUpload` / `finalize` / `abortUpload`) are `stream`-only
 * and `findByDigest` (content-addressed dedup) `cas`-only; both stay
 * capability-gated (`capabilities.resumable`, `capabilities.dedup`).
 *
 * `capabilities.ranges` is consumed by the framework itself: the controller's
 * `serveFromStorage()` facade answers 206/416/304 with `Accept-Ranges`/
 * `Content-Range` on both engines, gated on this flag — an adapter that
 * cannot serve ranges is transparently answered with the full 200.
 *
 * @typedef  {Object} StorageDriver
 * @property {function(object, object, function): void} put          - Store a readable stream; `fn(err, {@link StoragePutResult})`.
 * @property {function(string, function): void}         get          - Open a readable stream for `key`; `fn(err, stream)`. Errors on an unknown key — see `stat` for the existence question. Read-verb errors carry a machine `code` (`STORAGE_NO_OBJECT` / `STORAGE_RANGE_UNSATISFIABLE` / `STORAGE_INVALID_RANGE` — see `util.codedError`) so an HTTP serving layer maps 404/416/400 without parsing message text.
 * @property {function(string, number, number, function): void} getRange - Open a readable stream over an INCLUSIVE byte range; `fn(err, stream)`. An over-long `end` is clamped; an unsatisfiable `start` errors (the caller's 416).
 * @property {function(string, function): void}         stat         - Metadata for `key`; `fn(err, meta|null)`. `null` (not an error) when unknown.
 * @property {function(string, function=): void}        release      - Delete object and metadata; `fn(err, existed)`.
 * @property {function(string, ?object, function): void} resolve     - How to serve `key` — `resolve(key[, opts], fn)`; `fn(err, {kind:'path', path} | {kind:'inline'} | {kind:'url', url, expiresAt})`. `opts` carries offload response overrides (`contentType`/`download`/`filename`/`cacheControl` → the provider's signed `response-*` params); local strategies accept and IGNORE it, so one facade call site serves every driver.
 * @property {function(): void}                         close        - Release the metadata handle. Teardown/tests only.
 * @property {object}                                   capabilities - What this driver can do; every consumer must branch on it rather than assume.
 * @property {function(function): void}                 [stats]      - Driver statistics for the operator surface (`storage:stats`); `fn(err, {name, strategy, root, capabilities, store})` — `store` is the metadata store's aggregate counts, or `null` when the store reports no stats. Present on both local strategies.
 * @property {function((object|function)=, function=): void} [sweepNow] - cas-only: run one GC pass now; `{dryRun: true}` lists collectable keys without touching anything. `fn(err, {collected, drained}|{collectable, drained})`. A strategy without a sweep simply lacks the verb — callers branch, never assume. NB `stream` reclaims abandoned upload sessions on its own schedule but exposes no operator door in v1, so it correctly lacks this verb.
 * @property {function(object, function): void}         [verify]     - cas-only: files↔rows consistency scan (age-gated); see `src/local-cas`.
 * @property {function(object, function): void}         [createUpload] - stream-only: open a resumable upload session; `fn(err, {uploadId, chunkSize, expectedSize})`. `expectedSize` is REQUIRED — see `src/local-stream`.
 * @property {function(string, number, object, function): void} [writeSegment] - stream-only: write one segment at a byte offset, out of order and idempotently; `fn(err, {offset, length, received})`.
 * @property {function(string, function): void}         [statUpload]   - stream-only: what landed and what is missing; `fn(err, {expectedSize, received, missing, complete, …})`. The resumable twin of `stat()`.
 * @property {function(string, function): void}         [finalize]     - stream-only: verify coverage as an interval union, publish, index; `fn(err, {key, size, contentType})`. Idempotent, with a heal path.
 * @property {function(string, function=): void}        [abortUpload]  - stream-only: discard a session; `fn(err, {aborted})`. Idempotent.
 */

/**
 * Build a `local` filesystem driver.
 *
 * @param {string}           name              - Driver name, used only in error messages.
 * @param {object}           conf              - Resolved driver configuration.
 * @param {string}           conf.root         - Absolute driver root. Validated at boot to be
 *                                               absolute and outside every web-served tree.
 * @param {string}           conf.strategy     - Key-layout strategy (`sharded`).
 * @param {number}           conf.maxObjectSize - Per-object byte ceiling, already parsed.
 * @param {number}           [conf.inlineThreshold] - Size-tiering threshold in bytes, already
 *                                               parsed (defaults resolve in `start()`). Objects
 *                                               strictly under it are stored inline in the
 *                                               metadata store; `0`/absent disables tiering.
 * @param {number}           [conf.sweepGrace] - How old a temp file must be before the
 *                                               build-time orphan sweep reclaims it, in ms
 *                                               (defaults resolve in `start()`). Same key,
 *                                               default and meaning as cas's; `sharded` has no
 *                                               periodic sweep, so this gates the build pass
 *                                               alone (#B349).
 * @param {StorageMetaStore} metaStore         - Metadata backend (embedded SQLite by default).
 * @returns {StorageDriver} A ready driver.
 *
 * @example
 * var driver = createLocalDriver('assets', conf, metaStore);
 */
module.exports = function createLocalDriver(name, conf, metaStore) {

    var root = conf.root;
    var max  = conf.maxObjectSize;
    // Size tiering: objects strictly UNDER this many bytes are stored inline
    // in the metadata store; 0 (or absent — defaults resolve in start(), the
    // maxObjectSize pattern) means every object goes to the file tree.
    var inlineThreshold = ( typeof conf.inlineThreshold === 'number' && conf.inlineThreshold > 0 )
        ? conf.inlineThreshold
        : 0;
    var sweepGraceMs = ( typeof conf.sweepGrace === 'number' && conf.sweepGrace > 0 )
        ? conf.sweepGrace
        : 0;

    // #B349 — build-time temp-orphan sweep, age-gated. A put() whose PROCESS
    // died leaves its temp behind, and until now nothing on `sharded` ever
    // removed it: cas has this same pass and `stream` has its own, so sharded
    // was the one strategy where the leak was permanent. Build time is the
    // right and only trigger — a restart is the earliest moment the previous
    // process is provably gone — and the age gate is what keeps a SIBLING
    // process's in-flight write safe on a shared root, which is precisely the
    // shape a connector-backed store exists to support. Never throws: an
    // unreadable temp dir is the next put()'s problem to report properly, and
    // a sweep that took the build down would be a worse failure than the leak
    // it prevents.
    if ( sweepGraceMs > 0 ) {
        try {
            var _tmpD = nodePath.join(root, TMP_DIR);
            if ( fs.existsSync(_tmpD) ) {
                var _cutoff  = Date.now() - sweepGraceMs;
                var _entries = fs.readdirSync(_tmpD);
                for (var _t = 0; _t < _entries.length; _t++) {
                    var _tp = nodePath.join(_tmpD, _entries[_t]);
                    try {
                        if ( fs.statSync(_tp).mtimeMs < _cutoff ) {
                            fs.unlinkSync(_tp);
                        }
                    } catch (_e) { /* raced or unreadable — leave it */ }
                }
            }
        } catch (_e) { /* never blocks the build */ }
    }

    /**
     * Resolve a caller-supplied key to a confined absolute path.
     *
     * ONE shared implementation for every strategy — see
     * {@link module:lib/storage/util.makeResolvePath} for the three guards
     * and why their ORDER is load-bearing (a security boundary must not
     * exist in two copies that can drift).
     *
     * @inner
     * @type {function(string): {path: ?string, error: ?Error}}
     */
    var resolvePath = util.makeResolvePath(name, root);

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
        resumable : false,
        inline    : ( inlineThreshold > 0 )
    };

    return {

        /**
         * Store a readable stream and return its opaque key.
         *
         * With size tiering active, the head of the stream is buffered in
         * memory (bounded by the threshold plus one chunk): a stream that ends
         * strictly under `inlineThreshold` publishes as ONE metadata-store
         * transaction — no temp file, no directories, no filesystem at all —
         * while a stream that reaches the threshold crosses over to the file
         * path below, byte-order-exact.
         *
         * The file path streams to a temp file inside the driver root, then
         * publishes with `rename(2)`. On ANY failure — a source error, a write
         * error, or the size cap being exceeded mid-stream — the temp file is
         * removed and the REAL error is reported: never a fabricated one (the
         * #B223 lesson, where every move failure surfaced as a misleading
         * empty-upload message and masked ENOSPC/EACCES entirely).
         *
         * The reported size is measured from the PUBLISHED file on disk, not
         * from a byte counter read at an event that may still have data queued
         * behind it (the #B142 lesson) and never from the client. An inline
         * object's size is its buffer length — the same bytes the store
         * persists in the same transaction.
         *
         * @param {object}   stream               - Any readable stream.
         * @param {object}   [meta]               - Client-supplied, untrusted.
         * @param {string}   [meta.originalName]  - Filename; stored verbatim in metadata,
         *                                          and the only source of the path extension.
         * @param {string}   [meta.contentType]   - MIME type; stored verbatim.
         * @param {function} fn                   - `fn(err, {@link StoragePutResult})`.
         * @returns {void}
         *
         * @example
         * driver.put(req, { originalName: 'invoice.pdf' }, function (err, res) {
         *     if (err) { return next(err); }
         *     record.storageKey = res.key;   // opaque — store it, never parse it
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

            var now  = new Date();
            var id   = util.ulid(now.getTime());
            var ext  = util.sanitiseExtension(meta.originalName);
            var day  = now.getUTCFullYear()
                + '/' + ('0' + (now.getUTCMonth() + 1)).slice(-2)
                + '/' + ('0' + now.getUTCDate()).slice(-2);
            var key   = day + '/' + id + ext;
            var final = nodePath.join(root, key);
            var tmpD  = nodePath.join(root, TMP_DIR);
            var tmp   = nodePath.join(tmpD, id + '.tmp');

            var settled = false;
            var written = 0;
            var mkdired = false;
            var spilled = false;
            var ws      = null;
            var head    = [];

            var mkdirs = function() {
                fs.mkdirSync(nodePath.dirname(final), { recursive: true });
                fs.mkdirSync(tmpD, { recursive: true });
                mkdired = true;
            };

            // Tiering off: today's exact sequence — directories up front, a
            // plain early return on failure, then pipe from the first byte.
            if ( inlineThreshold === 0 ) {
                try {
                    mkdirs();
                } catch (mkErr) {
                    return fn(mkErr);
                }
            }

            /**
             * Abandon the put: tear both streams down, remove the temp, report.
             *
             * #B358 — the unlink WAITS for the write stream to close, and the
             * callback waits with it. `createWriteStream()` opens
             * asynchronously, so an error arriving right after `spill()` — the
             * source failing on the chunk that crossed `inlineThreshold` is the
             * measured case — reaches here while the `open(2)` is still in the
             * threadpool: the temp does not exist YET at this instant but lands
             * a tick later, on the worker thread, with no event-loop turn in
             * between for a synchronous check to see. The previous
             * `existsSync`-gated unlink therefore read false, skipped, and
             * orphaned the temp. A null `ws` means `spill()` never ran and no
             * temp was ever created, so that arm finishes immediately; `force`
             * makes the unlink a no-op there rather than a special case.
             *
             * @inner
             * @param {*} err - The failure to report; wrapped if not an Error.
             * @returns {void}
             */
            var onError = function(err) {
                if (settled) return;
                settled = true;
                head = null;
                try { stream.destroy(); } catch (_e) {}

                var finish = function() {
                    try { fs.rmSync(tmp, { force: true }); } catch (_e) {}
                    fn(( err instanceof Error ) ? err : new Error(String(err)));
                };

                // No ws (never spilled), or one that already emitted 'close' —
                // neither will emit it again, so those arms must not wait.
                if ( !ws || ws.closed || ws.destroyed ) { return finish(); }
                ws.once('close', finish);
                try { ws.destroy(); } catch (_e) { finish(); }
            };

            /**
             * Cross over to the file tree: create the directories (deferred
             * while the object could still land inline — a pure-inline put
             * touches the filesystem not at all), open the temp write stream,
             * flush whatever head was buffered, and hand delivery to pipe().
             *
             * @inner
             * @returns {void}
             */
            var spill = function() {
                spilled = true;
                if ( !mkdired ) {
                    try {
                        mkdirs();
                    } catch (mkErr) {
                        return onError(mkErr);
                    }
                }

                ws = fs.createWriteStream(tmp);

                // #B143 — armed at creation, never in a later handler: Node does not
                // replay 'error' for a listener attached after the fact, and an
                // unlistened stream 'error' becomes an uncaughtException that takes
                // the bundle down. Both streams need their own; `.pipe()` returns the
                // DESTINATION, so a single chained listener would cover only one.
                ws.on('error', onError);

                // 'close' also follows 'error' on an autoDestroyed stream, so the
                // settled latch is what keeps a failed write from publishing.
                ws.on('close', function() {
                    if (settled) return;

                    var size;
                    try {
                        // The published-file size is the honest one: it cannot be
                        // ahead of the bytes actually on disk the way an in-flight
                        // counter can.
                        size = fs.statSync(tmp).size;
                        fs.renameSync(tmp, final);
                    } catch (err) {
                        return onError(err);
                    }

                    settled = true;
                    metaStore.set(key, {
                        originalName : (typeof meta.originalName === 'string') ? meta.originalName : null,
                        contentType  : (typeof meta.contentType === 'string') ? meta.contentType : null,
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
                            contentType : (typeof meta.contentType === 'string') ? meta.contentType : null
                        });
                    });
                });

                // The buffered head is queued before pipe() attaches, and both
                // feed the same write stream FIFO — so the crossing is
                // byte-order-exact. pipe() only forwards chunks emitted AFTER
                // it attaches, and the chunk that crossed the threshold was
                // pushed onto the head inside its own 'data' tick.
                if ( head && head.length ) {
                    ws.write(Buffer.concat(head));
                }
                head = null;
                stream.pipe(ws);
            };

            stream.on('error', onError);

            stream.on('data', function(chunk) {
                if (settled) return;
                written += chunk.length;
                if ( written > max ) {
                    return onError(new Error('[storage:' + name + '] object exceeds maxObjectSize (' + max + ' bytes) — refused'));
                }
                if (spilled) return; // pipe() owns delivery from here
                head.push(chunk);
                // Strictly-under inlines: the moment the running total REACHES
                // the threshold the final size cannot be under it, so cross
                // over — including this chunk, via the head flush.
                if ( written >= inlineThreshold ) {
                    spill();
                }
            });

            stream.on('end', function() {
                if (settled || spilled) return;
                // Inline publish: the object never touched the filesystem —
                // one metadata-store transaction IS the write, so there is
                // nothing to roll back on failure.
                var buf = Buffer.concat(head);
                head = null;
                settled = true;
                metaStore.set(key, {
                    originalName : (typeof meta.originalName === 'string') ? meta.originalName : null,
                    contentType  : (typeof meta.contentType === 'string') ? meta.contentType : null,
                    size         : buf.length,
                    createdAt    : now.getTime(),
                    data         : buf
                }, function(metaErr) {
                    if (metaErr) {
                        return fn(metaErr);
                    }
                    fn(null, {
                        key         : key,
                        size        : buf.length,
                        contentType : (typeof meta.contentType === 'string') ? meta.contentType : null
                    });
                });
            });

            if ( inlineThreshold === 0 ) {
                spill();
            }
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
            // Metadata first: an inline row IS the object, and a row without
            // a payload answers exactly like the pre-tiering store did — so a
            // file-backed (or legacy) key falls through to the identical
            // filesystem path below.
            metaStore.get(key, function(metaErr, m) {
                if (metaErr) { return fn(metaErr); }
                if ( m && m.data != null ) {
                    // NB: the buffer must be wrapped in an array —
                    // Readable.from(buffer) would iterate it as INTEGERS.
                    return fn(null, Readable.from([m.data]));
                }
                if ( !fs.existsSync(r.path) ) {
                    return fn(util.codedError('STORAGE_NO_OBJECT', '[storage:' + name + '] no object for key `' + key + '`'));
                }
                var rs = fs.createReadStream(r.path);
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
            });
        },

        /**
         * Byte-range read — the driver half of HTTP Range serving.
         *
         * `end` is INCLUSIVE, matching both the HTTP `Range` header and
         * `fs.createReadStream({start, end})`, so no arithmetic happens at the
         * boundary between them. An `end` past the last byte is CLAMPED rather
         * than refused (RFC 9110: a range whose start is satisfiable is
         * satisfiable); only a `start` at or beyond the object's size is
         * unsatisfiable, and that is the caller's 416.
         *
         * Both tiers answer: an inline row slices its buffer, a file-backed row
         * gets a positioned read stream. The discriminator is `m.data != null`,
         * exactly as `get()`/`resolve()` use — never the configured threshold,
         * so a threshold change stays retroactively safe here too.
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
            metaStore.get(key, function(metaErr, m) {
                if (metaErr) { return fn(metaErr); }
                if ( m && m.data != null ) {
                    if ( start >= m.data.length ) {
                        return fn(util.codedError('STORAGE_RANGE_UNSATISFIABLE', '[storage:' + name + '] getRange(): start ' + start + ' is beyond the object size (' + m.data.length + ') for key `' + key + '`'));
                    }
                    // subarray() is a VIEW, no copy; the array wrap is the same
                    // load-bearing detail as in get() — Readable.from(buffer)
                    // would iterate the bytes as INTEGERS.
                    return fn(null, Readable.from([ m.data.subarray(start, Math.min(end, m.data.length - 1) + 1) ]));
                }
                if ( !fs.existsSync(r.path) ) {
                    return fn(util.codedError('STORAGE_NO_OBJECT', '[storage:' + name + '] no object for key `' + key + '`'));
                }
                var size = fs.statSync(r.path).size;
                if ( start >= size ) {
                    return fn(util.codedError('STORAGE_RANGE_UNSATISFIABLE', '[storage:' + name + '] getRange(): start ' + start + ' is beyond the object size (' + size + ') for key `' + key + '`'));
                }
                // The clamp is EXPLICITNESS, not necessity: measured, both
                // `createReadStream({end})` and `Buffer.subarray()` already stop
                // at the last byte, so the suite's clamp test passes with or
                // without it. Stated here so the contract does not rest on two
                // different APIs each happening to do the right thing.
                var rs = fs.createReadStream(r.path, { start: start, end: Math.min(end, size - 1) });
                // Armed before the caller can touch it (#B143) — identical
                // handoff discipline to get().
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
                // The payload is not metadata: an inline row's `data` is
                // stripped so stat() keeps its contracted shape — the
                // existence question and the bytes question stay separate
                // verbs (`resolve()` says where the bytes live).
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
         * Handles both tiers with the same code: an inline object has no file
         * (the unlink branch no-ops on a missing path) and its row removal IS
         * the deletion — `existed` comes from whichever side found something.
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
            metaStore.remove(key, function(metaErr, metaExisted) {
                if (metaErr) { return fn(metaErr); }
                fn(null, existed || !!metaExisted);
            });
        },

        /**
         * How to serve `key`.
         *
         * `{kind:'path'}` for a file-backed object; `{kind:'inline'}` for a
         * size-tiered one, whose bytes are reached through `get()` — an inline
         * object has no path to hand to a sendfile/X-Accel offload. `'url'`
         * arrives with the s3 adapter. Callers must branch on `kind` rather
         * than assume a path is always available.
         *
         * @param {string}   key    - The opaque storage key.
         * @param {?object}  [opts] - Offload response overrides — consumed by
         *                            offload-capable adapters (`s3`); accepted
         *                            and IGNORED here.
         * @param {function} fn     - `fn(err, {kind: 'path', path: string} | {kind: 'inline'})`.
         * @returns {void}
         *
         * @example
         * driver.resolve(key, function (err, r) {
         *     if (err) { return next(err); }
         *     if (r.kind === 'path') { return res.sendFile(r.path); }
         *     // 'inline' — stream the bytes yourself
         *     driver.get(key, function (err, stream) { stream.pipe(res); });
         * });
         */
        resolve: function(key, opts, fn) {
            if ( typeof opts === 'function' ) { fn = opts; }
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] resolve() requires a callback');
            }
            var r = resolvePath(key);
            if ( r.error ) { return fn(r.error); }
            metaStore.get(key, function(metaErr, m) {
                if (metaErr) { return fn(metaErr); }
                if ( m && m.data != null ) {
                    return fn(null, { kind: 'inline' });
                }
                if ( !fs.existsSync(r.path) ) {
                    return fn(util.codedError('STORAGE_NO_OBJECT', '[storage:' + name + '] no object for key `' + key + '`'));
                }
                fn(null, { kind: 'path', path: r.path });
            });
        },

        /**
         * Driver-level statistics for the operator surface (`storage:stats`
         * and `GET /_gina/storage/stats`): the driver's identity — strategy,
         * root, capabilities — plus the metadata store's aggregate counts.
         *
         * The store half is OPTIONAL seam surface: a store lacking `stats()`
         * reports `store: null` ("store reports no stats") rather than
         * erroring, so a connector-backed driver degrades instead of failing
         * the whole stats sweep.
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
         * What this driver can do. Consumers branch on these rather than
         * assuming. `inline` is conf-dependent: `true` when size tiering is
         * active (`inlineThreshold` > 0), meaning `resolve()` may answer
         * `{kind:'inline'}`; the rest flip to `true` in later slices.
         *
         * `offload` is `false` and measured, not assumed: no X-Accel /
         * X-Sendfile handling exists anywhere in either engine today, so a
         * caller must stream bytes itself.
         *
         * @type {{offload: boolean, ranges: boolean, dedup: boolean, resumable: boolean, inline: boolean}}
         */
        capabilities: capabilities,

        /**
         * Release the metadata handle. Teardown and tests only — the runtime
         * never calls it.
         *
         * @returns {void}
         */
        close: function() {
            try { metaStore.close(); } catch (e) { /* already closed */ }
        }
    };
};
