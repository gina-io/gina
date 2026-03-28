'use strict';
/**
 * lib/state.js — StateStore unit tests (#CN2 v3)
 *
 * Strategy: source inspection + functional tests against a temp directory.
 * node:sqlite is built-in on Node >= 22.5.0. Tests that exercise the live DB
 * are skipped gracefully on older versions.
 * No framework bootstrap or live project is required.
 */

var { describe, it, before, after, beforeEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');

var FW         = require('../fw');
var STATE_PATH = path.join(FW, 'lib/state.js');

var HAS_SQLITE = false;
try {
    require('node:sqlite');
    HAS_SQLITE = true;
} catch (_) {}


// ─── 01 — source structure ───────────────────────────────────────────────────

describe('01 - StateStore: source structure', function() {

    var src;
    before(function() { src = fs.readFileSync(STATE_PATH, 'utf8'); });

    it('exports StateStore constructor', function() {
        assert.ok(/function StateStore\(\)/.test(src));
        assert.ok(/module\.exports\s*=\s*StateStore/.test(src));
    });

    it('exports getInstance() singleton factory', function() {
        assert.ok(/StateStore\.getInstance\s*=\s*function/.test(src));
        assert.ok(/StateStore\._instance/.test(src));
    });

    it('requires node:sqlite with a try/catch guard', function() {
        assert.ok(/require\('node:sqlite'\)/.test(src));
        assert.ok(/catch\s*\(/.test(src));
    });

    it('uses DatabaseSync (synchronous API)', function() {
        assert.ok(/DatabaseSync/.test(src));
    });

    it('creates kv_store table with key, value, updated_at columns', function() {
        assert.ok(/CREATE TABLE IF NOT EXISTS kv_store/.test(src));
        assert.ok(/key\s+TEXT\s+PRIMARY KEY/.test(src));
        assert.ok(/value\s+TEXT\s+NOT NULL/.test(src));
        assert.ok(/updated_at\s+INTEGER\s+NOT NULL/.test(src));
    });

    it('uses INSERT OR REPLACE for atomic upserts', function() {
        assert.ok(/INSERT OR REPLACE INTO kv_store/.test(src));
    });

    it('maps the five known state files to SQLite keys', function() {
        assert.ok(/'main\.json'\s*:\s*'main'/.test(src));
        assert.ok(/'projects\.json'\s*:\s*'projects'/.test(src));
        assert.ok(/'ports\.json'\s*:\s*'ports'/.test(src));
        assert.ok(/'ports\.reverse\.json'\s*:\s*'ports_reverse'/.test(src));
        // settings uses a dynamic pattern, not a fixed key
        assert.ok(/settings\.json/.test(src));
        assert.ok(/settings\//.test(src));
    });

    it('writes JSON sidecar via fs.writeFileSync on every SQLite write', function() {
        assert.ok(/fs\.writeFileSync/.test(src));
    });

    it('reads GINA_HOMEDIR through getEnvVar with a typeof guard', function() {
        assert.ok(/typeof\s*\(\s*getEnvVar\s*\)\s*===\s*'function'/.test(src)
               || /typeof\(getEnvVar\)\s*===\s*'function'/.test(src));
        assert.ok(/GINA_HOMEDIR/.test(src));
    });

    it('exposes isStatePath(), write(), read(), and close()', function() {
        assert.ok(/this\.isStatePath\s*=\s*function/.test(src));
        assert.ok(/this\.write\s*=\s*function/.test(src));
        assert.ok(/this\.read\s*=\s*function/.test(src));
        assert.ok(/this\.close\s*=\s*function/.test(src));
    });

});


// ─── 02 — isStatePath (no SQLite required) ───────────────────────────────────

describe('02 - StateStore: isStatePath()', function() {

    var StateStore;
    var store;
    var fakeHome = '/tmp/gina-test-home';

    before(function() {
        StateStore = require(STATE_PATH);
        // Install a minimal getEnvVar global for the test
        global.getEnvVar = function(k) {
            if (k === 'GINA_HOMEDIR') return fakeHome;
            return undefined;
        };
        // Use a fresh instance for this suite
        StateStore._instance = null;
        store = StateStore.getInstance();
    });

    after(function() {
        // Reset singleton so other suites get a clean instance
        if (store && typeof store.close === 'function') store.close();
        StateStore._instance = null;
        delete global.getEnvVar;
    });

    it('returns true for main.json', function() {
        assert.ok(store.isStatePath(fakeHome + '/main.json'));
    });

    it('returns true for projects.json', function() {
        assert.ok(store.isStatePath(fakeHome + '/projects.json'));
    });

    it('returns true for ports.json', function() {
        assert.ok(store.isStatePath(fakeHome + '/ports.json'));
    });

    it('returns true for ports.reverse.json', function() {
        assert.ok(store.isStatePath(fakeHome + '/ports.reverse.json'));
    });

    it('returns true for {shortVersion}/settings.json', function() {
        assert.ok(store.isStatePath(fakeHome + '/0.1/settings.json'));
        assert.ok(store.isStatePath(fakeHome + '/1.0/settings.json'));
    });

    it('returns false for an arbitrary JSON file under homeDir', function() {
        assert.ok(!store.isStatePath(fakeHome + '/env.json'));
        assert.ok(!store.isStatePath(fakeHome + '/other.json'));
    });

    it('returns false for a file outside homeDir', function() {
        assert.ok(!store.isStatePath('/etc/passwd'));
        assert.ok(!store.isStatePath('/tmp/main.json'));
    });

    it('returns false when path has homeDir as substring but is not inside it', function() {
        assert.ok(!store.isStatePath(fakeHome + '-other/main.json'));
    });

});


// ─── 03 — graceful fallback (no GINA_HOMEDIR) ────────────────────────────────

describe('03 - StateStore: fallback when GINA_HOMEDIR is not set', function() {

    var StateStore;
    var store;

    before(function() {
        StateStore = require(STATE_PATH);
        global.getEnvVar = function() { return undefined; };
        StateStore._instance = null;
        store = StateStore.getInstance();
    });

    after(function() {
        if (store && typeof store.close === 'function') store.close();
        StateStore._instance = null;
        delete global.getEnvVar;
    });

    it('isStatePath() returns false when homeDir is unknown', function() {
        assert.ok(!store.isStatePath('/any/path/main.json'));
    });

    it('write() returns false when homeDir is unknown', function() {
        assert.strictEqual(store.write('/any/path/main.json', {}), false);
    });

    it('read() returns null when homeDir is unknown', function() {
        assert.strictEqual(store.read('/any/path/main.json'), null);
    });

});


// ─── 04 — functional: write / read / persistence (requires node:sqlite) ───────

describe('04 - StateStore: write / read / persistence', function() {

    var StateStore;
    var tmpDir;
    var store;

    before(function() {
        if (!HAS_SQLITE) return; // skip setup on Node < 22.5.0

        StateStore = require(STATE_PATH);
        tmpDir = path.join(os.tmpdir(), 'gina-state-test-' + Date.now());
        fs.mkdirSync(tmpDir);
        fs.mkdirSync(path.join(tmpDir, '0.1'));

        global.getEnvVar = function(k) {
            if (k === 'GINA_HOMEDIR') return tmpDir;
            return undefined;
        };
        StateStore._instance = null;
        store = StateStore.getInstance();
    });

    after(function() {
        if (!HAS_SQLITE) return;
        if (store && typeof store.close === 'function') store.close();
        StateStore._instance = null;
        delete global.getEnvVar;
        try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
    });

    it('write() returns true for a known state path', function() {
        if (!HAS_SQLITE) { return; }
        var ok = store.write(path.join(tmpDir, 'main.json'), { version: '0.1' });
        assert.strictEqual(ok, true);
    });

    it('creates gina.db alongside the state files', function() {
        if (!HAS_SQLITE) { return; }
        assert.ok(fs.existsSync(path.join(tmpDir, 'gina.db')));
    });

    it('writes a JSON sidecar file for backwards-compat read paths', function() {
        if (!HAS_SQLITE) { return; }
        store.write(path.join(tmpDir, 'projects.json'), { myproject: { path: '/a' } });
        assert.ok(fs.existsSync(path.join(tmpDir, 'projects.json')));
        var sidecar = JSON.parse(fs.readFileSync(path.join(tmpDir, 'projects.json'), 'utf8'));
        assert.deepEqual(sidecar, { myproject: { path: '/a' } });
    });

    it('read() returns the data written to SQLite', function() {
        if (!HAS_SQLITE) { return; }
        var data = { test: true, num: 42, arr: [1, 2, 3] };
        store.write(path.join(tmpDir, 'ports.json'), data);
        var result = store.read(path.join(tmpDir, 'ports.json'));
        assert.deepEqual(result, data);
    });

    it('read() returns null for a key that has never been written', function() {
        if (!HAS_SQLITE) { return; }
        var result = store.read(path.join(tmpDir, 'ports.reverse.json'));
        assert.strictEqual(result, null);
    });

    it('handles the {shortVersion}/settings.json path pattern', function() {
        if (!HAS_SQLITE) { return; }
        var data = { env: 'development', scope: 'local', log_level: 'info' };
        var settingsPath = path.join(tmpDir, '0.1', 'settings.json');
        var ok = store.write(settingsPath, data);
        assert.strictEqual(ok, true);
        var result = store.read(settingsPath);
        assert.deepEqual(result, data);
    });

    it('write() upserts — second write overwrites the first', function() {
        if (!HAS_SQLITE) { return; }
        var p = path.join(tmpDir, 'main.json');
        store.write(p, { v: 1 });
        store.write(p, { v: 2 });
        var result = store.read(p);
        assert.equal(result.v, 2);
    });

    it('data persists after close() and getInstance() on a new store', function() {
        if (!HAS_SQLITE) { return; }
        var p = path.join(tmpDir, 'projects.json');
        store.write(p, { persist: true });
        store.close();

        StateStore._instance = null;
        var store2 = StateStore.getInstance();
        var result = store2.read(p);
        assert.ok(result && result.persist === true, 'data should survive close/reopen');

        store2.close();
        StateStore._instance = null;
        // restore store for the after() hook
        store = StateStore.getInstance();
    });

    it('write() returns false for a non-state path', function() {
        if (!HAS_SQLITE) { return; }
        var ok = store.write(path.join(tmpDir, 'env.json'), {});
        assert.strictEqual(ok, false);
    });

});


// ─── 05 — generator.createFileFromDataSync integration ───────────────────────

describe('05 - generator.createFileFromDataSync integration with StateStore', function() {

    var GENERATOR_PATH = path.join(FW, 'lib/generator/index.js');
    var StateStore;
    var generator;
    var tmpDir;

    before(function() {
        if (!HAS_SQLITE) return;

        StateStore = require(STATE_PATH);
        generator  = require(GENERATOR_PATH);

        tmpDir = path.join(os.tmpdir(), 'gina-gen-test-' + Date.now());
        fs.mkdirSync(tmpDir);

        global.getEnvVar = function(k) {
            if (k === 'GINA_HOMEDIR') return tmpDir;
            return undefined;
        };
        StateStore._instance = null;
    });

    after(function() {
        if (!HAS_SQLITE) return;
        var s = StateStore.getInstance();
        if (s && typeof s.close === 'function') s.close();
        StateStore._instance = null;
        delete global.getEnvVar;
        try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
    });

    it('routes a known state path through SQLite (gina.db is created)', function() {
        if (!HAS_SQLITE) { return; }
        generator.createFileFromDataSync({ routed: true }, path.join(tmpDir, 'main.json'));
        assert.ok(fs.existsSync(path.join(tmpDir, 'gina.db')));
    });

    it('state path: sidecar JSON is written with correct content', function() {
        if (!HAS_SQLITE) { return; }
        generator.createFileFromDataSync({ check: 'sidecar' }, path.join(tmpDir, 'projects.json'));
        var sidecar = JSON.parse(fs.readFileSync(path.join(tmpDir, 'projects.json'), 'utf8'));
        assert.equal(sidecar.check, 'sidecar');
    });

    it('non-state path: writes JSON directly without touching gina.db', function() {
        if (!HAS_SQLITE) { return; }
        // Get gina.db mtime before
        var dbPath = path.join(tmpDir, 'gina.db');
        var mtimeBefore = fs.statSync(dbPath).mtimeMs;

        generator.createFileFromDataSync({ direct: true }, path.join(tmpDir, 'app.json'));

        var mtimeAfter = fs.statSync(dbPath).mtimeMs;
        var appContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'app.json'), 'utf8'));

        assert.equal(appContent.direct, true);
        assert.equal(mtimeBefore, mtimeAfter, 'gina.db should not be touched for non-state writes');
    });

    it('source: createFileFromDataSync has #CN2v3 intercept comment', function() {
        var src = fs.readFileSync(GENERATOR_PATH, 'utf8');
        assert.ok(/#CN2v3/.test(src));
        assert.ok(/StateStore\|stateStore|require\('\.\.\/state'\)/.test(src) || /require\('\.\.\/state'\)/.test(src));
    });

});
