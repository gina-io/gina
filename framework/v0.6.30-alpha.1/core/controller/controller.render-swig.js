const fs       = require('fs');
const nodePath = require('path'); // CVE-2023-25345: used for template path boundary enforcement

const lib             = require('./../../lib') || require.cache[require.resolve('./../../lib')];
// #B433 hardening — bind the logger explicitly. Until now this file reached it
// only because lib/routing reassigns the global at require time; an explicit
// binding keeps every log line here on the redacting, container-dispatched
// writer regardless of that side effect.
var console           = lib.logger;
const Collection      = lib.Collection;
const cache           = new lib.Cache();
const renderCache     = new lib.RenderCache();
var statusCodes       = requireJSON( _( getPath('gina').core + '/status.codes') );
// Inspector secret redaction (dev-mode only — never touches the actual response body)
var inlineScript      = require('./inline-script');
var inspectorRedact   = require('lib/inspector-redact');
// #INS10 follow-up — prod-window HTML egress (no-HTML, render-json-style emit).
var emitInspectorWindowData = require('./inspector-window-emit');
// #RWATCH S3 — stale-release banner injector (server-side inline; gated inert).
var releaseBanner = require('./release-banner');
// Precompiled regex — avoids per-request RegExp allocation (#P3)
var blacklistRe       = /[<>]/g;

// Inherited from controller.
// #B61 (completes the #INS10 race fix): ALL per-request deps are captured
// FUNCTION-scoped inside render() — nothing per-request lives at module scope.
// In prod this module is a shared singleton across concurrent requests, and a
// module-scoped capture is reassigned by every incoming render; a render
// suspended at an await would resume reading a CONCURRENT request's closures
// (measured: the post-await setResources / getData calls executed the other
// request's functions, gap-filling its page data into this render's context).

/**
 * Write the rendered HTML to the cache store (memory or file system).
 * No-op when caching is disabled or the route has no `cache` setting.
 *
 * @inner
 * @param {string} bundle      - Bundle name (used as cache-key namespace)
 * @param {object} opt         - Server cache configuration (`opt.path`, `opt.ttl`, `opt.sliding`, `opt.maxAge`)
 * @param {string} htmlContent - Compiled HTML string to cache
 * @param {object} req         - Per-request request captured by render() (function-scoped, race-safe)
 * @param {object} res         - Per-request response captured by render() (function-scoped, race-safe)
 * @param {boolean|string} cacheIsEnabled - Server-level cache flag threaded by render(); writeCache
 *                               is module-level and has no access to render()-scoped bindings
 * @param {function} throwError - Render-scoped controller `throwError` (closure-bound), threaded
 *                               for the `invalidateOnEvents` validation branch
 * @returns {Promise<void>}
 */
async function writeCache(bundle, opt, htmlContent, req, res, cacheIsEnabled, throwError) {
    if (
        typeof(req.routing.cache) == 'undefined'
        ||
        ! req.routing.cache
        ||
        // replaced: /^true$/i.test() (#P6); flag threaded as a param — module scope
        // has no render()-scoped bindings (see the #INS10 note at the top of this file)
        String(cacheIsEnabled).toLowerCase() !== 'true'
        ||
        // #B158 — a gated route is never stored: the key carries no principal and
        // both serve points run before the gate. Full rationale on isRouteGated.
        lib.authzGate.isRouteGated(req)
        ||
        // #SPA1 — a NEGOTIABLE route is never stored, for the identical reason one
        // sentence up: the key carries no SHAPE dimension, and both serve points run
        // before the shape is resolved. Storing one would let a fragment be replayed
        // to a page request (and vice versa) on the same URL.
        // This WRITE-side refusal is LOAD-BEARING, not merely defence-in-depth:
        // isaac's cache read runs PRE-ROUTING (server.isaac.js ~:2150 — it keys off
        // the raw request.url with no request.routing in scope, measured), so that
        // read CANNOT be guarded on the flag. Never writing the entry is what keeps
        // the isaac path correct; the express-side read guard is the belt.
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
                return throwError(res, 500, new Error('cache.invalidateOn must be an array'));
            }
            // Placing event listeners. Awaited: setEvents also persists the events into
            // the `fs` sidecar, so a restart's disk read-back can restore them.
            await renderCache.setEvents(cacheKey, cachingOption.invalidateOnEvents);
        }

    }
}
/**
 * Render HTML templates : Swig is the default template engine
 *
 *  Extend default filters
 *  - length
 *
 * Available filters:
 *  - getWebroot()
 *  - getUrl()
 *
 *  N.B.: Filters can be extended through your `<project>/src/<bundle>/templates/swig/filters.js`
 *
 *
 * @param {object}   userData              - Data merged into the template context
 * @param {boolean}  [displayInspector]    - Show the Gina dev inspector when `true`
 * @param {object}   [errOptions]          - Override `local.options` when rendering a custom error page
 * @param {object}   deps                  - Inherited refs from SuperController
 * @param {object}   deps.self             - The SuperController instance
 * @param {object}   deps.local            - Per-request closure (`req`, `res`, `next`, `options`)
 * @param {function} deps.getData          - Returns the merged template data object
 * @param {function} deps.hasViews         - Returns `true` when the route has a template configured
 * @param {function} deps.setResources     - Injects CSS/JS resource tags into the template data
 * @param {object}   deps.swig             - Swig template engine instance
 * @param {object}   deps.SwigFilters      - Custom Swig filter registry
 * @param {function} deps.headersSent      - Returns `true` when response headers are already sent
 * @returns {Promise<void>}
 */
