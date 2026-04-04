/**
 * @file Inspector SPA client — dev-mode diagnostic panel for Gina bundles.
 *
 * Single IIFE, no external dependencies, no build step. Served at
 * `{webroot}/_gina/inspector/` on the same origin as the monitored bundle.
 *
 * **Data channels** (in priority order):
 *   1. `window.opener.__ginaData`  — same-origin polling (always available
 *      when opened via the statusbar link)
 *   2. `localStorage.__ginaData`   — fallback when opener is unavailable
 *      (direct URL, cross-tab)
 *   3. engine.io socket            — real-time streaming (requires ioServer config)
 *
 * **Log channels:**
 *   - Client-side: `window.opener.__ginaLogs` (array filled by the framework's
 *     console capture script injected in dev mode)
 *   - Server-side SSE: `/_gina/logs` (taps `process.on('logger#default')`;
 *     dev mode only)
 *   - Server-side engine.io: `{ type: 'log' }` WebSocket messages (requires
 *     ioServer config)
 *
 * **Tabs:** Data, View, Forms, Query, Logs
 *
 * @see .claude/plugins/inspector.md — full architecture documentation
 *
 * @typedef {Object} LogEntry
 * @property {number}  t    - Timestamp (ms since epoch)
 * @property {string}  l    - Level string (error|warn|info|log|debug for client;
 *                            syslog names for server)
 * @property {string}  b    - Bundle name
 * @property {string}  s    - Message text (ANSI stripped for server entries)
 * @property {string}  [src] - `'server'` for server-side entries; absent for client
 * @property {number}  [_id] - Auto-incremented stable ID (assigned on ingest)
 *
 * @typedef {Object} QueryEntry
 * @property {string}  type        - Query type (e.g. `'N1QL'`)
 * @property {string}  trigger     - `entity#method` (e.g. `'invoice#save'`)
 * @property {string}  statement   - N1QL/SQL statement
 * @property {Array}   params      - Positional parameters
 * @property {number}  durationMs  - Execution time in ms
 * @property {number}  resultCount - Rows returned
 * @property {number}  [resultSize] - Result size in bytes
 * @property {?string} error       - Error message if failed
 * @property {string}  source      - `'server'`
 * @property {string}  origin      - Bundle name
 * @property {string}  connector   - Connector name (e.g. `'couchbase'`)
 *
 * @typedef {Object} PageMetrics
 * @property {?number} weight       - Transfer size in bytes
 * @property {?number} resourceSize - Decoded body size in bytes
 * @property {?number} loadMs       - Total load time in ms
 * @property {?number} transferMs   - Document transfer time in ms
 * @property {?number} fcpMs        - First Contentful Paint in ms
 * @property {string}  source       - `'page'` or `'xhr'`
 */
