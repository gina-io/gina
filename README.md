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

## What's in 0.7.9

> **Restart your bundles *and* rebuild them.** Form validation, form resets,
> file staging and `merge()` ship in the browser bundle, so `gina.min.js`
> changed and `gina bundle:restart` alone leaves the old client running:
> rebuild each consuming bundle, then restart it. If your build copies
> `gina.min.js` into your own static files, rebuild that copy before the
> restart.

> **Read before upgrading — some changes can change an answer.** Swig 2.12.1
> reads a key from the template data that names `__proto__`, `constructor` or
> `prototype` as missing, and a native `{% set %}` whose bracket target is
> given such a key throws when the template runs. An upload part whose `group`
> names a member of `Object.prototype` is answered HTTP 400. A form reset now
> runs a form-associated custom element's `formResetCallback`, and drops a
> submit that was waiting for a staged upload instead of replaying it once the
> upload ends. A rule on a staged file input runs again, so a required one
> with no file refuses the submit; a staged input that takes a selection of
> fewer files posts only those, and one whose staging failed is emptied. A
> form's error callback payload now carries `transportError: false` and
> `contentType` whenever the server answered. `merge()` adds a `NaN` only when
> the result holds none. Over HTTP/2, a request answered before its body has
> been read now has its stream closed with `RST_STREAM(NO_ERROR)` once the
> answer has gone out, and `self.sendTrailers()` now delivers its fields. The
> [migration notes](https://gina.io/docs/migration) list every behaviour change.

**The HTTP/2 and uploads release.** Security fixes: over HTTP/2, a request
answered before its body has been read, or a multipart upload refused while its
body is parsed, no longer keeps its stream open, and on Bun 1.2 and 1.3 the
bundle no longer holds what the client keeps sending; merging an array of
objects compared on their `id` no longer takes time cubic in its length; an
upload part whose `group` names a member of `Object.prototype` no longer
sidesteps the configured allow-list; and gina requires `@rhinostone/swig`
`^2.12.1`, whose earlier releases let a key from the template data reach the
prototype chain. The other fixes cover form resets, staged file inputs, live
checks, form error callbacks, `self.sendTrailers()` over HTTP/2, `merge()`
with `NaN`, and the error page of an upload that stops. Full detail in
[CHANGELOG.md](./CHANGELOG.md).

- **Security — HTTP/2 requests answered before their body is read (#B1071, #B1076, #B1086).** Over HTTP/2, a request answered while its client was still sending the body kept its stream open: the 413 past `server.maxBodySize`, the 431 past `upload.maxFieldsSize`, the 400 of a multipart body that fails to parse, the refusals gina gives while it parses a multipart body (too many files, an upload group that is not configured, an extension the group does not allow, a second file in a single-file group, the text-field limits, and the 500s of an upload directory that cannot be created, a write error or a multipart listener that throws), and, on Bun, the answers given before the body is read (the `/_gina/*` control endpoints, the cross-origin guard, the maintenance gate, the admin endpoints, a static file answered to a request that carries a body). On Bun 1.2 and 1.3 the bundle held everything the client kept sending in memory, without bound; on Node.js and Bun 1.4 the stream stayed open with the client held at its window. The server now closes the stream with `RST_STREAM(NO_ERROR)` once the answer has gone out, removes the parts a refused upload staged, and on Bun discards the unread body. HTTP/1.1 answers are unchanged.
- **Security — merging id-keyed arrays (#B1078).** Merging an array of objects compared on their `id` (or on the key set with `merge.setKeyComparison()`) took time cubic in its length when the target already held every id: 2,000 objects took about 4 to 5 seconds and blocked the event loop. It now takes a few milliseconds. Results are unchanged, except that an element that refers to itself no longer throws `RangeError` when every id is already present.
- **Security — upload groups named after `Object.prototype` members (#B1089).** An upload part whose `group` named a member of `Object.prototype` (`__proto__`, `constructor`, `hasOwnProperty`, `toString`, …) passed the configured-group check, and the group's rules were skipped: the file was accepted whatever its extension, a single-file group accepted several, and the file was staged to the default upload directory. Such a part is now answered HTTP 400 as an unconfigured group.
- **Security — swig `^2.12.1` (#B1088).** Up to 2.12.0, a key from the template data that names `__proto__`, `constructor` or `prototype` reached the prototype chain wherever a template read a value with it: a subscript printed the Object constructor, a call on such a value could run text from the data as JavaScript, and a native `{% set %}` whose bracket target took the key put a property on `Object.prototype` for the whole process (advisory GHSA-8mf3-p375-389g). A template is exposed when it indexes a value with a key that the request controls. Gina compiles a template each time it renders it and stores no compiled output, so a restart picks the fix up; a project copy loaded through `swig.useProject`, or a frontend selected through `swig.package`, keeps its own version: update it there.
- **Fixed — form resets (#B1041, #B1087, #B1043).** A reset (`form.reset()`, a reset button, or the handle's `.resetFields()`) now restores a form-associated custom element through its own `formResetCallback`, once the form's other controls are restored, as a native reset does; a callback that throws is reported without stopping the reset of the other fields. A reset also drops a submit that was waiting for one of the form's staged uploads and releases the busy state that submit armed, where the submit used to be replayed with the restored values once the upload succeeded.
- **Fixed — staged file inputs (#B1058, #B1057, #B1059).** A rule on a staged file input, declared under the input's name, runs again: none ran since 0.7.2, so `isRequired` let the form be sent with no file. An input that takes a selection of fewer files no longer posts the files it replaced, and after a failed staging the same file can be chosen again.
- **Fixed — live checks (#B1069, #B1038).** A live check still on its way when its form is destroyed (a debounced keystroke, a radio or checkbox pick, a `query` answer) no longer throws an uncaught `TypeError`, and changing a live-checked `<select>` no longer writes a page global named `once`.
- **Fixed — form error callbacks (#B1083).** The error callback's payload now carries `transportError: false` and `contentType` whenever the server answered, so a reverse proxy's HTML page can be told apart from a message the application wrote; an answer sent as an attachment keeps a body that is not JSON in `message`, where it was dropped.
- **Fixed — HTTP/2 trailers (#B1080).** `self.sendTrailers(fields)` delivers its fields over HTTP/2: in every release from 0.4.0 through 0.7.8, no field arrived. A field the HTTP/2 layer cannot send is dropped when it is recorded, and an answer that `throwError()` gives carries no trailers.
- **Fixed — `merge()` with `NaN` (#B1091).** When an array inside an object the target lacks held two or more object elements followed by `NaN`, or when an array was merged with itself, `merge()` never returned and the heap ran out. A `NaN` is now present once the result holds one, and it is never topped up.
- **Fixed — the error page of an upload that stops (#B1075).** An HTML request whose multipart upload stops while a file part is still being written now gets the bundle's custom error page, where the stopped write stream's error could answer the built-in 500 page first.

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
