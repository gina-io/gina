/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib
 * @description Central registry that loads and exposes every framework library.
 * Assigned to the global `lib` variable on first require so all framework code
 * can access `lib.merge`, `lib.Collection`, etc. without an explicit `require`.
 *
 * @package    gina.framework
 * @namespace  lib
 * @author     Rhinostone <contact@gina.io>
 */

//var merge = require('./merge');

/**
 * Library registry constructor — returns a plain object `self`, not `this`.
 * Consumed via `lib = new Lib()` in `gna.js`.
 *
 * @class Lib
 * @constructor
 */
function Lib() {


    var _require = function(path) {

        var cacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;
        if (cacheless) {
            delete require.cache[require.resolve(path)];
            return require(path)
        } else {
            return require(path)
        }
    }



    var self = {
        Config          : _require('./config'),
        //dev     : require('./lib/dev'),//must be at the same level than gina.lib => gina.dev
        inherits        : _require('./inherits'),
        helpers         : _require('./../helpers'),
        //this one must move to Dev since it's dev related
        Domain          : _require('./domain'),
        Model           : _require('./model'),
        // #B32-residual (measured 2026-06-16) — plain require, NOT _require.
        // Collection/merge/uuid are stateless leaf utilities new'd per request from
        // gen-0 bindings captured in load-once modules (server.isaac.js:34
        // `const Collection = lib.Collection`, used per request at :853 in onPath).
        // With _require they are evicted from require.cache every refreshCore(), so each
        // per-request `new Collection()` is a cache-miss that pushes a fresh merge/uuid
        // child Module onto the gen-0 (evicted-but-retained) collection Module — which
        // pruneDeadModuleChildren() never reaches (it walks require.cache keys only),
        // accumulating ~2 dead Modules/request (dev-mode OOM). Plain require = never
        // evicted = cache-hit = Node dedupes the children = flat. Verified standalone:
        // gen-0 collection .children 0->1000 over 500 reqs with _require, pinned at 2
        // with require. Same precedent as logger/job/State/instrument below.
        Collection      : require('./collection'),
        merge           : require('./merge'),
        generator       : _require('./generator'),//move to gina.dev
        Proc            : _require('./proc'),
        Shell           : _require('./shell'),
        // replaced: _require('./logger') — Logger is a singleton persisted via getContext('loggerInstance').
        // refreshCore() (server.isaac.js) re-runs Lib() on every dev-mode HTTP request by deleting and
        // re-requiring lib/index.js. _require would then delete logger from require.cache and re-require it,
        // calling Logger() again → "Logger instance already exists: reusing it ;)" once per request (#4).
        // Logger hot-reload is unnecessary: the singleton state survives through getContext regardless of
        // module eviction, and Logger() returns the existing instance anyway. Use plain require (cache hit).
        logger          : require('./logger'),
        math            : _require('./math'),
        // #FIN5 — exact-money primitive (ISO 4217 minor-unit BigInt arithmetic).
        // Pure stateless functions, no singleton, no adopted fds: _require so a
        // dev-mode edit hot-reloads like math/routing.
        money           : _require('./money'),
        // #B489 — multipart/form-data body encoder (the request parser's inverse,
        // for query()'s `body` option / forward()'s upload relay). Pure stateless
        // functions over fs reads, no singleton, no adopted fds: _require like money.
        multipart       : _require('./multipart'),
        routing         : _require('./routing'),
        // #B32-residual — plain require: archiver is a `new Archiver()` EventEmitter
        // SINGLETON (`module.exports = new Archiver()` at the tail of archiver/src/main.js;
        // since #B473 every compress()/decompress() call settles on its own per-call
        // channel INSIDE that singleton, so the instance itself must stay shared and
        // resident). _require re-instantiated it every
        // refreshCore() (per-request churn) and left each prior instance pinned via the
        // gen-0 lib registry — it was the named instance in the leak's heap snapshot.
        // A singleton must not hot-reload (same reason as logger/job/State/instrument).
        archiver        : require('./archiver'),
        cmd             : _require('./cmd'),
        SessionStore    : _require('./session-store'),
        // #AI6 — connector-backed job-store factory (lib/job `start({store})`).
        // Stateless dispatcher invoked ONCE at boot from gna.js; _require like
        // SessionStore (no instance/singleton state to protect from eviction).
        JobStore        : _require('./job-store'),
        // render-cache Slice 4 — connector-backed L2 store factory for
        // lib/render-cache's redis strategy. Stateless dispatcher invoked ONCE
        // at boot from gna.js (the built store is stashed on
        // process.gina._renderCacheStore); _require like JobStore/SessionStore.
        RenderCacheStore : _require('./render-cache-store'),
        // #COMPLY2 — connector-backed audit-store factory (lib/audit `start({store})`).
        // Stateless dispatcher invoked ONCE at boot from core/server.js; _require
        // like JobStore/SessionStore (no instance/singleton state to protect from
        // eviction). No connector ships an implementation yet — demand-gated.
        AuditStore      : _require('./audit-store'),
        // #STO1 — connector-backed storage metadata-store factory (lib/storage
        // `start({stores})`). Stateless dispatcher invoked ONCE at boot from
        // gna.js; _require like JobStore/AuditStore (no instance/singleton state
        // to protect from eviction). No connector ships an implementation yet —
        // demand-gated, the audit-store shipping order.
        StorageStore    : _require('./storage-store'),
        // #KV1 — connector-backed KV namespace-store factory (lib/kv,
        // `settings.kv.namespaces.<name>.store`). Stateless dispatcher invoked
        // once per store-backed namespace at boot; _require like JobStore /
        // StorageStore. No connector ships an implementation yet — naming one
        // refuses the boot (the audit-store shipping order).
        KvStore         : _require('./kv-store'),
        SwigFilters     : _require('./swig-filters'),
        Cache           : require('./cache'),    // #B32-residual — plain require (leaf class held at gen-0 via server.isaac.js:35; Cache._events is a Collection). See Collection note above.
        RenderCache     : require('./render-cache'), // #B32-residual — plain require (server-only render-cache strategy dispatcher; wraps lib/cache and is held at gen-0 in server.isaac.js + the render delegates). See Cache above.
        uuid            : require('./uuid'),      // #B32-residual — plain require (pushed as a child of the gen-0 collection module per `new Collection()`). See Collection note above.
        // #R1 — WatcherService: fs.watch-based file-change registry. Class is hot-reloadable;
        // instantiated once per bundle in gna.js:onStarted and stored as gna.watcher.
        Watcher         : _require('./watcher'),
        // #M4 — Promise adapter for .onComplete() EventEmitter callbacks.
        // Enables async/await in controller actions without rewriting entities.
        async           : _require('./async'),
        // #I18N1 — Internationalisation primitives. Per-bundle JSON catalogs,
        // fallback chain (specific → base → settings.region.culture →
        // GINA_CULTURE → 'en'), CLDR plural via Intl.PluralRules,
        // {name}-style interpolation. Backs gna.t(), self.t(), and the
        // swig/nunjucks `t` filter (slice 2). Catalogs land at
        // process.gina._i18nCatalogs[bundleName][culture].
        i18n            : _require('./i18n'),
        // #OBS1 — Prometheus metrics primitive. Wraps prom-client (peer dep,
        // loaded from project node_modules — same shape as mysql/postgres/AI
        // SDK connectors). Backs the /_gina/metrics endpoint and the request
        // lifecycle hook that populates the HTTP counter + histogram. Opt-in
        // via app.json `metrics.enabled`.
        metrics         : _require('./metrics'),
        // #S7 — admin /_gina/* IP-allowlist gate (isClientAllowed). Functional
        // sibling of metrics above, but a PLAIN require (NOT _require): a
        // stateless pure-function leaf with no instance/singleton state to
        // hot-reload — same #B32-residual precedent as merge / uuid / Collection.
        admin           : require('./admin'),
        // #MAINT1 — maintenance-mode primitive backing the pre-routing gate on
        // BOTH engines: config resolve/lint, constant-time bypass-key check,
        // stateless HMAC bypass cookie, and the proxy-aware IP adjudication.
        // PLAIN require (NOT _require) for the same reason as admin above: a
        // stateless pure-function leaf with no state to hot-reload — and it is
        // security-bearing, which keeps it out of the hot-reload path entirely
        // (the lib/authn precedent).
        maintenance     : require('./maintenance'),
        // #OW1 — engine-agnostic security-header emission (OWASP A02). The
        // #HDR1-14 plugins are express middleware, and the DEFAULT engine
        // (isaac) never runs the express chain for HTTP responses, so a mounted
        // orchestrator emits nothing there; this is the framework-side twin, in
        // the same shape as the #HDR8 hidePoweredBy gate.
        // PLAIN require (NOT _require) for the same reason as admin/maintenance
        // above: a stateless pure-function leaf with no state to hot-reload, and
        // security-bearing, which keeps it out of the hot-reload path entirely.
        securityHeadersEmitter : require('./security-headers-emitter'),
        // #OW3 — Subresource Integrity attribute computation (OWASP A08),
        // consumed by the controller's resource builder when a bundle opts in
        // via templates.json `"sriEnabled": true`. PLAIN require (NOT _require):
        // security-bearing like the emitter/authn precedent above, and it holds
        // a module-scope stat-validated hash cache that a per-request re-require
        // would pointlessly discard (the cache can never go stale — every
        // lookup re-stats the file — so surviving reloads costs nothing).
        sri             : require('./sri'),
        // #AI6 — Async-job primitive. Holds an in-memory job registry, a
        // concurrency-limited worker, and a self-contained unref'd setInterval
        // sweep timer at module scope. Like State / logger below, it MUST use a
        // plain require (not _require): refreshCore() re-runs Lib() on every
        // dev-mode HTTP request, and _require would delete + re-require the
        // module, discarding the live registry and orphaning the sweep timer on
        // each request. Plain require = cache hit = the singleton survives.
        job             : require('./job'),
        // #B366 — out-of-request push primitive, behind the gina.pushToSession()
        // global. Stateless (the caller hands it the live server instance), but a
        // PLAIN require (NOT _require) for the authzGate/authn reason: gna.js is
        // load-once and captures this binding at boot, so a _require'd copy would
        // be evicted and re-required out from under that gen-0 capture on every
        // dev-mode request — the #B32-residual leak class. It also keeps the
        // primitive that chooses a push recipient out of the hot-reload path.
        push            : require('./push'),
        // #INS10 — toggleable instrumentation window primitive. Owns the
        // time-boxed Inspector capture window (process.gina._inspectorWindowUntil)
        // and its unref'd expiry timer. PLAIN require (like job / State / logger):
        // refreshCore() re-runs Lib() on every dev-mode HTTP request, and _require
        // would delete + re-require the module, discarding the live window deadline
        // and orphaning the expiry timer. Plain require = cache hit = the singleton
        // and its timer survive.
        instrument      : require('./instrument'),
        // #RW1 — stale built-release watch primitives: source-tree fingerprints
        // (stamped by bundle:build / project:build into the manifest release
        // records), change classification, the recursive tree watcher, busy
        // probes and the in-flight request gauge. PLAIN require (like job /
        // instrument / State): the module holds live fs.watch handles, the
        // probe registry and the gauge at module scope — hot-reloading it would
        // orphan the handles and zero the gauge on every dev-mode request.
        releaseWatch    : require('./release-watch'),
        // replaced: _require('./state') — StateStore is a singleton backed by node:sqlite
        // (DatabaseSync). Hot-reloading it in dev mode would close and re-open the DB
        // connection on every HTTP request, racing with in-flight writes. Use plain
        // require() so the singleton survives refreshCore() evictions. (#CN2v3)
        State           : require('./state'),
        // Native schema/DTO builder (#DTO). require() — NOT _require — so the
        // DtoObject / DtoField constructors keep a stable identity across
        // refreshCore() hot-reload (a bundle registers named DTOs at boot on
        // process.gina._dtos; per-request `instanceof` / registry lookups must
        // still recognise them). The builder itself is stateless.
        dto             : require('./dto'),
        // #DTO2 — the default-on request-payload validation pipe, run by core/router.js
        // before the controller action. require() — NOT _require — so the module never
        // re-evaluates its module-scope capture of the validator plugin per request
        // (a load-once module performing no per-request require() can never grow a
        // dead-`children` tail; #B32-residual).
        dtoPipe         : require('./dto-pipe'),
        // #COMPLY1 — the default-on route authorization gate, run by core/router.js
        // before the DTO pipe and the controller action. require() — NOT _require —
        // for the same reason as dtoPipe above: a load-once module performing no
        // per-request require() can never grow a dead-`children` tail (#B32-residual).
        // It also keeps a security gate out of the dev-mode hot-reload path entirely.
        authzGate       : require('./authz-gate'),
        // #MS6 — identified-caller quota gate, run by core/router.js between the
        // authz gate and the DTO pipe. require() — NOT _require — for the same
        // reason as dtoPipe/authzGate above: router-bound, load-once, no
        // per-request require() (#B32-residual), and its policy/state live on the
        // engine instance + in the kv store, so hot-reload would gain nothing.
        rateLimit       : require('./rate-limit'),
        // #FIN6 — Idempotency-Key dedup gate. PLAIN require, like rate-limit:
        // router-bound, stateless (state lives in the kv namespace).
        idempotency     : require('./idempotency'),
        // #FIN3 — message-schema validation seam (application-supplied validators).
        // PLAIN require, like rate-limit/idempotency: router-bound, load-once, and
        // its registry lives on process.gina (survives refreshCore, dies on restart).
        messageValidator : require('./message-validator'),
        // #COMPLY3 — authentication hardening primitives (password hashing +
        // verification, password policy, lockout, TOTP). require() — NOT _require —
        // for the authzGate reason above: a security primitive stays out of the
        // dev-mode hot-reload path entirely. It also holds module-scope state the
        // hot-reload would discard on every dev request: the scrypt concurrency
        // gauge and its FIFO queue (a discarded queue strands in-flight logins).
        authn           : require('./authn'),
        // #COMPLY2 — the audit-trail primitive behind self.audit() and the authz
        // auto-events. Holds the boot-adopted store (an open O_APPEND fd for the
        // default file backend), the serialized write queue and the written/dropped
        // counters at module scope. Like job / State / logger above, it MUST use a
        // plain require (not _require): refreshCore() re-runs Lib() on every
        // dev-mode HTTP request, and _require would discard the adopted store and
        // leak the fd on each request. Plain require = cache hit = the singleton
        // survives.
        audit           : require('./audit'),
        // #DTO3 — the DTO -> TypeScript declaration emitter. Pure and CLI-only
        // (consumed by the offline `bundle:types`), so the dev-mode-hot-reloadable
        // _require is safe — same shape as routingIntrospect below.
        dtoTypes        : _require('./dto-types'),
        // Shared semantic extractor for routing.json. Consumed by bundle:openapi
        // and bundle:mcp to parse URL patterns, methods, requirements, and derive
        // stable tool / operation identifiers.
        routingIntrospect: _require('./routing-introspect'),
        // #EVTBUS — observable application-event emit hook (self.emitEvent /
        // lib.inspectorEvents.emit). Stateless (no module-scope state beyond a
        // best-effort counter), so the dev-mode-hot-reloadable _require is safe.
        inspectorEvents : _require('./inspector-events'),
        // Shared run-state / port display primitives (pad, pickPreferredPort,
        // readPidfile) for the bundle:list / service:list / bundle:status /
        // project:status CLI handlers. Pure (same contract as routing-introspect).
        cmdStatusFormat : _require('./cmd-status-format'),
        // #B160 — control-plane dial-host resolution: is host_v4 one of this
        // machine's own interfaces, and which address should a CLI-side client
        // dial (`bind_host` vs `host_v4`)? Pure + stateless (only reads
        // os.networkInterfaces()), so the dev-mode-hot-reloadable _require is
        // safe — same contract as routing-introspect above.
        netLocality     : _require('./net-locality'),
        // Single source of truth for the connector driver → npm package + semver
        // range mapping. Consumed by the connector:* CLI handlers (connector:add
        // install hint + connector:add --install range resolution + connector:list
        // driver introspection).
        connectorRegistry: _require('./connector-registry'),
        // Pure connector-entry resolver (merge shared+bundle connectors.json,
        // bundle wins; select by name; AI-subtype detection). Consumed by the
        // connector:* runtime CLI handlers (connector:infer) to resolve a
        // single connector conf outside a request. Returns a fresh entry so the
        // caller can run lib.secrets.resolve() on it in place. Pure (same
        // contract as connector-registry / cmd-status-format).
        connectorConfig : _require('./connector-config'),
        // #CE1 — transient-vs-permanent classifier for datastore query errors
        // (stamps err.isTransient / err.transientReason). PLAIN require, NOT
        // _require: the connectors capture `lib` at gen-0 (load-once) and invoke
        // stamp() per-request on the error path, so a _require'd copy would be a
        // #B32-residual leak candidate the moment this module gained any internal
        // require. Stateless + zero-dep, so a single never-evicted instance is
        // correct and hot-reload is unnecessary (connector code needs a restart).
        connectorError  : require('./connector-error'),
        // Comment-aware header/body splitter for JSON-with-comments config
        // files. firstStructuralBraceIndex / splitHeader find the first `{`
        // that is NOT inside a `//` or block comment, so a rewrite preserves a
        // leading comment header verbatim (the scaffolded connectors.json
        // template carries `// "couchbase": {` — a brace inside a comment).
        // Consumed by the connector:add / connector:rm / connector:migrate
        // handlers. Pure (same contract as cmd-status-format / routing-introspect).
        jsonConfigHeader: _require('./json-config-header'),
        // Pure OCI packaging primitives for the image:build CLI handler —
        // Containerfile synthesis, build-context staging, deterministic port
        // computation (bin/gina-init allocator replica) and container-host
        // descriptor resolution. Pure (same contract as cmd-status-format /
        // routing-introspect).
        imageBuild      : _require('./image-build'),
        // Pure resolver that picks between a project-installed @rhinostone/swig
        // (or swig-twig) and the framework's bundled copy. Opt-in via
        // settings.json > swig.useProject; default-off. Returns a decision
        // record — the caller performs the actual require.
        swigResolver    : _require('./swig-resolver'),
        // Detects project-installed `nunjucks` and caches on process.gina._nunjucks.
        // Opt-in via settings.json > render.engine === 'nunjucks'. No framework
        // fallback — load() throws NUNJUCKS_NOT_INSTALLED when the project has
        // not installed the package.
        nunjucksResolver: _require('./nunjucks-resolver'),
        // Per-request filter registry for the nunjucks render path. Mirror of
        // lib/swig-filters: same factory shape, same 7 public filters
        // (getUrl, getWebroot, length, nl2br, addHours, addDays, addYears).
        // Registered via env.addFilter() in render-nunjucks.js per request.
        nunjucksFilters: _require('./nunjucks-filters'),
        // #TPL1 — Async template-loader extension point. Builds a built-in
        // loader (memory; http in a later slice) from its flat
        // settings.template.<engine>.loader config and wraps it with a
        // CVE-2023-25345 segment-guard. Consumed by initSwigEngine (startup
        // build + validation) and controller.render-swig-async.js. Pure factory
        // (no singleton state), so _require (hot-reloadable) is safe.
        templateLoaders : _require('./template-loaders'),
        // #AI8b — MCP server primitives (JSON-RPC 2.0 framing, lifecycle,
        // method handlers). Transport-agnostic; wired to stdio by bundle:mcp-start.
        mcpServer       : _require('./mcp-server'),
        // #AI8b — HTTP loopback dispatcher. Translates MCP tools/call into a
        // real request against the running bundle's configured port.
        mcpDispatch     : _require('./mcp-dispatch'),
        // #AI8 Phase 2b — MCP Streamable HTTP transport. Wraps an mcpServer
        // instance with an HTTP endpoint (POST, JSON/SSE negotiation, batch,
        // Mcp-Session-Id lifecycle). Auth / Origin checks land in Phase 2b S2.
        mcpHttp         : _require('./mcp-http'),
        // ${secret:KEY} placeholder resolver for bundle JSON configs. Walks
        // the merged config object in place at config-load time (per-bundle,
        // inside loadBundleConfig). Default backend reads process.env[KEY];
        // fail-closed on unset/empty values. See lib/secrets/src/main.js.
        secrets         : _require('./secrets'),
        // #H13 — RFC 6455 WebSocket framing codec (frame encoder + incremental
        // parser: fragmentation reassembly, masking enforcement, UTF-8 and
        // close-code validation, maxPayload/maxFragments caps). Transport-
        // agnostic; the WebSocket-over-HTTP/2 session bridge feeds it
        // extended-CONNECT stream bytes. Pure factory (per-connection parser
        // instances, no module-scope state), so _require (hot-reloadable) is safe.
        wsFraming       : _require('./ws-framing'),
        // #H13 — WebSocket-over-HTTP/2 session bridge. accept(request) answers
        // the extended CONNECT with :status 200 and wraps the raw Http2Stream
        // + a ws-framing parser into a send/ping/close session (auto-pong,
        // timed close handshake, teardown on stream close/error, graceful-
        // shutdown drain registration). Consumed by the Isaac engine's
        // onWebSocket dispatcher. Pure factory, so _require is safe.
        wsSession       : _require('./ws-session'),
        // #H13 slice 3b — cross-bundle session.query() for WS channel handlers.
        // build(app, bundle, env) → query(options[, data]) → Promise: reuses the
        // framework controller's hardened HTTP/1+HTTP/2 client (fresh controller
        // per call) against the live server's warm session cache, mirroring a
        // controller's self.query(). The Isaac dispatcher attaches it to each
        // accepted session AFTER lib.wsSession.accept (so ws-session stays
        // controller-free). Pure factory (no module-scope state), so _require is safe.
        wsQuery         : _require('./ws-query'),
        // #STO1 — pluggable object storage (adapter x strategy). PLAIN require,
        // NOT _require: the module holds the built drivers and their open SQLite
        // metadata handles at module scope. refreshCore() re-runs Lib() on every
        // dev-mode HTTP request, and _require would delete + re-require the
        // module, discarding the drivers and leaking a file handle per request —
        // the same reason job / State / audit are plain requires. Plain require =
        // cache hit = the singleton survives.
        storage         : require('./storage'),
        // #KV1 — general-purpose KV primitive (strict-declared namespaces
        // behind gina.kv()). PLAIN require, like job / State / logger /
        // storage: a singleton holding the namespace registry and per-
        // namespace sweep timers — it must survive dev-mode refreshCore(),
        // and re-requiring it would orphan live timers and state.
        kv              : require('./kv'),
    };

    /**
     * Strip macOS dot-files (`.DS_Store`, `._*`, etc.) from a directory listing.
     *
     * @memberof module:lib
     * @param {string[]} files - Array of filenames from `fs.readdirSync`
     * @returns {string[]} Filtered array
     *
     * @deprecated Use once in `server.js`; TODO — remove entirely
     */
    self.cleanFiles = function(files){
        for(var f=0; f< files.length; f++){
            if(files[f].substring(0,1) == '.')
                files.splice(0,1);
        }
        return files;
    };



    return self
}
// Making it global
lib = new Lib();

