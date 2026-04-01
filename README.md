# Gina

[![npm version](https://badge.fury.io/js/gina.svg)](https://badge.fury.io/js/gina) [![GitHub version](https://badge.fury.io/gh/gina-io%2Fgina.svg)](https://badge.fury.io/gh/gina-io%2Fgina) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D%2018-brightgreen)](https://nodejs.org) [![Tests](https://github.com/gina-io/gina/actions/workflows/test.yml/badge.svg)](https://github.com/gina-io/gina/actions/workflows/test.yml)

> **Documentation:** [gina.io/docs](https://gina.io/docs/) · **Issues:** [GitHub](https://github.com/gina-io/gina/issues) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

Node.js MVC framework with built-in HTTP/2, multi-bundle architecture, and scope-based data isolation — no Express dependency.

- **HTTP/2 first.** Built-in `isaac` server with TLS, h2c, ALPN, HTTP/1.1 fallback, and full CVE hardening (Rapid Reset, CONTINUATION flood, RST flood, HPACK bomb) — all on by default.
- **Multi-bundle.** One project hosts multiple independent bundles (API, web, admin, …). Each bundle has its own routing, controllers, models, and config. Share code via the project layer.
- **Scope isolation.** Run `local`, `beta`, and `production` from the same codebase. Scopes propagate through routing, config interpolation, and data (every DB record is stamped with `_scope`).

## Features

| Feature | Detail |
| --- | --- |
| HTTP/2 server | Built-in `isaac` engine — TLS, h2c, ALPN, HTTP/1.1 fallback, 103 Early Hints, CVE-hardened |
| Multi-bundle | One project, N independent bundles with shared config and project layer |
| Scope isolation | `local` / `beta` / `production` — per-request and per-record |
| MVC routing | `routing.json` — declare routes in config, not code; O(m) radix trie lookup |
| Async/await | Controller actions can be `async`; rejections routed to `throwError` automatically |
| ORM / entities | EventEmitter-based entity system; SQL files auto-wired to entity methods |
| Connectors | Couchbase, MySQL, PostgreSQL, Redis, SQLite, AI (LLM) — loaded from project `node_modules` |
| AI connector | Any LLM provider via named protocol (`anthropic://`, `openai://`, `ollama://`, …) |
| Template engine | Swig 1.4.2 built-in; streaming SSE/chunked via `renderStream()` |
| Hot reload | WatcherService evicts `require.cache` only on file change — zero per-request overhead in dev |
| K8s ready | `gina-container`, `gina-init`, SIGTERM drain, JSON stdout logging |
| Dependency injection | Mockable connectors and config for unit testing |

## Quick start

```bash
npm install -g gina@latest --prefix=~/.npm-global
gina new myproject
gina bundle:add api @myproject
gina bundle:start api @myproject
open https://localhost:3100
```

## What's in 0.3.0-alpha.1

- **AI connector** — any LLM via `connectors.json`; unified `.infer()` normaliser; raw `.client` for streaming
- **MySQL & PostgreSQL connectors** — entity wiring, SQL files, native Promise + `.onComplete()` shim
- **Async controller actions** — `async function` actions with automatic rejection handling
- **`renderStream()`** — stream `AsyncIterable` as SSE or chunked HTTP without buffering
- **103 Early Hints** — automatic for CSS/JS; manual via `self.setEarlyHints(links)`
- **Route radix trie** — O(m) candidate lookup at startup; linear scan replaced on cache miss
- **HTTP/2 session metrics** — `activeSessions`, `totalStreams`, `goawayCount`, `rstCount` in `/_gina/info`
- **Configurable HTTP/2 settings** — `maxConcurrentStreams` and `initialWindowSize` via `settings.json`
- **WatcherService hot reload** — file-change-triggered eviction; per-request overhead eliminated
- **Per-bundle framework version** — pin `"gina_version"` in `manifest.json` per bundle

See the full [Changelog](./CHANGELOG.md) and [Roadmap](./ROADMAP.md).

## Documentation

Full installation guide, tutorials, configuration reference, and API docs at **[gina.io/docs](https://gina.io/docs/)**.

- [Getting started](https://gina.io/docs/getting-started/)
- [Guides](https://gina.io/docs/guides/)
- [CLI reference](https://gina.io/docs/cli/)
- [Configuration reference](https://gina.io/docs/reference/)
- [Security & CVE compliance](https://gina.io/docs/security)

## Governance

Gina is co-authored by **Martin Luther** ([Rhinostone](https://rhinostone.com)) and **Fabrice Delaneau** ([fdelaneau.com](https://fdelaneau.com)). Final decisions on direction, API design, and releases rest with Martin Luther. Community contributions and RFCs are welcome and taken seriously. See [GOVERNANCE.md](./GOVERNANCE.md) for details.

## License (MIT)

Copyright © 2009-2026 [Rhinostone](http://www.rhinostone.com/)

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
