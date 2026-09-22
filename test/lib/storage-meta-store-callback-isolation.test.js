/**
 * storage-meta-store-callback-isolation.test.js — #B565 (a).
 *
 * The metadata store must NEVER invoke the caller's callback from inside its
 * own `try`. Doing so has two consequences, both of which this file pins:
 *
 *   1. the application's own throw is SWALLOWED by the store's `catch`, so an
 *      error the caller raised never reaches the caller; and
 *   2. the `catch` then calls the callback a SECOND time with the
 *      application's error dressed as a store error — so a caller that
 *      latches (as `local-cas.js verify()` does) silently never completes,
 *      and the operation HANGS.
 *
 * `get()` already had the correct shape — its `try` wraps only the SQLite
 * call — and rides along as the positive control.
 *
 * Red-first: every `throws` assertion below fails, and every "exactly once"
 * assertion reads 2, against the pre-#B565 source.
 */

var fs       = require('fs');
var os       = require('os');
var nodePath = require('path');
var { describe, it, after } = require('node:test');
var assert   = require('node:assert/strict');

var FW      = require('../fw');
var storage = require(nodePath.join(FW, 'lib', 'storage', 'src', 'main.js'));

var roots = [];
after(function () {
    roots.forEach(function (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
});

function freshStore() {
    var root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'gina-b565-'));
    roots.push(root);
    return storage._createEmbeddedMetaStore(nodePath.join(root, '.meta.db'));
}

/**
 * Drive `invoke` with a callback that throws on its FIRST invocation only —
 * the shape of a real assertion failure, which fires on the success path and
 * not on a retry. Returns the recorded invocations.
 */
function driveThrowingOnce(invoke) {
    var calls = [];
    var cb = function (err) {
        calls.push(err ? 'err:' + err.message : 'ok');
        if (calls.length === 1) { throw new Error('APP-THROW'); }
    };
    return { calls: calls, run: function () { invoke(cb); } };
}

var CASES = [
    { name: 'set',          invoke: function (s, cb) { s.set('k', { size: 1 }, cb); } },
    { name: 'remove',       invoke: function (s, cb) { s.remove('k', cb); } },
    { name: 'acquireRef',   invoke: function (s, cb) { s.acquireRef('k', { size: 1 }, cb); } },
    { name: 'releaseRef',   invoke: function (s, cb) { s.releaseRef('k', cb); } },
    { name: 'listZeroRefs', invoke: function (s, cb) { s.listZeroRefs(Date.now(), 10, cb); } },
    { name: 'removeIfZero', invoke: function (s, cb) { s.removeIfZero('k', cb); } },
    { name: 'listKeys',     invoke: function (s, cb) { s.listKeys('', 10, cb); } },
    { name: 'get',          invoke: function (s, cb) { s.get('k', cb); } }   // control — already correct
];

describe('01 - a throwing callback escapes the store, and is never re-entered', function () {

    CASES.forEach(function (c) {
        it(c.name + '(): the application throw propagates to the caller', function () {
            var store = freshStore();
            var d = driveThrowingOnce(function (cb) { c.invoke(store, cb); });
            assert.throws(d.run, /APP-THROW/,
                c.name + '() swallowed the callback throw — it is calling fn() inside its own try');
        });

        it(c.name + '(): the callback is invoked EXACTLY ONCE', function () {
            var store = freshStore();
            var d = driveThrowingOnce(function (cb) { c.invoke(store, cb); });
            try { d.run(); } catch (e) { /* expected — pinned above */ }
            assert.equal(d.calls.length, 1,
                c.name + '() re-entered the callback (got ' + JSON.stringify(d.calls) + ')');
            assert.equal(d.calls[0], 'ok', 'the single invocation is the success path');
        });
    });
});

describe('02 - a REAL store error still reaches the callback (no regression)', function () {
    it('a closed store surfaces its error through fn(err), not a throw', function () {
        var store = freshStore();
        store.close();
        var seen = null;
        store.set('k', { size: 1 }, function (err) { seen = err; });
        assert.ok(seen instanceof Error, 'the store error must still arrive as fn(err)');
    });
});
