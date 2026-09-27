/**
 * Release-watch stale-release banner (#RWATCH S3).
 *
 * Server-side inline injector for a self-contained, Shadow-DOM-isolated
 * "stale built-release" banner. The sync render delegates
 * (controller.render-swig.js / controller.render-nunjucks.js) call
 * `maybeInject()` on the finalized HTML BEFORE the render-cache write, so the
 * banner rides both cache-MISS renders AND cache-HIT replays — an output-cache
 * hit is served verbatim from the stored bytes (server.isaac.js) and never
 * re-enters the delegate, so the banner MUST live in what `writeCache` stores.
 *
 * The banner is deliberately STATE-AGNOSTIC: it carries no render-time
 * staleness verdict (which would freeze into the cached bytes and go wrong the
 * moment source changes between renders). A tiny client script fetches
 * `/_gina/release/status` on load and subscribes to the `/_gina/release/events`
 * SSE, so the banner appears + updates at RUNTIME — correct on every hit/miss.
 *
 * Gate mirrors the boot-init in core/server.js: local scope + non-dev +
 * `server.releaseWatch.enabled === true`. Byte-inert (returns the HTML
 * unchanged) in every other case — zero footprint on prod/beta/dev/CLI and on
 * real clusters.
 *
 * NO dist rebuild: this is server-side only (never in the browser bundle);
 * hot-reloads per render in dev/cacheless mode like the statusbar (#TPL2).
 *
 * @module core/controller/release-banner
 */
'use strict';

/**
 * Double-injection guard token + Shadow-DOM host id. Present in the emitted
 * snippet, so a second `maybeInject()` on the same HTML is a no-op (a cached
 * page that already carries the banner is never re-injected).
 * @constant {string}
 */
var MARKER = 'gina-release-watch-banner';

/**
 * The browser-side banner client. Written as a real function and serialised
 * via `.toString()` at inject time — it must be fully self-contained (it may
 * reference only its `marker` argument and browser globals; NO closure over
 * module scope survives serialisation).
 *
 * Absolute `/_gina/release/*` paths (NOT webroot-prefixed — the endpoints match
 * on the origin-root URL). `status`/`events` are queried with BARE paths: their
 * handler regexes are `^…$` with no query group, so a `?cache-buster` 404s;
 * only `rebuild` takes `?restart=`.
 *
 * @inner
 * @param {string} marker - the {@link MARKER} token (host id + run-once guard).
 * @returns {void}
 */
