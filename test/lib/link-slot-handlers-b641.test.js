/**
 * #B641 — `gina scope:link-local`, `scope:link-production` and `env:link-dev` check
 * the project before they look the scope or environment up in it.
 *
 * The three handlers set a slot of the project in `projects.json` (`local_scope`,
 * `production_scope`, `dev_env`). They looked the value up in
 * `self.projects[self.name]` BEFORE checking that a project had been resolved and
 * was registered, so run outside a project directory without `@<project>`, or with
 * an `@<project>` that is not registered, they crashed with a TypeError, reported
 * as "Gina has some troubles with this command" plus a stack, instead of the
 * "Project name is required" / "is not a valid project name" messages further
 * down. Their missing-argument message also named `scope:use` / `env:use`.
 *
 * Live, against an isolated home (the container-boot.test.js shape: HOME
 * overridden, GINA_HOMEDIR removed; each arm asserts output and on-disk state):
 *   01 — for each handler: no project resolvable → "Project name is required";
 *        an unregistered @project → "is not a valid project name"; no argument →
 *        the message names the command; CONTROLS — a registered project gets the
 *        slot, and a value the project does not list is refused by name.
 *   02 — CONTROL: the project is still inferred from the working directory.
 *
 * Red-first: on the pre-change handlers the two project arms and the
 * missing-argument arm fail for each handler (a crash, and the wrong command
 * named); the CONTROLs pass on both.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var STAMP     = Date.now();
var FAKE_HOME = path.join(os.tmpdir(), 'gina-b641-home-' + STAMP);
var GINA_HOME = path.join(FAKE_HOME, '.gina');
var CLI       = path.join(path.resolve(__dirname, '../..'), 'bin', 'cli');
var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var PROJECT     = 'b641p' + STAMP;
var PROJECT_DIR = path.join(FAKE_HOME, PROJECT);

/**
 * Run an offline gina CLI command against the isolated home.
 *
 * @inner
 * @param {string[]} args - CLI arguments, starting with the task
 * @param {string} [cwd] - Working directory, the isolated home by default
 * @returns {{ status: (number|null), out: string }}
 */
function runCli(args, cwd) {
    var r = spawnSync(process.execPath, [CLI].concat(args), {
        env: CHILD_ENV, cwd: cwd || FAKE_HOME, encoding: 'utf8', timeout: 90000
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * The isolated home's registry entry for the test project.
 *
 * @inner
 * @returns {object}
 */
function projectEntry() {
    return JSON.parse(fs.readFileSync(path.join(GINA_HOME, 'projects.json'), 'utf8'))[PROJECT] || {};
}

var HANDLERS = [
    // task, a value the project lists, a value it does not, the slot it sets, the lookup noun
    ['scope:link-local',      'production', 'nosuch', 'local_scope',      'Scope'],
    ['scope:link-production', 'local',      'nosuch', 'production_scope', 'Scope'],
    ['env:link-dev',          'prod',       'nosuch', 'dev_env',          'Environment']
];

// File-level setup and cleanup: both sections share the isolated home.
var setupError = null;

before(function () {
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    var r = runCli(['project:add', '@' + PROJECT, '--path=' + PROJECT_DIR]);
    var entry = fs.existsSync(path.join(GINA_HOME, 'projects.json')) ? projectEntry() : {};
    if ( !entry.path ) {
        setupError = 'project:add did not register @' + PROJECT + ' in the isolated home:\n' + r.out;
    } else if ( String(entry.path).indexOf(FAKE_HOME) !== 0 ) {
        setupError = 'sandbox breach: ' + entry.path;
    }
});

after(function () {
    try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('01 - scope:link-local / scope:link-production / env:link-dev', function () {

    HANDLERS.forEach(function (h) {
        var task = h[0], listed = h[1], unlisted = h[2], slot = h[3], noun = h[4];

        it('[' + task + '] no project resolvable: refused by name, no crash', function () {
            assert.equal(setupError, null, setupError || '');
            var r = runCli([task, listed]); // cwd = the isolated home, not a project directory
            assert.doesNotMatch(r.out, /troubles with this command/, 'crashed:\n' + r.out);
            assert.match(r.out, /Project name is required: @<project_name>/, 'refusal printed:\n' + r.out);
            assert.equal(r.status, 1);
        });

        it('[' + task + '] an unregistered @project: refused by name, no crash', function () {
            assert.equal(setupError, null, setupError || '');
            var r = runCli([task, listed, '@nope' + STAMP]);
            assert.doesNotMatch(r.out, /troubles with this command/, 'crashed:\n' + r.out);
            assert.match(r.out, /\[ nope\d+ \] is not a valid project name\./, 'refusal printed:\n' + r.out);
            assert.equal(r.status, 1);
        });

        it('[' + task + '] no argument: the message names the command that was run', function () {
            assert.equal(setupError, null, setupError || '');
            var r = runCli([task]);
            assert.match(r.out, new RegExp('Missing argument in \\[ gina ' + task.replace(':', '\\:') + ' '), 'message:\n' + r.out);
            assert.equal(r.status, 1);
        });

        it('[' + task + '] CONTROL: a value the project does not list is refused by name', function () {
            assert.equal(setupError, null, setupError || '');
            var before = projectEntry()[slot];
            var r = runCli([task, unlisted, '@' + PROJECT]);
            assert.match(r.out, new RegExp(noun + ' \\[ ' + unlisted + ' \\] not found'), 'refusal printed:\n' + r.out);
            assert.equal(projectEntry()[slot], before, slot + ' unchanged');
        });

        it('[' + task + '] CONTROL: a registered project gets the slot', function () {
            assert.equal(setupError, null, setupError || '');
            var r = runCli([task, listed, '@' + PROJECT]);
            assert.equal(r.status, 0, 'exit 0:\n' + r.out);
            assert.equal(projectEntry()[slot], listed, slot + ' set:\n' + r.out);
        });
    });
});

describe('02 - the project is still inferred from the working directory', function () {

    it('CONTROL: env:link-dev run from the project directory sets its dev_env', function () {
        // 01 ran first and left dev_env on `prod`; switch it back from inside the project
        assert.equal(setupError, null, setupError || '');
        var r = runCli(['env:link-dev', 'dev'], PROJECT_DIR);
        assert.equal(r.status, 0, 'exit 0:\n' + r.out);
        assert.equal(projectEntry().dev_env, 'dev', 'dev_env set from the cwd project:\n' + r.out);
    });
});
