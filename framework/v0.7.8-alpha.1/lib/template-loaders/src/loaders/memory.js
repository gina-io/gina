/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/template-loaders/memory
 * @description Built-in in-memory template loader for the async loader
 * extension point (`settings.template.<engine>.loader.type === "memory"`).
 * Templates are supplied inline as a flat `identifier -> source` map in the
 * loader config — no filesystem, no network. Useful for tests and small,
 * self-contained template sets.
 *
 * Implements the two-method swig/nunjucks loader contract (`resolve` + `load`)
 * plus the `async: true` dispatch flag. `load` is dual-mode (callback form and
 * synchronous return) with arity 2 so swig's async `getTemplate()` picks the
 * callback load path (it gates on `load.length >= 2`).
 *
 * @package gina.framework
 */

/**
 * Build an in-memory loader from a templates map.
 *
 * @param {object} cfg            - Loader config (`settings.template.<engine>.loader`)
 * @param {Object.<string,string>} cfg.templates - Flat map of identifier -> source string
 * @returns {{async: boolean, resolve: function, load: function}} Loader object
 * @throws {Error} When `cfg.templates` is not a plain object map
 *
 * @example
 * var memory = require('lib/template-loaders/memory');
 * var loader = memory({ templates: { 'index.html': '<h1>{{ title }}</h1>' } });
 * loader.load('index.html', function (err, source) { ... });
 */
module.exports = function memory(cfg) {
    if (
        !cfg
        || typeof cfg.templates !== 'object'
        || cfg.templates === null
        || Array.isArray(cfg.templates)
    ) {
        throw new Error('[template-loader:memory] "templates" must be an object map of identifier -> source string');
    }
    var map = cfg.templates;

    return {
        // Dispatch flag — read by swig's renderFile and by gina's delegate
        // selection (controller.js routes async-loader bundles to the async
        // delegate). Always true for this loader.
        async: true,

        // Identity resolve — the supplied identifier IS the map key. extends /
        // include targets pass through here too, so the gina CVE segment-guard
        // (applied by the wrapper in main.js) covers the whole transitive chain.
        resolve: function (to, from) {
            return to;
        },

        // Dual-mode load. Arity 2 (identifier, cb) so swig.getTemplate() uses
        // the callback path; the synchronous return keeps the loader usable by
        // any sync consumer.
        load: function (identifier, cb) {
            if (cb) {
                if (!Object.prototype.hasOwnProperty.call(map, identifier)) {
                    return void cb(new Error('[template-loader:memory] template not found: ' + identifier));
                }
                return void cb(null, map[identifier]);
            }
            return map[identifier];
        }
    };
};
