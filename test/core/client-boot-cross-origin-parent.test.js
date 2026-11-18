'use strict';
/**
 * #B486 — the client boot survives a CROSS-ORIGIN parent frame; #B1130 — and no frame inherits its
 * parent frame's instance.
 *
 * `construct()` (vendor/gina/main.js) read `parent.window['gina']` unconditionally to inherit a
 * parent frame's instance. Under a cross-origin parent that named-property read on the parent's
 * WindowProxy throws `SecurityError`; `construct()` is `async`, so the throw became a rejected
 * promise that `core.js`'s `require('gina')(window['gina'])` discards — no `ginaloaded`
 * dispatch, a silently half-booted client, nothing in the console beyond the rejection.
 * Measured live in a two-origin browser repro (127.0.0.1:8901 embedding :8902): the exact
 * `SecurityError: Failed to read a named property 'gina' from 'Window'` fired at the read and
 * the dispatch line was never reached; #B486 wrapped the read in a try/catch.
 *
 * #B1130 removed the inheritance itself (Martin Luther ETOUMAN NDAMBWE's « D: no inheritance »,
 * and the approved change of this file, 2026-11-11). Under a SAME-origin parent the merge kept
 * every per-document value of the parent (lib/merge keeps the target's values): the frame's own
 * loader returned at once on the inherited `isFrameworkLoaded`, its popin, validator and nav boots
 * were skipped, and `new Popin()` looked up the parent's container id in the frame's document and
 * threw `Cannot read properties of undefined (reading 'addListener')` (gh#103, reproduced in
 * Chromium on develop fbdf80b29). With no read of `parent.window` at all, the #B486 purpose holds
 * by construction: a cross-origin parent cannot throw in construct().
 *
 * House style (the #B483 shape): no live browser here (the e2e spec
 * test/e2e/popin-frame-own-instance-b1130.spec.js drives the frame scene). Source pins on code
 * lines, `//` comment lines excluded (the fix keeps the old block in a `was:` comment, so every
 * absence pin also asserts the RAW text still holds the needle — the exclusion has something to
 * exclude), a
 * source-DERIVED replica of the instance merge driven with a cross-origin and a same-origin parent
 * through the real lib/merge, a control replaying the old block from that `was:` comment, and
 * built-bundle pins. Module-path seams `B486_SRC` / `B486_BUNDLE` / `B486_BUNDLE_MIN` so the whole
 * file runs against a pre-change copy (red-first).
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var path = require('path');

var FW   = process.env.B486_FW || require('../fw');
var MAIN = process.env.B486_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/main.js');
var BUNDLE     = process.env.B486_BUNDLE     || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var BUNDLE_MIN = process.env.B486_BUNDLE_MIN || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
var merge = require(path.join(FW, 'lib/merge'));

var READ     = "typeof(parent.window['gina']) != 'undefined'";
var MERGE    = "window['gina'] = merge((window['gina'] || {}), parent.window['gina']);";
var INSTANCE = "$instance = merge( (window['gina'] || {}), $instance);";
var DISPATCH = "triggerEvent(gina, proto.target, 'ginaloaded', $instance);";

/** The lines holding `needle` that are code, i.e. not `//` comment lines (no block-comment regex: a
 *  `/*` inside a string of the 2 MB bundle would make one swallow live code). */