module.exports = async function render(userData, displayInspector, errOptions, deps) {

    // Inherited from controller.
    // #INS10 / #B61 race fix — EVERY per-request dep is FUNCTION-scoped (`var`):
    // render() is async, so a render suspended at an await must not have its
    // captures overwritten by a concurrent render. #INS10 (8674c514) scoped
    // `self` / `local` for the post-await Inspector emit; #B61 completes the
    // sweep — getData / setResources were still module-scoped yet are read
    // AFTER the template-read await (the setResources call and the
    // `merge(data, getData())` restore further down), so a concurrent render's
    // reassignment executed the OTHER request's closures and gap-filled its
    // page data into this render. cachePath is likewise read post-await on the
    // layout-cache path, and the engine ref was assigned as an implicit global.
    var self            = deps.self;
    var local           = deps.local;
    var getData         = deps.getData;
    var hasViews        = deps.hasViews;
    var setResources    = deps.setResources;
    // Default filters
    var swig            = deps.swig;
    var SwigFilters     = deps.SwigFilters;
    var headersSent     = deps.headersSent;
    // Assigned on the layout-cache path once localOptions is resolved; read
    // post-await there (.gitignore drop + the {% extends %} rewrite).
    var cachePath       = null;
    // Function-scoped captures of per-request refs. The exported render()
    // is async with multiple await boundaries (template + layout reads,
    // cache writes). Between yields, `local.req` / `local.res` / `local.next`
    // can be nulled by another path on the same controller — most commonly
    // throwError's generic-error fallthrough that runs when a second
    // throwError fires after renderCustomError already started this render
    // (see controller.js: the fallthrough ends the response and nulls the
    // closure refs while we are suspended at await). Capturing into
    // function-scoped locals isolates this render from that null-out so
    // post-await reads do not dereference null. Terminal exits still null
    // `local.req` / `local.res` / `local.next` on the closure to release
    // per-request memory.
    var req         = local.req;
    var res         = local.res;
    var _next       = local.next;

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

    // #H10 — opt-in HTTP/2 response trailers (registered via self.sendTrailers()).
    var _trailers   = (local._trailers && typeof(local._trailers) === 'object') ? local._trailers : null;
    // #HDR5 — per-request CSP nonce (set on req by gina.plugins.Csp({useNonce:true})).
    // When present, every framework-injected inline <script> carries a matching
    // nonce="..." attribute so a bundle can drop 'unsafe-inline' from script-src.
    var _cspNonce   = (req && req._ginaCspNonce) ? req._ginaCspNonce : null;
    // Stamp the onGinaLoaded bootstrap <script> with a RENDER-TIME nonce template
    // (#B130). The loader tag flows into the swig-compiled layout, and the compiled
    // template is CACHED per view on serverInstance._cached — so a literal nonce
    // here would be frozen at first compile while the Csp middleware mints a fresh
    // one per request (header != markup on every later request for the view).
    // Injecting swig tags instead keeps the cached artifact nonce-agnostic: the
    // conditional re-evaluates on every compiledTemplate(data) execute against
    // data.page.cspNonce, which BOTH the cache-hit and compile branches assign
    // pre-execute. The loader tag itself is a cached, immutable string (config.js
    // builds it once) — .replace() returns a fresh string and never mutates the
    // shared cache. No-op when no nonce is set (non-CSP deployments bake the
    // plain tag, byte-identical to before).
    var _nonceLoader = function (loaderTag) {
        if (_cspNonce && typeof loaderTag === 'string') {
            return loaderTag.replace(
                '<script type="text/javascript">',
                '<script type="text/javascript"{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}>'
            );
        }
        return loaderTag;
    };
    // #HDR5 — nonce attribute fragment for POST-EXECUTE inline-<script> injections
    // (release banner, cache-patch scripts): those splice into htmlContent after
    // compiledTemplate(data) ran, so the literal per-request value is correct.
    // '' when no nonce is set.
    var _cspNonceAttr = _cspNonce ? (' nonce="' + _cspNonce + '"') : '';
    // #B130 — TEMPLATE form of the same attr for inline <script>s that are baked
    // into the swig-compiled layout PRE-compile (the dev Inspector __ginaData /
    // __ginaLogs pair): the compiled template is cached per view, so a literal
    // value would freeze at first compile. The swig conditional re-evaluates per
    // execute — the same mechanism the statusbar include already uses.
    var _cspNonceTplAttr = _cspNonce ? '{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}' : '';
    // Using server cache to cache compiledTemplates
    cache.from(self.serverInstance._cached);
    // Output/render cache goes through the strategy dispatcher (same shared store).
    renderCache.from(self.serverInstance._cached);

    // #TPL2 — cachePath (the layout-cache root) is derived IN-ROOT below, once
    // localOptions is resolved; see the assignment before the layout-cache prime.
    // Was: self.serverInstance._cachePath (a sibling, out-of-root tree).

    var err = null;
    // localOptions must be resolved before the isRenderingCustomError check below
    // because renderCustomError() sets the flag on local.options, not on userData.
    var localOptions = (errOptions) ? errOptions : local.options;
    // isRenderingCustomError is true when either:
    // - userData carries the flag (legacy path via throwError pass-through)
    // - local.options / errOptions carries it (set by renderCustomError at controller.js)
    var isRenderingCustomError = (
                                (typeof(userData) != 'undefined' && userData !== null
                                    && typeof(userData.isRenderingCustomError) != 'undefined'
                                    && String(userData.isRenderingCustomError).toLowerCase() === 'true')
                                || localOptions.isRenderingCustomError === true
                            ) ? true : false;
    if (isRenderingCustomError && userData && typeof(userData.isRenderingCustomError) != 'undefined')
        delete userData.isRenderingCustomError;

    localOptions.renderingStack.push( self.name );
    // preventing multiple call of self.render() when controller is rendering from another required controller
    if ( localOptions.renderingStack.length > 1 && !isRenderingCustomError ) {
        return false;
    }


    var data                = null
        , layout            = null
        , newLayoutFilename = null
        , layoutCacheFailed = false
        // fd removed: no longer needed after async I/O conversion (#P31)
        , buffer            = null
        , compiledTemplate  = null
        , template          = null
        , file              = null
        , path              = null
        , htmlContent       = null
        , cacheKey          = null
        , cacheObject       = null
        // #B495 — the assembled http/2 `link` preload header, built on the compile
        // path and memoised on the compiled-template cache entry for the hit path
        , _h2PreloadLinks   = null
        , plugin            = null
        // By default
        , isWithoutLayout   = (localOptions.isWithoutLayout) ? true : false
        // #SPA1 fragment-parent roster — populated only for a layoutless render
        // of an extends template (derived in the extends block, composed into
        // the fragments/ cache parent at the priming + post-asset writes).
        , fragmentBlockRoster = null
        , stream            = null
    ;

    if ( typeof(res.stream) != 'undefined') {
        stream = res.stream
    }

    try {
        data = getData();
        // Display session
        if (
            typeof(req.session) != 'undefined'
        ) {
            if ( typeof(data.page.data) == 'undefined' ) {
                data.page.data = {};
            }

            // A browser-session cookie has no expiry: _expires is null after a
            // store round-trip. `typeof null === 'object'` slipped past the old
            // `!= 'undefined'` guard, then null.format() threw (HTTP 500). This
            // block needs a real Date (date subtraction + .format), so gate on that.
            if ( req.session.cookie._expires instanceof Date ) {
                var dateEnd = req.session.cookie._expires;
                var dateStart = ( typeof(req.session.lastModified) != 'undefined')
                                ? new Date(req.session.lastModified)
                                : new Date()
                ;
                var elapsed = dateEnd - dateStart;
                // var expiresAt =
                if ( typeof(data.page.data.session) == 'undefined' ) {
                    data.page.data.session = {
                        id          : req.session.id,
                        lastModified: req.session.lastModified
                    };
                }
                // In milliseconds
                data.page.data.session.createdAt    = req.session.createdAt;
                data.page.data.session.expiresAt    = dateEnd.format('isoDateTime');
                data.page.data.session.timeout      = elapsed;

                dateEnd     = null;
                dateStart   = null;
                elapsed     = null;
            }
        }

        // in case `req.routing.param.file` has been changed on the fly
        if (
            req.routing.param.file
            && req.routing.param.file != data.page.view.file
        ) {
            data.page.view.file = req.routing.param.file;
        }
        if (
            req.routing.param.ext
            && req.routing.param.ext != data.page.view.ext
        ) {
            data.page.view.ext = req.routing.param.ext;
        }
        file = (isRenderingCustomError) ? localOptions.file : data.page.view.file;
        // making path thru [namespace &] file
        // #27 — self.setTemplate(file, ext) override wins and fully replaces
        // the path with NO namespace prefixing (mirrors render-nunjucks
        // resolveTemplatePath), so a catch-all dispatcher can target any
        // template under the templates root. Skipped during custom-error
        // rendering, which renders the framework error template instead.
        if ( !isRenderingCustomError && localOptions._templateOverride && typeof(localOptions._templateOverride.file) === 'string' && localOptions._templateOverride.file ) {
            file = data.page.view.file = localOptions._templateOverride.file;
            if ( typeof(localOptions._templateOverride.ext) === 'string' && localOptions._templateOverride.ext ) {
                data.page.view.ext = localOptions._templateOverride.ext;
            }
            path = _(localOptions.template.html + '/' + file);
        } else if ( typeof(localOptions.namespace) != 'undefined' && localOptions.namespace ) {
            // excepted for custom paths
            var fileNamingConvention = file.replace(localOptions.namespace+'-', '');
            // replaced: !/^(\.|\/|\\)/.test(file) → charAt(0) checks (#P9)
            if ( file.charAt(0) !== '.' && file.charAt(0) !== '/' && file.charAt(0) !== '\\' && file != fileNamingConvention ) {
                var _ext = data.page.view.ext;

                console.warn('file `'+ file +'` used in routing `'+ localOptions.rule +'` does not respect gina naming convention ! You should rename the file `'+ file + _ext +'` to `'+ ''+ fileNamingConvention + _ext +'`');
                console.warn('The reason you are getting this message is because your filename begins with `<namespace>-`\n If you don\‘t want to rename, use template path like ./../'+ localOptions.namespace +'/'+file);
                file = ''+ file.replace(localOptions.namespace+'-', '');
            }
            fileNamingConvention = null;
            _ext = null;


            // means that rule name === namespace -> pointing to root namespace dir
            if (!file || file === localOptions.namespace) {
                file = 'index'
            }
            path = (isRenderingCustomError) ? _(file) : _(localOptions.template.html +'/'+ localOptions.namespace + '/' + file)
        } else {
            if ( localOptions.path && !/(\?|\#)/.test(localOptions.path) ) {
                path = _(localOptions.path);
                // replaced: new RegExp(ext+'$') — use endsWith + slice instead (#P1)
                var _ext = data.page.view.ext;
                if ( _ext && data.page.view.file.endsWith(_ext) ) {
                    data.page.view.path = path.replace('/'+ data.page.view.file, '');

                    path            = path.slice(0, -_ext.length);
                    data.page.view.file  = data.page.view.file.slice(0, -_ext.length);

                } else {
                    data.page.view.path = path.replace('/'+ data.page.view.file, '');
                }
                _ext = null;
            } else {
                    // [CVE-2023-25345] When file starts with . / or \, it was used as-is,
                    // bypassing the template root entirely and allowing traversal to arbitrary
                    // filesystem locations (e.g. file = "../../etc/passwd").
                    // We now validate that any such path resolves within the template root.
                    // path = (!isRenderingCustomError && !/^(\.|\/|\\)/.test(file)) // replaced: CVE-2023-25345
                    //     ? _(localOptions.template.html +'/'+ file)
                    //     : file
                    // replaced: /^(\.|\/|\\)/.test(file) → charAt(0) checks (#P9)
                    if ( (file.charAt(0) === '.' || file.charAt(0) === '/' || file.charAt(0) === '\\') && !isRenderingCustomError ) {
                        var _fileTemplateRoot    = nodePath.resolve(localOptions.template.html);
                        var _fileResolvedPath    = nodePath.resolve(_fileTemplateRoot, file);
                        if ( !_fileResolvedPath.startsWith(_fileTemplateRoot + '/') ) {
                            throw new Error('[CVE-2023-25345] Path traversal attempt blocked: ' + file);
                        }
                        _fileTemplateRoot = null;
                        _fileResolvedPath = null;
                    }
                    // [/CVE-2023-25345]
                    // replaced: !/^(\.|\/|\\)/.test(file) → charAt(0) checks (#P9)
                    path = (!isRenderingCustomError && file.charAt(0) !== '.' && file.charAt(0) !== '/' && file.charAt(0) !== '\\')
                        ? _(localOptions.template.html +'/'+ file)
                        : file
            }
        }

        // replaced: new RegExp(ext+'$') — use endsWith instead (#P2)
        if (data.page.view.ext && !file.endsWith(data.page.view.ext) ) {
            path += data.page.view.ext
        }

        data.page.view.path = path;
    } catch (dataErr) {
        return self.throwError(dataErr);
    }

    // isWithoutLayout from content
    var pageContentObj  = new _(data.page.view.path);
    var _templateContent = null;
    try {
        // replaced: fs.readFileSync — async read (#P28)
        _templateContent = (await fs.promises.readFile(path)).toString()
    } catch (pathException) {
            console.warn("Path exception: ", pathException);
    }
    var hasLayoutInPath = /\{\%(\s+extends|extends)/.test(_templateContent) || false;
    var layoutPath      = null;
    var subFolder       = path.split(/\//g).slice(0, -1).join('/').replace(localOptions.template.html, '') || '';
    var hasSubFolder    = (subFolder && subFolder != '') ? true : false;

    // #TPL2 — the processed-layout cache lives IN-ROOT, under the bundle templates
    // root, so the {% extends %} rewrite below resolves inside the swig loader's
    // basepath and swig-core's confinement (CVE-2023-25345) accepts it without an
    // allowOutsideRoot opt-out. The leading-dot dir rides gina's existing
    // dotfile-skip convention (the public/errors/forms scans in config.js), so the
    // cache is never served as a static asset nor enumerated by template discovery.
    // localOptions (not local.options) so the custom-error render path caches under
    // its own template root.
    cachePath = localOptions.template.html + '/.gina-layout-cache';

    if (
        !isWithoutLayout
        && !isRenderingCustomError
        && pageContentObj.existsSync()
        && !hasLayoutInPath
    ) {
        isWithoutLayout = true;
    }
    pageContentObj = null;

    // #SPA1 — the compiled-template cache is shape-dimensioned: a layoutless
    // (fragment) compile of an extends template resolves against a block-roster
    // parent instead of the real layout, so the two shapes must never share a
    // slot (first-shape-wins collision otherwise). isWithoutLayout is final
    // here: the implicit extends-less auto-set runs above, and the later
    // layout-not-found fallbacks only fire for templates that never reach this
    // cache (its write requires an extends directive).
    cacheKey = 'swig:' + localOptions.bundle + subFolder +'/'+ data.page.view.file + ( (isWithoutLayout) ? ':fragment' : '' );
    // Retrieve layoutPath from content
    if (
        hasLayoutInPath
        && _templateContent
        && !cache.has(cacheKey)
    ) {

        // subFolder       = path.split(/\//g).slice(0, -1).join('/').replace(localOptions.template.html, '');
        // hasSubFolder    = (subFolder) ? true : false;
        // #B484 - the quantifier is lazy on purpose: a greedy span runs to the
        // LAST closing tag delimiter on the line, so a one-line extends directive
        // followed by another quoted tag swallowed them both and the path
        // extraction below then returned a corrupted, unmatchable path.
        var extendFound = _templateContent.match(/\{\%(\s+extends|extends)(.*?)\%}/);
        if (extendFound && Array.isArray(extendFound)) {
            try {
                // localOptions.template.templates +'/'+
                layoutPath = extendFound[0].match(/(\"|\')(.*?)(\"|\')/)[0].replace(/(\"|\')/g, '');

                // adding layout
                // #SPA1 — a layoutless (fragment) render of an extends template
                // must NOT target the shared full-page cached layout: the
                // post-asset persist below stores THIS render's assembled
                // `layout`, which for a fragment is the (empty) nolayout shell —
                // written over the shared file it blanks the parent every
                // full-page render compiles from, so child blocks extend a
                // block-less parent and are discarded. Fragments get their own
                // `fragments/` namespace, primed from the child's OWN block
                // roster so its blocks keep placeholders to fill.
                if ( isWithoutLayout ) {
                    var _fragBlockRe    = /\{\%-?\s*block\s+([A-Za-z0-9_-]+)/g;
                    var _fragBlockNames = [];
                    var _fragMatch      = null;
                    while ( (_fragMatch = _fragBlockRe.exec(_templateContent)) !== null ) {
                        if ( _fragBlockNames.indexOf(_fragMatch[1]) < 0 ) {
                            _fragBlockNames.push(_fragMatch[1]);
                        }
                    }
                    var _fragLines = [];
                    for (var _fragI = 0, _fragLen = _fragBlockNames.length; _fragI < _fragLen; ++_fragI) {
                        _fragLines.push('{% block '+ _fragBlockNames[_fragI] +' %}{% endblock %}');
                    }
                    fragmentBlockRoster = _fragLines.join('\n');
                    _fragBlockRe = null; _fragBlockNames = null; _fragMatch = null; _fragLines = null;
                }
                var newLayoutPath = 'swig' + subFolder + ( (isWithoutLayout) ? '/fragments/' : '/' ) + layoutPath;
                newLayoutFilename = _(cachePath +'/'+ localOptions.bundle +'/'+ newLayoutPath, true);

                // In dev/cacheless mode we always refresh the cached layout;
                // in cached mode we only write when it is missing. Previously
                // the dev branch did rmSync()+writeFile(), opening a gap window
                // where a concurrent request could observe the file as absent
                // between two parallel renders and ENOENT at the readFile call
                // ~340 lines below. The atomic temp+rename pattern below closes
                // that window: the target is always either the previous
                // content or the new content, never absent.
                var shouldWriteLayoutCache = (
                    String(self.serverInstance._cacheIsEnabled).toLowerCase() !== 'true'
                    || !fs.existsSync( newLayoutFilename )
                );

                if ( shouldWriteLayoutCache ) {
                    var newLayoutDir = newLayoutFilename.split(/\//g).slice(0, -1).join('/');
                    var newLayoutDirObj = new _(newLayoutDir);
                    if ( !newLayoutDirObj.existsSync() ) {
                        newLayoutDirObj.mkdirSync()
                    }
                    newLayoutDirObj = null;
                    // #TPL2 — keep the in-root layout cache out of a bundle's git:
                    // drop a self-ignoring .gitignore ('*') at the cache root so the
                    // .gina-layout-cache tree never surfaces as untracked in a
                    // consumer repo (the old out-of-root cache lived under the
                    // project `cache/` dir consumers already ignore). Written once,
                    // existsSync-guarded; best-effort.
                    var _cacheIgnore = cachePath + '/.gitignore';
                    if ( !fs.existsSync(_cacheIgnore) ) {
                        try { fs.writeFileSync(_cacheIgnore, '*\n'); } catch (_giErr) { /* best effort */ }
                    }
                    // [CVE-2023-25345] The layoutPath is extracted from the raw {% extends "..." %}
                    // directive in the template file. Without a boundary check, a template containing
                    // {% extends "../../../etc/passwd" %} would cause readFileSync to read arbitrary
                    // files outside the template root (directory traversal / arbitrary file read).
                    // We resolve the path and confirm it stays within localOptions.template.html.
                    // Boundary check now runs BEFORE any file operation (was after openSync previously).
                    var _layoutTemplateRoot     = nodePath.resolve(localOptions.template.html);
                    var _layoutResolvedPath     = nodePath.resolve(_layoutTemplateRoot, layoutPath);
                    if ( !_layoutResolvedPath.startsWith(_layoutTemplateRoot + '/') ) {
                        throw new Error('[CVE-2023-25345] Path traversal attempt blocked in {% extends %}: ' + layoutPath);
                    }
                    _layoutTemplateRoot = null;
                    _layoutResolvedPath = null;
                    // [/CVE-2023-25345]

                    // replaced: openSync/readFileSync/writeSync/closeSync — async read + write (#P29, #P31)
                    // buffer = Buffer.from( fs.readFileSync(localOptions.template.html + '/'+ layoutPath) ); // replaced: CVE-2023-25345
                    // #SPA1 — the fragments/ parent primes from the child's block
                    // roster, never from the original layout file (the roster is
                    // what lets the child's blocks render; the shell tail is
                    // appended by the post-asset persist further below).
                    if ( isWithoutLayout && fragmentBlockRoster !== null ) {
                        buffer = fragmentBlockRoster;
                    }
                    else {
                        buffer = await fs.promises.readFile(localOptions.template.html + '/'+ layoutPath);
                    }
                    // Atomic write: temp file + rename. rename(2) on POSIX is
                    // atomic on the same filesystem, so concurrent readers at
                    // the post-priming readFile below never see the target
                    // absent.
                    var _layoutTmp = newLayoutFilename + '.tmp.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2);
                    await fs.promises.writeFile(_layoutTmp, buffer);
                    await fs.promises.rename(_layoutTmp, newLayoutFilename);
                    _layoutTmp = null;
                    buffer = null;
                }

                // updating extends - #B482: confined to the matched directive; a bare
                // search over the whole template let the first hit anywhere win, so a
                // child naming its layout in a leading comment had the COMMENT rewritten
                // while the directive kept pointing at the raw, un-assembled layout.
                _templateContent = spliceExtendsTarget(_templateContent, extendFound, layoutPath, _(cachePath +'/'+ localOptions.bundle +'/'+ newLayoutPath, true) );

                // override layout path
                layoutPath = newLayoutPath;

                data.page.view.layout = layoutPath;
                layoutPath = cachePath +'/'+ localOptions.bundle +'/'+ layoutPath;

                localOptions.template.layout = layoutPath;

            } catch (extendErr) {
                // Layout cache setup failed (e.g. EACCES on cache dir).
                // Clear newLayoutFilename so line 1076 does not attempt to write
                // to a directory that was never created, which would produce a
                // misleading ENOENT 500. Rendering continues from the original
                // configured layout path via localOptions.template.layout.
                // layoutCacheFailed suppresses both the swig template cache and
                // writeCache so the warning repeats on every request until fixed.
                newLayoutFilename = null;
                layoutCacheFailed = true;
                console.warn('[render] Layout cache setup failed: ' + (extendErr.stack||extendErr.message||extendErr));
            }
        }
        extendFound = null;
    }

    localOptions.debugMode = ( typeof(displayInspector) == 'undefined' ) ? undefined : ( (/true/i.test(displayInspector)) ? true : false ); // only active for dev env

    // specific override
    if (
        self.isCacheless()
        && typeof(req[ req.method.toLowerCase() ]) != 'undefined'
        && typeof(req[ req.method.toLowerCase() ].debug) != 'undefined'
    ) {
        // replaced: /^(true|false)$/i.test() — use string comparison (#P6)
        var _debugVal = String(req[ req.method.toLowerCase() ].debug).toLowerCase();
        if ( _debugVal !== 'true' && _debugVal !== 'false' ) {
            console.warn('Detected wrong value for `debug`: '+ req[ req.method.toLowerCase() ].debug);
            console.warn('Switching `debug` to `true` as `cacheless` mode is enabled');
            req[ req.method.toLowerCase() ].debug = true;
            _debugVal = 'true';
        }
        localOptions.debugMode = _debugVal === 'true';
    } else if (
        self.isCacheless()
        && hasViews()
        && !isWithoutLayout
        && localOptions.debugMode == undefined
    ) {
        localOptions.debugMode = true;
    } else if ( localOptions.debugMode == undefined  ) {
        localOptions.debugMode = self.isCacheless()
    }

    // #B464 — decide the Inspector injection ONCE per request. The compile
    // branch reads it to assemble the pre-compile plugin (the data MARKER
    // included); BOTH cache paths read it post-execute to turn that marker
    // into this request's data script — or into nothing (a persisted layout
    // carries the marker for every later request of every view, wanted or
    // not). The predicate is the compile branch's, verbatim.
    var _inspectorWanted = (
        hasViews() && self.isCacheless() && !isWithoutLayout
        && localOptions.debugMode
        ||
        hasViews() && self.isCacheless() && !isWithoutLayout
        && typeof(localOptions.debugMode) == 'undefined'
        ||
        hasViews() && localOptions.debugMode
    ) ? true : false;
    // #B464 — the two XHR hidden inputs used to be spliced into the layout
    // under these two gates (the debug branch of the compile block and its
    // cacheless-XHR sibling); they are now spliced into the executed HTML on
    // both cache paths under the same gates, so a request's data is never
    // part of the compiled template or the persisted layout-cache file.
    var _xhrInputsWanted = self.isXMLRequest() && (
        _inspectorWanted && localOptions.debugMode
        ||
        !_inspectorWanted && hasViews() && self.isCacheless()
    ) ? true : false;

    try {

        if (!userData) {
            userData = { page: { view: {}}}
        } else if ( isWithoutLayout ) {
            // Layoutless renders (self.renderWithoutLayout) have no page envelope
            // — no `view.layout`, no breadcrumb, no session card. Expose the
            // controller's userData two ways so both fragment-template idioms work:
            //   (1) at top level, so bare `{{ var }}` references resolve; and
            //   (2) under `page.data`, so templates using `{% set data = page.data %}`
            //       / `data.X` (the layoutless contract popins rely on) keep working.
            // The page.data copy MUST run BEFORE the top-level merge below: while
            // userData still has no `page` key and `data` is the distinct page
            // envelope, the per-key copy creates only shared leaf refs. Running it
            // AFTER `data = merge(userData, data)` (where `merge` returns its first
            // arg, so `data === userData`) would make `data.page.data` alias `data`
            // — a circular ref that throws in the layoutless XHR-data `JSON.stringify`.
            // Mirrors the render-nunjucks userData stash; additive (page.data already
            // carried these keys before the top-level-only change).
            if ( !isRenderingCustomError && userData && !userData['page'] ) {
                if ( typeof(data['page']) == 'undefined' ) { data['page'] = {}; }
                if ( typeof(data['page']['data']) == 'undefined' ) { data['page']['data'] = {}; }
                for ( var _udk in userData ) {
                    if ( Object.prototype.hasOwnProperty.call(userData, _udk) ) {
                        data['page']['data'][_udk] = userData[_udk];
                    }
                }
            }
            data = (isRenderingCustomError) ? userData : merge(userData, data)
        } else if ( userData && !userData['page']) {

            if ( typeof(data['page']['data']) == 'undefined' )
                data['page']['data'] = userData;
            else
                data['page']['data'] = (isRenderingCustomError) ? userData : merge( userData, data['page']['data'] );
        } else {
            data = (isRenderingCustomError) ? userData : merge(userData, data)
        }

        template = localOptions.rule.replace('\@'+ localOptions.bundle, '');
        var localTemplateConf = localOptions.template;
        if ( isWithoutLayout ) {
            localTemplateConf = JSON.clone(localOptions.template);
            localTemplateConf.javascripts = new Collection(localTemplateConf.javascripts).find({ isCommon: false}, { isCommon: true, name: 'gina' });
            localTemplateConf.stylesheets = new Collection(localTemplateConf.stylesheets).find({ isCommon: false}, { isCommon: true, name: 'gina' });
        }
        setResources(localTemplateConf);

        // Allowing file & ext override
        if (
            typeof(req.routing.param.file) != 'undefined'
            && data.page.view.file !== req.routing.param.file
        ) {
            data.page.view.file = localOptions.file = req.routing.param.file
        }
        if (
            typeof(req.routing.param.ext) != 'undefined'
            && data.page.view.ext !== req.routing.param.ext
        ) {
            data.page.view.ext = localOptions.template.ext = req.routing.param.ext
        }


        // pre-compiling variables
        data = merge(data, getData()); // needed !!

        if  (typeof(data.page.data) == 'undefined' ) {
            data.page.data = {}
        }


        if (
            !localOptions.isRenderingCustomError
            && typeof(data.page.data.status) != 'undefined'
            && !String(data.page.data.status).startsWith('2')
            && typeof(data.page.data.error) != 'undefined'
        ) {

            // Normalize error/message to strings — upstream may send objects (e.g. ApiError
            // instances or plain {message, code} objects). Without normalization the error
            // page renders "[object Object]" as the title. (#Q2)
            var _errDetail = data.page.data.error || data.page.data.message;
            if ( _errDetail && typeof(_errDetail) === 'object' ) {
                _errDetail = _errDetail.message || _errDetail.error || JSON.stringify(_errDetail);
            }
            var _msgDetail = data.page.data.message;
            if ( _msgDetail && typeof(_msgDetail) === 'object' ) {
                _msgDetail = _msgDetail.message || _msgDetail.error || JSON.stringify(_msgDetail);
            }

            var errorObject = {
                status  : data.page.data.status,
                // replaced: statusCodes[data.page.data.status] first — always truthy for known
                // codes, so the actual upstream error reason was always buried. Prioritize the actual
                // error/message from the upstream response; fall back to generic status label. (#Q1)
                // Normalized to string before use — upstream objects would otherwise render as
                // "[object Object]". (#Q2)
                error   : _errDetail || _msgDetail || statusCodes[data.page.data.status] || msg,
                message : _msgDetail || _errDetail,
                stack   : data.page.data.stack
            };
            if ( typeof(data.page.data.session) != 'undefined' ) {
                errorObject.session = data.page.data.session;
            }
            // Log before throwError so the actual error reason appears in the bundle log
            // — throwError may only surface the generic status label otherwise. (#Q1)
            console.error(
                '[render] '+ data.page.data.status +' from upstream'
                + ( _errDetail ? ' — ' + _errDetail : '' )
                + ( data.page.data.stack ? '\n' + data.page.data.stack : '' )
            );

            return self.throwError(errorObject);
        }


        // data.page.view.path = path;

        var dic = {}, msg = '';
        for (let d in data.page) {
            dic['page.'+d] = data.page[d]
        }
        // Flatten page.environment so whisper() can resolve {{ page.environment.key }}
        // placeholders in ginaLoader (gina.onload.min.js), which is inserted after Swig
        // compilation and therefore cannot rely on Swig to substitute these tokens.
        if (typeof data.page.environment === 'object' && data.page.environment !== null) {
            for (let k in data.page.environment) {
                dic['page.environment.' + k] = data.page.environment[k];
            }
        }



        // please, do not start with a slashe when including...
        // ex.:
        //      /inc/_partial.html (BAD)
        //      inc/_partial.html (GOOD)
        //      ./namespace/page.html (GOOD)

        if ( !fs.existsSync(path) ) {
            if (isRenderingCustomError) {
                // #B191 — never dump a routing rule while rendering a CUSTOM
                // ERROR page: the rule in scope is the failing route's (or
                // the injected error route's), correct by construction, and
                // the generic diagnostic below misdirected operators toward
                // editing valid configuration. Name the template that failed
                // and hand off to throwError — its re-entry guard serves the
                // built-in error page without looping through this branch.
                msg = 'could not open the custom error template "'+ path +'"'
                    + ' — falling back to the built-in error page.';
                err = new ApiError(msg, 500);
                console.error(err.stack);
                self.throwError(err);
                return;
            }
            msg = 'could not open "'+ path +'"' +
                        '\n1) The requested file does not exists in your templates/html (check your template directory). Can you find: '+path +
                        '\n2) Check the following rule in your `'+localOptions.conf.bundlePath+'/config/routing.json` and look around `param` to make sure that nothing is wrong with your file declaration: '+
                        '\n' + localOptions.rule +':'+ JSON.stringify(localOptions.conf.content.routing[localOptions.rule], null, 4) +
                        '\n3) At this point, if you still have problems trying to run this portion of code, you can contact us telling us how to reproduce the bug.'
                        //'\n\r[ stack trace ] '
                        ;
            err = new ApiError(msg, 500);
            console.error(err.stack);
            self.throwError(err);
            return;
        }

        var localRequestPort = req.headers.port || req.headers[':port'];
        var isProxyHost = (
            typeof(req.headers.host) != 'undefined'
            && typeof(localRequestPort) != 'undefined'
            &&  (localRequestPort === '80' || localRequestPort === '443' || localRequestPort === 80 || localRequestPort === 443)
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
            typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
        ) ? true : false;


        // Setup swig default filters
        // #P39 — `options` is passed by REFERENCE. The former per-render deep
        // copy here was one of the two heaviest CPU sites in the whole render
        // path (the payload carries the all-bundle routing tables, the full
        // templates conf, settings, forms and locales), and it bought nothing:
        // SwigFilters' `_options` write-set is empty beyond the stash itself —
        // every filter only READS it — and the request path already shares
        // `conf.routing` / `conf.reverseRouting` / `conf.forms` by reference
        // (setOptions grafts the shared per-worker objects), so the filters see
        // the same objects the controller itself uses. The stash-then-await
        // interleave window is unchanged: with the copy, an interleaved render
        // overwrote the singleton with ITS copy; by reference it overwrites it
        // with ITS options — same wrongness class, zero new exposure.
        var filters = SwigFilters({
            options     : localOptions,
            isProxyHost : isProxyHost,
            throwError  : self.throwError,
            req         : req,
            res         : res
        });
        try {

            // To extends default filters with user defined filters, go to controllers/setup.js

            // Allows you to get a bundle web root
            // e.g.: swig.setFilter('getWebroot', filters.getWebroot);
            // e.g.: swig.setFilter('nl2br', filters.nl2br);
            for (let filter in filters) {
                // replaced: !/^getConfig$/.test() — use !== instead (#P11)
                if ( typeof(filters[filter]) == 'function' && filter !== 'getConfig' ) {
                    swig.setFilter(filter, filters[filter]);
                }
            }
        } catch (err) {
            self.throwError(res, 500, new Error('[SwigFilters] template filters setup exception encoutered: [ '+path+' ]\n'+(err.stack||err.message)));
            return;
        }


        var  assets                 = null
            , mapping               = null
            , isDeferModeEnabled    = null
            , hasExternalsPlugins    = null
            , viewInfos             = null
            , filename              = null
            , isWithSwigLayout      = null
            , isUsingGinaLayout     = (!isWithoutLayout && typeof(localOptions.template.layout) != 'undefined' && fs.existsSync(localOptions.template.layout)) ? true : false
        ;

        if ( isWithoutLayout || isUsingGinaLayout ) {
            layoutPath = (isWithoutLayout) ? localOptions.template.noLayout : localOptions.template.layout;
            // user layout override
            if ( isUsingGinaLayout && !isWithoutLayout ) {
                layoutPath = localOptions.template.layout;
            }
            if (isWithoutLayout) {
                data.page.view.layout = layoutPath;
            }
        }
        // without layout case
        else if (!hasLayoutInPath) {

            // by default
            layoutPath = localOptions.template.layout;
            // replaced: !/^\//.test() (#P8)
            if ( !layoutPath.startsWith('/')) {
                layoutPath = localOptions.template.templates +'/'+ layoutPath;
            }
            // default layout
            if (
                !isWithoutLayout  && !fs.existsSync(layoutPath) && layoutPath == localOptions.template.templates +'/index.html'
            ) {
                console.warn('Layout '+ localOptions.template.layout +' not found, replacing with `nolayout`: '+ localOptions.template.noLayout);
                layoutPath = localOptions.template.noLayout
                isWithoutLayout = true;
                data.page.view.layout = layoutPath;
            }
            // user defined layout
            else if ( !isWithoutLayout && !fs.existsSync(layoutPath) ) {
                isWithSwigLayout = true;
                layoutPath = localOptions.template.noLayout;
                data.page.view.layout = layoutPath;
            }
            // layout defiendd but not found
            else if (!fs.existsSync(layoutPath) ) {
                err = new ApiError(localOptions.bundle +' SuperController exception while trying to load your layout `'+ layoutPath +'`.\nIt seems like you have defined a layout, but gina could not locate the file.\nFor more informations, check your `config/templates.json` declaration around `'+ localOptions.rule.replace(/\@(.*)/g, '') +'`', 500);
                self.throwError(err);
                return;
            }
        }


        // errors first
        if (!headersSent()) {

            //catching errors
            res.statusCode = ( typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status])  != 'undefined' ) ? data.page.data.status : 200; // by default

            // HTTP/2 (RFC7540 8.1.2.4):
            // This standard for HTTP/2 explicitly states that status messages are not supported.
            // In HTTP/2, the status is conveyed solely by the numerical status code (e.g., 200, 404, 500),
            // and there is no field for a human-readable status message.
            if (
                typeof(data.page.data.errno) != 'undefined'
                    && String(data.page.data.status).startsWith('2')
                    && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
                    && !/http\/2/.test(localOptions.conf.server.protocol)
                ||
                typeof(data.page.data.status) != 'undefined'
                    && !String(data.page.data.status).startsWith('2')
                    && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
                    && !/http\/2/.test(localOptions.conf.server.protocol)
            ) {

                try {
                    res.statusMessage = localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status];
                } catch (err){
                    res.statusCode    = 500;
                    res.statusMessage = err.stack||err.message||localOptions.conf.server.coreConfiguration.statusCodes[res.statusCode];
                }
            }

            res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

            try {

                // escape special chars — uses module-level precompiled blacklistRe (#P3)
                // DO NOT REPLACE IT BY JSON.clone() !!!!
                blacklistRe.lastIndex = 0;
                data.page.data = JSON.parse(JSON.stringify(data.page.data).replace(blacklistRe, '\$&'));
            } catch (err) {
                filename = localOptions.template.html;
                // replaced: new RegExp('^' + namespace + '-') — use startsWith instead (#P2)
                filename += ( typeof(data.page.view.namespace) != 'undefined' && data.page.view.namespace != '' && data.page.view.file.startsWith(data.page.view.namespace + '-') ) ? '/' + data.page.view.namespace + data.page.view.file.split(data.page.view.namespace +'-').join('/') + ( (data.page.view.ext != '') ? data.page.view.ext: '' ) : '/' + data.page.view.file+ ( (data.page.view.ext != '') ? data.page.view.ext: '' );
                self.throwError(res, 500, new Error('Controller::render(...) compilation error encountered while trying to process template `'+ filename + '`\n' + (err.stack||err.message||err) ));
                filename = null;
                return;
            }
        }


        var isLoadingPartial = false;
        // #B490 — the Inspector's `view.assets` is the parsed http/2 preload map
        // that getAssets() leaves on localOptions.template.assets (per-template,
        // filled by the first compile-path request, so cache hits see it too).
        // Read at splice time: the http/2 block runs after the payload sites on
        // the hit path. Absent when the block never ran (http/1.1, XHR).
        var _inspectorAssetsMap = function() {
            return ( localOptions.template && localOptions.template.assets && typeof(localOptions.template.assets) == 'object' )
                ? localOptions.template.assets
                : undefined;
        };
        // replaced: fs.readFileSync — async read (#P29)
        layout = await fs.promises.readFile(layoutPath, 'utf8');
        // #B130 upgrade path — in cached mode the layout-cache file persists the
        // INJECTED layout (it is the {% extends %} target swig compiles from) and
        // is only re-primed when missing, so a file written by a pre-#B130 build
        // still carries the bootstrap loader (and, dev+cache, the Inspector
        // scripts) with a frozen LITERAL nonce baked in — and the injection
        // guards below skip re-injection because onGinaLoaded is already there.
        // Normalize those literals to the render-time conditional; anchored on
        // each script's own idiom (the loader's `<!--` wrapper from config.js,
        // the Inspector scripts' window.__gina* openers), idempotent (the
        // conditional form no longer matches), and persisted back by the
        // layout-cache write below, so this heals once per stale file.
        if ( /<script( type="text\/javascript")? nonce="/.test(layout) ) {
            layout = layout.replace(
                /<script type="text\/javascript" nonce="[^"]*">(\s*<!--)/g,
                '<script type="text/javascript"{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}>$1'
            );
            layout = layout.replace(
                /<script nonce="[^"]*">(window\.__gina(Data|Logs))/g,
                '<script{% if page.cspNonce %} nonce="{{ page.cspNonce }}"{% endif %}>$1'
            );
        }
        // #B464 upgrade path — a layout-cache file persisted by a pre-#B464
        // build carries the FIRST request's `window.__ginaData` script (and,
        // for an XHR render, its hidden inputs) verbatim, and cached mode
        // never re-primes an existing file. Rewrite the persisted script to
        // the marker the post-execute splice expects and drop the persisted
        // inputs; the layout-cache write further down persists the healed
        // text, so this heals once per stale file.
        layout = healPersistedInspectorData(layout);
        // Loading from cache
        if (
            String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'
            && cache.has(cacheKey)
        ) {
            compiledTemplate = cache.get(cacheKey).template;
            // #B495 — the entry carries what the compile path left behind: the
            // assembled `link` preload header (emitted below under the compile
            // path's own gates) and the parsed getAssets() map, restored onto this
            // request's template clone — the router clones options per request,
            // so the map a compile wrote to localOptions.template died with that
            // request and a hit resolved `view.assets` to nothing (#B490's hit-path
            // gap).
            var _swigEntry = cache.get(cacheKey);
            if ( localOptions.template && _swigEntry.assets && typeof(localOptions.template.assets) == 'undefined' ) {
                localOptions.template.assets = _swigEntry.assets;
            }

            // #FI — inject flow data before template execution on the cache-hit path.
            // The cached compiled template includes the __ginaData script (from the
            // miss-path toolbar injection), so data.page.flow must be populated before
            // compiledTemplate(data) for the Inspector to see timeline entries.
            if (local._timeline && local._timeline.entries.length > 0) {
                if (local._queryLog) {
                    for (var _cti = 0; _cti < local._queryLog.length; _cti++) {
                        var _cqe = local._queryLog[_cti];
                        if (_cqe._startMs) {
                            local._timeline.entries.push({
                                label: 'n1ql:' + (_cqe.trigger || 'query'),
                                cat: 'db',
                                startMs: _cqe._startMs,
                                endMs: _cqe._startMs + (_cqe.durationMs || 0),
                                durationMs: _cqe.durationMs || 0,
                                detail: (_cqe.statement || '').substring(0, 80)
                            });
                        }
                    }
                }
                data.page.flow = {
                    requestStart: local._timeline.requestStart,
                    entries: local._timeline.entries
                };
            }
            if (local._queryLog && local._queryLog.length > 0) {
                data.page.queries = local._queryLog;
            }
            // #AISTREAM — AI token-stream snapshot (rides the data.page clone into
            // __gdUser, like queries/flow); the live view rides inspector#token.
            if (local._aiLog && local._aiLog.length > 0) {
                data.page.aiStream = local._aiLog;
            }
            // #EVTBUS — observable application-event snapshot (rides the data.page
            // clone like queries/flow); the live view rides inspector#event.
            if (local._eventLog && local._eventLog.length > 0) {
                data.page.events = local._eventLog;
            }
            // #FI — snapshot count BEFORE late entries are pushed.
            // data.page.flow.entries is a reference to local._timeline.entries,
            // so reading .length later would include entries pushed after this point.
            var _cacheFlowSnapshot = (local._timeline) ? local._timeline.entries.length : 0;

            if ( !headersSent() ) {
                if ( localOptions.isRenderingCustomError ) {
                    localOptions.isRenderingCustomError = false;
                }

                // #FI — template execution timing (cache hit — no compile phase)
                var _cacheExecStart = (local._timeline) ? Date.now() : 0;
                // #HDR5 — {{ page.cspNonce }} app-template nonce helper. Absent when no nonce.
                if (_cspNonce) { data.page.cspNonce = _cspNonce; }
                htmlContent = compiledTemplate(data);
                // #B464 — the cached compiled template carries only a MARKER
                // where the Inspector data script used to be baked; swap it
                // for THIS request's script (or drop it), then splice the XHR
                // hidden inputs. The payload's snapshot count supersedes the
                // pre-execute one so the late-bind patch below appends only
                // the entries pushed after the payload was built.
                var _cacheInspSplice = spliceInspectorData(htmlContent, _inspectorWanted, data, _inspectorAssetsMap(), local, self, _cspNonceAttr);
                htmlContent = _cacheInspSplice.html;
                if ( _cacheInspSplice.flowSnapshotCount !== null ) {
                    _cacheFlowSnapshot = _cacheInspSplice.flowSnapshotCount;
                }
                if ( _xhrInputsWanted ) {
                    // #FI + #QI — inject flow and queries into data.page.data so the
                    // XHR hidden input carries them (the compile branch's injection
                    // never runs on a hit).
                    if (data.page.flow)    { data.page.data.flow    = data.page.flow; }
                    if (data.page.queries) { data.page.data.queries = data.page.queries; }
                    var _cacheViewInfos = JSON.clone(data.page.view);
                    if ( !isWithoutLayout ) {
                        _cacheViewInfos.assets = _inspectorAssetsMap();
                    }
                    htmlContent = spliceXhrInputs(htmlContent, data, _cacheViewInfos);
                }
                // #RWATCH S3 — stale-release banner before writeCache (rides cache
                // hit + miss); byte-inert unless local + !dev + releaseWatch.enabled.
                htmlContent = releaseBanner.maybeInject(htmlContent, localOptions.conf, _cspNonceAttr);
                if (_cacheExecStart && local._timeline) {
                    local._timeline.entries.push({
                        label: 'swig-execute', cat: 'template',
                        startMs: _cacheExecStart, endMs: Date.now(),
                        durationMs: Date.now() - _cacheExecStart,
                        detail: (data.page.view.file || null)
                    });
                }
                res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );
                // #B495 — the memoised preload header, under the compile path's gates
                if ( _swigEntry.h2Link && !self.isXMLRequest() && !self.isCacheless() ) {
                    res.setHeader('link', _swigEntry.h2Link);
                }

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
                        await writeCache(localOptions.bundle, localOptions.conf.server.cache, htmlContent, req, res, self.serverInstance._cacheIsEnabled, self.throwError);
                    } catch (cacheErr) {
                        // A cache-write failure must never break a render that already succeeded:
                        // unguarded, the rejection unwinds to render()'s function-level catch, which
                        // discards a good page and answers 500. Siblings already degrade this way
                        // (render-nunjucks.js try/catch, render-json.js .catch()).
                        try { console.error('[render-swig] writeCache failed: ' + (cacheErr.message || cacheErr)); } catch (e) {}
                    }
                }

                // Cache-Control: miss path — inform browsers/CDNs of the response lifetime (#C6)
                if ( typeof(req.routing.cache) != 'undefined' && req.routing.cache ) {
                    var _ccCfg = ( typeof(req.routing.cache) == 'string' ) ? { type: req.routing.cache } : req.routing.cache;
                    var _ccTtl = ( typeof(_ccCfg.ttl) != 'undefined' && _ccCfg.ttl > 0 ) ? _ccCfg.ttl : localOptions.conf.server.cache.ttl;
                    if ( _ccTtl > 0 ) {
                        res.setHeader('Cache-Control', ( _ccCfg.visibility === 'public' ? 'public' : 'private' ) + ', max-age=' + ~~(_ccTtl));
                    }
                }

                // #FI — response write + total timing (cache hit)
                if (local._timeline) {
                    var _cacheRespEnd = Date.now();
                    var _cacheRwStart = local._timeline._renderStart || local._timeline._actionStart || local._timeline.requestStart;
                    local._timeline.entries.push({
                        label: 'response-write', cat: 'response',
                        startMs: _cacheRwStart, endMs: _cacheRespEnd,
                        durationMs: _cacheRespEnd - _cacheRwStart,
                        detail: null
                    });
                    local._timeline.entries.push({
                        label: 'total', cat: 'total',
                        startMs: local._timeline.requestStart,
                        endMs: _cacheRespEnd,
                        durationMs: _cacheRespEnd - local._timeline.requestStart,
                        detail: null
                    });

                    // Patch late state into HTML — `__ginaData` was serialised
                    // (deep clone) before swig-compile, so anything that became
                    // known after that point needs a client-side late-bind:
                    //   • flow/execute/response/total entries appended to the
                    //     timeline AFTER `_cacheFlowSnapshot`
                    //   • `metrics.weightBytes` (only computable once
                    //     `htmlContent` is finalised) and the final
                    //     `metrics.serverMs` (includes the late `total` entry)
                    var _cacheLateEntries = local._timeline.entries.slice(_cacheFlowSnapshot);
                    if (displayInspector || self.isCacheless()) {
                        var _cacheWeightBytes = Buffer.byteLength(htmlContent, 'utf8');
                        var _cacheServerMsFinal = _cacheRespEnd - local._timeline.requestStart;
                        var _cacheFlowPatch = (_cacheLateEntries.length > 0)
                            ? 'if(u&&u.flow){var _e=u.flow.entries,_p=' + inlineScript.safeInlineJson(_cacheLateEntries) + ';for(var _i=0;_i<_p.length;_i++){_e.push(_p[_i])}}'
                            : '';
                        var _cachePatchScript = '<script' + _cspNonceAttr + '>(function(d){'
                            + 'var u=d&&d.user,g=d&&d.gina;'
                            + _cacheFlowPatch
                            + 'if(u&&u.environment&&u.environment.metrics){u.environment.metrics.weightBytes=' + _cacheWeightBytes + ';u.environment.metrics.serverMs=' + _cacheServerMsFinal + ';}'
                            + 'if(g&&g.environment&&g.environment.metrics){g.environment.metrics.weightBytes=' + _cacheWeightBytes + ';g.environment.metrics.serverMs=' + _cacheServerMsFinal + ';}'
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
                        htmlContent = htmlContent.replace(/<\/body>/i, function () { return _cachePatchScript + '</body>'; });
                    }
                }

                // #INS10 follow-up — prod-window HTML egress (cache-hit path).
                // Window-open AND not-dev: mutually exclusive with the dev-only
                // __ginaData injection block above (which requires isCacheless),
                // so no double emit. Emits the captured query log + flow timeline
                // (now complete with the response-write/total bars pushed above)
                // over the authenticated /_gina/agent SSE, touching no HTML.
                if ((process.gina && process.gina._inspectorWindowUntil > Date.now()) && !self.isCacheless()) {
                    emitInspectorWindowData(self, local);
                }

                console.info(req.method +' ['+res.statusCode +'] '+ req.url);
                // HEAD: send headers only — body suppressed (HTTP spec §4.3.2)
                if ( /^HEAD$/i.test(req.method) ) {
                    if ( stream ) {
                        // #H8 — HTTP/2 HEAD: stream.respond() with content-length, no body.
                        if ( !stream.headersSent ) {
                            var _headH = {
                                'content-type'   : localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
                                'content-length' : Buffer.byteLength(htmlContent, 'utf8'),
                                ':status'        : res.statusCode || 200
                            };
                            var _pendingH = res.getHeaders ? res.getHeaders() : {};
                            for (var _hk in _pendingH) {
                                if (!(_hk in _headH)) _headH[_hk] = _pendingH[_hk];
                            }
                            stream.respond(_headH);
                        }
                        stream.end();
                        res.headersSent = true;
                    } else {
                        res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding);
                        res.setHeader('content-length', Buffer.byteLength(htmlContent, 'utf8'));
                        res.end();
                    }
                } else if ( stream ) {
                    // #H8 — Direct HTTP/2 stream: bypass HTTP/1.1 compat layer.
                    // Guard: client may have disconnected (nginx timeout, browser navigation)
                    // before the async callback completed. stream.destroyed is true in that
                    // case — respond() would throw ERR_HTTP2_INVALID_STREAM.
                    if (stream.destroyed || stream.closed) {
                        console.warn('[render-swig] Stream already destroyed — client disconnected before response was sent ('+ req.url +')');
                    } else {
                        if ( !stream.headersSent ) {
                            var _streamHeaders = {
                                'content-type' : localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
                                ':status'      : res.statusCode || 200
                            };
                            // Merge headers set earlier in the pipeline (CORS, cache-control, etc.)
                            // — stream.respond() on the raw HTTP/2 stream does not include headers
                            // set via response.setHeader().
                            var _pendingHeaders = res.getHeaders ? res.getHeaders() : {};
                            for (var _rhk in _pendingHeaders) {
                                if (!(_rhk in _streamHeaders)) _streamHeaders[_rhk] = _pendingHeaders[_rhk];
                            }
                            // #H10 — register the trailer flush, then defer the stream close
                            // via waitForTrailers so the trailers follow the final DATA frame.
                            if (_trailers) {
                                stream.once('wantTrailers', function() {
                                    try { if (!stream.destroyed && !stream.closed) stream.sendTrailers(_trailers); } catch (_e) { /* best-effort */ }
                                });
                            }
                            stream.respond(_streamHeaders, _trailers ? { waitForTrailers: true } : undefined);
                        }
                        stream.end(htmlContent);
                        res.headersSent = true;
                    }
                } else {
                    res.end( htmlContent );
                }
                layout = null;
            }

            // Release per-request refs on the closure. The function-scoped
            // `req` / `res` / `_next` captures stay alive until return and
            // are GC'd then; the closure properties need explicit nulling
            // for early memory release of the per-request payload.
            local.req = null;
            local.res = null;
            local.next = null;
            if ( _next ) return _next();
            return;
        } // EO String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'



        // replaced: /\<html|head|body/i.test() — use toLowerCase().indexOf() (#P14)
        var _layoutLower = layout.toLowerCase();
        isLoadingPartial = (
            _layoutLower.indexOf('<html') < 0
            || _layoutLower.indexOf('<head') < 0
            || _layoutLower.indexOf('<body') < 0
        ) ? true : false;

        // if (isLoadingPartial) {
        //     console.warn('----------------> loading partial `'+ path);
        // }

        isDeferModeEnabled = localOptions.template.javascriptsDeferEnabled || localOptions.conf.content.templates._common.javascriptsDeferEnabled || false;
        hasExternalsPlugins = (localOptions.template.externalPlugins.length > 0) ? true : false;

        // iframe case - without HTML TAG
        if (!self.isXMLRequest() && _layoutLower.indexOf('<html') < 0 ) {
            // #A11Y3 — the synthesised wrapper carried no doctype (so the document rendered
            // in quirks mode) and no `lang` (WCAG 3.1.1). Deliberately NOT added here:
            //   - `<title>`: no title value is in scope at this point, and inventing one is
            //     worse than omitting it;
            //   - a landmark: this wraps arbitrary partial content that may already carry
            //     its own `<main>`, and two landmarks are worse than none.
            // The `</body>` below is load-bearing beyond markup validity — release-banner's
            // maybeInject() splices the dev banner on /<\/body>/i, so dropping it would
            // silently stop the banner injecting with no test to catch it.
            var _iframeLang = ( data && data.page && data.page.view
                                && typeof(data.page.view.lang) == 'string'
                                && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(data.page.view.lang) )
                ? data.page.view.lang
                : 'en';
            layout = '<!doctype html>\n<html lang="'+ _iframeLang +'">\n\t<head></head>\n\t<body class="gina-iframe-body">\n\t\t'+ layout +'\n\t</body>\n</html>';
        }

        // adding stylesheets
        if (!isWithoutLayout && data.page.view.stylesheets && !/\{\{\s+(page\.view\.stylesheets)\s+\}\}/.test(layout) ) {
            layout = layout.replace(/\<\/head\>/i, '\n\t{{ page.view.stylesheets }}\n</head>')
        }

        if (hasViews() && isWithoutLayout) {
            // $.getScript(...)
            //var isProxyHost = ( typeof(req.headers.host) != 'undefined' && localOptions.conf.server.scheme +'://'+ req.headers.host != localOptions.conf.hostname || typeof(req.headers[':authority']) != 'undefined' && localOptions.conf.server.scheme +'://'+ req.headers[':authority'] != localOptions.conf.hostname  ) ? true : false;
            //var hostname = (isProxyHost) ? localOptions.conf.hostname.replace(/\:\d+$/, '') : localOptions.conf.hostname;



            var scripts = data.page.view.scripts;
            scripts = scripts.replace(/\s+\<script/g, '\n<script');

            if (!isProxyHost) {
                var webroot = data.page.environment.webroot;
                scripts = scripts.replace(/src\=\"\/(.*)\"/g, 'src="'+ webroot +'$1"');
                //stylesheets = stylesheets.replace(/href\=\"\/(.*)\"/g, 'href="'+ webroot +'$1"')
                webroot = null;
            }

            // iframe case - without HTML TAG
            if (self.isXMLRequest() || _layoutLower.indexOf('<html') < 0 ) {
                layout += scripts;
                //layout += stylesheets;
            }

        }

        // Adding plugins
        // Means that we don't want GFF context or we already have it loaded
        viewInfos = JSON.clone(data.page.view);

        // #B464 — the predicate is _inspectorWanted (decided above, once).
        if ( _inspectorWanted ) {
            // #QI — inject dev-mode query log into data.page for Inspector
            if (local._queryLog && local._queryLog.length > 0) {
                data.page.queries = local._queryLog;
            }
            // #AISTREAM — AI token-stream snapshot (rides the data.page clone).
            if (local._aiLog && local._aiLog.length > 0) {
                data.page.aiStream = local._aiLog;
            }
            // #EVTBUS — observable application-event snapshot (rides the data.page clone).
            if (local._eventLog && local._eventLog.length > 0) {
                data.page.events = local._eventLog;
            }

            // #FI — inject dev-mode request timeline for Inspector Flow tab.
            // Also convert QI entries into timeline entries so the waterfall
            // shows N1QL queries alongside routing/controller/template phases.
            if (local._timeline && local._timeline.entries.length > 0) {
                if (local._queryLog) {
                    for (var _ti = 0; _ti < local._queryLog.length; _ti++) {
                        var _qe = local._queryLog[_ti];
                        if (_qe._startMs) {
                            local._timeline.entries.push({
                                label: 'n1ql:' + (_qe.trigger || 'query'),
                                cat: 'db',
                                startMs: _qe._startMs,
                                endMs: _qe._startMs + (_qe.durationMs || 0),
                                durationMs: _qe.durationMs || 0,
                                detail: (_qe.statement || '').substring(0, 80)
                            });
                        }
                    }
                }
                data.page.flow = {
                    requestStart: local._timeline.requestStart,
                    entries: local._timeline.entries
                };
            }
            // #FI — snapshot count BEFORE late entries are pushed.
            // data.page.flow.entries is a reference to local._timeline.entries,
            // so reading .length later would include entries pushed after this point.
            var _flowSnapshotCount = (local._timeline) ? local._timeline.entries.length : 0;

            // #B464 — the payload (the __gdGina / __gdUser clones, the engine
            // badge, metrics, the Inspector URL, the capture gate, redaction,
            // the serverInstance sinks and the inspector data event) is built
            // AFTER template execution by buildInspectorDataScript() at the
            // bottom of this file, on both cache paths, and spliced where the
            // pre-compile plugin below leaves the INSPECTOR_DATA_MARKER. Baked
            // into the layout here, the former __gdScript literal was compiled
            // once per view, cached, persisted to the layout-cache file — and
            // served request 1's page data to every later request and process.

            var __logsScript = '<script' + _cspNonceTplAttr + '>'
                + 'window.__ginaLogs = window.__ginaLogs || [];'
                + '(function(w){'
                + 'var _c=w.console,_l=w.__ginaLogs,_b=' + inlineScript.safeInlineString(data.page.environment && data.page.environment.bundle || '') + ';'
                + '["log","info","warn","error","debug"].forEach(function(lvl){'
                + 'var orig=_c[lvl].bind(_c);'
                + '_c[lvl]=function(){'
                + 'orig.apply(_c,arguments);'
                + 'try{_l.push({t:Date.now(),l:lvl,b:_b,s:Array.prototype.slice.call(arguments).join(" ")});}catch(e){}'
                + '};});'
                + '}(window));</script>\n';

            // #TPL2 — inline the statusbar template body instead of {% include %}-ing
            // it from the framework core dir. That include target is OUTSIDE the
            // bundle templates root, which the swig loader now confines
            // (CVE-2023-25345, allowOutsideRoot=false). statusbar.html is a leaf
            // (only {% if page.cspNonce %} + {{ }} tags, no nested include/extends),
            // so its body compiles identically when spliced into the layout in place
            // of the include. Read per-render so dev edits hot-reload; this block is
            // dev/debug-gated above, so there is no production read.
            var _statusbarTpl = '';
            try {
                _statusbarTpl = await fs.promises.readFile(
                    getPath('gina').core + '/asset/plugin/dist/vendor/gina/html/statusbar.html', 'utf8'
                );
            } catch (_sbErr) {
                console.warn('[render] Inspector statusbar template unavailable: ' + (_sbErr.message || _sbErr));
            }

            plugin = '\t'
                + '{# Gina Inspector #}'
                + __logsScript
                // #B464 — a marker, never the data script: spliceInspectorData()
                // resolves it post-execute on both cache paths. The statusbar
                // body that follows reads window.__ginaData at load, so the
                // script lands ahead of it exactly where the literal used to.
                + INSPECTOR_DATA_MARKER + '\n'
                + _statusbarTpl
                + '{# END Gina Inspector #}'
            ;


            if (isWithoutLayout && localOptions.debugMode || localOptions.debugMode ) {
                if (self.isXMLRequest()) {
                    // #FI + #QI — inject flow and queries into data.page.data so the
                    // XHR hidden input carries them to the Inspector on popin/dialog open.
                    if (data.page.flow)    { data.page.data.flow    = data.page.flow; }
                    if (data.page.queries) { data.page.data.queries = data.page.queries; }
                    // #B464 — the hidden inputs themselves are spliced into the
                    // executed HTML by spliceXhrInputs(), never into the layout.
                }
            }


            if (
                self.isCacheless()
                    && !/\{\# Gina Inspector \#\}/.test(layout)
                ||
                localOptions.debugMode
                    && !/\{\# Gina Inspector \#\}/.test(layout)
            ) {
                // $-safe splice. With a STRING replacement, String.prototype.replace expands
                // dollar patterns: $` is the text BEFORE the match, $' the text AFTER it
                // (also $&, $n). The inlined #TPL2 statusbar body literally contains both
                // (a `$` followed by a backtick in a comment, and `$'` in a regex literal),
                // so the old string form spliced the whole pre/post-</body> document INTO
                // the statusbar <script> — a SyntaxError that killed the dev Inspector
                // statusbar + launch link on any content-heavy page. A function replacer
                // returns the text verbatim, with no dollar-pattern expansion.
                layout = layout.replace(/<\/body>/i, function () { return plugin + '\n\t</body>'; });
            }

            // adding javascripts
            layout.replace('{{ page.view.scripts }}', '');
            // placed in the HEAD excepted when rendering a partial or when `isDeferModeEnabled` == true
            if (isLoadingPartial) {
                if ( !/\{\{ page\.view\.scripts \}\}/.test(layout) ) {
                    layout += '\t{{ page.view.scripts }}';
                }
            } else {
                // placed in the HEAD
                if ( isDeferModeEnabled  ) {
                    layout = layout.replace(/\<\/head\>/i, '\t{{ page.view.scripts }}\n\t</head>');
                }
                // placed in the BODY
                else {
                    if ( !/\{\{ page\.view\.scripts \}\}/.test(layout) ) {
                        layout = layout.replace(/\<\/body\>/i, '\t{{ page.view.scripts }}\n</body>');
                    }
                    if (hasExternalsPlugins) {
                        for (let i =0, len = localOptions.template.externalPlugins.length; i<len; i++) {
                            layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.externalPlugins +'\n</head>');
                        }
                    }
                }
            }

            // ginaLoader cannot be deferred
            if (
                !localOptions.template.javascriptsExcluded
                    && !/window\.onGinaLoaded/.test(layout)
                ||
                localOptions.template.javascriptsExcluded != '**'
                    && !/window\.onGinaLoaded/.test(layout)

            ) {
                layout = layout.replace(/\<\/head\>/i, '\t'+ _nonceLoader(localOptions.template.ginaLoader) +'\n</head>');
            }

        } else if ( hasViews() && self.isCacheless() && self.isXMLRequest() ) {

            if (isWithoutLayout) {
                delete data.page.view.scripts;
                delete data.page.view.stylesheets;
            }
            // means that we don't want GFF context or we already have it loaded
            // viewInfos = JSON.clone(data.page.view);
            // if ( !isWithoutLayout )
            //     viewInfos.assets = assets;


            // #FI + #QI — inject flow and queries into data.page.data so the
            // XHR hidden input carries them to the Inspector on popin/dialog open.
            if (data.page.flow)    { data.page.data.flow    = data.page.flow; }
            if (data.page.queries) { data.page.data.queries = data.page.queries; }
            // #B464 — the hidden inputs themselves are spliced into the
            // executed HTML by spliceXhrInputs(), never into the layout.

        } else { // other envs like prod ...
            // adding javascripts
            layout.replace('{{ page.view.scripts }}', '');
            if (isLoadingPartial) {
                if ( !/\{\{ page\.view\.scripts \}\}/.test(layout) ) {
                    layout += '\t{{ page.view.scripts }}\n';
                }
                if (
                    !localOptions.template.javascriptsExcluded
                        && !/window\.onGinaLoaded/.test(layout)
                    ||
                    localOptions.template.javascriptsExcluded != '**'
                        && !/window\.onGinaLoaded/.test(layout)

                ) {
                    layout += '\t'+ _nonceLoader(localOptions.template.ginaLoader) +'\n';
                }
            } else {
                // placed in the HEAD
                if (
                    isDeferModeEnabled && /\<\/head\>/i.test(layout)
                    && !/\{\{ page\.view\.scripts \}\}/.test(layout)
                ) { // placed in the HEAD
                    layout = layout.replace(/\<\/head\>/i, '\t{{ page.view.scripts }}\n\t</head>');
                }
                // placed in the BODY
                else {
                    if ( !/\{\{ page\.view\.scripts \}\}/.test(layout) ) {
                        layout = layout.replace(/\<\/body\>/i, '\t{{ page.view.scripts }}\n</body>');
                    }
                    if (hasExternalsPlugins) {
                        for (let i =0, len = localOptions.template.externalPlugins.length; i<len; i++) {
                            layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.externalPlugins +'\n</head>');
                        }
                    }
                }
                // ginaLoader cannot be deferred
                if (
                    !localOptions.template.javascriptsExcluded
                        && !/window\.onGinaLoaded/.test(layout)
                    ||
                    localOptions.template.javascriptsExcluded != '**'
                        && !/window\.onGinaLoaded/.test(layout)

                ) {
                    layout = layout.replace(/\<\/head\>/i, '\t'+ _nonceLoader(localOptions.template.ginaLoader) +'\n</head>');
                }
            }
        }


        layout = whisper(dic, layout, /\{{ ([a-zA-Z.]+) \}}/g );
        dic['page.content'] = layout;


        if ( !headersSent() ) {
            // //catching errors
            // res.statusCode = ( typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status])  != 'undefined' ) ? data.page.data.status : 200; // by default

            // // HTTP/2 (RFC7540 8.1.2.4):
            // // This standard for HTTP/2 explicitly states that status messages are not supported.
            // // In HTTP/2, the status is conveyed solely by the numerical status code (e.g., 200, 404, 500),
            // // and there is no field for a human-readable status message.
            // if (
            //     typeof(data.page.data.errno) != 'undefined'
            //         && String(data.page.data.status).startsWith('2')
            //         && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
            //         && !/http\/2/.test(localOptions.conf.server.protocol)
            //     ||
            //     typeof(data.page.data.status) != 'undefined'
            //         && !String(data.page.data.status).startsWith('2')
            //         && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
            //         && !/http\/2/.test(localOptions.conf.server.protocol)
            // ) {

            //     try {
            //         res.statusMessage = localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status];
            //     } catch (err){
            //         res.statusCode    = 500;
            //         res.statusMessage = err.stack||err.message||localOptions.conf.server.coreConfiguration.statusCodes[res.statusCode];
            //     }
            // }

            // res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

            // try {

            //     // escape special chars
            //     var blacklistRe = new RegExp('[\<\>]', 'g');
            //     // DO NOT REPLACE IT BY JSON.clone() !!!!

            //     data.page.data = JSON.parse(JSON.stringify(data.page.data).replace(blacklistRe, '\$&'));
            //     blacklistRe = null;
            // } catch (err) {
            //     filename = localOptions.template.html;
            //     filename += ( typeof(data.page.view.namespace) != 'undefined' && data.page.view.namespace != '' && new RegExp('^' + data.page.view.namespace +'-').test(data.page.view.file) ) ? '/' + data.page.view.namespace + data.page.view.file.split(data.page.view.namespace +'-').join('/') + ( (data.page.view.ext != '') ? data.page.view.ext: '' ) : '/' + data.page.view.file+ ( (data.page.view.ext != '') ? data.page.view.ext: '' );
            //     self.throwError(res, 500, new Error('Controller::render(...) compilation error encountered while trying to process template `'+ filename + '`\n' + (err.stack||err.message||err) ));
            //     filename = null;
            //     blacklistRe = null;
            //     return;
            // }



            // Only available for http/2.0 for now
            // #B495 — an XHR request skips this block unless the compiled-template
            // cache is on: the entry written below memoises the map and the header
            // for EVERY later render of the view, navigation renders included, so a
            // view whose first request is XHR must not leave it empty (measured — an
            // XHR render populates the same entry). With the cache off there is no
            // entry to fill and XHR skips the block as before. The emission keeps its
            // own gates on both paths.
            if (
                /http\/2/.test(localOptions.conf.server.protocol)
                && ( !self.isXMLRequest() || String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true' )
            ) {
                var assets = null;
                try {
                    // TODO - button in toolbar to empty url assets cache
                    if ( /**  self.isCacheless() ||*/ typeof(localOptions.template.assets) == 'undefined' || typeof(localOptions.template.assets[req.url]) == 'undefined' ) {
                        // assets string -> object
                        //assets = self.serverInstance.getAssets(localOptions.conf, layout.toString(), swig, data);
                        assets = self.serverInstance.getAssets(localOptions.conf, layout, null, data);
                        localOptions.template.assets = JSON.parse(assets);
                    }

                    // #B495 — assembled once per compile by a module-scope helper
                    // (parameters only), memoised on the cache entry below so a hit
                    // re-emits it without a layout parse; '' when nothing qualifies,
                    // and an empty header is no longer sent.
                    _h2PreloadLinks = buildH2PreloadLinks(localOptions.template.h2Links, localOptions.template.assets);
                    if ( !self.isXMLRequest() && !self.isCacheless() && _h2PreloadLinks ) {
                        res.setHeader('link', _h2PreloadLinks);
                    }

                    assets = null;

                } catch (err) {
                    assets = null;
                    self.throwError(res, 500, new Error('Controller::render(...) calling getAssets(...) \n' + (err.stack||err.message||err) ));
                    return;
                }
            }

            if (newLayoutFilename) {
                // replaced: openSync/writeSync/closeSync — async write (#P31)
                // Atomic write: temp file + rename. fs.promises.writeFile uses
                // O_TRUNC which transiently exposes a 0-byte state; a parallel
                // render reading the cached layout at the post-priming read
                // ~640 lines above could observe that empty state. Writing to
                // a temp file and renaming onto target is atomic on POSIX, so
                // readers always see either the prior content or the new
                // content.
                // #SPA1 — a fragment render persists the child's block roster
                // ahead of the assembled shell: the roster keeps placeholders
                // for the child's blocks, and the shell tail (xhr-inputs /
                // scripts) still rides the fragment response after them. The
                // write lands in the fragments/ namespace, so the full-page
                // cached layout is never touched by a fragment render.
                var _persistedLayout = ( isWithoutLayout && fragmentBlockRoster !== null )
                    ? fragmentBlockRoster + '\n' + layout
                    : layout;
                var _layoutTmpAssets = newLayoutFilename + '.tmp.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2);
                await fs.promises.writeFile(_layoutTmpAssets, _persistedLayout);
                await fs.promises.rename(_layoutTmpAssets, newLayoutFilename);
                _layoutTmpAssets = null;
                _persistedLayout = null;
            }

            // Last compilation before rendering
            // Now we can use `data` instead of `swigData`
            mapping = { filename: path  };
            if (isWithoutLayout && localOptions.debugMode || localOptions.debugMode ) {
                if (self.isXMLRequest()) {
                    // popin case
                    if ( !/<\/body>/i.test(layout) ) {
                        _templateContent += layout
                    }
                }
            }
            // #FI — template compilation timing
            var _compileStart = (local._timeline) ? Date.now() : 0;
            compiledTemplate = swig.compile(_templateContent, mapping);
            if (_compileStart && local._timeline) {
                local._timeline.entries.push({
                    label: 'swig-compile', cat: 'template',
                    startMs: _compileStart, endMs: Date.now(),
                    durationMs: Date.now() - _compileStart,
                    detail: (data.page.view.file || null)
                });
            }

            if (
                String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'
                && hasLayoutInPath
                && !cache.has(cacheKey)
                && !layoutCacheFailed
            ) {
                // Caching template
                cacheObject = {
                    template : compiledTemplate,
                    // #B495 — memoised for the hit path: the assembled `link` preload
                    // header (null when the http/2 block never ran, '' when nothing
                    // qualified) and the parsed preload map (`view.assets` on hits).
                    h2Link   : _h2PreloadLinks,
                    assets   : ( localOptions.template && localOptions.template.assets && typeof(localOptions.template.assets) == 'object' ) ? localOptions.template.assets : null
                };
                cache.set(cacheKey, cacheObject);
            }

            if ( !headersSent() ) {
                if ( localOptions.isRenderingCustomError ) {
                    localOptions.isRenderingCustomError = false;
                }
                // #FI — template execution timing
                var _execStart = (local._timeline) ? Date.now() : 0;
                // #HDR5 — expose the per-request nonce as {{ page.cspNonce }} for the
                // app-template helper + the dev-only statusbar include. Set before each
                // compiledTemplate(data) (swig re-evaluates the var per execute); absent when no nonce.
                if (_cspNonce) { data.page.cspNonce = _cspNonce; }
                htmlContent = compiledTemplate(data);
                // #B464 — see the cache-hit twin above: this request's data
                // script replaces the marker (or the marker goes), then the XHR
                // hidden inputs are spliced; the snapshot count supersedes the
                // pre-compile one taken in the compile branch.
                var _inspSplice = spliceInspectorData(htmlContent, _inspectorWanted, data, _inspectorAssetsMap(), local, self, _cspNonceAttr);
                htmlContent = _inspSplice.html;
                if ( _inspSplice.flowSnapshotCount !== null ) {
                    _flowSnapshotCount = _inspSplice.flowSnapshotCount;
                }
                if ( _xhrInputsWanted ) {
                    if ( !isWithoutLayout ) {
                        viewInfos.assets = _inspectorAssetsMap();
                    }
                    htmlContent = spliceXhrInputs(htmlContent, data, viewInfos);
                }
                // #RWATCH S3 — stale-release banner before writeCache (rides cache
                // hit + miss); byte-inert unless local + !dev + releaseWatch.enabled.
                htmlContent = releaseBanner.maybeInject(htmlContent, localOptions.conf, _cspNonceAttr);
                if (_execStart && local._timeline) {
                    local._timeline.entries.push({
                        label: 'swig-execute', cat: 'template',
                        startMs: _execStart, endMs: Date.now(),
                        durationMs: Date.now() - _execStart,
                        detail: (data.page.view.file || null)
                    });
                }
                res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

                if (
                    !layoutCacheFailed
                    && (
                        !self.isCacheless()
                        && typeof(req.routing.cache) != 'undefined'
                        && req.method.toUpperCase() === 'GET'
                        ||
                        // allowing caching even for dev env
                        String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true'
                        && typeof(req.routing.cache) != 'undefined'
                        && req.method.toUpperCase() === 'GET'
                    )
                ) {
                    try {
                        await writeCache(localOptions.bundle, localOptions.conf.server.cache, htmlContent, req, res, self.serverInstance._cacheIsEnabled, self.throwError);
                    } catch (cacheErr) {
                        // A cache-write failure must never break a render that already succeeded:
                        // unguarded, the rejection unwinds to render()'s function-level catch, which
                        // discards a good page and answers 500. Siblings already degrade this way
                        // (render-nunjucks.js try/catch, render-json.js .catch()).
                        try { console.error('[render-swig] writeCache failed: ' + (cacheErr.message || cacheErr)); } catch (e) {}
                    }
                }

                // Cache-Control: miss path — inform browsers/CDNs of the response lifetime (#C6)
                if ( typeof(req.routing.cache) != 'undefined' && req.routing.cache ) {
                    var _ccCfg = ( typeof(req.routing.cache) == 'string' ) ? { type: req.routing.cache } : req.routing.cache;
                    var _ccTtl = ( typeof(_ccCfg.ttl) != 'undefined' && _ccCfg.ttl > 0 ) ? _ccCfg.ttl : localOptions.conf.server.cache.ttl;
                    if ( _ccTtl > 0 ) {
                        res.setHeader('Cache-Control', ( _ccCfg.visibility === 'public' ? 'public' : 'private' ) + ', max-age=' + ~~(_ccTtl));
                    }
                }

                // #FI — response write + total timing
                if (local._timeline) {
                    var _respEnd = Date.now();
                    var _rwStart = local._timeline._renderStart || local._timeline._actionStart || local._timeline.requestStart;
                    local._timeline.entries.push({
                        label: 'response-write', cat: 'response',
                        startMs: _rwStart, endMs: _respEnd,
                        durationMs: _respEnd - _rwStart,
                        detail: null
                    });
                    local._timeline.entries.push({
                        label: 'total', cat: 'total',
                        startMs: local._timeline.requestStart,
                        endMs: _respEnd,
                        durationMs: _respEnd - local._timeline.requestStart,
                        detail: null
                    });

                    // Patch late state into HTML. __ginaData was serialised
                    // (deep clone) before swig-compile, so anything that became
                    // known after that point needs a client-side late-bind:
                    //   • flow late entries (template/response/total)
                    //   • `metrics.weightBytes` (only known once htmlContent
                    //     is finalised) and the final `metrics.serverMs`
                    //     (includes the just-pushed `total` entry).
                    var _lateEntries = local._timeline.entries.slice(_flowSnapshotCount);
                    if (displayInspector || self.isCacheless()) {
                        var _weightBytesFinal = Buffer.byteLength(htmlContent, 'utf8');
                        var _serverMsFinal    = _respEnd - local._timeline.requestStart;
                        var _flowPatch = (_lateEntries.length > 0)
                            ? 'if(u&&u.flow){var _e=u.flow.entries,_p=' + inlineScript.safeInlineJson(_lateEntries) + ';for(var _i=0;_i<_p.length;_i++){_e.push(_p[_i])}}'
                            : '';
                        var _patchScript = '<script' + _cspNonceAttr + '>(function(d){'
                            + 'var u=d&&d.user,g=d&&d.gina;'
                            + _flowPatch
                            + 'if(u&&u.environment&&u.environment.metrics){u.environment.metrics.weightBytes=' + _weightBytesFinal + ';u.environment.metrics.serverMs=' + _serverMsFinal + ';}'
                            + 'if(g&&g.environment&&g.environment.metrics){g.environment.metrics.weightBytes=' + _weightBytesFinal + ';g.environment.metrics.serverMs=' + _serverMsFinal + ';}'
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
                        htmlContent = htmlContent.replace(/<\/body>/i, function () { return _patchScript + '</body>'; });
                    }
                }

                // #INS10 follow-up — prod-window HTML egress (cache-miss path).
                // Window-open AND not-dev: mutually exclusive with the dev-only
                // __ginaData injection block (which requires isCacheless). Emits
                // the captured query log + flow timeline (complete with the
                // response-write/total bars just pushed) over the authenticated
                // /_gina/agent SSE, touching no HTML.
                if ((process.gina && process.gina._inspectorWindowUntil > Date.now()) && !self.isCacheless()) {
                    emitInspectorWindowData(self, local);
                }

                console.info(req.method +' ['+res.statusCode +'] '+ req.url);
                // HEAD: send headers only — body suppressed (HTTP spec §4.3.2)
                if ( /^HEAD$/i.test(req.method) ) {
                    if ( stream ) {
                        // #H8 — HTTP/2 HEAD: stream.respond() with content-length, no body.
                        if ( !stream.headersSent ) {
                            var _headH2 = {
                                'content-type'   : localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
                                'content-length' : Buffer.byteLength(htmlContent, 'utf8'),
                                ':status'        : res.statusCode || 200
                            };
                            var _pendingH2 = res.getHeaders ? res.getHeaders() : {};
                            for (var _hk2 in _pendingH2) {
                                if (!(_hk2 in _headH2)) _headH2[_hk2] = _pendingH2[_hk2];
                            }
                            stream.respond(_headH2);
                        }
                        stream.end();
                        res.headersSent = true;
                    } else {
                        res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding);
                        res.setHeader('content-length', Buffer.byteLength(htmlContent, 'utf8'));
                        res.end();
                    }
                } else if ( stream ) {
                    // #H8 — Direct HTTP/2 stream: bypass HTTP/1.1 compat layer.
                    if (stream.destroyed || stream.closed) {
                        console.warn('[render-swig] Stream already destroyed — client disconnected before response was sent ('+ req.url +')');
                    } else {
                        if ( !stream.headersSent ) {
                            var _streamHeaders2 = {
                                'content-type' : localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
                                ':status'      : res.statusCode || 200
                            };
                            var _pendingHeaders2 = res.getHeaders ? res.getHeaders() : {};
                            for (var _rhk2 in _pendingHeaders2) {
                                if (!(_rhk2 in _streamHeaders2)) _streamHeaders2[_rhk2] = _pendingHeaders2[_rhk2];
                            }
                            // #H10 — register the trailer flush, then defer the stream close
                            // via waitForTrailers so the trailers follow the final DATA frame.
                            if (_trailers) {
                                stream.once('wantTrailers', function() {
                                    try { if (!stream.destroyed && !stream.closed) stream.sendTrailers(_trailers); } catch (_e) { /* best-effort */ }
                                });
                            }
                            stream.respond(_streamHeaders2, _trailers ? { waitForTrailers: true } : undefined);
                        }
                        stream.end(htmlContent);
                        res.headersSent = true;
                    }
                } else {
                    res.end( htmlContent );
                }

                layout = null;
            }

            // console.info(req.method +' ['+res.statusCode +'] '+ req.url);

            // Release per-request refs on the closure. The function-scoped
            // `req` / `res` / `_next` captures stay alive until return.
            local.req = null;
            local.res = null;
            local.next = null;
            if ( _next ) return _next();
            return;
        }


        if ( typeof(req.params.errorObject) != 'undefined' ) {
            return self.throwError(req.params.errorObject);
        }
        if ( stream ) {
            // #H8 — Direct HTTP/2 stream for error fallthrough.
            if (stream.destroyed || stream.closed) {
                console.warn('[render-swig] Stream already destroyed — client disconnected before error response was sent ('+ (req ? req.url : 'unknown') +')');
            } else if ( !stream.headersSent ) {
                var _errHeaders = {
                    'content-type' : localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding,
                    ':status'      : 500
                };
                var _pendingErrH = res.getHeaders ? res.getHeaders() : {};
                for (var _ehk in _pendingErrH) {
                    if (!(_ehk in _errHeaders)) _errHeaders[_ehk] = _pendingErrH[_ehk];
                }
                stream.respond(_errHeaders);
                stream.end('Unexpected controller error while trying to render.');
                res.headersSent = true;
            }
        } else {
            res.end('Unexpected controller error while trying to render.');
        }

        // Release per-request refs on the closure. The function-scoped
        // `req` / `res` / `_next` captures stay alive until return.
        local.req = null;
        local.res = null;
        local.next = null;
        if ( _next ) return _next();
        return;

    } catch (err) {
        return self.throwError(res, 500, err);
    }
};