function CLIENT(marker) {
    if (window[marker]) { return; } // run once per document
    window[marker] = true;

    var host = document.createElement('div');
    host.id = marker;
    host.setAttribute('data-gina-release-watch', '1');
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
        '<style>'
      + ':host{all:initial}'
      + '.bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'
      + 'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
      + 'background:#1f2430;color:#e6e6e6;border-top:2px solid #e0a33e;'
      + 'box-shadow:0 -2px 14px rgba(0,0,0,.4);padding:9px 14px;'
      + 'box-sizing:border-box;display:none;align-items:center;gap:12px}'
      + '.bar.show{display:flex}'
      + '.ico{font-size:15px;color:#e0a33e;flex:0 0 auto}'
      + '.msg{flex:0 0 auto;font-weight:600}'
      + '.detail{flex:1 1 auto;min-width:0;color:#9aa4b2;font-size:12px;'
      + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + 'button{font:inherit;cursor:pointer;border:0;border-radius:5px;'
      + 'padding:6px 12px;color:#fff;flex:0 0 auto}'
      + '.rebuild{background:#e0a33e;color:#1f2430;font-weight:700}'
      + '.force{background:#6b7280}'
      + '.rebuild[disabled],.force[disabled]{opacity:.5;cursor:default}'
      + '.x{background:transparent;color:#9aa4b2;padding:6px 9px;font-size:16px;line-height:1}'
      + '</style>'
      + '<div class="bar">'
      + '<span class="ico">⟳</span>'
      + '<span class="msg"></span>'
      + '<span class="detail"></span>'
      + '<button type="button" class="rebuild">Rebuild &amp; reload</button>'
      + '<button type="button" class="force" style="display:none">Force restart</button>'
      + '<button type="button" class="x" title="dismiss" aria-label="dismiss">×</button>'
      + '</div>';
    (document.body || document.documentElement).appendChild(host);

    var bar     = root.querySelector('.bar');
    var msgEl   = root.querySelector('.msg');
    var detEl   = root.querySelector('.detail');
    var reBtn   = root.querySelector('.rebuild');
    var fcBtn   = root.querySelector('.force');
    var xBtn    = root.querySelector('.x');
    var busy    = false; // a rebuild pipeline is running — don't clobber progress

    function show()      { bar.classList.add('show'); }
    function hide()      { bar.classList.remove('show'); }
    function setMsg(t)   { msgEl.textContent = t; }
    function setDet(t)   { detEl.textContent = t || ''; }
    function sevLabel(s) {
        return s === 'restart' ? 'New server code — rebuild + restart needed'
             : s === 'assets'  ? 'Static assets changed — rebuild needed'
             : 'Release is stale';
    }
    function fmtChanges(c) {
        if (!c || !c.length) { return ''; }
        return 'changed: ' + c.slice(0, 3).join(', ') + (c.length > 3 ? ' +' + (c.length - 3) : '');
    }
    function offerRebuild(sev, changes) {
        if (busy) { return; }
        setMsg(sevLabel(sev));
        setDet(fmtChanges(changes));
        reBtn.textContent = 'Rebuild & reload';
        reBtn.disabled = false;
        fcBtn.style.display = 'none';
        show();
    }

    // Reload once the served page reflects the new release. For an assets/build
    // rebuild the process stays up + the cache was flushed, so reload now. For a
    // restart the process bounces — poll status until a FRESH process answers
    // (active && !stale), robust to the SSE dropping during the drain/kill/boot.
    function reloadWhenReady(needsFresh) {
        if (!needsFresh) { location.reload(); return; }
        var tries = 0;
        (function poll() {
            tries++;
            fetch('/_gina/release/status', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (s) {
                    if (s && s.active && s.stale === false) { location.reload(); }
                    else if (tries < 40) { setTimeout(poll, 700); }
                    else { location.reload(); }
                })
                .catch(function () {
                    if (tries < 40) { setTimeout(poll, 700); } else { location.reload(); }
                });
        })();
    }

    function onEvent(evt) {
        var t = evt.type, d = evt.data || {};
        if (t === 'status') {
            if (d && d.stale) { offerRebuild(d.severity, d.changes); }
            else if (!busy)   { hide(); }
            return;
        }
        if (t === 'stale')      { offerRebuild(d.severity, d.changes); return; }
        if (t === 'behind')     { if (d.processBehind) { offerRebuild('restart', null); } return; }
        if (t === 'build')      { busy = true; show(); setMsg('Rebuilding…'); setDet(d.line || ''); return; }
        if (t === 'waiting')    { busy = true; setMsg('Waiting for idle…'); setDet((d.inFlight || 0) + ' request(s) in flight'); fcBtn.style.display = ''; fcBtn.disabled = false; return; }
        if (t === 'flushed')    { busy = true; setDet('cache flushed'); return; }
        if (t === 'restarting') { busy = true; setMsg('Restarting…'); setDet('gate: ' + (d.how || '')); fcBtn.style.display = 'none'; reloadWhenReady(true); return; }
        if (t === 'done') {
            if (d.restarted)      { setMsg('Restarted — reloading…'); return; } // reloadWhenReady already running
            if (d.restartPending) { busy = false; setMsg('Rebuilt — restart pending'); reBtn.textContent = 'Restart & reload'; reBtn.disabled = false; fcBtn.style.display = ''; fcBtn.disabled = false; return; }
            setMsg('Rebuilt — reloading…'); reloadWhenReady(false); return;
        }
        if (t === 'error')      { busy = false; setMsg('Rebuild failed'); setDet(d.message || ''); reBtn.disabled = false; return; }
    }

    function rebuild(mode) {
        busy = true;
        reBtn.disabled = true;
        setMsg('Rebuilding…');
        setDet('');
        fetch('/_gina/release/rebuild?restart=' + mode, { method: 'POST', cache: 'no-store' })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (res) {
                if (res && res.accepted === false) {
                    busy = false;
                    setMsg('Busy — a rebuild is already running');
                    reBtn.disabled = false;
                }
                // otherwise progress + completion arrive over the SSE
            })
            .catch(function () {
                busy = false;
                setMsg('Rebuild request failed');
                reBtn.disabled = false;
            });
    }

    reBtn.addEventListener('click', function () { rebuild('auto'); });
    fcBtn.addEventListener('click', function () { rebuild('force'); });
    xBtn.addEventListener('click', function () { hide(); });

    // initial verdict (bare path — the ^…$ handler rejects a query string)
    fetch('/_gina/release/status', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) { if (s && s.stale) { offerRebuild(s.severity, s.changes); } })
        .catch(function () {});

    // live stream — default `message` events (server sends `data: <json>\n\n`)
    try {
        var es = new EventSource('/_gina/release/events');
        es.onmessage = function (m) {
            try { onEvent(JSON.parse(m.data)); } catch (e) {}
        };
    } catch (e) {}
}

