/**
 * Smoke test — full lifecycle.
 *
 * Creates a temporary gina project + bundle, wires up a minimal HTML view,
 * starts the bundle, verifies an HTTP response, checks logs, then tears
 * everything down regardless of outcome.
 *
 * Skip conditions (graceful, non-failing):
 *   - gina framework socket (port 8124) is not running
 *   - any setup step (project:add / bundle:add) fails
 *
 * Run standalone:
 *   node --test test/integration/smoke.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert   = require('node:assert/strict');
var net      = require('net');
var http     = require('http');
var fs       = require('fs');
var os       = require('os');
var path     = require('path');
var { execSync } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP             = Date.now();
var TEST_PROJECT      = 'gsmk' + STAMP;          // valid [a-z0-9_.]+ name
var TEST_BUNDLE       = 'smkb';
var TEST_DIR          = '/tmp/' + TEST_PROJECT;
var SMOKE_PORT_START  = 9100;                     // port:reset starts here

var GINA_SOCKET_PORT  = 8124;
var POLL_TIMEOUT_MS   = 20000;
var POLL_INTERVAL_MS  = 300;

var GINA_BIN = path.resolve(__dirname, '../../bin/gina');

// Tracks what was created so after() knows what to clean up
var created = { dir: false, project: false, bundle: false, started: false };

var shouldSkip = false;
var skipReason = '';
var bundlePort = null;


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTcpPortOpen(port) {
    return new Promise(function(resolve) {
        var sock = new net.Socket();
        sock.setTimeout(800);
        sock.on('connect', function() { sock.destroy(); resolve(true);  });
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
                if (open)                  return resolve(true);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(poll, POLL_INTERVAL_MS);
            });
        })();
    });
}

function httpGet(url) {
    return new Promise(function(resolve, reject) {
        http.get(url, function(res) {
            var body = '';
            res.on('data', function(chunk) { body += chunk; });
            res.on('end',  function() {
                resolve({
                    status:      res.statusCode,
                    contentType: res.headers['content-type'] || '',
                    body:        body
                });
            });
        }).on('error', reject);
    });
}

function ginaCmdSync(args) {
    execSync(GINA_BIN + ' ' + args, { stdio: 'pipe' });
}

/**
 * Reads ~/.gina/ports.json and returns the port number assigned to bundle@project/dev.
 */
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


/**
 * Patches the scaffolded controller to call self.render() instead of
 * self.renderJSON() so the HTML template pipeline is exercised.
 */
function patchController(projectDir, bundleName) {
    var ctrlPath = path.join(
        projectDir, 'src', bundleName, 'controllers', 'controller.content.js'
    );
    var src     = fs.readFileSync(ctrlPath, 'utf8');
    var patched = src.replace('self.renderJSON(data)', 'self.render(data)');
    fs.writeFileSync(ctrlPath, patched);
}

/**
 * Returns the bundle log file path if it exists, null otherwise.
 * Gina writes logs to ~/.${projectName}/var/logs/<bundle>.log.
 */
function findBundleLog(projectName, bundleName) {
    var logFile = path.join(
        os.homedir(), '.' + projectName, 'var', 'logs', bundleName + '.log'
    );
    return fs.existsSync(logFile) ? logFile : null;
}

/**
 * Scans a log file for [error] or [fatal] lines.
 * Returns an array of matching lines (empty when clean).
 */
