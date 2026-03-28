# Contributing to Gina

Gina follows a BDFL governance model — see [GOVERNANCE.md](./GOVERNANCE.md) for how decisions are made. Contributions of all experience levels are welcome.

---

## Table of contents

- [Requirements](#requirements)
- [Getting started locally](#getting-started-locally)
- [Running the tests](#running-the-tests)
- [Development environment](#development-environment)
- [Debugging](#debugging)
- [Branch model](#branch-model)
- [Commit style](#commit-style)
- [Changelog](#changelog)
- [Pull request checklist](#pull-request-checklist)
- [Reporting bugs](#reporting-bugs)
- [Proposing features](#proposing-features)

---

## Requirements

| Requirement | Version |
| --- | --- |
| OS | macOS or Linux (Windows: Docker only) |
| Node.js | >= 18 |
| npm | >= 8 |
| Changie | >= 1.24 |

---

## Getting started locally

Gina must be installed globally — the CLI and framework bootstrapper expect to run from the npm global prefix. Contributors clone directly into that location instead of using `npm install -g .`.

#### 1. Find your global prefix

```bash
npm config get prefix --quiet
```

The default is `/usr/local` (system) or `~/.npm-global` (user). The target directory is `${prefix}/lib/node_modules/gina`.

#### 2. Clone into the prefix

```bash
cd $(npm config get prefix)/lib/node_modules
git clone https://github.com/Rhinostone/gina.git gina
cd gina && git checkout develop
```

#### 3. Run the install scripts

```bash
node ./script/pre_install.js
node ./script/post_install.js
```

#### 4. Verify

```bash
gina version
```

---

## Running the tests

The test suite uses Node's built-in `node:test` runner — no additional test dependencies needed.

```bash
# Run all tests
node --test test/**/*.test.js

# Run a single file
node --test test/core/controller.test.js
```

---

## Development environment

When contributing to the framework, use the `dev` environment. It enables hot-reload, the debug toolbar, and verbose logging that makes it easier to follow what the framework is doing internally.

```bash
gina framework:set --env=dev
```

This sets the default environment so you can omit `--env=dev` from subsequent commands. To start the framework:

```bash
gina start
```

To follow logs in real time:

```bash
gina tail --follow
```

To revert to production defaults:

```bash
gina framework:set --env=prod
```

---

## Debugging

### Framework

```bash
gina start --inspect-gina
```

### Bundle

```bash
gina bundle:restart <bundle_name> @<project_name> --inspect=<port_number>
```

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

```text
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
- [ ] Docs updated if public API, CLI, or config schema changed (see [gina-io/docs/CONTRIBUTING.md](https://github.com/gina-io/docs/blob/main/CONTRIBUTING.md))

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

---

## Maintainers

| Name | Role | Profile |
| --- | --- | --- |
| Martin Luther | Lead maintainer | [rhinostone.com](https://rhinostone.com) |
| Fabrice Delaneau | Co-author | [fdelaneau.com](https://fdelaneau.com) |
