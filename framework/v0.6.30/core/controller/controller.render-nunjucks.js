"use strict";
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module core/controller/render-nunjucks
 *
 * Delegate file that handles `self.render()` calls when the bundle's
 * `settings.json > render.engine === 'nunjucks'`. Sister of
 * `controller.render-swig.js`; invoked through `controller.js` `this.render()`
 * dispatch.
 *
 * ## Status — MVP (Session N2 + Inspector + HTTP/2 + error-page ports 2026-04-22)
 *
 * Renders a `.njk` template with locals data and sends an HTTP/1.1 or HTTP/2
 * response. Inspector dev-payload injection, HTTP/2 `stream.respond()` direct
 * path, and error-page template routing are all shipped. The following are
 * still deferred to follow-up sessions and called out inline:
 *
 *   1. ~~**Inspector `__gdPayload`**~~ — **shipped**. `<script>window.__ginaData = ...</script>`
 *      + `<script>window.__ginaLogs = ...</script>` are injected before `</body>`
 *      in dev mode, redacted via `lib/inspector-redact`, stashed on
 *      `self.serverInstance._lastGinaData`, and emitted via
 *      `process.emit('inspector#data')`. The within-port follow-ups shipped
 *      with #M11: the dev statusbar.html body — a leaf with only `{% if %}`
 *      / `{{ }}` tags, valid nunjucks — is rendered through the resolver
 *      module's `renderString()` and spliced post-render (render-swig
 *      inlines the same body into the layout pre-compile — #TPL2), and both
 *      `data.page.flow` (flow timeline from `local._timeline`) and
 *      `data.page.queries` (query log from `local._queryLog`) are piped
 *      into the Inspector payload inside `injectInspectorScripts()`.
 *   2. ~~**HTTP/2 `stream.respond()` direct path**~~ — **shipped 2026-04-22**
 *      (commit TBD). `sendHtmlResponse` now implements the four-way branch
 *      from `class.controller.md §7b` (HEAD×stream, HEAD×HTTP1.1, body×stream,
 *      body×HTTP1.1). HTTP/2 streams bypass the compat layer, merge pipeline-set
 *      headers (CORS, cache-control) via `res.getHeaders()`, and guard
 *      against `stream.destroyed || stream.closed` client disconnects that
 *      would otherwise throw `ERR_HTTP2_INVALID_STREAM`. Early Hints 103
 *      auto-send for CSS/JS preloads is still deferred — that path in swig
 *      runs in `controller.js this.render()` before the delegate is called.
 *   3. ~~**Error-page template routing**~~ — **shipped 2026-04-22** (commit TBD).
 *      When `controller.js renderCustomError()` sets `localOptions.file` to
 *      the absolute path of the bundle's error template (from
 *      `bundleConf.content.templates._common.errorFiles[code]`), the
 *      `isRenderingCustomError` branch below reads the file with
 *      `fs.readFileSync` and renders it via `env.renderString(source, data)`
 *      instead of going through `FileSystemLoader` (which rejects absolute
 *      paths and cannot reach shared-path error templates outside the bundle
 *      root). Failures fall back to a minimal inline HTML body rather than
 *      recursing via `self.throwError` — recursion would re-enter this same
 *      branch and could loop. The defensive `localOptions.isRenderingCustomError
 *      = false` reset after render mirrors render-swig.js lines 804, 1434.
 *   4. ~~**Early Hints 103** auto-send~~ — **shipped 2026-04-23** (#NJ4).
 *      The #EH1 firing point in `controller.js this.render()` is already
 *      engine-agnostic — it reads `local.options.template.h2Links` and calls
 *      `self.setEarlyHints(_hints)` BEFORE the delegate dispatch, so both
 *      swig and nunjucks bundles reach it identically. The data-feed was
 *      closed by #NJ2: `deps.setResources(localTemplateConf)` is called below
 *      (same function object defined once in `controller.js:782` and passed
 *      to both delegates via `deps`), and `setResources` → `getNodeRes`
 *      writes to `local.options.template.h2Links` at `controller.js:901`
 *      (CSS) / `:930` (JS) on HTTP/2 non-dev requests. No nunjucks-specific
 *      h2Links logic is needed — a negative-invariant test locks that in.
 *   5. ~~**Static HTML cache writes**~~ — **shipped 2026-04-23** (#NJ3).
 *      `writeCache(bundle, opt, htmlContent)` is a direct port of
 *      `render-swig.js:35-129` (same guards, cache-key shape, memory/fs
 *      dispatch, sliding-window support, invalidateOnEvents hook). It runs
 *      after `injectAssets` + `injectInspectorScripts` so the cached bytes
 *      match what the client sees, and BEFORE `sendHtmlResponse` so the
 *      miss-path `Cache-Control: private, max-age=N` header is committed
 *      alongside the response. Reads are engine-agnostic already — the
 *      server-layer read path at `server.isaac.js:1012-1067` keys on
 *      `static:${bundle}:${url}` regardless of which engine populated the
 *      entry, so no read-side port was needed.
 *   6. ~~**Asset cataloguing / `setResources`**~~ — **shipped 2026-04-23** (#NJ2).
 *      `deps.setResources(localTemplateConf)` is now called before `env.render()`
 *      so `data.page.view.stylesheets` and `data.page.view.scripts` are
 *      populated with raw HTML strings (same shape as the swig path — produced
 *      by `controller.js getNodeRes()`). Templates may opt in explicitly with
 *      `{{ page.view.stylesheets | safe }}` / `{{ page.view.scripts | safe }}`.
 *      When the rendered HTML does NOT already contain those strings,
 *      `injectAssets` auto-injects them alongside `localOptions.template.ginaLoader`
 *      and `localOptions.template.externalPlugins`, honouring
 *      `javascriptsDeferEnabled` (scripts in `<head>` vs before `</body>`) and
 *      `javascriptsExcluded === '**'` (suppresses the ginaLoader). `isWithoutLayout`
 *      filters the asset list to common-only (`isCommon: true, name: 'gina'`)
 *      via the `Collection` primitive, mirroring render-swig.js:494-498.
 *   7. ~~**Gina SwigFilters registration**~~ — **shipped**. `lib/nunjucks-filters`
 *      mirrors `lib/swig-filters` (same 7 public filters: `getUrl`, `getWebroot`,
 *      `length`, `nl2br`, `addHours`, `addDays`, `addYears`). Registered
 *      per-request on the cached `nunjucks.Environment` via `env.addFilter()`
 *      in `registerGinaFilters` below — `getConfig` is internal and excluded
 *      from the registration loop, mirroring the swig path.
 *   8. **Layout composition** — nunjucks' native `{% extends %}` / `{% block %}`
 *      / `{% include %}` work automatically through `FileSystemLoader`. No
 *      Gina-specific layout merging beyond that.
 *
 * The dispatch in `controller.js` reaches this file only when the bundle
 * explicitly opts in via `settings.json > render.engine === 'nunjucks'`,
 * and the bundle startup has already validated that nunjucks is installed
 * in the project via `lib.nunjucksResolver.load()` — a hard error is
 * surfaced there rather than here, so this file assumes `nunjucksResolver.get()`
 * always returns a real nunjucks module.
 *
 * @param {object}   userData              - Data merged into the template context
 * @param {boolean}  [displayInspector]    - Reserved for future Inspector support; ignored in MVP
 * @param {object}   [errOptions]          - Override `local.options` when rendering a custom error page
 * @param {object}   deps                  - Inherited refs from SuperController
 * @param {object}   deps.self             - The SuperController instance
 * @param {object}   deps.local            - Per-request closure (`req`, `res`, `next`, `options`)
 * @param {function} deps.getData          - Returns the merged template data object
 * @param {function} deps.hasViews         - Returns `true` when the route has a template configured
 * @param {function} deps.setResources     - Populates `data.page.view.stylesheets`/`.scripts` (#NJ2)
 * @param {function} deps.headersSent      - Returns `true` when response headers are already sent
 * @returns {Promise<void>}
 */

var fs              = require('fs');
var nodePath        = require('path');
var inlineScript      = require('./inline-script');
var inspectorRedact = require('lib/inspector-redact');
// #INS10 follow-up — prod-window HTML egress (no-HTML, render-json-style emit).
var emitInspectorWindowData = require('./inspector-window-emit');
// #RWATCH S3 — stale-release banner injector (server-side inline; gated inert).
var releaseBanner = require('./release-banner');
// Collection — small data-query helper used to filter the asset list when
// rendering without a layout (mirrors render-swig.js:494-498). Fetched via
// the lib registry so the dev-mode hot-reload evictions of `lib/index.js`
// don't poison the reference across requests.
//
// FRAMEWORK PATCH: mirror render-swig.js's `|| require.cache[...]`
// fallback. server.isaac.js refreshCore() overwrites the lib cache entry with the
// exports value (not a Module object), so a plain `require()` here returns
// undefined and crashes the module-level read. Push upstream to gina-io/gina.
var libRef          = require('../../lib') || require.cache[require.resolve('../../lib')];
// #B433 hardening — bind the logger explicitly. Until now this file reached it
// only because lib/routing reassigns the global at require time; an explicit
// binding keeps every log line here on the redacting, container-dispatched
// writer regardless of that side effect.
var console         = libRef.logger;
var Collection      = libRef.Collection;
var merge           = libRef.merge;
// #NJ3 — static HTML cache writes. Module-scoped render-cache dispatcher
// mirrors `render-swig.js` and `render-json.js`. Per-request, the main render
// function re-points it at the server's shared in-memory store (key:
// `static:<bundle>:<url>`). The server-layer read path (server.isaac.js) is
// engine-agnostic, so writes from this delegate are served back on subsequent
// hits without going through the controller at all.
var renderCache     = new (libRef.RenderCache)();

/**
 * Caches a `nunjucks.Environment` per bundle template root so we don't
 * rebuild loaders on every request. Key: absolute path to
 * `localOptions.template.html`. Value: `nunjucks.Environment` instance.
 *
 * Stored on `process.gina._nunjucksEnvs` so it survives dev-mode
 * `refreshCoreDependencies()` evictions of `controller.js` and this
 * delegate file. Cleared automatically when `lib.nunjucksResolver.reset()`
 * runs (the Environment holds a reference to the cached nunjucks module).
 *
 * @inner
 * @param {*}      nunjucks   - The loaded nunjucks module
 * @param {string} templateRoot - Absolute path to the bundle's templates/html dir
 * @param {object} [options]   - Pass-through to `new nunjucks.Environment(loader, options)`
 * @returns {*} A cached or newly created `nunjucks.Environment` instance
 */
function getEnvironment(nunjucks, templateRoot, options) {
    if (!process.gina._nunjucksEnvs) {
        process.gina._nunjucksEnvs = Object.create(null);
    }
    // Invalidate when the cached nunjucks module was hot-swapped — the
    // Environment instance is bound to the module that created it, so if
    // the module changed we must rebuild.
    if (process.gina._nunjucksEnvsOwner !== nunjucks) {
        process.gina._nunjucksEnvs = Object.create(null);
        process.gina._nunjucksEnvsOwner = nunjucks;
    }
    var key = templateRoot;
    if (!process.gina._nunjucksEnvs[key]) {
        var loader = new nunjucks.FileSystemLoader(templateRoot, {
            // Dev-mode: disable nunjucks's own template cache so template
            // edits take effect without a bundle restart. Production bundles
            // keep the cache on for performance.
            noCache: process.env.NODE_ENV_IS_DEV === 'true',
            watch:   false
        });
        process.gina._nunjucksEnvs[key] = new nunjucks.Environment(loader, {
            autoescape:  (options && typeof(options.autoescape) === 'boolean') ? options.autoescape : true,
            throwOnUndefined: false,
            trimBlocks:  false,
            lstripBlocks: false
        });
    }
    return process.gina._nunjucksEnvs[key];
}

/**
 * Resolves the template file path relative to the bundle's templates root.
 * Mirrors the non-CVE, non-namespace path of render-swig.js (see
 * render-swig.js:269-335 for the full swig version). Returns a path
 * **relative to the template root** so nunjucks's FileSystemLoader can
 * find it; absolute paths are rejected by the loader.
 *
 * @inner
 * @param {object} data         - Template data (has `data.page.view.file`, `.ext`)
 * @param {object} localOptions - The controller's localOptions (has `.template.html`, `.namespace`)
 * @returns {string} relative template path
 */
function resolveTemplatePath(data, localOptions) {
    // Honour controller-set override from self.setTemplate(file, ext).
    // When set, the override fully replaces the rule's default path —
    // no namespace prefixing — so a catch-all dispatcher can drop the
    // controller anywhere under the templates root.
    if (localOptions && localOptions._templateOverride && localOptions._templateOverride.file) {
        var ovFile = localOptions._templateOverride.file;
        var ovExt  = localOptions._templateOverride.ext || data.page.view.ext || '';
        if (ovExt && !ovFile.endsWith(ovExt)) ovFile += ovExt;
        return ovFile;
    }

    var file = data.page.view.file;
    var ext  = data.page.view.ext || '';

    // Bundle's template root — loader is rooted here, so relative paths are
    // all the caller needs to give us.
    // var root = localOptions.template.html;  // kept for debugging reference

    // Namespace sub-dir handling (same as render-swig.js:271-290, minus the
    // CVE guard which is swig-specific legacy).
    if (localOptions.namespace) {
        var effective = file || localOptions.namespace;
        if (effective === localOptions.namespace) {
            effective = 'index';
        }
        // Drop the redundant `<namespace>-` prefix from the file segment
        // when present, so `project/project-get.njk` resolves to
        // `project/get.njk` (and `client/client-list.njk` to
        // `client/list.njk`). Lets route names that already carry the
        // namespace (e.g. `project-get`, `client-list`) live at the cleaner
        // `<namespace>/<action>.njk` path. Upstreamed in 0.3.9.
        var nsPrefix = localOptions.namespace + '-';
        if (effective.length > nsPrefix.length && effective.indexOf(nsPrefix) === 0) {
            effective = effective.substring(nsPrefix.length);
        }
        var rel = localOptions.namespace + '/' + effective;
        if (ext && !rel.endsWith(ext)) { rel += ext; }
        return rel;
    }

    // No namespace — plain file at template root.
    var rel = file;
    if (ext && !rel.endsWith(ext)) { rel += ext; }
    return rel;
}

/**
 * Builds the Inspector dev-payload scripts + the dev statusbar and injects
 * them into the rendered HTML just before `</body>`. Mirrors render-swig.js
 * (#TPL2 inlines the statusbar.html body into the layout pre-compile; here
 * the engine pass has already happened, so the statusbar body — a leaf with
 * only `{% if %}` / `{{ }}` tags, valid nunjucks — is rendered through the
 * resolver module's `renderString()` and spliced as plain HTML).
 *
 * Runs only in dev mode (`self.isCacheless()`), gated by `displayInspector`:
 *
 *   - `displayInspector === true`    → always inject (explicit opt-in)
 *   - `displayInspector === undefined` → inject when cacheless (dev-mode default)
 *   - `displayInspector === false`   → never inject
 *
 * Side effects beyond the HTML mutation:
 *   1. Stashes redacted `__gdPayload` on `self.serverInstance._lastGinaData` —
 *      consumed by the engine.io push and `/_gina/agent` SSE stream.
 *   2. Stashes unredacted snapshot on `serverInstance._lastGinaDataUnredacted`
 *      ONLY when `NODE_SCOPE === 'local'`. Other scopes clear it to null so
 *      `/_gina/reveal` never has anything to leak.
 *   3. Emits `process.emit('inspector#data', __gdPayload)` so attached
 *      listeners (dev-mode sockets) pick up the snapshot.
 *
 * @inner
 * @param  {string}  html              - Rendered HTML from the nunjucks engine
 * @param  {object}  data              - Template data (has `data.page.*`)
 * @param  {object}  self              - SuperController instance (has serverInstance, isCacheless)
 * @param  {object}  local             - Per-request closure
 * @param  {boolean} [displayInspector]
 * @returns {string} HTML with scripts injected, or the original string when gated off
 */
function injectInspectorScripts(html, data, self, local, displayInspector) {
    if (displayInspector === false) { return html; }
    if (displayInspector !== true && !self.isCacheless()) { return html; }
    if (!data || !data.page) { return html; }
    // No `</body>` anchor → nothing safe to inject into. Don't force it.
    if (!/<\/body>/i.test(html)) { return html; }

    // #HDR5 — per-request CSP nonce attribute for the Inspector inline <script>s.
    // Read the stable `local._cspNonce` (stamped from the captured req in the main
    // render scope), NOT volatile `local.req` — per the #M1 discipline local.req is
    // the only slot that gets nulled, and this helper already reads per-request
    // state off `local` (local._timeline / local._queryLog) the same way.
    var _cspNonce     = (local && local._cspNonce) ? local._cspNonce : null;
    var _cspNonceAttr = _cspNonce ? (' nonce="' + _cspNonce + '"') : '';

    // #FI — inject the dev-mode request timeline for the Inspector Flow tab,
    // and convert QI entries into timeline entries so the waterfall shows N1QL
    // queries alongside the routing/controller/template phases. Mirrors
    // render-swig.js:1056-1076. Without this `__ginaData.user.flow` never
    // exists for nunjucks pages, so the Flow tab stays empty (and the late
    // `_njFlowPatch` would no-op against a missing `u.flow`).
    if (local._timeline && local._timeline.entries.length > 0) {
        if (local._queryLog) {
            for (var _njTi = 0; _njTi < local._queryLog.length; _njTi++) {
                var _njQe = local._queryLog[_njTi];
                if (_njQe._startMs) {
                    local._timeline.entries.push({
                        label: 'n1ql:' + (_njQe.trigger || 'query'),
                        cat: 'db',
                        startMs: _njQe._startMs,
                        endMs: _njQe._startMs + (_njQe.durationMs || 0),
                        durationMs: _njQe.durationMs || 0,
                        detail: (_njQe.statement || '').substring(0, 80)
                    });
                }
            }
        }
        data.page.flow = {
            requestStart: local._timeline.requestStart,
            entries: local._timeline.entries
        };
    }

    // #M11 — Inspector Queries tab parity with render-swig: expose the raw
    // QI query log alongside the flow-timeline fold-in above, so
    // `__ginaData.user.queries` exists for nunjucks pages too.
    if (local._queryLog && local._queryLog.length > 0) {
        data.page.queries = local._queryLog;
    }
    // #AISTREAM — AI token-stream snapshot parity (rides the data.page clone).
    if (local._aiLog && local._aiLog.length > 0) {
        data.page.aiStream = local._aiLog;
    }
    // #EVTBUS — observable application-event snapshot parity; the live view rides inspector#event.
    if (local._eventLog && local._eventLog.length > 0) {
        data.page.events = local._eventLog;
    }

    // Two deep clones — one labelled gina (metadata for the Inspector
    // sidebar), one labelled user (mirrors what application code sees).
    // JSON.parse(JSON.stringify(...)) is intentional: it drops functions,
    // prototype chains, and circular refs — exactly what we want before
    // handing the payload to a client-side script tag.
    var __gdGina = JSON.parse(JSON.stringify(data.page));
    var __gdUser = JSON.parse(JSON.stringify(data.page));
    if (__gdGina.view) {
        __gdGina.view.assets      = {};
        __gdGina.view.scripts     = 'ignored-by-toolbar';
        __gdGina.view.stylesheets = 'ignored-by-toolbar';
    }
    if (__gdUser.view) {
        __gdUser.view.scripts     = 'ignored-by-toolbar';
        __gdUser.view.stylesheets = 'ignored-by-toolbar';
        __gdUser.view.assets      = {};
    }

    // Redact config — identical source lookup to render-swig.js:1056
    // so the two engines produce the same Inspector payload shape.
    var _redactConf = inspectorRedact.getConfig(local.options.conf);
    __gdGina.inspectorRedact = {
        patterns:    _redactConf.patterns,
        types:       _redactConf.types,
        replacement: _redactConf.replacement
    };
    if (__gdGina.environment) {
        __gdGina.environment.scope = process.env.NODE_SCOPE || null;
    }

    // Template engine identity for the Inspector View badge.
    try {
        var _njDec = process.gina && process.gina._nunjucksDecision;
        var _njVer = (_njDec && _njDec.version) || null;
        if (!_njVer) {
            try { _njVer = require('nunjucks/package.json').version; }
            catch (e) { _njVer = null; }
        }
        if (__gdGina.environment) {
            __gdGina.environment.templateEngine = { name: 'nunjucks', version: _njVer };
        }
        if (__gdUser.environment) {
            __gdUser.environment.templateEngine = { name: 'nunjucks', version: _njVer };
        }
    } catch (e) { /* defensive */ }

    // Inspector View tab Weight/Load fallback (emit-time values). `weightBytes`
    // is null at emit (body bytes unknown until post-render); `serverMs` is the
    // best-available server processing duration from the timeline walk above.
    // A late-bind patch script in the main render function (post-writeCache,
    // pre-sendHtmlResponse) upgrades both to byte-final values on fresh
    // renders; `server.isaac.js` cache-hits serve these emit-time values as a
    // fallback (mirroring render-swig.js parity).
    var _njServerMs = null;
    try {
        if (local._timeline && local._timeline.entries.length > 0) {
            var _njLatest = local._timeline.requestStart;
            for (var _njMi = 0, _njMlen = local._timeline.entries.length; _njMi < _njMlen; _njMi++) {
                var _njEnt = local._timeline.entries[_njMi];
                if (typeof _njEnt.endMs === 'number' && _njEnt.endMs > _njLatest) {
                    _njLatest = _njEnt.endMs;
                }
            }
            if (_njLatest > local._timeline.requestStart) {
                _njServerMs = _njLatest - local._timeline.requestStart;
            }
        }
    } catch (e) { _njServerMs = null; }
    if (__gdGina.environment) {
        __gdGina.environment.metrics = { weightBytes: null, serverMs: _njServerMs };
    }
    if (__gdUser.environment) {
        __gdUser.environment.metrics = { weightBytes: null, serverMs: _njServerMs };
    }

    // #INS8 — standalone Inspector URL (settings.json > inspector.url)
    var _inspUrlConf = null;
    try {
        var _confSource = local.options.conf || {};
        if (_confSource.content && _confSource.content.settings
            && _confSource.content.settings.inspector
            && _confSource.content.settings.inspector.url) {
            _inspUrlConf = _confSource.content.settings.inspector.url;
        }
    } catch (e) { /* leave null */ }
    __gdGina.inspectorUrl = _inspUrlConf;
    // #CC6 — mirror the events capture gate to the browser: the statusbar's
    // component-event capture honours the same knob
    // (settings > inspector.events.captureArgs); metadata always, detail
    // values only when opted in.
    __gdGina.inspectorEventsCaptureArgs = !!(process.gina && process.gina._inspectorEventsCaptureArgs);

    var __gdPayload = { gina: __gdGina, user: __gdUser };
    // Snapshot BEFORE redaction, gated on local scope only.
    var __gdPayloadUnredacted = (process.env.NODE_SCOPE === 'local')
        ? JSON.parse(JSON.stringify(__gdPayload)) : null;
    __gdPayload = inspectorRedact.redact(__gdPayload, {
        compiledPatterns: _redactConf.compiledPatterns,
        replacement:      _redactConf.replacement
    });

    // `</script>` and `<!--` must be escaped inside JSON-serialised script
    // content so the browser's HTML parser doesn't terminate the tag early
    // or start an HTML comment. Matches render-swig.js:1096-1097.
    // #B451 - see controller.render-swig.js: the blocklist this replaces was
    // bypassable by a trailing space or slash after the script tag name.
    var _safeJson = inlineScript.safeInlineJson(__gdPayload);

    var __gdScript   = '<script' + _cspNonceAttr + '>window.__ginaData = ' + _safeJson + ';</script>\n';
    var _bundleName  = (__gdUser.environment && __gdUser.environment.bundle) || '';
    var __logsScript = '<script' + _cspNonceAttr + '>'
        + 'window.__ginaLogs = window.__ginaLogs || [];'
        + '(function(w){'
        + 'var _c=w.console,_l=w.__ginaLogs,_b=' + inlineScript.safeInlineString(_bundleName) + ';'
        + '["log","info","warn","error","debug"].forEach(function(lvl){'
        + 'var orig=_c[lvl].bind(_c);'
        + '_c[lvl]=function(){'
        + 'orig.apply(_c,arguments);'
        + 'try{_l.push({t:Date.now(),l:lvl,b:_b,s:Array.prototype.slice.call(arguments).join(" ")});}catch(e){}'
        + '};});'
        + '}(window));</script>\n';

    // Stash on serverInstance + emit event. Swig path does both; the
    // Inspector-observer side depends on these specific side effects.
    if (self.serverInstance) {
        self.serverInstance._lastGinaData = __gdPayload;
        self.serverInstance._lastGinaDataUnredacted = __gdPayloadUnredacted; // null outside local scope
    }
    try {
        process.emit('inspector#data', __gdPayload);
    } catch (e) { /* listener raised — not fatal to the render */ }

    // #M11 — dev statusbar parity with render-swig. statusbar.html is a leaf
    // template (only {% if page.cspNonce %} + {{ }} tags — valid nunjucks),
    // but this helper runs AFTER the engine pass, so the body is rendered
    // through the resolver module's renderString() and spliced as plain
    // HTML. Read per-render so dev edits hot-reload; this path is
    // dev/inspector-gated above, so there is no production read.
    var _statusbarHtml = '';
    try {
        var _statusbarTpl = fs.readFileSync(
            getPath('gina').core + '/asset/plugin/dist/vendor/gina/html/statusbar.html', 'utf8'
        );
        _statusbarHtml = require('../../lib/nunjucks-resolver').get().renderString(_statusbarTpl, data);
    } catch (_sbErr) {
        console.warn('[render] Inspector statusbar unavailable: ' + (_sbErr.message || _sbErr));
    }

    // Inject before the first `</body>`. Case-insensitive match; the
    // surrounding newline + tab match render-swig's formatting so the
    // diff against a rendered swig-then-nunjucks page is cosmetic-only.
    // $-safe splice (function replacer): with a STRING replacement,
    // String.prototype.replace expands dollar patterns — the statusbar body
    // literally contains two of them, and the JSON payloads can carry them
    // in user data. The function form returns the text verbatim; mirrors
    // render-swig.js's #TPL2 splice fix.
    var _injected = '\t' + __logsScript + __gdScript + _statusbarHtml + '\n\t</body>';
    return html.replace(/<\/body>/i, function () { return _injected; });
}

/**
 * Send the rendered HTML back through the appropriate response path.
 * Implements the four-way branch described in
 * `the internal architecture docs §7b` — same shape as
 * `render-swig.js:877-927`:
 *
 *   1. HEAD + HTTP/2 stream  → `stream.respond({content-type, content-length, :status})` + `stream.end()`
 *   2. HEAD + HTTP/1.1       → `res.setHeader(content-type/content-length)` + `res.end()` (no body)
 *   3. body + HTTP/2 stream  → `stream.respond({content-type, :status})` + `stream.end(html)`
 *   4. body + HTTP/1.1       → `res.end(html)` (content-type set earlier)
 *
 * The HTTP/2 branches merge headers set earlier in the pipeline (CORS,
 * cache-control, cookies) via `res.getHeaders()` because
 * `stream.respond()` on the raw HTTP/2 stream does NOT include headers
 * set via `response.setHeader()`. The `stream.destroyed || stream.closed`
 * guard is required — the client may have disconnected before the async
 * render callback completed, in which case `stream.respond()` throws
 * `ERR_HTTP2_INVALID_STREAM`.
 *
 * `res.headersSent = true` is set after a successful `stream.respond()`
 * to signal to the HTTP/1.1 compat layer that the response was sent
 * directly, matching render-swig's §7b pattern.
 *
 * @inner
 * @param {object} local  - Per-request closure
 * @param {string} html   - Rendered HTML content
 */
function sendHtmlResponse(local, html, req, res) {
    if (res.headersSent) { return; }

    var statusCode = res.statusCode || 200;
    var stream     = (res && typeof res.stream !== 'undefined') ? res.stream : null;
    var isHead     = /^HEAD$/i.test(req.method);
    // #H10 — opt-in HTTP/2 response trailers (registered via self.sendTrailers()).
    var _trailers  = (local && local._trailers && typeof(local._trailers) === 'object') ? local._trailers : null;
    var byteLength = Buffer.byteLength(html, 'utf8');
    // Ensure content-type is set on the HTTP/1.1 response so header merge
    // picks it up for the stream paths and setHeader()-only paths alike.
    if (!res.getHeader('content-type')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
    }

    if (isHead) {
        if (stream) {
            // Case 1: HEAD + HTTP/2
            if (stream.destroyed || stream.closed) {
                try { console.warn('[render-nunjucks] stream already destroyed on HEAD — client disconnected ('+ req.url +')'); } catch (e) {}
                return;
            }
            if (!stream.headersSent) {
                var _headH2 = {
                    'content-type':   res.getHeader('content-type'),
                    'content-length': byteLength,
                    ':status':        statusCode
                };
                var _pendingHeadH2 = res.getHeaders ? res.getHeaders() : {};
                for (var _hh2k in _pendingHeadH2) {
                    if (!(_hh2k in _headH2)) { _headH2[_hh2k] = _pendingHeadH2[_hh2k]; }
                }
                stream.respond(_headH2);
            }
            stream.end();
            res.headersSent = true;
        } else {
            // Case 2: HEAD + HTTP/1.1
            res.setHeader('content-length', byteLength);
            res.writeHead(statusCode);
            res.end();
        }
        return;
    }

    if (stream) {
        // Case 3: body + HTTP/2
        if (stream.destroyed || stream.closed) {
            try { console.warn('[render-nunjucks] stream already destroyed — client disconnected before response ('+ req.url +')'); } catch (e) {}
            return;
        }
        if (!stream.headersSent) {
            var _streamHeaders = {
                'content-type': res.getHeader('content-type'),
                ':status':      statusCode
            };
            // Merge pipeline-set headers (CORS, cache-control, etc.) —
            // `stream.respond()` does not include them automatically.
            var _pendingHeaders = res.getHeaders ? res.getHeaders() : {};
            for (var _shk in _pendingHeaders) {
                if (!(_shk in _streamHeaders)) { _streamHeaders[_shk] = _pendingHeaders[_shk]; }
            }
            // #H10 — register the trailer flush, then defer the stream close via
            // waitForTrailers so the trailers follow the final DATA frame.
            if (_trailers) {
                stream.once('wantTrailers', function() {
                    try { if (!stream.destroyed && !stream.closed) stream.sendTrailers(_trailers); } catch (_e) { /* best-effort */ }
                });
            }
            stream.respond(_streamHeaders, _trailers ? { waitForTrailers: true } : undefined);
        }
        stream.end(html);
        res.headersSent = true;
        return;
    }

    // Case 4: body + HTTP/1.1
    res.writeHead(statusCode);
    res.end(html);
}

/**
 * Register Gina's filter registry on the cached `nunjucks.Environment`
 * for the current request. Mirror of the swig-side registration loop in
 * `controller.render-swig.js:629-647`.
 *
 * Per-request mutation of the cached env is safe because `env.render()`
 * is synchronous and Node's event loop serialises requests — two
 * concurrent requests can't interleave between `addFilter` and `render`.
 * The factory captures the per-request context (`req`, `options`,
 * `isProxyHost`) on `NunjucksFilters.instance._options`; filter functions
 * read from that singleton during the render pass that immediately
 * follows. `getConfig` is excluded from the loop to match the swig path.
 *
 * @inner
 * @param {*}      env          - The cached `nunjucks.Environment` for this template root
 * @param {object} self         - SuperController instance (for `self.throwError`)
 * @param {object} local        - Per-request closure (`req`, `res`, `next`, `options`)
 * @param {object} localOptions - The controller's localOptions (already has `conf`)
 * @returns {void}
 */
function registerGinaFilters(env, self, local, localOptions, req, res) {
    // FRAMEWORK PATCH: use module-scope libRef fallback so
    // refreshCore's malformed cache entry doesn't return undefined here.
    var nunjucksFilters = (libRef && libRef.nunjucksFilters)
        || require('../../lib/nunjucks-filters');

    // Same isProxyHost detection as render-swig.js:606-625. Duplicated here
    // verbatim rather than abstracted because (a) the conditions read raw
    // request headers and engine-specific localOptions, (b) extracting to a
    // shared helper would widen the scope of this filter-port change beyond
    // what's necessary. Future refactor candidate.
    var localRequestPort = req.headers.port || req.headers[':port'];
    var isProxyHost = (
        typeof(req.headers.host) != 'undefined'
        && typeof(localRequestPort) != 'undefined'
        && (localRequestPort === '80' || localRequestPort === '443' || localRequestPort === 80 || localRequestPort === 443)
        && localOptions.conf.server.scheme +'://'+ req.headers.host+':'+ localRequestPort != localOptions.conf.hostname.replace(/\:\d+$/, '') +':'+ localOptions.conf.server.port
        ||
        typeof(req.headers[':authority']) != 'undefined'
        && localOptions.conf.server.scheme +'://'+ req.headers[':authority'] != localOptions.conf.hostname
        ||
        typeof(req.headers.host) != 'undefined'
        && typeof(localRequestPort) != 'undefined'
        && (localRequestPort === '80' || localRequestPort === '443' || localRequestPort === 80 || localRequestPort === 443)
        && req.headers.host == localOptions.conf.host
        ||
        typeof(req.headers['x-nginx-proxy']) != 'undefined'
        && String(req.headers['x-nginx-proxy']).toLowerCase() === 'true'
        ||
        typeof(process.gina) != 'undefined' && typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
    ) ? true : false;

    // #P39 — `options` passed by REFERENCE, mirroring render-swig: the filter
    // singleton only READS the stash, and the former per-render deep copy of
    // the whole `local.options` (routing tables + templates + settings + forms
    // + locales) was one of the heaviest CPU sites in the render profile.
    var filters = nunjucksFilters({
        options:     localOptions,
        isProxyHost: isProxyHost,
        throwError:  self.throwError,
        req:         req,
        res:         res
    });

    // FRAMEWORK PATCH: apply bundle-level filter wraps registered
    // on process state. Bundle-level monkey-patches on `lib.nunjucksFilters`
    // don't survive refreshCore() (which creates a fresh lib singleton ~per-
    // request in dev mode), so bundles register their wrap on
    // `process.gina._bundleFilterWraps[bundleName]` and the framework applies
    // them here. Push upstream to gina-io/gina alongside Bugs A-D.
    var bundleFilterWraps = (process.gina && process.gina._bundleFilterWraps) || {};
    Object.keys(bundleFilterWraps).forEach(function (bundleName) {
        var wrap = bundleFilterWraps[bundleName];
        if (typeof wrap === 'function') {
            try {
                filters = wrap(filters) || filters;
            } catch (wrapErr) {
                try {
                    console.warn('[render-nunjucks] bundle filter wrap failed for ' + bundleName + ': ' + (wrapErr.message || wrapErr));
                } catch (e) {}
            }
        }
    });

    for (var name in filters) {
        if (typeof filters[name] === 'function' && name !== 'getConfig') {
            env.addFilter(name, filters[name]);
        }
    }
}

/**
 * Invoke the bundle's `controllers/setup.js` (if any) with `this.engine`
 * bound to the cached `nunjucks.Environment`, so user code can call
 * `engine.addFilter(name, fn)` to extend filters on the nunjucks side
 * the same way it already can on swig (where `self.engine = swig` is
 * set by `controller.js` before setup runs).
 *
 * Without this hook, every nunjucks bundle that uses the documented
 * setup.js pattern (`var engine = this.engine; engine.addFilter(...)`)
 * silently no-ops because `this.engine` arrives as the controller's
 * default `{}` — the nunjucks engine is created lazily here in the
 * render delegate, after the controller's onReady->setup chain has
 * already fired.
 *
 * Run once per `nunjucks.Environment` instance: marker `_userSetupDone`
 * is stamped on the env itself so re-renders are no-ops, and a fresh
 * env (e.g. after `nunjucksResolver.reset()`) re-runs setup.
 *
 * @inner
 * @param {*}        env          - cached `nunjucks.Environment`
 * @param {object}   self         - SuperController instance (provides throwError)
 * @param {object}   local        - per-request closure (`req`, `res`, `next`)
 * @param {object}   localOptions - controller's localOptions (has `bundle`, `conf.bundlesPath`)
 * @param {object}   req          - function-scoped capture of `local.req` (#M1 async-race guard)
 * @param {object}   res          - function-scoped capture of `local.res`
 * @param {Function} _next        - function-scoped capture of `local.next`
 * @returns {void}
 */
function registerUserFilters(env, self, local, localOptions, req, res, _next) {
    if (env._userSetupDone) return;
    if (!localOptions || !localOptions.bundle || !localOptions.conf || !localOptions.conf.bundlesPath) return;

    var setupFile = localOptions.conf.bundlesPath + '/' + localOptions.bundle + '/controllers/setup.js';
    if (!fs.existsSync(setupFile)) {
        env._userSetupDone = true; // no setup.js — nothing to do, don't recheck
        return;
    }

    var Setup;
    try {
        Setup = require(setupFile);
    } catch (loadErr) {
        try { console.warn('[render-nunjucks] failed to load user setup.js (' + setupFile + '): ' + (loadErr.message || loadErr)); } catch (e) {}
        env._userSetupDone = true;
        return;
    }

    if (typeof Setup !== 'function') {
        env._userSetupDone = true;
        return;
    }

    Setup.engine     = env;
    Setup.throwError = self.throwError;

    try {
        Setup.apply(Setup, [req, res, _next]);
    } catch (setupErr) {
        try { console.warn('[render-nunjucks] user setup.js threw: ' + (setupErr.message || setupErr)); } catch (e) {}
    }

    env._userSetupDone = true;
}

/**
 * Post-render asset injection — the nunjucks counterpart to the pre-compile
 * layout mutation in `render-swig.js:963-1195`. Idempotent and safe to call
 * on arbitrary HTML: every insertion is guarded against double-injection
 * by substring-testing the rendered output.
 *
 * Ports three concerns from the swig path:
 *
 *   1. **Stylesheets** — `data.page.view.stylesheets` (raw `<link>` tags
 *      produced by `controller.js getNodeRes('css', ...)`) are injected
 *      before the first `</head>` unless the user already placed
 *      `{{ page.view.stylesheets | safe }}` in their template. User-placement
 *      is detected by substring match on the final HTML: if the rendered
 *      text already contains the exact `stylesheets` string, we skip the
 *      auto-injection. The strings contain bundle-specific URLs, so
 *      false-positives are essentially zero.
 *   2. **Scripts** — `data.page.view.scripts` are placed before `</head>`
 *      when `localOptions.template.javascriptsDeferEnabled` is true,
 *      otherwise before `</body>`. The swig path has two more positional
 *      branches (`isLoadingPartial`, non-HTML iframe body) that aren't
 *      relevant to the nunjucks render pipeline as it stands today.
 *   3. **ginaLoader + externalPlugins** — the always-in-head loader script
 *      (`window.onGinaLoaded`) is injected before `</head>` unless the
 *      bundle opts out via `javascriptsExcluded === '**'` or the HTML
 *      already contains `window.onGinaLoaded`. External plugins
 *      (typically jQuery, loaded before Gina) are injected on the same
 *      `</head>` anchor, preserving their configured load order.
 *
 * The function returns the mutated HTML. It does NOT attempt injection on
 * fragments missing the `</head>` or `</body>` anchors — HEAD responses,
 * partial renders, and hand-written bodyless templates pass through
 * unchanged rather than growing truncated markup.
 *
 * @inner
 * @param {string}  html             - Rendered HTML from `env.render()` / `env.renderString()`
 * @param {object}  data             - Template data (has `data.page.view.stylesheets`/`.scripts`)
 * @param {object}  localOptions     - Controller's localOptions (has `template.ginaLoader`, `.externalPlugins`, etc.)
 * @param {string} [cspNonce]        - #HDR5 per-request CSP nonce; when set, the onGinaLoaded bootstrap <script> carries a matching nonce="..." attribute.
 * @returns {string} HTML with asset tags injected where appropriate
 */
function injectAssets(html, data, localOptions, cspNonce) {
    if (typeof html !== 'string' || html.length === 0) { return html; }
    if (!data || !data.page || !data.page.view) { return html; }

    var stylesheetsHtml = data.page.view.stylesheets || '';
    var scriptsHtml     = data.page.view.scripts     || '';
    var tpl             = localOptions && localOptions.template;
    var isDeferMode     = !!(tpl && tpl.javascriptsDeferEnabled);
    var jsExcluded      = tpl && tpl.javascriptsExcluded;
    var ginaLoader      = tpl && tpl.ginaLoader;
    // #HDR5 — stamp the bootstrap <script> with the per-request nonce when present.
    // The loader is a cached, immutable string; .replace() returns a fresh copy.
    if (cspNonce && typeof ginaLoader === 'string') {
        ginaLoader = ginaLoader.replace(
            '<script type="text/javascript">',
            '<script type="text/javascript" nonce="' + cspNonce + '">'
        );
    }
    var externalPlugins = (tpl && Array.isArray(tpl.externalPlugins)) ? tpl.externalPlugins : [];
    var hasHead         = /<\/head>/i.test(html);
    var hasBody         = /<\/body>/i.test(html);

    if (stylesheetsHtml && hasHead && html.indexOf(stylesheetsHtml) === -1) {
        html = html.replace(/<\/head>/i, '\n\t' + stylesheetsHtml + '\n</head>');
    }

    if (scriptsHtml && html.indexOf(scriptsHtml) === -1) {
        if (isDeferMode && hasHead) {
            html = html.replace(/<\/head>/i, '\t' + scriptsHtml + '\n</head>');
        } else if (hasBody) {
            html = html.replace(/<\/body>/i, '\t' + scriptsHtml + '\n</body>');
        }
    }

    if (externalPlugins.length > 0 && hasHead) {
        var extHtml = externalPlugins.join('');
        if (extHtml && html.indexOf(extHtml) === -1) {
            html = html.replace(/<\/head>/i, '\t' + extHtml + '\n</head>');
        }
    }

    if (
        ginaLoader
        && jsExcluded !== '**'
        && hasHead
        && !/window\.onGinaLoaded/.test(html)
    ) {
        html = html.replace(/<\/head>/i, '\t' + ginaLoader + '\n</head>');
    }

    return html;
}

/**
 * #NJ3 — write the rendered HTML to the static-HTML cache store (memory or
 * file system). No-op when caching is disabled server-side or the route has
 * no `cache` setting. Direct port of `render-swig.js:35-129` — same guards,
 * cache-key shape, memory/fs dispatch, sliding-window support, and
 * `invalidateOnEvents` hook.
 *
 * The cache-key namespace (`static:<bundle>:<url>`) matches the prefix the
 * server-layer read path scans in `server.isaac.js:1012-1067`, so writes
 * from this function are served back on subsequent hits without reaching
 * the controller at all.
 *
 * @inner
 * @param {object} local       - Per-request closure (`req`, `res`) — captured explicitly because writeCache is declared at module scope
 * @param {object} self        - SuperController instance (for `self.serverInstance._cacheIsEnabled` / `self.throwError`)
 * @param {string} bundle      - Bundle name (used as cache-key namespace)
 * @param {object} opt         - Server cache configuration (`opt.path`, `opt.ttl`, `opt.sliding`, `opt.maxAge`)
 * @param {string} htmlContent - Final HTML string to cache (post injectAssets + injectInspectorScripts)
 * @returns {Promise<void>}
 */
async function writeCache(local, self, bundle, opt, htmlContent, req, res) {
    if (
        typeof(req.routing.cache) == 'undefined'
        ||
        ! req.routing.cache
        ||
        String(self.serverInstance._cacheIsEnabled).toLowerCase() !== 'true'
        ||
        // #B158 — a gated route is never stored: the key carries no principal and
        // both serve points run before the gate. Full rationale on isRouteGated.
        libRef.authzGate.isRouteGated(req)
        ||
        // #SPA1 — a NEGOTIABLE route is never stored: the key carries no SHAPE
        // dimension, so a stored entry could replay a fragment to a page request.
        // This WRITE-side refusal is load-bearing, not defence-in-depth — isaac's
        // cache read runs PRE-ROUTING (server.isaac.js ~:2150, off raw request.url
        // with no request.routing in scope), so it cannot be guarded on the flag.
        // Keeping the URL out of the cache entirely is what protects that path.
        ( req.routing && req.routing.negotiate === true )
    ) {
        return;
    }
    // Fully-namespaced key via the single builder (#C3 bundle namespace +
    // the release namespace both live in renderCache.buildKey — writer/reader
    // share ONE format so they can't drift).
    var cacheKey = renderCache.buildKey('static', bundle, req.originalUrl);
    var responseHeaders = res.getHeaders() || {};
    if ( !renderCache.has(cacheKey) ) {
        // Caching kinds are: `memory` & `fs`
        var cachingOption = ( typeof(req.routing.cache) == 'string' ) ? { type: req.routing.cache } : JSON.clone(req.routing.cache);
        if ( typeof(cachingOption.ttl) == 'undefined' ) {
            cachingOption.ttl = opt.ttl
        }
        // Inherit the bundle-wide default strategy (server.cache.type) when the
        // route omits `type` — mirrors the ttl fallback above. Stays undefined
        // (→ not cached, unchanged) when neither the route nor server.cache sets it.
        if ( typeof(cachingOption.type) == 'undefined' ) {
            cachingOption.type = opt.type;
        }
        // Inherit bundle-wide sliding / maxAge defaults from server.cache when
        // the route omits them (mirrors the ttl fallback above). Per-route values
        // always win — an explicit `sliding: false` overrides a bundle-wide `true`.
        if ( typeof(cachingOption.sliding) == 'undefined' && typeof(opt.sliding) != 'undefined' ) {
            cachingOption.sliding = opt.sliding;
        }
        if ( typeof(cachingOption.maxAge) == 'undefined' && typeof(opt.maxAge) != 'undefined' ) {
            cachingOption.maxAge = opt.maxAge;
        }
        var cacheObject = {
            responseHeaders : responseHeaders
        };
        // Store visibility for Cache-Control header on the hit path.
        // Default is 'private' — opt in to 'public' explicitly for truly static pages.
        cacheObject.visibility = ( cachingOption.visibility === 'public' ) ? 'public' : 'private';
        if ( cachingOption.ttl > 0) {
            cacheObject.ttl = cachingOption.ttl;
        }
        // Sliding window (opt-in, default false).
        // When true, ttl becomes the idle eviction threshold (seconds since last access)
        // rather than an absolute duration from creation.
        if ( cachingOption.sliding === true ) {
            cacheObject.sliding = true;
        }
        // Absolute expiration ceiling — only meaningful when sliding is enabled.
        // The entry is evicted at createdAt + maxAge regardless of access patterns.
        if ( cacheObject.sliding && typeof(cachingOption.maxAge) != 'undefined' && cachingOption.maxAge > 0 ) {
            cacheObject.maxAge = cachingOption.maxAge;
        }
        // Store via the render-cache strategy dispatcher (memory | fs). The
        // memory/fs storage detail lives in lib/render-cache so all three
        // render delegates + the server read path share one backend seam.
        await renderCache.set(cachingOption.type, cacheKey, cacheObject, {
            content : htmlContent,
            path    : opt.path,
            bundle  : bundle,
            url     : req.originalUrl,
            kind    : 'html'
        });

        // Invalidation
        if ( typeof(cachingOption.invalidateOnEvents) != 'undefined' ) {
            if ( !Array.isArray(cachingOption.invalidateOnEvents) ) {
                return self.throwError(res, 500, new Error('cache.invalidateOn must be an array'));
            }
            // Placing event listeners. Awaited: setEvents also persists the events into
            // the `fs` sidecar, so a restart's disk read-back can restore them.
            await renderCache.setEvents(cacheKey, cachingOption.invalidateOnEvents);
        }
    }
}

module.exports = async function renderNunjucks(userData, displayInspector, errOptions, deps) {
    var self  = deps.self;
    var local = deps.local;
    var getData      = deps.getData;
    var hasViews     = deps.hasViews;
    var headersSent  = deps.headersSent;
    // #NJ2 — setResources is supplied by controller.js (same ref passed to
    // render-swig.js). It populates `data.page.view.stylesheets` and
    // `data.page.view.scripts` with raw HTML strings by walking the bundle's
    // `localOptions.template.{stylesheets,javascripts}` arrays.
    var setResources = deps.setResources;

    // Function-scoped captures of per-request refs (#M1 race fix — mirror of
    // controller.render-swig.js). renderNunjucks() is async with awaits at
    // writeCache (the layout-cache write). Between yields, an external code
    // path (most commonly throwError's generic-HTML fallthrough at
    // controller.js:5342-5344) can null `local.req`/`local.res`/`local.next`
    // on the controller closure. Capturing into function-scoped locals at the
    // top of the function isolates this render from that null-out so post-
    // await reads do not dereference null. Helpers that read the per-request
    // refs (sendHtmlResponse / writeCache / registerGinaFilters) take the
    // captures as parameters.
    var req   = local.req;
    var res   = local.res;
    var _next = local.next;

    // #B45 — released-response guard. render() can be re-entered on a controller
    // instance whose terminal exit already nulled the per-request triplet — e.g.
    // an action that fired several parallel self.query() calls against a downed
    // upstream: the first failure callback renders a degraded response and
    // releases the triplet, then a later callback re-enters render() here with
    // local.res === null. A later res.stream / setResources(local.req.headers)
    // deref then throws; since render() is async, that escapes as an unhandled
    // promise rejection. Nothing to render to a response already sent/released —
    // no-op. Mirrors render-json.js (#B36) / render-stream.js (#B38); distinct
    // from the #M1 in-flight null-out the captures above isolate.
    if ( local.res == null ) {
        return;
    }

    // #HDR5 — per-request CSP nonce (set on req by gina.plugins.Csp({useNonce:true})).
    // Mirrored onto every framework-injected inline <script> so a bundle can drop
    // 'unsafe-inline' from script-src. Threaded into injectAssets() (which has no
    // `req`); the main-scope value also nonces the late-bind patch script below.
    // Stamped onto `local._cspNonce` (a stable slot, never nulled like local.req)
    // so injectInspectorScripts() can read it without touching volatile local.req.
    var _cspNonce = (req && req._ginaCspNonce) ? req._ginaCspNonce : null;
    var _cspNonceAttr = _cspNonce ? (' nonce="' + _cspNonce + '"') : '';
    local._cspNonce = _cspNonce;

    // #NJ3 — point the module-level render-cache dispatcher at the server's
    // shared in-memory store for this request. Same pattern as render-swig.js
    // and render-json.js. A guard is unnecessary: `self.serverInstance._cached`
    // is always present by the time a controller action runs.
    renderCache.from(self.serverInstance._cached);

    // Fetch the nunjucks module from the process-cache. `get()` throws if
    // the bundle-startup load did not succeed — we surface that cleanly
    // via throwError so the usual error page pipeline handles it.
    // FRAMEWORK PATCH: use module-scope libRef fallback.
    var nunjucks;
    try {
        nunjucks = (libRef && libRef.nunjucksResolver)
            ? libRef.nunjucksResolver.get()
            : require('../../lib/nunjucks-resolver').get();
    } catch (err) {
        return self.throwError(err);
    }

    // No-view short-circuit — e.g. redirect responses reach render() with
    // no template configured. Matches render-swig.js behaviour at this
    // level (the full render-swig file has much more nuanced handling;
    // MVP keeps it simple).
    if (!hasViews || !hasViews()) {
        sendHtmlResponse(local, '', req, res);
        // Release per-request refs on the closure. The function-scoped
        // `req` / `res` / `_next` captures stay alive until return.
        local.req = null;
        local.res = null;
        local.next = null;
        return;
    }

    // headersSent guard — if the pipeline already sent headers (e.g. an
    // upstream throwError beat us here), do nothing. render-swig.js has
    // the same guard near the top.
    if (headersSent && headersSent()) { return; }

    var localOptions = errOptions || local.options;
    var data;
    try {
        data = getData();
    } catch (dataErr) {
        return self.throwError(dataErr);
    }

    // Error-interception mirror — render-swig.js:522-555 has identical logic.
    // When render(err) is called with a non-2xx status + an `error` object,
    // route to throwError for the framework's error page rather than
    // attempting to render.
    if (
        !localOptions.isRenderingCustomError
        && data
        && data.page
        && data.page.data
        && typeof(data.page.data.status) !== 'undefined'
        && !String(data.page.data.status).startsWith('2')
        && typeof(data.page.data.error) !== 'undefined'
    ) {
        var errorObject = {
            status:  data.page.data.status,
            error:   data.page.data.error   || data.page.data.message,
            message: data.page.data.message || data.page.data.error,
            stack:   data.page.data.stack
        };
        try {
            console.error('[render-nunjucks] ' + data.page.data.status + ' from upstream — routing to throwError');
        } catch (e) { /* ignore */ }
        return self.throwError(errorObject);
    }

    var templateRoot = localOptions.template && localOptions.template.html;
    if (!templateRoot) {
        return self.throwError(new Error(
            '[render-nunjucks] missing localOptions.template.html — cannot resolve template root'
        ));
    }

    // Merge user data into the render context, mirroring `render-swig.js`.
    //
    //   (a) Branching stash — if userData has no `page` key, copy it into
    //       `data.page.data` (so `{{ page.data.foo }}` works). userData with
    //       a `page` key skips the stash.
    //   (b) Unconditional top-level merge — userData wins on collision;
    //       userData.page merges INTO data.page (per-key) so a controller
    //       passing `page.*` does not wholesale-replace the subtree.
    //   (c) Framework-data restore — re-overlay getData() so the deep merge
    //       brings back any framework-injected page.environment/page.view/
    //       page.data.session keys that (b)'s per-key page write dropped.
    //       This is the `render-swig.js:593` step nunjucks was missing; without
    //       it a controller passing a partial `page.environment` clobbers
    //       webroot/hostname/version (§4 parity rule).
    if (userData && typeof(userData) === 'object') {
        // (a) Branching stash
        if (!userData.page) {
            if (!data.page.data) { data.page.data = {}; }
            Object.keys(userData).forEach(function (k) {
                data.page.data[k] = userData[k];
            });
        }
        // (b) Unconditional top-level merge — userData wins; userData.page
        // merges INTO data.page (preserves framework-injected page.view etc.).
        Object.keys(userData).forEach(function (k) {
            if (k === 'page' && data.page && typeof userData.page === 'object') {
                Object.keys(userData.page).forEach(function (pk) {
                    data.page[pk] = userData.page[pk];
                });
            } else {
                data[k] = userData[k];
            }
        });
        // (c) Restore framework page.* — deep-merge getData() back on top so
        // page.environment/page.view/page.data.session survive (b).
        data = merge(data, getData());
    }

    // FRAMEWORK PATCH: Bug J — alias `data.data` to `data.page.data`
    // so page-shell `{% set X = data.Y %}` resolves under nunjucks layout
    // inheritance. Mirrors swig's `_layouts/layout.html:1` `{% set data = page.data %}`.
    // Without this, page-shells like `estimate/get.njk:11 {% set document = data.document %}`
    // evaluate to undefined (no `data` key in the env.render context object) and
    // the .overview section renders empty even though page.data.document is fully
    // populated. Push upstream to gina-io/gina alongside Bugs A-I.
    if (data && data.page && data.page.data) {
        data.data = data.page.data;
    }

    // #HDR5 — expose the per-request CSP nonce to nunjucks templates as the
    // top-level {{ cspNonce }} (matching the framework's top-level promotion
    // idiom above). Set on the render-data context before both env.render() and
    // env.renderString() below; the key stays absent when no nonce, so it never
    // renders for bundles without gina.plugins.Csp({ useNonce: true }).
    if (_cspNonce) { data.cspNonce = _cspNonce; }

    var env;
    try {
        env = getEnvironment(nunjucks, templateRoot, {
            autoescape: (localOptions.autoescape !== false)
        });
    } catch (envErr) {
        return self.throwError(envErr);
    }

    // #NJ1 — register Gina's filter registry on the cached env per-request.
    // Mirror of render-swig.js:629-647. Per-request mutation of the cached
    // env is safe under Node's single-threaded event loop because the
    // env.render() / env.renderString() calls below are synchronous and
    // cannot interleave with another request's addFilter pass.
    try {
        registerGinaFilters(env, self, local, localOptions, req, res);
    } catch (filterErr) {
        return self.throwError(filterErr);
    }

    // #NJ1b — give the bundle's controllers/setup.js a chance to extend
    // filters via `this.engine.addFilter(...)`, mirroring the swig path
    // where `self.engine = swig` is set in controller.js before setup runs.
    // No-op if no setup.js exists or it doesn't add filters.
    try {
        registerUserFilters(env, self, local, localOptions, req, res, _next);
    } catch (userFilterErr) {
        try { console.warn('[render-nunjucks] registerUserFilters failed: ' + (userFilterErr.message || userFilterErr)); } catch (e) {}
    }

    // #NJ2 — build the per-request template config and populate
    // `data.page.view.stylesheets` / `data.page.view.scripts`. Mirrors the
    // swig path at render-swig.js:493-499. When `isWithoutLayout` is set
    // (e.g. XHR responses rendered into a popin) the asset list is filtered
    // to common-only via `Collection.find(...)`, matching render-swig.js:496-497.
    // `setResources` is tolerant of a missing viewConf, so we never skip the
    // call unless the dep itself wasn't provided (older controller shape).
    if (typeof setResources === 'function') {
        try {
            var isWithoutLayout = !!localOptions.isWithoutLayout;
            var localTemplateConf = localOptions.template;
            if (isWithoutLayout && localTemplateConf) {
                localTemplateConf = JSON.clone(localTemplateConf);
                if (Collection && Array.isArray(localTemplateConf.javascripts)) {
                    localTemplateConf.javascripts = new Collection(localTemplateConf.javascripts)
                        .find({ isCommon: false }, { isCommon: true, name: 'gina' });
                }
                if (Collection && Array.isArray(localTemplateConf.stylesheets)) {
                    localTemplateConf.stylesheets = new Collection(localTemplateConf.stylesheets)
                        .find({ isCommon: false }, { isCommon: true, name: 'gina' });
                }
            }
            setResources(localTemplateConf);
        } catch (resourcesErr) {
            try { console.warn('[render-nunjucks] setResources failed: ' + (resourcesErr.message || resourcesErr)); } catch (e) {}
        }
    }

    var isRenderingCustomError = (localOptions.isRenderingCustomError === true);
    var html;

    if (isRenderingCustomError) {
        // Custom error template path. `controller.js renderCustomError()` set
        // `localOptions.file` to the absolute path of the bundle's error file
        // (from `bundleConf.content.templates._common.errorFiles[code]` — see
        // `config.js:2653`). Error templates may live under the bundle's
        // template root OR under the shared path (outside the root), so we
        // read the file directly via `fs.readFileSync` and feed its contents
        // to `env.renderString(source, data)` instead of going through the
        // FileSystemLoader (absolute paths are rejected by the loader, and a
        // shared-path file would be outside the bundle root regardless).
        //
        // Never recurse into `self.throwError` from this branch — that would
        // re-enter the same render call and potentially loop. Every failure
        // mode falls back to a minimal inline HTML body served via
        // `sendHtmlResponse` so the client still gets a well-formed response.
        // Mirrors the render-swig.js behaviour where `isRenderingCustomError`
        // reads the file directly at line 347 and compiles its contents.
        var _absErrTemplate = localOptions.file;
        var _errStatusCode  = (data && data.page && data.page.data && data.page.data.status) || 500;
        // #A11Y3 — the three fallbacks below already carry a doctype and a title but no
        // `lang` (WCAG 3.1.1). Reuse the negotiated, already-normalised value the render
        // data carries, and fall back to `en` rather than emit an unparseable tag.
        var _errLang = ( data && data.page && data.page.view
                         && typeof(data.page.view.lang) == 'string'
                         && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(data.page.view.lang) )
            ? data.page.view.lang
            : 'en';

        if (!_absErrTemplate || !fs.existsSync(_absErrTemplate)) {
            html = '<!doctype html><html lang="' + _errLang + '"><head><title>Error ' + _errStatusCode + '</title></head>'
                 + '<body><pre>[render-nunjucks] error template not found: '
                 + (_absErrTemplate || '(unset)') + '</pre></body></html>';
        } else {
            var _errSource = null;
            try {
                _errSource = fs.readFileSync(_absErrTemplate, 'utf8');
            } catch (readErr) {
                html = '<!doctype html><html lang="' + _errLang + '"><head><title>Error ' + _errStatusCode + '</title></head>'
                     + '<body><pre>[render-nunjucks] failed to read error template: '
                     + (readErr.message || readErr) + '</pre></body></html>';
            }
            if (typeof _errSource === 'string') {
                try {
                    html = env.renderString(_errSource, data);
                } catch (renderErr) {
                    html = '<!doctype html><html lang="' + _errLang + '"><head><title>Error ' + _errStatusCode + '</title></head>'
                         + '<body><pre>[render-nunjucks] error template render failed: '
                         + (renderErr.message || renderErr) + '</pre></body></html>';
                }
            }
        }

        // Defensive flag reset — mirrors render-swig.js:804, 1434. Prevents
        // a subsequent render that reuses the same localOptions reference
        // from re-entering this branch.
        localOptions.isRenderingCustomError = false;
    } else {
        var templateRel;
        try {
            templateRel = resolveTemplatePath(data, localOptions);
        } catch (pathErr) {
            return self.throwError(pathErr);
        }

        // Template-existence pre-flight — nunjucks throws on missing templates
        // with a generic message; this produces a Gina-style error object with
        // a clear path so the dev sees what was looked up.
        var absTemplate = nodePath.join(templateRoot, templateRel);
        if (!fs.existsSync(absTemplate)) {
            return self.throwError(new Error(
                '[render-nunjucks] template not found: ' + templateRel +
                ' (looked under ' + templateRoot + ')'
            ));
        }

        try {
            html = env.render(templateRel, data);
        } catch (renderErr) {
            return self.throwError(renderErr);
        }
    }

    // #NJ2 — post-render asset injection (stylesheets / scripts / ginaLoader /
    // externalPlugins). Runs BEFORE Inspector injection so dev-mode scripts
    // settle in their final positions before `__ginaData` / `__ginaLogs` are
    // appended near the end of <body>. Any error falls through with the
    // un-mutated HTML so a mis-shaped template config never breaks the render.
    try {
        html = injectAssets(html, data, localOptions, _cspNonce);
    } catch (assetErr) {
        try { console.warn('[render-nunjucks] asset injection skipped: ' + (assetErr.message || assetErr)); } catch (e) {}
    }

    // FRAMEWORK PATCH: substitute {{ page.X }} / {{ page.environment.X }}
    // placeholders inside ginaLoader (gina.onload.min.js), which is inserted as a literal
    // HTML string by injectAssets() and therefore cannot rely on nunjucks to resolve its
    // tokens. Mirrors render-swig.js:572-582 (flatten dict) + 1276 (whisper call). Without
    // this, `window.onGinaLoaded` throws a JSON.parse SyntaxError on every page, leaving
    // gina.popin / gina.session / gina.forms / window.onGenericXhrResponse undefined and
    // breaking every legacy popin + form-submit. Push upstream to gina-io/gina alongside
    // Bugs A-E.
    try {
        if (data && data.page && typeof data.page === 'object' && typeof whisper === 'function') {
            var ginaLoaderDic = {};
            for (var _d in data.page) {
                ginaLoaderDic['page.' + _d] = data.page[_d];
            }
            if (typeof data.page.environment === 'object' && data.page.environment !== null) {
                for (var _k in data.page.environment) {
                    ginaLoaderDic['page.environment.' + _k] = data.page.environment[_k];
                }
            }
            // gina.onload.min.js also references `{{ page.data.session.X }}` (depth 3)
            // for session id/timeout/createdAt/lastModified — flatten that level too.
            if (data.page.data && typeof data.page.data === 'object' && data.page.data.session && typeof data.page.data.session === 'object') {
                for (var _s in data.page.data.session) {
                    ginaLoaderDic['page.data.session.' + _s] = data.page.data.session[_s];
                }
            }
            html = whisper(ginaLoaderDic, html, /\{{ ([a-zA-Z.]+) \}}/g);
        }
    } catch (whisperErr) {
        try { console.warn('[render-nunjucks] ginaLoader whisper substitution skipped: ' + (whisperErr.message || whisperErr)); } catch (e) {}
    }

    // Inspector dev-payload injection (dev mode only; no-op otherwise).
    try {
        html = injectInspectorScripts(html, data, self, local, displayInspector);
    } catch (injectErr) {
        // Never let an Inspector-side bug break the render. Log and
        // continue with the un-injected HTML.
        try { console.warn('[render-nunjucks] inspector injection skipped: ' + injectErr.message); } catch (e) {}
    }

    // #RWATCH S3 — stale-release banner before writeCache (rides cache hit + miss);
    // byte-inert unless local + !dev + releaseWatch.enabled.
    html = releaseBanner.maybeInject(html, localOptions.conf, _cspNonceAttr);

    // #FI — snapshot the timeline length AFTER the __ginaData payload was
    // serialised (inside injectInspectorScripts, which also pushed any QI
    // entries). The response-write/total entries pushed below are therefore
    // "late entries" appended client-side via _njFlowPatch. Mirrors
    // render-swig.js:1077-1080.
    var _njFlowSnapshotCount = (local._timeline) ? local._timeline.entries.length : 0;

    // #NJ3 — static HTML cache write. Must run BEFORE sendHtmlResponse so
    // the cached bytes reflect the final output AND the miss-path
    // Cache-Control header we set next is committed alongside the response.
    // The guard mirrors render-swig.js:821-830 exactly: cacheless mode
    // allowed through when `_cacheIsEnabled === 'true'` (dev-mode cache
    // testing), GETs only, route must declare a `cache` block.
    if (
        !self.isCacheless()
        && typeof(req.routing.cache) != 'undefined'
        && req.method.toUpperCase() === 'GET'
        ||
        // allowing caching even for dev env
        String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'
        && typeof(req.routing.cache) != 'undefined'
        && req.method.toUpperCase() === 'GET'
    ) {
        try {
            await writeCache(local, self, localOptions.bundle, localOptions.conf.server.cache, html, req, res);
        } catch (cacheErr) {
            // Cache-write failures must never break the render. The response
            // still goes out; subsequent requests will retry the write on the
            // next miss. Mirrors the fire-and-forget treatment in render-json.js.
            try { console.error('[render-nunjucks] writeCache failed: ' + (cacheErr.message || cacheErr)); } catch (e) {}
        }
    }

    // Cache-Control: miss path — inform browsers/CDNs of the response lifetime (#C6).
    // Mirror of render-swig.js:834-841. The hit path in server.isaac.js
    // re-computes its own Cache-Control header from `cachedContentObj.ttl`
    // so this header is only meaningful when a client receives the
    // freshly-rendered bytes.
    if ( typeof(req.routing.cache) != 'undefined' && req.routing.cache ) {
        var _ccCfg = ( typeof(req.routing.cache) == 'string' ) ? { type: req.routing.cache } : req.routing.cache;
        var _ccTtl = ( typeof(_ccCfg.ttl) != 'undefined' && _ccCfg.ttl > 0 ) ? _ccCfg.ttl : localOptions.conf.server.cache.ttl;
        if ( _ccTtl > 0 ) {
            res.setHeader('Cache-Control', ( _ccCfg.visibility === 'public' ? 'public' : 'private' ) + ', max-age=' + ~~(_ccTtl));
        }
    }

    // #FI — response write + total timing for the Inspector Flow tab. Pushed
    // after the __ginaData snapshot was serialised, so they are late entries
    // appended client-side by _njFlowPatch below. Mirrors render-swig.js:1583-1599.
    var _njLateEntries = [];
    if (local._timeline) {
        var _njRespEnd = Date.now();
        var _njRwStart = local._timeline._renderStart || local._timeline._actionStart || local._timeline.requestStart;
        local._timeline.entries.push({
            label: 'response-write', cat: 'response',
            startMs: _njRwStart, endMs: _njRespEnd,
            durationMs: _njRespEnd - _njRwStart,
            detail: null
        });
        local._timeline.entries.push({
            label: 'total', cat: 'total',
            startMs: local._timeline.requestStart,
            endMs: _njRespEnd,
            durationMs: _njRespEnd - local._timeline.requestStart,
            detail: null
        });
        _njLateEntries = local._timeline.entries.slice(_njFlowSnapshotCount);
    }

    // Late-bind Inspector View tab Weight + Load metrics AND Flow tab late
    // entries into the already-serialised `window.__ginaData` so both work
    // under COOP without `window.opener`. Mirrors render-swig.js:1608-1622
    // (cache-miss late-bind). `server.isaac.js` cache-hits serve the pre-patch
    // bytes (weightBytes=null + emit-time serverMs + base flow entries only).
    if ((displayInspector || self.isCacheless()) && /<\/body>/i.test(html)) {
        try {
            var _njWeightBytesFinal = Buffer.byteLength(html, 'utf8');
            var _njServerMsFinal    = (local._timeline && typeof local._timeline.requestStart === 'number')
                ? Date.now() - local._timeline.requestStart
                : null;
            var _njFlowPatch = (_njLateEntries.length > 0)
                ? 'if(u&&u.flow){var _e=u.flow.entries,_p=' + inlineScript.safeInlineJson(_njLateEntries) + ';for(var _i=0;_i<_p.length;_i++){_e.push(_p[_i])}}'
                : '';
            var _njPatchScript = '<script' + _cspNonceAttr + '>(function(d){'
                + 'var u=d&&d.user,g=d&&d.gina;'
                + _njFlowPatch
                + 'if(u&&u.environment&&u.environment.metrics){u.environment.metrics.weightBytes=' + _njWeightBytesFinal + ';u.environment.metrics.serverMs=' + _njServerMsFinal + ';}'
                + 'if(g&&g.environment&&g.environment.metrics){g.environment.metrics.weightBytes=' + _njWeightBytesFinal + ';g.environment.metrics.serverMs=' + _njServerMsFinal + ';}'
                // #B386 — re-sync the Inspector's localStorage fallback channel.
                // statusbar.html writes that mirror BEFORE this patch runs, so
                // without this line it keeps the emit-time payload forever:
                // weightBytes null (View tab drops its weight badge whenever the
                // client Performance leg is unavailable) and the late flow entries
                // missing (Flow tab loses its template/response/total bars).
                + 'try{localStorage.setItem("__ginaData",JSON.stringify(d))}catch(e){}'
                // #B386 (part 2) — republish over the per-tab BroadcastChannel.
                // localStorage above is only the Inspector's FALLBACK channel;
                // a statusbar-launched Inspector runs in BOUND mode and reads
                // this channel instead, so the re-sync above never reached it.
                // Every statusbar _ginaPublish() call site runs BEFORE this
                // patch (measured: 7 sites, all ahead of it), so without this
                // line a bound Inspector holds the pre-patch frame until it
                // re-requests — which is what "refresh the Inspector" did.
                // The channel id comes from sessionStorage, which is per-tab
                // and therefore race-free; the localStorage advert is
                // last-writer-wins across tabs and must NOT be used here.
                + 'try{var _t=sessionStorage.getItem("__gina_tab_id");if(_t&&typeof BroadcastChannel!=="undefined"){var _c=new BroadcastChannel("gina-inspector-"+_t);_c.postMessage({type:"data",payload:d});_c.close();}}catch(e){}'
                + '}(window.__ginaData));</script>';
            // Function replacer, not a string: the patch embeds JSON.stringify'd
            // flow entries, and a string replacement expands $&, $`, $' and $1 in
            // the replacement text — corrupting the emitted script for any entry
            // whose label/detail carries one. Both render-swig.js sites already
            // use the function form; this one did not.
            html = html.replace(/<\/body>/i, function () { return _njPatchScript + '</body>'; });
        } catch (lateBindErr) {
            try { console.warn('[render-nunjucks] view-fallback late-bind skipped: ' + (lateBindErr.message || lateBindErr)); } catch (e) {}
        }
    }

    // #INS10 follow-up — prod-window HTML egress (nunjucks). Window-open AND
    // not-dev: mutually exclusive with injectInspectorScripts() above (which
    // requires isCacheless/displayInspector). Emits the captured query log +
    // flow timeline (complete with the response-write/total bars pushed above)
    // over the authenticated /_gina/agent SSE, touching no HTML.
    if ((process.gina && process.gina._inspectorWindowUntil > Date.now()) && !self.isCacheless()) {
        emitInspectorWindowData(self, local);
    }

    sendHtmlResponse(local, html, req, res);

    // Release per-request refs on the closure. The function-scoped
    // `req` / `res` / `_next` captures stay alive until return.
    local.req = null;
    local.res = null;
    local.next = null;
};
