'use strict';
/**
 * lib/logger — what a writer outside emit() needs to mask its own text with the
 * logger's rules (the stall watchdog's thread writes its line itself, while the
 * main thread is blocked):
 *
 *   §01 getRedactionState() returns the compiled union setRedaction() built,
 *       or null when redaction is off.
 *   §02 setRedaction() emits the process event `logger#redaction` after each
 *       change, the state already updated when a listener runs.
 *   §03 the real compiled state (the built-in rules + a block pattern + a
 *       resolved secret) survives structuredClone — the copy a worker thread
 *       receives — and masks exactly as the original does.
 *
 * Run: node --test test/lib/logger-redaction-event.test.js
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');

var FRAMEWORK  = path.resolve(require('../fw'));
var MAIN_SRC   = path.join(FRAMEWORK, 'lib/logger/src/main.js');
var REDACT_SRC = path.join(FRAMEWORK, 'lib/logger/src/redact.js');

var SECRET = 'correct-horse-battery-staple';

describe('lib/logger — the redaction state for writers outside emit()', function() {
    var logger, redact;

    before(function() {
        // strip the mq flow BEFORE the module-level init dials it (the suite's convention)
        process.env.GINA_LOG_STDOUT = 'true';
        logger = require(MAIN_SRC);
        redact = require(REDACT_SRC);
    });
    after(function() {
        try { logger.setRedaction({ enabled: false }, { group: 'event-test@app' }); } catch (e) { /* best effort */ }
        delete process.env.GINA_LOG_STDOUT;
    });

    it('01.01 - getRedactionState() is a function of the logger', function() {
        assert.equal(typeof(logger.getRedactionState), 'function');
    });

    it('02.01 - setRedaction() emits logger#redaction once, after the state is updated', function() {
        var seen = [];
        var listener = function() { seen.push(logger.getRedactionState()); };
        process.on('logger#redaction', listener);
        try {
            logger.setRedaction({ patterns: ['tok_[a-z0-9]{8}'] }, { group: 'event-test@app', secrets: [{ path: 'db.password', value: SECRET }] });
        } finally {
            process.removeListener('logger#redaction', listener);
        }
        assert.equal(seen.length, 1, 'one event per setRedaction() call');
        assert.ok(seen[0], 'the listener already sees the new state');
        assert.equal(seen[0].secretCount, 1);
    });

    it('01.02 - getRedactionState() returns the compiled union that masks a line', function() {
        var state = logger.getRedactionState();
        assert.ok(state && Array.isArray(state.rules) && state.rules.length > 0);
        var masked = redact.apply(state, 'GET /a/tok_abcd1234/b?p=' + SECRET);
        assert.equal(masked.indexOf('tok_abcd1234'), -1, 'the block pattern masks');
        assert.equal(masked.indexOf(SECRET), -1, 'the resolved secret masks');
        assert.ok(masked.indexOf(redact.MARKER) > -1);
    });

    it('03.01 - the real state survives structuredClone and masks exactly as the original', function() {
        var state = logger.getRedactionState();
        var copy  = structuredClone(state);
        var lines = [
            'PUT /orders/42?token=abcdefghijklmnop',
            'GET /s/' + SECRET,
            'GET /a/tok_abcd1234/b',
            'Authorization: Bearer abc.def.ghi'
        ];
        lines.forEach(function(line) {
            assert.equal(redact.apply(copy, line), redact.apply(state, line), 'the copy masks like the original: ' + line);
        });
        assert.notEqual(redact.apply(copy, lines[1]), lines[1], 'the copy does mask (a control that can fail)');
    });

    it('01.03 - getRedactionState() is null once every contribution is off', function() {
        var seen = 0;
        var listener = function() { seen++; };
        process.on('logger#redaction', listener);
        try {
            logger.setRedaction({ enabled: false }, { group: 'event-test@app' });
        } finally {
            process.removeListener('logger#redaction', listener);
        }
        assert.equal(seen, 1, 'turning redaction off is a change too');
        var state = logger.getRedactionState();
        // another file's contribution could keep it on in a shared process: assert only what this file controls
        if ( state ) {
            assert.equal(redact.apply(state, 'GET /a/tok_abcd1234/b').indexOf('tok_abcd1234') > -1, true, 'this file\'s pattern is gone');
        } else {
            assert.equal(state, null);
        }
    });
});
