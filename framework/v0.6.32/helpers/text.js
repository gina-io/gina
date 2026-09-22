/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * TextHelper
 *
 * Hosts the legacy `__()` translation function as a one-arg alias of the
 * runtime translation primitive `lib.i18n.t`. New code should call `t()`
 * (the global exposed by `gna.t`) directly with explicit culture; `__()`
 * is preserved for back-compat.
 *
 * @package     Gina.Lib.Helpers
 * @author      Rhinostone <contact@gina.io>
 * @api public
 * */

module.exports = function() {

    /**
     * Legacy one-arg translation alias. Forwards to `lib.i18n.t(str)` when
     * the lib registry is available, otherwise returns `str` verbatim
     * (matching the historical no-op stub behaviour).
     *
     * No culture argument is supported on this signature — without an
     * explicit culture, `lib.i18n.t` itself returns the key verbatim. To
     * actually translate, callers should use `gna.t(key, params, culture)`
     * directly, or the controller helper `self.t(key, params)`.
     *
     * @global
     * @param   {string} str - Source key (dotted-path into the bundle catalog).
     * @returns {string} Translated value, or `str` verbatim when nothing matches.
     */
    __ = function(str) {
        if ( typeof lib === 'undefined' || !lib || !lib.i18n || typeof lib.i18n.t !== 'function' ) {
            return str;
        }
        return lib.i18n.t(str);
    };

};//EO TextHelper.
