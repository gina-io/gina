'use strict';
/**
 * FormValidator - staged-upload fields after a reset or a delete (#B858 - #B862)
 *
 * The hidden `<prefix>[i][…]` fields a file input's staged files write into its form were built
 * only when the input's virtual upload form was created, and a reset or a delete reached a file
 * only through an <img> child of the preview container:
 *  - #B858 a selection made after a reset found the virtual form, built no field, and the save
 *    posted no file; the declared `[preview][*]` inputs the reset removed never came back;
 *  - #B859 a file shown without an image (no <img>), and an <img> inside the <li> of a `<ul>`
 *    container, could not be reset or deleted;
 *  - #B860 a reset on a multi-file input threw (it set the input's value to the files left), and
 *    a delete removed the fields of the wrong index;
 *  - #B861 a custom `data-gina-form-upload-preview` id gave the reset link the container's own id,
 *    and an input with no preview container left every field empty (a read of a null container);
 *  - #B862 a reset removed the fields by the input's name, so a custom
 *    `data-gina-form-upload-prefix` kept them while the server was told to drop the file.
 *
 * Strategy:
 *  - 01 source pins on the shipped `main.js` (comment-stripped where a `was:` line would match):
 *    the fields are built on every staging that succeeds (#B960: no longer at the selection, whose
 *    first one binds the reset triggers the page holds), the reset link id, the staging answer
 *    kept on the input, ONE removal request, one prefix rule, the container a selection resolves.
 *  - 02 behaviour: the REAL helper bytes (brace-walked from the source) evaluated inside a jsdom
 *    window's own realm, on real forms: getUploadFieldPrefix, getUploadFileNodes,
 *    removeUploadEntryFields, restoreRemovedUploadFields, buildUploadHiddenFields,
 *    dropEmptyUploadPreviewItem. The browser path end to end is
 *    test/e2e/validator-upload-reset-reselect-b858.spec.js.
 *  - 03 dist fidelity: the unminified bundle carries the helpers; the minified one carries the
 *    properties the fix adds and no longer the file-list assignment of a multi-file reset.
 *
 * Seams for a red-first run against PRE-fix bytes without touching the shared tree:
 * B858_VALIDATOR_SRC=<copy of main.js>, B858_PLUGIN_DIST=<dir holding js/>.
 *
 * Usage: node --test test/core/validator-upload-reset-reselect-b858.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM } = require('jsdom');

var FW = require('../fw');

var MAIN     = process.env.B858_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.B858_PLUGIN_DIST   || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_RAW = path.join(DIST, 'js/gina.js');
var DIST_MIN = path.join(DIST, 'js/gina.min.js');

var HELPERS = [
    'getUploadFieldPrefix',
    'getUploadFileNodes',
    'removeUploadEntryFields',
    'restoreRemovedUploadFields',
    'buildUploadHiddenFields',
    'dropEmptyUploadPreviewItem'
];

var MANDATORY = ['name', 'group', 'originalFilename', 'ext', 'encoding', 'size', 'height', 'width', 'location', 'mime', 'preview'];

var src = fs.readFileSync(MAIN, 'utf8');

/**
 * Extracts `var <name> = function(...) {...}` from the source: line-anchored declaration,
 * uniqueness-gated, then a brace walk that skips comments and string literals.
 *
 * @inner
 * @param {string} source
 * @param {string} name
 * @returns {string} the function expression, from `function` to its closing brace
 */
function extractFn(source, name) {
    var re = new RegExp('^[ \\t]*var ' + name + ' = function\\s*\\(', 'mg');
    var m  = re.exec(source);
    assert.ok(m, 'declaration of ' + name + ' not found');
    assert.equal(re.exec(source), null, 'declaration of ' + name + ' is not unique');
    var start = source.indexOf('function', m.index);
    var i = source.indexOf('{', start), depth = 0, c = null, next = null, end = -1;
    for (; i < source.length; i++) {
        c = source[i];
        next = source[i + 1];
        if (c === '/' && next === '/') {
            i = source.indexOf('\n', i);
            assert.ok(i > -1, 'unterminated line comment in ' + name);
            continue;
        }
        if (c === '/' && next === '*') {
            end = source.indexOf('*/', i + 2);
            assert.ok(end > -1, 'unterminated block comment in ' + name);
            i = end + 1;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') {
            for (i++; i < source.length && source[i] !== c; i++) {
                if (source[i] === '\\') { i++; }
            }
            continue;
        }
        if (c === '{') {
            depth++;
        } else if (c === '}' && --depth === 0) {
            return source.substring(start, i + 1);
        }
    }
    assert.fail('unbalanced braces extracting ' + name);
}

