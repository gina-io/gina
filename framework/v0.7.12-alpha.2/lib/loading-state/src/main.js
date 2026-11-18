'use strict';
/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/loading-state
 * @description Framework-owned loading state for submit-like triggers. Works in
 * Node.js (CommonJS) and browser (AMD / GFF) contexts.
 *
 * A submit-like trigger — `<button type="submit">`, `<input type="submit">` or an
 * `<a data-gina-form-submit>` — carries `data-gina-loading="true"` for exactly as
 * long as the action it started is running, and `"false"` once that action
 * completes OR is interrupted. Consumers style the running state with CSS.
 *
 * The module owns three things and no more: resolving the configured attribute
 * NAME, writing the two values, and walking a click target up to the trigger that
 * actually owns it. It holds NO state — the caller decides which element is armed
 * and where to remember it, so the validator, popin and link plugins can share one
 * implementation without sharing a registry.
 *
 * ## The `"false"` value is deliberate, and it constrains readers
 *
 * `disarm()` writes the STRING `"false"`; it does not remove the attribute. That
 * diverges on purpose from the form-scoped `data-gina-form-loading`, which #B175
 * changed from `setAttribute(..., false)` to `removeAttribute()` precisely because
 * `"false"` is attribute-PRESENT and therefore truthy for a presence check.
 *
 * The consequence is a hard rule for every reader, in the framework and in
 * consumer CSS alike: **match on the VALUE, never on presence**. Use
 * `[data-gina-loading="true"]`, never a bare `[data-gina-loading]`, and in JS use
 * {@link module:lib/loading-state~isArmed} rather than reading the attribute
 * directly. A bare presence selector matches a disarmed trigger and pins the
 * loading style on forever.
 *
 * ## Configuring the attribute name
 *
 * The name is read from `gina.config.loadingAttribute`, lazily, at every call —
 * `gina.config` is populated by the loader after the bundle loads, so a value
 * captured at module-definition time would be stale. A project already built on
 * `data-loading` opts in with:
 *
 * ```js
 * gina.setOptions({ loadingAttribute: 'data-loading' });
 * ```
 *
 * There is no
 * auto-detection: a DOM probe reads nothing at rest (the attribute only exists
 * while something is loading) and a stylesheet probe races late-loaded sheets and
 * throws on cross-origin ones. Configuration is explicit by design.
 *
 * @example
 * var loadingState = require('lib/loading-state');
 *
 * var $trigger = loadingState.resolveTrigger(event.target, $form);
 * loadingState.arm($trigger);      // data-gina-loading="true"
 * // ... the action runs, then settles, errors, times out or is rejected ...
 * loadingState.disarm($trigger);   // data-gina-loading="false"
 */

/**
 * Loading-state factory — returns the stateless API object.
 * Exported as the module itself via `module.exports = LoadingState()`.
 *
 * @function LoadingState
 * @returns {object} The `{ arm, disarm, isArmed, getAttributeName, resolveTrigger, DEFAULT_ATTRIBUTE }` API
 *
 * @memberof module:lib
 * @author  Rhinostone <contact@gina.io>
 * @api     Public
 */