(function () {
    'use strict';

    // ── Constants ──────────────────────────────────────────────────────────
    /** @type {number} Data poll interval in ms — adjustable via Settings panel */
    var pollDataMs  = 2000;
    /** @constant {number} Log poll interval in ms */
    var POLL_LOGS_MS = 1000;
    /** @constant {number} Maximum retained log entries before oldest are dropped */
    var MAX_LOG_ENTRIES = 1000;
    /** @constant {string} localStorage key — fold state for tree views */
    var FOLD_STORAGE_KEY   = '__gina_inspector_folds';
    /** @constant {string} localStorage key — light/dark theme preference */
    var THEME_STORAGE_KEY  = '__gina_inspector_theme';
    /** @constant {string} localStorage key — last active tab */
    var TAB_STORAGE_KEY    = '__gina_inspector_tab';
    /** @constant {string} localStorage key — source filter (All/Client/Server) */
    var SOURCE_STORAGE_KEY = '__gina_inspector_log_source';
    /** @constant {string} localStorage key — level filter */
    var LEVEL_STORAGE_KEY  = '__gina_inspector_log_level';
    /** @constant {string} localStorage key — data poll interval override */
    var POLL_STORAGE_KEY     = '__gina_inspector_poll_interval';
    /** @constant {string} localStorage key — settings panel open/closed state */
    var SETTINGS_STORAGE_KEY = '__gina_inspector_settings_open';
    /** @constant {string} localStorage key — auto-expand tree nodes toggle */
    var EXPAND_STORAGE_KEY   = '__gina_inspector_auto_expand';

    /** @constant {RegExp} Matches UUID v4 strings */
    var RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    /** @constant {RegExp} Matches HTTP/HTTPS URLs */
    var RE_URL  = /^https?:\/\//i;

    /** @constant {Object} Keys to skip when rendering the View tab */
    var VIEW_SKIP = { scripts: 1, stylesheets: 1 };
    /** @constant {Object} Keys whose children are recursively flattened into PROPERTIES */
    var VIEW_FLATTEN = { html: 1, properties: 1 };

    // ── State ──────────────────────────────────────────────────────────────
    /** @type {?Window|string} Data source — `Window` (opener), `'localStorage'`, or `null` */
    var source  = null;
    /** @type {?Object} Latest parsed `__ginaData` payload */
    var ginaData = null;
    /** @type {LogEntry[]} In-memory log buffer (capped at {@link MAX_LOG_ENTRIES}) */
    var logs    = [];
    /** @type {number} Read offset into `source.__ginaLogs` for client-side polling */
    var logsOff = 0;
    /** @type {boolean} When true, new log entries are not appended */
    var paused  = false;
    /** @type {string} JSON.stringify of last processed ginaData — for change detection */
    var lastGdStr = '';
    /** @type {boolean} When true, Data tab renders raw JSON instead of a tree */
    var rawMode = false;
    /** @type {string} Highest severity level received since last clear (drives log-dot) */
    var highestLogLevel = '';
    /** @type {?number} Interval ID for the data polling timer */
    var pollDataTimer = null;
    /** @type {boolean} When true, all tree nodes are auto-expanded on render */
    var autoExpand = false;
    /** @type {?number} Timeout ID for the coalesced log render timer */
    var _renderTimer = null;

    // ── Log row selection ──────────────────────────────────────────────────
    /** @type {Set<number>} IDs of currently selected log rows */
    var selectedLogIds = new Set();
    /** @type {number} Last clicked log row ID (for Shift+click range selection) */
    var lastClickedLid = -1;
    /** @type {number} Auto-incrementing counter for stable log entry IDs */
    var _logIdCounter  = 0;

    // ── DOM helpers ────────────────────────────────────────────────────────

    /**
     * Query selector shorthand.
     * @inner
     * @param {string} sel - CSS selector
     * @param {Element|Document} [ctx=document] - Context element to search within
     * @returns {?Element} First matching element or null
     * @example
     *   qs('#bm-label')                 // document.querySelector('#bm-label')
     *   qs('.bm-tab', panelEl)          // panelEl.querySelector('.bm-tab')
     */
    function qs(sel, ctx)  { return (ctx || document).querySelector(sel); }

    /**
     * Query selector all shorthand — returns a real Array (not NodeList).
     * @inner
     * @param {string} sel - CSS selector
     * @param {Element|Document} [ctx=document] - Context element to search within
     * @returns {Element[]} All matching elements
     * @example
     *   qsa('.bm-tab').forEach(function (t) { t.classList.remove('active'); });
     */
    function qsa(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

    /**
     * Escape a string for safe insertion into HTML.
     * @inner
     * @param {*} s - Value to escape (coerced to string)
     * @returns {string} HTML-safe string with `&`, `<`, `>`, `"` escaped
     * @example
     *   escHtml('<script>alert(1)</script>')
     *   // '&lt;script&gt;alert(1)&lt;/script&gt;'
     */
    function escHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Escape a string for use inside a RegExp constructor.
     * @inner
     * @param {string} s - Literal string to escape
     * @returns {string} String with all regex special characters escaped
     * @example
     *   new RegExp('(' + escRegex(userInput) + ')', 'gi')
     */
    function escRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ── Theme management ──────────────────────────────────────────────────

    /**
     * Resolve the preferred theme: persisted value > OS preference > dark default.
     * @inner
     * @returns {string} `'light'` or `'dark'`
     */
    function getPreferredTheme() {
        var stored = null;
        try { stored = localStorage.getItem(THEME_STORAGE_KEY); } catch (e) {}
        if (stored === 'light' || stored === 'dark') return stored;
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
        return 'dark';
    }

    /**
     * Apply a theme to the document and persist the choice.
     * Sets `data-theme` attribute on `<html>` — CSS custom properties
     * switch all colors via `[data-theme="dark"]` / `[data-theme="light"]`.
     * @inner
     * @param {string} theme - `'light'` or `'dark'`
     */
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (e) {}
        var cb = qs('#bm-theme-cb');
        if (cb) cb.checked = (theme === 'light');
    }

    // ── Loader ────────────────────────────────────────────────────────────
    /** @type {number} Timestamp when the loader spinner was last shown */
    var loaderShownAt = 0;
    /** @type {?number} Timeout ID for the delayed hide */
    var loaderHideTimer = null;
    /** @constant {number} Minimum display time for the loader to avoid flickering */
    var MIN_LOADER_MS = 250;

    /**
     * Show the loading spinner overlay.
     * @inner
     */
    function showLoader() {
        if (loaderHideTimer) { clearTimeout(loaderHideTimer); loaderHideTimer = null; }
        var l = qs('#bm-loader');
        if (l) l.classList.remove('hidden');
        loaderShownAt = Date.now();
    }

    /**
     * Hide the loading spinner. Defers hiding if the spinner has been visible
     * for less than {@link MIN_LOADER_MS} to avoid visual flickering.
     * @inner
     */
    function hideLoader() {
        var elapsed = Date.now() - loaderShownAt;
        var remaining = MIN_LOADER_MS - elapsed;
        if (remaining > 0) {
            if (!loaderHideTimer) {
                loaderHideTimer = setTimeout(function () {
                    loaderHideTimer = null;
                    var l = qs('#bm-loader');
                    if (l) l.classList.add('hidden');
                }, remaining);
            }
            return;
        }
        if (loaderHideTimer) { clearTimeout(loaderHideTimer); loaderHideTimer = null; }
        var l = qs('#bm-loader');
        if (l) l.classList.add('hidden');
    }

    // ── Fold state persistence ────────────────────────────────────────────

    /**
     * Load the fold state store from localStorage.
     * @inner
     * @returns {Object} Map of `{ tabName: { dotPath: boolean } }` entries
     */
    function loadFoldStore() {
        try {
            var raw = localStorage.getItem(FOLD_STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    /**
     * Persist the fold state store to localStorage.
     * @inner
     * @param {Object} store - Map of `{ tabName: { dotPath: boolean } }`
     */
    function saveFoldStore(store) {
        try { localStorage.setItem(FOLD_STORAGE_KEY, JSON.stringify(store)); } catch (e) {}
    }

    /**
     * Snapshot the open/closed state of all `<details>` elements in a tab's
     * scroll area and persist it to the fold store.
     * @inner
     * @param {string} tabName - Tab identifier (e.g. `'data'`, `'view'`, `'forms'`)
     */
    function captureFoldState(tabName) {
        var panel = qs('#tab-' + tabName + ' .bm-scroll-area');
        if (!panel) return;
        var store = loadFoldStore();
        if (!store[tabName]) store[tabName] = {};
        var details = panel.querySelectorAll('details[data-path]');
        for (var i = 0; i < details.length; i++) {
            store[tabName][details[i].dataset.path] = details[i].open;
        }
        saveFoldStore(store);
    }

    /**
     * Restore the open/closed state of `<details>` elements from the fold store.
     * @inner
     * @param {string} tabName - Tab identifier
     */
    function restoreFoldState(tabName) {
        var store = loadFoldStore();
        var tabStore = store[tabName];
        if (!tabStore) return;
        var panel = qs('#tab-' + tabName + ' .bm-scroll-area');
        if (!panel) return;
        var details = panel.querySelectorAll('details[data-path]');
        for (var i = 0; i < details.length; i++) {
            var path = details[i].dataset.path;
            if (typeof tabStore[path] !== 'undefined') {
                details[i].open = tabStore[path];
            }
        }
    }

    // ── Flatten leaves helper (recursive) ─────────────────────────────────

    /**
     * Recursively extract all leaf (non-object) values from a nested object,
     * collapsing the hierarchy into a single flat object. Used by the View tab
     * to merge `html` and `properties` sub-objects into the PROPERTIES section.
     * @inner
     * @param {Object} obj - Source object to flatten
     * @param {Object} [result={}] - Accumulator (pass `{}` on first call)
     * @returns {Object} Flat map of `{ leafKey: leafValue }`
     * @example
     *   flattenLeaves({ html: { title: 'Home', meta: { charset: 'utf-8' } } })
     *   // { title: 'Home', charset: 'utf-8' }
     */
    function flattenLeaves(obj, result) {
        if (!obj || typeof obj !== 'object') return result;
        result = result || {};
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            var v = obj[keys[i]];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                flattenLeaves(v, result);
            } else {
                result[keys[i]] = v;
            }
        }
        return result;
    }

    // ── JSON tree renderer ─────────────────────────────────────────────────

    /**
     * Recursively render a JSON value as a foldable HTML tree.
     *
     * Produces nested `<details>/<summary>` elements for objects and arrays,
     * with `<ul class="bm-tree">` lists for children. Leaf values are rendered
     * as `<span>` elements with type-specific CSS classes (`bm-str`, `bm-num`,
     * `bm-bool`, `bm-null`, `bm-link`). UUIDs and URLs get the `bm-link` class.
     *
     * When `ginaVal` is provided and differs from `val` at a leaf, the original
     * gina value is rendered as a struck-through "overridden" row above the
     * current value (used to show XHR overlay diffs in the Data tab).
     *
     * @inner
     * @param {*} val - Value to render
     * @param {number} [depth=0] - Current nesting depth (controls auto-expand)
     * @param {string|number} [label] - Key or index label for the node
     * @param {string} [labelClass='bm-key'] - CSS class for the label span
     * @param {*} [ginaVal] - Corresponding value from `ginaData.gina` (for diff)
     * @param {string} [path=''] - Dot-path to this node (used for fold persistence)
     * @returns {string} HTML string
     */
    function renderTree(val, depth, label, labelClass, ginaVal, path) {
        depth = depth || 0;
        path = path || '';
        var labelHtml = '';
        if (typeof label !== 'undefined' && label !== null) {
            labelHtml = '<span class="' + (labelClass || 'bm-key') + '">' + escHtml(label) + '</span> ';
        }

        if (val === null || val === undefined) {
            return '<span class="bm-null">null</span>';
        }
        if (typeof val === 'boolean') {
            return '<span class="bm-bool bm-copyable" title="Click to copy">' + val + '</span>';
        }
        if (typeof val === 'number') {
            return '<span class="bm-num bm-copyable" title="Click to copy">' + val + '</span>';
        }
        if (typeof val === 'string') {
            return renderStringValue(val);
        }
        if (Array.isArray(val)) {
            var ginaArr = Array.isArray(ginaVal) ? ginaVal : null;
            var nodePath = (label !== null && typeof label !== 'undefined')
                ? (path ? path + '.' + label : String(label))
                : path;
            var emptyClass = val.length === 0 ? ' is-empty' : '';
            var isOpen = autoExpand || depth < 2;
            var h = '<details data-path="' + escHtml(nodePath) + '"' + (isOpen ? ' open' : '') + '>'
                + '<summary class="bm-summary' + emptyClass + '">'
                + labelHtml
                + '<span class="bm-bracket">[</span>'
                + '<span class="bm-count">' + val.length + '</span>'
                + '<span class="bm-bracket">]</span>'
                + '</summary>';
            if (val.length > 0) {
                h += '<ul class="bm-tree">';
                for (var i = 0; i < val.length; i++) {
                    var ginaChild = ginaArr ? ginaArr[i] : undefined;
                    h += '<li>';
                    if (typeof val[i] === 'object' && val[i] !== null) {
                        h += renderTree(val[i], depth + 1, i, 'bm-index', ginaChild, nodePath);
                    } else {
                        h += '<span class="bm-index">' + i + '</span><span class="bm-colon">:</span> ' + renderTree(val[i], depth + 1, null, null, ginaChild);
                    }
                    h += '</li>';
                }
                h += '</ul>';
            }
            return h + '</details>';
        }
        if (typeof val === 'object') {
            var ginaObj = (ginaVal && typeof ginaVal === 'object' && !Array.isArray(ginaVal)) ? ginaVal : null;
            var keys = Object.keys(val);
            keys.sort();

            if (depth === 0) {
                var h = '<ul class="bm-tree bm-root">';
                for (var ki = 0; ki < keys.length; ki++) {
                    var k = keys[ki];
                    var child = val[k];
                    var ginaChild = ginaObj ? ginaObj[k] : undefined;
                    if (typeof child === 'object' && child !== null) {
                        h += '<li>' + renderTree(child, depth + 1, k, 'bm-key', ginaChild, '') + '</li>';
                    } else {
                        h += renderLeafKV(k, child, ginaObj, depth);
                    }
                }
                h += '</ul>';
                return h;
            }

            var nodePath = (label !== null && typeof label !== 'undefined')
                ? (path ? path + '.' + label : String(label))
                : path;
            var emptyClass = keys.length === 0 ? ' is-empty' : '';
            var isOpen = autoExpand || depth < 2;
            var h = '<details data-path="' + escHtml(nodePath) + '"' + (isOpen ? ' open' : '') + '>'
                + '<summary class="bm-summary' + emptyClass + '">'
                + labelHtml
                + '<span class="bm-bracket">{</span> '
                + '<span class="bm-bracket">}</span>'
                + '</summary>';
            if (keys.length > 0) {
                h += '<ul class="bm-tree">';
                for (var ki = 0; ki < keys.length; ki++) {
                    var k = keys[ki];
                    var child = val[k];
                    var ginaChild = ginaObj ? ginaObj[k] : undefined;
                    if (typeof child === 'object' && child !== null) {
                        h += '<li>' + renderTree(child, depth + 1, k, 'bm-key', ginaChild, nodePath) + '</li>';
                    } else {
                        h += renderLeafKV(k, child, ginaObj, depth);
                    }
                }
                h += '</ul>';
            }
            return h + '</details>';
        }
        return '<span class="bm-str bm-copyable" title="Click to copy">' + escHtml(String(val)) + '</span>';
    }

    /**
     * Render a leaf key-value pair, optionally showing the overridden gina value.
     * @inner
     * @param {string} key - Property name
     * @param {*} val - Current value
     * @param {?Object} ginaObj - Parent object from `ginaData.gina` (for diff)
     * @param {number} depth - Current nesting depth
     * @returns {string} HTML `<li>` element(s)
     */
    function renderLeafKV(key, val, ginaObj, depth) {
        var h = '';
        if (ginaObj && typeof ginaObj[key] !== 'undefined' && ginaObj[key] !== val) {
            h += '<li class="bm-kv bm-overridden">'
                + '<span class="bm-key">' + escHtml(key) + '</span>'
                + '<span class="bm-colon">:</span> '
                + renderTree(ginaObj[key], depth + 1)
                + '</li>';
        }
        h += '<li class="bm-kv">'
            + '<span class="bm-key">' + escHtml(key) + '</span>'
            + '<span class="bm-colon">:</span> '
            + renderTree(val, depth + 1)
            + '</li>';
        return h;
    }

    /**
     * Render a string value with type-appropriate styling.
     * UUIDs and URLs are rendered with the `bm-link` class.
     * @inner
     * @param {string} val - String value to render
     * @returns {string} HTML `<span>` element
     */
    function renderStringValue(val) {
        var escaped = escHtml(val);
        if (RE_URL.test(val)) {
            return '<span class="bm-link bm-copyable" title="Click to copy">' + escaped + '</span>';
        }
        if (RE_UUID.test(val)) {
            return '<span class="bm-link bm-copyable" title="Click to copy">' + escaped + '</span>';
        }
        return '<span class="bm-str bm-copyable" title="Click to copy">' + escaped + '</span>';
    }

    // ── Section renderer ──────────────────────────────────────────────────

    /**
     * Render a named section with an `<h2>` title and a JSON tree body.
     * @inner
     * @param {string} name - Section heading text
     * @param {*} data - Data to render as a tree
     * @param {*} [ginaData] - Corresponding gina data (for diff overlay)
     * @returns {string} HTML string
     */
    function renderSection(name, data, ginaData) {
        return '<div class="bm-section">'
            + '<h2 class="bm-section-title">' + escHtml(name) + '</h2>'
            + renderTree(data, 0, null, null, ginaData)
            + '</div>';
    }

    // ── Data weight badge ──────────────────────────────────────────────────

    /**
     * Render a weight badge showing the JSON payload size for the Data tab.
     * @inner
     * @param {*} data - Data object to measure
     * @returns {string} HTML string (empty if data is not an object)
     */
    function renderDataBadge(data) {
        if (!data || typeof data !== 'object') return '';
        try {
            var json = JSON.stringify(data);
            var size = new Blob([json]).size;
            return '<div class="bm-view-badges">'
                + '<span class="bm-vbadge bm-vbadge-weight" title="Data payload size (JSON)">'
                + '<svg viewBox="0 0 16 16"><path d="M3.5 1h9l2.5 14H1zM4.8 2.5h6.4l2 11H2.8z"/></svg>'
                + formatBytes(size) + '</span></div>';
        } catch (e) { return ''; }
    }

    // ── Root extras (_comment + scalars) ──────────────────────────────────

    /**
     * Render root-level extras: the `_comment` banner and all scalar (non-object)
     * root keys as a flat key-value list above the collapsible tree sections.
     * @inner
     * @param {Object} data - Root data object
     * @returns {string} HTML string
     */
    function renderRootExtras(data) {
        if (!data || typeof data !== 'object') return '';
        var h = '';
        if (typeof data._comment === 'string' && data._comment) {
            h += '<div class="bm-comment-banner">' + escHtml(data._comment) + '</div>';
        }
        var keys = Object.keys(data);
        var rootScalars = [];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k === '_comment') continue;
            if (typeof data[k] !== 'object' || data[k] === null) rootScalars.push(k);
        }
        if (rootScalars.length > 0) {
            rootScalars.sort();
            h += '<ul class="bm-tree bm-root">';
            for (var j = 0; j < rootScalars.length; j++) {
                var sk = rootScalars[j];
                h += '<li class="bm-kv">'
                    + '<span class="bm-key">' + escHtml(sk) + '</span>'
                    + '<span class="bm-colon">:</span> '
                    + renderTree(data[sk], 1)
                    + '</li>';
            }
            h += '</ul>';
        }
        return h;
    }

    /**
     * Render the object-valued root keys of the data payload as collapsible
     * tree sections. Scalar keys and `_comment` are excluded (handled by
     * {@link renderRootExtras}).
     * @inner
     * @param {Object} data - Root data object
     * @param {Object} [ginaData] - Corresponding gina data (for diff overlay)
     * @returns {string} HTML string
     */
    function renderDataTree(data, ginaData) {
        if (!data || typeof data !== 'object') return '';
        var keys = Object.keys(data);
        keys.sort();
        var h = '<ul class="bm-tree bm-root">';
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k === '_comment') continue;
            var v = data[k];
            if (typeof v !== 'object' || v === null) continue;
            var ginaChild = ginaData ? ginaData[k] : undefined;
            h += '<li>' + renderTree(v, 1, k, 'bm-key', ginaChild, '') + '</li>';
        }
        h += '</ul>';
        return h;
    }

    // ── Engine badge ──────────────────────────────────────────────────────

    /**
     * Detect the template engine name from view data.
     * Inspects `view.layout` path and `view.ext` to distinguish between
     * template engines. Does NOT use `env.engine` (that is the HTTP server
     * engine — isaac/express — not the template engine).
     * @inner
     * @param {Object} view - View data from `__ginaData.user.view`
     * @param {Object} env - Environment data from `__ginaData.user.environment`
     * @returns {string} Template engine name (e.g. `'Swig'`, `'Nunjucks'`)
     */
    function detectEngine(view, env) {
        // Detect the TEMPLATE engine, not the HTTP engine.
        // env.engine is the HTTP server engine (isaac/express) — do not use it here.
        // The template engine is determined by the view layout path or file extension.

        // Try to detect from view.layout path (e.g. "swig/html/default")
        if (view && typeof view.layout === 'string') {
            if (/swig[\/\\]/i.test(view.layout)) return 'Swig';
            if (/nunjucks[\/\\]|njk[\/\\]/i.test(view.layout)) return 'Nunjucks';
        }
        // Try from view.ext
        if (view && typeof view.ext === 'string') {
            if (view.ext === '.njk') return 'Nunjucks';
            if (view.ext === '.html') return 'Swig';
        }
        // Default: render-swig.js handles all current rendering
        return 'Swig';
    }

    // ── Page metrics (weight, load time, paint time) ───────────────────────

    /**
     * Format a millisecond value for display.
     * @inner
     * @param {number} ms - Duration in milliseconds
     * @returns {string} `'X.XX s'` if >= 1000, otherwise `'N ms'`
     * @example
     *   fmtMs(42)    // '42 ms'
     *   fmtMs(1500)  // '1.50 s'
     */
    function fmtMs(ms) {
        if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
        return ms + ' ms';
    }

    /**
     * Collect page performance metrics from the opener window's Performance API.
     *
     * For full page loads, reads Navigation Timing Level 2 entries.
     * For XHR views (popin/dialog), reads the latest `xmlhttprequest`/`fetch`
     * resource entry. Falls back to `document.outerHTML` blob size when
     * `transferSize` is unavailable (e.g. cross-origin without CORS headers).
     *
     * @inner
     * @param {boolean} isXhr - `true` if the current view is an XHR overlay
     * @returns {PageMetrics} Metrics object (all numeric fields may be `null`)
     */
    function getPageMetrics(isXhr) {
        var m = { weight: null, resourceSize: null, loadMs: null, transferMs: null, fcpMs: null, source: 'page' };
        try {
            var win = (source && source !== 'localStorage') ? source : null;
            if (!win || !win.performance) return m;
            var perf = win.performance;

            if (isXhr) {
                // XHR view (popin/dialog) — use the latest XHR resource entry
                m.source = 'xhr';
                var resources = perf.getEntriesByType ? perf.getEntriesByType('resource') : [];
                var xhrEntry = null;
                for (var r = resources.length - 1; r >= 0; r--) {
                    var entry = resources[r];
                    if (entry.initiatorType === 'xmlhttprequest' || entry.initiatorType === 'fetch') {
                        xhrEntry = entry;
                        break;
                    }
                }
                if (xhrEntry) {
                    m.loadMs = Math.round(xhrEntry.duration);
                    if (xhrEntry.responseEnd > 0 && xhrEntry.responseStart > 0) {
                        m.transferMs = Math.round(xhrEntry.responseEnd - xhrEntry.responseStart);
                    }
                    if (xhrEntry.transferSize > 0) {
                        m.weight = xhrEntry.transferSize;
                    } else if (xhrEntry.encodedBodySize > 0) {
                        m.weight = xhrEntry.encodedBodySize;
                    }
                    if (xhrEntry.decodedBodySize > 0) {
                        m.resourceSize = xhrEntry.decodedBodySize;
                    }
                }
                // FCP not applicable for XHR views
                return m;
            }

            // Full page — Navigation Timing Level 2
            var navEntries = perf.getEntriesByType ? perf.getEntriesByType('navigation') : [];
            if (navEntries.length > 0 && navEntries[0].transferSize > 0) {
                m.weight = navEntries[0].transferSize;
            } else if (navEntries.length > 0 && navEntries[0].encodedBodySize > 0) {
                m.weight = navEntries[0].encodedBodySize;
            }
            if (navEntries.length > 0 && navEntries[0].decodedBodySize > 0) {
                m.resourceSize = navEntries[0].decodedBodySize;
            }
            // Fallback: estimate from DOM size
            if (!m.weight) {
                try {
                    var html = win.document.documentElement.outerHTML;
                    if (html) m.weight = new Blob([html]).size;
                } catch (e) {}
            }

            // Full page load time (navigationStart → loadEventEnd)
            if (perf.timing && perf.timing.loadEventEnd > 0 && perf.timing.navigationStart > 0) {
                m.loadMs = perf.timing.loadEventEnd - perf.timing.navigationStart;
            } else if (navEntries.length > 0 && navEntries[0].loadEventEnd > 0) {
                m.loadMs = Math.round(navEntries[0].loadEventEnd - navEntries[0].startTime);
            }
            // Document transfer time (requestStart → responseEnd)
            if (perf.timing && perf.timing.responseEnd > 0 && perf.timing.requestStart > 0) {
                m.transferMs = perf.timing.responseEnd - perf.timing.requestStart;
            } else if (navEntries.length > 0 && navEntries[0].responseEnd > 0 && navEntries[0].requestStart > 0) {
                m.transferMs = Math.round(navEntries[0].responseEnd - navEntries[0].requestStart);
            }

            // First Contentful Paint
            var paintEntries = perf.getEntriesByType ? perf.getEntriesByType('paint') : [];
            for (var i = 0; i < paintEntries.length; i++) {
                if (paintEntries[i].name === 'first-contentful-paint') {
                    m.fcpMs = Math.round(paintEntries[i].startTime);
                    break;
                }
            }
        } catch (e) {}
        return m;
    }

    /**
     * Format a byte count into a human-readable string (B, KB, or MB).
     * @inner
     * @param {number} bytes - Size in bytes
     * @returns {string} Formatted string (e.g. `'12.5 KB'`)
     */
    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(2) + ' MB';
    }

    /**
     * Split a byte count into a numeric part and unit for dual-badge rendering.
     * @inner
     * @param {number} bytes - Size in bytes
     * @returns {{num: string, unit: string}} Numeric string and unit label
     * @example
     *   splitBytes(5120)  // { num: '5.0', unit: 'KB' }
     */
    function splitBytes(bytes) {
        if (bytes < 1024) return { num: String(bytes), unit: 'B' };
        if (bytes < 1048576) return { num: (bytes / 1024).toFixed(1), unit: 'KB' };
        return { num: (bytes / 1048576).toFixed(2), unit: 'MB' };
    }

    // ── View tab — sectioned layout ───────────────────────────────────────

    /**
     * Render the View tab content: engine badge, page metrics badges,
     * params sections, flattened PROPERTIES section, and remaining object
     * sections (locale, assets, etc.).
     *
     * Keys in {@link VIEW_SKIP} are excluded. Keys in {@link VIEW_FLATTEN}
     * have their leaf values merged into the PROPERTIES section.
     *
     * @inner
     * @param {Object} view - View data from `__ginaData.user.view`
     * @param {Object} [ginaView] - Gina view data (for diff overlay)
     * @returns {string} HTML string
     */
    function renderViewContent(view, ginaView) {
        view = view || {};
        ginaView = ginaView || {};
        var keys = Object.keys(view);
        keys.sort();

        var objectSections = [];
        var propKeys = {};
        var ginaPropKeys = {};
        var paramsSection = null;

        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (VIEW_SKIP[k]) continue;

            var v = view[k];
            if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
                if (VIEW_FLATTEN[k]) {
                    // Recursively extract leaf values and merge into PROPERTIES
                    var leaves = flattenLeaves(v);
                    var ginaLeaves = ginaView[k] ? flattenLeaves(ginaView[k]) : {};
                    var lk = Object.keys(leaves);
                    for (var li = 0; li < lk.length; li++) {
                        propKeys[lk[li]] = leaves[lk[li]];
                        ginaPropKeys[lk[li]] = ginaLeaves[lk[li]];
                    }
                    continue;
                }
                var sec = { name: k, data: v, gina: ginaView[k] };
                if (k === 'params' || k.indexOf('params') === 0) {
                    if (!paramsSection) paramsSection = [];
                    paramsSection.push(sec);
                } else {
                    objectSections.push(sec);
                }
            } else {
                propKeys[k] = v;
                ginaPropKeys[k] = ginaView[k];
            }
        }

        var h = '';

        // Engine + metrics badges (floating right row)
        var env = (ginaData && ginaData.user && ginaData.user.environment) || {};
        var engine = detectEngine(view, env);
        var u = ginaData && ginaData.user ? ginaData.user : {};
        var isXhr = typeof u['view-xhr'] !== 'undefined';
        var metrics = getPageMetrics(isXhr);
        var hasBadges = engine || metrics.weight || metrics.loadMs || metrics.transferMs || metrics.fcpMs;
        if (hasBadges) {
            h += '<div class="bm-view-badges">';
            if (engine) {
                h += '<span class="bm-vbadge bm-vbadge-engine" title="Template engine">'
                    + '<svg viewBox="0 0 16 16"><path d="M5.854 4.854a.5.5 0 10-.708-.708l-3.5 3.5a.5.5 0 000 .708l3.5 3.5a.5.5 0 00.708-.708L2.707 8l3.147-3.146zm4.292 0a.5.5 0 01.708-.708l3.5 3.5a.5.5 0 010 .708l-3.5 3.5a.5.5 0 01-.708-.708L13.293 8l-3.147-3.146z"/></svg>'
                    + escHtml(engine) + '</span>';
            }
            if (metrics.weight) {
                var _res = metrics.resourceSize;
                var _xfr = metrics.weight;
                var _showDual = _res && _res !== _xfr;
                var weightTitle = _showDual
                    ? 'Resource: ' + formatBytes(_res) + ' | Transfer: ' + formatBytes(_xfr)
                    : (isXhr ? 'XHR response transfer size' : 'Page transfer size (document)');
                h += '<span class="bm-vbadge bm-vbadge-weight" title="' + weightTitle + '">'
                    + '<svg viewBox="0 0 16 16"><path d="M3.5 1h9l2.5 14H1zM4.8 2.5h6.4l2 11H2.8z"/></svg>';
                if (_showDual) {
                    var _rp = splitBytes(_res), _xp = splitBytes(_xfr);
                    if (_rp.unit === _xp.unit) {
                        h += '<span class="bm-vbadge-res">' + _rp.num + '</span>'
                            + '<span class="bm-vbadge-sep">|</span>'
                            + _xp.num + _xp.unit;
                    } else {
                        h += '<span class="bm-vbadge-res">' + formatBytes(_res) + '</span>'
                            + '<span class="bm-vbadge-sep">|</span>'
                            + formatBytes(_xfr);
                    }
                } else {
                    h += formatBytes(_xfr);
                }
                h += '</span>';
            }
            if (metrics.loadMs || metrics.transferMs) {
                var _ld = metrics.loadMs;
                var _tf = metrics.transferMs;
                var _showDualTime = _ld && _tf && _ld !== _tf;
                var timeTitle = _showDualTime
                    ? 'Load: ' + fmtMs(_ld) + ' | Transfer: ' + fmtMs(_tf)
                    : (isXhr ? 'XHR round-trip duration' : (_ld ? 'Page load time' : 'Document transfer time (requestStart \u2192 responseEnd)'));
                h += '<span class="bm-vbadge bm-vbadge-load" title="' + timeTitle + '">'
                    + '<svg viewBox="0 0 16 16"><path d="M8 3.5a.5.5 0 00-1 0V8a.5.5 0 00.252.434l3.5 2a.5.5 0 00.496-.868L8 7.71V3.5z"/><path d="M8 16A8 8 0 108 0a8 8 0 000 16zm7-8A7 7 0 111 8a7 7 0 0114 0z"/></svg>';
                if (_showDualTime) {
                    h += '<span class="bm-vbadge-res">' + fmtMs(_ld) + '</span>'
                        + '<span class="bm-vbadge-sep">|</span>'
                        + fmtMs(_tf);
                } else {
                    h += fmtMs(_ld || _tf);
                }
                h += '</span>';
            }
            if (metrics.fcpMs) {
                h += '<span class="bm-vbadge bm-vbadge-fcp" title="First Contentful Paint">'
                    + '<svg viewBox="0 0 16 16"><path d="M8 1.5s-4.5 4.75-4.5 8a4.5 4.5 0 109 0C12.5 6.25 8 1.5 8 1.5zm0 11.5a3.5 3.5 0 01-3.5-3.5c0-1.13.56-2.54 1.45-3.98A20.3 20.3 0 018 2.92a20.3 20.3 0 012.05 2.6c.89 1.44 1.45 2.85 1.45 3.98A3.5 3.5 0 018 13z"/></svg>'
                    + fmtMs(metrics.fcpMs) + ' FCP</span>';
            }
            h += '</div>';
        }

        // Params sections first
        if (paramsSection) {
            for (var p = 0; p < paramsSection.length; p++) {
                h += renderSection(paramsSection[p].name, paramsSection[p].data, paramsSection[p].gina);
            }
        }

        // Properties section (scalar root keys + flattened html/properties leaves)
        if (Object.keys(propKeys).length > 0) {
            h += renderSection('properties', propKeys, ginaPropKeys);
        }

        // Other object sections (locale, assets, etc.)
        for (var s = 0; s < objectSections.length; s++) {
            h += renderSection(objectSections[s].name, objectSections[s].data, objectSections[s].gina);
        }

        return h;
    }

    // ── Forms tab — contextual: forms in the current page/popin ──────────

    /**
     * Determine the canonical form identifier. Uses the same resolution
     * order as `gina.js`: `data-gina-form-id` attribute > `id` > `name`.
     * @inner
     * @param {HTMLFormElement} form - DOM form element
     * @returns {?string} Form ID or null if none found
     */
    function getFormId(form) {
        // gina.js uses data-gina-form-id, then id, then name
        return form.getAttribute('data-gina-form-id')
            || form.id
            || form.getAttribute('name')
            || null;
    }

    /**
     * Render the Forms tab content. Reads live DOM forms from the opener
     * window (scoped to the active popin element if present), enriches them
     * with data from `ginaToolbar.update('forms', ...)`, and renders each
     * form as a card-style accordion with attributes, events, rules, errors,
     * and sent data sub-sections.
     *
     * Forms from the data payload that do not match any DOM form are rendered
     * separately at the bottom.
     *
     * @inner
     * @param {Object} formsData - Forms data from `__ginaData.user.forms`
     * @param {Object} [ginaFormsData] - Gina forms data (for diff overlay)
     * @returns {string} HTML string
     */
    function renderFormsContent(formsData, ginaFormsData) {
        formsData = formsData || {};
        ginaFormsData = ginaFormsData || {};
        var h = '';

        // Read ALL forms from the opener page DOM (including hidden ones)
        // If a popin is active (el-xhr set), scope to that element
        var pageForms = [];
        try {
            if (source && source !== 'localStorage' && source.document) {
                var u = (ginaData && ginaData.user) || {};
                var scope = source.document;
                if (u['el-xhr']) {
                    var popinEl = source.document.getElementById(u['el-xhr']);
                    if (popinEl) scope = popinEl;
                }
                pageForms = Array.from(scope.querySelectorAll('form'));
            }
        } catch (e) {}

        var formKeys = Object.keys(formsData);

        if (pageForms.length === 0 && formKeys.length === 0) {
            return '<span class="bm-empty">No forms detected on this page</span>';
        }

        var formDataMap = {};
        for (var fi = 0; fi < formKeys.length; fi++) {
            formDataMap[formKeys[fi]] = formsData[formKeys[fi]];
        }

        var rendered = {};

        var chevronSvg = '<svg class="bm-form-chevron" viewBox="0 0 16 16"><path d="M4.35 5.65a.5.5 0 01.7 0L8 8.59l2.95-2.94a.5.5 0 01.7.7l-3.3 3.3a.5.5 0 01-.7 0l-3.3-3.3a.5.5 0 010-.7z"/></svg>';

        // Render DOM forms (enriched with data from formsData)
        for (var i = 0; i < pageForms.length; i++) {
            var form = pageForms[i];
            var formId = getFormId(form) || ('form-' + i);
            rendered[formId] = true;

            // Each form is a card-style accordion, default folded
            h += '<details class="bm-form-card" data-path="form.' + escHtml(formId) + '">';
            h += '<summary class="bm-form-header">'
                + escHtml(formId.toUpperCase())
                + chevronSvg + '</summary>';
            h += '<div class="bm-form-body">';

            // Attributes sub-section
            h += '<h3 class="bm-sub-section-title">attributes</h3>';
            h += '<ul class="bm-tree bm-root">';
            var attrs = form.attributes;
            for (var a = 0; a < attrs.length; a++) {
                var attr = attrs[a];
                if (attr.name === 'class') {
                    // List each class on its own indented line (like old toolbar)
                    var classes = attr.value.split(/\s+/).filter(Boolean);
                    for (var c = 0; c < classes.length; c++) {
                        h += '<li class="bm-kv" style="padding-left:20px">'
                            + '<span class="bm-str bm-copyable" title="Click to copy">' + escHtml(classes[c]) + '</span></li>';
                    }
                } else if (attr.name.indexOf('data-action-') === 0) {
                    // data-action-* attributes: show name then indented URL
                    h += '<li class="bm-kv"><span class="bm-key">' + escHtml(attr.name) + '</span><span class="bm-colon">:</span></li>';
                    h += '<li class="bm-kv" style="padding-left:20px">'
                        + '<span class="bm-link bm-copyable" title="Click to copy">' + escHtml(attr.value) + '</span></li>';
                } else {
                    h += '<li class="bm-kv"><span class="bm-key">' + escHtml(attr.name) + '</span>'
                        + '<span class="bm-colon">:</span> '
                        + '<span class="bm-str bm-copyable" title="Click to copy">' + escHtml(attr.value) + '</span></li>';
                }
            }
            h += '</ul>';

            // Events (data-gina-form-event-* attributes)
            var events = {};
            for (var ea = 0; ea < attrs.length; ea++) {
                var ean = attrs[ea].name;
                if (ean.indexOf('data-gina-form-event-') === 0) {
                    var eventName = ean.replace('data-gina-form-event-', '');
                    events[eventName] = attrs[ea].value;
                }
            }
            if (Object.keys(events).length > 0) {
                h += '<h3 class="bm-sub-section-title">events</h3>';
                h += renderTree(events, 0);
            }

            // Data sub-sections (rules, errors, sent) from ginaToolbar.update
            var fd = formDataMap[formId];
            if (!fd) {
                var upperKey = formId.toUpperCase().replace(/[-_]/g, '-');
                for (var mk = 0; mk < formKeys.length; mk++) {
                    if (formKeys[mk].toUpperCase().replace(/[-_]/g, '-') === upperKey) {
                        fd = formDataMap[formKeys[mk]];
                        rendered[formKeys[mk]] = true;
                        break;
                    }
                }
            }
            if (fd) {
                h += renderFormDataSections(fd, ginaFormsData[formId]);
                rendered[formId] = true;
            } else {
                // No data-driven rules — fall back to listing field names as collapsible empty objects
                var fields = Array.from(form.elements);
                var rulesObj = {};
                for (var f = 0; f < fields.length; f++) {
                    if (fields[f].name && !rulesObj[fields[f].name]) {
                        rulesObj[fields[f].name] = {};
                    }
                }
                if (Object.keys(rulesObj).length > 0) {
                    h += '<h3 class="bm-sub-section-title">rules</h3>';
                    h += renderTree(rulesObj, 0);
                }
            }

            h += '</div></details>';
        }

        // Render forms from data that were NOT matched to a DOM form
        for (var dk = 0; dk < formKeys.length; dk++) {
            var dkName = formKeys[dk];
            if (rendered[dkName]) continue;
            h += '<details class="bm-form-card" data-path="form.' + escHtml(dkName) + '">';
            h += '<summary class="bm-form-header">'
                + escHtml(dkName.toUpperCase())
                + chevronSvg + '</summary>';
            h += '<div class="bm-form-body">';
            h += renderFormDataSections(formsData[dkName], ginaFormsData[dkName]);
            h += '</div></details>';
        }

        return h || '<span class="bm-empty">No forms detected on this page</span>';
    }

    /**
     * Render the data sub-sections (rules, errors, sent, and any extras) for
     * a single form. Displays in priority order: rules > errors > sent.
     * @inner
     * @param {Object} fd - Form data from `formsData[formId]`
     * @param {Object} [ginaFd] - Corresponding gina form data (for diff)
     * @returns {string} HTML string
     */
    function renderFormDataSections(fd, ginaFd) {
        if (!fd || typeof fd !== 'object') return '';
        var h = '';
        // Priority display order
        var sectionOrder = ['rules', 'errors', 'sent'];
        var keys = Object.keys(fd);

        for (var s = 0; s < sectionOrder.length; s++) {
            var name = sectionOrder[s];
            if (typeof fd[name] !== 'undefined' && fd[name] !== null) {
                var isEmpty = typeof fd[name] === 'object' && Object.keys(fd[name]).length === 0;
                if (isEmpty) continue;
                h += '<h3 class="bm-sub-section-title">' + name + '</h3>';
                if (name === 'errors') h += '<div class="bm-form-errors">';
                h += renderTree(fd[name], 0, null, null, ginaFd ? ginaFd[name] : undefined);
                if (name === 'errors') h += '</div>';
            }
        }

        // Remaining keys (e.g. "validated" — boolean set by gina.js form validator)
        for (var k = 0; k < keys.length; k++) {
            if (sectionOrder.indexOf(keys[k]) >= 0) continue;
            h += '<h3 class="bm-sub-section-title">' + keys[k] + '</h3>';
            h += renderTree(fd[keys[k]], 0, null, null, ginaFd ? ginaFd[keys[k]] : undefined);
        }
        return h;
    }

    // ── Tab management ─────────────────────────────────────────────────────

    /**
     * Get the currently active tab name.
     * @inner
     * @returns {string} Tab name (e.g. `'data'`, `'view'`, `'forms'`,
     *                   `'query'`, `'logs'`)
     */
    function activeTab() {
        var active = qs('.bm-tab.active');
        return active ? active.dataset.tab : 'data';
    }

    /**
     * Switch to a tab by name. Updates CSS classes on tab buttons and panels,
     * renders the new tab's content (except Logs which renders on its own
     * schedule), and persists the selection to localStorage.
     * @inner
     * @param {string} name - Tab name to activate
     */
    function switchTab(name) {
        qsa('.bm-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
        qsa('.bm-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
        if (name !== 'logs') renderTab(name);
        try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch (e) {}
    }

    // ── Tab rendering ──────────────────────────────────────────────────────

    /**
     * Render a tab's content into its `#tree-{name}` container.
     *
     * Dispatches to the appropriate renderer based on tab name:
     * - `data`  — dot-path search, fuzzy filter, or full tree with badge
     * - `view`  — sectioned layout with engine/metrics badges
     * - `forms` — live DOM form inspection with data enrichment
     * - `query` — QI query cards with syntax highlighting
     *
     * Captures fold state before rendering and restores it after to preserve
     * the user's open/closed preferences across data refreshes.
     *
     * @inner
     * @param {string} name - Tab name to render
     */
    function renderTab(name) {
        var treeEl = qs('#tree-' + name);
        if (!treeEl) return;

        if (name === 'data' && rawMode) {
            renderRaw(treeEl);
            return;
        }

        if (!ginaData) {
            treeEl.innerHTML = '<span class="bm-hint">Waiting for source data\u2026</span>';
            return;
        }

        captureFoldState(name);

        var u = ginaData.user || {};
        var g = ginaData.gina || {};
        var content = '';
        var hasXhr = typeof u['data-xhr'] !== 'undefined';

        switch (name) {
            case 'data':
                var dataObj = hasXhr ? u['data-xhr'] : u.data;
                var ginaObj = hasXhr ? (g['data-xhr'] || g.data) : g.data;
                var q = getDataSearchQuery();
                if (q && dataObj && typeof dataObj === 'object') {
                    // Try exact dot-path resolve first
                    var resolved = resolveDataPath(dataObj, q);
                    if (resolved.found) {
                        // Render breadcrumb + resolved value
                        var breadcrumb = '<div class="bm-search-breadcrumb">'
                            + '<span class="bm-search-path">' + escHtml(q) + '</span></div>';
                        var resolvedGina = resolveDataPath(ginaObj || {}, q);
                        content = breadcrumb + renderTree(resolved.value, 0, resolved.key, 'bm-key',
                            resolvedGina.found ? resolvedGina.value : undefined, q.split('.').slice(0, -1).join('.'));
                    } else {
                        // Fuzzy filter — prune data to matching branches
                        var filtered = filterDataObj(dataObj, q);
                        var filteredGina = filterDataObj(ginaObj || {}, q);
                        if (filtered) {
                            content = renderRootExtras(filtered) + renderDataTree(filtered, filteredGina);
                        } else {
                            content = '<span class="bm-empty">No match for \u201c' + escHtml(q) + '\u201d</span>';
                        }
                    }
                } else {
                    content = renderDataBadge(dataObj) + renderRootExtras(dataObj) + renderDataTree(dataObj, ginaObj);
                }
                break;
            case 'view':
                var viewObj = (typeof u['view-xhr'] !== 'undefined') ? u['view-xhr'] : u.view;
                var ginaViewObj = (typeof u['view-xhr'] !== 'undefined') ? (g['view-xhr'] || g.view) : g.view;
                content = renderViewContent(viewObj, ginaViewObj);
                break;
            case 'forms':
                content = renderFormsContent(u.forms, g.forms);
                break;
            case 'query':
                var queryData = hasXhr && u['data-xhr'] && u['data-xhr'].queries
                    ? u['data-xhr'].queries : u.queries;
                content = renderQueryContent(queryData);
                break;
        }

        treeEl.innerHTML = content || '<span class="bm-empty">No data</span>';
        restoreFoldState(name);
    }

    /**
     * Render the Data tab in raw JSON mode (pretty-printed `<pre>` block).
     * @inner
     * @param {Element} treeEl - Container element to render into
     */
    function renderRaw(treeEl) {
        if (!ginaData) { treeEl.innerHTML = '<span class="bm-hint">No data to display</span>'; return; }
        var u = ginaData.user || {};
        var data = u['data-xhr'] || u.data;
        treeEl.innerHTML = '<pre class="bm-raw-view">' + escHtml(JSON.stringify(data, null, 2)) + '</pre>';
    }

    // ── Query tab renderer ──────────────────────────────────────────────────

    /** @type {string} Current free-text search for Query tab */
    var _querySearchTxt = '';
    /** @type {string} Current language dropdown filter */
    var _queryFilterLang = '';
    /** @type {string} Current connector dropdown filter */
    var _queryFilterConnector = '';
    /** @type {string} Current bundle dropdown filter */
    var _queryFilterBundle = '';
    /** @type {?QueryEntry[]} Last received queries array (for toolbar re-render) */
    var _lastQueries = null;

    /**
     * Format a byte size into a human-readable string.
     * @inner
     * @param {number} bytes - Size in bytes
     * @returns {string} Formatted string (e.g. `'1.2 KB'`)
     */
    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * Compile a query by replacing `$1`, `$2`, ... positional placeholders
     * with their actual parameter values. Replaces from highest index first
     * to avoid `$1` replacing part of `$10`.
     * @inner
     * @param {string} statement - N1QL/SQL statement with `$N` placeholders
     * @param {Array} [params] - Positional parameter values
     * @returns {string} Compiled statement with values inlined
     * @example
     *   compileQuery('SELECT * WHERE id = $1', ['abc'])
     *   // 'SELECT * WHERE id = "abc"'
     */
    function compileQuery(statement, params) {
        if (!statement) return '';
        var s = statement;
        if (params && params.length > 0) {
            // Replace from highest index first to avoid $1 replacing part of $10
            for (var i = params.length; i >= 1; i--) {
                var val = params[i - 1];
                var replacement;
                if (typeof val === 'string') replacement = '"' + val + '"';
                else if (val === null || val === undefined) replacement = 'NULL';
                else replacement = String(val);
                s = s.replace(new RegExp('\\$' + i + '(?!\\d)', 'g'), replacement);
            }
        }
        return s;
    }

    /**
     * Syntax-highlight a SQL/N1QL statement.
     *
     * Applies HTML spans with CSS classes:
     * - `bm-sql-kw` — keywords (blue)
     * - `bm-sql-fn` — functions (purple)
     * - `bm-sql-ph` — placeholders `$1`, `$2` (gold)
     * - `bm-sql-str` — string literals (green)
     * - `bm-sql-comment` — SQL comments (line `--` and block)
     *
     * Also inserts line breaks before major clause keywords and indents
     * `AND`/`OR` under their parent clause.
     *
     * @inner
     * @param {string} sql - Raw SQL/N1QL statement
     * @returns {string} HTML string with syntax highlighting spans
     */
    function highlightSQL(sql) {
        var s = escHtml(sql);
        // extract comments before formatting (-- line and /* block */)
        var comments = [];
        s = s.replace(/--[^\n]*|\/\*[^]*?\*\//g, function(m) {
            comments.push(m);
            return '\x00C' + (comments.length - 1) + '\x00';
        });
        // break before major clause keywords
        var clauses = 'SELECT|FROM|WHERE|JOIN|LEFT\\s+JOIN|RIGHT\\s+JOIN|INNER\\s+JOIN|OUTER\\s+JOIN|CROSS\\s+JOIN|FULL\\s+JOIN'
            + '|ORDER\\s+BY|GROUP\\s+BY|HAVING|LIMIT|OFFSET|SET|VALUES'
            + '|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|UPSERT'
            + '|UNION|EXCEPT|INTERSECT|LET|NEST|UNNEST|USE';
        s = s.replace(new RegExp('\\s+(?=' + clauses + '\\b)', 'gi'), '\n');
        // indent AND/OR under their clause
        s = s.replace(/\s+\b(AND|OR)\b/gi, '\n  $1');
        // keywords
        var kw = 'SELECT|DISTINCT|FROM|WHERE|AND|OR|NOT|AS|ON|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL'
            + '|ORDER\\s+BY|GROUP\\s+BY|HAVING|LIMIT|OFFSET|UNION|ALL|IN|IS|MISSING|NULL|EXISTS'
            + '|INSERT|INTO|UPDATE|SET|DELETE|UPSERT|USE|KEYS|UNNEST|LET|BETWEEN|LIKE|ASC|DESC'
            + '|CASE|WHEN|THEN|ELSE|END|TRUE|FALSE|VALUES';
        s = s.replace(new RegExp('\\b(' + kw + ')\\b', 'gi'), '<span class="bm-sql-kw">$1</span>');
        // functions — word followed by (
        s = s.replace(/\b([A-Z_][A-Z_0-9]*)\s*\(/gi, '<span class="bm-sql-fn">$1</span>(');
        // placeholders $1, $2 ...
        s = s.replace(/\$(\d+)/g, '<span class="bm-sql-ph">$$$1</span>');
        // string literals 'value'
        s = s.replace(/(&#39;[^]*?&#39;)/g, '<span class="bm-sql-str">$1</span>');
        // restore comments with highlighting
        s = s.replace(/\x00C(\d+)\x00/g, function(_, i) {
            return '<span class="bm-sql-comment">' + comments[parseInt(i, 10)] + '</span>';
        });
        return s;
    }

    /**
     * Render query parameters as a compact two-column table (Param / Value).
     * Values are color-coded by type (`bm-param-str`, `bm-param-num`).
     * @inner
     * @param {Array} params - Positional parameter values
     * @returns {string} HTML table string (empty if no params)
     */
    function renderParamsTable(params) {
        if (!params || params.length === 0) return '';
        var h = '<table class="bm-param-table"><thead><tr>'
            + '<th>Param</th><th>Value</th>'
            + '</tr></thead><tbody>';
        for (var p = 0; p < params.length; p++) {
            var val = params[p];
            var cls = '';
            if (typeof val === 'string') {
                val = '"' + val + '"';
                cls = ' class="bm-param-str"';
            } else if (typeof val === 'number') {
                cls = ' class="bm-param-num"';
            } else {
                val = String(val);
            }
            h += '<tr><td class="bm-param-name">$' + (p + 1) + '</td>'
                + '<td' + cls + '>' + escHtml(val) + '</td></tr>';
        }
        h += '</tbody></table>';
        return h;
    }

    /**
     * Filter queries by the active dropdown filters (language, connector,
     * bundle) and the free-text search input. Matches against all query
     * fields including params values.
     * @inner
     * @param {QueryEntry[]} queries - Full query array
     * @returns {QueryEntry[]} Filtered subset
     */
    function filterQueries(queries) {
        var result = [];
        var txt = _querySearchTxt ? _querySearchTxt.toLowerCase() : '';
        for (var i = 0; i < queries.length; i++) {
            var q = queries[i];
            // Dropdown filters
            if (_queryFilterLang && (q.type || 'SQL').toLowerCase() !== _queryFilterLang.toLowerCase()) continue;
            if (_queryFilterConnector && (q.connector || '').toLowerCase() !== _queryFilterConnector.toLowerCase()) continue;
            if (_queryFilterBundle && (q.origin || '').toLowerCase() !== _queryFilterBundle.toLowerCase()) continue;
            // Free-text search
            if (txt) {
                var haystack = [
                    q.type || '', q.connector || '', q.origin || '',
                    q.trigger || '', q.statement || '', q.source || '',
                    q.error || ''
                ];
                if (q.params) {
                    for (var p = 0; p < q.params.length; p++) {
                        haystack.push(String(q.params[p]));
                    }
                }
                if (haystack.join(' ').toLowerCase().indexOf(txt) < 0) continue;
            }
            result.push(q);
        }
        return result;
    }

    /**
     * Populate a `<select>` dropdown with unique values extracted from the
     * queries array. Preserves the previous selection if it still exists
     * in the new value set.
     * @inner
     * @param {HTMLSelectElement} selectEl - Target dropdown element
     * @param {QueryEntry[]} queries - Full query array
     * @param {function(QueryEntry): string} getter - Extracts the dropdown value
     * @param {string} allLabel - Label for the "all" option (e.g. `'All languages'`)
     */
    function populateQueryDropdown(selectEl, queries, getter, allLabel) {
        var vals = {};
        for (var i = 0; i < queries.length; i++) {
            var v = getter(queries[i]);
            if (v) vals[v] = true;
        }
        var keys = Object.keys(vals).sort();
        var prev = selectEl.value;
        var html = '<option value="">' + allLabel + '</option>';
        for (var k = 0; k < keys.length; k++) {
            html += '<option value="' + escHtml(keys[k]) + '">' + escHtml(keys[k]) + '</option>';
        }
        selectEl.innerHTML = html;
        // Restore previous selection if still valid
        if (prev && vals[prev]) selectEl.value = prev;
        else selectEl.value = '';
    }

    // SVG icons for stat badges (12×12, filled)
    var _svgClock  = '<svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zm.5 2.25a.5.5 0 00-1 0V8a.5.5 0 00.22.416l2.5 1.667a.5.5 0 00.56-.83L8.5 7.72V4.75z"/></svg>';
    var _svgWeight = '<svg viewBox="0 0 16 16"><path d="M8 1a2.5 2.5 0 012.45 2H13a1 1 0 011 1v9a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1h2.55A2.5 2.5 0 018 1zm0 1.5a1 1 0 100 2 1 1 0 000-2zM4 9.5a.5.5 0 000 1h8a.5.5 0 000-1H4zm0-2.5a.5.5 0 000 1h8a.5.5 0 000-1H4z"/></svg>';

    /**
     * Classify total query duration for badge coloring.
     * @inner
     * @param {number} ms - Total duration in milliseconds
     * @returns {string} `'fast'` (< 100), `'ok'` (< 500), or `'slow'` (>= 500)
     */
    function durationClass(ms) {
        if (ms < 100) return 'fast';
        if (ms < 500) return 'ok';
        return 'slow';
    }

    /**
     * Classify total result weight by average per query for badge coloring.
     * @inner
     * @param {number} totalBytes - Total result size in bytes
     * @param {number} count - Number of queries
     * @returns {string} `'light'` (avg < 10 KB), `'ok'` (< 100 KB), or
     *                   `'heavy'` (>= 100 KB)
     */
    function weightClass(totalBytes, count) {
        var avg = count > 0 ? totalBytes / count : 0;
        if (avg < 10 * 1024) return 'light';
        if (avg < 100 * 1024) return 'ok';
        return 'heavy';
    }

    /**
     * Build the tooltip text for the duration stat badge.
     * @inner
     * @param {number} ms - Total duration in milliseconds
     * @returns {string} Tooltip text with classification thresholds
     */
    function durationTooltip(ms) {
        var labels = { fast: 'fast', ok: 'acceptable', slow: 'slow' };
        return fmtMs(ms) + ' total \u2014 ' + labels[durationClass(ms)] + '  (\u2264100\u202Fms fast \u2022 \u2264500\u202Fms ok \u2022 else slow)';
    }

    /**
     * Build the tooltip text for the weight stat badge.
     * @inner
     * @param {number} totalBytes - Total result size in bytes
     * @param {number} count - Number of queries
     * @returns {string} Tooltip text with classification thresholds
     */
    function weightTooltip(totalBytes, count) {
        var avg = count > 0 ? totalBytes / count : 0;
        var labels = { light: 'light', ok: 'moderate', heavy: 'heavy' };
        return formatSize(totalBytes) + ' total \u2014 avg ' + formatSize(avg) + '/query \u2014 ' + labels[weightClass(totalBytes, count)] + '  (\u226410\u202FKB light \u2022 \u2264100\u202FKB ok \u2022 else heavy)';
    }

    /**
     * Apply visual state to a stat badge element (icon, text, CSS class, tooltip).
     * @inner
     * @param {Element} el - Badge DOM element
     * @param {string} svgIcon - SVG markup for the icon
     * @param {string} text - Display text
     * @param {string} cls - CSS modifier class (e.g. `'fast'`, `'slow'`)
     * @param {string} tooltip - Tooltip text
     */
    function applyStatBadge(el, svgIcon, text, cls, tooltip) {
        el.className = 'bm-query-stat bm-vbadge bm-stat-' + cls;
        el.innerHTML = svgIcon + text;
        el.setAttribute('data-tooltip', tooltip);
    }

    /**
     * Update the Query tab toolbar: populate filter dropdowns, compute and
     * display duration/weight stat badges, and update the tab badge count.
     * Called on every data refresh, regardless of which tab is active.
     * @inner
     * @param {?QueryEntry[]} queries - Query array or null if no queries
     */
    function updateQueryToolbar(queries) {
        var langEl    = qs('#bm-query-lang');
        var connEl    = qs('#bm-query-connector');
        var bundleEl  = qs('#bm-query-bundle');
        var statsEl   = qs('#bm-query-stats');
        var timeEl    = qs('#bm-query-total-time');
        var weightEl  = qs('#bm-query-total-weight');
        var tabBadge  = qs('#bm-query-tab-badge');

        if (!langEl) return;

        var hasQueries = queries && queries.length > 0;

        if (hasQueries) {
            populateQueryDropdown(langEl, queries, function(q) { return q.type || 'N1QL'; }, 'All languages');
            populateQueryDropdown(connEl, queries, function(q) { return q.connector || ''; }, 'All connectors');
            populateQueryDropdown(bundleEl, queries, function(q) { return q.origin || ''; }, 'All bundles');
        }

        var filtered = hasQueries ? filterQueries(queries) : [];
        var totalMs = 0;
        var totalSize = 0;
        for (var t = 0; t < filtered.length; t++) {
            totalMs   += (filtered[t].durationMs  || 0);
            totalSize += (filtered[t].resultSize  || 0);
        }

        if (statsEl) {
            if (hasQueries) statsEl.classList.remove('hidden');
            else            statsEl.classList.add('hidden');
        }

        if (timeEl) {
            if (hasQueries) {
                applyStatBadge(timeEl, _svgClock, fmtMs(totalMs), durationClass(totalMs), durationTooltip(totalMs));
            } else {
                timeEl.className = 'bm-query-stat bm-vbadge';
                timeEl.innerHTML = '';
                timeEl.removeAttribute('data-tooltip');
            }
        }
        if (weightEl) {
            var showWeight = hasQueries && totalSize > 0;
            if (showWeight) {
                applyStatBadge(weightEl, _svgWeight, formatSize(totalSize), weightClass(totalSize, filtered.length), weightTooltip(totalSize, filtered.length));
                weightEl.classList.remove('hidden');
            } else {
                weightEl.className = 'bm-query-stat bm-vbadge hidden';
                weightEl.innerHTML = '';
                weightEl.removeAttribute('data-tooltip');
            }
        }

        // Tab badge
        if (tabBadge) {
            if (hasQueries) {
                tabBadge.textContent = queries.length;
                tabBadge.classList.remove('hidden');
            } else {
                tabBadge.classList.add('hidden');
            }
        }
    }

    /**
     * Render the Query tab content: a list of query cards with syntax-highlighted
     * statements, parameter tables, trigger badges, timing badges, and error blocks.
     *
     * Badge order in each card header: type (N1QL) > connector (couchbase) >
     * origin (dashboard) > spacer > trigger > size > timing.
     *
     * @inner
     * @param {?QueryEntry[]} queries - Query entries from the current request
     * @returns {string} HTML string
     */
    function renderQueryContent(queries) {
        if (!queries || !Array.isArray(queries) || queries.length === 0) {
            updateQueryToolbar(null);
            return '<span class="bm-hint">No queries captured for this request.</span>';
        }

        _lastQueries = queries;
        updateQueryToolbar(queries);

        var filtered = filterQueries(queries);
        if (filtered.length === 0) {
            return '<span class="bm-hint" style="display:block;padding:12px 10px">No queries match the filters.</span>';
        }

        var h = '';

        for (var i = 0; i < filtered.length; i++) {
            var q = filtered[i];
            var hasError = q.error ? ' bm-query-has-error' : '';
            var durationClass = '';
            if (q.durationMs > 500) durationClass = ' bm-query-slow';
            else if (q.durationMs > 100) durationClass = ' bm-query-medium';

            h += '<div class="bm-query-card' + hasError + '">'
                + '<div class="bm-query-header">'
                + '<span class="bm-query-badge">' + escHtml(q.type || 'SQL') + '</span>';

            if (q.connector) {
                h += '<span class="bm-query-connector">' + escHtml(q.connector) + '</span>';
            }
            if (q.origin) {
                h += '<span class="bm-query-origin">' + escHtml(q.origin) + '</span>';
            }

            // Split trigger badge: entity#method → two joined halves
            var triggerHtml = '';
            var trig = q.trigger || '';
            if (trig) {
                var hashIdx = trig.indexOf('#');
                if (hashIdx > 0) {
                    triggerHtml = '<span class="bm-trigger-badge">'
                        + '<span class="bm-trigger-entity">' + escHtml(trig.substring(0, hashIdx)) + '</span>'
                        + '<span class="bm-trigger-method">' + escHtml(trig.substring(hashIdx + 1)) + '</span>'
                        + '</span>';
                } else {
                    triggerHtml = '<span class="bm-trigger-badge">'
                        + '<span class="bm-trigger-entity">' + escHtml(trig) + '</span>'
                        + '</span>';
                }
            }

            var sizeHtml = '';
            if (q.resultSize > 0) {
                sizeHtml = '<span class="bm-query-size">' + formatSize(q.resultSize) + '</span>';
            }

            h += '<span class="bm-query-right">'
                + triggerHtml
                + sizeHtml
                + '<span class="bm-query-timing' + durationClass + '">' + fmtMs(q.durationMs || 0) + '</span>'
                + '</span>'
                + '</div>';

            if (q.statement) {
                var compiled = compileQuery(q.statement, q.params);
                var rowCountBadge = '';
                if (typeof q.resultCount !== 'undefined') {
                    rowCountBadge = '<span class="bm-query-stmt-rows">'
                        + '<span class="bm-query-stmt-rows-label">rows</span>'
                        + '<span class="bm-query-stmt-rows-val">' + q.resultCount + '</span>'
                        + '</span>';
                }
                h += '<div class="bm-query-stmt-wrap">'
                    + '<pre class="bm-query-statement">' + highlightSQL(q.statement) + '</pre>'
                    + '<button class="bm-query-copy" title="Copy compiled query" data-compiled="'
                    + escHtml(compiled) + '">'
                    + '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M4 1.5A1.5 1.5 0 015.5 0h5A1.5 1.5 0 0112 1.5v9a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 014 10.5v-9z" opacity=".35"/><path fill="currentColor" d="M2 4.5A1.5 1.5 0 013.5 3h5A1.5 1.5 0 0110 4.5v9A1.5 1.5 0 018.5 15h-5A1.5 1.5 0 012 13.5v-9z"/></svg>'
                    + '</button>'
                    + rowCountBadge
                    + '</div>';
            }

            if (q.params && q.params.length > 0) {
                h += renderParamsTable(q.params);
            }

            var footerParts = [];
            if (q.source) {
                footerParts.push('<span class="bm-query-foot-item">'
                    + '<span class="bm-query-foot-label">Source</span>'
                    + '<span class="bm-query-foot-val bm-query-source-path">' + escHtml(q.source) + '</span>'
                    + '</span>');
            }
            if (footerParts.length > 0) {
                h += '<div class="bm-query-footer">' + footerParts.join('<span class="bm-query-foot-sep"></span>') + '</div>';
            }

            if (q.error) {
                h += '<div class="bm-query-error">' + escHtml(q.error) + '</div>';
            }

            h += '</div>'; // close bm-query-card
        }

        return h;
    }

    /**
     * Fetch `routing.json` from the bundle's `/_gina/assets/` endpoint and
     * render it as a tree in the given panel.
     * @inner
     * @param {Element} panel - Container element to render into
     */
    function loadRouting(panel) {
        var origin = '';
        var webroot = '/';
        try {
            if (source && source !== 'localStorage' && source.location) origin = source.location.origin;
            if (source && source !== 'localStorage' && source.__ginaData) {
                webroot = source.__ginaData.user.environment.webroot || '/';
            }
        } catch (e) {}
        if (!origin) origin = window.location.origin;
        if (webroot.charAt(webroot.length - 1) !== '/') webroot += '/';
        panel.innerHTML = '<span class="bm-hint">Loading routing\u2026</span>';
        fetch(origin + webroot + '_gina/assets/routing.json')
            .then(function (r) { return r.json(); })
            .then(function (data) { panel.innerHTML = renderTree(data, 0); })
            .catch(function (err) {
                panel.innerHTML = '<span class="bm-error">Could not load routing: ' + escHtml(err.message) + '</span>';
            });
    }

    // ── Data search / filter (data-level) ───────────────────────────────────
    /** @type {?number} Debounce timer ID for data search input */
    var _dataSearchTimer = null;

    /**
     * Resolve a dot-path like "document.company.id" against an object.
     * Returns { found: true, value: ... , key: 'id', parent: {...} }
     * or     { found: false }.
     * Supports array index notation: "items.0.name"
     */
    function resolveDataPath(obj, dotPath) {
        if (!obj || typeof obj !== 'object') return { found: false };
        var parts = dotPath.split('.');
        var cur = obj;
        for (var i = 0; i < parts.length; i++) {
            if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false };
            var key = parts[i];
            // Array index?
            if (Array.isArray(cur) && /^\d+$/.test(key)) key = parseInt(key, 10);
            if (!(key in cur)) return { found: false };
            if (i === parts.length - 1) {
                return { found: true, value: cur[key], key: parts[i], parent: cur };
            }
            cur = cur[key];
        }
        return { found: false };
    }

    /**
     * Recursively prune an object, keeping only branches where any
     * key name or full dot-path contains the query string.
     * Returns a pruned shallow copy, or null if nothing matches.
     */
    function filterDataObj(obj, query, parentPath) {
        if (!obj || typeof obj !== 'object') return null;
        parentPath = parentPath || '';
        if (Array.isArray(obj)) {
            var arrResult = [];
            var anyMatch = false;
            for (var ai = 0; ai < obj.length; ai++) {
                var itemPath = parentPath ? parentPath + '.' + ai : String(ai);
                if (typeof obj[ai] === 'object' && obj[ai] !== null) {
                    var sub = filterDataObj(obj[ai], query, itemPath);
                    if (sub !== null) { arrResult.push(sub); anyMatch = true; }
                    else { arrResult.push(null); } // placeholder to keep indices stable
                } else {
                    // Leaf in array — match value or index
                    if (String(obj[ai]).toLowerCase().indexOf(query) !== -1
                        || itemPath.toLowerCase().indexOf(query) !== -1) {
                        arrResult.push(obj[ai]); anyMatch = true;
                    } else { arrResult.push(null); }
                }
            }
            if (!anyMatch) return null;
            // Filter out null placeholders but re-wrap as object with original indices
            var sparse = {};
            for (var si = 0; si < arrResult.length; si++) {
                if (arrResult[si] !== null) sparse[si] = arrResult[si];
            }
            return Object.keys(sparse).length > 0 ? sparse : null;
        }

        var result = {};
        var hasMatch = false;
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var fullPath = parentPath ? parentPath + '.' + k : k;
            var keyMatch = k.toLowerCase().indexOf(query) !== -1
                        || fullPath.toLowerCase().indexOf(query) !== -1;
            var v = obj[k];

            if (typeof v === 'object' && v !== null) {
                if (keyMatch) {
                    // Key matches — include entire subtree
                    result[k] = v;
                    hasMatch = true;
                } else {
                    // Recurse
                    var sub = filterDataObj(v, query, fullPath);
                    if (sub !== null) { result[k] = sub; hasMatch = true; }
                }
            } else {
                // Leaf — match key or value
                if (keyMatch || String(v).toLowerCase().indexOf(query) !== -1) {
                    result[k] = v;
                    hasMatch = true;
                }
            }
        }
        return hasMatch ? result : null;
    }

    /** Returns the active search query (trimmed, lowercased) or empty string */
    function getDataSearchQuery() {
        var el = qs('#bm-data-search');
        return el ? (el.value || '').trim().toLowerCase() : '';
    }

    // ── Fold all toggle (Data tab only) ───────────────────────────────────

    /**
     * Toggle all `<details>` elements in the Data tab scroll area.
     * If any are open, close all; otherwise open all. Updates the fold-all
     * button state and persists the fold state.
     * @inner
     */
    function toggleFoldAll() {
        var panel = qs('#tab-data .bm-scroll-area');
        if (!panel) return;
        var allDetails = panel.querySelectorAll('details');
        if (!allDetails.length) return;
        var anyOpen = false;
        for (var i = 0; i < allDetails.length; i++) { if (allDetails[i].open) { anyOpen = true; break; } }
        for (var j = 0; j < allDetails.length; j++) { allDetails[j].open = !anyOpen; }
        var btn = qs('#bm-fold-all');
        if (btn) btn.classList.toggle('active', anyOpen);
        captureFoldState('data');
    }

    // ── Download modal ────────────────────────────────────────────────────

    /**
     * Open the download modal with checkboxes for each root data key.
     * All keys are checked by default.
     * @inner
     */
    function openDownloadModal() {
        if (!ginaData || !ginaData.user) return;
        var u = ginaData.user;
        var dataObj = u['data-xhr'] || u.data;
        if (!dataObj || typeof dataObj !== 'object') return;

        var keys = Object.keys(dataObj).sort();
        var checks = qs('#bm-dl-checks');
        checks.innerHTML = '';
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k === '_comment') continue;
            var label = document.createElement('label');
            var cb = document.createElement('input');
            cb.type = 'checkbox'; cb.value = k; cb.checked = true;
            label.appendChild(cb);
            label.appendChild(document.createTextNode(' ' + k));
            checks.appendChild(label);
        }
        qs('#bm-dl-modal').classList.remove('hidden');
    }

    /**
     * Execute the download: build a JSON blob from checked keys, trigger a
     * browser download with a filename of `{bundle}-{ISO timestamp}.json`.
     * @inner
     */
    function doDownload() {
        if (!ginaData || !ginaData.user) return;
        var u = ginaData.user;
        var dataObj = u['data-xhr'] || u.data;
        var checks = qsa('#bm-dl-checks input:checked');
        var result = {};
        for (var i = 0; i < checks.length; i++) {
            var k = checks[i].value;
            if (typeof dataObj[k] !== 'undefined') result[k] = dataObj[k];
        }
        var blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        var env = (ginaData.user.environment || {});
        a.href = url;
        a.download = (env.bundle || 'data') + '-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        qs('#bm-dl-modal').classList.add('hidden');
    }

    // ── Source connection ──────────────────────────────────────────────────

    /**
     * Attempt to connect to the opener window as the data source.
     * Accesses `window.opener.location.href` to verify same-origin access.
     * Sets `source` to the opener Window on success.
     * @inner
     * @returns {boolean} `true` if connection succeeded
     */
    function tryOpener() {
        try {
            if (!window.opener) return false;
            void window.opener.location.href;
            source = window.opener;
            return true;
        } catch (e) { return false; }
    }

    /**
     * Attempt to use localStorage as the fallback data source.
     * Parses `localStorage.__ginaData` and validates it contains a `user` key.
     * Sets `source` to `'localStorage'` on success.
     * @inner
     * @returns {boolean} `true` if a valid payload was found
     */
    function tryLocalStorage() {
        try {
            var raw = localStorage.getItem('__ginaData');
            if (!raw) return false;
            var gd = JSON.parse(raw);
            if (!gd || !gd.user) return false;
            source = 'localStorage';
            return true;
        } catch (e) { return false; }
    }

    // ── Settings — environment info + memory gauge ────────────────────────

    /**
     * Render the environment info grid and memory gauge in the Settings panel.
     * Reads scalar values from `ginaData.user.environment` and displays them
     * as key-value pairs. The memory gauge shows heap usage as a percentage
     * of allocated memory with color-coded thresholds.
     * @inner
     */
    function renderEnvironmentInfo() {
        if (!ginaData || !ginaData.user) return;
        var env = ginaData.user.environment;
        if (!env || typeof env !== 'object') return;

        // Env info grid
        var el = qs('#bm-settings-env');
        if (el) {
            var skip = { routing: 1, reverseRouting: 1, forms: 1 };
            var keys = Object.keys(env);
            var h = '';
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (skip[k]) continue;
                var v = env[k];
                if (typeof v === 'object' && v !== null) continue;
                h += '<span class="bm-env-key">' + escHtml(k) + '</span>'
                    + '<span class="bm-env-val">' + escHtml(String(v)) + '</span>';
            }
            el.innerHTML = h;
        }

        // Memory gauge
        var memRow = qs('#bm-mem-row');
        var memBar = qs('#bm-mem-bar');
        var memText = qs('#bm-mem-text');
        if (memRow && memBar && memText) {
            var heapStr = env['memory heap'];
            var allocStr = env['memory allocated'];
            if (heapStr && allocStr) {
                var heap = parseFloat(heapStr);
                var alloc = parseFloat(allocStr);
                // heap is in MB, alloc is in GB
                var allocMB = alloc * 1024;
                var pct = allocMB > 0 ? Math.min((heap / allocMB) * 100, 100) : 0;
                memBar.style.width = pct + '%';
                memBar.className = 'bm-mem-bar ' + (pct >= 80 ? 'mem-crit' : pct >= 50 ? 'mem-warn' : 'mem-ok');
                memText.textContent = heap.toFixed(0) + ' MB / ' + alloc.toFixed(1) + ' GB';
                memRow.style.display = 'flex';
            }
        }
    }

    /**
     * Poll the data source for updates. Called on a timer every
     * {@link pollDataMs} milliseconds.
     *
     * Reads `__ginaData` from the source (opener window or localStorage),
     * compares against the last-seen JSON string to detect changes, updates
     * the header label and health dot, renders the environment info and
     * active tab, and refreshes the Query tab badge.
     *
     * If the source is lost (e.g. bundle restart killed the opener page),
     * attempts to re-acquire it via {@link tryOpener} or {@link tryLocalStorage}.
     *
     * @inner
     */
    function pollData() {
        try {
            var gd;
            if (source === 'localStorage') {
                var raw = localStorage.getItem('__ginaData');
                if (!raw) return;
                gd = JSON.parse(raw);
            } else if (source) {
                gd = source.__ginaData;
            } else {
                // Source was lost (e.g. bundle restart killed the opener page).
                // Try to re-acquire it so the Inspector auto-reconnects.
                if (tryOpener() || tryLocalStorage()) {
                    qs('#bm-no-source').classList.add('hidden');
                    return pollData();
                }
                return;
            }
            if (!gd) return;
            var str = JSON.stringify(gd);
            if (str === lastGdStr) return;
            showLoader();
            lastGdStr = str;
            ginaData = gd;
            var env = (gd.user && gd.user.environment) || {};
            qs('#bm-label').textContent = (env.bundle || '?') + '@' + (env.env || '?');
            qs('#bm-dot').className = 'bm-dot ok';
            qs('#bm-no-source').classList.add('hidden');
            renderEnvironmentInfo();
            var tab = activeTab();
            if (tab !== 'logs') renderTab(tab);
            // Always update query tab badge regardless of active tab
            if (tab !== 'query') {
                var _u = gd.user || {};
                var _hasXhr = typeof _u['data-xhr'] !== 'undefined';
                var _qd = _hasXhr && _u['data-xhr'] && _u['data-xhr'].queries
                    ? _u['data-xhr'].queries : _u.queries;
                updateQueryToolbar(_qd || null);
            }
            hideLoader();
        } catch (e) {
            hideLoader();
            if (source !== 'localStorage') source = null;
            qs('#bm-dot').className = 'bm-dot err';
        }
    }

    // ── Log polling ────────────────────────────────────────────────────────

    /**
     * Severity score map — covers both client console levels and server
     * syslog level names. Used by the log-dot indicator to track the highest
     * severity received since last clear.
     * @constant {Object.<string, number>}
     */
    var LOG_SEVERITY = {
        debug: 0, log: 1, catch: 1,
        info: 2, notice: 2,
        warn: 3, warning: 3,
        error: 4, err: 4, crit: 4, alert: 4, emerg: 4
    };

    /**
     * Maps server syslog level names to CSS class suffixes for log row
     * styling (`bm-log-error`, `bm-log-warn`, etc.). Levels not in this
     * map use their raw name as the CSS suffix.
     * @constant {Object.<string, string>}
     */
    var CSS_LEVEL = {
        emerg: 'error', alert: 'error', crit: 'error', err: 'error',
        warning: 'warn', notice: 'info', catch: 'log'
    };

    /**
     * Synonym groups for the level filter — selecting `'error'` also matches
     * `'err'`, selecting `'warn'` also matches `'warning'`.
     * @constant {Object.<string, string[]>}
     */
    var LEVEL_EQUIV = {
        error: ['error', 'err'], err: ['error', 'err'],
        warn: ['warn', 'warning'], warning: ['warn', 'warning']
    };

    /** @constant {Array.<{v: string, t: string}>} Level dropdown options for client-only source */
    var CLIENT_LEVELS = [
        { v: 'error', t: 'Error' },
        { v: 'warn',  t: 'Warn' },
        { v: 'info',  t: 'Info' },
        { v: 'log',   t: 'Log' },
        { v: 'debug', t: 'Debug' }
    ];
    /** @constant {Array.<{v: string, t: string}>} Level dropdown options for server-only source */
    var SERVER_LEVELS = [
        { v: 'emerg',   t: 'Emergency' },
        { v: 'alert',   t: 'Alert' },
        { v: 'crit',    t: 'Critical' },
        { v: 'err',     t: 'Error' },
        { v: 'warning', t: 'Warning' },
        { v: 'notice',  t: 'Notice' },
        { v: 'info',    t: 'Info' },
        { v: 'debug',   t: 'Debug' }
    ];
    /** @constant {Array.<{v: string, t: string}>} Level dropdown options for "All" source */
    var ALL_LEVELS = [
        { v: 'emerg',   t: 'Emergency' },
        { v: 'alert',   t: 'Alert' },
        { v: 'crit',    t: 'Critical' },
        { v: 'error',   t: 'Error' },
        { v: 'warn',    t: 'Warn' },
        { v: 'notice',  t: 'Notice' },
        { v: 'info',    t: 'Info' },
        { v: 'log',     t: 'Log' },
        { v: 'debug',   t: 'Debug' }
    ];

    /**
     * Rebuild the level dropdown `<option>` elements based on the current
     * source filter. Server-only shows syslog levels; client-only shows
     * console levels; "All" shows a merged set. Preserves the previous
     * selection if it still exists in the new level set.
     * @inner
     * @param {string} srcVal - Source filter value (`'server'`, `'client'`, or `''`)
     */
    function updateLevelDropdown(srcVal) {
        var sel = qs('#bm-log-level');
        if (!sel) return;
        var prev = sel.value;
        var levels = srcVal === 'server' ? SERVER_LEVELS
                   : srcVal === 'client' ? CLIENT_LEVELS
                   : ALL_LEVELS;
        sel.innerHTML = '<option value="">All levels</option>'
            + levels.map(function (l) {
                return '<option value="' + l.v + '">' + escHtml(l.t) + '</option>';
            }).join('');
        // Restore previous selection if it still exists in the new set
        if (prev) {
            var exists = levels.some(function (l) { return l.v === prev; });
            sel.value = exists ? prev : '';
        }
    }

    /**
     * Poll client-side logs from `source.__ginaLogs`. Called on a timer
     * every {@link POLL_LOGS_MS} milliseconds. Reads new entries since
     * the last poll offset, assigns stable IDs, caps the buffer at
     * {@link MAX_LOG_ENTRIES}, updates the log-dot indicator, and renders.
     * @inner
     */
    function pollLogs() {
        if (paused) return;
        try {
            if (source === 'localStorage' || !source) return;
            var src = source.__ginaLogs;
            if (!src || !Array.isArray(src) || src.length <= logsOff) return;
        } catch (e) { return; }

        var fresh = src.slice(logsOff);
        logsOff = src.length;
        fresh.forEach(function (e) { e._id = ++_logIdCounter; logs.push(e); });
        if (logs.length > MAX_LOG_ENTRIES) logs = logs.slice(logs.length - MAX_LOG_ENTRIES);
        updateLogDot(fresh);
        renderLogs();
    }

    /**
     * Update the log-dot severity indicator. Scans the given entries for
     * the highest severity level and updates the dot's CSS class if the
     * new highest exceeds the current.
     * @inner
     * @param {LogEntry[]} entries - Newly ingested log entries
     */
    function updateLogDot(entries) {
        var dot = qs('#bm-log-dot');
        if (!dot) return;
        var highest = highestLogLevel;
        entries.forEach(function (e) {
            var lvl = e.l || 'log';
            if ((LOG_SEVERITY[lvl] || 0) > (LOG_SEVERITY[highest] || -1)) highest = lvl;
        });
        if (highest && highest !== highestLogLevel) {
            highestLogLevel = highest;
            // Use the CSS-mapped level for the dot class (bm-log-dot.error, .warn, etc.)
            var dotCss = CSS_LEVEL[highest] || highest;
            dot.className = 'bm-log-dot active ' + dotCss;
        }
    }

    /**
     * Coalesce rapid `renderLogs()` calls into a single repaint (150 ms
     * debounce). Used by streaming paths (SSE, engine.io) to avoid
     * per-message DOM rebuilds.
     * @inner
     */
    function scheduleRender() {
        if (_renderTimer) return;
        _renderTimer = setTimeout(function () { _renderTimer = null; renderLogs(); }, 150);
    }

    /**
     * Render the filtered log entries into `#bm-log-list`.
     *
     * Applies the current source filter, level filter (with synonym group
     * support), and free-text search. Highlights search matches with
     * `<mark class="bm-log-hl">`. Embeds `bm-log-selected` classes in the
     * HTML string so selection survives re-renders without a separate DOM pass.
     * Auto-scrolls to the bottom after render.
     *
     * @inner
     */
    function renderLogs() {
        var lvl = qs('#bm-log-level').value;
        var txt = (qs('#bm-log-search').value || '').toLowerCase();
        var list = qs('#bm-log-list');
        if (!list) return;

        // Build the accepted level set (handles synonym groups like error/err)
        var _lvlSet = null;
        if (lvl) {
            var eq = LEVEL_EQUIV[lvl];
            _lvlSet = eq ? {} : null;
            if (eq) { for (var i = 0; i < eq.length; i++) _lvlSet[eq[i]] = true; }
        }

        var srcFilter = qs('#bm-log-source');
        var srcVal = srcFilter ? srcFilter.value : '';

        var filtered = logs.filter(function (e) {
            // Source filter
            if (srcVal === 'server' && e.src !== 'server') return false;
            if (srcVal === 'client' && e.src === 'server') return false;
            // Level filter — exact match or synonym group
            if (lvl) {
                if (_lvlSet) { if (!_lvlSet[e.l]) return false; }
                else if (e.l !== lvl) return false;
            }
            if (txt && (e.s || '').toLowerCase().indexOf(txt) < 0) return false;
            return true;
        });

        var _hlRe = txt ? new RegExp('(' + escRegex(txt) + ')', 'gi') : null;
        list.innerHTML = filtered.map(function (e) {
            var d  = new Date(e.t);
            var ts = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
            var srcBadge = e.src === 'server'
                ? '<span class="bm-log-src">SVR</span>'
                : '';
            var cssLvl = CSS_LEVEL[e.l] || e.l;
            var msgHtml = escHtml(e.s || '');
            if (_hlRe) msgHtml = msgHtml.replace(_hlRe, '<mark class="bm-log-hl">$1</mark>');
            return '<div class="bm-log bm-log-' + escHtml(cssLvl)
                + (selectedLogIds.has(e._id) ? ' bm-log-selected' : '')
                + '" data-lid="' + e._id + '">'
                + '<span class="bm-log-ts">' + ts + '</span>'
                + srcBadge
                + '<span class="bm-log-lv">' + escHtml((e.l || '').toUpperCase()) + '</span>'
                + '<span class="bm-log-bun">' + escHtml(e.b || '') + '</span>'
                + '<span class="bm-log-msg">' + msgHtml + '</span>'
                + '</div>';
        }).join('');
        list.scrollTop = list.scrollHeight;
    }

    /**
     * Sync the selection HUD visibility based on the current selection size.
     * Shows the info button (keyboard shortcut help) when < 2 rows are selected,
     * shows the dual badge (Cancel + Copy N) when >= 2 rows are selected.
     * @inner
     */
    function updateSelectionUI() {
        var badge   = qs('#bm-log-sel-badge');
        var helpBtn = qs('#bm-log-help-btn');
        var copyBtn = qs('#bm-log-sel-copy');
        if (!badge) return;
        if (selectedLogIds.size < 2) {
            badge.classList.add('hidden');
            if (helpBtn) helpBtn.classList.remove('hidden');
        } else {
            badge.classList.remove('hidden');
            if (helpBtn) {
                helpBtn.classList.add('hidden');
                helpBtn.classList.remove('active');
                var pop = qs('#bm-log-help-pop');
                if (pop) pop.classList.remove('open');
            }
            if (copyBtn) copyBtn.textContent = 'Copy ' + selectedLogIds.size;
        }
    }

    /**
     * Copies all selected log entries (in chronological order) to the clipboard
     * as plain text. Works regardless of the current source/level/search filter.
     */
    function copySelectedLogs() {
        if (selectedLogIds.size === 0) return;
        var lines = [];
        for (var i = 0; i < logs.length; i++) {
            var e = logs[i];
            if (!selectedLogIds.has(e._id)) continue;
            var d   = new Date(e.t);
            var ts  = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
            var src = e.src === 'server' ? ' [SVR]' : '';
            var lv  = (e.l || '').toUpperCase();
            var bun = e.b ? ' [' + e.b + ']' : '';
            lines.push(ts + src + ' ' + lv + bun + ' ' + (e.s || ''));
        }
        var text = lines.join('\n');
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
        } else {
            fallbackCopy(text);
        }
        // Feedback on the badge copy button (only when the badge is visible)
        var badge   = qs('#bm-log-sel-badge');
        var copyBtn = qs('#bm-log-sel-copy');
        if (copyBtn && badge && !badge.classList.contains('hidden')) {
            var orig = copyBtn.textContent;
            copyBtn.textContent = '\u2713 Copied';
            copyBtn.classList.add('copied');
            setTimeout(function () {
                copyBtn.textContent = orig;
                copyBtn.classList.remove('copied');
            }, 900);
        }
    }

    // ── Engine.io ──────────────────────────────────────────────────────────

    /**
     * Attempt to connect to the bundle's engine.io WebSocket for real-time
     * data and log push. Requires the global `eio` function (engine.io client).
     *
     * On connection, sends a `getGinaData` request. Handles two message types:
     * - `{ type: 'ginaData', data }` — full data refresh, renders the active tab
     * - `{ type: 'log', data }` — single log entry, merged into the log buffer
     *
     * @inner
     */
    function tryEngineIO() {
        if (typeof eio === 'undefined') return;
        var port = null;
        try {
            if (source && source !== 'localStorage' && source.location) port = source.location.port;
        } catch (e) {}
        if (!port) port = window.location.port;
        if (!port) return;
        try {
            var sock = eio('ws://localhost:' + port);
            sock.on('open', function () { sock.send(JSON.stringify({ type: 'getGinaData' })); });
            sock.on('message', function (raw) {
                try {
                    var msg = JSON.parse(raw);
                    if (msg.type === 'ginaData' && msg.data) {
                        ginaData = msg.data;
                        var tab = activeTab();
                        if (tab !== 'logs') renderTab(tab);
                    } else if (msg.type === 'log' && msg.data && !paused) {
                        msg.data._id = ++_logIdCounter;
                        logs.push(msg.data);
                        if (logs.length > MAX_LOG_ENTRIES) logs.shift();
                        updateLogDot([msg.data]);
                        scheduleRender();
                    }
                } catch (e) {}
            });
            sock.on('error', function () {});
        } catch (e) {}
    }

    // ── Server-side log streaming via SSE ────────────────────────────────
    /**
     * Connects to the /_gina/logs SSE endpoint to receive real-time server-side
     * log entries from the bundle process. Entries are merged into the same logs[]
     * array used by client-side console capture and engine.io push.
     *
     * @inner
     * @private
     */
    function tryServerLogs() {
        if (typeof EventSource === 'undefined') return;

        // Derive the SSE URL from the inspector path:
        //   /{webroot}/_gina/inspector/  →  /{webroot}/_gina/logs
        var base = window.location.pathname.replace(/\/_gina\/inspector.*$/, '');
        var url  = base + '/_gina/logs';

        try {
            var es = new EventSource(url);
            es.onmessage = function (ev) {
                if (paused) return;
                try {
                    var entry = JSON.parse(ev.data);
                    entry._id = ++_logIdCounter;
                    logs.push(entry);
                    if (logs.length > MAX_LOG_ENTRIES) logs.shift();
                    updateLogDot([entry]);
                    scheduleRender();
                } catch (e) {}
            };
            es.onerror = function () {
                // EventSource reconnects automatically; nothing to do
            };
        } catch (e) {}
    }

    // ── Copy to clipboard ──────────────────────────────────────────────────

    /**
     * Install the delegated click-to-copy handler for `.bm-copyable` elements.
     * Copies the element's text content to the clipboard and applies a brief
     * `.copied` class for visual feedback.
     * @inner
     */
    function setupCopy() {
        document.addEventListener('click', function (e) {
            var el = e.target.closest('.bm-copyable');
            if (!el) return;
            if (el.closest('summary') && !e.target.classList.contains('bm-copyable')) return;
            var text = el.textContent;
            el.classList.add('copied');
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
            } else {
                fallbackCopy(text);
            }
            setTimeout(function () { el.classList.remove('copied'); }, 900);
        });
    }

    /**
     * Fallback copy-to-clipboard using a hidden textarea and `execCommand('copy')`.
     * Used when `navigator.clipboard` is unavailable (e.g. non-HTTPS).
     * @inner
     * @param {string} text - Text to copy
     */
    function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
    }

    // ── Settings panel ────────────────────────────────────────────────────

    /**
     * Initialize the Settings panel: toggle button, poll interval selector
     * (with localStorage persistence), and auto-expand checkbox.
     * @inner
     */
    function setupSettings() {
        var toggle = qs('#bm-settings-toggle');
        var panel = qs('#bm-settings');
        if (toggle && panel) {
            // Restore persisted open state
            try {
                if (localStorage.getItem(SETTINGS_STORAGE_KEY) === 'true') {
                    panel.classList.remove('hidden');
                }
            } catch (e) {}
            toggle.addEventListener('click', function () {
                panel.classList.toggle('hidden');
                try { localStorage.setItem(SETTINGS_STORAGE_KEY, String(!panel.classList.contains('hidden'))); } catch (e) {}
            });
        }

        var pollSelect = qs('#bm-poll-interval');
        if (pollSelect) {
            // Restore persisted poll interval
            try {
                var _savedPoll = localStorage.getItem(POLL_STORAGE_KEY);
                if (_savedPoll) {
                    var _parsedPoll = parseInt(_savedPoll, 10);
                    if (_parsedPoll > 0) {
                        pollDataMs = _parsedPoll;
                        pollSelect.value = String(_parsedPoll);
                    }
                }
            } catch (e) {}
            pollSelect.addEventListener('change', function () {
                pollDataMs = parseInt(this.value, 10) || 2000;
                if (pollDataTimer) clearInterval(pollDataTimer);
                pollDataTimer = setInterval(pollData, pollDataMs);
                try { localStorage.setItem(POLL_STORAGE_KEY, String(pollDataMs)); } catch (e) {}
            });
        }

        // Auto-expand checkbox — restore persisted state
        var autoExpandCb = qs('#bm-auto-expand');
        if (autoExpandCb) {
            try {
                if (localStorage.getItem(EXPAND_STORAGE_KEY) === 'true') {
                    autoExpand = true;
                    autoExpandCb.checked = true;
                }
            } catch (e) {}
            autoExpandCb.addEventListener('change', function () {
                autoExpand = this.checked;
                try { localStorage.setItem(EXPAND_STORAGE_KEY, String(autoExpand)); } catch (e) {}
                var tab = activeTab();
                if (tab !== 'logs') renderTab(tab);
            });
        }
    }

    // ── Resize handle for env panel ───────────────────────────────────────

    /**
     * Initialize the vertical resize handle for the environment info panel.
     * Allows dragging to adjust the panel's max-height. Minimum 40px.
     * @inner
     */
    function setupEnvResize() {
        var handle = qs('#bm-env-resize');
        var wrap = qs('#bm-settings-env-wrap');
        if (!handle || !wrap) return;

        var startY = 0, startH = 0, dragging = false;

        handle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            startY = e.clientY;
            startH = wrap.offsetHeight;
            dragging = true;
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var newH = Math.max(40, startH + (e.clientY - startY));
            wrap.style.maxHeight = newH + 'px';
        });

        document.addEventListener('mouseup', function () {
            if (dragging) {
                dragging = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    // ── Scroll navigation + progress bar ────────────────────────────────────

    /**
     * Initialize scroll navigation: top/bottom buttons and a progress bar.
     * Listens to scroll events on `.bm-scroll-area` and `.bm-log-list`
     * elements, showing/hiding navigation buttons based on scroll position
     * and updating the progress bar width.
     * @inner
     */
    function setupScrollToTop() {
        var nav = qs('#bm-scroll-nav');
        var topBtn = qs('#bm-scroll-top');
        var bottomBtn = qs('#bm-scroll-bottom');
        var progressBar = qs('#bm-scroll-progress');
        if (!nav) return;

        function getActiveScrollArea() {
            return qs('.bm-panel.active .bm-scroll-area') || qs('.bm-panel.active .bm-log-list');
        }

        document.addEventListener('scroll', function (e) {
            var area = e.target;
            if (!area || !area.classList) return;
            if (!area.classList.contains('bm-scroll-area') && !area.classList.contains('bm-log-list')) return;

            var scrollable = area.scrollHeight - area.clientHeight;
            var atTop = area.scrollTop < 5;
            var atBottom = (scrollable - area.scrollTop) < 5;

            // Show top button only when not at top
            topBtn.classList.toggle('hidden', atTop || scrollable < 50);
            // Show bottom button only when not at bottom
            bottomBtn.classList.toggle('hidden', atBottom || scrollable < 50);

            // Progress bar
            if (progressBar) {
                if (scrollable > 0) {
                    var pct = Math.min((area.scrollTop / scrollable) * 100, 100);
                    progressBar.style.width = pct + '%';
                    progressBar.classList.toggle('visible', area.scrollTop > 5);
                } else {
                    progressBar.classList.remove('visible');
                    progressBar.style.width = '0';
                }
            }
        }, true);

        topBtn.addEventListener('click', function () {
            var area = getActiveScrollArea();
            if (area) area.scrollTo({ top: 0, behavior: 'smooth' });
        });

        bottomBtn.addEventListener('click', function () {
            var area = getActiveScrollArea();
            if (area) area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
        });
    }

    // ── Init ───────────────────────────────────────────────────────────────

    /**
     * Initialize the Inspector SPA. Called on `DOMContentLoaded` (or
     * immediately if the document is already loaded).
     *
     * Setup sequence:
     * 1. Apply theme (persisted or OS-preferred)
     * 2. Wire tab switching and restore persisted tab
     * 3. Wire Data tab controls (search, fold-all, raw mode, download)
     * 4. Install fold state persistence via `<details>` toggle events
     * 5. Wire Log tab controls (source/level filters, search, pause, clear)
     * 6. Wire log row selection (click, Shift+click, Ctrl/Cmd+click, Escape)
     * 7. Wire Ctrl/Cmd+C keyboard shortcut for copying selected logs
     * 8. Wire Query tab toolbar (filter dropdowns, search, copy-compiled)
     * 9. Initialize settings panel, env resize handle, scroll navigation
     * 10. Establish data source (opener > localStorage)
     * 11. Attempt engine.io and SSE connections
     * 12. Start data and log polling timers
     *
     * @inner
     */
    function init() {
        // Theme
        applyTheme(getPreferredTheme());
        var themeCb = qs('#bm-theme-cb');
        if (themeCb) {
            themeCb.addEventListener('change', function () {
                applyTheme(this.checked ? 'light' : 'dark');
            });
        }
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
                var stored = null;
                try { stored = localStorage.getItem(THEME_STORAGE_KEY); } catch (e) {}
                if (!stored) applyTheme(getPreferredTheme());
            });
        }

        // Tab switching — restore persisted tab
        qsa('.bm-tab').forEach(function (btn) {
            btn.addEventListener('click', function () { switchTab(this.dataset.tab); });
        });
        var _savedTab = null;
        try { _savedTab = localStorage.getItem(TAB_STORAGE_KEY); } catch (e) {}
        if (_savedTab) switchTab(_savedTab);

        // Data tab controls
        var dataSearch = qs('#bm-data-search');
        if (dataSearch) {
            dataSearch.addEventListener('input', function () {
                if (_dataSearchTimer) clearTimeout(_dataSearchTimer);
                _dataSearchTimer = setTimeout(function () { renderTab('data'); }, 200);
            });
            dataSearch.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') { this.value = ''; renderTab('data'); }
            });
        }
        var foldBtn = qs('#bm-fold-all');
        if (foldBtn) foldBtn.addEventListener('click', toggleFoldAll);
        var rawBtn = qs('#bm-raw');
        if (rawBtn) {
            rawBtn.addEventListener('click', function () {
                rawMode = !rawMode;
                this.classList.toggle('active', rawMode);
                renderTab('data');
            });
        }
        var dlBtn = qs('#bm-download');
        if (dlBtn) dlBtn.addEventListener('click', openDownloadModal);
        var dlCancel = qs('#bm-dl-cancel');
        if (dlCancel) dlCancel.addEventListener('click', function () { qs('#bm-dl-modal').classList.add('hidden'); });
        var dlConfirm = qs('#bm-dl-confirm');
        if (dlConfirm) dlConfirm.addEventListener('click', doDownload);

        // Fold state persistence
        ['data', 'view', 'forms', 'query'].forEach(function (tab) {
            var panel = qs('#tab-' + tab + ' .bm-scroll-area');
            if (panel) {
                panel.addEventListener('toggle', function (e) {
                    if (e.target.tagName === 'DETAILS' && e.target.dataset.path) {
                        var store = loadFoldStore();
                        if (!store[tab]) store[tab] = {};
                        store[tab][e.target.dataset.path] = e.target.open;
                        saveFoldStore(store);
                    }
                }, true);
            }
        });

        // Log controls — restore persisted values, rebuild level dropdown
        var _lvlFilter = qs('#bm-log-level');
        var _srcFilter = qs('#bm-log-source');
        try {
            var _savedSrc = localStorage.getItem(SOURCE_STORAGE_KEY);
            if (_savedSrc && _srcFilter) _srcFilter.value = _savedSrc;
            // Rebuild level options based on restored source, then restore level
            updateLevelDropdown(_savedSrc || '');
            var _savedLvl = localStorage.getItem(LEVEL_STORAGE_KEY);
            if (_savedLvl && _lvlFilter) _lvlFilter.value = _savedLvl;
        } catch (e) {}
        _lvlFilter.addEventListener('change', function () {
            try { localStorage.setItem(LEVEL_STORAGE_KEY, this.value); } catch (e) {}
            renderLogs();
        });
        qs('#bm-log-search').addEventListener('input', renderLogs);
        if (_srcFilter) _srcFilter.addEventListener('change', function () {
            try { localStorage.setItem(SOURCE_STORAGE_KEY, this.value); } catch (e) {}
            updateLevelDropdown(this.value);
            renderLogs();
        });
        qs('#bm-log-pause').addEventListener('click', function () {
            paused = !paused;
            this.textContent = paused ? '\u25B6 Resume' : '\u23F8 Pause';
        });
        qs('#bm-log-clear').addEventListener('click', function () {
            logs = [];
            highestLogLevel = '';
            selectedLogIds.clear();
            lastClickedLid = -1;
            var dot = qs('#bm-log-dot');
            if (dot) dot.className = 'bm-log-dot';
            try { logsOff = source && source !== 'localStorage' && source.__ginaLogs ? source.__ginaLogs.length : 0; } catch (e) {}
            renderLogs();
            updateSelectionUI();
        });

        // Dual badge — cancel clears selection, copy copies all selected rows
        var _selCopy   = qs('#bm-log-sel-copy');
        var _selCancel = qs('#bm-log-sel-cancel');
        if (_selCopy)   _selCopy.addEventListener('click', copySelectedLogs);
        if (_selCancel) _selCancel.addEventListener('click', function () {
            selectedLogIds.clear();
            lastClickedLid = -1;
            var allRows = qsa('.bm-log[data-lid]', qs('#bm-log-list'));
            for (var i = 0; i < allRows.length; i++) allRows[i].classList.remove('bm-log-selected');
            updateSelectionUI();
        });

        // Info button — toggle shortcut popover
        var _helpBtn = qs('#bm-log-help-btn');
        var _helpPop = qs('#bm-log-help-pop');
        if (_helpBtn && _helpPop) {
            _helpBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var nowOpen = _helpPop.classList.toggle('open');
                _helpBtn.classList.toggle('active', nowOpen);
            });
            document.addEventListener('click', function () {
                if (_helpPop.classList.contains('open')) {
                    _helpPop.classList.remove('open');
                    _helpBtn.classList.remove('active');
                }
            });
        }

        // Prevent browser drag-selection on log rows
        qs('#bm-log-list').addEventListener('mousedown', function (ev) {
            if (ev.target.closest('.bm-log[data-lid]')) ev.preventDefault();
        });

        // Log row selection — click, Shift+click, Ctrl/Cmd+click
        qs('#bm-log-list').addEventListener('click', function (ev) {
            var row = ev.target.closest('.bm-log[data-lid]');
            if (!row) return;
            var lid = +row.getAttribute('data-lid');
            if (ev.shiftKey && lastClickedLid >= 0) {
                var rows = qsa('.bm-log[data-lid]', this);
                var ids  = rows.map(function (r) { return +r.getAttribute('data-lid'); });
                var fromIdx = ids.indexOf(lastClickedLid);
                var toIdx   = ids.indexOf(lid);
                if (fromIdx !== -1 && toIdx !== -1) {
                    if (!ev.ctrlKey && !ev.metaKey) selectedLogIds.clear();
                    var lo = Math.min(fromIdx, toIdx), hi = Math.max(fromIdx, toIdx);
                    for (var j = lo; j <= hi; j++) selectedLogIds.add(ids[j]);
                }
            } else if (ev.ctrlKey || ev.metaKey) {
                if (selectedLogIds.has(lid)) selectedLogIds.delete(lid);
                else selectedLogIds.add(lid);
                lastClickedLid = lid;
            } else {
                // Plain click — select this row and immediately copy it
                selectedLogIds.clear();
                selectedLogIds.add(lid);
                lastClickedLid = lid;
                copySelectedLogs();
                row.classList.add('bm-log-row-copied');
                setTimeout(function () { row.classList.remove('bm-log-row-copied'); }, 900);
            }
            // Re-apply classes without full re-render
            var allRows = qsa('.bm-log[data-lid]', this);
            for (var i = 0; i < allRows.length; i++) {
                var r = allRows[i];
                r.classList.toggle('bm-log-selected', selectedLogIds.has(+r.getAttribute('data-lid')));
            }
            updateSelectionUI();
        });

        // Escape — deselect all
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && activeTab() === 'logs' && selectedLogIds.size > 0) {
                selectedLogIds.clear();
                lastClickedLid = -1;
                var allRows = qsa('.bm-log[data-lid]', qs('#bm-log-list'));
                for (var i = 0; i < allRows.length; i++) allRows[i].classList.remove('bm-log-selected');
                updateSelectionUI();
            }
        });

        // Ctrl/Cmd+C — copy selected when logs tab is active
        document.addEventListener('keydown', function (ev) {
            if ((ev.ctrlKey || ev.metaKey) && ev.key === 'c'
                    && activeTab() === 'logs' && selectedLogIds.size > 0) {
                var el = document.activeElement;
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
                ev.preventDefault();
                copySelectedLogs();
            }
        });

        // Ensure initial state is correct (badge hidden, info button visible)
        updateSelectionUI();

        setupCopy();

        // Query tab toolbar — filter and search handlers
        function rerenderQueries() {
            if (!_lastQueries) return;
            var panel = qs('#tree-query');
            if (panel) {
                panel.innerHTML = renderQueryContent(_lastQueries);
            }
        }

        var querySearchEl = qs('#bm-query-search');
        if (querySearchEl) {
            querySearchEl.addEventListener('input', function () {
                _querySearchTxt = this.value || '';
                rerenderQueries();
            });
        }
        var queryLangEl = qs('#bm-query-lang');
        if (queryLangEl) {
            queryLangEl.addEventListener('change', function () {
                _queryFilterLang = this.value;
                rerenderQueries();
            });
        }
        var queryConnEl = qs('#bm-query-connector');
        if (queryConnEl) {
            queryConnEl.addEventListener('change', function () {
                _queryFilterConnector = this.value;
                rerenderQueries();
            });
        }
        var queryBundleEl = qs('#bm-query-bundle');
        if (queryBundleEl) {
            queryBundleEl.addEventListener('change', function () {
                _queryFilterBundle = this.value;
                rerenderQueries();
            });
        }

        // Query copy-compiled-query — delegated click handler
        document.addEventListener('click', function (e) {
            var btn = e.target.closest('.bm-query-copy');
            if (!btn) return;
            var compiled = btn.getAttribute('data-compiled');
            if (!compiled) return;
            navigator.clipboard.writeText(compiled).then(function () {
                btn.classList.add('copied');
                setTimeout(function () { btn.classList.remove('copied'); }, 1200);
            });
        });

        setupSettings();
        setupEnvResize();
        setupScrollToTop();

        var ok = tryOpener() || tryLocalStorage();
        if (!ok) {
            hideLoader();
            qs('#bm-no-source').classList.remove('hidden');
            qs('#bm-dot').className = 'bm-dot err';
            qs('#bm-label').textContent = 'No source';
        }

        tryEngineIO();
        tryServerLogs();

        pollDataTimer = setInterval(pollData, pollDataMs);
        setInterval(pollLogs, POLL_LOGS_MS);

        pollData();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}());
