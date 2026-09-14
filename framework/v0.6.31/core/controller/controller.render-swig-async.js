/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module controller.render-swig-async
 * @description Render delegate for swig bundles configured with a custom async
 * template loader (`settings.template.swig.loader`). controller.js selects this
 * delegate when `process.gina._swigLoaders[<templateRoot>].loader.async === true`;
 * every other swig bundle keeps the byte-identical filesystem path
 * (controller.render-swig.js).
 *
 * Unlike render-swig.js — which self-reads the template from disk, pre-resolves
 * `{% extends %}`, and compiles a string — this delegate renders through an
 * ISOLATED per-bundle `new swig.Swig({ loader })` instance. swig's async
 * codegen drives `resolve -> load` for the page template AND its whole
 * transitive `extends` / `include` / `import` chain through the custom loader,
 * so templates can live off-disk (remote / CDN / object-storage / in-memory).
 * The per-bundle instance is what keeps multiple bundles in one process from
 * colliding on the swig process-singleton's shared loader (#TPL1).
 *
 * MVP scope (Slice 1): per-bundle engine isolation + loader pipeline + gina
 * filter registration + render + HTTP/1.1 & HTTP/2 send + post-render asset
 * injection — the gina client bundle / CSS / JS are injected via injectAssets()
 * plus the gina-bootstrap whisper pass, mirroring render-nunjucks.js, so an
 * off-disk full page ships the client runtime and is production-usable. The
 * #RWATCH stale-release banner is spliced onto the finalized HTML too
 * (sync-delegate parity; self-gated, see release-banner.js).
 * Deferred to follow-up slices (mirroring the render-nunjucks N2 -> #NJ
 * build-out): Inspector dev-payload, static HTML cache writes, error-template
 * routing, and Early Hints.
 *
 * #TPL1 Tier-2 (this slice): the gina filters are registered ONCE on the shared
 * per-bundle engine and read per-request context from `process.gina._renderALS`
 * at call time, closing the #B25 cross-request filter-table race; an opt-in
 * (`settings.template.swig.loader.cache`, dev-disabled) compiled-fn memo per
 * template root reintroduces cross-request compile reuse.
 *
 * @package gina.framework
 */

const libRef = require('./../../lib') || require.cache[require.resolve('./../../lib')];
// #B433 hardening — bind the logger explicitly. Until now this file reached it
// only because lib/routing reassigns the global at require time; an explicit
// binding keeps every log line here on the redacting, container-dispatched
// writer regardless of that side effect.
var console  = libRef.logger;
const merge  = libRef.merge;
// Collection — filters the asset list to common-only when rendering without a
// layout (isWithoutLayout XHR/popin responses), mirroring render-nunjucks.js /
// render-swig.js. Fetched via the lib registry so dev-mode hot-reload evictions
// of lib/index.js don't poison the reference across requests.
const Collection = libRef.Collection;
// #RWATCH S3 — stale-release banner injector (shared standalone module; the
// call self-gates on local scope + !dev + server.releaseWatch.enabled).
// Sibling-file require, cache-hit-deduped across dev evictions — the same
// shape the sync delegates use (render-swig.js:14 / render-nunjucks.js:129).
const releaseBanner = require('./release-banner');

/**
 * Lazily construct the process-wide render-context AsyncLocalStorage, parked on
 * `process.gina` so it survives dev-mode `require.cache` eviction of this
 * delegate (mirrors `process.gina._reqALS` / `_queryALS`). The async delegates
 * wrap their awaited render in
 * `_renderALS.run({ options, isProxyHost, throwError, req, res }, …)` so the
 * once-registered, context-free gina filters (getUrl/getWebroot/t/tIcu) read the
 * right request's context at call time — closing the #B25 shared-filter-table
 * race and enabling a shared engine + compiled-fn cache (#TPL1 Tier-2).
 *
 * @inner
 * @returns {AsyncLocalStorage} the shared render-context store
 */
function getRenderALS() {
    if (!process.gina._renderALS) {
        var AsyncLocalStorage = require('async_hooks').AsyncLocalStorage;
        process.gina._renderALS = new AsyncLocalStorage();
    }
    return process.gina._renderALS;
}

