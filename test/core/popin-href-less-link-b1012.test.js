/**
 * #B1012 — a click on an enabled `<a>` with no `href` in popin content left `$popin.isRedirecting` set, so
 * `gina.popin.close(name)` and a form's `close()` did nothing afterwards.
 *
 * popinBind's bind loop gives such an anchor `href="#"` and a `popin.click.*` id, and sets `isLink` to false;
 * register() then binds it as an action, which loads nothing. The link's own click listener (the one that sets
 * the flag before a load) was attached whenever the anchor's `href` was not empty, and the `href="#"` just
 * written passed that test, so the flag was set with no load to clear it. The listener is now attached only
 * when `isLink` is true: the anchor had an `href` of its own.
 *
 *   01 the source: the listener's condition tests `isLink` first, and `isLink` is set to false, for an anchor
 *      with no `href`, before that test
 *   02 the built bundles carry the change: gina.js (the same lines) and gina.min.js (its minified form, whose
 *      tested variable is the one the bind loop sets to false after writing `href="#"`)
 *
 * The browser flow (an href-less anchor clicked, then `gina.popin.close()`) is driven in
 * test/e2e/popin-href-less-link-b1012.spec.js.
 *
 * Seams, so the whole file runs against pre-fix bytes without touching the tree:
 *   GINA_B1012_POPIN_SRC=<a copy of popin/main.js>   (01)
 *   GINA_B1012_DIST_DIR=<a directory holding gina.js and gina.min.js>   (02)
 *
 * Usage: node --test test/core/popin-href-less-link-b1012.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC_PATH = process.env.GINA_B1012_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var DIST_DIR       = process.env.GINA_B1012_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

var popinSrc     = fs.readFileSync(POPIN_SRC_PATH, 'utf8');
var IS_LINK_OFF  = 'isLink = false;';
var HREF_HASH    = '$link[i].setAttribute(\'href\', \'#\');';
var LISTENER     = 'addListener(gina, $link[i], \'click\', function(linkEvent) {';
var NEW_COND     = 'if ( isLink && !/^(null|\\s*)$/.test($link[i].getAttribute(\'href\')) ) {';
var OLD_COND     = 'if ( !/^(null|\\s*)$/.test($link[i].getAttribute(\'href\')) ) {';

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

/**
 * The pins shared by the source and gina.js: the listener's condition tests `isLink`, `isLink` is set to false
 * (after `href="#"` is written) before it, and the condition still guards the link's click listener.
 * @inner
 * @param {string} code - comment-stripped text
 */
function assertGuardedByIsLink(code) {
    assert.equal(count(code, NEW_COND), 1, 'the listener is attached only when isLink');
    assert.equal(count(code, OLD_COND), 0, 'the condition without isLink is gone');
    var at = code.indexOf(NEW_COND);
    assert.ok(/^\s*addListener\(gina, \$link\[i\], 'click', function\(linkEvent\) \{/.test(code.slice(at + NEW_COND.length)),
        'the condition guards the link\'s click listener');
    assert.ok(code.indexOf(HREF_HASH) < code.indexOf(IS_LINK_OFF) && code.indexOf(IS_LINK_OFF) < at,
        '`href="#"` is written, then isLink set to false, before the condition');
}

var srcCode = stripLineComments(popinSrc);

describe('#B1012 01 - the source: the link listener is attached only to an anchor that had an href', function () {

    it('control: the bind loop writes href="#" and sets isLink to false once, and the listener is found once', function () {
        assert.equal(count(srcCode, HREF_HASH), 1);
        assert.equal(count(srcCode, IS_LINK_OFF), 1);
        assert.equal(count(srcCode, LISTENER), 1);
    });

    it('the listener\'s condition tests isLink, set to false for an anchor with no href before it (comments dropped first; the raw text keeps the `// was:` line)', function () {
        assertGuardedByIsLink(srcCode);
        assert.equal(count(popinSrc, '// was: ' + OLD_COND), 1, 'raw-text control: the replaced condition is kept as a comment');
    });
});

describe('#B1012 02 - the built bundles carry the change', function () {

    var distJs  = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var distMin = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8').replace(/\n/g, '');
    var distCode = stripLineComments(distJs);
    // …Nb=!0,ua=na[fa].getAttribute('href'),ua&&ua!=''&&ua!='#'||(ua!='#'&&na[fa].setAttribute('href','#'),Nb=!1),…
    // …Eb||(Nb&&!/^(null|\s*)$/.test(na[fa].getAttribute('href'))&&addListener(gina,na[fa],'click',function(Ab){…
    var MIN_ANCHOR  = /\/\^\(null\|\\s\*\)\$\/\.test\(/g;
    var MIN_IS_LINK = /([\w$]+)=!0,([\w$]+)=([\w$]+)\[([\w$]+)\]\.getAttribute\('href'\),\2&&\2!=''&&\2!='#'\|\|\(\2!='#'&&\3\[\4\]\.setAttribute\('href','#'\),\1=!1\)/g;
    var MIN_NEW     = /([\w$]+)&&!\/\^\(null\|\\s\*\)\$\/\.test\(([\w$]+)\[([\w$]+)\]\.getAttribute\('href'\)\)&&addListener\(gina,\2\[\3\],'click',function\(/g;
    var MIN_OLD     = /\(\/\^\(null\|\\s\*\)\$\/\.test\(([\w$]+)\[([\w$]+)\]\.getAttribute\('href'\)\)\|\|addListener\(gina,\1\[\2\],'click',function\(/g;

    it('control: each bundle carries the bind loop and the listener\'s test once', function () {
        assert.equal(count(distCode, HREF_HASH), 1);
        assert.equal(count(distCode, IS_LINK_OFF), 1);
        assert.equal(count(distCode, LISTENER), 1);
        assert.equal((distMin.match(MIN_ANCHOR) || []).length, 1);
        assert.equal((distMin.match(MIN_IS_LINK) || []).length, 1);
    });

    it('gina.js: the same condition as the source', function () {
        assertGuardedByIsLink(distCode);
    });

    it('gina.min.js: the listener is attached only when the bind loop\'s isLink is true', function () {
        assert.equal((distMin.match(MIN_OLD) || []).length, 0, 'the shipped form, without isLink, is gone');
        var found = distMin.match(new RegExp(MIN_NEW.source));
        assert.ok(found, 'the minified condition tests a variable before the href');
        var isLink = distMin.match(new RegExp(MIN_IS_LINK.source))[1];
        assert.equal(found[1], isLink, 'the tested variable is the one set to false after href="#" is written');
        assert.equal((distMin.match(MIN_NEW) || []).length, 1);
    });
});
