/**
 * @module gina/lib/cmd/bundle/inc/name
 *
 * The rule a NEW bundle name must pass (#B665): `gina bundle:add` and the destination of
 * `gina bundle:copy` and `gina bundle:rename` apply it before they write anything. A bundle
 * name becomes a key in the project's `manifest.json` and `env.json`, the source directory
 * `src/<name>`, part of every `<bundle>@<project>` string in `ports.json` and
 * `ports.reverse.json`, and part of its process title. The CLI used to check only a name's
 * first character, so it registered names holding shell and regular-expression syntax, and
 * names every object inherits (`constructor`), which the manifest's
 * `typeof(bundles[name]) != 'undefined'` tests take for an existing bundle.
 *
 * The rule is the scope-name rule (`lib/cmd/scope/inc/name.js`, #B626, #B639). A name
 * registered before it existed keeps working: the commands apply it to a name the manifest
 * does not hold yet.
 *
 * No `fs`, no framework globals — require-by-path unit-testable. It lives in `inc/` so the
 * command loader never takes it for a `bundle:<action>` handler.
 */
'use strict';

var scopeName = require('../../scope/inc/name');

/**
 * Whether `name` is a bundle name the CLI may register: letters, digits, `_`, `.` and `-`,
 * starting with a lowercase letter, a digit, `_` or `.`; neither `.` nor `..`; and not a
 * property every object inherits.
 *
 * @param {*} name - Candidate bundle name
 * @returns {boolean} True when the scope-name rule accepts it
 *
 * @example
 *  isValidBundleName('api');           // true
 *  isValidBundleName('design-system'); // true
 *  isValidBundleName('Admin');         // false — starts with an uppercase letter
 *  isValidBundleName('a$b');           // false — `$` is not allowed
 *  isValidBundleName('constructor');   // false — every object inherits it
 */
function isValidBundleName(name) {
    return scopeName.isValidScopeName(name);
}

/**
 * The refusal message for a name `isValidBundleName()` rejects. A reserved name is named as
 * such; any other name gets the character rule. The value is JSON-quoted, so whitespace and
 * control characters stay visible.
 *
 * @param {*} name - The rejected name
 * @returns {string} The message, naming the value
 *
 * @example
 *  describeInvalidBundleName('constructor');
 *  // '"constructor" is not a valid bundle name: it is a property every object inherits, ...'
 *  describeInvalidBundleName('a b');
 *  // '"a b" is not a valid bundle name: use letters, digits, ...'
 */
function describeInvalidBundleName(name) {
    var shown = JSON.stringify(String(name));
    if ( scopeName.isReservedName(name) ) {
        return shown + ' is not a valid bundle name: it is a property every object inherits, so it'
            + ' cannot be used as a key in the project manifest.';
    }
    return shown + ' is not a valid bundle name: use letters, digits, `_`, `.` and `-`, starting with a'
        + ' lowercase letter, a digit, `_` or `.` (`.` and `..` are refused).';
}

module.exports = {
    isValidBundleName         : isValidBundleName,
    describeInvalidBundleName : describeInvalidBundleName
};