/**
 * Per-bundle isolated swig engine + compiled-fn cache. Key: the bundle template
 * root. Value: `{ engine, compiled }` — `engine` is a `new swig.Swig({ loader })`
 * instance with its OWN options.loader, cache, filters and tags (so multiple
 * bundles sharing one process never collide on a shared loader, which a
 * per-bundle `swig.setDefaults({ loader })` on the process-singleton would
 * cause); `compiled` is the #TPL1 Tier-2 per-template compiled-fn memo (consulted
 * per render only when the bundle opts into `loader.cache` and not in dev).
 *
 * The gina filters are registered ONCE here (not per request): they are
 * context-free and read per-request context from `process.gina._renderALS` at
 * call time, so the shared filter table can't bleed context across interleaved
 * async renders (#B25).
 *
 * Stored on `process.gina` so it survives dev-mode `refreshCoreDependencies()`
 * evictions of controller.js + this delegate. The whole registry (engines AND
 * their compiled-fn memos) is dropped when the resolved swig MODULE is
 * hot-swapped (`_swigEnginesOwner !== swigMod`) — compiled fns are bound to the
 * module that built them — mirroring render-nunjucks.js `_nunjucksEnvsOwner`.
 *
 * @inner
 * @param {*}        swigMod      - The resolved swig module (exposes `.Swig`)
 * @param {string}   templateRoot - Registry key (bundle template root)
 * @param {object}   loader       - Guarded async loader (from `process.gina._swigLoaders`)
 * @param {boolean}  autoescape   - Per-bundle autoescape (captured by initSwigEngine)
 * @param {function} SwigFilters  - The SwigFilters factory (from `deps`), registered once
 * @param {function} throwError   - `self.throwError`, carried into the filter set
 * @returns {{engine:*, compiled:Map}} The cached-or-built engine + its compiled-fn memo
 */
function getSwigEngine(swigMod, templateRoot, loader, autoescape, SwigFilters, throwError) {
    if (!process.gina._swigEngines) {
        process.gina._swigEngines = Object.create(null);
    }
    // Drop all cached engines (and their compiled-fn memos) when the swig module
    // was hot-swapped (dev-mode project-swig refresh) — instances and compiled
    // fns are bound to the module that built them.
    if (process.gina._swigEnginesOwner !== swigMod) {
        process.gina._swigEngines = Object.create(null);
        process.gina._swigEnginesOwner = swigMod;
    }
    var key = templateRoot;
    if (!process.gina._swigEngines[key]) {
        var engine = new swigMod.Swig({
            loader:     loader,
            autoescape: (autoescape === true),
            // swig forces cache:false for async-compiled templates anyway; the
            // gina Tier-2 compiled-fn reuse is the per-entry `compiled` Map below.
            cache:      false
        });
        // #B25 / #TPL1 Tier-2 — register the gina filters ONCE on the shared
        // engine (context-free; per-request context flows via _renderALS).
        registerGinaFilters(engine, SwigFilters, throwError);
        process.gina._swigEngines[key] = {
            engine:   engine,
            compiled: new Map()
        };
    }
    return process.gina._swigEngines[key];
}

/**
 * Resolve the loader identifier for the page template, relative to the bundle
 * template root. Same shape as render-nunjucks.js `resolveTemplatePath()`:
 * honours a `self.setTemplate()` override, the namespace sub-directory, and the
 * extension append. No CVE path check here — the loader wrapper guards every
 * `resolve()`.
 *
 * @inner
 * @param {object} data         - Template data (`data.page.view.file` / `.ext`)
 * @param {object} localOptions - Controller options (`.namespace`, `._templateOverride`)
 * @returns {string} Loader identifier (path relative to the template root)
 */
