# Plugins

Frontend assets, dev-mode tooling, and client-side components bundled with Gina.

This is the **source of truth** for everything related to Gina plugins. Each plugin has its own detail page linked below.

---

## Plugins vs Services

Gina has two extension mechanisms: **plugins** and **services**. They serve different purposes and run in fundamentally different ways.

| | Plugins | Services |
|---|---|---|
| **Location** | `core/asset/plugin/` (inside the framework package) | `services/src/` (project-level, gitignored) |
| **Runtime** | Client-side (browser) or built-in endpoints served by the bundle's own process | Standalone Gina bundles running as separate processes |
| **Install** | Shipped with `npm install gina` — always available | Created via `gina project:add @gina` + `gina bundle:add <name> @gina` |
| **Build** | `./build` script (SASS, RequireJS, Closure Compiler) or hand-authored in `dist/` | Standard Gina bundle build (`gina bundle:build`) |
| **Port** | No dedicated port — served on the bundle's own port via `/_gina/*` endpoints | Dedicated ports (4100+ range) |
| **Scope** | Per-bundle — every running bundle serves its own plugin assets | Per-project — one service instance shared across bundles |
| **Dev mode** | Most plugins are dev-mode only (guarded by `NODE_ENV_IS_DEV`) | Always running (dev and prod) |
| **Examples** | Inspector, Popin, Link, Toolbar (legacy), Validator (client-side) | Proxy (port 4100), Inspector standalone (port 4101, planned) |

**Key distinction:** Plugins are embedded inside the framework and activate automatically when a bundle starts. Services are independent Gina bundles that must be explicitly started and configured. A plugin can evolve into a service when it needs its own process, port, or cross-bundle scope (e.g., the Inspector is currently a plugin but has a planned standalone service mode at `services/src/inspector/`).

Services documentation: `.claude/services.md`

---

## Plugin Index