// ---- #B464 - module-scope helpers for the post-execute Inspector data splice ----
// Everything below is per-call and takes its render()-scoped inputs as
// parameters (the #B60 / #B61 shape): nothing here may read `self`, `local`,
// `data` or `assets` from an enclosing scope, because in prod this module is
// a singleton shared by concurrent renders.

/**
 * The placeholder the pre-compile Inspector plugin carries where the
 * `window.__ginaData` script used to be baked. An HTML comment: swig passes it
 * through untouched, it carries no `{`, `}` or `<script` (the #B463 helper
 * contract is unaffected), and it is inert if a request ever leaves it in place.
 *
 * @constant {string}
 */
var INSPECTOR_DATA_MARKER = '<!--gina:inspector-data-->';

/**
 * A `window.__ginaData` script exactly as pre-#B464 builds persisted it into a
 * layout-cache file: the opener is the bare tag, the #B130 render-time
 * conditional, or the pre-#B130 literal nonce. The payload was serialised with
 * every `<` escaped, so the first `;</script>` after the opener is the real
 * terminator; the optional trailing newline is the one the old builder appended.
 *
 * @constant {RegExp}
 */
var RE_PERSISTED_INSPECTOR_DATA = /<script(?: nonce="[^"]*"|\{% if page\.cspNonce %\} nonce="\{\{ page\.cspNonce \}\}"\{% endif %\})?>window\.__ginaData = [\s\S]*?;<\/script>\n?/g;