/**
 * The code of a slice without its comments: whole-line `//` and `*` lines dropped, a trailing
 * `// …` cut. Only used on slices whose strings hold no `//` (asserted by the caller).
 *
 * @inner
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(function (l) {
        return /^\s*(\/\/|\*)/.test(l) ? '' : l.replace(/\s\/\/.*$/, '');
    }).join('\n');
}

/**
 * Counts the occurrences of a literal needle.
 *
 * @inner
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
function count(text, needle) {
    var n = 0, i = -1;
    while ((i = text.indexOf(needle, i + 1)) > -1) { n++; }
    return n;
}

// ─── 01 source pins ──────────────────────────────────────────────────────────
describe('#B858 - #B862 staged-upload fields after a reset or a delete (source pins)', function () {

    var code = stripComments(src);
    var onUploadCode = null, onRemoveCode = null;

    before(function () {
        onUploadCode = stripComments(extractFn(src, 'onUpload'));
        onRemoveCode = stripComments(extractFn(src, 'onUploadResetOrDelete'));
    });

    it('01.1 #B858 - the selection that creates the virtual upload form binds the reset triggers; the staging success builds the fields through the helper (#B960)', function () {
        // #B960 — the fields are built when the staging succeeds (onUpload), no longer at the selection
        // was: assert.equal(count(code, 'var fieldPrefix = getUploadFieldPrefix($el);'), 1);
        // was: assert.equal(count(code, 'hiddenFields = buildUploadHiddenFields($el, fieldPrefix, files.length, mandatoryFields, true);'), 1);
        assert.equal(count(code, 'for (var _r = 0, _rLen = files.length; _r < _rLen; ++_r) {'), 1, 'the creating selection loops over its files');
        assert.equal(count(code, "bindUploadResetOrDeleteTrigger('reset', $el, _r);"), 1, 'and binds each file\'s reset trigger');
        assert.equal(count(code, 'hiddenFields = buildUploadHiddenFields('), 0, 'no field is built at the selection');
        assert.equal(count(onUploadCode, 'uploadProperties.uploadFields = buildUploadHiddenFields($uploadTriger, getUploadFieldPrefix($uploadTriger), files.length, uploadProperties.mandatoryFields, false);'), 1, 'the staging success builds them');
        // the collect + auto-create loop lives in the helper only, not inline in the change handler
        assert.equal(count(code, 'for (var _f = 0, _fLen = filesLength; _f < _fLen; ++_f) {'), 1);
        assert.equal(count(code, 'for (var _f = 0, _fLen = files.length; _f < _fLen; ++_f) {'), 0);
    });

    it('01.2 #B858 - a selection that finds the virtual form reads it from the live element, and builds no field (#B960)', function () {
        var live    = code.indexOf('$uploadForm = document.getElementById(uploadFormId) || $uploadForm;');
        assert.ok(live > -1, 'the live element is looked up on the document');
        // #B960 — the rebuild that followed the lookup is gone: the staging success builds the fields
        // was: var guard   = code.indexOf('if ( $el.form && $uploadForm.uploadProperties ) {', live);
        // was: var rebuild = code.indexOf('$uploadForm.uploadProperties.uploadFields = buildUploadHiddenFields($el, getUploadFieldPrefix($el), files.length, $uploadForm.uploadProperties.mandatoryFields, false);', live);
        // was: assert.ok(guard > live && rebuild > guard, 'the rebuild follows the lookup, guarded on the form and its properties');
        // was: assert.equal(count(code, 'buildUploadHiddenFields($el, getUploadFieldPrefix($el), files.length, $uploadForm.uploadProperties.mandatoryFields, false)'), 1);
        assert.equal(code.indexOf('buildUploadHiddenFields(', live), -1, 'no build follows the lookup');
    });

    it('01.3 #B861 - the reset link id is `<file input id>-<f>-reset-trigger`, not derived from the container id', function () {
        assert.equal(count(onUploadCode, "let resetLinkId = $uploadTriger.id + '-' + f + '-reset-trigger';"), 1);
        assert.equal(count(onUploadCode, '$previewContainer.id.replace('), 0);
        // the needle can fire: the raw source still holds it, in its `was:` line
        assert.ok(count(src, '$previewContainer.id.replace(/\\-preview/') > 0, '[instrument] the was: line is gone, the zero above is blind');
    });

    it('01.4 #B859 - the staging answer is kept on the input, read by the reset, and dropped after it', function () {
        assert.equal(count(onUploadCode, '$uploadTriger.stagedFiles = files;'), 1);
        assert.match(onRemoveCode, /stagedFiles\s*=\s*\$uploadTrigger\.stagedFiles \|\| \[\]/);
        assert.match(onRemoveCode, /\$uploadTrigger\.stagedFiles\s*=\s*\[\];/);
    });

    it('01.5 #B860 - ONE removal request, sent before the per-file removals', function () {
        assert.equal(count(onRemoveCode, 'setupXhr(xhrOptions)'), 1);
        assert.equal(count(onRemoveCode, 'xhr.send();'), 1);
        assert.equal(count(onRemoveCode, 'xhr.send(JSON.stringify({ files: filesToBeRemoved }));'), 1);
        var send = onRemoveCode.indexOf('setupXhr(xhrOptions)');
        var loop = onRemoveCode.indexOf('for (let e = 0, eLen = entries.length; e < eLen; e++) {');
        assert.ok(send > -1 && loop > send, 'the request is sent once, before the loop over the files');
    });

    it('01.6 #B862 - the fields are removed by the prefix they were built with', function () {
        assert.match(onRemoveCode, /fieldPrefix\s*=\s*getUploadFieldPrefix\(\$uploadTrigger\)/);
        assert.equal(count(onRemoveCode, 'removeUploadEntryFields($uploadTrigger, fieldPrefix, entries[e].index);'), 1);
        assert.equal(count(code, "$uploadTrigger.name+'['"), 0, 'the name-based removal regex is gone');
        assert.equal(count(extractFn(src, 'getUploadFieldPrefix'), "$input.getAttribute('data-gina-form-upload-prefix') || $input.name"), 1);
    });

    it('01.7 #B861 - the reset resolves the preview container as a selection does', function () {
        assert.match(onRemoveCode, /uploadPreviewId\s*=\s*\$uploadTrigger\.getAttribute\('data-gina-form-upload-preview'\) \|\| \$uploadTrigger\.id \+'-preview'/);
    });

    it('01.8 #B860 - a reset empties the input instead of writing the files left into its value', function () {
        assert.equal(count(onRemoveCode, 'fakepath'), 0);
        assert.match(onRemoveCode, /\$uploadTrigger\.value\s*=\s*'';/);
        assert.ok(count(src, "files.join(', C:\\\\fakepath\\\\')") > 0, '[instrument] the was: line is gone, the zero above is blind');
    });

    it('01.9 #B859 - the stored files of an edit form are the container\'s file nodes, named by the marker first', function () {
        assert.equal(count(code, 'var $els = getUploadFileNodes($previewContainer), deleteLinkId = null;'), 1);
        assert.equal(count(code, "let file = $img.getAttribute('data-upload-original-filename') || "), 1);
        assert.equal(count(onRemoveCode, 'childNodes            = getUploadFileNodes($uploadPreview)'), 1);
    });
});

// ─── 02 the helpers, on jsdom ────────────────────────────────────────────────
describe('#B858 - #B862 the upload field helpers (real bytes, jsdom)', function () {

    /**
     * A jsdom window holding `bodyHtml`, with the six helpers evaluated in its realm.
     *
     * @inner
     * @param {string} bodyHtml
     * @returns {{w: Window, h: object, binds: Array<Array>}} the window, the helpers, and the
     *   calls the bind stub received
     */
    function realm(bodyHtml) {
        var dom = new JSDOM('<!DOCTYPE html><html><body>' + bodyHtml + '</body></html>', { runScripts: 'outside-only' });
        var w = dom.window;
        var decls = HELPERS.map(function (name) { return 'var ' + name + ' = ' + extractFn(src, name) + ';'; }).join('\n');
        w.eval('window.__mk = function (bindUploadResetOrDeleteTrigger, uuid) {\n' + decls
            + '\nreturn { ' + HELPERS.map(function (n) { return n + ': ' + n; }).join(', ') + ' };\n};');
        var binds = [], seq = 0;
        var h = w.__mk(function (bindingType, $el, index) { binds.push([bindingType, $el.id, index]); }, function () { return 'u' + (++seq); });
        return { w: w, h: h, binds: binds };
    }

    /** The names of a form's controls, in tree order. */
    function names(form) {
        return Array.prototype.map.call(form.elements, function (el) { return el.name; });
    }

    /**
     * A list the helpers built, as an array of THIS realm (deepStrictEqual compares prototypes,
     * and an array built inside the jsdom realm has that realm's Array.prototype).
     *
     * @inner
     * @param {ArrayLike} list
     * @param {function} [fn]
     * @returns {Array}
     */
    function local(list, fn) {
        return Array.from(list, fn || function (x) { return x; });
    }

    it('02.1 getUploadFieldPrefix: the prefix attribute, else the name, else `files`', function () {
        var r = realm('<form><input type="file" id="a" name="doc" data-gina-form-upload-prefix="attachment">'
            + '<input type="file" id="b" name="doc"><input type="file" id="c"></form>');
        var d = r.w.document;
        assert.equal(r.h.getUploadFieldPrefix(d.getElementById('a')), 'attachment');
        assert.equal(r.h.getUploadFieldPrefix(d.getElementById('b')), 'doc');
        assert.equal(r.h.getUploadFieldPrefix(d.getElementById('c')), 'files');
    });

    it('02.2 getUploadFileNodes: an <img> child or <li> child, or a marked node, in order; not a node inside one', function () {
        var r = realm('<div id="pv">'
            + '<img id="i1" src="/a.png">'
            + '<a href="#" id="link">Reset</a>'
            + '<div id="wrap"><img id="deep" src="/b.png"></div>'
            + '<a id="m1" data-upload-original-filename="cv.pdf" href="/cv.pdf">cv.pdf<img id="inner" src="/c.png"></a>'
            + '</div>'
            + '<ul id="ul"><li><img id="li1" src="/d.png"></li><li><a href="#" id="r1">Reset</a></li><li><span><img id="deep2" src="/e.png"></span></li></ul>');
        var d = r.w.document;
        var ids = function (list) { return local(list, function (n) { return n.id; }); };
        assert.deepEqual(ids(r.h.getUploadFileNodes(d.getElementById('pv'))), ['i1', 'm1'],
            'a direct <img> and a marked node; not an <img> deeper in a wrapper, not one inside a marked node');
        assert.deepEqual(ids(r.h.getUploadFileNodes(d.getElementById('ul'))), ['li1'],
            'the <img> of an <li> child; not one deeper in it');
        assert.deepEqual(local(r.h.getUploadFileNodes(null)), []);
        // a static list: removing its nodes while walking it keeps every entry reachable
        var list = r.h.getUploadFileNodes(d.getElementById('pv'));
        assert.ok(Array.isArray(list));
        for (var i = 0; i < list.length; i++) { list[i].remove(); }
        assert.equal(list.length, 2);
        assert.equal(d.querySelectorAll('#pv img, #pv [data-upload-original-filename]').length, 1, 'only the <img> in the wrapper is left');
    });

    it('02.3 removeUploadEntryFields: `<prefix>[i]…` leave the form (not a locked one, not another index), kept on the input', function () {
        var r = realm('<form id="f"><input type="file" id="docA" name="doc">'
            + '<input type="hidden" name="doc[0][name]" value="a.png">'
            + '<input type="hidden" name="doc[0][preview][uri]" value="/p.png">'
            + '<input type="text" name="doc[0][caption]" value="my caption">'
            + '<input type="hidden" name="doc[0][tag]" value="t" data-gina-form-upload-is-locked="true">'
            + '<input type="hidden" name="doc[1][name]" value="b.png">'
            + '<input type="hidden" name="doc[10][name]" value="k.png">'
            + '</form>');
        var d = r.w.document, input = d.getElementById('docA'), form = d.getElementById('f');
        assert.equal(r.h.removeUploadEntryFields(input, 'doc', 0), 3);
        assert.deepEqual(names(form), ['doc', 'doc[0][tag]', 'doc[1][name]', 'doc[10][name]']);
        var stash = input.removedUploadFields[0];
        assert.deepEqual(local(stash, function (e) { return e.$field.name; }), ['doc[0][name]', 'doc[0][preview][uri]', 'doc[0][caption]']);
        assert.equal(stash[0].$field.value, '', 'a hidden field is emptied');
        assert.equal(stash[2].$field.value, 'my caption', 'a visible field keeps what the user typed');
        assert.equal(r.h.removeUploadEntryFields(input, 'doc', 1), 1, 'index 1 does not reach doc[10]');
        assert.deepEqual(names(form), ['doc', 'doc[0][tag]', 'doc[10][name]']);
    });

    it('02.4 removeUploadEntryFields: a prefix is matched literally (#B862)', function () {
        var r = realm('<form id="f"><input type="file" id="docA" name="doc" data-gina-form-upload-prefix="att.x">'
            + '<input type="hidden" name="att.x[0][name]" value="a"><input type="hidden" name="attXx[0][name]" value="b">'
            + '<input type="hidden" name="doc[0][name]" value="c"></form>');
        var d = r.w.document, input = d.getElementById('docA');
        assert.equal(r.h.removeUploadEntryFields(input, r.h.getUploadFieldPrefix(input), 0), 1);
        assert.deepEqual(names(d.getElementById('f')), ['doc', 'attXx[0][name]', 'doc[0][name]']);
    });

    it('02.5 restoreRemovedUploadFields: the removed fields come back in place and in order, a name the page re-added is kept', function () {
        var r = realm('<form id="f"><input type="file" id="docA" name="doc">'
            + '<fieldset id="fs"><input type="hidden" name="doc[0][preview][location]" value="/l.png">'
            + '<input type="hidden" name="doc[0][preview][uri]" value="/u.png"><input type="text" id="after" name="title"></fieldset>'
            + '<input type="hidden" name="doc[0][name]" value="a.png"></form>');
        var d = r.w.document, input = d.getElementById('docA'), form = d.getElementById('f');
        var before = names(form);
        assert.equal(r.h.removeUploadEntryFields(input, 'doc', 0), 3);
        // the page puts one back itself meanwhile
        var own = d.createElement('input');
        own.type = 'hidden';
        own.name = 'doc[0][name]';
        own.value = 'page';
        form.appendChild(own);
        assert.equal(r.h.restoreRemovedUploadFields(input, 0), 2);
        assert.deepEqual(names(form), before, 'same controls, same order');
        assert.equal(d.querySelector('[name="doc[0][preview][location]"]').parentNode.id, 'fs', 'back in its fieldset');
        assert.equal(d.querySelector('[name="doc[0][preview][uri]"]').value, '', 'restored emptied');
        assert.equal(form.querySelectorAll('[name="doc[0][name]"]').length, 1, 'no duplicate');
        assert.equal(d.querySelector('[name="doc[0][name]"]').value, 'page', 'the page\'s own input is kept');
        assert.equal(r.h.restoreRemovedUploadFields(input, 0), 0, 'the stash is consumed');
    });

    it('02.6 restoreRemovedUploadFields: a field whose parent left the document goes back into the form', function () {
        var r = realm('<form id="f"><input type="file" id="docA" name="doc">'
            + '<div id="box"><input type="hidden" name="doc[0][location]" value="/x"></div></form>');
        var d = r.w.document, input = d.getElementById('docA');
        r.h.removeUploadEntryFields(input, 'doc', 0);
        d.getElementById('box').remove();
        assert.equal(r.h.restoreRemovedUploadFields(input, 0), 1);
        assert.equal(d.querySelector('[name="doc[0][location]"]').parentNode.id, 'f');
    });

    it('02.7 buildUploadHiddenFields: the mandatory inputs are created once, the preview stays a map', function () {
        var r = realm('<form id="f"><input type="file" id="docA" name="doc"></form>');
        var d = r.w.document, input = d.getElementById('docA'), form = d.getElementById('f');
        var map = r.h.buildUploadHiddenFields(input, 'doc', 1, MANDATORY.slice(), true);
        var flat = MANDATORY.filter(function (k) { return k !== 'preview'; });
        assert.deepEqual(names(form), ['doc'].concat(flat.map(function (k) { return 'doc[0][' + k + ']'; })));
        assert.deepEqual(Object.keys(map[0].preview), [], 'an empty preview map, no flat preview input');
        assert.equal(map[0].location, d.querySelector('[name="doc[0][location]"]'));
        assert.deepEqual(r.binds, [['reset', 'docA', 0]]);
        // a second pass over the same selection reuses the inputs and binds nothing when told not to
        r.h.buildUploadHiddenFields(input, 'doc', 1, MANDATORY.slice(), false);
        assert.equal(form.querySelectorAll('input[type="hidden"]').length, flat.length, 'no duplicate');
        assert.equal(r.binds.length, 1);
    });

    it('02.8 buildUploadHiddenFields: after a reset the next selection gets its fields back, declared ones included (#B858)', function () {
        var r = realm('<form id="f"><input type="file" id="docA" name="doc">'
            + '<input type="hidden" name="doc[0][preview][location]"><input type="hidden" name="doc[0][preview][uri]">'
            + '<input type="hidden" name="doc[0][preview][width]"><input type="hidden" name="doc[0][preview][height]"></form>');
        var d = r.w.document, input = d.getElementById('docA'), form = d.getElementById('f');
        var first = r.h.buildUploadHiddenFields(input, 'doc', 1, MANDATORY.slice(), true);
        assert.deepEqual(Object.keys(first[0].preview).sort(), ['height', 'location', 'uri', 'width']);
        var built = names(form);
        assert.equal(built.length, 1 + 4 + 10);
        // the reset takes every doc[0] field out of the form
        assert.equal(r.h.removeUploadEntryFields(input, 'doc', 0), 14);
        assert.deepEqual(names(form), ['doc']);
        // the next selection
        var again = r.h.buildUploadHiddenFields(input, 'doc', 1, MANDATORY.slice(), false);
        assert.deepEqual(names(form), built, 'the same fields, in the same order');
        assert.deepEqual(Object.keys(again[0].preview).sort(), ['height', 'location', 'uri', 'width'], 'the declared preview inputs are back');
        assert.equal(again[0].preview.uri, d.querySelector('[name="doc[0][preview][uri]"]'));
        assert.equal(again[0].preview.uri.value, '');
    });

    it('02.9 buildUploadHiddenFields: a selection with more files gets fields for its new files; a custom prefix names them', function () {
        var r = realm('<form id="f"><input type="file" id="docA" name="doc" multiple data-gina-form-upload-prefix="attachment"></form>');
        var d = r.w.document, input = d.getElementById('docA'), form = d.getElementById('f');
        var prefix = r.h.getUploadFieldPrefix(input);
        r.h.buildUploadHiddenFields(input, prefix, 1, MANDATORY.slice(), true);
        var map = r.h.buildUploadHiddenFields(input, prefix, 2, MANDATORY.slice(), false);
        assert.equal(form.querySelectorAll('input[name^="attachment[0]"]').length, 10);
        assert.equal(form.querySelectorAll('input[name^="attachment[1]"]').length, 10);
        assert.equal(form.querySelectorAll('input[name^="doc["]').length, 0);
        assert.equal(map[1].mime, d.querySelector('[name="attachment[1][mime]"]'));
    });

    it('02.10 dropEmptyUploadPreviewItem: only an empty <li> child of the container goes', function () {
        var r = realm('<ul id="pv"><li id="empty"></li><li id="full"><img src="/a.png"></li></ul>'
            + '<ul><li id="other"></li></ul>');
        var d = r.w.document, pv = d.getElementById('pv');
        r.h.dropEmptyUploadPreviewItem(d.getElementById('full'), pv);
        r.h.dropEmptyUploadPreviewItem(d.getElementById('other'), pv);
        r.h.dropEmptyUploadPreviewItem(pv, pv);
        r.h.dropEmptyUploadPreviewItem(null, pv);
        assert.ok(d.getElementById('empty') && d.getElementById('full') && d.getElementById('other'), 'nothing else is removed');
        r.h.dropEmptyUploadPreviewItem(d.getElementById('empty'), pv);
        assert.equal(d.getElementById('empty'), null);
    });
});

