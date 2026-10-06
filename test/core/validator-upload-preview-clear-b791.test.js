'use strict';
/**
 * #B791 — staged-upload fill loop: a declared `[preview][*]` sub-field is left EMPTY
 * when the response does not carry its value, never left holding a replaced file's
 * stale value.
 *
 * Since #B459 the preview slot is a sub-field MAP (`{location, uri, width, height}`),
 * not a flat input. The fill loop's skip branch removed a skipped preview/height/width
 * field by `document.getElementById(fieldsObjectList[key].id)` — but the map has no
 * `.id`, so `getElementById(undefined)` returned null and nothing happened. On an EDIT
 * form whose declared sub-fields already held the REPLACED file's values, a replacement
 * whose staging response carried no `preview` (or only a PARTIAL one) left those inputs
 * untouched, and the real form's submit posted them with the new file. #B459 fixed the
 * UNDECLARED case only; a declared form was "unchanged".
 *
 * The fix honours the documented contract (file-uploads.md § Persisting the preview:
 * "a declared sub-field the response does not carry is left empty"): clear every
 * declared sub-field the response omits, then fill the ones it carries — covering both
 * the no-preview and partial-preview facets. The flat height/width removal is unchanged.
 *
 * Strategy: the real `for (var key in fieldsObjectList)` fill loop is brace-walked out
 * of the shipped plugin bytes (comment-aware) and executed against jsdom forms — the
 * #B459 test extracts the auto-create loop the same way; `onUpload` itself is extracted
 * by no test. Red-first seam (no shared-tree touch): B791_VALIDATOR_SRC=<pre-fix copy>.
 *
 * Run standalone: node --test test/core/validator-upload-preview-clear-b791.test.js
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var { JSDOM } = require('jsdom');
var FW = require('../fw');

var MAIN = process.env.B791_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');

var runFill;
before(function () {
    var src = fs.readFileSync(path.resolve(MAIN), 'utf8');
    var HEAD = 'for (var key in fieldsObjectList) {';
    var at = src.indexOf(HEAD);
    assert.ok(at > -1, 'fill-loop head not found');
    // balance-walk the loop, skipping comments and strings so an inner brace in a
    // comment or string literal cannot unbalance the walk
    var open = src.indexOf('{', at), depth = 0, i = open;
    var inLine = false, inBlock = false, inStr = false, strCh = '';
    for (; i < src.length; i++) {
        var c = src[i], n = src[i + 1];
        if (inLine) { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
        if (inStr) { if (c === '\\') { i++; continue; } if (c === strCh) inStr = false; continue; }
        if (c === '/' && n === '/') { inLine = true; i++; continue; }
        if (c === '/' && n === '*') { inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    assert.equal(depth, 0, 'unbalanced braces walking the fill loop');
    var loop = src.substring(at, i);
    runFill = new Function('fieldsObjectList', 'files', 'f', 'document', 'uploadProperties', '$previewContainer', 'fadeIn',
        'var $elIgnored = null;\n' + loop + '\n');
});

function makeInput(doc, form, id, name, value) {
    var el = doc.createElement('input');
    el.type = 'hidden'; el.id = id; el.name = name; el.value = value;
    form.appendChild(el);
    return el;
}
/** An EDIT form: declared [preview][*] inputs pre-loaded with the REPLACED file's values. */
function scene(withPreviewInputs) {
    var dom = new JSDOM('<!doctype html><body><form id="f"><input type="file" id="docA" name="doc"></form></body>');
    var doc = dom.window.document, form = doc.getElementById('f');
    var map = {};
    makeInput(doc, form, 'doc0name', 'doc[0][name]', '');
    map.name     = doc.getElementById('doc0name');
    map.location = makeInput(doc, form, 'doc0loc', 'doc[0][location]', '/old.png');
    if (withPreviewInputs) {
        map.preview = {
            location: makeInput(doc, form, 'p-loc', 'doc[0][preview][location]', '/old-preview.png'),
            uri:      makeInput(doc, form, 'p-uri', 'doc[0][preview][uri]', 'tmp://old'),
            width:    makeInput(doc, form, 'p-w',   'doc[0][preview][width]',  '111'),
            height:   makeInput(doc, form, 'p-h',   'doc[0][preview][height]', '222')
        };
    }
    return { doc: doc, map: map };
}
function run(s, files) {
    runFill(s.map, files, 0, s.doc, { hasPreviewContainer: false }, null, function () {});
}

describe('#B791 01 - a declared preview with NO preview in the response is left empty (not stale)', function () {
    it('every declared [preview][*] sub-field is cleared, and the inputs stay in the DOM', function () {
        var s = scene(true);
        run(s, [{ name: 'new.png', location: '/new.png', mime: 'image/png' }]);   // no preview key
        assert.equal(s.map.preview.location.value, '', 'preview[location] must be cleared');
        assert.equal(s.map.preview.uri.value, '',      'preview[uri] must be cleared');
        assert.equal(s.map.preview.width.value, '',     'preview[width] must be cleared');
        assert.equal(s.map.preview.height.value, '',    'preview[height] must be cleared');
        assert.ok(s.doc.getElementById('p-loc'), 'the inputs are LEFT EMPTY, not removed');
        assert.equal(s.map.location.value, '/new.png', 'the flat location field still fills');
    });
});

describe('#B791 02 - a response WITH a full preview fills the new values (control)', function () {
    it('each declared sub-field takes the response value', function () {
        var s = scene(true);
        run(s, [{ name: 'new.png', location: '/new.png',
            preview: { location: '/new-preview.png', uri: 'tmp://new', width: '10', height: '20' } }]);
        assert.equal(s.map.preview.location.value, '/new-preview.png');
        assert.equal(s.map.preview.uri.value, 'tmp://new');
        assert.equal(s.map.preview.width.value, '10');
        assert.equal(s.map.preview.height.value, '20');
    });
});

describe('#B791 03 - a PARTIAL preview fills the carried keys and clears the omitted ones', function () {
    it('location is filled; width/height/uri the response omits are left empty, not stale', function () {
        var s = scene(true);
        run(s, [{ name: 'new.png', location: '/new.png', preview: { location: '/new-preview.png' } }]);
        assert.equal(s.map.preview.location.value, '/new-preview.png', 'the carried key is filled');
        assert.equal(s.map.preview.uri.value, '',    'an omitted sub-field is cleared, not left stale');
        assert.equal(s.map.preview.width.value, '',  'an omitted sub-field is cleared, not left stale');
        assert.equal(s.map.preview.height.value, '', 'an omitted sub-field is cleared, not left stale');
    });
});

describe('#B791 04 - the flat height/width removal is unchanged (control)', function () {
    it('a declared flat width input is REMOVED when the response omits it on a non-image', function () {
        var dom = new JSDOM('<!doctype html><body><form id="f"><input type="file" id="docA" name="doc"></form></body>');
        var doc = dom.window.document, form = doc.getElementById('f');
        var wEl = makeInput(doc, form, 'flat-w', 'doc[0][width]', '99');
        runFill({ width: wEl }, [{ mime: 'application/pdf' }], 0, doc, { hasPreviewContainer: false }, null, function () {});
        assert.equal(doc.getElementById('flat-w'), null, 'the flat width input must be removed (not merely emptied)');
    });
});