/**
 * The two XHR hidden inputs exactly as pre-#B464 builds persisted them (the
 * value is RFC 5987 percent-encoded, so it never contains a quote).
 *
 * @constant {RegExp}
 */
var RE_PERSISTED_XHR_INPUT = /[ \t]*<input type="hidden" id="gina-without-layout-xhr-(?:data|view)" value="[^"]*">(?:\r?\n)?/g;

/**
 * Heal a layout-cache file persisted by a pre-#B464 build: the persisted
 * `window.__ginaData` script — the FIRST request's page data, served to every
 * later request and process that compiled from the file — becomes the marker
 * the post-execute splice expects, and persisted XHR hidden inputs are dropped.
 * Idempotent (a healed layout matches neither regex) and inert on a layout that
 * never carried either; app-authored scripts and inputs are untouched because
 * both regexes anchor on the framework's own emission shapes. The caller
 * persists the result back to the file on the same compile-cache miss.
 *
 * @inner
 * @param {string} layout - The layout text as read from the layout-cache file
 * @returns {string} The layout, with the marker in place of a persisted data script
 * @example
 * var stale  = await fs.promises.readFile(layoutCacheFile, 'utf8');
 * var healed = healPersistedInspectorData(stale); // the persisted script is now the marker
 */
function healPersistedInspectorData(layout) {
    if (
        typeof layout !== 'string'
        || layout.indexOf('__ginaData') < 0 && layout.indexOf('gina-without-layout-xhr-') < 0
    ) {
        return layout;
    }
    // A function replacer: the marker carries no `$`, but the form is the house
    // rule for every splice on this file (see the #TPL2 note in render()).
    layout = layout.replace(RE_PERSISTED_INSPECTOR_DATA, function () { return INSPECTOR_DATA_MARKER + '\n'; });
    layout = layout.replace(RE_PERSISTED_XHR_INPUT, '');
    return layout;
}

