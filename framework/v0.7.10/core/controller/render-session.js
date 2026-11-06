/**
 * #B989 — the request's session block, `page.data.session`, for every HTML render delegate.
 *
 * ## Why this module exists
 *
 * A page rendered for a request that has a session gets the request's session block under
 * `page.data.session`: its `id`, `lastModified`, `createdAt`, `expiresAt` and `timeout`. A template
 * reads it there, and gina's client bootstrap (`gina.onload`, injected into the page) builds
 * `gina.session` from its `{{ page.data.session.id }}`, `.timeout`, `.createdAt` and
 * `.lastModified` placeholders. Up to 0.7.5 only the swig delegate and its legacy twin
 * (`controller.render-swig.js`, `controller.render-v1.js`) built the block: the async swig
 * delegate and both nunjucks delegates never did, so on those engines a template read no session
 * value and the bootstrap reached the browser with its placeholders as written
 * (`gina.session.id` was the string `{{ page.data.session.id }}`).
 *
 * ## What the delegates call
 *
 * - `addSessionBlock(data, req)`, right after `data = getData()` and before the combine, where
 *   the swig delegate always built the block: the block is then part of the render data
 *   `copyForRender()` aligns an action's object with, so an action's own `session` member is
 *   copied for the render, never written (#B988).
 * - The async swig delegate and both nunjucks delegates also merge the block back after their
 *   combine. Their combine puts an action's own `page.data` or `session` member in the place of
 *   gina's, where the swig delegate merges the two (the action's keys win, the block adds the keys
 *   the action's member lacks); merging the block back gives the same result.
 * - The same three delegates fill the bootstrap's `{{ page.data.session.<key> }}` placeholders in
 *   the bootstrap string itself, inside their `injectAssets()`, before it goes into the page: with
 *   the block's value, or with nothing as swig renders a missing value. Their `whisper()` pass
 *   after the render runs over the whole page, so given the session keys it would also put the
 *   session id into text the page renders from app data; that pass no longer flattens them. (The
 *   fill is inline there: test/lib/render-engine-dispatch.test.js compiles `injectAssets()` on its
 *   own, outside the module.)
 *
 * Server-side only: `core/controller` is not part of the browser bundle.
 *
 * @module core/controller/render-session
 */
'use strict';

/**
 * The session block of a request, or `null` when it has none to show: no `req.session`, a
 * session without a `cookie`, or a session cookie without an expiry. A browser-session cookie has
 * no expiry (`cookie._expires` is `null` after a store round-trip), and the block needs a real
 * `Date` to compute its `expiresAt` and `timeout`. (The swig delegate's inline block read
 * `req.session.cookie._expires` unguarded, so a `null` session or one without a `cookie` made it
 * throw; express-session always sets both.)
 *
 * `expiresAt` is the cookie's expiry formatted `isoDateTime` (gina's `Date.prototype.format`);
 * `timeout` is the time in milliseconds from the session's `lastModified`, or from now when the
 * session has none, to that expiry. `lastModified` and `createdAt` are the session's own values,
 * `undefined` when its store sets none.
 *
 * @memberof module:core/controller/render-session
 * @param {object} req - the request
 * @returns {?{id: string, lastModified: *, createdAt: *, expiresAt: string, timeout: number}} the
 *   block, or `null`
 *
 * @example
 * var renderSession = require('./render-session');
 * var block = renderSession.sessionBlock(req);
 * // { id: 'X2TE…', lastModified: undefined, createdAt: undefined, expiresAt: '2026-10-27T01:37:22', timeout: 599904 }
 */
function sessionBlock(req) {
    if ( !req || typeof(req.session) == 'undefined' || req.session === null ) {
        return null;
    }
    // A browser-session cookie has no expiry: _expires is null after a store round-trip, and
    // `typeof null === 'object'`; date subtraction and .format() need a real Date.
    if ( !req.session.cookie || !(req.session.cookie._expires instanceof Date) ) {
        return null;
    }
    var dateEnd   = req.session.cookie._expires;
    var dateStart = ( typeof(req.session.lastModified) != 'undefined' )
                    ? new Date(req.session.lastModified)
                    : new Date();
    return {
        id          : req.session.id,
        lastModified: req.session.lastModified,
        createdAt   : req.session.createdAt,
        expiresAt   : dateEnd.format('isoDateTime'),
        // In milliseconds
        timeout     : dateEnd - dateStart
    };
}

/**
 * Puts the request's session block on `data.page.data.session`, as the swig delegate has always
 * done. Call it right after `data = getData()`, before the combine.
 *
 * When the request has a `session`, `data.page.data` is created if missing. When it has a block,
 * `data.page.data.session` gets one unless `getData()` already holds one (then that object keeps
 * its `id` and `lastModified`), and `createdAt`, `expiresAt` and `timeout` are set on it.
 *
 * @memberof module:core/controller/render-session
 * @param {object} data - the delegate's render data, as `getData()` returned it
 * @param {object} req - the request
 * @returns {?object} the block (see `sessionBlock()`), or `null` when the request has none
 *
 * @example
 * data = getData();
 * var sessionBlock = renderSession.addSessionBlock(data, req);
 * data.page.data.session.id === req.session.id; // true when the session cookie has an expiry
 */
function addSessionBlock(data, req) {
    if ( !req || typeof(req.session) == 'undefined' ) {
        return null;
    }
    if ( typeof(data.page.data) == 'undefined' ) {
        data.page.data = {};
    }
    var block = sessionBlock(req);
    if ( !block ) {
        return null;
    }
    if ( typeof(data.page.data.session) == 'undefined' ) {
        data.page.data.session = {
            id          : block.id,
            lastModified: block.lastModified
        };
    }
    data.page.data.session.createdAt    = block.createdAt;
    data.page.data.session.expiresAt    = block.expiresAt;
    data.page.data.session.timeout      = block.timeout;
    return block;
}

module.exports = {
    sessionBlock    : sessionBlock,
    addSessionBlock : addSessionBlock
};
