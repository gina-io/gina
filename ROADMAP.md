# Gina — Roadmap

This roadmap covers planned features, architectural improvements, new connectors, and AI integration. Items marked ✅ are shipped. All planned items are open to community contribution — see [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get involved.

> **Docs:** [gina.io/docs](https://gina.io/docs/) · **Issues:** [github.com/Rhinostone/gina/issues](https://github.com/Rhinostone/gina/issues)

---

## Timeline

| Period | Version | Focus |
| --- | --- | --- |
| **Apr 2026** | `0.1.8` ✅ | Scaffold correctness · K8s support · Dependency injection · Automatic version migration |
| **Q2 2026** | `0.2.0` | Stability · WatcherService · Redis & SQLite connectors · K8s session storage · Startup cache · Pointer compression · Couchbase v2 deprecation · Couchbase security & critical bug fixes · HTTP/2 security hardening |
| **Q3 2026** | `0.3.0` | Async/await · Dev hot-reload · MySQL & PostgreSQL connectors · AI Phase 2 · Tutorials · Mobile backend guide · Route radix tree · Connector peerDependencies · 103 Early Hints · HTTP/2 observability · Security & CVE page · Couchbase connector hardening |
| **Q4 2026** | `0.4.0` | TypeScript declarations · AI agents (OpenAPI, MCP) · ScyllaDB connector · PWA scaffold · Advanced tutorial · Website redesign · Docs offline ZIP · Bun investigation · Couchbase v2 removal · HTTP/2 hardening · Trailer support |
| **Q1 2027** | `0.5.0` | ESM support · Template engine migration · Structured logging · Alt-Svc · HTTP/2 priorities · WebSocket over HTTP/2 |
| **Q3 2027** | `1.0.0` | First stable release — Windows alpha compatibility is a hard gate |

---

## Features

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| ✅ | **Automatic version migration** — Upgrading or downgrading gina (e.g. `0.1.x → 0.2.0`, `0.5.x → 1.0.0`) automatically migrates `~/.gina/` config to the new version on first startup. Downgrade is free — old version data is never removed. | `0.1.8` | 2026-03-26 |
| 📋 | **`watchers.json`** — First-class bundle config for file watchers. Declare watchers on config files with event-based notification (no polling). Foundation for the dev-mode hot-reload system. | `0.2.0` | Q2 2026 |
| 📋 | **PWA scaffold** — `gina bundle:add` drops `manifest.json`, a service worker stub (`sw.js`), and the required `<meta>` / `<link>` tags into the bundle boilerplate. Zero runtime dependency. Enables Gina apps to be installed on mobile as PWAs without additional tooling. | `0.4.0` | Q4 2026 |

---

## Modernisation

### Phase 1 — Stability

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **Per-request controller instances** — Each HTTP request gets its own isolated controller instance with its own request state. Removes dead singleton infrastructure and fixes edge-case memory retention in error paths. | `0.2.0` | Q2 2026 |
| 📋 | **Entity `_arguments` buffer scoped to call** — Move the event result buffer from the entity to the individual call, preventing concurrent callers from sharing state. | `0.2.0` | Q2 2026 |
| ✅ | **Retire `freeMemory`** — Once per-request instances land (#M1), there is no shared `local` closure to null. Replace `freeMemory` call sites with explicit `local.req = null; local.res = null; local.next = null` at response exit points. | `0.2.0` | Q2 2026 |

### Phase 2 — Async

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **Promise adapter for entity calls** — `entityCall(emitter)` wraps the EventEmitter `.onComplete(cb)` pattern in a Promise. Controllers can switch to `async/await` immediately without rewriting entities. | `0.3.0` | Q3 2026 |
| 📋 | **Async controller actions** — Controller actions become `async function`. Single `try/catch` per action replaces ad-hoc error guards. | `0.3.0` | Q3 2026 |

### Phase 3 — Dev Tooling

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **File-watcher hot-reload** — Replace `delete require.cache` per-request with a `WatcherService` that evicts modules only on actual file change. Controllers and SQL files reload on save with zero per-request overhead. | `0.3.0` | Q3 2026 |
| 📋 | **SQL annotation parser** — Replace the single-pass regex for N1QL file parsing with a state-machine parser. Handles nested block comments and `--` in string literals correctly. | `0.3.0` | Q3 2026 |

### Phase 4 — DX

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **Explicit exports for global helpers** — `getContext`, `setContext`, `_`, `requireJSON` etc. available as explicit `require('gina/gna').getContext` imports alongside the existing global injection. Enables IDE navigation and static analysis. | `0.4.0` | Q4 2026 |
| 📋 | **TypeScript declaration files** — `.d.ts` declarations for the public surface: `SuperController`, `EntitySuper`, connector config shapes, `routing.json` schema. No TS migration of internals — just declarations for consumer projects. | `0.4.0` | Q4 2026 |

### Phase 5 — Future

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **ESM compatibility layer** — Dual CJS/ESM entry points via `"exports"` in `package.json`. Framework internals stay CJS; public API gets ESM re-exports. | `0.5.0` | Q1 2027 |
| 📋 | **Pluggable template engine** — Swig 1.4.2 stays fully integrated and remains the default. Nunjucks added as a supported alternative (opt-in per project via config). The render layer is abstracted behind a common interface so both engines co-exist. Switching to Nunjucks requires a per-project migration guide (breaking differences: `{% parent %}` → `{{ super() }}`, filter renames, autoescape default, `date` format strings, no `{% spaceless %}` — see docs). | `0.5.0` | Q1 2027 |
| 📋 | **Structured logging** — JSON log output (`{ level, message, bundle, requestId, durationMs }`). Additive — existing consumers are unaffected. Enables log aggregation (Loki, Datadog, CloudWatch). | `0.5.0` | Q1 2027 |
| 📋 | **Research `AsyncLocalStorage` for request context** — Evaluate `node:async_hooks` `AsyncLocalStorage` as a replacement for the `local` closure pattern, giving true async isolation across `setTimeout`, Promises, and `async/await` chains without any closure threading. Output: decision doc + proof-of-concept branch. | `0.5.0` | Q1 2027 |

---

## Connectors

New database connectors follow the same interface as the existing Couchbase connector: declared in `connectors.json`, acquired via `getConnection()`.

| Status | Connector | Version | Target | Notes |
| --- | --- | --- | --- | --- |
| ✅ | **Redis** | `0.2.0` | Q2 2026 | Session store and general-purpose cache. Client: `ioredis`. Required for K8s horizontal scaling. |
| 🔶 | **SQLite** | `0.2.0` | Q2 2026 | Three use cases: framework state storage (replaces JSON files under `~/.gina/`), session store for single-pod/dev deployments, and embedded ORM connector. Uses `node:sqlite` (Node.js built-in since v22.5.0 — zero npm deps). Session store done (v1); ORM and state storage deferred. |
| 📋 | **MySQL / MariaDB** | `0.3.0` | Q3 2026 | ORM connector. Client: `mysql2`. |
| 📋 | **PostgreSQL** | `0.3.0` | Q3 2026 | ORM connector. Client: `pg` (node-postgres). |
| 📋 | **ScyllaDB** | `0.4.0` | Q4 2026 | Cassandra-compatible wide-column store. Client: `@scylladb/scylla-driver`. |
| 📋 | **MongoDB** | `0.4.0` | Q4 2026 | Document store connector. Client: `mongodb` (official driver). Interface approach TBD — MongoDB's document model differs from the N1QL/SQL pattern used by existing connectors. |
| 📋 | **Couchbase SDK v2 deprecation** | `0.2.0` | Q2 2026 | Couchbase Server SDK v2 reached end-of-life in 2021. `connector.v2.js` now logs a deprecation warning at connection time, and a fatal error when V8 pointer compression is active (NAN bindings are incompatible). Upgrade path: set `sdk.version` to `3` or `4` in your bundle's `connectors.json`. |
| 📋 | **Couchbase SDK v2 removal** | `0.4.0` | Q4 2026 | `connector.v2.js` and all `sdk.version <= 2` branches removed. Default falls back to v3 when `sdk.version` is unset. Full migration guide in `CHANGELOG.md`. |
| 📋 | **`peerDependencies` for connector clients** | `0.3.0` | Q3 2026 | Connector client libraries (`ioredis`, `mysql2`, `pg`, `mongodb`, `@scylladb/scylla-driver`, `couchbase`) are loaded from the user's project — gina has zero runtime npm dependencies. `peerDependencies` (all optional) will signal the tested version range and surface an `npm install` compatibility warning when a user pins an untested version. |

---

## Couchbase Connector Hardening

A cold audit of the Couchbase connector identified two critical security vulnerabilities and four high-severity bugs. All items are contained to specific code paths and do not affect the common case (v4 SDK, Promise API, no `useRestApi`), but they should be resolved before the next stable release.

### Critical — Security

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **Credential exposure in process list (`restQuery`)** — The `useRestApi: true` path builds a shell command containing `-u username:password` and passes it to `exec()`. The full command including plaintext credentials is visible in `ps aux` for the duration of the call. **Fix:** replace `exec()` with `execFile()` and pass credentials as positional arguments or via `--netrc-file`. | `0.2.0` | Q2 2026 |
| 📋 | **Shell command injection in `restQuery`** — The same `exec()` path joins the N1QL statement and query parameters into a single shell string. Metacharacters (`$`, `;`, `&`, `|`, backtick) in parameters are not neutralised — an attacker who can influence query parameters can execute arbitrary shell commands. **Fix:** same — `execFile()` eliminates the shell entirely. | `0.2.0` | Q2 2026 |

### High — Bugs

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **`gina.onError()` handler accumulates on every reconnect** — The error handler is registered inside `onConnect()`, which fires on every reconnection. After N reconnects there are N handlers all racing on the same error, each trying to send a response. **Fix:** register the handler once at init time. | `0.2.0` | Q2 2026 |
| 📋 | **`session-store.v3 get()` always returns "session not found"** — `.then()/.catch()` callbacks are microtasks; the `if (!data)` guard that follows runs synchronously before they resolve. `data` is always `null` at that point, so every session read returns empty. Sessions work correctly with SDK v4. | `0.2.0` | Q2 2026 |
| 📋 | **`session-store.v3 set()` silently discards writes** — Same async/sync confusion. `fn(false, null)` is called before the upsert Promise resolves — writes appear to succeed but are never confirmed. | `0.2.0` | Q2 2026 |
| 📋 | **Infinite recursion when `keepAlive: false`** — The `else` branch in `ping()` calls itself unconditionally. Stack overflow on first connection with `keepAlive: false`. The default is `true` so this only fires when explicitly opted out. | `0.2.0` | Q2 2026 |

### Medium

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **300ms arbitrary startup delay** — A `setTimeout(300)` fires `ready` instead of a condition. Adds 300ms to every bundle startup and is unreliable under load. | `0.3.0` | Q3 2026 |
| 📋 | **`ping()` drops reconnection callback in v2/v3** — `typeof(next)` is checked but `next` is not in scope, so reconnect-from-ping always calls `connect()` without a callback, silently swallowing errors. | `0.3.0` | Q3 2026 |
| 📋 | **Stack traces in HTTP 500 responses** — `err.stack` is included in the JSON sent to the HTTP client. Absolute filesystem paths and internal module names exposed to any caller. | `0.3.0` | Q3 2026 |
| 📋 | **`eval()` for `@options` parsing** — `@options` directives in `.sql` files are evaluated with `eval()`. `JSON.parse()` is sufficient and eliminates the risk of a typo corrupting the options variable in scope. | `0.3.0` | Q3 2026 |
| 📋 | **`bulkInsert` does not return a Promise** — Unlike all other N1QL entity methods after the Option B refactor, `bulkInsert` still returns a plain `{onComplete: fn}` object. `await entity.bulkInsert(...)` resolves to the object, not the data. | `0.3.0` | Q3 2026 |

---

## K8s & Docker

| Status | Feature | Version | Date |
| --- | --- | --- | --- |
| ✅ | **Graceful shutdown on SIGTERM** — `server.close()` drains in-flight requests with configurable hard timeout (`GINA_SHUTDOWN_TIMEOUT`). | `0.1.8` | 2026-03-06 |
| ✅ | **`gina-container` foreground launcher** — Drop-in entrypoint for Docker/K8s. Spawns the bundle non-detached, forwards SIGTERM, exits with the child's code. No framework socket server required. | `0.1.8` | 2026-03-06 |
| ✅ | **Stdout/stderr structured logging** — `GINA_LOG_STDOUT=true` emits JSON lines compatible with `kubectl logs`, Fluentd, and Datadog. | `0.1.8` | 2026-03-21 |
| ✅ | **`gina-init` — stateless container bootstrap** — Generates all required `~/.gina/` config from env vars or a mounted JSON file. Idempotent. Makes the framework init-container friendly. | `0.1.8` | 2026-03-22 |
| ✅ | **Session storage for horizontal scaling** — Redis session store (multi-pod) + SQLite session store (single-pod/dev) + full sessions guide. | `0.2.0` | Q2 2026 |

---

## HTTP/2

| Status | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- |
| ✅ | **Fix `/_gina/info` HTTP/2 endpoint** — `stream.end(infoStatus)` not `stream.end(infoHeaders)` | `0.2.0` | Q2 2026 | The HTTP/2 branch of the info endpoint passes the headers object instead of the JSON string. Returns `[object Object]` instead of JSON. One-line fix. |
| ✅ | **Add stream-closed guard to HTML error response** — `stream.destroyed \|\| stream.closed` check in `throwError()` | `0.2.0` | Q2 2026 | JSON error path has this guard; HTML path does not. If the stream closes during error handling, Node.js emits an unhandled error. |
| ✅ | **HTTP/2 server security settings** — `maxHeaderListSize: 65536`, `enablePush: false`, `maxSessionInvalidFrames`, `maxSessionRejectedStreams` | `0.2.0` | Q2 2026 | Four missing settings on the server. `maxHeaderListSize` prevents HPACK bomb attacks (only set on the client today). `enablePush: false` — server push is deprecated in Chrome 106+ and removed in Firefox 132+. `maxSessionInvalidFrames` and `maxSessionRejectedStreams` defend against CONTINUATION flood (CVE-2024-27316) and RST flood / rapid reset (CVE-2023-44487). |
| 📋 | **103 Early Hints** — send `Link` preload headers as informational response before the final response | `0.3.0` | Q3 2026 | `Link: <url>; rel=preload` headers are correctly built but sent with the final response. Calling `stream.additionalHeaders({ ':status': 103, 'link': links })` before `stream.respond()` allows the browser to start preloading CSS/JS while the template is still rendering. Modern replacement for server push. |
| 📋 | **HTTP/2 session metrics** — expose active session count, stream count, GOAWAY and RST_STREAM totals via `/_gina/info` | `0.3.0` | Q3 2026 | No counters exist for the session pool state. Adds observability for ops teams without requiring an external APM. |
| 📋 | **Configurable `maxConcurrentStreams` and `initialWindowSize`** — move from hardcoded to `settings.server.json` | `0.3.0` | Q3 2026 | Currently `maxConcurrentStreams: 1000` (very permissive) and `initialWindowSize: 655,350` (10× default) are hardcoded. Move to bundle config with sensible defaults (256 / 65,535). Existing deployments unaffected until they opt in. |
| 📋 | **Application-level rapid reset rate limiter** (CVE-2023-44487) — per-session stream creation counter | `0.4.0` | Q4 2026 | Node.js ≥ 20.12.1 has the OS-level fix. Add an application-level counter: if a session creates more than N streams per second, close with GOAWAY. Important for public-facing deployments. |
| 📋 | **Trailer support** — `stream.sendTrailers()` + `waitForTrailers: true` | `0.4.0` | Q4 2026 | No trailer support today. Required for gRPC-style streaming (grpc-status trailer) and content integrity use cases. Opt-in: activated only when a controller calls `self.sendTrailers(fields)`. |
| 📋 | **Alt-Svc header** — advertise HTTP/3 availability | `0.5.0` | Q1 2027 | Set `Alt-Svc: h3=":443"; ma=86400` response header to advertise HTTP/3 (QUIC) availability via a QUIC-capable reverse proxy (nginx, Caddy, Cloudflare). Gina does not need to implement QUIC — just announce it. Opt-in via `settings.server.json`. |
| 📋 | **RFC 9218 Extensible Priorities** — read `Priority: u=N, i` request header | `0.5.0` | Q1 2027 | Use the RFC 9218 priority header to order response writes for multiplexed API clients. Low value for typical HTML page loads; high value for parallel API requests with declared urgency. |
| 📋 | **WebSocket over HTTP/2** (RFC 8441 — CONNECT method extension) | `0.5.0` | Q1 2027 | Tunnel WebSocket over an HTTP/2 stream without a separate HTTP/1.1 connection. Node.js supports this since v10.19. Enables WebSocket in HTTP/2-only deployments. |

---

## AI

### Phase 1 — AI can write Gina code correctly

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **JSON Schemas for config files** — Machine-readable schemas for `routing.json`, `connectors.json`, `app.json`, `settings.json`, `app.crons.json`. Adds `"$schema"` references to generated scaffold files. Gives editors free validation and autocomplete; gives AI assistants authoritative field names so generated config is correct on the first attempt. | `0.2.0` | Q2 2026 |
| 📋 | **TypeScript declaration files** — Cross-listed with Modernisation Phase 4. Essential for AI code generation accuracy. | `0.4.0` | Q4 2026 |

### Phase 2 — Gina apps can use AI

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **AI connector** — Declare an AI provider in `connectors.json` and acquire a client via `getConnection()`. Supported protocols: `anthropic://`, `openai://`. Follows the same pattern as database connectors. | `0.3.0` | Q3 2026 |
| 📋 | **`renderStream` — streaming responses** — `self.renderStream(asyncIterable, contentType)` streams SSE or chunked JSON without buffering. Required for LLM token streaming without bypassing the render pipeline. | `0.3.0` | Q3 2026 |
| 📋 | **Async job pattern for slow AI calls** — First-class "start job → return jobId → poll or webhook on completion" pattern integrated with the cron/queue infrastructure. Prevents LLM latency (1–30s) from blocking the response pipeline. | `0.4.0` | Q4 2026 |

### Phase 3 — AI agents can consume Gina apps

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **OpenAPI spec generation** — `gina bundle:openapi @myproject` emits `openapi.json` from `routing.json`. Zero manual spec writing — route annotations become `description` fields. Makes any Gina app consumable by AI agents, API gateways, and testing tools. | `0.4.0` | Q4 2026 |
| 📋 | **MCP server wrapper** — `gina bundle:mcp @myproject` exposes `routing.json` routes as MCP (Model Context Protocol) tools. Makes any Gina app a native MCP server discoverable by AI agents. | `0.4.0` | Q4 2026 |

---

## Performance

| Status | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- |
| ✅ | **`NODE_COMPILE_CACHE` — V8 bytecode startup cache** | `0.2.0` | Q2 2026 | Node.js 22.8+ caches compiled V8 bytecode to disk. Set once at startup — 30–60% faster cold start on subsequent runs with zero code changes to user bundles. No-op on Node < 22.8, so safe to ship unconditionally. |
| 📋 | **Route radix tree — compile `routing.json` at startup** | `0.3.0` | Q3 2026 | Current router does linear matching against `routing.json` on every request. Pre-compile routes into a radix tree at bundle startup for O(log n) matching. 2–3x faster routing layer. Internal change — no user-facing API change. |
| 📋 | **Bun runtime compatibility investigation** | `0.4.0` | Q4 2026 | Prototype Gina under Bun. Two blockers to verify: `require.cache` deletion (dev hot-reload) and `node:http2` completeness. If both pass, Bun gives 3–10x faster startup and meaningful throughput gains. Deliverable: a compatibility report. |
| ✅ | **V8 pointer compression support** | `0.2.0` | Q2 2026 | Node.js built with `--experimental-enable-pointer-compression` (e.g. [node-caged](https://github.com/platformatic/node-caged) or a custom build) delivers ~50% heap memory reduction across all pointer-heavy structures. Gina is pure JS — compatible out of the box. Adds: startup detection + `GINA_V8_POINTER_COMPRESSED` env var, Dockerfile guide with custom build recipe (full-icu + pointer compression), 4 GB ceiling documentation, N-API-only connector policy. |

---

## Windows

Windows compatibility is a hard requirement for `1.0.0`. The alpha scope covers all core features: install, scaffold, bundle start/stop, routing, rendering, and basic CLI. Full production-grade parity is post-1.0.0.

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **Windows alpha compatibility** — Install scripts, path handling, symlinks, and bundle lifecycle (start/stop/restart) work correctly on Windows. `bin/gina.bat` kept in sync with `bin/gina`. CI Windows runner required before this can be marked done. Out of scope for alpha: full build system (bash-based), Windows service integration, production-grade process management. | `1.0.0` | Q3 2027 |

---

## Tutorials

| Status | Tutorial | Duration | Version | Target |
| --- | --- | --- | --- | --- |
| 📋 | **Using Gina as a mobile backend** — REST API patterns, JSON-only bundles, token auth, CORS, HTTP/2, and the path to OpenAPI/MCP for SDK generation. Docs only — no code changes. | — | `0.3.0` | Q3 2026 |
| 📋 | **Beginner** — Your first Gina app: install, scaffold, one route, one controller, browser response. Starts from `gina new` — no prior project needed. | 5 min | `0.3.0` | Q3 2026 |
| 📋 | **Tutorial locale detection** — Detect the reader's locale and timezone via `navigator.language` + `Intl` and pre-fill the `settings.json` scaffold example with their actual `region`, `preferedLanguages`, and `24HourTimeFormat` values. Falls back to `en_CM`. Implemented as a client-side Docusaurus component. | — | `0.3.0` | Q3 2026 |
| 📋 | **Intermediate** — Multi-bundle setup, routing with URL params, entity + connector wiring, template rendering, form handling. Starts from scratch. | ~30 min | `0.3.0` | Q3 2026 |
| 📋 | **Advanced** — Full production project: authentication, scoped data isolation, async/await, HTTP/2, structured logging, Docker/K8s deployment. Starts from the intermediate tutorial's finished state. | ~60 min | `0.4.0` | Q4 2026 |

---

## Website

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **Official website redesign + docs integration** — Refactor gina.io as a proper project homepage (landing page, feature highlights, showcase) with the documentation fully integrated. Single coherent web presence. Prerequisite: tutorials complete. | `0.4.0` | Q4 2026 |
| 📋 | **Docs offline ZIP** — One-click download of the complete gina.io documentation as a static HTML ZIP archive. Generated at deploy time by the Docusaurus build pipeline — no server-side logic required. Targeted at users in regions with limited or expensive internet access (offline-first for the African market). | `0.4.0` | Q4 2026 |
| 📋 | **Security & CVE compliance page** — Dedicated docs page listing the HTTP/2 CVEs addressed by Gina and the Node.js version required for each mitigation. Covers CVE-2023-44487 (Rapid Reset), CVE-2024-27316 / CVE-2024-27983 (CONTINUATION flood), CVE-2019-9514 (RST flood), and the nghttp2-mitigated ping/settings floods. Docs only — no code changes. | `0.3.0` | Q3 2026 |

---

*Last updated: 2026-03-27 · To suggest a feature, [open an issue](https://github.com/Rhinostone/gina/issues).*
