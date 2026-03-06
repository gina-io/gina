var { describe, it, before, after } = require('node:test');
var assert  = require('node:assert/strict');
var net     = require('net');
var http    = require('http');
var fs      = require('fs');
var os      = require('os');
var path    = require('path');
var { execSync } = require('child_process');

// Test project config — must match what was created with:
//   gina project:add @fw-test --path=/tmp/fw-test-project
//   gina bundle:add testbundle @fw-test
var TEST_PROJECT     = 'fw-test';
var TEST_BUNDLE      = 'testbundle';
var TEST_PROJECT_DIR = '/tmp/fw-test-project';
var GINA_SOCKET_PORT = 8124;
var POLL_TIMEOUT_MS  = 20000;   // 20 s max for bundle to start
var POLL_INTERVAL_MS = 300;

var GINA_BIN = path.resolve(__dirname, '../../bin/gina');

// State
var bundlePort    = null;
var bundleStarted = false;
var shouldSkip    = false;
var skipReason    = '';


// --- helpers ---

function isTcpPortOpen(port) {
    return new Promise(function(resolve) {
        var sock = new net.Socket();
        sock.setTimeout(800);
        sock.on('connect', function() { sock.destroy(); resolve(true); });
        sock.on('error',   function() { resolve(false); });
        sock.on('timeout', function() { sock.destroy(); resolve(false); });
        sock.connect(port, '127.0.0.1');
    });
}

function waitForPort(port, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    return new Promise(function(resolve) {
        (function poll() {
            isTcpPortOpen(port).then(function(open) {
                if (open) return resolve(true);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(poll, POLL_INTERVAL_MS);
            });
        })();
    });
}

function httpGet(url) {
    return new Promise(function(resolve, reject) {
        http.get(url, function(res) {
            res.resume();
            resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '' });
        }).on('error', reject);
    });
}

// Look up a bundle's HTTP port in ~/.gina/ports.json.
// Format: { "http/1.1": { "http": { "PORT": "bundle@project/env" } } }
function getBundlePort(project, bundle, env) {
    var portsFile = path.join(os.homedir(), '.gina', 'ports.json');
    if (!fs.existsSync(portsFile)) return null;
    try {
        var ports  = JSON.parse(fs.readFileSync(portsFile, 'utf8'));
        var target = bundle + '@' + project + '/' + (env || 'dev');
        var proto  = ports['http/1.1'];
        if (!proto || !proto.http) return null;
        var httpMap = proto.http;
        for (var p in httpMap) {
            if (httpMap[p] === target) return parseInt(p, 10);
        }
    } catch (e) { /* ignore */ }
    return null;
}

function ginaCmdSync(args) {
    execSync(GINA_BIN + ' ' + args, { stdio: 'pipe' });
}


// --- suite ---

describe('16 - bundle startup — async render pipeline (P28-P31)', function() {

    before(async function() {

        // Skip if gina socket server is not running
        var ginaRunning = await isTcpPortOpen(GINA_SOCKET_PORT);
        if (!ginaRunning) {
            shouldSkip = true;
            skipReason = 'gina socket (port ' + GINA_SOCKET_PORT + ') is not running';
            return;
        }

        // Skip if test project was not set up
        // Create it first with: gina project:add @fw-test --path=/tmp/fw-test-project
        //                        gina bundle:add testbundle @fw-test
        if (!fs.existsSync(TEST_PROJECT_DIR)) {
            shouldSkip = true;
            skipReason = 'test project not found at ' + TEST_PROJECT_DIR;
            return;
        }

        // Find the bundle's HTTP port
        bundlePort = getBundlePort(TEST_PROJECT, TEST_BUNDLE);
        if (!bundlePort) {
            shouldSkip = true;
            skipReason = TEST_BUNDLE + '@' + TEST_PROJECT + '/dev not found in ~/.gina/ports.json';
            return;
        }

        // Stop bundle first in case it is already running from a previous failed test
        try { ginaCmdSync('bundle:stop ' + TEST_BUNDLE + ' @' + TEST_PROJECT); } catch (e) { /* ignore */ }

        // Start the bundle (daemonised — returns once acknowledged)
        ginaCmdSync('bundle:start ' + TEST_BUNDLE + ' @' + TEST_PROJECT);
        bundleStarted = true;

    });

    after(function() {
        if (bundleStarted) {
            try { ginaCmdSync('bundle:stop ' + TEST_BUNDLE + ' @' + TEST_PROJECT); } catch (e) { /* ignore */ }
            bundleStarted = false;
        }
    });


    it('bundle HTTP port opens within 20 s', { timeout: POLL_TIMEOUT_MS + 2000 }, async function(t) {
        if (shouldSkip) { t.skip(skipReason); return; }
        assert.ok(bundlePort, 'bundle port not found in ports.json — project may not be set up');
        var opened = await waitForPort(bundlePort, POLL_TIMEOUT_MS);
        assert.ok(opened, 'bundle port ' + bundlePort + ' did not open within ' + POLL_TIMEOUT_MS + ' ms — async render may have crashed on startup');
    });

    it('HTTP GET returns a response (server alive, render did not crash)', { timeout: 5000 }, async function(t) {
        if (shouldSkip) { t.skip(skipReason); return; }
        assert.ok(bundlePort, 'bundle port not found');
        var result = await httpGet('http://127.0.0.1:' + bundlePort + '/');
        // Any HTTP response proves the server is alive and handled the request.
        // A crash in the async render pipeline would cause no response / ECONNREFUSED.
        assert.ok(
            result.status >= 100 && result.status < 600,
            'expected a valid HTTP status, got: ' + result.status
        );
    });

});
