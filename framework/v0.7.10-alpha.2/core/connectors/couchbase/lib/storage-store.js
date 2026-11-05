/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/core/connectors/couchbase/storage-store
 *
 * Couchbase-backed `StorageMetaStore` for the object-storage layer
 * (`lib/storage`) — the FIRST connector store of the #STO1 family, and the
 * supported answer to the embedded backend's documented
 * single-process-per-driver-root boundary. Backed by the consumer project's
 * own `couchbase` driver (SDK major 3 or 4), resolved at construction — the
 * framework keeps zero hard dependency on it.
 *
 * What it buys over the embedded SQLite store: the metadata row lives on a
 * cluster every pod reaches, so several bundles (or replicas) can share ONE
 * driver root. That is not a performance nicety — SQLite's locking is a
 * known-broken story on a shared network filesystem, so a shared root is
 * exactly what the embedded store refuses to support.
 *
 * **Per-key atomicity comes from Couchbase's own CAS**, which the refcount
 * verbs need (`acquireRef` is what makes two concurrent identical `put()`s
 * yield one blob and two references instead of a lost update). Every
 * read-modify-write verb is a `get` → `mutateIn(..., {cas})` loop: the
 * sub-document mutation applies all-or-none and only if the document has not
 * changed since the read, so a lost update is impossible and a concurrent
 * writer costs a bounded retry. CAS-guarded writes execute against the ACTIVE
 * vBucket only (replicas serve reads, never writes), so the loop stays correct
 * across a failover — each retry re-reads whatever node is active now.
 *
 * **Multi-process sweep coordination is the store's atomic claim, by design.**
 * `removeIfZero` is a CAS-guarded `remove`: when several processes sweep the
 * same root concurrently, exactly one claim per blob succeeds and every other
 * one reads `CasMismatchError` / `DocumentNotFoundError` and skips — so the
 * `local-cas` sweep protocol (claim the row FIRST, unlink second) is safe
 * without any election layer, and adding one would close no gap while making
 * `storage:gc` report `collected: 0` on whichever replica did not hold the
 * lease. The residual the seam documents is unchanged and is NOT a
 * sweeper-vs-sweeper race: it is put-vs-sweep (a fresh publish racing the
 * unlink), mitigated by the grace window, the put-side heal and
 * `storage:verify`.
 *
 * **Durability, stated rather than implied.** By default mutations use the
 * SDK's own default level (in-memory on the active node), which is the same
 * honesty class as the embedded store's SQLite WAL at `synchronous=NORMAL` —
 * a crash can lose the most recent acknowledged write. Couchbase failover can
 * likewise lose durably-written data. Consequences here are asymmetric and
 * worth knowing: a lost `acquireRef` undercounts (a blob may reach zero early
 * — gated by the grace window, adjudicated by the claim, visible to
 * `storage:verify`), while a lost `releaseRef` overcounts and that blob is
 * never collected. Set `durability` on the connectors.json entry when the
 * content justifies the latency.
 *
 * Data layout — ONE JSON document per metadata row:
 *
 *   <prefix><driver>:<key>   the row. `d` (driver name) and `k` (logical key)
 *                            are the sargable discriminators every query
 *                            filters on; the contract fields ride beside them
 *                            (`originalName`, `contentType`, `size`,
 *                            `createdAt`), with `data` present only for
 *                            size-tiered inline objects and `refs`/`zeroAt`
 *                            present only on refcounted (cas) rows.
 *
 * The payload rides as a **base64 STRING inside the JSON document**, not as a
 * binary document body: Couchbase cannot parse, index or query a binary value
 * (it is retrievable by key alone), which would make `listZeroRefs` / `stats`
 * structurally impossible — and the refcount and the payload must sit under
 * ONE CAS for the verbs above to be atomic. The cost is base64's +33%: with
 * the shipped 64KB tiering threshold a row is ~85KB, far below Couchbase's
 * 20MB document ceiling, but an `inlineThreshold` above ~14MB would overflow
 * it and the SDK will refuse the write.
 *
 * Config keys follow the couchbase connector's OWN conventions (the §11 rule —
 * mirrors `connector.v4.js` / the session store): `protocol` + `host` +
 * `username` + `password` + `database` (the BUCKET name — the same field the
 * model layer's entity scan reads), plus `scope` / `collection` (both
 * `_default`), `prefix` and the optional `durability`.
 *
 * Constructed by the `lib/storage-store` dispatcher at boot; not meant to be
 * instantiated from application code.
 *
 * @example
 *   // connectors.json
 *   // { "assetsMeta": { "connector": "couchbase", "protocol": "couchbase://",
 *   //                   "host": "db1.internal", "username": "gina",
 *   //                   "password": "${secret:CB_PASSWORD}",
 *   //                   "database": "gina_storage" } }
 *   // settings.json
 *   // { "storage": { "drivers": { "assets": {
 *   //     "adapter": "local", "strategy": "cas",
 *   //     "root": "/var/data/assets", "store": "assetsMeta" } } } }
 */

/**
 * No-op callback used when a caller omits one.
 * @inner
 * @returns {void}
 */
function noop() {}

// #B432 — every verb runs a promise chain nested inside another (the connection
// gate, then a CAS retry loop), so a callback that THROWS would reject the
// enclosing chain and reach a second, outer handler. Each verb wraps `fn` at
// entry with the shared guard: one delivery, and the exception is reported
// under the verb's label instead of being lost in the chain or logged as a
// store failure (see core/connectors/settle-once.js).
var settleOnce = require('./../../settle-once');

