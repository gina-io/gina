# Contributing to Gina

Gina follows a BDFL governance model — see [GOVERNANCE.md](./GOVERNANCE.md) for how decisions are made. Contributions of all experience levels are welcome.

---

## Table of contents

- [Requirements](#requirements)
- [Getting started locally](#getting-started-locally)
- [Running the tests](#running-the-tests)
- [Development environment](#development-environment)
- [Debugging](#debugging)
- [Coding conventions](#coding-conventions)
- [Branch model](#branch-model)
- [Local git hooks (opt-in)](#local-git-hooks-opt-in)
- [Commit style](#commit-style)
- [Changelog](#changelog)
- [Pull request checklist](#pull-request-checklist)
- [Reporting bugs](#reporting-bugs)
- [Proposing features](#proposing-features)

---

## Requirements

| Requirement | Version |
| --- | --- |
| OS | macOS or Linux (Windows: WSL2 or Docker) |
| Node.js | >= 22 < 27 |
| npm | >= 8 |
| Changie | >= 1.24 |

---

## Getting started locally

Gina must be reachable from the npm global prefix — the CLI and framework bootstrapper expect to run from `${prefix}/lib/node_modules/gina`. **Do not clone directly into that path**: npm owns it, and any `npm install -g gina` run on the machine replaces whatever sits there — a direct clone would be destroyed, git history, uncommitted work and all — with the published tarball. Clone to a normal workspace directory and **symlink** it into the prefix instead: npm can then only ever replace the symlink, never your repository.

#### 1. Clone to your workspace

```bash
git clone https://github.com/gina-io/gina.git
cd gina && git checkout develop
```

#### 2. Link the clone into the npm global prefix

```bash
npm config get prefix --quiet
```

The default is `/usr/local` (system) or `~/.npm-global` (user).

```bash
ln -s "$PWD" "$(npm config get prefix)/lib/node_modules/gina"
```

Optional hardening (macOS): make the link immutable, so even a global install fails loudly instead of silently replacing it. Undo with `chflags -h nouchg` before an intentional change.

```bash
chflags -h uchg "$(npm config get prefix)/lib/node_modules/gina"
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

If the `gina` command is not found, link the CLIs into the prefix bin once:

```bash
cd "$(npm config get prefix)/bin" && ln -s ../lib/node_modules/gina/bin/gina* .
```

> ⚠️ On a machine set up this way, never run `npm install -g gina` — it replaces the symlink with the published tarball and your clone stops being served (with a direct clone at that path, it would have been deleted outright). Update with `git pull` instead; to switch to the published package deliberately, remove the symlink first.

---

## Running the tests

The test suite uses Node's built-in `node:test` runner — no additional test dependencies needed.

```bash
# Run all tests — the same set CI gates on
npm test

# Run all tests with a coverage report
npm run test:coverage

# Run a single file
node --test test/core/controller.test.js

# Pass extra node:test flags — via the env var, NOT `npm test -- --flag`
GINA_TEST_FLAGS=--test-concurrency=2 npm test
```

`npm test` is the single source of truth for which files make up the suite:
CI runs exactly this script, so a green local run and a green CI run cover the
same set.

**Extra runner flags must go through `GINA_TEST_FLAGS`.** `node --test` stops
parsing options at the first positional argument, so a flag placed after the
file list is neither honoured nor rejected — it is silently ignored and the run
still exits 0. That makes `npm test -- --test-concurrency=2` a no-op that looks
like it worked. The `test` script interpolates `$GINA_TEST_FLAGS` *before* the
file list, which is why `npm run test:coverage` is defined as
`GINA_TEST_FLAGS=--experimental-test-coverage npm test`. Measured over 199
files: `--test-concurrency=1` before the list takes 47s, after the list 15s,
and with no flag at all 17s.

Some tests resolve the framework the way a consuming project does — via
`require('gina')`. For that to resolve from inside the clone, the repository
must be reachable as its own `gina` module. Create a one-time self-symlink (it
lives inside the gitignored `node_modules/`, so it never shows in `git status`):

```bash
mkdir -p node_modules && ln -sfn "$PWD" node_modules/gina
```

Without it, a handful of suite members fail with `Cannot find module 'gina'`.

`test/fw.js`, which most suite files load, refuses a tree whose
`node_modules/gina` is another directory: in a worktree whose `node_modules`
is linked whole to another clone's, the tests that `require('gina')` would run
that clone's code beside the worktree's. Give such a worktree a real
`node_modules` directory (link packages one by one if you share them) and its
own self-symlink.

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

## Coding conventions

All coding conventions — variable declarations, function style, constructor patterns, error handling, async patterns, naming, JSDoc, EventEmitter usage, path handling, logging, and test conventions — are documented in [CONVENTIONS.md](./CONVENTIONS.md).

Please read it before submitting your first pull request.

---

## Branch model

| Branch | Purpose |
| --- | --- |
| `master` | Stable — merged from `develop` via PR at release time |
| `develop` | Working branch — all PRs target this branch |

Always branch from `develop` and open your PR against `develop`.

---

## Local git hooks (opt-in)

If you have multiple git identities on one machine (work, personal, internal hostname), it is easy to commit under the wrong `user.email` and leak a private domain into the public git log. This repo ships an opt-in `pre-commit` hook that refuses commits authored under a private-domain identity.

Install it once from the repo root:

```bash
cp resources/git-hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

The hook checks `git config user.email` against a short list of private-domain patterns (see the `BLOCKED_PATTERNS` regex inside `resources/git-hooks/pre-commit` for the current list) and exits with an error message if any match — letting you switch identity (`git config user.email you@public-domain.example`) before retrying.

Edit `resources/git-hooks/pre-commit` and extend the `BLOCKED_PATTERNS` regex to cover any additional private domain or hostname suffix you want to guard against. The hook is local to your clone — it is not shared across contributors, so each contributor installs it independently.

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

- [ ] Tests pass — `npm test`
- [ ] New behaviour is covered by a test (or an explanation is provided for why it cannot be)
- [ ] A `changie new` entry exists for any user-facing change
- [ ] Commit messages follow the style above
- [ ] Docs updated if public API, CLI, or config schema changed (see [gina-io/docs/CONTRIBUTING.md](https://github.com/gina-io/docs/blob/main/CONTRIBUTING.md))

---

## Reporting bugs

Open a [GitHub issue](https://github.com/gina-io/gina/issues) and include:

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
| Martin Luther ETOUMAN NDAMBWE | Lead maintainer | [rhinostone.com](https://rhinostone.com) |
| Fabrice DELANEAU | Co-author | [fdelaneau.com](https://fdelaneau.com) |
