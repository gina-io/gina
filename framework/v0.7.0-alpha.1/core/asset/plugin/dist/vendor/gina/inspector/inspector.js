/**
 * @file Inspector SPA client — dev-mode diagnostic panel for Gina bundles.
 *
 * Single IIFE, no external dependencies, no build step. Served at
 * `{webroot}/_gina/inspector/` on the same origin as the monitored bundle.
 *
 * **Data channels** (in priority order):
 *   0. `/_gina/agent` SSE          — remote/standalone mode (`?target=` param);
 *      streams both data and logs via named events
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
 *   - Server-side SSE agent: `/_gina/agent` `event: log` (standalone mode only)
 *   - Server-side engine.io: `{ type: 'log' }` WebSocket messages (requires
 *     ioServer config)
 *
 * **Tabs:** Data, View, Forms, Query, Logs
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
 * @property {?Array<{name: string, primary: boolean}>} indexes - Index descriptors used by the query;
 *           `null` if the connector does not support index reporting, empty array if no indexes used
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
    /** @constant {number} Liveness-handshake window in ms for an ADOPTED bound
     *  channel (#B231): after `_adoptAdvertisedChannel()` binds the
     *  statusbar-advertised tab channel (which posts `{type:'request'}` on bind),
     *  a `{type:'data'}` reply must land within this window — a stale advert
     *  (its tab closed; localStorage outlives tabs) would otherwise strand the
     *  window on a silent channel. On expiry the adopt path tears down and hands
     *  over to the legacy bundle-global acquisition. */
    var ADOPT_HANDSHAKE_MS = 1500;
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
    /** @constant {string} localStorage key — window geometry (width, height, left, top) */
    var GEOMETRY_STORAGE_KEY = '__gina_inspector_geometry';
    /** @constant {string} localStorage key — environment panel resize height */
    var ENV_HEIGHT_STORAGE_KEY = '__gina_inspector_env_height';
    /** @constant {string} localStorage key — flow label column width */
    var FLOW_LABEL_WIDTH_KEY = '__gina_inspector_flow_label_width';
    /** @constant {string} localStorage key — query language filter */
    var QUERY_LANG_KEY = '__gina_inspector_query_lang';
    /** @constant {string} localStorage key — query connector filter */
    var QUERY_CONNECTOR_KEY = '__gina_inspector_query_connector';
    /** @constant {string} localStorage key — query bundle filter */
    var QUERY_BUNDLE_KEY = '__gina_inspector_query_bundle';
    /** @constant {string} localStorage key — tab layout preference (balanced/backend/frontend/custom) */
    var TAB_LAYOUT_KEY = '__gina_inspector_tab_layout';
    /** @constant {string} localStorage key — user-defined custom tab order */
    var CUSTOM_ORDER_KEY = '__gina_inspector_tab_layout_custom';
    /** @constant {string} localStorage key — hidden tabs in custom layout (JSON array of tab names) */
    var HIDDEN_TABS_KEY = '__gina_inspector_tab_layout_hidden';
    /** @constant {string} localStorage key — Reveal toggle state for Data tab (#R7 reveal) */
    var REVEAL_STORAGE_KEY = '__gina_inspector_reveal';

    /**
     * Tab order definitions for each layout preset.
     *
     * - **balanced** (default) — Data, View, Logs, Forms, Query, Flow, Stream, Events
     * - **backend** — Data, Query, Flow, Logs, View, Forms, Stream, Events
     * - **frontend** — View, Data, Forms, Logs, Query, Flow, Stream, Events
     *
     * Each array contains `data-tab` attribute values in display order.
     * @constant {Object.<string, string[]>}
     */
    var TAB_LAYOUTS = {
        balanced: ['data', 'view', 'logs', 'forms', 'query', 'flow', 'stream', 'events'],
        backend:  ['data', 'query', 'flow', 'logs', 'view', 'forms', 'stream', 'events'],
        frontend: ['view', 'data', 'forms', 'logs', 'query', 'flow', 'stream', 'events']
    };

    /**
     * Default performance anomaly thresholds.
     * Metrics exceeding `warn` get an amber indicator; exceeding `critical`
     * get a red indicator with stronger visual emphasis.
     * @constant {Object.<string, {warn: number, critical: number}>}
     */
    var PERF_THRESHOLDS = {
        loadMs:     { warn: 3000,    critical: 10000 },
        weight:     { warn: 1048576, critical: 5242880 },
        fcpMs:      { warn: 2500,    critical: 4000 },
        queryMs:    { warn: 500,     critical: 2000 },
        queryCount: { warn: 20,      critical: 50 }
    };

    /** @constant {RegExp} Matches UUID v4 strings */
    var RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    /** @constant {RegExp} Matches HTTP/HTTPS URLs */
    var RE_URL  = /^https?:\/\//i;

    /** @constant {Object} Keys to skip when rendering the View tab (components renders bespoke — #CC6) */
    var VIEW_SKIP = { scripts: 1, stylesheets: 1, components: 1 };
    /** @constant {Object} Keys whose children are recursively flattened into PROPERTIES */
    var VIEW_FLATTEN = { html: 1, properties: 1 };

    /**
     * @constant {string} Prefix marking framework-internal transport keys.
     *
     * `controller.render-json.js` embeds `__ginaQueries` / `__ginaFlow` at the
     * ROOT of a JSON body so a calling bundle can merge an upstream bundle's
     * query log and timeline (dev-gated there — no production leak). They are
     * transport, not application data, and the Query and Flow tabs already
     * render them first-class, so the Data tab hides them on every surface it
     * reads the payload from. #B340
     */
    var INTERNAL_KEY_PREFIX = '__gina';

    /**
     * Shallow-copy a data payload without its framework-internal transport keys.
     *
     * Root level only: {@link INTERNAL_KEY_PREFIX} keys are produced at the root
     * of the JSON body, so a NESTED key carrying the prefix is application data
     * and is deliberately left alone. Arrays and non-objects pass through by
     * reference — a root payload is a plain object, and copying arrays would
     * change how the tree renders them.
     *
     * @inner
     * @param   {*} obj - Data payload; only plain objects are filtered
     * @returns {*} Filtered shallow copy, or `obj` unchanged when not a plain object
     * @example
     * stripInternalKeys({ status: 200, __ginaFlow: [] }); // → { status: 200 }
     * stripInternalKeys({ a: { __ginaX: 1 } });           // → { a: { __ginaX: 1 } } (nested kept)
     * stripInternalKeys([1, 2]);                          // → [1, 2] (unchanged, same ref)
     */
    function stripInternalKeys(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
        var out  = {};
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].indexOf(INTERNAL_KEY_PREFIX) === 0) continue;
            out[keys[i]] = obj[keys[i]];
        }
        return out;
    }

    // ── State ──────────────────────────────────────────────────────────────
    /** @type {?Window|string} Data source — `Window` (opener), `'localStorage'`, or `null` */
    var source  = null;
    /**
     * Bound mode (#INS) — the per-tab BroadcastChannel the Inspector binds to
     * when the statusbar opened it with `?ch=<tabId>`. Scopes data to the ONE
     * tab that opened the Inspector (immune to other tabs'/XHR renders that
     * clobber the bundle-global localStorage + SSE channels COOP forces us onto
     * when it severs window.opener). `null` outside bound mode.
     * @type {?BroadcastChannel}
     */
    var _boundChannel = null;
    /**
     * Latest payload received over {@link _boundChannel}; read by pollData()
     * (source === 'broadcast'). The channel handler also calls pollData() for an
     * immediate apply, so the poll timer is only a fallback.
     * @type {?Object}
     */
    var _bcLatest = null;
    /** @type {?Object} Latest parsed `__ginaData` payload */
    var ginaData = null;
    /**
     * Live AI token-stream buffer (#AISTREAM). Single-slot: it resets whenever a
     * new stream id arrives, so the Stream tab tails the CURRENT stream. The
     * end-of-request snapshot (user.aiStream) carries every stream of the request.
     * @type {{id: ?string, frames: Object[]}}
     */
    var _aiStreamBuf = { id: null, frames: [] };
    /**
     * Live application-event buffer (#EVTBUS). Unlike the single-slot token buffer,
     * this ACCUMULATES discrete events (capped at EVENT_BUF_MAX) so the Event tab
     * shows the rolling sequence as they fire; the end-of-request snapshot
     * (user.events) carries the events of one request.
     * @type {Object[]}
     */
    var _eventBuf     = [];
    /** @constant {number} Cap on the rolling live event buffer. */
    var EVENT_BUF_MAX = 500;
    /** @type {LogEntry[]} In-memory log buffer (capped at {@link MAX_LOG_ENTRIES}) */
    var logs    = [];
    /** @type {number} Read offset into `source.__ginaLogs` for client-side polling */
    var logsOff = 0;
    /** @type {?Array} Last-seen `source.__ginaLogs` array reference — used to detect
     *  opener navigation, which replaces the array with a fresh empty one. When the
     *  reference changes, {@link logsOff} must be reset to 0. */
    var _lastLogsRef = null;
    /** @type {boolean} When true, new log entries are not appended */
    var paused  = false;
    /** @type {string} JSON.stringify of last processed ginaData — for change detection */
    var lastGdStr = '';
    /** @type {?(number|string)} `gina pid` of the running bundle as last reported by the
     *  live agent (SSE/WS) channel; the freshness reference {@link _isStaleSource} compares
     *  opener/localStorage polls against so a stale-process snapshot (e.g. an opener tab
     *  rendered before a bundle restart) cannot override live data. Null in pure
     *  opener/localStorage mode, which leaves the guard inert. */
    var _livePid = null;
    /** @type {?string} Normalised webroot of the bundle that established {@link _livePid}
     *  (recorded by {@link _noteLivePid}). Lets {@link _isStaleSource} tell a stale
     *  same-bundle snapshot (same webroot, older pid) from a payload of a DIFFERENT
     *  bundle of a proxy-routed multi-bundle project (different webroot — the monitored
     *  tab legitimately crossed a bundle boundary, not staleness). Null until known. (#B205) */
    var _livePidWebroot = null;
    /** @type {?EventSource} Live `/_gina/logs` SSE stream — kept module-level so
     *  {@link _followBundleChannels} can close and re-open it against another bundle's
     *  base when the monitored tab navigates across bundles. (#B205) */
    var _serverLogsEs = null;
    /** @type {?string} Normalised base path the server-side channels (`/_gina/logs` and
     *  the passive `/_gina/agent` stream) are currently pointed at. Compared against each
     *  applied payload's webroot by {@link _followBundleChannels}. (#B205) */
    var _channelBase = null;
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
    /** @type {boolean} When true, the Data tab uses the unredacted snapshot fetched from `/_gina/reveal` (#R7 reveal) */
    var _revealActive = false;
    /** @type {?Object} Cached unredacted Inspector payload from `/_gina/reveal` (local scope only) */
    var _revealedData = null;
    /** @type {?EventSource} Passive `/_gina/agent` subscription used alongside opener
     *  polling to receive pushed data/log frames from SPA (pushState/XHR) navigations
     *  that do not rewrite `window.__ginaData`. Null when no opener is available
     *  or when agent mode (`?target=`) is the primary source. */
    var _passiveAgentEs = null;

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
            var o   = raw ? JSON.parse(raw) : {};
            // Shape-guard (mirrors getCustomOrder / getHiddenTabs / tryLocalStorage):
            // a corrupted or tampered key could hold a JSON primitive (42 / true /
            // "x"); returning it would make the un-try/caught toggle handler run
            // `store[tab] = {}` on a primitive → strict-mode TypeError, breaking
            // fold persistence on every <details> toggle.
            return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
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

    /**
     * #CC6 — render the component census as a View-tab section. The census is
     * collected in-page by the statusbar (the SPA has no DOM access in bound
     * or COOP mode) and rides `user.view.components` additively. Undefined
     * custom elements — a typo'd tag name, a missing or failed definition
     * script — are otherwise a perfectly silent failure (an inert inline
     * element), so they surface first, in red.
     * @inner
     * @param {Object} census - { defined: {tag: count}, undefined: {tag: count}, undefinedCount: number }
     * @returns {string} HTML string (empty when the page has no custom elements)
     */
    function renderComponentsSection(census) {
        var defined = (census && census.defined) || {};
        var pending = (census && census.undefined) || {};
        var defKeys = Object.keys(defined);
        var undKeys = Object.keys(pending);
        if (!defKeys.length && !undKeys.length) { return ''; }
        var h = '<div class="bm-section">'
            + '<h2 class="bm-section-title">components</h2>';
        if (undKeys.length) {
            var total = (census && typeof census.undefinedCount === 'number')
                ? census.undefinedCount : undKeys.length;
            var undParts = [];
            for (var ui = 0; ui < undKeys.length; ui++) {
                undParts.push(escHtml('<' + undKeys[ui] + '> ×' + pending[undKeys[ui]]));
            }
            h += '<div class="bm-comp-undefined">'
                + escHtml(String(total)) + ' undefined component' + (total === 1 ? '' : 's')
                + ' — not upgraded: ' + undParts.join(', ')
                + '</div>';
        }
        if (defKeys.length) {
            var defParts = [];
            for (var di = 0; di < defKeys.length; di++) {
                defParts.push(escHtml('<' + defKeys[di] + '> ×' + defined[defKeys[di]]));
            }
            h += '<div class="bm-comp-defined">' + defParts.join(', ') + '</div>';
        }
        return h + '</div>';
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
     * Detect the template engine and version from server-emitted environment
     * data, with a heuristic fallback from view layout/ext when the field is
     * absent (legacy renders, test stubs, render-v1.js path).
     *
     * Does NOT use `env.engine` — that is the HTTP server engine (isaac/express),
     * not the template engine.
     *
     * @inner
     * @param   {Object} view - View data from `__ginaData.user.view`
     * @param   {Object} env  - Environment data from `__ginaData.user.environment`
     * @returns {{name: (string|null), version: (string|null)}}
     */
    function detectEngine(view, env) {
        // Server-emitted field wins — render-swig.js / render-nunjucks.js
        // populate env.templateEngine = { name, version } from the resolver
        // decision cache.
        if (env && env.templateEngine && typeof env.templateEngine === 'object') {
            return {
                name:    env.templateEngine.name || null,
                version: env.templateEngine.version || null
            };
        }

        // Fallback heuristic — view.layout path then view.ext.
        var name = null;
        if (view && typeof view.layout === 'string') {
            if (/swig[\/\\]/i.test(view.layout)) name = 'Swig';
            else if (/nunjucks[\/\\]|njk[\/\\]/i.test(view.layout)) name = 'Nunjucks';
        }
        if (!name && view && typeof view.ext === 'string') {
            if (view.ext === '.njk') name = 'Nunjucks';
            else if (view.ext === '.html') name = 'Swig';
        }
        return { name: name || 'Swig', version: null };
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
        var m = {
            weight: null, resourceSize: null, loadMs: null, transferMs: null, fcpMs: null, source: 'page',
            // Server-emitted fallback values (populated below from env.metrics).
            // These survive the COOP/no-opener case where window.opener is null
            // and the Performance API path returns the all-null skeleton.
            serverWeight: null, serverLoadMs: null
        };
        // Read server-side metrics from the env payload first — independent of
        // whether the opener is reachable.
        try {
            var _envMetrics = (ginaData && ginaData.user && ginaData.user.environment && ginaData.user.environment.metrics) || null;
            if (_envMetrics) {
                if (typeof _envMetrics.weightBytes === 'number') m.serverWeight = _envMetrics.weightBytes;
                if (typeof _envMetrics.serverMs    === 'number') m.serverLoadMs = _envMetrics.serverMs;
            }
        } catch (e) { /* defensive — leave server values null */ }
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

    // ── Performance anomaly detection ─────────────────────────────────────

    /**
     * Check page metrics and query data against performance thresholds.
     *
     * Returns an array of anomaly objects, each describing a metric that
     * exceeded its warning or critical threshold. An empty array means
     * no anomalies detected.
     *
     * @inner
     * @param {PageMetrics} metrics - Page performance metrics
     * @param {QueryEntry[]} [queries] - Query entries from the current request
     * @returns {Array<{metric: string, value: number, level: string, label: string}>}
     */
    function checkPerfAnomalies(metrics, queries) {
        var result = [];
        var t = PERF_THRESHOLDS;

        if (metrics.loadMs && metrics.loadMs > t.loadMs.warn) {
            var _lCrit = metrics.loadMs > t.loadMs.critical;
            result.push({
                metric: 'load', value: metrics.loadMs,
                level: _lCrit ? 'critical' : 'warn',
                label: 'Load ' + fmtMs(metrics.loadMs) + (_lCrit
                    ? ' (critical > ' + fmtMs(t.loadMs.critical) + ')'
                    : ' (slow > ' + fmtMs(t.loadMs.warn) + ')')
            });
        }
        if (metrics.weight && metrics.weight > t.weight.warn) {
            var _wCrit = metrics.weight > t.weight.critical;
            result.push({
                metric: 'weight', value: metrics.weight,
                level: _wCrit ? 'critical' : 'warn',
                label: 'Transfer ' + formatBytes(metrics.weight) + (_wCrit
                    ? ' (critical > ' + formatBytes(t.weight.critical) + ')'
                    : ' (large > ' + formatBytes(t.weight.warn) + ')')
            });
        }
        if (metrics.fcpMs && metrics.fcpMs > t.fcpMs.warn) {
            var _fCrit = metrics.fcpMs > t.fcpMs.critical;
            result.push({
                metric: 'fcp', value: metrics.fcpMs,
                level: _fCrit ? 'critical' : 'warn',
                label: 'FCP ' + fmtMs(metrics.fcpMs) + (_fCrit
                    ? ' (critical > ' + fmtMs(t.fcpMs.critical) + ')'
                    : ' (slow > ' + fmtMs(t.fcpMs.warn) + ')')
            });
        }

        if (queries && Array.isArray(queries)) {
            var _totalMs = 0;
            for (var qi = 0; qi < queries.length; qi++) {
                _totalMs += (queries[qi].durationMs || 0);
            }
            if (_totalMs > t.queryMs.warn) {
                var _qCrit = _totalMs > t.queryMs.critical;
                result.push({
                    metric: 'queryMs', value: _totalMs,
                    level: _qCrit ? 'critical' : 'warn',
                    label: 'Query total ' + fmtMs(_totalMs) + (_qCrit
                        ? ' (critical > ' + fmtMs(t.queryMs.critical) + ')'
                        : ' (slow > ' + fmtMs(t.queryMs.warn) + ')')
                });
            }
            if (queries.length > t.queryCount.warn) {
                var _cCrit = queries.length > t.queryCount.critical;
                result.push({
                    metric: 'queryCount', value: queries.length,
                    level: _cCrit ? 'critical' : 'warn',
                    label: queries.length + ' queries' + (_cCrit
                        ? ' (critical > ' + t.queryCount.critical + ')'
                        : ' (many > ' + t.queryCount.warn + ')')
                });
            }
        }

        return result;
    }

    /**
     * Update the View tab dot indicator based on detected anomalies.
     *
     * Uses the same visual pattern as the log-dot: 8px circle with
     * heartbeat animation, colored by severity (warn = amber, critical = red).
     *
     * @inner
     * @param {Array<{metric: string, level: string, label: string}>} anomalies
     */
    function updateViewDot(anomalies) {
        var dot = qs('#bm-view-dot');
        if (!dot) return;
        if (!anomalies || anomalies.length === 0) {
            dot.className = 'bm-view-dot';
            dot.title = '';
            return;
        }
        var hasCritical = false;
        var tips = [];
        for (var i = 0; i < anomalies.length; i++) {
            if (anomalies[i].level === 'critical') hasCritical = true;
            tips.push('\u26a0 ' + anomalies[i].label);
        }
        dot.className = 'bm-view-dot active ' + (hasCritical ? 'error' : 'warn');
        dot.title = tips.join('\n');
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

        // Empty state — no view data and no page metrics (JSON-only API).
        // Server-side metrics survive the COOP/no-opener case, so the
        // empty-state guard must also consider env.metrics; otherwise the
        // View tab would falsely render "No views attached" when only the
        // server-side fallback values are populated.
        var _emptyMetrics = true;
        try {
            if (source && source !== 'localStorage' && source.performance) {
                _emptyMetrics = false;
            }
            var _emSrvMet = (ginaData && ginaData.user && ginaData.user.environment && ginaData.user.environment.metrics) || null;
            if (_emSrvMet && (typeof _emSrvMet.weightBytes === 'number' || typeof _emSrvMet.serverMs === 'number')) {
                _emptyMetrics = false;
            }
        } catch (e) {}
        if (keys.length === 0 && _emptyMetrics) {
            return '<div class="bm-tab-empty">'
                + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="bm-tab-empty-icon">'
                + '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
                + '<p>No views attached to this response</p>'
                + '<span class="bm-tab-empty-hint">This tab shows DOM properties, page metrics, and template data for HTML responses.</span>'
                + '</div>';
        }

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
        var engineInfo    = detectEngine(view, env);
        var engine        = engineInfo.name;
        var engineVersion = engineInfo.version;
        var u = ginaData && ginaData.user ? ginaData.user : {};
        var isXhr = typeof u['view-xhr'] !== 'undefined';
        var metrics = getPageMetrics(isXhr);
        var _hasDataXhr = typeof u['data-xhr'] !== 'undefined';
        var _viewQueries = _hasDataXhr && u['data-xhr'] && u['data-xhr'].queries
            ? u['data-xhr'].queries : u.queries;
        var _anomalies = checkPerfAnomalies(metrics, _viewQueries || []);
        var _anomMap = {};
        for (var _ai = 0; _ai < _anomalies.length; _ai++) _anomMap[_anomalies[_ai].metric] = _anomalies[_ai];
        updateViewDot(_anomalies);
        var hasBadges = engine
            || metrics.weight  || metrics.serverWeight
            || metrics.loadMs  || metrics.transferMs || metrics.serverLoadMs
            || metrics.fcpMs;
        if (hasBadges) {
            h += '<div class="bm-view-badges">';
            if (engine) {
                var _engineTitle = 'Template engine'
                    + (engineVersion ? ': ' + engine + ' ' + engineVersion : '');
                h += '<span class="bm-vbadge bm-vbadge-engine" title="' + escHtml(_engineTitle) + '">'
                    + '<svg viewBox="0 0 16 16"><path d="M5.854 4.854a.5.5 0 10-.708-.708l-3.5 3.5a.5.5 0 000 .708l3.5 3.5a.5.5 0 00.708-.708L2.707 8l3.147-3.146zm4.292 0a.5.5 0 01.708-.708l3.5 3.5a.5.5 0 010 .708l-3.5 3.5a.5.5 0 01-.708-.708L13.293 8l-3.147-3.146z"/></svg>'
                    + escHtml(engine);
                if (engineVersion) {
                    h += '<span class="bm-vbadge-sep">|</span>'
                        + '<span class="bm-vbadge-ver">' + escHtml(engineVersion) + '</span>';
                }
                h += '</span>';
            }
            // Weight badge \u2014 dual rendering rules:
            //   1. server + client \u2192 server dimmed | client primary (most informative)
            //   2. client only with differing resourceSize \u2192 resource | transfer (legacy)
            //   3. server only \u2192 server primary (COOP / no-opener fallback)
            //   4. client only (no resource diff) \u2192 transfer single
            if (metrics.weight || metrics.serverWeight) {
                var _clientW = metrics.weight;
                var _serverW = metrics.serverWeight;
                var _res     = metrics.resourceSize;
                var _aw      = _anomMap['weight'];
                var _wtTitle, _wtBody;
                if (_clientW && _serverW) {
                    _wtTitle = 'Server: ' + formatBytes(_serverW) + ' (response body) | Client: ' + formatBytes(_clientW) + ' (browser transferSize)';
                    _wtBody  = '<span class="bm-vbadge-svr">' + formatBytes(_serverW) + '</span>'
                             + '<span class="bm-vbadge-sep">|</span>'
                             + formatBytes(_clientW);
                } else if (_clientW && _res && _res !== _clientW) {
                    _wtTitle = 'Resource: ' + formatBytes(_res) + ' | Transfer: ' + formatBytes(_clientW);
                    var _rp = splitBytes(_res), _xp = splitBytes(_clientW);
                    if (_rp.unit === _xp.unit) {
                        _wtBody = '<span class="bm-vbadge-res">' + _rp.num + '</span>'
                                + '<span class="bm-vbadge-sep">|</span>'
                                + _xp.num + _xp.unit;
                    } else {
                        _wtBody = '<span class="bm-vbadge-res">' + formatBytes(_res) + '</span>'
                                + '<span class="bm-vbadge-sep">|</span>'
                                + formatBytes(_clientW);
                    }
                } else if (_clientW) {
                    _wtTitle = isXhr ? 'XHR response transfer size' : 'Page transfer size (document)';
                    _wtBody  = formatBytes(_clientW);
                } else {
                    _wtTitle = 'Server response body size (client transferSize unavailable \u2014 window.opener.performance is null, e.g. under Cross-Origin-Opener-Policy)';
                    _wtBody  = formatBytes(_serverW);
                }
                h += '<span class="bm-vbadge bm-vbadge-weight' + (_aw ? ' bm-perf-' + _aw.level : '') + '" title="' + _wtTitle + (_aw ? '\n\u26a0 ' + _aw.label : '') + '">'
                    + '<svg viewBox="0 0 16 16"><path d="M3.5 1h9l2.5 14H1zM4.8 2.5h6.4l2 11H2.8z"/></svg>'
                    + _wtBody
                    + '</span>';
            }
            // Load badge \u2014 same four-way rules, applied to load time:
            //   1. server + client load \u2192 server dimmed | client primary
            //   2. client load + differing transfer time \u2192 load | transfer (legacy)
            //   3. server only \u2192 server primary (COOP / no-opener fallback)
            //   4. client only \u2192 load OR transfer single
            if (metrics.loadMs || metrics.transferMs || metrics.serverLoadMs) {
                var _ld     = metrics.loadMs;
                var _tf     = metrics.transferMs;
                var _srvLd  = metrics.serverLoadMs;
                var _al     = _anomMap['load'];
                var _ltTitle, _ltBody;
                if (_ld && _srvLd) {
                    _ltTitle = 'Server: ' + fmtMs(_srvLd) + ' (backend processing) | Client: ' + fmtMs(_ld) + ' (full page load: network + parse + paint)';
                    _ltBody  = '<span class="bm-vbadge-svr">' + fmtMs(_srvLd) + '</span>'
                             + '<span class="bm-vbadge-sep">|</span>'
                             + fmtMs(_ld);
                } else if (_ld && _tf && _ld !== _tf) {
                    _ltTitle = 'Load: ' + fmtMs(_ld) + ' | Transfer: ' + fmtMs(_tf);
                    _ltBody  = '<span class="bm-vbadge-res">' + fmtMs(_ld) + '</span>'
                             + '<span class="bm-vbadge-sep">|</span>'
                             + fmtMs(_tf);
                } else if (_ld || _tf) {
                    _ltTitle = isXhr ? 'XHR round-trip duration' : (_ld ? 'Page load time' : 'Document transfer time (requestStart \u2192 responseEnd)');
                    _ltBody  = fmtMs(_ld || _tf);
                } else {
                    _ltTitle = 'Server processing time (client load time unavailable \u2014 window.opener.performance is null, e.g. under Cross-Origin-Opener-Policy)';
                    _ltBody  = fmtMs(_srvLd);
                }
                h += '<span class="bm-vbadge bm-vbadge-load' + (_al ? ' bm-perf-' + _al.level : '') + '" title="' + _ltTitle + (_al ? '\n\u26a0 ' + _al.label : '') + '">'
                    + '<svg viewBox="0 0 16 16"><path d="M8 3.5a.5.5 0 00-1 0V8a.5.5 0 00.252.434l3.5 2a.5.5 0 00.496-.868L8 7.71V3.5z"/><path d="M8 16A8 8 0 108 0a8 8 0 000 16zm7-8A7 7 0 111 8a7 7 0 0114 0z"/></svg>'
                    + _ltBody
                    + '</span>';
            }
            if (metrics.fcpMs) {
                var _af = _anomMap['fcp'];
                h += '<span class="bm-vbadge bm-vbadge-fcp' + (_af ? ' bm-perf-' + _af.level : '') + '" title="First Contentful Paint' + (_af ? '\n\u26a0 ' + _af.label : '') + '">'
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

        // #CC6 — component census (statusbar-collected; bespoke red indicator)
        if (view.components && typeof view.components === 'object') {
            h += renderComponentsSection(view.components);
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
     * separately at the bottom — split in two (#B343): keys also present in
     * the pristine gina half (`__ginaData.gina.forms` — the server-emitted
     * bundle catalog built from the bundle's `forms/` directory groups such
     * as `rules`, `mocks`, `validators`, which the statusbar merge never
     * writes to) are demoted into one collapsed "Bundle catalog" card; keys
     * only present in the user half are runtime form state (e.g. a departed
     * popin form) and keep their own card.
     *
     * @inner
     * @param {Object} formsData - Forms data from `__ginaData.user.forms`
     * @param {Object} [ginaFormsData] - Gina forms data (pristine server half; also the diff overlay source)
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
            // Richer empty state when no opener page exists (JSON-only API)
            var _hasOpener = false;
            try { _hasOpener = !!(source && source !== 'localStorage' && source.document); } catch (e) {}
            if (!_hasOpener) {
                return '<div class="bm-tab-empty">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="bm-tab-empty-icon">'
                    + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
                    + '<p>No forms in this response</p>'
                    + '<span class="bm-tab-empty-hint">This tab shows form fields, validation state, and submitted data for HTML pages with forms.</span>'
                    + '</div>';
            }
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

        // Render forms from data that were NOT matched to a DOM form.
        // Keys also present in the pristine gina half are the server-emitted
        // bundle catalog (the walked `<bundle>/forms/` groups), not page
        // forms — collect them for the demoted catalog card below (#B343).
        // The statusbar merge only ever writes `u.forms[<id>]`, so `g.forms`
        // stays the untouched server snapshot: presence there is the
        // discriminator. When `g.forms` is absent every key falls through to
        // the legacy per-key card, so nothing is ever hidden.
        var catalogKeys = [];
        for (var dk = 0; dk < formKeys.length; dk++) {
            var dkName = formKeys[dk];
            if (rendered[dkName]) continue;
            if (Object.prototype.hasOwnProperty.call(ginaFormsData, dkName)) {
                catalogKeys.push(dkName);
                continue;
            }
            h += '<details class="bm-form-card" data-path="form.' + escHtml(dkName) + '">';
            h += '<summary class="bm-form-header">'
                + escHtml(dkName.toUpperCase())
                + chevronSvg + '</summary>';
            h += '<div class="bm-form-body">';
            h += renderFormDataSections(formsData[dkName], ginaFormsData[dkName]);
            h += '</div></details>';
        }

        // Bundle catalog — whole-bundle definitions, one group per
        // `<bundle>/forms/` subdirectory, demoted to a single collapsed and
        // visually muted card at the bottom so page forms keep the prime
        // space (#B343).
        if (catalogKeys.length > 0) {
            h += '<details class="bm-form-card bm-catalog-card" data-path="form.__catalog">';
            h += '<summary class="bm-form-header bm-catalog-header">BUNDLE CATALOG'
                + '<span class="bm-catalog-hint">' + escHtml(catalogKeys.join(' · ')) + '</span>'
                + chevronSvg + '</summary>';
            h += '<div class="bm-form-body">';
            for (var ck = 0; ck < catalogKeys.length; ck++) {
                var ckName = catalogKeys[ck];
                h += '<details class="bm-form-card bm-catalog-sub" data-path="form.' + escHtml(ckName) + '">';
                h += '<summary class="bm-form-header">'
                    + escHtml(ckName.toUpperCase())
                    + chevronSvg + '</summary>';
                h += '<div class="bm-form-body">';
                h += renderFormDataSections(formsData[ckName], ginaFormsData[ckName]);
                h += '</div></details>';
            }
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
            h += '<h3 class="bm-sub-section-title">' + escHtml(keys[k]) + '</h3>';
            h += renderTree(fd[keys[k]], 0, null, null, ginaFd ? ginaFd[keys[k]] : undefined);
        }
        return h;
    }

    // ── Tab management ─────────────────────────────────────────────────────

    /**
     * Get the currently active tab name.
     * @inner
     * @returns {string} Tab name (e.g. `'data'`, `'view'`, `'forms'`,
     *                   `'query'`, `'flow'`, `'logs'`)
     */
    function activeTab() {
        var active = qs('.bm-tab.active');
        return active ? active.dataset.tab : 'data';
    }

    /**
     * Reorder tab buttons in the header `nav.bm-tabs` to match the given
     * layout preset.  Moves existing DOM nodes (preserving event listeners)
     * by appending them in the order defined in {@link TAB_LAYOUTS}.
     *
     * For `'custom'`, reads the saved order from localStorage.  If none is
     * saved, the current DOM order is kept as-is.
     *
     * @inner
     * @param {string} layout - One of `'balanced'`, `'backend'`, `'frontend'`, `'custom'`
     */
    function applyTabLayout(layout) {
        var order;
        var nav = qs('.bm-tabs');
        if (!nav) return;
        var hidden = [];
        if (layout === 'custom') {
            order = getCustomOrder();
            hidden = getHiddenTabs();
            // Only enable drag-mode when settings panel is open
            var _panel = qs('#bm-settings');
            if (_panel && !_panel.classList.contains('hidden')) {
                nav.classList.add('bm-drag-mode');
            } else {
                nav.classList.remove('bm-drag-mode');
            }
        } else {
            order = TAB_LAYOUTS[layout];
            nav.classList.remove('bm-drag-mode');
        }
        if (!order) return;
        // Reorder visible tabs and append hidden ones at the end
        var allTabs = nav.querySelectorAll('.bm-tab');
        for (var i = 0; i < order.length; i++) {
            var btn = qs('.bm-tab[data-tab="' + order[i] + '"]');
            if (btn) nav.appendChild(btn);
        }
        // Show/hide based on hidden list
        for (var j = 0; j < allTabs.length; j++) {
            var name = allTabs[j].dataset.tab;
            if (layout === 'custom' && hidden.indexOf(name) !== -1) {
                allTabs[j].style.display = 'none';
            } else {
                allTabs[j].style.display = '';
            }
        }
        // Toggle × close buttons visibility
        var closeBtns = nav.querySelectorAll('.bm-tab-close');
        for (var c = 0; c < closeBtns.length; c++) {
            closeBtns[c].style.display = (layout === 'custom') ? '' : 'none';
        }
    }

    /**
     * Read the user's custom tab order from localStorage.
     * Returns `null` if no valid custom order is saved.
     *
     * @inner
     * @returns {?string[]} Array of tab names in custom order, or null
     */
    function getCustomOrder() {
        try {
            var raw = localStorage.getItem(CUSTOM_ORDER_KEY);
            if (raw) {
                var arr = JSON.parse(raw);
                // Accept 1..N tab names where N is the full preset roster
                // (tabs may be hidden, so shorter is fine). #B194 — this bound
                // was a stale literal 6: once the roster grew to 8 tabs, a
                // custom order saved with 7-8 visible tabs was rejected here
                // on every read and never survived a reload.
                if (Array.isArray(arr) && arr.length >= 1 && arr.length <= TAB_LAYOUTS.balanced.length) return arr;
            }
        } catch (e) {}
        return null;
    }

    /**
     * Save the current visible DOM tab order as the custom layout in localStorage.
     * Only saves tabs that are not hidden (display !== 'none').
     * @inner
     */
    function saveCustomOrder() {
        var nav = qs('.bm-tabs');
        if (!nav) return;
        var order = [];
        var tabs = nav.querySelectorAll('.bm-tab');
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].style.display !== 'none') {
                order.push(tabs[i].dataset.tab);
            }
        }
        try { localStorage.setItem(CUSTOM_ORDER_KEY, JSON.stringify(order)); } catch (e) {}
    }

    /**
     * Read the list of hidden tab names from localStorage.
     * @inner
     * @returns {string[]} Array of hidden tab names (empty if none)
     */
    function getHiddenTabs() {
        try {
            var raw = localStorage.getItem(HIDDEN_TABS_KEY);
            if (raw) {
                var arr = JSON.parse(raw);
                if (Array.isArray(arr)) return arr;
            }
        } catch (e) {}
        return [];
    }

    /**
     * Save the list of hidden tab names to localStorage.
     * @inner
     * @param {string[]} hidden - Array of tab names to hide
     */
    function saveHiddenTabs(hidden) {
        try { localStorage.setItem(HIDDEN_TABS_KEY, JSON.stringify(hidden)); } catch (e) {}
    }

    /**
     * Hide a tab in custom layout mode. Hides the tab button, persists the
     * hidden list, updates the custom order, and switches to the first
     * visible tab if the hidden tab was active.
     * @inner
     * @param {string} tabName - Tab name to hide (e.g. 'view', 'forms')
     */
    function hideTab(tabName) {
        var btn = qs('.bm-tab[data-tab="' + tabName + '"]');
        if (!btn) return;
        btn.style.display = 'none';

        // Persist
        var hidden = getHiddenTabs();
        if (hidden.indexOf(tabName) === -1) hidden.push(tabName);
        saveHiddenTabs(hidden);
        saveCustomOrder();
        renderLayoutPreview('custom');

        // Show the reset button (fade in)
        var resetBtn = qs('#bm-layout-reset');
        if (resetBtn) resetBtn.classList.remove('fade-out');

        // If the hidden tab was active, switch to first visible
        if (btn.classList.contains('active')) {
            var nav = qs('.bm-tabs');
            var visible = nav ? nav.querySelectorAll('.bm-tab') : [];
            for (var i = 0; i < visible.length; i++) {
                if (visible[i].style.display !== 'none') {
                    switchTab(visible[i].dataset.tab);
                    return;
                }
            }
        }
    }

    /**
     * Restore a single hidden tab in custom layout mode — the per-tab
     * inverse of {@link hideTab}, wired to the dimmed preview pills (see
     * {@link renderLayoutPreview}): the struck-through pill is the removed
     * tab's only remaining representative, so clicking it brings the tab
     * back without touching the others (Reset stays the bulk path).
     *
     * Removes the tab from the hidden list, shows its button again at the
     * END of the visible tabs — hiding dropped it from the saved custom
     * order and applyTabLayout parks hidden buttons at the FRONT of the
     * nav (only ordered visible tabs are appended), so the explicit
     * appendChild is what makes the landing spot deterministic; drag-mode
     * is active right there for repositioning — then persists the new
     * order and re-renders the preview.
     *
     * Deliberately does NOT activate the restored tab: the user is
     * mid-layout-editing, so the tab reappearing in the bar and its pill
     * un-dimming is the whole feedback — no panel switch.
     *
     * @inner
     * @param {string} tabName - Tab name to restore (e.g. 'view', 'forms')
     */
    function restoreTab(tabName) {
        var hidden = getHiddenTabs();
        var idx = hidden.indexOf(tabName);
        if (idx === -1) return;
        hidden.splice(idx, 1);
        saveHiddenTabs(hidden);

        var btn = qs('.bm-tab[data-tab="' + tabName + '"]');
        var nav = qs('.bm-tabs');
        if (btn) {
            btn.style.display = '';
            if (nav) nav.appendChild(btn);
        }
        saveCustomOrder();
        renderLayoutPreview('custom');
    }

    /**
     * Restore all hidden tabs in custom layout mode. Shows all tab buttons,
     * clears the hidden list from localStorage, and rebuilds the custom order
     * to include all tabs.
     * @inner
     */
    function restoreAllTabs() {
        var nav = qs('.bm-tabs');
        if (!nav) return;
        var tabs = nav.querySelectorAll('.bm-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].style.display = '';
        }
        saveHiddenTabs([]);
        saveCustomOrder();
        renderLayoutPreview('custom');
    }

    /**
     * Read the current tab order from the DOM.
     * @inner
     * @returns {string[]} Array of tab names in current DOM order
     */
    function getCurrentTabOrder() {
        var nav = qs('.bm-tabs');
        if (!nav) return TAB_LAYOUTS.balanced;
        var order = [];
        var tabs = nav.querySelectorAll('.bm-tab');
        for (var i = 0; i < tabs.length; i++) {
            order.push(tabs[i].dataset.tab);
        }
        return order;
    }

    /**
     * Briefly animate visible tab buttons to indicate they can be dragged
     * or hidden. Applied when entering custom mode. Each tab gets a staggered
     * nudge animation (subtle horizontal wiggle).
     * @inner
     */
    function nudgeTabs() {
        var nav = qs('.bm-tabs');
        if (!nav) return;
        var tabs = nav.querySelectorAll('.bm-tab');
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].style.display === 'none') continue;
            (function (tab, delay) {
                tab.classList.remove('bm-tab-nudge');
                // Force reflow so re-adding the class triggers the animation
                void tab.offsetWidth;
                setTimeout(function () {
                    tab.classList.add('bm-tab-nudge');
                    tab.addEventListener('animationend', function _h() {
                        tab.classList.remove('bm-tab-nudge');
                        tab.removeEventListener('animationend', _h);
                    });
                }, delay);
            })(tabs[i], i * 60);
        }
    }

    /**
     * Tab name → category color mapping for the layout preview pills.
     * Uses the same theme variables as the Flow tab category bars.
     * @constant {Object.<string, string>}
     * @inner
     */
    var TAB_PREVIEW_COLORS = {
        data:  'var(--info)',
        view:  'var(--ok)',
        logs:  'var(--text-dim)',
        forms: 'var(--warn)',
        query: 'var(--num)',
        flow:  'var(--accent)',
        stream: 'var(--str)',
        events: 'var(--warn)'
    };

    /**
     * Tab name → short display label for preview pills.
     * @constant {Object.<string, string>}
     * @inner
     */
    var TAB_PREVIEW_LABELS = {
        data: 'Data', view: 'View', logs: 'Logs',
        forms: 'Forms', query: 'Query', flow: 'Flow',
        stream: 'Stream', events: 'Events'
    };

    /**
     * Resolve a tab's preview-pill label. #B194 — the two newer tabs (stream,
     * events) were added to every TAB_LAYOUTS preset but not to the preview
     * maps, so their pills rendered the literal string "undefined". The maps
     * now carry them, and this fallback humanizes any FUTURE tab that misses
     * the map (capitalized tab name), so the class cannot fire again.
     *
     * @inner
     * @param {string} tab - Tab name (e.g. 'query')
     * @returns {string} Display label for the preview pill
     */
    function pillLabel(tab) {
        return TAB_PREVIEW_LABELS[tab] || (tab.charAt(0).toUpperCase() + tab.slice(1));
    }

    /**
     * Resolve a tab's preview-pill color, falling back to the neutral dim
     * color for a tab absent from the map (see {@link pillLabel} — #B194).
     *
     * @inner
     * @param {string} tab - Tab name
     * @returns {string} CSS color value for the pill's --pill-color
     */
    function pillColor(tab) {
        return TAB_PREVIEW_COLORS[tab] || 'var(--text-dim)';
    }

    /**
     * Render a row of tiny colored pills into `#bm-layout-preview` showing
     * the tab order for the given layout preset.  Each pill is color-coded
     * by tab category and connected by arrows.
     *
     * For `'custom'`, reads from localStorage or falls back to the current DOM order.
     *
     * @inner
     * @param {string} layout - One of `'balanced'`, `'backend'`, `'frontend'`, `'custom'`
     */
    function renderLayoutPreview(layout) {
        var el = qs('#bm-layout-preview');
        if (!el) return;
        var order = (layout === 'custom')
            ? (getCustomOrder() || getCurrentTabOrder())
            : TAB_LAYOUTS[layout];
        if (!order) { el.innerHTML = ''; return; }
        var hidden = (layout === 'custom') ? getHiddenTabs() : [];
        var html = '';
        // Show visible tabs, then hidden ones as dimmed
        var visibleFirst = true;
        for (var i = 0; i < order.length; i++) {
            var tab = order[i];
            var isHidden = hidden.indexOf(tab) !== -1;
            if (!isHidden) {
                if (!visibleFirst) html += '<span class="bm-lp-arrow">\u203A</span>';
                html += '<span class="bm-lp-pill" style="--pill-color:' + pillColor(tab) + '">'
                      + pillLabel(tab) + '</span>';
                visibleFirst = false;
            }
        }
        // Append hidden tabs as dimmed pills \u2014 each is a click-to-restore
        // control (delegated on #bm-layout-preview): it carries data-tab for
        // the handler, a native Restore tooltip, and a leading + glyph as
        // the visible affordance. Visible pills stay a passive readout.
        for (var h = 0; h < hidden.length; h++) {
            if (!visibleFirst) html += '<span class="bm-lp-arrow bm-lp-arrow-dim">\u203A</span>';
            html += '<span class="bm-lp-pill bm-lp-pill-hidden" data-tab="' + hidden[h] + '"'
                  + ' title="Restore ' + pillLabel(hidden[h]) + ' tab"'
                  + ' style="--pill-color:' + pillColor(hidden[h]) + '">'
                  + '<span class="bm-lp-pill-add">+</span>'
                  + pillLabel(hidden[h]) + '</span>';
            visibleFirst = false;
        }
        el.innerHTML = html;
        // Fade reset button in/out based on active layout
        var resetEl = qs('#bm-layout-reset');
        if (resetEl) resetEl.classList.toggle('fade-out', layout !== 'custom');
    }

    /**
     * Switch to a tab by name. Updates CSS classes on tab buttons and panels,
     * renders the new tab's content (except Logs which renders on its own
     * schedule), and persists the selection to localStorage.
     * @inner
     * @param {string} name - Tab name to activate
     */
    function switchTab(name) {
        // Guard: if the tab is hidden, fall back to the first visible tab
        var targetBtn = qs('.bm-tab[data-tab="' + name + '"]');
        if (targetBtn && targetBtn.style.display === 'none') {
            var nav = qs('.bm-tabs');
            var tabs = nav ? nav.querySelectorAll('.bm-tab') : [];
            for (var _fi = 0; _fi < tabs.length; _fi++) {
                if (tabs[_fi].style.display !== 'none') {
                    name = tabs[_fi].dataset.tab;
                    break;
                }
            }
        }
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
            // #AISTREAM \u2014 the Stream tab renders its live token buffer even before
            // a snapshot exists, so don't blank it with the "Waiting\u2026" hint.
            if (name === 'stream') { renderAiStream(treeEl, null); return; }
            // #EVTBUS — same for the Event tab's rolling live buffer.
            if (name === 'events') { renderAppEvents(treeEl, null); return; }
            treeEl.innerHTML = '<span class="bm-hint">Waiting for source data\u2026</span>';
            return;
        }

        captureFoldState(name);

        // #R7 reveal — when active, swap in the unredacted payload fetched from
        // /_gina/reveal. Only Data/View/Forms/Query/Flow render from `u`/`g`,
        // so a single source swap covers every visible field.
        var src = (_revealActive && _revealedData) ? _revealedData : ginaData;
        var u = src.user || {};
        var g = src.gina || {};
        var content = '';
        var hasXhr = typeof u['data-xhr'] !== 'undefined';

        switch (name) {
            case 'data':
                // #B340 — strip at the source resolution point so every Data
                // surface agrees: tree, root scalars, size badge and search all
                // read from `dataObj`. `ginaObj` is stripped in step so the diff
                // overlay does not report the hidden keys as removed.
                var dataObj = stripInternalKeys(hasXhr ? u['data-xhr'] : u.data);
                var ginaObj = stripInternalKeys(hasXhr ? (g['data-xhr'] || g.data) : g.data);
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
            case 'flow':
                var flowData = hasXhr && u['data-xhr'] && u['data-xhr'].flow
                    ? u['data-xhr'].flow : u.flow;
                content = renderFlowContent(flowData);
                break;
            case 'stream':
                // #AISTREAM — render the snapshot (or live buffer) via textContent
                // and return before the innerHTML/fold path; token text is untrusted.
                renderAiStream(treeEl, u.aiStream);
                return;
            case 'events':
                // #EVTBUS — render the rolling live buffer (or the request snapshot)
                // via textContent; return before the innerHTML/fold path. Event
                // names + metadata are app-controlled but treated as untrusted.
                renderAppEvents(treeEl, u.events);
                appendClientEvents(treeEl, u.clientEvents); // #CC6 — component protocol events
                return;
        }

        treeEl.innerHTML = content || '<span class="bm-empty">No data</span>';
        restoreFoldState(name);
    }

    // ── AI token-stream tab (#AISTREAM) ──────────────────────────────────────

    /**
     * Append one live AI token-stream frame to the single-slot buffer and, when
     * the Stream tab is active, re-render it. The buffer resets whenever a new
     * stream id arrives, so the pane tails the current stream; the end-of-request
     * snapshot (`user.aiStream`) carries every stream of the request. Frame shape:
     * `{ phase:'start'|'delta'|'done'|'error', id, t, ... }`.
     * @inner
     * @param {Object} frame - The `inspector#token` frame, already transport-unwrapped.
     */
    function appendTokenDelta(frame) {
        if (!frame || typeof frame !== 'object' || !frame.phase) return;
        if (frame.id !== _aiStreamBuf.id) {
            _aiStreamBuf = { id: frame.id || null, frames: [] };   // reset on a new stream id
        }
        _aiStreamBuf.frames.push(frame);
        // Live-tail the buffer directly when the tab is open — NOT via renderTab,
        // which prioritises the end-of-request snapshot (stale while a NEW stream is
        // mid-flight, before its inspector#data snapshot has arrived).
        if (activeTab() === 'stream') {
            var el = qs('#tree-stream');
            if (el) el.textContent = formatAiLiveBuffer(_aiStreamBuf);
        }
    }

    /**
     * Format the live token buffer as a plain-text transcript (header + meta line
     * + accumulated text). Token text is rendered into the pane via textContent by
     * the caller — never innerHTML — since it is untrusted model output.
     * @inner
     * @param {{id: ?string, frames: Object[]}} buf
     * @returns {string}
     */
    function formatAiLiveBuffer(buf) {
        if (!buf || !buf.id) return '';
        var model = '', role = '', text = '', chunks = 0, tokens = null, status = 'streaming…';
        buf.frames.forEach(function (f) {
            if (f.phase === 'start') { model = f.model || ''; role = f.role || ''; }
            else if (f.phase === 'delta') {
                chunks++;
                if (typeof f.outputTokens === 'number') tokens = f.outputTokens;
                if (typeof f.deltaText === 'string') text += f.deltaText;
            } else if (f.phase === 'done') {
                if (typeof f.outputTokens === 'number') tokens = f.outputTokens;
                if (f.model) model = f.model;
                status = 'done' + (typeof f.latencyMs === 'number' ? ' · ' + f.latencyMs + 'ms' : '');
            } else if (f.phase === 'error') {
                status = 'error' + (f.message ? ' · ' + f.message : '');
            }
        });
        var head = 'stream ' + buf.id + (model ? '  ' + model : '') + (role ? '  [' + role + ']' : '');
        var meta = 'chunks=' + chunks + (tokens !== null ? '  tokens=' + tokens : '') + '  ' + status;
        return head + '\n' + meta + (text ? '\n\n' + text : '');
    }

    /**
     * Format the end-of-request AI-stream snapshot (`user.aiStream`) as plain text,
     * one block per completed stream. `prompt`/`text` appear only when
     * `inspector.ai.captureText` is enabled server-side.
     * @inner
     * @param {Object[]} arr
     * @returns {string}
     */
    function formatAiStreamSnapshot(arr) {
        if (!arr || !arr.length) return '';
        return arr.map(function (e) {
            var head = '● ' + (e.model || '?')
                + (e.role ? '  [' + e.role + ']' : '')
                + (e.provider ? '  ' + e.provider : '')
                + (e.origin ? '  @' + e.origin : '');
            var bits = [];
            if (typeof e.chunks === 'number') bits.push('chunks ' + e.chunks);
            if (e.promptTokens !== null && typeof e.promptTokens !== 'undefined') bits.push('in ' + e.promptTokens);
            if (e.outputTokens !== null && typeof e.outputTokens !== 'undefined') bits.push('out ' + e.outputTokens);
            if (typeof e.durationMs === 'number') bits.push(e.durationMs + 'ms');
            var lines = [head];
            if (bits.length) lines.push('  ' + bits.join(' · '));
            if (e.error) lines.push('  error: ' + e.error);
            if (typeof e.prompt !== 'undefined') {
                lines.push('  prompt: ' + (typeof e.prompt === 'string' ? e.prompt : JSON.stringify(e.prompt)));
            }
            if (typeof e.text === 'string' && e.text) lines.push('  text: ' + e.text);
            return lines.join('\n');
        }).join('\n\n');
    }

    /**
     * Render the Stream tab pane: the end-of-request snapshot when present, else
     * the live token buffer. Always writes textContent — token text is untrusted
     * model output and is never interpolated as HTML.
     * @inner
     * @param {Element} el - The `#tree-stream` pane.
     * @param {?Object[]} snapshot - `user.aiStream`, or null when no snapshot yet.
     */
    function renderAiStream(el, snapshot) {
        if (!el) return;
        if (snapshot && snapshot.length) {
            el.textContent = formatAiStreamSnapshot(snapshot);
        } else if (_aiStreamBuf && _aiStreamBuf.id) {
            el.textContent = formatAiLiveBuffer(_aiStreamBuf);
        } else {
            el.textContent = 'No AI streams captured this request.';
        }
    }

    // ── Application-event tab (#EVTBUS) ──────────────────────────────────────

    /**
     * Append one live application-event frame to the rolling buffer (capped at
     * EVENT_BUF_MAX) and, when the Event tab is active, re-render it directly.
     * Unlike appendTokenDelta (single-slot, reset per stream id), events ACCUMULATE
     * — each frame is one discrete event. Rendered via textContent (event names +
     * optional metadata are app-controlled but treated as untrusted).
     * @inner
     * @param {Object} frame - The inspector#event frame `{ name, id, t, meta? }`.
     */
    function appendAppEvent(frame) {
        if (!frame || typeof frame !== 'object' || !frame.name) { return; }
        _eventBuf.push(frame);
        if (_eventBuf.length > EVENT_BUF_MAX) { _eventBuf.shift(); }
        // Live-tail directly when the tab is open — NOT via renderTab (which a data
        // snapshot would re-render). Mirrors appendTokenDelta's direct-render.
        if (activeTab() === 'events') {
            var el = qs('#tree-events');
            if (el) { el.textContent = formatEventBuffer(_eventBuf); }
        }
    }

    /**
     * Format an array of event frames/entries as a plain-text transcript — one line
     * per event (time · name · compact metadata, present only when captureArgs is
     * enabled server-side). Rendered via textContent by the caller; never innerHTML.
     * @inner
     * @param {Object[]} arr
     * @returns {string}
     */
    function formatEventBuffer(arr) {
        if (!arr || !arr.length) { return 'No events captured.'; }
        return arr.map(function (e) {
            var ts = '';
            try { ts = new Date(e.t).toISOString().substr(11, 12); } catch (x) { ts = ''; }
            var line = (ts ? ts + '  ' : '') + (e.name || '?');
            if (e.meta && typeof e.meta === 'object') {
                var s;
                try { s = JSON.stringify(e.meta); } catch (x) { s = '[unserialisable]'; }
                line += '  ' + s;
            }
            return line;
        }).join('\n');
    }

    /**
     * Render the Event tab pane. Prefers the rolling live buffer (events accumulate
     * across the session); falls back to the request snapshot (`user.events`) when
     * no live frames have arrived (e.g. opener-only mode without an agent stream).
     * Always textContent — event names + metadata are treated as untrusted.
     * @inner
     * @param {Element} el - The `#tree-events` pane.
     * @param {?Object[]} snapshot - `user.events`, or null.
     */
    function renderAppEvents(el, snapshot) {
        if (!el) { return; }
        if (_eventBuf.length) {
            el.textContent = formatEventBuffer(_eventBuf);
        } else if (snapshot && snapshot.length) {
            el.textContent = formatEventBuffer(snapshot);
        } else {
            el.textContent = 'No events captured.';
        }
    }

    /**
     * #CC6 — format the client-side component-event buffer (the statusbar's
     * dispatchEvent capture: composed bubbling CustomEvents named
     * `<tag>:<verb>`). One line per event: time, name, emitting element and —
     * only when the server-side capture gate is opted in — the redacted
     * `detail` payload.
     * @inner
     * @param {?Object[]} arr - `user.clientEvents`, or null.
     * @returns {string}
     */
    function formatClientEventBuffer(arr) {
        return arr.map(function (e) {
            var ts = '';
            try { ts = new Date(e.t).toISOString().substr(11, 12); } catch (x) { ts = ''; }
            var line = (ts ? ts + '  ' : '') + (e.name || '?') + (e.target ? '  ' + e.target : '');
            if (typeof e.meta !== 'undefined') {
                var s;
                try { s = JSON.stringify(e.meta); } catch (x) { s = '[unserialisable]'; }
                line += '  ' + s;
            }
            return line;
        }).join('\n');
    }

    /**
     * #CC6 — append the client component-event block to the Events pane,
     * below the server events. Always textContent — event names, targets and
     * detail payloads are page-controlled and treated as untrusted.
     * @inner
     * @param {Element} el - The `#tree-events` pane.
     * @param {?Object[]} clientEvents - `user.clientEvents`, or null.
     */
    function appendClientEvents(el, clientEvents) {
        if (!el || !clientEvents || !clientEvents.length) { return; }
        el.textContent += '\n\n── Client component events ──\n'
            + formatClientEventBuffer(clientEvents);
    }

    /**
     * Render the Data tab in raw JSON mode (pretty-printed `<pre>` block).
     * @inner
     * @param {Element} treeEl - Container element to render into
     */
    function renderRaw(treeEl) {
        if (!ginaData) { treeEl.innerHTML = '<span class="bm-hint">No data to display</span>'; return; }
        var src = (_revealActive && _revealedData) ? _revealedData : ginaData;
        var u = src.user || {};
        var data = stripInternalKeys(u['data-xhr'] || u.data); // #B340
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
    /** @type {?number} Debounce timer for query search input */
    var _querySearchTimer = null;
    /** @constant {number} Max query cards to show before "Show all" button */
    var QUERY_PAGE_SIZE = 20;
    /** @type {boolean} Whether all query cards should be shown (pagination override) */
    var _queryShowAll = false;
    /**
     * #QI2 — Cached live index data from /_gina/indexes endpoint.
     * null = not yet fetched; object = fetched (may be empty).
     * @type {?{connectors: Object.<string, {type: string, database: string, tables: Object}>}}
     */
    var _liveIndexes = null;
    /** @type {boolean} Whether a /_gina/indexes fetch is in progress */
    var _liveIndexesFetching = false;

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
     * Resolve the base URL prefix for a per-bundle `/_gina/*` endpoint.
     *
     * Three-fallback resolver (the same logic `toggleReveal()` uses): (1) a
     * `?target=` query param (standalone mode), (2) the opener's pathname
     * (statusbar-opened mode — routes to the bundle that rendered the current
     * page), (3) the Inspector's own pathname with `_gina/inspector...` stripped.
     * Critical in proxy-routed multi-bundle setups where bundles share a host and
     * differ only by a path prefix: a bare `/_gina/logs` or `/_gina/indexes` would
     * otherwise hit the proxy's default bundle instead of the monitored one.
     *
     * Used by every per-bundle `/_gina/*` consumer: `fetchLiveIndexes()`,
     * `tryServerLogs()`, `toggleReveal()`, `tryAgentPassive()`, and the
     * refresh-button re-reveal all resolve their base through this one helper
     * (pinned by inspector.test.js §54/§55/§56/§79). For `tryAgentPassive()`
     * the `?target=` branch is inert — it only runs when no `?target=` exists.
     *
     * @inner
     * @returns {string} Base URL prefix (no trailing slash), or '' for host root.
     */
    function resolveBundleBase() {
        try {
            var params = new URLSearchParams(window.location.search);
            var target = (params.get('target') || '').replace(/\/+$/, '');
            if (target) {
                return target;
            }
            if (window.opener && window.opener.location) {
                return (window.opener.location.pathname || '').replace(/\/+$/, '');
            }
        } catch (e) {}
        return window.location.pathname.replace(/\/_gina\/inspector.*$/, '').replace(/\/+$/, '');
    }

    /**
     * #QI2 — Fetch live index data from the /_gina/indexes endpoint.
     * Called when the Query tab renders queries with N/A index badges.
     * On success, caches the result and re-renders the Query tab's tree
     * root (`#tree-query`) — the container {@link renderTab} owns. It must
     * never replace the scroll wrapper's children instead: `#tree-query`
     * lives INSIDE the wrapper, so a wrapper-level write destroys it and
     * every later `renderTab('query')` bails on the missing container —
     * freezing the Query pane and badge until the Inspector reloads (#B222).
     *
     * @inner
     */
    function fetchLiveIndexes() {
        if (_liveIndexes !== null || _liveIndexesFetching) return;
        _liveIndexesFetching = true;
        // Route through the shared 3-fallback resolver so /_gina/indexes reaches
        // the monitored bundle in proxy-routed multi-bundle setups (was a bare
        // pathname strip that misrouted to the proxy's default bundle).
        var base = resolveBundleBase();
        var url  = base + '/_gina/indexes';
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.onload = function() {
                _liveIndexesFetching = false;
                if (xhr.status === 200) {
                    try {
                        _liveIndexes = JSON.parse(xhr.responseText);
                        // Re-render query tab if we have queries — into
                        // #tree-query, the container renderTab() owns (#B222).
                        // Writing the scroll wrapper here instead destroyed
                        // #tree-query (a child of the wrapper), after which
                        // every later renderTab('query') bailed on the missing
                        // container and the Query pane froze until reload.
                        // #B225 — the queries derive from the live payload
                        // exactly as renderTab('query') does (reveal swap
                        // included), never from the module query cache: the
                        // cache survives overlay eras that ended while the
                        // Query tab was inactive, so a cached repaint after
                        // the forced refetch resurrected dead queries and
                        // rewrote the badge over the truthful one.
                        var src = (_revealActive && _revealedData) ? _revealedData : ginaData;
                        var u = (src && src.user) || {};
                        var hasXhr = typeof u['data-xhr'] !== 'undefined';
                        var queryData = hasXhr && u['data-xhr'] && u['data-xhr'].queries
                            ? u['data-xhr'].queries : u.queries;
                        if (queryData && queryData.length) {
                            var panel = qs('#tree-query');
                            if (panel) panel.innerHTML = renderQueryContent(queryData);
                        }
                    } catch (e) { _liveIndexes = { connectors: {} }; }
                }
            };
            xhr.onerror = function() { _liveIndexesFetching = false; };
            xhr.send();
        } catch (e) { _liveIndexesFetching = false; }
    }

    /**
     * #QI2 — Resolve live index data for a query entry that has null indexes.
     * Looks up the connector:database key in _liveIndexes, then resolves by
     * extracting the target table from the statement.
     *
     * #QI Phase C.3 — descriptors are CLONED and stamped with a per-query
     * `covers` flag (leftmost-prefix vs `q.whereColumns`), mirroring the
     * server-side sql-parser annotateCoverage so the live (no indexes.sql) path
     * renders the same bm-idx-uncovered badge as the declared-index path. The
     * shared _liveIndexes cache is never mutated.
     *
     * @inner
     * @param {object} q - Query entry with `q.indexes === null`
     * @returns {?Array<{name: string, primary: boolean, columns: Array<string>, covers: boolean}>} Resolved indexes (cloned), [] when the table has none, or null when unresolvable
     */
    function resolveLiveIndexes(q) {
        if (!_liveIndexes || !_liveIndexes.connectors) return null;
        // Try connector:database key; fall back to first matching connector type
        var connKey = null;
        var keys = Object.keys(_liveIndexes.connectors);
        for (var k = 0; k < keys.length; k++) {
            if (_liveIndexes.connectors[keys[k]].type === q.connector) {
                connKey = keys[k];
                break;
            }
        }
        if (!connKey) return null;
        var tables = _liveIndexes.connectors[connKey].tables;
        if (!tables) return null;
        // Use the table field if available; otherwise extract from statement
        var tbl = q.table || extractTableFromStatement(q.statement);
        if (!tbl) return null;
        var live = tables[tbl];
        if (!live) return [];
        // Clone each descriptor (never mutate the shared cache — two queries on the
        // same table may filter different columns) and stamp `covers` via the
        // leftmost-prefix rule: an index serves the filter only if its FIRST column
        // is among the query's WHERE columns. Same logic as sql-parser annotateCoverage.
        var wc  = q.whereColumns || [];
        var out = [];
        for (var i = 0; i < live.length; i++) {
            var cols = live[i].columns || [];
            out.push({
                name    : live[i].name,
                primary : !!live[i].primary,
                columns : cols.slice(),
                covers  : (cols.length > 0 && wc.length > 0 && wc.indexOf(cols[0]) > -1)
            });
        }
        return out;
    }

    /**
     * #QI2 — Simple client-side table name extraction from SQL statements.
     * @inner
     * @param {string} stmt - SQL or N1QL statement
     * @returns {?string} Lowercase table name, or null
     */
    function extractTableFromStatement(stmt) {
        if (!stmt) return null;
        var m = stmt.match(/\bFROM\s+[`"']?(\w+)[`"']?/i)
            || stmt.match(/\bINTO\s+[`"']?(\w+)[`"']?/i)
            || stmt.match(/\bUPDATE\s+[`"']?(\w+)[`"']?/i);
        return m ? m[1].toLowerCase() : null;
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
    var _svgIdx    = '<svg viewBox="0 0 16 16"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v1A1.5 1.5 0 0112.5 6h-9A1.5 1.5 0 012 4.5v-1zm1.5 0a.5.5 0 00-.5.5v.5a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V4a.5.5 0 00-.5-.5h-9zM2 8.5A1.5 1.5 0 013.5 7h5A1.5 1.5 0 0110 8.5v1A1.5 1.5 0 018.5 11h-5A1.5 1.5 0 012 9.5v-1zm1.5 0a.5.5 0 00-.5.5v.5a.5.5 0 00.5.5h5a.5.5 0 00.5-.5V9a.5.5 0 00-.5-.5h-5zM2 13a1 1 0 011-1h3a1 1 0 110 2H3a1 1 0 01-1-1z"/></svg>';
    var _svgIdxWarn = '<svg viewBox="0 0 16 16"><path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5a.905.905 0 00-.9.995l.35 3.507a.553.553 0 001.1 0l.35-3.507A.905.905 0 008 5zm.002 6a1 1 0 100 2 1 1 0 000-2z"/></svg>';

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

        // Tab badge color — three tiers:
        //   red  (err)  : missing index OR both time slow + weight heavy
        //   warn        : only one of time slow / weight heavy
        //   default     : everything ok
        if (tabBadge) {
            if (hasQueries) {
                tabBadge.textContent = queries.length;
                tabBadge.classList.remove('hidden');
                var hasIdxIssue = false;
                for (var qi = 0; qi < queries.length; qi++) {
                    var qIdx = queries[qi].indexes;
                    if (qIdx !== null && qIdx !== undefined && qIdx.length === 0) {
                        hasIdxIssue = true;
                        break;
                    }
                }
                var isSlow  = durationClass(totalMs) === 'slow';
                var isHeavy = weightClass(totalSize, filtered.length) === 'heavy';
                var isErr   = hasIdxIssue || (isSlow && isHeavy);
                var isWarn  = !isErr && (isSlow || isHeavy);
                tabBadge.classList.toggle('bm-tab-badge-err',  isErr);
                tabBadge.classList.toggle('bm-tab-badge-warn', isWarn);
            } else {
                tabBadge.classList.add('hidden');
                tabBadge.classList.remove('bm-tab-badge-err');
                tabBadge.classList.remove('bm-tab-badge-warn');
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
        var limit = (_queryShowAll || filtered.length <= QUERY_PAGE_SIZE) ? filtered.length : QUERY_PAGE_SIZE;
        var noIndexItems = []; // cards with supported but missing indexes
        var perfItems    = []; // cards that are slow (>= 500ms) or heavy (avg >= 100 KB)

        for (var i = 0; i < limit; i++) {
            var q = filtered[i];
            var hasError = q.error ? ' bm-query-has-error' : '';
            var durCls = '';
            if (q.durationMs > 500) durCls = ' bm-query-slow';
            else if (q.durationMs > 100) durCls = ' bm-query-medium';

            var cardId = 'bm-qcard-' + i;

            // Track queries with supported but missing indexes
            if (q.indexes !== null && q.indexes !== undefined && q.indexes.length === 0) {
                noIndexItems.push({ id: cardId, trigger: q.trigger || q.type || ('Query #' + (i + 1)) });
            }

            // Track slow or heavy queries
            var _isSlow  = (q.durationMs || 0) >= 500;
            var _isHeavy = weightClass(q.resultSize || 0, 1) === 'heavy';
            if (_isSlow || _isHeavy) {
                var reason = _isSlow && _isHeavy ? 'slow + heavy'
                    : _isSlow ? 'slow (' + fmtMs(q.durationMs) + ')'
                    : 'heavy (' + formatSize(q.resultSize) + ')';
                perfItems.push({ id: cardId, trigger: q.trigger || q.type || ('Query #' + (i + 1)), reason: reason });
            }

            h += '<div class="bm-query-card' + hasError + '" id="' + cardId + '">'
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
                sizeHtml = '<span class="bm-query-size bm-stat-' + weightClass(q.resultSize, 1) + '">' + formatSize(q.resultSize) + '</span>';
            }

            h += '<span class="bm-query-right">'
                + triggerHtml
                + sizeHtml
                + '<span class="bm-query-timing' + durCls + '">' + fmtMs(q.durationMs || 0) + '</span>'
                + '</span>'
                + '</div>';

            if (q.statement) {
                var compiled = compileQuery(q.statement, q.params);

                // #QI2 — resolve live indexes for N/A entries
                if ((q.indexes === null || q.indexes === undefined) && _liveIndexes) {
                    var _resolved = resolveLiveIndexes(q);
                    if (_resolved !== null) q.indexes = _resolved;
                }

                // Index badges (inline in stmt meta bar, left of rows count)
                var indexHtml = '';
                if (q.indexes !== null && q.indexes !== undefined) {
                    if (q.indexes.length === 0) {
                        indexHtml = '<span class="bm-query-idx bm-idx-none" title="No index used — full bucket scan">'
                            + _svgIdxWarn + ' no index</span>';
                    } else {
                        // #QI Phase C — the table has indexes; if none lead with a
                        // filtered column (leftmost-prefix), this query's filter
                        // cannot use them — surface that gap rather than implying
                        // coverage. covers/whereColumns are heuristic (declared
                        // indexes vs WHERE columns), not a planner verdict.
                        var _hasWhere  = q.whereColumns && q.whereColumns.length > 0;
                        var _anyCovers = false;
                        if (_hasWhere) {
                            for (var _ci = 0; _ci < q.indexes.length; _ci++) {
                                if (q.indexes[_ci].covers) { _anyCovers = true; break; }
                            }
                        }
                        if (_hasWhere && !_anyCovers) {
                            var _wc = q.whereColumns.join(', ');
                            indexHtml = '<span class="bm-query-idx bm-idx-uncovered" title="Indexes exist on this table, but none lead with a filtered column ('
                                + escHtml(_wc) + ') — this query cannot use them. Add an index starting with one of these columns.">'
                                + _svgIdxWarn + ' no index for filter</span>';
                        } else {
                            for (var ix = 0; ix < q.indexes.length; ix++) {
                                var idx = q.indexes[ix];
                                var idxCls = idx.primary ? 'bm-idx-primary' : 'bm-idx-secondary';
                                var idxTip = (idx.primary ? 'Primary index scan (consider adding a secondary index)' : 'Secondary index')
                                    + ' — click to copy';
                                indexHtml += '<span class="bm-query-idx bm-idx-copy ' + idxCls + '" title="' + idxTip
                                    + '" data-idx-name="' + escHtml(idx.name) + '">'
                                    + (idx.primary ? _svgIdxWarn : _svgIdx) + ' '
                                    + escHtml(idx.name) + '</span>';
                            }
                        }
                    }
                } else if (q.connector) {
                    indexHtml = '<span class="bm-query-idx bm-idx-na" title="Index info not available for this connector">'
                        + _svgIdx + ' N/A</span>';
                }

                var rowCountBadge = '';
                if (typeof q.resultCount !== 'undefined') {
                    rowCountBadge = '<span class="bm-query-stmt-rows">'
                        + '<span class="bm-query-stmt-rows-label">rows</span>'
                        + '<span class="bm-query-stmt-rows-val">' + q.resultCount + '</span>'
                        + '</span>';
                }

                var metaHtml = '';
                if (indexHtml || rowCountBadge) {
                    metaHtml = '<span class="bm-query-stmt-meta">'
                        + indexHtml + rowCountBadge + '</span>';
                }

                h += '<div class="bm-query-stmt-wrap">'
                    + '<pre class="bm-query-statement">' + highlightSQL(q.statement) + '</pre>'
                    + '<button class="bm-query-copy" title="Copy compiled query" data-compiled="'
                    + escHtml(compiled) + '">'
                    + '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M4 1.5A1.5 1.5 0 015.5 0h5A1.5 1.5 0 0112 1.5v9a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 014 10.5v-9z" opacity=".35"/><path fill="currentColor" d="M2 4.5A1.5 1.5 0 013.5 3h5A1.5 1.5 0 0110 4.5v9A1.5 1.5 0 018.5 15h-5A1.5 1.5 0 012 13.5v-9z"/></svg>'
                    + '</button>'
                    + metaHtml
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

        if (limit < filtered.length) {
            var remaining = filtered.length - limit;
            h += '<button class="bm-query-show-all">Show all (' + remaining + ' more)</button>';
        }

        // Prepend missing-index warning banner
        if (noIndexItems.length > 0) {
            var banner = '<div class="bm-idx-banner">'
                + '<span class="bm-idx-banner-icon">' + _svgIdxWarn + '</span>'
                + '<div class="bm-idx-banner-body">'
                + '<strong>' + noIndexItems.length + ' quer' + (noIndexItems.length === 1 ? 'y' : 'ies')
                + ' without index</strong> — full bucket scan'
                + '<ul class="bm-banner-list">';
            for (var ni = 0; ni < noIndexItems.length; ni++) {
                banner += '<li><a class="bm-idx-banner-link" href="#' + noIndexItems[ni].id + '">'
                    + escHtml(noIndexItems[ni].trigger) + '</a></li>';
            }
            banner += '</ul></div></div>';
            h = banner + h;
        }

        // Prepend performance warning banner (slow / heavy queries)
        if (perfItems.length > 0) {
            var pbanner = '<div class="bm-perf-banner">'
                + '<span class="bm-perf-banner-icon">' + _svgClock + '</span>'
                + '<div class="bm-perf-banner-body">'
                + '<strong>' + perfItems.length + ' quer' + (perfItems.length === 1 ? 'y needs' : 'ies need')
                + ' attention</strong> — slow or heavy result'
                + '<ul class="bm-banner-list">';
            for (var pi = 0; pi < perfItems.length; pi++) {
                pbanner += '<li><a class="bm-perf-banner-link" href="#' + perfItems[pi].id + '">'
                    + escHtml(perfItems[pi].trigger)
                    + '<span class="bm-perf-banner-reason">' + escHtml(perfItems[pi].reason) + '</span>'
                    + '</a></li>';
            }
            pbanner += '</ul></div></div>';
            h = pbanner + h;
        }

        // #QI2 — trigger live index fetch if any queries still show N/A
        if (_liveIndexes === null && !_liveIndexesFetching) {
            for (var na = 0; na < filtered.length; na++) {
                if (filtered[na].indexes === null || filtered[na].indexes === undefined) {
                    fetchLiveIndexes();
                    break;
                }
            }
        }

        return h;
    }

    // ── Flow tab (waterfall timeline) ─────────────────────────────────────

    /** @constant {Object<string, string>} Category CSS class suffix → human label */
    var FLOW_CAT_LABELS = {
        routing:    'Routing',
        middleware: 'Middleware',
        controller: 'Controller',
        io:         'Query (HTTP)',
        db:         'Query (N1QL)',
        template:   'Template',
        response:   'Response',
        total:      'Total',
        gap:        'Gap'
    };

    /** Minimum gap in ms before inserting a gap entry */
    var FLOW_GAP_THRESHOLD_MS = 1;

    /**
     * Render a scale bar (three marks: 0, mid, end) for a waterfall section.
     * @inner
     * @param {number} totalMs - Total time span
     * @returns {string} HTML string
     */
    function renderFlowScale(totalMs) {
        var h = '<div class="bm-flow-scale">';
        h += '<span class="bm-flow-scale-mark" style="left:0">0 ms</span>';
        h += '<span class="bm-flow-scale-mark" style="left:50%">' + fmtMs(Math.round(totalMs / 2)) + '</span>';
        h += '<span class="bm-flow-scale-mark" style="left:100%">' + fmtMs(totalMs) + '</span>';
        h += '</div>';
        return h;
    }

    /**
     * Detect uninstrumented gaps between sorted flow entries and insert
     * synthetic "overhead" entries so the waterfall accounts for 100% of
     * the total time. Uses a high-water mark to handle overlapping entries
     * (e.g. controller-action spanning inner queries).
     *
     * Skips entries with cat "total" — those are the full-span summary bar.
     *
     * @inner
     * @param {Array<Object>} entries - Sorted timing entries
     * @param {number} t0 - Baseline epoch ms (requestStart)
     * @param {number} totalEndMs - Epoch ms of the total span end
     * @returns {Array<Object>} Entries with gap entries inserted, sorted by startMs
     */
    function insertFlowGaps(entries, t0, totalEndMs) {
        var result = [];
        var hwm = t0; // high-water mark — furthest endMs seen so far
        var gapIndex = 0;

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.cat === 'total') { result.push(e); continue; }

            var eEnd = e.endMs || (e.startMs + (e.durationMs || 0));

            // Gap before this entry?
            if (e.startMs > hwm + FLOW_GAP_THRESHOLD_MS) {
                var gapMs = e.startMs - hwm;
                result.push({
                    label: 'uninstrumented', cat: 'gap',
                    startMs: hwm, endMs: e.startMs,
                    durationMs: gapMs, _isGap: true
                });
                gapIndex++;
            }

            result.push(e);
            if (eEnd > hwm) hwm = eEnd;
        }

        // Trailing gap (after last entry, before total end)
        if (totalEndMs > hwm + FLOW_GAP_THRESHOLD_MS) {
            result.push({
                label: 'uninstrumented', cat: 'gap',
                startMs: hwm, endMs: totalEndMs,
                durationMs: totalEndMs - hwm, _isGap: true
            });
        }

        return result;
    }

    /**
     * Render waterfall rows for a list of flow entries.
     * @inner
     * @param {Array<Object>} entries - Sorted timing entries (may include gap entries)
     * @param {number} t0 - Baseline time (epoch ms or relative 0)
     * @param {number} totalMs - Total span for percentage calculation
     * @returns {string} HTML string
     */
    /**
     * Clean a flow entry label by stripping the category prefix that the
     * badge already conveys. When the detail field holds a more meaningful
     * name (action name, rule name), promote it into the badge and suppress
     * the detail line.
     * @inner
     * @param {string} label  - Raw label from the timeline entry
     * @param {string} cat    - Category key
     * @param {string|null} detail - Detail string (may be promoted)
     * @returns {{ name: string, detail: string|null }}
     */
    function cleanFlowLabel(label, cat, detail) {
        var name = label;
        var det  = detail || null;

        switch (cat) {
            case 'routing':
                // "route-match" + detail "rule: home@dashboard" → name "home@dashboard"
                if (label === 'route-match' && det) {
                    name = det.replace(/^rule:\s*/, '');
                    det = null;
                } else if (label === 'request-setup') {
                    name = 'request setup';
                } else {
                    name = label.replace(/^route-/, '');
                }
                break;

            case 'controller':
                // "controller-action" + detail "home" → name "home"
                // "controller-setup" + detail "home" → name "setup (home)"
                if (label === 'controller-action' && det) {
                    name = det;
                    det = null;
                } else if (label === 'controller-setup' && det) {
                    name = 'setup (' + det + ')';
                    det = null;
                } else if (label === 'controller-setup') {
                    name = 'setup';
                }
                break;

            case 'io':
                // "query → api" → "→ api"
                name = label.replace(/^query\s*/, '');
                break;

            case 'template':
                // "swig-compile" → "compile"
                name = label.replace(/^swig-/, '');
                break;

            case 'response':
                // "response-write" → "write", "stream-write" → "stream"
                name = label.replace(/^response-/, '').replace(/^stream-/, '');
                break;
        }

        return { name: name, detail: det };
    }

    function renderFlowRows(entries, t0, totalMs) {
        var h = '';
        for (var j = 0; j < entries.length; j++) {
            var e = entries[j];
            var dur = e.durationMs || ((e.endMs || e.startMs) - e.startMs);
            var left = ((e.startMs - t0) / totalMs) * 100;
            var width = (dur / totalMs) * 100;
            if (width < 0.5) width = 0.5;

            var catClass = e.cat ? ' bm-flow-cat-' + escHtml(e.cat) : '';
            var catLabel = (e.cat && FLOW_CAT_LABELS[e.cat]) ? FLOW_CAT_LABELS[e.cat] : '';
            var rowCatClass = e.cat ? ' bm-flow-is-' + escHtml(e.cat) : '';
            var cleaned = cleanFlowLabel(e.label, e.cat, e.detail);
            var tooltip = escHtml(e.label + ': ' + fmtMs(dur) + (e.detail ? ' \u2014 ' + e.detail : ''));

            h += '<div class="bm-flow-row' + rowCatClass + '">';
            h += '<div class="bm-flow-label" title="' + tooltip + '">';
            h += '<span class="bm-flow-badge">';
            if (catLabel) {
                h += '<span class="bm-flow-badge-cat' + catClass + '">' + escHtml(catLabel) + '</span>';
            }
            h += '<span class="bm-flow-badge-name' + catClass + '">' + escHtml(cleaned.name) + '</span>';
            h += '</span>';
            if (cleaned.detail) {
                h += '<span class="bm-flow-label-detail">' + escHtml(cleaned.detail) + '</span>';
            }
            h += '</div>';
            h += '<div class="bm-flow-track-wrap">';
            h += '<span class="bm-flow-track">';
            h += '<span class="bm-flow-bar' + catClass + '" style="left:'
                + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%" title="' + tooltip + '">';
            if (width > 8) {
                h += '<span class="bm-flow-dur">' + fmtMs(dur) + '</span>';
            }
            h += '</span></span>';
            h += '</div>';
            h += '<span class="bm-flow-time">' + fmtMs(dur) + '</span>';
            h += '</div>';
        }
        return h;
    }

    /**
     * Read the client document transfer time from the opener window's
     * Navigation Timing API. Transfer time = `responseEnd` (time from
     * navigation start to last byte of the document received). Used for
     * the progress bar that shows server processing as a proportion of
     * total transfer time.
     *
     * @inner
     * @returns {number|null} Document transfer time in ms, or null
     */
    function getClientTransferMs() {
        try {
            var win = (source && source !== 'localStorage') ? source : null;
            if (!win || !win.performance) return null;
            var perf = win.performance;
            if (!perf.getEntriesByType) return null;
            var nav = perf.getEntriesByType('navigation');
            if (!nav || nav.length === 0) return null;
            var n = nav[0];
            if (n.responseEnd > 0) return Math.round(n.responseEnd);
            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Render the Flow tab — a horizontal waterfall/timeline chart showing
     * the HTTP request lifecycle phases with per-step timing.
     *
     * When client transfer time is available (from `window.opener.performance`),
     * a compact progress bar in the controls bar shows server processing time
     * as a proportion of total document transfer time.
     *
     * @inner
     * @param {Object} timeline - Timeline data from `__ginaData.user.flow`
     * @param {number} timeline.requestStart - Epoch ms of request arrival
     * @param {Array<Object>} timeline.entries - Array of timing entries
     * @returns {string} HTML string
     *
     * @example
     *   renderFlowContent({ requestStart: 1712345678901, entries: [
     *       { label: 'route-match', cat: 'routing', startMs: 1712345678901, endMs: 1712345678903, durationMs: 2 }
     *   ] })
     */
    function renderFlowContent(timeline) {
        var totalEl = qs('#bm-flow-total');
        var progressWrap = qs('#bm-flow-progress-wrap');

        if (!timeline || !timeline.entries || timeline.entries.length === 0) {
            if (totalEl) { totalEl.className = 'bm-flow-total'; totalEl.innerHTML = ''; }
            if (progressWrap) progressWrap.innerHTML = '';
            return '<span class="bm-hint">No timeline data for this request.</span>';
        }

        var t0 = timeline.requestStart;
        var entries = timeline.entries.slice().sort(function (a, b) {
            return a.startMs - b.startMs;
        });
        var maxEnd = t0;
        for (var i = 0; i < entries.length; i++) {
            var end = entries[i].endMs || (entries[i].startMs + (entries[i].durationMs || 0));
            if (end > maxEnd) maxEnd = end;
        }
        var serverTotalMs = maxEnd - t0;
        if (serverTotalMs <= 0) serverTotalMs = 1;

        // ── Dual badge for total time (same pattern as Query tab) ──────
        if (totalEl) {
            totalEl.className = 'bm-flow-total bm-vbadge bm-stat-' + durationClass(serverTotalMs);
            totalEl.innerHTML = _svgClock + fmtMs(serverTotalMs);
            totalEl.setAttribute('data-tooltip', durationTooltip(serverTotalMs));
        }

        // ── Progress bar: server time as proportion of client transfer ──
        if (progressWrap) {
            var clientMs = getClientTransferMs();
            if (clientMs && clientMs > 0) {
                var pct = Math.min((serverTotalMs / clientMs) * 100, 100);
                var ph = '<span class="bm-flow-progress">';
                ph += '<span class="bm-flow-progress-track">';
                ph += '<span class="bm-flow-progress-fill" style="width:' + pct.toFixed(1) + '%"></span>';
                ph += '</span>';
                ph += '<span class="bm-flow-progress-pct">' + pct.toFixed(0) + '%</span>';
                ph += '<span class="bm-flow-progress-text">of <span class="bm-flow-progress-val">' + fmtMs(clientMs) + '</span> transfer</span>';
                ph += '</span>';
                progressWrap.innerHTML = ph;
            } else {
                progressWrap.innerHTML = '';
            }
        }

        // Filter out 'total' entries — the total is already shown in the badge;
        // keeping it in the waterfall adds a redundant full-width bar and
        // confuses insertFlowGaps (a span from t0 to tEnd masks every gap).
        var filtered = [];
        for (var fi = 0; fi < entries.length; fi++) {
            if (entries[fi].cat !== 'total') filtered.push(entries[fi]);
        }
        var withGaps = insertFlowGaps(filtered, t0, maxEnd);

        var h = '<div class="bm-flow-waterfall">';
        h += renderFlowScale(serverTotalMs);
        h += renderFlowRows(withGaps, t0, serverTotalMs);
        h += '</div>';

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

    // ── Reveal toggle (Data tab only — local scope only) ──────────────────

    /**
     * Show or hide the Reveal button based on the current scope. The button is
     * only available when the source bundle is running in `local` scope — the
     * server-side endpoint enforces the same gate, this is just the UI mirror.
     * Called after every data poll since scope can change when switching
     * sources via the standalone Inspector `?target=` mode.
     * @inner
     */
    function updateRevealVisibility() {
        var btn = qs('#bm-reveal');
        if (!btn) return;
        var scope = (ginaData && ginaData.gina && ginaData.gina.environment)
            ? ginaData.gina.environment.scope : null;
        if (scope === 'local') {
            btn.classList.remove('bm-hidden');
        } else {
            btn.classList.add('bm-hidden');
            // If we previously revealed in local and the source flipped to a
            // non-local scope, drop the cache and visual state immediately.
            if (_revealActive) {
                _revealActive = false;
                _revealedData = null;
                btn.classList.remove('active');
                try { localStorage.removeItem(REVEAL_STORAGE_KEY); } catch (e) {}
            }
        }
    }

    /**
     * Toggle the Data tab reveal state. When activated, fetches the unredacted
     * payload from `/_gina/reveal` and re-renders the Data tab. The endpoint
     * is scope-gated server-side — a 403 means the bundle is no longer in
     * local scope and the toggle is forced off.
     * @inner
     */
    function toggleReveal() {
        var btn = qs('#bm-reveal');
        if (!btn) return;
        if (_revealActive) {
            _revealActive = false;
            _revealedData = null;
            btn.classList.remove('active');
            try { localStorage.removeItem(REVEAL_STORAGE_KEY); } catch (e) {}
            renderTab('data');
            return;
        }
        // Resolve the reveal URL. Three modes:
        //   1. Standalone (`?target=<bundle_url>`) — route to the explicit target.
        //   2. Opener (same-origin) — use the opener's pathname as the prefix so
        //      the request routes to the bundle that rendered the current page.
        //      Critical in proxy-routed multi-bundle setups where bare
        //      `/_gina/reveal` hits the proxy's default bundle instead of the
        //      one that produced the snapshot.
        //   3. Fallback — strip `_gina/inspector` from the Inspector's own
        //      pathname (same approach as tryServerLogs).
        var base = resolveBundleBase();
        var url = base + '/_gina/reveal';
        var xhr  = new XMLHttpRequest();
        try {
            xhr.open('GET', url, true);
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 200) {
                    try {
                        _revealedData = JSON.parse(xhr.responseText);
                        _revealActive = true;
                        btn.classList.add('active');
                        try { localStorage.setItem(REVEAL_STORAGE_KEY, '1'); } catch (e) {}
                        renderTab('data');
                    } catch (e) {
                        _revealedData = null;
                        _revealActive = false;
                        btn.classList.remove('active');
                    }
                } else if (xhr.status === 403) {
                    // Scope flipped server-side — sync the UI.
                    btn.classList.add('bm-hidden');
                    btn.classList.remove('active');
                    _revealActive = false;
                    _revealedData = null;
                    try { localStorage.removeItem(REVEAL_STORAGE_KEY); } catch (e) {}
                }
            };
            xhr.send();
        } catch (e) { /* network error — leave state untouched */ }
    }

    // ── Download modal ────────────────────────────────────────────────────

    /**
     * Open the download modal with checkboxes for each root data key.
     * All keys are checked by default.
     * @inner
     */
    function openDownloadModal() {
        if (!ginaData || !ginaData.user) return;
        var src = (_revealActive && _revealedData) ? _revealedData : ginaData;
        var u = src.user || {};
        var dataObj = stripInternalKeys(u['data-xhr'] || u.data); // #B340
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
        var src = (_revealActive && _revealedData) ? _revealedData : ginaData;
        var u = src.user || {};
        var dataObj = stripInternalKeys(u['data-xhr'] || u.data); // #B340
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

    /**
     * Bind the Inspector to the opener tab's per-tab BroadcastChannel (#INS).
     *
     * Used in "bound mode" — when the statusbar opened the Inspector with a
     * `?ch=<tabId>` param. The statusbar (running in the opener tab) publishes
     * that tab's CURRENT `__ginaData` on `gina-inspector-<tabId>` on every page
     * render and every `ginaToolbar.update()` (in-tab XHR / pushState), so the
     * data is scoped to exactly that tab and follows its navigation — unaffected
     * by other tabs' or background-XHR renders that clobber the bundle-global
     * localStorage / `/_gina/agent` SSE channels COOP forces the Inspector onto
     * when it severs `window.opener`.
     *
     * Sets `source = 'broadcast'` (pollData then reads {@link _bcLatest}). Posts
     * a `{type:'request'}` on connect so the opener replies with its current
     * payload (BroadcastChannel does not replay past messages).
     *
     * @inner
     * @param   {string}  ch  The opener tab id from the `?ch=` param.
     * @returns {boolean} `true` when the channel was established.
     */
    function setupBoundChannel(ch) {
        if (!ch || typeof BroadcastChannel === 'undefined') return false;
        try {
            _boundChannel = new BroadcastChannel('gina-inspector-' + ch);
        } catch (e) { _boundChannel = null; return false; }
        source = 'broadcast';
        _boundChannel.onmessage = function (ev) {
            if (!ev || !ev.data || ev.data.type !== 'data' || !ev.data.payload) return;
            _bcLatest = ev.data.payload;
            pollData();   // immediate apply; the poll timer is the fallback
        };
        try { _boundChannel.postMessage({ type: 'request' }); } catch (e) {}
        return true;
    }

    /**
     * Adopt the statusbar-advertised tab channel when no usable `?ch=` was
     * given (#B231).
     *
     * Every dev page's statusbar advertises its per-tab channel id in
     * `localStorage['__gina_last_tab_ch']` on each publish, so an embedded
     * Inspector opened WITHOUT `?ch=` (direct URL, bookmark, a window predating
     * bound mode) can still bind to the most-recently-published tab instead of
     * falling back to the bundle-global channels (opener/localStorage polling +
     * the passive `/_gina/agent` SSE), where ANY background request to the
     * bundle overwrites the page-scoped popin/XHR overlay within seconds.
     *
     * A liveness handshake guards the adopt: `setupBoundChannel()` posts
     * `{type:'request'}` on bind; if no `{type:'data'}` reply lands within
     * {@link ADOPT_HANDSHAKE_MS} (stale advert — its tab is closed, and
     * localStorage outlives tabs), the bound channel AND the `/_gina/logs`
     * stream the caller opened alongside it are torn down, and `onDead` runs
     * the legacy acquisition (leaving the logs stream open would double-deliver
     * log entries once the legacy path's passive agent stream attaches).
     *
     * Multi-tab semantics: adopts the LAST tab that published (last-writer-wins
     * on the advert) — a deliberate approximation of "the tab the user is on",
     * strictly narrower than the bundle-global fallback it replaces.
     *
     * @inner
     * @param   {function} onDead - Legacy acquisition to run when the adopted
     *   channel never delivers (the init's `_startLegacyAcquisition`).
     * @returns {boolean} `true` when an advertised channel was adopted (bound
     *   mode claimed; the handshake timer is armed).
     */
    function _adoptAdvertisedChannel(onDead) {
        var ad = null;
        try { ad = localStorage.getItem('__gina_last_tab_ch'); } catch (e) { ad = null; }
        if (!ad || !setupBoundChannel(ad)) return false;
        setTimeout(function () {
            // Proven live (a data frame arrived) or re-claimed by another mode.
            if (source !== 'broadcast' || _bcLatest !== null) return;
            try { if (_boundChannel) _boundChannel.close(); } catch (e) {}
            _boundChannel = null;
            if (_serverLogsEs) {
                try { _serverLogsEs.close(); } catch (e) {}
                _serverLogsEs = null;
            }
            source = null;
            if (typeof onDead === 'function') onDead();
        }, ADOPT_HANDSHAKE_MS);
        return true;
    }

    /**
     * Render the footer data-source mode badge (#B231).
     *
     * Surfaces WHICH kind of channel feeds the data tabs, so a degraded mode
     * is visible instead of silent:
     *  - `bound`  — per-tab statusbar channel (#INS15): page-scoped, immune to
     *    other tabs' / background renders.
     *  - `agent`  — explicit `?target=` bundle stream (standalone mode).
     *  - `global` — legacy fallback (opener/localStorage polling + the passive
     *    bundle-wide `/_gina/agent` SSE): ANY request to the bundle can
     *    overwrite the data tabs — warn-tinted, and the tooltip points at the
     *    statusbar link that yields bound mode.
     *
     * Called from `pollData()` (every tick + every bound-channel apply) and at
     * the end of the init acquisition, so a mode transition (e.g. an adopted
     * channel handing over to the legacy fallback) surfaces within one tick.
     * Agent mode (`?target=`) reaches neither of those — it schedules no poll
     * timer — so init calls this directly on its branch; without that call the
     * `agent` badge would be unreachable from a URL-entered standalone session
     * (#B306).
     *
     * @inner
     */
    function updateSourceModeBadge() {
        var el = qs('#bm-source-mode');
        if (!el) return;
        var mode = null;
        var cls  = 'bm-source-mode';
        var tip  = '';
        if (source === 'agent') {
            mode = 'agent';
            tip  = 'Data from the ?target= bundle stream (/_gina/agent).';
        } else if (source === 'broadcast') {
            mode = 'bound';
            tip  = 'Data bound to one page tab (statusbar channel). Other tabs and background requests cannot overwrite it.';
        } else if (source === 'localStorage' || (source && typeof source === 'object')) {
            mode = 'global';
            cls += ' bm-source-mode-warn';
            tip  = 'Bundle-global fallback: any tab or background request to this bundle can overwrite the data tabs. Open the Inspector from the page statusbar link to get bound (per-tab) mode.';
        }
        if (mode === null) {
            el.hidden = true;
            return;
        }
        el.hidden = false;
        el.textContent = mode;
        el.className = cls;
        el.title = tip;
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

        // Footer version
        var verEl = qs('#bm-footer-version');
        if (verEl && env['gina']) {
            verEl.innerHTML = '<span class="bm-footer-brand">Gina</span>'
                + '<span class="bm-footer-ver">v' + env['gina'].replace(/</g, '&lt;') + '</span>';
        }
    }

    /**
     * Extract the running bundle's `gina pid` from a `__ginaData` payload,
     * reading `gina.environment` first then falling back to `user.environment`.
     *
     * @inner
     * @param   {?Object} gd  A parsed `__ginaData` payload.
     * @returns {?(number|string)} The `gina pid`, or null when absent.
     */
    function _gdPid(gd) {
        try {
            var e = (gd && gd.gina && gd.gina.environment)
                 || (gd && gd.user && gd.user.environment) || null;
            return e ? (e['gina pid'] || null) : null;
        } catch (e) { return null; }
    }

    /**
     * Extract the bundle webroot from a `__ginaData` payload, reading
     * `gina.environment` first then falling back to `user.environment`
     * (mirrors {@link _gdPid}). Both render delegates emit it.
     *
     * @inner
     * @param   {?Object} gd  A parsed `__ginaData` payload.
     * @returns {?string} The webroot (e.g. `'/'` or `'/admin'`), or null when absent.
     */
    function _gdWebroot(gd) {
        try {
            var e = (gd && gd.gina && gd.gina.environment)
                 || (gd && gd.user && gd.user.environment) || null;
            var w = e ? e.webroot : null;
            return (typeof w === 'string') ? w : null;
        } catch (e) { return null; }
    }

    /**
     * Normalise a webroot/base path for comparison and URL building: strip
     * every trailing slash so `'/'` and `''` both mean the root and
     * `'/admin/'` equals `'/admin'`. Non-strings normalise to null (unknown).
     *
     * @inner
     * @param   {?string} w  A webroot or base path.
     * @returns {?string} The normalised base (`''` for the root), or null.
     */
    function _normWebroot(w) {
        return (typeof w === 'string') ? w.replace(/\/+$/, '') : null;
    }

    /**
     * Record the live bundle pid from an agent-delivered payload. The agent
     * (SSE/WS) channel always reflects the running process, so its pid is the
     * freshness reference {@link _isStaleSource} compares polled snapshots against.
     * Also records which bundle the pid belongs to ({@link _livePidWebroot}) so
     * the guard can tell a restart from a bundle crossing (#B205).
     *
     * @inner
     * @param {?Object} gd  A parsed `__ginaData` payload from the agent channel.
     */
    function _noteLivePid(gd) {
        var p = _gdPid(gd);
        if (p) {
            _livePid = p;
            _livePidWebroot = _normWebroot(_gdWebroot(gd));
        }
    }

    /**
     * Freshness guard for the opener/localStorage poll. Once the live agent
     * channel has reported the running bundle's pid ({@link _livePid}), a polled
     * payload carrying a DIFFERENT pid is a snapshot from a prior process — e.g.
     * an opener tab still open from before a bundle restart. Returning true tells
     * {@link pollData} to keep the live agent data instead of letting that stale
     * snapshot override it (most visibly the template-engine version badge).
     * Inert (returns false) until an agent pid is known, preserving the pure
     * opener/localStorage behaviour.
     *
     * A pid mismatch only means "stale" WITHIN one bundle: in a proxy-routed
     * multi-bundle project, a payload from another bundle (different webroot,
     * necessarily a different process/pid) is the monitored tab legitimately
     * crossing a bundle boundary — it must pass so the Inspector can follow
     * ({@link _followBundleChannels}). Only same-webroot pid mismatches are
     * treated as stale (#B205).
     *
     * @inner
     * @param   {?Object} gd  The polled `__ginaData` payload.
     * @returns {boolean} True when `gd` belongs to a different (stale) process.
     */
    function _isStaleSource(gd) {
        if (!_livePid) return false;
        var p = _gdPid(gd);
        if (!p || p === _livePid) return false;
        // #B205 — a different pid under a DIFFERENT webroot is another bundle,
        // not a stale snapshot of this one: let it through.
        var wr = _normWebroot(_gdWebroot(gd));
        if (wr !== null && _livePidWebroot !== null && wr !== _livePidWebroot) return false;
        return true;
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
     * Each applied payload also drives {@link _followBundleChannels}, which
     * re-points the server-side SSE channels when the monitored tab crossed
     * onto another bundle of the project (#B205).
     *
     * @inner
     */
    function pollData() {
        try {
            updateSourceModeBadge();
            var gd;
            if (source === 'agent') {
                // Agent mode — data is pushed via SSE; nothing to poll.
                // When called manually (refresh button), re-render from cache.
                if (ginaData) {
                    var tab = activeTab();
                    if (tab !== 'logs') renderTab(tab);
                }
                return;
            } else if (source === 'broadcast') {
                // Bound mode (#INS) — data is pushed over the per-tab
                // BroadcastChannel into _bcLatest (the channel handler calls
                // pollData() for an immediate apply; this timer re-read is the
                // fallback). Scoped to the opener tab, so other tabs' renders
                // never appear here.
                gd = _bcLatest;
                if (!gd) return;
            } else if (source === 'localStorage') {
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
            // Freshness guard — a stale-process opener/localStorage snapshot (its
            // `gina pid` differs from the live agent's) must not override live data;
            // see _isStaleSource. Inert until an agent frame establishes _livePid.
            if (_isStaleSource(gd)) return;
            showLoader();
            lastGdStr = str;
            ginaData = gd;
            var env = (gd.user && gd.user.environment) || {};
            // #B205 — follow the monitored tab across bundles: when this payload
            // belongs to another bundle (different webroot), re-point the
            // server-side channels at it. Hitting its Inspector endpoints also
            // activates that bundle's dev capture, so Flow/Query data starts
            // flowing for its pages.
            _followBundleChannels(gd);
            qs('#bm-label').textContent = (env.bundle || '?') + '@' + (env.env || '?');
            qs('#bm-dot').className = 'bm-dot ok';
            // Update window title with the inspected page URL
            try {
                var _pageUrl = (source && source !== 'localStorage' && source.location)
                    ? source.location.pathname + source.location.search
                    : null;
                document.title = _pageUrl
                    ? 'Inspector — ' + _pageUrl
                    : 'Inspector — ' + (env.bundle || '?') + '@' + (env.env || '?');
            } catch (e) {
                document.title = 'Inspector — ' + (env.bundle || '?') + '@' + (env.env || '?');
            }
            qs('#bm-no-source').classList.add('hidden');
            renderEnvironmentInfo();
            updateRevealVisibility();
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
            // Always update view dot regardless of active tab
            if (tab !== 'view') {
                var _u2 = gd.user || {};
                var _isXhr2 = typeof _u2['view-xhr'] !== 'undefined';
                var _vm = getPageMetrics(_isXhr2);
                var _dxhr = typeof _u2['data-xhr'] !== 'undefined';
                var _vq = _dxhr && _u2['data-xhr'] && _u2['data-xhr'].queries
                    ? _u2['data-xhr'].queries : _u2.queries;
                updateViewDot(checkPerfAnomalies(_vm, _vq || []));
            }
            hideLoader();
        } catch (e) {
            hideLoader();
            if (source !== 'localStorage' && source !== 'broadcast') source = null;
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
            if (!src || !Array.isArray(src)) return;
            // Detect opener navigation: the new page installs a fresh __ginaLogs
            // array, so the array identity differs from the one we last polled
            // (or its length is smaller than our offset). Reset the offset so
            // new entries on the new page are picked up.
            if (src !== _lastLogsRef || src.length < logsOff) {
                _lastLogsRef = src;
                logsOff = 0;
            }
            if (src.length <= logsOff) return;
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
        // Feedback: show "Copied", then fade out badge and clear selection
        var badge   = qs('#bm-log-sel-badge');
        var copyBtn = qs('#bm-log-sel-copy');
        if (copyBtn && badge && !badge.classList.contains('hidden')) {
            copyBtn.textContent = '\u2713 Copied';
            copyBtn.classList.add('copied');
            setTimeout(function () {
                badge.classList.add('fade-out');
                // Use setTimeout matching CSS transition duration instead of
                // transitionend — the event can be lost if the element is hidden
                // or re-rendered before the transition completes.
                setTimeout(function () {
                    badge.classList.remove('fade-out');
                    badge.classList.add('hidden');
                    copyBtn.classList.remove('copied');
                    copyBtn.textContent = '';
                    selectedLogIds.clear();
                    lastClickedLid = -1;
                    var allRows = qsa('.bm-log[data-lid]', qs('#bm-log-list'));
                    for (var i = 0; i < allRows.length; i++) allRows[i].classList.remove('bm-log-selected');
                    updateSelectionUI();
                }, 420);
            }, 600);
        } else {
            // No badge visible (single-row click copy) — keep accent briefly visible
            setTimeout(function () {
                selectedLogIds.clear();
                lastClickedLid = -1;
                var allRows = qsa('.bm-log[data-lid]', qs('#bm-log-list'));
                for (var i = 0; i < allRows.length; i++) allRows[i].classList.remove('bm-log-selected');
                updateSelectionUI();
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
     * At most one stream is live: a re-point ({@link _followBundleChannels})
     * closes the previous stream before connecting to the new bundle (#B205).
     *
     * @inner
     * @private
     * @param {string} [baseOverride]  Explicit bundle base to connect to —
     *   passed by the bundle-follow re-point; omitted at init, where the
     *   shared resolver derives the base.
     */
    function tryServerLogs(baseOverride) {
        if (typeof EventSource === 'undefined') return;

        // Derive the SSE URL via the shared 3-fallback resolver so /_gina/logs
        // reaches the monitored bundle in proxy-routed multi-bundle setups (was a
        // bare pathname strip that misrouted to the proxy's default bundle).
        var base = resolveBundleBase();
        // #B205 — bundle-follow re-points pass the target base explicitly.
        if (typeof baseOverride === 'string') base = baseOverride;
        var url  = base + '/_gina/logs';

        // #B205 — single live stream: close the previous one on re-point.
        if (_serverLogsEs) {
            try { _serverLogsEs.close(); } catch (e) {}
            _serverLogsEs = null;
        }

        try {
            var es = new EventSource(url);
            _serverLogsEs = es;
            _channelBase  = base;
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

    // ── Bundle-follow: re-point server channels on bundle crossing (#B205) ──

    /**
     * Follow the monitored tab across the bundles of a proxy-routed
     * multi-bundle project. Every applied `__ginaData` payload names its
     * bundle's webroot; when it differs from the base the server-side channels
     * are pointed at ({@link _channelBase}), the live `/_gina/logs` SSE and/or
     * the passive `/_gina/agent` SSE are closed and re-opened against the new
     * bundle's base, so that:
     *
     *  - server logs stream from the bundle actually serving the monitored
     *    page (they previously stayed pinned to the open-time bundle), and
     *  - the new bundle's dev capture activates: its Inspector endpoints latch
     *    the per-process activation flag that gates the request timeline
     *    (Flow tab) and the query log (Query tab). Without the re-point, a
     *    bundle the Inspector was never opened from kept rendering with no
     *    flow/queries — the Flow tab showed "No timeline data for this
     *    request." for every page that bundle served.
     *
     * The page that evidences the crossing rendered BEFORE the new bundle's
     * capture activated, so its own timeline is unavoidably absent — Flow and
     * Query data appear from the next render on. Agent mode (`?target=`) is an
     * explicit binding and is never re-pointed.
     *
     * @inner
     * @param {?Object} gd  The just-applied `__ginaData` payload.
     */
    function _followBundleChannels(gd) {
        if (source === 'agent') return;
        var wr = _normWebroot(_gdWebroot(gd));
        if (wr === null || wr === _channelBase) return;
        var hadPassive = !!_passiveAgentEs;
        var hadLogs    = !!_serverLogsEs;
        // Adopt the new base even when no channel is open (e.g. EventSource
        // unsupported), so the comparison above stays meaningful.
        _channelBase = wr;
        if (hadPassive) tryAgentPassive(wr);
        if (hadLogs)    tryServerLogs(wr);
    }

    // ── Remote data source via /_gina/agent SSE ─────────────────────────

    /**
     * Attempt to connect to a remote bundle via the `/_gina/agent` SSE endpoint.
     * Activated when the Inspector is opened with a `?target=` query parameter
     * (e.g. `http://localhost:4101/inspector/?target=http://localhost:3100`).
     *
     * When connected, this is the sole data and log source — opener polling,
     * localStorage fallback, `tryServerLogs()`, and `pollLogs()` are all skipped.
     *
     * The endpoint uses named SSE events:
     *   - `event: data` — full `__ginaData` payload (same shape as `window.__ginaData`)
     *   - `event: log`  — single log entry `{ t, l, b, s, src }`
     *
     * @inner
     * @returns {boolean} `true` if a `target` param was found and connection initiated
     */
    function tryAgent() {
        // #INS8 — if the WebSocket transport already claimed the channel, no-op.
        if (source === 'agent') return true;
        if (typeof EventSource === 'undefined') return false;

        var params = new URLSearchParams(window.location.search);
        var target = params.get('target');
        if (!target) return false;

        // Normalise: strip trailing slash
        target = target.replace(/\/+$/, '');
        var url = target + '/_gina/agent';

        // #INS9b — when the target bundle's agent endpoint is auth-gated
        // (settings.json inspector.agent.enabled outside dev mode), pass the key
        // via ?key=. EventSource cannot set request headers, so the browser path
        // is the query param. Optional — omitted when no key was supplied.
        var agentKey = params.get('key');
        if (agentKey) {
            url += '?key=' + encodeURIComponent(agentKey);
        }

        source = 'agent';
        qs('#bm-dot').className = 'bm-dot warn';
        qs('#bm-label').textContent = 'Connecting\u2026';

        try {
            var es = new EventSource(url);

            es.addEventListener('data', function (ev) {
                try {
                    var gd = JSON.parse(ev.data);
                    if (!gd) return;
                    var str = JSON.stringify(gd);
                    if (str === lastGdStr) return;
                    showLoader();
                    lastGdStr = str;
                    ginaData = gd;
                    _noteLivePid(gd);
                    var env = (gd.user && gd.user.environment) || {};
                    qs('#bm-label').textContent = (env.bundle || '?') + '@' + (env.env || '?');
                    qs('#bm-dot').className = 'bm-dot ok';
                    document.title = 'Inspector — ' + (env.bundle || '?') + '@' + (env.env || '?');
                    qs('#bm-no-source').classList.add('hidden');
                    renderEnvironmentInfo();
                    updateRevealVisibility();
                    var tab = activeTab();
                    if (tab !== 'logs') renderTab(tab);
                    if (tab !== 'query') {
                        var _u = gd.user || {};
                        var _hasXhr = typeof _u['data-xhr'] !== 'undefined';
                        var _qd = _hasXhr && _u['data-xhr'] && _u['data-xhr'].queries
                            ? _u['data-xhr'].queries : _u.queries;
                        updateQueryToolbar(_qd || null);
                    }
                    if (tab !== 'view') {
                        var _u2 = gd.user || {};
                        var _isXhr2 = typeof _u2['view-xhr'] !== 'undefined';
                        var _vm = getPageMetrics(_isXhr2);
                        var _dxhr = typeof _u2['data-xhr'] !== 'undefined';
                        var _vq = _dxhr && _u2['data-xhr'] && _u2['data-xhr'].queries
                            ? _u2['data-xhr'].queries : _u2.queries;
                        updateViewDot(checkPerfAnomalies(_vm, _vq || []));
                    }
                    hideLoader();
                } catch (e) {}
            });

            es.addEventListener('log', function (ev) {
                if (paused) return;
                try {
                    var entry = JSON.parse(ev.data);
                    entry._id = ++_logIdCounter;
                    logs.push(entry);
                    if (logs.length > MAX_LOG_ENTRIES) logs.shift();
                    updateLogDot([entry]);
                    scheduleRender();
                } catch (e) {}
            });

            es.addEventListener('token', function (ev) {
                // #AISTREAM — live AI token-stream frame (textContent-rendered).
                try { appendTokenDelta(JSON.parse(ev.data)); } catch (e) {}
            });

            es.addEventListener('event', function (ev) {
                // #EVTBUS — live application-event frame (textContent-rendered).
                try { appendAppEvent(JSON.parse(ev.data)); } catch (e) {}
            });

            es.addEventListener('open', function () {
                qs('#bm-dot').className = 'bm-dot ok';
                // Label stays as "Connecting…" until the first data event updates it
            });

            es.onerror = function () {
                // EventSource reconnects automatically.
                // Show warning state while disconnected.
                qs('#bm-dot').className = 'bm-dot warn';
            };
        } catch (e) {
            return false;
        }

        return true;
    }


    // ── WebSocket /_gina/agent transport (#INS8) ─────────────────────────

    /**
     * #INS8/#INS9b — WebSocket variant of {@link tryAgent}, the DEFAULT agent
     * transport (since #INS9b). Runs whenever the Inspector is opened with a
     * `?target=<bundle_url>` unless `?transport=sse` forces SSE.
     * Connects to `{target}/_gina/agent` over a WebSocket, parsing the same
     * `{event, data}` envelopes the SSE channel emits. Threads the optional
     * `?key=` on the WS URL (browsers cannot set WebSocket handshake headers,
     * same constraint as EventSource). Falls back to SSE ({@link tryAgent}) once
     * if the socket never opens (e.g. an HTTP/2-only target that cannot upgrade).
     *
     * @inner
     * @returns {boolean} `true` if a `target` param was found and a socket was opened
     */
    function tryAgentWS() {
        if (typeof WebSocket === 'undefined') return false;

        var params = new URLSearchParams(window.location.search);
        var target = params.get('target');
        if (!target) return false;

        // Normalise: strip trailing slash, switch scheme to ws/wss.
        target = target.replace(/\/+$/, '');
        var wsUrl = target.replace(/^http/i, 'ws') + '/_gina/agent';

        var agentKey = params.get('key');
        if (agentKey) {
            wsUrl += '?key=' + encodeURIComponent(agentKey);
        }

        qs('#bm-dot').className = 'bm-dot warn';
        qs('#bm-label').textContent = 'Connecting…';

        var _opened = false, _fellBack = false;

        try {
            var ws = new WebSocket(wsUrl);
            // Claim the channel only after the socket is constructed, so a
            // constructor throw leaves source unset and tryAgent() opens SSE.
            source = 'agent';

            ws.onopen = function () {
                _opened = true;
                qs('#bm-dot').className = 'bm-dot ok';
            };

            ws.onmessage = function (ev) {
                try {
                    var frame = JSON.parse(ev.data);
                    if (!frame || !frame.event) return;
                    if (frame.event === 'data') {
                        var gd = frame.data;
                        if (!gd) return;
                        var str = JSON.stringify(gd);
                        if (str === lastGdStr) return;
                        showLoader();
                        lastGdStr = str;
                        ginaData = gd;
                        _noteLivePid(gd);
                        var env = (gd.user && gd.user.environment) || {};
                        qs('#bm-label').textContent = (env.bundle || '?') + '@' + (env.env || '?');
                        qs('#bm-dot').className = 'bm-dot ok';
                        document.title = 'Inspector — ' + (env.bundle || '?') + '@' + (env.env || '?');
                        qs('#bm-no-source').classList.add('hidden');
                        renderEnvironmentInfo();
                        updateRevealVisibility();
                        var tab = activeTab();
                        if (tab !== 'logs') renderTab(tab);
                        if (tab !== 'query') {
                            var _u = gd.user || {};
                            var _hasXhr = typeof _u['data-xhr'] !== 'undefined';
                            var _qd = _hasXhr && _u['data-xhr'] && _u['data-xhr'].queries
                                ? _u['data-xhr'].queries : _u.queries;
                            updateQueryToolbar(_qd || null);
                        }
                        if (tab !== 'view') {
                            var _u2 = gd.user || {};
                            var _isXhr2 = typeof _u2['view-xhr'] !== 'undefined';
                            var _vm = getPageMetrics(_isXhr2);
                            var _dxhr = typeof _u2['data-xhr'] !== 'undefined';
                            var _vq = _dxhr && _u2['data-xhr'] && _u2['data-xhr'].queries
                                ? _u2['data-xhr'].queries : _u2.queries;
                            updateViewDot(checkPerfAnomalies(_vm, _vq || []));
                        }
                        hideLoader();
                    } else if (frame.event === 'log') {
                        if (paused) return;
                        var entry = frame.data;
                        if (!entry) return;
                        entry._id = ++_logIdCounter;
                        logs.push(entry);
                        if (logs.length > MAX_LOG_ENTRIES) logs.shift();
                        updateLogDot([entry]);
                        scheduleRender();
                    } else if (frame.event === 'token') {
                        // #AISTREAM — live AI token-stream frame (textContent-rendered).
                        appendTokenDelta(frame.data);
                    } else if (frame.event === 'event') {
                        // #EVTBUS — live application-event frame (textContent-rendered).
                        appendAppEvent(frame.data);
                    }
                } catch (e) {}
            };

            ws.onerror = function () {
                qs('#bm-dot').className = 'bm-dot warn';
            };

            ws.onclose = function () {
                qs('#bm-dot').className = 'bm-dot warn';
                // If the socket never opened, fall back to SSE once so the
                // Inspector still connects (e.g. an HTTP/2-only target whose
                // server cannot upgrade a WebSocket).
                if (!_opened && !_fellBack && source === 'agent') {
                    _fellBack = true;
                    source = null;
                    tryAgent();
                }
            };
        } catch (e) {
            return false;
        }

        return true;
    }

    // ── Passive /_gina/agent subscription (opener mode) ──────────────────

    /**
     * Open a parallel `/_gina/agent` SSE subscription alongside opener polling.
     *
     * Opener polling alone misses SPA (pushState) and XHR navigations because
     * those paths do not rewrite `window.__ginaData` — only full HTML renders
     * do. `render-json.js` however emits `process.emit('inspector#data', ...)`
     * on every JSON render when `process.gina._inspectorActive` is true, and
     * `/_gina/agent` forwards those emits as `event: data` SSE frames.
     *
     * This function subscribes to that same stream in the background while
     * `source` stays set to the opener window. The data handler updates the
     * Inspector UI but does NOT change `source`, so opener-driven behaviour
     * (reveal URL derivation, pollData fallback, log polling) is unchanged.
     *
     * Server-side logs arrive on this stream too (`event: log`), so when
     * passive mode succeeds `tryServerLogs()` is skipped to avoid duplicates.
     *
     * @inner
     * @param {string} [baseOverride]  Explicit bundle base to connect to —
     *   passed by the bundle-follow re-point ({@link _followBundleChannels})
     *   and the refresh-button reopen; omitted at init.
     * @returns {boolean} `true` when a subscription was opened, `false` when
     *   the environment is unsupported or the URL cannot be derived.
     */
    function tryAgentPassive(baseOverride) {
        if (typeof EventSource === 'undefined') return false;
        // Agent mode already covers data + logs via the primary tryAgent stream.
        if (source === 'agent') return false;

        // Resolve the bundle base via resolveBundleBase() (the one resolver
        // every /_gina/* consumer uses). Its ?target= branch is inert here:
        // tryAgentPassive only runs when source !== 'agent' (i.e. no ?target=),
        // so this falls through to the opener-pathname fallback as before.
        var base = resolveBundleBase();
        // #B205 — bundle-follow re-points pass the target base explicitly.
        if (typeof baseOverride === 'string') base = baseOverride;
        var url = base + '/_gina/agent';

        // #B205 — single live stream: close the previous one on re-point.
        if (_passiveAgentEs) {
            try { _passiveAgentEs.close(); } catch (e) {}
            _passiveAgentEs = null;
        }

        try {
            var es = new EventSource(url);
            _passiveAgentEs = es;
            _channelBase = base;

            es.addEventListener('data', function (ev) {
                try {
                    var gd = JSON.parse(ev.data);
                    if (!gd) return;
                    var str = JSON.stringify(gd);
                    if (str === lastGdStr) return;
                    showLoader();
                    lastGdStr = str;
                    ginaData = gd;
                    _noteLivePid(gd);
                    var env = (gd.user && gd.user.environment) || {};
                    qs('#bm-label').textContent = (env.bundle || '?') + '@' + (env.env || '?');
                    qs('#bm-dot').className = 'bm-dot ok';
                    try {
                        var _pageUrl = (window.opener && window.opener.location)
                            ? window.opener.location.pathname + window.opener.location.search
                            : null;
                        document.title = _pageUrl
                            ? 'Inspector — ' + _pageUrl
                            : 'Inspector — ' + (env.bundle || '?') + '@' + (env.env || '?');
                    } catch (e) {
                        document.title = 'Inspector — ' + (env.bundle || '?') + '@' + (env.env || '?');
                    }
                    qs('#bm-no-source').classList.add('hidden');
                    renderEnvironmentInfo();
                    updateRevealVisibility();
                    var tab = activeTab();
                    if (tab !== 'logs') renderTab(tab);
                    if (tab !== 'query') {
                        var _u = gd.user || {};
                        var _hasXhr = typeof _u['data-xhr'] !== 'undefined';
                        var _qd = _hasXhr && _u['data-xhr'] && _u['data-xhr'].queries
                            ? _u['data-xhr'].queries : _u.queries;
                        updateQueryToolbar(_qd || null);
                    }
                    if (tab !== 'view') {
                        var _u2 = gd.user || {};
                        var _isXhr2 = typeof _u2['view-xhr'] !== 'undefined';
                        var _vm = getPageMetrics(_isXhr2);
                        var _dxhr = typeof _u2['data-xhr'] !== 'undefined';
                        var _vq = _dxhr && _u2['data-xhr'] && _u2['data-xhr'].queries
                            ? _u2['data-xhr'].queries : _u2.queries;
                        updateViewDot(checkPerfAnomalies(_vm, _vq || []));
                    }
                    hideLoader();
                } catch (e) {}
            });

            es.addEventListener('log', function (ev) {
                if (paused) return;
                try {
                    var entry = JSON.parse(ev.data);
                    entry._id = ++_logIdCounter;
                    logs.push(entry);
                    if (logs.length > MAX_LOG_ENTRIES) logs.shift();
                    updateLogDot([entry]);
                    scheduleRender();
                } catch (e) {}
            });

            es.addEventListener('token', function (ev) {
                // #AISTREAM — live AI token-stream frame (textContent-rendered).
                try { appendTokenDelta(JSON.parse(ev.data)); } catch (e) {}
            });

            es.addEventListener('event', function (ev) {
                // #EVTBUS — live application-event frame (textContent-rendered).
                try { appendAppEvent(JSON.parse(ev.data)); } catch (e) {}
            });

            es.onerror = function () {
                // EventSource reconnects automatically. Opener polling is the
                // primary source here, so no UI state change is needed.
            };
        } catch (e) {
            _passiveAgentEs = null;
            return false;
        }

        return true;
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
                var isOpen = !panel.classList.contains('hidden');
                try { localStorage.setItem(SETTINGS_STORAGE_KEY, String(isOpen)); } catch (e) {}
                // Sync drag-mode: only allow tab dragging when settings is open + custom layout
                var nav = qs('.bm-tabs');
                if (nav) {
                    var activeLayout = qs('.bm-layout-btn.active');
                    if (isOpen && activeLayout && activeLayout.dataset.layout === 'custom') {
                        nav.classList.add('bm-drag-mode');
                    } else {
                        nav.classList.remove('bm-drag-mode');
                    }
                }
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

        // Inject × close buttons into each tab (hidden by default, shown in custom mode)
        qsa('.bm-tab').forEach(function (tab) {
            var closeBtn = document.createElement('span');
            closeBtn.className = 'bm-tab-close';
            closeBtn.innerHTML = '\u00d7';
            closeBtn.title = 'Hide this tab';
            closeBtn.style.display = 'none';
            closeBtn.addEventListener('click', function (e) {
                e.stopPropagation(); // Don't trigger tab switch
                hideTab(tab.dataset.tab);
            });
            tab.appendChild(closeBtn);
        });

        // Tab layout segmented control — restore persisted layout, wire click
        var layoutBtns = qsa('.bm-layout-btn');
        if (layoutBtns.length) {
            var savedLayout = null;
            try { savedLayout = localStorage.getItem(TAB_LAYOUT_KEY); } catch (e) {}
            var isValidPreset = savedLayout && (TAB_LAYOUTS[savedLayout] || savedLayout === 'custom');
            var initialLayout = isValidPreset ? savedLayout : 'balanced';
            // Activate the matching button and apply
            layoutBtns.forEach(function (btn) {
                btn.classList.toggle('active', btn.dataset.layout === initialLayout);
            });
            applyTabLayout(initialLayout);
            renderLayoutPreview(initialLayout);

            layoutBtns.forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var layout = this.dataset.layout;
                    layoutBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
                    if (layout === 'custom' && !getCustomOrder()) {
                        // First time entering custom mode — snapshot current order
                        saveCustomOrder();
                    }
                    applyTabLayout(layout);
                    renderLayoutPreview(layout);
                    try { localStorage.setItem(TAB_LAYOUT_KEY, layout); } catch (e) {}
                    // Animate tabs when entering custom mode
                    if (layout === 'custom') nudgeTabs();
                });
            });
        }

        // Reset link — restore all hidden tabs in custom mode
        var resetBtn = qs('#bm-layout-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', function () { restoreAllTabs(); });
        }

        // Per-tab restore — clicking a dimmed (hidden) preview pill restores
        // just that tab. Delegated on the container: the pill row is rebuilt
        // via innerHTML on every renderLayoutPreview(), so per-pill listeners
        // would not survive; the container does.
        var previewEl = qs('#bm-layout-preview');
        if (previewEl) {
            previewEl.addEventListener('click', function (e) {
                var pill = e.target && e.target.closest ? e.target.closest('.bm-lp-pill-hidden') : null;
                if (!pill) return;
                var name = pill.getAttribute('data-tab');
                if (name) restoreTab(name);
            });
        }

        // ── Tab drag-to-reorder (custom layout mode) ──────────────────────
        setupTabDrag();
    }

    /**
     * Wire mousedown/mousemove/mouseup on `.bm-tab` buttons to allow
     * drag-to-reorder when the nav bar has `.bm-drag-mode`.
     *
     * Drag is started on mousedown + mousemove (> 4px threshold to avoid
     * accidental drags on plain clicks).  The dragged tab follows the cursor
     * via opacity feedback and a drop-indicator line appears between potential
     * drop targets.  On mouseup the tab is moved in the DOM and the new order
     * is persisted to localStorage.
     *
     * @inner
     */
    function setupTabDrag() {
        var nav = qs('.bm-tabs');
        if (!nav) return;

        var _dragTab = null;
        var _dragStartX = 0;
        var _dragging = false;
        var _dropTarget = null;

        nav.addEventListener('mousedown', function (e) {
            if (!nav.classList.contains('bm-drag-mode')) return;
            var tab = e.target.closest('.bm-tab');
            if (!tab) return;
            e.preventDefault();
            _dragTab = tab;
            _dragStartX = e.clientX;
            _dragging = false;
            _dropTarget = null;
        });

        document.addEventListener('mousemove', function (e) {
            if (!_dragTab) return;
            if (!_dragging) {
                // Start dragging only after a 4px threshold
                if (Math.abs(e.clientX - _dragStartX) < 4) return;
                _dragging = true;
                _dragTab.classList.add('bm-tab-dragging');
            }
            // Find the drop target
            clearDropIndicators();
            var tabs = nav.querySelectorAll('.bm-tab');
            var best = null;
            var bestDist = Infinity;
            for (var i = 0; i < tabs.length; i++) {
                if (tabs[i] === _dragTab) continue;
                var rect = tabs[i].getBoundingClientRect();
                var center = rect.left + rect.width / 2;
                var dist = Math.abs(e.clientX - center);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = tabs[i];
                }
            }
            if (best) {
                var bestRect = best.getBoundingClientRect();
                // Drop before or after depending on cursor position
                if (e.clientX < bestRect.left + bestRect.width / 2) {
                    best.classList.add('bm-tab-drop-before');
                    _dropTarget = { ref: best, pos: 'before' };
                } else {
                    // Show indicator on the next sibling if any
                    var next = best.nextElementSibling;
                    if (next && next.classList.contains('bm-tab')) {
                        next.classList.add('bm-tab-drop-before');
                    }
                    _dropTarget = { ref: best, pos: 'after' };
                }
            }
        });

        document.addEventListener('mouseup', function () {
            if (!_dragTab) return;
            clearDropIndicators();
            _dragTab.classList.remove('bm-tab-dragging');
            if (_dragging && _dropTarget) {
                if (_dropTarget.pos === 'before') {
                    nav.insertBefore(_dragTab, _dropTarget.ref);
                } else {
                    // Insert after _dropTarget.ref
                    var after = _dropTarget.ref.nextSibling;
                    nav.insertBefore(_dragTab, after);
                }
                saveCustomOrder();
                renderLayoutPreview('custom');
            }
            _dragTab = null;
            _dragging = false;
            _dropTarget = null;
        });

        /**
         * Clear all drop indicator classes from tab buttons.
         * @inner
         */
        function clearDropIndicators() {
            var tabs = nav.querySelectorAll('.bm-tab');
            for (var i = 0; i < tabs.length; i++) {
                tabs[i].classList.remove('bm-tab-drop-before');
            }
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

        // Restore saved height
        try {
            var savedH = localStorage.getItem(ENV_HEIGHT_STORAGE_KEY);
            if (savedH) wrap.style.maxHeight = savedH + 'px';
        } catch (e) {}

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
                try {
                    localStorage.setItem(ENV_HEIGHT_STORAGE_KEY, parseInt(wrap.style.maxHeight, 10));
                } catch (e) {}
            }
        });
    }

    /**
     * Wire the copy button on the environment info panel. Copies all
     * key-value pairs as plain text (one per line, "key: value" format).
     * Shows a brief "Copied" visual feedback on the button.
     * @inner
     */
    function setupEnvCopy() {
        var btn = qs('#bm-env-copy');
        if (!btn) return;
        btn.addEventListener('click', function () {
            if (!ginaData || !ginaData.user || !ginaData.user.environment) return;
            var env = ginaData.user.environment;
            var skip = { routing: 1, reverseRouting: 1, forms: 1 };
            var lines = [];
            var keys = Object.keys(env);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (skip[k]) continue;
                var v = env[k];
                if (typeof v === 'object' && v !== null) continue;
                lines.push(k + ': ' + String(v));
            }
            var text = lines.join('\n');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
            } else {
                fallbackCopy(text);
            }
            btn.classList.add('copied');
            setTimeout(function () { btn.classList.remove('copied'); }, 900);
        });
    }

    /**
     * Set up drag-to-resize on the Flow tab label column.
     * A vertical handle between the label and the waterfall track lets
     * the user widen or narrow the left panel. Width is persisted in
     * localStorage across sessions.
     * @inner
     */
    function setupFlowResize() {
        var handle = qs('#bm-flow-resize');
        if (!handle) return;

        // Restore saved width
        try {
            var savedW = localStorage.getItem(FLOW_LABEL_WIDTH_KEY);
            if (savedW) {
                document.documentElement.style.setProperty('--flow-label-w', savedW + 'px');
            }
        } catch (e) {}

        var startX = 0, startW = 0, dragging = false;

        handle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            startX = e.clientX;
            // Read current computed width of the first label
            var firstLabel = qs('.bm-flow-label');
            startW = firstLabel ? firstLabel.offsetWidth : 280;
            dragging = true;
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var newW = Math.max(120, Math.min(500, startW + (e.clientX - startX)));
            document.documentElement.style.setProperty('--flow-label-w', newW + 'px');
        });

        document.addEventListener('mouseup', function () {
            if (dragging) {
                dragging = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                try {
                    var cur = getComputedStyle(document.documentElement).getPropertyValue('--flow-label-w');
                    localStorage.setItem(FLOW_LABEL_WIDTH_KEY, parseInt(cur, 10));
                } catch (e) {}
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
        var revealBtn = qs('#bm-reveal');
        if (revealBtn) {
            revealBtn.addEventListener('click', toggleReveal);
            // Restore the previously-saved Reveal state on init: if it was on
            // and the source is still local, fetch the unredacted snapshot.
            try {
                if (localStorage.getItem(REVEAL_STORAGE_KEY) === '1') {
                    // Defer one tick so ginaData is populated by the first poll.
                    setTimeout(function () {
                        var scope = (ginaData && ginaData.gina && ginaData.gina.environment)
                            ? ginaData.gina.environment.scope : null;
                        if (scope === 'local') toggleReveal();
                        else { try { localStorage.removeItem(REVEAL_STORAGE_KEY); } catch (e) {} }
                    }, 250);
                }
            } catch (e) {}
        }
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

        // ── Log row selection: click, Shift+click, Ctrl/Cmd+click, drag ──
        var _dragSelecting = false;
        var _dragStartLid  = -1;
        var _dragMoved     = false;

        var logList = qs('#bm-log-list');

        /** @inner */
        function applySelectionClasses() {
            var allRows = qsa('.bm-log[data-lid]', logList);
            for (var i = 0; i < allRows.length; i++) {
                var r = allRows[i];
                r.classList.toggle('bm-log-selected', selectedLogIds.has(+r.getAttribute('data-lid')));
            }
        }

        /** @inner */
        function selectRange(fromLid, toLid, additive) {
            var rows = qsa('.bm-log[data-lid]', logList);
            var ids  = rows.map(function (r) { return +r.getAttribute('data-lid'); });
            var fromIdx = ids.indexOf(fromLid);
            var toIdx   = ids.indexOf(toLid);
            if (fromIdx === -1 || toIdx === -1) return;
            if (!additive) selectedLogIds.clear();
            var lo = Math.min(fromIdx, toIdx), hi = Math.max(fromIdx, toIdx);
            for (var j = lo; j <= hi; j++) selectedLogIds.add(ids[j]);
        }

        logList.addEventListener('mousedown', function (ev) {
            var row = ev.target.closest('.bm-log[data-lid]');
            if (!row) return;
            ev.preventDefault();
            _dragSelecting = true;
            _dragMoved     = false;
            _dragStartLid  = +row.getAttribute('data-lid');
        });

        document.addEventListener('mousemove', function (ev) {
            if (!_dragSelecting) return;
            var row = ev.target.closest('.bm-log[data-lid]');
            if (!row) return;
            var lid = +row.getAttribute('data-lid');
            if (lid === _dragStartLid && !_dragMoved) return;
            _dragMoved = true;
            selectRange(_dragStartLid, lid, false);
            applySelectionClasses();
            updateSelectionUI();
        });

        document.addEventListener('mouseup', function (ev) {
            if (!_dragSelecting) return;
            _dragSelecting = false;

            if (_dragMoved) {
                // Drag completed — selection is already applied
                lastClickedLid = _dragStartLid;
                return;
            }

            // No drag movement — treat as a click
            var row = ev.target.closest('.bm-log[data-lid]');
            if (!row) return;
            var lid = +row.getAttribute('data-lid');

            if (ev.shiftKey && lastClickedLid >= 0) {
                selectRange(lastClickedLid, lid, ev.ctrlKey || ev.metaKey);
            } else if (ev.ctrlKey || ev.metaKey) {
                if (selectedLogIds.has(lid)) selectedLogIds.delete(lid);
                else selectedLogIds.add(lid);
                lastClickedLid = lid;
            } else {
                // Plain click — select this row, show accent, copy, then fade
                selectedLogIds.clear();
                selectedLogIds.add(lid);
                lastClickedLid = lid;
                applySelectionClasses();
                updateSelectionUI();
                copySelectedLogs();
                row.classList.add('bm-log-row-copied');
                setTimeout(function () { row.classList.remove('bm-log-row-copied'); }, 900);
                return; // applySelectionClasses already called
            }
            applySelectionClasses();
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
            // #B225 — derive from the live payload exactly as renderTab('query')
            // does (reveal swap included), never from the module query cache:
            // the cache survives overlay eras that ended while the Query tab
            // was inactive, so a cached repaint resurrects dead queries and
            // rewrites the badge over the truthful one.
            var src = (_revealActive && _revealedData) ? _revealedData : ginaData;
            var u = (src && src.user) || {};
            var hasXhr = typeof u['data-xhr'] !== 'undefined';
            var queryData = hasXhr && u['data-xhr'] && u['data-xhr'].queries
                ? u['data-xhr'].queries : u.queries;
            if (!queryData || !queryData.length) return;
            var panel = qs('#tree-query');
            if (panel) {
                panel.innerHTML = renderQueryContent(queryData);
            }
        }

        // Restore persisted query filter state
        try {
            var _savedLang = localStorage.getItem(QUERY_LANG_KEY);
            var _savedConn = localStorage.getItem(QUERY_CONNECTOR_KEY);
            var _savedBundle = localStorage.getItem(QUERY_BUNDLE_KEY);
            if (_savedLang) _queryFilterLang = _savedLang;
            if (_savedConn) _queryFilterConnector = _savedConn;
            if (_savedBundle) _queryFilterBundle = _savedBundle;
        } catch (e) {}

        var querySearchEl = qs('#bm-query-search');
        if (querySearchEl) {
            querySearchEl.addEventListener('input', function () {
                _querySearchTxt = this.value || '';
                _queryShowAll = false;
                if (_querySearchTimer) clearTimeout(_querySearchTimer);
                _querySearchTimer = setTimeout(function () { rerenderQueries(); }, 200);
            });
        }
        var queryLangEl = qs('#bm-query-lang');
        if (queryLangEl) {
            if (_queryFilterLang) queryLangEl.value = _queryFilterLang;
            queryLangEl.addEventListener('change', function () {
                _queryFilterLang = this.value;
                _queryShowAll = false;
                try { localStorage.setItem(QUERY_LANG_KEY, this.value); } catch (e) {}
                rerenderQueries();
            });
        }
        var queryConnEl = qs('#bm-query-connector');
        if (queryConnEl) {
            if (_queryFilterConnector) queryConnEl.value = _queryFilterConnector;
            queryConnEl.addEventListener('change', function () {
                _queryFilterConnector = this.value;
                _queryShowAll = false;
                try { localStorage.setItem(QUERY_CONNECTOR_KEY, this.value); } catch (e) {}
                rerenderQueries();
            });
        }
        var queryBundleEl = qs('#bm-query-bundle');
        if (queryBundleEl) {
            if (_queryFilterBundle) queryBundleEl.value = _queryFilterBundle;
            queryBundleEl.addEventListener('change', function () {
                _queryFilterBundle = this.value;
                _queryShowAll = false;
                try { localStorage.setItem(QUERY_BUNDLE_KEY, this.value); } catch (e) {}
                rerenderQueries();
            });
        }

        // "Show all" button — delegated click handler for query pagination
        document.addEventListener('click', function (e) {
            if (e.target.classList.contains('bm-query-show-all')) {
                _queryShowAll = true;
                rerenderQueries();
            }
        });

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

        // Index badge copy — delegated click handler
        document.addEventListener('click', function (e) {
            var badge = e.target.closest('.bm-idx-copy');
            if (!badge) return;
            var name = badge.getAttribute('data-idx-name');
            if (!name) return;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(name).catch(function () { fallbackCopy(name); });
            } else {
                fallbackCopy(name);
            }
            badge.classList.add('copied');
            setTimeout(function () { badge.classList.remove('copied'); }, 900);
        });

        // Banner anchor click — smooth scroll + highlight on query card
        document.addEventListener('click', function (e) {
            var link = e.target.closest('.bm-idx-banner-link') || e.target.closest('.bm-perf-banner-link');
            if (!link) return;
            e.preventDefault();
            var targetId = link.getAttribute('href');
            if (!targetId) return;
            var card = qs(targetId);
            if (!card) return;
            var hlClass = link.classList.contains('bm-perf-banner-link') ? 'bm-perf-highlight' : 'bm-idx-highlight';
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add(hlClass);
            setTimeout(function () { card.classList.remove(hlClass); }, 2000);
        });

        setupSettings();
        setupEnvResize();
        setupEnvCopy();
        setupFlowResize();
        setupScrollToTop();

        // ── Refresh button — force immediate re-poll ────────────────────────
        // Click        = soft refresh (data, live indexes, reveal snapshot,
        //                passive agent stream).
        // Shift+click  = also reload the inspected page via window.opener.
        var refreshBtn = qs('#bm-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function (ev) {
                lastGdStr = '';
                refreshBtn.classList.add('spinning');
                pollData();

                // Bypass the cache guard in fetchLiveIndexes().
                _liveIndexes = null;
                _liveIndexesFetching = false;
                fetchLiveIndexes();

                if (_revealActive) {
                    var base = resolveBundleBase();
                    try {
                        var xhr = new XMLHttpRequest();
                        xhr.open('GET', base + '/_gina/reveal', true);
                        xhr.onreadystatechange = function () {
                            if (xhr.readyState !== 4) return;
                            if (xhr.status === 200) {
                                try {
                                    _revealedData = JSON.parse(xhr.responseText);
                                    renderTab('data');
                                } catch (e) {}
                            }
                        };
                        xhr.send();
                    } catch (e) {}
                }

                // Reopen the passive /_gina/agent stream if it has closed.
                // #B225 — never in bound mode: a broadcast-driven window takes
                // its data from the statusbar publisher (#INS15), and a passive
                // stream opened here applies bundle-wide payloads over the
                // page-scoped ones (the measured badge blink at every later XHR
                // overlay); a later _noteLivePid could also retro-arm the leak
                // on bound applies.
                if (source !== 'agent' && source !== 'broadcast'
                    && (!_passiveAgentEs || _passiveAgentEs.readyState === 2)) {
                    try { if (_passiveAgentEs) _passiveAgentEs.close(); } catch (e) {}
                    _passiveAgentEs = null;
                    // #B205 — keep the re-opened stream on the currently-followed
                    // bundle instead of re-deriving from the opener's deep path.
                    tryAgentPassive(_channelBase !== null ? _channelBase : undefined);
                }

                if (ev.shiftKey) {
                    try {
                        if (window.opener && !window.opener.closed && window.opener.location) {
                            window.opener.location.reload();
                        }
                    } catch (e) {}
                }

                refreshBtn.addEventListener('animationend', function onEnd() {
                    refreshBtn.classList.remove('spinning');
                    refreshBtn.removeEventListener('animationend', onEnd);
                }, { once: true });
            });
        }

        // ── Data source acquisition ────────────────────────────────────────
        // Agent mode (?target= param) is the highest-priority source — it
        // provides both data and logs via a single SSE stream.  When active,
        // opener/localStorage polling and tryServerLogs() are unnecessary.
        // #INS9b — WebSocket is the DEFAULT agent transport; SSE is the automatic
        // fallback (tryAgentWS() falls back to tryAgent() on a failed open, and
        // only acts when a ?target= is present). ?transport=sse forces SSE. On a
        // successful handshake tryAgentWS() claims source='agent', so the
        // tryAgent() call below short-circuits to a no-op.
        var _agentTransport = (typeof URLSearchParams !== 'undefined')
            ? new URLSearchParams(window.location.search).get('transport') : null;
        if (_agentTransport !== 'sse') {
            tryAgentWS();
        }
        var isAgent = tryAgent();

        if (!isAgent) {
            // Bound mode (#INS) — the statusbar opened us with ?ch=<tabId>. Bind
            // to that tab's per-tab BroadcastChannel so the data tabs track THIS
            // tab only (immune to other tabs'/XHR renders that clobber the
            // bundle-global localStorage + SSE channels COOP forces us onto when
            // it severs window.opener). Server logs still arrive via the SSE.
            var _boundCh = (typeof URLSearchParams !== 'undefined')
                ? new URLSearchParams(window.location.search).get('ch') : null;
            if (setupBoundChannel(_boundCh)
                // #B231 — no usable ?ch=: adopt the statusbar's advertised tab
                // channel (bound mode) instead of the bundle-global fallback; a
                // dead advert hands over to _startLegacyAcquisition via the
                // liveness-handshake timer inside _adoptAdvertisedChannel().
                || _adoptAdvertisedChannel(_startLegacyAcquisition)) {
                qs('#bm-no-source').classList.add('hidden');
                tryServerLogs();   // server logs only; data via the bound channel
            } else {
                _startLegacyAcquisition();
            }
            updateSourceModeBadge();

            /**
             * Legacy bundle-global acquisition — opener/localStorage polling +
             * the passive `/_gina/agent` SSE (+ engine.io + the "No source"
             * connect form). Runs when neither an explicit `?ch=` nor an
             * adopted advertised channel yields bound mode — and again from
             * `_adoptAdvertisedChannel`'s handshake timer when an adopted
             * channel turns out dead (#B231). Body unchanged from the
             * pre-#B231 inline `else` block; only the connect-form wiring
             * moved into the nested `_wireConnectForm()` below.
             * @inner
             */
            function _startLegacyAcquisition() {
                var ok = tryOpener() || tryLocalStorage();
                if (!ok) {
                    hideLoader();
                    qs('#bm-no-source').classList.remove('hidden');
                    qs('#bm-dot').className = 'bm-dot err';
                    qs('#bm-label').textContent = 'No source';
                }

                _wireConnectForm();

                tryEngineIO();
                // Subscribe to /_gina/agent in parallel with opener polling. Opener
                // polling alone misses SPA (pushState) and XHR renders because
                // those paths never rewrite window.__ginaData. The passive agent
                // stream delivers pushed data + log frames from those renders.
                // It also supersedes tryServerLogs() (same `event: log` frames).
                var _passiveAgentActive = tryAgentPassive();
                if (!_passiveAgentActive) tryServerLogs();
                updateSourceModeBadge();

                /**
                 * Manual connect form on the "No source" overlay.
                 *
                 * When the Inspector opens without a `?target=` param and without
                 * `window.opener`, a form is shown allowing the user to type a
                 * bundle URL.  On submit the page reloads with `?target=<url>`,
                 * which activates `tryAgent()` and connects via SSE.
                 *
                 * The handler auto-prefixes `http://` when no scheme is provided
                 * and strips trailing slashes before encoding the target.
                 *
                 * @inner
                 */
                function _wireConnectForm() {
                    var connectForm = qs('#bm-connect-form');
                    if (connectForm) {
                        connectForm.addEventListener('submit', function (ev) {
                            ev.preventDefault();
                            var urlInput = qs('#bm-connect-url');
                            var raw = (urlInput.value || '').trim();
                            if (!raw) return;
                            // Normalise: add scheme if missing, strip trailing slash
                            if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
                            raw = raw.replace(/\/+$/, '');
                            // Navigate with ?target= to activate agent mode
                            var loc = window.location.pathname + '?target=' + encodeURIComponent(raw);
                            // #INS9b — append the optional inspector key (?key=) for an
                            // auth-gated agent endpoint. Kept in the URL only (ephemeral);
                            // never persisted to localStorage.
                            var keyInput = qs('#bm-connect-key');
                            var keyRaw = keyInput ? (keyInput.value || '').trim() : '';
                            if (keyRaw) {
                                loc += '&key=' + encodeURIComponent(keyRaw);
                            }
                            window.location.href = loc;
                        });
                    }
                }
            }
        } else {
            // #B306 — agent mode skips every acquisition-path badge call above
            // AND never schedules pollData (see the polling block below), so
            // this is the only place the badge's `agent` branch is reachable on
            // this entry path. Without it the same mode renders when reached via
            // the connect form (whose timer is already ticking when `source`
            // becomes 'agent') but stays hidden under a URL `?target=` — badged
            // or silent depending purely on how the Inspector was opened, which
            // defeats #B231's "visible instead of silent" purpose. `tryAgent()`
            // has already settled `source` to 'agent' by the time it returns
            // true — including when `tryAgentWS()` claimed the channel first, on
            // which path it short-circuits via its own `source === 'agent'`
            // guard — so the badge reads the final mode, not an interim one.
            updateSourceModeBadge();
        }

        // ── Persist window geometry on resize/move ──────────────────────────
        var _geoTimer = null;
        function saveGeometry() {
            try {
                localStorage.setItem(GEOMETRY_STORAGE_KEY, JSON.stringify({
                    w: window.outerWidth,
                    h: window.outerHeight,
                    x: window.screenX,
                    y: window.screenY
                }));
            } catch (e) {}
        }
        function debouncedSaveGeometry() {
            if (_geoTimer) clearTimeout(_geoTimer);
            _geoTimer = setTimeout(saveGeometry, 300);
        }
        window.addEventListener('resize', debouncedSaveGeometry);
        window.addEventListener('beforeunload', saveGeometry);

        // In agent mode, data arrives via SSE push — no polling needed, and the
        // timer is deliberately NOT scheduled.
        //
        // #B306 — the comment previously here claimed the opposite ("pollData()
        // still runs on the timer as a no-op … so the refresh button works").
        // Both halves were wrong, so do not "reconcile" this guard to match it:
        // pollData() is NOT a no-op under `source === 'agent'` — it re-renders
        // the active tab from cache before returning — so a ticking timer would
        // repaint every pollDataMs and fight scroll position, expanded folds and
        // text selection. And the refresh button needs no timer either: it calls
        // pollData() directly.
        if (!isAgent) {
            pollDataTimer = setInterval(pollData, pollDataMs);
            setInterval(pollLogs, POLL_LOGS_MS);
            pollData();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}());
