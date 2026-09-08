/**
 * @module gina/lib/cmd/controller/inc/namespace
 *
 * Pure, dependency-free helpers shared by `controller:add` / `controller:remove`
 * / `controller:rename`. A controller is referenced by its NAMESPACE string
 * (never by an imported identifier) — the namespace becomes a file-name segment
 * (`controllers/controller.<ns>.js`), a routing `namespace` value, a
 * `requireController('<ns>')` literal, a template-tree path segment, and the
 * PascalCase controller class name. These helpers validate the namespace/action
 * charset BEFORE any of those are built (the value is interpolated into file
 * paths, RegExps and JS identifiers, so a loose value is an injection vector),
 * and derive the canonical file name + class name.
 *
 * No `fs`, no framework globals — require-by-path unit-testable.
 */

// The default controller (`controllers/controller.js`, namespace = null) is the
// inheritance root for every namespace controller. It is NOT addressable as a
// namespace: `controller:add controller` would produce `controller.controller.js`
// and a routing namespace of `controller`, both of which collide conceptually
// with the default controller. Reserved, case-insensitively.
var RESERVED = ['controller'];

// Namespace + action charset. Deliberately conservative: a lowercase ASCII
// letter followed by letters / digits / underscores. No dots (path segment
// separator + template `file` collision), no slashes (path traversal), no
// hyphens (the namespace is capitalised into the `<Bundle><Namespace>Controller`
// class name and an action becomes a `this.<action>` method — both must be valid
// JS identifiers, and `-` is not). `_` is a valid identifier char, so it is kept.
var NAME_RE = /^[a-z][a-z0-9_]*$/i;

/**
 * Returns the string with its first character upper-cased (the `${Bundle}` /
 * `${Namespace}` convention the scaffolder uses for controller class names).
 *
 * @param {string} s
 * @returns {string}
 *
 * @example
 *  capitalize('checkout'); // 'Checkout'
 */
function capitalize(s) {
    s = String(s);
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Validates a controller namespace against the conservative charset and the
 * reserved list. The check runs BEFORE any path / RegExp / identifier is built
 * from the value.
 *
 * @param {string} name - Candidate namespace
 * @returns {boolean} True when the namespace is safe to use
 *
 * @example
 *  isValidNamespace('checkout');   // true
 *  isValidNamespace('controller'); // false (reserved)
 *  isValidNamespace('../etc');     // false (charset)
 */
function isValidNamespace(name) {
    if ( typeof(name) != 'string' || name === '' ) {
        return false;
    }
    if ( RESERVED.indexOf(name.toLowerCase()) > -1 ) {
        return false;
    }
    return NAME_RE.test(name);
}

/**
 * Validates a controller action name. Same charset as a namespace, but the
 * reserved list does NOT apply (an action named `controller` is harmless — it is
 * a method name, not a file segment). An action becomes a `this.<action>` method
 * and a routing `param.control` value.
 *
 * @param {string} name - Candidate action name
 * @returns {boolean} True when the action name is a safe JS identifier
 *
 * @example
 *  isValidAction('confirm'); // true
 *  isValidAction('1st');     // false (leading digit)
 */
function isValidAction(name) {
    if ( typeof(name) != 'string' || name === '' ) {
        return false;
    }
    return NAME_RE.test(name);
}

/**
 * Builds the canonical controller file name for a namespace.
 *
 * @param {string} namespace
 * @returns {string} `controller.<namespace>.js`
 *
 * @example
 *  controllerFileName('checkout'); // 'controller.checkout.js'
 */
function controllerFileName(namespace) {
    return 'controller.' + namespace + '.js';
}

/**
 * Derives the PascalCase controller class name from a bundle + namespace, the
 * `${Bundle}${Namespace}Controller` house convention (`view:add` builds the same
 * shape). Both parts are capitalised; the charset guard guarantees the result is
 * a valid JS identifier.
 *
 * @param {string} bundle
 * @param {string} namespace
 * @returns {string}
 *
 * @example
 *  className('demo', 'checkout'); // 'DemoCheckoutController'
 */
function className(bundle, namespace) {
    return capitalize(bundle) + capitalize(namespace) + 'Controller';
}

module.exports = {
    RESERVED           : RESERVED,
    capitalize         : capitalize,
    isValidNamespace   : isValidNamespace,
    isValidAction      : isValidAction,
    controllerFileName : controllerFileName,
    className          : className
};
