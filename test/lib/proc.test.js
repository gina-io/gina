var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var PROC_SOURCE   = path.join(require('../fw'), 'lib/proc.js');
var SERVER_SOURCE = path.join(require('../fw'), 'core/server.js');


// ---------------------------------------------------------------------------
// Replica of the process.server assignment logic from server.js.
// In production, self.instance.listen() is called with a real port.
// Here we inject a stub so the logic can be exercised without a network.
// ---------------------------------------------------------------------------
function assignProcessServer(selfInstance) {
    var _rawServer = selfInstance.listen(0);
    return (_rawServer && typeof _rawServer.close === 'function') ? _rawServer : selfInstance;
}

// ---------------------------------------------------------------------------
// Replica of the SIGTERM shutdown sequence from proc.js.
// proc and env are injected so the logic can be tested without signals.
// ---------------------------------------------------------------------------
function runShutdown(proc, shutdownMs, done) {
    var _httpServer = proc.server || null;
    if (_httpServer && typeof _httpServer.close === 'function') {
        var _shutdownTimer = setTimeout(function() {
            proc.exit(143);
            done('timeout');
        }, shutdownMs);
        if (typeof _shutdownTimer.unref === 'function') _shutdownTimer.unref();
        if (typeof _httpServer.closeIdleConnections === 'function') {
            _httpServer.closeIdleConnections();
        }
        _httpServer.close(function() {
            clearTimeout(_shutdownTimer);
            proc.exit(143);
            done(null);
        });
    } else {
        proc.exit(143);
        done(null);
    }
}


