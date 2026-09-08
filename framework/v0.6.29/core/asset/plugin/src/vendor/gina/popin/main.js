define('gina/popin', [ 'require', 'lib/domain', 'lib/loading-state', 'lib/merge', 'utils/events' ], function (require) {

    // TODO - Integrate dialog-polyfill : https://github.com/GoogleChrome/dialog-polyfill/blob/master/dist/dialog-polyfill.js
    var Domain          = require('lib/domain');
    var domainInstance  = null;
    var loadingState    = require('lib/loading-state');
    var merge           = require('lib/merge');

    require('utils/events'); // events

    /** @type {number} Auto-incrementing ID counter for internal popin identifiers */
    var _uid = 0;
    /**
     * Generates a lightweight unique ID for internal use (event names, DOM element IDs).
     * Replaces crypto.randomUUID() to avoid unnecessary crypto overhead.
     *
     * @inner
     * @param {string} [prefix='gp'] - Optional prefix
     * @returns {string} Unique ID string
     */
    function _nextId(prefix) { return (prefix || 'gp') + '-' + (++_uid); }

    /**
     * Module-level preload cache, keyed by URL. Warmed by the delegated
     * mouseover/focusin listeners (installPreload) and by the opt-in idle eager
     * pass (installEagerPreload); consumed once at open time (consumePreload).
     * Shared across popin instances so a warm entry survives the subsequent
     * click. A reserved-but-not-yet-loaded entry is `null` (in-flight).
     *
     * #B139 — an entry never outlives the open it warmed: popinUnbind clears
     * the consumed URL's slot at close (clearContentPreload), so a reopen's own
     * hover/focus warm fetches CURRENT content instead of dedup-ing against a
     * previous open's leftover. Pre-fix the leftover (the around-open re-warm,
     * or the #B54 in-flight adoption's repopulated body) blocked the fresh warm
     * and every open rendered the PREVIOUS open's fetch — a one-generation-
     * lagging cache paying ~1 GET per open for content it never showed.
     *
     * @inner
     * @type {object}
     */
    var preloadCache = {};
    // preloadWaiters[url] = [fn, ...] — callbacks parked by a click that adopted an
    // in-flight preload; preloadFetch fires them with the body (or null on failure) so a
    // click reuses the prefetch instead of issuing a second identical GET (#B54).
    var preloadWaiters = {};

    /**
     * Module-level popin registry shared by EVERY Popin instance (#B90). Each
     * instance's `$popins` aliases this object, so the published accessors
     * (`gina.popin.getPopinByName` / `getPopinById` / `getActivePopin`) and
     * click-time registrations (in-page dialogs) resolve popins no matter
     * which `new Popin()` registered them. Entry ids stay unique across
     * instances (they embed `instance.id`).
     *
     * @inner
     * @type {object}
     */
    var _sharedPopins = {};

    /** @inner @type {object} warn-once registry, keyed by deprecated attribute name */
    var _deprecationWarned = {};

    /**
     * warnDeprecatedOnce
     *
     * Emits a one-time `console.warn` for a deprecated, *developer-authored* legacy
     * trigger attribute — only `data-gina-popin-name` and `data-gina-popin-url` reach
     * here (at most two distinct warnings for the life of the page). The
     * engine-managed `data-gina-popin-is-link` / `data-gina-popin-loading` attributes
     * are written by gina itself and are NOT deprecated, so they never warn.
     *
     * @inner
     * @param {string} kind - the legacy attribute name
     * @returns {void}
     */
    function warnDeprecatedOnce(kind) {
        if ( _deprecationWarned[kind] ) {
            return;
        }
        _deprecationWarned[kind] = true;
        if ( typeof(console) != 'undefined' && typeof(console.warn) == 'function' ) {
            var replacement = ( kind === 'data-gina-popin-name' ) ? 'data-gina-dialog' : 'data-gina-dialog-src';
            console.warn(
                '[gina/popin] `' + kind + '` is deprecated; use `' + replacement + '` instead. '
                + 'The legacy attribute still works (mapped onto the new dialog path).'
            );
        }
    }

    /** @inner @type {boolean} module guard — the delegated open listener is installed once */
    var _ginaDialogDelegated = false;
    /** @inner @type {boolean} module guard — the preload listeners are installed once */
    var _ginaPreloadInstalled = false;
    /** @inner @type {boolean} module guard — the idle eager-preload pass is installed once */
    var _ginaEagerInstalled = false;

    /**
     * Gina Popin Handler
     *
     * @param {object} options
     * @param {string} options.name - unique popin name (the `data-gina-popin-name` trigger value)
     * @param {string} [options.class='gina-popin-default'] - extra CSS class on the popin container
     * @param {boolean} [options.useDialogMode=true] - use a native `<dialog>` (modal) instead of a `<div>` + overlay
     * @param {boolean} [options.cancelOnOverlayClick=false] - close the popin when the backdrop/overlay is clicked
     * @param {boolean} [options.preOpen=false] - opt-in: open the popin with a loading skeleton BEFORE the XHR
     *        returns (no blank-screen gap), replaced by the real content on completion. See showLoadingShell().
     * @param {string} [options.loadingShell] - custom skeleton HTML for `preOpen` (consumer markup wins);
     *        when omitted a generic gina-namespaced default skeleton is used.
     * @param {object} [options.validator] - a FormValidator instance to bind forms inside the popin
     * */
    function Popin(options) {

        this.plugin = 'popin';

        var events  = ['init', 'loaded', 'ready', 'open', 'close', 'click', 'destroy', 'success', 'error', 'progress'];
        registerEvents(this.plugin, events);

        var self = { // local use only
            'options' : {
                'name' : undefined,
                'class': 'gina-popin-default',
                // Support of `<dialog>` tag, set `true`
                'useDialogMode': true,
                'cancelOnOverlayClick': false,
                // Opt-in skeleton-loading pre-open: when `true`, the popin is filled with a
                // loading skeleton and opened BEFORE the XHR returns, then the real content
                // replaces the skeleton on completion. Off by default — pre-opening during
                // the load is a behavior change vs the default "open on content-complete"
                // path. See showLoadingShell().
                'preOpen': false,
                // Optional skeleton markup for `preOpen`: a string of HTML injected into the
                // popin while it loads. When omitted, a generic gina-namespaced default
                // skeleton is used (styled by `.gina-popin-skeleton*` in popin.css).
                'loadingShell': null,
                // Per-popin modal opt-in (precedence #2 in resolveModal). `null` => fall
                // through to the trigger `data-gina-dialog-modal` attribute, then the
                // `gina.config.popin.modal` project default, then the framework
                // non-modal default. Set `true`/`false` via `new Popin({ modal })`.
                'modal': null
            },
            authorizedEvents : ['ready', 'error'],
            events: {}
        };

        // Snapshot the per-popin `modal` option (precedence #2) from the constructor
        // arg, so resolveModal() can read it. `gina.config.popin.modal` (precedence #4)
        // is read lazily at open time — it is populated post-load via setOptions.
        if ( options && typeof(options.modal) != 'undefined' ) {
            self.options.modal = options.modal;
        }

        var instance        = {
            plugin          : this.plugin,
            id              : 'gina-popins-' + _nextId(),
            on              : on,
            eventData       : {},

            '$popins'       : _sharedPopins, // #B90 — module-shared registry (one object for all instances)
            activePopinId   : null,
            getActivePopin  : null, // returns the active $popin
            target          : document, // by default
            isReady         : false,
            initialized     : false
        };

        // popin proto
        var $popin          = { // is on main `gina-popins` container (first level)
            'plugin'            : this.plugin,
            'on'                : on,
            'eventData'         : {},
            'target'            : document, // by default

            'name'              : null,
            'load'              : null,
            'loadContent'       : null,
            'open'              : null,
            'isOpen'            : false,
            'isRedirecting'     : false,
            'close'             : null,
            '$forms'            : [],
            'hasForm'           : false,
            '$headers'             : [] // head elements for this popin
        };

        // imopring other plugins
        var $validatorInstance   = null; // validator instance


        // XML Request
        var xhr = null;

        var registeredPopins = [];

        // Cached regex — avoids repeated RegExp construction in click handlers
        var _rePopinClick = new RegExp('^popin\\.click\\.gina-popin-' + instance.id);


        /**
         * popinCreateContainer
         *
         * Creates HTML container and add it to the DOM
         *
         *
         * */
        var popinCreateContainer = function() {

            // creating template
            // <div class="gina-popins">
            //     <div class="gina-popins-overlay gina-popin-is-active"></div>
            // </div>
            var $container = document.createElement('div');
            $container.id = instance.id;
            $container.setAttribute('id', instance.id);
            $container.setAttribute('class', 'gina-popins');

            // Non-dialog mode only: the manual .gina-popins-overlay provides the dimming/
            // click-catcher backdrop for non-dialog popins. Dialog-mode popins open as
            // native modals in every env (see the showModal() branch in this file) and use
            // the native ::backdrop, so they no longer need this overlay.
            if ( !self.options.useDialogMode ) {
                var $overlay = document.createElement('div');
                $overlay.setAttribute('id', 'gina-popins-overlay');
                $overlay.setAttribute('class', 'gina-popins-overlay');
                $container.appendChild( $overlay );
            }

            // adding to DOM
            document.body.appendChild($container);

            instance.target     = $container;
            instance.on         = on;

            gina.popinContainer  = instance.id;
            //gina.hasPopinHandler = true;
        }

        var popinGetContainer = function () {
            instance.target     = document.getElementById(gina.popinContainer);
            instance.on         = on;
        }

        var proxyClick = function($childNode, $el, evt) {
            addListener(gina, $childNode, 'click', function(e) {
                cancelEvent(e);

                triggerEvent(gina, $el, evt);
            });
        }

        /**
         * setActivePopinId
         *
         * Single write path for the active-popin id (#B90): keeps the instance
         * mirror and the PUBLISHED `gina.popin.activePopinId` in sync, so
         * getActivePopin()'s id-fallback works no matter which Popin instance
         * opened (or closed) the popin. Pre-publish (no `gina.popin` yet), the
         * instance value alone is enough — the first publish exposes it.
         *
         * @inner
         * @param {string|null} id - the active popin id, or null to clear
         * @returns {void}
         */
        var setActivePopinId = function(id) {
            instance.activePopinId = id;
            if ( typeof(gina.popin) != 'undefined' && gina.popin ) {
                gina.popin.activePopinId = id;
            }
        }

        var getPopinById = function(id) {
            return ( typeof(instance.$popins[id]) != 'undefined' ) ? instance.$popins[id] : null;
        }

        var getPopinByName = function(name) {

            var $popin = null;

            for (var p in instance.$popins) {
                if ( instance.$popins[p].name === name ) {
                    $popin = instance.$popins[p];
                    break;
                }
            }

            return $popin;
        }

        function getActivePopin() {
            var $popin = null;

            for (var p in gina.popin.$popins) {
                if ( typeof(gina.popin.$popins[p].isOpen) != 'undefined' && gina.popin.$popins[p].isOpen ) {
                    $popin = gina.popin.$popins[p];
                    break;
                }
            }

            if (!$popin && gina.popin.activePopinId) {
                $popin = gina.popin.$popins[gina.popin.activePopinId]
            }

            return $popin;
        }


        // ─────────────────────────────────────────────────────────────────────────
        // New `data-gina-dialog-*` entry layer (strangler — funnels into the existing
        // popinLoad / popinBind / popinOpen engine). Additive: the legacy bindOpen scan
        // and per-element binding below are kept intact for full parity.
        // ─────────────────────────────────────────────────────────────────────────

        /**
         * resolveModal
         *
         * Resolves whether a trigger opens a modal dialog. Precedence (highest wins):
         *  1. legacy trigger (`data-gina-popin-name`) -> modal (today's showModal()-only parity)
         *  2. `data-gina-dialog-modal` on the trigger -> `"false"` => non-modal, else modal
         *  3. `new Popin({ modal })` per-popin option (`self.options.modal`)
         *  4. `gina.config.popin.modal` project default (read lazily — populated post-load)
         *  5. framework default -> non-modal
         *
         * @inner
         * @param {HTMLElement} $trigger
         * @param {boolean} [isLegacy] - precomputed legacy flag (resolveTrigger passes it)
         * @returns {boolean}
         */
        function resolveModal($trigger, isLegacy) {
            // 1. Legacy popins are always modal (showModal()-only, full parity).
            if ( isLegacy || $trigger.getAttribute('data-gina-popin-name') != null ) {
                return true;
            }
            // 2. Explicit attribute on the trigger. Value-parsed, no separate default:
            //    `="false"` => non-modal; present with any other value => modal.
            var attr = $trigger.getAttribute('data-gina-dialog-modal');
            if ( attr != null ) {
                return ( attr === 'false' ) ? false : true;
            }
            // 3. Per-popin constructor option.
            if ( self.options.modal === true || self.options.modal === false ) {
                return self.options.modal;
            }
            // 4. Project config — read lazily at open time (gina.config is populated
            //    post-load via setOptions, so it may be unset when the constructor ran).
            if (
                typeof(gina) != 'undefined' && gina.config && gina.config.popin
                && ( gina.config.popin.modal === true || gina.config.popin.modal === false )
            ) {
                return gina.config.popin.modal;
            }
            // 5. Framework default.
            return false;
        }

        /**
         * resolveTrigger
         *
         * Normalizes a trigger element (new `data-gina-dialog-*` or legacy
         * `data-gina-popin-*`) into a single descriptor consumed by openFromTrigger().
         * Only the two developer-authored legacy attributes are aliased + warned:
         * `data-gina-popin-name` -> `id`, `data-gina-popin-url` -> `src`. The
         * engine-managed `-is-link` / `-loading` attributes are read by the engine where
         * it already reads them and are never deprecated here.
         *
         * @inner
         * @param {HTMLElement} $trigger
         * @returns {object} { id, src, isLegacy, modal, partialTarget, isLink, formSubmit }
         */
        function resolveTrigger($trigger) {
            var isLegacy = false;
            var id  = $trigger.getAttribute('data-gina-dialog');
            var src = $trigger.getAttribute('data-gina-dialog-src');

            // Legacy aliasing — only the two developer-authored attributes (warn once each).
            if ( id == null && $trigger.getAttribute('data-gina-popin-name') != null ) {
                isLegacy = true;
                id = $trigger.getAttribute('data-gina-popin-name');
                warnDeprecatedOnce('data-gina-popin-name');
            }
            if ( src == null && $trigger.getAttribute('data-gina-popin-url') != null ) {
                isLegacy = true;
                src = $trigger.getAttribute('data-gina-popin-url');
                warnDeprecatedOnce('data-gina-popin-url');
            }
            // An <a href> doubles as the source for both APIs (ignore empty / "#" anchors).
            if ( src == null && /^A$/i.test($trigger.tagName) ) {
                var href = $trigger.getAttribute('href');
                if ( href && href != '' && href != '#' && !/^#/.test(href) ) {
                    src = href;
                }
            }

            return {
                'id'            : id
                , 'src'         : src
                , 'isLegacy'    : isLegacy
                , 'modal'       : resolveModal($trigger, isLegacy)
                , 'partialTarget' : $trigger.getAttribute('data-gina-dialog-target')
                // engine-managed (read, not deprecated) — surfaced for openFromTrigger
                , 'isLink'      : /^true$/i.test($trigger.getAttribute('data-gina-popin-is-link'))
                , 'formSubmit'  : /^true$/i.test($trigger.getAttribute('data-gina-form-submit'))
            };
        }

        /**
         * wireTriggerAria — adds `aria-haspopup="dialog"` + `aria-controls="ID"` to a
         * trigger so assistive tech announces the relationship.
         *
         * @inner
         */
        function wireTriggerAria($trigger, id) {
            if ( !$trigger || !id ) {
                return;
            }
            $trigger.setAttribute('aria-haspopup', 'dialog');
            $trigger.setAttribute('aria-controls', id);
        }

        /**
         * associateLabel — points the dialog's `aria-labelledby` at a REAL title element
         * (an `[id$="-title"]`, else the first heading), assigning an id if missing.
         * Fixes the legacy behavior of pointing `aria-labelledby` at the popin *name*.
         *
         * @inner
         */
        function associateLabel($el) {
            if ( !$el || typeof($el.querySelector) != 'function' ) {
                return;
            }
            var $title = $el.querySelector('[id$="-title"]') || $el.querySelector('h1, h2, h3, h4, h5, h6');
            if ( !$title ) {
                return;
            }
            if ( !$title.id ) {
                $title.id = ( $el.id || 'gina-popin' ) + '-title';
                $title.setAttribute('id', $title.id);
            }
            $el.setAttribute('aria-labelledby', $title.id);
        }

        /**
         * focusInitial — moves focus into the dialog after content is applied, honoring
         * an explicit `[autofocus]`, else the first focusable, else the dialog itself.
         * (Native showModal() already does this; the non-modal `.show()` path does not.)
         *
         * @inner
         */
        function focusInitial($el) {
            if ( !$el || typeof($el.querySelector) != 'function' ) {
                return;
            }
            var $target = $el.querySelector('[autofocus]')
                || $el.querySelector('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
            if ( $target && typeof($target.focus) == 'function' ) {
                $target.focus();
            } else if ( typeof($el.focus) == 'function' ) {
                if ( $el.getAttribute('tabindex') == null ) {
                    $el.setAttribute('tabindex', '-1');
                }
                $el.focus();
            }
        }

        /**
         * applyNonModalShims
         *
         * Native `<dialog>.showModal()` gives `Escape`->close, background inert, body
         * scroll-block and a focus trap for free; `.show()` (non-modal, the new-API
         * default) gives none of them. This restores them: an `Escape` keydown handler,
         * a body scroll-lock attribute (CSS), and best-effort `inert` on background
         * siblings. Torn down by removeNonModalShims() on close.
         *
         * "Background siblings" has to include any OTHER popin still open inside the
         * shared container: popinOpen() never closes the popin it supersedes, so a
         * second non-modal dialog would otherwise leave the first one fully
         * keyboard-reachable behind it. The container itself must stay reachable — it
         * holds $el — so it is descended into rather than skipped.
         *
         * Only `[open]` dialogs are inerted. A closed `<dialog>` is already
         * `display:none` per the UA stylesheet, so it is unreachable without help.
         *
         * @inner
         * @param {object} $popin - popin descriptor; the Escape handler closes by $popin.name
         * @param {HTMLElement} $el - the dialog element being shown non-modally
         * @returns {void}
         */
        function applyNonModalShims($popin, $el) {
            if ( !$el ) {
                return;
            }
            // body scroll-lock (styled by `body[data-gina-popin-scroll-lock]` in popin.css)
            document.body.setAttribute('data-gina-popin-scroll-lock', 'true');

            // Escape-to-close — native modal does this for free; .show() does not.
            var onKeydown = function (e) {
                if ( e.key === 'Escape' || e.keyCode === 27 ) {
                    e.preventDefault();
                    popinClose($popin.name);
                }
            };
            $el.__ginaOnKeydown = onKeydown;
            $el.addEventListener('keydown', onKeydown);

            // Best-effort background inert (skip the dialog and its ancestors; descend
            // into the container so a superseded popin does not stay reachable).
            var siblings = document.body.children;
            var b = 0, len = siblings.length;
            for (; b < len; ++b) {
                if ( siblings[b] === instance.target ) {
                    // The container holds $el, so it cannot be inerted wholesale — but any
                    // OTHER popin still open inside it would remain keyboard-reachable
                    // behind this one. Closed dialogs are already display:none (UA
                    // stylesheet), so [open] is the whole set that needs help.
                    var $open = siblings[b].querySelectorAll('dialog[open]');
                    var d = 0, dLen = $open.length;
                    for (; d < dLen; ++d) {
                        if ( $open[d] === $el || $open[d].contains($el) ) {
                            continue;
                        }
                        if ( $open[d].getAttribute('inert') == null ) {
                            $open[d].setAttribute('inert', '');
                            $open[d].setAttribute('data-gina-popin-inert', 'true');
                        }
                    }
                    continue;
                }
                if ( siblings[b] === $el || siblings[b].contains($el) ) {
                    continue;
                }
                if ( siblings[b].getAttribute('inert') == null ) {
                    siblings[b].setAttribute('inert', '');
                    siblings[b].setAttribute('data-gina-popin-inert', 'true');
                }
            }
        }

        /**
         * removeNonModalShims — teardown counterpart to applyNonModalShims (called from
         * popinClose). Idempotent — safe to call for popins that were opened modal.
         *
         * @inner
         */
        function removeNonModalShims($el) {
            document.body.removeAttribute('data-gina-popin-scroll-lock');
            if ( $el && $el.__ginaOnKeydown ) {
                $el.removeEventListener('keydown', $el.__ginaOnKeydown);
                $el.__ginaOnKeydown = null;
            }
            var $inert = document.querySelectorAll('[data-gina-popin-inert]');
            var b = 0, len = $inert.length;
            for (; b < len; ++b) {
                $inert[b].removeAttribute('inert');
                $inert[b].removeAttribute('data-gina-popin-inert');
            }
        }

        /**
         * applyContent
         *
         * Full (default): replace the whole element — byte-identical to the legacy
         * `$el.innerHTML = html.trim()`, so legacy popins are unaffected.
         * Partial (`partialTarget` set): parse the fetched HTML with DOMParser and swap
         * only the `partialTarget` region, so chrome (close button, header/footer) and
         * its bindings survive. Falls back to full-replace if the slot is absent.
         *
         * @inner
         */
        function applyContent($el, html, $popin, partialTarget) {
            if ( !partialTarget ) {
                $el.innerHTML = ( typeof(html) == 'string' ) ? html.trim() : '';
                return;
            }
            var $slot = $el.querySelector(partialTarget);
            if ( !$slot ) {
                $el.innerHTML = ( typeof(html) == 'string' ) ? html.trim() : '';
                return;
            }
            var parsed = new DOMParser().parseFromString(html, 'text/html');
            var $incoming = parsed.querySelector(partialTarget) || parsed.body;
            $slot.innerHTML = $incoming.innerHTML;
        }

        /**
         * handleLoadedBody
         *
         * Applies a loaded HTML body (full or partial per `$popin.partialTarget`),
         * (re)binds the dialog through the guarded popinBind path, and opens it. Used by
         * the preload-consume path; the click-time XHR keeps its own battle-tested
         * completion tail (redirect / JSON / CORS / toolbar) for parity.
         *
         * @inner
         */
        function handleLoadedBody(body, $popin, $el) {
            // $el may be absent on the cold-click path before popinLoad created it; ensure
            // it so applyContent injects into — and popinOpen later scans — a real element.
            $el = $el || ensurePopinDialog($popin);
            applyContent($el, body, $popin, $popin.partialTarget);
            popinUnbind($popin.name, true);
            popinBind({ target: $el, type: 'loaded.' + $popin.id }, $popin);
            if ( !$popin.isOpen ) {
                popinOpen($popin.name);
            }
            associateLabel($el);
            focusInitial($el);
        }

        /**
         * preloadFetch — small same-origin GET that mirrors popinLoad's `X-Requested-With`
         * + credentials so a preloaded response is interchangeable with a click-time load.
         * Cross-origin URLs are left for the click-time XHR/CORS path.
         *
         * @inner
         * @param {string} url - same-origin popin content URL
         * @param {function} [onDone] - completion callback, fired on EVERY exit path
         *   (cross-origin bail, cache, or decline) so a serialized caller — the
         *   eager warm queue — always advances. The hover path passes none.
         */
        function preloadFetch(url, onDone) {
            var _preloadDone = function () {
                if ( typeof(onDone) == 'function' ) { onDone(); }
            };
            if (
                /^(http|https):/.test(url)
                && !new RegExp('^' + window.location.protocol + '//' + window.location.host).test(url)
            ) {
                delete preloadCache[url];
                _preloadDone();
                return;
            }
            var xhrPreload = new XMLHttpRequest();
            xhrPreload.open('GET', url);
            xhrPreload.withCredentials = false;
            xhrPreload.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            xhrPreload.onreadystatechange = function () {
                if ( xhrPreload.readyState == 4 ) {
                    // #B54 — wake any click that adopted this in-flight preload instead of
                    // firing its own duplicate GET (see consumePreload).
                    var _waiters = preloadWaiters[url] || [];
                    delete preloadWaiters[url];
                    // #B80 — only cache a genuinely HTML fragment. A JSON response (an
                    // isXhrRedirect / reload / data payload) must NOT be injected as popin
                    // content: defer it to the click-time popinLoad, whose completion tail
                    // handles isXhrRedirect/reload/JSON exactly as a non-preloaded click.
                    // Mirrors popinLoad's own detection (`/application\/json/.test(Content-Type)`).
                    var _ct = xhrPreload.getResponseHeader('Content-Type');
                    if ( /^2/.test(xhrPreload.status) && !/application\/json/.test(_ct || '') ) {
                        preloadCache[url] = xhrPreload.responseText;
                        for ( var _w = 0; _w < _waiters.length; ++_w ) { _waiters[_w](xhrPreload.responseText); }
                    } else {
                        delete preloadCache[url];
                        for ( var _wf = 0; _wf < _waiters.length; ++_wf ) { _waiters[_wf](null); }
                    }
                    _preloadDone();
                }
            };
            xhrPreload.send();
        }

        /**
         * ensurePopinDialog — returns the popin's DOM element (a native `<dialog>` in
         * dialog mode, a `<div>` otherwise), creating + appending it under the container on
         * first use and returning the existing one thereafter (idempotent).
         *
         * The hover/focus preload path (consumePreload) short-circuits popinLoad() — which
         * is what otherwise creates the element — so without this the AJAX popin had no
         * element with `id === $popin.id` and popinOpen() threw
         * (`document.getElementById(id).getElementsByTagName(...)` on `null`). Mirrors the
         * create block popinLoad() runs at click time so both paths produce the same shape.
         *
         * @inner
         * @param {object} $popin
         * @returns {HTMLElement}
         */
        function ensurePopinDialog($popin) {
            var $el = document.getElementById($popin.id);
            if ( $el != null ) {
                return $el;
            }
            var className = $popin.options.class + ' ' + $popin.id;
            if ( !self.options.useDialogMode ) {
                // DIV + manual overlay (non-dialog mode)
                $el = document.createElement('div');
                $el.setAttribute('id', $popin.id);
                $el.setAttribute('class', className);
                instance.target.firstChild.appendChild($el);
            } else {
                // native <dialog> (top layer + ::backdrop)
                $el = document.createElement('dialog');
                $el.setAttribute('id', $popin.id);
                $el.setAttribute('class', className);
                $el.setAttribute('data-type', 'modal');
                $el.setAttribute('aria-labelledby', $popin.name);
                var $ov = document.getElementById('gina-popins-overlay');
                if ( $ov ) {
                    $ov.appendChild($el);
                } else {
                    instance.target.appendChild($el);
                }
            }
            return $el;
        }

        /**
         * consumePreload — reuse a hover/focus preload for `url` instead of firing a second
         * identical GET on click (#B54):
         *   - ready (cached body)      -> apply it now; return true.
         *   - in-flight (null slot)    -> park a waiter that applies the body when the
         *                                 preload resolves (or runs `onMiss` if it failed);
         *                                 return true (handled — caller must NOT also load).
         *   - never warmed (undefined) -> return false so the caller loads itself.
         *
         * Dev toolbar (#B225): both consume branches mirror the cold-click
         * loaded path's dev gate — GINA_ENV_IS_DEV sets the toolbar overlay
         * from the body right before the dispatch — so a warmed open surfaces
         * its rendered data exactly like a cold one. The set lives here and
         * NOT in handleLoadedBody: the cold path routes through the dispatcher
         * too, so a set there would double-fire the overlay.
         *
         * @inner
         * @param {string} url - the resolved popin URL.
         * @param {object} $popin - the registered popin.
         * @param {function} [onMiss] - the caller's click-time load, run only if an adopted
         *   in-flight preload ends up failing.
         * @param {function} [onSettled] - #B285: fired when this consume stops owing
         *   anything — synchronously after a ready (cached) apply, or when an adopted
         *   in-flight preload resolves (success AND failure, before the body/miss
         *   handling — the same release-before-apply order as popinLoad's readyState-4
         *   site). Deliberately a bare notifier: the CALLERS own any busy affordance,
         *   so this function stays loading-state-agnostic.
         * @returns {boolean} true if the preload was (or will be) consumed.
         */
        function consumePreload(url, $popin, onMiss, onSettled) {
            var _settle = function () {
                if ( typeof(onSettled) == 'function' ) { onSettled(); }
            };
            var slot = preloadCache[url];
            if ( typeof(slot) == 'undefined' ) {
                return false;
            }
            if ( slot === null ) {
                // In-flight: adopt the running preload rather than fire a second GET.
                // A preOpen popin still gets its instant born-modal skeleton now; the
                // adopted preload swaps in the real content on arrival — matching the
                // popinLoad preOpen flow this consume path bypasses (#B54).
                if ( $popin && $popin.options && $popin.options.preOpen ) {
                    showLoadingShell($popin, ensurePopinDialog($popin));
                }
                if ( typeof(preloadWaiters[url]) == 'undefined' ) {
                    preloadWaiters[url] = [];
                }
                preloadWaiters[url].push(function (body) {
                    // #B285 — the adopted wait is over (body or failure): settle FIRST,
                    // matching the cold path's release-before-apply order.
                    _settle();
                    if ( body == null ) {
                        if ( typeof(onMiss) == 'function' ) { onMiss(); }
                    } else {
                        // #B139 — record the content's source URL so close can
                        // clear the (repopulated) slot: the completion writes the
                        // cache back even after this adoption consumed the body.
                        $popin._contentUrl = url;
                        if (GINA_ENV_IS_DEV) { updateToolbar(body); }
                        handleLoadedBody(body, $popin, ensurePopinDialog($popin));
                    }
                });
                return true;
            }
            var body = slot;
            delete preloadCache[url];
            // #B139 — record the content's source URL so close can clear any
            // around-open re-warm parked at the same key (the leftover that made
            // the NEXT open render this open's generation).
            $popin._contentUrl = url;
            var $el = ensurePopinDialog($popin);
            if (GINA_ENV_IS_DEV) { updateToolbar(body); }
            handleLoadedBody(body, $popin, $el);
            // #B285 — synchronous settle: tells the caller no wait ever began, so it
            // must not arm. Load-bearing, not politeness: without this the caller
            // could not distinguish ready from in-flight and would arm forever.
            _settle();
            return true;
        }

        /**
         * clearContentPreload — #B139: the preload cache must not outlive the
         * open it warmed. Called from popinUnbind at the same lifecycle moment
         * the AJAX body is wiped from the DOM: deletes the popin's content-URL
         * slot so the NEXT open's own hover/focus warm (or click-time load)
         * fetches current content instead of dedup-ing against this open's
         * leftover. An in-flight slot gets a discard waiter instead — the
         * fetch completion writes the cache BEFORE firing waiters, so the
         * waiter deletes the just-written entry (and the failure path's own
         * delete makes the double-delete a no-op).
         *
         * Never-opened warms are untouched (no close ever ran for them): the
         * eager pass keeps its documented no-TTL page-lifetime semantics.
         *
         * @inner
         * @param {object} $popin
         */
        function clearContentPreload($popin) {
            var url = $popin._contentUrl;
            if ( !url ) {
                return;
            }
            $popin._contentUrl = null;
            clearPreloadSlot(url);
        }

        /**
         * clearPreloadSlot — #B139 slot-clearing core: deletes a ready slot;
         * an in-flight slot gets a discard waiter (the fetch completion writes
         * the cache BEFORE firing waiters, so the waiter deletes the
         * just-written entry — and the failure path's own delete makes the
         * double-delete a no-op). Split out of clearContentPreload so the
         * close path can re-sweep the URL after the teardown task (see
         * popinUnbind): the a11y focus-return and the pointer's re-hover after
         * overlay removal fire TRUSTED synthetic intent events DURING teardown
         * (measured: focusin → GET within 1ms of the close), re-warming the
         * just-cleared URL with close-era content. A raced sweep is benign by
         * construction — an adopted in-flight body still reaches its open via
         * the waiter chain; only the cached copy dies, costing at most one
         * extra fetch, never staleness.
         *
         * @inner
         * @param {string} url
         */
        function clearPreloadSlot(url) {
            var slot = preloadCache[url];
            if ( typeof(slot) == 'undefined' ) {
                return;
            }
            if ( slot === null ) {
                if ( typeof(preloadWaiters[url]) == 'undefined' ) {
                    preloadWaiters[url] = [];
                }
                preloadWaiters[url].push(function () {
                    delete preloadCache[url];
                });
                return;
            }
            delete preloadCache[url];
        }

        /**
         * installPreload — one-time delegated `mouseover` + `focusin` listeners that warm
         * preloadCache for AJAX triggers (`data-gina-dialog-src` / legacy
         * `data-gina-popin-url`). Per-trigger gating (disabled skip, the #B91
         * `data-gina-dialog-preload="false"` opt-out, URL-cache dedup) lives in
         * warmTrigger, shared with the idle eager pass (installEagerPreload) so the
         * two warm paths can never drift.
         *
         * @inner
         */
        function installPreload() {
            if ( _ginaPreloadInstalled ) {
                return;
            }
            _ginaPreloadInstalled = true;

            var onIntent = function (e) {
                var $trigger = ( e.target && typeof(e.target.closest) == 'function' )
                    ? e.target.closest('[data-gina-dialog-src],[data-gina-popin-url]')
                    : null;
                if ( !$trigger ) {
                    return;
                }
                warmTrigger($trigger);
            };
            document.addEventListener('mouseover', onIntent);
            document.addEventListener('focusin', onIntent);
        }

        /**
         * warmTrigger — shared per-trigger warm gate + fetch, used by BOTH the
         * hover/focus intent path (installPreload's onIntent) and the idle eager
         * pass (installEagerPreload). Gates, in order: the disabled/aria-disabled
         * skip, the #B91 `data-gina-dialog-preload="false"` opt-out
         * (case-insensitive), URL resolution, the already-cached/in-flight dedup —
         * then the in-flight slot reserve + GET. Keeping the gates in ONE place is
         * the point: a future gate change cannot land in one warm path and miss
         * the other.
         *
         * `onDone` (optional) fires on EVERY exit path — gate skip or fetch
         * completion — so a serialized caller (the eager queue) always advances.
         * The hover path passes none.
         *
         * @inner
         * @param {object} $trigger - the matched trigger element
         * @param {function} [onDone]
         */
        function warmTrigger($trigger, onDone) {
            var _warmDone = function () {
                if ( typeof(onDone) == 'function' ) { onDone(); }
            };
            if (
                $trigger.getAttribute('disabled') != null && $trigger.getAttribute('disabled') != 'false'
                || $trigger.getAttribute('aria-disabled') == 'true'
            ) {
                _warmDone();
                return;
            }
            // #B91 — per-trigger preload opt-out: a trigger whose GET has server-side
            // effects declares itself. Case-insensitive on purpose (a templated "False"
            // must not silently fail open and fire the GET anyway); its click still
            // loads normally, at click time (consumePreload -> false).
            if ( /^false$/i.test($trigger.getAttribute('data-gina-dialog-preload')) ) {
                _warmDone();
                return;
            }
            var url = $trigger.getAttribute('data-gina-dialog-src') || $trigger.getAttribute('data-gina-popin-url');
            if ( !url || typeof(preloadCache[url]) != 'undefined' ) {
                _warmDone();
                return; // already cached or in-flight — dedup
            }
            preloadCache[url] = null; // reserve in-flight slot (dedup concurrent intents)
            preloadFetch(url, onDone);
        }

        /**
         * installEagerPreload — one-time idle warm-all pass for triggers that opt
         * in with `data-gina-dialog-preload="eager"` (case-insensitive). Runs off
         * the critical path by construction: waits for `window` load, then
         * schedules on requestIdleCallback (setTimeout fallback — load-bearing for
         * browsers without rIC), and warms the opted-in triggers ONE AT A TIME
         * through the same warmTrigger gate as the hover path — so the #B91
         * `"false"` opt-out, the disabled skip, and the cache dedup (an eager warm
         * and a hover warm coalesce into one GET) all apply identically. Skipped
         * entirely when the browser signals Save-Data.
         *
         * One-shot: triggers injected after the pass are not re-scanned — the
         * delegated hover/focus warm covers them. Content staleness matches the
         * shipped hover-warm semantics (no TTL): the cache entry lives until
         * consumed, declined, or page unload — a trigger opts into that window by
         * declaring `eager`.
         *
         * @inner
         */
        function installEagerPreload() {
            if ( _ginaEagerInstalled ) {
                return;
            }
            _ginaEagerInstalled = true;
            // Respect the user's reduced-data preference — no speculative warm at all.
            if ( typeof(navigator) != 'undefined' && navigator.connection && navigator.connection.saveData ) {
                return;
            }
            var run = function () {
                var $candidates = document.querySelectorAll('[data-gina-dialog-src],[data-gina-popin-url]');
                var queue = [];
                for (var c = 0, cLen = $candidates.length; c < cLen; ++c) {
                    if ( /^eager$/i.test($candidates[c].getAttribute('data-gina-dialog-preload')) ) {
                        queue.push($candidates[c]);
                    }
                }
                // Serialized: each warm starts only when the previous one finished
                // (or was gate-skipped) — N eager popins never burst N parallel GETs.
                var next = function () {
                    var $trigger = queue.shift();
                    if ( !$trigger ) {
                        return;
                    }
                    warmTrigger($trigger, next);
                };
                next();
            };
            var schedule = function () {
                if ( typeof(window.requestIdleCallback) == 'function' ) {
                    window.requestIdleCallback(run);
                } else {
                    setTimeout(run, 1500);
                }
            };
            if ( document.readyState == 'complete' ) {
                schedule();
            } else {
                window.addEventListener('load', schedule, { once: true });
            }
        }

        /**
         * openInPageDialog
         *
         * Static (non-AJAX) path of the new API: opens an existing in-page
         * `<dialog id="ID">` directly. Registers a lightweight $popin keyed by the
         * element id (so close/getActivePopin work), wires a11y, then opens modal or
         * non-modal per the resolved descriptor.
         *
         * @inner
         */
        function openInPageDialog(descriptor, $trigger) {
            var id  = descriptor.id;
            var $el = document.getElementById(id);
            if ( !$el ) {
                throw new Error('Popin dialog `' + id + '` not found in the DOM !');
            }

            var $dialogPopin = getPopinById(id);
            if ( !$dialogPopin ) {
                $dialogPopin = merge({}, $popin);
                $dialogPopin.id            = id;
                $dialogPopin.name          = id;
                $dialogPopin.target        = $el;
                $dialogPopin.options       = merge({}, self.options);
                $dialogPopin.load          = popinLoad;
                $dialogPopin.loadContent   = popinLoadContent;
                $dialogPopin.open          = popinOpen;
                $dialogPopin.close         = popinClose;
                // Marks a static in-page dialog (vs an AJAX-loaded popin): its content is
                // authored in the page, so popinUnbind must NOT wipe innerHTML on close —
                // it has to survive close + reopen.
                $dialogPopin.isInPageDialog = true;
                instance.$popins[id]       = $dialogPopin;
            }
            $dialogPopin.modal       = descriptor.modal;
            $dialogPopin.openTrigger = $trigger ? ( $trigger.id || $trigger.getAttribute('id') ) : null;

            wireTriggerAria($trigger, id);
            associateLabel($el);

            // Bind close buttons / forms inside the dialog (guarded — no double-bind).
            if ( !gina.popinIsBinded ) {
                popinBind({ target: $el, type: 'open.' + id }, $dialogPopin);
            }

            $el.classList.add('gina-popin-is-active');
            if ( !$el.getAttribute('open') ) {
                if ( descriptor.modal && typeof($el.showModal) === 'function' ) {
                    $el.showModal();
                } else if ( typeof($el.show) === 'function' ) {
                    $el.show();
                    applyNonModalShims($dialogPopin, $el);
                } else {
                    $el.setAttribute('open', true);
                }
            }
            $dialogPopin.isOpen     = true;
            setActivePopinId($dialogPopin.id);
            focusInitial($el);
            triggerEvent(gina, instance.target, 'open.' + id, $dialogPopin);
        }

        /**
         * openFromTrigger
         *
         * Single entry point for both APIs. Resolves the descriptor, records the trigger
         * (for focus-return), then either AJAX-loads (`src`) through the existing
         * popinLoad engine — consuming a hover/focus preload when available — or opens an
         * in-page dialog directly.
         *
         * @inner
         */
        function openFromTrigger($trigger) {
            if (
                // #B296: the native `disabled` attribute is only meaningful where the browser
                // does NOT enforce it. On a real form control the browser suppresses the click
                // outright (measured: 0 clicks reach JS), so this arm could only ever fire on a
                // `disabled` written DURING the dispatch — the shape of every consumer
                // double-submit guard — which silently ate the open and left nothing marked.
                // Elements the browser does not enforce (`<a>`, custom elements, spans) keep it,
                // which is also what still honours armPopinTrigger's own `:1923` native write on
                // a non-<a> trigger. Mirrors the validator's isTriggerDisabled (#B293).
                // was: $trigger.getAttribute('disabled') != null && ... != 'false'
                !('disabled' in $trigger)
                && $trigger.getAttribute('disabled') != null && $trigger.getAttribute('disabled') != 'false'
                || $trigger.getAttribute('aria-disabled') == 'true'
            ) {
                return;
            }
            var descriptor = resolveTrigger($trigger);
            if ( !descriptor.id && !descriptor.src ) {
                return;
            }

            var triggerId = $trigger.id || $trigger.getAttribute('id');
            if ( !triggerId ) {
                triggerId = 'gina-dialog-trigger-' + _nextId();
                $trigger.setAttribute('id', triggerId);
            }
            wireTriggerAria($trigger, descriptor.id || descriptor.src);

            if ( descriptor.src ) {
                // AJAX path — register (or reuse) a $popin, then load through the
                // existing battle-tested popinLoad engine.
                var name = descriptor.id || ( 'gina-dialog-' + _nextId() );
                var existing = getPopinByName(name);
                if ( !existing ) {
                    var clone = merge({}, $popin);
                    registerPopin(clone, merge({ 'name': name }, self.options));
                    existing = getPopinByName(name);
                }
                existing.openTrigger   = triggerId;
                existing.modal         = descriptor.modal;
                existing.partialTarget = descriptor.partialTarget || null;

                // Wire the `loaded.<id>` listener that consumes the response: popinLoad()
                // only FIRES `loaded.<id>` with the body — it does not inject/open itself
                // (legacy bindOpen registers an equivalent listener at its own load site).
                // Without this the click-time XHR resolved into the void and nothing
                // opened. handleLoadedBody applies the body (partial-aware), binds + opens.
                // Guarded so repeated opens of the same popin register the listener once.
                var loadedEvt = 'loaded.' + existing.id;
                if ( typeof(gina.events[loadedEvt]) == 'undefined' ) {
                    addListener(gina, existing.target, loadedEvt, function (loadedEvent) {
                        loadedEvent.preventDefault();
                        handleLoadedBody(loadedEvent.detail, existing, ensurePopinDialog(existing));
                    });
                }

                // Consume a warmed OR in-flight preload; else fall through to a click-time XHR.
                var loadOptions = merge({ isSynchrone: false, withCredentials: false }, existing.options);
                var onMiss = function () { popinLoad(name, descriptor.src, loadOptions); };
                // #B139 companion — `preload="false"` is the always-refetch spelling:
                // such a trigger must NEVER serve cached content (not even a same-URL
                // sibling trigger's warm), so skip the consume entirely — its GET
                // always happens at open time.
                var _noPreload = /^false$/i.test($trigger.getAttribute('data-gina-dialog-preload'));
                // #B285 — an ADOPTED in-flight preload is a genuine wait: arm the trigger
                // for its duration exactly as the cold click-time XHR does, and release
                // when the adoption settles (the failure leg re-arms through popinLoad's
                // own path). The ready branch settles synchronously inside consumePreload,
                // so _adoptedWait is already false when it returns and nothing is armed —
                // nothing is owed when nothing is waited for.
                var _adoptedWait = true;
                var _armedForAdoption = false;
                var _onAdoptionSettled = function () {
                    _adoptedWait = false;
                    if (_armedForAdoption) {
                        _armedForAdoption = false;
                        releasePopinTrigger($trigger);
                    }
                };
                if ( !_noPreload && consumePreload(descriptor.src, existing, onMiss, _onAdoptionSettled) ) {
                    if (_adoptedWait) {
                        armPopinTrigger($trigger);
                        _armedForAdoption = true;
                    }
                    return;
                }
                onMiss();
            } else {
                openInPageDialog(descriptor, $trigger);
            }
        }

        /**
         * bindDelegatedOpen
         *
         * One delegated `document` click listener handling new `data-gina-dialog`
         * triggers (including dynamically-injected ones — SPA-safe). Idempotent via a
         * module guard. Legacy `data-gina-popin-name` triggers are already wired by
         * bindOpen's per-element listeners (kept for parity / test 02), so this handler
         * defers to those to avoid a double-open.
         *
         * @inner
         */
        function bindDelegatedOpen() {
            if ( _ginaDialogDelegated ) {
                return;
            }
            _ginaDialogDelegated = true;

            addListener(gina, document, 'click', function (event) {
                var $trigger = ( event.target && typeof(event.target.closest) == 'function' )
                    ? event.target.closest('[data-gina-dialog],[data-gina-dialog-src],[data-gina-popin-name]')
                    : null;
                if ( !$trigger ) {
                    return;
                }
                // Own the new data-gina-dialog API: the `data-gina-dialog` marker (in-page
                // or marker+src) OR a standalone `data-gina-dialog-src` AJAX trigger
                // (documented as a peer trigger, and already warmed by installPreload). Pure
                // legacy `data-gina-popin-*` triggers carrying neither new attribute stay
                // with bindOpen's per-element listeners, to avoid a double-open.
                if (
                    $trigger.getAttribute('data-gina-dialog') == null
                    && $trigger.getAttribute('data-gina-dialog-src') == null
                ) {
                    return;
                }
                cancelEvent(event);
                openFromTrigger($trigger);
            });
        }


        var bindOpen = function($popin, isRouting) {

            isRouting = ( typeof(isRouting) != 'undefined' ) ? isRouting : false;

            var attr    = 'data-gina-popin-name';
            var $els    = document.querySelectorAll('[' + attr + ']');
            var $el     = null, name = null, id = null;
            var url     = null;
            var proceed = null, evt = null;
            var i = null, len = null;

            i = 0; len = $els.length;
            for (;i < len; ++i) {
                $el     = $els[i];
                name    = $el.getAttribute(attr);
                if ( $el.tagName == 'A' ) {
                    url = $el.getAttribute('href');
                    if (url == '' || url =='#' || /\#/.test(url) ) {
                        url = null
                    }
                }

                if ( !url && typeof( $el.getAttribute('data-gina-popin-url') ) != 'undefined') {
                    url = $el.getAttribute('data-gina-popin-url');
                }

                if (!url) {
                    throw new Error('Found `data-gina-popin-name` without `url` !')
                }

                if ( !$el['url'] ) {
                    $el['url'] = url;
                }

                if ( !$el['popinName'] ) {
                    $el['popinName'] = name;
                }

                if (name == $popin.name) {
                    id = $el.id || $el.getAttribute('id') || null;
                    // By default
                    evt = 'popin.click.'+ 'gina-popin-' + instance.id +'-'+ _nextId() +'-'+ name;
                    // console.debug("[POPIN CLICK #1]", id, " VS ", evt);
                    // Retrieving existing event
                    if ( id && new RegExp( '^popin.click.gina-popin-').test(id) ) {
                    // if ( id && new RegExp( '^popin.click.gina-popin-' + instance.id).test(id) ) {
                        // console.debug("[POPIN CLICK #2]", id, " VS ", evt);
                        evt = id;
                    }

                    if (!gina.events[evt]) {
                        $el['id'] = evt;
                        $el.setAttribute( 'id', evt);
                        // $el.setAttribute( 'data-dialog', evt);

                        // attach click events
                        addListener(gina, $el, evt, function(e) {
                            cancelEvent(e);
                            // #B298 — the legacy twin of openFromTrigger's own entry gate; the
                            // predicate is copied verbatim from there, native arm included (see
                            // its comment for why `disabled` counts only where the browser does
                            // not enforce it). armPopinTrigger marks an <a> trigger
                            // `aria-disabled` for the duration of the load, but the only dispatch
                            // route for a legacy trigger — the document click proxy — tests the
                            // native attribute alone, which an <a> never carries; a second click
                            // during the load therefore reached here and started a second XHR.
                            //
                            // Gating HERE rather than in the proxy is load-bearing, not stylistic:
                            // a trigger's direct children each get their own listener from
                            // proxyClick, which fires the custom event DIRECTLY and never passes
                            // the proxy predicate at all. Both routes converge on this handler,
                            // and `currentTarget` is the element bindOpen bound, so a click that
                            // lands on child markup cannot dodge the gate. Measured: a
                            // proxy-level gate still let the child-click route fire twice.
                            var $trigger = e.currentTarget;
                            if (
                                !('disabled' in $trigger)
                                && $trigger.getAttribute('disabled') != null && $trigger.getAttribute('disabled') != 'false'
                                || $trigger.getAttribute('aria-disabled') == 'true'
                            ) {
                                return;
                            }
                            // console.debug("[POPIN CLICK #3]", $popin.openTrigger, " VS ", e.currentTarget.id);
                            $popin.openTrigger = e.currentTarget.id || e.currentTarget.getAttribute('id');

                            // loading & binding popin
                            // Non-Preflighted requests
                            var options = {
                                isSynchrone: false,
                                withCredentials: false // by default
                            };
                            options = merge($popin.options, options);
                            var url = this.getAttribute('data-gina-popin-url') || this.getAttribute('href');
                            if (!url) {
                                throw new Error('Popin `url` not defined, please check value for `data-gina-popin-url`');
                            }

                            // The click-time load: registers the loaded.<id> listener that
                            // injects + opens, then issues the XHR. Wrapped so a consumed
                            // preload can skip it (#B54), and an adopted-but-failed preload
                            // can fall back to it.
                            var doLoad = function() {
                                var fired = false;
                                addListener(gina, $popin.target, 'loaded.'+$popin.id, function(e) {
                                    e.preventDefault();

                                    // console.debug('Popin loaded: true, fired: '+ fired + ', $popin.isOpen: '+ $popin.isOpen);

                                    if (!fired) {
                                        fired = true;
                                        console.debug('active popin should be ', $popin.id);
                                        setActivePopinId($popin.id);
                                        popinBind(e, $popin);
                                        if (!$popin.isOpen) {
                                            popinOpen($popin.name);
                                        }
                                    }
                                });
                                popinLoad($popin.name, url, options);
                            };

                            // #B54 — reuse a hover/focus preload (warmed OR in-flight) for the
                            // same URL instead of firing a second identical GET. Mirrors the
                            // new data-gina-dialog path (openFromTrigger).
                            // #B139 companion — `preload="false"` triggers skip the consume:
                            // always-refetch means the GET happens at open time, never from
                            // the cache (see the openFromTrigger twin).
                            var _noPreload = /^false$/i.test(this.getAttribute('data-gina-dialog-preload'));
                            // #B285 — same adopted-wait arm as the openFromTrigger twin: a
                            // click adopting a still-in-flight preload waits for real; arm
                            // for the wait, release on settle (a failed adoption's doLoad
                            // re-arms through popinLoad's own path).
                            var _adoptedWait = true;
                            var _armedForAdoption = false;
                            var _onAdoptionSettled = function () {
                                _adoptedWait = false;
                                if (_armedForAdoption) {
                                    _armedForAdoption = false;
                                    releasePopinTrigger($trigger);
                                }
                            };
                            if ( !_noPreload && consumePreload(url, $popin, doLoad, _onAdoptionSettled) ) {
                                if (_adoptedWait) {
                                    armPopinTrigger($trigger);
                                    _armedForAdoption = true;
                                }
                                return;
                            }
                            doLoad();
                        });



                        // bind child elements
                        var childNodes = $el.childNodes;
                        var l = 0; lLen = childNodes.length;
                        if (lLen > 0) {
                            for(; l < lLen; ++l) {
                                if (typeof (childNodes[l].tagName) != 'undefined') {
                                    proxyClick(childNodes[l], $el, evt)
                                }
                            }
                        }
                    }
                }

            }

            // proxies
            // click on main document
            evt = 'click';// click proxy
            // for proxies, use popinInstance.id as target is always `document`
            addListener(gina, document, evt, function(event) {

                // #B296: native `disabled` counts only where the browser does not enforce it —
                // see the openFromTrigger gate for the full rationale. This is the SOLE dispatch
                // path for legacy `data-gina-popin-name` triggers (bindDelegatedOpen returns
                // early for them at the `data-gina-dialog` check), so the same guard shape is
                // latent here. Reachability of THIS site was traced, not exercised.
                if (
                    !('disabled' in event.target)
                    && event.target.getAttribute('disabled') != null && event.target.getAttribute('disabled') != 'false'
                ) {
                    return false;
                }

                // #B300: an id-stamping block used to sit here, gated on
                // `typeof(event.target.id) == 'undefined'`. An element's `id` IDL attribute
                // always exists (it defaults to ''), so the gate was never true and the block
                // never ran. Removed rather than "corrected": making it run would stamp
                // `click.<n>` — this proxy's own `evt` — onto EVERY id-less element clicked
                // anywhere in the document, an id matching neither prefix tested below.

                if ( /^popin\.close\./.test(event.target.id) ) {
                    cancelEvent(event);

                    var _evt = event.target.id;
                    triggerEvent(gina, event.target, _evt, event.detail);
                }

                if ( /^popin\.click\./.test(event.target.id) ) {
                    cancelEvent(event);
                    //console.log('popin.click !! ', event.target);
                    var _evt = event.target.id;

                    if ( _rePopinClick.test(_evt) ) {
                        triggerEvent(gina, event.target, _evt, event.detail);
                    }

                }
            });

            gina.popinIsBinded = false
        }


        function popinBind(e, $popin) {

            var $el = e.target;
            var eventType = e.type;

            if (
                typeof(e.detail) != 'undefined'
                && typeof(e.detail.trim) == 'function'
            ) {
                $el.innerHTML = e.detail.trim();
            }


            var register = function (type, evt, $element) {
                var isLink = $element.getAttribute('data-gina-popin-is-link');
                isLink = ( /^true$/i.test(isLink) ) ? true : false;
                if ( type == 'link' && !isLink) {
                    // like a form action, so gina will not follow the href and the event will be prevented
                    type = 'action';
                }
                // attach submit events
                addListener(gina, $element, evt, function(event) {

                    cancelEvent(event);

                    if (type != 'close') {

                        var fired = false;
                        var _evt = 'loaded.' + $popin.id;

                        if ( typeof(gina.events[_evt]) == 'undefined' ) {
                            addListener(gina, $el, _evt, function(e) {

                                e.preventDefault();

                                if (!fired) {
                                    fired = true;
                                    popinLoadContent(e.detail);
                                }
                            });
                        }

                        // Non-Preflighted requests
                        var options = {
                            isSynchrone: false,
                            withCredentials: false
                        };
                        //options = merge(options, $popin.options);
                        options = merge($popin.options, options);
                        popinLoad($popin.name, $element.href, options);
                    }

                    removeListener(gina, event.target, event.type)
                });

                addListener(gina, $element, 'click', function(event) {
                    cancelEvent(event);
                    // ignore disabled
                    // #B296: native `disabled` counts only where the browser does not enforce it —
                    // see the openFromTrigger gate. MEASURED reachable here: an in-popin
                    // `.gina-popin-close` <button> plus a CAPTURE-phase consumer guard leaves the
                    // popin open with nothing marked. A target-phase guard bound after gina's own
                    // listener (:1327) does NOT reproduce it — gina runs first — so this site is
                    // narrower than openFromTrigger's, but real.
                    if (
                        !('disabled' in event.target)
                        && event.target.getAttribute('disabled') != null && event.target.getAttribute('disabled') != 'false'
                    ) {
                        return false;
                    }
                    // NB.: `type == 'action'` will be handled by the form validator
                    if ( type == 'link' ) {
                        var linkHref = event.target.getAttribute('href') || null;
                        // console.debug('This is a link', event.target);
                        var linkTarget = event.target.getAttribute('target');
                        if ( linkTarget != null && linkTarget != '' ) {
                            var _window = window.open(linkHref, linkTarget);
                            // _window.onload = function onWindowLoad() {
                            //     var $popin = getActivePopin();
                            //     triggerEvent(gina, $popin, 'loaded.' + id);
                            // }
                        } else { // else, inside viewbox
                            // TODO - Integrate https://github.com/box/viewer.js#loading-a-simple-viewer
                            triggerEvent(gina, event.target, event.currentTarget.id, $popin);
                        }

                    } /**else if ( type == 'action' ) {
                        // rewrite form attributes
                        //console.debug('This is an action ', event.target);
                    }*/ else { // close

                        // #B300: an id-stamping block used to sit here, gated on
                        // `typeof(event.target.id) == 'undefined'` — never true, since an
                        // element's `id` IDL attribute always exists (defaulting to ''), so it
                        // never ran. Removed rather than "corrected": making it run would
                        // rewrite the clicked node's id to `evt + '.' + _nextId()`, which is
                        // exactly what the note below forbids — the `$close` teardown sweep
                        // finds this listener via `gina.events[eId] == eId`, i.e. it depends on
                        // the element id and the event name being the SAME string.

                        // #B299/#B301: reaching this branch ALREADY proves the element is a
                        // `.gina-popin-close` — register('close', …) has a single call site, fed
                        // only from `$el.querySelectorAll('.gina-popin-close')`. Re-deriving that
                        // fact from the id prefix was the defect twice over: a consumer-supplied
                        // id matches neither prefix (#B299), and `event.target` is whatever was
                        // actually CLICKED, so an icon nested inside the button matched neither
                        // either (#B301 — the ordinary `<button class="gina-popin-close"><svg/></button>`
                        // shape, and the wider of the two). Both left the button inert and silent,
                        // since `cancelEvent` at the top of this listener had already swallowed the
                        // default. So read the element `register()` actually bound —
                        // `event.currentTarget` — and treat a `popin.click.*` id as the SOLE
                        // exception, which preserves the dual-role element (a trigger that is also
                        // a close button; `bindOpen` scans the whole document, so it is reachable)
                        // exactly as before.
                        // The element's id is deliberately NOT touched: the `$close` teardown
                        // sweep removes this listener via `gina.events[eId] == eId`, i.e. it
                        // depends on the event name and the element id being the same string.
                        var _isClickTrigger = /^popin\.click\./.test(event.currentTarget.id);

                        if ( !_isClickTrigger ) {
                            cancelEvent(event);
                            // Just in case we left the popin with a link:target = _blank
                            $popin.isRedirecting = false;
                            popinClose($popin.name);
                        }

                        if ( _isClickTrigger ) {
                            cancelEvent(event);
                            var _evt = event.target.id;

                            if ( _rePopinClick.test(_evt) ) {
                                triggerEvent(gina, event.target, _evt, event.detail);
                            }

                        }
                    }
                });

            }; // EO var register = function (type, evt, $element) {

            gina.popinIsBinded = true;

            var i       = null
                , b     = null
                , len   = null
            ;
            // bind overlay on click
            if (!$popin.isOpen && self.options.cancelOnOverlayClick) {
                var $overlay = $popin.target;
                // Non-dialog mode only: bind cancelOnOverlayClick to the manual overlay
                // div — the non-dialog path has no native backdrop to click. Dialog-mode
                // popins are native modals (see the showModal() branch) and use ::backdrop.
                if ( !self.options.useDialogMode ) {
                    $overlay = instance.target.childNodes[0];
                }
                addListener(gina, $overlay, 'mousedown', function(event) {

                    // don't cancel here, it will corrupt child elements behaviors such as checkboxes and radio buttons
                    if ( /gina-popin-is-active/.test(event.target.className) ) {

                        // remove listeners
                        removeListener(gina, event.target, 'mousedown');

                        // binding popin close
                        var $close = Array.prototype.slice.call($el.querySelectorAll('.gina-popin-close'));

                        b = 0; len = $close.length;
                        for (; b < len; ++b) {
                            let $el = $close[b];
                            let eId = $el.getAttribute('id');
                            for (let e = 0, eLen = events.length; e < eLen; e++) {
                                let evt = events[e];
                                if ( typeof(gina.events[ evt ]) != 'undefined' && gina.events[ evt ] == eId ) {
                                    removeListener(gina, $el, evt);
                                }
                                if ( typeof(gina.events[ eId ]) != 'undefined' && gina.events[ eId ] == eId ) {
                                    removeListener(gina, $el, eId);
                                }

                                if ( typeof(gina.events[ evt +'.'+ eId ]) != 'undefined' && gina.events[ evt +'.'+ eId ] == eId ) {
                                    removeListener(gina, $el, evt +'.'+ eId);
                                }

                                if ( typeof(gina.events[ evt +'.'+ eId ]) != 'undefined' && gina.events[ evt +'.'+ eId ] == evt +'.'+ eId ) {
                                    removeListener(gina, $el, evt +'.'+ eId);
                                }
                            }


                            //removeListener(gina, $close[b], $close[b].getAttribute('id') );
                        }

                        // div with click
                        // var $elTMP = $form.target.getElementsByTagName('div');
                        // if ( $elTMP.length > 0 ) {
                        //     for(let i = 0, len = $elTMP.length; i < len; ++i) {
                        //         $els.push( $elTMP[i] )
                        //     }
                        // }
                        // // label with click
                        // $elTMP = $form.target.getElementsByTagName('label');
                        // if ( $elTMP.length > 0 ) {
                        //     for(let i = 0, len = $elTMP.length; i < len; ++i) {
                        //         $els.push( $elTMP[i] )
                        //     }
                        // }

                        // Just in case we left the popin with a link:target = _blank
                        $popin.isRedirecting = false;
                        popinClose($popin.name);
                    }

                });
            }
            // detecting form in popin
            if ( /<form/i.test($el.innerHTML) && typeof($validatorInstance) != 'undefined' && $validatorInstance ) {
                $popin.hasForm = true;
            }

            // binding popin close & links (& its target attributes)
            var $close = Array.prototype.slice.call($el.querySelectorAll('.gina-popin-close'));
            var $link  = [];

            // Collect non-close <a> links
            var $aTags = $el.getElementsByTagName('a');
            b = 0; len = $aTags.length;
            if ( len > 0 ) {
                for(; b < len; ++b) {
                    if ( $aTags[b].classList.contains('gina-popin-close') ) {
                        continue
                    }

                    if (
                        typeof($aTags[b]) != 'undefined'
                        && !/(\#|\#.*)$/.test($aTags[b].href) // ignore href="#"
                        // ignore href already bindded byr formValidator or the user
                        && !$aTags[b].id
                        ||
                        typeof($aTags[b]) != 'undefined'
                        && !/(\#|\#.*)$/.test($aTags[b].href) // ignore href="#"
                        && !/^(click\.|popin\.link)/.test($aTags[b].id)
                    ) {
                        $link.push($aTags[b]);
                        continue
                    }
                }
            }

            var evt = null;
            // close events
            // NB.: the close element's default action (e.g. an `<a href="#">` navigation) is already
            //      suppressed by register('close', …) below — the click listener it attaches calls
            //      cancelEvent() (preventDefault/stopPropagation) on every click. The previous inline
            //      onclick="return false;" injection here was redundant with that listener AND tripped
            //      CSP script-src-attr under nonce-based policies (a nonce in script-src disables
            //      'unsafe-inline' for inline event-handler attributes), so it has been removed.
            b = 0; len = $close.length;
            for (; b < len; ++b) {

                if (!$close[b]['id']) {

                    evt = 'popin.close.'+ _nextId();
                    $close[b]['id'] = evt;
                    $close[b].setAttribute( 'id', evt);

                } else {
                    evt = $close[b]['id'];
                }


                if ( typeof(gina.events[evt]) == 'undefined' || gina.events[evt] != $close[b].id ) {
                    register('close', evt, $close[b])
                }
            }

            // link events
            i = 0; len = $link.length;
            var _form = null, f = null, fLen = null;
            var inheritedData = {}, _formData = null;
            var domParserObject = new DOMParser()
                , currentId     = null
                , found         = null
                , aHref         = null
                , isSubmitLink  = null
                , isLink        = null
            ;

            for (; i < len; ++i) {
                // if is disabled, stop propagation
                if ( $link[i].getAttribute('disabled') != null ) {
                    continue;
                }

                $link[i]['id'] =  ( /^null$/i.test($link[i].getAttribute('id')) ) ? null : $link[i].getAttribute('id');
                if (!$link[i]['id'] || !/^popin\.link/.test($link[i]['id']) || !/^popin\.click/.test($link[i]['id']) ) {

                    // just in case
                    isLink = true;
                    aHref = $link[i].getAttribute('href');
                    if (!aHref || aHref == '' || aHref == '#' ) {
                        if (aHref != '#')
                            $link[i].setAttribute('href', '#');
                        isLink = false;
                    }
                    // link or action ?
                    if (/^null$/i.test($link[i]['id'])) {
                        if ( isLink ) {
                            evt = 'popin.link.' + _nextId();
                            $link[i].setAttribute('data-gina-popin-is-link', true);
                        } else {
                            evt = 'popin.click.' + _nextId();
                            $link[i].setAttribute('data-gina-popin-is-link', false);
                        }
                    } else {
                        evt = $link[i]['id'];
                    }

                    $link[i]['id'] = evt;
                    $link[i].setAttribute( 'id', evt);

                } else {
                    evt = $link[i]['id'];
                }

                // ignore `isSubmitLink == true`
                // will be handled by validator
                isSubmitLink = $link[i].getAttribute('data-gina-form-submit');
                isSubmitLink = ( isSubmitLink && /^true$/i.test(isSubmitLink) ) ? true : false;
                if (isSubmitLink) {
                    continue;
                }


                if ( !/^(null|\s*)$/.test($link[i].getAttribute('href')) ) {
                    addListener(gina, $link[i], 'click', function(linkEvent) {
                        linkEvent.preventDefault();

                        $popin.isRedirecting = true;

                        if ($popin.hasForm) {
                            // Experimental - inheritedData
                            // Inhertitance from previously request: merging datas with current form context
                            // TODO - Get the inhereted data from LMDB Database using the form CSRF
                            _form = $popin.target.getElementsByTagName('FORM');
                            f = 0; fLen = _form.length;
                            for (; f < fLen; ++f) {
                                // check if current link is in form
                                currentId = linkEvent.currentTarget.id;
                                found = domParserObject.parseFromString(_form.item(f).innerHTML, 'text/html').getElementById(currentId) || false;
                                if ( found ) {
                                    _formData = _form[f].getAttribute('data-gina-form-inherits-data') || null;
                                    // mergin GET data
                                    inheritedData = merge(inheritedData, JSON.parse(decodeURIComponent(_formData)));
                                }
                            }

                            // has already params ?
                            if ( inheritedData.count() > 0 ) {
                                if ( /\?/.test(linkEvent.currentTarget.href) ) {
                                    linkEvent.currentTarget.href += '&inheritedData=' + encodeRFC5987ValueChars(JSON.stringify(inheritedData));
                                } else {
                                    linkEvent.currentTarget.href += '?inheritedData=' + encodeRFC5987ValueChars(JSON.stringify(inheritedData));
                                }
                            }
                        }
                    })
                }

                if ( typeof(gina.events[evt]) == 'undefined' || gina.events[evt] != $link[i].id ) {
                    register('link', evt, $link[i])
                }


            } // EO for(; i < len; ++i)

            // bind with formValidator if forms are found
            if ($popin.hasForm) {
                var _id = null;
                var $forms = $el.getElementsByTagName('form');
                i = 0; len = $forms.length;
                for(; i < len; ++i) {

                    // #B300: this was gated on
                    // `!$forms[i]['id'] || typeof($forms[i]) != 'string'`, whose second clause
                    // tested the form ELEMENT rather than its id — always true for an object —
                    // so the guard was always true and its `else` (`_id = $forms[i]['id']`)
                    // unreachable. Behaviour is unchanged by removing it: for a form that
                    // already carries an id, `getAttribute('id')` returns that same id.
                    _id = $forms[i].getAttribute('id') || 'form.' + _nextId();
                    $forms[i].setAttribute('id', _id);// just in case
                    $forms[i]['id'] = _id

                    //console.debug('pushing ', _id, $forms[i]['id'], typeof($forms[i]['id']), $forms[i].getAttribute('id'));
                    if ($popin['$forms'].indexOf(_id) < 0)
                        $popin['$forms'].push(_id);

                    $forms[i].close = popinClose;
                    $validatorInstance.isPopinContext = true;
                    $validatorInstance.validateFormById($forms[i].getAttribute('id')); //$forms[i]['id']

                    removeListener(gina, $popin.target, eventType);
                }
            }

        } // EO function popinBind(e, $popin) {

        function updateToolbar(result, resultIsObject) {
            // update toolbar errors
            var $popin  = getActivePopin();
            var XHRData = null;
            var $el     = null;
            if ( gina && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar && typeof(result) != 'undefined' && typeof(resultIsObject) != 'undefined' && result ) {

                XHRData = result;

                try {
                    var XHRDataNew = null;
                    if ( !resultIsObject && XHRData.error && /^(\{|\[)/.test(XHRData.error) )
                        XHRData.error = JSON.parse(XHRData.error);

                    // bad .. should not happen
                    if ( typeof(XHRData.error) != 'undefined' && typeof(XHRData.error) == 'object' && typeof(XHRData.error) == 'object' ) {
                        // by default
                        XHRDataNew = { 'status' : XHRData.status };
                        // existing will be overriden by user
                        for (xErr in XHRData.error) {
                            if ( !/^error$/.test(xErr ) ) {
                                XHRDataNew[xErr] = XHRData.error[xErr];
                            }
                        }

                        XHRDataNew.error = XHRData.error.error;

                        XHRData = result = XHRDataNew
                    } else if ( typeof(XHRData.error) != 'undefined' && typeof(XHRData.error) == 'string' ) {
                        XHRData = result;
                    }

                    XHRData.isXHRViewData = true;
                    ginaToolbar.update('data-xhr', XHRData );

                    return;
                } catch (err) {
                    throw err
                }
            }

            // update toolbar

            try {
                $popin = getPopinById( (typeof(gina.popin) != 'undefined' && gina.popin) ? gina.popin.activePopinId : instance.activePopinId );
                $el = $popin.target;
            } catch (err) {
                if ($popin) {
                    ginaToolbar.update('data-xhr', err );
                }
            }
            // XHR - case; popin is in the result, but not loaded yet
            if (!$popin) {
                var popinObject = new DOMParser().parseFromString(result, 'text/html').getElementsByClassName('popin')[0] || new DOMParser().parseFromString(result, 'text/html').getElementsByTagName('div')[0];
                $popin = {
                    id      : popinObject.id,
                    target  : popinObject
                };
                $el = $popin.target;
            }


            // XHRData
            XHRData = null;
            if ( typeof(result) == 'string' && /\<(.*)\>/.test(result) ) {
                // converting Element to DOM object
                XHRData = new DOMParser().parseFromString(result, 'text/html').getElementById('gina-without-layout-xhr-data');
            } else {
                XHRData = document.getElementById('gina-without-layout-xhr-data');
            }

            if ( gina && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar && XHRData ) {
                try {

                    if ( typeof(XHRData.value) != 'undefined' && XHRData.value ) {
                        XHRData = JSON.parse( decodeURIComponent( XHRData.value ) );
                        // reset data-xhr
                        XHRData.isXHRViewData = true;
                        ginaToolbar.update('data-xhr', XHRData);
                    }

                } catch (err) {
                    throw err
                }
            }

            // XHRView
            var XHRView = null;
            if ( typeof(result) == 'string' && /\<(.*)\>/.test(result) ) {
                // converting Element to DOM object
                XHRView = new DOMParser().parseFromString(result, 'text/html').getElementById('gina-without-layout-xhr-view');
            } else {
                XHRView = document.getElementById('gina-without-layout-xhr-view');
            }

            if ( gina && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar && XHRView ) {
                try {

                    if ( typeof(XHRView.value) != 'undefined' && XHRView.value ) {

                        XHRView = JSON.parse( decodeURIComponent( XHRView.value ) );
                        // reset data-xhr
                        ginaToolbar.update('view-xhr', XHRView);
                    }

                } catch (err) {
                    throw err
                }
            }

            // XHRForm - updated by `open.`+ $popin.id event
            // See: triggerEvent(gina, instance.target, 'open.'+ $popin.id, $popin);
        } // EO function updateToolbar(result, resultIsObject)



        /**
         * XML Request options
         * */
        var xhrOptions = {
            'url'           : '',
            'method'        : 'GET',
            'isSynchrone'   : false,
            'withCredentials': true, // if should be enabled under a trusted env
            'headers'       : {
                // cross domain is enabled by default, but you need to setup `Access-Control-Allow-Origin`
                'X-Requested-With': 'XMLHttpRequest' // to set isXMLRequest == true && in case of cross domain origin

            }
        };

        /**
         * Default loading skeleton injected by showLoadingShell() when `preOpen` is set but
         * no `loadingShell` markup was provided. Generic + gina-namespaced so it never
         * collides with a consumer's own markup; styled by the `.gina-popin-skeleton*` rules
         * in popin.css. Static HTML (no scripts) — CSP-safe.
         *
         * @constant {string}
         * @inner
         */
        var GINA_DEFAULT_LOADING_SHELL =
              '<div class="gina-popin-skeleton" aria-hidden="true">'
            +     '<div class="gina-popin-skeleton-line gina-popin-skeleton-title"></div>'
            +     '<div class="gina-popin-skeleton-line"></div>'
            +     '<div class="gina-popin-skeleton-line gina-popin-skeleton-line--short"></div>'
            + '</div>';

        /**
         * showLoadingShell
         *
         * Opt-in skeleton-loading pre-open. When a popin is registered with `preOpen: true`,
         * this fills the (already DOM-attached) popin element with a loading skeleton and
         * opens it BEFORE the XHR returns, so there is no blank-screen gap while the server
         * responds. On completion popinBind injects the real HTML over `$el.innerHTML`
         * (replacing the skeleton) and popinOpen's `!$el.getAttribute('open')` guard then
         * skips its own open (re-showModal() on an already-open dialog throws).
         *
         * Born modal in every env (dev/prod parity), matching popinOpen's showModal()-only
         * behavior. Idempotent — the open/active guard lets the two loading-attr write sites
         * (the synchronous readyState-1 set and the onreadystatechange set) call it at most
         * once per load. The skeleton is the consumer's `loadingShell` option when provided
         * (so a consumer can delete its own pre-open observer and keep its exact markup),
         * otherwise GINA_DEFAULT_LOADING_SHELL. Injected via innerHTML — no scripts, CSP-safe.
         *
         * @inner
         * @param {object} $popin - the registered popin (carries `.options.preOpen` / `.options.loadingShell`)
         * @param {HTMLElement} $el - the popin container (`<dialog>` in dialog mode, `<div>` otherwise)
         * @returns {void}
         *
         * @example
         * // gina default skeleton:
         * new Popin({ name: 'form', preOpen: true });
         * // consumer markup (delete your own pre-open observer, keep your look):
         * new Popin({ name: 'form', preOpen: true, loadingShell: '<div class="my-skel">…</div>' });
         */
        function showLoadingShell($popin, $el) {
            // Opt-in only — off unless the popin was registered with `preOpen: true`.
            if ( !$popin || !$el || !$popin.options || !$popin.options.preOpen ) {
                return;
            }
            // Idempotent: both loading-attr write sites call this; once the element is
            // open/active, the repeat call no-ops. hasAttribute() (not getAttribute()) —
            // showModal() sets `open` to the empty string, which is falsy, so a
            // getAttribute() truthiness check would not trip on the second call.
            if ( $el.hasAttribute('open') || $el.classList.contains('gina-popin-is-active') ) {
                return;
            }

            var shell = ( typeof($popin.options.loadingShell) == 'string' && $popin.options.loadingShell )
                ? $popin.options.loadingShell
                : GINA_DEFAULT_LOADING_SHELL;
            $el.innerHTML = shell;

            if ( $el.tagName === 'DIALOG' ) {
                // Born modal (dev/prod parity). showModal() promotes the dialog to the top
                // layer with a native ::backdrop; popinOpen's !getAttribute('open') guard
                // then skips its own showModal() (re-showModal on an open dialog throws).
                if ( typeof($el.showModal) === 'function' ) {
                    try { $el.showModal(); } catch (e) {}
                } else {
                    $el.setAttribute('open', true);
                }
            } else {
                // Non-dialog mode: no native ::backdrop — activate the container and its
                // manual .gina-popins-overlay (mirrors popinOpen's non-dialog branch).
                $el.classList.add('gina-popin-is-active');
                var $overlay = $el.parentElement;
                if ( $overlay && !$overlay.classList.contains('gina-popin-is-active') ) {
                    $overlay.classList.add('gina-popin-is-active');
                }
            }
        }

        /**
         * armPopinTrigger
         *
         * Makes the control that opened a popin inoperable for the duration of the load
         * and marks it with the shared `data-gina-loading`.
         *
         * That attribute is NOT a duplicate of the container's `data-gina-popin-loading`:
         * they sit on different elements and answer different questions — the container
         * one says "this popin is filling", this one says "this control is busy". The
         * second is the same attribute the validator and link plugins write, so a single
         * stylesheet covers every busy control a project has, whichever plugin started
         * the work.
         *
         * Scoped to the TRIGGER rather than absorbing the whole arm block, deliberately:
         * the two arm sites must keep their own literal `showLoadingShell($popin, $el)`
         * call, which is what `popin.test.js` pins to prove the skeleton shows at both.
         *
         * @inner
         * @param {HTMLElement} [$popinTrigger] - the control that opened it, when it has an id
         * @returns {void}
         *
         * @example
         * armPopinTrigger(document.getElementById($popin.openTrigger));
         */
        function armPopinTrigger($popinTrigger) {
            if ( !$popinTrigger ) {
                return;
            }
            // For A tag: aria-disabled=true
            if ( /^A$/i.test($popinTrigger.tagName) ) {
                $popinTrigger.setAttribute('aria-disabled', true);
            } else {
                $popinTrigger.setAttribute('disabled', true);
            }
            loadingState.arm($popinTrigger);
        }

        /**
         * releasePopinTrigger
         *
         * armPopinTrigger's mirror: removes the attribute the arm set
         * (`aria-disabled` on an `<a>`, native `disabled` everywhere else) and
         * releases the shared `data-gina-loading` marker. Same shape as
         * popinLoad's own readyState-4 release; used by the adopted-preload
         * wait (#B285), whose release has no XHR of its own to hang it on.
         *
         * @inner
         * @param {HTMLElement} [$popinTrigger] - the control armPopinTrigger marked
         * @returns {void}
         *
         * @example
         * releasePopinTrigger($popinTrigger);
         */
        function releasePopinTrigger($popinTrigger) {
            if ( !$popinTrigger ) {
                return;
            }
            if ( /^A$/i.test($popinTrigger.tagName) ) {
                $popinTrigger.removeAttribute('aria-disabled');
            } else {
                $popinTrigger.removeAttribute('disabled');
            }
            loadingState.disarm($popinTrigger);
        }

        /**
         * popinLoad
         *
         * @param {string} name
         * @param {string} url
         * @param {object} [options]
         * */
        function popinLoad(name, url, options) {
            // if no name defiend, get the current
            if ( typeof(name) == 'undefined' ) {
                if ( typeof(this.name) == 'undefined' ) {
                    throw new Error('`$popin.name` needs to be defined !')
                }
                name = this.name;
            } else if (typeof(this.name) == 'undefined' && name != 'undefined') {
                this.name = name;
            }
            // popin object
            var $popin          = getPopinByName(name);
            var id              = $popin.id;
            var $popinTrigger   = document.getElementById($popin.openTrigger) || null;

            // #B139 — record the content's source URL for the close-time cache
            // clear (covers every click-time load path, incl. validator redirects).
            if (url) {
                $popin._contentUrl = url;
            }

            // set as active if none is active
            if ( !gina.popin.activePopinId ) {
                setActivePopinId(id);
            }

            // popin element
            var $el         = document.getElementById(id) || null;

            if ( $el == null ) {
                var className = null;
                if ( !self.options.useDialogMode ) {
                    // DIV
                    className   = $popin.options.class +' '+ id;
                    $el             = document.createElement('div');
                    $el.setAttribute('id', id);
                    $el.setAttribute('class', className);
                    instance.target.firstChild.appendChild($el);
                } else {
                    // DIALOG
                    // <dialog class="dialog" id="sample-dialog-1" data-type="modal" method="dialog" aria-labelledby="dialog-title">
                    // Then to open
                    // <button class="button" data-dialog="sample-dialog-1" type="button">Open dialog</button>
                    className   = $popin.options.class +' '+ id;
                    $el             = document.createElement('dialog');
                    $el.setAttribute('id', id);
                    $el.setAttribute('class', className);
                    $el.setAttribute('data-type', 'modal');
                    // $el.setAttribute('method', 'dialog');
                    $el.setAttribute('aria-labelledby', name);
                    $overlay = document.getElementById('gina-popins-overlay');
                    if ($overlay) {
                        $overlay.appendChild($el);
                    } else {
                        instance.target.appendChild($el);
                    }
                }
            }

            if ( typeof(options) == 'undefined' ) {
                options = xhrOptions;
            } else {
                // In order to inherit without overriding default xhrOptions
                var isWithCredentials = xhrOptions.withCredentials;
                options = merge(options, xhrOptions);

                options.withCredentials = isWithCredentials;
            }

            if (
                /^(http|https)\:/.test(url)
                && !new RegExp('^' + window.location.protocol + '//'+ window.location.host).test(url)
            ) {
                // is request from same domain ?
                //options.headers['Origin']   = window.protocol+'//'+window.location.host;
                //options.headers['Origin']   = '*';
                //options.headers['Host']     = 'https://domain.local:3154';
                var hostRootDomain  = domainInstance.getRootDomain(window.location.hostname).value;
                var urlRootDomain   = domainInstance.getRootDomain(url).value;
                var isSameDomain    = (hostRootDomain === urlRootDomain) ? true : false;
                // var isSameDomain    = ( new RegExp(window.location.hostname).test(url) ) ? true : false;

                if (gina.config.envIsDev) {
                    console.debug('Checking CORS from Popin plugin...\TODO - local CORS Proxy');
                    console.debug('Is request from same domain ? ', isSameDomain);
                }
                if (!isSameDomain) {
                    // Cross-origin request: drop credentials by default — the target
                    // server must opt in via `Access-Control-Allow-Origin` (+ `Vary: Origin`).
                    // If forced by user options, it is restored by the `$popin.options` merge.
                    //
                    // SECURITY: the previous code rewrote the URL through an external CORS
                    // proxy (`corsacme.herokuapp.com`) — an unmaintained third party that
                    // would have routed user traffic (and any credentials) through it, and
                    // which no longer resolves. Removed; cross-origin requests now go direct
                    // and rely on the server's own CORS headers.
                    options.withCredentials = false;
                }
            }
            options.url     = url;
            // updating popin options
            $popin.options  = merge(options, $popin.options);

            var result = null;

            // Fresh XHR per load — prevents concurrent popins from sharing state
            var xhr = null;
            if (window.XMLHttpRequest) {
                xhr = new XMLHttpRequest();
            } else if (window.ActiveXObject) {
                try { xhr = new ActiveXObject("Msxml2.XMLHTTP"); }
                catch (e) { try { xhr = new ActiveXObject("Microsoft.XMLHTTP"); } catch (e) {} }
            }

            if ( options.withCredentials ) { // Preflighted requests
                if ('withCredentials' in xhr) {
                    // XHR for Chrome/Firefox/Opera/Safari.
                    if (options.isSynchrone) {
                        xhr.open(options.method, options.url, options.isSynchrone)
                    } else {
                        xhr.open(options.method, options.url)
                    }
                } else if ( typeof XDomainRequest != 'undefined' ) {
                    // XDomainRequest for IE.
                    xhr = new XDomainRequest();
                    xhr.open(options.method, options.url);
                } else {
                    // CORS not supported.
                    xhr = null;
                    result = 'CORS not supported: the server is missing the header `"Access-Control-Allow-Credentials": true` ';
                    triggerEvent(gina, $el, 'error.' + id, result)
                }
            } else { // simple requests

                if (options.isSynchrone) {
                    xhr.open(options.method, options.url, options.isSynchrone)
                } else {
                    xhr.open(options.method, options.url)
                }
            }


            var resultIsObject = false;
            if (xhr) {
                // setting up headers
                xhr.withCredentials = ( typeof(options.withCredentials) != 'undefined' ) ? options.withCredentials : false;

                xhr.onerror = function(event, err) {

                    var error = 'Transaction error: might be due to the server CORS settings.\nPlease, check the console for more details.';
                    result = {
                        'status':  xhr.status, //500,
                        'error' : error
                    };

                    resultIsObject = true;
                    instance.eventData.error = result +'\n'+ err;
                    updateToolbar(result, resultIsObject);
                    triggerEvent(gina, $el, 'error.' + id, result)
                }


                for (var header in options.headers) {
                    xhr.setRequestHeader(header, options.headers[header]);
                }

                // Data loading ...
                if ( /^(1|3)$/.test(xhr.readyState) ) {
                    $popin.target.setAttribute('data-gina-popin-loading', true);
                    showLoadingShell($popin, $el);
                    armPopinTrigger($popinTrigger);
                }

                // catching ready state cb
                xhr.onreadystatechange = function (event) {
                    // Data loading ...
                    if ( /^(1|3)$/.test(xhr.readyState) ) {
                        $popin.target.setAttribute('data-gina-popin-loading', true);
                        showLoadingShell($popin, $el);
                        armPopinTrigger($popinTrigger);
                    }
                    if (xhr.readyState == 4) {
                        // Fixed: clear loading state on response complete — data-gina-popin-loading
                        // was set on readyState 1|3 but never removed, leaving the overlay blocked.
                        // Covers every status including 0, since the branch is on readyState alone.
                        $popin.target.removeAttribute('data-gina-popin-loading');
                        if ($popinTrigger) {
                            if ( /^A$/i.test($popinTrigger.tagName) ) {
                                $popinTrigger.removeAttribute('aria-disabled');
                            } else {
                                $popinTrigger.removeAttribute('disabled');
                            }
                            loadingState.disarm($popinTrigger);
                        }
                        // 200, 201, 201' etc ...
                        var result = null;

                        if ( /^2/.test(xhr.status) ) {
                            try {
                                result = xhr.responseText;
                                var contentType   = xhr.getResponseHeader("Content-Type")
                                    , isJsonContent = (/application\/json/.test( contentType )) ? true : false
                                    , isRedirecting = true // by default
                                ;
                                if ( isJsonContent ) {
                                    result = JSON.parse(xhr.responseText);
                                    result.status = xhr.status;
                                    result.contentType = contentType;
                                    isRedirecting = false;
                                }


                                instance.eventData.success = result;

                                if (
                                    // A partial re-load (data-gina-dialog-target) must reach
                                    // applyContent's slot-swap, which lives on the loaded.<id>
                                    // path (the `else` below). popinLoadContent full-replaces
                                    // $el.innerHTML and ignores partialTarget, so an open re-load
                                    // with a slot target is diverted to the else branch here;
                                    // redirect / form / JSON re-loads (no partialTarget) keep the
                                    // popinLoadContent path unchanged.
                                    !isJsonContent && $popin.isOpen && !$popin.hasForm && !$popin.partialTarget
                                    ||
                                    !isJsonContent && $popin.isOpen && isRedirecting && !$popin.partialTarget
                                ) {
                                    // console.debug('Popin now redirecting [1]');
                                    popinLoadContent(result, isRedirecting);
                                } else {

                                    if (
                                        isJsonContent && typeof(result.location) != 'undefined'
                                        ||
                                        isJsonContent && typeof(result.reload) != 'undefined'
                                    ) {
                                        var isXhrRedirect = false;
                                        if (
                                            typeof(result.isXhrRedirect) != 'undefined'
                                            && /^true$/i.test(result.isXhrRedirect)
                                        ) {
                                            isXhrRedirect = true;
                                        }
                                        // console.debug('Popin now redirecting [2]');
                                        if ( typeof(result.location) != 'undefined' && isXhrRedirect ) {
                                            if (
                                                typeof(result.popin) != 'undefined'
                                                && typeof(result.popin.close) != 'undefined'
                                            ) {
                                                $popin.isRedirecting = false;
                                                $popin.close();

                                                var _reload = (result.popin.reload) ? result.popin.reload : false;
                                                if ( !result.popin.location && !result.popin.url) {
                                                    delete result.popin;
                                                    // only exception
                                                    if (_reload) {
                                                        result.popin = { reload: _reload };
                                                    }
                                                }
                                            }

                                            var _target = '_self'; // by default
                                            if ( typeof(result.target) != 'undefined' ) {
                                                if ( /^(blank|self|parent|top)$/ ) {
                                                    result.target = '_'+result.target;
                                                }
                                                _target = result.target
                                            }

                                            // special case of location without having the popin open
                                            // can occure while tunnelling
                                            if ( /^_self$/.test(_target) ) {
                                                var popinUrl = null;
                                                if ( typeof(result.popin) != 'undefined' ) {
                                                    popinUrl = result.popin.location || result.popin.url;
                                                } else {
                                                    popinUrl = result.location;
                                                }

                                                // was: a blind 50 ms timer that force-opened the popin if it
                                                // wasn't open yet. Vestigial (v0.1.0, 2021, 4d85d084) race-inducer:
                                                // a follow-up load slower than 50 ms let the timer open() against
                                                // a not-yet-injected (skeleton/empty) target. The already-armed
                                                // `loaded.<id>` listener opens content-first (injects the body,
                                                // then popinOpen), so the load alone suffices — no blind open.
                                                $popin
                                                    .load( $popin.name, popinUrl, $popin.options );
                                                return;
                                            }


                                            window.open(result.location, _target);
                                            return;
                                        }

                                        if ( typeof(result.location) != 'undefined' ) {
                                            // console.debug('Popin now redirecting [4]');
                                            document.location = result.location;
                                            return;
                                        }

                                        if ( typeof(result.reload) != 'undefined' ) {
                                            document.location.reload();
                                            return;
                                        }

                                        if ( typeof(result.popin) != 'undefined' ) {
                                            if ( typeof(result.popin.close) != 'undefined' ) {
                                                $popin.isRedirecting = false;
                                                popinClose($popin.name);
                                            }
                                        }
                                    }

                                    //if ( !isJsonContent && $popin.hasForm) {
                                        //$validatorInstance.handleXhrResponse(xhr, $forms[0], $forms[0].id, event, true);
                                        //handleXhr(xhr, $el, options, require)
                                        //return
                                    //}
                                    if ( !isJsonContent ) {
                                        if (GINA_ENV_IS_DEV)
                                            updateToolbar(result);
                                        triggerEvent(gina, $el, 'loaded.' + id, result);
                                        return
                                    }

                                    if (GINA_ENV_IS_DEV)
                                            updateToolbar(result);

                                    // #B315 — this used to dispatch on `$forms[0]`, a free variable:
                                    // `$forms` is declared only in `popinBind` (a sibling function), so
                                    // reading it here threw ReferenceError into the catch below, which
                                    // converted every successful JSON load into `error.<id>` with a 422.
                                    // `success` therefore never fired. Dispatching on `$el` matches the
                                    // two sibling triggers in this same handler (`loaded.` and `error.`)
                                    // — and popinLoad is the CONTENT loader, so a JSON response need not
                                    // involve a form at all.
                                    triggerEvent(gina, $el, 'success.' + id, result);

                                }

                                if (GINA_ENV_IS_DEV)
                                    updateToolbar(result);

                            } catch (err) {

                                resultIsObject = false;

                                result = {
                                    'status':  422,
                                    'error' : err.description || err.stack
                                };

                                if ( /application\/json/.test( xhr.getResponseHeader("Content-Type") ) ) {
                                    result.error = JSON.parse(xhr.responseText);
                                    resultIsObject = true
                                }

                                instance.eventData.error = result;
                                if (GINA_ENV_IS_DEV)
                                    updateToolbar(result, resultIsObject);

                                triggerEvent(gina, $el, 'error.' + id, result)
                            }

                        } // EO if ( /^2/.test(xhr.status) )
                        else {
                            //console.log('error event triggered ', event.target, $form);
                            resultIsObject = false;
                            result = {
                                'status':  xhr.status,
                                'error' : xhr.responseText
                            };

                            if ( /application\/json/.test( xhr.getResponseHeader("Content-Type") ) ) {
                                result.error = JSON.parse(xhr.responseText);
                                resultIsObject = true
                            }

                            instance.eventData.error = result;


                            // update toolbar
                            if (GINA_ENV_IS_DEV)
                                updateToolbar(result, resultIsObject);

                            triggerEvent(gina, $el, 'error.' + id, result)
                        }
                    }
                };

                // catching request progress
                // xhr.onprogress = function(event) {
                //     //console.log(
                //     //    'progress position '+ event.position,
                //     //    '\nprogress total size '+ event.totalSize
                //     //);
                //
                //     var percentComplete = (event.position / event.totalSize)*100;
                //     var result = {
                //         'status': 100,
                //         'progress': percentComplete
                //     };
                //
                //     instance.eventData.onprogress = result;
                //
                //     triggerEvent(gina, $el, 'progress.' + id, result)
                // };

                // catching timeout
                // xhr.ontimeout = function (event) {
                //     var result = {
                //         'status': 408,
                //         'error': 'Request Timeout'
                //     };
                //
                //     instance.eventData.ontimeout = result;
                //
                //     triggerEvent(gina, $el, 'error.' + id, result)
                // };


                // sending
                //var data = JSON.stringify({ sample: 'data'});
                xhr.send();


                return {
                    'open': function () {
                        var fired = false;
                        addListener(gina, $el, 'loaded.' + id, function(e) {

                            e.preventDefault();

                            if (!fired) {
                                fired = true;

                                setActivePopinId($popin.id);
                                popinBind(e, $popin);
                                popinOpen($popin.name);
                            }
                        });
                    }
                }
           }

        }

        /**
         * popinLoadContent
         *
         * @param {string} html - plain/text
         * @param {boolean} [isRedirecting] - to handle link inside popin without form
         */
        function popinLoadContent(stringContent, isRedirecting) {

            var $popin = getActivePopin();
            if ( !$popin ) {
                return;
            }
            if (!$popin.isOpen)
                throw new Error('Popin `'+$popin.name+'` is not open !');

            $popin.isRedirecting = ( typeof(isRedirecting) != 'undefined' ) ? isRedirecting : false;

            var $el = $popin.target;
            // if (
            //     typeof(stringContent) != 'undefined'
            //     && typeof(stringContent.trim) == 'function'
            // ) {
                $el.innerHTML = stringContent.trim();
            // }

            popinUnbind($popin.name, true);
            popinBind({ target: $el, type: 'loaded.' + $popin.id }, $popin);

            // Fixing Safari repaint issue - 2023-02-02
            // Not needed when using `dialog` instead of `div`
            if ( !self.options.useDialogMode ) {
                 refreshCSS();
            }

            if ( !$popin.isRedirecting ) {
                triggerEvent(gina, instance.target, 'open.'+ $popin.id, $popin);
            } else {
                // console.debug('Popin now redirecting [1-b]');
                triggerEvent(gina, instance.target, 'loaded.' + $popin.id, $popin);
            }

            // Update toolbar
            if ( gina && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                try {
                    ginaToolbar.update("el-xhr", $popin.id);
                } catch (err) {
                    throw err
                }
            }
        }

        /**
         * Loads an external script by injecting a <script> element into the document head.
         * Browser handles loading in parallel — no sequential XHR or eval().
         *
         * @param {string} source - Script URL
         * @param {object} [$popin] - Popin object for tracking injected headers (cleaned up on close)
         */
        function getScript(source, $popin) {
            var s = document.createElement('script');
            s.src = source;
            s.id = 'popin-script-' + _nextId();
            if ($popin) { $popin.$headers.push({ id: s.id }); }
            document.head.appendChild(s);
        }

        /**
         * Loads an external stylesheet by injecting a <link> element into the document head.
         * Browser handles loading in parallel — no sequential XHR or eval().
         *
         * @param {string} source - Stylesheet URL
         * @param {object} [$popin] - Popin object for tracking injected headers (cleaned up on close)
         */
        function getStyle(source, $popin) {
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = source;
            link.id = 'popin-style-' + _nextId();
            if ($popin) { $popin.$headers.push({ id: link.id }); }
            document.head.appendChild(link);
        }

        function refreshCSS() {
            if (!/safari/i.test(window.navigator.userAgent)) {
                return;
            }
            let links = document.getElementsByTagName('link');
            for (let i = 0; i < links.length; i++) {
                if (
                    links[i].getAttribute('rel') == 'stylesheet'
                ) {

                    let href = links[i].getAttribute('href')
                                        .split('?')[0];
                    // only for gina styles
                    if ( !/gina\.min\.css|gina\.css/.test(href) ) {
                        continue;
                    }

                    let newHref = href + '?version='
                                + new Date().getMilliseconds();

                    links[i].setAttribute('href', newHref);
                }
            }
        }

        /**
         * popinOpen
         *
         * If you get a x-origin error, check if you have `Vary` rule
         * set in your policy : // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Vary
         *
         * Add to your project/env.json the following rule
         * {
         *  "$bundle" : {
         *      "server": {
         *          "response": {
         *              // other definitions ...
         *
         *              "vary": "Origin"
         *          }
         *      }
         *  }
         * }
         *
         * Opens a popin by name
         *
         * @parama {string} name
         *
         * */
        function popinOpen(name) {

            var id = null, $el = null;
            var $popin = ( typeof(name) != 'undefined') ? getPopinByName(name) : getPopinById(this.id);
            if ( !$popin ) {
                throw new Error('Popin name `'+name+'` not found !')
            }
            id = $popin.id;
            $el = document.getElementById(id);

            // load external resources in order of declaration
            var globalScriptsList   = $popin.parentScripts
                , scripts           = $el.getElementsByTagName('script')
                , globalStylesList  = $popin.parentStyles
                // A <link> element can occur either in the <head> or <body> element, depending on whether it
                , styles            = $el.getElementsByTagName('link')
                , i                 = 0
                , len               = scripts.length
            ;
            var domain = gina.config.hostname.replace(/(https|http|)\:\/\//, '').replace(/\:\d+$/, '');
            var reDomain = new RegExp(domain+'\:\\d+\|'+domain);
            for (;i < len; ++i) {
                if ( typeof(scripts[i].src) == 'undefined' || scripts[i].src == '' ) {
                    continue;
                }
                let filename = scripts[i].src
                                .replace(/(https|http|)\:\/\//, '')
                                .replace(reDomain, '');
                // don't load if already in the global context
                if ( globalScriptsList.indexOf(filename) > -1 )
                    continue;

                getScript(scripts[i].src, $popin);
            }

            // Styles
            i   = 0;
            len = styles.length;
            for (;i < len; ++i) {
                if ( typeof(styles[i].href) == 'undefined' || styles[i].href == '' ) {
                    continue;
                }
                let filename = styles[i].href
                                .replace(/(https|http|)\:\/\//, '')
                                .replace(reDomain, '');
                // don't load if already in the global context
                if ( globalStylesList.indexOf(filename) > -1 )
                    continue;

                getStyle(styles[i].href, $popin);
            }

            // Skip if already bound by the loaded listener — avoids double DOM scanning
            if (!gina.popinIsBinded) {
                popinBind({ target: $el, type: 'loaded.' + $popin.id }, $popin);
            }


            $el.classList.add('gina-popin-is-active');

            // Non-dialog mode only: activate the manual overlay — the non-dialog path has
            // no native ::backdrop (see the showModal() branch).
            if ( !self.options.useDialogMode ) {
                // overlay
                instance.target.firstChild.classList.add('gina-popin-is-active');
                // overlay
                if ( instance.target.firstChild.classList.contains('gina-popin-is-active') ) {
                    removeListener(gina, instance.target, 'open.'+ $popin.id)
                }
            }


            // Fix today's name-based aria-labelledby: associate a REAL title element.
            associateLabel($el);

            if ( self.options.useDialogMode && !$el.getAttribute('open') ) {
                // Modal vs non-modal. The new `data-gina-dialog` API defaults to
                // non-modal — openFromTrigger sets `$popin.modal`. Any path that did NOT
                // set it (legacy `data-gina-popin-*` triggers, direct popinOpen() calls)
                // falls back to modal, preserving today's showModal()-only parity.
                var useModal = ( typeof($popin.modal) == 'boolean' ) ? $popin.modal : true;
                if ( typeof($el.showModal) === "function" ) {
                    if ( useModal ) {
                        // showModal() promotes the dialog to the top layer with a native
                        // ::backdrop and inerts the rest of the page. Consumers that
                        // preemptively open the dialog (skeleton-loading) MUST also use
                        // showModal() so it is born modal; the !getAttribute('open') guard
                        // above then skips this call (re-showModal on an open dialog throws).
                        $el.showModal();
                    } else {
                        // Non-modal: .show() loses the native ::backdrop / Escape /
                        // scroll-block / focus-trap — applyNonModalShims() restores them.
                        $el.show();
                        applyNonModalShims($popin, $el);
                        focusInitial($el);
                    }
                } else {
                    $el.setAttribute('open', true)
                }
            }

            // A native <dialog> can be closed by the user agent — pressing Escape, or
            // submitting a `<form method="dialog">` inside it — which fires the element's
            // native `close` event WITHOUT going through popinClose(). popinClose() is the
            // only path that resets `isOpen`, runs popinUnbind() (clearing an AJAX popin's
            // innerHTML + removing its `loaded.<id>` listener) and restores the toolbar, so
            // a UA close otherwise leaves the reused element stale and `isOpen` stuck true.
            // Bind a one-time native `close` listener that runs the same cleanup. We listen
            // to `close` (not `cancel`): `close` fires for BOTH Escape and method="dialog";
            // `cancel` is Escape-only. De-dup: on the plugin's own close, popinClose() sets
            // isOpen=false synchronously before the queued `close` event fires, so the guard
            // below sees isOpen===false and no-ops (popinClose() also re-guards on !isOpen),
            // and popinClose()'s $el.close() on an already-closed dialog is a spec no-op so
            // there is no recursion. `_ginaCloseSyncBound` keeps it to one listener across
            // element reuse; gated on useDialogMode (non-dialog mode is a <div>, no `close`
            // event). Native addEventListener — NOT gina's addListener (the custom event bus).
            if ( self.options.useDialogMode && $el && !$el._ginaCloseSyncBound ) {
                $el._ginaCloseSyncBound = true;
                $el.addEventListener('close', function () {
                    if ( $popin.isOpen ) {
                        popinClose($popin.name);
                    }
                });
            }

            $popin.isOpen = true;
            // so it can be forwarded to the handler who is listening
            $popin.target = $el;

            setActivePopinId($popin.id);

            // update toolbar
            if ( gina && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar /**&& GINA_ENV_IS_DEV*/) {
                try {
                    ginaToolbar.update("el-xhr", $popin.id);
                } catch (err) {
                    throw err
                }
            }

            triggerEvent(gina, instance.target, 'open.'+ $popin.id, $popin);
        }

        /**
         * popinUnbind
         *
         * Closes a popin by `name` or all `is-active`
         *
         * @parama {string} [name]
         *
         * */
        function popinUnbind(name, isRouting) {

            var $popin = ( typeof(name) != 'undefined') ? getPopinByName(name) : getActivePopin();
            var $el = null;
            if ( !$popin && typeof(name) != 'undefined' ) {
                throw new Error('Popin `'+name+'` not found !');
            }

            // by default
            if ( typeof($popin) != 'undefined' && $popin != null ) {
                $el = $popin.target;

                isRouting = ( typeof(isRouting) != 'undefined' ) ? isRouting : false;

                if ( $el != null && $el.classList.contains('gina-popin-is-active') ) {
                    if (!isRouting) {
                        // Non-dialog mode only: clear the manual overlay's active state.
                        // In dialog mode the `gina-popins` container has no overlay
                        // first-child (popinCreateContainer skips it — native ::backdrop is
                        // used instead), so guard the firstChild access to avoid a null
                        // deref on close. Mirrors the open-path guard above.
                        if ( !self.options.useDialogMode ) {
                            instance.target.firstChild.classList.remove('gina-popin-is-active');
                        }
                        $el.classList.remove('gina-popin-is-active');
                        // In-page (static) dialogs own their authored content — it must
                        // persist across close + reopen. Only clear for AJAX-loaded popins
                        // (the legacy default), whose body was injected at load time.
                        if ( !$popin.isInPageDialog ) {
                            $el.innerHTML                       = '';
                            // #B139 — the content cache dies with the content: clear
                            // this popin's URL slot so the next open warms FRESH
                            // instead of consuming this open's leftover — then SWEEP
                            // the same slot once the teardown task has drained: the
                            // close-time focus-return and pointer re-hover re-warm
                            // the URL within ~1ms (measured), refilling it with
                            // close-era content the next open would serve stale. The
                            // sweep's race direction is benign (at most one extra
                            // fetch, never stale content).
                            var _closedContentUrl = $popin._contentUrl;
                            clearContentPreload($popin);
                            if ( _closedContentUrl ) {
                                setTimeout(function () {
                                    clearPreloadSlot(_closedContentUrl);
                                }, 120);
                            }
                        }
                    }
                    // Fixed: clear loading state on reset — defensive cleanup for navigation
                    // within a popin that was in loading state when reset was called.
                    $el.removeAttribute('data-gina-popin-loading');
                    // Trigger-scoped release. This function is ALSO reached from routing
                    // transitions that never call popinClose, so without this the control
                    // that opened a popin torn down by a route change would stay armed.
                    // Resolved here rather than passed in: popinUnbind only has $popin, and
                    // `disarm` is a no-op on the null a trigger-less popin resolves to.
                    loadingState.disarm( document.getElementById($popin.openTrigger) );

                    // removing from FormValidator instance
                    if ($validatorInstance && $validatorInstance['$forms']) {
                        // #B265: iterate a COPY, and clear the array ONCE. The previous loop
                        // spliced `$popin['$forms']` while walking it against a length captured
                        // BEFORE the loop, so every element shifted left under the cursor and the
                        // read index skipped one each time: the originally odd-indexed forms were
                        // never destroyed AND were left behind in the very array the loop exists
                        // to empty. Their validator entries then survived pointing at nodes the
                        // `innerHTML = ''` above had already detached, so `validateFormById`
                        // returned the stale entry on the next open and the form — trigger
                        // included — was silently never re-bound.
                        var _formIds = $popin['$forms'].slice();
                        $popin['$forms'].length = 0;
                        for (var i = 0, _formIdsLen = _formIds.length; i < _formIdsLen; ++i) {
                            var $formToDestroy = $validatorInstance['$forms'][ _formIds[i] ];
                            if ( typeof($formToDestroy) == 'undefined' ) {
                                continue;
                            }
                            try {
                                $formToDestroy.destroy();
                            } catch (destroyErr) {
                                // One form must never abort the teardown of the others.
                                // `destroy()` -> `unbindForm` -> `getFormById(vFormId)` throws for
                                // a form holding a `data-gina-form-virtual` file input whose
                                // virtual form is no longer resolvable — and by this point every
                                // form here is detached, which is exactly when that lookup fails.
                                // This hazard is PRE-EXISTING, not introduced by the fix above:
                                // before it, a throw here silently left every LATER form bound.
                                if ( typeof(console) != 'undefined' && console.warn ) {
                                    console.warn('[gina] popin teardown: destroy() failed for form `' + _formIds[i] + '`', destroyErr);
                                }
                            }
                        }
                    }

                    gina.popinIsBinded = false;

                    // remove listeners
                    removeListener(gina, $popin.target, 'loaded.' + $popin.id);
                }
            }
        }


        /**
         * popinClose
         *
         * Closes a popin by `name` or all `is-active`
         *
         * @parama {string} [name]
         *
         * */
        function popinClose(name) {

            var $popin = null;
            if ( typeof(name) == 'undefined' && /^true$/.test(this.isOpen) ) {
                name    = this.name;
                $popin  = this;
            } else {
                $popin  = getPopinByName(name) || getActivePopin();
                if (!$popin)
                    return;

                name    = $popin.name;
            }
            //var $popin = ( typeof(name) != 'undefined') ? getPopinByName(name) : getActivePopin();
            var $el = null;
            if ( !$popin && typeof(name) != 'undefined' ) {
               throw new Error('Popin `'+name+'` not found !');
            }
            if (!$popin.isOpen)
                return;

            // by default
            if ( typeof($popin) != 'undefined' && $popin != null ) {

                // in case popinClose is called by the user e.g.: binding cancel/close with a <A> tag
                // but at the same time, the <A> href is not empty -> redirection wanted in the HTML
                // in this case, we want to ignore close
                if ( $popin.isRedirecting )
                    return;

                $el = $popin.target;
                var $popinTrigger = document.getElementById($popin.openTrigger) || null;

                if ( typeof($el.close) === "function" ) {
                    $el.close();
                } else {
                    $el.removeAttribute('open')
                }

                removeListener(gina, $popin.target, 'ready.' + instance.id);

                if ( $popin.hasForm ) {
                    $popin.hasForm = false;
                }

                if ( $el != null && $el.classList.contains('gina-popin-is-active') ) {

                    popinUnbind(name);
                    $popin.isOpen           = false;
                    gina.popinIsBinded      = false;

                    // restore toolbar
                    if ( GINA_ENV_IS_DEV && gina &&  typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar )
                        ginaToolbar.restore();

                    setActivePopinId(null);
                    if ( $popin.$headers.length > 0) {
                        var s = 0
                            , sLen = $popin.$headers.length
                        ;
                        try {
                            for (; s<sLen; ++s) {
                                document.getElementById( $popin.$headers[s].id ).remove();
                            }
                        } catch(err){
                            console.warn('Could not remove script `'+ $popin.$headers[s].id +'`\n'+ err.stack)
                        }
                        $popin.$headers = [];
                    }

                    // Tear down the non-modal a11y shims (Escape handler, scroll-lock,
                    // background inert). Idempotent — a no-op for popins opened modal.
                    removeNonModalShims($el);

                    if ($popinTrigger) {
                        // For A tag: aria-disabled=true
                        if ( /^A$/i.test($popinTrigger.tagName) ) {
                            $popinTrigger.removeAttribute('aria-disabled', true);
                        } else {
                            $popinTrigger.removeAttribute('disabled', true);
                        }
                        loadingState.disarm($popinTrigger);
                        // a11y: return focus to the trigger that opened the popin.
                        if ( typeof($popinTrigger.focus) == 'function' ) {
                            $popinTrigger.focus();
                        }
                    }
                    // Fixed: clear loading state on explicit close — defensive cleanup in case
                    // the popin is closed before the XHR completes or after a non-XHR flow.
                    $el.removeAttribute('data-gina-popin-loading');
                    triggerEvent(gina, $popin.target, 'close.'+ $popin.id, $popin);
                }
            }
        }

        /**
         * popinDestroy
         *
         * Destroys a popin by name: closes it if open, removes event listeners,
         * removes the DOM element, and cleans up the internal registry.
         *
         * @param {string} [name] - Popin name. If omitted, destroys the active popin.
         */
        function popinDestroy(name) {

            var $popin = ( typeof(name) != 'undefined') ? getPopinByName(name) : getActivePopin();
            var id = null, $el = null;
            if ( !$popin && typeof(name) != 'undefined' ) {
                throw new Error('Popin `'+name+'` not found !');
            }
            if ( !$popin ) return;

            id = $popin.id;
            name = $popin.name;

            // Close first if still open (handles listener cleanup, form unbinding, header removal)
            if ( $popin.isOpen ) {
                $popin.isRedirecting = false;
                popinClose(name);
            }

            // Remove the DOM element
            $el = document.getElementById(id);
            if ( $el ) {
                $el.remove();
            }

            // Remove remaining listeners
            removeListener(gina, $popin.target, 'loaded.' + id);
            removeListener(gina, $popin.target, 'ready.' + id);
            removeListener(gina, $popin.target, 'open.' + id);
            removeListener(gina, $popin.target, 'close.' + id);

            // Clean up registry
            delete instance.$popins[id];
            var regIdx = registeredPopins.indexOf(name);
            if ( regIdx > -1 ) {
                registeredPopins.splice(regIdx, 1);
            }

            // Reset active if this was the active popin (#B90 — the published
            // value is the source of truth: another instance may have set it)
            var _activePopinId = ( typeof(gina.popin) != 'undefined' && gina.popin ) ? gina.popin.activePopinId : instance.activePopinId;
            if ( _activePopinId === id ) {
                setActivePopinId(null);
            }

            triggerEvent(gina, instance.target, 'destroy.' + id, { name: name, id: id });
        }

        function registerPopin($popin, options) {

            if ( typeof(options) != 'object' ) {
                throw new Error('`options` must be an object')
            }

            $popin.options = merge(options, self.options);
            $popin.id = 'gina-popin-' + instance.id +'-'+ $popin.options['name'];

            if ( typeof(instance.$popins[$popin.id]) == 'undefined' ) {

                if ( typeof($popin.options['name']) != 'string' || $popin.options['name'] == '' ) {
                    throw new Error('`options.name` can not be left `empty` or `undefined`')
                }

                if ( registeredPopins.indexOf($popin.options['name']) > -1 ) {
                    throw new Error('`popin '+$popin.options['name']+'` already exists !')
                }
                registeredPopins.push($popin.options['name']);

                // import over plugins
                if ( typeof($popin.options['validator']) != 'undefined' ) {
                    $validatorInstance = $popin.options['validator'];
                    $popin.validateFormById = $validatorInstance.validateFormById;
                }


                $popin.options['class'] = 'gina-popin-container ' + $popin.options['class'];


                $popin.name             = $popin.options['name'];
                $popin.target           = instance.target;
                $popin.load             = popinLoad;
                $popin.loadContent      = popinLoadContent;
                $popin.open             = popinOpen;
                $popin.close            = popinClose;
                if (GINA_ENV_IS_DEV)
                    $popin.updateToolbar    = updateToolbar;

                // Get main resources
                $popin.parentScripts    = [];
                $popin.parentStyles     = [];
                var domain = gina.config.hostname.replace(/(https|http|)\:\/\//, '').replace(/\:\d+$/, '');
                var reDomain = new RegExp(domain+'\:\\d+\|'+domain);
                // Parent scripts
                var mainDocumentScripts = document.getElementsByTagName('script');
                for (let s = 0, len = mainDocumentScripts.length; s < len; s++ ) {
                    if (!mainDocumentScripts[s].src || mainDocumentScripts[s].src == '')
                        continue;
                    // Filename without domain
                    let filename = mainDocumentScripts[s].src
                                    .replace(/(https|http|)\:\/\//, '')
                                    .replace(reDomain, '');
                    $popin.parentScripts[s] = filename;
                }
                // Parent Styles
                var mainDocumentStyles  = document.getElementsByTagName('link');
                for (let s = 0, len = mainDocumentStyles.length; s < len; s++ ) {
                    if ( typeof(mainDocumentStyles[s].rel) == 'undefined' || !/stylesheet/i.test(mainDocumentStyles[s].rel) )
                        continue;
                    // Filename without domain
                    let filename = mainDocumentStyles[s].href
                                    .replace(/(https|http|)\:\/\//, '')
                                    .replace(reDomain, '');
                    $popin.parentStyles[s] = filename;
                }



                instance.$popins[$popin.id] = $popin;

                // XHR is now created per popinLoad() call — no shared instance needed

                bindOpen($popin);
            }
        }

        var init = function(options) {

            setupInstanceProto();

            // New `data-gina-dialog-*` entry layer — install the delegated open + preload
            // listeners once per page (module-guarded). Additive to the legacy bindOpen
            // scan (which registerPopin still runs per popin). The eager pass warms
            // `data-gina-dialog-preload="eager"` triggers off the critical path
            // (post-load idle) through the same warmTrigger gate.
            bindDelegatedOpen();
            installPreload();
            installEagerPreload();
            //instance.on('init', function(event) {
            addListener(gina, instance.target, 'init.'+instance.id, function(e) {

                var $newPopin = null;
                var popinId = 'gina-popin-' + instance.id +'-'+ options['name'];
                if ( typeof(instance.$popins[popinId]) == 'undefined' ) {
                    var $newPopin = merge({}, $popin);
                    registerPopin($newPopin, options);
                }

                instance.isReady = true;
                gina.hasPopinHandler = true;
                // #B90 — publish ONCE: `gina.popin` IS the first instance (a LIVE
                // object). Re-publishing per construction (a target-wins deep copy
                // of each new instance) froze the first instance's accessors and
                // scalar state on the published object — `getPopinByName` /
                // `getPopinById` resolved only the boot registry and
                // `activePopinId` never moved. The registry is module-shared now
                // (`$popins` aliases `_sharedPopins` in every instance), so later
                // constructions have nothing to publish — and re-merging would
                // self-merge the shared registry (a deep recursion into every
                // registered $popin).
                if ( typeof(gina.popin) == 'undefined' || !gina.popin ) {
                    gina.popin = instance;
                }
                // trigger popin ready event
                triggerEvent(gina, instance.target, 'ready.' + instance.id, $newPopin);
            });




            instance.initialized = true;

            return instance
        }

        var setupInstanceProto = function() {
            instance.getPopinById   = getPopinById;
            instance.getPopinByName = getPopinByName;
            instance.load           = popinLoad;
            instance.loadContent    = popinLoadContent;
            instance.getActivePopin = getActivePopin;
            instance.open           = popinOpen;
            instance.close          = popinClose;
            instance.destroy        = popinDestroy;
        }


        if ( !gina.hasPopinHandler ) {
            popinCreateContainer();
        } else {
            popinGetContainer()
        }

        if (!domainInstance) {
            new Domain( function onReady(err, _domainInstance) {
                if (err) {
                    throw err
                }

                domainInstance = _domainInstance;
            });
        }

        return init(options)
    }

    return Popin
});