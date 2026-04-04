# Inspector

Dev-mode SPA that surfaces per-request state, DOM/form inspection, database query instrumentation, and real-time log streaming.

**Formerly known as:** Toolbar (the RequireJS in-page panel) → Beemaster (first standalone SPA) → Inspector (current).

---

## History

| Era | Name | Architecture | Status |
|---|---|---|---|
| Original | Toolbar | RequireJS AMD module embedded in `gina.min.js`, rendered as an in-page panel | Legacy — source at `src/vendor/gina/toolbar/`, still bundled for `ginaToolbar` API |
| Phase 1 | Beemaster | Standalone SPA in `dist/vendor/gina/beemaster/`, opened via `window.open()` | Legacy — kept on disk for reference, do not modify |
| Phase 2 | Inspector | Standalone SPA in `dist/vendor/gina/inspector/`, opened via statusbar link | **Active** — canonical implementation |

The `bm-*` CSS class prefix throughout the Inspector is a cosmetic residue from the Beemaster era. No functional impact.

---

## Files

### Source (canonical — edit these)

| File | Role |
|---|---|
| `core/asset/plugin/src/vendor/gina/inspector/html/index.html` | SPA shell — tabs, toolbar, overlays, settings panel |
| `core/asset/plugin/src/vendor/gina/inspector/js/inspector.js` | All client-side logic (single IIFE, no external deps) |
| `core/asset/plugin/src/vendor/gina/inspector/sass/inspector.scss` | SCSS source — dark/light theme via `[data-theme]`, compiled to `css/inspector.css` |
| `core/asset/plugin/src/vendor/gina/inspector/css/inspector.css` | Compiled CSS (intermediate — generated from SCSS, committed to git) |
| `core/asset/plugin/src/vendor/gina/inspector/html/statusbar.html` | Injected into every HTML response in dev mode; provides the status bar UI, `ginaToolbar` shim, and localStorage bridge |

### Dist (output — built from src by `./build`)

| File | Role |
|---|---|
| `core/asset/plugin/dist/vendor/gina/inspector/index.html` | Served at `/_gina/inspector/` |
| `core/asset/plugin/dist/vendor/gina/inspector/inspector.js` | Served at `/_gina/inspector/inspector.js` |
| `core/asset/plugin/dist/vendor/gina/inspector/inspector.css` | Served at `/_gina/inspector/inspector.css` |
| `core/asset/plugin/dist/vendor/gina/html/statusbar.html` | Included by `controller.render-swig.js` |

The `./build` script compiles `sass/inspector.scss` to `css/inspector.css`, then copies `html/`, `js/`, and `css/` to the flat `dist/vendor/gina/inspector/` directory. No RequireJS, no Closure Compiler. Inspector SASS is excluded from Phase 2 auto-discovery — it is compiled in Phase 3 and served separately at `/_gina/inspector/inspector.css`, NOT concatenated into `gina.min.css`. Edit `src/`, run `./build` (or copy manually during development).

---

## Server-side Integration

### `/_gina/*` endpoints (dev mode only)

| Endpoint | Handler | Purpose |
|---|---|---|
| `GET /_gina/inspector/*` | `server.isaac.js:598` (fast-path) + `server.js:2281` (agnostic fallback) | Serves the Inspector SPA static files |
| `GET /_gina/logs` | `server.isaac.js:638` + `server.js:2309` | SSE stream of server-side log entries |

Both endpoints are guarded by `NODE_ENV_IS_DEV === 'true'` (Isaac uses the `isCacheless` boolean; Express `server.js` tests the env var directly).

**Endpoint sync rule:** Every `/_gina/*` handler in `server.isaac.js` must also work in `server.js`. See `CLAUDE.md § Gina /_gina/* built-in endpoint sync`. `server.express.js` has **no** Inspector endpoints currently — it delegates to `server.js` `onRequest()`.

### `displayToolbar` parameter

The legacy `displayToolbar` parameter flows through the render pipeline:

1. `server.js:3916` / `controller.js:4783` — sets `routeObj.param.displayToolbar = self.isCacheless()`
2. `controller.js:4427` — extracts from `req.routing.param.displayToolbar`, then deletes the param
3. `controller.js:4463` — passes to `self.render(data, displayToolbar, errOptions)`
4. `controller.render-swig.js:155` — receives as second argument, gates all dev-mode injection