/**
 * Build this request's Inspector payload and its inline `<script>` — the block
 * that lived inline in render()'s compile branch until #B464, extracted so
 * BOTH cache paths run it AFTER `compiledTemplate(data)`. Clones `data.page`
 * twice (the toolbar view and the redacted user view), stamps the engine
 * badge, the server metrics, the Inspector URL and the capture gate, snapshots
 * the unredacted payload for `/_gina/reveal` (local scope only), redacts (#R7),
 * refreshes the serverInstance sinks and emits the inspector data event — so a
 * cache HIT now refreshes those sinks too, where before only a compile did.
 *
 * The script opens with the LITERAL nonce attribute: it is spliced into the
 * executed HTML, never into the compiled template, so the per-request value is
 * correct there (the same reasoning as the two late-bind patch scripts).
 *
 * @inner
 * @param {object} data          - The executed template context (`data.page` populated)
 * @param {object} assets        - The parsed http/2 preload map the payload carries as `view.assets` — resolved by the caller at splice time, `undefined` when the preload block never ran (#B490)
 * @param {object} local         - The per-request closure (`_timeline`, `options.conf`)
 * @param {object} self          - The SuperController instance (`serverInstance` sinks)
 * @param {string} _cspNonceAttr - Literal ` nonce="..."` fragment, or `''`
 * @returns {{script: string, flowSnapshotCount: number}} The inline script, and the
 *          timeline length at payload-build time (the late-bind patch's slice point)
 * @example
 * var built = buildInspectorDataScript(data, assets, local, self, ' nonce="abc"');
 * // built.script opens with `<script nonce="abc">` and assigns window.__ginaData
 */