function resolveTemplatePath(data, localOptions) {
    // Runtime override from self.setTemplate(file, ext) fully replaces the
    // rule's default path (no namespace prefixing).
    if (localOptions && localOptions._templateOverride && localOptions._templateOverride.file) {
        var ovFile = localOptions._templateOverride.file;
        var ovExt  = localOptions._templateOverride.ext || data.page.view.ext || '';
        if (ovExt && !ovFile.endsWith(ovExt)) { ovFile += ovExt; }
        return ovFile;
    }

    var file = data.page.view.file;
    var ext  = data.page.view.ext || '';

    if (localOptions.namespace) {
        var effective = file || localOptions.namespace;
        if (effective === localOptions.namespace) { effective = 'index'; }
        // Drop a redundant `<namespace>-` prefix from the file segment so a
        // route named `<namespace>-<action>` resolves to `<namespace>/<action>`.
        var nsPrefix = localOptions.namespace + '-';
        if (effective.length > nsPrefix.length && effective.indexOf(nsPrefix) === 0) {
            effective = effective.substring(nsPrefix.length);
        }
        var rel = localOptions.namespace + '/' + effective;
        if (ext && !rel.endsWith(ext)) { rel += ext; }
        return rel;
    }

    var relRoot = file;
    if (ext && !relRoot.endsWith(ext)) { relRoot += ext; }
    return relRoot;
}

/**
 * Compute the per-request proxy-host decision from the raw request headers and
 * the resolved bundle options. Extracted so the render path can stash it in the
 * `_renderALS` store (the gina filters read `ctx.isProxyHost` from there).
 * Mirrors the isProxyHost derivation in render-swig.js / render-nunjucks.js.
 *
 * @inner
 * @param {object} req          - Request (raw headers)
 * @param {object} localOptions - Controller options (`.conf`, hostname/port)
 * @returns {boolean} true when the request appears to arrive via a reverse proxy
 */
