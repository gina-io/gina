/**
 * framework:reset — runtime factory reset (clears ~/.gina; rebuilds on next cmd)
 *
 * Why source inspection + simulation instead of requiring the module:
 *   reset.js depends on injected globals (lib.logger, getEnvVar, GINA_RUNDIR, _)
 *   only present inside a running gina process, and it calls process.exit() at
 *   every exit — so it cannot be required in a bare node:test context (same
 *   constraint framework-init-middleware.test.js / framework-version.test.js
 *   document). The end-to-end behaviour is validated by the Bun container smoke.
 *
 * Background: `npm install -g gina@latest --reset` wipes ~/.gina from the npm
 * install lifecycle (pre/post_install.js). That lifecycle does NOT run under Bun
 * (`bun add -g` blocks dependency scripts), so the install-flag reset never
 * fires there. framework:reset is the runtime, package-manager-agnostic
 * equivalent: it wipes ~/.gina and lets the next command rebuild it (the
 * measured-safe "absent ~/.gina rebuilds on next run" path — NOT an in-process
 * re-invoke of init, which would read stale require-cached ~/.gina JSON).
 *
 * Covers:
 *   (a) source structure — the running-process guard (refuse unless --force),
 *       the fs.rmSync wipe, the run-dir liveness probe, --force parsing, the
 *       home resolution, and the deliberate no-in-process-rebuild decision
 *   (b) detectRunning enumeration/liveness (pure-logic replica)
 *   (c) the guard decision + --force parsing (pure-logic replica)
 */
'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var commentStrip = require('../strip-comments');

var SOURCE_PATH = path.join(require('../fw'), 'lib/cmd/framework/reset.js');
var src = fs.readFileSync(SOURCE_PATH, 'utf8');

/** Strip block + line comments so negative code-absence pins don't trip on the
 *  file's own JSDoc (the jsdoc.md "negative pin trips on the file's own comment"
 *  trap — the module header explains WHY it avoids the in-process rebuild). */
function stripComments(s) {
    return commentStrip.all(s);
}

/** Slice the guarded-reset init() body, end-anchored on the end() declaration so
 *  the window can't drift, start-anchored on the function so its JSDoc is out. */
function initBlock() {
    var start = src.indexOf('var init = function() {');
    var end   = src.indexOf('var end = function(', start);
    assert.ok(start > -1 && end > start, 'could not slice init() body');
    return src.slice(start, end);
}


// ---------------------------------------------------------------------------
// 01 — source structure
// ---------------------------------------------------------------------------
describe('01 - framework:reset source structure', function() {

    it('refuses when processes are running and --force is absent', function() {
        var blk = initBlock();
        assert.ok(/if\s*\(\s*running\.length\s*&&\s*!force\s*\)/.test(blk),
            'expected the refusal gated on (running.length && !force)');
        assert.ok(blk.indexOf('gina stop') > -1, 'expected the refusal to point at `gina stop`');
    });

    it('warns but proceeds when running and --force is set', function() {
        assert.ok(/if\s*\(\s*running\.length\s*&&\s*force\s*\)/.test(initBlock()),
            'expected a warn branch on (running.length && force)');
    });

    it('wipes ~/.gina with fs.rmSync recursive+force', function() {
        assert.ok(/fs\.rmSync\(\s*ginaHome\s*,\s*\{[^}]*recursive:\s*true[^}]*force:\s*true[^}]*\}\s*\)/.test(initBlock()),
            'expected fs.rmSync(ginaHome, { recursive:true, force:true })');
    });

    it('leaves ~/.gina absent — message says it rebuilds on the next command', function() {
        var blk = initBlock();
        assert.ok(/next gina command/i.test(blk), 'expected the "next gina command" rebuild message');
        assert.ok(blk.indexOf('Factory reset complete') > -1, 'expected the success confirmation');
    });

    it('probes run-dir pidfile liveness via process.kill(pid, 0)', function() {
        assert.ok(src.indexOf('process.kill(pid, 0)') > -1, 'expected a process.kill(pid, 0) liveness probe');
        assert.ok(src.indexOf('fs.readdirSync(runDir)') > -1, 'expected the run-dir enumeration');
        assert.ok(/\/\\\.pid\$\/|\.pid\$/.test(src), 'expected a .pid file filter');
    });

    it('counts EPERM as alive (conservative) and skips ESRCH (stale)', function() {
        assert.ok(src.indexOf("'EPERM'") > -1, 'expected EPERM handled as alive');
    });

    it('parses --force (and --force=true)', function() {
        assert.ok(/\^\\-\\-force\(\\=true\)\?\$/.test(src) || /--force\(\\=true\)\?/.test(src),
            'expected a --force / --force=true matcher');
    });

    it('resolves the home from GINA_HOMEDIR with opt.homedir fallback', function() {
        assert.ok(src.indexOf("getEnvVar('GINA_HOMEDIR')") > -1, 'expected GINA_HOMEDIR source');
        assert.ok(src.indexOf('opt.homedir') > -1, 'expected the opt.homedir fallback');
    });

    it('does NOT re-bootstrap in-process (no init re-invoke / no onComplete)', function() {
        var clean = stripComments(src);
        assert.ok(clean.indexOf('/cmd/framework/init') < 0,
            'must NOT require the init module (stale require-cache hazard — rebuild defers to next cmd)');
        assert.ok(clean.indexOf('.onComplete(') < 0, 'must NOT drive an in-process init chain');
    });

});


