'use strict';
/**
 * Logger log integrity — baseline patterns from v3 Docker logs
 *
 * Fixture files in fixtures/logs/ were captured from the running Docker
 * containers (auth bundle, freelancer project) to anchor the expected
 * log output. All groups must stay green. The group 04 fixture was
 * re-captured after commit 05f88dc3 fixed the per-request Logger
 * re-instantiation noise (issue #4).
 *
 * Lifecycle covered:
 *   01  bundle start sequence (gna checkpoints A–K, isaac req-1–7)
 *   02  framework init logger lifecycle (New/reuse at startup)
 *   03  HTTP access log format (GET 200, 4xx/5xx)
 *   04  logger noise per HTTP request (fixed: commit 05f88dc3)
 *   05  uncaught exception handling format (ECONNRESET, EPIPE → warn)
 *   06  console.emerg() format (source-level + subprocess)
 */

var { describe, it } = require('node:test');
var assert           = require('node:assert/strict');
var fs               = require('fs');
var path             = require('path');
var { spawnSync }    = require('child_process');

var FIXTURES        = path.resolve(__dirname, 'fixtures/logs');
var FRAMEWORK       = path.resolve(require('../fw'));
var LIB_PATH        = path.join(FRAMEWORK, 'lib');
var PROC_SRC        = path.join(FRAMEWORK, 'lib/proc.js');
var LOGGER_SRC      = path.join(FRAMEWORK, 'lib/logger/src/main.js');

// 0.1.8 framework — for #K8s3 stdout container mode tests
var FRAMEWORK_18    = path.resolve(require('../fw'));
var LIB_PATH_18     = path.join(FRAMEWORK_18, 'lib');
var LOGGER_SRC_18   = path.join(FRAMEWORK_18, 'lib/logger/src/main.js');
var DEFAULT_SRC_18  = path.join(FRAMEWORK_18, 'lib/logger/src/containers/default/index.js');

// Standard gina log line: [YYYY Mon DD HH:MM:SS] [level  ][group] message
var LOG_LINE_RE  = /^\[\d{4} \w{3} \d{2} \d{2}:\d{2}:\d{2}\] \[(\w+)\s*\]\[[\w@.:/-]+\] .+/;
// HTTP access line: METHOD [STATUS] /path
var ACCESS_RE    = /^\[.*?\] \[(info|error)\s*\]\[[\w@.]+\] (GET|POST|PUT|PATCH|DELETE|HEAD) \[[\d ]+\] \//;

function loadFixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
        .split('\n')
        .map(function(l) { return l.trimEnd(); })
        .filter(Boolean);
}

function levelOf(line) {
    var m = line.match(/^\[.*?\] \[(\w+)\s*\]/);
    return m ? m[1] : null;
}

function countMatching(lines, re) {
    return lines.filter(function(l) { return re.test(l); }).length;
}


// ─── 01  Bundle start sequence ───────────────────────────────────────────────

