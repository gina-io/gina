/**
 * #STO1 — `s3` adapter: object storage on any S3-compatible provider
 * (AWS S3, Scaleway, MinIO, R2, Garage, Ceph RGW…), STORELESS.
 *
 * The provider owns placement AND metadata. There is no metadata store here —
 * no embedded SQLite, no connector rows, no `.driver` stamp: one `PutObject`
 * (or completed multipart) atomically carries the bytes, the Content-Type and
 * the original name (as user-defined object metadata, which S3 documents as
 * IMMUTABLE after upload — exactly this layer's immutable-key contract), and
 * every process that can reach the bucket reads the same truth. That is why
 * this adapter cannot have the drift class `storage:verify` exists to catch,
 * and why the shared-root topology that forces a connector store on the local
 * adapter simply does not arise.
 *
 * The SDK is the CONSUMING PROJECT's dependency, never the framework's — the
 * policy every database connector follows, and the one `schema/settings.json`
 * documents for this adapter. Because lib/storage is framework-independent
 * (no `_()`/`getPath()` globals — test-enforced), the project-module resolver
 * is INJECTED by the caller (`start()`'s `requireProjectModule`, built in
 * gna.js where the globals are legal), and this factory resolves lazily:
 *
 *   - `@aws-sdk/client-s3`            — the client and commands
 *   - `@aws-sdk/lib-storage`          — streaming put of unknown length
 *                                       (single-part vs multipart "under the
 *                                       hood", per its own README)
 *   - `@aws-sdk/s3-request-presigner` — `resolve()`'s presigned URLs
 *
 * A missing package throws AT CONSTRUCTION with an `npm install` hint, which
 * the boot path treats as fatal (main.js's "no safe degraded mode" rationale —
 * silently dropping a configured driver would leave `put()` writing nowhere).
 *
 * Strategy: `sharded` only (defaulted when absent) — on external object
 * storage the layout algorithm collapses to key naming, so this adapter mints
 * the sharded grammar (`YYYY/MM/DD/<ulid><ext>` under the configured
 * `prefix`) and `cas`/`stream` are refused at validation with a message
 * saying why (S3 ETags are not content digests; multipart is the provider's
 * own resumable).
 *
 * Crash residue: the s3 analog of a crashed-put temp file is an INCOMPLETE
 * MULTIPART UPLOAD, and AWS documents that its parts bill storage until the
 * upload is completed or aborted, with no expiry. The build-time sweep below
 * (age-gated past `sweepGrace`, best-effort, never throws — the sharded
 * temp-orphan shape) aborts them; a bucket lifecycle rule
 * (`AbortIncompleteMultipartUpload`) remains worthwhile defense-in-depth for
 * processes that never reboot, and the guide says so.
 *
 * IAM note (measured against the AWS docs): `HeadObject` on a missing key
 * answers **404 only when the credentials hold `s3:ListBucket`; otherwise
 * 403** — under least-privilege credentials without it, `stat()` surfaces a
 * provider AccessDenied instead of the contract's `null`. The minimal policy
 * (documented in the guide): GetObject, PutObject, DeleteObject, ListBucket,
 * ListBucketMultipartUploads, AbortMultipartUpload — bucket/prefix-scoped.
 *
 * S3-COMPATIBLE HONESTY: strong read-after-write consistency (HEAD and LIST
 * included) and the user-metadata semantics above are AWS-DOCUMENTED
 * behaviour; a compatible provider claiming API parity owns its own
 * consistency model. This adapter only uses the core compat surface
 * (Put/Get/Head/Delete/ListObjectsV2/ListMultipartUploads/Abort + SigV4
 * presigning), and the guide states the assumption rather than hiding it.
 *
 * @module lib/storage/s3
 */
var stream    = require('stream');
var Transform = stream.Transform;

var util = require('./util');