function computeIsProxyHost(req, localOptions) {
    var localRequestPort = req.headers.port || req.headers[':port'];
    return (
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
}

/**
 * Register gina's SwigFilters on the shared per-bundle engine, ONCE (not per
 * request). The filters are context-free: getUrl / getWebroot / t / tIcu read
 * per-request context from `process.gina._renderALS` at call time, so a single
 * shared filter table can't bleed one request's context into another's
 * interleaved async render (#B25). The build-time conf is therefore empty —
 * everything flows through the ALS store stamped by the render `.run()` wrap.
 *
 * @inner
 * @param {*}        engine      - The per-bundle swig engine instance
 * @param {function} SwigFilters - The SwigFilters factory (from `deps`)
 * @param {function} throwError  - `self.throwError`, carried for the singleton-fallback path
 * @returns {void}
 */
function registerGinaFilters(engine, SwigFilters, throwError) {
    var filters = SwigFilters({ options: {}, isProxyHost: false, throwError: throwError });

    for (var name in filters) {
        if (typeof filters[name] === 'function' && name !== 'getConfig') {
            engine.setFilter(name, filters[name]);
        }
    }
}

/**
 * Send the rendered HTML, covering HEAD + HTTP/2 stream + HTTP/1.1 in the
 * four-way branch from class.controller.md §7b. Ported verbatim from
 * render-nunjucks.js `sendHtmlResponse()` (the proven separate-delegate send).
 *
 * @inner
 * @param {object} local - Per-request closure (for `_trailers`)
 * @param {string} html  - Final HTML string
 * @param {object} req   - Request (captured)
 * @param {object} res   - Response (captured)
 * @returns {void}
 */
function sendHtmlResponse(local, html, req, res) {
    if (res.headersSent) { return; }

    var statusCode = res.statusCode || 200;
    var stream     = (res && typeof res.stream !== 'undefined') ? res.stream : null;
    var isHead     = /^HEAD$/i.test(req.method);
    // #H10 — opt-in HTTP/2 response trailers (registered via self.sendTrailers()).
    var _trailers  = (local && local._trailers && typeof(local._trailers) === 'object') ? local._trailers : null;
    var byteLength = Buffer.byteLength(html, 'utf8');

    if (!res.getHeader('content-type')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
    }

    if (isHead) {
        if (stream) {
            // Case 1: HEAD + HTTP/2
            if (stream.destroyed || stream.closed) {
                try { console.warn('[render-swig-async] stream already destroyed on HEAD — client disconnected ('+ req.url +')'); } catch (e) {}
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
            try { console.warn('[render-swig-async] stream already destroyed — client disconnected before response ('+ req.url +')'); } catch (e) {}
            return;
        }
        if (!stream.headersSent) {
            var _streamHeaders = {
                'content-type': res.getHeader('content-type'),
                ':status':      statusCode
            };
            var _pendingHeaders = res.getHeaders ? res.getHeaders() : {};
            for (var _shk in _pendingHeaders) {
                if (!(_shk in _streamHeaders)) { _streamHeaders[_shk] = _pendingHeaders[_shk]; }
            }
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
 * Post-render asset injection. Inserts the bundle's stylesheets / scripts, the
 * external plugins, and the gina client bootstrap (`gina.onload.min.js`) onto
 * the `</head>` / `</body>` anchors of the rendered HTML. Direct port of
 * render-nunjucks.js `injectAssets()` — the async swig delegate renders through
 * the engine API (no FS `getAssets()` machinery), so it injects post-render the
 * same way the nunjucks delegate does.
 *
 * Honours `javascriptsDeferEnabled` (scripts in `<head>` vs before `</body>`)
 * and `javascriptsExcluded === '**'` (suppresses the bootstrap). Skips any
 * asset already present in the HTML (idempotent) and any fragment missing the
 * `</head>`/`</body>` anchor (HEAD responses, partial renders) — returning the
 * HTML unchanged rather than growing truncated markup.
 *
 * @inner
 * @param {string}  html         - Rendered HTML from the swig async engine
 * @param {object}  data         - Template data (`data.page.view.stylesheets`/`.scripts`)
 * @param {object}  localOptions - Controller options (`template.ginaLoader`, `.externalPlugins`, …)
 * @param {string} [cspNonce]    - #HDR5 per-request CSP nonce; stamps the bootstrap <script>
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
 * Async-loader swig render delegate. Signature matches the other delegates so
 * controller.js can dispatch to it interchangeably.
 *
 * @param {object}   userData          - Controller-supplied template data
 * @param {boolean=} displayInspector  - Dev Inspector toggle (deferred — unused in the MVP)
 * @param {object=}  errOptions        - Options when invoked from the error pipeline
 * @param {object}   deps              - Injected controller refs ({ self, local, getData, hasViews, setResources, headersSent, SwigFilters, swig })
 * @returns {Promise<void>}
 *
 * @example
 * // Selected automatically by controller.js when the bundle configures
 * // settings.template.swig.loader; the controller action just calls self.render(data).
 */
module.exports = async function renderSwigAsync(userData, displayInspector, errOptions, deps) {
    var self        = deps.self;
    var local       = deps.local;
    var getData     = deps.getData;
    var hasViews    = deps.hasViews;
    var headersSent = deps.headersSent;
    var SwigFilters  = deps.SwigFilters;
    var setResources = deps.setResources; // #TPL1 — populates data.page.view.stylesheets/.scripts for asset injection
    var swigMod      = deps.swig; // the resolved swig MODULE (exposes .Swig)

    // Function-scoped captures of the per-request refs (#M1 race fix — mirror of
    // render-nunjucks/render-swig). This render awaits (getTemplate + execute);
    // capturing isolates post-await reads from a concurrent throwError null-out
    // on the controller closure.
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

    // No-view short-circuit (e.g. redirect responses reach render() without a
    // configured template).
    if (!hasViews || !hasViews()) {
        sendHtmlResponse(local, '', req, res);
        local.req = null;
        local.res = null;
        local.next = null;
        return;
    }

    // If the pipeline already sent headers (an upstream throwError beat us), stop.
    if (headersSent && headersSent()) { return; }

    var localOptions = errOptions || local.options;

    var data;
    try {
        data = getData();
    } catch (dataErr) {
        return self.throwError(dataErr);
    }

    // Error-interception — render(err) with a non-2xx status + an error object
    // routes to the framework error page rather than rendering. Mirrors
    // render-swig.js / render-nunjucks.js.
    if (
        !localOptions.isRenderingCustomError
        && data && data.page && data.page.data
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
            console.error('[render-swig-async] ' + data.page.data.status + ' from upstream — routing to throwError');
        } catch (e) { /* ignore */ }
        return self.throwError(errorObject);
    }

    // Registry key — the SAME expression initSwigEngine used to stash the loader
    // (conf.content.templates._common.html), so the two sides never diverge.
    var loaderKey = localOptions.conf
        && localOptions.conf.content
        && localOptions.conf.content.templates
        && localOptions.conf.content.templates._common
        && localOptions.conf.content.templates._common.html;

    var stash = (loaderKey && process.gina._swigLoaders) ? process.gina._swigLoaders[loaderKey] : null;
    if (!stash || !stash.loader) {
        return self.throwError(new Error(
            '[render-swig-async] no async swig loader registered for bundle ' + localOptions.bundle +
            ' — initSwigEngine did not build one (was settings.template.swig.loader removed at runtime?)'
        ));
    }

    // Merge user data into the render context — mirror render-nunjucks.js:
    //   (a) branching stash (userData without a `page` key -> data.page.data),
    //   (b) top-level merge with per-key `page` handling (preserves page.view etc.),
    //   (c) framework-data restore (re-overlay getData() so page.environment /
    //       page.view / page.data.session survive a partial page.* from the controller).
    if (userData && typeof(userData) === 'object') {
        if (!userData.page) {
            if (!data.page.data) { data.page.data = {}; }
            Object.keys(userData).forEach(function (k) {
                data.page.data[k] = userData[k];
            });
        }
        Object.keys(userData).forEach(function (k) {
            if (k === 'page' && data.page && typeof userData.page === 'object') {
                Object.keys(userData.page).forEach(function (pk) {
                    data.page[pk] = userData.page[pk];
                });
            } else {
                data[k] = userData[k];
            }
        });
        data = merge(data, getData());
    }

    var engineEntry, engine;
    try {
        engineEntry = getSwigEngine(swigMod, loaderKey, stash.loader, stash.autoescape, SwigFilters, self.throwError);
        engine      = engineEntry.engine;
    } catch (engErr) {
        return self.throwError(engErr);
    }

    // #TPL1 asset injection — populate data.page.view.stylesheets / .scripts so
    // injectAssets() (post-render) can auto-inject the gina client bundle, CSS
    // and JS into the off-disk render. Mirrors render-nunjucks.js: isWithoutLayout
    // (XHR/popin) responses filter the asset list to common-only via Collection.
    if (typeof setResources === 'function') {
        try {
            var isWithoutLayout   = !!localOptions.isWithoutLayout;
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
            // Re-overlay getData() so the freshly-set page.view.stylesheets /
            // .scripts reach `data` — the render-swig.js:609 "needed !!" step:
            // setResources writes via the controller's set() into local.userData,
            // getData() rebuilds the data object, and merge fills the new keys.
            data = merge(data, getData());
        } catch (resourcesErr) {
            try { console.warn('[render-swig-async] setResources failed: ' + (resourcesErr.message || resourcesErr)); } catch (e) {}
        }
    }

    // #HDR5/#HDR16 — per-request CSP nonce (set on req by gina.plugins.Csp({useNonce:true})).
    // Passed to injectAssets() so the injected gina bootstrap <script> carries a
    // matching nonce, and exposed as {{ page.cspNonce }} for app templates
    // (mirrors render-swig.js:903). Absent when the bundle sets no nonce.
    var _cspNonce = (req && req._ginaCspNonce) ? req._ginaCspNonce : null;
    if (_cspNonce) {
        if (!data.page) { data.page = {}; }
        data.page.cspNonce = _cspNonce;
    }

    var templateName;
    try {
        templateName = resolveTemplatePath(data, localOptions);
    } catch (pathErr) {
        return self.throwError(pathErr);
    }

    var html;
    try {
        // #B25 / #TPL1 Tier-2 — per-request render context for the once-registered,
        // context-free gina filters on the shared engine. Carried through
        // process.gina._renderALS so the filters read THIS request's context at
        // call time (not a concurrently-interleaved render's). The .run() wrap is
        // UNCONDITIONAL — it closes the #B25 race whether or not the compiled
        // cache is opted in — and propagates the store across every await in the
        // render (page template + its transitive extends/include chain).
        var _renderStore = {
            options:     JSON.clone(localOptions),
            isProxyHost: computeIsProxyHost(req, localOptions),
            throwError:  self.throwError,
            req:         req,
            res:         res
        };
        // Tier-2 compiled-fn reuse: opt-in via settings.template.swig.loader.cache,
        // force-disabled in dev so template edits are picked up live.
        var _useMemo = (stash.cache === true) && (process.env.NODE_ENV_IS_DEV !== 'true');

        html = await getRenderALS().run(_renderStore, async function () {
            var compiled;
            if (_useMemo) {
                compiled = engineEntry.compiled.get(templateName);
                if (!compiled) {
                    // Cache the Promise<fn> (collapses concurrent first-loads of the
                    // same template); a rejected compile is evicted so a transient
                    // loader failure doesn't poison the cache permanently.
                    compiled = engine.getTemplate(templateName, { filename: templateName });
                    engineEntry.compiled.set(templateName, compiled);
                    compiled.catch(function () { engineEntry.compiled.delete(templateName); });
                }
                compiled = await compiled;
            } else {
                // swig async path: getTemplate(name) resolves+loads the page
                // template AND its transitive extends/include chain through the
                // custom loader, returning Promise<TemplateFn>; the compiled fn
                // returns Promise<{output}>.
                compiled = await engine.getTemplate(templateName, { filename: templateName });
            }
            var rendered = await compiled(data);
            return (rendered && typeof rendered.output === 'string') ? rendered.output : String(rendered);
        });
    } catch (renderErr) {
        return self.throwError(renderErr);
    }

    // #TPL1 — post-render asset injection (stylesheets / scripts / ginaLoader /
    // externalPlugins) onto the </head> / </body> anchors. Falls through with
    // un-mutated HTML on any error so a mis-shaped template config never breaks
    // the render.
    try {
        html = injectAssets(html, data, localOptions, _cspNonce);
    } catch (assetErr) {
        try { console.warn('[render-swig-async] asset injection skipped: ' + (assetErr.message || assetErr)); } catch (e) {}
    }

    // The injected gina bootstrap (gina.onload.min.js) is a literal HTML string
    // carrying {{ page.X }} / {{ page.environment.X }} / {{ page.data.session.X }}
    // placeholders the engine never saw (inserted post-render); resolve them with
    // whisper(). Mirrors render-nunjucks.js / render-swig.js:572-582+1276. Without
    // this, window.onGinaLoaded throws a JSON.parse SyntaxError and gina.popin /
    // gina.session / gina.forms / onGenericXhrResponse stay undefined.
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
            // gina.onload.min.js also references `{{ page.data.session.X }}` (depth 3).
            if (data.page.data && typeof data.page.data === 'object' && data.page.data.session && typeof data.page.data.session === 'object') {
                for (var _s in data.page.data.session) {
                    ginaLoaderDic['page.data.session.' + _s] = data.page.data.session[_s];
                }
            }
            html = whisper(ginaLoaderDic, html, /\{{ ([a-zA-Z.]+) \}}/g);
        }
    } catch (whisperErr) {
        try { console.warn('[render-swig-async] ginaLoader whisper substitution skipped: ' + (whisperErr.message || whisperErr)); } catch (e) {}
    }

    // #RWATCH S3 — stale-release banner on the finalized HTML (parity with the
    // sync delegates): after the whisper pass, before send. Self-gated in
    // release-banner.js — byte-inert unless local scope + !dev +
    // server.releaseWatch.enabled; skipped for partials (no </body> anchor)
    // and already-bannered HTML (MARKER double-injection guard).
    var _cspNonceAttr = _cspNonce ? (' nonce="' + _cspNonce + '"') : '';
    html = releaseBanner.maybeInject(html, localOptions.conf, _cspNonceAttr);

    // A concurrent throwError may have sent headers while we awaited — re-check.
    if (headersSent && headersSent()) { return; }

    sendHtmlResponse(local, html, req, res);

    // Release per-request refs on the closure; the function-scoped captures stay
    // alive until return.
    local.req = null;
    local.res = null;
    local.next = null;
};