function buildInspectorDataScript(data, assets, local, self, _cspNonceAttr) {
    // #FI — the late-bind patch appends every timeline entry pushed AFTER this
    // point (data.page.flow.entries is a reference to local._timeline.entries).
    var flowSnapshotCount = (local._timeline) ? local._timeline.entries.length : 0;

    var __gdGina = JSON.parse(JSON.stringify(data.page));
    __gdGina.view.assets      = {};
    __gdGina.view.scripts     = 'ignored-by-toolbar';
    __gdGina.view.stylesheets = 'ignored-by-toolbar';

    var __gdUser = JSON.parse(JSON.stringify(data.page));
    __gdUser.view.scripts     = 'ignored-by-toolbar';
    __gdUser.view.stylesheets = 'ignored-by-toolbar';
    __gdUser.view.assets      = assets;

    // #B464 — the per-request CSP nonce rides data.page for the template's
    // own {{ page.cspNonce }} helper; it is transport state, not page data,
    // and was never in the payload while the clone ran pre-execute.
    delete __gdGina.cspNonce;
    delete __gdUser.cspNonce;

    // Inspector secret redaction (#R7) — strip secret-looking fields from
    // the Inspector clone before any sink (HTML script tag, engine.io push,
    // /_gina/agent SSE). The actual template `data` is never touched.
    // Inject the resolved redact config so the statusbar shim can apply
    // the same rules to validator `ginaToolbar.update()` calls client-side.
    var _redactConf = inspectorRedact.getConfig(local.options.conf);
    __gdGina.inspectorRedact = {
        patterns    : _redactConf.patterns,
        types       : _redactConf.types,
        replacement : _redactConf.replacement
    };
    // Expose bundle scope so the Inspector knows whether to offer the
    // Reveal toggle (only local-scope bundles ship the unredacted snapshot
    // via /_gina/reveal — see serverInstance._lastGinaDataUnredacted below).
    if (__gdGina.environment) {
        __gdGina.environment.scope = process.env.NODE_SCOPE || null;
    }

    // Template engine identity (name + version) for the Inspector View
    // badge. Read from the cached resolver decision; fall back to the
    // package's package.json when the cache is missing (test stubs,
    // very-early bootstrap). Defensive — never break render.
    try {
        var _swigDec   = process.gina && process.gina._swigDecision;
        var _swigPkg   = (_swigDec && _swigDec['package']) || '@rhinostone/swig';
        var _swigVer   = (_swigDec && _swigDec.version) || null;
        if (!_swigVer) {
            try { _swigVer = require(_swigPkg + '/package.json').version; }
            catch (e) { _swigVer = null; }
        }
        var _engineName = _swigPkg.replace(/^@rhinostone\//, '');
        if (__gdGina.environment) {
            __gdGina.environment.templateEngine = { name: _engineName, version: _swigVer };
        }
        if (__gdUser.environment) {
            __gdUser.environment.templateEngine = { name: _engineName, version: _swigVer };
        }
    } catch (e) { /* defensive — engine badge falls back to client heuristic */ }

    // Inspector View tab Weight/Load fallback. When the popup's
    // window.opener is unreachable (Cross-Origin-Opener-Policy on the
    // host page nulls opener references), the client-side Performance
    // API path can't compute weight/load. These server-side values let
    // the Inspector render dual badges (server dimmed | client primary)
    // and a server-only badge when client is unavailable.
    //
    //   serverMs    — best-available server processing duration; updated
    //                 by the late-bind patch script below with the final
    //                 total once `response-write` + `total` entries are
    //                 appended to the timeline.
    //   weightBytes — null at emit time, late-bound by the patch script
    //                 from `Buffer.byteLength(htmlContent)` (only known
    //                 after htmlContent is finalised).
    var _serverMsInit = null;
    try {
        if (local._timeline && local._timeline.entries.length > 0) {
            var _latestEndMs = local._timeline.requestStart;
            for (var _mi = 0, _mlen = local._timeline.entries.length; _mi < _mlen; _mi++) {
                var _mEnt = local._timeline.entries[_mi];
                if (typeof _mEnt.endMs === 'number' && _mEnt.endMs > _latestEndMs) {
                    _latestEndMs = _mEnt.endMs;
                }
            }
            if (_latestEndMs > local._timeline.requestStart) {
                _serverMsInit = _latestEndMs - local._timeline.requestStart;
            }
        }
    } catch (e) { _serverMsInit = null; }
    if (__gdGina.environment) {
        __gdGina.environment.metrics = { weightBytes: null, serverMs: _serverMsInit };
    }
    if (__gdUser.environment) {
        __gdUser.environment.metrics = { weightBytes: null, serverMs: _serverMsInit };
    }

    // #INS8 — expose the standalone Inspector URL so statusbar.html can
    // prefer it over the embedded /_gina/inspector/ path. Null when
    // unset = fall back to legacy embedded popup.
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
    // #CC6 — mirror the events capture gate to the browser: the
    // statusbar's component-event capture honours the same knob
    // (settings > inspector.events.captureArgs); metadata always,
    // detail values only when opted in.
    __gdGina.inspectorEventsCaptureArgs = !!(process.gina && process.gina._inspectorEventsCaptureArgs);

    var __gdPayload = { gina: __gdGina, user: __gdUser };
    // Snapshot the unredacted payload BEFORE the redact pass, gated on
    // bundle scope. Production / beta / testing never store this — the
    // /_gina/reveal endpoint will 403 with no snapshot to leak.
    var __gdPayloadUnredacted = (process.env.NODE_SCOPE === 'local')
        ? JSON.parse(JSON.stringify(__gdPayload)) : null;
    __gdPayload = inspectorRedact.redact(__gdPayload, {
        compiledPatterns : _redactConf.compiledPatterns,
        replacement      : _redactConf.replacement
    });

    var script = '<script' + _cspNonceAttr + '>window.__ginaData = '
        // #B451 — the helper escapes '<' itself, so no terminator spelling
        // survives (the former blocklist matched two spellings and was
        // bypassable); #B463's brace escape is moot post-execute but harmless.
        + inlineScript.safeInlineJson(__gdPayload)
        + ';</script>';

    // Expose last snapshot for engine.io push and /_gina/agent SSE
    self.serverInstance._lastGinaData = __gdPayload;
    if (__gdPayloadUnredacted) {
        self.serverInstance._lastGinaDataUnredacted = __gdPayloadUnredacted;
    } else {
        // Defensive: clear any stale unredacted snapshot if scope changed mid-process.
        self.serverInstance._lastGinaDataUnredacted = null;
    }
    process.emit('inspector#data', __gdPayload);

    return { script: script, flowSnapshotCount: flowSnapshotCount };
}

/**
 * Resolve the Inspector data marker in the EXECUTED HTML of either cache path:
 * build and splice this request's script when the Inspector is wanted, drop the
 * marker when it is not (a persisted layout carries it for every later request
 * of every view, wanted or not), and leave HTML that never carried it untouched.
 * A function replacer keeps the JSON verbatim — the serialised page data can
 * carry `$` sequences a string replacement would expand.
 *
 * @inner
 * @param {string}  htmlContent   - The executed template output
 * @param {boolean} wanted        - The request's Inspector injection decision
 * @param {object}  data          - The executed template context
 * @param {object}  assets        - The parsed http/2 preload map for `view.assets`, or `undefined` (#B490)
 * @param {object}  local         - The per-request closure
 * @param {object}  self          - The SuperController instance
 * @param {string}  _cspNonceAttr - Literal nonce fragment, or `''`
 * @returns {{html: string, flowSnapshotCount: (number|null)}} The resolved HTML, and the
 *          payload's snapshot count — `null` when no payload was built
 * @example
 * var out = spliceInspectorData(html, wanted, data, assets, local, self, nonceAttr);
 * html = out.html; // the marker is now the script, or gone
 */
function spliceInspectorData(htmlContent, wanted, data, assets, local, self, _cspNonceAttr) {
    if ( typeof htmlContent !== 'string' || htmlContent.indexOf(INSPECTOR_DATA_MARKER) < 0 ) {
        return { html: htmlContent, flowSnapshotCount: null };
    }
    if ( !wanted ) {
        return { html: htmlContent.replace(INSPECTOR_DATA_MARKER, ''), flowSnapshotCount: null };
    }
    var built = buildInspectorDataScript(data, assets, local, self, _cspNonceAttr);
    return {
        html              : htmlContent.replace(INSPECTOR_DATA_MARKER, function () { return built.script; }),
        flowSnapshotCount : built.flowSnapshotCount
    };
}

/**
 * Splice the two XHR hidden inputs — `gina-without-layout-xhr-data` (the page
 * data) and `gina-without-layout-xhr-view` — into the EXECUTED HTML: before
 * `</body>` when the document has one, appended otherwise (the popin shape).
 * Until #B464 they were spliced into the layout pre-compile, which baked a
 * request's data into the compiled template and, for a layout-bearing render,
 * into the persisted layout-cache file. The values are RFC 5987 percent-encoded,
 * so the `</body>` splice can never see a `$`.
 *
 * @inner
 * @param {string} htmlContent - The executed template output
 * @param {object} data        - The executed template context (`data.page.data`, with flow/queries when injected)
 * @param {object} viewInfos   - The `data.page.view` clone (+ the resolved http/2 assets map for a layout render, when one was resolved — #B490)
 * @returns {string} The HTML carrying both inputs
 * @example
 * html = spliceXhrInputs(html, data, JSON.clone(data.page.view));
 */
function spliceXhrInputs(htmlContent, data, viewInfos) {
    var xhrData = '\n<input type="hidden" id="gina-without-layout-xhr-data" value="'+ encodeRFC5987ValueChars(JSON.stringify(data.page.data)) +'">';
    var xhrView = '\n<input type="hidden" id="gina-without-layout-xhr-view" value="'+ encodeRFC5987ValueChars(JSON.stringify(viewInfos)) +'">';
    if ( /<\/body>/i.test(htmlContent) ) {
        return htmlContent.replace(/<\/body>/i, function () { return xhrData + xhrView + '\n\t</body>'; });
    }
    // Popin case — a fragment without a document shell
    return htmlContent + xhrData + xhrView + '\n\t';
}


// ---- #B482/#B484 - module-scope helper for the extends layout-cache re-point ----

/**
 * Re-points a template's extends directive at its assembled layout-cache copy,
 * rewriting ONLY the occurrence that sits inside the matched directive.
 *
 * The previous form searched the whole template for the bare layout path, so the
 * first occurrence anywhere won: a child whose leading comment named its layout
 * had that comment rewritten while the directive kept the raw path, and the page
 * then extended the un-assembled layout (#B482). Splicing around the match index
 * confines the rewrite to the directive and leaves later legitimate mentions of
 * the same filename untouched.
 *
 * A function replacer is used deliberately: the target is a runtime-built path,
 * and a string replacement would expand any dollar-pattern it happens to carry.
 *
 * @inner
 * @param {string} templateContent - Raw child-template source.
 * @param {Array}  extendFound     - Result of the non-global directive match; its
 *   `index` locates the directive inside `templateContent`.
 * @param {string} layoutPath      - Bare, unquoted layout path taken from that directive.
 * @param {string} target          - Absolute path of the assembled cache copy.
 * @returns {string} `templateContent` with the directive's target replaced.
 *
 * @example
 * // Only the directive is re-pointed; a leading comment naming the same file
 * // keeps its original text.
 * out = spliceExtendsTarget(childSource, directiveMatch, 'base.html', cachedAbsolutePath);
 */
function spliceExtendsTarget(templateContent, extendFound, layoutPath, target) {
    var at  = extendFound.index;
    var end = at + extendFound[0].length;
    return templateContent.slice(0, at)
         + extendFound[0].replace(layoutPath, function () { return target; })
         + templateContent.slice(end);
}

/**
 * #B495 — assemble the http/2 `link` preload header for a compiled view: the
 * per-request `h2Links` prefix (the config-declared stylesheets and scripts
 * `getNodeRes()` appended, `rel=preload,`-terminated) followed by one entry per
 * qualifying asset of the parsed `getAssets()` map, trailing comma trimmed.
 * The loop is the compile path's former inline loop, lifted verbatim: a key
 * starting with `_` is metadata and is skipped; so is an entry with no (or a
 * falsy) `as`, and one whose `as` is anything but the string `'null'` while
 * `isAvailable` is false; `imagesrcset` / `imagesizes` ride along when present.
 *
 * Pure — parameters only, the #B60 / #B61 shape: in prod this module is a
 * singleton shared by concurrent renders, so nothing here may read `self`,
 * `local` or `localOptions` from an enclosing scope. The compile path calls it
 * once per view and memoises the result on the compiled-template cache entry
 * (`cacheObject.h2Link`), which is what the cache-hit path emits.
 *
 * @param {string|undefined} h2Links - The per-request `localOptions.template.h2Links` prefix (`''` under http/2, `undefined` otherwise)
 * @param {object|undefined} assets  - The parsed `getAssets()` map: asset URL → `{ as, isAvailable, imagesrcset?, imagesizes? }` plus `_`-prefixed metadata keys
 * @returns {string} The `link` header value — `''` when nothing qualifies (callers send no header then)
 *
 * @example
 * buildH2PreloadLinks('</css/app.css>; as=style; rel=preload,', {
 *     '/js/app.js' : { as: 'script', isAvailable: true },
 *     '_classes'   : ['x']
 * });
 * // → '</css/app.css>; as=style; rel=preload,</js/app.js>; as=script; rel=preload'
 */
function buildH2PreloadLinks(h2Links, assets) {
    var links = h2Links || '';
    if ( assets && typeof(assets) == 'object' ) {
        for (let l in assets) {
            let link = assets[l]
            if (
                /^_/.test(l)
                || typeof(link.as) == 'undefined'
                || typeof(link.as) != 'undefined'
                    && link.as != 'null'
                    && !link.isAvailable
                || !link.as
            ) {
                // ignoring
                continue;
            }

            links += '<'+ l +'>; as='+ link.as +'; '
            if ( link.imagesrcset) {
                links += 'imagesrcset='+ link.imagesrcset +'; ';
            }
            if ( link.imagesizes) {
                links += 'imagesizes='+ link.imagesizes +'; ';
            }
            links += 'rel=preload,'
        }
    }
    if ( /\,$/.test(links) ) {
        links = links.substring(0, links.length-1);
    }
    return links;
}