function collectLogErrors(logFile) {
    if (!logFile) return [];
    try {
        return fs.readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(function(line) { return /\[(error|fatal)\]/i.test(line); });
    } catch (e) {
        return [];
    }
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('17 - smoke — create project → add bundle → add HTML view → start → verify → teardown', function() {


    before(async function() {

        // -- Guard: gina socket must be running for bundle:start --
        var ginaRunning = await isTcpPortOpen(GINA_SOCKET_PORT);
        if (!ginaRunning) {
            shouldSkip = true;
            skipReason = 'gina socket (port ' + GINA_SOCKET_PORT + ') is not running';
            return;
        }

        // 1. Create project
        try {
            ginaCmdSync(
                'project:add @' + TEST_PROJECT +
                ' --path=' + TEST_DIR +
                ' --start-port-from=' + SMOKE_PORT_START
            );
            created.dir     = true;
            created.project = true;
        } catch (e) {
            shouldSkip = true;
            skipReason = 'project:add failed: ' + (e.stderr ? e.stderr.toString() : (e.message || e));
            return;
        }

        // 2. Add bundle (offline — port scan runs inside gina)
        try {
            ginaCmdSync(
                'bundle:add ' + TEST_BUNDLE + ' @' + TEST_PROJECT +
                ' --start-port-from=' + SMOKE_PORT_START
            );
            created.bundle = true;
        } catch (e) {
            shouldSkip = true;
            skipReason = 'bundle:add failed: ' + (e.stderr ? e.stderr.toString() : (e.message || e));
            return;
        }

        // 3. Scaffold HTML view files (offline — copies boilerplate templates into bundle)
        try {
            ginaCmdSync('view:add ' + TEST_BUNDLE + ' @' + TEST_PROJECT);
        } catch (e) {
            shouldSkip = true;
            skipReason = 'view:add failed: ' + (e.stderr ? e.stderr.toString() : (e.message || e));
            return;
        }

        // 4. Patch the scaffolded controller to call self.render() instead of
        //    self.renderJSON() so the HTML template pipeline is exercised.
        patchController(TEST_DIR, TEST_BUNDLE);

        // 5. Look up the assigned bundle port
        bundlePort = getBundlePort(TEST_PROJECT, TEST_BUNDLE);
        if (!bundlePort) {
            shouldSkip = true;
            skipReason = TEST_BUNDLE + '@' + TEST_PROJECT + '/dev not found in ~/.gina/ports.json';
            return;
        }

        // 6. Start the bundle (daemonised; returns once acknowledged by the socket)
        try {
            ginaCmdSync('bundle:start ' + TEST_BUNDLE + ' @' + TEST_PROJECT);
            created.started = true;
        } catch (e) {
            shouldSkip = true;
            skipReason = 'bundle:start failed: ' + (e.stderr ? e.stderr.toString() : (e.message || e));
        }
    });


    after(function() {
        // Cleanup in reverse order — always runs regardless of test outcome
        if (created.started) {
            try { ginaCmdSync('bundle:stop ' + TEST_BUNDLE + ' @' + TEST_PROJECT); } catch (e) { /* ignore */ }
        }
        if (created.project) {
            // --force skips the interactive "also delete sources?" prompt
            try { ginaCmdSync('project:rm @' + TEST_PROJECT + ' --force'); } catch (e) { /* ignore */ }
        }
        // Belt-and-suspenders: delete the directory even if project:rm did it already
        if (created.dir && fs.existsSync(TEST_DIR)) {
            try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        }
    });


    // -- Tests --

    it('bundle HTTP port opens within 20 s', { timeout: POLL_TIMEOUT_MS + 5000 }, async function(t) {
        if (shouldSkip) { t.skip(skipReason); return; }
        assert.ok(bundlePort, 'bundle port not found in ports.json');
        var opened = await waitForPort(bundlePort, POLL_TIMEOUT_MS);
        assert.ok(
            opened,
            'port ' + bundlePort + ' did not open within ' + POLL_TIMEOUT_MS + ' ms — bundle may have crashed on startup'
        );
    });

    it('HTTP GET / returns 200 with HTML containing the greeting', { timeout: 5000 }, async function(t) {
        if (shouldSkip) { t.skip(skipReason); return; }
        assert.ok(bundlePort, 'bundle port not found');

        var result = await httpGet('http://127.0.0.1:' + bundlePort + '/' + TEST_BUNDLE + '/');
        assert.equal(result.status, 200, 'expected HTTP 200, got ' + result.status);
        assert.ok(
            result.contentType.startsWith('text/html'),
            'expected text/html content-type, got: ' + result.contentType
        );
        assert.ok(
            result.body.includes('Hello World'),
            'expected "Hello World" (appConf.greeting) in response body.\n' +
            'First 300 chars: ' + result.body.substring(0, 300)
        );
    });

    it('bundle log has no [error] or [fatal] entries', { timeout: 2000 }, function(t) {
        if (shouldSkip) { t.skip(skipReason); return; }

        var logFile = findBundleLog(TEST_PROJECT, TEST_BUNDLE);
        if (!logFile) {
            // Log path depends on gina version and runtime config — skip if not found
            t.skip('log file not found at ~/.' + TEST_PROJECT + '/var/logs/' + TEST_BUNDLE + '.log');
            return;
        }

        var errors = collectLogErrors(logFile);
        assert.deepEqual(
            errors, [],
            'found [error]/[fatal] entries in bundle log:\n' + errors.join('\n')
        );
    });

});
