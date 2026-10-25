/**
 * #B292 — `bindUploadResetOrDeleteTrigger` (validator plugin) warned « did not find `upload <reset|delete>
 * trigger` » in two cases where nothing was missing:
 *
 * - a trigger found and already bound, as a re-bind (`$forms[id].reBind()`) finds the delete link of a
 *   saved file it bound the first time: the message named an element that was present and working;
 * - a reset trigger missing under its default id `<input id>-<index>-reset-trigger`, which gina creates
 *   itself when the staging succeeds (onUpload): the first selection of every upload input warned.
 *
 * It now warns only when the page had to provide the trigger: a delete trigger (a saved file's link), or
 * an id declared through `data-gina-form-upload-<reset|delete>-trigger`. A trigger already bound is left
 * as it is, as before.
 *
 *   01 the source: the warning branch carries the new condition, the bare `else` is gone
 *   02 the function, extracted from the source and run with a fake document: each case's warnings and
 *      bindings (the reset and delete cases above, plus the declared-id and found-unbound controls)
 *   03 the built bundles carry the change: gina.js (the same condition) and gina.min.js (its minified form)
 *
 * The browser flows are driven in test/e2e/validator-upload-trigger-warning-b292.spec.js.
 *
 * Seams, so the whole file runs against pre-fix bytes without touching the tree:
 *   GINA_B292_VALIDATOR_SRC=<a copy of src/main.js>   (01, 02)
 *   GINA_B292_DIST_DIR=<a directory holding gina.js and gina.min.js>   (03)
 * RED-FIRST, measured 2026-10-25 on develop 7acd7622f's src/main.js, gina.js and gina.min.js (git show):
 * the 01 pins, the three « nothing missing » arms of 02 and the 03 shape pins fail, each on its own
 * assertion; the controls (the declaration found once, the declared id, the delete link, the found-unbound
 * binding and the raw-text controls) pass.
 *
 * Usage: node --test test/core/validator-upload-trigger-warning-b292.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var MAIN_SRC_PATH = process.env.GINA_B292_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST_DIR      = process.env.GINA_B292_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

var mainSrc = fs.readFileSync(MAIN_SRC_PATH, 'utf8');
var DECL = 'var bindUploadResetOrDeleteTrigger = function';
var NEW_COND = "} else if ( !$uploadResetOrDeleteTrigger && ( bindingType != 'reset' || customTriggerId ) ) {";
var WARN_HEAD = "console.warn('[FormValidator::bindForm][upload]['";

/**
 * The function from its declaration to its closing brace: a brace walk that skips comments and string
 * literals (the same walk as validator-upload-reset-delete.test.js).
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
 * Drops the full-line `//` comments, so a `// was:` line keeping the old code cannot satisfy a pin.
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

var binder = fnSlice(mainSrc, DECL);
var binderCode = stripLineComments(binder);

describe('#B292 01 - the source: the warning branch is guarded', function () {

    it('control: the declaration is found once, and the warning is still in the function', function () {
        var decls = mainSrc.match(/^[ \t]*var bindUploadResetOrDeleteTrigger = function/mg) || [];
        assert.equal(decls.length, 1);
        assert.equal(count(binderCode, WARN_HEAD), 1);
    });

    it('the warning branch is `else if` the trigger is absent and the page had to provide it', function () {
        assert.equal(count(binderCode, NEW_COND), 1);
        var cond = binderCode.indexOf(NEW_COND), warn = binderCode.indexOf(WARN_HEAD);
        assert.ok(cond > -1 && warn > cond, 'the warning sits inside the guarded branch');
        assert.equal(binderCode.substring(cond + NEW_COND.length, warn).replace(/\s+/g, ''), '',
            'nothing but whitespace between the guard and the warning, once comments are dropped');
    });

    it('no bare `else` leads to the warning any more (comments dropped first; the raw text keeps the `// was:` line)', function () {
        var bare = /isBinded = true;\s*\}\s*else\s*\{\s*console\.warn\('\[FormValidator::bindForm\]\[upload\]\['/;
        assert.equal(bare.test(binderCode), false);
        assert.ok(binder.indexOf('// was: } else {') > -1, 'raw-text control: the replaced line is kept as a comment');
    });
});

/**
 * The binder, compiled from the source with its free identifiers injected.
 * @inner
 * @param {object} doc - a fake document: `getElementById`
 * @returns {{ fn: Function, warns: string[], listeners: Array }}
 */
