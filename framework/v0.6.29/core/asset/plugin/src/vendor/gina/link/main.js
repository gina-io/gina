define('gina/link', [ 'require', 'lib/domain', 'lib/loading-state', 'lib/merge', 'lib/uuid', 'utils/events' ], function (require) {

    var Domain          = require('lib/domain');
    var domainInstance  = null;
    var loadingState    = require('lib/loading-state');
    var merge           = require('lib/merge');
    var uuid            = require('lib/uuid');

    require('utils/events'); // events

    /**
     * Gina Link Handler
     *
     * Activate binding with: `data-gina-link`
     * Optional, if your a.href is empty or with another value than the targeted action : `data-gina-link-url`
     *
     * @param {object} options
     * */
    function Link(options) {

        this.plugin = 'link';

        var events  = ['loaded', 'ready', 'open', 'close', 'destroy', 'success', 'error', 'progress'];
        registerEvents(this.plugin, events);

        var self = { // local use only
            'options' : {
                'url' : undefined,
                'class': 'gina-link-default'
            },
            authorizedEvents : ['ready', 'success', 'error'],
            events: {}
        };

        var instance        = {
            plugin          : this.plugin,
            id              : 'gina-links-' + uuid(),
            on              : on,
            eventData       : {},

            '$links'       : {},
            target          : document, // by default
            isReady         : false,
            initialized     : false
        };

        // link proto
        var $link          = { // is on main `gina-links` container (first level)
            'plugin'            : this.plugin,
            'on'                : on,
            'eventData'         : {},
            'target'            : document, // by default

            'url'               : null,
            'request'           : null,
            '$forms'            : []
        };



        // XML Request — the request currently in flight, plus a monotonic sequence.
        //
        // These replace a single module-scope `xhr` that every link click reused.
        // That is the #B175 class popin already fixed and nav deliberately avoids:
        // calling `open()` on an object that is still carrying a request implicitly
        // ABORTS it, and an aborted request reaches readyState 4 with status 0 —
        // which `handleXhr` has no branch for. So the first click's completion never
        // arrived at all, and anything waiting on it waited forever.
        //
        // The sequence exists because aborting is not enough on its own: the
        // superseded request may already have reached readyState 4 and queued its
        // handler. `_linkSeq` lets that stale response be dropped rather than acted
        // upon, so a slow first response can never overwrite a newer one.
        var _linkXhr = null;
        var _linkSeq = 0;

        /**
         * #B287 — the registration the user actually operated, handed from the
         * dispatch listener in `registerLink` to `linkRequest` so that anchors
         * sharing one url resolve to the anchor that was clicked rather than to
         * the first registration whose url matches. Both click paths — the
         * direct anchor listener and `proxyClick`'s child delegation — dispatch
         * into that same listener, so this single hand-off covers both.
         * Consumed (and cleared) at `linkRequest` entry, before anything else
         * runs, so an early exit can never leak it into a later call; the
         * public `gina.link.request(url)` path never sets it and keeps the
         * historical first-match lookup.
         * @type {object|null}
         */
        var _operatedLink = null;

        /**
         * Build a fresh transport for a single request.
         *
         * Was inlined in the `init` handler, which created ONE object for the whole
         * page lifetime. Per-request construction is what makes concurrent link
         * clicks independent.
         *
         * @returns {object} a new XHR-like object, or `null` when the browser has none
         *
         * @example
         * var xhr = createXhr(); // fresh per request — never shared
         *
         * @inner
         */
        var createXhr = function() {
            if (window.XMLHttpRequest) { // Mozilla, Safari, ...
                return new XMLHttpRequest();
            }
            if (window.ActiveXObject) { // IE
                try {
                    return new ActiveXObject("Msxml2.XMLHTTP");
                } catch (e) {
                    try {
                        return new ActiveXObject("Microsoft.XMLHTTP");
                    }
                    catch (e) {}
                }
            }
            return null;
        };

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

        var registeredLinks = [];



        /**
         * A click the user asked the BROWSER to handle specially — cmd/ctrl for a new
         * tab, shift for a new window, alt for a download in some browsers. Binding it
         * swallows that intent, exactly as the `download` / `target` / `#` shapes did
         * before the bind-time guard in `bindLinks`.
         *
         * Mirrors the nav plugin's equivalent test, with two deliberate differences:
         *   - nav also bails on `event.defaultPrevented`. That cannot be reused here:
         *     this plugin's own per-anchor listener suppresses the default before the
         *     document proxy runs, so the flag is always set by the time the proxy is
         *     reached and the bail would fire on every single click.
         *   - nav also bails on a non-left `event.button`. Measured unnecessary here:
         *     a middle click fires `auxclick`, not `click`, so it never arrives.
         *
         * Must be consulted at every site that still holds the NATIVE event — the
         * per-anchor listener, the document proxy and this child proxy. The custom
         * event dispatched onward carries no modifier data at all (`triggerEvent`
         * copies native properties only when handed a `proxiedEvent`, which no call
         * site here does), so a check placed after that hop could never fire.
         *
         * @inner
         * @private
         * @param {object} e - the native click event
         * @returns {boolean} true when a modifier key was held
         *
         * @example
         * if ( isModifiedClick(e) ) return; // let the browser open its new tab
         */
        var isModifiedClick = function(e) {
            return !!( e && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) );
        }

        /**
         * isLinkDisabled
         *
         * Tells whether a bound link is currently marked disabled — #B310's
         * click-time gate. The predicate is the popin trigger gate's (#B296),
         * itself mirroring the validator's (#B293), so all three subsystems
         * agree on what "disabled" means for a trigger: the aria-disabled
         * marker always counts; the native attribute counts only where
         * `disabled` is not a real IDL property (on an anchor it never is, so
         * both arms are live here), because a genuine form control's
         * browser-enforced disable never lets the click reach JS at all.
         *
         * Consulted at the TWO dispatch sites that turn a click into a
         * request — the document proxy and the child-node proxy — AFTER their
         * cancelEvent: a registered link keeps suppressing its default, gated
         * or not, so a disabled link goes nowhere rather than falling back to
         * navigation. Deliberately NOT consulted in linkRequest (the public
         * API + the redirect funnel — a programmatic call is not operating
         * the control, the same scope reasoning as the validator's gesture
         * gate) nor in the per-anchor CSP suppression listener (a gated link
         * still suppresses its default).
         *
         * @inner
         * @private
         * @param {object} $el - the bound anchor
         * @returns {boolean} true when the link is marked disabled
         *
         * @example
         * if ( isLinkDisabled($el) ) return; // swallow the click, send nothing
         */
        var isLinkDisabled = function($el) {
            return !!(
                $el
                && (
                    !('disabled' in $el)
                    && $el.getAttribute('disabled') != null && $el.getAttribute('disabled') != 'false'
                    || $el.getAttribute('aria-disabled') == 'true'
                )
            );
        }

        var proxyClick = function($childNode, $el, evt) {

            addListener(gina, $childNode, 'click', function(e) {
                if ( isModifiedClick(e) ) return;

                cancelEvent(e);
                // #B310 — the disabled gate, AFTER cancelEvent: a registered
                // link keeps suppressing its default, gated or not.
                if ( isLinkDisabled($el) ) return;

                triggerEvent(gina, $el, evt);
            });
        }

        var getLinkById = function(id) {
            return ( typeof(instance.$links[id]) != 'undefined' ) ? instance.$links[id] : null;
        }

        var getLinkByUrl = function(url) {
            var $link = null;

            for (var p in gina.link.$links) {
                if ( typeof(gina.link.$links[p].url) != 'undefined' && gina.link.$links[p].url == url ) {
                    $link = gina.link.$links[p];
                    break;
                }
            }

            return $link;
        }



        /**
         * linkRequest
         *
         * Builds and sends the request for a bound link. Every entry point funnels
         * through here — the direct click, the `proxyClick` child delegation and the
         * public `gina.link.request()` — which is why the loading state is armed here
         * rather than in the click handlers: `$el` is already the anchor at this point,
         * so no click target ever has to be walked back up to it.
         *
         * The link object resolves in two steps (#B287): the operated registration
         * handed off by the dispatch listener wins; only when none was handed off —
         * the public `gina.link.request(url)` path — does the historical first-match
         * url lookup run. Before this order existed, two anchors sharing one url
         * collapsed onto whichever registered first, whichever was clicked.
         *
         * A url that resolves to no registration throws a named error BEFORE the
         * supersede step (#B328) — a miss can never abort a request already in
         * flight, and the message names the url plus the likely cause. A
         * registration whose anchor has left the DOM throws the same way (#B418):
         * there is no deregistration path, so registrations outlive their
         * elements, and the link contract cannot proceed without the anchor.
         *
         * Side effects: supersedes any request still in flight, arms `data-gina-loading`
         * on the anchor for the duration of this one, and releases it from a `loadend`
         * listener. An indefinite hang is the single outcome that never releases, because
         * no `xhr.timeout` is set.
         *
         * @param {string} url - URL to request
         * @param {object} [options] - XHR options, merged over the link's own
         *
         * @throws {Error} when `url` matches no registration, or the matched
         *  registration's anchor is no longer in the DOM (both public-path misses)
         *
         * @returns {void}
         *
         * @example
         * gina.link.request('/some/route'); // arms the bound anchor, releases on loadend
         *
         * @inner
         * */
        function linkRequest(url, options) {

            // #B287 — consume the operated registration FIRST so no later step
            // (nor an early exit) can leak it into a subsequent call.
            var $operated = _operatedLink;
            _operatedLink = null;

            // link object — #B287: the operated registration wins; the first-match
            // url lookup remains only for the public `gina.link.request(url)` path.
            // #B328 — resolved (and guarded) BEFORE the transport block below:
            // resolving after it meant a mistyped public url had already aborted a
            // legitimate in-flight request before throwing a bare TypeError on
            // `$link.id`. A miss now leaves transport state untouched.
            var $link      = $operated || getLinkByUrl(url);
            if ( !$link ) {
                // Named like #B415's null-table guard: tell a mistyped url from the
                // real second shape — a registration added by a later construction,
                // which the published instance's walk cannot see (#B326).
                throw new Error('[ LinkHandler::request(url, options) ] : no link is registered for url `'+ url +'` (never bound, or bound by a later construction — the published instance walks only its own registrations)');
            }
            // link element — #B418: same shape, second miss. A registration can
            // outlive its anchor (there is no deregistration path, so a page that
            // re-renders its anchors leaves the registration pointing at nothing),
            // and the bare `$el.getAttribute` below then threw a raw TypeError —
            // after the supersede block had aborted an in-flight request and
            // bumped the sequence, whose stale-response wrapper drops that
            // request's completion. Resolved and guarded HERE so a miss of either
            // kind leaves transport state untouched. The link contract is
            // DOM-coupled — loading state, hlink attributes and response events
            // all target the anchor — so this cannot proceed without one.
            var id  = $link.id;
            var $el = document.getElementById(id) || null;
            if ( !$el ) {
                throw new Error('[ LinkHandler::request(url, options) ] : link `'+ id +'` is registered for url `'+ url +'` but its anchor is no longer in the DOM — registrations are not removed when their element is');
            }

            // One transport per request, and a sequence taken BEFORE the abort so a
            // supersede-abort is stale by construction — its handler sees
            // `seq !== _linkSeq` and drops out, which is what keeps the abort from
            // being mistaken for a real network failure.
            var seq = ++_linkSeq;
            if ( _linkXhr && _linkXhr.readyState !== 4 ) {
                try {
                    _linkXhr.abort();
                } catch (abortErr) { /* already dead — nothing to unwind */ }
            }
            var xhr = createXhr();
            _linkXhr = xhr;

            var hLinkIsRequired = null;
            // forward callback to HTML data event attribute through `hlink` status
            hLinkIsRequired = ( $el.getAttribute('data-gina-link-event-on-success') || $el.getAttribute('data-gina-link-event-on-error') ) ? true : false;
            // success -> data-gina-link-event-on-success
            // error -> data-gina-link-event-on-error
            if (hLinkIsRequired)
                listenToXhrEvents($link, 'link');

            // if ( $el == null ) {

            //     //var className   = $link.options.class +' '+ id;
            //     $el             = document.createElement('a');
            //     $el.setAttribute('id', id);
            //     //$el.setAttribute('class', className);
            //     instance.target.firstChild.appendChild($el);
            // }

            if ( typeof(options) == 'undefined' ) {
                options = xhrOptions;
            } else {
                options = merge(options, xhrOptions);
            }

            if ( /^(http|https)\:/.test(url) && !new RegExp('^' + window.location.protocol + '//'+ window.location.host).test(url) ) {
                // is request from same domain ?
                //options.headers['Origin']   = window.protocol+'//'+window.location.host;
                //options.headers['Origin']   = '*';
                //options.headers['Host']     = 'https://myproject.local:3154';
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
                    // If forced by user options, it is restored by the `$link.options` merge.
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
            // updating link options
            if ($link && typeof($link.options) != 'undefined')
                options  = merge($link.options, options);


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
                    var result = 'CORS not supported: the server is missing the header `"Access-Control-Allow-Credentials": true` ';
                    triggerEvent(gina, $el, 'error.' + id, result)
                }
            } else { // simple requests

                if (options.isSynchrone) {
                    xhr.open(options.method, options.url, options.isSynchrone)
                } else {
                    xhr.open(options.method, options.url)
                }
            }



            if (!xhr)
                throw new Error('No `xhr` object initiated');


            options.$link = $link;
            // The CORS branches above can swap the transport (XDomainRequest) or drop
            // it entirely, so re-point the in-flight tracker at whatever will actually run.
            _linkXhr = xhr;
            //xhr = handleXhr(xhr, $el, options);
            handleXhr(xhr, $el, options, require);

            // Sequence guard, applied by WRAPPING the handler `handleXhr` just installed
            // rather than by teaching `handleXhr` about link's sequence. `handleXhr` is
            // shared and the sequence belongs to the plugin that owns the clicks, so the
            // guard lives here and `utils/events.js` stays untouched.
            //
            // Only `onreadystatechange` needs wrapping: an aborted request fires
            // `onabort` (which `handleXhr` does not install), never `onerror`, so a
            // superseded request has exactly one way back into the completion path.
            var onSettled = xhr.onreadystatechange;
            xhr.onreadystatechange = function(event) {
                if ( seq !== _linkSeq ) {
                    return; // superseded by a newer click — drop the stale response
                }
                if ( typeof(onSettled) == 'function' ) {
                    onSettled.call(this, event);
                }
            };

            // #B247 — loading state for the link the user actually clicked.
            //
            // Armed HERE rather than in the click handlers because `$el` is already the
            // anchor at this point (`getElementById($link.id)` above), and because this
            // is the one funnel every entry reaches: the direct click, the `proxyClick`
            // child delegation — which dispatches its custom event ON the anchor, so the
            // handler's `e.target` is never the inner node — and the public
            // `gina.link.request()`. Arming below the `!xhr` throw also means a transport
            // that never materialises can not leave a trigger lit.
            //
            // Released on `loadend`, the same fail-safe the validator uses: a LISTENER
            // emits no events of its own, so it covers success, error, abort AND the
            // readyState-4/status-0 network failure `handleXhr` has no branch for —
            // without any of the consumer-visible surface that adding such a branch
            // would carry (#B282). One listener per transport, and transports are built
            // per request, so nothing accumulates.
            //
            // Never arm what can not be released: the CORS branch above can swap in a
            // legacy `XDomainRequest`, which has no `addEventListener` and so no
            // `loadend` to release on. An armed trigger with no release is exactly the
            // permanent strand this feature exists to prevent.
            //
            // Deliberately NOT sequence-guarded, unlike the response wrapper above. The
            // sequence drops a stale RESPONSE; a superseded request must still RELEASE
            // its trigger. It releases before the newer click arms, because `abort()`
            // fires `loadend` synchronously — inside the abort at the top of this
            // function, which runs before this line. Guarding here would strand the
            // trigger it was meant to protect.
            //
            // Residual: a request that never terminates never fires `loadend`, so an
            // indefinite hang still strands the trigger. That is #B283 (no `xhr.timeout`
            // is set, which is also why the `ontimeout` handleXhr installs is dead code)
            // — a separate, consumer-visible behaviour change, NOT covered here.
            if ( typeof(xhr.addEventListener) == 'function' ) {
                loadingState.arm($el);
                xhr.addEventListener('loadend', function onLinkSettled() {
                    loadingState.disarm($el);
                });
            }

            // sending
            try {
                xhr.send();
            } catch (sendErr) {
                // A synchronous throw out of `send()` (a cross-origin synchronous
                // request, a transport already in an invalid state) means no request ran,
                // so no `loadend` is ever coming. Release, then let the error out
                // unchanged — the caller's contract is untouched.
                if ( loadingState.isArmed($el) ) {
                    loadingState.disarm($el);
                }
                throw sendErr;
            }
        }

        function registerLink($link, options) {

            if ( typeof(options) != 'object' ) {
                throw new Error('`options` must be an object')
            }

            $link.options = merge(options, self.options);

            // link element
            var id  = $link.id;
            var $el = document.getElementById(id) || null;

            if ( typeof(instance.$links[$link.id]) == 'undefined' ) {



                if ( registeredLinks.indexOf($link.id) > -1 ) {
                    throw new Error('`link '+$link.id+'` already exists !')
                }


                if (!gina.events[evt]) {



                    // attach click events
                    addListener(gina, $el, evt, function(e) {
                        cancelEvent(e);

                        var $localLink = getLinkById(e.target.id)
                        // loading & binding link
                        var localUrl = $localLink.url;

                        // Non-Preflighted requests
                        if ( typeof($localLink.options.isSynchrone) == 'undefined' ) {
                            $localLink.options.isSynchrone = false;
                        }
                        if ( typeof($localLink.options.withCredentials) == 'undefined' ) {
                            $localLink.options.withCredentials = false
                        }

                        _operatedLink = $localLink; // #B287 — hand the operated registration to linkRequest
                        linkRequest(localUrl, $localLink.options);

                        //delete gina.events[ $localLink.id ];
                        //removeListener(gina, event.target, event.type)
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




                $link.request       = linkRequest;
                $link.getLinkById   = getLinkById;
                $link.getLinkByUrl  = getLinkByUrl;

                instance.$links[$link.id] = $link;



            }
        }

        /**
         * bindLinks
         *
         * Binds every `<a data-gina-link>` under `$target` so its clicks issue an XHR
         * instead of navigating. An anchor spelling `data-gina-link="false"` opts out.
         *
         * Three shapes are skipped at bind time (#B288) because they ask the BROWSER for
         * something an XHR cannot deliver — a `download` save, a `target` window, or a
         * pure `#` in-page fragment move. A skipped anchor is left completely untouched
         * (no generated id, no click listeners) and therefore behaves exactly like
         * un-marked markup. The test is made against the RESOLVED url, so the documented
         * `<a href="#" data-gina-link-url="/real/target">` placeholder idiom still binds.
         *
         * Cross-origin anchors are deliberately NOT skipped — `linkRequest` supports them
         * (it drops credentials and relies on the target's CORS headers). Non-left-button
         * clicks need no guard: a middle click fires `auxclick`, not `click`.
         *
         * @param {object} $target - DOM element
         * @param {object} [options]
         *
         * @example
         * // bound — same-origin GET over XHR
         * // <a href="/reports/42" data-gina-link>Open</a>
         *
         * // bound — placeholder href, real target in the data attribute
         * // <a href="#" data-gina-link data-gina-link-url="/reports/42">Open</a>
         *
         * // NOT bound — the browser saves, moves in-page, or opens a window itself
         * // <a href="/report.pdf" data-gina-link download>Save</a>
         * // <a href="/reports/42" data-gina-link target="_blank">New tab</a>
         * // <a href="#section-3" data-gina-link>Jump</a>
         * */
        var bindLinks = function($target, options) {

            var id = null;
            if ( typeof($target) == 'undefined' ) {
                $target = instance.target;
                id = instance.id;
            }

            // binding form elements
            var found               = null
                , $el               = null
                , props             = null
                , $newLink          = null
                , url               = null
                , elId              = null
                , onEvent           = null
                // a
                , $a                = $target.getElementsByTagName('a')
                // buttons
                //, $button   = $target.getElementsByTagName('button')
            ;

            var i = 0, len = $a.length;
            for (; i < len; ++i) {
                found = $a[i].getAttribute('data-gina-link');

                if (!found && found != "" || /^false$/i.test(found) ) continue;

                $el     = $a[i];
                props   = {
                    type: 'a',
                    method: 'GET'
                };


                url = $el.getAttribute('data-gina-link-url');
                if ( typeof(url) != 'undefined' && url != null ) {
                    props.url = url
                } else {
                    props.url = $el.getAttribute('href')
                }

                // #B288 — leave the browser's own affordances alone. Three anchor shapes
                // ask the BROWSER to do something an XHR cannot do, and binding them
                // silently swallowed the user's intent (all three measured in a real
                // browser against the shipped bundle):
                //   `download` — the user asked for a saved file; the native save streams
                //                and names it, where the XHR path buffers the whole body
                //                in memory first.
                //   `target`   — asks for another window/tab; an XHR opens neither, so the
                //                click did nothing observable at all.
                //   a pure `#` — an in-page fragment move; there is no resource to request,
                //                and the plugin issued a GET for the literal "#name".
                // Skipped at BIND time, so a skipped anchor gets neither the id nor either
                // click listener and behaves exactly as un-marked markup — gating only the
                // request would leave the default still suppressed and produce a dead link
                // (the #B141 failure this plugin already shipped once).
                // Keyed on the RESOLVED url, never on `href`: `data-gina-link-url` wins
                // (see just above), so the documented placeholder idiom
                // `<a href="#" data-gina-link data-gina-link-url="/real/target">` still binds.
                // Deliberately NOT guarded here: cross-origin (a supported link feature —
                // see the CORS branch in `linkRequest`) and non-left-button clicks (a middle
                // click fires `auxclick`, not `click`, so it never reaches this plugin —
                // measured: the browser opens the tab and no request is made).
                if (
                       $el.getAttribute('download') != null
                    || $el.getAttribute('target') != null
                    || /^#/.test( props.url || '' )
                ) {
                    continue;
                }

                elId = $el.getAttribute('id');
                if ( typeof(elId) == 'undefined' || elId == null || elId == '' || /popin\.link/.test(elId) ) {

                    // unbind popin link
                    // if ( /popin\.link/.test(elId) ) {

                    // }

                    elId = 'link.click.'+ 'gina-link-' + instance.id +'-'+ uuid();
                }
                $el['id']   = elId;
                props.id    = elId;
                evt         = elId;
                $el.setAttribute('id', evt);

                // [CSP] Suppress the link's default action via a click listener instead of an
                // inline onclick="return false;" attribute — the inline handler tripped CSP
                // script-src-attr under nonce-based policies. preventDefault (NOT cancelEvent —
                // its stopPropagation would block the document-level delegation that fires the
                // AJAX request) covers direct AND child clicks while leaving the delegation intact.
                // The modifier bail runs FIRST: suppressing here would kill the browser's new
                // tab/window no matter what the document proxy later decides, because this
                // listener is reached before it.
                addListener(gina, $el, 'click', function(e) { if ( isModifiedClick(e) ) return; e.preventDefault(); });

                $newLink = null;

                if ( typeof(instance.$links[props.id]) == 'undefined' ) {
                    props.target = $el;
                    $newLink = merge(props, $link);
                    registerLink($newLink, options);
                }


            }

        }

        var init = function(options) {

            setupInstanceProto();
            instance.on('init', function(event) {

                // AJAX setup used to happen HERE, building one transport for the whole
                // page lifetime. It moved to `createXhr()`, called per request from
                // `linkRequest`, so two link clicks no longer share one object — see the
                // `_linkXhr` / `_linkSeq` comment at the top of this closure.

                // proxies
                // click on main document
                evt = 'click';// click proxy
                // for proxies, use linkInstance.id as target is always `document`
                addListener(gina, instance.target, evt, function(event) {

                    // A modified click — cmd/ctrl/shift/alt — belongs to the browser (#B288),
                    // so it bails first and nothing below can cancel the event or dispatch for
                    // it. This bail used to carry a second justification, "before the id
                    // backfill below, so deferring leaves no trace on the element either";
                    // that backfill was dead code and is gone (#B324), so only the primary
                    // reason remains.
                    if ( isModifiedClick(event) ) return;

                    // #B324: an id-backfill block used to sit here, gated on
                    // `typeof(event.target.id) == 'undefined'`. An element's `id` IDL attribute
                    // always exists (defaulting to ''), so the gate was never true and the block
                    // never ran — the popin plugin carried the identical dead pair, removed as
                    // #B300. Removed rather than "corrected": `instance.target` is `document`
                    // (see the note above) and `evt` is the literal 'click', so a live body
                    // would write `id="click.<uuid>"` onto EVERY id-less element clicked
                    // anywhere in the page; and since #B302 the dispatch below keys on
                    // `instance.$links[…]` — registration, not the id's SHAPE — so such an id is
                    // absent from `$links` and dispatches nothing. Pollution for zero gain.



                    // #B302 — dispatch on REGISTRATION, never on the id's SHAPE. `bindLinks`
                    // KEEPS an author-supplied `id` (only an empty/missing/`popin.link` id gets
                    // the generated `link.click.gina-link-<instance>-<uuid>` form), so gating
                    // here on that shape made `<a id="my-link" data-gina-link>text</a>` a DEAD
                    // link: it registered its `$links` entry and its custom-event listener
                    // normally, this proxy then refused to trigger it, and the per-anchor
                    // listener above had already suppressed the default — so the click did
                    // nothing at all. `instance.$links` is the very lookup `getLinkById` is,
                    // and it is PER-INSTANCE, so it answers "is this one of MY links?"
                    // directly — subsuming the old second, instance-scoping regex — and it
                    // holds for BOTH id shapes. Note the child proxy (`proxyClick`) has always
                    // been shape-agnostic (it takes the id as a parameter), which is why a
                    // nested-element click on such an anchor already worked; this makes the
                    // direct-click path agree with it rather than adding a new mechanism.
                    // A click on non-link markup yields an id absent from `$links` — no-op.
                    if ( typeof(instance.$links[event.target.id]) != 'undefined' ) {
                        cancelEvent(event);
                        // #B310 — the disabled gate, AFTER cancelEvent (same
                        // reasoning as proxyClick's): suppressed, not sent.
                        if ( isLinkDisabled(event.target) ) {
                            return;
                        }
                        triggerEvent(gina, event.target, event.target.id, event.detail);
                    }
                });

                if ( typeof(options) == 'undefined' ) {
                    options = {}
                }
                instance.options = options;

                bindLinks(instance.target, options);
                gina.linkIsBinded = true;

                instance.isReady = true;
                gina.hasLinkHandler = true;
                // #B326 — publish ONCE: `gina.link` IS the first activated
                // instance (a LIVE object); later constructions have nothing
                // to publish, and re-merging would freeze accessors/state (#B90).
                if ( typeof(gina.link) == 'undefined' || !gina.link ) {
                    gina.link = instance;
                }
                // trigger link ready event
                triggerEvent(gina, instance.target, 'ready.' + instance.id, instance);
            });




            instance.initialized = true;

            return instance
        }

        var setupInstanceProto = function() {

            instance.bindLinks      = bindLinks;
            instance.request        = linkRequest;
            instance.getLinkById    = getLinkById;
            instance.getLinkByUrl   = getLinkByUrl;
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

    return Link
});