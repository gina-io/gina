/**
 * lib/logger/.../mq/listener.js — a payload's `request` field must not be able to
 * kill the process (#B678).
 *
 * The MQ listener (port 8125, started by every `bin/cli` invocation) reads a
 * `request` field off each JSON frame and uses it (1) as a key on `forwardList`
 * and (2), for `report`/`respond`, as a method name on `self`. Before #B678 both
 * uses were unguarded `typeof … != 'undefined'` checks, so a frame naming an
 * inherited `Object.prototype` member — `__proto__`, `constructor`,
 * `hasOwnProperty` — or the object's own `name` string field reached
 * `forwardList[req].indexOf(...)` on a non-array, or called `self[req](...)` on a
 * non-function, and THREW out of the socket's 'data' handler. That is an
 * uncaught exception in the `bin/cli` daemon process (no uncaughtException
 * handler there — lib/proc.js's handler is bundle-side), which ends the process
 * hosting BOTH the listener and the 8124 command socket. The listener binds
 * loopback by default (see #B279 / entry 280), so this is a same-host,
 * local-privilege crash, not remotely reachable — hence no advisory — but a
 * single 30-byte frame taking the daemon down is a defect.
 *
 * Two layers, mirroring mq-listener-conn-error.test.js:
 *   01 — source pins on the real file (comment-stripped): the OWN-key/own-method
 *        guards and the request-name validator are present, and the raw
 *        `typeof(forwardList[this.request]) == 'undefined'` and
 *        `typeof(self[this.request]) != 'undefined'` shapes are gone.
 *   02 — behaviour, in a CHILD process: the REAL listener module is loaded, a
 *        client sends the malicious frames, and the process is asserted to
 *        survive AND still answer a following frame. The negative arm must run
 *        out-of-process precisely because pre-#B678 the throw would take this
 *        test runner down. Arm (b) is a small driver, not a replica: it requires
 *        the real listener.
 *
 * Run standalone:
 *   node --test test/lib/mq-listener-dispatch-guard-b678.test.js
 */

'use strict';

var fs        = require('fs');
var path      = require('path');
var os        = require('os');
var { spawnSync } = require('child_process');
var { describe, it } = require('node:test');
var assert    = require('node:assert/strict');

var FW       = require('../fw');
var ROOT     = path.resolve(__dirname, '..', '..');
var LISTENER = path.join(FW, 'lib/logger/src/containers/mq/listener.js');


// ---------------------------------------------------------------------------
// 01 — source pins (comment-stripped: the #B678 comments name every guarded
//      shape and would satisfy these on their own — the file's-own-comment trap)
// ---------------------------------------------------------------------------
describe('01 - mq listener: the request field is dispatched by OWN key/method only (#B678)', function () {

    var code = fs.readFileSync(LISTENER, 'utf8').replace(/\/\/[^\n]*/g, '');

    it('01a - validates the request name before it becomes a key', function () {
        assert.match(code, /isRequestName\s*=\s*function/,
            'an isRequestName validator must gate the request field');
        assert.match(code, /if\s*\(\s*!isRequestName\(pl\.request\)\s*\)/,
            'the frame must be refused when the request name is invalid');
    });

    it('01b - dispatches to an OWN function property only, never an inherited/name member', function () {
        assert.match(code, /hasOwn\(self,\s*this\.request\)\s*&&\s*typeof\(self\[this\.request\]\)\s*==\s*.function./,
            'self dispatch must require an own function property');
        assert.ok(code.indexOf("typeof(self[this.request]) != 'undefined'") < 0,
            "the old unguarded `typeof(self[this.request]) != 'undefined'` must be gone");
    });

    it('01c - guards every forwardList access with an own-key check', function () {
        assert.ok(code.indexOf("typeof(forwardList[this.request]) == 'undefined'") < 0,
            'no unguarded forwardList typeof-undefined check may survive');
        assert.ok(code.indexOf("typeof(forwardList[this.request]) != 'undefined'") < 0,
            'no unguarded forwardList typeof-defined check may survive');
        assert.match(code, /hasOwn\(forwardList,\s*this\.request\)/,
            'forwardList access must go through hasOwn');
    });
});


// ---------------------------------------------------------------------------
// 02 — behaviour: the malicious frames do not take the process down
//      (child process — pre-#B678 the throw is uncaught and would kill THIS runner)
// ---------------------------------------------------------------------------
describe('02 - mq listener: a malicious request name cannot crash the daemon (#B678)', function () {

    // The driver loads the REAL listener from GINA_ROOT, then sends, in order:
    // a valid `report` frame, then `{"request":"name"}`, `{"request":"__proto__"}`,
    // `{"request":"constructor"}`; finally another valid frame. Pre-fix the first
    // malicious frame throws out of the 'data' handler → the child dies before
    // printing DONE. With the fix every malicious frame is refused and the child
    // prints DONE with the survivor count.
    var driver = [
        "'use strict';",
        "var net = require('net'), fs = require('fs'), os = require('os'), path = require('path');",
        // node -e <driver> <ROOT> <FW>: with -e there is no script filename in argv, so the
        // two args land at [1]/[2], not [2]/[3].
        "var ROOT = process.argv[1], FW = process.argv[2];",
        "require(ROOT + '/utils/helper'); require(FW + '/lib');",
        "var scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'b678-drv-'));",
        "setEnvVar('GINA_HOMEDIR', scratch);",
        "var MQListener = require(FW + '/lib/logger/src/containers/mq/listener.js');",
        "var frames = ['{\\\"request\\\":\\\"report\\\",\\\"content\\\":\\\"a\\\"}',",
        "  '{\\\"request\\\":\\\"name\\\",\\\"content\\\":\\\"x\\\"}',",
        "  '{\\\"request\\\":\\\"__proto__\\\",\\\"content\\\":\\\"x\\\"}',",
        "  '{\\\"request\\\":\\\"constructor\\\",\\\"content\\\":\\\"x\\\"}',",
        "  '{\\\"request\\\":\\\"report\\\",\\\"content\\\":\\\"z\\\"}'];",
        "var server = MQListener({ hostV4: '127.0.0.1', port: 0 }, function () {",
        "  var port = server.address().port, i = 0;",
        "  (function next() {",
        "    if (i >= frames.length) {",
        "      process.stdout.write('DONE listening=' + server.listening + '\\n');",
        "      server.close(); try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}",
        "      process.exit(0); return;",
        "    }",
        "    var frame = frames[i++];",
        "    var sock = net.connect(port, '127.0.0.1');",
        "    sock.on('error', function () {});",
        "    sock.on('data', function () {});",
        "    sock.on('connect', function () { setTimeout(function () { sock.write(frame + '\\r\\n'); }, 30); });",
        "    setTimeout(function () { sock.destroy(); next(); }, 200);",
        "  })();",
        "});"
    ].join('\n');

    it('02a - the real listener survives every Object.prototype/own-field request name', function () {
        var r = spawnSync(process.execPath, ['-e', driver, ROOT, FW], {
            encoding: 'utf8', timeout: 30000,
            env: Object.assign({}, process.env, { GINA_LOG_STDOUT: 'true' })
        });
        var out = (r.stdout || '') + (r.status !== 0 ? '\n[stderr] ' + (r.stderr || '').slice(-800) : '');
        assert.ok(/DONE listening=true/.test(r.stdout || ''),
            'the listener process must survive every malicious frame and stay listening — got: ' + out);
        assert.equal(r.status, 0, 'the driver must exit 0 (no uncaught throw)');
    });
});
