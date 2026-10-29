/**
 * #B994 (+ #B1007, #B1008) — a link carrying `disabled` in popin content was honored in no shape.
 *
 *   #B1008 — a link carrying `disabled` when the content was bound was skipped at bind time, so the browser
 *            followed it: a click anywhere on it navigated the page, it stayed unbound once `disabled` was
 *            removed, and `disabled="false"` was skipped too.
 *   #B994  — `register()`'s click gate read `disabled` from `event.target`, the node clicked: on a link
 *            disabled after the bind, a click on its child (an icon, a label) passed the gate and loaded the
 *            link into the popin, while a click on the link itself was ignored.
 *   #B1007 — the link's own click listener set `$popin.isRedirecting` before that gate ignored the click, so
 *            no load cleared it and `gina.popin.close(name)` / a form's `close()` did nothing afterwards.
 *
 * Now every link with an `href` is bound, the gate reads `event.currentTarget` (the element register() bound,
 * link or close button), and the link's listener starts no redirect for a disabled link: an element carrying
 * `disabled` (any value but "false") does nothing when clicked, wherever the click lands. An `<a>` with no
 * `href` carrying `disabled` is still skipped at bind time, as before: binding it would write `href="#"` and
 * an id on it, making a disabled control focusable while it does nothing.
 *
 *   01 the source: the gate, the redirect flag and the bind loop
 *   02 the built bundles carry the change: gina.js (the same lines) and gina.min.js (its minified form)
 *
 * The browser flows are driven in test/e2e/popin-disabled-link-b994.spec.js.
 *
 * Seams, so the whole file runs against pre-fix bytes without touching the tree:
 *   GINA_B994_POPIN_SRC=<a copy of popin/main.js>   (01)
 *   GINA_B994_DIST_DIR=<a directory holding gina.js and gina.min.js>   (02)
 *
 * Usage: node --test test/core/popin-disabled-link-b994.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC_PATH = process.env.GINA_B994_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var DIST_DIR       = process.env.GINA_B994_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

// At line start: the file repeats the declaration in its own `} // EO var register = …` closing comment.
var REGISTER_RE    = /^[ \t]*var register = function \(type, evt, \$element\) \{/m;
var REGISTER_END   = '// EO var register';
var GATE_IN        = "!('disabled' in event.currentTarget)";
var GATE_ATTR      = "&& event.currentTarget.getAttribute('disabled') != null && event.currentTarget.getAttribute('disabled') != 'false'";
var GATE_OLD_IN    = "('disabled' in event.target)";
var FLAG_LISTENER  = "addListener(gina, $link[i], 'click', function(linkEvent) {";
var FLAG_READ      = 'var $clickedLink = linkEvent.currentTarget;';
var FLAG_IN        = "!('disabled' in $clickedLink)";
var FLAG_SET       = '$popin.isRedirecting = true;';
var SKIP_OLD       = "if ( $link[i].getAttribute('disabled') != null ) {";
var SKIP_NOHREF    = "if ( !$link[i].getAttribute('href') && $link[i].getAttribute('disabled') != null ) {";
var LINK_ID_STAMP  = "$link[i]['id'] =  ( /^null$/i.test($link[i].getAttribute('id')) ) ? null : $link[i].getAttribute('id');";

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
    var i = src.indexOf('{', start + token.length - 1), depth = 0, c = null, next = null, end = -1;
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
 * The text between a start landmark and the first end landmark after it.
 * @inner
 * @param {string} src
 * @param {RegExp} from
 * @param {string} to
 * @returns {string}
 */