/**
 * User-metadata key carrying the URI-encoded original name. The SDK's
 * `Metadata` map serialises each entry as an `x-amz-meta-<key>` header, and
 * S3 stores metadata keys lowercased.
 *
 * The value is URI-ENCODED BY THIS ADAPTER rather than left to the provider:
 * AWS handles non-US-ASCII metadata by RFC 2047-encoding it on the wire —
 * documented AWS behaviour that an S3-compatible provider may not implement —
 * so encoding to plain ASCII ourselves is what keeps the round-trip portable.
 *
 * @inner
 * @constant
 * @type {string}
 */
var META_NAME_KEY = 'gina-name';

/**
 * Byte ceiling for the encoded original-name metadata value. AWS caps ALL
 * user-defined metadata at 2KB total (UTF-8 bytes of every key + value), so
 * one display-only name is kept safely under half of it and TRUNCATED beyond —
 * `originalName` is display metadata, never a path, and losing its tail beats
 * failing the whole put.
 *
 * @inner
 * @constant
 * @type {number}
 */
var META_NAME_MAX = 1024;

/**
 * Page bound for `stats()`'s ListObjectsV2 aggregation — 10 pages of up to
 * 1,000 keys. Beyond it the counts are reported with `truncated: true` rather
 * than walking a multi-million-object bucket on an operator ping (the
 * maintenance surface's bounded-pass precedent).
 *
 * @inner
 * @constant
 * @type {number}
 */
var LIST_PAGE_LIMIT = 10;

/**
 * Validate a caller-supplied key for provider addressing. The same order as
 * `util.makeResolvePath` (reject-hostile-first, then canonical form) minus the
 * filesystem resolution this adapter does not have: no traversal segments, no
 * absolute/backslashed/NUL forms — a hostile key must fail BEFORE it is
 * embedded in a signed URL or a provider request. Messages deliberately do
 * not echo any resolved form.
 *
 * @inner
 * @param {string} name - Driver name, for messages.
 * @param {string} key  - The caller's opaque key.
 * @returns {?Error} `null` when the key is usable.
 */
function guardKey(name, key) {
    if ( typeof(key) != 'string' || key.length === 0 ) {
        return new Error('[storage:' + name + '] a non-empty string key is required (got: ' + JSON.stringify(key) + ')');
    }
    if ( key.indexOf('\0') > -1 || key.indexOf('\\') > -1 || key.charAt(0) === '/' ) {
        return new Error('[storage:' + name + '] key `' + key + '` is not in canonical form');
    }
    var segments = key.split('/');
    for (var i = 0; i < segments.length; i++) {
        if ( segments[i] === '' || segments[i] === '.' || segments[i] === '..' ) {
            return new Error('[storage:' + name + '] key `' + key + '` is not in canonical form');
        }
    }
    return null;
}

/**
 * Map a provider read error onto the layer's coded contract. `NoSuchKey`
 * (GetObject) and `NotFound` (HeadObject's body-less 404) both mean the
 * object is gone → `STORAGE_NO_OBJECT`; the provider's 416/`InvalidRange` →
 * `STORAGE_RANGE_UNSATISFIABLE`. Anything else is RAW-FORWARDED — the typed
 * SDK class is the caller's signal (#B153 lesson: wrapping loses it).
 *
 * @inner
 * @param {string} name - Driver name, for messages.
 * @param {string} key  - The key being read.
 * @param {object} err  - The SDK error.
 * @returns {Error} A coded error, or `err` untouched.
 */
function mapReadError(name, key, err) {
    var status = ( err && err.$metadata && err.$metadata.httpStatusCode ) || 0;
    if ( err && ( err.name === 'NoSuchKey' || err.name === 'NotFound' || status === 404 ) ) {
        return util.codedError('STORAGE_NO_OBJECT', '[storage:' + name + '] no object for key `' + key + '`');
    }
    if ( err && ( err.name === 'InvalidRange' || status === 416 ) ) {
        return util.codedError('STORAGE_RANGE_UNSATISFIABLE', '[storage:' + name + '] getRange(): the requested range is beyond the object size for key `' + key + '`');
    }
    return err;
}

