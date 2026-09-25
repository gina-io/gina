/**
 * #B639 — `gina env:add` checks the whole environment name, the retired
 * `<bundle>/<env>` form is no longer documented, and both the scope and the
 * environment rule refuse names that every object inherits.
 *
 * `env:add` used to test only a name's first character, as `scope:add` did
 * before #B626. `frontend/staging` — the form `help.txt` documented as
 * "Adding/refreshing environment to a bundle" — was registered verbatim as a
 * PROJECT environment (no per-bundle semantics ever existed), and `Staging` was
 * dropped without a word. An environment name becomes a directory name, part of a
 * configuration overlay file name (`<name>.<env>.json`), a key in the project
 * files and the value of `NODE_ENV`.
 *
 * The environment rule is the scope rule plus one reserved name, `global`, which
 * already names the overlay applying to every environment. Both rules also refuse
 * a name that is a property every object inherits (`__proto__`, `constructor`,
 * gina's own `count`, ...): several writers index the project files by the name
 * and would reach the shared prototype instead of an own key.
 *
 * Sections:
 *   01 — env/help.txt: no longer documents the form and states the naming rule.
 *        CONTROL: still documents `env:add <env_name> @<project_name>`.
 *   02 — env/inc/name.js (behavioural): what is refused and accepted, and each
 *        refusal message.
 *   03 — scope/inc/name.js (behavioural): the reserved-name refusal added to the
 *        scope rule; `global` stays a valid SCOPE name; #B626's accepted names
 *        are still accepted.
 *   04 — env/add.js (comment-stripped source pins): the argv loop refuses
 *        through isValidEnvName; the first-character-only acceptance is gone.
 *   05 — live: the real CLI against an isolated home — the refusal is REACHED
 *        (no earlier bootstrap stage pre-empts it) and nothing is registered;
 *        CONTROL: a valid name is registered.
 *
 * Red-first: on the pre-change tree 01's form and rule pins fail, every 02 arm
 * fails (the module does not exist), 03's reserved-name arms fail, 04 fails, and
 * 05's three refusal arms fail; the CONTROLs and 03's unchanged-acceptance arm
 * pass.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW       = require('../fw');
var HELP_TXT = fs.readFileSync(path.join(FW, 'lib/cmd/env/help.txt'), 'utf8');
var ADD_SRC  = fs.readFileSync(path.join(FW, 'lib/cmd/env/add.js'), 'utf8');

// comment-stripped handler source, so a pin never matches the fix's own comments
var ADD_ACTIVE = ADD_SRC.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

/**
 * Load the environment rule per arm, so a missing module fails each arm with
 * its own message instead of taking the whole file down at require time.
 *
 * @inner
 * @returns {{ isValidEnvName: function, describeInvalidEnvName: function, RESERVED_ENV_NAMES: string[] }}
 */
function loadEnvRule() {
    return require(path.join(FW, 'lib/cmd/env/inc/name'));
}

/**
 * Load the scope rule (#B626), which the environment rule builds on.
 *
 * @inner
 * @returns {{ isValidScopeName: function, describeInvalidScopeName: function, isReservedName: function }}
 */
function loadScopeRule() {
    return require(path.join(FW, 'lib/cmd/scope/inc/name'));
}

describe('01 - env/help.txt', function () {

    it('CONTROL: still documents env:add <env_name> @<project_name>', function () {
        assert.ok(HELP_TXT.indexOf('$ gina env:add <env_name> @<project_name>') > -1);
    });

    it('no longer documents the <bundle_name>/<env_name> form', function () {
        assert.equal(HELP_TXT.indexOf('<bundle_name>/<env_name>'), -1);
        assert.equal(HELP_TXT.indexOf('Adding/refreshing environment to a bundle'), -1);
    });

    it('states the naming rule, including the reserved `global`', function () {
        assert.match(HELP_TXT, /environment name is made of letters,\s+digits/);
        assert.match(HELP_TXT, /`global`/);
    });
});

