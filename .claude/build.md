# Build System (Frontend Plugin)

**Location:** `core/asset/plugin/`
**Script:** `core/asset/plugin/build` (bash)
**CLI:** `gina build` or `gina framework:build` (online command — requires framework socket on port 8124)
**README:** `core/asset/plugin/README.md` (stale, last updated 2016 — `.claude/build.md` is the current reference)

---

## `src/` vs `dist/`

`src/` is where source files are authored and edited. `dist/` is the runtime directory — the files the framework actually reads and serves at runtime. The `./build` script transforms or copies `src/` into `dist/`.

Some plugins go through a full build pipeline that produces different output than the source (SASS compiled to CSS, RequireJS concatenation, Closure Compiler minification). Others (like the Inspector) are straight copies with no transformation. Either way, **`src/` is the canonical source — edit `src/`, never edit `dist/` directly**.

`dist/` files are **committed to git intentionally** — npm installers consume them without running a build step. This means `dist/` must always be in sync with `src/` before a publish.

---

## CLI Entry Point

**File:** `lib/cmd/framework/build.js`

`gina build` (alias `gina framework:build`) is currently classified as an online command (requires `gina start` for the framework socket on port 8124), but the handler only runs `execSync` on the bash script — no bundle state, routing, or runtime context is used. It could be an offline command. It calls the bash build script via `execSync`, passing through any CLI arguments:

```javascript
var bashScript = _(GINA_CORE + '/asset/plugin/build', true);
if (Array.isArray(argv) && argv.length > 0) {
    bashScript += " " + argv.join(" ");
}
console.log(execSync(bashScript).toString());
```

**Usage:**

```bash
gina framework:build --scope=<scope> --env=<env>   # full form
gina build --env=dev                                # dev build (no minification)
gina build                                          # production build
```

`--scope` sets the target scope context at the CLI level. `--env` is forwarded to the bash script and controls minification/source maps. All other arguments are forwarded directly to the bash script.

---

## External Dependencies

| Tool | Install | Used for |
|---|---|---|
| `sass` | `npm install -g sass` | SCSS/SASS → CSS compilation |
| `csso` | `npm install -g csso@2.2.1` | CSS minification |
| `r.js` | `npm install -g requirejs` | RequireJS module bundling |
| `java >= 8` | System install | Runs Google Closure Compiler |
| `brotli` | `brew install brotli` | `.br` compression |
| `gzip` | System (usually pre-installed) | `.gz` compression |

All tool binary paths can be overridden:

```bash
./build --sass-bin=/path/to/sass --java-bin=/path/to/java
```

**Closure Compiler JARs** are not in git. Run once before building:

```bash
bash core/asset/plugin/lib/js/install-closure-compiler.sh
```

Downloads from Maven Central:
- `closure-compiler-v20160619.jar` (Java 7+)
- `closure-compiler-v20220104.jar` (Java 8+) — active via `compiler.jar` symlink

---

## Build Phases

The bash script runs 8 phases sequentially. `--env=dev` affects phases 2, 4, 5, and 8.

### Phase 1 — Dependency check (lines 59–102)

Verifies all 6 external tools are installed. Exits with error if any are missing.

### Phase 2 — SASS compilation + CSS packaging (lines 105–229)

The script **auto-discovers** plugins by scanning `src/vendor/` for subdirectories that contain a `sass/` folder. Currently finds `toolbar`, `popin`, and `inspector` — but **`inspector` is explicitly skipped** (its SASS is compiled in Phase 3 instead, and its CSS is served separately at `/_gina/inspector/inspector.css`, NOT concatenated into `gina.min.css`).

For each discovered plugin (except `inspector`):
1. Copies `html/` templates from `src/` to `dist/vendor/gina/html/` (this is how `toolbar/html/toolbar.html` ends up in `dist/html/`)
2. Compiles every `.sass`/`.scss` file in the plugin's `sass/` dir → `css/` dir (intermediate, stays in `src/`)
3. Collects the CSS file whose name matches the plugin directory name (e.g. `toolbar/css/toolbar.css` from `toolbar/`, `popin/css/popin.css` from `popin/`)

After scanning all plugins:
- **Prod:** concatenates collected CSS files with `cat` and pipes through `csso` → `dist/vendor/gina/css/gina.min.css`
- **Dev:** concatenates without minification → `dist/vendor/gina/css/gina.min.css` (no source map)

**Plugin discovery rule:** a directory under `src/vendor/gina/` is treated as a build-pipeline plugin **only if it has a `sass/` subdirectory AND is not `inspector`**. Directories without `sass/` (like `utils/`, `helpers/`) are ignored by this phase.

### Phase 3 — Inspector build (lines 231–280)

Compiles Inspector SCSS, then copies from type-based subdirectories to flat dist:
1. `sass/inspector.scss` → `css/inspector.css` (intermediate, stays in src/)
2. `html/index.html` → `dist/vendor/gina/inspector/index.html`
3. `js/inspector.js` → `dist/vendor/gina/inspector/inspector.js`
4. `css/inspector.css` → `dist/vendor/gina/inspector/inspector.css`
5. `html/statusbar.html` → `dist/vendor/gina/html/statusbar.html` (server-side include)

### Phase 4 — RequireJS bundling (lines 249–265)

