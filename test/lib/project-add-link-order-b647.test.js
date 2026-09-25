/**
 * #B647 — `gina project:add` starts its `link` step only once the rest of the
 * command has finished.
 *
 * For a new project, `end()` is reached from `createPackageFile()` before `init()`
 * runs the `--scope` / `--env` children (`scope:add`, `env:add`) and writes
 * `manifest.json` / `env.json`. `end()` used to start the `link` child right there,
 * through the asynchronous `Shell` helper, so it ran alongside those children —
 * and every gina CLI process reads and rewrites the registry files, so concurrent
 * processes lose each other's writes. Measured before the fix (100 runs of the
 * flow in section 02, each in a fresh isolated home): the new scope was missing
 * afterwards from `main.json` or from the project's list on 3/100 runs, and the
 * state store logged `database is locked` on 63/100. With the link step deferred:
 * 0/100 on both counts.
 *
 * Sections:
 *   01 — add.js (comment-stripped source pin): in `end()`, the link dispatch sits
 *        inside a `setImmediate` callback.
 *   02 — live, against an isolated home: five `project:add` runs with new scope
 *        and environment names each leave both names registered, in `main.json`
 *        and in the project's lists, and none logs `database is locked`.
 *
 * Red-first: on the pre-change tree the 01 pin fails, and 02 fails on all but
 * about 0.3^5 of runs (a lock warning in each of five runs is ~70% likely).
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');

var FW      = require('../fw');
var ADD_SRC = fs.readFileSync(path.join(FW, 'lib/cmd/project/add.js'), 'utf8');

// comment-stripped handler source, so a pin never matches the fix's own comments
var ADD_ACTIVE = ADD_SRC.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

describe('01 - project/add.js source pin', function () {

    it('end() dispatches the link step from a setImmediate callback', function () {
        var endIdx   = ADD_ACTIVE.indexOf('var end = async function(created) {');
        var nextIdx  = ADD_ACTIVE.indexOf('var hasPastProtocolAndSchemeCheck = function', endIdx);
        assert.ok(endIdx > -1 && nextIdx > endIdx, 'end() found by its structural anchors');
        var END      = ADD_ACTIVE.slice(endIdx, nextIdx);
        var deferIdx = END.indexOf('setImmediate(function linkOnceScaffolded()');
        var linkIdx  = END.indexOf('linkGina(onError, onSuccess)');
        assert.ok(deferIdx > -1, 'the link dispatch is deferred with setImmediate');
        assert.ok(linkIdx > deferIdx, 'linkGina() is called inside the deferred callback, not before it');
    });
});

// ---------------------------------------------------------------------------
// 02 — live, against an isolated home (the container-boot.test.js shape: HOME
// overridden so the CLI bootstraps a throwaway `~/.gina`; GINA_HOMEDIR removed so
// it cannot inherit the developer's). Each run asserts on-disk state.
// ---------------------------------------------------------------------------

var STAMP     = Date.now();
var FAKE_HOME = path.join(os.tmpdir(), 'gina-b647-home-' + STAMP);
var GINA_HOME = path.join(FAKE_HOME, '.gina');
var CLI       = path.join(path.resolve(__dirname, '../..'), 'bin', 'cli');
var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

/**
 * Read a JSON state file of the isolated home, or an empty object when absent.
 *
 * @inner
 * @param {string} name - File name inside the isolated `.gina`
 * @returns {object}
 */
function readState(name) {
    var p = path.join(GINA_HOME, name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

/**
 * The first release key's list of a main.json per-release map.
 *
 * @inner
 * @param {object} map - For example main.scopes
 * @returns {string[]}
 */
function releaseList(map) {
    return (map && map[Object.keys(map)[0]]) || [];
}

describe('02 - live: project:add with new names, five runs', function () {

    after(function () {
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    it('every run keeps both new names registered, and no run hits a locked state store', function () {
        fs.mkdirSync(FAKE_HOME, { recursive: true });
        for (var n = 0; n < 5; n++) {
            var name  = 'b647p' + STAMP + 'n' + n;
            var scope = 'stg' + STAMP + 'n' + n;
            var env   = 'qa' + STAMP + 'n' + n;
            var r = spawnSync(process.execPath, [CLI, 'project:add', '@' + name,
                '--path=' + path.join(FAKE_HOME, name), '--scope=' + scope, '--env=' + env],
                { env: CHILD_ENV, cwd: FAKE_HOME, encoding: 'utf8', timeout: 90000 });
            var out      = (r.stdout || '') + (r.stderr || '');
            var main     = readState('main.json');
            var projects = readState('projects.json');
            var label    = 'run ' + n + ':\n' + out;
            assert.ok(projects[name], 'the project was registered, ' + label);
            assert.ok(String(projects[name].path).indexOf(FAKE_HOME) === 0, 'sandbox kept, ' + label);
            assert.doesNotMatch(out, /database is locked/, 'no concurrent state-store writer, ' + label);
            assert.ok(releaseList(main.scopes).indexOf(scope) > -1, 'main.json lists the scope, ' + label);
            assert.ok(releaseList(main.envs).indexOf(env) > -1, 'main.json lists the environment, ' + label);
            assert.ok(projects[name].scopes.indexOf(scope) > -1, 'the project lists the scope, ' + label);
            assert.ok(projects[name].envs.indexOf(env) > -1, 'the project lists the environment, ' + label);
        }
    });
});
