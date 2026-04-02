/**
 * Beemaster SPA client
 *
 * Served at /_gina/beemaster/ — same origin as the monitored bundle.
 *
 * Data channels (in priority order):
 *   1. window.opener.__ginaData  — same-origin polling (always available)
 *   2. engine.io socket          — real-time streaming (requires ioServer config)
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

    // ── State ──────────────────────────────────────────────────────────────
    var source  = null;               // window.opener (same-origin)
    var ginaData = null;              // last __ginaData snapshot
    var logs    = [];                 // accumulated log entries
    var logsOff = 0;                  // consumed index into source.__ginaLogs
    var paused  = false;
    var lastGdStr = '';               // for change detection

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
    function renderTree(val, depth) {
        depth = depth || 0;

        if (val === null || val === undefined) {
            return '<span class="bm-null">null</span>';
        }
        if (typeof val === 'boolean') {
            return '<span class="bm-bool">' + val + '</span>';
        }
        if (typeof val === 'number') {
            return '<span class="bm-num bm-copyable" title="Click to copy">' + val + '</span>';
        }
        if (typeof val === 'string') {
            return '<span class="bm-str bm-copyable" title="Click to copy">' + escHtml(val) + '</span>';
        }
        if (Array.isArray(val)) {
            if (val.length === 0) return '<span class="bm-empty">[ ]</span>';
            var h = '<details' + (depth < 2 ? ' open' : '') + '>'
                + '<summary class="bm-summary">'
                + '<span class="bm-bracket">[</span>'
                + '<span class="bm-count">' + val.length + '</span>'
                + '<span class="bm-bracket">]</span>'
                + '</summary>'
                + '<ul class="bm-tree">';
            for (var i = 0; i < val.length; i++) {
                h += '<li><span class="bm-index">' + i + '</span> ' + renderTree(val[i], depth + 1) + '</li>';
            }
            return h + '</ul></details>';
        }
        if (typeof val === 'object') {
            var keys = Object.keys(val).sort();
            if (keys.length === 0) return '<span class="bm-empty">{ }</span>';
            var h = '<details' + (depth < 2 ? ' open' : '') + '>'
                + '<summary class="bm-summary">'
                + '<span class="bm-bracket">{</span>'
                + '<span class="bm-count">' + keys.length + '</span>'
                + '<span class="bm-bracket">}</span>'
                + '</summary>'
                + '<ul class="bm-tree">';
            for (var ki = 0; ki < keys.length; ki++) {
                var k = keys[ki];
                h += '<li>'
                    + '<span class="bm-key">' + escHtml(k) + '</span>'
                    + '<span class="bm-colon">:</span> '
                    + renderTree(val[k], depth + 1)
                    + '</li>';
            }
            return h + '</ul></details>';
        }
        return '<span class="bm-str bm-copyable" title="Click to copy">' + escHtml(String(val)) + '</span>';
    }

    // ── Tab / subtab management ────────────────────────────────────────────
    function switchTab(name) {
        qsa('.bm-tab').forEach(function (t) {
            t.classList.toggle('active', t.dataset.tab === name);
        });
        qsa('.bm-panel').forEach(function (p) {
            p.classList.toggle('active', p.id === 'tab-' + name);
        });
    }

    function switchSubtab(name) {
        qsa('.bm-subtab').forEach(function (t) {
            t.classList.toggle('active', t.dataset.subtab === name);
        });
        qsa('.bm-subpanel').forEach(function (p) {
            p.classList.toggle('active', p.id === 'subtab-' + name);
        });
        renderSubtab(name);
    }

    function activeSubtab() {
        var active = qs('.bm-subtab.active');
        return active ? active.dataset.subtab : 'data';
    }

    // ── Subtab rendering ───────────────────────────────────────────────────
    function renderSubtab(name) {
        var panel = qs('#subtab-' + name + ' .bm-tree-root');
        if (!panel) return;

        if (!ginaData) {
            panel.innerHTML = '<span class="bm-hint">Waiting for source data\u2026</span>';
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
            case 'config': {
                // Strip large encoded fields to keep the panel readable
                var env = u.environment ? JSON.parse(JSON.stringify(u.environment)) : {};
                delete env.routing;
                delete env.reverseRouting;
                content = renderTree(env, 0);
                break;
            }
            case 'routing':
                loadRouting(panel);
                return;
        }

        panel.innerHTML = content || '<span class="bm-empty">No data</span>';
    }

    function loadRouting(panel) {
        // Same origin — fetch routing.json from the opener's bundle
        var origin = '';
        try {
            if (source && source.location) origin = source.location.origin;
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

    // ── Source connection ──────────────────────────────────────────────────
    function tryOpener() {
        try {
            if (!window.opener) return false;
            // Probe same-origin access — always works since /_gina/beemaster/
            // is served from the same bundle origin
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
            renderSubtab(activeSubtab());
        } catch (e) {
            if (source !== 'localStorage') source = null;
            qs('#bm-dot').className = 'bm-dot err';
        }
    }

    // ── Log polling ────────────────────────────────────────────────────────
    function pollLogs() {
        if (paused || !source) return;
        try {
            var src = source.__ginaLogs;
            if (!src || !Array.isArray(src)) return;
            if (src.length <= logsOff) return;
            var fresh = src.slice(logsOff);
            logsOff = src.length;
            fresh.forEach(function (e) { logs.push(e); });
            if (logs.length > MAX_LOG_ENTRIES) logs = logs.slice(logs.length - MAX_LOG_ENTRIES);
            renderLogs();
        } catch (e) {}
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
            if (source && source.location) port = source.location.port;
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
                        renderSubtab(activeSubtab());
                    } else if (msg.type === 'log' && msg.data && !paused) {
                        logs.push(msg.data);
                        if (logs.length > MAX_LOG_ENTRIES) logs.shift();
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

        // Subtab buttons
        qsa('.bm-subtab').forEach(function (btn) {
            btn.addEventListener('click', function () { switchSubtab(this.dataset.subtab); });
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
            try { logsOff = source && source.__ginaLogs ? source.__ginaLogs.length : 0; } catch (e) {}
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
