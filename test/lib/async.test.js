/**
 * lib/async — onCompleteCall Promise adapter (#M4)
 *
 * Tests the Promise wrapper for EventEmitter-based .onComplete(cb) callbacks.
 */

'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');

var onCompleteCall = require(path.join(require('../fw'), 'lib/async/src/main'));


// ─── 01 — Basic contract ────────────────────────────────────────────────────

describe('01 - onCompleteCall basic contract (#M4)', function() {

    it('exports a function', function() {
        assert.equal(typeof onCompleteCall, 'function');
    });

    it('returns a Promise', function() {
        var emitter = { onComplete: function() {} };
        var result = onCompleteCall(emitter);
        assert.ok(result instanceof Promise);
    });

});


// ─── 02 — Resolve / Reject ──────────────────────────────────────────────────

describe('02 - onCompleteCall resolve and reject (#M4)', function() {

    it('resolves with the result on success', async function() {
        var emitter = {
            onComplete: function(cb) { cb(null, 'hello'); }
        };
        var result = await onCompleteCall(emitter);
        assert.equal(result, 'hello');
    });

    it('resolves with undefined when result is undefined', async function() {
        var emitter = {
            onComplete: function(cb) { cb(null); }
        };
        var result = await onCompleteCall(emitter);
        assert.equal(result, undefined);
    });

    it('resolves with null when result is null', async function() {
        var emitter = {
            onComplete: function(cb) { cb(null, null); }
        };
        var result = await onCompleteCall(emitter);
        assert.equal(result, null);
    });

    it('resolves with an object', async function() {
        var emitter = {
            onComplete: function(cb) { cb(null, { count: 42 }); }
        };
        var result = await onCompleteCall(emitter);
        assert.deepEqual(result, { count: 42 });
    });

    it('rejects with the error on failure', async function() {
        var emitter = {
            onComplete: function(cb) { cb(new Error('disk full')); }
        };
        await assert.rejects(
            onCompleteCall(emitter),
            { message: 'disk full' }
        );
    });

    it('rejects with a string error', async function() {
        var emitter = {
            onComplete: function(cb) { cb('something went wrong'); }
        };
        await assert.rejects(
            onCompleteCall(emitter),
            function(err) { return err === 'something went wrong'; }
        );
    });

    it('rejects with false sentinel (entity convention: false is success)', async function() {
        // Entity callbacks use `callback(false, data)` for success.
        // false is falsy, so onCompleteCall should resolve, not reject.
        var emitter = {
            onComplete: function(cb) { cb(false, 'data'); }
        };
        var result = await onCompleteCall(emitter);
        assert.equal(result, 'data');
    });

});


// ─── 03 — Input validation ──────────────────────────────────────────────────

describe('03 - onCompleteCall input validation (#M4)', function() {

    it('throws TypeError for null emitter', function() {
        assert.throws(
            function() { onCompleteCall(null); },
            { name: 'TypeError' }
        );
    });

    it('throws TypeError for undefined emitter', function() {
        assert.throws(
            function() { onCompleteCall(undefined); },
            { name: 'TypeError' }
        );
    });

    it('throws TypeError for emitter without onComplete method', function() {
        assert.throws(
            function() { onCompleteCall({}); },
            { name: 'TypeError' }
        );
    });

    it('throws TypeError for non-object emitter', function() {
        assert.throws(
            function() { onCompleteCall('string'); },
            { name: 'TypeError' }
        );
    });

});


// ─── 04 — Async callback timing ─────────────────────────────────────────────

describe('04 - onCompleteCall with delayed callbacks (#M4)', function() {

    it('resolves when callback fires asynchronously', async function() {
        var emitter = {
            onComplete: function(cb) {
                setTimeout(function() { cb(null, 'delayed'); }, 10);
            }
        };
        var result = await onCompleteCall(emitter);
        assert.equal(result, 'delayed');
    });

    it('rejects when error fires asynchronously', async function() {
        var emitter = {
            onComplete: function(cb) {
                setTimeout(function() { cb(new Error('timeout')); }, 10);
            }
        };
        await assert.rejects(
            onCompleteCall(emitter),
            { message: 'timeout' }
        );
    });

});


// ─── 05 — lib.async registration ────────────────────────────────────────────

describe('05 - lib/async registered in lib/index.js (#M4)', function() {

    it('lib/index.js contains async registration line', function() {
        var fs = require('fs');
        var libIndex = fs.readFileSync(path.join(require('../fw'), 'lib/index.js'), 'utf8');
        assert.ok(
            libIndex.indexOf("async") > -1 && libIndex.indexOf("_require('./async')") > -1,
            'expected lib/index.js to register async via _require(\'./async\')'
        );
    });

});