/**
 * Secondary indexes this store needs, and the fields they cover. Created at
 * construction when missing (see the bootstrap below); an operator whose
 * cluster credentials cannot create indexes gets the exact DDL in a log line
 * instead.
 *
 * `gina_storage_refs` serves `listZeroRefs` (the GC sweep's listing) and
 * `gina_storage_keys` serves `listKeys` / `stats` (the `storage:verify` walk
 * and the operator surface). Both lead with `d`, which every query filters on,
 * so one collection can host several drivers without cross-scanning.
 *
 * @inner
 * @constant
 * @type {Array<{name: string, fields: string}>}
 */
var INDEXES = [
    { name: 'gina_storage_refs', fields: '(d, refs, zeroAt)' },
    { name: 'gina_storage_keys', fields: '(d, k)' }
];

/**
 * Ceiling on how many times a CAS read-modify-write verb re-reads and retries
 * before giving up. A BOUND, not a config knob (the `SWEEP_BATCH` precedent):
 * it caps the work one contended key can cost, and exhaustion is reported
 * through the callback as an ordinary error, never silently swallowed.
 *
 * @inner
 * @constant
 * @type {number}
 */
var MAX_CAS_ATTEMPTS = 10;

/**
 * Backoff schedule between CAS attempts, in ms — jittered at use so several
 * contending processes do not re-collide in lockstep. The last value repeats
 * once the schedule is exhausted.
 *
 * @inner
 * @constant
 * @type {number[]}
 */
var CAS_BACKOFF_MS = [0, 5, 10, 20, 40];

/**
 * Couchbase's hard ceiling on a document KEY, in bytes. The composed docId
 * (`<prefix><driver>:<key>`) is checked against it per call: today's key
 * grammars peak around half of it, so tripping this means a caller minted an
 * unusually long key — and a truncating store would silently alias two
 * objects onto one row.
 *
 * @inner
 * @constant
 * @type {number}
 */
var MAX_DOC_ID_BYTES = 250;

/**
 * Driver names that may safely compose a document-id namespace. A `:` would
 * let one driver's name alias another's namespace boundary, so the character
 * class is deliberately narrower than the file-system key guard's.
 *
 * @inner
 * @constant
 * @type {RegExp}
 */
var DRIVER_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Couchbase identifier grammar, for the three names that MUST be interpolated
 * into statements rather than bound as parameters (a keyspace is an
 * identifier, and N1QL has no placeholder for one). Anything outside this
 * class is refused at construction — that refusal is what keeps the
 * interpolation safe.
 *
 * @inner
 * @constant
 * @type {RegExp}
 */
var IDENTIFIER_RE = /^[A-Za-z0-9_%\-]+$/;

/**
 * Accepted `durability` values → the SDK's `DurabilityLevel` member name.
 * BOTH spellings are accepted for the middle level because the server
 * documentation and the Node SDK disagree: the docs call it
 * `majorityAndPersistToActive`, the SDK enum member is
 * `MajorityAndPersistOnMaster`. Accepting only one of them would silently
 * drop a correctly-configured durability level.
 *
 * @inner
 * @constant
 * @type {Object.<string, string>}
 */
var DURABILITY_LEVELS = {
    none                       : 'None',
    majority                   : 'Majority',
    majorityandpersisttoactive : 'MajorityAndPersistOnMaster',
    majorityandpersistonmaster : 'MajorityAndPersistOnMaster',
    persisttomajority          : 'PersistToMajority'
};

/**
 * Build a Couchbase-backed metadata store implementing the
 * {@link StorageMetaStore} seam — the four base verbs (`set` / `get` /
 * `remove` / `close`), the four refcount verbs a `cas` driver requires
 * (`acquireRef` / `releaseRef` / `listZeroRefs` / `removeIfZero`) and both
 * optional operator verbs (`stats` / `listKeys`).
 *
 * The SDK is promise-based, so callbacks fire asynchronously — which the seam
 * explicitly allows (the embedded store's synchronous timing is an
 * implementation detail of `node:sqlite`, never part of the contract).
 *
 * @param {object}  connConf              - Resolved `connectors.json` entry for this store.
 * @param {string}  [connConf.protocol]   - Connection scheme (default `'couchbase://'`).
 * @param {string}  [connConf.host]       - Host or comma-separated hosts (default 127.0.0.1).
 * @param {string}  [connConf.username]   - Cluster username.
 * @param {string}  [connConf.password]   - Cluster password.
 * @param {string}  connConf.database     - Bucket NAME (required — the couchbase connector's
 *                                          own convention; the model layer reads the same field).
 * @param {string}  [connConf.scope]      - Scope name (default `'_default'`).
 * @param {string}  [connConf.collection] - Collection name (default `'_default'`).
 * @param {string}  [connConf.prefix]     - Document-id prefix (default `'stor:'`).
 * @param {string}  [connConf.durability] - Durability level applied to every mutation:
 *                                          `majority` | `majorityAndPersistToActive` |
 *                                          `persistToMajority` (or `none`). Omitted, the SDK
 *                                          default applies — see the module header.
 * @param {string}  bundle                - Bundle name — used in log lines.
 * @param {string}  driverName            - Storage driver this store backs. It NAMESPACES every
 *                                          document id and scopes every query, so several
 *                                          drivers may share one connectors.json entry without
 *                                          colliding keys, stamps or refcounts.
 * @param {object}  [injected]            - Test-only dependency injection (the entity-layer
 *                                          `injected` precedent): `{ driver }` replaces the
 *                                          project-resolved couchbase module.
 * @returns {StorageMetaStore}            - A ready store (plus `close()`).
 * @throws {Error}                        - When the couchbase driver is not installed, the SDK
 *                                          major is unsupported, `database` is missing, or a
 *                                          driver/keyspace name is unusable. `gna.js` treats a
 *                                          throw as a boot fatal — an explicitly configured
 *                                          store must build or refuse, never degrade to the
 *                                          embedded backend.
 *
 * @example
 *   // wired automatically at boot by gna.js via lib/storage-store
 *   var store = require('.../couchbase/lib/storage-store')(connConf, 'app', 'assets');
 */