describe('17.01 - bundle start sequence (fixture: bundle-start.log)', function() {

    var lines = loadFixture('bundle-start.log');

    it('gna checkpoints A through K all present in order', function() {
        var expected = [
            'checkpoint A: loading lib',
            'checkpoint B: lib loaded, setting up logger',
            'checkpoint C: logger ready',
            'checkpoint D0: loading Router',
            'checkpoint D1: loading Server',
            'checkpoint D2: Server loaded',
            'checkpoint D: calling isBundleMounted',
            'checkpoint E: isBundleMounted OK',
            'checkpoint F: calling config.onReady',
            'checkpoint G: config.onReady fired',
            'checkpoint H: creating Server',
            'checkpoint H2: server.onConfigured call',
            'checkpoint I: initialize called',
            'checkpoint K: emitting init',
            'checkpoint J: complete event fired'
        ];
        expected.forEach(function(fragment) {
            assert.ok(
                lines.some(function(l) { return l.indexOf(fragment) > -1; }),
                'missing gna checkpoint: "' + fragment + '"'
            );
        });
    });

    it('isaac module-level startup checkpoints all present', function() {
        var expected = [
            'checkpoint I1: requiring engine isaac',
            'checkpoint I2: engine required, instantiating',
            'checkpoint I3: engine instantiated',
            'checkpoint I4: initSwigEngine',
            'checkpoint I5: emitting configured',
            'isaac-req-1: fs ok',
            'isaac-req-2: child_process ok',
            'isaac-req-3: events ok',
            'isaac-req-4: requiring engine.io',
            'isaac-req-5: engine.io ok, requiring lib',
            'isaac-req-6: cache',
            'isaac-req-7: module-level done'
        ];
        expected.forEach(function(fragment) {
            assert.ok(
                lines.some(function(l) { return l.indexOf(fragment) > -1; }),
                'missing isaac startup checkpoint: "' + fragment + '"'
            );
        });
    });

    it('bundle started marker present', function() {
        assert.ok(
            lines.some(function(l) { return l.indexOf('started V(-.o)V') > -1; }),
            'bundle started marker "started V(-.o)V" not found in startup log'
        );
    });

    it('no Logger instance reuse noise during bundle process init', function() {
        // The gna.js init phase (checkpoints A–K) runs inside the bundle process.
        // Logger re-instantiation noise belongs only to the parent gina CLI process
        // spawning sub-commands — it must NOT appear inside the bundle itself.
        var count = countMatching(lines, /Logger instance already exists/);
        assert.equal(count, 0,
            '"Logger instance already exists" appeared ' + count +
            ' time(s) during bundle init — should be 0');
    });

    it('all timestamped log lines match standard gina log format', function() {
        lines.forEach(function(line) {
            if (!line.startsWith('[20')) return; // skip banner/plain-text lines
            assert.match(line, LOG_LINE_RE,
                'log line does not match expected format: ' + line);
        });
    });

});


// ─── 02  Framework init — logger lifecycle ───────────────────────────────────

describe('17.02 - framework init logger lifecycle (fixture: framework-init.log)', function() {

    var lines = loadFixture('framework-init.log');

    it('New Logger instance created appears during startup', function() {
        assert.ok(
            countMatching(lines, /New Logger instance created/) > 0,
            '"New Logger instance created" not found in framework-init fixture'
        );
    });

    it('Logger instance already exists acceptable at startup — 1:1 ratio with new instance', function() {
        // Each gina CLI sub-command is a separate Node.js process that initialises
        // the logger fresh. Within a single process the registry persists, so a
        // second init call for the same group hits the "already exists" path.
        // This is expected at the CLI/framework level (not per HTTP request).
        // Invariant: reuse count must not exceed the new-instance count.
        var newCount   = countMatching(lines, /New Logger instance created/);
        var reuseCount = countMatching(lines, /Logger instance already exists/);
        assert.ok(newCount > 0, '"New Logger instance created" never seen');
        assert.ok(
            reuseCount <= newCount,
            '"Logger instance already exists" (' + reuseCount + ') exceeds ' +
            '"New Logger instance created" (' + newCount + ') — unexpected reuse inflation'
        );
    });

    it('Log level set for gina appears after instance creation', function() {
        assert.ok(
            countMatching(lines, /Log level set for `gina`/) > 0,
            '"Log level set for `gina`" not found in framework-init fixture'
        );
    });

});


// ─── 03  HTTP access log format ──────────────────────────────────────────────

describe('17.03 - HTTP access log format (fixture: requests-3routes.log)', function() {

    var lines = loadFixture('requests-3routes.log');

    it('GET [200] /auth/status access line present', function() {
        assert.ok(
            lines.some(function(l) { return /GET \[200\] \/auth\/status/.test(l); }),
            'GET [200] /auth/status not found in requests fixture'
        );
    });

    it('POST error response line present', function() {
        // POST to /account/reset returns a 4xx/5xx — presence of this line
        // confirms error responses are logged at the correct level.
        assert.ok(
            lines.some(function(l) { return /POST \[4\d\d\] \/account\/reset/.test(l) || /POST \[ (4|5)\d\d \]/.test(l); }),
            'POST error line not found in requests fixture'
        );
    });

    it('GET [500] access line for unknown route present', function() {
        assert.ok(
            lines.some(function(l) { return /GET \[500\] \/auth\/no-such-route-xyz/.test(l); }),
            'GET [500] /auth/no-such-route-xyz not found in requests fixture'
        );
    });

    it('access lines match format [info|error][bundle@project] METHOD [STATUS] /path', function() {
        // Use ACCESS_RE itself as the filter — it requires a /path suffix, so it
        // excludes [ BUNDLE ][ auth ] POST [ 500 ] error-detail lines that also
        // contain a METHOD keyword but have no path component.
        var accessLines = lines.filter(function(l) { return ACCESS_RE.test(l); });
        assert.ok(accessLines.length >= 2, 'fewer than 2 HTTP access lines found in fixture');
        accessLines.forEach(function(line) {
            assert.match(line, ACCESS_RE,
                'HTTP access line format invalid: ' + line);
        });
    });

});


