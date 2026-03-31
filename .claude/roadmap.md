# Roadmap

## Legend

| Symbol | Meaning |
| --- | --- |
| ✅ | Done |
| 🔄 | In progress |
| 📋 | Planned |
| ⏸ | Deferred |

**Public?** — ✓ appears in the public `ROADMAP.md` · — is internal only.

---

## Timeline

| Period | Version | Focus | Items |
| --- | --- | --- | --- |
| **Apr 2026** | `0.1.8` | Boilerplate fixes — ship a correct scaffold before any other work | #BP1–#BP7, #R2–#R4, #K1–#K4 |
| **Q2 2026** | `0.2.0` ✅ | Stability · WatcherService · Connectors (Redis, SQLite) · Adoption Phase 1 · Visibility Phase 1–2 · AI Phase 1 · Startup cache · Pointer compression · Couchbase v2 deprecation · Couchbase security & critical bug fixes · HTTP/2 bug fixes & security hardening | #M1–#M3, #R1, #CN1–#CN2, #CN7, #K5, #A1–#A6, #A9–#A11, #V1–#V6, #AI1–#AI2, #P1, #P4, #H1–#H3, #CB1–#CB6 |
| **Q3 2026** | `0.3.0` | Async · Dev tooling · Connectors (MySQL, PostgreSQL) · K8s session · On-ramp · AI Phase 2 · Route radix tree · Connector peerDeps · 103 Early Hints · HTTP/2 observability & config · Security & CVE page · Tutorial locale detection · Couchbase medium fixes · Per-bundle framework version · Beemaster Phase 1 | #M4–#M7, #CN3–#CN4, #CN9, #A7–#A8, #A12–#A13, #A15–#A16, #V7–#V8, #V11, #AI4–#AI5, #UT1, #P2, #H4–#H7, #CB7–#CB12, #R7, #BM1–#BM2 |
| **Q4 2026** | `0.4.0` | DX · AI Phase 2–3 · ScyllaDB · Prometheus metrics · Bun investigation · Couchbase v2 removal · Docs offline ZIP · HTTP/2 rapid reset defense · Trailer support · Beemaster core | #M8–#M9, #CN5, #CN8, #OBS1, #AI3, #AI6–#AI8, #P3, #V10, #H8–#H10, #CB13, #BM3–#BM6 |
| **Q1 2027** | `0.5.0` | Future platform · HTTP/2 advanced features · Beemaster admin | #M10–#M12, #M14, #H11–#H13, #BM7–#BM10, #BM12 |
| **Q3 2027** | `1.0.0` | First stable release — Windows alpha compatibility is a hard gate | #W1 |

---

## Summary