/**
 * Build the inline banner snippet: a `<script>` that boots {@link CLIENT}.
 * `$`-bearing — splice via a FUNCTION replacer only (String.prototype.replace
 * dollar-expansion: `$\``, `$'`, `$&`, `$n`).
 *
 * @inner
 * @param {string} nonceAttr - `' nonce="..."'` (#HDR16) or `''` when no nonce.
 * @returns {string} the `<script>…</script>` HTML to splice before `</body>`.
 */
function buildSnippet(nonceAttr) {
    var boot = '(' + CLIENT.toString() + ')(' + JSON.stringify(MARKER) + ');';
    return '<script' + nonceAttr + '>' + boot + '</script>';
}

/**
 * Inject the stale-release banner into a finalized HTML string when the
 * release-watch gate passes, else return the HTML unchanged.
 *
 * Gate (mirrors core/server.js boot-init): `NODE_SCOPE_IS_LOCAL === 'true'`
 * AND `NODE_ENV_IS_DEV !== 'true'` AND `conf.server.releaseWatch.enabled ===
 * true`. Additionally requires a `</body>` anchor (HTML pages only — JSON/API
 * and layoutless partials are skipped) and a fresh page (the {@link MARKER}
 * double-injection guard).
 *
 * Call this on the finalized HTML BEFORE the render-cache write so the banner
 * rides both cache-miss renders and cache-hit replays.
 *
 * @param {string} html - the finalized page HTML.
 * @param {object} conf - the resolved bundle config (`localOptions.conf`).
 * @param {string} [nonceAttr] - `' nonce="..."'` (#HDR16) or `''`/undefined.
 * @returns {string} the HTML with the banner spliced before `</body>`, or the
 *   input unchanged when the gate fails / it is not an HTML page / already present.
 * @example
 * htmlContent = require('./release-banner').maybeInject(htmlContent, localOptions.conf, _cspNonceAttr);
 */
function maybeInject(html, conf, nonceAttr) {
    if (typeof html !== 'string') { return html; }
    var rw = conf && conf.server && conf.server.releaseWatch;
    if (!(
        /^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL)
        && !/^true$/i.test(process.env.NODE_ENV_IS_DEV)
        && rw && rw.enabled === true
    )) {
        return html;
    }
    if (html.indexOf(MARKER) >= 0) { return html; }   // already injected (double-injection guard)
    if (!/<\/body>/i.test(html))   { return html; }   // HTML pages only
    var snippet = buildSnippet(nonceAttr || '');
    return html.replace(/<\/body>/i, function () { return '\n' + snippet + '\n</body>'; });
}

module.exports = {
    maybeInject  : maybeInject,
    _buildSnippet: buildSnippet,
    MARKER       : MARKER
};
