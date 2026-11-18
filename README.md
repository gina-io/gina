# Gina

[![npm version](https://img.shields.io/npm/v/gina)](https://www.npmjs.com/package/gina) [![npm downloads](https://img.shields.io/npm/dm/gina)](https://www.npmjs.com/package/gina) [![GitHub stars](https://img.shields.io/github/stars/gina-io/gina)](https://github.com/gina-io/gina/stargazers) [![Tests](https://github.com/gina-io/gina/actions/workflows/test.yml/badge.svg)](https://github.com/gina-io/gina/actions/workflows/test.yml) [![Socket](https://img.shields.io/badge/Socket-view%20analysis-blue)](https://socket.dev/npm/package/gina) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/gina-io/gina/badge)](https://scorecard.dev/viewer/?uri=github.com/gina-io/gina) [![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D%2022-brightgreen)](https://nodejs.org) [![Bun >= 1.2](https://img.shields.io/badge/Bun-%3E%3D%201.2-brightgreen)](https://bun.sh) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Documentation:** [gina.io/docs](https://gina.io/docs/) · **Issues:** [GitHub](https://github.com/gina-io/gina/issues) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Security:** [SECURITY.md](./SECURITY.md)

MVC framework for Node.js and Bun with built-in HTTP/2, multi-bundle architecture, and scope-based data isolation — no Express dependency.

- **HTTP/2 first.** Built-in `isaac` server with TLS, h2c, ALPN, HTTP/1.1 fallback, and full CVE hardening (Rapid Reset, CONTINUATION flood, RST flood, HPACK bomb) — all on by default.
- **Multi-bundle.** One project hosts multiple independent bundles (API, web, admin, …). Each bundle has its own routing, controllers, models, and config. Share code via the project layer.
- **Scope isolation.** Run `local`, `beta`, and `production` from the same codebase. Scopes propagate through routing, config interpolation, and data (every DB record is stamped with `_scope`).
- **Batteries included.** Forms & validation, sessions, uploads, async jobs, response caching, CSRF, security headers, route authorization, audit trail, i18n, OpenAPI + MCP generation — built in, not bolted on.

## Features

| Feature | Detail |
| --- | --- |
| HTTP/2 server | Built-in `isaac` engine — TLS, h2c, ALPN, HTTP/1.1 fallback, 103 Early Hints, RFC 9218 request priorities, CVE-hardened |
| Multi-bundle | One project, N independent bundles with shared config and project layer |
| Scope isolation | `local` / `beta` / `production` — per-request and per-record |
| MVC routing | `routing.json` — declare routes in config, not code; an index built once per routing table narrows each cold match to the rules the URL could reach, and a hot path is served from the route cache |
| Fast lane | Opt-in JSON routes without a controller — `param.lane` names a handler module under `lanes/` that answers with `ctx.json()` / `ctx.error()`; the request id, CORS, the bundle's session and CSRF middleware, the metrics and the error envelope stay as on any route |
| Async/await | Controller actions can be `async`; rejections routed to `throwError` automatically |
| WebSockets | WS routes in `routing.json` (`"method": "ws"` + channel handlers, `:param` paths); WebSocket-over-HTTP/2 (RFC 8441) |
| ORM / entities | EventEmitter-based entity system; SQL files auto-wired to entity methods |
| Connectors | Couchbase, MongoDB, ScyllaDB / Cassandra, MySQL, PostgreSQL, Redis, SQLite, AI (LLM) — loaded from project `node_modules` |
| AI connector | Any LLM provider via named protocol (`anthropic://`, `openai://`, `ollama://`, …) — unified `.infer()`, token streaming via `.stream()`, inference-as-a-job via `self.inferAsync()` |
| Template engine | [`@rhinostone/swig`](https://github.com/gina-io/swig) — maintained fork with CVE-2023-25345 patched; streaming SSE/chunked via `renderStream()`. Nunjucks supported as opt-in via `render.engine = "nunjucks"` or per-section `"ext": ".njk"` |
| Forms & validation | One rule engine for client and server — live checks, cross-field rules, ARIA states, localised messages; the server enforces the same rules on submit. A form can swap its HTML answer into any element of the page, htmx-style (`data-gina-form-target` / `-swap` / `-select`), and update elements elsewhere out of band (`data-gina-swap-oob`); the server can retarget, reswap or reselect that answer with `X-Gina-Retarget` / `-Reswap` / `-Reselect` response headers. Two answers replacing the same region coordinate on their own — derived from the swap strategy, with no attribute to write — and `data-gina-form-sync` overrides that where it is wrong, while `data-gina-form-disabled-elt` holds controls disabled for the life of a request |
| DTOs | `gina.dto` schema builder — request validation with localised 422s (`param.dto`), response shaping (`param.responseDto`), JSON Schema export |
| Sessions | Hardened session plugin (SameSite / HttpOnly / Secure defaults) — Redis, SQLite, MongoDB, Couchbase, and ScyllaDB stores; session-id rotation on login, per-bundle login and remember-me cookie lifetimes from `security.json`, opt-in absolute timeout, record destroyed on logout |
| File uploads | Multipart via the maintained [`@rhinostone/busboy`](https://github.com/gina-io/busboy) fork — named upload groups with per-group extension allow-lists, size / count limits, and target dirs |
| Object storage | `gina.storage()` — named drivers pairing an adapter (`local` filesystem, or `s3` for any S3-compatible provider with its SDK as a project-side dependency) with a key strategy behind opaque keys: `sharded` (dated), `cas` (content-addressed, deduplicating, refcounted, GC-swept) and `stream` (large media, resumable out-of-order segment uploads); size tiering, HTTP Range serving (`serveFromStorage()` — 206/416/304, strong key ETags), presigned-URL offload (307) on `s3`, embedded SQLite or Couchbase metadata store, `storage:stats` / `gc` / `verify` CLI |
| Async jobs | `self.startJob()` background jobs — durable SQLite / MongoDB / Redis stores, retries with backoff, HMAC-signed completion webhooks, `/_gina/jobs/:id` status endpoint |
| Response caching | Per-route render cache — memory / fs / Redis tiers, cross-replica warm start, event-driven invalidation, RFC 9211 `Cache-Status` |
| Authentication | `lib.authn` primitives — scrypt password hashing as self-describing PHC strings (argon2 / bcrypt verify-only for migration), NIST SP 800-63B policy, enumeration-safe `dummyVerify`, PCI-DSS account lockout, RFC 6238 TOTP |
| Route authorization | `requireAuth` / `roles` / `policy` per route or deny-by-default, login bounce with `resumeRequest()`, `self.hasRole()` |
| Rate limiting | Opt-in identified-caller quotas at the router (#MS6) — fixed-window counters over the KV primitive (per-process, or replica-shared via redis/sqlite), per-route overrides/exemptions, 429 + `Retry-After` + draft `RateLimit` header fields; anonymous flood control stays at your edge by design |
| Maintenance mode | Opt-in `server.maintenance` (#MAINT1) — every request answered 503 + `Retry-After` before statics, cache and routing while `/_gina/*` stays reachable; topology-neutral bypass (`x-gina-maintenance-key` header, or a one-shot query grant minted into a signed cookie) plus a non-proxied IP allowlist; runtime toggle `POST /_gina/maintenance` with a dead-man `ttlSeconds`, `GINA_MAINTENANCE` to boot closed, and replica coherence through a shared KV namespace (`store`) |
| Audit trail | Opt-in append-only JSONL audit log (`self.audit()`), authorization denials auto-recorded, always-on request ids; opt-in HMAC hash chain verified offline by `gina audit:verify` |
| CSRF protection | Signed double-submit token middleware + Origin/Referer pre-filter + hardened session cookie |
| Security headers | CSP with per-response nonces, HSTS, COOP / COEP / CORP, Referrer-Policy and the X-* family — per-header plugins or one `SecurityHeaders` wrapper |
| Secrets | `${secret:KEY}` placeholders in bundle config — fail-closed, env-backed, with opt-in file and exec-bridge tiers beneath the environment; `secrets:scan` / `secrets:check` CLI |
| Internationalisation | Per-bundle JSON catalogs, `t()` helper, swig + nunjucks `t` filter, CLDR plurals, ICU MessageFormat opt-in via `t.icu()` |
| Exact money | `lib.money` / `gina.money` — ISO 4217 minor-unit integer arithmetic (BigInt-safe), strict wire-string parsing, same-currency guards; display via `Intl.NumberFormat` |
| Idempotency keys | Opt-in `Idempotency-Key` dedup at the router band (IETF draft): retried mutations replay the recorded first response — 409 while in flight, 422 on payload reuse, principal-scoped over the kv primitive |
| Message validation | `param.messageValidator` — a route-level seam running the raw request body through an application-supplied validator (XSD sidecar, JSON Schema, anything) before the action: boot-compiled factory, sync or async, fail-closed 400/422/503 refusals with `Retry-After` on checker outage |
| XML in and out | `application/xml`, `text/xml` and `application/*+xml` request bodies reach the action verbatim on `req.body`; `self.renderXML()` sends pre-serialised responses with the right content type and charset. The application brings its own XML library — the framework parses none and builds none |
| Observability | Built-in `/_gina/metrics` Prometheus endpoint (opt-in, IP-allowlisted) — process metrics + HTTP counter / duration histogram with cardinality-safe route labels; structured JSON logs with request ids (`GINA_LOG_FORMAT=json`) |
| Dev Inspector | Embedded dev SPA at `/_gina/inspector` — request data, live logs, SQL with index-coverage badges, flow timings, app events, AI token stream |
| OpenAPI & MCP | `bundle:openapi` emits OpenAPI 3.1 from `routing.json`; `bundle:mcp` emits an MCP tool manifest; built-in MCP runtime server (stdio + Streamable HTTP) |
| TypeScript & ESM | Typed public surface (shipped `.d.ts`), `bundle:types` generates entity types from DTOs, dual CJS / ESM exports |
| Hot reload | WatcherService evicts `require.cache` only on file change — zero per-request overhead in dev |
| K8s ready | `gina-container`, `gina-init`, SIGTERM drain, JSON stdout logging |
| Container tooling | `image:build` synthesizes an OCI image (buildah), `image:run` / `container:ps` / `container:stop` (podman) — local or over SSH |
| Dependency injection | Mockable connectors and config for unit testing |
| Runtime | Node.js 22–26, or **Bun** (`bun add -g gina`) — install + boot validated end-to-end by a CI Bun smoke, and the unit suite runs under `bun test` in CI behind an expected-failures gate |

## Quick start

```bash
npm install -g gina@latest --prefix=~/.npm-global   # or, on the Bun runtime: bun add -g gina
gina project:add @myproject --path=$(pwd)/myproject
gina bundle:add api @myproject
gina start
gina bundle:start api @myproject
open http://localhost:3100
```

> **npm 12+** blocks install scripts by default, and gina's post-install bootstraps `~/.gina` and the framework dependencies. Install with `npm install -g gina@latest --allow-scripts=gina`, or allow it once for all global installs with `npm config set allow-scripts=gina --location=user`. (Not needed on npm ≤ 11.)

## What's in 0.7.11

> **Restart your bundles *and* rebuild them.** Popins, staged file inputs, the
> client's start-up in a frame and `lib.routing.getRoute()` ship in the browser
> bundle, so `gina.min.js` changed and `gina bundle:restart` alone leaves the
> old client running: rebuild each consuming bundle, then restart it. If your
> build copies `gina.min.js` into your own static files, rebuild that copy
> before the restart.

> **Read before upgrading — some changes can change an answer.** gina locks
> swig 2.12.4: a template's read of `count` or `functionCount` reads only an
> object's own key, `{{ _ext.name }}` renders an empty string, and a context
> key named like a JavaScript global that holds null or undefined hides that
> global. A staged file input refuses, before any request, a file its `accept`
> excludes or one larger than its new `data-gina-form-upload-max-size`, so an
> input whose `accept` names fewer types than its upload group allows now
> refuses the others; an input with no staging action refuses every file. A
> gina page in a same-origin frame starts its own client: code there that read
> the parent's values through its own `gina` now reads its own. A redirect's
> `param.code` sets the status only when it is 301, 302, 303, 307 or 308 (else
> 301); a redirect route's `param.route` resolves as `self.redirect()` does;
> under a non-root webroot a redirect route's `param.path` gets the webroot,
> and every other reader gets `param.path` as written. On a `culturePrefix`
> route, `req.culture` takes the URL value. Outside development a required
> controller's module-level code runs once per process. Pages that a route's
> `fs` or `redis` output cache stored before the upgrade are not served after
> it, unless `GINA_CACHE_NAMESPACE` keeps its value across the upgrade: then
> run `gina cache:clear`. The
> [migration notes](https://gina.io/docs/migration) list every behaviour change.

**A security release.** Outside development, `self.requireController()` no
longer keeps a copy of the required controller on every call, which let
repeated requests exhaust the process's memory. Concurrent renders of swig
pages that share a layout no longer serve one another's request values, and
with the render cache on, the first render no longer fixes the hostname,
webroot and culture of every later visitor. On the isaac engine, an
`X-Forwarded-Prefix` that opens with two slashes is refused. The release also
adds an opt-in stall watchdog, an opt-in load limit for popins and a boot
warning for a route that binds a URL placeholder under a key gina reads as
configuration. The other fixes cover staged file inputs, a gina page in a
same-origin frame, popin options, redirects, `downloadFromURL()`, download
names with accented letters, `req.culture`, `lib.routing.getRoute()`, a route
with no `param` block and `requireController()` without `options`. Full detail
in [CHANGELOG.md](./CHANGELOG.md).

- **Security — `requireController()` outside development (#B1126).** Each call evicted the super controller and the required controller from the require cache and required them again, and every copy stayed referenced for the life of the process: memory grew by about the required controller's source size per call, so a route reachable without authentication let a client exhaust the process's memory by repeating requests. Outside development both modules now load once per process; in development they are still required again on every call, and the old copies are released.
- **Security — layouts and per-request values (#B1129, #B1131, gh#104).** With the render cache off, the default, concurrent renders of swig pages sharing a layout wrote each request's values (the public hostname and webroot, the culture, the validation labels, the proxy host) into one shared layout file, so a page could carry another request's values or arrive without gina's client loader, and on a bind-mounted templates directory the file could be found absent (a 500). Each render now assembles its layout in memory. With the render cache on, the first render after the layout file was created fixed its hostname, webroot and culture for every later render of every view sharing the layout, until the file was removed; swig now renders these values from each request's data. They come from request headers (`X-Forwarded-Host`, `X-Forwarded-Prefix`, `Accept-Language`, the culture cookie), so one client's headers could reach other clients' pages.
- **Security — an `X-Forwarded-Prefix` that opens with two slashes (#B1129).** On the isaac engine such a value passed the path-character check, but the public webroot composed from it was a protocol-relative URL: the browser fetched the client routing table, and the gina stylesheet when it was not already linked, from the host it names. It is now refused like a malformed value, and the page keeps the bundle's own webroot.
- **Added — a stall watchdog (`server.stallWatchdog`).** With `{ "enabled": true }`, a worker thread watches the bundle's main thread and, when its heartbeat has not moved for `threshold` (default `"5s"`), writes one crit line itself while the main thread is still blocked: the blocked thread's call frames (on Node) and the application requests in flight, by the `X-Request-Id` their answers echo, to stdout and to the log relay `gina tail` reads. When the main thread resumes, a warn line gives the whole silence, and with metrics enabled `gina_main_thread_stalls_total` and `gina_main_thread_stall_seconds` count it. Off by default; works on Node and Bun.
- **Added — a load limit for popins (#B1108).** `loadTimeout`, in milliseconds, per popin (`new Popin({ name, loadTimeout: 15000 })`) or for every popin without its own value (`gina.setOptions({ popin: { loadTimeout: 15000 } })`): a load still unanswered at the limit is aborted and fails like any failed load (`error` fires with `{ status: 408, error: 'Request Timeout' }`), then the loading shell closes unless a listener loaded content, and the trigger is released. There is no limit unless one is set.
- **Added — a boot warning for configuration keys bound to URL placeholders (#B1124).** A bundle warns once at boot about each route whose `param` block binds a URL placeholder under a key gina reads as configuration, such as `"section": ":section"` or `"code": ":code"`: gina reads the placeholder text as that key's value. Bind the segment under another name (`"url": "/item/:itemCode"` with `"itemCode": ":itemCode"`); nothing is rewritten.
- **Changed — staged file inputs check `accept` and size before any request.** A chosen or dropped file of a type the input's `accept` excludes, or larger than its new `data-gina-form-upload-max-size` attribute, is refused before any request is sent, with the rest of its selection; the input's error element and the form's live region say why, and its `data-gina-form-upload-on-error` callback runs with `{ refused: true, reason, files, error, transportError: false }`. The server stays the authority. An input whose `accept` names fewer types than its upload group allows now refuses the files of the other types: list them in `accept`, or remove it.
- **Changed — swig 2.12.4 (#B1138).** Both lockfiles lock `@rhinostone/swig` 2.12.4; the manifests keep `^2.12.1`, so a fresh install already resolves 2.12.4 or later. In a gina process a template's read of `count` or `functionCount` now reads only an object's own key, so `{{ r.count() }}` renders an empty string and `{% if r.count %}` is false for an object without its own `count` key (a query row's `count` column reads as before); `{{ _ext.name }}` renders an empty string; a context key named like a JavaScript global (`JSON`, `Math`, `encodeURIComponent`) that holds null or undefined hides that global. Server-side only: a bundle restart picks it up.
- **Fixed — staged file inputs (#B1094, #B1095).** An input with no `data-gina-form-upload-action`, on a page without an `upload-to-tmp-xml` route, refuses a file before any request, where the file was posted to `/null`. A rule that a `_case_` condition gives a staged input now judges the files the input holds: with one `_case_` key a required staged input refused nothing, and with two or more an edit form showing a saved file was refused.
- **Fixed — a gina page in a same-origin frame (#B1130, gh#103).** It now starts its own client. The parent's instance was merged into the frame's at start-up and its values won, so the frame's configuration, session and forms were never applied, its popin, validator and navigation never started, and `new Popin()` in the frame threw. The client no longer reads its parent frame at all; read `parent.gina` where the two pages share an origin.
- **Fixed — popin options (#B1109).** Popins loaded with `gina.popin.load(name, url)` and no options, or with one options object passed to several loads, no longer share one options object: the second took the first one's `preOpen`, `loadingShell` and class, and the object passed gained the popin's options.
- **Fixed — redirects (#B1122, #B1125, #B1134, #B1137).** A route that binds a URL segment as `code` no longer breaks every redirect that reads it. `self.redirect('<route>')` without `@bundle` redirects to that route of the current bundle, where it answered 500 or 404, and route names are lowercased. A redirect route's `param.route` resolves as `self.redirect()` does, a target in another bundle included. Under a non-root webroot, a redirect route's `param.path` gets the webroot, where the path lost its first character.
- **Fixed — `downloadFromURL()` (#B1111, #B1112, #B1114, #B1118, #B1119, #B1120, #B1121).** A bad `options`, `options.file` or url now answers a 500 through `throwError()`, where the request got no response, and only the `http` and `https` schemes are accepted. The method no longer writes into the options object it is given. An `https` url that names no port goes to port 443; a url aimed at a proxied bundle's host on another port goes to that bundle's port; the host and the port are read from the url's authority only.
- **Fixed — download names with accented letters (#B1113, #B1115).** `self.downloadFromLocal()`, `self.downloadFromURL()` and `self.serveFromStorage()`, its `s3` offload path included, send a name such as `résumé.pdf` with an RFC 8187 `filename*=UTF-8''…` parameter after an all-ASCII `filename` fallback, so Chromium and WebKit save it as written; AWS S3 no longer refuses a name with a character above U+00FF.
- **Fixed — routing (#B1123, #B1133, #B1135).** On a `culturePrefix` route, `req.culture` takes the URL value of the segment bound to `param.culture`. A route with no `param` block stops the boot with an error that names it. `lib.routing.getRoute()` looks for a fixed `param` value as written, where it read it as a regular expression (a value such as `"C++"` threw a `SyntaxError`).
- **Fixed — `requireController()` without `options` (#B1031).** It now builds the controller with the options of the request being served, where it threw a `TypeError`, and it works in a route middleware and in a bundle's `controllers/setup.js`.
## Documentation

Full installation guide, tutorials, configuration reference, and API docs at **[gina.io/docs](https://gina.io/docs/)**.

- [Getting started](https://gina.io/docs/getting-started/)
- [Guides](https://gina.io/docs/guides/)
- [CLI reference](https://gina.io/docs/cli/)
- [Configuration reference](https://gina.io/docs/reference/)
- [Security & CVE compliance](https://gina.io/docs/security)

## Ecosystem

| Package | Description |
| --- | --- |
| [@rhinostone/swig](https://github.com/gina-io/swig) | Maintained fork of the Swig template engine (upstream abandoned since 2015). CVE-2023-25345 patched. |
| [gina-starter](https://github.com/gina-io/gina-starter) | Minimal starter project — one bundle, one route, a dev container |

## Governance

Gina is co-authored by **Martin Luther ETOUMAN NDAMBWE** ([Rhinostone](https://rhinostone.com)) and **Fabrice DELANEAU** ([fdelaneau.com](https://fdelaneau.com)). Final decisions on direction, API design, and releases rest with Martin Luther. Community contributions and RFCs are welcome and taken seriously. See [GOVERNANCE.md](./GOVERNANCE.md) for details.

## Supply-chain scanners

Gina is an MVC framework with a process-management CLI, so it uses Node's
`child_process` by design — to start and supervise application bundle processes
and the framework daemon, run local/SSH commands (`lib/shell`), launch the
inspector, and perform setup in the npm install scripts. Supply-chain scanners
therefore report a **Shell access** capability for `child_process`. This is
expected and intrinsic to a CLI framework, not a vulnerability: the install-time
commands are built only from local values (npm prefix, install path) and take no
network input.

## License (MIT)

Copyright © 2009-2026 [Rhinostone](https://rhinostone.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished
to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