| Track | ✅ Done | 🔄 In Progress | 📋 Planned | Total |
| --- | --- | --- | --- | --- |
| ✅ Boilerplate (#BP) | 7 | 0 | 0 | 7 |
| Features (#R) | 5 | 0 | 2 | 7 |
| Beemaster (#BM) | 0 | 0 | 13 | 13 |
| Modernisation (#M) | 3 | 0 | 11 | 14 |
| Connectors (#CN) | 4 | 0 | 5 | 9 |
| K8s & Docker (#K) | 5 | 0 | 0 | 5 |
| AI (#AI) | 2 | 0 | 6 | 8 |
| Adoption (#A) | 9 | 0 | 7 | 16 |
| Visibility (#V) | 4 | 0 | 6 | 10 |
| Performance (#P) | 2 | 0 | 2 | 4 |
| HTTP/2 (#H) | 3 | 0 | 10 | 13 |
| Windows (#W) | 0 | 0 | 1 | 1 |
| Sustainability (#S) | 1 | 0 | 0 | 1 |
| Unit Tests (#UT) | 0 | 0 | 1 | 1 |
| Couchbase Hardening (#CB) | 13 | 0 | 0 | 13 |
| Observability (#OBS) | 0 | 0 | 1 | 1 |
| **Total** | **58** | **0** | **64** | **122** |

---

## 🔴 Boilerplate (#BP) — Top Priority

Scaffold correctness issues. Every new project inherits these problems on day one. Ship before any other work.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #BP1 | — | Auto-detect system locale/timezone at `bundle:add` and `framework init` | `0.1.8` | Apr 2026 | `settings.json` boilerplate uses `${culture}` / `${isoShort}` / `${dateFormat}` / `${timeZone}` placeholders. `add.js parse()` resolves at scaffold time; `init.js` derives `iso_short` from culture prefix and `date` via `Intl.formatToParts`. Commits `c43bde62`, `2bf59f40`, `cb364f78`, `1846cb21`, `e242f28b`, `75a06295`. `services/` locale values (`en_CM` / `Africa/Douala`) are correct for the dev machine and are patched at runtime by `config.js` (#BP7) regardless — no action needed. `core/template/conf/settings.json` resolved by #BP7. |
| ✅ | #BP2 | — | Translate `error-msg-noscript.html` to English | `0.1.8` | Apr 2026 | Current text is entirely in French ("Pour fonctionner correctement…"). Replace with English. Optionally use `{{ page.lang }}` to select language from the bundle config once i18n is in place. |
| ✅ | #BP3 | — | Create `home.css` stub in `bundle_public/css/` | `0.1.8` | Apr 2026 | `templates.json` references `/css/home.css` for the `home` route (route-specific CSS on top of `default.css`) but the file is never scaffolded — causes a 404 on first HTML render. Add an empty stub matching the `default.css` pattern. |
| ✅ | #BP4 | — | Decouple `setup.js` from Swig | `0.1.8` | Apr 2026 | `var swig = this.engine` and all filter comments say "Swig". Rename to `var engine = this.engine`; update all references and comments to say "template engine". Prerequisite for #M11 (Nunjucks migration) — without this, the migration touches user-facing boilerplate files at the last moment. |
| ✅ | #BP5 | — | Remove `express-session` reference from `index.js` | `0.1.8` | Apr 2026 | Commented import `var SessionStore = lib.SessionStore(session)` implies Express-session is needed. Replace with a note pointing to Gina's built-in session pattern. Confusing in a framework with no Express dependency. |
| ✅ | #BP6 | — | Add `connectors.json` template to scaffold | `0.1.8` | Apr 2026 | Database configuration is not discoverable from the scaffold — developers have to find it from docs. Add a commented-out `connectors.json` to the `bundle/config/` boilerplate with a Couchbase example (matching `reference/connectors.json` in the docs) and a pointer to the docs for future connectors. |
| ✅ | #BP7 | — | Make `core/template/conf/settings.json` locale section runtime-aware | `0.1.8` | Apr 2026 | `config.js`: after loading the static `defaultSettings` template, patches the full `locale` section from `GINA_CULTURE` (resolved by `init.js`) — `preferedLanguages` and `currency.code` from locale database, `dateFormat.short` and `24HourTimeFormat` from `Intl`, `measurementUnits` and `temperature` from exception lists, `firstDayOfWeek` from `Intl.Locale.getWeekInfo()`. `JSON.clone()` prevents requireJSON cache mutation. Commits `be7ef710`, `a97e81b0`, `34f35b35`. |

---

## Features (#R)

| Status | ID | Public | Feature | Version | Date / Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #R5 | ✓ | `init.js` short-version migration — auto-migrate `main.json` and `settings.json` on first startup of a new short version | `0.1.8` | 2026-03-26 | `checkIfMain`: detects missing `frameworks[release]`, copies all namespaced keys from the most recent previous short version via `parseFloat` comparison. `checkIfSettings`: seeds port/hostname env vars from the previous release's `settings.json` when the new dir has no settings yet. Downgrade is free — old keys are never removed. Handles any bump: `0.1→0.2`, `0.5→1.0`. |
| ✅ | #R2 | — | Dependency injection — Phase 1: mockable service locator | `0.1.8` | 2026-03-25 | Commit `92cc3307`. |
| ✅ | #R3 | — | Dependency injection — Phase 2: entity constructor injection | `0.1.8` | 2026-03-25 | Commit `e2caca11`. `EntitySuper(conn, caller, injected)`: `injected.connector` overrides `getConnection()`, new `this.getConfig()` routes through `injected.config`. 13 tests in `test/core/entity-injection.test.js`. |
| ✅ | #R4 | — | Dependency injection — Phase 3: controller test factory | `0.1.8` | 2026-03-25 | Commit `e74f4587`. `SuperController.createTestInstance(deps)`: fresh instance per call, wires mock req/res/next/options via `setOptions()`, sets `_isTestInstance = true`. Production singleton untouched. 11 tests in `test/core/controller-injection.test.js`. |
| ✅ | #R1 | ✓ | `watchers.json` bundle config + shared WatcherService | `0.2.0` | 2026-03-29 | `lib/watcher/src/main.js` — `WatcherService` class: `register(name, path, opts)`, `load(configDir, conf)`, `on(name, listener)`, `start()`, `stop()`, `active()`, `registered()`. Uses `fs.watch` (no polling). Wired into `gna.js:onStarted` — reads `conf.watchers` (auto-loaded from `watchers.json` by config.js), calls `load()` + `start()`, exposes instance as `gna.watcher` for #M6 registration. Boilerplate at `core/template/boilerplate/bundle/config/watchers.json`. `env.json` path key renamed `watchersPath` (was `watchers`) to avoid collision with the loaded config. 9 tests in `test/core/watcher.test.js`. |
| 📋 | #R6 | ✓ | PWA scaffold in `gina bundle:add` | `0.4.0` | Q4 2026 | Add PWA-ready files to the bundle boilerplate: `manifest.json` (name, icons, theme colour, display mode), a service worker stub (`sw.js`) with a basic cache-first strategy, and the required `<meta>` / `<link>` tags in the default HTML template. Zero runtime dependency — just static files that `gina bundle:add` drops into the right directories. Enables Gina apps to be installed on mobile as PWAs without any additional tooling. |
| 📋 | #R7 | ✓ | Per-bundle framework version | `0.3.0` | Q3 2026 | Multiple `framework/v${version}` directories already coexist under the same install prefix; `main.json` tracks them all. This item wires per-bundle version selection on top of that foundation. (1) Add optional `gina_version` field to per-bundle entries in `manifest.json`. (2) Extend `lib/cmd/bundle/start.js:isRealApp()` callback to return the declared version as a fourth argument. (3) In `proceedToStart`, if a version is declared, shallow-clone `getContext()` and override `GINA_FRAMEWORK_DIR`, `GINA_CORE`, `GINA_VERSION`, `GINA_SHORT_VERSION` before `spawn()` — the socket server's own version is unaffected. (4) Validate the declared version against `main.json`'s `frameworks[shortVersion]` array before spawn; abort with a clear error if not found. (5) Add `--gina-version=X.Y.Z` flag to `bundle:start` for ad-hoc override without touching `manifest.json`. Default: no `gina_version` declared → current behaviour unchanged. |

---

## Beemaster (#BM)

Standalone gina dev and admin tool. Served as its own gina bundle (`services/src/beemaster/`) on port 4101. Replaces the in-page toolbar with a thin status bar and moves all tooling UI to an isolated browser tab. Works for both local and remote/K8s gina instances.

**Architecture decision:** Shadow DOM, browser extension, separate popup window, and Electron were all evaluated. Shadow DOM doesn't scale to admin operations. Electron is local-only and cannot manage remote/K8s instances. A browser extension requires distribution overhead and is a UI shell without its own backend. The standalone web app is the strict superset — full admin UI, works locally and remotely. A browser extension companion (#BM13) can be layered on top later.

**Existing scaffolding already in place:** `services/src/toolbar/` skeleton, `engine.io-client` bundled (currently dead weight), port range 4100+ reserved for services, port 8125 already the MQ/log-tail port.

### Phase 1 — Decouple in-page toolbar

Prerequisite for all other phases. Zero change to the existing toolbar UI — just moves where it lives.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #BM1 | ✓ | Thin in-page status bar | `0.3.0` | Q3 2026 | Remove the in-page toolbar AMD bundle entirely. Replace with a lightweight `<div id="gina-status">` injected by the render pipeline — no RequireJS, no jQuery, no SASS. Contains: bundle name, current environment, a status dot (green = ok, yellow = warnings, red = errors) derived from `page.errors`, and an "Open Beemaster" link to port 4101. Injected only when `NODE_ENV_IS_DEV=true`. Zero impact on the app DOM tree, zero CSS conflicts. Keyboard shortcut `Ctrl+Shift+G` opens Beemaster in a new tab. |
| 📋 | #BM2 | ✓ | `window.__ginaData` — replace `<pre>` embedding | `0.3.0` | Q3 2026 | The current toolbar serializes the full `page` object into `<pre id="gina-data">` / `<pre id="gina-view">` tags inside the HTML body. Replace with a single `<script>window.__ginaData={...}</script>` tag injected before `</body>` — dev mode only. Contains: `{ data, view, env, forms, routing, user, errors }`. Smaller page weight, no DOM nodes to scrape, Beemaster reads it on connect via the `window.opener` reference or a `postMessage` handshake. Production mode: tag is never injected. |

### Phase 2 — Beemaster core

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #BM3 | ✓ | `services/src/beemaster/` bundle scaffold | `0.4.0` | Q4 2026 | Create the Beemaster gina bundle. Config: `app.json`, `routing.json`, `settings.json`, `settings.server.json`. Port: 4101. Single-page application served at `/` with tab-based navigation. Reads `window.__ginaData` from the inspected tab via `window.opener` or a `postMessage` channel. Auto-starts alongside the gina dev server when `NODE_ENV_IS_DEV=true`. Replaces the empty `services/src/toolbar/` skeleton. |
| 📋 | #BM4 | ✓ | Toolbar tab | `0.4.0` | Q4 2026 | Migrate the full toolbar UI to the Beemaster Toolbar tab. Sub-tabs: **Data** (page data tree with expand/collapse), **View** (view model), **Forms** (form state, field values, validation errors, XHR status), **Configuration** (bundle `app.json`, environment variables), **Routing** (matched route, full `routing.json` rule, URL params). Source: `toolbar/main.js` (jQuery-free since 2026-03-28) rewritten as a plain ES5 module loaded by Beemaster's own bundle — AMD/RequireJS no longer needed. Copy-to-clipboard and value inspector features carry over as-is. |
| 📋 | #BM5 | ✓ | Real-time data via engine.io | `0.4.0` | Q4 2026 | Wire the already-bundled `engine.io-client` (currently dead weight in `gina.min.js`) to port 8125. The Beemaster bundle subscribes to the gina MQ on port 8125 and pushes updates to connected Beemaster clients over a persistent socket. Replaces the `<pre>` snapshot model — data, log events, and XHR activity stream in real time. Prerequisite for #BM6 and #BM10. |
| 📋 | #BM6 | ✓ | Logs tab | `0.4.0` | Q4 2026 | Real-time log tail via the engine.io channel (#BM5). Replaces the stub Logs tab in the current toolbar (zero implementation). Features: live tail with pause/resume, log level filter (debug/info/warn/error), bundle filter, text search, timestamp display. Log entries arrive as JSON over the engine.io channel; Beemaster renders them in a virtual-scrolling list to handle high log volume without DOM bloat. |

### Phase 3 — Admin

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #BM12 | — | Auth layer | `0.5.0` | Q1 2027 | Token-based auth gate for all write operations (bundle start/stop/build, project add/remove, connector config edits). Token configured under `beemaster.token` in `services/src/beemaster/config/settings.json` or via `BEEMASTER_TOKEN` env var. Read-only tabs (Toolbar, Logs, Routing) are unauthenticated in local dev. Write operations always require the token. HTTPS strongly recommended before exposing Beemaster outside `localhost`. Prerequisite for #BM7–#BM9. |
| 📋 | #BM7 | ✓ | Bundles tab | `0.5.0` | Q1 2027 | List all known bundles (running and stopped) by querying the gina socket API on port 8124. Columns: name, project, port, env, status, uptime, last error. Actions: start, stop, restart, build — each dispatches the equivalent `gina bundle:*` socket command. Real-time status updates via engine.io (#BM5). Requires auth (#BM12). |
| 📋 | #BM8 | ✓ | Projects tab | `0.5.0` | Q1 2027 | List all registered gina projects from `~/.gina/${shortVersion}/projects.json`. Actions: add project (name, path), remove project, view project summary (bundles, ports, env). Config files (`app.json`, `routing.json`, `connectors.json`) shown as read-only JSON with syntax highlighting; "Open in editor" triggers the OS default editor via a gina CLI command. Requires auth (#BM12). |
| 📋 | #BM9 | ✓ | DB connectors tab | `0.5.0` | Q1 2027 | View all connectors declared in `connectors.json` across registered bundles. Columns: connector type (Couchbase/SQLite/Redis/MySQL/PostgreSQL/ScyllaDB), bundle, host:port, database/bucket, connection status (live/error/unconfigured), last error. Test connection button shows latency. Credentials always masked. Requires auth (#BM12). |
| 📋 | #BM10 | ✓ | Query inspector | `0.5.0` | Q1 2027 | Live entity query log replacing the stub Query tab. Hooks into the connector `execute()` path: captures connector type, query text (N1QL/SQL), bound parameters, duration (ms), row count, error if any. Delivered via engine.io (#BM5). Filters: connector, bundle, slow query threshold. Clicking a row expands the full query with parameters. |

### Phase 4 — Advanced

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #BM11 | ✓ | Multi-instance support | post-1.0.0 | — | Connect Beemaster to remote gina instances (staging, K8s) by entering a host:port in Beemaster settings. Each instance appears as a named environment tab. Requires the remote instance to have Beemaster running with auth (#BM12) and port 8125 accessible from the browser. Enables managing multiple deployments from a single Beemaster tab. |
| 📋 | #BM13 | ✓ | Browser extension companion | post-1.0.0 | — | Chrome/Firefox DevTools panel that embeds a Beemaster view in F12, connecting to the local Beemaster instance via WebSocket. The extension is a thin UI shell — all data and logic live in `services/src/beemaster/`. Modeled after Vue DevTools and React DevTools. Optional enhancement on top of the standalone app — not a replacement. Requires Manifest V3 service worker design for the WebSocket background connection. |

---

## Modernisation (#M)

### Phase 1 — Stability

Break the known failure modes. No new features — just making the existing ones safe under load.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #M1 | ✓ | Per-request controller instances | `0.2.0` | Q2 2026 | Per-request isolation already exists via `inherits()` (`b.apply(this, arguments)` in `lib/inherits/src/main.js:78` creates a fresh `this` + fresh `local` closure on every `new Controller()` call — no singleton return). Cleanup: remove dead singleton infrastructure (`SuperController.instance`, `SuperController.initialized`, `init()`/`getInstance()` singleton path); remove 4 no-op `freeMemory([], false)` calls (array-slot nulling on a throwaway array, `isGlobalModeNeeded=false` skips `local.*` reset); fix `throwError()` HTML error path gap (missing `local.req/res/next = null` after `res.end(msgString)` — real risk when entity listeners keep the controller alive). See also #M14 for the follow-up research into `AsyncLocalStorage`. _Done: 2026-03-27 · commit `b590ebae`_ |
| ✅ | #M2 | ✓ | `_arguments` buffer scoped to call instance | `0.2.0` | 2026-03-29 | `_callbacks[trigger]` is now a FIFO queue (array). A single persistent `.on` dispatch listener dequeues the oldest resolver on each emit — concurrent callers each receive their own result. `removeAllListeners` removed (was killing in-flight callers). `_arguments[trigger]` is also a queue; DISPATCH:PREEMPTIVE_BUFFER pushes and both consume paths shift. emit condition 3 skips DISPATCH:CALLBACK_FLUSH for queue mode (`Array.isArray` guard). 4 tests (concurrent-calls test added). _Done: 2026-03-29 · commit `ed6d9def`_ |
| ✅ | #M3 | ✓ | Retire `freeMemory` | `0.2.0` | Q2 2026 | Once #M1 is done there is no shared `local` to null. Remove `freeMemory` and replace all call sites with explicit `local.req = null; local.res = null; local.next = null;` at response exit points. _Done: 2026-03-27 · commit `5ef0ee0b`_ |

### Phase 2 — Async

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #M4 | ✓ | Promise adapter for onComplete EventEmitter calls | `0.3.0` | Q3 2026 | Thin wrapper: `onCompleteCall(emitter)` returns a `Promise` that resolves/rejects from `.onComplete(cb)`. No entity rewrite needed — controllers switch to `async/await` immediately. Add to `lib/` as a utility. |
| 📋 | #M5 | ✓ | Async controller actions | `0.3.0` | Q3 2026 | Once #M4 is in place, migrate controller actions to `async function`. Single `try/catch` per action replaces the double-throwError pattern and ad-hoc error guards. |
| ⏸ | #M13 | — | `config.js` async `readdirSync` (#P33) | `—` | Blocked on M4/M5 | `loadWithTemplate` and `loadBundleConfig` in `config.js` use `fs.readdirSync()` at startup and on dev reload. Async conversion attempted (`d661e47d`) and reverted (`146a8973`) — `new Config({...})` must complete synchronously before returning so callers can access `bundlesConfiguration` immediately. Unblocks once the Config init chain is refactored to be promise-aware (after M4/M5). |

### Phase 3 — Dev Tooling

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #M6 | ✓ | File-watcher hot-reload (replace `delete require.cache`) | `0.3.0` | Q3 2026 | Register internal dev-mode watchers on the `WatcherService` built for #R1 (prerequisite). Watch `controllers/`, `entities/`, and `n1ql/` directories; evict modules from `require.cache` on actual disk change only. Eliminates per-request `delete require.cache` and per-query `fs.readFileSync`. Controllers and SQL reload instantly on save with zero per-request overhead. |
| 📋 | #M7 | ✓ | SQL comment/annotation parser | `0.3.0` | Q3 2026 | Replace the single-pass regex with a minimal state-machine parser. Handles `--` in string literals, nested block comments, and multi-line annotations correctly. ~200 lines. Prerequisite for #M6 (annotations must survive hot-reload). |

### Phase 4 — DX

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #M8 | ✓ | Explicit exports for global helpers | `0.4.0` | Q4 2026 | Add `module.exports` aliases in `gna.js` for `getContext`, `setContext`, `_`, `requireJSON`, etc. New code can `require('gina/gna').getContext` instead of relying on injection. Old call sites keep working. Enables static analysis and IDE navigation. |
| 📋 | #M9 | ✓ | TypeScript declaration files (`.d.ts`) | `0.4.0` | Q4 2026 | Add declarations for the public surface: `SuperController`, `EntitySuper`, connector config shapes, `routing.json` schema. No TS migration of internals — just declarations. Gives IDE autocomplete and shape-error catching at call sites for TypeScript consumer projects. |

### Phase 5 — Future

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #M10 | ✓ | ESM compatibility layer | `0.5.0` | Q1 2027 | Add `"exports"` field to `package.json` with dual CJS/ESM entry points. Framework internals stay CJS; public API gets ESM re-exports. Required for compatibility with ESM-only dependencies and modern bundlers. |
| 📋 | #M11 | ✓ | Swig replacement | `0.5.0` | Q1 2027 | Swig (1.4.2) is abandoned upstream and will accumulate CVEs. Candidates: **Nunjucks** (closest syntax, Jinja2-style, maintained) or **eta** (lighter, faster). Template syntax migration across all bundles is the main cost. Plan migration path before execution; run both engines in parallel during transition. |
| 📋 | #M12 | ✓ | Structured logging | `0.5.0` | Q1 2027 | Replace freeform log strings with structured JSON output (`{ level, message, bundle, requestId, durationMs }`). Enables log aggregation (Loki, Datadog, CloudWatch) and per-request tracing without a full APM. Additive — existing log consumers see the same data, new consumers can filter/query by field. |
| 📋 | #M14 | ✓ | Research `AsyncLocalStorage` for per-request context | `0.5.0` | Q1 2027 | Follow-up to #M1. Evaluate `node:async_hooks` `AsyncLocalStorage` (stable Node ≥ 16.4) as a replacement for the `local` closure pattern in `controller.js`. Goal: true async isolation across `setTimeout`, `setImmediate`, Promise chains without threading `local` through function arguments. Research scope: (1) benchmark `getStore()` overhead at HTTP scale (expected 1–3% — negligible); (2) audit all `local.*` read sites in `controller.js`, `render-swig.js`, `render-json.js`; (3) assess middleware and bundle-level impact; (4) draft migration path. If adopted, `#M3` (freeMemory retire) becomes moot — store is GC'd automatically when the async context ends. Output: decision doc + PoC branch. |

---

## Connectors (#CN)

New database and service connectors following the same interface as the existing Couchbase connector: declared in `connectors.json`, acquired via `getConnection()`, entity trigger pattern (EventEmitter + `.onComplete(cb)`).

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #CN1 | ✓ | Redis connector | `0.2.0` | Q2 2026 | Session store and general-purpose cache connector. Location: `core/connectors/redis/`. Client: `ioredis` (supports Redis Cluster, Sentinel, TLS, ElastiCache, Cloud Memorystore, Upstash). Interface: `get`, `set`, `destroy`, `touch` (mirrors `session-store.v4.js`). Required by #K5 (distributed sessions in K8s). _Done: 2026-03-27 · commit `2bd9ff70`_ |
| ✅ | #CN2 | ✓ | SQLite connector | `0.2.0` | Q2 2026 | Three use cases: (1) **`~/.gina/` state storage** — replace the 4 JSON config files with a single `gina.db` SQLite file; one artifact to mount in containers, atomic multi-key writes via transactions, no partial-write corruption on crash. Client: `node:sqlite` (Node.js built-in since 22.5.0 — zero npm deps, synchronous API, drop-in compatible with gina's sync init contract). (2) **Session store** for single-pod/dev/staging: `core/connectors/sqlite/lib/session-store.js`. (3) **ORM entity connector** for bundles needing an embedded relational store without an external DB service. _v1 (session store) done: 2026-03-27 · commit `96c5808a`. v2 (ORM / entity connector) done: 2026-03-28 · commit `08ead296`. v3 (~/.gina/ state) done: 2026-03-28 · commit `da5c55ba`._ |
| 📋 | #CN3 | ✓ | MySQL / MariaDB connector | `0.3.0` | Q3 2026 | ORM / entity connector for relational databases. Location: `core/connectors/mysql/`. Client: `mysql2` (compatible with MySQL ≥ 5.7 and MariaDB ≥ 10.3, prepared statements, connection pooling). Connection pool config: `host`, `port`, `user`, `password`, `database`, `connectionLimit`. |
| 📋 | #CN4 | ✓ | PostgreSQL connector | `0.3.0` | Q3 2026 | ORM / entity connector for PostgreSQL. Location: `core/connectors/postgres/`. Client: `pg` (node-postgres — battle-tested, `pg-pool`, prepared statements, JSONB). Connection pool config: `host`, `port`, `user`, `password`, `database`, `max`. |
| 📋 | #CN5 | ✓ | ScyllaDB connector | `0.4.0` | Q4 2026 | High-performance Cassandra-compatible wide-column store connector. Location: `core/connectors/scylladb/`. Client: `@scylladb/scylla-driver` (drop-in for `cassandra-driver`, optimised for ScyllaDB's shard-aware routing). Connection config: `contactPoints`, `localDataCenter`, `keyspace`, `credentials`. |
| 📋 | #CN6 | ✓ | MongoDB connector | `0.4.0` | Q4 2026 | Document store connector. Location: `core/connectors/mongodb/`. Client: `mongodb` (official Node.js driver). Interface approach TBD — MongoDB's document model (BSON, aggregation pipeline, no fixed schema) differs significantly from the N1QL/SQL pattern used by existing connectors. Design question: thin wrapper exposing a raw collection vs. entity abstraction layer. |
| ✅ | #CN7 | ✓ | Couchbase SDK v2 formal deprecation + runtime warning | `0.2.0` | Q2 2026 | Couchbase Server SDK v2 reached end-of-life in 2021. In `0.2.0`: (1) `console.warn` in `connector.v2.js:onConnect` — fires once per bundle startup, states EOL date, removal version, and upgrade path (`sdk.version: 3` or `4` in `connectors.json`); (2) `console.error` when `GINA_V8_POINTER_COMPRESSED=true` — v2 uses NAN-based bindings which are incompatible with pointer compression (possible segfault). _Done: 2026-03-27 · commit `4d40cc00`_ |
| 📋 | #CN8 | ✓ | Remove Couchbase SDK v2 connector | `0.4.0` | Q4 2026 | Delete `core/connectors/couchbase/lib/connector.v2.js` and the `sdk.version <= 2` branches in `index.js` (query builder closures + `bulkInsert`). Update the main `index.js` to default to v3 when `conn.sdk.version` is missing instead of v2. Migration guide in `CHANGELOG.md` and docs. |
| ✅ | #CN9 | — | `peerDependencies` for connector client libraries | `0.3.0` | Q3 2026 | Gina loads connector clients (`couchbase`, `ioredis`, `mysql2`, `pg`, `mongodb`, `@scylladb/scylla-driver`) from the user's project `node_modules` via a dynamic `require()`. Currently `package.json` has no `peerDependencies` — no signal of which library versions are tested and supported. Add `peerDependencies` and `peerDependenciesMeta` (all optional) listing each connector client with the tested version range. Gives `npm install` a compatibility warning if a user pins an untested version. No runtime change. _Done: 2026-03-28_ |

---

## Couchbase Connector Hardening (#CB)

Findings from the 2026-03-27 cold audit of `core/connectors/couchbase/`. Ordered by severity. Audit report: `.claude/audit/2026-03-27-couchbase-connector-audit.md`.

### Security — Critical

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #CB1 | — | Fix `restQuery()` credential exposure in process list | `0.2.0` | Q2 2026 | **CB-SEC-1** (`connector.v3.js:283`, `connector.v4.js:277`). `exec(cmd.join(' '))` interpolated `-u username:password` directly into the shell command string. The full command — including plaintext credentials — appeared in `ps aux` for the duration of the call. **Fix:** replaced `exec()` with `execFile()` with an args array, credentials passed as positional arguments. Only fires on the `useRestApi: true` code path. _Done: 2026-03-27 · commit `558b9c59`_ |
| ✅ | #CB2 | — | Fix shell command injection in `restQuery()` | `0.2.0` | Q2 2026 | **CB-SEC-2** (`connector.v3.js:269–285`, `connector.v4.js:263–279`). `statement` and `queryParams.parameters` were joined into a single shell string via `exec(cmd.join(' '))`. The quote-escaping pass only replaced `'` with `"` — it did not neutralise `$`, `;`, `&`, `|`, backtick, or `\n`. **Fix:** replaced `exec()` with `execFile()` — same change as #CB1. _Done: 2026-03-27 · commit `558b9c59`_ |

### Bugs — High

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #CB3 | — | Fix `gina.onError()` handler accumulation on reconnect | `0.2.0` | Q2 2026 | **CB-BUG-1** (`connector.v2.js:139`, `connector.v3.js:148`, `connector.v4.js:164`). `gina.onError(handler)` was registered inside `onConnect()`, which fired on every reconnection. After N reconnects, N stacked handlers raced on the same error. **Fix:** `if (!self._errorHandlerRegistered)` guard wraps the `gina.onError` call so it registers only once per connector instance. _Done: 2026-03-27 · commit `558b9c59`_ |
| ✅ | #CB4 | — | Fix `session-store.v3 get()` — always returns "session not found" | `0.2.0` | Q2 2026 | **CB-BUG-2** (`session-store.v3.js:183–206`). `.then()/.catch()` callbacks were microtasks but the `if (!data)` guard ran synchronously in the same tick — `data` was always `null`. Every `get()` call returned `fn()` with no session. **Fix:** rewrote `get()` with `async/await` (matching the v4 store). _Done: 2026-03-27 · commit `558b9c59`_ |
| ✅ | #CB5 | — | Fix `session-store.v3 set()` — silently discards writes | `0.2.0` | Q2 2026 | **CB-BUG-3** (`session-store.v3.js:250–265`). Same async/sync confusion as #CB4. `fn(false, null)` was called before the upsert Promise resolved. **Fix:** rewrote `set()` with `async/await`. _Done: 2026-03-27 · commit `558b9c59`_ |
| ✅ | #CB6 | — | Fix infinite recursion when `keepAlive: false` | `0.2.0` | Q2 2026 | **CB-BUG-4** (`connector.v2.js:426–428`, `connector.v3.js:460–462`, `connector.v4.js:454–456`). The `else` branch in `ping()` called `self.ping(interval, cb, ncb)` unconditionally — stack overflow on first connection with `keepAlive: false`. **Fix:** replaced the unconditional self-call with a `return` (no-op when `keepAlive` is false, as intended). _Done: 2026-03-27 · commit `558b9c59`_ |

### Medium

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #CB7 | — | Remove 300ms arbitrary startup delay before `ready` emit | `0.3.0` | Q3 2026 | **CB-PERF-1** (`connector.v3.js:215–217`, `connector.v4.js:231–233`). A `setTimeout(300)` was added because something "was not working yet on Mac OS X" — root cause never identified. **Fix:** removed the `setTimeout`; `self.emit('ready', false, self.instance)` is called directly. _Done: 2026-03-28 · commit `43875aac`_ |
| ✅ | #CB8 | — | Fix `ping()` undefined `next` variable in v2 and v3 | `0.3.0` | Q3 2026 | **CB-PERF-2** (`connector.v2.js:413`, `connector.v3.js:447`). `typeof(next) != 'undefined'` — but `next` is not in scope in the `ping` method. **Fix:** changed `typeof(next)` to `typeof(ncb)` and updated the self-call to pass `ncb`. _Done: 2026-03-28 · commit `43875aac`_ |
| ✅ | #CB9 | — | Remove duplicate `modelUtil.setConnection()` call | `0.3.0` | Q3 2026 | **CB-PERF-3** (`connector.v2.js:121–123`, `connector.v3.js:129–133`, `connector.v4.js:145–149`). `setConnection()` was called twice with identical arguments before `reloadModels()`. **Fix:** removed the redundant first call outside the `fs.existsSync` block. _Done: 2026-03-27 · commit `558b9c59`_ |
| ✅ | #CB10 | — | Remove stack traces from HTTP 500 responses | `0.3.0` | Q3 2026 | **CB-QUAL-1** (`connector.v2.js:183–188`, `connector.v3.js:192–198`, `connector.v4.js:208–214`). `err.stack` was included in `res.end(JSON.stringify({...}))`. **Fix:** `err.stack` logged server-side via `console.error`; client receives only `{ status: 500, error: err.message }`. _Done: 2026-03-27 · commit `558b9c59`_ |
| ✅ | #CB11 | — | Replace `eval()` for `@options` parsing in `.sql` files | `0.3.0` | Q3 2026 | **CB-QUAL-2** (`index.js:242`). `@options` directives in `.sql` files were evaluated with `eval()`. **Fix:** replaced with a regex normalisation pass (unquoted JS keys → quoted) then `JSON.parse()`. Handles all value shapes in production files (`"request_plus"`, `"not_bounded"`, `true`, `false`, numeric). _Done: 2026-03-28 · commit `193f46ca`_ |
| ✅ | #CB12 | — | Make `bulkInsert` return a Promise | `0.3.0` | Q3 2026 | **CB-QUAL-3** (`index.js:1119–1129`). `bulkInsert` still used the old `_proto` pattern — returned a plain `{onComplete: fn}` object. **Fix:** converted to the Option B Promise pattern (`new Promise(resolve, reject)` with `.onComplete(cb)` chaining), matching all other N1QL entity methods. _Done: 2026-03-28 · commit `43875aac`_ |

### Low

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #CB13 | — | Sanitise `bulkInsert` document key in N1QL string | `0.4.0` | Q4 2026 | **CB-QUAL-4** (`index.js:1018`). `id` (the document key) was interpolated directly into the N1QL string — a `"` in the key would break the query. **Fix:** replaced `'"'+ id +'"'` with `JSON.stringify(String(id))`. _Done: 2026-03-28 · commit `cdceb33a`_ |

---

## K8s & Docker (#K)

| Status | ID | Public | Feature | Version | Date / Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #K1 | ✓ | Graceful HTTP shutdown on SIGTERM | `0.1.8` | 2026-03-06 | Commits `9f0a28c3`, `7abe0d0b`. `proc.js` drains in-flight requests via `server.close()` with configurable hard timeout (`GINA_SHUTDOWN_TIMEOUT`, default 10s). |
| ✅ | #K2 | ✓ | Foreground bundle launcher (`bin/gina-container`) | `0.1.8` | 2026-03-06 | Commit `719ff0ae`. Replaces `gina bundle:start + gina tail` in container entrypoints. Spawns bundle non-detached, forwards SIGTERM to child, waits for graceful drain, exits with child's code. No framework socket server required. |
| ✅ | #K3 | ✓ | stdout/stderr structured logging (`GINA_LOG_STDOUT`) | `0.1.8` | 2026-03-21 | Commit `469c1502`. `GINA_LOG_STDOUT=true` activates stdout-only mode: JSON lines (`ts`, `level`, `group`, `msg`) instead of coloured output; MQ transport skipped. Compatible with `kubectl logs`, Fluentd, Datadog. |
| ✅ | #K4 | ✓ | `gina-init`: stateless `~/.gina/` bootstrap for containers | `0.1.8` | 2026-03-22 | Commit `bf701661`. Standalone `bin/gina-init` generates all 4 required files from env vars or a mounted JSON config file. Port allocation mirrors the real schema. Idempotent. |
| ✅ | #K5 | ✓ | Session storage for horizontal scaling | `0.2.0` | Q2 2026 | Redis session store (#CN1) + SQLite session store (#CN2 v1) + sessions guide + K8s multi-pod docs with managed provider table (Upstash/ElastiCache/Cloud Memorystore/Azure) + K8s Secrets patterns. _Done: 2026-03-27 · docs commit `5822c07`_ |

---

## Observability (#OBS)

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #OBS1 | ✓ | Prometheus metrics endpoint | `0.4.0` | Q4 2026 | Built-in `/_gina/metrics` endpoint (Prometheus exposition format). Opt-in via `app.json` `"metrics": { "enabled": true, "path": "/_gina/metrics", "allowFrom": ["127.0.0.1"] }`. Implementation: `lib/metrics/index.js` wraps `prom-client` (loaded from project `node_modules` — peer dep, same pattern as `ioredis`/`mysql2`); `server.isaac.js` serves the endpoint in the `/_gina/` namespace alongside existing internal routes; router hooks record request start time + route pattern (`req.routing.rule`) + method + status code at response exit. Default metrics: Node.js process via `prom-client.collectDefaultMetrics()` (heap, GC pause, event loop lag, active handles). HTTP metrics: `http_requests_total{method,route,status}` counter + `http_request_duration_seconds{method,route}` histogram. Route label always comes from `routing.json` pattern — never from raw URL — to prevent cardinality explosion from path parameters. Each bundle is an independent scrape target on its own port. `prom-client` is NOT vendored. |

---

## AI (#AI)

### Phase 1 — AI can write Gina code correctly

AI assistants pointed at a Gina project currently have to reverse-engineer patterns from source. These items give them authoritative, machine-readable structure.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #AI1 | — | `llms.txt` | `0.2.0` | Q2 2026 | Single file at the repo root synthesising the `.claude/architecture/` docs into a concise, LLM-optimised summary. Picked up automatically by Cursor, Copilot, Claude.ai, and any tool that follows the `llms.txt` convention. The material already exists — this is a formatting and curation exercise. _Done: 2026-03-28_ |
| ✅ | #AI2 | ✓ | JSON Schemas for config files | `0.2.0` | Q2 2026 | Machine-readable schemas for `routing.json`, `connectors.json`, `app.json`, `settings.json`, `app.crons.json`. Add `"$schema"` references to generated scaffold files. Gives editors free validation and autocomplete; gives AI assistants authoritative field names so generated config is correct on the first attempt. Highest-leverage single item in the roadmap — benefits editors, AI, validation tooling, and docs generation simultaneously. _Done: 2026-03-27 · commit `5574dbdc`_ |
| 📋 | #AI3 | ✓ | Complete JSDoc + `.d.ts` | `0.4.0` | Q4 2026 | Cross-listed with #M9. Without type declarations, AI infers shapes from usage (~70% accuracy). With `.d.ts` it is 100%. #AI2 and #AI3 together make AI-generated Gina code reliable. |

### Phase 2 — Gina apps can use AI

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #AI4 | ✓ | AI connector | `0.3.0` | Q3 2026 | New connector type declared in `connectors.json`, following the same pattern as Couchbase/MongoDB. Wraps the Anthropic (or OpenAI) SDK, reads `apiKey` from config or env, returns a client via `getConnection()`. Supported protocols: `anthropic://`, `openai://`. |
| 📋 | #AI5 | ✓ | `renderStream` — streaming response primitive | `0.3.0` | Q3 2026 | LLM responses are streamed token by token. Add `self.renderStream(asyncIterable, contentType)` to the controller pipeline. Writes SSE (`text/event-stream`) or chunked JSON without buffering. Without this, every LLM integration bypasses the render pipeline with raw `res.write()`, losing error handling and memory cleanup. |
| 📋 | #AI6 | ✓ | Async job pattern for slow AI calls | `0.4.0` | Q4 2026 | LLM calls take 1–30s. Formalise the "start job → return jobId → poll or webhook on completion" pattern as a first-class framework primitive, integrated with the existing cron/queue infrastructure. Prevents LLM latency from degrading the whole request pipeline. |

### Phase 3 — AI agents can consume Gina apps

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #AI7 | ✓ | OpenAPI spec generation from `routing.json` | `0.4.0` | Q4 2026 | `gina bundle:openapi @myproject` emits `openapi.json` from the structured data already in `routing.json` (method, path, params, auth). Makes any Gina app immediately consumable by AI agents, API gateways, and API testing tools (Postman, Bruno) with zero manual spec writing. Route annotations become the OpenAPI `description` fields. |
| 📋 | #AI8 | ✓ | MCP server wrapper | `0.4.0` | Q4 2026 | `gina bundle:mcp @myproject` wraps `routing.json` routes as MCP (Model Context Protocol) tools. Tool names and descriptions sourced from route annotations. Makes any Gina app a native MCP server. Sits one layer above #AI7: OpenAPI is for HTTP clients, MCP is for AI agents specifically. |

---

## Adoption (#A)

> Internal track — not in the public roadmap. Items here should simply be done, not announced.

### Phase 1 — First impression

Low effort, high impact. These are the signals a developer evaluates in the first 60 seconds on the GitHub page or npm listing.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #A1 | — | CI pipeline (GitHub Actions) | `0.2.0` | Q2 2026 | Add `.github/workflows/test.yml`: run `node --test test/core/` on push and PR to `develop` and `master`. Node matrix: 18, 20, 22. Adds a passing CI badge to the README — the single strongest trust signal for an unfamiliar project. Prerequisite for #V5 (Awesome Node.js requires CI). _Done: 2026-03-27 · commit `d6ad21fb`_ |
| ✅ | #A2 | — | CHANGELOG.md committed to master | `0.1.8` | 2026-03-26 | First committed as part of the `0.1.8-alpha.1` release batch. |
| ✅ | #A3 | — | npm keywords cleanup | `0.2.0` | Q2 2026 | Current keywords are 80% self-referential. Replace with discoverable terms: `node.js`, `http2`, `mvc`, `rest-api`, `full-stack`, `server-side-rendering`, `event-driven`, `couchbase`, `mongodb`, `typescript`. npm search ranks on keywords. Cross-listed as #V3. _Done: 2026-03-28 · commit `b0750020`_ |
| ✅ | #A4 | — | CONTRIBUTING.md | `0.2.0` | Q2 2026 | Document: how to clone + run tests locally, commit message style, changie workflow, branch model (`develop` → `master`), PR checklist. Signals an actively maintained project. _Done: 2026-03-26 · commit `5ff90078`_ |
| ✅ | #A5 | — | GitHub issue and PR templates | `0.2.0` | Q2 2026 | `.github/ISSUE_TEMPLATE/bug_report.md` (Node version, gina version, repro steps) and `.github/PULL_REQUEST_TEMPLATE.md` (checklist: tests, changie entry, docs updated). _Done: 2026-03-28_ |

### Phase 2 — On-ramp

The barrier between "this looks interesting" and "I have a running app" must be under 5 minutes.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #A6 | — | Starter / example repository | `0.2.0` | 2026-03-29 | `gina-io/gina-starter` repo created at `~/Sites/gina/gina-starter/`. One bundle (`demo`), one route (`GET /`), HTML template rendering, CSS stubs. `gina project:add @myproject --path=$(pwd) && gina bundle:add demo @myproject && gina bundle:start demo @myproject` → browser shows "Hello World !". `bundle/add.js` patched (#A6): when `rewrite=false` and the bundle source directory already exists, `createBundle()` skips the boilerplate copy and preserves the cloned source files. |
| 📋 | #A7 | — | Docker Compose starter | `0.3.0` | Q3 2026 | `docker-compose.yml` in the starter repo: Gina app container + Couchbase Community container, pre-seeded with starter data. Zero local DB setup for new evaluators. |
| 📋 | #A8 | — | `gina new` scaffold improvements | `0.3.0` | Q3 2026 | Current scaffold generates the directory structure but not a runnable app. Make `gina new <project>` produce a project that starts and responds to `GET /` immediately. |

### Phase 3 — Community infrastructure

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #A9 | — | README modernisation | `0.2.0` | Q2 2026 | Add: (1) a 3-bullet "why Gina" section at the top, (2) a feature highlights table (HTTP/2, multi-bundle, scope-based isolation, hot-reload, no Express), (3) a "Quick start" section in 5 commands, (4) badges for CI, npm version, license, Node compatibility. Move detailed install variants to a collapsible section or docs site. _Done: 2026-03-27 · commit `18fc11ef`_ |
| ✅ | #A10 | — | GitHub Discussions | `0.2.0` | Q2 2026 | Enable Discussions on the repo (Q&A + Show and Tell categories). Gives users a place to ask questions without opening issues. _Done: 2026-03-27 · commit `a7f940f5`_ |
| ✅ | #A11 | — | Dependabot config | `0.1.8` | 2026-03-26 | Added `.github/dependabot.yml` for root `package.json`, weekly schedule, vendored deps excluded. |

### Phase 4 — Tutorials

Prerequisite for all three: starter repo (#A6) must exist so readers can follow along with a working project.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #A15 | ✓ | "Using Gina as a mobile backend" guide | `0.3.0` | Q3 2026 | Focused guide on the docs site: REST API patterns with Gina (JSON-only bundles, `renderJSON` as the sole render path), authentication for mobile clients (token-based, session-less), CORS config, HTTP/2 for mobile, and the path to OpenAPI/MCP (#AI7/#AI8) for SDK generation. Answers the "can I use Gina for my mobile app?" question directly and gives a working path forward. No code changes — docs only. |
| 📋 | #A12 | ✓ | Beginner tutorial — 5 min | `0.3.0` | Q3 2026 | "Your first Gina app in 5 minutes." Install, scaffold, one route, one controller action, browser response. Lives on the docs site as the first entry under Getting Started. The CLI scaffold (`gina new` + `gina bundle:add`) is the starting point — the finished state IS what a starter repo would be. No external dependency. |
| 📋 | #A16 | ✓ | Tutorial locale detection — pre-fill `settings.json` from visitor locale | `0.3.0` | Q3 2026 | At the start of the beginner and intermediate tutorials, detect the reader's locale and timezone via `navigator.language` + `Intl.DateTimeFormat().resolvedOptions().timeZone` and pre-fill the `settings.json` scaffold example with their detected `region`, `preferedLanguages`, `24HourTimeFormat`, and `timeZone` values. Implemented as a client-side React component in Docusaurus (MDX). Falls back to `en_CM` for unrecognised locales. Prerequisite: #A12. The static reference docs (settings.json reference) keep `en_CM` as the fixed example — dynamic detection is only meaningful where the reader is actively generating config they will paste into a real project. |
| 📋 | #A13 | ✓ | Intermediate tutorial — ~30 min | `0.3.0` | Q3 2026 | Multi-bundle setup, routing with URL params, entity + connector wiring, basic template rendering with Swig, simple form handling. Readers scaffold from scratch and build up. A companion repo with the finished state is useful as a reference but not required — can be added after. No external dependency. |
| 📋 | #A14 | ✓ | Advanced tutorial — ~60 min | `0.4.0` | Q4 2026 | Full production-grade project: authentication, scoped data isolation, async entity calls (post #M4), HTTP/2, structured logging, Docker/K8s deployment with `gina-container`. Readers must either have completed the intermediate tutorial or clone a checkpoint from its finished state. Prerequisite: #A13 (or companion repo derived from it). |

---

## Visibility (#V)

> Internal track — not in the public roadmap. Marketing and distribution strategy.

### Phase 1 — Metadata

Fixes that take minutes and affect every npm search result, GitHub Explore listing, and package page.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #V1 | — | Fix `package.json` description | `0.1.8` | 2026-03-26 | Updated to: `"Node.js MVC framework with built-in HTTP/2, multi-bundle architecture, and scope-based data isolation — no Express dependency"`. |
| ✅ | #V2 | — | GitHub topics | `0.2.0` | Q2 2026 | Add via repo Settings UI: `nodejs`, `mvc`, `http2`, `framework`, `javascript`, `couchbase`, `mongodb`, `event-driven`. Takes 30 seconds. Makes the repo appear in GitHub Explore and topic search pages. _Done: 2026-03-27 · commit `a7f940f5`_ |
| ✅ | #V3 | — | npm keywords cleanup | `0.2.0` | Q2 2026 | Cross-listed as #A3. Directly affects npm search ranking. _Done: 2026-03-28 · commit `b0750020`_ |
| ✅ | #V4 | — | CHANGELOG.md on master | `0.1.8` | 2026-03-26 | Cross-listed as #A2. Done. |

### Phase 2 — Listings and backlinks

One-time submissions to high-authority directories. Each accepted listing is a permanent backlink.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ⏸ | #V5 | — | Awesome Node.js PR | `0.2.0` | Q2 2026 | Submit to `sindresorhus/awesome-nodejs` under `### Web frameworks` — entry format: `- [Gina](https://github.com/Rhinostone/gina) - MVC framework with multi-bundle architecture, HTTP/2, and built-in scope-based environment isolation.` · **Blocked**: awesome-nodejs requires ≥100 GitHub stars (currently 10). All other prerequisites met: CI badge (#A1 ✅), clean README (#A9 ✅), repo age (2013). Revisit when stars reach 100. |
| ⏸ | #V6 | — | NodeFrameworks.com listing | `0.2.0` | Q2 2026 | **Defunct.** nodeframeworks.com does not resolve (DNS failure). No active GitHub repo found. Removed from scope. |

### Phase 3 — Content

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #V7 | — | Long-tail SEO landing pages on gina.io/docs | `0.3.0` | Q3 2026 | Target queries where Gina has a real differentiator: "node.js http2 framework", "node.js mvc without express", "node.js multi-bundle architecture", "couchbase node.js orm". One focused guide per query. The gina.io domain already has authority — targeted pages compound it. |
| 📋 | #V8 | — | dev.to / Hashnode article — "Building a REST API with Gina in 10 minutes" | `0.3.0` | Q3 2026 | Ranks fast on dev.to (high domain authority), links back to npm and GitHub. Prerequisite: starter repo (#A6) must exist so readers can follow along. One article per month sustains consistent inbound. |

### Phase 4 — Web presence

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #V9 | ✓ | Official website redesign + docs integration | `0.4.0` | Q4 2026 | Refactor gina.io to serve as a proper project homepage (landing page, feature highlights, showcase). Integrate or replace the existing gina-io content with the Docusaurus docs site so there is a single coherent web presence. Decide on domain strategy: one unified site vs. a marketing landing page at gina.io + docs at gina.io/docs. Prerequisite: stable docs (#A12–#A14 complete) so the site has content worth promoting. |
| 📋 | #V10 | ✓ | Docs offline ZIP | `0.4.0` | Q4 2026 | One-click download of the complete gina.io documentation as a static HTML ZIP archive. Generated at deploy time by the Docusaurus build pipeline — no server-side logic required. Targeted at users in regions with limited or expensive internet access. Offline-first for the African market. |
| 📋 | #V11 | ✓ | Security & CVE compliance page | `0.3.0` | Q3 2026 | Dedicated page on gina.io/docs listing the HTTP/2 CVEs Gina addresses and the Node.js version requirements for each mitigation: CVE-2023-44487 (Rapid Reset — `maxSessionRejectedStreams` + Node ≥ 20.12.1), CVE-2024-27316 / CVE-2024-27983 (CONTINUATION flood — `maxSessionInvalidFrames` + Node ≥ 18.20.1 / 20.12.1), CVE-2019-9514 (RST flood — `maxSessionRejectedStreams`), CVE-2019-9512 (PING flood — nghttp2 internal), CVE-2019-9515 (Settings flood — nghttp2 internal). Docs only — no code changes. Target audience: enterprise and security-conscious developers evaluating the framework. |

---

## Performance (#P)

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #P1 | ✓ | `NODE_COMPILE_CACHE` — V8 bytecode startup cache | `0.2.0` | Q2 2026 | Node.js 22.8+ caches compiled V8 bytecode to disk. Set `NODE_COMPILE_CACHE` in `gna.js` at startup (one line). Subsequent framework starts skip parsing and compilation entirely — 30–60% faster cold start for free, zero code changes to user bundles. Fallback: no-op on Node < 22.8, so safe to ship unconditionally. _Done: 2026-03-27 · commit `9f261b82`_ |
| 📋 | #P2 | ✓ | Route radix tree — compile `routing.json` at startup | `0.3.0` | Q3 2026 | Current router does linear string matching against `routing.json` on every request. Pre-compile routes into a radix tree at bundle startup. Matching becomes O(log n) instead of O(n). Largest gain for apps with many routes; 2–3x faster routing layer in all cases. Change is internal to `core/router.js` — no user-facing API change. |
| 📋 | #P3 | ✓ | Bun runtime compatibility investigation | `0.4.0` | Q4 2026 | Prototype Gina running under Bun. Two hard blockers to verify first: (1) `require.cache` deletion — Gina's dev-mode hot-reload depends on this; (2) `node:http2` completeness — HTTP/2 is a core Gina feature. If both pass, Bun gives 3–10x faster startup and meaningful throughput gains for free. Deliverable: a compatibility report with a list of patches needed, not necessarily a fully working port. |
| ✅ | #P4 | ✓ | V8 pointer compression support (node-caged compatible) | `0.2.0` | Q2 2026 | Node.js built with `--experimental-enable-pointer-compression` delivers ~50% heap memory reduction for all pointer-heavy structures (objects, arrays, routing tables, template caches) at the cost of a 4 GB per-isolate ceiling. Gina is pure JS — no code changes needed for compatibility. Deliverables: (1) startup detection in `gna.js` — sets `GINA_V8_POINTER_COMPRESSED=true` and logs heap limit; (2) Dockerfile guide updated with pointer-compression base image options and custom build recipe (including `--with-intl=full-icu` + ARM64 crypto extensions — a superset of node-caged); (3) documentation: 4 GB ceiling implications, `--max-old-space-size` behaviour, scaling strategies, native addon ABI policy (N-API only); (4) couchbase v2 connector startup warning when `GINA_V8_POINTER_COMPRESSED=true` (v2 uses NAN-based bindings — incompatible). _Done: 2026-03-27 · commit `b596d7d7`_ |

---

## Windows (#W)

Windows compatibility is a hard requirement for `1.0.0`. The alpha scope means all core features work correctly on Windows — install, scaffold, bundle start/stop, routing, rendering, and basic CLI. Full production-grade parity (build system, all CLI commands) is post-1.0.0.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #W1 | ✓ | Windows alpha compatibility | `1.0.0` | Q3 2027 | **Alpha scope (hard gate for 1.0.0):** install scripts (`pre_install.js`, `post_install.js`) work without Unix shell commands; path separators handled correctly throughout; symlink creation falls back to `junction` on Windows; `os.homedir()` replaces all `~` expansion; basic bundle start/stop/restart via `gina-container` works; `bin/gina.bat` kept in sync with `bin/gina`. **Out of alpha scope (post-1.0.0):** full build system (bash-based asset pipeline), all CLI commands, production-grade daemon/process management, Windows service integration. Blocked areas: SIGTERM semantics differ on Windows; `ps`/`kill` have no native equivalent; detached child process model maps poorly to Windows. CI matrix must include a Windows runner before this can be marked done. |

---

## Sustainability (#S)

> Internal track — not in the public roadmap.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #S1 | — | Donation page on gina.io/docs | `0.2.0` | 2026-03-29 | `docs/support.md` created. Sections: GitHub Sponsors CTA, star the repo, contribute, spread the word. Filtered from main sidebar (like roadmap), `supportSidebar` added to `sidebars.js`. "Support Gina" and "GitHub Discussions" links added to footer in `docusaurus.config.js`. `FUNDING.yml` created in gina repo (GitHub Sponsors: Rhinostone). |

---

## Unit Tests (#UT)

> Internal track — not in the public roadmap. See `unit-tests.md` for the full test inventory.

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #UT1 | — | HTTP/2 client mock harness + retry path tests | `0.3.0` | Q3 2026 | Test `handleHTTP2ClientRequest` retry paths: GOAWAY premature close (#H1), 502 upstream (#H2), stream timeout, stream error. Requires a mock harness for `node:http2` ClientHttp2Session + ClientHttp2Stream, framework cache (`serverInstance._cached`), `getContext('gina')`, and `local.req/res`. No mock harness exists yet — blocked on building one before any HTTP/2 client tests can be written. |

---

## HTTP/2 (#H)

Sourced from the HTTP/2 audit (`2026-03-27-http2-audit.md`). Items cover the three confirmed bugs, security hardening, observability, configuration, and advanced protocol features.

### Bug Fixes & Security Hardening

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ | #H1 | ✓ | Fix `/_gina/info` HTTP/2 endpoint — pass `infoStatus` not `infoHeaders` | `0.2.0` | Q2 2026 | **BUG-H1** (`isaac.js:529`). `stream.end(infoHeaders)` passes the response headers object instead of the JSON string `infoStatus`. On HTTP/2 the endpoint returns `[object Object]`. One-line fix. Severity: medium (internal endpoint). _Done: 2026-03-27 · commit `cdc3b3b1`_ |
| ✅ | #H2 | ✓ | Add stream-closed guard to HTML error response path | `0.2.0` | Q2 2026 | **BUG-H2** (`server.js:3644`). `throwError()` HTML path has a TODO noting no `stream.destroyed \|\| stream.closed` check before writing the error response. JSON error path has this guard; HTML path does not. If the stream closes between the error being triggered and the response written, Node.js emits an unhandled error. Severity: low (race condition, infrequent). _Done: 2026-03-27 · commit `cdc3b3b1`_ |
| ✅ | #H3 | ✓ | HTTP/2 server security settings — `maxHeaderListSize`, `enablePush: false`, `maxSessionInvalidFrames`, `maxSessionRejectedStreams` | `0.2.0` | Q2 2026 | Four missing settings on the server object in `isaac.js:309-314`: (1) `maxHeaderListSize: 65536` — prevents HPACK bomb attack (currently only set on client). (2) `enablePush: false` — server push deprecated in Chrome 106+ and removed in Firefox 132+; push is dead for browser traffic; should be off by default. (3) `maxSessionInvalidFrames` — explicit value (recommended: 1000) defends against CONTINUATION flood (CVE-2024-27316/CVE-2024-27983). (4) `maxSessionRejectedStreams` — explicit value (recommended: 100) defends against RST flood (CVE-2019-9514) and rapid reset (CVE-2023-44487). All are configuration-only changes. _Done: 2026-03-27 · commit `cdc3b3b1`_ |

### Observability & Configuration

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #H4 | ✓ | 103 Early Hints — send `Link` preload headers as informational response | `0.3.0` | Q3 2026 | **BUG-H3** (`render-swig.js:1127`). `Link` preload headers are correctly built and set via `res.setHeader('link', links)` but are sent with the final response, not before it. Modern replacement for server push: call `stream.additionalHeaders({ ':status': 103, 'link': links })` before `stream.respond()` on the HTTP/2 path. Allows the browser to start preloading CSS/JS while the server is still rendering the template. Supported: Chrome 103+, Edge 103+, Node.js http2. |
| 📋 | #H5 | — | Log GOAWAY `errorCode` and `lastStreamID` | `0.3.0` | Q3 2026 | `controller.js:3003-3008` handles `client.on('goaway')` (session evicted, stream retried) but does not log the GOAWAY error code or the last processed stream ID. These two values are essential for debugging upstream connection management issues (e.g., distinguishing a clean server restart from a protocol error). One-line addition to the existing GOAWAY handler. |
| 📋 | #H6 | ✓ | HTTP/2 session metrics via `/_gina/info` | `0.3.0` | Q3 2026 | No counters exist for: active HTTP/2 sessions, active stream count, GOAWAY events received, RST_STREAM events received. Add these to the `/_gina/info` endpoint response and to the `GINA_LOG_STDOUT` structured log output. Gives ops teams visibility into the session pool state without an external APM. |
| 📋 | #H7 | ✓ | Expose `maxConcurrentStreams` and `initialWindowSize` as bundle config | `0.3.0` | Q3 2026 | Both values are hardcoded in `isaac.js`: `maxConcurrentStreams: 1000` (very permissive — RFC recommends 100–256 for public endpoints) and `initialWindowSize: 655,350` (10× default — right for high-throughput APIs, wrong for low-bandwidth clients). Move both to `settings.server.json` with sensible defaults (`maxConcurrentStreams: 256`, `initialWindowSize: 65535`). No API change; existing deployments keep current behaviour until they opt in to the config key. |

### Hardening

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #H8 | — | Direct `stream.respond()` for HTML rendering | `0.4.0` | Q4 2026 | `render-swig.js` has the direct HTTP/2 stream path commented out in multiple locations (lines 775-782, 1204-1211, 1236-1241). HTML rendering currently goes through `local.res.end()` (HTTP/1.1 compat layer). JSON rendering (`render-json.js`) already uses the direct path. Completing and uncommenting the direct HTML path removes the compat layer overhead, enables `respondWithFile` and `waitForTrailers`, and aligns HTML and JSON rendering behaviour. Prerequisite: thorough test coverage of all HTML render exit paths first (#UT1). |
| 📋 | #H9 | ✓ | Application-level rapid reset rate limiter (CVE-2023-44487) | `0.4.0` | Q4 2026 | Node.js ≥ 20.12.1 / 18.20.1 contains the OS-level fix for rapid reset. For public-facing deployments, add an application-level counter: track stream creation rate per session within a 1s window; if it exceeds a threshold (e.g., 200 streams/s), close the session with GOAWAY. More targeted than `maxSessionRejectedStreams` (which counts refused streams, not created ones). Implement in `isaac.js` `session` event handler. |
| 📋 | #H10 | ✓ | Trailer support — `stream.sendTrailers()` + `waitForTrailers: true` | `0.4.0` | Q4 2026 | No use of `stream.sendTrailers()` or the `wantTrailers` option anywhere in the codebase. Trailers are required for gRPC-style streaming (final status code, grpc-status) and useful for content integrity (`Digest` trailer after chunked response). Add opt-in support: if a controller calls `self.sendTrailers(fields)`, the render pipeline sets `waitForTrailers: true` on `stream.respond()` and calls `stream.sendTrailers(fields)` in the `wantTrailers` event. No breaking change — only activated when `sendTrailers` is called. |

### Future

| Status | ID | Public | Feature | Version | Target | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 📋 | #H11 | ✓ | Alt-Svc / HTTP/3 advertisement header | `0.5.0` | Q1 2027 | Set `Alt-Svc: h3=":443"; ma=86400` response header to advertise HTTP/3 (QUIC) availability. Gina does not need to implement QUIC — just advertise it so clients that can use it (via a QUIC-capable reverse proxy like nginx with QUIC, Caddy, or Cloudflare) automatically upgrade. Additive: one `res.setHeader` call in the request pipeline, gated on a `settings.server.json` option (`http3Advertisement: true`). **This is the full extent of Gina's HTTP/3 story — native QUIC is explicitly out of scope.** Node.js has no stable QUIC API (experimental since Node 20, not yet stable), implementing it would require native C bindings (`quiche`, `ngtcp2`) breaking the pure-JS zero-native-dependency principle, and the standard production topology (Gina → Caddy/nginx/Cloudflare → client) already delivers HTTP/3 to end users at the edge. For African mobile users on lossy networks where HTTP/3's 0-RTT and connection migration matter most, Cloudflare already handles this for free. Revisit native QUIC only if Node.js ships a stable API and there is evidence of significant Gina deployments without a reverse proxy. |
| 📋 | #H12 | ✓ | RFC 9218 Extensible Priorities — read `Priority` request header | `0.5.0` | Q1 2027 | RFC 9218 replaces the old HTTP/2 stream priority tree (deprecated in RFC 9113 §5.3) with a simple `Priority: u=N, i` request header. Read the header in the routing layer and use it to order response writes. Low value for typical HTML page loads (single resource per request); high value for multiplexed API clients making many parallel requests with declared urgency levels. |
| 📋 | #H13 | ✓ | WebSocket over HTTP/2 (RFC 8441 — CONNECT method extension) | `0.5.0` | Q1 2027 | RFC 8441 allows WebSocket tunneling over HTTP/2 streams via the CONNECT method extension. Enables WebSocket without a separate HTTP/1.1 connection, which is important for HTTP/2-only deployments. Node.js supports this since v10.19. Scope: detect `CONNECT` with `protocol: websocket` upgrade request in the server; route to a WebSocket handler; manage the stream lifecycle. Does not require a full WebSocket library rewrite — the framing is identical to HTTP/1.1 WebSocket once the stream is established. |
