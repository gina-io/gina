/**
 * #B665 S3 — new project and bundle names follow one rule, and the CLI's registry lookups match
 * names literally and exactly.
 *
 * S1 and S2 (cmd-argv-b665.test.js, cmd-argv-b665-s2.test.js) took every name and flag out of
 * the shell. S3 closes the two gaps they left:
 * - A name reached the registry after a first-character check only (`isValidName`,
 *   lib/cmd/helper.js), so `project:add` and `bundle:add` registered names holding shell and
 *   regular-expression syntax, `.` and `..`, and names every object inherits. A NEW name now
 *   passes the scope and environment rule: letters, digits, `_`, `.` and `-`, starting with a
 *   lowercase letter, a digit, `_` or `.`, and neither `.`, `..` nor an inherited property name
 *   (project/inc/name.js, bundle/inc/name.js). `project:add`, `bundle:add`, `project:rename`'s
 *   new name, the destination of `bundle:rename` / `bundle:copy` and `project:restore`'s name
 *   apply it before anything is written. A name already registered keeps working, and
 *   `project:import` is exempt.
 * - The registry lookups built regular expressions from names: a `.` matched any character, and
 *   `+` or `(` broke the expression or threw. Nine of them also matched a SIBLING with no special
 *   character at all: `api@shop/` in `myapi@shop/dev`, `@shop` in `@shopping/dev`, `/dev` in
 *   `/devel`. Every name is now escaped, and those nine are anchored on the registry's fixed
 *   shapes (`<bundle>@<project>/<env>` values, `<bundle>@<project>` keys, JSON strings). The
 *   install scripts escape the install prefix the same way.
 *
 * Sections:
 *   01 — the project-name and bundle-name rules, required by path (accept / refuse, messages)
 *   02 — comment-stripped source pins: each check sits before the first write it guards, the
 *        registered-name exemptions test own keys, and every handler requires `escapeRegex`
 *   03 — every regular-expression site, EVALUATED from its own source text (the Nth
 *        `new RegExp(` of the file's comment-stripped source) against sibling and
 *        metacharacter subjects, with an instrument control for the extraction and the bindings
 *   04 — driven: the CLI against an isolated home (refusals leave nothing written; CONTROLS keep
 *        a registered name, a `-` name and a dry run working; bundle:remove and project:remove
 *        leave a sibling's ports alone)
 *
 * Red-first: on the pre-change tree 01 fails (the rule modules do not exist), 02's pins fail,
 * every 03 site fails at least one case, and every 04 refusal or sibling arm fails; the 04
 * CONTROLs and the 03 instrument controls pass on both trees.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW     = require('../fw');
var CMD    = path.join(FW, 'lib/cmd');
var REPO   = path.resolve(FW, '..', '..');

var escapeRegex = require(path.join(CMD, 'bundle/inc/name-rewrite')).escapeRegex;

/**
 * A file's raw source.
 *
 * @inner
 * @param {string} rel - Path under the repository root
 * @returns {string}
 */
