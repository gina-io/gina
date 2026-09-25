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

## What's in 0.6.33

> **Restart your bundles *and* rebuild them.** Eight of this release's commits
> are browser-bundled — the request-parsing security fixes, the validator's
> referenced-value and token fixes, the in-memory Collection and the routing
> fix — so `gina.min.js` changed and `gina bundle:restart` alone leaves the old
> client running. Rebuild each consuming bundle, then restart.

> **No settings reset.** `0.6.33` is a patch — the `shortVersion` stays `0.6`,
> so your `~/.gina/0.6/settings.json` is untouched. (`0.6.0` was the reset.)

> **Read before upgrading — some changes can stop a bundle or change an
> answer.** A malformed `${secret:…}` reference now refuses the bundle (run
> `gina secrets:check` first); a throw from `onInitialize` and a model that fails
> to load on an asynchronous connector now abort the boot; a Couchbase `$scope`
> outside `^[A-Za-z0-9_./-]+$` refuses the boot; `http2Options.maxStreamsPerSecond`
> is no longer read (rename it `maxStreamResetsPerSecond`); `useRestApi` on a
> Couchbase connector is ignored; `scope:add` and `env:add` refuse names they
> used to drop silently; and on an `http/2.0` bundle an HTTP/1.1 client using a
> method a route does not declare now gets 404 (405 on a multi-method route).
> The [migration notes](https://gina.io/docs/migration) list every behaviour
> change.

**The request-parsing and inter-bundle release.** Nine security fixes lead it.
One unauthenticated GET could stop a bundle process, an encoded `&` or `=` in a
form field could add or override other fields, a parse failure wrote the raw
body or query to the log, and a top-level `__proto__` field swapped the parsed
request object's prototype. On an `http/2.0` bundle an HTTP/1.1 request skipped
every route's method check, and a query key named like an inherited object
member could reach another route. The Couchbase connector no longer writes
values into statement text unvalidated and its plaintext REST transport is
retired, and `project:add` no longer runs `--scope` / `--env` through a shell.
The inter-bundle throughput arc makes `self.query()` hold up under sustained
traffic: the framework's env template is parsed once per process instead of six
times per request, the HTTP/2 rapid-reset guard counts client resets instead of
new streams, client sessions no longer reset every stream, leak or storm
pre-flight PINGs, a request refused before processing is retried for any method,
HTTP/1.1 calls reuse their connections, and `server.query.http2SessionPool`
spreads calls over several sessions. The `is` validation rule now compares
referenced values exactly as typed, with one `$field` token grammar everywhere
([gh#77](https://github.com/gina-io/gina/issues/77)). Full detail in
[CHANGELOG.md](./CHANGELOG.md).

- **Security — one GET request could stop the bundle (#B591).** A bracket-notation field name whose non-last segment is numeric while its container is not an array (`0[a]=1`) threw inside the nesting helper, and on the `inheritedData` query path nothing caught it: one unauthenticated `GET /any-url?inheritedData=0%5Ba%5D%3D1` exited the bundle process. A urlencoded body with the same name answered 500, and the validator's browser twin broke the submission. Such a segment now creates a plain object slot.
- **Security — an encoded `&` or `=` in a form field can no longer add or override other fields (#B588).** A urlencoded POST, PUT or PATCH body was percent-decoded as a whole before it was split, so `bio=hi%26role%3Dadmin` arrived as a second `role` field. The body now follows the standard form algorithm — split on `&`, then at the first `=`, each name and value decoded exactly once — which also keeps a raw `=` inside a value and a typed `100%25` as typed.
- **Security — a parse failure no longer writes the request body or query to the log (#B590).** The data helper's parse-failure lines printed the whole document at error level — a password or a token included, and in the browser console too — and the isaac query parser warned with the value. They now log the input's length, its first character and the error's name, never the value or the parse message.
- **Security — a top-level field named `__proto__`, `constructor` or `prototype` is dropped (#B592).** Assigned flat, a JSON-valued `__proto__` pair swapped the prototype of the parsed request object, so `req.post.<key>` could read an attacker-chosen value that `Object.keys` and `hasOwnProperty` could not see. The process-wide pollution was already closed by #B446; this is the per-request object.
- **Security — the Couchbase connector no longer writes caller or configuration values into statement text unvalidated (#B608).** A `$N` inside `SEARCH()` is now bound as a query parameter instead of being spliced in as an unescaped string literal; a `$N` used as a field-path segment must be a dotted identifier path or the query is refused (`GINA_COUCHBASE_INVALID_FIELD_PATH`); and the `$scope` / `_scope` value is resolved once at load and must match `^[A-Za-z0-9_./-]+$`, or the bundle refuses to boot.
- **Security — the Couchbase connector's REST query transport is retired (#B634, #B623).** `useRestApi: true` sent every N1QL query over plain HTTP with the cluster credentials in an `Authorization: Basic` header — even on a `couchbases://` entry — and rewrote quotes and inserted parameters unescaped. The option is now ignored with one warning, and those queries go through the Couchbase SDK.
- **Security — `project:add` no longer runs `--scope` / `--env` through a shell (#B640).** An unregistered name was registered through a shell command line with the value spliced in unquoted, so shell syntax in it ran as the user running `project:add` — an exposure for automation that builds those flags from data it does not control. Both values are now checked against the name rules before anything is written, and the child commands start from an argument vector.
- **Security — on an `http/2.0` bundle, an HTTP/1.1 request is held to each route's method (#B645).** Such a bundle also answers HTTP/1.1 — a client that does not negotiate HTTP/2, or a reverse proxy such as nginx's `proxy_pass` — and the router read the method from the HTTP/2 `:method` pseudo-header, which an HTTP/1.1 request does not carry, so every method passed: a GET reached a POST-only action, and the wrong action could be left in the route cache for later HTTP/2 clients. A wrong method now gets 404 (405 on a multi-method route), and an HTTP/1.1 CORS preflight is answered 204.
- **Security — a query key named like an inherited object member can no longer reach another route (#B650).** For a GET or DELETE on a route that declares `requirements`, a key such as `toString` or `valueOf` was found by a plain property read and counted as a requirement; each such key replaced a leading segment of the compared URL, so a request could reach a route whose path differs from its own — bypassing a path-based control applied outside the route, such as a reverse-proxy location rule. Only requirements a route declares itself count now. Every release since `0.1.0` was affected.
- **Added — `server.query.http2SessionPool` (#P43).** How many HTTP/2 client sessions `self.query()` keeps per upstream (1 to 50, default 1, as before). A pool of N is filled round-robin, so a per-connection load balancer — a Kubernetes Service with no HTTP-aware ingress — spreads the calls over N connections instead of pinning them all to one pod.
- **Changed — the HTTP/2 rapid-reset guard counts client resets; `maxStreamsPerSecond` becomes `maxStreamResetsPerSecond` (#B611).** The Isaac guard (CVE-2023-44487) counted new streams per session, so above 200 calls per second a sibling bundle's own multiplexed `self.query()` calls tripped it and every in-flight call failed with a 500. It now counts the streams a client cuts short. The old key is no longer read — a bundle still setting it gets one boot warning and the default — and `streamResetBurst` / `streamResetRate` pass through to the runtime's own reset limit. Not a vulnerability fix: the protection stays; it no longer fires on the framework's own traffic.
- **Changed — `scope:add` checks the whole name; the `<bundle>/<scope>` form is retired (#B626).** A name is made of letters, digits, `_`, `.` and `-`, starts with a lowercase letter, a digit, `_` or `.`, and is not `.`, `..` or the name of an inherited object member such as `constructor`; a name that fails used to be dropped without a message and is now refused. The `<bundle>/<scope>` form never limited a scope to one bundle — it registered a scope literally named `<bundle>/<scope>` — and is refused with a pointer to the `scopes` allow-list in `manifest.json`. Registered scopes are unchanged.
- **Changed — `env:add` checks the whole name; the `<bundle>/<env>` form is retired (#B639).** The same rules as `scope:add`, and `global` — which already names the overlay that applies to every environment — is refused as well. Registered environments are unchanged.
- **Fixed — a throw from `onInitialize` aborts the boot loudly (#B576).** A synchronous throw, or the rejection of an `async` callback's promise, before `'complete'` now exits 1 with the reason on stderr. It used to leave a bundle listening on nothing: `bundle:start` waited out its timeout, and a `gina-container` process could exit 0.
- **Fixed — a model that fails to load on an asynchronous connector aborts the boot (#B617).** A rejected entity file or a throwing entity constructor on DuckDB or Couchbase was logged as a rejection, retried as a connection failure, or swallowed — and a DuckDB bundle under `gina-container` exited 0. It now ends the boot with exit code 1, as a synchronous connector already did.
- **Fixed — a malformed `${secret:…}` reference refuses the bundle at config load (#B583).** A key breaking `^[A-Z_][A-Z0-9_]*$` — lowercase, dotted, empty or padded — used to pass through, so the literal placeholder reached its consumer as a credential. It is now refused like a missing key; `gina secrets:check` names every offending entry, so run it before restarting on this release.
- **Fixed — logging in with the Couchbase session store no longer fails when the pre-login session was never saved (#B577).** Rotating the session deleted an absent document and the store reported that as an error, failing `req.login()` and Passport 0.6 or later; deleting an absent session is now a success, as on every other session store gina ships.
- **Fixed — a query value holding a percent-escape no longer empties the whole query (#B589).** A GET or HEAD value holding `%0A`, `%22`, `%5C` or `%25` was decoded twice, turning the serialized query document into invalid JSON — `req.get` came back empty — and `100%2525` became `100%`. The same path serves the browser validator and every route declaring a DTO, where a JSON body value holding `%22` could leave the action with no payload.
- **Fixed — two data-helper type declarations match the runtime (#B588).** `nestBracketNotationKey` takes the bracket path as an array, and `formatDataFromString` returns `object | undefined`. Type-check only.
- **Fixed — a referenced value is compared exactly as typed (#B600, #B601, #B602).** In an `is` condition such as `$password === $passwordConfirm`, a double quote, a backslash or a line break in a value stopped the validation pass (the browser form could not submit, the server threw); parentheses and the word `return` inside a value were ignored (`ab(cd` matched `ab)cd`); and a value with no ASCII letter or digit (`!!!`) never matched.
- **Fixed — every `$field` token follows one grammar (#B603, #B604, #B606).** In an `is` condition, a route `validator::` requirement, a fluent `is()` call and a `query` rule's `data`: one pass, the longest field name wins, a token ends at the first character outside `A-Z a-z 0-9 _ -`, and a `$` naming no field stays literal — so `abc$email` is no longer substituted a second time, `($password) === ($passwordConfirm)` resolves, and `$passwordConfirm` in `query` data is no longer read as `$password` followed by `Confirm`.
- **Fixed — the in-memory Collection compares strings with `==`, `>` and `<`, and a quote no longer breaks a query (#B609).** A row whose string value held a `"` threw and failed the whole `find()`; `==`, `>` and `<` were not recognised on strings; and a space after the operator skewed the comparison. Both operands are now encoded before they are compared; numeric and datetime comparisons are unchanged.
- **Fixed — every request re-read the framework's env template from disk (#B610).** Six synchronous reads and parses per request in every bundle — measured at 27% of a trivial JSON route's CPU — are now one parse per process.
- **Fixed — bundle-to-bundle HTTP/2 calls no longer die after about 1,000 calls, and a call cut by a GOAWAY is retried (#B612, #B613).** The client reset every completed stream, which the target's runtime counted against its reset limit until it closed the session with `GOAWAY(INTERNAL_ERROR)`. A safe-method call cut by a GOAWAY is now retried on a fresh session, and a session gone before the send is retried for any method.
- **Fixed — the `/_gina/info` `rstCount` metric was always 0 (#B614).** It now counts the streams a client cuts short.
- **Fixed — bundle-to-bundle HTTP/2 sessions no longer leak, and the pre-flight PING no longer storms (#B625, #B627).** Evictions are identity-checked, so a dead session's late event no longer evicts its live replacement (which leaked, keepalive ticking); a replaced or evicted session is closed gracefully; one pre-flight PING serves every waiting caller; and a cancelled PING no longer counts as a dead session.
- **Fixed — the boot warmup (`server.warmup`) keeps its HTTP/2 sessions on Node.js (#B629).** Its PING went out while the session was still connecting and the cancel tore the session down; it is now sent once the session is connected.
- **Fixed — a request refused before the upstream processed it is retried for any method (#B630, #B631).** `REFUSED_STREAM` and an asynchronous `ERR_HTTP2_GOAWAY_SESSION` are re-sent within the retry budget, so a POST no longer fails with a 503 when nothing was processed.
- **Fixed — the Isaac server closes idle HTTP/2 sessions (#B619).** Its 120 s idle timer tested a property that does not exist and re-armed forever. An idle session now closes gracefully after `http2Options.sessionIdleTimeout` (default 120 s; `0` disables it). Node.js only.
- **Fixed — bundle-to-bundle HTTP/1.1 calls reuse their connections (#P44).** Each call built its own connection pool and threw it away, so 500 calls opened 500 connections; calls to one upstream now share one keep-alive pool, and `maxSockets` (default 100) now limits the concurrent connections to one upstream.
- **Fixed — an https bundle-to-bundle call no longer reads its CA file on every call (#B633).** The file is read once and read again only when it changes on disk, so a Kubernetes Secret update is still picked up by the next call.
- **Fixed — a Couchbase reconnect keeps each connector's declared `scope` (#B624).** The model rebuild omitted it, switching the connector to `NODE_SCOPE` for the documents it stamps and the queries it filters.
- **Fixed — `bulkInsert` escapes the bucket name (#B616).** A bucket such as `beer-sample` made the statement fail to parse; the name is now backtick-quoted.
- **Fixed — `project:add` no longer loses a scope or environment it has just registered (#B647).** Its link step raced the `scope:add` / `env:add` children over the registry files; it now starts once the rest of the command has finished.
- **Fixed — `scope:link-local`, `scope:link-production` and `env:link-dev` no longer crash without a registered project (#B641).** They print the missing or unknown project name and exit 1 instead of a stack trace.
- **Fixed — the same three commands exit after a successful change (#B648).** Started by the CLI's own path (`node <gina>/bin/cli …`, as CI jobs and scripts run it), they wrote the change and then hung on the CLI's open log listener; the installed `gina` launcher was not affected.
- **Fixed — the published package no longer carries end-to-end test artifacts (#B581).** Two Playwright `error-context.md` snapshots shipped in `0.6.32` and `0.6.33-alpha.1` — test fixtures only, no credentials and no local paths; `test-results/` and `playwright-report/` are now excluded from the tarball.

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