function liveLines(s, needle) {
    return s.split('\n').filter(function (l) { return l.indexOf(needle) > -1 && !/^\s*\/\//.test(l); });
}
/** The pre-#B1130 block, recovered from the `// was:` comment that follows the #B1130 note. */
function oldBlockFromComment(src) {
    var at = src.indexOf('// #B1130');
    var was = (at > -1) ? src.indexOf('// was:', at) : -1;
    if (was < 0) { return null; }
    var lines = src.slice(was).split('\n').slice(1);
    var out = [];
    for (var i = 0; i < lines.length && /^\s*\/\//.test(lines[i]); i++) { out.push(lines[i].replace(/^\s*\/\/ ?/, '')); }
    return out.join('\n');
}
/** A SecurityError-shaped DOMException, as the browser throws it for a cross-origin named-property read. */
function crossOriginParent() {
    return { get window() { return new Proxy({}, { get: function (t, k) {
        if (k === 'gina') { throw new DOMException("Failed to read a named property 'gina' from 'Window'", 'SecurityError'); }
        return undefined; } }); } };
}
/** This document's fresh defaults, the shape of construct()'s `$instance` literal. */
function freshInstance() {
    return { id: 'gina-frame', isFrameworkLoaded: false, hasValidator: false, hasPopinHandler: false, config: {}, session: null, registeredEvents: {}, events: {} };
}

describe('01 - #B486 / #B1130 source pins: construct() no longer reads the parent frame', function () {
    var src;
    before(function () { src = fs.readFileSync(MAIN, 'utf8'); });

    it('no read of parent.window[\'gina\'] in code (the raw text keeps it, in the `was:` comment)', function () {
        assert.ok(src.indexOf(READ) > -1, 'the raw source still holds the old read in its was: comment (the strip has something to remove)');
        assert.deepStrictEqual(liveLines(src, READ), [], 'no live read');
        assert.deepStrictEqual(liveLines(src, 'parent.window'), [], 'no live parent.window access of any shape');
    });
    it('no inheritance merge in code (the raw text keeps it, in the `was:` comment)', function () {
        assert.ok(src.indexOf(MERGE) > -1, 'the raw source still holds the old merge in its was: comment');
        assert.deepStrictEqual(liveLines(src, MERGE), [], 'no live inheritance merge');
    });
    it('the instance merge is performed once, and the dispatch follows it', function () {
        assert.strictEqual(liveLines(src, INSTANCE).length, 1, 'exactly one instance merge');
        assert.ok(src.indexOf(DISPATCH) > src.indexOf(INSTANCE), 'dispatch after the instance merge');
    });
});

describe('02 - replica DERIVED from the source: what construct() runs after its $instance literal', function () {
    var region, oldBlock;
    before(function () {
        var src = fs.readFileSync(MAIN, 'utf8');
        var lit   = src.indexOf("'money'             : money");
        var start = src.indexOf('};', lit) + 2;
        var stop  = src.indexOf('registerEvents(this.plugin, events);', start);
        assert.ok(lit > -1 && start > 1 && stop > start, 'the region between the $instance literal and registerEvents');
        region = src.slice(start, stop);
        assert.strictEqual(liveLines(region, INSTANCE).length, 1, 'the region holds the instance merge');
        // the pre-#B1130 block: from the fix's `was:` comment; on a pre-fix source, the live region itself
        oldBlock = oldBlockFromComment(src) || region.replace(INSTANCE, '');
        oldBlock = oldBlock.slice(oldBlock.indexOf('try {'));
    });
    function run(code, parent, win) {
        var fn = new Function('parent', 'window', 'merge', '$instance', code + '\nreturn { window: window, instance: $instance };');
        return fn(parent, win, merge, freshInstance());
    }
    function sameOriginParent() {
        return { window: { gina: { isFrameworkLoaded: true, hasPopinHandler: true, popinContainer: 'gina-popins-parent', fromParent: 1 } } };
    }
    it('a cross-origin parent: nothing is thrown, the frame keeps its own fresh instance', function () {
        var out; assert.doesNotThrow(function () { out = run(region, crossOriginParent(), { gina: { _global: 1 } }); });
        assert.strictEqual(out.instance.hasPopinHandler, false);
        assert.strictEqual(out.instance.isFrameworkLoaded, false);
    });
    it('a same-origin parent carrying an instance: not inherited — the frame keeps its own fresh instance', function () {
        var out = run(region, sameOriginParent(), { gina: { _global: 1 } });
        assert.strictEqual(out.instance.isFrameworkLoaded, false, 'its own boot state');
        assert.strictEqual(out.instance.hasPopinHandler, false, 'its own popin state');
        assert.strictEqual(typeof out.instance.popinContainer, 'undefined', 'no parent container id');
        assert.strictEqual(typeof out.instance.fromParent, 'undefined', 'nothing of the parent');
        assert.strictEqual(out.instance._global, 1, 'the core.js object it started from is kept');
    });
    it('a top-level page (parent === window, no instance yet): its fresh instance, nothing thrown', function () {
        var win = {}; var out = run(region, { window: win }, win);
        assert.strictEqual(out.instance.hasPopinHandler, false);
    });
    it('control — the pre-#B1130 block DOES inherit the parent\'s per-document values (the replica can tell)', function () {
        assert.ok(oldBlock.indexOf(MERGE) > -1 && oldBlock.indexOf('try {') === 0, 'the old block is recovered');
        var out = run(oldBlock + '\n' + INSTANCE, sameOriginParent(), { gina: { _global: 1 } });
        assert.strictEqual(out.instance.hasPopinHandler, true, 'the parent\'s flag beats the fresh default (lib/merge keeps the target)');
        assert.strictEqual(out.instance.popinContainer, 'gina-popins-parent', 'and the parent\'s container id is copied');
    });
    it('control — the pre-#B486 shape (the old block without its guard) DOES throw under the cross-origin parent', function () {
        var unguarded = oldBlock.replace(/^try \{\s*/, '').replace(/\}\s*catch \(\w+\) \{[\s\S]*\}\s*$/, '');
        assert.ok(unguarded.indexOf('try {') === -1 && unguarded.indexOf(READ) > -1, 'guard stripped, read kept');
        assert.throws(function () { run(unguarded, crossOriginParent(), {}); }, function (e) { return e.name === 'SecurityError'; });
    });
});

// ─── 03 — built-bundle pins (validated RED on the pre-fix dist through the B486_BUNDLE* seams) ──

describe('03 - built-bundle pins: no read of the parent frame survives r.js and Closure', function () {
    var js, min;
    before(function () { js = fs.readFileSync(BUNDLE, 'utf8'); min = fs.readFileSync(BUNDLE_MIN, 'utf8'); });

    it('gina.js (r.js concatenation, source verbatim with its comments): no live read, the was: comment kept', function () {
        assert.ok(js.indexOf(READ) > -1, 'the raw bundle still holds the old read in the was: comment');
        assert.deepStrictEqual(liveLines(js, READ), [], 'no live read');
        assert.deepStrictEqual(liveLines(js, MERGE), [], 'no live inheritance merge');
    });
    it('gina.min.js (Closure, comments removed): no parent.window.gina at all — fixed-string needles', function () {
        assert.strictEqual(min.split('parent.window.gina').length - 1, 0, 'no read and no merge of the parent frame\'s instance');
        assert.ok(min.indexOf('ginaloaded') > -1, 'control — the boot dispatch is in this bundle');
    });
});