### Statusbar injection (`controller.render-swig.js`)

When `displayToolbar` is truthy, `render-swig.js` appends three blocks before `</body>`:

1. **`__logsScript`** (line ~920) — creates `window.__ginaLogs = []` and wraps `console.log/info/warn/error/debug` to push `{ t, l, b, s }` objects into the array.
2. **`__gdScript`** (line ~910) — sets `window.__ginaData = { gina, user }` and saves the payload to `serverInstance._lastGinaData` (for engine.io push).
3. **`statusbar.html`** (line ~935) — injected via Swig `{%- include ... -%}`. Builds the status bar in a Shadow DOM element (`<div id="__gina-statusbar">`), opens the Inspector in a positioned popup window, and syncs `localStorage.__ginaData`.

The injection is wrapped in `{# Gina Toolbar #}` / `{# END Gina Toolbar #}` comment markers. `render-swig.js:957` checks for these markers to avoid double-injection on custom layouts.

### QI injection

`render-swig.js:894` injects the dev-mode query log (`_devQueryLog`) into `data.page.data.queries` before the `__ginaData` script is emitted. Entries from `process.gina._queryALS.getStore()` (the per-request AsyncLocalStorage) are copied into the page data.

### `ignored-by-toolbar` stripping

`render-swig.js:901-906` sets `data.page.data.scripts` and `data.page.data.stylesheets` to the string `'ignored-by-toolbar'` in the `__ginaData` payload to avoid sending bulky asset arrays to the Inspector. The Inspector's Data tab filters these out.

---

## Statusbar (`statusbar.html`)

The statusbar is a self-contained `<script>` block injected into every dev-mode HTML response. It:

1. Creates a Shadow DOM host (`<div id="__gina-statusbar">`) with a fixed-position bar at bottom-right
2. Displays `bundle@env` with a green/red health dot
3. Provides an "Inspector" link that opens the Inspector SPA in a popup window (right third of screen, full height)
4. Installs the `ginaToolbar` shim (see below)
5. Syncs `window.__ginaData` to `localStorage.__ginaData` for the Inspector's fallback channel

### `ginaToolbar` shim

`gina.min.js` (the RequireJS-bundled client runtime) tries to create `window.ginaToolbar = new GinaToolbar()` on `DOMContentLoaded`. The statusbar shim uses `Object.defineProperty` to lock the property:

- **getter** returns the shim object
- **setter** absorbs `gina.min.js`'s assignment, copying non-conflicting properties while preserving `update` and `restore`

This ensures the Inspector receives XHR overlay data from the validator plugin (40+ `ginaToolbar.update()` calls in `validator/src/main.js`) without the legacy toolbar class overwriting the bridge.

### `ginaToolbar` API

| Method | Called by | Effect |
|---|---|---|
| `update(section, data)` | `validator/src/main.js` (40+ calls), `events.js` (6 calls), `popin/main.js` (13 refs) | Merges section into `window.__ginaData.user`, syncs `localStorage.__ginaData` |
| `restore()` | `popin/main.js` (only `restore()` call site in the codebase) | Removes XHR overlays (`data-xhr`, `view-xhr`, `el-xhr`), restores original `data`/`view` |

**Three consumers:** validator (forms/XHR data), events.js (XHR response data), popin (dialog lifecycle including the only `restore()` call). All calls are guarded with `typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar` — skipped in prod where no shim exists.

**Sections:** `data-xhr`, `view-xhr`, `el-xhr`, `forms`

---

## `__ginaData` Payload Shape

```js
{
  gina: { ... },
  user: {
    environment : { bundle, env, webroot, ... },
    data        : { ... },           // controller action data
    view        : { ... },           // DOM/element state
    forms       : { ... },           // form state
    queries     : [ ... ],           // QI — database query log
    'data-xhr'  : { ... },           // XHR overlay (set by ginaToolbar.update())
    'view-xhr'  : { ... },
    'el-xhr'    : { ... }
  }
}
```

---

## Data Channels (Inspector SPA)

| Priority | Channel | Source |
|---|---|---|
| 1 | `window.opener.__ginaData` | Same-origin poll every `pollDataMs` (default 2 s) — always available when opened via statusbar link |
| 2 | `localStorage.__ginaData` | Fallback when opener is unavailable (direct URL, cross-tab) |
| 3 | engine.io socket | Real-time push — requires `ioServer` config; sends `{ type: 'ginaData', data }` messages |