// ─── 03 dist fidelity ───────────────────────────────────────────────────────
describe('#B858 - #B862 the built bundles carry the fix (dist pins)', function () {

    var raw = null, min = null;
    before(function () {
        raw = fs.readFileSync(DIST_RAW, 'utf8');
        min = fs.readFileSync(DIST_MIN, 'utf8');
    });

    it('03.1 gina.js holds each helper once', function () {
        HELPERS.forEach(function (name) {
            assert.equal(count(raw, 'var ' + name + ' = function'), 1, name);
        });
    });

    it('03.2 gina.min.js keeps the properties the fix adds (Closure keeps property names)', function () {
        assert.ok(count(min, 'removedUploadFields') > 0, 'removedUploadFields');
        assert.ok(count(min, 'stagedFiles') > 0, 'stagedFiles');
        assert.ok(count(min, 'data-gina-form-upload-preview') > 0, 'control: an attribute the bundle has always read');
    });

    it('03.3 gina.min.js no longer writes the files left into the input\'s value (#B860), and keeps the #B150 signal', function () {
        assert.equal(count(min, 'fakepath'), 0);
        assert.ok(count(min, '-reset-trigger') > 0, 'control: the reset trigger id suffix');
        assert.equal(count(min, 'none matched the staged input files'), 1);
    });
});