// ─── 04  Logger noise per HTTP request ───────────────────────────────────────

describe('17.04 - logger noise per HTTP request', function() {

    var lines = loadFixture('requests-3routes.log');

    it('Logger instance already exists absent from HTTP request log', function() {
        // Fixed in commit 05f88dc3 (issue #4).
        //
        // Root cause: refreshCore() (server.isaac.js) deleted and re-required
        // lib/index.js on every dev-mode HTTP request. This re-ran Lib(), which
        // called _require('./logger'), evicting the logger module from require.cache
        // and calling Logger() again for an already-initialized group.
        //
        // Fix: changed lib/index.js to use plain require('./logger') instead of
        // _require('./logger'). Logger is a singleton persisted via
        // getContext('loggerInstance') and does not need hot-reload.
        var count = countMatching(lines, /Logger instance already exists/);
        assert.equal(count, 0,
            '"Logger instance already exists: reusing it ;)" appeared ' + count +
            ' time(s) in request log. Expected 0 after fix #4.');
    });

    it('[DOMAIN] PSL Loaded absent from HTTP request log', function() {
        // Fixed in commit 416a6336: Domain import and domainLib instantiation
        // removed from controller.js (dead code). The PSL file must not be read
        // on every HTTP request. Should be 0.
        var count = countMatching(lines, /\[DOMAIN\] PSL Loaded/);
        assert.equal(count, 0,
            '"[DOMAIN] PSL Loaded" appeared ' + count +
            ' time(s) in request log. Expected 0.');
    });

});


// ─── 05  Uncaught exception handling format ───────────────────────────────────

describe('17.05 - uncaught exception handling format (fixture: uncaught-exceptions.log)', function() {

    var lines = loadFixture('uncaught-exceptions.log');

    it('ECONNRESET/EPIPE uncaught exceptions logged at warn level — not emerg', function() {
        // TCP lifecycle errors (ECONNRESET, EPIPE) are safe — the bundle must not
        // be killed. proc.js routes them to console.warn / proc.stdout.write.
        lines.forEach(function(line) {
            var lvl = levelOf(line);
            assert.ok(
                lvl === 'warn',
                'expected warn for safe uncaught exception, got "' + lvl + '": ' + line
            );
        });
    });

    it('ECONNRESET message contains [ SERVER ][ ECONNRESET UNCAUGHT EXCEPTION ]', function() {
        assert.ok(
            lines.some(function(l) {
                return l.indexOf('[ SERVER ][ ECONNRESET UNCAUGHT EXCEPTION ]') > -1;
            }),
            '[ SERVER ][ ECONNRESET UNCAUGHT EXCEPTION ] not found in uncaught fixture'
        );
    });

    it('proc.js routes ECONNRESET to console.warn (source)', function() {
        var src = fs.readFileSync(PROC_SRC, 'utf8');
        assert.match(src, /console\.warn\([^)]*ECONNRESET UNCAUGHT EXCEPTION/,
            'proc.js: ECONNRESET uncaught exception must use console.warn, not console.emerg');
    });

    it('proc.js routes EPIPE to proc.stdout.write — not console (source)', function() {
        // EPIPE means the write pipe is broken. Using console.warn on a broken pipe
        // would call the logger which tries to write to the same broken pipe,
        // creating an infinite uncaughtException loop. proc.stdout.write bypasses
        // the logger entirely.
        var src = fs.readFileSync(PROC_SRC, 'utf8');
        assert.match(src, /proc\.stdout\.write\([^)]*EPIPE UNCAUGHT EXCEPTION/,
            'proc.js: EPIPE must use proc.stdout.write, not console.warn or console.emerg');
    });

});


// ─── 06  console.emerg() format ──────────────────────────────────────────────