// ---------------------------------------------------------------------------
// 01 — Source: server.js — process.server assigned from listen() return value
// ---------------------------------------------------------------------------
describe('01 - graceful shutdown: process.server wired in server.js', function() {

    it('listen() return value is captured into _rawServer', function() {
        var src = fs.readFileSync(SERVER_SOURCE, 'utf8');
        assert.ok(
            /var _rawServer\s*=\s*self\.instance\.listen\(/.test(src),
            'expected `var _rawServer = self.instance.listen(...)` in server.js'
        );
    });

    it('process.server is assigned from _rawServer', function() {
        var src = fs.readFileSync(SERVER_SOURCE, 'utf8');
        assert.ok(
            /process\.server\s*=\s*\(_rawServer\s*&&\s*typeof _rawServer\.close/.test(src),
            'expected `process.server = (_rawServer && typeof _rawServer.close === \'function\') ? ...` in server.js'
        );
    });

    it('process.server assignment falls back to self.instance', function() {
        var src = fs.readFileSync(SERVER_SOURCE, 'utf8');
        assert.ok(
            /\?\s*_rawServer\s*:\s*self\.instance/.test(src),
            'expected ternary fallback to self.instance in server.js'
        );
    });

});


// ---------------------------------------------------------------------------
// 02 — Source: proc.js — SIGTERM handler structure
// ---------------------------------------------------------------------------
describe('02 - graceful shutdown: SIGTERM handler structure in proc.js', function() {

    it('SIGTERM handler reads proc.server', function() {
        var src = fs.readFileSync(PROC_SOURCE, 'utf8');
        assert.ok(
            /proc\.on\('SIGTERM'[\s\S]*?proc\.server/.test(src),
            'expected proc.server referenced inside SIGTERM handler'
        );
    });

    it('server.close() is called with a callback', function() {
        var src = fs.readFileSync(PROC_SOURCE, 'utf8');
        assert.ok(
            /_httpServer\.close\(function\(\)/.test(src),
            'expected `_httpServer.close(function() {...})` in SIGTERM handler'
        );
    });

    it('hard timeout references GINA_SHUTDOWN_TIMEOUT env var', function() {
        var src = fs.readFileSync(PROC_SOURCE, 'utf8');
        assert.ok(
            /GINA_SHUTDOWN_TIMEOUT/.test(src),
            'expected GINA_SHUTDOWN_TIMEOUT env var in SIGTERM handler'
        );
    });

    it('hard timeout defaults to 10 000 ms', function() {
        var src = fs.readFileSync(PROC_SOURCE, 'utf8');
        assert.ok(
            /\|\|\s*10000/.test(src),
            'expected `|| 10000` default for shutdown timeout'
        );
    });

    it('closeIdleConnections() is guarded by typeof check', function() {
        var src = fs.readFileSync(PROC_SOURCE, 'utf8');
        assert.ok(
            /typeof _httpServer\.closeIdleConnections\s*===\s*'function'/.test(src),
            'expected typeof guard before closeIdleConnections() call'
        );
    });

    it('shutdown timer is unref()d', function() {
        var src = fs.readFileSync(PROC_SOURCE, 'utf8');
        assert.ok(
            /_shutdownTimer\.unref/.test(src),
            'expected _shutdownTimer.unref() so the timer does not block natural exit'
        );
    });

    it('fallback immediate exit present when proc.server is absent', function() {
        var src = fs.readFileSync(PROC_SOURCE, 'utf8');
        // The else branch must contain proc.exit(143)
        var sigtermBlock = src.slice(src.indexOf("proc.on('SIGTERM'"));
        sigtermBlock = sigtermBlock.slice(0, sigtermBlock.indexOf("proc.on('SIGABRT'"));
        assert.ok(
            /\}\s*else\s*\{[^}]*proc\.exit\(143\)/.test(sigtermBlock),
            'expected else branch with proc.exit(143) when proc.server is absent'
        );
    });

});


// ---------------------------------------------------------------------------
// 03 — Logic: process.server assignment (isolated, no network)
// ---------------------------------------------------------------------------
describe('03 - graceful shutdown: process.server assignment logic', function() {

    it('uses _rawServer when listen() returns an object with close()', function() {
        var rawServer = { close: function() {} };
        var instance  = { listen: function() { return rawServer; } };
        var result = assignProcessServer(instance);
        assert.strictEqual(result, rawServer,
            'process.server should be the raw server returned by listen()'
        );
    });

    it('falls back to self.instance when listen() returns null', function() {
        var instance = { listen: function() { return null; } };
        var result = assignProcessServer(instance);
        assert.strictEqual(result, instance,
            'process.server should fall back to self.instance when listen() returns null'
        );
    });

    it('falls back to self.instance when listen() returns object without close()', function() {
        var instance = { listen: function() { return {}; } };
        var result = assignProcessServer(instance);
        assert.strictEqual(result, instance,
            'process.server should fall back to self.instance when raw server has no close()'
        );
    });

    it('falls back to self.instance when listen() returns undefined', function() {
        var instance = { listen: function() { return undefined; } };
        var result = assignProcessServer(instance);
        assert.strictEqual(result, instance,
            'process.server should fall back to self.instance when listen() returns undefined'
        );
    });

});


// ---------------------------------------------------------------------------
// 04 — Logic: shutdown sequence (isolated, mock server, no signals)
// ---------------------------------------------------------------------------
describe('04 - graceful shutdown: shutdown sequence logic', function() {

    it('server.close() callback triggers exit(143)', function(_, done) {
        var exitCode = null;
        var proc = {
            server: { close: function(cb) { cb(); } },
            exit:   function(code) { exitCode = code; }
        };
        runShutdown(proc, 5000, function(reason) {
            assert.equal(reason, null,        'should drain cleanly, not time out');
            assert.equal(exitCode, 143,       'exit code must be 143 (128 + SIGTERM)');
            done();
        });
    });

    it('closeIdleConnections() is called when available', function(_, done) {
        var idleClosed = false;
        var proc = {
            server: {
                close:               function(cb) { cb(); },
                closeIdleConnections: function() { idleClosed = true; }
            },
            exit: function() {}
        };
        runShutdown(proc, 5000, function() {
            assert.ok(idleClosed, 'closeIdleConnections() must be called when present');
            done();
        });
    });

    it('closeIdleConnections() is skipped without throwing when absent', function(_, done) {
        var closed = false;
        var proc = {
            server: { close: function(cb) { closed = true; cb(); } },
            exit:   function() {}
        };
        assert.doesNotThrow(function() {
            runShutdown(proc, 5000, function() {
                assert.ok(closed, 'close() must still be called');
                done();
            });
        });
    });

    it('exits immediately when proc.server is null', function() {
        var exitCode = null;
        var proc = {
            server: null,
            exit:   function(code) { exitCode = code; }
        };
        runShutdown(proc, 5000, function() {});
        assert.equal(exitCode, 143, 'must exit immediately with 143 when server is absent');
    });

    it('exits immediately when proc.server has no close() method', function() {
        var exitCode = null;
        var proc = {
            server: { noClose: true },
            exit:   function(code) { exitCode = code; }
        };
        runShutdown(proc, 5000, function() {});
        assert.equal(exitCode, 143, 'must exit immediately with 143 when server lacks close()');
    });

    it('hard timeout fires if close() never calls its callback', function(_, done) {
        var exitCode = null;
        var proc = {
            server: { close: function(_cb) { /* never calls cb */ } },
            exit:   function(code) { exitCode = code; }
        };
        // Use a 50ms timeout so the test does not take 10s
        runShutdown(proc, 50, function(reason) {
            assert.equal(reason,    'timeout', 'shutdown path must be the hard timeout');
            assert.equal(exitCode,  143,        'exit code must be 143 on timeout');
            done();
        });
    });

});
