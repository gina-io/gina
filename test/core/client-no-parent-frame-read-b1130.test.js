'use strict';
/**
 * #B1130 — no client module under vendor/gina/ reads its parent or top frame.
 *
 * Up to 0.7.10, construct() (vendor/gina/main.js) merged `parent.window['gina']` into the instance
 * of a page loaded in a frame: under a same-origin parent the frame inherited the parent's
 * per-document state, so its loader, popin, validator and navigation boots were skipped and
 * `new Popin()` failed on the parent's container id (gh#103); under a cross-origin parent the read
 * threw `SecurityError` (#B486, then wrapped in a try/catch). #B1130 removed the read: every
 * document has its own instance. This file guards the whole client source tree so that no later
 * change reads the parent or the top frame again: no CODE line under
 * core/asset/plugin/src/vendor/gina/ may read `parent.window`, `parent.document`, `parent.location`,
 * `parent.gina`, `parent.frames`, `parent[...]`, `window.parent`, `window.top` or the same members
 * of a bare `top`. Comment lines (starting with `//`, `*` or `/*`) are excluded; the vendored
 * `psl/` build is not ours and is skipped; `window.opener` (the Inspector's own window) is out of
 * scope.
 *
 * Controls: the scanner fires on the pre-#B1130 lines and on synthetic reads, and stays silent on
 * look-alikes (`el.style.top`, `rect.top.toFixed()`, `node.parentNode`, `this.parent`, a
 * `{ top: 0 }` literal, a `/^(self|parent|top)$/` target check); the comment filter excludes the
 * three comment shapes; main.js's RAW text still names `parent.window` (the fix keeps the old
 * block in a `was:` comment), so the exclusion has something to exclude.
 *
 * Seam: `B1130_SRC_ROOT` points the tree scan at another copy (red-first: develop's tree before
 * the fix holds the read at main.js `construct()`).
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var path = require('path');

var FW   = process.env.B1130_FW || require('../fw');
var ROOT = process.env.B1130_SRC_ROOT || path.join(FW, 'core/asset/plugin/src/vendor/gina');

/**
 * Reads of the parent or the top frame. A bare `parent` / `top` must not follow a `.`, a word
 * character or `$`, so `node.parentNode`, `this.parent`, `rect.top.toFixed()` and `style.top`
 * stay out.
 * @type {RegExp[]}
 */
var FRAME_READS = [
    /(^|[^.\w$])parent\s*\.\s*(window|document|location|gina|frames)\b/,
    /(^|[^.\w$])parent\s*\[/,
    /\bwindow\s*\.\s*parent\b/,
    /\bwindow\s*\.\s*top\b/,
    /(^|[^.\w$])top\s*\.\s*(window|document|location|gina|frames)\b/,
    /(^|[^.\w$])top\s*\[/
];

/**
 * Whether one line is a comment line (`//`, a JSDoc ` * ` line, or a `/*` opener).
 * @param {string} line
 * @returns {boolean}
 */
function isCommentLine(line) {
    return /^\s*(\/\/|\*|\/\*)/.test(line);
}

/**
 * The code lines of `text` that read the parent or the top frame.
 * @param {string} text
 * @returns {Array<{line: number, text: string}>}
 */
function frameReads(text) {
    var out = [];
    text.split('\n').forEach(function (l, i) {
        if (isCommentLine(l)) { return; }
        if (FRAME_READS.some(function (re) { return re.test(l); })) { out.push({ line: i + 1, text: l.trim() }); }
    });
    return out;
}

/**
 * Every `.js` file under `dir`, the vendored `psl/` build excepted.
 * @param {string} dir
 * @returns {string[]}
 */
function clientSources(dir) {
    var out = [];
    (function walk(d) {
        fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
            var p = path.join(d, e.name);
            if (e.isDirectory()) {
                if (e.name === 'psl' || e.name === 'dist' || e.name === 'node_modules') { return; }
                walk(p);
            } else if (/\.js$/.test(e.name)) {
                out.push(p);
            }
        });
    })(dir);
    return out.sort();
}

describe('#B1130 — the client source tree reads no parent or top frame', function () {

    it('01 CONTROL: the scanner fires on parent and top frame reads, the pre-#B1130 lines included', function () {
        var reads = [
            "            if ( typeof(parent.window['gina']) != 'undefined' ) {",
            "                window['gina'] = merge((window['gina'] || {}), parent.window['gina']);",
            "var doc = parent.document;",
            "if (window.parent !== window) { x = 1; }",
            "var t = window.top;",
            "top.location.href = url;",
            "var g = parent['gina'];",
            "var f = top.frames[0];"
        ];
        reads.forEach(function (l) {
            assert.equal(frameReads(l).length, 1, 'the scanner should fire on: ' + l);
        });
    });

    it('02 CONTROL: the scanner stays silent on look-alikes', function () {
        var lookAlikes = [
            "var p = el.parentNode;",
            "var q = el.parentElement;",
            "this.parent = node;",
            "var y = rect.top.toFixed(2);",
            "el.style.top = '0px';",
            "area.scrollTo({ top: 0, behavior: 'smooth' });",
            "if ( /^(blank|self|parent|top)$/.test(target) ) { return; }",
            "var opener = window.opener;"
        ];
        lookAlikes.forEach(function (l) {
            assert.deepEqual(frameReads(l), [], 'the scanner should not fire on: ' + l);
        });
    });

    it('03 CONTROL: comment lines are excluded, in their three shapes', function () {
        var text = [
            "// var g = parent.window['gina'];",
            "     * reads `window.parent` in a JSDoc line",
            "    /* top.location */",
            "var live = window.parent;"
        ].join('\n');
        assert.deepEqual(frameReads(text).map(function (r) { return r.line; }), [4]);
    });

    it('04 CONTROL: the scan sees the client modules', function () {
        var files = clientSources(ROOT).map(function (f) { return path.relative(ROOT, f); });
        ['main.js', 'core.js', path.join('popin', 'main.js'), path.join('utils', 'loader.js')].forEach(function (f) {
            assert.ok(files.indexOf(f) > -1, f + ' should be scanned (found: ' + files.join(', ') + ')');
        });
        assert.ok(files.length >= 10, 'expected at least 10 client modules, found ' + files.length);
        assert.equal(files.filter(function (f) { return f.indexOf('psl' + path.sep) === 0; }).length, 0, 'psl/ is vendored and skipped');
    });

    it('05 CONTROL: main.js still names parent.window in its comments, so the exclusion has something to exclude', function () {
        var raw = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
        assert.ok(raw.indexOf('parent.window') > -1, 'main.js no longer mentions parent.window at all: the comment filter is untested');
    });

    it('06 no code line under vendor/gina/ reads the parent or the top frame', function () {
        var found = [];
        clientSources(ROOT).forEach(function (f) {
            frameReads(fs.readFileSync(f, 'utf8')).forEach(function (r) {
                found.push(path.relative(ROOT, f) + ':' + r.line + '  ' + r.text);
            });
        });
        assert.deepEqual(found, [], 'parent or top frame reads:\n' + found.join('\n'));
    });
});
