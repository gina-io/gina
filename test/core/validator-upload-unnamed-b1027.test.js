/**
 * #B1027 — a staging answer that gives no name for a file or for its preview made the reset name it
 * « undefined ». The staging success wrote `files[f].originalFilename` into the preview node's
 * `data-upload-original-filename` and `files[f].preview.originalFilename` into its
 * `data-upload-preview-original-filename` without a check, and `setAttribute()` stores a missing value as
 * the text « undefined ». The reset prefers the answer's names, then the node's attributes, so it sent
 * that text in its removal request and in the removal callback's `payload.files`. The published guide's
 * `preview` example carries no `originalFilename`, so the documented shape was affected.
 *
 * Each name is now written only when the answer gives one, and the reset falls back to the browser
 * file's name when the node carries no file name.
 *
 *   01 the source: the three writes are guarded, and the reset's file name falls back to `files[f].name`
 *   02 the built bundles carry the change: gina.js (the same lines) and gina.min.js (their minified forms)
 *
 * The browser flows are driven in test/e2e/validator-upload-unnamed-b1027.spec.js.
 *
 * Seams, so the whole file runs against pre-fix bytes without touching the tree:
 *   GINA_B1027_VALIDATOR_SRC=<a copy of src/main.js>   (01)
 *   GINA_B1027_DIST_DIR=<a directory holding gina.js and gina.min.js>   (02)
 * RED-FIRST, measured 2026-10-29 on the parent commit's src/main.js, gina.js and gina.min.js (fix/b990
 * 044381017) and on develop c91fbf88f's: every pin fails on its own assertion; the controls (each write
 * site found, the reset chain found) pass.
 *
 * Usage: node --test test/core/validator-upload-unnamed-b1027.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var MAIN_SRC_PATH = process.env.GINA_B1027_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST_DIR      = process.env.GINA_B1027_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

var FILE_WRITE    = "$img.setAttribute('data-upload-original-filename', files[f].originalFilename);";
var PREVIEW_WRITE = "$img.setAttribute('data-upload-preview-original-filename', files[f][key].originalFilename);";
var RESET_LINK    = "$img.setAttribute('data-upload-reset-link-id', $resetLink.id);";
var RESET_OLD     = ": ( entry.nodes.length ) ? entry.nodes[0].getAttribute('data-upload-original-filename') : files[f].name;";
var RESET_NEW     = ": ( entry.nodes.length && entry.nodes[0].getAttribute('data-upload-original-filename') ) ? entry.nodes[0].getAttribute('data-upload-original-filename') : files[f].name;";
var RESET_HEAD    = 'childNodeFile           = ( stagedFiles[f] && stagedFiles[f].originalFilename )';

/**
 * The write `line`, wrapped in a guard on `name` at the indentation `pad`.
 * @inner
 * @param {string} pad
 * @param {string} name
 * @param {string} line
 * @returns {string}
 */
function guarded(pad, name, line) {
    return '\n' + pad + 'if ( ' + name + ' ) {\n' + pad + '    ' + line + '\n' + pad + '}\n';
}

/**
 * Drops the full-line `//` comments, so a comment naming a guard cannot satisfy a pin.
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

var P20 = ' '.repeat(20), P32 = ' '.repeat(32);

/**
 * The pins shared by the source and gina.js, which carries the same lines.
 * @inner
 * @param {string} code - the text, full-line comments dropped
 */
function assertGuards(code) {
    assert.equal(count(code, guarded(P20, 'files[f].originalFilename', FILE_WRITE)), 1,
        'the file name of an image shown without a preview is written only when the answer gives it');
    assert.equal(count(code, guarded(P32, 'files[f].originalFilename', FILE_WRITE)), 1,
        'the file name in the preview branch is written only when the answer gives it');
    assert.equal(count(code, guarded(P32, 'files[f][key].originalFilename', PREVIEW_WRITE)), 1,
        'the preview name is written only when the answer gives it');
    assert.equal(count(code, FILE_WRITE), 2, 'no other file-name write');
    assert.equal(count(code, PREVIEW_WRITE), 1, 'no other preview-name write');
}

describe('#B1027 01 - the source: a name is written only when the staging answer gives one', function () {

    var mainCode = stripLineComments(fs.readFileSync(MAIN_SRC_PATH, 'utf8'));

    it('control: both preview nodes and the reset name chain are found', function () {
        assert.equal(count(mainCode, RESET_LINK), 2, 'the two preview <img> writes');
        assert.equal(count(mainCode, RESET_HEAD), 1, 'the reset name chain');
    });

    it('the three writes are guarded', function () {
        assertGuards(mainCode);
    });

    it('the reset falls back to the browser file\'s name when the node carries no file name', function () {
        assert.equal(count(mainCode, RESET_NEW), 1);
        assert.equal(count(mainCode, RESET_OLD), 0);
    });
});

describe('#B1027 02 - the built bundles carry the change', function () {

    var distJs  = stripLineComments(fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8'));
    var distMin = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8').replace(/\n/g, '');
    var MIN_FILE    = /([\w$]+)\[([\w$]+)\]\.originalFilename&&[\w$]+\.setAttribute\('data-upload-original-filename',\1\[\2\]\.originalFilename\)/g;
    var MIN_PREVIEW = /([\w$]+)\[([\w$]+)\]\[([\w$]+)\]\.originalFilename&&[\w$]+\.setAttribute\('data-upload-preview-original-filename',\1\[\2\]\[\3\]\.originalFilename\)/g;
    var MIN_RESET   = /([\w$]+)\.nodes\.length&&\1\.nodes\[0\]\.getAttribute\('data-upload-original-filename'\)\?\1\.nodes\[0\]\.getAttribute\('data-upload-original-filename'\):[\w$]+\[[\w$]+\]\.name/g;

    it('control: each bundle carries the writes and the reset chain', function () {
        assert.equal(count(distJs, RESET_LINK), 2);
        assert.equal(count(distJs, RESET_HEAD), 1);
        assert.equal(count(distMin, ".setAttribute('data-upload-original-filename',"), 2);
        assert.equal(count(distMin, ".setAttribute('data-upload-preview-original-filename',"), 1);
        assert.equal(count(distMin, ".getAttribute('data-upload-preview-original-filename')"), 1);
    });

    it('gina.js: the same guards and reset fallback as the source', function () {
        assertGuards(distJs);
        assert.equal(count(distJs, RESET_NEW), 1);
        assert.equal(count(distJs, RESET_OLD), 0);
    });

    it('gina.min.js: both file-name writes and the preview-name write are guarded', function () {
        assert.equal((distMin.match(MIN_FILE) || []).length, 2);
        assert.equal((distMin.match(MIN_PREVIEW) || []).length, 1);
    });

    it('gina.min.js: the reset falls back to the browser file\'s name', function () {
        assert.equal((distMin.match(MIN_RESET) || []).length, 1);
    });
});
