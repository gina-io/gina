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

## What's in 0.7.6

> **Restart your bundles *and* rebuild them.** The form validator's staged
> uploads, the popin and the routing library are browser-bundled, so
> `gina.min.js` changed and `gina bundle:restart` alone leaves the old client
> running: rebuild each consuming bundle, then restart it. If your build copies
> `gina.min.js` into your own static files, rebuild that copy before the restart.

> **Read before upgrading — some changes can change an answer.** A URL
> placeholder's value now wins over a query-string or body key of the same name
> on every request, in `req.get`, `req.post` and the other method objects as in
> `req.params`; the client's value stays readable in `req.originalUrl`,
> `req.query` or `req.rawBody`. An HTTP/2 `self.query()` that reaches its
> `requestTimeout` fails with `TIMEOUT` and is not sent again. `self.render()`,
> `self.renderWithoutLayout()`, `self.renderJSON()` and `self.throwError()` no
> longer write into the object an action passes them: an action that read gina's
> additions back from its own object (`page.data.session`, `gina.csrfToken`, an
> incident `ref`, the Inspector sidecars) reads them elsewhere, and a change it
> makes to the object after calling the render may no longer reach the template.
> Swig 2.9.6 renders on a copy of the data it is given: a template's `{% set %}`
> no longer lands in that object, a top-level property that is not enumerable is
> no longer visible, and the output before an `{% import %}` is now kept. A
> top-level JSON array body is the array on every request, a path's first
> included, and pages rendered with an async swig loader or with nunjucks now
> carry the request's session. The [migration notes](https://gina.io/docs/migration)
> list every behaviour change.

**The render-isolation release.** Three security fixes keep request data out of
the objects an action passes to gina: `self.render()` and
`self.renderWithoutLayout()` no longer write a request's session id, CSRF token
and URL into them, `self.renderJSON()` no longer writes its Inspector sidecars
into them, and Gina requires `@rhinostone/swig` `^2.9.6`, which renders on a copy
of the data it is given (GHSA-25w8-77gg-4ccw), bounds async renders
(GHSA-86pr-x856-xrq5), keeps a cached layout unchanged (GHSA-g628-5x3r-g298),
runs `striptags` in linear time (GHSA-rvx7-jqr9-c242) and caps swig-core ranges
(GHSA-f8f4-95q3-38qw). Three changes, one addition and fifteen fixes follow: staged
uploads in the form validator, the popin, HTTP/2 `self.query()` retries, `DELETE`
routes, JSON array bodies, `self.throwError()`, the session block on every
renderer, swig's `{% import %}`, and the filters a route middleware's template
sees. Full detail in [CHANGELOG.md](./CHANGELOG.md).

- **Security — a render no longer writes into the object an action passes (#B988, #B992).** `self.render()` and `self.renderWithoutLayout()` combine a copy of the object, so a module-level or `require()`d object no longer carries the first request's session id, CSRF token and URL into later pages; `self.renderJSON()` writes its Inspector sidecars (`__ginaQueries`, `__ginaFlow`) into a copy, so a cached response object no longer sends one request's query log to later clients. A class instance passed as the object is not copied.
- **Security — swig `^2.9.6` (#B963, #B973, #B983, #B997).** Swig renders on a copy of the locals a caller passes (GHSA-25w8-77gg-4ccw), fails a render on the async loader path once more than 1,000 templates are nested instead of exhausting the heap (GHSA-86pr-x856-xrq5), keeps a page's block override out of a cached layout (GHSA-g628-5x3r-g298), runs `striptags` in linear time (GHSA-rvx7-jqr9-c242) and returns an empty swig-core range above 1,000,000 elements (GHSA-f8f4-95q3-38qw). A project copy loaded through `swig.useProject`, or a frontend selected through `swig.package`, keeps its own version, so update it there.
- **Changed — a URL placeholder's value wins (#B954, #B957), an HTTP/2 timeout is final (#B967, #B970, #B628), and the staged-upload sweep waits an hour longer (#B472).** On a route `/items/:grp/:id`, `?id=99` or `{ "id": "99" }` no longer replaces the URL value in `req.get`, `req.post` and the other method objects; a `self.query()` to an HTTP/2 upstream that reaches its `requestTimeout` fails with `TIMEOUT` and is not resent, and on a connected session only that request is cancelled; the boot-time sweep removes a staged upload part once it is older than the timeout plus one hour.
- **Added — `page.environment.packageVersion` (#TPL3).** Templates read the project's own `package.json` version, read once per process; it is not set when the project has no `package.json` or no `version` in it.
- **Fixed — staged uploads in the form validator (#B150, #B959, #B960, #B961, #B962, #B292).** A saved file's delete link goes away when a new selection replaces it; reset and delete links keep working after an emptied selection, after a failed staging and while a file uploads; a new file's own `name` is submitted; the trigger warning names only a control the page must provide.
- **Fixed — the popin (#B974, #B975, #B977).** A popin closes after a link inside it loaded a page, and a click on an element inside a link with a `target` opens that window.
- **Fixed — HTTP/2 `self.query()` retries (#B981, #B968, #B982, #B628).** A retry after a 502, a stream error or a stream that ended early leaves the other calls on its session alone, and a call that was never sent is sent again on a new session.
- **Fixed — routing and request data (#B955, #B956, #B953, #B965).** A `DELETE` route whose regex `requirements` cover its placeholders sets `req.params`, one whose requirements cover only some of them matches, and a top-level JSON array body is the array on every request, a path's first included.
- **Fixed — rendering (#B672, #B989, #B978, #TPL3).** `self.throwError()` no longer writes into the error object an action passes; pages rendered with an async swig loader or with nunjucks carry the request's session in `page.data.session` and in the client bootstrap; swig keeps the output before an `{% import %}`, and async-loader templates render includes inside loops; a template a route middleware renders sees the filters `controllers/setup.js` registers.

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
