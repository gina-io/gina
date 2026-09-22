'use strict';
/**
 * #R8 slice 1 — Upload progress for the staged upload client layer
 *
 * The validator plugin's staged upload layer (`data-gina-form-upload-*`) gains
 * real client-to-server wire progress: `send()` attaches `xhr.upload.onprogress`
 * (freshly reassigned on EVERY send — the module-scoped `xhr` is created once and
 * reused, so a stale closure would replay the previous send's id on later sends)
 * and, for `gina-upload-*` virtual-form sends only, dispatches a NEW registered
 * event `uploadProgress.<id>` carrying
 * `{ status, progress, loaded, total, lengthComputable, files }`.
 * The response-side (download) progress channel is untouched.
 *
 * Consumer surfaces:
 *  - bus: `getFormById(uploadFormId).on('uploadProgress', cb)`
 *  - window callback: `data-gina-form-upload-on-progress` (bare identifier),
 *    copied onto the virtual form as `data-gina-form-event-on-upload-progress`
 *    and bound by listenToXhrEvents on the `.hform` channel
 *  - declarative element: `data-gina-form-upload-progress` (default target id
 *    `<fieldId>-progress`, same derivation family as -preview/-error), updated
 *    by `updateUploadProgressIndicator` — native `<progress>` gets value/max,
 *    any other element gets textContent + data attributes; full lifecycle
 *    (preparing/uploading/indeterminate/complete/error/reset) managed.
 *
 * Strategy:
 *  - Source-inspection pins lock the structural shape (registered event, fresh
 *    per-send assignment inside send(), upload-only gate, payload keys, .hform
 *    gating, listenToXhrEvents third block, change-handler wiring, onUpload
 *    finalize chokepoint, reset/delete strip).
 *  - The indicator helper is EXTRACTED from the shipped source at run time
 *    (brace-walk, control-gated) and executed against a jsdom document — the
 *    exact shipped bytes are driven behaviourally, so there is no replica to
 *    drift.
 *  - The percent computation and the FormData file-name snapshot are mirrored
 *    as pure-logic replicas, each locked by a gap-free contiguous-span pin.
 *  - Dist-fidelity pins assert the built browser bundles carry the new string
 *    literals (they survive Closure SIMPLE mode); they are expected RED before
 *    the bundle rebuild and green after — the transition is the subtract
 *    control proving they detect a stale artifact.
 *
 * Usage: node --test test/core/validator-upload-progress.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM } = require('jsdom');

var FW       = require('../fw');
var MAIN     = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var SRC;

before(function () {
    SRC = fs.readFileSync(MAIN, 'utf8');
});

/**
 * Strips block comments then line comments from a source string, for negative
 * pins that must not trip on prose mentions (the own-JSDoc trap).
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/mg, '');
}

/**
 * Extracts a `var <name> = function (...) {...}` function expression from the
 * source by brace-walking from its declaration. Returns the function text
 * (from `function` through the matching closing brace).
 *
 * @param {string} src
 * @param {string} declaration - the exact declaration prefix to anchor on
 * @returns {string}
 */
function extractFunctionExpression(src, declaration) {
    var declIdx = src.indexOf(declaration);
    assert.ok(declIdx >= 0, 'declaration not found: ' + declaration);
    assert.equal(src.indexOf(declaration, declIdx + 1), -1,
        'declaration must occur exactly once: ' + declaration);
    var fnStart = src.indexOf('function', declIdx);
    var braceIdx = src.indexOf('{', fnStart);
    var depth = 0;
    for (var i = braceIdx, len = src.length; i < len; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                return src.substring(fnStart, i + 1);
            }
        }
    }
    assert.fail('unbalanced braces walking ' + declaration);
}


describe('#R8 §01 — uploadProgress is a registered validator event', function () {

    it('the events array contains uploadProgress', function () {
        var start = SRC.indexOf('var events      = [');
        assert.ok(start >= 0, 'events array declaration found');
        var end = SRC.indexOf('];', start);
        var block = SRC.substring(start, end);
        assert.match(block, /'uploadProgress'/,
            'uploadProgress is registered (required by on() name validation)');
        // the download-direction event stays registered alongside it
        assert.match(block, /'progress'/,
            'the pre-existing progress event is still registered');
    });
});


