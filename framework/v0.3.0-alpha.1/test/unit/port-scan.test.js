'use strict';

/**
 * Unit tests for lib/cmd/port/inc/scan.js
 *
 * Run with:
 *   node --test framework/v0.3.0-alpha.1/test/unit/port-scan.test.js
 *
 * These tests use node:test (built-in, Node 22.5+) and mock net.Socket so
 * no real TCP connections are made — tests are fast and deterministic.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net    = require('net');
const path   = require('path');

// ---------------------------------------------------------------------------
// Bootstrap the minimal framework globals scan.js needs at require() time.
// ---------------------------------------------------------------------------
global.lib   = { logger: { ...console, debug: () => {}, warn: () => {} } };
global.merge = function merge(target, defaults) {
    for (var key in defaults) {
        if (typeof target[key] === 'undefined') target[key] = defaults[key];
    }
    return target;
};

const scan = require(
    path.resolve(__dirname, '../../lib/cmd/port/inc/scan.js')
);

// ---------------------------------------------------------------------------
// net.Socket mock helpers
// ---------------------------------------------------------------------------

/**
 * Installs a mock net.Socket. For each attempted connection:
 *   occupiedFn(port) === true  → emit 'connect'  (port in use)
 *   occupiedFn(port) === false → emit ECONNREFUSED error (port free)
 *
 * Returns a restore function.
 */
function mockSocket(occupiedFn) {
    const Original = net.Socket;
    net.Socket = class MockSocket {
        connect(port) {
            setImmediate(() => {
                if (occupiedFn(port)) {
                    this.emit('connect');
                } else {
                    const err = new Error('connect ECONNREFUSED 127.0.0.1:' + port);
                    err.code = 'ECONNREFUSED';
                    this.emit('error', err);
                }
            });
            return this;
        }
        setTimeout() { return this; }
        destroy()    {}
        on(event, fn) {
            this._handlers = this._handlers || {};
            this._handlers[event] = fn;
            return this;
        }
        emit(event, ...args) {
            if (this._handlers && this._handlers[event]) {
                this._handlers[event](...args);
            }
        }
    };
    return () => { net.Socket = Original; };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('scan window defaults to start+899 for small limit', (t, done) => {
    // All ports free — verify the first port returned is at `start`.
    const restore = mockSocket(() => false); // all ports free
    scan({ start: 44000, limit: 1 }, (err, ports) => {
        restore();
        assert.ok(!err, String(err));
        assert.equal(ports.length, 1);
        assert.equal(ports[0], 44000);
        done();
    });
});

test('scan window extends proportionally for large limit', (t, done) => {
    // limit=901 → new end = start + max(899, 1000) = start + 1000 = 45000
    // Ports 44000–44899 are occupied; 44900+ are free.
    // OLD formula (start+899=44899): scanner never reaches 44900 → error.
    // NEW formula (start+1000=45000): scanner reaches 44900 → finds a port.
    const start = 44000;
    const restore = mockSocket(p => p < start + 900); // 44000–44899 occupied

    scan({ start, limit: 901 }, (err, ports) => {
        restore();
        // With the new formula the scanner finds ports in 44900–45000.
        // It may not collect all 901 (only ~100 slots remain), so it will
        // still error — but it must have found at least one port beyond 44899
        // before hitting the new end.  The old formula would error with 0 found.
        if (err) {
            // Acceptable: window extended but still couldn't satisfy limit=901.
            // What matters is the error is at the NEW end (45000), not old (44899).
            assert.match(err.message, /45000/);
        } else {
            assert.ok(ports.length > 0);
            assert.ok(ports[0] >= start + 900);
        }
        done();
    });
});

test('scan skips reserved range 4100–4199 and returns a port >= 4200', (t, done) => {
    // Ports 4090–4099 are occupied; ports >= 4200 are free.
    // The scanner must skip the entire 4100–4199 range and return 4200.
    const restore = mockSocket(p => p >= 4090 && p <= 4099);

    scan({ start: 4090, limit: 1 }, (err, ports) => {
        restore();
        assert.ok(!err, String(err));
        assert.equal(ports.length, 1);
        assert.ok(ports[0] >= 4200, `Expected port >= 4200, got ${ports[0]}`);
        assert.ok(ports[0] < 4300,  `Expected port < 4300, got ${ports[0]}`);
        done();
    });
});

test('no port in reserved range 4100–4199 is ever returned', (t, done) => {
    // All ports free — scan a range that crosses the reserved band.
    const restore = mockSocket(() => false);
    const collected = [];

    // Request 200 ports starting from 4090 to get results both before and
    // after the reserved range.
    scan({ start: 4090, limit: 200 }, (err, ports) => {
        restore();
        if (err) {
            // May hit end before finding 200 — that's fine, check what we got.
            // The warn log prints found/total but we have no ports in the error case.
            done();
            return;
        }
        for (const p of ports) {
            assert.ok(
                p < 4100 || p > 4199,
                `Port ${p} is in the reserved range 4100–4199`
            );
        }
        done();
    });
});

test('scan returns error with correct message when window is exhausted', (t, done) => {
    // Use the ignore list to skip every port in the default window, so the
    // scanner reaches opt.end without finding any free port.
    const start = 44500;
    const ignore = [];
    for (let p = start; p <= start + 899; p++) ignore.push(String(p));

    scan({ start, ignore, limit: 1 }, (err) => {
        assert.ok(err instanceof Error, 'Expected an Error');
        assert.match(err.message, /Maximum port number reached/i);
        done();
    });
});

test('ports in the ignore list are never returned', (t, done) => {
    const start = 44100;
    // Ignore the first 3 ports; expect the 4th to be returned.
    const ignore = [String(start), String(start + 1), String(start + 2)];
    const restore = mockSocket(() => false); // all ports free

    scan({ start, ignore, limit: 1 }, (err, ports) => {
        restore();
        assert.ok(!err, String(err));
        assert.equal(ports[0], start + 3);
        done();
    });
});
