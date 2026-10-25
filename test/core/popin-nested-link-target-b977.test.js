/**
 * #B977 — a click on markup nested inside an `<a target="…">` in popin content loaded the link's page into the
 * popin instead of opening its window.
 *
 * The popin guide promises that a link with a `target` opens that window as usual, while a plain link (no `id`,
 * no `#` in its URL, no `target`) loads its page into the same popin. `register()`'s click listener (popin
 * plugin) is bound on the link, but its link branch read `href` and `target` from `event.target`, the node the
 * user clicked: a click on a `<span>` (an icon, a label) inside a `target` link read no `target`, took the
 * in-popin branch and loaded the link's page into the popin. It now reads both from `event.currentTarget`, the
 * link the listener is bound on. The in-popin dispatch keeps `event.target`: its event bubbles to the link's own
 * listener, which loads `$element.href`.
 *
 *   01 the source: the link branch reads `href` and `target` from `event.currentTarget`, never from `event.target`
 *   02 the built bundles carry the change: gina.js (the same lines) and gina.min.js (its minified form)
 *
 * The browser flows are driven in test/e2e/popin-nested-link-target-b977.spec.js.
 *
 * Seams, so the whole file runs against pre-fix bytes without touching the tree:
 *   GINA_B977_POPIN_SRC=<a copy of popin/main.js>   (01)
 *   GINA_B977_DIST_DIR=<a directory holding gina.js and gina.min.js>   (02)
 * RED-FIRST, measured 2026-10-25 on develop dc4d3d5b1's popin/main.js, gina.js and gina.min.js (git show): the
 * two read pins of 01 and the two bundle pins of 02 fail, each on its own first assertion (the new `href` read
 * absent, an `event.target` read present, gina.js's new `href` read absent, the minified shape absent); the two
 * controls pass. The minified negative pin matches once in those bytes and never in the rebuilt ones.
 *
 * Usage: node --test test/core/popin-nested-link-target-b977.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC_PATH = process.env.GINA_B977_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var DIST_DIR       = process.env.GINA_B977_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

var popinSrc = fs.readFileSync(POPIN_SRC_PATH, 'utf8');
var LINK_BRANCH = "if ( type == 'link' ) {";
var NEW_HREF    = "var linkHref = event.currentTarget.getAttribute('href') || null;";
var NEW_TARGET  = "var linkTarget = event.currentTarget.getAttribute('target');";
var OLD_READ    = /event\.target\.getAttribute\('(href|target)'\)/;
var WINDOW_OPEN = 'var _window = window.open(linkHref, linkTarget);';
var DISPATCH    = 'triggerEvent(gina, event.target, event.currentTarget.id, $popin);';

/**
 * The block opened by `token`, up to its closing brace: a brace walk that skips comments and string literals
 * (the same walk as validator-upload-trigger-warning-b292.test.js).
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

var branch = blockSlice(popinSrc, LINK_BRANCH);
var branchCode = stripLineComments(branch);

describe('#B977 01 - the source: the link branch reads the link the listener is bound on', function () {

    it('control: the link branch is found once, and still opens the window or dispatches the in-popin load', function () {
        assert.equal(count(popinSrc, LINK_BRANCH), 1);
        assert.equal(count(branchCode, WINDOW_OPEN), 1);
        assert.equal(count(branchCode, DISPATCH), 1);
    });

    it('`href` and `target` are read from `event.currentTarget`, before the window opens', function () {
        assert.equal(count(branchCode, NEW_HREF), 1);
        assert.equal(count(branchCode, NEW_TARGET), 1);
        assert.ok(branchCode.indexOf(NEW_TARGET) < branchCode.indexOf(WINDOW_OPEN), 'the target is read before window.open');
    });

    it('no `href` or `target` read from `event.target` is left (comments dropped first; the raw text keeps the `// was:` lines)', function () {
        assert.equal(OLD_READ.test(branchCode), false);
        assert.equal(count(branch, '// was: var link'), 2, 'raw-text control: the replaced reads are kept as comments');
    });
});

describe('#B977 02 - the built bundles carry the change', function () {

    var distJs  = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var distMin = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8').replace(/\n/g, '');
    // var Cb=Gb.currentTarget.getAttribute('href')||null,Tb=Gb.currentTarget.getAttribute('target');Tb!=null&&Tb!=''?(window.open(Cb,Tb),…
    var MIN_NEW = /var ([\w$]+)=([\w$]+)\.currentTarget\.getAttribute\('href'\)\|\|null,([\w$]+)=\2\.currentTarget\.getAttribute\('target'\);\3!=null&&\3!=''\?\(window\.open\(\1,\3\)/g;
    var MIN_OLD = /var ([\w$]+)=([\w$]+)\.target\.getAttribute\('href'\)\|\|null,([\w$]+)=\2\.target\.getAttribute\('target'\);\3!=null&&\3!=''\?\(window\.open\(\1,\3\)/g;
    // …?(window.open(Cb,Tb),u.isRedirecting=!1):triggerEvent(gina,Gb.target,Gb.currentTarget.id,u), unchanged by the fix
    var MIN_DISPATCH = /\?\(window\.open\(([\w$]+),([\w$]+)\),([\w$]+)\.isRedirecting=!1\):triggerEvent\(gina,([\w$]+)\.target,\4\.currentTarget\.id,\3\)/g;

    it('control: each bundle carries the link branch once', function () {
        assert.equal(count(distJs, LINK_BRANCH), 1);
        assert.equal(count(stripLineComments(distJs), WINDOW_OPEN), 1);
        assert.equal((distMin.match(MIN_DISPATCH) || []).length, 1);
    });

    it('gina.js: the same reads as the source', function () {
        var code = stripLineComments(blockSlice(distJs, LINK_BRANCH));
        assert.equal(count(code, NEW_HREF), 1);
        assert.equal(count(code, NEW_TARGET), 1);
        assert.equal(OLD_READ.test(code), false);
    });

    it('gina.min.js: both reads come from the element the listener is bound on', function () {
        assert.equal((distMin.match(MIN_NEW) || []).length, 1);
        assert.equal((distMin.match(MIN_OLD) || []).length, 0, 'the shipped form, read from the clicked node');
    });
});
