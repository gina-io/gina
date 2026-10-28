/**
 * #B995 — a click on markup added inside a dual-role element (a legacy trigger that is also a
 * `.gina-popin-close`) after `bindOpen` stamped it dispatched nothing.
 *
 * `register()`'s close branch treats an element whose id is a `popin.click.*` trigger id as the sole
 * exception to closing (#B301): it dispatches that trigger instead. It tested the id on
 * `event.currentTarget`, the element the listener is bound on, but then read the event name from
 * `event.target.id`, the node actually clicked, and dispatched on that node. Markup present when
 * `bindOpen` ran gets its own `proxyClick` listener and never reaches this branch; markup added
 * later does, and its id (`''`) matched nothing, so the click did nothing (`cancelEvent` had
 * already run). The branch now reads the id from, and dispatches on, `event.currentTarget`.
 *
 *   01 the source: the dual-role branch reads the event name from `event.currentTarget` and
 *      dispatches on it, never on `event.target`
 *   02 the built bundles carry the change: gina.js (the same lines) and gina.min.js (its minified form)
 *
 * The browser flow (the element bound by popinBind before bindOpen, then a late node clicked) is
 * driven in test/e2e/popin-dual-trigger-nested-b995.spec.js.
 *
 * Seams, so the whole file runs against pre-fix bytes without touching the tree:
 *   GINA_B995_POPIN_SRC=<a copy of popin/main.js>   (01)
 *   GINA_B995_DIST_DIR=<a directory holding gina.js and gina.min.js>   (02)
 *
 * Usage: node --test test/core/popin-dual-trigger-nested-b995.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC_PATH = process.env.GINA_B995_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var DIST_DIR       = process.env.GINA_B995_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

var popinSrc = fs.readFileSync(POPIN_SRC_PATH, 'utf8');
var DUAL_BRANCH = 'if ( _isClickTrigger ) {';
var NEW_READ    = 'var _evt = event.currentTarget.id;';
var NEW_FIRE    = 'triggerEvent(gina, event.currentTarget, _evt, event.detail);';
var CANCEL      = 'cancelEvent(event);';

/**
 * The block opened by `token`, up to its closing brace: a brace walk that skips comments and string literals
 * (the same walk as popin-nested-link-target-b977.test.js).
 * @inner
 * @param {string} src
 * @param {string} token
 * @returns {string}
 */
function blockSlice(src, token) {
    var start = src.indexOf(token);
    assert.ok(start > -1, 'block anchor not found: ' + token);
    var i = src.indexOf('{', start), depth = 0, c = null, next = null, end = -1;
    for (; i < src.length; i++) {
        c = src[i];
        next = src[i + 1];
        if (c === '/' && next === '/') { i = src.indexOf('\n', i); continue; }
        if (c === '/' && next === '*') { end = src.indexOf('*/', i + 2); i = end + 1; continue; }
        if (c === '\'' || c === '"' || c === '`') {
            for (i++; i < src.length && src[i] !== c; i++) { if (src[i] === '\\') { i++; } }
            continue;
        }
        if (c === '{') { depth++; } else if (c === '}' && --depth === 0) { return src.substring(start, i + 1); }
    }
    assert.fail('unbalanced braces after: ' + token);
}

/**
 * Drops the full-line `//` comments, so a `// was:` line keeping the old code cannot satisfy a pin.
 * @inner
 * @param {string} text
 * @returns {string}
 */
function stripLineComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

/**
 * Non-overlapping occurrences of `needle` in `hay`.
 * @inner
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function count(hay, needle) {
    var n = 0, i = hay.indexOf(needle);
    while (i > -1) { n++; i = hay.indexOf(needle, i + needle.length); }
    return n;
}

var branch = blockSlice(popinSrc, DUAL_BRANCH);
var branchCode = stripLineComments(branch);

describe('#B995 01 - the source: the dual-role branch dispatches the element its listener is bound on', function () {

    it('control: the branch is found once, and still cancels the click before dispatching', function () {
        assert.equal(count(popinSrc, DUAL_BRANCH), 1);
        assert.equal(count(branchCode, CANCEL), 1);
        assert.ok(branchCode.indexOf(CANCEL) < branchCode.indexOf('triggerEvent('), 'the click is cancelled first');
    });

    it('the event name is read from `event.currentTarget`, and the trigger is dispatched on it', function () {
        assert.equal(count(branchCode, NEW_READ), 1);
        assert.equal(count(branchCode, NEW_FIRE), 1);
        assert.ok(branchCode.indexOf(NEW_READ) < branchCode.indexOf(NEW_FIRE), 'the name is read before the dispatch');
    });

    it('nothing in the branch reads `event.target` any more (comments dropped first; the raw text keeps the `// was:` lines)', function () {
        assert.equal(branchCode.indexOf('event.target'), -1);
        assert.equal(count(branch, '// was: var _evt = event.target.id;'), 1, 'raw-text control: the replaced read is kept as a comment');
        assert.equal(count(branch, '// was: triggerEvent(gina, event.target, _evt, event.detail);'), 1, 'raw-text control: the replaced dispatch is kept as a comment');
    });
});

describe('#B995 02 - the built bundles carry the change', function () {

    var distJs  = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var distMin = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8').replace(/\n/g, '');
    // …Cb=/^popin\.click\./.test(Gb.currentTarget.id),Cb||(…),Cb&&(cancelEvent(Gb),Cb=Gb.currentTarget.id,ta.test(Cb)&&triggerEvent(gina,Gb.currentTarget,Cb,Gb.detail))
    // The anchor is the branch's own test on `currentTarget.id`: the document click proxy (#B1009) tests
    // and dispatches `.target` on purpose, so a bundle-wide `.target` absence would be the wrong pin.
    var MIN_ANCHOR = /=\/\^popin\\\.click\\\.\/\.test\(([\w$]+)\.currentTarget\.id\)/g;
    var MIN_NEW = /cancelEvent\(([\w$]+)\),([\w$]+)=\1\.currentTarget\.id,([\w$]+)\.test\(\2\)&&triggerEvent\(gina,\1\.currentTarget,\2,\1\.detail\)/g;
    var MIN_OLD = /cancelEvent\(([\w$]+)\),([\w$]+)=\1\.target\.id,([\w$]+)\.test\(\2\)&&triggerEvent\(gina,\1\.target,\2,\1\.detail\)\)\}\)\}/g;

    it('control: each bundle carries the dual-role branch once', function () {
        assert.equal(count(distJs, DUAL_BRANCH), 1);
        assert.equal((distMin.match(MIN_ANCHOR) || []).length, 1);
    });

    it('gina.js: the same reads as the source', function () {
        var code = stripLineComments(blockSlice(distJs, DUAL_BRANCH));
        assert.equal(count(code, NEW_READ), 1);
        assert.equal(count(code, NEW_FIRE), 1);
        assert.equal(code.indexOf('event.target'), -1);
    });

    it('gina.min.js: the minified branch dispatches the element the listener is bound on', function () {
        assert.equal((distMin.match(MIN_NEW) || []).length, 1);
        var at = distMin.search(MIN_ANCHOR);
        assert.ok(at > -1, 'anchor found');
        var tail = distMin.slice(at, at + 400);
        assert.equal((tail.match(MIN_OLD) || []).length, 0, 'the shipped form, read from the clicked node, is gone from the branch');
    });
});
