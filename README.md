# Gina

[![npm version](https://img.shields.io/npm/v/gina)](https://www.npmjs.com/package/gina) [![npm downloads](https://img.shields.io/npm/dm/gina)](https://www.npmjs.com/package/gina) [![GitHub stars](https://img.shields.io/github/stars/gina-io/gina)](https://github.com/gina-io/gina/stargazers) [![Tests](https://github.com/gina-io/gina/actions/workflows/test.yml/badge.svg)](https://github.com/gina-io/gina/actions/workflows/test.yml) [![Socket](https://img.shields.io/badge/Socket-view%20analysis-blue)](https://socket.dev/npm/package/gina) [![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D%2022-brightgreen)](https://nodejs.org) [![Bun >= 1.2](https://img.shields.io/badge/Bun-%3E%3D%201.2-brightgreen)](https://bun.sh) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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

## What's in 0.7.0

> **Restart your bundles *and* rebuild them.** Two changes are browser-bundled —
> custom form validators now compile without `eval`, and the warm route cache is
> one map — so `gina.min.js` changed and `gina bundle:restart` alone leaves the old
> client running. Rebuild each consuming bundle, then restart.

> **A new minor version — check what carries over to `~/.gina/0.7`.** On an npm
> install, the install writes `~/.gina/0.7/settings.json` from its template, so
> `port`, `debug_port`, `mq_port`, `host_v4`, `bind_host`, `hostname`, `rundir`,
> `logdir`, `tmpdir` and the log level start from their defaults: re-apply them
> with `gina framework:set`. With Bun, a `gina-container` image or a git checkout,
> those nine carry over from `~/.gina/0.6/settings.json` and only the log level
> resets. Culture, timezone, default environment and scope carry over on every
> path. A `^0.6.x` dependency range does not resolve `0.7.0` — widen it to
> `^0.7.0`.

> **Read before upgrading — some changes can change an answer.** A plain `GET`
> no longer runs an action whose route is `DELETE`: the popin and link plugins'
> same-origin XHR anchors keep working, but any other client must send a real
> `DELETE`. `project:rename` refuses a registered name, `project:add` and
> `project:import` read `--path`, `--scope` and `--env` whole, a `405` now
> carries `Allow`, and a `HEAD` is served by every `GET` route. The scaffolded
> Couchbase keep-alive key is `pingInterval`, not `ping` — check your
> `connectors.json`. And plan for `0.8.0`: Swig's `autoescape` default becomes
> `true`; a bundle that leaves it unset now says so at boot. The
> [migration notes](https://gina.io/docs/migration) list every behaviour change.

**The hardening and throughput release.** Seven security fixes lead it: a `GET`
could run a route's `DELETE` action for another site; on Express 5 one body-less
request could stop a bundle; a stack passed as an error message reached the
client; `gina tail --follow` could re-run another local user's program; a long
`X-Forwarded-Prefix` header could tie up an isaac bundle; a malformed frame could
stop the framework daemon; and the browser bundle no longer carries any
dynamic-code call. The inter-bundle throughput arc closes with a route candidate
index and a one-map warm route cache, and `0.7.0` prepares Swig's move to escaped
output by default in `0.8.0`. Full detail in [CHANGELOG.md](./CHANGELOG.md).

- **Security — a `GET` no longer runs a `DELETE` action for another site (#B662).** So that the popin and link plugins could send their anchors as a `GET`, the router served any `GET` to a `DELETE` route as a `DELETE`, for any client: a cross-site navigation carrying the visitor's session cookie could run it — on the Express engine even with the Csrf plugin adopted, and on either engine without it, since the Session plugin's default `SameSite=Lax` cookie is sent on a top-level navigation. The override is now granted only to a same-origin XHR (`X-Requested-With: XMLHttpRequest`, `Sec-Fetch-Site` of `same-origin` or `none`, no foreign `Origin`); any other `GET` answers 404, or 405 on a route whose methods include `DELETE`.
- **Security — on Express 5, one body-less request no longer stops the bundle (#B666).** A `DELETE`, or a `POST`, `PUT` or `PATCH` without a body, on any URL and with no authentication, found `request.query` undefined, and the resulting TypeError exited the process. `request.query` is now an accessor that materialises Express's own parse on first read. Express 4 and the default isaac engine were never affected; `0.6.9` to `0.6.33` were.
- **Security — a stack passed as an error message no longer reaches the client (#B670).** `self.throwError(res, 500, err.stack)`, or an error whose `message`, `error` or `title` holds a stack, put file paths and frames in the JSON body and on the built-in error page in every scope. Outside the local scope such a value now keeps only its first line in the response, and the full text goes to the server log line that carries the incident ref.
- **Security — `gina tail --follow` no longer re-runs a start command from the shared tmp directory (#B676).** The command a crash restart re-runs is now saved as `~/.gina/run/<bundle>@<project>.argv` (mode 0600) and re-run only from a regular file owned by the current user that group and other cannot write; where `/tmp` is shared, another local user could create the old file first. Restart `gina tail`, then start each bundle once so its file is written in the new place.
- **Security — a long `X-Forwarded-Prefix` header no longer ties up an isaac bundle (#B679).** The trailing-slash trim backtracked quadratically on a long run of slashes and ran before the 255-character cap, so one request with a 15 KB header cost about 100–170 ms of CPU. The cap now runs first. `0.3.10` to `0.6.33` were affected.
- **Security — a malformed frame on the log listener no longer stops the framework daemon (#B678).** A frame on port 8125 whose `request` names an inherited object member, such as `__proto__`, threw out of the socket handler and ended the daemon, which also serves the command socket on 8124; the listener now dispatches only short identifiers to its own methods. It binds loopback by default, so only a local process could reach it. Pickup: a framework restart.
- **Security — the browser bundle carries no dynamic-code call (#M21d).** A custom form validator is compiled by the browser as an inline script carrying the page's CSP nonce instead of through `eval` — the same `this.getValidationContext()` contract, and no `'unsafe-eval'` needed — and the two unreachable calls in the bundled RequireJS and engine.io-client are rewritten at build time. Nothing changes for a validator file that follows the reference.
- **Added — a boot warning when Swig `autoescape` is not set; `true` becomes the default in `0.8.0` (#B359).** Rendered output does not change in `0.7.0`. Set `settings.swig.autoescape` explicitly to silence it: `false` keeps today's output; with `true`, mark HTML you trust with `| safe` — `{{ gina.csrfInput | safe }}` first, or every form POST fails CSRF. New bundles are scaffolded with `"autoescape": true`.
- **Added — a boot warning for routing `requirements` regexes that are not anchored (#B360).** A requirement is tested as a partial match, so `"/[0-9]+/"` accepts `123abc`. Anchor each listed pattern (`"/^[0-9]+$/"`); nothing is rewritten for you, and requirements are not applied when a URL is built.
- **Changed — routing tests only the routes whose URL could match (#P46).** A per-table candidate index skips the rules a request's URL cannot match — a late rule on a 380-rule table went from about 440 µs to about 14 µs — so a skipped rule's `validator::` requirement is no longer evaluated for that request.
- **Changed — the warm route cache is one map and keeps only the matched rule (#P46).** A lookup and an eviction cost the same at any size, and an entry no longer keeps the first request's parameters and data — a login form's body included — for the life of the process.
- **Changed — `self.query()` over HTTP/2 no longer adds `status: 200` (#P47).** An upstream JSON body without a `status` arrives as sent, as it always did over HTTP/1.1, with no warning per call; treat an absent `status` as success.
- **Fixed — the first gina commands after a minor-version upgrade no longer fail (#B680, #B681).** When `bundle:start`, `bundle:restart`, `project:start`, `project:restart` or a `gina-container` boot ran first, every later command exited `1` (`reading 'split'`) until `main.json` was repaired by hand, and the first command after any minor upgrade failed once (`reading 'indexOf'`). Installs that skip npm's install scripts were exposed. CLI only.
- **Fixed — with `autoescape: true`, Swig pages keep their CSS and JavaScript (#B690).** gina's injected `<link>` and `<script>` tags rendered as visible text; they are now injected with `| safe`, and `nl2br` keeps its line breaks. Output with escaping off is unchanged.
- **Fixed — a `405` carries `Allow`, and a `HEAD` works on every `GET` route (#B659, #B667).** The `Allow` header lists the methods of the routes whose URL matched; a `HEAD` on a parameterised URL used to answer 404, and on a route declaring several methods 405.
- **Fixed — a `HEAD` gives the action `req.get` (#B675).** A `GET` action reading `req.get.<param>` answered 500 on `HEAD`; `req.get` is now the same object as `req.head`.
- **Fixed — on the Express engine, a URL carrying a query string resolves (#B668).** `GET /items?page=2` and a cache-busted static such as `/css/app.css?v=3` answered 404 on Express 4 and 5; the query is now stripped before routing and statics, as on isaac.
- **Fixed — `env:add <env> @<project>` makes the environment ready to start (#B643).** It registered the environment but gave no bundle ports for it; it now allocates them, writes the `env.json` blocks, prints a confirmation and exits.
- **Fixed — `project:add` and `project:import` read `--path`, `--scope` and `--env` whole (#B644).** A value holding `=` was cut at its second `=`.
- **Fixed — `project:rename` renames to a free name and refuses a taken one (#B651).** It refused every free name, and renamed port records of any project whose name began with the old one.
- **Fixed — six more commands exit after their work (#B653).** Started by the CLI's own path, as CI and scripts run it, `port:reset` with no project, `env:unset`, `env:set` with no key, `port:list --format=json|conf`, `connector:list` without a project and a cancelled `protocol:set` prompt never ended.
- **Fixed — a path with a space no longer breaks the install, `port:reset` or `bundle:restart` (#B663).** The install scripts, `port:reset` and `bundle:restart` no longer run their commands through a shell, so a home directory or npm prefix with a space works, and `port:reset` no longer needs `gina` on your `PATH`.
- **Fixed — a failed copy no longer leaves a temporary file behind, and reports a stack on Bun (#B649, #B654).**
- **Fixed — the scaffolded Couchbase keep-alive interval is `pingInterval` (#D51).** The example named `ping`, a key the connector ignores — check your `connectors.json`.

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