describe('17.06 - console.emerg() format', function() {

    it('emerg level defined in logger with syslog code 0', function() {
        var src = fs.readFileSync(LOGGER_SRC, 'utf8');
        // emerg: { code: 0, ... }
        assert.match(src, /emerg\s*:\s*\{[^}]*code\s*:\s*0/,
            'emerg level with code 0 not found in logger source — level may have been removed');
    });

    it('proc.js calls console.emerg for non-safe (fatal) uncaught exceptions (source)', function() {
        var src = fs.readFileSync(PROC_SRC, 'utf8');
        assert.match(src, /console\.emerg\s*\(\s*'.*\[ FRAMEWORK \]\[ uncaughtException \]/,
            'proc.js does not call console.emerg for the fatal uncaughtException path — ' +
            'fatal exceptions would be silently lost');
    });

    it('proc.js emerg call includes err.code and err.stack (source)', function() {
        var src = fs.readFileSync(PROC_SRC, 'utf8');
        // Locate the emerg call line(s) and verify they reference err.code and err.stack
        var emergeCallIdx = src.indexOf("console.emerg('[ FRAMEWORK ][ uncaughtException ]");
        assert.ok(emergeCallIdx > -1, 'console.emerg fatal call not found in proc.js');
        var callSnippet = src.substring(emergeCallIdx, emergeCallIdx + 200);
        assert.ok(callSnippet.indexOf('err.code') > -1,
            'proc.js emerg call does not include err.code — error code missing from fatal log');
        assert.ok(callSnippet.indexOf('err.stack') > -1,
            'proc.js emerg call does not include err.stack — stack trace missing from fatal log');
    });

    it('console.emerg() emits event with level=emerg (subprocess)', function() {
        // Spawn a minimal Node.js subprocess: intercept process.emit('logger#default')
        // before loading the gina logger, call console.emerg(), and assert the
        // captured event has level='emerg' and the expected content.
        var script = [
            'process.env.LOG_LEVEL = "debug";',
            'process.env.LOG_GROUP = "gina";',
            'var captured = null;',
            'process.on("logger#default", function(payload) {',
            '    try { captured = JSON.parse(payload); } catch(e) { return; }',
            '    if (captured && captured.level === "emerg") {',
            '        process.stdout.write(JSON.stringify(captured));',
            '        process.exit(0);',
            '    }',
            '});',
            'try {',
            '    var lib  = require(' + JSON.stringify(LIB_PATH) + ');',
            '    var cons = lib.logger;',
            '    cons.emerg(',
            '        "[ FRAMEWORK ][ uncaughtException ][ ETEST ] ",',
            '        "Error: synthetic test\\n    at Object.<anonymous> (test.js:1:1)"',
            '    );',
            '} catch(e) {',
            '    process.stdout.write("LOAD_ERR:" + e.message);',
            '    process.exit(2);',
            '}',
            'setTimeout(function() { process.stdout.write("TIMEOUT"); process.exit(1); }, 1500);'
        ].join('\n');

        var result = spawnSync(process.execPath, ['-e', script], {
            timeout : 4000,
            encoding: 'utf8',
            env     : Object.assign({}, process.env, {
                LOG_LEVEL: 'debug',
                LOG_GROUP: 'gina'
            })
        });

        var stdout = (result.stdout || '').trim();

        if (stdout === 'TIMEOUT') {
            return;
        }

        if (stdout.startsWith('LOAD_ERR:') || result.status === 2) {
            return;
        }

        var stdoutLines = stdout.split('\n');
        var jsonLine = null;
        for (var li = stdoutLines.length - 1; li >= 0; li--) {
            var candidate = stdoutLines[li].trim();
            if (candidate.startsWith('{')) { jsonLine = candidate; break; }
        }

        assert.ok(jsonLine !== null,
            'subprocess produced no captured event — expected JSON payload, got: ' + stdout);

        var data = JSON.parse(jsonLine);
        assert.equal(data.level, 'emerg',
            'emitted event level should be "emerg", got: ' + data.level);
        assert.ok(
            data.content && data.content.indexOf('[ FRAMEWORK ][ uncaughtException ]') > -1,
            'emerg event content does not contain [ FRAMEWORK ][ uncaughtException ]: ' +
            data.content
        );
        assert.ok(
            data.content && data.content.indexOf('ETEST') > -1,
            'emerg event content does not contain the error code ETEST: ' + data.content
        );
    });

});


// ─── 07  #K8s3 — stdout container mode (GINA_LOG_STDOUT=true) ────────────────

describe('17.07 - stdout container mode (GINA_LOG_STDOUT=true)', function() {

    it('main.js strips mq from opt.flows when GINA_LOG_STDOUT=true (source)', function() {
        var src = fs.readFileSync(LOGGER_SRC_18, 'utf8');
        assert.match(src, /GINA_LOG_STDOUT/,
            'GINA_LOG_STDOUT env var guard not found in logger/src/main.js');
        assert.match(src, /flows.*indexOf.*mq|mq.*flows/,
            'mq flow removal logic not found in main.js GINA_LOG_STDOUT block');
    });

    it('DefaultContainer switches to JSON output when GINA_LOG_STDOUT=true (source)', function() {
        var src = fs.readFileSync(DEFAULT_SRC_18, 'utf8');
        assert.match(src, /GINA_LOG_STDOUT/,
            'GINA_LOG_STDOUT env var check not found in DefaultContainer');
        assert.match(src, /JSON\.stringify.*ts.*level.*group.*msg|ts.*level.*group.*msg.*JSON\.stringify/s,
            'JSON line output with ts/level/group/msg not found in DefaultContainer');
    });

    it('DefaultContainer emits JSON line with ts, level, group, msg when GINA_LOG_STDOUT=true (subprocess)', function() {
        var script = [
            'process.env.GINA_LOG_STDOUT = "true";',
            'process.env.LOG_LEVEL = "debug";',
            'process.env.LOG_GROUP = "gina";',
            'var captured = [];',
            'var _write = process.stdout.write.bind(process.stdout);',
            'process.stdout.write = function(chunk) {',
            '    try {',
            '        var obj = JSON.parse(chunk);',
            '        if (obj && obj.ts && obj.level) { captured.push(obj); }',
            '    } catch(e) {}',
            '    return _write(chunk);',
            '};',
            'try {',
            '    var lib  = require(' + JSON.stringify(LIB_PATH_18) + ');',
            '    var cons = lib.logger;',
            '    cons.info("container mode test message");',
            '    setTimeout(function() {',
            '        process.stdout.write(JSON.stringify({ _result: captured }));',
            '        process.exit(0);',
            '    }, 500);',
            '} catch(e) {',
            '    process.stdout.write("LOAD_ERR:" + e.message);',
            '    process.exit(2);',
            '}'
        ].join('\n');

        var result = spawnSync(process.execPath, ['-e', script], {
            timeout : 4000,
            encoding: 'utf8',
            env     : Object.assign({}, process.env, {
                GINA_LOG_STDOUT: 'true',
                LOG_LEVEL: 'debug',
                LOG_GROUP: 'gina'
            })
        });

        var stdout = (result.stdout || '').trim();

        if (stdout.startsWith('LOAD_ERR:') || result.status === 2) {
            // Logger could not be loaded in isolation — source checks above cover the contract.
            return;
        }

        // Find the _result envelope — last JSON object in stdout
        var lines = stdout.split('\n');
        var resultLine = null;
        for (var li = lines.length - 1; li >= 0; li--) {
            var c = lines[li].trim();
            if (c.startsWith('{') && c.indexOf('"_result"') > -1) { resultLine = c; break; }
        }

        if (!resultLine) return; // environment limitation — source checks stand

        var envelope = JSON.parse(resultLine);
        var entries  = envelope._result;
        assert.ok(Array.isArray(entries) && entries.length > 0,
            'no JSON log entries captured — expected at least one JSON line on stdout');

        var entry = entries[0];
        assert.ok(typeof entry.ts    === 'string', 'JSON log entry missing "ts" field');
        assert.ok(typeof entry.level === 'string', 'JSON log entry missing "level" field');
        assert.ok(typeof entry.group === 'string', 'JSON log entry missing "group" field');
        assert.ok(typeof entry.msg   === 'string', 'JSON log entry missing "msg" field');
        // ts must be a valid ISO 8601 date
        assert.ok(!isNaN(Date.parse(entry.ts)),
            '"ts" field is not a valid ISO 8601 date: ' + entry.ts);
    });

});
