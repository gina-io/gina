/**
 * #B640 — `gina project:add` / `project:import` run their `--scope=` / `--env=`
 * children without a shell, and refuse an invalid name before writing anything.
 *
 * The two children (`scope:add`, `env:add`) used to be launched through a shell
 * string with the option value spliced in unquoted, so a value carrying shell
 * syntax ran as shell syntax — before the child's own whole-name check (#B626,
 * #B639) ever saw it — and an invalid name was refused only AFTER the project
 * had been registered, leaving it half-added. Now both values are checked up
 * front with the shared name rules, and the children are spawned from an
 * argument vector.
 *
 * Registration semantics are deliberately unchanged: the children still receive
 * no `@<project>` token, so a new scope or environment is registered for every
 * project, as before.
 *
 * Sections:
 *   01 — add.js (comment-stripped source pins): the name rules are applied before
 *        the shared bootstrap, and both children are spawned by execFileSync from
 *        an argument vector; no shell string carries either value.
 *   02 — live, against an isolated home: shell syntax in either value is refused
 *        and never executes; an invalid name is refused before anything is
 *        written; CONTROLS — a new project with new names registers them through
 *        the children, the consumer boot line (`project:import … --scope=local
 *        --env=dev`) keeps working, an import passing names registered before
 *        the name rules keeps working (the check is skipped on import), and an
 *        import naming a scope or environment the project does not list is
 *        refused by the CLI bootstrap before any child runs (so the import path
 *        never reached a shell, before or after).
 *
 * Red-first: on the pre-change tree every 01 pin fails, and 02's three refusal
 * arms fail (the injected commands run, and the invalid name half-registers the
 * project); the five CONTROLs pass on both. The legacy-import CONTROL is the one
 * that fails if the name check is applied on `project:import` as well.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW      = require('../fw');
var ADD_SRC = fs.readFileSync(path.join(FW, 'lib/cmd/project/add.js'), 'utf8');

// comment-stripped handler source, so a pin never matches the fix's own comments
var ADD_ACTIVE = ADD_SRC.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

/**
 * The `--scope` child block and the `--env` child block of add.js, sliced
 * between their structural anchors (the same anchors
 * `project-add-link.test.js` §10 uses).
 *
 * @inner
 * @returns {{ scope: string, env: string }} Empty strings when an anchor is missing
 */
function childBlocks() {
    var scopeIdx = ADD_ACTIVE.indexOf("if ( self.scope && !isDefined('scope', self.scope) )");
    var envIdx   = ADD_ACTIVE.indexOf("if ( self.env && !isDefined('env', self.env) )");
    var manIdx   = ADD_ACTIVE.indexOf('file = new _(self.projectManifestPath, true);');
    return {
        scope : (scopeIdx > -1 && envIdx > scopeIdx) ? ADD_ACTIVE.slice(scopeIdx, envIdx) : '',
        env   : (envIdx > -1 && manIdx > envIdx) ? ADD_ACTIVE.slice(envIdx, manIdx) : ''
    };
}