/**
 * Minimal RFC 6266 attachment value for the presigned
 * `response-content-disposition` override. Control characters are stripped
 * (setHeader-injection class — the serving facade strips too; this is the
 * direct-caller defense) and quote/backslash escaped.
 *
 * @inner
 * @param {string} filename - Display filename.
 * @returns {string} The `Content-Disposition` header value.
 */
function formatDisposition(filename) {
    var safe = String(filename)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
    return 'attachment; filename="' + safe + '"';
}

/**
 * Build an `s3` driver.
 *
 * @param {string}  name                    - Driver name (messages, config identity).
 * @param {object}  conf                    - Resolved config (see `resolveDriverConf`).
 * @param {string}  conf.bucket             - Bucket name (validated non-empty).
 * @param {string}  conf.prefix             - Key prefix, `''` or `…/`-terminated (normalised upstream).
 * @param {string}  [conf.region]           - Signing region; upstream defaults `us-east-1` when a
 *                                            custom `endpoint` is set and none was configured.
 * @param {string}  [conf.endpoint]         - S3-compatible endpoint URL (scheme added upstream when missing).
 * @param {boolean} [conf.forcePathStyle]   - Path-style addressing (MinIO et al.).
 * @param {string}  [conf.accessKeyId]      - Static credentials; ABSENT means the SDK default
 * @param {string}  [conf.secretAccessKey]    provider chain (env / shared config / IMDS / IRSA) —
 * @param {string}  [conf.sessionToken]       the container-native path, deliberately first-class.
 * @param {number}  conf.presignExpiry      - Presigned-URL lifetime, ms.
 * @param {number}  conf.sweepGrace         - Age gate for the multipart-orphan sweep, ms.
 * @param {number}  conf.maxObjectSize      - Per-object byte ceiling.
 * @param {?object} store                   - Always `null` — this adapter is storeless; the
 *                                            dispatcher passes it for signature uniformity.
 * @param {object}  deps                    - Injected dependencies.
 * @param {function} deps.requireModule     - Project-module resolver (`gna.js` builds it from
 *                                            `getPath('project')`; tests inject a fake SDK).
 * @returns {StorageDriver} A ready driver (`resolve()` answers `{kind:'url'}`).
 * @throws {Error} When `deps.requireModule` is absent, an SDK package is not installed in the
 *                 project, or the loaded client is not SDK v3 — the boot path treats each as fatal.
 */
