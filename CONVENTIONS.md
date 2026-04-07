# Gina — Coding Conventions

Observed from the current framework codebase. Each convention includes current practice, consistency estimate, and improvement recommendations.

---

## 1. Variable Declarations

**Current practice:** `var` dominates (~90%). `const` appears for top-level `require()` imports in newer files and a few module-level constants. `let` is used almost exclusively in `for` loop counters.

```js
// dominant pattern — all scopes
var self = this;
var local = {};
var fs = require('fs');

// newer files only — top-level imports
const path = require('path');
const { EventEmitter } = require('events');

// rare — loop counters in recent code
for (let i = 0, len = arr.length; i < len; ++i) { ... }
```

**Rules:**
- `var` for all function-scoped variables in existing code
- `const` for imports and values that never reassign (new files)
- `let` for block-scoped temporaries and loop counters (new files)
- No arrow functions — see §2

**Recommendation:**
Standardise new files on `const` for imports, `let` for locals, `var` only where hoisting is intentionally relied upon. Do not do a mass refactor of existing files — the risk outweighs the gain. Apply the new standard file-by-file as files are touched for other reasons.

---

## 2. Function Definition Style

**Current practice:** Named function expressions for private inner functions; `this.method = function()` for public instance methods; named declarations for constructors and top-level utilities. Arrow functions are absent by convention.

```js
// constructor (top-level declaration)
function SuperController(options) { ... }

// private inner function (expression)
var init = function() { ... }
var freeMemory = function(variables, isGlobalModeNeeded) { ... }

// public instance method
this.render = function(userData, displayInspector, errOptions) { ... }

// async addition (recent)
this.store = async function(key, value, ttl) { ... }
```

**Rules:**
- No arrow functions `=>` in framework code — not a restriction to lift, but a deliberate choice that avoids `this`-binding ambiguity in the constructor/closure patterns used
- `async function` is acceptable for new I/O-bound operations
- Do not convert existing callbacks to `async` without also converting all callers (see §5)

**Recommendation:**
Arrow functions may be introduced carefully in pure utility functions with no `this` reference. Keep the ban on arrow functions inside constructor bodies where `self = this` captures are in use — the risk of confusing `this` contexts is real.

---

## 3. Constructor / Class Patterns

**Current practice:** Pre-ES6 constructor functions exclusively. No `class` keyword anywhere. Singleton via static properties. Inheritance via `lib/inherits(Child, Parent)`.

```js
// Singleton pattern
function Router(env, scope) {
    var self = this;
    var local = {};
    var init = function() {
        if (typeof(Router.initialized) != 'undefined') return self.getInstance();
        Router.instance    = self;
        Router.initialized = true;
    }
    init();
}

// Public instance method
Router.prototype.getInstance = function() { return Router.instance; }

// Inheritance
Entity = inherits(Entity, EntitySuperClass);
```

**Rules:**
- No ES6 `class` syntax — existing code uses pre-ES6 patterns throughout
- Singletons use `Constructor.initialized` + `Constructor.instance` static flags
- `var self = this;` is mandatory in all constructors and methods referencing instance state
- `var local = {};` is the private closure for per-instance or per-request state
- Static factory methods (e.g., `SuperController.createTestInstance`) are the approved pattern for test instances