describe('02 - env/inc/name.js', function () {

    it('refuses the retired form, whitespace, quotes, shell syntax, dot segments and other characters', function () {
        var rule = loadEnvRule();
        ['frontend/staging', 'a b', 'x\'y', 'x"y', '$x', 'a$b', 'a;b', 'a(b', 'x$(y)',
            '.', '..', 'Staging', 'a%b', 'a`b', 'a\\b', 'café', '', '-x', '@proj'].forEach(function (n) {
            assert.equal(rule.isValidEnvName(n), false, JSON.stringify(n));
        });
    });

    it('refuses `global` and names every object inherits', function () {
        var rule = loadEnvRule();
        ['global', '__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty',
            'count', 'functionCount'].forEach(function (n) {
            assert.equal(rule.isValidEnvName(n), false, n);
        });
    });

    it('refuses non-strings', function () {
        var rule = loadEnvRule();
        [undefined, null, 5, {}, []].forEach(function (n) {
            assert.equal(rule.isValidEnvName(n), false, String(n));
        });
    });

    it('accepts the environments gina ships and ordinary custom names', function () {
        var rule = loadEnvRule();
        ['dev', 'prod', 'staging', 'qa', 'my_env.v2', 'pre-prod', 'myEnv', '_x',
            '.hidden', '0', 'globalish', 'global2'].forEach(function (n) {
            assert.equal(rule.isValidEnvName(n), true, n);
        });
    });

    it('a name holding / is refused with the no-per-bundle-form wording', function () {
        var msg = loadEnvRule().describeInvalidEnvName('frontend/staging');
        assert.match(msg, /^"frontend\/staging" is not a valid environment name/);
        assert.match(msg, /every bundle of the project/);
    });

    it('`global` is refused as the overlay applying to every environment', function () {
        var msg = loadEnvRule().describeInvalidEnvName('global');
        assert.match(msg, /^"global" is not a valid environment name/);
        assert.match(msg, /\.global\.json/);
    });

    it('an inherited property name is refused as such', function () {
        var msg = loadEnvRule().describeInvalidEnvName('constructor');
        assert.match(msg, /^"constructor" is not a valid environment name/);
        assert.match(msg, /every object inherits/);
    });

    it('any other refused name gets the character rule, and its value stays visible', function () {
        var rule = loadEnvRule();
        var msg = rule.describeInvalidEnvName('a b');
        assert.match(msg, /^"a b" is not a valid environment name/);
        assert.match(msg, /letters, digits/);
        assert.match(rule.describeInvalidEnvName('a\nb'), /^"a\\nb"/, 'a control character is shown escaped');
    });
});

describe('03 - scope/inc/name.js reserved names', function () {

    it('refuses names every object inherits', function () {
        var rule = loadScopeRule();
        ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty',
            'count', 'functionCount'].forEach(function (n) {
            assert.equal(rule.isValidScopeName(n), false, n);
        });
    });

    it('exports isReservedName, which also refuses a property added to Object.prototype at run time', function () {
        var rule = loadScopeRule();
        assert.equal(typeof(rule.isReservedName), 'function');
        var probe = 'zzB639probe';
        assert.equal(rule.isReservedName(probe), false, 'not reserved before it exists');
        Object.defineProperty(Object.prototype, probe, { value: 1, configurable: true, enumerable: false, writable: true });
        try {
            assert.equal(rule.isReservedName(probe), true, 'reserved once every object inherits it');
            assert.equal(rule.isValidScopeName(probe), false);
        } finally {
            delete Object.prototype[probe];
        }
        assert.equal(rule.isReservedName(probe), false, 'the probe was removed');
    });

    it('an inherited property name gets its own refusal message', function () {
        var msg = loadScopeRule().describeInvalidScopeName('__proto__');
        assert.match(msg, /^"__proto__" is not a valid scope name/);
        assert.match(msg, /every object inherits/);
    });

    it('`global` stays a valid scope name, and #B626\'s accepted names are unchanged', function () {
        var rule = loadScopeRule();
        ['global', 'local', 'beta', 'production', 'testing', 'staging', 'my_scope.v2',
            'pre-prod', 'myScope', '_x', '.hidden', '0'].forEach(function (n) {
            assert.equal(rule.isValidScopeName(n), true, n);
        });
    });
});

