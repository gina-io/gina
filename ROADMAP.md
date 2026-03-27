# Gina — Roadmap

This roadmap covers planned features, architectural improvements, new connectors, and AI integration. Items marked ✅ are shipped. All planned items are open to community contribution — see [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get involved.

> **Docs:** [gina.io/docs](https://gina.io/docs/) · **Issues:** [github.com/Rhinostone/gina/issues](https://github.com/Rhinostone/gina/issues)

---

## Timeline

| Period | Version | Focus |
| --- | --- | --- |
| **Apr 2026** | `0.1.8` ✅ | Scaffold correctness · K8s support · Dependency injection · Automatic version migration |
| **Q2 2026** | `0.2.0` | Stability · WatcherService · Redis & SQLite connectors · K8s session storage |
| **Q3 2026** | `0.3.0` | Async/await · Dev hot-reload · MySQL & PostgreSQL connectors · AI Phase 2 · Tutorials · Mobile backend guide |
| **Q4 2026** | `0.4.0` | TypeScript declarations · AI agents (OpenAPI, MCP) · ScyllaDB connector · PWA scaffold · Advanced tutorial · Website redesign |
| **Q1 2027** | `0.5.0` | ESM support · Template engine migration · Structured logging |

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
| 📋 | **Per-request controller instances** — Each request gets its own controller instance, eliminating shared mutable state under concurrency. | `0.2.0` | Q2 2026 |
| 📋 | **Entity `_arguments` buffer scoped to call** — Move the event result buffer from the entity to the individual call, preventing concurrent callers from sharing state. | `0.2.0` | Q2 2026 |
| 📋 | **Retire `freeMemory`** — Once per-request instances land (#M1), there is no shared `local` closure to null. Replace `freeMemory` call sites with explicit `local.req = null; local.res = null; local.next = null` at response exit points. | `0.2.0` | Q2 2026 |

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

---

## Connectors

New database connectors follow the same interface as the existing Couchbase connector: declared in `connectors.json`, acquired via `getConnection()`.

| Status | Connector | Version | Target | Notes |
| --- | --- | --- | --- | --- |
| 📋 | **Redis** | `0.2.0` | Q2 2026 | Session store and general-purpose cache. Client: `ioredis`. Required for K8s horizontal scaling. |
| 📋 | **SQLite** | `0.2.0` | Q2 2026 | Three use cases: framework state storage (replaces JSON files under `~/.gina/`), session store for single-pod/dev deployments, and embedded ORM connector. Uses `node:sqlite` (Node.js built-in since v22.5.0 — zero npm deps). |
| 📋 | **MySQL / MariaDB** | `0.3.0` | Q3 2026 | ORM connector. Client: `mysql2`. |
| 📋 | **PostgreSQL** | `0.3.0` | Q3 2026 | ORM connector. Client: `pg` (node-postgres). |
| 📋 | **ScyllaDB** | `0.4.0` | Q4 2026 | Cassandra-compatible wide-column store. Client: `@scylladb/scylla-driver`. |
| 📋 | **MongoDB** | `0.4.0` | Q4 2026 | Document store connector. Client: `mongodb` (official driver). Interface approach TBD — MongoDB's document model differs from the N1QL/SQL pattern used by existing connectors. |

---

## K8s & Docker

| Status | Feature | Version | Date |
| --- | --- | --- | --- |
| ✅ | **Graceful shutdown on SIGTERM** — `server.close()` drains in-flight requests with configurable hard timeout (`GINA_SHUTDOWN_TIMEOUT`). | `0.1.8` | 2026-03-06 |
| ✅ | **`gina-container` foreground launcher** — Drop-in entrypoint for Docker/K8s. Spawns the bundle non-detached, forwards SIGTERM, exits with the child's code. No framework socket server required. | `0.1.8` | 2026-03-06 |
| ✅ | **Stdout/stderr structured logging** — `GINA_LOG_STDOUT=true` emits JSON lines compatible with `kubectl logs`, Fluentd, and Datadog. | `0.1.8` | 2026-03-21 |
| ✅ | **`gina-init` — stateless container bootstrap** — Generates all required `~/.gina/` config from env vars or a mounted JSON file. Idempotent. Makes the framework init-container friendly. | `0.1.8` | 2026-03-22 |
| 📋 | **Session storage for horizontal scaling** — Plug-in session store backed by Redis (#CN1) for multi-pod deployments. Default in-memory store remains available for single-pod and development. | `0.2.0` | Q2 2026 |

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

## Tutorials

| Status | Tutorial | Duration | Version | Target |
| --- | --- | --- | --- | --- |
| 📋 | **Using Gina as a mobile backend** — REST API patterns, JSON-only bundles, token auth, CORS, HTTP/2, and the path to OpenAPI/MCP for SDK generation. Docs only — no code changes. | — | `0.3.0` | Q3 2026 |
| 📋 | **Beginner** — Your first Gina app: install, scaffold, one route, one controller, browser response. Starts from `gina new` — no prior project needed. | 5 min | `0.3.0` | Q3 2026 |
| 📋 | **Intermediate** — Multi-bundle setup, routing with URL params, entity + connector wiring, template rendering, form handling. Starts from scratch. | ~30 min | `0.3.0` | Q3 2026 |
| 📋 | **Advanced** — Full production project: authentication, scoped data isolation, async/await, HTTP/2, structured logging, Docker/K8s deployment. Starts from the intermediate tutorial's finished state. | ~60 min | `0.4.0` | Q4 2026 |

---

## Website

| Status | Feature | Version | Target |
| --- | --- | --- | --- |
| 📋 | **Official website redesign + docs integration** — Refactor gina.io as a proper project homepage (landing page, feature highlights, showcase) with the documentation fully integrated. Single coherent web presence. Prerequisite: tutorials complete. | `0.4.0` | Q4 2026 |

---

*Last updated: 2026-03-27 · To suggest a feature, [open an issue](https://github.com/Rhinostone/gina/issues).*
