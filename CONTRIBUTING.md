# Contributing to Gina

Gina follows a BDFL governance model — see [GOVERNANCE.md](./GOVERNANCE.md) for how decisions are made. Contributions of all experience levels are welcome.

---

## Table of contents

- [Getting started locally](#getting-started-locally)
- [Running the tests](#running-the-tests)
- [Branch model](#branch-model)
- [Commit style](#commit-style)
- [Changelog](#changelog)
- [Pull request checklist](#pull-request-checklist)
- [Reporting bugs](#reporting-bugs)
- [Proposing features](#proposing-features)

---

## Getting started locally

**Requirements:** Node.js >= 18, npm >= 8.

```bash
git clone https://github.com/Rhinostone/gina.git
cd gina
npm install -g .
```

Installing with `-g` is required — Gina is a global CLI tool and framework. The install scripts (`preinstall` / `postinstall`) set up `~/.gina/` on first run.

---

## Running the tests

The test suite uses Node's built-in `node:test` runner — no additional test dependencies.

```bash
# Run all tests
node --test test/**/*.test.js

# Run a single file
node --test test/core/controller.test.js
```

Tests require Node >= 18. The suite currently covers core modules, lib utilities, and integration helpers. See `.claude/todo/unit-tests.md` for the full test inventory and roadmap.

---

## Branch model

| Branch | Purpose |
| --- | --- |
| `master` | Stable — merged from `develop` via PR at release time |
| `develop` | Working branch — all PRs target this branch |

Always branch from `develop` and open your PR against `develop`.

---

## Commit style

Use imperative or gerund sentences, matching the existing log:

```
Fixed GlobalContext::whisper() memory leak
Added _debugLog to server.isaac.js
Allowing bundle:build to build for dev env
```

- One logical change per commit
- No references to AI tools in commit messages, comments, or files

---

## Changelog

Gina uses [changie](https://changie.dev) for changelog management. After any user-facing change, run:

```bash
changie new
```

Pick the kind (`Added`, `Changed`, `Fixed`, `Removed`, `Security`) and write the body from the user's perspective. Do **not** edit `CHANGELOG.md` directly — changie generates it at release time from entries in `.changes/unreleased/`.

---

## Pull request checklist

Before opening a PR against `develop`:

- [ ] Tests pass — `node --test test/**/*.test.js`
- [ ] New behaviour is covered by a test (or an explanation is provided for why it cannot be)
- [ ] A `changie new` entry exists for any user-facing change
- [ ] Commit messages follow the style above
- [ ] Docs updated if public API, CLI, or config schema changed

---

## Reporting bugs

Open a [GitHub issue](https://github.com/Rhinostone/gina/issues) and include:

- Node.js version (`node --version`)
- Gina version (`gina --version`)
- Minimal reproduction steps
- Expected vs actual behaviour

---

## Proposing features

Open a GitHub issue describing the use case **before** writing code. Features that align with the [roadmap](./ROADMAP.md) and architecture are most likely to be accepted. Significant API changes go through a public discussion period before being finalised.