function raw(rel) {
    return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/**
 * Comment-stripped source (full-line `//` comments and JSDoc/block lines), so a pin never
 * matches a kept `was:` line.
 *
 * @inner
 * @param {string} src
 * @returns {string}
 */
function live(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

var FWREL = path.relative(REPO, FW);

/**
 * A handler's comment-stripped source.
 *
 * @inner
 * @param {string} rel - Path under lib/cmd
 * @returns {string}
 */
function handler(rel) {
    return live(raw(path.join(FWREL, 'lib/cmd', rel)));
}

// ---------------------------------------------------------------------------
// 01 — the two name rules
// ---------------------------------------------------------------------------

var ACCEPTED = ['my-app', 'api', 'my.app', 'my_app', '_x', '.hidden', 'a1', '0app', 'aB', 'x.y-z_w'];
var REFUSED  = [
    'Myproject', '-x', '.', '..', 'a$b', 'a b', 'a/b', 'a@b', 'a(b', 'a+b', 'a\nb', "a'b", 'a;b', '',
    'constructor', '__proto__', 'toString', 'hasOwnProperty', 'count'
];

[
    { kind: 'project', file: 'project/inc/name.js', isValid: 'isValidProjectName', describe: 'describeInvalidProjectName', registry: 'the project registry' },
    { kind: 'bundle',  file: 'bundle/inc/name.js',  isValid: 'isValidBundleName',  describe: 'describeInvalidBundleName',  registry: 'the project manifest' }
].forEach(function (spec) {

    describe('01 - the ' + spec.kind + '-name rule (lib/cmd/' + spec.file + ')', function () {

        /**
         * The rule module, required by path (it throws on the pre-change tree, where the
         * module does not exist).
         *
         * @inner
         * @returns {object}
         */
        function rule() {
            return require(path.join(CMD, spec.file));
        }

        it('accepts letters, digits, `_`, `.` and `-` after a lowercase letter, a digit, `_` or `.`', function () {
            ACCEPTED.forEach(function (name) {
                assert.equal(rule()[spec.isValid](name), true, JSON.stringify(name) + ' should be accepted');
            });
        });

        it('refuses every other name, `.`, `..` and the names every object inherits', function () {
            REFUSED.forEach(function (name) {
                assert.equal(rule()[spec.isValid](name), false, JSON.stringify(name) + ' should be refused');
            });
        });

        it('refuses a value that is not a string', function () {
            [null, undefined, 1, {}, ['a']].forEach(function (value) {
                assert.equal(rule()[spec.isValid](value), false, String(value) + ' should be refused');
            });
        });

        it('names an inherited property as such, and ' + spec.registry + ' as what it would reach', function () {
            var msg = rule()[spec.describe]('constructor');
            assert.equal(msg.indexOf('"constructor" is not a valid ' + spec.kind + ' name: it is a property every object inherits'), 0, msg);
            assert.ok(msg.indexOf(spec.registry) > -1, msg);
        });

        it('states the character rule for any other name, the value JSON-quoted', function () {
            var msg = rule()[spec.describe]('a\nb');
            assert.equal(msg.indexOf('"a\\nb" is not a valid ' + spec.kind + ' name: use letters, digits,'), 0, msg);
            assert.ok(msg.indexOf('(`.` and `..` are refused)') > -1, msg);
        });
    });
});

// ---------------------------------------------------------------------------
// 02 — source pins
// ---------------------------------------------------------------------------

/**
 * The index of `needle` in `src`, asserting it is found.
 *
 * @inner
 * @param {string} src
 * @param {string} needle
 * @param {number} [from=0] - Where to start searching
 * @returns {number}
 */
function at(src, needle, from) {
    var i = src.indexOf(needle, from || 0);
    assert.ok(i > -1, 'expected `' + needle + '`');
    return i;
}

describe('02 - the name checks sit before the first write they guard', function () {

    it('project:add checks a new name before the CLI bootstrap, on add only, exempting a registered name', function () {
        var src   = handler('project/add.js');
        at(src, "var projectNameRule = require('./inc/name');");
        var gate  = at(src, 'if ( !/\\:import/i.test(process.argv[2]) ) {');
        var check = at(src, '!isRegisteredProject(candidate) && !projectNameRule.isValidProjectName(candidate)');
        var boot  = at(src, 'if ( !isCmdConfigured() ) return false;');
        assert.ok(gate < check && check < boot, 'the check lies inside the add-only block, before isCmdConfigured()');
        var def   = src.slice(at(src, 'var isRegisteredProject = function'));
        assert.ok(def.indexOf("GINA_HOMEDIR + '/projects.json'") > -1, 'the registry is read from GINA_HOMEDIR');
        assert.ok(def.indexOf('Object.prototype.hasOwnProperty.call(registry, name)') > -1, 'an own key only');
    });

    it('bundle:add checks every new name after the bootstrap and before the first bundle is added', function () {
        var src   = handler('bundle/add.js');
        at(src, "var bundleNameRule = require('./inc/name');");
        var boot  = at(src, 'if ( !isCmdConfigured() ) return false;');
        var check = at(src, 'bundleNameRule.isValidBundleName(candidate)');
        var first = at(src, 'addBundles(0);');
        assert.ok(boot < check && check < first, 'isCmdConfigured() < the check < addBundles(0)');
        assert.ok(src.indexOf('Object.prototype.hasOwnProperty.call(self.projectData.bundles, candidate)') > -1, 'a registered bundle is an own key of the manifest');
    });

    ['bundle/copy.js', 'bundle/rename.js'].forEach(function (rel) {
        it(rel + ' checks the whole destination name right after its first-character check', function () {
            var src   = handler(rel);
            at(src, "var bundleNameRule = require('./inc/name');");
            var first = at(src, 'if ( !isValidName(dest) ) {');
            var check = at(src, 'bundleNameRule.isValidBundleName(dest)');
            var next  = at(src, 'var srcEntry');
            assert.ok(first < check && check < next, 'isValidName(dest) < the check < the source lookup');
            assert.ok(src.indexOf('Object.prototype.hasOwnProperty.call(self.projectData.bundles, dest)') > -1, 'a registered destination is an own key of the manifest');
        });
    });

    it('project:rename checks the new name before it renames anything', function () {
        var src    = handler('project/rename.js');
        at(src, "var projectNameRule = require('./inc/name');");
        var target = at(src, 'local.target = self.projectArgvList[1];');
        var check  = at(src, 'projectNameRule.isValidProjectName(local.target)', target);
        var call   = at(src, 'rename()', target);
        assert.ok(target < check && check < call, 'the check precedes the rename() call');
    });

    it('project:restore checks a new name before it reads the archive argument, so before extracting', function () {
        var src     = handler('project/restore.js');
        at(src, "var projectNameRule = require('./inc/name');");
        var name    = at(src, 'local.project = self.projectName;');
        var check   = at(src, 'projectNameRule.isValidProjectName(local.project)', name);
        var archive = at(src, 'var archiveArg', name);
        assert.ok(name < check && check < archive, 'the check precedes the archive checks and run()');
        assert.ok(src.indexOf('Object.prototype.hasOwnProperty.call(self.projects || {}, local.project)') > -1, 'a registered name is an own key');
    });

    it('the single-bundle refusal names the rejected bundle', function () {
        var src = handler('helper.js');
        assert.ok(src.indexOf("console.error('[ ' + cmd.bundles[0] + ' ] is not a valid bundle name.');") > -1);
        assert.equal(src.indexOf("console.error('[ ' + cmd.name + ' ] is not a valid bundle name.');"), -1, 'no longer prints cmd.name, which is unset there');
    });

    it('project:import inserts the new paths verbatim (function replacers, so `$&` does not expand)', function () {
        var src = handler('helper.js');
        assert.ok(src.indexOf('.replace(reOldHomedir, function') > -1);
        assert.ok(src.indexOf('.replace(reOldProjectPath, function') > -1);
    });

    [
        ['bundle/remove.js',   './inc/name-rewrite'],
        ['bundle/start.js',    './inc/name-rewrite'],
        ['env/remove.js',      './../bundle/inc/name-rewrite'],
        ['helper.js',          './bundle/inc/name-rewrite'],
        ['port/list.js',       './../bundle/inc/name-rewrite'],
        ['port/reset.js',      './../bundle/inc/name-rewrite'],
        ['project/add.js',     './../bundle/inc/name-rewrite'],
        ['project/remove.js',  './../bundle/inc/name-rewrite'],
        ['protocol/set.js',    './../bundle/inc/name-rewrite']
    ].forEach(function (spec) {
        it(spec[0] + ' binds escapeRegex at module scope', function () {
            assert.ok(handler(spec[0]).indexOf("var escapeRegex = require('" + spec[1] + "').escapeRegex;") > -1);
            assert.ok(fs.existsSync(path.join(CMD, path.dirname(spec[0]), spec[1] + '.js')), 'the required path resolves');
        });
    });

    it('both install scripts define the same escaper as lib/cmd/bundle/inc/name-rewrite.js', function () {
        var body = "return String(s).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');";
        assert.ok(raw(path.join(FWREL, 'lib/cmd/bundle/inc/name-rewrite.js')).indexOf(body) > -1, 'CONTROL: the reference body is found');
        ['script/pre_install.js', 'script/post_install.js'].forEach(function (rel) {
            var src = live(raw(rel));
            var def = at(src, 'var escapeRegex = function(s) {');
            assert.ok(src.indexOf(body, def) > -1 && src.indexOf(body, def) - def < 120, rel + ' carries the escaper body');
        });
    });

    it('the help texts state the naming rule, and project:add no longer documents a form it refuses', function () {
        var project = raw(path.join(FWREL, 'lib/cmd/project/help.txt'));
        var bundle  = raw(path.join(FWREL, 'lib/cmd/bundle/help.txt'));
        assert.ok(project.indexOf('A project name is made of letters, digits') > -1);
        assert.ok(bundle.indexOf('A bundle name is made of letters, digits') > -1);
        assert.equal(project.indexOf('2nd method'), -1, 'the no-argument `gina project:add`, which the CLI refuses');
    });
});

// ---------------------------------------------------------------------------
// 03 — every regular-expression site, evaluated from its own source text
// ---------------------------------------------------------------------------

/**
 * The Nth `new RegExp(` expression of `src`, up to its matching parenthesis. String literals
 * are skipped, so a parenthesis inside a pattern string does not end the expression.
 *
 * @inner
 * @param {string} src - Comment-stripped source
 * @param {number} n - Zero-based occurrence
 * @returns {?string} The expression text, or null when there is no such occurrence
 */
function nthRegExp(src, n) {
    var from = -1;
    for (var k = 0; k <= n; k++) {
        from = src.indexOf('new RegExp(', from + 1);
        if (from < 0) return null;
    }
    var i = from + 'new RegExp('.length, depth = 1, quote = null;
    for (; i < src.length && depth > 0; i++) {
        var c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
    }
    return depth === 0 ? src.slice(from, i) : null;
}

/**
 * Every name the regular-expression sites read. Each is passed explicitly, so an expression
 * using any other free name throws a ReferenceError instead of passing silently.
 *
 * @constant
 * @type {string[]}
 */
var BINDINGS = [
    'escapeRegex', 'bundle', 'self', 'cmd', 'env', 'portValue', '_bundle', '_env',
    'projectName', 'project', 'oldHomedir', 'oldProjectPath', 'prefix', 'getUserHome'
];

/**
 * Evaluates a site's expression with the given bindings.
 *
 * @inner
 * @param {string} expr - A `new RegExp(...)` expression
 * @param {object} b - Values by binding name
 * @returns {RegExp}
 */
function build(expr, b) {
    var fn = Function.apply(null, BINDINGS.concat('return ' + expr + ';'));
    return fn.apply(null, BINDINGS.map(function (k) {
        return k === 'escapeRegex' ? escapeRegex : b[k];
    }));
}

/**
 * `ports.json` as JSON text, with one assignment.
 *
 * @inner
 * @param {string} port
 * @param {string} value - A `<bundle>@<project>/<env>` value
 * @returns {string}
 */
function portsText(port, value) {
    var scheme = {};
    scheme[port] = value;
    return JSON.stringify({ 'http/1.1': { http: scheme } });
}

/**
 * One scheme of `ports.json` as JSON text, as setPorts stringifies it.
 *
 * @inner
 * @param {object} entries - Values by port
 * @returns {string}
 */
function schemeText(entries) {
    return JSON.stringify(entries);
}

var C = 'lib/cmd/';

var PORT_VALUE_SITE = [
    { b: { portValue: 'api@shop/dev' },
      match: [portsText('3100', 'api@shop/dev')],
      reject: [portsText('3100', 'api@shop/devel'), portsText('3100', 'myapi@shop/dev')] },
    { b: { portValue: 'a(b@shop/dev' },
      match: [portsText('3100', 'a(b@shop/dev')], reject: [] }
];

var PREFIX_CASES = function (binding, suffix) {
    return [
        { b: binding('/opt/c++/.npm-global'),
          match: ['/opt/c++/.npm-global' + suffix + '/x'], reject: ['/opt/c++/Xnpm-global' + suffix + '/x'] },
        { b: binding('/Users/a.b/.npm-global'),
          match: ['/Users/a.b/.npm-global' + suffix + '/x'], reject: ['/Users/aXb/.npm-global' + suffix + '/x'] }
    ];
};

var SITES = [
    { file: C + 'bundle/remove.js', nth: 0, name: 'bundle:remove — the removed bundle\'s ports.json values', cases: [
        { b: { bundle: 'api', self: { projectName: 'shop' } }, match: ['api@shop/dev'], reject: ['myapi@shop/dev', 'api@shopping/dev'] },
        { b: { bundle: 'a(b', self: { projectName: 'my.app' } }, match: ['a(b@my.app/dev'], reject: ['a(b@my-app/dev'] }
    ] },
    { file: C + 'bundle/remove.js', nth: 1, name: 'bundle:remove — the removed bundle\'s ports.reverse.json key', cases: [
        { b: { bundle: 'api', self: { projectName: 'shop' } }, match: ['api@shop'], reject: ['myapi@shop', 'api@shopping'] },
        { b: { bundle: 'a(b', self: { projectName: 'my.app' } }, match: ['a(b@my.app'], reject: ['a(b@my-app'] }
    ] },
    { file: C + 'bundle/start.js', nth: 0, name: 'bundle:start — the bundle\'s own `mounted !` line', cases: [
        { b: { bundle: 'api', self: { projectName: 'shop' } }, match: ['api@shop mounted !', 'Bundle started !'], reject: [] },
        { b: { bundle: 'a+b', self: { projectName: 'my.app' } }, match: ['a+b@my.app mounted !'], reject: [] },
        { b: { bundle: 'a(b', self: { projectName: 'shop' } }, match: ['a(b@shop mounted !'], reject: [] }
    ] },
    { file: C + 'env/remove.js', nth: 0, name: 'env:remove — the ports.json values of one environment', cases: [
        { b: { self: { projectName: 'shop' }, env: 'dev' }, match: ['api@shop/dev'], reject: ['api@shop/devel', 'api@shopping/dev'] },
        { b: { self: { projectName: 'my.app' }, env: 'd(v' }, match: ['api@my.app/d(v'], reject: ['api@my-app/d(v'] }
    ] },
    { file: C + 'env/remove.js', nth: 1, name: 'env:remove — the project\'s ports.reverse.json keys', cases: [
        { b: { self: { projectName: 'shop' } }, match: ['api@shop'], reject: ['api@shopping'] },
        { b: { self: { projectName: 'my.app' } }, match: ['api@my.app'], reject: ['api@my-app'] }
    ] },
    { file: C + 'helper.js', nth: 0, name: 'project:import — the old home directory prefix', cases: [
        { b: { oldHomedir: '/home/u/.shop' }, match: ['/home/u/.shop/releases'], reject: ['/home/u/Xshop/releases'] },
        { b: { oldHomedir: '/home/a.b/.x(1)' }, match: ['/home/a.b/.x(1)/tmp'], reject: ['/home/aXb/.x(1)/tmp'] }
    ] },
    { file: C + 'helper.js', nth: 1, name: 'project:import — the old project path prefix', cases: [
        { b: { oldProjectPath: '/srv/c++/shop' }, match: ['/srv/c++/shop/src'], reject: [] },
        { b: { oldProjectPath: '/srv/a.b/shop' }, match: ['/srv/a.b/shop/src'], reject: ['/srv/aXb/shop/src'] }
    ] },
    { file: C + 'helper.js', nth: 2, name: 'loading a project\'s assets — its ports.json values', cases: [
        { b: { cmd: { projectName: 'shop' } }, match: ['api@shop/dev'], reject: ['api@shopping/dev'] },
        { b: { cmd: { projectName: 'my.app' } }, match: ['api@my.app/dev'], reject: ['api@my-app/dev'] }
    ] },
    { file: C + 'helper.js', nth: 3, name: 'the project\'s port list', cases: [
        { b: { cmd: { projectName: 'shop' } }, match: ['api@shop/dev'], reject: ['api@shopping/dev'] },
        { b: { cmd: { projectName: 'my.app' } }, match: ['api@my.app/dev'], reject: ['api@my-app/dev'] }
    ] },
    { file: C + 'helper.js', nth: 4, name: 'one bundle\'s port list', cases: [
        { b: { cmd: { name: 'api', projectName: 'shop' } }, match: ['api@shop/dev'], reject: ['myapi@shop/dev', 'api@shopping/dev'] },
        { b: { cmd: { name: 'a+b', projectName: 'shop' } }, match: ['a+b@shop/dev'], reject: [] }
    ] },
    { file: C + 'helper.js', nth: 5, name: 'setPorts — an existing assignment in one scheme\'s JSON text', cases: [
        { b: { bundle: 'api', cmd: { projectName: 'shop' }, env: 'dev' },
          match: [schemeText({ '3100': 'api@shop/dev' })],
          reject: [schemeText({ '3100': 'api@shop/devel' }), schemeText({ '3100': 'myapi@shop/dev' }), schemeText({ '3100': 'api@shopping/dev' })] },
        { b: { bundle: 'a"b', cmd: { projectName: 'shop' }, env: 'dev' },
          match: [schemeText({ '3100': 'a"b@shop/dev' })], reject: [] }
    ] },
    { file: C + 'helper.js', nth: 6, name: 'setPorts — the port an existing assignment holds', cases: [
        { b: { bundle: 'api', cmd: { projectName: 'shop' }, env: 'dev' }, captures: [
            [schemeText({ '3100': 'api@shop/devel', '3106': 'api@shop/dev' }), '3106'],
            [schemeText({ '3100': 'api@shop/devel' }), null],
            [schemeText({ '3100': 'myapi@shop/dev' }), null]
        ] },
        { b: { bundle: 'a(b', cmd: { projectName: 'shop' }, env: 'dev' }, captures: [
            [schemeText({ '3104': 'a(b@shop/dev' }), '3104']
        ] }
    ] },
    { file: C + 'port/list.js', nth: 0, name: 'port:list (every project) — a project\'s ports.json values', cases: [
        { b: { projectName: 'shop' }, match: ['api@shop/dev'], reject: ['api@shopping/dev'] },
        { b: { projectName: 'my.app' }, match: ['api@my.app/dev'], reject: ['api@my-app/dev'] }
    ] },
    { file: C + 'port/list.js', nth: 1, name: 'port:list (every project) — one assignment\'s own value', cases: [
        { b: { _bundle: 'api', projectName: 'shop', _env: 'dev' }, match: ['api@shop/dev'], reject: [] },
        { b: { _bundle: 'a+b', projectName: 'shop', _env: 'dev' }, match: ['a+b@shop/dev'], reject: [] },
        { b: { _bundle: 'a(b', projectName: 'my.app', _env: 'dev' }, match: ['a(b@my.app/dev'], reject: ['a(b@my-app/dev'] }
    ] },
    { file: C + 'port/list.js', nth: 2, name: 'port:list @<project> — the project\'s ports.json values', cases: [
        { b: { self: { projectName: 'shop' } }, match: ['api@shop/dev'], reject: ['api@shopping/dev'] },
        { b: { self: { projectName: 'my.app' } }, match: ['api@my.app/dev'], reject: ['api@my-app/dev'] }
    ] },
    { file: C + 'port/list.js', nth: 3, name: 'port:list @<project> — one assignment\'s own value', cases: [
        { b: { _bundle: 'a+b', self: { projectName: 'shop' }, _env: 'dev' }, match: ['a+b@shop/dev'], reject: [] },
        { b: { _bundle: 'a(b', self: { projectName: 'my.app' }, _env: 'dev' }, match: ['a(b@my.app/dev'], reject: ['a(b@my-app/dev'] }
    ] },
    { file: C + 'port/list.js', nth: 4, name: 'port:list <bundle> @<project> — the bundle\'s ports.json values', cases: [
        { b: { bundle: 'api', self: { projectName: 'shop' } }, match: ['api@shop/dev'], reject: ['myapi@shop/dev', 'api@shopping/dev'] },
        { b: { bundle: 'api', self: { projectName: 'my.app' } }, match: ['api@my.app/dev'], reject: ['api@my-app/dev'] }
    ] },
    { file: C + 'port/list.js', nth: 5, name: 'port:list <bundle> @<project> — one assignment\'s own value', cases: [
        { b: { _bundle: 'a+b', self: { projectName: 'shop' }, _env: 'dev' }, match: ['a+b@shop/dev'], reject: [] },
        { b: { _bundle: 'a(b', self: { projectName: 'my.app' }, _env: 'dev' }, match: ['a(b@my.app/dev'], reject: ['a(b@my-app/dev'] }
    ] },
    { file: C + 'port/reset.js', nth: 0, name: 'port:reset — a reset bundle\'s ports.json values', cases: [
        { b: { bundle: 'api', project: 'shop' }, match: ['api@shop/dev'], reject: ['api@shopping/dev', 'myapi@shop/dev'] },
        { b: { bundle: 'api', project: 'my.app' }, match: ['api@my.app/dev'], reject: ['api@my-app/dev'] }
    ] },
    { file: C + 'port/reset.js', nth: 1, name: 'port:reset — an assignment already in ports.json (JSON text)', cases: PORT_VALUE_SITE },
    { file: C + 'project/add.js', nth: 0, name: 'project:add — an assignment already in ports.json (JSON text)', cases: PORT_VALUE_SITE },
    { file: C + 'project/remove.js', nth: 0, name: 'project:remove — the project\'s ports.json values', cases: [
        { b: { self: { projectName: 'shop' } }, match: ['api@shop/dev'], reject: ['api@shopping/dev'] },
        { b: { self: { projectName: 'my.app' } }, match: ['api@my.app/dev'], reject: ['api@my-app/dev'] }
    ] },
    { file: C + 'protocol/set.js', nth: 0, name: 'protocol:set @<project> — the project\'s ports.reverse.json keys', cases: [
        { b: { self: { projectName: 'shop' } }, match: ['api@shop'], reject: ['api@shopping'] },
        { b: { self: { projectName: 'my.app' } }, match: ['api@my.app'], reject: ['api@my-app'] }
    ] },
    { file: C + 'protocol/set.js', nth: 1, name: 'protocol:set <bundle> @<project> — the project\'s ports.reverse.json keys', cases: [
        { b: { self: { projectName: 'shop' } }, match: ['api@shop'], reject: ['api@shopping'] },
        { b: { self: { projectName: 'my.app' } }, match: ['api@my.app'], reject: ['api@my-app'] }
    ] },
    { file: 'script/pre_install.js', nth: 0, name: 'pre_install — an installed gina under the prefix',
      cases: PREFIX_CASES(function (p) { return { self: { prefix: p } }; }, '') },
    { file: 'script/pre_install.js', nth: 1, name: 'pre_install — the run directory under the prefix',
      cases: PREFIX_CASES(function (p) { return { prefix: p }; }, '') },
    { file: 'script/pre_install.js', nth: 2, name: 'pre_install — the tmp directory under the prefix',
      cases: PREFIX_CASES(function (p) { return { prefix: p }; }, '') },
    { file: 'script/pre_install.js', nth: 3, name: 'pre_install — the tmp directory under <prefix>/var',
      cases: PREFIX_CASES(function (p) { return { prefix: p }; }, '/var') },
    { file: 'script/pre_install.js', nth: 4, name: 'pre_install — the log directory under the prefix',
      cases: PREFIX_CASES(function (p) { return { prefix: p }; }, '') },
    { file: 'script/pre_install.js', nth: 5, name: 'pre_install — the log directory under <prefix>/var',
      cases: PREFIX_CASES(function (p) { return { prefix: p }; }, '/var') },
    { file: 'script/post_install.js', nth: 0, name: 'post_install — an installed gina under the prefix',
      cases: PREFIX_CASES(function (p) { return { self: { prefix: p } }; }, '') },
    { file: 'script/post_install.js', nth: 1, name: 'post_install — the home directory prefix of the install prefix',
      cases: PREFIX_CASES(function (p) { return { getUserHome: function () { return p; } }; }, '') }
];

/**
 * `new RegExp(` occurrences per file, in the comment-stripped source. The ordinals above point
 * at their sites only while these hold; S3 rewrites expressions in place and adds none.
 *
 * @constant
 * @type {Object<string, number>}
 */
var TOTALS = {};
TOTALS[C + 'bundle/remove.js']  = 2;
TOTALS[C + 'bundle/start.js']   = 5;
TOTALS[C + 'env/remove.js']     = 2;
TOTALS[C + 'helper.js']         = 7;
TOTALS[C + 'port/list.js']      = 6;
TOTALS[C + 'port/reset.js']     = 2;
TOTALS[C + 'project/add.js']    = 1;
TOTALS[C + 'project/remove.js'] = 1;
TOTALS[C + 'protocol/set.js']   = 2;
TOTALS['script/pre_install.js']  = 6;
TOTALS['script/post_install.js'] = 2;

/**
 * A site file's comment-stripped source.
 *
 * @inner
 * @param {string} rel - `lib/cmd/...` (under the framework dir) or `script/...`
 * @returns {string}
 */
function siteSource(rel) {
    return live(raw(/^lib\//.test(rel) ? path.join(FWREL, rel) : rel));
}

describe('03 - every regular-expression site, evaluated from its own source text', function () {

    it('INSTRUMENT: the extraction ends at the matching parenthesis, past parentheses inside strings', function () {
        var src = "var a = new RegExp('(' + x + ')', 'g'); var b = new RegExp(\"b)\");";
        assert.equal(nthRegExp(src, 0), "new RegExp('(' + x + ')', 'g')");
        assert.equal(nthRegExp(src, 1), 'new RegExp("b)")');
        assert.equal(nthRegExp(src, 2), null);
        assert.equal(nthRegExp(siteSource(C + 'bundle/start.js'), 1), "new RegExp('Listening on','gmi')", 'a real constant site');
    });

    it('INSTRUMENT: an expression reading a name outside the bindings throws instead of passing', function () {
        assert.throws(function () { build('new RegExp(unboundName)', {}); }, ReferenceError);
        assert.equal(build("new RegExp('^' + escapeRegex(bundle))", { bundle: 'a.b' }).test('aXb'), false, 'the real escaper is bound');
    });

    it('each site file still holds the same number of `new RegExp(`, so every ordinal points at its site', function () {
        Object.keys(TOTALS).forEach(function (rel) {
            assert.equal(siteSource(rel).split('new RegExp(').length - 1, TOTALS[rel], rel);
        });
    });

    SITES.forEach(function (site) {
        it(site.file.replace(/^lib\/cmd\//, '') + ' #' + site.nth + ' — ' + site.name, function () {
            var expr = nthRegExp(siteSource(site.file), site.nth);
            assert.ok(expr, 'the site was found');
            site.cases.forEach(function (c) {
                var label = expr + ' with ' + JSON.stringify(c.b);
                var re;
                try {
                    re = build(expr, c.b);
                } catch (err) {
                    assert.fail(label + ' threw ' + err.name + ': ' + err.message);
                }
                (c.match || []).forEach(function (s) {
                    assert.equal(build(expr, c.b).test(s), true, label + ' should match ' + JSON.stringify(s));
                });
                (c.reject || []).forEach(function (s) {
                    assert.equal(build(expr, c.b).test(s), false, label + ' should not match ' + JSON.stringify(s));
                });
                (c.captures || []).forEach(function (pair) {
                    var m = build(expr, c.b).exec(pair[0]);
                    assert.equal(m ? m[1] : null, pair[1], label + ' on ' + pair[0]);
                });
                assert.ok(re instanceof RegExp);
            });
        });
    });
});

// ---------------------------------------------------------------------------
// 04 — driven, against an isolated home (the project-add-children-b640.test.js shape: HOME
// overridden so the CLI bootstraps a throwaway `~/.gina`, GINA_HOMEDIR removed so it cannot
// inherit the developer's). Each arm asserts on-disk state, and each refusal its message.
// ---------------------------------------------------------------------------

var STAMP       = Date.now();
var FAKE_HOME   = path.join(os.tmpdir(), 'gina-b665s3-home-' + STAMP);
var GINA_HOME   = path.join(FAKE_HOME, '.gina');
var ARCHIVE_DIR = path.join(FAKE_HOME, 'backups');
var CLI         = path.join(REPO, 'bin', 'cli');
var CHILD_ENV   = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var P  = 'sh' + STAMP;      // holds the bundle `api`
var P2 = P + 'ping';        // a project whose name begins with P's (seeded ports only)
var Q  = 'q' + STAMP;       // re-keyed under QX, a name the rule refuses
var QX = 'q+x' + STAMP;
var R  = 'rn' + STAMP;      // the rename and backup arms
var M  = 'm.a' + STAMP;     // a name holding `.`
var M2 = 'm-a' + STAMP;     // differs from M at the `.` only (seeded ports only)

/**
 * Run an offline gina CLI command against the isolated home, from a working directory inside it.
 *
 * @inner
 * @param {string[]} args - CLI arguments, starting with the task
 * @returns {{ status: (number|null), out: string }} The exit status and both streams joined
 */
function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), {
        env: CHILD_ENV, cwd: FAKE_HOME, encoding: 'utf8', timeout: 90000
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * The text of a CLI run's output: the `message` of each JSON log record (GINA_LOG_STDOUT
 * writes one per line, so a quoted name arrives escaped), and any other line as it is.
 *
 * @inner
 * @param {string} out
 * @returns {string}
 */
function text(out) {
    return out.split('\n').map(function (line) {
        try {
            var rec = JSON.parse(line);
            if ( rec && typeof(rec.message) == 'string' ) return rec.message;
        } catch (err) { /* not a record */ }
        return line;
    }).join('\n');
}

/**
 * Read a JSON state file of the isolated home, or null when it is absent.
 *
 * @inner
 * @param {string} name - File name inside the isolated `.gina`
 * @returns {?object}
 */
function readState(name) {
    var p = path.join(GINA_HOME, name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/**
 * Write a JSON state file of the isolated home.
 *
 * @inner
 * @param {string} name - File name inside the isolated `.gina`
 * @param {object} data
 */
function writeState(name, data) {
    fs.writeFileSync(path.join(GINA_HOME, name), JSON.stringify(data, null, 4));
}

/**
 * Every `ports.json` value, as `{ port, value }` records.
 *
 * @inner
 * @param {object} ports
 * @returns {Array<{port: string, value: string}>}
 */
function portValues(ports) {
    var list = [];
    Object.keys(ports || {}).forEach(function (protocol) {
        Object.keys(ports[protocol] || {}).forEach(function (scheme) {
            Object.keys(ports[protocol][scheme] || {}).forEach(function (port) {
                list.push({ port: port, value: ports[protocol][scheme][port] });
            });
        });
    });
    return list;
}

/**
 * A project's manifest in the isolated home.
 *
 * @inner
 * @param {string} name - Project directory name
 * @returns {object}
 */
function manifest(name) {
    return JSON.parse(fs.readFileSync(path.join(FAKE_HOME, name, 'manifest.json'), 'utf8'));
}

describe('04 - driven: the CLI against an isolated home', function () {
    var setupError = null;
    var ARCHIVE    = null;

    before(function () {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        var steps = [
            [['project:add', '@' + P, '--path=' + path.join(FAKE_HOME, P)], function () { return (readState('projects.json') || {})[P]; }],
            [['bundle:add', 'api', '@' + P], function () { return manifest(P).bundles.api && (readState('ports.reverse.json') || {})['api@' + P]; }],
            [['project:add', '@' + Q, '--path=' + path.join(FAKE_HOME, Q)], function () { return (readState('projects.json') || {})[Q]; }],
            [['project:add', '@' + R, '--path=' + path.join(FAKE_HOME, R)], function () { return (readState('projects.json') || {})[R]; }],
            [['project:add', '@' + M, '--path=' + path.join(FAKE_HOME, M)], function () { return (readState('projects.json') || {})[M]; }],
            [['project:backup', '@' + R, '--out=' + ARCHIVE_DIR], function () {
                ARCHIVE = fs.readdirSync(ARCHIVE_DIR).filter(function (f) { return /\.zip$/.test(f); }).map(function (f) { return path.join(ARCHIVE_DIR, f); })[0] || null;
                return ARCHIVE;
            }]
        ];
        for (var s = 0; s < steps.length; s++) {
            var r = runCli(steps[s][0]);
            var ok = false;
            try { ok = !!steps[s][1](); } catch (err) { ok = false; }
            if ( !ok ) {
                setupError = 'setup step `' + steps[s][0].join(' ') + '` did not take:\n' + r.out;
                return;
            }
        }
        var projects = readState('projects.json');
        Object.keys(projects).forEach(function (name) {
            if ( String(projects[name].path).indexOf(FAKE_HOME) !== 0 ) {
                setupError = 'sandbox breach: ' + name + ' → ' + projects[name].path;
            }
        });
    });

    after(function () {
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    it('project:add refuses a new name holding a metacharacter, before anything is written', function () {
        assert.equal(setupError, null, setupError || '');
        var name = 'x$y' + STAMP, dir = path.join(FAKE_HOME, name);
        var r = runCli(['project:add', '@' + name, '--path=' + dir]);
        assert.ok(text(r.out).indexOf(JSON.stringify(name) + ' is not a valid project name: use letters') > -1, r.out);
        assert.notEqual(r.status, 0, 'exit status');
        assert.equal((readState('projects.json') || {})[name], undefined, 'not registered');
        assert.equal(fs.existsSync(dir), false, 'the --path directory was not created');
    });

    it('project:add refuses a new name every object inherits, before anything is written', function () {
        assert.equal(setupError, null, setupError || '');
        var dir = path.join(FAKE_HOME, 'ctor' + STAMP);
        var r = runCli(['project:add', '@constructor', '--path=' + dir]);
        assert.ok(text(r.out).indexOf('"constructor" is not a valid project name: it is a property every object inherits') > -1, r.out);
        assert.notEqual(r.status, 0, 'exit status');
        assert.equal(Object.prototype.hasOwnProperty.call(readState('projects.json') || {}, 'constructor'), false, 'not registered');
        assert.equal(fs.existsSync(dir), false, 'the --path directory was not created');
    });

    it('CONTROL: project:add registers a new name holding `-`', function () {
        assert.equal(setupError, null, setupError || '');
        var name = 'ds-' + STAMP;
        var r = runCli(['project:add', '@' + name, '--path=' + path.join(FAKE_HOME, name)]);
        assert.doesNotMatch(text(r.out), /is not a valid project name/, r.out);
        assert.ok((readState('projects.json') || {})[name], 'registered:\n' + r.out);
    });

    it('CONTROL: a name registered before the rule keeps working with project:add and project:import', function () {
        assert.equal(setupError, null, setupError || '');
        var projects = readState('projects.json');
        projects[QX] = projects[Q];
        delete projects[Q];
        writeState('projects.json', projects);
        var dir = path.join(FAKE_HOME, Q);
        var a = runCli(['project:add', '@' + QX, '--path=' + dir]);
        assert.doesNotMatch(text(a.out), /is not a valid project name/, 'project:add refused a registered name:\n' + a.out);
        assert.ok((readState('projects.json') || {})[QX], 'still registered after project:add:\n' + a.out);
        var i = runCli(['project:import', '@' + QX, '--path=' + dir]);
        assert.doesNotMatch(text(i.out), /is not a valid project name/, 'project:import refused a registered name:\n' + i.out);
        assert.ok((readState('projects.json') || {})[QX], 'still registered after project:import:\n' + i.out);
    });

    it('bundle:add checks every name of the list before it adds the first one', function () {
        assert.equal(setupError, null, setupError || '');
        var ok = 'ok' + STAMP;
        var r = runCli(['bundle:add', ok, 'bad$x', '@' + P]);
        assert.ok(text(r.out).indexOf('"bad$x" is not a valid bundle name: use letters') > -1, r.out);
        assert.notEqual(r.status, 0, 'exit status');
        assert.equal(manifest(P).bundles[ok], undefined, 'the valid name before it was not added');
        assert.equal(fs.existsSync(path.join(FAKE_HOME, P, 'src', ok)), false, 'no source tree for it');
        assert.equal((readState('ports.reverse.json') || {})[ok + '@' + P], undefined, 'no ports for it');
    });

    it('bundle:add names the rejected bundle in its first-character refusal', function () {
        assert.equal(setupError, null, setupError || '');
        var r = runCli(['bundle:add', 'Admin', '@' + P]);
        assert.ok(text(r.out).indexOf('[ Admin ] is not a valid bundle name.') > -1, r.out);
        assert.notEqual(r.status, 0, 'exit status');
    });

    it('bundle:add refuses a new bundle name every object inherits', function () {
        assert.equal(setupError, null, setupError || '');
        var r = runCli(['bundle:add', 'constructor', '@' + P]);
        assert.ok(text(r.out).indexOf('"constructor" is not a valid bundle name: it is a property every object inherits') > -1, r.out);
        assert.equal(Object.prototype.hasOwnProperty.call(manifest(P).bundles, 'constructor'), false, 'not added');
    });

    it('bundle:copy and bundle:rename refuse a new destination name, before their dry-run report', function () {
        assert.equal(setupError, null, setupError || '');
        var c = runCli(['bundle:copy', 'api', 'x$y', '@' + P, '--dry-run']);
        assert.ok(text(c.out).indexOf('"x$y" is not a valid bundle name') > -1, 'bundle:copy:\n' + c.out);
        assert.notEqual(c.status, 0, 'bundle:copy exit status');
        var n = runCli(['bundle:rename', 'api', 'z(z', '@' + P, '--dry-run']);
        assert.ok(text(n.out).indexOf('"z(z" is not a valid bundle name') > -1, 'bundle:rename:\n' + n.out);
        assert.notEqual(n.status, 0, 'bundle:rename exit status');
    });

    it('CONTROL: bundle:copy --dry-run still reports a valid new name', function () {
        assert.equal(setupError, null, setupError || '');
        var r = runCli(['bundle:copy', 'api', 'ok2' + STAMP, '@' + P, '--dry-run']);
        assert.doesNotMatch(text(r.out), /is not a valid bundle name/, r.out);
        assert.equal(r.status, 0, r.out);
    });

    it('project:rename refuses a new name holding a metacharacter, and nothing moves', function () {
        assert.equal(setupError, null, setupError || '');
        var target = 'x$r' + STAMP;
        var r = runCli(['project:rename', '@' + R, '@' + target]);
        assert.ok(text(r.out).indexOf(JSON.stringify(target) + ' is not a valid project name') > -1, r.out);
        assert.notEqual(r.status, 0, 'exit status');
        var projects = readState('projects.json') || {};
        assert.ok(projects[R], 'the project keeps its name');
        assert.equal(projects[target], undefined, 'no project under the new name');
        assert.ok(fs.existsSync(path.join(FAKE_HOME, R)), 'its directory did not move');
    });

    it('project:restore refuses a new name before extracting the archive', function () {
        assert.equal(setupError, null, setupError || '');
        var name = 'x$s' + STAMP, to = path.join(FAKE_HOME, 'restored-' + STAMP);
        var r = runCli(['project:restore', '@' + name, ARCHIVE, '--to=' + to]);
        assert.ok(text(r.out).indexOf(JSON.stringify(name) + ' is not a valid project name') > -1, r.out);
        assert.notEqual(r.status, 0, 'exit status');
        assert.equal(fs.existsSync(to), false, 'nothing was extracted');
        assert.equal((readState('projects.json') || {})[name], undefined, 'not registered');
    });

    it('bundle:remove removes only its own ports: a sibling bundle and a sibling project keep theirs', function () {
        assert.equal(setupError, null, setupError || '');
        var own      = 'api@' + P;
        var siblings = ['myapi@' + P, 'api@' + P2];
        var ports    = readState('ports.json');
        var reverse  = readState('ports.reverse.json');
        siblings.forEach(function (sib, s) {
            Object.keys(ports).forEach(function (protocol) {
                Object.keys(ports[protocol]).forEach(function (scheme) {
                    Object.keys(ports[protocol][scheme]).forEach(function (port) {
                        var value = ports[protocol][scheme][port];
                        if ( value.indexOf(own + '/') === 0 ) {
                            ports[protocol][scheme][String(~~port + 500 + 100 * s)] = sib + value.slice(own.length);
                        }
                    });
                });
            });
            reverse[sib] = JSON.parse(JSON.stringify(reverse[own]));
        });
        writeState('ports.json', ports);
        writeState('ports.reverse.json', reverse);
        var r = runCli(['bundle:remove', 'api', '@' + P, '--force']);
        var values  = portValues(readState('ports.json')).map(function (e) { return e.value; });
        var after   = readState('ports.reverse.json') || {};
        assert.equal(values.filter(function (v) { return v.indexOf(own + '/') === 0; }).length, 0, 'the removed bundle keeps no port:\n' + r.out);
        assert.equal(after[own], undefined, 'the removed bundle keeps no ports.reverse.json entry');
        siblings.forEach(function (sib) {
            assert.ok(values.some(function (v) { return v.indexOf(sib + '/') === 0; }), sib + ' kept its ports:\n' + r.out);
            assert.ok(after[sib], sib + ' kept its ports.reverse.json entry');
        });
    });

    it('project:remove removes only its own ports: a project differing at the `.` keeps its own', function () {
        assert.equal(setupError, null, setupError || '');
        var sib     = 'b@' + M2;
        var ports   = readState('ports.json');
        var reverse = readState('ports.reverse.json');
        ports['http/1.1'] = ports['http/1.1'] || {};
        ports['http/1.1'].http = ports['http/1.1'].http || {};
        ports['http/1.1'].http['3990'] = sib + '/dev';
        reverse[sib] = { dev: { 'http/1.1': { http: 3990 } } };
        writeState('ports.json', ports);
        writeState('ports.reverse.json', reverse);
        var r = runCli(['project:remove', '@' + M, '--force']);
        assert.equal((readState('projects.json') || {})[M], undefined, 'the project itself was removed:\n' + r.out);
        assert.equal(((readState('ports.json')['http/1.1'] || {}).http || {})['3990'], sib + '/dev', 'the sibling kept its port:\n' + r.out);
        assert.ok((readState('ports.reverse.json') || {})[sib], 'the sibling kept its ports.reverse.json entry');
    });
});