function load(doc) {
    var warns = [], listeners = [];
    var fakeConsole = { warn: function (m) { warns.push(String(m)); }, debug: function () {}, log: function () {} };
    var addListener = function (target, el, type, cb) { listeners.push({ el: el, type: type, cb: cb }); };
    var fn = new Function('document', 'addListener', 'gina', 'onUploadResetOrDelete', 'console',
        binder + '\nreturn bindUploadResetOrDeleteTrigger;')(doc, addListener, {}, function () {}, fakeConsole);
    return { fn: fn, warns: warns, listeners: listeners };
}

function fakeDocument(elements) {
    return { getElementById: function (id) { return Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null; } };
}

function fileInput(id, attrs) {
    var a = attrs || {};
    return { id: id, getAttribute: function (n) { return Object.prototype.hasOwnProperty.call(a, n) ? a[n] : null; } };
}

describe('#B292 02 - the function, run from the source', function () {

    it('a reset trigger missing under its default id (gina creates it at the staging success): no warning', function () {
        var h = load(fakeDocument({}));
        h.fn('reset', fileInput('doc'), 0);
        assert.deepEqual(h.warns, [], 'the shipped binder warned here: ' + JSON.stringify(h.warns));
        assert.equal(h.listeners.length, 0);
    });

    it('a delete trigger found and already bound (a re-bind): no warning, no second listener', function () {
        var link = { tagName: 'A', isBinded: true };
        var h = load(fakeDocument({ 'doc-0-delete-trigger': link }));
        h.fn('delete', fileInput('doc'), 0);
        assert.deepEqual(h.warns, [], 'the shipped binder warned « did not find » for a present link: ' + JSON.stringify(h.warns));
        assert.equal(h.listeners.length, 0);
    });

    it('a declared reset trigger found and already bound: no warning, no second listener', function () {
        var btn = { tagName: 'BUTTON', isBinded: true };
        var h = load(fakeDocument({ myReset: btn }));
        h.fn('reset', fileInput('doc', { 'data-gina-form-upload-reset-trigger': 'myReset' }), 0);
        assert.deepEqual(h.warns, [], JSON.stringify(h.warns));
        assert.equal(h.listeners.length, 0);
    });

    it('CONTROL a delete trigger missing (the page must provide it): one warning naming its id', function () {
        var h = load(fakeDocument({}));
        h.fn('delete', fileInput('doc'), 0);
        assert.equal(h.warns.length, 1);
        assert.ok(h.warns[0].indexOf('did not find `upload delete trigger`') > -1, h.warns[0]);
        assert.ok(h.warns[0].indexOf('element ID is `doc-0-delete-trigger`') > -1, h.warns[0]);
    });

    it('CONTROL a declared reset trigger id with no element: one warning naming the declared id', function () {
        var h = load(fakeDocument({}));
        h.fn('reset', fileInput('doc', { 'data-gina-form-upload-reset-trigger': 'noSuchReset' }), 0);
        assert.equal(h.warns.length, 1);
        assert.ok(h.warns[0].indexOf('element ID is `noSuchReset`') > -1, h.warns[0]);
    });

    it('CONTROL a trigger found and not yet bound: bound once (click, plus keydown on an anchor), no warning', function () {
        var link = { tagName: 'A' };
        var h = load(fakeDocument({ 'doc-0-reset-trigger': link }));
        h.fn('reset', fileInput('doc'), 0);
        assert.deepEqual(h.warns, []);
        assert.deepEqual(h.listeners.map(function (l) { return l.type; }), ['click', 'keydown']);
        assert.equal(link.isBinded, true);
    });
});

describe('#B292 03 - the built bundles carry the change', function () {

    var distJs  = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var distMin = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8').replace(/\n/g, '');
    var MIN_NEW = /isBinded=!0\):([\w$]+)\|\|([\w$]+)=='reset'&&!([\w$]+)\|\|console\.warn\('\[FormValidator::bindForm\]\[upload\]\['/g;
    var MIN_OLD = /isBinded=!0\):console\.warn\('\[FormValidator::bindForm\]\[upload\]\['/g;

    it('control: each bundle carries the warning once', function () {
        assert.equal(count(distJs, "did not find `upload '+bindingType+' trigger`."), 1);
        assert.equal((distMin.match(/did not find `upload '\+[\w$]+\+' trigger`\./g) || []).length, 1);
    });

    it('gina.js: the same guarded branch as the source', function () {
        assert.equal(count(stripLineComments(distJs), NEW_COND), 1);
    });

    it('gina.min.js: the warning runs only when the trigger is absent and not a default-id reset', function () {
        assert.equal((distMin.match(MIN_NEW) || []).length, 1);
        assert.equal((distMin.match(MIN_OLD) || []).length, 0, 'the unguarded form of the shipped bundle');
    });
});