/**
 * Bootstrap the command dispatcher when running inside the daemon process.
 * Sets Gina paths, seeds CLI options from the package manifest, and calls
 * `lib.cmd.onExec()` to start processing commands.
 *
 * @memberof module:lib
 * @param {object}  opt                    - Bootstrap options
 * @param {Array}   opt.argv               - `process.argv`-style argument array
 * @param {string}  opt.ginaPath           - Absolute path to gina root
 * @param {string}  opt.frameworkPath      - Absolute path to the framework version dir
 * @param {object}  opt.pack               - Package manifest (`version`, `copyright`)
 * @param {string}  opt.task               - CLI task name
 * @param {string}  opt.homedir            - User home directory
 * @param {object}  opt.client             - Socket client reference
 * @param {boolean} [opt.isFromFramework]  - `true` when invoked from framework internals
 * @returns {void}
 */
lib.cmd.load = function(opt){

    process.argv = opt.argv;

    //Set gina paths.
    setPath('gina.root', _(opt.ginaPath));
    setPath('framework', _(opt.frameworkPath));
    setPath('gina.core', _(opt.frameworkPath +'/core'));
    setPath('gina.home', opt.homedir);
    setPath('gina.lib', _(opt.frameworkPath +'/lib'));
    setPath('gina.helpers', _(opt.frameworkPath +'/helpers'));

    //Getting package.
    var p = opt.pack;

    //Setting default options.
    lib.cmd.setOption([
        {
            'name' : 'version',
            'content' : p.version
        },
        {
            'name' : 'copyright',
            'content' : p.copyright
        },
        {
            'name' : 'task',
            'content' : opt.task
        },
        {
            'name' : 'homedir',
            'content' : opt.homedir
        }
    ]);

    var isFromFramework = ( typeof(opt.isFromFramework) != 'undefined') ? true : false;
    lib.cmd.onExec(opt.client, isFromFramework, opt)
};

module.exports = lib