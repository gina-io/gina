define('gina/nav', [ 'require', 'lib/merge', 'lib/uuid', 'utils/events' ], function (require) {

    var merge   = require('lib/merge');
    var uuid    = require('lib/uuid');

    require('utils/events'); // events

    /**
     * Gina Navigation Handler (#SPA1 — Tier 1)
     *
     * Turns link clicks into fragment swaps on routes that opted into content
     * negotiation: the matched route must declare `negotiate: true` in
     * routing.json, and the page must carry a `data-gina-nav` swap region.
     *
     * Activation is OPT-IN per page/project: the first element carrying
     * `data-gina-nav` (with any value but `"false"` — that spelling is the
     * per-link opt-out) is BOTH the opt-in signal and the region whose content
     * each fetched fragment replaces. Without the marker the handler stays
     * inert, so upgrading the framework never changes navigation behaviour on
     * existing pages.
     *
     * What a navigation does:
     *  1. a delegated document-level click listener resolves the anchor and
     *     defers to the link plugin (`data-gina-link*`) and to dialog/popin
     *     triggers (`data-gina-dialog*` / `data-gina-popin-*`), skips modified
     *     and non-left clicks, `target`/`download` links, cross-origin URLs,
     *     in-page hash moves and `data-gina-nav="false"` links;
     *  2. the URL is matched client-side against the served routing table
     *     (`gina.config.routing`) with the same semantics as the server scan —
     *     first match in table order wins; interception happens only when that
     *     route declares `negotiate: true` and accepts GET;
     *  3. the fragment is fetched over a FRESH XMLHttpRequest carrying
     *     `X-Gina-Navigate: fragment` (the negotiation signal) AND
     *     `X-Requested-With: XMLHttpRequest` (without it the render path
     *     re-wraps a layoutless body into a full `<html>` shell);
     *  4. a genuine negotiated answer — 2xx, HTML, `Vary` advertising
     *     `X-Gina-Navigate` — replaces the region's content, re-injects the
     *     fragment's src-bearing scripts the document does not already have
     *     (inline scripts are NOT executed — same contract as popin content),
     *     rebinds id-bearing forms through the live validator, closes any open
     *     popin (a full navigation would have unloaded it), pushes a history
     *     entry, restores focus/scroll, and fires `success`;
     *  5. ANY other answer falls back to a full-page navigation: non-2xx,
     *     timeout, network error, an un-negotiated 2xx (the `Vary` check —
     *     a client/server matching disagreement degrades to a normal page
     *     load), or a JSON `{location}` redirect (hard-followed, the
     *     established XHR convention).
     *
     * Browser floor: `history.pushState` + `Element.closest` (feature-guarded).
     * The ActiveX/attachEvent branches other plugins carry are unreachable
     * behind that floor, so this module uses plain `XMLHttpRequest` and a raw
     * `window.addEventListener('popstate', …)` — `utils/events`' addListener
     * reads `element.getAttribute` at registration, which `window` lacks.
     *
     * Usage — declarative (boot shim constructs when the marker exists):
     *      <main data-gina-nav>…server-rendered page content…</main>
     *
     * Usage — programmatic:
     *      gina.nav.navigate('/section/item-1');
     *
     * Events: `ready`, `navigate` (before the fetch), `success` (after a
     * swap), `error` (before a fallback navigation).
     *
     * @param {object} [options]
     * @param {number} [options.timeout=10000] - fragment fetch budget in ms; a
     *        timeout falls back to a full-page navigation
     * */
    function Nav(options) {

        this.plugin = 'nav';

        var events  = ['init', 'ready', 'navigate', 'success', 'error'];
        registerEvents(this.plugin, events);

        var self = { // local use only
            'options' : {
                // Fragment fetch budget (ms) — on expiry the navigation falls
                // back to a full page load of the same URL.
                'timeout': 10000
            }
        };

        var instance        = {
            plugin          : this.plugin,
            id              : 'gina-nav-' + uuid(),
            on              : on,
            eventData       : {},

            target          : document, // by default; the `data-gina-nav` region once activated
            isReady         : false,
            initialized     : false
        };

        // Navigation sequence — a response is applied only when its sequence is
        // still current, so an aborted/superseded XHR can never swap stale
        // content (#B175: the module-scope shared-XHR shape is the defect class
        // this deliberately avoids — every navigation opens a FRESH XHR).
        var _navSeq             = 0;
        var _xhr                = null;
        // Per-rule compiled matchers + the routing table object they were
        // compiled from. The table is read LAZILY at each navigation: it
        // arrives from an async fetch and can land after `isFrameworkLoaded`.
        var _compiled           = null;
        var _compiledFor        = null;
        // Scripts present at activation + scripts nav injected across swaps
        // (the popin `parentScripts` model): a fragment's src-bearing script is
        // injected once, never re-executed on later swaps.
        var _parentScripts      = [];
        var _injectedScripts    = [];
        // pathname+search last rendered — popstate events that do not change it
        // are hash-only moves and are left to the browser.
        var _currentUrl         = null;
        // Delegated listeners are installed once per instance lifecycle.
        var _listenersInstalled = false;


        /**
         * Safe decodeURI — mirrors the server's #B30 discipline (safeDecodeURI):
         * a malformed percent-sequence falls back to the raw input instead of
         * throwing, so a hand-typed `%` in a URL can never crash the matcher.
         *
         * @inner
         * @private
         * @param {string} str
         * @returns {string} decoded string, or `str` unchanged when malformed
         */
        var safeDecode = function(str) {
            try {
                return decodeURI(str);
            } catch (decodeErr) {
                return str;
            }
        };

        /**
         * Compiles one routing requirement value into a RegExp, mirroring the
         * server's fitsWithRequirements parsing verbatim: a `/body/flags` value
         * is split with the same greedy `match(/\/(.*)\//)`  extraction (so both
         * sides accept identical values), a bare string feeds `new RegExp()`
         * directly. `validator::` values never reach the client (filtered out
         * of the served map).
         *
         * @inner
         * @private
         * @param {string} requirement
         * @returns {object|null} RegExp, or null when malformed — the variant
         *          then becomes client-unmatchable (fail-open to a normal
         *          browser navigation, where the server would 500 instead)
         */
        var parseRequirement = function(requirement) {
            try {
                if ( /^\//.test(requirement) ) {
                    var body  = requirement.match(/\/(.*)\//).pop();
                    var flags = requirement.replace('/' + body + '/', '');
                    return new RegExp(body, flags);
                }
                return new RegExp(requirement);
            } catch (reErr) {
                return null;
            }
        };

        /**
         * Compiles ONE url variant of a route into an array of segment
         * matchers, or null when the variant cannot be matched client-side.
         *
         * Mirrored server semantics (parseRouting + fitsWithRequirements):
         * literal segments compare strict-equal; a pure `:key` segment tests
         * its requirement when one is declared, otherwise it accepts any
         * NON-EMPTY segment only when the served `param` block declares the
         * key (fitsWithRequirements returns false otherwise). A mixed
         * literal+param segment (`page:number`) is matchable server-side but
         * deliberately UNMATCHABLE here in Tier 1 — no interception, normal
         * navigation (false-negative-safe).
         *
         * @inner
         * @private
         * @param {string} url - one variant (already comma-split)
         * @param {object} route - the served route object
         * @returns {array|null} segment matchers ({lit} | {key, re}) or null
         */
        var compileVariant = function(url, route) {
            var segments = String(url).split(/\//);
            var out = [];
            for (var i = 0, len = segments.length; i < len; ++i) {
                var seg = segments[i];
                if ( seg.indexOf(':') < 0 ) {
                    out.push({ 'lit': seg });
                    continue;
                }
                if ( !/^\:[-_a-zA-Z0-9]+$/.test(seg) ) {
                    return null;
                }
                var key = seg.substring(1);
                if ( route.requirements && typeof(route.requirements[key]) != 'undefined' ) {
                    var re = parseRequirement(String(route.requirements[key]));
                    if (!re) {
                        return null;
                    }
                    out.push({ 'key': key, 're': re });
                    continue;
                }
                if ( route.param && typeof(route.param[key]) != 'undefined' ) {
                    out.push({ 'key': key, 're': null });
                    continue;
                }
                return null;
            }
            return out;
        };

        /**
         * Returns the compiled candidate list for the CURRENT routing table,
         * (re)compiling when the table object changed identity. Candidate
         * filtering mirrors the server scan: paramless routes are skipped,
         * foreign-bundle routes are skipped, and — for a GET navigation —
         * single-method routes survive only as GET or DELETE (the server's
         * GET→DELETE override keeps such a route as a BLOCKING candidate so
         * the client can never intercept across it), while multi-method routes
         * always reach URL comparison.
         *
         * @inner
         * @private
         * @returns {array|null} compiled candidates, or null when the routing
         *          table has not been fetched yet
         */
        var getCompiled = function() {
            var config  = ( window.gina && window.gina.config ) ? window.gina.config : null;
            var routing = ( config && config.routing && typeof(config.routing) == 'object' ) ? config.routing : null;
            if ( !routing ) {
                return null;
            }
            if ( _compiledFor === routing && _compiled ) {
                return _compiled;
            }
            var bundle   = config.bundle;
            var compiled = [];
            for (var rule in routing) {
                var route = routing[rule];
                if ( !route || typeof(route) != 'object' ) continue;
                if ( typeof(route.param) == 'undefined' ) continue;
                if ( route.bundle != bundle ) continue;
                var method      = String(route.method || '');
                var hasComma    = /\,/.test(method);
                var singleClean = method.replace(/\s+/g, '');
                if ( !hasComma && !/^(get|delete)$/i.test(singleClean) ) continue;
                var isGet = hasComma
                    ? /(^|,)\s*get\s*(,|$)/i.test(method)
                    : /^get$/i.test(singleClean);
                var urls     = String(route.url).split(/\,/g);
                var variants = [];
                for (var u = 0, uLen = urls.length; u < uLen; ++u) {
                    variants.push( compileVariant(urls[u], route) );
                }
                compiled.push({
                    'rule'      : rule,
                    'route'     : route,
                    'isGet'     : isGet,
                    'variants'  : variants,
                    'rawUrl'    : String(route.url)
                });
            }
            _compiled    = compiled;
            _compiledFor = routing;
            return compiled;
        };

        /**
         * matchUrl
         *
         * Client-side URL→route matcher over the served routing table. First
         * match in table order wins — the server's own scan order, so both
         * sides resolve the same rule for the same pathname. The pathname is
         * matched decoded (safeDecode) with a raw exact-equality short-circuit
         * per route, both mirroring the server.
         *
         * A null return, or a match without `negotiate: true`, means the click
         * is left to the browser — the matcher is an interception FILTER, and
         * every uncertainty degrades to a normal navigation.
         *
         * @param {string} pathname - location pathname (no query string)
         * @returns {object|null} { rule, route, isGet } or null
         * */
        var matchUrl = function(pathname) {
            var compiled = getCompiled();
            if ( !compiled ) {
                return null;
            }
            var decoded = safeDecode(pathname);
            var segs    = decoded.split(/\//);
            for (var i = 0, len = compiled.length; i < len; ++i) {
                var c = compiled[i];
                if ( pathname === c.rawUrl || decoded === c.rawUrl ) {
                    return { 'rule': c.rule, 'route': c.route, 'isGet': c.isGet };
                }
                for (var v = 0, vLen = c.variants.length; v < vLen; ++v) {
                    var m = c.variants[v];
                    if ( !m || m.length !== segs.length ) continue;
                    var ok = true;
                    for (var s = 0, sLen = m.length; s < sLen; ++s) {
                        if ( typeof(m[s].lit) != 'undefined' ) {
                            if ( m[s].lit !== segs[s] ) { ok = false; break; }
                            continue;
                        }
                        if ( !segs[s] ) { ok = false; break; }
                        if ( m[s].re && !m[s].re.test(segs[s]) ) { ok = false; break; }
                    }
                    if (ok) {
                        return { 'rule': c.rule, 'route': c.route, 'isGet': c.isGet };
                    }
                }
            }
            return null;
        };

        /**
         * Snapshots the src of every script present in the document at
         * activation — the popin `parentScripts` model. Scripts already loaded
         * with the page are never re-injected from a fragment.
         *
         * @inner
         * @private
         */
        var snapshotParentScripts = function() {
            var scripts = document.getElementsByTagName('script');
            for (var i = 0, len = scripts.length; i < len; ++i) {
                if ( scripts[i].src ) {
                    _parentScripts.push(scripts[i].src);
                }
            }
        };

        /**
         * Re-injects the fragment's src-bearing scripts the document does not
         * already have (mirrors popinOpen's external-resource loading). Inline
         * scripts are NOT executed — innerHTML semantics, the same contract
         * popin content has always had. Injected scripts persist across later
         * swaps (a page never "closes"); the registry keeps them single-shot.
         *
         * @inner
         * @private
         * @param {object} $target - the swapped region
         */
        var injectFragmentScripts = function($target) {
            var scripts = $target.getElementsByTagName('script');
            for (var i = 0, len = scripts.length; i < len; ++i) {
                var src = scripts[i].src; // resolved absolute URL
                if ( !src ) continue;
                if ( _parentScripts.indexOf(src) > -1 || _injectedScripts.indexOf(src) > -1 ) continue;
                var s = document.createElement('script');
                s.src = src;
                document.head.appendChild(s);
                _injectedScripts.push(src);
            }
        };

        /**
         * Rebinds id-bearing forms of the swapped region through the live
         * validator (`gina.validator.validateFormById` — the popinBind model).
         * Id-less forms are skipped: validation rules are keyed by form id, so
         * no rule can target them. A missing/ruleless validator is a no-op.
         *
         * @inner
         * @private
         * @param {object} $target - the swapped region
         */
        var rebindValidator = function($target) {
            try {
                if ( !gina.hasValidator || !gina.validator || typeof(gina.validator.validateFormById) != 'function' ) {
                    return;
                }
                var $forms = $target.getElementsByTagName('form');
                for (var i = 0, len = $forms.length; i < len; ++i) {
                    var _id = $forms[i].getAttribute('id');
                    if ( !_id ) continue;
                    try {
                        gina.validator.validateFormById(_id);
                    } catch (bindErr) {
                        console.warn('[gina][nav] validator rebind skipped for `'+ _id +'`: '+ (bindErr.message || bindErr));
                    }
                }
            } catch (validatorErr) {}
        };

        /**
         * Closes the active popin when one is open: a full-page navigation
         * would have unloaded it, and after a fragment swap it would sit over
         * content it no longer belongs to.
         *
         * @inner
         * @private
         */
        var closeActivePopin = function() {
            try {
                if ( gina.hasPopinHandler && gina.popin && typeof(gina.popin.getActivePopin) == 'function' ) {
                    var $active = gina.popin.getActivePopin();
                    if ( $active && $active.isOpen && typeof(gina.popin.close) == 'function' ) {
                        gina.popin.close($active.name);
                    }
                }
            } catch (popinCloseErr) {}
        };

        /**
         * Stores the current scroll position onto the CURRENT history entry
         * (replaceState) so a later Back restores it. The entry keeps its
         * `ginaNav` stamp.
         *
         * @inner
         * @private
         */
        var saveScrollOnCurrentEntry = function() {
            try {
                var st = window.history.state || {};
                st.ginaNav = true;
                st.scroll  = [ window.pageXOffset || 0, window.pageYOffset || 0 ];
                window.history.replaceState(st, '', window.location.href);
            } catch (histErr) {}
        };

        /**
         * Applies a fetched fragment: swaps the region content, re-injects
         * missing src scripts, applies the optional `[data-gina-nav-title]`
         * document title, pushes/updates history, restores scroll and focus,
         * closes any open popin, rebinds validator forms and fires `success`.
         *
         * @inner
         * @private
         * @param {string} html - the layoutless fragment body
         * @param {string} url - the navigated URL (pathname + search [+ hash])
         * @param {boolean} isPopState - popstate re-render (no history push)
         * @param {object} [navOptions] - { scroll: [x, y] } on popstate
         */
        var applyFragment = function(html, url, isPopState, navOptions) {
            var $target = instance.target;
            $target.innerHTML = ( typeof(html) == 'string' ) ? html.trim() : '';

            injectFragmentScripts($target);

            // Optional per-page document title: the first element of the
            // fragment carrying `data-gina-nav-title` (the fragment is
            // layoutless, so it cannot carry a <title> of its own).
            var $titled = ( typeof($target.querySelector) == 'function' ) ? $target.querySelector('[data-gina-nav-title]') : null;
            if ( $titled ) {
                var _title = $titled.getAttribute('data-gina-nav-title');
                if (_title) {
                    document.title = _title;
                }
            }

            if ( !isPopState ) {
                // Store the leaving entry's scroll, then push the new one.
                saveScrollOnCurrentEntry();
                try {
                    window.history.pushState({ 'ginaNav': true }, '', url);
                } catch (pushErr) {}
            }
            _currentUrl = window.location.pathname + window.location.search;

            // Focus first (preventScroll where supported), then the explicit
            // scroll decision wins: restored position on popstate, `#hash`
            // target or top on a forward navigation.
            try {
                if ( !$target.getAttribute('tabindex') ) {
                    $target.setAttribute('tabindex', '-1');
                }
                $target.focus({ 'preventScroll': true });
            } catch (focusErr) {
                try { $target.focus(); } catch (focusRetryErr) {}
            }
            var _scroll = ( isPopState && navOptions && navOptions.scroll ) ? navOptions.scroll : null;
            if ( _scroll ) {
                window.scrollTo(_scroll[0] || 0, _scroll[1] || 0);
            } else {
                var _hash   = ( url.indexOf('#') > -1 ) ? url.substring(url.indexOf('#') + 1) : null;
                var $anchor = ( _hash ) ? document.getElementById(_hash) : null;
                if ( $anchor && typeof($anchor.scrollIntoView) == 'function' ) {
                    $anchor.scrollIntoView();
                } else {
                    window.scrollTo(0, 0);
                }
            }

            closeActivePopin();
            rebindValidator($target);

            instance.eventData.success = { 'url': url, 'target': $target, 'isPopState': isPopState };
            triggerEvent(gina, instance.target, 'success.' + instance.id, instance.eventData.success);
        };

        /**
         * Falls back to a full-page navigation, firing `error` first so
         * consumers can observe/log. On a popstate the address bar already
         * shows the target, so the fallback is a reload.
         *
         * @inner
         * @private
         * @param {string} url
         * @param {boolean} isPopState
         * @param {object} errorData - { status, error }
         */
        var fallback = function(url, isPopState, errorData) {
            instance.eventData.error = errorData || {};
            triggerEvent(gina, instance.target, 'error.' + instance.id, instance.eventData.error);
            if ( isPopState ) {
                window.location.reload();
            } else {
                window.location.href = url;
            }
        };

        /**
         * Handles a completed fragment XHR. Discrimination is protocol-level:
         * a genuine negotiated answer always advertises `Vary: X-Gina-Navigate`
         * (the #SPA1 controller contract) — a 2xx WITHOUT it means the server
         * dispatched a route the client matched differently, and the honest
         * recovery is a normal page load. A JSON `{location}` body is the
         * established XHR redirect protocol and is hard-followed.
         *
         * @inner
         * @private
         * @param {object} xhr
         * @param {string} url
         * @param {boolean} isPopState
         * @param {object} [navOptions]
         */
        var onNavResponse = function(xhr, url, isPopState, navOptions) {
            var status = xhr.status;
            if ( /^2/.test(String(status)) ) {
                var contentType = xhr.getResponseHeader('Content-Type') || '';
                if ( /application\/json/.test(contentType) ) {
                    var result = null;
                    try {
                        result = JSON.parse(xhr.responseText);
                    } catch (parseErr) {}
                    if ( result && typeof(result.location) != 'undefined' && result.location ) {
                        window.location.href = result.location;
                        return;
                    }
                    return fallback(url, isPopState, { 'status': status, 'error': 'unexpected JSON answer to a fragment request' });
                }
                var vary = xhr.getResponseHeader('Vary') || '';
                if ( !/x-gina-navigate/i.test(vary) ) {
                    return fallback(url, isPopState, { 'status': status, 'error': 'response is not negotiated (no `Vary: X-Gina-Navigate`)' });
                }
                return applyFragment(xhr.responseText, url, isPopState, navOptions);
            }
            fallback(url, isPopState, { 'status': status || 0, 'error': xhr.statusText || 'network error or timeout' });
        };

        /**
         * navigate
         *
         * Fetches the URL's negotiated fragment and swaps it into the
         * `data-gina-nav` region. Every uncertainty (non-2xx, timeout, network
         * error, un-negotiated answer, JSON redirect) degrades to a full-page
         * navigation of the same URL, so a programmatic call on a
         * non-negotiable route behaves like `window.location.href = url`.
         *
         * A FRESH XMLHttpRequest is opened per navigation and any in-flight
         * one is aborted; its handlers observe a stale sequence and drop out,
         * so two rapid navigations can never interleave content.
         *
         * @param {string} url - same-origin URL (pathname + search [+ hash])
         * @param {object} [navOptions]
         * @param {boolean} [navOptions.isPopState=false] - popstate re-render
         * @param {array} [navOptions.scroll] - [x, y] to restore on popstate
         * */
        var navigate = function(url, navOptions) {
            if ( !url || typeof(url) != 'string' ) {
                return;
            }
            if ( !instance.isReady || instance.target === document ) {
                // Not activated (no marker) — behave like a plain navigation.
                window.location.href = url;
                return;
            }
            var isPopState = ( navOptions && navOptions.isPopState ) ? true : false;
            var seq = ++_navSeq;
            if ( _xhr && _xhr.readyState !== 4 ) {
                try {
                    _xhr.abort();
                } catch (abortErr) {}
            }

            instance.eventData.navigate = { 'url': url, 'isPopState': isPopState };
            triggerEvent(gina, instance.target, 'navigate.' + instance.id, instance.eventData.navigate);

            // Fresh XHR per navigation — prevents concurrent navigations from
            // sharing state (#B175).
            var xhr = new XMLHttpRequest();
            _xhr = xhr;
            xhr.open('GET', url);
            // Both headers, deliberately:
            //  - `X-Gina-Navigate` is the #SPA1 negotiation signal (the
            //    controller resolves the layoutless shape and advertises Vary
            //    on negotiable routes);
            //  - `X-Requested-With` keeps the request on the established XHR
            //    paths — without it the render path re-wraps the layoutless
            //    body into a full `<html>` shell (render-swig iframe case),
            //    and redirects/errors leave the proven JSON protocol.
            xhr.setRequestHeader('X-Gina-Navigate', 'fragment');
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            xhr.timeout = self.options.timeout;
            xhr.onreadystatechange = function() {
                if ( xhr.readyState !== 4 ) {
                    return;
                }
                if ( seq !== _navSeq ) {
                    return; // superseded — a newer navigation owns the page
                }
                // status 0 with a CURRENT sequence is a network failure or the
                // timeout's internal abort (a supersede-abort is always stale
                // by construction: the sequence increments before the abort).
                onNavResponse(xhr, url, isPopState, navOptions);
            };
            xhr.send();
        };

        /**
         * The delegated document-level click handler — the popin
         * bindDelegatedOpen model, so links inside swapped fragments are
         * covered with no rebinding. Every skip rule below defers to an
         * existing owner or to the browser; interception happens only for a
         * same-origin left-click resolving to a first-match route that
         * declares `negotiate: true` and accepts GET.
         *
         * @inner
         * @private
         * @param {object} event - the click event
         */
        var onDocumentClick = function(event) {
            if ( event.defaultPrevented ) return;
            if ( typeof(event.button) == 'number' && event.button !== 0 ) return;
            if ( event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ) return;
            var $a = ( event.target && typeof(event.target.closest) == 'function' )
                ? event.target.closest('a[href]')
                : null;
            if ( !$a ) return;
            // Ownership deference — the link plugin and the dialog/popin
            // triggers keep their own handlers.
            if ( $a.getAttribute('data-gina-link') != null || $a.getAttribute('data-gina-link-url') != null ) return;
            if ( $a.getAttribute('data-gina-dialog') != null || $a.getAttribute('data-gina-dialog-src') != null ) return;
            if ( $a.getAttribute('data-gina-popin-name') != null || $a.getAttribute('data-gina-popin-url') != null ) return;
            // Per-link opt-out.
            if ( /^false$/i.test($a.getAttribute('data-gina-nav')) ) return;
            var targetAttr = $a.getAttribute('target');
            if ( targetAttr && !/^_self$/i.test(targetAttr) ) return;
            if ( $a.getAttribute('download') != null ) return;
            var href = $a.getAttribute('href');
            if ( !href || /^#/.test(href) ) return;
            // Same-origin only — the anchor element is the URL parser.
            if ( $a.protocol !== window.location.protocol || $a.host !== window.location.host ) return;
            // In-page hash move on the same document — the browser handles it.
            if ( $a.pathname === window.location.pathname && $a.search === window.location.search && $a.hash ) return;

            var matched = matchUrl($a.pathname);
            if ( !matched || matched.route.negotiate !== true || !matched.isGet ) return;

            cancelEvent(event);
            navigate($a.pathname + $a.search + $a.hash);
        };

        /**
         * Installs the delegated click listener and the popstate handler —
         * once per instance lifecycle.
         *
         * @inner
         * @private
         */
        var installListeners = function() {
            if ( _listenersInstalled ) {
                return;
            }
            _listenersInstalled = true;

            addListener(gina, document, 'click', function(event) {
                try {
                    onDocumentClick(event);
                } catch (navClickErr) {
                    // An interception error must never eat the click — the
                    // browser keeps handling it.
                    console.warn('[gina][nav] click interception skipped: '+ (navClickErr.message || navClickErr));
                }
            });

            // Raw addEventListener: utils/events' addListener reads
            // `element.getAttribute` at registration and `window` has neither
            // `id` nor `getAttribute`.
            window.addEventListener('popstate', function(event) {
                try {
                    var _url = window.location.pathname + window.location.search;
                    if ( _url === _currentUrl ) {
                        return; // hash-only move on the same document
                    }
                    var st = event.state;
                    if ( st && st.ginaNav ) {
                        navigate(_url + window.location.hash, { 'isPopState': true, 'scroll': st.scroll || null });
                        return;
                    }
                    // A history entry nav did not stamp (external history
                    // manipulation) — the only honest recovery is a full load
                    // of what the address bar shows.
                    window.location.reload();
                } catch (popErr) {
                    window.location.reload();
                }
            });
        };

        var init = function(options) {

            setupInstanceProto();
            instance.on('init', function(event) {

                self.options = merge(options || {}, self.options);

                // Swap-target + page opt-in in one marker. `"false"` is the
                // per-LINK opt-out spelling and must not opt a page in.
                var $marker = null;
                try {
                    $marker = document.querySelector('[data-gina-nav]:not([data-gina-nav="false"])');
                } catch (qsErr) {}

                if ( !$marker ) {
                    // Explicit construction on a page without the marker: warn
                    // and stay inert — no listeners, no publish, no behaviour
                    // change (the boot shim never constructs in this state).
                    console.warn('[gina][nav] no [data-gina-nav] region found — navigation interception stays off');
                    instance.isReady = true;
                    triggerEvent(gina, instance.target, 'ready.' + instance.id, instance);
                    return;
                }

                instance.target = $marker;
                _currentUrl     = window.location.pathname + window.location.search;
                snapshotParentScripts();
                try {
                    if ( window.history && 'scrollRestoration' in window.history ) {
                        window.history.scrollRestoration = 'manual';
                    }
                    // Stamp the entry page so a Back onto it is recognised as
                    // nav-owned and re-rendered as a fragment.
                    var _st = window.history.state || {};
                    _st.ginaNav = true;
                    window.history.replaceState(_st, '', window.location.href);
                } catch (histErr) {}

                installListeners();

                instance.isReady = true;
                gina.hasNavHandler = true;
                // #B90 — publish ONCE: `gina.nav` IS the first activated
                // instance (a LIVE object); later constructions have nothing
                // to publish, and re-merging would freeze accessors/state.
                if ( typeof(gina.nav) == 'undefined' || !gina.nav ) {
                    gina.nav = instance;
                }
                triggerEvent(gina, instance.target, 'ready.' + instance.id, instance);
            });

            instance.initialized = true;

            return instance;
        };

        var setupInstanceProto = function() {
            instance.navigate = navigate;
            instance.matchUrl = matchUrl;
        };

        return init(options);
    }

    return Nav;
});