module.exports = function createS3Driver(name, conf, store, deps) {
    deps = deps || {};
    if ( typeof deps.requireModule !== 'function' ) {
        throw new Error('[storage:' + name + '] the s3 adapter requires `deps.requireModule` — the project-module resolver injected at boot (see gna.js), or a test-injected fake SDK loader');
    }

    /**
     * Load one project-side package with an actionable message — the connector
     * idiom (lazy, contextual `npm install` hint, real error appended).
     *
     * @inner
     * @param {string} pkg - Package name.
     * @returns {object} The package's exports.
     */
    var loadPkg = function(pkg) {
        try {
            return deps.requireModule(pkg);
        } catch (e) {
            throw new Error(
                '[storage:' + name + '] ' + pkg + ' is not installed in your project.\n'
                + 'The s3 adapter needs: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner\n'
                + (e && e.message || e)
            );
        }
    };

    var clientMod    = loadPkg('@aws-sdk/client-s3');
    var libStorage   = loadPkg('@aws-sdk/lib-storage');
    var presignerMod = loadPkg('@aws-sdk/s3-request-presigner');

    // Interop shim for dual-published packages (the AI-connector shape).
    var sdk = clientMod && clientMod.S3Client ? clientMod : ( clientMod && clientMod.default ) || clientMod;
    var S3Client = sdk && sdk.S3Client;
    if ( typeof S3Client !== 'function' ) {
        // v2 `aws-sdk` has no S3Client — name the actual requirement rather
        // than failing later with an unrelated TypeError.
        throw new Error('[storage:' + name + '] @aws-sdk/client-s3 v3 is required (the loaded module exposes no S3Client — the v2 `aws-sdk` package is not supported)');
    }
    var Upload = ( libStorage && libStorage.Upload ) || ( libStorage && libStorage.default && libStorage.default.Upload );
    if ( typeof Upload !== 'function' ) {
        throw new Error('[storage:' + name + '] @aws-sdk/lib-storage exposes no Upload class — v3 is required');
    }
    var getSignedUrl = ( presignerMod && presignerMod.getSignedUrl ) || ( presignerMod && presignerMod.default && presignerMod.default.getSignedUrl );
    if ( typeof getSignedUrl !== 'function' ) {
        throw new Error('[storage:' + name + '] @aws-sdk/s3-request-presigner exposes no getSignedUrl — v3 is required');
    }

    var bucket        = conf.bucket;
    var prefix        = conf.prefix || '';
    var maxObjectSize = conf.maxObjectSize;
    var presignMs     = conf.presignExpiry;
    var sweepGrace    = conf.sweepGrace;

    var clientConf = {};
    if ( conf.region ) { clientConf.region = conf.region; }
    if ( conf.endpoint ) { clientConf.endpoint = conf.endpoint; }
    if ( conf.forcePathStyle === true ) { clientConf.forcePathStyle = true; }
    if ( typeof(conf.accessKeyId) == 'string' && conf.accessKeyId.length
        && typeof(conf.secretAccessKey) == 'string' && conf.secretAccessKey.length ) {
        clientConf.credentials = {
            accessKeyId     : conf.accessKeyId,
            secretAccessKey : conf.secretAccessKey
        };
        if ( typeof(conf.sessionToken) == 'string' && conf.sessionToken.length ) {
            clientConf.credentials.sessionToken = conf.sessionToken;
        }
    }
    // No credentials configured → the SDK default provider chain runs
    // (env vars / shared config / IMDS / IRSA) — misconfiguration surfaces at
    // the first operation with the SDK's own message, like every DB connector;
    // a boot-time reachability probe would couple boot to provider liveness.
    var client = new S3Client(clientConf);

    /**
     * The provider-side key: the configured prefix + the opaque key. The
     * OPAQUE key excludes the prefix (config-relative addressing, exactly as
     * local keys are root-relative), so re-pointing `prefix` orphans old
     * objects the same way re-pointing a local `root` does — a config move,
     * never a key rewrite.
     *
     * @inner
     * @param {string} key - The opaque storage key.
     * @returns {string} The bucket object key.
     */
    var providerKey = function(key) {
        return prefix + key;
    };

    /**
     * Age-gated multipart-orphan sweep — the s3 analog of the local
     * strategies' crashed-put temp reclamation (#B349 class): a process that
     * died mid-`put()` may have left an in-progress multipart upload, whose
     * parts BILL until aborted and which no verb ever looks at again. One
     * bounded page per build (successive boots drain more), each upload older
     * than `sweepGrace` aborted; best-effort and silent like the sharded
     * sweep — it must never delay or fail a boot, and a provider that does
     * not implement the listing simply no-ops it.
     *
     * @inner
     * @returns {void}
     */
    var sweepMultipartOrphans = function() {
        var listCmd = new sdk.ListMultipartUploadsCommand({
            Bucket : bucket,
            Prefix : prefix.length ? prefix : undefined
        });
        client.send(listCmd).then(function(res) {
            var uploads = ( res && Array.isArray(res.Uploads) ) ? res.Uploads : [];
            var cutoff  = Date.now() - sweepGrace;
            var stale   = uploads.filter(function(u) {
                var initiated = ( u && u.Initiated ) ? new Date(u.Initiated).getTime() : NaN;
                // an upload with no readable initiation date is left alone —
                // the sweep only ever claims provably old work
                return !isNaN(initiated) && initiated < cutoff && u.Key && u.UploadId;
            });
            var next = function(i) {
                if ( i >= stale.length ) { return; }
                client.send(new sdk.AbortMultipartUploadCommand({
                    Bucket   : bucket,
                    Key      : stale[i].Key,
                    UploadId : stale[i].UploadId
                })).catch(function() {}).then(function() { next(i + 1); });
            };
            next(0);
        }).catch(function() {});
    };
    setImmediate(sweepMultipartOrphans);

    /**
     * What this driver can do. `offload: true` is the layer's FIRST — the
     * serving facade redirects to a presigned URL instead of streaming the
     * bytes itself. `ranges` stays true because the adapter can ALSO proxy
     * (`get`/`getRange` are real), which is what `opts.offload: false` on the
     * facade uses. No dedup (S3 ETags are not content digests), no resumable
     * verbs (multipart is the provider's own resumable), no inline tier (there
     * is no metadata store to inline into).
     *
     * @type {{offload: boolean, ranges: boolean, dedup: boolean, resumable: boolean, inline: boolean}}
     */
    var capabilities = {
        offload   : true,
        ranges    : true,
        dedup     : false,
        resumable : false,
        inline    : false
    };

    return {

        /**
         * Store a readable stream and return its opaque key.
         *
         * The key is minted with the sharded grammar (`YYYY/MM/DD/<ulid><ext>`)
         * under the configured prefix; ContentType rides the object verbatim
         * and the original name rides as URI-encoded user metadata (immutable
         * after upload, like the object). The byte transfer goes through
         * lib-storage's `Upload` — single-part or multipart "under the hood",
         * which is what accepts a stream of unknown length without local
         * staging.
         *
         * `maxObjectSize` is enforced MID-STREAM by a counting transform: on
         * breach the upload is aborted (best-effort — the build-time sweep is
         * the backstop for a lost abort) and the REAL cap error is reported.
         * The reported `size` is the meter's count — the bytes the provider
         * acknowledged storing; transport checksums guard the transfer, so a
         * confirm-HEAD would buy nothing.
         *
         * @param {object}   stream               - Any readable stream.
         * @param {object}   [meta]               - Client-supplied, untrusted.
         * @param {string}   [meta.originalName]  - Filename; URI-encoded into user metadata
         *                                          (truncated past ~1KB), and the only source
         *                                          of the key extension.
         * @param {string}   [meta.contentType]   - MIME type; stored verbatim on the object.
         * @param {function} fn                   - `fn(err, {key, size, contentType})`.
         * @returns {void}
         *
         * @example
         * driver.put(req, { originalName: 'report.pdf', contentType: 'application/pdf' }, function (err, res) {
         *     if (err) { return next(err); }
         *     record.storageKey = res.key;   // opaque — store it, never parse it
         * });
         */
        put: function(source, meta, fn) {
            if ( typeof meta === 'function' ) { fn = meta; meta = {}; }
            meta = meta || {};
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] put() requires a callback');
            }
            if ( !source || typeof source.pipe !== 'function' ) {
                return fn(new Error('[storage:' + name + '] put() requires a readable stream'));
            }

            var now = new Date();
            var id  = util.ulid(now.getTime());
            var ext = util.sanitiseExtension(meta.originalName);
            var day = now.getUTCFullYear()
                + '/' + ('0' + (now.getUTCMonth() + 1)).slice(-2)
                + '/' + ('0' + now.getUTCDate()).slice(-2);
            var key = day + '/' + id + ext;

            var settled = false;
            var settle  = function(err, res) {
                if (settled) { return; }
                settled = true;
                fn(err || null, res);
            };

            var counted = 0;
            var meter = new Transform({
                transform: function(chunk, enc, cb) {
                    counted += chunk.length;
                    if ( counted > maxObjectSize ) {
                        return cb(new Error('[storage:' + name + '] put() aborted: the object exceeds maxObjectSize (' + maxObjectSize + ' bytes)'));
                    }
                    cb(null, chunk);
                }
            });

            var params = {
                Bucket : bucket,
                Key    : providerKey(key),
                Body   : meter
            };
            if ( typeof(meta.contentType) == 'string' && meta.contentType.length ) {
                params.ContentType = meta.contentType;
            }
            if ( typeof(meta.originalName) == 'string' && meta.originalName.length ) {
                var encodedName = encodeURIComponent(meta.originalName);
                if ( encodedName.length > META_NAME_MAX ) {
                    encodedName = encodedName.slice(0, META_NAME_MAX);
                }
                params.Metadata = {};
                params.Metadata[META_NAME_KEY] = encodedName;
            }

            var upload = new Upload({ client: client, params: params });

            /**
             * Best-effort cancel — a rejected/aborted multipart may leave
             * parts; the sweep reclaims whatever the abort misses.
             *
             * @inner
             * @returns {void}
             */
            var cancel = function() {
                try {
                    var p = upload.abort();
                    if ( p && typeof p.catch === 'function' ) { p.catch(function() {}); }
                } catch (ignore) {}
            };

            // Armed before any data can flow (#B143): a source error is OUR
            // report — the REAL error, never a fabricated one (#B223).
            source.on('error', function(err) {
                cancel();
                meter.destroy();
                settle(err);
            });

            source.pipe(meter);

            upload.done().then(function() {
                settle(null, {
                    key         : key,
                    size        : counted,
                    contentType : ( typeof(meta.contentType) == 'string' && meta.contentType.length ) ? meta.contentType : null
                });
            }, function(err) {
                cancel();
                settle(err);
            });
        },

        /**
         * Read the whole object as a stream (the proxy path — used by the
         * serving facade when `opts.offload: false`, and by any caller that
         * wants the bytes in-process).
         *
         * @param {string}   key - The opaque storage key.
         * @param {function} fn  - `fn(err, stream)`.
         * @returns {void}
         */
        get: function(key, fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] get() requires a callback');
            }
            var bad = guardKey(name, key);
            if ( bad ) { return fn(bad); }
            client.send(new sdk.GetObjectCommand({
                Bucket : bucket,
                Key    : providerKey(key)
            })).then(function(res) {
                fn(null, res.Body);
            }, function(err) {
                fn(mapReadError(name, key, err));
            });
        },

        /**
         * Byte-range read — `end` INCLUSIVE, matching the HTTP `Range` header
         * exactly as the local strategies do; the range rides the provider's
         * own `Range: bytes=a-b`, so an over-long `end` is clamped by the
         * provider and only a `start` at or beyond the object's size is
         * unsatisfiable (surfaced as the provider's 416, mapped to the
         * layer's code).
         *
         * @param {string}   key   - The opaque storage key.
         * @param {number}   start - First byte offset, inclusive; integer >= 0.
         * @param {number}   end   - Last byte offset, INCLUSIVE; integer >= start.
         * @param {function} fn    - `fn(err, stream)`.
         * @returns {void}
         */
        getRange: function(key, start, end, fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] getRange() requires a callback');
            }
            if ( !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start ) {
                return fn(util.codedError('STORAGE_INVALID_RANGE', '[storage:' + name + '] getRange(): invalid range [' + start + ', ' + end + '] — both bounds must be integers with 0 <= start <= end'));
            }
            var bad = guardKey(name, key);
            if ( bad ) { return fn(bad); }
            client.send(new sdk.GetObjectCommand({
                Bucket : bucket,
                Key    : providerKey(key),
                Range  : 'bytes=' + start + '-' + end
            })).then(function(res) {
                fn(null, res.Body);
            }, function(err) {
                fn(mapReadError(name, key, err));
            });
        },

        /**
         * Metadata for `key` — a `HeadObject`, which S3 documents as strongly
         * consistent after the put.
         *
         * ⚠️ IAM: a missing key answers 404 (→ the contract's `null`) only
         * when the credentials hold `s3:ListBucket`; without it the provider
         * answers 403, which surfaces here as a raw error, not `null`. The
         * guide ships the minimal policy.
         *
         * @param {string}   key - The opaque storage key.
         * @param {function} fn  - `fn(err, meta|null)`; `null` when the key is unknown.
         * @returns {void}
         */
        stat: function(key, fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] stat() requires a callback');
            }
            var bad = guardKey(name, key);
            if ( bad ) { return fn(bad); }
            client.send(new sdk.HeadObjectCommand({
                Bucket : bucket,
                Key    : providerKey(key)
            })).then(function(res) {
                var rawName = ( res.Metadata && res.Metadata[META_NAME_KEY] ) || null;
                var originalName = null;
                if ( rawName != null ) {
                    // decode failure ⇒ the raw value — a name written by
                    // another tool is still better surfaced than dropped
                    try { originalName = decodeURIComponent(rawName); }
                    catch (e) { originalName = rawName; }
                }
                fn(null, {
                    originalName : originalName,
                    contentType  : ( typeof(res.ContentType) == 'string' && res.ContentType.length ) ? res.ContentType : null,
                    size         : ( typeof(res.ContentLength) == 'number' ) ? res.ContentLength : null,
                    createdAt    : res.LastModified ? new Date(res.LastModified).getTime() : null
                });
            }, function(err) {
                var mapped = mapReadError(name, key, err);
                if ( mapped && mapped.code === 'STORAGE_NO_OBJECT' ) {
                    return fn(null, null);
                }
                fn(mapped);
            });
        },

        /**
         * Delete the object.
         *
         * DOCUMENTED DEVIATION: S3's delete is idempotent and does not report
         * prior existence, so `existed` is `true` whenever the provider
         * acknowledged the delete — it is an acknowledgement, not an
         * existence signal. A caller needing the distinction should `stat()`
         * first (no framework code reads the flag today — measured).
         *
         * @param {string}   key  - The opaque storage key.
         * @param {function} [fn] - `fn(err, existed)`.
         * @returns {void}
         */
        release: function(key, fn) {
            if ( typeof fn !== 'function' ) { fn = function() {}; }
            var bad = guardKey(name, key);
            if ( bad ) { return fn(bad); }
            client.send(new sdk.DeleteObjectCommand({
                Bucket : bucket,
                Key    : providerKey(key)
            })).then(function() {
                fn(null, true);
            }, function(err) {
                fn(err);
            });
        },

        /**
         * How to serve `key`: a presigned GET URL — `{kind: 'url'}`, the kind
         * the contract reserved for this adapter. Presigning is LOCAL
         * computation (SigV4 over the configured credentials — no provider
         * round-trip), so existence is deliberately NOT verified here: the
         * serving facade is `stat()`-gated already, and a direct caller's URL
         * to a vanished object answers the provider's own 404. Documented
         * rather than hidden.
         *
         * `opts` is how the serving facade's decisions reach the PROVIDER's
         * response — the override params are part of the signature, and S3
         * only honours them on signed requests:
         *   - `opts.contentType`  → `response-content-type` (the facade passes
         *     its fail-closed DOWNGRADED type here, which is what keeps the
         *     stored-XSS guard intact on the offload path)
         *   - `opts.download`/`opts.filename` → `response-content-disposition`
         *   - `opts.cacheControl` → `response-cache-control` (the facade's
         *     immutable-per-key default — the redirect itself stays no-store,
         *     the PAYLOAD response carries the caching policy)
         *
         * @param {string}   key              - The opaque storage key.
         * @param {object}   [opts]           - Response-override options (see above).
         * @param {string}   [opts.contentType]
         * @param {boolean}  [opts.download]
         * @param {string}   [opts.filename]
         * @param {string}   [opts.cacheControl]
         * @param {function} fn               - `fn(err, {kind:'url', url, expiresAt})` —
         *                                      `expiresAt` epoch ms.
         * @returns {void}
         *
         * @example
         * driver.resolve(key, function (err, r) {
         *     if (err) { return next(err); }
         *     // r.kind === 'url' — hand it to the client, mind r.expiresAt
         *     self.redirect(r.url);
         * });
         */
        resolve: function(key, opts, fn) {
            if ( typeof opts === 'function' ) { fn = opts; opts = null; }
            opts = opts || {};
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] resolve() requires a callback');
            }
            var bad = guardKey(name, key);
            if ( bad ) { return fn(bad); }

            var params = {
                Bucket : bucket,
                Key    : providerKey(key)
            };
            if ( typeof(opts.contentType) == 'string' && opts.contentType.length ) {
                params.ResponseContentType = opts.contentType;
            }
            if ( opts.download === true || ( typeof(opts.filename) == 'string' && opts.filename.length ) ) {
                params.ResponseContentDisposition = formatDisposition(opts.filename || 'download');
            }
            if ( typeof(opts.cacheControl) == 'string' && opts.cacheControl.length ) {
                params.ResponseCacheControl = opts.cacheControl;
            }

            var expiresInS = Math.max(1, Math.floor(presignMs / 1000));
            getSignedUrl(client, new sdk.GetObjectCommand(params), { expiresIn: expiresInS })
                .then(function(url) {
                    fn(null, { kind: 'url', url: url, expiresAt: Date.now() + expiresInS * 1000 });
                }, function(err) {
                    fn(err);
                });
        },

        /**
         * Driver statistics for the operator surface. `root` is meaningless
         * here, so the identity fields are the provider coordinates instead
         * (`adapter`/`bucket`/`prefix`/`endpoint`); `store` is `null` by
         * construction (storeless). Object counts aggregate ListObjectsV2 in
         * bounded pages — a bucket larger than the bound reports
         * `truncated: true` with the partial counts rather than walking
         * millions of keys on an operator ping. In-progress multipart uploads
         * are invisible to the listing (provider semantics) and therefore not
         * counted.
         *
         * @param {function} fn - `fn(err, {name, adapter, strategy, bucket, prefix, endpoint,
         *                        capabilities, store, objects})` — `objects` is
         *                        `{count, bytes, truncated}`.
         * @returns {void}
         */
        stats: function(fn) {
            if ( typeof fn !== 'function' ) {
                throw new Error('[storage:' + name + '] stats() requires a callback');
            }
            var count = 0, bytes = 0, pages = 0;
            var page = function(token) {
                if ( pages >= LIST_PAGE_LIMIT ) {
                    return done(true);
                }
                pages++;
                var params = { Bucket: bucket };
                if ( prefix.length ) { params.Prefix = prefix; }
                if ( token ) { params.ContinuationToken = token; }
                client.send(new sdk.ListObjectsV2Command(params)).then(function(res) {
                    var contents = Array.isArray(res.Contents) ? res.Contents : [];
                    for (var i = 0; i < contents.length; i++) {
                        count++;
                        if ( typeof(contents[i].Size) == 'number' ) { bytes += contents[i].Size; }
                    }
                    if ( res.IsTruncated && res.NextContinuationToken ) {
                        return page(res.NextContinuationToken);
                    }
                    done(false);
                }, function(err) {
                    fn(err);
                });
            };
            var done = function(truncated) {
                fn(null, {
                    name         : name,
                    adapter      : 's3',
                    strategy     : 'sharded',
                    bucket       : bucket,
                    prefix       : prefix,
                    endpoint     : conf.endpoint || null,
                    capabilities : capabilities,
                    store        : null,
                    objects      : { count: count, bytes: bytes, truncated: truncated }
                });
            };
            page(null);
        },

        capabilities: capabilities,

        /**
         * Destroy the client's connection pool. Nothing else to close — no
         * store handle, no timers (the sweep is a one-shot).
         *
         * @returns {void}
         */
        close: function() {
            try { client.destroy(); } catch (ignore) {}
        },

        /**
         * Test seam — the one-shot multipart-orphan sweep, exposed so the
         * suite can drive it deterministically (the `_sweepOnce` convention).
         *
         * @private
         */
        _sweepMultipartOrphans: sweepMultipartOrphans
    };
};
