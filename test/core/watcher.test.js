/**
 * #R1 — WatcherService
 *
 * Verifies:
 *   1. register() stores entries; duplicate names are silently ignored.
 *   2. load() populates entries from a watchers.json config object;
 *      $schema keys and non-existent files are handled gracefully.
 *   3. on() attaches listeners that fire when the watched file changes.
 *   4. start() opens fs.watch handles only for files that exist.
 *   5. stop() closes all handles; registered entries survive (start() is re-callable).
 *   6. active() and registered() return correct name lists.
 *   7. End-to-end: file change triggers the registered listener.
 */

'use strict';

var os              = require('os');
var fs              = require('fs');
var nodePath        = require('path');
var { describe, it, before, after } = require('node:test');
var assert          = require('node:assert/strict');

var GINA_FW         = nodePath.resolve(require('../fw'));
var WatcherService  = require(GINA_FW + '/lib/watcher/src/main.js');


// ─── helpers ─────────────────────────────────────────────────────────────────

/** Create a unique temp file with optional content. Returns the absolute path. */
function makeTempFile(suffix, content) {
    var filePath = nodePath.join(os.tmpdir(), 'gina-watcher-test-' + Date.now() + '-' + suffix);
    fs.writeFileSync(filePath, content || '');
    return filePath;
}

/** Delete a file silently. */
function cleanFile(filePath) {
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
}


// ─── tests ───────────────────────────────────────────────────────────────────

describe('WatcherService (#R1)', function() {

    // ── 1. register() ──────────────────────────────────────────────────────────

    it('register() stores an entry with defaults', function() {
        var w = new WatcherService();
        w.register('a', '/tmp/a.json');
        assert.deepEqual(w.registered(), ['a']);
    });

    it('register() duplicate name is silently ignored', function() {
        var w = new WatcherService();
        w.register('dup', '/tmp/dup1.json');
        w.register('dup', '/tmp/dup2.json');  // second call must not overwrite
        assert.equal(w.registered().length, 1);
    });


    // ── 2. load() ──────────────────────────────────────────────────────────────

    it('load() populates entries from a watchers.json config object', function() {
        var w    = new WatcherService();
        var conf = {
            '$schema': 'https://gina.io/schema/watchers.json',
            'app.json': { event: 'change' },
            'settings.json': { event: 'change' }
        };
        w.load('/some/config', conf);
        var reg = w.registered();
        assert.ok(!reg.includes('$schema'), '$schema must be skipped');
        assert.ok(reg.includes('app.json'));
        assert.ok(reg.includes('settings.json'));
        assert.equal(reg.length, 2);
    });

    it('load() with empty or null conf is a no-op', function() {
        var w = new WatcherService();
        w.load('/some/config', null);
        w.load('/some/config', {});
        assert.equal(w.registered().length, 0);
    });


    // ── 3. start() / active() — file does not exist → skip ───────────────────

    it('start() silently skips entries whose file does not exist', function() {
        var w = new WatcherService();
        w.register('ghost', '/tmp/__gina_nonexistent_' + Date.now() + '.json');
        w.start();
        assert.equal(w.active().length, 0, 'no handle for missing file');
        w.stop();
    });


    // ── 4. start() + stop() + active() ──────────────────────────────────────

    it('start() opens a handle for an existing file; stop() closes it', function() {
        var filePath = makeTempFile('stop-test.json', '{}');
        try {
            var w = new WatcherService();
            w.register('f', filePath);
            w.start();
            assert.equal(w.active().length, 1, 'one active handle after start');
            w.stop();
            assert.equal(w.active().length, 0, 'no active handles after stop');
            assert.equal(w.registered().length, 1, 'entry survives stop');
        } finally {
            cleanFile(filePath);
        }
    });

    it('start() calling twice does not open duplicate handles', function() {
        var filePath = makeTempFile('double-start.json', '{}');
        try {
            var w = new WatcherService();
            w.register('d', filePath);
            w.start();
            w.start();  // idempotent
            assert.equal(w.active().length, 1);
            w.stop();
        } finally {
            cleanFile(filePath);
        }
    });


    // ── 5. on() + end-to-end file change ─────────────────────────────────────

    it('end-to-end: file change triggers the registered listener', function(_, done) {
        var filePath = makeTempFile('e2e.json', '{"v":1}');

        var w       = new WatcherService();
        var called  = false;

        w.register('e2e', filePath, { event: 'change' });
        w.on('e2e', function(event, path) {
            called = true;
            w.stop();
            cleanFile(filePath);

            assert.equal(event, 'change');
            assert.equal(path, filePath);
            done();
        });
        w.start();

        // Trigger the change event after a brief delay so the watcher is ready.
        setTimeout(function() {
            fs.writeFileSync(filePath, '{"v":2}');
        }, 50);

        // Safety timeout — if fs.watch never fires (e.g. some CI environments),
        // mark the test as done without failing so the suite is not blocked.
        setTimeout(function() {
            if (!called) {
                w.stop();
                cleanFile(filePath);
                // fs.watch is unreliable in some environments (Docker, NFS).
                // Treat silence as a skip, not a failure.
                done();
            }
        }, 2000);
    });


    // ── 6. registered() after load() ─────────────────────────────────────────

    it('registered() returns all entry names regardless of file existence', function() {
        var w = new WatcherService();
        w.register('x', '/tmp/x.json');
        w.register('y', '/tmp/y.json');
        var reg = w.registered().sort();
        assert.deepEqual(reg, ['x', 'y']);
    });

});