module.exports = function CouchbaseStorageStore(connConf, bundle, driverName, injected) {
    connConf = connConf || {};

    if ( typeof driverName !== 'string' || !DRIVER_NAME_RE.test(driverName) ) {
        throw new Error('[CouchbaseStorageStore] a storage driver name is required and must match '
            + DRIVER_NAME_RE + ' (got: ' + JSON.stringify(driverName) + ') — it namespaces every '
            + 'document id, so a `:` in it would alias another driver\'s namespace');
    }

    // Resolve the couchbase driver from the project's node_modules (the
    // connector's own precedent — core/connectors/couchbase/index.js:8-9 —
    // and the mongodb job-store's). The injected branch is test-only; the
    // default branch is the only place the injected `_` / `getPath` globals
    // are read, so tests stay standalone.
    var couchbase;
    if (injected && injected.driver) {
        couchbase = injected.driver;
    } else {
        try {
            var driverPath = _(getPath('project') + '/node_modules/couchbase', true);
            couchbase = require(driverPath);
        } catch (e) {
            throw new Error(
                '[CouchbaseStorageStore] couchbase is not installed. '
                + 'Run `npm install couchbase` in your project (SDK major 3 or 4).\n'
                + e.message
            );
        }
    }

    if ( typeof couchbase.connect !== 'function' ) {
        // #CN8 parity: SDK v2 exposed cluster.openBucket() and no connect().
        throw new Error('[CouchbaseStorageStore] the installed couchbase driver exposes no `connect()` — '
            + 'supported SDK majors are 3 and 4. Upgrade the couchbase dependency in your project '
            + 'package.json: npm install couchbase@^4 (or ^3).');
    }

    var bucketName = connConf.database;
    if (!bucketName) {
        throw new Error('[CouchbaseStorageStore] missing required `database` field (the bucket name) in the connectors.json entry');
    }

    var scopeName      = connConf.scope || '_default';
    var collectionName = connConf.collection || '_default';
    var prefix         = ( typeof connConf.prefix === 'string' && connConf.prefix.length > 0 ) ? connConf.prefix : 'stor:';

    // The keyspace is an IDENTIFIER, and N1QL has no placeholder for one, so
    // these three names are interpolated into every statement. Validating them
    // here — once, at construction — is what makes that interpolation safe;
    // every VALUE below is a positional parameter.
    [['database', bucketName], ['scope', scopeName], ['collection', collectionName]].forEach(function(pair) {
        if ( typeof pair[1] !== 'string' || !IDENTIFIER_RE.test(pair[1]) ) {
            throw new Error('[CouchbaseStorageStore] `' + pair[0] + '` must match ' + IDENTIFIER_RE
                + ' (got: ' + JSON.stringify(pair[1]) + ') — it is interpolated into N1QL statements as an identifier');
        }
    });

    /**
     * Backtick-quoted keyspace, e.g. `` `gina_storage`.`_default`.`_default` ``.
     * @inner
     * @type {string}
     */
    var keyspace = '`' + bucketName + '`.`' + scopeName + '`.`' + collectionName + '`';

    /**
     * Resolved SDK durability option, merged into every mutation. `null` when
     * unconfigured — the SDK's own default then applies.
     *
     * @inner
     * @type {?object}
     */
    var durabilityOpt = null;
    if ( typeof connConf.durability === 'string' && connConf.durability.length > 0 ) {
        var member = DURABILITY_LEVELS[connConf.durability.toLowerCase()];
        if (!member) {
            throw new Error('[CouchbaseStorageStore] unknown `durability` ' + JSON.stringify(connConf.durability)
                + ' — expected one of: majority, majorityAndPersistToActive, persistToMajority, none');
        }
        if ( !couchbase.DurabilityLevel || typeof couchbase.DurabilityLevel[member] === 'undefined' ) {
            throw new Error('[CouchbaseStorageStore] `durability` ' + JSON.stringify(connConf.durability)
                + ' is not available on the installed couchbase SDK (no DurabilityLevel.' + member + ')');
        }
        durabilityOpt = { durabilityLevel: couchbase.DurabilityLevel[member] };
    }

    /**
     * Merge the configured durability into a per-operation options bag.
     *
     * @inner
     * @param {object} [opt] - Base options (e.g. `{cas}`).
     * @returns {object} The options to hand the SDK.
     */
    var withDurability = function(opt) {
        opt = opt || {};
        if (durabilityOpt) { opt.durabilityLevel = durabilityOpt.durabilityLevel; }
        return opt;
    };

    /**
     * Whether `err` is the named Couchbase error class. Checked by
     * constructor identity first, then by name — a driver that surfaces the
     * class only by name (or a test double) still classifies correctly, and
     * misclassifying here would turn a resurrection signal into a hard
     * failure.
     *
     * @inner
     * @param {*}      err       - Any thrown/rejected value.
     * @param {string} className - e.g. `'CasMismatchError'`.
     * @returns {boolean}
     */
    var isCbError = function(err, className) {
        if (!err) { return false; }
        var Ctor = couchbase[className];
        if ( typeof Ctor === 'function' && err instanceof Ctor ) { return true; }
        if ( err.name === className ) { return true; }
        if ( err.constructor && err.constructor.name === className ) { return true; }
        return false;
    };

    /**
     * Compose the document id for a logical key, refusing one that would
     * exceed Couchbase's key ceiling.
     *
     * @inner
     * @param {string} key - The logical storage key.
     * @returns {{id: ?string, error: ?Error}}
     */
    var docIdFor = function(key) {
        var id = prefix + driverName + ':' + key;
        if ( Buffer.byteLength(id, 'utf8') > MAX_DOC_ID_BYTES ) {
            return { id: null, error: new Error('[CouchbaseStorageStore] the composed document id for key `' + key
                + '` is ' + Buffer.byteLength(id, 'utf8') + ' bytes, over Couchbase\'s ' + MAX_DOC_ID_BYTES
                + '-byte key limit (prefix `' + prefix + '` + driver `' + driverName + '`)') };
        }
        return { id: id, error: null };
    };

    /**
     * Build the stored document for `key` + `meta`.
     *
     * Absent optional fields are OMITTED rather than written as `null`, which
     * is what lets `get()` rebuild a row's exact contract shape: a
     * non-refcounted row must come back without `refs`/`zeroAt`, and a
     * file-backed row without `data`. A refcounted row always carries BOTH
     * `refs` and `zeroAt` (the latter valued `null` while `refs > 0`) —
     * mirroring the embedded store, whose NULL column reads back as `null`.
     *
     * @inner
     * @param {string}      key        - Logical storage key.
     * @param {StorageMeta} meta       - Caller metadata (may carry `data`).
     * @param {boolean}     refcounted - Stamp `refs: 1` / `zeroAt: null` (the acquireRef create).
     * @returns {object} The document to store.
     */
    var buildDoc = function(key, meta, refcounted) {
        meta = meta || {};
        var doc = {
            d            : driverName,
            k            : key,
            originalName : ( typeof meta.originalName === 'string' ) ? meta.originalName : null,
            contentType  : ( typeof meta.contentType === 'string' ) ? meta.contentType : null,
            size         : ( typeof meta.size === 'number' ) ? meta.size : null,
            createdAt    : ( typeof meta.createdAt === 'number' ) ? meta.createdAt : Date.now()
        };
        // Binary safety: a Buffer IS a Uint8Array and base64-encodes exactly;
        // anything else (a string above all — utf8 coercion would corrupt a
        // binary payload) is refused rather than encoded, matching the
        // embedded store's refusal-to-NULL.
        if ( meta.data instanceof Uint8Array ) {
            doc.data = Buffer.isBuffer(meta.data)
                ? meta.data.toString('base64')
                : Buffer.from(meta.data).toString('base64');
        }
        if (refcounted) {
            doc.refs   = 1;
            doc.zeroAt = null;
        }
        return doc;
    };

    /**
     * Rebuild the contract-shaped metadata object from a stored document.
     *
     * @inner
     * @param {object}  doc            - The stored document.
     * @param {boolean} includePayload - Attach `data` when the row carries one.
     * @returns {StorageMeta}
     */
    var metaFromDoc = function(doc, includePayload) {
        var meta = {
            originalName : ( typeof doc.originalName === 'string' ) ? doc.originalName : null,
            contentType  : ( typeof doc.contentType === 'string' ) ? doc.contentType : null,
            size         : ( typeof doc.size === 'number' ) ? doc.size : null,
            createdAt    : ( typeof doc.createdAt === 'number' ) ? doc.createdAt : null
        };
        // Present only for inline objects, so a file-backed row keeps its
        // exact pre-tiering shape. A zero-length payload is a real empty
        // object, distinct from an absent one — base64 '' decodes to it.
        if ( includePayload && typeof doc.data === 'string' ) {
            meta.data = Buffer.from(doc.data, 'base64');
        }
        // Present only for refcounted rows — the same pattern as `data`.
        if ( typeof doc.refs === 'number' ) {
            meta.refs   = doc.refs;
            meta.zeroAt = ( typeof doc.zeroAt === 'number' ) ? doc.zeroAt : null;
        }
        return meta;
    };

    /**
     * Pause between CAS attempts, jittered so contending processes do not
     * re-collide in lockstep.
     *
     * @inner
     * @param {number}   attempt - Zero-based attempt index.
     * @param {function} next    - Called after the pause.
     * @returns {void}
     */
    var backoff = function(attempt, next) {
        var base = CAS_BACKOFF_MS[Math.min(attempt, CAS_BACKOFF_MS.length - 1)];
        if (!base) { return setImmediate(next); }
        setTimeout(next, base + Math.floor(Math.random() * base));
    };

    /**
     * The error a CAS loop reports once {@link MAX_CAS_ATTEMPTS} is spent.
     * Carries a code so a caller can distinguish sustained contention from a
     * cluster fault.
     *
     * @inner
     * @param {string} verb - Verb name, for the message.
     * @param {string} key  - Logical key.
     * @returns {Error}
     */
    var contentionError = function(verb, key) {
        var err = new Error('[CouchbaseStorageStore] ' + verb + '(`' + key + '`) gave up after '
            + MAX_CAS_ATTEMPTS + ' CAS attempts — the row is under sustained concurrent modification');
        err.code = 'GINA_STORAGE_CAS_CONTENTION';
        return err;
    };

    // ─── Connection ──────────────────────────────────────────────────────────

    var connStr = ( connConf.protocol || 'couchbase://' ) + ( connConf.host || '127.0.0.1' );
    var cluster = null;

    /**
     * Resolves to the open collection once the cluster is up. Every verb
     * chains on it, so operations issued before the connection completes are
     * queued rather than lost — and a connection failure surfaces through
     * each verb's own callback instead of as an unhandled rejection.
     *
     * @inner
     * @type {Promise<object>}
     */
    var ready = Promise.resolve()
        .then(function() {
            return couchbase.connect(connStr, {
                username : connConf.username,
                password : connConf.password
            });
        })
        .then(function(c) {
            cluster = c;
            return c.bucket(bucketName).scope(scopeName).collection(collectionName);
        });

    ready.catch(function(err) {
        console.error('[CouchbaseStorageStore] connection to `' + connStr + '` failed (bundle: '
            + bundle + ', driver: ' + driverName + '): ' + ((err && err.message) || err));
    });

    /**
     * Run `fn` against the open collection, funnelling any connection failure
     * into the caller's callback.
     *
     * @inner
     * @param {function} fn - `fn(collection)`.
     * @param {function} cb - The verb's callback; receives a connection error.
     * @returns {void}
     */
    var withCollection = function(fn, cb) {
        ready.then(fn).catch(function(err) { cb(err); });
    };

    /**
     * Run a N1QL statement. `NotBounded` scan consistency is deliberate and
     * safe here: index staleness can only make a listing MISS a row or offer
     * a stale candidate, and every destructive step that follows re-adjudicates
     * against the document itself through CAS — the listing is a trigger, the
     * KV operation is the verdict.
     *
     * @inner
     * @param {string}   statement - The N1QL statement.
     * @param {Array}    params    - Positional parameters (`$1..$N`).
     * @param {function} cb        - `cb(err, rows)`.
     * @returns {void}
     */
    var runQuery = function(statement, params, cb) {
        ready.then(function() {
            var opt = {
                parameters : params,
                // never re-plan a statement we compose ourselves
                adhoc      : false
            };
            if ( couchbase.QueryScanConsistency && typeof couchbase.QueryScanConsistency.NotBounded !== 'undefined' ) {
                opt.scanConsistency = couchbase.QueryScanConsistency.NotBounded;
            }
            return cluster.query(statement, opt);
        }).then(function(res) {
            cb(null, ( res && res.rows ) || []);
        }).catch(function(err) {
            cb(err);
        });
    };

    /**
     * Validate a caller-supplied row limit. It is INTERPOLATED into the
     * statement rather than bound, which keeps each statement a stable string
     * for the query plan cache — so it must be a plain positive integer, and
     * anything else falls back to the caller's documented default rather than
     * reaching the server.
     *
     * @inner
     * @param {*}      limit - Caller value.
     * @param {number} dflt  - Fallback.
     * @returns {number}
     */
    var safeLimit = function(limit, dflt) {
        return ( Number.isSafeInteger(limit) && limit > 0 ) ? limit : dflt;
    };

    // ─── Index bootstrap ─────────────────────────────────────────────────────

    /**
     * Ensure the two secondary indexes exist — eager and fire-and-forget (the
     * mongodb job-store precedent): no operation waits on it.
     *
     * Existence is probed through `system:indexes` rather than relying on
     * `CREATE INDEX IF NOT EXISTS`, whose availability depends on the server
     * version this store has no way to require. The probe covers both
     * keyspace shapes: on the default collection `keyspace_id` IS the bucket
     * and `bucket_id` is missing; on a named collection the three ids are
     * bucket / scope / collection.
     *
     * A failure here is NOT fatal — an operator whose credentials cannot
     * create indexes is a normal deployment — but it is logged with the exact
     * DDL to run by hand, because the consequence is not "slower queries": an
     * unindexed query ERRORS, and the periodic sweep's bare call would
     * swallow that error forever. Every query verb therefore logs its own
     * failures too.
     *
     * @inner
     * @returns {void}
     */
    var ensureIndexes = function() {
        var names = INDEXES.map(function(i) { return '"' + i.name + '"'; }).join(', ');
        var probe = 'SELECT name FROM system:indexes'
            + ' WHERE name IN [' + names + ']'
            + ' AND ( (bucket_id IS MISSING AND keyspace_id = $1)'
            + ' OR (bucket_id = $1 AND scope_id = $2 AND keyspace_id = $3) )';

        runQuery(probe, [bucketName, scopeName, collectionName], function(err, rows) {
            if (err) {
                return console.warn('[CouchbaseStorageStore] could not inspect system:indexes (bundle: ' + bundle
                    + ', driver: ' + driverName + '): ' + ((err && err.message) || err)
                    + ' — create these by hand if queries fail: ' + ddlLines().join(' ; '));
            }
            var have = {};
            (rows || []).forEach(function(r) { if (r && r.name) { have[r.name] = true; } });
            INDEXES.forEach(function(idx) {
                if (have[idx.name]) { return; }
                var ddl = 'CREATE INDEX `' + idx.name + '` ON ' + keyspace + idx.fields;
                runQuery(ddl, [], function(createErr) {
                    if (createErr) {
                        // IndexExistsError is the benign race: a sibling
                        // process created it between the probe and here.
                        if ( isCbError(createErr, 'IndexExistsError') ) { return; }
                        console.warn('[CouchbaseStorageStore] could not create index `' + idx.name + '` (bundle: '
                            + bundle + ', driver: ' + driverName + '): ' + ((createErr && createErr.message) || createErr)
                            + ' — run it by hand: ' + ddl);
                    }
                });
            });
        });
    };

    /**
     * The DDL for every index this store needs — surfaced in log lines so an
     * operator can create them by hand.
     *
     * @inner
     * @returns {string[]}
     */
    var ddlLines = function() {
        return INDEXES.map(function(idx) {
            return 'CREATE INDEX `' + idx.name + '` ON ' + keyspace + idx.fields;
        });
    };

    ensureIndexes();

    // ─── Statements ──────────────────────────────────────────────────────────
    //
    // Composed once. Every VALUE is a positional parameter; only the keyspace
    // (an identifier, which N1QL cannot bind) and the row limit are
    // interpolated, both from validated input.

    /**
     * `refs IS VALUED` is the LOAD-BEARING guard, not decoration: a
     * non-refcounted row carries no `refs` field at all, and this is what
     * keeps such rows structurally invisible to the GC sweep — the same role
     * the embedded store gets free from SQL's `NULL != 0`.
     *
     * @inner
     * @param {number} limit
     * @returns {string}
     */
    var zeroRefsStatement = function(limit) {
        return 'SELECT k FROM ' + keyspace
            + ' WHERE d = $1 AND refs IS VALUED AND refs = 0'
            + ' AND zeroAt IS VALUED AND zeroAt <= $2'
            + ' ORDER BY zeroAt LIMIT ' + limit;
    };

    /**
     * Key-ordered pagination, reserved dot-keys excluded — ordering by the
     * key is what keeps the cursor stable while the bundle keeps writing.
     *
     * @inner
     * @param {number} limit
     * @returns {string}
     */
    var keysStatement = function(limit) {
        return 'SELECT k FROM ' + keyspace
            + ' WHERE d = $1 AND k > $2 AND k NOT LIKE ".%"'
            + ' ORDER BY k LIMIT ' + limit;
    };

    /**
     * One aggregate pass for the operator surface. `IFMISSINGORNULL` is what
     * makes an EMPTY driver report zeroes rather than nulls (SUM over no rows
     * is NULL) — the embedded store's `COALESCE`.
     *
     * `inline` is BACKTICKED because it is a N1QL reserved word (#B356) — the
     * server refuses the whole statement with `at: inline (reserved word)`, so
     * `stats` was the one maintenance verb that could not parse against a real
     * cluster. Escaping it changes nothing else: a quoted alias still yields
     * the bare key `inline` in the result row, which `stats()` below reads.
     * The other four aliases are NOT reserved (checked against Couchbase's
     * reserved-word list, which is why they are left bare) and `§07` pins that
     * none of them silently becomes one.
     *
     * @inner
     * @type {string}
     */
    var statsStatement = 'SELECT COUNT(1) AS objects,'
        + ' IFMISSINGORNULL(SUM(CASE WHEN refs IS VALUED THEN 1 ELSE 0 END), 0) AS refcounted,'
        + ' IFMISSINGORNULL(SUM(CASE WHEN refs = 0 THEN 1 ELSE 0 END), 0) AS zeroRefPending,'
        + ' IFMISSINGORNULL(SUM(CASE WHEN data IS VALUED THEN 1 ELSE 0 END), 0) AS `inline`,'
        + ' IFMISSINGORNULL(SUM(size), 0) AS bytes'
        + ' FROM ' + keyspace
        + ' WHERE d = $1 AND k NOT LIKE ".%"';

    return {

        /**
         * Upsert `meta` under `key` — REPLACE semantics, exactly like the
         * embedded store's `INSERT OR REPLACE`.
         *
         * Never call this on a refcounted row: it would drop `refs`/`zeroAt`
         * and reset the count. `acquireRef` owns those rows.
         *
         * @param {string}      key
         * @param {StorageMeta} meta
         * @param {function}    [fn] - `fn(err, meta)`.
         * @returns {void}
         */
        set: function(key, meta, fn) {
            fn = settleOnce('couchbase:storage#set', fn, console);
            meta = meta || {};
            var d = docIdFor(key);
            if (d.error) { return fn(d.error); }
            withCollection(function(coll) {
                return coll.upsert(d.id, buildDoc(key, meta, false), withDurability())
                    .then(function() { fn(null, meta); });
            }, fn);
        },

        /**
         * Fetch metadata by `key`.
         *
         * @param {string}   key
         * @param {function} fn - `fn(err, meta|null)`; `null` when the key is unknown.
         * @returns {void}
         */
        get: function(key, fn) {
            fn = settleOnce('couchbase:storage#get', fn, console);
            var d = docIdFor(key);
            if (d.error) { return fn(d.error); }
            withCollection(function(coll) {
                return coll.get(d.id)
                    .then(function(res) { fn(null, metaFromDoc(res.content, true)); })
                    .catch(function(err) {
                        if ( isCbError(err, 'DocumentNotFoundError') ) { return fn(null, null); }
                        fn(err);
                    });
            }, fn);
        },

        /**
         * Delete metadata by `key`.
         *
         * @param {string}   key
         * @param {function} [fn] - `fn(err, existed)`.
         * @returns {void}
         */
        remove: function(key, fn) {
            fn = settleOnce('couchbase:storage#remove', fn, console);
            var d = docIdFor(key);
            if (d.error) { return fn(d.error); }
            withCollection(function(coll) {
                return coll.remove(d.id, withDurability())
                    .then(function() { fn(null, true); })
                    .catch(function(err) {
                        if ( isCbError(err, 'DocumentNotFoundError') ) { return fn(null, false); }
                        fn(err);
                    });
            }, fn);
        },

        /**
         * Atomically take one reference on `key` — insert-or-increment.
         *
         * Missing row: inserted with `meta` and `refs` = 1 (`created: true`);
         * a concurrent insert loses on `DocumentExistsError` and retries into
         * the increment branch. Existing refcounted row: `refs` incremented
         * and `zeroAt` cleared (a blob inside the GC grace window is
         * resurrected), with the INCOMING meta ignored — first-write-wins.
         *
         * Atomicity is Couchbase's CAS: the read's CAS token guards the
         * sub-document mutation, so an interleaved writer invalidates this
         * attempt rather than silently overwriting it.
         *
         * A row that exists but carries NO `refs` is REFUSED loudly rather
         * than adopted: it belongs to something else (a `sharded` row, or the
         * `.driver` stamp), and quietly stamping a refcount onto it would
         * corrupt that owner's data. The embedded store gets the same
         * loudness from its PRIMARY KEY conflict.
         *
         * @param {string}      key  - The blob key.
         * @param {StorageMeta} meta - Metadata for the CREATE case (may carry `data`).
         * @param {function}    [fn] - `fn(err, {created: boolean, refs: number, meta: StorageMeta})`.
         * @returns {void}
         */
        acquireRef: function(key, meta, fn) {
            fn = settleOnce('couchbase:storage#acquireRef', fn, console);
            meta = meta || {};
            var d = docIdFor(key);
            if (d.error) { return fn(d.error); }

            withCollection(function(coll) {
                var attempt = function(n) {
                    if ( n >= MAX_CAS_ATTEMPTS ) { return fn(contentionError('acquireRef', key)); }

                    coll.get(d.id).then(function(res) {
                        var doc = res.content;
                        if ( typeof doc.refs !== 'number' ) {
                            return fn(new Error('[CouchbaseStorageStore] acquireRef(`' + key + '`) refuses to adopt an '
                                + 'existing non-refcounted row — it belongs to another strategy (or is the `.driver` '
                                + 'stamp), and taking a reference on it would corrupt its owner'));
                        }
                        var next = doc.refs + 1;
                        return coll.mutateIn(d.id, [
                            couchbase.MutateInSpec.upsert('refs', next),
                            couchbase.MutateInSpec.upsert('zeroAt', null)
                        ], withDurability({ cas: res.cas })).then(function() {
                            fn(null, {
                                created : false,
                                refs    : next,
                                meta    : {
                                    originalName : ( typeof doc.originalName === 'string' ) ? doc.originalName : null,
                                    contentType  : ( typeof doc.contentType === 'string' ) ? doc.contentType : null,
                                    size         : ( typeof doc.size === 'number' ) ? doc.size : null,
                                    createdAt    : ( typeof doc.createdAt === 'number' ) ? doc.createdAt : null,
                                    refs         : next
                                }
                            });
                        }).catch(function(err) {
                            if ( isCbError(err, 'CasMismatchError') || isCbError(err, 'DocumentNotFoundError') ) {
                                return backoff(n, function() { attempt(n + 1); });
                            }
                            fn(err);
                        });
                    }).catch(function(getErr) {
                        if ( !isCbError(getErr, 'DocumentNotFoundError') ) { return fn(getErr); }
                        coll.insert(d.id, buildDoc(key, meta, true), withDurability())
                            .then(function() { fn(null, { created: true, refs: 1, meta: meta }); })
                            .catch(function(insErr) {
                                if ( isCbError(insErr, 'DocumentExistsError') ) {
                                    return backoff(n, function() { attempt(n + 1); });
                                }
                                fn(insErr);
                            });
                    });
                };
                attempt(0);
            }, fn);
        },

        /**
         * Atomically drop one reference on `key`.
         *
         * Floors at 0 and stamps `zeroAt` at the 1 → 0 transition — the
         * timestamp the GC grace window reads. Both fields move in ONE
         * `mutateIn`, which applies all-or-none, so the invariant (`zeroAt`
         * non-null exactly when `refs === 0`) can never be observed broken.
         *
         * A missing, non-refcounted, or already-zero row answers
         * `{existed: false}`: the reference the caller wanted to drop was
         * already gone, which is the outcome they asked for.
         *
         * @param {string}   key  - The blob key.
         * @param {function} [fn] - `fn(err, {existed: boolean, refs: number})` — `refs` is the
         *                          count AFTER the decrement.
         * @returns {void}
         */
        releaseRef: function(key, fn) {
            fn = settleOnce('couchbase:storage#releaseRef', fn, console);
            var d = docIdFor(key);
            if (d.error) { return fn(d.error); }

            withCollection(function(coll) {
                var attempt = function(n) {
                    if ( n >= MAX_CAS_ATTEMPTS ) { return fn(contentionError('releaseRef', key)); }

                    coll.get(d.id).then(function(res) {
                        var doc = res.content;
                        if ( typeof doc.refs !== 'number' || doc.refs < 1 ) {
                            return fn(null, { existed: false, refs: ( typeof doc.refs === 'number' ) ? doc.refs : 0 });
                        }
                        var next = doc.refs - 1;
                        return coll.mutateIn(d.id, [
                            couchbase.MutateInSpec.upsert('refs', next),
                            couchbase.MutateInSpec.upsert('zeroAt', ( next === 0 ) ? Date.now() : null)
                        ], withDurability({ cas: res.cas })).then(function() {
                            fn(null, { existed: true, refs: next });
                        }).catch(function(err) {
                            if ( isCbError(err, 'CasMismatchError') || isCbError(err, 'DocumentNotFoundError') ) {
                                return backoff(n, function() { attempt(n + 1); });
                            }
                            fn(err);
                        });
                    }).catch(function(getErr) {
                        if ( isCbError(getErr, 'DocumentNotFoundError') ) {
                            return fn(null, { existed: false, refs: 0 });
                        }
                        fn(getErr);
                    });
                };
                attempt(0);
            }, fn);
        },

        /**
         * Keys whose refcount has sat at 0 since before `olderThanMs` —
         * oldest first, at most `limit`.
         *
         * Non-refcounted rows carry no `refs` field, which `refs IS VALUED`
         * excludes, so they are structurally invisible here.
         *
         * @param {number}   olderThanMs - Epoch ms cutoff (typically now − grace).
         * @param {number}   limit       - Batch cap.
         * @param {function} fn          - `fn(err, string[])`.
         * @returns {void}
         */
        listZeroRefs: function(olderThanMs, limit, fn) {
            fn = settleOnce('couchbase:storage#listZeroRefs', fn, console);
            runQuery(zeroRefsStatement(safeLimit(limit, 100)), [driverName, olderThanMs], function(err, rows) {
                if (err) {
                    // The sweep's own call passes no callback, so an error
                    // that only travelled through `fn` would vanish and GC
                    // would appear to work forever while collecting nothing.
                    console.error('[CouchbaseStorageStore] listZeroRefs failed (bundle: ' + bundle + ', driver: '
                        + driverName + '): ' + ((err && err.message) || err)
                        + ' — if this names a missing index, run: ' + ddlLines()[0]);
                    return fn(err);
                }
                fn(null, rows.map(function(r) { return r.k; }));
            });
        },

        /**
         * Delete the row ONLY IF its refcount is still 0 — the sweep's claim
         * step, and the reason concurrent sweeps across processes are safe
         * without an election: the CAS guard makes exactly one claim win.
         *
         * A concurrent `acquireRef` resurrection wins the same way: it moves
         * the document's CAS, this guarded remove reports `CasMismatchError`,
         * and the sweep skips the blob.
         *
         * @param {string}   key  - The blob key.
         * @param {function} [fn] - `fn(err, removed: boolean)`.
         * @returns {void}
         */
        removeIfZero: function(key, fn) {
            fn = settleOnce('couchbase:storage#removeIfZero', fn, console);
            var d = docIdFor(key);
            if (d.error) { return fn(d.error); }

            withCollection(function(coll) {
                return coll.get(d.id).then(function(res) {
                    if ( res.content.refs !== 0 ) { return fn(null, false); }
                    return coll.remove(d.id, withDurability({ cas: res.cas }))
                        .then(function() { fn(null, true); })
                        .catch(function(err) {
                            // Both mean somebody else got there first — a
                            // resurrection (CAS moved) or another sweeper
                            // (document gone). Neither is an error.
                            if ( isCbError(err, 'CasMismatchError') || isCbError(err, 'DocumentNotFoundError') ) {
                                return fn(null, false);
                            }
                            fn(err);
                        });
                }).catch(function(getErr) {
                    if ( isCbError(getErr, 'DocumentNotFoundError') ) { return fn(null, false); }
                    fn(getErr);
                });
            }, fn);
        },

        /**
         * Aggregate counts over this driver's rows — the `storage:stats`
         * operator surface. Reserved dot-key rows (the `.driver` stamp) are
         * excluded, so an empty root reports zero objects.
         *
         * @param {function} fn - `fn(err, {objects, refcounted, zeroRefPending, inline, bytes})`.
         * @returns {void}
         */
        stats: function(fn) {
            fn = settleOnce('couchbase:storage#stats', fn, console);
            runQuery(statsStatement, [driverName], function(err, rows) {
                if (err) {
                    console.error('[CouchbaseStorageStore] stats failed (bundle: ' + bundle + ', driver: '
                        + driverName + '): ' + ((err && err.message) || err));
                    return fn(err);
                }
                var row = rows[0] || {};
                fn(null, {
                    objects        : row.objects || 0,
                    refcounted     : row.refcounted || 0,
                    zeroRefPending : row.zeroRefPending || 0,
                    inline         : row.inline || 0,
                    bytes          : row.bytes || 0
                });
            });
        },

        /**
         * Page over this driver's object keys, ordered by key — the
         * enumeration `storage:verify` walks for its rows-without-files
         * direction. Reserved dot-key rows are excluded.
         *
         * @param {string}   afterKey - Exclusive lower bound (`''` for the first page).
         * @param {number}   limit    - Page size cap.
         * @param {function} fn       - `fn(err, string[])`.
         * @returns {void}
         */
        listKeys: function(afterKey, limit, fn) {
            fn = settleOnce('couchbase:storage#listKeys', fn, console);
            runQuery(
                keysStatement(safeLimit(limit, 500)),
                [driverName, ( typeof afterKey === 'string' ) ? afterKey : ''],
                function(err, rows) {
                    if (err) {
                        console.error('[CouchbaseStorageStore] listKeys failed (bundle: ' + bundle + ', driver: '
                            + driverName + '): ' + ((err && err.message) || err)
                            + ' — if this names a missing index, run: ' + ddlLines()[1]);
                        return fn(err);
                    }
                    fn(null, rows.map(function(r) { return r.k; }));
                }
            );
        },

        /**
         * Release the cluster connection. NOT called on the request path —
         * provided for teardown and tests.
         *
         * @returns {void}
         */
        close: function() {
            try {
                if ( cluster && typeof cluster.close === 'function' ) {
                    var p = cluster.close();
                    if ( p && typeof p.catch === 'function' ) { p.catch(noop); }
                }
            } catch (e) { /* already closed */ }
        }
    };
};
