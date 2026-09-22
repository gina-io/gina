# Gina

[![npm version](https://img.shields.io/npm/v/gina)](https://www.npmjs.com/package/gina) [![npm downloads](https://img.shields.io/npm/dm/gina)](https://www.npmjs.com/package/gina) [![GitHub stars](https://img.shields.io/github/stars/gina-io/gina)](https://github.com/gina-io/gina/stargazers) [![Tests](https://github.com/gina-io/gina/actions/workflows/test.yml/badge.svg)](https://github.com/gina-io/gina/actions/workflows/test.yml) [![Socket](https://img.shields.io/badge/Socket-view%20analysis-blue)](https://socket.dev/npm/package/gina) [![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D%2022-brightgreen)](https://nodejs.org) [![Bun >= 1.2](https://img.shields.io/badge/Bun-%3E%3D%201.2-brightgreen)](https://bun.sh) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Documentation:** [gina.io/docs](https://gina.io/docs/) · **Issues:** [GitHub](https://github.com/gina-io/gina/issues) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

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
| MVC routing | `routing.json` — declare routes in config, not code; O(m) radix trie lookup |
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
gina bundle:start api @myproject
open https://localhost:3100
```

> **npm 12+** blocks install scripts by default, and gina's post-install bootstraps `~/.gina` and the framework dependencies. Install with `npm install -g gina@latest --allow-scripts=gina`, or allow it once for all global installs with `npm config set allow-scripts=gina --location=user`. (Not needed on npm ≤ 11.)

## What's in 0.6.32

> **Restart your bundles *and* rebuild them.** Seventeen of this release's
> commits are browser-bundled — the whole form-answer arc, the popin fixes and
> the validator changes — so `gina.min.js` changed and `gina bundle:restart`
> alone leaves the old client running. Rebuild each consuming bundle, then
> restart.

> **No settings reset.** `0.6.32` is a patch — the `shortVersion` stays `0.6`,
> so your `~/.gina/0.6/settings.json` is untouched. (`0.6.0` was the reset.)

**The form-answer release.** A form's HTML answer can now land anywhere in the
page — htmx-style `data-gina-form-target` / `-swap` / `-select`, out-of-band
elements, three server-side override headers — and two forms answering into one
region no longer race. Where a popin is involved, the answer is routed by the
popin the form is *inside*, never by whichever popin happens to be open, which
closes the routing defect behind
[gh#76](https://github.com/gina-io/gina/issues/76) and a run of popin edge cases
with it. Four security fixes lead the rest: credentials no longer ride a
redirect, the built-in error pages escape what they render, a request parameter
can no longer force an error or hang a request, and an HTTP/2 static no longer
carries another request's headers. Alongside: the HTTP/2 render path now runs a
session middleware's hooks, maintenance mode can be armed from the environment
and kept coherent across replicas, an environment config overlay wins over its
base file, and per-bundle login session lifetimes are read from `security.json`.
Full detail in [CHANGELOG.md](./CHANGELOG.md).

- **Security — credentials no longer ride a redirect (#B551).** `self.redirect()` carried the request's parameters to the target — the parsed body verbatim for a `POST`, so a login form's plaintext password was written to the session store, or placed in the redirect URL on a session-less bundle. Fields matching the framework's redaction list (`password`, `secret`, `token`, `apikey`, `authorization`, `credentials` and their case and separator variants) are now dropped from what is carried; everything else travels exactly as before.
- **Security — the built-in error pages escape every value they render (#B554).** A crafted link to any route whose action redirects — `?error=<script>…` — made the fallback error page reflect the value as markup and execute it in your application's origin, on every released version; a newly scaffolded bundle, which configures no `errorFiles`, hit exactly that page. The engine-level error page and the three nunjucks fallbacks are escaped the same way.
- **Security — a request parameter can no longer decide whether a redirect happens (#B559).** A key named `error` in the query string or body was read as an instruction to raise an error, so any unauthenticated request to any redirecting route could force a 500 — and an empty value left the request unanswered for as long as the client held the connection. The key is now an ordinary parameter and rides the redirect in `inheritedData`.
- **Security — an HTTP/2 static file no longer carries another request's response headers (#B566).** The first static request after boot registered a byte-serving listener that kept its response object for the life of the process and folded that response's headers — its `Set-Cookie` included — onto every later client's stream, served unseen HTML as raw binary, and answered a directory's index URL with a destroyed stream for the rest of the process's life. The listener and its server-push branch are removed; every HTTP/2 static is served on the request's own response, with the `ETag` / `304` support that path never emitted.
- **Added — a form can swap its HTML answer into any element of the page (gh#76).** Three attributes on the `<form>`: `data-gina-form-target` (the `hx-target` grammar), `data-gina-form-swap` (nine strategies, `innerHTML` by default) and `data-gina-form-select`; a target or strategy that cannot be honoured refuses the submit before anything is sent, and `beforeswap` / `afterswap` bracket the main swap. A declared target wins over the popin the form is in.
- **Added — an answer can update elements anywhere in the page, out of band (gh#76).** Any element of the answer carrying `data-gina-swap-oob` is swapped into the page element with the same `id` (htmx's `hx-swap-oob`), on all three answer paths; the success payload gains `oob` and `remainder`, and an answer without the attribute takes exactly the path it did before.
- **Added — a server can retarget, reswap or reselect a form's HTML answer (gh#76).** `X-Gina-Retarget`, `X-Gina-Reswap` and `X-Gina-Reselect` override the form's declared attributes at settle, and are honoured only from a response whose origin is the page's own; a Retarget that cannot be resolved means no swap at all, reported to the success callback with `swapped: false`, never an error.
- **Added — `GINA_MAINTENANCE` boots a bundle with maintenance mode on.** `GINA_MAINTENANCE=1` closes the gate at boot exactly as `server.maintenance.enabled: true` would — for replacement pods created during a window — and can only close a bundle, never open one; `GET /_gina/maintenance` reports `source: "env"` for such a closure.
- **Added — maintenance mode stays coherent across replicas through a shared kv namespace.** Point `server.maintenance.store` at a declared kv namespace and every `POST /_gina/maintenance` is written there and polled by each process (`pollInterval`, default 2000 ms); a store outage freezes each replica in its last-known state and never reopens a closed site.
- **Added — the maintenance status payload carries `pid` and `hostname`.** The runtime override was always per process; the two fields let an operator fanning a `POST` out over replicas read back which ones applied it, and that per-process contract is now stated on the guide, the schema and `llms.txt`.
- **Added — per-bundle login session lifetimes from `security.json`.** `session.expires` and `session.remember` — unit-suffixed duration strings — set the cookie lifetime `req.login()` applies for an ordinary and a remembered login. Both keys were documented but interpreted by nothing until now, so a value already there that is not a duration string is reported at boot and ignored, never fatal.
- **Added — `lib.duration.parse()`, one parser for unit-suffixed durations.** The parser `lib/storage` already used for its interval keys, promoted to a registry entry so every configuration key naming a span of time shares one dialect (`"500ms"`, `"30s"`, `"15m"`, `"3h"`, `"15d"`; the unit is required and a bare number is refused).
- **Added — a `commit-msg` git hook for contributor clones.** It keeps local-tool configuration paths and attribution mentions out of commit messages — the one surface no hook had scanned — and reaches a clone through the `core.hooksPath` that `post_install` already installs. Not part of the published package.
- **Changed — the popin context a request carries is decided by containment, not by "the active popin" (gh#76).** The `X-Gina-Popin-Id` / `-Name` headers, `self.isPopinContext()` and a popin-style XHR redirect are produced only for a form rendered inside a popin; a page form's `location` redirect navigates the page; `getActivePopin()` returns open popins only, the most recently opened first; a name-less `popin: { close: true }` with nothing open is a no-op.
- **Changed — two form answers replacing the same region no longer race (gh#76).** When a form's swap replaces its target, a newer submit into the same target supersedes the request still in flight (a new `abort` event with `reason: 'superseded'`, never the `error` channel); insertion swaps still both land. `data-gina-form-sync` (`replace`, `drop`, `queue`) overrides the derived decision and `data-gina-form-disabled-elt` holds elements disabled for the life of a request. Superseding cancels the client's wait, not the server's work — never read it as "not saved" and resubmit.
- **Changed — a navigated fragment's forms are bound only when they opt in (gh#76).** Fragment navigation binds the swapped region through the shared `bindRegion()` policy, so a bare id-bearing form inside a navigated fragment keeps its native submit unless it carries a `data-gina-form-*` attribute or an id naming a rule.
- **Fixed — a form's HTML answer is routed by the popin the submitting form is in (gh#76).** A page form's answer arriving while a popin was open replaced that popin's content; arriving while a popin was still loading it raised a false `422` after a successful server write; with two popins open it landed in whichever had been registered first. Containment at submit decides now, and `popinLoadContent` loads into the popin it is called on.
- **Fixed — a form or link answering into a popin runs its declared success callback (#B571).** The popin branch returned after the bare `success.<id>` event, so `data-gina-form-event-on-submit-success` and `data-gina-link-event-on-success` never ran there.
- **Fixed — a pre-opened popin's loading shell is a state you can close, load into, or lose to a failed load (gh#76).** `isLoading` covers the round trip between the shell showing and the content landing: `loadContent()` no longer throws, `close()` and `destroy()` cancel the load and tear the shell down, an Escape during the load takes that same path instead of a dialog that reopens when its content arrives, and a failed load closes the shell unless an `error` listener loaded content into it.
- **Fixed — a pre-opened popin opened modeless reaches its open state (#B574).** `popinOpen` guarded its open call with `getAttribute('open')`, which reads the shell's empty-string attribute as absent, so `show()` threw `InvalidStateError` and the popin stayed visibly open while the framework recorded it closed.
- **Fixed — a popin answer outside dev mode no longer reports a false 422 (#B575).** The two hidden inputs the popin branch parsed are spliced only when `NODE_ENV_IS_DEV` is true; both branches now go through one tolerant parse.
- **Fixed — an HTML answer whose top-level elements are table rows or cells keeps them (#B578).** The answer is parsed as a fragment rather than a whole document, so a top-level `<tr>` or `<td>` survives and a swap into a `<tbody>` writes the row, not the cell text.
- **Fixed — reloading an open popin no longer blanks it (#B579).** The declarative trigger's `loaded` listener applied the event detail — the popin object — as if it were the body, wiping the content just written; present since `0.4.6`.
- **Fixed — a malformed `data-gina-dialog-target` falls back instead of throwing (#B580).** A selector such as `#slot >` takes the documented full-replace fallback rather than an uncaught `SyntaxError`, and both silent fallbacks are now announced in dev mode.
- **Fixed — a page form's staged upload is placed with its own form (#B572).** Which popin a chosen file belongs to is decided by containment, captured once at selection, never by "some popin is open" — before, a file chosen while an unrelated popin was open had its virtual upload form appended inside that popin and the form then saved without the file.
- **Fixed — the client validator binds only the forms a page opted in (#B549).** Declaring a single rule file used to make every form on every page an always-XHR submit, plain login and signup forms included. Behaviour change: an implicitly bound form now submits natively unless it carries a `data-gina-form-*` attribute or matches a rule.
- **Fixed — a date field no longer submits the previous day east of UTC (#B558).** `isDate` wrote a `Date` object into the payload, which `JSON.stringify` renders as a UTC instant — the previous day in any positive offset. The payload now takes a plain `yyyy-mm-dd` string, matching the schema the framework already published; breaking for anything that read `req.body.<field>` as a `Date`.
- **Fixed — an XHR redirect over HTTP/2 delivers the session cookie it rotated (#B550).** `redirect()`'s XHR and popin exits answered on the raw HTTP/2 stream, so a session middleware's `on-headers` cookie and save-on-end never fired and a user signed in immediately before the redirect arrived unauthenticated. Both exits terminate through the compat response, and the router's `inheritedData` consume persists itself.
- **Fixed — a session survives an ordinary HTTP/2 render (#B562).** A transparent base `writeHead` / `write` / `end` is installed before the middleware chain and the six buffering render delegates hand their send to it, so a `rolling` cookie rolls and a mutation made while rendering is persisted; statics stay on the raw stream deliberately and `renderStream()` is unchanged.
- **Fixed — an HTML file in `public/` no longer answers 500 on a bundle without templates (#B567).** The dev-mode loader injection read a `content.templates._common` block that an API-only bundle never has.
- **Fixed — an environment config overlay now overrides its base file.** A `<name>.<env>.json` overlay was folded in before its base and lost to it on every shared key — the opposite of what the reference pages described. It now wins; an overlay array replaces the base array and a `null` overrides. Read your overlays before upgrading.
- **Fixed — two connectors in one bundle no longer fight over an entity class name (#B555).** The process-wide entity table was keyed on the bare class name, so the connector whose connection became ready second was handed the first one's instance. It is keyed per bundle, model and class now, and a bundle whose declared entity did not reach its model refuses to start instead of serving a half-built model layer.
- **Fixed — a JSON config with a docblock and an unterminated `/*` in a string value no longer hangs the boot (#B568).** `requireJSON`'s block-comment strip backtracked about twice per line after a glob or certificate path such as `"…/ssl/*.example.pem"`, hanging the boot until the start-wait killed it with nothing logged; the strip is now a linear, string-aware scan.
- **Fixed — `self.throwError()` answers the request when called with a falsy value (#B560).** The late-call guard tested the one-argument form's payload for truthiness, so `self.throwError(err)` with `''`, `null`, `undefined`, `0` or `false` was mistaken for a call on a released response and the request was never answered; it now renders a 500 like any other.
- **Fixed — the storage metadata store no longer runs an application callback inside its own try/catch (#B565).** Seven methods swallowed an error thrown by the callback and then invoked it a second time with the application error presented as a store error, so a first-settle latch such as the content-addressed driver's `verify()` hung; callbacks now run after the try on every path.


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
| [gina-starter](https://github.com/gina-io/gina-starter) | Minimal starter project — one bundle, one route, Docker Compose included |

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