describe('#R8 §02 — send(): fresh per-send xhr.upload.onprogress, upload-gated', function () {

    it('the upload listener is assigned inside send(), after the response-side handler', function () {
        var sendIdx     = SRC.indexOf('var send = function(data, options)');
        var downloadIdx = SRC.indexOf('xhr.onprogress = function');
        var uploadIdx   = SRC.indexOf('xhr.upload.onprogress = function');
        var helperIdx   = SRC.indexOf('var updateUploadProgressIndicator = function');
        assert.ok(sendIdx >= 0 && downloadIdx >= 0 && uploadIdx >= 0 && helperIdx >= 0);
        // structural ordering: send decl < response-side attach < upload attach < next module-level helper
        assert.ok(sendIdx < downloadIdx, 'response-side handler is inside send()');
        assert.ok(downloadIdx < uploadIdx, 'upload handler attaches after (sibling of) the response-side handler');
        assert.ok(uploadIdx < helperIdx, 'upload handler sits inside send(), before the next module-level declaration');
        // exactly one assignment site — per-send reassignment happens because send() runs it each call
        assert.equal(SRC.indexOf('xhr.upload.onprogress', uploadIdx + 1), -1,
            'exactly one xhr.upload.onprogress assignment site');
    });

    it('the shared-xhr guard and the upload-only gate are in place', function () {
        // xhr.upload existence guard (XDomainRequest / ActiveX have no .upload)
        assert.match(SRC, /typeof\(xhr\.upload\) != 'undefined' && xhr\.upload/,
            'xhr.upload guarded with the typeof-and-truthy pattern');
        // the send-scoped gate variable (code-unique declaration form)
        assert.ok(SRC.indexOf("var isUploadXhr = /^gina\\-upload/i.test(id);") >= 0,
            'isUploadXhr computed once per send');
        // the closure no-ops for non-upload sends
        assert.match(SRC, /xhr\.upload\.onprogress = function\(event\) \{[\s\S]{0,200}?if \(!isUploadXhr\) return;/,
            'the fresh closure self-gates on isUploadXhr');
    });

    it('the payload carries the documented keys and is stashed on eventData', function () {
        assert.match(SRC, /'progress'\s*:\s*percentComplete/);
        assert.match(SRC, /'loaded'\s*:\s*event\.loaded/);
        assert.match(SRC, /'total'\s*:\s*event\.total/);
        assert.match(SRC, /'lengthComputable'\s*:\s*event\.lengthComputable/);
        assert.match(SRC, /'files'\s*:\s*uploadFileNames/);
        assert.ok(SRC.indexOf('$form.eventData.uploadProgress = result;') >= 0,
            'last payload stashed on $form.eventData.uploadProgress');
    });

    it('dispatches uploadProgress.<id>, and .hform only behind its attribute gate', function () {
        assert.ok(SRC.indexOf("triggerEvent(gina, $target, 'uploadProgress.' + id, result);") >= 0,
            'bus dispatch present');
        assert.match(SRC,
            /if \(uploadProgressHFormIsRequired\)\s*\n\s*triggerEvent\(gina, \$target, 'uploadProgress\.' \+ id \+ '\.hform', result\);/,
            '.hform dispatch gated on the attribute-presence flag');
        assert.match(SRC,
            /var uploadProgressHFormIsRequired = \( \$target\.getAttribute\('data-gina-form-event-on-upload-progress'\) \) \? true : false;/,
            'the gate reads the copied virtual-form attribute');
    });

    it('gap-free pin: the FormData file-name snapshot block (mirrored by §08)', function () {
        assert.match(SRC, new RegExp(
            'var uploadFileNames = \\[\\];\\s*' +
            'if \\( isUploadXhr && data instanceof FormData \\) \\{\\s*' +
            'for \\(var \\[uploadFileKey, uploadFileValue\\] of data\\.entries\\(\\)\\) \\{\\s*' +
            'if \\(uploadFileValue instanceof File\\) \\{\\s*' +
            'uploadFileNames\\.push\\(uploadFileValue\\.name\\);\\s*' +
            '\\}\\s*\\}\\s*\\}'
        ), 'snapshot block is contiguous and matches the §08 replica');
    });

    it('gap-free pin: the percent computation block (mirrored by §09)', function () {
        assert.match(SRC, new RegExp(
            'var percentComplete = null; // null means indeterminate \\(length not computable\\)\\s*' +
            'if \\( event\\.lengthComputable && event\\.total > 0 \\) \\{\\s*' +
            'percentComplete = event\\.loaded / event\\.total;\\s*' +
            'percentComplete = parseInt\\(percentComplete \\* 100\\);\\s*' +
            '\\}'
        ), 'percent block is contiguous and matches the §09 replica');
    });
});


describe('#R8 §03 — listenToXhrEvents binds the upload-progress window callback', function () {

    it('reads the copied attribute and binds uploadProgress.hform', function () {
        assert.match(SRC,
            /var htmlUploadProgressEventCallback = \$form\.target\.getAttribute\('data-gina-form-event-on-upload-progress'\) \|\| null;/);
        assert.ok(SRC.indexOf("$form.on('uploadProgress.hform', window[htmlUploadProgressEventCallback])") >= 0,
            'bare-identifier callback bound on the .hform channel');
    });

    it('rejects function-call shapes with the #M21a warn (bare identifiers only)', function () {
        assert.match(SRC,
            /if \( \/\\\(\(\.\*\)\\\)\/\.test\(htmlUploadProgressEventCallback\) \)/,
            'function-call shape detected');
        assert.ok(SRC.indexOf('function-call shape not supported on data-gina-form-event-on-upload-progress') >= 0,
            'the warn names the attribute');
    });
});


describe('#R8 §04 — updateUploadProgressIndicator (extracted shipped bytes, jsdom-driven)', function () {

    var helper = null;
    var dom    = null;

    /**
     * Builds a fresh jsdom document carrying one native progress target and one
     * text target, and returns the helper bound to it.
     *
     * @returns {object} { fn, doc }
     */
    function freshDom() {
        dom = new JSDOM('<!doctype html><html><body>' +
            '<progress id="p1"></progress>' +
            '<div id="d1"></div>' +
            '</body></html>');
        var fnText = extractFunctionExpression(SRC,
            'var updateUploadProgressIndicator = function(containerId, state, result) {');
        /* jshint evil: true */
        var make = new Function('document', 'return (' + fnText + ');');
        return { fn: make(dom.window.document), doc: dom.window.document };
    }

    it('extraction control: the declaration matches exactly once and walks to balance', function () {
        var fnText = extractFunctionExpression(SRC,
            'var updateUploadProgressIndicator = function(containerId, state, result) {');
        assert.ok(fnText.length > 500 && fnText.length < 5000, 'sane extraction size');
        assert.ok(/^function\(containerId, state, result\) \{/.test(fnText));
        assert.ok(/\}$/.test(fnText));
    });

    it('null container id and unknown ids are silent no-ops', function () {
        var h = freshDom();
        assert.doesNotThrow(function () { h.fn(null, 'uploading', { progress: 50 }); });
        assert.doesNotThrow(function () { h.fn('nope', 'uploading', { progress: 50 }); });
    });

    it('uploading on a native <progress> tracks bytes and stamps both data attributes', function () {
        var h = freshDom();
        h.fn('p1', 'uploading', { progress: 42, loaded: 1024, total: 2438 });
        var $p = h.doc.getElementById('p1');
        assert.equal($p.getAttribute('max'), '2438');
        assert.equal($p.getAttribute('value'), '1024');
        assert.equal($p.getAttribute('data-gina-upload-progress'), '42');
        assert.equal($p.getAttribute('data-gina-upload-progress-state'), 'uploading');
    });

    it('uploading on a non-progress element writes textContent percent + attributes', function () {
        var h = freshDom();
        h.fn('d1', 'uploading', { progress: 42, loaded: 1024, total: 2438 });
        var $d = h.doc.getElementById('d1');
        assert.equal($d.textContent, '42%');
        assert.equal($d.getAttribute('data-gina-upload-progress'), '42');
        assert.equal($d.getAttribute('data-gina-upload-progress-state'), 'uploading');
    });

    it('preparing / null-progress are indeterminate: value attribute removed, percent attribute absent', function () {
        var h = freshDom();
        var $p = h.doc.getElementById('p1');
        // seed a determinate state first, then go indeterminate
        h.fn('p1', 'uploading', { progress: 50, loaded: 5, total: 10 });
        h.fn('p1', 'preparing');
        assert.equal($p.getAttribute('value'), null, 'value removed (native indeterminate)');
        assert.equal($p.getAttribute('data-gina-upload-progress'), null);
        assert.equal($p.getAttribute('data-gina-upload-progress-state'), 'preparing');
        // uploading with a null progress (lengthComputable false) behaves the same
        h.fn('p1', 'indeterminate', { progress: null, loaded: 5, total: 0 });
        assert.equal($p.getAttribute('value'), null);
        assert.equal($p.getAttribute('data-gina-upload-progress-state'), 'indeterminate');
    });

    it('complete fills the bar (preserving a live max) and reads 100%', function () {
        var h = freshDom();
        var $p = h.doc.getElementById('p1');
        h.fn('p1', 'uploading', { progress: 84, loaded: 2048, total: 2438 });
        h.fn('p1', 'complete');
        assert.equal($p.getAttribute('max'), '2438', 'live byte max preserved');
        assert.equal($p.value, $p.max, 'bar full');
        assert.equal($p.getAttribute('data-gina-upload-progress'), '100');
        assert.equal($p.getAttribute('data-gina-upload-progress-state'), 'complete');

        // fresh element (no prior max): defaults to 100/100
        h.fn('d1', 'complete');
        assert.equal(h.doc.getElementById('d1').textContent, '100%');
    });

    it('error empties the native bar (value 0, never indeterminate) and clears text', function () {
        var h = freshDom();
        var $p = h.doc.getElementById('p1');
        h.fn('p1', 'uploading', { progress: 73, loaded: 730, total: 1000 });
        h.fn('p1', 'error');
        assert.equal($p.getAttribute('value'), '0', 'value 0 — an indeterminate animation would read as still working');
        assert.equal($p.getAttribute('data-gina-upload-progress'), null, 'stale percent cleared');
        assert.equal($p.getAttribute('data-gina-upload-progress-state'), 'error');

        var $d = h.doc.getElementById('d1');
        h.fn('d1', 'uploading', { progress: 73, loaded: 730, total: 1000 });
        h.fn('d1', 'error');
        assert.equal($d.textContent, '', 'stale percent text cleared');
        assert.equal($d.getAttribute('data-gina-upload-progress-state'), 'error');
    });

    it('reset strips everything the layer ever set', function () {
        var h = freshDom();
        var $p = h.doc.getElementById('p1');
        var $d = h.doc.getElementById('d1');
        h.fn('p1', 'uploading', { progress: 42, loaded: 1024, total: 2438 });
        h.fn('d1', 'uploading', { progress: 42, loaded: 1024, total: 2438 });
        h.fn('p1', 'reset');
        h.fn('d1', 'reset');
        assert.equal($p.getAttribute('value'), null);
        assert.equal($p.getAttribute('max'), null);
        assert.equal($p.getAttribute('data-gina-upload-progress'), null);
        assert.equal($p.getAttribute('data-gina-upload-progress-state'), null);
        assert.equal($d.textContent, '');
        assert.equal($d.getAttribute('data-gina-upload-progress'), null);
        assert.equal($d.getAttribute('data-gina-upload-progress-state'), null);
    });

    it('no hardcoded copy: the helper writes only percent strings, never words', function () {
        var fnText = extractFunctionExpression(SRC,
            'var updateUploadProgressIndicator = function(containerId, state, result) {');
        var active = stripComments(fnText);
        // the only textContent literals are '' / '100%' / the percent concat
        assert.doesNotMatch(active, /textContent = '[A-Za-z]/,
            'no wording is hardcoded (labels are the consumer concern, i18n-neutral)');
    });
});


describe('#R8 §05 — change handler: attribute reads, uploadProperties, kickoff', function () {

    it('reads data-gina-form-upload-on-progress alongside -on-success/-on-error', function () {
        var successIdx  = SRC.indexOf("var eventOnSuccess  = $el.getAttribute('data-gina-form-upload-on-success');");
        var progressIdx = SRC.indexOf("var eventOnProgress = $el.getAttribute('data-gina-form-upload-on-progress');");
        assert.ok(successIdx >= 0 && progressIdx >= 0);
        assert.ok(progressIdx > successIdx, 'read sits with its siblings');
    });

    it('resolves the indicator target as a string id with the <fieldId>-progress default', function () {
        assert.match(SRC, /var progressContainer\s*=\s*\$el\.getAttribute\('data-gina-form-upload-progress'\)/);
        assert.ok(SRC.indexOf("(fieldId) ? fieldId + '-progress' : null") >= 0,
            'default derives from the input id, same family as -preview/-error');
    });

    it('stores progressContainer on uploadProperties', function () {
        assert.match(SRC, /progressContainer\s*:\s*progressContainer,/,
            'uploadProperties carries the resolved string id');
    });

    it('copies the callback onto the virtual form with NO default', function () {
        assert.match(SRC,
            /if \(eventOnProgress\) \{\s*\$uploadForm\.setAttribute\('data-gina-form-event-on-upload-progress', eventOnProgress\);\s*\}/,
            'copy block has no else branch — absent attribute means no .hform channel');
    });

    it('kickoff: preparing state on every selection, gated on the resolved container', function () {
        assert.match(SRC,
            /if \( \$uploadForm\.uploadProperties && \$uploadForm\.uploadProperties\.progressContainer \) \{\s*updateUploadProgressIndicator\(\$uploadForm\.uploadProperties\.progressContainer, 'preparing'\);\s*\}/);
    });
});


describe('#R8 §06 — lifecycle finalize + reset/delete strip', function () {

    it('onUpload finalizes the indicator right after the uploadProperties guard', function () {
        var guardIdx    = SRC.indexOf("throw new Error('No uploadProperties found !!');");
        var finalizeIdx = SRC.indexOf('uploadProperties.progressContainer || null');
        assert.ok(guardIdx >= 0 && finalizeIdx >= 0);
        assert.ok(finalizeIdx > guardIdx, 'finalize sits after the guard (single chokepoint for success AND every error path)');
        assert.match(SRC, /\(status == 'success'\) \? 'complete' : 'error'/,
            'status maps to the two terminal indicator states');
    });

    it('onUploadResetOrDelete strips the indicator when at least one file was removed', function () {
        // #R8 slice 2 relaxed the tail (was `'reset'\s*\);\s*\}`): the dropzone
        // idle-reset now sits inside the same removedCount block right after
        // this call, so the block no longer closes here. The gate + this call
        // (with its default-id derivation) stay pinned; the full extended block
        // shape is locked by validator-upload-dropzone.test.js §01.
        assert.match(SRC,
            /if \(removedCount > 0\) \{\s*updateUploadProgressIndicator\(\s*\$uploadTrigger\.getAttribute\('data-gina-form-upload-progress'\) \|\| \( \(\$uploadTrigger\.id\) \? \$uploadTrigger\.id \+ '-progress' : null \),\s*'reset'\s*\);/);
    });
});


describe('#R8 §07 — negatives: shipped surfaces untouched, scope locked', function () {

    it('the response-side (download) progress channel is byte-intact', function () {
        // the old block's distinctive lines all survive
        assert.ok(SRC.indexOf('$form.eventData.onprogress = result;') >= 0);
        assert.ok(SRC.indexOf("triggerEvent(gina, $target, 'progress.' + id, result)") >= 0);
    });

    it('no direction discriminator was introduced (the distinct-event design)', function () {
        var active = stripComments(SRC);
        // strip control: a known comment is gone, known code remains
        assert.ok(active.indexOf('catching request progress') < 0, 'strip control: comments removed');
        assert.ok(active.indexOf('xhr.onprogress') >= 0, 'strip control: code kept');
        assert.ok(active.indexOf("'direction'") < 0, 'no quoted direction payload key anywhere');
    });

    it('no hardcoded progress wording landed in active code', function () {
        var active = stripComments(SRC);
        assert.ok(active.indexOf("'Done'") < 0, 'the dormant example wording stays out of active code');
        assert.ok(active.indexOf("'Uploading") < 0, 'no hardcoded uploading label');
    });

    it('no abort path was added (the layer has none)', function () {
        var active = stripComments(SRC);
        // gh#76 slice 4 added ONE abort, in the request-coordination decision at the top of
        // send() — a different layer. Pin that it is the only one, and that it is that one:
        // an abort reaching THIS layer would show up as a second hit, or a different prefix.
        assert.deepEqual(active.match(/[\w.$]*xhr\.abort\(/g) || [], ['syncEntry.xhr.abort(']);
    });
});


describe('#R8 §08 — replica: FormData file-name snapshot (locked by §02 gap-free pin)', function () {

    /**
     * Mirrors the send()-scope snapshot block.
     *
     * @param {boolean} isUploadXhr
     * @param {*} data
     * @returns {string[]}
     */
    function snapshotNames(isUploadXhr, data) {
        var uploadFileNames = [];
        if ( isUploadXhr && data instanceof FormData ) {
            for (var [uploadFileKey, uploadFileValue] of data.entries()) {
                if (uploadFileValue instanceof File) {
                    uploadFileNames.push(uploadFileValue.name);
                }
            }
        }
        return uploadFileNames;
    }

    it('collects every File name, skips text fields, in order', function () {
        var fd = new FormData();
        fd.append('files', new File(['aaa'], 'photo1.jpg'));
        fd.append('files', new File(['bbbb'], 'photo2.png'));
        fd.append('note', 'not a file');
        assert.deepEqual(snapshotNames(true, fd), ['photo1.jpg', 'photo2.png']);
    });

    it('non-upload sends and non-FormData bodies yield an empty list', function () {
        var fd = new FormData();
        fd.append('files', new File(['x'], 'a.bin'));
        assert.deepEqual(snapshotNames(false, fd), []);
        assert.deepEqual(snapshotNames(true, { not: 'formdata' }), []);
        assert.deepEqual(snapshotNames(true, undefined), []);
    });
});


describe('#R8 §09 — replica: percent computation (locked by §02 gap-free pin)', function () {

    /**
     * Mirrors the closure's percent block.
     *
     * @param {boolean} lengthComputable
     * @param {number} loaded
     * @param {number} total
     * @returns {number|null}
     */
    function percent(lengthComputable, loaded, total) {
        var event = { lengthComputable: lengthComputable, loaded: loaded, total: total };
        var percentComplete = null;
        if ( event.lengthComputable && event.total > 0 ) {
            percentComplete = event.loaded / event.total;
            percentComplete = parseInt(percentComplete * 100);
        }
        return percentComplete;
    }

    it('computes the truncated integer percent when length is computable', function () {
        assert.equal(percent(true, 512, 1024), 50);
        assert.equal(percent(true, 1, 3), 33);
        assert.equal(percent(true, 2438, 2438), 100);
        assert.equal(percent(true, 0, 2438), 0);
    });

    it('null (indeterminate) when not computable or total is zero', function () {
        assert.equal(percent(false, 512, 1024), null);
        assert.equal(percent(true, 0, 0), null);
    });
});


describe('#R8 §10 — dist fidelity: the built bundles carry the feature', function () {
    // Expected RED before the prod bundle rebuild and green after — the
    // transition is the subtract control proving these detect a stale artifact.
    // All pinned tokens are string literals (they survive Closure SIMPLE mode)
    // and ASCII-only.

    var TOKENS = [
        'uploadProgress',
        'data-gina-upload-progress-state',
        'data-gina-form-event-on-upload-progress',
        'data-gina-form-upload-progress'
    ];

    it('gina.js (unminified bundle) contains every new literal', function () {
        var bundle = fs.readFileSync(DIST, 'utf8');
        TOKENS.forEach(function (token) {
            assert.ok(bundle.indexOf(token) >= 0, 'gina.js carries ' + token);
        });
    });

    it('gina.min.js (minified bundle) contains every new literal', function () {
        var bundle = fs.readFileSync(DIST_MIN, 'utf8');
        TOKENS.forEach(function (token) {
            assert.ok(bundle.indexOf(token) >= 0, 'gina.min.js carries ' + token);
        });
    });
});


/*
 * ─────────────────────────────────────────────────────────────────────────
 * processing state — an additive lifecycle state stamped at bytes-done
 * (xhr.upload.onloadend), for the server post-processing window between the
 * last byte sent and the response. Advances the state attribute ONLY, leaving
 * the determinate bar full (value/max/percent untouched) so a styled bar does
 * not visually regress to an empty track while the server works.
 * ─────────────────────────────────────────────────────────────────────────
 */

describe('#R8 §11 — processing state: source pins (onloadend delegate + early-return)', function () {

    it('xhr.upload.onloadend is registered once, inside the per-send block, upload-gated', function () {
        var uploadProgIdx = SRC.indexOf('xhr.upload.onprogress = function');
        var loadendIdx    = SRC.indexOf('xhr.upload.onloadend = function');
        var helperIdx     = SRC.indexOf('var updateUploadProgressIndicator = function');
        assert.ok(loadendIdx >= 0, 'onloadend handler present');
        assert.ok(uploadProgIdx >= 0 && uploadProgIdx < loadendIdx,
            'onloadend attaches after onprogress (sibling in the same per-send block)');
        assert.ok(loadendIdx < helperIdx,
            'onloadend sits inside send(), before the next module-level declaration');
        assert.equal(SRC.indexOf('xhr.upload.onloadend', loadendIdx + 1), -1,
            'exactly one onloadend assignment site (fresh per-send, like onprogress)');
        // upload-only gate mirrors onprogress — no-op for non-upload sends
        assert.match(SRC, /xhr\.upload\.onloadend = function\(\) \{[\s\S]{0,120}?if \(!isUploadXhr\) return;/,
            'the onloadend closure self-gates on isUploadXhr');
    });

    it('onloadend delegates the processing state to the shared indicator chokepoint', function () {
        assert.match(SRC,
            /xhr\.upload\.onloadend = function\(\) \{[\s\S]*?updateUploadProgressIndicator\(\s*\(\$target\.uploadProperties\) \? \$target\.uploadProperties\.progressContainer : null,\s*'processing'\s*\)/,
            'onloadend calls the same helper onprogress uses, with the processing state and no result payload');
    });

    it('the processing early-return sits right after the state stamp, before the complete/!result branches', function () {
        var stampIdx      = SRC.indexOf("$indicator.setAttribute('data-gina-upload-progress-state', state);");
        var processingIdx = SRC.indexOf("if (state == 'processing') {");
        var completeIdx   = SRC.indexOf("if (state == 'complete') {");
        assert.ok(stampIdx >= 0 && processingIdx >= 0 && completeIdx >= 0);
        assert.ok(stampIdx < processingIdx,
            'the state attribute is stamped unconditionally BEFORE the processing early-return');
        assert.ok(processingIdx < completeIdx,
            'the processing branch precedes complete (and therefore the later !result guard that would strip value/percent)');
        // the branch is a bare early-return: it writes no value/max/percent
        assert.match(SRC, /if \(state == 'processing'\) \{[\s\S]*?return;\s*\}/,
            'processing branch returns without further mutation');
    });

    it('the docstring enum and @param carry the processing state', function () {
        assert.match(SRC, /preparing\|uploading\|indeterminate\|processing\|complete\|error/,
            'enum lists processing between indeterminate and complete');
        assert.match(SRC, /@param \{string\} state[\s\S]{0,160}?`processing`/,
            '@param documents the processing state');
    });
});


describe('#R8 §12 — processing state: preserves the bar, advances the state (jsdom-driven shipped bytes)', function () {

    /**
     * Builds a fresh jsdom document with one native progress and one text target
     * and returns the shipped updateUploadProgressIndicator bound to it.
     *
     * @returns {object} { fn, doc }
     */
    function freshDom() {
        var dom = new JSDOM('<!doctype html><html><body>' +
            '<progress id="p1"></progress>' +
            '<div id="d1"></div>' +
            '</body></html>');
        var fnText = extractFunctionExpression(SRC,
            'var updateUploadProgressIndicator = function(containerId, state, result) {');
        /* jshint evil: true */
        var make = new Function('document', 'return (' + fnText + ');');
        return { fn: make(dom.window.document), doc: dom.window.document };
    }

    it('processing after a determinate uploading update leaves value/max/percent UNTOUCHED', function () {
        var h = freshDom();
        var $p = h.doc.getElementById('p1');
        h.fn('p1', 'uploading', { progress: 100, loaded: 2438, total: 2438 });
        // the byte-done state as the last onprogress left it
        assert.equal($p.getAttribute('value'), '2438');
        assert.equal($p.getAttribute('max'), '2438');
        assert.equal($p.getAttribute('data-gina-upload-progress'), '100');
        // bytes-done → processing (the onloadend delegate passes NO result)
        h.fn('p1', 'processing');
        assert.equal($p.getAttribute('data-gina-upload-progress-state'), 'processing', 'state advanced');
        assert.equal($p.getAttribute('value'), '2438', 'value preserved — bar stays full');
        assert.equal($p.getAttribute('max'), '2438', 'max preserved');
        assert.equal($p.getAttribute('data-gina-upload-progress'), '100', 'percent attribute preserved');
    });

    it('processing on a non-progress element leaves textContent + percent attribute UNTOUCHED', function () {
        var h = freshDom();
        var $d = h.doc.getElementById('d1');
        h.fn('d1', 'uploading', { progress: 100, loaded: 2438, total: 2438 });
        h.fn('d1', 'processing');
        assert.equal($d.getAttribute('data-gina-upload-progress-state'), 'processing');
        assert.equal($d.textContent, '100%', 'percent text preserved');
        assert.equal($d.getAttribute('data-gina-upload-progress'), '100', 'percent attribute preserved');
    });

    it('processing after an indeterminate update keeps the bar indeterminate (value stays absent)', function () {
        var h = freshDom();
        var $p = h.doc.getElementById('p1');
        h.fn('p1', 'indeterminate', { progress: null });
        assert.equal($p.getAttribute('value'), null, 'indeterminate: value absent (native animation)');
        h.fn('p1', 'processing');
        assert.equal($p.getAttribute('data-gina-upload-progress-state'), 'processing');
        assert.equal($p.getAttribute('value'), null, 'value still absent — the native animation keeps reading as "working"');
    });

    it('processing called with NO result arg does not throw', function () {
        var h = freshDom();
        h.fn('p1', 'uploading', { progress: 50, loaded: 5, total: 10 });
        assert.doesNotThrow(function () { h.fn('p1', 'processing'); }, 'the onloadend delegate passes no result — must be safe');
    });

    it('subtract control: WITHOUT the early-return, a resultless processing call strips value + percent', function () {
        // Prove the early-return is LOAD-BEARING: remove the processing branch from
        // the extracted shipped bytes and re-drive. A resultless call then falls
        // through to the `!result` guard, which removes `value` (native indeterminate)
        // and the percent attribute — exactly the regression the branch prevents.
        var fnText  = extractFunctionExpression(SRC,
            'var updateUploadProgressIndicator = function(containerId, state, result) {');
        var without = fnText.replace(/if \(state == 'processing'\) \{[\s\S]*?return;\s*\}/, '');
        assert.ok(without.indexOf("state == 'processing'") < 0, 'subtract removed the branch');
        var dom  = new JSDOM('<!doctype html><html><body><progress id="p1"></progress></body></html>');
        /* jshint evil: true */
        var make = new Function('document', 'return (' + without + ');');
        var fn   = make(dom.window.document);
        var $p   = dom.window.document.getElementById('p1');
        fn('p1', 'uploading', { progress: 100, loaded: 2438, total: 2438 });
        fn('p1', 'processing'); // no result → falls through to the !result guard
        assert.equal($p.getAttribute('value'), null, 'WITHOUT the branch: value stripped (native indeterminate) — the regression');
        assert.equal($p.getAttribute('data-gina-upload-progress'), null, 'WITHOUT the branch: percent attribute stripped');
    });
});


describe('#R8 §13 — dist fidelity: processing state in the built bundles', function () {
    // `onloadend` is introduced ONLY by this change (absent from the pre-change
    // dist, verified 0/0), so it is a clean RED-before / green-after subtract
    // control proving these pins detect a stale artifact.

    it('gina.js (unminified) carries the onloadend delegate and the processing branch', function () {
        var bundle = fs.readFileSync(DIST, 'utf8');
        assert.ok(bundle.indexOf('onloadend') >= 0, 'gina.js carries the onloadend handler');
        assert.ok(bundle.indexOf("state == 'processing'") >= 0, 'gina.js carries the processing early-return branch');
    });

    it('gina.min.js (minified) carries the onloadend handler', function () {
        var bundle = fs.readFileSync(DIST_MIN, 'utf8');
        assert.ok(bundle.indexOf('onloadend') >= 0,
            'gina.min.js carries the onloadend handler (a native DOM property — survives SIMPLE-mode minification, like onprogress)');
    });
});