| Plugin | Status | Detail page |
|---|---|---|
| [Inspector](#inspector) | Active | [inspector.md](./inspector.md) |
| [Popin](#popin) | Active | (inline below) |
| [Link](#link) | Active | (inline below) |
| [Toolbar](#toolbar-legacy) | Legacy | (inline below — replaced by Inspector) |
| [Beemaster](#beemaster-legacy) | Legacy | (inline below — predecessor to Inspector) |

---

## Build System

**Location:** `core/asset/plugin/`
**Script:** `./build` (or `./build --env=dev`)
**Detailed docs:** `.claude/build.md`

### `src/` vs `dist/`

`src/` is where source files are authored. `dist/` is the runtime directory — the files the framework reads and serves. The `./build` script transforms or copies `src/` into `dist/`. Some plugins go through a full build pipeline (SASS → CSS, RequireJS → bundle, Closure Compiler → minified JS); others (Inspector) are straight copies. Either way, **edit `src/`, never `dist/`**. Dist files are committed to git so npm installers work without a build step.

### Build pipeline summary

```
src/vendor/gina/**/*.sass/.scss
  --> sass compiler --> src/vendor/gina/**/css/*.css (intermediate)
  --> cat + csso --> dist/vendor/gina/css/gina.min.css

src/vendor/gina/**/*.js (core.js entry point)
  --> r.js (RequireJS optimizer) --> dist/vendor/gina/js/gina.js
  --> Closure Compiler (SIMPLE) --> dist/vendor/gina/js/gina.min.js
  --> brotli + gzip --> .br + .gz variants

src/vendor/gina/utils/loader.js (built separately)
  --> Closure Compiler (ADVANCED) --> dist/vendor/gina/js/gina.onload.min.js

src/vendor/gina/toolbar/html/toolbar.html
  --> cp --> dist/vendor/gina/html/toolbar.html
```

**SCSS-compiled + copy (Inspector — Phase 3):**
- `src/vendor/gina/inspector/sass/inspector.scss` → compiled to `css/inspector.css` → `dist/vendor/gina/inspector/inspector.css`
- `src/vendor/gina/inspector/html/index.html` → `dist/vendor/gina/inspector/index.html`
- `src/vendor/gina/inspector/js/inspector.js` → `dist/vendor/gina/inspector/inspector.js`
- `src/vendor/gina/inspector/html/statusbar.html` → `dist/vendor/gina/html/statusbar.html` — Statusbar (dist path unchanged for `render-swig.js`)

**Legacy (dist-only, no source in src/):**
- `dist/vendor/gina/beemaster/` — Beemaster SPA (predecessor to Inspector, do not modify)

### Dist file manifest

| Asset | Role |
|---|---|
| `css/gina.min.css` (+`.br`, +`.gz`) | Compiled SCSS — popin + toolbar (legacy) styles |
| `js/gina.min.js` (+`.br`, +`.gz`) | Main frontend runtime (RequireJS + jQuery + all plugins) |
| `js/gina.onload.min.js` (+`.br`, +`.gz`) | Lightweight onload-only variant |
| `html/statusbar.html` | Dev-mode status bar — injected into every HTML response |
| `html/toolbar.html` (+`.br`, +`.gz`) | Legacy toolbar HTML (replaced by statusbar.html) |
| `inspector/` | Inspector SPA — see [inspector.md](./inspector.md) |
| `beemaster/` | Legacy predecessor to Inspector — do not modify |

---

## Inspector

Dev-mode SPA that surfaces per-request state, DOM/form inspection, database query instrumentation, and real-time log streaming. Formerly known as "Beemaster", then "Toolbar".

**Full documentation:** [inspector.md](./inspector.md)

---

## Popin

Client-side dialog/modal component bundled into `gina.min.js`.

**Source:** `src/vendor/gina/popin/`

| File | Role |
|---|---|
| `popin/main.js` | AMD module — popin lifecycle (open, close, XHR content loading) |
| `popin/sass/popin.sass` | Main styles (compiled to `popin/css/popin.css`) |
| `popin/sass/config.sass` | Variable definitions |
| `popin/sass/design.sass` | Visual design layer |
| `popin/sass/helper.scss` | CSS helper classes |
| `popin/doc/` | Component documentation (TOC, CSS, HTML, JS, FAQ, extend, usage) |

The popin module is included in `gina.min.js` via RequireJS (`build.json` path: `"gina/popin"`). Its CSS is concatenated into `gina.min.css`.

---

## Link

XHR-powered `<a>` element handler — intercepts link clicks to load content via AJAX instead of full page navigation.

**Source:** `src/vendor/gina/link/main.js`

Bundled into `gina.min.js` via RequireJS (`build.json` path: `"gina/link"`).

---

## Toolbar (legacy)

**Status:** Legacy — replaced by Inspector + Statusbar in dev mode.

**Source:** `src/vendor/gina/toolbar/`

| File | Role |
|---|---|
| `toolbar/main.js` | AMD module — `Toolbar()` class with `ginaToolbar` API |
| `toolbar/sass/toolbar.sass` | Styles (compiled to `toolbar/css/toolbar.css`) |
| `toolbar/html/toolbar.html` | Template (copied to `dist/vendor/gina/html/toolbar.html`) |
| `toolbar/svg-src/` | 14 SVG icon sources |
| `toolbar/mock.gina.json`, `toolbar/mock.user.json` | Mock data for standalone development |
| `toolbar/js/jquery-3.1.0.min.js` | jQuery copy for toolbar standalone testing |

The toolbar module is still bundled into `gina.min.js` because the `ginaToolbar.update()` / `ginaToolbar.restore()` API is consumed by `validator/src/main.js` (40+ call sites) and the main `gina.js` bundle for XHR overlay updates (`data-xhr`, `view-xhr`, `forms`). The `statusbar.html` shim intercepts these calls and bridges them to the Inspector via `localStorage.__ginaData`.

**`controller.render-v1.js`** still references `toolbar.html` via Swig include — this is the legacy render path (v1 templates). The current render path (`controller.render-swig.js`) uses `statusbar.html`.

### `ginaToolbar` API (still active via shim)

| Method | Called by | Effect |
|---|---|---|
| `ginaToolbar.update(section, data)` | `validator/src/main.js`, `gina.js` | Merges XHR data into `window.__ginaData.user` and syncs `localStorage.__ginaData` |
| `ginaToolbar.restore()` | `gina.js` | Removes XHR overlays, restores original `data`/`view` |

---

## Beemaster (legacy)

**Status:** Legacy — predecessor to Inspector. Kept on disk for reference only.

**Location:** `dist/vendor/gina/beemaster/` (no source in `src/`)

| File | Role |
|---|---|
| `beemaster/index.html` | SPA shell (simpler than Inspector — no search, no theme toggle, no scroll nav) |
| `beemaster/beemaster.js` | Client logic (same data polling architecture as Inspector) |
| `beemaster/beemaster.css` | Styles (same `bm-` prefix that the Inspector inherited) |

The test file was renamed from `test/core/beemaster.test.js` to `test/core/inspector.test.js`. All `bm-*` CSS class names in the Inspector are a cosmetic residue of this lineage.

**Do not add new features to the Beemaster files.** The Inspector is the canonical implementation.

---

## Utility Modules (bundled into `gina.min.js`)

| Module | Source | Role |
|---|---|---|
| `dom` | `src/vendor/gina/utils/dom.js` | DOM helper functions |
| `effects` | `src/vendor/gina/utils/effects.js` | fadeIn / fadeOut animations |
| `events` | `src/vendor/gina/utils/events.js` | Event system — register, trigger, listen, XHR handling |
| `loader` | `src/vendor/gina/utils/loader.js` | `onGinaLoaded` callback (built separately with ADVANCED optimisation) |
| `polyfill` | `src/vendor/gina/utils/polyfill.js` | `Object.assign`, `JSON.clone`, `JSON.escape` polyfills |
| `binding` | `src/vendor/gina/helpers/binding.js` | Binding helper for processing callback arrays |

---

## Source Directory Layout

```text
core/asset/plugin/
├── build                           Build script (bash)
├── README.md
├── uuid.json                       RequireJS config for uuid
├── lib/js/
│   ├── README.md
│   └── install-closure-compiler.sh Closure Compiler download script
├── src/vendor/
│   ├── gina/
│   │   ├── build.json              RequireJS build config (production)
│   │   ├── build.dev.json          RequireJS build config (dev)
│   │   ├── core.js                 Entry point (requires all modules)
│   │   ├── main.js                 Main AMD module
│   │   ├── helpers/binding.js
│   │   ├── inspector/              Inspector SPA source (SCSS compiled, then copied to dist)
│   │   │   ├── html/index.html
│   │   │   ├── html/statusbar.html → copied to dist/vendor/gina/html/ (server-side include)
│   │   │   ├── js/inspector.js
│   │   │   ├── sass/inspector.scss SCSS source (compiled to css/inspector.css)
│   │   │   └── css/inspector.css   Compiled CSS (intermediate, committed to git)
│   │   ├── link/main.js
│   │   ├── popin/                  Popin plugin (sass/, css/, doc/, main.js)
│   │   ├── toolbar/                Legacy toolbar (sass/, css/, html/, svg-src/, main.js)
│   │   └── utils/                  dom.js, effects.js, events.js, loader.js, polyfill.js
│   └── jquery/                     jQuery builds (1.x, 2.x, 3.x slim)
└── dist/vendor/gina/
    ├── css/gina.min.css            Built from src SASS
    ├── js/gina.min.js              Built from src JS
    ├── js/gina.onload.min.js       Built from loader.js
    ├── html/statusbar.html         Copied from src
    ├── html/toolbar.html           Copied from src (legacy)
    ├── inspector/                  Copied from src
    └── beemaster/                  Legacy SPA (dist-only, no source)
```
