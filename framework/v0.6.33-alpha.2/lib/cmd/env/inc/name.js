/**
 * @module gina/lib/cmd/env/inc/name
 *
 * The environment-name rule `gina env:add` enforces (#B639), and the one
 * `gina project:add --env=` checks before it registers anything. An environment
 * name becomes a directory name (`releases/<bundle>/<scope>/<env>/<version>`), part
 * of a configuration overlay file name (`<name>.<env>.json`, `routing.<env>.json`),
 * the audit log name (`audit-<bundle>-<env>.jsonl`), a key in `main.json`,
 * `projects.json`, `env.json` and `ports.reverse.json`, and the value of `NODE_ENV`.
 * `env:add` used to check only a name's first character, so it registered a name
 * such as `frontend/staging` (the `<bundle>/<env>` form its help documented, which
 * never limited an environment to one bundle) verbatim, and dropped a name such as
 * `Staging` without a word.
 *
 * The rule is the scope-name rule (`lib/cmd/scope/inc/name.js`, #B626), which
 * already refuses the names every object inherits, plus one name reserved for
 * environments: `global`, which names the overlay that applies to every
 * environment (`<name>.global.json`, `routing.global.json`).
 *
 * No `fs`, no framework globals — require-by-path unit-testable. It lives in
 * `inc/` so the command loader never takes it for an `env:<action>` handler.
 */
'use strict';

var scopeName = require('../../scope/inc/name');

/**
 * Names an environment may not take on top of the scope-name rule. `global` is
 * the configuration-overlay token applying to every environment: `core/config.js`
 * matches overlay files against `\.(<env>|global)\.json$`.
 *
 * @constant
 * @type {string[]}
 */
var RESERVED_ENV_NAMES = ['global'];

/**
 * Whether `name` is an environment name `env:add` may register.
 *
 * @param {*} name - Candidate environment name
 * @returns {boolean} True when the scope-name rule accepts it and it is not a name reserved for environments
 *
 * @example
 *  isValidEnvName('staging');          // true
 *  isValidEnvName('frontend/staging'); // false — the retired <bundle>/<env> form
 *  isValidEnvName('global');           // false — the overlay applying to every environment
 *  isValidEnvName('constructor');      // false — every object inherits it
 */
function isValidEnvName(name) {
    return scopeName.isValidScopeName(name)
        && RESERVED_ENV_NAMES.indexOf(name) < 0;
}

/**
 * The refusal message for a name `isValidEnvName()` rejects. A name holding `/`
 * is told there is no per-bundle form; `global` and the names every object
 * inherits are named as reserved; any other name gets the character rule. The
 * value is JSON-quoted, so whitespace and control characters stay visible.
 *
 * @param {*} name - The rejected name
 * @returns {string} The message, naming the value
 *
 * @example
 *  describeInvalidEnvName('frontend/staging');
 *  // '"frontend/staging" is not a valid environment name: an environment applies to every bundle of the project, ...'
 *  describeInvalidEnvName('global');
 *  // '"global" is not a valid environment name: `global` names the configuration overlay ...'
 *  describeInvalidEnvName('a b');
 *  // '"a b" is not a valid environment name: use letters, digits, ...'
 */
function describeInvalidEnvName(name) {
    var shown = JSON.stringify(String(name));
    if ( typeof(name) == 'string' && name.indexOf('/') > -1 ) {
        return shown + ' is not a valid environment name: an environment applies to every bundle of the'
            + ' project, and `env:add` has no per-bundle form.';
    }
    if ( typeof(name) == 'string' && RESERVED_ENV_NAMES.indexOf(name) > -1 ) {
        return shown + ' is not a valid environment name: `global` names the configuration overlay that'
            + ' applies to every environment (<name>.global.json).';
    }
    if ( scopeName.isReservedName(name) ) {
        return shown + ' is not a valid environment name: it is a property every object inherits, so it'
            + ' cannot be used as a key in the project files.';
    }
    return shown + ' is not a valid environment name: use letters, digits, `_`, `.` and `-`, starting with'
        + ' a lowercase letter, a digit, `_` or `.` (`.` and `..` are refused).';
}

module.exports = {
    RESERVED_ENV_NAMES     : RESERVED_ENV_NAMES,
    isValidEnvName         : isValidEnvName,
    describeInvalidEnvName : describeInvalidEnvName
};