**Recommendation:**
ES6 `class` can be introduced for entirely new modules that have no inheritance relationship with existing framework classes. Do not mix `class extends` with `inherits()` — they are incompatible. The singleton `#C1` pattern (#M1 roadmap item) is the primary architectural risk — see architecture docs.

---

## 4. Error Handling

**Current practice:** Four patterns coexist across different generations of the codebase.

```js
// 1. try/catch (dominant in core)
try {
    var config = new Config().getInstance();
} catch (configErr) {
    serverInstance.throwError(response, 500, configErr);
    return null;
}

// 2. self.throwError / controller.throwError (HTTP errors)
self.throwError(local.res, 404, new Error('Not found'));

// 3. next(err) (middleware chain)
return next(err);

// 4. error-as-value return (path helpers — anti-pattern)
var result = pathObj.mkdirSync(); // may return Error, callers rarely check
```

**Rules:**
- `try/catch` for all I/O and JSON operations
- `self.throwError(res, code, err)` for HTTP error responses in controllers
- `next(err)` for middleware-style propagation
- **Never** use error-as-value returns in new code — always `throw` or callback with `err`
- Always null `local.req/res/next` at every error exit point in controllers (memory hygiene)

**Recommendation:**
Audit all `_.prototype.mkdirSync()` call sites (~25) that ignore the return value — this is a silent failure risk documented in security.md. New code must either `throw` on error or use the callback/Promise pattern. Introduce a lint rule to catch unchecked return values from `mkdirSync`.

---

## 5. Async Patterns

**Current practice:** Three generations coexist. Migration from callbacks → EventEmitter → Promises is in progress.

```js
// Gen 1: error-first callbacks (original, still used in cmd handlers)
self.checkIfMain(function(err) {
    if (err) return done(err);
    done();
});

// Gen 2: EventEmitter .onComplete() (entity model layer, backward-compat bridge)
entity.findById(id).onComplete(function(err, data) { ... });

// Gen 3: native Promise + .onComplete() bridge (added 2026-03-20)
var _promise = new Promise(function(resolve, reject) {
    entity.once('user#findById', function(err, result) {
        if (err) reject(err); else resolve(result);
    });
});
_promise.onComplete = function(cb) { _promise.then(cb.bind(null,null)).catch(cb); return _promise; };
return _promise;
```

**Rules:**
- `.onComplete(cb)` is the public contract for all entity methods — never break it
- `.once()` not `.on()` for entity event listeners — mandatory (documented in architecture)
- `entity.removeAllListeners([eventName])` before every `.once()` registration
- New non-entity async code may use `async/await` directly
- Do not `await` inside a constructor — use lazy init patterns instead

**Recommendation:**
Complete the migration by adding `onCompleteCall(emitter)` Promise adapter (#M4) so controllers can use `async/await` without touching entity internals. Avoid creating any new callback-only APIs — all new async APIs should return Promises with an optional `.onComplete()` bridge for backward compatibility.

---

## 6. Module System

**Current practice:** CommonJS exclusively. No ESM. Extensive use of global helpers injected by `gna.js` without explicit `require()`.

```js
// Standard CJS
var fs = require('fs');
module.exports = SuperController;

// Dev-mode cache-busting pattern
var _require = function(path) {
    if (isCacheless) { delete require.cache[require.resolve(path)]; }
    return require(path);
}

// Globals (no require needed — injected by gna.js)
_(path, true)          // PathObject constructor
getContext('gina')     // global context read
setEnvVar('KEY', val)  // env var write
requireJSON(path)      // cached JSON read
```

**Rules:**
- No ESM `import`/`export` in framework files (roadmap item #M10 for Q1 2027)
- `_require()` only for hot-reload delegate files; use plain `require()` for singletons (logger, cache)
- Do not add new global injections — use explicit `require()` in new files
- Circular dependencies must be resolved at the module level, not papered over with `require.cache` fallbacks

**Recommendation:**
Document all globals injected by `gna.js` with `@global` JSDoc so IDEs can discover them. Long-term, migrate toward explicit exports (#M8) so static analysis tools can trace the dependency graph. The `utils/helper.js ↔ lib/logger` circular dependency is a known risk — resolve before the async migration (#M4/M5).

---

## 7. Naming Conventions

**Current practice:**

| Element | Convention | Example |
| --- | --- | --- |
| Files (multi-word) | dot-separated namespacing | `controller.render-json.js`, `server.isaac.js` |
| Files (versioned) | `.vN` suffix | `connector.v4.js`, `session-store.v2.js` |
| Files (kebab) | kebab-case | `link-dev.js`, `api-error.js` |
| Files (test) | numeric prefix + snake | `01-init_new_project.js` |
| Constructors | PascalCase | `SuperController`, `EntitySuper`, `CmdHelper` |
| Variables | camelCase | `envIsDev`, `scopeIsLocal`, `isLoadedThroughCLI` |
| Private/internal | `_` prefix | `_isDev`, `_options`, `_scope`, `_conn`, `_promise` |
| Instance capture | always `self` | `var self = this;` |
| Private closure | always `local` | `var local = {};` |
| EventEmitter instance | `e` | `var e = new EventEmitter();` |
| Env vars / globals | SCREAMING_SNAKE | `GINA_DIR`, `GINA_HOMEDIR`, `NODE_SCOPE` |
| Config keys (settings) | snake_case | `dev_env`, `def_scope`, `log_level` |
| Config keys (routing) | camelCase | `startingApp`, `projectName`, `bundlesConfiguration` |

**Rules:**
- `self` and `local` are reserved names — do not use them for other purposes inside constructors
- Underscore prefix means "not part of the public API" — never call `_prefixed` methods from user bundles
- Settings/home dir config: `snake_case`. Routing/server config: `camelCase`. Do not mix within one config file.
- **Names must be human-readable:** functions, methods, classes, and variables must use full words that describe intent. Single-letter names (`x`, `n`, `fn`) are only acceptable as loop counters (`i`, `j`, `k`, `len`) and in arrow-function shorthands where context is unambiguous. Abbreviations are allowed only when universally understood in the domain (`req`, `res`, `err`, `env`, `cfg`, `cb`). Never use names like `tmp2`, `foo`, `data2`, or `handler1` — name the thing by what it actually does or represents.

**Recommendation:**
Standardise config file field naming to `camelCase` across all new config files (`snake_case` is a legacy of early framework development). Document the reserved words (`self`, `local`, `e`) in this file so contributors know not to repurpose them.

---

## 8. Comments and JSDoc

**Current practice:** JSDoc on constructors and public methods in recently refactored files. Inline comments use `//` with a `TODO -` format. Ticket references use `#` prefix.

```js
// Copyright block (most files)
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 * ...
 */

// JSDoc (recent files)
/**
 * @class SuperController
 * @constructor
 * @this {SuperController}
 */

// Inline markers
// TODO - handle windows case
// N.B.: must be called before setOptions()
// replaced: old pattern — reason (#ticket)
// BO - section description
// EO - section description
```

**Rules:**
- **Every time code is written or modified, add or update JSDoc on the affected functions.** This is not a deferred task — JSDoc is part of the definition of done for any code change. New functions must ship with JSDoc; modified functions must have their JSDoc updated to reflect the change.
- Every constructor must have `@class`, `@constructor`, `@this` JSDoc
- Every public method must have at minimum `@param`, `@returns`, and at least one `@example`
- Private/inner functions (inside IIFEs or closures) must have `@inner` and `@private`
- Use `@typedef` for reusable data shapes at the top of the file
- Use `@constant` for module-level constants with a brief description of purpose
- State variables should have `@type` annotations describing their role
- `TODO - ` (with dash and space) is the standard TODO format
- Preserve replaced code as inline comments with `// replaced: <what> — <why>` when the change is non-obvious
- `"use strict";` should be present in all new files
- **Never use `*/` inside a JSDoc comment** (e.g. in code examples showing block comments) — it prematurely closes the comment block and causes syntax errors. Reword to avoid it.

**Recommendation:**
Add `"use strict";` to all new files immediately (no mass refactor of old files). Add ESLint or JSHint config (`.jshintrc` / `.eslintrc`) to enforce it on new code. The JSDoc backfill is tracked as #M9 in the roadmap.

---

## 9. EventEmitter Patterns

**Current practice:** Well-established and consistently applied.

```js
// Entity trigger naming: <entity>#<method>
entity.removeAllListeners(['user#findById']);
entity.once('user#findById', function(err, result) {
    if (err) reject(err); else resolve(result);
});

// Framework lifecycle events: descriptive strings
emitter.emit('server#started', server, app);
emitter.once('config#complete', function(err, config) { ... });

// Listener cap
var ENTITY_MAX_LISTENERS = 100;
self.setMaxListeners(Math.min(self._maxListeners + 1, ENTITY_MAX_LISTENERS));
```

**Rules:**
- `.once()` not `.on()` for all entity trigger listeners — mandatory
- `removeAllListeners([name])` before every `.once()` registration
- `ENTITY_MAX_LISTENERS = 100` — never exceed without understanding the implication
- Framework lifecycle events use `#` separator: `component#event`
- Entity triggers use `#` separator: `entityName#methodName`
- Numbered variant (`entity#method1`) exists for loop/recursive emit safety — avoid in new code

**Recommendation:**
This is the best-maintained convention in the codebase. The only risk is `_arguments` buffer poisoning under concurrent load (#M2) — tracked in the roadmap.

---

## 10. Path Handling

**Current practice:** The `_()` global is the primary tool for path normalization.

```js
// String path (most common)
var filename = _(opt.path + '/' + bundle + '/data' + url + '.json', true);

// PathObject (for existence checks, mkdir, cp, mv)
var obj = new _(self.opt.homedir + '/main.json', true);
if (obj.existsSync()) { ... }

// Node path module — used when `_()` is insufficient
const nodePath = require('path'); // renamed to avoid collision with local `path` var
nodePath.resolve(root, userPath);
```

**Rules:**
- Always use `_()` for framework-internal path construction
- Import `path` as `nodePath` in files where a local variable named `path` already exists
- Use `nodePath.resolve()` for security-sensitive path validation (CVE-2023-25345 pattern)
- Never concatenate user-supplied strings into file paths without a `nodePath.resolve()` boundary check

**Recommendation:**
Replace string concatenation paths with `nodePath.join()` in new code — more readable and avoids double-slash issues. The `_()` helper should remain the primary API but should internally use `path.join` instead of raw concatenation.

---

## 11. Logging

**Current practice:** Consistent and well-standardised.

```js
var console = lib.logger; // shadows Node's console — present in virtually every file

console.log('message');    // info-level
console.info('message');   // info-level
console.warn('message');   // warn-level
console.error('message');  // error-level
console.debug('message');  // debug-level (suppressed unless GINA_LOG_LEVEL=debug)
console.emerg('message');  // fatal/emergency
```

**Rules:**
- Always shadow `console` with `lib.logger` — never use `process.stdout.write()` directly in bundle code
- `console.debug()` for developer-only tracing (filtered by log level)
- `console.emerg()` for conditions that require immediate attention
- Bootstrap code (before logger is ready) may use `fs.writeSync(2, msg)` directly

**Recommendation:**
Introduce structured logging (#M12) as a future migration, not a replacement — the `%d [%s][%a] %m` template format will need to produce `{ ts, level, group, msg }` JSON when `GINA_LOG_STDOUT=true` is set.

---

## 12. Test Conventions

**Current practice:** `nodeunit` framework. Tests use `exports['test name'] = function(test) {}`. Files are numerically prefixed and named with `snake_case`.

```js
// Test structure
exports['[ find limit ] Hotel WHERE country === "France"'] = function(test) {
    test.equal(actual, expected, 'message');
    test.deepEqual(obj1, obj2);
    test.done(); // mandatory — hangs if omitted
}

// Setup
exports.setUp = function(done) {
    if (initialized) return done();
    initialized = true;
    // setup code
    done();
}
```

**Rules:**
- `test.done()` is mandatory at every exit path
- Test names use `[ category ] description` format for grouping
- Setup guards (`if (initialized) return done()`) prevent re-execution across test suites
- New unit tests go in `test/core/` with numeric prefix for ordering

**Recommendation:**
Migrate to `node:test` (built-in, Node 18+) for all new test files — `nodeunit` is unmaintained. Do not convert existing tests; add `node:test` tests alongside. The HTTP/2 client mock harness (#UT1) should use `node:test + node:assert` natively.

---

## 13. Git Commit Style

**Current practice:** Short imperative or gerund subject lines. Ticket references in subject or body. No AI references. No co-author footers.

```
Fixed ReferenceError: defIsoShort/defDate used across function boundary in init.js
Added SuperController.createTestInstance for controller unit testing (#R4)
Removed stale root core/ directory left over from pre-versioned framework layout
```

**Rules:**
- No AI tool references anywhere in commit messages or comments
- No `Co-Authored-By:` footers
- Ticket references: `(#ID)` at end of subject line, or inline in body
- Subject line: max ~72 characters
- Body: explain *why*, not *what* (the diff shows what)

---

## 14. File Headers

**Current practice:** Copyright block present in most files. `"use strict"` in ~40% of files. `@module` JSDoc in recently refactored files.

```js
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/core/config
 * @class Config
 * @constructor
 */
```

**Rules:**
- Copyright block is mandatory in all framework files
- `"use strict";` is required in all new files
- `@module` is required in all new files
- `@class` + `@constructor` on every constructor function

---

## 15. Version & Home Directory Schema

**Current practice:** Version strings use `0.MINOR.PATCH-STAGE.N` format (e.g., `0.1.8-alpha.1`). The "short version" is the first two components (`0.1`), used as the namespace key in `~/.gina/main.json` and the `~/.gina/0.1/` directory name.

```js
// Short version derivation in init.js
var shortVersion = version.split('.');
shortVersion.splice(2);
shortVersion = shortVersion.join('.');  // "0.1.8-alpha.1" → "0.1"
```

**Rules:**
- All `main.json` config keys are namespaced by short version: `main['def_culture']['0.1']`
- Incrementing the minor version (`0.1.x → 0.1.(x+1)`) keeps short version `"0.1"` — no migration
- Incrementing the middle version (`0.1.x → 0.2.0`) changes short version to `"0.2"` — **requires migration script**
- Patch releases within a minor version use `-pN` suffix: `0.1.8-p1`, `0.1.8-p2`

**Recommendation:**
All planned releases should stay in the `0.1.x` series (see roadmap) to avoid the home directory migration until a dedicated `gina framework:migrate` command is built. When a `0.2.0` release is eventually warranted, the migration script must: (1) copy all `"0.1"` keys to `"0.2"` in `main.json`, (2) create `~/.gina/0.2/` from `~/.gina/0.1/`, (3) update `projects.json` entries.

---

## 16. `whisper()` Substitution — `${variable}` Syntax and `reps` Completeness

**Background:** `helpers/context.js::whisper(dictionary, replaceable)` performs a single-pass `${variable}` substitution on JSON config objects. It was migrated from `{variable}` syntax to `${variable}` syntax.

**Critical rule — single-pass, no self-resolution:**
`whisper()` does **not** do multi-pass resolution. If `env.json` defines `bundlesPath` as `"${homedir}/bundles"`, and `bundlePath` as `"${bundlesPath}/${bundle}"`, whisper **cannot** derive `bundlePath` from `homedir` alone — both `homedir` AND `bundlesPath` must be in the `reps` dictionary at call time.

**Rule for every `getCoreEnv` / `whisper()` call site:**
> Pre-compute all derived values before building `reps`. The dictionary must contain every `${placeholder}` key that appears anywhere in the template being substituted, including keys whose values are themselves derived from other keys.

**Required keys for `lib/cmd/helper.js::getCoreEnv`** (covers `core/template/conf/env.json`):

| Key | Source |
| --- | --- |
| `frameworkDir` | `GINA_FRAMEWORK_DIR` |
| `executionPath` | `cmd.projects[name].path` |
| `projectPath` | `cmd.projects[name].path` |
| `projectName` | `cmd.projectName` |
| `homedir` | `cmd.projects[name].homedir` or `os.homedir() + '/.' + projectName` |
| `bundlesPath` | `cmd.projects[name].bundles_path` or `homedir + '/bundles'` |
| `cachePath` | `homedir + '/cache'` |
| `projectVersion` | `manifest.version` from `projectPath/manifest.json` |
| `projectVersionMajor` | `manifest.version.split('.')[0]` |
| `env` | `cmd.projects[name].def_env` |
| `bundle` | bundle argument |
| `version` | `GINA_VERSION` |

**Error message format:** When a key is missing, `context.js` logs `[Whisper Error]: The key ${varName} was not found`. If you see `{varName}` (without `$`) in logs, the error message itself has a formatting bug — report it and fix `context.js` line 743.

**Syntax migration note:** The old `{variable}` (without `$`) placeholder syntax is no longer supported as of a breaking change in `0.1.8`. Any template file still using `{variable}` will silently pass through substitution without replacement. Always use `${variable}`.

---

## 17. Comma-First Object Literals (JS only)

**Current practice:** Multi-line object and array literals use comma-first style with colon alignment. This applies to JavaScript source files only — JSON config files (`routing.json`, `settings.json`, `env.json`, etc.) use standard trailing-comma JSON syntax.

```js
// correct — comma-first with colon alignment
var note = {
    id        : store.nextId++
  , text      : text
  , createdAt : new Date().toISOString()
};

var options = {
    hostname : target.hostname
  , port     : target.port
  , path     : target.path
  , method   : 'GET'
  , headers  : headers
};

// also applies to arrays when elements are on separate lines
var bundles = [
    'api'
  , 'dashboard'
  , 'public'
];
```

**Rules:**
- First property on the opening `{` / `[` line (no leading comma)
- Subsequent properties prefixed with `, ` (comma + space) at the same indentation level as the first property's key, minus 2 characters
- Colons aligned with spaces (matching §7 alignment conventions)
- **JS only** — JSON files cannot use comma-first (JSON syntax requires trailing commas between values, and the last value must have no trailing comma)
- Do not mix comma-first and comma-last in the same file

**Why:**
- Cleaner diffs — adding or removing a property touches exactly one line
- Missing commas are immediately visible (they line up vertically)
- Aligns naturally with Gina's colon-alignment style

---

## Known Anti-Patterns

| Anti-pattern | Location | Risk | Roadmap item |
| --- | --- | --- | --- |
| Shared `local` closure on singleton controller | `controller.js` | Data corruption under concurrency | #M1 |
| `_arguments` buffer persists across concurrent calls | `entity.js` | Stale null results | #M2 |
| Error-as-value from `_.prototype.mkdirSync()` | `helpers/path.js`, ~25 call sites | Silent failures | — |
| Implicit globals injected by `gna.js` | Everywhere | Not statically analysable | #M8 |
| `typeof(x)` with parentheses | Everywhere | Style inconsistency | — |
| `"use strict"` absent from ~60% of files | Everywhere | Sloppy mode bugs | #M9 |
| `eval()` in install script | `script/pre_install.js:222` | Low-risk but code smell | — |
| Circular dep `utils/helper ↔ lib/logger` | `lib/index.js:32` | Import order fragility | — |
| Commented-out code preserved in large blocks | `context.js`, `controller.render-json.js` | Dead code maintenance burden | — |
| Incomplete `reps` dict in `getCoreEnv` | `lib/cmd/helper.js` | whisper silently leaves `${placeholder}` unresolved | — |

---

## Unit Tests — `node:test` Async Patterns

**Framework:** `node:test` (built-in, used throughout `test/`)

### Async tests must return a Promise or use `async function`

`node:test` does **not** support the Mocha-style `done` callback. If you write:

```js
it('name', function(_, done) {
    somePromise.then(function(val) {
        assert.equal(val, 'expected');
        done();   // ← done is undefined — this throws, but AFTER the test passes
    });
    // function returns undefined → test is marked passing immediately
});
```

The test appears to pass without executing the assertion. The `.then()` callback runs asynchronously after `node:test` has already closed the test. The `done()` call throws silently. **This is a silent false positive.**

**Correct patterns:**

```js
// Option A — async function (preferred)
it('name', async function() {
    var val = await somePromise;
    assert.equal(val, 'expected');
});

// Option B — return the Promise
it('name', function() {
    return somePromise.then(function(val) {
        assert.equal(val, 'expected');
    });
});

// Option C — assert.rejects for rejection tests
it('name', async function() {
    await assert.rejects(somePromise, expectedError);
});
```

**Rule**

> Every async `it()` block must either be declared `async` or explicitly `return` a Promise. Any test that calls an async API without doing either will silently pass without testing anything.
