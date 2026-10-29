/**
 * #B990 — a re-bind of a form (`$forms[id].reBind()`, `.bind()`, a bind after `destroy()`) while a file
 * input showed files it had staged ran bindForm's saved-file pass again: it reset the input's entries
 * (`customFiles`) and read every file node of `<input id>-preview` as a saved file. An image staged became a
 * saved entry and warned « did not find `upload delete trigger` » for a link the page never had; a file
 * shown without an image (a PDF with no thumbnail) left no entry at all, so its reset did nothing and the
 * form saved the file the user had removed; beside an image on a `multiple` input, its reset removed the
 * image instead. The pass is now skipped while one of the input's staged entries (an entry with no
 * `deleteLinkId`) still has its reset control `<input id>-<index>-reset-trigger` on the page
 * (`hasLiveStagedFiles`); once the page has replaced the container, the controls are gone and the pass
 * reads it again.
 *
 *   01 the source: the helper is declared once and the saved-file pass's condition calls it
 *   02 the helper, extracted from the source and run with a fake document: live staged entries, stale
 *      ones, saved entries, no entries
 *   03 the built bundles carry the change: gina.js (the same helper and call) and gina.min.js (their
 *      minified forms)
 *
 * The browser flows are driven in test/e2e/validator-upload-rebind-b990.spec.js.
 *
 * Seams, so the whole file runs against pre-fix bytes without touching the tree:
 *   GINA_B990_VALIDATOR_SRC=<a copy of src/main.js>   (01, 02)
 *   GINA_B990_DIST_DIR=<a directory holding gina.js and gina.min.js>   (03)
 * RED-FIRST, measured 2026-10-29 on develop c91fbf88f's src/main.js, gina.js and gina.min.js: every pin
 * of 01, 02 and 03 fails on its own assertion (02 cannot find the helper); the controls (the saved-file
 * pass found once, each bundle carrying the pass) pass.
 *
 * Usage: node --test test/core/validator-upload-rebind-b990.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var MAIN_SRC_PATH = process.env.GINA_B990_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST_DIR      = process.env.GINA_B990_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

var mainSrc = fs.readFileSync(MAIN_SRC_PATH, 'utf8');
var DECL = 'var hasLiveStagedFiles = function';
var PASS_TAIL = "                    && !/none/i.test($previewContainer.parentElement.style.display)\n";
var CALL = '                    && !hasLiveStagedFiles($uploadTrigger)\n                ) {';
var PASS_BODY = "var $deleteLink = null, index = 0, bindingType = 'delete';";

/**
 * The function from its declaration to its closing brace: a brace walk that skips comments and string
 * literals (the same walk as validator-upload-trigger-warning-b292.test.js).
 * @inner
 * @param {string} src
 * @param {string} declToken
 * @returns {string}
 */
function fnSlice(src, declToken) {
    var start = src.indexOf(declToken);
    assert.ok(start > -1, 'declaration anchor not found: ' + declToken);
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
    assert.fail('unbalanced braces after: ' + declToken);
}

/**
 * Drops the full-line `//` comments, so a comment naming the call cannot satisfy a pin.
 * @inner
 * @param {string} text
 * @returns {string}
 */
function stripLineComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

function count(hay, needle) {
    var n = 0, i = hay.indexOf(needle);
    while (i > -1) { n++; i = hay.indexOf(needle, i + needle.length); }
    return n;
}

var mainCode = stripLineComments(mainSrc);