Bundles all AMD modules into a single concatenated JS file:

```bash
r.js -o src/vendor/gina/build.json       # prod
r.js -o src/vendor/gina/build.dev.json   # dev
```

- Entry module: `core` (`src/vendor/gina/core.js`)
- Output: `dist/vendor/gina/js/gina.js` (prod) or `dist/vendor/gina/js/gina.min.js` (dev — no Closure Compiler, so this IS the final output)
- Includes RequireJS itself (`"include": ["requireLib"]`)
- Pulls in all plugins (`popin`, `link`, `validator`, `storage`), utilities, helpers, and external libs (`uuid`, `engine.io`, `merge`, `routing`, `collection`, `domain`, `inherits`, `form-validator`)
- `optimize: "none"` — RequireJS does NOT minify; that's Closure Compiler's job

### Phase 5 — Closure Compiler: main JS (lines 268–276)

**Prod only** (skipped in dev):

```bash
java -jar lib/js/compiler.jar \
  --compilation_level SIMPLE_OPTIMIZATIONS \
  --js dist/vendor/gina/js/gina.js \
  --js_output_file dist/vendor/gina/js/gina.min.js
```

`SIMPLE_OPTIMIZATIONS` renames local variables but preserves the public API. `ADVANCED_OPTIMIZATIONS` was attempted but breaks RequireJS module names.

### Phase 6 — Closure Compiler: loader (lines 279–288)

The loader (`src/vendor/gina/utils/loader.js`) is built **separately** from the main bundle:

- **Prod:** Closure Compiler with `ADVANCED_OPTIMIZATIONS` → `dist/vendor/gina/js/gina.onload.min.js`
- **Dev:** simple `cp` to `dist/vendor/gina/js/gina.onload.min.js`

`ADVANCED_OPTIMIZATIONS` is safe here because the loader is self-contained (no AMD module names to preserve).

### Phase 7 — Swig compilation (lines 290–317)

Compiles the vendored Swig template engine for client-side use:

```bash
java -jar lib/js/compiler.jar \
  --compilation_level SIMPLE_OPTIMIZATIONS \
  --js core/deps/swig-1.4.2/bin/swig.js \
  --js_output_file core/deps/swig-1.4.2/dist/swig.min.js
```

Also creates symlinks in `core/deps/swig-1.4.2/docs/js/` pointing to the source and minified versions. Previous `.map` and build artifacts are cleaned before each run.

### Phase 8 — Compression + cleanup (lines 320–371)

Generates `.br` (Brotli) and `.gz` (Gzip) compressed variants for all dist assets:

| Target | Files compressed |
|---|---|
| `dist/vendor/gina/css/` | `*.css` |
| `dist/vendor/gina/js/` | `*.min.js` |
| `dist/vendor/gina/html/` | `*.html` |
| `lib/domain/dist/` | `*_list.dat` (domain suffix lists) |

**Prod only:** removes all `*.map` (source map) files from `dist/`.

**`gzip -n` is required** — all `gzip` calls use `-n` (no-name, no-timestamp). Without it, each build run embeds a different timestamp in the `.gz` header, producing a binary diff every time even when source is unchanged. This blocks `git checkout` in `prepare_version.js`. Never remove the `-n` flag. `brotli` is deterministic by default and needs no equivalent flag.

---

## Dev vs Prod

| Aspect | `--env=dev` | Default (prod) |
|---|---|---|
| SASS compilation | `--no-source-map` | With source maps |
| CSS minification | Skipped (plain `cat` concatenation) | `csso` minification + source map |
| RequireJS output | `gina.min.js` (direct output, no Closure step) | `gina.js` (intermediate) |
| Closure Compiler: main | Skipped | `SIMPLE_OPTIMIZATIONS` → `gina.min.js` |
| Closure Compiler: loader | Skipped (`cp` instead) | `ADVANCED_OPTIMIZATIONS` |
| Source maps | Kept | Removed at end |
| Inspector copy | Same | Same |
| Compression | Same | Same |

---

## What the Build Produces

```
dist/vendor/gina/
├── css/
│   ├── gina.min.css          Concatenated CSS (popin + toolbar styles)
│   ├── gina.min.css.br
│   └── gina.min.css.gz
├── js/
│   ├── gina.js               RequireJS bundle (unminified, prod intermediate)
│   ├── gina.min.js            Closure Compiler output (prod) or RequireJS output (dev)
│   ├── gina.min.js.br
│   ├── gina.min.js.gz
│   ├── gina.onload.min.js    Loader (Closure ADVANCED prod, plain copy dev)
│   ├── gina.onload.min.js.br
│   └── gina.onload.min.js.gz
├── html/
│   ├── statusbar.html         Copied from src/vendor/gina/inspector/
│   ├── toolbar.html           Copied from src/vendor/gina/toolbar/html/
│   ├── toolbar.html.br
│   └── toolbar.html.gz
├── inspector/
│   ├── index.html             Copied from src/vendor/gina/inspector/
│   ├── inspector.js
│   └── inspector.css
└── beemaster/                 Legacy (dist-only, not produced by build)
```

Also produced outside of `dist/`:
- `core/deps/swig-1.4.2/dist/swig.min.js` — client-side Swig
- `lib/domain/dist/*.dat.br`, `*.dat.gz` — compressed domain suffix lists
