/**
 * Beemaster SPA client
 *
 * Served at /_gina/beemaster/ — same origin as the monitored bundle.
 *
 * Data channels (in priority order):
 *   1. window.opener.__ginaData  — same-origin polling (always available)
 *   2. localStorage.__ginaData   — fallback when opener is unavailable
 *   3. engine.io socket          — real-time streaming (requires ioServer config)
 *
 * Log channel: window.opener.__ginaLogs (array filled by the framework's log
 * capture script injected in dev mode).
 */
(function () {
    'use strict';

    // ── Constants ──────────────────────────────────────────────────────────
    var POLL_DATA_MS = 2000;
    var POLL_LOGS_MS = 1000;
    var MAX_LOG_ENTRIES = 1000;

    // Patterns for detecting special value types
    var RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var RE_URL  = /^https?:\/\//i;
    var RE_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

    // ── State ──────────────────────────────────────────────────────────────
    var source  = null;               // window.opener (same-origin) or 'localStorage'
    var ginaData = null;              // last __ginaData snapshot
    var logs    = [];                 // accumulated log entries
    var logsOff = 0;                  // consumed index into source.__ginaLogs
    var paused  = false;
    var lastGdStr = '';               // for change detection
    var rawMode = {};                 // per-tab raw mode state
    var highestLogLevel = '';         // tracks highest severity for dot indicator

    // ── DOM helpers ────────────────────────────────────────────────────────
    function qs(sel, ctx)  { return (ctx || document).querySelector(sel); }
    function qsa(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

    function escHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── JSON tree renderer ─────────────────────────────────────────────────
    // label: optional key/index to prepend in the summary line
    // labelClass: CSS class for the label span (bm-key or bm-index)
    function renderTree(val, depth, label, labelClass) {
        depth = depth || 0;
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
            var emptyClass = val.length === 0 ? ' is-empty' : '';
            var h = '<details' + (depth < 2 ? ' open' : '') + '>'
                + '<summary class="bm-summary' + emptyClass + '">'
                + labelHtml
                + '<span class="bm-bracket">[</span>'
                + '<span class="bm-count">' + val.length + '</span>'
                + '<span class="bm-bracket">]</span>'
                + '</summary>';
            if (val.length > 0) {
                h += '<ul class="bm-tree">';
                for (var i = 0; i < val.length; i++) {
                    h += '<li>';
                    if (typeof val[i] === 'object' && val[i] !== null) {
                        h += renderTree(val[i], depth + 1, i, 'bm-index');
                    } else {
                        h += '<span class="bm-index">' + i + '</span><span class="bm-colon">:</span> ' + renderTree(val[i], depth + 1);
                    }
                    h += '</li>';
                }
                h += '</ul>';
            }
            return h + '</details>';
        }
        if (typeof val === 'object') {
            var keys = Object.keys(val);
            keys.sort();
            var emptyClass = keys.length === 0 ? ' is-empty' : '';
            var h = '<details' + (depth < 2 ? ' open' : '') + '>'
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
                    if (typeof child === 'object' && child !== null) {
                        h += '<li>' + renderTree(child, depth + 1, k, 'bm-key') + '</li>';
                    } else {
                        h += '<li class="bm-kv">'
                            + '<span class="bm-key">' + escHtml(k) + '</span>'
                            + '<span class="bm-colon">:</span> '
                            + renderTree(child, depth + 1)
                            + '</li>';
                    }
                }
                h += '</ul>';
            }
            return h + '</details>';
        }
        return '<span class="bm-str bm-copyable" title="Click to copy">' + escHtml(String(val)) + '</span>';
    }

    function renderStringValue(val) {
        var escaped = escHtml(val);
        // URLs — render as clickable links
        if (RE_URL.test(val)) {
            return '<span class="bm-link bm-copyable" title="Click to copy">' + escaped + '</span>';
        }
        // UUIDs — render as links (for easy copy)
        if (RE_UUID.test(val)) {
            return '<span class="bm-link bm-copyable" title="Click to copy">' + escaped + '</span>';
        }
        // ISO dates — use string color but distinct
        if (RE_DATE.test(val)) {
            return '<span class="bm-str bm-copyable" title="Click to copy">' + escaped + '</span>';
        }
        return '<span class="bm-str bm-copyable" title="Click to copy">' + escaped + '</span>';
    }

    // ── Tab management ─────────────────────────────────────────────────────
    function activeTab() {
        var active = qs('.bm-tab.active');
        return active ? active.dataset.tab : 'data';
    }

    function switchTab(name) {
        qsa('.bm-tab').forEach(function (t) {
            t.classList.toggle('active', t.dataset.tab === name);
        });
        qsa('.bm-panel').forEach(function (p) {
            p.classList.toggle('active', p.id === 'tab-' + name);
        });
        if (name !== 'logs') {
            renderTab(name);
        }
    }

    // ── Tab rendering ──────────────────────────────────────────────────────
    function renderTab(name) {
        var treeEl = qs('#tree-' + name);
        if (!treeEl) return;

        if (rawMode[name]) {
            renderRaw(name, treeEl);
            return;
        }

        if (!ginaData) {
            treeEl.innerHTML = '<span class="bm-hint">Waiting for source data\u2026</span>';
            return;
        }

        var u = ginaData.user || {};
        var content = '';

        switch (name) {
            case 'data':
                content = renderTree(u.data, 0);
                break;
            case 'view':
                content = renderTree(u.view, 0);
                break;
            case 'forms':
                content = renderTree(u.forms, 0);
                break;
            case 'query':
                loadRouting(treeEl);
                return;
        }

        treeEl.innerHTML = content || '<span class="bm-empty">No data</span>';
    }

    function renderRaw(name, treeEl) {
        if (!ginaData) {
            treeEl.innerHTML = '<span class="bm-hint">No data to display</span>';
            return;
        }
        var u = ginaData.user || {};
        var data;
        switch (name) {
            case 'data':  data = u.data; break;
            case 'view':  data = u.view; break;
            case 'forms': data = u.forms; break;
            case 'query': data = null; break;
        }
        treeEl.innerHTML = '<pre class="bm-raw-view">' + escHtml(JSON.stringify(data, null, 2)) + '</pre>';
    }

    function loadRouting(panel) {
        var origin = '';
        try {
            if (source && source !== 'localStorage' && source.location) origin = source.location.origin;
        } catch (e) {}
        if (!origin) {
            origin = window.location.origin;
        }
        panel.innerHTML = '<span class="bm-hint">Loading routing\u2026</span>';
        fetch(origin + '/_gina/assets/routing.json')
            .then(function (r) { return r.json(); })
            .then(function (data) { panel.innerHTML = renderTree(data, 0); })
            .catch(function (err) {
                panel.innerHTML = '<span class="bm-error">Could not load routing: ' + escHtml(err.message) + '</span>';
            });
    }

    // ── Fold all toggle ────────────────────────────────────────────────────
    function toggleFoldAll(tabName) {
        var panel = qs('#tab-' + tabName + ' .bm-scroll-area');
        if (!panel) return;

        var allDetails = panel.querySelectorAll('details');
        if (!allDetails.length) return;

        // Determine if we should fold or unfold: if any is open, fold all; otherwise unfold all
        var anyOpen = false;
        for (var i = 0; i < allDetails.length; i++) {
            if (allDetails[i].open) { anyOpen = true; break; }
        }

        for (var j = 0; j < allDetails.length; j++) {
            allDetails[j].open = !anyOpen;
        }

        // Update button state
        var btn = qs('#tab-' + tabName + ' .bm-pill-btn');
        if (btn) btn.classList.toggle('active', anyOpen);
    }

    // ── Source connection ──────────────────────────────────────────────────
    function tryOpener() {
        try {
            if (!window.opener) return false;
            void window.opener.location.href;
            source = window.opener;
            return true;
        } catch (e) {
            return false;
        }
    }

    function tryLocalStorage() {
        try {
            var raw = localStorage.getItem('__ginaData');
            if (!raw) return false;
            var gd = JSON.parse(raw);
            if (!gd || !gd.user) return false;
            source = 'localStorage';
            return true;
        } catch (e) {
            return false;
        }
    }

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
                return;
            }
            if (!gd) return;
            var str = JSON.stringify(gd);
            if (str === lastGdStr) return; // unchanged
            lastGdStr = str;
            ginaData = gd;
            // Update target indicator
            var env = (gd.user && gd.user.environment) || {};
            qs('#bm-label').textContent = (env.bundle || '?') + '@' + (env.env || '?');
            qs('#bm-dot').className = 'bm-dot ok';
            qs('#bm-no-source').classList.add('hidden');
            var tab = activeTab();
            if (tab !== 'logs') renderTab(tab);
        } catch (e) {
            if (source !== 'localStorage') source = null;
            qs('#bm-dot').className = 'bm-dot err';
        }
    }

    // ── Log polling ────────────────────────────────────────────────────────
    var LOG_SEVERITY = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

    function pollLogs() {
        if (paused) return;
        var src;
        try {
            if (source === 'localStorage') return;
            if (!source) return;
            src = source.__ginaLogs;
            if (!src || !Array.isArray(src)) return;
            if (src.length <= logsOff) return;
        } catch (e) { return; }

        var fresh = src.slice(logsOff);
        logsOff = src.length;
        fresh.forEach(function (e) { logs.push(e); });
        if (logs.length > MAX_LOG_ENTRIES) logs = logs.slice(logs.length - MAX_LOG_ENTRIES);

        // Update log dot indicator with highest severity
        updateLogDot(fresh);
        renderLogs();
    }

    function updateLogDot(entries) {
        var dot = qs('#bm-log-dot');
        if (!dot) return;

        var highest = highestLogLevel;
        entries.forEach(function (e) {
            var lvl = e.l || 'log';
            if ((LOG_SEVERITY[lvl] || 0) > (LOG_SEVERITY[highest] || -1)) {
                highest = lvl;
            }
        });

        if (highest && highest !== highestLogLevel) {
            highestLogLevel = highest;
            dot.className = 'bm-log-dot active ' + highest;
        }
    }

    function renderLogs() {
        var lvl = qs('#bm-log-level').value;
        var txt = (qs('#bm-log-search').value || '').toLowerCase();
        var list = qs('#bm-log-list');
        if (!list) return;
        var filtered = logs.filter(function (e) {
            if (lvl && e.l !== lvl) return false;
            if (txt && (e.s || '').toLowerCase().indexOf(txt) < 0) return false;
            return true;
        });
        list.innerHTML = filtered.map(function (e) {
            var d  = new Date(e.t);
            var ts = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
            return '<div class="bm-log bm-log-' + escHtml(e.l) + '">'
                + '<span class="bm-log-ts">' + ts + '</span>'
                + '<span class="bm-log-lv">' + escHtml((e.l || '').toUpperCase()) + '</span>'
                + '<span class="bm-log-bun">' + escHtml(e.b || '') + '</span>'
                + '<span class="bm-log-msg">' + escHtml(e.s || '') + '</span>'
                + '</div>';
        }).join('');
        list.scrollTop = list.scrollHeight;
    }

    // ── Engine.io (optional — requires ioServer in bundle settings.json) ──
    function tryEngineIO() {
        /* global eio */
        if (typeof eio === 'undefined') return;
        var port = null;
        try {
            if (source && source !== 'localStorage' && source.location) port = source.location.port;
        } catch (e) {}
        if (!port) port = window.location.port;
        if (!port) return;
        try {
            var sock = eio('ws://localhost:' + port);
            sock.on('open', function () {
                sock.send(JSON.stringify({ type: 'getGinaData' }));
            });
            sock.on('message', function (raw) {
                try {
                    var msg = JSON.parse(raw);
                    if (msg.type === 'ginaData' && msg.data) {
                        ginaData = msg.data;
                        var tab = activeTab();
                        if (tab !== 'logs') renderTab(tab);
                    } else if (msg.type === 'log' && msg.data && !paused) {
                        logs.push(msg.data);
                        if (logs.length > MAX_LOG_ENTRIES) logs.shift();
                        updateLogDot([msg.data]);
                        renderLogs();
                    }
                } catch (e) {}
            });
            sock.on('error', function () { /* engine.io not available */ });
        } catch (e) {}
    }

    // ── Copy to clipboard ──────────────────────────────────────────────────
    function setupCopy() {
        document.addEventListener('click', function (e) {
            var el = e.target.closest('.bm-copyable');
            if (!el) return;
            // Don't copy when clicking on a details summary toggle
            if (el.closest('summary')) {
                // Only copy if the click target is the value element itself, not the summary
                if (e.target.closest('summary') && !e.target.classList.contains('bm-copyable')) return;
            }
            var text = el.textContent;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text).then(function () {
                    flash(el);
                }).catch(function () { fallbackCopy(text, el); });
            } else {
                fallbackCopy(text, el);
            }
        });
    }

    function fallbackCopy(text, el) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); flash(el); } catch (e) {}
        document.body.removeChild(ta);
    }

    function flash(el) {
        el.classList.add('copied');
        setTimeout(function () { el.classList.remove('copied'); }, 700);
    }

    // ── Init ───────────────────────────────────────────────────────────────
    function init() {
        // Main tab buttons
        qsa('.bm-tab').forEach(function (btn) {
            btn.addEventListener('click', function () { switchTab(this.dataset.tab); });
        });

        // Fold all buttons
        ['data', 'view', 'forms', 'query'].forEach(function (tab) {
            var foldBtn = qs('#bm-fold-all' + (tab === 'data' ? '' : '-' + tab));
            if (foldBtn) {
                foldBtn.addEventListener('click', function () {
                    toggleFoldAll(tab);
                });
            }
        });

        // RAW toggle buttons
        ['data', 'view', 'forms', 'query'].forEach(function (tab) {
            var rawBtn = qs('#bm-raw' + (tab === 'data' ? '' : '-' + tab));
            if (rawBtn) {
                rawBtn.addEventListener('click', function () {
                    rawMode[tab] = !rawMode[tab];
                    this.classList.toggle('active', rawMode[tab]);
                    renderTab(tab);
                });
            }
        });

        // Log controls
        qs('#bm-log-level').addEventListener('change', renderLogs);
        qs('#bm-log-search').addEventListener('input', renderLogs);
        qs('#bm-log-pause').addEventListener('click', function () {
            paused = !paused;
            this.textContent = paused ? '\u25B6 Resume' : '\u23F8 Pause';
        });
        qs('#bm-log-clear').addEventListener('click', function () {
            logs = [];
            highestLogLevel = '';
            var dot = qs('#bm-log-dot');
            if (dot) dot.className = 'bm-log-dot';
            try { logsOff = source && source !== 'localStorage' && source.__ginaLogs ? source.__ginaLogs.length : 0; } catch (e) {}
            renderLogs();
        });

        setupCopy();

        // Connect — try window.opener first, fall back to localStorage
        var ok = tryOpener() || tryLocalStorage();
        if (!ok) {
            qs('#bm-no-source').classList.remove('hidden');
            qs('#bm-dot').className = 'bm-dot err';
            qs('#bm-label').textContent = 'No source';
        }

        tryEngineIO();

        // Poll loops
        setInterval(pollData, POLL_DATA_MS);
        setInterval(pollLogs, POLL_LOGS_MS);

        pollData(); // immediate first load
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}());
