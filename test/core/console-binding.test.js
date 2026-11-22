'use strict';
/**
 * Console binding in the URL-logging framework files (#B433 hardening).
 *
 * The #B433 census found 46 live `console.<level>(… request.url …)` sites in
 * 10 files, all of which reach `lib/logger` — but seven of those files never
 * bound `console` themselves: they inherited it because `lib/routing/src/main.js`
 * performs a declarator-less, non-strict `console = require('../../logger')`
 * that reassigns Node's GLOBAL console at require time. A `'use strict'` or a
 * `var` in that one file would have routed their access lines back to raw
 * stdout — bypassing the containers and the redaction seam — with no test
 * failing. The six render delegates now bind the logger explicitly (the csrf
 * plugin keeps the plugin convention: 0 of 5 plugins bind, the global is their
 * documented mechanism).
 *
 * Covered:
 *   01  every non-plugin census file binds `console` to the logger at module scope (source, comment-stripped)
 *   02  the binding sits before the file's first `console.` use, and no capture of a logger METHOD exists
 *   03  the global-reassignment mechanism the plugins rely on still holds at runtime (behavioural, identity)
 *   04  roster pins: the census file list and the routing reassignment are unchanged (a control that can fail)
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var commentStrip = require('../strip-comments');

var FRAMEWORK = path.resolve(require('../fw'));

// The ten non-plugin files of the #B433 census: live `console.<level>(… request.url …)`
// sites across server.js · server.isaac.js · controller.js · the seven render delegates
// (+ the csrf plugin's 1, covered by section 03). `render-xml.js` joined with #FIN2;
// `render-stream.js` is deliberately absent — it logs no request URL.
var CENSUS = [
    'core/server.js',
    'core/server.isaac.js',
    'core/controller/controller.js',
    'core/controller/controller.render-json.js',
    'core/controller/controller.render-swig.js',
    'core/controller/controller.render-swig-async.js',
    'core/controller/controller.render-nunjucks.js',
    'core/controller/controller.render-nunjucks-async.js',
    'core/controller/controller.render-v1.js',
    'core/controller/controller.render-xml.js'
];
var PLUGIN  = 'core/plugins/lib/csrf/src/main.js';
var ROUTING = 'lib/routing/src/main.js';

// Module-scope binding of `console` to the registry's logger. Both spellings the
// tree uses; anchored at line start so a comment cannot satisfy it.
var BINDING = /^[ \t]*(?:var|const|let)[ \t]+console[ \t]*=[ \t]*(?:lib|libRef)\.logger[ \t]*;/m;

function read(rel) { return fs.readFileSync(path.join(FRAMEWORK, rel), 'utf8'); }
function stripComments(s) {
    return commentStrip.all(s);
}


// ─── 01  every census file binds console explicitly ─────────────────────────
describe('01 - every non-plugin census file binds console to the logger at module scope', function () {
    CENSUS.forEach(function (rel) {
        it(rel + ' carries a module-scope `console = lib.logger` binding', function () {
            var code = stripComments(read(rel));
            assert.match(code, BINDING, rel + ': no explicit console binding — the file would inherit the global');
            // anti-vacuity: the stripped source still contains a console use to be governed
            assert.ok(/console\.(?:info|warn|error|debug|log)\(/.test(code), rel + ': stripping emptied the file');
        });
    });
});


// ─── 02  binding precedes first use; no method capture ──────────────────────
describe('02 - the binding precedes the first console use, and no logger method is captured', function () {
    CENSUS.forEach(function (rel) {
        it(rel + ': binding index < first `console.` call index; no `= console.<method>` capture', function () {
            var code    = stripComments(read(rel));
            var bindIdx = code.search(BINDING);
            var useIdx  = code.search(/console\.(?:info|warn|error|debug|log)\(/);
            assert.ok(bindIdx > -1 && useIdx > -1, 'anchors present');
            assert.ok(bindIdx < useIdx, rel + ': a console call precedes the binding (a hoisted `var console` is undefined there)');
            // capturing a method into a local would bypass call-time property resolution
            // (the seam a post-boot logger replacement relies on) — none may exist
            assert.doesNotMatch(code, /=[ \t]*(?:console|lib\.logger|libRef\.logger|logger)\.[a-zA-Z_$]+[ \t]*(?:;|,|\)|$)/m, rel + ': a logger method is captured into a local');
        });
    });
});


// ─── 03  the plugin mechanism: global console IS the logger after routing loads ──
describe('03 - the global reassignment plugins rely on holds at runtime', function () {
    it('requiring lib/routing makes global.console the lib/logger export (identity)', function () {
        process.env.GINA_LOG_STDOUT = 'true';   // strip the mq dial before the logger's module init
        var before = global.console;
        require(path.join(FRAMEWORK, ROUTING));
        var logger = require(path.join(FRAMEWORK, 'lib/logger'));
        assert.notEqual(global.console, before, 'the global was not reassigned');
        assert.equal(global.console, logger, 'global.console must be the lib/logger singleton');
        assert.equal(typeof global.console.setRedaction, 'function', 'the logger reached through the global carries the #B433 seam');
        delete process.env.GINA_LOG_STDOUT;
    });

    it('the csrf plugin binds nothing itself (plugin convention) and so depends on that global', function () {
        var code = stripComments(read(PLUGIN));
        assert.doesNotMatch(code, BINDING, 'the plugin gained an explicit binding — update this test and the logger.md note');
        assert.ok(/console\.error\(/.test(code), 'the plugin still logs through `console`');
    });
});


// ─── 04  roster + mechanism pins (controls that can fail) ───────────────────
describe('04 - roster and mechanism pins', function () {
    it('lib/routing still performs the declarator-less global reassignment (the documented plugin mechanism)', function () {
        var code = stripComments(read(ROUTING));
        assert.match(code, /^[ \t]*console[ \t]*=[ \t]*require\('\.\.\/\.\.\/logger'\);/m,
            'the routing reassignment changed shape — plugins (0 of 5 bind console) would lose the logger');
        assert.doesNotMatch(code, /(?:var|const|let)[ \t]+console\b/, 'a declarator here would stop the global reassignment');
        assert.doesNotMatch(code, /^[ \t]*'use strict'/m, 'strict mode here would make the bare assignment throw');
    });

    it('every census file still exists and logs a request URL (the roster is not stale)', function () {
        CENSUS.forEach(function (rel) {
            var code = stripComments(read(rel));
            assert.ok(/console\.(?:info|warn|error|debug)\([^;]*\b(?:req|request|_req)\.url\b/.test(code) || /\.url\b/.test(code),
                rel + ': no URL-logging site found — re-run the #B433 census and update the roster');
        });
    });
});