function region(src, from, to) {
    var m = src.match(from);
    assert.ok(m, 'start landmark not found: ' + from);
    var a = src.indexOf(m[0]);
    var b = src.indexOf(to, a + m[0].length);
    assert.ok(b > -1, 'end landmark not found: ' + to);
    return src.slice(a, b);
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

/**
 * The three source checks, shared by the source and gina.js.
 * @inner
 * @param {string} text - popin/main.js, or the gina.js bundle carrying it verbatim
 * @returns {void}
 */
function checkSource(text) {
    var reg = stripLineComments(region(text, REGISTER_RE, REGISTER_END));
    assert.equal(count(reg, GATE_IN), 1, 'the gate tests `disabled` in the bound element');
    assert.equal(count(reg, GATE_ATTR), 1, 'the gate reads the attribute from the bound element');
    assert.equal(count(reg, GATE_OLD_IN), 0, 'no gate in register() reads the clicked node');

    var flag = stripLineComments(blockSlice(text, FLAG_LISTENER));
    assert.equal(count(flag, FLAG_READ), 1);
    assert.equal(count(flag, FLAG_IN), 1);
    assert.ok(flag.indexOf('return;') > -1 && flag.indexOf('return;') < flag.indexOf(FLAG_SET),
        'a disabled link returns before the redirect flag is set');

    var code = stripLineComments(text);
    assert.equal(count(code, SKIP_OLD), 0, 'no link with an `href` is skipped at bind time for carrying `disabled`');
    assert.equal(count(code, SKIP_NOHREF), 1, 'an `<a>` with no `href` carrying `disabled` is still skipped');
    assert.ok(code.indexOf(SKIP_NOHREF) < code.indexOf(LINK_ID_STAMP),
        'the skip runs before the bind loop writes an id on the link');
}

describe('#B994 01 - the source: the gate, the redirect flag and the bind loop', function () {

    var popinSrc = fs.readFileSync(POPIN_SRC_PATH, 'utf8');

    it('control: each landmark is found once', function () {
        assert.equal((popinSrc.match(new RegExp(REGISTER_RE.source, 'gm')) || []).length, 1);
        assert.equal(count(popinSrc, FLAG_LISTENER), 1);
    });

    it('register()\'s gate reads the bound element, the flag skips a disabled link, and only an <a> with no href is skipped at bind time', function () {
        checkSource(popinSrc);
        assert.equal(count(popinSrc, '// was: !(\'disabled\' in event.target)'), 1, 'raw-text control: the replaced gate is kept as a comment');
        assert.equal(count(popinSrc, '// was: ' + SKIP_OLD), 1, 'raw-text control: the replaced skip is kept as a comment');
    });
});

describe('#B994 02 - the built bundles carry the change', function () {

    var distJs  = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var distMin = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8').replace(/\n/g, '');
    // cancelEvent(Gb);if(!('disabled'in Gb.currentTarget)&&Gb.currentTarget.getAttribute('disabled')!=null&&…!='false')return!1;if(vb=='link'){
    // The trailing `=='link'` keeps the pin on register()'s listener: the legacy document click proxy keeps
    // its own `.target` gate on purpose, followed by its `popin.close.` test.
    var MIN_GATE_NEW = /cancelEvent\(([\w$]+)\);if\(!\('disabled'in \1\.currentTarget\)&&\1\.currentTarget\.getAttribute\('disabled'\)!=null&&\1\.currentTarget\.getAttribute\('disabled'\)!='false'\)return!1;if\([\w$]+=='link'\)/g;
    var MIN_GATE_OLD = /cancelEvent\(([\w$]+)\);if\(!\('disabled'in \1\.target\)&&\1\.target\.getAttribute\('disabled'\)!=null&&\1\.target\.getAttribute\('disabled'\)!='false'\)return!1;if\([\w$]+=='link'\)/g;
    // .preventDefault();var Mb=vb.currentTarget;if('disabled'in Mb||Mb.getAttribute('disabled')==null||…=='false')if(u.isRedirecting=!0,…
    var MIN_FLAG_NEW = /\.preventDefault\(\);var ([\w$]+)=[\w$]+\.currentTarget;if\('disabled'in \1\|\|\1\.getAttribute\('disabled'\)==null\|\|\1\.getAttribute\('disabled'\)=='false'\)if\([\w$]+\.isRedirecting=!0/g;
    var MIN_FLAG_OLD = /\.preventDefault\(\);([\w$]+)\.isRedirecting=!0;if\(\1\.hasForm\)/g;
    // the pre-fix bind loop: na[fa].getAttribute('disabled')==null&&(na[fa].id=/^null$/i.test(…
    var MIN_SKIP_OLD = /([\w$]+)\[([\w$]+)\]\.getAttribute\('disabled'\)==null&&\(\1\[\2\]\.id=\/\^null\$\/i\.test\(/g;
    // the skip kept for an <a> with no href: if(na[fa].getAttribute('href')||na[fa].getAttribute('disabled')==null)na[fa].id=/^null$/i.test(…
    var MIN_SKIP_NOHREF = /if\(([\w$]+)\[([\w$]+)\]\.getAttribute\('href'\)\|\|\1\[\2\]\.getAttribute\('disabled'\)==null\)\1\[\2\]\.id=\/\^null\$\/i\.test\(/g;

    it('control: each bundle carries register()\'s listener and the link loop once', function () {
        assert.equal((distJs.match(new RegExp(REGISTER_RE.source, 'gm')) || []).length, 1);
        assert.equal(count(distJs, FLAG_LISTENER), 1);
        assert.equal((distMin.match(/\.id=\/\^null\$\/i\.test\(/g) || []).length, 1);
    });

    it('gina.js: the same three changes as the source', function () {
        checkSource(distJs);
    });

    it('gina.min.js: the gate reads the bound element, the flag skips a disabled link, and the bind-time skip keeps only an <a> with no href', function () {
        assert.equal((distMin.match(MIN_GATE_NEW) || []).length, 1);
        assert.equal((distMin.match(MIN_GATE_OLD) || []).length, 0, 'the shipped gate, read from the clicked node');
        assert.equal((distMin.match(MIN_FLAG_NEW) || []).length, 1);
        assert.equal((distMin.match(MIN_FLAG_OLD) || []).length, 0, 'the shipped flag, set before the gate');
        assert.equal((distMin.match(MIN_SKIP_OLD) || []).length, 0, 'the shipped bind-time skip of every disabled link');
        assert.equal((distMin.match(MIN_SKIP_NOHREF) || []).length, 1, 'the skip kept for an <a> with no href');
    });
});