---

## Log Channels

| Channel | Direction | How it works |
|---|---|---|
| `window.__ginaLogs` | Client → Inspector | Array filled by the console capture script; polled via `pollLogs()` from `window.opener` every 1 s |
| `/_gina/logs` SSE | Server → Inspector | `server.js`/`server.isaac.js` taps `process.on('logger#default', ...)`, strips ANSI codes, emits SSE `data:` frames |
| engine.io push | Server → Inspector | `ioServer` connection handler taps `logger#default`, sends `{ type: 'log', data }` messages |

### SSE endpoint details

The `/_gina/logs` handler:
- Maps syslog levels to Inspector levels (`emerg/alert/crit/err → error`, `warn/warning → warn`, `notice/info → info`, `debug → debug`, `catch/log → log`)
- Strips ANSI color codes from log messages
- Emits SSE `data:` frames with shape `{ t, l, b, s, src: 'server' }`
- The Inspector SSE URL is derived from the `/_gina/inspector/` path (`inspector.js:1775-1788`)

### Log entry shape

```js
{
  t   : 1712345678901,  // timestamp — ms since epoch
  l   : 'info',         // level string
  b   : 'dashboard',    // bundle name
  s   : 'message text', // content (ANSI stripped for server entries)
  src : 'server'        // present only for server-side entries
}
```

**Client levels:** `error | warn | info | log | debug`

**Server syslog levels (raw):** `emerg | alert | crit | err | warning | notice | info | debug | catch`

### Level mapping

| Raw level | CSS class suffix |
|---|---|
| `emerg / alert / crit / err` | `error` |
| `warning` | `warn` |
| `notice` | `info` |
| `catch` | `log` |
| anything else | same as raw |

`LEVEL_EQUIV` groups synonyms for the level filter (`error` matches `err`, `warn` matches `warning`).

---

## Tabs