function LoadingState() {

    /**
     * The attribute written when no `gina.config.loadingAttribute` override is set.
     *
     * @constant {string}
     * @inner
     */
    var DEFAULT_ATTRIBUTE = 'data-gina-loading';

    /**
     * The value written by `arm()`.
     *
     * @constant {string}
     * @inner
     */
    var ARMED = 'true';

    /**
     * The value written by `disarm()`. NOT `removeAttribute` — see the module
     * description for why, and for the presence-check rule it imposes on readers.
     *
     * @constant {string}
     * @inner
     */
    var DISARMED = 'false';

    /**
     * How many ancestors `resolveTrigger()` will climb before giving up. A submit
     * trigger is a direct child of its form in every realistic markup, so this is a
     * runaway guard rather than a real limit — a detached or cyclic node can not
     * spin the loop.
     *
     * @constant {number}
     * @inner
     */
    var MAX_DEPTH = 10;

    /**
     * isNode
     *
     * True when `$el` can carry attributes. Guards every public entry point so a
     * `null`, a text node, a `window` or a plain object is a silent no-op rather
     * than a thrown TypeError inside an event handler.
     *
     * @param {object} $el - candidate element
     *
     * @returns {boolean} true when `$el` exposes the attribute API
     *
     * @example
     * isNode(document.querySelector('button')); // true
     * isNode(null);                             // false
     *
     * @inner
     */
    var isNode = function($el) {
        return !!(
            $el
            && typeof($el.setAttribute) == 'function'
            && typeof($el.getAttribute) == 'function'
        );
    };

    /**
     * isSubmitTrigger
     *
     * True when `$el` is an element a user submits a form WITH. Mirrors the shapes
     * the validator's click proxy already recognises: a `button`/`input` whose type
     * is `submit`, or an anchor carrying `data-gina-form-submit`.
     *
     * @param {object} $el - candidate element
     *
     * @returns {boolean} true when `$el` is a submit-like trigger
     *
     * @example
     * isSubmitTrigger($button); // true for <button type="submit">
     * isSubmitTrigger($span);   // false
     *
     * @inner
     */
    var isSubmitTrigger = function($el) {
        if ( !isNode($el) || !$el.tagName ) {
            return false;
        }
        if ( /^(button|input)$/i.test($el.tagName) && /^submit$/i.test($el.type || '') ) {
            return true;
        }
        if ( /^a$/i.test($el.tagName) && $el.getAttribute('data-gina-form-submit') != null ) {
            return true;
        }
        return false;
    };

    /**
     * getAttributeName
     *
     * Resolves the attribute name to write. Reads `gina.config.loadingAttribute`
     * LAZILY on every call: `gina.config` is populated after the bundle loads, so a
     * value captured once at definition time would always be the default. Falls
     * back to `data-gina-loading` when unset, empty or not a string.
     *
     * @returns {string} the configured attribute name, or `data-gina-loading`
     *
     * @example
     * getAttributeName();                                  // 'data-gina-loading'
     * gina.setOptions({ loadingAttribute: 'data-loading' });
     * getAttributeName();                                  // 'data-loading'
     *
     * @api Public
     */
    var getAttributeName = function() {
        if (
            typeof(gina) != 'undefined' && gina && gina.config
            && typeof(gina.config.loadingAttribute) == 'string'
            && gina.config.loadingAttribute !== ''
        ) {
            return gina.config.loadingAttribute;
        }
        return DEFAULT_ATTRIBUTE;
    };

    /**
     * arm
     *
     * Marks `$el` as running by writing `<attribute>="true"`. Idempotent — arming an
     * already-armed trigger rewrites the same value. A non-element is a no-op.
     *
     * @param {object} $el - the trigger to mark (see `resolveTrigger`)
     *
     * @returns {boolean} true when the attribute was written
     *
     * @example
     * arm($button); // $button now carries data-gina-loading="true"
     *
     * @api Public
     */
    var arm = function($el) {
        if ( !isNode($el) ) {
            return false;
        }
        $el.setAttribute(getAttributeName(), ARMED);
        return true;
    };

    /**
     * disarm
     *
     * Releases `$el` by writing `<attribute>="false"`. Called on EVERY terminal
     * outcome — settled, errored, timed out, aborted, rate-limited and
     * validation-rejected — so a trigger can not stay visually loading after its
     * action stopped. Idempotent; a non-element is a no-op.
     *
     * Writes `"false"` rather than removing the attribute; see the module
     * description for the reasoning and the presence-check rule it imposes.
     *
     * @param {object} $el - the trigger to release
     *
     * @returns {boolean} true when the attribute was written
     *
     * @example
     * disarm($button); // $button now carries data-gina-loading="false"
     *
     * @api Public
     */
    var disarm = function($el) {
        if ( !isNode($el) ) {
            return false;
        }
        $el.setAttribute(getAttributeName(), DISARMED);
        return true;
    };

    /**
     * isArmed
     *
     * True only when `$el` is currently marked as running. Compares the VALUE
     * against `"true"` — never tests presence, because a disarmed trigger still
     * carries the attribute with `"false"`. Use this instead of reading the
     * attribute directly.
     *
     * @param {object} $el - the trigger to inspect
     *
     * @returns {boolean} true when `$el` carries `<attribute>="true"`
     *
     * @example
     * arm($button);    isArmed($button); // true
     * disarm($button); isArmed($button); // false — attribute present, value "false"
     *
     * @api Public
     */
    var isArmed = function($el) {
        if ( !isNode($el) ) {
            return false;
        }
        return $el.getAttribute(getAttributeName()) === ARMED;
    };

    /**
     * resolveTrigger
     *
     * Walks `$el` up to the submit trigger that owns it, so the state lands on the
     * control the user perceives as the button rather than on whatever inner node
     * happened to receive the click. `<button type="submit"><span>Save</span></button>`
     * clicked on the label yields the `button`, not the `span`.
     *
     * Returns `$el` itself when no submit-like ancestor is found, so a caller that
     * already knows it is handling a submit still gets a usable element. Stops at
     * the boundary element (typically the form), at `form`/`body`/`html`, or after
     * `MAX_DEPTH` hops.
     *
     * ## Recognising a non-submit trigger (`isTrigger`)
     *
     * The default predicate recognises submit-like controls only — a `button` or
     * `input` of type `submit`, or an `a[data-gina-form-submit]`. That is what the
     * validator needs and nothing else. Other plugins arm elements this module has
     * no business knowing about: link arms `a[data-gina-link]`, popin arms
     * `a[data-gina-dialog]`. Pass `isTrigger` to say what counts as YOUR trigger.
     *
     * Without it the climb finds no match, breaks at `form`/`body`/`html`, and
     * returns the ORIGINAL `$el` — so a click on the `<span>` inside
     * `<a data-gina-link><span>Go</span></a>` would arm the span and leave the
     * anchor unstyled.
     *
     * The predicate lives with the caller deliberately rather than being folded
     * into the default: this module owns the WALK, each plugin owns its own notion
     * of a trigger. Folding plugin attribute names in here would also couple the
     * module to the popin deprecation/alias work, which changes which attributes
     * are honoured over time.
     *
     * @param {object} $el - the clicked element (`event.target`)
     * @param {object} [$boundary] - element to stop at, usually the `<form>`
     * @param {function} [isTrigger] - `($node) => boolean`; defaults to the
     *   submit-like predicate. Ignored when not a function. A predicate that
     *   THROWS is deliberately not caught: every caller is framework code, so
     *   swallowing would hide a framework bug behind a silently unarmed trigger.
     *
     * @returns {object} the owning trigger, or `$el`, or `null` when `$el` is not an element
     *
     * @example
     * // <button type="submit"><span>Save</span></button>
     * resolveTrigger(event.target, $form); // the <button>, even when the <span> was clicked
     *
     * @example
     * // <a data-gina-link><span>Go</span></a> — the span was clicked
     * resolveTrigger(event.target, null, function($n) {
     *     return /^a$/i.test($n.tagName) && $n.getAttribute('data-gina-link') != null;
     * }); // the <a>, not the <span>
     *
     * @api Public
     */
    var resolveTrigger = function($el, $boundary, isTrigger) {
        if ( !isNode($el) ) {
            return null;
        }
        var matches = ( typeof(isTrigger) == 'function' ) ? isTrigger : isSubmitTrigger;
        var $node = $el;
        var depth = 0;
        while ( isNode($node) && depth < MAX_DEPTH ) {
            if ( matches($node) ) {
                return $node;
            }
            if ( $boundary && $node === $boundary ) {
                break;
            }
            if ( $node.tagName && /^(form|body|html)$/i.test($node.tagName) ) {
                break;
            }
            $node = $node.parentNode;
            ++depth;
        }
        return $el;
    };

    return {
        'DEFAULT_ATTRIBUTE' : DEFAULT_ATTRIBUTE,
        'getAttributeName'  : getAttributeName,
        'arm'               : arm,
        'disarm'            : disarm,
        'isArmed'           : isArmed,
        'resolveTrigger'    : resolveTrigger
    };
}

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = LoadingState()
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define('lib/loading-state', function() { return LoadingState() })
}