describe('04 - env/add.js source pins', function () {

    it('the argv loop refuses through isValidEnvName', function () {
        assert.ok(ADD_ACTIVE.indexOf('require(\'./inc/name\')') > -1, 'add.js requires inc/name');
        assert.ok(ADD_ACTIVE.indexOf('envName.isValidEnvName(process.argv[i])') > -1);
        assert.ok(ADD_ACTIVE.indexOf('envName.describeInvalidEnvName(process.argv[i])') > -1);
    });

    it('the first-character-only acceptance is gone', function () {
        assert.equal(ADD_ACTIVE.indexOf('else if (/^[a-z0-9_.]/.test(process.argv[i]))'), -1);
        // anti-vacuity: the strip kept the code — the project-token test is still visible
        assert.ok(ADD_ACTIVE.indexOf('/^\\@[a-z0-9_.]/.test(process.argv[i])') > -1);
    });
});

// ---------------------------------------------------------------------------
// 05 — live, against an isolated home (the container-boot.test.js shape: HOME
// overridden so the CLI bootstraps a throwaway `~/.gina`; GINA_HOMEDIR removed so
// it cannot inherit the developer's). CLI exit codes are not trusted on the
// first-run bootstrap, so each arm asserts on-disk state and the printed message.
// ---------------------------------------------------------------------------

var STAMP     = Date.now();
var FAKE_HOME = path.join(os.tmpdir(), 'gina-b639-home-' + STAMP);
var GINA_HOME = path.join(FAKE_HOME, '.gina');
var PROJ      = 'b639p' + STAMP;
var PROJ_DIR  = path.join(FAKE_HOME, 'proj');
var CLI       = path.join(path.resolve(__dirname, '../..'), 'bin', 'cli');
var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

/**
 * Run an offline gina CLI command against the isolated home, from a working
 * directory inside it.
 *
 * @inner
 * @param {string[]} args - CLI arguments, starting with the task
 * @returns {{ status: (number|null), out: string }} The exit status and both streams joined
 */
function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), {
        env: CHILD_ENV, cwd: FAKE_HOME, encoding: 'utf8', timeout: 60000
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * The registered environments: main.json's list for the running release, and
 * the test project's list in projects.json.
 *
 * @inner
 * @returns {{ main: string[], project: string[] }}
 */
function registeredEnvs() {
    var main = JSON.parse(fs.readFileSync(path.join(GINA_HOME, 'main.json'), 'utf8'));
    var projects = JSON.parse(fs.readFileSync(path.join(GINA_HOME, 'projects.json'), 'utf8'));
    var release = Object.keys(main.envs)[0];
    return { main: main.envs[release], project: projects[PROJ].envs };
}

describe('05 - live: env:add against an isolated home', function () {
    var setupError = null;

    before(function () {
        fs.mkdirSync(PROJ_DIR, { recursive: true });
        var r = runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if ( !fs.existsSync(projectsPath) ) {
            setupError = 'project:add did not bootstrap the isolated home:\n' + r.out;
            return;
        }
        var entry = JSON.parse(fs.readFileSync(projectsPath, 'utf8'))[PROJ];
        if ( !entry || String(entry.path).indexOf(FAKE_HOME) !== 0 ) {
            setupError = 'sandbox breach or missing entry: ' + JSON.stringify(entry) + '\n' + r.out;
        }
    });

    after(function () {
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    [
        ['the retired <bundle>/<env> form', 'frontend/staging', /is not a valid environment name/],
        ['the reserved `global`',           'global',           /is not a valid environment name/],
        ['an inherited property name',      '__proto__',        /is not a valid environment name/]
    ].forEach(function (spec) {
        it('refuses ' + spec[0] + ' and registers nothing', function () {
            assert.equal(setupError, null, setupError || '');
            var before = registeredEnvs();
            var r = runCli(['env:add', spec[1]]);
            assert.match(r.out, spec[2], 'the refusal was reached and printed:\n' + r.out);
            assert.notEqual(r.status, 0, 'a refusal exits non-zero');
            var after = registeredEnvs();
            assert.deepEqual(after.main, before.main, 'main.json envs unchanged');
            assert.deepEqual(after.project, before.project, 'projects.json envs unchanged');
            assert.equal(after.main.indexOf(spec[1]), -1);
        });
    });

    it('CONTROL: a valid name is registered in main.json and on the project', function () {
        assert.equal(setupError, null, setupError || '');
        var r = runCli(['env:add', 'qa' + STAMP]);
        var after = registeredEnvs();
        assert.ok(after.main.indexOf('qa' + STAMP) > -1, 'main.json envs gained it:\n' + r.out);
        assert.ok(after.project.indexOf('qa' + STAMP) > -1, 'the project envs gained it:\n' + r.out);
    });
});
