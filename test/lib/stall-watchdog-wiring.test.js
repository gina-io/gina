'use strict';
/**
 * The stall watchdog's three wiring points, pinned in the sources:
 *
 *   §01 core/server.js init() resolves `server.stallWatchdog` BEFORE any listen():
 *       inside init()'s try (whose catch emergs and exits), outside any nested try,
 *       so a wrong value on an enabled block refuses the boot; the resolved conf is
 *       stamped on the server, and a warning is logged.
 *   §02 onRequest() reads the stamp once, and the request-entry site feeds the ring
 *       for application requests only: after the early answers (/_gina/*, statics,
 *       maintenance), after the entry line, before the body is read, with the path
 *       escaped (escapeLogControlChars).
 *   §03 core/gna.js starts the thread in the `server.on('started')` band — after
 *       the listener is up and after lib.metrics.start() — non-fatally.
 *
 * The behaviour end to end is test/integration/container-boot-stall-watchdog.test.js
 * (a booted bundle); the thread itself, test/lib/stall-watchdog-worker.test.js.
 *
 * Run: node --test test/lib/stall-watchdog-wiring.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var SERVER_SRC = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var GNA_SRC    = fs.readFileSync(path.join(FW, 'core/gna.js'), 'utf8');

/**
 * The index of a needle that must occur exactly once.
 *
 * @param {string} src
 * @param {string} needle
 * @returns {number}
 */
function once(src, needle) {
    var i = src.indexOf(needle);
    assert.ok(i > -1, 'not found: ' + needle);
    assert.equal(src.indexOf(needle, i + 1), -1, 'found twice: ' + needle);
    return i;
}

describe('01 - core/server.js init(): resolved and validated before listen()', function() {
    var RESOLVE = 'var _swConf = lib.stallWatchdog.resolveConfig(self.conf[self.appName][self.env].server.stallWatchdog);';

    it('01.01 - inside init(), after the releaseWatch block and before the #COMPLY9 posture block', function() {
        var initAt    = once(SERVER_SRC, '    var init = function(options) {');
        var rwCatchAt = once(SERVER_SRC, "console.warn('[releaseWatch] init skipped: '");
        var resolveAt = once(SERVER_SRC, RESOLVE);
        var comply9At = once(SERVER_SRC, '// ── #COMPLY9 — production transport posture (ZT2)');
        var exitAt    = once(SERVER_SRC, 'console.emerg(_engineMsg)');
        assert.ok(initAt < rwCatchAt && rwCatchAt < resolveAt && resolveAt < comply9At && comply9At < exitAt);
    });

    it('01.02 - no try of its own: a throw reaches init()\'s catch, which exits before any listen()', function() {
        var rwCatchAt = once(SERVER_SRC, "console.warn('[releaseWatch] init skipped: '");
        var resolveAt = once(SERVER_SRC, RESOLVE);
        var between   = SERVER_SRC.slice(rwCatchAt, resolveAt);
        assert.equal(between.indexOf('try {'), -1, 'no try opens between the releaseWatch catch and the resolve');
        // the real call (JSDoc above it quotes `self.instance.listen(port)`, a different line)
        var listenAt = once(SERVER_SRC, 'var _rawServer = self.instance.listen(self.conf[self.appName][self.env].server.port);');
        assert.ok(once(SERVER_SRC, 'console.emerg(_engineMsg)') < listenAt, 'the catch that exits precedes the listen() call');
    });

    it('01.03 - the warning is logged and the conf stamped on the server', function() {
        var resolveAt = once(SERVER_SRC, RESOLVE);
        var block     = SERVER_SRC.slice(resolveAt, resolveAt + 300);
        assert.ok(block.indexOf('if ( _swConf.warning ) {\n                console.warn(_swConf.warning);\n            }') > -1);
        assert.ok(block.indexOf('self._stallWatchdogConf = _swConf;') > -1);
    });
});

describe('02 - core/server.js onRequest(): the ring is fed at the request-entry site', function() {
    var READ  = 'var stallWatchdog = ( self._stallWatchdogConf && self._stallWatchdogConf.enabled === true );';
    var ENTER = 'lib.stallWatchdog.enter(request, response, escapeLogControlChars(request.url));';

    it('02.01 - the stamp is read once, in onRequest(), before the catch-all handler', function() {
        var onRequestAt = once(SERVER_SRC, '    var onRequest = function() {');
        var readAt      = once(SERVER_SRC, READ);
        var catchAllAt  = once(SERVER_SRC, 'self.instance.all(catchAllPattern, function onInstance(request, response, next) {');
        assert.ok(onRequestAt < readAt && readAt < catchAllAt);
    });

    it('02.02 - guarded by that flag, after the early answers and the entry line, before the body is set up', function() {
        var keepOpenAt = once(SERVER_SRC, 'earlyAnswer.keepOpen(request);');
        var entryAt    = once(SERVER_SRC, '                    logRequestEntry(request);');
        var enterAt    = once(SERVER_SRC, ENTER);
        var bodyAt     = SERVER_SRC.indexOf("request.body    = ( typeof(request.body) != 'undefined' ) ? request.body : {};", enterAt);
        assert.ok(keepOpenAt < entryAt && entryAt < enterAt && enterAt < bodyAt && bodyAt > -1);
        assert.ok(SERVER_SRC.slice(enterAt - 60, enterAt).indexOf('if ( stallWatchdog ) {') > -1, 'guarded by the read-once flag');
    });

    it('02.03 - the request id it names is stamped first-seer earlier in the same handler', function() {
        var idAt    = once(SERVER_SRC, 'request._ginaReqId = _resolveRequestId(request);');
        var enterAt = once(SERVER_SRC, ENTER);
        assert.ok(idAt < enterAt);
    });
});

describe('03 - core/gna.js: the thread starts in the started band, after the metrics init', function() {
    var INIT = 'lib.stallWatchdog.init({';

    it('03.01 - inside server.on(\'started\'), after lib.metrics.start() and its catch', function() {
        var bandAt     = once(GNA_SRC, "server.on('started', async function (conf) {");
        var metricsAt  = once(GNA_SRC, 'lib.metrics.start({');
        var mCatchAt   = once(GNA_SRC, "console.warn('[lib.metrics] init skipped: '");
        var initAt     = once(GNA_SRC, INIT);
        assert.ok(bandAt < metricsAt && metricsAt < mCatchAt && mCatchAt < initAt);
    });

    it('03.02 - only with the resolved conf, handed the logger and the metrics; non-fatal', function() {
        var initAt = once(GNA_SRC, INIT);
        var block  = GNA_SRC.slice(initAt - 200, initAt + 500);
        assert.ok(block.indexOf('if ( server._stallWatchdogConf && server._stallWatchdogConf.enabled === true ) {') > -1);
        assert.ok(block.indexOf('conf    : server._stallWatchdogConf,') > -1);
        assert.ok(block.indexOf('logger  : lib.logger,') > -1);
        assert.ok(block.indexOf('metrics : lib.metrics') > -1);
        assert.ok(block.indexOf("console.warn('[stallWatchdog] start skipped: '") > -1, 'a start failure is a warn, never a boot abort');
    });
});