// ---------------------------------------------------------------------------
// 02 — detectRunning enumeration / liveness (pure-logic replica)
// ---------------------------------------------------------------------------
describe('02 - run-dir liveness logic', function() {

    /**
     * Mirror of detectRunning: enumerate *.pid files (incl. gina-* daemon),
     * skip hidden/non-pid, liveness via an injected kill(pid) that returns
     * 'alive' | 'ESRCH' | 'EPERM'.
     * @param {Object.<string,string>} files  filename -> pidfile content
     * @param {function(number):string} kill   pid -> liveness verdict
     * @returns {Array<{name:string,pid:number}>}
     */
    function detectRunning(files, kill) {
        var alive = [];
        Object.keys(files).forEach(function(file) {
            if (/^\./.test(file) || !/\.pid$/.test(file)) return;
            var pid = parseInt(String(files[file]).trim(), 10);
            if (!pid || isNaN(pid)) return;
            var v = kill(pid);
            if (v === 'alive' || v === 'EPERM') alive.push({ name: file.replace(/\.pid$/, ''), pid: pid });
        });
        return alive;
    }

    it('returns live bundle AND daemon pidfiles, skips stale (ESRCH)', function() {
        var files = { 'api@demo.pid': '111', 'web@demo.pid': '222', 'gina-v0.5.5-alpha.2.pid': '333' };
        var alive = detectRunning(files, function(pid) { return pid === 222 ? 'ESRCH' : 'alive'; });
        var names = alive.map(function(a) { return a.name; }).sort();
        assert.deepEqual(names, ['api@demo', 'gina-v0.5.5-alpha.2']); // 222 (web) is stale -> dropped
    });

    it('counts an EPERM pid as alive (conservative)', function() {
        var alive = detectRunning({ 'api@demo.pid': '999' }, function() { return 'EPERM'; });
        assert.equal(alive.length, 1);
    });

    it('skips hidden files, non-pid files, and empty/garbage pids', function() {
        var files = { '.DS_Store': 'x', 'notes.txt': 'y', 'bad.pid': 'notanumber', 'zero.pid': '0', 'ok.pid': '42' };
        var alive = detectRunning(files, function() { return 'alive'; });
        assert.deepEqual(alive.map(function(a){return a.name;}), ['ok']);
    });

    it('returns empty when nothing is alive', function() {
        var alive = detectRunning({ 'api@demo.pid': '111' }, function() { return 'ESRCH'; });
        assert.equal(alive.length, 0);
    });

});


// ---------------------------------------------------------------------------
// 03 — guard decision + --force parsing (pure-logic replica)
// ---------------------------------------------------------------------------
describe('03 - guard decision + --force', function() {

    function hasForce(argv) {
        for (var i = 0; i < argv.length; i++) {
            if (/^\-\-force(\=true)?$/i.test(argv[i])) return true;
        }
        return false;
    }

    /** running + !force -> 'refuse'; running + force -> 'force'; else 'proceed' */
    function decide(runningCount, force) {
        if (runningCount && !force) return 'refuse';
        if (runningCount && force)  return 'force';
        return 'proceed';
    }

    it('parses --force and --force=true; ignores others', function() {
        assert.equal(hasForce(['gina', 'framework:reset', '--force']), true);
        assert.equal(hasForce(['gina', 'framework:reset', '--force=true']), true);
        assert.equal(hasForce(['gina', 'reset']), false);
        assert.equal(hasForce(['gina', 'reset', '--forcefully']), false);
    });

    it('refuses when running without --force', function() {
        assert.equal(decide(2, false), 'refuse');
    });

    it('proceeds (with warning) when running with --force', function() {
        assert.equal(decide(2, true), 'force');
    });

    it('proceeds cleanly when nothing is running', function() {
        assert.equal(decide(0, false), 'proceed');
        assert.equal(decide(0, true), 'proceed');
    });

});
