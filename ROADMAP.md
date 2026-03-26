# Gina — Roadmap

This roadmap covers planned features, architectural improvements, new connectors, and AI integration. Items marked ✅ are shipped. All planned items are open to community contribution — see [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get involved.

> **Docs:** [gina.io/docs](https://gina.io/docs/) · **Issues:** [github.com/Rhinostone/gina/issues](https://github.com/Rhinostone/gina/issues)

---

## Timeline

| Period | Focus |
| --- | --- |
| **Q2 2026** | Stability · WatcherService · Redis & SQLite connectors · K8s session storage |
| **Q3 2026** | Async/await · Dev hot-reload · MySQL & PostgreSQL connectors · AI Phase 2 |
| **Q4 2026** | TypeScript declarations · AI agents (OpenAPI, MCP) · ScyllaDB connector |
| **Q1 2027** | ESM support · Template engine migration · Structured logging |

---

## Features

| Status | Feature | Target |
| --- | --- | --- |
| 📋 | **`watchers.json`** — First-class bundle config for file watchers. Declare watchers on config files with event-based notification (no polling). Foundation for the dev-mode hot-reload system. | Q2 2026 |

---

## Modernisation

### Phase 1 — Stability

| Status | Feature | Target |
| --- | --- | --- |
| 📋 | **Per-request controller instances** — Each request gets its own controller instance, eliminating shared mutable state under concurrency. | Q2 2026 |
| 📋 | **Entity `_arguments` buffer scoped to call** — Move the event result buffer from the entity to the individual call, preventing concurrent callers from sharing state. | Q2 2026 |

### Phase 2 — Async

| Status | Feature | Target |
| --- | --- | --- |
| 📋 | **Promise adapter for entity calls** — `entityCall(emitter)` wraps the EventEmitter `.onComplete(cb)` pattern in a Promise. Controllers can switch to `async/await` immediately without rewriting entities. | Q3 2026 |
| 📋 | **Async controller actions** — Controller actions become `async function`. Single `try/catch` per action replaces ad-hoc error guards. | Q3 2026 |

### Phase 3 — Dev Tooling

| Status | Feature | Target |
| --- | --- | --- |
| 📋 | **File-watcher hot-reload** — Replace `delete require.cache` per-request with a `WatcherService` that evicts modules only on actual file change. Controllers and SQL files reload on save with zero per-request overhead. | Q3 2026 |
| 📋 | **SQL annotation parser** — Replace the single-pass regex for N1QL file parsing with a state-machine parser. Handles nested block comments and `--` in string literals correctly. | Q3 2026 |

### Phase 4 — DX

| Status | Feature | Target |
| --- | --- | --- |
| 📋 | **Explicit exports for global helpers** — `getContext`, `setContext`, `_`, `requireJSON` etc. available as explicit `require('gina/gna').getContext` imports alongside the existing global injection. Enables IDE navigation and static analysis. | Q4 2026 |
| 📋 | **TypeScript declaration files** — `.d.ts` declarations for the public surface: `SuperController`, `EntitySuper`, connector config shapes, `routing.json` schema. No TS migration of internals — just declarations for consumer projects. | Q4 2026 |

### Phase 5 — Future

| Status | Feature | Target |
| --- | --- | --- |
| 📋 | **ESM compatibility layer** — Dual CJS/ESM entry points via `"exports"` in `package.json`. Framework internals stay CJS; public API gets ESM re-exports. | Q1 2027 |
| 📋 | **Template engine migration** — Replace the abandoned Swig 1.4.2 with a maintained engine. Leading candidate: Nunjucks (identical Jinja2-style syntax — existing templates require no changes). | Q1 2027 |
| 📋 | **Structured logging** — JSON log output (`{ level, message, bundle, requestId, durationMs }`). Additive — existing consumers are unaffected. Enables log aggregation (Loki, Datadog, CloudWatch). | Q1 2027 |

---

## Connectors

New database connectors follow the same interface as the existing Couchbase/MongoDB connectors: declared in `connectors.json`, acquired via `getConnection()`.

| Status | Connector | Target | Notes |
| --- | --- | --- | --- |
| 📋 | **Redis** | Q2 2026 | Session store and general-purpose cache. Client: `ioredis`. Required for K8s horizontal scaling. |
| 📋 | **SQLite** | Q2 2026 | Three use cases: framework state storage (replaces JSON files under `~/.gina/`), session store for single-pod/dev deployments, and embedded ORM connector. Uses `node:sqlite` (Node.js built-in since v22.5.0 — zero npm deps). |
| 📋 | **MySQL / MariaDB** | Q3 2026 | ORM connector. Client: `mysql2`. |
| 📋 | **PostgreSQL** | Q3 2026 | ORM connector. Client: `pg` (node-postgres). |
| 📋 | **ScyllaDB** | Q4 2026 | Cassandra-compatible wide-column store. Client: `@scylladb/scylla-driver`. |

---

## K8s & Docker

| Status | Feature | Date |
| --- | --- | --- |
| ✅ | **Graceful shutdown on SIGTERM** — `server.close()` drains in-flight requests with configurable hard timeout (`GINA_SHUTDOWN_TIMEOUT`). | 2026-03-06 |
| ✅ | **`gina-container` foreground launcher** — Drop-in entrypoint for Docker/K8s. Spawns the bundle non-detached, forwards SIGTERM, exits with the child's code. No framework socket server required. | 2026-03-06 |
| ✅ | **Stdout/stderr structured logging** — `GINA_LOG_STDOUT=true` emits JSON lines compatible with `kubectl logs`, Fluentd, and Datadog. | 2026-03-21 |
| ✅ | **`gina-init` — stateless container bootstrap** — Generates all required `~/.gina/` config from env vars or a mounted JSON file. Idempotent. Makes the framework init-container friendly. | 2026-03-22 |
| 📋 | **Session storage for horizontal scaling** — Plug-in session store backed by Redis (#CN1) for multi-pod deployments. Default in-memory store remains available for single-pod and development. | Q3 2026 |

---

## AI

### Phase 1 — AI can write Gina code correctly

| Status | Feature | Target |
| --- | --- | --- |
| 📋 | **JSON Schemas for config files** — Machine-readable schemas for `routing.json`, `connectors.json`, `app.json`, `settings.json`, `app.crons.json`. Adds `"$schema"` references to generated scaffold files. Gives editors free validation and autocomplete; gives AI assistants authoritative field names so generated config is correct on the first attempt. | Q2 2026 |
| 📋 | **TypeScript declaration files** — Cross-listed with Modernisation Phase 4. Essential for AI code generation accuracy. | Q4 2026 |

### Phase 2 — Gina apps can use AI

| Status | Feature | Target |
| --- | --- | --- |
| 📋 | **AI connector** — Declare an AI provider in `connectors.json` and acquire a client via `getConnection()`. Supported protocols: `anthropic://`, `openai://`. Follows the same pattern as database connectors. | Q3 2026 |
| 📋 | **`renderStream` — streaming responses** — `self.renderStream(asyncIterable, contentType)` streams SSE or chunked JSON without buffering. Required for LLM token streaming without bypassing the render pipeline. | Q3 2026 |
| 📋 | **Async job pattern for slow AI calls** — First-class "start job → return jobId → poll or webhook on completion" pattern integrated with the cron/queue infrastructure. Prevents LLM latency (1–30s) from blocking the response pipeline. | Q4 2026 |

### Phase 3 — AI agents can consume Gina apps

| Status | Feature | Target |
| --- | --- | --- |
| 📋 | **OpenAPI spec generation** — `gina bundle:openapi @myproject` emits `openapi.json` from `routing.json`. Zero manual spec writing — route annotations become `description` fields. Makes any Gina app consumable by AI agents, API gateways, and testing tools. | Q4 2026 |
| 📋 | **MCP server wrapper** — `gina bundle:mcp @myproject` exposes `routing.json` routes as MCP (Model Context Protocol) tools. Makes any Gina app a native MCP server discoverable by AI agents. | Q4 2026 |

---

*Last updated: 2026-03-26 · To suggest a feature, [open an issue](https://github.com/Rhinostone/gina/issues).*
