/**
 * @module gina/lib/cmd/project/inc/name
 *
 * The rule a NEW project name must pass (#B665): `gina project:add`, the new name of
 * `gina project:rename` and the `@<name>` of `gina project:restore` apply it before they
 * write anything. A project name becomes a key in `projects.json`, the project home
 * directory `~/.<name>`, part of every `<bundle>@<project>` string in `ports.json` and
 * `ports.reverse.json`, and part of each bundle's process title. The CLI used to check
 * only a name's first character, so it registered names holding shell and
 * regular-expression syntax, `.` and `..` (whose home is `~/..`), and names every object
 * inherits (`constructor`), which the registry's `typeof(projects[name]) != 'undefined'`
 * tests take for an existing project.
 *
 * The rule is the scope-name rule (`lib/cmd/scope/inc/name.js`, #B626, #B639). A name
 * registered before it existed keeps working: the commands apply it to a name that is
 * not registered yet, and `project:import` does not apply it.
 *
 * No `fs`, no framework globals — require-by-path unit-testable. It lives in `inc/` so the
 * command loader never takes it for a `project:<action>` handler.
 */
'use strict';

var scopeName = require('../../scope/inc/name');

/**
 * Whether `name` is a project name the CLI may register: letters, digits, `_`, `.` and
 * `-`, starting with a lowercase letter, a digit, `_` or `.`; neither `.` nor `..`; and not
 * a property every object inherits.
 *
 * @param {*} name - Candidate project name, without its `@`
 * @returns {boolean} True when the scope-name rule accepts it
 *
 * @example
 *  isValidProjectName('myproject');     // true
 *  isValidProjectName('my-app');        // true
 *  isValidProjectName('Myproject');     // false — starts with an uppercase letter
 *  isValidProjectName('..');            // false — its home would be ~/..
 *  isValidProjectName('constructor');   // false — every object inherits it
 */
function isValidProjectName(name) {
    return scopeName.isValidScopeName(name);
}

/**
 * The refusal message for a name `isValidProjectName()` rejects. A reserved name is named
 * as such; any other name gets the character rule. The value is JSON-quoted, so
 * whitespace and control characters stay visible.
 *
 * @param {*} name - The rejected name, without its `@`
 * @returns {string} The message, naming the value
 *
 * @example
 *  describeInvalidProjectName('constructor');
 *  // '"constructor" is not a valid project name: it is a property every object inherits, ...'
 *  describeInvalidProjectName('a b');
 *  // '"a b" is not a valid project name: use letters, digits, ...'
 */
function describeInvalidProjectName(name) {
    var shown = JSON.stringify(String(name));
    if ( scopeName.isReservedName(name) ) {
        return shown + ' is not a valid project name: it is a property every object inherits, so it'
            + ' cannot be used as a key in the project registry.';
    }
    return shown + ' is not a valid project name: use letters, digits, `_`, `.` and `-`, starting with a'
        + ' lowercase letter, a digit, `_` or `.` (`.` and `..` are refused).';
}

module.exports = {
    isValidProjectName         : isValidProjectName,
    describeInvalidProjectName : describeInvalidProjectName
};
