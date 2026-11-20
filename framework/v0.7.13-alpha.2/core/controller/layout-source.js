/**
 * #B1129 — the layout a swig render assembles, handed to swig from memory.
 *
 * ## Why this module exists
 *
 * A template that extends a layout is compiled by swig against a PARENT template. The swig
 * delegate (`controller.render-swig.js`) points the template's `{% extends %}` at the bundle's
 * processed layout under `<templates>/.gina-layout-cache/` and assembles that layout for each
 * render: the client loader, the scripts and the stylesheets go in, and the request's own values
 * are whispered into it (`{{ page.environment.hostname }}`, `.webroot`, `.culture` …). Up to
 * 0.7.10 the delegate wrote the assembled layout to that shared file and swig read it back, on
 * every render with the render cache off: concurrent renders of pages sharing a layout read one
 * another's file, so a page could carry another request's whispered values, or arrive without the
 * client loader, and on a bind-mounted templates directory a reader could find the file absent
 * (ENOENT) while another render renamed over it.
 *
 * swig resolves a parent only through its engine's loader (`resolve` + `load`; swig-core
 * `engine.js` `getParents` / `parseFile`), and a loader passed to one `compile()` call is not
 * honoured. So the delegate installs a thin hook on the loader of the engine it renders with:
 * `register()` binds an identifier to the layout this render assembled, the loader's `load()`
 * returns it from memory, and `release()` drops it once the compile returns. The compile is
 * synchronous, so a registration never outlives its render's compile. The identifier still carries
 * a per-render token (`token()`): a loader without the hook reads a path that exists nowhere and
 * the render fails, instead of reading a layout file another render left behind.
 *
 * Server-side only: `core/controller` is not part of the browser bundle.
 *
 * @module core/controller/layout-source
 */
'use strict';

/**
 * The loader property holding the registered sources: a non-enumerable, prototype-less map from
 * a resolved identifier to the source string served for it.
 *
 * @constant {string}
 */
var SOURCES_KEY = '_ginaLayoutSources';

/**
 * Per-process counter behind `token()`. The module is loaded once per process (the delegate is
 * re-required per render in development, this module is not), so tokens never repeat in a process.
 *
 * @type {number}
 */
var seq = 0;

/**
 * A per-render suffix for the extends target the delegate splices into a template. It names no
 * file, so only the hooked loader can serve the target it ends.
 *
 * @returns {string} `?gina-render=<pid>.<n>`, unique in the process
 *
 * @example
 * var target = '/app/templates/html/.gina-layout-cache/web/swig/layouts/main.html' + layoutSource.token();
 * // '/app/templates/html/.gina-layout-cache/web/swig/layouts/main.html?gina-render=4242.17'
 */
function token() {
    seq = ( seq >= Number.MAX_SAFE_INTEGER ) ? 1 : seq + 1;
    return '?gina-render=' + process.pid + '.' + seq;
}

/**
 * Installs the hook on a swig loader, once: its `load()` is wrapped so that a registered
 * identifier is served from memory and any other identifier reaches the original `load()`
 * unchanged. The wrapper keeps the original's arity, because swig's async path chooses the
 * callback form of `load()` by `load.length` (swig-core `engine.js`), and `resolve()` is not
 * touched. Idempotent: a loader already hooked is returned as it is.
 *
 * @param {object} loader - A swig loader (`{ resolve, load }`), such as `swig.loaders.fs(root)`
 * @returns {object|null} The same loader, hooked; `null` when it has no `load()` function or
 *   cannot take a new property (frozen or sealed)
 *
 * @example
 * var loader = layoutSource.install(engine.options.loader);
 * // loader === engine.options.loader, and loader.load now serves registered identifiers
 */
function install(loader) {
    if ( !loader || ( typeof(loader) !== 'object' && typeof(loader) !== 'function' ) || typeof(loader.load) !== 'function' ) {
        return null;
    }
    if ( Object.prototype.hasOwnProperty.call(loader, SOURCES_KEY) ) {
        return loader;
    }
    if ( !Object.isExtensible(loader) ) {
        return null;
    }
    var sources = Object.create(null);
    var load    = loader.load;
    var hooked  = ( load.length >= 2 )
        ? function (identifier, cb) {
            if ( typeof(identifier) === 'string' && Object.prototype.hasOwnProperty.call(sources, identifier) ) {
                if ( typeof(cb) === 'function' ) {
                    cb(null, sources[identifier]);
                    return;
                }
                return sources[identifier];
            }
            return load.apply(this, arguments);
        }
        : function (identifier) {
            if ( typeof(identifier) === 'string' && Object.prototype.hasOwnProperty.call(sources, identifier) ) {
                return sources[identifier];
            }
            return load.apply(this, arguments);
        };
    Object.defineProperty(loader, SOURCES_KEY, { value: sources, enumerable: false, configurable: false, writable: false });
    loader.load = hooked;
    return loader;
}

/**
 * Serves `source` for `id` through the loader until `release(loader, id)`. Installs the hook
 * first when the loader does not have it yet.
 *
 * @param {object} loader - A swig loader
 * @param {string} id     - The identifier swig will load: the loader's own
 *   `resolve(target)` of the extends target, so that it matches what swig passes to `load()`
 * @param {string} source - The template source to serve
 * @returns {boolean} `true` when registered; `false` when the loader cannot be hooked
 *
 * @example
 * var id = loader.resolve(target);
 * layoutSource.register(loader, id, assembledLayout);
 * try { compiled = engine.compile(childSource, { filename: childPath }); }
 * finally { layoutSource.release(loader, id); }
 */
function register(loader, id, source) {
    var hooked = install(loader);
    if ( !hooked || typeof(id) !== 'string' ) {
        return false;
    }
    hooked[SOURCES_KEY][id] = String(source);
    return true;
}

/**
 * Stops serving `id`: the next `load(id)` reaches the original loader again.
 *
 * @param {object} loader - The loader `register()` was given
 * @param {string} id     - The identifier it was registered under
 * @returns {void}
 *
 * @example
 * layoutSource.release(loader, id);
 */
function release(loader, id) {
    if ( loader && Object.prototype.hasOwnProperty.call(loader, SOURCES_KEY) && typeof(id) === 'string' ) {
        delete loader[SOURCES_KEY][id];
    }
}

module.exports = {
    token    : token,
    install  : install,
    register : register,
    release  : release
};
