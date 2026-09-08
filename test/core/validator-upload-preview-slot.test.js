'use strict';
/**
 * FormValidator - staged-upload preview slot: a sub-field map, never a flat input (#B459)
 *
 * The staged-upload client layer writes one hidden input per `mandatoryFields` entry into
 * the real form, auto-creating any the form did not declare. `preview` is in that list, and
 * the auto-create loop - under a comment reading "all but preview" - carried no carve-out:
 * a form declaring no `[preview][...]` sub-fields got a FLAT `<prefix>[i][preview]` input.
 * The fill loop then assigned the staging response's preview OBJECT to that input's `.value`
 * ("[object Object]"), and the real form's submit posted it verbatim. The trigger is a
 * conjunction - an undeclared form AND a response carrying a `preview` key; with no key the
 * skip clause fires and the flat input was removed, which is why the documented response
 * shape never showed it.
 *
 * The fix: the auto-create loop seeds the preview slot with an EMPTY sub-field map instead
 * of an input, so the fill loop still visits the key (the nested thumbnail is rendered from
 * inside it) and posts nothing for it - the documented field set; and the shared assignment
 * never targets the preview slot. Declaring the sub-fields stays the opt-in for persisting
 * the preview; declared forms are unchanged.
 *
 * Strategy:
 *  - 01 source pins: the carve-out, its position inside the auto-create loop (after the
 *    loop head, before the name statement and the input creation), the guard on the shared
 *    assignment and its position inside the fill loop, with non-discriminating controls
 *    (`'preview'` still listed in mandatoryFields; the sub-key fill statement unchanged);
 *  - 02 the auto-create loop EXTRACTED from the shipped plugin bytes (brace-walked from its
 *    head, the real mandatoryFields literal evaluated from the same bytes) and executed
 *    against jsdom forms: an undeclared form gets the ten flat inputs and an empty preview
 *    map and no flat preview input; a declared preview map and a declared flat field are
 *    left untouched;
 *  - 03 dist fidelity: the two new `preview` comparisons survive minification.
 *  The real-bytes BEHAVIOURAL arm is test/e2e/validator-upload-preview-fields.spec.js
 *  (arm 02 red before the fix, green after; 01 and 03 as controls, both thumbnails).
 *
 * Seams for a red-first run against PRE-fix bytes without touching the shared tree:
 * GINA_VALIDATOR_MAIN=<plugin main.js>, GINA_PLUGIN_DIST=<dir holding js/>.
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM } = require('jsdom');

var FW = require('../fw');

var MAIN    = process.env.GINA_VALIDATOR_MAIN || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST    = process.env.GINA_PLUGIN_DIST    || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_JS = path.join(DIST, 'js/gina.min.js');

var LOOP_HEAD = 'for (var m = 0, mLen = mandatoryFields.length; m < mLen; ++m) {';
var CARVE     = "if ( mandatoryFields[m] == 'preview' ) {";
var NAME_STMT = "_name = fieldPrefix +'['+ _f +']['+ mandatoryFields[m] +']';";
var CREATE    = "$newVirtualField = document.createElement('input');";
var FILL_HEAD = 'fieldsObjectList = uploadProperties.uploadFields[f];';
var GUARD     = "if ( key != 'preview' ) {";
var ASSIGN    = 'fieldsObjectList[key].value = files[f][key];';
var HANDLE    = "if ( key == 'preview' ) {";
var SUBFILL   = 'fieldsObjectList[key][previewKey].value = files[f][key][previewKey];';
var LISTED    = ", 'preview'";

var src, active;
before(function () {
    src    = fs.readFileSync(MAIN, 'utf8');
    active = stripComments(src);
});

/** Lines that are not `//` / JSDoc comment lines (the pins must not count rationale). */
function stripComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*\*|\/\*)/.test(l); }).join('\n');
}
function count(text, needle) {
    var n = 0, i = -1;
    while ((i = text.indexOf(needle, i + 1)) > -1) { n++; }
    return n;
}
/** Brace walk from the `{` at `open`; balance-gated. Returns the block including both braces. */
function walkBlock(source, open) {
    assert.equal(source[open], '{', 'walkBlock must start on an opening brace');
    var i = open, depth = 0;
    for (; i < source.length; i++) {
        var c = source[i];
        if (c === '{') { depth++; }
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    assert.equal(depth, 0, 'unbalanced braces from offset ' + open);
    return source.substring(open, i);
}

describe('#B459 01 - source pins on the plugin', function () {

    it('01.1 the auto-create loop carries the preview carve-out exactly once, and it seeds a map then continues', function () {
        assert.equal(count(active, CARVE), 1);
        var at   = active.indexOf(CARVE);
        var tail = active.substring(at + CARVE.length, at + CARVE.length + 160);
        assert.match(tail, /^\s*hiddenFields\[_f\]\.preview = \{\};\s*continue;/,
            'the carve-out must seed `hiddenFields[_f].preview = {}` and `continue`, got: ' + JSON.stringify(tail));
    });

    it('01.2 the carve-out sits inside the auto-create loop, after its head and before the name statement and the input creation', function () {
        assert.equal(count(active, LOOP_HEAD), 1, 'the auto-create loop head is unique');
        var head   = active.indexOf(LOOP_HEAD);
        var carve  = active.indexOf(CARVE);
        var name   = active.indexOf(NAME_STMT, head);
        var create = active.indexOf(CREATE, head);
        // anti-vacuity: every anchor resolves after the loop head
        assert.ok(name > head,   'name statement missing after the loop head');
        assert.ok(create > head, 'input creation missing after the loop head');
        assert.ok(carve > head,   'the carve-out must come after the loop head');
        assert.ok(carve < name,   'the carve-out must come before the name statement');
        assert.ok(carve < create, 'the carve-out must come before the input creation');
    });

    it('01.3 the fill loop\'s shared assignment is guarded against the preview key, and it is the only live assignment', function () {
        assert.equal(count(active, GUARD), 1);
        var at   = active.indexOf(GUARD);
        var tail = active.substring(at + GUARD.length, at + GUARD.length + 120);
        assert.match(tail, /^\s*fieldsObjectList\[key\]\.value = files\[f\]\[key\];\s*\}/,
            'the guard must wrap exactly the shared assignment, got: ' + JSON.stringify(tail));
        assert.equal(count(active, ASSIGN), 1, 'an unguarded copy of the assignment must not exist');
    });

    it('01.4 the guard sits inside the fill loop, after its head and before the `handle preview` block', function () {
        assert.equal(count(active, FILL_HEAD), 1, 'the fill loop head is unique');
        var fill   = active.indexOf(FILL_HEAD);
        var guard  = active.indexOf(GUARD, fill);
        var handle = active.indexOf(HANDLE, fill);
        assert.ok(handle > fill, 'handle-preview anchor missing after the fill head');
        assert.ok(guard > fill,   'the guard must come after the fill head');
        assert.ok(guard < handle, 'the guard must come before the handle-preview block');
    });

    it('01.5 controls (non-discriminating, by design): `preview` is still listed in mandatoryFields, and the sub-key fill is unchanged and unique', function () {
        assert.equal(count(active, LISTED), 1);
        assert.equal(count(active, SUBFILL), 1);
    });
});

