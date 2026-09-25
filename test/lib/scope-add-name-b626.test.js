/**
 * #B626 — `gina scope:add` checks the whole scope name, and the retired
 * `<bundle>/<scope>` form is no longer documented.
 *
 * `scope:add` used to test only a name's first character. `frontend/staging` —
 * the form `help.txt` documented as "Adding/refreshing scope to a bundle" — was
 * registered verbatim as a PROJECT scope (no per-bundle semantics ever existed),
 * and `Staging` was dropped without a word. The per-bundle mechanism is the
 * `manifest.json` `bundles.<name>.scopes` allow-list (#B373).
 *
 * The rule lives in a dependency-free module (`lib/cmd/scope/inc/name.js`), driven
 * here by require-by-path; `add.js` runs inside the CLI daemon context, so its
 * wiring is covered by source pins, as for the other lib/cmd handlers.
 *
 * Sections:
 *   01 — help.txt: no longer documents the form and points at the manifest
 *        allow-list. CONTROL: still documents `scope:add <scope_name> @<project_name>`.
 *   02 — inc/name.js (behavioural): what is refused and accepted, both refusal
 *        messages, and that every accepted name also passes the Couchbase
 *        `$scope` grammar.
 *   03 — add.js (comment-stripped source pins): the argv loop refuses through
 *        isValidScopeName; the first-character-only acceptance is gone.
 *
 * Red-first: on the pre-change tree 01's form and pointer pins fail, every 02 arm
 * fails (the module does not exist), and 03 fails; 01's control passes.
 */
'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW       = require('../fw');
var HELP_TXT = fs.readFileSync(path.join(FW, 'lib/cmd/scope/help.txt'), 'utf8');
var ADD_SRC  = fs.readFileSync(path.join(FW, 'lib/cmd/scope/add.js'), 'utf8');

// comment-stripped handler source, so a pin never matches the fix's own comments
var ADD_ACTIVE = ADD_SRC.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

/**
 * Load the rule module per arm, so a missing module fails each 02 arm with its
 * own message instead of taking the whole file down at require time.
 *
 * @inner
 * @returns {{ NAME_RE: RegExp, isValidScopeName: function, describeInvalidScopeName: function }}
 */
function loadRule() {
    return require(path.join(FW, 'lib/cmd/scope/inc/name'));
}

describe('01 - help.txt', function () {

    it('CONTROL: still documents scope:add <scope_name> @<project_name>', function () {
        assert.ok(HELP_TXT.indexOf('$ gina scope:add <scope_name> @<project_name>') > -1);
    });

    it('no longer documents the <bundle_name>/<scope_name> form', function () {
        assert.equal(HELP_TXT.indexOf('<bundle_name>/<scope_name>'), -1);
        assert.equal(HELP_TXT.indexOf('Adding/refreshing scope to a bundle'), -1);
    });

    it('points at the per-bundle allow-list in manifest.json', function () {
        assert.match(HELP_TXT, /manifest\.json/);
        assert.match(HELP_TXT, /"scopes": \["local"\]/);
    });
});

describe('02 - inc/name.js', function () {

    it('refuses the retired form, whitespace, quotes, $, dot segments and other characters', function () {
        var rule = loadRule();
        ['frontend/staging', 'a b', 'x\'y', 'x"y', '$x', 'a$b', '.', '..', 'Staging',
            'a%b', 'a`b', 'a\\b', 'café', '', '-x', '@proj'].forEach(function (n) {
            assert.equal(rule.isValidScopeName(n), false, JSON.stringify(n));
        });
    });

    it('refuses non-strings', function () {
        var rule = loadRule();
        [undefined, null, 5, {}, []].forEach(function (n) {
            assert.equal(rule.isValidScopeName(n), false, String(n));
        });
    });

    it('accepts the scopes gina ships and ordinary custom names', function () {
        var rule = loadRule();
        ['local', 'beta', 'production', 'testing', 'staging', 'my_scope.v2',
            'pre-prod', 'myScope', '_x', '.hidden', '0'].forEach(function (n) {
            assert.equal(rule.isValidScopeName(n), true, n);
        });
    });

    it('every accepted name also passes the Couchbase $scope grammar', function () {
        var rule = loadRule();
        var COUCHBASE_SCOPE = /^[A-Za-z0-9_.\/-]+$/;
        ['local', 'staging', 'my_scope.v2', 'pre-prod', 'myScope', '_x', '.hidden', '0'].forEach(function (n) {
            assert.ok(rule.isValidScopeName(n), n + ' accepted');
            assert.ok(COUCHBASE_SCOPE.test(n), n + ' passes the Couchbase grammar');
        });
    });

    it('a name holding / is refused with the per-bundle pointer', function () {
        var msg = loadRule().describeInvalidScopeName('frontend/staging');
        assert.match(msg, /^"frontend\/staging" is not a valid scope name/);
        assert.match(msg, /bundles\.<bundle>\.scopes/);
    });

    it('any other refused name gets the character rule, and its value stays visible', function () {
        var rule = loadRule();
        var msg = rule.describeInvalidScopeName('a b');
        assert.match(msg, /^"a b" is not a valid scope name/);
        assert.match(msg, /letters, digits/);
        assert.doesNotMatch(msg, /bundles\./);
        assert.match(rule.describeInvalidScopeName('a\nb'), /^"a\\nb"/, 'a control character is shown escaped');
    });
});

describe('03 - add.js source pins', function () {

    it('the argv loop refuses through isValidScopeName', function () {
        assert.ok(ADD_ACTIVE.indexOf('require(\'./inc/name\')') > -1, 'add.js requires inc/name');
        assert.ok(ADD_ACTIVE.indexOf('scopeName.isValidScopeName(process.argv[i])') > -1);
        assert.ok(ADD_ACTIVE.indexOf('scopeName.describeInvalidScopeName(process.argv[i])') > -1);
    });

    it('the first-character-only acceptance is gone', function () {
        assert.equal(ADD_ACTIVE.indexOf('else if (/^[a-z0-9_.]/.test(process.argv[i]))'), -1);
        // anti-vacuity: the strip kept the code — the project-token test is still visible
        assert.ok(ADD_ACTIVE.indexOf('/^\\@[a-z0-9_.]/.test(process.argv[i])') > -1);
    });
});