describe('01 - project/add.js source pins', function () {

    it('both child blocks were found by their structural anchors', function () {
        var b = childBlocks();
        assert.ok(b.scope.length > 0, 'scope block anchor missing');
        assert.ok(b.env.length > 0, 'env block anchor missing');
    });

    it('requires execFileSync and both name rules', function () {
        assert.ok(ADD_ACTIVE.indexOf("require('child_process').execFileSync") > -1);
        assert.ok(ADD_ACTIVE.indexOf("require('../scope/inc/name')") > -1);
        assert.ok(ADD_ACTIVE.indexOf("require('../env/inc/name')") > -1);
    });

    it('checks both values with the name rules BEFORE the shared bootstrap', function () {
        var scopeCheck = ADD_ACTIVE.indexOf('scopeName.isValidScopeName(self.scope)');
        var envCheck   = ADD_ACTIVE.indexOf('envName.isValidEnvName(self.env)');
        var bootstrap  = ADD_ACTIVE.indexOf('if ( !isCmdConfigured() ) return false;');
        assert.ok(scopeCheck > -1 && envCheck > -1 && bootstrap > -1, 'all three found');
        assert.ok(scopeCheck < bootstrap, 'the scope check precedes isCmdConfigured()');
        assert.ok(envCheck < bootstrap, 'the env check precedes isCmdConfigured()');
    });

    [['scope', 'scope:add', 'self.scope'], ['env', 'env:add', 'self.env']].forEach(function (spec) {
        it('[' + spec[0] + '] the child is spawned from an argument vector, with no shell string', function () {
            var blk = childBlocks()[spec[0]];
            assert.match(blk, /execFileSync\(\s*process\.execPath\s*,/, 'execFileSync on the running node');
            assert.ok(blk.indexOf("'" + spec[1] + "'") > -1, 'the task is its own argv element');
            assert.ok(blk.indexOf(spec[2] + ']') > -1 || blk.indexOf(spec[2] + ' ]') > -1,
                'the value is its own (last) argv element');
            assert.equal(blk.indexOf('execSync('), -1, 'no execSync in the child block');
            assert.equal(blk.indexOf("+ " + spec[2] + ";"), -1, 'the value is not concatenated into a string');
        });
    });
});

// ---------------------------------------------------------------------------
// 02 — live, against an isolated home (the container-boot.test.js shape: HOME
// overridden so the CLI bootstraps a throwaway `~/.gina`; GINA_HOMEDIR removed so
// it cannot inherit the developer's). CLI exit codes are not trusted on the
// first-run bootstrap, so each arm asserts on-disk state.
// ---------------------------------------------------------------------------

var STAMP     = Date.now();
var FAKE_HOME = path.join(os.tmpdir(), 'gina-b640-home-' + STAMP);
var GINA_HOME = path.join(FAKE_HOME, '.gina');
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
        env: CHILD_ENV, cwd: FAKE_HOME, encoding: 'utf8', timeout: 90000
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
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
 * @param {object} data - The content to write
 */
function writeState(name, data) {
    fs.writeFileSync(path.join(GINA_HOME, name), JSON.stringify(data, null, 4));
}

/**
 * The first release key of a main.json per-release map (the running release).
 *
 * @inner
 * @param {object} map - For example main.envs
 * @returns {string[]}
 */
function releaseList(map) {
    return map[Object.keys(map)[0]];
}

describe('02 - live: project:add / project:import against an isolated home', function () {
    var setupError = null;
    var IMPORTED   = 'b640imp' + STAMP;                      // registered in before(), imported by the CONTROLs
    var IMPORT_DIR = path.join(FAKE_HOME, IMPORTED + '.app'); // last segment ≠ project name, like a consumer tree

    before(function () {
        fs.mkdirSync(IMPORT_DIR, { recursive: true });
        var r = runCli(['project:add', '@' + IMPORTED, '--path=' + IMPORT_DIR]);
        var projects = readState('projects.json');
        if ( !projects || !projects[IMPORTED] ) {
            setupError = 'project:add did not bootstrap the isolated home or register @' + IMPORTED + ':\n' + r.out;
            return;
        }
        if ( String(projects[IMPORTED].path).indexOf(FAKE_HOME) !== 0 ) {
            setupError = 'sandbox breach: ' + projects[IMPORTED].path;
        }
    });

    after(function () {
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    it('shell syntax in --scope never runs, and nothing is registered', function () {
        assert.equal(setupError, null, setupError || '');
        var name   = 'b640s' + STAMP;
        var marker = path.join(FAKE_HOME, 'PWNED-scope');
        var dir    = path.join(FAKE_HOME, name);
        var r = runCli(['project:add', '@' + name, '--path=' + dir, '--scope=x;touch ' + marker]);
        assert.equal(fs.existsSync(marker), false, 'the injected command ran:\n' + r.out);
        assert.match(r.out, /is not a valid scope name/, 'the refusal was printed:\n' + r.out);
        assert.equal((readState('projects.json') || {})[name], undefined, 'the project was not registered');
        assert.equal(fs.existsSync(path.join(dir, 'package.json')), false, 'no project file was written');
    });

    it('shell syntax in --env never runs, and nothing is registered', function () {
        assert.equal(setupError, null, setupError || '');
        var name   = 'b640e' + STAMP;
        var marker = path.join(FAKE_HOME, 'PWNED-env');
        var dir    = path.join(FAKE_HOME, name);
        var r = runCli(['project:add', '@' + name, '--path=' + dir, '--env=x$(touch ' + marker + ')']);
        assert.equal(fs.existsSync(marker), false, 'the injected command ran:\n' + r.out);
        assert.match(r.out, /is not a valid environment name/, 'the refusal was printed:\n' + r.out);
        assert.equal((readState('projects.json') || {})[name], undefined, 'the project was not registered');
    });

    it('an invalid name is refused before the project is written', function () {
        assert.equal(setupError, null, setupError || '');
        var name = 'b640n' + STAMP;
        var dir  = path.join(FAKE_HOME, name);
        var r = runCli(['project:add', '@' + name, '--path=' + dir, '--scope=Staging']);
        assert.match(r.out, /is not a valid scope name/, 'the refusal was printed:\n' + r.out);
        assert.equal((readState('projects.json') || {})[name], undefined, 'the project was not half-registered');
        assert.equal(fs.existsSync(dir), false, 'not even the project directory was created');
    });

    it('CONTROL: a new project with new names registers them through the children', function () {
        assert.equal(setupError, null, setupError || '');
        var name  = 'b640c' + STAMP;
        var scope = 'stg' + STAMP;
        var env   = 'qa' + STAMP;
        var r = runCli(['project:add', '@' + name, '--path=' + path.join(FAKE_HOME, name), '--scope=' + scope, '--env=' + env]);
        var projects = readState('projects.json') || {};
        var main     = readState('main.json') || {};
        assert.ok(projects[name], 'the project was registered:\n' + r.out);
        assert.ok(releaseList(main.scopes).indexOf(scope) > -1, 'scope:add ran (main.json scopes):\n' + r.out);
        assert.ok(releaseList(main.envs).indexOf(env) > -1, 'env:add ran (main.json envs):\n' + r.out);
        assert.ok(projects[name].scopes.indexOf(scope) > -1, 'the project lists the scope');
        assert.ok(projects[name].envs.indexOf(env) > -1, 'the project lists the environment');
    });

    it('CONTROL: the consumer boot line `project:import … --scope=local --env=dev` keeps working', function () {
        assert.equal(setupError, null, setupError || '');
        var r = runCli(['project:import', '@' + IMPORTED, '--path=' + IMPORT_DIR, '--scope=local', '--env=dev']);
        var projects = readState('projects.json') || {};
        assert.ok(projects[IMPORTED], 'still registered:\n' + r.out);
        assert.equal(projects[IMPORTED].path, IMPORT_DIR, 'path kept');
        assert.ok(projects[IMPORTED].scopes.indexOf('local') > -1, 'local kept');
        assert.ok(projects[IMPORTED].envs.indexOf('dev') > -1, 'dev kept');
        assert.doesNotMatch(r.out, /could not be set/, 'no child failed:\n' + r.out);
    });

    // The up-front name check is skipped on `project:import`, so a name registered
    // before the rules existed — what the retired `scope:add <bundle>/<scope>` and
    // `env:add <bundle>/<env>` forms registered — keeps importing, as #B626 promised
    // for scopes. This arm is green on the pre-change tree and turns red if the
    // check is ever applied on import too.
    it('CONTROL: an import passing names registered before the name rules keeps working', function () {
        assert.equal(setupError, null, setupError || '');
        var legacyScope = 'frontend/staging';
        var legacyEnv   = 'frontend/qa';
        var main     = readState('main.json');
        var projects = readState('projects.json');
        releaseList(main.scopes).push(legacyScope);
        releaseList(main.envs).push(legacyEnv);
        projects[IMPORTED].scopes.push(legacyScope);
        projects[IMPORTED].envs.push(legacyEnv);
        writeState('main.json', main);
        writeState('projects.json', projects);
        var r = runCli(['project:import', '@' + IMPORTED, '--path=' + IMPORT_DIR, '--scope=' + legacyScope, '--env=' + legacyEnv]);
        assert.doesNotMatch(r.out, /is not a valid (scope|environment) name/, 'a registered legacy name was refused:\n' + r.out);
        assert.doesNotMatch(r.out, /running: /, 'no child was spawned:\n' + r.out);
        assert.equal(r.status, 0, 'the import succeeded:\n' + r.out);
        assert.equal(((readState('projects.json') || {})[IMPORTED] || {}).path, IMPORT_DIR, 'still registered at its path');
    });

    // An import names a registered project, and the CLI bootstrap
    // (`framework/init.js` checkScope / checkEnv) refuses a --scope / --env value
    // that project does not list — before project/add.js runs at all. So no
    // child is ever spawned on an import with a value the project lacks, shell
    // syntax included. Measured on the pre-change tree too: this arm is green on
    // both, and pins that the import path never reached a shell.
    [['scope', 'imps', ';touch '], ['env', 'impe', '$(touch ']].forEach(function (spec) {
        it('CONTROL: an import naming a ' + spec[0] + ' the project does not list is refused by the bootstrap, and nothing runs', function () {
            assert.equal(setupError, null, setupError || '');
            var marker = path.join(FAKE_HOME, 'PWNED-import-' + spec[0]);
            var value  = spec[1] + STAMP + spec[2] + marker + (spec[0] == 'env' ? ')' : '');
            var r = runCli(['project:import', '@' + IMPORTED, '--path=' + IMPORT_DIR, '--' + spec[0] + '=' + value]);
            var main = readState('main.json') || {};
            var list = releaseList(spec[0] == 'scope' ? main.scopes : main.envs);
            assert.equal(fs.existsSync(marker), false, 'the injected command ran:\n' + r.out);
            assert.match(r.out, /not registered/, 'the bootstrap refusal was printed:\n' + r.out);
            assert.equal(list.indexOf(spec[1] + STAMP), -1, 'nothing was registered');
            assert.ok((readState('projects.json') || {})[IMPORTED], 'the project stays registered');
        });
    });
});