describe('#B459 02 - the auto-create loop executed from the shipped bytes against jsdom forms', function () {

    var runLoop, mandatoryFields;

    before(function () {
        // the real list, evaluated from the same bytes the loop reads
        var decl = /mandatoryFields\s*=\s*\[/.exec(active);
        assert.ok(decl, 'mandatoryFields declaration not found');
        var open  = decl.index + decl[0].length - 1;
        var close = active.indexOf(']', open);
        mandatoryFields = new Function('return ' + active.substring(open, close + 1) + ';')();
        assert.ok(Array.isArray(mandatoryFields) && mandatoryFields.indexOf('preview') > -1,
            'the evaluated mandatoryFields must be an array listing `preview`');

        var head  = active.indexOf(LOOP_HEAD);
        assert.ok(head > -1, 'auto-create loop head not found');
        var body  = walkBlock(active, head + LOOP_HEAD.length - 1);
        var loop  = LOOP_HEAD.substring(0, LOOP_HEAD.length - 1) + body;
        runLoop   = new Function('hiddenFields', '_f', 'mandatoryFields', 'fieldPrefix', '$el', 'document', 'uuid',
            'var _name = null, $newVirtualField = null;\n' + loop + '\nreturn hiddenFields;');
    });

    function scene(inner) {
        var dom  = new JSDOM('<!doctype html><body><form id="f">' + inner + '<input type="file" id="docA" name="doc"></form></body>');
        var doc  = dom.window.document;
        var n    = 0;
        return { doc: doc, $el: doc.getElementById('docA'), uuid: function () { return 'u' + (++n); } };
    }
    function generated(form) {
        var out = {};
        Array.prototype.forEach.call(form.querySelectorAll('input[type="hidden"]'), function (el) { out[el.name] = el.value; });
        return out;
    }
    var FLAT = ['name', 'group', 'originalFilename', 'ext', 'encoding', 'size', 'height', 'width', 'location', 'mime'];

    it('02.1 an undeclared form gets the ten flat inputs, an EMPTY preview map, and no flat preview input', function () {
        var s = scene('');
        var hf = runLoop([], 0, mandatoryFields, 'doc', s.$el, s.doc, s.uuid);
        var g  = generated(s.$el.form);
        FLAT.forEach(function (k) {
            assert.ok(Object.prototype.hasOwnProperty.call(g, 'doc[0][' + k + ']'), 'missing generated input doc[0][' + k + ']');
            assert.equal(g['doc[0][' + k + ']'], '');
        });
        assert.equal(Object.keys(g).length, FLAT.length, 'exactly the ten flat inputs, got: ' + Object.keys(g).join(' '));
        assert.equal(Object.prototype.hasOwnProperty.call(g, 'doc[0][preview]'), false, 'a flat preview input must not be created');
        assert.deepEqual(hf[0].preview, {}, 'the preview slot must be an empty sub-field map');
        assert.equal(typeof hf[0].preview.tagName, 'undefined', 'the preview slot must not be an element');
        FLAT.forEach(function (k) { assert.equal(hf[0][k].tagName, 'INPUT', 'slot ' + k + ' must hold the generated input'); });
    });

    it('02.2 a declared preview map is left untouched (same object, same keys), and no flat preview input is created', function () {
        var s = scene('<input type="hidden" name="doc[0][preview][location]" value="/p.png">');
        var loc = s.$el.form.querySelector('input[name="doc[0][preview][location]"]');
        var map = { location: loc };
        var hf  = runLoop([{ preview: map }], 0, mandatoryFields, 'doc', s.$el, s.doc, s.uuid);
        assert.equal(hf[0].preview, map, 'the declared map must be the same object');
        assert.deepEqual(Object.keys(hf[0].preview), ['location']);
        assert.equal(hf[0].preview.location, loc);
        var g = generated(s.$el.form);
        assert.equal(Object.prototype.hasOwnProperty.call(g, 'doc[0][preview]'), false);
        assert.equal(g['doc[0][preview][location]'], '/p.png', 'the declared input is untouched');
        assert.equal(Object.keys(g).length, FLAT.length + 1, 'the ten flat inputs plus the declared one');
    });

    it('02.3 control: a declared flat slot is left alone and only the missing ones are created', function () {
        var s = scene('<input type="hidden" name="doc[0][name]" value="kept.png">');
        var nameEl = s.$el.form.querySelector('input[name="doc[0][name]"]');
        var hf = runLoop([{ name: nameEl }], 0, mandatoryFields, 'doc', s.$el, s.doc, s.uuid);
        assert.equal(hf[0].name, nameEl, 'the declared slot keeps its element');
        var g = generated(s.$el.form);
        assert.equal(g['doc[0][name]'], 'kept.png');
        assert.equal(Object.keys(g).length, FLAT.length, 'nine created plus the one declared');
        assert.deepEqual(hf[0].preview, {});
    });
});

describe('#B459 03 - dist fidelity: the two new comparisons survive minification', function () {

    var distJs;
    before(function () {
        distJs = fs.readFileSync(DIST_JS, 'utf8');
    });

    it('03.1 the guard on the shared assignment compiles to a `preview` inequality (0 before the fix, 1 after)', function () {
        assert.equal(count(distJs, "!='preview'") + count(distJs, "'preview'!="), 1);
    });

    it('03.2 the carve-out adds one `preview` equality to the two the plugin already carried (2 before the fix, 3 after)', function () {
        assert.equal(count(distJs, "=='preview'") + count(distJs, "'preview'=="), 3);
    });

    it('03.3 control: the quoted literal count moves from 2 to 4 - the pin above is what changed, nothing else', function () {
        assert.equal((distJs.match(/['"]preview['"]/g) || []).length, 4);
    });
});