describe('#B990 01 - the source: the saved-file pass is skipped while staged files are on the page', function () {

    it('control: the saved-file pass is found once', function () {
        assert.equal(count(mainCode, PASS_TAIL), 1);
        assert.equal(count(mainCode, PASS_BODY), 1);
    });

    it('the helper is declared once', function () {
        var decls = mainSrc.match(/^[ \t]*var hasLiveStagedFiles = function\(\$uploadTrigger\) \{/mg) || [];
        assert.equal(decls.length, 1);
    });

    it('the pass condition ends with the call, then the pass body (comments dropped)', function () {
        var tail = mainCode.indexOf(PASS_TAIL);
        assert.ok(tail > -1);
        assert.equal(mainCode.indexOf(CALL), tail + PASS_TAIL.length, 'the call follows the visibility checks');
        var body = mainCode.indexOf(PASS_BODY);
        assert.equal(mainCode.substring(tail + PASS_TAIL.length + CALL.length, body).replace(/\s+/g, ''), '',
            'nothing but whitespace between the condition and the pass body');
        assert.equal(count(mainCode, 'hasLiveStagedFiles('), 2, 'the declaration and the one call');
    });
});

/**
 * The helper, compiled from the source with `document` injected.
 * @inner
 * @param {object} doc - a fake document: `getElementById`
 * @returns {Function}
 */
function load(doc) {
    return new Function('document', fnSlice(mainSrc, DECL) + '\nreturn hasLiveStagedFiles;')(doc);
}

function fakeDocument(ids) {
    return { getElementById: function (id) { return ids.indexOf(id) > -1 ? { id: id } : null; } };
}

/** A staged entry, as the staging success writes them: the selection's File objects. */
function stagedFile(name) {
    return { name: name, size: 1, type: 'application/pdf' };
}

describe('#B990 02 - the helper, run from the source', function () {

    it('a staged entry whose reset control is on the page: true', function () {
        var fn = load(fakeDocument(['doc-0-reset-trigger']));
        assert.equal(fn({ id: 'doc', customFiles: [stagedFile('me.pdf')] }), true);
    });

    it('a staged entry whose reset control is gone (the page replaced the container): false', function () {
        var fn = load(fakeDocument(['doc-0-delete-trigger']));
        assert.equal(fn({ id: 'doc', customFiles: [stagedFile('me.pdf')] }), false);
    });

    it('saved entries only (they carry deleteLinkId), even beside a control with that index: false', function () {
        var fn = load(fakeDocument(['doc-0-reset-trigger', 'doc-0-delete-trigger']));
        assert.equal(fn({ id: 'doc', customFiles: [{ name: 'photo.png', deleteLinkId: 'doc-0-delete-trigger' }] }), false);
    });

    it('no entries, or none recorded: false', function () {
        var fn = load(fakeDocument(['doc-0-reset-trigger']));
        assert.equal(fn({ id: 'doc', customFiles: [] }), false);
        assert.equal(fn({ id: 'doc' }), false);
    });

    it('one live staged entry among several: true; an empty slot is skipped', function () {
        var fn = load(fakeDocument(['doc-1-reset-trigger']));
        assert.equal(fn({ id: 'doc', customFiles: [stagedFile('me.png'), stagedFile('doc.pdf')] }), true);
        assert.equal(fn({ id: 'doc', customFiles: [null, stagedFile('doc.pdf')] }), true);
    });

    it('the control is looked up under the input\'s own id', function () {
        var fn = load(fakeDocument(['other-0-reset-trigger']));
        assert.equal(fn({ id: 'doc', customFiles: [stagedFile('me.pdf')] }), false);
    });
});

describe('#B990 03 - the built bundles carry the change', function () {

    var distJs  = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var distMin = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8').replace(/\n/g, '');
    var MIN_HELPER = /([\w$]+)=function\(([\w$]+)\)\{for\(var ([\w$]+)=\2\.customFiles\|\|\[\],([\w$]+)=0,([\w$]+)=\3\.length;\4<\5;\+\+\4\)if\(\3\[\4\]&&!\3\[\4\]\.deleteLinkId&&document\.getElementById\(\2\.id\+'-'\+\4\+'-reset-trigger'\)\)return!0;return!1\}/g;
    var MIN_CALL = /parentElement\.style\.display\)&&!([\w$]+)\([\w$]+\)\)\{[\w$]+=0;console\.debug\('preview is visible \.\.\.'\)/g;
    var MIN_PASS = /parentElement\.style\.display\)(&&![\w$]+\([\w$]+\))?\)\{[\w$]+=0;console\.debug\('preview is visible \.\.\.'\)/g;

    it('control: each bundle carries the saved-file pass once', function () {
        assert.equal(count(distJs, "console.debug('preview is visible ...');"), 1);
        assert.equal((distMin.match(MIN_PASS) || []).length, 1);
    });

    it('gina.js: the same helper and call as the source', function () {
        var code = stripLineComments(distJs);
        assert.equal(count(code, 'var hasLiveStagedFiles = function($uploadTrigger) {'), 1);
        assert.equal(count(code, CALL), 1);
    });

    it('gina.min.js: the helper, and the pass condition calling it', function () {
        var helpers = [], calls = [], m = null;
        while ((m = MIN_HELPER.exec(distMin))) { helpers.push(m[1]); }
        while ((m = MIN_CALL.exec(distMin))) { calls.push(m[1]); }
        assert.equal(helpers.length, 1, 'the helper');
        assert.deepEqual(calls, helpers, 'the pass condition calls that helper');
    });
});