| Tab | ID | Content |
|---|---|---|
| Data | `#tab-data` | JSON tree of `__ginaData.user` (excluding `scripts`, `stylesheets`). Foldable, searchable by dot-path, raw JSON mode, download. |
| View | `#tab-view` | DOM / element state — properties, HTML attributes, styles. Page metrics badges (engine, weight, load time, FCP). |
| Forms | `#tab-forms` | Form field values and validation state. |
| Query | `#tab-query` | Database query instrumentation — see [QI section](#query-instrumentation-qi) below. |
| Logs | `#tab-logs` | Combined client + server log stream — see [Logs tab](#logs-tab) below. |

---

## View Tab — Page Metrics Badges

The View tab header displays performance badges when data is available:

| Badge | CSS class | Data source | Display |
|---|---|---|---|
| Engine | `bm-vbadge-engine` | Template engine detection from view/env data | Engine name (e.g., `swig`) |
| Weight | `bm-vbadge-weight` | `transferSize` / `encodedBodySize` / `decodedBodySize` from Performance API | Dual `resource|transfer` when sizes differ, single value otherwise |
| Time | `bm-vbadge-load` | `loadEventEnd` (page) or `duration` (XHR) for load; `responseEnd - requestStart` (page) or `responseEnd - responseStart` (XHR) for transfer | Dual `load|transfer` when times differ, single value otherwise |
| FCP | `bm-vbadge-fcp` | `first-contentful-paint` from Performance API | Time in ms |

The dual badges use `bm-vbadge-res` (dimmed first value) and `bm-vbadge-sep` (pipe separator) classes.

---

## Logs Tab

### Toolbar controls
- Source filter (`#bm-log-source`) — All / Client / Server; persisted in `localStorage.__gina_inspector_log_source`
- Level filter (`#bm-log-level`) — options rebuilt by `updateLevelDropdown()` based on source; persisted in `localStorage.__gina_inspector_log_level`
- Search input (`#bm-log-search`) — free-text filter against `e.s`; highlights matches with `<mark class="bm-log-hl">`
- Pause / Resume button — stops new entries from being appended to the list
- Clear button — empties `logs[]`, resets `logsOff`, clears selection, clears the log-dot indicator

### Selection HUD

A floating HUD (`bm-log-sel-hud`) in the top-right of the log list contains:

- **Info button** (`bm-log-help-btn`) — visible when < 2 rows selected; toggles a popover (`bm-log-help-pop`) showing keyboard shortcuts
- **Dual badge** (`bm-log-sel-badge`) — visible when >= 2 rows selected; contains Cancel (clears selection) and Copy N (copies selected)

### Row selection

Each log entry has a stable `_id` (auto-incremented `_logIdCounter`). Every rendered `<div class="bm-log">` carries `data-lid="{_id}"`.

| Gesture | Effect |
|---|---|
| Click | Copy that single row (green flash + checkmark feedback) |
| Shift+click | Range-select from last clicked to here |
| Ctrl / Cmd+click | Toggle individual row |
| Escape | Deselect all |
| Ctrl / Cmd+C | Copy all selected (when logs tab active, focus not in an input) |

Selection state: `Set<number> selectedLogIds`. `updateSelectionUI()` manages badge/info button visibility. `copySelectedLogs()` iterates `logs[]` directly (not the DOM) — filtered-out entries are still copied if selected, output is chronological.

### Rendering

`scheduleRender()` coalesces rapid `renderLogs()` calls (SSE, engine.io) into a single 150 ms repaint. User-initiated actions (filter change, clear, search) call `renderLogs()` directly. When `renderLogs()` replaces `list.innerHTML`, `bm-log-selected` classes are embedded in the HTML string (via `selectedLogIds.has(e._id)`), so selection survives re-renders without a separate DOM pass.

### Log-dot indicator

`#bm-log-dot` — shows the highest severity received since the last clear. Animated heartbeat when active. CSS classes: `debug | info | warn | error`.

---

## Query Instrumentation (QI)

Full QI architecture is documented in `.claude/architecture/index.md § Inspector § Query Instrumentation (QI)`.

### Summary

- **Per-request isolation:** `process.gina._queryALS` (AsyncLocalStorage, created once in `controller.js`) binds a query log array to each async context via `enterWith()`
- **Connector interception:** Couchbase connector's N1QL execution path (`core/connectors/couchbase/index.js`) pushes entries to the ALS-bound `_devQueryLog`
- **JSON sidecar:** `render-json.js` embeds `__ginaQueries` in JSON responses (dev mode only)
- **Cross-bundle merge:** `controller.js` `query()` success callback extracts and merges `__ginaQueries` from upstream bundle responses, then deletes the field before returning data to the action

### Query entry shape

```js
{
  type        : 'N1QL',          // query type
  trigger     : 'invoice#save',  // entity#method
  statement   : 'SELECT ...',    // N1QL statement
  params      : ['val1'],        // positional parameters
  durationMs  : 12,              // execution time
  resultCount : 5,               // rows returned
  error       : null,            // error message if failed
  source      : 'server',
  origin      : 'dashboard',     // bundle name
  connector   : 'couchbase'      // connector name
}
```

### Inspector Query UI

- **Split trigger badge** — `entity#method` rendered as two joined halves (`.bm-trigger-entity` + `.bm-trigger-method`)
- **SQL syntax highlighting** — keywords (blue), functions (purple), placeholders `$1`/`$2` (gold), string literals (green)
- **Params table** — two columns: Param (`$1`, `$2`) and Value (color-coded by type)
- **Search bar** — free-text filter across all query fields
- **Badge order** in header: type (N1QL) → connector (couchbase) → origin (dashboard) → spacer → trigger → timing

---

## localStorage Keys

| Key | Purpose |
|---|---|
| `__gina_inspector_folds` | Fold state for tree views (per-tab, per-path) |
| `__gina_inspector_theme` | Light / dark theme preference |
| `__gina_inspector_tab` | Last active tab |
| `__gina_inspector_log_source` | Source filter value |
| `__gina_inspector_log_level` | Level filter value |
| `__gina_inspector_poll_interval` | Data poll interval in ms (default 2000) |
| `__gina_inspector_settings_open` | Whether the settings panel is expanded |
| `__gina_inspector_auto_expand` | Whether all tree nodes are auto-expanded |

---

## CSS Architecture

- Theme variables defined on `[data-theme="dark"]` and `[data-theme="light"]`; applied via `applyTheme()` at startup
- All class names prefixed `bm-` (legacy from Beemaster rename — cosmetic only, no functional impact)
- `#tab-logs.active` uses `display: flex` (column) to let `#bm-log-list` fill remaining height
- `.bm-log` has `user-select: none` and `cursor: pointer` to support row selection UX

### CSS gotchas

- **Native `<select>` ignores `line-height`** on macOS — use explicit `padding` for height, not `line-height`
- Keep `--sans` font for `<select>` dropdowns, `--mono` for text inputs — keep their CSS rules separate
- DOM re-render from search input: when `innerHTML` replacement causes focus loss, manually `.focus()` and restore `selectionStart`/`selectionEnd`

---

## Test File

**Location:** `test/core/inspector.test.js` (renamed from `beemaster.test.js`)

| Section | What it tests |
|---|---|
| 01 | Inspector handler existence in `server.js` |
| 02 | `/_gina/inspector` URL pattern matching (14 cases) |
| 03 | Inspector path extraction |
| 04 | MIME type resolution for inspector files |
| 05 | Inspector SPA file existence |
| 06 | Dev-mode guard |
| 10 | Query tab rendering (CSS classes, structure) |
| 11 | `/_gina/logs` SSE handler in `server.js` |
| 12 | `/_gina/logs` SSE handler in `server.isaac.js` |
| 13 | `/_gina/logs` URL pattern matching |
| 14 | CSS toolbar styles for query tab |
| 17 | Inspector SPA SSE client and source filter |

---

## Codebase Reference Map

All files that contain Inspector/Toolbar-related code:

### Server-side (Node.js)

| File | What |
|---|---|
| `core/server.js:2281-2340` | `/_gina/inspector/*` handler + `/_gina/logs` SSE handler (engine-agnostic) |
| `core/server.js:3916` | Sets `routeObj.param.displayToolbar` |
| `core/server.isaac.js:598-690` | `/_gina/inspector/*` fast-path + `/_gina/logs` SSE (Isaac engine) |
| `core/server.isaac.js:1165` | Legacy "Beemaster: respond to data pull request" comment |
| `core/server.isaac.js:1177` | Inspector broadcast via engine.io |
| `core/controller/controller.js:961-1019` | `render()` and `renderWithoutLayout()` with `displayToolbar` param |
| `core/controller/controller.js:3534` | Inspector comment in coreapi query context |
| `core/controller/controller.js:4427-4463` | `displayToolbar` extraction from routing params |
| `core/controller/controller.render-swig.js:142-155` | `displayToolbar` param, function signature |
| `core/controller/controller.render-swig.js:448` | `localOptions.debugMode` from `displayToolbar` |
| `core/controller/controller.render-swig.js:894-936` | QI injection, `__ginaData`/`__ginaLogs` scripts, statusbar include |
| `core/controller/controller.render-swig.js:957-960` | Toolbar guard regex (`{# Gina Toolbar #}`) |
| `core/controller/controller.render-swig.js:1134,1142` | Toolbar TODOs |
| `core/controller/controller.render-v1.js:19-23` | Legacy render path with `displayToolbar` |
| `core/controller/controller.render-v1.js:588-605` | Legacy `{# Gina Toolbar #}` block with `toolbar.html` include |
| `core/controller/controller.render-json.js:212` | Inspector comment for `__ginaQueries` |

### Client-side (browser)

| File | What |
|---|---|
| `dist/vendor/gina/inspector/inspector.js` | Inspector SPA — all client logic |
| `dist/vendor/gina/inspector/inspector.css` | Inspector SPA — all styles |
| `dist/vendor/gina/inspector/index.html` | Inspector SPA — shell |
| `dist/vendor/gina/html/statusbar.html` | Dev-mode statusbar + `ginaToolbar` shim |
| `dist/vendor/gina/html/toolbar.html` | Legacy toolbar HTML (240 lines, `gina-toolbar-*` classes) |
| `dist/vendor/gina/beemaster/` | Legacy Beemaster SPA (3 files) |
| `dist/vendor/gina/js/gina.js` | Unminified bundle — `ginaToolbar.update()` calls, `__ginaData` refs |
| `src/vendor/gina/toolbar/main.js` | Legacy `Toolbar()` class source (AMD module) |
| `src/vendor/gina/toolbar/css/toolbar.css` | Legacy toolbar styles (582 lines, `gina-toolbar*` prefix) |
| `src/vendor/gina/toolbar/html/toolbar.html` | Legacy toolbar template source |
| `core/plugins/lib/validator/src/main.js` | 40+ `ginaToolbar.update()` calls for forms/XHR data |
| `core/plugins/lib/validator/src/form-validator.js:1702` | "open inspector" debug comment |

### Config / Build

| File | What |
|---|---|
| `src/vendor/gina/build.json:31` | `"gina/toolbar"` RequireJS path |
| `src/vendor/gina/build.dev.json:30` | `"gina/toolbar"` RequireJS path |
| `lib/cmd/port/inc/scan.js:97` | Port 4101 reserved for Beemaster/Inspector |

### Tests

| File | What |
|---|---|
| `test/core/inspector.test.js` | Canonical test file (renamed from `beemaster.test.js`) |

### Documentation

| File | What |
|---|---|
| `.claude/plugins/index.md` | Plugin overview (references this file) |
| `.claude/architecture/index.md:232-305` | Inspector architecture (QI, SSE, localStorage, CSS gotchas) |
| `.claude/services.md:40-80` | Planned `services/src/inspector/` standalone bundle |
| `.claude/roadmap.md` | Inspector roadmap items #INS1-#INS14 |
| `ROADMAP.md:248-306` | Public Inspector roadmap |
| `CHANGELOG.md` | Beemaster Phase 2 changelog |
| `.changes/0.3.0-alpha.1.md` | Beemaster Phase 2 description |
| `llms.txt:455-565` | Inspector section |
| `CONTRIBUTING.md:85` | "debug toolbar" mention |

---

## Open Issues

### Legacy name residue

- `bm-*` CSS class prefix throughout the Inspector (cosmetic, ~hundreds of occurrences)
- `displayToolbar` parameter name in the render pipeline (`controller.js`, `render-swig.js`, `render-v1.js`)
- `{# Gina Toolbar #}` comment markers in template injection
- `server.isaac.js:1165` "Beemaster" comment
- `scan.js:97` "Beemaster" port comment

These are functional no-ops but may cause confusion when reading the code. A bulk rename would touch many files and tests.

### `server.express.js` gap

`server.express.js` has **zero** Inspector endpoints. It relies on `server.js` `onRequest()` for the agnostic fallback. This is correct but should be documented — the Express adapter does not need its own fast-path because Express request handling already goes through `server.js`.

### Legacy toolbar in `render-v1.js`

`controller.render-v1.js` still includes `toolbar.html` (not `statusbar.html`) via Swig. This is the v1 render path — if any bundle still uses v1 templates, it gets the legacy toolbar instead of the Inspector statusbar.

### Source directory structure (#INS14) — completed 2026-04-04

The Inspector source now follows the same type-based subdirectory convention as other plugins:

```text
src/vendor/gina/inspector/
├── html/
│   ├── index.html          SPA shell
│   └── statusbar.html      Server-side include (copied to dist/vendor/gina/html/)
├── css/
│   └── inspector.css       Compiled CSS (intermediate — generated from SCSS, committed to git)
├── js/
│   └── inspector.js        All client-side logic (single IIFE)
└── sass/
    └── inspector.scss      SCSS source — dark/light theme via CSS custom properties, SCSS nesting
```

**Key design decisions:**
- **`.scss` (not `.sass`)** — the original CSS used brace syntax; `.scss` is a superset of CSS, making the conversion 1:1. Other plugins use `.sass` (indented syntax) because they were written that way from scratch.
- **Inspector is excluded from Phase 2 auto-discovery.** The build script skips `inspector/` during the plugin scan that concatenates CSS into `gina.min.css`. Inspector SCSS is compiled in Phase 3 instead, and the output is served separately at `/_gina/inspector/inspector.css`.
- **`css/inspector.css` is committed to git** — same convention as `toolbar/css/toolbar.css` and `popin/css/popin.css`. It is the intermediate build output that `./build` Phase 3 copies to dist.
- **No `main.js`** — that name implies an AMD module bundled into `gina.min.js` via RequireJS.
- **No `svg-src/` yet** — all icons are inline SVG in `index.html`. `svg-src/` is a natural next step when the Inspector gets custom icons.
- **Dist layout remains flat** — `dist/vendor/gina/inspector/` contains `index.html`, `inspector.js`, `inspector.css` at the root. The build script maps subdirectory sources to flat dist output.
