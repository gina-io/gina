'use strict';
/**
 * #B567 — an HTML static on a bundle with no `content.templates` no longer answers 500.
 *
 * THE DEFECT: in dev, `handleStatics`' file-read callback injected the gina loader into an
 * HTML static by reading `bundleConf.content.templates._common` unguarded. A bundle that never
 * ran `view:add` — any API-only bundle — has no `content.templates`, so the read threw
 * `TypeError: Cannot read properties of undefined (reading '_common')` inside the try, and the
 * request answered 500. Reproduced live three times. Until #B566 it was masked after the first
 * request (the removed stream listener served later HTML statics raw); with the listener gone
 * every HTML static on such a bundle reached it.
 *
 * THE FIX: the loader is injected only when `content.templates._common.ginaLoader` exists;
 * otherwise the page is served as text, untouched.
 *
 * WHICH PINS CAN GO RED — read this before trusting a green run:
 *   the guard pin, the negative unguarded-read pin and the `_tplCommon`-keyed injection pin
 *   all read RED on the pre-fix source (validated via `git show`, 3 red / 1 green).
 *   The `isBinary = false;` pin is GREEN on both revisions by design: it guards that the
 *   fix kept the page a text send, not that the fix exists — a structural control.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SERVER = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');

function code(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n');
}
function count(hay, needle) {
    var n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) > -1) { n++; i += needle.length; }
    return n;
}

/** The loader-injection block: from the `adding gina loader` gate to the handler-wrap `else`. */
function injectBlock() {
    var gate = "if ( /text\\/html/i.test(contentType) && self.isCacheless() ) {";
    var i = SERVER.indexOf(gate);
    assert.ok(i > -1, 'the dev HTML gate must exist');
    var j = SERVER.indexOf("// adding handler `gina.ready(...)` wrapper", i);
    assert.ok(j > i, 'the handler-wrap branch must follow the HTML gate');
    return code(SERVER.slice(i, j));
}

describe('01 - the gina loader is injected only when the bundle has templates (#B567)', function() {

    it('resolves _common through a guard that tolerates a missing content.templates', function() {
        var blk = injectBlock();
        assert.match(blk, /var _tplCommon\s*=\s*\(\s*bundleConf\.content\s*&&\s*bundleConf\.content\.templates\s*&&\s*typeof\(bundleConf\.content\.templates\._common\)\s*==\s*'object'\s*\)\s*\?\s*bundleConf\.content\.templates\._common\s*:\s*null;/,
            'the guard must test content, content.templates and the _common object before reading it');
        assert.match(blk, /if\s*\(\s*_tplCommon\s*&&\s*_tplCommon\.ginaLoader\s*\)\s*\{/,
            'injection must be gated on the resolved _common carrying a ginaLoader');
    });

    it('no longer reads _common unguarded inside the injection block', function() {
        assert.equal(count(injectBlock(), 'bundleConf.content.templates._common.'), 0,
            'a dotted read straight off bundleConf.content.templates._common is the #B567 crash');
    });

    it('still injects at </head> when deferred and at </body> otherwise', function() {
        var blk = injectBlock();
        assert.equal(count(blk, "_tplCommon.javascriptsDeferEnabled"), 1);
        assert.match(blk, /file\.replace\(\/\\<\\\/head\\>\/i,\s*'\\t'\+\s*_tplCommon\.ginaLoader\s*\+'\\n<\/head>'\)/);
        assert.match(blk, /file\.replace\(\/\\<\\\/body\\>\/i,\s*'\\t'\+\s*_tplCommon\.ginaLoader\s*\+'\\n<\/body>'\)/);
    });

    it('keeps the page a text send (isBinary false) whether or not the loader was injected', function() {
        assert.equal(count(injectBlock(), 'isBinary = false;'), 1);
    });
});
