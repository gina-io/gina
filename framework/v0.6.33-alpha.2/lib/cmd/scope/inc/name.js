/**
 * @module gina/lib/cmd/scope/inc/name
 *
 * The scope-name rule `gina scope:add` enforces (#B626). A scope name becomes a
 * directory name (`releases/<bundle>/<scope>/<env>/<version>`), a `<scope>_scope`
 * key in `projects.json` and `main.json`, the value of `NODE_SCOPE`, and — through
 * the Couchbase connector — a quoted literal in N1QL statement text. `scope:add`
 * used to check only a name's first character, so it registered a name such as
 * `frontend/staging` (the retired `<bundle>/<scope>` form, which never limited a
 * scope to one bundle) verbatim, and dropped a name such as `Staging` without a
 * word. The per-bundle mechanism is the `bundles.<name>.scopes` allow-list in the
 * project's `manifest.json`.
 *
 * No `fs`, no framework globals — require-by-path unit-testable.
 */
'use strict';

/**
 * A scope name: a lowercase letter, a digit, `_` or `.` first (the rule
 * `scope:add` always applied), then letters, digits, `_`, `.` or `-`. Every name
 * it accepts also passes the Couchbase connector's `$scope` grammar
 * (`^[A-Za-z0-9_./-]+$`), which keeps `/` only so that a scope registered under
 * the retired form still boots.
 *
 * @constant
 * @type {RegExp}
 */
var NAME_RE = /^[a-z0-9_.][A-Za-z0-9_.-]*$/;

/**
 * Whether `name` is a scope name `scope:add` may register.
 *
 * @param {*} name - Candidate scope name
 * @returns {boolean} True when the whole name matches `NAME_RE` and is neither `.` nor `..`
 *
 * @example
 *  isValidScopeName('staging');          // true
 *  isValidScopeName('frontend/staging'); // false — the retired <bundle>/<scope> form
 *  isValidScopeName('..');               // false — it would be a parent-directory segment
 */
function isValidScopeName(name) {
    return typeof(name) == 'string'
        && name !== '.'
        && name !== '..'
        && NAME_RE.test(name);
}

/**
 * The refusal message for a name `isValidScopeName()` rejects. A name holding
 * `/` gets the pointer to the per-bundle mechanism, since that is what the
 * retired `<bundle>/<scope>` form was taken for; any other name gets the
 * character rule. The value is JSON-quoted, so whitespace and control characters
 * stay visible.
 *
 * @param {*} name - The rejected name
 * @returns {string} The message, naming the value
 *
 * @example
 *  describeInvalidScopeName('frontend/staging');
 *  // '"frontend/staging" is not a valid scope name: a scope applies to every bundle of the project, ...'
 *  describeInvalidScopeName('a b');
 *  // '"a b" is not a valid scope name: use letters, digits, ...'
 */
function describeInvalidScopeName(name) {
    var shown = JSON.stringify(String(name));
    if ( typeof(name) == 'string' && name.indexOf('/') > -1 ) {
        return shown + ' is not a valid scope name: a scope applies to every bundle of the project, and'
            + ' `scope:add` has no per-bundle form. To deploy a bundle in some scopes only, list them in'
            + ' manifest.json under bundles.<bundle>.scopes, for example "scopes": ["local"].';
    }
    return shown + ' is not a valid scope name: use letters, digits, `_`, `.` and `-`, starting with a'
        + ' lowercase letter, a digit, `_` or `.` (`.` and `..` are refused).';
}

module.exports = {
    NAME_RE                  : NAME_RE,
    isValidScopeName         : isValidScopeName,
    describeInvalidScopeName : describeInvalidScopeName
};
